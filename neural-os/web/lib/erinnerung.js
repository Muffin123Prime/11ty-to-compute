/**
 * erinnerung.js -- ruhige Erinnerungen an Termine, solange Neural OS offen ist.
 *
 * Ein Termin mit `reminder` (Minuten vorher) meldet sich zur Zeit
 * "Beginn minus reminder" oben rechts: "In 15 Min · Zahnarzt · Bibliothek",
 * mit Schliessen. Wer moechte, schaltet im Termin einmal "Auch als Mitteilung"
 * ein -- dann zeigt auch das Betriebssystem eine Mitteilung.
 *
 * Ehrlich, weil es sonst niemand merkt, bis es zu spaet ist: Das hier ist
 * Code im Browserfenster. Ist Neural OS zu, erinnert NICHTS. Es gibt keinen
 * Dienst im Hintergrund und keinen Server, der Mitteilungen schickt. Genau
 * dieser eine Satz steht deshalb neben der Erinnerung im Termin.
 *
 * Warum der Browser nur nach einem Klick um Erlaubnis gefragt wird: eine
 * Erlaubnisfrage, die beim Laden aufspringt, klickt jeder weg -- und Safari
 * verweigert sie ohne Klick ohnehin.
 *
 * Eingehaengt wird das Modul mit genau einer Zeile in web/app.js; die reinen
 * Funktionen (faellige, hinweisText, erinnerungInWorten) werden in
 * test/kalender-ansicht.test.js ohne Browser geprueft.
 */

import { h, text, icon } from './dom.js';

const STYLE_ID = 'nos-erinnerung';
/**
 * Gemerkt wird, was der Nutzer WEGGEKLICKT hat -- nicht, was gezeigt wurde.
 * Laedt das Fenster neu (etwa wenn der Service Worker uebernimmt), steht eine
 * faellige Erinnerung also wieder da, statt still verloren zu gehen. Eine
 * Mitteilung des Betriebssystems kommt dagegen nur einmal.
 */
const ERLEDIGT_KEY = 'neural-os:erinnerungen-erledigt';
const MITGETEILT_KEY = 'neural-os:erinnerungen-mitgeteilt';
const MITTEILUNG_KEY = 'neural-os:erinnerung-mitteilung';

/** Die Stufen, die das Formular anbietet (Vertrag A). null = keine. */
export const ERINNERUNG_OPTIONEN = [null, 0, 5, 10, 15, 30, 60, 120, 1440];

/** Ein ganztaegiger Termin erinnert, als begaenne er um neun -- nicht um Mitternacht. */
const GANZTAGS_STUNDE = 9;
/** So lange nach Beginn steht ein Hinweis noch; wer spaeter oeffnet, braucht ihn nicht mehr. */
const NACHLAUF_MS = 10 * 60000;

const pad = (n) => String(n).padStart(2, '0');

/** "15 Min vorher", "1 Std vorher", "1 Tag vorher", "Zum Beginn", "Keine". */
export function erinnerungInWorten(min) {
  if (min === null || min === undefined || min === '') return 'Keine';
  const n = Number(min);
  if (!Number.isFinite(n)) return 'Keine';
  if (n === 0) return 'Zum Beginn';
  if (n % 1440 === 0) return `${n / 1440} ${n === 1440 ? 'Tag' : 'Tage'} vorher`;
  if (n % 60 === 0) return `${n / 60} Std vorher`;
  return `${n} Min vorher`;
}

/** Beginn eines Termins als Zeitpunkt in Ortszeit (ganztaegig: 09:00). */
export function beginnMs(start) {
  const s = String(start || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], GANZTAGS_STUNDE, 0).getTime();
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Wann die Erinnerung kommt -- in WANDZEIT gerechnet: "1 Tag vorher" heisst
 * am Vortag zur selben Uhrzeit, auch wenn dazwischen die Uhr umgestellt
 * wurde (25.10.: ein Tag hat dann 25 Stunden). So liest auch die
 * Kalenderdatei es (TRIGGER:-P1D ist nach RFC 5545 3.3.6 ein Kalendertag,
 * keine 24 Stunden), und so zeigt es das iPad nach dem Import. Minuten und
 * Stunden sind dagegen genaue Dauern, auf beiden Seiten.
 *
 * Ganztaegig: neun Uhr Wandzeit, am Tag selbst bzw. n Tage davor.
 */
export function ausloeseMs(start, reminder) {
  const min = Number(reminder);
  if (!Number.isFinite(min)) return null;
  const s = String(start || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s);
  if (!m) {
    // Ein fester Zeitpunkt mit Zone: dort gibt es keine Wandzeit zu wahren.
    const b = beginnMs(s);
    return b === null ? null : b - min * 60000;
  }
  const tage = Math.floor(min / 1440);
  const rest = min - tage * 1440;
  const stunde = m[4] !== undefined ? +m[4] : GANZTAGS_STUNDE;
  const minute = m[5] !== undefined ? +m[5] : 0;
  return new Date(+m[1], +m[2] - 1, +m[3] - tage, stunde, minute).getTime() - rest * 60000;
}

/** Die Felder eines Elements aus /api/events/zeitraum -- Satz oder Vorkommen. */
function felder(item) {
  const data = item && item.data && typeof item.data === 'object' ? item.data : (item || {});
  return {
    id: item && item.id,
    occurrence: (item && item.occurrence) || data.occurrence || null,
    title: data.title || 'Termin',
    location: data.location || '',
    start: data.start,
    reminder: data.reminder,
  };
}

/**
 * Welche Erinnerungen jetzt dran sind.
 *
 * @param {object[]} items   Elemente aus /api/events/zeitraum
 * @param {number} jetzt     Zeitpunkt in ms
 * @param {Set<string>|{has:Function}} erledigt  weggeklickte Schluessel
 * @returns {{key:string, id:string, occurrence:string|null, titel:string, ort:string, startMs:number, fireMs:number}[]}
 */
export function faellige(items, jetzt, erledigt = new Set()) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const f = felder(item);
    if (f.reminder === null || f.reminder === undefined || !Number.isFinite(Number(f.reminder))) continue;
    const startMs = beginnMs(f.start);
    if (startMs === null) continue;
    const fireMs = ausloeseMs(f.start, f.reminder);
    if (fireMs === null) continue;
    if (jetzt < fireMs || jetzt > startMs + NACHLAUF_MS) continue;
    // Start und Vorlauf im Schluessel: wer den Termin verschiebt, wird neu erinnert.
    const key = `${f.id}|${f.occurrence || ''}|${f.start}|${f.reminder}`;
    if (erledigt.has(key)) continue;
    out.push({ key, id: f.id, occurrence: f.occurrence, titel: f.title, ort: f.location, startMs, fireMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** "In 15 Min · Zahnarzt · Bibliothek" -- "Jetzt · …", "Seit 3 Min · …", "Morgen 09:00 · …". */
export function hinweisText(e, jetzt) {
  return [wannText(e.startMs, jetzt), e.titel, e.ort].filter(Boolean).join(' · ');
}

export function wannText(startMs, jetzt) {
  const diff = Math.round((startMs - jetzt) / 60000);
  if (diff > 0 && diff < 60) return `In ${diff} Min`;
  if (diff >= 60 && diff < 180 && diff % 60 === 0) return `In ${diff / 60} Std`;
  if (diff >= 60) {
    const d = new Date(startMs);
    const heute = new Date(jetzt);
    const gleicherTag = d.toDateString() === heute.toDateString();
    return `${gleicherTag ? 'Heute' : 'Morgen'} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (diff === 0) return 'Jetzt';
  return `Seit ${-diff} Min`;
}

/* ------------------------------------------------------------------ */
/* Mitteilungen des Betriebssystems                                    */
/* ------------------------------------------------------------------ */

function lies(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function schreib(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* privat surfen: dann eben nicht gemerkt */ }
}

/** Kann dieser Browser Mitteilungen ueberhaupt? */
export function mitteilungMoeglich() {
  return typeof window !== 'undefined' && typeof window.Notification === 'function';
}

/** Ist "Auch als Mitteilung" eingeschaltet UND erlaubt? */
export function mitteilungAn() {
  return mitteilungMoeglich() && lies(MITTEILUNG_KEY) === '1' && window.Notification.permission === 'granted';
}

/**
 * Ein- oder ausschalten. Die Erlaubnis wird nur hier gefragt -- also nur nach
 * einem Klick.
 * @returns {Promise<{an:boolean, grund:string|null}>}
 */
export async function mitteilungSchalten(an) {
  if (!an) {
    schreib(MITTEILUNG_KEY, null);
    return { an: false, grund: null };
  }
  if (!mitteilungMoeglich()) return { an: false, grund: 'Dieser Browser kann keine Mitteilungen zeigen.' };
  let erlaubnis = window.Notification.permission;
  if (erlaubnis === 'default') {
    try {
      erlaubnis = await window.Notification.requestPermission();
    } catch {
      erlaubnis = 'denied';
    }
  }
  if (erlaubnis !== 'granted') {
    return { an: false, grund: 'Mitteilungen sind im Browser nicht erlaubt. Ändern lässt sich das in den Website-Einstellungen.' };
  }
  schreib(MITTEILUNG_KEY, '1');
  return { an: true, grund: null };
}

/* ------------------------------------------------------------------ */
/* Der Hinweis oben rechts                                              */
/* ------------------------------------------------------------------ */

const CSS = `
.erin {
  position: fixed;
  top: calc(var(--sp-2) + env(safe-area-inset-top, 0px));
  right: var(--sp-3);
  z-index: 110;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  width: min(360px, calc(100vw - var(--sp-4)));
  pointer-events: none;
}
.erin__card {
  display: grid;
  grid-template-columns: 3px minmax(0, 1fr) auto;
  align-items: stretch;
  gap: 12px;
  padding: 10px 6px 10px 12px;
  color: var(--fg);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-3);
  box-shadow: var(--shadow-2);
  pointer-events: auto;
  animation: erin-in var(--dur-3) var(--ease);
}
@keyframes erin-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.erin__bar { border-radius: var(--r-full); background: var(--accent); }
.erin__text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  padding: 0;
  font: inherit;
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}
.erin__wann { font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.02em; color: var(--accent-text); font-variant-numeric: tabular-nums; }
.erin__titel { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-base); color: var(--fg); }
.erin__ort { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg-subtle); }
.erin__text:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); border-radius: var(--r-1); }
.erin__close { align-self: center; }
@media (pointer: coarse) {
  .erin__text { min-height: var(--tap-min); }
}
@media (prefers-reduced-motion: reduce) {
  .erin__card { animation: none; }
}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const GLYPH_CLOSE = '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>';

/** Schluessel -> Zeitpunkt, die letzten drei Tage; aelteres braucht niemand mehr. */
function mengeLaden(key) {
  const map = new Map();
  try {
    const roh = JSON.parse(lies(key) || '[]');
    const grenze = Date.now() - 3 * 86400000;
    for (const [k, t] of Array.isArray(roh) ? roh : []) if (typeof k === 'string' && t > grenze) map.set(k, t);
  } catch { /* kaputt oder leer: dann eben nichts */ }
  return map;
}

function mengeSpeichern(key, map) {
  schreib(key, JSON.stringify([...map.entries()].slice(-200)));
}

const heuteTag = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function plusTag(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return heuteTag(new Date(y, m - 1, d + n));
}

/**
 * Einhaengen. Einmal pro Anwendung (web/app.js).
 *
 * @param {{api:object, bus?:{on:Function}, navigate?:Function}} ctx
 * @returns {{stop:Function, zeige:Function, pruefe:Function}}
 */
export function starteErinnerungen({ api, bus, navigate } = {}) {
  if (typeof document === 'undefined' || !api) return { stop() {}, zeige() {}, pruefe() {} };
  ensureStyle();
  const erledigt = mengeLaden(ERLEDIGT_KEY);
  const mitgeteilt = mengeLaden(MITGETEILT_KEY);
  const offen = new Map(); // key -> {eintrag, node}
  let items = [];
  let ladeZeit = 0;
  let laeuft = null;
  let alive = true;

  const box = h('div.erin', { role: 'status', 'aria-live': 'polite', 'aria-label': 'Erinnerungen' });
  document.body.appendChild(box);

  async function laden() {
    if (laeuft) return laeuft;
    const heute = heuteTag();
    // Gestern bis uebermorgen: "1 Tag vorher" braucht die Termine von morgen,
    // und ein Termin von gestern 23:55 kann heute noch nachlaufen.
    laeuft = api.get('/events/zeitraum', { query: { from: plusTag(heute, -1), to: plusTag(heute, 2) } })
      .then((res) => {
        items = Array.isArray(res && res.items) ? res.items : [];
        ladeZeit = Date.now();
      })
      .catch(() => { /* kein Server, gesperrter Tresor: beim naechsten Mal */ })
      .finally(() => { laeuft = null; });
    return laeuft;
  }

  function schliessen(key, { vomNutzer = true } = {}) {
    const eintrag = offen.get(key);
    if (!eintrag) return;
    offen.delete(key);
    eintrag.node.remove();
    if (vomNutzer) {
      erledigt.set(key, Date.now());
      mengeSpeichern(ERLEDIGT_KEY, erledigt);
    }
  }

  function zeige(e) {
    if (offen.has(e.key)) return;
    const wann = h('span.erin__wann');
    const knopf = h('button.erin__text', {
      type: 'button',
      onClick: () => {
        schliessen(e.key);
        const ziel = `#/kalender?id=${encodeURIComponent(e.id)}${e.occurrence ? `&am=${e.occurrence}` : ''}`;
        if (typeof navigate === 'function') navigate(ziel);
        else window.location.hash = ziel;
      },
    },
    wann,
    h('span.erin__titel', null, text(e.titel)),
    e.ort ? h('span.erin__ort', null, text(e.ort)) : null);
    const card = h('div.erin__card', null,
      h('span.erin__bar', { 'aria-hidden': 'true' }),
      knopf,
      h('button.icon-button.erin__close', {
        type: 'button',
        'aria-label': 'Erinnerung schließen',
        title: 'Schließen',
        onClick: () => schliessen(e.key),
      }, icon(GLYPH_CLOSE)));
    box.appendChild(card);
    offen.set(e.key, { eintrag: e, node: card, wann });
    beschriften();

    if (mitteilungAn() && !mitgeteilt.has(e.key)) {
      mitgeteilt.set(e.key, Date.now());
      mengeSpeichern(MITGETEILT_KEY, mitgeteilt);
      try {
        // eslint-disable-next-line no-new
        new window.Notification(e.titel, { body: [wannText(e.startMs, Date.now()), e.ort].filter(Boolean).join(' · '), tag: e.key });
      } catch { /* manche Browser erlauben Mitteilungen nur ueber einen Service Worker */ }
    }
  }

  function beschriften() {
    const jetzt = Date.now();
    for (const [key, { eintrag, wann }] of offen) {
      if (jetzt > eintrag.startMs + NACHLAUF_MS + 5 * 60000) {
        schliessen(key, { vomNutzer: false });
        continue;
      }
      const neu = wannText(eintrag.startMs, jetzt);
      if (wann.textContent !== neu) {
        while (wann.firstChild) wann.removeChild(wann.firstChild);
        wann.appendChild(text(neu));
      }
    }
  }

  function pruefe() {
    if (!alive) return;
    const jetzt = Date.now();
    for (const e of faellige(items, jetzt, erledigt)) zeige(e);
    beschriften();
  }

  const offs = [];
  let bald = null;
  const neuLaden = () => {
    clearTimeout(bald);
    bald = setTimeout(() => laden().then(pruefe), 400);
  };
  if (bus && typeof bus.on === 'function') {
    const istTermin = (p) => p && (p.type === 'event' || (p.record && p.record.type === 'event'));
    for (const name of ['record.created', 'record.updated', 'record.deleted']) {
      offs.push(bus.on(name, (p) => { if (istTermin(p)) neuLaden(); }));
    }
    offs.push(bus.on('hello', neuLaden));
  }
  // Alle 20 Sekunden nachsehen kostet nichts (nur lokale Rechnung); neu
  // geladen wird alle fuenf Minuten und bei jeder Aenderung an einem Termin.
  const takt = setInterval(() => {
    if (Date.now() - ladeZeit > 5 * 60000) laden().then(pruefe);
    else pruefe();
  }, 20000);
  laden().then(pruefe);

  return {
    stop() {
      alive = false;
      clearInterval(takt);
      clearTimeout(bald);
      for (const off of offs) { try { off(); } catch { /* weiter */ } }
      box.remove();
    },
    zeige,
    pruefe,
  };
}

export default { starteErinnerungen };
