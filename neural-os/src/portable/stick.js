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
 *  4. `update()` NEVER TOUCHES THE DATA DIRECTORY. This is the single most
 *     important guarantee here, because the data directory is the user's
 *     thinking and the source tree is replaceable. It is enforced in code
 *     (`assertOutsideData`), not by convention, and proven by a test.
 *
 *  5. THE FILESYSTEM IS PROBED, NOT ASSUMED. Most sticks are exFAT or FAT32.
 *     `chmod 0600` silently does nothing there, so `0700` on the vault
 *     protects exactly nobody -- which makes vault encryption the only real
 *     protection and therefore something the user has to be told about. FAT32
 *     additionally cannot hold a file over 4 GB, and a language model usually
 *     is one.
 *
 * The one thing this module does NOT promise: that a runtime for a foreign
 * platform can always be fetched. That needs the network gate to allow
 * nodejs.org, and if it does not, that is a decision of the user's policy --
 * reported in plain German, not raised as a defect.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  ValidationError,
  StorageError,
  NotFoundError,
  NetworkBlockedError,
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

/** Directory and file names of the stick layout. Single source of truth. */
const LAYOUT = {
  marker: PORTABLE_MARKER,
  app: 'app',
  runtime: 'runtime',
  data: 'data',
  sync: 'sync',
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

/**
 * What can this filesystem actually do?
 *
 * The permission question cannot be answered by looking at a mount table --
 * it is answered by writing a file with mode 0600 and reading the mode back.
 * On FAT/exFAT the mode comes back as 0777 or 0666, which is precisely the
 * fact the user needs to hear before they trust the stick with a vault.
 *
 * @param {string} dir an existing directory
 * @returns {{writable:boolean, enforcesModes:boolean|null, type:number|null,
 *            typeName:string, maxFileBytes:number|null, error:string|null}}
 */
function probeFilesystem(dir) {
  const result = {
    writable: false,
    enforcesModes: null,
    type: null,
    typeName: 'unbekannt',
    maxFileBytes: null,
    error: null,
  };

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

function excludedBy(name, set) {
  if (set.has(name)) return true;
  return name.endsWith('.log');
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
function collectTree(root, { exclude = EXCLUDED_NAMES } = {}) {
  const files = [];
  const warnings = [];
  let bytes = 0;

  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (err) {
    throw new NotFoundError(`Der Quellordner ${root}`);
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
      if (excludedBy(entry.name, exclude)) continue;
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
 */
function copyFiles(files, dest, { onFile, label }) {
  let copied = 0;
  let bytes = 0;
  const madeDirs = new Set();

  for (const file of files) {
    const target = path.join(dest, file.rel);
    const dir = path.dirname(target);
    if (!madeDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    try {
      fs.copyFileSync(file.abs, target);
    } catch (err) {
      if (err && err.code === 'ENOSPC') {
        throw new StorageError(
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
    try { fs.chmodSync(target, file.mode & 0o111 ? 0o755 : 0o644); } catch { /* FAT */ }
    copied++;
    bytes += file.size;
    if (onFile && copied % 25 === 0) onFile({ copied, total: files.length, bytes, label });
  }
  if (onFile) onFile({ copied, total: files.length, bytes, label });
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
function swapIntoPlace(finalPath, tmpPath) {
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
  if (exists) rmrf(oldPath);
}

/** Names this module leaves behind while it works. */
const STALE_RE = /^\.([A-Za-z0-9._ -]+)\.(tmp|old)-[0-9a-f]{8}$/;

/**
 * Repair the traces of an interrupted copy.
 *
 * `.x.tmp-*` is always garbage -- nothing ever read from it. `.x.old-*` is the
 * previous, complete version: if `x` is missing, the stick was pulled between
 * the two renames and putting it back is a genuine recovery, not a guess.
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

${modeNote}
Mitgelieferte Laufzeiten
------------------------
${runtimeList}

Steht dein Betriebssystem nicht in der Liste, meldet der Starter das und sagt,
was fehlt. Nachlegen kannst du es in Neural OS unter Einstellungen -> Stick,
auf einem Rechner mit Internet. Alternativ genuegt ein installiertes Node.js
(Version 20 oder neuer) auf dem fremden Rechner.

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
   abgezogen. In Neural OS unter Einstellungen -> Stick auf "Stick pruefen"
   und danach "Stick aktualisieren" klicken.

Version: ${version}
Erstellt: ${new Date().toISOString().slice(0, 10)}
`;
}

/* ------------------------------------------------------- archive readers */

function archiveCorrupt(what, detail) {
  return new StorageError(
    `Das heruntergeladene Archiv (${what}) ist beschaedigt oder unvollstaendig (${detail}). Es wurde nichts auf den Stick geschrieben.`,
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
            throw new StorageError(`Die Datei im Archiv ist groesser als erlaubt (${humanBytes(maxBytes)}); der Vorgang wurde abgebrochen.`);
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
      if (!tarHeaderValid(block)) throw archiveCorrupt('tar', 'ungueltige Pruefsumme im Kopfsatz');

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
  if (buffer.length < 22) throw archiveCorrupt('zip', 'zu kurz fuer ein Archiv');
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
  if (p < 0 || p >= buffer.length) throw archiveCorrupt('zip', 'ungueltiger Verzeichnis-Zeiger');

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
      throw new StorageError(`Die Datei "${name}" im Archiv ist groesser als erlaubt (${humanBytes(maxBytes)}).`);
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw archiveCorrupt('zip', `Eintrag "${name}" hat keinen gueltigen Kopfsatz`);
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
      throw archiveCorrupt('zip', `Eintrag "${name}" liess sich nicht entpacken`);
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
      throw new ValidationError(`"${raw}" ist keine gueltige Node-Version (erwartet z. B. v22.11.0).`);
    }
    return v;
  }

  function requireTarget(targetDir, what) {
    if (typeof targetDir !== 'string' || !targetDir.trim()) {
      throw new ValidationError(`${what} braucht den Pfad zum Stick (z. B. /media/usb oder E:\\).`);
    }
    return path.resolve(targetDir);
  }

  function requireStick(root, what) {
    if (!fs.existsSync(root)) {
      throw new NotFoundError(`Der Ordner ${root}`);
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
   * goes through here, so "data is never touched" is a property of the code
   * and not of the author's attention.
   */
  function assertOutsideData(root, target) {
    const data = dataDirOf(root);
    if (isInside(data, target)) {
      throw new StorageError(
        `Abgebrochen: "${target}" liegt im Datenordner. Eine Aktualisierung darf den Datenbestand nie veraendern.`,
        { target, dataDir: data },
      );
    }
  }

  function warnFilesystem(fsInfo, warnings) {
    if (fsInfo.enforcesModes === false) {
      warnings.push(
        'Das Dateisystem dieses Sticks kennt keine Zugriffsrechte (typisch fuer exFAT und FAT32). '
        + 'Die Dateirechte 0600/0700 laufen dort ins Leere - sie schuetzen deine Daten hier NICHT. '
        + 'Schalte deshalb die Verschluesselung ein; sie ist auf einem Stick der einzige wirksame Schutz.',
      );
    } else if (fsInfo.enforcesModes === null && process.platform === 'win32') {
      warnings.push(
        'Unter Windows werden Unix-Dateirechte nicht abgebildet; der Schutz haengt an den Rechten des '
        + 'Laufwerks. Auf einem Stick heisst das praktisch: Verschluesselung einschalten.',
      );
    }
    if (fsInfo.maxFileBytes !== null && fsInfo.maxFileBytes !== undefined && fsInfo.maxFileBytes < 4 * 1024 * 1024 * 1024) {
      warnings.push(
        `Der Stick ist mit ${fsInfo.typeName} formatiert. Dort kann keine einzelne Datei groesser als 4 GB sein - `
        + 'ein groesseres KI-Modell passt also nicht darauf. Fuer Modelle brauchst du exFAT oder NTFS.',
      );
    } else if (fsInfo.enforcesModes === false && fsInfo.typeName === 'unbekannt') {
      warnings.push(
        'Der Typ des Dateisystems liess sich nicht bestimmen. Falls es FAT32 ist, passt keine Datei '
        + 'ueber 4 GB darauf - das betrifft groessere KI-Modelle.',
      );
    }
    if (fsInfo.error) {
      warnings.push(`Beim Pruefen des Dateisystems trat ein Fehler auf: ${fsInfo.error}`);
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
            `"${id}" ist keine bekannte Plattform. Moeglich sind: ${Object.keys(PLATFORMS).join(', ')}.`,
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

  function runtimeBinary(root, platform) {
    const spec = PLATFORMS[platform];
    return spec ? path.join(runtimeDir(root, platform), spec.file) : null;
  }

  /**
   * Copy the running interpreter onto the stick. No network, no download, no
   * conditions -- this is what makes the stick work on the next machine of the
   * same kind, and it is the only runtime we can guarantee.
   */
  function copyLocalRuntime(root, warnings) {
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
    const target = runtimeBinary(root, LOCAL_PLATFORM);
    const tmp = path.join(dir, `.${path.basename(target)}.tmp-${randomSuffix()}`);
    try {
      fs.copyFileSync(process.execPath, tmp);
    } catch (err) {
      rmrf(tmp);
      if (err && err.code === 'ENOSPC') {
        throw new StorageError(
          'Der Stick wurde beim Kopieren der Laufzeit voll. Die Laufzeit ist rund '
          + `${humanBytes(sizeOf(process.execPath))} gross. Schaffe Platz und versuche es erneut.`,
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
  function checkExecutable(binary) {
    try {
      const res = spawnSync(binary, ['-e', 'process.stdout.write(process.version)'], {
        timeout: 20000, encoding: 'utf8', windowsHide: true,
      });
      if (res.error) return { ok: false, reason: res.error.code || res.error.message };
      if (res.status !== 0) return { ok: false, reason: `Beendet mit Status ${res.status}` };
      return { ok: true, version: String(res.stdout || '').trim() };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  }

  /* ------------------------------------------------------------ download */

  /**
   * Everything that leaves this machine goes through here, so there is exactly
   * one place where the scope, the ceiling and the host list are set.
   */
  async function fetchFromDist(url, { purpose, maxBytes }) {
    if (!gate) {
      throw new ValidationError(
        'Ohne Netzschleuse kann keine zusaetzliche Laufzeit geholt werden. '
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
      + `Damit eine zusaetzliche Laufzeit geholt werden kann, brauchst du entweder den Netzmodus 'online' `
      + `mit ${DIST_HOST} auf der Freigabeliste, oder eine Freigabe fuer den Bereich '${RUNTIME_SCOPE}'. `
      + 'Das ist kein Fehler des Stick-Werkzeugs: Der Stick laeuft auch ohne die zusaetzlichen Laufzeiten '
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
  async function downloadRuntime(root, platform, onProgress) {
    const spec = PLATFORMS[platform];
    const version = nodeVersion();
    const ext = spec.archive === 'zip' ? 'zip' : 'tar.gz';
    const filename = `node-${version}-${platform}.${ext}`;
    const base = `${DIST_BASE}/${version}`;

    onProgress({ phase: 'laufzeit', message: `Pruefsummen fuer ${platform} werden geladen …`, platform });
    const sumsResponse = await fetchFromDist(`${base}/SHASUMS256.txt`, {
      purpose: `stick.runtime.checksums:${platform}`,
      maxBytes: MAX_SHASUMS_BYTES,
    });
    const sums = await sumsResponse.text();
    const expected = findShasum(sums, filename);
    if (!expected) {
      throw new StorageError(
        `In SHASUMS256.txt von nodejs.org gibt es keinen Eintrag fuer "${filename}". `
        + `Gibt es Node ${version} fuer ${platform} ueberhaupt? Es wurde nichts geschrieben.`,
        { filename, version, platform },
      );
    }

    onProgress({ phase: 'laufzeit', message: `Laufzeit fuer ${platform} wird geladen (${filename}) …`, platform });
    const archiveResponse = await fetchFromDist(`${base}/${filename}`, {
      purpose: `stick.runtime.download:${platform}`,
      maxBytes: MAX_ARCHIVE_BYTES,
    });
    const archive = Buffer.from(await archiveResponse.arrayBuffer());

    const actual = crypto.createHash('sha256').update(archive).digest('hex');
    if (actual !== expected) {
      throw new StorageError(
        `Die Pruefsumme von "${filename}" stimmt nicht mit der von nodejs.org veroeffentlichten ueberein. `
        + 'Die Datei wurde VERWORFEN und nichts auf den Stick geschrieben. Das kann an einer abgebrochenen '
        + 'Uebertragung liegen - oder daran, dass jemand unterwegs etwas ausgetauscht hat.',
        { filename, expected, actual },
      );
    }

    onProgress({ phase: 'laufzeit', message: `Laufzeit fuer ${platform} wird entpackt …`, platform });
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
    const target = runtimeBinary(root, platform);
    const tmp = path.join(dir, `.${spec.file}.tmp-${randomSuffix()}`);
    try {
      fs.writeFileSync(tmp, binary);
      try { fs.chmodSync(tmp, 0o755); } catch { /* FAT */ }
      fs.renameSync(tmp, target);
    } catch (err) {
      rmrf(tmp);
      if (err && err.code === 'ENOSPC') {
        throw new StorageError(
          `Der Stick hat nicht genug Platz fuer die Laufzeit ${platform} (${humanBytes(binary.length)}).`,
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
   *          sourceHome?:string, sourceRoot?:string, onProgress?:Function}} [opts]
   * @returns {Promise<{root:string, bytes:number, files:number, runtimes:object[], warnings:string[]}>}
   */
  async function prepare(targetDir, opts = {}) {
    const root = requireTarget(targetDir, 'prepare()');
    const sourceRoot = path.resolve(opts.sourceRoot || APP_ROOT);
    const progress = makeProgress(opts.onProgress, log);
    const warnings = [];

    if (!fs.existsSync(sourceRoot)) throw new NotFoundError(`Der Quelltext-Ordner ${sourceRoot}`);
    // Copying a tree into itself produces an ever-growing copy. Refuse early.
    if (isInside(sourceRoot, root)) {
      throw new ValidationError(
        `Der Stick-Ordner ${root} liegt im Quelltext-Ordner ${sourceRoot}. Waehle einen Ordner ausserhalb, `
        + 'sonst wuerde sich die Kopie endlos selbst kopieren.',
      );
    }
    if (isInside(root, sourceRoot)) {
      throw new ValidationError(`Der Quelltext liegt im Zielordner ${root}. Waehle einen anderen Zielordner.`);
    }

    const plan = resolvePlatforms(opts.includeRuntimes);
    if (!plan.local) {
      warnings.push(
        'Es wurde ausdruecklich keine Laufzeit mitkopiert. Der Stick laeuft dann nur auf Rechnern, '
        + 'auf denen Node.js (Version 20 oder neuer) bereits installiert ist.',
      );
    }

    progress({ phase: 'pruefen', message: 'Quelltext wird vermessen …' });
    const source = collectTree(sourceRoot);
    warnings.push(...source.warnings);

    let home = null;
    if (opts.includeVault) {
      const homeDir = opts.sourceHome || (appPaths && appPaths.home);
      if (!homeDir) {
        throw new ValidationError(
          'Fuer eine Sicherung des Datenbestands fehlt der Quellordner. Uebergib sourceHome, '
          + 'oder erzeuge das Werkzeug mit paths aus einer laufenden Instanz.',
        );
      }
      if (!fs.existsSync(homeDir)) throw new NotFoundError(`Der Datenordner ${homeDir}`);
      if (isInside(homeDir, root) || isInside(root, homeDir)) {
        throw new ValidationError(`Der Datenordner ${homeDir} und der Stick-Ordner ${root} duerfen nicht ineinander liegen.`);
      }
      home = collectTree(homeDir, { exclude: HOME_EXCLUDED_NAMES });
      warnings.push(...home.warnings);
    }

    // ---- the space check, before a single byte of content is written ----
    mkdirp(root);
    const localRuntimeBytes = plan.local && LOCAL_PLATFORM ? sizeOf(process.execPath) : 0;
    const required = source.bytes + localRuntimeBytes + (home ? home.bytes : 0)
      + plan.extra.length * ESTIMATED_RUNTIME_BYTES;
    const withHeadroom = required + Math.max(MIN_HEADROOM_BYTES, Math.round(required * 0.05));
    const free = freeBytes(root);
    if (free === null) {
      warnings.push('Der freie Platz auf dem Stick liess sich nicht ermitteln; der Vorgang laeuft ohne diese Pruefung.');
    } else if (free < withHeadroom) {
      throw new StorageError(
        `Auf dem Stick sind nur ${humanBytes(free)} frei, gebraucht werden mindestens ${humanBytes(withHeadroom)} `
        + `(Quelltext ${humanBytes(source.bytes)}`
        + (localRuntimeBytes ? `, Laufzeit ${humanBytes(localRuntimeBytes)}` : '')
        + (home ? `, Datenbestand ${humanBytes(home.bytes)}` : '')
        + (plan.extra.length ? `, ${plan.extra.length} weitere Laufzeit(en) geschaetzt ${humanBytes(plan.extra.length * ESTIMATED_RUNTIME_BYTES)}` : '')
        + '). Es wurde nichts geschrieben - ein halb kopierter Stick waere schlimmer als keiner. '
        + 'Schaffe Platz oder lass die zusaetzlichen Laufzeiten weg.',
        { free, required: withHeadroom },
      );
    }

    const fsInfo = probeFilesystem(root);
    if (!fsInfo.writable) {
      throw new StorageError(
        `In ${root} laesst sich nicht schreiben (${fsInfo.error || 'unbekannter Grund'}). `
        + 'Ist der Stick schreibgeschuetzt oder nur lesend eingehaengt?',
        { root, error: fsInfo.error },
      );
    }
    warnFilesystem(fsInfo, warnings);

    const recovered = cleanStale(root);
    if (recovered.restored.length) {
      warnings.push(`Ein frueher abgebrochener Kopiervorgang wurde repariert (wiederhergestellt: ${recovered.restored.join(', ')}).`);
    }

    // ---- source tree: build beside, then swap ----
    progress({ phase: 'quelltext', message: 'Quelltext wird kopiert …', total: source.files.length });
    const tmpApp = path.join(root, `.${LAYOUT.app}.tmp-${randomSuffix()}`);
    rmrf(tmpApp);
    mkdirp(tmpApp);
    let written;
    try {
      written = copyFiles(source.files, tmpApp, {
        label: 'quelltext',
        onFile: (p) => progress({ phase: 'quelltext', message: `Quelltext wird kopiert (${p.copied}/${p.total}) …`, ...p }),
      });
      swapIntoPlace(path.join(root, LAYOUT.app), tmpApp);
    } catch (err) {
      rmrf(tmpApp); // an interrupted copy leaves nothing behind
      throw err;
    }

    let totalBytes = written.bytes;
    let totalFiles = written.files;

    // ---- data and sync directories ----
    const dataDir = dataDirOf(root);
    mkdirp(dataDir, 0o700);
    mkdirp(path.join(root, LAYOUT.sync), 0o700);

    if (home) {
      const existing = fs.readdirSync(dataDir).filter((n) => !n.startsWith('.'));
      if (existing.length) {
        throw new StorageError(
          `In ${dataDir} liegt bereits ein Datenbestand. prepare() ueberschreibt niemals Daten. `
          + 'Nutze "Stick aktualisieren", um nur den Quelltext zu erneuern, oder waehle einen leeren Ordner.',
          { dataDir },
        );
      }
      progress({ phase: 'daten', message: 'Datenbestand wird auf den Stick kopiert …', total: home.files.length });
      const copiedHome = copyFiles(home.files, dataDir, {
        label: 'daten',
        onFile: (p) => progress({ phase: 'daten', message: `Datenbestand wird kopiert (${p.copied}/${p.total}) …`, ...p }),
      });
      totalBytes += copiedHome.bytes;
      totalFiles += copiedHome.files;
      if (fsInfo.enforcesModes === false) {
        warnings.push(
          'Der Datenbestand liegt jetzt auf einem Dateisystem ohne Zugriffsrechte. Falls die Sicherung '
          + 'unverschluesselt war, kann sie jeder lesen, der den Stick findet.',
        );
      }
    }

    // ---- runtimes ----
    const runtimes = [];
    if (plan.local) {
      progress({ phase: 'laufzeit', message: `Laufzeit fuer ${LOCAL_PLATFORM || 'dieses System'} wird kopiert …` });
      const localRuntime = copyLocalRuntime(root, warnings);
      if (localRuntime) {
        runtimes.push(localRuntime);
        totalBytes += localRuntime.bytes;
        totalFiles += 1;
        const check = checkExecutable(localRuntime.file);
        if (!check.ok) {
          warnings.push(
            `Die kopierte Laufzeit liess sich auf dem Stick nicht starten (${check.reason}). `
            + 'Haeufigster Grund: der Stick ist mit "noexec" eingehaengt. Auf einem anderen Rechner '
            + 'funktioniert sie in der Regel trotzdem; notfalls den Ordner auf die Festplatte kopieren.',
          );
        }
      }
    }

    for (const platform of plan.extra) {
      try {
        const got = await downloadRuntime(root, platform, progress);
        runtimes.push(got);
        totalBytes += got.bytes;
        totalFiles += 1;
      } catch (err) {
        // A missing extra runtime must never invalidate an otherwise good
        // stick. It is reported in full and the work continues.
        const message = err && err.message ? err.message : String(err);
        warnings.push(`Laufzeit fuer ${platform} wurde NICHT auf den Stick gelegt: ${message}`);
        log.warn(`Laufzeit ${platform} fehlgeschlagen: ${message}`);
      }
    }

    // ---- launchers, readme, marker ----
    progress({ phase: 'abschluss', message: 'Starter und Hinweise werden geschrieben …' });
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

    progress({ phase: 'fertig', message: 'Der Stick ist fertig.', bytes: totalBytes, files: totalFiles });
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
    const sourceRoot = path.resolve(opts.sourceRoot || APP_ROOT);
    const progress = makeProgress(opts.onProgress, log);
    const warnings = [];

    if (isInside(sourceRoot, root) || isInside(root, sourceRoot)) {
      throw new ValidationError(`Quelltext (${sourceRoot}) und Stick (${root}) duerfen nicht ineinander liegen.`);
    }

    const appDir = path.join(root, LAYOUT.app);
    assertOutsideData(root, appDir);

    progress({ phase: 'pruefen', message: 'Quelltext wird vermessen …' });
    const source = collectTree(sourceRoot);
    warnings.push(...source.warnings);

    const free = freeBytes(root);
    // The old app/ is only released after the new one is complete, so the
    // requirement is the full size once more, not the difference.
    const needed = source.bytes + MIN_HEADROOM_BYTES;
    if (free !== null && free < needed) {
      throw new StorageError(
        `Fuer die Aktualisierung werden ${humanBytes(needed)} frei gebraucht, vorhanden sind ${humanBytes(free)}. `
        + 'Es wurde nichts veraendert; der bisherige Stand auf dem Stick bleibt unberuehrt.',
        { free, required: needed },
      );
    }

    const fsInfo = probeFilesystem(root);
    if (!fsInfo.writable) {
      throw new StorageError(
        `In ${root} laesst sich nicht schreiben (${fsInfo.error || 'unbekannter Grund'}). Ist der Stick schreibgeschuetzt?`,
        { root },
      );
    }
    warnFilesystem(fsInfo, warnings);

    const recovered = cleanStale(root);
    if (recovered.restored.length) {
      warnings.push(`Ein frueher abgebrochener Kopiervorgang wurde repariert (wiederhergestellt: ${recovered.restored.join(', ')}).`);
    }

    progress({ phase: 'quelltext', message: 'Quelltext wird erneuert …', total: source.files.length });
    const tmpApp = path.join(root, `.${LAYOUT.app}.tmp-${randomSuffix()}`);
    assertOutsideData(root, tmpApp);
    rmrf(tmpApp);
    mkdirp(tmpApp);
    let written;
    try {
      written = copyFiles(source.files, tmpApp, {
        label: 'quelltext',
        onFile: (p) => progress({ phase: 'quelltext', message: `Quelltext wird erneuert (${p.copied}/${p.total}) …`, ...p }),
      });
      swapIntoPlace(appDir, tmpApp);
    } catch (err) {
      rmrf(tmpApp);
      throw err;
    }

    progress({ phase: 'abschluss', message: 'Starter und Hinweise werden erneuert …' });
    for (const launcher of LAUNCHERS) assertOutsideData(root, path.join(root, launcher.target));
    const launchers = deployLaunchers(root, sourceRoot);
    warnings.push(...launchers.warnings);

    const readme = path.join(root, LAYOUT.readme);
    assertOutsideData(root, readme);
    writeFileAtomic(readme, renderReadme({
      platforms: detectPlatforms(root).map((p) => p.platform),
      version: appVersion(sourceRoot),
      fsInfo,
    }));
    writeMarker(root, { nodeVersion: process.version });

    progress({ phase: 'fertig', message: 'Der Quelltext auf dem Stick ist aktuell.', bytes: written.bytes, files: written.files });
    return { root, bytes: written.bytes, files: written.files, warnings, dataDir: dataDirOf(root) };
  }

  /**
   * Is this stick in a state where a double-click will work?
   *
   * Everything reported is something the user can act on; each problem carries
   * a `fix` sentence, because "layout invalid" helps nobody standing in front
   * of a stick that will not start.
   */
  async function verify(targetDir) {
    const root = requireTarget(targetDir, 'verify()');
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
      readme: { path: path.join(root, LAYOUT.readme), exists: false },
      launchers: {},
      runtimes: [],
    };

    if (!exists) {
      add('error', 'NO_STICK', `Der Ordner ${root} existiert nicht.`, 'Stecke den Stick ein und waehle den richtigen Ordner.');
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
    layout.readme.exists = fs.existsSync(path.join(root, LAYOUT.readme));

    // An interrupted copy is the one failure mode a stick really has.
    const stale = [];
    try {
      for (const entry of fs.readdirSync(root)) if (STALE_RE.test(entry)) stale.push(entry);
    } catch { /* handled by the checks below */ }
    if (stale.length) {
      add(layout.app.exists ? 'warn' : 'error', 'INTERRUPTED_COPY',
        `Es liegen Reste eines abgebrochenen Kopiervorgangs auf dem Stick (${stale.join(', ')}).`,
        layout.app.exists
          ? 'Sie koennen geloescht werden; "Stick aktualisieren" raeumt sie automatisch auf.'
          : 'Der Ordner "app" fehlt dadurch. Rufe "Stick aktualisieren" auf - dabei wird der vorherige Stand wiederhergestellt.');
    }

    if (!layout.app.exists) {
      add('error', 'APP_MISSING', 'Der Ordner "app" mit dem Programm fehlt.', 'Stick neu vorbereiten oder aktualisieren.');
    } else {
      // A few load-bearing files: their absence is exactly the "half copied"
      // state that otherwise only shows up as a confusing crash at startup.
      for (const rel of ['bin/neural-os.js', 'src/app.js', 'src/kernel/paths.js', 'web/index.html', 'package.json']) {
        if (!fs.existsSync(path.join(layout.app.path, rel))) {
          add('error', 'APP_INCOMPLETE', `Im Programmordner fehlt "${rel}" - die Kopie ist unvollstaendig.`,
            'Rufe "Stick aktualisieren" auf; dabei wird der Quelltext vollstaendig neu geschrieben.');
        }
      }
    }

    if (!layout.data.exists) {
      add('warn', 'DATA_MISSING', 'Der Datenordner fehlt.', 'Er wird beim naechsten Start automatisch angelegt.');
    }

    layout.runtimes = detectPlatforms(root);
    if (!layout.runtimes.length) {
      add('error', 'NO_RUNTIME', 'Auf dem Stick liegt keine einzige Laufzeitumgebung.',
        'Bereite den Stick erneut vor - dabei wird die Laufzeit dieses Rechners immer mitkopiert.');
    } else if (LOCAL_PLATFORM && !layout.runtimes.some((r) => r.platform === LOCAL_PLATFORM)) {
      add('warn', 'NO_LOCAL_RUNTIME',
        `Fuer dieses System (${LOCAL_PLATFORM}) liegt keine Laufzeit auf dem Stick; vorhanden sind: `
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

    const fsInfo = probeFilesystem(root);
    if (!fsInfo.writable) {
      add('error', 'READ_ONLY', `Auf den Stick laesst sich nicht schreiben (${fsInfo.error || 'unbekannter Grund'}).`,
        'Schreibschutz-Schalter pruefen, oder der Stick ist nur lesend eingehaengt. Ohne Schreibrecht kann Neural OS nichts speichern.');
    } else if (fsInfo.enforcesModes === false) {
      add('warn', 'NO_PERMISSIONS',
        `Das Dateisystem (${fsInfo.typeName}) kennt keine Zugriffsrechte - die Daten sind fuer jeden lesbar, der den Stick hat.`,
        'Schalte in den Einstellungen die Verschluesselung ein.');
    }
    if (fsInfo.maxFileBytes !== null && fsInfo.maxFileBytes !== undefined && fsInfo.maxFileBytes < 4 * 1024 * 1024 * 1024) {
      add('warn', 'MAX_FILE_SIZE',
        `Auf ${fsInfo.typeName} kann keine Datei groesser als 4 GB sein; groessere KI-Modelle passen nicht darauf.`,
        'Fuer Modelle den Stick mit exFAT formatieren (Achtung: dabei gehen alle Daten verloren - vorher sichern).');
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
        `"${platform}" ist keine bekannte Plattform. Moeglich sind: ${Object.keys(PLATFORMS).join(', ')}.`,
      );
    }
    const progress = makeProgress(opts.onProgress, log);
    const warnings = [];
    mkdirp(path.join(root, LAYOUT.runtime));

    if (platform === LOCAL_PLATFORM) {
      progress({ phase: 'laufzeit', message: `Laufzeit fuer ${platform} wird vom laufenden System kopiert …`, platform });
      const copied = copyLocalRuntime(root, warnings);
      if (!copied) throw new StorageError('Die Laufzeit des laufenden Systems konnte nicht kopiert werden.');
      return { ...copied, warnings };
    }

    const got = await downloadRuntime(root, platform, progress);
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
          'detectPlatforms() braucht den Pfad zum Stick: diese Instanz laeuft nicht von einem portablen Medium.',
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
    detectPlatforms,
    probeFilesystem,
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
  freeBytesOf,
  collectTree,
  cleanStale,
  nodeDistPlatform,
  humanBytes,
  // Exported for tests and for anything that needs to read an archive without
  // touching the network: both take a complete buffer and return one member.
  pickFromZip,
  pickFromTarGz,
};
