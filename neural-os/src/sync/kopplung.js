'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const defaultMerge = require('./merge');
const { createFolderSync, DEVICE_ID_RE } = require('./folder');
const { withActor } = require('../kernel/actor');
const { schreibeDauerhaft } = require('../kernel/dateien');
const { PORTABLE_MARKER, gleicherPfad } = require('../kernel/paths');
const { NeuralError, ValidationError, StorageError, LockedError, asNeuralError } = require('../kernel/errors');

/**
 * Koppeln (Bauplan 2.8): Zwei oder mehr Sticks teilen ihr Wissen und bleiben
 * abgeglichen, über die `sync/`-Ordner auf den Sticks selbst. Keiner muss
 * dafür gleichzeitig laufen.
 *
 *   <Stick>/[Inhalt/]neural-os.portable         Marker: kiId, name (Klartext)
 *   <Stick>/[Inhalt/]data/kopplungen.json       dieser Dienst; mit PIN versiegelt
 *   <Stick>/[Inhalt/]sync/<eigene-id>/          eigenes Postfach
 *   <Stick>/[Inhalt/]sync/<partner-id>/         Postfach, das ein Partner hier abgelegt hat
 *   <Stick>/[Inhalt/]sync/koppeln/<id>.angebot  Kopplungsangebot
 *   <Stick>/[Inhalt/]sync/koppeln/<id>.entkoppelt
 *
 * Die Heim-Installation hat kein eigenes `sync/`; sie schreibt nur in
 * `P:/sync/<heim-id>/` und liest `P:/sync/<P>/`.
 *
 * Koppeln: A erzeugt je Paar einen Schlüssel und legt ihn als Angebot auf B
 * (hat B eine PIN, mit dem Datenschlüssel von B versiegelt; die PIN von B
 * öffnet dessen Tresor dafür nur im Speicher). B nimmt beim nächsten Start
 * oder Suchlauf an. Wer beide Sticks in der Hand hat und die PIN von B kennt,
 * darf koppeln; ein zweiter Klick auf B brächte keine Sicherheit.
 *
 * Abgleichen: erst die Postfächer der Partner lesen (aus dem eigenen `sync/`
 * und aus dem `sync/` jedes steckenden Partners), dann das eigene schreiben
 * (ins eigene `sync/` und auf jeden steckenden Partner). Alles in EINER
 * Warteschlange: zwei Auslöser laufen nacheinander, nie gleichzeitig.
 */

const DATEI = 'kopplungen.json';
const ZUSTAND_VERSION = 1;
/** So viele eigene Generationen reisen als Verlauf mit (Zwillingserkennung). */
const VERLAUF_MAX = 64;
/** So viele Suchläufe ohne Fund (je 15 s), dann gilt eine gelöschte Kopie als weg. */
/** Entkoppel-Nachricht, die auf dem EIGENEN Stick für den Partner liegt: <Partner>.abmeldung */
const ABMELDUNG = '.abmeldung';
const ZWILLING_WEG_NACH = 3;
const SCHLUESSEL_BYTES = 32;
const NAME_MAX = 60;
const FASSUNGEN_MAX = 20;

const STANDARD_ZEITEN = Object.freeze({
  /** Suchlauf nach steckenden Partnern. */
  suchlaufMs: 15000,
  /** Abgleich so lange nach der letzten Änderung. */
  ruheMs: 20000,
  /** Erster Abgleich nach dem Start; vorher laufen Einführung und Server an. */
  startMs: 1500,
  /** So lange darf ein Einhängepunkt für eine Antwort brauchen. */
  zeitgrenzeMs: 1500,
  /** So lange wird ein Einhängepunkt übersprungen, der nicht antwortete. */
  sperreMs: 5 * 60 * 1000,
});

function nowIso() {
  return new Date().toISOString();
}

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

function hmac(schluessel, text) {
  return crypto.createHmac('sha256', schluessel).update(text, 'utf8').digest('hex');
}

function schluesselAus(text) {
  if (typeof text !== 'string' || !text) return null;
  const buf = Buffer.from(text, 'base64');
  return buf.length === SCHLUESSEL_BYTES ? buf : null;
}

function kurzName(id) {
  return `KI ${String(id || '').slice(4, 8).toUpperCase()}`;
}

function sauberName(name) {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = [...name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, NAME_MAX).join('');
  return s || null;
}

/** "1.10.0" gegen "1.9.3": Zahlen, nicht Zeichen. */
function vergleicheVersion(a, b) {
  const teile = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = teile(a);
  const y = teile(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  }
  return 0;
}

function leerZustand() {
  return {
    v: ZUSTAND_VERSION,
    eigeneGeneration: 0,
    letzterInhalt: null,
    verlauf: [],
    verlaufGekuerzt: false,
    zwilling: null,
    partner: [],
    ausstehend: [],
  };
}

function normalisieren(roh) {
  const z = leerZustand();
  if (!roh || typeof roh !== 'object') return z;
  z.eigeneGeneration = Number.isInteger(roh.eigeneGeneration) && roh.eigeneGeneration > 0 ? roh.eigeneGeneration : 0;
  z.letzterInhalt = typeof roh.letzterInhalt === 'string' ? roh.letzterInhalt : null;
  z.verlauf = Array.isArray(roh.verlauf)
    ? roh.verlauf.filter((e) => Array.isArray(e) && Number.isInteger(e[0]) && typeof e[1] === 'string').slice(-VERLAUF_MAX)
    : [];
  z.verlaufGekuerzt = roh.verlaufGekuerzt === true;
  z.zwilling = roh.zwilling && typeof roh.zwilling === 'object' ? roh.zwilling : null;
  z.partner = Array.isArray(roh.partner)
    ? roh.partner.filter((p) => p && DEVICE_ID_RE.test(p.id) && schluesselAus(p.schluessel)).map((p) => ({
      id: p.id,
      name: sauberName(p.name) || kurzName(p.id),
      schluessel: p.schluessel,
      seit: typeof p.seit === 'string' ? p.seit : null,
      zustand: p.zustand === 'wartet' ? 'wartet' : 'aktiv',
      gesehen: Number.isInteger(p.gesehen) && p.gesehen > 0 ? p.gesehen : 0,
      gesehenInhalt: typeof p.gesehenInhalt === 'string' ? p.gesehenInhalt : null,
      quittung: Number.isInteger(p.quittung) && p.quittung > 0 ? p.quittung : 0,
      zuletzt: typeof p.zuletzt === 'string' ? p.zuletzt : null,
      ueber: Array.isArray(p.ueber) ? p.ueber.filter((u) => u && typeof u.id === 'string') : [],
      version: typeof p.version === 'string' ? p.version : null,
      erster: p.erster === true,
    }))
    : [];
  z.ausstehend = Array.isArray(roh.ausstehend)
    ? roh.ausstehend.filter((a) => a && DEVICE_ID_RE.test(a.an) && a.nachricht && typeof a.nachricht === 'object')
    : [];
  return z;
}

/**
 * Die Naht zu src/sync/folder.js (`deps.postfach`): Paarschlüssel, eigene
 * Generation und Verlauf, was von jedem Partner schon gelesen wurde. Alles
 * lebt in kopplungen.json; `zustand()` liefert das lebende Objekt, `sichern()`
 * schreibt es (und wirft, wenn das nicht geht: Dann wird auch kein Postfach
 * geschrieben).
 *
 * @param {{zustand:()=>object, sichern:()=>void, ich:()=>string}} p
 */
function createPostfach({ zustand, sichern, ich }) {
  const partnerVon = (id) => zustand().partner.find((p) => p.id === id) || null;

  return {
    /** Für wen das eigene Postfach geschrieben wird. */
    empfaenger() {
      return zustand().partner
        .map((p) => ({ id: p.id, name: p.name, schluessel: schluesselAus(p.schluessel) }))
        .filter((e) => e.schluessel);
    },
    schluessel(id) {
      const p = partnerVon(id);
      return p ? schluesselAus(p.schluessel) : null;
    },
    kennt(id) {
      return !!partnerVon(id);
    },
    stand() {
      const z = zustand();
      return {
        generation: z.eigeneGeneration || 0,
        verlauf: z.verlauf.map((e) => [e[0], e[1]]),
        voll: z.verlaufGekuerzt !== true,
      };
    },
    /**
     * Die Generation für diesen Inhalt. Derselbe Inhalt behält seine
     * Generation (zwei Zielordner, ein Stand); ein neuer bekommt
     * max(eigene, höchste Quittung eines Partners) + 1 – die Quittung heilt
     * einen zurückgesetzten Zähler. Gemerkt wird VOR dem Schreiben.
     */
    vergeben(inhalt) {
      const z = zustand();
      const quittung = Math.max(0, ...z.partner.map((p) => p.quittung || 0));
      const bisher = z.eigeneGeneration || 0;
      if (bisher > 0 && z.letzterInhalt === inhalt && bisher >= quittung) return bisher;
      const generation = Math.max(bisher, quittung) + 1;
      z.eigeneGeneration = generation;
      z.letzterInhalt = inhalt;
      z.verlauf = [...z.verlauf, [generation, inhalt]];
      if (z.verlauf.length > VERLAUF_MAX) {
        z.verlauf = z.verlauf.slice(-VERLAUF_MAX);
        z.verlaufGekuerzt = true;
      }
      sichern();
      return generation;
    },
    gelesen(id) {
      const p = partnerVon(id);
      return p
        ? { generation: p.gesehen || 0, inhalt: p.gesehenInhalt || null, quittung: p.quittung || 0 }
        : { generation: 0, inhalt: null, quittung: 0 };
    },
    merkeGelesen(id, info = {}) {
      const p = partnerVon(id);
      if (!p) return;
      const selbst = ich();
      p.gesehen = Number.isInteger(info.generation) ? info.generation : p.gesehen;
      p.gesehenInhalt = typeof info.inhalt === 'string' ? info.inhalt : null;
      p.quittung = Math.max(p.quittung || 0, Number.isInteger(info.quittung) ? info.quittung : 0);
      if (Array.isArray(info.partner)) {
        p.ueber = info.partner
          .filter((x) => x && typeof x.id === 'string' && x.id !== selbst && x.id !== id)
          .map((x) => ({ id: x.id, name: sauberName(x.name) }));
      }
      const name = sauberName(info.name);
      if (name) p.name = name;
      if (typeof info.version === 'string') p.version = info.version;
      p.zuletzt = typeof info.at === 'string' ? info.at : nowIso();
      p.zustand = 'aktiv';
      p.erster = false;
      sichern();
    },
  };
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.paths          `home`: dort liegt kopplungen.json
 * @param {object} deps.identitaet     Kennung und Name dieser KI (src/kernel/identitaet.js)
 * @param {object} [deps.portable]     aus paths.portableInfo; ohne: Heim-Installation
 * @param {object} [deps.vaultCrypto]  versiegelt kopplungen.json und sync-folder.json
 * @param {object} [deps.history]      der erste Abgleich nach dem Koppeln läuft unter suspend()
 * @param {{aussetzen:Function, nachholen:Function}} [deps.ableitung]
 *   Die Ableitung der Verknüpfungen ruht, während Sätze eines Partners
 *   ankommen (sonst legte sie zu jeder Notiz eigene Kanten mit zufälliger ID
 *   an, zusätzlich zu denen, die im Postfach mitkommen), und wird danach
 *   einmal nachgeholt.
 * @param {object} [deps.bus]
 * @param {object} [deps.config]
 * @param {Function|object} [deps.logger]
 * @param {string} [deps.version]      Programmversion (für "älter"/"neuer")
 * @param {boolean} [deps.automatisch=true] Zeitgeber und Bus-Auslöser
 * @param {()=>string[]|Promise<string[]>} [deps.einhaengepunkte] Tests
 * @param {object} [deps.dateisystem]  fs.promises-artig, nur für finden() (Tests: Spion)
 * @param {string} [deps.plattform]
 * @param {object} [deps.zeiten]
 */
function createKopplung(deps = {}) {
  const { store, paths, identitaet } = deps;
  if (!store || !paths || typeof paths.home !== 'string') throw new ValidationError('createKopplung braucht store und paths.');
  if (!identitaet || typeof identitaet !== 'object') throw new ValidationError('createKopplung braucht die Identität dieser KI.');
  const portable = deps.portable && typeof deps.portable.root === 'string' ? deps.portable : null;
  const vaultCrypto = deps.vaultCrypto || null;
  const history = deps.history || null;
  const bus = deps.bus || null;
  const merge = deps.merge || defaultMerge;
  const log = typeof deps.logger === 'function' ? deps.logger('sync.kopplung') : (deps.logger || nullLogger());
  const version = typeof deps.version === 'string' ? deps.version : require('../../package.json').version;
  const automatisch = deps.automatisch !== false;
  const zeiten = { ...STANDARD_ZEITEN, ...(deps.zeiten || {}) };
  const dateisystem = deps.dateisystem || fs.promises;
  const plattform = deps.plattform || process.platform;
  const ableitung = deps.ableitung && typeof deps.ableitung.aussetzen === 'function' ? deps.ableitung : null;

  const datei = path.join(paths.home, DATEI);
  const eigenesSync = portable ? path.join(portable.root, 'sync') : null;

  /** @type {object|null} kopplungen.json im Speicher */
  let zustand = null;
  /** Nicht lesbar (z. B. anderer Schlüssel): dann wird sie nicht überschrieben. */
  let unlesbar = false;

  const ich = () => identitaet.id;
  const meinPin = () => !!(vaultCrypto && vaultCrypto.enabled);
  /**
   * Gesperrter Tresor: Angebote lassen sich nicht öffnen, kopplungen.json
   * nicht schreiben. Dann bleibt alles liegen, wie es ist, bis entsperrt ist;
   * weggeworfen wird nichts.
   */
  const tresorGesperrt = () => meinPin() && vaultCrypto.state === 'locked';
  const nichtGesperrt = () => {
    if (tresorGesperrt()) throw new LockedError('Der Tresor ist gesperrt.');
  };

  function laden() {
    if (zustand) return zustand;
    let roh;
    try {
      roh = fs.readFileSync(datei);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`${DATEI} ist nicht lesbar (${err.message}).`);
      zustand = leerZustand();
      return zustand;
    }
    // Klartext (aus der Zeit vor der PIN) nicht am ersten Byte erkennen: Ein
    // Siegel beginnt mit einem zufälligen IV, und das ist in etwa jedem
    // 256. Fall ein „{“ (Prüfung Runde 1). Erst als JSON versuchen – ein
    // Siegel ist nie gültiges JSON –, sonst entsiegeln.
    let klartext = false;
    let wert;
    try {
      wert = JSON.parse(roh.toString('utf8'));
      klartext = !!wert && typeof wert === 'object' && !Array.isArray(wert);
    } catch { klartext = false; }
    try {
      const text = klartext ? null : vaultCrypto.decryptBuffer(roh).toString('utf8');
      zustand = normalisieren(klartext ? wert : JSON.parse(text));
      unlesbar = false;
    } catch (err) {
      const e = asNeuralError(err);
      unlesbar = true;
      // Gesperrt heißt: später noch einmal lesen, nichts merken.
      if (e.code === 'VAULT_LOCKED') return leerZustand();
      log.warn(`${DATEI} ließ sich nicht öffnen (${e.message}); diese KI gilt vorerst als ungekoppelt.`);
      zustand = leerZustand();
      return zustand;
    }
    // Aus der Zeit vor der PIN: die Paarschlüssel nicht länger im Klartext.
    if (klartext && meinPin() && !tresorGesperrt()) {
      try { sichern(); } catch (err) { log.warn(err.message); }
    }
    return zustand;
  }

  /** Nie Satz, nie Sicherung, nie HTTP; mit PIN versiegelt. */
  function sichern() {
    const z = laden();
    if (unlesbar) throw new StorageError(`${DATEI} ist nicht lesbar und wird nicht überschrieben.`);
    const json = Buffer.from(JSON.stringify({
      v: ZUSTAND_VERSION,
      eigeneGeneration: z.eigeneGeneration,
      letzterInhalt: z.letzterInhalt,
      verlauf: z.verlauf,
      verlaufGekuerzt: z.verlaufGekuerzt,
      zwilling: z.zwilling,
      partner: z.partner,
      ausstehend: z.ausstehend,
    }), 'utf8');
    const inhalt = meinPin() ? vaultCrypto.encryptBuffer(json) : json;
    try {
      schreibeDauerhaft(datei, inhalt);
    } catch (err) {
      throw new StorageError(`${DATEI} konnte nicht gespeichert werden: ${err.message}`);
    }
  }

  const postfach = createPostfach({ zustand: laden, sichern, ich });
  const folder = createFolderSync({
    store, merge, bus, logger: deps.logger, config: deps.config, vaultCrypto, paths, identitaet, postfach,
    saatBasen: deps.saatBasen,
  });

  /* ------------------------------------------------------ flüchtiger Stand */

  /** @type {Array<object>} Ergebnis der letzten Suche */
  let gefunden = [];
  /** Kennung -> {pfad, sync} der steckenden Partner */
  const steckt = new Map();
  /** Suchläufe hintereinander, in denen der Zwilling (grund 'gefunden') nicht mehr da war */
  let zwillingOhneFund = 0;
  /** Partner, deren Postfach ein neueres Protokoll trägt */
  const neuer = new Set();
  /** Partner, deren Postfach von einer Gabelung stammt (Zwilling beim Partner) */
  const gabelungen = new Set();
  /** "Gekoppelt mit Max." – einmal anzeigen */
  let hinweis = null;
  const fassungen = [];
  const gesperrt = new Map();
  let suche = null;
  let sucheMitLeeren = false;
  let kette = Promise.resolve();
  let laufNr = 0;
  let laeuft = false;

  let gestartet = false;
  let startLief = false;
  let beendet = false;
  let startTimer = null;
  let startAbbrechen = null;
  let startLauf = null;
  let suchTimer = null;
  let ruheTimer = null;
  const abmelden = [];

  function melde(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`Bus-Ereignis ${name}: ${err && err.message}`);
    }
  }

  function zuruecksetzen() {
    zustand = null;
    unlesbar = false;
    folder.vergessen();
    gefunden = [];
    steckt.clear();
    neuer.clear();
    gabelungen.clear();
    hinweis = null;
  }

  if (bus && typeof bus.on === 'function') {
    const beiErneuerung = () => zuruecksetzen();
    const beiFassung = (evt) => {
      const p = evt && evt.payload;
      if (!p) return;
      fassungen.unshift({ titel: p.titel, kopieId: p.kopieId, at: evt.at || nowIso() });
      if (fassungen.length > FASSUNGEN_MAX) fassungen.length = FASSUNGEN_MAX;
    };
    bus.on('ki.erneuert', beiErneuerung);
    bus.on('kopplung.zweiFassungen', beiFassung);
    bus.on('vault.encrypted', neuVersiegeln);
    abmelden.push(
      () => bus.off('ki.erneuert', beiErneuerung),
      () => bus.off('kopplung.zweiFassungen', beiFassung),
      () => bus.off('vault.encrypted', neuVersiegeln),
    );
  }

  /**
   * Eine PIN kam dazu (Einstellungen: "PIN festlegen"): Paarschlüssel und der
   * Abgleich-Stand liegen ab sofort versiegelt auf dem Stick, nicht erst beim
   * nächsten Schreiben. Synchron, damit die Antwort der Route es schon zeigt.
   */
  function neuVersiegeln() {
    if (!meinPin() || tresorGesperrt()) return;
    if (fs.existsSync(datei)) {
      laden();
      if (!unlesbar) {
        try { sichern(); } catch (err) { log.warn(err.message); }
      }
    }
    try {
      folder.neuVersiegeln();
    } catch (err) {
      log.warn(`Der Abgleich-Stand ließ sich nicht versiegeln: ${asNeuralError(err).message}`);
    }
  }

  /** Eine Warteschlange statt Fehlern: jeder Vorgang wartet, bis der vorige fertig ist. */
  function einreihen(fn) {
    const lauf = kette.then(fn, fn);
    kette = lauf.then(() => {}, () => {});
    return lauf;
  }

  /**
   * Zwei Sticks tragen dieselbe KI. Gemerkt wird, woran es erkannt wurde:
   * Verschwindet der Grund (der andere Stick ist eigenständig geworden), wird
   * wieder geschrieben; bis dahin nicht.
   */
  function alsZwilling(grund, woran = {}) {
    const z = laden();
    if (z.zwilling) return;
    z.zwilling = { seit: nowIso(), grund, ...woran };
    try { sichern(); } catch (err) { log.warn(err.message); }
    log.warn('Zwei Sticks tragen dieselbe KI.');
    melde('kopplung.zwilling', { grund });
  }

  /* ------------------------------------------------------------- Status */

  function zwillingVorbei() {
    const z = laden();
    if (!z.zwilling) return;
    z.zwilling = null;
    try { sichern(); } catch (err) { log.warn(err.message); }
    melde('kopplung.zwilling', { vorbei: true });
  }

  function zustandVon(p) {
    if (gabelungen.has(p.id)) return 'zwilling';
    if (neuer.has(p.id)) return 'neuer';
    const g = gefunden.find((x) => x.id === p.id);
    if (g && (g.zustand === 'aelter' || g.zustand === 'neuer')) return g.zustand;
    return p.zustand === 'wartet' ? 'wartet' : 'aktiv';
  }

  function partnerAnsicht(p) {
    const selbst = ich();
    return {
      id: p.id,
      name: p.name,
      zustand: zustandVon(p),
      seit: p.seit || null,
      zuletzt: p.zuletzt || null,
      steckt: steckt.has(p.id),
      ueber: (p.ueber || []).filter((u) => u.id !== selbst).map((u) => u.name || kurzName(u.id)),
    };
  }

  /**
   * Für die Stick-Ansicht: wer ich bin, mit wem ich gekoppelt bin, was steckt.
   * Nie ein Schlüssel.
   * @param {{hinweisAbholen?:boolean}} [opts] der Hinweis erscheint einmal
   */
  function status(opts = {}) {
    const z = laden();
    const out = {
      selbst: { id: ich(), name: identitaet.name, pin: meinPin(), zwilling: !!z.zwilling },
      partner: z.partner.map(partnerAnsicht),
      gefunden: gefunden.map((g) => ({ ...g })),
      hinweis,
      fassungen: fassungen.map((f) => ({ ...f })),
      laeuft,
    };
    if (opts.hinweisAbholen) hinweis = null;
    return out;
  }

  /* -------------------------------------------------------------- Finden */

  function mitZeitgrenze(promise, ms) {
    let timer = null;
    const grenze = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Zeitgrenze'), { zeitgrenze: true })), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, grenze]).finally(() => clearTimeout(timer));
  }

  async function ordnerListe(dir) {
    try {
      const namen = await mitZeitgrenze(dateisystem.readdir(dir), zeiten.zeitgrenzeMs);
      return namen.filter((n) => typeof n === 'string' && !n.startsWith('.')).map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  }

  /** Wo Wechseldatenträger hängen (Bauplan 2.8). */
  async function einhaengepunkte() {
    if (typeof deps.einhaengepunkte === 'function') {
      const liste = await deps.einhaengepunkte();
      return Array.isArray(liste) ? liste.filter((p) => typeof p === 'string' && p) : [];
    }
    if (plattform === 'win32') return 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((b) => `${b}:\\`);
    if (plattform === 'darwin') return ordnerListe('/Volumes');
    let nutzer = '';
    try { nutzer = os.userInfo().username; } catch { nutzer = process.env.USER || ''; }
    const listen = await Promise.all([
      nutzer ? ordnerListe(`/media/${nutzer}`) : [],
      nutzer ? ordnerListe(`/run/media/${nutzer}`) : [],
      ordnerListe('/mnt'),
    ]);
    return listen.flat();
  }

  async function echterPfad(p) {
    try {
      return await dateisystem.realpath(p);
    } catch {
      return path.resolve(p);
    }
  }

  async function existiert(p) {
    try {
      await dateisystem.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Nur der Marker: kiId, Name, Datenordner. Nie config.json. */
  async function markerLesen(dir) {
    let roh;
    try {
      roh = await dateisystem.readFile(path.join(dir, PORTABLE_MARKER), 'utf8');
    } catch {
      return null;
    }
    try {
      const info = JSON.parse(roh);
      return info && typeof info === 'object' && info.neuralOsPortable === true ? info : null;
    } catch {
      return null;
    }
  }

  function unterordner(dir, rel, vorgabe) {
    const name = typeof rel === 'string' && rel ? rel : vorgabe;
    const ziel = path.resolve(dir, name);
    const r = path.relative(dir, ziel);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? ziel : path.join(dir, vorgabe);
  }

  async function versionLesen(appDir) {
    try {
      const pkg = JSON.parse(await dateisystem.readFile(path.join(appDir, 'package.json'), 'utf8'));
      return pkg && typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
      return null;
    }
  }

  async function freierPlatz(dir) {
    if (typeof dateisystem.statfs !== 'function') return null;
    try {
      const st = await dateisystem.statfs(dir);
      const frei = Number(st.bavail) * Number(st.bsize);
      return Number.isFinite(frei) ? frei : null;
    } catch {
      return null;
    }
  }

  /** Ein Stick an diesem Pfad: der Ordner mit dem Marker, oder `<pfad>/Inhalt`. */
  async function stickAn(pfad) {
    for (const dir of [pfad, path.join(pfad, 'Inhalt')]) {
      const info = await markerLesen(dir);
      if (!info) continue;
      const id = typeof info.kiId === 'string' && DEVICE_ID_RE.test(info.kiId) ? info.kiId : null;
      const dataDir = unterordner(dir, info.dataDir, 'data');
      return {
        markerDir: dir,
        id,
        name: sauberName(info.name),
        dataDir,
        appDir: unterordner(dir, info.appDir, 'app'),
        sync: path.join(dir, 'sync'),
        pin: await existiert(path.join(dataDir, 'secrets.json')),
      };
    }
    return null;
  }

  /**
   * Trägt der Stick an diesem Pfad noch diese KI? Ein Laufwerksbuchstabe
   * kann inzwischen einem anderen Stick gehören; dorthin wird nie geschrieben.
   */
  async function traegt(dir, id) {
    const info = await markerLesen(dir);
    return !!(info && info.kiId === id);
  }

  /**
   * Ist das der eigene Stick? Erst über den Pfad, dann über die Markerdatei
   * selbst (Gerät und Dateinummer): Derselbe Stick unter einem zweiten
   * Einhängepunkt ist kein Zwilling. Nicht unter Windows: Dort ist `dev` die
   * Seriennummer des Laufwerks, und die trägt auch ein Stick, der Byte für
   * Byte geklont wurde – genau ein Zwilling. Zweite Pfade (subst, Ordner als
   * Laufwerk) löst dort schon realpath auf.
   */
  async function istSelbst(dir) {
    if (!portable) return false;
    if (gleicherPfad(await echterPfad(dir), await echterPfad(portable.root))) return true;
    if (plattform === 'win32') return false;
    try {
      const [a, b] = await Promise.all([
        dateisystem.stat(path.join(dir, PORTABLE_MARKER)),
        dateisystem.stat(path.join(portable.root, PORTABLE_MARKER)),
      ]);
      return !!(a && b && a.ino && a.ino === b.ino && a.dev === b.dev);
    } catch {
      return false;
    }
  }

  async function pruefePunkt(punkt, mitLeeren) {
    const stick = await stickAn(punkt);
    if (!stick) {
      if (!mitLeeren) return null;
      let st = null;
      try { st = await dateisystem.stat(punkt); } catch { st = null; }
      if (!st || !st.isDirectory()) return null;
      // "/Volumes/Macintosh HD" zeigt auf "/": die eingebaute Platte ist kein Stick.
      const echt = await echterPfad(punkt);
      if (echt === path.parse(echt).root && path.resolve(punkt) !== echt) return null;
      if (portable && await istSelbst(punkt)) return null;
      return { pfad: punkt, id: null, name: null, pin: false, zustand: 'leer', version: null, frei: await freierPlatz(punkt) };
    }
    if (await istSelbst(stick.markerDir)) return null;
    const stickVersion = await versionLesen(stick.appDir);
    const selbst = ich();
    let z;
    if (stick.id && stick.id === selbst) z = 'zwilling';
    else if (stickVersion && vergleicheVersion(stickVersion, version) < 0) z = 'aelter';
    else if (stickVersion && vergleicheVersion(stickVersion, version) > 0) z = 'neuer';
    else if (stick.id && laden().partner.some((p) => p.id === stick.id)) z = 'partner';
    else z = 'fremd';
    return {
      pfad: stick.markerDir,
      id: stick.id,
      name: stick.name || (stick.id ? kurzName(stick.id) : null),
      pin: stick.pin,
      zustand: z,
      version: stickVersion,
      frei: await freierPlatz(stick.markerDir),
    };
  }

  /**
   * Steckende Sticks finden. Jeder Einhängepunkt bekommt 1,5 s; wer nicht
   * antwortet (Netzlaufwerk, hängendes DVD-Laufwerk), wird 5 min
   * übersprungen. Es läuft nie mehr als eine Suche.
   * @param {{leer?:boolean}} [opts] auch Datenträger ohne Marker
   */
  function finden(opts = {}) {
    const mitLeeren = opts.leer === true;
    if (suche) {
      // Läuft schon eine Suche ohne leere Datenträger, wird danach noch einmal gesucht.
      if (mitLeeren && !sucheMitLeeren) return suche.then(() => finden(opts), () => finden(opts));
      return suche;
    }
    sucheMitLeeren = mitLeeren;
    suche = (async () => {
      try {
        return await suchen(mitLeeren);
      } finally {
        suche = null;
      }
    })();
    return suche;
  }

  async function suchen(mitLeeren) {
    const punkte = [...new Set(await einhaengepunkte())];
    const jetzt = Date.now();
    const liste = [];
    for (const punkt of punkte) {
      const bis = gesperrt.get(punkt);
      if (bis && bis > jetzt) continue;
      try {
        const eintrag = await mitZeitgrenze(pruefePunkt(punkt, mitLeeren), zeiten.zeitgrenzeMs);
        if (eintrag) liste.push(eintrag);
      } catch (err) {
        if (err && err.zeitgrenze) {
          gesperrt.set(punkt, Date.now() + zeiten.sperreMs);
          log.debug(`${punkt} antwortet nicht; übersprungen.`);
        }
      }
    }
    gefunden = liste;
    steckt.clear();
    const z = laden();
    for (const g of liste) {
      if (!g.id) continue;
      if (g.zustand === 'zwilling') alsZwilling('gefunden', { pfad: g.pfad });
      else if (z.partner.some((p) => p.id === g.id)) steckt.set(g.id, { pfad: g.pfad, sync: path.join(g.pfad, 'sync') });
    }
    // Die Kopie ist weg (Prüfung Runde 1): Am gemerkten Pfad steckt ein
    // Stick mit eigener Kennung oder ein Datenträger ohne diese KI
    // (formatiert) -> sofort vorbei; ist der Pfad ganz weg (gelöscht oder
    // abgezogen), nach einigen Suchläufen ohne Fund. Läuft die Kopie irgendwo
    // weiter, erkennt sie das fremde Postfach bzw. die Gabelung beim Partner.
    if (z.zwilling && z.zwilling.grund === 'gefunden' && !liste.some((g) => g.zustand === 'zwilling')) {
      const pfad = z.zwilling.pfad;
      let vorbei = liste.some((g) => g.pfad === pfad && g.id && g.id !== ich());
      if (!vorbei && typeof pfad === 'string' && !punkte.some((p) => (gesperrt.get(p) || 0) > jetzt && (pfad === p || pfad.startsWith(p + path.sep)))) {
        let st = null;
        try { st = await dateisystem.stat(pfad); } catch { st = null; }
        if (st && st.isDirectory() && !(await traegt(pfad, ich()))) vorbei = true;
        else if (!st) {
          zwillingOhneFund += 1;
          if (zwillingOhneFund >= ZWILLING_WEG_NACH) vorbei = true;
        }
      }
      if (vorbei) {
        zwillingOhneFund = 0;
        zwillingVorbei();
      }
    } else {
      zwillingOhneFund = 0;
    }
    return liste.map((g) => ({ ...g }));
  }

  /* ---------------------------------------------------------- Dateien */

  /** Einen Ordner anlegen, aber nie seine Eltern: fehlt der Stick, bleibt es dabei. */
  function ordnerAnlegen(eltern, name) {
    if (!fs.existsSync(eltern)) throw new StorageError('Der Stick ist nicht mehr da.');
    const ziel = path.join(eltern, name);
    try {
      fs.mkdirSync(ziel);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    return ziel;
  }

  function loeschen(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (err) { log.warn(`${p} ließ sich nicht löschen: ${err.message}`); }
  }

  /* ---------------------------------------------------------- Koppeln */

  /**
   * Mit dem Stick an `root` koppeln (A läuft, B steckt; B muss nicht laufen).
   * @param {{root?:string, pfad?:string, pin?:string}} opts
   */
  function koppeln(opts = {}) {
    const ziel = typeof opts.root === 'string' && opts.root.trim() ? opts.root : opts.pfad;
    if (typeof ziel !== 'string' || !ziel.trim()) return Promise.reject(new ValidationError('Es fehlt der Stick.'));
    return einreihen(() => koppelnIntern(path.resolve(ziel.trim()), opts.pin));
  }

  async function koppelnIntern(ziel, pin) {
    nichtGesperrt();
    const z = laden();
    if (z.zwilling) throw new NeuralError('KOPPLUNG_ZWILLING', 'Zwei Sticks tragen dieselbe KI.', { status: 409 });
    const b = await stickAn(ziel);
    if (!b || !b.id) throw new NeuralError('NOT_FOUND', 'Auf diesem Stick wohnt keine KI.', { status: 404 });
    if (await istSelbst(b.markerDir)) throw new ValidationError('Das ist dieser Stick.');
    if (b.id === ich()) throw new NeuralError('KOPPLUNG_ZWILLING', 'Zwei Sticks tragen dieselbe KI.', { status: 409 });
    const name = b.name || kurzName(b.id);
    if (b.pin && !meinPin()) {
      throw new NeuralError('KOPPLUNG_SCHUTZ', `${name} hat eine PIN, dieser Stick nicht.`, { status: 409, details: { pinHier: false, pinDort: true } });
    }
    if (!b.pin && meinPin()) {
      throw new NeuralError('KOPPLUNG_SCHUTZ', `Dieser Stick hat eine PIN, ${name} nicht.`, { status: 409, details: { pinHier: true, pinDort: false } });
    }

    // Der Tresor von B, nur im Speicher und nur für das Siegel des Angebots.
    let tresorB = null;
    if (b.pin) {
      const { createVaultCrypto } = require('../store/vaultcrypto');
      tresorB = createVaultCrypto({ paths: { secrets: path.join(b.dataDir, 'secrets.json') }, config: {}, geraet: false });
      try {
        await tresorB.unlock(String(pin === undefined || pin === null ? '' : pin));
      } catch {
        tresorB.lock();
        throw new NeuralError('FALSCHE_PIN', 'Falsche PIN.', { status: 403 });
      }
    }

    const schluessel = crypto.randomBytes(SCHLUESSEL_BYTES);
    const vorher = z.partner.find((p) => p.id === b.id) || null;
    const eintrag = {
      id: b.id,
      name,
      schluessel: schluessel.toString('base64'),
      seit: nowIso(),
      zustand: 'wartet',
      gesehen: 0,
      gesehenInhalt: null,
      quittung: 0,
      zuletzt: null,
      ueber: [],
      version: null,
      erster: true,
    };
    const ausstehendVorher = z.ausstehend;
    try {
      z.partner = z.partner.filter((p) => p.id !== b.id).concat(eintrag);
      // Eine Entkoppel-Nachricht an B, die noch wartet, ist mit dem neuen
      // Angebot überholt; zugestellt zöge sie es sofort zurück (Prüfung Runde 1).
      z.ausstehend = z.ausstehend.filter((a) => a.an !== b.id);
      try {
        sichern();
        const angebot = { v: 1, von: ich(), name: identitaet.name, an: b.id, schluessel: eintrag.schluessel, at: nowIso() };
        const inhalt = tresorB
          ? { v: 1, versiegelt: tresorB.encryptBuffer(Buffer.from(JSON.stringify(angebot), 'utf8')).toString('base64') }
          : angebot;
        const koppelOrdner = ordnerAnlegen(ordnerAnlegen(b.markerDir, 'sync'), 'koppeln');
        schreibeDauerhaft(path.join(koppelOrdner, `${ich()}.angebot`), `${JSON.stringify(inhalt)}\n`);
        // Alte Nachrichten zu diesem Paar: meine Entkoppel-Nachricht auf B
        // und meine eigene Abmeldung für B (siehe entkoppeln).
        loeschen(path.join(koppelOrdner, `${ich()}.entkoppelt`));
        if (eigenesSync) loeschen(path.join(eigenesSync, 'koppeln', `${b.id}${ABMELDUNG}`));
      } catch (err) {
        z.partner = z.partner.filter((p) => p !== eintrag).concat(vorher ? [vorher] : []);
        z.ausstehend = ausstehendVorher;
        try { sichern(); } catch { /* der Fehler unten ist der wichtigere */ }
        throw err instanceof NeuralError ? err : new StorageError(`Das Angebot ließ sich nicht auf den Stick schreiben: ${err.message}`);
      }
    } finally {
      schluessel.fill(0);
      if (tresorB) tresorB.lock();
    }

    steckt.set(b.id, { pfad: b.markerDir, sync: b.sync });
    melde('kopplung.gekoppelt', { id: b.id, name });
    // Sofort das eigene Postfach auf B legen: B übernimmt beim nächsten Start.
    await abgleichenIntern('koppeln', { suchen: false });
    return { partner: partnerAnsicht(laden().partner.find((p) => p.id === b.id) || eintrag) };
  }

  /** Für Paket R: einen eben vorbereiteten Stick mit dieser KI koppeln. */
  function koppelnNeu(opts = {}) {
    return koppeln(opts);
  }

  /* ---------------------------------------------------------- Annehmen */

  function angebotLesen(datei, von) {
    let roh;
    try {
      roh = JSON.parse(fs.readFileSync(datei, 'utf8'));
    } catch {
      return null;
    }
    if (!roh || typeof roh !== 'object') return null;
    let a = roh;
    if (meinPin()) {
      // Mit PIN nur versiegelt: Ein Angebot im Klartext kann jeder ablegen.
      if (typeof roh.versiegelt !== 'string') return null;
      try {
        a = JSON.parse(vaultCrypto.decryptBuffer(Buffer.from(roh.versiegelt, 'base64')).toString('utf8'));
      } catch {
        return null;
      }
    } else if (roh.versiegelt !== undefined) {
      return null;
    }
    if (!a || a.an !== ich() || a.von !== von || !schluesselAus(a.schluessel)) return null;
    return { von, name: sauberName(a.name) || kurzName(von), schluessel: a.schluessel };
  }

  function entkoppeltGueltig(datei, partner) {
    let n;
    try {
      n = JSON.parse(fs.readFileSync(datei, 'utf8'));
    } catch {
      return false;
    }
    if (!n || n.von !== partner.id || n.an !== ich() || typeof n.at !== 'string' || typeof n.mac !== 'string') return false;
    const k = schluesselAus(partner.schluessel);
    if (!k) return false;
    const soll = Buffer.from(hmac(k, `entkoppelt|${n.von}|${n.an}|${n.at}`), 'hex');
    const ist = Buffer.from(n.mac, 'hex');
    return ist.length === soll.length && crypto.timingSafeEqual(ist, soll);
  }

  /**
   * Angebote und Entkoppel-Nachrichten im eigenen `sync/koppeln/` bearbeiten.
   * @returns {Promise<{angenommen:Array<{id,name}>, entkoppelt:string[], abgelehnt:number}>}
   */
  function annehmen() {
    return einreihen(() => annehmenIntern());
  }

  async function annehmenIntern() {
    const out = { angenommen: [], entkoppelt: [], abgelehnt: 0 };
    if (!eigenesSync || tresorGesperrt()) return out;
    laden();
    if (unlesbar) return out;
    const dir = path.join(eigenesSync, 'koppeln');
    let namen;
    try {
      namen = fs.readdirSync(dir).sort();
    } catch {
      return out;
    }
    for (const name of namen) {
      const datei = path.join(dir, name);
      if (name.endsWith('.angebot')) {
        const von = name.slice(0, -'.angebot'.length);
        const angebot = DEVICE_ID_RE.test(von) && von !== ich() ? angebotLesen(datei, von) : null;
        if (!angebot) {
          out.abgelehnt++;
          loeschen(datei);
          continue;
        }
        // Schon wieder zurückgezogen (entkoppelt, bevor ich lief): still weg.
        const zurueck = path.join(dir, `${von}.entkoppelt`);
        if (namen.includes(`${von}.entkoppelt`) && entkoppeltGueltig(zurueck, { id: von, schluessel: angebot.schluessel })) {
          loeschen(datei);
          loeschen(zurueck);
          loeschen(path.join(eigenesSync, von));
          continue;
        }
        const z = laden();
        z.partner = z.partner.filter((p) => p.id !== von).concat({
          id: von,
          name: angebot.name,
          schluessel: angebot.schluessel,
          seit: nowIso(),
          zustand: 'aktiv',
          gesehen: 0,
          gesehenInhalt: null,
          quittung: 0,
          zuletzt: null,
          ueber: [],
          version: null,
          erster: true,
        });
        gabelungen.delete(von);
        // Eine eigene Entkoppel-Nachricht an ihn ist damit überholt.
        z.ausstehend = z.ausstehend.filter((a) => a.an !== von);
        // Erst merken, dann das Angebot löschen: seedIfEmpty sieht immer eines von beiden.
        sichern();
        loeschen(datei);
        loeschen(path.join(dir, `${von}${ABMELDUNG}`));
        hinweis = `Gekoppelt mit ${angebot.name}.`;
        out.angenommen.push({ id: von, name: angebot.name });
        melde('kopplung.angenommen', { id: von, name: angebot.name, text: hinweis });
      } else if (name.endsWith('.entkoppelt')) {
        const von = name.slice(0, -'.entkoppelt'.length);
        const z = laden();
        const p = z.partner.find((x) => x.id === von);
        if (!p || !entkoppeltGueltig(datei, p)) {
          if (p) out.abgelehnt++;
          loeschen(datei);
          continue;
        }
        z.partner = z.partner.filter((x) => x.id !== von);
        sichern();
        loeschen(path.join(eigenesSync, von));
        loeschen(datei);
        // Mein Postfach auf seinem Stick liest niemand mehr.
        const s = steckt.get(von);
        if (s && (await traegt(s.pfad, von))) loeschen(path.join(s.sync, ich()));
        steckt.delete(von);
        neuer.delete(von);
        gabelungen.delete(von);
        out.entkoppelt.push(von);
        melde('kopplung.entkoppelt', { id: von, name: p.name });
      }
    }
    return out;
  }

  /**
   * Hat ein steckender Partner mich an seinem Rechner entkoppelt, liegt die
   * Nachricht auf SEINEM Stick (`<ich>.abmeldung`, siehe entkoppeln). Dann
   * entkopple ich ebenso, statt weiter mein Postfach auf seinen Stick zu legen
   * und „abgeglichen“ zu zeigen.
   */
  async function abmeldungenAbholen() {
    const z = laden();
    for (const p of [...z.partner]) {
      const s = steckt.get(p.id);
      if (!s || !(await traegt(s.pfad, p.id))) continue;
      const datei = path.join(s.sync, 'koppeln', `${ich()}${ABMELDUNG}`);
      if (!fs.existsSync(datei) || !entkoppeltGueltig(datei, p)) continue;
      z.partner = z.partner.filter((x) => x.id !== p.id);
      sichern();
      if (eigenesSync) loeschen(path.join(eigenesSync, p.id));
      // Ohne Partner liest mein Postfach niemand mehr.
      if (eigenesSync && !z.partner.length) loeschen(path.join(eigenesSync, ich()));
      loeschen(path.join(s.sync, ich()));
      loeschen(datei);
      steckt.delete(p.id);
      neuer.delete(p.id);
      gabelungen.delete(p.id);
      melde('kopplung.entkoppelt', { id: p.id, name: p.name });
    }
  }

  /* ---------------------------------------------------------- Entkoppeln */

  function zustellen(stick, nachricht) {
    loeschen(path.join(stick.sync, ich()));
    const ordner = ordnerAnlegen(ordnerAnlegen(stick.pfad, 'sync'), 'koppeln');
    schreibeDauerhaft(path.join(ordner, `${ich()}.entkoppelt`), `${JSON.stringify(nachricht)}\n`);
    // Ein Angebot, das dort noch wartet, ist damit zurückgezogen.
    loeschen(path.join(ordner, `${ich()}.angebot`));
  }

  async function ausstehendeZustellen() {
    const z = laden();
    if (!z.ausstehend.length) return;
    const rest = [];
    for (const a of z.ausstehend) {
      const g = gefunden.find((x) => x.id === a.an);
      if (!g || !(await traegt(g.pfad, a.an))) {
        rest.push(a);
        continue;
      }
      try {
        zustellen({ pfad: g.pfad, sync: path.join(g.pfad, 'sync') }, a.nachricht);
        if (eigenesSync) loeschen(path.join(eigenesSync, 'koppeln', `${a.an}${ABMELDUNG}`));
      } catch {
        rest.push(a);
      }
    }
    if (rest.length !== z.ausstehend.length) {
      z.ausstehend = rest;
      sichern();
    }
  }

  /**
   * Entkoppeln: Schlüssel weg, eigenes Postfach ohne den Partner, sein
   * Postfach hier weg. Steckt er, auch mein Postfach auf ihm weg und eine
   * Nachricht dazu (HMAC mit dem Paarschlüssel, vor dem Löschen berechnet);
   * sonst wird sie zugestellt, sobald er das nächste Mal steckt. Beide
   * behalten, was sie wissen.
   */
  function entkoppeln(id) {
    return einreihen(async () => {
      nichtGesperrt();
      const z = laden();
      const p = z.partner.find((x) => x.id === id);
      if (!p) throw new NeuralError('NOT_FOUND', 'Diese Kopplung gibt es nicht.', { status: 404 });
      const selbst = ich();
      const at = nowIso();
      const k = schluesselAus(p.schluessel);
      const nachricht = { v: 1, von: selbst, an: id, at, mac: hmac(k, `entkoppelt|${selbst}|${id}|${at}`) };
      k.fill(0);
      await finden();
      const kandidat = steckt.get(id) || null;
      const stick = kandidat && (await traegt(kandidat.pfad, id)) ? kandidat : null;

      z.partner = z.partner.filter((x) => x.id !== id);
      let zugestellt = false;
      if (stick) {
        try {
          zustellen(stick, nachricht);
          zugestellt = true;
        } catch (err) {
          log.warn(`Die Entkoppel-Nachricht ließ sich nicht ablegen: ${err.message}`);
        }
      }
      if (!zugestellt) {
        z.ausstehend = z.ausstehend.filter((a) => a.an !== id).concat({ an: id, nachricht });
        // Dieselbe Nachricht auch auf den EIGENEN Stick: Läuft der Partner
        // mit diesem Stick, bevor ich mit seinem laufe, erfährt er es dort
        // (Prüfung Runde 1: Lena entkoppelt an ihrem Laptop).
        if (eigenesSync) {
          try {
            const ordner = ordnerAnlegen(eigenesSync, 'koppeln');
            schreibeDauerhaft(path.join(ordner, `${id}${ABMELDUNG}`), `${JSON.stringify(nachricht)}\n`);
          } catch (err) {
            log.warn(`Die Abmeldung ließ sich nicht auf diesen Stick legen: ${err.message}`);
          }
        }
      }
      sichern();
      steckt.delete(id);
      neuer.delete(id);
      gabelungen.delete(id);
      if (eigenesSync) {
        loeschen(path.join(eigenesSync, id));
        // Mein Postfach trägt ihn noch als Empfänger: neu schreiben, ohne ihn.
        if (z.partner.length) {
          try {
            await folder.publish(eigenesSync, { ziel: selbst });
          } catch (err) {
            log.warn(`Das eigene Postfach ließ sich nicht neu schreiben: ${asNeuralError(err).message}`);
          }
        } else {
          loeschen(path.join(eigenesSync, selbst));
        }
      }
      melde('kopplung.entkoppelt', { id, name: p.name });
      return status();
    });
  }

  /**
   * "Diesen Stick eigenständig machen": neue Kennung, ohne Partner. Vorher
   * werden die Postfächer entfernt, die DIESER Stick unter der alten Kennung
   * geschrieben hat; die des anderen Zwillings bleiben.
   */
  function eigenstaendig() {
    return einreihen(async () => {
      nichtGesperrt();
      const selbst = ich();
      try {
        await finden();
      } catch { /* dann eben nur das eigene sync/ */ }
      const ziele = [];
      if (eigenesSync) ziele.push({ ordner: eigenesSync, ziel: selbst });
      for (const [id, s] of steckt) ziele.push({ ordner: s.sync, ziel: id });
      for (const t of ziele) {
        try {
          await folder.eigenesEntfernen(t.ordner, { ziel: t.ziel });
        } catch (err) {
          log.warn(`Ein altes Postfach ließ sich nicht entfernen: ${asNeuralError(err).message}`);
        }
      }
      identitaet.erneuern('zwilling');
      zuruecksetzen();
      return status();
    });
  }

  /* ---------------------------------------------------------- Abgleichen */

  /**
   * Einmal abgleichen: lesen, dann schreiben. Wartet, bis ein laufender
   * Vorgang fertig ist.
   * @returns {Promise<object>} Bericht
   */
  function abgleichen(opts = {}) {
    return einreihen(() => abgleichenIntern(opts.grund || 'hand'));
  }

  async function abgleichenIntern(grund, { suchen: mitSuche = true } = {}) {
    const bericht = {
      lauf: ++laufNr,
      grund,
      begonnen: performance.now(),
      beendet: null,
      uebernommen: 0,
      konflikte: 0,
      kopien: 0,
      gelesen: [],
      geschrieben: [],
      warnungen: [],
      zwilling: false,
    };
    laeuft = true;
    try {
      if (tresorGesperrt()) {
        bericht.gesperrt = true;
        return bericht;
      }
      await annehmenIntern();
      const z = laden();
      if (!z.partner.length && !z.ausstehend.length) return bericht;
      if (mitSuche) await finden();
      await ausstehendeZustellen();
      await abmeldungenAbholen();
      if (!laden().partner.length) return bericht;

      const selbst = ich();
      const erster = z.partner.some((p) => p.erster);
      const warn = (text) => { if (bericht.warnungen.length < 50) bericht.warnungen.push(text); };

      const lauf = async () => {
        let angewendet = false;
        const lesenAlle = async () => {
          for (const p of [...laden().partner]) {
            const quellen = [];
            if (eigenesSync) quellen.push(eigenesSync);
            const s = steckt.get(p.id);
            if (s) quellen.push(s.sync);
            let r;
            try {
              r = await folder.lesen(quellen, p.id);
            } catch (err) {
              warn(`${p.name}: ${asNeuralError(err).message}`);
              continue;
            }
            if (r.neuer) neuer.add(p.id);
            else if (r.gelesen) neuer.delete(p.id);
            if (r.gabelung && !r.gelesen) gabelungen.add(p.id);
            else if (r.gelesen) gabelungen.delete(p.id);
            if (r.zwilling) {
              alsZwilling('gabelung');
              bericht.zwilling = true;
            }
            for (const w of r.warnings || []) warn(w);
            if (r.gelesen) {
              if (r.applied || r.kopien) angewendet = true;
              bericht.uebernommen += r.applied;
              bericht.konflikte += r.conflicts;
              bericht.kopien += r.kopien;
              bericht.gelesen.push({ id: p.id, generation: r.generation, uebernommen: r.applied, konflikte: r.conflicts, kopien: r.kopien });
            }
          }
        };
        if (ableitung) await ableitung.aussetzen(lesenAlle);
        else await lesenAlle();
        if (angewendet && ableitung && typeof ableitung.nachholen === 'function') {
          try {
            withActor({ kind: 'sync', label: 'Abgleich' }, () => ableitung.nachholen());
          } catch (err) {
            log.warn(`Die Verknüpfungen ließen sich nicht nachholen: ${asNeuralError(err).message}`);
          }
        }

        const ziele = [];
        if (eigenesSync) ziele.push({ eltern: portable.root, ordner: eigenesSync, ziel: selbst, partner: null });
        for (const p of laden().partner) {
          const s = steckt.get(p.id);
          if (s) ziele.push({ eltern: s.pfad, ordner: s.sync, ziel: p.id, partner: p });
        }
        const zw = laden().zwilling;
        if (zw && zw.grund === 'fremdes-postfach') {
          // Liegt das fremde Postfach nicht mehr dort, ist der andere weg.
          const t = ziele.find((x) => x.ziel === zw.ziel);
          if (t) {
            try {
              if (!(await folder.fremdesPostfach(t.ordner, { ziel: t.ziel }))) zwillingVorbei();
            } catch { /* Ordner gerade nicht lesbar: bleibt, wie es ist */ }
          }
        }
        if (laden().zwilling) {
          bericht.zwilling = true;
          return;
        }
        let geaendert = false;
        for (const t of ziele) {
          try {
            if (t.partner && !(await traegt(t.eltern, t.ziel))) continue;
            ordnerAnlegen(t.eltern, 'sync');
            const w = await folder.publish(t.ordner, { ziel: t.ziel });
            if (w.zwilling) {
              alsZwilling('fremdes-postfach', { ziel: t.ziel });
              bericht.zwilling = true;
              break;
            }
            if (w.geschrieben) bericht.geschrieben.push({ ordner: t.ordner, generation: w.generation });
            if (t.partner && (w.geschrieben || w.grund === 'unveraendert')) {
              t.partner.zuletzt = nowIso();
              geaendert = true;
            }
          } catch (err) {
            warn(asNeuralError(err).message);
          }
        }
        if (geaendert) {
          try { sichern(); } catch (err) { warn(err.message); }
        }
      };

      if (erster && history && typeof history.suspend === 'function') await history.suspend(lauf);
      else await lauf();
      if (bericht.kopien) melde('kopplung.abgeglichen', { kopien: bericht.kopien, uebernommen: bericht.uebernommen });
      return bericht;
    } finally {
      laeuft = false;
      bericht.beendet = performance.now();
    }
  }

  /* ---------------------------------------------------------- Auslöser */

  function hatAngebote() {
    if (!eigenesSync) return false;
    try {
      return fs.readdirSync(path.join(eigenesSync, 'koppeln')).some((n) => n.endsWith('.angebot') || n.endsWith('.entkoppelt'));
    } catch {
      return false;
    }
  }

  async function suchlauf() {
    if (beendet || laeuft || tresorGesperrt()) return;
    try {
      if (hatAngebote()) {
        await abgleichen({ grund: 'angebot' });
        return;
      }
      const z = laden();
      if (!z.partner.length && !z.ausstehend.length) return;
      const vorher = new Set(steckt.keys());
      await finden();
      const neuEingesteckt = [...steckt.keys()].some((id) => !vorher.has(id));
      const zustellbar = z.ausstehend.some((a) => gefunden.some((g) => g.id === a.an));
      if (neuEingesteckt || zustellbar) await abgleichen({ grund: 'eingesteckt' });
    } catch (err) {
      log.warn(`Suchlauf: ${asNeuralError(err).message}`);
    }
  }

  /**
   * Eine Änderung an einem Satz, der reist, oder ein neuer Name dieser KI
   * (er steht im Postfach): 20 s nach der letzten davon abgleichen.
   */
  function beiAenderung(evt) {
    if (beendet || !evt || typeof evt.name !== 'string') return;
    if (evt.name !== 'ki.umbenannt') {
      if (!evt.name.startsWith('record.')) return;
      const p = evt.payload || {};
      if (p.actor && p.actor.kind === 'sync') return;
      if (!merge.isSyncable(p.type)) return;
    }
    if (!laden().partner.length) return;
    if (ruheTimer) clearTimeout(ruheTimer);
    ruheTimer = setTimeout(() => {
      ruheTimer = null;
      abgleichen({ grund: 'aenderung' }).catch((err) => log.warn(`Abgleich: ${asNeuralError(err).message}`));
    }, zeiten.ruheMs);
    if (typeof ruheTimer.unref === 'function') ruheTimer.unref();
  }

  /**
   * Die Kopplung in Gang setzen: erster Abgleich (nimmt auch Angebote an),
   * und – wenn `automatisch` – Suchlauf und Abgleich nach Änderungen.
   * Zeitgeber halten keinen Prozess am Leben.
   * @returns {Promise<object|null>} der Bericht des ersten Abgleichs
   */
  function starten() {
    if (startLauf) return startLauf;
    if (beendet) return Promise.resolve(null);
    gestartet = true;
    if (automatisch) {
      if (bus && typeof bus.subscribe === 'function') abmelden.push(bus.subscribe(beiAenderung));
      suchTimer = setInterval(() => { suchlauf(); }, zeiten.suchlaufMs);
      if (typeof suchTimer.unref === 'function') suchTimer.unref();
    }
    startLauf = new Promise((resolve) => {
      const los = () => {
        startTimer = null;
        startAbbrechen = null;
        startLief = true;
        abgleichen({ grund: 'start' }).then(resolve, (err) => {
          log.warn(`Abgleich beim Start: ${asNeuralError(err).message}`);
          resolve(null);
        });
      };
      if (automatisch && zeiten.startMs > 0) {
        startAbbrechen = () => resolve(null);
        startTimer = setTimeout(los, zeiten.startMs);
        if (typeof startTimer.unref === 'function') startTimer.unref();
      } else {
        los();
      }
    });
    return startLauf;
  }

  /** Beim Beenden: Zeitgeber aus, laufende Vorgänge abwarten, ein letzter Abgleich. */
  async function beenden() {
    if (beendet) return;
    beendet = true;
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = null;
      if (startAbbrechen) startAbbrechen();
    }
    if (suchTimer) clearInterval(suchTimer);
    if (ruheTimer) clearTimeout(ruheTimer);
    suchTimer = null;
    ruheTimer = null;
    for (const f of abmelden.splice(0)) {
      try { f(); } catch { /* schon weg */ }
    }
    await kette;
    if (gestartet && startLief && laden().partner.length) {
      try {
        await einreihen(() => abgleichenIntern('beenden', { suchen: false }));
      } catch (err) {
        log.warn(`Abgleich beim Beenden: ${asNeuralError(err).message}`);
      }
    }
  }

  return {
    get automatisch() { return automatisch; },
    status,
    finden,
    koppeln,
    koppelnNeu,
    annehmen,
    abgleichen,
    entkoppeln,
    eigenstaendig,
    starten,
    beenden,
    /** Nur für Tests und Werkzeuge. */
    __internals: { folder, postfach, laden },
  };
}

module.exports = {
  createKopplung,
  createPostfach,
  vergleicheVersion,
  STANDARD_ZEITEN,
  DATEI,
};
