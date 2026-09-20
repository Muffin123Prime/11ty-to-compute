'use strict';

const assert = require('node:assert/strict');
const { test, drain, tempHome } = require('./harness');
const path = require('node:path');
const fs = require('node:fs');

const paths = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const schema = require('../src/store/schema');
const errors = require('../src/kernel/errors');

test('layout keeps everything under one home directory', () => {
  const l = paths.layout('/tmp/nos-home');
  for (const key of ['config', 'vault', 'log', 'files', 'audit', 'runs', 'exports']) {
    assert.ok(l[key].startsWith('/tmp/nos-home'), `${key} escapes home: ${l[key]}`);
  }
});

test('safeJoin blocks path traversal', () => {
  assert.equal(paths.safeJoin('/root', 'a/b'), path.resolve('/root/a/b'));
  assert.throws(() => paths.safeJoin('/root', '../etc/passwd'), /escapes/);
  assert.throws(() => paths.safeJoin('/root', '/etc/passwd'), /escapes/);
});

test('default configuration is offline and loopback-bound', () => {
  const d = configMod.defaults();
  assert.equal(d.network.mode, 'offline');
  assert.equal(d.server.host, '127.0.0.1');
  assert.equal(d.security.sharing.enabled, false);
  assert.equal(d.security.encryption.enabled, false);
  assert.deepEqual(d.network.allowHosts, []);
});

test('config refuses an unauthenticated public bind', () => {
  const c = configMod.defaults();
  c.server.host = '0.0.0.0';
  assert.throws(() => configMod.validateConfig(c), /sharing.enabled is false/);
  c.security.sharing.enabled = true;
  c.security.sharing.requireToken = false;
  assert.throws(() => configMod.validateConfig(c), /without token authentication/);
  c.security.sharing.requireToken = true;
  assert.equal(configMod.validateConfig(c), true);
});

test('config save/load round-trips atomically', () => {
  const { home, cleanup } = tempHome('cfg');
  try {
    const file = path.join(home, 'config.json');
    const c = configMod.defaults();
    c.network.mode = 'lan';
    configMod.save(file, c);
    assert.equal(configMod.load(file).network.mode, 'lan');
    // Unknown future keys survive a round-trip.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.futureFeature = { x: 1 };
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.deepEqual(configMod.load(file).futureFeature, { x: 1 });
  } finally {
    cleanup();
  }
});

test('corrupt config falls back to safe defaults and preserves the file', () => {
  const { home, cleanup } = tempHome('cfg2');
  try {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => configMod.load(file), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      assert.equal(err.recovered.network.mode, 'offline');
      return true;
    });
    assert.ok(fs.existsSync(file), 'original corrupt file must be kept');
  } finally {
    cleanup();
  }
});

test('bus replays events for reconnecting clients', () => {
  const bus = new Bus();
  bus.publish('a', {});
  bus.publish('b', {});
  bus.publish('c', {});
  assert.deepEqual(bus.since(1).map((e) => e.name), ['b', 'c']);
  assert.equal(bus.since(99).length, 0);
});

test('a throwing bus listener cannot break the publisher', () => {
  const bus = new Bus();
  bus.on('boom', () => { throw new Error('listener exploded'); });
  const evt = bus.publish('boom', { ok: true });
  assert.equal(evt.name, 'boom');
});

test('audit writes append-only JSONL', () => {
  const { home, cleanup } = tempHome('audit');
  try {
    const a = new Audit(path.join(home, 'audit.jsonl')).open();
    a.write('network.block', { host: 'evil.example', scope: 'global' });
    a.write('network.allow', { host: '127.0.0.1' });
    a.close();
    const entries = a.readTail(10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, 'network.allow');
    assert.ok(entries[0].at);
  } finally {
    cleanup();
  }
});

test('schema fills defaults and enforces required fields', () => {
  const n = schema.validate('note', { title: 'Test' });
  assert.equal(n.body, '');
  assert.deepEqual(n.tags, []);
  assert.throws(() => schema.validate('note', {}), /title is required/);
  assert.throws(() => schema.validate('nope', {}), /Unknown record type/);
});

test('schema partial mode skips required checks for PATCH', () => {
  const p = schema.validate('note', { body: 'x' }, { partial: true });
  assert.deepEqual(p, { body: 'x' });
});

test('new agents default to no network and approval-required', () => {
  const a = schema.validate('agent', { name: 'X' });
  assert.equal(a.permissions.network, 'offline');
  assert.equal(a.permissions.requireApproval, true);
  assert.equal(a.permissions.writeNotes, false);
  assert.equal(a.permissions.spawnAgents, false);
});

test('enum violations are rejected', () => {
  assert.throws(() => schema.validate('task', { title: 't', status: 'nonsense' }), /status must be one of/);
  assert.throws(() => schema.validate('edge', { from: 'a', to: 'b', kind: 'invented' }), /kind must be one of/);
});

test('error taxonomy carries HTTP status and serialises safely', () => {
  const e = new errors.NetworkBlockedError('blocked', { host: 'x' });
  assert.equal(e.status, 403);
  assert.equal(e.toJSON().error.code, 'NETWORK_BLOCKED');
  const wrapped = errors.asNeuralError(new TypeError('boom'));
  assert.equal(wrapped.code, 'INTERNAL_ERROR');
  assert.equal(errors.asNeuralError(new errors.NotFoundError('note')).status, 404);
});

module.exports = { name: 'kernel', tests: drain() };
