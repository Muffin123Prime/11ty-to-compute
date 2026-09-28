'use strict';

const fs = require('node:fs');
const path = require('node:path');

const rechner = require('./rechner');
const pathsMod = require('./paths');

/**
 * Wo ein Ordner liegt, so gespeichert, dass der Stick an jedem Rechner weiß,
 * ob er gemeint ist (Bauplan 2.7).
 *
 * Ein Stick wandert. `E:\Schule` heißt am Mac `/Volumes/NEURAL/Schule`, und
 * `C:\Users\max\Dokumente` gibt es an vielen Schulrechnern, aber jedes Mal mit
 * den Dokumenten eines anderen Menschen. Ein absoluter Pfad allein kann also
 * beides falsch machen: einen Ordner auf dem Stick an einem anderen Rechner
 * nicht mehr finden, und Dokumente eines fremden PCs einlesen.
 *
 * Deshalb zwei Arten von Einträgen:
 *   {ort:'stick',   rel}             POSIX-relativ zur Stick-Wurzel; gilt überall
 *   {ort:'rechner', rechner, pfad}   `rechner` = `rechner.profil()` (Rechner +
 *                                    Benutzerkonto); gilt nur dort
 *
 * Alte Einträge sind bloße Zeichenketten. Ohne Stick (Heim-Installation) steht
 * der Rechner fest, dort gelten sie wie bisher. Auf dem Stick gilt nur, was
 * auf dem Stick liegt: Von einer Zeichenkette lässt sich nicht beweisen, dass
 * sie zu diesem Rechner gehört.
 *
 * `rechner` und `fs` werden bei jedem Aufruf über das Modulobjekt gelesen,
 * damit Tests einen anderen Rechner einspielen können.
 */

/** Name des Ordners, in dem neue Sticks Programm und Daten tragen (Bauplan 2.10, Punkt 4). */
const INHALT = 'inhalt';

/**
 * Was auf einem Stick der alten Aufteilung (Markierung in der Wurzel) der KI
 * gehört. Klein geschrieben: FAT und exFAT unterscheiden nicht.
 * Wie `LAYOUT` in src/portable/stick.js, dazu `models` von älteren Sticks.
 */
const KI_EINTRAEGE = ['app', 'runtime', 'data', 'sync', 'sicherungen', 'models'];

/** Der Satz, den die Oberfläche wörtlich zeigt (Bauplan 1.8). */
const FREMDER_RECHNER = 'Gehört zu einem anderen Rechner.';
const KI_ORDNER = 'Hier liegt eine Neural-OS-KI.';

function istObjekt(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Windows und macOS vergleichen Namen ohne Groß/Klein (NTFS, FAT/exFAT, APFS). */
function ohneGross(pfad, plattform) {
  const system = plattform || (pfad === path.win32 ? 'win32' : process.platform);
  return system === 'win32' || system === 'darwin';
}

function teile(p, pfad) {
  return pfad.resolve(p).split(pfad.sep).filter(Boolean);
}

/**
 * Liegt `kind` in `eltern` (oder ist es)? Dann der Rest als POSIX-Pfad
 * ('' für "ist es"), sonst `null`. Segmentweise statt über `path.relative`,
 * weil `path.posix.relative` am Mac Groß/Klein unterscheidet, der Datenträger
 * aber nicht.
 */
function unterhalb(kind, eltern, { pfad = path, plattform } = {}) {
  const a = teile(eltern, pfad);
  const b = teile(kind, pfad);
  if (b.length < a.length) return null;
  const klein = ohneGross(pfad, plattform);
  for (let i = 0; i < a.length; i++) {
    const x = klein ? a[i].toLowerCase() : a[i];
    const y = klein ? b[i].toLowerCase() : b[i];
    if (x !== y) return null;
  }
  // Unter Windows auch das Laufwerk vergleichen: `teile` wirft die Wurzel
  // nicht weg ("E:"), aber `\\server\share` und `C:` dürfen nie gleich sein.
  if (pfad.parse(pfad.resolve(eltern)).root.toLowerCase() !== pfad.parse(pfad.resolve(kind)).root.toLowerCase()) {
    return null;
  }
  return b.slice(a.length).join('/');
}

/**
 * Die Wurzel des Sticks, von dem dieses Programm läuft, oder `null`.
 * `portable` ist das Ergebnis von `paths.portableInfo` (`{root, …}`) oder der
 * Wurzelpfad selbst. `root` ist der Ordner mit der Markierung; bei neuen
 * Sticks ist das `Inhalt/`, und die Wurzel ist eine Ebene höher.
 */
function stickWurzel(portable, { pfad = path } = {}) {
  let root = null;
  if (typeof portable === 'string') root = portable;
  else if (istObjekt(portable) && typeof portable.root === 'string') root = portable.root;
  if (!root || !root.trim()) return null;
  const abs = pfad.resolve(root);
  return pfad.basename(abs).toLowerCase() === INHALT ? pfad.dirname(abs) : abs;
}

function profilVon(profil) {
  if (typeof profil === 'function') return String(profil() || '');
  if (typeof profil === 'string') return profil;
  return rechner.profil();
}

function absolutOderNull(p, pfad) {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (!s || s.includes('\u0000') || !pfad.isAbsolute(s)) return null;
  return pfad.resolve(s);
}

/**
 * Einen absoluten Pfad so festhalten, dass er an jedem Rechner richtig
 * gedeutet wird.
 * @param {string} absolut
 * @param {{portable?:object|string|null, pfad?:object, plattform?:string, profil?:string|Function}} [opts]
 * @returns {{ort:'stick', rel:string}|{ort:'rechner', rechner:string, pfad:string}}
 */
function erfassen(absolut, { portable, pfad = path, plattform, profil } = {}) {
  const abs = pfad.resolve(String(absolut));
  const wurzel = stickWurzel(portable, { pfad });
  if (wurzel) {
    const rel = unterhalb(abs, wurzel, { pfad, plattform });
    if (rel !== null) return { ort: 'stick', rel };
  }
  return { ort: 'rechner', rechner: profilVon(profil), pfad: abs };
}

/**
 * Wo liegt der Eintrag an diesem Rechner?
 * @param {string|object} eintrag `{ort, rel|rechner+pfad}`, ein Datensatz mit
 *   `path` (beobachteter Ordner) oder eine alte Zeichenkette
 * @param {{portable?:object|string|null, pfad?:object, plattform?:string, profil?:string|Function}} [opts]
 * @returns {string|null} absoluter Pfad, oder `null`: gehört nicht hierher
 */
function aufloesen(eintrag, opts = {}) {
  const pfad = opts.pfad || path;
  const wurzel = stickWurzel(opts.portable, { pfad });

  if (typeof eintrag === 'string') {
    const abs = absolutOderNull(eintrag, pfad);
    if (abs === null) return null;
    if (!wurzel) return abs;
    return unterhalb(abs, wurzel, { pfad, plattform: opts.plattform }) !== null ? abs : null;
  }
  if (!istObjekt(eintrag)) return null;

  if (eintrag.ort === 'stick') {
    if (!wurzel || typeof eintrag.rel !== 'string' || eintrag.rel.includes('\u0000')) return null;
    const stuecke = eintrag.rel.split('/').filter((s) => s && s !== '.');
    if (stuecke.includes('..')) return null;
    const abs = stuecke.length ? pfad.resolve(pfad.join(wurzel, ...stuecke)) : wurzel;
    // Ein "\" in einem Namen vom Mac wäre unter Windows ein Trenner; was dabei
    // aus dem Stick hinausführt, gehört nicht hierher.
    return unterhalb(abs, wurzel, { pfad, plattform: opts.plattform }) !== null ? abs : null;
  }
  if (eintrag.ort === 'rechner') {
    if (typeof eintrag.rechner !== 'string' || !eintrag.rechner) return null;
    if (eintrag.rechner !== profilVon(opts.profil)) return null;
    return absolutOderNull(typeof eintrag.pfad === 'string' ? eintrag.pfad : eintrag.path, pfad);
  }
  // Ohne `ort`: Altbestand eines Datensatzes, gedeutet wie seine Zeichenkette.
  if (eintrag.ort === undefined || eintrag.ort === null) {
    if (typeof eintrag.path === 'string') return aufloesen(eintrag.path, opts);
  }
  return null;
}

/** Jeden Eintrag auflösen; was nicht hierher gehört, fällt weg, Doppeltes auch. */
function aufloesenListe(liste, opts = {}) {
  const out = [];
  if (!Array.isArray(liste)) return out;
  for (const eintrag of liste) {
    const abs = aufloesen(eintrag, opts);
    if (abs !== null && !out.includes(abs)) out.push(abs);
  }
  return out;
}

let gemerkterStick;

/**
 * Der Stick, von dem dieser Prozess läuft, für Aufrufer, denen niemand
 * `portable` mitgibt (Agenten-Rechte im Systemtext, `/api/agents`). Gesucht
 * wird wie beim Start, vom Programmordner aus; das Ergebnis ändert sich nicht,
 * solange der Prozess läuft (ohne Stick endet er, Bauplan 0.2).
 * @returns {object|null}
 */
function dieserStick() {
  if (gemerkterStick === undefined) {
    try {
      gemerkterStick = pathsMod.detectPortable() || null;
    } catch {
      gemerkterStick = null;
    }
  }
  return gemerkterStick;
}

/** `opts.portable`, wenn es jemand gesagt hat (auch `null`), sonst dieser Stick. */
function stickAus(opts) {
  return opts && opts.portable !== undefined ? opts.portable : dieserStick();
}

/* ------------------------------------------------ Hier liegt eine KI */

function istDatei(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function istOrdner(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Die Markierung eines Sticks in `dir`, gelesen; `{}`, wenn sie kaputt ist; sonst `null`. */
function markierungIn(dir) {
  const datei = path.join(dir, pathsMod.PORTABLE_MARKER);
  if (!istDatei(datei)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(datei, 'utf8'));
    return istObjekt(info) ? info : {};
  } catch {
    return {};
  }
}

/** Ein Datenordner von Neural OS: `vault/` mit `log/` und `files/` (paths.ensureLayout). */
function istDatenordner(dir) {
  return istOrdner(path.join(dir, 'vault', 'log')) && istOrdner(path.join(dir, 'vault', 'files'));
}

/**
 * Ist `dir` selbst eine KI: ein Datenordner, ein Ordner mit der Markierung
 * oder die Wurzel eines neuen Sticks (`Inhalt/` mit Markierung)?
 * Für den Rundlauf, der in solche Ordner nicht hinabsteigt.
 */
function istKiOrdner(dir) {
  return istDatenordner(dir)
    || markierungIn(dir) !== null
    || istDatei(path.join(dir, 'Inhalt', pathsMod.PORTABLE_MARKER))
    || istDatei(path.join(dir, 'inhalt', pathsMod.PORTABLE_MARKER));
}

/**
 * Liegt in `abs` eine Neural-OS-KI, oder liegt `abs` in einer?
 *
 * Verweigert wird, was eine KI ist oder zu ihr gehört: ein Datenordner und
 * alles darin, der Ordner mit der Markierung selbst, bei neuen Sticks alles in
 * `Inhalt/`, bei alten Sticks (Markierung in der Wurzel) Programm, Laufzeiten,
 * Daten, Abgleich und Sicherungen. Ein eigener Ordner des Nutzers auf dem
 * Stick, etwa `Schule`, gehört nicht dazu: Genau der soll an jedem Rechner
 * funktionieren (Bauplan 2.7, Ziel).
 * @param {string} abs aufgelöster absoluter Pfad
 * @returns {boolean}
 */
function kiBereich(abs) {
  let dir = path.resolve(abs);
  const darunter = []; // Namen von `dir` hinab bis `abs`
  for (;;) {
    if (istDatenordner(dir)) return true;
    const info = markierungIn(dir);
    if (info !== null) {
      if (!darunter.length) return true;
      if (path.basename(dir).toLowerCase() === INHALT) return true;
      const eigene = new Set(KI_EINTRAEGE);
      if (typeof info.dataDir === 'string' && info.dataDir) {
        const erster = info.dataDir.split(/[\\/]+/).filter((s) => s && s !== '.')[0];
        if (erster) eigene.add(erster.toLowerCase());
      }
      if (eigene.has(darunter[0].toLowerCase())) return true;
    }
    if (!darunter.length && istKiOrdner(dir)) return true;
    const eltern = path.dirname(dir);
    if (eltern === dir) return false;
    darunter.unshift(path.basename(dir));
    dir = eltern;
  }
}

module.exports = {
  erfassen,
  aufloesen,
  aufloesenListe,
  stickWurzel,
  unterhalb,
  dieserStick,
  stickAus,
  kiBereich,
  istKiOrdner,
  FREMDER_RECHNER,
  KI_ORDNER,
};
