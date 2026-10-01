/**
 * views/stick.js -- „Stick“: dieser Stick, andere Sticks, Koppeln, Sicherung
 * (docs/STICK-BAUPLAN.md 1.6, 1.7 und 1.8; Paket W2).
 *
 * Was der Nutzer sieht, von oben nach unten
 * ----------------------------------------
 *   Dieser Stick   Läuft er an Windows und am Mac? Sonst [Für Mac holen] bzw.
 *                  [Für Windows holen]. Ist er die Kopie eines anderen:
 *                  [Diesen Stick eigenständig machen].
 *   Andere Sticks  Was gerade steckt: „Leerer Stick: E:\ · 14,2 GB frei“
 *                  [Neue KI] [Mit dieser KI gekoppelt], „Anderer Stick: Lena“
 *                  [Koppeln], ältere und neuere Programmstände.
 *   Gekoppelt      Mit wem, wann zuletzt abgeglichen, [Jetzt abgleichen]
 *                  [Entkoppeln] -- und was es zweimal verschieden gab.
 *   Sicherung      [Jetzt sichern], klein darunter das Wiederherstellen.
 * Beenden steht unten links in der Leiste ([Beenden], web/app.js).
 *
 * Entscheidungen, die man beim Lesen sonst für Zufall hielte
 * ----------------------------------------------------------
 * - **Die Sätze sind die aus dem Bauplan, wörtlich.** Wo der Server den Satz
 *   schon liefert („Läuft bisher nur an Windows.“, „Falsche PIN.“, „Auf diesem
 *   Stick wohnt schon eine KI.“), steht genau seiner da.
 * - **Gesucht wird alle 15 s, solange die Ansicht sichtbar ist**
 *   (`GET /api/kopplung?suchen=1&leer=1`). Neu gezeichnet wird nur, wenn sich
 *   etwas geändert hat, und eine PIN, die gerade getippt wird, bleibt samt
 *   Cursor stehen.
 * - **Nachgefragt wird in der Seite**, nicht mit einem Fenster des Browsers:
 *   „Entkoppeln? Beide behalten, was sie wissen.“ [Entkoppeln] [Abbrechen].
 * - **Die Frage nach dem Internet kommt als zwei Knöpfe**: „Erlauben“ oder
 *   „Nur <dieses System>“. Ein Dialog kann Escape und Nein nicht
 *   unterscheiden -- dann hätte ein Wegklicken still einen halben Stick bestellt.
 * - **[Für Mac holen] ist selbst die Erlaubnis**: wer ihn drückt, will die
 *   Laufzeit holen. Die Freigabe gilt nur nodejs.org und nur für diesen einen
 *   Vorgang (src/http/api/stick.js).
 * - **Der Balken ist gemessen.** Jede Bewegung kommt aus einem Ereignis des
 *   Servers; eine Animation, die bei 90 % stehenbleibt, verleitet zum Abziehen.
 * - **Ein PIN-Feld ist kein type=password und kein <form>**: der Browser soll
 *   nicht anbieten, die PIN zu speichern -- sonst läge sie neben dem Stick.
 */

import {
  h, text, clear, icon, formatBytes, formatNumber, formatDateTime, timeAgo,
} from '../lib/dom.js';
import { zielVon } from '../lib/agenten.js';
import * as lokal from '../lib/lokal.js';

/* ------------------------------------------------------------------ */
/* Wortschatz                                                          */
/* ------------------------------------------------------------------ */

const EIGENE_ICONS = {
  download: '<path d="M10 3.4v9.2M6.2 9l3.8 3.8L13.8 9M4 16.2h12"/>',
  upload: '<path d="M10 16.4V7.2M6.2 11 10 7.2 13.8 11M4 3.8h12"/>',
  stop: '<rect x="5.4" y="5.4" width="9.2" height="9.2" rx="1.6"/>',
  koppeln: '<path d="M8.2 11.8 11.8 8.2"/><path d="M9.4 5.6 11 4a3 3 0 0 1 4.2 4.2l-1.6 1.6"/><path d="M10.6 14.4 9 16a3 3 0 0 1-4.2-4.2l1.6-1.6"/>',
};

/**
 * Wiederherstellen: die Modi aus `POST /api/backup/import`, von „nimmt nichts
 * weg" nach „nimmt alles weg". Voreingestellt ist der ungefährliche.
 */
const MODI = [
  { value: 'merge', label: 'Ergänzen', gefahr: false },
  { value: 'replace', label: 'Gleiche ersetzen', gefahr: true },
  { value: 'fresh', label: 'Nur in leeren Tresor', gefahr: false },
  { value: 'restore', label: 'Alles ersetzen', gefahr: true },
];

const STYLE_ID = 'neural-os-stickv-style';

/** So oft wird nachgesehen, was steckt (Bauplan 2.12). */
const SUCHEN_MS = 15000;

/** Dieselbe Regel wie in den Einstellungen. */
const PIN_RE = /^[0-9]{4,6}$/;
const PIN_SATZ = 'Die PIN besteht aus 4 bis 6 Ziffern.';

/** Welche Laufzeiten [Für Mac holen] bzw. [Für Windows holen] holt (Bauplan 2.10.1). */
const HOLEN = {
  mac: ['darwin-arm64', 'darwin-x64'],
  windows: ['win-x64'],
};

/** Vorgänge, die auf einen Stick schreiben. Immer nur einer davon zugleich. */
const SCHREIBEND = new Set(['einrichten', 'erneuern', 'laufzeit']);

function fehlerText(err) {
  if (!err) return 'Unbekannter Fehler.';
  return err.message ? String(err.message) : String(err);
}

/** Der erste Satz eines langen Grundes -- der Rest steht im Protokoll. */
function ersterSatz(satz) {
  const s = String(satz || '').trim();
  const m = /^(.{12,220}?[.!?])(\s|$)/.exec(s);
  return m ? m[1] : s.slice(0, 220);
}

/**
 * Die Rechnerfamilie zu einer Plattform. Für die Frage „Darf es?" zählt, ob
 * der Stick an Windows und am Mac startet -- ob Intel oder Apple-Chip, weiß
 * der Nutzer oft nicht und muss es hier auch nicht wissen.
 */
function familien(ids) {
  const namen = [];
  for (const id of ids || []) {
    const s = String(id);
    const n = s.startsWith('win') ? 'Windows' : s.startsWith('darwin') ? 'Mac' : s.startsWith('linux') ? 'Linux' : s;
    if (!namen.includes(n)) namen.push(n);
  }
  return namen;
}

function aufzaehlen(namen) {
  const n = (namen || []).filter(Boolean);
  if (n.length <= 1) return n.join('');
  return `${n.slice(0, -1).join(', ')} und ${n[n.length - 1]}`;
}

/** „14,2 GB frei“ -- eine Nachkommastelle, wie der Explorer sie zeigt. */
function frei(bytes) {
  const n = Number(bytes);
  if (bytes === null || bytes === undefined || !Number.isFinite(n) || n < 0) return null;
  const gb = 1024 ** 3;
  if (n >= gb) return `${(n / gb).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB frei`;
  return `${formatBytes(n)} frei`;
}

/** „14:03“ heute, „gestern 16:40“, sonst „12.09. 16:40“. */
function wann(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const uhr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const jetzt = new Date();
  const tag = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const abstand = Math.round((tag(jetzt) - tag(d)) / 86400000);
  if (abstand === 0) return uhr;
  if (abstand === 1) return `gestern ${uhr}`;
  const datum = d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    ...(d.getFullYear() !== jetzt.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${datum} ${uhr}`;
}

/**
 * Was fehlt, als Sätze -- jeder nur einmal: Fehlen beide Macs ohne Netz,
 * steht „Ohne Internet geht das nicht.“ einmal da, nicht zweimal.
 */
function fehlendSaetze(fehlend) {
  const saetze = [];
  for (const f of Array.isArray(fehlend) ? fehlend : []) {
    const satz = f && (f.satz || ersterSatz(f.grund));
    if (satz && !saetze.includes(satz)) saetze.push(satz);
  }
  return saetze;
}

/** Liegt `pfad` in `basis` oder ist er es? (ein vorbereiteter Stick steht unter „…/Inhalt“) */
function unter(pfad, basis) {
  return pfad === basis || pfad.startsWith(`${basis}/`) || pfad.startsWith(`${basis}\\`);
}

/** Für Selektoren. Der Stiltext heißt hier STIL -- `CSS` ist das des Browsers. */
const escape = (x) => (globalThis.CSS && typeof globalThis.CSS.escape === 'function'
  ? globalThis.CSS.escape(x)
  : String(x).replace(/["\\]/g, '\\$&'));

/* ------------------------------------------------------------------ */
/* Ansicht                                                             */
/* ------------------------------------------------------------------ */

let view = null;

/**
 * [Ansehen] einer Fassung: danach nicht noch einmal zeigen -- auch nicht nach
 * dem Neuladen. Gemerkt werden nur Kennungen (web/lib/lokal.js), höchstens 50.
 */
const GESEHEN_MAX = 50;
function gesehen() {
  const liste = lokal.lesenJson('fassungen-gesehen', []);
  return new Set(Array.isArray(liste) ? liste.filter((x) => typeof x === 'string') : []);
}
function alsGesehen(kopieId) {
  const liste = [...gesehen()].filter((x) => x !== kopieId);
  liste.push(kopieId);
  lokal.schreibenJson('fassungen-gesehen', liste.slice(-GESEHEN_MAX));
}

export default {
  id: 'stick',
  title: 'Stick',

  async mount(container, ctx) {
    ensureStyle();
    teardown();

    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      icons: ctx.icons || {},
      container,
      requests: new Set(),
      timers: new Set(),
      takte: new Set(),
      offs: [],

      /** GET /api/stick: läuft diese KI vom Stick, fehlen Laufzeiten? */
      selbst: null,
      selbstFehler: null,

      /** GET /api/kopplung?suchen=1&leer=1: wer steckt, mit wem gekoppelt. */
      kopplung: null,
      kopplungFehler: null,
      suche: null,
      /** Zählt Änderungen (Koppeln, Entkoppeln, …); eine Suche von davor zählt nicht. */
      stand: 0,
      sucheStand: 0,
      signatur: '',
      gleichtAb: false,

      /** Getippte PINs je Feld -- sie überleben das Neuzeichnen. */
      pins: new Map(),
      /** Je Stick oder Partner: {art, laeuft, percent, message, detail, fehler, code, details, ergebnis}. */
      vorgaenge: new Map(),
      /** Die Frage nach dem Internet: {schluessel, pfad, ki, pin, pinFeld, plan}. */
      frage: null,
      /** Kennung des Partners, bei dem „Entkoppeln?“ gefragt wird. */
      entkoppeln: null,

      /** Ort von Hand, wenn die Suche einen Stick nicht findet. */
      hand: { offen: false, pfad: '', plan: null, fehler: null, laeuft: false },

      /* Sichern */
      sicherung: null,
      sichernLaeuft: false,
      sichernFehler: null,
      gesichert: null,
      sichernSlot: null,

      /* Wiederherstellen */
      offen: false,
      liste: null,
      quelle: '',
      modus: 'merge',
      pass: '',
      vorschau: null,
      vorschauQuelle: null,
      vorschauFehler: null,
      vorschauLaeuft: false,
      ergebnis: null,
      ergebnisFehler: null,
      importLaeuft: false,
    };
    view = self;

    render(self);
    await Promise.all([ladeSelbst(self), ladeKopplung(self)]);
    if (!self.alive) return;
    alleNeu(self);
    await ladeSicherung(self);
    if (self.alive) renderSichern(self);
    beobachten(self);
  },

  async unmount() {
    teardown();
  },
};

function teardown() {
  const self = view;
  view = null;
  if (!self) return;
  self.alive = false;
  // Ein Wechsel des Bereichs baut den Strom ab, und der Server bricht dann ab
  // (stream.onClose). Ein Tab, den niemand mehr ansieht, darf keinen Stick zu
  // Ende beschreiben, von dem keiner weiß, dass er beschrieben wird.
  for (const controller of self.requests) {
    try { controller.abort(); } catch { /* schon vorbei */ }
  }
  self.requests.clear();
  for (const t of self.timers) clearTimeout(t);
  self.timers.clear();
  for (const t of self.takte) clearInterval(t);
  self.takte.clear();
  for (const off of self.offs) {
    try { off(); } catch { /* schon weg */ }
  }
  self.offs = [];
}

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

function spaeter(self, fn, ms) {
  const t = setTimeout(() => {
    self.timers.delete(t);
    if (self.alive) fn();
  }, ms);
  self.timers.add(t);
  return t;
}

/* ------------------------------------------------------------------ */
/* Laden und Beobachten                                                */
/* ------------------------------------------------------------------ */

async function ladeSelbst(self) {
  try {
    self.selbst = await request(self, (signal) => self.api.get('/stick', { signal, timeoutMs: 20000 }));
    self.selbstFehler = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.selbstFehler = err;
  }
}

/**
 * Nachsehen, was steckt. Es läuft nie mehr als eine Suche; wer währenddessen
 * fragt, bekommt dieselbe -- außer sie begann vor der letzten Änderung (etwa
 * vor [Koppeln]): dann wird danach noch einmal gesucht, und ihr Ergebnis gilt
 * nicht, sonst stünde kurz wieder der alte Stand da.
 */
function ladeKopplung(self, { suchen = true } = {}) {
  if (self.suche) {
    if (self.sucheStand !== self.stand) return self.suche.then(() => ladeKopplung(self, { suchen }));
    return self.suche;
  }
  const stand = self.stand;
  self.sucheStand = stand;
  self.suche = (async () => {
    try {
      const r = await request(self, (signal) => self.api.get('/kopplung', {
        signal,
        timeoutMs: 30000,
        query: suchen ? { suchen: '1', leer: '1' } : undefined,
      }));
      if (!self.alive || stand !== self.stand) return;
      self.kopplung = r;
      self.kopplungFehler = null;
      if (r && typeof r.hinweis === 'string' && r.hinweis) hinweisZeigen(self, r.hinweis);
      if (suchen) vergesseAbgezogene(self);
    } catch (err) {
      if (!self.alive || (err && err.isAborted)) return;
      self.kopplungFehler = err;
    } finally {
      self.suche = null;
    }
  })();
  return self.suche;
}

/** Etwas wurde geändert: was eine ältere Suche bringt, gilt nicht mehr. */
function geaendert(self) {
  self.stand += 1;
}

/** „Gekoppelt mit Max.“ (1.7 Punkt 5) -- über die Schale, damit es nur einmal kommt. */
function hinweisZeigen(self, satz) {
  const shell = self.ctx.shell;
  if (shell && typeof shell.hinweis === 'function') shell.hinweis(satz);
  else self.ctx.toast(satz, 'success');
}

/**
 * Was zu einem Stick gehörte, der nicht mehr steckt, ist vorbei: „Fertig.
 * Stick kann raus.“ stünde sonst noch da, wenn er längst in der Tasche ist.
 */
function vergesseAbgezogene(self) {
  const liste = gefunden(self);
  const pfade = liste.map((g) => g.pfad);
  if (self.hand.plan && self.hand.plan.root) pfade.push(self.hand.plan.root);
  const ids = new Set(liste.map((g) => g.id).filter(Boolean));
  // Ein eben vorbereiteter Stick wird unter „…/Inhalt“ gefunden (Bauplan 2.10.4).
  const steckt = (pfad) => pfade.some((x) => unter(x, pfad));
  for (const [schluessel, v] of self.vorgaenge) {
    if (!schluessel.startsWith('pfad:') || v.laeuft) continue;
    const kennung = v.ergebnis && v.ergebnis.ki && v.ergebnis.ki.id;
    if (!steckt(schluessel.slice(5)) && !(kennung && ids.has(kennung))) self.vorgaenge.delete(schluessel);
  }
  if (self.frage && !steckt(self.frage.pfad)) self.frage = null;
}

function beobachten(self) {
  const takt = setInterval(() => {
    if (!self.alive) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    ladeKopplung(self).then(() => nachZiehen(self));
  }, SUCHEN_MS);
  self.takte.add(takt);

  if (typeof document !== 'undefined') {
    const sichtbar = () => {
      if (document.visibilityState === 'visible' && self.alive) ladeKopplung(self).then(() => nachZiehen(self));
    };
    document.addEventListener('visibilitychange', sichtbar);
    self.offs.push(() => document.removeEventListener('visibilitychange', sichtbar));
  }

  // Was der Dienst von sich aus tut (Start, eingesteckter Partner, Abgleich
  // nach einer Änderung, Beenden), meldet er über den Bus.
  const bus = self.ctx.bus;
  if (bus && typeof bus.on === 'function') {
    const namen = ['kopplung.gekoppelt', 'kopplung.angenommen', 'kopplung.entkoppelt', 'kopplung.abgeglichen',
      'kopplung.zwilling', 'kopplung.zweiFassungen', 'stick.eingerichtet'];
    for (const name of namen) {
      const off = bus.on(name, () => bald(self));
      if (typeof off === 'function') self.offs.push(off);
    }
  }
}

/** Mehrere Meldungen kurz hintereinander: einmal nachsehen. */
function bald(self) {
  if (self.baldTimer) return;
  self.baldTimer = spaeter(self, () => {
    self.baldTimer = null;
    ladeKopplung(self).then(() => nachZiehen(self));
  }, 400);
}

function signatur(self) {
  const k = self.kopplung;
  try {
    return JSON.stringify([
      k ? [k.selbst, k.partner, k.gefunden, k.fassungen, k.laeuft] : null,
      self.kopplungFehler ? fehlerText(self.kopplungFehler) : null,
    ]);
  } catch {
    return String(Math.random());
  }
}

/** Nach einer Suche: nur neu zeichnen, wenn sich etwas geändert hat. */
function nachZiehen(self) {
  if (!self.alive) return;
  const neu = signatur(self);
  if (neu === self.signatur) return;
  alleNeu(self);
}

async function ladeSicherung(self) {
  const pfad = self.hand.pfad.trim();
  try {
    self.sicherung = await request(self, (signal) => self.api.get('/stick/sicherung', {
      signal, query: pfad ? { path: pfad } : undefined,
    }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.sicherung = { fehler: fehlerText(err) };
  }
}

async function ladeListe(self) {
  const ziel = self.sicherung && self.sicherung.ziel;
  try {
    self.liste = await request(self, (signal) => self.api.get('/backup/list', {
      signal, query: ziel && ziel.pfad ? { dir: ziel.pfad } : undefined,
    }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.liste = { items: [], fehler: fehlerText(err) };
  }
}

/* ------------------------------------------------------------------ */
/* Was steckt, wer gekoppelt ist                                       */
/* ------------------------------------------------------------------ */

function gefunden(self) {
  return (self.kopplung && Array.isArray(self.kopplung.gefunden)) ? self.kopplung.gefunden : [];
}

function partnerListe(self) {
  return (self.kopplung && Array.isArray(self.kopplung.partner)) ? self.kopplung.partner : [];
}

/** Die anderen Sticks: was steckt, ohne die Partner (die stehen unter „Gekoppelt“). */
function andereSticks(self) {
  const partner = new Set(partnerListe(self).map((p) => p.id));
  return gefunden(self).filter((g) => !(g.id && partner.has(g.id)));
}

function gefundenVon(self, id) {
  return gefunden(self).find((g) => g.id === id) || null;
}

function selbstPin(self) {
  const k = self.kopplung;
  if (k && k.selbst && typeof k.selbst.pin === 'boolean') return k.selbst.pin;
  return !!(self.selbst && self.selbst.pinNoetig);
}

function schreibtGerade(self) {
  for (const v of self.vorgaenge.values()) if (v.laeuft && SCHREIBEND.has(v.art)) return true;
  return false;
}

/** Der Vorgang zu einem Stick -- über den Pfad, oder über die Kennung der KI, die er eben bekam. */
function vorgangFuer(self, { pfad = null, id = null } = {}) {
  if (pfad && self.vorgaenge.has(`pfad:${pfad}`)) return self.vorgaenge.get(`pfad:${pfad}`);
  if (id) {
    for (const v of self.vorgaenge.values()) {
      if (v.art === 'einrichten' && v.ergebnis && v.ergebnis.ki && v.ergebnis.ki.id === id) return v;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Vorgänge                                                            */
/* ------------------------------------------------------------------ */

function neuerVorgang(self, schluessel, art) {
  const v = {
    art, laeuft: true, percent: 0, message: '', fehler: null, code: null, details: null, ergebnis: null, abbruch: null,
  };
  self.vorgaenge.set(schluessel, v);
  return v;
}

function fehlerSetzen(self, schluessel, satz, art = 'hinweis') {
  const v = neuerVorgang(self, schluessel, art);
  v.laeuft = false;
  v.fehler = satz;
  alleNeu(self);
}

/**
 * Ein Vorgang mit Ereignisstrom (Vorbereiten, Erneuern, Laufzeit holen): der
 * Balken bewegt sich nur, wenn der Server es sagt.
 */
async function stromLauf(self, schluessel, art, route, body, extra = {}) {
  const controller = new AbortController();
  self.requests.add(controller);
  const v = Object.assign(neuerVorgang(self, schluessel, art), extra);
  v.abbruch = controller;
  alleNeu(self);
  try {
    await self.api.stream(route, {
      body,
      signal: controller.signal,
      onEvent: (event) => {
        if (!self.alive) return;
        const nutz = event.payload || {};
        if (event.type === 'fortschritt') {
          if (Number.isFinite(nutz.percent)) v.percent = Math.max(v.percent || 0, nutz.percent);
          if (nutz.message) v.message = String(nutz.message);
        } else if (event.type === 'fertig') {
          v.ergebnis = nutz;
          v.percent = 100;
        } else if (event.type === 'fehler') {
          const e = nutz.error || {};
          v.fehler = fehlerText(e);
          v.code = e.code || null;
          v.details = e.details || null;
        }
        zeichneLauf(self, schluessel);
      },
    });
  } catch (err) {
    v.fehler = err && err.isAborted ? 'Abgebrochen. Auf dem Stick steht der Stand von vorher.' : fehlerText(err);
    v.code = (err && err.code) || null;
    v.details = (err && err.details) || null;
  } finally {
    self.requests.delete(controller);
    v.laeuft = false;
    v.abbruch = null;
  }
  return v;
}

/** Nur den Balken nachziehen -- ein volles Neuzeichnen mehrmals pro Sekunde wäre Unruhe. */
function zeichneLauf(self, schluessel) {
  const v = self.vorgaenge.get(schluessel);
  const ort = self.container && self.container.querySelector(`[data-lauf="${escape(schluessel)}"]`);
  if (!v || !ort || !v.laeuft) {
    alleNeu(self);
    return;
  }
  const p = prozent(v);
  const fuellung = ort.querySelector('.stickv__bar-fill');
  if (fuellung) fuellung.style.width = `${p}%`;
  const balken = ort.querySelector('.stickv__bar');
  if (balken) balken.setAttribute('aria-valuenow', String(p));
  const satz = ort.querySelector('.stickv__lauf-text');
  if (satz) satz.textContent = laufSatz(v);
  const detail = ort.querySelector('.stickv__lauf-detail');
  if (detail) detail.textContent = v.message || '';
}

function prozent(v) {
  return Number.isFinite(v.percent) ? Math.round(Math.max(0, Math.min(100, v.percent))) : 0;
}

function laufSatz(v) {
  const p = prozent(v);
  if (v.art === 'laufzeit') return `Wird geholt … ${p} %`;
  return `Wird vorbereitet … ${p} %`;
}

/* --- [Neue KI] und [Mit dieser KI gekoppelt] (1.6) --- */

async function einrichtenGeklickt(self, auftrag) {
  if (schreibtGerade(self)) return;
  let pin;
  if (auftrag.ki === 'gekoppelt' && auftrag.pinFeld) {
    pin = String(self.pins.get(auftrag.pinFeld) || '');
    if (!PIN_RE.test(pin)) {
      fehlerSetzen(self, auftrag.schluessel, PIN_SATZ);
      return;
    }
  }
  self.frage = null;
  let plan;
  try {
    plan = await request(self, (signal) => self.api.get('/stick/plan', { signal, query: { path: auftrag.pfad } }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    fehlerSetzen(self, auftrag.schluessel, fehlerText(err));
    return;
  }
  if (!self.alive) return;
  // Muss für die anderen Betriebssysteme einmal ins Internet, und erlaubt
  // die Schleuse das nicht schon von sich aus: fragen. Sonst sofort los.
  if (plan.download && plan.download.noetig && !plan.download.erlaubt) {
    self.vorgaenge.delete(auftrag.schluessel);
    self.frage = { ...auftrag, pin, plan };
    alleNeu(self);
    const erlauben = self.container.querySelector(`[data-knopf="${escape(`${auftrag.schluessel}:erlauben`)}"]`);
    if (erlauben) erlauben.focus();
    return;
  }
  await einrichten(self, { ...auftrag, pin }, { andereSysteme: true, erlaubnis: false });
}

/**
 * @param {{schluessel:string, pfad:string, ki:'neu'|'gekoppelt', pin?:string, pinFeld?:string}} auftrag
 * @param {{andereSysteme:boolean|'ohneNetz', erlaubnis:boolean}} wie
 */
async function einrichten(self, auftrag, { andereSysteme, erlaubnis }) {
  if (schreibtGerade(self)) return;
  self.frage = null;
  const body = { path: auftrag.pfad, ki: auftrag.ki, andereSysteme, erlaubnis };
  if (auftrag.ki === 'gekoppelt' && auftrag.pin) body.pin = auftrag.pin;
  const v = await stromLauf(self, auftrag.schluessel, 'einrichten', '/stick/einrichten', body, { frei: auftrag.frei });
  if (!self.alive) return;
  geaendert(self);
  if (v.ergebnis && auftrag.pinFeld) self.pins.delete(auftrag.pinFeld);
  // Danach steckt dort etwas Neues: eine KI, vielleicht schon ein Partner.
  const vonHand = self.hand.plan && self.hand.plan.root === auftrag.pfad;
  await Promise.all([ladeKopplung(self), ladeSicherung(self), vonHand ? handPruefen(self, { leise: true }) : null]);
  if (!self.alive) return;
  alleNeu(self);
  renderSichern(self);
}

/* --- [Koppeln] (1.7) --- */

async function koppeln(self, g, schluessel, pinFeld) {
  const vorher = self.vorgaenge.get(schluessel);
  if (vorher && vorher.laeuft) return;
  const pin = String(self.pins.get(pinFeld) || '');
  if (g.pin && !PIN_RE.test(pin)) {
    fehlerSetzen(self, schluessel, PIN_SATZ, 'koppeln');
    return;
  }
  const v = neuerVorgang(self, schluessel, 'koppeln');
  alleNeu(self);
  try {
    const r = await request(self, (signal) => self.api.post('/kopplung/koppeln',
      pin ? { pfad: g.pfad, pin } : { pfad: g.pfad }, { signal, timeoutMs: 120000 }));
    if (!self.alive) return;
    geaendert(self);
    if (r && typeof r === 'object') self.kopplung = r;
    self.vorgaenge.delete(schluessel);
    self.pins.delete(pinFeld);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    v.fehler = fehlerText(err);
    v.code = (err && err.code) || null;
    v.details = (err && err.details) || null;
    // „Falsche PIN.“: das Feld leeren, damit die nächste nicht an die alte angehängt wird.
    if (v.code === 'FALSCHE_PIN') self.pins.delete(pinFeld);
  } finally {
    v.laeuft = false;
  }
  if (!self.alive) return;
  alleNeu(self);
  await ladeKopplung(self);
  nachZiehen(self);
}

/* --- [Jetzt abgleichen] --- */

async function abgleichen(self) {
  if (self.gleichtAb) return;
  self.gleichtAb = true;
  self.abgleichFehler = null;
  alleNeu(self);
  try {
    const r = await request(self, (signal) => self.api.post('/kopplung/abgleichen', {}, { signal, timeoutMs: 300000 }));
    if (!self.alive) return;
    geaendert(self);
    if (r && typeof r === 'object') {
      const { bericht, ...stand } = r;
      self.kopplung = { ...stand, gefunden: Array.isArray(stand.gefunden) ? stand.gefunden : gefunden(self) };
    }
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.abgleichFehler = fehlerText(err);
  } finally {
    self.gleichtAb = false;
  }
  if (self.alive) alleNeu(self);
}

/* --- [Entkoppeln] (1.7 Punkt 9) --- */

function entkoppelnFragen(self, id) {
  self.entkoppeln = id;
  alleNeu(self);
  const abbrechen = self.container.querySelector(`[data-knopf="${escape(`id:${id}:abbrechen`)}"]`);
  if (abbrechen) abbrechen.focus();
}

function entkoppelnAbbrechen(self, id) {
  self.entkoppeln = null;
  alleNeu(self);
  const zurueck = self.container.querySelector(`[data-knopf="${escape(`id:${id}:entkoppeln`)}"]`);
  if (zurueck) zurueck.focus();
}

async function entkoppeln(self, p) {
  const schluessel = `id:${p.id}`;
  const v = neuerVorgang(self, schluessel, 'entkoppeln');
  alleNeu(self);
  try {
    await request(self, (signal) => self.api.post('/kopplung/entkoppeln', { id: p.id }, { signal, timeoutMs: 60000 }));
    if (!self.alive) return;
    geaendert(self);
    self.vorgaenge.delete(schluessel);
    self.entkoppeln = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    v.fehler = fehlerText(err);
    v.code = (err && err.code) || null;
  } finally {
    v.laeuft = false;
  }
  if (!self.alive) return;
  await ladeKopplung(self);
  if (self.alive) alleNeu(self);
}

/* --- [Diesen Stick eigenständig machen] (1.7 Punkt 10) --- */

async function eigenstaendig(self) {
  const schluessel = 'eigenstaendig';
  const vorher = self.vorgaenge.get(schluessel);
  if (vorher && vorher.laeuft) return;
  const v = neuerVorgang(self, schluessel, 'eigenstaendig');
  alleNeu(self);
  try {
    await request(self, (signal) => self.api.post('/kopplung/eigenstaendig', {}, { signal, timeoutMs: 120000 }));
  } catch (err) {
    v.laeuft = false;
    if (!self.alive || (err && err.isAborted)) return;
    v.fehler = fehlerText(err);
    alleNeu(self);
    return;
  }
  // Diese KI hat jetzt eine neue Kennung. Alles, was der Browser unter der
  // alten weiß (web/lib/lokal.js), gilt nicht mehr: neu laden.
  if (typeof window !== 'undefined' && window.location) window.location.reload();
}

/* --- [Lena erneuern] (1.7 Punkt 11) und [Erneuern] (1.6) --- */

async function erneuern(self, g, schluessel) {
  if (schreibtGerade(self)) return;
  await stromLauf(self, schluessel, 'erneuern', '/stick/update', { path: g.pfad });
  if (!self.alive) return;
  geaendert(self);
  await ladeKopplung(self);
  if (self.alive) alleNeu(self);
}

/* --- [Für Mac holen] / [Für Windows holen] (1.6) --- */

async function laufzeitHolen(self, schluessel, root, familie) {
  if (!root || schreibtGerade(self)) return;
  const bekannt = (self.selbst && Array.isArray(self.selbst.bekanntePlattformen)) ? self.selbst.bekanntePlattformen : null;
  const plattformen = HOLEN[familie].filter((p) => !bekannt || bekannt.includes(p));
  if (!plattformen.length) return;
  const v = await stromLauf(self, schluessel, 'laufzeit', '/stick/runtime', { path: root, platforms: plattformen, erlaubnis: true });
  if (!self.alive) return;
  geaendert(self);
  const r = v.ergebnis;
  if (r && Array.isArray(r.fehlend) && r.fehlend.length === 0) {
    // Geholt: die Zeile verschwindet mit dem neuen Stand, der Vorgang mit ihr.
    self.vorgaenge.delete(schluessel);
    self.ctx.toast(`Läuft jetzt auch ${familie === 'mac' ? 'am Mac' : 'an Windows'}.`, 'success');
  }
  await Promise.all([ladeSelbst(self), ladeKopplung(self)]);
  if (self.alive) alleNeu(self);
}

/* --- Ort von Hand (wenn die Suche einen Stick nicht findet) --- */

/** @param {{leise?:boolean}} [opts] leise: ohne „Wird geprüft …“ (nach dem Vorbereiten) */
async function handPruefen(self, { leise = false } = {}) {
  const pfad = self.hand.pfad.trim();
  if (!pfad || self.hand.laeuft) return;
  self.hand.laeuft = !leise;
  self.hand.fehler = null;
  if (!leise) alleNeu(self);
  try {
    self.hand.plan = await request(self, (signal) => self.api.get('/stick/plan', { signal, query: { path: pfad } }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.hand.plan = null;
    self.hand.fehler = fehlerText(err);
  } finally {
    self.hand.laeuft = false;
  }
  if (self.alive) alleNeu(self);
}

/* ------------------------------------------------------------------ */
/* 2. Sichern                                                          */
/* ------------------------------------------------------------------ */

async function sichern(self) {
  if (self.sichernLaeuft) return;
  self.sichernLaeuft = true;
  self.sichernFehler = null;
  self.gesichert = null;
  renderSichern(self);
  try {
    const pfad = self.hand.pfad.trim();
    self.gesichert = await request(self, (signal) => self.api.post('/stick/sichern',
      pfad ? { path: pfad } : {}, { signal, timeoutMs: 600000 }));
    self.ctx.toast('Gesichert.', 'success');
    await ladeSicherung(self);
    if (self.offen) await ladeListe(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.sichernFehler = err;
  } finally {
    self.sichernLaeuft = false;
    if (self.alive) {
      renderSichern(self);
      if (self.offen) renderWieder(self);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Wiederherstellen (die Funktion der früheren „Sicherung")         */
/* ------------------------------------------------------------------ */

function quelleKoerper(self) {
  const quelle = String(self.quelle || '').trim();
  const klein = quelle.toLowerCase();
  const body = klein.endsWith('.json') || klein.endsWith('.enc') ? { file: quelle } : { dir: quelle };
  if (self.pass) body.passphrase = self.pass;
  return body;
}

/**
 * Gilt die Vorschau noch für das, was eingestellt ist? Eine Vorschau ist eine
 * Aussage über GENAU EINE Sicherung in GENAU EINEM Modus; daneben ein anderer
 * Pfad oder Modus, und sie beschreibt etwas, das so nicht passieren würde.
 */
function vorschauGilt(self) {
  const v = self.vorschau;
  if (!v || v.mode !== self.modus) return false;
  return String(self.quelle || '').trim() === self.vorschauQuelle;
}

async function ansehen(self) {
  const quelle = String(self.quelle || '').trim();
  if (!quelle) return;
  self.vorschauLaeuft = true;
  self.vorschauFehler = null;
  self.ergebnis = null;
  self.ergebnisFehler = null;
  renderWieder(self);
  try {
    const r = await request(self, (signal) => self.api.post('/backup/preview',
      { ...quelleKoerper(self), mode: self.modus }, { signal, timeoutMs: 120000 }));
    if (!self.alive) return;
    self.vorschau = r;
    self.vorschauQuelle = quelle;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.vorschau = null;
    self.vorschauFehler = err;
  } finally {
    self.vorschauLaeuft = false;
    if (self.alive) renderWieder(self);
  }
}

async function wiederherstellen(self) {
  const quelle = String(self.quelle || '').trim();
  if (!quelle || !vorschauGilt(self)) return;
  const modus = MODI.find((m) => m.value === self.modus) || MODI[0];
  const v = self.vorschau;
  const zeilen = [];
  if (v && v.sicherung) zeilen.push(`${formatNumber(v.sicherung.records || 0)} Einträge kommen aus der Sicherung.`);
  if (v && Array.isArray(v.verschwindet) && v.verschwindet.length) zeilen.push(`Es verschwindet: ${v.verschwindet.join('; ')}.`);
  const ok = await self.ctx.confirm({
    title: modus.value === 'restore' ? 'Alles durch die Sicherung ersetzen?' : 'Wiederherstellen?',
    message: zeilen.join(' ') || quelle,
    confirmLabel: modus.value === 'restore' ? 'Ja, alles ersetzen' : 'Wiederherstellen',
    danger: modus.gefahr,
  });
  if (!ok || !self.alive) return;

  self.importLaeuft = true;
  self.ergebnis = null;
  self.ergebnisFehler = null;
  renderWieder(self);
  try {
    const r = await request(self, (signal) => self.api.post('/backup/import',
      { ...quelleKoerper(self), mode: self.modus }, { signal, timeoutMs: 600000 }));
    if (!self.alive) return;
    self.ergebnis = r;
    self.ctx.toast(`Wiederhergestellt: ${formatNumber((r && r.imported) || 0)} Einträge.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ergebnisFehler = err;
  } finally {
    self.importLaeuft = false;
    if (self.alive) renderWieder(self);
  }
}

/* ------------------------------------------------------------------ */
/* Aufbau                                                              */
/* ------------------------------------------------------------------ */

function render(self) {
  if (!self.alive || !self.container) return;
  clear(self.container);
  self.dieserTitel = h('h2.stickv__titel', null, text('Dieser Stick'));
  self.dieserSlot = h('div.stickv__inhalt');
  self.andereSlot = h('div.stickv__inhalt', { 'aria-live': 'polite' });
  self.handSlot = h('div.stickv__inhalt');
  self.gekoppeltSlot = h('div.stickv__inhalt', { 'aria-live': 'polite' });
  self.sichernSlot = h('div.stickv__sichern');
  self.wiederSlot = h('div.stickv__wieder-inhalt');
  self.gekoppeltKarte = h('section.card.stickv__karte', { 'aria-label': 'Gekoppelt', dataset: { karte: 'gekoppelt' } },
    h('h2.stickv__titel', null, text('Gekoppelt')),
    self.gekoppeltSlot);

  const page = h('div.page.stickv', null,
    h('section.card.stickv__karte', { 'aria-label': 'Dieser Stick', dataset: { karte: 'dieser' } },
      self.dieserTitel,
      self.dieserSlot),
    h('section.card.stickv__karte', { 'aria-label': 'Andere Sticks', dataset: { karte: 'andere' } },
      h('div.stickv__kopf', null,
        h('h2.stickv__titel', null, text('Andere Sticks')),
        // Gesucht wird ohnehin alle 15 s; wer den Stick eben eingesteckt hat, muss nicht warten.
        self.suchenKnopf = h('button.btn.btn--ghost.btn--small', {
          type: 'button',
          dataset: { knopf: 'neu-suchen' },
          onClick: async () => {
            if (self.suchenKnopf) self.suchenKnopf.disabled = true;
            await ladeKopplung(self);
            if (!self.alive) return;
            if (self.suchenKnopf) self.suchenKnopf.disabled = false;
            alleNeu(self);
          },
        }, icon(self.icons.refresh || ''), text('Neu suchen'))),
      self.andereSlot,
      handKarte(self)),
    self.gekoppeltKarte,
    sichernKarte(self));
  self.container.appendChild(page);
  alleNeu(self);
  renderSichern(self);
  renderWieder(self);
}

/**
 * Die drei oberen Karten neu zeichnen. Ein Feld mit dem Cursor darin (eine
 * PIN, halb getippt) und ein Knopf mit dem Fokus darauf bleiben, wo sie sind:
 * sie tragen einen Schlüssel (data-feld, data-knopf) und werden danach
 * wiedergefunden.
 */
function alleNeu(self) {
  if (!self.alive || !self.container || !self.dieserSlot) return;
  const aktiv = typeof document !== 'undefined' ? document.activeElement : null;
  const drin = aktiv && self.container.contains(aktiv) && aktiv.dataset ? aktiv : null;
  const feld = drin && drin.dataset.feld ? drin.dataset.feld : null;
  const knopfSchluessel = !feld && drin && drin.dataset.knopf ? drin.dataset.knopf : null;
  const auswahl = feld ? [drin.selectionStart, drin.selectionEnd] : null;

  renderDieser(self);
  renderAndere(self);
  renderHand(self);
  renderGekoppelt(self);
  self.signatur = signatur(self);

  if (feld) {
    const neu = self.container.querySelector(`[data-feld="${escape(feld)}"]`);
    if (neu) {
      neu.focus();
      try { neu.setSelectionRange(auswahl[0], auswahl[1]); } catch { /* nicht jedes Feld kann das */ }
    }
  } else if (knopfSchluessel) {
    const neu = self.container.querySelector(`[data-knopf="${escape(knopfSchluessel)}"]`);
    if (neu && !neu.disabled) neu.focus();
  }
}

/* --------------------------------------------------- Bausteine */

function still(satz, extra = {}) {
  return h('p.stickv__still', extra, text(satz));
}

function meldung(self, satz) {
  return h('div.stickv__meldung', { role: 'alert' }, icon(self.icons.alert || ''), h('span', null, text(satz)));
}

/**
 * Ein Knopf mit Schlüssel (für den Fokus nach dem Neuzeichnen).
 * @param {{beschriftung:string, schluessel:string, art?:string, symbol?:string, disabled?:boolean, title?:string, onClick:Function}} o
 */
function knopf(self, o) {
  const art = o.art ? `.btn--${o.art}` : '';
  return h(`button.btn${art}`, {
    type: 'button',
    disabled: !!o.disabled,
    title: o.title || null,
    dataset: { knopf: o.schluessel },
    onClick: o.onClick,
  }, o.symbol ? icon(o.symbol) : null, text(o.beschriftung));
}

/**
 * Ein PIN-Feld. Kein type=password, kein <form>, kein Autofill: der Browser
 * soll die PIN nicht speichern wollen (wie in den Einstellungen). Die Punkte
 * macht CSS (-webkit-text-security).
 */
function pinFeld(self, feldSchluessel, beschriftung, onEnter) {
  const feld = h('input.input.stickv__pin', {
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: '6',
    spellcheck: 'false',
    value: self.pins.get(feldSchluessel) || '',
    'aria-label': beschriftung,
    dataset: { feld: feldSchluessel },
    attrs: { autocorrect: 'off', autocapitalize: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', enterkeyhint: 'done' },
    onInput: (ev) => {
      const el = ev.currentTarget;
      const sauber = el.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (sauber !== el.value) el.value = sauber;
      self.pins.set(feldSchluessel, sauber);
    },
    onKeydown: (ev) => {
      if (ev.key === 'Enter' && typeof onEnter === 'function') {
        ev.preventDefault();
        onEnter();
      }
    },
  });
  return h('label.stickv__pinfeld', null, h('span.stickv__pinfeld-name', null, text(beschriftung)), feld);
}

/**
 * Eine Zeile für einen Stick oder Partner: der Satz, darunter was gerade
 * ist (Balken, Frage, Meldung, „Fertig.“), dann die Knöpfe.
 */
function reihe(self, o) {
  const kinder = [h('p.stickv__satz', null, text(o.satz))];
  for (const z of o.zusatz || []) {
    kinder.push(h('div.stickv__zusatz', null,
      h('span.stickv__hinweis', null, text(z.satz)),
      z.knopf || null));
  }
  // Erst was ist („Fertig. Stick kann raus.“, „Falsche PIN.“), dann was man tun kann.
  const zustand = o.unten || vorgangBlock(self, o.schluessel, o.vorgang);
  if (zustand) kinder.push(zustand);
  if (o.knoepfe && o.knoepfe.length) kinder.push(h('div.stickv__knoepfe', null, ...o.knoepfe));
  return h('div.stickv__reihe', {
    dataset: { art: o.art, schluessel: o.schluessel, ...(o.data || {}) },
    class: o.warn ? 'is-warn' : '',
  }, ...kinder);
}

/** Was ein Vorgang gerade zeigt -- oder null. */
function vorgangBlock(self, schluessel, v) {
  if (self.frage && self.frage.schluessel === schluessel) return frageBlock(self);
  if (!v) return null;
  if (v.laeuft) {
    if (SCHREIBEND.has(v.art)) {
      const p = prozent(v);
      return h('div.stickv__lauf', { dataset: { lauf: schluessel } },
        h('div.stickv__bar', {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(p),
          'aria-label': 'Fortschritt',
        }, h('div.stickv__bar-fill', { style: `width:${p}%` })),
        h('div.stickv__lauf-zeile', null,
          h('span.stickv__lauf-text', null, text(laufSatz(v))),
          h('button.btn.btn--ghost.btn--small', {
            type: 'button',
            dataset: { knopf: `${schluessel}:stopp` },
            onClick: () => { if (v.abbruch) v.abbruch.abort(); },
          }, icon(EIGENE_ICONS.stop), text('Abbrechen'))),
        h('p.stickv__lauf-detail', null, text(v.message || '')));
    }
    const worte = { koppeln: 'Wird gekoppelt …', entkoppeln: 'Wird entkoppelt …', eigenstaendig: 'Bekommt eine eigene Kennung …' };
    return h('p.stickv__still.stickv__arbeitet', { role: 'status' },
      h('span.spinner', { 'aria-hidden': 'true' }), text(` ${worte[v.art] || 'Einen Moment …'}`));
  }
  if (v.fehler) {
    const block = meldung(self, v.fehler);
    // „Lena hat eine PIN, dieser Stick nicht.“ [PIN festlegen] (1.7 Punkt 3)
    if (v.code === 'KOPPLUNG_SCHUTZ' && v.details && v.details.pinHier === false) {
      return h('div.stickv__zusatz', null, block, pinFestlegenKnopf(self, schluessel));
    }
    return block;
  }
  if (v.ergebnis && (v.art === 'einrichten' || v.art === 'erneuern')) return fertigBlock(self, schluessel, v.ergebnis);
  if (v.ergebnis && v.art === 'laufzeit') {
    const saetze = fehlendSaetze(v.ergebnis.fehlend);
    if (!saetze.length) return null;
    return h('div.stickv__zusatz', { role: 'status' }, ...saetze.map((satz) => h('p.stickv__hinweis', null, text(satz))));
  }
  return null;
}

/** Die eine Rückfrage vor dem Vorbereiten: zwei Knöpfe, keine Erklärung. */
function frageBlock(self) {
  const f = self.frage;
  const plan = f.plan || {};
  const hier = familien([plan.dieserRechner])[0] || plan.dieserRechnerName || 'dieses System';
  const ausDemNetz = plan.ausDemNetz || plan.andere || [];
  let ziele = familien(ausDemNetz).filter((x) => x !== hier);
  // Fehlt nur der andere Mac-Chip, heißt er mit seinem Namen.
  if (!ziele.length) ziele = plan.ausDemNetzNamen || plan.andereNamen || [];
  // Liegt ein Teil ohne Netz bereit (eigener Stick, Zwischenspeicher), kommt der ohne Frage mit.
  const ohneNetzDa = (plan.andere || []).some((p) => !ausDemNetz.includes(p));
  return h('div.stickv__frage', { role: 'group', 'aria-label': 'Einmal ins Internet?' },
    h('p.stickv__frage-text', null, text(
      `Damit der Stick auch an ${aufzaehlen(ziele)} startet, lädt Neural OS einmal die Laufzeit `
      + 'dafür von nodejs.org. Darf es?')),
    h('div.stickv__antworten', null,
      knopf(self, {
        beschriftung: 'Erlauben',
        art: 'accent',
        symbol: self.icons.globe || '',
        schluessel: `${f.schluessel}:erlauben`,
        onClick: () => einrichten(self, f, { andereSysteme: true, erlaubnis: true }),
      }),
      knopf(self, {
        beschriftung: ohneNetzDa ? 'Ohne Internet' : `Nur ${hier}`,
        art: 'accent',
        schluessel: `${f.schluessel}:ohne`,
        onClick: () => einrichten(self, f, { andereSysteme: ohneNetzDa ? 'ohneNetz' : false, erlaubnis: false }),
      })));
}

/** „Fertig. Stick kann raus.“ (1.6) -- und woran der neue Stick noch nicht startet. */
function fertigBlock(self, schluessel, r) {
  const kinder = [
    h('p.stickv__fertig-titel', null,
      h('span.stickv__haken', null, icon(self.icons.checkCircle || self.icons.check || '')),
      text('Fertig. Stick kann raus.')),
  ];
  for (const satz of fehlendSaetze(r.fehlend)) kinder.push(h('p.stickv__hinweis', null, text(satz)));
  // „Windows sieht diesen Stick nicht.“ (am Mac mit APFS vorbereitet, 1.6)
  for (const hw of Array.isArray(r.hinweise) ? r.hinweise : []) {
    if (hw && hw.satz) kinder.push(h('p.stickv__hinweis', { dataset: { code: hw.code || '' } }, text(hw.satz)));
  }
  const laufzeiten = Array.isArray(r.laufzeiten) ? r.laufzeiten : null;
  const root = r.root || r.basis || null;
  if (laufzeiten && root) {
    const win = laufzeiten.some((p) => String(p).startsWith('win'));
    const mac = laufzeiten.some((p) => String(p).startsWith('darwin'));
    if (win !== mac) {
      const familie = win ? 'mac' : 'windows';
      kinder.push(h('div.stickv__zusatz', null,
        h('span.stickv__hinweis', null, text(win ? 'Läuft bisher nur an Windows.' : 'Läuft bisher nur am Mac.')),
        knopf(self, {
          beschriftung: win ? 'Für Mac holen' : 'Für Windows holen',
          symbol: EIGENE_ICONS.download,
          schluessel: `${schluessel}:holen`,
          disabled: schreibtGerade(self),
          title: 'Lädt die Laufzeit einmal von nodejs.org.',
          onClick: () => laufzeitHolen(self, schluessel, root, familie),
        })));
    }
  }
  return h('div.stickv__fertig', { role: 'status' }, ...kinder);
}

function pinFestlegenKnopf(self, schluessel = 'pin') {
  return knopf(self, {
    beschriftung: 'PIN festlegen',
    art: 'accent',
    symbol: self.icons.lock || '',
    schluessel: `${schluessel}:pin-festlegen`,
    onClick: () => self.ctx.navigate('#/settings?bereich=schutz'),
  });
}

/* ------------------------------------------------ Dieser Stick */

function renderDieser(self) {
  const slot = self.dieserSlot;
  if (!slot) return;
  clear(slot);
  const s = self.selbst;
  if (self.selbstFehler && !s) {
    slot.appendChild(meldung(self, fehlerText(self.selbstFehler)));
    return;
  }
  if (!s) {
    slot.appendChild(still('Wird geprüft …'));
    return;
  }
  if (!s.portabel) {
    self.dieserTitel.textContent = 'Dieser Rechner';
    slot.appendChild(still('Neural OS läuft von diesem Rechner, nicht von einem Stick.'));
  } else {
    self.dieserTitel.textContent = 'Dieser Stick';
    const root = s.von && s.von.root;
    const zeile = [root, frei(s.freieBytes)].filter(Boolean).join(' · ');
    if (zeile) slot.appendChild(still(zeile, { dataset: { ort: '1' } }));
    // „Läuft bisher nur an Windows.“ [Für Mac holen] (1.6) -- die Sätze kommen vom Server.
    const probleme = (s.pruefung && Array.isArray(s.pruefung.problems)) ? s.pruefung.problems : [];
    for (const p of probleme) {
      if (p.code !== 'FEHLT_WINDOWS' && p.code !== 'FEHLT_MAC') continue;
      const familie = p.code === 'FEHLT_MAC' ? 'mac' : 'windows';
      const schluessel = `laufzeit:${familie}`;
      const v = self.vorgaenge.get(schluessel);
      slot.appendChild(reihe(self, {
        art: 'laufzeit',
        schluessel,
        satz: p.message,
        knoepfe: v && v.laeuft ? [] : [knopf(self, {
          beschriftung: p.fix || (familie === 'mac' ? 'Für Mac holen' : 'Für Windows holen'),
          art: 'accent',
          symbol: EIGENE_ICONS.download,
          schluessel: `${schluessel}:holen`,
          disabled: schreibtGerade(self),
          title: 'Lädt die Laufzeit einmal von nodejs.org.',
          onClick: () => laufzeitHolen(self, schluessel, root, familie),
        })],
        vorgang: v,
      }));
    }
    // „Windows sieht diesen Stick nicht.“ und was das Dateisystem sonst sagt.
    for (const hinweis of Array.isArray(s.hinweise) ? s.hinweise : []) {
      if (hinweis && hinweis.satz) slot.appendChild(h('p.stickv__hinweis', { dataset: { code: hinweis.code || '' } }, text(hinweis.satz)));
    }
  }
  // Diese KI ist die Kopie einer anderen (Gabelung, fremdes Postfach), und
  // die andere steckt gerade nicht: dann steht es hier.
  const k = self.kopplung;
  if (k && k.selbst && k.selbst.zwilling && !gefunden(self).some((g) => g.zustand === 'zwilling')) {
    slot.appendChild(zwillingReihe(self, null));
  }
}

/* ------------------------------------------------ Andere Sticks */

function renderAndere(self) {
  const slot = self.andereSlot;
  if (!slot) return;
  clear(slot);
  if (self.kopplungFehler && !self.kopplung) {
    slot.appendChild(meldung(self, fehlerText(self.kopplungFehler)));
    return;
  }
  if (!self.kopplung) {
    slot.appendChild(still('Suche Sticks …'));
    return;
  }
  const handRoot = self.hand.plan && self.hand.plan.root;
  // Was gerade vorbereitet wird, bleibt der leere Stick, den man angetippt
  // hat -- auch wenn die Suche mittendrin schon eine KI (unter „…/Inhalt“) sieht.
  const laufend = [];
  for (const [k, v] of self.vorgaenge) {
    if (k.startsWith('pfad:') && v.art === 'einrichten' && v.laeuft && k.slice(5) !== handRoot) laufend.push({ pfad: k.slice(5), v });
  }
  const liste = andereSticks(self).filter((g) => !(handRoot && unter(g.pfad, handRoot)) // steht unter „Ort von Hand“
    && !laufend.some((l) => unter(g.pfad, l.pfad)));
  if (!liste.length && !laufend.length) {
    slot.appendChild(still('Kein anderer Stick gefunden. Steckst du einen ein, erscheint er hier von selbst.', { dataset: { leer: '1' } }));
  }
  for (const l of laufend) slot.appendChild(leerReihe(self, l.pfad, l.v.frei, l.v));
  for (const g of liste) slot.appendChild(stickReihe(self, g));
}

function stickReihe(self, g) {
  const schluessel = `pfad:${g.pfad}`;
  const v = vorgangFuer(self, { pfad: g.pfad, id: g.id });
  const name = g.name || 'ohne Namen';
  // Während er vorbereitet wird, bleibt er der leere Stick, den man angetippt
  // hat. Danach zeigt er, was er jetzt ist („Anderer Stick: …“ [Koppeln]),
  // und darunter steht „Fertig. Stick kann raus.“
  if (v && v.art === 'einrichten' && v.laeuft) return leerReihe(self, g.pfad, g.frei, v);
  if (g.zustand === 'zwilling') return zwillingReihe(self, g);
  if (g.zustand === 'aelter') {
    return reihe(self, {
      art: 'aelter',
      schluessel,
      satz: `${name} hat eine ältere Version.`,
      knoepfe: v && v.laeuft ? [] : [erneuernKnopf(self, g, schluessel)],
      vorgang: v,
      data: { pfad: g.pfad },
    });
  }
  if (g.zustand === 'neuer') {
    return reihe(self, { art: 'neuer', schluessel, satz: `${name} hat eine neuere Version.`, vorgang: v, data: { pfad: g.pfad } });
  }
  // Ein Stick ohne KI (leer, oder nur das Programm drauf) bekommt eine.
  if (g.zustand === 'leer' || !g.id) return leerReihe(self, g.pfad, g.frei, v);
  return fremdReihe(self, g, v);
}

/** „Leerer Stick: E:\ · 14,2 GB frei“ [Neue KI] [Mit dieser KI gekoppelt] (1.6) */
function leerReihe(self, pfad, freiBytes, v) {
  const schluessel = `pfad:${pfad}`;
  const satz = [`Leerer Stick: ${pfad}`, frei(freiBytes)].filter(Boolean).join(' · ');
  const gesperrt = schreibtGerade(self) || !!(v && v.laeuft);
  const knoepfe = [];
  const fertig = v && v.art === 'einrichten' && v.ergebnis;
  if (!(v && v.laeuft) && !fertig && !(self.frage && self.frage.schluessel === schluessel)) {
    knoepfe.push(knopf(self, {
      beschriftung: 'Neue KI',
      art: 'primary',
      symbol: self.icons.stick || '',
      schluessel: `${schluessel}:neu`,
      disabled: gesperrt,
      onClick: () => einrichtenGeklickt(self, { schluessel, pfad, frei: freiBytes, ki: 'neu' }),
    }));
    const koppelnGeht = !self.selbst || self.selbst.koppelnMoeglich !== false;
    if (koppelnGeht) {
      const pinNoetig = selbstPin(self);
      const feldSchluessel = `neu:${pfad}`;
      const auftrag = { schluessel, pfad, frei: freiBytes, ki: 'gekoppelt', pinFeld: pinNoetig ? feldSchluessel : null };
      knoepfe.push(h('div.stickv__gruppe', null,
        // Gekoppelte Sticks sind entweder beide geschützt oder beide nicht.
        pinNoetig ? pinFeld(self, feldSchluessel, 'PIN für den neuen Stick', () => einrichtenGeklickt(self, auftrag)) : null,
        knopf(self, {
          beschriftung: 'Mit dieser KI gekoppelt',
          symbol: EIGENE_ICONS.koppeln,
          schluessel: `${schluessel}:gekoppelt`,
          disabled: gesperrt,
          onClick: () => einrichtenGeklickt(self, auftrag),
        })));
    }
  }
  return reihe(self, { art: 'leer', schluessel, satz, knoepfe, vorgang: v, data: { pfad } });
}

/** „Anderer Stick: Lena“ [Koppeln], mit „PIN von Lena“, wenn Lena eine hat (1.7) */
function fremdReihe(self, g, v) {
  const schluessel = `pfad:${g.pfad}`;
  const name = g.name || 'ohne Namen';
  const feldSchluessel = `pin:${g.pfad}`;
  const los = () => koppeln(self, g, schluessel, feldSchluessel);
  const knoepfe = [];
  if (!(v && v.laeuft)) {
    if (g.pin) knoepfe.push(pinFeld(self, feldSchluessel, `PIN von ${name}`, los));
    knoepfe.push(knopf(self, {
      beschriftung: 'Koppeln',
      art: 'primary',
      symbol: EIGENE_ICONS.koppeln,
      schluessel: `${schluessel}:koppeln`,
      onClick: los,
    }));
  }
  return reihe(self, { art: 'fremd', schluessel, satz: `Anderer Stick: ${name}`, knoepfe, vorgang: v, data: { pfad: g.pfad, id: g.id || '' } });
}

/** „Zwei Sticks tragen dieselbe KI.“ [Diesen Stick eigenständig machen] (1.7 Punkt 10) */
function zwillingReihe(self, g) {
  const schluessel = 'eigenstaendig';
  const v = self.vorgaenge.get(schluessel);
  return reihe(self, {
    art: 'zwilling',
    schluessel,
    satz: 'Zwei Sticks tragen dieselbe KI.',
    warn: true,
    knoepfe: v && v.laeuft ? [] : [knopf(self, {
      beschriftung: 'Diesen Stick eigenständig machen',
      art: 'accent',
      schluessel: 'eigenstaendig:los',
      onClick: () => eigenstaendig(self),
    })],
    vorgang: v,
    data: g ? { pfad: g.pfad } : {},
  });
}

function erneuernKnopf(self, g, schluessel) {
  const name = g.name || 'den Stick';
  return knopf(self, {
    beschriftung: g.name ? `${name} erneuern` : 'Erneuern',
    art: 'accent',
    schluessel: `${schluessel}:erneuern`,
    disabled: schreibtGerade(self),
    onClick: () => erneuern(self, g, schluessel),
  });
}

/* ------------------------------------------------ Ort von Hand */

function handKarte(self) {
  const details = h('details.stickv__hand', {
    onToggle: (e) => {
      self.hand.offen = e.target.open;
      if (self.hand.offen && self.handFeld) setTimeout(() => { try { self.handFeld.focus(); } catch { /* weg */ } }, 30);
    },
  },
  h('summary.stickv__hand-titel', null, text('Stick nicht dabei? Ort von Hand eintragen')),
  h('div.stickv__hand-inhalt', null, handZeile(self), self.handSlot));
  if (self.hand.offen) details.open = true;
  return details;
}

function handZeile(self) {
  const feld = h('input.input.stickv__feld', {
    type: 'text',
    value: self.hand.pfad,
    placeholder: 'z. B. E:\\  oder  /Volumes/STICK',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Ort des Sticks',
    onInput: (e) => {
      self.hand.pfad = e.target.value;
      self.hand.plan = null;
      self.hand.fehler = null;
      if (self.handKnopf) self.handKnopf.disabled = !self.hand.pfad.trim();
      renderHand(self);
      // Das Ziel von „Jetzt sichern“ folgt dem Feld.
      if (self.tippTimer) clearTimeout(self.tippTimer);
      self.tippTimer = spaeter(self, async () => {
        self.tippTimer = null;
        await ladeSicherung(self);
        renderSichern(self);
      }, 450);
    },
    onKeyDown: (e) => { if (e.key === 'Enter') handPruefen(self); },
  });
  self.handFeld = feld;
  self.handKnopf = h('button.btn', {
    type: 'button',
    disabled: !self.hand.pfad.trim(),
    onClick: () => handPruefen(self),
  }, text('Prüfen'));
  return h('div.stickv__feldzeile', null, feld, self.handKnopf);
}

function renderHand(self) {
  const slot = self.handSlot;
  if (!slot) return;
  clear(slot);
  if (self.hand.laeuft) {
    slot.appendChild(still('Wird geprüft …'));
    return;
  }
  if (self.hand.fehler) {
    slot.appendChild(meldung(self, self.hand.fehler));
    return;
  }
  const plan = self.hand.plan;
  if (!plan) return;
  const k = self.kopplung;
  const ich = k && k.selbst ? k.selbst.id : null;
  const partner = plan.ki && plan.ki.id ? partnerListe(self).find((p) => p.id === plan.ki.id) : null;
  if (plan.eigener) {
    slot.appendChild(still('Das ist dieser Stick.'));
  } else if (partner) {
    slot.appendChild(still(`Gekoppelt mit ${partner.name || 'diesem Stick'}.`));
  } else if (plan.ki && plan.ki.id && ich && plan.ki.id === ich) {
    slot.appendChild(zwillingReihe(self, { pfad: plan.root }));
  } else if (!plan.istStick || !(plan.ki && plan.ki.id)) {
    // Keine KI darauf: ein leerer Stick, wie ihn die Suche auch zeigt.
    const v = vorgangFuer(self, { pfad: plan.root });
    slot.appendChild(leerReihe(self, plan.root, plan.frei, v));
  } else {
    const g = {
      pfad: plan.root,
      id: plan.ki ? plan.ki.id : null,
      name: plan.ki ? plan.ki.name : null,
      pin: plan.pin === true,
      zustand: plan.aelter ? 'aelter' : 'fremd',
    };
    slot.appendChild(stickReihe(self, g));
  }
}

/* ------------------------------------------------ Gekoppelt */

function renderGekoppelt(self) {
  const slot = self.gekoppeltSlot;
  if (!slot) return;
  clear(slot);
  const k = self.kopplung;
  const partner = partnerListe(self);
  const schonGesehen = gesehen();
  const fassungen = ((k && Array.isArray(k.fassungen)) ? k.fassungen : [])
    .filter((f) => f && f.kopieId && !schonGesehen.has(f.kopieId))
    .slice(0, 5);
  if (self.gekoppeltKarte) self.gekoppeltKarte.hidden = !partner.length && !fassungen.length;
  for (const p of partner) slot.appendChild(partnerReihe(self, p));
  if (self.abgleichFehler) slot.appendChild(meldung(self, self.abgleichFehler));
  for (const f of fassungen) slot.appendChild(fassungReihe(self, f));
}

/** „Gekoppelt mit Lena · abgeglichen 14:03“ [Jetzt abgleichen] [Entkoppeln] (1.7) */
function partnerReihe(self, p) {
  const k = self.kopplung || {};
  const schluessel = `id:${p.id}`;
  const v = self.vorgaenge.get(schluessel);
  const name = p.name || 'ohne Namen';
  const ueber = Array.isArray(p.ueber) ? p.ueber.filter(Boolean) : [];

  let satz = `Gekoppelt mit ${name}`;
  if (ueber.length) satz += ` (über ${name} auch: ${ueber.join(', ')})`;
  const gleicht = p.steckt && (self.gleichtAb || k.laeuft === true);
  if (gleicht) satz += ' · Gleiche ab …';
  else if (p.zustand === 'wartet') satz += ` · ${name} übernimmt beim nächsten Start`;
  else if (p.zuletzt) satz += p.steckt ? ` · abgeglichen ${wann(p.zuletzt)}` : ` · zuletzt ${wann(p.zuletzt)}`;

  const zusatz = [];
  if (p.zustand === 'schutz') {
    if (p.pin === true && !selbstPin(self)) zusatz.push({ satz: `${name} hat eine PIN, dieser Stick nicht.`, knopf: pinFestlegenKnopf(self, schluessel) });
    else if (p.pin === false && selbstPin(self)) zusatz.push({ satz: `Dieser Stick hat eine PIN, ${name} nicht.` });
  } else if (p.zustand === 'zwilling') {
    zusatz.push({ satz: 'Zwei Sticks tragen dieselbe KI.' });
  } else if (p.zustand === 'aelter') {
    const g = gefundenVon(self, p.id);
    const lauf = g ? vorgangFuer(self, { pfad: g.pfad }) : null;
    zusatz.push({
      satz: `${name} hat eine ältere Version.`,
      knopf: g && !(lauf && lauf.laeuft) ? erneuernKnopf(self, { ...g, name: p.name || g.name }, `pfad:${g.pfad}`) : null,
    });
  } else if (p.zustand === 'neuer') {
    zusatz.push({ satz: `${name} hat eine neuere Version.` });
  }

  let knoepfe = [];
  let unten = null;
  if (self.entkoppeln === p.id && !(v && v.laeuft)) {
    // Die Rückfrage steht in der Seite, ohne Fenster des Browsers (1.7 Punkt 9).
    unten = h('div.stickv__rueckfrage', { role: 'group', 'aria-label': 'Entkoppeln?' },
      h('p', null, text('Entkoppeln? Beide behalten, was sie wissen.')),
      h('div.stickv__antworten', null,
        knopf(self, {
          beschriftung: 'Entkoppeln', art: 'danger', schluessel: `${schluessel}:ja`, onClick: () => entkoppeln(self, p),
        }),
        knopf(self, {
          beschriftung: 'Abbrechen', art: 'ghost', schluessel: `${schluessel}:abbrechen`, onClick: () => entkoppelnAbbrechen(self, p.id),
        })));
  } else if (!(v && v.laeuft)) {
    if (p.steckt) {
      knoepfe.push(knopf(self, {
        beschriftung: 'Jetzt abgleichen',
        symbol: self.icons.refresh || '',
        schluessel: `${schluessel}:abgleichen`,
        disabled: gleicht,
        onClick: () => abgleichen(self),
      }));
    }
    knoepfe.push(knopf(self, {
      beschriftung: 'Entkoppeln',
      art: 'ghost',
      schluessel: `${schluessel}:entkoppeln`,
      onClick: () => entkoppelnFragen(self, p.id),
    }));
  }
  // Was an seinem Stick gerade passiert oder eben passiert ist: [Lena
  // erneuern], [Für Mac holen] -- oder er wurde eben als [Mit dieser KI
  // gekoppelt] vorbereitet, dann bleibt „Fertig. Stick kann raus.“ stehen.
  if (!unten && !v) {
    const g = gefundenVon(self, p.id);
    const amStick = (g && self.vorgaenge.get(`pfad:${g.pfad}`)) || vorgangFuer(self, { id: p.id });
    if (amStick) {
      const pfad = g ? g.pfad : ((amStick.ergebnis && amStick.ergebnis.root) || '');
      unten = vorgangBlock(self, `pfad:${pfad}`, amStick);
    }
  }
  return reihe(self, {
    art: 'partner', schluessel, satz, zusatz, knoepfe, unten, vorgang: v, data: { id: p.id, zustand: p.zustand || '' },
  });
}

/** „„Einkaufsliste“ gab es zweimal verschieden – beide sind da.“ [Ansehen] (1.7 Punkt 8) */
function fassungReihe(self, f) {
  const ziel = zielVon(f.kopieId);
  const schluessel = `fassung:${f.kopieId}`;
  return reihe(self, {
    art: 'fassung',
    schluessel,
    satz: `„${f.titel || 'Ohne Titel'}“ gab es zweimal verschieden – beide sind da.`,
    knoepfe: ziel ? [knopf(self, {
      beschriftung: 'Ansehen',
      schluessel: `${schluessel}:ansehen`,
      onClick: () => {
        alsGesehen(f.kopieId);
        self.ctx.navigate(ziel);
      },
    })] : [],
    data: { id: f.kopieId },
  });
}

/* ------------------------------------------------------- Sichern */

function sichernKarte(self) {
  const details = h('details.stickv__wieder', {
    onToggle: async (e) => {
      self.offen = e.target.open;
      if (self.offen && !self.liste) {
        renderWieder(self);
        await ladeListe(self);
      }
      renderWieder(self);
    },
  },
  h('summary.stickv__wieder-titel', null, text('Von einer Sicherung wiederherstellen')),
  self.wiederSlot);
  if (self.offen) details.open = true;

  return h('section.card.stickv__karte', { 'aria-label': 'Sicherung', dataset: { karte: 'sicherung' } },
    h('h2.stickv__titel', null, text('Sicherung')),
    self.sichernSlot,
    details);
}

function renderSichern(self) {
  if (!self.alive || !self.sichernSlot) return;
  clear(self.sichernSlot);
  const s = self.sicherung;
  let satz = '';
  if (s && s.fehler) satz = s.fehler;
  else if (s && s.letzte && s.letzte.at) {
    satz = `Zuletzt gesichert ${timeAgo(s.letzte.at)} · ${s.letzte.art === 'stick' ? 'auf dem Stick' : 'im Sicherungsordner'}`;
  } else if (s) satz = 'Noch keine Sicherung.';

  self.sichernSlot.appendChild(h('div.stickv__zeile', null,
    h('button.btn.btn--accent.stickv__sichern-knopf', {
      type: 'button',
      disabled: self.sichernLaeuft,
      onClick: () => sichern(self),
    }, self.sichernLaeuft ? h('span.spinner', { 'aria-hidden': 'true' }) : icon(EIGENE_ICONS.download),
    text(self.sichernLaeuft ? 'Wird gesichert …' : 'Jetzt sichern')),
    h('span.stickv__still', { title: s && s.letzte ? `${formatDateTime(s.letzte.at)} · ${s.letzte.dir}` : '' }, text(satz))));

  if (self.sichernFehler) {
    self.sichernSlot.appendChild(meldung(self, fehlerText(self.sichernFehler)));
  } else if (self.gesichert) {
    const g = self.gesichert;
    self.sichernSlot.appendChild(h('p.stickv__still.stickv__pfad', { role: 'status' },
      text(`${formatNumber(g.records || 0)} Einträge · ${formatBytes(g.bytes || 0)} · ${g.dir}`)));
  }
}

function renderWieder(self) {
  if (!self.alive || !self.wiederSlot) return;
  clear(self.wiederSlot);
  if (!self.offen) return;

  const items = (self.liste && self.liste.items) || [];
  const quelleFeld = h('input.input', {
    type: 'text',
    value: self.quelle,
    spellcheck: 'false',
    placeholder: 'Ordner der Sicherung',
    'aria-label': 'Ordner oder Datei der Sicherung',
    onInput: (e) => {
      self.quelle = e.target.value;
      knoepfeNachziehen(self);
    },
  });

  const modusFeld = h('select.select', {
    'aria-label': 'Wie wiederherstellen',
    onChange: (e) => {
      self.modus = e.target.value;
      self.vorschau = null;
      self.ergebnis = null;
      renderWieder(self);
    },
  }, MODI.map((m) => h('option', { value: m.value }, text(m.label))));
  modusFeld.value = self.modus;

  const passFeld = h('input.input', {
    type: 'password',
    value: self.pass,
    autocomplete: 'off',
    placeholder: 'Passphrase, falls verschlüsselt',
    'aria-label': 'Passphrase der Sicherung',
    onInput: (e) => { self.pass = e.target.value; },
  });

  self.ansehenKnopf = h('button.btn', {
    type: 'button',
    disabled: self.vorschauLaeuft || !String(self.quelle || '').trim(),
    onClick: () => ansehen(self),
  }, text(self.vorschauLaeuft ? 'Wird gelesen …' : 'Erst ansehen'));

  self.zurueckKnopf = h('button.btn.btn--primary', {
    type: 'button',
    // Ohne gesehene Vorschau gibt es den Knopf nicht: nichts wird
    // geschrieben, bevor dasteht, was geschrieben wird.
    disabled: !vorschauGilt(self) || self.importLaeuft,
    onClick: () => wiederherstellen(self),
  }, icon(EIGENE_ICONS.upload), text(self.importLaeuft ? 'Läuft …' : 'Wiederherstellen'));

  self.wiederSlot.append(
    items.length
      ? h('div.stickv__liste', { role: 'list' }, items.slice(0, 6).map((item) => h('button.stickv__eintrag', {
        type: 'button',
        role: 'listitem',
        class: String(self.quelle || '').trim() === item.dir ? 'is-active' : '',
        onClick: () => {
          self.quelle = item.dir;
          self.vorschau = null;
          self.vorschauFehler = null;
          self.ergebnis = null;
          renderWieder(self);
          ansehen(self);
        },
      },
      h('span', null, text(item.at ? formatDateTime(item.at) : item.name)),
      h('span.stickv__still', null, text([
        item.records === null || item.records === undefined ? null : `${formatNumber(item.records)} Einträge`,
        ortName(self, item),
        item.sealed ? 'verschlüsselt' : null,
      ].filter(Boolean).join(' · '))))))
      : h('p.stickv__still', null, text(self.liste ? 'Hier liegt keine Sicherung.' : 'Suche Sicherungen …')),
    h('div.stickv__formular', null, quelleFeld, modusFeld, passFeld),
    h('div.stickv__zeile', null, self.ansehenKnopf, self.zurueckKnopf),
    vorschauBlock(self) || '',
    ergebnisBlock(self) || '');
}

/** Wo eine Sicherung liegt, in den Worten dieser Ansicht statt in denen der Liste. */
function ortName(self, item) {
  const ziel = self.sicherung && self.sicherung.ziel;
  if (item.ort === 'Auf dem Stick') return 'auf dem Stick';
  if (item.ort === 'Gewähltes Ziel') return ziel && ziel.art === 'stick' ? 'auf dem Stick' : 'im Sicherungsordner';
  if (item.ort === 'Im Programmverzeichnis') return 'im Sicherungsordner';
  return item.ort || null;
}

/**
 * Beim Tippen NUR die Knöpfe nachziehen, kein volles Neuzeichnen: das würde
 * das Feld bei jedem Zeichen austauschen und den Cursor verlieren.
 */
function knoepfeNachziehen(self) {
  if (self.ansehenKnopf) self.ansehenKnopf.disabled = self.vorschauLaeuft || !String(self.quelle || '').trim();
  if (self.zurueckKnopf) self.zurueckKnopf.disabled = !vorschauGilt(self) || self.importLaeuft;
  const slot = self.wiederSlot && self.wiederSlot.querySelector('.stickv__vorschau');
  if (slot) slot.hidden = !vorschauGilt(self);
}

function vorschauBlock(self) {
  if (self.vorschauFehler) return meldung(self, fehlerText(self.vorschauFehler));
  if (!vorschauGilt(self)) return null;
  const v = self.vorschau;
  const verschwindet = Array.isArray(v.verschwindet) ? v.verschwindet : [];
  return h('div.stickv__vorschau', { role: 'status' },
    h('p', null, h('strong', null, text('Das würde passieren – geschrieben ist noch nichts.'))),
    h('p', null, text(`${formatNumber(v.sicherung.records)} Einträge kommen`
      + (v.at ? ` (Stand ${formatDateTime(v.at)})` : '')
      + `, hier liegen jetzt ${formatNumber(v.hier.records)}.`)),
    verschwindet.length
      ? h('p.stickv__hinweis', null, text(`Es verschwindet: ${verschwindet.join('; ')}.`))
      : null,
    h('p.stickv__still', null, text('Zugangstoken und Netzmodus kommen nicht mit.')));
}

function ergebnisBlock(self) {
  if (self.ergebnisFehler) return meldung(self, `Nicht wiederhergestellt: ${fehlerText(self.ergebnisFehler)}`);
  const r = self.ergebnis;
  if (!r) return null;
  const warnungen = Array.isArray(r.warnings) ? r.warnings : [];
  return h('div.stickv__fertig', { role: 'status' },
    h('p.stickv__fertig-titel', null,
      h('span.stickv__haken', null, icon(self.icons.checkCircle || self.icons.check || '')),
      text(`${formatNumber(r.imported || 0)} Einträge wiederhergestellt.`)),
    ...warnungen.slice(0, 3).map((w) => h('p.stickv__hinweis', null, text(w))));
}

/* ------------------------------------------------------------------ */
/* Gestalt                                                             */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = STIL; // hier geschrieben, niemals Nutzerdaten
  document.head.appendChild(node);
}

const STIL = `
.stickv {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.stickv p { margin: 0; }

.stickv__karte {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-radius: var(--r-4);
  box-shadow: none;
}
.stickv__karte[hidden] { display: none; }
.stickv__titel {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 500;
  color: var(--fg);
}
.stickv__kopf {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.stickv__inhalt { display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__inhalt:empty { display: none; }

.stickv__reihe {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: 12px var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
}
.stickv__reihe.is-warn { border-color: var(--warn); }
.stickv__satz { font-size: var(--fs-base); line-height: var(--lh); overflow-wrap: anywhere; }
.stickv__zusatz {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-2);
}
.stickv__zusatz .stickv__meldung { flex: 1 1 18rem; }
.stickv__knoepfe {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--sp-1);
}
.stickv__knoepfe .btn, .stickv__zusatz .btn, .stickv__antworten .btn { min-height: var(--tap-min); }
.stickv__gruppe {
  display: inline-flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.stickv__pinfeld { display: inline-flex; flex-direction: column; gap: 2px; }
.stickv__pinfeld-name { font-size: var(--fs-xs); color: var(--fg-muted); }
.stickv__pin {
  width: 10ch;
  min-height: var(--tap-min);
  font-family: var(--font-mono);
  letter-spacing: 0.2em;
  -webkit-text-security: disc;
}

.stickv__label {
  font-size: var(--fs-md);
  color: var(--fg);
}

.stickv__feldzeile {
  display: flex;
  gap: var(--sp-1);
  align-items: stretch;
}
.stickv__feld {
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--tap-min);
  font-size: var(--fs-md);
  font-family: var(--font-mono);
  border-radius: var(--r-3);
}
.stickv__feldzeile .btn { min-height: var(--tap-min); }

.stickv__hand { border-top: 1px solid var(--border); padding-top: var(--sp-2); }
.stickv__hand-titel,
.stickv__wieder-titel {
  cursor: pointer;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  min-height: 28px;
  display: flex;
  align-items: center;
}
.stickv__hand-titel:hover,
.stickv__wieder-titel:hover { color: var(--fg); }
.stickv__hand-inhalt {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
}

.stickv__still {
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  line-height: var(--lh);
  overflow-wrap: anywhere;
}
.stickv__hinweis {
  color: var(--warn);
  font-size: var(--fs-sm);
  line-height: var(--lh);
}
.stickv__arbeitet { display: flex; align-items: center; gap: var(--sp-1); }

.stickv__lauf { display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__bar {
  height: 8px;
  background: var(--surface-3);
  border-radius: var(--r-full);
  overflow: hidden;
}
.stickv__bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: var(--r-full);
  transition: width var(--dur-3) var(--ease);
}
.stickv__lauf-zeile { display: flex; align-items: center; gap: var(--sp-1); }
.stickv__lauf-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--fg);
  font-size: var(--fs-sm);
}
.stickv__lauf-detail {
  color: var(--fg-muted);
  font-size: var(--fs-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stickv__lauf-detail:empty { display: none; }

.stickv__frage,
.stickv__rueckfrage {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  background: var(--surface-3);
  border-radius: var(--r-3);
}
.stickv__frage-text { line-height: var(--lh); }
.stickv__antworten { display: flex; flex-wrap: wrap; gap: var(--sp-1); }

.stickv__fertig { display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__fertig-titel {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-md);
  font-weight: 500;
}
.stickv__haken { display: inline-flex; color: var(--accent-text); }

.stickv__meldung {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  padding: 12px var(--sp-2);
  border-radius: var(--r-3);
  background: var(--danger-soft);
  color: var(--fg);
  font-size: var(--fs-sm);
  line-height: var(--lh);
  word-break: break-word;
}
.stickv__meldung svg { flex: none; color: var(--danger); margin-top: 1px; }

.stickv__zeile {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-2);
}
.stickv__sichern { display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__sichern-knopf { min-height: var(--tap-min); }
.stickv__pfad { word-break: break-all; }

.stickv__wieder { border-top: 1px solid var(--border); padding-top: var(--sp-2); }
.stickv__wieder-inhalt {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
}
.stickv__wieder-inhalt:empty { display: none; }
.stickv__liste { display: flex; flex-direction: column; gap: var(--sp-05); }
.stickv__eintrag {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1);
  min-height: 40px;
  padding: var(--sp-1) 12px;
  background: none;
  color: var(--fg);
  font: inherit;
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  cursor: pointer;
  text-align: left;
}
.stickv__eintrag:hover { background: var(--surface-3); }
.stickv__eintrag.is-active { border-color: var(--accent); }
.stickv__formular {
  display: grid;
  grid-template-columns: 2fr 1.4fr 1.2fr;
  gap: var(--sp-1);
}
.stickv__vorschau {
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  padding: 12px var(--sp-2);
  background: var(--surface-3);
  border-radius: var(--r-3);
  font-size: var(--fs-sm);
  line-height: var(--lh);
}

/* Mit dem Finger (iPad) ist auch die kleine Zeile ein ganzes Tippziel. */
@media (pointer: coarse) {
  .stickv__wieder-titel, .stickv__hand-titel { min-height: var(--tap-min); }
}

@media (max-width: 720px) {
  .stickv__formular { grid-template-columns: 1fr; }
  .stickv__karte { padding: var(--sp-2); }
}
`;
