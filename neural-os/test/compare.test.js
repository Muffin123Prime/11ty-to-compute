'use strict';

/**
 * Tests for src/models/compare.js and src/http/api/compare.js.
 *
 * Two rules hold in every test here:
 *   - no test touches the real home directory (always `tempHome`);
 *   - no test reaches the internet. There is no language model installed in
 *     this environment, so the model side is a hand-written registry
 *     stand-in -- but the GATE is the real one, with the real config, because
 *     every claim worth testing in this file is a claim about the gate:
 *     what it would refuse, and what it really decided.
 *
 * What is therefore NOT proven here, and cannot be: that a real backend
 * streams two answers correctly. The success path is exercised against a fake
 * provider; the honest paths (blocked, no model, one side down, abort) are
 * exercised end to end.
 *
 * The addresses are reserved on purpose. 203.0.113.x is RFC 5737 TEST-NET-3,
 * never routed on the public internet, and this gate deliberately classifies
 * every reserved range as 'private' so a test cannot turn into a real request
 * by accident -- which is why the "ferne" side below comes out as `ort: 'lan'`
 * rather than 'online'. What the observation test actually proves is the line
 * that matters: loopback is not network use, anything else is. The one
 * genuinely public literal in this file appears only in a `plan()` test, and
 * `plan()` is proven to open no connection at all.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const { createGate } = require('../src/net/gate');
const { createRegistry } = require('../src/models/registry');
const { createCompare } = require('../src/models/compare');
const compareApi = require('../src/http/api/compare');
const { NoModelError, ModelError, AbortedError } = require('../src/kernel/errors');

/** Tests must not write diagnostics over the runner's output. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Die Backends der Attrappe. Keines wird jemals wirklich angesprochen. */
const LOCAL = { id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'lokalmodell' };
const FERN = { id: 'fern', kind: 'openai', baseUrl: 'https://203.0.113.5/v1', model: 'fernmodell' };
const NAMED = { id: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' };
/** Oeffentlich klassifiziert. Nur in plan() benutzt, das nichts verbindet. */
const WEB = { id: 'web', kind: 'openai', baseUrl: 'https://93.184.216.34/v1', model: 'webmodell' };

/**
 * A registry stand-in.
 *
 * `chatImpl(target, options)` receives exactly what the real registry hands a
 * provider, so a test can stream, stall, abort or throw precisely where a real
 * backend would. `probed` decides whether the snapshot claims a provider was
 * seen up -- the real registry's `list()` never probes either.
 */
function fakeRegistry(targets, chatImpl, opts = {}) {
  const probedAt = opts.probed === false ? null : new Date().toISOString();
  return {
    calls: [],
    list() {
      return {
        at: probedAt,
        providers: targets.map((t) => ({
          id: t.id,
          kind: t.kind,
          baseUrl: t.baseUrl,
          available: opts.unavailable === t.id ? false : opts.probed !== false,
          error: opts.unavailable === t.id ? 'Verbindung abgelehnt.' : null,
          models: [{ id: t.model, name: t.model }],
        })),
      };
    },
    resolve(ref) {
      const want = typeof ref === 'string'
        ? { provider: ref.split('/')[0], model: ref.split('/').slice(1).join('/') }
        : (ref && typeof ref === 'object' ? ref : { provider: null, model: null });
      const hit = want.provider
        ? targets.find((t) => t.id === want.provider)
        : targets[0];
      if (!hit) throw new NoModelError(`Kein Anbieter "${want.provider}".`);
      return { providerId: hit.id, kind: hit.kind, baseUrl: hit.baseUrl, model: want.model || hit.model };
    },
    explain(headline) {
      return `${headline || 'Es ist kein Modell verfügbar.'}\n\nAnleitung der Attrappe.`;
    },
    async chat(ref, options) {
      const target = this.resolve(ref);
      this.calls.push({ target, options });
      return chatImpl(target, options);
    },
  };
}

/**
 * The real gate, a real store, a real bus -- everything except the model.
 * @param {(env:object)=>any} fn
 */
async function withCompare(label, fn, opts = {}) {
  const { home, cleanup } = tempHome(label);
  const bus = new Bus();
  const store = await openStore({ paths: home, bus, logger: silentLogger });
  const config = configMod.defaults();
  if (typeof opts.mutateConfig === 'function') opts.mutateConfig(config);
  const audit = new Audit(`${home}/audit.jsonl`).open();
  const gate = createGate({ config, bus, audit, store, logger: silentLogger });
  const registry = opts.registry || fakeRegistry([LOCAL], async () => ({ content: 'x', stats: {} }));
  const compare = createCompare({ registry, gate, store, bus, config, logger: silentLogger });
  const attempts = [];
  bus.on('network.attempt', (evt) => attempts.push(evt.payload));
  try {
    await fn({ home, bus, store, config, gate, registry, compare, attempts });
  } finally {
    await store.close().catch(() => {});
    cleanup();
  }
}

/** A provider that streams, and that goes through the gate exactly as a real one does. */
function gatedStreamer(chunks, opts = {}) {
  return async function chatImpl(target, options) {
    const url = new URL(target.baseUrl);
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    // This is what makes `usedNetwork` an observation: the decision below is a
    // real gate decision, published on the real bus under this side's scope.
    opts.gate.enforce({
      host: url.hostname,
      port,
      scope: options.scope,
      purpose: options.purpose,
    });
    for (const chunk of chunks) {
      if (options.signal && options.signal.aborted) throw new AbortedError('Abgebrochen.');
      options.onDelta(chunk);
      await sleep(opts.delayMs || 0);
    }
    return { content: chunks.join(''), stats: { promptTokens: 7, completionTokens: 11, ms: 3 }, provider: target.providerId, model: target.model };
  };
}

/* ------------------------------------------------------------------ plan */

test('plan: verbindet nichts und meldet einen öffentlichen Host im Offline-Modus als gesperrt', async () => {
  await withCompare('nos-cmp-plan', async ({ compare, attempts, gate, config }) => {
    assert.equal(config.network.mode, 'offline', 'Voraussetzung: der Standard ist offline');
    const statsBefore = gate.stats();

    const plan = await compare.plan({ a: 'ollama/lokalmodell', b: 'openai/gpt-test' });

    assert.equal(plan.a.ort, 'lokal');
    assert.equal(plan.a.verlaesstGeraet, false);
    assert.equal(plan.a.gate.erlaubt, true, 'ein Modell auf 127.0.0.1 ist keine Netznutzung');

    assert.equal(plan.b.modell.host, 'api.openai.com');
    assert.equal(plan.b.verlaesstGeraet, true);
    assert.equal(plan.b.gate.erlaubt, false, 'im Offline-Modus ist ein öffentlicher Host gesperrt');
    assert.match(plan.b.gate.grund, /offline/i);
    // Die Schleuse zitiert den Geltungsbereich in ihrer Begründung zurück.
    // Ein Satz, den ein Mensch vor dem Senden liest, darf deshalb keine
    // internen Marken enthalten -- der Plan fragt mit dem reinen Chat-Bereich.
    assert.ok(!/vergleich:/.test(plan.b.gate.grund), `interne Marke im Grund: ${plan.b.gate.grund}`);
    assert.ok(!/vergleich:/.test(plan.b.hinweis), `interne Marke im Hinweis: ${plan.b.hinweis}`);
    assert.match(plan.b.hinweis, /verlassen damit diesen Rechner/);
    assert.match(plan.b.hinweis, /sperren/i, 'der Plan verschweigt die Sperre nicht');
    // Ein noch nicht aufgeloester Name ist nicht 'online' -- nur sicher nicht
    // dieses Geraet. Alles andere waere geraten.
    assert.equal(plan.b.ort, 'unbekannt');

    // Eine oeffentliche Adresse dagegen ist eindeutig, und zwar ohne DNS.
    const web = await compare.plan({ a: 'ollama/lokalmodell', b: 'web/webmodell' });
    assert.equal(web.b.ort, 'online');
    assert.equal(web.b.gate.klassifikation, 'public');
    assert.equal(web.b.gate.erlaubt, false, 'offline sperrt auch eine Adresse ohne Namen');

    assert.equal(plan.verlaesstGeraet, true);
    assert.equal(plan.zustimmungNoetig, true);
    assert.match(plan.hinweis, /Seite B geht an api\.openai\.com/);
    assert.match(plan.hinweis, /verlassen damit dieses Gerät/);

    // Der eigentliche Beweis: der Plan hat nichts versucht.
    assert.deepEqual(attempts, [], 'plan() darf keinen einzigen Egress-Versuch erzeugen');
    const statsAfter = gate.stats();
    assert.equal(statsAfter.allowed, statsBefore.allowed);
    assert.equal(statsAfter.blocked, statsBefore.blocked);
  }, { registry: fakeRegistry([LOCAL, NAMED, WEB], async () => ({ content: '', stats: {} })) });
});

test('plan: eine Freigabe für genau diesen Chat macht die Sperre sichtbar zu einer Erlaubnis', async () => {
  await withCompare('nos-cmp-grant', async ({ compare, store, gate }) => {
    const chat = store.create('chat', { title: 'Vergleich' });
    const gesperrt = await compare.plan({ chatId: chat.id, a: 'ollama/lokalmodell', b: 'fern/fernmodell' });
    assert.equal(gesperrt.b.gate.erlaubt, false);

    gate.addGrant({ scope: `chat:${chat.id}`, level: 'lan', hosts: ['203.0.113.5'], reason: 'Test' });

    const frei = await compare.plan({ chatId: chat.id, a: 'ollama/lokalmodell', b: 'fern/fernmodell' });
    assert.equal(frei.b.gate.erlaubt, true, 'die Freigabe dieses Chats gilt auch für den Vergleich');
    assert.equal(frei.b.ort, 'lan');
    assert.equal(frei.b.verlaesstGeraet, true, 'erlaubt heißt nicht harmlos');
    assert.match(frei.hinweis, /Seite B geht an 203\.0\.113\.5/);

    // Auch die Freigabe-Abfrage darf nichts versucht haben.
    const fremd = await compare.plan({ a: 'ollama/lokalmodell', b: 'fern/fernmodell' });
    assert.equal(fremd.b.gate.erlaubt, false, 'die Freigabe gilt nur für ihren Chat, nicht global');
  }, { registry: fakeRegistry([LOCAL, FERN], async () => ({ content: '', stats: {} })) });
});

test('plan: ein unbekannter Chat ist ein 404 und kein stiller Vergleich ohne Zusammenhang', async () => {
  await withCompare('nos-cmp-404', async ({ compare }) => {
    await assert.rejects(
      () => compare.plan({ chatId: 'chat_gibtesnichtxxxxxxxxxx', a: null, b: null }),
      (err) => err.code === 'NOT_FOUND',
    );
  });
});

/* ------------------------------------------------------------- one side down */

test('run: scheitert eine Seite, kommt die andere trotzdem – und die gescheiterte trägt ihren Fehler', async () => {
  const registry = fakeRegistry([LOCAL, FERN], async (target, options) => {
    if (target.providerId === 'fern') {
      throw new ModelError('Der ferne Anbieter hat mit 500 geantwortet.', { url: target.baseUrl });
    }
    options.onDelta('Die lokale ');
    options.onDelta('Antwort.');
    return { content: 'Die lokale Antwort.', stats: { promptTokens: 4, completionTokens: 5, ms: 9 } };
  });

  await withCompare('nos-cmp-halb', async ({ compare }) => {
    const result = await compare.run({ prompt: 'Warum?', a: 'ollama/lokalmodell', b: 'fern/fernmodell' });

    assert.equal(result.a.text, 'Die lokale Antwort.');
    assert.equal(result.a.fehler, null);
    assert.deepEqual(result.a.tokens, { prompt: 4, completion: 5 });

    assert.equal(result.b.text, '', 'eine gescheiterte Seite erfindet keinen Text');
    assert.ok(result.b.fehler, 'die gescheiterte Seite trägt ihren Fehler');
    assert.equal(result.b.fehler.code, 'MODEL_ERROR');
    assert.match(result.b.fehler.message, /500/);

    assert.notEqual(result.a.text, result.b.text, 'niemals dieselbe Antwort zweimal ausgeben');
    assert.equal(result.b.model.model, 'fernmodell', 'auch die gescheiterte Seite sagt, wen sie gefragt hat');
  }, { registry });
});

/* --------------------------------------------------------------- no model */

test('run: ohne jedes Modell wird nichts erfunden, sondern NoModelError mit der Anleitung', async () => {
  const { home, cleanup } = tempHome('nos-cmp-leer');
  try {
    const bus = new Bus();
    const store = await openStore({ paths: home, bus, logger: silentLogger });
    const config = configMod.defaults();
    const gate = createGate({ config, bus, store, logger: silentLogger });
    // Die echte Registry, absichtlich ungeprüft: nichts wurde gesucht, also
    // ist auch nichts da. Kein Netzverkehr, keine Attrappe.
    const registry = createRegistry({ config, gate, bus, logger: silentLogger });
    const compare = createCompare({ registry, gate, store, bus, config, logger: silentLogger });

    const plan = await compare.plan({ a: null, b: null });
    assert.equal(plan.a.modell, null);
    assert.equal(plan.b.modell, null);
    assert.equal(plan.a.erreichbar, false);
    assert.match(plan.hinweis, /auf keiner der beiden Seiten ein Modell verfügbar/);

    await assert.rejects(
      () => compare.run({ prompt: 'Was ist ein Zwiebelfisch?', a: null, b: null }),
      (err) => {
        assert.ok(err instanceof NoModelError, `erwartet NoModelError, bekam ${err && err.name}`);
        assert.equal(err.code, 'NO_MODEL_AVAILABLE');
        assert.match(err.message, /Für keine der beiden Seiten ist ein Modell verfügbar/);
        // Die Anleitung der Registry, wörtlich, nicht eine zweite eigene.
        // Seit dem Wegfall der Offline-KI: die Anleitung, Claude zu verbinden.
        assert.match(err.message, /console\.anthropic\.com/);
        assert.match(err.message, /erfindet Neural OS keine Antworten/);
        return true;
      },
    );

    await store.close().catch(() => {});
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------ observation */

test('run: usedNetwork kommt aus der Beobachtung, nicht aus der Konfiguration', async () => {
  const registry = fakeRegistry([LOCAL, FERN], null);
  await withCompare('nos-cmp-netz', async ({ compare, gate, attempts }) => {
    registry.chat = async function chat(ref, options) {
      const target = this.resolve(ref);
      return gatedStreamer(['Antwort von ', target.providerId], { gate })(target, options);
    };

    const result = await compare.run({ prompt: 'Wohin geht das?', a: 'ollama/lokalmodell', b: 'fern/fernmodell' });

    // Die Konfiguration sagt für BEIDE Seiten 'online'. Die Beobachtung nicht.
    assert.equal(result.a.usedNetwork, false, '127.0.0.1 ist dieses Gerät, kein Netzverkehr');
    assert.deepEqual(result.a.networkTargets, ['127.0.0.1:11434'], 'das Ziel wird trotzdem vermerkt');
    assert.equal(result.a.ort, 'lokal');
    assert.equal(result.a.netzBeobachtet, true);

    assert.equal(result.b.usedNetwork, true, 'die ferne Seite hat das Gerät wirklich verlassen');
    assert.deepEqual(result.b.networkTargets, ['203.0.113.5:443']);
    // 203.0.113.5 ist reserviert und wird von dieser Schleuse als lokales Netz
    // eingestuft -- nicht als Internet. Entscheidend ist: nicht loopback.
    assert.equal(result.b.ort, 'lan');

    // Und die Beobachtung stammt wirklich vom Tor: genau zwei erlaubte
    // Entscheidungen, je eine pro Seite, mit getrennten Geltungsbereichen.
    const erlaubt = attempts.filter((p) => p.allowed === true);
    assert.equal(erlaubt.length, 2);
    const scopes = erlaubt.map((p) => p.scope);
    assert.ok(scopes.some((s) => /vergleich:[^\s:]+:a$/.test(s)), `Seite A hat ihren eigenen Geltungsbereich: ${scopes}`);
    assert.ok(scopes.some((s) => /vergleich:[^\s:]+:b$/.test(s)), `Seite B hat ihren eigenen Geltungsbereich: ${scopes}`);
    assert.equal(new Set(scopes).size, 2, 'die beiden Seiten sind auseinanderzuhalten');
  }, {
    registry,
    mutateConfig: (config) => {
      config.network.mode = 'online';
      config.network.strictAllowlist = false;
    },
  });
});

test('run: ohne Bus wird keine Herkunft behauptet, sondern zugegeben', async () => {
  const { home, cleanup } = tempHome('nos-cmp-blind');
  try {
    const store = await openStore({ paths: home, logger: silentLogger });
    const config = configMod.defaults();
    const gate = createGate({ config, store, logger: silentLogger });
    const registry = fakeRegistry([LOCAL], async (target, options) => {
      options.onDelta('still');
      return { content: 'still', stats: {} };
    });
    const compare = createCompare({ registry, gate, store, config, logger: silentLogger });
    const result = await compare.run({ prompt: 'Und?', a: null, b: null });
    assert.equal(result.a.netzBeobachtet, false, 'ohne Bus ist nichts beobachtbar');
    assert.equal(result.a.usedNetwork, false);
    assert.deepEqual(result.a.networkTargets, []);
    await store.close().catch(() => {});
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ abort */

test('run: ein Abbruch beendet beide Seiten', async () => {
  const started = { a: false, b: false };
  const registry = fakeRegistry([LOCAL, FERN], async (target, options) => {
    started[target.providerId === 'ollama' ? 'a' : 'b'] = true;
    for (let i = 0; i < 200; i++) {
      if (options.signal && options.signal.aborted) throw new AbortedError('Die Modellanfrage wurde abgebrochen.');
      options.onDelta('.');
      await sleep(5);
    }
    return { content: '.'.repeat(200), stats: {} };
  });

  await withCompare('nos-cmp-stop', async ({ compare }) => {
    const controller = new AbortController();
    const running = compare.run({
      prompt: 'Zähl bis zweihundert.',
      a: 'ollama/lokalmodell',
      b: 'fern/fernmodell',
      signal: controller.signal,
    });
    await sleep(60);
    assert.ok(started.a && started.b, 'beide Seiten liefen wirklich los');
    controller.abort();

    const result = await running;
    for (const seite of ['a', 'b']) {
      assert.equal(result[seite].abgebrochen, true, `Seite ${seite} wurde abgebrochen`);
      assert.equal(result[seite].fehler.code, 'ABORTED', `Seite ${seite} trägt den Abbruch als Fehler`);
      assert.ok(result[seite].text.length > 0, `der bis dahin erzeugte Text der Seite ${seite} bleibt erhalten`);
    }
  }, { registry });
});

/* ------------------------------------------------------------------- save */

test('save: legt einen Vergleich nur auf Verlangen ab – mit beiden Antworten und beiden Namen', async () => {
  const registry = fakeRegistry([LOCAL, FERN], async (target, options) => {
    options.onDelta(`Antwort von ${target.providerId}`);
    return { content: `Antwort von ${target.providerId}`, stats: {} };
  });
  await withCompare('nos-cmp-save', async ({ compare, store }) => {
    const chat = store.create('chat', { title: 'Fragen' });
    const before = store.count('note');
    const result = await compare.run({ chatId: chat.id, prompt: 'Wer bist du?', a: 'ollama/lokalmodell', b: 'fern/fernmodell' });
    assert.equal(store.count('note'), before, 'ein Lauf allein schreibt nichts in den Tresor');

    const saved = compare.save({ chatId: chat.id, prompt: 'Wer bist du?', a: result.a, b: result.b });
    assert.equal(store.count('note'), before + 1);
    const body = saved.record.data.body;
    assert.match(body, /Antwort von ollama/);
    assert.match(body, /Antwort von fern/);
    assert.match(body, /lokalmodell/);
    assert.match(body, /fernmodell/);
    assert.match(body, /Diese Antwort hat das Gerät nicht verlassen/);
    assert.equal(saved.verknuepft, true, 'die Notiz hängt am Chat');
    const edges = store.edges.for(saved.record.id, { direction: 'out' });
    assert.ok(edges.some((e) => e.data.to === chat.id && e.data.kind === 'derived-from'));
  }, { registry });
});

/* -------------------------------------------------------------- HTTP routes */

/**
 * Die Route ist noch nicht in src/http/server.js eingetragen -- das macht die
 * Verdrahtung. Damit der Vertrag trotzdem geprüft wird, wird sie hier an ein
 * bereits geladenes Routenmodul angehängt, genau wie in test/assist.test.js.
 */
const SERVER_FILE = require.resolve('../src/http/server');
if (!/require\(['"]\.\/api\/compare['"]\)/.test(fs.readFileSync(SERVER_FILE, 'utf8'))) {
  const host = require('../src/http/api/history');
  const originalRegister = host.register;
  host.register = function registerWithCompare(router) {
    originalRegister.call(this, router);
    compareApi.register(router);
  };
}

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const textBody = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = textBody ? JSON.parse(textBody) : null; } catch { /* nicht jede Route antwortet JSON */ }
        resolve({ status: res.statusCode, text: textBody, json, type: res.headers['content-type'] || '' });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Sehr kleiner SSE-Leser: sammelt {event, data} bis der Server schließt. */
function sse(base, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        accept: 'text/event-stream',
        'x-neural-os': '1',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, events: [], text: Buffer.concat(chunks).toString('utf8') }));
        return;
      }
      let buffer = '';
      const events = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let name = null;
          const data = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!name && !data.length) continue;
          let parsed = data.join('\n');
          try { parsed = JSON.parse(parsed); } catch { /* Klartext ist erlaubtes SSE */ }
          events.push({ event: name, data: parsed });
        }
      });
      res.on('end', () => resolve({ status: 200, events }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('Die HTTP-Routen liefern den vereinbarten Vertrag', async () => {
  const { createServer } = require('../src/http/server');
  const { home, cleanup } = tempHome('nos-cmp-http');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';

  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const gate = createGate({ config, bus, store, logger: silentLogger });
  const registry = fakeRegistry([LOCAL, NAMED], async (target, options) => {
    if (target.providerId === 'openai') throw new ModelError('Der ferne Anbieter war nicht erreichbar.');
    options.onDelta('Hallo ');
    options.onDelta('Welt.');
    return { content: 'Hallo Welt.', stats: { promptTokens: 2, completionTokens: 3, ms: 1 } };
  });
  const compare = createCompare({ registry, gate, store, bus, config, logger: silentLogger });

  const server = await createServer({
    version: 'test', config, paths, store, bus, gate, registry, compare, logger: silentLogger, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    const chat = store.create('chat', { title: 'HTTP' });

    const planned = await request(base, 'POST', '/api/compare/plan', {
      chatId: chat.id, a: 'ollama/lokalmodell', b: 'openai/gpt-test',
    });
    assert.equal(planned.status, 200, planned.text);
    assert.equal(planned.json.plan.b.gate.erlaubt, false, 'offline heißt offline');
    assert.match(planned.json.plan.hinweis, /Seite B geht an api\.openai\.com/);

    const kaputt = await request(base, 'POST', '/api/compare', { chatId: chat.id, prompt: '   ' });
    assert.equal(kaputt.status, 400, 'ein leerer Text ist ein Statuscode, kein Ereignisstrom');

    const fehlenderChat = await request(base, 'POST', '/api/compare/plan', { chatId: 'chat_gibtesnichtxxxxxxxxxx' });
    assert.equal(fehlenderChat.status, 404, fehlenderChat.text);

    const run = await sse(base, '/api/compare', {
      chatId: chat.id, prompt: 'Sag Hallo.', a: 'ollama/lokalmodell', b: 'openai/gpt-test',
    });
    assert.equal(run.status, 200);
    const names = run.events.map((e) => e.event);
    assert.ok(names.includes('plan'), `plan fehlt: ${names}`);
    assert.equal(names[names.length - 1], 'done', `done muss zuletzt kommen: ${names}`);
    assert.equal(names.filter((n) => n === 'start').length, 2, 'für jede Seite ein start');
    assert.equal(names.filter((n) => n === 'side').length, 2, 'für jede Seite ein Ergebnis');

    const deltas = run.events.filter((e) => e.event === 'delta');
    assert.ok(deltas.length >= 2, 'die lokale Seite hat wirklich gestromt');
    assert.ok(deltas.every((d) => d.data.seite === 'a'), 'die ferne Seite hat nichts geliefert');

    const sides = Object.fromEntries(run.events.filter((e) => e.event === 'side').map((e) => [e.data.seite, e.data.ergebnis]));
    assert.equal(sides.a.text, 'Hallo Welt.');
    assert.equal(sides.a.fehler, null);
    assert.equal(sides.b.text, '');
    assert.ok(sides.b.fehler, 'die gescheiterte Seite trägt ihren Fehler bis in den Strom');

    const saved = await request(base, 'POST', '/api/compare/save', {
      chatId: chat.id, prompt: 'Sag Hallo.', a: sides.a, b: sides.b,
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(store.get(saved.json.record.id).type, 'note');
    assert.match(store.get(saved.json.record.id).data.body, /Hallo Welt\./);
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    cleanup();
  }
});

test('Ohne verdrahteten Vergleich antwortet die Route ehrlich mit 503', async () => {
  const { createServer } = require('../src/http/server');
  const { home, cleanup } = tempHome('nos-cmp-503');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const server = await createServer({ version: 'test', config, paths, store, bus, logger: silentLogger, failures: [] });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const res = await request(base, 'POST', '/api/compare/plan', { a: null, b: null });
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.error.code, 'SUBSYSTEM_UNAVAILABLE');
    assert.match(res.json.error.message, /Modellvergleich/);
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    cleanup();
  }
});

/* ------------------------------------------------------------- Anzeige */

/*
 * Die Anzeige des Vergleichs (zwei Spalten, Token-Zeile, Modellauswahl) stand
 * in web/views/chat.js. Der Chat ist neu gebaut: die KI ist Claude, und den
 * Vergleich zweier Modelle hat der Nutzer gestrichen -- also gibt es dort
 * weder `tokenSummary` noch `modelChoices`. Was die neue Ansicht an reinen
 * Funktionen hat, prueft test/chat-ansicht.test.js.
 */

module.exports = { name: 'compare', tests: drain() };
