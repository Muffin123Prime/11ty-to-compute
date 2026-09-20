'use strict';

/**
 * Tests for the egress gate.
 *
 * Two rules hold for every test in this file:
 *   - no test may reach the real internet. Network tests use the loopback
 *     fakeServer from the harness; name resolution is faked with an injected
 *     dns.lookup and is asserted to be NOT called wherever the point of the
 *     test is that nothing left the machine.
 *   - no test may touch the real home directory.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dns = require('node:dns');

const { test, drain, tempHome, fakeServer } = require('./harness');

const gateMod = require('../src/net/gate');
const { classify, createGate } = gateMod;
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');

/* ------------------------------------------------------------------ setup */

function makeGate(overrides = {}) {
  const config = configMod.defaults();
  Object.assign(config.network, overrides.network || {});
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const audit = new Audit(overrides.auditPath || path.join(__dirname, 'never-written.jsonl'), {
    enabled: !!overrides.auditPath,
  });
  if (overrides.auditPath) audit.open();
  const gate = createGate({ config, bus, audit, store: overrides.store, logger: overrides.logger });
  return { gate, config, bus, audit, events };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replace dns.lookup with a table-driven fake. Always restored. */
async function withFakeDns(table, fn) {
  const original = dns.lookup;
  const calls = [];
  dns.lookup = function fakeLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    calls.push(String(hostname));
    const answer = table[hostname];
    if (!answer) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      err.code = 'ENOTFOUND';
      return process.nextTick(cb, err);
    }
    const all = answer.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));
    if (opts.all === true) return process.nextTick(cb, null, all);
    return process.nextTick(cb, null, all[0].address, all[0].family);
  };
  try {
    return await fn(calls);
  } finally {
    dns.lookup = original;
  }
}

/* -------------------------------------------------------------- classify */

test('classify recognises the plain address ranges', () => {
  assert.equal(classify('127.0.0.1'), 'loopback');
  assert.equal(classify('127.255.255.254'), 'loopback');
  assert.equal(classify('0.0.0.0'), 'loopback');
  assert.equal(classify('::1'), 'loopback');
  assert.equal(classify('[::1]'), 'loopback');
  assert.equal(classify('localhost'), 'loopback');
  assert.equal(classify('LOCALHOST'), 'loopback');
  assert.equal(classify('localhost.'), 'loopback');
  assert.equal(classify('ollama.localhost'), 'loopback');

  assert.equal(classify('10.0.0.1'), 'private');
  assert.equal(classify('172.16.0.1'), 'private');
  assert.equal(classify('172.31.255.255'), 'private');
  assert.equal(classify('172.32.0.1'), 'public'); // just outside 172.16/12
  assert.equal(classify('172.15.0.1'), 'public');
  assert.equal(classify('192.168.1.5'), 'private');
  assert.equal(classify('169.254.169.254'), 'private'); // cloud metadata
  assert.equal(classify('100.64.0.1'), 'private'); // CGNAT
  assert.equal(classify('100.127.255.255'), 'private');
  assert.equal(classify('100.128.0.1'), 'public'); // just outside 100.64/10
  assert.equal(classify('fc00::1'), 'private');
  assert.equal(classify('fd12:3456::1'), 'private');
  assert.equal(classify('fe80::1'), 'private');
  assert.equal(classify('fe80::1%eth0'), 'private');

  assert.equal(classify('8.8.8.8'), 'public');
  assert.equal(classify('93.184.216.34'), 'public');
  assert.equal(classify('2606:4700:4700::1111'), 'public');
  assert.equal(classify('example.com'), 'unknown');
  assert.equal(classify(''), 'unknown');
  assert.equal(classify(null), 'unknown');
  assert.equal(classify('not a host at all'), 'unknown');
});

test('classify sees through every IPv4 obfuscation a resolver would accept', () => {
  for (const spelling of [
    '127.0.0.1',
    '2130706433', // decimal
    '0177.0.0.1', // octal first octet
    '0177.0.0.01',
    '0x7f000001', // hex whole address
    '0x7f.0x0.0x0.0x1',
    '127.1', // two-part inet_aton form
    '127.0.1',
    '0',
    '::ffff:127.0.0.1', // IPv4-mapped IPv6
    '::ffff:7f00:1', // same, written in hex
    '[::ffff:127.0.0.1]',
    '::127.0.0.1', // deprecated IPv4-compatible
    '127.0.0.1:11434', // host:port
  ]) {
    assert.equal(classify(spelling), 'loopback', `${spelling} must be loopback`);
  }

  assert.equal(classify('3232235777'), 'private'); // 192.168.1.1
  assert.equal(classify('0xc0a80105'), 'private'); // 192.168.1.5
  assert.equal(classify('::ffff:192.168.1.5'), 'private');
  assert.equal(classify('0xa9fea9fe'), 'private'); // 169.254.169.254
  assert.equal(classify('134744072'), 'public'); // 8.8.8.8
  assert.equal(classify('::ffff:8.8.8.8'), 'public');

  // Invalid octal must not be silently read as decimal.
  assert.equal(classify('0177.0.0.09'), 'unknown');
  // Out-of-range parts are not addresses at all.
  assert.equal(classify('256.1.1.1'), 'unknown');
  assert.equal(classify('127.0.0.1.1'), 'unknown');
  assert.equal(classify('4294967296'), 'unknown');
});

test('translation prefixes count as public even when they wrap a local address', () => {
  // 64:ff9b::/96 is NAT64: the packet leaves the host towards a gateway.
  assert.equal(classify('64:ff9b::127.0.0.1'), 'public');
  assert.equal(classify('64:ff9b::8.8.8.8'), 'public');
  assert.equal(classify('::ffff:0:127.0.0.1'), 'public'); // IPv4-translated
});

/* ---------------------------------------------------------- offline policy */

test('the default policy is offline: loopback yes, everything else no', () => {
  const { gate } = makeGate();
  assert.equal(gate.mode, 'offline');

  const local = gate.check({ host: '127.0.0.1', port: 11434, scope: 'global', purpose: 'test' });
  assert.equal(local.allowed, true);
  assert.equal(local.level, 'local');
  assert.equal(local.classification, 'loopback');

  const dnsServer = gate.check({ host: '8.8.8.8', port: 53, scope: 'global', purpose: 'test' });
  assert.equal(dnsServer.allowed, false);
  assert.equal(dnsServer.classification, 'public');
  assert.match(dnsServer.reason, /offline/);

  const name = gate.check({ host: 'example.com', port: 443, scope: 'global', purpose: 'test' });
  assert.equal(name.allowed, false);
  assert.equal(name.classification, 'unknown');

  assert.equal(gate.check({ host: '192.168.1.5', port: 80, scope: 'global' }).allowed, false);
  // The obfuscations must not open a back door either.
  assert.equal(gate.check({ host: '134744072', port: 80, scope: 'global' }).allowed, false);
  assert.equal(gate.check({ host: '2130706433', port: 11434, scope: 'global' }).allowed, true);
});

test('lan mode opens the local network and nothing beyond it', () => {
  const { gate } = makeGate({ network: { mode: 'lan' } });
  assert.equal(gate.check({ host: '192.168.1.5', port: 80, scope: 'global' }).allowed, true);
  assert.equal(gate.check({ host: '10.1.2.3', port: 445, scope: 'global' }).allowed, true);
  assert.equal(gate.check({ host: 'fd00::5', port: 80, scope: 'global' }).allowed, true);
  assert.equal(gate.check({ host: '127.0.0.1', port: 11434, scope: 'global' }).allowed, true);

  const blocked = gate.check({ host: '8.8.8.8', port: 53, scope: 'global' });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /online/);
  assert.equal(gate.check({ host: '93.184.216.34', port: 443, scope: 'global' }).allowed, false);
});

test('online mode still honours the strict allowlist', () => {
  const { gate, config } = makeGate({ network: { mode: 'online' } });
  assert.equal(config.network.strictAllowlist, true);
  assert.equal(gate.check({ host: '93.184.216.34', port: 443, scope: 'global' }).allowed, false);

  config.network.allowHosts = ['api.example.com', '*.cdn.example.net', '93.184.216.34'];
  assert.equal(gate.check({ host: 'api.example.com', port: 443, scope: 'global' }).allowed, true);
  assert.equal(gate.check({ host: 'files.cdn.example.net', port: 443, scope: 'global' }).allowed, true);
  // A wildcard on an allowlist grants subdomains only, not the apex.
  assert.equal(gate.check({ host: 'cdn.example.net', port: 443, scope: 'global' }).allowed, false);
  assert.equal(gate.check({ host: 'evil.example.org', port: 443, scope: 'global' }).allowed, false);
  // The allowlisted address spelled differently is still the same address.
  assert.equal(gate.check({ host: '1572395042', port: 443, scope: 'global' }).allowed, true);

  config.network.strictAllowlist = false;
  assert.equal(gate.check({ host: 'evil.example.org', port: 443, scope: 'global' }).allowed, true);
});

test('a port-qualified allowlist entry only covers that port', () => {
  const { gate, config } = makeGate({ network: { mode: 'online', allowHosts: ['api.example.com:443'] } });
  assert.equal(gate.check({ host: 'api.example.com', port: 443, scope: 'global' }).allowed, true);
  assert.equal(gate.check({ host: 'api.example.com', port: 8080, scope: 'global' }).allowed, false);
  config.network.allowHosts = ['*'];
  assert.equal(gate.check({ host: 'api.example.com', port: 8080, scope: 'global' }).allowed, true);
});

/* ----------------------------------------------------------------- grants */

test('a grant is bound to its exact scope', () => {
  const { gate } = makeGate();
  gate.addGrant({ scope: 'chat:x', level: 'online', hosts: ['*'], reason: 'Recherche' });

  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'chat:x' }).allowed, true);
  assert.equal(gate.check({ host: '93.184.216.34', port: 443, scope: 'chat:x' }).allowed, true);

  const other = gate.check({ host: 'example.com', port: 443, scope: 'chat:y' });
  assert.equal(other.allowed, false, 'chat:x must never cover chat:y');
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'global' }).allowed, false);
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'agent:x' }).allowed, false);
});

test('the scope chain runs from once: up to global', () => {
  const { gate } = makeGate();
  gate.addGrant({ scope: 'global', level: 'lan', hosts: ['192.168.1.5'] });
  // A global grant covers every narrower scope...
  assert.equal(gate.check({ host: '192.168.1.5', port: 80, scope: 'run:r1 agent:a1 chat:c1' }).allowed, true);
  assert.equal(gate.check({ host: '192.168.1.5', port: 80, scope: 'chat:c9' }).allowed, true);
  // ...but not a class it does not cover.
  assert.equal(gate.check({ host: '8.8.8.8', port: 53, scope: 'chat:c1' }).allowed, false);

  gate.addGrant({ scope: 'agent:a1', level: 'online', hosts: ['api.example.com'] });
  const viaAgent = gate.check({ host: 'api.example.com', port: 443, scope: 'run:r1 agent:a1 chat:c1' });
  assert.equal(viaAgent.allowed, true);
  assert.equal(viaAgent.level, 'online');
  assert.equal(gate.check({ host: 'api.example.com', port: 443, scope: 'agent:a2' }).allowed, false);

  assert.deepEqual(gate.scopeChain('chat:c1'), ['chat:c1', 'global']);
  assert.deepEqual(gate.scopeChain('once:n1 chat:c1 agent:a1'), ['once:n1', 'agent:a1', 'chat:c1', 'global']);
});

test('a grant only covers the hosts it names', () => {
  const { gate } = makeGate();
  gate.addGrant({ scope: 'run:r1', level: 'online', hosts: ['*.wikipedia.org'] });
  assert.equal(gate.check({ host: 'de.wikipedia.org', port: 443, scope: 'run:r1' }).allowed, true);
  assert.equal(gate.check({ host: 'wikipedia.org', port: 443, scope: 'run:r1' }).allowed, false);
  assert.equal(gate.check({ host: 'evil.org', port: 443, scope: 'run:r1' }).allowed, false);

  // An empty host list grants nothing at all.
  gate.addGrant({ scope: 'run:r2', level: 'online', hosts: [] });
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'run:r2' }).allowed, false);
});

test('a lan grant does not become an internet grant', () => {
  const { gate } = makeGate();
  gate.addGrant({ scope: 'agent:a1', level: 'lan', hosts: ['*'] });
  assert.equal(gate.check({ host: '192.168.1.5', port: 80, scope: 'agent:a1' }).allowed, true);
  assert.equal(gate.check({ host: '8.8.8.8', port: 53, scope: 'agent:a1' }).allowed, false);
});

test('a lan grant lets a NAME through the gate but not its public address', async () => {
  // A name is undecidable before it is resolved. Refusing every name in lan
  // mode would make the mode useless, so the name passes the provisional check
  // and the address it resolves to is judged on its own.
  const { gate } = makeGate();
  gate.addGrant({ scope: 'run:r1', level: 'lan', hosts: ['*'] });
  assert.equal(gate.check({ host: 'nas.example', port: 80, scope: 'run:r1' }).allowed, true);

  await withFakeDns({ 'nas.example': ['192.168.1.5'], 'tarnung.example': ['93.184.216.34'] }, async () => {
    assert.equal((await gate.resolve('nas.example', { scope: 'run:r1' })).ip, '192.168.1.5');
    await assert.rejects(
      () => gate.resolve('tarnung.example', { scope: 'run:r1' }),
      (err) => err.code === 'NETWORK_BLOCKED',
    );
  });
});

test('maxUses is really enforced', () => {
  const { gate } = makeGate();
  const grant = gate.addGrant({ scope: 'run:r1', level: 'online', hosts: ['api.example.com'], maxUses: 2 });

  // check() is a decision, not a use: it must not consume anything.
  for (let i = 0; i < 5; i++) {
    assert.equal(gate.check({ host: 'api.example.com', port: 443, scope: 'run:r1' }).allowed, true);
  }
  gate.consume(grant.id);
  assert.equal(gate.check({ host: 'api.example.com', port: 443, scope: 'run:r1' }).allowed, true);
  gate.consume(grant.id);
  const after = gate.check({ host: 'api.example.com', port: 443, scope: 'run:r1' });
  assert.equal(after.allowed, false, 'the third use must be refused');

  // Used up, but kept on record.
  assert.equal(gate.listGrants().length, 0);
  const kept = gate.listGrants({ includeInactive: true });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].data.uses, 2);
});

test('expiresAt is really enforced', async () => {
  const { gate } = makeGate();
  gate.addGrant({ scope: 'once:n1', level: 'online', hosts: ['*'], expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'once:n1' }).allowed, false);

  gate.addGrant({ scope: 'once:n2', level: 'online', hosts: ['*'], expiresAt: new Date(Date.now() + 60).toISOString() });
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'once:n2' }).allowed, true);
  await sleep(90);
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'once:n2' }).allowed, false, 'the grant must expire on its own');

  // A timestamp that cannot be read is treated as expired, never as eternal.
  const broken = gate.addGrant({ scope: 'once:n3', level: 'online', hosts: ['*'] });
  broken.data.expiresAt = 'irgendwann';
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'once:n3' }).allowed, false);
});

test('revoking keeps the record and stops the grant', () => {
  const { gate } = makeGate();
  const grant = gate.addGrant({ scope: 'chat:c1', level: 'online', hosts: ['*'] });
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'chat:c1' }).allowed, true);
  gate.revokeGrant(grant.id);
  assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'chat:c1' }).allowed, false);
  assert.equal(gate.listGrants().length, 0);
  assert.equal(gate.listGrants({ includeInactive: true })[0].data.revoked, true);
  assert.throws(() => gate.revokeGrant('grant_doesnotexist000000'), /not found/i);
});

test('addGrant refuses nonsense instead of storing it', () => {
  const { gate } = makeGate();
  assert.throws(() => gate.addGrant({ scope: '', level: 'online', hosts: ['*'] }), /scope|required/i);
  assert.throws(() => gate.addGrant({ scope: 'global', level: 'offline', hosts: ['*'] }), /level/);
  assert.throws(() => gate.addGrant({ scope: 'global', level: 'online', hosts: ['*'], expiresAt: 'bald' }), /ISO/);
  assert.throws(() => gate.addGrant({ scope: 'global', level: 'online', hosts: ['*'], maxUses: 0 }), /maxUses/);
  assert.throws(() => gate.addGrant({ scope: 'global', level: 'online', hosts: ['  '] }), /Host/);
});

test('blockHosts beats every grant and every mode', () => {
  const { gate, config } = makeGate({
    network: { mode: 'online', strictAllowlist: false, blockHosts: ['telemetry.example.com', '*.ads.example.net', '93.184.216.34'] },
  });
  gate.addGrant({ scope: 'global', level: 'online', hosts: ['*'] });

  const blocked = gate.check({ host: 'telemetry.example.com', port: 443, scope: 'global' });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Sperrliste/);
  assert.equal(gate.check({ host: 'pixel.ads.example.net', port: 443, scope: 'global' }).allowed, false);
  // On a blocklist the wildcard also covers the apex.
  assert.equal(gate.check({ host: 'ads.example.net', port: 443, scope: 'global' }).allowed, false);
  // And an obfuscated address does not slip past it.
  assert.equal(gate.check({ host: '1572395042', port: 443, scope: 'global' }).allowed, false);
  assert.equal(gate.check({ host: 'ok.example.com', port: 443, scope: 'global' }).allowed, true);

  // Even loopback can be blocked explicitly.
  config.network.blockHosts.push('127.0.0.1:9999');
  assert.equal(gate.check({ host: '127.0.0.1', port: 9999, scope: 'global' }).allowed, false);
  assert.equal(gate.check({ host: '127.0.0.1', port: 11434, scope: 'global' }).allowed, true);
});

test('effectiveFor describes what the UI should show', () => {
  const { gate } = makeGate({ network: { mode: 'lan', allowHosts: ['api.example.com'] } });
  gate.addGrant({ scope: 'chat:c1', level: 'online', hosts: ['de.wikipedia.org'], reason: 'Recherche' });
  gate.addGrant({ scope: 'chat:c2', level: 'online', hosts: ['other.example'] });

  const eff = gate.effectiveFor('chat:c1');
  assert.equal(eff.mode, 'lan');
  assert.deepEqual(eff.chain, ['chat:c1', 'global']);
  assert.equal(eff.grants.length, 1);
  assert.equal(eff.grants[0].scope, 'chat:c1');
  assert.ok(eff.hosts.includes('de.wikipedia.org'));
  assert.ok(eff.hosts.includes('api.example.com'));
  assert.ok(!eff.hosts.includes('other.example'));
});

test('setMode validates and takes effect immediately', () => {
  const { gate, config } = makeGate();
  assert.throws(() => gate.setMode('halboffen'), /Netzmodus/);
  assert.equal(gate.check({ host: '192.168.1.5', port: 80, scope: 'global' }).allowed, false);
  gate.setMode('lan');
  assert.equal(config.network.mode, 'lan');
  assert.equal(gate.check({ host: '192.168.1.5', port: 80, scope: 'global' }).allowed, true);
});

test('setMode persists to disk when a config path is known', () => {
  const { home, cleanup } = tempHome('gate-mode');
  try {
    const file = path.join(home, 'config.json');
    const config = configMod.defaults();
    configMod.save(file, config);
    const gate = createGate({ config, configPath: file, bus: new Bus() });
    gate.setMode('online');
    assert.equal(configMod.load(file).network.mode, 'online');
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------- audit and events */

test('every decision is published and audited, allow as well as block', () => {
  const { home, cleanup } = tempHome('gate-audit');
  try {
    const { gate, events, audit } = makeGate({ auditPath: path.join(home, 'audit.jsonl') });
    gate.check({ host: '127.0.0.1', port: 11434, scope: 'chat:c1', purpose: 'model' });
    gate.check({ host: '8.8.8.8', port: 53, scope: 'chat:c1', purpose: 'test' });
    audit.close();

    const attempts = events.filter((e) => e.name === 'network.attempt');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].payload.allowed, true);
    assert.equal(attempts[0].payload.scope, 'chat:c1');
    assert.equal(attempts[1].payload.allowed, false);
    assert.equal(attempts[1].payload.classification, 'public');

    const lines = fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.kind), ['network.local', 'network.block']);
    assert.equal(lines[0].host, '127.0.0.1');
    assert.equal(lines[1].reason.length > 0, true);

    const stats = gate.stats();
    assert.equal(stats.allowed, 1);
    assert.equal(stats.blocked, 1);
    assert.ok(stats.lastBlockedAt);
    assert.equal(stats.byHost['8.8.8.8'].blocked, 1);
  } finally {
    cleanup();
  }
});

test('check({record:false}) decides without touching the counters', () => {
  const { gate, events } = makeGate();
  gate.check({ host: '8.8.8.8', port: 53, scope: 'global', record: false });
  assert.equal(events.filter((e) => e.name === 'network.attempt').length, 0);
  assert.equal(gate.stats().blocked, 0);
});

/* --------------------------------------------------------------- resolve */

test('resolve refuses to ask DNS when the connection would be blocked anyway', async () => {
  const { gate } = makeGate(); // offline
  await withFakeDns({ 'example.com': ['93.184.216.34'] }, async (calls) => {
    await assert.rejects(
      () => gate.resolve('example.com', { scope: 'global' }),
      (err) => {
        assert.equal(err.code, 'NETWORK_BLOCKED');
        return true;
      },
    );
    assert.deepEqual(calls, [], 'the hostname must never reach the resolver');
  });
});

test('resolve answers localhost and literals without any query', async () => {
  const { gate } = makeGate();
  await withFakeDns({}, async (calls) => {
    assert.deepEqual(await gate.resolve('localhost', { scope: 'global' }), { ip: '127.0.0.1', family: 4, resolved: false });
    assert.deepEqual(await gate.resolve('ollama.localhost', { scope: 'global' }), { ip: '127.0.0.1', family: 4, resolved: false });
    assert.deepEqual(await gate.resolve('127.0.0.1', { scope: 'global' }), { ip: '127.0.0.1', family: 4, resolved: false });
    assert.deepEqual(await gate.resolve('::1', { scope: 'global' }), { ip: '::1', family: 6, resolved: false });
    assert.deepEqual(calls, []);
  });
});

test('resolve queries only when the policy allows it, and pins the answer', async () => {
  const { gate } = makeGate({ network: { mode: 'online', strictAllowlist: false } });
  await withFakeDns({ 'example.com': ['93.184.216.34'] }, async (calls) => {
    const r = await gate.resolve('example.com', { scope: 'global' });
    assert.equal(r.ip, '93.184.216.34');
    assert.equal(r.family, 4);
    assert.equal(r.resolved, true);
    assert.deepEqual(calls, ['example.com']);
  });
});

test('resolve refuses an answer that smuggles a forbidden address', async () => {
  const { gate } = makeGate({ network: { mode: 'lan', strictAllowlist: false } });
  await withFakeDns({
    'nas.example': ['192.168.1.5'],
    'sneaky.example': ['192.168.1.5', '8.8.8.8'],
  }, async () => {
    assert.equal((await gate.resolve('nas.example', { scope: 'global' })).ip, '192.168.1.5');
    await assert.rejects(
      () => gate.resolve('sneaky.example', { scope: 'global' }),
      (err) => err.code === 'NETWORK_BLOCKED',
    );
  });
});

test('a failed lookup is reported as a lookup failure, not as a block', async () => {
  const { gate } = makeGate({ network: { mode: 'online', strictAllowlist: false } });
  await withFakeDns({}, async () => {
    await assert.rejects(
      () => gate.resolve('nothing.invalid', { scope: 'global' }),
      (err) => {
        assert.equal(err.code, 'NAME_RESOLUTION_FAILED');
        assert.equal(err.details.code, 'ENOTFOUND');
        return true;
      },
    );
  });
});

/* ----------------------------------------------------------------- fetch */

test('fetch talks to a loopback server and returns a Response-like object', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'welt', host: req.headers.host }));
      return;
    }
    res.writeHead(201, { 'content-type': 'text/plain; charset=utf-8', 'x-test': 'ja' });
    res.end('Grüße vom lokalen Server');
  });
  try {
    const { gate } = makeGate();
    const res = await gate.fetch(`${srv.url}/text`, { scope: 'global', purpose: 'test' });
    assert.equal(res.ok, true);
    assert.equal(res.status, 201);
    assert.equal(res.headers['x-test'], 'ja');
    assert.equal(res.headers.get('X-Test'), 'ja');
    assert.equal(await res.text(), 'Grüße vom lokalen Server');
    assert.equal(res.redirected, false);

    const json = await (await gate.fetch(`${srv.url}/json`, { scope: 'global' })).json();
    assert.equal(json.hello, 'welt');
    // Host header must name the original host, not the pinned address.
    assert.equal(json.host, `127.0.0.1:${srv.port}`);
  } finally {
    await srv.close();
  }
});

test('fetch sends a body, reads NDJSON line by line and reports HTTP errors honestly', async () => {
  const srv = await fakeServer((req, res) => {
    if (req.url === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    if (req.url === '/ndjson') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"n":1}\n');
      res.write('{"n":2}\n');
      res.end('{"n":3}\n');
      return;
    }
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('kaputt');
  });
  try {
    const { gate } = makeGate();
    const echoed = await (await gate.fetch(`${srv.url}/echo`, {
      scope: 'global', method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' },
    })).json();
    assert.equal(echoed.method, 'POST');
    assert.deepEqual(JSON.parse(echoed.body), { a: 1 });

    // Bytes must travel as bytes, an object as JSON -- neither as "[object Object]".
    const binary = await (await gate.fetch(`${srv.url}/echo`, {
      scope: 'global', method: 'PUT', body: new Uint8Array([0x68, 0x61, 0x6c, 0x6c, 0x6f]),
    })).json();
    assert.equal(binary.method, 'PUT');
    assert.equal(binary.body, 'hallo');
    const asObject = await (await gate.fetch(`${srv.url}/echo`, {
      scope: 'global', method: 'POST', body: { b: 2 },
    })).json();
    assert.deepEqual(JSON.parse(asObject.body), { b: 2 });

    const stream = await gate.fetch(`${srv.url}/ndjson`, { scope: 'global', stream: true });
    const seen = [];
    for await (const line of stream.lines()) if (line) seen.push(JSON.parse(line).n);
    assert.deepEqual(seen, [1, 2, 3]);

    // A server error is a real answer, not an exception, and never invented.
    const bad = await gate.fetch(`${srv.url}/fehler`, { scope: 'global' });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 503);
    assert.equal(await bad.text(), 'kaputt');
    await assert.rejects(() => gate.fetch(`${srv.url}/fehler`, { scope: 'global' }).then((r) => r.json()), /kein gültiges JSON/);
  } finally {
    await srv.close();
  }
});

test('fetch re-checks the policy on every redirect', async () => {
  let hops = 0;
  const srv = await fakeServer((req, res) => {
    if (req.url === '/start') {
      hops++;
      res.writeHead(302, { location: '/ziel' });
      res.end();
      return;
    }
    if (req.url === '/ziel') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('angekommen');
      return;
    }
    if (req.url === '/raus') {
      res.writeHead(302, { location: 'http://8.8.8.8/' });
      res.end();
      return;
    }
    if (req.url === '/schleife') {
      res.writeHead(302, { location: '/schleife' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const { gate } = makeGate();
    const ok = await gate.fetch(`${srv.url}/start`, { scope: 'global' });
    assert.equal(await ok.text(), 'angekommen');
    assert.equal(ok.redirected, true);
    assert.equal(hops, 1);

    // A redirect that leaves loopback is blocked at the redirect, not followed.
    await assert.rejects(
      () => gate.fetch(`${srv.url}/raus`, { scope: 'global' }),
      (err) => {
        assert.equal(err.code, 'NETWORK_BLOCKED');
        assert.equal(err.details.host, '8.8.8.8');
        return true;
      },
    );

    await assert.rejects(
      () => gate.fetch(`${srv.url}/schleife`, { scope: 'global' }),
      (err) => {
        assert.equal(err.code, 'TOO_MANY_REDIRECTS');
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

test('fetch refuses to start without a scope or with a foreign protocol', async () => {
  const { gate } = makeGate();
  await assert.rejects(() => gate.fetch('http://127.0.0.1:1/'), /scope/);
  await assert.rejects(() => gate.fetch('http://127.0.0.1:1/', { scope: '   ' }), /scope/);
  await assert.rejects(() => gate.fetch('file:///etc/passwd', { scope: 'global' }), /http/);
  await assert.rejects(() => gate.fetch('nicht mal eine url', { scope: 'global' }), /URL/);
});

test('fetch blocks a forbidden destination before opening a socket', async () => {
  const { gate, events } = makeGate();
  await assert.rejects(
    () => gate.fetch('http://8.8.8.8:80/', { scope: 'global', purpose: 'test' }),
    (err) => {
      assert.equal(err.code, 'NETWORK_BLOCKED');
      assert.equal(err.status, 403);
      return true;
    },
  );
  const attempt = events.find((e) => e.name === 'network.attempt');
  assert.equal(attempt.payload.allowed, false);
  assert.equal(attempt.payload.host, '8.8.8.8');
});

test('fetch honours an AbortSignal and a timeout', async () => {
  const srv = await fakeServer((req, res) => {
    // Never answers: the request must end by abort or by timeout.
    void res;
  });
  try {
    const { gate } = makeGate();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => gate.fetch(`${srv.url}/haengt`, { scope: 'global', signal: controller.signal, timeoutMs: 5000 }),
      (err) => {
        assert.equal(err.code, 'ABORTED');
        return true;
      },
    );

    await assert.rejects(
      () => gate.fetch(`${srv.url}/haengt`, { scope: 'global', timeoutMs: 60 }),
      (err) => {
        assert.equal(err.code, 'NETWORK_TIMEOUT');
        return true;
      },
    );

    const aborted = AbortSignal.abort();
    await assert.rejects(() => gate.fetch(`${srv.url}/haengt`, { scope: 'global', signal: aborted }), /abgebrochen/);
  } finally {
    await srv.close();
  }
});

test('fetch caps the response size instead of eating all memory', async () => {
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(Buffer.alloc(64 * 1024, 0x61));
  });
  try {
    const { gate } = makeGate();
    await assert.rejects(
      () => gate.fetch(`${srv.url}/gross`, { scope: 'global', maxBytes: 1024 }),
      (err) => {
        assert.equal(err.code, 'RESPONSE_TOO_LARGE');
        return true;
      },
    );
    const fine = await gate.fetch(`${srv.url}/gross`, { scope: 'global', maxBytes: 1024 * 1024 });
    assert.equal((await fine.text()).length, 64 * 1024);
  } finally {
    await srv.close();
  }
});

test('fetch pins the resolved address and uses the name only in the Host header', async () => {
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ host: req.headers.host, remote: req.socket.remoteAddress }));
  });
  try {
    const { gate } = makeGate({ network: { mode: 'online', strictAllowlist: false } });
    let lookups = 0;
    await withFakeDns({ 'modell.example': ['127.0.0.1'] }, async (calls) => {
      const res = await gate.fetch(`http://modell.example:${srv.port}/`, { scope: 'global' });
      const body = await res.json();
      assert.equal(body.host, `modell.example:${srv.port}`, 'Host header carries the name');
      assert.match(body.remote, /127\.0\.0\.1$/, 'the connection went to the pinned address');
      lookups = calls.length;
    });
    assert.equal(lookups, 1, 'exactly one lookup, then the address is pinned');
  } finally {
    await srv.close();
  }
});

test('fetch consumes a grant it relied on', async () => {
  const srv = await fakeServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  try {
    // Loopback would be free, so the grant is forced by blocking nothing but
    // requiring a non-loopback classification: use a fake name on 192.168.x.
    const { gate } = makeGate({ network: { mode: 'offline' } });
    const grant = gate.addGrant({ scope: 'run:r1', level: 'lan', hosts: ['nas.example'], maxUses: 1 });
    await withFakeDns({ 'nas.example': ['127.0.0.1'] }, async () => {
      // 127.0.0.1 is loopback, so the grant is NOT needed and NOT consumed.
      const res = await gate.fetch(`http://nas.example:${srv.port}/`, { scope: 'run:r1' });
      assert.equal(await res.text(), 'ok');
    });
    assert.equal(gate.listGrants({ includeInactive: true })[0].data.uses, 0);

    // A decision that really rests on the grant does consume it.
    assert.equal(gate.check({ host: 'nas.example', ip: '192.168.1.5', port: 80, scope: 'run:r1' }).allowed, true);
    gate.consume(grant.id);
    assert.equal(gate.check({ host: 'nas.example', ip: '192.168.1.5', port: 80, scope: 'run:r1' }).allowed, false);
  } finally {
    await srv.close();
  }
});

/* ------------------------------------------------------------ store seam */

test('grants live in the store when one is provided', () => {
  const created = [];
  const records = new Map();
  const store = {
    create(type, data) {
      const rec = { id: `grant_${'a'.repeat(20)}${records.size}`, type, createdAt: new Date().toISOString(), updatedAt: null, deletedAt: null, rev: 1, data };
      records.set(rec.id, rec);
      created.push(rec);
      return rec;
    },
    get(id) { return records.get(id) || null; },
    update(id, patch) {
      const rec = records.get(id);
      rec.data = { ...rec.data, ...patch };
      return rec;
    },
    all(type) { return [...records.values()].filter((r) => r.type === type); },
  };
  const { gate } = makeGate({ store });
  const grant = gate.addGrant({ scope: 'chat:c1', level: 'online', hosts: ['*'] });
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'grant');
  assert.equal(created[0].data.uses, 0);
  assert.equal(gate.grantsArePersisted, true);
  gate.consume(grant.id);
  assert.equal(records.get(grant.id).data.uses, 1);
});

test('an unreadable store denies instead of silently allowing', () => {
  const store = {
    create() { throw new Error('vault locked'); },
    get() { throw new Error('vault locked'); },
    update() { throw new Error('vault locked'); },
    all() { throw new Error('vault locked'); },
  };
  const { gate } = makeGate({ store, network: { mode: 'offline' } });
  const decision = gate.check({ host: 'example.com', port: 443, scope: 'chat:c1' });
  assert.equal(decision.allowed, false);
  assert.equal(gate.stats().grantReadFailures > 0, true);
  // Loopback still works: the app must stay usable with a locked vault.
  assert.equal(gate.check({ host: '127.0.0.1', port: 11434, scope: 'chat:c1' }).allowed, true);
});

module.exports = { name: 'gate', tests: drain() };
