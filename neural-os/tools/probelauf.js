#!/usr/bin/env node
'use strict';

/**
 * Neural OS – Probelauf (Paket P, docs/STICK-BAUPLAN.md Abschnitt 2.2 und Teil 3)
 *
 * Hier gibt es weder einen Windows-PC noch einen Mac. Alles, was der Bauplan
 * über Schulrechner, Gatekeeper, exFAT, Virenschutz und Portsperren annimmt,
 * klärt dieser eine Doppelklick je Rechner. Er benutzt dafür genau den
 * Start-Mechanismus aus Paket S (Starter -> abgelöster Dienst -> Browser) und
 * prüft ihn damit gleich mit.
 *
 *   node tools/probelauf.js --auf-stick <Stick-Wurzel>   Dateien auf einen Stick legen
 *   node probelauf.js --start [--ort <Ordner>]            Starter (aus der .bat/.command)
 *   node probelauf.js --trocken [--ort <Ordner>]          nur messen, JSON auf stdout
 *   node probelauf.js --dienst ...                        intern
 *
 * Eigenständig mit Absicht: kein `require` aus `src/`, keine Abhängigkeit.
 * Das Skript wird einzeln auf einen Stick kopiert und muss dort allein laufen.
 * Aus demselben Grund stehen die Modulnamen ohne "node:"-Präfix und ohne
 * `?.`/`??`: Im Projektordner läuft es vielleicht mit einem älteren,
 * installierten Node, und an einer Syntaxfrage soll der Probelauf nicht
 * scheitern.
 *
 * Ohne vorbereiteten Stick: Liegt der Starter im Projektordner (ZIP
 * entpackt), ist der Ort kein Wechseldatenträger. Dann sucht der Probelauf
 * einen eingesteckten, beschreibbaren Stick und misst die Schreibproben
 * dort, in einem eigenen Ordner PROBELAUF, der danach wieder verschwindet.
 * Die Ergebnisdatei bleibt am Ort des Starters.
 *
 * Nichts Persönliches: Das Ergebnis enthält keinen Benutzernamen, keinen
 * Rechnernamen und keine Pfade (die tragen fast immer den Benutzernamen).
 * Der Rechner erscheint nur als Kennung, derselbe Hash wie `rechner.kennung()`
 * aus Paket G.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

const FORMAT = 1;
const ORDNER = 'PROBELAUF';
const PORT_DATEI = 'dienst-port.txt';
const APP_DATEI = 'app-gestartet.txt';
const TMP_PORT_DATEI = 'neural-os-probelauf-port.txt';
const MARKER = 'neural-os.portable';

const UMBENENNEN_ANZAHL = 300;
const PORT_PROBEN = 20;
const PORT_VON = 20000;
const PORT_BIS = 29999;
// Ein hängendes Netzlaufwerk darf die Suche nicht aufhalten (Bauplan 2.2).
const STAT_GRENZE_MS = 3000;
// "Starter weg, Dienst lebt": höchstens 30 s beobachten; ist der Starter
// früher weg, reichen 5 s danach. In diesen Sekunden schließt Windows das
// Konsolenfenster, und ein daran hängender Prozess stürbe mit.
const BEOBACHTEN_MS = 30000;
const NACH_STARTER_MS = 5000;
const BEREIT_GRENZE_MS = 120000;
const DAUERT_NOCH_MS = 10000;
// Wer die Seite offen lässt und geht, soll keinen Dienst für immer zurücklassen.
const LEERLAUF_MS = 30 * 60 * 1000;
const KOERPER_MAX = 16 * 1024;

const TEXTE = {
  keineLaufzeiten: 'Auf diesem Stick fehlen die Laufzeiten.',
  keinOrdner: 'Diesen Ordner gibt es nicht.',
  keineVorlagen: 'Die Starter-Vorlagen fehlen neben probelauf.js.',
  dauertNoch: 'Probelauf startet … (dauert noch)',
  startFehler: 'Probelauf konnte nicht starten:',
  aufruf: 'Aufruf: node probelauf.js --start | --trocken | --auf-stick <Stick-Wurzel>',
};

// ---------------------------------------------------------------------------
// Kleine Werkzeuge
// ---------------------------------------------------------------------------

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Dieselbe Kennung wie `kennung()` in src/kernel/rechner.js (Paket G): Der
 * Probelauf soll zeigen, welche Kennung die Sperren auf diesem Rechner
 * tragen werden. Nachgebaut statt eingebunden, weil das Skript allein auf
 * dem Stick liegt; der Test vergleicht beide.
 */
function kennung() {
  let name = '';
  try {
    name = String(os.hostname() || '').toLowerCase();
  } catch (_) {
    name = '';
  }
  return sha256('nos-rechner|' + name).slice(0, 16);
}

function bootZeit() {
  return Math.round(Date.now() / 1000 - os.uptime());
}

/** Millisekunden mit Nachkommastelle, für Dauer-Messungen. */
function jetzt() {
  return performance.now();
}

function runde(ms) {
  return Math.round(ms * 10) / 10;
}

function istOrdner(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function istDatei(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function weg(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function warte(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function median(zahlen) {
  if (!zahlen.length) return null;
  const s = zahlen.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Fehlertexte können Pfade enthalten (und darin den Benutzernamen). Ins
 * Ergebnis kommt deshalb nur der Code, und wo doch Text nötig ist, läuft er
 * hier durch.
 */
function sauber(text, geheim) {
  let t = String(text || '');
  const liste = (geheim || []).concat([os.homedir()]).filter((g) => g && g.length > 2);
  try {
    const u = os.userInfo().username;
    if (u && u.length > 2) liste.push(u);
  } catch (_) {
    /* ohne Eintrag in der Benutzerdatenbank */
  }
  try {
    const h = os.hostname();
    if (h && h.length > 2) liste.push(h);
  } catch (_) {
    /* ohne Namen */
  }
  liste.sort((a, b) => b.length - a.length);
  for (const g of liste) t = t.split(g).join('…');
  return t.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Ein Systemprogramm laufen lassen, ohne je zu werfen. `windowsHide`, weil
 * der Dienst keine Konsole hat und Windows sonst für jedes Kind ein Fenster
 * aufmacht (Bauplan 0.3).
 */
function lauf(befehl, args, opts) {
  const o = opts || {};
  const grenze = o.grenzeMs || 15000;
  return new Promise((resolve) => {
    const t0 = jetzt();
    let out = '';
    let err = '';
    let fertig = false;
    let kind;
    const ende = (erg) => {
      if (fertig) return;
      fertig = true;
      clearTimeout(timer);
      resolve(Object.assign({ out, err, ms: Math.round(jetzt() - t0) }, erg));
    };
    try {
      kind = spawn(befehl, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: o.env || process.env });
    } catch (e) {
      resolve({ exit: null, out: '', err: '', ms: 0, fehler: e.code || 'FEHLER' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        kind.kill();
      } catch (_) {
        /* schon weg */
      }
      ende({ exit: null, fehler: 'ZEITGRENZE' });
    }, grenze);
    kind.stdout.on('data', (d) => {
      if (out.length < 65536) out += d;
    });
    kind.stderr.on('data', (d) => {
      if (err.length < 65536) err += d;
    });
    kind.on('error', (e) => ende({ exit: null, fehler: e.code || 'FEHLER' }));
    kind.on('close', (code) => ende({ exit: code, fehler: null }));
  });
}

/** Wie `schreibeDauerhaft` aus Paket G: tmp + fsync + rename, damit ein
 * gezogener Stick nie eine halbe Ergebnisdatei hinterlässt. */
function schreibeDauerhaft(ziel, inhalt) {
  const tmp = path.join(path.dirname(ziel), '.' + path.basename(ziel) + '.tmp-' + process.pid);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o644);
    fs.writeSync(fd, inhalt);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, ziel);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* egal */
      }
    }
    weg(tmp);
    throw err;
  }
}

function innerhalb(p, wurzel) {
  const a = process.platform === 'win32' ? p.toLowerCase() : p;
  const b = process.platform === 'win32' ? wurzel.toLowerCase() : wurzel;
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function echt(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
}

// ---------------------------------------------------------------------------
// Aufbau eines Sticks
// ---------------------------------------------------------------------------

/**
 * Neuer Aufbau: alles unter "Inhalt/" (Bauplan 1.1, Paket R). Alter Aufbau:
 * runtime/, app/ und der Marker direkt in der Wurzel. Bestehende Sticks
 * werden nie umgebaut, deshalb muss der Probelauf beide kennen.
 */
function aufbauVon(root) {
  if (istOrdner(path.join(root, 'Inhalt'))) return { aufbau: 'inhalt', basis: path.join(root, 'Inhalt') };
  for (const n of ['runtime', 'app', MARKER]) {
    if (fs.existsSync(path.join(root, n))) return { aufbau: 'alt', basis: root };
  }
  return null;
}

function hatLaufzeit(basis) {
  const kandidaten = [
    ['win-x64', 'node.exe'],
    ['win-arm64', 'node.exe'],
    ['darwin-arm64', 'node'],
    ['darwin-x64', 'node'],
    ['linux-x64', 'node'],
  ];
  return kandidaten.some(([plat, name]) => istDatei(path.join(basis, 'runtime', plat, name)));
}

function istProjektordner(p) {
  return istDatei(path.join(p, 'package.json')) && istDatei(path.join(p, 'bin', 'neural-os.js'));
}

/** Wo liegt der Starter? Aus der Lage dieses Skripts erschlossen, falls kein
 * `--ort` kommt: Inhalt/probelauf.js, <Wurzel>/probelauf.js oder tools/. */
function standardOrt() {
  const hier = __dirname;
  const name = path.basename(hier);
  if (name === 'Inhalt') return path.dirname(hier);
  if (name === 'tools' && istProjektordner(path.dirname(hier))) return path.dirname(hier);
  return hier;
}

// ---------------------------------------------------------------------------
// --auf-stick: Dateien ablegen, nichts starten
// ---------------------------------------------------------------------------

function infoPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleExecutable</key>',
    '  <string>probe</string>',
    '  <key>CFBundleIdentifier</key>',
    '  <string>de.neural-os.probelauf.probe</string>',
    '  <key>CFBundleName</key>',
    '  <string>Probe</string>',
    '  <key>CFBundlePackageType</key>',
    '  <string>APPL</string>',
    '  <key>CFBundleShortVersionString</key>',
    '  <string>1</string>',
    '  <key>CFBundleVersion</key>',
    '  <string>1</string>',
    '  <key>LSMinimumSystemVersion</key>',
    '  <string>11.0</string>',
    // Kein Dock-Symbol: Das Skript läuft Sekundenbruchteile und ist dann weg.
    '  <key>LSUIElement</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * Das Skript im Bündel. Es sucht den Ordner PROBELAUF relativ zu sich selbst:
 * Inhalt/Probe.app (neuer Aufbau), <Wurzel>/Probe.app (alter Aufbau) oder
 * PROBELAUF/Probe.app (vom Dienst angelegt, wenn kein vorbereiteter Stick da
 * ist). Den Port liest es aus einer Datei, weil er beim Anlegen noch nicht
 * feststeht.
 */
function probeSkript() {
  return [
    '#!/bin/sh',
    '# Probe fuer den Neural-OS-Probelauf (Paket P). Startet ein unsigniertes',
    '# Skript-.app per Doppelklick von diesem Stick? Wenn ja, legt es',
    '# PROBELAUF/app-gestartet.txt ab und meldet sich per HTTP beim Dienst.',
    'APP=$(cd -- "$(dirname -- "$0")/../.." 2>/dev/null && pwd)',
    'BEI=$(dirname -- "$APP")',
    'case "$(basename -- "$BEI")" in',
    '  PROBELAUF) ZIEL="$BEI" ;;',
    '  Inhalt) ZIEL="$(dirname -- "$BEI")/PROBELAUF" ;;',
    '  *) ZIEL="$BEI/PROBELAUF" ;;',
    'esac',
    '# App Translocation: Ein Buendel mit Quarantaene laeuft von einer',
    '# zufaelligen, schreibgeschuetzten Kopie. Das ist selbst eine Antwort.',
    'case "$APP" in */AppTranslocation/*) VERSETZT=ja ;; *) VERSETZT=nein ;; esac',
    'DATEI=nein',
    'if mkdir -p "$ZIEL" 2>/dev/null && date "+%Y-%m-%dT%H:%M:%S%z" > "$ZIEL/' + APP_DATEI + '" 2>/dev/null; then DATEI=ja; fi',
    'PORT=$(cat "$ZIEL/' + PORT_DATEI + '" 2>/dev/null || cat "$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)' + TMP_PORT_DATEI + '" 2>/dev/null || cat "${TMPDIR:-/tmp}/' + TMP_PORT_DATEI + '" 2>/dev/null)',
    'case "$PORT" in ""|*[!0-9]*) exit 0 ;; esac',
    '/usr/bin/curl -s -m 3 -X POST -H "X-Probelauf: 1" -H "Content-Type: application/json" \\',
    '  --data "{\\"datei\\":\\"$DATEI\\",\\"versetzt\\":\\"$VERSETZT\\"}" "http://127.0.0.1:$PORT/api/app-gestartet" >/dev/null 2>&1',
    'exit 0',
    '',
  ].join('\n');
}

function probeAppSchreiben(basis) {
  const app = path.join(basis, 'Probe.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), infoPlist());
  const skript = path.join(app, 'Contents', 'MacOS', 'probe');
  fs.writeFileSync(skript, probeSkript(), { mode: 0o755 });
  // writeFile setzt den Modus nur beim Anlegen und nur unter der umask.
  fs.chmodSync(skript, 0o755);
  return app;
}

function probeAppLoeschen(basis) {
  const app = path.join(basis, 'Probe.app');
  weg(path.join(app, 'Contents', 'MacOS', 'probe'));
  weg(path.join(app, 'Contents', 'Info.plist'));
  for (const d of [path.join(app, 'Contents', 'MacOS'), path.join(app, 'Contents'), app]) {
    try {
      fs.rmdirSync(d);
    } catch (_) {
      /* nicht leer oder schon weg */
    }
  }
}

/** Zeilenenden fest einstellen: cmd.exe braucht CRLF, /bin/sh verträgt kein CR. */
function mitCrlf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function mitLf(text) {
  return text.replace(/\r\n/g, '\n');
}

function fehler(text, code) {
  const err = new Error(text);
  err.code = code || 'PROBELAUF';
  err.satz = text;
  return err;
}

function aufStick(root) {
  const wurzel = path.resolve(root);
  if (!istOrdner(wurzel)) throw fehler(TEXTE.keinOrdner, 'KEIN_ORDNER');
  const a = aufbauVon(wurzel);
  if (!a || !hatLaufzeit(a.basis)) throw fehler(TEXTE.keineLaufzeiten, 'KEINE_LAUFZEIT');
  const vorlagen = path.join(__dirname, 'launchers');
  const batVorlage = path.join(vorlagen, 'probelauf-windows.bat');
  const cmdVorlage = path.join(vorlagen, 'probelauf-macos.command');
  if (!istDatei(batVorlage) || !istDatei(cmdVorlage)) throw fehler(TEXTE.keineVorlagen, 'KEINE_VORLAGEN');

  // Erst alles lesen, dann schreiben: Fehlt etwas, bleibt der Stick unberührt.
  const bat = mitCrlf(fs.readFileSync(batVorlage, 'latin1'));
  const cmd = mitLf(fs.readFileSync(cmdVorlage, 'utf8'));
  const selbst = fs.readFileSync(__filename);

  const angelegt = [];
  const batZiel = path.join(wurzel, 'Probelauf - Windows.bat');
  fs.writeFileSync(batZiel, bat, 'latin1');
  angelegt.push(batZiel);
  const cmdZiel = path.join(wurzel, 'Probelauf - Mac.command');
  fs.writeFileSync(cmdZiel, cmd, { mode: 0o755 });
  fs.chmodSync(cmdZiel, 0o755);
  angelegt.push(cmdZiel);
  const jsZiel = path.join(a.basis, 'probelauf.js');
  fs.writeFileSync(jsZiel, selbst);
  angelegt.push(jsZiel);
  const app = probeAppSchreiben(a.basis);
  angelegt.push(path.join(app, 'Contents', 'Info.plist'), path.join(app, 'Contents', 'MacOS', 'probe'));
  return { aufbau: a.aufbau, dateien: angelegt };
}

// ---------------------------------------------------------------------------
// Fremde Ausgaben auswerten
// ---------------------------------------------------------------------------

/** `netsh int ipv4 show excludedportrange protocol=tcp` -> [[von, bis], …]
 * Zahlenpaare genügen: Die Überschriften sind je nach Sprache verschieden. */
function netshBereiche(text) {
  const out = [];
  for (const zeile of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d{1,5})\s+(\d{1,5})\s*\*?\s*$/.exec(zeile);
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

/** Eine Zeile aus `/sbin/mount` (macOS): "<gerät> on <punkt> (<typ>, <flags…>)". */
function mountZeilenMac(text) {
  const out = [];
  for (const zeile of String(text || '').split(/\r?\n/)) {
    const m = /^(.+?) on (.+) \(([^()]*)\)\s*$/.exec(zeile);
    if (!m) continue;
    const teile = m[3].split(',').map((s) => s.trim()).filter(Boolean);
    out.push(mountEintrag(m[1], m[2], teile[0] || '', teile.slice(1)));
  }
  return out;
}

/** /proc/mounts (Linux): Leerzeichen stehen dort als \040. */
function mountZeilenLinux(text) {
  const out = [];
  const ent = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  for (const zeile of String(text || '').split('\n')) {
    const f = zeile.split(' ');
    if (f.length < 4) continue;
    out.push(mountEintrag(ent(f[0]), ent(f[1]), f[2], f[3].split(',')));
  }
  return out;
}

function mountEintrag(geraet, punkt, typ, flags) {
  return {
    geraet,
    punkt,
    typ,
    flags,
    readOnly: flags.includes('read-only') || flags.includes('ro'),
    noexec: flags.includes('noexec'),
    noowners: flags.includes('noowners'),
    local: flags.includes('local'),
  };
}

/** Der Eintrag, unter dem `pfad` liegt: der längste passende Einhängepunkt. */
function mountFuer(eintraege, pfad) {
  let best = null;
  for (const e of eintraege) {
    const p = e.punkt;
    const passt = p === '/' || pfad === p || pfad.startsWith(p.endsWith('/') ? p : p + '/');
    if (passt && (!best || p.length > best.punkt.length)) best = e;
  }
  return best;
}

function mountZeile(text, pfad) {
  return mountFuer(mountZeilenMac(text), pfad);
}

/** Nur die paar Schlüssel aus `diskutil info -plist`, die der Bauplan braucht. */
function plistWerte(xml, schluessel) {
  const out = {};
  for (const k of schluessel) {
    const re = new RegExp('<key>' + k + '</key>\\s*(<true/>|<false/>|<string>([^<]*)</string>|<integer>([^<]*)</integer>)');
    const m = re.exec(String(xml || ''));
    if (!m) out[k] = null;
    else if (m[1] === '<true/>') out[k] = true;
    else if (m[1] === '<false/>') out[k] = false;
    else out[k] = m[2] !== undefined ? m[2] : Number(m[3]);
  }
  return out;
}

/** "Mozilla/5.0 … Edg/128.0" -> "Edge 128". Der volle User-Agent bleibt in
 * der Datei; ins kopierte Ergebnis kommt nur Name und Hauptversion. */
function browserName(ua) {
  const s = String(ua || '');
  const regeln = [
    [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+(?:\.\d+)?).*Safari\//, 'Safari'],
  ];
  for (const [re, name] of regeln) {
    const m = re.exec(s);
    if (m) return name + ' ' + m[1];
  }
  return s ? 'unbekannt' : null;
}

// ---------------------------------------------------------------------------
// Messen: überall
// ---------------------------------------------------------------------------

function systemInfo() {
  return {
    os: process.platform,
    version: os.release(),
    arch: process.arch,
    node: process.version,
    bootZeit: bootZeit(),
    uptimeS: Math.round(os.uptime()),
    bootZeitAbweichungS: null,
  };
}

/** Den Ordner PROBELAUF anlegen oder übernehmen und prüfen, ob man darin
 * schreiben kann. `erstellt` merkt sich, ob er hinterher wieder weg darf. */
function ordnerAnlegen(pfad) {
  let erstellt = false;
  try {
    if (!istOrdner(pfad)) {
      fs.mkdirSync(pfad);
      erstellt = true;
    }
    const test = path.join(pfad, '.schreibtest-' + process.pid);
    fs.writeFileSync(test, 'x');
    fs.unlinkSync(test);
    return { pfad, erstellt, fehler: null };
  } catch (err) {
    if (erstellt) {
      try {
        fs.rmdirSync(pfad);
      } catch (_) {
        /* dann bleibt er */
      }
    }
    return { pfad, erstellt: false, fehler: err.code || 'FEHLER' };
  }
}

function schreibprobe(ordner) {
  const t0 = jetzt();
  const datei = path.join(ordner, 'schreibprobe.tmp');
  const inhalt = crypto.randomBytes(4096);
  try {
    fs.writeFileSync(datei, inhalt);
    const zurueck = fs.readFileSync(datei);
    fs.unlinkSync(datei);
    if (!zurueck.equals(inhalt)) return { ok: false, ms: Math.round(jetzt() - t0), fehler: 'INHALT' };
    return { ok: true, ms: Math.round(jetzt() - t0), fehler: null };
  } catch (err) {
    weg(datei);
    return { ok: false, ms: Math.round(jetzt() - t0), fehler: err.code || 'FEHLER' };
  }
}

/**
 * 300 × "tmp schreiben + über bestehende Datei umbenennen", so wie jede
 * dauerhafte Schreibung in Neural OS. Keine Wiederholung: Gezählt wird, wie
 * oft Virenschutz oder Indexdienst das Umbenennen verhindern, denn daraus
 * ergeben sich Wartezeit und Wiederholungen in `dateien.umbenennen` (G).
 * Alle 25 Runden gibt die Schleife den Takt ab, damit die Seite im Browser
 * währenddessen antwortet; gemessen wird nur die Arbeit selbst.
 */
async function umbenennenProbe(ordner, abbruch) {
  const ziel = path.join(ordner, 'umbenennen.ziel');
  const inhalt = Buffer.alloc(1024, 0x6e);
  const erg = { anzahl: UMBENENNEN_ANZAHL, ok: 0, fehler: {}, gesamtMs: 0, erstesFehlerBei: null };
  try {
    fs.writeFileSync(ziel, 'start');
  } catch (err) {
    return { anzahl: 0, ok: 0, fehler: {}, gesamtMs: 0, uebersprungen: err.code || 'FEHLER' };
  }
  let summe = 0;
  for (let i = 0; i < UMBENENNEN_ANZAHL; i++) {
    if (abbruch && abbruch()) {
      erg.anzahl = i;
      break;
    }
    const tmp = path.join(ordner, '.umbenennen-' + i + '.tmp');
    const t0 = jetzt();
    try {
      fs.writeFileSync(tmp, inhalt);
      fs.renameSync(tmp, ziel);
      erg.ok++;
    } catch (err) {
      const code = err.code || 'FEHLER';
      erg.fehler[code] = (erg.fehler[code] || 0) + 1;
      if (erg.erstesFehlerBei === null) erg.erstesFehlerBei = i + 1;
      weg(tmp);
    }
    summe += jetzt() - t0;
    if (i % 25 === 24) await new Promise((r) => setImmediate(r));
  }
  weg(ziel);
  erg.gesamtMs = Math.round(summe);
  return erg;
}

function fsyncProbe(ordner) {
  const datei = path.join(ordner, 'fsync.probe');
  const zeiten = [];
  let fehlerCode = null;
  let fd = null;
  try {
    fd = fs.openSync(datei, 'w');
    const block = Buffer.alloc(4096, 0x66);
    for (let i = 0; i < 10; i++) {
      fs.writeSync(fd, block);
      const t0 = jetzt();
      fs.fsyncSync(fd);
      zeiten.push(jetzt() - t0);
    }
  } catch (err) {
    fehlerCode = err.code || 'FEHLER';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* egal */
      }
    }
    weg(datei);
  }
  // Ordner-fsync: unter Windows geht das nicht (Bauplan G, fsyncOrdner), und
  // genau das soll hier mit Code stehen.
  let ordnerErg = 'ok';
  const t0 = jetzt();
  let dfd = null;
  try {
    dfd = fs.openSync(ordner, 'r');
    fs.fsyncSync(dfd);
  } catch (err) {
    ordnerErg = err.code || 'FEHLER';
  } finally {
    if (dfd !== null) {
      try {
        fs.closeSync(dfd);
      } catch (_) {
        /* egal */
      }
    }
  }
  return {
    dateiMs: zeiten.length ? runde(median(zeiten)) : null,
    dateiMaxMs: zeiten.length ? runde(Math.max.apply(null, zeiten)) : null,
    ordner: ordnerErg,
    ordnerMs: runde(jetzt() - t0),
    fehler: fehlerCode,
  };
}

function binden(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (err) => resolve(err.code || 'FEHLER'));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(null)));
  });
}

/** 20 Ports, gleichmäßig über 20000–29999 verteilt, damit auch ein
 * Ausschlussbereich von Hyper-V/WSL mitten im Bereich auffällt. */
async function portProbe() {
  const schritt = Math.floor((PORT_BIS - PORT_VON + 1) / PORT_PROBEN);
  const liste = [];
  for (let i = 0; i < PORT_PROBEN; i++) {
    const port = PORT_VON + i * schritt + Math.floor(Math.random() * schritt);
    liste.push([port, await binden(port)]);
  }
  return { liste, frei: liste.filter((x) => x[1] === null).length };
}

function statMitGrenze(p, grenzeMs) {
  const t0 = jetzt();
  return new Promise((resolve) => {
    let fertig = false;
    const timer = setTimeout(() => {
      fertig = true;
      resolve({ ms: Math.round(jetzt() - t0), code: null, zeitGrenze: true });
    }, grenzeMs);
    fs.promises.stat(p).then(
      () => {
        if (fertig) return;
        clearTimeout(timer);
        resolve({ ms: Math.round(jetzt() - t0), code: null, zeitGrenze: false });
      },
      (err) => {
        if (fertig) return;
        clearTimeout(timer);
        resolve({ ms: Math.round(jetzt() - t0), code: err.code || 'FEHLER', zeitGrenze: false });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Wechseldatenträger erkennen und einen Stick suchen
// ---------------------------------------------------------------------------

function systemProgramm(...teile) {
  const wurzel = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const voll = path.join(wurzel, 'System32', ...teile);
  return istDatei(voll) ? voll : teile[teile.length - 1];
}

function powershell(befehl, grenzeMs) {
  return lauf(systemProgramm('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', befehl], {
    grenzeMs: grenzeMs || 30000,
  });
}

/** Laufwerksarten über CIM (ein Cmdlet, geht auch im Constrained Language
 * Mode). 2 = Wechseldatenträger, 3 = Festplatte, 4 = Netz, 5 = CD. */
async function artenCim() {
  const r = await powershell(
    "Get-CimInstance -ClassName Win32_LogicalDisk | ForEach-Object { '{0}|{1}|{2}' -f $_.DeviceID, $_.DriveType, $_.FileSystem }"
  );
  const liste = {};
  for (const zeile of r.out.split(/\r?\n/)) {
    const m = /^([A-Za-z]):\|(\d+)\|(.*)$/.exec(zeile.trim());
    if (m) liste[m[1].toUpperCase()] = { typ: Number(m[2]), fs: m[3].trim() || null };
  }
  return Object.keys(liste).length ? { quelle: 'cim', liste, ms: r.ms } : null;
}

/** Rückfall ohne PowerShell: `fsutil fsinfo drivetype` spricht die Sprache
 * des Systems, deshalb deutsch und englisch. */
async function artenFsutil(buchstaben) {
  const liste = {};
  for (const b of buchstaben) {
    const r = await lauf(systemProgramm('fsutil.exe'), ['fsinfo', 'drivetype', b + ':'], { grenzeMs: 5000 });
    const t = r.out;
    let typ = null;
    if (/Removable|Wechsel/i.test(t)) typ = 2;
    else if (/Fixed|Festplatte|lokale/i.test(t)) typ = 3;
    else if (/Remote|Netz/i.test(t)) typ = 4;
    else if (/CD|DVD/i.test(t)) typ = 5;
    if (typ !== null) liste[b] = { typ, fs: null };
  }
  return Object.keys(liste).length ? { quelle: 'fsutil', liste } : null;
}

function hatNeuralOs(wurzel) {
  return istDatei(path.join(wurzel, MARKER)) || istDatei(path.join(wurzel, 'Inhalt', MARKER));
}

/**
 * Ist der Ort ein Wechseldatenträger, und welche Sticks stecken sonst?
 * Liefert { erkennung, ortWechsel, ortLaufwerk, ortDateisystem, kandidaten }.
 * Windows misst dabei die Laufwerksbuchstaben mit (Bauplan: stat auf D:–Z:).
 */
async function wechselInfo(ctx, e) {
  const ort = ctx.ort;
  const info = { erkennung: null, ortWechsel: null, ortLaufwerk: null, ortDateisystem: null, kandidaten: [] };

  if (process.platform === 'win32') {
    const buchstaben = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const staende = await Promise.all(buchstaben.map((b) => statMitGrenze(b + ':\\', STAT_GRENZE_MS)));
    e.windows.laufwerke = buchstaben.map((b, i) => Object.assign({ b }, staende[i]));
    const vorhanden = e.windows.laufwerke.filter((l) => l.code === null && !l.zeitGrenze).map((l) => l.b);
    let arten = await artenCim();
    if (!arten) arten = await artenFsutil(['C'].concat(vorhanden));
    e.windows.laufwerksarten = arten ? { quelle: arten.quelle, liste: arten.liste } : { quelle: null, liste: {} };
    const liste = arten ? arten.liste : {};
    info.erkennung = arten ? arten.quelle : 'marker';
    const m = /^([A-Za-z]):/.exec(ort);
    if (m) {
      const b = m[1].toUpperCase();
      info.ortLaufwerk = b + ':';
      if (liste[b]) {
        info.ortWechsel = liste[b].typ === 2;
        info.ortDateisystem = liste[b].fs;
      }
    } else {
      info.ortWechsel = false; // UNC-Pfad: Netzfreigabe
    }
    for (const b of vorhanden) {
      if (info.ortLaufwerk === b + ':') continue;
      const wurzel = b + ':\\';
      if ((liste[b] && liste[b].typ === 2) || hatNeuralOs(wurzel)) {
        info.kandidaten.push({ wurzel, laufwerk: b + ':', dateisystem: liste[b] ? liste[b].fs : null });
      }
    }
  } else if (process.platform === 'darwin') {
    const r = await lauf('/sbin/mount', [], { grenzeMs: 5000 });
    const eintraege = mountZeilenMac(r.out);
    ctx.mountEintraege = eintraege;
    info.erkennung = 'mount';
    const z = mountFuer(eintraege, echt(ort));
    if (z) {
      info.ortWechsel = z.punkt.startsWith('/Volumes/') && z.local;
      info.ortDateisystem = z.typ;
    }
    for (const k of eintraege) {
      if (!k.punkt.startsWith('/Volumes/') || !k.local || k.readOnly) continue;
      if (z && k.punkt === z.punkt) continue;
      info.kandidaten.push({ wurzel: k.punkt, laufwerk: null, dateisystem: k.typ });
    }
  } else {
    let text = '';
    try {
      text = fs.readFileSync('/proc/mounts', 'utf8');
    } catch (_) {
      text = '';
    }
    const eintraege = mountZeilenLinux(text);
    ctx.mountEintraege = eintraege;
    info.erkennung = 'proc';
    const istStickPunkt = (p) => /^\/(media|run\/media)\//.test(p);
    const z = mountFuer(eintraege, echt(ort));
    info.ortWechsel = !!(z && istStickPunkt(z.punkt));
    if (z) info.ortDateisystem = z.typ;
    for (const k of eintraege) {
      if (!istStickPunkt(k.punkt) || k.readOnly) continue;
      if (z && k.punkt === z.punkt) continue;
      info.kandidaten.push({ wurzel: k.punkt, laufwerk: null, dateisystem: k.typ });
    }
  }

  // Für Tests (und zum Nachstellen): Die Unterordner von --suche-in gelten
  // als eingesteckte Sticks. Die Messungen des Systems oben laufen trotzdem.
  if (ctx.sucheIn) {
    const basis = echt(ctx.sucheIn);
    let namen = [];
    try {
      namen = fs.readdirSync(basis).sort();
    } catch (_) {
      namen = [];
    }
    const wurzeln = namen.map((n) => path.join(basis, n)).filter(istOrdner);
    const ortEcht = echt(ort);
    info.erkennung = 'suche-in';
    info.ortWechsel = wurzeln.some((w) => innerhalb(ortEcht, w));
    info.kandidaten = wurzeln
      .filter((w) => !innerhalb(ortEcht, w))
      .map((w) => ({ wurzel: w, laufwerk: null, dateisystem: null }));
  }
  return info;
}

/**
 * Wo gemessen wird. Liegt der Starter auf einem Stick (erkannt oder am
 * Neural-OS-Aufbau), dort. Sonst auf dem ersten beschreibbaren Stick,
 * einer mit Neural OS zuerst. Sonst am Ort, und das Ergebnis sagt es.
 */
function messortWaehlen(ctx, info, e) {
  const aufbau = aufbauVon(ctx.ort);
  const ortIstStick = info.ortWechsel === true || !!aufbau;
  e.ort = {
    art: ortIstStick ? 'stick' : istProjektordner(ctx.ort) ? 'projektordner' : 'ordner',
    wechseldatentraeger: info.ortWechsel,
    laufwerk: info.ortLaufwerk,
    dateisystem: info.ortDateisystem,
    aufbau: aufbau ? aufbau.aufbau : null,
  };
  e.messort = {
    wo: 'am-ort',
    stickGesucht: !ortIstStick,
    stickGefunden: false,
    laufwerk: null,
    dateisystem: null,
    erkennung: info.erkennung,
    ordnerEntfernt: false,
    entferntBeiFertig: false,
  };
  if (!ortIstStick) {
    const sortiert = info.kandidaten.slice().sort((a, b) => Number(hatNeuralOs(b.wurzel)) - Number(hatNeuralOs(a.wurzel)));
    for (const k of sortiert) {
      const o = ordnerAnlegen(path.join(k.wurzel, ORDNER));
      if (o.fehler) continue;
      e.messort.wo = 'stick';
      e.messort.stickGefunden = true;
      e.messort.laufwerk = k.laufwerk;
      e.messort.dateisystem = k.dateisystem;
      return Object.assign(o, { amOrt: false, wurzel: k.wurzel });
    }
  }
  const o = ordnerAnlegen(path.join(ctx.ort, ORDNER));
  return Object.assign(o, { amOrt: true, wurzel: ctx.ort });
}

// ---------------------------------------------------------------------------
// Messen: Windows und Mac
// ---------------------------------------------------------------------------

async function messeWindows(ctx, e, mo) {
  const w = e.windows;
  const m = /^([A-Za-z]):/.exec(mo.wurzel);
  const b = m ? m[1].toUpperCase() : 'C';
  const befehlSprache = "$ExecutionContext.SessionState.LanguageMode; [IO.DriveInfo]::new('" + b + ":\\').DriveFormat";
  const befehlVerben =
    "$v = (New-Object -ComObject Shell.Application).Namespace(17).ParseName('" + b + ":').Verbs(); foreach ($x in $v) { $x.Name }";
  const [ps, verben, netsh] = await Promise.all([
    powershell(befehlSprache),
    powershell(befehlVerben),
    lauf(systemProgramm('netsh.exe'), ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { grenzeMs: 15000 }),
  ]);
  const psZeilen = ps.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  w.powershell = {
    laufwerk: b + ':',
    exit: ps.exit,
    sprache: psZeilen[0] || null,
    dateisystem: psZeilen[1] || null,
    ausgabe: sauber(ps.out + (ps.err ? ' | ' + ps.err : ''), [ctx.ort]).slice(0, 300),
    ms: ps.ms,
    fehler: ps.fehler,
  };
  w.verben = {
    laufwerk: b + ':',
    exit: verben.exit,
    namen: verben.out
      .split(/\r?\n/)
      .map((s) => s.replace(/&/g, '').trim())
      .filter(Boolean)
      .slice(0, 30),
    fehler: verben.fehler || (verben.exit ? sauber(verben.err, [ctx.ort]).slice(0, 160) : null),
    ms: verben.ms,
  };
  w.netsh = {
    exit: netsh.exit,
    bereiche: netshBereiche(netsh.out),
    ausgabe: netsh.out.slice(0, 3000),
    fehler: netsh.fehler,
  };
}

async function quarantaene(datei) {
  if (!datei || !fs.existsSync(datei)) return null;
  const r = await lauf('/usr/bin/xattr', ['-l', datei], { grenzeMs: 10000 });
  if (r.fehler) return { vorhanden: null, von: null, fehler: r.fehler };
  const m = /com\.apple\.quarantine:\s*([^\n]*)/.exec(r.out);
  if (!m) return { vorhanden: false, von: null };
  // "0083;66f1c2a3;Safari;UUID" – nur der Name des Programms, nicht die
  // UUID: die verweist auf den Download-Verlauf.
  const teile = m[1].split(';');
  return { vorhanden: true, von: teile[2] || null };
}

function modus(datei) {
  try {
    return (fs.statSync(datei).mode & 0o777).toString(8);
  } catch (err) {
    return err.code || null;
  }
}

function lesen(ordner) {
  if (!ordner) return null;
  try {
    fs.readdirSync(ordner);
    return 'ok';
  } catch (err) {
    return err.code || 'FEHLER';
  }
}

async function messeMac(ctx, e, mo) {
  const [ver, chip, uebersetzt] = await Promise.all([
    lauf('/usr/bin/sw_vers', ['-productVersion'], { grenzeMs: 5000 }),
    lauf('/usr/bin/uname', ['-m'], { grenzeMs: 5000 }),
    lauf('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], { grenzeMs: 5000 }),
  ]);
  const mac = e.mac;
  mac.version = ver.out.trim() || null;
  mac.chip = chip.out.trim() || null;
  mac.nodeUnterRosetta = uebersetzt.out.trim() === '1';
  if (mac.chip === 'arm64') {
    const r = await lauf('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { grenzeMs: 10000 });
    mac.rosetta = { exit: r.exit, fehler: r.fehler };
  } else {
    mac.rosetta = null;
  }
  const z = mountFuer(ctx.mountEintraege || [], echt(mo.wurzel));
  mac.mount = z ? { typ: z.typ, flags: z.flags, readOnly: z.readOnly, noexec: z.noexec, noowners: z.noowners } : null;
  if (z && z.punkt !== '/') {
    const r = await lauf('/usr/sbin/diskutil', ['info', '-plist', z.punkt], { grenzeMs: 15000 });
    mac.diskutil = Object.assign({ exit: r.exit }, plistWerte(r.out, ['FilesystemType', 'WritableVolume', 'Ejectable', 'Removable']));
  } else {
    mac.diskutil = null;
  }
  const starter = path.join(ctx.ort, 'Probelauf - Mac.command');
  const gefunden = ctx.probeApp || vorbereiteteProbe(ctx);
  const probe = gefunden ? path.join(gefunden.basis, 'Probe.app', 'Contents', 'MacOS', 'probe') : null;
  const [qStarter, qNode] = await Promise.all([quarantaene(starter), quarantaene(process.execPath)]);
  mac.quarantaene = { starter: qStarter, node: qNode, vorher: ctx.vorher || null };
  mac.modus = { starter: modus(starter), node: modus(process.execPath), probe: probe ? modus(probe) : null, skript: modus(__filename) };
  const a = aufbauVon(ctx.ort);
  const programm = a ? path.join(a.basis, 'app') : istProjektordner(ctx.ort) ? path.join(ctx.ort, 'src') : null;
  mac.lesen = { programm: programm ? lesen(programm) : null, stick: lesen(mo.wurzel) };
}

function messeLinux(ctx, e, mo) {
  const z = mountFuer(ctx.mountEintraege || [], echt(mo.wurzel));
  e.linux = { mount: z ? { typ: z.typ, readOnly: z.readOnly, noexec: z.noexec } : null };
}

// ---------------------------------------------------------------------------
// Probe.app (nur Mac, im Dienst)
// ---------------------------------------------------------------------------

/** Das Probe.app, das `--auf-stick` abgelegt hat, falls es eins gibt. */
function vorbereiteteProbe(ctx) {
  const a = aufbauVon(ctx.ort);
  const stellen = [];
  if (a && a.aufbau === 'inhalt') stellen.push(['inhalt', a.basis]);
  stellen.push(['wurzel', ctx.ort]);
  for (const [wo, basis] of stellen) {
    if (istDatei(path.join(basis, 'Probe.app', 'Contents', 'MacOS', 'probe'))) {
      return { wo, basis, ordner: path.join(ctx.ort, ORDNER), erstellt: false };
    }
  }
  return null;
}

/** Liegt schon ein Probe.app vom Vorbereiten da? Sonst legt der Dienst eins
 * in den Ordner PROBELAUF des Messorts, das beim Ende wieder verschwindet. */
function probeAppFinden(ctx, mo) {
  const vorhanden = vorbereiteteProbe(ctx);
  if (vorhanden) return vorhanden;
  if (!mo || mo.fehler) return null;
  try {
    probeAppSchreiben(mo.pfad);
  } catch (_) {
    return null;
  }
  return { wo: 'probelauf', basis: mo.pfad, ordner: mo.pfad, erstellt: true, aufStick: !mo.amOrt };
}

/**
 * Probe.app braucht den Port des Dienstes: neben dem Bündel im Ordner
 * PROBELAUF und im Temp-Ordner des Benutzers, falls macOS das Bündel per App
 * Translocation an einen anderen Ort versetzt. Gleich beim Finden, damit ein
 * schneller Doppelklick nicht ins Leere geht.
 */
function probeAppEinrichten(ctx, e) {
  try {
    if (!istOrdner(ctx.probeApp.ordner)) fs.mkdirSync(ctx.probeApp.ordner);
    fs.writeFileSync(path.join(ctx.probeApp.ordner, PORT_DATEI), String(ctx.port));
  } catch (_) {
    /* dann nur der Temp-Ordner */
  }
  try {
    fs.writeFileSync(path.join(os.tmpdir(), TMP_PORT_DATEI), String(ctx.port));
  } catch (_) {
    /* dann hilft nur die Datei am Stick */
  }
  if (!e.mac.probeApp) e.mac.probeApp = { wo: ctx.probeApp.wo, gestartet: false, perHttp: false, perDatei: false, versetzt: null };
}

function probeHinweis(p) {
  if (!p) return null;
  if (p.wo === 'inhalt') return 'Jetzt im Ordner Inhalt „Probe“ doppelklicken.';
  if (p.wo === 'wurzel') return 'Jetzt auf dem Stick „Probe“ doppelklicken.';
  if (p.aufStick) return 'Jetzt auf dem Stick im Ordner PROBELAUF „Probe“ doppelklicken.';
  return 'Jetzt im Ordner PROBELAUF „Probe“ doppelklicken.';
}

// ---------------------------------------------------------------------------
// Das Ergebnis
// ---------------------------------------------------------------------------

function leeresErgebnis(modusName) {
  const e = {
    probelauf: FORMAT,
    zeit: new Date().toISOString(),
    rechner: kennung(),
    system: systemInfo(),
    start: {
      modus: modusName,
      starterBisBereitMs: null,
      starterBeendet: null,
      starterEndeNachMs: null,
      dienstLebtWeiter: null,
      beobachtetS: null,
    },
    ort: null,
    messort: null,
    schreibprobe: null,
    umbenennen: null,
    fsync: null,
    ports: null,
    browser: null,
    antworten: {},
    fehler: [],
  };
  if (process.platform === 'win32') e.windows = {};
  if (process.platform === 'darwin') e.mac = {};
  return e;
}

/**
 * Alles messen, was ohne Browser geht. `mo` (der Ordner PROBELAUF am
 * Messort) bleibt stehen, bis `messortAufraeumen` ihn wegräumt: Am Mac liegt
 * darin womöglich noch das Probe.app.
 */
async function messen(ctx, e) {
  let info;
  try {
    info = await wechselInfo(ctx, e);
  } catch (err) {
    e.fehler.push('Laufwerke: ' + sauber(err.code || err.message, [ctx.ort]));
    info = { erkennung: null, ortWechsel: null, ortLaufwerk: null, ortDateisystem: null, kandidaten: [] };
  }
  const mo = messortWaehlen(ctx, info, e);
  ctx.messOrdner = mo;
  const abbruch = () => !!ctx.abbrechen;

  if (mo.fehler) {
    e.schreibprobe = { ok: false, ms: 0, fehler: mo.fehler };
    e.umbenennen = { anzahl: 0, ok: 0, fehler: {}, gesamtMs: 0, uebersprungen: mo.fehler };
    e.fsync = { dateiMs: null, dateiMaxMs: null, ordner: null, ordnerMs: null, fehler: mo.fehler };
  } else {
    e.schreibprobe = schreibprobe(mo.pfad);
    e.umbenennen = await umbenennenProbe(mo.pfad, abbruch);
    e.fsync = fsyncProbe(mo.pfad);
  }
  e.ports = await portProbe();

  if (process.platform === 'darwin' && ctx.modus === 'dienst') {
    ctx.probeApp = probeAppFinden(ctx, mo);
    if (ctx.probeApp) probeAppEinrichten(ctx, e);
  }
  try {
    if (process.platform === 'win32') await messeWindows(ctx, e, mo);
    else if (process.platform === 'darwin') await messeMac(ctx, e, mo);
    else messeLinux(ctx, e, mo);
  } catch (err) {
    e.fehler.push('System: ' + sauber(err.code || err.message, [ctx.ort]));
  }

  // Ist der Ordner auf einem fremden Stick und hält nichts mehr darin fest,
  // gleich wieder weg. Am Ort bleibt er für die Ergebnisdatei.
  const probeImOrdner = ctx.probeApp && ctx.probeApp.erstellt && ctx.probeApp.basis === mo.pfad;
  if (probeImOrdner && !mo.amOrt) e.messort.entferntBeiFertig = true;
  else if (!mo.amOrt || ctx.modus === 'trocken') messortAufraeumen(ctx, e);
  return e;
}

function messortAufraeumen(ctx, e) {
  const mo = ctx.messOrdner;
  if (!mo || mo.fehler) return;
  if (ctx.probeApp && ctx.probeApp.erstellt) probeAppLoeschen(ctx.probeApp.basis);
  if (ctx.probeApp) {
    weg(path.join(ctx.probeApp.ordner, PORT_DATEI));
    weg(path.join(ctx.probeApp.ordner, APP_DATEI));
  }
  const bleibt = mo.amOrt && ctx.modus === 'dienst';
  if (mo.erstellt && !bleibt) {
    try {
      fs.rmdirSync(mo.pfad);
      e.messort.ordnerEntfernt = true;
      e.messort.entferntBeiFertig = false;
    } catch (_) {
      /* nicht leer: dann gehört etwas darin nicht uns und bleibt */
    }
  }
}

function osName(p) {
  return p === 'win32' ? 'windows' : p === 'darwin' ? 'mac' : p;
}

function dateiName(e) {
  const d = new Date(e.zeit);
  const zwei = (n) => String(n).padStart(2, '0');
  const datum = d.getFullYear() + '-' + zwei(d.getMonth() + 1) + '-' + zwei(d.getDate()) + '-' + zwei(d.getHours()) + zwei(d.getMinutes());
  return osName(e.system.os) + '-' + e.rechner + '-' + datum + '.json';
}

// ---------------------------------------------------------------------------
// Der kurze Text zum Kopieren
// ---------------------------------------------------------------------------

function sek(ms) {
  if (typeof ms !== 'number') return '–';
  return (ms / 1000).toFixed(1).replace('.', ',') + ' s';
}

/** Kurze Dauern in ms, lange in s – "0,0 s" für 37 ms sagt nichts. */
function dauer(ms) {
  if (typeof ms !== 'number') return '–';
  return ms < 1000 ? zahl(ms) + ' ms' : sek(ms);
}

/** Deutsches Komma, höchstens eine Nachkommastelle. */
function zahl(n) {
  if (typeof n !== 'number') return '–';
  return String(Math.round(n * 10) / 10).replace('.', ',');
}

function jn(b) {
  return b === true ? 'ja' : b === false ? 'nein' : '–';
}

function kuerzen(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

const FRAGEN = {
  win32: [
    { id: 'fenster', text: 'Ist ein schwarzes Fenster offen geblieben?', kurz: 'Schwarzes Fenster offen geblieben' },
    { id: 'warnung', text: 'Kam eine Warnung (SmartScreen, Virenschutz)?', kurz: 'Warnung (SmartScreen, Virenschutz)' },
  ],
  darwin: [
    { id: 'terminal', text: 'Ist das Terminal-Fenster noch offen?', kurz: 'Terminal-Fenster noch offen' },
    { id: 'tcc', text: 'Hat macOS nach Zugriff auf einen Wechseldatenträger gefragt?', kurz: 'Frage nach Wechseldatenträger' },
    { id: 'meldung', text: 'Kam eine Meldung?', kurz: 'Meldung beim Öffnen von Probe', nachSekunden: 60 },
  ],
};

/** Höchstens drei Ja/Nein-Fragen, wörtlich aus dem Bauplan (2.2). */
function fragen(plattform) {
  return (FRAGEN[plattform] || []).map((f) => Object.assign({}, f));
}

function systemZeile(e) {
  const s = e.system || {};
  const name = s.os === 'win32' ? 'Windows' : s.os === 'darwin' ? 'macOS' : s.os === 'linux' ? 'Linux' : String(s.os || '?');
  const version = s.os === 'darwin' && e.mac && e.mac.version ? e.mac.version : s.version;
  return 'System: ' + name + ' ' + (version || '?') + ' · ' + (s.arch || '?') + ' · Node ' + (s.node || '?');
}

function ortZeile(e) {
  const o = e.ort;
  if (!o) return 'Ort: –';
  const art = { stick: 'Stick', projektordner: 'Projektordner', ordner: 'Ordner' }[o.art] || o.art;
  const wechsel =
    o.wechseldatentraeger === true
      ? 'Wechseldatenträger'
      : o.wechseldatentraeger === false
      ? 'kein Wechseldatenträger'
      : 'Wechseldatenträger unbekannt';
  const teile = [o.laufwerk, o.dateisystem].filter(Boolean).join(' ');
  const aufbau = o.aufbau ? ' · Aufbau ' + (o.aufbau === 'inhalt' ? 'Inhalt/' : 'alt') : '';
  return 'Ort: ' + art + aufbau + ' · ' + wechsel + (teile ? ' (' + teile + ')' : '');
}

function messortZeile(e) {
  const m = e.messort;
  if (!m) return 'Messort: –';
  const erkannt = m.erkennung ? ' · erkannt über ' + { cim: 'CIM', fsutil: 'fsutil', mount: 'mount', proc: '/proc/mounts', marker: 'Marker', 'suche-in': 'Testordner' }[m.erkennung] : '';
  if (m.wo === 'stick') {
    const teile = [m.laufwerk, m.dateisystem].filter(Boolean).join(' ');
    const weg = m.ordnerEntfernt ? 'danach entfernt' : m.entferntBeiFertig ? 'wird bei Fertig entfernt' : 'nicht entfernt';
    return 'Messort: eingesteckter Stick' + (teile ? ' (' + teile + ')' : '') + ' · PROBELAUF ' + weg + erkannt;
  }
  if (!m.stickGesucht) return 'Messort: am Ort' + erkannt;
  return 'Messort: am Ort · kein Stick gefunden' + erkannt;
}

function startZeile(e) {
  const s = e.start || {};
  if (s.modus === 'trocken') return 'Start: trocken (ohne Starter und Browser)';
  const teile = ['bereit nach ' + dauer(s.starterBisBereitMs)];
  if (s.starterBeendet === true) teile.push('Starter weg ' + dauer(s.starterEndeNachMs) + ' danach');
  else if (s.starterBeendet === false) teile.push('Starter nach ' + (s.beobachtetS || 30) + ' s noch da');
  else teile.push('Starter wird beobachtet');
  teile.push('Dienst lebt weiter: ' + jn(s.dienstLebtWeiter));
  return 'Start: ' + teile.join(' · ');
}

function probenZeilen(e) {
  const z = [];
  const s = e.schreibprobe;
  z.push('Schreibprobe: ' + (!s ? '–' : s.ok ? 'ok (' + dauer(s.ms) + ')' : 'FEHLER ' + s.fehler));
  const u = e.umbenennen;
  if (!u) z.push('Umbenennen: –');
  else if (u.uebersprungen) z.push('Umbenennen: übersprungen (' + u.uebersprungen + ')');
  else {
    const codes = Object.keys(u.fehler || {});
    const summe = codes.reduce((a, k) => a + u.fehler[k], 0);
    const art = codes.length ? ' (' + codes.map((k) => k + ' ' + u.fehler[k]).join(', ') + ')' : '';
    z.push('Umbenennen ' + u.anzahl + '×: ' + summe + ' Fehler' + art + ' · ' + dauer(u.gesamtMs));
  }
  const f = e.fsync;
  if (!f) z.push('fsync: –');
  else if (f.dateiMs === null) z.push('fsync: Datei ' + (f.fehler || '–') + ' · Ordner ' + (f.ordner || '–'));
  else z.push('fsync: Datei ' + zahl(f.dateiMs) + ' ms (max ' + zahl(f.dateiMaxMs) + ' ms) · Ordner ' + f.ordner);
  const p = e.ports;
  if (!p) z.push('Ports ' + PORT_VON + '–' + PORT_BIS + ': –');
  else {
    const belegt = p.liste.filter((x) => x[1] !== null).map((x) => x[0] + ' ' + x[1]);
    z.push(kuerzen('Ports ' + PORT_VON + '–' + PORT_BIS + ': ' + (p.liste.length - belegt.length) + '/' + p.liste.length + ' frei' + (belegt.length ? ' · ' + belegt.join(', ') : ''), 120));
  }
  return z;
}

function windowsZeilen(w) {
  const z = ['Windows:'];
  const ps = w.powershell;
  if (ps) {
    const grund = ps.fehler ? ' · ' + ps.fehler : '';
    z.push('  PowerShell' + (ps.laufwerk ? ' (' + ps.laufwerk + ')' : '') + ': ' + (ps.sprache || '–') + ' · ' + (ps.dateisystem || '–') + ' · Exit ' + ps.exit + grund);
  }
  const la = w.laufwerksarten;
  if (la) z.push('  Laufwerksarten über: ' + ({ cim: 'CIM', fsutil: 'fsutil' }[la.quelle] || 'nichts (weder CIM noch fsutil)'));
  const n = w.netsh;
  if (n) {
    const drin = (n.bereiche || []).filter((b) => b[1] >= PORT_VON && b[0] <= PORT_BIS).map((b) => b[0] + '–' + b[1]);
    const ohne = n.exit === 0 || n.exit === undefined ? '' : ' · Exit ' + n.exit;
    z.push(kuerzen('  Portsperren (netsh): ' + (n.bereiche || []).length + ' Bereiche · in ' + PORT_VON + '–' + PORT_BIS + ': ' + (drin.length ? drin.join(', ') : 'keine') + ohne, 120));
  }
  const v = w.verben;
  if (v) {
    const namen = v.namen || [];
    const auswerfen = namen.some((x) => /auswerfen|eject/i.test(x));
    const liste = namen.length ? ' · ' + namen.join(', ') : v.fehler ? ' · ' + v.fehler : '';
    z.push(kuerzen('  Auswerfen im Menü' + (v.laufwerk ? ' (' + v.laufwerk + ')' : '') + ': ' + jn(namen.length ? auswerfen : null) + liste, 120));
  }
  const l = w.laufwerke;
  if (l) {
    const auffaellig = l.filter((x) => x.zeitGrenze || x.code !== 'ENOENT' || x.ms >= 500);
    const fehlt = l.length - auffaellig.length;
    const teile = auffaellig.map((x) => x.b + ' ' + (x.zeitGrenze ? 'Zeitgrenze ' + sek(x.ms) : (x.code === null ? 'ok ' : x.code + ' ') + dauer(x.ms)));
    z.push(kuerzen('  Laufwerke D–Z: ' + (teile.length ? teile.join(' · ') : 'keins') + (fehlt ? ' · ' + fehlt + '× leer' : ''), 120));
  }
  return z;
}

function macZeilen(m) {
  const z = ['Mac:'];
  const rosetta = m.rosetta ? (m.rosetta.exit === 0 ? 'ja' : 'nein') : m.chip === 'arm64' ? '–' : 'nicht nötig';
  z.push('  macOS ' + (m.version || '–') + ' · Chip ' + (m.chip || '–') + ' · Rosetta ' + rosetta + ' · Node unter Rosetta: ' + jn(m.nodeUnterRosetta));
  if (m.mount) {
    const f = m.mount;
    z.push(kuerzen('  mount: ' + [f.typ].concat(f.flags || []).join(', ') + ' · noexec ' + jn(f.noexec) + ' · schreibgeschützt ' + jn(f.readOnly), 120));
  } else z.push('  mount: –');
  if (m.diskutil) {
    const d = m.diskutil;
    z.push('  diskutil: ' + (d.FilesystemType || '–') + ' · beschreibbar ' + jn(d.WritableVolume) + ' · auswerfbar ' + jn(d.Ejectable) + ' · Wechselmedium ' + jn(d.Removable));
  }
  if (m.quarantaene) {
    const q = m.quarantaene;
    const eins = (x) => (!x ? '–' : x.vorhanden ? 'ja' + (x.von ? ' (' + x.von + ')' : '') : x.vorhanden === false ? 'nein' : '–');
    const v = q.vorher || {};
    const vorher = q.vorher ? ' · vorher: Starter ' + (v.quarantaeneStarter || '–') + ', Node ' + (v.quarantaeneNode || '–') : '';
    z.push('  Quarantäne: Starter ' + eins(q.starter) + ' · Node ' + eins(q.node) + vorher);
  }
  if (m.modus) {
    const v = (m.quarantaene && m.quarantaene.vorher) || {};
    const vorher = v.modusStarter || v.modusNode ? ' · vorher: Starter ' + (v.modusStarter || '–') + ', Node ' + (v.modusNode || '–') : '';
    z.push('  Modus: Starter ' + m.modus.starter + ' · Node ' + m.modus.node + ' · Probe ' + (m.modus.probe || '–') + ' · Skript ' + m.modus.skript + vorher);
  }
  if (m.lesen) z.push('  Lesen: Programm ' + (m.lesen.programm || '–') + ' · Stick ' + (m.lesen.stick || '–'));
  if (m.probeApp) {
    const p = m.probeApp;
    z.push(
      '  Probe.app: ' +
        (p.gestartet ? 'gestartet (HTTP ' + jn(p.perHttp) + ', Datei ' + jn(p.perDatei) + ', versetzt ' + jn(p.versetzt) + ')' : 'nicht gemeldet')
    );
  }
  return z;
}

function browserZeile(b) {
  if (!b) return 'Browser: –';
  return (
    'Browser: ' +
    (b.name || '–') +
    ' · sicherer Kontext ' +
    jn(b.sichererKontext) +
    ' · localStorage ' +
    jn(b.localStorage) +
    ' · sessionStorage ' +
    jn(b.sessionStorage) +
    ' · Service Worker ' +
    jn(b.serviceWorker) +
    ' · Zwischenablage ' +
    jn(b.zwischenablage)
  );
}

/**
 * Der Text für [Ergebnis kopieren]: kurz (höchstens 40 Zeilen), nur was die
 * Entscheidungen aus Teil 3 brauchen, nichts Persönliches. Die volle
 * Messung steht in der Ergebnisdatei.
 */
function ergebnisText(e) {
  const z = [];
  z.push('Neural OS Probelauf ' + (e.probelauf || FORMAT) + ' · ' + String(e.zeit || '').slice(0, 16).replace('T', ' ') + ' UTC');
  z.push(systemZeile(e));
  const s = e.system || {};
  const boot =
    typeof s.bootZeitAbweichungS === 'number'
      ? s.bootZeitAbweichungS <= 2
        ? 'Bootzeit stabil'
        : 'Bootzeit schwankt um ' + s.bootZeitAbweichungS + ' s'
      : 'Bootzeit –';
  const seit = typeof s.uptimeS === 'number' ? ' (läuft seit ' + Math.round(s.uptimeS / 60) + ' min)' : '';
  z.push('Rechner: ' + (e.rechner || '–') + ' · ' + boot + seit);
  z.push(ortZeile(e));
  z.push(messortZeile(e));
  z.push(startZeile(e));
  z.push.apply(z, probenZeilen(e));
  if (e.windows) z.push.apply(z, windowsZeilen(e.windows));
  if (e.mac) z.push.apply(z, macZeilen(e.mac));
  if (e.linux && e.linux.mount) z.push('Linux: mount ' + e.linux.mount.typ + ' · noexec ' + jn(e.linux.mount.noexec));
  z.push(browserZeile(e.browser));
  const liste = fragen(e.system ? e.system.os : process.platform);
  const antworten = e.antworten || {};
  for (const f of liste) {
    if (f.nachSekunden && !antworten[f.id]) continue;
    z.push(f.kurz + ': ' + (antworten[f.id] || '–'));
  }
  if (e.fehler && e.fehler.length) z.push(kuerzen('Fehler: ' + e.fehler.join(' · '), 120));
  return z.slice(0, 40).join('\n');
}

// ---------------------------------------------------------------------------
// Die Seite im Browser
// ---------------------------------------------------------------------------

function seite() {
  // Schwarz-weiß wie die App, ein Blau (#2f7cf6 aus web/app.css). Alles
  // inline: Der Dienst liefert nichts anderes aus, und fremde Quellen sind
  // per Content-Security-Policy ohnehin gesperrt.
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Probelauf · Neural OS</title>
<style>
:root { color-scheme: dark; --bg:#090a0a; --flaeche:#101112; --fg:#eeeef0; --leise:#a4a6ac; --leiser:#6e7076;
  --linie:rgba(255,255,255,.08); --linie2:rgba(255,255,255,.16); --blau:#2f7cf6; --blau-hover:#4a8ef8; --blau-text:#6aa5ff; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 620px; margin: 0 auto; padding: 56px 20px 72px; }
.marke { font-size: 11px; letter-spacing: .34em; text-transform: uppercase; color: var(--leise); margin: 0 0 28px; }
h1 { font-size: 28px; font-weight: 600; letter-spacing: -.01em; margin: 0 0 6px; }
.stand { color: var(--leise); margin: 0 0 28px; min-height: 1.5em; }
.stand::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: var(--blau); margin: 0 10px 1px 0; vertical-align: middle; }
.stand.fertig::before { background: var(--fg); }
.zeile { display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 0; border-top: 1px solid var(--linie); }
.zeile:last-child { border-bottom: 1px solid var(--linie); }
.hinweis { color: var(--blau-text); }
.wahl { display: flex; gap: 8px; flex-shrink: 0; }
button { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--linie2);
  border-radius: 10px; padding: 7px 16px; cursor: pointer; transition: background .14s, border-color .14s; }
button:hover:not(:disabled) { border-color: rgba(255,255,255,.32); }
button[aria-pressed="true"] { background: var(--blau); border-color: var(--blau); color: #fff; }
.knoepfe { display: flex; flex-wrap: wrap; gap: 12px; margin: 32px 0 20px; }
.haupt { background: var(--blau); border-color: var(--blau); color: #fff; font-weight: 500; padding: 10px 20px; }
.haupt:hover:not(:disabled) { background: var(--blau-hover); border-color: var(--blau-hover); }
.haupt:disabled { background: transparent; border-color: var(--linie2); color: var(--leiser); cursor: default; }
.neben { padding: 10px 20px; }
.neben:disabled { color: var(--leiser); cursor: default; }
pre { margin: 0; padding: 16px; background: var(--flaeche); border: 1px solid var(--linie); border-radius: 12px;
  color: var(--leise); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word; }
:focus-visible { outline: 2px solid var(--blau-text); outline-offset: 2px; }
@media (max-width: 480px) { .zeile { flex-direction: column; align-items: flex-start; } }
</style>
</head>
<body>
<main>
  <p class="marke">Neural OS</p>
  <h1>Probelauf</h1>
  <p class="stand" id="stand" aria-live="polite">Misst …</p>
  <div id="liste"></div>
  <div class="knoepfe">
    <button type="button" class="haupt" id="kopieren" disabled>Ergebnis kopieren</button>
    <button type="button" class="neben" id="fertig">Fertig</button>
  </div>
  <pre id="text" hidden></pre>
</main>
<script>
(function () {
  'use strict';
  var KOPF = { 'X-Probelauf': '1', 'Content-Type': 'application/json' };
  var stand = null, aus = false, pannen = 0, kopiertBis = 0, zeilen = {};
  function $(id) { return document.getElementById(id); }
  function senden(pfad, daten) {
    return fetch(pfad, { method: 'POST', headers: KOPF, body: JSON.stringify(daten || {}) });
  }
  function geht(fn) { try { return !!fn(); } catch (e) { return false; } }
  function speicher(art) {
    return geht(function () {
      var s = window[art], k = 'neural-os-probelauf';
      s.setItem(k, '1'); var ok = s.getItem(k) === '1'; s.removeItem(k); return ok;
    });
  }
  senden('/api/browser', {
    ua: navigator.userAgent,
    sichererKontext: window.isSecureContext === true,
    localStorage: speicher('localStorage'),
    sessionStorage: speicher('sessionStorage'),
    serviceWorker: 'serviceWorker' in navigator,
    zwischenablage: !!(navigator.clipboard && navigator.clipboard.writeText)
  }).catch(function () {});

  function knopf(text, klasse) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    if (klasse) b.className = klasse; return b;
  }
  function zeileFuer(id, text) {
    if (zeilen[id]) return zeilen[id];
    var z = document.createElement('div'); z.className = 'zeile';
    var t = document.createElement('span'); t.textContent = text; z.appendChild(t);
    zeilen[id] = { el: z, text: t }; $('liste').appendChild(z); return zeilen[id];
  }
  function frageZeile(f) {
    var z = zeileFuer(f.id, f.text);
    if (!z.wahl) {
      z.wahl = document.createElement('div'); z.wahl.className = 'wahl';
      z.wahl.setAttribute('role', 'group'); z.wahl.setAttribute('aria-label', f.text);
      z.knoepfe = {};
      ['ja', 'nein'].forEach(function (a) {
        var b = knopf(a === 'ja' ? 'Ja' : 'Nein');
        b.addEventListener('click', function () {
          f.antwort = a; setzen(z, a);
          senden('/api/antwort', { id: f.id, antwort: a }).then(holen, function () {});
        });
        z.knoepfe[a] = b; z.wahl.appendChild(b);
      });
      z.el.appendChild(z.wahl);
    }
    return z;
  }
  function setzen(z, a) {
    z.knoepfe.ja.setAttribute('aria-pressed', String(a === 'ja'));
    z.knoepfe.nein.setAttribute('aria-pressed', String(a === 'nein'));
  }
  function zeichnen() {
    if (!stand) return;
    var s = $('stand');
    if (!aus) {
      s.textContent = stand.kernFertig ? 'Gemessen.' : 'Misst … ' + stand.sekunden + ' s';
      s.className = stand.kernFertig ? 'stand fertig' : 'stand';
    }
    if (stand.probe && stand.probe.hinweis) {
      var h = zeileFuer('probe', stand.probe.hinweis);
      h.text.className = 'hinweis';
      h.text.textContent = stand.probe.gestartet ? 'Probe hat sich gemeldet.' : stand.probe.hinweis;
    }
    stand.fragen.forEach(function (f) {
      if (!f.sichtbar) return;
      setzen(frageZeile(f), f.antwort);
    });
    var k = $('kopieren');
    k.disabled = !stand.kernFertig;
    if (Date.now() > kopiertBis) k.textContent = 'Ergebnis kopieren';
    if (stand.kernFertig) { var t = $('text'); t.hidden = false; t.textContent = stand.text; }
  }
  function holen() {
    if (aus) return Promise.resolve();
    return fetch('/api/stand', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      pannen = 0; stand = s; zeichnen();
    }, function () {
      if (++pannen >= 3 && !aus) { aus = true; $('stand').textContent = 'Probelauf ist aus.'; $('fertig').disabled = true; }
    });
  }
  function markieren() {
    var r = document.createRange(); r.selectNodeContents($('text'));
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function befehlKopieren(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta); return ok;
  }
  function gemeldet(wie) {
    var k = $('kopieren');
    k.textContent = wie === 'nein' ? 'Markiert – jetzt kopieren' : 'Kopiert';
    if (wie === 'nein') markieren();
    kopiertBis = Date.now() + 2500;
    if (!aus) senden('/api/browser', { kopiert: wie }).catch(function () {});
  }
  $('kopieren').addEventListener('click', function () {
    var text = stand && stand.text; if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { gemeldet('api'); },
        function () { gemeldet(befehlKopieren(text) ? 'befehl' : 'nein'); });
    } else gemeldet(befehlKopieren(text) ? 'befehl' : 'nein');
  });
  $('fertig').addEventListener('click', function () {
    var b = $('fertig'); b.disabled = true;
    senden('/api/fertig', {}).catch(function () {}).then(function () {
      aus = true; var s = $('stand'); s.textContent = 'Probelauf beendet.'; s.className = 'stand fertig';
    });
  });
  holen(); setInterval(holen, 1000);
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// --dienst
// ---------------------------------------------------------------------------

function vorherLesen(text) {
  if (!text) return null;
  const erlaubt = ['quarantaeneStarter', 'quarantaeneNode', 'modusStarter', 'modusNode'];
  const out = {};
  for (const teil of String(text).split(';')) {
    const i = teil.indexOf('=');
    if (i < 0) continue;
    const k = teil.slice(0, i);
    const v = teil.slice(i + 1);
    if (erlaubt.includes(k) && /^(ja|nein|[0-7]{3,4}|\?)$/.test(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function lebtPid(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Lebt der Dienst weiter, wenn der Starter (und unter Windows sein
 * Konsolenfenster) weg ist? Beobachtet `process.kill(ppid, 0)`. */
function starterBeobachten(e, starterPid, bereitAm) {
  return new Promise((resolve) => {
    const beginn = Date.now();
    let endeAm = null;
    const timer = setInterval(() => {
      const t = Date.now();
      if (endeAm === null && !lebtPid(starterPid)) {
        endeAm = t;
        e.start.starterBeendet = true;
        e.start.starterEndeNachMs = t - bereitAm;
      }
      const genug = endeAm !== null ? t - endeAm >= NACH_STARTER_MS : t - beginn >= BEOBACHTEN_MS;
      if (!genug) return;
      clearInterval(timer);
      if (endeAm === null) e.start.starterBeendet = false;
      e.start.dienstLebtWeiter = endeAm !== null ? true : null;
      e.start.beobachtetS = Math.round((t - beginn) / 1000);
      resolve();
    }, 200);
  });
}

function koerperLesen(req) {
  return new Promise((resolve) => {
    let text = '';
    let zuViel = false;
    req.setEncoding('utf8');
    req.on('data', (d) => {
      if (zuViel) return;
      text += d;
      if (text.length > KOERPER_MAX) zuViel = true;
    });
    req.on('end', () => {
      if (zuViel) return resolve(null);
      try {
        const v = JSON.parse(text || '{}');
        resolve(v && typeof v === 'object' ? v : {});
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve(null));
  });
}

function antworte(res, status, daten, art) {
  const text = typeof daten === 'string' ? daten : JSON.stringify(daten);
  res.writeHead(status, {
    'Content-Type': art || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(text);
}

function lauschen(server, port) {
  return new Promise((resolve) => {
    const nein = () => {
      server.removeListener('listening', ja);
      resolve(false);
    };
    const ja = () => {
      server.removeListener('error', nein);
      resolve(true);
    };
    server.once('error', nein);
    server.once('listening', ja);
    server.listen(port, '127.0.0.1');
  });
}

async function dienst(args) {
  // Das Arbeitsverzeichnis darf nicht auf dem Stick liegen, sonst hält der
  // Dienst ihn fest und Windows verweigert das Auswerfen (Bauplan S).
  try {
    process.chdir(os.tmpdir());
  } catch (_) {
    /* dann eben nicht */
  }
  // Terminal zu (Mac) soll den Dienst nicht mitnehmen.
  process.on('SIGHUP', () => {});

  const ctx = {
    modus: 'dienst',
    ort: path.resolve(args.ort || standardOrt()),
    sucheIn: args.sucheIn,
    vorher: vorherLesen(args.vorher),
    abbrechen: false,
  };
  const starterPid = process.ppid;
  const e = leeresErgebnis('dienst');
  const zustand = { kernFertig: false, beginn: Date.now(), seiteSeit: null, endet: false };
  const plattform = process.platform;
  const liste = fragen(plattform);
  let port = null;
  let leerlauf = null;
  let ergebnisPfad = null;
  let messung = Promise.resolve();

  const melden = (nachricht) => {
    if (process.send && process.connected) {
      try {
        process.send(nachricht);
      } catch (_) {
        /* Starter schon weg */
      }
    }
  };

  const sichtbar = (f) => {
    if (e.antworten[f.id]) return true;
    if (!f.nachSekunden) return true;
    const gestartet = e.mac && e.mac.probeApp && e.mac.probeApp.gestartet;
    return !gestartet && zustand.seiteSeit !== null && Date.now() - zustand.seiteSeit >= f.nachSekunden * 1000;
  };

  const stand = () => ({
    pid: process.pid,
    plattform,
    kernFertig: zustand.kernFertig,
    sekunden: Math.round((Date.now() - zustand.beginn) / 1000),
    text: ergebnisText(e),
    fragen: liste.map((f) => ({ id: f.id, text: f.text, antwort: e.antworten[f.id] || null, sichtbar: sichtbar(f) })),
    probe: ctx.probeApp ? { hinweis: probeHinweis(ctx.probeApp), gestartet: !!(e.mac.probeApp && e.mac.probeApp.gestartet) } : null,
  });

  /** Ergebnis am Ort ablegen; geht das nicht (schreibgeschützt), am Messort. */
  const speichern = () => {
    const name = dateiName(e);
    const orte = [path.join(ctx.ort, ORDNER)];
    if (ctx.messOrdner && !ctx.messOrdner.amOrt && !ctx.messOrdner.fehler) orte.push(ctx.messOrdner.pfad);
    if (ergebnisPfad) orte.unshift(path.dirname(ergebnisPfad));
    for (const o of orte) {
      try {
        if (!istOrdner(o)) fs.mkdirSync(o);
        schreibeDauerhaft(path.join(o, name), JSON.stringify(e, null, 2) + '\n');
        ergebnisPfad = path.join(o, name);
        return true;
      } catch (_) {
        /* nächster Ort */
      }
    }
    return false;
  };

  const probeGemeldet = (wie, daten) => {
    if (!e.mac) return;
    const p = e.mac.probeApp || (e.mac.probeApp = { wo: ctx.probeApp ? ctx.probeApp.wo : null, gestartet: false, perHttp: false, perDatei: false, versetzt: null });
    p.gestartet = true;
    if (wie === 'http') {
      p.perHttp = true;
      if (daten && (daten.versetzt === 'ja' || daten.versetzt === 'nein')) p.versetzt = daten.versetzt === 'ja';
      if (daten && daten.datei === 'ja') p.perDatei = true;
    } else p.perDatei = true;
    if (zustand.kernFertig) speichern();
  };

  let beendet = false;
  const beenden = async () => {
    if (beendet) return;
    beendet = true;
    zustand.endet = true;
    ctx.abbrechen = true;
    clearTimeout(leerlauf);
    await Promise.race([messung.catch(() => {}), warte(5000)]);
    messortAufraeumen(ctx, e);
    try {
      fs.unlinkSync(path.join(os.tmpdir(), TMP_PORT_DATEI));
    } catch (_) {
      /* nie angelegt */
    }
    e.system.bootZeitAbweichungS = Math.abs(bootZeit() - e.system.bootZeit);
    speichern();
    server.close();
    process.exit(0);
  };

  const neuerLeerlauf = () => {
    clearTimeout(leerlauf);
    leerlauf = setTimeout(beenden, LEERLAUF_MS);
  };

  const server = http.createServer(async (req, res) => {
    neuerLeerlauf();
    // Nur die eigene Adresse: schützt vor DNS-Rebinding von fremden Seiten.
    const host = String(req.headers.host || '');
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return antworte(res, 403, { fehler: 'Falscher Host.' });
    const url = String(req.url || '/').split('?')[0];
    if (req.method === 'GET' && url === '/') return antworte(res, 200, seite(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url === '/api/stand') return antworte(res, 200, stand());
    if (req.method !== 'POST') return antworte(res, 404, { fehler: 'Gibt es nicht.' });
    // Ein eigener Kopf erzwingt bei fremden Seiten eine CORS-Vorabfrage, die
    // hier nie beantwortet wird: Nur die eigene Seite (und Probe.app) darf.
    if (req.headers['x-probelauf'] !== '1') return antworte(res, 403, { fehler: 'Nur von der Probelauf-Seite.' });
    const daten = await koerperLesen(req);
    if (daten === null) return antworte(res, 413, { fehler: 'Zu groß.' });

    if (url === '/api/browser') {
      if (zustand.seiteSeit === null) zustand.seiteSeit = Date.now();
      const b = e.browser || (e.browser = {});
      if (typeof daten.ua === 'string') {
        b.ua = daten.ua.slice(0, 300);
        b.name = browserName(daten.ua);
      }
      for (const k of ['sichererKontext', 'localStorage', 'sessionStorage', 'serviceWorker', 'zwischenablage']) {
        if (typeof daten[k] === 'boolean') b[k] = daten[k];
      }
      if (['api', 'befehl', 'nein'].includes(daten.kopiert)) b.kopiert = daten.kopiert;
      if (zustand.kernFertig) speichern();
      return antworte(res, 200, { ok: true });
    }
    if (url === '/api/antwort') {
      const f = liste.find((x) => x.id === daten.id);
      if (!f || (daten.antwort !== 'ja' && daten.antwort !== 'nein')) return antworte(res, 400, { fehler: 'Unbekannt.' });
      e.antworten[f.id] = daten.antwort;
      if (zustand.kernFertig) speichern();
      return antworte(res, 200, { ok: true });
    }
    if (url === '/api/app-gestartet') {
      probeGemeldet('http', daten);
      return antworte(res, 200, { ok: true });
    }
    if (url === '/api/fertig') {
      res.on('finish', () => {
        beenden();
      });
      return antworte(res, 200, { ok: true });
    }
    return antworte(res, 404, { fehler: 'Gibt es nicht.' });
  });

  // Möglichst im Bereich 20000–29999, den auch die KI-Ports benutzen: So
  // prüft schon das Öffnen der Seite, ob der Browser dort hinkommt.
  let ok = false;
  for (let i = 0; i < 10 && !ok; i++) {
    const p = PORT_VON + Math.floor(Math.random() * (PORT_BIS - PORT_VON + 1));
    ok = await lauschen(server, p);
    if (ok) port = p;
  }
  if (!ok) {
    ok = await lauschen(server, 0);
    if (ok) port = server.address().port;
  }
  if (!ok) {
    melden({ fehler: { text: 'Kein freier Port.' } });
    process.exit(1);
  }
  ctx.port = port;
  e.dienst = { port, portImBereich: port >= PORT_VON && port <= PORT_BIS };
  const bereitAm = Date.now();
  e.start.starterBisBereitMs = typeof args.t0 === 'number' && args.t0 > 0 ? bereitAm - args.t0 : null;
  const url = 'http://127.0.0.1:' + port + '/';
  melden({ bereit: { url } });
  neuerLeerlauf();
  // Nach spätestens zwei Stunden ist Schluss, egal was die Seite macht.
  setTimeout(beenden, 2 * 60 * 60 * 1000).unref();

  // Probe.app kann sich auch nur per Datei melden (etwa wenn curl fehlt).
  const blick = setInterval(() => {
    if (zustand.endet || !ctx.probeApp || !e.mac || !e.mac.probeApp) return;
    if (!e.mac.probeApp.perDatei && istDatei(path.join(ctx.probeApp.ordner, APP_DATEI))) probeGemeldet('datei');
  }, 1000);
  blick.unref();

  const beobachtung = starterBeobachten(e, starterPid, bereitAm);
  messung = messen(ctx, e);
  messung.catch((err) => {
    e.fehler.push('Messung: ' + sauber(err && (err.code || err.message), [ctx.ort]));
  });
  await Promise.all([beobachtung, messung.catch(() => {})]);
  if (zustand.endet) return;
  e.system.bootZeitAbweichungS = Math.abs(bootZeit() - e.system.bootZeit);
  zustand.kernFertig = true;
  speichern();
}

// ---------------------------------------------------------------------------
// --start: der Starter
// ---------------------------------------------------------------------------

/** Den Browser öffnen. `NEURAL_OS_OEFFNER` lenkt die Adresse für Tests in
 * eine Datei um (wie im Bauplan für Paket S). */
function oeffnen(url) {
  const umleitung = process.env.NEURAL_OS_OEFFNER;
  if (umleitung) {
    fs.appendFileSync(umleitung, url + '\n');
    return Promise.resolve(true);
  }
  let befehl;
  let args;
  if (process.platform === 'win32') {
    // `start` ist ein cmd-Befehl; der leere Titel verhindert, dass cmd die
    // Adresse für den Fenstertitel hält.
    befehl = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    befehl = 'open';
    args = [url];
  } else {
    befehl = 'xdg-open';
    args = [url];
  }
  return new Promise((resolve) => {
    let kind;
    try {
      kind = spawn(befehl, args, { stdio: 'ignore', detached: true, windowsHide: true });
    } catch (_) {
      resolve(false);
      return;
    }
    kind.on('error', () => resolve(false));
    kind.unref();
    setTimeout(() => resolve(true), 300);
  });
}

async function starter(args) {
  const t0 = performance.timeOrigin || Date.now();
  const ort = path.resolve(args.ort || standardOrt());
  const dienstArgs = [__filename, '--dienst', '--ort', ort, '--t0', String(Math.round(t0))];
  if (args.sucheIn) dienstArgs.push('--suche-in', path.resolve(args.sucheIn));
  if (args.vorher) dienstArgs.push('--vorher', args.vorher);

  // Genau wie Paket S: abgelöst, ohne geerbte Ein-/Ausgabe (sonst stirbt das
  // Kind mit dem Terminal, und libuv setzt unter Windows CREATE_NO_WINDOW nur
  // ohne geerbten fd), cwd außerhalb des Sticks. Mehr Threads, damit ein
  // hängendes Netzlaufwerk beim stat nicht alle Dateizugriffe blockiert.
  const env = Object.assign({}, process.env, { UV_THREADPOOL_SIZE: '16' });
  let kind;
  try {
    kind = spawn(process.execPath, dienstArgs, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      cwd: os.tmpdir(),
      env,
    });
  } catch (err) {
    console.error(TEXTE.startFehler + ' ' + (err.code || err.message));
    return 1;
  }

  const antwort = await new Promise((resolve) => {
    const grenze = setTimeout(() => resolve({ fehler: { text: 'keine Antwort nach 120 s' } }), BEREIT_GRENZE_MS);
    const dauert = setTimeout(() => console.log(TEXTE.dauertNoch), DAUERT_NOCH_MS);
    const fertig = (x) => {
      clearTimeout(grenze);
      clearTimeout(dauert);
      resolve(x);
    };
    kind.on('message', (m) => {
      if (m && (m.bereit || m.fehler)) fertig(m);
    });
    kind.on('exit', (code) => fertig({ fehler: { text: 'Dienst endete (' + code + ')' } }));
    kind.on('error', (err) => fertig({ fehler: { text: err.code || err.message } }));
  });

  if (!antwort.bereit) {
    console.error(TEXTE.startFehler + ' ' + antwort.fehler.text);
    return 1;
  }
  try {
    kind.disconnect();
  } catch (_) {
    /* schon getrennt */
  }
  kind.unref();
  await oeffnen(antwort.bereit.url);
  return 0;
}

// ---------------------------------------------------------------------------
// --trocken
// ---------------------------------------------------------------------------

async function trocken(args) {
  const ctx = {
    modus: 'trocken',
    ort: path.resolve(args.ort || standardOrt()),
    sucheIn: args.sucheIn,
    vorher: vorherLesen(args.vorher),
    abbrechen: false,
  };
  const e = leeresErgebnis('trocken');
  await messen(ctx, e);
  e.system.bootZeitAbweichungS = Math.abs(bootZeit() - e.system.bootZeit);
  process.stdout.write(JSON.stringify(e, null, 2) + '\n');
  return 0;
}

// ---------------------------------------------------------------------------

function argumente(argv) {
  const a = { modus: null, ort: null, sucheIn: null, t0: null, vorher: null, stick: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--trocken' || x === '--start' || x === '--dienst') a.modus = x.slice(2);
    else if (x === '--auf-stick') {
      a.modus = 'auf-stick';
      a.stick = argv[++i];
    } else if (x === '--ort') a.ort = argv[++i];
    else if (x === '--suche-in') a.sucheIn = argv[++i];
    else if (x === '--t0') a.t0 = Number(argv[++i]);
    else if (x === '--vorher') a.vorher = argv[++i];
  }
  return a;
}

async function hauptprogramm(argv) {
  const a = argumente(argv);
  if (a.modus === 'auf-stick') {
    if (!a.stick) {
      console.error(TEXTE.aufruf);
      return 1;
    }
    try {
      const r = aufStick(a.stick);
      for (const d of r.dateien) console.log(path.relative(path.resolve(a.stick), d));
      return 0;
    } catch (err) {
      console.error(err.satz || err.message);
      return 1;
    }
  }
  if (a.modus === 'start') return starter(a);
  if (a.modus === 'trocken') return trocken(a);
  if (a.modus === 'dienst') {
    await dienst(a);
    return null; // Der Dienst endet selbst (Fertig, Leerlauf).
  }
  console.error(TEXTE.aufruf);
  return 1;
}

if (require.main === module) {
  hauptprogramm(process.argv.slice(2)).then(
    (code) => {
      if (typeof code === 'number') process.exit(code);
    },
    (err) => {
      console.error(TEXTE.startFehler + ' ' + sauber(err && (err.code || err.message)));
      process.exit(1);
    }
  );
}

module.exports = {
  kennung,
  fragen,
  ergebnisText,
  aufStick,
  netshBereiche,
  mountZeile,
  plistWerte,
  browserName,
  seite,
  TEXTE,
};
