'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { layout } = require('../kernel/paths');
const schema = require('./schema');
const { createSearchIndex } = require('./search');
const {
  ValidationError,
  NotFoundError,
  StorageError,
  LockedError,
} = require('../kernel/errors');

/**
 * The persistence core: an append-only operation log with in-memory state.
 *
 * Why this shape and not "write a JSON file per record" or SQLite:
 *
 *  - Zero dependencies is a hard constraint, so there is no embedded database
 *    to lean on. What is left is: keep the truth in memory, and make the disk
 *    representation a log of what happened. Reads are then Map lookups (no I/O,
 *    no cache coherency problem) and writes are one appended line.
 *  - An append-only log is the only cheap format that survives a crash mid
 *    write. The failure mode of "rewrite the whole file" is a truncated file
 *    and a destroyed vault; the failure mode of an append is one unparseable
 *    trailing line, which we can detect, cut off and report. That property is
 *    the whole reason for the design, so it is tested explicitly.
 *  - Replaying the log forever would make startup O(lifetime), so a snapshot
 *    materialises state periodically and the log only carries the delta since.
 *
 * Durability contract:
 *   - Every mutation writes its line with fs.writeSync before the call returns,
 *     so a process crash loses nothing. fsync is NOT done per write (that costs
 *     ~1-10 ms on real hardware and would make bulk import unusable); `flush()`
 *     is where the caller asks for power-loss durability.
 *   - Inside `transaction()` the lines are buffered and written in one go. If
 *     the callback throws, the in-memory changes are rolled back and nothing is
 *     written -- memory and disk can never disagree.
 *
 * Records are never mutated in place. Every change produces a new frozen-by
 * convention object, which is what makes the transaction rollback above a
 * matter of restoring a reference. Callers receive a shallow copy with a deep
 * copy of `data`, so a careless consumer cannot corrupt the vault by editing
 * the object it was handed.
 */

/** Log segments roll at 8 MB (contract). */
const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Snapshot after this many operations, so startup stays fast. */
const SNAPSHOT_EVERY_OPS = 2000;
const LOG_VERSION = 1;
const SNAPSHOT_VERSION = 1;
const SEGMENT_RE = /^(\d{5,})\.jsonl$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 24;
const ENVELOPE_KEYS = new Set(['id', 'type', 'createdAt', 'updatedAt', 'deletedAt', 'rev']);

/**
 * Types that never enter the full-text index: edges are structure rather than
 * content, and tokens/grants/approvals carry credentials or bookkeeping the
 * user would be alarmed to find in search results.
 */
const UNSEARCHABLE_TYPES = new Set(['edge', 'token', 'grant', 'approval']);

const NOOP_LOGGER = { error() {}, warn() {}, info() {}, debug() {} };

/* ------------------------------------------------------------------ utils */

function nowIso() {
  return new Date().toISOString();
}

/**
 * `<type>_<24 base36 chars>` from CSPRNG bytes, rejection-sampled so every
 * character is uniform (byte % 36 alone would bias 0-3). ~124 bits of entropy.
 */
function makeId(type) {
  let out = '';
  while (out.length < ID_LENGTH) {
    const bytes = crypto.randomBytes(ID_LENGTH);
    for (let i = 0; i < bytes.length && out.length < ID_LENGTH; i++) {
      if (bytes[i] >= 252) continue; // 252 = 7*36: keep the distribution flat
      out += BASE36[bytes[i] % 36];
    }
  }
  return `${type}_${out}`;
}

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  const out = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

/** What callers see: our envelope, their own copy of `data`. */
function expose(record) {
  if (!record) return null;
  return {
    id: record.id,
    type: record.type,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    rev: record.rev,
    data: clone(record.data),
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A line we could not parse: tell the difference between "corrupt" and
 * "encrypted, and nobody gave us the key". Dropping an encrypted vault as
 * garbage would be silent, total data loss, so we refuse instead.
 */
function looksEncrypted(text) {
  return text.length > 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err && err.code === 'EPERM';
  }
}

/**
 * Identity crypt seam. `enabled` is read on every call, not captured, because
 * the vault can be locked or unlocked while the store is open.
 */
function normaliseCrypto(vc) {
  if (!vc) {
    return {
      get enabled() { return false; },
      encryptLine: (s) => s,
      decryptLine: (s) => s,
      encryptBuffer: (b) => b,
      decryptBuffer: (b) => b,
    };
  }
  const need = (name) => {
    if (typeof vc[name] !== 'function') {
      throw new StorageError(`vaultCrypto.${name} fehlt, obwohl die Verschluesselung aktiv ist.`);
    }
    return vc[name].bind(vc);
  };
  return {
    get enabled() { return !!vc.enabled; },
    encryptLine: (s) => (vc.enabled ? need('encryptLine')(s) : s),
    decryptLine: (s) => (vc.enabled ? need('decryptLine')(s) : s),
    encryptBuffer: (b) => (vc.enabled ? need('encryptBuffer')(b) : b),
    decryptBuffer: (b) => (vc.enabled ? need('decryptBuffer')(b) : b),
  };
}

function normalisePaths(input) {
  if (typeof input === 'string') return layout(input);
  if (!isPlainObject(input)) throw new ValidationError('openStore benoetigt paths (Layout-Objekt oder Home-Pfad).');
  for (const key of ['home', 'vault', 'log', 'snapshot', 'files']) {
    if (typeof input[key] !== 'string') throw new ValidationError(`paths.${key} fehlt.`);
  }
  return input;
}

/**
 * Create only the directories the STORE owns. `ensureLayout()` also makes the
 * runs/exports/trash directories, which belong to other subsystems; creating
 * them from here would mean a store-only test silently provisions half the app.
 */
function ensureStoreDirs(paths) {
  for (const dir of [paths.home, paths.vault, paths.log, paths.files]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new StorageError(`Verzeichnis ${dir} konnte nicht angelegt werden: ${err.message}`, { cause: String(err) });
    }
  }
}

function segmentName(n) {
  return `${String(n).padStart(5, '0')}.jsonl`;
}

function listSegments(logDir) {
  let entries;
  try {
    entries = fs.readdirSync(logDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new StorageError(`Log-Verzeichnis nicht lesbar: ${err.message}`, { cause: String(err) });
  }
  return entries
    .map((name) => {
      const m = SEGMENT_RE.exec(name);
      return m ? { name, index: Number(m[1]), file: path.join(logDir, name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
}

/* ------------------------------------------------------------------ store */

/**
 * @param {{paths:object|string, bus?:object, logger?:object, vaultCrypto?:object,
 *          lock?:boolean, snapshotEveryOps?:number, segmentMaxBytes?:number}} options
 * @returns {Promise<object>} Store
 */
async function openStore(options = {}) {
  const paths = normalisePaths(options.paths);
  const bus = options.bus || null;
  const log = options.logger || NOOP_LOGGER;
  const vault = normaliseCrypto(options.vaultCrypto);
  const useLock = options.lock !== false;
  const snapshotEveryOps = Number.isInteger(options.snapshotEveryOps) ? options.snapshotEveryOps : SNAPSHOT_EVERY_OPS;
  const segmentMaxBytes = Number.isInteger(options.segmentMaxBytes) ? options.segmentMaxBytes : SEGMENT_MAX_BYTES;

  ensureStoreDirs(paths);

  /* --- exclusive access ------------------------------------------------ */

  /**
   * The store guards the VAULT directory, not the installation. `paths.lock`
   * (home/.lock) belongs to the application-level lock in src/app.js; sharing
   * one file would mean each layer could mistake the other's lock for a stale
   * one and delete it.
   */
  const lockFile = path.join(paths.vault, '.lock');
  let ownsLock = false;
  if (useLock) ownsLock = acquireLock();

  function acquireLock() {
    const payload = JSON.stringify({ pid: process.pid, at: nowIso(), scope: 'store' });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(lockFile, payload, { flag: 'wx', mode: 0o600 });
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw new StorageError(`Sperrdatei kann nicht angelegt werden: ${err.message}`, { cause: String(err) });
        }
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { holder = null; }
        if (holder && holder.pid === process.pid) {
          // Same process opening the same vault twice (server + a maintenance
          // task). Not a data hazard: both share this process's write path.
          log.debug('vault lock already held by this process');
          return false;
        }
        if (holder && pidAlive(holder.pid)) {
          throw new StorageError(
            `Der Vault wird bereits von Prozess ${holder.pid} verwendet. Bitte zuerst die andere Instanz beenden.`,
            { pid: holder.pid },
          );
        }
        if (!holder || !Number.isInteger(holder.pid)) {
          // We cannot tell who left this behind, so we do not get to delete it.
          // Opening unlocked is the lesser risk: destroying someone else's
          // lock would be the very failure the lock exists to prevent.
          log.warn('Unlesbare Sperrdatei im Vault gefunden; oeffne ohne eigene Sperre.');
          return false;
        }
        log.warn(`stale vault lock from pid ${holder.pid} removed`);
        try { fs.unlinkSync(lockFile); } catch { /* raced with another taker */ }
      }
    }
    return false;
  }

  /* --- in-memory state -------------------------------------------------- */
  /** @type {Map<string, object>} all records, live and tombstoned */
  const byId = new Map();
  /** @type {Map<string, Set<string>>} type -> ids (live AND deleted) */
  const byType = new Map();
  /** node id -> live edge ids (outgoing / incoming) */
  const edgesFrom = new Map();
  const edgesTo = new Map();
  /** `${from}\u0000${to}\u0000${kind}` -> edge id, for O(1) dedupe */
  const edgeKey = new Map();
  const index = options.searchIndex || createSearchIndex(options.searchOptions);

  let seq = 0;
  let lastWrite = null;
  let closed = false;

  /* --- log writer ------------------------------------------------------- */
  let segments = listSegments(paths.log);
  let currentSegment = segments.length ? segments[segments.length - 1].index : 1;
  let currentFile = path.join(paths.log, segmentName(currentSegment));
  let currentBytes = 0;
  let fd = null;

  /** @type {string[]|null} buffered lines while a transaction is open */
  let pending = null;
  let txDepth = 0;
  /** id -> previous record object (or undefined when it did not exist) */
  let txJournal = null;
  let opsSinceSnapshot = 0;

  function openSegment() {
    if (fd !== null) return;
    try {
      fd = fs.openSync(currentFile, 'a', 0o600);
      currentBytes = fs.fstatSync(fd).size;
    } catch (err) {
      throw new StorageError(`Log-Segment ${path.basename(currentFile)} nicht beschreibbar: ${err.message}`, { cause: String(err) });
    }
  }

  function rotateIfNeeded() {
    if (currentBytes < segmentMaxBytes) return;
    closeFd();
    currentSegment += 1;
    currentFile = path.join(paths.log, segmentName(currentSegment));
    currentBytes = 0;
    openSegment();
    log.debug(`log rotated to ${segmentName(currentSegment)}`);
  }

  function closeFd() {
    if (fd === null) return;
    try { fs.closeSync(fd); } catch { /* already gone */ }
    fd = null;
  }

  function encodeLine(entry) {
    const json = JSON.stringify(entry);
    const line = vault.enabled ? vault.encryptLine(json) : json;
    if (typeof line !== 'string') throw new StorageError('vaultCrypto.encryptLine hat keinen String geliefert.');
    if (line.includes('\n')) throw new StorageError('Log-Zeile enthaelt einen Zeilenumbruch und wuerde den Log zerstoeren.');
    return line;
  }

  function writeLines(lines) {
    if (!lines.length) return;
    openSegment();
    const payload = `${lines.join('\n')}\n`;
    try {
      fs.writeSync(fd, payload);
    } catch (err) {
      throw new StorageError(`Schreiben in den Vault fehlgeschlagen: ${err.message}`, { cause: String(err) });
    }
    currentBytes += Buffer.byteLength(payload);
    lastWrite = nowIso();
    rotateIfNeeded();
  }

  /** Append one operation. Inside a transaction it is only staged. */
  function append(entry) {
    const line = encodeLine(entry);
    if (pending) {
      pending.push(line);
      return;
    }
    writeLines([line]);
    opsSinceSnapshot += 1;
    maybeSnapshot();
  }

  function maybeSnapshot() {
    if (snapshotEveryOps <= 0 || opsSinceSnapshot < snapshotEveryOps) return;
    try {
      compactSync();
    } catch (err) {
      // A failed snapshot is not a data loss (the log still holds everything),
      // so it must not take down the write that triggered it.
      opsSinceSnapshot = 0;
      log.warn(`automatischer Snapshot fehlgeschlagen: ${err.message}`);
    }
  }

  /* --- index maintenance ------------------------------------------------ */

  function typeSet(type) {
    let set = byType.get(type);
    if (!set) byType.set(type, (set = new Set()));
    return set;
  }

  function edgeKeyOf(data) {
    return `${data.from}\u0000${data.to}\u0000${data.kind}`;
  }

  function addToIndexes(record) {
    byId.set(record.id, record);
    typeSet(record.type).add(record.id);
    if (record.deletedAt) return; // tombstones stay out of every live index
    if (record.type === 'edge') linkEdge(record);
    if (!UNSEARCHABLE_TYPES.has(record.type)) index.add(record);
  }

  function removeFromLiveIndexes(record) {
    if (record.type === 'edge') unlinkEdge(record);
    if (!UNSEARCHABLE_TYPES.has(record.type)) index.remove(record.id);
  }

  function linkEdge(record) {
    const { from, to } = record.data;
    let out = edgesFrom.get(from);
    if (!out) edgesFrom.set(from, (out = new Set()));
    out.add(record.id);
    let inc = edgesTo.get(to);
    if (!inc) edgesTo.set(to, (inc = new Set()));
    inc.add(record.id);
    edgeKey.set(edgeKeyOf(record.data), record.id);
  }

  function unlinkEdge(record) {
    const { from, to } = record.data;
    const out = edgesFrom.get(from);
    if (out) { out.delete(record.id); if (!out.size) edgesFrom.delete(from); }
    const inc = edgesTo.get(to);
    if (inc) { inc.delete(record.id); if (!inc.size) edgesTo.delete(to); }
    const key = edgeKeyOf(record.data);
    if (edgeKey.get(key) === record.id) edgeKey.delete(key);
  }

  /** Single choke point for every state change, so rollback stays possible. */
  function place(record) {
    const previous = byId.get(record.id);
    if (txJournal && !txJournal.has(record.id)) txJournal.set(record.id, previous);
    if (previous) removeFromLiveIndexes(previous);
    addToIndexes(record);
    return record;
  }

  function drop(id) {
    const previous = byId.get(id);
    if (!previous) return null;
    if (txJournal && !txJournal.has(id)) txJournal.set(id, previous);
    removeFromLiveIndexes(previous);
    byId.delete(id);
    const set = byType.get(previous.type);
    if (set) { set.delete(id); if (!set.size) byType.delete(previous.type); }
    return previous;
  }

  function restoreJournal(journal) {
    // Applied newest-first is unnecessary: each entry holds the state from
    // BEFORE the transaction touched that id, so order does not matter.
    for (const [id, previous] of journal) {
      const current = byId.get(id);
      if (current) {
        removeFromLiveIndexes(current);
        byId.delete(id);
        const set = byType.get(current.type);
        if (set) { set.delete(id); if (!set.size) byType.delete(current.type); }
      }
      if (previous) addToIndexes(previous);
    }
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`bus publish ${name} failed: ${err.message}`);
    }
  }

  /* --- loading ---------------------------------------------------------- */

  const recovery = {
    snapshotSeq: 0,
    snapshotRecords: 0,
    recovered: 0,
    skipped: 0,
    dropped: 0,
    truncatedBytes: 0,
    segments: 0,
    corrupt: [],
  };

  function decodeText(raw, what) {
    const text = raw.trim();
    if (!text) return null;
    if (text.charCodeAt(0) === 0x7b /* { */) return JSON.parse(text);
    if (!vault.enabled && looksEncrypted(text)) {
      throw new LockedError(`Der Vault (${what}) ist verschluesselt. Bitte zuerst mit der Passphrase entsperren.`);
    }
    return JSON.parse(vault.decryptLine(text));
  }

  function loadSnapshot() {
    let raw;
    try {
      raw = fs.readFileSync(paths.snapshot, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new StorageError(`Snapshot nicht lesbar: ${err.message}`, { cause: String(err) });
    }
    let parsed;
    try {
      parsed = decodeText(raw, 'Snapshot');
    } catch (err) {
      if (err instanceof LockedError) throw err;
      // The snapshot is a derived artefact: the log is the truth. Keep the
      // broken file for forensics and rebuild from seq 0 rather than refusing
      // to start.
      const backup = `${paths.snapshot}.corrupt-${Date.now()}`;
      try { fs.renameSync(paths.snapshot, backup); } catch { /* best effort */ }
      log.error(`Snapshot beschaedigt (gesichert als ${path.basename(backup)}); baue aus dem Log neu auf.`);
      recovery.corrupt.push({ where: 'snapshot', reason: err.message });
      return;
    }
    if (!parsed || !Array.isArray(parsed.records)) {
      log.error('Snapshot hat ein unbekanntes Format; baue aus dem Log neu auf.');
      recovery.corrupt.push({ where: 'snapshot', reason: 'unexpected shape' });
      return;
    }
    for (const record of parsed.records) {
      if (!record || typeof record.id !== 'string' || typeof record.type !== 'string') continue;
      addToIndexes(normaliseRecord(record));
    }
    seq = Number.isFinite(parsed.seq) ? parsed.seq : 0;
    recovery.snapshotSeq = seq;
    recovery.snapshotRecords = byId.size;
  }

  function normaliseRecord(raw) {
    return {
      id: raw.id,
      type: raw.type,
      createdAt: raw.createdAt || raw.updatedAt || nowIso(),
      updatedAt: raw.updatedAt || raw.createdAt || nowIso(),
      deletedAt: raw.deletedAt || null,
      rev: Number.isFinite(raw.rev) ? raw.rev : 1,
      data: isPlainObject(raw.data) ? raw.data : {},
    };
  }

  /**
   * Replay one segment.
   *
   * Parsing runs over the raw Buffer, not a decoded string, because the
   * truncation offset has to be an exact BYTE position and a JSON payload full
   * of umlauts has more bytes than characters.
   *
   * Two distinct damage shapes exist and they are treated differently:
   *   - a run of unreadable lines at the very END of the newest segment is what
   *     a crash mid-append looks like; it is cut off so the next write lands on
   *     a clean boundary.
   *   - damage anywhere else is NOT truncated (that would throw away every good
   *     line after it). It is skipped, counted and reported.
   */
  function replaySegment(segment, isLast) {
    let buf;
    try {
      buf = fs.readFileSync(segment.file);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new StorageError(`Log-Segment ${segment.name} nicht lesbar: ${err.message}`, { cause: String(err) });
    }
    if (!buf.length) return;

    /** @type {Array<{from:number,to:number,entry:object|null,error:Error|null}>} */
    const lines = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      lines.push({ from: start, to: i, entry: null, error: null, partial: false });
      start = i + 1;
    }
    if (start < buf.length) {
      // Bytes with no terminating newline: a torn write, by definition.
      lines.push({ from: start, to: buf.length, entry: null, error: new Error('partial trailing write'), partial: true });
    }

    for (const line of lines) {
      if (line.partial) continue;
      try {
        line.entry = decodeText(buf.toString('utf8', line.from, line.to), `Log-Segment ${segment.name}`);
      } catch (err) {
        if (err instanceof LockedError) throw err;
        line.error = err;
      }
    }

    // How far back does the damage at the tail reach?
    let cutFrom = -1;
    if (isLast) {
      for (let i = lines.length - 1; i >= 0 && lines[i].error; i--) cutFrom = lines[i].from;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.error) {
        recovery.dropped += 1;
        if (cutFrom === -1 || line.from < cutFrom) {
          log.error(`Log-Zeile ${i + 1} in ${segment.name} ist beschaedigt und wird uebersprungen.`);
          recovery.corrupt.push({ where: segment.name, line: i + 1, reason: line.error.message });
        }
        continue;
      }
      if (!line.entry) continue;
      applyLogEntry(line.entry, segment.name, i + 1);
    }

    if (cutFrom !== -1) truncateSegment(segment, cutFrom, 'damaged tail after an interrupted write');
  }

  function truncateSegment(segment, offset, reason) {
    try {
      const size = fs.statSync(segment.file).size;
      if (size > offset) {
        fs.truncateSync(segment.file, offset);
        recovery.truncatedBytes += size - offset;
      }
      recovery.corrupt.push({ where: segment.name, offset, reason });
      log.warn(`${segment.name}: ${size - offset} Byte am Ende abgeschnitten (${reason}).`);
    } catch (err) {
      throw new StorageError(`Beschaedigtes Log-Ende konnte nicht repariert werden: ${err.message}`, { cause: String(err) });
    }
  }

  function applyLogEntry(entry, segmentName_, lineNo) {
    if (!isPlainObject(entry) || typeof entry.op !== 'string' || typeof entry.id !== 'string') {
      recovery.dropped += 1;
      recovery.corrupt.push({ where: segmentName_, line: lineNo, reason: 'missing op/id' });
      return;
    }
    // A line with no seq cannot be proven redundant, so it is applied rather
    // than skipped: replaying an operation twice is idempotent here, losing
    // one is not.
    if (Number.isFinite(entry.seq)) {
      if (entry.seq > seq) seq = entry.seq;
      if (entry.seq <= recovery.snapshotSeq) {
        recovery.skipped += 1;
        return; // already materialised in the snapshot
      }
    }

    const existing = byId.get(entry.id);
    const at = entry.at || nowIso();
    switch (entry.op) {
      case 'create': {
        const record = normaliseRecord({
          id: entry.id,
          type: entry.type,
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
          rev: entry.rev,
          data: entry.data,
        });
        if (existing) removeFromLiveIndexes(existing);
        addToIndexes(record);
        break;
      }
      case 'update': {
        if (!existing) {
          // An update without its create means the create landed in a segment
          // that was lost. Materialise what we have rather than discard it.
          const record = normaliseRecord({
            id: entry.id,
            type: entry.type,
            createdAt: at,
            updatedAt: at,
            rev: entry.rev,
            data: entry.patch || entry.data || {},
          });
          addToIndexes(record);
          recovery.corrupt.push({ where: segmentName_, line: lineNo, reason: 'update without create' });
          break;
        }
        const record = {
          ...existing,
          updatedAt: at,
          rev: Number.isFinite(entry.rev) ? entry.rev : existing.rev + 1,
          data: { ...existing.data, ...(isPlainObject(entry.patch) ? entry.patch : {}) },
        };
        removeFromLiveIndexes(existing);
        addToIndexes(record);
        break;
      }
      case 'delete': {
        if (!existing) break;
        const record = { ...existing, deletedAt: at, updatedAt: at, rev: Number.isFinite(entry.rev) ? entry.rev : existing.rev + 1 };
        removeFromLiveIndexes(existing);
        addToIndexes(record);
        break;
      }
      case 'restore': {
        if (!existing) break;
        const record = { ...existing, deletedAt: null, updatedAt: at, rev: Number.isFinite(entry.rev) ? entry.rev : existing.rev + 1 };
        removeFromLiveIndexes(existing);
        addToIndexes(record);
        break;
      }
      case 'purge': {
        if (!existing) break;
        removeFromLiveIndexes(existing);
        byId.delete(entry.id);
        const set = byType.get(existing.type);
        if (set) { set.delete(entry.id); if (!set.size) byType.delete(existing.type); }
        break;
      }
      default:
        recovery.dropped += 1;
        recovery.corrupt.push({ where: segmentName_, line: lineNo, reason: `unknown op ${entry.op}` });
        return;
    }
    recovery.recovered += 1;
  }

  try {
    loadSnapshot();
    segments = listSegments(paths.log);
    recovery.segments = segments.length;
    for (let i = 0; i < segments.length; i++) {
      replaySegment(segments[i], i === segments.length - 1);
    }
  } catch (err) {
    // A vault we could not load is a vault we do not hold.
    if (ownsLock) { try { fs.unlinkSync(lockFile); } catch { /* ignore */ } }
    throw err;
  }

  segments = listSegments(paths.log);
  currentSegment = segments.length ? segments[segments.length - 1].index : 1;
  currentFile = path.join(paths.log, segmentName(currentSegment));

  if (recovery.dropped || recovery.corrupt.length) {
    log.warn(
      `Vault-Wiederherstellung: ${recovery.recovered} Operationen nachgespielt, ${recovery.dropped} Zeile(n) verworfen.`,
    );
  }

  /* --- mutations -------------------------------------------------------- */

  function assertOpen() {
    if (closed) throw new StorageError('Der Store ist bereits geschlossen.');
  }

  function nextSeq() {
    return ++seq;
  }

  function liveOrNull(id) {
    const record = byId.get(id);
    if (!record || record.deletedAt) return null;
    return record;
  }

  function create(type, data, opts = {}) {
    assertOpen();
    if (typeof type !== 'string' || !schema.TYPES.includes(type)) {
      throw new ValidationError(`Unbekannter Datensatztyp: ${String(type)}`, { type });
    }
    const normalised = schema.validate(type, isPlainObject(data) ? data : {});
    let id = opts.id;
    if (id !== undefined && id !== null) {
      if (!schema.isValidId(id)) throw new ValidationError(`Ungueltige ID: ${String(id)}`, { id });
      if (byId.has(id)) throw new ValidationError(`Es existiert bereits ein Datensatz mit der ID ${id}.`, { id });
    } else {
      do { id = makeId(type); } while (byId.has(id));
    }
    const at = nowIso();
    const record = { id, type, createdAt: at, updatedAt: at, deletedAt: null, rev: 1, data: normalised };
    place(record);
    append({ v: LOG_VERSION, seq: nextSeq(), op: 'create', at, id, type, rev: 1, data: normalised });
    const out = expose(record);
    publish('record.created', { id, type, record: out });
    if (type === 'edge') publish('edge.created', { id, edge: out });
    return out;
  }

  function get(id, opts = {}) {
    const record = byId.get(id);
    if (!record) return null;
    if (record.deletedAt && !opts.includeDeleted) return null;
    return expose(record);
  }

  function mustGet(id, opts = {}) {
    const record = get(id, opts);
    if (!record) throw new NotFoundError(`Record ${id}`);
    return record;
  }

  function update(id, patch, opts = {}) {
    assertOpen();
    const existing = byId.get(id);
    if (!existing || (existing.deletedAt && !opts.includeDeleted)) throw new NotFoundError(`Record ${id}`);
    if (!isPlainObject(patch)) throw new ValidationError('Patch muss ein Objekt sein.');
    const normalised = schema.validate(existing.type, patch, { partial: true });
    if (existing.type === 'edge' && ('from' in normalised || 'to' in normalised || 'kind' in normalised)) {
      // Changing an endpoint would silently break the dedupe key and the
      // adjacency index; edges are cheap, so require delete + add instead.
      throw new ValidationError('from/to/kind einer Kante koennen nicht geaendert werden. Kante loeschen und neu anlegen.');
    }
    const at = nowIso();
    const record = {
      ...existing,
      updatedAt: at,
      rev: existing.rev + 1,
      data: { ...existing.data, ...normalised },
    };
    place(record);
    append({ v: LOG_VERSION, seq: nextSeq(), op: 'update', at, id, type: record.type, rev: record.rev, patch: normalised });
    const out = expose(record);
    publish('record.updated', { id, type: record.type, record: out, patch: clone(normalised) });
    return out;
  }

  function remove(id, opts = {}) {
    assertOpen();
    const existing = byId.get(id);
    if (!existing) throw new NotFoundError(`Record ${id}`);
    const at = nowIso();

    if (opts.hard) {
      const cascaded = [];
      if (existing.type !== 'edge') {
        // Leaving edges pointing at a purged node would make the graph lie and
        // would let edges.add() believe a dedupe key is taken by a ghost.
        for (const edgeId of incidentEdgeIds(id, 'both')) {
          const edge = byId.get(edgeId);
          if (!edge) continue;
          drop(edgeId);
          append({ v: LOG_VERSION, seq: nextSeq(), op: 'purge', at, id: edgeId, type: 'edge', rev: edge.rev });
          cascaded.push(expose(edge));
        }
      }
      drop(id);
      append({ v: LOG_VERSION, seq: nextSeq(), op: 'purge', at, id, type: existing.type, rev: existing.rev });
      const out = expose(existing);
      for (const edge of cascaded) publish('edge.deleted', { id: edge.id, edge, cascaded: true });
      publish('record.deleted', { id, type: existing.type, record: out, hard: true, cascadedEdges: cascaded.length });
      if (existing.type === 'edge') publish('edge.deleted', { id, edge: out });
      return out;
    }

    if (existing.deletedAt) return expose(existing); // already a tombstone
    const record = { ...existing, deletedAt: at, updatedAt: at, rev: existing.rev + 1 };
    place(record);
    append({ v: LOG_VERSION, seq: nextSeq(), op: 'delete', at, id, type: record.type, rev: record.rev });
    const out = expose(record);
    publish('record.deleted', { id, type: record.type, record: out, hard: false });
    if (record.type === 'edge') publish('edge.deleted', { id, edge: out });
    return out;
  }

  function restore(id) {
    assertOpen();
    const existing = byId.get(id);
    if (!existing) throw new NotFoundError(`Record ${id}`);
    if (!existing.deletedAt) return expose(existing);
    if (existing.type === 'edge') {
      const { from, to, kind } = existing.data;
      if (!liveOrNull(from) || !liveOrNull(to)) {
        throw new ValidationError('Die Kante kann nicht wiederhergestellt werden, weil ein Endpunkt fehlt.', { from, to });
      }
      // While this edge was deleted the same connection may have been drawn
      // again. Restoring on top of it would put two live edges behind one
      // dedupe key, and the second one would become invisible to edges.add().
      const twinId = edgeKey.get(`${from}\u0000${to}\u0000${kind}`);
      if (twinId && twinId !== id) {
        const twin = byId.get(twinId);
        if (twin && !twin.deletedAt) return expose(twin);
      }
    }
    const at = nowIso();
    const record = { ...existing, deletedAt: null, updatedAt: at, rev: existing.rev + 1 };
    place(record);
    append({ v: LOG_VERSION, seq: nextSeq(), op: 'restore', at, id, type: record.type, rev: record.rev });
    const out = expose(record);
    publish('record.updated', { id, type: record.type, record: out, restored: true });
    if (record.type === 'edge') publish('edge.created', { id, edge: out, restored: true });
    return out;
  }

  /* --- queries ---------------------------------------------------------- */

  function envelopeOrData(record, field) {
    return ENVELOPE_KEYS.has(field) ? record[field] : record.data[field];
  }

  function matchesFilter(record, filter) {
    for (const [key, want] of Object.entries(filter)) {
      const have = envelopeOrData(record, key);
      if (Array.isArray(want)) {
        if (!want.includes(have)) return false;
      } else if (Array.isArray(have)) {
        if (!have.includes(want)) return false;
      } else if (have !== want) {
        return false;
      }
    }
    return true;
  }

  function typesOf(type) {
    if (type === undefined || type === null || type === '*') return Array.from(byType.keys());
    if (Array.isArray(type)) return type;
    return [type];
  }

  function list(type, q = {}) {
    const wanted = typesOf(type);
    const includeDeleted = q.includeDeleted === true;
    const filter = q.filter;
    const filterFn = typeof filter === 'function' ? filter : null;
    const filterObj = isPlainObject(filter) ? filter : null;

    const matched = [];
    for (const t of wanted) {
      const ids = byType.get(t);
      if (!ids) continue;
      for (const id of ids) {
        const record = byId.get(id);
        if (!record) continue;
        if (record.deletedAt && !includeDeleted) continue;
        if (filterObj && !matchesFilter(record, filterObj)) continue;
        if (filterFn && !filterFn(expose(record))) continue;
        matched.push(record);
      }
    }

    const sortField = typeof q.sort === 'string' && q.sort ? q.sort : 'updatedAt';
    const dir = q.order === 'asc' ? 1 : -1;
    matched.sort((a, b) => {
      const av = envelopeOrData(a, sortField);
      const bv = envelopeOrData(b, sortField);
      if (av === bv) return a.id < b.id ? -1 : 1; // stable, deterministic
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      return av < bv ? -dir : dir;
    });

    const total = matched.length;
    const offset = Number.isInteger(q.offset) && q.offset > 0 ? q.offset : 0;
    const limit = Number.isInteger(q.limit) && q.limit >= 0 ? q.limit : total;
    return { items: matched.slice(offset, offset + limit).map(expose), total };
  }

  function all(type) {
    return list(type, { limit: undefined }).items;
  }

  function count(type) {
    let n = 0;
    for (const t of typesOf(type)) {
      const ids = byType.get(t);
      if (!ids) continue;
      for (const id of ids) {
        const record = byId.get(id);
        if (record && !record.deletedAt) n++;
      }
    }
    return n;
  }

  function search(query, opts = {}) {
    const result = index.query(query, opts);
    const items = [];
    for (const hit of result.items) {
      const record = byId.get(hit.id);
      if (!record || record.deletedAt) continue; // index and store raced
      items.push({ record: expose(record), score: hit.score, snippet: hit.snippet });
    }
    return { items, total: result.total };
  }

  /* --- edges ------------------------------------------------------------ */

  function incidentEdgeIds(id, direction = 'both', kinds = null) {
    const out = [];
    const push = (set) => {
      if (!set) return;
      for (const edgeId of set) {
        if (kinds) {
          const edge = byId.get(edgeId);
          if (!edge || !kinds.includes(edge.data.kind)) continue;
        }
        out.push(edgeId);
      }
    };
    if (direction === 'out' || direction === 'both') push(edgesFrom.get(id));
    if (direction === 'in' || direction === 'both') push(edgesTo.get(id));
    return direction === 'both' ? Array.from(new Set(out)) : out;
  }

  const edges = {
    add(spec = {}) {
      assertOpen();
      const { from, to, kind = 'related', source = 'manual', reason = '', weight = 1 } = spec;
      if (typeof from !== 'string' || typeof to !== 'string') {
        throw new ValidationError('Kante benoetigt from und to als Strings.');
      }
      if (from === to) throw new ValidationError('Eine Kante darf nicht auf ihren eigenen Knoten zeigen.', { from });
      if (!liveOrNull(from)) throw new NotFoundError(`Record ${from}`);
      if (!liveOrNull(to)) throw new NotFoundError(`Record ${to}`);

      const existingId = edgeKey.get(`${from}\u0000${to}\u0000${kind}`);
      if (existingId) {
        const existing = byId.get(existingId);
        if (existing && !existing.deletedAt) return expose(existing);
      }
      return create('edge', { from, to, kind, source, reason, weight });
    },

    remove(id) {
      const record = byId.get(id);
      if (!record) throw new NotFoundError(`Edge ${id}`);
      if (record.type !== 'edge') throw new ValidationError(`${id} ist keine Kante.`);
      return remove(id);
    },

    for(id, opts = {}) {
      const direction = opts.direction || 'both';
      if (!['in', 'out', 'both'].includes(direction)) {
        throw new ValidationError(`Unbekannte Richtung: ${direction}`);
      }
      const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : null;
      const ids = incidentEdgeIds(id, direction, kinds);
      const out = [];
      for (const edgeId of ids) {
        const edge = byId.get(edgeId);
        if (edge && !edge.deletedAt) out.push(expose(edge));
      }
      out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
      const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : out.length;
      return out.slice(0, limit);
    },

    between(a, b) {
      const out = [];
      for (const edgeId of incidentEdgeIds(a, 'both')) {
        const edge = byId.get(edgeId);
        if (!edge || edge.deletedAt) continue;
        if (edge.data.from === b || edge.data.to === b) out.push(expose(edge));
      }
      return out;
    },

    /**
     * Breadth-first neighbourhood. `truncated` is set only when the node limit
     * actually cut the result short -- a depth limit is the caller's own
     * parameter, not a surprise, so it does not count as truncation.
     */
    neighbours(id, opts = {}) {
      const start = liveOrNull(id);
      if (!start) throw new NotFoundError(`Record ${id}`);
      const depth = Number.isInteger(opts.depth) && opts.depth >= 0 ? opts.depth : 1;
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 300;
      const types = Array.isArray(opts.types) && opts.types.length ? opts.types : null;
      const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : null;

      const nodes = new Map([[id, start]]);
      const found = new Map();
      let truncated = false;
      let frontier = [id];

      for (let d = 0; d < depth && frontier.length; d++) {
        const next = [];
        for (const nodeId of frontier) {
          for (const edgeId of incidentEdgeIds(nodeId, 'both', kinds)) {
            const edge = byId.get(edgeId);
            if (!edge || edge.deletedAt) continue;
            const otherId = edge.data.from === nodeId ? edge.data.to : edge.data.from;
            const other = liveOrNull(otherId);
            if (!other) continue;
            if (types && !types.includes(other.type)) continue;
            if (!nodes.has(otherId)) {
              if (nodes.size >= limit) { truncated = true; continue; }
              nodes.set(otherId, other);
              next.push(otherId);
            }
            found.set(edgeId, edge);
          }
        }
        frontier = next;
      }

      // Close the subgraph: edges between two included nodes that BFS never
      // traversed (siblings at the outer ring) still belong in the picture.
      for (const nodeId of nodes.keys()) {
        for (const edgeId of incidentEdgeIds(nodeId, 'out', kinds)) {
          if (found.has(edgeId)) continue;
          const edge = byId.get(edgeId);
          if (!edge || edge.deletedAt) continue;
          if (nodes.has(edge.data.to)) found.set(edgeId, edge);
        }
      }

      return {
        nodes: Array.from(nodes.values()).map(expose),
        edges: Array.from(found.values()).map(expose),
        truncated,
      };
    },

    count() {
      return count('edge');
    },
  };

  /* --- content-addressed blobs ------------------------------------------ */

  function blobPath(hash) {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      throw new ValidationError(`Ungueltiger Datei-Hash: ${String(hash)}`, { hash });
    }
    // Two-character fan-out: 256 directories keeps any single directory small
    // enough that ext4/APFS lookups stay O(1)-ish even with 100k blobs.
    return path.join(paths.files, hash.slice(0, 2), hash);
  }

  const files = {
    put(buffer, meta = {}) {
      assertOpen();
      // An empty file is legitimate content; `undefined` is a caller bug and
      // must not be silently turned into one.
      let buf;
      if (Buffer.isBuffer(buffer)) buf = buffer;
      else if (buffer instanceof Uint8Array) buf = Buffer.from(buffer);
      else if (typeof buffer === 'string') buf = Buffer.from(buffer, 'utf8');
      else throw new ValidationError('files.put() benoetigt einen Buffer, ein Uint8Array oder einen String.');
      // Hash the PLAINTEXT: identical content must land on one blob regardless
      // of whether encryption was on when it was written (IVs are random, so
      // hashing the ciphertext would defeat deduplication entirely).
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      const target = blobPath(hash);
      if (!fs.existsSync(target)) {
        const payload = vault.enabled ? vault.encryptBuffer(buf) : buf;
        if (!Buffer.isBuffer(payload)) throw new StorageError('vaultCrypto.encryptBuffer hat keinen Buffer geliefert.');
        const dir = path.dirname(target);
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
          fs.writeFileSync(tmp, payload, { mode: 0o600 });
          fs.renameSync(tmp, target); // atomic: a reader never sees a half blob
        } catch (err) {
          throw new StorageError(`Datei konnte nicht gespeichert werden: ${err.message}`, { cause: String(err) });
        }
      }
      return { hash, size: buf.length, path: target, name: meta.name || null, mime: meta.mime || 'application/octet-stream' };
    },

    read(hash) {
      const target = blobPath(hash);
      let raw;
      try {
        raw = fs.readFileSync(target);
      } catch (err) {
        if (err.code === 'ENOENT') throw new NotFoundError(`File ${hash}`);
        throw new StorageError(`Datei nicht lesbar: ${err.message}`, { cause: String(err) });
      }
      const out = vault.enabled ? vault.decryptBuffer(raw) : raw;
      if (!Buffer.isBuffer(out)) throw new StorageError('vaultCrypto.decryptBuffer hat keinen Buffer geliefert.');
      return out;
    },

    has(hash) {
      try {
        return fs.existsSync(blobPath(hash));
      } catch {
        return false; // an invalid hash simply is not present
      }
    },

    remove(hash) {
      const target = blobPath(hash);
      try {
        fs.unlinkSync(target);
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw new StorageError(`Datei konnte nicht geloescht werden: ${err.message}`, { cause: String(err) });
      }
    },

    path: blobPath,
  };

  /* --- transactions, durability, maintenance ---------------------------- */

  function transaction(fn) {
    assertOpen();
    if (typeof fn !== 'function') throw new ValidationError('transaction() benoetigt eine Funktion.');
    if (txDepth > 0) {
      // Nested: join the outer transaction so there is exactly one flush.
      txDepth += 1;
      try {
        return fn(store);
      } finally {
        txDepth -= 1;
      }
    }

    txDepth = 1;
    pending = [];
    txJournal = new Map();
    const journal = txJournal;

    /** Undo every in-memory change so memory can never outlive the log. */
    const abort = () => {
      pending = null;
      txJournal = null;
      txDepth = 0;
      restoreJournal(journal);
    };

    let result;
    try {
      result = fn(store);
    } catch (err) {
      abort();
      throw err;
    }

    const lines = pending;
    try {
      writeLines(lines);
    } catch (err) {
      // The log is the source of truth. Memory that disagrees with it would
      // resurrect itself as phantom data on the next reload, so a failed write
      // rolls the whole batch back instead of leaving a split brain.
      abort();
      throw err;
    }
    pending = null;
    txJournal = null;
    txDepth = 0;
    opsSinceSnapshot += lines.length;
    maybeSnapshot();
    return result;
  }

  async function flush() {
    if (fd === null) return;
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      throw new StorageError(`fsync auf dem Vault-Log fehlgeschlagen: ${err.message}`, { cause: String(err) });
    }
  }

  function snapshotPayload() {
    const records = [];
    for (const record of byId.values()) records.push(record);
    return { v: SNAPSHOT_VERSION, at: nowIso(), seq, records };
  }

  function compactSync() {
    assertOpen();
    if (pending) throw new StorageError('compact() ist waehrend einer Transaktion nicht erlaubt.');
    const payload = snapshotPayload();
    const json = JSON.stringify(payload);
    const body = vault.enabled ? vault.encryptLine(json) : json;
    const tmp = `${paths.snapshot}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, paths.snapshot); // snapshot first, log second
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw new StorageError(`Snapshot konnte nicht geschrieben werden: ${err.message}`, { cause: String(err) });
    }

    closeFd();
    for (const segment of listSegments(paths.log)) {
      try { fs.unlinkSync(segment.file); } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`Altes Log-Segment ${segment.name} blieb liegen: ${err.message}`);
      }
    }
    currentSegment = 1;
    currentFile = path.join(paths.log, segmentName(currentSegment));
    currentBytes = 0;
    opsSinceSnapshot = 0;
    recovery.snapshotSeq = seq;
    return { records: payload.records.length, bytes: Buffer.byteLength(body) };
  }

  async function compact() {
    return compactSync();
  }

  function vaultBytes() {
    let bytes = 0;
    for (const segment of listSegments(paths.log)) {
      try { bytes += fs.statSync(segment.file).size; } catch { /* vanished */ }
    }
    try { bytes += fs.statSync(paths.snapshot).size; } catch { /* no snapshot yet */ }
    return bytes;
  }

  function stats() {
    const counts = {};
    for (const [type, ids] of byType) {
      let live = 0;
      for (const id of ids) {
        const record = byId.get(id);
        if (record && !record.deletedAt) live++;
      }
      counts[type] = live;
    }
    return {
      counts,
      records: Array.from(byId.values()).filter((r) => !r.deletedAt).length,
      edges: counts.edge || 0,
      bytes: vaultBytes(),
      logSegments: listSegments(paths.log).length,
      lastWrite,
      seq,
      encrypted: vault.enabled,
      recovery: clone(recovery),
      search: index.stats(),
    };
  }

  async function close() {
    if (closed) return;
    try {
      await flush();
    } finally {
      closed = true;
      closeFd();
      if (ownsLock) {
        try { fs.unlinkSync(lockFile); } catch { /* already removed */ }
        ownsLock = false;
      }
    }
  }

  const store = {
    // identity + diagnostics
    paths,
    recovery,
    searchIndex: index,
    get closed() { return closed; },
    get encrypted() { return vault.enabled; },

    // records
    create,
    get,
    mustGet,
    update,
    remove,
    restore,
    list,
    all,
    count,
    search,

    // subsystems
    edges,
    files,

    // lifecycle
    transaction,
    flush,
    compact,
    stats,
    close,
  };

  return store;
}

module.exports = { openStore, makeId, SEGMENT_MAX_BYTES, SNAPSHOT_EVERY_OPS };
