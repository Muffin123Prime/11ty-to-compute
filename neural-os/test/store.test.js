'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { test, drain, tempHome } = require('./harness');
const { openStore } = require('../src/store/engine');
const schema = require('../src/store/schema');
const paths = require('../src/kernel/paths');
const { Bus } = require('../src/kernel/bus');

/**
 * Every test gets its own temporary home. Nothing here may ever look at
 * ~/.neural-os, so the home is always created by tempHome() and removed again.
 */
async function withStore(label, fn, openOpts = {}) {
  const { home, cleanup } = tempHome(label);
  const opened = [];
  const open = async (extra = {}) => {
    const store = await openStore({ paths: home, ...openOpts, ...extra });
    opened.push(store);
    return store;
  };
  try {
    return await fn(await open(), { home, open });
  } finally {
    for (const store of opened) {
      try { await store.close(); } catch { /* already closed by the test */ }
    }
    cleanup();
  }
}

/** Reversible stand-in for src/store/vaultcrypto.js (another agent owns that). */
function fakeCrypto() {
  return {
    enabled: true,
    encryptLine: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    decryptLine: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    // XOR is enough to prove the seam is used; the real implementation
    // (src/store/vaultcrypto.js) is another agent's AES-256-GCM.
    encryptBuffer: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptBuffer: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
  };
}

function logFiles(home) {
  const dir = paths.layout(home).log;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
}

/* ---------------------------------------------------------------- records */

test('create returns a schema-conform record with a contract-shaped id', async () => {
  await withStore('store-create', async (store) => {
    const note = store.create('note', { title: 'Erste Notiz' });
    assert.match(note.id, schema.ID_RE);
    assert.ok(note.id.startsWith('note_'));
    assert.equal(note.id.length, 'note_'.length + 24);
    assert.equal(note.type, 'note');
    assert.equal(note.rev, 1);
    assert.equal(note.deletedAt, null);
    assert.equal(note.createdAt, note.updatedAt);
    assert.equal(note.data.body, '', 'schema defaults must be applied');
    assert.deepEqual(note.data.tags, []);
  });
});

test('generated ids are unique across many creations', async () => {
  await withStore('store-ids', async (store) => {
    const seen = new Set();
    store.transaction(() => {
      for (let i = 0; i < 500; i++) seen.add(store.create('note', { title: `N${i}` }).id);
    });
    assert.equal(seen.size, 500);
  });
});

test('create rejects unknown types and invalid data', async () => {
  await withStore('store-validate', async (store) => {
    assert.throws(() => store.create('nonsense', {}), /Unbekannter Datensatztyp|Unknown record type/);
    assert.throws(() => store.create('note', {}), /title is required/);
    assert.throws(() => store.create('task', { title: 't', status: 'erfunden' }), /status must be one of/);
  });
});

test('opts.id forces an id and refuses a duplicate or a malformed one', async () => {
  await withStore('store-forced-id', async (store) => {
    const id = 'note_aaaaaaaaaaaaaaaaaaaaaaaa';
    const note = store.create('note', { title: 'Fest' }, { id });
    assert.equal(note.id, id);
    assert.throws(() => store.create('note', { title: 'Nochmal' }, { id }), /existiert bereits/);
    assert.throws(() => store.create('note', { title: 'X' }, { id: 'kaputt' }), /Ungueltige ID/);
  });
});

test('callers cannot corrupt the vault through the record they were handed', async () => {
  await withStore('store-immutable', async (store) => {
    const note = store.create('note', { title: 'Original', tags: ['a'] });
    note.data.title = 'Manipuliert';
    note.data.tags.push('b');
    const fresh = store.get(note.id);
    assert.equal(fresh.data.title, 'Original');
    assert.deepEqual(fresh.data.tags, ['a']);
  });
});

test('update shallow-merges, bumps rev and moves updatedAt', async () => {
  await withStore('store-update', async (store) => {
    const note = store.create('note', { title: 'A', body: 'alt', tags: ['x'] });
    const updated = store.update(note.id, { body: 'neu' });
    assert.equal(updated.rev, 2);
    assert.equal(updated.data.body, 'neu');
    assert.equal(updated.data.title, 'A', 'untouched fields survive');
    assert.deepEqual(updated.data.tags, ['x']);
    assert.ok(updated.updatedAt >= note.updatedAt);
    assert.throws(() => store.update('note_ffffffffffffffffffffffff', { body: 'x' }), /not found/);
    assert.throws(() => store.update(note.id, { tags: 'kein array' }), /tags must be an array/);
  });
});

test('soft delete tombstones, hides and is reversible', async () => {
  await withStore('store-softdelete', async (store) => {
    const note = store.create('note', { title: 'Weg damit' });
    const removed = store.remove(note.id);
    assert.ok(removed.deletedAt);
    assert.equal(store.get(note.id), null);
    assert.ok(store.get(note.id, { includeDeleted: true }));
    assert.equal(store.count('note'), 0);
    assert.equal(store.list('note').total, 0);
    assert.equal(store.list('note', { includeDeleted: true }).total, 1);
    assert.equal(store.search('Weg').total, 0, 'tombstones leave the search index');

    const back = store.restore(note.id);
    assert.equal(back.deletedAt, null);
    assert.equal(store.count('note'), 1);
    assert.equal(store.search('Weg').total, 1);
  });
});

test('hard delete purges the record and cascades to its edges', async () => {
  await withStore('store-harddelete', async (store) => {
    const note = store.create('note', { title: 'Knoten' });
    const project = store.create('project', { name: 'Projekt' });
    const edge = store.edges.add({ from: note.id, to: project.id, kind: 'belongs-to' });
    assert.equal(store.count('edge'), 1);

    store.remove(note.id, { hard: true });
    assert.equal(store.get(note.id, { includeDeleted: true }), null);
    assert.equal(store.get(edge.id, { includeDeleted: true }), null, 'dangling edge must not survive');
    assert.equal(store.count('edge'), 0);
    assert.equal(store.count('project'), 1);
  });
});

test('list filters, sorts, paginates and reports the honest total', async () => {
  await withStore('store-list', async (store) => {
    store.create('task', { title: 'A', status: 'todo', priority: 1 });
    store.create('task', { title: 'B', status: 'done', priority: 3 });
    store.create('task', { title: 'C', status: 'todo', priority: 2 });

    const todo = store.list('task', { filter: { status: 'todo' } });
    assert.equal(todo.total, 2);
    assert.deepEqual(todo.items.map((r) => r.data.title).sort(), ['A', 'C']);

    const byPriority = store.list('task', { sort: 'priority', order: 'asc' });
    assert.deepEqual(byPriority.items.map((r) => r.data.title), ['A', 'C', 'B']);

    const page = store.list('task', { sort: 'title', order: 'asc', limit: 2, offset: 1 });
    assert.equal(page.total, 3, 'total counts matches, not the page');
    assert.deepEqual(page.items.map((r) => r.data.title), ['B', 'C']);

    const fn = store.list('task', { filter: (r) => r.data.priority <= 2 });
    assert.equal(fn.total, 2);

    assert.equal(store.list(null).total, 3, 'null type lists everything');
    assert.equal(store.all('task').length, 3);
  });
});

/* ------------------------------------------------------------------ edges */

test('edges deduplicate on (from,to,kind) and demand real endpoints', async () => {
  await withStore('store-edges', async (store) => {
    const a = store.create('note', { title: 'A' });
    const b = store.create('note', { title: 'B' });

    const first = store.edges.add({ from: a.id, to: b.id, kind: 'links-to', reason: 'zuerst' });
    const again = store.edges.add({ from: a.id, to: b.id, kind: 'links-to', reason: 'zweimal' });
    assert.equal(again.id, first.id, 'a duplicate returns the existing edge');
    assert.equal(again.data.reason, 'zuerst', 'and does not overwrite it');
    assert.equal(store.count('edge'), 1);

    const other = store.edges.add({ from: a.id, to: b.id, kind: 'related' });
    assert.notEqual(other.id, first.id, 'a different kind is a different edge');

    assert.throws(() => store.edges.add({ from: a.id, to: 'note_ffffffffffffffffffffffff', kind: 'related' }), /not found/);
    assert.throws(() => store.edges.add({ from: 'note_ffffffffffffffffffffffff', to: b.id }), /not found/);
    assert.throws(() => store.edges.add({ from: a.id, to: a.id }), /eigenen Knoten/);

    // A removed edge frees its dedupe key again.
    store.edges.remove(first.id);
    const recreated = store.edges.add({ from: a.id, to: b.id, kind: 'links-to' });
    assert.notEqual(recreated.id, first.id);
    assert.equal(store.count('edge'), 2);
  });
});

test('edges.for and edges.between respect direction and kind', async () => {
  await withStore('store-edges-query', async (store) => {
    const a = store.create('note', { title: 'A' });
    const b = store.create('note', { title: 'B' });
    const c = store.create('note', { title: 'C' });
    store.edges.add({ from: a.id, to: b.id, kind: 'links-to' });
    store.edges.add({ from: c.id, to: a.id, kind: 'mentions' });

    assert.equal(store.edges.for(a.id, { direction: 'out' }).length, 1);
    assert.equal(store.edges.for(a.id, { direction: 'in' }).length, 1);
    assert.equal(store.edges.for(a.id).length, 2);
    assert.equal(store.edges.for(a.id, { kinds: ['mentions'] }).length, 1);
    assert.equal(store.edges.for(a.id, { limit: 1 }).length, 1);
    assert.equal(store.edges.between(a.id, b.id).length, 1);
    assert.equal(store.edges.between(b.id, a.id).length, 1, 'between is undirected');
    assert.equal(store.edges.between(b.id, c.id).length, 0);
    assert.throws(() => store.edges.for(a.id, { direction: 'seitwaerts' }), /Unbekannte Richtung/);
  });
});

test('neighbours is a real BFS with an honest truncated flag', async () => {
  await withStore('store-bfs', async (store) => {
    // A chain n0 -> n1 -> ... -> n5 plus one unrelated island.
    const chain = [];
    store.transaction(() => {
      for (let i = 0; i < 6; i++) chain.push(store.create('note', { title: `n${i}` }));
      for (let i = 0; i < 5; i++) store.edges.add({ from: chain[i].id, to: chain[i + 1].id, kind: 'links-to' });
    });
    const island = store.create('note', { title: 'Insel' });

    const d1 = store.edges.neighbours(chain[0].id, { depth: 1 });
    assert.deepEqual(d1.nodes.map((n) => n.data.title).sort(), ['n0', 'n1']);
    assert.equal(d1.edges.length, 1);
    assert.equal(d1.truncated, false);

    const d3 = store.edges.neighbours(chain[0].id, { depth: 3 });
    assert.deepEqual(d3.nodes.map((n) => n.data.title).sort(), ['n0', 'n1', 'n2', 'n3']);
    assert.equal(d3.edges.length, 3);

    const far = store.edges.neighbours(chain[0].id, { depth: 10 });
    assert.equal(far.nodes.length, 6, 'BFS stops at the component boundary');
    assert.ok(!far.nodes.some((n) => n.id === island.id));

    const capped = store.edges.neighbours(chain[0].id, { depth: 10, limit: 3 });
    assert.equal(capped.nodes.length, 3);
    assert.equal(capped.truncated, true, 'the limit must be reported, not hidden');

    const typed = store.edges.neighbours(chain[0].id, { depth: 10, types: ['project'] });
    assert.equal(typed.nodes.length, 1, 'type filter excludes every neighbour');

    const kinded = store.edges.neighbours(chain[0].id, { depth: 10, kinds: ['mentions'] });
    assert.equal(kinded.nodes.length, 1);
    assert.throws(() => store.edges.neighbours('note_ffffffffffffffffffffffff'), /not found/);
  });
});

test('neighbours closes the subgraph with edges between included nodes', async () => {
  await withStore('store-bfs-closure', async (store) => {
    const hub = store.create('note', { title: 'Hub' });
    const a = store.create('note', { title: 'A' });
    const b = store.create('note', { title: 'B' });
    store.edges.add({ from: hub.id, to: a.id, kind: 'links-to' });
    store.edges.add({ from: hub.id, to: b.id, kind: 'links-to' });
    store.edges.add({ from: a.id, to: b.id, kind: 'related' }); // sibling link

    const view = store.edges.neighbours(hub.id, { depth: 1 });
    assert.equal(view.nodes.length, 3);
    assert.equal(view.edges.length, 3, 'the A-B edge belongs in the picture');
  });
});

/* ------------------------------------------------------------------ files */

test('files are content-addressed, deduplicated and path-safe', async () => {
  await withStore('store-files', async (store, { home }) => {
    const buf = Buffer.from('Ein Dokument über Bären.', 'utf8');
    const put = store.files.put(buf, { name: 'baer.txt', mime: 'text/plain' });
    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(put.hash, expected);
    assert.equal(put.size, buf.length);
    assert.equal(put.path, path.join(paths.layout(home).files, expected.slice(0, 2), expected));
    assert.ok(fs.existsSync(put.path));

    const again = store.files.put(Buffer.from('Ein Dokument über Bären.', 'utf8'), { name: 'kopie.txt' });
    assert.equal(again.hash, put.hash, 'identical content is one blob');

    assert.deepEqual(store.files.read(put.hash), buf);
    assert.equal(store.files.has(put.hash), true);
    assert.equal(store.files.remove(put.hash), true);
    assert.equal(store.files.remove(put.hash), false, 'removing twice is not an error');
    assert.equal(store.files.has(put.hash), false);
    assert.throws(() => store.files.read(put.hash), /not found/);

    assert.throws(() => store.files.read('../../etc/passwd'), /Ungueltiger Datei-Hash/);
    assert.equal(store.files.has('../../etc/passwd'), false);
    assert.throws(() => store.files.put(undefined), /benoetigt einen Buffer/);

    const empty = store.files.put(Buffer.alloc(0));
    assert.equal(empty.size, 0);
    assert.equal(store.files.read(empty.hash).length, 0);
  });
});

/* ----------------------------------------------------- durability & crash */

test('a reopened store reproduces exactly what was written', async () => {
  await withStore('store-reload', async (store, { open }) => {
    const note = store.create('note', { title: 'Bleibt', body: 'Inhalt', tags: ['t'] });
    const task = store.create('task', { title: 'Aufgabe', status: 'doing' });
    store.update(task.id, { status: 'done' });
    const gone = store.create('note', { title: 'Verschwindet' });
    store.remove(gone.id);
    store.edges.add({ from: note.id, to: task.id, kind: 'related' });
    await store.close();

    const reopened = await open();
    assert.equal(reopened.recovery.recovered, 6, 'create, create, update, create, delete, edge');
    assert.equal(reopened.recovery.dropped, 0);
    assert.deepEqual(reopened.get(note.id), note);
    assert.equal(reopened.get(task.id).data.status, 'done');
    assert.equal(reopened.get(task.id).rev, 2);
    assert.equal(reopened.get(gone.id), null);
    assert.ok(reopened.get(gone.id, { includeDeleted: true }).deletedAt);
    assert.equal(reopened.count('edge'), 1);
    assert.equal(reopened.search('Inhalt').total, 1);
  });
});

test('an interrupted write only costs the torn line, never the vault', async () => {
  await withStore('store-torn', async (store, { home, open }) => {
    const kept = [];
    for (let i = 0; i < 4; i++) kept.push(store.create('note', { title: `Notiz ${i}` }));
    await store.close();

    // Simulate a crash in the middle of appending the last line.
    const file = logFiles(home)[0];
    const buf = fs.readFileSync(file);
    let lastLineStart = 0;
    for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x0a) lastLineStart = i + 1;
    const cutAt = lastLineStart + 30;
    assert.ok(cutAt < buf.length, 'the test must actually cut into the final line');
    fs.truncateSync(file, cutAt);

    const recovered = await open();
    assert.equal(recovered.recovery.dropped, 1);
    assert.ok(recovered.recovery.truncatedBytes > 0);
    assert.equal(recovered.count('note'), 3, 'everything before the torn line survives');
    for (let i = 0; i < 3; i++) assert.ok(recovered.get(kept[i].id));
    assert.equal(recovered.get(kept[3].id), null);

    // And the log must be writable again, on a clean line boundary.
    const fresh = recovered.create('note', { title: 'Nach dem Absturz' });
    await recovered.close();
    const third = await open();
    assert.equal(third.recovery.dropped, 0, 'the damage was repaired, not re-reported');
    assert.equal(third.count('note'), 4);
    assert.equal(third.get(fresh.id).data.title, 'Nach dem Absturz');
  });
});

test('damage in the middle of the log skips one line and keeps the rest', async () => {
  await withStore('store-midcorrupt', async (store, { home, open }) => {
    const a = store.create('note', { title: 'Eins' });
    const b = store.create('note', { title: 'Zwei' });
    const c = store.create('note', { title: 'Drei' });
    await store.close();

    const file = logFiles(home)[0];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    lines[1] = '{"v":1,"seq":2,"op":"crea';
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const sizeBefore = fs.statSync(file).size;

    const recovered = await open();
    assert.equal(recovered.recovery.dropped, 1);
    assert.equal(recovered.recovery.truncatedBytes, 0, 'mid-file damage must never truncate');
    assert.equal(fs.statSync(file).size, sizeBefore);
    assert.ok(recovered.get(a.id));
    assert.equal(recovered.get(b.id), null);
    assert.ok(recovered.get(c.id), 'lines after the damage are still replayed');
    assert.equal(recovered.recovery.corrupt.length, 1);
  });
});

test('a corrupt snapshot is set aside and the log rebuilds the state', async () => {
  await withStore('store-badsnapshot', async (store, { home, open }) => {
    const note = store.create('note', { title: 'Ueberlebt' });
    await store.close();
    fs.writeFileSync(paths.layout(home).snapshot, '{ kaputt');

    const recovered = await open();
    assert.ok(recovered.get(note.id), 'the log is the source of truth');
    assert.equal(recovered.recovery.corrupt[0].where, 'snapshot');
    const vaultDir = paths.layout(home).vault;
    assert.ok(fs.readdirSync(vaultDir).some((f) => f.startsWith('snapshot.json.corrupt-')), 'the broken file is kept');
  });
});

test('compact snapshots the state and truncates the log', async () => {
  await withStore('store-compact', async (store, { home, open }) => {
    store.transaction(() => {
      for (let i = 0; i < 50; i++) store.create('note', { title: `N${i}`, body: 'x'.repeat(100) });
    });
    const before = store.stats();
    assert.ok(before.bytes > 0);

    const result = await store.compact();
    assert.equal(result.records, 50);
    assert.ok(result.bytes > 0);
    assert.ok(fs.existsSync(paths.layout(home).snapshot));
    assert.equal(store.stats().logSegments, 0, 'the log is gone after a snapshot');

    const after = store.create('note', { title: 'Nach dem Snapshot' });
    await store.close();

    const reopened = await open();
    assert.equal(reopened.count('note'), 51);
    assert.equal(reopened.recovery.snapshotRecords, 50);
    assert.equal(reopened.recovery.recovered, 1, 'only the post-snapshot delta is replayed');
    assert.equal(reopened.get(after.id).data.title, 'Nach dem Snapshot');
  });
});

test('log lines written before a snapshot are not replayed twice', async () => {
  await withStore('store-nodouble', async (store, { open }) => {
    const note = store.create('note', { title: 'A' });
    store.update(note.id, { body: 'eins' });
    await store.compact();
    store.update(note.id, { body: 'zwei' });
    await store.close();

    const reopened = await open();
    assert.equal(reopened.get(note.id).data.body, 'zwei');
    assert.equal(reopened.get(note.id).rev, 3);
  });
});

test('automatic snapshots keep the log from growing without bound', async () => {
  await withStore('store-autosnapshot', async (store, { open }) => {
    for (let i = 0; i < 25; i++) store.create('note', { title: `N${i}` });
    assert.ok(store.stats().logSegments <= 1);
    await store.close();
    const reopened = await open({ snapshotEveryOps: 10 });
    assert.equal(reopened.count('note'), 25);
    assert.ok(reopened.recovery.snapshotRecords > 0 || reopened.recovery.recovered === 25);
  }, { snapshotEveryOps: 10 });
});

/* ----------------------------------------------------------- transactions */

test('a transaction writes once and rolls memory back when it throws', async () => {
  await withStore('store-tx', async (store, { open }) => {
    const created = store.transaction(() => {
      const a = store.create('note', { title: 'Tx A' });
      const b = store.create('note', { title: 'Tx B' });
      store.edges.add({ from: a.id, to: b.id, kind: 'related' });
      return [a, b];
    });
    assert.equal(created.length, 2);
    assert.equal(store.count('note'), 2);

    const before = store.create('note', { title: 'Vorher' });
    assert.throws(() => {
      store.transaction(() => {
        store.create('note', { title: 'Wird zurueckgerollt' });
        store.update(before.id, { body: 'auch zurueck' });
        store.remove(before.id);
        throw new Error('Abbruch');
      });
    }, /Abbruch/);

    assert.equal(store.count('note'), 3, 'nothing from the failed transaction remains');
    assert.deepEqual(store.get(before.id), before, 'the pre-transaction state is restored exactly');
    assert.equal(store.search('zurueckgerollt').total, 0, 'the search index rolled back too');

    await store.close();
    const reopened = await open();
    assert.equal(reopened.count('note'), 3);
    assert.equal(reopened.get(before.id).data.body, '');
  });
});

test('nested transactions join the outer one', async () => {
  await withStore('store-tx-nested', async (store) => {
    const value = store.transaction(() => {
      store.create('note', { title: 'aussen' });
      return store.transaction(() => {
        store.create('note', { title: 'innen' });
        return 42;
      });
    });
    assert.equal(value, 42);
    assert.equal(store.count('note'), 2);
  });
});

/* ------------------------------------------------------------ crypto seam */

test('vaultCrypto encrypts every log line and the snapshot body', async () => {
  const { home, cleanup } = tempHome('store-crypto');
  try {
    const vc = fakeCrypto();
    const store = await openStore({ paths: home, vaultCrypto: vc });
    const note = store.create('note', { title: 'Geheim', body: 'Vertraulich' });
    const blob = store.files.put(Buffer.from('Geheimer Anhang', 'utf8'));
    await store.compact();
    store.create('note', { title: 'Nach dem Snapshot' });
    await store.close();

    const raw = fs.readFileSync(logFiles(home)[0], 'utf8');
    assert.ok(!raw.includes('Nach dem Snapshot'), 'plaintext must not reach the log');
    const snapshotRaw = fs.readFileSync(paths.layout(home).snapshot, 'utf8');
    assert.ok(!snapshotRaw.includes('Vertraulich'), 'plaintext must not reach the snapshot');
    const blobRaw = fs.readFileSync(blob.path);
    assert.ok(!blobRaw.toString('utf8').includes('Geheimer Anhang'), 'plaintext must not reach the blob');

    const reopened = await openStore({ paths: home, vaultCrypto: fakeCrypto() });
    assert.equal(reopened.get(note.id).data.body, 'Vertraulich');
    assert.equal(reopened.count('note'), 2);
    assert.deepEqual(reopened.files.read(blob.hash), Buffer.from('Geheimer Anhang', 'utf8'));
    await reopened.close();

    // Opening an encrypted vault without the key must fail loudly, never
    // silently present an empty vault (which a later write would then destroy).
    await assert.rejects(() => openStore({ paths: home }), (err) => {
      assert.equal(err.code, 'VAULT_LOCKED');
      return true;
    });
  } finally {
    cleanup();
  }
});

test('a disabled vaultCrypto is the identity seam', async () => {
  const { home, cleanup } = tempHome('store-nocrypto');
  try {
    const vc = { ...fakeCrypto(), enabled: false };
    const store = await openStore({ paths: home, vaultCrypto: vc });
    const note = store.create('note', { title: 'Klartext' });
    await store.close();
    assert.ok(fs.readFileSync(logFiles(home)[0], 'utf8').includes('Klartext'));
    const reopened = await openStore({ paths: home });
    assert.equal(reopened.get(note.id).data.title, 'Klartext');
    await reopened.close();
  } finally {
    cleanup();
  }
});

/* -------------------------------------------------------------- bus, lock */

test('every mutation publishes a truthful bus event', async () => {
  const { home, cleanup } = tempHome('store-bus');
  try {
    const bus = new Bus();
    const seen = [];
    bus.subscribe((evt) => seen.push(evt.name));
    const store = await openStore({ paths: home, bus });

    const a = store.create('note', { title: 'A' });
    const b = store.create('note', { title: 'B' });
    store.update(a.id, { body: 'x' });
    store.edges.add({ from: a.id, to: b.id, kind: 'related' });
    store.remove(a.id);
    store.restore(a.id);

    assert.deepEqual(seen, [
      'record.created', 'record.created', 'record.updated',
      'record.created', 'edge.created',
      'record.deleted', 'record.updated',
    ]);
    const created = bus.recent.find((e) => e.name === 'edge.created');
    assert.equal(created.payload.edge.data.from, a.id);
    await store.close();
  } finally {
    cleanup();
  }
});

test('a vault held by another live process is refused, a stale lock is taken over', async () => {
  const { home, cleanup } = tempHome('store-lock');
  try {
    // The store guards the vault directory; home/.lock belongs to src/app.js.
    const lockPath = path.join(paths.layout(home).vault, '.lock');
    fs.mkdirSync(paths.layout(home).vault, { recursive: true });

    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
    await assert.rejects(() => openStore({ paths: home }), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      assert.match(err.message, /bereits von Prozess 1/);
      return true;
    });

    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, at: new Date().toISOString() }));
    const store = await openStore({ paths: home });
    assert.ok(store, 'a lock from a dead process must not brick the vault');
    await store.close();
    assert.equal(fs.existsSync(lockPath), false, 'close() releases the lock');
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------- stats and search */

test('stats reports what is really on disk', async () => {
  await withStore('store-stats', async (store) => {
    store.create('note', { title: 'A' });
    store.create('note', { title: 'B' });
    const p = store.create('project', { name: 'P' });
    store.edges.add({ from: p.id, to: store.create('task', { title: 'T' }).id, kind: 'belongs-to' });
    const s = store.stats();
    assert.equal(s.counts.note, 2);
    assert.equal(s.counts.project, 1);
    assert.equal(s.edges, 1);
    assert.equal(s.logSegments, 1);
    assert.ok(s.bytes > 0);
    assert.ok(s.lastWrite);
    assert.equal(s.encrypted, false);
  });
});

test('store.search returns records with scores and snippets', async () => {
  await withStore('store-search', async (store) => {
    store.create('note', { title: 'Backup-Strategie', body: 'Regelmässige Sicherung der Daten.', tags: ['infra'] });
    store.create('note', { title: 'Kochrezept', body: 'Zwiebeln anbraten.' });
    const hits = store.search('sicherung');
    assert.equal(hits.total, 1);
    assert.equal(hits.items[0].record.data.title, 'Backup-Strategie');
    assert.ok(hits.items[0].score > 0);
    assert.ok(hits.items[0].snippet.includes('\u0001'));
    assert.equal(store.search('sicherung', { types: ['task'] }).total, 0);
  });
});

/* -------------------------------------------------------------- endurance */

test('5000 records: create, reload and search stay correct and fast', async () => {
  await withStore('store-scale', async (store, { open }) => {
    const N = 5000;
    const words = ['Projekt', 'Notiz', 'Bericht', 'Übersicht', 'Straße', 'Messung', 'Analyse', 'Entwurf'];
    const t0 = Date.now();
    store.transaction(() => {
      for (let i = 0; i < N; i++) {
        store.create('note', {
          title: `${words[i % words.length]} ${i}`,
          body: `Inhalt ${i} über ${words[(i + 3) % words.length]} und Haushaltsgeraete.`,
          tags: i % 10 === 0 ? ['wichtig'] : ['routine'],
        });
      }
    });
    const writeMs = Date.now() - t0;
    assert.equal(store.count('note'), N);
    assert.ok(writeMs < 30000, `writing ${N} records took ${writeMs}ms`);

    const searched = store.search('haushalt', { limit: 5 });
    assert.equal(searched.total, N);
    assert.equal(searched.items.length, 5);

    const tagged = store.search('tag:wichtig', { limit: 1000 });
    assert.equal(tagged.total, N / 10);

    const before = store.list('note', { sort: 'title', order: 'asc', limit: 10 });
    await store.close();

    const t1 = Date.now();
    const reopened = await open();
    const loadMs = Date.now() - t1;
    assert.ok(loadMs < 30000, `loading ${N} records took ${loadMs}ms`);
    assert.equal(reopened.count('note'), N, 'crash consistency: the reload sees every record');
    assert.equal(reopened.recovery.dropped, 0);
    assert.deepEqual(
      reopened.list('note', { sort: 'title', order: 'asc', limit: 10 }).items,
      before.items,
      'the reloaded vault is byte-for-byte the same data',
    );
    assert.equal(reopened.search('haushalt', { limit: 5 }).total, N);
  });
});

test('a second store in the same process sees writes after they are flushed', async () => {
  await withStore('store-concurrent', async (store, { open }) => {
    const note = store.create('note', { title: 'Geteilt' });
    await store.flush();
    // Simulates a crash: the first store never closed, but its writes are
    // already durable, so a fresh open must find them.
    const observer = await open();
    assert.equal(observer.get(note.id).data.title, 'Geteilt');
    assert.equal(observer.recovery.dropped, 0);
  });
});

test('the log rotates into segments and replays across all of them', async () => {
  await withStore('store-rotate', async (store, { home, open }) => {
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push(store.create('note', { title: `N${i}`, body: 'x'.repeat(200) }).id);
    assert.ok(logFiles(home).length > 1, 'the log must actually have rotated');
    assert.deepEqual(
      logFiles(home).map((f) => path.basename(f)),
      logFiles(home).map((f) => path.basename(f)).slice().sort(),
      'segments are named so that lexical order is chronological order',
    );
    await store.close();

    const reopened = await open({ segmentMaxBytes: 2048 });
    assert.equal(reopened.count('note'), 40, 'every segment is replayed');
    assert.equal(reopened.recovery.dropped, 0);
    assert.ok(reopened.recovery.segments > 1);
    for (const id of ids) assert.ok(reopened.get(id));
  }, { segmentMaxBytes: 2048, snapshotEveryOps: 0 });
});

test('damage in an older segment never truncates it away', async () => {
  await withStore('store-oldsegment', async (store, { home, open }) => {
    for (let i = 0; i < 40; i++) store.create('note', { title: `N${i}`, body: 'x'.repeat(200) });
    await store.close();
    const files = logFiles(home);
    assert.ok(files.length > 1);

    const first = files[0];
    const lines = fs.readFileSync(first, 'utf8').split('\n').filter(Boolean);
    lines[0] = 'voellig kaputt';
    fs.writeFileSync(first, `${lines.join('\n')}\n`);
    const sizeBefore = fs.statSync(first).size;

    const reopened = await open({ segmentMaxBytes: 2048 });
    assert.equal(reopened.count('note'), 39, 'exactly one record was lost');
    assert.equal(reopened.recovery.dropped, 1);
    assert.equal(reopened.recovery.truncatedBytes, 0);
    assert.equal(fs.statSync(first).size, sizeBefore, 'an old segment is never shortened');
  }, { segmentMaxBytes: 2048, snapshotEveryOps: 0 });
});

test('restoring an edge cannot create a second edge behind one dedupe key', async () => {
  await withStore('store-edge-restore', async (store) => {
    const a = store.create('note', { title: 'A' });
    const b = store.create('note', { title: 'B' });
    const first = store.edges.add({ from: a.id, to: b.id, kind: 'related' });
    store.edges.remove(first.id);
    const second = store.edges.add({ from: a.id, to: b.id, kind: 'related' });

    const restored = store.restore(first.id);
    assert.equal(restored.id, second.id, 'the live twin is returned instead');
    assert.equal(store.count('edge'), 1);
    assert.equal(store.edges.between(a.id, b.id).length, 1);
  });
});

test('an edge whose endpoint was purged cannot be restored', async () => {
  await withStore('store-edge-orphan', async (store) => {
    const a = store.create('note', { title: 'A' });
    const b = store.create('note', { title: 'B' });
    const edge = store.edges.add({ from: a.id, to: b.id, kind: 'related' });
    store.edges.remove(edge.id);
    store.remove(b.id, { hard: true });
    assert.throws(() => store.restore(edge.id), /Endpunkt fehlt/);
  });
});

test('a closed store refuses further writes instead of losing them', async () => {
  const { home, cleanup } = tempHome('store-closed');
  try {
    const store = await openStore({ paths: home });
    store.create('note', { title: 'A' });
    await store.close();
    await store.close(); // idempotent
    assert.equal(store.closed, true);
    assert.throws(() => store.create('note', { title: 'B' }), /bereits geschlossen/);
    assert.equal(store.count('note'), 1, 'reads still work on the in-memory snapshot');
  } finally {
    cleanup();
  }
});

module.exports = { name: 'store', tests: drain() };
