'use strict';

/**
 * Turning a USB stick into a running Neural OS.
 *
 * The promise this module has to keep
 * -----------------------------------
 * A stick gets pulled out mid-write, plugged into a machine whose filesystem
 * has no permission bits, runs full, and is carried between operating systems.
 * None of that may cost data, and all of it has to be reported in words the
 * owner of the stick can act on. Everything below follows from that:
 *
 *  1. THE RUNTIME OF THE RUNNING SYSTEM IS ALWAYS COPIED, WITHOUT NETWORK.
 *     `process.execPath` is a complete, working Node binary that is already on
 *     this machine. Copying it makes the stick bootable on every machine with
 *     the same OS and architecture -- which is the normal case -- and it works
 *     on a computer that has never been online. Additional platforms are a
 *     bonus that needs an explicit egress grant; their absence is never a
 *     failure of the stick.
 *
 *  2. NOTHING IS WRITTEN BEFORE THE SPACE IS KNOWN TO BE THERE. Half a copied
 *     stick is worse than no copied stick: it looks finished and fails later,
 *     somewhere else. The size of the source is measured, the free space is
 *     read from the filesystem, and `prepare()` refuses up front.
 *
 *  3. EVERY DIRECTORY LANDS ATOMICALLY. The source tree is built in a hidden
 *     sibling directory and only then renamed into place, so an interrupted
 *     copy leaves `app/` either completely old or completely new -- never a
 *     mixture that starts and then behaves strangely. `verify()` recognises
 *     the leftovers of an interruption and says what to do; `prepare()` and
 *     `update()` clean them up, and restore `app/` if the crash happened in
 *     the one instant between the two renames.
 *
 *  4. `update()` NEVER TOUCHES THE DATA DIRECTORY -- NOR THE MODEL DIRECTORY.
 *     This is the single most important guarantee here, because the data
 *     directory is the user's thinking and the source tree is replaceable.
 *     `models/` joins it for a different reason with the same consequence: it
 *     holds gigabytes that were copied once, over minutes, and that no update
 *     of a few megabytes of source code may put at risk. Both are enforced in
 *     code (`geschuetzterOrdner` / `assertNichtGeschuetzt`), not by
 *     convention, and proven by a test.
 *
 *  5. THE FILESYSTEM IS PROBED, NOT ASSUMED. Most sticks are exFAT or FAT32.
 *     `chmod 0600` silently does nothing there, so `0700` on the vault
 *     protects exactly nobody -- which makes vault encryption the only real
 *     protection and therefore something the user has to be told about. FAT32
 *     additionally cannot hold a file over 4 GB, and a language model usually
 *     is one.
 *
 *  6. NICHTS DAVON HAELT DEN SERVER AN. Dieselben Funktionen bedienen die
 *     Kommandozeile UND eine HTTP-Route. Am Terminal stoert es niemanden, wenn
 *     eine Kopie synchron laeuft; im Serverprozess steht waehrenddessen die
 *     ganze Oberflaeche fuer jeden Benutzer still. Gemessen an 250 Dateien und
 *     1 GB waren das 2864 ms ohne eine einzige Runde des Ereignisrings.
 *     Deshalb kopiert dieses Modul ueber den Thread-Pool, und deshalb wird
 *     kein Kindprozess mehr synchron abgewartet.
 *
 *  7. JEDER LANGE VORGANG LAESST SICH ABBRECHEN, UND ZWEI GLEICHZEITIGE GIBT
 *     ES NICHT. Ein geschlossener Browsertab darf keine 8-GB-Kopie zu Ende
 *     laufen lassen (`signal`), und zwei Tabs duerfen einander nicht die
 *     halbfertigen Ordner wegraeumen (`lockRoot`) -- cleanStale() kann die
 *     beiden Faelle auf der Platte nicht unterscheiden.
 *
 *  8. WAS NUR LIEST, SCHREIBT AUCH NICHTS. verify() beantwortet eine reine
 *     Lesefrage; die Rechte-Sonde, die dafuer eine Datei anlegt, muss ein
 *     Aufrufer ausdruecklich verlangen.
 *
 * The one thing this module does NOT promise: that a runtime for a foreign
 * platform can always be fetched. That needs the network gate to allow
 * nodejs.org, and if it does not, that is a decision of the user's policy --
 * reported in plain German, not raised as a defect.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const {
  ValidationError,
  StorageError,
  NotFoundError,
  NetworkBlockedError,
  PermissionError,
  AbortedError,
  NeuralError,
} = require('../kernel/errors');
const { PORTABLE_MARKER } = require('../kernel/paths');

/* ------------------------------------------------------------- constants */

/** Root of the source tree this file belongs to (src/portable -> project). */
const APP_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Node's own distribution names. The keys are exactly the directory names used
 * under `runtime/` on the stick, so the launcher scripts can build a path from
 * `uname -m` / `%PROCESSOR_ARCHITECTURE%` without a lookup table of their own.
 */
const PLATFORMS = {
  'win-x64': { archive: 'zip', member: 'node.exe', file: 'node.exe', executable: false },
  'win-arm64': { archive: 'zip', member: 'node.exe', file: 'node.exe', executable: false },
  'darwin-x64': { archive: 'tar.gz', member: 'bin/node', file: 'node', executable: true },
  'darwin-arm64': { archive: 'tar.gz', member: 'bin/node', file: 'node', executable: true },
  'linux-x64': { archive: 'tar.gz', member: 'bin/node', file: 'node', executable: true },
  'linux-arm64': { archive: 'tar.gz', member: 'bin/node', file: 'node', executable: true },
  'linux-armv7l': { archive: 'tar.gz', member: 'bin/node', file: 'node', executable: true },
};

/**
 * Directory and file names of the stick layout. Single source of truth.
 *
 * `models` kam dazu, weil bis dahin das WISSEN mitreiste und das MODELL nicht:
 * auf einem fremden Rechner standen die Notizen da, eine Antwort gab es nicht.
 * Der Ordner ist bewusst ein Geschwister von `runtime` und nicht ein Teil
 * davon: `runtime/` ist die Node-Laufzeit, die dieses Modul selbst kopiert,
 * `models/` enthaelt fremde Programme (Ollama, llama-server) und ihre Gewichte.
 * Was dort liegt, steht in `models/modelle.json` -- siehe src/portable/model.js.
 */
const LAYOUT = {
  marker: PORTABLE_MARKER,
  app: 'app',
  runtime: 'runtime',
  data: 'data',
  sync: 'sync',
  models: 'models',
  /** Beschreibungsdatei IN models/. Ein spaeterer Leser soll nicht raten muessen. */
  modelsIndex: 'modelle.json',
  readme: 'LIESMICH.txt',
};

/**
 * Launcher sources in the repository, and the names they get on the stick.
 * German names on purpose: the user double-clicks this, and "start-linux.sh"
 * is not what a non-technical person looks for.
 */
const LAUNCHERS = [
  { source: 'start-windows.bat', target: 'Neural OS starten.bat', eol: 'crlf', executable: false },
  { source: 'start-macos.command', target: 'Neural OS starten.command', eol: 'lf', executable: true },
  { source: 'start-linux.sh', target: 'Neural OS starten.sh', eol: 'lf', executable: true },
];

/**
 * Never copied into `app/`.
 *
 * Matched on the base name at any depth, because `.DS_Store` and `*.log` turn
 * up everywhere, not only at the top. `vault`, `data`, `exports`, `runs`,
 * `trash`, `.lock`, `audit.jsonl` and `secrets.json` are home-directory
 * artefacts: they appear here only if somebody points `sourceRoot` at a home
 * directory by mistake, and copying a vault into `app/` would be a quiet
 * privacy leak (the source tree is the part people share).
 */
const EXCLUDED_NAMES = new Set([
  'node_modules', '.git', 'vault', 'data', 'exports', 'runs', 'trash',
  'audit.jsonl', 'secrets.json', '.DS_Store', '.lock', PORTABLE_MARKER,
]);

/** Dropped when copying a home directory onto the stick (see EXCLUDED_NAMES). */
const HOME_EXCLUDED_NAMES = new Set(['.lock', '.DS_Store']);

/** Guards against a symlink loop or a pathologically deep tree. */
const MAX_DEPTH = 64;

/** Rough size of one downloaded Node binary, for the space estimate only. */
const ESTIMATED_RUNTIME_BYTES = 140 * 1024 * 1024;

/** Headroom on top of the measured requirement, so the stick is not left at 0. */
const MIN_HEADROOM_BYTES = 8 * 1024 * 1024;

/** Caps for anything fetched from nodejs.org. */
const MAX_SHASUMS_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const MAX_BINARY_BYTES = 400 * 1024 * 1024;
const RUNTIME_TIMEOUT_MS = 10 * 60 * 1000;

/** The single host this module is ever allowed to reach. */
const DIST_HOST = 'nodejs.org';
const DIST_BASE = `https://${DIST_HOST}/dist`;
/** Egress scope for every request made here, so a grant can be that narrow. */
const RUNTIME_SCOPE = 'stick:runtime';

/**
 * Linux `statfs` magic numbers we can name. Everything else stays 'unbekannt'
 * rather than being guessed -- on macOS `f_type` is not these values at all,
 * and a wrong filesystem name would produce a wrong warning.
 */
const FS_TYPES = {
  0x4d44: { name: 'FAT (FAT16/FAT32)', maxFileBytes: 4 * 1024 * 1024 * 1024 - 1 },
  0x2011bab0: { name: 'exFAT', maxFileBytes: null },
  0x5346544e: { name: 'NTFS', maxFileBytes: null },
  0xef53: { name: 'ext2/ext3/ext4', maxFileBytes: null },
  0x9123683e: { name: 'Btrfs', maxFileBytes: null },
  0x58465342: { name: 'XFS', maxFileBytes: null },
  0x01021994: { name: 'tmpfs', maxFileBytes: null },
  0x2fc12fc1: { name: 'ZFS', maxFileBytes: null },
  0x65735546: { name: 'FUSE (z. B. exfat-fuse, ntfs-3g)', maxFileBytes: null },
  0x6969: { name: 'NFS', maxFileBytes: null },
  0xff534d42: { name: 'SMB/CIFS', maxFileBytes: null },
  0x482b: { name: 'HFS+', maxFileBytes: null },
};

/* ----------------------------------------------------------- small tools */

/** Node's dist name for a platform/arch pair, or null if there is no build. */
function nodeDistPlatform(platform = process.platform, arch = process.arch) {
  const osPart = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  if (!osPart) return null;
  const archPart = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'armv7l' : null;
  if (!archPart) return null;
  const id = `${osPart}-${archPart}`;
  return PLATFORMS[id] ? id : null;
}

/** The platform this process runs on, e.g. 'linux-x64'. null on exotic systems. */
const LOCAL_PLATFORM = nodeDistPlatform();

function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return 'unbekannt';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

/** `child` is inside `parent` (or is `parent`). Both are resolved absolutes. */
function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

/**
 * Anteil in Prozent, aus Bytes wenn es sie gibt, sonst aus der Dateizahl.
 * Ein Balken im Browser braucht eine Zahl, auch wenn alle Dateien 0 Byte haben.
 */
function percentOf(bytes, totalBytes, copied, total) {
  const share = totalBytes > 0 ? bytes / totalBytes : (total > 0 ? copied / total : 1);
  return Math.max(0, Math.min(100, Math.round(share * 100)));
}

/* ------------------------------------------- Fehler in ganzen Saetzen */

/**
 * Warum hier eigene Klassen stehen, obwohl kernel/errors.js eine Taxonomie hat:
 *
 *  - `NotFoundError` baut den Satz `${what} not found`. Die Aufrufer hier
 *    beginnen deutsch ("Der Quellordner /media/usb"), in der Oberflaeche stuende
 *    also "Der Quellordner /media/usb not found". Die Unterklasse erbt Code und
 *    Status (NOT_FOUND / 404) unveraendert und setzt nur den fertigen deutschen
 *    Satz ein; `instanceof NotFoundError` gilt weiterhin.
 *  - `StorageError` antwortet mit Status 500. "Der Stick ist voll" ist aber
 *    kein Defekt dieses Servers, sondern ein Zustand der Welt. 500 laedt die
 *    Oberflaeche dazu ein, einen Fehlerbericht anzubieten, wo "Platz schaffen"
 *    die richtige Handlung waere. 507 (Insufficient Storage) ist genau dieser
 *    Fall. Die Klasse bleibt eine StorageError, damit niemand etwas verliert,
 *    der darauf prueft.
 *
 * Fuer den dritten Fall gibt es die passende Klasse bereits: ein
 * schreibgeschuetzter Stick ist eine `PermissionError` (403) -- ein Recht wurde
 * gebraucht und nicht gewaehrt --, kein Serverdefekt.
 */
class StickNotFoundError extends NotFoundError {
  constructor(satz, details) {
    super(satz);
    this.message = satz;
    this.details = details ?? null;
  }
}

/** Der Stick hat keinen Platz mehr. Status 507, nicht 500. */
class StickFullError extends StorageError {
  constructor(message, details) {
    super(message, details);
    this.name = 'StickFullError';
    this.code = 'STICK_FULL';
    this.status = 507;
  }
}

/**
 * Auf dem Stick liegt schon ein Datenbestand, und prepare() ueberschreibt nie
 * Daten. Aus demselben Grund wie StickFullError keine 500: das ist kein Defekt
 * dieses Servers, sondern der Zustand des Sticks, und die Oberflaeche soll
 * "nimm Aktualisieren" anbieten statt eines Fehlerberichts. 409 (Conflict) ist
 * genau dieser Fall. `instanceof StorageError` gilt weiterhin.
 */
class StickDataError extends StorageError {
  constructor(message, details) {
    super(message, details);
    this.name = 'StickDataError';
    this.code = 'STICK_DATA_PRESENT';
    this.status = 409;
  }
}

/** Auf derselben Stick-Wurzel laeuft schon ein Vorgang. Status 409. */
class StickBusyError extends NeuralError {
  constructor(message, details) {
    super('STICK_BUSY', message, { status: 409, details });
    this.name = 'StickBusyError';
  }
}

/* --------------------------------------------------------------- Abbruch */

/**
 * Was ein Abbruch dem Benutzer sagen muss: nicht "aborted", sondern was jetzt
 * auf dem Stick liegt. Halbe Kopien sind durch die zweistufige Umbenennung
 * abgedeckt -- der bisherige Stand bleibt vollstaendig, das halbfertige
 * Verzeichnis traegt einen Namen, den verify() erkennt.
 */
function abortedDuring(what) {
  return new AbortedError(
    `${what} wurde abgebrochen. Auf dem Stick steht weiterhin der Stand von vorher; `
    + 'halb Kopiertes wurde entfernt. "Stick pruefen" zeigt, was jetzt da ist.',
  );
}

function throwIfAborted(signal, what) {
  if (signal && signal.aborted) throw abortedDuring(what);
}

/* ------------------------------------------------------ Platz, an EINER Stelle */

/**
 * Wie viel Platz ein Vorgang braucht.
 *
 * WARUM eine eigene Funktion: dieselbe Zahl beantwortet zwei Fragen, die weit
 * auseinanderliegen -- "darf prepare() ueberhaupt anfangen?" und "was sagt die
 * Vorschau im Browser, bevor jemand klickt?". Stuenden die beiden Formeln
 * getrennt da, wuerde die Vorschau irgendwann etwas versprechen, das der
 * Vorgang danach ablehnt. Genau diese Sorte Luege soll es hier nicht geben.
 *
 * `update` rechnet anders, und das ist kein Versehen: der alte `app/`-Ordner
 * wird erst freigegeben, wenn der neue vollstaendig danebensteht -- gebraucht
 * wird also die volle Groesse noch einmal, nicht die Differenz.
 */
function spaceNeeded(action, { sourceBytes = 0, runtimeBytes = 0, homeBytes = 0, extraRuntimes = 0 } = {}) {
  if (action === 'update') {
    return { required: sourceBytes, withHeadroom: sourceBytes + MIN_HEADROOM_BYTES };
  }
  const required = sourceBytes + runtimeBytes + homeBytes + extraRuntimes * ESTIMATED_RUNTIME_BYTES;
  return { required, withHeadroom: required + Math.max(MIN_HEADROOM_BYTES, Math.round(required * 0.05)) };
}

/**
 * Der Satz zu "es passt nicht" -- ebenfalls an einer Stelle, aus demselben
 * Grund: die Vorschau lehnt mit demselben Wortlaut ab wie der Vorgang selbst.
 */
function stickFull(action, parts) {
  const { free, withHeadroom, sourceBytes = 0, runtimeBytes = 0, homeBytes = 0, extraRuntimes = 0 } = parts;
  if (action === 'update') {
    return new StickFullError(
      `Für die Aktualisierung werden ${humanBytes(withHeadroom)} frei gebraucht, vorhanden sind ${humanBytes(free)}. `
      + 'Es wurde nichts verändert; der bisherige Stand auf dem Stick bleibt unberührt.',
      { free, required: withHeadroom },
    );
  }
  return new StickFullError(
    `Auf dem Stick sind nur ${humanBytes(free)} frei, gebraucht werden mindestens ${humanBytes(withHeadroom)} `
    + `(Quelltext ${humanBytes(sourceBytes)}`
    + (runtimeBytes ? `, Laufzeit ${humanBytes(runtimeBytes)}` : '')
    + (homeBytes ? `, Datenbestand ${humanBytes(homeBytes)}` : '')
    + (extraRuntimes ? `, ${extraRuntimes} weitere Laufzeit(en) geschätzt ${humanBytes(extraRuntimes * ESTIMATED_RUNTIME_BYTES)}` : '')
    + '). Es wurde nichts geschrieben - ein halb kopierter Stick waere schlimmer als keiner. '
    + 'Schaffe Platz oder lass die zusätzlichen Laufzeiten weg.',
    { free, required: withHeadroom },
  );
}

/** Derselbe Satz fuer "da liegen schon Daten", aus demselben Grund. */
function dataPresent(dataDir, entries) {
  return new StickDataError(
    `In ${dataDir} liegt bereits ein Datenbestand (${entries} Eintrag/Einträge). "Stick vorbereiten" überschreibt `
    + 'niemals Daten. Nutze "Stick aktualisieren", um nur den Quelltext zu erneuern, oder wähle einen leeren Ordner.',
    { dataDir, entries },
  );
}

/** Der naechste Ordner nach oben, den es wirklich gibt. Fuer eine Vorschau auf einen Pfad, der noch nicht existiert. */
function nearestExisting(dir) {
  let probe = path.resolve(dir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (fs.existsSync(probe)) return probe;
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  return null;
}

/* ------------------------------------------------- eine Sperre je Stick */

/**
 * Prozessweite Sperre je Stick-Wurzel.
 *
 * WARUM prozessweit und nicht je Werkzeug-Instanz: cleanStale() entfernt JEDES
 * `.name.tmp-XXXX` in der Wurzel -- auch das Arbeitsverzeichnis eines gerade
 * laufenden zweiten Vorgangs. Ueber HTTP genuegen dafuer zwei Browsertabs, und
 * jede Anfrage kann sich ihr eigenes createStick() holen. Die Sperre muss also
 * am Pfad haengen, nicht am Objekt. Sie ist bewusst keine Warteschlange: der
 * zweite Aufruf soll sofort eine Antwort bekommen, die er anzeigen kann.
 */
const busyRoots = new Map();

// Windows unterscheidet in Pfaden keine Gross-/Kleinschreibung; ohne das waeren
// "E:/stick" und "e:/stick" zwei verschiedene Sticks und die Sperre nutzlos.
function rootKey(root) {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/** Laeuft auf dieser Wurzel gerade ein Vorgang? Sonst null. */
function runningOn(root) {
  return busyRoots.get(rootKey(root)) || null;
}

/** Der Satz zu "da laeuft schon etwas" -- einmal, fuer die Sperre und fuer die Vorschau. */
function busyError(root, running) {
  const seconds = Math.max(1, Math.round((Date.now() - running.since) / 1000));
  return new StickBusyError(
    `Auf ${root} laeuft bereits "${running.what}" (seit ${seconds} s). Zwei Vorgaenge auf demselben Stick `
    + 'raeumen einander die halbfertigen Ordner weg und koennen ihn unbrauchbar machen. Warte, bis der '
    + 'erste fertig ist, oder brich ihn ab.',
    { root, running: running.what, seconds },
  );
}

function lockRoot(root, what) {
  const key = rootKey(root);
  const running = busyRoots.get(key);
  if (running) throw busyError(root, running);
  const entry = { what, since: Date.now() };
  busyRoots.set(key, entry);
  return () => { if (busyRoots.get(key) === entry) busyRoots.delete(key); };
}

/** A throwing progress callback must never break a copy in flight. */
function makeProgress(fn, log) {
  if (typeof fn !== 'function') return () => {};
  return (event) => {
    try { fn(event); } catch (err) {
      if (log && log.warn) log.warn(`onProgress hat geworfen: ${err && err.message}`);
    }
  };
}

/* --------------------------------------------------------- filesystem I/O */

/**
 * Free bytes on the filesystem holding `dir`.
 *
 * Walks up to the nearest existing ancestor, because the target directory of
 * a fresh `prepare()` does not exist yet and we want the answer before we
 * create anything. Returns null when the platform cannot tell us -- in that
 * case we warn instead of pretending to have checked.
 */
function freeBytesOf(dir) {
  let probe = path.resolve(dir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      const st = fs.statfsSync(probe);
      const free = Number(st.bsize) * Number(st.bavail);
      return Number.isFinite(free) ? free : null;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = path.dirname(probe);
        if (parent === probe) return null;
        probe = parent;
        continue;
      }
      return null;
    }
  }
  return null;
}

function emptyFsInfo() {
  return {
    writable: false,
    enforcesModes: null,
    probed: false,
    type: null,
    typeName: 'unbekannt',
    maxFileBytes: null,
    error: null,
  };
}

/** Typ und Grenzen des Dateisystems. Reines Lesen, auf jedem Weg gleich. */
function readFsType(dir, result) {
  try {
    const st = fs.statfsSync(dir);
    result.type = Number(st.type);
    const known = FS_TYPES[result.type >>> 0] || FS_TYPES[result.type];
    if (known) {
      result.typeName = known.name;
      result.maxFileBytes = known.maxFileBytes;
    }
  } catch { /* not every platform reports a usable type */ }
  return result;
}

/**
 * What can this filesystem actually do?
 *
 * The permission question cannot be answered by looking at a mount table --
 * it is answered by writing a file with mode 0600 and reading the mode back.
 * On FAT/exFAT the mode comes back as 0777 or 0666, which is precisely the
 * fact the user needs to hear before they trust the stick with a vault.
 *
 * Diese Sonde LEGT EINE DATEI AN. Sie gehoert deshalb in die Vorgaenge, die
 * ohnehin schreiben (prepare, update) -- wer nur liest, nimmt
 * inspectFilesystem() und bekommt eine ehrliche Luecke statt einer Nebenwirkung.
 *
 * @param {string} dir an existing directory
 * @returns {{writable:boolean, enforcesModes:boolean|null, probed:boolean,
 *            type:number|null, typeName:string, maxFileBytes:number|null,
 *            error:string|null}}
 */
function probeFilesystem(dir) {
  const result = emptyFsInfo();
  result.probed = true;

  const probe = path.join(dir, `.neural-os-probe-${randomSuffix()}`);
  try {
    fs.writeFileSync(probe, 'neural-os', { mode: 0o600 });
    result.writable = true;
    if (process.platform === 'win32') {
      // Windows does not map Unix modes at all; asking the question there
      // would produce a FAT warning on a perfectly fine NTFS volume.
      result.enforcesModes = null;
    } else {
      result.enforcesModes = (fs.statSync(probe).mode & 0o777) === 0o600;
    }
  } catch (err) {
    result.error = (err && err.message) || String(err);
  } finally {
    try { fs.unlinkSync(probe); } catch { /* the probe is disposable */ }
  }

  return readFsType(dir, result);
}

/**
 * Dieselben Fragen, ohne eine einzige Schreiboperation.
 *
 * WARUM: verify() beantwortet eine reine Lesefrage und haengt an einer
 * HTTP-Route, die ein Browser beim Oeffnen der Ansicht aufruft. Ein GET, das
 * eine Datei anlegt, ist an dieser Stelle falsch -- auf einem
 * schreibgeschuetzten Stick scheitert er, und auf einem gesunden hinterlaesst
 * er Muell, wenn der Prozess zwischen Schreiben und Loeschen stirbt.
 *
 * Schreibrecht kommt aus access(W_OK), das nichts anlegt. Die Rechtefrage
 * beantworten die Zeugen: Dateien, die prepare() mit einem BEKANNTEN Modus
 * geschrieben hat. Stimmt der gelesene Modus nicht mehr mit dem geschriebenen
 * ueberein, hat das Dateisystem ihn verworfen -- genau das, was die Sonde
 * herausfindet. Gibt es keinen Zeugen, bleibt die Antwort null (= unbekannt)
 * und verify() sagt das, statt es zu erfinden.
 *
 * @param {string} dir
 * @param {Array<{path:string, mode:number}>} [witnesses]
 */
function inspectFilesystem(dir, witnesses = []) {
  const result = emptyFsInfo();
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    result.writable = true;
  } catch (err) {
    result.error = (err && err.message) || String(err);
  }

  if (process.platform !== 'win32') {
    let seen = 0;
    let kept = 0;
    for (const witness of witnesses) {
      let stat;
      try { stat = fs.statSync(witness.path); } catch { continue; }
      seen++;
      if ((stat.mode & 0o777) === witness.mode) kept++;
    }
    if (seen > 0) result.enforcesModes = kept === seen;
  }

  return readFsType(dir, result);
}

/** Write via a temporary file in the same directory, then rename into place. */
function writeFileAtomic(file, content, mode) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${randomSuffix()}`);
  fs.writeFileSync(tmp, content);
  if (mode !== undefined) {
    try { fs.chmodSync(tmp, mode); } catch { /* exFAT/FAT ignore modes */ }
  }
  fs.renameSync(tmp, file);
}

function mkdirp(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, ...(mode === undefined ? {} : { mode }) });
  if (mode !== undefined) {
    try { fs.chmodSync(dir, mode); } catch { /* best effort, see above */ }
  }
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Dasselbe, ohne den Ereignisring anzuhalten. Ein abgebrochener Kopiervorgang
 * hinterlaesst bis zu einem ganzen Quelltextbaum; ihn synchron wegzuraeumen
 * wuerde den Server genau dort wieder blockieren, wo gerade abgebrochen wurde.
 */
async function rmrfAsync(target) {
  try { await fsp.rm(target, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Alles entfernen, was seit `keep` dazugekommen ist -- der Rest bleibt stehen.
 *
 * Gezielt so und nicht "Ordner leeren": hier haengt der Datenbestand des
 * Benutzers dran, und was schon vorher da war, gehoert nicht diesem Vorgang.
 */
async function removeNewEntries(dir, keep) {
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return; }
  for (const name of entries) {
    if (keep.has(name)) continue;
    await rmrfAsync(path.join(dir, name));
  }
}

/**
 * `dropLogs` is off for a data backup on purpose: `*.log` is noise in a source
 * tree but it is the user's own file in their home directory, and a backup
 * that quietly leaves files behind is not a backup.
 */
function excludedBy(name, set, dropLogs) {
  if (set.has(name)) return true;
  return dropLogs && name.endsWith('.log');
}

/**
 * Walk a tree and list the regular files that would be copied.
 *
 * Read-only on purpose: `prepare()` needs the total size before it is allowed
 * to write the first byte, and the same list is then used for the copy so the
 * progress numbers cannot drift apart from what actually happens.
 *
 * Symlinks are dereferenced for files and skipped for directories: following a
 * directory link is how a copy turns into an infinite loop, and a stick is not
 * the place to find that out.
 */
function collectTree(root, { exclude = EXCLUDED_NAMES, dropLogs = true } = {}) {
  const files = [];
  const warnings = [];
  let bytes = 0;

  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (err) {
    throw new StickNotFoundError(`Den Quellordner ${root} gibt es nicht (oder er ist nicht lesbar).`, { root });
  }
  if (!rootStat.isDirectory()) {
    throw new ValidationError(`${root} ist kein Ordner.`);
  }

  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH) {
      warnings.push(`Der Ordner ${rel || '.'} ist tiefer verschachtelt als ${MAX_DEPTH} Ebenen und wurde nicht weiter verfolgt.`);
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Ordner ${rel || '.'} konnte nicht gelesen werden (${err.code || err.message}); er fehlt auf dem Stick.`);
      return;
    }
    for (const entry of entries) {
      if (excludedBy(entry.name, exclude, dropLogs)) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;

      let stat;
      if (entry.isSymbolicLink()) {
        try {
          stat = fs.statSync(abs);
        } catch {
          warnings.push(`Die Verknüpfung ${childRel} zeigt ins Leere und wurde übersprungen.`);
          continue;
        }
        if (stat.isDirectory()) {
          warnings.push(`${childRel} ist eine Ordner-Verknüpfung und wurde übersprungen (Schleifengefahr).`);
          continue;
        }
      } else if (entry.isDirectory()) {
        walk(abs, childRel, depth + 1);
        continue;
      } else if (!entry.isFile()) {
        continue; // sockets, fifos, devices have no meaning on a stick
      }

      if (!stat) {
        try { stat = fs.statSync(abs); } catch { continue; }
      }
      files.push({ rel: childRel, abs, size: stat.size, mode: stat.mode & 0o777 });
      bytes += stat.size;
    }
  };

  walk(root, '', 0);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, bytes, warnings };
}

/**
 * Copy a collected file list into `dest`.
 *
 * `dest` is always a temporary directory that nothing else knows about yet, so
 * a failure here can be cleaned up completely. ENOSPC is translated on the
 * spot: "the stick filled up" is a sentence the user can do something with,
 * `ENOSPC` is not.
 *
 * WARUM await je Datei statt fs.copyFileSync: gemessen an 250 Dateien / 1 GB
 * stand der Ereignisring mit der synchronen Schleife 2864 ms komplett still --
 * kein einziger von ~143 erwarteten Zeitgeber-Ticks kam durch. Im Serverprozess
 * heisst das: die gesamte Oberflaeche haengt, minutenlang, fuer jeden Benutzer.
 * fs.promises.copyFile gibt die Arbeit an den Thread-Pool von libuv ab; der
 * Hauptthread ist waehrend des Kopierens frei, und das `await` gibt dem Ring
 * zwischen zwei Dateien eine Runde. Das ist einer Stream-Pumpe (createReadStream
 * -> createWriteStream) vorzuziehen, weil copyFile je nach Dateisystem
 * copy_file_range/fcopyfile benutzt und damit die Daten gar nicht erst durch
 * den JS-Prozess laufen. Nacheinander statt parallel: so bleibt der Fortschritt
 * monoton, ENOSPC trifft genau eine Datei, und der Thread-Pool (vier Threads)
 * bleibt fuer den Rest des Servers benutzbar.
 */
async function copyFiles(files, dest, { onFile, label, signal, what = 'Das Kopieren' } = {}) {
  let copied = 0;
  let bytes = 0;
  const madeDirs = new Set();
  const total = files.length;
  const planBytes = files.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0);
  let lastReport = 0;

  const report = (force) => {
    if (!onFile) return;
    const now = Date.now();
    // Alle 25 Dateien war fuer eine Zeile in der Kommandozeile gedacht: bei
    // 10 Dateien kam damit ueberhaupt nur die Schlussmeldung an. Ein Balken im
    // Browser braucht die erste Datei (damit er ueberhaupt erscheint), eine
    // Zahl in Prozent, und auch bei wenigen grossen Dateien regelmaessig ein
    // Lebenszeichen -- deshalb zusaetzlich die Zeitschranke.
    if (!force && copied !== 1 && copied % 25 !== 0 && now - lastReport < 150) return;
    lastReport = now;
    onFile({
      copied, total, bytes, totalBytes: planBytes,
      percent: percentOf(bytes, planBytes, copied, total), label,
    });
  };

  for (const file of files) {
    throwIfAborted(signal, what);
    const target = path.join(dest, file.rel);
    const dir = path.dirname(target);
    if (!madeDirs.has(dir)) {
      await fsp.mkdir(dir, { recursive: true });
      madeDirs.add(dir);
    }
    try {
      await fsp.copyFile(file.abs, target);
    } catch (err) {
      if (err && err.code === 'ENOSPC') {
        throw new StickFullError(
          `Der Stick ist während des Kopierens voll geworden (bei "${file.rel}"). Es wurde nichts verändert: `
          + 'der halb kopierte Ordner wird wieder entfernt. Schaffe Platz und versuche es erneut.',
          { file: file.rel, code: 'ENOSPC' },
        );
      }
      throw new StorageError(
        `"${file.rel}" konnte nicht auf den Stick kopiert werden (${(err && err.code) || err.message}).`,
        { file: file.rel, code: err && err.code },
      );
    }
    // Keep the executable bit where the source had one (bin/neural-os.js).
    try { await fsp.chmod(target, file.mode & 0o111 ? 0o755 : 0o644); } catch { /* FAT */ }
    copied++;
    bytes += file.size;
    report(false);
  }
  report(true);
  return { files: copied, bytes };
}

/**
 * Put `tmp` where `final` is, atomically enough that a yanked stick cannot
 * produce a half directory.
 *
 * Two renames are unavoidable: a rename onto an existing directory fails on
 * Windows, so the old one has to step aside first. The gap between them is the
 * only vulnerable instant, and `cleanStale()` repairs exactly that state by
 * putting `.app.old-*` back when `app/` is missing.
 */
async function swapIntoPlace(finalPath, tmpPath) {
  const parent = path.dirname(finalPath);
  const base = path.basename(finalPath);
  const oldPath = path.join(parent, `.${base}.old-${randomSuffix()}`);

  const exists = fs.existsSync(finalPath);
  if (exists) fs.renameSync(finalPath, oldPath);
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    // Put the old one back rather than leaving the stick without an app.
    if (exists) {
      try { fs.renameSync(oldPath, finalPath); } catch { /* reported by verify() */ }
    }
    throw new StorageError(
      `Der fertige Ordner "${base}" konnte nicht an seinen Platz verschoben werden (${(err && err.code) || err.message}). `
      + 'Der vorherige Stand wurde wiederhergestellt.',
      { target: finalPath, code: err && err.code },
    );
  }
  // Die beiden Umbenennungen bleiben synchron und unmittelbar hintereinander:
  // dazwischen liegt das einzige verwundbare Fenster, und es soll so kurz wie
  // moeglich sein. Nur das Wegraeumen des alten Baums danach darf warten.
  if (exists) await rmrfAsync(oldPath);
}

/** Names this module leaves behind while it works. */
const STALE_RE = /^\.([A-Za-z0-9._ -]+)\.(tmp|old)-[0-9a-f]{8}$/;

/**
 * Repair the traces of an interrupted copy.
 *
 * `.x.tmp-*` is always garbage -- nothing ever read from it. `.x.old-*` is the
 * previous, complete version: if `x` is missing, the stick was pulled between
 * the two renames and putting it back is a genuine recovery, not a guess.
 *
 * ACHTUNG: "immer Muell" gilt nur, solange kein zweiter Vorgang auf derselben
 * Wurzel laeuft -- dessen Arbeitsverzeichnis heisst genauso. Jeder schreibende
 * Aufruf haelt deshalb lockRoot() (siehe oben), bevor er hier hereingeht.
 */
function cleanStale(root) {
  const removed = [];
  const restored = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, restored };
  }
  for (const entry of entries) {
    const m = STALE_RE.exec(entry.name);
    if (!m) continue;
    const full = path.join(root, entry.name);
    const target = path.join(root, m[1]);
    if (m[2] === 'tmp') {
      rmrf(full);
      removed.push(entry.name);
      continue;
    }
    if (fs.existsSync(target)) {
      rmrf(full);
      removed.push(entry.name);
    } else {
      try {
        fs.renameSync(full, target);
        restored.push(m[1]);
      } catch {
        removed.push(entry.name);
      }
    }
  }
  return { removed, restored };
}

/* ------------------------------------------------------------ the marker */

function markerPath(root) {
  return path.join(root, LAYOUT.marker);
}

function readMarker(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(root), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The data directory a stick actually uses.
 *
 * Read from the marker rather than hard-coded, because a user may have pointed
 * `dataDir` somewhere else -- and `update()`'s promise to leave the data alone
 * is worthless if it only knows about the default name.
 */
function dataDirOf(root) {
  const info = readMarker(root);
  const rel = info && typeof info.dataDir === 'string' && info.dataDir ? info.dataDir : LAYOUT.data;
  return path.resolve(root, rel);
}

/** Der Modellordner dieses Sticks. Absolut, damit isInside() damit rechnen kann. */
function modelsDirOf(root) {
  return path.resolve(root, LAYOUT.models);
}

/**
 * Wie viel liegt in models/, und ist es beschrieben?
 *
 * Bewusst nur Bytes, Dateizahl und "gibt es die Beschreibung": WAS dort liegt
 * und ob es zu diesem Rechner passt, beantwortet src/portable/model.js
 * (`aufDemStick`). Zwei Leser desselben Formats waeren einer zu viel -- der
 * zweite wuerde irgendwann etwas anderes behaupten als der erste.
 *
 * WARUM prepare() und preview() das trotzdem brauchen: hier liegt auf einem
 * fertigen Stick der groesste Posten. In `spaceNeeded()` geht er NICHT ein --
 * belegter Platz ist kein gebrauchter Platz, und statfs() hat ihn laengst
 * abgezogen --, aber in jede Vorschau gehoert er, sonst sucht jemand
 * vergeblich, wo seine Gigabyte geblieben sind.
 */
function modelsUebersicht(root) {
  const dir = modelsDirOf(root);
  const out = { path: dir, exists: fs.existsSync(dir), bytes: 0, files: 0, index: false };
  if (!out.exists) return out;
  out.index = fs.existsSync(path.join(dir, LAYOUT.modelsIndex));
  try {
    const tree = collectTree(dir, { exclude: new Set(), dropLogs: false });
    out.bytes = tree.bytes;
    out.files = tree.files.length;
  } catch { /* unlesbar: die Zahlen bleiben 0, `exists` sagt weiter die Wahrheit */ }
  return out;
}

/**
 * Liegt `target` in einem Ordner, den kein Vorgang dieses Moduls ueberschreibt?
 *
 * WARUM das eine Funktion ist und keine zwei if-Zeilen an vier Stellen: die
 * Liste der unantastbaren Ordner ist gewachsen (erst `data/`, jetzt auch
 * `models/`) und wird wieder wachsen. Steht sie an einer Stelle, gilt jede
 * Erweiterung sofort an allen vier Schreibstellen von update(); steht sie
 * verteilt, gilt sie irgendwann an dreien.
 *
 * Reine Funktion, deshalb auf Modulebene und exportiert: so laesst sich die
 * Zusage direkt pruefen, ohne einen Stick anzulegen.
 *
 * @returns {{dir:string, was:string}|null} null heisst "darf geschrieben werden"
 */
function geschuetzterOrdner(root, target) {
  const data = dataDirOf(root);
  if (isInside(data, target)) return { dir: data, was: 'Datenordner' };
  const models = modelsDirOf(root);
  if (isInside(models, target)) return { dir: models, was: 'Modellordner' };
  return null;
}

function writeMarker(root, extra = {}) {
  const existing = readMarker(root) || {};
  const now = new Date().toISOString();
  const info = {
    ...existing,
    neuralOsPortable: true,
    // Preserved, never overwritten: this is where somebody's notes live.
    dataDir: typeof existing.dataDir === 'string' && existing.dataDir ? existing.dataDir : LAYOUT.data,
    appDir: LAYOUT.app,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    hinweis: 'Diese Datei macht den Ordner zu einem portablen Neural OS. Bitte nicht loeschen.',
    ...extra,
  };
  writeFileAtomic(markerPath(root), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/* ------------------------------------------------- launchers and LIESMICH */

function toEol(text, kind) {
  const lf = String(text).replace(/\r\n/g, '\n');
  return kind === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * The .bat has to be CRLF: cmd.exe is the one interpreter still in wide use
 * that mis-parses a LF-only batch file, and the repository stores LF.
 */
function deployLaunchers(root, sourceRoot) {
  const written = [];
  const warnings = [];
  for (const launcher of LAUNCHERS) {
    const src = path.join(sourceRoot, 'tools', 'launchers', launcher.source);
    let raw;
    try {
      raw = fs.readFileSync(src, 'utf8');
    } catch {
      warnings.push(
        `Der Starter "${launcher.source}" fehlt im Quelltext; "${launcher.target}" liegt deshalb nicht auf dem Stick. `
        + 'Du kannst Neural OS trotzdem starten: siehe LIESMICH.txt.',
      );
      continue;
    }
    const target = path.join(root, launcher.target);
    writeFileAtomic(target, toEol(raw, launcher.eol), launcher.executable ? 0o755 : 0o644);
    written.push(launcher.target);
  }
  return { written, warnings };
}

function renderReadme({ platforms, version, fsInfo }) {
  const runtimeList = platforms.length
    ? platforms.map((p) => `  - ${p}`).join('\n')
    : '  (keine - siehe unten)';
  const modeNote = fsInfo && fsInfo.enforcesModes === false
    ? 'WICHTIG: Das Dateisystem dieses Sticks kennt keine Zugriffsrechte. Jeder, der\n'
      + 'den Stick in der Hand hat, kann die Dateien lesen. Schalte deshalb in den\n'
      + 'Einstellungen die Verschluesselung ein - sie ist hier der einzige echte Schutz.\n'
    : 'Tipp: Schalte in den Einstellungen die Verschluesselung ein. Ein Stick geht\n'
      + 'leicht verloren, und ohne Verschluesselung kann ihn jeder lesen.\n';

  return `Neural OS - portabel auf diesem Stick
=====================================

Was ist das?
------------
Dein persoenliches KI-System. Es laeuft komplett von diesem Stick: der Ordner
"app" enthaelt das Programm, "runtime" die mitgelieferte Laufzeitumgebung und
"data" deine Daten. Es wird nichts auf dem fremden Rechner installiert und
nichts an irgendeinen Server geschickt.

So startest du
--------------
  Windows   -> Doppelklick auf  "Neural OS starten.bat"
  macOS     -> Rechtsklick auf  "Neural OS starten.command"  -> Oeffnen
               (Beim ersten Mal kommt eine Sicherheitswarnung. "Oeffnen"
                anklicken. Nur ein Doppelklick genuegt beim ersten Mal nicht.)
  Linux     -> Doppelklick auf  "Neural OS starten.sh"  oder im Terminal:
               ./"Neural OS starten.sh"

Danach oeffnet sich dein Browser mit http://127.0.0.1:7777 . Solange das
schwarze Fenster offen ist, laeuft Neural OS. Zum Beenden das Fenster
schliessen oder Strg+C druecken.

Wo liegen meine Daten?
----------------------
Alles in "${LAYOUT.data}" auf diesem Stick. Nichts ausserhalb. Ein Backup ist
eine Kopie dieses Ordners - mehr braucht es nicht.

Und das Sprachmodell?
---------------------
Im Ordner "${LAYOUT.models}" kann ein Sprachmodell samt Laufzeitkern (z. B.
Ollama oder llama-server) liegen. Ist der Ordner leer, zeigt dieser Stick auf
einem fremden Rechner zwar deine Notizen, kann aber KEINE Antwort geben - dafuer
braucht es dann ein Modell, das auf jenem Rechner schon installiert ist. Was
mitreist, steht in "${LAYOUT.models}/${LAYOUT.modelsIndex}": Modellname,
Groesse, Pruefsummen und fuer welches Betriebssystem der Laufzeitkern gebaut
ist. Ein Laufzeitkern fuer Windows startet auf einem Mac nicht - die
Modelldateien selbst passen dagegen auf jeden Rechner.

${modeNote}
Mitgelieferte Laufzeiten
------------------------
${runtimeList}

Steht dein Betriebssystem nicht in der Liste, meldet der Starter das und sagt,
was fehlt. Nachlegen kannst du es in Neural OS im Bereich "Stick" (Seitenleiste,
oder g dann t): auf einem Rechner DIESES Systems genuegt dort "Jetzt kopieren"
und es braucht kein Internet; fuer ein fremdes System "Holen", dafuer einmalig
Internet. Alternativ genuegt ein installiertes Node.js (Version 20 oder neuer)
auf dem fremden Rechner.

Wenn gar nichts geht
--------------------
1. Starte im abgesicherten Modus - dabei bleiben eigene Erweiterungen aus:
     Windows:  runtime\\win-x64\\node.exe app\\bin\\neural-os.js start --safe
     macOS:    ./runtime/darwin-arm64/node app/bin/neural-os.js start --safe
     Linux:    ./runtime/linux-x64/node app/bin/neural-os.js start --safe
2. Sagt der Starter "Laufzeit fehlt", passt keine mitgelieferte Laufzeit zu
   diesem Rechner (anderes Betriebssystem oder andere Prozessorarchitektur).
3. Passiert nach dem Doppelklick gar nichts, ist der Stick moeglicherweise mit
   "noexec" eingehaengt. Dann kopiere den ganzen Ordner auf die Festplatte und
   starte ihn von dort.
4. Der Ordner "app" fehlt oder ist halb? Dann wurde der Stick beim Kopieren
   abgezogen. In Neural OS im Bereich "Stick" erst "Stick pruefen" und danach
   "Nur Programm erneuern" klicken - dein Datenordner bleibt dabei unberuehrt.

Version: ${version}
Erstellt: ${new Date().toISOString().slice(0, 10)}
`;
}

/* ------------------------------------------------------- archive readers */

function archiveCorrupt(what, detail) {
  return new StorageError(
    `Das heruntergeladene Archiv (${what}) ist beschädigt oder unvollständig (${detail}). Es wurde nichts auf den Stick geschrieben.`,
    { archive: what, detail },
  );
}

function cstr(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end === -1 ? slice.length : end);
}

/** tar sizes are octal ASCII, except GNU's base-256 form for large values. */
function tarNumber(buf, start, length) {
  if (buf[start] & 0x80) {
    let value = 0n;
    for (let i = start + 1; i < start + length; i++) value = (value << 8n) | BigInt(buf[i]);
    return Number(value);
  }
  const text = cstr(buf, start, length).trim();
  if (!text) return 0;
  const n = parseInt(text, 8);
  return Number.isFinite(n) ? n : 0;
}

/** The header checksum is the only integrity check a tar offers. Use it. */
function tarHeaderValid(block) {
  const declared = tarNumber(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : block[i];
  return sum === declared;
}

/**
 * Pull exactly one member out of a tar stream and stop.
 *
 * Streaming rather than buffering: a Node tarball unpacks to well over 100 MB
 * and we want precisely one file out of it. Everything that is not the wanted
 * member is discarded as it flows past, so peak memory is the archive plus the
 * one binary, not the whole tree.
 */
function createTarPicker(matches, maxBytes) {
  let pending = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let entrySize = 0;
  let capture = null;
  let special = null; // 'longname' | 'pax'
  let overrideName = null;
  let result = null;

  function finishEntry() {
    if (special === 'longname' && capture) {
      overrideName = Buffer.concat(capture.chunks).toString('utf8').replace(/\0.*$/s, '');
    } else if (special === 'pax' && capture) {
      const text = Buffer.concat(capture.chunks).toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(text);
      if (m) overrideName = m[1];
    } else if (capture) {
      result = Buffer.concat(capture.chunks);
    }
    capture = null;
    special = null;
  }

  function drain() {
    for (;;) {
      if (result) return true;
      if (padding > 0) {
        const n = Math.min(padding, pending.length);
        if (n === 0) return false;
        pending = pending.subarray(n);
        padding -= n;
        continue;
      }
      if (remaining > 0) {
        const n = Math.min(remaining, pending.length);
        if (n === 0) return false;
        if (capture) {
          capture.bytes += n;
          if (capture.bytes > maxBytes) {
            throw new StorageError(`Die Datei im Archiv ist größer als erlaubt (${humanBytes(maxBytes)}); der Vorgang wurde abgebrochen.`);
          }
          capture.chunks.push(Buffer.from(pending.subarray(0, n)));
        }
        pending = pending.subarray(n);
        remaining -= n;
        if (remaining === 0) {
          padding = (512 - (entrySize % 512)) % 512;
          finishEntry();
        }
        continue;
      }
      if (pending.length < 512) return false;
      const block = Buffer.from(pending.subarray(0, 512));
      pending = pending.subarray(512);
      if (block.every((b) => b === 0)) return false; // end-of-archive marker
      if (!tarHeaderValid(block)) throw archiveCorrupt('tar', 'ungültige Prüfsumme im Kopfsatz');

      const rawName = cstr(block, 0, 100);
      const prefix = cstr(block, 345, 155);
      const magic = block.toString('latin1', 257, 262);
      const typeflag = String.fromCharCode(block[156] || 0x30) || '0';
      let name = overrideName || (magic === 'ustar' && prefix ? `${prefix}/${rawName}` : rawName);
      overrideName = null;

      entrySize = tarNumber(block, 124, 12);
      remaining = entrySize;
      padding = 0;

      if (typeflag === 'L') {
        special = 'longname';
        capture = { chunks: [], bytes: 0 };
      } else if (typeflag === 'x' || typeflag === 'X') {
        special = 'pax';
        capture = { chunks: [], bytes: 0 };
      } else if ((typeflag === '0' || typeflag === '\0') && matches(name)) {
        capture = { chunks: [], bytes: 0 };
      }
      if (remaining === 0) {
        finishEntry();
      }
    }
  }

  return {
    /** @returns {boolean} true once the wanted member is complete. */
    push(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      return drain();
    },
    result() { return result; },
  };
}

/** Gunzip a buffer through the tar picker, stopping as soon as it is satisfied. */
function pickFromTarGz(buffer, matches, maxBytes) {
  return new Promise((resolve, reject) => {
    const picker = createTarPicker(matches, maxBytes);
    const gunzip = zlib.createGunzip();
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    gunzip.on('data', (chunk) => {
      try {
        if (picker.push(chunk)) {
          gunzip.destroy();
          done(resolve, picker.result());
        }
      } catch (err) {
        gunzip.destroy();
        done(reject, err);
      }
    });
    gunzip.on('end', () => done(resolve, picker.result()));
    gunzip.on('close', () => done(resolve, picker.result()));
    gunzip.on('error', (err) => done(reject, archiveCorrupt('tar.gz', (err && err.message) || 'gunzip fehlgeschlagen')));
    gunzip.end(buffer);
  });
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Minimal zip reader: find one member, inflate it, done.
 *
 * The end-of-central-directory record sits behind a comment of unknown length,
 * so it has to be searched for backwards; the record whose declared comment
 * length lands exactly on the end of the file is the real one and not a
 * coincidence inside compressed data.
 */
function pickFromZip(buffer, matches, maxBytes) {
  if (buffer.length < 22) throw archiveCorrupt('zip', 'zu kurz für ein Archiv');
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) !== SIG_EOCD) continue;
    if (i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
    if (eocd < 0) eocd = i;
  }
  if (eocd < 0) throw archiveCorrupt('zip', 'das Verzeichnis am Dateiende fehlt');

  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  if (p < 0 || p >= buffer.length) throw archiveCorrupt('zip', 'ungültiger Verzeichnis-Zeiger');

  for (let k = 0; k < count; k++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buffer.length) break;
    const rawName = buffer.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1');
    p += 46 + nameLen + extraLen + commentLen;

    if (!matches(name)) continue;
    if (size > maxBytes) {
      throw new StorageError(`Die Datei "${name}" im Archiv ist größer als erlaubt (${humanBytes(maxBytes)}).`);
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw archiveCorrupt('zip', `Eintrag "${name}" hat keinen gültigen Kopfsatz`);
    }
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const end = start + compressedSize;
    if (end > buffer.length) throw archiveCorrupt('zip', `Eintrag "${name}" ist abgeschnitten`);
    const raw = buffer.subarray(start, end);
    if (method === 0) return Buffer.from(raw);
    if (method !== 8) throw archiveCorrupt('zip', `unbekanntes Kompressionsverfahren ${method}`);
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (err) {
      throw archiveCorrupt('zip', `Eintrag "${name}" ließ sich nicht entpacken`);
    }
  }
  return null;
}

/* ----------------------------------------------------------- the factory */

/**
 * @param {{gate?:object, logger?:Function|object, paths?:object, config?:object,
 *          freeBytes?:(dir:string)=>number|null}} [deps]
 *   `freeBytes` exists so the "not enough space" path is testable without a
 *   full disk; it defaults to the real `statfs`.
 */
function createStick(deps = {}) {
  const gate = deps.gate || null;
  const log = typeof deps.logger === 'function' ? deps.logger('stick') : (deps.logger || nullLogger());
  const appPaths = deps.paths || null;
  const config = deps.config || null;
  const freeBytes = typeof deps.freeBytes === 'function' ? deps.freeBytes : freeBytesOf;

  /** Node version used for downloads: the one we run, unless configured. */
  function nodeVersion() {
    const configured = config && config.portable && config.portable.nodeVersion;
    const raw = typeof configured === 'string' && configured ? configured : process.version;
    const v = raw.startsWith('v') ? raw : `v${raw}`;
    if (!/^v\d+\.\d+\.\d+$/.test(v)) {
      throw new ValidationError(`"${raw}" ist keine gültige Node-Version (erwartet z. B. v22.11.0).`);
    }
    return v;
  }

  function requireTarget(targetDir, what) {
    if (typeof targetDir !== 'string' || !targetDir.trim()) {
      throw new ValidationError(`${what} braucht den Pfad zum Stick (z. B. /media/usb oder E:\\).`);
    }
    const root = path.resolve(targetDir);
    // Without this, mkdir on a regular file raises a bare EEXIST later on.
    try {
      if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
        throw new ValidationError(`${root} ist eine Datei, kein Ordner. Gib den Ordner des Sticks an.`);
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      // An unreadable path is reported by the operation that needs it.
    }
    return root;
  }

  function requireStick(root, what) {
    if (!fs.existsSync(root)) {
      throw new StickNotFoundError(
        `Den Ordner ${root} gibt es nicht. Steckt der Stick noch, und stimmt der Pfad?`,
        { root },
      );
    }
    if (!readMarker(root)) {
      throw new ValidationError(
        `In ${root} liegt kein Neural-OS-Stick (die Datei "${LAYOUT.marker}" fehlt oder ist unlesbar). `
        + `${what} arbeitet nur auf einem bereits vorbereiteten Stick - lege ihn zuerst mit "Stick vorbereiten" an.`,
      );
    }
  }

  /**
   * The guard behind update()'s central promise. Every write during an update
   * goes through here, so "data and models are never touched" is a property of
   * the code and not of the author's attention.
   */
  function assertNichtGeschuetzt(root, target) {
    const treffer = geschuetzterOrdner(root, target);
    if (treffer) {
      throw new StorageError(
        `Abgebrochen: "${target}" liegt im ${treffer.was}. Eine Aktualisierung erneuert nur das Programm - `
        + 'sie darf weder deinen Datenbestand noch ein mitgenommenes Modell verändern.',
        { target, ordner: treffer.dir, was: treffer.was },
      );
    }
  }

  function warnFilesystem(fsInfo, warnings) {
    if (fsInfo.enforcesModes === false) {
      warnings.push(
        'Das Dateisystem dieses Sticks kennt keine Zugriffsrechte (typisch für exFAT und FAT32). '
        + 'Die Dateirechte 0600/0700 laufen dort ins Leere - sie schützen deine Daten hier NICHT. '
        + 'Schalte deshalb die Verschlüsselung ein; sie ist auf einem Stick der einzige wirksame Schutz.',
      );
    } else if (fsInfo.enforcesModes === null && process.platform === 'win32') {
      warnings.push(
        'Unter Windows werden Unix-Dateirechte nicht abgebildet; der Schutz hängt an den Rechten des '
        + 'Laufwerks. Auf einem Stick heißt das praktisch: Verschlüsselung einschalten.',
      );
    }
    if (fsInfo.maxFileBytes !== null && fsInfo.maxFileBytes !== undefined && fsInfo.maxFileBytes < 4 * 1024 * 1024 * 1024) {
      warnings.push(
        `Der Stick ist mit ${fsInfo.typeName} formatiert. Dort kann keine einzelne Datei größer als 4 GB sein - `
        + 'ein größeres KI-Modell passt also nicht darauf. Für Modelle brauchst du exFAT oder NTFS.',
      );
    } else if (fsInfo.enforcesModes === false && fsInfo.typeName === 'unbekannt') {
      warnings.push(
        'Der Typ des Dateisystems ließ sich nicht bestimmen. Falls es FAT32 ist, passt keine Datei '
        + 'über 4 GB darauf - das betrifft größere KI-Modelle.',
      );
    }
    if (fsInfo.error) {
      warnings.push(`Beim Prüfen des Dateisystems trat ein Fehler auf: ${fsInfo.error}`);
    }
  }

  /** Which platforms does the caller want? Local is included unless refused. */
  function resolvePlatforms(includeRuntimes) {
    const extra = [];
    let local = true;
    if (includeRuntimes === false) {
      local = false;
    } else if (Array.isArray(includeRuntimes)) {
      for (const id of includeRuntimes) {
        if (!PLATFORMS[id]) {
          throw new ValidationError(
            `"${id}" ist keine bekannte Plattform. Möglich sind: ${Object.keys(PLATFORMS).join(', ')}.`,
          );
        }
        if (id !== LOCAL_PLATFORM) extra.push(id);
      }
    } else if (includeRuntimes === 'all') {
      for (const id of Object.keys(PLATFORMS)) if (id !== LOCAL_PLATFORM) extra.push(id);
    } else if (includeRuntimes !== undefined && includeRuntimes !== true) {
      throw new ValidationError('includeRuntimes muss true, false, "all" oder eine Liste von Plattformen sein.');
    }
    return { local, extra: [...new Set(extra)] };
  }

  function runtimeDir(root, platform) {
    return path.join(root, LAYOUT.runtime, platform);
  }

  /**
   * Dateien, deren Modus prepare() ausdruecklich gesetzt hat.
   *
   * Sie beantworten die Rechtefrage, ohne etwas anzulegen: kommt der gesetzte
   * Modus unveraendert zurueck, setzt das Dateisystem Rechte durch; kommt
   * stattdessen 0777/0666 zurueck, hat es sie verworfen (exFAT, FAT32).
   */
  function modeWitnesses(root) {
    const list = [{ path: dataDirOf(root), mode: 0o700 }];
    for (const launcher of LAUNCHERS) {
      list.push({ path: path.join(root, launcher.target), mode: launcher.executable ? 0o755 : 0o644 });
    }
    return list;
  }

  function runtimeBinary(root, platform) {
    const spec = PLATFORMS[platform];
    return spec ? path.join(runtimeDir(root, platform), spec.file) : null;
  }

  /** Remnants of a download that was interrupted. Nothing ever read from them. */
  function dropRuntimeScraps(dir) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (STALE_RE.test(name)) rmrf(path.join(dir, name));
      }
    } catch { /* the directory may not exist yet */ }
  }

  /**
   * Copy the running interpreter onto the stick. No network, no download, no
   * conditions -- this is what makes the stick work on the next machine of the
   * same kind, and it is the only runtime we can guarantee.
   */
  async function copyLocalRuntime(root, warnings, signal) {
    if (!LOCAL_PLATFORM) {
      warnings.push(
        `Dieses Betriebssystem (${process.platform}/${process.arch}) hat keine offizielle Node-Ausgabe; `
        + 'es konnte keine Laufzeit vom laufenden System kopiert werden. Der Stick braucht dann ein '
        + 'installiertes Node.js (Version 20 oder neuer).',
      );
      return null;
    }
    const dir = runtimeDir(root, LOCAL_PLATFORM);
    mkdirp(dir);
    dropRuntimeScraps(dir);
    const target = runtimeBinary(root, LOCAL_PLATFORM);
    const tmp = path.join(dir, `.${path.basename(target)}.tmp-${randomSuffix()}`);
    throwIfAborted(signal, 'Das Kopieren der Laufzeit');
    try {
      // Rund 110 MB am Stueck: synchron kopiert stuende der Server so lange.
      await fsp.copyFile(process.execPath, tmp);
    } catch (err) {
      await rmrfAsync(tmp);
      if (err && err.code === 'ENOSPC') {
        throw new StickFullError(
          'Der Stick wurde beim Kopieren der Laufzeit voll. Die Laufzeit ist rund '
          + `${humanBytes(sizeOf(process.execPath))} groß. Schaffe Platz und versuche es erneut.`,
          { code: 'ENOSPC' },
        );
      }
      throw new StorageError(`Die Laufzeit konnte nicht kopiert werden (${(err && err.code) || err.message}).`);
    }
    try { fs.chmodSync(tmp, 0o755); } catch { /* FAT ignores modes; noted in warnings */ }
    fs.renameSync(tmp, target);
    writeFileAtomic(path.join(dir, 'node-version.txt'), `${process.version}\n`);
    return { platform: LOCAL_PLATFORM, file: target, bytes: sizeOf(target), version: process.version, source: 'lokal' };
  }

  function sizeOf(file) {
    try { return fs.statSync(file).size; } catch { return 0; }
  }

  /**
   * Does the copied runtime actually run here?
   *
   * Only asked for the local platform -- a win-x64 binary cannot be executed on
   * Linux, and failing to run it would prove nothing. A failure is a warning,
   * not an error: the usual cause is a stick mounted `noexec`, which is a
   * property of this machine's mount options and not of the stick.
   */
  function checkExecutable(binary, { signal } = {}) {
    // WARUM kein spawnSync: die Zeitgrenze ist 20 s, und spawnSync haelt so
    // lange den ganzen Prozess an. Auf einem "noexec"-Stick -- dem Fall, den
    // diese Pruefung finden soll -- waere das im Server 20 s Stillstand.
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(binary, ['-e', 'process.stdout.write(process.version)'], {
          timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ ok: false, reason: (err && err.message) || String(err) });
        return;
      }

      let out = '';
      let settled = false;
      const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* schon beendet */ } };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      if (signal) {
        if (signal.aborted) { onAbort(); finish({ ok: false, reason: 'abgebrochen' }); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (chunk) => { if (out.length < 200) out += String(chunk); });
      child.stderr.on('data', () => { /* verworfen, muss aber gelesen werden */ });
      child.on('error', (err) => finish({ ok: false, reason: err.code || err.message }));
      child.on('close', (code, sig) => {
        if (sig) return finish({ ok: false, reason: `Beendet durch Signal ${sig}` });
        if (code !== 0) return finish({ ok: false, reason: `Beendet mit Status ${code}` });
        finish({ ok: true, version: out.trim() });
      });
    });
  }

  /* ------------------------------------------------------------ download */

  /**
   * Everything that leaves this machine goes through here, so there is exactly
   * one place where the scope, the ceiling and the host list are set.
   */
  async function fetchFromDist(url, { purpose, maxBytes, signal }) {
    if (!gate) {
      throw new ValidationError(
        'Ohne Netzschleuse kann keine zusätzliche Laufzeit geholt werden. '
        + 'Starte Neural OS normal (dann ist die Schleuse da) oder kopiere die Laufzeit von Hand '
        + `nach ${LAYOUT.runtime}/<plattform>/.`,
      );
    }
    let response;
    try {
      response = await gate.fetch(url, {
        scope: RUNTIME_SCOPE,
        purpose,
        maxLevel: 'online',
        allowedHosts: [DIST_HOST],
        maxBytes,
        timeoutMs: RUNTIME_TIMEOUT_MS,
        signal,
      });
    } catch (err) {
      throw explainBlocked(err, url);
    }
    if (!response || !response.ok) {
      const status = response ? response.status : '?';
      throw new StorageError(
        `nodejs.org hat die Anfrage nach ${url} mit Status ${status} beantwortet. `
        + 'Es wurde nichts auf den Stick geschrieben. Stimmt die Node-Version?',
        { url, status },
      );
    }
    return response;
  }

  /**
   * Turn a policy denial into something the user can act on.
   *
   * A blocked request here is not a defect: the user's own network policy said
   * no. The message therefore says which two things would change that, and --
   * more important -- that the stick is complete and usable without the extra
   * runtime.
   */
  function explainBlocked(err, url) {
    if (!err || err.code !== 'NETWORK_BLOCKED') return err;
    const hint =
      `Die Netzschleuse hat den Zugriff auf ${DIST_HOST} blockiert. Grund: ${err.message} `
      + `Damit eine zusätzliche Laufzeit geholt werden kann, brauchst du entweder den Netzmodus 'online' `
      + `mit ${DIST_HOST} auf der Freigabeliste, oder eine Freigabe für den Bereich '${RUNTIME_SCOPE}'. `
      + 'Das ist kein Fehler des Stick-Werkzeugs: Der Stick läuft auch ohne die zusätzlichen Laufzeiten '
      + 'auf jedem Rechner mit demselben Betriebssystem wie diesem hier.';
    return new NetworkBlockedError(hint, {
      ...(err.details || {}),
      url,
      scope: RUNTIME_SCOPE,
      needs: { mode: 'online', allowHost: DIST_HOST, orGrantScope: RUNTIME_SCOPE },
    });
  }

  function findShasum(text, filename) {
    for (const line of String(text).split('\n')) {
      const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
      if (m && m[2] === filename) return m[1];
    }
    return null;
  }

  /**
   * Fetch one runtime, check it against the official checksum, unpack the one
   * binary we need.
   *
   * The order matters: the checksum list is fetched first and from the same
   * origin, and a binary whose hash does not match is never written. Half a
   * verification is no verification.
   */
  async function downloadRuntime(root, platform, onProgress, signal) {
    const spec = PLATFORMS[platform];
    const version = nodeVersion();
    const ext = spec.archive === 'zip' ? 'zip' : 'tar.gz';
    const filename = `node-${version}-${platform}.${ext}`;
    const base = `${DIST_BASE}/${version}`;

    onProgress({ phase: 'runtime', message: `Prüfsummen für ${platform} werden geladen …`, platform });
    throwIfAborted(signal, `Das Holen der Laufzeit ${platform}`);
    const sumsResponse = await fetchFromDist(`${base}/SHASUMS256.txt`, {
      purpose: `stick.runtime.checksums:${platform}`,
      maxBytes: MAX_SHASUMS_BYTES,
      signal,
    });
    const sums = await sumsResponse.text();
    const expected = findShasum(sums, filename);
    if (!expected) {
      throw new StorageError(
        `In SHASUMS256.txt von nodejs.org gibt es keinen Eintrag für "${filename}". `
        + `Gibt es Node ${version} für ${platform} überhaupt? Es wurde nichts geschrieben.`,
        { filename, version, platform },
      );
    }

    onProgress({ phase: 'runtime', message: `Laufzeit für ${platform} wird geladen (${filename}) …`, platform });
    throwIfAborted(signal, `Das Holen der Laufzeit ${platform}`);
    const archiveResponse = await fetchFromDist(`${base}/${filename}`, {
      purpose: `stick.runtime.download:${platform}`,
      maxBytes: MAX_ARCHIVE_BYTES,
      signal,
    });
    const archive = Buffer.from(await archiveResponse.arrayBuffer());

    const actual = crypto.createHash('sha256').update(archive).digest('hex');
    if (actual !== expected) {
      throw new StorageError(
        `Die Prüfsumme von "${filename}" stimmt nicht mit der von nodejs.org veröffentlichten überein. `
        + 'Die Datei wurde VERWORFEN und nichts auf den Stick geschrieben. Das kann an einer abgebrochenen '
        + 'Übertragung liegen - oder daran, dass jemand unterwegs etwas ausgetauscht hat.',
        { filename, expected, actual },
      );
    }

    onProgress({ phase: 'runtime', message: `Laufzeit für ${platform} wird entpackt …`, platform });
    const wanted = spec.member;
    const matches = (name) => name === wanted || name.endsWith(`/${wanted}`);
    const binary = spec.archive === 'zip'
      ? pickFromZip(archive, matches, MAX_BINARY_BYTES)
      : await pickFromTarGz(archive, matches, MAX_BINARY_BYTES);

    if (!binary || !binary.length) {
      throw new StorageError(
        `Im Archiv "${filename}" war keine Datei "${wanted}" zu finden. Es wurde nichts geschrieben.`,
        { filename, member: wanted },
      );
    }

    const dir = runtimeDir(root, platform);
    mkdirp(dir);
    dropRuntimeScraps(dir);
    const target = runtimeBinary(root, platform);
    const tmp = path.join(dir, `.${spec.file}.tmp-${randomSuffix()}`);
    try {
      fs.writeFileSync(tmp, binary);
      try { fs.chmodSync(tmp, 0o755); } catch { /* FAT */ }
      fs.renameSync(tmp, target);
    } catch (err) {
      rmrf(tmp);
      if (err && err.code === 'ENOSPC') {
        throw new StickFullError(
          `Der Stick hat nicht genug Platz für die Laufzeit ${platform} (${humanBytes(binary.length)}).`,
          { platform, needed: binary.length },
        );
      }
      throw new StorageError(`Die Laufzeit ${platform} konnte nicht geschrieben werden (${(err && err.code) || err.message}).`);
    }
    writeFileAtomic(path.join(dir, 'node-version.txt'), `${version}\n`);
    return { platform, file: target, bytes: binary.length, version, source: DIST_HOST };
  }

  /* --------------------------------------------------------- public API */

  /**
   * Make `targetDir` a running Neural OS stick.
   *
   * @param {string} targetDir
   * @param {{includeRuntimes?:boolean|'all'|string[], includeVault?:boolean,
   *          sourceHome?:string, sourceRoot?:string, onProgress?:Function,
   *          signal?:AbortSignal}} [opts]
   *   `signal` bricht den Vorgang ab -- der Fall "Browsertab zu, waehrend 8 GB
   *   kopiert werden". Ohne ihn laeuft alles wie bisher.
   * @returns {Promise<{root:string, bytes:number, files:number, runtimes:object[], warnings:string[]}>}
   */
  async function prepare(targetDir, opts = {}) {
    const root = requireTarget(targetDir, 'prepare()');
    const release = lockRoot(root, 'Stick vorbereiten');
    try {
      return await prepareLocked(root, opts);
    } finally {
      release();
    }
  }

  async function prepareLocked(root, opts) {
    const signal = opts.signal || null;
    const what = 'Das Vorbereiten des Sticks';
    throwIfAborted(signal, what);
    const sourceRoot = path.resolve(opts.sourceRoot || APP_ROOT);
    const progress = makeProgress(opts.onProgress, log);
    const warnings = [];

    if (!fs.existsSync(sourceRoot)) {
      throw new StickNotFoundError(`Den Quelltext-Ordner ${sourceRoot} gibt es nicht.`, { sourceRoot });
    }
    // Copying a tree into itself produces an ever-growing copy. Refuse early.
    if (isInside(sourceRoot, root)) {
      throw new ValidationError(
        `Der Stick-Ordner ${root} liegt im Quelltext-Ordner ${sourceRoot}. Wähle einen Ordner ausserhalb, `
        + 'sonst wuerde sich die Kopie endlos selbst kopieren.',
      );
    }
    if (isInside(root, sourceRoot)) {
      throw new ValidationError(`Der Quelltext liegt im Zielordner ${root}. Wähle einen anderen Zielordner.`);
    }

    const plan = resolvePlatforms(opts.includeRuntimes);
    if (!plan.local) {
      warnings.push(
        'Es wurde ausdruecklich keine Laufzeit mitkopiert. Der Stick läuft dann nur auf Rechnern, '
        + 'auf denen Node.js (Version 20 oder neuer) bereits installiert ist.',
      );
    }

    progress({ phase: 'check', message: 'Quelltext wird vermessen …' });
    const source = collectTree(sourceRoot);
    warnings.push(...source.warnings);

    let home = null;
    if (opts.includeVault) {
      const homeDir = opts.sourceHome || (appPaths && appPaths.home);
      if (!homeDir) {
        throw new ValidationError(
          'Für eine Sicherung des Datenbestands fehlt der Quellordner. Uebergib sourceHome, '
          + 'oder erzeuge das Werkzeug mit paths aus einer laufenden Instanz.',
        );
      }
      if (!fs.existsSync(homeDir)) {
        throw new StickNotFoundError(`Den Datenordner ${homeDir} gibt es nicht.`, { homeDir });
      }
      if (isInside(homeDir, root) || isInside(root, homeDir)) {
        throw new ValidationError(`Der Datenordner ${homeDir} und der Stick-Ordner ${root} duerfen nicht ineinander liegen.`);
      }
      home = collectTree(homeDir, { exclude: HOME_EXCLUDED_NAMES, dropLogs: false });
      warnings.push(...home.warnings);
    }

    // ---- the space check, before a single byte of content is written ----
    mkdirp(root);
    const localRuntimeBytes = plan.local && LOCAL_PLATFORM ? sizeOf(process.execPath) : 0;
    const bedarf = {
      sourceBytes: source.bytes,
      runtimeBytes: localRuntimeBytes,
      homeBytes: home ? home.bytes : 0,
      extraRuntimes: plan.extra.length,
    };
    const { withHeadroom } = spaceNeeded('prepare', bedarf);
    const free = freeBytes(root);
    if (free === null) {
      warnings.push('Der freie Platz auf dem Stick ließ sich nicht ermitteln; der Vorgang läuft ohne diese Prüfung.');
    } else if (free < withHeadroom) {
      throw stickFull('prepare', { ...bedarf, free, withHeadroom });
    }

    const fsInfo = probeFilesystem(root);
    if (!fsInfo.writable) {
      throw new PermissionError(
        `In ${root} lässt sich nicht schreiben (${fsInfo.error || 'unbekannter Grund'}). `
        + 'Ist der Stick schreibgeschützt oder nur lesend eingehängt?',
        { root, error: fsInfo.error },
      );
    }
    warnFilesystem(fsInfo, warnings);

    const recovered = cleanStale(root);
    if (recovered.restored.length) {
      warnings.push(`Ein früher abgebrochener Kopiervorgang wurde repariert (wiederhergestellt: ${recovered.restored.join(', ')}).`);
    }

    // ---- source tree: build beside, then swap ----
    progress({ phase: 'source', message: 'Quelltext wird kopiert …', total: source.files.length });
    const tmpApp = path.join(root, `.${LAYOUT.app}.tmp-${randomSuffix()}`);
    rmrf(tmpApp);
    mkdirp(tmpApp);
    let written;
    try {
      written = await copyFiles(source.files, tmpApp, {
        label: 'source',
        signal,
        what,
        onFile: (p) => progress({
          phase: 'source',
          message: `Quelltext wird kopiert (${p.copied}/${p.total}, ${p.percent} %) …`,
          ...p,
        }),
      });
      await swapIntoPlace(path.join(root, LAYOUT.app), tmpApp);
    } catch (err) {
      // Auch bei Abbruch: das halbfertige Verzeichnis verschwindet, der
      // vorherige Stand bleibt unangetastet.
      await rmrfAsync(tmpApp);
      throw err;
    }

    let totalBytes = written.bytes;
    let totalFiles = written.files;

    // ---- data and sync directories ----
    const dataDir = dataDirOf(root);
    mkdirp(dataDir, 0o700);
    mkdirp(path.join(root, LAYOUT.sync), 0o700);
    // models/ wird angelegt, aber NIE geleert: hier kann ein Modell von einem
    // frueheren Mal liegen, das Minuten gekostet hat. Kein Modus 0700 - die
    // Gewichte sind kein Geheimnis, und ein fremder Laufzeitkern muss sie
    // lesen duerfen.
    mkdirp(path.join(root, LAYOUT.models));

    if (home) {
      const existing = fs.readdirSync(dataDir).filter((n) => !n.startsWith('.'));
      if (existing.length) throw dataPresent(dataDir, existing.length);
      progress({ phase: 'data', message: 'Datenbestand wird auf den Stick kopiert …', total: home.files.length });
      const vorhandene = new Set(fs.readdirSync(dataDir));
      let copiedHome;
      try {
        copiedHome = await copyFiles(home.files, dataDir, {
          label: 'data',
          signal,
          what,
          onFile: (p) => progress({
            phase: 'data',
            message: `Datenbestand wird kopiert (${p.copied}/${p.total}, ${p.percent} %) …`,
            ...p,
          }),
        });
      } catch (err) {
        // Eine halbe Sicherung sieht aus wie eine ganze und ist deshalb
        // schlimmer als keine -- also wird zurueckgenommen, was dieser Vorgang
        // angelegt hat, und nur das.
        await removeNewEntries(dataDir, vorhandene);
        throw err;
      }
      totalBytes += copiedHome.bytes;
      totalFiles += copiedHome.files;
      if (fsInfo.enforcesModes === false) {
        warnings.push(
          'Der Datenbestand liegt jetzt auf einem Dateisystem ohne Zugriffsrechte. Falls die Sicherung '
          + 'unverschlüsselt war, kann sie jeder lesen, der den Stick findet.',
        );
      }
    }

    // ---- runtimes ----
    const runtimes = [];
    if (plan.local) {
      throwIfAborted(signal, what);
      // platform gehoert in jede Laufzeit-Meldung: eine Fortschrittsanzeige
      // zeigt sonst bei der lokalen Laufzeit ein leeres Feld, wo bei jeder
      // anderen der Plattformname steht.
      progress({
        phase: 'runtime',
        message: `Laufzeit für ${LOCAL_PLATFORM || 'dieses System'} wird kopiert …`,
        platform: LOCAL_PLATFORM,
      });
      const localRuntime = await copyLocalRuntime(root, warnings, signal);
      if (localRuntime) {
        runtimes.push(localRuntime);
        totalBytes += localRuntime.bytes;
        totalFiles += 1;
        const check = await checkExecutable(localRuntime.file, { signal });
        if (!check.ok) {
          warnings.push(
            `Die kopierte Laufzeit ließ sich auf dem Stick nicht starten (${check.reason}). `
            + 'Häufigster Grund: der Stick ist mit "noexec" eingehängt. Auf einem anderen Rechner '
            + 'funktioniert sie in der Regel trotzdem; notfalls den Ordner auf die Festplatte kopieren.',
          );
        }
      }
    }

    for (const platform of plan.extra) {
      throwIfAborted(signal, what);
      try {
        const got = await downloadRuntime(root, platform, progress, signal);
        runtimes.push(got);
        totalBytes += got.bytes;
        totalFiles += 1;
      } catch (err) {
        // Ein Abbruch ist keine fehlende Laufzeit: er gilt dem ganzen Vorgang
        // und darf nicht als Hinweis unter den Tisch fallen.
        if (err instanceof AbortedError || (err && err.code === 'ABORTED')) throw err;
        // A missing extra runtime must never invalidate an otherwise good
        // stick. It is reported in full and the work continues.
        const message = err && err.message ? err.message : String(err);
        warnings.push(`Laufzeit für ${platform} wurde NICHT auf den Stick gelegt: ${message}`);
        log.warn(`Laufzeit ${platform} fehlgeschlagen: ${message}`);
      }
    }

    // ---- launchers, readme, marker ----
    throwIfAborted(signal, what);
    progress({ phase: 'finish', message: 'Starter und Hinweise werden geschrieben …', percent: 99 });
    const launchers = deployLaunchers(root, sourceRoot);
    warnings.push(...launchers.warnings);

    const platformsOnStick = detectPlatforms(root).map((p) => p.platform);
    writeFileAtomic(path.join(root, LAYOUT.readme), renderReadme({
      platforms: platformsOnStick,
      version: appVersion(sourceRoot),
      fsInfo,
    }));
    writeMarker(root, {
      preparedBy: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
    });

    progress({ phase: 'done', message: 'Der Stick ist fertig.', bytes: totalBytes, files: totalFiles, percent: 100 });
    return { root, bytes: totalBytes, files: totalFiles, runtimes, warnings };
  }

  /**
   * Replace the source tree on an existing stick, and nothing else.
   *
   * `data/`, `sync/` and `runtime/` are deliberately untouched. That is the
   * reason this function exists separately from `prepare()`.
   */
  async function update(targetDir, opts = {}) {
    const root = requireTarget(targetDir, 'update()');
    requireStick(root, 'update()');
    const release = lockRoot(root, 'Stick aktualisieren');
    try {
      return await updateLocked(root, opts);
    } finally {
      release();
    }
  }

  async function updateLocked(root, opts) {
    const signal = opts.signal || null;
    const what = 'Das Aktualisieren des Sticks';
    throwIfAborted(signal, what);
    const sourceRoot = path.resolve(opts.sourceRoot || APP_ROOT);
    const progress = makeProgress(opts.onProgress, log);
    const warnings = [];

    if (isInside(sourceRoot, root) || isInside(root, sourceRoot)) {
      throw new ValidationError(`Quelltext (${sourceRoot}) und Stick (${root}) duerfen nicht ineinander liegen.`);
    }

    const appDir = path.join(root, LAYOUT.app);
    assertNichtGeschuetzt(root, appDir);

    progress({ phase: 'check', message: 'Quelltext wird vermessen …' });
    const source = collectTree(sourceRoot);
    warnings.push(...source.warnings);

    const free = freeBytes(root);
    const { withHeadroom: needed } = spaceNeeded('update', { sourceBytes: source.bytes });
    if (free !== null && free < needed) {
      throw stickFull('update', { free, withHeadroom: needed, sourceBytes: source.bytes });
    }

    const fsInfo = probeFilesystem(root);
    if (!fsInfo.writable) {
      throw new PermissionError(
        `In ${root} lässt sich nicht schreiben (${fsInfo.error || 'unbekannter Grund'}). Ist der Stick schreibgeschützt?`,
        { root },
      );
    }
    warnFilesystem(fsInfo, warnings);

    const recovered = cleanStale(root);
    if (recovered.restored.length) {
      warnings.push(`Ein früher abgebrochener Kopiervorgang wurde repariert (wiederhergestellt: ${recovered.restored.join(', ')}).`);
    }

    progress({ phase: 'source', message: 'Quelltext wird erneuert …', total: source.files.length });
    const tmpApp = path.join(root, `.${LAYOUT.app}.tmp-${randomSuffix()}`);
    assertNichtGeschuetzt(root, tmpApp);
    rmrf(tmpApp);
    mkdirp(tmpApp);
    let written;
    try {
      written = await copyFiles(source.files, tmpApp, {
        label: 'source',
        signal,
        what,
        onFile: (p) => progress({
          phase: 'source',
          message: `Quelltext wird erneuert (${p.copied}/${p.total}, ${p.percent} %) …`,
          ...p,
        }),
      });
      await swapIntoPlace(appDir, tmpApp);
    } catch (err) {
      await rmrfAsync(tmpApp);
      throw err;
    }

    throwIfAborted(signal, what);
    progress({ phase: 'finish', message: 'Starter und Hinweise werden erneuert …', percent: 99 });
    for (const launcher of LAUNCHERS) assertNichtGeschuetzt(root, path.join(root, launcher.target));
    const launchers = deployLaunchers(root, sourceRoot);
    warnings.push(...launchers.warnings);

    const readme = path.join(root, LAYOUT.readme);
    assertNichtGeschuetzt(root, readme);
    writeFileAtomic(readme, renderReadme({
      platforms: detectPlatforms(root).map((p) => p.platform),
      version: appVersion(sourceRoot),
      fsInfo,
    }));
    writeMarker(root, { nodeVersion: process.version });

    progress({
      phase: 'done',
      message: 'Der Quelltext auf dem Stick ist aktuell.',
      bytes: written.bytes,
      files: written.files,
      percent: 100,
    });
    return { root, bytes: written.bytes, files: written.files, warnings, dataDir: dataDirOf(root) };
  }

  /**
   * Was WUERDE passieren? Eine reine Lesefrage, mit denselben Zahlen.
   *
   * WARUM es das gibt: im Browser gibt es keinen Ordnerwaehler, der einen
   * absoluten Pfad liefert -- der Pfad wird getippt. Ein getippter Pfad und
   * ein Knopf, der sofort 8 GB kopiert, ist eine Falle. Dieselbe Antwort gibt
   * `src/http/api/watch.js` mit seinem "Erst ansehen", und aus demselben
   * Grund: bevor dieses Programm eine fremde Stelle der Platte anfasst, soll
   * dastehen, WELCHE Stelle das ist und was dort passieren wuerde.
   *
   * Diese Funktion schreibt nichts -- keine Sonde, kein mkdir. Die Rechtefrage
   * wird deshalb ueber access(W_OK) und die Zeugen beantwortet (siehe
   * inspectFilesystem), nicht durch Anlegen einer Datei.
   *
   * Sie wirft nur, wenn sie gar nicht antworten kann (unbrauchbarer Pfad,
   * unlesbarer Quelltext, kein Stick fuer update/runtime). Alles, woran der
   * Vorgang scheitern WUERDE, steht als Satz in `blockers` -- damit die
   * Oberflaeche es anzeigen kann, statt einen Fehler zu werfen.
   *
   * @param {string} targetDir
   * @param {{action?:'prepare'|'update'|'runtime', includeVault?:boolean,
   *          includeRuntimes?:*, platform?:string, sourceRoot?:string,
   *          sourceHome?:string}} [opts]
   */
  function preview(targetDir, opts = {}) {
    const action = opts.action === 'update' || opts.action === 'runtime' ? opts.action : 'prepare';
    const label = action === 'update' ? 'Die Vorschau auf "Stick aktualisieren"'
      : action === 'runtime' ? 'Die Vorschau auf "Laufzeit holen"' : 'Die Vorschau auf "Stick vorbereiten"';
    const root = requireTarget(targetDir, label);
    if (action !== 'prepare') requireStick(root, label);

    const warnings = [];
    const blockers = [];
    const block = (err) => blockers.push({ code: err.code, status: err.status, message: err.message });

    const exists = fs.existsSync(root);
    const marker = readMarker(root);

    // Ein laufender Vorgang ist der haeufigste Grund, aus dem ein zweiter
    // Klick nichts tun darf -- und der einzige, den man auf der Platte nicht
    // sehen kann.
    const running = runningOn(root);
    if (running) block(busyError(root, running));

    // ---- Quelltext ----
    const sourceRoot = path.resolve(opts.sourceRoot || APP_ROOT);
    let source = { files: [], bytes: 0, warnings: [] };
    if (action !== 'runtime') {
      if (!fs.existsSync(sourceRoot)) {
        throw new StickNotFoundError(`Den Quelltext-Ordner ${sourceRoot} gibt es nicht.`, { sourceRoot });
      }
      if (isInside(sourceRoot, root)) {
        throw new ValidationError(
          `Der Stick-Ordner ${root} liegt im Quelltext-Ordner ${sourceRoot}. Wähle einen Ordner ausserhalb, `
          + 'sonst wuerde sich die Kopie endlos selbst kopieren.',
        );
      }
      if (isInside(root, sourceRoot)) {
        throw new ValidationError(`Der Quelltext liegt im Zielordner ${root}. Wähle einen anderen Zielordner.`);
      }
      source = collectTree(sourceRoot);
      warnings.push(...source.warnings);
    }

    // ---- Datenbestand ----
    let home = null;
    let homeDir = null;
    if (action === 'prepare' && opts.includeVault) {
      homeDir = opts.sourceHome || (appPaths && appPaths.home) || null;
      if (!homeDir) {
        throw new ValidationError(
          'Für eine Sicherung des Datenbestands fehlt der Quellordner. Uebergib sourceHome, '
          + 'oder erzeuge das Werkzeug mit paths aus einer laufenden Instanz.',
        );
      }
      if (!fs.existsSync(homeDir)) {
        throw new StickNotFoundError(`Den Datenordner ${homeDir} gibt es nicht.`, { homeDir });
      }
      if (isInside(homeDir, root) || isInside(root, homeDir)) {
        throw new ValidationError(`Der Datenordner ${homeDir} und der Stick-Ordner ${root} duerfen nicht ineinander liegen.`);
      }
      home = collectTree(homeDir, { exclude: HOME_EXCLUDED_NAMES, dropLogs: false });
      warnings.push(...home.warnings);
    }

    // ---- Laufzeiten ----
    let plan;
    if (action === 'runtime') {
      if (!PLATFORMS[opts.platform]) {
        throw new ValidationError(
          `"${opts.platform}" ist keine bekannte Plattform. Möglich sind: ${Object.keys(PLATFORMS).join(', ')}.`,
        );
      }
      plan = { local: opts.platform === LOCAL_PLATFORM, extra: opts.platform === LOCAL_PLATFORM ? [] : [opts.platform] };
    } else if (action === 'update') {
      plan = { local: false, extra: [] };
    } else {
      plan = resolvePlatforms(opts.includeRuntimes);
    }
    const onStick = detectPlatforms(root);
    const runtimeBytes = plan.local && LOCAL_PLATFORM ? sizeOf(process.execPath) : 0;

    // ---- Platz, mit derselben Formel wie der Vorgang ----
    const bedarf = {
      sourceBytes: source.bytes,
      runtimeBytes,
      homeBytes: home ? home.bytes : 0,
      extraRuntimes: plan.extra.length,
    };
    const { required, withHeadroom } = spaceNeeded(action, bedarf);
    const free = freeBytes(root);
    let fits = null;
    if (free === null) {
      warnings.push('Der freie Platz ließ sich hier nicht ermitteln; der Vorgang läuft dann ohne diese Prüfung.');
    } else {
      fits = free >= withHeadroom;
      if (!fits) {
        const err = stickFull(action, { ...bedarf, free, withHeadroom });
        // addRuntime() rechnet vorher nicht nach -- ein Download ist geschaetzt,
        // und eine Vorschau darf nicht schaerfer ablehnen als der Vorgang.
        if (action === 'runtime') warnings.push(`${err.message} (Die Groesse einer Laufzeit ist geschätzt.)`);
        else block(err);
      }
    }

    // ---- Dateisystem, ohne Sonde ----
    const probeDir = exists ? root : nearestExisting(root);
    const filesystem = probeDir
      ? inspectFilesystem(probeDir, exists ? modeWitnesses(root) : [])
      : emptyFsInfo();
    if (!probeDir) {
      warnings.push(`Von ${root} existiert kein einziger übergeordneter Ordner; der Pfad ist vermutlich falsch getippt.`);
    } else if (!filesystem.writable) {
      block(new PermissionError(
        exists
          ? `In ${root} lässt sich nicht schreiben (${filesystem.error || 'unbekannter Grund'}). `
            + 'Ist der Stick schreibgeschützt oder nur lesend eingehängt?'
          : `Den Ordner ${root} gibt es noch nicht, und in ${probeDir} lässt sich nichts anlegen `
            + `(${filesystem.error || 'unbekannter Grund'}).`,
        { root },
      ));
    }
    warnFilesystem(filesystem, warnings);

    // ---- Datenordner auf dem Stick ----
    const dataDir = dataDirOf(root);
    let dataEntries = [];
    try {
      dataEntries = fs.readdirSync(dataDir).filter((n) => !n.startsWith('.'));
    } catch { /* gibt es noch nicht */ }
    if (action === 'prepare' && home && dataEntries.length) {
      block(dataPresent(dataDir, dataEntries.length));
    }

    const stale = [];
    try {
      for (const entry of fs.readdirSync(root)) if (STALE_RE.test(entry)) stale.push(entry);
    } catch { /* der Ordner muss noch nicht existieren */ }

    return {
      action,
      root,
      exists,
      isStick: !!marker,
      marker: marker ? {
        createdAt: marker.createdAt || null,
        updatedAt: marker.updatedAt || null,
        preparedBy: marker.preparedBy || null,
        nodeVersion: marker.nodeVersion || null,
      } : null,
      source: action === 'runtime' ? null : {
        root: sourceRoot,
        version: appVersion(sourceRoot),
        files: source.files.length,
        bytes: source.bytes,
      },
      home: home ? { root: homeDir, files: home.files.length, bytes: home.bytes } : null,
      data: { path: dataDir, exists: fs.existsSync(dataDir), entries: dataEntries.length },
      // Belegt, nicht gebraucht: siehe modelsUebersicht(). Ohne diese Zahl
      // erklaert keine Vorschau, warum auf einem 64-GB-Stick 6 GB frei sind.
      models: modelsUebersicht(root),
      runtimes: {
        local: LOCAL_PLATFORM,
        copyLocal: plan.local,
        download: plan.extra,
        onStick: onStick.map((r) => ({ platform: r.platform, bytes: r.bytes, version: r.version, isLocal: r.isLocal })),
      },
      space: { free, required, withHeadroom, fits },
      filesystem,
      running,
      stale,
      blockers,
      warnings,
    };
  }

  /**
   * Is this stick in a state where a double-click will work?
   *
   * Everything reported is something the user can act on; each problem carries
   * a `fix` sentence, because "layout invalid" helps nobody standing in front
   * of a stick that will not start.
   *
   * Diese Pruefung SCHREIBT NICHTS. Sie haengt an einer Route, die ein Browser
   * beim Oeffnen der Ansicht aufruft, und ein GET, das eine Datei anlegt, ist
   * an dieser Stelle falsch -- auf einem schreibgeschuetzten Stick scheitert er,
   * und stirbt der Prozess zwischen Anlegen und Loeschen, bleibt sein Muell
   * liegen. Wer die Schreibsonde trotzdem will, verlangt sie ausdruecklich:
   * `verify(pfad, { probe: true })`.
   *
   * @param {string} targetDir
   * @param {{probe?:boolean}} [opts]
   */
  async function verify(targetDir, opts = {}) {
    const root = requireTarget(targetDir, 'verify()');
    const probeWrite = opts.probe === true;
    const problems = [];
    const add = (level, code, message, fix) => problems.push({ level, code, message, fix });

    const exists = fs.existsSync(root);
    const layout = {
      root,
      marker: { path: markerPath(root), exists: false },
      app: { path: path.join(root, LAYOUT.app), exists: false },
      data: { path: path.join(root, LAYOUT.data), exists: false },
      runtime: { path: path.join(root, LAYOUT.runtime), exists: false },
      sync: { path: path.join(root, LAYOUT.sync), exists: false },
      models: { path: modelsDirOf(root), exists: false, bytes: 0, files: 0, index: false },
      readme: { path: path.join(root, LAYOUT.readme), exists: false },
      launchers: {},
      runtimes: [],
    };

    if (!exists) {
      add('error', 'NO_STICK', `Der Ordner ${root} existiert nicht.`, 'Stecke den Stick ein und wähle den richtigen Ordner.');
      return { ok: false, problems, layout, freeBytes: null };
    }

    const marker = readMarker(root);
    layout.marker.exists = fs.existsSync(layout.marker.path);
    if (!marker) {
      add('error', 'MARKER_MISSING',
        `Die Datei "${LAYOUT.marker}" fehlt oder ist unlesbar; ohne sie findet Neural OS seine Daten nicht.`,
        'Stick einmal mit "Stick aktualisieren" anfassen - dabei wird die Datei neu geschrieben.');
    }

    layout.data = { path: dataDirOf(root), exists: fs.existsSync(dataDirOf(root)) };
    layout.app.exists = fs.existsSync(layout.app.path);
    layout.runtime.exists = fs.existsSync(layout.runtime.path);
    layout.sync.exists = fs.existsSync(path.join(root, LAYOUT.sync));
    layout.models = modelsUebersicht(root);
    layout.readme.exists = fs.existsSync(path.join(root, LAYOUT.readme));

    // Dateien ohne Beschreibung sind auf einem fremden Rechner wertlos: niemand
    // sieht einer 4-GB-Datei an, zu welchem Modell sie gehoert und welcher
    // Laufzeitkern sie oeffnen kann. Kein Fehler -- der Stick startet trotzdem.
    if (layout.models.exists && layout.models.files > 0 && !layout.models.index) {
      add('info', 'MODELS_UNDOCUMENTED',
        `Im Ordner "${LAYOUT.models}" liegen ${layout.models.files} Datei(en) (${humanBytes(layout.models.bytes)}), `
        + `aber keine Beschreibung "${LAYOUT.modelsIndex}". Was dort liegt, laesst sich nur raten.`,
        'Lege das Modell noch einmal über "Modell mitnehmen" ab - dabei wird die Beschreibung geschrieben.');
    }

    // An interrupted copy is the one failure mode a stick really has.
    const stale = [];
    try {
      for (const entry of fs.readdirSync(root)) if (STALE_RE.test(entry)) stale.push(entry);
    } catch { /* handled by the checks below */ }
    // Ein gerade laufender Vorgang sieht auf der Platte genauso aus wie ein
    // abgebrochener -- gleiche Namen, gleiche halbe Ordner. Ihn als Abbruch zu
    // melden waere ein erfundener Befund, und der zweite Browsertab macht das
    // ueber HTTP zum Normalfall.
    const running = runningOn(root);
    if (running) {
      add('info', 'OPERATION_RUNNING',
        `Auf diesem Stick läuft gerade "${running.what}". Was hier steht, ist eine Momentaufnahme mittendrin.`,
        'Warte, bis der Vorgang fertig ist, und prüfe dann noch einmal.');
    }
    if (stale.length && running) {
      add('info', 'COPY_IN_PROGRESS',
        `Die Ordner ${stale.join(', ')} gehören zum laufenden Vorgang, nicht zu einem Abbruch.`,
        'Nichts tun - sie verschwinden, sobald er fertig ist.');
    } else if (stale.length) {
      add(layout.app.exists ? 'warn' : 'error', 'INTERRUPTED_COPY',
        `Es liegen Reste eines abgebrochenen Kopiervorgangs auf dem Stick (${stale.join(', ')}).`,
        layout.app.exists
          ? 'Sie koennen geloescht werden; "Stick aktualisieren" räumt sie automatisch auf.'
          : 'Der Ordner "app" fehlt dadurch. Rufe "Stick aktualisieren" auf - dabei wird der vorherige Stand wiederhergestellt.');
    }

    if (!layout.app.exists) {
      add('error', 'APP_MISSING', 'Der Ordner "app" mit dem Programm fehlt.', 'Stick neu vorbereiten oder aktualisieren.');
    } else {
      // A few load-bearing files: their absence is exactly the "half copied"
      // state that otherwise only shows up as a confusing crash at startup.
      for (const rel of ['bin/neural-os.js', 'src/app.js', 'src/kernel/paths.js', 'web/index.html', 'package.json']) {
        if (!fs.existsSync(path.join(layout.app.path, rel))) {
          add('error', 'APP_INCOMPLETE', `Im Programmordner fehlt "${rel}" - die Kopie ist unvollständig.`,
            'Rufe "Stick aktualisieren" auf; dabei wird der Quelltext vollstaendig neu geschrieben.');
        }
      }
    }

    if (!layout.data.exists) {
      add('warn', 'DATA_MISSING', 'Der Datenordner fehlt.', 'Er wird beim nächsten Start automatisch angelegt.');
    }

    layout.runtimes = detectPlatforms(root);
    if (!layout.runtimes.length) {
      add('error', 'NO_RUNTIME', 'Auf dem Stick liegt keine einzige Laufzeitumgebung.',
        'Bereite den Stick erneut vor - dabei wird die Laufzeit dieses Rechners immer mitkopiert.');
    } else if (LOCAL_PLATFORM && !layout.runtimes.some((r) => r.platform === LOCAL_PLATFORM)) {
      add('warn', 'NO_LOCAL_RUNTIME',
        `Für dieses System (${LOCAL_PLATFORM}) liegt keine Laufzeit auf dem Stick; vorhanden sind: `
        + `${layout.runtimes.map((r) => r.platform).join(', ')}.`,
        'Auf diesem Rechner startet der Stick nur, wenn Node.js installiert ist. "Stick aktualisieren" auf diesem Rechner legt die passende Laufzeit an.');
    }

    for (const launcher of LAUNCHERS) {
      const file = path.join(root, launcher.target);
      const present = fs.existsSync(file);
      layout.launchers[launcher.target] = { path: file, exists: present };
      if (!present) {
        add('warn', 'LAUNCHER_MISSING', `Der Starter "${launcher.target}" fehlt.`,
          'Mit "Stick aktualisieren" wird er neu geschrieben.');
      }
    }

    const fsInfo = probeWrite ? probeFilesystem(root) : inspectFilesystem(root, modeWitnesses(root));
    if (!fsInfo.writable) {
      add('error', 'READ_ONLY', `Auf den Stick lässt sich nicht schreiben (${fsInfo.error || 'unbekannter Grund'}).`,
        'Schreibschutz-Schalter prüfen, oder der Stick ist nur lesend eingehängt. Ohne Schreibrecht kann Neural OS nichts speichern.');
    } else if (fsInfo.enforcesModes === false) {
      add('warn', 'NO_PERMISSIONS',
        `Das Dateisystem (${fsInfo.typeName}) kennt keine Zugriffsrechte - die Daten sind für jeden lesbar, der den Stick hat.`,
        'Schalte in den Einstellungen die Verschlüsselung ein.');
    } else if (fsInfo.enforcesModes === null && !fsInfo.probed && process.platform !== 'win32') {
      // Keine erfundene Entwarnung: ohne Zeugen und ohne Sonde ist die Frage
      // schlicht offen, und das steht hier statt eines stillen Häkchens.
      add('info', 'PERMISSIONS_UNKNOWN',
        'Ob dieses Dateisystem Zugriffsrechte durchsetzt, ist hier nicht zu sehen - die Prüfung schreibt nichts auf den Stick.',
        'Beim Vorbereiten oder Aktualisieren wird es geprüft und gemeldet; bis dahin gilt: auf einem Stick schützt nur Verschlüsselung.');
    }
    if (fsInfo.maxFileBytes !== null && fsInfo.maxFileBytes !== undefined && fsInfo.maxFileBytes < 4 * 1024 * 1024 * 1024) {
      add('warn', 'MAX_FILE_SIZE',
        `Auf ${fsInfo.typeName} kann keine Datei größer als 4 GB sein; größere KI-Modelle passen nicht darauf.`,
        'Für Modelle den Stick mit exFAT formatieren (Achtung: dabei gehen alle Daten verloren - vorher sichern).');
    }

    const free = freeBytes(root);
    if (free !== null && free < MIN_HEADROOM_BYTES) {
      add('warn', 'LOW_SPACE', `Auf dem Stick sind nur noch ${humanBytes(free)} frei.`,
        'Schaffe Platz, sonst kann Neural OS nichts mehr speichern.');
    }

    return {
      ok: !problems.some((p) => p.level === 'error'),
      problems,
      layout,
      freeBytes: free,
      filesystem: fsInfo,
    };
  }

  /**
   * Fetch one more runtime onto an existing stick.
   *
   * For the local platform this is a plain file copy and needs no network at
   * all -- the same guarantee `prepare()` gives.
   */
  async function addRuntime(targetDir, platform, opts = {}) {
    const root = requireTarget(targetDir, 'addRuntime()');
    requireStick(root, 'addRuntime()');
    if (!PLATFORMS[platform]) {
      throw new ValidationError(
        `"${platform}" ist keine bekannte Plattform. Möglich sind: ${Object.keys(PLATFORMS).join(', ')}.`,
      );
    }
    // Dieselbe Sperre wie prepare/update: addRuntime schreibt in dieselbe
    // Wurzel, und dropRuntimeScraps() raeumt dort nach denselben Regeln auf.
    const release = lockRoot(root, `Laufzeit ${platform} holen`);
    try {
      return await addRuntimeLocked(root, platform, opts);
    } finally {
      release();
    }
  }

  async function addRuntimeLocked(root, platform, opts) {
    const signal = opts.signal || null;
    throwIfAborted(signal, `Das Holen der Laufzeit ${platform}`);
    const progress = makeProgress(opts.onProgress, log);
    const warnings = [];
    mkdirp(path.join(root, LAYOUT.runtime));

    if (platform === LOCAL_PLATFORM) {
      progress({
        phase: 'runtime',
        message: `Laufzeit für ${platform} wird vom laufenden System kopiert …`,
        platform,
        percent: 0,
      });
      const copied = await copyLocalRuntime(root, warnings, signal);
      if (!copied) throw new StorageError('Die Laufzeit des laufenden Systems konnte nicht kopiert werden.');
      progress({ phase: 'done', message: `Laufzeit ${platform} liegt auf dem Stick.`, platform, percent: 100 });
      return { ...copied, warnings };
    }

    const got = await downloadRuntime(root, platform, progress, signal);
    progress({ phase: 'done', message: `Laufzeit ${platform} liegt auf dem Stick.`, platform, percent: 100 });
    return { ...got, warnings };
  }

  /**
   * Which runtimes are already on the stick?
   *
   * The version is read from the file written next to the binary rather than by
   * running it: a win-x64 binary cannot be executed on Linux, and a stick is
   * routinely inspected from a different operating system than the one the
   * runtime is for.
   */
  function detectPlatforms(targetDir) {
    let root;
    if (targetDir) {
      root = path.resolve(targetDir);
    } else {
      const detected = require('../kernel/paths').detectPortable();
      if (!detected) {
        throw new ValidationError(
          'detectPlatforms() braucht den Pfad zum Stick: diese Instanz läuft nicht von einem portablen Medium.',
        );
      }
      root = detected.root;
    }
    const dir = path.join(root, LAYOUT.runtime);
    const found = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const spec = PLATFORMS[entry.name];
      if (!spec) continue;
      const binary = path.join(dir, entry.name, spec.file);
      let stat;
      try { stat = fs.statSync(binary); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      let version = null;
      try { version = fs.readFileSync(path.join(dir, entry.name, 'node-version.txt'), 'utf8').trim() || null; } catch { /* optional */ }
      found.push({
        platform: entry.name,
        file: binary,
        bytes: stat.size,
        version,
        isLocal: entry.name === LOCAL_PLATFORM,
        executableBit: (stat.mode & 0o111) !== 0,
      });
    }
    found.sort((a, b) => (a.platform < b.platform ? -1 : 1));
    return found;
  }

  return {
    prepare,
    update,
    verify,
    addRuntime,
    /** Was WUERDE passieren -- dieselben Zahlen, ohne eine Zeile zu schreiben. */
    preview,
    detectPlatforms,
    probeFilesystem,
    /** Dieselben Fragen wie probeFilesystem(), ohne eine Zeile zu schreiben. */
    inspectFilesystem,
    LOCAL_PLATFORM,
    PLATFORMS,
    LAYOUT,
    /** Free bytes on the filesystem holding a path; null when unknown. */
    freeBytes,
  };
}

function appVersion(sourceRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    return pkg && pkg.version ? String(pkg.version) : 'unbekannt';
  } catch {
    return 'unbekannt';
  }
}

module.exports = {
  createStick,
  LOCAL_PLATFORM,
  PLATFORMS,
  LAYOUT,
  EXCLUDED_NAMES,
  LAUNCHERS,
  RUNTIME_SCOPE,
  DIST_HOST,
  probeFilesystem,
  inspectFilesystem,
  freeBytesOf,
  collectTree,
  cleanStale,
  nodeDistPlatform,
  humanBytes,
  /**
   * Fuer src/portable/model.js, das dieselbe Stick-Wurzel beschreibt.
   *
   * WARUM exportiert und nicht dort nachgebaut: jede dieser Funktionen traegt
   * eine Zusage, die oben im Kopf begruendet ist -- die Sperre je Wurzel
   * (sonst raeumen sich zwei Tabs die halbfertigen Ordner weg), das Kopieren
   * ueber den Thread-Pool (sonst steht der Server minutenlang), das
   * zweistufige Umbenennen (sonst gibt es halbe Ordner) und die Reparatur der
   * Reste. Ein zweites Kopierwerk daneben haette dieselben Zusagen ein
   * zweites Mal einhalten muessen -- und haette sie irgendwann nicht mehr.
   */
  lockRoot,
  runningOn,
  busyError,
  copyFiles,
  makeProgress,
  swapIntoPlace,
  mkdirp,
  writeFileAtomic,
  rmrfAsync,
  randomSuffix,
  throwIfAborted,
  abortedDuring,
  StickFullError,
  /** Die unantastbaren Ordner, als reine Funktion pruefbar. */
  geschuetzterOrdner,
  modelsDirOf,
  modelsUebersicht,
  MIN_HEADROOM_BYTES,
  // Exported for tests and for anything that needs to read an archive without
  // touching the network: both take a complete buffer and return one member.
  pickFromZip,
  pickFromTarGz,
};
