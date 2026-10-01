/**
 * lib/insel.js -- die Insel: ein kleines Wesen am rechten Rand von Neural OS,
 * immer da, und auf Wunsch ueber allen anderen Programmen.
 *
 * Was sie ist, ehrlich gesagt:
 *
 * - **Zu: ein kleines Wesen am Rand** (lib/insel-wesen.js), rechts im
 *   unteren Drittel, auf jeder Seite. Es zeigt mit seiner Haltung, was es
 *   gerade tut (zuhoeren, denken, sprechen, essen, schlafen …), und daneben
 *   stehen kleine Schilder mit dem, was lebt: ein Timer laeuft ab, ein
 *   Termin beginnt gleich, ein Agent arbeitet, eine Freigabe wartet, das
 *   Mikrofon ist an, der Bildschirm wird geteilt, die KI schreibt.
 *   Erinnerungen an Termine (lib/erinnerung.js) haengen sich als Kapsel
 *   daneben. Es sitzt nie auf einem Knopf: Ist die rechte Spalte zu, hat es
 *   eine eigene Spur am Rand; sonst sucht es sich eine freie Stelle
 *   (lib/insel-logik.js dockLage).
 * - **Antippen: es waechst** zu einem Feld am rechten Rand (400 px, hoechstens
 *   80 % der Hoehe; am Telefon ein Blatt von unten) -- nie der ganze
 *   Bildschirm. Oben das Wesen, gross, darunter das Gespraech mit der eigenen
 *   KI: derselbe Chat-Dienst mit denselben Werkzeugen (Termin eintragen,
 *   Notiz anlegen, merken, im eigenen Wissen und im Internet suchen). Jede
 *   Frage landet in einem echten Chat "Insel · …", den man unter "Zuletzt"
 *   findet, oeffnen und loeschen kann. Nach zwei Stunden Ruhe beginnt ein
 *   neuer.
 * - **Live**: ein echtes Hin und Her mit der Stimme. Es hoert zu, merkt, wenn
 *   man fertig ist (1,2 s Stille nach Sprache), schreibt das Gesagte auf
 *   (die Erkennung des Browsers, sonst eine Aufnahme, die Gemini umschreibt),
 *   fragt, liest die Antwort vor und hoert wieder zu -- bis man Live wieder
 *   antippt oder Esc drueckt. Antippen, waehrend es spricht, unterbricht.
 * - **Dateien essen**: eine Datei auf das Wesen ziehen (oder die Bueroklammer):
 *   es macht das Maul auf, die Datei fliegt hinein, es kaut -- und dann geht
 *   sie wirklich an die KI (Bilder und PDF als Anhang, Textdateien als
 *   Text). Was es nicht lesen kann, sagt es, statt so zu tun.
 * - **"Bildschirm zeigen"**: der Browser fragt, was geteilt wird. Solange
 *   geteilt wird, geht mit jeder Frage ein frisches Bild mit -- abschaltbar.
 * - **"Über allen Fenstern"** (Document Picture-in-Picture): die Insel zieht in
 *   ein kleines Fenster, das ueber jedem Programm schwebt (Chrome, Edge,
 *   Opera und Firefox am Computer; in Safari und auf dem iPad nicht -- dann
 *   gibt es den Eintrag nicht).
 * - Was sie NICHT kann: in anderen Programmen klicken oder tippen, und sie
 *   hoert nicht von selbst zu -- nur nach dem Antippen von Mikrofon oder
 *   Live. Strg/⌘ + Umschalt + Leertaste gilt in Neural OS und im
 *   schwebenden Fenster, nicht im ganzen Computer.
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
  sprechWeg, erkennungStarten, erkennungFehlerSatz, erkennungUntauglich, bytesAlsBase64, mikrofonMoeglich,
} from './sprechen.js';
import { seitenVorleser, vorlesenMoeglich, sprechText } from './vorlesen.js';
import {
  bildVorbereiten, alsBase64, anhangUrl, MAX_BILD_BYTES, MAX_JE_NACHRICHT, leuchtkasten,
} from './anhaenge.js';
import { wesenErschaffen, wesenStil } from './insel-wesen.js';
import { ohrOeffnen } from './insel-ohr.js';
import * as L from './insel-logik.js';

const STYLE_ID = 'nos-insel';
const CHAT_KEY = 'insel-chat';
const VORLIEBEN_KEY = 'insel-vorlieben';
const TIMER_KEY = 'insel-timer';
const MAX_VERLAUF = 12;
const DATEI_ANNAHME = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json,.txt,.md,.markdown,.csv,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif';

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
  live: '<path d="M3.4 10h1.4M6.6 7.2v5.6M9.8 4.4v11.2M13 6.8v6.4M16.2 9v2"/>',
  mehr: '<circle cx="5" cy="10" r="1.35" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.35" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.35" fill="currentColor" stroke="none"/>',
  klammer: '<path d="M14.6 9.2 9.4 14.4a3.3 3.3 0 0 1-4.7-4.7l5.6-5.6a2.2 2.2 0 0 1 3.1 3.1l-5.4 5.4a1.1 1.1 0 0 1-1.6-1.6l4.9-4.9"/>',
  suche: '<circle cx="8.8" cy="8.8" r="5"/><path d="m12.6 12.6 4 4"/>',
  lesen: '<path d="M3 5.2c2.4-.8 4.8-.6 7 .9 2.2-1.5 4.6-1.7 7-.9v10c-2.4-.8-4.8-.6-7 .9-2.2-1.5-4.6-1.7-7-.9z"/><path d="M10 6.1v10"/>',
  wissen: '<circle cx="10" cy="10" r="2.2"/><circle cx="4.4" cy="5.4" r="1.4"/><circle cx="15.6" cy="5.4" r="1.4"/><circle cx="15.6" cy="14.6" r="1.4"/><path d="M5.6 6.4 8.4 8.6M14.4 6.4l-2.8 2.2M14.4 13.6l-2.8-2.2"/>',
  haken: '<path d="m5 10.4 3.2 3.2 6.8-7.4"/>',
  agent: '<circle cx="7" cy="7" r="2.6"/><circle cx="13.6" cy="7.6" r="2"/><path d="M2.8 15.6a4.2 4.2 0 0 1 8.4 0M11.2 15.6a3.2 3.2 0 0 1 6 0"/>',
  welt: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2 2 2.8 4.4 2.8 7S12 15 10 17c-2-2-2.8-4.4-2.8-7S8 5 10 3z"/>',
};

/* ------------------------------------------------------------------ */
/* Aussehen: die Farben der App (hell wie dunkel), EIN Akzent.         */
/* ------------------------------------------------------------------ */

const INSEL_CSS = `
/* Die Spur am rechten Rand: ab 1000 px, wenn die rechte Spalte zu ist, gehoert
   der Rand dem Wesen -- so liegt es nie auf einem Knopf (lib/insel-logik.js randSpur). */
@media (min-width: 1000px) {
  .shell[data-insel="spur"][data-rechts="zu"] { --right: 76px; }
}

/* ---------------- Das Dock: das Wesen am Rand ---------------- */
.insel-dock {
  --w-groesse: 60px;
  position: fixed; z-index: 50; top: 0; right: 16px;
  width: var(--w-groesse); height: var(--w-groesse);
  transform: translate3d(0, var(--dock-y, 60vh), 0);
  transition: transform 560ms cubic-bezier(0.34, 1.32, 0.5, 1);
}
.insel-dock[hidden] { display: none; }
.insel-dock.ist-neu { transition: none; }
.insel-dock[data-aus="ja"] { z-index: 10001; pointer-events: none; }
.insel-wesen-knopf {
  position: relative; display: grid; place-items: center; flex: none;
  width: var(--w-groesse, 60px); height: var(--w-groesse, 60px); margin: 0; padding: 0;
  color: inherit; background: transparent; border: 0; border-radius: 50%; cursor: pointer;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
}
.insel-wesen-knopf .wesen { transition: transform 280ms cubic-bezier(0.3, 1.4, 0.5, 1); }
@media (hover: hover) {
  .insel-dock .insel-wesen-knopf:hover .wesen { transform: scale(1.07); }
}
.insel-wesen-knopf:active .wesen { transform: scale(0.95); }
.insel-wesen-knopf:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.insel-wesen-knopf[data-neu="ja"]::after {
  content: ''; position: absolute; top: 3px; right: 3px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 0 2.5px var(--bg);
}
.insel-dock.is-ablegen .insel-wesen-knopf::before {
  content: ''; position: absolute; inset: -10px; border: 2px dashed var(--accent); border-radius: 50%;
  animation: insel-drehen 7s linear infinite;
}
@keyframes insel-drehen { to { transform: rotate(360deg); } }

/* Neben dem Wesen: Kapseln (Erinnerungen, ein klingelnder Timer) und Schilder. */
.insel-dock__seite {
  position: absolute; right: calc(100% + 10px); top: 50%; transform: translateY(-50%);
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  width: max-content; max-width: min(330px, calc(100vw - var(--w-groesse) - 46px));
  pointer-events: none;
}
.insel-dock__seite > * { pointer-events: auto; }
.insel-dock__schilder { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: 100%; }
.insel-dock__schilder:empty { display: none; }
.insel-schild {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 28px; padding: 0 11px 0 9px;
  font: inherit; font-size: var(--fs-xs); font-weight: 500; line-height: 1; color: var(--fg);
  background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 999px; box-shadow: var(--shadow-2);
  white-space: nowrap; cursor: pointer; font-variant-numeric: tabular-nums;
  animation: insel-ein 260ms var(--ease) both;
}
.insel-schild > span:not(.insel-schild__punkt) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.insel-schild svg { width: 14px; height: 14px; flex: none; color: var(--fg-muted); }
.insel-schild[data-ton="ki"] { color: var(--accent-text); }
.insel-schild[data-ton="ki"] svg { color: var(--accent-text); }
.insel-schild:hover { background: var(--surface-3); }
.insel-schild__punkt { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--danger); animation: insel-atmen 1.6s ease-in-out infinite; }
@keyframes insel-ein { from { opacity: 0; transform: translateX(8px) scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes insel-atmen { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.insel__welle { display: inline-flex; align-items: center; gap: 2px; height: 12px; flex: none; }
.insel__welle i { display: block; width: 2.5px; height: 100%; border-radius: 2px; background: currentColor; animation: insel-welle 0.9s ease-in-out infinite; transform-origin: center; }
.insel__welle i:nth-child(2) { animation-delay: -0.3s; }
.insel__welle i:nth-child(3) { animation-delay: -0.6s; }
@keyframes insel-welle { 0%, 100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }

.insel__kapseln { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: 100%; }
.insel__kapseln:empty { display: none; }
/* Neben dem Wesen ist eine Erinnerung eine Zeile ("In 9 Min · Inselprobe · Flur ×") -- so verdeckt sie wenig. */
.insel-dock .insel__kapseln .erin__card {
  display: grid; grid-template-columns: 3px minmax(0, 1fr) auto; align-items: center; gap: 9px;
  width: auto; max-width: min(300px, 100%); height: 40px; padding: 0 4px 0 11px; border-radius: 999px;
}
.insel-dock .insel__kapseln .erin__bar { height: 16px; align-self: center; }
.insel-dock .insel__kapseln .erin__text { flex-direction: row; align-items: center; gap: 7px; min-width: 0; min-height: 0; white-space: nowrap; }
.insel-dock .insel__kapseln .erin__wann { flex: none; }
.insel-dock .insel__kapseln .erin__titel { flex: 0 1 auto; min-width: 0; font-size: var(--fs-sm); }
.insel-dock .insel__kapseln .erin__ort { flex: 0 2 auto; min-width: 0; max-width: 40%; font-size: var(--fs-xs); }
.insel-dock .insel__kapseln .erin__ort::before { content: '· '; }
.insel-dock .insel__kapseln .erin__close { width: 30px; height: 30px; min-height: 0; border-radius: 50%; }
/* Neural OS ist aus: nur das schlafende Wesen, keine Schilder, die nicht mehr stimmen. */
.insel-dock[data-aus="ja"] .insel-dock__seite { display: none; }
.insel__wecker {
  display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 4px 0 12px;
  font-size: var(--fs-sm); font-weight: 600; color: var(--accent-fg); background: var(--accent);
  border-radius: 999px; box-shadow: var(--shadow-2); animation: insel-ein 260ms var(--ease) both;
}
.insel__wecker svg { width: 16px; height: 16px; flex: none; }
.insel__wecker button { height: 28px; padding: 0 12px; font: inherit; font-weight: 600; color: var(--accent); background: var(--accent-fg); border: 0; border-radius: 999px; cursor: pointer; }

/* Schwebt die Insel ueber allen Fenstern, steht am Rand nur ein Knopf zum Zurueckholen. */
.insel-schwebt {
  position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px 0 11px; white-space: nowrap;
  font: inherit; font-size: var(--fs-sm); color: var(--fg-muted); background: var(--surface-2);
  border: 1px solid var(--border-strong); border-radius: 999px; box-shadow: var(--shadow-2); cursor: pointer;
}
.insel-schwebt[hidden] { display: none; }
.insel-schwebt svg { width: 16px; height: 16px; color: var(--accent-text); }
.insel-schwebt:hover { color: var(--fg); }

/* ---------------- Aufgeklappt: das Feld am Rand ---------------- */
.insel-panel {
  position: fixed; z-index: 90; right: 16px; bottom: 16px; width: 400px; height: 680px;
  display: flex; flex-direction: column; overflow: hidden;
  color: var(--fg); background: var(--surface); border: 1px solid var(--border); border-radius: 28px;
  box-shadow: var(--shadow-3); font-size: var(--fs-base); line-height: var(--lh);
}
.insel-panel[hidden] { display: none; }
.insel-panel[data-art="blatt"] { left: 0; right: 0; bottom: 0; width: auto; border-bottom: 0; border-radius: 26px 26px 0 0; padding-bottom: env(safe-area-inset-bottom, 0px); }
.insel-panel :focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.insel-panel__kopf { position: relative; flex: none; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 22px 60px 10px; }
.insel-panel__wesen { display: grid; place-items: center; width: 92px; height: 92px; margin-bottom: 4px; }
.insel-panel__wesen .insel-wesen-knopf { --w-groesse: 92px; }
.insel-panel__satz { margin: 0; min-height: 1.5em; font-size: var(--fs-sm); font-weight: 500; color: var(--fg-muted); text-align: center; }
.insel-panel__satz[data-ton="ki"] { color: var(--accent-text); }
.insel-panel__satz[data-ton="fehler"] { color: var(--danger); }
.insel-panel__zwischen { margin: 0; max-width: 100%; font-size: var(--fs-sm); color: var(--fg); text-align: center; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.insel-panel__zwischen:empty { display: none; }
.insel-panel__knoepfe { position: absolute; top: 12px; right: 12px; display: flex; gap: 2px; }
.insel-panel__links { position: absolute; top: 14px; left: 14px; display: flex; gap: 4px; }
.insel-live-an { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px 0 9px; font: inherit; font-size: var(--fs-xs); font-weight: 600; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 999px; cursor: pointer; }
.insel-live-an[hidden] { display: none; }
.insel-live-an i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: insel-atmen 1.4s ease-in-out infinite; }
.insel-k { flex: none; display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0; color: var(--fg-muted); background: transparent; border: 0; border-radius: 50%; cursor: pointer; }
.insel-k[hidden] { display: none; }
.insel-k:hover { color: var(--fg); background: var(--surface-3); }
.insel-k:disabled { opacity: 0.4; cursor: default; }
.insel-k svg { width: 19px; height: 19px; }
.insel-k.is-an { color: var(--accent-fg); background: var(--danger); }
.insel-k[aria-expanded="true"] { color: var(--fg); background: var(--surface-3); }

.insel-live { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; padding: 0 16px 8px; }
.insel-live:empty { display: none; }
.insel-panel .insel__kapseln { align-items: stretch; padding: 0 14px 8px; }
.insel-panel .insel__kapseln .erin__card { width: auto; }
.insel-panel .insel__wecker { justify-content: space-between; }
.insel-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; max-width: 100%; padding: 0 11px; font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--surface-2); border: 0; border-radius: 999px; cursor: pointer; text-align: left; }
.insel-chip:hover { background: var(--surface-3); }
.insel-chip:disabled { opacity: 0.5; cursor: default; }
.insel-chip svg { width: 15px; height: 15px; flex: none; color: var(--fg-muted); }
.insel-chip > span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.insel-chip[data-ton="ki"] svg { color: var(--accent-text); }
.insel-chip[data-ton="aufnahme"] svg { color: var(--danger); }
.insel-chip__zahl { font-variant-numeric: tabular-nums; color: var(--fg-muted); }
.insel-chip__x { display: inline-grid; place-items: center; width: 22px; height: 22px; margin-right: -6px; padding: 0; color: var(--fg-subtle); background: transparent; border: 0; border-radius: 50%; cursor: pointer; }
.insel-chip__x:hover { color: var(--fg); background: var(--surface-4); }
.insel-chip__x svg { width: 13px; height: 13px; }
.insel-chip[aria-pressed="true"] { color: var(--accent-fg); background: var(--accent); }
.insel-chip[aria-pressed="true"] svg { color: currentColor; }

/* Das Gespraech */
.insel-verlauf { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 18px 10px; overscroll-behavior: contain; }
.insel-leer { display: flex; flex-direction: column; gap: 14px; padding: 6px 0 4px; }
.insel-leer__satz { margin: 0 8px 4px; font-size: var(--fs-sm); line-height: 1.5; color: var(--fg-subtle); text-align: center; text-wrap: balance; }
.insel-leer__wege { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.insel-leer__wege li { margin: 0; }
.insel-weg { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 46px; padding: 8px 14px; font: inherit; font-size: var(--fs-sm); text-align: left; color: var(--fg); background: var(--surface-2); border: 0; border-radius: 16px; cursor: pointer; }
.insel-weg:hover { background: var(--surface-3); }
.insel-weg svg { width: 18px; height: 18px; flex: none; color: var(--accent-text); }
.insel-weg small { display: block; margin-top: 1px; color: var(--fg-subtle); font-size: var(--fs-xs); }
.insel-leer__hinweis { display: flex; align-items: center; justify-content: center; gap: 7px; margin: 2px 0 0; font-size: var(--fs-xs); color: var(--fg-subtle); text-align: center; }
.insel-leer__hinweis svg { width: 14px; height: 14px; flex: none; }
.insel-eintrag { display: flex; flex-direction: column; gap: 7px; padding: 12px 0 6px; }
.insel-frage { align-self: flex-end; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: 88%; }
.insel-frage:empty { display: none; }
.insel-frage__text { padding: 8px 13px; font-size: var(--fs-base); line-height: 1.45; color: var(--fg); background: var(--surface-3); border-radius: 18px 18px 6px 18px; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
.insel-frage__bilder { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.insel-frage__bild { display: block; padding: 0; border: 0; background: none; border-radius: 12px; cursor: zoom-in; overflow: hidden; }
.insel-frage__bild img { display: block; width: 76px; height: 56px; object-fit: cover; border-radius: 12px; background: var(--surface-3); }
.insel-frage__datei { display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 100%; padding: 0 11px; font-size: var(--fs-xs); color: var(--fg-muted); background: var(--surface-2); border-radius: 999px; }
.insel-frage__datei span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.insel-frage__datei svg { width: 14px; height: 14px; flex: none; }
.insel-antwort { font-size: var(--fs-base); line-height: 1.6; color: var(--fg); overflow-wrap: anywhere; }
.insel-antwort:empty { display: none; }
.insel-antwort > :last-child { margin-bottom: 0; }
.insel-antwort p { margin: 0 0 8px; }
.insel-antwort a { color: var(--accent-text); text-decoration: underline; text-underline-offset: 2px; }
.insel-antwort .md-image { max-width: 100%; height: auto; border-radius: 14px; cursor: zoom-in; }
.insel-verweis { padding: 0 1px; font-size: 0.78em; vertical-align: super; line-height: 0; color: var(--accent-text) !important; text-decoration: none !important; }
.insel-schritte { display: flex; flex-direction: column; gap: 4px; }
.insel-schritte:empty { display: none; }
.insel-schritt { display: flex; align-items: center; gap: 8px; margin: 0; min-width: 0; font-size: var(--fs-sm); color: var(--fg-subtle); }
.insel-schritt > span:not(.insel-schritt__punkt) { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.insel-schritt svg { width: 15px; height: 15px; flex: none; }
.insel-schritt.is-laeuft { color: var(--fg); }
.insel-schritt.is-laeuft svg { color: var(--accent-text); }
.insel-schritt.is-fehler { color: var(--danger); }
.insel-schritt__punkt { width: 6px; height: 6px; flex: none; margin-left: auto; border-radius: 50%; background: var(--accent); animation: insel-atmen 1.1s ease-in-out infinite; }
.insel-quellen { display: flex; flex-direction: column; gap: 1px; padding-top: 2px; }
.insel-quellen:empty { display: none; }
.insel-quellen__titel { margin: 0 0 2px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.02em; color: var(--fg-subtle); }
.insel-quelle { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 3px 0; font-size: var(--fs-sm); color: var(--fg); text-decoration: none; }
.insel-quelle__nr { flex: none; min-width: 14px; font-size: var(--fs-xs); color: var(--accent-text); font-variant-numeric: tabular-nums; }
.insel-quelle__titel { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.insel-quelle__host { flex: none; margin-left: auto; font-size: var(--fs-xs); color: var(--fg-subtle); }
.insel-quelle:hover .insel-quelle__titel { text-decoration: underline; }
.insel-mehr { align-self: flex-start; padding: 2px 0; font: inherit; font-size: var(--fs-xs); color: var(--accent-text); background: none; border: 0; cursor: pointer; }
.insel-notizen { display: flex; flex-direction: column; gap: 4px; }
.insel-notizen:empty { display: none; }
.insel-notiz { display: flex; align-items: flex-start; gap: 7px; margin: 0; font-size: var(--fs-xs); line-height: 1.45; color: var(--fg-subtle); }
.insel-notiz svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }
.insel-zustand { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: var(--fs-sm); color: var(--fg-muted); }
.insel-zustand[hidden] { display: none; }
.insel-zustand .insel__welle { color: var(--accent-text); }
.insel-zustand.is-fehler { color: var(--danger); }
.insel-wirkung { display: flex; flex-wrap: wrap; gap: 6px; }
.insel-wirkung[hidden] { display: none; }
.insel-wirkung .insel-chip svg { color: var(--accent-text); }
.insel-rueck { padding: 12px; background: var(--surface-2); border-radius: 16px; }
.insel-rueck__frage { margin: 0 0 8px; font-size: var(--fs-sm); font-weight: 600; }
.insel-rueck__wahl { display: flex; flex-wrap: wrap; gap: 6px; }
.insel-rueck__wahl .insel-chip { background: var(--surface-3); }
.insel-aktionen { display: flex; flex-wrap: wrap; gap: 2px; margin: 0 0 0 -8px; }
.insel-aktionen[hidden] { display: none; }
.insel-aktion { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 8px; font: inherit; font-size: var(--fs-xs); color: var(--fg-subtle); background: transparent; border: 0; border-radius: 9px; cursor: pointer; }
.insel-aktion:hover { color: var(--fg); background: var(--surface-2); }
.insel-aktion svg { width: 15px; height: 15px; }
.insel-aktion.is-an { color: var(--accent-text); }

.insel-hinweis { display: flex; align-items: center; gap: 8px; margin: 0 14px 8px; padding: 9px 12px; font-size: var(--fs-sm); color: var(--fg); background: var(--surface-2); border-radius: 14px; }
.insel-hinweis[hidden] { display: none; }
.insel-hinweis.is-fehler { color: var(--danger); background: var(--danger-soft); }
.insel-hinweis svg { width: 16px; height: 16px; flex: none; }
.insel-hinweis span { flex: 1 1 auto; min-width: 0; }
.insel-hinweis button { flex: none; height: 28px; padding: 0 10px; font: inherit; font-size: var(--fs-sm); font-weight: 600; color: var(--accent-text); background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
.insel-hinweis button:hover { background: var(--surface-3); }
.insel-teilen { display: flex; align-items: center; gap: 10px; margin: 0 14px 8px; padding: 6px; background: var(--danger-soft); border-radius: 16px; }
.insel-teilen[hidden] { display: none; }
.insel-teilen video { flex: none; width: 72px; height: 44px; object-fit: cover; background: #111; border-radius: 10px; }
.insel-teilen__text { flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); line-height: 1.35; }
.insel-teilen__text b { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.insel-teilen__text b::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); animation: insel-atmen 1.6s ease-in-out infinite; }
.insel-teilen__text small { display: block; color: var(--fg-muted); font-size: var(--fs-xs); }
.insel-teilen > button { flex: none; height: 30px; padding: 0 12px; font: inherit; font-size: var(--fs-sm); font-weight: 600; color: #fff; background: var(--danger); border: 0; border-radius: 999px; cursor: pointer; }
.insel-verbinden { display: flex; align-items: center; gap: 10px; margin: 0 14px 8px; padding: 10px 12px; font-size: var(--fs-sm); background: var(--surface-2); border-radius: 16px; }
.insel-verbinden[hidden] { display: none; }
.insel-verbinden span { flex: 1 1 auto; }
.insel-verbinden button { flex: none; height: 30px; padding: 0 14px; font: inherit; font-weight: 600; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 999px; cursor: pointer; }
.insel-vorlagen { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 8px; }
.insel-vorlagen[hidden], .insel-timerwahl[hidden] { display: none; }
.insel-timerwahl { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 14px 8px; padding: 10px 12px; background: var(--surface-2); border-radius: 16px; font-size: var(--fs-sm); }
.insel-timerwahl .insel-chip { background: var(--surface-3); }
.insel-timerwahl small { flex-basis: 100%; color: var(--fg-subtle); font-size: var(--fs-xs); }
.insel-anhaenge { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 6px; }
.insel-anhaenge:empty { display: none; }
.insel-anhaenge img { width: 24px; height: 18px; object-fit: cover; border-radius: 4px; flex: none; }

/* Die Eingabe: Feld oben, darunter eine ruhige Leiste. */
.insel-eingabe { position: relative; flex: none; display: flex; flex-direction: column; margin: 2px 12px 12px; padding: 4px 6px 6px 14px; background: var(--surface-2); border: 1px solid transparent; border-radius: 22px; transition: border-color var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease); }
.insel-eingabe:focus-within { border-color: color-mix(in srgb, var(--accent) 45%, transparent); box-shadow: 0 0 0 3px var(--accent-soft); }
.insel-feld { width: 100%; min-height: 38px; max-height: 128px; margin: 0; padding: 9px 6px 3px 0; font: inherit; font-size: 15px; line-height: 1.4; color: var(--fg); background: transparent; border: 0; outline: none; resize: none; }
.insel-feld::placeholder { color: var(--fg-subtle); }
.insel-panel .insel-feld:focus-visible { box-shadow: none; }
.insel-eingabe__leiste { display: flex; align-items: center; gap: 2px; margin-left: -8px; }
.insel-eingabe__luecke { flex: 1 1 auto; }
.insel-live-knopf { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px 0 10px; font: inherit; font-size: var(--fs-sm); font-weight: 600; color: var(--fg); background: var(--surface-4); border: 0; border-radius: 999px; cursor: pointer; }
.insel-live-knopf[hidden] { display: none; }
.insel-live-knopf svg { width: 17px; height: 17px; }
.insel-live-knopf:hover { background: color-mix(in srgb, var(--surface-4) 70%, var(--fg) 8%); }
.insel-live-knopf[aria-pressed="true"] { color: var(--accent-fg); background: var(--accent); }
.insel-senden { flex: none; display: inline-grid; place-items: center; width: 34px; height: 34px; margin-left: 4px; padding: 0; color: var(--fg-muted); background: var(--surface-4); border: 0; border-radius: 50%; cursor: pointer; }
.insel-senden svg { width: 18px; height: 18px; }
.insel-senden.is-bereit { color: var(--accent-fg); background: var(--accent); }
.insel-senden.is-bereit:hover { background: var(--accent-hover); }
.insel-senden.is-stopp { color: var(--bg); background: var(--fg); }
.insel-menue { position: absolute; left: 6px; bottom: calc(100% + 8px); z-index: 5; display: flex; flex-direction: column; min-width: 236px; padding: 6px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 16px; box-shadow: var(--shadow-3); }
.insel-menue[hidden] { display: none; }
.insel-menue button { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 0 12px; font: inherit; font-size: var(--fs-sm); color: var(--fg); text-align: left; background: transparent; border: 0; border-radius: 10px; cursor: pointer; }
.insel-menue button:hover, .insel-menue button:focus-visible { background: var(--surface-3); outline: none; box-shadow: none; }
.insel-menue button svg { width: 17px; height: 17px; flex: none; color: var(--fg-muted); }
.insel-ablage { position: absolute; inset: 8px; z-index: 6; display: grid; place-items: center; padding: 20px; font-size: var(--fs-md); font-weight: 600; color: var(--accent-text); text-align: center; background: color-mix(in srgb, var(--surface) 86%, var(--accent) 14%); border: 2px dashed var(--accent); border-radius: 22px; pointer-events: none; }
.insel-ablage[hidden] { display: none; }
.insel-unsichtbar { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Im schwebenden Fenster: das ganze Fenster ist die Insel. */
body.insel-fenster { margin: 0; height: 100vh; overflow: hidden; display: flex; flex-direction: column; background: var(--surface); color: var(--fg); }
body.insel-fenster .insel-panel { position: static; flex: 1 1 auto; width: auto !important; height: auto !important; min-height: 0; border: 0; border-radius: 0; box-shadow: none; }
body.insel-fenster .insel-panel__kopf { padding-top: 14px; }
body.insel-fenster .insel-panel__wesen { width: 72px; height: 72px; }
body.insel-fenster .insel-panel__wesen .insel-wesen-knopf { --w-groesse: 72px; }
body.insel-fenster.is-klein .insel-panel > :not(.insel-panel__kopf) { display: none !important; }
body.insel-fenster.is-klein .insel-panel__kopf { flex-direction: row; justify-content: flex-start; gap: 12px; padding: 10px 96px 10px 14px; }
body.insel-fenster.is-klein .insel-panel__wesen { width: 56px; height: 56px; margin: 0; }
body.insel-fenster.is-klein .insel-panel__wesen .insel-wesen-knopf { --w-groesse: 56px; }
body.insel-fenster.is-klein .insel-panel__satz { text-align: left; }
body.insel-fenster.is-klein .insel-panel__links, body.insel-fenster.is-klein .insel-panel__zwischen { display: none; }
body.insel-fenster.is-klein .insel-panel__knoepfe { top: 50%; transform: translateY(-50%); }

@media (pointer: coarse) {
  .insel-dock { --w-groesse: 56px; }
  .insel-k, .insel-senden { width: 44px; height: 44px; }
  .insel-live-knopf { height: 44px; }
  .insel-chip, .insel-aktion, .insel-menue button { min-height: 44px; }
  .insel-schild { position: relative; height: 32px; }
  /* Zum Antippen 44 px hoch, ohne dass das Schild groesser aussieht. */
  .insel-schild::after { content: ''; position: absolute; left: 0; right: 0; top: -6px; bottom: -6px; }
  .insel-feld { font-size: 16px; }
  .insel__kapseln .erin__close { width: 40px; height: 40px; }
  .insel-dock .insel__kapseln .erin__card { height: 46px; }
  .insel-dock .insel__kapseln .erin__text { min-height: 40px; }
  .insel-dock .insel__kapseln .erin__close { width: 40px; height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .insel-dock, .insel-schild, .insel__wecker, .insel__welle i, .insel-schild__punkt, .insel-schritt__punkt,
  .insel-teilen__text b::before, .insel-live-an i, .insel-wesen-knopf .wesen, .insel-dock.is-ablegen .insel-wesen-knopf::before { animation: none !important; transition: none !important; }
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
const maus = () => {
  try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return false; }
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

/** Der Satz, wenn das Mikrofon nicht aufging. */
function mikrofonFehlerSatz(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Das Mikrofon ist nicht erlaubt. Erlaube es oben in der Adressleiste – dann tippe noch einmal.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Kein Mikrofon gefunden.';
  if (name === 'NotReadableError') return 'Das Mikrofon ist gerade belegt – vielleicht von einem anderen Programm.';
  return 'Das Mikrofon ließ sich nicht öffnen.';
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
  if (typeof document === 'undefined' || !ctx || !ctx.api || !document.body) return leer;
  stilEinsetzen();
  wesenStil();

  const { api, state, bus, navigate, toast } = ctx;
  const icons = ctx.icons || {};
  const vl = vorlesenMoeglich() ? seitenVorleser() : null;
  const shell = document.getElementById('shell');
  const kopf = document.getElementById('topbar');

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
    live: null,
    frisst: null,
    freutBis: 0,
    verwirrtBis: 0,
    verwirrtSatz: '',
    menue: false,
    dockY: null,
    ziehen: false,
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

  const wesen = wesenErschaffen();
  const wesenKnopf = h('button.insel-wesen-knopf', {
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'insel-panel',
    'aria-haspopup': 'dialog',
    title: `Insel (${L.kuerzelText(istMac())})`,
    onClick: (ev) => wesenGetippt(ev),
  }, wesen.el);
  const kapseln = h('div.insel__kapseln');
  const schilder = h('div.insel-dock__schilder');
  const dockSeite = h('div.insel-dock__seite', null, kapseln, schilder);
  const schwebtKnopf = h('button.insel-schwebt', {
    type: 'button',
    hidden: true,
    title: 'Die Insel zurück in Neural OS holen',
    onClick: () => zurueckHolen(),
  }, icon(G.schweben), h('span', null, text('Insel schwebt · zurückholen')));
  const ansage = h('span.insel-unsichtbar', { role: 'status', 'aria-live': 'polite' });
  const dock = h('div.insel-dock.ist-neu', { role: 'group', 'aria-label': 'Insel' }, wesenKnopf, dockSeite, schwebtKnopf, ansage);

  // Das Feld
  const wesenPlatz = h('div.insel-panel__wesen');
  const satzEl = h('p.insel-panel__satz', { 'aria-live': 'polite' });
  const zwischenEl = h('p.insel-panel__zwischen', { 'aria-hidden': 'true' });
  const liveAnKnopf = h('button.insel-live-an', {
    type: 'button',
    hidden: true,
    title: 'Live beenden (Esc)',
    'aria-label': 'Live beenden',
    onClick: () => liveAus(),
  }, h('i', { 'aria-hidden': 'true' }), h('span', null, text('Live')));
  const knopfKlein = kKnopf(G.kleiner, 'Kleiner', () => fensterGroesse(!z.gross));
  const knopfZurueck = kKnopf(G.zurueck, 'Zurück in Neural OS', () => zurueckHolen());
  const knopfZu = kKnopf(G.zu, 'Insel schließen', () => schliessen({ fokus: true }));
  const panelKopf = h('header.insel-panel__kopf', null,
    h('div.insel-panel__links', null, liveAnKnopf),
    wesenPlatz, satzEl, zwischenEl,
    h('div.insel-panel__knoepfe', null, knopfKlein, knopfZurueck, knopfZu));
  const live = h('div.insel-live');
  const kapselPlatz = h('div.insel-panel__kapseln');
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
    placeholder: 'Frag mich etwas …',
    'aria-label': 'Frage an deine KI',
    enterkeyhint: 'send',
  });
  const dateiWahl = h('input', { type: 'file', multiple: true, accept: DATEI_ANNAHME, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const knopfKlammer = kKnopf(G.klammer, 'Datei geben – ich lese sie', () => dateiWahl.click());
  const knopfMehr = kKnopf(G.mehr, 'Mehr', () => menueUmschalten());
  knopfMehr.setAttribute('aria-haspopup', 'menu');
  knopfMehr.setAttribute('aria-expanded', 'false');
  const knopfMikro = kKnopf(G.mikro, 'Sprechen', () => sprechenUmschalten());
  const knopfLive = h('button.insel-live-knopf', {
    type: 'button',
    'aria-pressed': 'false',
    title: 'Live: wir reden – ich höre zu, antworte und höre wieder zu',
    onClick: (ev) => { ev.stopPropagation(); liveUmschalten(); },
  }, icon(G.live), h('span', null, text('Live')));
  const knopfSenden = h('button.insel-senden', { type: 'button', 'aria-label': 'Senden', title: 'Senden', onClick: (ev) => { ev.stopPropagation(); absenden(); } }, icon(G.senden));
  const menue = h('div.insel-menue', { role: 'menu', hidden: true, 'aria-label': 'Mehr' });
  const eingabe = h('form.insel-eingabe', {
    onSubmit: (ev) => {
      ev.preventDefault();
      absenden();
    },
  }, feld,
  h('div.insel-eingabe__leiste', null, knopfKlammer, knopfMehr, h('span.insel-eingabe__luecke'), knopfMikro, knopfLive, knopfSenden),
  menue, dateiWahl);
  const ablageEl = h('div.insel-ablage', { hidden: true }, text('Gib mir die Datei – ich lese sie.'));
  const panel = h('section.insel-panel#insel-panel', {
    role: 'dialog',
    'aria-label': 'Insel – sprich mit deiner KI',
    hidden: true,
  }, panelKopf, live, kapselPlatz, verlaufEl, hinweisEl, verbindenEl, teilenEl, timerWahlEl, vorlagenEl, anhangEl, eingabe, ablageEl);

  function kKnopf(glyphe, label, run) {
    return h('button.insel-k', { type: 'button', 'aria-label': label, title: label, onClick: (ev) => { ev.stopPropagation(); run(ev); } }, icon(glyphe));
  }

  document.body.appendChild(dock);
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
    else if (z.live && z.live.phase === 'hoert') out.push({ art: 'hoeren', zwischen: z.live.text || '', zeit: z.live.seit });
    const letzte = z.verlauf[z.verlauf.length - 1];
    const offeneFrage = letzte && letzte.antwort.rueckfragen.find((f) => f.zustand === 'offen');
    if (z.lauf) {
      out.push({ art: 'antwort', phase: z.lauf.phase, schritt: z.lauf.schritt, vorschau: z.lauf.eintrag ? z.lauf.eintrag.antwort.text : '', zeit: z.lauf.seit });
    } else if (offeneFrage) {
      out.push({ art: 'rueckfrage', frage: offeneFrage.frage, zeit: letzte.zeit });
    }
    if (z.ungesehen) out.push({ art: 'neu', vorschau: z.ungesehen.vorschau, zeit: z.ungesehen.zeit });
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

  /** Was das Wesen gerade ist -- aus dem, was wirklich laeuft. */
  function wesenJetzt(jetzt) {
    const k = state.get('claude');
    const aus = !!state.get('aus');
    const phase = z.lauf ? z.lauf.phase : null;
    const livePhase = z.live ? z.live.phase : null;
    return L.wesenZustand({
      jetzt,
      aus,
      verbunden: k && k.bekannt ? k.verbunden !== false : null,
      frisst: !!z.frisst,
      verwirrtBis: z.verwirrtBis,
      hoert: !!z.sprechen || livePhase === 'hoert',
      spricht: z.liest,
      schreibt: phase === 'schreibt',
      denkt: (!!phase && phase !== 'schreibt') || livePhase === 'versteht' || livePhase === 'denkt',
      freutBis: z.freutBis,
    });
  }

  /** Die eine Zeile unter dem grossen Wesen. */
  function satzJetzt(zustand) {
    const aus = !!state.get('aus');
    if (aus) return { satz: L.wesenSatz('schlaeft', { aus: true }), ton: '' };
    if (z.live) {
      if (z.live.phase === 'denkt' && z.lauf && z.lauf.phase === 'werkzeug' && z.lauf.schritt) return { satz: z.lauf.schritt, ton: 'ki' };
      return { satz: L.liveSatz(z.live.phase), ton: 'ki' };
    }
    if (z.sprechen) return { satz: z.sprechen.schreibt ? 'Ich schreibe auf …' : 'Ich höre zu …', ton: 'ki' };
    if (zustand === 'frisst') return { satz: L.wesenSatz('frisst', { datei: z.frisst && z.frisst.datei }), ton: 'ki' };
    if (z.lauf) {
      const s = {
        chat: 'Ich denke …', bild: 'Ich schaue auf deinen Bildschirm …', ablegen: 'Ich nehme die Datei …', denkt: 'Ich denke …', schreibt: 'Ich schreibe …',
      }[z.lauf.phase];
      return { satz: z.lauf.phase === 'werkzeug' ? (z.lauf.schritt || 'Ich arbeite …') : (s || 'Ich denke …'), ton: 'ki' };
    }
    if (z.liest) return { satz: 'Ich lese vor … – zum Anhalten tippen', ton: 'ki' };
    if (zustand === 'verwirrt') return { satz: L.wesenSatz('verwirrt', { satz: z.verwirrtSatz }), ton: 'fehler' };
    return { satz: L.wesenSatz(zustand, {}), ton: '' };
  }

  function zeichnen() {
    if (!lebt) return;
    const jetzt = Date.now();
    for (const a of z.agenten.values()) a.sicht = zustandVon(a, jetzt);
    z.termin = L.naechsterTermin(z.termine, jetzt, kapselTermine);
    const liste = aktivitaeten(jetzt);
    const klingelt = liste.some((a) => a.art === 'wecker');
    const { haupt, alle } = L.kompakt(liste.filter((a) => a.art !== 'wecker'));
    const zustand = wesenJetzt(jetzt);
    wesen.zustand(zustand);
    if (klingelt) {
      if (wesen.el.dataset.geste !== 'aufgeregt' && !z.frisst) wesen.geste('aufgeregt');
    } else if (wesen.el.dataset.geste === 'aufgeregt') {
      wesen.geste(null);
    }
    dock.dataset.klingelt = klingelt ? 'ja' : 'nein';
    const { satz, ton } = satzJetzt(zustand);
    zeichneWesenKnopf(satz, haupt, jetzt);
    zeichneWecker();
    if (!z.offen && z.modus === 'seite') zeichneSchilder(alle, jetzt);
    else if (schilder.firstChild) { clear(schilder); schilder.dataset.key = ''; lagePlanen(60); }
    if (z.offen || z.modus === 'fenster') {
      zeichnePanelKopf(satz, ton);
      zeichneLive(alle, jetzt);
      zeichneVerlauf();
      zeichneHinweis();
      zeichneTeilen();
      zeichneVorlagen();
      zeichneAnhaenge();
      zeichneEingabe();
      zeichneMenue();
    }
    const k = state.get('claude');
    verbindenEl.hidden = !(k && k.bekannt && k.verbunden === false);
  }

  let ansageZuletzt = '';
  function zeichneWesenKnopf(satz, haupt, jetzt) {
    const tz = haupt ? L.aktivitaetText(haupt, jetzt) : null;
    const offen = z.offen || (z.modus === 'fenster' && z.gross);
    const zusatz = tz && tz.text && tz.text !== satz && !z.offen ? ` · ${tz.text}` : '';
    const label = `Insel: ${satz}${zusatz}. ${z.modus === 'fenster' ? (z.gross ? 'Kleiner' : 'Größer') : (offen ? 'Schließen' : 'Öffnen')}`;
    if (wesenKnopf.getAttribute('aria-label') !== label) wesenKnopf.setAttribute('aria-label', label);
    wesenKnopf.dataset.neu = z.ungesehen && !z.offen ? 'ja' : 'nein';
    wesenKnopf.disabled = !!state.get('aus');
    // Nur ein Wechsel der Lage wird angesagt, nicht jede Sekunde eines Timers.
    const ansagen = haupt && ['neu', 'fehler', 'rueckfrage'].includes(haupt.art) ? L.aktivitaetText(haupt, jetzt).text : '';
    if (ansagen !== ansageZuletzt) {
      clear(ansage);
      if (ansagen) ansage.appendChild(text(ansagen));
    }
    ansageZuletzt = ansagen;
  }

  /** Die kleinen Schilder neben dem Wesen (zu). Neu gebaut nur, wenn sich mehr als eine Zahl aendert. */
  const schildKnoten = new Map();
  function zeichneSchilder(alle, jetzt) {
    const zeigen = [];
    for (const a of alle) {
      const c = L.chipFuer(a, jetzt);
      if (!c) continue;
      zeigen.push({ a, c, key: `${a.art}|${a.id || a.runId || ''}|${c.symbol}|${a.art === 'timer' ? a.titel : c.text}` });
      if (zeigen.length >= L.MAX_CHIPS) break;
    }
    const schluessel = zeigen.map((x) => x.key).join('\n');
    if (schilder.dataset.key !== schluessel) {
      schilder.dataset.key = schluessel;
      clear(schilder);
      schildKnoten.clear();
      for (const x of zeigen) {
        const t = h('span', null, text(x.c.text));
        schildKnoten.set(x.key, t);
        schilder.appendChild(schild(x.a, x.c, t));
      }
      lagePlanen(80);
      return;
    }
    for (const x of zeigen) {
      const t = schildKnoten.get(x.key);
      if (t && t.textContent !== x.c.text) {
        clear(t);
        t.appendChild(text(x.c.text));
      }
    }
  }

  function schild(a, c, inhalt) {
    const sym = {
      timer: icon(G.timer), termin: icon(G.termin), freigabe: icon(G.freigabe), agent: icon(icons.agents || G.agent),
      mikro: null, bildschirm: null, vorlesen: icon(G.vorlesen), neu: icon(G.haken), hinweis: icon(G.hinweis),
      welle: h('span.insel__welle', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    }[c.symbol] || null;
    const ziel = () => {
      if (a.art === 'termin') navigieren(`#/kalender?id=${encodeURIComponent(a.id)}${a.occurrence ? `&am=${encodeURIComponent(a.occurrence)}` : ''}`);
      else if (a.art === 'freigabe') navigieren('#/agents');
      else if (a.art === 'agent') navigieren(a.runId ? `#/agents?id=${encodeURIComponent(a.runId)}` : '#/agents');
      else oeffnen({ fokus: true });
    };
    return h('button.insel-schild', {
      type: 'button',
      'data-ton': c.ton,
      'data-art': a.art,
      title: L.aktivitaetText(a, Date.now()).text,
      onClick: (ev) => { ev.stopPropagation(); ziel(); },
    }, c.ton === 'aufnahme' ? h('span.insel-schild__punkt', { 'aria-hidden': 'true' }) : null, sym, inhalt);
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
        h('button', { type: 'button', onClick: (ev) => { ev.stopPropagation(); timerAus(t.id); } }, text('Aus')));
      weckerKnoten.set(t.id, node);
      kapseln.prepend(node);
    }
  }

  function zeichnePanelKopf(satz, ton) {
    if (satzEl.textContent !== satz) {
      clear(satzEl);
      satzEl.appendChild(text(satz));
    }
    if ((satzEl.dataset.ton || '') !== ton) satzEl.dataset.ton = ton;
    const zw = z.live && z.live.phase === 'hoert' && z.live.text ? `„${L.kurzText(z.live.text, 120, { ende: true })}“` : '';
    if (zwischenEl.textContent !== zw) {
      clear(zwischenEl);
      if (zw) zwischenEl.appendChild(text(zw));
    }
    liveAnKnopf.hidden = !z.live;
    const fenster = z.modus === 'fenster';
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
   * Die Live-Zeile im Feld. Jede Sekunde neu gerechnet, aber nur neu
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
        return h('span.insel-chip', null, icon(G.timer),
          h('span', null, text(a.titel)), h('span.insel-chip__zahl', null, zahl),
          h('button.insel-chip__x', { type: 'button', 'aria-label': `Timer „${a.titel}“ beenden`, title: 'Beenden', onClick: () => timerAus(a.id) }, icon(G.zu)));
      case 'termin':
        return h('button.insel-chip', {
          type: 'button',
          'data-ton': 'ki',
          onClick: () => navigieren(`#/kalender?id=${encodeURIComponent(a.id)}${a.occurrence ? `&am=${encodeURIComponent(a.occurrence)}` : ''}`),
        }, icon(G.termin), zahl);
      case 'freigabe':
        return h('button.insel-chip', { type: 'button', onClick: () => navigieren('#/agents') }, icon(G.freigabe), zahl);
      case 'agent':
        return h('button.insel-chip', {
          type: 'button',
          onClick: () => navigieren(a.runId ? `#/agents?id=${encodeURIComponent(a.runId)}` : '#/agents'),
        }, icon(icons.agents || G.agent), zahl);
      case 'vorlesen':
        return h('span.insel-chip', { 'data-ton': 'ki' }, icon(G.vorlesen), zahl,
          h('button.insel-chip__x', { type: 'button', 'aria-label': 'Vorlesen beenden', title: 'Beenden', onClick: () => vorlesenStopp() }, icon(G.zu)));
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
      const da = verlaufEl.querySelector('.insel-leer');
      const key = leerSchluessel();
      if (!da || da.dataset.key !== key) {
        clear(verlaufEl);
        verlaufEl.appendChild(leerZustand(key));
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

  function leerSchluessel() {
    return [L.teilenMoeglich(window), mikrofonMoeglich(hostFenster()), !!state.get('aus')].join('|');
  }

  function leerZustand(key) {
    const wege = [];
    if (mikrofonMoeglich(hostFenster())) {
      wege.push(weg(G.live, 'Live sprechen', 'Wir reden einfach – ich höre zu und antworte.', () => liveAn()));
    }
    wege.push(weg(G.termin, 'Was steht heute an?', 'Termine und offene Aufgaben, kurz.', () => vorlageNutzen(L.VORLAGEN.find((v) => v.id === 'heute'))));
    wege.push(weg(G.ablage, 'Erklär mir, was ich kopiert habe', 'Text oder Bild aus jedem Programm – Strg+C genügt.', () => vorlageNutzen(L.VORLAGEN.find((v) => v.id === 'erklaeren'))));
    if (L.teilenMoeglich(window)) {
      wege.push(weg(G.bildschirm, 'Bildschirm zeigen', 'Dann sehe ich, was du in einem anderen Programm vor dir hast.', () => teilenStarten()));
    } else {
      wege.push(weg(G.timer, '„Timer 5 min“', 'Timer, Notizen und Erinnerungen gehen sofort.', () => { z.timerWahl = true; planen(); }));
    }
    return h('div.insel-leer', { dataset: { key } },
      h('p.insel-leer__satz', null, text('Ich kenne deine Notizen, Termine und Projekte, schlage für dich nach und trage für dich ein.')),
      h('ul.insel-leer__wege', null, ...wege.map((w) => h('li', null, w))),
      h('p.insel-leer__hinweis', null, icon(G.klammer), h('span', null, text('Zieh eine Datei auf mich – ich lese sie.'))));
  }

  function weg(glyphe, titel, satz, run) {
    return h('button.insel-weg', { type: 'button', onClick: () => run() }, icon(glyphe),
      h('span', null, text(titel), h('small', null, text(satz))));
  }

  function eintragAufbauen(e) {
    const el = h('article.insel-eintrag', { dataset: { eintrag: e.id } });
    e._frage = h('div.insel-frage');
    e._schritte = h('div.insel-schritte');
    e._antwort = h('div.insel-antwort');
    e._rueck = h('div');
    e._wirkung = h('div.insel-wirkung', { hidden: true });
    e._quellen = h('div.insel-quellen');
    e._notizen = h('div.insel-notizen');
    e._zustand = h('div.insel-zustand', { hidden: true });
    e._aktionen = h('div.insel-aktionen', { hidden: true });
    el.append(e._frage, e._schritte, e._antwort, e._rueck, e._wirkung, e._quellen, e._notizen, e._zustand, e._aktionen);
    // Verweise in der Antwort: innere ("#/…") fuehren in Neural OS, nie im schwebenden Fenster.
    el.addEventListener('click', (ev) => {
      const t = ev.target;
      const bild = t && t.closest ? t.closest('img.md-image') : null;
      if (bild && z.modus === 'seite') {
        const alle = [...e._antwort.querySelectorAll('img.md-image')].map((b) => ({ src: b.currentSrc || b.src, name: b.alt || 'Bild' }));
        leuchtkasten({ bilder: alle, start: Math.max(0, [...e._antwort.querySelectorAll('img.md-image')].indexOf(bild)) });
        return;
      }
      const a = t && t.closest ? t.closest('a[href]') : null;
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
    // Die Frage (und Bilder, Dateien, das Bild vom Bildschirm, sobald es da ist)
    const fKey = `${e.frage}|${(e.bilder || []).map((b) => b.src).join('|')}|${(e.dateien || []).map((d) => d.name).join('|')}`;
    if (e._fKey !== fKey) {
      e._fKey = fKey;
      clear(e._frage);
      if (e.bilder && e.bilder.length) {
        const liste = e.bilder.slice(0, 4).map((b) => ({ src: absolut(b.src), name: b.name || 'Bild' }));
        e._frage.appendChild(h('div.insel-frage__bilder', null, ...liste.map((b, i) => h('button.insel-frage__bild', {
          type: 'button',
          'aria-label': `Bild ansehen: ${b.name}`,
          onClick: () => { if (z.modus === 'seite') leuchtkasten({ bilder: liste, start: i }); },
        }, h('img', { src: b.src, alt: b.name, loading: 'lazy' })))));
      }
      if (e.dateien && e.dateien.length) {
        e._frage.appendChild(h('div.insel-frage__bilder', null, ...e.dateien.map((d) => h('span.insel-frage__datei', null,
          icon(d.art === 'text' ? G.ablage : G.notiz), h('span', null, text(d.name))))));
      }
      const t = e.frage || '';
      if (t) e._frage.appendChild(h('div.insel-frage__text', null, text(t)));
    }
    if (e._quelle !== a.text) {
      e._quelle = a.text;
      const o = L.ohneOffenenBaustein(a.text);
      e._baustein = o.baustein;
      e._md = markdownOhneUi(o.text);
    }
    const baustein = e._baustein;
    const zuZeigen = e._md;
    const quellen = Array.isArray(a.quellen) ? a.quellen : [];
    const mdKey = `${zuZeigen}|${quellen.length}`;
    if (e._gezeichnet !== mdKey) {
      e._gezeichnet = mdKey;
      clear(e._antwort);
      if (zuZeigen.trim()) {
        e._antwort.appendChild(renderMarkdown(zuZeigen, { highlight: false, copy: false }));
        verweiseSetzen(e._antwort, quellen);
      }
    }
    const laeuft = z.lauf && z.lauf.eintrag === e;
    // Was die KI unterwegs tut: "Sucht im Internet: …", danach "Gesucht: … · 5 Treffer".
    const saetze = [];
    for (const ag of a.agenten.values()) {
      if (ag.rolle === 'planung') continue;
      const s = L.schrittSatz(ag);
      if (!s) continue;
      if (!laeuft && s.art === 'werkzeug') continue;
      saetze.push(s);
    }
    const sKey = JSON.stringify(saetze);
    if (e._sKey !== sKey) {
      e._sKey = sKey;
      clear(e._schritte);
      for (const s of saetze.slice(-5)) {
        const sym = {
          suche: G.suche, lesen: G.lesen, nachschlagen: G.lesen, wissen: G.wissen, werkzeug: G.agent,
        }[s.art] || G.agent;
        e._schritte.appendChild(h('p.insel-schritt', { class: s.laeuft ? 'is-laeuft' : (s.fehler ? 'is-fehler' : '') },
          icon(s.fehler ? G.hinweis : (s.laeuft ? sym : G.haken)),
          h('span', null, text(s.laeuft ? `${s.text} …` : s.text)),
          s.laeuft ? h('span.insel-schritt__punkt', { 'aria-hidden': 'true' }) : null));
      }
    }
    // Zustand unter der Antwort
    let satz = '';
    let fehler = false;
    if (laeuft) {
      if (baustein) satz = 'Baut einen Baustein …';
      else if (z.lauf.phase !== 'schreibt' && !saetze.some((s) => s.laeuft)) {
        satz = { chat: 'Denkt nach …', bild: 'Schaut auf den Bildschirm …', ablegen: 'Nimmt die Datei …', denkt: 'Denkt nach …' }[z.lauf.phase] || '';
        if (z.lauf.phase === 'werkzeug') satz = z.lauf.schritt || 'Arbeitet …';
      }
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
      if (laeuft) e._zustand.appendChild(aktion(G.stopp, 'Stopp', () => stoppen()));
      if (fehler && a.nichtVerbunden) {
        e._zustand.appendChild(h('button.insel-aktion.is-an', { type: 'button', onClick: () => navigieren('#/chat') }, text('Verbinden')));
      } else if (fehler && a.fehlerCode === 'CLAUDE_GUTHABEN') {
        // Kein Guthaben bei Anthropic: in den Einstellungen geht es kostenlos mit Gemini weiter.
        e._zustand.appendChild(h('button.insel-aktion.is-an', { type: 'button', onClick: () => navigieren('#/settings') }, text('Kostenlos mit Gemini')));
      }
    }
    // Rueckfragen
    const rKey = JSON.stringify([a.rueckfragen.map((f) => [f.id, f.zustand, f.antwort, (f.gewaehlt || []).join('|')]), !!z.lauf]);
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
          ? h('button.insel-chip', { type: 'button', onClick: () => navigieren(w.href) }, ...inhalt)
          : h('span.insel-chip', null, ...inhalt));
      }
    }
    // Quellen (Websuche, eigene Eintraege): klein, mit Nummer und Rechnername.
    const qKey = JSON.stringify([quellen.map((q) => [q.url, q.titel]), !!e._quellenAlle]);
    if (e._qKey !== qKey) {
      e._qKey = qKey;
      clear(e._quellen);
      if (quellen.length) {
        const zeige = e._quellenAlle ? quellen : quellen.slice(0, 4);
        e._quellen.appendChild(h('p.insel-quellen__titel', null, text('Quellen')));
        zeige.forEach((q, i) => {
          const inApp = q.art === 'eintrag' || String(q.url || '').startsWith('#/');
          e._quellen.appendChild(h('a.insel-quelle', inApp
            ? { href: q.url, title: q.titel || '' }
            : { href: q.url, target: '_blank', rel: 'noopener noreferrer', title: q.url },
          h('span.insel-quelle__nr', null, text(String(i + 1))),
          h('span.insel-quelle__titel', null, text(q.titel || q.url)),
          h('span.insel-quelle__host', null, text(inApp ? 'dein Wissen' : L.quelleHost(q.url)))));
        });
        if (quellen.length > 4) {
          e._quellen.appendChild(h('button.insel-mehr', {
            type: 'button',
            onClick: () => { e._quellenAlle = !e._quellenAlle; planen(); },
          }, text(e._quellenAlle ? 'Weniger' : `+ ${quellen.length - 4} weitere`)));
        }
      }
    }
    // Hinweise aus dem Strom ("Ohne Internetsuche: …", "… ist gerade am Limit – es antwortet …"): ruhig, klein.
    const hinweise = Array.isArray(a.hinweise) ? a.hinweise : [];
    const nKey = hinweise.join('\n');
    if (e._nKey !== nKey) {
      e._nKey = nKey;
      clear(e._notizen);
      for (const s of hinweise) e._notizen.appendChild(h('p.insel-notiz', null, icon(G.hinweis), h('span', null, text(s))));
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
        if (vl) e._aktionen.appendChild(aktion(liestDiese ? G.stopp : G.vorlesen, liestDiese ? 'Stopp' : 'Vorlesen', () => vorlesen(e), liestDiese));
        e._aktionen.appendChild(aktion(G.kopieren, 'Kopieren', () => kopieren(markdownOhneUi(a.text))));
        e._aktionen.appendChild(aktion(G.notiz, e.notizId ? 'Notiz öffnen' : 'Als Notiz', () => alsNotiz(e), !!e.notizId));
        if (e.chatId || z.chatId) e._aktionen.appendChild(aktion(G.oeffnen, 'Im Chat öffnen', () => navigieren(`#/chat?id=${encodeURIComponent(e.chatId || z.chatId)}`)));
      }
    }
  }

  function aktion(glyphe, label, run, an = false) {
    return h('button.insel-aktion', { type: 'button', class: an ? 'is-an' : '', onClick: () => run() }, icon(glyphe), h('span', null, text(label)));
  }

  /** "[1]" im Text wird ein kleiner Verweis auf Quelle 1 -- dieselbe Zaehlung wie die Liste darunter. */
  function verweiseSetzen(wurzel, quellen) {
    if (!quellen.length) return;
    const d = wurzel.ownerDocument || document;
    const laeufer = d.createTreeWalker(wurzel, 4, {
      acceptNode(n) {
        const el = n.parentElement;
        if (!el || el.closest('code, pre, a, button')) return 2;
        return /\[\d{1,2}\]/.test(n.nodeValue || '') ? 1 : 3;
      },
    });
    const knoten = [];
    for (let n = laeufer.nextNode(); n; n = laeufer.nextNode()) knoten.push(n);
    for (const n of knoten) {
      const s = n.nodeValue || '';
      const teile = [];
      let pos = 0;
      for (const m of s.matchAll(/\[(\d{1,2})\]/g)) {
        const q = quellen[Number(m[1]) - 1];
        if (!q || !q.url) continue;
        if (m.index > pos) teile.push(d.createTextNode(s.slice(pos, m.index)));
        const inApp = q.art === 'eintrag' || String(q.url).startsWith('#/');
        teile.push(h('a.insel-verweis', {
          href: q.url,
          target: inApp ? null : '_blank',
          rel: inApp ? null : 'noopener noreferrer',
          title: `${m[1]} · ${q.titel || q.url}`,
          'aria-label': `Quelle ${m[1]}: ${q.titel || q.url}`,
        }, text(`[${m[1]}]`)));
        pos = m.index + m[0].length;
      }
      if (!teile.length) continue;
      if (pos < s.length) teile.push(d.createTextNode(s.slice(pos)));
      n.replaceWith(...teile);
    }
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
    hinweisEl.append(icon(G.hinweis), h('span', null, text(hw.satz)));
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

  /**
   * Die Schnellknoepfe -- nur, wenn es etwas gibt, worauf sich "das" bezieht
   * (Anhang, Markierung, geteilter Bildschirm). Ohne steht im leeren
   * Gespraech, was geht; der Timer steht unter "…".
   */
  function zeichneVorlagen() {
    const kontext = !!z.teilen || z.anhaenge.length > 0;
    const zeigen = !z.lauf && !z.sprechen && !z.live && !z.frisst && kontext;
    vorlagenEl.hidden = !zeigen;
    timerWahlEl.hidden = !z.timerWahl || !!z.lauf || !!z.live;
    const bild = !!z.teilen || z.anhaenge.some((a) => a.art === 'bild');
    const key = `${zeigen}|${bild}|${z.timerWahl}`;
    if (vorlagenEl.dataset.key !== key) {
      vorlagenEl.dataset.key = key;
      clear(vorlagenEl);
      if (zeigen) {
        for (const v of L.VORLAGEN) {
          if (v.braucht === 'bild' && !bild) continue;
          if (v.braucht === null) continue;
          vorlagenEl.appendChild(h('button.insel-chip', { type: 'button', onClick: () => vorlageNutzen(v) }, h('span', null, text(v.label))));
        }
      }
    }
    if (timerWahlEl.dataset.key !== String(z.timerWahl)) {
      timerWahlEl.dataset.key = String(z.timerWahl);
      clear(timerWahlEl);
      if (z.timerWahl) {
        timerWahlEl.appendChild(h('span', null, text('Timer:')));
        for (const min of L.TIMER_VORGABEN) {
          timerWahlEl.appendChild(h('button.insel-chip', { type: 'button', onClick: () => { z.timerWahl = false; timerStarten(min * 60000, ''); } }, h('span', null, text(`${min} Min`))));
        }
        timerWahlEl.appendChild(h('small', null, text('Oder schreib zum Beispiel „Timer 8 min Nudeln“.')));
      }
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
        'data-ton': z.bildMit ? 'aufnahme' : null,
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
    knopfMikro.hidden = (!z.sprechen && !weg) || !!z.live;
    knopfMikro.classList.toggle('is-an', !!z.sprechen);
    const mLabel = z.sprechen ? 'Fertig gesprochen – senden' : 'Sprechen';
    if (knopfMikro.getAttribute('aria-label') !== mLabel) {
      knopfMikro.setAttribute('aria-label', mLabel);
      knopfMikro.title = mLabel;
    }
    // Live braucht ein Mikrofon; geht Sprache zu Text hier nicht, sagt der Knopf es beim Antippen.
    knopfLive.hidden = !mikrofonMoeglich(hostFenster());
    knopfLive.setAttribute('aria-pressed', String(!!z.live));
    const lLabel = z.live ? 'Live beenden' : 'Live – sprich mit mir';
    if (knopfLive.getAttribute('aria-label') !== lLabel) knopfLive.setAttribute('aria-label', lLabel);
    const stoppt = !!z.lauf;
    const sLabel = stoppt ? 'Stopp' : 'Senden';
    if (knopfSenden.getAttribute('aria-label') !== sLabel) {
      knopfSenden.setAttribute('aria-label', sLabel);
      knopfSenden.title = sLabel;
      clear(knopfSenden);
      knopfSenden.appendChild(icon(stoppt ? G.stopp : G.senden));
    }
    knopfSenden.classList.toggle('is-stopp', stoppt);
    knopfSenden.classList.toggle('is-bereit', !stoppt && !!(feld.value.trim() || z.anhaenge.length || (z.teilen && z.bildMit)));
    knopfKlammer.disabled = !!z.frisst;
    const platzhalter = z.live ? 'Live ist an – sprich einfach.' : (z.sprechen ? 'Ich höre zu … (Mikrofon antippen: senden)' : (z.teilen && z.bildMit ? 'Frag mich zu deinem Bildschirm …' : 'Frag mich etwas …'));
    if (feld.placeholder !== platzhalter) feld.placeholder = platzhalter;
  }

  /* ------------------------------------------------------- "…" Menue */

  function menueEintraege() {
    const out = [];
    if (L.teilenMoeglich(window)) {
      out.push({ id: 'teilen', glyphe: G.bildschirm, label: z.teilen ? 'Bildschirm nicht mehr zeigen' : 'Bildschirm zeigen', run: () => teilenUmschalten() });
    }
    if (z.modus === 'seite' && L.schwebenMoeglich(window)) {
      out.push({ id: 'schweben', glyphe: G.schweben, label: 'Über allen Fenstern', run: () => schweben() });
    }
    out.push({ id: 'ablage', glyphe: G.ablage, label: 'Aus der Zwischenablage', run: () => ausZwischenablage() });
    out.push({ id: 'timer', glyphe: G.timer, label: 'Timer', run: () => { z.timerWahl = true; planen(); } });
    if (z.verlauf.length && !z.lauf) out.push({ id: 'neu', glyphe: G.neu, label: 'Neues Gespräch', run: () => neuesGespraech() });
    return out;
  }

  function zeichneMenue() {
    knopfMehr.setAttribute('aria-expanded', String(z.menue));
    menue.hidden = !z.menue;
    if (!z.menue) {
      if (menue.dataset.key) {
        menue.dataset.key = '';
        clear(menue);
      }
      return;
    }
    const eintraege = menueEintraege();
    const key = eintraege.map((x) => x.label).join('|');
    if (menue.dataset.key === key) return;
    menue.dataset.key = key;
    clear(menue);
    for (const x of eintraege) {
      menue.appendChild(h('button', {
        type: 'button',
        role: 'menuitem',
        'aria-label': x.id === 'schweben' ? 'Über allen Fenstern – die Insel schwebt über anderen Programmen' : x.label,
        dataset: { eintrag: x.id },
        onClick: (ev) => {
          ev.stopPropagation();
          menueZu({ fokus: false });
          x.run();
        },
      }, icon(x.glyphe), h('span', null, text(x.label))));
    }
  }

  function menueUmschalten() {
    if (z.menue) menueZu({ fokus: true });
    else {
      z.menue = true;
      sofort();
      const erster = menue.querySelector('button');
      if (erster) erster.focus();
    }
  }
  function menueZu({ fokus = false } = {}) {
    if (!z.menue) return;
    z.menue = false;
    sofort();
    if (fokus) knopfMehr.focus();
  }
  menue.addEventListener('keydown', (ev) => {
    const knoepfe = [...menue.querySelectorAll('button')];
    const i = knoepfe.indexOf(ev.target);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = knoepfe.length;
      const j = ev.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      if (knoepfe[j]) knoepfe[j].focus();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      menueZu({ fokus: true });
    } else if (ev.key === 'Tab') {
      menueZu({ fokus: false });
    }
  });

  /* ------------------------------------------------- Lage am Rand */

  const HINDERNIS = 'button, a[href], input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [contenteditable="true"]';

  /** So weit muss Inhalt rollen koennen, damit man einen Knopf unter dem Wesen hervorrollen kann. */
  const ROLLT_WEIT = 160;

  /**
   * Liegt das Element in Inhalt, der WEIT rollt (eine lange Liste, der
   * Verlauf eines Chats)? Dann wandert es mit -- man rollt es unter dem Wesen
   * hervor, es ist kein festes Hindernis. Was nur ein paar Pixel rollt (ein
   * Monat im Kalender), steht praktisch fest und zaehlt.
   */
  function rolltIn(el, grenze, weit = ROLLT_WEIT) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.scrollHeight - p.clientHeight > weit) {
        const oy = getComputedStyle(p).overflowY;
        if (oy === 'auto' || oy === 'scroll') return true;
      }
      if (p === grenze) break;
    }
    return false;
  }

  function dockGroesse() {
    return wesenKnopf.parentNode === dock ? (wesenKnopf.offsetWidth || 60) : (finger() ? 56 : 60);
  }

  /** Was fest steht, auch wenn der Inhalt darum herum rollt: das Eingabefeld des Chats. */
  const FEST = '.cv-composer';

  /**
   * Was von einem Element wirklich zu sehen ist: beschnitten von jedem
   * Elternteil, das seinen Inhalt abschneidet (ein Bereich, der rollt). Was
   * ganz darunter verschwindet, ist kein Hindernis.
   */
  function sichtbarerTeil(el, r, cache) {
    let { top, bottom, left, right } = r;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      let rahmen = cache.get(p);
      if (rahmen === undefined) {
        const cs = getComputedStyle(p);
        rahmen = cs.overflowX === 'visible' && cs.overflowY === 'visible' ? null : p.getBoundingClientRect();
        cache.set(p, rahmen);
      }
      if (!rahmen) continue;
      top = Math.max(top, rahmen.top);
      bottom = Math.min(bottom, rahmen.bottom);
      left = Math.max(left, rahmen.left);
      right = Math.min(right, rahmen.right);
      if (bottom - top < 2 || right - left < 2) return null;
    }
    return { top, bottom, left, right };
  }

  /**
   * Die Bedienelemente, die waagrecht im Streifen [links, rechts] liegen -- als
   * {top, bottom}. Am Telefon sitzt das Wesen unten rechts wie ein schwebender
   * Knopf: dort zaehlt vom Inhalt nur, was gar nicht rollt (und das
   * Eingabefeld) -- alles andere rollt man darunter hervor.
   */
  function hindernisseIm(band, groesse, hoehe, telefon = false) {
    const view = document.getElementById('view');
    const out = [];
    const cache = new Map();
    const weit = telefon ? 4 : ROLLT_WEIT;
    const nehmen = (r) => {
      if (!r || r.bottom - r.top < 1 || r.right - r.left < 1) return;
      if (r.right <= band.links || r.left >= band.rechts || r.bottom <= 0 || r.top >= hoehe) return;
      out.push({ top: r.top, bottom: r.bottom });
    };
    // Was ueber dem Wesen liegt, verdeckt es ohnehin (ein Dialog, eine Meldung, eine aufgeklappte
    // Schublade unter 1000 px): danach richtet es sich nicht -- sonst bliebe es danach an einer seltsamen Stelle.
    const darueber = window.innerWidth < 1000 ? '#overlays, .overlay, .toasts, .lk, .rail, .aside' : '#overlays, .overlay, .toasts, .lk';
    for (const el of document.querySelectorAll(HINDERNIS)) {
      if (dock.contains(el) || panel.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.right <= band.links || r.left >= band.rechts || r.bottom <= 0 || r.top >= hoehe) continue;
      if (el.closest(darueber)) continue;
      // Grosse Flaechen (die Vorschau des Gehirns, ein Editor) sind keine Knoepfe -- daneben bleibt
      // genug zum Tippen. Ein Tag im Kalender (gut 100 x 120 px) ist ein Knopf.
      if (r.height > groesse * 3 && r.width * r.height > groesse * groesse * 6) continue;
      if (view && view.contains(el) && !el.closest(FEST) && rolltIn(el, view, weit)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
      nehmen(sichtbarerTeil(el, r, cache));
    }
    for (const el of document.querySelectorAll(FEST)) nehmen(el.getBoundingClientRect());
    return out;
  }

  /**
   * Das Wesen an seinen Platz: unteres Drittel der Mitte (am Telefon unten),
   * nie auf einem Knopf (lib/insel-logik.js dockLage). Erst mit seinen
   * Schildern und Kapseln; ist dafuer nirgends Platz, wenigstens das Wesen --
   * die Kapsel liegt dann wie eine Mitteilung kurz ueber dem Inhalt.
   */
  function dockPlatzieren() {
    if (!lebt || dock.hidden) return;
    const breite = window.innerWidth;
    const hoehe = window.innerHeight;
    const groesse = dockGroesse();
    const rand = L.LAGE.RAND;
    const telefon = breite < L.LAGE.TELEFON_BIS;
    const unten = telefon ? 12 : rand;
    const kr = kopf ? kopf.getBoundingClientRect() : null;
    const oben = Math.max(12, (kr && kr.height ? kr.bottom : 64) + 8);
    const hatSeite = !dockSeite.hidden && dock.dataset.aus !== 'ja' && (schilder.childElementCount > 0 || kapseln.childElementCount > 0);
    const seite = hatSeite ? dockSeite.getBoundingClientRect() : { width: 0, height: 0 };
    const versuche = [];
    if (hatSeite) versuche.push({ art: 'ganz', links: breite - rand - groesse - seite.width - 10, box: Math.max(groesse, Math.round(seite.height)) });
    versuche.push({ art: hatSeite ? 'wesen' : 'ganz', links: breite - rand - groesse, box: groesse });
    let y = null;
    let frei = 'nein';
    for (const v of versuche) {
      const versatz = (v.box - groesse) / 2;
      const lage = L.dockLage({
        hoehe,
        telefon,
        groesse: v.box,
        oben,
        unten,
        hindernisse: hindernisseIm({ links: v.links, rechts: breite - rand + 1 }, groesse, hoehe, telefon),
        // Nach einem Wechsel der Ansicht (oder der Fenstergroesse) zurueck an die Wunschstelle, wenn sie frei ist.
        aktuell: lageFrisch || z.dockY === null ? null : z.dockY - versatz,
      });
      if (lage.frei || v === versuche[versuche.length - 1]) {
        y = Math.round(lage.y + versatz);
        frei = lage.frei ? v.art : 'nein';
        break;
      }
    }
    // Die Seite (Schilder, Kapseln) darf oben und unten nicht aus dem Fenster ragen.
    const halb = Math.max(0, (seite.height - groesse) / 2);
    y = Math.round(Math.min(Math.max(y, halb + 4), Math.max(halb + 4, hoehe - groesse - halb - 4)));
    lageFrisch = false;
    if (z.dockY !== y) {
      z.dockY = y;
      dock.style.setProperty('--dock-y', `${y}px`);
    }
    dock.dataset.frei = frei;
  }
  let lageFrisch = true;
  /** Eine neue Ansicht oder eine andere Fenstergroesse: dann darf das Wesen an seine Wunschstelle zurueck. */
  function lageNeu(ms) {
    lageFrisch = true;
    lagePlanen(ms);
  }

  /**
   * Neu nachsehen, wo das Wesen sitzt -- gebuendelt, aber nie endlos
   * verschoben: aendert sich eine Ansicht staendig (eine Uhr, ein Strom),
   * bleibt der erste geplante Zeitpunkt; nur ein frueherer ersetzt ihn.
   */
  let lageUhr = null;
  let lageBis = 0;
  function lagePlanen(ms = 160) {
    const bis = Date.now() + ms;
    if (lageUhr !== null && bis >= lageBis) return;
    clearTimeout(lageUhr);
    lageBis = bis;
    lageUhr = setTimeout(() => { lageUhr = null; dockPlatzieren(); }, ms);
  }

  /** Die Spur am Rand (web/app.css-Raster): nur, solange das Wesen in der Seite sitzt. */
  let spurUhr = null;
  function spurSetzen() {
    if (!shell) return;
    // Nicht an dock.hidden haengen: geht das Feld auf, soll nichts im Raster springen.
    const an = lebt && !state.get('pin');
    const vorher = shell.dataset.insel === 'spur';
    if (an && !vorher) shell.dataset.insel = 'spur';
    else if (!an && shell.dataset.insel) delete shell.dataset.insel;
    if (an !== vorher && lebt) {
      // Das Raster bewegt sich 200 ms (web/app.css): danach noch einmal nachsehen.
      clearTimeout(spurUhr);
      spurUhr = setTimeout(() => lageNeu(10), 340);
    }
  }

  function panelPlatzieren() {
    if (z.modus !== 'seite') return;
    const p = L.panelLage({ breite: window.innerWidth, hoehe: window.innerHeight });
    panel.dataset.art = p.art;
    if (p.art === 'blatt') {
      for (const k of ['right', 'bottom', 'width']) panel.style[k] = '';
      panel.style.height = `${p.hoehe}px`;
      return;
    }
    panel.style.right = `${p.rechts}px`;
    panel.style.bottom = `${p.unten}px`;
    panel.style.width = `${p.breite}px`;
    panel.style.height = `${p.hoehe}px`;
  }

  /* -------------------------------------------- Auf, zu, schweben */

  /** Das Wesen getippt: unterbricht, wenn es spricht; sonst auf oder zu. */
  function wesenGetippt() {
    if (state.get('aus')) return;
    if (z.timer.length) klangVorbereiten();
    if (z.live && z.live.phase === 'spricht') {
      liveUnterbrechen();
      return;
    }
    if (z.live && z.live.phase === 'hoert' && (z.offen || (z.modus === 'fenster' && z.gross))) {
      liveFertigGesprochen();
      return;
    }
    if (!z.live && z.liest && (z.offen || z.modus === 'fenster')) {
      vorlesenStopp();
      return;
    }
    if (z.modus === 'fenster') {
      fensterGroesse(!z.gross);
      return;
    }
    if (z.offen) schliessen({ fokus: true });
    else oeffnen({ fokus: true });
  }

  function oeffnen({ fokus = true } = {}) {
    if (!lebt || state.get('aus')) return;
    if (z.modus === 'fenster') {
      if (!z.gross) fensterGroesse(true);
      try { z.fenster.focus(); } catch { /* der Browser entscheidet */ }
      if (fokus) feld.focus();
      return;
    }
    if (z.offen) {
      if (fokus && !finger()) feld.focus();
      return;
    }
    markierungMerken();
    const vorher = wesenKnopf.getBoundingClientRect();
    z.offen = true;
    z.ungesehen = null;
    wesenKnopf.setAttribute('aria-expanded', 'true');
    panelPlatzieren();
    panel.hidden = false;
    wesenPlatz.appendChild(wesenKnopf);
    kapselPlatz.appendChild(kapseln);
    dock.hidden = true;
    verlaufLaden();
    kiInfoLaden();
    sofort();
    verlaufEl.scrollTop = z.verlauf.length ? verlaufEl.scrollHeight : 0;
    wachsen(vorher, true);
    if (fokus && !finger()) feld.focus();
  }

  function schliessen({ fokus = false } = {}) {
    if (!z.offen || z.modus !== 'seite') return;
    const vorher = wesenKnopf.getBoundingClientRect();
    z.offen = false;
    z.timerWahl = false;
    z.menue = false;
    wesenKnopf.setAttribute('aria-expanded', 'false');
    dock.hidden = false;
    dock.insertBefore(wesenKnopf, dockSeite);
    dockSeite.insertBefore(kapseln, schilder);
    ablageEl.hidden = true;
    sofort();
    dockPlatzieren();
    const nach = wesenKnopf.getBoundingClientRect();
    flip(wesenKnopf, vorher, nach, 360);
    zuklappen(nach).then(() => {
      if (!z.offen) panel.hidden = true;
    });
    if (fokus) wesenKnopf.focus();
  }

  /** Das Wesen waechst vom Rand nach oben ins Feld, das Feld klappt aus ihm auf. */
  function wachsen(vorher, auf) {
    const nach = wesenKnopf.getBoundingClientRect();
    flip(wesenKnopf, vorher, nach, 420);
    if (!auf || reduziert() || typeof panel.animate !== 'function') return;
    const p = panel.getBoundingClientRect();
    if (!p.width || !vorher.width) return;
    const von = `inset(${Math.max(0, vorher.top - p.top)}px ${Math.max(0, p.right - vorher.right)}px ${Math.max(0, p.bottom - vorher.bottom)}px ${Math.max(0, vorher.left - p.left)}px round ${vorher.width / 2}px)`;
    try {
      const anim = panel.animate([{ clipPath: von, opacity: 0.2 }, { clipPath: 'inset(0px 0px 0px 0px round 28px)', opacity: 1 }], {
        duration: 420, easing: 'cubic-bezier(0.2, 0.85, 0.25, 1)', fill: 'both',
      });
      anim.finished.catch(() => {}).then(() => { try { anim.cancel(); } catch { /* vorbei */ } });
    } catch { /* ohne Bewegung */ }
  }

  function zuklappen(ziel) {
    if (reduziert() || typeof panel.animate !== 'function') return Promise.resolve();
    const p = panel.getBoundingClientRect();
    if (!p.width || !ziel.width) return Promise.resolve();
    const nach = `inset(${Math.max(0, ziel.top - p.top)}px ${Math.max(0, p.right - ziel.right)}px ${Math.max(0, p.bottom - ziel.bottom)}px ${Math.max(0, ziel.left - p.left)}px round ${ziel.width / 2}px)`;
    try {
      const anim = panel.animate([{ clipPath: 'inset(0px 0px 0px 0px round 28px)', opacity: 1 }, { clipPath: nach, opacity: 0 }], {
        duration: 300, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards',
      });
      return anim.finished.catch(() => {}).then(() => { try { anim.cancel(); } catch { /* vorbei */ } });
    } catch {
      return Promise.resolve();
    }
  }

  /** FLIP: dasselbe Element, von seiner alten Stelle und Groesse an die neue. */
  function flip(el, vorher, nach, ms) {
    if (reduziert() || typeof el.animate !== 'function' || !vorher.width || !nach.width) return;
    const s = vorher.width / nach.width;
    const dx = vorher.left - nach.left;
    const dy = vorher.top - nach.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(s - 1) < 0.01) return;
    try {
      el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${s})`, transformOrigin: '0 0' },
        { transform: 'none', transformOrigin: '0 0' },
      ], { duration: ms, easing: 'cubic-bezier(0.3, 1.15, 0.4, 1)' });
    } catch { /* ohne Bewegung */ }
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
    // Was mit dem Mikrofon dieser Seite lief, gehoert nicht ins neue Fenster.
    if (z.live) liveAus();
    if (z.sprechen) sprechenAbbrechen();
    fensterEinrichten(w);
    z.fenster = w;
    z.modus = 'fenster';
    z.gross = true;
    z.offen = false;
    z.menue = false;
    wesenKnopf.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    for (const k of ['right', 'bottom', 'width', 'height']) panel.style[k] = '';
    delete panel.dataset.art;
    wesenPlatz.appendChild(wesenKnopf);
    kapselPlatz.appendChild(kapseln);
    w.document.body.append(panel);
    dock.hidden = false;
    dockSeite.hidden = true;
    schwebtKnopf.hidden = false;
    w.addEventListener('pagehide', zurueckGeholt, { once: true });
    w.document.addEventListener('keydown', tasteImFenster);
    w.document.addEventListener('pointermove', zeigerBewegt, { passive: true });
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
    wesenStil(d);
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
    } else if (ev.key === 'Escape') {
      if (z.menue) {
        ev.preventDefault();
        menueZu({ fokus: true });
      } else if (z.live) {
        ev.preventDefault();
        liveAus();
      } else if (z.gross && !z.sprechen) {
        ev.preventDefault();
        fensterGroesse(false);
      }
    }
  }

  function fensterGroesse(gross) {
    if (z.modus !== 'fenster' || !z.fenster) return;
    z.gross = gross;
    z.menue = false;
    z.fenster.document.body.classList.toggle('is-klein', !gross);
    wesenKnopf.setAttribute('aria-expanded', String(gross));
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
    z.menue = false;
    if (w) {
      try {
        w.document.removeEventListener('keydown', tasteImFenster);
        w.document.removeEventListener('pointermove', zeigerBewegt);
      } catch { /* weg */ }
    }
    // Spracherkennung, Aufnahme und Live hingen am Fenster.
    if (z.live) liveAus();
    if (z.sprechen) sprechenAbbrechen();
    document.body.appendChild(panel);
    panel.hidden = true;
    dock.insertBefore(wesenKnopf, dockSeite);
    dockSeite.insertBefore(kapseln, schilder);
    dockSeite.hidden = false;
    wesenKnopf.setAttribute('aria-expanded', 'false');
    schwebtKnopf.hidden = true;
    dock.hidden = false;
    taktStarten();
    sofort();
    lagePlanen(30);
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

  /** Das Wesen schaut verwirrt (und schuettelt auf Wunsch den Kopf) -- mit dem Satz, warum. */
  function verwirrt(satz, { schuetteln = false } = {}) {
    z.verwirrtBis = Date.now() + L.VERWIRRT_MS;
    z.verwirrtSatz = satz || '';
    if (schuetteln) wesen.geste('schuetteln', 720);
    planen();
    setTimeout(planen, L.VERWIRRT_MS + 30);
  }

  function freuen() {
    z.freutBis = Date.now() + L.FREUT_MS;
    planen();
    setTimeout(planen, L.FREUT_MS + 30);
  }

  /* ---------------------------------------------- Markierung, Ablage */

  function markierungMerken() {
    try {
      const sel = window.getSelection();
      const t = sel ? String(sel.toString() || '').trim() : '';
      if (!t || t.length < 3) return;
      const knoten = sel.anchorNode;
      if (knoten && (panel.contains(knoten) || dock.contains(knoten))) return;
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
      return false;
    }
    z.anhaenge.push(a);
    planen();
    return true;
  }

  function anhangWeg(a) {
    z.anhaenge = z.anhaenge.filter((x) => x !== a);
    if (a.url && a.url.startsWith('blob:')) {
      // Die Vorschau im Verlauf braucht die Adresse nicht mehr, wenn nichts gesendet wurde.
      try { URL.revokeObjectURL(a.url); } catch { /* egal */ }
    }
    planen();
  }

  /**
   * Eine Datei fuer die naechste Frage vorbereiten: Bilder (zu gross:
   * verkleinert), PDF, Text (im Browser gelesen). Nie geraten -- was nicht
   * geht, kommt mit seinem Satz zurueck.
   * @returns {Promise<{anhang?:object, satz?:string}>}
   */
  async function vorbereiten(datei, p) {
    const name = datei.name || (p.art === 'bild' ? 'Bild.png' : (p.art === 'pdf' ? 'Dokument.pdf' : 'Text.txt'));
    try {
      if (p.art === 'text') {
        const inhalt = await datei.text();
        if (!inhalt.trim()) return { satz: `„${L.kurzText(name, 48)}“ ist leer.` };
        return { anhang: { art: 'text', name, text: inhalt, max: L.MAX_DATEI_ZEICHEN, datei: true } };
      }
      if (p.art === 'bild') {
        const fertig = await bildVorbereiten(datei, { name, mime: p.mime });
        return { anhang: { art: 'bild', name: fertig.name, mime: fertig.mime, datei: fertig.datei, url: URL.createObjectURL(fertig.datei) } };
      }
      return { anhang: { art: 'pdf', name, mime: p.mime, datei } };
    } catch (err) {
      return { satz: (err && err.message) || `„${L.kurzText(name, 48)}“ ließ sich nicht lesen.` };
    }
  }

  /**
   * Das Wesen isst Dateien: Maul auf, die Datei fliegt hinein, es kaut --
   * dann haengt sie an der Frage. `senden`: danach gleich auswerten (mit dem
   * getippten Text, sonst "Werte diese Datei aus.").
   */
  let isstGerade = Promise.resolve();
  function fuettern(liste, opts = {}) {
    isstGerade = isstGerade.then(() => essen(liste, opts)).catch(() => {});
    return isstGerade;
  }

  async function essen(liste, { von = null, senden = true } = {}) {
    const dateien = [...(liste || [])].filter(Boolean);
    if (!dateien.length || !lebt || state.get('aus')) return;
    const gut = [];
    const saetze = [];
    let frei = MAX_JE_NACHRICHT - z.anhaenge.filter((a) => a.art !== 'text').length;
    for (const d of dateien) {
      const p = L.dateiPruefen({ name: d.name, type: d.type, size: d.size });
      if (!p.art) {
        saetze.push(p.satz);
        continue;
      }
      if (p.art !== 'text') {
        if (frei <= 0) {
          saetze.push(`Höchstens ${MAX_JE_NACHRICHT} Bilder und PDFs je Frage – „${L.kurzText(d.name || 'Datei', 40)}“ bleibt draußen.`);
          continue;
        }
        frei -= 1;
      }
      gut.push({ d, p });
    }
    if (!gut.length) {
      wesen.geste(null);
      verwirrt(saetze[0], { schuetteln: true });
      melden(saetze.join(' '), 'fehler');
      return;
    }
    z.frisst = { seit: Date.now(), datei: gut[0].d.name || 'Datei' };
    wesen.geste(null);
    sofort();
    const arbeit = gut.map(({ d, p }) => vorbereiten(d, p));
    // Direkt aufs Wesen fallen gelassen: die Datei kommt trotzdem sichtbar von oben links angeflogen.
    const maul = wesen.maulPunkt();
    const start = von && Math.hypot(von.x - maul.x, von.y - maul.y) > 70 ? von : { x: maul.x - 86, y: maul.y - 64 };
    const kauen = senden ? 820 : 480;
    const verdaut = senden ? 620 : 380;
    for (let i = 0; i < gut.length; i += 1) {
      const { d, p } = gut[i];
      const vorschau = p.art === 'bild' ? URL.createObjectURL(d) : null;
      const ab = { x: start.x + (i % 3) * 18 - 18, y: start.y - Math.floor(i / 3) * 14 };
      const flug = wesen.essen({ von: ab, bild: vorschau, kuerzel: L.dateiKuerzel(d.name, p.art) });
      if (vorschau) flug.then(() => { try { URL.revokeObjectURL(vorschau); } catch { /* egal */ } });
      if (i < gut.length - 1) await new Promise((r) => setTimeout(r, 170));
      else await flug;
    }
    await wesen.geste('kauen', kauen);
    const fertig = await Promise.all(arbeit);
    const dazu = [];
    for (const f of fertig) {
      if (f.anhang && anhangDazu(f.anhang)) dazu.push(f.anhang);
      else if (f.satz) saetze.push(f.satz);
    }
    if (dazu.length) await wesen.geste('verdaut', verdaut);
    z.frisst = null;
    if (saetze.length) {
      if (!dazu.length) verwirrt(saetze[0], { schuetteln: true });
      melden(saetze.join(' '), 'fehler');
    }
    sofort();
    if (!dazu.length || !senden) return;
    if (z.lauf) {
      melden(dazu.length === 1 ? 'Die Datei hängt an deiner nächsten Frage – ich antworte gerade noch.' : 'Die Dateien hängen an deiner nächsten Frage – ich antworte gerade noch.', 'info');
      return;
    }
    if (z.modus === 'seite' && !z.offen) oeffnen({ fokus: false });
    const getippt = feld.value.trim();
    fragen(getippt || L.dateienAuftrag(dazu.length), { ausFeld: !!getippt, dateienAuftrag: !getippt });
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
    if (r.bild) await fuettern([r.bild], { senden: false, von: mitteVon(feld) });
    else if (r.text) anhangDazu({ art: 'text', name: 'Aus der Zwischenablage', text: r.text.slice(0, L.MAX_KONTEXT_ZEICHEN) });
    else if (r.leer) melden('In der Zwischenablage ist nichts. Kopier zuerst etwas (Strg+C).', 'info');
    else if (r.fehler) melden(r.fehler, 'fehler');
    try { feld.focus(); } catch { /* egal */ }
  }

  function mitteVon(el) {
    const r = el.getBoundingClientRect();
    return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
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

  /* ------------------------------------------- Sprechen (Mikrofon) */

  function sprechWegJetzt() {
    return sprechWeg({ transkribieren: !!(z.kiInfo && z.kiInfo.transkribieren), nurAufnahme: z.nurAufnahme }, hostFenster());
  }

  /** Den Pegel eines offenen Mikrofons am Ring zeigen. */
  function pegelZeigen(p) {
    wesen.pegel(p);
  }

  function sprechenUmschalten() {
    if (z.live) return;
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

  /** Die Erkennung des Browsers -- dazu das Ohr nur fuer den Ring (geht es nicht auf, geht es auch ohne). */
  function erkennungLos() {
    const vorher = feld.value;
    const sitzung = { weg: 'erkennung', seit: Date.now(), vorher: vorher && !/\s$/.test(vorher) ? `${vorher} ` : vorher, erkannt: false, fehler: null };
    z.sprechen = sitzung;
    z.sprechText = '';
    ohrOeffnen({ w: hostFenster(), aufnehmen: false, onPegel: pegelZeigen, onEreignis: (e) => { if (e === 'grenze' && z.sprechen === sitzung) sprechenFertig(); } })
      .then((ohr) => {
        if (z.sprechen !== sitzung) ohr.abbrechen();
        else sitzung.ohr = ohr;
      })
      .catch(() => { /* der Ring bleibt still; erkannt wird trotzdem */ });
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
          if (sitzung.ohr) sitzung.ohr.abbrechen();
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
      if (sitzung.ohr) sitzung.ohr.abbrechen();
      z.nurAufnahme = true;
      if (sprechWegJetzt() === 'aufnahme') {
        aufnahmeLos();
        return;
      }
      melden('Die Spracherkennung ließ sich nicht starten.', 'fehler');
    }
    planen();
  }

  /** Ohne Erkennung (Opera): aufnehmen, Gemini schreibt um. */
  async function aufnahmeLos() {
    const sitzung = { weg: 'aufnahme', seit: Date.now() };
    z.sprechen = sitzung;
    z.sprechText = '';
    planen();
    let ohr;
    try {
      ohr = await ohrOeffnen({
        w: hostFenster(),
        aufnehmen: true,
        onPegel: pegelZeigen,
        onEreignis: (e) => {
          if (z.sprechen !== sitzung) return;
          if (e === 'grenze') sprechenFertig();
          else if (e === 'weg') sprechenAbbrechen();
        },
      });
    } catch (err) {
      if (z.sprechen === sitzung) z.sprechen = null;
      melden(mikrofonFehlerSatz(err), 'fehler');
      verwirrt(mikrofonFehlerSatz(err));
      return;
    }
    if (z.sprechen !== sitzung) {
      ohr.abbrechen();
      return;
    }
    sitzung.aufnahme = ohr;
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
      t = await umschreiben(wav);
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

  /** Eine Aufnahme als Text (Gemini, POST /api/ki/transkribieren). */
  async function umschreiben(wav) {
    const r = await api.post('/ki/transkribieren', { audio: bytesAlsBase64(wav), ...(z.chatId ? { chatId: z.chatId } : {}) }, { timeoutMs: 90000 });
    return String((r && r.text) || '').trim();
  }

  function sprechenAbbrechen() {
    const s = z.sprechen;
    z.sprechen = null;
    if (!s) return;
    try {
      if (s.erkennung) s.erkennung.abbrechen();
      if (s.aufnahme) s.aufnahme.abbrechen();
      if (s.ohr) s.ohr.abbrechen();
    } catch { /* schon aus */ }
    wesen.pegel(0);
    planen();
  }

  /* ---------------------------------------------------------- Live */

  function liveUmschalten() {
    if (z.live) liveAus();
    else liveAn();
  }

  /** Live an: geht es hier ueberhaupt? Sonst ein ehrlicher Satz, und es bleibt beim Tippen. */
  async function liveAn() {
    if (z.live || !lebt || state.get('aus')) return;
    klangVorbereiten();
    if (!z.kiInfo) await kiInfoLaden();
    const w = hostFenster();
    const m = L.liveMoeglich({ sicher: w.isSecureContext !== false, mikrofon: mikrofonMoeglich(w), weg: sprechWegJetzt() });
    if (!m.ok) {
      verwirrt(m.satz);
      melden(m.satz, 'fehler', { label: 'Einstellungen', run: () => navigieren('#/settings') });
      return;
    }
    if (z.sprechen) sprechenAbbrechen();
    if (vl && z.liest) vl.stopp();
    z.live = { phase: L.liveSchritt(null, 'an'), seit: Date.now(), runde: 0, text: '' };
    if (z.modus === 'seite' && !z.offen) oeffnen({ fokus: false });
    sofort();
    liveHoeren();
  }

  /** Live aus: Mikrofon zu, Vorlesen aus. */
  function liveAus(satz = null) {
    const l = z.live;
    if (!l) return;
    z.live = null;
    liveOhrZu(l);
    if (vl && z.liest) vl.stopp();
    wesen.pegel(0);
    if (satz) melden(satz, 'info');
    sofort();
  }

  function liveOhrZu(l) {
    try {
      if (l.erkennung) l.erkennung.abbrechen();
    } catch { /* aus */ }
    try {
      if (l.ohr) l.ohr.abbrechen();
    } catch { /* aus */ }
    l.erkennung = null;
    l.ohr = null;
  }

  /** Ein Schritt im Gespraech (lib/insel-logik.js liveSchritt); null heisst: Live ist aus. */
  function liveWeiter(ereignis) {
    const l = z.live;
    if (!l) return null;
    const neu = L.liveSchritt(l.phase, ereignis);
    if (neu === null) {
      liveAus();
      return null;
    }
    l.phase = neu;
    planen();
    return neu;
  }

  /** Zuhoeren: ein Ohr (Ring und Stille), dazu die Erkennung des Browsers -- oder eine Aufnahme fuer Gemini. */
  async function liveHoeren() {
    const l = z.live;
    if (!l) return;
    liveOhrZu(l);
    l.phase = 'hoert';
    l.runde += 1;
    l.text = '';
    l.fertigText = '';
    l.erkFehler = null;
    l.rundeSeit = Date.now();
    const runde = l.runde;
    const w = hostFenster();
    l.weg = sprechWegJetzt();
    planen();
    let ohr;
    try {
      // Immer mit Aufnahme: kann die Erkennung des Browsers es doch nicht (Opera), geht das Gesagte nicht verloren.
      ohr = await ohrOeffnen({ w, aufnehmen: true, onPegel: pegelZeigen, onEreignis: (e) => liveGehoert(runde, e) });
    } catch (err) {
      if (z.live !== l || l.runde !== runde) return;
      const satz = mikrofonFehlerSatz(err);
      liveWeiter('mikrofonFehler');
      verwirrt(satz);
      melden(satz, 'fehler');
      return;
    }
    if (z.live !== l || l.runde !== runde) {
      ohr.abbrechen();
      return;
    }
    l.ohr = ohr;
    if (l.weg === 'erkennung') liveErkennungStarten(l, runde, w);
    planen();
  }

  function liveErkennungStarten(l, runde, w) {
    try {
      l.erkennung = erkennungStarten({
        onText: (fertig, vorlaeufig) => {
          if (z.live !== l || l.runde !== runde) return;
          l.text = [fertig, vorlaeufig].filter(Boolean).join(' ');
          l.fertigText = fertig;
          planen();
        },
        onFehler: (code) => {
          if (z.live === l && l.runde === runde) l.erkFehler = code;
        },
        onEnde: () => liveErkennungEnde(l, runde),
      }, w);
    } catch {
      // Die Erkennung gibt es nur dem Namen nach: die Aufnahme laeuft schon.
      l.erkennung = null;
      z.nurAufnahme = true;
      l.weg = 'aufnahme';
    }
  }

  /** Was das Ohr meldet: Sprache begann, Stille danach (fertig), die Minute ist um, nichts gehoert. */
  function liveGehoert(runde, ereignis) {
    const l = z.live;
    if (!l || l.runde !== runde || l.phase !== 'hoert') return;
    if (ereignis === 'sprache') {
      planen();
      return;
    }
    if (ereignis === 'weg') {
      liveAus('Das Mikrofon ist weg – Live ist aus.');
      return;
    }
    if (ereignis === 'nichts') {
      liveWeiter('nichtsGehoert');
      melden('Live ist aus – ich habe eine Minute lang nichts gehört.', 'info');
      return;
    }
    // 'stille' oder 'grenze': fertig gesprochen.
    liveFertigGesprochen();
  }

  /** Fertig gesprochen (Stille, oder das Wesen wurde angetippt). */
  async function liveFertigGesprochen() {
    const l = z.live;
    if (!l || l.phase !== 'hoert') return;
    const runde = l.runde;
    liveWeiter('stille');
    if (l.weg === 'erkennung' && l.erkennung) {
      // Die Erkennung liefert ihr letztes Wort, dann kommt onEnde.
      try { l.erkennung.stopp(); } catch { liveErkennungEnde(l, runde); }
      return;
    }
    const ohr = l.ohr;
    l.ohr = null;
    if (!ohr) {
      liveWeiter('nichtVerstanden');
      liveHoeren();
      return;
    }
    let t = '';
    try {
      const { wav, sekunden, abgebrochen, gesprochen } = await ohr.stopp();
      if (z.live !== l || l.runde !== runde) return;
      if (abgebrochen) return;
      if (!gesprochen || sekunden < 0.3) {
        liveWeiter('nichtVerstanden');
        liveHoeren();
        return;
      }
      t = await umschreiben(wav);
    } catch (err) {
      if (z.live !== l || l.runde !== runde) return;
      const satz = `Nicht verstanden: ${fehlerSatz(err)}`;
      liveAus();
      verwirrt(satz);
      melden(satz, 'fehler');
      return;
    }
    if (z.live !== l || l.runde !== runde) return;
    if (!t) {
      liveWeiter('nichtVerstanden');
      liveHoeren();
      return;
    }
    liveSenden(t);
  }

  function liveErkennungEnde(l, runde) {
    if (z.live !== l || l.runde !== runde) return;
    const code = l.erkFehler;
    l.erkennung = null;
    const t = String(l.text || '').trim();
    if (code && !t && erkennungUntauglich(code)) {
      // Opera und Co.: die Erkennung gibt es nur dem Namen nach. Die Aufnahme laeuft schon weiter.
      z.nurAufnahme = true;
      l.weg = 'aufnahme';
      if (l.phase === 'versteht') {
        // Schon fertig gesprochen: die Aufnahme umschreiben.
        l.phase = 'hoert';
        liveFertigGesprochen();
      }
      planen();
      return;
    }
    if (l.ohr) {
      l.ohr.abbrechen();
      l.ohr = null;
    }
    if (code && code !== 'no-speech' && code !== 'aborted' && !t) {
      const satz = erkennungFehlerSatz(code) || 'Die Spracherkennung ist gescheitert.';
      liveAus();
      verwirrt(satz);
      melden(satz, 'fehler');
      return;
    }
    if (!t) {
      // Nichts verstanden -- weiter zuhoeren, aber nicht im Kreis, wenn die Erkennung sofort endet.
      if (Date.now() - (l.rundeSeit || 0) < 1500 && (l.leer = (l.leer || 0) + 1) >= 3) {
        liveAus('Die Spracherkennung hört gerade nichts – Live ist aus.');
        return;
      }
      if (l.phase === 'versteht') liveWeiter('nichtVerstanden');
      liveHoeren();
      return;
    }
    l.leer = 0;
    liveSenden(t);
  }

  /** Das Gesagte geht als Frage los; die Antwort wird vorgelesen, dann hoert es wieder zu. */
  async function liveSenden(t) {
    const l = z.live;
    if (!l) return;
    liveWeiter('text');
    l.text = '';
    planen();
    const r = await fragen(t, { live: true });
    if (z.live !== l) return;
    const e = r && r.e;
    if (!e || r.ergebnis !== 'ok' || e.antwort.fehler) {
      if (e && e.antwort.nichtVerbunden) {
        liveWeiter('nichtVerbunden');
        return;
      }
      if (r && r.ergebnis === 'abgebrochen') {
        liveWeiter('antwortFehler');
        liveHoeren();
        return;
      }
      liveWeiter('antwortFehler');
      liveHoeren();
      return;
    }
    const zuLesen = vorleseText(e.antwort.text);
    if (vl && zuLesen && liveWeiter('antwortFertig') === 'spricht') {
      l.liestId = `insel:${e.id}`;
      if (!vl.start(l.liestId, zuLesen)) {
        liveWeiter('vorgelesen');
        liveHoeren();
      }
      return;
    }
    liveWeiter('ohneVorlesen');
    liveHoeren();
  }

  /** Antippen, waehrend es spricht: still sein und zuhoeren. */
  function liveUnterbrechen() {
    const l = z.live;
    if (!l || l.phase !== 'spricht') return;
    liveWeiter('unterbrechen');
    if (vl) vl.stopp();
    liveHoeren();
  }

  /* ---------------------------------------------------- Vorlesen */

  if (vl) {
    offs.push(vl.abonnieren((zs) => {
      const liest = !!(zs && zs.id && String(zs.id).startsWith('insel:'));
      if (liest !== z.liest) {
        z.liest = liest;
        // Fertig vorgelesen, waehrend Live an ist: wieder zuhoeren.
        if (!liest && z.live && z.live.phase === 'spricht') {
          liveWeiter('vorgelesen');
          liveHoeren();
        }
        planen();
      } else if (liest) {
        planen();
      }
    }));
  }

  function vorlesen(e) {
    if (!vl) return;
    if (z.liest && vl.zustand().id === `insel:${e.id}`) {
      vorlesenStopp();
      return;
    }
    vl.start(`insel:${e.id}`, vorleseText(e.antwort.text));
  }

  function vorlesenStopp() {
    if (!vl) return;
    if (z.live && z.live.phase === 'spricht') {
      liveUnterbrechen();
      return;
    }
    vl.stopp();
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
    lagePlanen(60);
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
    lagePlanen(60);
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
    planen();
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
    // Eingefuegt wird beim Schreiben: es isst die Datei, wartet aber auf die Frage.
    fuettern(dateien, { senden: false, von: mitteVon(feld) });
  });
  dateiWahl.addEventListener('change', () => {
    const dateien = [...(dateiWahl.files || [])];
    dateiWahl.value = '';
    if (dateien.length) fuettern(dateien, { von: mitteVon(knopfKlammer) });
  });

  /* Dateien auf das Wesen (zu) oder in das Feld (auf) ziehen. */
  const hatDateien = (ev) => !!(ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes('Files'));
  let ziehUhr = null;
  function ziehenSehen() {
    if (!z.ziehen) {
      z.ziehen = true;
      if (!z.frisst && !state.get('aus')) wesen.geste('hungrig');
    }
    clearTimeout(ziehUhr);
    ziehUhr = setTimeout(ziehenVorbei, 260);
  }
  function ziehenVorbei() {
    clearTimeout(ziehUhr);
    z.ziehen = false;
    if (wesen.el.dataset.geste === 'hungrig') wesen.geste(null);
    dock.classList.remove('is-ablegen');
    ablageEl.hidden = true;
  }
  for (const ziel of [dock, panel]) {
    ziel.addEventListener('dragover', (ev) => {
      if (!hatDateien(ev) || state.get('aus')) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      ziehenSehen();
      if (ziel === dock) dock.classList.add('is-ablegen');
      else ablageEl.hidden = false;
    });
    ziel.addEventListener('drop', (ev) => {
      const dateien = [...((ev.dataTransfer && ev.dataTransfer.files) || [])];
      ziehenVorbei();
      if (!dateien.length) return;
      ev.preventDefault();
      fuettern(dateien, { von: { x: ev.clientX, y: ev.clientY } });
    });
  }
  // Irgendwo im Fenster wird eine Datei gezogen: das Wesen macht schon das Maul auf.
  const ueberallZiehen = (ev) => { if (hatDateien(ev)) ziehenSehen(); };
  document.addEventListener('dragover', ueberallZiehen, true);
  offs.push(() => document.removeEventListener('dragover', ueberallZiehen, true));
  const ziehenEnde = () => ziehenVorbei();
  document.addEventListener('drop', ziehenEnde, true);
  document.addEventListener('dragend', ziehenEnde, true);
  offs.push(() => {
    document.removeEventListener('drop', ziehenEnde, true);
    document.removeEventListener('dragend', ziehenEnde, true);
  });

  panel.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || z.modus !== 'seite') return;
    ev.stopPropagation();
    ev.preventDefault();
    if (z.menue) {
      menueZu({ fokus: true });
      return;
    }
    if (z.live) {
      liveAus();
      return;
    }
    if (z.sprechen) sprechenAbbrechen();
    schliessen({ fokus: true });
  });
  dock.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && z.live) {
      ev.preventDefault();
      liveAus();
    }
  });
  // Klicks in der Insel: den Ton vorbereiten (fuer einen Timer, der spaeter klingelt).
  panel.addEventListener('pointerdown', (ev) => {
    if (z.timer.length) klangVorbereiten();
    if (z.menue && !menue.contains(ev.target) && !knopfMehr.contains(ev.target)) menueZu({ fokus: false });
  }, { passive: true });

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
        if (r.bild) await fuettern([r.bild], { senden: false, von: mitteVon(feld) });
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
   * @returns {Promise<{e:object, ergebnis:string}|null>}
   */
  async function fragen(frage, {
    ausFeld = false, vorlage = null, erneut = false, live: imLive = false, dateienAuftrag = false,
  } = {}) {
    if (z.lauf) return null;
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
        return null;
      }
    }
    const mitBild = !!(z.teilen && z.bildMit);
    if (!roh && !dateienVorher.length && !texteVorher.length && !mitBild) return null;
    const gesprochen = (z.gesprochen && ausFeld) || imLive;
    const feldVorher = feld.value;
    if (ausFeld) {
      feld.value = '';
      feldGroesse();
    }
    z.gesprochen = false;
    z.ungesehen = null;
    z.timerWahl = false;
    z.menue = false;
    const mitgeschickt = [...z.anhaenge];
    z.anhaenge = [];
    const e = {
      id: `e${(zaehler += 1)}`,
      zeit: Date.now(),
      frage: roh || (mitBild ? 'Was siehst du?' : ''),
      bilder: mitgeschickt.filter((a) => a.art === 'bild' && a.url).map((a) => ({ src: a.url, name: a.name })),
      dateien: mitgeschickt.filter((a) => a.art === 'pdf' || (a.art === 'text' && a.datei)).map((a) => ({ name: a.name, art: a.art })),
      antwort: neueAntwort(),
      chatId: null,
      live: imLive,
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
        return fragen(roh, { ausFeld: false, vorlage, erneut: true, live: imLive, dateienAuftrag });
      }
      e.antwort.status = 'fehler';
      e.antwort.fehler = `Nicht gesendet: ${fehlerSatz(err)}`;
      e.antwort.nichtVerbunden = nichtVerbunden(err);
      z.lauf = null;
      zurueck();
      verwirrt(e.antwort.fehler);
      sofort();
      return { e, ergebnis: 'abgelehnt' };
    }

    const texte = mitgeschickt.filter((a) => a.art === 'text').map((a) => ({ name: a.name, text: a.text, max: a.max }));
    const plan = L.textePlanen(roh || (mitBild || ids.length ? 'Was siehst du? Sag kurz das Wichtigste.' : ''), texte);
    let inhalt = plan.inhalt;
    // Ehrlich: was nicht ganz mitging, sagt die Insel.
    const fehlt = [];
    for (const n of plan.gekuerzt) fehlt.push(`„${L.kurzText(n, 40)}“ war lang – mitgeschickt ist nur der Anfang.`);
    for (const n of plan.weggelassen) fehlt.push(`„${L.kurzText(n, 40)}“ passte nicht mehr in diese Frage – gib sie mir einzeln.`);
    if (fehlt.length) e.antwort.hinweise.push(...fehlt);
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
      if (gesprochen && !imLive && vl && e.antwort.text.trim() && !e.antwort.fehler) vorlesen(e);
    }
    sofort();
    return { e, ergebnis: ok };
  }

  function neueAntwort() {
    return {
      id: null, text: '', status: 'laeuft', fehler: null, rueckfragen: [], wirkung: [], agenten: new Map(), quellen: [], hinweise: [],
    };
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
        e.antwort.fehlerCode = err.code || null;
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
    if (e.antwort.status === 'aborted' && ergebnis === 'ok') ergebnis = 'abgebrochen';
    const sichtbar = z.offen || (z.modus === 'fenster' && z.gross);
    if (ergebnis === 'ok' && !sichtbar && (e.antwort.text.trim() || e.antwort.rueckfragen.some((f) => f.zustand === 'offen'))) {
      z.ungesehen = { vorschau: L.kurzText(markdownOhneUi(e.antwort.text), 80) || 'Eine Rückfrage wartet', zeit: Date.now() };
    }
    if (e.antwort.fehler || ergebnis === 'abgelehnt' || ergebnis === 'unterbrochen') verwirrt(e.antwort.fehler || 'Die Verbindung brach ab.');
    else if (ergebnis === 'ok' && e.antwort.text.trim() && !z.live) freuen();
    sofort();
    return ergebnis;
  }

  function quelleDazu(a, p) {
    if (!p || !p.url) return;
    // Wie der Chat: dieselbe Adresse mit anderer Kennung ist eine andere Quelle.
    if (a.quellen.some((x) => x.url === p.url && (x.id || null) === (p.id || null))) return;
    a.quellen.push({ titel: p.titel || p.url, url: p.url, art: p.art || 'zitat', ...(p.id ? { id: p.id, typ: p.typ || null } : {}) });
  }

  function agentDazu(a, p) {
    const vorher = a.agenten.get(p.id) || {};
    a.agenten.set(p.id, {
      ...vorher,
      id: p.id,
      rolle: p.rolle || vorher.rolle || '',
      titel: p.titel || vorher.titel || '',
      zustand: p.zustand || vorher.zustand,
      schritt: p.schritt || '',
      ergebnis: p.ergebnis || vorher.ergebnis || null,
      werkzeug: p.werkzeug || vorher.werkzeug || null,
      wirkung: Array.isArray(p.wirkung) ? p.wirkung : (vorher.wirkung || null),
    });
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
          if (z.live && e.live && z.live.phase === 'denkt') liveWeiter('erstesWort');
        }
        break;
      case 'inhalt':
        if (typeof p.content === 'string') a.text = p.content;
        break;
      case 'denken':
        if (z.lauf && z.lauf.eintrag === e && !a.text) z.lauf.phase = 'denkt';
        break;
      case 'quelle':
        quelleDazu(a, p);
        break;
      case 'agent': {
        agentDazu(a, p);
        if (Array.isArray(p.wirkung) && p.wirkung.length) {
          const bekannt = new Map(a.wirkung.map((w) => [`${w.id}|${w.aktion}`, w]));
          for (const w of p.wirkung) bekannt.set(`${w.id}|${w.aktion}`, w);
          a.wirkung = [...bekannt.values()];
        }
        if (z.lauf && z.lauf.eintrag === e) {
          const laeuft = [...a.agenten.values()].find((x) => x.zustand === 'laeuft' && x.rolle !== 'planung');
          if (laeuft) {
            // Fuer die eine Zeile unter dem Wesen das kurze Wort des Werkzeugs ("Sucht im Internet",
            // "Schlägt nach"); die genaue Zeile steht im Gespraech.
            const s = L.schrittSatz(laeuft);
            z.lauf.phase = 'werkzeug';
            z.lauf.schritt = `${laeuft.schritt || (s && s.text) || laeuft.titel || 'Arbeitet'} …`.replace(/(?:…|\.\.\.)\s*…$/, '…');
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
        if (p.satz && !a.hinweise.includes(String(p.satz))) a.hinweise.push(String(p.satz));
        break;
      case 'fehler':
        a.fehler = p.satz || 'Die KI konnte nicht antworten.';
        a.nichtVerbunden = nichtVerbunden(p);
        a.fehlerCode = p.code || null;
        break;
      case 'fertig': {
        const d = p.record && p.record.data;
        if (d) {
          if (typeof d.content === 'string') a.text = d.content;
          if (typeof d.status === 'string') a.status = d.status === 'streaming' ? 'complete' : d.status;
          if (Array.isArray(d.agenten)) {
            const alle = [];
            for (const ag of d.agenten) {
              if (ag && ag.id) agentDazu(a, ag);
              if (Array.isArray(ag.wirkung)) alle.push(...ag.wirkung);
            }
            if (alle.length) a.wirkung = alle;
          }
          if (Array.isArray(d.quellen)) for (const q of d.quellen) quelleDazu(a, q);
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
      freuen();
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
          const anh = Array.isArray(d.anhaenge) ? d.anhaenge : [];
          offen = {
            id: `e${(zaehler += 1)}`,
            zeit: Date.parse(m.createdAt) || 0,
            frage: L.kurzText(String(d.content || '').split(/\n\n(?:\*\*|\[Gerade offen)/)[0], 400),
            bilder: anh.filter((x) => /^image\//.test(x.mime || '')).map((x) => ({ src: anhangUrl(chatId, x.id), name: x.name })),
            dateien: anh.filter((x) => x.mime === 'application/pdf').map((x) => ({ name: x.name, art: 'pdf' })),
            antwort: { ...neueAntwort(), status: 'complete' },
            chatId,
          };
          paare.push(offen);
        } else if (d.role === 'assistant' && offen) {
          const a = offen.antwort;
          a.id = m.id;
          a.text = String(d.content || '');
          a.status = d.status === 'streaming' ? 'unterbrochen' : (d.status || 'complete');
          a.rueckfragen = (Array.isArray(d.rueckfragen) ? d.rueckfragen : []).map((f) => ({
            id: f.id, frage: f.frage, optionen: (f.optionen || []).map((o) => (typeof o === 'string' ? o : o.label)), mehrfach: f.mehrfach === true, zustand: f.zustand || 'offen',
          }));
          for (const ag of Array.isArray(d.agenten) ? d.agenten : []) {
            if (ag && ag.id) agentDazu(a, ag);
            if (Array.isArray(ag.wirkung)) a.wirkung.push(...ag.wirkung);
          }
          for (const q of Array.isArray(d.quellen) ? d.quellen : []) quelleDazu(a, q);
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
  offs.push(state.on('claude', () => {
    planen();
    if (z.offen || z.modus === 'fenster') kiInfoLaden();
  }));
  offs.push(state.on('pin', () => sichtbarkeit()));
  // Eine Spalte klappt auf oder zu (200 ms Bewegung im Raster): gleich und noch einmal danach nachsehen.
  let seitenUhr = null;
  offs.push(state.on('seiten', () => {
    lageNeu(30);
    clearTimeout(seitenUhr);
    seitenUhr = setTimeout(() => lageNeu(10), 320);
  }));
  offs.push(() => clearTimeout(seitenUhr));
  offs.push(state.on('route', () => lageNeu(450)));
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
    const gesperrt = !!state.get('pin');
    if (aus || gesperrt) {
      if (z.offen) schliessen();
      if (z.modus === 'fenster') zurueckHolen();
      // "Neural OS ist aus" oder gesperrt: nichts schwebt, nichts nimmt auf.
      liveAus();
      sprechenAbbrechen();
      if (aus) teilenBeenden();
      if (aus === 'beendet') timerAus(null);
    }
    // Gesperrt (PIN): keine Insel. Aus: das Wesen schlaeft am Rand -- sichtbar, aber nicht antippbar.
    dock.hidden = gesperrt || (z.offen && z.modus === 'seite');
    dock.dataset.aus = aus ? 'ja' : 'nein';
    dock.setAttribute('aria-hidden', aus ? 'true' : 'false');
    if (aus) panel.hidden = true;
    spurSetzen();
    sofort();
    lagePlanen(30);
  }
  offs.push(state.on('aus', () => sichtbarkeit()));

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

  /* -------------------------------------- Seite: Klick, Taste, Zeiger */

  function draussen(ev) {
    if (!z.offen || z.modus !== 'seite') return;
    const t = ev.target;
    if (!t || panel.contains(t) || dock.contains(t)) return;
    if (t.closest && t.closest('.lk, .overlay, .toast, .toasts, .wesen-happen')) return;
    schliessen();
  }
  document.addEventListener('pointerdown', draussen, true);
  offs.push(() => document.removeEventListener('pointerdown', draussen, true));

  function taste(ev) {
    if (!L.istKuerzel(ev)) return;
    ev.preventDefault();
    if (dock.hidden && !z.offen) return;
    if (state.get('aus')) return;
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

  /** Die Augen folgen dem Zeiger ein wenig -- nur mit Maus, nur bei Bewegung (kein Dauertakt). */
  let blickGeplant = 0;
  let blickZiel = null;
  function zeigerBewegt(ev) {
    blickZiel = { x: ev.clientX, y: ev.clientY, w: (ev.view || window) };
    if (blickGeplant) return;
    const w = blickZiel.w;
    blickGeplant = w.requestAnimationFrame(() => {
      blickGeplant = 0;
      if (!blickZiel || reduziert(w)) return;
      if (wesenKnopf.ownerDocument.defaultView !== blickZiel.w) return;
      const r = wesenKnopf.getBoundingClientRect();
      if (!r.width) return;
      const dx = blickZiel.x - (r.left + r.width / 2);
      const dy = blickZiel.y - (r.top + r.height / 2);
      const weit = Math.hypot(dx, dy) || 1;
      const staerke = Math.min(1, weit / 220);
      wesen.blick((dx / weit) * staerke, (dy / weit) * staerke);
    });
  }
  if (maus()) {
    document.addEventListener('pointermove', zeigerBewegt, { passive: true });
    offs.push(() => document.removeEventListener('pointermove', zeigerBewegt));
    const weg = () => wesen.blick(0, 0);
    document.addEventListener('pointerleave', weg);
    offs.push(() => document.removeEventListener('pointerleave', weg));
  }

  const neuLegen = () => {
    if (z.offen) panelPlatzieren();
    lageNeu(120);
  };
  window.addEventListener('resize', neuLegen);
  offs.push(() => window.removeEventListener('resize', neuLegen));
  wesenKnopf.addEventListener('pointerdown', () => markierungMerken(), { passive: true });
  // Wer waehrend der Antwort nach oben rollt, liest -- dann rollt nichts mehr nach unten.
  verlaufEl.addEventListener('scroll', () => {
    if (!z.lauf) return;
    z.lauf.folgen = verlaufEl.scrollHeight - verlaufEl.scrollTop - verlaufEl.clientHeight < 48;
  }, { passive: true });

  // Was am Rand liegt, aendert sich mit der Ansicht: neu nachsehen (gebuendelt).
  if (typeof MutationObserver === 'function') {
    let zuletzt = 0;
    const mo = new MutationObserver(() => {
      const jetzt = Date.now();
      lagePlanen(jetzt - zuletzt > 1500 ? 500 : 900);
      zuletzt = jetzt;
    });
    for (const id of ['view', 'aside']) {
      const el = document.getElementById(id);
      if (el) mo.observe(el, { childList: true, subtree: true });
    }
    offs.push(() => mo.disconnect());
    // Kapseln kommen und gehen (Erinnerungen): das Wesen richtet sich danach.
    const kmo = new MutationObserver(() => { planen(); lagePlanen(60); });
    kmo.observe(kapseln, { childList: true });
    offs.push(() => kmo.disconnect());
  }
  // Ist der Kopf schmal (unter 600 px), lassen Ansichten Entbehrliches weg (das Gehirn seine Zahl).
  function kopfMessen() {
    if (!lebt || !kopf) return;
    const eng = kopf.clientWidth > 0 && kopf.clientWidth < 600 ? 'ja' : 'nein';
    if (kopf.dataset.eng !== eng) kopf.dataset.eng = eng;
  }
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => kopfMessen());
    if (kopf) ro.observe(kopf);
    offs.push(() => ro.disconnect());
  }
  kopfMessen();

  sichtbarkeit();
  dockPlatzieren();
  requestAnimationFrame(() => dock.classList.remove('ist-neu'));
  sofort();

  /* --------------------------------------- Erinnerungen (Adapter) */

  const erinnerungen = {
    /** Eine Erinnerungskarte (lib/erinnerung.js) als Kapsel neben das Wesen. */
    einhaengen(karte, e) {
      if (!lebt || state.get('pin')) return false;
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
      clearTimeout(lageUhr);
      clearTimeout(spurUhr);
      try { taktIn.clearInterval(takt); } catch { /* zu */ }
      teilenBeenden();
      liveAus();
      sprechenAbbrechen();
      if (z.fenster) {
        try { z.fenster.close(); } catch { /* zu */ }
      }
      dock.remove();
      panel.remove();
      spurSetzen();
    },
  };
}

export default { starteInsel };
