'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { layout } = require('../kernel/paths');
const {
  NeuralError,
  ValidationError,
  NotFoundError,
  StorageError,
} = require('../kernel/errors');

/**
 * "Rückgängig" for everything -- including what an agent did overnight.
 *
 * Why this cannot be built on the vault log
 * -----------------------------------------
 * `src/store/engine.js` appends every mutation to a log, and after every write
 * it calls `maybeSnapshot()`. Once `SNAPSHOT_EVERY_OPS` (2000) operations have
 * accumulated that runs `compactSync()`, which materialises a snapshot and
 * then DELETES every log segment. The log is therefore a crash-durability
 * mechanism, not a history: it is complete only until the next compaction, and
 * afterwards the previous values of every record are gone for good. An undo
 * built on it would work all through development and silently stop working on
 * somebody's 2000th write -- which is worse than having no undo at all,
 * because by then they would be relying on it.
 *
 * So undo gets its own journal: one append-only JSONL file that compaction
 * never touches, carrying per change exactly what is needed to put it back.
 *
 * What this journal is NOT
 * ------------------------
 * It is not a version history and not a backup. It keeps the previous values
 * of changed fields, bounded by count and by age, so it can answer "nimm das
 * zurück" for a while -- not "wie sah diese Notiz im Mai aus". What falls out
 * of the bounds is gone, and `list()` says so by simply not offering it.
 * `src/store/backup.js` is the thing that keeps everything.
 *
 * Encryption
 * ----------
 * The journal holds the user's own words (old note bodies, former titles), so
 * it goes through the SAME `vaultCrypto` seam as the vault log. A plaintext
 * journal next to an encrypted vault would hand over the content of every
 * change the user ever made. The seam is re-stated here rather than imported
 * because engine.js does not export it.
 *
 * Attribution
 * -----------
 * The first question about a surprising change is "hat das ein Agent
 * gemacht?". The answer is read off the provenance stamp that `stamped()` in
 * src/agents/tools.js writes onto records an agent creates, never guessed from
 * what happened to be running at the time. Its honest limit is stated at
 * `actorOf()`.
 */

/* --------------------------------------------------------------- contract */

const JOURNAL_FILE = 'history.jsonl';

/** What an untouched config means. Both bounds are configurable. */
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_DAYS = 30;

/**
 * The file is only rewritten once it carries this much more than the cap.
 * Trimming on every write would turn an append-only journal into a
 * read-modify-write of the whole file for every changed character.
 */
const TRIM_FACTOR = 1.3;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const TITLE_MAX = 60;

/**
 * The types an undo means something for. An allow-list rather than a deny-list
 * on purpose: a record type somebody adds later is bookkeeping until a person
 * has decided what putting it back would even do.
 *
 * `edge` is the one that has to be argued. Derived links are not authored,
 * they are recomputed: `src/graph/derive.js` rebuilds them from the text that
 * implies them on every write, so undoing one would simply be undone again by
 * the next derivation -- an undo button that visibly does nothing, which is
 * exactly the kind of fake affordance this system refuses to ship. Links a
 * person drew by hand already have their own inverse (the delete button next
 * to them).
 * `run`, `message` and `approval` are records OF something that happened;
 * restoring an old value would not un-happen it. `grant`, `token`, `peer`,
 * `conflict` and `suggestion` carry credentials or a decision made elsewhere,
 * and quietly reviving a revoked grant would be a security hole wearing the
 * costume of a convenience.
 */
const UNDOABLE_TYPES = new Set([
  'note', 'chat', 'project', 'task', 'agent', 'file', 'entity', 'memory', 'schedule', 'trigger',
]);

/** German names for the types above, for the label the user reads. */
const TYPE_LABELS = {
  note: 'Notiz',
  chat: 'Chat',
  project: 'Projekt',
  task: 'Aufgabe',
  agent: 'Agent',
  file: 'Datei',
  entity: 'Begriff',
  memory: 'Erinnerung',
  schedule: 'Zeitplan',
  trigger: 'Auslöser',
};

/** Where each type keeps the one line a human recognises it by. */
const TITLE_FIELDS = {
  note: 'title',
  chat: 'title',
  project: 'name',
  task: 'title',
  agent: 'name',
  file: 'name',
  entity: 'name',
  memory: 'text',
  schedule: 'goal',
  trigger: 'goal',
};

const OP_VERBS = { create: 'angelegt', update: 'geändert', delete: 'gelöscht' };

const REASON_UNDONE = 'Diese Änderung wurde bereits rückgängig gemacht.';
const REASON_GONE = 'Der Eintrag existiert nicht mehr.';

const NOOP_LOGGER = { error() {}, warn() {}, info() {}, debug() {} };

/* ----------------------------------------------------------------- utils */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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

/** Read a bound from a config that may not have a `history` section at all. */
function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Same test engine.js uses: a line we cannot parse is either damaged or
 * encrypted-without-a-key, and those two need opposite responses.
 */
function looksEncrypted(text) {
  return text.length > 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function shorten(value, max = TITLE_MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The crypt seam, identical in behaviour to the one in engine.js: `enabled` is
 * read per call rather than captured, because the vault can be locked and
 * unlocked while this subsystem is running.
 */
function normaliseCrypto(vc) {
  if (!vc) {
    return {
      get enabled() { return false; },
      encryptLine: (s) => s,
      decryptLine: (s) => s,
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
  };
}

function normalisePaths(input) {
  if (typeof input === 'string') return layout(input);
  if (!isPlainObject(input) || typeof input.vault !== 'string') {
    throw new ValidationError('createHistory benoetigt paths mit einem vault-Verzeichnis.');
  }
  return input;
}

/* --------------------------------------------------------------- history */

/**
 * @param {{store:object, bus?:object, paths:object|string, config?:object,
 *          logger?:object|Function, vaultCrypto?:object, now?:()=>Date}} deps
 * @returns {object} history subsystem
 */
function createHistory({ store, bus, paths, config, logger, vaultCrypto, now } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.update !== 'function') {
    throw new ValidationError('createHistory benoetigt einen Store.');
  }
  const resolvedPaths = normalisePaths(paths);
  const log = typeof logger === 'function'
    ? (logger('history') || NOOP_LOGGER)
    : (logger && typeof logger.warn === 'function' ? logger : NOOP_LOGGER);
  const vault = normaliseCrypto(vaultCrypto);
  const clock = typeof now === 'function' ? now : () => new Date();

  const cfg = isPlainObject(config) && isPlainObject(config.history) ? config.history : {};
  const maxEntries = positiveInt(cfg.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxDays = positiveInt(cfg.maxDays, DEFAULT_MAX_DAYS);
  const rewriteAbove = Math.max(1, Math.ceil(maxEntries * TRIM_FACTOR));

  const journalFile = path.join(resolvedPaths.vault, JOURNAL_FILE);

  /** @type {Array<object>} entries oldest-first; the journal, in memory. */
  const entries = [];
  /** seq -> entry, so `undo(id)` is a lookup rather than a scan. */
  const bySeq = new Map();
  let seq = 0;
  /** Physical lines in the file, entries and undo marks alike. */
  let linesOnDisk = 0;
  /**
   * Lines we could not interpret, kept verbatim as they were read.
   *
   * They are written back untouched by every trim. Dropping them would be
   * silent data loss of the one thing this file exists to hold, and refusing
   * to trim while they exist would turn a single damaged line into an
   * unbounded file -- so they are carried instead of judged. A line that is
   * merely encrypted-and-we-have-no-key is still perfectly good ciphertext,
   * and it survives a trim by this route.
   */
  const carried = [];
  let failedWrites = 0;

  /** @type {Array<[string, Function]>} the bus listeners this instance added */
  const subscriptions = [];
  let running = false;
  /**
   * Set while `undo()` writes through the store. An undo that lands in the
   * journal makes "mach das rückgängig rückgängig" ambiguous -- two entries
   * describing opposite halves of one decision -- and invites a loop where
   * each undo produces the next undoable entry. The inverse is recorded by
   * marking the original entry undone, and nowhere else.
   */
  let suppressed = false;

  function at() {
    const value = clock();
    return value instanceof Date ? value : new Date(value);
  }

  function nowIso() {
    return at().toISOString();
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`);
    }
  }

  /* ------------------------------------------------------------ the file */

  function encodeLine(value) {
    const json = JSON.stringify(value);
    const line = vault.enabled ? vault.encryptLine(json) : json;
    if (typeof line !== 'string') throw new StorageError('vaultCrypto.encryptLine hat keinen String geliefert.');
    if (line.includes('\n')) throw new StorageError('Journal-Zeile enthaelt einen Zeilenumbruch und wuerde das Journal zerstoeren.');
    return line;
  }

  function decodeLine(raw) {
    const text = raw.trim();
    if (!text) return null;
    if (text.charCodeAt(0) === 0x7b /* { */) return JSON.parse(text);
    if (!vault.enabled && looksEncrypted(text)) {
      throw new StorageError('Der Aenderungsverlauf ist verschluesselt. Bitte zuerst den Vault entsperren.');
    }
    return JSON.parse(vault.decryptLine(text));
  }

  /**
   * One open/append/close per line instead of a long-lived descriptor.
   *
   * The trim below replaces the file by rename. A descriptor held across that
   * rename would keep writing into the unlinked old inode, and every entry
   * after the first trim would be lost without a single error -- a failure
   * mode this subsystem must not have. Journalled changes are a small subset
   * of all writes (no messages, no edges, no run steps), so the syscall per
   * entry is not worth that risk.
   */
  function appendLine(value) {
    const line = encodeLine(value);
    try {
      fs.mkdirSync(resolvedPaths.vault, { recursive: true, mode: 0o700 });
      fs.appendFileSync(journalFile, `${line}\n`, { mode: 0o600 });
    } catch (err) {
      throw new StorageError(`Der Aenderungsverlauf konnte nicht geschrieben werden: ${err.message}`, { cause: String(err) });
    }
    linesOnDisk += 1;
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(journalFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new StorageError(`Der Aenderungsverlauf ist nicht lesbar: ${err.message}`, { cause: String(err) });
    }
    for (const rawLine of raw.split('\n')) {
      if (!rawLine.trim()) continue;
      linesOnDisk += 1;
      let parsed;
      try {
        parsed = decodeLine(rawLine);
      } catch (err) {
        // One damaged line is not a reason to throw away the rest of the
        // journal, and not a reason to throw away the line either.
        carried.push(rawLine.trim());
        log.error(`Eine Zeile im Aenderungsverlauf ist unlesbar und wird unveraendert behalten: ${err.message}`);
        continue;
      }
      if (isPlainObject(parsed) && parsed.mark === 'undone') {
        const target = bySeq.get(parsed.seq);
        if (target) {
          target.undone = true;
          target.undoneAt = parsed.at || null;
        }
        continue;
      }
      if (!isPlainObject(parsed) || !Number.isFinite(parsed.seq)
        || typeof parsed.id !== 'string' || !OP_VERBS[parsed.op]) {
        // Readable but not something this version understands -- a journal
        // from a later version, most likely. Kept, not reinterpreted.
        carried.push(rawLine.trim());
        continue;
      }
      const entry = normaliseEntry(parsed);
      entries.push(entry);
      bySeq.set(entry.seq, entry);
      if (entry.seq > seq) seq = entry.seq;
    }
    prune();
  }

  function normaliseEntry(raw) {
    return {
      at: typeof raw.at === 'string' ? raw.at : nowIso(),
      seq: raw.seq,
      op: raw.op,
      id: raw.id,
      type: typeof raw.type === 'string' ? raw.type : 'unbekannt',
      label: typeof raw.label === 'string' ? raw.label : '',
      before: raw.before === undefined ? null : raw.before,
      fields: Array.isArray(raw.fields) ? raw.fields : null,
      rev: Number.isFinite(raw.rev) ? raw.rev : null,
      fromRev: Number.isFinite(raw.fromRev) ? raw.fromRev : null,
      actor: isPlainObject(raw.actor) ? raw.actor : { kind: 'user' },
      undone: raw.undone === true,
      undoneAt: typeof raw.undoneAt === 'string' ? raw.undoneAt : null,
    };
  }

  /** Drop what is over the count cap or past the age cap. In memory only. */
  function prune() {
    const cutoff = at().getTime() - maxDays * DAY_MS;
    let removed = 0;
    while (entries.length && (entries.length > maxEntries || Date.parse(entries[0].at) < cutoff)) {
      const gone = entries.shift();
      bySeq.delete(gone.seq);
      removed += 1;
    }
    return removed;
  }

  /**
   * Replace the file with what is left in memory, plus whatever we could not
   * read, unchanged.
   *
   * Written to a temp file and renamed, because a journal truncated by a crash
   * mid-rewrite would be a safety net that tore exactly when somebody reached
   * for it. Undo marks are folded into their entries here, which is what keeps
   * them from accumulating.
   */
  function rewrite() {
    const lines = carried.concat(entries.map((entry) => encodeLine(toLine(entry))));
    const body = lines.length ? `${lines.join('\n')}\n` : '';
    const tmp = `${journalFile}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(resolvedPaths.vault, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, journalFile);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never existed */ }
      throw new StorageError(`Der Aenderungsverlauf konnte nicht gekuerzt werden: ${err.message}`, { cause: String(err) });
    }
    linesOnDisk = lines.length;
    return true;
  }

  /**
   * Trim only when the file has actually drifted past the cap AND rewriting it
   * would shorten it. Without the second half, a journal that is mostly
   * unreadable lines would be rewritten from end to end on every single change
   * without ever getting smaller.
   */
  function maybeTrim() {
    if (linesOnDisk <= rewriteAbove) return false;
    if (carried.length + entries.length >= linesOnDisk) return false;
    return rewrite();
  }

  function toLine(entry) {
    const line = {
      at: entry.at,
      seq: entry.seq,
      op: entry.op,
      id: entry.id,
      type: entry.type,
      label: entry.label,
      before: entry.before,
      actor: entry.actor,
      undone: entry.undone,
    };
    if (entry.fields) line.fields = entry.fields;
    if (entry.rev !== null) line.rev = entry.rev;
    if (entry.fromRev !== null) line.fromRev = entry.fromRev;
    if (entry.undoneAt) line.undoneAt = entry.undoneAt;
    return line;
  }

  /* ---------------------------------------------------------- describing */

  function titleOf(type, data) {
    if (!isPlainObject(data)) return '';
    const field = TITLE_FIELDS[type];
    return field ? shorten(data[field]) : '';
  }

  /**
   * The label is computed now, not when the list is read, because by then the
   * record may be gone -- and "Eintrag note_x8f… gelöscht" is not something
   * anybody can recognise as the shopping list they want back.
   */
  function labelOf(op, type, data) {
    const what = TYPE_LABELS[type] || type;
    const title = titleOf(type, data);
    const verb = OP_VERBS[op] || 'geändert';
    return title ? `${what} „${title}" ${verb}` : `${what} ${verb}`;
  }

  /**
   * Who made this change.
   *
   * Read off the stamp `stamped()` puts on records an agent creates. Stated
   * honestly: for an update or a delete that stamp says who CREATED the
   * record, because `record.updated`/`record.deleted` carry no actor of their
   * own and `stamped()` is deliberately not applied to updates. So a note an
   * agent wrote and the user later edited is attributed to that agent's run.
   * The alternative -- inferring an actor from whichever run happens to be in
   * flight -- would be a guess, and a guess is the one answer this question
   * must never get.
   */
  /**
   * Wer diese Änderung gemacht hat.
   *
   * Zwei Quellen, in dieser Reihenfolge:
   *
   * 1. **Der Urheber am Ereignis** (`evt.payload.actor`). Der Speicher trägt
   *    ihn seit Neuestem durch die asynchrone Aufrufkette mit
   *    (`src/kernel/actor.js`), ein Agentenlauf setzt ihn einmal. Das ist die
   *    einzige Quelle, die auch bei einer *Änderung* stimmt -- und genau da
   *    lag vorher die Lücke: eine Notiz, die du geschrieben und ein Agent
   *    später bearbeitet hat, sah aus wie deine eigene Änderung.
   * 2. **Der Herkunftsstempel am Satz** (`runId`/`agentId`, gesetzt beim
   *    Anlegen). Er beantwortet zuverlässig nur „wer hat diesen Satz
   *    erzeugt?". Als Rückfall bleibt er für Sätze aus der Zeit vor dem
   *    Urheber-Kontext und für Aufrufwege, die die Kette verlassen.
   *
   * Ist beides unbekannt, heißt die Antwort `user`: ein Schreibvorgang ohne
   * Laufkontext kommt aus der Oberfläche oder von der Kommandozeile, und beide
   * bedienst du selbst.
   */
  function actorOf(data, patch, eventActor) {
    if (isPlainObject(eventActor) && eventActor.kind === 'agent') {
      return {
        kind: 'agent',
        runId: typeof eventActor.runId === 'string' ? eventActor.runId : null,
        agentId: typeof eventActor.agentId === 'string' ? eventActor.agentId : null,
        via: 'kontext',
      };
    }
    const source = isPlainObject(patch) && typeof patch.runId === 'string' ? patch : data;
    if (isPlainObject(source) && typeof source.runId === 'string' && source.runId) {
      return {
        kind: 'agent',
        runId: source.runId,
        agentId: typeof source.agentId === 'string' ? source.agentId : null,
        via: 'stempel',
      };
    }
    return { kind: 'user' };
  }

  /* ----------------------------------------------------------- recording */

  function record(op, { id, type, data, patch, before, rev, fromRev, eventActor }) {
    const entry = {
      at: nowIso(),
      seq: ++seq,
      op,
      id,
      type,
      label: labelOf(op, type, data),
      before: before === undefined ? null : before,
      fields: op === 'update' && isPlainObject(patch) ? Object.keys(patch) : null,
      rev: Number.isFinite(rev) ? rev : null,
      fromRev: Number.isFinite(fromRev) ? fromRev : null,
      actor: actorOf(data, patch, eventActor),
      undone: false,
      undoneAt: null,
    };

    appendLine(toLine(entry));
    entries.push(entry);
    bySeq.set(entry.seq, entry);

    // Memory obeys both bounds immediately so that what `list()` offers is
    // always inside them; the file catches up in batches.
    prune();
    maybeTrim();

    publish('history.recorded', { entry: clone(entry) });
    return entry;
  }

  /**
   * A failed journal write must not undo the write that triggered it.
   *
   * Known limitation, stated rather than hidden: `store.transaction()`
   * publishes its events as each change happens, and a transaction that throws
   * rolls the changes back without publishing anything to say so. An entry
   * from a rolled-back transaction therefore stays in the journal, where it
   * names a record that never came to exist -- `list()` shows it with
   * `canUndo: false` and the honest reason, and `undo()` refuses it. Fixing it
   * properly needs a rollback event from the engine.
   */
  function guard(fn) {
    return (event) => {
      if (suppressed || !running) return;
      try {
        fn(event);
      } catch (err) {
        failedWrites += 1;
        log.error(`Eine Aenderung konnte nicht in den Verlauf aufgenommen werden: ${err && err.message}`);
      }
    };
  }

  function payloadOf(event) {
    return event && isPlainObject(event.payload) ? event.payload : null;
  }

  function onCreated(event) {
    const payload = payloadOf(event);
    if (!payload || !payload.record || !UNDOABLE_TYPES.has(payload.record.type)) return;
    const created = payload.record;
    record('create', {
      id: created.id,
      type: created.type,
      data: created.data,
      // Nothing existed before a create: its inverse is a delete, and `before`
      // says so by being null rather than by being an empty object.
      before: null,
      rev: created.rev,
      eventActor: payload.actor,
    });
  }

  function onUpdated(event) {
    const payload = payloadOf(event);
    if (!payload || !payload.record || !UNDOABLE_TYPES.has(payload.record.type)) return;
    // A restore publishes `record.updated` without a `before`, because it is
    // itself the inverse of a delete. Journalling it with nothing to put back
    // would create an entry whose undo button could not work.
    if (!isPlainObject(payload.before)) return;

    // Keys whose previous value was `undefined` do not survive JSON, so they
    // are dropped from `before` here too -- in memory and on disk alike, so a
    // reload cannot behave differently from the session that wrote it. What
    // was changed is still known from `fields`, and `undo()` says out loud
    // which of them it could not restore.
    const before = {};
    for (const [key, value] of Object.entries(payload.before)) {
      if (value !== undefined) before[key] = clone(value);
    }
    record('update', {
      id: payload.record.id,
      type: payload.record.type,
      data: payload.record.data,
      patch: payload.patch,
      before,
      rev: payload.record.rev,
      fromRev: payload.fromRev,
      eventActor: payload.actor,
    });
  }

  function onDeleted(event) {
    const payload = payloadOf(event);
    if (!payload || !payload.record || !UNDOABLE_TYPES.has(payload.record.type)) return;
    const deleted = payload.record;
    record('delete', {
      id: deleted.id,
      type: deleted.type,
      data: deleted.data,
      // The whole record, because a delete takes the whole record away.
      before: clone(deleted.data),
      rev: deleted.rev,
      eventActor: payload.actor,
    });
  }

  /* --------------------------------------------------------- undoability */

  /** @returns {{canUndo:boolean, reason:string|null, current:object|null}} */
  function undoability(entry) {
    if (entry.undone) return { canUndo: false, reason: REASON_UNDONE, current: null };
    if (!UNDOABLE_TYPES.has(entry.type)) {
      const what = TYPE_LABELS[entry.type] || entry.type;
      return { canUndo: false, reason: `Änderungen an „${what}" können nicht zurückgenommen werden.`, current: null };
    }
    const current = store.get(entry.id, { includeDeleted: true });
    if (!current) {
      // Only a delete survives its record: everything else needs something to
      // act on, and a purged record leaves nothing.
      if (entry.op === 'delete') return { canUndo: true, reason: null, current: null };
      return { canUndo: false, reason: REASON_GONE, current: null };
    }
    if (Number.isFinite(entry.rev) && current.rev !== entry.rev) {
      return {
        canUndo: false,
        reason: `Der Eintrag wurde seitdem erneut geändert (Fassung ${entry.rev} → ${current.rev}).`,
        current,
      };
    }
    return { canUndo: true, reason: null, current };
  }

  function decorate(entry) {
    const state = undoability(entry);
    const item = clone(toLine(entry));
    item.canUndo = state.canUndo;
    if (!state.canUndo) item.reason = state.reason;
    return item;
  }

  /* ------------------------------------------------------------- reading */

  function matches(entry, filter) {
    if (filter.actor && (entry.actor.kind || 'user') !== filter.actor) return false;
    if (filter.type && entry.type !== filter.type) return false;
    if (filter.sinceMs !== null && Date.parse(entry.at) < filter.sinceMs) return false;
    return true;
  }

  function list(query = {}) {
    const q = isPlainObject(query) ? query : {};
    const limit = Number.isFinite(q.limit) ? Math.min(MAX_LIMIT, Math.max(0, Math.floor(q.limit))) : DEFAULT_LIMIT;
    const offset = Number.isFinite(q.offset) && q.offset > 0 ? Math.floor(q.offset) : 0;

    let sinceMs = null;
    if (q.since !== undefined && q.since !== null && q.since !== '') {
      const parsed = q.since instanceof Date ? q.since.getTime() : Date.parse(q.since);
      if (!Number.isFinite(parsed)) throw new ValidationError('"since" muss ein Zeitpunkt im ISO-Format sein.');
      sinceMs = parsed;
    }
    if (q.actor !== undefined && q.actor !== null && !['user', 'agent'].includes(q.actor)) {
      throw new ValidationError('"actor" muss user oder agent sein.');
    }
    const filter = { actor: q.actor || null, type: q.type || null, sinceMs };

    // Newest first: this list is read to find the thing that just went wrong.
    const matched = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      if (matches(entries[i], filter)) matched.push(entries[i]);
    }
    return {
      items: matched.slice(offset, offset + limit).map(decorate),
      total: matched.length,
    };
  }

  function stats() {
    const byActor = { user: 0, agent: 0 };
    let undoable = 0;
    // Only the newest entry per record can still be undoable -- `rev` is
    // monotonic, so an older entry can never match the record's current
    // revision again. Checking one entry per record keeps this from reading
    // (and copying) the same record out of the store a hundred times.
    const seen = new Set();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      byActor[entry.actor.kind === 'agent' ? 'agent' : 'user'] += 1;
      if (entry.undone || seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (undoability(entry).canUndo) undoable += 1;
    }
    let bytes = 0;
    try { bytes = fs.statSync(journalFile).size; } catch { /* nothing written yet */ }
    return {
      total: entries.length,
      undoable,
      byActor,
      oldest: entries.length ? entries[0].at : null,
      newest: entries.length ? entries[entries.length - 1].at : null,
      bytes,
      // Not in the agreed shape, but a journal that is silently incomplete
      // would be worse than one that says so: these two are the difference
      // between "nichts passiert" and "wir konnten es nicht aufschreiben".
      unreadable: carried.length,
      failedWrites,
    };
  }

  /* ---------------------------------------------------------------- undo */

  function refuse(reason, details) {
    return new NeuralError('HISTORY_NOT_UNDOABLE', reason, { status: 409, details: details || null });
  }

  function findEntry(entryId) {
    const key = Number(entryId);
    const entry = Number.isFinite(key) ? bySeq.get(key) : undefined;
    if (!entry) throw new NotFoundError(`Verlaufseintrag ${entryId}`);
    return entry;
  }

  function markUndone(entry) {
    entry.undone = true;
    entry.undoneAt = nowIso();
    // Appended rather than rewritten in place: the journal stays append-only,
    // so a crash here can lose at most this mark, never an entry. `rewrite()`
    // folds the marks back into their entries when it next trims.
    appendLine({ at: entry.undoneAt, mark: 'undone', seq: entry.seq });
    maybeTrim();
  }

  /**
   * Run the real inverse through the store with journalling switched off.
   * Synchronous on purpose: the bus is synchronous, so every event the store
   * publishes arrives inside this call, and an await in the middle would let
   * an unrelated write slip past the suppression.
   */
  function withoutJournalling(fn) {
    suppressed = true;
    try {
      return fn();
    } finally {
      suppressed = false;
    }
  }

  async function undo(entryId, opts = {}) {
    const entry = findEntry(entryId);
    const force = isPlainObject(opts) && opts.force === true;
    const state = undoability(entry);

    if (!state.canUndo) {
      // `force` answers exactly one question -- "ja, ich weiß, dass seitdem
      // etwas anderes passiert ist" -- and nothing else. An entry that is
      // already undone, or whose record is gone, has no inverse left to force.
      const forceable = state.current !== null && !entry.undone && UNDOABLE_TYPES.has(entry.type);
      if (!force || !forceable) throw refuse(state.reason, { seq: entry.seq, id: entry.id, force: forceable });
      log.warn(`Verlaufseintrag ${entry.seq} wird trotz neuerer Aenderung zurueckgenommen (force).`);
    }

    let applied;
    switch (entry.op) {
      case 'create': {
        // Only reachable with `force`: without it a record that is already a
        // tombstone has a different revision and the guard above refuses.
        // Saying "gelöscht" about something that was already gone would be a
        // report of work that did not happen.
        const before = store.get(entry.id, { includeDeleted: true });
        const removed = withoutJournalling(() => store.remove(entry.id));
        applied = { op: 'delete', id: removed.id, rev: removed.rev };
        if (before && before.deletedAt) {
          applied.note = 'Der Eintrag war bereits gelöscht; es wurde nichts geändert.';
        }
        break;
      }
      case 'update': {
        const patch = isPlainObject(entry.before) ? entry.before : {};
        const updated = withoutJournalling(() => store.update(entry.id, patch));
        applied = { op: 'update', id: updated.id, rev: updated.rev };
        // A field that had no value before this change cannot be given one
        // back: the store merges patches, it cannot remove a key. Saying so is
        // the difference between an undo and a half-undo dressed up as one.
        const missing = (entry.fields || []).filter((field) => !(field in patch));
        if (missing.length) {
          applied.note = `Diese Felder hatten vorher keinen Wert und bleiben, wie sie sind: ${missing.join(', ')}.`;
        }
        break;
      }
      case 'delete': {
        const current = store.get(entry.id, { includeDeleted: true });
        if (current) {
          const restored = withoutJournalling(() => store.restore(entry.id));
          applied = { op: 'restore', id: restored.id, rev: restored.rev };
          // Same honesty as above, and reachable the same way: somebody may
          // have brought it back by hand before pressing this.
          if (!current.deletedAt) {
            applied.note = 'Der Eintrag war bereits wieder vorhanden; es wurde nichts geändert.';
          }
        } else {
          // Hard-purged. The record can come back, its identity cannot: the
          // old id's edges were purged with it, and handing the id to a new
          // record would quietly point anything that still refers to it at
          // something that is not the original. So it gets a new one, and the
          // answer says so instead of implying the old entry returned.
          const data = isPlainObject(entry.before) ? entry.before : {};
          const created = withoutJournalling(() => store.create(entry.type, data));
          applied = {
            op: 'recreate',
            id: created.id,
            newId: created.id,
            oldId: entry.id,
            note: 'Der Eintrag war endgültig gelöscht und wurde unter einer neuen Kennung wiederhergestellt; '
              + 'frühere Verknüpfungen zu ihm sind verloren.',
          };
        }
        break;
      }
      default:
        throw refuse(`Unbekannte Änderungsart „${entry.op}".`, { seq: entry.seq });
    }

    markUndone(entry);
    const result = { entry: clone(toLine(entry)), applied };
    publish('history.undone', result);
    log.info(`Rueckgaengig: ${entry.label} (Eintrag ${entry.seq}).`);
    return result;
  }

  /* ----------------------------------------------------------- lifecycle */

  load();

  const history = {
    /** Where the journal lives, so the UI and a diagnosis can name the file. */
    file: journalFile,
    get running() { return running; },
    limits: { maxEntries, maxDays },

    /**
     * Subscribe to the bus. The handler references are kept so `stop()` can
     * remove exactly the listeners this instance added -- a subscription that
     * outlives `stop()` keeps writing history for a subsystem the user
     * switched off, and nothing in the journal would show where it came from.
     */
    start() {
      if (running) return true;
      if (!bus || typeof bus.on !== 'function') {
        log.warn('Kein Ereignisbus vorhanden; es wird kein Aenderungsverlauf aufgezeichnet.');
        return false;
      }
      running = true;
      for (const [name, handler] of [
        ['record.created', guard(onCreated)],
        ['record.updated', guard(onUpdated)],
        ['record.deleted', guard(onDeleted)],
      ]) {
        bus.on(name, handler);
        subscriptions.push([name, handler]);
      }
      log.info(`Aenderungsverlauf aktiv (${entries.length} Eintraege, hoechstens ${maxEntries} / ${maxDays} Tage).`);
      return true;
    },

    stop() {
      if (!running) return false;
      for (const [name, handler] of subscriptions) {
        if (bus && typeof bus.off === 'function') bus.off(name, handler);
      }
      subscriptions.length = 0;
      running = false;
      log.info('Aenderungsverlauf gestoppt.');
      return true;
    },

    list,
    stats,
    undo,

    /** One entry with its undoability, for a UI that already knows the id. */
    get(entryId) {
      return decorate(findEntry(entryId));
    },
  };

  return history;
}

module.exports = {
  createHistory,
  UNDOABLE_TYPES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_DAYS,
  JOURNAL_FILE,
};
