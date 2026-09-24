'use strict';

const fs = require('node:fs');

/**
 * Der Wächter des Dienstes (Stick-Bauplan 2.4, Paket S): Ohne Fenster sieht
 * niemand, ob Neural OS noch läuft. Also endet es von selbst,
 *
 *  - wenn der Stick weg ist: alle 2 s `stat(marker)`; zweimal hintereinander
 *    ENOENT/EIO/ENODEV/ENXIO -> sofort `ende(0)`, OHNE flush. `node.exe` liegt
 *    selbst auf dem Stick, ein Server ohne Stick kann nichts mehr retten und
 *    nur noch Daten aus dem Speicher ausliefern (Bauplan 0.2);
 *  - im Leerlauf: alle 15 s; kein offener Tab (`streams === 0`), keine
 *    laufende Anfrage, die letzte über 10 min her und der Start über 5 min
 *    her -> `beenden('leerlauf')`, also sauber mit Speichern.
 *
 * Eine Lücke von über 60 s zwischen zwei Prüfungen ist ein Ruhezustand
 * (Deckel zu). Danach zählt die Zeit neu: Wer den Laptop aufklappt, soll
 * nicht als Erstes ein beendetes Neural OS vorfinden.
 *
 * Uhr, Zeitgeber und `stat` sind einspielbar (Tests).
 */

const STICK_TAKT_MS = 2000;
const LEERLAUF_TAKT_MS = 15 * 1000;
const LEERLAUF_MS = 10 * 60 * 1000;
const SCHONFRIST_MS = 5 * 60 * 1000;
const SPRUNG_MS = 60 * 1000;
const WEG_CODES = new Set(['ENOENT', 'EIO', 'ENODEV', 'ENXIO']);

/**
 * @param {object} opts
 * @param {string|null} opts.marker   `portable.marker`; ohne Marker (Heim-Installation) kein Stick-Wächter
 * @param {()=>{streams:number, inFlight:number, letzteAnfrage:number}} opts.aktivitaet
 * @param {(grund:string)=>any} opts.beenden   sauberes Ende (app.close, Laufzettel, exit)
 * @param {(code:number)=>any} [opts.ende]     hartes Ende, Vorgabe process.exit
 * @param {()=>number} [opts.jetzt]
 * @param {Function} [opts.setInterval] @param {Function} [opts.clearInterval]
 * @param {(p:string)=>Promise<any>} [opts.stat]
 * @param {{warn:Function, info:Function}} [opts.log]
 */
function starte({
  marker = null,
  aktivitaet,
  beenden,
  ende = (code) => process.exit(code),
  jetzt = Date.now,
  setInterval: planen = setInterval,
  clearInterval: abbrechen = clearInterval,
  stat = (p) => fs.promises.stat(p),
  log = null,
} = {}) {
  const start = jetzt();
  let fehlt = 0;
  let statLaeuft = false;
  let letztePruefung = start;
  let zaehltAb = 0; // nur nach einem Zeitsprung gesetzt
  let beendet = false;
  const zeitgeber = [];

  async function pruefeStick() {
    if (!marker || beendet || statLaeuft) return;
    statLaeuft = true;
    try {
      await stat(marker);
      fehlt = 0;
    } catch (err) {
      if (err && WEG_CODES.has(err.code)) {
        fehlt += 1;
        if (fehlt >= 2) {
          beendet = true;
          if (log && log.warn) log.warn('Der Stick ist weg; Neural OS endet sofort.');
          ende(0);
        }
      } else {
        fehlt = 0;
      }
    } finally {
      statLaeuft = false;
    }
  }

  function pruefeLeerlauf() {
    if (beendet) return;
    const t = jetzt();
    if (t - letztePruefung > SPRUNG_MS) zaehltAb = t; // Ruhezustand: neu zählen
    letztePruefung = t;
    let a;
    try {
      a = aktivitaet() || {};
    } catch {
      return;
    }
    if (Number(a.streams) > 0 || Number(a.inFlight) > 0) return;
    const zuletzt = Math.max(Number(a.letzteAnfrage) || 0, zaehltAb);
    if (t - zuletzt <= LEERLAUF_MS) return;
    if (t - start <= SCHONFRIST_MS) return;
    beendet = true;
    if (log && log.info) log.info('10 min ohne offenen Tab; Neural OS endet.');
    beenden('leerlauf');
  }

  const merke = (h) => {
    if (h && typeof h.unref === 'function') h.unref();
    zeitgeber.push(h);
  };
  if (marker) merke(planen(() => { pruefeStick(); }, STICK_TAKT_MS));
  merke(planen(pruefeLeerlauf, LEERLAUF_TAKT_MS));

  return {
    pruefeStick,
    pruefeLeerlauf,
    stoppe() {
      while (zeitgeber.length) abbrechen(zeitgeber.pop());
    },
  };
}

module.exports = { starte, STICK_TAKT_MS, LEERLAUF_TAKT_MS, LEERLAUF_MS, SCHONFRIST_MS, SPRUNG_MS };
