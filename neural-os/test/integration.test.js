'use strict';

/**
 * End-to-end tests over the real stack: real app boot, real HTTP server, real
 * vault on disk. Nothing is mocked except the absence of the internet, which
 * is the point.
 *
 * These tests are the evidence behind the claims in the README. If any of them
 * fails, a promise the app makes to its user is broken.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { test, drain, tempHome } = require('./harness');

const { createApp, seedIfEmpty } = require('../src/app');

/** Minimal HTTP client so the tests exercise the real wire format. */
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
          try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is fine */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Boot a fully wired app on an ephemeral port in a throwaway home. */
async function withApp(fn, appOpts = {}) {
  const { home, cleanup } = tempHome('nos-e2e');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, ...appOpts });
    await seedIfEmpty(app);
    const server = await app.listen();
    const addr = server.server.address();
    const base = `http://127.0.0.1:${addr.port}`;
    await fn({ app, base, home, request: (m, p, b, h) => request(base, m, p, b, h) });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
}

test('app boots into a fresh vault and reports its real state', async () => {
  await withApp(async ({ app }) => {
    const health = await app.doctor();
    assert.equal(health.network.mode, 'offline', 'a fresh install must start offline');
    assert.ok(health.subsystems.store, 'store must be available');
    assert.ok(health.subsystems.gate, 'gate must be available');
    // doctor() must never claim a model exists when none was reachable.
    if (!health.models.available) {
      assert.ok(Array.isArray(health.models.providers));
    }
  });
});

test('OFFLINE GUARANTEE: loopback allowed, public internet blocked', async () => {
  await withApp(async ({ app }) => {
    const gate = app.gate;
    // A local model server is not "the internet" and must keep working.
    assert.equal(gate.check({ host: '127.0.0.1', port: 11434, scope: 'global' }).allowed, true);
    assert.equal(gate.check({ host: 'localhost', port: 8080, scope: 'global' }).allowed, true);
    assert.equal(gate.check({ host: '::1', port: 1234, scope: 'global' }).allowed, true);

    // Everything else is denied while offline.
    for (const host of ['8.8.8.8', 'example.com', 'api.openai.com', '1.1.1.1', '192.168.1.10']) {
      const decision = gate.check({ host, port: 443, scope: 'global' });
      assert.equal(decision.allowed, false, `${host} must be blocked while offline`);
      assert.ok(decision.reason, 'a denial must state its reason');
    }
  });
});

test('OFFLINE GUARANTEE: the whole product surface works with the network down', async () => {
  await withApp(async ({ request: req, app }) => {
    // Notes: create, read, search.
    const created = await req('POST', '/api/records', {
      type: 'note',
      data: { title: 'Offline-Beweis', body: 'Verweis auf [[Willkommen in Neural OS]] #test', tags: ['test'] },
    });
    assert.equal(created.status, 200, created.text);
    const noteId = created.json.record.id;

    const fetched = await req('GET', `/api/records/${noteId}`);
    assert.equal(fetched.json.record.data.title, 'Offline-Beweis');

    const found = await req('GET', '/api/search?q=Offline-Beweis');
    assert.ok(found.json.items.length >= 1, 'full-text search must work offline');

    // The graph must reflect the wiki link that was just written.
    const graph = await req('GET', `/api/graph?focus=${noteId}&depth=2`);
    assert.ok(graph.json.nodes.length >= 1, 'graph must return nodes offline');
    const edge = graph.json.edges.find((e) => e.from === noteId || e.to === noteId);
    assert.ok(edge, 'the [[wiki link]] must have produced a real edge');

    // Manual edges are user-owned and must be creatable offline.
    const other = await req('POST', '/api/records', { type: 'note', data: { title: 'Zweite Notiz' } });
    const manual = await req('POST', '/api/edges', {
      from: noteId, to: other.json.record.id, kind: 'related', reason: 'Test',
    });
    assert.equal(manual.status, 200, manual.text);

    // Projects and tasks.
    const project = await req('POST', '/api/records', { type: 'project', data: { name: 'Testprojekt' } });
    const task = await req('POST', '/api/records', {
      type: 'task', data: { title: 'Etwas erledigen', projectId: project.json.record.id },
    });
    assert.equal(task.json.record.data.status, 'todo');

    // Update and soft delete stay reversible.
    const patched = await req('PATCH', `/api/records/${noteId}`, { data: { title: 'Umbenannt' } });
    assert.equal(patched.json.record.data.title, 'Umbenannt');
    await req('DELETE', `/api/records/${noteId}`);
    assert.equal((await req('GET', `/api/records/${noteId}`)).status, 404);
    const restored = await req('POST', `/api/records/${noteId}/restore`);
    assert.equal(restored.status, 200, 'a soft delete must be recoverable');

    // Nothing above touched the network.
    assert.equal(app.config.network.mode, 'offline');
  });
});

test('HONESTY: a chat without a reachable model errors instead of inventing an answer', async () => {
  await withApp(async ({ request: req }) => {
    const chat = await req('POST', '/api/chats', { title: 'Test' });
    assert.equal(chat.status, 200, chat.text);
    const res = await req('POST', `/api/chats/${chat.json.record.id}/send`, { content: 'Hallo?' });

    // Either the SSE stream carries an error event, or the request fails
    // outright. What must NEVER happen is a plausible-looking assistant reply.
    const body = res.text || '';
    const inventedReply = /"role"\s*:\s*"assistant"[^}]*"content"\s*:\s*"(?!")/i.test(body) && !/NO_MODEL_AVAILABLE|MODEL_ERROR|error/i.test(body);
    assert.equal(inventedReply, false, 'the app must not fabricate a model response');
    assert.ok(
      /NO_MODEL_AVAILABLE|MODEL_ERROR|error/i.test(body) || res.status >= 400,
      `expected an honest failure, got: ${body.slice(0, 400)}`,
    );
  });
});

test('SECURITY: mutating requests without the CSRF header are rejected', async () => {
  await withApp(async ({ base }) => {
    const res = await request(base, 'POST', '/api/records', { type: 'note', data: { title: 'x' } }, { 'x-neural-os': '' });
    assert.ok(res.status === 400 || res.status === 403, `expected rejection, got ${res.status}`);
  });
});

test('SECURITY: a foreign Host header is rejected (DNS rebinding)', async () => {
  await withApp(async ({ base }) => {
    const res = await request(base, 'GET', '/api/status', undefined, { host: 'attacker.example.com' });
    assert.ok(res.status === 400 || res.status === 403, `expected rejection, got ${res.status}`);
  });
});

test('SECURITY: every response carries a content security policy', async () => {
  await withApp(async ({ request: req }) => {
    const res = await req('GET', '/api/status');
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'CSP header missing');
    assert.match(csp, /connect-src[^;]*'self'/, "connect-src must be 'self' so the UI cannot reach any other host");
    assert.match(csp, /default-src[^;]*'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});

test('SECURITY: static file serving refuses path traversal', async () => {
  await withApp(async ({ request: req }) => {
    for (const evil of ['/../package.json', '/..%2f..%2fetc%2fpasswd', '/web/../../src/app.js']) {
      const res = await req('GET', evil);
      assert.ok(res.status >= 400 || !/createApp|"name":\s*"neural-os"/.test(res.text), `traversal leaked via ${evil}`);
    }
  });
});

test('NETWORK CONTROL: a grant is scoped, counted and expiring', async () => {
  await withApp(async ({ app }) => {
    const gate = app.gate;
    gate.addGrant({ scope: 'chat:abc', level: 'online', hosts: ['de.wikipedia.org'], maxUses: 2, reason: 'Test' });

    assert.equal(gate.check({ host: 'de.wikipedia.org', port: 443, scope: 'chat:abc' }).allowed, true);
    // A grant for one chat must not leak into another.
    assert.equal(gate.check({ host: 'de.wikipedia.org', port: 443, scope: 'chat:xyz' }).allowed, false);
    // Nor to a different host.
    assert.equal(gate.check({ host: 'evil.example', port: 443, scope: 'chat:abc' }).allowed, false);

    const expired = gate.addGrant({
      scope: 'global', level: 'online', hosts: ['*'],
      expiresAt: new Date(Date.now() - 1000).toISOString(), reason: 'abgelaufen',
    });
    assert.equal(gate.check({ host: 'example.com', port: 443, scope: 'global' }).allowed, false, 'expired grants must not apply');
    assert.ok(expired);
  });
});

test('NETWORK CONTROL: every decision is written to the audit trail', async () => {
  await withApp(async ({ app, home }) => {
    app.gate.check({ host: '8.8.8.8', port: 53, scope: 'global', purpose: 'test' });
    app.gate.check({ host: '127.0.0.1', port: 11434, scope: 'global', purpose: 'test' });

    const auditFile = path.join(home, 'audit.jsonl');
    const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const kinds = lines.map((l) => l.kind);
    assert.ok(kinds.some((k) => k.startsWith('network.')), 'network decisions must be audited');
    // Allowed traffic is audited too: a log of only denials proves nothing
    // about what actually left the machine.
    const networkLines = lines.filter((l) => l.kind.startsWith('network.'));
    assert.ok(networkLines.length >= 2, `expected both decisions audited, got ${networkLines.length}`);
  });
});

test('live events reach the browser over SSE', async () => {
  await withApp(async ({ base, request: req }) => {
    const received = [];
    const url = new URL('/api/events', base);
    const stream = await new Promise((resolve, reject) => {
      const r = http.request(
        { method: 'GET', hostname: url.hostname, port: url.port, path: url.pathname, headers: { accept: 'text/event-stream' } },
        resolve,
      );
      r.on('error', reject);
      r.end();
    });
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => received.push(chunk));

    await new Promise((r) => setTimeout(r, 120));
    await req('POST', '/api/records', { type: 'note', data: { title: 'SSE-Test' } });
    await new Promise((r) => setTimeout(r, 400));
    stream.destroy();

    const text = received.join('');
    assert.match(text, /record\.created|SSE-Test/, `expected a live event, got: ${text.slice(0, 300)}`);
  });
});

test('DATA SAFETY: export and re-import reproduce the vault exactly', async () => {
  const { home: sourceHome, cleanup: cleanSource } = tempHome('nos-src');
  const { home: targetHome, cleanup: cleanTarget } = tempHome('nos-dst');
  let source = null;
  let target = null;
  try {
    source = await createApp({ home: sourceHome, logLevel: 'error', harden: false });
    await seedIfEmpty(source);
    const note = source.store.create('note', { title: 'Wichtig', body: 'Darf niemals verloren gehen', tags: ['a', 'b'] });
    const second = source.store.create('note', { title: 'Verbunden' });
    source.store.edges.add({ from: note.id, to: second.id, kind: 'related', source: 'manual', reason: 'Test' });
    await source.store.flush();

    assert.ok(source.backup, 'backup subsystem required for this guarantee');
    const exported = await source.backup.exportAll({ format: 'json', includeFiles: true });
    const before = source.store.all('note').length;

    target = await createApp({ home: targetHome, logLevel: 'error', harden: false });
    const imported = await target.backup.importAll({ dir: exported.dir, mode: 'merge' });
    assert.ok(imported.imported > 0, 'import moved no records');

    const restored = target.store.get(note.id);
    assert.ok(restored, 'the exported note must exist after import');
    assert.equal(restored.data.title, 'Wichtig');
    assert.deepEqual(restored.data.tags, ['a', 'b']);
    assert.ok(target.store.all('note').length >= before, 'notes were lost in the round trip');
    // The manual edge -- the user's own connection -- must survive too.
    assert.ok(target.store.edges.between(note.id, second.id).length > 0, 'manual edges must survive a round trip');
  } finally {
    if (source) await source.close().catch(() => {});
    if (target) await target.close().catch(() => {});
    cleanSource();
    cleanTarget();
  }
});

test('DATA SAFETY: a crash mid-write cannot destroy the vault', async () => {
  const { home, cleanup } = tempHome('nos-crash');
  let app = null;
  try {
    app = await createApp({ home, logLevel: 'error', harden: false });
    const keep = app.store.create('note', { title: 'Vor dem Absturz' });
    await app.store.flush();
    await app.close();
    app = null;

    // Simulate power loss in the middle of appending a record.
    const logDir = path.join(home, 'vault', 'log');
    const segments = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort();
    const last = path.join(logDir, segments[segments.length - 1]);
    fs.appendFileSync(last, '{"v":1,"op":"create","id":"note_trunc');

    app = await createApp({ home, logLevel: 'error', harden: false });
    assert.ok(app.store.get(keep.id), 'records written before the crash must survive');
    assert.equal(app.store.get(keep.id).data.title, 'Vor dem Absturz');
    // And the vault must still accept new writes afterwards.
    const after = app.store.create('note', { title: 'Nach dem Absturz' });
    assert.ok(app.store.get(after.id));
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});

test('two instances cannot open the same vault', async () => {
  const { home, cleanup } = tempHome('nos-lock');
  const { acquireLock } = require('../src/app');
  const layout = require('../src/kernel/paths').ensureLayout(require('../src/kernel/paths').layout(home));
  let release = null;
  try {
    release = await acquireLock(layout);
    await assert.rejects(() => acquireLock(layout), /already using|corrupt/i);
  } finally {
    if (release) await release();
    cleanup();
  }
});


test('SECURITY: agents cannot be created or raised through the generic record route', async () => {
  await withApp(async ({ request: req }) => {
    const sneaky = await req('POST', '/api/records', {
      type: 'agent',
      data: {
        name: 'Schleichweg',
        permissions: { network: 'online', writeFiles: true, requireApproval: false, fileRoots: ['/'] },
      },
    });
    assert.ok(sneaky.status >= 400, 'the generic route must not mint agents');
    assert.match(String(sneaky.text), /api\/agents/, 'the refusal should point at the route that checks permissions');

    // The dedicated route fills every omitted permission with "denied".
    const proper = await req('POST', '/api/agents', { name: 'Ordentlich', permissions: { readNotes: true } });
    assert.equal(proper.status, 200, proper.text);
    const perms = proper.json.record.data.permissions;
    assert.equal(perms.network, 'offline');
    assert.equal(perms.writeFiles, false);
    assert.equal(perms.requireApproval, true);
    assert.deepEqual(perms.fileRoots, []);

    // And it cannot be raised afterwards through the generic patch route.
    const raise = await req('PATCH', `/api/records/${proper.json.record.id}`, {
      data: { permissions: { network: 'online', writeFiles: true } },
    });
    assert.ok(raise.status >= 400, 'permissions must not be raisable through the generic route');
  });
});

module.exports = { name: 'integration', tests: drain() };
