'use strict';

const assert = require('node:assert/strict');

const { test, drain, tempHome, fakeServer } = require('./harness');

const pathsMod = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { openStore } = require('../src/store/engine');
const { createVectorStore } = require('../src/store/vectors');
const { createRegistry } = require('../src/models/registry');
const { createEmbeddings, __internals } = require('../src/models/embeddings');
const { NetworkBlockedError } = require('../src/kernel/errors');

/**
 * Embedding service tests.
 *
 * Nothing here talks to a real model. The fake Ollama returns a deterministic
 * bag-of-words vector: texts that share words end up close, texts that share
 * none end up orthogonal. That makes "similar texts are found" an assertion
 * about real cosine arithmetic instead of a mock returning a canned answer.
 *
 * The two properties under the most scrutiny are the honest failures: no
 * embedding model must produce a NoModelError with installation instructions
 * (never a silent keyword fallback), and a model change must be detected
 * (never a mixed index that answers plausibly and wrongly).
 */

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || LOOPBACK_V4.test(h);
}

/** Stand-in gate: a scope is mandatory and nothing but loopback is dialled. */
function testGate() {
  const calls = [];
  return {
    calls,
    classify(host) {
      return isLoopback(host) ? 'loopback' : 'public';
    },
    async fetch(url, init = {}) {
      if (typeof init.scope !== 'string' || !init.scope) {
        throw new Error('gate.fetch wurde ohne scope aufgerufen');
      }
      const target = new URL(url);
      calls.push({ url, scope: init.scope, purpose: init.purpose, method: init.method || 'GET' });
      if (!isLoopback(target.hostname)) {
        throw new NetworkBlockedError(`Blockiert: ${target.hostname} ist nicht loopback`);
      }
      return fetch(url, {
        method: init.method || 'GET',
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      });
    },
  };
}

/** Bag-of-words vector: shared vocabulary means a high cosine similarity. */
function fakeVector(text, dim) {
  const out = new Array(dim).fill(0);
  const tokens = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    out[(h >>> 0) % dim] += 1;
  }
  if (!tokens.length) out[0] = 1;
  return out;
}

const CHAT_MODEL = { model: 'llama3.2:latest', name: 'llama3.2:latest', size: 2000000000, details: {} };
const EMBED_MODEL = { model: 'nomic-embed-text:latest', name: 'nomic-embed-text:latest', size: 274000000, details: {} };

/**
 * A fake Ollama. `state` is live: a test can swap the model list or make the
 * next embedding call fail and see how the service reacts.
 */
async function ollamaStub(initial = {}) {
  const state = {
    models: initial.models || [CHAT_MODEL, EMBED_MODEL],
    dims: initial.dims || { 'nomic-embed-text:latest': 32 },
    defaultDim: initial.defaultDim || 32,
    embedCalls: [],
    tagCalls: 0,
    legacyOnly: initial.legacyOnly === true,
    failOn: initial.failOn || null,
    onEmbed: initial.onEmbed || null,
    delayMs: initial.delayMs || 0,
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });

  const send = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };

  const server = await fakeServer(async (req, res) => {
    if (req.url === '/api/tags') {
      state.tagCalls++;
      return send(res, 200, { models: state.models });
    }
    if (req.url === '/api/embed' && req.method === 'POST') {
      if (state.legacyOnly) return send(res, 404, { error: 'not found' });
      const body = await readJson(req);
      state.embedCalls.push(body);
      if (state.onEmbed) await state.onEmbed(state, body);
      if (state.failOn && body.input.some((t) => String(t).includes(state.failOn))) {
        return send(res, 500, { error: 'das Modell ist explodiert' });
      }
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      const dim = state.dims[body.model] || state.defaultDim;
      return send(res, 200, { embeddings: body.input.map((t) => fakeVector(t, dim)) });
    }
    if (req.url === '/api/embeddings' && req.method === 'POST') {
      const body = await readJson(req);
      state.embedCalls.push({ model: body.model, input: [body.prompt], legacy: true });
      const dim = state.dims[body.model] || state.defaultDim;
      return send(res, 200, { embedding: fakeVector(body.prompt, dim) });
    }
    return send(res, 404, { error: `unbekannter Pfad ${req.url}` });
  });

  return { ...server, state };
}

/** Everything a test needs, wired the way app.js would wire it. */
async function harness(opts = {}) {
  const backend = await ollamaStub(opts.server || {});
  const { home, cleanup } = tempHome('emb');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.models.providers = [{ id: 'ollama', kind: 'ollama', baseUrl: backend.url, enabled: true }];
  if (opts.embeddingsConfig) config.models.embeddings = opts.embeddingsConfig;

  const bus = new Bus();
  const gate = testGate();
  const registry = opts.registry === null ? null : createRegistry({ config, gate, bus });
  const store = await openStore({ paths, bus });
  const vectors = createVectorStore({ paths });
  const embeddings = createEmbeddings({
    registry: opts.registryOverride ? opts.registryOverride(registry) : registry,
    gate,
    config,
    store,
    bus,
    vectors,
  });

  return {
    backend,
    paths,
    config,
    bus,
    gate,
    registry,
    store,
    vectors,
    embeddings,
    async cleanup() {
      await store.close();
      await vectors.close();
      await backend.close();
      cleanup();
    },
  };
}

function note(store, title, body) {
  return store.create('note', { title, body });
}

// ---------------------------------------------------------------------------

test('without an embedding model every entry point says so and offers the fix', async () => {
  const h = await harness({ server: { models: [CHAT_MODEL] } });
  try {
    const available = await h.embeddings.available();
    assert.equal(available.ok, false);
    assert.equal(available.model, null);
    assert.match(available.reason, /Keines der installierten Modelle ist ein Einbettungsmodell/);
    assert.match(available.reason, /ollama pull nomic-embed-text/);

    const record = note(h.store, 'Test', 'Inhalt');
    for (const call of [
      () => h.embeddings.embed(['hallo']),
      () => h.embeddings.search('hallo'),
      () => h.embeddings.indexRecord(record),
      () => h.embeddings.reindexAll(),
    ]) {
      await assert.rejects(call, (err) => {
        assert.equal(err.code, 'NO_MODEL_AVAILABLE');
        assert.match(err.message, /ollama pull nomic-embed-text/);
        assert.match(err.message, /nicht heimlich auf die Stichwortsuche aus/);
        return true;
      });
    }
    assert.equal(h.vectors.size(), 0, 'nothing may have been written without a model');
  } finally {
    await h.cleanup();
  }
});

test('an unreachable backend is reported as unreachable, not as "no model"-less detail', async () => {
  const h = await harness();
  try {
    await h.backend.close();
    const available = await h.embeddings.available({ refresh: true });
    assert.equal(available.ok, false);
    assert.match(available.reason, /Kein Modellanbieter ist erreichbar/);
    assert.match(available.reason, /ollama/);
  } finally {
    await h.cleanup();
  }
});

test('available() finds the preferred model and learns its dimension', async () => {
  const h = await harness();
  try {
    const available = await h.embeddings.available();
    assert.equal(available.ok, true);
    assert.equal(available.model, 'nomic-embed-text:latest');
    assert.equal(available.provider, 'ollama');
    assert.equal(available.dim, 32);
    assert.equal(available.reason, null);
    // Asking twice must not cost another round trip.
    const before = h.backend.state.embedCalls.length;
    await h.embeddings.available();
    assert.equal(h.backend.state.embedCalls.length, before);
  } finally {
    await h.cleanup();
  }
});

test('the preference order picks nomic over a merely embed-shaped name', async () => {
  const h = await harness({
    server: {
      models: [
        { model: 'some-embedder:latest', name: 'some-embedder:latest', details: {} },
        { model: 'all-minilm:latest', name: 'all-minilm:latest', details: {} },
        EMBED_MODEL,
      ],
      dims: { 'nomic-embed-text:latest': 32, 'all-minilm:latest': 16, 'some-embedder:latest': 8 },
    },
  });
  try {
    assert.equal((await h.embeddings.available()).model, 'nomic-embed-text:latest');
  } finally {
    await h.cleanup();
  }
});

test('a configured model wins, and a missing configured model is named', async () => {
  const chosen = await harness({
    server: {
      models: [EMBED_MODEL, { model: 'all-minilm:latest', name: 'all-minilm:latest', details: {} }],
      dims: { 'nomic-embed-text:latest': 32, 'all-minilm:latest': 16 },
    },
    embeddingsConfig: { model: 'all-minilm' },
  });
  try {
    const available = await chosen.embeddings.available();
    assert.equal(available.model, 'all-minilm:latest');
    assert.equal(available.dim, 16);
  } finally {
    await chosen.cleanup();
  }

  const missing = await harness({ embeddingsConfig: { model: 'bge-m3' } });
  try {
    const available = await missing.embeddings.available();
    assert.equal(available.ok, false);
    assert.match(available.reason, /"bge-m3" ist bei keinem erreichbaren Anbieter installiert/);
  } finally {
    await missing.cleanup();
  }
});

test('embed() batches, keeps input order and returns Float32Array', async () => {
  const h = await harness();
  try {
    const texts = ['eins', 'zwei', 'drei', 'vier', 'fuenf'];
    const vectors = await h.embeddings.embed(texts, { batchSize: 2 });
    assert.equal(vectors.length, 5);
    assert.ok(vectors[0] instanceof Float32Array);
    assert.equal(vectors[0].length, 32);
    // 5 texts at 2 per request = 3 requests (plus the one dimension probe).
    const batches = h.backend.state.embedCalls.filter((c) => c.input.length > 1 || c.input[0] !== 'neural-os');
    assert.deepEqual(batches.map((b) => b.input), [['eins', 'zwei'], ['drei', 'vier'], ['fuenf']]);
    for (let i = 0; i < texts.length; i++) {
      assert.deepEqual([...vectors[i]], fakeVector(texts[i], 32), `Vektor ${i} gehört zu Text ${i}`);
    }
  } finally {
    await h.cleanup();
  }
});

test('semantic search finds the text that means the same thing', async () => {
  const h = await harness();
  try {
    const hund = note(h.store, 'Nachbarschaft', 'Der Hund bellt laut im Garten der Nachbarn');
    const hund2 = note(h.store, 'Notiz', 'Unser Nachbar hat einen Hund der im Garten bellt');
    const steuer = note(h.store, 'Finanzen', 'Die Steuererklaerung muss bis Juli beim Finanzamt sein');

    const result = await h.embeddings.reindexAll();
    assert.equal(result.indexed, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.model, 'nomic-embed-text:latest');
    assert.ok(result.ms >= 0);

    const hits = await h.embeddings.search('Hund im Garten', { limit: 3 });
    assert.equal(hits.length, 3);
    assert.ok([hund.id, hund2.id].includes(hits[0].id), `erwartet eine Hunde-Notiz, bekam ${hits[0].id}`);
    assert.ok([hund.id, hund2.id].includes(hits[1].id));
    assert.equal(hits[2].id, steuer.id, 'die inhaltlich fremde Notiz muss hinten stehen');
    assert.ok(hits[0].score > hits[2].score + 0.3, `Abstand zu klein: ${JSON.stringify(hits)}`);

    const taxHits = await h.embeddings.search('Finanzamt Steuererklaerung', { limit: 1 });
    assert.equal(taxHits[0].id, steuer.id);
  } finally {
    await h.cleanup();
  }
});

test('search filters by type and respects minScore', async () => {
  const h = await harness();
  try {
    const n = note(h.store, 'Kochen', 'Nudeln mit Tomatensauce und Basilikum');
    h.store.create('task', { title: 'Nudeln kaufen', body: 'Tomatensauce und Basilikum besorgen' });
    await h.embeddings.reindexAll();

    const onlyNotes = await h.embeddings.search('Nudeln Tomatensauce', { types: ['note'], limit: 5 });
    assert.deepEqual(onlyNotes.map((x) => x.id), [n.id]);
    const onlyTasks = await h.embeddings.search('Nudeln Tomatensauce', { types: ['task'], limit: 5 });
    assert.equal(onlyTasks.length, 1);
    assert.notEqual(onlyTasks[0].id, n.id);

    const strict = await h.embeddings.search('voellig anderes Thema Quantenphysik', { minScore: 0.9, limit: 5 });
    assert.deepEqual(strict, [], 'minScore muss wirklich filtern');
  } finally {
    await h.cleanup();
  }
});

test('unchanged text is never embedded twice', async () => {
  const h = await harness();
  try {
    const record = note(h.store, 'Stabil', 'Dieser Text aendert sich nicht');
    await h.embeddings.reindexAll();
    const afterFirst = h.backend.state.embedCalls.length;

    const second = await h.embeddings.reindexAll();
    assert.equal(second.indexed, 0);
    assert.equal(second.skipped, 1);
    assert.equal(h.backend.state.embedCalls.length, afterFirst, 'ein unveraenderter Text darf kein Modell kosten');

    const again = await h.embeddings.indexRecord(h.store.get(record.id));
    assert.equal(again.skipped, true);
    assert.match(again.reason, /unveraendert|unverändert/);

    const changed = h.store.update(record.id, { body: 'Jetzt steht hier etwas ganz anderes' });
    const reindexed = await h.embeddings.indexRecord(changed);
    assert.equal(reindexed.indexed, true);
    assert.ok(h.backend.state.embedCalls.length > afterFirst);
  } finally {
    await h.cleanup();
  }
});

test('a record without text and a deleted record leave no vector behind', async () => {
  const h = await harness();
  try {
    const keep = note(h.store, 'Bleibt', 'Inhalt mit Bedeutung');
    const gone = note(h.store, 'Verschwindet', 'Wird gleich geloescht');
    await h.embeddings.reindexAll();
    assert.equal(h.vectors.size(), 2);

    h.store.remove(gone.id);
    const result = await h.embeddings.reindexAll();
    assert.equal(result.removed, 1);
    assert.equal(h.vectors.has(gone.id), false);
    assert.equal(h.vectors.size(), 1);

    assert.equal(await h.embeddings.removeRecord(keep.id), true);
    assert.equal(await h.embeddings.removeRecord(keep.id), false);
    assert.equal(h.vectors.size(), 0);
  } finally {
    await h.cleanup();
  }
});

test('a model change invalidates the index instead of mixing two models', async () => {
  const h = await harness();
  try {
    note(h.store, 'Erste', 'Ein Text ueber Gartenarbeit und Rosen');
    await h.embeddings.reindexAll();
    assert.equal(h.vectors.model(), 'nomic-embed-text:latest');
    assert.equal(h.vectors.dim(), 32);

    // The user pulls a different embedding model and removes the old one.
    h.backend.state.models = [CHAT_MODEL, { model: 'mxbai-embed-large:latest', name: 'mxbai-embed-large:latest', details: {} }];
    h.backend.state.dims = { 'mxbai-embed-large:latest': 24 };
    await h.registry.refresh();

    const record = h.store.all('note')[0];
    for (const call of [
      () => h.embeddings.search('Rosen', { refresh: true }),
      () => h.embeddings.indexRecord(record),
    ]) {
      await assert.rejects(call, (err) => {
        assert.equal(err.code, 'STORAGE_ERROR');
        assert.equal(err.details.action, 'reindex');
        assert.match(err.message, /neu indizieren/);
        assert.match(err.message, /plausibel/);
        return true;
      });
    }

    // Reindexing is the sanctioned way out and adopts the new model.
    const result = await h.embeddings.reindexAll();
    assert.equal(result.reset, true);
    assert.equal(result.indexed, 1);
    assert.equal(h.vectors.model(), 'mxbai-embed-large:latest');
    assert.equal(h.vectors.dim(), 24);
    const hits = await h.embeddings.search('Gartenarbeit Rosen', { limit: 1 });
    assert.equal(hits.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('searching an empty index says so instead of returning no hits', async () => {
  const h = await harness();
  try {
    note(h.store, 'Da', 'Es gibt Notizen, aber keinen Index');
    await assert.rejects(() => h.embeddings.search('irgendwas'), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      assert.equal(err.details.action, 'reindex');
      assert.match(err.message, /Index ist leer/);
      return true;
    });
  } finally {
    await h.cleanup();
  }
});

test('the index survives a restart and keeps answering', async () => {
  const h = await harness();
  try {
    const record = note(h.store, 'Persistenz', 'Segelboote auf dem Bodensee bei Sonnenuntergang');
    await h.embeddings.reindexAll();
    await h.vectors.flush();

    const reopened = createVectorStore({ paths: h.paths });
    const second = createEmbeddings({
      registry: h.registry,
      gate: h.gate,
      config: h.config,
      store: h.store,
      vectors: reopened,
    });
    assert.equal(reopened.size(), 1);
    const hits = await second.search('Segelboote Bodensee', { limit: 1 });
    assert.equal(hits[0].id, record.id);

    // And a second full reindex over unchanged data costs nothing.
    const result = await second.reindexAll();
    assert.equal(result.indexed, 0);
    assert.equal(result.skipped, 1);
    await reopened.close();
  } finally {
    await h.cleanup();
  }
});

test('a failing batch is counted and named, the rest of the run continues', async () => {
  // One record per batch, so the failure is isolated and the run must go on.
  const h = await harness({ server: { failOn: 'KAPUTT' }, embeddingsConfig: { batchSize: 1 } });
  try {
    const good1 = note(h.store, 'Gut eins', 'Ein voellig harmloser Text');
    const bad = note(h.store, 'Problemfall', 'Dieser Text ist KAPUTT und bringt den Server zu Fall');
    const good2 = note(h.store, 'Gut zwei', 'Noch ein harmloser Text');

    const result = await h.embeddings.reindexAll({ types: ['note'] });
    assert.equal(result.indexed, 2, 'die gesunden Datensaetze muessen durchlaufen');
    assert.equal(result.failed, 1);
    assert.equal(result.problems.length, 1);
    assert.deepEqual(result.problems[0].ids, [bad.id]);
    assert.match(result.problems[0].error, /HTTP 500|explodiert/);
    // What did work is really in the index; the run did not roll back.
    assert.equal(h.vectors.size(), 2);
    assert.equal(h.vectors.has(good1.id), true);
    assert.equal(h.vectors.has(good2.id), true);
    assert.equal(h.vectors.has(bad.id), false);
  } finally {
    await h.cleanup();
  }
});

test('onProgress reports real numbers and the bus sees the run', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 5; i++) note(h.store, `Notiz ${i}`, `Inhalt Nummer ${i} mit etwas Text`);
    const seen = [];
    const events = [];
    h.bus.on('embeddings.reindex', (e) => events.push(e.payload.phase));
    const result = await h.embeddings.reindexAll({ onProgress: (p) => seen.push(p), types: ['note'] });
    assert.equal(result.indexed, 5);
    assert.equal(seen[0].phase, 'start');
    assert.equal(seen[seen.length - 1].phase, 'done');
    assert.equal(seen[seen.length - 1].done, 5);
    assert.equal(seen[seen.length - 1].total, 5);
    assert.ok(events.includes('start') && events.includes('done'));
  } finally {
    await h.cleanup();
  }
});

test('an AbortSignal stops a reindex, before and during the run', async () => {
  const pre = await harness();
  try {
    note(pre.store, 'Egal', 'Text');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => pre.embeddings.reindexAll({ signal: controller.signal }), (err) => {
      assert.equal(err.code, 'ABORTED');
      return true;
    });
  } finally {
    await pre.cleanup();
  }

  const mid = await harness({ server: { delayMs: 40 } });
  try {
    for (let i = 0; i < 8; i++) note(mid.store, `N${i}`, `Ein Text mit der Nummer ${i}`);
    const controller = new AbortController();
    mid.backend.state.onEmbed = (state) => {
      // Abort while a request is genuinely in flight, not between batches.
      if (state.embedCalls.length >= 2) controller.abort();
    };
    await assert.rejects(
      () => mid.embeddings.reindexAll({ signal: controller.signal, types: ['note'] }),
      (err) => {
        assert.equal(err.code, 'ABORTED');
        return true;
      },
    );
  } finally {
    await mid.cleanup();
  }
});

test('with a registry that cannot embed, the gate carries the request', async () => {
  const h = await harness({
    registryOverride: (registry) => ({
      list: () => registry.list(),
      refresh: (o) => registry.refresh(o),
      resolve: (ref) => registry.resolve(ref),
      // embed() deliberately absent: this is the older registry the fallback exists for.
    }),
  });
  try {
    const record = note(h.store, 'Fallback', 'Der Weg ueber die Schleuse muss genauso funktionieren');
    const result = await h.embeddings.reindexAll();
    assert.equal(result.indexed, 1);
    const hits = await h.embeddings.search('Schleuse Weg', { limit: 1 });
    assert.equal(hits[0].id, record.id);

    const embedCalls = h.gate.calls.filter((c) => c.url.includes('/api/embed'));
    assert.ok(embedCalls.length > 0, 'die Anfrage muss durch die Schleuse gegangen sein');
    for (const call of embedCalls) {
      assert.equal(call.scope, 'global');
      assert.match(call.purpose, /Einbettungen/);
    }
  } finally {
    await h.cleanup();
  }
});

test('the gate fallback survives an Ollama that only knows the old endpoint', async () => {
  const h = await harness({
    server: { legacyOnly: true },
    registryOverride: (registry) => ({
      list: () => registry.list(),
      refresh: (o) => registry.refresh(o),
      resolve: (ref) => registry.resolve(ref),
    }),
  });
  try {
    note(h.store, 'Alt', 'Eine alte Ollama-Version kennt nur /api/embeddings');
    const result = await h.embeddings.reindexAll();
    assert.equal(result.indexed, 1);
    assert.ok(h.backend.state.embedCalls.some((c) => c.legacy === true));
  } finally {
    await h.cleanup();
  }
});

test('bookkeeping records are skipped before a single request is made', async () => {
  const h = await harness();
  try {
    note(h.store, 'Echte Notiz', 'Diese soll in den Index');
    await h.embeddings.reindexAll();
    const before = h.backend.state.embedCalls.length;

    const grant = h.store.create('grant', { scope: 'global', level: 'online', hosts: ['example.com'], reason: 'Test' });
    const result = await h.embeddings.indexRecord(grant);
    assert.equal(result.indexed, false);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /"grant" werden nicht eingebettet/);
    assert.equal(h.backend.state.embedCalls.length, before, 'ein Buchhaltungs-Datensatz darf kein Modell kosten');
    assert.equal(h.vectors.has(grant.id), false);
  } finally {
    await h.cleanup();
  }
});

test('an OpenAI-compatible backend works through the gate fallback too', async () => {
  const calls = [];
  const backend = await fakeServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/v1/models') {
        return send(200, { data: [{ id: 'text-embedding-nomic' }, { id: 'qwen2.5' }] });
      }
      if (req.url === '/v1/embeddings' && req.method === 'POST') {
        const parsed = JSON.parse(body || '{}');
        calls.push(parsed);
        // Deliberately out of order: the client must sort by `index`.
        const rows = parsed.input.map((t, i) => ({ index: i, embedding: fakeVector(t, 20) })).reverse();
        return send(200, { object: 'list', data: rows });
      }
      return send(404, { error: `unbekannter Pfad ${req.url}` });
    });
  });
  const { home, cleanup } = tempHome('emb-openai');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.models.providers = [{ id: 'llamacpp', kind: 'openai', baseUrl: `${backend.url}/v1`, enabled: true }];
  const bus = new Bus();
  const gate = testGate();
  const full = createRegistry({ config, gate, bus });
  const store = await openStore({ paths, bus });
  const vectors = createVectorStore({ paths });
  const embeddings = createEmbeddings({
    // No embed(): forces the hand-written OpenAI request in embeddings.js.
    registry: { list: () => full.list(), refresh: (o) => full.refresh(o), resolve: (r) => full.resolve(r) },
    gate,
    config,
    store,
    bus,
    vectors,
  });

  try {
    const available = await embeddings.available();
    assert.equal(available.ok, true);
    assert.equal(available.model, 'text-embedding-nomic');
    assert.equal(available.dim, 20);

    const a = note(store, 'Segeln', 'Ein Boot mit weissen Segeln auf dem See');
    note(store, 'Buchhaltung', 'Rechnungen sortieren und Belege ablegen');
    const result = await embeddings.reindexAll();
    assert.equal(result.indexed, 2);
    const hits = await embeddings.search('Boot Segeln See', { limit: 2 });
    assert.equal(hits[0].id, a.id);
    assert.ok(calls.length >= 2);
    assert.ok(gate.calls.some((c) => c.url.endsWith('/v1/embeddings')));
  } finally {
    await store.close();
    await vectors.close();
    await backend.close();
    cleanup();
  }
});

test('text extraction keeps the title, folds whitespace and is bounded', () => {
  const text = __internals.textOf({
    id: 'note_x',
    type: 'note',
    data: { title: 'Die Überschrift', body: 'Zeile eins\n\n   Zeile zwei', tags: ['a', 'b'] },
  });
  assert.equal(text, 'Die Überschrift Zeile eins Zeile zwei a, b');

  const long = __internals.textOf({
    id: 'note_y',
    type: 'note',
    data: { title: 'T', body: 'x'.repeat(__internals.MAX_TEXT_CHARS * 2) },
  });
  assert.equal(long.length, __internals.MAX_TEXT_CHARS);

  assert.equal(__internals.textOf({ id: 'n', type: 'note', data: { title: '   ', body: '' } }), '');
  // An unknown type still gets embedded rather than silently ignored.
  assert.equal(__internals.textOf({ id: 'q', type: 'invented', data: { foo: 'Hallo', token: 'geheim' } }), 'Hallo');

  assert.equal(__internals.hashText('abc'), __internals.hashText('abc'));
  assert.notEqual(__internals.hashText('abc'), __internals.hashText('abd'));
  assert.equal(__internals.hashText('abc').length, 32);
});

test('empty and malformed input to embed() is refused before any request', async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.embeddings.embed([]), []);
    await assert.rejects(() => h.embeddings.embed('kein array'), /Array von Texten/);
    await assert.rejects(() => h.embeddings.embed([42]), /ausschließlich Texte/);
    await assert.rejects(() => h.embeddings.embed(['  ']), /leeren Text/);
    await assert.rejects(() => h.embeddings.search('   '), /Suchtext/);
    assert.equal(h.backend.state.embedCalls.length, 0, 'ungueltige Eingabe darf kein Modell kosten');
  } finally {
    await h.cleanup();
  }
});

module.exports = { name: 'embeddings', tests: drain() };
