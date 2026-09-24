'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Schreiben, das ein gezogener Stick überlebt.
 *
 * FAT und exFAT haben kein Journal, und Windows wie macOS puffern Schreibzugriffe
 * auf Wechseldatenträger. "Datei schreiben, umbenennen" allein garantiert
 * deshalb nicht, dass nach dem Abziehen die neue oder wenigstens die alte
 * Fassung da ist: Das Umbenennen kann auf dem Datenträger landen, bevor der
 * Inhalt dort ist. Die Reihenfolge hier ist die einzige, die das ausschließt:
 *
 *   tmp schreiben -> fsync(tmp) -> umbenennen -> fsync(Ordner)
 *
 * `fs` wird bei jedem Aufruf über das Modulobjekt angesprochen und nie
 * zerlegt. So können Tests (hier und in Paket H) einen Spion auf `node:fs`
 * setzen, und wer es genauer braucht, spielt über `{ fs }` ein eigenes ein.
 */

/**
 * Den Ordner selbst auf den Datenträger zwingen, damit ein Umbenennen oder
 * Löschen darin haltbar ist. Unter Windows lässt sich ein Ordner nicht so
 * öffnen, und manche Dateisysteme kennen fsync für Ordner nicht. Dann ist das
 * Umbenennen trotzdem atomar, nur die Reihenfolge-Garantie ist schwächer;
 * ein Fehler hier darf also nie das eigentliche Schreiben scheitern lassen.
 * Wie `fsyncDir` in src/sync/folder.js.
 * @param {string} dir
 * @param {{fs?:object}} [opts] eingespieltes fs (Tests)
 */
function fsyncOrdner(dir, { fs: f = fs } = {}) {
  let fd = null;
  try {
    fd = f.openSync(dir, 'r');
    f.fsyncSync(fd);
  } catch {
    /* siehe oben: bestmöglich, nie ein Grund zum Abbruch */
  } finally {
    if (fd !== null) {
      try { f.closeSync(fd); } catch { /* nichts mehr zu retten */ }
    }
  }
}

/**
 * Die Codes, mit denen Windows ein Umbenennen ablehnt, solange ein anderer
 * Prozess die Datei kurz offen hat: Virenschutz, Suchindex, Explorer-Vorschau.
 * Das vergeht nach Millisekunden. Andere Fehler (ENOENT, EROFS, ENOSPC) sind
 * echt und kommen sofort durch.
 */
const WINDOWS_VORUEBERGEHEND = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Insgesamt höchstens so lange warten; länger hält kein Scanner eine Datei. */
const WARTEN_HOECHSTENS_MS = 2000;
const ERSTE_PAUSE_MS = 20;

/**
 * Synchron schlafen, ohne die CPU zu belasten. `umbenennen` wird aus
 * synchronen Schreibpfaden aufgerufen (Tresor, Konfiguration); dort gibt es
 * kein `await`, und eine Warteschleife würde den Prozess heißlaufen lassen.
 */
function schlafeSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `fs.renameSync`, unter Windows mit Geduld.
 *
 * Unter Windows wird bei EPERM/EACCES/EBUSY wiederholt, mit Pausen von 20, 40,
 * 80, … ms, zusammen höchstens 2 s; danach kommt der letzte Fehler durch.
 * Gezählt wird die geplante Wartezeit, nicht die Wanduhr: So ist die Grenze
 * auch mit einem eingespielten `schlafe` (Tests) endlich. Auf anderen Systemen
 * bedeuten dieselben Codes wirklich "keine Rechte" und werden nicht wiederholt.
 *
 * @param {string} von
 * @param {string} nach
 * @param {{fs?:object, platform?:string, schlafe?:(ms:number)=>void}} [opts] Attrappen für Tests
 */
function umbenennen(von, nach, { fs: f = fs, platform = process.platform, schlafe = schlafeSync } = {}) {
  let gewartet = 0;
  let pause = ERSTE_PAUSE_MS;
  for (;;) {
    try {
      f.renameSync(von, nach);
      return;
    } catch (err) {
      const nochmal = platform === 'win32'
        && err && WINDOWS_VORUEBERGEHEND.has(err.code)
        && gewartet < WARTEN_HOECHSTENS_MS;
      if (!nochmal) throw err;
      const jetzt = Math.min(pause, WARTEN_HOECHSTENS_MS - gewartet);
      schlafe(jetzt);
      gewartet += jetzt;
      pause *= 2;
    }
  }
}

/**
 * Eine Datei so ersetzen, dass danach entweder die alte oder die neue Fassung
 * vollständig auf dem Datenträger liegt, auch wenn der Stick mittendrin
 * gezogen wird.
 *
 * Die tmp-Datei liegt im selben Ordner wie das Ziel, weil nur ein Umbenennen
 * innerhalb eines Dateisystems atomar ist. Ihr Name beginnt mit einem Punkt
 * (unsichtbar im Finder, übersehbar im Explorer) und trägt PID und Zufall, damit
 * zwei Prozesse nie dieselbe tmp-Datei beschreiben.
 *
 * Fehlende Ordner werden absichtlich **nicht** angelegt: Fehlt der Ordner,
 * ist meist der Stick weg, und am Mac würde ein `mkdir -p /Volumes/…` dann
 * still einen Ordner auf der eingebauten Platte anlegen.
 *
 * @param {string} ziel
 * @param {string|Buffer|Uint8Array} inhalt Zeichenketten werden als UTF-8 geschrieben
 * @param {{modus?:number, fs?:object, platform?:string, schlafe?:Function}} [opts]
 *   `modus` wie bei `open`; die Vorgabe 0o600 hält Daten vor anderen Konten
 *   verborgen (exFAT/FAT kennen keine Rechte und übergehen das).
 * @returns {string} das Ziel
 */
function schreibeDauerhaft(ziel, inhalt, { modus = 0o600, fs: f = fs, platform, schlafe } = {}) {
  const dir = path.dirname(ziel);
  const tmp = path.join(dir, `.${path.basename(ziel)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const daten = typeof inhalt === 'string' ? Buffer.from(inhalt, 'utf8') : Buffer.from(inhalt);
  let fd = null;
  try {
    // 'wx': eine gleichnamige Datei wäre ein fremder Schreibvorgang, nie überschreiben.
    fd = f.openSync(tmp, 'wx', modus);
    let geschrieben = 0;
    // writeSync darf weniger schreiben als verlangt (volle Platte, Signale).
    while (geschrieben < daten.length) {
      geschrieben += f.writeSync(fd, daten, geschrieben, daten.length - geschrieben);
    }
    f.fsyncSync(fd);
    f.closeSync(fd);
    fd = null;
    umbenennen(tmp, ziel, { fs: f, platform, schlafe });
  } catch (err) {
    if (fd !== null) {
      try { f.closeSync(fd); } catch { /* der Fehler oben ist der wichtigere */ }
    }
    try { f.unlinkSync(tmp); } catch { /* gab es nie oder ist schon weg */ }
    throw err;
  }
  fsyncOrdner(dir, { fs: f });
  return ziel;
}

/**
 * Dateien, die Betriebssysteme ungefragt auf Sticks legen. Sie sind nie
 * Nutzerdaten: Wer sie einliest, abgleicht oder als "unvollständige Kopie"
 * deutet, erzeugt Einträge, Warnungen oder gar Ordner wie `_.app`
 * (belegt, win-mac v4). Eingefroren, weil mehrere Pakete dieselbe Liste
 * teilen und keiner sie für alle anderen verändern darf.
 */
const OS_BEGLEITDATEIEN = Object.freeze([
  /^\._/, // AppleDouble: macOS legt zu jeder Datei auf FAT/exFAT einen "._"-Zwilling an
  '.DS_Store',
  '.Trashes',
  '.fseventsd',
  '.Spotlight-V100',
  '.TemporaryItems',
  '.apdisk',
  '.VolumeIcon.icns',
  '.metadata_never_index',
  'System Volume Information',
  '$RECYCLE.BIN',
  'desktop.ini',
  'Thumbs.db',
]);

/** Kleingeschrieben vorberechnet; Windows und macOS vergleichen Namen ohne Groß/Klein. */
const BEGLEIT_NAMEN = new Set(
  OS_BEGLEITDATEIEN.filter((e) => typeof e === 'string').map((e) => e.toLowerCase()),
);
const BEGLEIT_MUSTER = OS_BEGLEITDATEIEN.filter((e) => e instanceof RegExp);

/**
 * Ist dieser Eintrag eine Begleitdatei des Betriebssystems?
 * Erwartet einen einzelnen Namen, keinen Pfad: Wer einen Pfad übergibt, hat
 * sich vertan, und ein stilles "ja" würde echte Daten überspringen.
 * @param {string} name
 * @returns {boolean}
 */
function istBegleitdatei(name) {
  if (typeof name !== 'string' || !name) return false;
  if (BEGLEIT_NAMEN.has(name.toLowerCase())) return true;
  return BEGLEIT_MUSTER.some((muster) => muster.test(name));
}

module.exports = {
  schreibeDauerhaft,
  umbenennen,
  fsyncOrdner,
  OS_BEGLEITDATEIEN,
  istBegleitdatei,
};
