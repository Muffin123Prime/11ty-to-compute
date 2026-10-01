/**
 * lib/insel-wesen.js -- das kleine Wesen der Insel (lib/insel.js).
 *
 * Ein eigenes, kleines Tier aus einem einzigen SVG: ein runder Leib mit
 * zwei Ohren, zwei Augen und einem Mund -- in den Farben der App (im Dunkeln
 * hell, im Hellen dunkel) und mit genau einem Akzent, dem Blau, fuer das,
 * was gerade lebt (der Ring beim Zuhoeren, die Punkte beim Denken, die Zunge
 * beim Essen, die Funken, wenn es sich freut). Keine Bilddatei, keine
 * fremde Figur.
 *
 * Was die Zustaende zeigen (die Rangfolge rechnet lib/insel-logik.js,
 * wesenZustand):
 *   ruht      atmet, blinzelt, schaut ein wenig dem Zeiger nach
 *   hoert     Ohren hoch, ein Ring, der mit dem echten Mikrofon atmet (pegel)
 *   denkt     schaut nach oben, drei Punkte ueber dem Kopf
 *   spricht   der Mund bewegt sich (Antwort kommt Wort fuer Wort, oder es liest vor)
 *   frisst    Maul auf, die Datei fliegt hinein (essen), es kaut, dann "verdaut"
 *   freut     Augen zu Boegen, ein Huepfer, zwei Funken
 *   verwirrt  Kopf schief, ein Fragezeichen -- und auf Wunsch schuettelt es den Kopf
 *   schlaeft  Augen zu, Ohren haengen, "zzz"
 *
 * Bewegt wird nur mit transform und opacity (CSS-Animationen), es gibt
 * keine Schleife mit requestAnimationFrame. Wer im System "weniger
 * Bewegung" eingestellt hat, sieht die Haltung jedes Zustands, aber keine
 * Bewegung. Gezeichnet wird ueber icon() aus lib/dom.js (als XML gelesen,
 * ohne Skript) -- die CSP der App (default-src 'self') bleibt unberuehrt.
 */

import { h, icon } from './dom.js';

const STYLE_ID = 'nos-insel-wesen';

let zaehler = 0;

/**
 * Das Bild. `id` macht die Verlaeufe eindeutig (es gibt das Wesen einmal,
 * aber es zieht mit in das schwebende Fenster).
 */
function markup(id) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" class="wesen__svg">
  <defs>
    <radialGradient id="${id}-leib" cx="40%" cy="30%" r="78%">
      <stop offset="0" class="wesen__hell"/>
      <stop offset="1" class="wesen__dunkel"/>
    </radialGradient>
  </defs>
  <circle class="wesen__ring" cx="60" cy="68" r="52"/>
  <ellipse class="wesen__schatten" cx="60" cy="112" rx="25" ry="3.6"/>
  <g class="wesen__huepf">
    <g class="wesen__koerper">
      <g class="wesen__ohr wesen__ohr--l">
        <ellipse cx="39" cy="35" rx="11" ry="15.5" fill="url(#${id}-leib)"/>
        <ellipse class="wesen__ohr-innen" cx="39.5" cy="37" rx="5.2" ry="9"/>
      </g>
      <g class="wesen__ohr wesen__ohr--r">
        <ellipse cx="81" cy="35" rx="11" ry="15.5" fill="url(#${id}-leib)"/>
        <ellipse class="wesen__ohr-innen" cx="80.5" cy="37" rx="5.2" ry="9"/>
      </g>
      <ellipse class="wesen__fuss" cx="45" cy="104.5" rx="9.5" ry="5"/>
      <ellipse class="wesen__fuss" cx="75" cy="104.5" rx="9.5" ry="5"/>
      <path class="wesen__leib" fill="url(#${id}-leib)" d="M60 27C83 27 101.5 44 102 67.5C102.5 90 85.5 106 60 106C34.5 106 17.5 90 18 67.5C18.5 44 37 27 60 27Z"/>
      <ellipse class="wesen__bauch" cx="60" cy="88" rx="21" ry="12"/>
      <g class="wesen__blick">
        <g class="wesen__gesicht">
          <g class="wesen__augen">
            <ellipse class="wesen__auge" cx="45.5" cy="63" rx="7.4" ry="9.6"/>
            <ellipse class="wesen__auge" cx="74.5" cy="63" rx="7.4" ry="9.6"/>
            <circle class="wesen__glanz" cx="48.4" cy="59" r="2.7"/>
            <circle class="wesen__glanz" cx="77.4" cy="59" r="2.7"/>
            <circle class="wesen__glanz wesen__glanz--klein" cx="43.4" cy="67" r="1.2"/>
            <circle class="wesen__glanz wesen__glanz--klein" cx="72.4" cy="67" r="1.2"/>
          </g>
          <path class="wesen__strich wesen__augen-froh" d="M38.5 65.5Q45.5 56 52.5 65.5M67.5 65.5Q74.5 56 81.5 65.5"/>
          <path class="wesen__strich wesen__augen-zu" d="M38.5 63.5Q45.5 69.5 52.5 63.5M67.5 63.5Q74.5 69.5 81.5 63.5"/>
          <ellipse class="wesen__wange" cx="34.5" cy="76.5" rx="6.2" ry="3.6"/>
          <ellipse class="wesen__wange" cx="85.5" cy="76.5" rx="6.2" ry="3.6"/>
          <path class="wesen__strich wesen__mund wesen__mund--laecheln" d="M53.5 78Q60 84 66.5 78"/>
          <ellipse class="wesen__mund wesen__mund--reden" cx="60" cy="80.2" rx="5" ry="4"/>
          <g class="wesen__mund wesen__mund--auf">
            <ellipse class="wesen__maul" cx="60" cy="81" rx="10.5" ry="9.5"/>
            <ellipse class="wesen__zunge" cx="60" cy="86.4" rx="6.2" ry="3.4"/>
          </g>
          <path class="wesen__strich wesen__mund wesen__mund--wellig" d="M50.5 80.5q3.2-3 6.4 0t6.4 0t6.4 0"/>
          <path class="wesen__strich wesen__mund wesen__mund--klein" d="M56 80h8"/>
          <path class="wesen__strich wesen__mund wesen__mund--kauen" d="M51 79.5Q55.5 83 60 79.5Q64.5 83 69 79.5"/>
        </g>
      </g>
    </g>
  </g>
  <g class="wesen__denken">
    <circle cx="47" cy="12.5" r="3.7"/>
    <circle cx="60" cy="9.5" r="3.7"/>
    <circle cx="73" cy="12.5" r="3.7"/>
  </g>
  <g class="wesen__zzz">
    <text x="88" y="31">z</text>
    <text x="96" y="21">z</text>
    <text x="104.5" y="10">Z</text>
  </g>
  <text class="wesen__frage" x="95" y="31">?</text>
  <g class="wesen__funken">
    <path d="M17 31l2.2 5.3L24.5 38.5l-5.3 2.2L17 46l-2.2-5.3L9.5 38.5l5.3-2.2z"/>
    <path d="M101 18l1.7 4.1 4.1 1.7-4.1 1.7L101 29.6l-1.7-4.1-4.1-1.7 4.1-1.7z"/>
    <path d="M104 52l1.2 2.8 2.8 1.2-2.8 1.2L104 60l-1.2-2.8-2.8-1.2 2.8-1.2z"/>
  </g>
</svg>`;
}

/** Ein Blatt Papier mit Eselsohr -- die Datei, die ins Maul fliegt. */
const HAPPEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 48" fill="none"><path d="M6 3h19l11 11v28a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" class="wesen-happen__blatt"/><path d="M25 3v8a3 3 0 0 0 3 3h8" class="wesen-happen__ecke"/></svg>';

/* ------------------------------------------------------------------ */
/* Aussehen                                                             */
/* ------------------------------------------------------------------ */

const WESEN_CSS = `
.wesen {
  --w-hell: #f6f6f8; --w-dunkel: #c7c8cf; --w-auge: #0c0d0f; --w-glanz: #ffffff; --w-innen: #d9dae0;
  --w-maul: #17181b; --w-bauch: rgba(255, 255, 255, 0.32); --w-schatten: rgba(0, 0, 0, 0.55); --w-zzz: var(--fg-muted, #a4a6ac);
  --w-akzent: var(--accent, #2f7cf6); --w-akzent-text: var(--accent-text, #6aa5ff);
  --w-wange: color-mix(in srgb, var(--accent, #2f7cf6) 38%, transparent);
  --pegel: 0; --blick-x: 0; --blick-y: 0;
  position: relative; display: inline-grid; place-items: center; width: 100%; height: 100%;
  pointer-events: none;
}
:root[data-theme="light"] .wesen {
  --w-hell: #44464d; --w-dunkel: #0e0f12; --w-auge: #ffffff; --w-glanz: #121316; --w-innen: #5c5f68;
  --w-maul: #000000; --w-bauch: rgba(255, 255, 255, 0.07); --w-schatten: rgba(16, 18, 24, 0.22);
}
@media (prefers-color-scheme: light) {
  :root[data-theme="system"] .wesen {
    --w-hell: #44464d; --w-dunkel: #0e0f12; --w-auge: #ffffff; --w-glanz: #121316; --w-innen: #5c5f68;
    --w-maul: #000000; --w-bauch: rgba(255, 255, 255, 0.07); --w-schatten: rgba(16, 18, 24, 0.22);
  }
}
.wesen__svg { position: absolute; left: 50%; top: 50%; width: 140%; height: 140%; transform: translate(-50%, -52%); overflow: visible; }
.wesen__hell { stop-color: var(--w-hell); }
.wesen__dunkel { stop-color: var(--w-dunkel); }
.wesen__svg * { transform-box: view-box; }
.wesen__ohr-innen { fill: var(--w-innen); }
.wesen__fuss { fill: var(--w-dunkel); }
.wesen__bauch { fill: var(--w-bauch); }
.wesen__auge { fill: var(--w-auge); }
.wesen__glanz { fill: var(--w-glanz); }
.wesen__strich { fill: none; stroke: var(--w-auge); stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; }
.wesen__mund--reden { fill: var(--w-maul); }
.wesen__maul { fill: var(--w-maul); }
.wesen__zunge { fill: var(--w-akzent); }
.wesen__wange { fill: var(--w-wange); opacity: 0; transition: opacity 240ms ease; }
.wesen__schatten { fill: var(--w-schatten); opacity: 0.55; transform-origin: 60px 112px; }
.wesen__ring { fill: none; stroke: var(--w-akzent); stroke-width: 3; opacity: 0; transform-origin: 60px 68px; transform: scale(0.82); transition: opacity 220ms ease, transform 110ms linear; }
.wesen__denken circle { fill: var(--w-akzent); opacity: 0; }
.wesen__zzz text { fill: var(--w-zzz); font: 700 11px/1 ui-sans-serif, system-ui, sans-serif; opacity: 0; }
.wesen__zzz text:nth-child(2) { font-size: 13px; }
.wesen__zzz text:nth-child(3) { font-size: 15px; }
.wesen__frage { fill: var(--w-akzent-text); font: 800 22px/1 ui-sans-serif, system-ui, sans-serif; opacity: 0; transform-origin: 98px 24px; }
.wesen__funken path { fill: var(--w-akzent); opacity: 0; transform-origin: center; transform-box: fill-box; }

/* Was je Zustand zu sehen ist. Alles liegt immer da, nur die Deckkraft wechselt. */
.wesen__augen-froh, .wesen__augen-zu, .wesen__mund { opacity: 0; transition: opacity 120ms ease; }
.wesen__mund--laecheln { opacity: 1; }
.wesen__augen { transform-origin: 60px 63px; }
.wesen__mund--reden { transform-origin: 60px 80px; }
.wesen__mund--auf { transform-origin: 60px 81px; }
.wesen__koerper { transform-origin: 60px 106px; animation: wesen-atmen 4.4s ease-in-out infinite; }
.wesen__augen { animation: wesen-blinzeln 5.6s ease-in-out infinite; }
.wesen__ohr { transition: transform 260ms cubic-bezier(0.3, 1.4, 0.5, 1); }
.wesen__ohr--l { transform-origin: 41px 46px; }
.wesen__ohr--r { transform-origin: 79px 46px; animation: wesen-zucken 8.5s ease-in-out infinite; }
.wesen__blick { transform: translate(calc(var(--blick-x) * 3.4px), calc(var(--blick-y) * 2.6px)); transition: transform 220ms ease-out; }
.wesen__gesicht { transition: transform 260ms ease; transform-origin: 60px 70px; }
.wesen__huepf { transform-origin: 60px 106px; }

@keyframes wesen-atmen { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.012, 1.03); } }
@keyframes wesen-blinzeln { 0%, 92%, 97%, 100% { transform: scaleY(1); } 94.5% { transform: scaleY(0.08); } }
@keyframes wesen-zucken { 0%, 70%, 78%, 100% { transform: rotate(0); } 73% { transform: rotate(9deg); } 75.5% { transform: rotate(-2deg); } }

/* hoert: Ohren hoch, der Ring atmet mit dem Mikrofon. */
.wesen[data-zustand="hoert"] .wesen__ohr--l { transform: translate(1px, -5px) rotate(10deg); animation: none; }
.wesen[data-zustand="hoert"] .wesen__ohr--r { transform: translate(-1px, -5px) rotate(-10deg); animation: none; }
.wesen[data-zustand="hoert"] .wesen__ring { opacity: calc(0.35 + var(--pegel) * 0.65); transform: scale(calc(0.86 + var(--pegel) * 0.2)); }
.wesen[data-zustand="hoert"] .wesen__augen { transform: scale(1.06); animation: none; }
.wesen[data-zustand="hoert"] .wesen__gesicht { transform: translateY(-1.5px); }

/* denkt: der Blick geht nach oben, drei Punkte ueber dem Kopf. */
.wesen[data-zustand="denkt"] .wesen__gesicht { transform: translate(3px, -3.5px); }
.wesen[data-zustand="denkt"] .wesen__mund--laecheln { opacity: 0; }
.wesen[data-zustand="denkt"] .wesen__mund--klein { opacity: 1; }
.wesen[data-zustand="denkt"] .wesen__denken circle { opacity: 1; animation: wesen-punkt 1.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.wesen[data-zustand="denkt"] .wesen__denken circle:nth-child(2) { animation-delay: 0.18s; }
.wesen[data-zustand="denkt"] .wesen__denken circle:nth-child(3) { animation-delay: 0.36s; }
.wesen[data-zustand="denkt"] .wesen__koerper { animation: wesen-wiegen 2.6s ease-in-out infinite; }
@keyframes wesen-punkt { 0%, 100% { opacity: 0.25; transform: translateY(1.5px) scale(0.8); } 40% { opacity: 1; transform: translateY(-2px) scale(1); } }
@keyframes wesen-wiegen { 0%, 100% { transform: rotate(-2.2deg); } 50% { transform: rotate(2.2deg); } }

/* spricht: der Mund geht auf und zu, das Wesen nickt ein wenig. */
.wesen[data-zustand="spricht"] .wesen__mund--laecheln { opacity: 0; }
.wesen[data-zustand="spricht"] .wesen__mund--reden { opacity: 1; animation: wesen-reden 0.62s ease-in-out infinite; }
.wesen[data-zustand="spricht"] .wesen__koerper { animation: wesen-nicken 1.24s ease-in-out infinite; }
@keyframes wesen-reden { 0%, 100% { transform: scale(1, 0.35); } 22% { transform: scale(1, 1.15); } 45% { transform: scale(0.9, 0.55); } 70% { transform: scale(1.05, 1); } }
@keyframes wesen-nicken { 0%, 100% { transform: translateY(0) scale(1, 1); } 50% { transform: translateY(-1.5px) scale(1.01, 1.015); } }

/* frisst: auf (das Maul wartet), kauen, verdaut. */
.wesen[data-zustand="frisst"] .wesen__mund--laecheln { opacity: 0; }
.wesen[data-zustand="frisst"] .wesen__mund--auf { opacity: 1; animation: wesen-maul 0.9s ease-in-out infinite; }
.wesen[data-zustand="frisst"] .wesen__augen { transform: scale(1.1); animation: none; }
.wesen[data-zustand="frisst"] .wesen__ohr--l { transform: rotate(-6deg); }
.wesen[data-zustand="frisst"] .wesen__ohr--r { transform: rotate(6deg); animation: none; }
.wesen[data-zustand="frisst"] .wesen__wange { opacity: 0.6; }
@keyframes wesen-maul { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08, 1.14); } }
.wesen[data-geste="kauen"] .wesen__mund--auf { opacity: 0; animation: none; }
.wesen[data-geste="kauen"] .wesen__mund--kauen { opacity: 1; }
.wesen[data-geste="kauen"] .wesen__wange { opacity: 1; }
.wesen[data-geste="kauen"] .wesen__koerper { animation: wesen-kauen 0.34s ease-in-out infinite; }
.wesen[data-geste="kauen"] .wesen__augen { animation: none; transform: scaleY(0.6); }
@keyframes wesen-kauen { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.05, 0.94); } }
.wesen[data-geste="verdaut"] .wesen__mund--auf { opacity: 0; animation: none; }
.wesen[data-geste="verdaut"] .wesen__mund--laecheln { opacity: 1; }
.wesen[data-geste="verdaut"] .wesen__augen { opacity: 0; }
.wesen[data-geste="verdaut"] .wesen__augen-froh { opacity: 1; }
.wesen[data-geste="verdaut"] .wesen__funken path { animation: wesen-funke 0.9s ease-out both; }

/* freut: Augen als Boegen, ein Huepfer, Funken. */
.wesen[data-zustand="freut"] .wesen__augen { opacity: 0; }
.wesen[data-zustand="freut"] .wesen__augen-froh { opacity: 1; }
.wesen[data-zustand="freut"] .wesen__wange { opacity: 0.85; }
.wesen[data-zustand="freut"] .wesen__huepf { animation: wesen-hopsen 0.56s cubic-bezier(0.3, 0.7, 0.4, 1) 2; }
.wesen[data-zustand="freut"] .wesen__funken path { animation: wesen-funke 1.1s ease-out both; }
.wesen[data-zustand="freut"] .wesen__funken path:nth-child(2) { animation-delay: 0.12s; }
.wesen[data-zustand="freut"] .wesen__funken path:nth-child(3) { animation-delay: 0.24s; }
@keyframes wesen-hopsen { 0%, 100% { transform: translateY(0) scale(1, 1); } 30% { transform: translateY(-9px) scale(0.98, 1.04); } 62% { transform: translateY(0) scale(1.04, 0.95); } }
@keyframes wesen-funke { 0% { opacity: 0; transform: scale(0.2) rotate(0); } 35% { opacity: 1; transform: scale(1.1) rotate(25deg); } 100% { opacity: 0; transform: scale(0.6) rotate(60deg); } }

/* verwirrt: Kopf schief, Fragezeichen, ein welliger Mund. */
.wesen[data-zustand="verwirrt"] .wesen__mund--laecheln { opacity: 0; }
.wesen[data-zustand="verwirrt"] .wesen__mund--wellig { opacity: 1; }
.wesen[data-zustand="verwirrt"] .wesen__huepf { transform: rotate(-8deg); transition: transform 260ms ease; }
.wesen[data-zustand="verwirrt"] .wesen__frage { opacity: 1; animation: wesen-frage 1.6s ease-in-out infinite; }
.wesen[data-zustand="verwirrt"] .wesen__ohr--l { transform: rotate(-14deg); }
.wesen[data-zustand="verwirrt"] .wesen__ohr--r { transform: rotate(4deg); animation: none; }
@keyframes wesen-frage { 0%, 100% { transform: translateY(0) rotate(8deg); } 50% { transform: translateY(-3px) rotate(-4deg); } }
.wesen[data-geste="schuetteln"] .wesen__huepf { animation: wesen-schuetteln 0.7s ease-in-out; }
@keyframes wesen-schuetteln { 0%, 100% { transform: rotate(0); } 15% { transform: translateX(-4px) rotate(-9deg); } 35% { transform: translateX(4px) rotate(9deg); } 55% { transform: translateX(-3px) rotate(-6deg); } 75% { transform: translateX(2px) rotate(4deg); } }

/* schlaeft: Augen zu, Ohren haengen, zzz. */
.wesen[data-zustand="schlaeft"] .wesen__augen { opacity: 0; animation: none; }
.wesen[data-zustand="schlaeft"] .wesen__augen-zu { opacity: 1; }
.wesen[data-zustand="schlaeft"] .wesen__mund--laecheln { opacity: 0; }
.wesen[data-zustand="schlaeft"] .wesen__mund--klein { opacity: 0.7; }
.wesen[data-zustand="schlaeft"] .wesen__ohr--l { transform: translate(2px, 3px) rotate(-24deg); }
.wesen[data-zustand="schlaeft"] .wesen__ohr--r { transform: translate(-2px, 3px) rotate(24deg); animation: none; }
.wesen[data-zustand="schlaeft"] .wesen__koerper { animation: wesen-schlafen 5.6s ease-in-out infinite; }
.wesen[data-zustand="schlaeft"] .wesen__blick { transform: none; }
.wesen[data-zustand="schlaeft"] .wesen__zzz text { animation: wesen-zzz 3.6s ease-in-out infinite; }
.wesen[data-zustand="schlaeft"] .wesen__zzz text:nth-child(2) { animation-delay: 0.6s; }
.wesen[data-zustand="schlaeft"] .wesen__zzz text:nth-child(3) { animation-delay: 1.2s; }
@keyframes wesen-schlafen { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.02, 1.045); } }
@keyframes wesen-zzz { 0% { opacity: 0; transform: translate(0, 4px); } 30%, 60% { opacity: 1; } 100% { opacity: 0; transform: translate(4px, -6px); } }

/* Aufgeregt (ein Timer klingelt): es huepft, bis jemand ihn ausschaltet. */
.wesen[data-geste="aufgeregt"] .wesen__huepf { animation: wesen-hopsen 0.6s cubic-bezier(0.3, 0.7, 0.4, 1) infinite; }
.wesen[data-geste="aufgeregt"] .wesen__ring { opacity: 0.7; animation: wesen-klingeln 1.2s ease-out infinite; }
@keyframes wesen-klingeln { 0% { transform: scale(0.8); opacity: 0.8; } 100% { transform: scale(1.12); opacity: 0; } }
/* Hungrig (eine Datei wird ueber das Fenster gezogen): Maul auf, grosse Augen. */
.wesen[data-geste="hungrig"] .wesen__mund--laecheln { opacity: 0; }
.wesen[data-geste="hungrig"] .wesen__mund--auf { opacity: 1; animation: wesen-maul 0.9s ease-in-out infinite; }
.wesen[data-geste="hungrig"] .wesen__augen { transform: scale(1.12); animation: none; }

/* Weniger Bewegung: jede Haltung bleibt, nichts bewegt sich. */
@media (prefers-reduced-motion: reduce) {
  .wesen *, .wesen-happen { animation: none !important; transition: none !important; }
  .wesen[data-zustand="denkt"] .wesen__denken circle, .wesen[data-zustand="schlaeft"] .wesen__zzz text { opacity: 1; }
  .wesen[data-geste="verdaut"] .wesen__funken path, .wesen[data-zustand="freut"] .wesen__funken path { opacity: 1; }
}

/* Die Datei, die ins Maul fliegt. */
.wesen-happen {
  position: fixed; left: 0; top: 0; z-index: 1300; width: 44px; height: 52px; margin: -26px 0 0 -22px;
  pointer-events: none; will-change: transform, opacity;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.35));
}
.wesen-happen svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.wesen-happen__blatt { fill: var(--surface-2, #161719); stroke: var(--fg-muted, #a4a6ac); stroke-width: 2; }
.wesen-happen__ecke { stroke: var(--fg-muted, #a4a6ac); stroke-width: 2; stroke-linejoin: round; }
.wesen-happen__schild {
  position: absolute; left: 50%; bottom: 9px; transform: translateX(-50%);
  padding: 1px 5px; font: 700 9px/1.3 ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em;
  color: var(--accent-fg, #fff); background: var(--accent, #2f7cf6); border-radius: 4px;
}
.wesen-happen__bild { position: absolute; left: 6px; right: 7px; top: 15px; bottom: 7px; width: calc(100% - 13px); height: calc(100% - 22px); object-fit: cover; border-radius: 3px; }
`;

/** Das Aussehen einsetzen (einmal je Dokument -- auch im schwebenden Fenster). */
export function wesenStil(doc = document) {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return;
  const node = doc.createElement('style');
  node.id = STYLE_ID;
  node.textContent = WESEN_CSS;
  doc.head.appendChild(node);
}

const reduziert = (w) => {
  try { return !!(w && w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
};

/**
 * Das Wesen erschaffen.
 * @returns {{el:HTMLElement, zustand:(name:string)=>void, geste:(name:string|null, ms?:number)=>Promise<void>,
 *   pegel:(v:number)=>void, blick:(x:number, y:number)=>void, maulPunkt:()=>{x:number,y:number},
 *   essen:(o:{von:{x:number,y:number}, bild?:string, kuerzel?:string})=>Promise<void>}}
 */
export function wesenErschaffen({ doc = document } = {}) {
  wesenStil(doc);
  zaehler += 1;
  const id = `wesen${zaehler}`;
  const svg = icon(markup(id));
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  const el = h('span.wesen', { 'aria-hidden': 'true', dataset: { zustand: 'ruht' } }, svg);
  let gesteUhr = null;
  let gesteFertig = null;
  let pegelJetzt = -1;
  let blickJetzt = '';

  function zustand(name) {
    if (el.dataset.zustand !== name) el.dataset.zustand = name;
  }

  /**
   * Eine kurze Geste ueber dem Zustand ('kauen', 'verdaut', 'schuetteln',
   * 'aufgeregt', 'hungrig'). Mit `ms` endet sie von selbst; null beendet sie.
   */
  function geste(name, ms = 0) {
    clearTimeout(gesteUhr);
    if (gesteFertig) {
      gesteFertig();
      gesteFertig = null;
    }
    if (!name) {
      delete el.dataset.geste;
      return Promise.resolve();
    }
    // Dieselbe Geste noch einmal: neu anstossen (die Animation beginnt von vorn).
    if (el.dataset.geste === name) {
      delete el.dataset.geste;
      void el.offsetWidth;
    }
    el.dataset.geste = name;
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => {
      gesteFertig = resolve;
      gesteUhr = setTimeout(() => {
        if (el.dataset.geste === name) delete el.dataset.geste;
        gesteFertig = null;
        resolve();
      }, ms);
    });
  }

  function pegel(v) {
    const p = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) / 100;
    if (p === pegelJetzt) return;
    pegelJetzt = p;
    el.style.setProperty('--pegel', String(p));
  }

  function blick(x, y) {
    const bx = Math.round(Math.max(-1, Math.min(1, Number(x) || 0)) * 20) / 20;
    const by = Math.round(Math.max(-1, Math.min(1, Number(y) || 0)) * 20) / 20;
    const key = `${bx}|${by}`;
    if (key === blickJetzt) return;
    blickJetzt = key;
    el.style.setProperty('--blick-x', String(bx));
    el.style.setProperty('--blick-y', String(by));
  }

  /** Wo das Maul gerade ist (Bildschirmpunkte). */
  function maulPunkt() {
    const r = svg.getBoundingClientRect();
    return { x: r.left + r.width * (60 / 120), y: r.top + r.height * (82 / 120) };
  }

  /**
   * Eine Datei fliegt von `von` ins Maul: ein Blatt mit Schild ("PDF") oder
   * mit dem Bild darauf. Ohne Animation (weniger Bewegung) geht es sofort.
   */
  function essen({ von, bild = null, kuerzel = '' } = {}) {
    const d = el.ownerDocument || doc;
    const w = d.defaultView || window;
    if (!von || reduziert(w)) return Promise.resolve();
    const happen = d.createElement('div');
    happen.className = 'wesen-happen';
    happen.appendChild(icon(HAPPEN_SVG));
    if (bild) {
      const img = d.createElement('img');
      img.className = 'wesen-happen__bild';
      img.alt = '';
      img.src = bild;
      happen.appendChild(img);
    }
    if (kuerzel) {
      const schild = d.createElement('span');
      schild.className = 'wesen-happen__schild';
      schild.textContent = kuerzel;
      happen.appendChild(schild);
    }
    d.body.appendChild(happen);
    const ziel = maulPunkt();
    const dx = ziel.x - von.x;
    const dy = ziel.y - von.y;
    const mitte = { x: von.x + dx * 0.5, y: von.y + dy * 0.5 - Math.min(90, 30 + Math.abs(dx) * 0.18) };
    const t = (p, s, r, o = 1) => ({ transform: `translate(${p.x}px, ${p.y}px) scale(${s}) rotate(${r}deg)`, opacity: o });
    if (typeof happen.animate !== 'function') {
      happen.remove();
      return Promise.resolve();
    }
    const anim = happen.animate([
      t(von, 1, 0),
      { ...t(mitte, 0.85, -14), offset: 0.55 },
      t(ziel, 0.12, 12, 0.35),
    ], { duration: 640, easing: 'cubic-bezier(0.45, 0, 0.7, 1)', fill: 'forwards' });
    return anim.finished.catch(() => {}).then(() => { happen.remove(); });
  }

  return { el, zustand, geste, pegel, blick, maulPunkt, essen };
}

export default { wesenErschaffen, wesenStil };
