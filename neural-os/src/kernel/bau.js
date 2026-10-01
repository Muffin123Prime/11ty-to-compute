'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Die Bau-Kennung: Welche Fassung des Programms ist das?
 *
 * Anlass (01.10.2026): Der Nutzer lud die neue ZIP, doppelklickte den neuen
 * Starter -- und sah weiter die alte App, die nur Claude kannte. Auf seinem
 * Rechner lief noch die alte Fassung mit demselben Datenordner; der Starter
 * fand sie im Laufzettel und öffnete nur den Browser zu ihr. Die Version in
 * package.json hilft dabei nicht: Sie heißt seit dem ersten Tag 0.1.0.
 *
 * Die Kennung ist ein Fingerabdruck des Programms selbst: SHA-256 über Pfad,
 * Größe und Inhalt jeder Datei unter bin/, src/ und web/ und über
 * package.json. Dieselben Dateien ergeben dieselbe Kennung, nach jedem
 * Entpacken; jede Änderung ergibt eine andere. Der Dienst schreibt sie in den
 * Laufzettel (src/kernel/laufzettel.js), der Starter vergleicht sie mit
 * seiner (bin/neural-os.js, cmdStarter).
 */

const WURZEL = path.resolve(__dirname, '..', '..');
const TEILE = ['package.json', 'bin', 'src', 'web'];
/** Mehr Dateien hat kein Neural OS; ein Ordner voller fremder Dateien soll den Start nicht aufhalten. */
const MAX_DATEIEN = 5000;

/** Je Programmordner einmal je Prozess: Der Code, der läuft, ändert sich nicht mehr. */
const gemerkt = new Map();

/** Alle Dateien unter `rel`, sortiert, mit "/" getrennt; Verknüpfungen zählen nicht. */
function sammeln(wurzel, rel, liste) {
  let st;
  try {
    st = fs.lstatSync(path.join(wurzel, rel));
  } catch {
    return;
  }
  if (st.isFile()) {
    liste.push(rel);
    return;
  }
  if (!st.isDirectory()) return;
  const namen = fs.readdirSync(path.join(wurzel, rel)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of namen) {
    if (liste.length > MAX_DATEIEN) return;
    sammeln(wurzel, `${rel}/${name}`, liste);
  }
}

/**
 * @param {{wurzel?:string}} [opts] nur für Tests: ein anderer Programmordner
 * @returns {string|null} 16 Hex-Zeichen, oder null, wenn sie sich nicht bilden lässt
 */
function kennung({ wurzel = WURZEL } = {}) {
  if (gemerkt.has(wurzel)) return gemerkt.get(wurzel);
  let wert = null;
  try {
    const dateien = [];
    for (const teil of TEILE) sammeln(wurzel, teil, dateien);
    if (dateien.length > 0 && dateien.length <= MAX_DATEIEN) {
      const h = crypto.createHash('sha256');
      for (const rel of dateien) {
        const inhalt = fs.readFileSync(path.join(wurzel, rel));
        h.update(`${rel}\0${inhalt.length}\0`);
        h.update(inhalt);
      }
      wert = h.digest('hex').slice(0, 16);
    }
  } catch {
    wert = null; // unlesbar: dann gilt, was vorher galt (kein Vergleich)
  }
  gemerkt.set(wurzel, wert);
  return wert;
}

module.exports = { kennung, WURZEL };
