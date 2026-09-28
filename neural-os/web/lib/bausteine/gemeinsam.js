/**
 * bausteine/gemeinsam.js -- was alle Antwort-Bausteine teilen.
 *
 * Drei Dinge liegen hier, damit sie nicht zweiundzwanzigmal leicht
 * verschieden entstehen:
 *
 * 1. Die Pruefhelfer. Das JSON eines Bausteins schreibt eine KI. Es wird
 *    deshalb nie "vertraut", sondern je Feld gelesen: bekannte Felder mit
 *    dem richtigen Typ bleiben, Laengen werden gekappt, alles andere
 *    faellt weg. Ein Fehler hat genau einen deutschen Satz -- er steht
 *    spaeter ueber dem Codeblock ("Konnte nicht angezeigt werden").
 * 2. Die Symbole (eigene SVG-Pfade im Strich von web/app.js), weil ein
 *    Baustein nicht davon abhaengen darf, welche Symbole die App gerade
 *    registriert hat.
 * 3. Das gemeinsame CSS: ein Baustein sieht aus wie die anderen Karten der
 *    App (Haarlinie, --r-3, ein Akzent), dunkel und hell, und jede
 *    Bedienflaeche hat unter (pointer: coarse) mindestens 44 px.
 *
 * Nichts hier fasst beim Laden `document` an: test/bausteine.test.js
 * importiert die Module in Node, ohne Browser.
 */

import { h, text, icon } from '../dom.js';
import { renderInline } from '../markdown.js';

/* ------------------------------------------------------------------ */
/* Pruefen                                                             */
/* ------------------------------------------------------------------ */

/** Ein Fehler im JSON eines Bausteins. Die Nachricht ist fuer Menschen. */
export class BausteinFehler extends Error {
  constructor(message) {
    super(message);
    this.name = 'BausteinFehler';
  }
}

export const fehler = (satz) => new BausteinFehler(satz);

/** Grenzen fuer Textfelder. Kurz = Beschriftung, Text = Absatz, Inhalt = Markdown. */
export const LAENGE = { kurz: 200, titel: 160, text: 2000, inhalt: 40000, datei: 200000 };

/** Steuerzeichen raus (ausser Tab und Zeilenumbruch), Rand weg, kappen. */
export function str(wert, max = LAENGE.kurz) {
  if (wert === null || wert === undefined) return '';
  if (typeof wert !== 'string' && typeof wert !== 'number') return '';
  const s = String(wert).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Wie `str`, aber das Feld muss da sein. */
export function strPflicht(wert, feld, max = LAENGE.kurz) {
  const s = str(wert, max);
  if (!s) throw fehler(`Das Feld „${feld}“ fehlt oder ist leer.`);
  return s;
}

/** Ein Inhalt, bei dem Leerraum zaehlt (Code, Datei): nur kappen, nicht trimmen. */
export function roh(wert, max = LAENGE.datei) {
  if (typeof wert !== 'string') return '';
  const s = wert.replace(/\r\n?/g, '\n');
  return s.length > max ? s.slice(0, max) : s;
}

export function bool(wert, standard = false) {
  return typeof wert === 'boolean' ? wert : standard;
}

/** Eine endliche Zahl im Bereich, sonst `standard`. */
export function zahl(wert, { min = -Infinity, max = Infinity, standard = null, ganz = false } = {}) {
  let n = typeof wert === 'number' ? wert : (typeof wert === 'string' && wert.trim() !== '' ? Number(wert.replace(',', '.')) : NaN);
  if (!Number.isFinite(n)) return standard;
  if (ganz) n = Math.round(n);
  return Math.min(max, Math.max(min, n));
}

/** Eine Liste mit Grenzen; `je` wandelt jeden Eintrag (und darf werfen). */
export function liste(wert, feld, { min = 0, max = 50, je = (x) => x } = {}) {
  if (wert === undefined || wert === null) {
    if (min > 0) throw fehler(`Das Feld „${feld}“ fehlt.`);
    return [];
  }
  if (!Array.isArray(wert)) throw fehler(`„${feld}“ muss eine Liste sein.`);
  const out = [];
  for (const [i, eintrag] of wert.slice(0, max).entries()) {
    const x = je(eintrag, i);
    if (x !== null && x !== undefined) out.push(x);
  }
  if (out.length < min) {
    throw fehler(min === 1 ? `„${feld}“ braucht mindestens einen Eintrag.` : `„${feld}“ braucht mindestens ${min} Einträge.`);
  }
  return out;
}

/** Einer aus einer festen Menge, sonst `standard`. */
export function wahl(wert, erlaubt, standard) {
  const s = typeof wert === 'string' ? wert.trim().toLowerCase() : '';
  return erlaubt.includes(s) ? s : standard;
}

/** Ein fester Schluessel (`id`) fuer den gespeicherten Zustand. */
export function schluesselOk(wert) {
  return typeof wert === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(wert) ? wert : null;
}

/** Ein Objekt (kein Array, nicht null) oder null. */
export function objekt(wert) {
  return wert && typeof wert === 'object' && !Array.isArray(wert) ? wert : null;
}

/* ------------------------------------------------------------------ */
/* Kleine reine Helfer                                                 */
/* ------------------------------------------------------------------ */

/**
 * Deterministisch mischen: dieselbe Saat gibt dieselbe Reihenfolge. Das ist
 * Absicht -- die Nachricht wird bei jeder Aenderung neu gezeichnet, und eine
 * Zuordnung, deren rechte Seite dabei jedes Mal neu faellt, waere
 * unbedienbar.
 */
export function mischen(n, saat = 1) {
  let s = (Math.abs(Math.floor(saat)) % 2147483646) + 1;
  const zufall = () => {
    s = (s * 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(zufall() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/** Eine Zahl aus einem Text (fuer `mischen`), stabil ueber Sitzungen. */
export function saatAus(textWert) {
  let x = 2166136261;
  const s = String(textWert || '');
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return x || 1;
}

/** Ein Element von `von` nach `nach` verschieben, ohne das Original zu aendern. */
export function umordnen(reihe, von, nach) {
  const out = Array.isArray(reihe) ? reihe.slice() : [];
  if (!Number.isInteger(von) || !Number.isInteger(nach)) return out;
  if (von < 0 || von >= out.length) return out;
  const ziel = Math.max(0, Math.min(out.length - 1, nach));
  const [x] = out.splice(von, 1);
  out.splice(ziel, 0, x);
  return out;
}

/** Ist `reihe` eine Umordnung von 0..n-1? (gespeicherter Zustand kann alt sein) */
export function istUmordnung(reihe, n) {
  if (!Array.isArray(reihe) || reihe.length !== n) return false;
  const gesehen = new Set();
  for (const x of reihe) {
    if (!Number.isInteger(x) || x < 0 || x >= n || gesehen.has(x)) return false;
    gesehen.add(x);
  }
  return true;
}

/** Deutsche Zahl mit hoechstens `stellen` Nachkommastellen. */
export function zahlDeutsch(n, stellen = 2) {
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString('de-DE', { maximumFractionDigits: stellen });
}

/** Ist das genau ein Emoji (ein Graphem, bildhaft)? */
export function istEmoji(s) {
  const wert = String(s || '');
  if (!wert || wert.length > 16) return false;
  if (!/\p{Extended_Pictographic}/u.test(wert)) return false;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const teile = [...new Intl.Segmenter('de', { granularity: 'grapheme' }).segment(wert)];
    return teile.length === 1;
  }
  return /^(\p{Extended_Pictographic}|️|‍|\p{Emoji_Modifier})+$/u.test(wert);
}

/* ------------------------------------------------------------------ */
/* Symbole                                                             */
/* ------------------------------------------------------------------ */

/**
 * Die Symbolnamen, die eine KI in `karten[].symbol` und `aktionen[].symbol`
 * benutzen darf (docs/ANTWORT-BAUSTEINE.md, Abschnitt 2). Eine feste Liste,
 * damit ein erfundener Name nicht still zu einem leeren Kreis wird.
 */
export const SYMBOL_NAMEN = ['buch', 'uhr', 'stern', 'ziel', 'idee', 'datei', 'kalender', 'ort', 'person', 'haken',
  'blitz', 'herz', 'lernen', 'code', 'bild', 'musik', 'geld', 'frage'];

export const S = {
  // Bedienung
  haken: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  links: '<path d="M12.4 4.6 7 10l5.4 5.4"/>',
  rechts: '<path d="M7.6 4.6 13 10l-5.4 5.4"/>',
  runter: '<path d="M4.6 7.6 10 13l5.4-5.4"/>',
  zurueck: '<path d="M7.4 4.8 3.8 8.4l3.6 3.6"/><path d="M4 8.4h7.4a4.6 4.6 0 0 1 0 9.2H9.2"/>',
  vor: '<path d="m12.6 4.8 3.6 3.6-3.6 3.6"/><path d="M16 8.4H8.6a4.6 4.6 0 0 0 0 9.2h2.2"/>',
  start: '<path d="M6.6 4.4v11.2l8.8-5.6z"/>',
  pause: '<path d="M7.2 4.8v10.4M12.8 4.8v10.4"/>',
  stopp: '<rect x="5.2" y="5.2" width="9.6" height="9.6" rx="1.8"/>',
  laden: '<path d="M10 3.4v9.4M6 9l4 4 4-4"/><path d="M3.8 16.2h12.4"/>',
  gross: '<path d="M3.6 7.6V3.6h4M16.4 7.6V3.6h-4M3.6 12.4v4h4M16.4 12.4v4h-4"/>',
  klein: '<path d="M7.6 3.6v4h-4M12.4 3.6v4h4M7.6 16.4v-4h-4M12.4 16.4v-4h4"/>',
  quelltext: '<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>',
  teilen: '<path d="M10 12.2V3.4M6.8 6.4 10 3.2l3.2 3.2"/><path d="M6.6 9H5.4a1.6 1.6 0 0 0-1.6 1.6v5.2a1.6 1.6 0 0 0 1.6 1.6h9.2a1.6 1.6 0 0 0 1.6-1.6v-5.2A1.6 1.6 0 0 0 14.6 9h-1.2"/>',
  griff: '<g fill="currentColor" stroke="none"><circle cx="7.4" cy="5.2" r="1.1"/><circle cx="12.6" cy="5.2" r="1.1"/><circle cx="7.4" cy="10" r="1.1"/><circle cx="12.6" cy="10" r="1.1"/><circle cx="7.4" cy="14.8" r="1.1"/><circle cx="12.6" cy="14.8" r="1.1"/></g>',
  mischen: '<path d="M3.4 6.2h2.4c1.7 0 2.7.8 3.6 2.3l1.4 2.8c.9 1.5 1.9 2.3 3.6 2.3h2"/><path d="M3.4 13.6h2.4c1 0 1.8-.3 2.4-.9M11.8 7.1c.6-.6 1.4-.9 2.4-.9h2"/><path d="m14.6 4.4 1.9 1.8-1.9 1.8M14.6 11.8l1.9 1.8-1.9 1.8"/>',
  nochmal: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  extern: '<path d="M11.6 3.6h4.8v4.8M16.2 3.8 9.4 10.6"/><path d="M14.4 11.6v3.2a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6V7.2a1.6 1.6 0 0 1 1.6-1.6h3.2"/>',
  stift: '<path d="M12.8 3.8a1.9 1.9 0 0 1 2.7 2.7l-8.6 8.6-3.6.9.9-3.6z"/><path d="m11.4 5.2 2.7 2.7"/>',
  schliessen: '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>',
  auge: '<path d="M2.4 10s2.8-5.2 7.6-5.2 7.6 5.2 7.6 5.2-2.8 5.2-7.6 5.2S2.4 10 2.4 10z"/><circle cx="10" cy="10" r="2.3"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  achtung: '<circle cx="10" cy="10" r="7.4"/><path d="M10 6.2v4.4M10 13.6h.01"/>',
  kreuz: '<path d="m5.6 5.6 8.8 8.8M14.4 5.6l-8.8 8.8"/>',
  pfeil: '<path d="M3.8 10h11.4M11 5.8l4.2 4.2-4.2 4.2"/>',
  // Karten- und Aktionssymbole (SYMBOL_NAMEN)
  buch: '<path d="M10 5.4C8.4 4.2 6.2 3.8 3.6 4v11.2c2.6-.2 4.8.2 6.4 1.4 1.6-1.2 3.8-1.6 6.4-1.4V4c-2.6-.2-4.8.2-6.4 1.4z"/><path d="M10 5.4v11.2"/>',
  uhr: '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.4V10l3.2 1.9"/>',
  stern: '<path d="m10 2.8 2.2 4.6 5 .6-3.7 3.4 1 5-4.5-2.5-4.5 2.5 1-5L2.8 8l5-.6z"/>',
  ziel: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.8"/><circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none"/>',
  idee: '<path d="M7.6 14.2h4.8M8.2 16.8h3.6"/><path d="M10 2.8a5 5 0 0 0-3 9c.6.5.9 1.1.9 1.8v.6h4.2v-.6c0-.7.3-1.3.9-1.8a5 5 0 0 0-3-9z"/>',
  datei: '<path d="M5.4 2.7h5.9l3.9 3.9v9.1a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6V4.3a1.6 1.6 0 0 1 1.6-1.6z"/><path d="M11.1 2.9v3.9h3.9M6.8 10.4h6.4M6.8 13.4h4.2"/>',
  kalender: '<rect x="3" y="4.2" width="14" height="13" rx="2.4"/><path d="M3 8.4h14M6.8 2.6v3.2M13.2 2.6v3.2"/>',
  ort: '<path d="M10 17.4s5.4-4.9 5.4-9.1a5.4 5.4 0 0 0-10.8 0c0 4.2 5.4 9.1 5.4 9.1z"/><circle cx="10" cy="8.3" r="1.9"/>',
  person: '<circle cx="10" cy="6.6" r="3.2"/><path d="M3.8 17c.6-3.2 3.1-5.2 6.2-5.2s5.6 2 6.2 5.2"/>',
  blitz: '<path d="M11 2.6 4.6 11.2h5l-1 6.2 6.8-8.8h-5.2z"/>',
  herz: '<path d="M10 16.6S3 12.5 3 7.6A3.8 3.8 0 0 1 10 5.5a3.8 3.8 0 0 1 7 2.1c0 4.9-7 9-7 9z"/>',
  lernen: '<path d="M10 4.2 2.4 8 10 11.8 17.6 8z"/><path d="M5.4 9.6v3.6c1.2 1.2 2.8 1.8 4.6 1.8s3.4-.6 4.6-1.8V9.6M17.6 8v4.4"/>',
  code: '<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>',
  bild: '<rect x="3" y="3.8" width="14" height="12.4" rx="2.2"/><circle cx="7.4" cy="8" r="1.4"/><path d="m3.4 14.6 4-4 3 3 2.2-2.2 4 3.8"/>',
  musik: '<path d="M7.6 14.6V4.8l8.2-1.6v9.6"/><circle cx="5.6" cy="14.6" r="2"/><circle cx="13.8" cy="12.8" r="2"/>',
  geld: '<rect x="2.6" y="5.2" width="14.8" height="9.6" rx="2"/><circle cx="10" cy="10" r="2.2"/><path d="M5.4 7.8h.01M14.6 12.2h.01"/>',
  frage: '<circle cx="10" cy="10" r="7.4"/><path d="M7.9 7.8a2.2 2.2 0 1 1 3.1 2c-.6.3-1 .8-1 1.5v.4M10 14.1h.01"/>',
};
// `haken` ist in der Liste der Kartensymbole ein Haken im Kreis.
const HAKEN_KREIS = '<circle cx="10" cy="10" r="7.4"/><path d="m6.8 10.2 2.2 2.2 4.2-4.6"/>';

/** Ein Bedien-Symbol als Knoten (dekorativ, aria-hidden). */
export function sym(name) {
  return icon(S[name] || S.frage);
}

/**
 * Ein Karten-/Aktionssymbol: Name aus SYMBOL_NAMEN oder ein einzelnes
 * Emoji. Unbekanntes wird beim Pruefen schon verworfen.
 */
export function kartenSymbol(wert) {
  if (!wert) return null;
  if (SYMBOL_NAMEN.includes(wert)) return icon(wert === 'haken' ? HAKEN_KREIS : S[wert]);
  return h('span.bs-emoji', { 'aria-hidden': 'true' }, text(wert));
}

/** Symbolfeld pruefen: bekannter Name oder genau ein Emoji, sonst weg. */
export function symbolPruefen(wert) {
  if (typeof wert !== 'string') return null;
  const s = wert.trim();
  if (SYMBOL_NAMEN.includes(s.toLowerCase())) return s.toLowerCase();
  return istEmoji(s) ? s : null;
}

/* ------------------------------------------------------------------ */
/* Inline-Markdown                                                      */
/* ------------------------------------------------------------------ */

/**
 * Kurze Felder duerfen Inline-Markdown (fett, kursiv, Code, Links). In einer
 * Beschriftung, die selbst ein Knopf ist, waere ein Link darin ungueltiges
 * HTML (interaktiv in interaktiv) und ein Klick zweideutig: dort wird er zu
 * seinem Text.
 */
export function inline(wert, { ohneLinks = false } = {}) {
  const f = renderInline(String(wert || ''));
  if (ohneLinks) {
    for (const a of [...f.querySelectorAll('a, .md-link--blocked')]) {
      const span = h('span');
      for (const kind of [...a.childNodes]) {
        if (kind.nodeType === 1 && kind.classList && kind.classList.contains('md-link__mark')) continue;
        span.appendChild(kind);
      }
      a.replaceWith(span);
    }
  }
  return f;
}

/* ------------------------------------------------------------------ */
/* Stil                                                                 */
/* ------------------------------------------------------------------ */

/** Ein <style> je Modul, einmal. Nur mit textContent -- nie als HTML. */
export function ensureStyle(id, css) {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(id)) return;
  const node = document.createElement('style');
  node.id = id;
  node.textContent = css;
  document.head.appendChild(node);
}

/**
 * Das gemeinsame Aussehen. Alle Werte sind Marken aus web/app.css. Die
 * Karte eines Bausteins liegt in der Antwortblase (--surface-2) und ist
 * deshalb eine Stufe dunkler/heller (--surface) mit Haarlinie: so wie die
 * Wirkungskarten und die Rueckfrage des Chats.
 */
export const CSS = `
.bs { position: relative; display: block; width: 600px; max-width: 100%; margin: 14px 0; padding: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); color: var(--fg); font-size: var(--fs-md); line-height: var(--lh); text-align: left; animation: bs-ein var(--dur-3) var(--ease); }
.bs:first-child { margin-top: 0; }
.bs:focus { outline: none; }
.bs:last-child { margin-bottom: 0; }
.bs--flach { padding: 0; background: none; border: 0; }
/* Eine ruhige, einheitliche Breite: Bausteine stehen in einer Blase, die sich
   nach ihrem Inhalt richtet. Ohne feste Wunschbreite waere jede Karte so
   schmal wie ihr laengstes Wort -- ein Formular einspaltig, drei Karten
   untereinander. Breitere Dinge (Vorschau, Karten, Formular) duerfen mehr. */
.bs--flach { width: auto; }
.bs[data-baustein="vorschau"], .bs[data-baustein="karten"], .bs[data-baustein="formular"] { width: 680px; }
.bs .bs { width: auto; }
.bs .bs { margin: 12px 0; }
@keyframes bs-ein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.bs-kopf { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
.bs-titel { margin: 0; font-size: var(--fs-md); font-weight: 600; line-height: 1.35; letter-spacing: -0.005em; color: var(--fg); overflow-wrap: anywhere; }
.bs-meta { font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.bs-leise { font-size: var(--fs-sm); color: var(--fg-subtle); }
.bs-fuss { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
.bs-fuss__rechts { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; }
.bs-fehler { margin: 10px 0 0; font-size: var(--fs-sm); color: var(--danger); }
.bs-ok { color: var(--ok); }
.bs-knopf { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 0 14px; font: inherit; font-size: var(--fs-base); font-weight: 500; line-height: 1.2; color: var(--fg); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-2); cursor: pointer; white-space: nowrap; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease), opacity var(--dur-2) var(--ease); -webkit-tap-highlight-color: transparent; }
.bs-knopf:hover:not(:disabled) { background: var(--surface-3); }
.bs-knopf:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-knopf:disabled { opacity: 0.45; cursor: default; }
.bs-knopf svg { width: 16px; height: 16px; flex: none; }
.bs-knopf--haupt { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
.bs-knopf--haupt:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
.bs-knopf--akzent { color: var(--accent-text); background: color-mix(in srgb, var(--accent) 7%, transparent); border-color: color-mix(in srgb, var(--accent) 62%, transparent); }
.bs-knopf--akzent:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); }
.bs-knopf--leise { color: var(--fg-muted); background: none; border-color: transparent; }
.bs-knopf--leise:hover:not(:disabled) { color: var(--fg); background: var(--surface-3); }
.bs-knopf--rund { width: 34px; padding: 0; }
.bs-knopf.is-ok { color: var(--ok); }
.bs-knopf .spinner { width: 14px; height: 14px; border-width: 2px; }
.bs-feld { width: 100%; min-height: 38px; padding: 8px 12px; font: inherit; font-size: var(--fs-base); color: var(--fg); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-2); transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease); }
.bs-feld::placeholder { color: var(--fg-subtle); }
.bs-feld:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-feld[aria-invalid="true"] { border-color: var(--danger); }
.bs-balken { position: relative; height: 6px; overflow: hidden; background: var(--surface-3); border-radius: var(--r-full); }
.bs-balken__wert { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--accent); border-radius: inherit; transition: width var(--dur-3) var(--ease); }
.bs-punkte { display: flex; align-items: center; justify-content: center; gap: 2px; }
.bs-punkt { display: inline-grid; place-items: center; width: 22px; height: 22px; padding: 0; background: none; border: 0; border-radius: 50%; cursor: pointer; }
.bs-punkt::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); transition: background var(--dur-2) var(--ease), transform var(--dur-2) var(--ease); }
.bs-punkt.is-aktiv::before { background: var(--accent); transform: scale(1.15); }
.bs-punkt.is-fertig::before { background: var(--fg-subtle); }
.bs-punkt:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-md { min-width: 0; }
.bs-md .md-p { margin: 0 0 10px; }
.bs-md > :last-child, .bs-md .md-p:last-child { margin-bottom: 0; }
.bs-emoji { font-size: 17px; line-height: 1; }
.bs-nur-leser { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
/* Rueckgaengig/Wiederholen: eine kleine Leiste, die auf der oberen Kante der
   Karte sitzt -- sie verdeckt so keinen Inhalt (Titel, "3 von 5"). */
.bs-verlauf { position: absolute; top: -14px; right: 14px; display: flex; gap: 2px; padding: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); box-shadow: var(--shadow-1); animation: bs-ein var(--dur-2) var(--ease); z-index: 1; }
.bs-verlauf .bs-knopf { min-height: 26px; width: 28px; padding: 0; border: 0; background: none; color: var(--fg-muted); }
.bs-verlauf .bs-knopf:hover:not(:disabled) { color: var(--fg); background: var(--surface-3); }
.bs-verlauf .bs-knopf svg { width: 15px; height: 15px; }

/* Schieberegler: eine Spur, deren gefuellter Teil der Akzent ist (--p setzt reglerFuellen) */
.bs-regler { -webkit-appearance: none; appearance: none; flex: 1 1 auto; min-width: 0; height: 24px; margin: 0; background: none; cursor: pointer; --p: 50%; }
.bs-regler:disabled { cursor: default; opacity: 0.6; }
.bs-regler:focus-visible { outline: none; }
.bs-regler::-webkit-slider-runnable-track { height: 4px; background: linear-gradient(to right, var(--accent) 0 var(--p), var(--surface-4) var(--p) 100%); border-radius: var(--r-full); }
.bs-regler::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; margin-top: -8px; background: var(--accent-fg); border: 0; border-radius: 50%; box-shadow: 0 0 0 1px var(--border-strong), var(--shadow-1); transition: box-shadow var(--dur-1) var(--ease), transform var(--dur-1) var(--ease); }
.bs-regler:active::-webkit-slider-thumb { transform: scale(1.08); }
.bs-regler:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px var(--accent-ring); }
.bs-regler::-moz-range-track { height: 4px; background: var(--surface-4); border-radius: var(--r-full); }
.bs-regler::-moz-range-progress { height: 4px; background: var(--accent); border-radius: var(--r-full); }
.bs-regler::-moz-range-thumb { width: 20px; height: 20px; background: var(--accent-fg); border: 0; border-radius: 50%; box-shadow: 0 0 0 1px var(--border-strong), var(--shadow-1); }

/* Platzhalter, solange der Block noch geschrieben wird */
.bs--wird { display: flex; align-items: center; gap: 12px; min-height: 64px; color: var(--fg-muted); font-size: var(--fs-sm); background: linear-gradient(100deg, var(--surface) 30%, var(--surface-2) 50%, var(--surface) 70%); background-size: 220% 100%; animation: bs-schimmer 1.4s linear infinite; }
.bs--wird .bs-wird__punkt { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--accent); opacity: 0.7; }
@keyframes bs-schimmer { from { background-position: 120% 0; } to { background-position: -120% 0; } }

/* Konnte nicht angezeigt werden */
.bs-kaputt { margin: 14px 0; }
.bs-kaputt__hinweis { margin: 0 0 6px; font-size: var(--fs-sm); line-height: 1.45; color: var(--fg-muted); }
.bs-kaputt__hinweis svg { width: 15px; height: 15px; margin-right: 6px; vertical-align: -3px; color: var(--warn); }
.bs-kaputt__grund { color: var(--fg-subtle); }

@media (pointer: coarse) {
  .bs-knopf, .bs-feld { min-height: var(--tap-min); }
  .bs-knopf--rund { width: var(--tap-min); }
  .bs-punkt { width: 32px; height: var(--tap-min); }
  .bs-verlauf { position: static; width: fit-content; margin: 12px 0 -4px auto; }
  .bs-verlauf .bs-knopf { min-height: 40px; width: 40px; }
  .bs-regler { height: var(--tap-min); }
  .bs-regler::-webkit-slider-thumb { width: 28px; height: 28px; margin-top: -12px; }
  .bs-regler::-moz-range-thumb { width: 28px; height: 28px; }
}
@media (prefers-reduced-motion: reduce) {
  .bs, .bs-verlauf { animation: none; }
  .bs--wird { animation: none; }
}
`;

/* ------------------------------------------------------------------ */
/* Bauhelfer (brauchen den Browser erst beim Aufruf)                    */
/* ------------------------------------------------------------------ */

/**
 * Ein Knopf in der Sprache der Bausteine. `art`: '' | 'haupt' | 'akzent' |
 * 'leise'. Klicks laufen nicht weiter nach oben: das Antippen einer
 * Nachricht schaltet im Chat die Aktionsleiste um, ein Knopf in einem
 * Baustein soll das nicht nebenbei tun.
 */
export function knopf(beschriftung, { art = '', symbol = null, onClick, key = null, titel = null, label = null, disabled = false, klasse = '', attrs = null } = {}) {
  const klassen = ['bs-knopf'];
  if (art) klassen.push(`bs-knopf--${art}`);
  if (klasse) klassen.push(klasse);
  if (!beschriftung && symbol) klassen.push('bs-knopf--rund');
  return h('button', {
    type: 'button',
    class: klassen.join(' '),
    disabled,
    title: titel || null,
    'aria-label': label || (!beschriftung ? titel : null),
    'data-key': key,
    attrs,
    onClick: (e) => {
      e.stopPropagation();
      if (typeof onClick === 'function') onClick(e);
    },
  }, symbol ? sym(symbol) : null, beschriftung ? h('span', null, beschriftung instanceof Node ? beschriftung : text(beschriftung)) : null);
}

/** Ein Spinner im Knopf (die Klasse `spinner` kommt aus app.css). */
export function spinner() {
  return h('span.spinner', { 'aria-hidden': 'true' });
}

/** Fortschrittsbalken 0..1 mit echter progressbar-Rolle. */
export function balken(anteil, label) {
  const p = Math.max(0, Math.min(1, Number(anteil) || 0));
  return h('div.bs-balken', {
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(Math.round(p * 100)),
    'aria-label': label || null,
  }, h('div.bs-balken__wert', { style: { width: `${(p * 100).toFixed(2)}%` } }));
}

/** Datei im Browser speichern (Blob, kein Server). */
export function herunterladen(name, inhalt, mime = 'text/plain;charset=utf-8') {
  const blob = inhalt instanceof Blob ? inhalt : new Blob([inhalt], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: ladeName(name), hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Erst spaeter freigeben: Safari liest die Adresse nach dem Klick noch.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

/**
 * Der Name fuer den Download: nur ASCII. Chromium verwirft ein
 * download-Attribut mit Umlauten je nach System still und nennt die Datei
 * dann "download" -- aus "Zähler.html" wird deshalb "Zaehler.html".
 */
export function ladeName(name) {
  const s = String(name || '')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_');
  return dateiname(s, 'datei.txt');
}

/** Ein Dateiname ohne Pfadteile und ohne Zeichen, die ein Dateisystem ablehnt. */
export function dateiname(roherName, standard = 'datei.txt') {
  const s = String(roherName || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return s || standard;
}

/** Das Element mit diesem data-key (die Schluessel enthalten | und :). */
export function perKey(key, wurzel = document) {
  const c = globalThis.CSS;
  const k = c && typeof c.escape === 'function' ? c.escape(key) : String(key).replace(/["\\]/g, '\\$&');
  return wurzel.querySelector(`[data-key="${k}"]`);
}

/** Nach dem naechsten Neuzeichnen dorthin fokussieren. */
export function fokusSpaeter(key) {
  setTimeout(() => {
    const el = perKey(key);
    if (el && typeof el.focus === 'function') el.focus();
  }, 20);
}

/** Den gefuellten Teil eines Schiebereglers setzen (WebKit kennt kein ::range-progress). */
export function reglerFuellen(el) {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const v = Number(el.value);
  const p = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--p', `${Math.max(0, Math.min(100, p)).toFixed(2)}%`);
}
