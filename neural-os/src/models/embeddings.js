'use strict';

const crypto = require('node:crypto');

const {
  ValidationError,
  NoModelError,
  ModelError,
  StorageError,
  AbortedError,
  asNeuralError,
} = require('../kernel/errors');

/**
 * Embedding service: turns records into vectors and answers semantic queries.
 *
 * Why this exists next to the BM25 index rather than instead of it
 * ----------------------------------------------------------------
 * Keyword search finds the word you typed; embeddings find the thing you
 * meant. They fail in opposite directions -- BM25 misses "Auto" when the note
 * says "Fahrzeug", embeddings miss an exact serial number -- so the answer is
 * both, never one pretending to be the other.
 *
 * Why there is no fallback to keyword search in here
 * --------------------------------------------------
 * The tempting shortcut, when no embedding model is installed, is to quietly
 * run the BM25 query instead. The user then gets results, believes they are
 * semantic, and draws conclusions from an absence of hits that never happened.
 * Every entry point therefore raises NoModelError with installation
 * instructions. Choosing the other search is the caller's decision to make
 * out loud, not ours to make silently.
 *
 * Why the text hash decides re-embedding
 * --------------------------------------
 * Embedding is the only expensive operation in this system (tens of
 * milliseconds per text, locally, per model call). Hashing the exact text that
 * produced a vector means an unchanged note is never embedded twice, which is
 * what makes `reindexAll` usable as a routine "make sure everything is
 * current" button instead of a coffee break.
 *
 * Why batches, and why a failed batch is reported rather than skipped
 * ------------------------------------------------------------------
 * One HTTP round trip per note would spend most of the time in connection
 * overhead; Ollama's /api/embed takes an array. But a batch that fails is a
 * batch of records with NO vector, and a reindex that reported success while
 * silently dropping 40 notes would leave a search index that is quietly
 * incomplete. Failures are counted, named and returned.
 *
 * Network: every request goes through the registry (which injects the gate)
 * or, when a registry predates `embed()`, through `gate.fetch` directly. This
 * module never touches fetch/http itself.
 */

/**
 * Models we prefer, best first. All three are small, run on CPU and are the
 * ones Ollama actually ships for this job; anything else that calls itself an
 * embedding model is picked up by the "contains embed" rule below.
 */
const PREFERRED_MODELS = ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm'];

/** Record types that carry text worth embedding. */
const DEFAULT_TYPES = ['note', 'task', 'project', 'entity', 'memory', 'file', 'chat'];

/**
 * Fields per type, in reading order. Mirrors the BM25 field list in
 * `store/search.js` so the two searches see the same text; weights are absent
 * because an embedding has no notion of per-field weight -- the model reads
 * the text as one document.
 */
const TEXT_FIELDS = {
  note: ['title', 'body', 'tags'],
  chat: ['title', 'systemPrompt'],
  message: ['content'],
  project: ['name', 'description', 'tags'],
  task: ['title', 'body'],
  agent: ['name', 'description', 'systemPrompt'],
  file: ['name', 'text', 'tags'],
  entity: ['name', 'description', 'aliases'],
  memory: ['text', 'scope'],
  run: ['goal', 'result'],
};

/** Never embedded, whatever the type: credentials and opaque digests. */
const NEVER_EMBED = new Set(['hash', 'salt', 'token', 'wrappedKey', 'keyCheck', 'passphrase', 'apiKey']);

/**
 * Embedding models have a context window (nomic-embed-text: 8192 tokens).
 * Text beyond it is dropped by the backend anyway; cutting here makes that
 * visible and bounded instead of backend-dependent.
 */
const MAX_TEXT_CHARS = 6000;

/** Texts per request. Large enough to amortise the round trip, small enough
 *  that one failure does not cost a hundred re-computations. */
const DEFAULT_BATCH_SIZE = 16;

/** One short word, only ever used to learn a model's output dimension. */
const PROBE_TEXT = 'neural-os';

/** How long an availability answer may be reused before re-checking. */
const AVAILABILITY_TTL_MS = 30000;

const INSTALL_HINT = [
  'So richtest du die semantische Suche ein (einmalig, danach vollständig offline):',
  '',
  '    ollama pull nomic-embed-text     ~274 MB – Standardempfehlung',
  '    ollama pull mxbai-embed-large    ~670 MB – etwas genauer, braucht mehr RAM',
  '    ollama pull all-minilm            ~46 MB – kleinste Variante',
  '',
  'Danach in den Einstellungen auf "Modelle neu suchen" klicken und die',
  'semantische Suche einmal neu indizieren.',
  '',
  'Neural OS weicht nicht heimlich auf die Stichwortsuche aus: du bekommst',
  'entweder echte semantische Treffer oder diesen Hinweis – niemals',
  'stillschweigend etwas anderes, als du angefordert hast.',
].join('\n');

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

/** Ollama tags a model "name:latest"; the base name is what a user types. */
function baseName(id) {
  if (typeof id !== 'string') return '';
  const cut = id.indexOf(':');
  return (cut === -1 ? id : id.slice(0, cut)).toLowerCase();
}

function looksLikeEmbeddingModel(id) {
  return /embed|bge|gte|e5|minilm/i.test(String(id || ''));
}

function fieldText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(', ');
  return '';
}

/**
 * The text an embedding is computed from. Deliberately includes the title:
 * a body without its heading loses the single most topical sentence a note has.
 */
function textOf(record) {
  if (!record || typeof record !== 'object') return '';
  const data = record.data && typeof record.data === 'object' ? record.data : {};
  const fields = TEXT_FIELDS[record.type];
  const parts = [];
  if (fields) {
    for (const name of fields) {
      const text = fieldText(data[name]).trim();
      if (text) parts.push(text);
    }
  } else {
    for (const [name, value] of Object.entries(data)) {
      if (NEVER_EMBED.has(name)) continue;
      const text = fieldText(value).trim();
      if (text) parts.push(text);
    }
  }
  const joined = parts.join('\n').replace(/\s+/g, ' ').trim();
  return joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined;
}

/**
 * 128 bits of SHA-256. The hash only has to answer "is this the same text as
 * last time"; a full digest would add 32 bytes per record to a manifest that
 * is read whole on every start, for collision odds that are already absurd.
 */
function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new AbortedError('Die Indizierung wurde abgebrochen.');
}

/** Errors that make continuing pointless: the backend itself is gone. */
function isFatal(err) {
  return err instanceof NoModelError
    || err instanceof AbortedError
    || (err && (err.code === 'NETWORK_BLOCKED' || err.code === 'VAULT_LOCKED'));
}

/**
 * @param {{registry:object, gate?:object, config?:object, store?:object, bus?:object,
 *          logger?:Function, vectors?:object, paths?:object, vaultCrypto?:object}} deps
 */
function createEmbeddings({ registry, gate, config, store, bus, logger, vectors, paths, vaultCrypto } = {}) {
  if (!registry || typeof registry.list !== 'function') {
    throw new ValidationError('createEmbeddings benötigt die Modell-Registry.');
  }
  const log = typeof logger === 'function' ? logger('embeddings') : (logger || nullLogger());

  // The vector store may be handed in (tests, a shared instance) or built from
  // the same paths the record store uses. One of the two must exist -- an
  // embedding service without somewhere to put the vectors is not a thing.
  let index = vectors || null;
  if (!index) {
    const layout = paths || (store && store.paths) || null;
    if (!layout || typeof layout.vault !== 'string') {
      throw new ValidationError(
        'createEmbeddings benötigt entweder einen Vektorspeicher (vectors) oder paths.vault.',
      );
    }
    index = require('../store/vectors').createVectorStore({ paths: layout, vaultCrypto, logger });
  }

  const settings = () => {
    const models = (config && config.models) || {};
    const e = (models.embeddings && typeof models.embeddings === 'object') ? models.embeddings : {};
    return {
      enabled: e.enabled !== false,
      model: typeof e.model === 'string' && e.model ? e.model : null,
      provider: typeof e.provider === 'string' && e.provider ? e.provider : null,
      batchSize: Number.isInteger(e.batchSize) && e.batchSize > 0 ? e.batchSize : DEFAULT_BATCH_SIZE,
      minScore: Number.isFinite(e.minScore) ? e.minScore : 0,
      types: Array.isArray(e.types) && e.types.length ? e.types.filter((t) => typeof t === 'string') : DEFAULT_TYPES,
      scope: typeof e.scope === 'string' && e.scope ? e.scope : 'global',
      timeoutMs: Number.isInteger(e.timeoutMs) && e.timeoutMs > 0 ? e.timeoutMs : 60000,
    };
  };

  /** model id -> output dimension. A model's dimension never changes. */
  const dimCache = new Map();
  /** @type {{at:number, value:object}|null} */
  let availabilityCache = null;

  function publish(name, payload) {
    if (bus && typeof bus.publish === 'function') {
      try { bus.publish(name, payload); } catch { /* a listener must not break indexing */ }
    }
  }

  function noModel(reason, details) {
    return new NoModelError(
      ['Für die semantische Suche ist kein Einbettungsmodell verfügbar.', '', reason, '', INSTALL_HINT].join('\n'),
      { reason, ...(details || {}) },
    );
  }

  function reindexError(message, details) {
    return new StorageError(message, { action: 'reindex', ...(details || {}) });
  }

  // ---------------------------------------------------------------- selection

  async function snapshot({ refresh = false, signal } = {}) {
    const snap = registry.list();
    if (!refresh && snap && snap.at !== null) return snap;
    if (typeof registry.refresh !== 'function') return snap || { providers: [], at: null };
    try {
      return await registry.refresh({ signal });
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      log.warn(`Modellsuche fehlgeschlagen: ${err.message}`);
      return registry.list() || { providers: [], at: null };
    }
  }

  /**
   * Pick the embedding model. Explicit configuration wins; otherwise the
   * preference list; otherwise anything whose name says it embeds.
   * @returns {{provider:string, model:string, source:string}|{error:string}}
   */
  function chooseModel(snap) {
    const cfg = settings();
    const providers = (snap && Array.isArray(snap.providers) ? snap.providers : [])
      .filter((p) => p && p.available);

    if (!providers.length) {
      const configured = (snap && snap.providers) || [];
      if (!configured.length) return { error: 'Es ist kein Modellanbieter konfiguriert.' };
      const lines = configured.map((p) => `  • ${p.id} (${p.baseUrl}) – ${p.error || 'nicht erreichbar'}`);
      return { error: ['Kein Modellanbieter ist erreichbar:', ...lines].join('\n') };
    }

    const wanted = cfg.model ? baseName(cfg.model) : null;
    const inProvider = (p, match) => (p.models || []).find((m) => match(m));

    if (wanted) {
      for (const p of providers) {
        if (cfg.provider && p.id !== cfg.provider) continue;
        const hit = inProvider(p, (m) => baseName(m.id) === wanted || baseName(m.name) === wanted);
        if (hit) return { provider: p.id, model: hit.id, source: 'konfiguriert' };
      }
      return {
        error: `Das eingestellte Einbettungsmodell "${cfg.model}" ist bei keinem erreichbaren Anbieter installiert.`,
      };
    }

    for (const preferred of PREFERRED_MODELS) {
      for (const p of providers) {
        if (cfg.provider && p.id !== cfg.provider) continue;
        const hit = inProvider(p, (m) => baseName(m.id) === preferred || baseName(m.name) === preferred);
        if (hit) return { provider: p.id, model: hit.id, source: 'bevorzugt' };
      }
    }

    for (const p of providers) {
      if (cfg.provider && p.id !== cfg.provider) continue;
      const hit = inProvider(p, (m) => looksLikeEmbeddingModel(m.id) || looksLikeEmbeddingModel(m.name));
      if (hit) return { provider: p.id, model: hit.id, source: 'erkannt' };
    }

    const installed = providers.flatMap((p) => (p.models || []).map((m) => `${p.id}/${m.id}`));
    return {
      error: installed.length
        ? `Keines der installierten Modelle ist ein Einbettungsmodell. Gefunden: ${installed.join(', ')}.`
        : 'Der Modellanbieter läuft, hat aber kein einziges Modell installiert.',
    };
  }

  // ------------------------------------------------------------------ backend

  /**
   * Fallback used only when the registry has no `embed()`. Kept here rather
   * than in the provider files (which this module must not modify) and shaped
   * exactly like the two documented endpoints.
   */
  async function embedViaGate(target, texts, signal) {
    if (!gate || typeof gate.fetch !== 'function') {
      throw new ValidationError(
        'Interner Fehler: Weder die Registry noch die Netzwerkschleuse können Einbettungen berechnen.',
      );
    }
    const cfg = settings();
    const base = String(target.baseUrl || '').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;

    const call = async (url, body) => {
      const res = await gate.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        scope: cfg.scope,
        purpose: `Einbettungen mit ${target.model}`,
        timeoutMs: cfg.timeoutMs,
        signal,
      });
      if (!res || typeof res.status !== 'number') {
        throw new ModelError('Die Netzwerkschleuse hat keine verwertbare Antwort geliefert.', { url });
      }
      return res;
    };

    if (target.kind === 'ollama') {
      let res = await call(`${base}/api/embed`, { model: target.model, input: texts });
      if (res.status === 404) {
        // Older Ollama: one text per request at /api/embeddings.
        const out = [];
        for (const prompt of texts) {
          const single = await call(`${base}/api/embeddings`, { model: target.model, prompt });
          if (!single.ok) throw await httpError(single, target);
          const json = await single.json();
          if (!Array.isArray(json && json.embedding)) {
            throw new ModelError('Ollama hat keinen Einbettungsvektor geliefert.', { model: target.model });
          }
          out.push(json.embedding);
        }
        return out;
      }
      if (!res.ok) throw await httpError(res, target);
      const json = await res.json();
      const rows = Array.isArray(json && json.embeddings) ? json.embeddings : null;
      if (!rows) throw new ModelError('Ollama hat keine Einbettungsvektoren geliefert.', { model: target.model });
      return rows;
    }

    const res = await call(`${base}/embeddings`, { model: target.model, input: texts });
    if (!res.ok) throw await httpError(res, target);
    const json = await res.json();
    const rows = Array.isArray(json && json.data) ? json.data : null;
    if (!rows) throw new ModelError('Der Modellserver hat keine Einbettungsvektoren geliefert.', { model: target.model });
    return rows
      .slice()
      .sort((a, b) => (Number(a && a.index) || 0) - (Number(b && b.index) || 0))
      .map((row) => (Array.isArray(row && row.embedding) ? row.embedding : null));
  }

  async function httpError(res, target) {
    let excerpt = '';
    try { excerpt = (await res.text()).slice(0, 400); } catch { /* body already gone */ }
    return new ModelError(
      `Der Modellserver hat die Einbettung mit HTTP ${res.status} abgelehnt: ${excerpt || '(leere Antwort)'}`,
      { status: res.status, model: target.model },
    );
  }

  /** One request. Returns raw (un-normalised) vectors in input order. */
  async function embedBatch(texts, signal) {
    const chosen = await resolveModel({ signal });
    const ref = { provider: chosen.provider, model: chosen.model };
    const cfg = settings();
    let rows;
    if (typeof registry.embed === 'function') {
      const result = await registry.embed(ref, {
        input: texts,
        signal,
        scope: cfg.scope,
        purpose: `Einbettungen mit ${chosen.model}`,
        timeoutMs: cfg.timeoutMs,
      });
      rows = result && Array.isArray(result.vectors) ? result.vectors : null;
    } else {
      if (typeof registry.resolve !== 'function') {
        throw new ValidationError('Die Modell-Registry kann weder embed() noch resolve() – sie ist zu alt für die semantische Suche.');
      }
      rows = await embedViaGate(registry.resolve(ref), texts, signal);
    }
    if (!rows || rows.length !== texts.length) {
      throw new ModelError(
        `Das Einbettungsmodell "${chosen.model}" hat ${rows ? rows.length : 0} Vektoren für ${texts.length} Texte geliefert.`,
        { model: chosen.model, expected: texts.length, received: rows ? rows.length : 0 },
      );
    }
    return rows.map((row, i) => {
      if (!Array.isArray(row) && !(row instanceof Float32Array) && !(row instanceof Float64Array)) {
        throw new ModelError(`Vektor ${i} der Antwort ist kein Zahlen-Array.`, { model: chosen.model });
      }
      const out = new Float32Array(row.length);
      for (let k = 0; k < row.length; k++) {
        const v = Number(row[k]);
        if (!Number.isFinite(v)) {
          throw new ModelError(
            `Vektor ${i} enthält an Position ${k} keinen gültigen Zahlenwert.`,
            { model: chosen.model },
          );
        }
        out[k] = v;
      }
      if (!out.length) throw new ModelError(`Vektor ${i} der Antwort ist leer.`, { model: chosen.model });
      return out;
    });
  }

  /** The chosen model, or a NoModelError explaining precisely what is missing. */
  async function resolveModel({ refresh = false, signal } = {}) {
    const cfg = settings();
    if (!cfg.enabled) {
      throw noModel('Die semantische Suche ist in der Konfiguration abgeschaltet (models.embeddings.enabled = false).');
    }
    const snap = await snapshot({ refresh, signal });
    const chosen = chooseModel(snap);
    if (chosen.error) throw noModel(chosen.error, { at: snap && snap.at });
    return chosen;
  }

  /** Dimension of a model, learned once by embedding a single short word. */
  async function dimensionOf(chosen, signal) {
    if (dimCache.has(chosen.model)) return dimCache.get(chosen.model);
    const info = index.info();
    if (info.state === 'ok' && info.model === chosen.model && info.dim > 0) {
      dimCache.set(chosen.model, info.dim);
      return info.dim;
    }
    const [vector] = await embedBatch([PROBE_TEXT], signal);
    dimCache.set(chosen.model, vector.length);
    return vector.length;
  }

  // -------------------------------------------------------------- public API

  const api = {
    /** The vector store behind this service, for status pages and backups. */
    vectors: index,

    /** The German setup instructions, so the UI can show them without an error. */
    installHint() {
      return INSTALL_HINT;
    },

    /**
     * Is semantic search usable right now?
     * @param {{refresh?:boolean, signal?:AbortSignal}} [opts]
     * @returns {Promise<{ok:boolean, model:string|null, dim:number|null, reason:string|null, provider:string|null}>}
     */
    async available(opts = {}) {
      if (!opts.refresh && availabilityCache && Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) {
        return availabilityCache.value;
      }
      let value;
      try {
        const chosen = await resolveModel({ refresh: opts.refresh, signal: opts.signal });
        const dim = await dimensionOf(chosen, opts.signal);
        value = { ok: true, model: chosen.model, dim, reason: null, provider: chosen.provider, source: chosen.source };
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        const mapped = asNeuralError(err);
        // A reachable backend that cannot embed is still "not available", but
        // the reason has to say WHICH of the two failed, not just "no".
        value = {
          ok: false,
          model: null,
          dim: null,
          provider: null,
          reason: mapped.message,
          code: mapped.code,
        };
        publish('embeddings.unavailable', { reason: mapped.message, code: mapped.code });
      }
      availabilityCache = { at: Date.now(), value };
      return value;
    },

    /**
     * Embed texts, batched.
     * @param {string[]} texts
     * @param {{signal?:AbortSignal, batchSize?:number}} [opts]
     * @returns {Promise<Float32Array[]>} raw model output, in input order
     */
    async embed(texts, opts = {}) {
      if (!Array.isArray(texts)) throw new ValidationError('embed() erwartet ein Array von Texten.');
      if (!texts.length) return [];
      for (const t of texts) {
        if (typeof t !== 'string') throw new ValidationError('embed() erwartet ausschließlich Texte.');
        if (!t.trim()) throw new ValidationError('embed() hat einen leeren Text erhalten; ein leerer Text hat keine Bedeutung.');
      }
      const signal = opts.signal;
      throwIfAborted(signal);
      const chosen = await resolveModel({ signal });
      const size = Number.isInteger(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : settings().batchSize;
      const out = [];
      for (let start = 0; start < texts.length; start += size) {
        throwIfAborted(signal);
        const batch = texts.slice(start, start + size);
        try {
          const vectors = await embedBatch(batch, signal);
          for (const v of vectors) out.push(v);
        } catch (err) {
          if (err instanceof AbortedError) throw err;
          const mapped = asNeuralError(err);
          mapped.details = {
            ...(mapped.details || {}),
            batch: { start, end: start + batch.length - 1, size: batch.length },
            model: chosen.model,
          };
          throw mapped;
        }
      }
      return out;
    },

    /**
     * Index one record. Unchanged text is skipped without touching the model.
     * @param {object} record
     * @returns {Promise<{id:string, indexed:boolean, skipped:boolean, reason:string|null}>}
     */
    async indexRecord(record, opts = {}) {
      if (!record || typeof record !== 'object' || typeof record.id !== 'string') {
        throw new ValidationError('indexRecord() erwartet einen Datensatz mit einer ID.');
      }
      const signal = opts.signal;
      if (record.deletedAt) {
        const removed = await api.removeRecord(record.id);
        return { id: record.id, indexed: false, skipped: true, removed, reason: 'Der Datensatz ist gelöscht.' };
      }
      // app.js indexes as a side effect of every write, so bookkeeping records
      // (grants, tokens, approvals) arrive here too. Checking the type BEFORE
      // touching the model means they cost neither a request nor an error.
      if (!settings().types.includes(record.type)) {
        const removed = index.has(record.id) ? await api.removeRecord(record.id) : false;
        return {
          id: record.id,
          indexed: false,
          skipped: true,
          removed,
          reason: `Datensätze vom Typ "${record.type}" werden nicht eingebettet.`,
        };
      }

      const text = textOf(record);
      if (!text) {
        const removed = index.has(record.id) ? await api.removeRecord(record.id) : false;
        return { id: record.id, indexed: false, skipped: true, removed, reason: 'Der Datensatz enthält keinen einbettbaren Text.' };
      }

      const chosen = await resolveModel({ signal });
      const dim = await dimensionOf(chosen, signal);
      requireCompatible(chosen.model, dim);

      const hash = hashText(text);
      const existing = index.meta(record.id);
      if (existing && existing.hash === hash && index.model() === chosen.model) {
        return { id: record.id, indexed: false, skipped: true, reason: 'Der Text ist unverändert.' };
      }

      const [vector] = await api.embed([text], { signal, batchSize: 1 });
      index.put(record.id, vector, {
        model: chosen.model,
        hash,
        type: record.type,
        updatedAt: record.updatedAt || record.createdAt || null,
      });
      await index.flush();
      publish('embeddings.indexed', { id: record.id, type: record.type, model: chosen.model });
      return { id: record.id, indexed: true, skipped: false, reason: null };
    },

    /** @returns {Promise<boolean>} whether a vector was actually removed */
    async removeRecord(id) {
      if (typeof id !== 'string' || !id) throw new ValidationError('removeRecord() braucht eine ID.');
      const removed = index.remove(id);
      if (removed) {
        await index.flush();
        publish('embeddings.removed', { id });
      }
      return removed;
    },

    /**
     * Rebuild the index over every indexable record.
     * @param {{onProgress?:Function, signal?:AbortSignal, types?:string[], force?:boolean}} [opts]
     * @returns {Promise<{indexed:number, skipped:number, failed:number, ms:number}>}
     */
    async reindexAll(opts = {}) {
      const started = Date.now();
      const signal = opts.signal;
      throwIfAborted(signal);
      if (!store || typeof store.all !== 'function') {
        throw new ValidationError('reindexAll() braucht den Datenspeicher (store).');
      }

      const chosen = await resolveModel({ refresh: true, signal });
      const dim = await dimensionOf(chosen, signal);

      // A model change is exactly what a reindex is for, so here -- and only
      // here -- the old vectors are discarded instead of refused.
      const compat = index.compatible({ model: chosen.model, dim });
      let reset = false;
      if (!compat.ok || opts.force === true) {
        index.reset({ model: chosen.model, dim });
        reset = true;
        if (!compat.ok) log.warn(`Vektorindex verworfen: ${compat.reason}`);
      }

      const types = Array.isArray(opts.types) && opts.types.length ? opts.types : settings().types;
      const records = [];
      for (const type of types) {
        for (const record of store.all(type)) records.push(record);
      }

      // Anything in the index that is gone from the store is stale. Leaving it
      // would let a deleted note keep turning up in search results.
      let removed = 0;
      const live = new Set(records.map((r) => r.id));
      for (const id of index.ids()) {
        if (!live.has(id)) {
          index.remove(id);
          removed++;
        }
      }

      const pending = [];
      let skipped = 0;
      for (const record of records) {
        const text = textOf(record);
        if (!text) {
          if (index.remove(record.id)) removed++;
          skipped++;
          continue;
        }
        const hash = hashText(text);
        const existing = index.meta(record.id);
        if (!reset && existing && existing.hash === hash) {
          skipped++;
          continue;
        }
        pending.push({ record, text, hash });
      }

      const total = pending.length;
      const size = settings().batchSize;
      let indexed = 0;
      let failed = 0;
      const problems = [];
      const report = (phase) => {
        if (typeof opts.onProgress === 'function') {
          try {
            opts.onProgress({ phase, done: indexed + failed, total, indexed, skipped, failed, removed });
          } catch (err) {
            log.warn(`onProgress hat geworfen: ${err.message}`);
          }
        }
        publish('embeddings.reindex', { phase, done: indexed + failed, total, indexed, skipped, failed, removed });
      };

      report('start');
      for (let start = 0; start < pending.length; start += size) {
        throwIfAborted(signal);
        const batch = pending.slice(start, start + size);
        try {
          const vectors = await embedBatch(batch.map((b) => b.text), signal);
          for (let i = 0; i < batch.length; i++) {
            const { record, hash } = batch[i];
            index.put(record.id, vectors[i], {
              model: chosen.model,
              hash,
              type: record.type,
              updatedAt: record.updatedAt || record.createdAt || null,
            });
            indexed++;
          }
        } catch (err) {
          if (isFatal(err)) {
            await index.flush();
            throw err;
          }
          // One bad batch must not cost the whole run, but it must be counted:
          // these records have NO vector and will not be found by a search.
          failed += batch.length;
          const mapped = asNeuralError(err);
          problems.push({ from: start, count: batch.length, ids: batch.map((b) => b.record.id), error: mapped.message });
          log.warn(`Einbettung für ${batch.length} Datensätze fehlgeschlagen: ${mapped.message}`);
        }
        report('progress');
      }

      await index.flush();
      report('done');
      const result = {
        indexed,
        skipped,
        failed,
        removed,
        ms: Date.now() - started,
        model: chosen.model,
        dim,
        reset,
        total: records.length,
        problems,
      };
      log.info(`Neuindizierung: ${indexed} eingebettet, ${skipped} unverändert, ${failed} fehlgeschlagen (${result.ms} ms)`);
      return result;
    },

    /**
     * Semantic search.
     * @param {string} query
     * @param {{types?:string[], limit?:number, minScore?:number, signal?:AbortSignal}} [opts]
     * @returns {Promise<[{id:string, score:number}]>}
     */
    async search(query, opts = {}) {
      if (typeof query !== 'string' || !query.trim()) {
        throw new ValidationError('Für die semantische Suche wird ein Suchtext gebraucht.');
      }
      const signal = opts.signal;
      const chosen = await resolveModel({ signal });
      const dim = await dimensionOf(chosen, signal);
      requireCompatible(chosen.model, dim);

      const info = index.info();
      if (info.size === 0) {
        // Returning [] here would be indistinguishable from "nothing matches",
        // and the user would conclude their notes do not contain the topic.
        throw reindexError(
          'Der semantische Index ist leer – es wurde noch nichts eingebettet. '
          + 'Bitte die semantische Suche einmal indizieren; danach beantwortet sie Suchanfragen.',
          { model: chosen.model, dim },
        );
      }

      const [vector] = await api.embed([query.trim()], { signal, batchSize: 1 });
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
      const minScore = Number.isFinite(opts.minScore) ? opts.minScore : settings().minScore;
      const types = Array.isArray(opts.types) && opts.types.length ? opts.types : null;
      return index.search(vector, { limit, minScore, filter: types ? { types } : null });
    },

    /** Everything a status page needs, without throwing. */
    async status(opts = {}) {
      const availability = await api.available(opts);
      return {
        available: availability.ok,
        model: availability.model,
        dim: availability.dim,
        provider: availability.provider || null,
        reason: availability.reason,
        index: index.info(),
        types: settings().types,
      };
    },

    /** Synchronous, cheap view for callers that must not await. */
    info() {
      return { index: index.info(), types: settings().types, batchSize: settings().batchSize };
    },

    async close() {
      await index.close();
    },
  };

  function requireCompatible(model, dim) {
    const compat = index.compatible({ model, dim });
    if (compat.ok) return;
    throw reindexError(
      `Der Vektorindex passt nicht mehr zum aktuellen Einbettungsmodell: ${compat.reason} `
      + 'Vektoren zweier Modelle dürfen nicht gemischt werden – das ergibt Treffer, die plausibel '
      + 'aussehen und falsch sind. Bitte die semantische Suche einmal neu indizieren.',
      { current: compat.current, wanted: compat.wanted },
    );
  }

  return api;
}

module.exports = {
  createEmbeddings,
  INSTALL_HINT,
  PREFERRED_MODELS,
  DEFAULT_TYPES,
  /** Exposed for tests only. */
  __internals: { textOf, hashText, baseName, looksLikeEmbeddingModel, MAX_TEXT_CHARS },
};
