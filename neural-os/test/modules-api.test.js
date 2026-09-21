'use strict';

/**
 * Tests for the extension system's HTTP surface.
 *
 * Everything here talks to a REAL server (`src/http/server.js`) on an
 * ephemeral loopback port over real sockets, against a real store in a
 * throwaway home. Nothing touches the internet or the real home directory.
 *
 * Two deliberate seams:
 *
 * 1. `src/http/server.js` builds its router from a fixed list of route files
 *    and this agent may not edit that file, so until the integrator adds
 *    `require('./api/modules')` to it, the registration is injected here
 *    through the last route module the server loads. The server itself --
 *    security headers, host and CSRF checks, auth, body limits, error
 *    serialisation, the router -- is the real one, unpatched.
 *
 * 2. `src/modules/registry.js` is built by another agent and may not exist
 *    yet, so these tests run against a contract-faithful double. It keeps its
 *    records in the REAL store with the real `module` schema and really does
 *    versioning and rollback; what it does not do is execute the source. That
 *    is deliberate: the subject here is the HTTP layer, and the sandbox has
 *    its own tests. The end-to-end pairing belongs in test/integration.test.js.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');

const { test, tempHome } = require('./harness');

const { createServer } = require('../src/http/server');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');
const { openStore } = require('../src/store/engine');
const { ValidationError, NotFoundError } = require('../src/kernel/errors');

const modulesApi = require('../src/http/api/modules');

/** Tests must not write diagnostics over the runner's output. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

/* ------------------------------------------------- route registration seam */

/**
 * Make the real server serve /api/modules even before the integrator has
 * added the route file to its loader list: the route file the server loads
 * last gets a wrapper that also registers ours.
 *
 * Once `src/http/server.js` requires `./api/modules` itself -- which this
 * checks for rather than assumes -- the seam disappears and the tests run
 * against the unmodified server. That is why the check reads the file instead
 * of inspecting the router: by the time a `register` call could look, the
 * server's own registration has not happened yet.
 */
const SERVER_FILE = require.resolve('../src/http/server');
const SERVER_REGISTERS_MODULES = /require\(['"]\.\/api\/modules['"]\)/
  .test(require('node:fs').readFileSync(SERVER_FILE, 'utf8'));

if (!SERVER_REGISTERS_MODULES) {
  const lastLoadedApi = require('../src/http/api/sync');
  const originalRegister = lastLoadedApi.register;
  lastLoadedApi.register = function registerWithModules(router) {
    originalRegister.call(this, router);
    modulesApi.register(router);
  };
}

/* ------------------------------------------------------------- utilities */

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

/* ----------------------------------------------------- the registry double */

const UI_SOURCE = `export const manifest = {
  name: 'Wortzähler',
  description: 'Zeigt, wie viele Wörter du geschrieben hast.',
  kind: 'ui',
  capabilities: ['ui.view', 'ui.api'],
};

export default {
  id: 'wortzaehler',
  title: 'Wortzähler',
  async mount(container) { container.textContent = 'Hallo'; },
  async unmount() {},
};
`;

const SERVER_SOURCE = `module.exports = {
  manifest: {
    name: 'Notizen-Statistik',
    description: 'Zählt Notizen pro Schlagwort.',
    kind: 'server',
    capabilities: ['records.read'],
  },
  setup(api) { api.log('bereit'); },
};
`;

/** Pull the manifest literal out of a source without running it. */
function readManifest(source) {
  const match = /manifest\s*[:=]\s*(\{[\s\S]*?\n\s*\})/.exec(source);
  if (!match) return null;
  try {
    return vm.runInNewContext(`(${match[1]})`, Object.create(null), { timeout: 200 });
  } catch {
    return null;
  }
}

/**
 * A module registry that behaves as docs/MODULE-CONTRACT.md describes, over
 * the real store. It compiles the source (real syntax errors, real line
 * numbers) and reads the manifest, but never runs `setup()`.
 */
function createFakeRegistry(store) {
  const capabilitiesMod = require('../src/modules/capabilities');

  async function validate(source, opts = {}) {
    const problems = [];
    const warnings = [];
    let manifest = null;

    const text = typeof source === 'string' ? source : '';
    try {
      // ES-module syntax does not compile as a script; the real sandbox knows
      // the difference. Here a UI module only has to be plausible.
      if (!/^\s*export\s/m.test(text)) new vm.Script(text, { filename: 'modul.js' });
    } catch (err) {
      const line = err && err.stack ? Number((/modul\.js:(\d+)/.exec(err.stack) || [])[1]) : null;
      problems.push({ message: `Syntaxfehler: ${err.message}`, line: Number.isFinite(line) ? line : null });
    }

    if (!problems.length) {
      manifest = readManifest(text);
      if (!manifest) problems.push({ message: 'Es wurde kein manifest gefunden.', line: null });
    }

    const kind = (manifest && manifest.kind) || opts.kind || 'server';
    let caps = [];
    if (manifest) {
      try {
        caps = capabilitiesMod.validate(manifest.capabilities, kind);
      } catch (err) {
        problems.push({ message: err.message, line: null });
      }
      if (!manifest.name) problems.push({ message: 'Dem Manifest fehlt ein Name.', line: null });
    }

    return {
      ok: problems.length === 0,
      manifest,
      kind,
      capabilities: caps,
      risk: capabilitiesMod.riskOf(caps),
      description: capabilitiesMod.describe(caps, kind),
      problems,
      warnings,
    };
  }

  function get(id) {
    const record = store.get(id);
    return record && record.type === 'module' ? record : null;
  }

  function mustGet(id) {
    const record = get(id);
    if (!record) throw new NotFoundError(`module ${id}`);
    return record;
  }

  return {
    validate,
    list: () => store.list('module', { limit: 500 }).items,
    get,
    status: () => ({ loaded: 0, failed: 0, disabled: store.list('module', { limit: 500 }).items.length, safeMode: false }),

    async install({ source, note }) {
      const validation = await validate(source, {});
      if (!validation.ok) throw new ValidationError('Das Modul ist nicht gültig.');
      const record = store.create('module', {
        name: validation.manifest.name,
        description: validation.manifest.description || '',
        kind: validation.kind,
        source,
        version: 1,
        versions: [],
        capabilities: validation.capabilities,
        enabled: false,
      });
      return { record, validation, note: note || '' };
    },

    async update(id, { source, note }) {
      const before = mustGet(id);
      const versions = (before.data.versions || []).concat([{
        version: before.data.version,
        source: before.data.source,
        at: new Date().toISOString(),
        note: note || '',
      }]);
      const record = store.update(id, {
        source,
        version: before.data.version + 1,
        versions,
        enabled: false,
      });
      return { record };
    },

    async rollback(id, version) {
      const before = mustGet(id);
      const wanted = (before.data.versions || []).find((entry) => entry.version === version);
      if (!wanted) throw new ValidationError(`Fassung ${version} gibt es nicht.`);
      const versions = (before.data.versions || []).concat([{
        version: before.data.version,
        source: before.data.source,
        at: new Date().toISOString(),
        note: 'vor dem Zurückgehen',
      }]);
      const record = store.update(id, {
        source: wanted.source,
        version: before.data.version + 1,
        versions,
        enabled: false,
      });
      return { record, restoredFrom: version };
    },

    async enable(id) {
      const before = mustGet(id);
      store.update(id, { enabled: true, lastError: null });
      return { registered: { views: before.data.kind === 'ui' ? 1 : 0 } };
    },

    async disable(id) {
      mustGet(id);
      store.update(id, { enabled: false });
      return true;
    },

    async remove(id) {
      mustGet(id);
      store.update(id, { enabled: false });
      return store.remove(id);
    },
  };
}

/* ---------------------------------------------------------------- fixture */

/**
 * Boot a real server on an ephemeral port. `opts.modules` replaces the
 * registry (pass `null` to prove a missing subsystem answers 503);
 * `opts.identity` installs a fake auth with exactly those permissions.
 */
async function withServer(fn, opts = {}) {
  const { home, cleanup } = tempHome('nos-modules-api');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  config.server.port = 7777;

  const bus = new Bus();
  const audit = new Audit(paths.audit).open();
  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto: null });

  const registry = opts.modules === undefined ? createFakeRegistry(store) : opts.modules;

  const ctx = {
    version: 'test',
    config,
    paths,
    store,
    bus,
    audit,
    logger: silentLogger,
    modules: registry,
    failures: [],
  };
  if (opts.identity) {
    ctx.auth = {
      async middleware() { return { ok: true, identity: opts.identity }; },
    };
  }

  const server = await createServer(ctx);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    await fn({
      base,
      ctx,
      store,
      registry,
      req: (method, urlPath, body, headers) => request(base, method, urlPath, body, headers),
    });
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    audit.close();
    cleanup();
  }
}

/** A token identity that may read and write but was never granted modules. */
const GUEST_WITHOUT_MODULES = {
  kind: 'token',
  tokenId: 'tok_test',
  permissions: { read: true, write: true, chat: false, agents: false },
};

/* ------------------------------------------------------------------ tests */

test('Ein gültiges Modul wird installiert – und zwar ausgeschaltet', async () => {
  await withServer(async ({ req }) => {
    const res = await req('POST', '/api/modules', { source: UI_SOURCE, note: 'erste Fassung' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.installed, true);

    const record = res.json.record;
    assert.equal(record.type, 'module');
    assert.equal(record.data.name, 'Wortzähler');
    assert.equal(record.data.kind, 'ui');
    assert.equal(record.data.version, 1);
    // Einfügen und Ausführen sind zwei getrennte Handlungen.
    assert.equal(record.data.enabled, false, 'ein frisch installiertes Modul darf nicht laufen');
    assert.deepEqual(record.data.capabilities, ['ui.view', 'ui.api']);

    assert.equal(res.json.description.risk, 'medium');
    assert.match(res.json.description.text, /Darf:/);

    const listed = await req('GET', '/api/modules');
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.total, 1);
    assert.equal(listed.json.items[0].id, record.id);
    assert.ok(listed.json.status, 'die Liste nennt den Zustand der Modulverwaltung');
    assert.equal(listed.json.descriptions[record.id].risk, 'medium');
  });
});

test('Unsinn wird nicht installiert, sondern als Prüfbericht mit Problemen beantwortet', async () => {
  await withServer(async ({ req, store }) => {
    const res = await req('POST', '/api/modules', { source: 'function kaputt( {\n  return 1;\n' });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.error.code, 'MODULE_INVALID');
    assert.match(res.json.error.message, /NICHT installiert/);

    const validation = res.json.error.details.validation;
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.length >= 1, 'der Bericht muss das Problem benennen');
    assert.match(validation.problems[0].message, /Syntaxfehler/);

    // Und wirklich nichts angelegt.
    assert.equal(store.list('module', { limit: 10 }).items.length, 0);
  });
});

test('POST /api/modules/validate installiert nichts, auch nicht bei gültigem Code', async () => {
  await withServer(async ({ req, store }) => {
    const res = await req('POST', '/api/modules/validate', { source: SERVER_SOURCE });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.installed, false);
    assert.equal(res.json.validation.manifest.name, 'Notizen-Statistik');
    assert.deepEqual(res.json.validation.capabilities, ['records.read']);
    assert.equal(store.list('module', { limit: 10 }).items.length, 0, 'Prüfen darf nichts anlegen');

    const bad = await req('POST', '/api/modules/validate', { source: 'const x = ;' });
    assert.equal(bad.status, 200, 'ein Problem im Code ist eine Antwort, kein Serverfehler');
    assert.equal(bad.json.ok, false);
    assert.ok(bad.json.validation.problems.length >= 1);
  });
});

test('Aktivieren, Deaktivieren und die Bestätigung der Berechtigungen', async () => {
  await withServer(async ({ req }) => {
    const installed = await req('POST', '/api/modules', { source: UI_SOURCE });
    const id = installed.json.record.id;

    // Eine Bestätigung, die nicht zu dem passt, was das Modul verlangt, wird
    // abgelehnt: sonst genehmigt man etwas, das man nie gesehen hat.
    const wrong = await req('POST', `/api/modules/${id}/enable`, { capabilities: ['ui.view'] });
    assert.equal(wrong.status, 400, wrong.text);
    assert.match(wrong.json.error.message, /Nicht bestätigt: ui\.api/);

    const enabled = await req('POST', `/api/modules/${id}/enable`, { capabilities: ['ui.view', 'ui.api'] });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.json.enabled, true);
    assert.equal(enabled.json.record.data.enabled, true);

    const disabled = await req('POST', `/api/modules/${id}/disable`);
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal(disabled.json.enabled, false);
    assert.equal(disabled.json.record.data.enabled, false);
  });
});

test('Neuer Quelltext schaltet ab, der Verlauf bleibt, und Rollback holt die alte Fassung zurück', async () => {
  await withServer(async ({ req }) => {
    const installed = await req('POST', '/api/modules', { source: UI_SOURCE });
    const id = installed.json.record.id;
    await req('POST', `/api/modules/${id}/enable`, { capabilities: ['ui.view', 'ui.api'] });

    const broken = UI_SOURCE.replace("container.textContent = 'Hallo';", 'kaputt(;');
    const patched = await req('PATCH', `/api/modules/${id}`, { source: broken, note: 'zweiter Versuch' });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.record.data.version, 2);
    assert.equal(patched.json.record.data.enabled, false, 'neuer Code läuft nicht ungefragt weiter');
    assert.ok(patched.json.notes.some((n) => /Verlauf/.test(n)));

    // Die Liste trägt die alten Fassungen nur als Metadaten, nicht als Quelltext.
    const listed = await req('GET', '/api/modules');
    const summary = listed.json.items.find((item) => item.id === id);
    assert.equal(summary.data.versions.length, 1);
    assert.equal(summary.data.versions[0].version, 1);
    assert.equal(summary.data.versions[0].source, undefined, 'die Liste darf nicht den ganzen Verlauf mitschleppen');
    assert.ok(summary.data.versions[0].bytes > 0);

    // Der Einzelabruf liefert den vollen Verlauf, den die Werkstatt braucht.
    const single = await req('GET', `/api/modules/${id}`);
    assert.equal(single.status, 200, single.text);
    assert.equal(single.json.record.data.versions[0].source, UI_SOURCE);

    const nonsense = await req('POST', `/api/modules/${id}/rollback`, { version: 99 });
    assert.equal(nonsense.status, 400);
    assert.match(nonsense.json.error.message, /Vorhanden sind: 1/);

    const back = await req('POST', `/api/modules/${id}/rollback`, { version: 1 });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.restoredFrom, 1);
    assert.equal(back.json.record.data.source, UI_SOURCE, 'die alte Fassung ist wieder aktiv');
    // Auch der Rückschritt ist umkehrbar: die kaputte Fassung liegt im Verlauf.
    assert.ok(back.json.record.data.versions.some((v) => v.source === broken));
  });
});

test('source.js liefert den Quelltext eines Oberflächen-Moduls als JavaScript', async () => {
  await withServer(async ({ req }) => {
    const installed = await req('POST', '/api/modules', { source: UI_SOURCE });
    const id = installed.json.record.id;

    const res = await req('GET', `/api/modules/${id}/source.js?v=1`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-neural-os-module-version'], '1');
    assert.equal(res.text, UI_SOURCE, 'der Quelltext muss unverändert ankommen');
    // Gleicher Ursprung: genau das macht den import() CSP-konform.
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});

test('source.js verweigert ein Server-Modul, weil es im Browser nichts zu suchen hat', async () => {
  await withServer(async ({ req }) => {
    const installed = await req('POST', '/api/modules', { source: SERVER_SOURCE });
    const id = installed.json.record.id;
    assert.equal(installed.json.record.data.kind, 'server');

    const res = await req('GET', `/api/modules/${id}/source.js`);
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.error.code, 'MODULE_KIND_MISMATCH');
    assert.match(res.json.error.message, /Server-Modul/);

    // Über den normalen Weg ist der Quelltext für die Werkstatt weiterhin da.
    const single = await req('GET', `/api/modules/${id}`);
    assert.equal(single.json.record.data.source, SERVER_SOURCE);
  });
});

test('Ohne die Berechtigung "modules" darf ein geteilter Zugang lesen, aber nichts einschalten', async () => {
  await withServer(async ({ req }) => {
    // Vorbereitung durch dieselbe Identität ist unmöglich, also direkt prüfen.
    const install = await req('POST', '/api/modules', { source: UI_SOURCE });
    assert.equal(install.status, 403, install.text);
    assert.equal(install.json.error.code, 'PERMISSION_DENIED');
    assert.match(install.json.error.message, /Berechtigung "Module"/);

    const validate = await req('POST', '/api/modules/validate', { source: UI_SOURCE });
    assert.equal(validate.status, 403, 'auch das Prüfen führt den Code aus');

    // Lesen bleibt erlaubt.
    const listed = await req('GET', '/api/modules');
    assert.equal(listed.status, 200, listed.text);
    const catalogue = await req('GET', '/api/modules/capabilities');
    assert.equal(catalogue.status, 200);
  }, { identity: GUEST_WITHOUT_MODULES });
});

test('Ausschalten bleibt erlaubt, wenn Einschalten es nicht ist', async () => {
  let moduleId = null;
  await withServer(async ({ req, store, registry }) => {
    // Als Besitzer anlegen und einschalten ist hier nicht möglich (die Identität
    // gilt für den ganzen Server), also über die Registry selbst vorbereiten.
    const { record } = await registry.install({ source: UI_SOURCE });
    await registry.enable(record.id);
    moduleId = record.id;
    assert.equal(store.get(moduleId).data.enabled, true);

    const off = await req('POST', `/api/modules/${moduleId}/disable`);
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.enabled, false);

    const on = await req('POST', `/api/modules/${moduleId}/enable`);
    assert.equal(on.status, 403, 'der gefährliche Weg bleibt gesperrt');
  }, { identity: GUEST_WITHOUT_MODULES });
  assert.ok(moduleId);
});

test('Ohne Modulverwaltung antworten die Routen mit 503 statt abzustürzen', async () => {
  await withServer(async ({ req }) => {
    for (const [method, url, body] of [
      ['GET', '/api/modules', undefined],
      ['GET', '/api/modules/mod_123', undefined],
      ['GET', '/api/modules/mod_123/source.js', undefined],
      ['POST', '/api/modules', { source: UI_SOURCE }],
      ['POST', '/api/modules/validate', { source: UI_SOURCE }],
      ['POST', '/api/modules/mod_123/enable', {}],
      ['POST', '/api/modules/mod_123/disable', {}],
      ['POST', '/api/modules/mod_123/rollback', { version: 1 }],
      ['DELETE', '/api/modules/mod_123', undefined],
      ['PATCH', '/api/modules/mod_123', { name: 'x' }],
    ]) {
      const res = await req(method, url, body);
      assert.equal(res.status, 503, `${method} ${url} -> ${res.status} ${res.text}`);
      assert.equal(res.json.error.code, 'SUBSYSTEM_UNAVAILABLE');
      assert.match(res.json.error.message, /Modulverwaltung/);
    }

    // Der Katalog erklärt die Berechtigungen auch dann noch.
    const catalogue = await req('GET', '/api/modules/capabilities');
    assert.equal(catalogue.status, 200, catalogue.text);
    assert.ok(catalogue.json.items.length > 0);
  }, { modules: null });
});

test('Der Berechtigungskatalog nennt jede Berechtigung mit Klartext und Risiko', async () => {
  await withServer(async ({ req }) => {
    const res = await req('GET', '/api/modules/capabilities');
    assert.equal(res.status, 200, res.text);
    assert.ok(res.json.items.some((c) => c.id === 'records.write' && c.risk === 'high'));
    assert.ok(res.json.byKind.ui.includes('ui.view'));
    assert.ok(!res.json.byKind.ui.includes('files.write'));
    for (const entry of res.json.items) {
      assert.equal(typeof entry.label, 'string');
      assert.ok(entry.hint.length > 10, `${entry.id} braucht eine Erklärung in Klartext`);
    }
  });
});

test('Unbekannte Module und kaputte Eingaben werden benannt, nicht verschluckt', async () => {
  await withServer(async ({ req }) => {
    const missing = await req('GET', '/api/modules/mod_gibtsnicht');
    assert.equal(missing.status, 404, missing.text);
    assert.equal(missing.json.error.code, 'NOT_FOUND');
    assert.match(missing.json.error.message, /kein Modul/);

    const noSource = await req('POST', '/api/modules', {});
    assert.equal(noSource.status, 400);
    assert.match(noSource.json.error.message, /"source"/);

    const badKind = await req('POST', '/api/modules/validate', { source: UI_SOURCE, kind: 'irgendwas' });
    assert.equal(badKind.status, 400);
    assert.match(badKind.json.error.message, /Modul-Art/);

    const installed = await req('POST', '/api/modules', { source: UI_SOURCE });
    const id = installed.json.record.id;

    const nothing = await req('PATCH', `/api/modules/${id}`, {});
    assert.equal(nothing.status, 400);
    assert.match(nothing.json.error.message, /nichts zum Ändern/);

    const relativeRoot = await req('PATCH', `/api/modules/${id}`, { fileRoots: ['dokumente'] });
    assert.equal(relativeRoot.status, 400);
    assert.match(relativeRoot.json.error.message, /vollständiger Pfad/);

    const noVersion = await req('POST', `/api/modules/${id}/rollback`, {});
    assert.equal(noVersion.status, 400);
    assert.match(noVersion.json.error.message, /"version" fehlt/);
  });
});

test('Geänderte Ordner schalten ein laufendes Modul ab, statt es heimlich weiterlaufen zu lassen', async () => {
  await withServer(async ({ req }) => {
    const installed = await req('POST', '/api/modules', { source: SERVER_SOURCE });
    const id = installed.json.record.id;
    await req('POST', `/api/modules/${id}/enable`);

    const res = await req('PATCH', `/api/modules/${id}`, {
      name: 'Statistik',
      fileRoots: ['/tmp/neural-os-test-ordner'],
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.disabledForChange, true);
    assert.equal(res.json.record.data.enabled, false);
    assert.equal(res.json.record.data.name, 'Statistik');
    assert.deepEqual(res.json.record.data.fileRoots, ['/tmp/neural-os-test-ordner']);
    assert.ok(res.json.notes.some((n) => /Ordner/.test(n)));
  });
});

test('Entfernen löscht weich und meldet es ehrlich', async () => {
  await withServer(async ({ req, store }) => {
    const installed = await req('POST', '/api/modules', { source: UI_SOURCE });
    const id = installed.json.record.id;

    const res = await req('DELETE', `/api/modules/${id}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.removed, true);

    assert.equal(store.get(id), null);
    assert.ok(store.get(id, { includeDeleted: true }), 'weich gelöscht: der Eintrag ist noch da');

    const after = await req('GET', `/api/modules/${id}`);
    assert.equal(after.status, 404);
  });
});

test('Ein Fehler aus der Registry kommt unverändert beim Nutzer an', async () => {
  const angry = {
    list: () => [],
    get: () => ({ id: 'mod_1', type: 'module', data: { name: 'Zickig', kind: 'server', source: 'x', capabilities: [], enabled: false, versions: [] } }),
    status: () => ({ loaded: 0, failed: 1, disabled: 0, safeMode: false }),
    async enable() {
      throw new ValidationError('Das Modul hat beim Laden geworfen: kaputt is not defined (Zeile 4).');
    },
  };
  await withServer(async ({ req }) => {
    const res = await req('POST', '/api/modules/mod_1/enable', {});
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    assert.match(res.json.error.message, /Zeile 4/, 'die deutsche Meldung der Registry ist der eigentliche Wert');
  }, { modules: angry });
});
