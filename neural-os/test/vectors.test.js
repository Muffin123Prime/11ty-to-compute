'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');

const pathsMod = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { createVectorStore, __internals } = require('../src/store/vectors');
const { createVaultCrypto } = require('../src/store/vaultcrypto');

/**
 * Vector store tests.
 *
 * The properties that actually matter here are not "does put() store a thing"
 * but: does a model change get CAUGHT (mixing two models produces plausible
 * nonsense), does the index survive a restart byte for byte, and does a brute
 * force scan stay fast enough at realistic size. Those three get the most work.
 */

function makeStore(label = 'vec', extra = {}) {
  const { home, cleanup } = tempHome(label);
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  return { home, paths, cleanup, store: createVectorStore({ paths, ...extra }) };
}

/** Deterministic pseudo-random unit-ish vectors; no Math.random in tests. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomVector(dim, seed) {
  const next = seeded(seed);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = next() * 2 - 1;
  return out;
}

test('vectors are normalised on write so search is a plain dot product', () => {
  const { store, cleanup } = makeStore('vec-norm');
  try {
    store.put('a', [3, 4], { model: 'm' });
    const got = store.get('a');
    assert.equal(got.dim, 2);
    // 3/5, 4/5 -- the raw magnitude is deliberately not preserved.
    assert.ok(Math.abs(got.vector[0] - 0.6) < 1e-6, `expected 0.6, got ${got.vector[0]}`);
    assert.ok(Math.abs(got.vector[1] - 0.8) < 1e-6, `expected 0.8, got ${got.vector[1]}`);
    const norm = Math.hypot(got.vector[0], got.vector[1]);
    assert.ok(Math.abs(norm - 1) < 1e-6, `stored vector must be a unit vector, norm was ${norm}`);
    // An unnormalised query must still score 1.0 against a parallel vector.
    const [hit] = store.search([30, 40], { limit: 1 });
    assert.equal(hit.id, 'a');
    assert.ok(Math.abs(hit.score - 1) < 1e-6);
  } finally {
    cleanup();
  }
});

test('search ranks by cosine similarity and honours limit and minScore', () => {
  const { store, cleanup } = makeStore('vec-rank');
  try {
    store.put('near', [1, 0.1, 0], { model: 'm', type: 'note' });
    store.put('far', [0, 1, 0], { model: 'm', type: 'note' });
    store.put('opposite', [-1, 0, 0], { model: 'm', type: 'note' });
    const hits = store.search([1, 0, 0], { limit: 3 });
    assert.deepEqual(hits.map((h) => h.id), ['near', 'far', 'opposite']);
    assert.ok(hits[0].score > hits[1].score && hits[1].score > hits[2].score);
    assert.equal(store.search([1, 0, 0], { limit: 1 })[0].id, 'near');
    assert.deepEqual(store.search([1, 0, 0], { minScore: 0.5, limit: 10 }).map((h) => h.id), ['near']);
  } finally {
    cleanup();
  }
});

test('search filters by type and by explicit id set', () => {
  const { store, cleanup } = makeStore('vec-filter');
  try {
    store.put('n1', [1, 0, 0], { model: 'm', type: 'note' });
    store.put('t1', [0.99, 0.1, 0], { model: 'm', type: 'task' });
    store.put('n2', [0.9, 0.2, 0], { model: 'm', type: 'note' });
    assert.deepEqual(store.search([1, 0, 0], { filter: { types: ['task'] }, limit: 5 }).map((h) => h.id), ['t1']);
    assert.deepEqual(
      store.search([1, 0, 0], { filter: { types: ['note'] }, limit: 5 }).map((h) => h.id),
      ['n1', 'n2'],
    );
    assert.deepEqual(store.search([1, 0, 0], { filter: (id) => id === 'n2', limit: 5 }).map((h) => h.id), ['n2']);
  } finally {
    cleanup();
  }
});

test('a vector that would poison the index is refused, not stored', () => {
  const { store, cleanup } = makeStore('vec-bad');
  try {
    assert.throws(() => store.put('z', [0, 0, 0], { model: 'm' }), /Nullvektor/);
    assert.throws(() => store.put('n', [1, NaN, 0], { model: 'm' }), /Position 1/);
    assert.throws(() => store.put('i', [1, Infinity], { model: 'm' }), /Position 1/);
    assert.throws(() => store.put('e', [], { model: 'm' }), /leer/);
    assert.throws(() => store.put('s', 'nicht-ein-vektor', { model: 'm' }), /Zahlen-Array/);
    assert.equal(store.size(), 0, 'nothing may have been written');
  } finally {
    cleanup();
  }
});

test('a different dimension is detected and answered with a reindex instruction', () => {
  const { store, cleanup } = makeStore('vec-dim');
  try {
    store.put('a', [1, 0, 0], { model: 'nomic-embed-text' });
    assert.throws(
      () => store.put('b', [1, 0, 0, 0], { model: 'nomic-embed-text' }),
      (err) => {
        assert.equal(err.code, 'STORAGE_ERROR');
        assert.equal(err.details.action, 'reindex');
        assert.match(err.message, /neu indizieren/);
        assert.match(err.message, /3 Dimensionen/);
        return true;
      },
    );
    assert.equal(store.size(), 1);
    const compat = store.compatible({ model: 'nomic-embed-text', dim: 4 });
    assert.equal(compat.ok, false);
    assert.equal(compat.current.dim, 3);
  } finally {
    cleanup();
  }
});

test('a different model with the same dimension is detected too', () => {
  const { store, cleanup } = makeStore('vec-model');
  try {
    store.put('a', [1, 0, 0], { model: 'nomic-embed-text' });
    assert.throws(
      () => store.put('b', [0, 1, 0], { model: 'mxbai-embed-large' }),
      (err) => {
        assert.match(err.message, /nomic-embed-text/);
        assert.match(err.message, /mxbai-embed-large/);
        assert.match(err.message, /neu indizieren/);
        return true;
      },
    );
    assert.equal(store.compatible({ model: 'mxbai-embed-large', dim: 3 }).ok, false);
    // A reindex is the sanctioned way out, and it adopts the new model.
    store.reset({ model: 'mxbai-embed-large', dim: 3 });
    assert.equal(store.size(), 0);
    store.put('b', [0, 1, 0], { model: 'mxbai-embed-large' });
    assert.equal(store.model(), 'mxbai-embed-large');
  } finally {
    cleanup();
  }
});

test('index survives a restart with vectors, hashes and types intact', async () => {
  const { paths, cleanup } = makeStore('vec-persist');
  try {
    const first = createVectorStore({ paths });
    first.put('note_a', [1, 0, 0, 0], { model: 'nomic-embed-text', hash: 'aaa', type: 'note', updatedAt: '2026-01-01T00:00:00.000Z' });
    first.put('note_b', [0, 1, 0, 0], { model: 'nomic-embed-text', hash: 'bbb', type: 'note' });
    await first.flush();
    await first.close();

    assert.ok(fs.existsSync(path.join(paths.vault, 'vectors.bin')));
    assert.ok(fs.existsSync(path.join(paths.vault, 'vectors.json')));

    const second = createVectorStore({ paths });
    assert.equal(second.size(), 2);
    assert.equal(second.dim(), 4);
    assert.equal(second.model(), 'nomic-embed-text');
    assert.equal(second.meta('note_a').hash, 'aaa');
    assert.equal(second.meta('note_a').type, 'note');
    assert.equal(second.meta('note_a').updatedAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(second.ids().sort(), ['note_a', 'note_b']);
    const [hit] = second.search([1, 0, 0, 0], { limit: 1 });
    assert.equal(hit.id, 'note_a');
    assert.ok(Math.abs(hit.score - 1) < 1e-6, 'floats must survive the round trip bit for bit');
  } finally {
    cleanup();
  }
});

test('removing entries leaves reusable gaps and compact() closes them', async () => {
  const { paths, cleanup } = makeStore('vec-compact');
  try {
    const store = createVectorStore({ paths });
    for (let i = 0; i < 5; i++) store.put(`v${i}`, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i], { model: 'm' });
    assert.equal(store.size(), 5);
    assert.equal(store.remove('v1'), true);
    assert.equal(store.remove('v3'), true);
    assert.equal(store.remove('v1'), false, 'removing twice must be honest about it');
    assert.equal(store.size(), 3);
    assert.equal(store.info().freeSlots, 2);
    assert.equal(store.has('v1'), false);
    assert.equal(store.get('v1'), null);

    const before = store.search([0, 0, 1], { limit: 5 }).map((h) => h.id);
    const result = store.compact();
    assert.equal(result.freedSlots, 2);
    assert.equal(result.slots, 3);
    assert.equal(store.info().freeSlots, 0);
    assert.deepEqual(store.search([0, 0, 1], { limit: 5 }).map((h) => h.id), before, 'compacting must not change results');

    await store.flush();
    const reloaded = createVectorStore({ paths });
    assert.equal(reloaded.size(), 3);
    assert.deepEqual(reloaded.ids().sort(), ['v0', 'v2', 'v4']);
  } finally {
    cleanup();
  }
});

test('a recycled slot never hands back the removed vector', () => {
  const { store, cleanup } = makeStore('vec-recycle');
  try {
    store.put('old', [1, 0, 0], { model: 'm' });
    store.put('keep', [0, 1, 0], { model: 'm' });
    store.remove('old');
    store.put('new', [0, 0, 1], { model: 'm' });
    const hits = store.search([1, 0, 0], { limit: 5 });
    assert.equal(hits.find((h) => h.id === 'old'), undefined);
    assert.ok(hits.every((h) => h.score < 0.5), `no vector should still point at the old direction: ${JSON.stringify(hits)}`);
  } finally {
    cleanup();
  }
});

test('an encrypted vault stores vectors as ciphertext and reads them back', async () => {
  const { home, paths, cleanup } = makeStore('vec-crypt');
  try {
    const config = configMod.defaults();
    const vaultCrypto = createVaultCrypto({ paths, config });
    await vaultCrypto.initialise('ein-sehr-geheimes-passwort');
    assert.equal(vaultCrypto.state, 'unlocked');

    const store = createVectorStore({ paths, vaultCrypto });
    store.put('a', [1, 0, 0, 0], { model: 'm', hash: 'geheim-hash' });
    store.put('b', [0, 1, 0, 0], { model: 'm' });
    await store.flush();

    const rawMeta = fs.readFileSync(path.join(paths.vault, 'vectors.json'));
    assert.notEqual(rawMeta[0], 0x7b, 'the manifest must not start as plain JSON when encryption is on');
    assert.equal(rawMeta.includes(Buffer.from('geheim-hash', 'utf8')), false, 'plaintext must not be on disk');
    const rawBin = fs.readFileSync(path.join(paths.vault, 'vectors.bin'));
    assert.equal(rawBin.length, 2 * 4 * 4 + 12 + 16, 'iv + tag must precede the ciphertext');

    const reopened = createVectorStore({ paths, vaultCrypto });
    assert.equal(reopened.size(), 2);
    assert.equal(reopened.meta('a').hash, 'geheim-hash');
    assert.equal(reopened.search([1, 0, 0, 0], { limit: 1 })[0].id, 'a');

    // A locked vault is a locked vault -- not a damaged index.
    vaultCrypto.lock();
    const locked = createVectorStore({ paths, vaultCrypto });
    assert.equal(locked.info().state, 'locked');
    assert.throws(() => locked.size(), (err) => {
      assert.equal(err.code, 'VAULT_LOCKED');
      return true;
    });
    assert.ok(home);
  } finally {
    cleanup();
  }
});

test('a damaged index refuses to answer and offers a reindex', async () => {
  const { paths, cleanup } = makeStore('vec-damaged');
  try {
    const store = createVectorStore({ paths });
    store.put('a', [1, 0, 0], { model: 'm' });
    await store.flush();
    fs.writeFileSync(path.join(paths.vault, 'vectors.json'), '{ kaputt');

    const broken = createVectorStore({ paths });
    const info = broken.info();
    assert.equal(info.state, 'damaged');
    assert.match(info.problem, /JSON/);
    for (const call of [() => broken.size(), () => broken.search([1, 0, 0]), () => broken.put('b', [0, 1, 0])]) {
      assert.throws(call, (err) => {
        assert.equal(err.code, 'STORAGE_ERROR');
        assert.equal(err.details.action, 'reindex');
        assert.match(err.message, /neu indizieren/);
        return true;
      });
    }
    // Recovery must be possible without deleting files by hand.
    broken.reset({ model: 'm', dim: 3 });
    broken.put('a', [1, 0, 0], { model: 'm' });
    assert.equal(broken.size(), 1);
    assert.equal(broken.info().state, 'ok');
  } finally {
    cleanup();
  }
});

test('a truncated matrix file is caught instead of read as garbage', async () => {
  const { paths, cleanup } = makeStore('vec-trunc');
  try {
    const store = createVectorStore({ paths });
    store.put('a', [1, 0, 0], { model: 'm' });
    store.put('b', [0, 1, 0], { model: 'm' });
    await store.flush();
    const bin = path.join(paths.vault, 'vectors.bin');
    fs.truncateSync(bin, 8);
    const broken = createVectorStore({ paths });
    assert.equal(broken.info().state, 'damaged');
    assert.match(broken.info().problem, /zu kurz/);
  } finally {
    cleanup();
  }
});

test('a query with the wrong dimension is named as such, not silently empty', () => {
  const { store, cleanup } = makeStore('vec-qdim');
  try {
    store.put('a', [1, 0, 0], { model: 'm' });
    assert.throws(() => store.search([1, 0], { limit: 1 }), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /anderen Einbettungsmodell/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test('5000 vectors of 768 dimensions stay searchable under 150 ms', () => {
  const { store, cleanup } = makeStore('vec-perf');
  try {
    const dim = 768;
    const count = 5000;
    for (let i = 0; i < count; i++) {
      store.put(`v${i}`, randomVector(dim, i + 1), { model: 'nomic-embed-text', type: i % 2 ? 'note' : 'task' });
    }
    assert.equal(store.size(), count);
    assert.equal(store.dim(), dim);

    const query = randomVector(dim, 999999);
    store.search(query, { limit: 10 }); // warm up the JIT; the contract is about steady state
    const started = process.hrtime.bigint();
    const hits = store.search(query, { limit: 10 });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(hits.length, 10);
    assert.ok(hits[0].score >= hits[9].score);
    assert.ok(ms < 150, `Suche über ${count} Vektoren dauerte ${ms.toFixed(1)} ms (Grenze 150 ms)`);
  } finally {
    cleanup();
  }
});

test('autoFlushMs coalesces writes for callers that index in bursts', async () => {
  const { paths, cleanup } = makeStore('vec-auto');
  try {
    const store = createVectorStore({ paths, autoFlushMs: 15 });
    for (let i = 0; i < 20; i++) store.put(`v${i}`, [i + 1, 1, 1], { model: 'm' });
    assert.equal(fs.existsSync(path.join(paths.vault, 'vectors.bin')), false, 'nothing may be written yet');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fs.existsSync(path.join(paths.vault, 'vectors.bin')), true, 'the debounce must have written once');
    assert.equal(store.info().dirty, false);
    assert.equal(createVectorStore({ paths }).size(), 20);
    await store.close();
  } finally {
    cleanup();
  }
});

test('internal helpers hold the numeric guarantees the index relies on', () => {
  const unit = __internals.normalise(Float64Array.from([1, 1, 1, 1]));
  assert.ok(Math.abs(unit[0] - 0.5) < 1e-6);
  const top = [];
  __internals.pushTop(top, 2, 'a', 0.1);
  __internals.pushTop(top, 2, 'b', 0.9);
  __internals.pushTop(top, 2, 'c', 0.5);
  assert.deepEqual(top.map((t) => t.id), ['b', 'c']);
  const floats = Float32Array.from([1.5, -2.25]);
  const bytes = __internals.floatsToBytes(floats, 2);
  assert.deepEqual([...__internals.bytesToFloats(Buffer.from(bytes), 2)], [1.5, -2.25]);
});

module.exports = { name: 'vectors', tests: drain() };
