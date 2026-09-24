'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Filesystem layout for a Neural OS installation.
 *
 * Everything the app owns lives under ONE directory (the "home"). That is a
 * deliberate privacy property: the user can see, back up, encrypt or delete
 * their entire digital environment by touching a single folder. Nothing is
 * written to OS-wide caches, temp dirs or anywhere outside this tree.
 *
 * Resolution order for the home directory:
 *   1. explicit argument (CLI --home)
 *   2. a portable marker next to the application (USB stick)
 *   3. NEURAL_OS_HOME environment variable
 *   4. ~/.neural-os
 *
 * Der Stick steht vor NEURAL_OS_HOME (Bauplan 2.6): Ältere Starter setzten die
 * Variable, und eine, die auf einem fremden Laptop noch in der Umgebung steht,
 * darf die KI dieses Sticks nicht auf die Platte umleiten. Wer wirklich
 * woanders hin will, sagt `--home`.
 *
 * @param {string} [explicit]
 * @param {{von?:string, env?:object}} [opts] `von`: wo das Programm liegt
 *   (Vorgabe: dieser Programmordner); `env`: die Umgebung (Vorgabe: process.env).
 *   Beides nur, damit Tests einen Temp-Stick einspielen können.
 */
function resolveHome(explicit, opts = {}) {
  return homeHerkunft(explicit, opts).home;
}

/**
 * Wie `resolveHome`, sagt aber auch, woher der Ordner kommt, und ob dabei
 * NEURAL_OS_HOME übergangen wurde; das meldet der Start in einer Zeile.
 * @returns {{home:string, quelle:'ausdruecklich'|'stick'|'umgebung'|'standard', uebergangen:string|null}}
 */
function homeHerkunft(explicit, { von, env = process.env } = {}) {
  if (explicit) return { home: path.resolve(explicit), quelle: 'ausdruecklich', uebergangen: null };
  const ausUmgebung = env && env.NEURAL_OS_HOME ? path.resolve(env.NEURAL_OS_HOME) : null;
  const portable = detectPortable(von);
  if (portable) {
    const uebergangen = ausUmgebung && !gleicherPfad(ausUmgebung, portable.dataDir) ? ausUmgebung : null;
    return { home: portable.dataDir, quelle: 'stick', uebergangen };
  }
  if (ausUmgebung) return { home: ausUmgebung, quelle: 'umgebung', uebergangen: null };
  return { home: path.resolve(path.join(os.homedir(), '.neural-os')), quelle: 'standard', uebergangen: null };
}

/**
 * Zeigen zwei Pfade auf denselben Ordner? Über `path.relative`, damit ein
 * Schrägstrich am Ende oder `a/../b` nichts ausmacht. Windows und macOS
 * unterscheiden in Dateinamen nicht zwischen Groß und Klein (NTFS, FAT/exFAT
 * und APFS in der Grundeinstellung): `e:\data` und `E:\data` sind derselbe
 * Ordner, und ein Stick, der dort nicht erkannt wird, liefe mit Port 7777 und
 * ohne Kennung im Marker.
 * @param {{pfad?:object, plattform?:string}} [opts] `pfad`: path-Modul
 *   (Tests spielen `path.win32` ein); `plattform`: wie `process.platform`.
 */
function gleicherPfad(a, b, { pfad = path, plattform } = {}) {
  const system = plattform || (pfad === path.win32 ? 'win32' : process.platform);
  let x = pfad.resolve(String(a));
  let y = pfad.resolve(String(b));
  if (system === 'win32' || system === 'darwin') {
    x = x.toLowerCase();
    y = y.toLowerCase();
  }
  return pfad.relative(x, y) === '';
}

/** Filename of the marker that turns a directory into a portable installation. */
const PORTABLE_MARKER = 'neural-os.portable';

/**
 * Is this copy running from a portable medium (a USB stick)?
 *
 * Detection walks up from the application directory looking for a marker file.
 * Two deliberate constraints:
 *
 *  - The marker must be valid JSON containing `neuralOsPortable: true`. A stray
 *    empty file with the right name cannot silently redirect where somebody's
 *    notes are written; that would be a data-loss trap disguised as a feature.
 *  - The search is bounded to a few levels. Walking to the filesystem root
 *    would mean a forgotten marker in a home directory could capture every
 *    installation below it.
 *
 * The result is always announced at startup. A mode that quietly changes where
 * your data lives is exactly the kind of surprise this project exists to avoid.
 *
 * @param {string} [from] directory to start from (default: the app directory)
 * @returns {{root:string, dataDir:string, marker:string, info:object}|null}
 */
function detectPortable(from) {
  let dir = path.resolve(from || path.join(__dirname, '..', '..'));
  for (let depth = 0; depth < 4; depth++) {
    const marker = path.join(dir, PORTABLE_MARKER);
    let raw = null;
    try {
      raw = fs.readFileSync(marker, 'utf8');
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      continue;
    }
    let info;
    try {
      info = JSON.parse(raw);
    } catch {
      // A corrupt marker is reported by refusing to act on it: falling back to
      // the home directory is recoverable, writing to a guessed path is not.
      return null;
    }
    if (!info || info.neuralOsPortable !== true) return null;
    const dataDir = path.resolve(dir, typeof info.dataDir === 'string' && info.dataDir ? info.dataDir : 'data');
    return { root: dir, dataDir, marker, info };
  }
  return null;
}

/**
 * Is the home directory we ended up with the portable one?
 * Used by the startup banner, which must state where the data actually is.
 *
 * @param {string} home
 * @param {{von?:string, gefunden?:object|null, pfad?:object, plattform?:string}} [opts]
 *   `von` wie bei `detectPortable`; `gefunden` ersetzt die Suche (Tests);
 *   `pfad`/`plattform` wie bei `gleicherPfad`.
 */
function portableInfo(home, { von, gefunden, pfad, plattform } = {}) {
  const detected = gefunden !== undefined ? gefunden : detectPortable(von);
  if (!detected) return null;
  if (!gleicherPfad(home, detected.dataDir, { pfad, plattform })) return null;
  return detected;
}

/**
 * Der portable Betrieb, in einer Form, die ueber HTTP gehen kann.
 *
 * `detectPortable()` gibt die rohe Markierungsdatei zurueck; davon geht hier
 * nur weiter, was jemand vor dem Bildschirm auch gebrauchen kann: von wo
 * gestartet wurde, wo die Daten liegen, wann der Stick angelegt und zuletzt
 * angefasst wurde. `null` heisst "dieser Prozess laeuft von der Platte" -- und
 * das ist die Auskunft, die der Browser bisher ueberhaupt nicht bekam.
 */
function describePortable(portable) {
  if (!portable) return null;
  const info = portable.info || {};
  return {
    root: portable.root,
    dataDir: portable.dataDir,
    marker: portable.marker,
    createdAt: info.createdAt || null,
    updatedAt: info.updatedAt || null,
    preparedBy: info.preparedBy || null,
    nodeVersion: info.nodeVersion || null,
  };
}

/**
 * @param {string} [explicitHome]
 * @param {{von?:string, env?:object}} [opts] wie bei `resolveHome`
 * @returns {{
 *   home:string, config:string, vault:string, log:string, snapshot:string,
 *   files:string, audit:string, runs:string, exports:string, lock:string,
 *   secrets:string, trash:string
 * }}
 */
function layout(explicitHome, opts = {}) {
  const home = resolveHome(explicitHome, opts);
  const vault = path.join(home, 'vault');
  return {
    home,
    // Plain JSON, never encrypted: the app must be able to read its own
    // network policy before it can ask for a passphrase.
    config: path.join(home, 'config.json'),
    vault,
    log: path.join(vault, 'log'), // append-only operation log segments
    snapshot: path.join(vault, 'snapshot.json'), // periodic materialised state
    files: path.join(vault, 'files'), // content-addressed blobs
    audit: path.join(home, 'audit.jsonl'), // network + permission decisions
    runs: path.join(home, 'runs'), // agent run transcripts
    exports: path.join(home, 'exports'),
    trash: path.join(home, 'trash'),
    lock: path.join(home, '.lock'),
    secrets: path.join(home, 'secrets.json'), // key material wrapper, 0600
  };
}

/** Create every directory the layout needs. Idempotent. */
function ensureLayout(paths) {
  for (const dir of [paths.home, paths.vault, paths.log, paths.files, paths.runs, paths.exports, paths.trash]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Tighten the top-level directory even if it already existed.
  try {
    fs.chmodSync(paths.home, 0o700);
  } catch {
    /* best effort: some filesystems (exFAT, network mounts) ignore modes */
  }
  return paths;
}

/**
 * Guard against path traversal for any user-supplied relative path.
 * Returns the resolved absolute path, or throws if it escapes `root`.
 */
function safeJoin(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (target !== resolvedRoot && !target.startsWith(withSep)) {
    const err = new Error(`Path escapes its root: ${relative}`);
    err.code = 'EPATHESCAPE';
    throw err;
  }
  return target;
}

module.exports = {
  resolveHome, homeHerkunft, gleicherPfad, layout, ensureLayout, safeJoin,
  detectPortable, portableInfo, describePortable, PORTABLE_MARKER,
};
