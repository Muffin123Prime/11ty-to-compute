'use strict';

/**
 * Tests for src/http/auth.js.
 *
 * Every test builds its own temporary vault; nothing here touches the real
 * home directory and nothing opens a socket. The request objects are the
 * minimal shape `auth.middleware` reads from `http.IncomingMessage`, which is
 * exactly `method`, `url`, `headers` and `socket.remoteAddress` -- using the
 * real server would test the router, not the policy.
 */

const assert = require('node:assert/strict');
const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const configMod = require('../src/kernel/config');
const { Audit } = require('../src/kernel/log');
const { Bus } = require('../src/kernel/bus');
const { createAuth, __internals } = require('../src/http/auth');

const HOST = '127.0.0.1:7777';

/** Open a throwaway vault + auth instance and clean both up afterwards. */
async function withAuth(label, fn, mutateConfig) {
  const { home, cleanup } = tempHome(label);
  const config = configMod.defaults();
  if (typeof mutateConfig === 'function') mutateConfig(config);
  const store = await openStore({ paths: home, bus: new Bus() });
  const audit = new Audit(`${home}/audit.jsonl`).open();
  const auth = createAuth({ store, config, audit });
  try {
    return await fn({ auth, store, config, audit, home });
  } finally {
    audit.close();
    try { await store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

/** Minimal stand-in for an incoming HTTP request. */
function req(opts = {}) {
  const headers = { host: opts.host === undefined ? HOST : opts.host };
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (v !== undefined) headers[k.toLowerCase()] = v;
  }
  if (opts.host === null) delete headers.host;
  return {
    method: opts.method || 'GET',
    url: opts.url || '/api/records',
    headers,
    socket: { remoteAddress: opts.remote === undefined ? '127.0.0.1' : opts.remote },
  };
}

/** A mutating request that carries everything except what the test removes. */
function post(overrides = {}) {
  return req({
    method: 'POST',
    url: '/api/records',
    ...overrides,
    headers: { 'x-neural-os': '1', ...(overrides.headers || {}) },
  });
}

function shareOn(config) {
  config.security.sharing.enabled = true;
  config.security.sharing.requireToken = true;
}

/* ------------------------------------------------------- owner identity */

test('loopback without sharing is the owner and needs no token', async () => {
  await withAuth('auth-owner', async ({ auth }) => {
    const res = await auth.middleware(req());
    assert.equal(res.ok, true);
    assert.equal(res.identity.kind, 'owner');
    assert.equal(res.identity.permissions, 'all');
    assert.equal(auth.can(res.identity, 'write'), true);
    assert.equal(auth.can(res.identity, 'agents'), true);
  });
});

test('without sharing, a non-loopback client is refused outright', async () => {
  await withAuth('auth-remote-off', async ({ auth }) => {
    const res = await auth.middleware(req({ remote: '192.168.1.44', host: '192.168.1.5:7777' }));
    assert.equal(res.ok, false);
    assert.equal(res.error.status, 403);
  });
});

/* ------------------------------------------------- DNS rebinding defence */

test('a foreign Host header is rejected (DNS rebinding)', async () => {
  await withAuth('auth-host', async ({ auth }) => {
    const res = await auth.middleware(req({ host: 'attacker.example.com' }));
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'PERMISSION_DENIED');
    assert.match(res.error.message, /Host-Header/);
  });
});

test('localhost, ::1 and the configured bind host are accepted', async () => {
  await withAuth('auth-host-ok', async ({ auth }) => {
    for (const host of ['localhost:7777', '127.0.0.1', '[::1]:7777', 'dev.localhost:7777']) {
      const res = await auth.middleware(req({ host }));
      assert.equal(res.ok, true, `host ${host} should be accepted`);
    }
  });
});

test('an address literal is accepted once sharing is on, a strange name is not', async () => {
  await withAuth('auth-host-lan', async ({ auth, store }) => {
    const { token } = await auth.createToken({ label: 'Tablet' });
    const headers = { authorization: `Bearer ${token}` };

    const ok = await auth.middleware(req({ host: '192.168.1.5:7777', remote: '192.168.1.44', headers }));
    assert.equal(ok.ok, true, ok.ok ? '' : ok.error && ok.error.message);

    // A name is exactly what a rebinding attack needs, so it stays refused.
    const bad = await auth.middleware(req({ host: 'evil.test:7777', remote: '192.168.1.44', headers }));
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /Host-Header/);
    assert.ok(store);
  }, (config) => {
    shareOn(config);
    config.server.host = '0.0.0.0';
    config.security.sharing.bindHost = '0.0.0.0';
  });
});

test('a missing Host header is tolerated locally and refused remotely', async () => {
  await withAuth('auth-host-missing', async ({ auth }) => {
    assert.equal((await auth.middleware(req({ host: null }))).ok, true);
    const remote = await auth.middleware(req({ host: null, remote: '10.0.0.9' }));
    assert.equal(remote.ok, false);
  });
});

/* ----------------------------------------------------------------- CSRF */

test('a mutating request without the CSRF header is rejected', async () => {
  await withAuth('auth-csrf', async ({ auth }) => {
    const missing = await auth.middleware(req({ method: 'POST' }));
    assert.equal(missing.ok, false);
    assert.equal(missing.error.status, 403);
    assert.match(missing.error.message, /X-Neural-OS/);

    // An empty value is not a value: the header must actually be set.
    const empty = await auth.middleware(req({ method: 'POST', headers: { 'x-neural-os': '  ' } }));
    assert.equal(empty.ok, false);
  });
});

test('a GET needs no CSRF header', async () => {
  await withAuth('auth-csrf-get', async ({ auth }) => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await auth.middleware(req({ method }));
      assert.equal(res.ok, true, `${method} must pass without the header`);
    }
  });
});

test('a mutating request with a foreign Origin is rejected, same-origin passes', async () => {
  await withAuth('auth-origin', async ({ auth }) => {
    const foreign = await auth.middleware(post({ headers: { origin: 'https://evil.example' } }));
    assert.equal(foreign.ok, false);
    assert.match(foreign.error.message, /Origin/);

    const same = await auth.middleware(post({ headers: { origin: `http://${HOST}` } }));
    assert.equal(same.ok, true, same.ok ? '' : same.error && same.error.message);

    const crossSite = await auth.middleware(post({ headers: { 'sec-fetch-site': 'cross-site' } }));
    assert.equal(crossSite.ok, false);
  });
});

/* --------------------------------------------------------------- tokens */

test('createToken returns the raw token once and stores only its hash', async () => {
  await withAuth('auth-token-store', async ({ auth, store }) => {
    const { token, record } = await auth.createToken({ label: 'Tablet', permissions: { read: true, chat: true } });

    assert.match(token, /^nos_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}$/);
    const secret = token.split('.')[1];

    // The sanitised record the caller gets back carries no secret material.
    assert.equal(record.hash, undefined);
    assert.equal(record.salt, undefined);

    // Neither does anything that reached the vault.
    const stored = store.get(record.id);
    const serialised = JSON.stringify(stored);
    assert.ok(!serialised.includes(token), 'the raw token must never be stored');
    assert.ok(!serialised.includes(secret), 'the token secret must never be stored');
    assert.ok(stored.data.hash && stored.data.salt, 'hash and salt must be stored');
    assert.notEqual(stored.data.hash, secret);
    assert.equal(stored.data.permissions.chat, true);
    assert.equal(stored.data.permissions.write, false);

    // And it is never handed out again.
    const listed = auth.listTokens();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].hash, undefined);
    assert.ok(!JSON.stringify(listed).includes(secret));
  });
});

test('a valid token authenticates, a wrong one does not', async () => {
  await withAuth('auth-token-verify', async ({ auth }) => {
    const { token, record } = await auth.createToken({ label: 'Tablet', permissions: { read: true } });

    const ok = await auth.middleware(req({ headers: { authorization: `Bearer ${token}` } }));
    assert.equal(ok.ok, true, ok.ok ? '' : ok.error && ok.error.message);
    assert.equal(ok.identity.kind, 'token');
    assert.equal(ok.identity.tokenId, record.id);
    assert.equal(auth.can(ok.identity, 'read'), true);
    assert.equal(auth.can(ok.identity, 'write'), false);
    assert.throws(() => auth.assertCan(ok.identity, 'agents'), /agents/);

    // Same selector, wrong secret: the shape is right, the proof is not.
    const [prefix] = token.split('.');
    const forged = `${prefix}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const bad = await auth.middleware(req({ headers: { authorization: `Bearer ${forged}` } }));
    assert.equal(bad.ok, false);
    assert.equal(bad.error.status, 401);
    assert.match(bad.error.message, /Ungültiges Zugriffstoken/);

    const nonsense = await auth.middleware(req({ headers: { authorization: 'Bearer total-erfunden' } }));
    assert.equal(nonsense.ok, false);
    assert.equal(nonsense.error.status, 401);
  }, shareOn);
});

test('an expired token is rejected', async () => {
  await withAuth('auth-token-expired', async ({ auth, store }) => {
    const { token, record } = await auth.createToken({
      label: 'Kurz gültig',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal((await auth.middleware(req({ headers: { authorization: `Bearer ${token}` } }))).ok, true);

    // Let time pass, without making the test wait for it.
    store.update(record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    const res = await auth.middleware(req({ headers: { authorization: `Bearer ${token}` } }));
    assert.equal(res.ok, false);
    assert.equal(res.error.status, 401);
    assert.match(res.error.message, /abgelaufen/);
  }, shareOn);
});

test('a revoked token is rejected and stays on record', async () => {
  await withAuth('auth-token-revoked', async ({ auth, store }) => {
    const { token, record } = await auth.createToken({ label: 'Verloren' });
    assert.equal((await auth.middleware(req({ headers: { authorization: `Bearer ${token}` } }))).ok, true);

    const revoked = auth.revokeToken(record.id);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.active, false);

    const res = await auth.middleware(req({ headers: { authorization: `Bearer ${token}` } }));
    assert.equal(res.ok, false);
    assert.match(res.error.message, /widerrufen/);

    // The record survives: the audit trail must stay able to name the credential.
    assert.ok(store.get(record.id), 'a revoked token record must not be deleted');
    assert.equal(auth.listTokens().length, 1);
  }, shareOn);
});

test('sharing on: no credential means no access, and the session cookie is one', async () => {
  await withAuth('auth-sharing', async ({ auth }) => {
    assert.equal(auth.bootstrapNeeded(), true);

    const none = await auth.middleware(req());
    assert.equal(none.ok, false);
    assert.equal(none.error.status, 401);
    assert.match(none.error.message, /Zugriffstoken/);

    const { token } = await auth.createToken({ label: 'Browser' });
    assert.equal(auth.bootstrapNeeded(), false);

    const setCookie = auth.cookieFor(token, { maxAgeSeconds: 3600 });
    assert.match(setCookie, /^nos_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    const cookieValue = setCookie.split(';')[0].trim();
    const res = await auth.middleware(req({ headers: { cookie: `theme=dark; ${cookieValue}` } }));
    assert.equal(res.ok, true, res.ok ? '' : res.error && res.error.message);
    assert.equal(res.identity.kind, 'token');

    // The cookie is a credential like any other: CSRF still applies to writes.
    const write = await auth.middleware(req({ method: 'POST', headers: { cookie: cookieValue } }));
    assert.equal(write.ok, false);
    assert.match(write.error.message, /X-Neural-OS/);
  }, shareOn);
});

test('sharing on: the health endpoint stays reachable from this machine', async () => {
  await withAuth('auth-health', async ({ auth }) => {
    const local = await auth.middleware(req({ url: '/api/health' }));
    assert.equal(local.ok, true);
    assert.equal(local.identity.kind, 'health');

    const remote = await auth.middleware(req({ url: '/api/health', remote: '192.168.1.44', host: '192.168.1.5:7777' }));
    assert.equal(remote.ok, false, 'health must not be public to the network');
  }, (config) => {
    shareOn(config);
    config.server.host = '0.0.0.0';
    config.security.sharing.bindHost = '0.0.0.0';
  });
});

test('a 401 sets WWW-Authenticate so a client knows what to send', async () => {
  await withAuth('auth-challenge', async ({ auth }) => {
    const headers = {};
    const res = await auth.middleware(req(), {
      headersSent: false,
      setHeader: (k, v) => { headers[k] = v; },
    });
    assert.equal(res.ok, false);
    assert.equal(headers['WWW-Authenticate'], 'Bearer realm="Neural OS"');
  }, shareOn);
});

test('createToken validates its input instead of inventing defaults', async () => {
  await withAuth('auth-token-validate', async ({ auth }) => {
    await assert.rejects(() => auth.createToken({}), /Bezeichnung/);
    await assert.rejects(() => auth.createToken({ label: 'x', expiresAt: 'irgendwann' }), /ISO-Zeitstempel/);
    await assert.rejects(
      () => auth.createToken({ label: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() }),
      /Vergangenheit/,
    );
    assert.throws(() => auth.revokeToken('token_doesnotexist000000'), /not found/);
  });
});

test('every denial is written to the audit trail', async () => {
  await withAuth('auth-audit', async ({ auth, audit }) => {
    await auth.middleware(req({ host: 'attacker.example.com' }));
    const entries = audit.tail(10);
    const denial = entries.find((e) => e.kind === 'auth.denied');
    assert.ok(denial, 'a rejected request must leave a trace');
    assert.equal(denial.host, 'attacker.example.com');
    assert.equal(denial.code, 'PERMISSION_DENIED');
  });
});

/* ------------------------------------------------------------ internals */

test('host and cookie parsing handle the shapes browsers really send', () => {
  const { hostnameOf, parseCookies, isLoopbackAddress, isIpLiteral } = __internals;
  assert.equal(hostnameOf('[::1]:7777'), '::1');
  assert.equal(hostnameOf('Example.COM:80'), 'example.com');
  assert.equal(hostnameOf('host.'), 'host');
  assert.equal(hostnameOf(''), '');
  assert.equal(hostnameOf(undefined), '');

  assert.deepEqual(parseCookies('a=1; b=zwei%20drei'), { a: '1', b: 'zwei drei' });
  assert.deepEqual(parseCookies('broken; c="quoted"'), { c: 'quoted' });
  assert.deepEqual(parseCookies(undefined), {});

  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.53'), true);
  assert.equal(isLoopbackAddress('192.168.0.1'), false);

  assert.equal(isIpLiteral('192.168.1.5'), true);
  assert.equal(isIpLiteral('fe80::1'), true);
  assert.equal(isIpLiteral('example.com'), false);
  assert.equal(isIpLiteral('999.1.1.1'), false);
});

module.exports = { name: 'auth', tests: drain() };
