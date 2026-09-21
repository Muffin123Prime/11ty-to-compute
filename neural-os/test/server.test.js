'use strict';

/**
 * HTTP layer tests.
 *
 * Everything here talks to a real server over a real socket on 127.0.0.1 with
 * an ephemeral port: no request is faked, no handler is called directly. The
 * vault is a real store in a throwaway home, and the subsystems that are not
 * under test are either absent (to prove a missing subsystem answers 503
 * instead of crashing) or an explicit local double.
 *
 * Nothing in here touches the internet or the real home directory.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');

const { createServer, CSP } = require('../src/http/server');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');
const { openStore } = require('../src/store/engine');

/** Tests must not write diagnostics over the runner's output. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

/* ------------------------------------------------------------- utilities */

function request(base, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body
        : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not every route answers JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open an event stream and collect what arrives, without buffering for ever. */
function openStream(base, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const req = http.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { accept: 'text/event-stream', ...headers },
      },
      (res) => {
        res.setEncoding('utf8');
        let text = '';
        let ended = false;
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => { ended = true; });
        res.on('close', () => { ended = true; });
        resolve({
          res,
          status: res.statusCode,
          headers: res.headers,
          get text() { return text; },
          get ended() { return ended; },
          async waitFor(pattern, ms = 3000) {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
              if (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)) return text;
              await sleep(15);
            }
            throw new Error(`Ereignis "${pattern}" kam nicht an. Empfangen: ${JSON.stringify(text.slice(0, 400))}`);
          },
          async waitForEnd(ms = 3000) {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
              if (ended) return true;
              await sleep(15);
            }
            throw new Error('Der Strom wurde nicht beendet.');
          },
          close() { res.destroy(); },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Boot a real server on an ephemeral port over a real (temporary) vault.
 * `opts.ctx` adds or overrides injected subsystems; `opts.server` patches
 * config.server (body limit, stream limit, web root).
 */
async function withServer(fn, opts = {}) {
  const { home, cleanup } = tempHome('nos-http');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  // A real port in the config (the server still listens on an ephemeral one):
  // config validation rejects port 0, and /api/config writes go through it.
  config.server.port = 7777;
  Object.assign(config.server, opts.server || {});
  if (opts.config) Object.assign(config, opts.config);

  const bus = new Bus();
  const audit = new Audit(paths.audit).open();
  // Real encryption only where a test asks for it: scrypt is deliberately slow.
  const vaultCrypto = opts.vaultCrypto === true
    ? require('../src/store/vaultcrypto').createVaultCrypto({ paths, config })
    : (opts.vaultCrypto || null);
  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto });

  const ctx = {
    version: 'test',
    config,
    paths,
    store,
    bus,
    audit,
    logger: silentLogger,
    vaultCrypto,
    failures: [],
    ...(opts.ctx || {}),
  };

  const server = await createServer(ctx);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    await fn({
      server,
      base,
      ctx,
      store,
      bus,
      home,
      paths,
      config,
      req: (method, urlPath, body, headers) => request(base, method, urlPath, body, headers),
      stream: (urlPath, headers) => openStream(base, urlPath, headers),
    });
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    audit.close();
    cleanup();
  }
}

/* ------------------------------------------------------------------ tests */

test('Status-Route antwortet ehrlich und setzt die Sicherheits-Kopfzeilen', async () => {
  await withServer(async ({ req }) => {
    const res = await req('GET', '/api/status');
    assert.equal(res.status, 200, res.text);

    assert.equal(res.headers['content-security-policy'], CSP);
    assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers['permissions-policy'], /geolocation=\(\)/);
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'CORS darf es hier nicht geben');

    assert.equal(res.json.version, 'test');
    assert.equal(res.json.network.mode, 'offline');
    assert.equal(res.json.network.online, false);
    assert.equal(res.json.sharing.enabled, false);
    assert.equal(res.json.subsystems.store, true);
    // Ohne Registry darf nie behauptet werden, es gäbe ein Modell.
    assert.equal(res.json.models.available, false);
    assert.equal(res.json.agents.active, 0);
  });
});

test('CRUD auf /api/records: anlegen, lesen, ändern, löschen, wiederherstellen', async () => {
  await withServer(async ({ req }) => {
    const created = await req('POST', '/api/records', {
      type: 'note',
      data: { title: 'Testnotiz', body: 'Inhalt mit #marker', tags: ['test'] },
    });
    assert.equal(created.status, 200, created.text);
    const id = created.json.record.id;
    assert.equal(created.json.record.data.title, 'Testnotiz');

    const fetched = await req('GET', `/api/records/${id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.record.id, id);
    assert.ok(Array.isArray(fetched.json.edges));

    const patched = await req('PATCH', `/api/records/${id}`, { data: { title: 'Umbenannt' } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.record.data.title, 'Umbenannt');
    assert.equal(patched.json.record.rev, created.json.record.rev + 1);

    const listed = await req('GET', '/api/records?type=note&limit=10');
    assert.equal(listed.status, 200);
    assert.ok(listed.json.items.some((r) => r.id === id));
    assert.equal(typeof listed.json.total, 'number');

    const searched = await req('GET', '/api/search?q=Umbenannt');
    assert.equal(searched.status, 200, searched.text);
    assert.ok(searched.json.items.length >= 1, 'Volltextsuche findet den Eintrag nicht');
    assert.ok(searched.json.items[0].record, 'Suchtreffer tragen den Datensatz');

    const deleted = await req('DELETE', `/api/records/${id}`);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal((await req('GET', `/api/records/${id}`)).status, 404);

    const restored = await req('POST', `/api/records/${id}/restore`);
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.record.deletedAt, null);
  });
});

test('Unbekannte Routen und Einträge antworten 404 mit typisiertem Fehler', async () => {
  await withServer(async ({ req }) => {
    const route = await req('GET', '/api/gibtsnicht');
    assert.equal(route.status, 404);
    assert.equal(route.json.error.code, 'NOT_FOUND');

    const record = await req('GET', '/api/records/note_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(record.status, 404);
    assert.equal(record.json.error.code, 'NOT_FOUND');

    const method = await req('PUT', '/api/records', { type: 'note', data: {} });
    assert.equal(method.status, 405);
    assert.match(method.headers.allow || '', /POST/);
  });
});

test('Validierung: Schema, unbekannte Art und kaputtes JSON', async () => {
  await withServer(async ({ req, base }) => {
    const missingTitle = await req('POST', '/api/records', { type: 'note', data: {} });
    assert.equal(missingTitle.status, 400, missingTitle.text);
    assert.equal(missingTitle.json.error.code, 'VALIDATION_FAILED');

    const unknownType = await req('POST', '/api/records', { type: 'dings', data: {} });
    assert.equal(unknownType.status, 400);
    assert.match(unknownType.json.error.message, /Unbekannte Art/);

    const forbiddenType = await req('POST', '/api/records', { type: 'edge', data: { from: 'a', to: 'b' } });
    assert.equal(forbiddenType.status, 400);
    assert.match(forbiddenType.json.error.message, /POST \/api\/edges/);

    const badJson = await new Promise((resolve, reject) => {
      const url = new URL('/api/records', base);
      const payload = Buffer.from('{"type":"note",');
      const r = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-neural-os': '1' },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      r.on('error', reject);
      r.end(payload);
    });
    assert.equal(badJson.status, 400);
    assert.match(badJson.text, /kein gültiges JSON/);
  });
});

test('CSRF: ändernde Anfragen ohne Kopfzeile und mit fremdem Origin werden abgelehnt', async () => {
  await withServer(async ({ base, req }) => {
    const without = await request(base, 'POST', '/api/records', { type: 'note', data: { title: 'x' } }, { 'x-neural-os': '' });
    assert.ok(without.status === 400 || without.status === 403, `erwartet Ablehnung, bekam ${without.status}`);

    const foreignOrigin = await req('POST', '/api/records', { type: 'note', data: { title: 'x' } }, { origin: 'https://boese.example' });
    assert.equal(foreignOrigin.status, 403);
    assert.match(foreignOrigin.json.error.message, /Origin/);

    // Lesende Anfragen brauchen den Nachweis nicht.
    const read = await request(base, 'GET', '/api/status');
    assert.equal(read.status, 200);
  });
});

test('Ein fremder Host-Kopf wird abgelehnt (DNS-Rebinding)', async () => {
  await withServer(async ({ base }) => {
    const res = await request(base, 'GET', '/api/status', undefined, { host: 'angreifer.example.com' });
    assert.ok(res.status === 400 || res.status === 403, `erwartet Ablehnung, bekam ${res.status}`);

    const ok = await request(base, 'GET', '/api/status', undefined, { host: `localhost:${new URL(base).port}` });
    assert.equal(ok.status, 200);
  });
});

test('Eine Anfrage ganz ohne Host-Kopf wird lokal geduldet', async () => {
  const net = require('node:net');
  await withServer(async ({ base }) => {
    const port = Number(new URL(base).port);
    const answer = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        // HTTP/1.0 darf den Host-Kopf weglassen; ein Browser tut das nie.
        socket.write('GET /api/status HTTP/1.0\r\n\r\n');
      });
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { text += chunk; });
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    assert.match(answer, /^HTTP\/1\.1 200 /, answer.slice(0, 200));
    assert.match(answer, /content-security-policy/i);
  });
});

test('/api/health antwortet ohne Anmeldung, aber nur lokal', async () => {
  await withServer(async ({ base }) => {
    const res = await request(base, 'GET', '/api/health', undefined, { host: 'irgendwas.example' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.ok, true);
  });
});

test('Statische Dateien: MIME, ETag, 304 und kein Pfad-Ausbruch', async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-web-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>Neural OS</title>');
  fs.writeFileSync(path.join(site, 'app.css'), ':root{--x:1}');
  fs.mkdirSync(path.join(site, 'lib'));
  fs.writeFileSync(path.join(site, 'lib', 'api.js'), 'export const api = {};');
  try {
    await withServer(async ({ req, base }) => {
      const index = await req('GET', '/');
      assert.equal(index.status, 200, index.text);
      assert.match(index.headers['content-type'], /text\/html/);
      assert.equal(index.headers['cache-control'], 'no-cache');
      assert.ok(index.headers.etag, 'ETag fehlt');
      assert.match(index.text, /Neural OS/);
      assert.equal(index.headers['content-security-policy'], CSP);

      const again = await req('GET', '/', undefined, { 'if-none-match': index.headers.etag });
      assert.equal(again.status, 304);
      assert.equal(again.text, '');

      const css = await req('GET', '/app.css');
      assert.equal(css.status, 200);
      assert.match(css.headers['content-type'], /text\/css/);

      const mjs = await req('GET', '/lib/api.js');
      assert.equal(mjs.status, 200);
      assert.match(mjs.headers['content-type'], /javascript/);

      for (const evil of ['/../package.json', '/..%2f..%2fetc%2fpasswd', '/lib/../../src/app.js', '/%2e%2e/%2e%2e/etc/passwd']) {
        const res = await request(base, 'GET', evil);
        assert.ok(res.status >= 400, `${evil} wurde ausgeliefert (${res.status})`);
        assert.ok(!/createApp|root:/.test(res.text), `${evil} hat Inhalte nach außen gegeben`);
      }

      // Kein Auffang-200: die Oberfläche routet in der Fragment-Adresse, und
      // ein Server, der jede erfundene Adresse bejaht, belohnt das Stochern.
      const unknown = await req('GET', '/notizen');
      assert.equal(unknown.status, 404);
      const missingAsset = await req('GET', '/fehlt.css');
      assert.equal(missingAsset.status, 404);
    }, { server: { webRoot: site } });
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});

test('Fehlende Oberfläche wird benannt statt verschwiegen', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-web-leer-'));
  try {
    await withServer(async ({ req }) => {
      const res = await req('GET', '/');
      assert.equal(res.status, 404);
      assert.equal(res.json.error.code, 'UI_MISSING');
      assert.match(res.json.error.message, /index\.html/);
    }, { server: { webRoot: empty } });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('SSE: Ereignisse erreichen den Browser und werden ab einer Sequenz nachgeliefert', async () => {
  await withServer(async ({ req, stream, bus }) => {
    const events = await stream('/api/events');
    assert.equal(events.status, 200);
    assert.match(events.headers['content-type'], /text\/event-stream/);
    assert.equal(events.headers['cache-control'], 'no-store, no-transform');
    await events.waitFor('event: hello');

    const created = await req('POST', '/api/records', { type: 'note', data: { title: 'SSE-Notiz' } });
    assert.equal(created.status, 200, created.text);
    await events.waitFor('event: record.created');
    await events.waitFor('SSE-Notiz');
    assert.match(events.text, /^id: \d+$/m, 'Ereignisse brauchen eine Sequenznummer für den Wiedereinstieg');
    events.close();

    // Wiedereinstieg: alles nach der genannten Sequenz kommt noch einmal.
    const before = bus.seq;
    bus.publish('test.marker', { note: 'nachgeliefert' });
    const replay = await stream(`/api/events?since=${before}`);
    await replay.waitFor('nachgeliefert');
    assert.match(replay.text, /event: test\.marker/);
    replay.close();
  });
});

test('Der Ereignisstrom schlägt Herz, damit er nicht für tot gehalten wird', async () => {
  // In der Anwendung alle 25 s; hier verkürzt, damit der Test schnell bleibt.
  await withServer(async ({ stream }) => {
    const events = await stream('/api/events');
    await events.waitFor('event: hello');
    await events.waitFor(/^: hb /m, 2500);
    events.close();
  }, { server: { heartbeatMs: 1000 } });
});

test('HEAD auf den Ereignisstrom öffnet keine Leitung ins Leere', async () => {
  await withServer(async ({ req, server }) => {
    const res = await req('HEAD', '/api/events');
    assert.equal(res.status, 405);
    assert.equal(server.streamCount(), 0);
  });
});

test('Die Zahl gleichzeitiger Ereignisströme ist begrenzt', async () => {
  await withServer(async ({ stream, server }) => {
    const first = await stream('/api/events');
    const second = await stream('/api/events');
    await first.waitFor('event: hello');
    await second.waitFor('event: hello');
    assert.equal(server.streamCount(), 2);

    const third = await stream('/api/events');
    assert.equal(third.status, 503);
    await third.waitFor('TOO_MANY_STREAMS');

    first.close();
    second.close();
    third.close();
    // Nach dem Schließen ist wieder Platz.
    await sleep(60);
    assert.ok(server.streamCount() <= 1, `es blieben ${server.streamCount()} Ströme offen`);
  }, { server: { maxEventStreams: 2 } });
});

test('Sauberes Herunterfahren beendet offene Ströme', async () => {
  await withServer(async ({ stream, server }) => {
    const events = await stream('/api/events');
    await events.waitFor('event: hello');
    await server.close();
    await events.waitForEnd();
    assert.match(events.text, /event: server/);
    assert.equal(server.streamCount(), 0);
  });
});

test('Das Body-Limit greift, bevor der Speicher volläuft', async () => {
  await withServer(async ({ base }) => {
    const payload = Buffer.alloc(64 * 1024, 0x61);
    const res = await request(base, 'POST', '/api/records', payload, {
      'content-type': 'application/json',
      'x-neural-os': '1',
    });
    assert.equal(res.status, 413, res.text);
    assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');

    // Danach ist der Server weiter ansprechbar.
    const after = await request(base, 'GET', '/api/status');
    assert.equal(after.status, 200);
  }, { server: { maxBodyBytes: 2048 } });
});

test('Eine halb gesendete Anfrage blockiert die Verbindung nicht für immer', async () => {
  await withServer(async ({ base }) => {
    const url = new URL('/api/records', base);
    const outcome = await new Promise((resolve, reject) => {
      const r = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        // Angekündigt, aber nie gesendet: der Server muss von sich aus auflegen.
        headers: { 'content-type': 'application/json', 'content-length': 5000, 'x-neural-os': '1' },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve({ kind: 'status', status: res.statusCode }));
      });
      r.on('error', (err) => resolve({ kind: 'error', code: err.code }));
      r.write('{');
      // kein r.end(): die Anfrage bleibt unvollständig
      setTimeout(() => reject(new Error('Der Server hat die unvollständige Anfrage nicht beendet.')), 5000).unref();
    });
    assert.ok(
      (outcome.kind === 'status' && (outcome.status === 408 || outcome.status === 400))
      || outcome.kind === 'error',
      `erwartet Abbruch durch den Server, bekam ${JSON.stringify(outcome)}`,
    );
  }, { server: { requestTimeoutMs: 700 } });
});

test('Chat: /send streamt delta, message und done', async () => {
  const sent = [];
  const fakeChat = {
    create(data) { return { id: 'chat_stub', type: 'chat', data }; },
    get(id) {
      if (id !== 'chat_fake000000000000000000') {
        const { NotFoundError } = require('../src/kernel/errors');
        throw new NotFoundError(`Chat ${id}`);
      }
      return { id, type: 'chat', data: { title: 'Fake' } };
    },
    async send({ chatId, content, onEvent }) {
      sent.push(content);
      onEvent({ type: 'user', record: { id: 'message_u', data: { role: 'user', content } } });
      onEvent({ type: 'delta', chatId, messageId: 'message_a', text: 'Teil ' });
      onEvent({ type: 'delta', chatId, messageId: 'message_a', text: 'zwei' });
      onEvent({ type: 'message', record: { id: 'message_a', data: { role: 'assistant', content: 'Teil zwei' } } });
      onEvent({ type: 'done', chatId, messageId: 'message_a', status: 'complete' });
      return { message: { id: 'message_a' } };
    },
  };

  await withServer(async ({ base }) => {
    const url = new URL('/api/chats/chat_fake000000000000000000/send', base);
    const payload = Buffer.from(JSON.stringify({ content: 'Hallo?' }));
    const res = await new Promise((resolve, reject) => {
      const r = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'x-neural-os': '1',
          accept: 'text/event-stream',
        },
      }, (response) => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', (c) => { text += c; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
      });
      r.on('error', reject);
      r.end(payload);
    });

    assert.equal(res.status, 200, res.text);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.text, /event: delta/);
    assert.match(res.text, /Teil /);
    assert.match(res.text, /event: message/);
    assert.match(res.text, /event: done/);
    assert.deepEqual(sent, ['Hallo?']);
  }, { ctx: { chat: fakeChat } });
});

test('Das Body-Limit greift auch ohne angekündigte Länge (chunked)', async () => {
  await withServer(async ({ base }) => {
    const url = new URL('/api/records', base);
    const res = await new Promise((resolve, reject) => {
      const r = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        // Keine content-length: Node sendet chunked, die Grenze muss während
        // des Lesens greifen.
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', 'x-neural-os': '1' },
      }, (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      r.on('error', reject);
      r.write(Buffer.alloc(8 * 1024, 0x61));
      r.write(Buffer.alloc(8 * 1024, 0x61));
      r.end();
    });
    assert.equal(res.status, 413, res.text);
    assert.match(res.text, /PAYLOAD_TOO_LARGE/);
  }, { server: { maxBodyBytes: 4096 } });
});

test('Ein abgebrochener Chat-Abruf bricht auch die Antwort des Modells ab', async () => {
  let aborted = false;
  let started = null;
  const slowChat = {
    get(id) { return { id, type: 'chat', data: {} }; },
    send({ signal, onEvent }) {
      onEvent({ type: 'delta', text: 'erstes Stück' });
      return new Promise((resolve) => {
        const finish = () => {
          aborted = signal.aborted;
          resolve({ message: { id: 'message_x' } });
        };
        signal.addEventListener('abort', finish, { once: true });
        started();
      });
    },
  };

  await withServer(async ({ base }) => {
    const url = new URL('/api/chats/chat_egal0000000000000000000/send', base);
    const payload = Buffer.from(JSON.stringify({ content: 'Lange Frage' }));
    const running = new Promise((resolve) => { started = resolve; });

    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-neural-os': '1' },
    });
    // Das Abreißen der Verbindung ist hier der Test, kein Fehlerfall.
    req.on('error', () => {});
    req.end(payload);
    await running;
    // Der Tab wird geschlossen, während das Modell noch schreibt.
    req.destroy();

    const deadline = Date.now() + 3000;
    while (!aborted && Date.now() < deadline) await sleep(15);
    assert.equal(aborted, true, 'die Antwort lief nach dem Verbindungsabbruch weiter');
  }, { ctx: { chat: slowChat } });
});

test('Chat: ein Fehler des Dienstes wird als Ereignis gemeldet, nie als erfundene Antwort', async () => {
  const { NoModelError, NotFoundError } = require('../src/kernel/errors');
  const failingChat = {
    get(id) {
      if (id !== 'chat_fake000000000000000000') throw new NotFoundError(`Chat ${id}`);
      return { id, type: 'chat', data: {} };
    },
    async send() {
      throw new NoModelError('Es ist kein lokales Modell erreichbar.');
    },
  };

  await withServer(async ({ base, req }) => {
    const url = new URL('/api/chats/chat_fake000000000000000000/send', base);
    const payload = Buffer.from(JSON.stringify({ content: 'Frage' }));
    const res = await new Promise((resolve, reject) => {
      const r = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-neural-os': '1' },
      }, (response) => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', (c) => { text += c; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      });
      r.on('error', reject);
      r.end(payload);
    });

    assert.match(res.text, /event: error/);
    assert.match(res.text, /NO_MODEL_AVAILABLE/);
    assert.match(res.text, /event: done/);
    assert.ok(!/"role":"assistant","content":"[^"]+"/.test(res.text), 'es darf keine erfundene Antwort auftauchen');

    // Leere Eingaben scheitern als Statuscode, bevor ein Strom geöffnet wird.
    const empty = await req('POST', '/api/chats/chat_fake000000000000000000/send', { content: '   ' });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'VALIDATION_FAILED');

    const missing = await req('POST', '/api/chats/chat_fehlt00000000000000000/send', { content: 'x' });
    assert.equal(missing.status, 404);
  }, { ctx: { chat: failingChat } });
});

test('Fehlende Subsysteme antworten 503 mit klarer Meldung statt abzustürzen', async () => {
  await withServer(async ({ req, store }) => {
    const agent = store.create('agent', { name: 'Testagent' });

    const run = await req('POST', `/api/agents/${agent.id}/run`, { goal: 'Etwas tun' });
    assert.equal(run.status, 503, run.text);
    assert.equal(run.json.error.code, 'SUBSYSTEM_UNAVAILABLE');
    assert.match(run.json.error.message, /Laufzeit/);

    const models = await req('GET', '/api/models');
    assert.equal(models.status, 503);
    assert.match(models.json.error.message, /Modellverwaltung/);

    const graph = await req('GET', '/api/graph');
    assert.equal(graph.status, 503);

    const chat = await req('POST', '/api/chats/chat_egal0000000000000000000/send', { content: 'Hallo' });
    assert.equal(chat.status, 503);

    const backup = await req('POST', '/api/backup/export', {});
    assert.equal(backup.status, 503);

    // Der Server lebt danach unverändert weiter.
    assert.equal((await req('GET', '/api/status')).status, 200);
  });
});

test('Graph-Routen liefern Knoten, Kanten und manuelle Verknüpfungen', async () => {
  const graph = { ...require('../src/graph/view'), ...require('../src/graph/derive') };
  await withServer(async ({ req }) => {
    const a = await req('POST', '/api/records', { type: 'note', data: { title: 'Erste', body: 'Verweis auf [[Zweite]]' } });
    const b = await req('POST', '/api/records', { type: 'note', data: { title: 'Zweite' } });
    assert.equal(b.status, 200, b.text);

    const edge = await req('POST', '/api/edges', { from: a.json.record.id, to: b.json.record.id, kind: 'related', reason: 'Test' });
    assert.equal(edge.status, 200, edge.text);
    assert.equal(edge.json.record.data.source, 'manual', 'von Hand gezogene Kanten sind niemals "derived"');

    const view = await req('GET', `/api/graph?focus=${a.json.record.id}&depth=2`);
    assert.equal(view.status, 200, view.text);
    assert.ok(view.json.nodes.length >= 2, 'der Graph muss beide Notizen enthalten');
    assert.ok(view.json.edges.some((e) => e.id === edge.json.record.id));

    const edges = await req('GET', `/api/edges?node=${a.json.record.id}`);
    assert.equal(edges.status, 200);
    assert.ok(edges.json.items.length >= 1);

    const rescan = await req('POST', '/api/graph/rescan');
    assert.equal(rescan.status, 200, rescan.text);
    assert.equal(typeof rescan.json.scanned, 'number');

    const removed = await req('DELETE', `/api/edges/${edge.json.record.id}`);
    assert.equal(removed.status, 200, removed.text);

    const selfLink = await req('POST', '/api/edges', { from: a.json.record.id, to: a.json.record.id });
    assert.equal(selfLink.status, 400);
  }, { ctx: { graph } });
});

test('Netz-Prüfung entscheidet, ohne zu verbinden', async () => {
  const calls = [];
  const fakeGate = {
    mode: 'offline',
    classify(host) { return host === '127.0.0.1' ? 'loopback' : 'public'; },
    check(opts) {
      calls.push(opts);
      const allowed = opts.host === '127.0.0.1';
      return { allowed, level: allowed ? 'local' : 'blocked', classification: this.classify(opts.host), reason: allowed ? 'Lokale Adresse.' : 'Im Modus offline gesperrt.' };
    },
    listGrants() { return []; },
    stats() { return { allowed: 0, blocked: 0, byHost: {} }; },
    reachability() { return { mode: 'offline', loopback: true, lan: false, internet: false }; },
    effectiveFor(scope) { return { mode: 'offline', scope, hosts: [], grants: [] }; },
    async fetch() { throw new Error('Ein Test darf niemals wirklich ins Netz gehen.'); },
  };

  await withServer(async ({ req }) => {
    const overview = await req('GET', '/api/network');
    assert.equal(overview.status, 200, overview.text);
    assert.equal(overview.json.mode, 'offline');
    assert.deepEqual(overview.json.grants, []);

    const blocked = await req('POST', '/api/network/test', { host: 'example.com', port: 443 });
    assert.equal(blocked.status, 200, blocked.text);
    assert.equal(blocked.json.decision.allowed, false);
    assert.equal(blocked.json.connected, false);

    const local = await req('POST', '/api/network/test', { host: '127.0.0.1', port: 11434 });
    assert.equal(local.json.decision.allowed, true);

    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.record === false), 'eine Was-wäre-wenn-Frage darf die Statistik nicht verfälschen');

    const badPort = await req('POST', '/api/network/test', { host: 'example.com', port: 99999 });
    assert.equal(badPort.status, 400);
  }, { ctx: { gate: fakeGate } });
});

test('Ein geteilter Zugang darf lesen, aber die Netz-Policy nicht ändern', async () => {
  const guest = {
    async middleware() {
      return { ok: true, identity: { kind: 'token', permissions: { read: true, write: false, chat: false, agents: false } } };
    },
  };
  await withServer(async ({ req }) => {
    assert.equal((await req('GET', '/api/status')).status, 200);

    const write = await req('POST', '/api/records', { type: 'note', data: { title: 'Fremd' } });
    assert.equal(write.status, 403, write.text);
    assert.equal(write.json.error.code, 'PERMISSION_DENIED');

    const policy = await req('PUT', '/api/network', { mode: 'online' });
    assert.equal(policy.status, 403);
    assert.match(policy.json.error.message, /geteilten Zugang/);
  }, { ctx: { auth: guest } });
});

test('Eine abgelehnte Anmeldung endet als 401, nicht als Absturz', async () => {
  const strict = {
    async middleware() {
      return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Zugangstoken fehlt.', status: 401 } };
    },
  };
  await withServer(async ({ req }) => {
    const res = await req('GET', '/api/status');
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'UNAUTHORIZED');
    assert.match(res.headers['www-authenticate'] || '', /Bearer/);
    // Health bleibt für Aufsichtsprozesse erreichbar.
    assert.equal((await req('GET', '/api/health')).status, 200);
  }, { ctx: { auth: strict } });
});

test('Ein unerwarteter Fehler wird zu 500 ohne Stapelspur', async () => {
  const explodingGate = {
    mode: 'offline',
    check() { const err = new Error('/home/geheim/pfad kaputt'); err.stack = 'Error: geheim\n    at irgendwo'; throw err; },
    classify() { return 'public'; },
    listGrants() { return []; },
    stats() { return {}; },
    reachability() { return {}; },
  };
  await withServer(async ({ req }) => {
    const res = await req('POST', '/api/network/test', { host: 'example.com' });
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, 'INTERNAL_ERROR');
    assert.ok(!/geheim/.test(res.text), 'interne Pfade dürfen den Client nie erreichen');
    assert.ok(!/at irgendwo/.test(res.text), 'Stapelspuren gehören ins Protokoll, nicht in die Antwort');
  }, { ctx: { gate: explodingGate } });
});

test('PATCH /api/config schreibt die Konfiguration und verschweigt Geheimnisse', async () => {
  await withServer(async ({ req, paths }) => {
    const before = await req('GET', '/api/config');
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.config.ui.theme, 'system');

    const patched = await req('PATCH', '/api/config', { ui: { theme: 'dark' } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.config.ui.theme, 'dark');

    const onDisk = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    assert.equal(onDisk.ui.theme, 'dark');

    const invalid = await req('PATCH', '/api/config', { server: { port: 70000 } });
    assert.equal(invalid.status, 400, invalid.text);
  });
});

test('Geheimnisse aus der Konfiguration verlassen den Server nicht', async () => {
  const { sanitiseConfig } = require('../src/http/api/system');
  const sanitised = sanitiseConfig({
    security: { sharing: { enabled: true, requireToken: true } },
    models: { remote: [{ id: 'x', apiKey: 'sk-geheim', apiKeyEnv: 'OPENAI_API_KEY' }] },
    token: 'abc',
  });
  assert.equal(sanitised.models.remote[0].apiKey, '[gesetzt]');
  assert.equal(sanitised.models.remote[0].apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(sanitised.token, '[gesetzt]');
  // Einstellungen, die nur zufällig wie ein Geheimnis heißen, bleiben lesbar.
  assert.equal(sanitised.security.sharing.requireToken, true);
});

test('HEAD und OPTIONS verhalten sich vorhersagbar', async () => {
  await withServer(async ({ req }) => {
    const head = await req('HEAD', '/api/status');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-security-policy'], CSP);

    const options = await req('OPTIONS', '/api/status');
    assert.equal(options.status, 204);
    assert.match(options.headers.allow, /GET/);
    assert.equal(options.headers['access-control-allow-origin'], undefined);
  });
});

test('Sicherung: Export, Download und Prüfung greifen wirklich auf den Vault zu', async () => {
  const { createBackup } = require('../src/store/backup');
  await withServer(async ({ req, store, ctx, paths }) => {
    // Das Backup-Subsystem wird hier echt gebaut, nicht nachgeahmt.
    ctx.backup = createBackup({ store, paths, config: ctx.config, logger: SILENT });
    store.create('note', { title: 'Muss gesichert werden', body: 'Inhalt', tags: ['sicherung'] });
    await store.flush();

    const exported = await req('POST', '/api/backup/export', { format: 'json', includeFiles: false });
    assert.equal(exported.status, 200, exported.text);
    assert.ok(exported.json.records >= 1, 'der Export enthält keine Einträge');
    assert.ok(fs.existsSync(path.join(exported.json.dir, 'export.json')));

    const verified = await req('GET', `/api/backup/verify?dir=${encodeURIComponent(exported.json.dir)}`);
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.json.ok, true, JSON.stringify(verified.json.problems));

    const download = await req('GET', '/api/backup/download');
    assert.equal(download.status, 200, download.text.slice(0, 200));
    assert.match(download.headers['content-disposition'], /attachment; filename="neural-os-/);
    assert.equal(download.headers['x-neural-os-blobs'], 'excluded');
    const payload = JSON.parse(download.text);
    assert.equal(payload.kind, 'neural-os-export');
    assert.ok(payload.records.some((r) => r.data && r.data.title === 'Muss gesichert werden'));

    // Der Download hinterlässt kein Verzeichnis im Export-Ordner. Aufgeräumt
    // wird serverseitig, nachdem die Antwort durch ist -- also kurz warten.
    const deadline = Date.now() + 2000;
    let leftovers = [];
    do {
      leftovers = fs.readdirSync(paths.exports).filter((name) => name.startsWith('download-'));
      if (!leftovers.length) break;
      await sleep(20);
    } while (Date.now() < deadline);
    assert.deepEqual(leftovers, [], `zurückgelassene Verzeichnisse: ${leftovers.join(', ')}`);

    const imported = await req('POST', '/api/backup/import', { dir: exported.json.dir, mode: 'merge' });
    assert.equal(imported.status, 200, imported.text);
    assert.equal(typeof imported.json.imported, 'number');

    const badMode = await req('POST', '/api/backup/import', { dir: exported.json.dir, mode: 'dings' });
    assert.equal(badMode.status, 400);
  });
});

test('Vault: Verschlüsselung anschalten schreibt den bestehenden Vault wirklich neu', async () => {
  await withServer(async ({ req, store, paths }) => {
    const note = store.create('note', { title: 'Klartext-Kanarienvogel' });
    await store.flush();

    const segments = fs.readdirSync(paths.log).map((name) => path.join(paths.log, name));
    const plainBefore = segments.some((file) => fs.readFileSync(file, 'utf8').includes('Klartext-Kanarienvogel'));
    assert.equal(plainBefore, true, 'unverschlüsselt muss der Text lesbar sein, sonst prüft der Test nichts');

    const before = await req('GET', '/api/vault');
    assert.equal(before.json.state, 'disabled');

    const encrypted = await req('POST', '/api/vault/encrypt', { passphrase: 'ein gutes langes Passwort' });
    assert.equal(encrypted.status, 200, encrypted.text);
    assert.equal(encrypted.json.state, 'unlocked');
    assert.ok(encrypted.json.rewritten, 'der bestehende Vault wurde nicht neu geschrieben');

    const stillPlain = fs.readdirSync(paths.log)
      .map((name) => fs.readFileSync(path.join(paths.log, name), 'utf8'))
      .concat(fs.existsSync(paths.snapshot) ? [fs.readFileSync(paths.snapshot, 'utf8')] : [])
      .some((text) => text.includes('Klartext-Kanarienvogel'));
    assert.equal(stillPlain, false, 'nach dem Einschalten darf kein Klartext mehr auf der Platte liegen');
    assert.ok(store.get(note.id), 'der Eintrag muss weiterhin lesbar sein');

    const tooShort = await req('POST', '/api/vault/encrypt', { passphrase: 'kurz' });
    assert.ok(tooShort.status === 400, `erwartet 400, bekam ${tooShort.status}`);

    const locked = await req('POST', '/api/vault/lock');
    assert.equal(locked.status, 200, locked.text);
    assert.equal(locked.json.state, 'locked');
  }, { vaultCrypto: true });
});

test('Agenten, Läufe und Bestätigungen gehen durch die echte Rechtelogik', async () => {
  const { createApprovals } = require('../src/agents/approvals');
  await withServer(async ({ req, store, ctx, bus }) => {
    const started = [];
    ctx.runtime = {
      async start({ agentId, goal }) {
        const run = store.create('run', { agentId, goal, status: 'running', startedAt: new Date().toISOString() });
        started.push(run.id);
        return run;
      },
      abort(runId) { return started.includes(runId); },
      listActive() { return started.map((id) => store.get(id)).filter(Boolean); },
      transcript() { return [{ kind: 'run.started' }]; },
    };
    ctx.approvals = createApprovals({ store, bus, config: ctx.config });

    const created = await req('POST', '/api/agents', {
      name: 'Rechercheur',
      // Absichtlich nur eine Fähigkeit: alles andere muss verweigert bleiben.
      permissions: { readNotes: true },
    });
    assert.equal(created.status, 200, created.text);
    const agentId = created.json.record.id;
    assert.equal(created.json.record.data.permissions.readNotes, true);
    assert.equal(created.json.record.data.permissions.writeNotes, false, 'fehlende Fähigkeiten müssen verweigert sein');
    assert.equal(created.json.record.data.permissions.network, 'offline');

    const listed = await req('GET', '/api/agents');
    assert.ok(listed.json.items.some((a) => a.id === agentId));

    const patched = await req('PATCH', `/api/agents/${agentId}`, { permissions: { createEdges: true } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.record.data.permissions.createEdges, true);
    assert.equal(patched.json.record.data.permissions.readNotes, true, 'ein Teil-Patch darf nichts stillschweigend zurücksetzen');

    const run = await req('POST', `/api/agents/${agentId}/run`, { goal: 'Notizen ordnen' });
    assert.equal(run.status, 200, run.text);
    assert.ok(run.json.runId);

    const runs = await req('GET', '/api/runs?status=running');
    assert.ok(runs.json.items.some((r) => r.id === run.json.runId));
    assert.deepEqual(runs.json.active, [run.json.runId]);

    const detail = await req('GET', `/api/runs/${run.json.runId}?transcript=1`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.transcript.length, 1);

    const aborted = await req('POST', `/api/runs/${run.json.runId}/abort`);
    assert.equal(aborted.json.aborted, true);

    const goalMissing = await req('POST', `/api/agents/${agentId}/run`, {});
    assert.equal(goalMissing.status, 400);

    // Eine echte Bestätigung wartet, bis sie über die API beantwortet wird.
    const waiting = ctx.approvals.request({ kind: 'tool', summary: 'Datei schreiben', agentId, timeoutMs: 5000 });
    const pending = await req('GET', '/api/approvals');
    assert.equal(pending.json.items.length, 1, pending.text);
    const approvalId = pending.json.items[0].id;

    const decided = await req('POST', `/api/approvals/${approvalId}`, { decision: 'approved' });
    assert.equal(decided.status, 200, decided.text);
    assert.equal(decided.json.record.data.status, 'approved');
    assert.equal(await waiting, true, 'die wartende Anfrage wurde nicht freigegeben');

    const nonsense = await req('POST', `/api/approvals/${approvalId}`, { decision: 'vielleicht' });
    assert.equal(nonsense.status, 400);
  });
});

test('Modelle: die Übersicht sondiert nicht, die Aktualisierung schon', async () => {
  let probes = 0;
  let snapshot = { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', available: false, models: [], error: 'nicht erreichbar' }], at: null };
  const registry = {
    list() { return snapshot; },
    async refresh() {
      probes++;
      snapshot = { at: new Date().toISOString(), providers: [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', available: true, models: [{ id: 'llama3.2' }], error: null, latencyMs: 3 }] };
      return snapshot;
    },
    installHint() { return 'Installiere Ollama und lade ein Modell: ollama pull llama3.2'; },
  };

  await withServer(async ({ req }) => {
    const before = await req('GET', '/api/models');
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.available, false);
    assert.match(before.json.hint, /ollama pull/, 'ohne Modell gehört die Anleitung in die Antwort');
    assert.equal(probes, 0, 'die Übersicht darf nichts sondieren');

    const refreshed = await req('POST', '/api/models/refresh');
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.equal(refreshed.json.available, true);
    assert.equal(refreshed.json.hint, undefined, 'mit Modell braucht es keine Anleitung');
    assert.equal(probes, 1);

    // Der Status übernimmt die Momentaufnahme, ohne erneut zu sondieren.
    const status = await req('GET', '/api/status');
    assert.equal(status.json.models.available, true);
    assert.deepEqual(status.json.models.providers[0].models, ['llama3.2']);
    assert.equal(probes, 1);
  }, { ctx: { registry } });
});

/* ------------------------------------------------- Zum Home-Bildschirm */

/**
 * Warum diese vier Pruefungen hier stehen
 * ---------------------------------------
 * Neural OS gibt es nicht im App Store. Auf einem iPad entsteht das
 * App-Symbol ausschliesslich ueber "Zum Home-Bildschirm", und dafuer muessen
 * vier Dinge gleichzeitig stimmen: ein Manifest, ein PNG (iOS nimmt an dieser
 * Stelle KEIN SVG), die Verweise darauf im HTML, und die Dateien im Cache des
 * Service Workers. Faellt eines davon weg, bekommt der Nutzer statt eines
 * Symbols ein graues Rechteck -- und merkt es erst auf dem Geraet, wo kein
 * Test mehr hinreicht.
 */
const WEB = path.join(__dirname, '..', 'web');

test('das Manifest fuer den Home-Bildschirm ist vollstaendig, und seine Symbole gibt es wirklich', () => {
  const roh = fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(roh);

  assert.equal(manifest.name, 'Neural OS');
  assert.equal(manifest.display, 'standalone', 'ohne "standalone" oeffnet das Symbol nur einen Safari-Tab');
  assert.ok(manifest.start_url, 'ohne start_url weiss das Geraet nicht, was es oeffnen soll');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'zu wenige Symbole');

  for (const symbol of manifest.icons) {
    const datei = path.join(WEB, symbol.src.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(datei), `das Manifest nennt ${symbol.src}, die Datei fehlt aber`);
    // Die ersten acht Bytes einer PNG-Datei sind festgelegt. Ein leeres oder
    // halb geschriebenes Symbol faellt hier auf, nicht erst auf dem Geraet.
    const kopf = fs.readFileSync(datei).subarray(0, 8);
    assert.deepEqual([...kopf], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${symbol.src} ist keine PNG-Datei`);
  }
  assert.ok(manifest.icons.some((s) => s.purpose === 'maskable'),
    'ohne ein maskable-Symbol schneidet Android die Marke an');
});

test('index.html verweist auf Manifest und ein PNG-Symbol, das es gibt', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

  assert.match(html, /<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.webmanifest"/,
    'ohne den Manifest-Verweis findet das Geraet das Manifest nicht');
  const touch = html.match(/<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/);
  assert.ok(touch, 'kein apple-touch-icon — auf iOS bleibt das Symbol dann ein Bildschirmausschnitt');
  assert.ok(touch[1].endsWith('.png'), `iOS nimmt hier nur PNG, hier steht: ${touch[1]}`);
  assert.ok(fs.existsSync(path.join(WEB, touch[1].replace(/^\.\//, ''))),
    `index.html verweist auf ${touch[1]}, die Datei fehlt`);
  assert.match(html, /name="apple-mobile-web-app-capable"\s+content="yes"/,
    'die im Umlauf befindlichen iPad-Fassungen lesen weiterhin nur diese Zeile');
});

test('der Service Worker legt Manifest und Symbol mit in den Cache', () => {
  const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
  for (const datei of ['./manifest.webmanifest', './icons/icon-180.png']) {
    assert.ok(sw.includes(`'${datei}'`),
      `${datei} fehlt in SHELL_ASSETS — ein vom Home-Bildschirm gestartetes Fenster zeigt dann beim ersten Start ohne Server kein Symbol`);
  }
});

test('die Bildmarke im Symbol-Werkzeug ist dieselbe wie in der Oberflaeche', () => {
  // Die Marke steht an zwei Stellen, weil das Werkzeug ohne Browser laeuft und
  // web/app.js ein ES-Modul ist. Zwei Kopien laufen frueher oder spaeter
  // auseinander -- dann traegt die Anwendung ein anderes Zeichen als ihr
  // Symbol auf dem Home-Bildschirm, und das faellt niemandem auf.
  const werkzeug = fs.readFileSync(path.join(__dirname, '..', 'tools', 'make-icons.js'), 'utf8');
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

  const ausWerkzeug = werkzeug.match(/const MARK = ([\s\S]*?);\n/);
  assert.ok(ausWerkzeug, 'MARK in tools/make-icons.js nicht gefunden');
  const ausApp = app.match(/brand:\s*'([^']*)'/);
  assert.ok(ausApp, 'ICONS.brand in web/app.js nicht gefunden');

  // Aus dem Werkzeug kommt ein mehrzeiliger Ausdruck mit + verknuepfter
  // Zeichenketten; hier interessiert nur, was am Ende dasteht.
  const zusammengesetzt = [...ausWerkzeug[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
  assert.equal(zusammengesetzt, ausApp[1],
    'die Marke im Werkzeug und die in der Oberflaeche sind verschieden');
});

module.exports = { name: 'server', tests: drain() };
