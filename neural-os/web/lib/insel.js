/**
 * lib/insel.js -- die Insel: oben in der Mitte von Neural OS, immer da, und
 * auf Wunsch ueber allen anderen Programmen.
 *
 * Was sie ist, ehrlich gesagt:
 *
 * - **Eine kleine Pille im Kopf**, die zeigt, was gerade lebt: die KI denkt
 *   oder schreibt, ein Timer laeuft ab, ein Termin beginnt gleich, ein
 *   Agent arbeitet, der Bildschirm wird geteilt. Die wichtigste Sache steht
 *   gross, eine zweite als Blase daneben (wie zwei Live-Aktivitaeten am
 *   iPhone). Erinnerungen an Termine (lib/erinnerung.js) haengen sich als
 *   Kapsel an die Pille.
 * - **Aufgeklappt ein Gespraech** mit der eigenen KI -- derselbe Chat-Dienst
 *   mit denselben Werkzeugen (Termin eintragen, Notiz anlegen, merken,
 *   im eigenen Wissen suchen, Websuche). Jede Frage landet in einem echten
 *   Chat "Insel · …", den man unter "Zuletzt" findet, oeffnen und loeschen
 *   kann. Nach zwei Stunden Ruhe beginnt ein neuer.
 * - **"Bildschirm zeigen"**: der Browser fragt, was geteilt wird (ganzer
 *   Bildschirm, ein Fenster, ein Tab). Solange geteilt wird, geht mit jeder
 *   Frage ein frisches Bild mit -- abschaltbar. Die KI sieht also, was man
 *   in einem ANDEREN Programm vor sich hat. Sie sieht es nur in dem Moment
 *   der Frage; ein Film wird nicht gemacht.
 * - **"Über allen Fenstern"** (Document Picture-in-Picture): die Insel zieht
 *   in ein kleines Fenster, das ueber jedem Programm schwebt. Das geht in
 *   Chrome, Edge, Opera und Firefox am Computer; in Safari und auf dem iPad
 *   nicht -- dann gibt es den Knopf nicht. Das Fenster gehoert zum Tab von
 *   Neural OS: wird der geschlossen, geht es mit zu.
 * - Was sie NICHT kann: in anderen Programmen klicken oder tippen, und sie
 *   hoert nicht von selbst zu. Ein Tastenkuerzel, das in jedem Programm
 *   wirkt, kann eine Webseite nicht anlegen -- Strg/⌘ + Umschalt +
 *   Leertaste gilt in Neural OS und im schwebenden Fenster.
 *
 * Kleine Befehle erledigt sie selbst, ohne die KI zu fragen ("Timer 5 min",
 * "Notiz: …", lib/insel-logik.js). Was der Browser sich dabei merkt, steht in
 * lib/lokal.js: die Kennung des Insel-Chats und eine Vorliebe; Timer nur fuer
 * diesen Tab (lokal.entwurf), weil ihr Name Inhalt ist.
 *
 * Eingehaengt wird sie mit einer Zeile in web/app.js.
 */

import { h, text, clear, icon } from './dom.js';
import { ApiError } from './api.js';
import * as lokal from './lokal.js';
import { renderMarkdown, extractPlain } from './markdown.js';
import { markdownOhneUi } from './bausteine/index.js';
import { wirkungZeilen, zustandVon } from './agenten.js';
import {
  sprechWeg, erkennungStarten, aufnahmeStarten, erkennungFehlerSatz, erkennungUntauglich, bytesAlsBase64,
} from './sprechen.js';
import { seitenVorleser, vorlesenMoeglich, sprechText } from './vorlesen.js';
import {
  dateiArt, bildVorbereiten, alsBase64, anhangUrl, MOEGLICH, MAX_BILD_BYTES, MAX_PDF_BYTES, MAX_JE_NACHRICHT, mb,
} from './anhaenge.js';
import * as L from './insel-logik.js';

const STYLE_ID = 'nos-insel';
const CHAT_KEY = 'insel-chat';
const VORLIEBEN_KEY = 'insel-vorlieben';
const TIMER_KEY = 'insel-timer';
const MAX_VERLAUF = 12;

/* ------------------------------------------------------------------ */
/* Symbole: 20x20, currentColor                                        */
/* ------------------------------------------------------------------ */

const G = {
  mikro: '<rect x="7.4" y="2.8" width="5.2" height="9.4" rx="2.6"/><path d="M4.8 9.8a5.2 5.2 0 0 0 10.4 0M10 15v2.4"/>',
  bildschirm: '<rect x="2.6" y="3.8" width="14.8" height="10" rx="1.8"/><path d="M7.2 16.6h5.6M10 13.8v2.8"/>',
  senden: '<path d="M10 15.6V4.6M5.4 9.2 10 4.6l4.6 4.6"/>',
  stopp: '<rect x="5.8" y="5.8" width="8.4" height="8.4" rx="1.8" fill="currentColor" stroke="none"/>',
  schweben: '<rect x="2.6" y="3.8" width="14.8" height="12.4" rx="2"/><rect x="9.6" y="9.4" width="5.8" height="4.6" rx="1" fill="currentColor" stroke="none"/>',
  zurueck: '<path d="M7.8 5.6 3.6 9.8l4.2 4.2"/><path d="M4.2 9.8h7.6a4.4 4.4 0 0 1 4.4 4.4v.8"/>',
  kleiner: '<path d="m5.8 12.4 4.2-4.2 4.2 4.2"/>',
  groesser: '<path d="m5.8 8.2 4.2 4.2 4.2-4.2"/>',
  zu: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  neu: '<path d="M10 4.4v11.2M4.4 10h11.2"/>',
  timer: '<circle cx="10" cy="11" r="6"/><path d="M10 8v3.2l2.2 1.4M8 2.8h4"/>',
  termin: '<rect x="3.2" y="4.4" width="13.6" height="12" rx="2"/><path d="M3.2 8.4h13.6M7 2.8v3M13 2.8v3"/>',
  vorlesen: '<path d="M3.4 8v4h3l4.2 3.2V4.8L6.4 8z"/><path d="M13.4 7.2a4 4 0 0 1 0 5.6M15.6 5.2a7 7 0 0 1 0 9.6"/>',
  kopieren: '<rect x="6.6" y="6.6" width="9.6" height="9.6" rx="1.8"/><path d="M13.4 6.6V5.2a1.6 1.6 0 0 0-1.6-1.6H5.2a1.6 1.6 0 0 0-1.6 1.6v6.6a1.6 1.6 0 0 0 1.6 1.6h1.4"/>',
  notiz: '<path d="M5.2 3.4h6.6l3.2 3.2v9.6a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 16.2V4.6a1.2 1.2 0 0 1 1.2-1.2z"/><path d="M7 9.2h6M7 12.2h4"/>',
  oeffnen: '<path d="M11.4 3.6h5v5M16.4 3.6l-7 7"/><path d="M14.6 11.6v3.2a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6V7a1.6 1.6 0 0 1 1.6-1.6h3.2"/>',
  ablage: '<rect x="4.8" y="3.8" width="10.4" height="13.2" rx="1.8"/><path d="M7.8 3.8V2.8h4.4v1M7.6 9h4.8M7.6 12h3.2"/>',
  freigabe: '<path d="M10 2.8 4.4 5v4.6c0 3.4 2.4 6 5.6 7.6 3.2-1.6 5.6-4.2 5.6-7.6V5z"/><path d="m7.6 10 1.8 1.8 3.2-3.4"/>',
  auge: '<path d="M2.4 10S5.2 4.6 10 4.6s7.6 5.4 7.6 5.4-2.8 5.4-7.6 5.4S2.4 10 2.4 10z"/><circle cx="10" cy="10" r="2.4"/>',
  hinweis: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.4M10 6.4v.2"/>',
};

/* ------------------------------------------------------------------ */
/* Aussehen. Die Insel ist schwarz, hell wie dunkel -- wie am iPhone.  */
/* ------------------------------------------------------------------ */

const INSEL_CSS = `
.insel-dock { flex: 0 1 auto; min-width: 0; display: flex; justify-content: center; margin-inline: auto; padding-inline: 8px; }
.topbar .insel-dock:not([hidden]) ~ .topbar__slot { margin-left: 0; }
.topbar .insel-dock:not([hidden]) ~ .topbar__right { margin-left: 0; }
.insel-dock, .insel, .insel-panel {
  --i-bg: #000;
  --i-flaeche: #161618;
  --i-flaeche-2: #222226;
  --i-fg: #f5f5f7;
  --i-leise: #a9a9b1;
  --i-rand: rgba(255, 255, 255, 0.12);
  --i-akzent: #6aa5ff;
  --i-ki: #2f7cf6;
  --i-rot: #ff6b5e;
  --i-orange: #f0ac4c;
  --i-gruen: #3ccf74;
  --i-h: 34px;
}
.insel { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
.insel__pille {
  position: relative;
  display: inline-flex; align-items: center; gap: 8px;
  height: var(--i-h); min-width: var(--i-h); max-width: 360px; margin: 0; padding: 0 14px 0 5px;
  font: inherit; font-size: var(--fs-sm); font-weight: 500; line-height: 1; color: var(--i-fg);
  background: var(--i-bg); border: 1px solid var(--i-rand); border-radius: 999px;
  box-shadow: 0 6px 18px -10px rgba(0, 0, 0, 0.7);
  cursor: pointer; overflow: hidden;
  transition: box-shadow var(--dur-3) var(--ease), border-color var(--dur-3) var(--ease);
}
.insel__pille:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.insel__pille[aria-expanded="true"] { visibility: hidden; }
.insel__glyph { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: var(--i-fg); background: var(--i-flaeche-2); }
.insel__glyph svg { width: 16px; height: 16px; }
.insel__text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.insel__pille[data-ton="ruhe"] .insel__text { color: var(--i-leise); font-weight: 400; }
.insel__neben { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 22px; margin-right: -8px; padding: 0 8px; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--i-fg); background: var(--i-flaeche-2); border-radius: 999px; }
.insel__neben[hidden] { display: none; }
.insel__punkt { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.insel [data-ton="ki"] .insel__glyph, .insel__pille[data-ton="ki"] .insel__glyph { color: #fff; background: var(--i-ki); }
.insel__pille[data-ton="rot"] .insel__glyph { color: #fff; background: var(--i-rot); }
.insel__pille[data-ton="orange"] .insel__glyph { color: #1a1205; background: var(--i-orange); }
.insel__pille[data-ton="gruen"] .insel__glyph { color: #04170b; background: var(--i-gruen); }
.insel__pille[data-ton="ki"] { border-color: rgba(106, 165, 255, 0.45); box-shadow: 0 0 0 1px rgba(47, 124, 246, 0.25), 0 8px 26px -12px rgba(47, 124, 246, 0.8); }
.insel__pille[data-klingelt="ja"] { animation: insel-puls 1.2s ease-in-out infinite; border-color: var(--i-orange); }
.insel__pille[data-art="teilen"] .insel__glyph, .insel__pille[data-art="hoeren"] .insel__glyph { animation: insel-atmen 1.6s ease-in-out infinite; }
.insel__neben[data-ton="rot"] { color: var(--i-rot); }
.insel__neben[data-ton="orange"] { color: var(--i-orange); }
.insel__neben[data-ton="ki"] { color: var(--i-akzent); }
.insel__neben[data-ton="gruen"] { color: var(--i-gruen); }
@keyframes insel-puls { 0%, 100% { box-shadow: 0 0 0 0 rgba(240, 172, 76, 0.55); } 50% { box-shadow: 0 0 0 7px rgba(240, 172, 76, 0); } }
@keyframes insel-atmen { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
/* Die Welle, solange die KI arbeitet. */
.insel__welle { display: inline-flex; align-items: center; gap: 2px; height: 14px; }
.insel__welle i { display: block; width: 3px; height: 100%; border-radius: 2px; background: currentColor; animation: insel-welle 0.9s ease-in-out infinite; transform-origin: center; }
.insel__welle i:nth-child(2) { animation-delay: -0.3s; }
.insel__welle i:nth-child(3) { animation-delay: -0.6s; }
@keyframes insel-welle { 0%, 100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
.insel__pille.is-schwebt .insel__text { color: var(--i-leise); }

/* Erinnerungen (lib/erinnerung.js) als Kapsel neben der Pille. */
.insel__kapseln { display: flex; align-items: center; gap: 6px; min-width: 0; }
.insel__kapseln:empty { display: none; }
.insel__kapseln .erin__card {
  display: grid; grid-template-columns: 3px minmax(0, 1fr) auto; align-items: center; gap: 8px;
  height: var(--i-h); min-width: 0; max-width: 420px; padding: 0 2px 0 10px;
  color: var(--i-fg); background: var(--i-bg); border: 1px solid var(--i-rand); border-radius: 999px; box-shadow: 0 6px 18px -10px rgba(0, 0, 0, 0.7);
  animation: insel-kapsel var(--dur-3) var(--ease);
  --fg-subtle: var(--i-leise);
}
.insel__kapseln .erin__bar { height: 14px; align-self: center; background: var(--i-ki); border-radius: 2px; }
.insel__kapseln .erin__text { flex-direction: row; align-items: center; gap: 8px; min-width: 0; min-height: 28px; color: var(--i-fg); }
.insel__kapseln .erin__wann { flex: none; color: var(--i-akzent); }
.insel__kapseln .erin__titel { flex: 0 1 auto; min-width: 0; font-size: var(--fs-sm); color: var(--i-fg); }
.insel__kapseln .erin__ort { flex: none; max-width: 35%; font-size: var(--fs-xs); color: var(--i-leise); }
.insel__kapseln .erin__ort::before { content: '· '; }
.insel__kapseln .erin__close { width: 28px; height: 28px; min-height: 0; color: var(--i-leise); border-radius: 50%; }
.insel__kapseln .erin__close:hover { color: var(--i-fg); background: var(--i-flaeche-2); }
.insel__wecker { display: inline-flex; align-items: center; gap: 8px; height: var(--i-h); padding: 0 4px 0 12px; color: #1a1205; background: var(--i-orange); border: 0; border-radius: 999px; font: inherit; font-size: var(--fs-sm); font-weight: 600; animation: insel-kapsel var(--dur-3) var(--ease); }
.insel__wecker button { height: 26px; padding: 0 10px; font: inherit; font-weight: 600; color: var(--i-fg); background: var(--i-bg); border: 0; border-radius: 999px; cursor: pointer; }
@keyframes insel-kapsel { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: none; } }

/* Aufgeklappt. */
.insel-panel {
  position: fixed; z-index: 90; top: 8px; left: 8px; width: min(460px, calc(100vw - 16px));
  display: flex; flex-direction: column; max-height: calc(100vh - 16px); overflow: hidden;
  color: var(--i-fg); background: var(--i-bg); border: 1px solid var(--i-rand); border-radius: 26px;
  box-shadow: 0 34px 90px -24px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.03);
  color-scheme: dark;
  font-size: var(--fs-base);
  /* Was in der Insel gezeichnet wird (Markdown, Knoepfe), sieht dunkel aus -- auch im hellen Design. */
  --fg: #f5f5f7; --fg-muted: #b9b9c1; --fg-subtle: #9a9aa3;
  --surface: #0b0b0c; --surface-2: #161618; --surface-3: #1f1f22; --surface-4: #2a2a2e;
  --border: rgba(255, 255, 255, 0.08); --border-strong: rgba(255, 255, 255, 0.16);
  --accent: #2f7cf6; --accent-hover: #4a8ef8; --accent-fg: #fff; --accent-text: #6aa5ff; --accent-soft: rgba(47, 124, 246, 0.18); --accent-ring: rgba(47, 124, 246, 0.5);
  --ok: #3ccf74; --warn: #f0ac4c; --danger: #ff6b5e; --danger-soft: rgba(255, 107, 94, 0.14);
}
.insel-panel[hidden] { display: none; }
.insel-panel :focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.insel-panel__kopf { display: flex; align-items: center; gap: 6px; padding: 10px 10px 6px 14px; }
.insel-panel__titel { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); font-weight: 600; letter-spacing: 0.01em; }
.insel-panel__titel .insel__glyph { width: 22px; height: 22px; }
.insel-panel__titel span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.insel-k { flex: none; display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; color: var(--i-leise); background: transparent; border: 0; border-radius: 50%; cursor: pointer; }
.insel-k:hover { color: var(--i-fg); background: var(--i-flaeche-2); }
.insel-k:disabled { opacity: 0.4; cursor: default; }
.insel-k svg { width: 18px; height: 18px; }
.insel-k.is-an { color: #fff; background: var(--i-rot); }
.insel-k.is-ki { color: #fff; background: var(--i-ki); }
.insel-k.is-ki:hover { background: #4a8ef8; }

.insel-live { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
.insel-live:empty { display: none; }
.insel-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; max-width: 100%; padding: 0 10px; font: inherit; font-size: var(--fs-sm); color: var(--i-fg); background: var(--i-flaeche); border: 1px solid var(--i-rand); border-radius: 999px; cursor: pointer; text-align: left; }
.insel-chip:hover { background: var(--i-flaeche-2); }
.insel-chip svg { width: 15px; height: 15px; flex: none; }
.insel-chip > span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.insel-chip[data-ton="orange"] svg { color: var(--i-orange); }
.insel-chip[data-ton="ki"] svg { color: var(--i-akzent); }
.insel-chip[data-ton="gruen"] svg { color: var(--i-gruen); }
.insel-chip[data-ton="rot"] svg { color: var(--i-rot); }
.insel-chip__zahl { font-variant-numeric: tabular-nums; color: var(--i-leise); }
.insel-chip__x { display: inline-grid; place-items: center; width: 22px; height: 22px; margin-right: -6px; padding: 0; color: var(--i-leise); background: transparent; border: 0; border-radius: 50%; cursor: pointer; }
.insel-chip__x:hover { color: var(--i-fg); background: var(--i-flaeche-2); }
.insel-chip__x svg { width: 13px; height: 13px; }

.insel-verlauf { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 16px 8px; overscroll-behavior: contain; }
.insel-leer { padding: 8px 2px 4px; }
.insel-leer__satz { margin: 0 0 12px; font-size: var(--fs-md); line-height: 1.45; color: var(--i-fg); }
.insel-leer__satz small { display: block; margin-top: 4px; font-size: var(--fs-sm); color: var(--i-leise); }
.insel-leer__wege { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.insel-leer__wege li { margin: 0; }
.insel-weg { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 6px 12px; font: inherit; font-size: var(--fs-sm); text-align: left; color: var(--i-fg); background: var(--i-flaeche); border: 1px solid transparent; border-radius: 14px; cursor: pointer; }
.insel-weg:hover { border-color: var(--i-rand); background: var(--i-flaeche-2); }
.insel-weg svg { width: 18px; height: 18px; flex: none; color: var(--i-akzent); }
.insel-weg small { display: block; color: var(--i-leise); font-size: var(--fs-xs); }
.insel-eintrag { padding: 8px 0 10px; border-top: 1px solid rgba(255, 255, 255, 0.06); }
.insel-eintrag:first-child { border-top: 0; }
.insel-frage { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 6px; font-size: var(--fs-sm); color: var(--i-leise); }
.insel-frage__text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
.insel-frage__bilder { display: flex; gap: 4px; flex: none; }
.insel-frage__bilder img { width: 44px; height: 30px; object-fit: cover; border-radius: 6px; border: 1px solid var(--i-rand); background: var(--i-flaeche); }
.insel-antwort { font-size: var(--fs-base); line-height: 1.55; color: var(--i-fg); overflow-wrap: anywhere; }
.insel-antwort > :last-child { margin-bottom: 0; }
.insel-antwort p { margin: 0 0 8px; }
.insel-antwort a { color: var(--i-akzent); text-decoration: underline; text-underline-offset: 2px; }
.insel-zustand { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: var(--fs-sm); color: var(--i-leise); }
.insel-zustand .insel__welle { color: var(--i-akzent); }
.insel-zustand.is-fehler { color: var(--i-rot); }
.insel-wirkung { display: grid; gap: 4px; margin-top: 8px; }
.insel-wirkung button { justify-content: flex-start; }
.insel-rueck { margin-top: 8px; padding: 10px; background: var(--i-flaeche); border-radius: 14px; }
.insel-rueck__frage { margin: 0 0 8px; font-size: var(--fs-sm); font-weight: 600; }
.insel-rueck__wahl { display: flex; flex-wrap: wrap; gap: 6px; }
.insel-rueck__wahl .insel-chip[aria-pressed="true"] { color: #fff; background: var(--i-ki); border-color: transparent; }
.insel-aktionen { display: flex; flex-wrap: wrap; gap: 2px; margin: 6px 0 0 -6px; }
.insel-aktion { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 8px; font: inherit; font-size: var(--fs-xs); color: var(--i-leise); background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
.insel-aktion:hover { color: var(--i-fg); background: var(--i-flaeche); }
.insel-aktion svg { width: 15px; height: 15px; }
.insel-aktion.is-an { color: var(--i-akzent); }

.insel-hinweis { display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 8px 10px; font-size: var(--fs-sm); color: var(--i-fg); background: var(--i-flaeche); border-radius: 12px; }
.insel-hinweis[hidden] { display: none; }
.insel-hinweis.is-fehler { color: #ffd2cd; background: rgba(255, 107, 94, 0.14); }
.insel-hinweis svg { width: 16px; height: 16px; flex: none; }
.insel-hinweis span { flex: 1 1 auto; min-width: 0; }
.insel-hinweis button { flex: none; height: 28px; padding: 0 10px; font: inherit; font-size: var(--fs-sm); font-weight: 600; color: var(--i-akzent); background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
.insel-hinweis button:hover { background: var(--i-flaeche-2); }

.insel-teilen { display: flex; align-items: center; gap: 10px; margin: 0 12px 8px; padding: 6px 6px 6px 6px; background: rgba(255, 107, 94, 0.1); border: 1px solid rgba(255, 107, 94, 0.35); border-radius: 14px; }
.insel-teilen[hidden] { display: none; }
.insel-teilen video { flex: none; width: 72px; height: 44px; object-fit: cover; background: #111; border-radius: 9px; }
.insel-teilen__text { flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); line-height: 1.35; }
.insel-teilen__text b { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.insel-teilen__text b::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--i-rot); animation: insel-atmen 1.6s ease-in-out infinite; }
.insel-teilen__text small { display: block; color: var(--i-leise); font-size: var(--fs-xs); }
.insel-teilen button { flex: none; height: 30px; padding: 0 12px; font: inherit; font-size: var(--fs-sm); font-weight: 600; color: #fff; background: var(--i-rot); border: 0; border-radius: 999px; cursor: pointer; }

.insel-vorlagen { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
.insel-vorlagen[hidden], .insel-timerwahl[hidden] { display: none; }
.insel-timerwahl { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 12px 8px; padding: 8px 10px; background: var(--i-flaeche); border-radius: 14px; font-size: var(--fs-sm); }
.insel-timerwahl small { flex-basis: 100%; color: var(--i-leise); font-size: var(--fs-xs); }
.insel-anhaenge { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 6px; }
.insel-anhaenge:empty { display: none; }
.insel-anhaenge img { width: 24px; height: 18px; object-fit: cover; border-radius: 4px; flex: none; }

.insel-eingabe { display: flex; align-items: flex-end; gap: 6px; margin: 0 10px 10px; padding: 6px 6px 6px 14px; background: var(--i-flaeche); border: 1px solid var(--i-rand); border-radius: 22px; }
.insel-eingabe.is-ablegen { border-color: var(--i-akzent); box-shadow: 0 0 0 3px rgba(47, 124, 246, 0.25); }
.insel-feld { flex: 1 1 auto; min-width: 0; min-height: 32px; max-height: 128px; margin: 0; padding: 6px 0; font: inherit; font-size: 15px; line-height: 1.4; color: var(--i-fg); background: transparent; border: 0; outline: none; resize: none; }
.insel-feld::placeholder { color: #8d8d96; }
.insel-panel .insel-feld:focus-visible { box-shadow: none; }
.insel-eingabe:focus-within { border-color: rgba(106, 165, 255, 0.55); }
.insel-eingabe .insel-k { width: 34px; height: 34px; }
.insel-eingabe .insel-k[hidden] { display: none; }
.insel-verbinden { display: flex; align-items: center; gap: 10px; margin: 0 12px 8px; padding: 10px 12px; font-size: var(--fs-sm); background: rgba(240, 172, 76, 0.12); border: 1px solid rgba(240, 172, 76, 0.35); border-radius: 14px; }
.insel-verbinden[hidden] { display: none; }
.insel-verbinden span { flex: 1 1 auto; }
.insel-verbinden button { flex: none; height: 30px; padding: 0 12px; font: inherit; font-weight: 600; color: #1a1205; background: var(--i-orange); border: 0; border-radius: 999px; cursor: pointer; }
.insel-unsichtbar { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Im schwebenden Fenster: die Zeile oben, das Gespraech darunter -- das ganze Fenster ist die Insel. */
body.insel-fenster { margin: 0; height: 100vh; overflow: hidden; display: flex; flex-direction: column; background: #000; color: #f5f5f7; }
body.insel-fenster .insel { flex: none; padding: 8px 10px 6px; justify-content: stretch; flex-wrap: wrap; }
body.insel-fenster .insel__pille { flex: 1 1 auto; max-width: none; }
body.insel-fenster .insel__pille[aria-expanded="true"] { visibility: visible; }
body.insel-fenster .insel__kapseln { flex: 1 1 100%; }
body.insel-fenster .insel__kapseln .erin__card { flex: 1 1 auto; max-width: none; }
body.insel-fenster .insel-panel { position: static; flex: 1 1 auto; width: auto; max-height: none; min-height: 0; border: 0; border-radius: 0; box-shadow: none; }
body.insel-fenster.is-klein .insel-panel { display: none; }
body.insel-fenster .insel-panel__kopf { padding-top: 4px; }

.insel__kurz { display: none; }
/* Wie viel Platz der Kopf hat, misst lib/insel.js (kopfMessen): voll (der ganze
   Satz), kompakt (nur die Kurzform, "4:59"), punkt (nur das Zeichen). Der
   Titel des Bereichs behaelt so immer seinen Platz. */
.insel-dock[data-stufe="kompakt"] .insel__text, .insel-dock[data-stufe="kompakt"] .insel__neben,
.insel-dock[data-stufe="punkt"] .insel__text, .insel-dock[data-stufe="punkt"] .insel__neben,
.insel-dock[data-stufe="punkt"] .insel__kurz { display: none; }
.insel-dock[data-stufe="kompakt"] .insel__kurz:not(:empty) { display: inline; padding-right: 7px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.insel-dock[data-stufe="kompakt"] .insel__pille, .insel-dock[data-stufe="punkt"] .insel__pille { padding-right: 5px; }
.insel-dock[data-stufe="punkt"] { padding-inline: 2px; }
/* Kein Platz neben der Pille (Telefon, oder eine Ansicht braucht den Kopf):
   Erinnerungen und ein klingelnder Timer fallen darunter herab, wie eine
   Mitteilung am iPhone. Gilt nur im Kopf -- im schwebenden Fenster steht die
   Zeile nicht im Dock. */
.insel-dock[data-kapseln="unten"] .insel { position: relative; }
.insel-dock[data-kapseln="unten"] .insel__kapseln { position: absolute; top: calc(100% + 14px); left: 50%; z-index: 40; flex-direction: column; align-items: stretch; width: min(340px, calc(100vw - 24px)); transform: translateX(-50%); }
.insel-dock[data-kapseln="unten"] .insel__kapseln .erin__card, .insel-dock[data-kapseln="unten"] .insel__wecker { max-width: none; box-shadow: 0 18px 40px -16px rgba(0, 0, 0, 0.8); }
@media (max-width: 560px) {
  body:not(.insel-fenster) .insel-dock { padding-inline: 0; }
}
@media (pointer: coarse) {
  .insel-dock, .insel, .insel-panel { --i-h: 44px; }
  .insel-k, .insel-eingabe .insel-k { width: 44px; height: 44px; }
  .insel-chip, .insel-aktion { min-height: 44px; }
  .insel-feld { font-size: 16px; }
  .insel__kapseln .erin__close { width: 40px; height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .insel__pille, .insel__wecker, .insel__kapseln .erin__card, .insel__welle i, .insel__glyph, .insel-teilen__text b::before { animation: none !important; transition: none !important; }
}
`;

function stilEinsetzen(doc = document) {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return;
  const node = doc.createElement('style');
  node.id = STYLE_ID;
  node.textContent = INSEL_CSS;
  doc.head.appendChild(node);
}

const reduziert = (w = window) => {
  try { return w.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
const finger = () => {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
};
const istMac = () => /Mac|iPhone|iPad/.test(String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''));

/** Was vorgelesen wird: ohne Codebloecke, ohne Bausteine-JSON, ohne Quellennummern. */
function vorleseText(md) {
  const ohne = String(markdownOhneUi(String(md || ''))).replace(/```[\s\S]*?```/g, '\n');
  return sprechText(extractPlain(ohne).replace(/\[\d{1,2}\]/g, ''));
}

/** Im schwebenden Fenster gilt die Adresse der Seite nicht: Bilder bekommen ihre volle Adresse. */
function absolut(src) {
  const s = String(src || '');
  if (/^(?:blob:|data:|https?:)/.test(s)) return s;
  try { return new URL(s, document.baseURI).href; } catch { return s; }
}

/** Ein Satz zu einem Fehler der Schnittstelle. */
function fehlerSatz(err) {
  if (!err) return 'unbekannter Fehler';
  if (err instanceof ApiError) return err.message || err.code || 'Fehler';
  return String(err.message || err);
}

function nichtVerbunden(err) {
  const code = String((err && err.code) || '');
  return /NICHT_VERBUNDEN|KEIN_SCHLUESSEL|SCHLUESSEL_FEHLT|OFFLINE|GATE/.test(code);
}

/* ------------------------------------------------------------------ */
/* Die Insel                                                            */
/* ------------------------------------------------------------------ */

/**
 * Einhaengen. Einmal pro Anwendung (web/app.js).
 * @param {object} ctx  die Grundausstattung der Schale (baseContext)
 * @returns {{stop:Function, erinnerungen:{einhaengen:Function, termine:Function}, navigieren:Function, oeffnen:Function, schliessen:Function}}
 */
export function starteInsel(ctx) {
  const leer = { stop() {}, erinnerungen: null, navigieren: (z) => ctx && ctx.navigate && ctx.navigate(z), oeffnen() {}, schliessen() {} };
  if (typeof document === 'undefined' || !ctx || !ctx.api) return leer;
  const kopf = document.getElementById('topbar');
  if (!kopf) return leer;
  stilEinsetzen();

  const { api, state, bus, navigate, toast } = ctx;
  const icons = ctx.icons || {};
  const vl = vorlesenMoeglich() ? seitenVorleser() : null;

  /** Der ganze Zustand an einer Stelle. */
  const z = {
    offen: false,
    modus: 'seite', // 'seite' | 'fenster'
    fenster: null,
    gross: true,
    chatId: null,
    zuletzt: null,
    geladen: false,
    verlauf: [],
    lauf: null,
    anhaenge: [],
    teilen: null,
    bildMit: true,
    sprechen: null,
    sprechText: '',
    gesprochen: false,
    nurAufnahme: false,
    kiInfo: null,
    timer: [],
    termine: [],
    termin: null,
    agenten: new Map(),
    ungesehen: null,
    hinweis: null,
    timerWahl: false,
    liest: false,
    markiert: '',
  };
  let lebt = true;
  let zaehler = 0;
  const offs = [];
  const uhren = new Map();

  /* -------------------------------------------------------- Merken */

  (function laden() {
    const c = lokal.lesenJson(CHAT_KEY, null);
    if (c && typeof c.id === 'string' && /^chat_[A-Za-z0-9_-]{4,80}$/.test(c.id)) {
      z.chatId = c.id;
      z.zuletzt = Number(c.zuletzt) || null;
    }
    const v = lokal.lesenJson(VORLIEBEN_KEY, {});
    if (v && v.bildMit === false) z.bildMit = false;
    try {
      z.timer = L.timerPruefen(JSON.parse(lokal.entwurf.lesen(TIMER_KEY) || '[]'), Date.now());
    } catch {
      z.timer = [];
    }
  }());

  function chatMerken() {
    if (z.chatId) lokal.schreibenJson(CHAT_KEY, { id: z.chatId, zuletzt: z.zuletzt || Date.now() });
    else lokal.loeschen(CHAT_KEY);
  }
  function vorliebenMerken() {
    lokal.schreibenJson(VORLIEBEN_KEY, { bildMit: z.bildMit });
  }
  function timerMerken() {
    const liste = z.timer.filter((t) => !t.klingelt).map(({ id, titel, dauerMs, endeMs }) => ({ id, titel, dauerMs, endeMs }));
    if (liste.length) lokal.entwurf.schreiben(TIMER_KEY, JSON.stringify(liste));
    else lokal.entwurf.loeschen(TIMER_KEY);
  }

  /* --------------------------------------------------------- Aufbau */

  const glyph = h('span.insel__glyph', { 'aria-hidden': 'true' });
  const zeileText = h('span.insel__text');
  // Auf dem Telefon steht statt des Satzes nur die Kurzform ("4:59", "12 Min") -- wie am iPhone.
  const kurzEl = h('span.insel__kurz', { 'aria-hidden': 'true' });
  const neben = h('span.insel__neben', { hidden: true, 'aria-hidden': 'true' });
  const pille = h('button.insel__pille', {
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'insel-panel',
    'aria-haspopup': 'dialog',
    title: `Insel (${L.kuerzelText(istMac())})`,
    onClick: () => pilleGedrueckt(),
  }, glyph, zeileText, kurzEl, neben);
  const kapseln = h('div.insel__kapseln');
  const zeile = h('div.insel', { role: 'group', 'aria-label': 'Insel' }, pille, kapseln);
  const schwebtKnopf = h('button.insel__pille.is-schwebt', {
    type: 'button',
    hidden: true,
    title: 'Die Insel zurück in Neural OS holen',
    onClick: () => zurueckHolen(),
  }, h('span.insel__glyph', { 'aria-hidden': 'true' }, icon(G.schweben)), h('span.insel__text', null, text('Insel schwebt · zurückholen')));
  const dock = h('div.insel-dock', null, zeile, schwebtKnopf);
  const ansage = h('span.insel-unsichtbar', { role: 'status', 'aria-live': 'polite' });
  dock.appendChild(ansage);

  // Panel
  const titelGlyph = h('span.insel__glyph', { 'aria-hidden': 'true' });
  const titelText = h('span', null, text('Insel'));
  const knopfNeu = kKnopf(G.neu, 'Neues Gespräch', () => neuesGespraech());
  const knopfSchweben = kKnopf(G.schweben, 'Über allen Fenstern – die Insel schwebt über anderen Programmen', () => schweben());
  const knopfKlein = kKnopf(G.kleiner, 'Kleiner', () => fensterGroesse(!z.gross));
  const knopfZurueck = kKnopf(G.zurueck, 'Zurück in Neural OS', () => zurueckHolen());
  const knopfZu = kKnopf(G.zu, 'Insel schließen', () => schliessen({ fokus: true }));
  const panelKopf = h('div.insel-panel__kopf', null,
    h('div.insel-panel__titel', null, titelGlyph, titelText),
    knopfNeu, knopfSchweben, knopfKlein, knopfZurueck, knopfZu);
  const live = h('div.insel-live');
  const verlaufEl = h('div.insel-verlauf', { 'aria-live': 'off' });
  const hinweisEl = h('div.insel-hinweis', { hidden: true, role: 'status' });
  const verbindenEl = h('div.insel-verbinden', { hidden: true },
    h('span', null, text('Deine KI ist noch nicht verbunden.')),
    h('button', { type: 'button', onClick: () => navigieren('#/chat') }, text('Verbinden')));
  const teilenVideo = h('video', { muted: true, playsinline: true, autoplay: true, 'aria-hidden': 'true' });
  teilenVideo.muted = true;
  const teilenSatz = h('small');
  const teilenWas = h('b');
  const teilenEl = h('div.insel-teilen', { hidden: true },
    teilenVideo,
    h('div.insel-teilen__text', null, teilenWas, teilenSatz),
    h('button', { type: 'button', onClick: () => teilenBeenden() }, text('Stopp')));
  const vorlagenEl = h('div.insel-vorlagen');
  const timerWahlEl = h('div.insel-timerwahl', { hidden: true });
  const anhangEl = h('div.insel-anhaenge');
  const feld = h('textarea.insel-feld', {
    rows: 1,
    placeholder: 'Frag deine KI …',
    'aria-label': 'Frage an deine KI',
    enterkeyhint: 'send',
  });
  const knopfMikro = kKnopf(G.mikro, 'Sprechen', () => sprechenUmschalten());
  const knopfTeilen = kKnopf(G.bildschirm, 'Bildschirm zeigen – ich sehe mit', () => teilenUmschalten());
  const knopfSenden = kKnopf(G.senden, 'Senden', () => absenden());
  knopfSenden.classList.add('is-ki');
  const eingabe = h('form.insel-eingabe', {
    onSubmit: (ev) => {
      ev.preventDefault();
      absenden();
    },
  }, feld, knopfMikro, knopfTeilen, knopfSenden);
  const panel = h('section.insel-panel#insel-panel', {
    role: 'dialog',
    'aria-label': 'Insel – frag deine KI',
    hidden: true,
  }, panelKopf, live, verlaufEl, hinweisEl, verbindenEl, teilenEl, timerWahlEl, vorlagenEl, anhangEl, eingabe);

  function kKnopf(glyphe, label, run) {
    return h('button.insel-k', { type: 'button', 'aria-label': label, title: label, onClick: (ev) => { ev.stopPropagation(); run(ev); } }, icon(glyphe));
  }

  // In den Kopf: zwischen Titel und den Knoepfen rechts.
  const slot = kopf.querySelector('.topbar__slot') || kopf.querySelector('.topbar__right');
  if (slot) kopf.insertBefore(dock, slot);
  else kopf.appendChild(dock);
  document.body.appendChild(panel);

  /* ----------------------------------------------------- Zeichnen */

  let geplant = null;
  let geplantIn = null;
  function planen() {
    if (geplant !== null || !lebt) return;
    const w = hostFenster();
    geplantIn = w;
    try {
      geplant = w.requestAnimationFrame(() => { geplant = null; zeichnen(); });
    } catch {
      geplant = setTimeout(() => { geplant = null; zeichnen(); }, 30);
    }
  }
  function sofort() {
    if (geplant !== null) {
      try { geplantIn.cancelAnimationFrame(geplant); } catch { /* schon weg */ }
      clearTimeout(geplant);
      geplant = null;
    }
    zeichnen();
  }

  function hostFenster() {
    return z.modus === 'fenster' && z.fenster && !z.fenster.closed ? z.fenster : window;
  }

  function aktivitaeten(jetzt) {
    const out = [];
    for (const t of z.timer) {
      if (t.klingelt) out.push({ art: 'wecker', id: t.id, titel: t.titel, zeit: t.endeMs });
      else out.push({ art: 'timer', id: t.id, titel: t.titel, endeMs: t.endeMs, zeit: -t.endeMs });
    }
    if (z.sprechen) out.push({ art: 'hoeren', zwischen: z.sprechText, zeit: z.sprechen.seit });
    const letzte = z.verlauf[z.verlauf.length - 1];
    const offeneFrage = letzte && letzte.antwort.rueckfragen.find((f) => f.zustand === 'offen');
    if (z.lauf) {
      out.push({ art: 'antwort', phase: z.lauf.phase, schritt: z.lauf.schritt, vorschau: z.lauf.eintrag ? z.lauf.eintrag.antwort.text : '', zeit: z.lauf.seit });
    } else if (offeneFrage) {
      out.push({ art: 'rueckfrage', frage: offeneFrage.frage, zeit: letzte.zeit });
    }
    if (z.ungesehen) out.push({ art: 'neu', vorschau: z.ungesehen.vorschau, zeit: z.ungesehen.zeit });
    // Ein Hinweis steht im Panel; nur im kleinen schwebenden Fenster (kein Panel, keine Meldungen der Seite) in der Pille.
    if (z.hinweis && z.modus === 'fenster' && !z.gross && jetzt - z.hinweis.zeit < 8000) out.push({ art: 'fehler', satz: z.hinweis.satz, zeit: z.hinweis.zeit, ton: z.hinweis.ton });
    if (z.teilen) out.push({ art: 'teilen', zeit: z.teilen.seit });
    if (z.liest) out.push({ art: 'vorlesen', zeit: 0 });
    if (z.termin) out.push({ art: 'termin', ...z.termin, zeit: -z.termin.startMs });
    const freigaben = Array.isArray(state.get('approvals')) ? state.get('approvals').length : 0;
    if (freigaben) out.push({ art: 'freigabe', anzahl: freigaben, zeit: 0 });
    for (const a of z.agenten.values()) {
      if (a.sicht !== 'laeuft' || (a.chatId && a.chatId === z.chatId)) continue;
      if (jetzt - (a.beginn || 0) < 1500) continue;
      out.push({ art: 'agent', titel: a.titel, runId: a.runId, zeit: a.zeit });
    }
    return out;
  }

  /** Termine mit Erinnerungskapsel -- und solche, deren Kapsel schon weg ist: weggeklickt heisst erledigt. */
  const kapselTermine = new Set();
  function kapselIds() {
    return kapselTermine;
  }

  function zeichnen() {
    if (!lebt) return;
    const jetzt = Date.now();
    for (const a of z.agenten.values()) a.sicht = zustandVon(a, jetzt);
    z.termin = L.naechsterTermin(z.termine, jetzt, kapselIds());
    const liste = aktivitaeten(jetzt);
    // Ein klingelnder Timer steht als Kapsel mit [Aus] neben der Pille; die Pille pulsiert nur.
    const klingelt = liste.some((a) => a.art === 'wecker');
    const { haupt, neben: zweite, alle } = L.kompakt(liste.filter((a) => a.art !== 'wecker'));
    pille.dataset.klingelt = klingelt ? 'ja' : 'nein';
    zeichnePille(haupt, zweite, jetzt);
    zeichneWecker();
    if (z.offen || z.modus === 'fenster') {
      zeichnePanelKopf(haupt, jetzt);
      zeichneLive(alle, jetzt);
      zeichneVerlauf();
      zeichneHinweis();
      zeichneTeilen();
      zeichneVorlagen();
      zeichneAnhaenge();
      zeichneEingabe();
    }
    const k = state.get('claude');
    verbindenEl.hidden = !(k && k.bekannt && k.verbunden === false);
  }

  function glyphFuer(a) {
    if (!a) return icon(icons.brand || G.auge);
    switch (a.art) {
      case 'antwort': return h('span.insel__welle', null, h('i'), h('i'), h('i'));
      case 'rueckfrage': return icon(G.hinweis);
      case 'neu': return icon(icons.brand || G.auge);
      case 'fehler': return icon(G.hinweis);
      case 'hoeren': return icon(G.mikro);
      case 'teilen': return icon(G.auge);
      case 'vorlesen': return icon(G.vorlesen);
      case 'timer': case 'wecker': return icon(G.timer);
      case 'termin': return icon(G.termin);
      case 'freigabe': return icon(G.freigabe);
      case 'agent': return icon(icons.agents || G.auge);
      default: return icon(icons.brand || G.auge);
    }
  }

  let pilleSchluessel = '';
  let ansageZuletzt = '';
  function zeichnePille(haupt, zweite, jetzt) {
    const k = state.get('claude');
    let satz;
    let ton;
    if (haupt) {
      const t = L.aktivitaetText(haupt, jetzt);
      satz = t.text;
      ton = haupt.art === 'fehler' && haupt.ton !== 'fehler' ? 'ki' : t.ton;
    } else {
      satz = k && k.bekannt && k.verbunden === false ? 'KI nicht verbunden' : 'Frag mich …';
      ton = 'ruhe';
    }
    const art = haupt ? haupt.art : 'ruhe';
    const schluessel = `${art}|${haupt && haupt.art === 'antwort' ? '' : ''}`;
    if (schluessel !== pilleSchluessel) {
      pilleSchluessel = schluessel;
      clear(glyph);
      glyph.appendChild(glyphFuer(haupt));
    }
    if (zeileText.textContent !== satz) {
      clear(zeileText);
      zeileText.appendChild(text(satz));
    }
    const kurz = haupt ? L.aktivitaetText(haupt, jetzt).kurz : '';
    if (kurzEl.textContent !== kurz) {
      clear(kurzEl);
      if (kurz) kurzEl.appendChild(text(kurz));
    }
    pille.dataset.ton = ton;
    pille.dataset.art = art;
    const tz = zweite ? L.aktivitaetText(zweite, jetzt) : null;
    neben.hidden = !tz;
    if (tz) {
      neben.dataset.ton = tz.ton;
      const inhalt = tz.kurz || '';
      const alt = neben.dataset.inhalt;
      if (alt !== `${zweite.art}|${inhalt}`) {
        neben.dataset.inhalt = `${zweite.art}|${inhalt}`;
        clear(neben);
        neben.appendChild(h('span.insel__punkt'));
        if (inhalt) neben.appendChild(text(inhalt));
      }
    }
    const label = `Insel: ${satz}${tz && tz.text ? ` · ${tz.text}` : ''}. ${z.offen ? 'Schließen' : 'Öffnen'}`;
    if (pille.getAttribute('aria-label') !== label) pille.setAttribute('aria-label', label);
    // Nur ein Wechsel der Lage wird angesagt, nicht jede Sekunde eines Timers.
    const ansagen = haupt && ['wecker', 'neu', 'fehler', 'rueckfrage'].includes(haupt.art) ? satz : '';
    if (ansagen !== ansageZuletzt) {
      clear(ansage);
      if (ansagen) ansage.appendChild(text(ansagen));
    }
    ansageZuletzt = ansagen;
  }

  const weckerKnoten = new Map();
  function zeichneWecker() {
    const klingeln = z.timer.filter((t) => t.klingelt);
    for (const [id, node] of weckerKnoten) {
      if (!klingeln.some((t) => t.id === id)) {
        node.remove();
        weckerKnoten.delete(id);
      }
    }
    for (const t of klingeln) {
      if (weckerKnoten.has(t.id)) continue;
      const node = h('div.insel__wecker', { role: 'alert' },
        icon(G.timer),
        h('span', null, text(`${t.titel} ist fertig`)),
        h('button', { type: 'button', onClick: () => timerAus(t.id) }, text('Aus')));
      weckerKnoten.set(t.id, node);
      kapseln.prepend(node);
    }
  }

  function zeichnePanelKopf(haupt, jetzt) {
    const eigen = haupt && ['antwort', 'hoeren'].includes(haupt.art) ? haupt : null;
    const gKey = eigen ? eigen.art : 'ruhe';
    if (titelGlyph.dataset.art !== gKey) {
      titelGlyph.dataset.art = gKey;
      clear(titelGlyph);
      titelGlyph.appendChild(glyphFuer(eigen));
    }
    titelGlyph.parentNode.dataset.ton = eigen ? 'ki' : 'ruhe';
    const satz = haupt && ['antwort', 'hoeren'].includes(haupt.art) ? L.aktivitaetText(haupt, jetzt).text : 'Insel';
    if (titelText.textContent !== satz) {
      clear(titelText);
      titelText.appendChild(text(satz));
    }
    const fenster = z.modus === 'fenster';
    knopfNeu.hidden = !z.verlauf.length || !!z.lauf;
    knopfSchweben.hidden = fenster || !L.schwebenMoeglich(window);
    knopfKlein.hidden = !fenster;
    knopfZurueck.hidden = !fenster;
    knopfZu.hidden = fenster;
    if (fenster) {
      const label = z.gross ? 'Kleiner' : 'Größer';
      if (knopfKlein.getAttribute('aria-label') !== label) {
        knopfKlein.setAttribute('aria-label', label);
        knopfKlein.title = label;
        clear(knopfKlein);
        knopfKlein.appendChild(icon(z.gross ? G.kleiner : G.groesser));
      }
    }
  }

  /**
   * Die Live-Zeile im Panel. Jede Sekunde neu gerechnet, aber nur neu
   * GEBAUT, wenn sich etwas anderes als eine Zahl aendert -- sonst verloere
   * ein Knopf, auf dem gerade der Fokus steht, ihn jede Sekunde.
   */
  const liveKnoten = new Map();
  function zeichneLive(alle, jetzt) {
    const zeigen = [];
    for (const a of alle) {
      const t = L.aktivitaetText(a, jetzt);
      if (a.art === 'timer') zeigen.push({ key: `timer|${a.id}|${a.titel}`, a, zahl: L.uhrText(a.endeMs - jetzt) });
      else if (a.art === 'termin') zeigen.push({ key: `termin|${a.id}|${a.occurrence || ''}|${a.titel}|${a.ort}`, a, zahl: [t.text, a.ort].filter(Boolean).join(' · ') });
      else if (a.art === 'freigabe') zeigen.push({ key: `freigabe|${a.anzahl}`, a, zahl: t.text });
      else if (a.art === 'agent') zeigen.push({ key: `agent|${a.runId}|${t.text}`, a, zahl: t.text });
      else if (a.art === 'vorlesen') zeigen.push({ key: 'vorlesen', a, zahl: 'Liest vor' });
    }
    if (z.timer.some((t) => !t.klingelt) && typeof window.Notification === 'function' && window.Notification.permission === 'default') {
      zeigen.push({ key: 'mitteilung', a: { art: 'mitteilung' }, zahl: 'Auch als Mitteilung' });
    }
    const schluessel = zeigen.map((x) => x.key).join('\n');
    if (live.dataset.key !== schluessel) {
      live.dataset.key = schluessel;
      clear(live);
      liveKnoten.clear();
      for (const x of zeigen) {
        const zahl = h('span', null, text(x.zahl));
        liveKnoten.set(x.key, zahl);
        live.appendChild(liveChip(x.a, zahl));
      }
      return;
    }
    for (const x of zeigen) {
      const node = liveKnoten.get(x.key);
      if (node && node.textContent !== x.zahl) {
        clear(node);
        node.appendChild(text(x.zahl));
      }
    }
  }

  function liveChip(a, zahl) {
    switch (a.art) {
      case 'timer':
        return h('span.insel-chip', { 'data-ton': 'orange' }, icon(G.timer),
          h('span', null, text(a.titel)), h('span.insel-chip__zahl', null, zahl),
          h('button.insel-chip__x', { type: 'button', 'aria-label': `Timer „${a.titel}“ beenden`, title: 'Beenden', onClick: () => timerAus(a.id) }, icon(G.zu)));
      case 'termin':
        return h('button.insel-chip', {
          type: 'button',
          'data-ton': 'ki',
          onClick: () => navigieren(`#/kalender?id=${encodeURIComponent(a.id)}${a.occurrence ? `&am=${encodeURIComponent(a.occurrence)}` : ''}`),
        }, icon(G.termin), zahl);
      case 'freigabe':
        return h('button.insel-chip', { type: 'button', 'data-ton': 'orange', onClick: () => navigieren('#/agents') }, icon(G.freigabe), zahl);
      case 'agent':
        return h('button.insel-chip', {
          type: 'button',
          'data-ton': 'gruen',
          onClick: () => navigieren(a.runId ? `#/agents?id=${encodeURIComponent(a.runId)}` : '#/agents'),
        }, icon(icons.agents || G.auge), zahl);
      case 'vorlesen':
        return h('span.insel-chip', { 'data-ton': 'ki' }, icon(G.vorlesen), zahl,
          h('button.insel-chip__x', { type: 'button', 'aria-label': 'Vorlesen beenden', title: 'Beenden', onClick: () => { if (vl) vl.stopp(); } }, icon(G.zu)));
      default:
        return h('button.insel-chip', {
          type: 'button',
          onClick: async () => {
            try { await window.Notification.requestPermission(); } catch { /* dann eben nicht */ }
            live.dataset.key = '';
            planen();
          },
        }, icon(G.hinweis), zahl);
    }
  }

  /* ------------------------------------------------------- Verlauf */

  function zeichneVerlauf() {
    if (!z.verlauf.length) {
      if (!verlaufEl.querySelector('.insel-leer')) {
        clear(verlaufEl);
        verlaufEl.appendChild(leerZustand());
      }
      return;
    }
    const leerEl = verlaufEl.querySelector('.insel-leer');
    if (leerEl) leerEl.remove();
    const unten = verlaufEl.scrollHeight - verlaufEl.scrollTop - verlaufEl.clientHeight < 48;
    const ids = new Set(z.verlauf.map((e) => e.id));
    for (const node of [...verlaufEl.children]) if (!ids.has(node.dataset.eintrag)) node.remove();
    for (const e of z.verlauf) {
      if (!e._el) e._el = eintragAufbauen(e);
      if (e._el.parentNode !== verlaufEl) verlaufEl.appendChild(e._el);
      eintragAktualisieren(e);
    }
    if (unten && (!z.lauf || z.lauf.folgen !== false)) verlaufEl.scrollTop = verlaufEl.scrollHeight;
  }

  function leerZustand() {
    const wege = [];
    if (L.teilenMoeglich(window)) {
      wege.push(weg(G.bildschirm, 'Bildschirm zeigen', 'Dann sehe ich, was du in einem anderen Programm vor dir hast.', () => teilenStarten()));
    }
    if (L.schwebenMoeglich(window)) {
      wege.push(weg(G.schweben, 'Über allen Fenstern', 'Die Insel schwebt über jedem Programm.', () => schweben()));
    }
    wege.push(weg(G.ablage, 'Etwas kopieren, dann „Erklär mir das“', 'Text oder Bild aus jedem Programm – Strg+C genügt.', () => vorlageNutzen(L.VORLAGEN.find((v) => v.id === 'erklaeren'))));
    wege.push(weg(G.timer, '„Timer 5 min“', 'Timer, Notizen und Erinnerungen gehen sofort.', () => { z.timerWahl = true; planen(); }));
    return h('div.insel-leer', null,
      h('p.insel-leer__satz', null, text('Frag mich etwas – auch über das, was du gerade in einem anderen Programm siehst.'),
        h('small', null, text('Ich kenne deine Notizen, Termine und Projekte und kann dort für dich eintragen.'))),
      h('ul.insel-leer__wege', null, ...wege.map((w) => h('li', null, w))));
  }

  function weg(glyphe, titel, satz, run) {
    return h('button.insel-weg', { type: 'button', onClick: () => run() }, icon(glyphe),
      h('span', null, text(titel), h('small', null, text(satz))));
  }

  function eintragAufbauen(e) {
    const el = h('article.insel-eintrag', { dataset: { eintrag: e.id } });
    e._frage = h('div.insel-frage');
    e._antwort = h('div.insel-antwort');
    e._rueck = h('div');
    e._zustand = h('div.insel-zustand', { hidden: true });
    e._wirkung = h('div.insel-wirkung', { hidden: true });
    e._aktionen = h('div.insel-aktionen', { hidden: true });
    el.append(e._frage, e._antwort, e._rueck, e._zustand, e._wirkung, e._aktionen);
    // Verweise in der Antwort: innere ("#/…") fuehren in Neural OS, nie im schwebenden Fenster.
    el.addEventListener('click', (ev) => {
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#/')) {
        ev.preventDefault();
        navigieren(href);
      } else if (!a.target) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
    return el;
  }

  function eintragAktualisieren(e) {
    const a = e.antwort;
    // Die Frage (und das Bild vom Bildschirm, sobald es da ist)
    const fKey = `${e.frage}|${(e.bilder || []).map((b) => b.src).join('|')}`;
    if (e._fKey !== fKey) {
      e._fKey = fKey;
      clear(e._frage);
      if (e.bilder && e.bilder.length) {
        e._frage.appendChild(h('span.insel-frage__bilder', null, ...e.bilder.slice(0, 3).map((b) => h('img', { src: absolut(b.src), alt: b.name || 'Bild', loading: 'lazy' }))));
      }
      e._frage.appendChild(h('span.insel-frage__text', null, text(e.frage || (e.bilder && e.bilder.length ? 'Bild' : ''))));
    }
    if (e._quelle !== a.text) {
      e._quelle = a.text;
      const o = L.ohneOffenenBaustein(a.text);
      e._baustein = o.baustein;
      e._md = markdownOhneUi(o.text);
    }
    const baustein = e._baustein;
    const zuZeigen = e._md;
    if (e._gezeichnet !== zuZeigen) {
      e._gezeichnet = zuZeigen;
      clear(e._antwort);
      if (zuZeigen.trim()) e._antwort.appendChild(renderMarkdown(zuZeigen, { highlight: false, copy: false }));
    }
    // Zustand unter der Antwort
    const laeuft = z.lauf && z.lauf.eintrag === e;
    let satz = '';
    let fehler = false;
    if (laeuft) {
      const t = L.aktivitaetText({ art: 'antwort', phase: z.lauf.phase, schritt: z.lauf.schritt, vorschau: '' }, Date.now());
      satz = baustein ? 'Baut einen Baustein …' : (z.lauf.phase === 'schreibt' ? '' : t.text);
    } else if (a.fehler) {
      satz = a.fehler;
      fehler = true;
    } else if (a.status === 'aborted') {
      satz = 'Abgebrochen.';
    } else if (a.status === 'unterbrochen') {
      satz = 'Die Verbindung brach ab – was ankam, steht oben.';
      fehler = true;
    }
    const zKey = `${laeuft ? 'l' : ''}|${satz}|${fehler}`;
    if (e._zKey !== zKey) {
      e._zKey = zKey;
      clear(e._zustand);
      e._zustand.hidden = !satz && !laeuft;
      e._zustand.classList.toggle('is-fehler', fehler);
      if (laeuft) e._zustand.appendChild(h('span.insel__welle', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
      if (satz) e._zustand.appendChild(h('span', null, text(satz)));
      if (fehler && a.nichtVerbunden) {
        e._zustand.appendChild(h('button.insel-aktion.is-an', { type: 'button', onClick: () => navigieren('#/chat') }, text('Verbinden')));
      }
    }
    // Rueckfragen
    const rKey = JSON.stringify(a.rueckfragen.map((f) => [f.id, f.zustand, f.antwort, (f.gewaehlt || []).join('|')]));
    if (e._rKey !== rKey) {
      e._rKey = rKey;
      clear(e._rueck);
      for (const f of a.rueckfragen) {
        if (f.zustand !== 'offen') continue;
        const wahl = h('div.insel-rueck__wahl');
        for (const o of f.optionen) {
          const an = (f.gewaehlt || []).includes(o);
          wahl.appendChild(h('button.insel-chip', {
            type: 'button',
            'aria-pressed': f.mehrfach ? String(an) : null,
            disabled: !!z.lauf,
            onClick: () => {
              if (f.mehrfach) {
                const g = new Set(f.gewaehlt || []);
                if (g.has(o)) g.delete(o);
                else g.add(o);
                f.gewaehlt = [...g];
                planen();
                return;
              }
              rueckfrageBeantworten(e, f, o);
            },
          }, h('span', null, text(o))));
        }
        if (f.mehrfach) {
          wahl.appendChild(h('button.insel-chip', {
            type: 'button',
            disabled: !(f.gewaehlt || []).length || !!z.lauf,
            onClick: () => rueckfrageBeantworten(e, f, [...(f.gewaehlt || [])]),
          }, h('span', null, text('Fertig'))));
        }
        e._rueck.appendChild(h('div.insel-rueck', null, h('p.insel-rueck__frage', null, text(f.frage)), wahl));
      }
    }
    // Was die KI angelegt hat
    const zeilen = wirkungZeilen(a.wirkung);
    const wKey = JSON.stringify(zeilen.map((w) => [w.id, w.label, w.detail]));
    if (e._wKey !== wKey) {
      e._wKey = wKey;
      clear(e._wirkung);
      e._wirkung.hidden = !zeilen.length;
      for (const w of zeilen) {
        const inhalt = [icon(w.typ === 'event' ? G.termin : G.notiz), h('span', null, text(`${w.label}${w.detail ? ` · ${w.detail}` : ''}`))];
        e._wirkung.appendChild(w.href
          ? h('button.insel-chip', { type: 'button', 'data-ton': 'gruen', onClick: () => navigieren(w.href) }, ...inhalt)
          : h('span.insel-chip', { 'data-ton': 'gruen' }, ...inhalt));
      }
    }
    // Aktionen, sobald die Antwort steht
    const fertig = !laeuft && a.text.trim() && a.status !== 'laeuft';
    const liestDiese = z.liest && vl && vl.zustand().id === `insel:${e.id}`;
    const aKey = `${fertig}|${liestDiese}|${!!e.notizId}|${z.chatId}`;
    if (e._aKey !== aKey) {
      e._aKey = aKey;
      clear(e._aktionen);
      e._aktionen.hidden = !fertig;
      if (fertig) {
        if (vl) {
          e._aktionen.appendChild(aktion(G.vorlesen, liestDiese ? 'Stopp' : 'Vorlesen', () => vorlesen(e), liestDiese));
        }
        e._aktionen.appendChild(aktion(G.kopieren, 'Kopieren', () => kopieren(markdownOhneUi(a.text))));
        e._aktionen.appendChild(aktion(G.notiz, e.notizId ? 'Notiz öffnen' : 'Als Notiz', () => alsNotiz(e), !!e.notizId));
        if (e.chatId || z.chatId) e._aktionen.appendChild(aktion(G.oeffnen, 'Im Chat öffnen', () => navigieren(`#/chat?id=${encodeURIComponent(e.chatId || z.chatId)}`)));
      }
    }
  }

  function aktion(glyphe, label, run, an = false) {
    return h('button.insel-aktion', { type: 'button', class: an ? 'is-an' : '', onClick: () => run() }, icon(glyphe), h('span', null, text(label)));
  }

  function zeichneHinweis() {
    const hw = z.hinweis;
    const zeigen = hw && Date.now() - hw.zeit < (hw.dauer || 9000);
    hinweisEl.hidden = !zeigen;
    const key = zeigen ? `${hw.zeit}|${hw.satz}` : '';
    if (hinweisEl.dataset.key === key) return;
    hinweisEl.dataset.key = key;
    clear(hinweisEl);
    if (!zeigen) return;
    hinweisEl.classList.toggle('is-fehler', hw.ton === 'fehler');
    hinweisEl.append(icon(hw.ton === 'fehler' ? G.hinweis : G.hinweis), h('span', null, text(hw.satz)));
    if (hw.aktion) hinweisEl.appendChild(h('button', { type: 'button', onClick: () => hw.aktion.run() }, text(hw.aktion.label)));
  }

  function zeichneTeilen() {
    const t = z.teilen;
    teilenEl.hidden = !t;
    if (!t) return;
    const anbieter = (state.get('claude') || {}).name || 'deine KI';
    const satzWas = `Ich sehe ${t.was}`;
    if (teilenWas.textContent !== satzWas) {
      clear(teilenWas);
      teilenWas.appendChild(text(satzWas));
    }
    const satz = z.bildMit
      ? `Mit jeder Frage geht ein Bild davon an ${anbieter}.`
      : 'Bilder gehen gerade nicht mit (unten wieder einschalten).';
    if (teilenSatz.textContent !== satz) {
      clear(teilenSatz);
      teilenSatz.appendChild(text(satz));
    }
    if (teilenVideo.srcObject !== t.strom) {
      teilenVideo.srcObject = t.strom;
      teilenVideo.play().catch(() => { /* ein stilles Video braucht keinen Ton */ });
    }
  }

  function zeichneVorlagen() {
    const zeigen = !z.lauf && !z.sprechen;
    vorlagenEl.hidden = !zeigen;
    timerWahlEl.hidden = !z.timerWahl || !zeigen;
    const bild = !!z.teilen || z.anhaenge.some((a) => a.art === 'bild');
    const key = `${zeigen}|${bild}|${z.timerWahl}`;
    if (vorlagenEl.dataset.key === key) return;
    vorlagenEl.dataset.key = key;
    clear(vorlagenEl);
    for (const v of L.VORLAGEN) {
      if (v.braucht === 'bild' && !bild) continue;
      vorlagenEl.appendChild(h('button.insel-chip', { type: 'button', onClick: () => vorlageNutzen(v) }, h('span', null, text(v.label))));
    }
    vorlagenEl.appendChild(h('button.insel-chip', {
      type: 'button',
      'aria-expanded': String(z.timerWahl),
      onClick: () => { z.timerWahl = !z.timerWahl; planen(); },
    }, icon(G.timer), h('span', null, text('Timer'))));
    vorlagenEl.appendChild(h('button.insel-chip', { type: 'button', onClick: () => ausZwischenablage() }, icon(G.ablage), h('span', null, text('Einfügen'))));
    clear(timerWahlEl);
    if (z.timerWahl) {
      timerWahlEl.appendChild(h('span', null, text('Timer:')));
      for (const min of L.TIMER_VORGABEN) {
        timerWahlEl.appendChild(h('button.insel-chip', { type: 'button', onClick: () => { z.timerWahl = false; timerStarten(min * 60000, ''); } }, h('span', null, text(`${min} Min`))));
      }
      timerWahlEl.appendChild(h('small', null, text('Oder schreib zum Beispiel „Timer 8 min Nudeln“.')));
    }
  }

  function zeichneAnhaenge() {
    const key = JSON.stringify([z.anhaenge.map((a) => [a.id, a.name]), !!z.teilen, z.bildMit]);
    if (anhangEl.dataset.key === key) return;
    anhangEl.dataset.key = key;
    clear(anhangEl);
    if (z.teilen) {
      anhangEl.appendChild(h('button.insel-chip', {
        type: 'button',
        'data-ton': z.bildMit ? 'rot' : null,
        'aria-pressed': String(z.bildMit),
        title: z.bildMit ? 'Antippen: die nächste Frage ohne Bild' : 'Antippen: wieder mit Bild',
        onClick: () => { z.bildMit = !z.bildMit; vorliebenMerken(); planen(); },
      }, icon(G.bildschirm), h('span', null, text(z.bildMit ? 'Bildschirm geht mit' : 'Ohne Bild vom Bildschirm'))));
    }
    for (const a of z.anhaenge) {
      const was = a.art === 'text' ? `${a.name} · ${a.text.length.toLocaleString('de-DE')} Zeichen` : a.name;
      anhangEl.appendChild(h('span.insel-chip', null,
        a.art === 'bild' && a.url ? h('img', { src: a.url, alt: '' }) : icon(a.art === 'text' ? G.ablage : G.notiz),
        h('span', null, text(was)),
        h('button.insel-chip__x', { type: 'button', 'aria-label': `„${a.name}“ entfernen`, title: 'Entfernen', onClick: () => anhangWeg(a) }, icon(G.zu))));
    }
  }

  function zeichneEingabe() {
    const weg = sprechWegJetzt();
    knopfMikro.hidden = !z.sprechen && !weg;
    knopfMikro.classList.toggle('is-an', !!z.sprechen);
    const mLabel = z.sprechen ? 'Fertig gesprochen – senden' : 'Sprechen';
    if (knopfMikro.getAttribute('aria-label') !== mLabel) {
      knopfMikro.setAttribute('aria-label', mLabel);
      knopfMikro.title = mLabel;
    }
    knopfTeilen.hidden = !L.teilenMoeglich(window);
    knopfTeilen.classList.toggle('is-an', !!z.teilen);
    const tLabel = z.teilen ? 'Bildschirm nicht mehr zeigen' : 'Bildschirm zeigen – ich sehe mit';
    if (knopfTeilen.getAttribute('aria-label') !== tLabel) {
      knopfTeilen.setAttribute('aria-label', tLabel);
      knopfTeilen.title = tLabel;
    }
    const stoppt = !!z.lauf;
    const sLabel = stoppt ? 'Stopp' : 'Senden';
    if (knopfSenden.getAttribute('aria-label') !== sLabel) {
      knopfSenden.setAttribute('aria-label', sLabel);
      knopfSenden.title = sLabel;
      clear(knopfSenden);
      knopfSenden.appendChild(icon(stoppt ? G.stopp : G.senden));
    }
    const platzhalter = z.sprechen ? 'Ich höre zu … (Mikrofon antippen: senden)' : (z.teilen && z.bildMit ? 'Frag mich zu deinem Bildschirm …' : 'Frag deine KI …');
    if (feld.placeholder !== platzhalter) feld.placeholder = platzhalter;
  }

  /* -------------------------------------------- Auf, zu, schweben */

  function pilleGedrueckt() {
    if (z.timer.length) klangVorbereiten();
    if (z.modus === 'fenster') {
      fensterGroesse(!z.gross);
      return;
    }
    if (z.offen) schliessen({ fokus: true });
    else oeffnen({ fokus: true });
  }

  function oeffnen({ fokus = true } = {}) {
    if (!lebt) return;
    if (z.modus === 'fenster') {
      if (!z.gross) fensterGroesse(true);
      try { z.fenster.focus(); } catch { /* der Browser entscheidet */ }
      if (fokus) feld.focus();
      return;
    }
    if (z.offen) {
      if (fokus) feld.focus();
      return;
    }
    markierungMerken();
    z.offen = true;
    z.ungesehen = null;
    pille.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    verlaufLaden();
    kiInfoLaden();
    sofort();
    platzieren();
    verlaufEl.scrollTop = z.verlauf.length ? verlaufEl.scrollHeight : 0;
    morph(true);
    if (fokus && !finger()) feld.focus();
  }

  function schliessen({ fokus = false } = {}) {
    if (!z.offen || z.modus !== 'seite') return;
    z.offen = false;
    z.timerWahl = false;
    pille.setAttribute('aria-expanded', 'false');
    const fertig = () => {
      if (z.offen) return;
      panel.hidden = true;
    };
    morph(false).then(fertig);
    sofort();
    if (fokus) pille.focus();
  }

  /** Das Panel an die Pille legen: oben buendig, mittig darunter, im Fenster. */
  function platzieren() {
    if (z.modus !== 'seite' || !z.offen) return;
    const r = pille.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const breite = Math.min(460, vw - 16);
    const mitte = r.width ? r.left + r.width / 2 : vw / 2;
    const links = Math.max(8, Math.min(vw - breite - 8, mitte - breite / 2));
    const oben = Math.max(8, Math.round((r.height ? r.top : 12) - 4));
    panel.style.left = `${Math.round(links)}px`;
    panel.style.top = `${oben}px`;
    panel.style.width = `${Math.round(breite)}px`;
    panel.style.maxHeight = `${Math.max(260, Math.min(680, vh - oben - 12))}px`;
  }

  /** Die Pille waechst zum Panel (und zurueck) -- clip-path, keine Layoutsprünge. */
  function morph(auf) {
    if (z.modus !== 'seite' || reduziert() || typeof panel.animate !== 'function') return Promise.resolve();
    const p = panel.getBoundingClientRect();
    const r = pille.getBoundingClientRect();
    if (!p.width || !r.width) return Promise.resolve();
    const oben = Math.max(0, r.top - p.top);
    const links = Math.max(0, r.left - p.left);
    const rechts = Math.max(0, p.right - r.right);
    const unten = Math.max(0, p.bottom - r.bottom);
    const von = `inset(${oben}px ${rechts}px ${unten}px ${links}px round ${r.height / 2}px)`;
    const nach = 'inset(0px 0px 0px 0px round 26px)';
    try {
      const anim = panel.animate([{ clipPath: von, opacity: 0.4 }, { clipPath: nach, opacity: 1 }], {
        duration: auf ? 280 : 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', direction: auf ? 'normal' : 'reverse', fill: 'both',
      });
      return anim.finished.catch(() => {}).then(() => { try { anim.cancel(); } catch { /* vorbei */ } });
    } catch {
      return Promise.resolve();
    }
  }

  async function schweben() {
    const dpip = window.documentPictureInPicture;
    if (!L.schwebenMoeglich(window)) {
      melden(L.SCHWEBEN_NICHT, 'fehler');
      return;
    }
    if (z.modus === 'fenster' && z.fenster && !z.fenster.closed) {
      try { z.fenster.focus(); } catch { /* egal */ }
      return;
    }
    let w;
    try {
      w = await dpip.requestWindow(L.fensterMasse(true));
    } catch (err) {
      melden(L.schwebenFehlerSatz(err), 'fehler');
      return;
    }
    fensterEinrichten(w);
    z.fenster = w;
    z.modus = 'fenster';
    z.gross = true;
    z.offen = false;
    pille.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    for (const k of ['left', 'top', 'width', 'maxHeight']) panel.style[k] = '';
    w.document.body.append(zeile, panel);
    dock.classList.add('is-leer');
    schwebtKnopf.hidden = false;
    w.addEventListener('pagehide', zurueckGeholt, { once: true });
    w.document.addEventListener('keydown', tasteImFenster);
    verlaufLaden();
    kiInfoLaden();
    taktStarten();
    sofort();
    verlaufEl.scrollTop = verlaufEl.scrollHeight;
    try { feld.focus(); } catch { /* egal */ }
  }

  /** Das schwebende Fenster bekommt dasselbe Aussehen wie die Seite. */
  function fensterEinrichten(w) {
    const d = w.document;
    d.documentElement.lang = 'de';
    for (const attr of ['data-theme']) {
      const v = document.documentElement.getAttribute(attr);
      if (v) d.documentElement.setAttribute(attr, v);
    }
    d.title = 'Insel · Neural OS';
    for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
      if (node.tagName === 'LINK') {
        const link = d.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL(node.getAttribute('href'), document.baseURI).href;
        d.head.appendChild(link);
      } else {
        const s = d.createElement('style');
        if (node.id) s.id = node.id;
        s.textContent = node.textContent;
        d.head.appendChild(s);
      }
    }
    stilEinsetzen(d);
    d.body.classList.add('insel-fenster');
    // Was die Seite spaeter an Stilen nachlaedt (ein Baustein, der erst jetzt
    // gezeichnet wird), braucht das Fenster auch.
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver((liste) => {
        for (const m of liste) {
          for (const n of m.addedNodes) {
            if (n.tagName === 'STYLE' && (!n.id || !d.getElementById(n.id))) {
              const s = d.createElement('style');
              if (n.id) s.id = n.id;
              s.textContent = n.textContent;
              d.head.appendChild(s);
            }
          }
        }
      });
      mo.observe(document.head, { childList: true });
      w.addEventListener('pagehide', () => mo.disconnect(), { once: true });
    }
  }

  function tasteImFenster(ev) {
    if (L.istKuerzel(ev)) {
      ev.preventDefault();
      fensterGroesse(!z.gross);
    } else if (ev.key === 'Escape' && z.gross && !z.sprechen) {
      ev.preventDefault();
      fensterGroesse(false);
    }
  }

  function fensterGroesse(gross) {
    if (z.modus !== 'fenster' || !z.fenster) return;
    z.gross = gross;
    z.fenster.document.body.classList.toggle('is-klein', !gross);
    pille.setAttribute('aria-expanded', String(gross));
    const m = L.fensterMasse(gross);
    try {
      // Die Titelleiste des Fensters gehoert dem Browser; sie kommt dazu.
      const rand = Math.max(0, (z.fenster.outerHeight || 0) - (z.fenster.innerHeight || 0));
      z.fenster.resizeTo(m.width, m.height + rand);
    } catch { /* ohne Klick darf das Fenster seine Groesse nicht aendern */ }
    if (gross) {
      z.ungesehen = null;
      verlaufEl.scrollTop = verlaufEl.scrollHeight;
    }
    sofort();
  }

  function zurueckHolen() {
    if (z.modus !== 'fenster' || !z.fenster) return;
    try { z.fenster.close(); } catch { zurueckGeholt(); }
  }

  /** Das Fenster ist zu (Knopf, Kreuz oder der Tab ging zu): alles zurueck in die Seite. */
  function zurueckGeholt() {
    if (z.modus !== 'fenster') return;
    const w = z.fenster;
    z.fenster = null;
    z.modus = 'seite';
    z.gross = true;
    z.offen = false;
    if (w) {
      try { w.document.removeEventListener('keydown', tasteImFenster); } catch { /* weg */ }
    }
    // Spracherkennung und Aufnahme hingen am Fenster.
    if (z.sprechen) sprechenAbbrechen();
    dock.insertBefore(zeile, schwebtKnopf);
    document.body.appendChild(panel);
    panel.hidden = true;
    pille.setAttribute('aria-expanded', 'false');
    dock.classList.remove('is-leer');
    schwebtKnopf.hidden = true;
    taktStarten();
    sofort();
    kopfMessen();
  }

  /** Im schwebenden Fenster fuehrt alles, was in Neural OS zeigt, dorthin -- und holt den Tab nach vorn. */
  function navigieren(ziel) {
    navigate(ziel);
    if (z.modus === 'fenster') {
      try { window.focus(); } catch { /* der Browser entscheidet */ }
    } else if (z.offen) {
      schliessen();
    }
  }

  /* ------------------------------------------------------- Melden */

  function melden(satz, ton = 'info', aktionOpt = null) {
    z.hinweis = { satz, ton, zeit: Date.now(), aktion: aktionOpt };
    if (!z.offen && z.modus === 'seite' && typeof toast === 'function') {
      toast(satz, ton === 'fehler' ? 'error' : 'info', aktionOpt ? { action: aktionOpt } : undefined);
    }
    planen();
  }

  /* ---------------------------------------------- Markierung, Ablage */

  function markierungMerken() {
    try {
      const sel = window.getSelection();
      const t = sel ? String(sel.toString() || '').trim() : '';
      if (!t || t.length < 3) return;
      const knoten = sel.anchorNode;
      if (knoten && (panel.contains(knoten) || zeile.contains(knoten))) return;
      // Dieselbe Markierung, schon einmal mitgeschickt: nicht noch einmal.
      if (t === z.markiert || z.anhaenge.some((a) => a.art === 'text' && a.text === t)) return;
      z.markiert = t;
      anhangDazu({ art: 'text', name: 'Markierung', text: t.slice(0, L.MAX_KONTEXT_ZEICHEN) });
    } catch { /* keine Auswahl */ }
  }

  function anhangDazu(a) {
    a.id = `a${(zaehler += 1)}`;
    const dateien = z.anhaenge.filter((x) => x.art !== 'text').length;
    if (a.art !== 'text' && dateien >= MAX_JE_NACHRICHT) {
      melden(`Höchstens ${MAX_JE_NACHRICHT} Dateien je Frage.`, 'fehler');
      return;
    }
    z.anhaenge.push(a);
    planen();
  }

  function anhangWeg(a) {
    z.anhaenge = z.anhaenge.filter((x) => x !== a);
    if (a.url && a.url.startsWith('blob:')) {
      // Die Vorschau im Verlauf braucht die Adresse nicht mehr, wenn nichts gesendet wurde.
      try { URL.revokeObjectURL(a.url); } catch { /* egal */ }
    }
    planen();
  }

  async function dateienDazu(liste) {
    for (const datei of liste) {
      const art = dateiArt(datei);
      if (!art.art) {
        melden(`„${datei.name || 'Datei'}“ geht nicht. ${MOEGLICH}`, 'fehler');
        continue;
      }
      if (art.art === 'text') {
        try {
          const inhalt = await datei.text();
          anhangDazu({ art: 'text', name: datei.name || 'Text', text: inhalt });
        } catch {
          melden(`„${datei.name}“ ließ sich nicht lesen.`, 'fehler');
        }
        continue;
      }
      if (art.art === 'pdf' && datei.size > MAX_PDF_BYTES) {
        melden(`„${datei.name}“ ist zu groß (${mb(datei.size)} MB, erlaubt sind ${mb(MAX_PDF_BYTES)} MB).`, 'fehler');
        continue;
      }
      try {
        const name = datei.name || (art.art === 'bild' ? 'Bild.png' : 'Dokument.pdf');
        const fertig = art.art === 'bild' ? await bildVorbereiten(datei, { name, mime: art.mime }) : { datei, name, mime: art.mime };
        anhangDazu({ art: art.art, name: fertig.name, mime: fertig.mime, datei: fertig.datei, url: art.art === 'bild' ? URL.createObjectURL(fertig.datei) : null });
      } catch (err) {
        melden(err.message, 'fehler');
      }
    }
  }

  /** Aus der Zwischenablage: ein Bild oder Text. Liest erst nach dem Klick (der Browser fragt einmal). */
  async function zwischenablageLesen() {
    const w = hostFenster();
    const cb = w.navigator && w.navigator.clipboard;
    if (!cb) return { fehler: 'Dieser Browser lässt die Zwischenablage nicht lesen. Füg mit Strg+V ins Feld ein.' };
    try {
      if (typeof cb.read === 'function') {
        const teile = await cb.read();
        for (const teil of teile) {
          const bildTyp = teil.types.find((t) => t.startsWith('image/'));
          if (bildTyp) {
            const blob = await teil.getType(bildTyp);
            return { bild: new File([blob], 'Aus der Zwischenablage.png', { type: blob.type || bildTyp }) };
          }
        }
        for (const teil of teile) {
          if (teil.types.includes('text/plain')) {
            const t = await (await teil.getType('text/plain')).text();
            if (t.trim()) return { text: t };
          }
        }
        return { leer: true };
      }
      const t = await cb.readText();
      return t && t.trim() ? { text: t } : { leer: true };
    } catch (err) {
      if (err && err.name === 'NotAllowedError') return { fehler: 'Die Zwischenablage ist nicht erlaubt. Füg mit Strg+V ins Feld ein – oder erlaube es oben in der Adressleiste.' };
      return { fehler: 'Die Zwischenablage ließ sich nicht lesen. Füg mit Strg+V ins Feld ein.' };
    }
  }

  async function ausZwischenablage() {
    const r = await zwischenablageLesen();
    if (r.bild) await dateienDazu([r.bild]);
    else if (r.text) anhangDazu({ art: 'text', name: 'Aus der Zwischenablage', text: r.text.slice(0, L.MAX_KONTEXT_ZEICHEN) });
    else if (r.leer) melden('In der Zwischenablage ist nichts. Kopier zuerst etwas (Strg+C).', 'info');
    else if (r.fehler) melden(r.fehler, 'fehler');
    try { feld.focus(); } catch { /* egal */ }
  }

  /* ---------------------------------------------- Bildschirm teilen */

  function teilenUmschalten() {
    if (z.teilen) teilenBeenden();
    else teilenStarten();
  }

  async function teilenStarten() {
    if (!L.teilenMoeglich(window)) {
      melden('Dieser Browser kann den Bildschirm nicht teilen.', 'fehler');
      return;
    }
    let strom;
    try {
      strom = await window.navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include',
      });
    } catch (err) {
      const satz = L.teilenFehlerSatz(err);
      if (satz) melden(satz, 'fehler');
      return;
    }
    const spur = strom.getVideoTracks()[0];
    if (!spur) {
      for (const s of strom.getTracks()) s.stop();
      return;
    }
    const flaeche = (spur.getSettings && spur.getSettings().displaySurface) || '';
    const was = { monitor: 'deinen Bildschirm', window: 'ein Fenster', browser: 'einen Tab' }[flaeche] || 'mit';
    z.teilen = { strom, spur, was, seit: Date.now() };
    spur.addEventListener('ended', () => {
      if (z.teilen && z.teilen.spur === spur) teilenBeenden();
    });
    if (z.modus === 'seite' && !z.offen) oeffnen({ fokus: true });
    sofort();
    try { feld.focus(); } catch { /* egal */ }
  }

  function teilenBeenden() {
    const t = z.teilen;
    if (!t) return;
    z.teilen = null;
    for (const s of t.strom.getTracks()) {
      try { s.stop(); } catch { /* schon aus */ }
    }
    teilenVideo.srcObject = null;
    planen();
  }

  /** Ein Bild vom geteilten Bildschirm, als JPEG, hoechstens BILD_KANTE Pixel. */
  async function bildschirmfoto() {
    const t = z.teilen;
    if (!t) throw new Error('Es wird gerade nichts geteilt.');
    let quelle = null;
    let breite = 0;
    let hoehe = 0;
    if (typeof window.ImageCapture === 'function') {
      try {
        const bmp = await new window.ImageCapture(t.spur).grabFrame();
        quelle = bmp;
        breite = bmp.width;
        hoehe = bmp.height;
      } catch {
        quelle = null;
      }
    }
    if (!quelle) {
      const v = teilenVideo;
      if (v.srcObject !== t.strom) v.srcObject = t.strom;
      if (!v.videoWidth) {
        try { await v.play(); } catch { /* still */ }
        await new Promise((r) => {
          const fertig = () => r();
          v.addEventListener('loadeddata', fertig, { once: true });
          setTimeout(fertig, 1500);
        });
      }
      if (!v.videoWidth) throw new Error('Vom Bildschirm kam noch kein Bild.');
      quelle = v;
      breite = v.videoWidth;
      hoehe = v.videoHeight;
    }
    const m = L.bildMasse(breite, hoehe);
    const c = document.createElement('canvas');
    c.width = m.breite;
    c.height = m.hoehe;
    const g = c.getContext('2d');
    g.drawImage(quelle, 0, 0, m.breite, m.hoehe);
    if (quelle && typeof quelle.close === 'function') quelle.close();
    for (const guete of [0.82, 0.7, 0.58]) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', guete));
      if (blob && blob.size <= MAX_BILD_BYTES) return blob;
    }
    throw new Error('Das Bild vom Bildschirm wurde zu groß.');
  }

  /* ------------------------------------------------------ Sprechen */

  function sprechWegJetzt() {
    return sprechWeg({ transkribieren: !!(z.kiInfo && z.kiInfo.transkribieren), nurAufnahme: z.nurAufnahme }, hostFenster());
  }

  function sprechenUmschalten() {
    if (z.sprechen) {
      sprechenFertig();
      return;
    }
    const weg = sprechWegJetzt();
    if (!weg) return;
    if (vl && z.liest) vl.stopp();
    if (weg === 'erkennung') erkennungLos();
    else aufnahmeLos();
  }

  function erkennungLos() {
    const vorher = feld.value;
    const sitzung = { weg: 'erkennung', seit: Date.now(), vorher: vorher && !/\s$/.test(vorher) ? `${vorher} ` : vorher, erkannt: false, fehler: null };
    z.sprechen = sitzung;
    z.sprechText = '';
    try {
      sitzung.erkennung = erkennungStarten({
        onText: (fertig, vorlaeufig) => {
          if (z.sprechen !== sitzung) return;
          const t = [fertig, vorlaeufig].filter(Boolean).join(' ');
          if (!t) return;
          sitzung.erkannt = true;
          feld.value = sitzung.vorher + t;
          z.sprechText = t;
          z.gesprochen = true;
          feldGroesse();
          planen();
        },
        onFehler: (code) => {
          if (z.sprechen === sitzung) sitzung.fehler = code;
        },
        onEnde: () => {
          if (z.sprechen !== sitzung) return;
          z.sprechen = null;
          const code = sitzung.fehler;
          if (code && !sitzung.erkannt && erkennungUntauglich(code)) {
            z.nurAufnahme = true;
            if (sprechWegJetzt() === 'aufnahme') {
              aufnahmeLos();
              return;
            }
          }
          const satz = code ? erkennungFehlerSatz(code) : null;
          if (satz) melden(satz, 'fehler');
          if (sitzung.danachSenden || (sitzung.erkannt && !code)) {
            if (feld.value.trim()) absenden();
          }
          planen();
        },
      }, hostFenster());
    } catch {
      z.sprechen = null;
      z.nurAufnahme = true;
      if (sprechWegJetzt() === 'aufnahme') {
        aufnahmeLos();
        return;
      }
      melden('Die Spracherkennung ließ sich nicht starten.', 'fehler');
    }
    planen();
  }

  async function aufnahmeLos() {
    const sitzung = { weg: 'aufnahme', seit: Date.now() };
    z.sprechen = sitzung;
    z.sprechText = '';
    planen();
    let a;
    try {
      a = await aufnahmeStarten({
        onGrenze: () => { if (z.sprechen === sitzung) sprechenFertig(); },
      }, hostFenster());
    } catch (err) {
      if (z.sprechen === sitzung) z.sprechen = null;
      const name = err && err.name;
      melden(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Das Mikrofon ist nicht erlaubt. Erlaube es oben in der Adressleiste.'
        : (name === 'NotFoundError' ? 'Kein Mikrofon gefunden.' : 'Das Mikrofon ließ sich nicht öffnen.'), 'fehler');
      return;
    }
    if (z.sprechen !== sitzung) {
      a.abbrechen();
      return;
    }
    sitzung.aufnahme = a;
    planen();
  }

  /** Fertig gesprochen: die Erkennung liefert ihr letztes Wort, die Aufnahme wird umgeschrieben -- dann geht die Frage los. */
  async function sprechenFertig() {
    const s = z.sprechen;
    if (!s) return;
    s.danachSenden = true;
    if (s.weg === 'erkennung') {
      if (s.erkennung) s.erkennung.stopp();
      return;
    }
    if (!s.aufnahme || s.schreibt) return;
    s.schreibt = true;
    z.sprechText = 'Schreibe auf …';
    planen();
    let t = '';
    try {
      const { wav, sekunden, abgebrochen } = await s.aufnahme.stopp();
      if (abgebrochen || z.sprechen !== s) return;
      if (sekunden < 0.3) throw new Error('Die Aufnahme ist zu kurz.');
      const r = await api.post('/ki/transkribieren', { audio: bytesAlsBase64(wav), ...(z.chatId ? { chatId: z.chatId } : {}) }, { timeoutMs: 90000 });
      t = String((r && r.text) || '').trim();
    } catch (err) {
      if (z.sprechen === s) z.sprechen = null;
      melden(`Nicht verstanden: ${fehlerSatz(err)}`, 'fehler');
      planen();
      return;
    }
    if (z.sprechen === s) z.sprechen = null;
    if (!t) {
      melden('Nichts verstanden. Tippe noch einmal aufs Mikrofon und sprich.', 'info');
      planen();
      return;
    }
    feld.value = `${feld.value}${feld.value && !/\s$/.test(feld.value) ? ' ' : ''}${t}`;
    z.gesprochen = true;
    feldGroesse();
    absenden();
  }

  function sprechenAbbrechen() {
    const s = z.sprechen;
    z.sprechen = null;
    if (!s) return;
    try {
      if (s.erkennung) s.erkennung.abbrechen();
      if (s.aufnahme) s.aufnahme.abbrechen();
    } catch { /* schon aus */ }
  }

  /* ---------------------------------------------------- Vorlesen */

  if (vl) {
    offs.push(vl.abonnieren((zs) => {
      const liest = !!(zs && zs.id && String(zs.id).startsWith('insel:'));
      if (liest !== z.liest) {
        z.liest = liest;
        planen();
      } else if (liest) {
        planen();
      }
    }));
  }

  function vorlesen(e) {
    if (!vl) return;
    if (z.liest && vl.zustand().id === `insel:${e.id}`) {
      vl.stopp();
      return;
    }
    vl.start(`insel:${e.id}`, vorleseText(e.antwort.text));
  }

  /* ------------------------------------------------------- Kopieren */

  async function kopieren(wert) {
    const w = hostFenster();
    try {
      await w.navigator.clipboard.writeText(wert);
      melden('Kopiert.', 'info');
      return;
    } catch { /* weiter unten von Hand */ }
    try {
      const d = w.document;
      const ta = d.createElement('textarea');
      ta.value = wert;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      d.body.appendChild(ta);
      ta.select();
      const ok = d.execCommand('copy');
      ta.remove();
      melden(ok ? 'Kopiert.' : 'Kopieren ging nicht.', ok ? 'info' : 'fehler');
    } catch {
      melden('Kopieren ging nicht.', 'fehler');
    }
  }

  async function alsNotiz(e) {
    if (e.notizId) {
      navigieren(`#/notes?id=${encodeURIComponent(e.notizId)}`);
      return;
    }
    const inhalt = markdownOhneUi(e.antwort.text).trim();
    if (!inhalt) return;
    const titel = L.kurzText(e.frage || inhalt, 60) || 'Aus der Insel';
    try {
      const r = await api.post('/records', { type: 'note', data: { title: titel, body: inhalt } });
      const id = r && r.record ? r.record.id : null;
      e.notizId = id;
      e._aKey = null;
      melden('Notiz angelegt.', 'info', id ? { label: 'Öffnen', run: () => navigieren(`#/notes?id=${encodeURIComponent(id)}`) } : null);
    } catch (err) {
      melden(`Nicht gespeichert: ${fehlerSatz(err)}`, 'fehler');
    }
  }

  /* ----------------------------------------------------- Timer */

  let klang = null;
  /** Den Ton vorbereiten, solange ein Klick da ist -- spaeter darf ein Browser ihn sonst nicht abspielen. */
  function klangVorbereiten() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!klang || klang.state === 'closed') klang = new AC();
      if (klang.state === 'suspended') klang.resume().catch(() => {});
    } catch {
      klang = null;
    }
  }

  function gong() {
    if (!klang || klang.state === 'closed') return;
    try {
      if (klang.state === 'suspended') klang.resume().catch(() => {});
      const t0 = klang.currentTime + 0.02;
      for (const [frequenz, versatz] of [[880, 0], [660, 0.24], [880, 0.48]]) {
        const o = klang.createOscillator();
        const g = klang.createGain();
        o.type = 'sine';
        o.frequency.value = frequenz;
        g.gain.setValueAtTime(0.0001, t0 + versatz);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + versatz + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + versatz + 0.7);
        o.connect(g);
        g.connect(klang.destination);
        o.start(t0 + versatz);
        o.stop(t0 + versatz + 0.75);
      }
    } catch { /* ohne Ton bleibt die Insel sichtbar */ }
  }

  function timerStarten(ms, titel) {
    klangVorbereiten();
    if (z.timer.length >= 5) {
      melden('Höchstens fünf Timer gleichzeitig.', 'fehler');
      return;
    }
    const t = L.timerNeu(ms, titel, Date.now());
    z.timer.push(t);
    timerMerken();
    timerPlanen(t);
    melden(`Timer läuft: ${L.dauerWorte(t.dauerMs)}${t.titel !== 'Timer' ? ` · ${t.titel}` : ''}.`, 'info');
    sofort();
  }

  /** Ein eigener Wecker je Timer (kein Takt): im Hintergrund drosselt der Browser Takte, einzelne Wecker kaum. */
  function timerPlanen(t) {
    clearTimeout(uhren.get(t.id));
    const rest = t.endeMs - Date.now();
    if (rest <= 0) {
      timerFertig(t.id);
      return;
    }
    uhren.set(t.id, setTimeout(() => timerFertig(t.id), Math.min(rest, 2147483000)));
  }

  let klingelUhr = null;
  let klingelBis = 0;
  function timerFertig(id) {
    const t = z.timer.find((x) => x.id === id);
    if (!t || t.klingelt) return;
    t.klingelt = true;
    timerMerken();
    klingelBis = Date.now() + L.KLINGELN_MS;
    if (!klingelUhr) {
      gong();
      klingelUhr = setInterval(() => {
        if (!z.timer.some((x) => x.klingelt) || Date.now() > klingelBis) {
          clearInterval(klingelUhr);
          klingelUhr = null;
          return;
        }
        gong();
      }, 2000);
    }
    try {
      if (typeof window.Notification === 'function' && window.Notification.permission === 'granted') {
        // eslint-disable-next-line no-new
        new window.Notification(`${t.titel} ist fertig`, { body: `Timer · ${L.dauerWorte(t.dauerMs)}`, tag: `insel-${t.id}` });
      }
    } catch { /* manche Browser erlauben Mitteilungen nur ueber einen Service Worker */ }
    sofort();
  }

  function timerAus(id) {
    const vorher = z.timer.length;
    z.timer = id ? z.timer.filter((t) => t.id !== id) : [];
    if (id) {
      clearTimeout(uhren.get(id));
      uhren.delete(id);
    } else {
      for (const u of uhren.values()) clearTimeout(u);
      uhren.clear();
    }
    if (!z.timer.some((t) => t.klingelt) && klingelUhr) {
      clearInterval(klingelUhr);
      klingelUhr = null;
    }
    // Kein Timer mehr: das Tongeraet wieder freigeben.
    if (!z.timer.length && klang && klang.state === 'running') klang.suspend().catch(() => {});
    timerMerken();
    if (vorher !== z.timer.length) sofort();
  }

  for (const t of z.timer) timerPlanen(t);

  /* ------------------------------------------------------- Fragen */

  function feldGroesse() {
    feld.style.height = 'auto';
    feld.style.height = `${Math.min(128, feld.scrollHeight)}px`;
  }

  feld.addEventListener('input', () => {
    if (!z.sprechen) z.gesprochen = false;
    feldGroesse();
  });
  feld.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      absenden();
    }
  });
  feld.addEventListener('paste', (ev) => {
    const dateien = [...((ev.clipboardData && ev.clipboardData.files) || [])];
    if (!dateien.length) return;
    ev.preventDefault();
    dateienDazu(dateien);
  });
  for (const ziel of [panel, zeile]) {
    ziel.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
      ev.preventDefault();
      eingabe.classList.add('is-ablegen');
    });
    ziel.addEventListener('dragleave', () => eingabe.classList.remove('is-ablegen'));
    ziel.addEventListener('drop', (ev) => {
      const dateien = [...((ev.dataTransfer && ev.dataTransfer.files) || [])];
      eingabe.classList.remove('is-ablegen');
      if (!dateien.length) return;
      ev.preventDefault();
      if (z.modus === 'seite' && !z.offen) oeffnen({ fokus: true });
      dateienDazu(dateien);
    });
  }
  panel.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && z.modus === 'seite') {
      ev.stopPropagation();
      ev.preventDefault();
      if (z.sprechen) sprechenAbbrechen();
      schliessen({ fokus: true });
    }
  });
  // Klicks in der Insel: den Ton vorbereiten (fuer einen Timer, der spaeter klingelt).
  panel.addEventListener('pointerdown', () => { if (z.timer.length) klangVorbereiten(); }, { passive: true });

  function absenden() {
    if (z.lauf) {
      stoppen();
      return;
    }
    if (z.sprechen) {
      sprechenFertig();
      return;
    }
    const t = feld.value.trim();
    if (!t && !z.anhaenge.length && !(z.teilen && z.bildMit)) return;
    fragen(t, { ausFeld: true });
  }

  async function vorlageNutzen(v) {
    if (!v || z.lauf) return;
    if (v.braucht === 'inhalt') {
      const hatBild = !!(z.teilen && z.bildMit);
      const hatAnhang = z.anhaenge.length > 0;
      if (!hatBild && !hatAnhang) {
        // Nichts da, worauf sich "das" bezieht: zuerst die Zwischenablage.
        const r = await zwischenablageLesen();
        if (r.bild) await dateienDazu([r.bild]);
        else if (r.text) anhangDazu({ art: 'text', name: 'Aus der Zwischenablage', text: r.text.slice(0, L.MAX_KONTEXT_ZEICHEN) });
        if (!r.bild && !r.text) {
          const offen = z.modus === 'seite' ? L.offenHinweis(state.get('route')) : null;
          if (!offen) {
            melden(r.fehler || 'Worauf soll ich mich beziehen? Kopier zuerst etwas (Strg+C) oder zeig mir deinen Bildschirm.', r.fehler ? 'fehler' : 'info',
              L.teilenMoeglich(window) ? { label: 'Bildschirm zeigen', run: () => teilenStarten() } : null);
            return;
          }
        }
      }
    }
    fragen(v.frage, { vorlage: v });
  }

  /** Den Insel-Chat holen -- oder anlegen, wenn es keinen gibt oder der letzte zu alt ist. */
  async function inselChat() {
    if (z.chatId && !L.gespraechAbgelaufen(z.zuletzt, Date.now())) return z.chatId;
    if (z.chatId && L.gespraechAbgelaufen(z.zuletzt, Date.now())) {
      // Das laufende Gespraech ist alt: die neue Frage beginnt ein neues (das alte bleibt unter "Zuletzt").
      const aktuell = z.lauf ? z.lauf.eintrag : null;
      freigeben(z.verlauf.filter((x) => x !== aktuell));
      z.verlauf = aktuell ? [aktuell] : [];
      z.chatId = null;
    }
    const r = await api.post('/chats', { title: L.chatTitel(Date.now()), systemPrompt: L.SYSTEM_ANWEISUNG });
    const id = r && r.record ? r.record.id : null;
    if (!id) throw new Error('Der Server hat keinen Chat angelegt.');
    z.chatId = id;
    z.zuletzt = Date.now();
    z.geladen = true;
    chatMerken();
    return id;
  }

  async function ablegen(chatId, dateien) {
    const ids = [];
    for (const a of dateien) {
      if (a.ablageId && a.ablageChat === chatId) {
        ids.push(a.ablageId);
        continue;
      }
      const daten = await alsBase64(a.datei);
      const r = await api.post(`/chats/${encodeURIComponent(chatId)}/anhaenge`, { name: a.name, mime: a.mime, daten }, { timeoutMs: 180000 });
      const neu = r && r.anhang;
      if (!neu || !neu.id) throw new Error('Der Server hat die Datei nicht angenommen.');
      a.ablageId = neu.id;
      a.ablageChat = chatId;
      ids.push(neu.id);
    }
    return ids;
  }

  /**
   * Eine Frage stellen. Kleine Befehle (Timer, Notiz) erledigt die Insel
   * selbst; alles andere geht -- mit Bild vom Bildschirm, Anhaengen und
   * Text aus der Zwischenablage -- in den Insel-Chat.
   */
  async function fragen(frage, { ausFeld = false, vorlage = null, erneut = false } = {}) {
    if (z.lauf) return;
    const roh = String(frage || '').trim();
    const dateienVorher = z.anhaenge.filter((a) => a.art === 'bild' || a.art === 'pdf');
    const texteVorher = z.anhaenge.filter((a) => a.art === 'text');
    if (!vorlage && !dateienVorher.length && !texteVorher.length) {
      const b = L.befehl(roh);
      if (b) {
        if (ausFeld) {
          feld.value = '';
          feldGroesse();
        }
        befehlAusfuehren(b);
        return;
      }
    }
    const mitBild = !!(z.teilen && z.bildMit);
    if (!roh && !dateienVorher.length && !texteVorher.length && !mitBild) return;
    const gesprochen = z.gesprochen && ausFeld;
    const feldVorher = feld.value;
    if (ausFeld) {
      feld.value = '';
      feldGroesse();
    }
    z.gesprochen = false;
    z.ungesehen = null;
    z.timerWahl = false;
    const mitgeschickt = [...z.anhaenge];
    z.anhaenge = [];
    const e = {
      id: `e${(zaehler += 1)}`,
      zeit: Date.now(),
      frage: roh || (mitBild ? 'Was siehst du?' : ''),
      bilder: mitgeschickt.filter((a) => a.art === 'bild' && a.url).map((a) => ({ src: a.url, name: a.name })),
      antwort: { id: null, text: '', status: 'laeuft', fehler: null, rueckfragen: [], wirkung: [], agenten: new Map() },
      chatId: null,
    };
    z.verlauf.push(e);
    if (z.verlauf.length > MAX_VERLAUF) freigeben(z.verlauf.splice(0, z.verlauf.length - MAX_VERLAUF));
    const controller = new AbortController();
    z.lauf = { controller, phase: 'chat', schritt: '', eintrag: e, seit: Date.now(), folgen: true };
    sofort();
    verlaufEl.scrollTop = verlaufEl.scrollHeight;

    const zurueck = () => {
      // Nicht angekommen: Text und Anhaenge zurueck ins Feld.
      if (ausFeld && !feld.value) {
        feld.value = feldVorher;
        feldGroesse();
      }
      z.anhaenge = [...mitgeschickt.filter((a) => !z.anhaenge.includes(a)), ...z.anhaenge];
    };

    let chatId;
    let ids = [];
    try {
      chatId = await inselChat();
      e.chatId = chatId;
      const dateien = mitgeschickt.filter((a) => a.art === 'bild' || a.art === 'pdf');
      if (mitBild) {
        z.lauf.phase = 'bild';
        planen();
        const blob = await bildschirmfoto();
        const url = URL.createObjectURL(blob);
        e.bilder.unshift({ src: url, name: 'Bildschirm' });
        dateien.unshift({ art: 'bild', name: L.bildName(Date.now()), mime: 'image/jpeg', datei: blob, url, vomBildschirm: true });
        sofort();
      }
      if (dateien.length) {
        z.lauf.phase = 'ablegen';
        planen();
        ids = await ablegen(chatId, dateien);
      }
    } catch (err) {
      if (!erneut && err instanceof ApiError && err.status === 404) {
        // Der Insel-Chat wurde geloescht: ein neuer, einmal.
        z.chatId = null;
        chatMerken();
        z.lauf = null;
        z.verlauf = z.verlauf.filter((x) => x !== e);
        z.anhaenge = mitgeschickt;
        return fragen(roh, { ausFeld: false, vorlage, erneut: true });
      }
      e.antwort.status = 'fehler';
      e.antwort.fehler = `Nicht gesendet: ${fehlerSatz(err)}`;
      e.antwort.nichtVerbunden = nichtVerbunden(err);
      z.lauf = null;
      zurueck();
      sofort();
      return undefined;
    }

    const texte = mitgeschickt.filter((a) => a.art === 'text').map((a) => ({ name: a.name, text: a.text }));
    let inhalt = L.frageMitTexten(roh || (mitBild || ids.length ? 'Was siehst du? Sag kurz das Wichtigste.' : ''), texte);
    if (vorlage && vorlage.braucht === 'inhalt' && !mitBild && !ids.length && !texte.length) {
      const offen = z.modus === 'seite' ? L.offenHinweis(state.get('route')) : null;
      if (offen) inhalt = `${inhalt}\n\n${offen}`;
    }
    const ok = await strom(`/chats/${encodeURIComponent(chatId)}/messages`, { inhalt, ...(ids.length ? { anhaenge: ids } : {}) }, e);
    if (ok === 'abgelehnt') {
      zurueck();
    } else {
      z.zuletzt = Date.now();
      chatMerken();
      if (gesprochen && vl && e.antwort.text.trim() && !e.antwort.fehler) vorlesen(e);
    }
    sofort();
    return undefined;
  }

  /**
   * Einen Strom fahren (Frage oder Antwort auf eine Rueckfrage) und seine
   * Ereignisse in den Eintrag uebernehmen.
   * @returns {Promise<'ok'|'abgelehnt'|'abgebrochen'|'unterbrochen'>}
   */
  async function strom(pfad, body, e) {
    const controller = z.lauf && z.lauf.eintrag === e ? z.lauf.controller : new AbortController();
    if (!z.lauf) z.lauf = { controller, phase: 'denkt', schritt: '', eintrag: e, seit: Date.now(), folgen: true };
    z.lauf.phase = 'denkt';
    planen();
    let fertig = false;
    let ergebnis = 'ok';
    try {
      await api.stream(pfad, {
        body,
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === 'fertig') fertig = true;
          ereignis(e, ev.type, ev.payload || {});
          planen();
        },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status > 0) {
        e.antwort.status = 'fehler';
        e.antwort.fehler = fehlerSatz(err);
        e.antwort.nichtVerbunden = nichtVerbunden(err);
        ergebnis = 'abgelehnt';
      } else if (err instanceof ApiError && err.isAborted) {
        e.antwort.status = 'aborted';
        ergebnis = 'abgebrochen';
      } else if (!fertig) {
        e.antwort.status = 'unterbrochen';
        ergebnis = 'unterbrochen';
      }
    } finally {
      if (z.lauf && z.lauf.eintrag === e) z.lauf = null;
    }
    if (ergebnis === 'ok' && e.antwort.status === 'laeuft') e.antwort.status = 'complete';
    const sichtbar = z.offen || (z.modus === 'fenster' && z.gross);
    if (ergebnis === 'ok' && !sichtbar && (e.antwort.text.trim() || e.antwort.rueckfragen.some((f) => f.zustand === 'offen'))) {
      z.ungesehen = { vorschau: L.kurzText(markdownOhneUi(e.antwort.text), 80) || 'Eine Rückfrage wartet', zeit: Date.now() };
    }
    sofort();
    return ergebnis;
  }

  function ereignis(e, typ, p) {
    const a = e.antwort;
    switch (typ) {
      case 'antwort':
        if (p.record) {
          a.id = p.record.id || a.id;
          const inhalt = p.record.data && typeof p.record.data.content === 'string' ? p.record.data.content : null;
          if (inhalt !== null && inhalt.length >= a.text.length) a.text = inhalt;
        }
        break;
      case 'text':
        if (typeof p.delta === 'string') {
          a.text += p.delta;
          if (z.lauf && z.lauf.eintrag === e) z.lauf.phase = 'schreibt';
        }
        break;
      case 'inhalt':
        if (typeof p.content === 'string') a.text = p.content;
        break;
      case 'denken':
        if (z.lauf && z.lauf.eintrag === e && !a.text) z.lauf.phase = 'denkt';
        break;
      case 'agent': {
        const vorher = a.agenten.get(p.id) || {};
        const neu = { ...vorher, id: p.id, titel: p.titel || vorher.titel || '', zustand: p.zustand, schritt: p.schritt || '' };
        a.agenten.set(p.id, neu);
        if (Array.isArray(p.wirkung) && p.wirkung.length) {
          const bekannt = new Map(a.wirkung.map((w) => [`${w.id}|${w.aktion}`, w]));
          for (const w of p.wirkung) bekannt.set(`${w.id}|${w.aktion}`, w);
          a.wirkung = [...bekannt.values()];
        }
        if (z.lauf && z.lauf.eintrag === e) {
          const laeuft = [...a.agenten.values()].find((x) => x.zustand === 'laeuft');
          if (laeuft) {
            z.lauf.phase = 'werkzeug';
            z.lauf.schritt = `${laeuft.schritt || laeuft.titel || 'Arbeitet'} …`.replace(/(?:…|\.\.\.)\s*…$/, '…');
          } else {
            z.lauf.phase = a.text ? 'schreibt' : 'denkt';
          }
        }
        break;
      }
      case 'rueckfrage':
        if (!a.rueckfragen.some((f) => f.id === p.id)) {
          a.rueckfragen.push({
            id: p.id,
            frage: String(p.frage || ''),
            optionen: (Array.isArray(p.optionen) ? p.optionen : []).map((o) => (typeof o === 'string' ? o : String((o && o.label) || ''))).filter(Boolean),
            mehrfach: p.mehrfach === true,
            zustand: 'offen',
          });
        }
        break;
      case 'hinweis':
        break;
      case 'fehler':
        a.fehler = p.satz || 'Die KI konnte nicht antworten.';
        a.nichtVerbunden = nichtVerbunden(p);
        break;
      case 'fertig': {
        const d = p.record && p.record.data;
        if (d) {
          if (typeof d.content === 'string') a.text = d.content;
          if (typeof d.status === 'string') a.status = d.status === 'streaming' ? 'complete' : d.status;
          if (Array.isArray(d.agenten)) {
            const alle = [];
            for (const ag of d.agenten) if (Array.isArray(ag.wirkung)) alle.push(...ag.wirkung);
            if (alle.length) a.wirkung = alle;
          }
          if (Array.isArray(d.rueckfragen)) {
            for (const f of d.rueckfragen) {
              const meine = a.rueckfragen.find((x) => x.id === f.id);
              if (meine && f.zustand && f.zustand !== 'offen') meine.zustand = f.zustand;
            }
          }
          // Abgebrochen hat der Mensch selbst: das ist kein Fehler, sondern ein ruhiges "Abgebrochen."
          if (d.error && d.error.message && !a.fehler && d.status !== 'aborted') a.fehler = d.error.message;
        } else if (a.status === 'laeuft') {
          a.status = 'complete';
        }
        if (p.stopReason === 'abgebrochen') a.status = 'aborted';
        break;
      }
      default:
        break;
    }
  }

  async function rueckfrageBeantworten(e, f, antwort) {
    if (z.lauf || !z.chatId) return;
    f.zustand = 'beantwortet';
    f.antwort = antwort;
    const controller = new AbortController();
    z.lauf = { controller, phase: 'denkt', schritt: '', eintrag: e, seit: Date.now(), folgen: true };
    e.antwort.status = 'laeuft';
    const r = await strom(`/chats/${encodeURIComponent(e.chatId || z.chatId)}/rueckfrage`, { id: f.id, antwort }, e);
    if (r === 'abgelehnt') f.zustand = 'offen';
    z.zuletzt = Date.now();
    chatMerken();
    sofort();
  }

  async function stoppen() {
    const lauf = z.lauf;
    if (!lauf || lauf.stoppt) return;
    lauf.stoppt = true;
    let angenommen = false;
    const id = lauf.eintrag && (lauf.eintrag.chatId || z.chatId);
    if (id) {
      try {
        const r = await api.post(`/chats/${encodeURIComponent(id)}/abort`, {}, { timeoutMs: 5000 });
        angenommen = !!(r && r.aborted);
      } catch {
        angenommen = false;
      }
    }
    if (!angenommen) lauf.controller.abort();
    else setTimeout(() => { if (z.lauf === lauf) lauf.controller.abort(); }, 4000);
  }

  function befehlAusfuehren(b) {
    if (b.art === 'timer') {
      if (b.ms) timerStarten(b.ms, b.titel);
      else {
        z.timerWahl = true;
        if (z.modus === 'seite' && !z.offen) oeffnen({ fokus: false });
        planen();
      }
    } else if (b.art === 'timerAus') {
      if (!z.timer.length) melden('Es läuft kein Timer.', 'info');
      timerAus(null);
    } else if (b.art === 'notiz') {
      notizAnlegen(b);
    }
  }

  async function notizAnlegen(b) {
    try {
      const r = await api.post('/records', { type: 'note', data: { title: b.titel, body: b.text } });
      const id = r && r.record ? r.record.id : null;
      melden(`Notiz angelegt: „${b.titel}“.`, 'info', id ? { label: 'Öffnen', run: () => navigieren(`#/notes?id=${encodeURIComponent(id)}`) } : null);
    } catch (err) {
      feld.value = `Notiz: ${b.text}`;
      feldGroesse();
      melden(`Nicht gespeichert: ${fehlerSatz(err)}`, 'fehler');
    }
  }

  /** Bilder vom Bildschirm leben als blob:-Adressen im Speicher des Tabs -- wer geht, gibt sie frei. */
  function freigeben(eintraege) {
    for (const e of eintraege) {
      for (const b of e.bilder || []) {
        if (String(b.src).startsWith('blob:')) {
          try { URL.revokeObjectURL(b.src); } catch { /* schon frei */ }
        }
      }
    }
  }

  function neuesGespraech() {
    if (z.lauf) return;
    freigeben(z.verlauf);
    z.chatId = null;
    z.zuletzt = null;
    z.verlauf = [];
    z.ungesehen = null;
    chatMerken();
    sofort();
    try { feld.focus(); } catch { /* egal */ }
  }

  /** Das laufende Insel-Gespraech nach dem Neuladen wieder zeigen (die letzten Fragen). */
  async function verlaufLaden() {
    if (z.geladen || !z.chatId) return;
    z.geladen = true;
    if (L.gespraechAbgelaufen(z.zuletzt, Date.now())) return;
    const chatId = z.chatId;
    try {
      const r = await api.get(`/chats/${encodeURIComponent(chatId)}/messages`, { query: { limit: 500 }, timeoutMs: 8000 });
      if (z.chatId !== chatId || z.verlauf.length) return;
      const items = Array.isArray(r && r.items) ? r.items : [];
      const paare = [];
      let offen = null;
      for (const m of items) {
        const d = m.data || {};
        if (d.role === 'user') {
          offen = {
            id: `e${(zaehler += 1)}`,
            zeit: Date.parse(m.createdAt) || 0,
            frage: L.kurzText(String(d.content || '').split(/\n\n(?:\*\*|\[Gerade offen)/)[0], 400),
            bilder: (Array.isArray(d.anhaenge) ? d.anhaenge : []).filter((x) => /^image\//.test(x.mime || '')).map((x) => ({ src: anhangUrl(chatId, x.id), name: x.name })),
            antwort: { id: null, text: '', status: 'complete', fehler: null, rueckfragen: [], wirkung: [], agenten: new Map() },
            chatId,
          };
          paare.push(offen);
        } else if (d.role === 'assistant' && offen) {
          offen.antwort.id = m.id;
          offen.antwort.text = String(d.content || '');
          offen.antwort.status = d.status === 'streaming' ? 'unterbrochen' : (d.status || 'complete');
          offen.antwort.rueckfragen = (Array.isArray(d.rueckfragen) ? d.rueckfragen : []).map((f) => ({
            id: f.id, frage: f.frage, optionen: (f.optionen || []).map((o) => (typeof o === 'string' ? o : o.label)), mehrfach: f.mehrfach === true, zustand: f.zustand || 'offen',
          }));
          for (const ag of Array.isArray(d.agenten) ? d.agenten : []) if (Array.isArray(ag.wirkung)) offen.antwort.wirkung.push(...ag.wirkung);
        }
      }
      z.verlauf = paare.slice(-6);
      sofort();
      verlaufEl.scrollTop = verlaufEl.scrollHeight;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        z.chatId = null;
        chatMerken();
      }
    }
  }

  async function kiInfoLaden() {
    try {
      z.kiInfo = await api.get('/ki', { timeoutMs: 6000 });
    } catch {
      z.kiInfo = null;
    }
    planen();
  }

  /* --------------------------------------------- Agenten, Freigaben */

  function laufUebernehmen(p) {
    if (!p || !p.id) return;
    const alt = z.agenten.get(p.id) || {};
    z.agenten.set(p.id, {
      ...alt,
      id: p.id,
      runId: p.runId || alt.runId || p.id,
      rolle: p.rolle || alt.rolle,
      titel: p.titel || alt.titel || '',
      zustand: p.zustand,
      status: p.status,
      startedAt: alt.startedAt || p.startedAt || new Date(Date.now() - (Number(p.dauerMs) || 0)).toISOString(),
      beginn: alt.beginn || (Date.parse(p.startedAt || '') || (Date.now() - (Number(p.dauerMs) || 0))),
      zeit: Date.now(),
      chatId: p.chatId || alt.chatId || null,
    });
  }

  async function laeufeLaden() {
    try {
      const r = await api.get('/runs', { query: { status: 'running', limit: 10 }, timeoutMs: 8000 });
      const aktiv = new Set();
      for (const run of Array.isArray(r && r.items) ? r.items : []) {
        const d = run.data || {};
        aktiv.add(run.id);
        laufUebernehmen({ id: run.id, runId: run.id, rolle: d.rolle, titel: d.titel || d.goal || '', status: d.status, startedAt: d.startedAt || run.createdAt, chatId: d.chatId });
      }
      for (const [id, a] of z.agenten) if (!aktiv.has(id) && a.status === 'running') z.agenten.delete(id);
    } catch { /* dann eben ohne */ }
    planen();
  }

  if (bus && typeof bus.on === 'function') {
    offs.push(bus.on('agent.aktivitaet', (p) => {
      laufUebernehmen(p);
      planen();
    }));
    let bald = null;
    const spaeter = () => {
      clearTimeout(bald);
      bald = setTimeout(laeufeLaden, 500);
    };
    for (const name of ['run.started', 'run.finished', 'run.failed', 'hello']) offs.push(bus.on(name, spaeter));
    offs.push(() => clearTimeout(bald));
  }
  laeufeLaden();
  offs.push(state.on('approvals', () => planen()));
  offs.push(state.on('claude', () => planen()));
  offs.push(state.on('pin', () => sichtbarkeit()));
  offs.push(state.on('theme', () => {
    if (z.fenster) {
      const v = document.documentElement.getAttribute('data-theme');
      try {
        if (v) z.fenster.document.documentElement.setAttribute('data-theme', v);
        else z.fenster.document.documentElement.removeAttribute('data-theme');
      } catch { /* zu */ }
    }
  }));

  function sichtbarkeit() {
    const aus = state.get('aus') || null;
    const gesperrt = !!state.get('pin') || !!aus;
    dock.hidden = gesperrt;
    if (gesperrt) {
      if (z.offen) schliessen();
      if (z.modus === 'fenster') zurueckHolen();
      if (aus) {
        // "Neural OS ist aus": nichts schwebt, nichts nimmt auf.
        teilenBeenden();
        sprechenAbbrechen();
        panel.hidden = true;
      }
      if (aus === 'beendet') timerAus(null);
    }
  }
  offs.push(state.on('aus', () => sichtbarkeit()));
  sichtbarkeit();

  /* ------------------------------------------------------- Takt */

  let takt = null;
  let taktIn = null;
  function taktStarten() {
    if (takt !== null) {
      try { taktIn.clearInterval(takt); } catch { /* das Fenster ist zu */ }
    }
    taktIn = hostFenster();
    // Jede Sekunde: Countdown, "In 12 Min", ob ein Hinweis abgelaufen ist.
    takt = taktIn.setInterval(() => {
      if (z.timer.length || z.termine.length || z.hinweis || z.agenten.size || z.lauf) planen();
      if (z.hinweis && Date.now() - z.hinweis.zeit > 12000) z.hinweis = null;
    }, 1000);
  }
  taktStarten();

  /* --------------------------------------------- Seite: Klick, Taste */

  function draussen(ev) {
    if (!z.offen || z.modus !== 'seite') return;
    const t = ev.target;
    if (!t || panel.contains(t) || zeile.contains(t)) return;
    if (t.closest && t.closest('.lk, .overlay, .toast, .toasts')) return;
    schliessen();
  }
  document.addEventListener('pointerdown', draussen, true);
  offs.push(() => document.removeEventListener('pointerdown', draussen, true));

  function taste(ev) {
    if (!L.istKuerzel(ev)) return;
    ev.preventDefault();
    if (dock.hidden) return;
    if (z.modus === 'fenster') {
      fensterGroesse(!z.gross);
      try { z.fenster.focus(); } catch { /* egal */ }
      return;
    }
    if (z.offen) schliessen({ fokus: true });
    else oeffnen({ fokus: true });
  }
  document.addEventListener('keydown', taste);
  offs.push(() => document.removeEventListener('keydown', taste));

  const neuLegen = () => platzieren();
  window.addEventListener('resize', neuLegen);
  offs.push(() => window.removeEventListener('resize', neuLegen));
  pille.addEventListener('pointerdown', () => markierungMerken(), { passive: true });
  // Wer waehrend der Antwort nach oben rollt, liest -- dann rollt nichts mehr nach unten.
  verlaufEl.addEventListener('scroll', () => {
    if (!z.lauf) return;
    z.lauf.folgen = verlaufEl.scrollHeight - verlaufEl.scrollTop - verlaufEl.clientHeight < 48;
  }, { passive: true });
  // Die Pille wandert, wenn sich der Kopf aendert (Leiste ein- oder ausgeklappt): das Panel geht mit.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => platzieren());
    ro.observe(kopf);
    offs.push(() => ro.disconnect());
  }

  /**
   * Wie viel Platz hat die Insel im Kopf? Gemessen wird alles AUSSER ihr --
   * der Titel mit seiner ganzen Breite --, so haengt das Ergebnis nicht an
   * ihr selbst und kippt nicht hin und her. Ist die Mitte schmal (unter
   * 600 px, etwa 1024 px mit offener Spalte), steht am Kopf data-eng="ja":
   * Ansichten lassen dann Entbehrliches weg (das Gehirn seine Zahl).
   */
  function kopfMessen() {
    if (!lebt) return;
    const eng = kopf.clientWidth > 0 && kopf.clientWidth < 600 ? 'ja' : 'nein';
    if (kopf.dataset.eng !== eng) kopf.dataset.eng = eng;
    if (dock.hidden) return;
    const cs = getComputedStyle(kopf);
    const innen = kopf.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const abstand = parseFloat(cs.columnGap) || 8;
    let belegt = 0;
    let anzahl = 0;
    for (const el of kopf.children) {
      if (el === dock) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).display === 'none') continue;
      anzahl += 1;
      belegt += el.classList.contains('topbar__title') ? Math.min(el.scrollWidth, 220) : r.width;
    }
    const frei = innen - belegt - abstand * anzahl - 24;
    let telefon = false;
    try { telefon = window.matchMedia('(max-width: 560px)').matches; } catch { telefon = false; }
    // Passt eine Erinnerung nicht daneben (Telefon, oder eine Ansicht braucht
    // den Kopf), faellt sie unter die Insel -- wie eine Mitteilung am iPhone.
    const hatKapseln = kapseln.children.length > 0;
    const unten = hatKapseln && (telefon || frei - 52 < 160);
    const lage = unten ? 'unten' : 'daneben';
    if (dock.dataset.kapseln !== lage) dock.dataset.kapseln = lage;
    const kapselnDa = z.modus === 'seite' && hatKapseln && !unten;
    let stufe = frei >= 150 ? 'voll' : (frei >= 76 ? 'kompakt' : 'punkt');
    if (kapselnDa) stufe = 'punkt';
    if (dock.dataset.stufe !== stufe) dock.dataset.stufe = stufe;
    const pMax = stufe === 'voll' ? `${Math.round(Math.min(360, frei))}px` : '';
    if (pille.style.maxWidth !== pMax) pille.style.maxWidth = pMax;
    const kMax = kapselnDa ? `${Math.round(frei - 52)}px` : '';
    if (kapseln.style.maxWidth !== kMax) kapseln.style.maxWidth = kMax;
  }
  let messenGeplant = 0;
  const neuMessen = () => {
    if (messenGeplant) return;
    messenGeplant = requestAnimationFrame(() => { messenGeplant = 0; kopfMessen(); });
  };

  // Kapseln kommen und gehen (Erinnerungen): die Pille richtet sich danach.
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => { planen(); neuMessen(); });
    mo.observe(kapseln, { childList: true });
    offs.push(() => mo.disconnect());
    // Ein anderer Titel, andere Knoepfe einer Ansicht: neu messen.
    const kopfMo = new MutationObserver(neuMessen);
    for (const el of kopf.querySelectorAll('.topbar__title, .topbar__slot')) kopfMo.observe(el, { childList: true, subtree: true, characterData: true });
    offs.push(() => kopfMo.disconnect());
  }
  if (typeof ResizeObserver === 'function') {
    const ro2 = new ResizeObserver(neuMessen);
    ro2.observe(kopf);
    offs.push(() => ro2.disconnect());
  }
  kopfMessen();

  sofort();

  /* --------------------------------------- Erinnerungen (Adapter) */

  const erinnerungen = {
    /** Eine Erinnerungskarte (lib/erinnerung.js) als Kapsel an die Pille. */
    einhaengen(karte, e) {
      if (!lebt || dock.hidden) return false;
      if (e && e.id) {
        karte.dataset.termin = e.id;
        kapselTermine.add(String(e.id));
      }
      kapseln.appendChild(karte);
      planen();
      return true;
    },
    /** Die Termine von gestern bis uebermorgen (dieselbe Liste, die die Erinnerungen laden). */
    termine(items) {
      z.termine = Array.isArray(items) ? items : [];
      planen();
    },
  };

  return {
    erinnerungen,
    navigieren,
    oeffnen,
    schliessen,
    stop() {
      lebt = false;
      for (const off of offs) {
        try { off(); } catch { /* weiter */ }
      }
      for (const u of uhren.values()) clearTimeout(u);
      if (klingelUhr) clearInterval(klingelUhr);
      try { taktIn.clearInterval(takt); } catch { /* zu */ }
      teilenBeenden();
      sprechenAbbrechen();
      if (z.fenster) {
        try { z.fenster.close(); } catch { /* zu */ }
      }
      dock.remove();
      panel.remove();
    },
  };
}

export default { starteInsel };
