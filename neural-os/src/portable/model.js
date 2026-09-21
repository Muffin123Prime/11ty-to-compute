'use strict';

/**
 * Das Modell mit auf den Stick nehmen -- Gewichte UND Laufzeitkern.
 *
 * Das Problem, das dieses Modul loest
 * -----------------------------------
 * Bisher reiste das WISSEN mit und das MODELL nicht. Auf einem fremden Rechner
 * standen die Notizen da, aber es kam keine Antwort: ein Sprachmodell gehoert
 * einem Anbieter auf dem eigenen Rechner (Ollama, llama.cpp, LM Studio), nicht
 * Neural OS. Wer den Stick irgendwo hineinsteckt, will aber genau das: "da ist
 * diese KI, weil sie auf dem Stick ist."
 *
 * Damit das wahr wird, muessen ZWEI Dinge mitreisen:
 *   1. die Gewichte (die grosse Datei, plattformunabhaengig), und
 *   2. der Laufzeitkern, der sie oeffnet -- ein Programm, und Programme sind an
 *      ein Betriebssystem UND eine Prozessorarchitektur gebunden. Ein
 *      llama-server.exe startet auf einem Mac nicht, und keine Dateikopie der
 *      Welt aendert daran etwas. Deshalb sagt `aufDemStick()` diesen Satz
 *      ausdruecklich, statt ihn zu verschweigen.
 *
 * Die Zusagen, die hier eingehalten werden
 * ----------------------------------------
 *  1. NICHTS WIRD GERATEN. `finden()` liest Ollamas Manifeste und rechnet die
 *     Summe der Blobs EINES Modells aus. Der Ollama-Speicher ist
 *     inhaltsadressiert: `manifests/...` verweist auf `blobs/sha256-*`, und
 *     mehrere Modelle teilen sich Blobs. Wer stattdessen den Ordner misst,
 *     kopiert 40 GB, wo 2 GB gemeint waren -- auf einen Stick, der 32 GB hat.
 *
 *  2. VOR DEM ERSTEN BYTE STEHT DER PLAN. `planen()` schreibt nichts und
 *     nennt jedes Hindernis mit Code und deutschem Satz. Das wahrscheinlichste
 *     ist FAT32: dort passt keine Datei ueber 4 GB, und ein Modell IST meist
 *     eine einzige Datei ueber 4 GB. Der Satz dazu muss sagen, was hilft --
 *     und dass Neuformatieren alles loescht.
 *
 *  3. DIE ZUSAGEN VON stick.js GELTEN WEITER. Nicht blockierend (fsp.copyFile
 *     ueber den Thread-Pool), abbrechbar (AbortSignal), atomar (versteckter
 *     Nachbarordner, dann umbenennen) und unter derselben Sperre je
 *     Stick-Wurzel. Deshalb wird hier nichts davon nachgebaut, sondern genau
 *     dasselbe benutzt: `copyFiles`, `swapIntoPlace`, `lockRoot`, `cleanStale`.
 *
 *  4. WAS SCHON AUF DEM STICK LIEGT, IST HEILIG. Ein zweites Modell kommt
 *     DANEBEN, nicht statt des ersten. Deshalb wird models/ beim zweiten Mal
 *     NICHT als ganzer Ordner getauscht: das haette die Gigabyte vom ersten Mal
 *     ein zweites Mal ueber den USB-Anschluss geschoben. Siehe `einsetzen()` --
 *     dort steht auch, warum die Reihenfolge (erst Nutzlast, dann Zeiger)
 *     genau die Eigenschaft rettet, auf die es ankommt.
 *
 *  5. KEIN ERFUNDENER ERFOLG. Ist kein Modell da, ist das ein Befund mit einem
 *     deutschen Satz, kein Fehler -- und niemals eine Antwort, die es nicht
 *     gibt. Dieses Modul kopiert Dateien; es redet nie an der Stelle eines
 *     Modells.
 *
 * Was dieses Modul NICHT tut: herunterladen. Es bringt auf den Stick, was auf
 * DIESEM Rechner schon liegt. Ein Modell aus dem Netz zu holen ist eine Sache
 * des Anbieters (ollama pull) und der Netz-Richtlinie, nicht dieser Datei.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  ValidationError,
  StorageError,
  PermissionError,
  NotFoundError,
} = require('../kernel/errors');

const {
  LAYOUT,
  LAUNCHERS,
  nodeDistPlatform,
  humanBytes,
  inspectFilesystem,
  freeBytesOf,
  collectTree,
  cleanStale,
  lockRoot,
  runningOn,
  busyError,
  copyFiles,
  swapIntoPlace,
  makeProgress,
  mkdirp,
  writeFileAtomic,
  rmrfAsync,
  randomSuffix,
  throwIfAborted,
  abortedDuring,
  StickFullError,
  modelsDirOf,
  MIN_HEADROOM_BYTES,
} = require('./stick');

/* ------------------------------------------------------------- Konstanten */

/** Arten, die dieses Modul kennt. Mehr gibt es nicht -- Raten waere schlimmer. */
const ART = {
  ollama: 'ollama',
  llamaCpp: 'llama.cpp',
  gguf: 'gguf',
};

/** Version der Beschreibungsdatei. Ein spaeterer Leser darf sie pruefen. */
const BESCHREIBUNG_VERSION = 1;

/** Grenze einer einzelnen Datei auf FAT16/FAT32. */
const FAT_DATEIGRENZE = 4 * 1024 * 1024 * 1024 - 1;

/**
 * Bis hierher wird eine Pruefsumme von selbst gerechnet.
 *
 * WARUM eine Grenze: eine Pruefsumme kostet einen vollstaendigen Lesevorgang.
 * Bei 200 MB sind das Sekunden, bei 40 GB ueber einen USB-2-Anschluss eine
 * halbe Stunde -- nach dem Kopieren noch einmal so lange. Wer sie trotzdem
 * will, verlangt sie ausdruecklich (`pruefsummen: 'alle'`); wo sie fehlt,
 * steht der Grund in der Beschreibungsdatei statt eines stillen `null`.
 */
const PRUEFSUMME_GRENZE_BYTES = 256 * 1024 * 1024;

/** Sicherung gegen Symlink-Schleifen und absurd tiefe Baeume beim Suchen. */
const MAX_TIEFE = 6;
/** Sicherung gegen einen versehentlich uebergebenen Heimatordner mit 2 Mio. Dateien. */
const MAX_EINTRAEGE = 50000;

/** Ein Ollama-Digest, so wie er im Manifest steht. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** Mehrteilige GGUF-Dateien: "modell-00002-of-00004.gguf". */
const TEIL_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

/**
 * Geraete, auf denen ein Laufzeitkern vom Stick grundsaetzlich nicht startet.
 *
 * WARUM diese Tabelle existiert: der Besitzer dieses Sticks benutzt Neural OS
 * auch auf einem iPad. Dort gibt es keine Moeglichkeit, ein Programm von einem
 * Stick auszufuehren -- das ist keine fehlende Datei und kein Fehler dieses
 * Moduls, sondern eine Eigenschaft des Geraets. Sie zu verschweigen waere der
 * unehrlichste Fall ueberhaupt: die Oberflaeche zeigte einen gruenen Haken und
 * es kaeme trotzdem keine Antwort.
 */
const GERAETE = {
  ios: { name: 'iPhone/iPad (iOS/iPadOS)', kannProgrammeStarten: false },
  ipados: { name: 'iPad (iPadOS)', kannProgrammeStarten: false },
  ipad: { name: 'iPad (iPadOS)', kannProgrammeStarten: false },
  iphone: { name: 'iPhone (iOS)', kannProgrammeStarten: false },
  android: { name: 'Android-Geraet', kannProgrammeStarten: false },
};

/* ------------------------------------------------------- kleine Werkzeuge */

/**
 * Die Plattformkennung dieses Rechners -- dasselbe Vokabular wie `runtime/`
 * auf dem Stick ('linux-x64', 'win-x64', 'darwin-arm64'), damit nicht zwei
 * Namen fuer dieselbe Sache herumliegen. Exotische Systeme bekommen ihren
 * rohen Namen statt eines erfundenen.
 */
function plattformId(plattform = process.platform, arch = process.arch) {
  return nodeDistPlatform(plattform, arch) || `${plattform}-${arch}`;
}

function einmalig(liste) {
  return [...new Set(liste.filter(Boolean))];
}

function kurzHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

function statSicher(datei) {
  try { return fs.statSync(datei); } catch { return null; }
}

/** Dateiname ohne Pfadtrenner und ohne Ueberraschungen fuer FAT/exFAT. */
function sicherName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'modell';
}

/**
 * Ist diese Datei ausfuehrbar?
 *
 * Unter Windows gibt es kein Ausfuehrbar-Bit; dort entscheidet die Endung.
 * Anderswo entscheidet der Modus -- und genau dieses Bit geht auf FAT/exFAT
 * verloren, weshalb `planen()` davor warnt.
 */
function istAusfuehrbar(datei, aufOs = process.platform) {
  const st = statSicher(datei);
  if (!st || !st.isFile()) return false;
  if (aufOs === 'win32') return /\.(exe|cmd|bat|com)$/i.test(datei);
  return (st.mode & 0o111) !== 0;
}

/**
 * Dateien unter `wurzel` suchen, mit harter Obergrenze.
 *
 * Ordner-Verknuepfungen werden uebersprungen (Schleifengefahr), Datei-
 * Verknuepfungen aufgeloest -- dieselbe Regel wie in stick.js collectTree().
 */
function dateienSuchen(wurzel, { passt, tiefe = MAX_TIEFE, maxEintraege = MAX_EINTRAEGE } = {}) {
  const treffer = [];
  let gesehen = 0;
  let abgeschnitten = false;

  const gehe = (dir, rel, ebene) => {
    if (ebene > tiefe || abgeschnitten) return;
    let eintraege;
    try {
      eintraege = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unlesbar: kein Fund, kein Fehler
    }
    for (const eintrag of eintraege) {
      if (abgeschnitten) return;
      if (++gesehen > maxEintraege) { abgeschnitten = true; return; }
      const abs = path.join(dir, eintrag.name);
      const kindRel = rel ? `${rel}/${eintrag.name}` : eintrag.name;
      if (eintrag.isSymbolicLink()) {
        const st = statSicher(abs);
        if (!st || st.isDirectory()) continue;
      } else if (eintrag.isDirectory()) {
        gehe(abs, kindRel, ebene + 1);
        continue;
      } else if (!eintrag.isFile()) {
        continue;
      }
      if (passt && !passt(eintrag.name, kindRel)) continue;
      const st = statSicher(abs);
      if (!st || !st.isFile()) continue;
      treffer.push({ abs, rel: kindRel, bytes: st.size, mode: st.mode & 0o777 });
    }
  };

  gehe(wurzel, '', 0);
  return { treffer, abgeschnitten };
}

/* ------------------------------------------------- Orte auf diesem Rechner */

function pfadOrte(env, namen) {
  const roh = env.PATH || env.Path || env.path || '';
  const orte = [];
  for (const teil of String(roh).split(path.delimiter)) {
    if (!teil) continue;
    for (const name of namen) orte.push(path.join(teil, name));
  }
  return orte;
}

/** Wo ein installiertes Ollama liegen kann. Reihenfolge = Wahrscheinlichkeit. */
function ollamaProgrammOrte(env, home, aufOs) {
  const namen = aufOs === 'win32' ? ['ollama.exe'] : ['ollama'];
  const orte = pfadOrte(env, namen);
  if (aufOs === 'win32') {
    const lokal = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : null);
    if (lokal) orte.push(path.join(lokal, 'Programs', 'Ollama', 'ollama.exe'));
    if (env.ProgramFiles) orte.push(path.join(env.ProgramFiles, 'Ollama', 'ollama.exe'));
  } else if (aufOs === 'darwin') {
    // Im App-Bundle liegt das eigentliche Programm unter Resources; die Datei
    // unter MacOS/ startet die Oberflaeche, nicht den Server.
    orte.push('/Applications/Ollama.app/Contents/Resources/ollama');
    orte.push('/usr/local/bin/ollama', '/opt/homebrew/bin/ollama');
  } else {
    orte.push('/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/ollama/bin/ollama');
  }
  if (home) orte.push(path.join(home, '.local', 'bin', namen[0]));
  return einmalig(orte);
}

/** Wo ein llama.cpp-Server liegen kann. */
function llamaProgrammOrte(env, home, aufOs) {
  const namen = aufOs === 'win32' ? ['llama-server.exe'] : ['llama-server'];
  const orte = pfadOrte(env, namen);
  if (aufOs === 'darwin') orte.push('/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server');
  else if (aufOs !== 'win32') orte.push('/usr/local/bin/llama-server', '/usr/bin/llama-server');
  if (home) {
    orte.push(path.join(home, '.local', 'bin', namen[0]));
    orte.push(path.join(home, 'llama.cpp', namen[0]));
    orte.push(path.join(home, 'llama.cpp', 'build', 'bin', namen[0]));
  }
  return einmalig(orte);
}

/**
 * Ollamas Modellspeicher. OLLAMA_MODELS gewinnt -- wer die Variable setzt, hat
 * seine Modelle bewusst woanders hingelegt, oft auf eine zweite Platte.
 */
function ollamaSpeicherOrte(env, home, aufOs) {
  const orte = [];
  if (env.OLLAMA_MODELS) orte.push(env.OLLAMA_MODELS);
  if (aufOs === 'win32' && env.USERPROFILE) orte.push(path.join(env.USERPROFILE, '.ollama', 'models'));
  if (home) orte.push(path.join(home, '.ollama', 'models'));
  return einmalig(orte);
}

/** Wo GGUF-Dateien liegen: LM Studio, llama.cpp, und der uebliche Handablageort. */
function ggufOrte(env, home) {
  if (!home) return [];
  return einmalig([
    path.join(home, '.lmstudio', 'models'),
    path.join(home, '.cache', 'lm-studio', 'models'),
    path.join(home, '.cache', 'llama.cpp'),
    path.join(home, 'models'),
  ]);
}

/* ------------------------------------------------------ Ollama-Manifestleser */

/**
 * Aus dem Pfad eines Manifests wird der Name, den Ollama selbst benutzt:
 * `manifests/registry.ollama.ai/library/llama3/8b` -> `llama3:8b`.
 * Ein fremder Namensraum bleibt sichtbar (`meineorg/modell:tag`), sonst
 * verwechselt jemand zwei verschiedene Modelle mit gleichem Namen.
 */
function ollamaModellname(rel) {
  const teile = String(rel).split('/').filter(Boolean);
  if (teile.length < 2) return teile.join('/') || 'unbenannt';
  const tag = teile[teile.length - 1];
  const modell = teile[teile.length - 2];
  const namensraum = teile.length >= 3 ? teile[teile.length - 3] : null;
  if (!namensraum || namensraum === 'library') return `${modell}:${tag}`;
  return `${namensraum}/${modell}:${tag}`;
}

/**
 * Alle Modelle EINES Ollama-Speichers, mit der Summe ihrer eigenen Blobs.
 *
 * Das ist der Kern dieses Moduls: der Speicher ist inhaltsadressiert, mehrere
 * Modelle teilen sich Schichten, und die Groesse eines Modells steht nirgends
 * als Zahl. Sie ergibt sich erst aus dem Manifest -- und nur aus den Blobs,
 * die DIESES Manifest nennt.
 */
function ollamaModelleLesen(speicher) {
  const manifestWurzel = path.join(speicher, 'manifests');
  const blobOrdner = path.join(speicher, 'blobs');
  const funde = [];
  const hinweise = [];

  if (!fs.existsSync(manifestWurzel)) return { funde, hinweise };

  const { treffer, abgeschnitten } = dateienSuchen(manifestWurzel, { tiefe: MAX_TIEFE });
  if (abgeschnitten) {
    hinweise.push(`Der Ollama-Speicher ${speicher} enthaelt aussergewoehnlich viele Dateien; es wurde nur ein Teil gelesen.`);
  }

  for (const datei of treffer) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(datei.abs, 'utf8'));
    } catch {
      continue; // kein Manifest, sondern irgendeine Datei -- kein Grund zur Klage
    }
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.layers)) continue;

    const digests = einmalig([
      manifest.config && manifest.config.digest,
      ...manifest.layers.map((l) => l && l.digest),
    ].filter((d) => typeof d === 'string' && DIGEST_RE.test(d)));

    const dateien = [];
    const fehlend = [];
    let bytes = 0;
    for (const digest of digests) {
      const rel = `blobs/${digest.replace(':', '-')}`;
      const abs = path.join(blobOrdner, digest.replace(':', '-'));
      const st = statSicher(abs);
      if (!st || !st.isFile()) { fehlend.push(digest); continue; }
      bytes += st.size;
      dateien.push({ abs, rel, bytes: st.size, mode: st.mode & 0o777, art: 'blob', digest });
    }
    // Das Manifest kommt ZULETZT in die Liste, und das ist kein Zufall: es ist
    // der Zeiger auf die Blobs. Wird mittendrin abgebrochen, liegen Blobs ohne
    // Zeiger da (verschwendeter Platz), nie ein Zeiger ohne Blobs (ein Modell,
    // das es zu geben scheint und beim ersten Satz zerbricht).
    dateien.push({
      abs: datei.abs,
      rel: `manifests/${datei.rel}`,
      bytes: datei.bytes,
      mode: datei.mode,
      art: 'manifest',
    });

    const name = ollamaModellname(datei.rel);
    funde.push({
      id: `ollama:${name}`,
      art: ART.ollama,
      rolle: 'modell',
      name,
      pfad: datei.abs,
      bytes,
      plattform: null,
      ausfuehrbar: false,
      dateien,
      vollstaendig: fehlend.length === 0,
      hinweis: fehlend.length
        ? `Zu "${name}" fehlen ${fehlend.length} von ${digests.length} Blobs im Speicher; das Modell ist dort unvollstaendig.`
        : null,
      speicher,
    });
  }

  funde.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { funde, hinweise };
}

/* ----------------------------------------------------------- GGUF-Modelle */

/**
 * GGUF-Dateien eines Ordners zu Modellen zusammenfassen.
 *
 * Mehrteilige Modelle ("...-00001-of-00003.gguf") gehoeren ZUSAMMEN. Wer nur
 * Teil 1 mitnimmt, hat auf dem fremden Rechner eine 4-GB-Datei, die kein
 * Programm oeffnen kann -- und merkt es dort.
 */
function ggufModelleLesen(ordner, quelle) {
  const funde = [];
  const hinweise = [];
  if (!fs.existsSync(ordner)) return { funde, hinweise };

  const { treffer, abgeschnitten } = dateienSuchen(ordner, {
    passt: (name) => /\.gguf$/i.test(name),
  });
  if (abgeschnitten) hinweise.push(`In ${ordner} liegen sehr viele Dateien; es wurde nur ein Teil durchsucht.`);

  const gruppen = new Map();
  for (const datei of treffer) {
    const dir = path.dirname(datei.abs);
    const basis = path.basename(datei.abs).replace(TEIL_RE, '.gguf');
    const schluessel = `${dir}::${basis}`;
    if (!gruppen.has(schluessel)) gruppen.set(schluessel, { dir, basis, dateien: [] });
    gruppen.get(schluessel).dateien.push(datei);
  }

  for (const gruppe of gruppen.values()) {
    gruppe.dateien.sort((a, b) => (a.abs < b.abs ? -1 : 1));
    const bytes = gruppe.dateien.reduce((summe, d) => summe + d.bytes, 0);
    const name = gruppe.basis.replace(/\.gguf$/i, '');
    const teile = gruppe.dateien.length;
    // Ein mehrteiliges Modell sagt im Namen, wie viele Teile es haben MUSS.
    const erwartet = (() => {
      const m = TEIL_RE.exec(path.basename(gruppe.dateien[0].abs));
      return m ? Number(m[2]) : 1;
    })();
    funde.push({
      id: `gguf:${sicherName(name)}@${kurzHash(gruppe.dir)}`,
      art: ART.gguf,
      rolle: 'modell',
      name: gruppe.basis,
      pfad: gruppe.dateien[0].abs,
      bytes,
      plattform: null,
      ausfuehrbar: false,
      dateien: gruppe.dateien.map((d) => ({
        abs: d.abs,
        rel: path.basename(d.abs),
        bytes: d.bytes,
        mode: d.mode,
        art: 'gewichte',
      })),
      vollstaendig: teile >= erwartet,
      hinweis: teile < erwartet
        ? `Von "${gruppe.basis}" liegen nur ${teile} von ${erwartet} Teilen hier; unvollstaendig ist es auf dem Stick wertlos.`
        : null,
      quelle,
      ordner: gruppe.dir,
    });
  }

  funde.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { funde, hinweise };
}

/* =========================================================== das Werkzeug */

/**
 * @param {{logger?:*, env?:object, home?:string, plattform?:{os:string,arch:string},
 *          freeBytes?:Function, dateisystem?:Function, jetzt?:Function}} [deps]
 */
function createPortableModels(deps = {}) {
  const log = typeof deps.logger === 'function' ? deps.logger('modell-stick') : (deps.logger || null);
  const env = deps.env || process.env;
  const home = deps.home === undefined ? os.homedir() : deps.home;
  const aufOs = (deps.plattform && deps.plattform.os) || process.platform;
  const aufArch = (deps.plattform && deps.plattform.arch) || process.arch;
  const dieserRechner = plattformId(aufOs, aufArch);
  const freeBytes = typeof deps.freeBytes === 'function' ? deps.freeBytes : freeBytesOf;
  // Einspeisbar, weil die entscheidende Eigenschaft eines Sticks (FAT32 kann
  // keine 4-GB-Datei) auf keinem Entwicklungsrechner vorkommt. Ohne diese Naht
  // waere die wichtigste Warnung dieses Moduls ungeprueft.
  const dateisystem = typeof deps.dateisystem === 'function' ? deps.dateisystem : inspectFilesystem;
  const jetzt = typeof deps.jetzt === 'function' ? deps.jetzt : () => new Date();

  function melde(stufe, text) {
    if (log && typeof log[stufe] === 'function') log[stufe](text);
  }

  function wurzelVon(ziel, was) {
    if (typeof ziel !== 'string' || !ziel.trim()) {
      throw new ValidationError(`${was} braucht den Pfad zum Stick (z. B. /media/usb oder E:\\).`);
    }
    const wurzel = path.resolve(ziel);
    const st = statSicher(wurzel);
    if (st && !st.isDirectory()) {
      throw new ValidationError(`${wurzel} ist eine Datei, kein Ordner. Gib den Ordner des Sticks an.`);
    }
    return wurzel;
  }

  /* ------------------------------------------------------------- finden() */

  /**
   * Was liegt auf DIESEM Rechner an Modellen und Laufzeitkernen?
   *
   * Findet sich nichts, ist das ein Befund und kein Fehler: `gefunden: false`
   * plus ein deutscher Satz, was zu tun waere. Eine Ausnahme zu werfen waere
   * hier falsch -- "kein Modell installiert" ist der Normalzustand eines
   * frisch aufgesetzten Rechners.
   */
  function finden(opts = {}) {
    const hinweise = [];
    const kerne = [];
    const modelle = [];
    const speicherOrte = [];

    // ---- Laufzeitkerne ----
    for (const ort of ollamaProgrammOrte(env, home, aufOs)) {
      const st = statSicher(ort);
      if (!st || !st.isFile()) continue;
      kerne.push({
        id: `kern:${ART.ollama}`,
        art: ART.ollama,
        rolle: 'kern',
        name: path.basename(ort),
        pfad: ort,
        bytes: st.size,
        plattform: dieserRechner,
        ausfuehrbar: istAusfuehrbar(ort, aufOs),
        dateien: [{ abs: ort, rel: path.basename(ort), bytes: st.size, mode: st.mode & 0o777, art: 'programm' }],
        vollstaendig: true,
        hinweis: null,
      });
      break; // der erste Treffer ist der, den auch die Kommandozeile benutzt
    }
    for (const ort of llamaProgrammOrte(env, home, aufOs)) {
      const st = statSicher(ort);
      if (!st || !st.isFile()) continue;
      kerne.push({
        id: `kern:${ART.llamaCpp}`,
        art: ART.llamaCpp,
        rolle: 'kern',
        name: path.basename(ort),
        pfad: ort,
        bytes: st.size,
        plattform: dieserRechner,
        ausfuehrbar: istAusfuehrbar(ort, aufOs),
        dateien: [{ abs: ort, rel: path.basename(ort), bytes: st.size, mode: st.mode & 0o777, art: 'programm' }],
        vollstaendig: true,
        hinweis: null,
      });
      break;
    }

    // ---- Ollama-Speicher ----
    for (const speicher of ollamaSpeicherOrte(env, home, aufOs)) {
      if (!fs.existsSync(speicher)) continue;
      speicherOrte.push({ art: ART.ollama, pfad: speicher });
      const gelesen = ollamaModelleLesen(speicher);
      modelle.push(...gelesen.funde);
      hinweise.push(...gelesen.hinweise);
    }

    // ---- GGUF-Dateien (llama.cpp, LM Studio, Handablage) ----
    const ggufSuchorte = einmalig([...ggufOrte(env, home), ...(opts.zusaetzlicheOrte || [])]);
    for (const ordner of ggufSuchorte) {
      if (!fs.existsSync(ordner)) continue;
      speicherOrte.push({ art: ART.gguf, pfad: ordner });
      const gelesen = ggufModelleLesen(ordner, ordner);
      modelle.push(...gelesen.funde);
      hinweise.push(...gelesen.hinweise);
    }

    // ---- ehrliche Saetze zum Befund ----
    if (!kerne.length && !modelle.length) {
      hinweise.push(
        'Auf diesem Rechner ist kein lokales Modell und kein Laufzeitkern zu finden. Zum Mitnehmen '
        + 'braucht es beides: installiere z. B. Ollama (ollama.com) und hole ein Modell mit '
        + '"ollama pull llama3" - danach kann dieser Rechner es auf den Stick legen.',
      );
    } else if (!kerne.length) {
      hinweise.push(
        `Es liegen ${modelle.length} Modell(e) hier, aber kein Laufzeitkern (ollama oder llama-server). `
        + 'Ohne ihn kann ein fremder Rechner die Dateien nicht oeffnen - mitnehmen lohnt sich nur zusammen.',
      );
    } else if (!modelle.length) {
      hinweise.push(
        'Ein Laufzeitkern ist da, aber kein Modell. Hole eines (z. B. "ollama pull llama3") - '
        + 'der Kern allein beantwortet keine Frage.',
      );
    }
    for (const fund of [...modelle, ...kerne]) {
      if (fund.hinweis) hinweise.push(fund.hinweis);
    }
    const ohneBit = kerne.filter((k) => !k.ausfuehrbar);
    for (const kern of ohneBit) {
      hinweise.push(
        `"${kern.pfad}" traegt kein Ausfuehrbar-Bit. Auf dem Stick wird es dadurch nicht besser; `
        + 'auf dem Zielrechner muss es dann von Hand gesetzt werden (chmod +x).',
      );
    }

    return {
      rechner: { plattform: dieserRechner, os: aufOs, arch: aufArch },
      gefunden: kerne.length > 0 || modelle.length > 0,
      kerne,
      modelle,
      speicher: speicherOrte,
      bytes: modelle.reduce((s, m) => s + m.bytes, 0) + kerne.reduce((s, k) => s + k.bytes, 0),
      hinweise,
    };
  }

  /* --------------------------------------------------- Auswahl und Ziele */

  function alleFunde(befund) {
    return [...befund.kerne, ...befund.modelle];
  }

  /**
   * Die Auswahl aufloesen -- Kennungen oder ganze Funde sind beides erlaubt.
   * Eine unbekannte Kennung wird NICHT stillschweigend uebergangen: sie waere
   * sonst ein Modell, das der Benutzer erwartet und das nie ankommt.
   */
  function auswahlAufloesen(befund, auswahl) {
    const alle = alleFunde(befund);
    const nachId = new Map(alle.map((f) => [f.id, f]));
    const gewaehlt = [];
    const unbekannt = [];
    for (const eintrag of Array.isArray(auswahl) ? auswahl : []) {
      if (eintrag && typeof eintrag === 'object' && Array.isArray(eintrag.dateien)) {
        gewaehlt.push(eintrag);
        continue;
      }
      const id = String(eintrag);
      if (nachId.has(id)) gewaehlt.push(nachId.get(id));
      else unbekannt.push(id);
    }
    return { gewaehlt: einmalig(gewaehlt), unbekannt };
  }

  /**
   * Der Platz einer Datei auf dem Stick, relativ zu models/.
   *
   * Die Ollama-Ordnung bleibt erhalten (blobs/ + manifests/), damit ein
   * mitgenommenes Ollama den Stick direkt als Speicher benutzen kann:
   * OLLAMA_MODELS=<Stick>/models/ollama. Nachbauen muesste man sie sonst
   * beim Zurueckspielen -- und wer das von Hand macht, macht es falsch.
   */
  function zielFuer(fund, datei) {
    if (fund.art === ART.ollama && fund.rolle === 'modell') return `ollama/${datei.rel}`;
    if (fund.rolle === 'kern') return `kern/${fund.plattform || dieserRechner}/${datei.rel}`;
    // Ein eigener Ordner je GGUF-Modell: mehrteilige Modelle bleiben zusammen,
    // und zwei gleichnamige Dateien aus zwei Ordnern ueberschreiben sich nicht.
    return `gguf/${sicherName(fund.name.replace(/\.gguf$/i, ''))}/${datei.rel}`;
  }

  /** Inhaltsadressiert: der Name IST die Pruefsumme. Nur solche Dateien duerfen uebersprungen werden. */
  function istBlob(zielRel) {
    return /^ollama\/blobs\/sha256-[0-9a-f]{64}$/.test(zielRel);
  }

  /**
   * Zeugen fuer die Rechtefrage -- Dateien, deren Modus JEMAND ABSICHTLICH
   * gesetzt hat.
   *
   * WARUM ueberhaupt: `inspectFilesystem()` schreibt nichts (eine Vorschau
   * darf keine Datei anlegen) und kann die Frage "setzt dieses Dateisystem
   * Rechte durch" deshalb nur an vorhandenen Dateien beantworten. Kommt der
   * gesetzte Modus unveraendert zurueck, setzt es sie durch; kommt 0777/0666
   * zurueck, hat es sie verworfen (exFAT, FAT32) -- und genau dann startet der
   * Laufzeitkern auf dem Zielrechner eventuell nicht. Ohne Zeugen bleibt die
   * Antwort null (= unbekannt), und es wird nichts behauptet.
   */
  function zeugen(wurzel) {
    const liste = LAUNCHERS.map((l) => ({
      path: path.join(wurzel, l.target),
      mode: l.executable ? 0o755 : 0o644,
    }));
    // Der beste Zeuge ist ein frueher kopierter Laufzeitkern: den hat dieses
    // Modul selbst mit 0755 geschrieben.
    const kernWurzel = path.join(modelsDirOf(wurzel), 'kern');
    try {
      for (const plattform of fs.readdirSync(kernWurzel)) {
        for (const name of fs.readdirSync(path.join(kernWurzel, plattform))) {
          liste.push({ path: path.join(kernWurzel, plattform, name), mode: 0o755 });
        }
      }
    } catch { /* noch kein Kern auf dem Stick */ }
    return liste;
  }

  /* ------------------------------------------------------------- planen() */

  /**
   * Was WUERDE passieren? Schreibt nichts -- kein mkdir, keine Sonde.
   *
   * Jedes Hindernis traegt `schwere`: 'stopp' laesst `kopieren()` gar nicht
   * erst anfangen, 'warnung' ist etwas, das der Benutzer wissen muss und
   * trotzdem tun darf.
   */
  function planen(opts = {}) {
    const wurzel = wurzelVon(opts.ziel, 'planen()');
    const befund = opts.befund || finden(opts);
    const { gewaehlt, unbekannt } = auswahlAufloesen(befund, opts.auswahl);

    const hindernisse = [];
    const hinweise = [];
    const stopp = (code, satz, details) => hindernisse.push({ code, schwere: 'stopp', satz, details: details || null });
    const warnung = (code, satz, details) => hindernisse.push({ code, schwere: 'warnung', satz, details: details || null });

    for (const id of unbekannt) {
      stopp('UNBEKANNTE_AUSWAHL',
        `"${id}" ist auf diesem Rechner nicht (mehr) zu finden. Sieh noch einmal nach, was da ist.`,
        { id });
    }
    if (!gewaehlt.length) {
      stopp('NICHTS_AUSGEWAEHLT',
        'Es ist nichts ausgewaehlt. Waehle ein Modell und den passenden Laufzeitkern - beides zusammen, '
        + 'sonst liegen auf dem Stick Dateien, die dort niemand oeffnen kann.');
    }

    const stickDa = fs.existsSync(wurzel);
    if (!stickDa) {
      stopp('ZIEL_FEHLT',
        `Den Ordner ${wurzel} gibt es nicht. Steckt der Stick noch, und stimmt der Pfad?`,
        { wurzel });
    }
    if (stickDa && !fs.existsSync(path.join(wurzel, LAYOUT.marker))) {
      hinweise.push(
        `In ${wurzel} liegt noch kein vorbereiteter Neural-OS-Stick. Die Modelle landen trotzdem dort, `
        + 'aber ohne "Stick vorbereiten" startet dort kein Programm, das sie benutzt.',
      );
    }

    // Ein laufender Vorgang ist das einzige Hindernis, das man dem Stick nicht
    // ansieht. kopieren() haelt die Sperre selbst und prueft deshalb nicht.
    if (opts.sperrePruefen !== false) {
      const laeuft = runningOn(wurzel);
      if (laeuft) stopp('VORGANG_LAEUFT', busyError(wurzel, laeuft).message, { laeuft: laeuft.what });
    }

    // ---- die Dateiliste, genau die, die kopiert wuerde ----
    const modelsDir = modelsDirOf(wurzel);
    const dateien = [];
    const uebersprungen = [];
    // Zwei Modelle desselben Anbieters teilen sich Schichten. Ohne diese Menge
    // stuende derselbe Blob zweimal im Plan: doppelt gezaehlt (der Stick gilt
    // als zu klein, obwohl es passt) und zweimal ueber den USB-Anschluss
    // geschoben.
    const schonGeplant = new Set();
    let groesste = null;
    for (const fund of gewaehlt) {
      if (fund.vollstaendig === false && fund.hinweis) warnung('QUELLE_UNVOLLSTAENDIG', fund.hinweis, { id: fund.id });
      for (const datei of fund.dateien) {
        const st = statSicher(datei.abs);
        if (!st || !st.isFile()) {
          stopp('QUELLE_FEHLT',
            `Die Datei "${datei.abs}" gibt es nicht mehr. Wurde das Modell inzwischen geloescht?`,
            { id: fund.id, pfad: datei.abs });
          continue;
        }
        const zielRel = zielFuer(fund, datei);
        if (schonGeplant.has(zielRel)) {
          uebersprungen.push({ ziel: zielRel, bytes: st.size, fund: fund.id, grund: 'gehoert zu mehreren ausgewaehlten Modellen und wird nur einmal kopiert' });
          continue;
        }
        const vorhanden = statSicher(path.join(modelsDir, zielRel));
        // Nur inhaltsadressierte Dateien duerfen uebersprungen werden: dort ist
        // gleicher Name + gleiche Groesse tatsaechlich gleicher Inhalt. Bei
        // allem anderen waere das eine Annahme, und eine falsche Annahme
        // kostet hier ein stummes, halb altes Modell.
        if (vorhanden && vorhanden.isFile() && vorhanden.size === st.size && istBlob(zielRel)) {
          uebersprungen.push({ ziel: zielRel, bytes: st.size, fund: fund.id, grund: 'liegt schon identisch auf dem Stick' });
          continue;
        }
        const eintrag = { rel: zielRel, abs: datei.abs, size: st.size, mode: st.mode & 0o777, fund: fund.id, art: datei.art };
        schonGeplant.add(zielRel);
        dateien.push(eintrag);
        if (!groesste || st.size > groesste.bytes) groesste = { ziel: zielRel, bytes: st.size, quelle: datei.abs };
      }
    }

    const bytes = dateien.reduce((summe, d) => summe + d.size, 0);
    // 1 %, nicht 5 % wie beim Quelltext: Modelle SIND der Stick. Fuenf Prozent
    // von 8 GB waeren 400 MB Ablehnung fuer nichts.
    const kopfraum = Math.max(MIN_HEADROOM_BYTES, Math.round(bytes * 0.01));
    const bytesMitKopfraum = bytes + kopfraum;

    // ---- Dateisystem, ohne eine Zeile zu schreiben ----
    const fsInfo = stickDa ? dateisystem(wurzel, zeugen(wurzel)) : null;
    if (fsInfo && !fsInfo.writable) {
      stopp('KEIN_SCHREIBRECHT',
        `In ${wurzel} laesst sich nicht schreiben (${fsInfo.error || 'unbekannter Grund'}). `
        + 'Ist der Stick schreibgeschuetzt oder nur lesend eingehaengt?',
        { wurzel });
    }

    const grenze = fsInfo && Number.isFinite(fsInfo.maxFileBytes) ? fsInfo.maxFileBytes : null;
    if (grenze !== null && groesste && groesste.bytes > grenze) {
      stopp('DATEI_ZU_GROSS',
        `Der Stick ist mit ${fsInfo.typeName} formatiert und kann keine einzelne Datei ueber `
        + `${humanBytes(grenze)} aufnehmen. "${path.basename(groesste.ziel)}" ist aber ${humanBytes(groesste.bytes)} gross. `
        + 'Ein Sprachmodell ist fast immer genau so eine einzelne grosse Datei. Was hilft: den Stick mit exFAT '
        + '(laeuft auf Windows, macOS und Linux) oder NTFS (Windows) formatieren. ACHTUNG: Beim Formatieren '
        + 'werden ALLE Daten auf dem Stick geloescht - sichere ihn vorher, auch den Ordner "data".',
        { grenze, bytes: groesste.bytes, datei: groesste.ziel, dateisystem: fsInfo.typeName });
    } else if (grenze === null && fsInfo && fsInfo.enforcesModes === false && groesste && groesste.bytes > FAT_DATEIGRENZE) {
      // Kein erfundener Befund: der Typ liess sich nicht bestimmen, aber ein
      // Dateisystem ohne Rechte auf einem Stick ist meist FAT32 oder exFAT --
      // und bei FAT32 scheitert genau diese Datei.
      warnung('DATEI_ZU_GROSS_VIELLEICHT',
        `Der Typ des Dateisystems liess sich nicht bestimmen. Ist es FAT32, passt "${path.basename(groesste.ziel)}" `
        + `(${humanBytes(groesste.bytes)}) nicht darauf - dort ist bei ${humanBytes(FAT_DATEIGRENZE)} je Datei Schluss. `
        + 'exFAT und NTFS haben diese Grenze nicht.',
        { bytes: groesste.bytes });
    }

    const kerneInAuswahl = gewaehlt.filter((f) => f.rolle === 'kern');
    if (fsInfo && fsInfo.enforcesModes === false && kerneInAuswahl.length) {
      warnung('KEIN_AUSFUEHRBAR_BIT',
        'Dieses Dateisystem kennt keine Zugriffsrechte (typisch fuer exFAT und FAT32). Das Ausfuehrbar-Bit des '
        + 'Laufzeitkerns geht dabei verloren; auf Linux und macOS startet er dann eventuell nicht. '
        + 'Abhilfe auf dem Zielrechner: chmod +x auf die Datei in models/kern/, oder den Ordner auf die Festplatte kopieren.',
        { dateisystem: fsInfo.typeName });
    }

    const frei = stickDa ? freeBytes(wurzel) : null;
    let passt = null;
    if (frei === null) {
      if (stickDa) hinweise.push('Der freie Platz liess sich hier nicht ermitteln; der Vorgang laeuft dann ohne diese Pruefung.');
    } else {
      passt = frei >= bytesMitKopfraum;
      if (!passt) {
        stopp('ZU_WENIG_PLATZ',
          `Auf dem Stick sind ${humanBytes(frei)} frei, gebraucht werden ${humanBytes(bytesMitKopfraum)} `
          + `(${dateien.length} Datei(en), ${humanBytes(bytes)} plus etwas Luft). Es wird nichts geschrieben - `
          + 'ein halb kopiertes Modell sieht fertig aus und zerbricht beim ersten Satz. Schaffe Platz oder waehle weniger aus.',
          { frei, gebraucht: bytesMitKopfraum });
      }
    }

    if (gewaehlt.length && !kerneInAuswahl.length && gewaehlt.some((f) => f.rolle === 'modell')) {
      warnung('KEIN_KERN_AUSGEWAEHLT',
        'Es ist kein Laufzeitkern ausgewaehlt. Das Modell reist dann mit, aber auf einem fremden Rechner '
        + 'oeffnet es nur, wer dort selbst Ollama oder llama.cpp installiert hat.');
    }
    for (const kern of kerneInAuswahl) {
      if (kern.plattform && kern.plattform !== dieserRechner) continue;
      hinweise.push(
        `Der Laufzeitkern "${kern.name}" ist fuer ${kern.plattform || dieserRechner} gebaut. Auf einem Rechner `
        + 'mit anderem Betriebssystem oder anderer Prozessorarchitektur startet er nicht - dort hilft nur ein '
        + 'Kern fuer jenes System.',
      );
    }
    if (uebersprungen.length) {
      hinweise.push(
        `${uebersprungen.length} Datei(en) werden nicht noch einmal kopiert `
        + `(${humanBytes(uebersprungen.reduce((s, u) => s + u.bytes, 0))}): sie liegen schon identisch auf dem Stick `
        + 'oder gehoeren zu mehreren der ausgewaehlten Modelle.',
      );
    }

    return {
      ziel: wurzel,
      ordner: modelsDir,
      stickVorbereitet: stickDa && fs.existsSync(path.join(wurzel, LAYOUT.marker)),
      auswahl: gewaehlt.map((f) => ({
        id: f.id, art: f.art, rolle: f.rolle, name: f.name,
        bytes: f.bytes, dateien: f.dateien.length, plattform: f.plattform || null,
      })),
      dateien,
      anzahl: dateien.length,
      bytes,
      kopfraum,
      bytesMitKopfraum,
      uebersprungen,
      bytesUebersprungen: uebersprungen.reduce((s, u) => s + u.bytes, 0),
      groessteDatei: groesste,
      frei,
      passt,
      dateisystem: fsInfo,
      vorhanden: aufDemStick(wurzel),
      hindernisse,
      hinweise,
      kannLosgehen: !hindernisse.some((h) => h.schwere === 'stopp'),
      zusammenfassung: zusammenfassen(gewaehlt, bytes, dateien.length),
    };
  }

  function zusammenfassen(gewaehlt, bytes, anzahl) {
    if (!gewaehlt.length) return 'Nichts ausgewaehlt.';
    const modelle = gewaehlt.filter((f) => f.rolle === 'modell').map((f) => f.name);
    const kerne = gewaehlt.filter((f) => f.rolle === 'kern').map((f) => f.name);
    const teile = [];
    if (modelle.length) teile.push(`${modelle.length} Modell(e) (${modelle.join(', ')})`);
    if (kerne.length) teile.push(`Laufzeitkern ${kerne.join(', ')} fuer ${dieserRechner}`);
    return `${teile.join(' und ')} - ${anzahl} Datei(en), ${humanBytes(bytes)}.`;
  }

  /** Aus einem Stopp-Hindernis wird der Fehler, den die Oberflaeche schon kennt. */
  function hindernisAlsFehler(h) {
    if (h.code === 'ZU_WENIG_PLATZ') return new StickFullError(h.satz, h.details);
    if (h.code === 'KEIN_SCHREIBRECHT') return new PermissionError(h.satz, h.details);
    if (h.code === 'ZIEL_FEHLT' || h.code === 'QUELLE_FEHLT') {
      const err = new NotFoundError(h.satz);
      err.message = h.satz;
      err.details = h.details;
      return err;
    }
    if (h.code === 'NICHTS_AUSGEWAEHLT' || h.code === 'UNBEKANNTE_AUSWAHL') return new ValidationError(h.satz, h.details);
    return new StorageError(h.satz, h.details);
  }

  /* ----------------------------------------------------------- kopieren() */

  /**
   * Das Modell auf den Stick legen.
   *
   * Reihenfolge und Begruendung stehen bei `einsetzen()`. Alles, was hier
   * geschrieben wird, landet zuerst in einem versteckten Nachbarordner der
   * Stick-Wurzel (`.models.tmp-XXXX`) -- denselben Namen raeumt cleanStale()
   * nach einem Abbruch weg, und dieselbe Sperre schuetzt ihn vor einem
   * zweiten Browsertab.
   */
  async function kopieren(ziel, opts = {}) {
    const wurzel = wurzelVon(ziel, 'kopieren()');
    const release = lockRoot(wurzel, 'Modell auf den Stick kopieren');
    try {
      return await kopierenGesperrt(wurzel, opts);
    } finally {
      release();
    }
  }

  async function kopierenGesperrt(wurzel, opts) {
    const signal = opts.signal || null;
    const was = 'Das Kopieren des Modells';
    const fortschritt = makeProgress(opts.onProgress, log);
    throwIfAborted(signal, was);

    fortschritt({ phase: 'pruefen', message: 'Es wird geprueft, was kopiert werden muss …', percent: 0 });
    // sperrePruefen: false -- die Sperre halten WIR gerade.
    const plan = planen({ ...opts, ziel: wurzel, sperrePruefen: false });
    const stopper = plan.hindernisse.find((h) => h.schwere === 'stopp');
    if (stopper) throw hindernisAlsFehler(stopper);

    const warnungen = plan.hindernisse.filter((h) => h.schwere === 'warnung').map((h) => h.satz);
    warnungen.push(...plan.hinweise);

    if (!plan.dateien.length) {
      // Kein erfundener Erfolg, aber auch kein Fehler: es liegt schon alles da.
      // Die Beschreibung wird trotzdem geschrieben -- sie kann fehlen (geloescht,
      // oder von Hand kopiert), und genau dann ist sie am wichtigsten.
      const eintraege = beschreibungSchreiben(wurzel, plan, new Map());
      fortschritt({ phase: 'fertig', message: 'Es lag bereits alles auf dem Stick.', percent: 100 });
      return {
        ziel: wurzel,
        ordner: plan.ordner,
        kopiert: { dateien: 0, bytes: 0 },
        uebersprungen: plan.uebersprungen.length,
        bytesUebersprungen: plan.bytesUebersprungen,
        eintraege,
        beschreibung: path.join(plan.ordner, LAYOUT.modelsIndex),
        warnungen,
      };
    }

    const reste = cleanStale(wurzel);
    if (reste.restored.length) {
      warnungen.push(`Ein frueher abgebrochener Vorgang wurde repariert (wiederhergestellt: ${reste.restored.join(', ')}).`);
    }

    const tmp = path.join(wurzel, `.${LAYOUT.models}.tmp-${randomSuffix()}`);
    await rmrfAsync(tmp);
    mkdirp(tmp);

    let geschrieben;
    try {
      fortschritt({
        phase: 'kopieren',
        message: `${plan.anzahl} Datei(en), ${humanBytes(plan.bytes)} werden kopiert …`,
        total: plan.anzahl,
        totalBytes: plan.bytes,
        percent: 0,
      });
      geschrieben = await copyFiles(plan.dateien, tmp, {
        label: 'models',
        signal,
        what: was,
        onFile: (p) => fortschritt({
          phase: 'kopieren',
          message: `Modell wird kopiert (${p.copied}/${p.total}, ${p.percent} %) …`,
          ...p,
        }),
      });

      // Pruefsummen auf der KOPIE, nicht auf der Quelle: die Frage ist, ob das
      // angekommen ist, was losgeschickt wurde. Ein Stick, der still Bits
      // verdreht, faellt nur so auf.
      const summen = await pruefsummen(plan.dateien, tmp, {
        modus: opts.pruefsummen || 'auto',
        signal,
        fortschritt,
      });

      fortschritt({ phase: 'einsetzen', message: 'Das Kopierte wird an seinen Platz gelegt …', percent: 99 });
      await einsetzen(wurzel, tmp, plan.dateien, signal);

      const eintraege = beschreibungSchreiben(wurzel, plan, summen);
      fortschritt({
        phase: 'fertig',
        message: `Fertig: ${geschrieben.files} Datei(en), ${humanBytes(geschrieben.bytes)} liegen jetzt auf dem Stick.`,
        percent: 100,
        bytes: geschrieben.bytes,
        files: geschrieben.files,
      });
      melde('info', `Modell auf den Stick kopiert: ${geschrieben.files} Dateien, ${geschrieben.bytes} Bytes nach ${plan.ordner}`);

      return {
        ziel: wurzel,
        ordner: plan.ordner,
        kopiert: { dateien: geschrieben.files, bytes: geschrieben.bytes },
        uebersprungen: plan.uebersprungen.length,
        bytesUebersprungen: plan.bytesUebersprungen,
        eintraege,
        beschreibung: path.join(plan.ordner, LAYOUT.modelsIndex),
        warnungen,
      };
    } catch (err) {
      // Auch bei Abbruch: der halbfertige Ordner verschwindet, und was vorher
      // auf dem Stick lag, wurde nie angefasst.
      await rmrfAsync(tmp);
      throw err;
    }
  }

  /**
   * Pruefsummen der kopierten Dateien.
   *
   * Drei Faelle, alle drei ehrlich:
   *  - Ollama-Blob: der Dateiname IST der sha256 des Inhalts. Wird er ohnehin
   *    gerechnet, wird er auch verglichen -- stimmt er nicht, ist die Kopie
   *    kaputt, und das ist ein Fehler und keine Fussnote.
   *  - klein genug: gerechnet.
   *  - zu gross und nicht ausdruecklich verlangt: NICHT gerechnet, mit dem
   *    Grund als Satz. Ein leeres Feld ohne Grund waere die Luege.
   */
  async function pruefsummen(dateien, tmp, { modus, signal, fortschritt }) {
    const out = new Map();
    const zuRechnen = dateien.filter((d) => {
      if (modus === 'keine') return false;
      if (modus === 'alle') return true;
      return d.size <= PRUEFSUMME_GRENZE_BYTES;
    });
    let fertig = 0;
    for (const datei of dateien) {
      throwIfAborted(signal, 'Das Pruefen der Kopie');
      const nameSumme = istBlob(datei.rel) ? datei.rel.slice(datei.rel.lastIndexOf('sha256-') + 7) : null;
      if (!zuRechnen.includes(datei)) {
        out.set(datei.rel, nameSumme
          ? { algo: 'sha256', wert: nameSumme, herkunft: 'dateiname', grund: null }
          : {
            algo: 'sha256',
            wert: null,
            herkunft: null,
            grund: modus === 'keine'
              ? 'Auf Wunsch nicht berechnet.'
              : `Nicht berechnet: die Datei ist ${humanBytes(datei.size)} gross, das haette sie ein zweites Mal `
                + 'vollstaendig gelesen. Mit pruefsummen:"alle" wird sie trotzdem berechnet.',
          });
        continue;
      }
      fortschritt({
        phase: 'pruefen',
        message: `Kopie wird geprueft (${fertig + 1}/${zuRechnen.length}) …`,
        copied: fertig,
        total: zuRechnen.length,
        percent: zuRechnen.length ? Math.round((fertig / zuRechnen.length) * 100) : 100,
      });
      const wert = await sha256Von(path.join(tmp, datei.rel), signal);
      if (nameSumme && wert !== nameSumme) {
        throw new StorageError(
          `Die Kopie von "${datei.rel}" stimmt nicht mit dem Original ueberein (Pruefsumme weicht ab). `
          + 'Es wurde nichts an seinen Platz gelegt. Das passiert bei einem defekten Stick oder einem '
          + 'Kabel, das waehrend des Kopierens wackelt - versuche es erneut, moeglichst an einem anderen Anschluss.',
          { datei: datei.rel, erwartet: nameSumme, gefunden: wert },
        );
      }
      out.set(datei.rel, { algo: 'sha256', wert, herkunft: 'berechnet', grund: null });
      fertig++;
    }
    return out;
  }

  /**
   * WARUM von Hand und nicht ueber pipeline(strom, hash): eine crypto.Hash als
   * Ziel einer Pipeline schiebt ihren Digest beim Ende selbst hinaus und gilt
   * danach als abgeschlossen -- ein anschliessendes .digest() wirft. Die
   * Schleife liest ueber den Thread-Pool, haelt den Ereignisring also
   * genauso wenig an, und `signal` bricht sie mitten in einer 4-GB-Datei ab.
   */
  async function sha256Von(datei, signal) {
    const hash = crypto.createHash('sha256');
    try {
      const strom = fs.createReadStream(datei, signal ? { signal } : {});
      for await (const stueck of strom) hash.update(stueck);
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw abortedDuring('Das Pruefen der Kopie');
      throw new StorageError(`"${datei}" liess sich zum Pruefen nicht lesen (${(err && err.code) || err.message}).`);
    }
    return hash.digest('hex');
  }

  /**
   * Das Kopierte an seinen Platz legen.
   *
   * Gibt es models/ noch nicht, ist der Fall einfach und vollstaendig atomar:
   * ein einziges Umbenennen (`swapIntoPlace`), genau wie bei app/.
   *
   * Gibt es models/ schon, waere derselbe Weg falsch: swapIntoPlace() ersetzt
   * den ganzen Ordner, das vorher mitgenommene Modell waere weg. Es in den
   * Nachbarordner zu schieben und zusammen zurueckzubenennen waere die andere
   * naheliegende Loesung -- und die gefaehrlichste: der Nachbarordner heisst
   * `.models.tmp-XXXX`, und genau den raeumt cleanStale() nach einem Abbruch
   * ersatzlos weg. Dann laege das alte Modell im Muell.
   *
   * Deshalb wandert hier jede Datei einzeln hinueber, und zwar in dieser
   * Reihenfolge: erst die Nutzlast (Blobs, Gewichte, Programme), zuletzt die
   * Zeiger (Ollama-Manifeste). Ein Abbruch mittendrin laesst damit hoechstens
   * Blobs ohne Manifest zurueck -- verschenkter Platz, den ein erneuter Lauf
   * wiederverwendet. Ein Manifest ohne Blobs (ein Modell, das es zu geben
   * SCHEINT) kann so nicht entstehen. Was vorher auf dem Stick lag, wird dabei
   * zu keinem Zeitpunkt angefasst.
   */
  async function einsetzen(wurzel, tmp, dateien, signal) {
    const modelsDir = modelsDirOf(wurzel);
    if (!fs.existsSync(modelsDir)) {
      await swapIntoPlace(modelsDir, tmp);
      return;
    }
    const reihenfolge = [...dateien].sort((a, b) => {
      const az = a.art === 'manifest' ? 1 : 0;
      const bz = b.art === 'manifest' ? 1 : 0;
      if (az !== bz) return az - bz;
      return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
    });
    for (const datei of reihenfolge) {
      throwIfAborted(signal, 'Das Einsetzen auf dem Stick');
      const von = path.join(tmp, datei.rel);
      const nach = path.join(modelsDir, datei.rel);
      await fsp.mkdir(path.dirname(nach), { recursive: true });
      try {
        await fsp.rename(von, nach);
      } catch (err) {
        // Windows benennt nicht auf eine vorhandene Datei um. Erst weg, dann hin.
        if (err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES')) {
          await rmrfAsync(nach);
          await fsp.rename(von, nach);
        } else {
          throw new StorageError(
            `"${datei.rel}" konnte auf dem Stick nicht an seinen Platz gelegt werden (${(err && err.code) || err.message}).`,
            { datei: datei.rel },
          );
        }
      }
    }
    await rmrfAsync(tmp);
  }

  /**
   * Die Beschreibungsdatei -- damit ein spaeterer Leser nicht raten muss.
   *
   * Sie wird ZULETZT geschrieben und ersetzt nie, was schon drinsteht: ein
   * zweites Modell kommt hinzu. Bewusst NICHT enthalten: der Pfad, aus dem
   * kopiert wurde. Er enthaelt fast immer den Benutzernamen des Besitzers, und
   * ein Stick geht verloren; fuer die Frage "was liegt hier und passt es zu
   * meinem Rechner" braucht ihn niemand.
   */
  function beschreibungSchreiben(wurzel, plan, summen) {
    const modelsDir = modelsDirOf(wurzel);
    const datei = path.join(modelsDir, LAYOUT.modelsIndex);
    let vorhanden = null;
    try { vorhanden = JSON.parse(fs.readFileSync(datei, 'utf8')); } catch { vorhanden = null; }
    const alt = vorhanden && Array.isArray(vorhanden.eintraege) ? vorhanden.eintraege : [];

    const zeitpunkt = jetzt().toISOString();
    const nachId = new Map(alt.map((e) => [e && e.id, e]).filter(([id]) => typeof id === 'string'));

    const neu = [];
    for (const auswahl of plan.auswahl) {
      const dateien = plan.dateien.filter((d) => d.fund === auswahl.id).map((d) => ({
        ziel: d.rel,
        bytes: d.size,
        pruefsumme: summen.get(d.rel) || { algo: 'sha256', wert: null, herkunft: null, grund: 'Nicht berechnet.' },
      }));
      const uebersprungen = plan.uebersprungen.filter((u) => u.fund === auswahl.id);
      const frueher = nachId.get(auswahl.id);
      const eintrag = {
        id: auswahl.id,
        art: auswahl.art,
        rolle: auswahl.rolle,
        name: auswahl.name,
        // Nur ein Laufzeitkern ist plattformgebunden. Bei Gewichten steht hier
        // bewusst null -- sie laufen ueberall, und ein erfundener Wert wuerde
        // einen Benutzer glauben machen, sein Modell passe nicht.
        plattform: auswahl.rolle === 'kern' ? (auswahl.plattform || dieserRechner) : null,
        bytes: auswahl.bytes,
        dateien: frueher && Array.isArray(frueher.dateien)
          ? zusammenfuehren(frueher.dateien, dateien)
          : dateien,
        zeitpunkt,
        start: startHinweis(auswahl),
      };
      if (uebersprungen.length && !dateien.length) eintrag.hinweis = 'Lag bereits vollstaendig auf dem Stick.';
      nachId.set(eintrag.id, eintrag);
      neu.push(eintrag);
    }

    const doc = {
      version: BESCHREIBUNG_VERSION,
      hinweis: 'Diese Datei beschreibt, was im Ordner "models" liegt: Modelle, Laufzeitkerne, Groessen und '
        + 'Pruefsummen. Ein Laufzeitkern gilt nur fuer die genannte Plattform; die Modelldateien selbst '
        + 'passen auf jeden Rechner.',
      erstellt: (vorhanden && typeof vorhanden.erstellt === 'string') ? vorhanden.erstellt : zeitpunkt,
      aktualisiert: zeitpunkt,
      eintraege: [...nachId.values()].filter(Boolean),
    };
    mkdirp(modelsDir);
    writeFileAtomic(datei, `${JSON.stringify(doc, null, 2)}\n`);
    return neu;
  }

  /** Alte und neue Dateiliste eines Eintrags vereinen, neue gewinnen. */
  function zusammenfuehren(alt, neu) {
    const nachZiel = new Map(alt.filter((d) => d && typeof d.ziel === 'string').map((d) => [d.ziel, d]));
    for (const d of neu) nachZiel.set(d.ziel, d);
    return [...nachZiel.values()];
  }

  /** Wie man das Ding vom Stick startet. Ein Satz, den man abtippen kann. */
  function startHinweis(auswahl) {
    if (auswahl.rolle === 'kern' && auswahl.art === ART.ollama) {
      return 'Ollama vom Stick: OLLAMA_MODELS="<Stick>/models/ollama" "<Stick>/models/kern/'
        + `${auswahl.plattform || dieserRechner}/${auswahl.name}" serve - danach in Neural OS den Anbieter `
        + 'http://127.0.0.1:11434 eintragen.';
    }
    if (auswahl.rolle === 'kern' && auswahl.art === ART.llamaCpp) {
      return `"<Stick>/models/kern/${auswahl.plattform || dieserRechner}/${auswahl.name}" -m `
        + '"<Stick>/models/gguf/<modell>/<datei>.gguf" --port 8080 - danach in Neural OS den Anbieter '
        + 'http://127.0.0.1:8080 eintragen.';
    }
    if (auswahl.art === ART.ollama) {
      return `Wird von Ollama gefunden, sobald OLLAMA_MODELS auf "<Stick>/models/ollama" zeigt (Modellname: ${auswahl.name}).`;
    }
    return `Wird von llama-server mit -m "<Stick>/models/gguf/${sicherName(auswahl.name.replace(/\.gguf$/i, ''))}/${auswahl.name}" geoeffnet.`;
  }

  /* --------------------------------------------------------- aufDemStick() */

  /**
   * Was liegt auf dem Stick, und passt es zu diesem Rechner?
   *
   * Antwortet so, dass eine Oberflaeche daraus EINEN ehrlichen Satz bauen kann
   * -- auch den unbequemen. `fuer` erlaubt die Frage fuer ein anderes Geraet:
   * wer seinen Stick am iPad benutzt, soll dort nicht raten muessen.
   *
   * @param {string} wurzel
   * @param {{fuer?:string}} [opts]
   */
  function aufDemStick(wurzel, opts = {}) {
    const root = wurzelVon(wurzel, 'aufDemStick()');
    const ordner = modelsDirOf(root);
    const ziel = geraetAufloesen(opts.fuer || dieserRechner);

    const out = {
      wurzel: root,
      ordner,
      vorhanden: false,
      bytes: 0,
      modelle: [],
      kerne: [],
      plattformen: [],
      beschreibung: null,
      fuer: ziel,
      dieserRechner,
      passt: false,
      satz: '',
      hinweise: [],
      warnungen: [],
    };

    if (!fs.existsSync(ordner)) {
      out.satz = 'Auf diesem Stick liegt kein Modell. Deine Notizen reisen mit, eine Antwort gibt es auf einem '
        + 'fremden Rechner nur, wenn dort selbst ein Modell installiert ist.';
      return out;
    }

    // ---- Laufzeitkerne: models/kern/<plattform>/<datei> ----
    const kernWurzel = path.join(ordner, 'kern');
    let kernPlattformen = [];
    try {
      kernPlattformen = fs.readdirSync(kernWurzel, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* kein Kern auf dem Stick */ }
    for (const plattform of kernPlattformen) {
      let eintraege = [];
      try {
        eintraege = fs.readdirSync(path.join(kernWurzel, plattform), { withFileTypes: true }).filter((e) => e.isFile());
      } catch { continue; }
      for (const eintrag of eintraege) {
        const abs = path.join(kernWurzel, plattform, eintrag.name);
        const st = statSicher(abs);
        if (!st) continue;
        out.kerne.push({
          art: /^ollama/i.test(eintrag.name) ? ART.ollama : ART.llamaCpp,
          name: eintrag.name,
          plattform,
          pfad: abs,
          bytes: st.size,
          ausfuehrbar: istAusfuehrbar(abs, aufOs),
        });
      }
    }
    out.plattformen = einmalig(out.kerne.map((k) => k.plattform));

    // ---- Modelle: derselbe Leser wie auf dem Quellrechner ----
    const ollamaAufStick = path.join(ordner, 'ollama');
    if (fs.existsSync(ollamaAufStick)) {
      const gelesen = ollamaModelleLesen(ollamaAufStick);
      out.modelle.push(...gelesen.funde.map((f) => ({
        art: f.art, name: f.name, bytes: f.bytes, dateien: f.dateien.length,
        vollstaendig: f.vollstaendig, hinweis: f.hinweis,
      })));
      out.warnungen.push(...gelesen.funde.filter((f) => !f.vollstaendig).map((f) => f.hinweis));
    }
    const ggufAufStick = path.join(ordner, 'gguf');
    if (fs.existsSync(ggufAufStick)) {
      const gelesen = ggufModelleLesen(ggufAufStick, ggufAufStick);
      out.modelle.push(...gelesen.funde.map((f) => ({
        art: f.art, name: f.name, bytes: f.bytes, dateien: f.dateien.length,
        vollstaendig: f.vollstaendig, hinweis: f.hinweis,
      })));
      out.warnungen.push(...gelesen.funde.filter((f) => !f.vollstaendig).map((f) => f.hinweis));
    }

    try {
      const tree = collectTree(ordner, { exclude: new Set(), dropLogs: false });
      out.bytes = tree.bytes;
    } catch { /* unlesbar; dann bleibt es bei 0, und der Rest sagt weiter die Wahrheit */ }
    out.vorhanden = out.modelle.length > 0 || out.kerne.length > 0;

    // ---- die Beschreibung, falls vorhanden ----
    const indexDatei = path.join(ordner, LAYOUT.modelsIndex);
    if (fs.existsSync(indexDatei)) {
      try {
        const gelesen = JSON.parse(fs.readFileSync(indexDatei, 'utf8'));
        out.beschreibung = gelesen && typeof gelesen === 'object' ? gelesen : null;
      } catch {
        out.warnungen.push(`Die Beschreibung "${LAYOUT.modelsIndex}" ist unlesbar. Was hier steht, wurde aus den Dateien selbst gelesen.`);
      }
    } else if (out.vorhanden) {
      out.hinweise.push(
        `Es gibt keine Beschreibung "${LAYOUT.modelsIndex}". Was hier steht, wurde aus den Dateien selbst gelesen - `
        + 'Pruefsummen und Herkunft fehlen deshalb.',
      );
    }
    if (out.beschreibung && Array.isArray(out.beschreibung.eintraege)) {
      for (const eintrag of out.beschreibung.eintraege) {
        if (!eintrag || !Array.isArray(eintrag.dateien)) continue;
        const fehlend = eintrag.dateien.filter((d) => d && typeof d.ziel === 'string' && !fs.existsSync(path.join(ordner, d.ziel)));
        if (fehlend.length) {
          out.warnungen.push(
            `Die Beschreibung nennt "${eintrag.name}", aber ${fehlend.length} seiner Datei(en) fehlen auf dem Stick. `
            + 'Der Kopiervorgang wurde vermutlich abgebrochen - lege es noch einmal ab.',
          );
        }
      }
    }

    // ---- der eine ehrliche Satz ----
    out.passt = !!ziel.kannProgrammeStarten && out.modelle.length > 0
      && out.kerne.some((k) => k.plattform === ziel.plattform);
    out.satz = urteil(out, ziel);
    return out;
  }

  /**
   * Fuer welches Geraet wird gefragt? Ein iPad ist kein Rechner mit anderer
   * Architektur, sondern ein Geraet, das ueberhaupt kein Programm von einem
   * Stick startet -- diese beiden Faelle duerfen nicht denselben Satz bekommen.
   */
  function geraetAufloesen(kennung) {
    const roh = String(kennung || '').toLowerCase();
    const kurz = roh.split('-')[0];
    const bekannt = GERAETE[roh] || GERAETE[kurz] || null;
    return {
      plattform: roh || dieserRechner,
      name: bekannt ? bekannt.name : (roh || dieserRechner),
      kannProgrammeStarten: bekannt ? bekannt.kannProgrammeStarten : true,
    };
  }

  function urteil(stand, ziel) {
    const groesse = humanBytes(stand.bytes);
    if (!stand.vorhanden) {
      return 'Auf diesem Stick liegt kein Modell. Deine Notizen reisen mit, eine Antwort gibt es auf einem '
        + 'fremden Rechner nur, wenn dort selbst ein Modell installiert ist.';
    }
    if (!ziel.kannProgrammeStarten) {
      return `Auf einem ${ziel.name} laesst sich kein Programm von einem Stick starten. Die Modelldateien `
        + `(${groesse}) sind dort lesbar, aber der Laufzeitkern`
        + (stand.plattformen.length ? ` (gebaut fuer ${stand.plattformen.join(', ')})` : '')
        + ' nuetzt dort nichts. Antworten gibt es auf diesem Geraet nur ueber einen Rechner im selben Netz, '
        + 'der das Modell laufen laesst.';
    }
    if (!stand.modelle.length) {
      return `Auf dem Stick liegt ein Laufzeitkern (${stand.plattformen.join(', ') || 'unbekannte Plattform'}), `
        + 'aber kein Modell. Ein Kern ohne Gewichte beantwortet keine Frage.';
    }
    if (!stand.kerne.length) {
      return `Auf dem Stick liegen ${stand.modelle.length} Modell(e) (${groesse}), aber kein Laufzeitkern. `
        + 'Oeffnen kann sie nur ein Rechner, auf dem Ollama oder llama.cpp schon installiert ist.';
    }
    if (stand.passt) {
      return `Auf dem Stick liegen ${stand.modelle.length} Modell(e) (${groesse}) und ein Laufzeitkern fuer `
        + `${ziel.plattform}. Dieser Rechner ist ${ziel.plattform} - das passt.`;
    }
    return `Der Laufzeitkern auf dem Stick ist fuer ${stand.plattformen.join(', ')}, dieser Rechner ist `
      + `${ziel.plattform}. Er startet hier nicht. Die Modelldateien selbst (${groesse}) passen auf jeden Rechner; `
      + `es fehlt nur ein Kern fuer ${ziel.plattform} - den legt ein Rechner mit diesem System selbst dazu.`;
  }

  return {
    finden,
    planen,
    kopieren,
    aufDemStick,
    /** Die Plattformkennung dieses Rechners, im Vokabular von runtime/. */
    dieserRechner,
  };
}

module.exports = {
  createPortableModels,
  ART,
  GERAETE,
  BESCHREIBUNG_VERSION,
  FAT_DATEIGRENZE,
  PRUEFSUMME_GRENZE_BYTES,
  plattformId,
  // Fuer Tests und fuer jeden, der denselben Speicher lesen muss, ohne das
  // ganze Werkzeug zu bauen:
  ollamaModellname,
  ollamaModelleLesen,
  ggufModelleLesen,
};
