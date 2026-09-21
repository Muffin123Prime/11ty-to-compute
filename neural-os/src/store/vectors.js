'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ValidationError, StorageError, LockedError } = require('../kernel/errors');

/**
 * Dense vector index for semantic search (contract section 1 neighbourhood:
 * this is a second store next to the record engine, and like the engine it is
 * the only module that writes its own files).
 *
 * Why one flat Float32 matrix instead of an array per record
 * ----------------------------------------------------------
 * A personal vault reaches a few thousand embeddings; 5 000 x 768 floats are
 * 15 MB. One contiguous Float32Array keeps every row in the same prefetchable
 * block, so a full scan is a single tight loop. Per-record arrays would add a
 * pointer dereference and an object header per record and push the dot product
 * into the 100 ms range for no gain. An approximate index (HNSW, IVF) only
 * starts paying off an order of magnitude later and would add a graph
 * structure to persist and repair -- brute force that stays under 150 ms is
 * the honest choice at this size.
 *
 * Why vectors are normalised on write
 * -----------------------------------
 * Cosine similarity is a dot product divided by both norms. Dividing at query
 * time costs 2 x dim extra multiplications and a square root per candidate.
 * Normalising once on write turns every later comparison into a plain dot
 * product, which is the minimum work the maths allows. The stored vector is
 * therefore NOT the raw model output, and `get()` says so by handing back the
 * unit vector it really holds.
 *
 * Why the model name lives in the manifest
 * ----------------------------------------
 * Two embedding models produce numbers of the same shape that mean completely
 * different things. Mixing them yields results that look plausible and are
 * wrong -- the worst possible failure for a search box, because nothing in the
 * output reveals it. The index records which model built it and refuses
 * anything else with a typed error naming the remedy.
 *
 * Why the text hash sits next to the vector
 * -----------------------------------------
 * Embedding is the expensive half (tens of milliseconds per text on a local
 * model). Storing the hash of the exact text a vector came from lets the
 * indexer skip every record whose text did not change, which turns a reindex
 * of an unchanged vault into a no-op instead of an hour of compute.
 *
 * Why a damaged index throws instead of returning nothing
 * -------------------------------------------------------
 * An empty result set and a broken index look identical to the caller. Since
 * this index is derived data, the safe reaction is not to hide the problem but
 * to report it with the one action that fixes it: reindex.
 */

/** Manifest format version. Bumped only on an incompatible layout change. */
const MANIFEST_VERSION = 1;

const BIN_FILE = 'vectors.bin';
const META_FILE = 'vectors.json';

/** Rows the index allocates the first time something is stored. */
const INITIAL_SLOTS = 64;
/** Growth factor. 1.5 wastes less than doubling on a 15 MB matrix. */
const GROWTH = 1.5;
/** Refuse absurd dimensions early: a wrong parse must not allocate 8 GB. */
const MAX_DIM = 16384;

/**
 * Float32Array uses the platform byte order, so the file would not be
 * portable between a laptop and, say, a big-endian NAS. Little endian is the
 * on-disk format; on a big-endian host the 4-byte groups are swapped.
 */
const HOST_IS_LITTLE_ENDIAN = os.endianness() === 'LE';

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function nowIso() {
  return new Date().toISOString();
}

/** Copy bytes into a freshly allocated, 4-byte aligned Float32Array. */
function bytesToFloats(buf, count) {
  const bytes = count * 4;
  if (buf.length < bytes) {
    throw new StorageError(
      `Die Vektordatei ist zu kurz: ${buf.length} Byte vorhanden, ${bytes} Byte erwartet.`,
      { action: 'reindex', have: buf.length, need: bytes },
    );
  }
  // A pooled Buffer can start at any 8-byte offset, and Float32Array demands a
  // 4-byte aligned view, so the ArrayBuffer is allocated explicitly.
  const ab = new ArrayBuffer(bytes);
  const view = Buffer.from(ab);
  buf.copy(view, 0, 0, bytes);
  if (!HOST_IS_LITTLE_ENDIAN) view.swap32();
  return new Float32Array(ab);
}

/** View (little endian) or byte-swapped copy (big endian) for writing. */
function floatsToBytes(floats, count) {
  const view = Buffer.from(floats.buffer, floats.byteOffset, count * 4);
  if (HOST_IS_LITTLE_ENDIAN) return view;
  const copy = Buffer.from(view);
  copy.swap32();
  return copy;
}

/**
 * Accept whatever an embedding backend produced and return a plain float
 * array, rejecting anything that would poison the index. NaN or Infinity in a
 * single component makes every later dot product with that row NaN, and NaN
 * comparisons are false, so the row would silently disappear from all results.
 */
function toFloats(vector, what = 'Vektor') {
  let arr;
  if (vector instanceof Float32Array || vector instanceof Float64Array) arr = vector;
  else if (Array.isArray(vector)) arr = vector;
  else throw new ValidationError(`Der ${what} muss ein Zahlen-Array oder ein Float32Array sein.`);
  if (!arr.length) throw new ValidationError(`Der ${what} ist leer.`);
  if (arr.length > MAX_DIM) {
    throw new ValidationError(`Der ${what} hat ${arr.length} Dimensionen; mehr als ${MAX_DIM} sind nicht plausibel.`);
  }
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]);
    if (!Number.isFinite(v)) {
      throw new ValidationError(`Der ${what} enthält an Position ${i} keinen gültigen Zahlenwert.`);
    }
    out[i] = v;
  }
  return out;
}

/** Unit vector, in double precision, written out as Float32. */
function normalise(values, what = 'Vektor') {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
  if (sum <= 0) {
    throw new ValidationError(
      `Der ${what} besteht nur aus Nullen. Ein Nullvektor hat keine Richtung, `
      + 'die Kosinus-Ähnlichkeit ist für ihn nicht definiert.',
    );
  }
  const inv = 1 / Math.sqrt(sum);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] * inv;
  return out;
}

/** Insert into a descending top-k list. `limit` is small, so linear beats a heap. */
function pushTop(out, limit, id, score) {
  if (out.length >= limit && score <= out[out.length - 1].score) return;
  let i = out.length;
  while (i > 0 && out[i - 1].score < score) i--;
  out.splice(i, 0, { id, score });
  if (out.length > limit) out.pop();
}

function atomicWrite(file, buf) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Without fsyncing the directory the rename itself can be lost in a crash,
  // leaving the manifest and the matrix from two different generations.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    /* some filesystems refuse to fsync a directory; the rename is still atomic */
  }
}

/**
 * @param {{paths:object, vaultCrypto?:object, logger?:Function, autoFlushMs?:number}} deps
 */
function createVectorStore({ paths, vaultCrypto, logger, autoFlushMs = 0 } = {}) {
  if (!paths || typeof paths.vault !== 'string' || !paths.vault) {
    throw new ValidationError('createVectorStore benötigt paths.vault.');
  }
  const log = typeof logger === 'function' ? logger('vectors') : (logger || nullLogger());
  const binPath = path.join(paths.vault, BIN_FILE);
  const metaPath = path.join(paths.vault, META_FILE);

  /** @type {Float32Array} slots * dimension floats, row-major */
  let data = new Float32Array(0);
  let slots = 0;
  let dimension = 0;
  let modelName = null;
  /** @type {Map<string, {slot:number, hash:string|null, type:string|null, updatedAt:string|null, meta:object|null}>} */
  const entries = new Map();
  /** Slots of removed entries, handed out again before the matrix grows. */
  let freeSlots = [];
  /** First slot never handed out yet. Always >= every live entry's slot. */
  let highWater = 0;
  let createdAt = null;
  let updatedAt = null;

  let loaded = false;
  let dirty = false;
  let closed = false;
  /** @type {{reason:string, at:string}|null} non-null means: refuse, offer reindex */
  let damaged = null;
  let flushTimer = null;

  function crypt() {
    return vaultCrypto && vaultCrypto.enabled ? vaultCrypto : null;
  }

  function damagedError() {
    return new StorageError(
      `Der Vektorindex ist unbrauchbar: ${damaged.reason} `
      + 'Er ist abgeleitete Information und lässt sich vollständig neu berechnen – '
      + 'bitte die semantische Suche neu indizieren.',
      { action: 'reindex', reason: damaged.reason, at: damaged.at },
    );
  }

  function markDamaged(reason) {
    damaged = { reason, at: nowIso() };
    data = new Float32Array(0);
    slots = 0;
    highWater = 0;
    entries.clear();
    freeSlots = [];
    log.error(`Vektorindex nicht lesbar: ${reason}`);
  }

  function decodeFile(buf, what) {
    const vc = crypt();
    if (!vc) return buf;
    try {
      return vc.decryptBuffer(buf);
    } catch (err) {
      if (err instanceof LockedError) throw err;
      throw new StorageError(
        `${what} konnte nicht entschlüsselt werden (${err.message}).`,
        { action: 'reindex' },
      );
    }
  }

  function encodeFile(buf) {
    const vc = crypt();
    return vc ? vc.encryptBuffer(buf) : buf;
  }

  function readManifest() {
    const raw = fs.readFileSync(metaPath);
    if (!raw.length) throw new StorageError('Die Zuordnungsdatei des Vektorindex ist leer.', { action: 'reindex' });
    // '{' as the first byte means plaintext JSON. Saying so precisely is the
    // difference between "your index predates encryption" and "your key is wrong".
    if (crypt() && raw[0] === 0x7b) {
      throw new StorageError(
        'Der Vektorindex stammt aus der Zeit vor der Vault-Verschlüsselung und liegt unverschlüsselt vor.',
        { action: 'reindex' },
      );
    }
    const text = decodeFile(raw, 'Die Zuordnungsdatei des Vektorindex').toString('utf8');
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (err) {
      throw new StorageError(`Die Zuordnungsdatei des Vektorindex ist kein gültiges JSON (${err.message}).`, { action: 'reindex' });
    }
    if (!manifest || typeof manifest !== 'object') {
      throw new StorageError('Die Zuordnungsdatei des Vektorindex hat keinen Objekt-Inhalt.', { action: 'reindex' });
    }
    if (manifest.v !== MANIFEST_VERSION) {
      throw new StorageError(
        `Der Vektorindex hat Format-Version ${manifest.v}, diese Fassung liest Version ${MANIFEST_VERSION}.`,
        { action: 'reindex' },
      );
    }
    const d = manifest.dim;
    if (!Number.isInteger(d) || d <= 0 || d > MAX_DIM) {
      throw new StorageError(`Der Vektorindex nennt eine unplausible Dimension (${d}).`, { action: 'reindex' });
    }
    if (!Number.isInteger(manifest.slots) || manifest.slots < 0) {
      throw new StorageError('Der Vektorindex nennt eine unplausible Anzahl Plätze.', { action: 'reindex' });
    }
    if (!Array.isArray(manifest.entries)) {
      throw new StorageError('Im Vektorindex fehlt die Liste der Einträge.', { action: 'reindex' });
    }
    return manifest;
  }

  function loadFromDisk() {
    if (!fs.existsSync(metaPath)) return; // fresh install: an empty index is correct
    const manifest = readManifest();
    const rawBin = fs.existsSync(binPath) ? fs.readFileSync(binPath) : Buffer.alloc(0);
    const bin = decodeFile(rawBin, 'Die Vektordatei');
    const floats = bytesToFloats(bin, manifest.slots * manifest.dim);

    const used = new Set();
    const next = new Map();
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
      const slot = entry.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= manifest.slots) {
        throw new StorageError(
          `Der Eintrag ${entry.id} zeigt auf Platz ${slot}, den es im Vektorindex nicht gibt.`,
          { action: 'reindex' },
        );
      }
      if (used.has(slot)) {
        throw new StorageError(`Platz ${slot} im Vektorindex ist doppelt belegt.`, { action: 'reindex' });
      }
      used.add(slot);
      next.set(entry.id, {
        slot,
        hash: typeof entry.hash === 'string' ? entry.hash : null,
        type: typeof entry.type === 'string' ? entry.type : null,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
        meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : null,
      });
    }

    data = floats;
    slots = manifest.slots;
    dimension = manifest.dim;
    modelName = typeof manifest.model === 'string' && manifest.model ? manifest.model : null;
    createdAt = typeof manifest.createdAt === 'string' ? manifest.createdAt : null;
    updatedAt = typeof manifest.updatedAt === 'string' ? manifest.updatedAt : null;
    entries.clear();
    for (const [id, e] of next) entries.set(id, e);
    freeSlots = [];
    for (let i = 0; i < slots; i++) if (!used.has(i)) freeSlots.push(i);
    highWater = slots;
  }

  /**
   * Loading is lazy on purpose: an encrypted vault is locked at boot, and a
   * constructor that threw there would take down the whole application for an
   * index that is only needed once somebody searches.
   */
  function ensureLoaded() {
    if (loaded) return;
    try {
      loadFromDisk();
      loaded = true;
    } catch (err) {
      if (err instanceof LockedError) throw err; // retry after unlock, do not give up
      loaded = true;
      markDamaged(err.message);
    }
  }

  function requireOpen() {
    if (closed) throw new StorageError('Der Vektorindex wurde bereits geschlossen.');
  }

  function requireHealthy() {
    if (damaged) throw damagedError();
  }

  function ready() {
    requireOpen();
    ensureLoaded();
    requireHealthy();
  }

  function mismatchError(wantedModel, wantedDim) {
    return new StorageError(
      `Der Vektorindex wurde mit dem Modell "${modelName || 'unbekannt'}" und ${dimension} Dimensionen gebaut, `
      + `jetzt liefert "${wantedModel || 'unbekannt'}" ${wantedDim} Dimensionen. `
      + 'Vektoren zweier Modelle dürfen nicht gemischt werden – das ergibt Treffer, die plausibel aussehen '
      + 'und falsch sind. Bitte die semantische Suche einmal neu indizieren.',
      {
        action: 'reindex',
        current: { model: modelName, dim: dimension },
        wanted: { model: wantedModel || null, dim: wantedDim || null },
      },
    );
  }

  function grow(minSlots) {
    if (minSlots <= slots) return;
    const want = Math.max(INITIAL_SLOTS, minSlots, Math.ceil(slots * GROWTH));
    const next = new Float32Array(want * dimension);
    if (slots) next.set(data.subarray(0, slots * dimension));
    data = next;
    slots = want;
  }

  /**
   * Slots are handed out from the free list first, then from a high-water
   * mark. Scanning for the lowest unused row instead would make indexing
   * quadratic, which only shows up once a vault is big enough to matter.
   */
  function allocateSlot() {
    if (freeSlots.length) return freeSlots.pop();
    const slot = highWater++;
    grow(slot + 1);
    return slot;
  }

  function touch() {
    dirty = true;
    updatedAt = nowIso();
    if (autoFlushMs > 0 && !flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        api.flush().catch((err) => log.error(`Vektorindex konnte nicht gespeichert werden: ${err.message}`));
      }, autoFlushMs);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }
  }

  function buildManifest() {
    const list = [];
    for (const [id, e] of entries) {
      const row = { id, slot: e.slot, hash: e.hash, type: e.type, updatedAt: e.updatedAt };
      if (e.meta) row.meta = e.meta;
      list.push(row);
    }
    return {
      v: MANIFEST_VERSION,
      model: modelName,
      dim: dimension,
      // Only rows that were ever handed out are written. Capacity above the
      // high-water mark is allocation slack, not data, and persisting it would
      // put megabytes of zeroes on disk after a growth step.
      slots: highWater,
      count: entries.size,
      createdAt: createdAt || nowIso(),
      updatedAt: updatedAt || nowIso(),
      entries: list,
    };
  }

  function makeFilter(filter) {
    if (!filter) return null;
    if (typeof filter === 'function') return filter;
    if (typeof filter !== 'object') {
      throw new ValidationError('filter muss eine Funktion oder ein Objekt sein.');
    }
    const types = Array.isArray(filter.types)
      ? filter.types
      : (typeof filter.type === 'string' ? [filter.type] : null);
    const ids = Array.isArray(filter.ids) ? new Set(filter.ids) : null;
    const exclude = Array.isArray(filter.exclude) ? new Set(filter.exclude) : null;
    if (!types && !ids && !exclude) return null;
    const typeSet = types ? new Set(types) : null;
    return (id, entry) => {
      if (typeSet && !typeSet.has(entry.type)) return false;
      if (ids && !ids.has(id)) return false;
      if (exclude && exclude.has(id)) return false;
      return true;
    };
  }

  const api = {
    /** Where the two files live, so a caller can show or back them up. */
    files: { bin: binPath, meta: metaPath },

    get closed() {
      return closed;
    },

    /** Number of live vectors. */
    size() {
      ready();
      return entries.size;
    },

    /** Dimension of this index, 0 while it is still empty. */
    dim() {
      ready();
      return dimension;
    },

    /** Name of the model every vector in here came from, or null. */
    model() {
      ready();
      return modelName;
    },

    has(id) {
      ready();
      return entries.has(id);
    },

    /** Stored metadata without copying the vector -- the hot path of reindexing. */
    meta(id) {
      ready();
      const e = entries.get(id);
      if (!e) return null;
      return {
        id,
        hash: e.hash,
        type: e.type,
        updatedAt: e.updatedAt,
        model: modelName,
        dim: dimension,
        meta: e.meta,
      };
    },

    /**
     * @returns {{id:string, vector:Float32Array, hash:string|null, type:string|null,
     *            model:string|null, dim:number, updatedAt:string|null, meta:object|null}|null}
     *          `vector` is the NORMALISED copy this index holds, not the raw model output.
     */
    get(id) {
      ready();
      const e = entries.get(id);
      if (!e) return null;
      const base = e.slot * dimension;
      return {
        id,
        vector: data.slice(base, base + dimension),
        hash: e.hash,
        type: e.type,
        model: modelName,
        dim: dimension,
        updatedAt: e.updatedAt,
        meta: e.meta,
      };
    },

    /**
     * Store (or replace) one vector.
     * @param {string} id
     * @param {Float32Array|number[]} vector raw model output; normalised here
     * @param {{model?:string, hash?:string, type?:string, updatedAt?:string, meta?:object}} [meta]
     */
    put(id, vector, meta = {}) {
      ready();
      if (typeof id !== 'string' || !id) throw new ValidationError('put() braucht eine Datensatz-ID.');
      const values = toFloats(vector);
      const wantedModel = typeof meta.model === 'string' && meta.model ? meta.model : null;

      if (dimension === 0) {
        dimension = values.length;
        modelName = wantedModel;
        createdAt = createdAt || nowIso();
      } else if (values.length !== dimension || (wantedModel && modelName && wantedModel !== modelName)) {
        throw mismatchError(wantedModel || modelName, values.length);
      } else if (wantedModel && !modelName) {
        modelName = wantedModel;
      }

      const unit = normalise(values);
      const existing = entries.get(id);
      const slot = existing ? existing.slot : allocateSlot();
      grow(slot + 1);
      data.set(unit, slot * dimension);
      entries.set(id, {
        slot,
        hash: typeof meta.hash === 'string' ? meta.hash : null,
        type: typeof meta.type === 'string' ? meta.type : null,
        updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : nowIso(),
        meta: meta.meta && typeof meta.meta === 'object' ? meta.meta : null,
      });
      touch();
      return { id, slot, dim: dimension, model: modelName };
    },

    /** @returns {boolean} whether something was actually removed */
    remove(id) {
      ready();
      const e = entries.get(id);
      if (!e) return false;
      entries.delete(id);
      freeSlots.push(e.slot);
      // Zero the row so a stale vector can never be read back through a
      // recycled slot before it is overwritten.
      data.fill(0, e.slot * dimension, (e.slot + 1) * dimension);
      touch();
      return true;
    },

    /**
     * Cosine similarity against every live vector.
     * @param {Float32Array|number[]} queryVector
     * @param {{limit?:number, filter?:Function|object, minScore?:number}} [opts]
     * @returns {[{id:string, score:number}]} descending by score
     */
    search(queryVector, opts = {}) {
      ready();
      if (!entries.size) return [];
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 10;
      const minScore = Number.isFinite(opts.minScore) ? opts.minScore : -Infinity;
      const values = toFloats(queryVector, 'Suchvektor');
      if (values.length !== dimension) {
        throw new ValidationError(
          `Der Suchvektor hat ${values.length} Dimensionen, der Index ${dimension}. `
          + 'Das passiert, wenn die Anfrage mit einem anderen Einbettungsmodell berechnet wurde als der Index.',
          { queryDim: values.length, indexDim: dimension, model: modelName },
        );
      }
      const q = normalise(values, 'Suchvektor');
      const accept = makeFilter(opts.filter);
      const out = [];
      const d = dimension;
      for (const [id, e] of entries) {
        if (accept && !accept(id, e)) continue;
        let score = 0;
        const base = e.slot * d;
        for (let i = 0; i < d; i++) score += data[base + i] * q[i];
        if (score < minScore) continue;
        pushTop(out, limit, id, score);
      }
      return out;
    },

    /**
     * Whether this index may be used with the given model.
     * @returns {{ok:boolean, reason?:string, current:object, wanted:object}}
     */
    compatible({ model = null, dim = null } = {}) {
      requireOpen();
      ensureLoaded();
      const current = { model: modelName, dim: dimension, size: entries.size };
      const wanted = { model: model || null, dim: dim || null };
      if (damaged) return { ok: false, reason: damaged.reason, current, wanted };
      if (!entries.size) return { ok: true, current, wanted }; // empty adopts anything
      if (dim && dimension && dim !== dimension) {
        return { ok: false, reason: `Der Index hat ${dimension} Dimensionen, das Modell liefert ${dim}.`, current, wanted };
      }
      if (model && modelName && model !== modelName) {
        return { ok: false, reason: `Der Index wurde mit "${modelName}" gebaut, jetzt läuft "${model}".`, current, wanted };
      }
      return { ok: true, current, wanted };
    },

    /**
     * Drop everything and (optionally) adopt a new model. The only legitimate
     * answer to a model change, and deliberately explicit: nothing in here
     * silently discards vectors the user paid compute for.
     */
    reset({ model = null, dim = null } = {}) {
      requireOpen();
      ensureLoaded();
      entries.clear();
      freeSlots = [];
      highWater = 0;
      dimension = Number.isInteger(dim) && dim > 0 ? dim : 0;
      modelName = typeof model === 'string' && model ? model : null;
      slots = 0;
      data = new Float32Array(0);
      damaged = null;
      createdAt = nowIso();
      touch();
      return api.info();
    },

    /**
     * Remove the gaps left by deleted entries so the matrix is dense again.
     * Nothing else needs this to be correct -- search skips free slots -- but a
     * vault that churns notes would otherwise keep writing a file full of holes.
     */
    compact() {
      ready();
      const live = entries.size;
      const before = slots;
      if (!live) {
        const freed = before;
        data = new Float32Array(0);
        slots = 0;
        highWater = 0;
        freeSlots = [];
        if (freed) touch();
        return { moved: 0, slots: 0, freedSlots: freed, bytes: 0 };
      }
      let moved = 0;
      const next = new Float32Array(live * dimension);
      let target = 0;
      for (const e of entries.values()) {
        if (e.slot !== target) moved++;
        next.set(data.subarray(e.slot * dimension, (e.slot + 1) * dimension), target * dimension);
        e.slot = target;
        target++;
      }
      data = next;
      slots = live;
      highWater = live;
      freeSlots = [];
      if (moved || before !== live) touch();
      return { moved, slots: live, freedSlots: before - live, bytes: live * dimension * 4 };
    },

    /** Honest state report; never throws, so a UI can always render something. */
    info() {
      const files = { bin: binPath, meta: metaPath };
      if (closed) return { state: 'closed', model: modelName, dim: dimension, size: 0, slots: 0, freeSlots: 0, bytes: 0, createdAt, updatedAt, dirty, files, problem: null };
      try {
        ensureLoaded();
      } catch (err) {
        // A locked vault is not a defect, and reporting it as one would send
        // the user reindexing when all they need to do is unlock.
        const state = err instanceof LockedError ? 'locked' : 'damaged';
        return { state, model: null, dim: 0, size: 0, slots: 0, freeSlots: 0, bytes: 0, createdAt: null, updatedAt: null, dirty, files, problem: err.message };
      }
      if (damaged) {
        return { state: 'damaged', model: modelName, dim: dimension, size: 0, slots: 0, freeSlots: 0, bytes: 0, createdAt, updatedAt, dirty, files, problem: damaged.reason };
      }
      return {
        state: 'ok',
        model: modelName,
        dim: dimension,
        size: entries.size,
        slots,
        freeSlots: freeSlots.length,
        bytes: slots * dimension * 4,
        createdAt,
        updatedAt,
        dirty,
        files,
        problem: null,
      };
    },

    /**
     * Write both files. Explicit rather than automatic: the matrix is written
     * whole, so flushing after every single `put` would rewrite 15 MB per
     * indexed note. Callers batch, then flush once.
     */
    async flush() {
      requireOpen();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!dirty) return { written: false, bytes: 0 };
      if (damaged) throw damagedError();
      const bytes = floatsToBytes(data, highWater * dimension);
      atomicWrite(binPath, encodeFile(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
      atomicWrite(metaPath, encodeFile(Buffer.from(JSON.stringify(buildManifest()), 'utf8')));
      dirty = false;
      return { written: true, bytes: bytes.length, entries: entries.size };
    },

    /** Delete both files and forget everything. Used when the user wipes the index. */
    async destroy() {
      requireOpen();
      entries.clear();
      freeSlots = [];
      highWater = 0;
      data = new Float32Array(0);
      slots = 0;
      dimension = 0;
      modelName = null;
      damaged = null;
      dirty = false;
      loaded = true;
      for (const file of [binPath, metaPath]) {
        try { fs.rmSync(file, { force: true }); } catch { /* nothing to delete */ }
      }
      return { removed: true };
    },

    async close() {
      if (closed) return;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (dirty && !damaged) {
        try {
          await api.flush();
        } catch (err) {
          log.error(`Vektorindex konnte beim Schließen nicht gespeichert werden: ${err.message}`);
        }
      }
      closed = true;
    },
  };

  return api;
}

module.exports = {
  createVectorStore,
  MANIFEST_VERSION,
  /** Exposed for tests only: the numeric helpers are where silent bugs live. */
  __internals: { toFloats, normalise, pushTop, bytesToFloats, floatsToBytes },
};
