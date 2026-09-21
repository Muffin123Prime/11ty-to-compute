'use strict';

/**
 * Tests for the module register.
 *
 * The premise throughout: the pasted code is wrong. What has to hold is that
 * the app still starts, still works, says what went wrong, and lets the user
 * get back to where they were.
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
const { createSandbox } = require('../src/modules/sandbox');
const { createModuleRegistry, CRASH_FILE } = require('../src/modules/registry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition instead of guessing a delay. */
async function until(fn, ms = 1500) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
}

function serverModule(name, body, caps = []) {
  return [
    'module.exports = {',
    `  manifest: { name: ${JSON.stringify(name)}, description: "Testmodul", kind: "server", capabilities: ${JSON.stringify(caps)} },`,
    `  setup(api) {${body}}`,
    '};',
  ].join('\n');
}

async function env(label) {
  const tmp = tempHome(label);
  const paths = ensureLayout(layout(tmp.home));
  const config = configMod.defaults();
  const bus = new Bus();
  const audit = new Audit(paths.audit, { enabled: false });
  const store = await openStore({ paths, bus });
  const gate = createGate({ config, audit, bus, store });
  const sandbox = createSandbox({ store, gate, bus, config, paths, audit });
  const registry = createModuleRegistry({ store, sandbox, bus, config, audit, paths });
  const events = [];
  bus.subscribe((evt) => { if (evt.name.startsWith('module.')) events.push(evt); });
  return {
    home: tmp.home,
    paths,
    bus,
    store,
    sandbox,
    registry,
    events,
    eventNames: () => events.map((e) => e.name),
    async cleanup() {
      try { await registry.disposeAll(); } catch { /* ignore */ }
      await store.close();
      tmp.cleanup();
    },
  };
}

/* ---------------------------------------------------------------- checking */

test('validate never throws -- problems come back as data', async () => {
  const e = await env('mod-validate');
  try {
    for (const bad of ['', '   ', 'const x = ;', 'module.exports = {};', null, 42]) {
      const report = await e.registry.validate(bad);
      assert.equal(report.ok, false, `"${String(bad).slice(0, 20)}" should not be ok`);
      assert.ok(Array.isArray(report.problems) && report.problems.length > 0);
      assert.equal(typeof report.problems[0].message, 'string');
    }
    const syntax = await e.registry.validate('module.exports = {\n  manifest: {},\n  setup(api) { const y = ; },\n};');
    assert.equal(syntax.problems[0].line, 3, 'the workshop needs the line to mark it');
  } finally {
    await e.cleanup();
  }
});

test('a check reports the permissions in plain German before anything is installed', async () => {
  const e = await env('mod-report');
  try {
    const report = await e.registry.validate(
      serverModule('Notiz-Statistik', ' api.tool({ name: "stat.tags", description: "zählt", run: () => ({}) }); ', ['records.read', 'tools.add']),
    );
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.manifest.name, 'Notiz-Statistik');
    assert.deepEqual(report.capabilities, ['records.read', 'tools.add']);
    assert.equal(report.risk, 'medium');
    assert.match(report.description, /Darf:/);
    assert.match(report.description, /Kein Netzzugang/);
    assert.deepEqual(report.registered.tools.map((t) => t.name), ['stat.tags']);
    assert.equal(e.store.count('module'), 0, 'checking must not install anything');
  } finally {
    await e.cleanup();
  }
});

test('an unknown capability is named rather than silently dropped', async () => {
  const e = await env('mod-unknowncap');
  try {
    const report = await e.registry.validate(serverModule('Fantasie', '', ['records.read', 'zaubern']));
    assert.equal(report.ok, false);
    assert.match(report.problems.map((p) => p.message).join(' '), /zaubern/);
  } finally {
    await e.cleanup();
  }
});

/* -------------------------------------------------------------- installing */

test('install stores the module switched off, with the source kept', async () => {
  const e = await env('mod-install');
  try {
    const source = serverModule('Zähler', ' api.log("hallo"); ', []);
    const { record, validation } = await e.registry.install({ source, note: 'erster Versuch' });
    assert.equal(validation.ok, true);
    assert.equal(record.data.enabled, false, 'nothing runs before the user says so');
    assert.equal(record.data.version, 1);
    assert.equal(record.data.source, source);
    assert.deepEqual(record.data.versions, []);
    assert.ok(e.eventNames().includes('module.installed'));

    const list = e.registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].loaded, false);
    assert.equal(list[0].name, 'Zähler');
  } finally {
    await e.cleanup();
  }
});

test('install refuses broken code and hands the whole report to the caller', async () => {
  const e = await env('mod-install-bad');
  try {
    await assert.rejects(
      () => e.registry.install({ source: 'module.exports = { setup(api) {} };' }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.ok(err.details.validation.problems.length > 0, 'the report travels with the error');
        return true;
      },
    );
    assert.equal(e.store.count('module'), 0);
  } finally {
    await e.cleanup();
  }
});

/* --------------------------------------------------------------- enabling */

test('enable really instantiates; a module that throws stays off with a reason', async () => {
  const e = await env('mod-enable');
  try {
    const good = await e.registry.install({ source: serverModule('Gut', ' api.log("da"); ', []) });
    const result = await e.registry.enable(good.record.id);
    assert.equal(result.record.data.enabled, true);
    assert.equal(e.registry.isLoaded(good.record.id), true);
    assert.equal(e.registry.status().loaded, 1);

    // A module that only fails once it is really set up: the check passes
    // (the trial run refuses the write), enabling then fails for real.
    const bad = e.store.create('module', {
      name: 'Kaputt beim Start',
      kind: 'server',
      source: serverModule('Kaputt beim Start', ' throw new Error("Datenbank fehlt"); ', []),
      capabilities: [],
      enabled: false,
    });
    await assert.rejects(() => e.registry.enable(bad.id), (err) => {
      assert.equal(err.code, 'MODULE_FAILED');
      assert.match(err.message, /Datenbank fehlt/);
      return true;
    });
    const after = e.store.get(bad.id);
    assert.equal(after.data.enabled, false, 'a failed activation must not leave enabled:true behind');
    assert.ok(after.data.lastError, 'the reason is kept for the workshop');
    assert.equal(after.data.lastError.where, 'Aktivieren');
    assert.equal(after.data.failures, 1);
  } finally {
    await e.cleanup();
  }
});

test('confirming fewer permissions is allowed, confirming more is not', async () => {
  const e = await env('mod-confirm');
  try {
    const { record } = await e.registry.install({
      source: serverModule('Sparsam', ' api.storage.set("hat", { records: "records" in api, tools: "tool" in api }); ', ['records.read', 'tools.add']),
    });
    await assert.rejects(
      () => e.registry.enable(record.id, { capabilities: ['records.read', 'files.write'] }),
      /nicht verlangt/,
    );
    const enabled = await e.registry.enable(record.id, { capabilities: ['records.read'] });
    assert.deepEqual(enabled.record.data.capabilities, ['records.read']);
    const seen = e.store.get(record.id).data.storage.hat;
    assert.deepEqual(seen, { records: true, tools: false }, 'the api follows the confirmation, not the manifest');
  } finally {
    await e.cleanup();
  }
});

test('disable tears the module down and takes its tools with it', async () => {
  const e = await env('mod-disable');
  try {
    const { record } = await e.registry.install({
      source: serverModule('Werkzeugkasten', ' api.tool({ name: "kasten.eins", description: "x", run: () => 1 }); ', ['tools.add']),
    });
    await e.registry.enable(record.id);
    assert.equal(e.registry.tools().length, 1);
    assert.equal(e.registry.tools()[0].moduleId, record.id);

    await e.registry.disable(record.id);
    assert.equal(e.registry.tools().length, 0);
    assert.equal(e.store.get(record.id).data.enabled, false);
    assert.ok(e.eventNames().includes('module.disabled'));
  } finally {
    await e.cleanup();
  }
});

/* ------------------------------------------------------- crash protection */

test('a module that took the process down last time is switched off at the next start', async () => {
  const e = await env('mod-crash');
  try {
    const { record } = await e.registry.install({ source: serverModule('Absturz', ' api.log("x"); ', []) });
    await e.registry.enable(record.id);
    await e.registry.disposeAll();

    // Exactly what a hard crash during loading leaves behind.
    fs.writeFileSync(
      path.join(e.home, CRASH_FILE),
      JSON.stringify({ id: record.id, name: 'Absturz', at: new Date().toISOString() }),
    );

    const result = await e.registry.loadAll();
    assert.equal(result.loaded, 0, 'the crasher must not be loaded again');
    assert.equal(result.crashRecovery.id, record.id);
    const after = e.store.get(record.id);
    assert.equal(after.data.enabled, false);
    assert.equal(after.data.lastError.code, 'MODULE_CRASH');
    assert.match(after.data.lastError.message, /mitgerissen/);
    assert.equal(fs.existsSync(path.join(e.home, CRASH_FILE)), false, 'the marker is consumed');
  } finally {
    await e.cleanup();
  }
});

test('a module that throws while loading does not stop the others', async () => {
  const e = await env('mod-loadall');
  try {
    const crasher = e.store.create('module', {
      name: 'Bremser',
      kind: 'server',
      source: serverModule('Bremser', ' throw new Error("ich falle um"); ', []),
      capabilities: [],
      enabled: true,
    });
    const first = e.store.create('module', {
      name: 'Erster',
      kind: 'server',
      source: serverModule('Erster', ' api.tool({ name: "eins.tu", description: "x", run: () => 1 }); ', ['tools.add']),
      capabilities: ['tools.add'],
      enabled: true,
    });
    const second = e.store.create('module', {
      name: 'Zweiter',
      kind: 'server',
      source: serverModule('Zweiter', ' api.tool({ name: "zwei.tu", description: "x", run: () => 2 }); ', ['tools.add']),
      capabilities: ['tools.add'],
      enabled: true,
    });

    const result = await e.registry.loadAll();
    assert.equal(result.failed, 1);
    assert.equal(result.loaded, 2, 'the other two must still be there');
    assert.equal(e.store.get(crasher.id).data.enabled, false);
    assert.match(e.store.get(crasher.id).data.lastError.message, /ich falle um/);
    assert.equal(e.store.get(first.id).data.enabled, true);
    assert.equal(e.store.get(second.id).data.enabled, true);
    assert.deepEqual(e.registry.tools().map((t) => t.name).sort(), ['eins.tu', 'zwei.tu']);
    assert.equal(fs.existsSync(path.join(e.home, CRASH_FILE)), false);
  } finally {
    await e.cleanup();
  }
});

test('a module with an endless loop at load time is switched off, not waited for', async () => {
  const e = await env('mod-hang');
  try {
    e.store.create('module', {
      name: 'Hänger',
      kind: 'server',
      source: 'while (true) {}',
      capabilities: [],
      enabled: true,
    });
    const started = Date.now();
    const result = await e.registry.loadAll();
    assert.ok(Date.now() - started < 10000, 'loadAll must come back');
    assert.equal(result.failed, 1);
    assert.equal(result.loaded, 0);
  } finally {
    await e.cleanup();
  }
});

test('safe mode loads nothing and says how many it skipped', async () => {
  const e = await env('mod-safe');
  try {
    const { record } = await e.registry.install({ source: serverModule('Egal', ' api.log("x"); ', []) });
    await e.registry.enable(record.id);
    await e.registry.disposeAll();

    const result = await e.registry.loadAll({ safeMode: true });
    assert.equal(result.safeMode, true);
    assert.equal(result.loaded, 0);
    assert.equal(result.disabled, 1);
    assert.equal(e.store.get(record.id).data.enabled, true, 'safe mode does not un-choose the user\'s choice');
    await assert.rejects(() => e.registry.enable(record.id), (err) => err.code === 'SAFE_MODE');
  } finally {
    await e.cleanup();
  }
});

test('three errors in a row switch a module off by itself', async () => {
  const e = await env('mod-strikes');
  try {
    const { record } = await e.registry.install({
      source: serverModule('Nörgler', ' api.on("test.ping", () => { throw new Error("schon wieder"); }); ', ['bus.listen']),
    });
    await e.registry.enable(record.id);
    assert.equal(e.registry.isLoaded(record.id), true);

    e.bus.publish('test.ping', {});
    assert.equal(e.registry.isLoaded(record.id), true, 'one mistake is not a verdict');
    e.bus.publish('test.ping', {});
    e.bus.publish('test.ping', {});

    const off = await until(() => !e.registry.isLoaded(record.id));
    assert.equal(off, true, 'after three failures the module must be off');
    const after = e.store.get(record.id);
    assert.equal(after.data.enabled, false);
    assert.equal(after.data.failures, 3);
    assert.match(after.data.lastError.message, /schon wieder/);
    assert.ok(after.data.lastError.stack, 'the workshop shows the stack');

    // And it really is quiet now.
    const before = e.store.get(record.id).data.failures;
    e.bus.publish('test.ping', {});
    await sleep(50);
    assert.equal(e.store.get(record.id).data.failures, before);
  } finally {
    await e.cleanup();
  }
});

/* ------------------------------------------------------------ reversibility */

test('install -> update -> update -> rollback to 1 -> rollback to 3', async () => {
  const e = await env('mod-versions');
  try {
    const v1 = serverModule('Wandler', ' api.storage.set("fassung", 1); ', []);
    const v2 = serverModule('Wandler', ' api.storage.set("fassung", 2); ', []);
    const v3 = serverModule('Wandler', ' api.storage.set("fassung", 3); ', []);

    const installed = await e.registry.install({ source: v1, note: 'Anfang' });
    const id = installed.record.id;
    assert.equal(installed.record.data.version, 1);

    const after2 = await e.registry.update(id, { source: v2, note: 'zweiter Anlauf' });
    assert.equal(after2.record.data.version, 2);
    assert.equal(after2.record.data.versions.length, 1);
    assert.equal(after2.record.data.versions[0].version, 1);
    assert.equal(after2.record.data.versions[0].source, v1);

    const after3 = await e.registry.update(id, { source: v3, note: 'dritter Anlauf' });
    assert.equal(after3.record.data.version, 3);
    assert.equal(after3.record.data.source, v3);
    assert.deepEqual(after3.record.data.versions.map((v) => v.version), [1, 2]);

    // Back to the very first version.
    const back = await e.registry.rollback(id, 1);
    assert.equal(back.record.data.source, v1, 'the old source is active again');
    assert.equal(back.record.data.version, 4, 'a rollback is a new version, so it is itself reversible');
    assert.deepEqual(back.record.data.versions.map((v) => v.version), [1, 2, 3]);
    assert.equal(back.record.data.enabled, false);

    // And forward again to what version 3 contained.
    const forward = await e.registry.rollback(id, 3);
    assert.equal(forward.record.data.source, v3);
    assert.equal(forward.record.data.version, 5);
    assert.deepEqual(forward.record.data.versions.map((v) => v.version), [1, 2, 3, 4]);

    await assert.rejects(() => e.registry.rollback(id, 99), (err) => err.code === 'NOT_FOUND');
  } finally {
    await e.cleanup();
  }
});

test('a rollback works even when the old version no longer validates', async () => {
  const e = await env('mod-rollback-broken');
  try {
    // Installed while it was fine, then the record is doctored to hold a
    // version that would never pass a check today -- exactly the state a user
    // ends up in after an update that changed the rules.
    const good = serverModule('Retter', ' api.log("ok"); ', []);
    const { record } = await e.registry.install({ source: good });
    const broken = 'module.exports = { manifest: { name: "Retter", kind: "server", capabilities: ["zaubern"] }, setup(api) {} };';
    e.store.update(record.id, {
      versions: [{ version: 1, source: broken, at: new Date().toISOString(), note: 'kaputt' }],
      version: 2,
      source: good,
    });

    const result = await e.registry.rollback(record.id, 1);
    assert.equal(result.record.data.source, broken, 'the way back must never be blocked');
    assert.equal(result.record.data.enabled, false);
    assert.equal(result.validation.ok, false, 'and the report says honestly that it is broken');
  } finally {
    await e.cleanup();
  }
});

test('update switches the module off until the user says yes again', async () => {
  const e = await env('mod-update-off');
  try {
    const { record } = await e.registry.install({ source: serverModule('Laufend', ' api.log("a"); ', []) });
    await e.registry.enable(record.id);
    assert.equal(e.registry.isLoaded(record.id), true);

    const updated = await e.registry.update(record.id, { source: serverModule('Laufend', ' api.log("b"); ', []) });
    assert.equal(updated.record.data.enabled, false);
    assert.equal(updated.wasEnabled, true, 'the caller can offer to switch it back on');
    assert.equal(e.registry.isLoaded(record.id), false);

    await assert.rejects(() => e.registry.update(record.id, { source: 'const x = ;' }), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    });
    assert.equal(e.store.get(record.id).data.version, 2, 'a refused update changes nothing');
  } finally {
    await e.cleanup();
  }
});

/* ------------------------------------------------------- routes and removal */

test('routes are collected for the router, with the module behind each one', async () => {
  const e = await env('mod-routes');
  try {
    const { record } = await e.registry.install({
      source: serverModule('Adressen', ' api.route("GET", "/api/x/hallo", (req) => ({ gruss: "hallo", frage: req.query.n })); ', ['routes.add']),
    });
    await e.registry.enable(record.id);
    const routes = e.registry.routes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].method, 'GET');
    assert.equal(routes[0].path, '/api/x/hallo');
    assert.equal(routes[0].moduleId, record.id);

    const answer = await routes[0].handler({ method: 'GET', pathname: '/api/x/hallo', params: {}, query: { n: '3' } });
    assert.deepEqual(answer, { gruss: 'hallo', frage: '3' });

    await e.registry.disable(record.id);
    assert.equal(e.registry.routes().length, 0);
  } finally {
    await e.cleanup();
  }
});

test('remove disables and soft-deletes, so nothing is actually lost', async () => {
  const e = await env('mod-remove');
  try {
    const { record } = await e.registry.install({ source: serverModule('Weg', ' api.log("x"); ', []) });
    await e.registry.enable(record.id);
    await e.registry.remove(record.id);

    assert.equal(e.registry.isLoaded(record.id), false);
    assert.equal(e.registry.list().length, 0);
    assert.equal(e.store.get(record.id), null);
    assert.ok(e.store.get(record.id, { includeDeleted: true }), 'the record is a tombstone, not gone');
    assert.ok(e.eventNames().includes('module.removed'));
  } finally {
    await e.cleanup();
  }
});

test('status tells the truth about what is loaded, failed and off', async () => {
  const e = await env('mod-status');
  try {
    const a = await e.registry.install({ source: serverModule('A', ' api.log("a"); ', []) });
    await e.registry.install({ source: serverModule('B', ' api.log("b"); ', []) });
    await e.registry.enable(a.record.id);

    const status = e.registry.status();
    assert.equal(status.total, 2);
    assert.equal(status.loaded, 1);
    assert.equal(status.disabled, 1);
    assert.equal(status.failed, 0);
    assert.equal(status.safeMode, false);
  } finally {
    await e.cleanup();
  }
});

module.exports = { name: 'modules', tests: drain() };
