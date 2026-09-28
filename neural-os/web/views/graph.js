/**
 * views/graph.js -- "Gehirn": das zoombare Wissensuniversum.
 *
 * Die Vision des Nutzers (27.09.2026): kein Notizblock, ein Wissensuniversum.
 * Grosse Themen als grosse, ruhige Kreise; man zoomt in einen Bereich hinein
 * und sieht sein ganzes Wissen dazu, jederzeit tiefer hinein oder wieder
 * heraus -- "als wuerde ich durch mein eigenes Gehirn navigieren". Deshalb:
 *
 * 1. **Zwei Ebenen, zwei Leinwaende.** Ebene 0 (Universum) zeichnet der
 *    Zeichner im Themen-Modus: hoechstens ~40 Kreise, Groesse = Anzahl, Name
 *    in der Mitte, feine Linien zwischen Themen, die Eintraege teilen. Ebene
 *    1 ist EIN Thema als Netz: seine Knoten, seine Kanten, die Nachbarn
 *    ausserhalb leiser. Beide Leinwaende liegen uebereinander und blenden
 *    beim Hinein- und Herauszoomen weich ineinander -- die Kamera "faehrt"
 *    in den Kreis, das Netz baut sich darin auf. Nichts fliegt herum.
 * 2. **Der Server rechnet, der Browser zeichnet.** GET /api/graph/universum
 *    liefert Themen (Ebene 0) und ein Thema (Ebene 1) in unter 300 ms, auch
 *    bei 10.000 Knoten (Cache, Vertrag F). Kennt ein aelterer Server die
 *    Route nicht, rechnet web/lib/universum.js dieselben Gruppen im Browser
 *    -- langsamer, nie erfunden.
 * 3. **Hover ist Licht, Auswahl ist Wissen.** Ueberfahren hebt Knoten und
 *    Nachbarn hervor, der Rest tritt auf ein Viertel zurueck (Zeichner).
 *    Antippen oeffnet rechts die Informationskarte: Art, Titel, Anfang,
 *    Schlagworte, "Verknuepft mit" (mit Grund, antippbar), zuletzt
 *    bearbeitet, Dateien, Vorschlaege mit [Verbinden], KI-Zusammenfassung
 *    -- ehrlich: solange keine KI verbunden ist, sagt die Karte das.
 * 4. **Suche findet ueberall.** Oben rechts; tippen hebt Treffer hervor,
 *    Eingabetaste springt zum ersten. Was nicht auf dieser Ebene liegt,
 *    sucht der Server (/api/graph?q=) -- ein Treffer dort oeffnet das Umfeld
 *    des Eintrags als eigene Ebene 1 ("Fokus").
 * 5. **Live, ohne Umwerfen.** 'graph.kante' vom Bus: die neue Linie zieht
 *    sich in 400 ms, beide Knoten bewegen sich leicht, der Rest bleibt.
 *    Alles andere laedt gebuendelt nach; der Zeichner behaelt jede Position.
 * 6. **Leer heisst eingeladen, nicht kaputt.** "Dein Wissensuniversum
 *    wartet." mit drei Wegen hinein. Unter acht Eintraegen gibt es keine
 *    Themen-Ebene: das Netz direkt.
 *
 * Adressen: #/graph (Universum), #/graph?thema=<id> (ein Thema),
 * #/graph?focus=<id> (Umfeld eines Eintrags, gewaehlt), #/graph?ansicht=karte
 * (die ruhige Themenkarte, views/wissenskarte.js).
 */

import { h, text, clear, on, icon, formatNumber, timeAgo, debounce } from '../lib/dom.js';
import { createGraphCanvas, layoutThemen, THEME_HUES } from '../lib/graph-canvas.js';
import {
  TYPE_PLURALS, OPEN_ROUTES, WURZEL_NAME, KLEIN_AB, artVon, fold, passt,
  normaliseEbene0, normaliseEbene1, normaliseVerknuepft, verknuepftAusGraph, brotkrumen,
  sucheThemen, sucheKnoten, universumLokal, ebene1Lokal,
} from '../lib/universum.js';
import { createWissenskarte } from './wissenskarte.js';

/* ------------------------------------------------------------------ */
/* Konstanten                                                          */
/* ------------------------------------------------------------------ */

const ICON = {
  close: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  open: '<path d="M4 10h11M11 6l4 4-4 4"/>',
  search: '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 4 4"/>',
  chevron: '<path d="m7.5 5 5 5-5 5"/>',
  back: '<path d="M12.5 5 7.5 10l5 5"/>',
  in: '<path d="M4 10h9M9.5 6l4 4-4 4"/>',
  out: '<path d="M16 10H7M10.5 6l-4 4 4 4"/>',
  link: '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l1-1"/>',
  spark: '<path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.5 5.5l2 2M12.5 12.5l2 2M14.5 5.5l-2 2M7.5 12.5l-2 2"/>',
  focus: '<circle cx="10" cy="10" r="3"/><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3"/>',
  file: '<path d="M5.5 3h6l3 3v11h-9z"/><path d="M11.5 3v3h3"/>',
  undo: '<path d="M4.6 10a5.4 5.4 0 1 0 1.7-3.9"/><path d="M4.2 3.6v3.2h3.2"/>',
};

/** So lange dauert das Ueberblenden zwischen den Ebenen (CSS unten, gleich). */
const BLEND_MS = 420;
const LOAD_LIMIT = 2500;
/** Ab Werk unsichtbar: Laeufe sind Buchhaltung der Agenten, kein Wissen. */
const AB_WERK_AUS = new Set(['run']);

/* ------------------------------------------------------------------ */
/* Eigenes CSS (nur Marken aus web/app.css)                            */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-gehirn-style';
const CSS = `
.main[data-view="graph"] { overflow: hidden; }
.gh {
  position: relative; height: 100%; min-height: 320px; overflow: hidden;
  background: var(--bg);
}
.gh__layer {
  position: absolute; inset: 0;
  transition: opacity ${BLEND_MS}ms var(--ease), transform ${BLEND_MS}ms var(--ease);
  transform-origin: 50% 50%; will-change: opacity, transform;
}
.gh__layer[data-zustand="weg"] { opacity: 0; pointer-events: none; visibility: hidden; transition: opacity ${BLEND_MS}ms var(--ease), transform ${BLEND_MS}ms var(--ease), visibility 0s linear ${BLEND_MS}ms; }
.gh__layer[data-zustand="tief"] { opacity: 0; transform: scale(2.4); pointer-events: none; }
.gh__layer[data-zustand="klein"] { opacity: 0; transform: scale(0.86); pointer-events: none; }
.gh__layer[data-zustand="da"] { opacity: 1; transform: none; }
.gh__canvas {
  position: absolute; inset: 0; display: block; width: 100%; height: 100%;
  touch-action: none; outline: none; cursor: default;
  -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
}
.gh__canvas:focus-visible { box-shadow: inset 0 0 0 2px var(--accent-ring); }
.gh__live {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
@media (prefers-reduced-motion: reduce) {
  .gh__layer { transition: none; }
}

/* Oben: links die Brotkrumen, rechts Suche und Filter. */
.gh__top {
  position: absolute; top: 12px; left: 14px; right: 14px; z-index: 3;
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-2);
  pointer-events: none;
}
.gh__top > * { pointer-events: auto; }
.gh__crumbs {
  display: flex; align-items: center; flex-wrap: wrap; gap: 2px;
  min-height: 36px; padding: 0 6px 0 4px;
  background: color-mix(in srgb, var(--surface-2) 88%, transparent);
  border: 1px solid var(--border); border-radius: var(--r-2); box-shadow: var(--shadow-1);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
}
.gh__crumb {
  display: inline-flex; align-items: center; gap: 4px;
  min-height: 30px; padding: 0 8px; border: 0; border-radius: var(--r-1);
  background: none; color: var(--fg-muted); font: inherit; font-size: var(--fs-base); cursor: pointer;
  max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gh__crumb:hover { background: var(--surface-3); color: var(--fg); }
.gh__crumb[aria-current="page"] { color: var(--fg); font-weight: 500; cursor: default; }
.gh__crumb[aria-current="page"]:hover { background: none; }
.gh__crumb-sep { color: var(--fg-subtle); font-size: var(--fs-sm); }
.gh__crumb-n { color: var(--fg-subtle); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; margin-left: 2px; }

.gh__tools { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: min(360px, 60%); }
.gh__search { position: relative; width: 256px; max-width: 100%; }
.gh__search .input {
  width: 100%; min-height: 36px; padding-left: 32px; padding-right: 10px;
  background: color-mix(in srgb, var(--surface-2) 88%, transparent);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
}
.gh__search-icon {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  display: grid; color: var(--fg-subtle); pointer-events: none;
}
.gh__search-icon svg { width: 15px; height: 15px; }
.gh__results {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 4; width: 300px; max-width: calc(100vw - 40px);
  max-height: 340px; overflow: auto; overscroll-behavior: contain;
  padding: 6px; margin: 0; list-style: none;
  background: var(--surface-2); border: 1px solid var(--border-strong);
  border-radius: var(--r-2); box-shadow: var(--shadow-2);
}
.gh__results-head { padding: 6px 8px 2px; color: var(--fg-subtle); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.gh__result {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 4px 8px;
  background: none; border: 0; border-radius: var(--r-1); color: var(--fg); font: inherit; text-align: left; cursor: pointer;
}
.gh__result:hover, .gh__result:focus-visible { background: var(--surface-3); outline: none; }
.gh__result-main { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh__result-sub { flex: none; color: var(--fg-subtle); font-size: var(--fs-sm); }
.gh__dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--fg-subtle); }
.gh__empty-result { padding: 8px; color: var(--fg-subtle); font-size: var(--fs-sm); }

.gh__chips { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.gh__chips .chip {
  min-height: 28px; padding: 0 10px; color: var(--fg-subtle);
  background: color-mix(in srgb, var(--surface-2) 88%, transparent);
}
.gh__chips .chip.is-active { color: var(--fg); background: var(--surface-3); border-color: var(--border-strong); }
.gh__chips .chip[data-fokus].is-active { color: var(--accent-text); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 60%, transparent); }
.gh__chip-n { color: var(--fg-subtle); font-variant-numeric: tabular-nums; }

/* Unten links: ein leiser Hinweis, wie man sich bewegt. */
.gh__hint {
  position: absolute; left: 16px; bottom: 12px; z-index: 2; margin: 0;
  color: var(--fg-subtle); font-size: var(--fs-xs); pointer-events: none;
  transition: opacity var(--dur-3) var(--ease);
}
.gh__hint[hidden] { display: none; }

/* Die Informationskarte rechts. */
.gh__card {
  position: absolute; top: 12px; right: 14px; bottom: 12px; z-index: 3;
  width: min(340px, calc(100% - 28px));
  display: flex; flex-direction: column;
  background: color-mix(in srgb, var(--surface-2) 94%, transparent);
  border: 1px solid var(--border-strong); border-radius: var(--r-3); box-shadow: var(--shadow-2);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
  transform: translateX(0); opacity: 1;
  transition: transform var(--dur-3) var(--ease), opacity var(--dur-3) var(--ease);
}
.gh__card[hidden] { display: none; }
.gh__card-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px 16px 18px; }
.gh__card-head { display: flex; align-items: center; gap: var(--sp-1); min-height: 32px; }
.gh__card-kind {
  display: inline-flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0;
  color: var(--fg-subtle); font-size: var(--fs-sm);
}
.gh__card-kind .gh__dot { width: 9px; height: 9px; }
.gh__card-head .icon-button { width: 32px; height: 32px; margin: -4px -6px -4px 0; }
.gh__card-title {
  margin: 4px 0 0; font-size: var(--fs-lg); font-weight: 500; line-height: var(--lh-tight); letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.gh__card-snip {
  margin: 8px 0 0; color: var(--fg-muted); font-size: var(--fs-base); line-height: var(--lh);
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.gh__card-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.gh__card-tags .chip { min-height: 24px; padding: 0 8px; font-size: var(--fs-xs); cursor: default; }
.gh__card-meta { margin: 10px 0 0; color: var(--fg-subtle); font-size: var(--fs-sm); }
.gh__card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.gh__card-actions .btn svg { width: 16px; height: 16px; }
.gh__sec { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.gh__sec-head { display: flex; align-items: center; gap: var(--sp-1); margin: 0 0 6px; }
.gh__sec-title { flex: 1 1 auto; margin: 0; color: var(--fg-muted); font-size: var(--fs-sm); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
.gh__sec-hint { margin: 0; color: var(--fg-subtle); font-size: var(--fs-sm); line-height: 1.45; }
.gh__links { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.gh__link {
  display: flex; align-items: center; gap: 8px; width: calc(100% + 16px); margin: 0 -8px; min-height: 36px; padding: 4px 8px;
  background: none; border: 0; border-radius: var(--r-1); color: var(--fg); font: inherit; text-align: left; cursor: pointer;
}
.gh__link:hover, .gh__link:focus-visible { background: var(--surface-3); outline: none; }
.gh__link-dir { flex: none; display: grid; color: var(--fg-subtle); }
.gh__link-dir svg { width: 15px; height: 15px; }
.gh__link-main { flex: 1 1 auto; min-width: 0; }
.gh__link-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh__link-why { display: block; color: var(--fg-subtle); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh__link-art { flex: none; color: var(--fg-subtle); font-size: var(--fs-xs); }
.gh__vorschlag { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 0; }
.gh__vorschlag .gh__link-main { cursor: default; }
.gh__vorschlag .btn { flex: none; }
.gh__ki { margin: 6px 0 0; color: var(--fg); font-size: var(--fs-base); line-height: var(--lh); white-space: pre-wrap; }
.gh__ki--fehlt { color: var(--fg-subtle); }
.gh__themen { display: flex; flex-wrap: wrap; gap: 6px; }
.gh__themen .chip { min-height: 26px; padding: 0 9px; font-size: var(--fs-xs); }

/* Zustaende in der Mitte: laden, Fehler, leer. */
.gh__state {
  position: absolute; inset: 0; z-index: 2; display: grid; place-items: center;
  padding: var(--sp-4); text-align: center; pointer-events: none;
}
.gh__state[hidden] { display: none; }
.gh__state-box { max-width: 460px; pointer-events: auto; }
.gh__state-title { margin: 0 0 8px; font-size: var(--fs-2xl); font-weight: 500; letter-spacing: -0.015em; color: var(--fg); }
.gh__state-text { margin: 0; color: var(--fg-muted); font-size: var(--fs-md); line-height: var(--lh); }
.gh__state-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: var(--sp-3); }
.gh__state .spinner { margin: 0 auto 10px; }
.gh__count { color: var(--fg-subtle); font-size: var(--fs-sm); white-space: nowrap; font-variant-numeric: tabular-nums; margin-right: var(--sp-1); }
.gh__switch { margin-right: var(--sp-1); }
.gh__switch .segmented__option { min-height: 28px; }

/* Die ruhige Themenkarte liegt ueber den Leinwaenden. */
.gh__karte { position: absolute; inset: 0; z-index: 2; overflow: auto; background: var(--bg); }
.gh__karte[hidden] { display: none; }
.gh[data-ansicht="karte"] .gh__top, .gh[data-ansicht="karte"] .gh__hint, .gh[data-ansicht="karte"] .gh__card { display: none; }

@media (pointer: coarse) {
  .gh__crumb { min-height: 36px; }
  .gh__chips .chip { min-height: 36px; }
  .gh__link { min-height: 44px; }
  .gh__card-head .icon-button { width: 40px; height: 40px; }
  .gh__result { min-height: 40px; }
}
@media (max-width: 760px) {
  .gh__card { top: auto; right: 10px; left: 10px; bottom: 10px; width: auto; max-height: 52%; }
  .gh__card[data-kompakt="ja"] .gh__sec, .gh__card[data-kompakt="ja"] .gh__card-snip, .gh__card[data-kompakt="ja"] .gh__card-tags { display: none; }
  .gh__hint { display: none; }
  .gh__search { width: 190px; }
  .gh__count { display: none; }
}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

/* ------------------------------------------------------------------ */
/* Die Ansicht                                                         */
/* ------------------------------------------------------------------ */

let view = null;

function teardown() {
  if (!view) return;
  const dying = view;
  view = null;
  dying.alive = false;
  for (const off of dying.cleanups.splice(0)) {
    try {
      off();
    } catch (err) {
      console.error('[gehirn] Aufräumen ist gescheitert:', err);
    }
  }
  if (dying.abort) dying.abort.abort();
  if (dying.uni) dying.uni.destroy();
  if (dying.netz) dying.netz.destroy();
  if (dying.karte) dying.karte.destroy();
  if (dying.dom.root) delete dying.dom.root.gehirn;
}

export default {
  id: 'graph',
  title: 'Gehirn',

  async mount(container, ctx) {
    ensureStyle();
    teardown();
    const params = (ctx.route && ctx.route.params) || {};
    const self = {
      alive: true,
      ctx,
      container,
      cleanups: [],
      abort: null,
      uni: null, // Zeichner der Themen-Ebene
      netz: null, // Zeichner der Netz-Ebene
      karte: null, // die ruhige Themenkarte
      dom: {},
      // Was geladen ist
      universum: null, // {themen, verbindungen, gesamt}
      lokal: null, // Ersatz-Universum im Browser, falls die Route fehlt
      ebene: 0,
      ansicht: params.ansicht === 'karte' ? 'karte' : 'universum',
      thema: null, // {id, name, ...} des offenen Themas (Ebene 1)
      pfad: [], // Eltern des offenen Themas
      fokusId: null, // Ebene 1 als Umfeld eines Eintrags
      nodes: [],
      edges: [],
      byId: new Map(),
      klein: false, // unter KLEIN_AB Eintraegen: kein Universum
      leer: false,
      loading: true,
      error: null,
      selectedId: null,
      hiddenTypes: new Set(AB_WERK_AUS),
      fokusModus: false,
      query: '',
      matches: [],
      fernTreffer: [],
      fernThemen: [],
      wechsel: 0, // laufende Ueberblendung
      ladeToken: 0,
      kartenToken: 0,
      wunsch: { focus: typeof params.focus === 'string' && params.focus ? params.focus : null, thema: typeof params.thema === 'string' && params.thema ? params.thema : null },
    };
    view = self;
    build(self);
    await start(self);
  },

  async unmount() {
    teardown();
  },
};

/* ---------------------------- Aufbau -------------------------------- */

function build(self) {
  const { ctx, container, dom } = self;
  clear(container);

  dom.canvasUni = h('canvas.gh__canvas.gh__canvas--uni', { tabindex: '0', role: 'img', 'aria-label': 'Themen des Wissensuniversums' });
  dom.canvasNetz = h('canvas.gh__canvas.gh__canvas--netz', { tabindex: '0', role: 'img', 'aria-label': 'Netz eines Themas' });
  dom.layerUni = h('div.gh__layer.gh__layer--uni', { dataset: { zustand: 'weg' } }, dom.canvasUni);
  dom.layerNetz = h('div.gh__layer.gh__layer--netz', { dataset: { zustand: 'weg' } }, dom.canvasNetz);
  dom.crumbs = h('nav.gh__crumbs', { 'aria-label': 'Pfad im Wissen' });
  dom.tools = h('div.gh__tools');
  dom.top = h('div.gh__top', null, dom.crumbs, dom.tools);
  dom.hint = h('p.gh__hint', { hidden: true });
  dom.card = h('aside.gh__card', { hidden: true, 'aria-label': 'Ausgewählter Eintrag' });
  dom.state = h('div.gh__state', { hidden: true });
  dom.karte = h('div.gh__karte', { hidden: true });
  dom.live = h('p.gh__live', { role: 'status', 'aria-live': 'polite' });
  dom.root = h('div.gh', { dataset: { ruhe: 'nein', ebene: '0', ansicht: self.ansicht } },
    dom.layerUni, dom.layerNetz, dom.top, dom.hint, dom.state, dom.card, dom.karte, dom.live);
  container.appendChild(dom.root);

  // Der Kopf der Schale: Umschalter Universum | Karte und die Zahl.
  dom.count = h('span.gh__count');
  dom.switch = h('div.segmented.gh__switch', { role: 'tablist', 'aria-label': 'Darstellung des Gehirns' },
    h('button.segmented__option', { type: 'button', role: 'tab', dataset: { ansicht: 'universum' }, onClick: () => setAnsicht(self, 'universum') }, text('Universum')),
    h('button.segmented__option', { type: 'button', role: 'tab', dataset: { ansicht: 'karte' }, onClick: () => setAnsicht(self, 'karte') }, text('Karte')));
  ctx.setHeadActions(dom.count, dom.switch);
  renderSwitch(self);

  self.uni = createGraphCanvas(dom.canvasUni, {
    themen: true,
    onSelect: (node) => { if (node) tauchen(self, node.id, { woher: 'tippen' }); },
    onDive: (node) => { if (node) tauchen(self, node.id, { woher: 'zoom' }); },
    onHover: (node) => announce(self, node ? `Thema ${node.label}, ${formatNumber(node.anzahl)} Einträge` : ''),
  });
  // Luft um die Kreise: die Karte fuellt den Rahmen nicht bis an den Rand (Vision: viel freier Platz).
  self.uni.setPadding({ top: 84, right: 96, bottom: 72, left: 88 });

  self.netz = createGraphCanvas(dom.canvasNetz, {
    onSelect: (node) => select(self, node ? node.id : null, { fromCanvas: true }),
    onOpen: (node) => openNode(self, node),
    onLongPress: (node) => { if (node) { select(self, node.id, { fromCanvas: true, voll: true }); } },
    onHover: (node) => announce(self, node ? `${artVon(node)}: ${node.label}` : ''),
    onSurface: () => auftauchen(self, { woher: 'zoom' }),
    onSettle: () => { if (self.alive) dom.root.dataset.ruhe = 'ja'; },
    onWake: () => { if (self.alive) dom.root.dataset.ruhe = 'nein'; },
  });
  self.netz.setPadding({ top: 72, right: 72, bottom: 48, left: 56 });

  // Die ruhige Themenkarte teilt sich die Daten mit dem Universum.
  self.karte = createWissenskarte(dom.karte, {
    ctx,
    ladeUniversum: () => ladeUniversum(self),
    ladeThema: (id) => ladeThemaDaten(self, id),
    onThema: (id) => { setAnsicht(self, 'universum'); if (id) tauchen(self, id, { woher: 'karte' }); else auftauchen(self, { woher: 'karte' }); },
    onKnoten: (node, themaId) => {
      setAnsicht(self, 'universum');
      if (themaId && !(self.ebene === 1 && self.thema && self.thema.id === themaId)) {
        tauchen(self, themaId, { woher: 'karte', dann: node.id });
      } else if (self.byId.has(node.id)) {
        select(self, node.id, { hinzoomen: true });
      } else {
        umfeld(self, node.id);
      }
    },
    onOeffnen: (node) => openNode(self, node),
  });

  // Die Leinwaende folgen der Darstellung (hell/dunkel), auch mitten im Blick.
  const retheme = () => {
    if (!self.alive) return;
    requestAnimationFrame(() => {
      if (!self.alive) return;
      self.uni.refreshTheme();
      self.netz.refreshTheme();
      faerben(self);
    });
  };
  if (ctx.state && typeof ctx.state.on === 'function') self.cleanups.push(ctx.state.on('theme', retheme));
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', retheme);
    self.cleanups.push(() => media.removeEventListener('change', retheme));
  } catch { /* ohne matchMedia bleibt die erste Palette */ }

  // Live: neue Verbindungen sofort, alles andere gebuendelt.
  const bald = debounce(() => { if (self.alive) nachladen(self); }, 1200);
  self.cleanups.push(() => bald.cancel && bald.cancel());
  if (ctx.bus && typeof ctx.bus.on === 'function') {
    self.cleanups.push(ctx.bus.on('graph.kante', (payload) => neueKante(self, payload, bald)));
    for (const name of ['record.created', 'record.updated', 'record.deleted', 'graph.rescanned']) {
      self.cleanups.push(ctx.bus.on(name, () => bald()));
    }
  }

  // Tasten, die ueberall im Gehirn gelten.
  self.cleanups.push(on(document, 'keydown', (event) => {
    if (!self.alive || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const t = event.target;
    const tippt = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (event.key === 'Escape') {
      if (tippt) return; // das Feld selbst leert sich
      if (self.ansicht === 'karte') return;
      if (document.querySelector('.dialog')) return;
      event.preventDefault();
      if (self.selectedId) select(self, null);
      else if (self.fokusModus) setFokusModus(self, false);
      else if (self.ebene === 1 && !self.klein) auftauchen(self, { woher: 'taste' });
      return;
    }
    if (tippt || self.ansicht === 'karte') return;
    const canvas = self.ebene === 1 ? self.netz : self.uni;
    const el = self.ebene === 1 ? dom.canvasNetz : dom.canvasUni;
    if (t === el) return; // der Zeichner hat die Taste schon
    let handled = true;
    switch (event.key) {
      case '+': case '=': canvas.zoomBy(1.25, undefined, undefined, true); break;
      case '-': case '_': canvas.zoomBy(0.8, undefined, undefined, true); break;
      case '0': canvas.fitToView(); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
        el.focus({ preventScroll: true });
        el.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, shiftKey: event.shiftKey, bubbles: false }));
        break;
      case '/': dom.search && dom.search.focus(); break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  }));
  // Klick ausserhalb der Suche schliesst die Trefferliste.
  self.cleanups.push(on(document, 'pointerdown', (event) => {
    if (dom.searchOffen && dom.searchWrap && !dom.searchWrap.contains(event.target)) schliesseSuche(self);
  }));

  renderCrumbs(self);
  renderTools(self);
  renderHint(self);

  // Fuer Pruefwerkzeuge: was gerade zu sehen ist, ohne Pixel zu raten.
  dom.root.gehirn = {
    get ebene() { return self.ebene; },
    get ansicht() { return self.ansicht; },
    get thema() { return self.thema; },
    get selectedId() { return self.selectedId; },
    get nodes() { return self.nodes.length; },
    get ids() { return self.nodes.filter((n) => !n.ausserhalb).map((n) => n.id); },
    get themen() { return self.universum ? self.universum.themen.length : 0; },
    get themenIds() { return self.universum ? self.universum.themen.map((t) => t.id) : []; },
    get klein() { return self.klein; },
    get leer() { return self.leer; },
    screenPosition(id) {
      const canvas = self.ebene === 1 ? self.netz : self.uni;
      return canvas.screenPosition(id);
    },
    /** Der Knoten unter einem Punkt der Leinwand (CSS-Pixel), oder null -- fuer Pruefwerkzeuge. */
    nodeAt(x, y) {
      const canvas = self.ebene === 1 ? self.netz : self.uni;
      return canvas.nodeAtScreen(x, y);
    },
    stats() { return (self.ebene === 1 ? self.netz : self.uni).stats(); },
    tauchen: (id) => tauchen(self, id, { woher: 'test' }),
    auftauchen: () => auftauchen(self, { woher: 'test' }),
    select: (id) => select(self, id),
  };
}

/* ---------------------------- Laden --------------------------------- */

function neuerAbort(self) {
  if (self.abort) self.abort.abort();
  self.abort = new AbortController();
  return self.abort.signal;
}

/** Ebene 0 laden -- vom Server, sonst im Browser gerechnet. Merkt sich das Ergebnis. */
async function ladeUniversum(self, { frisch = false } = {}) {
  if (self.universum && !frisch) return self.universum;
  const { ctx } = self;
  let data;
  try {
    data = await ctx.api.get('/graph/universum', { query: { tiefe: 0 }, timeoutMs: 20000 });
    self.lokal = null;
    self.universum = normaliseEbene0(data);
  } catch (err) {
    if (!(err && err.status === 404)) throw err;
    // Ein aelterer Server: dieselben Gruppen, im Browser gerechnet.
    const graph = await ctx.api.get('/graph', { query: { limit: LOAD_LIMIT, includeOrphans: true }, timeoutMs: 20000 });
    self.lokal = universumLokal(graph);
    self.universum = normaliseEbene0(self.lokal);
  }
  return self.universum;
}

/** Ebene 1 eines Themas laden (Server oder Ersatz). */
async function ladeThemaDaten(self, themaId) {
  const { ctx } = self;
  if (self.lokal) {
    const e1 = ebene1Lokal(self.lokal, themaId);
    if (!e1) {
      const err = new Error('Dieses Thema gibt es nicht mehr.');
      err.status = 404;
      throw err;
    }
    return normaliseEbene1(e1);
  }
  const data = await ctx.api.get('/graph/universum', { query: { tiefe: 1, thema: themaId }, timeoutMs: 20000 });
  return normaliseEbene1(data);
}

/** Das Umfeld eines Eintrags bis Tiefe 2 -- als eigene Ebene 1. */
async function ladeUmfeld(self, id) {
  const data = await self.ctx.api.get('/graph', { query: { focus: id, depth: 2, limit: 400, includeOrphans: true }, timeoutMs: 20000 });
  return normaliseEbene1({ thema: null, knoten: data.nodes, kanten: data.edges });
}

/** Alles auf einmal -- fuer kleine Tresore ohne Themen-Ebene. */
async function ladeAlles(self) {
  const data = await self.ctx.api.get('/graph', { query: { limit: LOAD_LIMIT, includeOrphans: true }, timeoutMs: 20000 });
  return normaliseEbene1({ thema: null, knoten: data.nodes, kanten: data.edges });
}

async function start(self) {
  const { dom } = self;
  self.loading = true;
  self.error = null;
  renderState(self);
  const token = ++self.ladeToken;
  try {
    const u = await ladeUniversum(self, { frisch: true });
    if (!self.alive || token !== self.ladeToken) return;
    self.loading = false;
    self.leer = u.gesamt.knoten === 0;
    self.klein = !self.leer && u.gesamt.knoten < KLEIN_AB;
    renderState(self);
    renderCount(self);
    if (self.leer) {
      dom.layerUni.dataset.zustand = 'weg';
      dom.layerNetz.dataset.zustand = 'weg';
      renderCrumbs(self);
      renderTools(self); // kein Suchfeld ueber einem leeren Universum
      renderHint(self);
      return;
    }
    if (self.wunsch.focus) {
      const id = self.wunsch.focus;
      self.wunsch.focus = null;
      await umfeld(self, id, { sofort: true });
      return;
    }
    if (self.wunsch.thema && !self.klein) {
      const id = self.wunsch.thema;
      self.wunsch.thema = null;
      zeigeUniversum(self, { sofort: true });
      await tauchen(self, id, { woher: 'adresse', sofort: true });
      return;
    }
    if (self.klein) {
      await zeigeNetz(self, { art: 'alles', sofort: true });
      return;
    }
    zeigeUniversum(self, { sofort: false });
  } catch (err) {
    if (!self.alive || token !== self.ladeToken || (err && (err.isAborted || err.name === 'AbortError'))) return;
    self.loading = false;
    self.error = err;
    renderState(self);
  }
}

/** Nach einem Ereignis vom Bus: die gezeigte Ebene neu laden, Positionen bleiben. */
async function nachladen(self) {
  if (!self.alive || self.loading) return;
  const token = ++self.ladeToken;
  try {
    const u = await ladeUniversum(self, { frisch: true });
    if (!self.alive || token !== self.ladeToken) return;
    const warLeer = self.leer;
    self.leer = u.gesamt.knoten === 0;
    self.klein = !self.leer && u.gesamt.knoten < KLEIN_AB;
    if (self.ebene === 0 || warLeer) {
      if (self.leer) { renderState(self); renderCount(self); renderCrumbs(self); renderTools(self); return; }
      if (self.klein) { await zeigeNetz(self, { art: 'alles', sofort: true }); return; }
      themenZeichnen(self, { neu: warLeer });
      renderState(self);
    } else if (self.fokusId) {
      const e1 = await ladeUmfeld(self, self.fokusId);
      if (!self.alive || token !== self.ladeToken) return;
      netzDaten(self, e1, { still: true });
    } else if (self.thema) {
      const e1 = await ladeThemaDaten(self, self.thema.id);
      if (!self.alive || token !== self.ladeToken) return;
      self.thema = { ...self.thema, ...e1.thema };
      self.pfad = e1.pfad;
      netzDaten(self, e1, { still: true });
    } else if (self.klein) {
      const e1 = await ladeAlles(self);
      if (!self.alive || token !== self.ladeToken) return;
      netzDaten(self, e1, { still: true });
    }
    if (self.karte) self.karte.aktualisieren();
    renderCount(self);
    renderCrumbs(self);
  } catch (err) {
    if (!(err && err.status === 404)) console.warn('[gehirn] Nachladen ist gescheitert:', err && err.message);
  }
}

/* ---------------------------- Ebene 0 ------------------------------- */

function themenZeichnen(self, { neu = false } = {}) {
  const u = self.universum;
  if (!u) return;
  const lage = layoutThemen(u.themen, u.verbindungen);
  const nodes = u.themen.map((t) => {
    const p = lage.get(t.id) || { x: 0, y: 0 };
    return { id: t.id, label: t.name, anzahl: t.anzahl, farbe: t.farbe, x: p.x, y: p.y, kinder: t.kinder, knoten: t.knoten };
  });
  const edges = u.verbindungen.map((v) => ({ from: v.from, to: v.to, anzahl: v.anzahl }));
  self.uni.setData({ nodes, edges });
  self.uni.setColors(new Map(nodes.map((n) => [n.id, n.farbe])), THEME_HUES);
  if (neu) self.uni.enter();
  self.uni.fitToView({ animate: false });
}

function zeigeUniversum(self, { sofort = false } = {}) {
  const { dom } = self;
  self.ebene = 0;
  self.thema = null;
  self.pfad = [];
  self.fokusId = null;
  self.fokusModus = false;
  dom.root.dataset.ebene = '0';
  dom.root.dataset.ruhe = 'ja';
  select(self, null, { still: true });
  themenZeichnen(self, { neu: true });
  dom.layerNetz.dataset.zustand = 'weg';
  dom.layerUni.dataset.zustand = 'da';
  void sofort;
  renderCrumbs(self);
  renderTools(self);
  renderHint(self);
  renderCount(self);
  describe(self);
  if (self.query) suchen(self, self.query);
  adresse(self);
}

/**
 * Hinein in ein Thema: die Kamera faehrt in den Kreis, das Netz baut sich
 * darin auf. Waehrend die Daten kommen, laeuft schon die Ueberblendung.
 */
async function tauchen(self, themaId, { woher = 'tippen', sofort = false, dann = null } = {}) {
  if (!self.alive || self.ebene === 1 && self.thema && self.thema.id === themaId && !dann) return;
  const { dom } = self;
  const token = ++self.ladeToken;
  const wechsel = ++self.wechsel;
  // Vom Kreis aus hineinfahren: die Mitte des Kreises ist der Ursprung.
  const pos = self.uni.screenPosition(themaId);
  if (pos && dom.layerUni.dataset.zustand === 'da') {
    dom.layerUni.style.transformOrigin = `${pos.x}px ${pos.y}px`;
    dom.layerUni.dataset.zustand = 'tief';
  } else {
    dom.layerUni.dataset.zustand = 'weg';
  }
  self.uni.setSelection(null);
  announce(self, 'Thema wird geöffnet …');
  let e1;
  try {
    e1 = await ladeThemaDaten(self, themaId);
  } catch (err) {
    if (!self.alive || token !== self.ladeToken) return;
    dom.layerUni.dataset.zustand = 'da';
    self.ctx.toast(err && err.status === 404 ? 'Dieses Thema gibt es nicht mehr.' : `Das Thema konnte nicht geladen werden: ${err && err.message ? err.message : 'unbekannter Fehler'}`, 'error');
    return;
  }
  if (!self.alive || token !== self.ladeToken || wechsel !== self.wechsel) return;
  self.thema = e1.thema.id ? e1.thema : { id: themaId, name: 'Thema', anzahl: e1.nodes.length, farbe: 0, kinder: [] };
  self.pfad = e1.pfad;
  self.fokusId = null;
  await zeigeNetz(self, { art: 'thema', daten: e1, sofort, dann });
  void woher;
}

/** Das Umfeld eines Eintrags als eigene Ebene 1, der Eintrag gewaehlt. */
async function umfeld(self, id, { sofort = false } = {}) {
  if (!self.alive) return;
  const token = ++self.ladeToken;
  const { dom } = self;
  if (dom.layerUni.dataset.zustand === 'da') dom.layerUni.dataset.zustand = 'tief';
  let e1;
  try {
    e1 = await ladeUmfeld(self, id);
  } catch (err) {
    if (!self.alive || token !== self.ladeToken) return;
    if (self.ebene === 0) dom.layerUni.dataset.zustand = 'da';
    self.ctx.toast(err && err.status === 404 ? 'Diesen Eintrag gibt es nicht mehr.' : `Das Umfeld konnte nicht geladen werden: ${err && err.message ? err.message : 'unbekannter Fehler'}`, err && err.status === 404 ? 'info' : 'error');
    if (self.ebene === 0 && dom.layerUni.dataset.zustand !== 'da') zeigeUniversum(self);
    return;
  }
  if (!self.alive || token !== self.ladeToken) return;
  const mitte = e1.nodes.find((n) => n.id === id);
  self.thema = null;
  self.pfad = [];
  self.fokusId = id;
  await zeigeNetz(self, { art: 'umfeld', daten: e1, sofort, dann: id, name: mitte ? mitte.label : 'Eintrag' });
}

/** Die Netz-Ebene mit Daten fuellen und zeigen. */
async function zeigeNetz(self, { art, daten = null, sofort = false, dann = null } = {}) {
  const { dom } = self;
  let e1 = daten;
  if (!e1) {
    const token = ++self.ladeToken;
    try {
      e1 = art === 'alles' ? await ladeAlles(self) : null;
    } catch (err) {
      if (!self.alive) return;
      self.error = err;
      self.loading = false;
      renderState(self);
      return;
    }
    if (!self.alive || token !== self.ladeToken || !e1) return;
    self.thema = null;
    self.pfad = [];
    self.fokusId = null;
  }
  self.ebene = 1;
  self.fokusModus = false;
  dom.root.dataset.ebene = '1';
  dom.root.dataset.ruhe = 'nein';
  select(self, null, { still: true });
  netzDaten(self, e1, { still: false });
  // Ueberblenden: das Netz kommt klein und wird gross, das Universum ist schon tief.
  dom.layerNetz.dataset.zustand = sofort ? 'da' : 'klein';
  if (!sofort) {
    // Zwei Bilder Abstand, damit der Uebergang wirklich laeuft.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!self.alive || self.ebene !== 1) return;
    dom.layerNetz.dataset.zustand = 'da';
  }
  self.netz.enter(sofort ? 0 : 120);
  setTimeout(() => { if (self.alive && self.ebene === 1) dom.layerUni.dataset.zustand = 'weg'; }, BLEND_MS);
  renderCrumbs(self);
  renderTools(self);
  renderHint(self);
  renderCount(self);
  describe(self);
  if (self.query) suchen(self, self.query);
  adresse(self);
  if (dann && self.byId.has(dann)) {
    select(self, dann, { hinzoomen: true });
  }
}

/** Die Daten einer Ebene 1 in den Zeichner: Positionen bleiben pro id. */
function netzDaten(self, e1, { still = false } = {}) {
  self.nodes = e1.nodes;
  self.edges = e1.edges;
  self.byId = new Map(self.nodes.map((n) => [n.id, n]));
  const netz = self.netz;
  netz.setData({ nodes: self.nodes, edges: self.edges });
  applyFilter(self, { quiet: true });
  faerben(self);
  if (!still) {
    // Die ersten, wildesten Schritte rechnet der Zeichner vorab; dann folgt
    // die Kamera der Wolke weich, bis sie ruht. Wer weniger Bewegung mag,
    // bekommt das fertige Bild.
    let ruhig = false;
    try { ruhig = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* dann mit Bewegung */ }
    const n = self.nodes.length;
    if (ruhig) netz.prewarm(400, 1200);
    else if (n > 1500) netz.prewarm(70, 420);
    else if (n > 400) netz.prewarm(110, 320);
    else netz.prewarm(150, 260);
    netz.fitToView({ animate: false, follow: true });
  }
  if (self.selectedId && !self.byId.has(self.selectedId)) select(self, null, { still: true });
  if (self.selectedId) renderCard(self);
}

/** Ein Hauch der Themenfarbe fuer die Knoten des Themas; Nachbarn ausserhalb bleiben grau. */
function faerben(self) {
  if (!self.netz) return;
  if (self.ebene !== 1 || !self.thema) {
    self.netz.setColors(null);
    return;
  }
  const map = new Map();
  for (const node of self.nodes) if (!node.ausserhalb) map.set(node.id, self.thema.farbe);
  self.netz.setColors(map, THEME_HUES);
}

/** Zurueck in die Uebersicht: das Netz wird klein, die Kreise kommen wieder. */
async function auftauchen(self, { woher = 'taste' } = {}) {
  if (!self.alive || self.ebene !== 1 || self.klein) return;
  const { dom } = self;
  ++self.ladeToken;
  ++self.wechsel;
  // Ein Kind-Thema: eine Ebene hoch ist sein Elternthema, nicht die Wurzel.
  if (self.thema && self.pfad.length && woher !== 'wurzel') {
    const eltern = self.pfad[self.pfad.length - 1];
    dom.layerNetz.dataset.zustand = 'klein';
    await tauchen(self, eltern.id, { woher: 'auf' });
    return;
  }
  dom.layerNetz.dataset.zustand = 'klein';
  zeigeUniversum(self);
  announce(self, 'Zurück im Universum.');
}

/** Die Adresse folgt der Ebene, ohne die Ansicht neu zu bauen. */
function adresse(self) {
  const { ctx } = self;
  if (typeof ctx.replaceRoute !== 'function') return;
  let ziel = '#/graph';
  if (self.ansicht === 'karte') ziel = `#/graph?ansicht=karte${self.thema ? `&thema=${encodeURIComponent(self.thema.id)}` : ''}`;
  else if (self.ebene === 1 && self.fokusId) ziel = `#/graph?focus=${encodeURIComponent(self.fokusId)}`;
  else if (self.ebene === 1 && self.thema) ziel = `#/graph?thema=${encodeURIComponent(self.thema.id)}`;
  try { ctx.replaceRoute(ziel); } catch { /* die Adresse ist Komfort, kein Muss */ }
}

/* ---------------------------- Karte | Universum ---------------------- */

function setAnsicht(self, ansicht) {
  if (self.ansicht === ansicht) return;
  self.ansicht = ansicht;
  self.dom.root.dataset.ansicht = ansicht;
  renderSwitch(self);
  if (ansicht === 'karte') {
    self.dom.karte.hidden = false;
    self.karte.zeige(self.thema ? self.thema.id : null);
  } else {
    self.dom.karte.hidden = true;
  }
  adresse(self);
}

function renderSwitch(self) {
  for (const b of self.dom.switch.querySelectorAll('.segmented__option')) {
    const active = b.dataset.ansicht === self.ansicht;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  self.dom.karte.hidden = self.ansicht !== 'karte';
  if (self.ansicht === 'karte' && self.karte) self.karte.zeige(self.thema ? self.thema.id : null);
}

/* ---------------------------- Filter -------------------------------- */

function applyFilter(self, { quiet = false } = {}) {
  const hidden = self.hiddenTypes;
  const keep = self.selectedId;
  const fokus = self.fokusModus && self.selectedId ? self.netz.neighbourhood(self.selectedId, 2) : null;
  self.netz.setFilter((node) => (node.id === keep) || ((!hidden.has(node.type)) && (!fokus || fokus.has(node.id))));
  if (!quiet) {
    if (self.query) suchen(self, self.query);
    describe(self);
    renderCount(self);
  }
}

function setFokusModus(self, an) {
  self.fokusModus = !!an && !!self.selectedId;
  applyFilter(self);
  renderTools(self);
  if (self.fokusModus) self.netz.fitToView();
  if (self.selectedId) renderCard(self);
}

/* ---------------------------- Suche --------------------------------- */

const suchenFern = debounce(async (self, q) => {
  if (!self.alive || self.query !== q || q.length < 2) return;
  try {
    const data = await self.ctx.api.get('/graph', { query: { q, limit: 12, includeOrphans: true }, timeoutMs: 8000 });
    if (!self.alive || self.query !== q) return;
    const hits = (data.nodes || []).filter((n) => !AB_WERK_AUS.has(n.type));
    if (self.ebene === 1) {
      // Treffer im Text eines geladenen Knotens zaehlen hier -- nicht "anderswo".
      const bekannt = new Set(self.matches.map((n) => n.id));
      const hier = hits.filter((n) => self.byId.has(n.id) && !bekannt.has(n.id) && !self.hiddenTypes.has(n.type)).map((n) => self.byId.get(n.id));
      if (hier.length) {
        self.matches = [...self.matches, ...hier];
        self.netz.setHighlight(self.matches.map((n) => n.id));
      }
      self.fernTreffer = hits.filter((n) => !self.byId.has(n.id));
    } else {
      self.fernTreffer = hits;
    }
  } catch {
    self.fernTreffer = [];
  }
  renderResults(self);
}, 220);

function suchen(self, value, { jump = false } = {}) {
  const q = String(value || '').trim();
  self.query = q;
  if (!q) {
    self.matches = [];
    self.fernTreffer = [];
    self.fernThemen = [];
    self.uni.setHighlight(null);
    self.netz.setHighlight(null);
    renderResults(self);
    return;
  }
  if (self.ebene === 0) {
    self.fernThemen = self.universum ? sucheThemen(self.universum.themen, q) : [];
    self.matches = [];
    self.uni.setHighlight(self.fernThemen.map((r) => r.thema.id));
  } else {
    self.fernThemen = self.universum ? sucheThemen(self.universum.themen, q).slice(0, 3) : [];
    self.matches = sucheKnoten(self.nodes.filter((n) => !self.hiddenTypes.has(n.type)), q);
    self.netz.setHighlight(self.matches.map((n) => n.id));
  }
  suchenFern(self, q);
  renderResults(self);
  if (jump) springen(self);
}

/** Eingabetaste: zum ersten Treffer. */
function springen(self) {
  if (self.ebene === 1 && self.matches.length) {
    const hit = self.matches[0];
    select(self, hit.id, { hinzoomen: true });
    return;
  }
  if (self.ebene === 0 && self.fernThemen.length) {
    const r = self.fernThemen[0];
    const ziel = passt(self.query, r.thema.name) || !r.kinder.length ? r.thema.id : r.kinder[0].id;
    tauchen(self, ziel, { woher: 'suche' });
    return;
  }
  if (self.fernTreffer.length) {
    umfeld(self, self.fernTreffer[0].id);
    return;
  }
  if (self.fernThemen.length) tauchen(self, self.fernThemen[0].thema.id, { woher: 'suche' });
}

function renderResults(self) {
  const { dom } = self;
  if (!dom.results) return;
  clear(dom.results);
  const q = self.query;
  dom.results.hidden = !q || dom.searchOffen !== true;
  if (!q || dom.searchOffen !== true) return;
  const rows = [];
  const zeile = (opts) => h('li', null, h('button.gh__result', { type: 'button', onClick: opts.onClick },
    opts.farbe !== undefined ? h('span.gh__dot', { style: { background: `color-mix(in srgb, ${THEME_HUES[opts.farbe] || THEME_HUES[0]} 55%, var(--fg-muted))` } }) : null,
    h('span.gh__result-main', null, text(opts.title)),
    h('span.gh__result-sub', null, text(opts.sub))));
  if (self.ebene === 1 && self.matches.length) {
    rows.push(h('li.gh__results-head', null, text(self.thema ? `In ${self.thema.name}` : 'Hier')));
    for (const node of self.matches.slice(0, 6)) {
      rows.push(zeile({ title: node.label, sub: artVon(node), onClick: () => { select(self, node.id, { hinzoomen: true }); schliesseSuche(self); } }));
    }
  }
  if (self.fernThemen.length) {
    rows.push(h('li.gh__results-head', null, text('Themen')));
    for (const r of self.fernThemen.slice(0, 5)) {
      rows.push(zeile({ farbe: r.thema.farbe, title: r.thema.name, sub: `${formatNumber(r.thema.anzahl)} Einträge`, onClick: () => { tauchen(self, r.thema.id, { woher: 'suche' }); schliesseSuche(self); } }));
      for (const k of r.kinder.slice(0, 3)) {
        rows.push(zeile({ farbe: k.farbe, title: `${r.thema.name} › ${k.name}`, sub: `${formatNumber(k.anzahl)}`, onClick: () => { tauchen(self, k.id, { woher: 'suche' }); schliesseSuche(self); } }));
      }
    }
  }
  if (self.fernTreffer.length) {
    rows.push(h('li.gh__results-head', null, text(self.ebene === 1 ? 'Anderswo im Wissen' : 'Einträge')));
    for (const node of self.fernTreffer.slice(0, 6)) {
      rows.push(zeile({ title: node.label, sub: artVon(node), onClick: () => { umfeld(self, node.id); schliesseSuche(self); } }));
    }
  }
  if (!rows.length) rows.push(h('li.gh__empty-result', null, text(q.length < 2 ? 'Weiter tippen …' : 'Nichts gefunden.')));
  dom.results.append(...rows);
}

function schliesseSuche(self) {
  self.dom.searchOffen = false;
  renderResults(self);
}

/* ---------------------------- Auswahl ------------------------------- */

function select(self, id, { fromCanvas = false, hinzoomen = false, still = false, voll = false } = {}) {
  const next = id && self.byId.has(id) ? id : null;
  const vorher = self.selectedId;
  self.selectedId = next;
  if (vorher !== next && self.fokusModus) {
    self.fokusModus = !!next;
    applyFilter(self, { quiet: true });
    renderTools(self);
  } else if (vorher && !next && self.hiddenTypes.has((self.byId.get(vorher) || {}).type)) {
    applyFilter(self, { quiet: true });
  }
  if (!fromCanvas) self.netz.setSelection(next);
  // Neben der offenen Karte bleibt weniger Flaeche: Einpassen und Hinzoomen
  // zielen auf die freie Mitte, nicht unter die Karte.
  self.netz.setPadding({ right: next && !istSchmal(self) ? 340 + 28 + 24 : 72 });
  if (next && hinzoomen) self.netz.focus(next, { zoom: Math.max(1.6, self.netz.transform.k) });
  self.dom.card.dataset.kompakt = voll || !fromCanvas || !istSchmal(self) ? 'nein' : 'ja';
  renderCard(self);
  if (!still) {
    const node = next ? self.byId.get(next) : null;
    if (node) announce(self, `Gewählt: ${artVon(node)} ${node.label}`);
    describe(self);
    renderTools(self);
  }
}

function istSchmal(self) {
  return self.dom.root.clientWidth < 760;
}

function openNode(self, node) {
  if (!node) return;
  const route = OPEN_ROUTES[node.type];
  if (route) self.ctx.navigate(route(node.id));
}

/** Zu einem verknuepften Eintrag springen -- hier, oder in sein Umfeld. */
function springeZu(self, id) {
  if (self.byId.has(id)) select(self, id, { hinzoomen: true });
  else umfeld(self, id);
}

/* ---------------------------- Karte (Detail) ------------------------ */

function renderCard(self) {
  const { dom } = self;
  clear(dom.card);
  const node = self.selectedId ? self.byId.get(self.selectedId) : null;
  dom.card.hidden = !node;
  if (!node) return;
  const token = ++self.kartenToken;
  const links = self.netz.neighbours(node.id).length;
  const route = OPEN_ROUTES[node.type];
  const farbe = self.thema && !node.ausserhalb ? self.thema.farbe : null;

  const scroll = h('div.gh__card-scroll');
  const kopf = h('div.gh__card-head', null,
    h('span.gh__card-kind', null,
      farbe !== null ? h('span.gh__dot', { style: { background: `color-mix(in srgb, ${THEME_HUES[farbe]} 55%, var(--fg-muted))` } }) : null,
      text(`${artVon(node)}${node.ausserhalb ? ' · außerhalb des Themas' : ''}`)),
    h('button.icon-button', { type: 'button', title: 'Schließen', 'aria-label': 'Auswahl schließen', onClick: () => select(self, null) }, icon(ICON.close)));
  const titel = h('h3.gh__card-title', null, text(node.label || 'Ohne Titel'));
  const snip = h('p.gh__card-snip', { hidden: !node.snippet || node.snippet === node.label }, text(node.snippet || ''));
  const tags = h('div.gh__card-tags', { hidden: !(node.tags && node.tags.length) },
    ...(node.tags || []).slice(0, 8).map((t) => h('span.chip', null, text(`#${String(t).replace(/^#/, '')}`))));
  const meta = h('p.gh__card-meta', null, text([
    node.updatedAt ? `zuletzt bearbeitet ${timeAgo(node.updatedAt)}` : null,
    links === 1 ? '1 Verbindung' : `${formatNumber(links)} Verbindungen`,
  ].filter(Boolean).join(' · ')));
  const actions = h('div.gh__card-actions', null,
    route
      ? h('button.btn.btn--accent', { type: 'button', onClick: () => openNode(self, node) }, icon(ICON.open), text('Öffnen'))
      : null,
    h('button.btn.btn--ghost', {
      type: 'button',
      title: 'Nur dieser Eintrag und seine Nachbarn bis Tiefe 2',
      'aria-pressed': self.fokusModus ? 'true' : 'false',
      class: self.fokusModus ? 'is-active' : '',
      onClick: () => setFokusModus(self, !self.fokusModus),
    }, icon(ICON.focus), text('Fokus')),
    self.fokusId !== node.id
      ? h('button.btn.btn--ghost', { type: 'button', title: 'Das Umfeld dieses Eintrags als eigene Ebene', onClick: () => umfeld(self, node.id) }, text('Umfeld'))
      : null);

  const verknuepft = h('div.gh__sec', null,
    h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text('Verknüpft mit'))),
    h('p.gh__sec-hint', null, text('Wird geladen …')));
  const dateien = h('div.gh__sec', { hidden: true });
  const vorschlaege = h('div.gh__sec', { hidden: true });
  const themen = h('div.gh__sec', { hidden: true });
  const ki = h('div.gh__sec', null,
    h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text('KI-Zusammenfassung'))),
    h('div', null, h('button.btn.btn--small', { type: 'button', onClick: (event) => zusammenfassen(self, node, event.currentTarget, ki) }, icon(ICON.spark), text('Zusammenfassen'))));

  scroll.append(kopf, titel, snip, tags, meta, actions, verknuepft, dateien, vorschlaege, themen, ki);
  dom.card.append(scroll);

  ladeVerknuepft(self, node, token, { verknuepft, dateien, vorschlaege, themen, snip });
}

async function ladeVerknuepft(self, node, token, teile) {
  const { ctx } = self;
  let v;
  try {
    v = normaliseVerknuepft(await ctx.api.get(`/records/${encodeURIComponent(node.id)}/verknuepft`, { timeoutMs: 12000 }));
  } catch (err) {
    if (!self.alive || token !== self.kartenToken) return;
    if (err && err.status === 404 && self.lokal) {
      // Aelterer Server: dasselbe aus dem Umfeld, ohne Vorschlaege.
      try {
        const g = await ctx.api.get('/graph', { query: { focus: node.id, depth: 1, limit: 200 }, timeoutMs: 12000 });
        v = verknuepftAusGraph(node.id, g);
      } catch { v = null; }
    } else if (err && err.status === 404) {
      v = null;
      clear(teile.verknuepft);
      teile.verknuepft.append(h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text('Verknüpft mit'))), h('p.gh__sec-hint', null, text('Diesen Eintrag gibt es nicht mehr.')));
      return;
    } else v = null;
  }
  if (!self.alive || token !== self.kartenToken) return;
  // Der Anfang des Textes, wenn das Netz keinen mitbringt.
  if (!node.snippet) {
    try {
      const r = await ctx.api.get(`/records/${encodeURIComponent(node.id)}`, { timeoutMs: 8000 });
      if (!self.alive || token !== self.kartenToken) return;
      const d = (r && r.record && r.record.data) || {};
      const roh = [d.body, d.description, d.text, d.content, d.goal].find((x) => typeof x === 'string' && x.trim());
      if (roh) {
        const klar = roh.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`[\]]/g, '').replace(/\s+/g, ' ').trim();
        if (klar && klar !== node.label) {
          node.snippet = klar.length > 280 ? `${klar.slice(0, 279).trimEnd()}…` : klar;
          clear(teile.snip);
          teile.snip.appendChild(text(node.snippet));
          teile.snip.hidden = false;
        }
      }
    } catch { /* ohne Anfang geht es auch */ }
  }
  clear(teile.verknuepft);
  if (!v) {
    teile.verknuepft.append(h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text('Verknüpft mit'))), h('p.gh__sec-hint', null, text('Die Verknüpfungen konnten gerade nicht geladen werden.')));
    return;
  }
  const zeile = (row, richtung) => h('li', null, h('button.gh__link', {
    type: 'button',
    title: row.reason ? `${richtung === 'out' ? 'Ausgehend' : 'Eingehend'} · ${row.reason}` : (richtung === 'out' ? 'Ausgehend' : 'Eingehend'),
    onClick: () => springeZu(self, row.id),
  },
  h('span.gh__link-dir', null, icon(richtung === 'out' ? ICON.out : ICON.in)),
  h('span.gh__link-main', null,
    h('span.gh__link-title', null, text(row.title)),
    row.reason ? h('span.gh__link-why', null, text(row.reason)) : null),
  h('span.gh__link-art', null, text(artVon(row)))));
  // Zwei Kanten zum selben Eintrag in derselben Richtung (Wiki-Link und
  // Schlagwort) sind EINE Zeile mit beiden Gruenden.
  const buendeln = (rows) => {
    const out = [];
    const byId = new Map();
    for (const r of rows) {
      const da = byId.get(r.id);
      if (!da) {
        const kopie = { ...r };
        byId.set(r.id, kopie);
        out.push(kopie);
      } else if (r.reason && !String(da.reason).includes(r.reason)) da.reason = da.reason ? `${da.reason} · ${r.reason}` : r.reason;
    }
    return out;
  };
  const alle = [...buendeln(v.ausgehend).map((r) => zeile(r, 'out')), ...buendeln(v.eingehend).map((r) => zeile(r, 'in'))];
  teile.verknuepft.append(
    h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text('Verknüpft mit')), h('span.gh__link-art', null, text(alle.length ? formatNumber(alle.length) : ''))),
    alle.length ? h('ul.gh__links', null, ...alle) : h('p.gh__sec-hint', null, text('Noch mit nichts verknüpft. Ein [[Link]] im Text oder ein gemeinsames #Schlagwort verbindet.')));

  const files = [...v.ausgehend, ...v.eingehend].filter((r) => r.type === 'file');
  clear(teile.dateien);
  teile.dateien.hidden = !files.length;
  if (files.length) {
    teile.dateien.append(
      h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text('Dateien'))),
      h('ul.gh__links', null, ...files.map((f) => h('li', null, h('button.gh__link', { type: 'button', onClick: () => springeZu(self, f.id) },
        h('span.gh__link-dir', null, icon(ICON.file)), h('span.gh__link-main', null, h('span.gh__link-title', null, text(f.title))))))));
  }

  clear(teile.themen);
  teile.themen.hidden = !v.themen.length;
  if (v.themen.length) {
    teile.themen.append(
      h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text('Themen'))),
      h('div.gh__themen', null, ...v.themen.map((t) => h('button.chip', {
        type: 'button', title: `Thema ${t.name} öffnen`, onClick: () => tauchen(self, t.id, { woher: 'karte' }),
      }, h('span.gh__dot', { style: { background: `color-mix(in srgb, ${THEME_HUES[t.farbe] || THEME_HUES[0]} 55%, var(--fg-muted))` } }), h('span.chip__label', null, text(t.name))))));
  }

  renderVorschlaege(self, node, v.vorschlaege, teile.vorschlaege);
}

function renderVorschlaege(self, node, liste, sec) {
  clear(sec);
  sec.hidden = !liste.length;
  if (!liste.length) return;
  const alle = h('button.btn.btn--small', { type: 'button', onClick: () => verbinden(self, node, liste.map((v) => v.id), sec, liste) }, text('Alle verbinden'));
  sec.append(
    h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text(liste.length === 1 ? '1 Vorschlag' : `${liste.length} Vorschläge`)), liste.length > 1 ? alle : null),
    h('ul.gh__links', null, ...liste.map((v) => h('li.gh__vorschlag', null,
      h('span.gh__link-main', { title: v.grund }, h('span.gh__link-title', null, text(v.title)), h('span.gh__link-why', null, text(v.grund || artVon(v)))),
      h('button.btn.btn--small', { type: 'button', 'aria-label': `Mit ${v.title} verbinden`, onClick: () => verbinden(self, node, [v.id], sec, liste) }, icon(ICON.link), text('Verbinden'))))));
}

async function verbinden(self, node, ziele, sec, liste) {
  const { ctx } = self;
  for (const b of sec.querySelectorAll('button')) b.disabled = true;
  let res;
  try {
    res = await ctx.api.post('/graph/verbinden', { from: node.id, to: ziele, kind: 'related', reason: 'Im Gehirn verbunden' }, { timeoutMs: 15000 });
  } catch (err) {
    if (!self.alive) return;
    for (const b of sec.querySelectorAll('button')) b.disabled = false;
    ctx.toast(`Verbinden ist gescheitert: ${err && err.message ? err.message : 'unbekannter Fehler'}`, 'error');
    return;
  }
  if (!self.alive) return;
  const neu = res && Array.isArray(res.neu) ? res.neu : [];
  const rest = liste.filter((v) => !ziele.includes(v.id));
  const rueck = res && res.rueckgaengig && Array.isArray(res.rueckgaengig.edges) && res.rueckgaengig.edges.length ? res.rueckgaengig : null;
  ctx.toast(neu.length === 1 ? 'Verbunden.' : `${formatNumber(ziele.length)} Verbindungen angelegt.`, 'success', rueck ? {
    action: {
      label: 'Rückgängig',
      run: async () => {
        try {
          await ctx.api.post(rueck.pfad || '/graph/rueckgaengig', { edges: rueck.edges }, { timeoutMs: 15000 });
          ctx.toast('Verbindung wieder gelöst.', 'info');
        } catch (err) {
          ctx.toast(`Rückgängig ist gescheitert: ${err && err.message ? err.message : 'unbekannter Fehler'}`, 'error');
        }
      },
    },
    timeout: 8000,
  } : undefined);
  if (self.selectedId === node.id) renderVorschlaege(self, node, rest, sec);
}

async function zusammenfassen(self, node, button, sec) {
  const { ctx } = self;
  button.disabled = true;
  let res;
  try {
    res = await ctx.api.post('/graph/zusammenfassung', { id: node.id }, { timeoutMs: 60000 });
  } catch (err) {
    if (!self.alive) return;
    button.disabled = false;
    if (err && (err.status === 404 || err.status === 501)) res = { verfuegbar: false, grund: 'Kommt, sobald eine KI verbunden ist.' };
    else {
      ctx.toast(`Die Zusammenfassung ist gescheitert: ${err && err.message ? err.message : 'unbekannter Fehler'}`, 'error');
      return;
    }
  }
  if (!self.alive || self.selectedId !== node.id) return;
  clear(sec);
  sec.append(h('div.gh__sec-head', null, h('h4.gh__sec-title', null, text('KI-Zusammenfassung'))));
  if (res && res.verfuegbar && typeof res.text === 'string' && res.text.trim()) {
    sec.append(h('p.gh__ki', null, text(res.text.trim())), res.modell ? h('p.gh__sec-hint', null, text(`Von ${res.modell}.`)) : null);
  } else {
    sec.append(h('p.gh__ki.gh__ki--fehlt', null, text((res && res.grund) || 'Kommt, sobald eine KI verbunden ist.')));
  }
}

/* ---------------------------- Brotkrumen, Werkzeuge ----------------- */

function renderCrumbs(self) {
  const { dom } = self;
  clear(dom.crumbs);
  if (self.leer) { dom.crumbs.hidden = true; return; }
  dom.crumbs.hidden = false;
  const krumen = self.ebene === 1 && self.fokusId
    ? [{ id: null, name: WURZEL_NAME }, { id: '__fokus', name: (self.byId.get(self.fokusId) || {}).label || 'Umfeld' }]
    : brotkrumen(self.pfad, self.ebene === 1 ? self.thema : null);
  krumen.forEach((k, i) => {
    const letzte = i === krumen.length - 1;
    if (i > 0) dom.crumbs.appendChild(h('span.gh__crumb-sep', { 'aria-hidden': 'true' }, text('›')));
    const b = h('button.gh__crumb', {
      type: 'button',
      'aria-current': letzte ? 'page' : null,
      title: letzte ? null : (k.id ? `Zurück zu ${k.name}` : 'Zurück zur Übersicht'),
      onClick: () => {
        if (letzte) return;
        if (!k.id) auftauchen(self, { woher: 'wurzel' });
        else tauchen(self, k.id, { woher: 'krume' });
      },
    }, text(k.name));
    if (letzte && self.ebene === 1 && self.thema) b.appendChild(h('span.gh__crumb-n', null, text(formatNumber(self.thema.anzahl))));
    if (letzte && self.ebene === 0 && self.universum) b.appendChild(h('span.gh__crumb-n', null, text(`${formatNumber(self.universum.gesamt.themen)} Themen`)));
    dom.crumbs.appendChild(b);
  });
  if (self.klein && self.ebene === 1) {
    // Unter acht Eintraegen: keine Themen -- die Wurzel ist alles.
    clear(dom.crumbs);
    dom.crumbs.appendChild(h('button.gh__crumb', { type: 'button', 'aria-current': 'page' }, text(WURZEL_NAME), h('span.gh__crumb-n', null, text(formatNumber(self.nodes.length)))));
  }
}

function renderTools(self) {
  const { dom } = self;
  const hatte = dom.search && document.activeElement === dom.search;
  const cursor = hatte ? dom.search.selectionStart : null;
  clear(dom.tools);
  if (self.leer) { dom.tools.hidden = true; return; }
  dom.tools.hidden = false;

  dom.search = h('input.input', {
    type: 'search',
    placeholder: self.ebene === 0 ? 'Thema oder Eintrag …' : 'Suchen …',
    value: self.query,
    'aria-label': 'Im Gehirn suchen',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  dom.results = h('ul.gh__results', { hidden: true, role: 'listbox', 'aria-label': 'Treffer' });
  const searchSoon = debounce((v) => { if (self.alive) suchen(self, v); }, 120);
  dom.search.addEventListener('input', () => { dom.searchOffen = true; searchSoon(dom.search.value); });
  dom.search.addEventListener('focus', () => { dom.searchOffen = true; renderResults(self); });
  dom.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (searchSoon.cancel) searchSoon.cancel();
      suchen(self, dom.search.value, { jump: true });
      schliesseSuche(self);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (dom.search.value) {
        dom.search.value = '';
        suchen(self, '');
      } else dom.search.blur();
    }
  });
  dom.searchWrap = h('div.gh__search', null, h('span.gh__search-icon', null, icon(ICON.search)), dom.search, dom.results);
  dom.tools.appendChild(dom.searchWrap);

  if (self.ebene === 1) {
    const counts = new Map();
    for (const node of self.nodes) counts.set(node.type, (counts.get(node.type) || 0) + 1);
    const arten = [...counts.keys()].filter((t) => counts.get(t) > 0).sort((a, b) => counts.get(b) - counts.get(a));
    const chips = arten.length > 1 ? arten.map((type) => h('button.chip', {
      type: 'button',
      class: self.hiddenTypes.has(type) ? '' : 'is-active',
      'aria-pressed': self.hiddenTypes.has(type) ? 'false' : 'true',
      title: `${TYPE_PLURALS[type] || type} ein- oder ausblenden`,
      onClick: () => {
        if (self.hiddenTypes.has(type)) self.hiddenTypes.delete(type);
        else self.hiddenTypes.add(type);
        applyFilter(self);
        renderTools(self);
      },
    }, h('span.chip__label', null, text(TYPE_PLURALS[type] || type)), h('span.gh__chip-n', null, text(formatNumber(counts.get(type)))))) : [];
    if (self.selectedId) {
      chips.push(h('button.chip', {
        type: 'button',
        dataset: { fokus: 'ja' },
        class: self.fokusModus ? 'is-active' : '',
        'aria-pressed': self.fokusModus ? 'true' : 'false',
        title: 'Nur der gewählte Eintrag und seine Nachbarn bis Tiefe 2',
        onClick: () => setFokusModus(self, !self.fokusModus),
      }, icon(ICON.focus), h('span.chip__label', null, text('Fokus'))));
    }
    if (chips.length) dom.tools.appendChild(h('div.gh__chips', { role: 'group', 'aria-label': 'Arten' }, ...chips));
  }
  if (hatte) {
    dom.search.focus({ preventScroll: true });
    try { dom.search.setSelectionRange(cursor, cursor); } catch { /* egal */ }
  }
}

function renderHint(self) {
  const { dom } = self;
  if (self.leer || self.loading) { dom.hint.hidden = true; return; }
  clear(dom.hint);
  dom.hint.hidden = false;
  let fein = false;
  try { fein = window.matchMedia('(pointer: fine)').matches; } catch { /* Finger */ }
  if (self.ebene === 0) dom.hint.appendChild(text(fein ? 'Klick oder Rad öffnet ein Thema · Ziehen verschiebt' : 'Antippen oder Aufziehen öffnet ein Thema'));
  else dom.hint.appendChild(text(fein ? `Klick wählt · Doppelklick öffnet · Rad zoomt${self.klein ? '' : ' · Esc oder Herauszoomen zurück'}` : `Antippen wählt · Zweimal tippen öffnet · Zwei Finger zoomen${self.klein ? '' : ' · Zusammenziehen zurück'}`));
}

/* ---------------------------- Zustand ------------------------------- */

function renderState(self) {
  const { dom } = self;
  clear(dom.state);
  let box = null;
  if (self.loading && !self.universum) {
    box = h('div.gh__state-box', null, h('span.spinner', { 'aria-hidden': 'true' }), h('p.gh__state-text', null, text('Das Gehirn wird geladen …')));
  } else if (self.error && !self.universum) {
    const msg = self.error && self.error.message ? self.error.message : 'Unbekannter Fehler.';
    box = h('div.gh__state-box', { role: 'alert' },
      h('p.gh__state-title', null, text('Das Gehirn konnte nicht geladen werden.')),
      h('p.gh__state-text', null, text(msg)),
      h('div.gh__state-actions', null, h('button.btn', { type: 'button', onClick: () => start(self) }, text('Nochmal versuchen'))));
  } else if (self.leer) {
    box = h('div.gh__state-box', null,
      h('p.gh__state-title', null, text('Dein Wissensuniversum wartet.')),
      h('p.gh__state-text', null, text('Erstelle deine erste Notiz oder importiere vorhandenes Wissen.')),
      h('div.gh__state-actions', null,
        h('button.btn.btn--primary', { type: 'button', onClick: () => self.ctx.navigate('#/notes?neu') }, text('Erste Notiz')),
        h('button.btn', { type: 'button', onClick: () => self.ctx.navigate('#/stick') }, text('Importieren')),
        h('button.btn', { type: 'button', onClick: () => self.ctx.navigate('#/chat') }, text('KI kennenlernen'))));
  }
  dom.state.hidden = !box;
  if (box) dom.state.appendChild(box);
  renderHint(self);
}

function renderCount(self) {
  const { dom } = self;
  if (!dom.count) return;
  clear(dom.count);
  if (!self.universum || self.leer) return;
  if (self.ebene === 0) {
    const g = self.universum.gesamt;
    dom.count.appendChild(text(`${formatNumber(g.themen)} Themen · ${formatNumber(g.knoten)} Einträge`));
    return;
  }
  const s = self.netz.stats();
  dom.count.appendChild(text(`${formatNumber(s.visibleNodes)} Einträge · ${formatNumber(s.visibleEdges)} Verbindungen`));
}

function describe(self) {
  const { dom } = self;
  if (!dom.canvasNetz || !self.netz) return;
  const s = self.netz.stats();
  const parts = [];
  if (self.ebene === 1) {
    parts.push(`${self.thema ? `Thema ${self.thema.name}` : 'Netz'} mit ${formatNumber(s.visibleNodes)} Einträgen und ${formatNumber(s.visibleEdges)} Verbindungen`);
    const node = self.selectedId ? self.byId.get(self.selectedId) : null;
    if (node) parts.push(`gewählt: ${node.label}`);
    parts.push('Ziehen verschiebt, Mausrad oder zwei Finger zoomen, Antippen wählt, zweimal Antippen öffnet, Pfeiltasten verschieben, 0 passt ein, Escape geht eine Ebene hoch');
    dom.canvasNetz.setAttribute('aria-label', `${parts.join('. ')}.`);
  } else if (self.universum) {
    dom.canvasUni.setAttribute('aria-label', `Wissensuniversum mit ${formatNumber(self.universum.gesamt.themen)} Themen und ${formatNumber(self.universum.gesamt.knoten)} Einträgen. Antippen oder Hineinzoomen öffnet ein Thema.`);
  }
}

function announce(self, message) {
  const { dom } = self;
  if (!dom.live) return;
  clear(dom.live);
  if (message) dom.live.appendChild(text(message));
}

/* ---------------------------- Live ---------------------------------- */

/**
 * 'graph.kante' vom Bus: {edge, neu|entfernt, von:{id,type,label}, zu:{...}}.
 * Auf Ebene 1 erscheint die Linie sofort und zieht sich; ein Ende, das noch
 * nicht geladen ist, kommt als Nachbar dazu. Ebene 0 laedt gebuendelt nach,
 * weil sich dort nur Zahlen aendern.
 */
function neueKante(self, payload, bald) {
  if (!self.alive) return;
  const edge = payload && payload.edge;
  const d = edge && edge.data ? edge.data : edge;
  if (!d || typeof d.from !== 'string' || typeof d.to !== 'string') { bald(); return; }
  if (self.ebene !== 1) { bald(); return; }
  if (payload.entfernt) {
    const vorher = self.edges.length;
    self.edges = self.edges.filter((e) => e.id !== edge.id && !(e.from === d.from && e.to === d.to && e.kind === (d.kind || 'related')));
    if (self.edges.length !== vorher) self.netz.setData({ nodes: self.nodes, edges: self.edges }, { beweglich: [d.from, d.to] });
    bald();
    return;
  }
  const hatFrom = self.byId.has(d.from);
  const hatTo = self.byId.has(d.to);
  if (!hatFrom && !hatTo) { bald(); return; }
  const neuer = !hatFrom ? payload.von : !hatTo ? payload.zu : null;
  if ((!hatFrom || !hatTo) && !(neuer && typeof neuer.id === 'string')) { bald(); return; }
  if (neuer) {
    const node = { id: neuer.id, type: neuer.type || 'note', label: String(neuer.label || 'Ohne Titel'), tags: [], grad: 1, ausserhalb: !!self.thema, snippet: '' };
    self.nodes = [...self.nodes, node];
    self.byId.set(node.id, node);
  }
  const kante = { id: edge.id || `${d.from}>${d.to}`, from: d.from, to: d.to, kind: d.kind || 'related', source: d.source || 'manual', reason: d.reason || '' };
  if (self.edges.some((e) => e.id === kante.id)) return;
  self.edges = [...self.edges, kante];
  self.netz.setData({ nodes: self.nodes, edges: self.edges }, { beweglich: [d.from, d.to] });
  self.netz.nudge([d.from, d.to]);
  applyFilter(self, { quiet: true });
  faerben(self);
  renderCount(self);
  if (self.selectedId === d.from || self.selectedId === d.to) renderCard(self);
  announce(self, `Neue Verbindung: ${(payload.von && payload.von.label) || d.from} und ${(payload.zu && payload.zu.label) || d.to}`);
}

export { fold };
