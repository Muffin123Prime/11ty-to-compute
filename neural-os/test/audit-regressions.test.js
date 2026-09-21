'use strict';

/**
 * Regression tests for defects found by the adversarial audit.
 *
 * Each test names the promise that was broken. These are the cases that got
 * through once, so they are the ones most likely to come back.
 */

const assert = require('node:assert/strict');
const dns = require('node:dns');
const { test, drain, tempHome } = require('./harness');

const { createGate } = require('../src/net/gate');
const { harden } = require('../src/net/harden');
const configMod = require('../src/kernel/config');
const permissions = require('../src/agents/permissions');
const { openStore } = require('../src/store/engine');
const { logger } = require('../src/kernel/log');

const silent = { write() {} };
const noBus = { publish() {} };

function gateWith(patch = {}) {
  const config = configMod.deepMerge(configMod.defaults(), patch);
  return createGate({ config, audit: silent, bus: noBus, logger: null });
}

/* -------- Z1/Z2: the resolver's ANSWER decides, not just the name -------- */

test('Z1: a LAN-level grant cannot reach a public address the name resolves to', async () => {
  const gate = gateWith({ network: { mode: 'offline' } });
  gate.addGrant({ scope: 'global', level: 'lan', hosts: ['nas.example.com'], reason: 'Regression' });

  const real = dns.lookup;
  dns.lookup = function (host, opts, cb) {
    const callback = typeof opts === 'function' ? opts : cb;
    const o = typeof opts === 'function' ? {} : (opts || {});
    if (String(host) === 'nas.example.com') {
      return process.nextTick(() => (o.all === true
        ? callback(null, [{ address: '93.184.216.34', family: 4 }])
        : callback(null, '93.184.216.34', 4)));
    }
    return real.call(dns, host, opts, cb);
  };
  const hardening = harden(gate, { logger: null });
  try {
    const err = await new Promise((resolve) => dns.lookup('nas.example.com', (e) => resolve(e)));
    assert.ok(err, 'the resolver answer must be judged, not only the name');
    assert.equal(err.code, 'NETWORK_BLOCKED');
    assert.match(err.message, /93\.184\.216\.34/, 'the denial must name the address that was refused');
  } finally {
    hardening.restore();
    dns.lookup = real;
  }
});

test('Z1: a caller-supplied lookup function cannot bypass the patches', () => {
  const gate = gateWith({ network: { mode: 'offline' } });
  const hardening = harden(gate, { logger: null });
  try {
    assert.throws(
      () => require('node:net').connect({
        host: 'anything.example',
        port: 443,
        lookup: (h, o, c) => c(null, '93.184.216.34', 4),
      }),
      (err) => err.code === 'NETWORK_BLOCKED',
    );
  } finally {
    hardening.restore();
  }
});

test('Z1: localhost still resolves while the gate is offline', async () => {
  const gate = gateWith({ network: { mode: 'offline' } });
  const hardening = harden(gate, { logger: null });
  try {
    const address = await new Promise((resolve, reject) =>
      dns.lookup('localhost', (err, addr) => (err ? reject(err) : resolve(addr))));
    assert.match(address, /^(127\.|::1)/, 'a local model must stay reachable while offline');
  } finally {
    hardening.restore();
  }
});

/* ----------- Z3: a caller's own ceiling narrows the decision ------------- */

test('Z3: an agent limited to LAN cannot reach a public host on an online device', () => {
  const gate = gateWith({ network: { mode: 'online', strictAllowlist: false } });
  const open = gate.check({ host: 'forschung.example.com', ip: '8.8.8.8', port: 443, scope: 'global', record: false });
  assert.equal(open.allowed, true, 'the device itself permits this');

  const limited = gate.check({
    host: 'forschung.example.com', ip: '8.8.8.8', port: 443, scope: 'global',
    maxLevel: 'lan', record: false,
  });
  assert.equal(limited.allowed, false, "the caller's own ceiling must still apply");
  assert.match(limited.reason, /begrenzt/);
});

test('Z3: a caller host list is enforced against the resolved address too', () => {
  const gate = gateWith({ network: { mode: 'online', strictAllowlist: false } });
  const allowed = gate.check({
    host: 'de.wikipedia.org', port: 443, scope: 'global',
    maxLevel: 'online', allowedHosts: ['de.wikipedia.org'], record: false,
  });
  assert.equal(allowed.allowed, true);

  const elsewhere = gate.check({
    host: 'tracker.example.com', port: 443, scope: 'global',
    maxLevel: 'online', allowedHosts: ['de.wikipedia.org'], record: false,
  });
  assert.equal(elsewhere.allowed, false, 'a redirect must not walk the caller off its host list');
});

test('Z3: a ceiling never blocks loopback — the local model is not the internet', () => {
  const gate = gateWith({ network: { mode: 'offline' } });
  const d = gate.check({
    host: '127.0.0.1', port: 11434, scope: 'global',
    maxLevel: 'lan', allowedHosts: ['nothing.example'], record: false,
  });
  assert.equal(d.allowed, true);
});

/* ------------------ Z1: one address, one identity ----------------------- */

test('Z1: the blocklist is not bypassed by writing the address as IPv4-in-IPv6', () => {
  const gate = gateWith({
    network: { mode: 'online', strictAllowlist: false, blockHosts: ['1.2.3.4'] },
  });
  for (const spelling of ['1.2.3.4', '::ffff:1.2.3.4', '[::ffff:1.2.3.4]', '16909060', '0x01020304']) {
    const d = gate.check({ host: spelling, port: 443, scope: 'global', record: false });
    assert.equal(d.allowed, false, `${spelling} must hit the blocklist`);
  }
  // ...while the genuinely different ::1 stays loopback.
  assert.equal(gate.check({ host: '::1', port: 80, scope: 'global', record: false }).classification, 'loopback');
});

/* ------------- Z3: delegation must never be a privilege ladder ----------- */

test('Z3: a spawned agent cannot exceed its parent', () => {
  const parent = {
    id: 'agent_parentaaaaaaaaaaaaaaaaaa', type: 'agent',
    data: {
      name: 'Eltern',
      permissions: {
        readNotes: true, writeNotes: true, network: 'lan',
        allowedHosts: ['nas.local'], requireApproval: true, maxSteps: 8, maxSeconds: 60,
      },
    },
  };
  const cases = [
    [{ writeFiles: true }, 'writeFiles'],
    [{ network: 'online' }, 'network'],
    [{ allowedHosts: ['tracker.example.com'] }, 'host'],
    [{ requireApproval: false }, 'requireApproval'],
    [{ maxSteps: 400 }, 'maxSteps'],
    [{ maxSeconds: 9999 }, 'maxSeconds'],
  ];
  for (const [override, expected] of cases) {
    const child = { id: 'agent_childaaaaaaaaaaaaaaaaaaa', type: 'agent', data: { name: 'Kind', permissions: { ...parent.data.permissions, ...override } } };
    const res = permissions.subsetOf(child, parent);
    assert.equal(res.ok, false, `a child with ${JSON.stringify(override)} must be refused`);
    assert.ok(res.missing.some((m) => m.includes(expected)), `expected ${expected} in ${res.missing.join(',')}`);
  }
  // A genuinely narrower child is still allowed.
  const narrower = {
    id: 'agent_narroweraaaaaaaaaaaaaaaa', type: 'agent',
    data: {
      name: 'Kind', permissions: {
        readNotes: true, network: 'offline', allowedHosts: ['nas.local'],
        requireApproval: true, maxSteps: 4, maxSeconds: 30,
      },
    },
  };
  assert.equal(permissions.subsetOf(narrower, parent).ok, true);
});

/* -------------- Z4: a failed write must change nothing ------------------ */

test('Z4: a write that fails leaves the record intact in memory', async () => {
  const { home, cleanup } = tempHome('nos-durable');
  let store = null;
  try {
    // A crypto layer that starts working and then refuses, standing in for a
    // locked vault, a full disk or a failing encryption step.
    let failing = false;
    const vaultCrypto = {
      enabled: true,
      get state() { return failing ? 'locked' : 'unlocked'; },
      encryptLine: (line) => {
        if (failing) throw new Error('Vault gesperrt');
        return line;
      },
      decryptLine: (line) => line,
      encryptBuffer: (b) => b,
      decryptBuffer: (b) => b,
    };
    store = await openStore({ paths: home, bus: noBus, logger, vaultCrypto });
    const note = store.create('note', { title: 'Steuerunterlagen 2025' });
    await store.flush();

    failing = true;
    assert.throws(() => store.remove(note.id, { hard: true }), /gesperrt|STORAGE|locked/i);
    assert.ok(store.get(note.id), 'the record must survive a write that did not happen');
    assert.equal(store.get(note.id).data.title, 'Steuerunterlagen 2025');

    // And a compact() must not turn the non-deletion into a real one.
    failing = false;
    await store.compact();
    await store.close();
    store = await openStore({ paths: home, bus: noBus, logger, vaultCrypto });
    assert.ok(store.get(note.id), 'the record must still be there after compaction and reload');
  } finally {
    if (store && !store.closed) await store.close().catch(() => {});
    cleanup();
  }
});


/* --------- Z1: patterns a person actually types must still work --------- */

test('Z1: a pasted URL in the blocklist blocks that host', () => {
  const gate = gateWith({
    network: {
      mode: 'online', strictAllowlist: false,
      blockHosts: ['https://tracker.example.com/beacon', 'http://user:pw@ads.example.com'],
    },
  });
  for (const host of ['tracker.example.com', 'ads.example.com']) {
    const d = gate.check({ host, port: 443, scope: 'global', record: false });
    assert.equal(d.allowed, false, `${host} must be blocked; a list that silently ignores entries is worse than none`);
  }
});

test('Z1: a pasted URL in the allowlist grants that host', () => {
  const gate = gateWith({
    network: { mode: 'online', strictAllowlist: true, allowHosts: ['https://de.wikipedia.org/wiki/Test'] },
  });
  assert.equal(gate.check({ host: 'de.wikipedia.org', port: 443, scope: 'global', record: false }).allowed, true);
  assert.equal(gate.check({ host: 'tracker.example.com', port: 443, scope: 'global', record: false }).allowed, false);
});

/* ------ Z1: the socket layer must see the real target, not a default ----- */

test('Z1: connect() in the array form Node uses internally is checked', () => {
  const net = require('node:net');
  const gate = gateWith({ network: { mode: 'offline' } });
  const hardening = harden(gate, { logger: null });
  try {
    const socket = new net.Socket();
    assert.throws(
      // Node normalises to [options, callback] and calls connect with that array.
      () => socket.connect([{ host: '8.8.8.8', port: 80 }, () => {}]),
      (err) => err.code === 'NETWORK_BLOCKED',
      'the array form must not be read as a connection to localhost',
    );
    socket.destroy();
  } finally {
    hardening.restore();
  }
});

test('Z5: the audit records the real destination, never an invented one', async () => {
  const http = require('node:http');
  const entries = [];
  const config = configMod.defaults();
  const gate = createGate({
    config,
    audit: { write(kind, data) { entries.push({ kind, host: data.host, port: data.port }); } },
    bus: noBus,
    logger: null,
  });
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const hardening = harden(gate, { logger: null });
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
    const network = entries.filter((e) => String(e.kind).startsWith('network.'));
    assert.ok(network.length > 0, 'the request must be audited');
    for (const entry of network) {
      assert.equal(entry.host, '127.0.0.1', `audited host must be the real one, got ${entry.host}`);
      assert.equal(Number(entry.port), port, `audited port must be the real one, got ${entry.port}`);
    }
  } finally {
    hardening.restore();
    await new Promise((r) => server.close(r));
  }
});

module.exports = { name: 'audit-regressions', tests: drain() };
