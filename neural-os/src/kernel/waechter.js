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
 *  - wenn am selben Pfad ein ANDERER Stick steckt: schnell getauscht, unter
 *    Windows mit demselben Laufwerksbuchstaben. Ein Marker ist dann da, aber
 *    nicht unserer: andere `kiId`, ein anderes Gerät (`dev`, unter Windows die
 *    Seriennummer des Laufwerks) oder, außer unter Windows, ein anderer
 *    Ordner `data/` (dev/ino). Dann sofort `ende(0)`, ohne zu schreiben:
 *    Alles, was per Pfad geschrieben würde (config.json, Marker, Laufzettel),
 *    landete auf dem fremden Stick und machte ihn zum Zwilling (Prüfung
 *    Runde 2, s18);
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
 * @param {()=>string|null} [opts.kennung]  die Kennung dieser KI, jedes Mal frisch (sie kann sich erneuern)
 * @param {string|null} [opts.ordner]  `paths.home`, also `data/` auf dem Stick
 * @param {string} [opts.plattform]
 * @param {(p:string)=>Promise<string>} [opts.lesen]
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
  lesen = (p) => fs.promises.readFile(p, 'utf8'),
  kennung = null,
  ordner = null,
  plattform = process.platform,
  log = null,
} = {}) {
  const start = jetzt();
  let fehlt = 0;
  let statLaeuft = false;
  let letztePruefung = start;
  let zaehltAb = 0; // nur nach einem Zeitsprung gesetzt
  let beendet = false;
  const zeitgeber = [];
  // Woran der eigene Stick zu erkennen ist; beim ersten Blick gemerkt.
  let bezug = null;
  // Die Kennung, die zuletzt im Marker stand und passte. Während
  // `erneuern` steht kurz die alte im Marker und schon die neue im Speicher.
  let bisher = null;

  /** Was jetzt am Pfad steckt: null = unser Stick, sonst der Grund. */
  async function fremd(st) {
    const jetztBezug = { dev: st && st.dev, ordnerDev: undefined, ordnerIno: undefined };
    if (ordner && plattform !== 'win32') {
      const o = await stat(ordner);
      jetztBezug.ordnerDev = o && o.dev;
      jetztBezug.ordnerIno = o && o.ino;
    }
    let kiId;
    if (typeof kennung === 'function') {
      let info = null;
      try {
        info = JSON.parse(await lesen(marker));
      } catch (err) {
        if (err && WEG_CODES.has(err.code)) throw err;
        info = null; // gerade nicht lesbar: sagt nichts
      }
      if (info && typeof info === 'object') kiId = typeof info.kiId === 'string' && info.kiId ? info.kiId : null;
    }
    if (!bezug) {
      bezug = jetztBezug;
    } else {
      if (bezug.dev !== jetztBezug.dev) return 'anderes Gerät';
      if (bezug.ordnerDev !== jetztBezug.ordnerDev || bezug.ordnerIno !== jetztBezug.ordnerIno) return 'anderer Datenordner';
    }
    if (kiId === undefined) return null;
    let eigene = null;
    try { eigene = kennung(); } catch { eigene = null; }
    if (kiId === null) return bisher ? 'Marker ohne Kennung' : null;
    if (kiId === eigene || kiId === bisher || (!eigene && !bisher)) {
      if (kiId === eigene || !bisher) bisher = kiId;
      return null;
    }
    return 'andere KI';
  }

  async function pruefeStick() {
    if (!marker || beendet || statLaeuft) return;
    statLaeuft = true;
    try {
      const st = await stat(marker);
      const grund = await fremd(st);
      if (grund) {
        beendet = true;
        if (log && log.warn) log.warn(`Am Pfad des Sticks steckt ein anderer (${grund}); Neural OS endet sofort.`);
        ende(0);
        return;
      }
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

/**
 * Die Aktivität des Dienstes für den Leerlauf-Wächter. Läuft die Anwendung,
 * zählt ihr Server selbst (`server.aktivitaet()`). Davor, im Vorraum (PIN
 * noch nicht eingegeben), sieht niemand sonst die Anfragen: Sie werden hier
 * über den Diagnosekanal von node:http gezählt, der jede Anfrage jedes
 * HTTP-Servers dieses Prozesses meldet. Sonst endete ein Dienst, dessen
 * PIN-Seite offen ist und in den gerade getippt wird, nach 10 min als
 * "Leerlauf" (Prüfung von Welle 1). Die Gesundheitsabfrage zählt nicht: Sie
 * kommt vom Starter, nicht von einem Menschen.
 *
 * @param {{app:()=>object|null, vorraumOffen:()=>boolean, jetzt?:()=>number}} o
 * @returns {(()=>{streams:number, inFlight:number, letzteAnfrage:number}) & {abmelden:()=>void}}
 */
function dienstAktivitaet({ app = () => null, vorraumOffen = () => false, jetzt = Date.now } = {}) {
  const kanal = require('node:diagnostics_channel');
  let letzte = jetzt();
  let inFlight = 0;
  const beiAnfrage = (nachricht) => {
    if (!vorraumOffen()) return;
    const url = String((nachricht && nachricht.request && nachricht.request.url) || '');
    if (url === '/api/health' || url.startsWith('/api/health?')) return;
    inFlight += 1;
    letzte = jetzt();
    const antwort = nachricht && nachricht.response;
    if (antwort && typeof antwort.once === 'function') {
      antwort.once('close', () => {
        inFlight = Math.max(0, inFlight - 1);
        letzte = jetzt();
      });
    } else {
      inFlight = Math.max(0, inFlight - 1);
    }
  };
  kanal.subscribe('http.server.request.start', beiAnfrage);
  const aktivitaet = () => {
    const a = app();
    if (a && a.server && typeof a.server.aktivitaet === 'function') return a.server.aktivitaet();
    return { streams: 0, inFlight, letzteAnfrage: letzte };
  };
  aktivitaet.abmelden = () => kanal.unsubscribe('http.server.request.start', beiAnfrage);
  return aktivitaet;
}

module.exports = { starte, dienstAktivitaet, STICK_TAKT_MS, LEERLAUF_TAKT_MS, LEERLAUF_MS, SCHONFRIST_MS, SPRUNG_MS };
