'use strict';

/**
 * Tests for the process-level enforcement.
 *
 * Every test installs the patches inside a try/finally and removes them again:
 * a leaked patch would silently change the behaviour of every test file that
 * runs after this one.
 *
 * Nothing here may reach the internet. The blocked cases are proven by the
 * patch throwing BEFORE a socket exists, the allowed cases run against the
 * loopback fakeServer from the harness.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const path = require('node:path');

const { test, drain, tempHome, fakeServer } = require('./harness');

const { createGate } = require('../src/net/gate');
const { harden, SCOPE } = require('../src/net/harden');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');

function makeGate(networkOverrides = {}) {
  const config = configMod.defaults();
  Object.assign(config.network, networkOverrides);
  const bus = new Bus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const audit = new Audit(path.join(__dirname, 'never-written.jsonl'), { enabled: false });
  return { gate: createGate({ config, bus, audit }), config, events };
}

/** Install the patches, run the body, always restore. */
async function hardened(networkOverrides, fn, hardenOpts = {}) {
  const ctx = makeGate(networkOverrides);
  const handle = harden(ctx.gate, { ...hardenOpts });
  try {
    return await fn({ ...ctx, handle });
  } finally {
    handle.restore();
  }
}

function blocked(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

/* ------------------------------------------------------------ http / https */

test('after harden a direct http.get to a public address fails', async () => {
  await hardened({}, async ({ handle }) => {
    for (const call of [
      () => http.get('http://8.8.8.8/'),
      () => http.get({ host: '8.8.8.8', port: 80, path: '/' }),
      () => http.request({ hostname: '8.8.8.8', port: 80 }),
      () => https.get('https://example.com/'),
      () => https.request('https://93.184.216.34/'),
      () => http.get('http://2130706433.nip.io/'), // a name, still unknown
    ]) {
      const err = blocked(call);
      assert.ok(err, 'the call must not go through');
      assert.equal(err.code, 'NETWORK_BLOCKED');
      assert.equal(err.status, 403);
    }
    assert.ok(handle.stats().blocked >= 6);
  });
});

test('after harden loopback still works end to end', async () => {
  // The server is created AFTER hardening on purpose: listen() must not break.
  await hardened({}, async () => {
    const srv = await fakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('lokal erreichbar');
    });
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.get(`${srv.url}/`, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve(buf));
        });
        req.on('error', reject);
      });
      assert.equal(body, 'lokal erreichbar');
    } finally {
      await srv.close();
    }
  });
});

test('the live policy decides: a blocked loopback port is blocked too', async () => {
  const srv = await fakeServer((req, res) => res.end('x'));
  try {
    await hardened({ blockHosts: [`127.0.0.1:${srv.port}`] }, async () => {
      const err = blocked(() => http.get(`${srv.url}/`));
      assert.ok(err);
      assert.equal(err.code, 'NETWORK_BLOCKED');
      assert.match(err.message, /Sperrliste/);
    });
  } finally {
    await srv.close();
  }
});

/* ----------------------------------------------------------------- sockets */

test('raw sockets are covered in every calling convention', async () => {
  await hardened({}, async () => {
    for (const call of [
      () => net.connect({ host: '8.8.8.8', port: 80 }),
      () => net.connect(80, '8.8.8.8'),
      () => net.createConnection({ host: '1.1.1.1', port: 443 }),
      () => new net.Socket().connect({ host: '8.8.8.8', port: 80 }),
      () => new net.Socket().connect(80, '8.8.8.8'),
      () => tls.connect({ host: '8.8.8.8', port: 443 }),
      () => tls.connect(443, '8.8.8.8'),
    ]) {
      const err = blocked(call);
      assert.ok(err, 'the socket must not be opened');
      assert.equal(err.code, 'NETWORK_BLOCKED');
    }
  });
});

test('a loopback socket and a unix socket stay open for business', async () => {
  const { home, cleanup } = tempHome('harden-unix');
  try {
    const socketPath = path.join(home, 'test.sock');
    const unixServer = net.createServer((socket) => socket.end('unix'));
    await new Promise((resolve) => unixServer.listen(socketPath, resolve));
    const tcpServer = net.createServer((socket) => socket.end('tcp'));
    await new Promise((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
    const tcpPort = tcpServer.address().port;

    try {
      await hardened({}, async () => {
        const read = (socket) => new Promise((resolve, reject) => {
          let buf = '';
          socket.setEncoding('utf8');
          socket.on('data', (c) => { buf += c; });
          socket.on('end', () => resolve(buf));
          socket.on('error', reject);
        });
        assert.equal(await read(net.connect(socketPath)), 'unix');
        assert.equal(await read(net.connect({ path: socketPath })), 'unix');
        assert.equal(await read(net.connect(tcpPort, '127.0.0.1')), 'tcp');
      });
    } finally {
      await new Promise((r) => unixServer.close(r));
      await new Promise((r) => tcpServer.close(r));
    }
  } finally {
    cleanup();
  }
});

/* --------------------------------------------------------------------- dns */

test('a blocked lookup never reaches the resolver', async () => {
  // The spy is installed first, so harden() wraps it; if the patch ever
  // delegated, the spy would record the hostname.
  const original = dns.lookup;
  const seen = [];
  dns.lookup = function spyLookup(hostname, options, callback) {
    seen.push(String(hostname));
    const cb = typeof options === 'function' ? options : callback;
    const err = new Error('der Test hätte hier eine echte Anfrage gestellt');
    err.code = 'ENOTFOUND';
    return process.nextTick(cb, err);
  };
  try {
    await hardened({}, async () => {
      const err = await new Promise((resolve) => dns.lookup('geheim.example.com', (e) => resolve(e)));
      assert.ok(err);
      assert.equal(err.code, 'NETWORK_BLOCKED');
      assert.deepEqual(seen, [], 'the hostname must not reach the resolver');

      // localhost is answered from RFC 6761 knowledge, not by asking anyone.
      const local = await new Promise((resolve, reject) => {
        dns.lookup('localhost', (e, address, family) => (e ? reject(e) : resolve({ address, family })));
      });
      assert.deepEqual(local, { address: '127.0.0.1', family: 4 });
      const sub = await new Promise((resolve, reject) => {
        dns.lookup('ollama.localhost', { all: true }, (e, addresses) => (e ? reject(e) : resolve(addresses)));
      });
      assert.deepEqual(sub, [{ address: '127.0.0.1', family: 4 }]);
      assert.deepEqual(seen, []);
    });
  } finally {
    dns.lookup = original;
  }
});

test('the promise and resolver DNS APIs are covered as well', async () => {
  await hardened({}, async () => {
    await assert.rejects(() => dns.promises.lookup('geheim.example.com'), (err) => {
      assert.equal(err.code, 'NETWORK_BLOCKED');
      return true;
    });
    assert.deepEqual(await dns.promises.lookup('localhost'), { address: '127.0.0.1', family: 4 });

    const err = await new Promise((resolve) => dns.resolve4('geheim.example.com', (e) => resolve(e)));
    assert.equal(err.code, 'NETWORK_BLOCKED');
    await assert.rejects(() => dns.promises.resolveTxt('geheim.example.com'), (e) => e.code === 'NETWORK_BLOCKED');
    await assert.rejects(() => new dns.promises.Resolver().resolve4('geheim.example.com'), (e) => e.code === 'NETWORK_BLOCKED');
    const viaResolver = await new Promise((resolve) => new dns.Resolver().resolve('geheim.example.com', (e) => resolve(e)));
    assert.equal(viaResolver.code, 'NETWORK_BLOCKED');
  });
});

/* ------------------------------------------------------------ global fetch */

test('the global fetch is routed through the gate', async () => {
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pfad: req.url }));
  });
  try {
    await hardened({}, async () => {
      await assert.rejects(() => globalThis.fetch('http://8.8.8.8/'), (err) => {
        assert.equal(err.code, 'NETWORK_BLOCKED');
        return true;
      });
      await assert.rejects(() => globalThis.fetch('nicht mal eine url'), (err) => err.code === 'NETWORK_BLOCKED');

      const res = await globalThis.fetch(`${srv.url}/lokal`);
      assert.equal(res.ok, true);
      assert.deepEqual(await res.json(), { pfad: '/lokal' });
    });
  } finally {
    await srv.close();
  }
});

/* ------------------------------------------------- the gate's own traffic */

test('the gate is not blocked by its own patch', async () => {
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('durchgelassen');
  });
  try {
    const ctx = makeGate();
    const handle = harden(ctx.gate, {});
    try {
      const res = await ctx.gate.fetch(`${srv.url}/`, { scope: 'global', purpose: 'test' });
      assert.equal(await res.text(), 'durchgelassen');
      // The internal marker must not have been used as a general escape: the
      // policy still applies to the gate's own destinations.
      await assert.rejects(() => ctx.gate.fetch('http://8.8.8.8/', { scope: 'global' }), (err) => err.code === 'NETWORK_BLOCKED');
      assert.ok(handle.stats().passthrough > 0, 'internal calls must be recognised as internal');
    } finally {
      handle.restore();
    }
  } finally {
    await srv.close();
  }
});

/* ------------------------------------------------------------ scope tagging */

test('a scope tag on the options attributes the call to its run', async () => {
  // Again a spy instead of a real request: what is under test is which scope
  // the patch asks the gate about, not whether 93.184.216.34 answers.
  const original = http.request;
  const calls = [];
  http.request = function spyRequest(...args) {
    calls.push(args[0]);
    return { on() { return this; }, end() { return this; }, destroy() {} };
  };
  try {
    await hardened({}, async ({ gate, events }) => {
      gate.addGrant({ scope: 'run:r1', level: 'online', hosts: ['*'] });

      const tagged = { host: '93.184.216.34', port: 80, path: '/' };
      tagged[SCOPE] = 'run:r1';
      assert.equal(blocked(() => http.request(tagged)), null, "the run's grant must apply");
      assert.equal(calls.length, 1);
      assert.equal(events.filter((e) => e.name === 'network.attempt').pop().payload.scope, 'run:r1');

      // The same destination without the tag falls back to the global scope,
      // where no grant exists.
      const err = blocked(() => http.request({ host: '93.184.216.34', port: 80, path: '/' }));
      assert.ok(err);
      assert.equal(err.code, 'NETWORK_BLOCKED');
      assert.equal(calls.length, 1, 'the untagged call never reached the original');
      assert.equal(events.filter((e) => e.name === 'network.attempt').pop().payload.scope, 'global');
    });
  } finally {
    http.request = original;
  }
});

test('allowUnscoped turns enforcement into observation and is off by default', async () => {
  // A spy stands in for the real http.request: with allowUnscoped the patch
  // must delegate to it, and this way the test proves that without ever
  // letting a packet towards 8.8.8.8 leave the machine.
  const original = http.request;
  const calls = [];
  http.request = function spyRequest(...args) {
    calls.push(args[0]);
    return { on() { return this; }, end() { return this; }, destroy() {} };
  };
  try {
    await hardened({}, async ({ handle }) => {
      const err = blocked(() => http.request({ host: '8.8.8.8', port: 80, path: '/' }));
      assert.equal(err, null, 'with allowUnscoped the gate only watches');
      assert.equal(calls.length, 1, 'the call was passed through to the original');
      const stats = handle.stats();
      assert.equal(stats.allowUnscoped, true);
      assert.ok(stats.unscoped > 0);
      assert.equal(stats.blocked, 0);
    }, { allowUnscoped: true });

    calls.length = 0;
    await hardened({}, async ({ handle }) => {
      const err = blocked(() => http.request({ host: '8.8.8.8', port: 80, path: '/' }));
      assert.ok(err, 'the default must enforce');
      assert.equal(err.code, 'NETWORK_BLOCKED');
      assert.deepEqual(calls, [], 'nothing reached the real http.request');
      assert.equal(handle.stats().allowUnscoped, false);
      assert.equal(handle.stats().blocked, 1);
    });
  } finally {
    http.request = original;
  }
});

/* ----------------------------------------------------------------- restore */

test('restore puts every original function back', async () => {
  const before = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    socketConnect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    dnsLookup: dns.lookup,
    dnsPromisesLookup: dns.promises.lookup,
    dnsResolve4: dns.resolve4,
  };
  const { gate } = makeGate();
  const handle = harden(gate, {});
  assert.notEqual(http.get, before.httpGet, 'harden must actually patch');
  assert.ok(handle.stats().patched.includes('http.get'));
  assert.equal(handle.stats().active, true);

  handle.restore();
  for (const [name, fn] of Object.entries(before)) {
    const current = {
      fetch: globalThis.fetch,
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
      netConnect: net.connect,
      netCreateConnection: net.createConnection,
      socketConnect: net.Socket.prototype.connect,
      tlsConnect: tls.connect,
      dnsLookup: dns.lookup,
      dnsPromisesLookup: dns.promises.lookup,
      dnsResolve4: dns.resolve4,
    }[name];
    assert.equal(current, fn, `${name} was not restored`);
  }
  assert.equal(handle.stats().active, false);
  handle.restore(); // idempotent
});

test('hardening twice does not stack wrappers', async () => {
  const { gate } = makeGate();
  const first = harden(gate, {});
  const patchedGet = http.get;
  const second = harden(gate, {});
  try {
    assert.equal(http.get, patchedGet, 'the second call must not wrap again');
    assert.deepEqual(second.stats().patched, []);
  } finally {
    second.restore();
    first.restore();
  }
});

test('harden refuses a gate it cannot ask', () => {
  assert.throws(() => harden(null), /Schleuse/);
  assert.throws(() => harden({}), /Schleuse/);
});

module.exports = { name: 'harden', tests: drain() };
