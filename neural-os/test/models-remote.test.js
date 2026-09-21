'use strict';

/**
 * Tests for the online-model-provider surface, /api/models/remote/*.
 *
 * The subject here is a privacy boundary, not a CRUD list. So what is actually
 * asserted is:
 *
 * - an API key NEVER comes back out of the API, by any route;
 * - adding an online backend does NOT open the network gate by itself;
 * - opening it is a separate, explicit act that produces a real grant record;
 * - the gate's verdict for a host is reported without connecting to it, so
 *   merely looking at the list is not an outbound request -- and does not show
 *   up in the network audit log either.
 *
 * Everything runs against the REAL server and the REAL gate over a real
 * loopback socket. No network is reachable from these tests: every host used
 * here is a literal that the gate classifies as public and refuses in offline
 * mode, which is exactly the state under test.
 */

const assert = require('node:assert/strict');
const http = require('node:http');

const { test, tempHome } = require('./harness');

const { createServer } = require('../src/http/server');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');
const { openStore } = require('../src/store/engine');
const { createGate } = require('../src/net/gate');

const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

function request(base, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
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

/**
 * A registry double.
 *
 * The real registry would try to reach api.example.test, and a test that
 * depends on a DNS failure is a test that behaves differently on a machine
 * with a wildcard resolver. What matters for these routes is the shape of the
 * answer, so the probe result is supplied; the gate under test is real.
 */
function createRegistryDouble(config, { probeResult } = {}) {
  let lastTimeout = null;
  return {
    list: () => ({ providers: [], at: null }),
    async refresh({ timeoutMs } = {}) {
      lastTimeout = timeoutMs;
      const remote = (config.models && config.models.remote) || [];
      return {
        at: new Date().toISOString(),
        providers: remote.map((entry) => ({
          id: entry.id,
          kind: entry.kind || 'openai',
          baseUrl: entry.baseUrl,
          remote: true,
          hasApiKey: !!(entry.apiKey || (entry.apiKeyEnv && process.env[entry.apiKeyEnv])),
          available: false,
          models: [],
          latencyMs: 3,
          ...(probeResult || {}),
        })),
      };
    },
    installHint: () => 'Installiere Ollama.',
    get lastTimeout() { return lastTimeout; },
  };
}

async function withServer(fn, opts = {}) {
  const { home, cleanup } = tempHome('nos-models-remote');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  if (opts.mode) config.network.mode = opts.mode;

  const bus = new Bus();
  const audit = new Audit(paths.audit).open();
  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto: null });
  const gate = createGate({ config, audit, bus, store, logger: silentLogger });

  const ctx = {
    version: 'test',
    config,
    paths,
    store,
    bus,
    audit,
    gate,
    logger: silentLogger,
    registry: createRegistryDouble(config, opts),
    failures: [],
    // The composition root's saver, minus the live gate re-wiring that a real
    // app does -- these routes only ever touch config.models.remote.
    saveConfig(patch) {
      const next = configMod.deepMerge(config, patch);
      configMod.validateConfig(next);
      configMod.save(paths.config, next);
      Object.assign(config, next);
      return config;
    },
  };

  const server = await createServer(ctx);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    await fn({
      base, ctx, config, store, gate,
      req: (method, urlPath, body, headers) => request(base, method, urlPath, body, headers),
    });
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    audit.close();
    cleanup();
  }
}

const OPENAI_LIKE = {
  id: 'testanbieter',
  label: 'Testanbieter',
  baseUrl: 'https://api.example.test/v1',
};

/* --------------------------------------------------------------- reading */

test('models/remote: leere Liste nennt Vorlagen und den Netzmodus', async () => {
  await withServer(async ({ req }) => {
    const res = await req('GET', '/api/models/remote');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, []);
    assert.ok(res.json.presets.length >= 5, 'es gibt Vorlagen für bekannte Anbieter');
    assert.equal(res.json.mode, 'offline');
    assert.match(res.json.advice, /Umgebungsvariable/);
    // Every preset must carry what the UI needs to create an entry in one step.
    for (const preset of res.json.presets) {
      assert.ok(preset.id && preset.label && preset.baseUrl && preset.host, `unvollständige Vorlage: ${preset.id}`);
    }
  });
});

/* --------------------------------------------------------------- writing */

test('models/remote: anlegen speichert, öffnet aber die Schleuse NICHT', async () => {
  await withServer(async ({ req, config, gate }) => {
    const created = await req('POST', '/api/models/remote', { ...OPENAI_LIKE, apiKeyEnv: 'TEST_KEY_ENV' });
    assert.equal(created.status, 200);
    assert.equal(created.json.record.id, 'testanbieter');
    assert.equal(created.json.grant, null, 'ohne allowHost darf keine Freigabe entstehen');

    // Persisted in the configuration the registry reads.
    assert.equal(config.models.remote.length, 1);
    assert.equal(config.models.remote[0].baseUrl, 'https://api.example.test/v1');

    // And the gate still refuses the host: adding a backend is not consent.
    const verdict = gate.check({ host: 'api.example.test', scope: 'global', record: false });
    assert.equal(verdict.allowed, false, 'der Host darf im Offline-Modus weiterhin gesperrt sein');
    assert.equal(created.json.record.gate.allowed, false, 'die Antwort sagt das auch');
  });
});

test('models/remote: allowHost legt eine echte, nachlesbare Freigabe an', async () => {
  await withServer(async ({ req, gate }) => {
    const created = await req('POST', '/api/models/remote', { ...OPENAI_LIKE, allowHost: true });
    assert.equal(created.status, 200);
    assert.ok(created.json.grant, 'eine Freigabe wurde zurückgegeben');
    assert.equal(created.json.grant.data.level, 'online');
    assert.deepEqual(created.json.grant.data.hosts, ['api.example.test']);

    const grants = gate.listGrants();
    assert.equal(grants.length, 1, 'die Freigabe liegt als Satz im Tresor und ist widerrufbar');
    assert.match(grants[0].data.reason, /Testanbieter/);

    const verdict = gate.check({ host: 'api.example.test', scope: 'global', record: false });
    assert.equal(verdict.allowed, true, 'jetzt – und erst jetzt – ist der Host erlaubt');
  });
});

/* ------------------------------------------------------- key containment */

test('models/remote: ein Schlüssel kommt über keine Route wieder heraus', async () => {
  await withServer(async ({ req, config }) => {
    const secret = 'sk-geheim-1234567890';
    const created = await req('POST', '/api/models/remote', { ...OPENAI_LIKE, apiKey: secret });
    assert.equal(created.status, 200);
    assert.equal(created.json.record.hasApiKey, true);
    assert.equal(created.json.record.keySource, 'config');
    assert.match(created.json.keyWarning, /Klartext/, 'der Nutzer erfährt, wo der Schlüssel liegt');

    // Stored, so the provider can use it ...
    assert.equal(config.models.remote[0].apiKey, secret);

    // ... but never readable through the API, on any of these routes.
    for (const [method, path] of [['GET', '/api/models/remote'], ['GET', '/api/config'], ['GET', '/api/status']]) {
      const res = await req(method, path);
      assert.ok(!res.text.includes(secret), `${method} ${path} hat den Schlüssel ausgeliefert`);
    }
    const patched = await req('PATCH', '/api/models/remote/testanbieter', { label: 'Neu' });
    assert.ok(!patched.text.includes(secret), 'PATCH hat den Schlüssel ausgeliefert');
    const tested = await req('POST', '/api/models/remote/testanbieter/test');
    assert.ok(!tested.text.includes(secret), 'der Verbindungstest hat den Schlüssel ausgeliefert');
  });
});

test('models/remote: apiKeyEnv und apiKey schließen einander aus', async () => {
  await withServer(async ({ req, config }) => {
    const both = await req('POST', '/api/models/remote', { ...OPENAI_LIKE, apiKeyEnv: 'A_KEY', apiKey: 'sk-x' });
    assert.equal(both.status, 400);
    assert.match(both.json.error.message, /entweder/);

    await req('POST', '/api/models/remote', { ...OPENAI_LIKE, apiKey: 'sk-x' });
    // Switching to an environment variable must drop the stored key, not keep
    // a second, stale source of truth lying around in the file.
    const switched = await req('PATCH', '/api/models/remote/testanbieter', { apiKeyEnv: 'A_KEY' });
    assert.equal(switched.status, 200);
    assert.equal(config.models.remote[0].apiKey, undefined, 'der alte Schlüssel wurde entfernt');
    assert.equal(config.models.remote[0].apiKeyEnv, 'A_KEY');
  });
});

test('models/remote: ein fehlender Umgebungsschlüssel wird als solcher benannt', async () => {
  await withServer(async ({ req }) => {
    await req('POST', '/api/models/remote', { ...OPENAI_LIKE, apiKeyEnv: 'GARANTIERT_NICHT_GESETZT_XYZ' });
    const list = await req('GET', '/api/models/remote');
    assert.equal(list.json.items[0].hasApiKey, false);
    assert.equal(list.json.items[0].keySource, 'env-missing', 'nicht "none" – der Nutzer hat eine Variable genannt, sie ist nur leer');
  });
});

/* ------------------------------------------------------------ validation */

test('models/remote: unbrauchbare Eingaben werden mit einem Grund abgelehnt', async () => {
  await withServer(async ({ req }) => {
    const cases = [
      [{ id: 'a b', baseUrl: 'https://x.test/v1' }, /Buchstaben/],
      [{ id: 'ok', baseUrl: 'file:///etc/passwd' }, /http:\/\/ oder https:\/\//],
      [{ id: 'ok', baseUrl: 'https://user:pw@x.test/v1' }, /Zugangsdaten/],
      [{ id: 'ok', baseUrl: 'https://x.test/v1', kind: 'telepathie' }, /Anbietertyp/],
      [{ id: 'ok', baseUrl: 'https://x.test/v1', apiKeyEnv: 'klein geschrieben' }, /Umgebungsvariable/],
      [{ id: 'ollama', baseUrl: 'https://x.test/v1' }, /lokalen Backends/],
    ];
    for (const [body, pattern] of cases) {
      const res = await req('POST', '/api/models/remote', body);
      assert.equal(res.status, 400, `sollte abgelehnt werden: ${JSON.stringify(body)}`);
      assert.match(res.json.error.message, pattern);
    }
  });
});

test('models/remote: doppelte Kennung wird abgelehnt, nicht still überschrieben', async () => {
  await withServer(async ({ req, config }) => {
    await req('POST', '/api/models/remote', OPENAI_LIKE);
    const again = await req('POST', '/api/models/remote', { ...OPENAI_LIKE, baseUrl: 'https://anders.test/v1' });
    assert.equal(again.status, 400);
    assert.equal(config.models.remote.length, 1);
    assert.equal(config.models.remote[0].baseUrl, 'https://api.example.test/v1', 'der erste Eintrag blieb unverändert');
  });
});

test('models/remote: unbekannte Kennung ist 404, nicht 500', async () => {
  await withServer(async ({ req }) => {
    for (const [method, path] of [
      ['PATCH', '/api/models/remote/gibtsnicht'],
      ['DELETE', '/api/models/remote/gibtsnicht'],
      ['POST', '/api/models/remote/gibtsnicht/test'],
    ]) {
      const res = await req(method, path, method === 'PATCH' ? { label: 'x' } : undefined);
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });
});

/* -------------------------------------------------------------- deleting */

test('models/remote: löschen entfernt den Anbieter und verschweigt die Freigabe nicht', async () => {
  await withServer(async ({ req, config, gate }) => {
    await req('POST', '/api/models/remote', { ...OPENAI_LIKE, allowHost: true });
    const removed = await req('DELETE', '/api/models/remote/testanbieter');
    assert.equal(removed.status, 200);
    assert.equal(config.models.remote.length, 0);
    assert.match(removed.json.note, /Freigabe/, 'der Nutzer erfährt, dass die Netz-Freigabe bestehen bleibt');
    assert.equal(gate.listGrants().length, 1, 'und sie besteht wirklich noch');
  });
});

/* ------------------------------------------------------------ connecting */

test('models/remote: der Test unterscheidet "gesperrt" von "nicht erreichbar"', async () => {
  await withServer(async ({ req }) => {
    await req('POST', '/api/models/remote', OPENAI_LIKE);
    const res = await req('POST', '/api/models/remote/testanbieter/test');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.blocked, true, 'die Schleuse hat abgelehnt – das ist keine Störung');
    assert.match(res.json.hint, /Netzwerk/, 'und der Hinweis sagt, wo man das ändert');
    // The code is what decides, not the wording: the gate's German sentence
    // says neither "blockiert" nor "Schleuse", which is how the first version
    // of this check got it wrong.
  }, { probeResult: { available: false, code: 'NETWORK_BLOCKED', error: "Netzmodus ist 'offline'. Für api.example.test wird Modus 'online' benötigt." } });
});

test('models/remote: ein geglückter Test meldet echte Modellnamen', async () => {
  await withServer(async ({ req }) => {
    await req('POST', '/api/models/remote', { ...OPENAI_LIKE, allowHost: true });
    const res = await req('POST', '/api/models/remote/testanbieter/test');
    assert.equal(res.json.ok, true);
    assert.equal(res.json.blocked, false);
    assert.deepEqual(res.json.models, ['modell-gross', 'modell-klein']);
    assert.equal(res.json.hint, null, 'wenn es funktioniert, gibt es nichts zu erklären');
  }, {
    probeResult: {
      available: true,
      error: null,
      models: [{ id: 'modell-gross' }, { id: 'modell-klein' }],
    },
  });
});

test('models/remote: das Auflisten löst keinen Netzversuch aus', async () => {
  await withServer(async ({ req, gate }) => {
    await req('POST', '/api/models/remote', OPENAI_LIKE);
    const before = gate.stats().attempts;
    await req('GET', '/api/models/remote');
    await req('GET', '/api/models/remote');
    assert.equal(gate.stats().attempts, before, 'ein Blick auf die Liste ist kein Zugriffsversuch');
  });
});
