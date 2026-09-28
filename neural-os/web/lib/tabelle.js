/**
 * tabelle.js -- Tabellen im Chat, mit denen man arbeiten kann.
 *
 * Der Markdown-Renderer (web/lib/markdown.js) baut eine Tabelle als
 * `div.md-table-wrap > table.md-table`. Dieses Modul macht daraus eine
 * Tabelle, die sich wie in einer guten Tabellen-App verhaelt
 * (docs/ANTWORT-BAUSTEINE.md, Abschnitt 2, "Vergleiche sind normale
 * Markdown-Tabellen"):
 *
 * - Sortieren per Klick auf den Kopf: aufsteigend, absteigend, wieder wie
 *   geschrieben. Zahlen werden als Zahlen sortiert ("1.234,5 €" vor
 *   "12.000 €"), Datumsangaben als Datum ("28.09.2026", "Sep 2026",
 *   "Q3 2026"), Text nach deutschem Alphabet (Umlaute richtig, "Punkt 2"
 *   vor "Punkt 10"). Leere Zellen stehen immer unten.
 * - Ab 7 Zeilen ein Filterfeld (Gross/Klein und Umlaute egal, mehrere Woerter
 *   muessen alle vorkommen), mit "3 von 12".
 * - Waagrecht rollbar; ist die Tabelle hoeher als ein Bildschirm, rollt sie
 *   in sich und die Kopfzeile bleibt stehen. Ist sie breiter als der Platz
 *   (Telefon), bleibt die erste Spalte stehen.
 * - Tastatur: Kopf-Knoepfe sind echte Knoepfe (aria-sort am Kopf), das
 *   Filterfeld leert sich mit Esc, eine rollbare Tabelle ist fokussierbar.
 *
 * Warum der Zustand (Sortierung, Filter) ausserhalb des DOM liegt: Der Chat
 * baut eine Nachricht bei jeder Aenderung ihrer Signatur ganz neu (beim
 * Streaming in jedem Bild). Mit einem `schluessel` (z. B. die Nachrichten-id)
 * findet die neu gebaute Tabelle ihre Sortierung wieder.
 *
 * Die reinen Lese-Helfer (zahlLesen, datumLesen, spaltenArt, …) stehen hier,
 * weil sie zuerst Tabellen-Arbeit sind; web/lib/diagramm.js benutzt sie mit.
 * Nichts hier fasst beim Laden `document` an (test/diagramm.test.js laedt das
 * Modul in Node).
 */

import { h, text, icon } from './dom.js';

/** Ab so vielen Zeilen gibt es ein Filterfeld. */
export const FILTER_AB = 7;
/** Ab so vielen Zeilen rollt die Tabelle in sich (Kopfzeile bleibt stehen). */
export const HOCH_AB = 12;

/* ------------------------------------------------------------------ */
/* Werte lesen (rein)                                                  */
/* ------------------------------------------------------------------ */

const RAUM = /[     ]/g;

/** Zellen, die "kein Wert" bedeuten -- sie sortieren immer ans Ende. */
const LEERWERTE = new Set(['', '-', '–', '—', '−', '/', '?', 'k.a.', 'k. a.', 'n/a', 'n.a.', 'na', 'keine angabe', 'null']);

/** Ist das eine leere Zelle ("", "–", "k. A.", "n/a")? */
export function istLeer(wert) {
  return LEERWERTE.has(String(wert ?? '').replace(RAUM, ' ').trim().toLowerCase());
}

/* Die Groessenwoerter hinter einer Zahl: "3,5 Mio.", "12 Tsd.", "12k". */
const FAKTOREN = [
  [/^(?:mrd\.?|milliarden?|bn\.?)$/i, 1e9],
  [/^(?:mio\.?|millionen?|mn\.?)$/i, 1e6],
  [/^(?:tsd\.?|tausend|k)$/i, 1e3],
];
const VORZEICHEN = /^([+\-−‒–])\s*/;
const WAEHRUNG_VORN = /^(?:€|\$|£|¥|chf|eur|usd|gbp)\s*/i;
const UNGEFAEHR = /^(?:ca\.|circa|etwa|rund|ungefähr|~|≈|>=?|<=?|≥|≤)\s*/i;

/**
 * Nur die Ziffern mit Trennzeichen. Deutsch zuerst ("1.234" ist Tausend),
 * englisch nur, wenn es eindeutig ist ("1,234.5", "1,234,567").
 */
function ziffernLesen(z) {
  if (/^[1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?$/.test(z)) return Number(z.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(?:[ '’]\d{3})+(?:[.,]\d+)?$/.test(z)) return Number(z.replace(/[ '’]/g, '').replace(',', '.'));
  if (/^[1-9]\d{0,2}(?:,\d{3}){2,}(?:\.\d+)?$/.test(z) || /^[1-9]\d{0,2}(?:,\d{3})+\.\d+$/.test(z)) return Number(z.replace(/,/g, ''));
  if (/^\d+(?:[.,]\d+)?$/.test(z)) return Number(z.replace(',', '.'));
  if (/^[.,]\d+$/.test(z)) return Number(`0.${z.slice(1)}`);
  return null;
}

/**
 * Eine Zahl so lesen, wie ein Mensch sie in eine deutsche Tabelle schreibt:
 * "1.234,5" → 1234.5 · "12 %" → 12 · "3,5 Mio. €" → 3500000 · "−4,2" → -4.2 ·
 * "ca. 500" → 500 · "12k" → 12000 · "4 km" → 4. Alles andere (Text, Datum,
 * Uhrzeit, "3 Äpfel und 2 Birnen") ist `null` -- lieber keine Zahl als eine
 * falsche.
 * @param {string|number} eingabe
 * @returns {number|null}
 */
export function zahlLesen(eingabe) {
  if (typeof eingabe === 'number') return Number.isFinite(eingabe) ? eingabe : null;
  if (typeof eingabe !== 'string') return null;
  let s = eingabe.replace(RAUM, ' ').trim();
  if (!s || s.length > 60) return null;
  s = s.replace(UNGEFAEHR, '');
  let vz = 1;
  const vorzeichen = (t) => {
    const m = VORZEICHEN.exec(t);
    if (!m) return t;
    if (m[1] !== '+') vz = -vz;
    return t.slice(m[0].length);
  };
  s = vorzeichen(s);
  const w = WAEHRUNG_VORN.exec(s);
  if (w) s = vorzeichen(s.slice(w[0].length));
  const m = /^(\d[\d.,'’ ]*\d|\d|[.,]\d+)/.exec(s);
  if (!m) return null;
  const wert = ziffernLesen(m[1]);
  if (wert === null) return null;
  let rest = s.slice(m[0].length).trim();
  let faktor = 1;
  const wort = /^([A-Za-zÄÖÜäöü]+\.?)/.exec(rest);
  if (wort) {
    for (const [re, f] of FAKTOREN) {
      if (re.test(wort[1])) {
        faktor = f;
        rest = rest.slice(wort[0].length).trim();
        break;
      }
    }
  }
  // Was bleibt, darf eine Einheit sein ("€", "km/h", "°C"), aber keine
  // weitere Zahl: "3 von 5" ist kein Wert, sondern ein Satz.
  if (rest && (/\d/.test(rest) || rest.length > 16)) return null;
  const r = vz * wert * faktor;
  return Number.isFinite(r) ? Number(r.toPrecision(15)) : null;
}

const MONATE = new Map(Object.entries({
  jan: 0, januar: 0, jän: 0, jänner: 0, january: 0,
  feb: 1, febr: 1, februar: 1, february: 1,
  mär: 2, märz: 2, maerz: 2, mrz: 2, mar: 2, march: 2,
  apr: 3, april: 3,
  mai: 4, may: 4,
  jun: 5, juni: 5, june: 5,
  jul: 6, juli: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  okt: 9, oktober: 9, oct: 9, october: 9,
  nov: 10, november: 10,
  dez: 11, dezember: 11, dec: 11, december: 11,
}));

function monatAus(wort) {
  const m = MONATE.get(String(wort || '').toLowerCase().replace(/\.$/, ''));
  return m === undefined ? null : m;
}

function jahrAus(s) {
  const t = String(s).replace(/^'/, '');
  if (t.length === 4) return Number(t);
  const n = Number(t);
  return n < 70 ? 2000 + n : 1900 + n;
}

/* Alle Zeiten sind Wandzeit ohne Zone, als UTC-Millisekunden gespeichert --
   wie im Kalender der App. So verschiebt keine Sommerzeit einen Tick. */
function utc(j, mo, tag = 1, std = 0, min = 0) {
  if (std > 23 || min > 59) return null;
  const ms = Date.UTC(j, mo, tag, std, min);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== j || d.getUTCMonth() !== mo || d.getUTCDate() !== tag) return null; // 31.02.
  return ms;
}

const WOCHENTAG_VORN = /^(?:mo|di|mi|do|fr|sa|so)(?:ntag|nstag|ttwoch|nnerstag|eitag|mstag|nnabend)?\.?,?\s+/i;

/**
 * Ein Datum aus einer Beschriftung lesen. Erkannt werden ISO ("2026-09-28",
 * "2026-09-28T14:30", "2026-09"), deutsch ("28.09.2026", "28.9.26",
 * "28.09.", "3. Sep 2026", "28. Sep 2026, 14:30", "Mo, 28. Sep 2026"),
 * Monate ("Sep 2026", "September 2026", "09/2026"), Quartale ("Q3 2026",
 * "2026 Q3", "3. Quartal 2026") und -- nur mit `jahrAllein` -- Jahre ("2026").
 *
 * @param {string} eingabe
 * @param {{jahr?:number, jahrAllein?:boolean}} [opts] `jahr` ergaenzt ein fehlendes Jahr ("28.09.")
 * @returns {{t:number, genau:'minute'|'tag'|'monat'|'quartal'|'jahr', ohneJahr?:true}|null}
 */
export function datumLesen(eingabe, { jahr = null, jahrAllein = false } = {}) {
  if (typeof eingabe !== 'string' && typeof eingabe !== 'number') return null;
  let s = String(eingabe).replace(RAUM, ' ').trim();
  if (!s || s.length > 40) return null;
  s = s.replace(WOCHENTAG_VORN, '');
  const standardJahr = () => (Number.isInteger(jahr) ? jahr : new Date().getFullYear());
  const aus = (t, genau, ohneJahr = false) => (t === null ? null : (ohneJahr ? { t, genau, ohneJahr: true } : { t, genau }));
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s))) {
    return aus(utc(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0), m[4] ? 'minute' : 'tag');
  }
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) return aus(utc(+m[1], +m[2] - 1, 1), 'monat');
  if ((m = /^(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2}))?(?:,?\s+(\d{1,2})[:.](\d{2})(?:\s?Uhr)?)?$/i.exec(s))) {
    const ohne = !m[3];
    return aus(utc(ohne ? standardJahr() : jahrAus(m[3]), +m[2] - 1, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0), m[4] ? 'minute' : 'tag', ohne);
  }
  if ((m = /^(\d{1,2})\.?\s*([A-Za-zÄäÖöÜü]{3,9})\.?(?:\s+('?\d{2}|\d{4}))?(?:,?\s+(\d{1,2}):(\d{2})(?:\s?Uhr)?)?$/.exec(s))) {
    // "4. Quartal 2025" hat dieselbe Form -- kein Monat, dann weiter unten.
    const mo = monatAus(m[2]);
    const ohne = !m[3];
    if (mo !== null) return aus(utc(ohne ? standardJahr() : jahrAus(m[3]), mo, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0), m[4] ? 'minute' : 'tag', ohne);
  }
  if ((m = /^([A-Za-zÄäÖöÜü]{3,9})\.?\s*('?\d{2}|\d{4})$/.exec(s))) {
    const mo = monatAus(m[1]);
    if (mo !== null) return aus(utc(jahrAus(m[2]), mo, 1), 'monat');
  }
  if ((m = /^(\d{1,2})[/.](\d{4})$/.exec(s))) return aus(utc(+m[2], +m[1] - 1, 1), 'monat');
  if ((m = /^(\d{4})\/(\d{1,2})$/.exec(s))) return aus(utc(+m[1], +m[2] - 1, 1), 'monat');
  if ((m = /^Q([1-4])\s*[/\- ]?\s*('?\d{2}|\d{4})$/i.exec(s))) return aus(utc(jahrAus(m[2]), (+m[1] - 1) * 3, 1), 'quartal');
  if ((m = /^(\d{4})\s*[/\- ]?\s*Q([1-4])$/i.exec(s))) return aus(utc(+m[1], (+m[2] - 1) * 3, 1), 'quartal');
  if ((m = /^([1-4])\.\s*Quartal\s+(\d{4})$/i.exec(s))) return aus(utc(+m[2], (+m[1] - 1) * 3, 1), 'quartal');
  if (jahrAllein && (m = /^(1[5-9]\d{2}|2[0-2]\d{2})$/.exec(s))) return aus(utc(+m[1], 0, 1), 'jahr');
  return null;
}

/**
 * Was steht in einer Spalte? 'zahl', wenn mindestens 80 % der vollen Zellen
 * Zahlen sind, sonst 'datum' nach derselben Regel, sonst 'text'. Die 80 %
 * erlauben einen Ausreisser ("siehe unten") ohne dass die ganze Spalte
 * alphabetisch sortiert.
 * @param {string[]} werte
 */
export function spaltenArt(werte) {
  const voll = (werte || []).map((w) => String(w ?? '').trim()).filter((w) => !istLeer(w));
  if (!voll.length) return 'text';
  const anteil = (fn) => voll.filter(fn).length / voll.length;
  if (anteil((w) => zahlLesen(w) !== null) >= 0.8) return 'zahl';
  if (anteil((w) => datumLesen(w, { jahrAllein: true, jahr: 2000 }) !== null) >= 0.8) return 'datum';
  return 'text';
}

/**
 * Der Sortierschluessel einer Zelle: Zahl, Zeitpunkt oder Text; `null` fuer
 * leer oder unlesbar (steht dann unten).
 */
export function sortSchluessel(wert, art) {
  const s = String(wert ?? '').trim();
  if (istLeer(s)) return null;
  if (art === 'zahl') return zahlLesen(s);
  if (art === 'datum') {
    // Ein festes Jahr fuer "28.09.": sortiert wird dann nach Monat und Tag.
    const d = datumLesen(s, { jahrAllein: true, jahr: 2000 });
    return d ? d.t : null;
  }
  return s;
}

let kollator = null;
function sammler() {
  if (!kollator) {
    try {
      kollator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
    } catch {
      kollator = { compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0) };
    }
  }
  return kollator;
}

/** Zwei Sortierschluessel derselben Art vergleichen. */
export function vergleiche(a, b, art) {
  if (art === 'zahl' || art === 'datum') return a - b;
  return sammler().compare(String(a), String(b));
}

/**
 * Die Reihenfolge der Zeilen nach einer Spalte. Stabil (gleiche Werte
 * behalten ihre Reihenfolge), leere Zellen unten -- auch absteigend.
 * @param {string[][]} zeilen Zelltexte je Zeile
 * @param {number|null} spalte
 * @param {'auf'|'ab'|null} richtung null = wie geschrieben
 * @param {'zahl'|'datum'|'text'} [art] sonst aus der Spalte erkannt
 * @returns {number[]}
 */
export function reihenfolge(zeilen, spalte, richtung, art = null) {
  const idx = (zeilen || []).map((_, i) => i);
  if (!richtung || !Number.isInteger(spalte) || spalte < 0) return idx;
  const a = art || spaltenArt(zeilen.map((z) => z[spalte]));
  const schluessel = zeilen.map((z) => sortSchluessel(z[spalte], a));
  const dir = richtung === 'ab' ? -1 : 1;
  return idx.sort((i, j) => {
    const x = schluessel[i];
    const y = schluessel[j];
    if (x === null && y === null) return i - j;
    if (x === null) return 1;
    if (y === null) return -1;
    return (vergleiche(x, y, a) * dir) || i - j;
  });
}

/** Text fuer den Vergleich beim Filtern: klein, ohne Akzente, ß = ss. */
export function normText(wert, { umlautAe = false } = {}) {
  let s = String(wert ?? '').toLowerCase().replace(/ß/g, 'ss');
  if (umlautAe) s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Passt eine Zeile zum Suchtext? Jedes Wort muss irgendwo in der Zeile
 * stehen. "muller" und "mueller" finden beide "Müller".
 */
export function filterPasst(zellen, suche) {
  const woerter = normText(suche).split(' ').filter(Boolean);
  if (!woerter.length) return true;
  const roh = (zellen || []).join(' \u0001 ');
  const a = normText(roh);
  const ae = normText(roh, { umlautAe: true });
  return woerter.every((w) => a.includes(w) || ae.includes(w));
}

/* ------------------------------------------------------------------ */
/* Zustand ausserhalb des DOM                                           */
/* ------------------------------------------------------------------ */

const ZUSTAENDE = new Map();
const ZUSTAND_MAX = 300;

function zustandVon(schluessel) {
  let z = ZUSTAENDE.get(schluessel);
  if (!z) {
    z = { spalte: null, richtung: null, filter: '', caret: null };
    ZUSTAENDE.set(schluessel, z);
    if (ZUSTAENDE.size > ZUSTAND_MAX) ZUSTAENDE.delete(ZUSTAENDE.keys().next().value);
  }
  return z;
}

/** Ein Fingerabdruck, wenn der Einbauer keinen Schluessel gibt. */
function fingerabdruck(kopf, zeilen) {
  let x = 2166136261;
  const s = `${kopf.join('\u0001')}\u0002${zeilen.length}\u0002${zeilen.map((z) => z[0] || '').join('\u0001')}`;
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return `fp${x.toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* DOM                                                                  */
/* ------------------------------------------------------------------ */

const I = {
  neutral: '<path d="M6.8 8.2 10 5l3.2 3.2M6.8 11.8 10 15l3.2-3.2"/>',
  auf: '<path d="M6.2 11.6 10 7.8l3.8 3.8"/>',
  ab: '<path d="M6.2 8.4 10 12.2l3.8-3.8"/>',
  suche: '<circle cx="8.8" cy="8.8" r="5.2"/><path d="m12.8 12.8 3.6 3.6"/>',
};

function ensureStyle(id, css) {
  if (typeof document === 'undefined' || !document.head || document.getElementById(id)) return;
  const node = document.createElement('style');
  node.id = id;
  node.textContent = css;
  document.head.appendChild(node);
}

const STYLE_ID = 'nos-tabelle';

/**
 * Eine gerenderte Tabelle verbessern (idempotent: ein zweiter Aufruf tut
 * nichts).
 *
 * @param {Element} ziel die Tabelle, ihr `div.md-table-wrap` oder ein Element darueber
 * @param {{schluessel?:string, filterAb?:number, hochAb?:number, beschriftung?:string}} [opts]
 *   `schluessel`: fester Name fuer Sortierung und Filter ueber einen Neubau hinweg
 * @returns {HTMLElement|null} die Huelle `div.tb` (steht an der Stelle der Tabelle) oder null
 */
export function tabelleVerbessern(ziel, { schluessel = null, filterAb = FILTER_AB, hochAb = HOCH_AB, beschriftung = 'Tabelle' } = {}) {
  if (typeof document === 'undefined' || !ziel) return null;
  const tabelle = ziel.tagName === 'TABLE' ? ziel : (ziel.querySelector ? ziel.querySelector('table') : null);
  if (!tabelle || tabelle.dataset.tb) return null;
  const kopfZeile = tabelle.tHead && tabelle.tHead.rows[0];
  const tbody = tabelle.tBodies[0];
  if (!kopfZeile || !tbody) return null;
  ensureStyle(STYLE_ID, CSS);
  tabelle.dataset.tb = '1';

  let wrap = tabelle.parentElement;
  if (!wrap || !wrap.classList.contains('md-table-wrap')) {
    const neu = h('div.md-table-wrap');
    if (tabelle.parentNode) tabelle.parentNode.replaceChild(neu, tabelle);
    neu.appendChild(tabelle);
    wrap = neu;
  }
  wrap.classList.add('tb-wrap');
  const huelle = h('div.tb');
  if (wrap.parentNode) wrap.parentNode.replaceChild(huelle, wrap);
  huelle.appendChild(wrap);

  const kopfZellen = [...kopfZeile.cells];
  const spalten = kopfZellen.length;
  const zeilen = [...tbody.rows];
  const texte = zeilen.map((tr) => Array.from({ length: spalten }, (_, c) => (tr.cells[c] ? tr.cells[c].textContent.replace(/\s+/g, ' ').trim() : '')));
  const kopfTexte = kopfZellen.map((th) => th.textContent.replace(/\s+/g, ' ').trim());
  const arten = Array.from({ length: spalten }, (_, c) => spaltenArt(texte.map((z) => z[c])));
  const name = schluessel ? String(schluessel) : fingerabdruck(kopfTexte, texte);
  const z = zustandVon(name);
  const key = (teil) => `tb:${name}:${teil}`;
  zeilen.forEach((tr, i) => { tr.dataset.nr = String(i); });

  // Zahlen stehen rechtsbuendig untereinander -- ausser das Markdown hat
  // selbst eine Ausrichtung gewaehlt.
  arten.forEach((art, c) => {
    if (art === 'text') return;
    for (const zelle of [kopfZellen[c], ...zeilen.map((tr) => tr.cells[c])]) {
      if (!zelle) continue;
      // "9,1 Mio." und "28.09.2026" bleiben auf einer Zeile.
      if (zelle !== kopfZellen[c]) zelle.classList.add('tb-ganz');
      if (art === 'zahl' && !zelle.style.textAlign) zelle.classList.add('tb-rechts');
    }
  });

  const pfeile = [];
  kopfZellen.forEach((th, c) => {
    // Ein Link im Kopf wird zu Text: ein Link in einem Knopf waere zwei
    // Dinge zugleich, und der Klick waere zweideutig.
    for (const a of [...th.querySelectorAll('a')]) a.replaceWith(text(a.textContent));
    const inhalt = [...th.childNodes];
    const pfeil = h('span.tb-sort__pfeil', { 'aria-hidden': 'true' });
    pfeile.push(pfeil);
    th.replaceChildren(h('button.tb-sort', {
      type: 'button',
      'data-key': key(`sort:${c}`),
      title: 'Sortieren',
      onClick: (e) => {
        e.stopPropagation();
        if (z.spalte !== c) {
          z.spalte = c;
          z.richtung = 'auf';
        } else if (z.richtung === 'auf') z.richtung = 'ab';
        else if (z.richtung === 'ab') {
          z.spalte = null;
          z.richtung = null;
        } else z.richtung = 'auf';
        sortieren();
      },
    }, h('span.tb-sort__text', null, inhalt), pfeil));
  });

  const leer = h('tr.tb-leer', { hidden: true }, h('td', { colspan: String(spalten) }));
  tbody.appendChild(leer);

  function sortieren() {
    const reihe = reihenfolge(texte, z.spalte, z.richtung, Number.isInteger(z.spalte) ? arten[z.spalte] : null);
    const f = document.createDocumentFragment();
    for (const i of reihe) f.appendChild(zeilen[i]);
    f.appendChild(leer);
    tbody.appendChild(f);
    kopfZellen.forEach((th, c) => {
      const an = c === z.spalte && !!z.richtung;
      if (an) th.setAttribute('aria-sort', z.richtung === 'auf' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
      pfeile[c].replaceChildren(icon(an ? I[z.richtung] : I.neutral));
      const knopf = th.firstChild;
      if (knopf) knopf.title = !an ? 'Sortieren' : (z.richtung === 'auf' ? 'Absteigend sortieren' : 'Wie geschrieben');
    });
  }

  let zaehler = null;
  function filtern() {
    let sichtbar = 0;
    zeilen.forEach((tr, i) => {
      const ja = filterPasst(texte[i], z.filter);
      tr.hidden = !ja;
      if (ja) sichtbar += 1;
    });
    leer.hidden = sichtbar > 0;
    if (!leer.hidden) leer.firstChild.textContent = `Keine Zeile passt zu „${z.filter.trim()}“.`;
    if (zaehler) zaehler.textContent = z.filter.trim() ? `${sichtbar} von ${zeilen.length}` : `${zeilen.length} Zeilen`;
  }

  if (zeilen.length >= filterAb) {
    const feld = h('input.tb-filter__feld', {
      type: 'search',
      value: z.filter,
      placeholder: 'Filtern …',
      'aria-label': `${beschriftung} filtern`,
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      'data-key': key('filter'),
      onInput: () => {
        z.filter = feld.value;
        z.caret = feld.selectionStart;
        filtern();
      },
      onKeydown: (e) => {
        if (e.key === 'Escape' && feld.value) {
          // Nur das Feld leeren -- nicht den Chat (Stopp) oder ein Menue schliessen.
          e.preventDefault();
          e.stopPropagation();
          feld.value = '';
          z.filter = '';
          filtern();
        }
      },
      // Nach einem Neubau landet der Fokus ueber data-key wieder hier; die
      // Schreibmarke soll dann dort stehen, wo sie war, nicht am Anfang.
      onFocus: () => {
        if (Number.isInteger(z.caret) && z.caret <= feld.value.length) {
          try { feld.setSelectionRange(z.caret, z.caret); } catch { /* type=search kann es nicht ueberall */ }
        }
      },
      onClick: (e) => e.stopPropagation(),
    });
    zaehler = h('span.tb-zaehler', { role: 'status', 'aria-live': 'polite' });
    huelle.insertBefore(h('div.tb-leiste', null, h('label.tb-filter', null, icon(I.suche), feld), zaehler), wrap);
  }
  if (zeilen.length > hochAb) wrap.classList.add('is-hoch');

  sortieren();
  filtern();

  // Breite messen: erst im Dokument weiss die Tabelle, ob sie ueberlaeuft.
  const rand = () => {
    const breit = wrap.scrollWidth > wrap.clientWidth + 1;
    wrap.classList.toggle('is-gerollt', wrap.scrollLeft > 1);
    wrap.classList.toggle('is-mehr-rechts', breit && wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 2);
  };
  const messen = () => {
    const breit = wrap.scrollWidth > wrap.clientWidth + 1;
    const hoch = wrap.scrollHeight > wrap.clientHeight + 1;
    wrap.classList.toggle('is-breit', breit);
    if (breit || hoch) {
      // Eine rollbare Flaeche muss mit der Tastatur erreichbar sein.
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', `${beschriftung}, rollbar`);
    } else {
      wrap.removeAttribute('tabindex');
      wrap.removeAttribute('role');
      wrap.removeAttribute('aria-label');
    }
    rand();
  };
  wrap.addEventListener('scroll', rand, { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      // Ein Knoten, den der Chat ersetzt hat, meldet sich hier ab.
      if (!wrap.isConnected) {
        ro.disconnect();
        return;
      }
      messen();
    });
    ro.observe(wrap);
  }
  return huelle;
}

/**
 * Alle Markdown-Tabellen in einem Knoten verbessern (der Chat ruft das nach
 * renderMarkdown auf). Tabellen, die schon verbessert sind, bleiben, wie sie
 * sind; Tabellen in Diagrammen verwaltet das Diagramm selbst.
 * @param {ParentNode} wurzel
 * @param {{schluessel?:string}} [opts] Praefix; die Tabellen heissen dann `${schluessel}:0`, `:1`, …
 * @returns {number} wie viele verbessert wurden
 */
export function tabellenVerbessern(wurzel, { schluessel = null, ...rest } = {}) {
  if (!wurzel || typeof wurzel.querySelectorAll !== 'function') return 0;
  let n = 0;
  [...wurzel.querySelectorAll('table.md-table')].forEach((t, i) => {
    if (t.dataset.tb || (t.closest && t.closest('.dg'))) return;
    if (tabelleVerbessern(t, { ...rest, schluessel: schluessel ? `${schluessel}:${i}` : null })) n += 1;
  });
  return n;
}

const CSS = `
.tb { --tb-grund: var(--surface-2); min-width: 0; max-width: 100%; margin: 4px 0 14px; }
.bs .tb, .dg .tb { --tb-grund: var(--surface); }
.tb:first-child { margin-top: 0; }
.tb:last-child { margin-bottom: 0; }
.tb .md-table-wrap.tb-wrap { position: relative; max-width: 100%; margin: 0; overflow: auto; border-radius: var(--r-1); scrollbar-width: thin; }
.tb-wrap.is-hoch { max-height: min(62vh, 520px); }
.tb-wrap:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.tb-wrap.is-mehr-rechts { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); }
/* separate statt collapse: sonst rollt die Linie unter einer stehenden
   Kopfzeile mit dem Inhalt weg (Chromium). */
.tb .tb-wrap .table { border-collapse: separate; border-spacing: 0; }
/* Die Chat-Blase bricht lange Woerter ueberall (overflow-wrap: anywhere) --
   in einer Tabelle wuerde daraus "Österrei|ch" und eine Spalte aus einzelnen
   Buchstaben. Hier bricht nur zwischen Woertern; was nicht passt, rollt. */
.tb .tb-wrap .table { overflow-wrap: normal; word-break: normal; }
.tb .tb-ganz { white-space: nowrap; }
.tb .tb-wrap thead th { position: sticky; top: 0; z-index: 2; padding: 0; vertical-align: bottom; background: var(--tb-grund); }
.tb .tb-wrap tbody td { background: var(--tb-grund); transition: background var(--dur-1) var(--ease); }
.tb .tb-wrap tbody tr:hover td { background: color-mix(in srgb, var(--fg) 4%, var(--tb-grund)); }
.tb-sort { display: flex; align-items: center; gap: 4px; width: 100%; min-height: 34px; padding: 7px 10px; font: inherit; font-weight: 500; line-height: 1.3; color: inherit; text-align: inherit; background: none; border: 0; border-radius: var(--r-1); cursor: pointer; -webkit-tap-highlight-color: transparent; }
.tb-sort:hover { color: var(--fg); }
.tb-sort:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent-ring); }
.tb-sort__text { min-width: 0; }
.tb-sort__pfeil { display: inline-grid; place-items: center; flex: none; width: 14px; height: 14px; color: var(--fg-subtle); opacity: 0; transition: opacity var(--dur-1) var(--ease), color var(--dur-1) var(--ease); }
.tb-sort__pfeil svg { width: 14px; height: 14px; }
.tb-sort:hover .tb-sort__pfeil, .tb-sort:focus-visible .tb-sort__pfeil, th[aria-sort] .tb-sort__pfeil { opacity: 1; }
th[aria-sort] .tb-sort { color: var(--fg); }
th[aria-sort] .tb-sort__pfeil { color: var(--accent-text); }
.tb .tb-rechts { text-align: right; font-variant-numeric: tabular-nums; }
.tb th.tb-rechts .tb-sort, .tb th[style*="right"] .tb-sort { flex-direction: row-reverse; }
.tb th[style*="center"] .tb-sort { justify-content: center; }
/* Telefon: die erste Spalte bleibt stehen, wenn die Tabelle seitwaerts rollt */
.tb .tb-wrap.is-breit th:first-child, .tb .tb-wrap.is-breit td:first-child { position: sticky; left: 0; z-index: 1; }
.tb .tb-wrap.is-breit thead th:first-child { z-index: 3; }
.tb .tb-wrap.is-gerollt th:first-child, .tb .tb-wrap.is-gerollt td:first-child { box-shadow: 1px 0 0 var(--border-strong), 8px 0 10px -8px rgba(0, 0, 0, 0.35); }
.tb-leer td { padding: 16px 10px; font-size: var(--fs-sm); color: var(--fg-muted); text-align: center; }
.tb-leiste { display: flex; align-items: center; gap: 12px; margin: 0 0 8px; }
.tb-filter { position: relative; display: flex; align-items: center; flex: 0 1 260px; min-width: 0; }
.tb-filter svg { position: absolute; left: 10px; width: 15px; height: 15px; color: var(--fg-subtle); pointer-events: none; }
.tb-filter__feld { width: 100%; min-height: 32px; padding: 5px 10px 5px 32px; font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-2); transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease); }
.bs .tb-filter__feld, .dg .tb-filter__feld { background: var(--surface-2); }
.tb-filter__feld::placeholder { color: var(--fg-subtle); }
.tb-filter__feld:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.tb-filter__feld::-webkit-search-cancel-button { cursor: pointer; }
.tb-zaehler { font-size: var(--fs-xs); color: var(--fg-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (pointer: coarse) {
  .tb-sort { min-height: 40px; }
  /* 16 px: sonst vergroessert Safari auf dem iPad beim Antippen die Seite */
  .tb-filter__feld { min-height: var(--tap-min); font-size: 16px; }
  .tb-filter { flex-basis: 300px; }
}
@media (prefers-reduced-motion: reduce) {
  .tb .tb-wrap tbody td, .tb-sort__pfeil { transition: none; }
}
`;
