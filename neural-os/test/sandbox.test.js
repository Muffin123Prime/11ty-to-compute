'use strict';

/**
 * Tests for the module sandbox.
 *
 * Every test here answers one question: what happens when the user pastes code
 * that is wrong? Nothing touches the real home directory, nothing reaches the
 * network -- the one network test relies on the gate refusing BEFORE it would
 * resolve a name, which is also what makes it safe to run offline.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const { layout, ensureLayout } = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const { createGate } = require('../src/net/gate');
const sandboxMod = require('../src/modules/sandbox');
const { createSandbox, rewriteEsm, sniffKind } = sandboxMod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A throwaway Neural OS just big enough to run a module against. */
async function env(label) {
  const tmp = tempHome(label);
  const paths = ensureLayout(layout(tmp.home));
  const config = configMod.defaults();
  const bus = new Bus();
  const audit = new Audit(paths.audit, { enabled: false });
  const store = await openStore({ paths, bus });
  const gate = createGate({ config, audit, bus, store });
  const sandbox = createSandbox({ store, gate, bus, config, paths, audit });
  return {
    home: tmp.home,
    paths,
    config,
    bus,
    store,
    gate,
    sandbox,
    /** Create the `module` record a real install would have produced. */
    install(data) {
      return store.create('module', {
        name: 'Testmodul',
        kind: 'server',
        source: '',
        version: 1,
        capabilities: [],
        enabled: false,
        ...data,
      });
    },
    async cleanup() {
      try { sandbox.disposeAll(); } catch { /* ignore */ }
      await store.close();
      tmp.cleanup();
    },
  };
}

/* ------------------------------------------------------- source handling */

test('a syntax error carries the line the user sees in the editor', async () => {
  const e = await env('sbx-syntax');
  try {
    const source = [
      'module.exports = {',
      '  manifest: { name: "Kaputt", kind: "server", capabilities: [] },',
      '  setup(api) { const x = ; },',
      '};',
    ].join('\n');
    await assert.rejects(() => e.sandbox.evaluate(source, { kind: 'server' }), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.equal(err.details.line, 3, `expected line 3, got ${err.details.line}`);
      assert.equal(err.details.syntax, true);
      return true;
    });
  } finally {
    await e.cleanup();
  }
});

test('the manifest is read without setup() ever being called', async () => {
  const e = await env('sbx-manifest');
  try {
    const source = [
      'let called = false;',
      'module.exports = {',
      '  manifest: { name: "Zähler", description: "zählt", kind: "server", capabilities: ["records.read"] },',
      '  setup(api) { called = true; },',
      '};',
      'module.exports.wasCalled = () => called;',
    ].join('\n');
    const result = await e.sandbox.evaluate(source, { kind: 'server' });
    assert.equal(result.manifest.name, 'Zähler');
    assert.deepEqual(result.manifest.capabilities, ['records.read']);
    assert.equal(result.exports.wasCalled(), false, 'setup() must not run during a check');
  } finally {
    await e.cleanup();
  }
});

test('missing manifest is data, not a crash', async () => {
  const e = await env('sbx-nomanifest');
  try {
    const result = await e.sandbox.evaluate('module.exports = { setup(api) {} };', { kind: 'server' });
    assert.equal(result.manifest, null);
  } finally {
    await e.cleanup();
  }
});

test('the ESM rewrite keeps line numbers and exports what it claims', () => {
  const source = [
    'export const manifest = { name: "Sicht", kind: "ui", capabilities: ["ui.view"] };',
    'function helfer() { return 1; }',
    'export default { id: "sicht", title: "Sicht", mount() {} };',
  ].join('\n');
  const out = rewriteEsm(source);
  assert.equal(out.problems.length, 0);
  // Everything before the appended tail must stay on its original line.
  const rewritten = out.source.split('\n');
  assert.ok(rewritten[1].includes('function helfer'), 'line 2 must not move');
  assert.equal(sniffKind(source), 'ui');
});

test('an import in a module is refused with an explanation, not a stack trace', () => {
  const out = rewriteEsm('import { x } from "./y.js";\nexport const manifest = {};');
  assert.equal(out.problems.length, 1);
  assert.equal(out.problems[0].line, 1);
  assert.match(out.problems[0].message, /importieren/);
});

/* ------------------------------------------------------------ the limits */

test('an endless loop hits the time limit instead of freezing the app', async () => {
  const e = await env('sbx-loop');
  try {
    const started = Date.now();
    await assert.rejects(
      () => e.sandbox.evaluate('while (true) {}', { kind: 'server', timeoutMs: 150 }),
      (err) => {
        assert.equal(err.code, 'MODULE_TIMEOUT');
        assert.match(err.message, /Zeitlimit/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 3000, 'the timeout must actually fire');
  } finally {
    await e.cleanup();
  }
});

test('an endless loop inside setup() is cut off too', async () => {
  const e = await env('sbx-loop2');
  try {
    const record = e.install({
      name: 'Hänger',
      source: 'module.exports = { manifest: { name: "Hänger", kind: "server", capabilities: [] }, setup(api) { while (true) {} } };',
    });
    await assert.rejects(
      () => e.sandbox.instantiate(record, { timeoutMs: 150 }),
      (err) => err.code === 'MODULE_TIMEOUT',
    );
    assert.equal(e.sandbox.has(record.id), false, 'a module that timed out must not stay registered');
  } finally {
    await e.cleanup();
  }
});

test('require() explains where capabilities come from and names the right one', async () => {
  const e = await env('sbx-require');
  try {
    await assert.rejects(
      () => e.sandbox.evaluate('const fs = require("fs");', { kind: 'server' }),
      (err) => {
        assert.match(err.message, /api\.files/);
        assert.match(err.message, /setup\(api\)/);
        return true;
      },
    );
    await assert.rejects(
      () => e.sandbox.evaluate('const http = require("node:http");', { kind: 'server' }),
      (err) => /api\.fetch/.test(err.message),
    );
  } finally {
    await e.cleanup();
  }
});

test('eval and new Function are not available inside a module', async () => {
  const e = await env('sbx-eval');
  try {
    await assert.rejects(() => e.sandbox.evaluate('eval("1+1");', { kind: 'server' }));
    await assert.rejects(() => e.sandbox.evaluate('new Function("return 1")();', { kind: 'server' }));
  } finally {
    await e.cleanup();
  }
});

test('timers are cleaned up when the module is disabled', async () => {
  const e = await env('sbx-timers');
  try {
    const record = e.install({
      name: 'Ticker',
      source: [
        'module.exports = {',
        '  manifest: { name: "Ticker", kind: "server", capabilities: [] },',
        '  setup(api) {',
        '    setInterval(() => { api.storage.set("ticks", (api.storage.get("ticks") || 0) + 1); }, 50);',
        '  },',
        '};',
      ].join('\n'),
    });
    await e.sandbox.instantiate(record);
    await sleep(180);
    const ticks = e.store.get(record.id).data.storage.ticks;
    assert.ok(ticks >= 1, `expected the interval to have run, got ${ticks}`);

    e.sandbox.dispose(record.id);
    const afterDispose = e.store.get(record.id).data.storage.ticks;
    await sleep(180);
    assert.equal(
      e.store.get(record.id).data.storage.ticks,
      afterDispose,
      'a disabled module must not keep ticking',
    );
  } finally {
    await e.cleanup();
  }
});

/* ------------------------------------------------------- the capability api */

test('a permission that was not granted leaves no property on api at all', async () => {
  const e = await env('sbx-caps');
  try {
    const probe = [
      'module.exports = {',
      '  manifest: { name: "Prüfer", kind: "server", capabilities: CAPS },',
      '  setup(api) {',
      '    api.storage.set("gesehen", {',
      '      records: "records" in api,',
      '      fetch: "fetch" in api,',
      '      files: "files" in api,',
      '      tool: "tool" in api,',
      '      route: "route" in api,',
      '      on: "on" in api,',
      '      model: "model" in api,',
      '      storage: "storage" in api,',
      '    });',
      '  },',
      '};',
    ].join('\n');

    const bare = e.install({
      name: 'Ohne',
      source: probe.replace('CAPS', '[]'),
      capabilities: [],
    });
    await e.sandbox.instantiate(bare);
    const seenBare = e.store.get(bare.id).data.storage.gesehen;
    assert.deepEqual(seenBare, {
      records: false, fetch: false, files: false, tool: false,
      route: false, on: false, model: false, storage: true,
    });
    e.sandbox.dispose(bare.id);

    const armed = e.install({
      name: 'Mit',
      source: probe.replace('CAPS', '["records.read", "tools.add"]'),
      capabilities: ['records.read', 'tools.add'],
    });
    await e.sandbox.instantiate(armed);
    const seenArmed = e.store.get(armed.id).data.storage.gesehen;
    assert.equal(seenArmed.records, true);
    assert.equal(seenArmed.tool, true);
    assert.equal(seenArmed.fetch, false, 'no network capability means no api.fetch');
  } finally {
    await e.cleanup();
  }
});

test('records.read grants reading and nothing else', async () => {
  const e = await env('sbx-records');
  try {
    e.store.create('note', { title: 'Einkaufen', body: 'Milch', tags: ['haushalt'] });
    const record = e.install({
      name: 'Leser',
      capabilities: ['records.read'],
      source: [
        'module.exports = {',
        '  manifest: { name: "Leser", kind: "server", capabilities: ["records.read"] },',
        '  setup(api) {',
        '    api.storage.set("anzahl", api.records.list("note").length);',
        '    api.storage.set("darfSchreiben", typeof api.records.create === "function");',
        '  },',
        '};',
      ].join('\n'),
    });
    await e.sandbox.instantiate(record);
    const storage = e.store.get(record.id).data.storage;
    assert.equal(storage.anzahl, 1);
    assert.equal(storage.darfSchreiben, false);
  } finally {
    await e.cleanup();
  }
});

test('a module cannot write the record types that decide its own permissions', async () => {
  const e = await env('sbx-escalate');
  try {
    const record = e.install({
      name: 'Aufsteiger',
      capabilities: ['records.read', 'records.write'],
      source: [
        'module.exports = {',
        '  manifest: { name: "Aufsteiger", kind: "server", capabilities: ["records.read", "records.write"] },',
        '  setup(api) {',
        '    const versuche = {};',
        '    for (const typ of ["agent", "grant", "token", "module"]) {',
        '      try { api.records.create(typ, { name: "x", scope: "global", label: "x", hash: "x", salt: "x", source: "x" }); versuche[typ] = "erlaubt"; }',
        '      catch (err) { versuche[typ] = err.code; }',
        '    }',
        '    api.storage.set("versuche", versuche);',
        '  },',
        '};',
      ].join('\n'),
    });
    await e.sandbox.instantiate(record);
    const versuche = e.store.get(record.id).data.storage.versuche;
    for (const typ of ['agent', 'grant', 'token', 'module']) {
      assert.equal(versuche[typ], 'PERMISSION_DENIED', `${typ} must be refused`);
    }
  } finally {
    await e.cleanup();
  }
});

test('api.storage is capped so one module cannot fill the vault', async () => {
  const e = await env('sbx-storage');
  try {
    const record = e.install({ name: 'Vielschreiber', source: 'module.exports = { manifest: { name: "V", kind: "server", capabilities: [] }, setup(api) {} };' });
    const { api } = await e.sandbox.instantiate(record);
    assert.throws(
      () => api.storage.set('gross', 'x'.repeat(sandboxMod.MAX_STORAGE_BYTES + 10)),
      (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /voll/);
        return true;
      },
    );
    api.storage.set('klein', { a: 1 });
    assert.deepEqual(api.storage.get('klein'), { a: 1 });
    assert.deepEqual(api.storage.keys(), ['klein']);
  } finally {
    await e.cleanup();
  }
});

/* ----------------------------------------------------------- tools + routes */

test('a route outside /api/x/ is refused so no existing address can be shadowed', async () => {
  const e = await env('sbx-routes');
  try {
    const record = e.install({
      name: 'Adressen',
      capabilities: ['routes.add'],
      source: 'module.exports = { manifest: { name: "A", kind: "server", capabilities: ["routes.add"] }, setup(api) {} };',
    });
    const { api } = await e.sandbox.instantiate(record);
    for (const bad of ['/api/records', '/api/xy/test', '/x/test', '/api/x/']) {
      assert.throws(() => api.route('GET', bad, () => ({})), (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        return true;
      }, `"${bad}" must be refused`);
    }
    const ok = api.route('GET', '/api/x/statistik', () => ({ zahl: 1 }));
    assert.equal(ok.path, '/api/x/statistik');
    assert.throws(() => api.route('BREW', '/api/x/kaffee', () => ({})), /Methode/);
  } finally {
    await e.cleanup();
  }
});

test('a module tool cannot take over a built-in tool name', async () => {
  const e = await env('sbx-tools');
  try {
    const record = e.install({
      name: 'Werkzeuge',
      capabilities: ['tools.add'],
      source: 'module.exports = { manifest: { name: "W", kind: "server", capabilities: ["tools.add"] }, setup(api) {} };',
    });
    const { api } = await e.sandbox.instantiate(record);
    assert.throws(() => api.tool({ name: 'files.write', run() {} }), /eingebauten/);
    assert.throws(() => api.tool({ name: 'Grossbuchstaben', run() {} }), /Werkzeugname/);
    const tool = api.tool({ name: 'statistik.tags', description: 'zählt', run: () => ({ ok: 1 }) });
    assert.equal(tool.name, 'statistik.tags');
  } finally {
    await e.cleanup();
  }
});

test('what a tool returns arrives as plain data, and a throw reaches the caller', async () => {
  const e = await env('sbx-toolrun');
  try {
    const record = e.install({
      name: 'Läufer',
      capabilities: ['tools.add'],
      source: [
        'module.exports = {',
        '  manifest: { name: "Läufer", kind: "server", capabilities: ["tools.add"] },',
        '  setup(api) {',
        '    api.tool({ name: "test.echo", description: "echo", run: (args) => ({ zurueck: args.text }) });',
        '    api.tool({ name: "test.kaputt", description: "wirft", run: () => { throw new Error("kaputt"); } });',
        '  },',
        '};',
      ].join('\n'),
    });
    const { registered } = await e.sandbox.instantiate(record);
    const echo = registered.tools.find((t) => t.name === 'test.echo');
    const result = await echo.run({ text: 'hallo' });
    assert.deepEqual(result, { zurueck: 'hallo' });
    assert.equal(Object.getPrototypeOf(result), Object.prototype, 'the result must be a host-realm plain object');

    const kaputt = registered.tools.find((t) => t.name === 'test.kaputt');
    await assert.rejects(() => kaputt.run({}), /kaputt/);
  } finally {
    await e.cleanup();
  }
});

/* ---------------------------------------------------------------- files */

test('files stay inside the shared folders, symlinks included', async () => {
  const e = await env('sbx-files');
  try {
    const shared = path.join(e.home, 'geteilt');
    const secret = path.join(e.home, 'geheim');
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(secret, { recursive: true });
    fs.writeFileSync(path.join(shared, 'notiz.txt'), 'hallo');
    fs.writeFileSync(path.join(secret, 'passwort.txt'), 'geheim');
    fs.symlinkSync(secret, path.join(shared, 'tuer'));

    const record = e.install({
      name: 'Dateien',
      capabilities: ['files.read', 'files.write'],
      fileRoots: [shared],
      source: 'module.exports = { manifest: { name: "D", kind: "server", capabilities: ["files.read", "files.write"] }, setup(api) {} };',
    });
    const { api } = await e.sandbox.instantiate(record);

    assert.equal(api.files.read('notiz.txt'), 'hallo');

    // The three ways out, all closed.
    assert.throws(() => api.files.read('../geheim/passwort.txt'), (err) => {
      assert.equal(err.code, 'PERMISSION_DENIED');
      return true;
    });
    assert.throws(() => api.files.read(path.join(secret, 'passwort.txt')), (err) => err.code === 'PERMISSION_DENIED');
    assert.throws(() => api.files.read('tuer/passwort.txt'), (err) => {
      assert.equal(err.code, 'PERMISSION_DENIED');
      assert.match(err.message, /Symlink/);
      return true;
    }, 'a symlink out of the folder must not be a way out');

    api.files.write('neu.txt', 'inhalt');
    assert.equal(fs.readFileSync(path.join(shared, 'neu.txt'), 'utf8'), 'inhalt');
    assert.throws(() => api.files.write('tuer/neu.txt', 'x'), (err) => err.code === 'PERMISSION_DENIED');
  } finally {
    await e.cleanup();
  }
});

test('a file capability without a shared folder says so instead of failing silently', async () => {
  const e = await env('sbx-noroots');
  try {
    const record = e.install({
      name: 'Ohne Ordner',
      capabilities: ['files.read'],
      fileRoots: [],
      source: 'module.exports = { manifest: { name: "O", kind: "server", capabilities: ["files.read"] }, setup(api) {} };',
    });
    const { api } = await e.sandbox.instantiate(record);
    assert.ok(api.files, 'the capability was granted, so the property exists');
    assert.throws(() => api.files.read('irgendwas.txt'), (err) => {
      assert.equal(err.code, 'PERMISSION_DENIED');
      assert.match(err.message, /kein Ordner freigegeben/);
      return true;
    });
  } finally {
    await e.cleanup();
  }
});

/* --------------------------------------------------------------- network */

test('without a network capability there is no api.fetch, and with one the gate still decides', async () => {
  const e = await env('sbx-net');
  try {
    const offline = e.install({
      name: 'Stubenhocker',
      capabilities: [],
      source: 'module.exports = { manifest: { name: "S", kind: "server", capabilities: [] }, setup(api) {} };',
    });
    const bare = await e.sandbox.instantiate(offline);
    assert.equal(bare.api.fetch, undefined);
    e.sandbox.dispose(offline.id);

    // config.network.mode is 'offline' by default, so the gate refuses -- and
    // it refuses BEFORE resolving the name, which is why this test is safe.
    const online = e.install({
      name: 'Neugierig',
      capabilities: ['net.online'],
      source: 'module.exports = { manifest: { name: "N", kind: "server", capabilities: ["net.online"] }, setup(api) {} };',
    });
    const armed = await e.sandbox.instantiate(online);
    assert.equal(typeof armed.api.fetch, 'function');
    await assert.rejects(() => armed.api.fetch('https://example.com/'), (err) => {
      assert.equal(err.code, 'NETWORK_BLOCKED');
      return true;
    });
  } finally {
    await e.cleanup();
  }
});

test('a module cannot widen its own network permission through the init object', async () => {
  const e = await env('sbx-net2');
  try {
    const seen = [];
    const fakeGate = { fetch: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 }; } };
    const sandbox = createSandbox({ store: e.store, gate: fakeGate, bus: e.bus, config: e.config, paths: e.paths });
    const record = e.install({
      name: 'Schlau',
      capabilities: ['net.lan'],
      source: 'module.exports = { manifest: { name: "S", kind: "server", capabilities: ["net.lan"] }, setup(api) {} };',
    });
    const { api } = await sandbox.instantiate(record);
    await api.fetch('http://192.168.1.5/', { maxLevel: 'online', scope: 'global', allowedHosts: ['*'] });
    assert.equal(seen[0].init.maxLevel, 'lan', 'the ceiling comes from the capabilities, not from the module');
    assert.equal(seen[0].init.scope, `module:${record.id}`);
    assert.equal(seen[0].init.allowedHosts, undefined);
    sandbox.disposeAll();
  } finally {
    await e.cleanup();
  }
});

/* ------------------------------------------------------------- dry run */

test('a trial run registers nothing and writes nothing', async () => {
  const e = await env('sbx-dry');
  try {
    const before = e.store.count('note');
    const record = e.install({
      name: 'Probe',
      capabilities: ['records.read', 'records.write', 'tools.add'],
      source: [
        'module.exports = {',
        '  manifest: { name: "Probe", kind: "server", capabilities: ["records.read", "records.write", "tools.add"] },',
        '  setup(api) {',
        '    api.tool({ name: "probe.test", description: "x", run: () => 1 });',
        '    api.records.create("note", { title: "vom Probelauf" });',
        '  },',
        '};',
      ].join('\n'),
    });
    await assert.rejects(() => e.sandbox.instantiate(record, { dryRun: true }), (err) => {
      assert.equal(err.code, 'MODULE_DRYRUN_WRITE');
      return true;
    });
    assert.equal(e.store.count('note'), before, 'a check must not create records');
    assert.equal(e.sandbox.has(record.id), false);
  } finally {
    await e.cleanup();
  }
});

module.exports = { name: 'sandbox', tests: drain() };
