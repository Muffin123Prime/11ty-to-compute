'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const defaultExtract = require('./extract');
const {
  NeuralError,
  ValidationError,
  NotFoundError,
  StorageError,
  asNeuralError,
} = require('../kernel/errors');

/**
 * Beobachtete Ordner -- Dateien lesen, statt sie von Hand zu importieren.
 *
 * Why this is not "drop a folder in and forget about it"
 * -----------------------------------------------------
 * A folder that quietly pushes things into the vault is exactly the kind of
 * invisible automation this system otherwise avoids. Everything here is built
 * so that the answer to "what did it do?" is always available and always the
 * truth:
 *
 *  - A folder is read only after it was explicitly created AND explicitly
 *    switched on. `enabled` is false when the record is born (see the `watch`
 *    type in ./schema.js) and switching it on is a separate, owner-only act.
 *  - Every run produces a list: what was taken in, and what was skipped WITH
 *    THE REASON. A skipped file that nobody is told about is a silent loss.
 *  - `scan(id, {dryRun:true})` answers "what would happen" and touches
 *    nothing -- see the note on dryRun below.
 *
 * What this module will never do to the watched folder
 * ----------------------------------------------------
 * Read. That is the whole list. There is no `unlink`, no `rename`, no `write`,
 * no `utimes` anywhere in this file: the only fs calls made against the
 * watched directory are `readdir`, `lstat`, `realpath`, `readFile` and
 * `fs.watch`. Somebody's Documents folder is not ours to tidy up.
 *
 * Symbolic links are not followed. Ever.
 * --------------------------------------
 * `safeJoin` in ../kernel/paths.js catches a traversing *path string*, but a
 * symbolic link is a different attack on the same idea: the path stays inside
 * the folder and the kernel walks out of it anyway. A link named `alles` that
 * points at `/` would hand this program the whole disk; one pointing at
 * `~/.ssh` would put private keys into the vault as searchable plain text, and
 * from there into every export and every device sync. There is no reading of
 * link targets that is safe enough to be worth it, so every symlink is
 * reported as skipped and left alone. The user can always add the real
 * directory as a folder of its own -- explicitly, which is the point.
 *
 * Why the vault itself can never be watched
 * -----------------------------------------
 * Watching `paths.home` would make the system read its own blobs, write them
 * back as new blobs, notice those, and grow until the disk is full. Both
 * directions are refused: the folder may not lie inside the home directory,
 * and the home directory may not lie inside the folder.
 *
 * Why `fs.watch` is not trusted on its own
 * ----------------------------------------
 * It is unreliable on network shares, on some macOS versions and inside
 * containers, and its `recursive` option is not available everywhere. So it is
 * an accelerator, not the mechanism: a slow sweep walks every enabled folder
 * on a timer regardless, and the sweep is what actually guarantees that a file
 * eventually arrives. Both paths run through the same `scan()`, so there is
 * one behaviour to reason about and one behaviour to test.
 *
 * Why a dryRun never opens a file
 * -------------------------------
 * "Erst ansehen" must be cheap, must write nothing, and must be honest about
 * what it can know. It walks the directory and stats the entries -- names,
 * sizes, modification times -- and answers from that. What it therefore cannot
 * know is whether a file's *content* is already in the vault under a different
 * name; the result says so in `hinweis` rather than guessing. That also keeps
 * a switched-off folder genuinely unread: a preview reads the folder listing,
 * never the documents in it.
 */

/** A file that is already in the vault is recognised by its sha256. */
const HASH_ALGO = 'sha256';

/** How long to wait after a change before reading the file. */
const DEFAULT_DEBOUNCE_MS = 1200;
const MIN_DEBOUNCE_MS = 50;
const MAX_DEBOUNCE_MS = 60000;

/** The fallback sweep. Deliberately slow: it is a safety net, not a poller. */
const DEFAULT_SWEEP_MS = 5 * 60 * 1000;
const MIN_SWEEP_MS = 5000;
const MAX_SWEEP_MS = 6 * 60 * 60 * 1000;

/** Bounds for one run, so a folder full of surprises cannot become a hang. */
const MAX_ENTRIES_PER_SCAN = 5000;
const MAX_DEPTH = 12;
/** Extracted text per file. Matches what ./extract.js defaults to. */
const TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** Skipped files are remembered in memory only; this is how many per folder. */
const LOG_MAX = 300;
/** Above this many new files, one run goes through `bulkWrite` (see below). */
const BULK_THRESHOLD = 25;

/** Hard ceiling for `maxFileBytes`, mirroring ./extract.js. */
const MAX_FILE_BYTES_CEILING = 256 * 1024 * 1024;

/**
 * Extensions this system can read text from, and the media type recorded with
 * the blob. The *bytes* decide how a file is parsed (`extract.sniffKind`
 * ignores the name on purpose); this list only decides what is worth opening
 * at all, so that a watched Downloads folder does not try to read 400 MB of
 * video.
 */
const READABLE = new Map([
  ['.txt', 'text/plain'],
  ['.text', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.log', 'text/plain'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.json', 'application/json'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.xml', 'application/xml'],
  ['.rtf', 'application/rtf'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.epub', 'application/epub+zip'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.odp', 'application/vnd.oasis.opendocument.presentation'],
]);

/** Directories that are somebody's build output, not their documents. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache', '.Trash', '$RECYCLE.BIN']);

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

function conflict(message, details) {
  return new NeuralError('WATCH_BUSY', message, { status: 409, details: details || null });
}

function disabled(record) {
  return new NeuralError(
    'WATCH_DISABLED',
    `Der Ordner „${record.data.path}“ ist ausgeschaltet. Ein ausgeschalteter Ordner wird nicht gelesen – `
    + 'schalte ihn ein, wenn von dort aufgenommen werden soll.',
    { status: 409, details: { id: record.id } },
  );
}

/** `true` when `child` is `parent` or lies below it. Used in both directions. */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function extensionOf(name) {
  const ext = path.extname(name);
  return ext ? ext.toLowerCase() : '';
}

function normaliseExtensions(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) continue;
    const withDot = value.startsWith('.') ? value : `.${value}`;
    if (!out.includes(withDot)) out.push(withDot);
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * @param {object} deps
 * @param {object} deps.store        record store (required)
 * @param {object} deps.paths        layout, or the home directory as a string
 * @param {object} [deps.bus]
 * @param {object} [deps.config]     reads `config.watch` if present
 * @param {Function|object} [deps.logger]
 * @param {object} [deps.extract]    defaults to ./extract
 * @param {Function} [deps.now]      injectable clock, ms
 * @param {Function} [deps.bulkWrite] `(fn) => Promise` -- see BULK_THRESHOLD
 * @returns {object} Watcher
 */
function createWatcher(deps = {}) {
  const store = deps.store;
  if (!store || typeof store.create !== 'function' || typeof store.list !== 'function') {
    throw new ValidationError('createWatcher benötigt einen Store.');
  }
  const paths = typeof deps.paths === 'string' ? { home: deps.paths } : (deps.paths || {});
  if (typeof paths.home !== 'string' || !paths.home) {
    throw new ValidationError(
      'createWatcher benötigt paths.home. Ohne sie lässt sich nicht prüfen, ob ein Ordner den Tresor selbst enthält.',
    );
  }
  // Resolved through `realpath` for the same reason the watched folder is: on
  // macOS `/tmp` is a link to `/private/tmp`, so comparing unresolved strings
  // would let somebody watch the vault by naming it differently.
  const home = (() => {
    const resolved = path.resolve(paths.home);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved; // not created yet: the plain path is the best we have
    }
  })();
  const bus = deps.bus || null;
  const extract = deps.extract && typeof deps.extract.extractText === 'function' ? deps.extract : defaultExtract;
  const log = typeof deps.logger === 'function' ? deps.logger('store.watch') : (deps.logger || nullLogger());
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const bulkWrite = typeof deps.bulkWrite === 'function' ? deps.bulkWrite : null;

  const watchConfig = (deps.config && typeof deps.config.watch === 'object' && deps.config.watch) || {};
  const debounceMs = clampInt(watchConfig.debounceMs, MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS);
  let sweepMs = clampInt(watchConfig.sweepIntervalMs, MIN_SWEEP_MS, MAX_SWEEP_MS, DEFAULT_SWEEP_MS);

  /* --- live state, all of it torn down by stop() ------------------------ */

  let running = false;
  /** @type {NodeJS.Timeout|null} */
  let sweepTimer = null;
  /** @type {Map<string, {watcher:object|null, signature:string, kind:string, problem:string|null}>} */
  const attached = new Map();
  /** @type {Map<string, NodeJS.Timeout>} per-file debounce; key `${id}\u0000${rel}` */
  const pending = new Map();
  /** @type {Map<string, Array<object>>} skipped entries, in memory, per watch id */
  const skipLog = new Map();
  /** @type {Set<string>} ids with a run in flight; two clicks are not two imports */
  const busy = new Set();
  /** Bus subscriptions, so `stop()` really removes everything it added. */
  const busHandlers = [];

  function emit(name, payload) {
    if (bus && typeof bus.publish === 'function') {
      try {
        bus.publish(name, payload);
      } catch (err) {
        log.debug(`Ereignis ${name} konnte nicht veröffentlicht werden: ${err && err.message}`);
      }
    }
  }

  /* --- records ---------------------------------------------------------- */

  function records() {
    return store.list('watch', { limit: 500, sort: 'createdAt', order: 'asc' }).items;
  }

  function mustGet(id) {
    const record = store.get(id);
    if (!record || record.type !== 'watch') throw new NotFoundError(`Beobachteter Ordner ${id}`);
    return record;
  }

  /**
   * Resolve and vet a folder path.
   *
   * `realpath` is applied to the folder itself so that adding a symlink AS the
   * watched folder cannot smuggle past the home-directory check -- the checks
   * below then run against the place the kernel would actually read.
   */
  function resolveFolder(input) {
    const raw = String(input === undefined || input === null ? '' : input).trim();
    if (!raw) {
      throw new ValidationError(
        'Es wurde kein Ordner angegeben. Trage den vollständigen Pfad ein, zum Beispiel /home/du/Dokumente '
        + 'oder C:\\Users\\Du\\Dokumente.',
      );
    }
    if (raw.includes('\u0000')) throw new ValidationError('Der Pfad enthält ein unzulässiges Zeichen.');

    let abs = path.resolve(raw);
    let stats;
    try {
      abs = fs.realpathSync(abs);
      stats = fs.statSync(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new NotFoundError(`Der Ordner ${abs}`);
      }
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
        throw new NeuralError('WATCH_UNREADABLE', `Der Ordner ${abs} darf von diesem Programm nicht gelesen werden.`, {
          status: 403,
          details: { path: abs },
        });
      }
      throw new StorageError(`Der Ordner ${abs} ist nicht erreichbar: ${err.message}`, { cause: String(err) });
    }
    if (!stats.isDirectory()) throw new ValidationError(`${abs} ist kein Ordner, sondern eine Datei.`);

    // Both directions. Inside the home directory the system would read its own
    // blobs; above it, the home directory is part of the folder being walked
    // and the same loop happens one level up.
    if (isInside(abs, home)) {
      throw new ValidationError(
        `${abs} liegt im Datenordner von Neural OS (${home}). Der Tresor kann sich nicht selbst beobachten – `
        + 'er würde seine eigenen Dateien aufnehmen und dabei immer weiter wachsen.',
      );
    }
    if (isInside(home, abs)) {
      throw new ValidationError(
        `${abs} enthält den Datenordner von Neural OS (${home}). Wähle einen Ordner, der den Tresor nicht enthält, `
        + 'sonst nimmt das System seine eigenen Dateien auf.',
      );
    }
    return abs;
  }

  /** Already-watched folders, so the same directory is not added twice. */
  function assertNotDuplicate(abs, exceptId) {
    for (const record of records()) {
      if (record.id === exceptId) continue;
      if (path.resolve(record.data.path) === abs) {
        throw new ValidationError(`${abs} wird bereits beobachtet („${record.data.label || record.data.path}“).`);
      }
    }
  }

  function add(input = {}) {
    const abs = resolveFolder(input.path);
    assertNotDuplicate(abs, null);

    const data = {
      path: abs,
      label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : path.basename(abs),
      // Never taken from the caller: a folder that is on the moment it is
      // created is the invisible automation this feature exists to avoid.
      enabled: false,
      recursive: input.recursive !== false,
      extensions: normaliseExtensions(input.extensions),
      tags: Array.isArray(input.tags)
        ? input.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 20)
        : [],
      maxFileBytes: clampInt(input.maxFileBytes, 1, MAX_FILE_BYTES_CEILING, 25 * 1024 * 1024),
    };
    const record = store.create('watch', data);
    emit('watch.changed', { id: record.id, what: 'angelegt' });
    return record;
  }

  function update(id, patch = {}) {
    const record = mustGet(id);
    const next = {};
    if (patch.path !== undefined) {
      const abs = resolveFolder(patch.path);
      assertNotDuplicate(abs, id);
      next.path = abs;
    }
    if (patch.label !== undefined) next.label = String(patch.label || '').trim();
    if (patch.recursive !== undefined) next.recursive = patch.recursive !== false;
    if (patch.extensions !== undefined) next.extensions = normaliseExtensions(patch.extensions);
    if (patch.tags !== undefined) {
      next.tags = Array.isArray(patch.tags)
        ? patch.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 20)
        : [];
    }
    if (patch.maxFileBytes !== undefined) {
      next.maxFileBytes = clampInt(patch.maxFileBytes, 1, MAX_FILE_BYTES_CEILING, record.data.maxFileBytes);
    }
    const switching = patch.enabled !== undefined;
    if (!switching && !Object.keys(next).length) throw new ValidationError('Es wurde keine Änderung übergeben.');

    // The other fields first, so that switching on in the same request arms
    // the folder the user just described, not the one it used to be.
    let updated = record;
    if (Object.keys(next).length) {
      updated = store.update(id, next);
      reattach(updated);
      emit('watch.changed', { id, what: 'geändert' });
    }
    if (switching) updated = enable(id, patch.enabled !== false);
    return updated;
  }

  /**
   * The switch.
   *
   * Switching on does NOT import anything by itself -- it arms the folder. The
   * first take-in happens on the next change or the next sweep, or immediately
   * when the user asks for it. Keeping the two apart means "einschalten" has
   * exactly one consequence, and the interface can state it in one sentence.
   */
  function enable(id, value) {
    const record = mustGet(id);
    const enabled = value !== false;
    if (record.data.enabled === enabled) return record;
    const updated = store.update(id, { enabled, lastError: enabled ? null : record.data.lastError });
    reattach(updated);
    emit('watch.changed', { id, what: enabled ? 'eingeschaltet' : 'ausgeschaltet' });
    log.info(`Ordner ${updated.data.path} ${enabled ? 'eingeschaltet' : 'ausgeschaltet'}.`);
    return updated;
  }

  function remove(id) {
    const record = mustGet(id);
    detach(id);
    skipLog.delete(id);
    const removed = store.remove(id);
    emit('watch.changed', { id, what: 'entfernt' });
    // The `file` records this folder produced stay. They are the user's data
    // now, and deleting them behind their back because a folder was removed
    // from a list would be a surprise of exactly the wrong kind.
    return removed;
  }

  /* --- the vault's side: what is already in ----------------------------- */

  /**
   * One pass over the `file` records, so a scan of 500 files does not do 500
   * linear searches. Two indexes, answering two different questions:
   *   byHash -- "is this content already here?" (catches renamed copies)
   *   byPath -- "is this exact file, unchanged, already here?" (lets the sweep
   *             skip it without reading it at all)
   */
  function buildIndex() {
    const byHash = new Set();
    const byPath = new Map();
    for (const record of store.all('file')) {
      const data = record.data || {};
      if (typeof data.hash === 'string' && data.hash) byHash.add(data.hash);
      if (typeof data.externalPath === 'string' && data.externalPath) {
        byPath.set(path.resolve(data.externalPath), record);
      }
    }
    return { byHash, byPath };
  }

  /* --- the folder's side: walking it ------------------------------------ */

  /**
   * Collect candidate files.
   *
   * Uses `withFileTypes`, which reports a symlink AS a symlink without
   * following it -- the one property this walk depends on. Anything that is
   * not a plain file or a plain directory (sockets, devices, FIFOs) is skipped
   * too: opening a FIFO blocks for ever.
   */
  function walk(root, { recursive, skipped }) {
    const files = [];
    const stack = [{ dir: root, depth: 0 }];
    let truncated = null;

    while (stack.length) {
      const { dir, depth } = stack.shift();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        skipped.push({
          datei: path.relative(root, dir) || '.',
          grund: `Der Ordner ist nicht lesbar (${err.code || err.message}).`,
        });
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));

      for (const entry of entries) {
        if (files.length >= MAX_ENTRIES_PER_SCAN) {
          truncated = `Es wurden ${MAX_ENTRIES_PER_SCAN} Dateien betrachtet; der Rest kommt beim nächsten Durchlauf dran.`;
          stack.length = 0;
          break;
        }
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full);

        if (entry.isSymbolicLink()) {
          // The whole point. See the module comment: a link is not followed,
          // it is reported. `readlink` is not called either -- where it points
          // is not this program's business.
          skipped.push({ datei: rel, grund: 'Symbolischer Link – wird nicht verfolgt.' });
          continue;
        }
        if (entry.name.startsWith('.')) {
          if (entry.isDirectory()) continue; // .git, .config: not documents
          skipped.push({ datei: rel, grund: 'Versteckte Datei.' });
          continue;
        }
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          if (!recursive) continue;
          if (depth + 1 > MAX_DEPTH) {
            skipped.push({ datei: rel, grund: `Tiefer als ${MAX_DEPTH} Ebenen – nicht weiter verfolgt.` });
            continue;
          }
          stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) {
          skipped.push({ datei: rel, grund: 'Keine gewöhnliche Datei.' });
          continue;
        }
        files.push({ abs: full, rel, name: entry.name });
      }
    }
    return { files, truncated };
  }

  /* --- taking one file in ----------------------------------------------- */

  function mimeFor(name) {
    return READABLE.get(extensionOf(name)) || 'application/octet-stream';
  }

  /**
   * Decide about one file without opening it.
   * @returns {{skip:string}|{ok:true, stat:object}}
   */
  function inspect(record, file, index) {
    const allowed = record.data.extensions;
    const ext = extensionOf(file.name);
    if (allowed.length) {
      if (!allowed.includes(ext)) return { skip: `Endung ${ext || '(keine)'} steht nicht in der Liste dieses Ordners.` };
    } else if (!READABLE.has(ext)) {
      return { skip: `Aus ${ext || 'einer Datei ohne Endung'} kann dieses System keinen Text lesen.` };
    }

    let stat;
    try {
      // lstat, not stat: the walk already refused symlinks, and this keeps the
      // second look at the same file free of a follow as well.
      stat = fs.lstatSync(file.abs);
    } catch (err) {
      return { skip: `Nicht lesbar (${err.code || err.message}).` };
    }
    if (!stat.isFile()) return { skip: 'Keine gewöhnliche Datei.' };
    if (stat.size === 0) return { skip: 'Die Datei ist leer.' };

    const limit = record.data.maxFileBytes;
    if (stat.size > limit) {
      return {
        skip: `Zu groß: ${Math.round(stat.size / 1024)} kB, erlaubt sind ${Math.round(limit / 1024)} kB. `
          + 'Halb gelesen wird nichts.',
      };
    }

    const known = index.byPath.get(path.resolve(file.abs));
    if (known) {
      const sameSize = Number(known.data.size) === stat.size;
      const sameTime = Number(known.data.sourceMtimeMs) === Math.round(stat.mtimeMs);
      if (sameSize && sameTime) return { skip: 'Schon aufgenommen und seitdem unverändert.' };
    }
    return { ok: true, stat };
  }

  /**
   * Read one vetted file and put it in the vault.
   * @returns {{taken:object}|{skip:string}}
   */
  function take(record, file, stat, index) {
    let buffer;
    try {
      buffer = fs.readFileSync(file.abs);
    } catch (err) {
      return { skip: `Nicht lesbar (${err.code || err.message}).` };
    }
    // The file may have grown between the stat and the read.
    if (buffer.length > record.data.maxFileBytes) {
      return { skip: `Zwischenzeitlich gewachsen auf ${Math.round(buffer.length / 1024)} kB – übersprungen.` };
    }

    const hash = crypto.createHash(HASH_ALGO).update(buffer).digest('hex');
    if (index.byHash.has(hash)) {
      // `store.files` is content-addressed, so the same bytes would land on
      // the same blob anyway -- but a second `file` record pointing at it is
      // still a duplicate in every list the user reads. Caught here instead.
      return { skip: 'Derselbe Inhalt liegt schon im Tresor.' };
    }

    let extracted;
    try {
      extracted = extract.extractText(buffer, { name: file.name, mime: mimeFor(file.name), maxBytes: TEXT_MAX_BYTES });
    } catch (err) {
      // A format we cannot read is a fact, not a crash. It is reported with
      // the extractor's own sentence and the run continues.
      return { skip: `Text nicht lesbar: ${asNeuralError(err).message}` };
    }

    let blob;
    try {
      blob = store.files.put(buffer, { name: file.name, mime: mimeFor(file.name) });
    } catch (err) {
      return { skip: `Konnte nicht gespeichert werden: ${asNeuralError(err).message}` };
    }

    const warnings = Array.isArray(extracted.warnings) ? extracted.warnings.slice(0, 10) : [];
    const created = store.create('file', {
      name: file.name,
      hash: blob.hash,
      mime: mimeFor(file.name),
      size: buffer.length,
      // Never a substitute: a scanned PDF has kind 'pdf-image', an empty text
      // and a warning saying so. That warning travels with the record.
      text: typeof extracted.text === 'string' ? extracted.text : null,
      externalPath: file.abs,
      tags: record.data.tags.slice(),
      // Extra fields; ./schema.js keeps unknown keys inside `data`. They are
      // what makes the "das habe ich aufgenommen" list answerable later.
      watchId: record.id,
      sourceMtimeMs: Math.round(stat.mtimeMs),
      extractKind: extracted.kind || null,
      extractWarnings: warnings,
      truncated: extracted.truncated === true,
    });

    index.byHash.add(blob.hash);
    index.byPath.set(path.resolve(file.abs), created);
    return { taken: created, warnings, kind: extracted.kind };
  }

  /* --- the run ----------------------------------------------------------- */

  function remember(id, entry) {
    const entries = skipLog.get(id) || [];
    entries.unshift({ at: new Date(now()).toISOString(), ...entry });
    if (entries.length > LOG_MAX) entries.length = LOG_MAX;
    skipLog.set(id, entries);
  }

  /**
   * Walk a folder and take in what belongs in the vault.
   *
   * @param {string} id
   * @param {{dryRun?:boolean, quiet?:boolean}} [opts]
   * @returns {Promise<object>} gefunden / aufgenommen / uebersprungen / dauerMs
   */
  async function scan(id, opts = {}) {
    const record = mustGet(id);
    const dryRun = opts.dryRun === true;
    if (!record.data.enabled && !dryRun) throw disabled(record);
    if (busy.has(id)) {
      throw conflict(`Für „${record.data.label || record.data.path}“ läuft bereits ein Durchlauf.`, { id });
    }

    busy.add(id);
    const started = now();
    try {
      return await runScan(record, { dryRun, quiet: opts.quiet === true, started });
    } finally {
      busy.delete(id);
    }
  }

  async function runScan(record, { dryRun, quiet, started }) {
    const id = record.id;
    const result = {
      id,
      ordner: record.data.path,
      dryRun,
      gefunden: 0,
      aufgenommen: 0,
      wuerdeAufnehmen: 0,
      neu: [],
      uebersprungen: [],
      warnungen: [],
      sammelschreibung: false,
      abgebrochen: null,
      hinweis: null,
      dauerMs: 0,
    };

    // A folder that has been unplugged is a state, not a crash: it is written
    // into `lastError` so the panel can say what is wrong with which folder.
    let root;
    try {
      root = resolveFolder(record.data.path);
    } catch (err) {
      const message = asNeuralError(err).message;
      store.update(id, { lastError: message, lastScanAt: new Date(now()).toISOString() });
      result.dauerMs = Math.max(0, now() - started);
      result.abgebrochen = message;
      if (!quiet) log.warn(`Ordner ${record.data.path} nicht lesbar: ${message}`);
      return result;
    }

    const index = buildIndex();
    const { files, truncated } = walk(root, { recursive: record.data.recursive, skipped: result.uebersprungen });
    result.gefunden = files.length;
    result.abgebrochen = truncated;

    /** @type {Array<{file:object, stat:object}>} */
    const candidates = [];
    for (const file of files) {
      const verdict = inspect(record, file, index);
      if (verdict.skip) {
        result.uebersprungen.push({ datei: file.rel, grund: verdict.skip });
        continue;
      }
      candidates.push({ file, stat: verdict.stat });
    }
    result.wuerdeAufnehmen = candidates.length;

    if (dryRun) {
      result.neu = candidates.slice(0, 200).map((c) => ({ datei: c.file.rel, groesse: c.stat.size }));
      result.hinweis = 'Nur angesehen: keine Datei wurde geöffnet und nichts wurde gespeichert. '
        + 'Ob derselbe Inhalt schon unter einem anderen Namen im Tresor liegt, zeigt sich deshalb erst beim Aufnehmen.';
      result.dauerMs = Math.max(0, now() - started);
      // Nichts ins Protokoll: eine Vorschau hat keine Datei übersprungen, sie
      // hat gesagt, was sie überspringen WÜRDE. Das eine ist ein Ereignis,
      // das andere eine Ankündigung, und eine Liste, die beides mischt,
      // beantwortet die Frage „was ist passiert?" nicht mehr.
      return result;
    }

    // Above the threshold this is an import, and an import that fills the undo
    // journal pushes out the user's own last changes. `bulkWrite` is the
    // composition root's way of suspending it; without it wired we say so in
    // the result rather than quietly doing the damage.
    const useBulk = !!bulkWrite && candidates.length > BULK_THRESHOLD;
    result.sammelschreibung = useBulk;

    const doImport = () => {
      for (const { file, stat } of candidates) {
        const outcome = take(record, file, stat, index);
        if (outcome.skip) {
          result.uebersprungen.push({ datei: file.rel, grund: outcome.skip });
          continue;
        }
        result.aufgenommen += 1;
        result.neu.push({ datei: file.rel, groesse: stat.size, id: outcome.taken.id });
        if (outcome.warnings && outcome.warnings.length) {
          for (const warning of outcome.warnings) {
            const line = `${file.rel}: ${warning}`;
            if (!result.warnungen.includes(line)) result.warnungen.push(line);
          }
        }
        remember(id, {
          datei: file.rel,
          was: 'aufgenommen',
          recordId: outcome.taken.id,
          warnungen: outcome.warnings || [],
        });
      }
    };

    try {
      if (useBulk) await bulkWrite(doImport);
      else doImport();
    } catch (err) {
      const message = asNeuralError(err).message;
      result.abgebrochen = message;
      log.error(`Aufnahme aus ${root} abgebrochen: ${message}`);
    }

    for (const entry of result.uebersprungen) remember(id, { ...entry, was: 'übersprungen' });

    const failed = result.abgebrochen;
    store.update(id, {
      lastScanAt: new Date(now()).toISOString(),
      lastError: failed || null,
      imported: Number(record.data.imported || 0) + result.aufgenommen,
      skipped: Number(record.data.skipped || 0) + result.uebersprungen.length,
    });

    result.dauerMs = Math.max(0, now() - started);
    if (!quiet || result.aufgenommen) {
      log.info(`${root}: ${result.aufgenommen} aufgenommen, ${result.uebersprungen.length} übersprungen `
        + `(${result.dauerMs} ms).`);
    }
    emit('watch.scanned', {
      id,
      aufgenommen: result.aufgenommen,
      uebersprungen: result.uebersprungen.length,
      dryRun: false,
    });
    return result;
  }

  /**
   * One file, because `fs.watch` said it changed.
   *
   * Goes through exactly the same checks as a full run -- the fast path must
   * not be the lenient path.
   */
  function takeOne(record, relName) {
    const id = record.id;
    if (busy.has(id)) return; // a full run is already looking at this folder
    let root;
    try {
      root = resolveFolder(record.data.path);
    } catch {
      return; // the sweep will record the real reason in lastError
    }
    const abs = path.resolve(root, relName);
    if (!isInside(abs, root)) return; // a name from outside the folder is not ours

    const file = { abs, rel: path.relative(root, abs), name: path.basename(abs) };
    let entryStat;
    try {
      entryStat = fs.lstatSync(abs);
    } catch {
      return; // gone again before we looked: nothing to do, nothing to report
    }
    if (entryStat.isSymbolicLink()) {
      remember(id, { datei: file.rel, was: 'übersprungen', grund: 'Symbolischer Link – wird nicht verfolgt.' });
      return;
    }
    if (!entryStat.isFile()) return;

    busy.add(id);
    try {
      const index = buildIndex();
      const verdict = inspect(record, file, index);
      if (verdict.skip) {
        remember(id, { datei: file.rel, was: 'übersprungen', grund: verdict.skip });
        const before = store.get(id);
        if (before) store.update(id, { skipped: Number(before.data.skipped || 0) + 1 });
        return;
      }
      const outcome = take(record, file, verdict.stat, index);
      const current = store.get(id);
      if (!current) return;
      if (outcome.skip) {
        remember(id, { datei: file.rel, was: 'übersprungen', grund: outcome.skip });
        store.update(id, { skipped: Number(current.data.skipped || 0) + 1 });
        return;
      }
      remember(id, {
        datei: file.rel,
        was: 'aufgenommen',
        recordId: outcome.taken.id,
        warnungen: outcome.warnings || [],
      });
      store.update(id, {
        imported: Number(current.data.imported || 0) + 1,
        lastScanAt: new Date(now()).toISOString(),
        lastError: null,
      });
      emit('watch.scanned', { id, aufgenommen: 1, uebersprungen: 0, dryRun: false });
    } catch (err) {
      log.warn(`Datei ${file.rel} konnte nicht aufgenommen werden: ${asNeuralError(err).message}`);
    } finally {
      busy.delete(id);
    }
  }

  /* --- the log ----------------------------------------------------------- */

  /**
   * „Das habe ich aufgenommen."
   *
   * The taken-in half comes from the vault itself (the `file` records carry
   * `watchId`), so it is as durable as the data and survives a restart. The
   * skipped half cannot: nothing was written, so there is nothing to read back
   * later. Rather than invent a durable log nobody asked for, the answer says
   * plainly how far back it reaches.
   */
  function logFor(id, opts = {}) {
    const record = mustGet(id);
    const limit = clampInt(opts.limit, 1, 500, 100);
    const taken = [];
    for (const file of store.all('file')) {
      if (!file.data || file.data.watchId !== id) continue;
      taken.push({
        id: file.id,
        datei: file.data.externalPath
          ? path.relative(record.data.path, file.data.externalPath) || file.data.name
          : file.data.name,
        name: file.data.name,
        groesse: file.data.size,
        art: file.data.extractKind || null,
        leererText: !file.data.text,
        warnungen: Array.isArray(file.data.extractWarnings) ? file.data.extractWarnings : [],
        at: file.createdAt,
      });
    }
    taken.sort((a, b) => (a.at < b.at ? 1 : -1));

    const skippedAll = (skipLog.get(id) || []).filter((entry) => entry.was !== 'aufgenommen');
    return {
      id,
      ordner: record.data.path,
      aufgenommen: taken.slice(0, limit),
      aufgenommenGesamt: taken.length,
      uebersprungen: skippedAll.slice(0, limit),
      uebersprungenGesamt: skippedAll.length,
      hinweis: 'Die aufgenommenen Dateien stehen im Tresor und bleiben dort auch nach einem Neustart. '
        + 'Übersprungene Dateien merkt sich dieses Programm nur, solange es läuft – sie wurden ja nirgends gespeichert.',
    };
  }

  /* --- fs.watch + sweep --------------------------------------------------- */

  function signatureOf(record) {
    return `${record.data.path}\u0000${record.data.recursive ? '1' : '0'}\u0000${record.data.enabled ? '1' : '0'}`;
  }

  function detach(id) {
    const entry = attached.get(id);
    if (entry && entry.watcher) {
      try {
        entry.watcher.close();
      } catch { /* already closed */ }
    }
    attached.delete(id);
    for (const [key, timer] of pending) {
      if (key.startsWith(`${id}\u0000`)) {
        clearTimeout(timer);
        pending.delete(key);
      }
    }
  }

  /**
   * Attach an OS watcher to one folder.
   *
   * `persistent: false` plus `unref()`: an open watcher must never be the
   * reason a `neural-os doctor` run or a test process refuses to exit.
   * `recursive` is not available on every platform, so its absence is recorded
   * and the sweep covers the subdirectories instead -- said out loud in
   * `status()`, not hidden.
   */
  function attach(record) {
    const id = record.id;
    detach(id);
    if (!record.data.enabled) return;

    let dir;
    try {
      dir = resolveFolder(record.data.path);
    } catch (err) {
      attached.set(id, { watcher: null, signature: signatureOf(record), kind: 'keine', problem: asNeuralError(err).message });
      return;
    }

    const wanted = record.data.recursive === true;
    const openWatcher = (recursive) => fs.watch(dir, { recursive, persistent: false }, (event, filename) => {
      if (!filename) return; // some platforms omit the name; the sweep covers it
      onChange(id, String(filename));
    });

    let watcher = null;
    let kind = wanted ? 'fs.watch (mit Unterordnern)' : 'fs.watch';
    let problem = null;
    try {
      watcher = openWatcher(wanted);
    } catch (err) {
      if (wanted) {
        try {
          watcher = openWatcher(false);
          kind = 'fs.watch (nur oberste Ebene)';
          problem = 'Dieses Betriebssystem kann Unterordner nicht mitbeobachten; der Rundlauf holt sie nach.';
        } catch (inner) {
          problem = `fs.watch nicht möglich (${inner.code || inner.message}); nur der Rundlauf sieht Änderungen.`;
          kind = 'nur Rundlauf';
        }
      } else {
        problem = `fs.watch nicht möglich (${err.code || err.message}); nur der Rundlauf sieht Änderungen.`;
        kind = 'nur Rundlauf';
      }
    }
    if (watcher) {
      if (typeof watcher.unref === 'function') watcher.unref();
      watcher.on('error', (err) => {
        log.warn(`Beobachtung von ${dir} gestört: ${err && err.message}`);
        const entry = attached.get(id);
        if (entry) entry.problem = `Die Beobachtung wurde unterbrochen (${err && err.code}); der Rundlauf läuft weiter.`;
      });
    }
    attached.set(id, { watcher, signature: signatureOf(record), kind, problem });
  }

  function reattach(record) {
    if (!running) return;
    const entry = attached.get(record.id);
    if (entry && entry.signature === signatureOf(record)) return;
    attach(record);
  }

  /**
   * Debounce per file: an editor writes several times when it saves (truncate,
   * write, rename), and each of those is an event. Reading in between yields a
   * half-written file, so the last event wins and the timer starts over.
   */
  function onChange(id, filename) {
    const key = `${id}\u0000${filename}`;
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(key);
      if (!running) return; // stop() was called while we were waiting
      const record = store.get(id);
      if (!record || record.type !== 'watch' || !record.data.enabled) return;
      try {
        takeOne(record, filename);
      } catch (err) {
        log.warn(`Änderung an ${filename} nicht verarbeitet: ${asNeuralError(err).message}`);
      }
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(key, timer);
  }

  async function sweep() {
    if (!running) return;
    for (const record of records()) {
      if (!running) return;
      if (!record.data.enabled) continue;
      if (busy.has(record.id)) continue;

      // A folder on an external disk loses its OS watcher when the disk is
      // unplugged and never gets one back on its own, because nothing about
      // the record changed. The sweep is the only thing that runs again, so
      // it is also the thing that re-attaches.
      const entry = attached.get(record.id);
      if (!entry || !entry.watcher) attach(record);

      try {
        await scan(record.id, { quiet: true });
      } catch (err) {
        log.debug(`Rundlauf für ${record.data.path}: ${asNeuralError(err).message}`);
      }
    }
  }

  function onRecordEvent(evt) {
    const record = evt && evt.payload && evt.payload.record;
    if (!record || record.type !== 'watch') return;
    reattach(record);
  }

  function onRecordDeleted(evt) {
    const payload = (evt && evt.payload) || {};
    if (payload.type && payload.type !== 'watch') return;
    if (payload.id) detach(payload.id);
  }

  /**
   * Start watching. Idempotent.
   * @param {{sweepIntervalMs?:number}} [opts]
   */
  function start(opts = {}) {
    if (opts && opts.sweepIntervalMs !== undefined) {
      sweepMs = clampInt(opts.sweepIntervalMs, MIN_SWEEP_MS, MAX_SWEEP_MS, sweepMs);
    }
    if (running) return status();
    running = true;

    for (const record of records()) attach(record);

    if (bus && typeof bus.on === 'function') {
      const created = (evt) => onRecordEvent(evt);
      const updated = (evt) => onRecordEvent(evt);
      const deleted = (evt) => onRecordDeleted(evt);
      bus.on('record.created', created);
      bus.on('record.updated', updated);
      bus.on('record.deleted', deleted);
      busHandlers.push(['record.created', created], ['record.updated', updated], ['record.deleted', deleted]);
    }

    sweepTimer = setInterval(() => {
      Promise.resolve(sweep()).catch((err) => {
        log.error(`Rundlauf fehlgeschlagen: ${asNeuralError(err).message}`);
      });
    }, sweepMs);
    // Unref'd on purpose: a fallback sweep must never keep the process alive.
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

    log.info(`Ordnerbeobachtung läuft (Rundlauf alle ${Math.round(sweepMs / 1000)} s).`);
    return status();
  }

  /**
   * Stop watching and give everything back: OS watchers, the sweep timer,
   * every pending debounce and every bus subscription. Anything left behind
   * here is a listener that fires into a torn-down subsystem later, which is
   * how a test suite starts failing in a file nobody touched.
   */
  function stop() {
    if (!running) return false;
    running = false;

    for (const id of Array.from(attached.keys())) detach(id);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();

    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    if (bus && typeof bus.off === 'function') {
      for (const [name, handler] of busHandlers) bus.off(name, handler);
    }
    busHandlers.length = 0;
    log.info('Ordnerbeobachtung gestoppt.');
    return true;
  }

  function stateOf(record) {
    const entry = attached.get(record.id) || null;
    return {
      aktiv: !!(entry && entry.watcher),
      art: entry ? entry.kind : (record.data.enabled ? 'noch nicht gestartet' : 'ausgeschaltet'),
      problem: entry ? entry.problem : null,
      laeuftGerade: busy.has(record.id),
      uebersprungenGemerkt: (skipLog.get(record.id) || []).filter((e) => e.was !== 'aufgenommen').length,
    };
  }

  function list() {
    return records().map((record) => ({ ...record, beobachtung: stateOf(record) }));
  }

  function status() {
    const all = records();
    return {
      running,
      sweepIntervalMs: sweepMs,
      debounceMs,
      total: all.length,
      enabled: all.filter((r) => r.data.enabled).length,
      watching: Array.from(attached.values()).filter((e) => e.watcher).length,
      sammelschreibung: !!bulkWrite,
    };
  }

  function one(id) {
    const record = mustGet(id);
    return { ...record, beobachtung: stateOf(record) };
  }

  return {
    list,
    get: one,
    add,
    update,
    remove,
    enable,
    scan,
    log: logFor,
    start,
    stop,
    status,
    sweep,
    get running() {
      return running;
    },
    READABLE_EXTENSIONS: Array.from(READABLE.keys()),
  };
}

module.exports = {
  createWatcher,
  READABLE,
  BULK_THRESHOLD,
  MAX_ENTRIES_PER_SCAN,
  DEFAULT_SWEEP_MS,
  DEFAULT_DEBOUNCE_MS,
};
