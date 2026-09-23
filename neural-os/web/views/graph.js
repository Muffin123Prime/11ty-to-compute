/**
 * views/graph.js -- "Gehirn": alles, was die KI ueber dich weiss, als Netz.
 *
 * Vorlage des Nutzers: docs/vorlage/gehirn-obsidian.png ("so soll das Gehirn
 * aussehen"). Die fruehere Fassung mit Werkzeugleiste, Formen-Legende und
 * Inspektor-Spalte fand er "ganz, ganz schlimm". Deshalb:
 *
 * 1. **Die Flaeche gehoert dem Netz.** Kein Kopf ueber der Leinwand, keine
 *    Legende, keine Seitenspalte. Alles Verstellbare liegt in EINEM Panel
 *    oben rechts, wie in Obsidian: Filter, Gruppen, Anzeige, Kraefte --
 *    einklappbar, und es merkt sich, wie man es verlassen hat.
 * 2. **Antippen zeigt, was es ist -- klein.** Ein schmales Kaertchen unten
 *    links mit Art, Titel, zwei Zeilen Auszug und "Oeffnen". Zweimal
 *    Antippen oeffnet sofort. Mehr braucht es nicht, um vom Netz in den
 *    Eintrag zu springen.
 * 3. **Themenfarben sind eine Gruppe, keine Grundeinstellung.** Der Nutzer
 *    wollte frueher "je nach Thema eine andere Farbe"; die Vorlage ist grau.
 *    Beides geht: die Themen werden hier erkannt (Label Propagation ueber
 *    die geladenen Verbindungen, benannt nach dem haeufigsten Schlagwort
 *    oder Wort), im Panel unter "Gruppen" gezeigt und auf Wunsch gedaempft
 *    eingefaerbt -- ab Werk aus.
 * 4. **Laden auf dem Server, Filtern im Browser.** `/api/graph` wird einmal
 *    gefragt; Arten, Waisen und Suche laufen ueber die geladene Menge. Ein
 *    Schalter wirkt sofort und veraendert nicht, welche Knoten der Server
 *    ausgewaehlt hat -- das Bild bleibt ruhig.
 * 5. **Live, ohne Umwerfen.** Neue Notizen, Termine und Verbindungen kommen
 *    ueber den Bus; nachgeladen wird gebuendelt, und der Zeichner behaelt jede
 *    Position nach id. Was schon da war, bleibt, wo es ist.
 */

import { h, text, clear, on, icon, formatNumber, debounce } from '../lib/dom.js';
import { createGraphCanvas, GRAPH_DEFAULTS, GRAPH_TYPES } from '../lib/graph-canvas.js';

/* ------------------------------------------------------------------ */
/* Wortschatz                                                          */
/* ------------------------------------------------------------------ */

const TYPE_LABELS = {
  note: 'Notiz',
  chat: 'Chat',
  project: 'Projekt',
  task: 'Aufgabe',
  event: 'Termin',
  agent: 'Agent',
  file: 'Datei',
  entity: 'Begriff',
  run: 'Lauf',
};

const TYPE_PLURALS = {
  note: 'Notizen',
  chat: 'Chats',
  project: 'Projekte',
  task: 'Aufgaben',
  event: 'Termine',
  agent: 'Agenten',
  file: 'Dateien',
  entity: 'Begriffe',
  run: 'Läufe',
};

/** Wo ein Eintrag sich oeffnen laesst. */
const OPEN_ROUTES = {
  note: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  file: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  entity: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  chat: (id) => `#/chat?id=${encodeURIComponent(id)}`,
  project: (id) => `#/projects?id=${encodeURIComponent(id)}`,
  task: (id) => `#/projects?id=${encodeURIComponent(id)}`,
  event: (id) => `#/kalender?id=${encodeURIComponent(id)}`,
  agent: (id) => `#/agents?id=${encodeURIComponent(id)}`,
  run: (id) => `#/agents?id=${encodeURIComponent(id)}`,
};

/**
 * Themenfarben. Acht Toene mit gleicher Helligkeit, keiner davon blau: Blau
 * ist der Akzent und heisst "gewaehlt". Der Zeichner mischt sie ohnehin
 * zu gut einem Drittel ins Grau -- gedaempft, wie in Obsidian.
 */
const GROUP_COLORS = ['#5fb8a5', '#d4a857', '#a98bd6', '#8cbc6a', '#d9828f', '#b9b56a', '#cc86c0', '#d98f5c'];
const MAX_GROUPS = GROUP_COLORS.length;

const ICON = {
  chevron: '<path d="m7.5 5 5 5-5 5"/>',
  sliders: '<path d="M4 6h7M15 6h1M4 14h1M9 14h7"/><circle cx="13" cy="6" r="1.8"/><circle cx="7" cy="14" r="1.8"/>',
  reset: '<path d="M4.6 10a5.4 5.4 0 1 0 1.7-3.9"/><path d="M4.2 3.6v3.2h3.2"/>',
  close: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  open: '<path d="M4 10h11M11 6l4 4-4 4"/>',
  search: '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 4 4"/>',
};

const STORE_KEY = 'neural-os:gehirn';
const LOAD_LIMIT = 2500;

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

/* Das Panel oben rechts, wie in Obsidian. */
.gh__panel {
  position: absolute; top: 14px; right: 14px; z-index: 3;
  width: min(292px, calc(100% - 28px)); max-height: calc(100% - 28px); overflow: auto;
  overscroll-behavior: contain;
  background: var(--surface-2); border: 1px solid var(--border-strong);
  border-radius: var(--r-3); box-shadow: var(--shadow-2);
  font-size: var(--fs-base); color: var(--fg);
}
.gh__sec + .gh__sec { border-top: 1px solid var(--border); }
.gh__sum {
  display: flex; align-items: center; gap: var(--sp-1);
  min-height: 44px; padding: 0 var(--sp-1) 0 12px;
  list-style: none; cursor: pointer; user-select: none; -webkit-user-select: none;
  color: var(--fg); font-size: var(--fs-md);
}
.gh__sum::-webkit-details-marker { display: none; }
.gh__sum::marker { content: ''; }
.gh__sum:hover { background: var(--surface-3); }
.gh__sec:first-child .gh__sum { border-radius: var(--r-3) var(--r-3) 0 0; }
.gh__chev { display: grid; place-items: center; color: var(--fg-subtle); transition: transform var(--dur-2) var(--ease); }
.gh__chev svg { width: 15px; height: 15px; }
.gh__sec[open] > .gh__sum .gh__chev { transform: rotate(90deg); }
.gh__sum-title { flex: 1 1 auto; min-width: 0; }
.gh__sum .icon-button { width: 32px; height: 32px; }
.gh__sum .icon-button svg { width: 17px; height: 17px; }
.gh__body { display: flex; flex-direction: column; gap: 12px; padding: 4px 14px 16px; }
.gh__search { position: relative; }
.gh__search .input { width: 100%; padding-left: 32px; }
.gh__search-icon {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  display: grid; color: var(--fg-subtle); pointer-events: none;
}
.gh__search-icon svg { width: 15px; height: 15px; }
.gh__hint { margin: 0; color: var(--fg-subtle); font-size: var(--fs-sm); line-height: 1.45; }
.gh__label { margin: 0; color: var(--fg-muted); font-size: var(--fs-sm); }
.gh__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.gh__chips .chip { min-height: 28px; padding: 0 10px; }
.gh__chip-n { color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.chip.is-active .gh__chip-n { color: inherit; opacity: 0.75; }

.gh__toggle {
  display: flex; align-items: center; gap: var(--sp-1); width: 100%;
  min-height: 34px; padding: 0; background: none; border: 0; cursor: pointer;
  color: var(--fg); font: inherit; font-size: var(--fs-base); text-align: left;
}
.gh__toggle-text { flex: 1 1 auto; min-width: 0; }
.gh__switch {
  position: relative; flex: none; width: 34px; height: 20px;
  background: var(--surface-4); border: 1px solid var(--border-strong); border-radius: var(--r-full);
  transition: background var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease);
}
.gh__switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  background: var(--fg-muted); border-radius: 50%;
  transition: transform var(--dur-2) var(--ease), background var(--dur-2) var(--ease);
}
.gh__toggle[aria-checked="true"] .gh__switch { background: var(--accent); border-color: var(--accent); }
.gh__toggle[aria-checked="true"] .gh__switch::after { transform: translateX(14px); background: var(--accent-fg); }
.gh__toggle:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: 2px; border-radius: var(--r-1); }

.gh__groups { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.gh__group {
  display: flex; align-items: center; gap: 10px; width: 100%;
  min-height: 32px; padding: 0 8px; margin: 0 -8px; width: calc(100% + 16px);
  background: none; border: 0; border-radius: var(--r-1); cursor: pointer;
  color: var(--fg); font: inherit; font-size: var(--fs-base); text-align: left;
}
.gh__group:hover { background: var(--surface-3); }
.gh__group[aria-pressed="false"] { color: var(--fg-subtle); }
.gh__group-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; }
.gh__group[aria-pressed="false"] .gh__group-dot { background: var(--surface-4) !important; }
.gh__group-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh__group-n { flex: none; color: var(--fg-subtle); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }

.gh__range { display: flex; flex-direction: column; gap: 2px; }
.gh__range-head { display: flex; justify-content: space-between; color: var(--fg-muted); font-size: var(--fs-sm); }
.gh__range-val { color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.gh__range input[type="range"] { width: 100%; margin: 0; height: 22px; accent-color: var(--accent); cursor: pointer; }
.gh__row { display: flex; flex-wrap: wrap; gap: var(--sp-1); }

.gh__opener {
  position: absolute; top: 14px; right: 14px; z-index: 3;
  background: var(--surface-2); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2);
}

/* Das schmale Kaertchen beim Antippen. */
.gh__card {
  position: absolute; left: 14px; bottom: 14px; z-index: 3;
  width: min(330px, calc(100% - 28px));
  padding: 12px 12px 14px 16px;
  background: var(--surface-2); border: 1px solid var(--border-strong);
  border-radius: var(--r-3); box-shadow: var(--shadow-2);
}
.gh__card-head { display: flex; align-items: center; gap: var(--sp-1); min-height: 32px; }
.gh__card-kind { flex: 1 1 auto; min-width: 0; color: var(--fg-subtle); font-size: var(--fs-sm); }
.gh__card-head .icon-button { width: 32px; height: 32px; margin: -4px -2px -4px 0; }
.gh__card-title {
  margin: 2px 0 0; font-size: var(--fs-md); font-weight: 500; line-height: var(--lh-tight);
  overflow-wrap: anywhere;
}
.gh__card-snip {
  margin: 6px 0 0; color: var(--fg-muted); font-size: var(--fs-sm); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.gh__card-actions { display: flex; align-items: center; gap: var(--sp-1); margin-top: 12px; }
.gh__card-actions .btn svg { width: 16px; height: 16px; }

.gh__state {
  position: absolute; inset: 0; z-index: 2; display: grid; place-items: center;
  padding: var(--sp-4); text-align: center; pointer-events: none;
}
.gh__state-box { max-width: 420px; pointer-events: auto; }
.gh__state-title { margin: 0 0 6px; font-size: var(--fs-lg); font-weight: 500; color: var(--fg); }
.gh__state-text { margin: 0; color: var(--fg-muted); line-height: var(--lh); }
.gh__state .btn { margin-top: var(--sp-2); }
.gh__count { color: var(--fg-subtle); font-size: var(--fs-sm); white-space: nowrap; font-variant-numeric: tabular-nums; }

@media (pointer: coarse) {
  .gh__sum .icon-button, .gh__card-head .icon-button { width: 40px; height: 40px; }
  .gh__toggle, .gh__group { min-height: 44px; }
  .gh__chips .chip { min-height: 44px; }
  .gh__range input[type="range"] { height: 44px; }
}
@media (max-width: 640px) {
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
/* Gemerkte Einstellungen                                              */
/* ------------------------------------------------------------------ */

function readPrefs() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch { /* privates Fenster: dann eben nur fuer diese Sitzung */ }
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/** Fuer die Suche: Umlaute so, wie ein Deutscher sie tippt. */
function fold(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'oder',
  'aber', 'nicht', 'auch', 'noch', 'schon', 'nur', 'wie', 'wenn', 'dann', 'ist', 'sind', 'war', 'hat',
  'haben', 'wird', 'fuer', 'mit', 'von', 'zum', 'zur', 'auf', 'aus', 'bei', 'nach', 'ueber', 'unter',
  'vor', 'durch', 'ohne', 'neue', 'neuer', 'neues', 'gespraech', 'gedanke', 'termin', 'notiz', 'chat',
  'lauf', 'erledigen', 'the', 'and', 'for', 'with',
]);

/* ------------------------------------------------------------------ */
/* Themen: Label Propagation                                           */
/* ------------------------------------------------------------------ */

/**
 * Themen aus der Struktur, nicht geraten: jeder Knoten uebernimmt reihum
 * die Gruppe, die unter seinen Nachbarn am haeufigsten ist, bis sich nichts
 * mehr aendert. Deterministisch (feste Reihenfolge, feste Gleichstandsregel),
 * damit dieselbe Karte dieselben Farben behaelt. Benannt wird eine Gruppe
 * nach dem, was ihre Knoten wirklich teilen: erst ein Schlagwort, dann ein
 * Wort aus den Titeln, zuletzt der Titel des groessten Knotens.
 */
function detectTopics(nodes, edges) {
  const idx = new Map(nodes.map((node, i) => [node.id, i]));
  const adj = nodes.map(() => []);
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    adj[a].push(b);
    adj[b].push(a);
  }
  const label = nodes.map((_, i) => i);
  const order = nodes.map((_, i) => i).sort((p, q) => (adj[q].length - adj[p].length) || (nodes[p].id < nodes[q].id ? -1 : 1));
  for (let round = 0; round < 24; round++) {
    let changed = 0;
    for (const i of order) {
      if (!adj[i].length) continue;
      const count = new Map();
      for (const j of adj[i]) count.set(label[j], (count.get(label[j]) || 0) + 1 + adj[j].length * 0.002);
      let best = label[i];
      let bestN = count.get(best) || 0;
      for (const [l, c] of count) {
        if (c > bestN + 1e-9 || (Math.abs(c - bestN) < 1e-9 && l < best)) {
          best = l;
          bestN = c;
        }
      }
      if (best !== label[i]) {
        label[i] = best;
        changed++;
      }
    }
    if (!changed) break;
  }
  const groups = new Map();
  nodes.forEach((node, i) => {
    if (!adj[i].length) return;
    let g = groups.get(label[i]);
    if (!g) groups.set(label[i], (g = []));
    g.push(i);
  });
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 4) continue;
    const tags = new Map();
    const words = new Map();
    let top = members[0];
    for (const i of members) {
      const node = nodes[i];
      if (adj[i].length > adj[top].length) top = i;
      for (const t of new Set((node.tags || []).map((x) => String(x).trim()).filter(Boolean))) tags.set(t, (tags.get(t) || 0) + 1);
      for (const w of new Set(fold(node.label).split(/[^a-z0-9]+/).filter((x) => x.length > 3 && !STOPWORDS.has(x) && !/^\d+$/.test(x)))) {
        words.set(w, (words.get(w) || 0) + 1);
      }
    }
    const best = (map) => [...map.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0];
    const tag = best(tags);
    const word = best(words);
    let name;
    if (tag && tag[1] >= Math.max(2, members.length * 0.25)) name = `#${tag[0]}`;
    else if (adj[top].length >= 3) name = nodes[top].label;
    else if (word && word[1] >= 2) name = word[0].charAt(0).toUpperCase() + word[0].slice(1);
    else name = nodes[top].label;
    out.push({ key: nodes[top].id, name: String(name || 'Gruppe'), ids: members.map((i) => nodes[i].id) });
  }
  out.sort((a, b) => (b.ids.length - a.ids.length) || (a.key < b.key ? -1 : 1));
  return out.slice(0, MAX_GROUPS);
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
  if (dying.graph) dying.graph.destroy();
}

export default {
  id: 'graph',
  title: 'Gehirn',

  async mount(container, ctx) {
    ensureStyle();
    teardown();
    const params = (ctx.route && ctx.route.params) || {};
    const prefs = readPrefs();
    const self = {
      alive: true,
      ctx,
      container,
      cleanups: [],
      abort: null,
      graph: null,
      dom: {},
      nodes: [],
      edges: [],
      byId: new Map(),
      truncated: false,
      total: 0,
      loading: true,
      error: null,
      focusId: typeof params.focus === 'string' && params.focus ? params.focus : null,
      selectedId: null,
      query: '',
      matches: [],
      matchAt: -1,
      topics: [],
      prefs: {
        panel: typeof prefs.panel === 'boolean' ? prefs.panel : null,
        open: prefs.open && typeof prefs.open === 'object' ? prefs.open : {},
        settings: { ...GRAPH_DEFAULTS, ...(prefs.settings || {}) },
        hiddenTypes: Array.isArray(prefs.hiddenTypes) ? prefs.hiddenTypes.filter((t) => GRAPH_TYPES.includes(t)) : [],
        orphans: prefs.orphans !== false,
        colors: prefs.colors === true,
        groupsOff: Array.isArray(prefs.groupsOff) ? prefs.groupsOff.map(String) : [],
      },
    };
    view = self;
    build(self);
    await load(self, { first: true });
  },

  async unmount() {
    teardown();
  },
};

function save(self) {
  writePrefs(self.prefs);
}

/* ---------------------------- Aufbau -------------------------------- */

function build(self) {
  const { ctx, container, dom } = self;
  clear(container);

  dom.canvas = h('canvas.gh__canvas', { tabindex: '0', role: 'img', 'aria-label': 'Gehirn wird geladen.' });
  dom.live = h('p.gh__live', { role: 'status', 'aria-live': 'polite' });
  dom.state = h('div.gh__state', { hidden: true });
  dom.card = h('div.gh__card', { hidden: true, role: 'dialog', 'aria-label': 'Ausgewählter Eintrag' });
  dom.panel = h('div.gh__panel', { role: 'region', 'aria-label': 'Filter und Anzeige des Gehirns' });
  dom.opener = h('button.icon-button.gh__opener', {
    type: 'button',
    title: 'Filter und Anzeige',
    'aria-label': 'Filter und Anzeige öffnen',
    onClick: () => setPanel(self, true),
  }, icon(ICON.sliders));
  dom.root = h('div.gh', null, dom.canvas, dom.state, dom.panel, dom.opener, dom.card, dom.live);
  container.appendChild(dom.root);

  dom.count = h('span.gh__count');
  ctx.setHeadActions(dom.count);

  self.graph = createGraphCanvas(dom.canvas, {
    onSelect: (node) => select(self, node ? node.id : null, { fromCanvas: true }),
    onOpen: (node) => openNode(self, node),
    onHover: (node) => announce(self, node ? `${TYPE_LABELS[node.type] || 'Eintrag'}: ${node.label}` : ''),
    // Fuer Pruefwerkzeuge und Bildschirmfotos: die Wolke ruht.
    onSettle: () => { if (self.alive) dom.root.dataset.ruhe = 'ja'; },
    onUserMove: () => {},
  });
  self.graph.setSettings(self.prefs.settings);

  // Die Leinwand folgt der Darstellung (hell/dunkel), auch mitten im Blick.
  const retheme = () => {
    if (!self.alive) return;
    requestAnimationFrame(() => {
      if (!self.alive) return;
      self.graph.refreshTheme();
      applyColors(self);
    });
  };
  if (ctx.state && typeof ctx.state.on === 'function') self.cleanups.push(ctx.state.on('theme', retheme));
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', retheme);
    self.cleanups.push(() => media.removeEventListener('change', retheme));
  } catch { /* ohne matchMedia bleibt die erste Palette */ }

  // Live: gebuendelt nachladen, Positionen bleiben.
  const soon = debounce(() => {
    if (self.alive && !self.loading) load(self, { first: false });
  }, 1200);
  self.cleanups.push(() => soon.cancel && soon.cancel());
  if (ctx.bus && typeof ctx.bus.on === 'function') {
    for (const name of ['record.created', 'record.updated', 'record.deleted', 'edge.created', 'edge.deleted', 'graph.rescanned']) {
      self.cleanups.push(ctx.bus.on(name, () => soon()));
    }
  }

  // Tasten, die nur hier gelten: f passt ein, Escape schliesst das Kaertchen.
  self.cleanups.push(on(document, 'keydown', (event) => {
    if (!self.alive || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const t = event.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (event.key === 'f') {
      event.preventDefault();
      self.graph.fitToView();
    } else if (event.key === 'Escape' && self.selectedId) {
      event.preventDefault();
      select(self, null);
    }
  }));

  renderPanel(self);
}

/* ---------------------------- Laden --------------------------------- */

async function load(self, { first }) {
  const { ctx } = self;
  self.loading = true;
  if (first) renderState(self);
  if (self.abort) self.abort.abort();
  const controller = new AbortController();
  self.abort = controller;

  let data;
  try {
    data = await ctx.api.get('/graph', {
      query: { limit: LOAD_LIMIT, includeOrphans: true },
      signal: controller.signal,
      timeoutMs: 20000,
    });
    // Ein Sprung von "Im Gehirn zeigen" auf einen Eintrag, der nicht unter
    // den geladenen ist: seine Nachbarschaft dazuholen, statt still das
    // Falsche zu zeigen.
    if (self.focusId && !(data.nodes || []).some((node) => node.id === self.focusId)) {
      try {
        const extra = await ctx.api.get('/graph', {
          query: { focus: self.focusId, depth: 1, limit: 200 },
          signal: controller.signal,
          timeoutMs: 20000,
        });
        const have = new Set((data.nodes || []).map((node) => node.id));
        data.nodes = [...(data.nodes || []), ...(extra.nodes || []).filter((node) => !have.has(node.id))];
        const edgeIds = new Set((data.edges || []).map((e) => e.id));
        data.edges = [...(data.edges || []), ...(extra.edges || []).filter((e) => !edgeIds.has(e.id))];
      } catch (err) {
        if (err && err.status === 404) {
          ctx.toast('Diesen Eintrag gibt es nicht mehr. Gezeigt wird das ganze Gehirn.', 'info');
          self.focusId = null;
        }
      }
    }
  } catch (err) {
    if (!self.alive || (err && (err.isAborted || err.name === 'AbortError'))) return;
    self.loading = false;
    self.error = err;
    renderState(self);
    return;
  }
  if (!self.alive || controller.signal.aborted) return;
  self.loading = false;
  self.error = null;
  self.nodes = Array.isArray(data && data.nodes) ? data.nodes : [];
  self.edges = Array.isArray(data && data.edges) ? data.edges : [];
  self.byId = new Map(self.nodes.map((node) => [node.id, node]));
  self.truncated = !!(data && data.truncated);
  self.total = data && data.stats && Number.isFinite(data.stats.candidates) ? data.stats.candidates : self.nodes.length;

  const graph = self.graph;
  graph.setData({ nodes: self.nodes, edges: self.edges });
  applyFilter(self, { quiet: true });
  self.topics = detectTopics(self.nodes, self.edges);
  applyColors(self);
  if (self.query) runSearch(self, self.query, { jump: false });
  if (self.selectedId && !self.byId.has(self.selectedId)) select(self, null);

  if (first) {
    // Die ersten, wildesten Schritte rechnet der Zeichner vorab; danach
    // folgt die Kamera der Wolke weich, bis sie ruht oder jemand eingreift.
    graph.prewarm(self.nodes.length > 1200 ? 90 : 140, 260);
    if (self.focusId && self.byId.has(self.focusId)) {
      select(self, self.focusId);
      graph.focus(self.focusId, { animate: false, zoom: 1.5 });
    } else {
      graph.fitToView({ animate: false, follow: true });
    }
  }
  renderState(self);
  renderPanel(self);
  describe(self);
}

/* ---------------------------- Filter -------------------------------- */

function applyFilter(self, { quiet = false } = {}) {
  const hidden = new Set(self.prefs.hiddenTypes);
  const keep = self.selectedId;
  self.graph.setFilter((node) => !hidden.has(node.type) || node.id === keep, { orphans: self.prefs.orphans });
  self.graph.setOrphans(self.prefs.orphans);
  if (!quiet) {
    if (self.query) runSearch(self, self.query, { jump: false });
    describe(self);
    renderCount(self);
  }
}

function applyColors(self) {
  if (!self.prefs.colors || !self.topics.length) {
    self.graph.setColors(null);
    return;
  }
  const off = new Set(self.prefs.groupsOff);
  const map = new Map();
  self.topics.forEach((topic, i) => {
    if (off.has(topic.name)) return;
    for (const id of topic.ids) map.set(id, i);
  });
  self.graph.setColors(map, GROUP_COLORS);
}

/* ---------------------------- Suche --------------------------------- */

function runSearch(self, value, { jump = false } = {}) {
  const q = fold(String(value || '').trim());
  self.query = String(value || '').trim();
  if (!q) {
    self.matches = [];
    self.matchAt = -1;
    self.graph.setHighlight(null);
  } else {
    const hidden = new Set(self.prefs.hiddenTypes);
    self.matches = self.nodes
      .filter((node) => !hidden.has(node.type))
      .filter((node) => fold(node.label).includes(q) || (node.tags || []).some((t) => fold(t).includes(q)))
      .sort((a, b) => (b.degree || 0) - (a.degree || 0));
    self.graph.setHighlight(self.matches.map((node) => node.id));
    if (jump && self.matches.length) {
      self.matchAt = (self.matchAt + 1) % self.matches.length;
      const hit = self.matches[self.matchAt];
      select(self, hit.id);
      self.graph.focus(hit.id, { zoom: Math.max(1.6, self.graph.transform.k) });
    }
  }
  if (self.dom.searchHint) {
    clear(self.dom.searchHint);
    self.dom.searchHint.hidden = !q;
    if (q) {
      self.dom.searchHint.appendChild(text(self.matches.length
        ? `${formatNumber(self.matches.length)} ${self.matches.length === 1 ? 'Treffer' : 'Treffer'} · Eingabetaste springt hin`
        : 'Nichts gefunden.'));
    }
  }
}

/* ---------------------------- Auswahl ------------------------------- */

function select(self, id, { fromCanvas = false } = {}) {
  self.selectedId = id && self.byId.has(id) ? id : null;
  if (!fromCanvas) self.graph.setSelection(self.selectedId);
  renderCard(self);
  const node = self.selectedId ? self.byId.get(self.selectedId) : null;
  if (node) announce(self, `Gewählt: ${TYPE_LABELS[node.type] || 'Eintrag'} ${node.label}`);
  describe(self);
}

function openNode(self, node) {
  if (!node) return;
  const route = OPEN_ROUTES[node.type];
  if (route) self.ctx.navigate(route(node.id));
}

function renderCard(self) {
  const { dom } = self;
  clear(dom.card);
  const node = self.selectedId ? self.byId.get(self.selectedId) : null;
  dom.card.hidden = !node;
  if (!node) return;
  const links = self.graph.neighbours(node.id).length;
  const kind = `${TYPE_LABELS[node.type] || 'Eintrag'} · ${links === 1 ? '1 Verbindung' : `${formatNumber(links)} Verbindungen`}`;
  const route = OPEN_ROUTES[node.type];
  dom.card.append(
    h('div.gh__card-head', null,
      h('span.gh__card-kind', null, text(kind)),
      h('button.icon-button', {
        type: 'button', title: 'Schließen', 'aria-label': 'Auswahl schließen', onClick: () => select(self, null),
      }, icon(ICON.close))),
    h('h3.gh__card-title', null, text(node.label || 'Ohne Titel')),
    node.snippet && node.snippet !== node.label ? h('p.gh__card-snip', null, text(node.snippet)) : null,
    h('div.gh__card-actions', null,
      route
        ? h('button.btn.btn--accent', { type: 'button', onClick: () => openNode(self, node) }, icon(ICON.open), text('Öffnen'))
        : h('span.gh__hint', null, text('Dieser Eintrag hat keine eigene Seite.')),
      h('button.btn.btn--ghost', {
        type: 'button',
        onClick: () => self.graph.focus(node.id, { zoom: Math.max(1.8, self.graph.transform.k) }),
      }, text('Hinzoomen'))),
  );
}

/* ---------------------------- Panel --------------------------------- */

function setPanel(self, open) {
  self.prefs.panel = open;
  save(self);
  renderPanel(self);
  if (open) {
    const first = self.dom.panel.querySelector('summary');
    if (first) first.focus({ preventScroll: true });
  } else {
    self.dom.opener.focus({ preventScroll: true });
  }
}

function panelOpen(self) {
  if (typeof self.prefs.panel === 'boolean') return self.prefs.panel;
  // Ohne gemerkte Wahl: auf breiter Flaeche offen (wie die Vorlage), auf
  // schmaler zu -- dort braucht das Netz jeden Zentimeter.
  const w = self.dom.root ? self.dom.root.clientWidth : 0;
  return w >= 760;
}

function section(self, key, title, body, extra) {
  const isOpen = !!self.prefs.open[key];
  const details = h('details.gh__sec', { open: isOpen },
    h('summary.gh__sum', null,
      h('span.gh__chev', null, icon(ICON.chevron)),
      h('span.gh__sum-title', null, text(title)),
      extra || null),
    h('div.gh__body', null, ...body));
  details.addEventListener('toggle', () => {
    self.prefs.open = { ...self.prefs.open, [key]: details.open };
    save(self);
  });
  return details;
}

function toggle(label, checked, onChange) {
  return h('button.gh__toggle', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    onClick: (event) => {
      const next = event.currentTarget.getAttribute('aria-checked') !== 'true';
      event.currentTarget.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    },
  }, h('span.gh__toggle-text', null, text(label)), h('span.gh__switch', { 'aria-hidden': 'true' }));
}

function slider(self, key, label, min, max, step) {
  const valueText = () => `${Math.round(self.prefs.settings[key] * 100)} %`;
  const out = h('span.gh__range-val', null, text(valueText()));
  const input = h('input', {
    type: 'range', min: String(min), max: String(max), step: String(step),
    value: String(self.prefs.settings[key]),
    'aria-label': label,
    onInput: (event) => {
      const v = Number(event.target.value);
      if (!Number.isFinite(v)) return;
      self.prefs.settings = { ...self.prefs.settings, [key]: v };
      self.graph.setSettings({ [key]: v });
      clear(out);
      out.appendChild(text(valueText()));
    },
    onChange: () => save(self),
  });
  return h('label.gh__range', null, h('span.gh__range-head', null, h('span', null, text(label)), out), input);
}

function renderPanel(self) {
  const { dom, prefs } = self;
  const open = panelOpen(self);
  dom.panel.hidden = !open;
  dom.opener.hidden = open;
  clear(dom.panel);
  if (!open) return;

  /* Filter */
  dom.search = h('input.input', {
    type: 'search',
    placeholder: 'Suchen …',
    value: self.query,
    'aria-label': 'Im Gehirn suchen',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  dom.searchHint = h('p.gh__hint', { hidden: !self.query });
  const searchSoon = debounce((v) => { if (self.alive) runSearch(self, v); }, 120);
  dom.search.addEventListener('input', () => searchSoon(dom.search.value));
  dom.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (searchSoon.cancel) searchSoon.cancel();
      runSearch(self, dom.search.value, { jump: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dom.search.value = '';
      runSearch(self, '');
    }
  });

  const counts = new Map();
  for (const node of self.nodes) counts.set(node.type, (counts.get(node.type) || 0) + 1);
  const hidden = new Set(prefs.hiddenTypes);
  const chips = GRAPH_TYPES.filter((t) => counts.get(t)).map((type) => h('button.chip', {
    type: 'button',
    class: hidden.has(type) ? '' : 'is-active',
    'aria-pressed': hidden.has(type) ? 'false' : 'true',
    onClick: () => {
      const set = new Set(self.prefs.hiddenTypes);
      if (set.has(type)) set.delete(type);
      else set.add(type);
      self.prefs.hiddenTypes = [...set];
      save(self);
      applyFilter(self);
      renderPanel(self);
    },
  }, h('span.chip__label', null, text(TYPE_PLURALS[type] || type)), h('span.gh__chip-n', null, text(formatNumber(counts.get(type))))));

  const filterBody = [
    h('div.gh__search', null, h('span.gh__search-icon', null, icon(ICON.search)), dom.search),
    dom.searchHint,
    chips.length ? h('p.gh__label', null, text('Arten')) : null,
    chips.length ? h('div.gh__chips', null, ...chips) : null,
    toggle('Unverbundene zeigen', prefs.orphans, (v) => {
      self.prefs.orphans = v;
      save(self);
      applyFilter(self);
    }),
  ];
  runSearchHintOnly(self);

  const headButtons = h('span', { class: 'row', style: { gap: '2px' } },
    h('button.icon-button', {
      type: 'button',
      title: 'Alles zurücksetzen',
      'aria-label': 'Filter, Anzeige und Kräfte zurücksetzen',
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        resetAll(self);
      },
    }, icon(ICON.reset)),
    h('button.icon-button', {
      type: 'button',
      title: 'Schließen',
      'aria-label': 'Panel schließen',
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        setPanel(self, false);
      },
    }, icon(ICON.close)));

  /* Gruppen */
  const off = new Set(prefs.groupsOff);
  const groupRows = self.topics.map((topic, i) => {
    const color = `color-mix(in srgb, ${GROUP_COLORS[i]} 62%, var(--fg-muted))`;
    const active = prefs.colors && !off.has(topic.name);
    const row = h('button.gh__group', {
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      title: active ? 'Farbe dieser Gruppe ausschalten' : 'Diese Gruppe einfärben',
      onClick: () => {
        const set = new Set(self.prefs.groupsOff);
        if (!self.prefs.colors) {
          // Wer eine Gruppe antippt, will Farbe sehen.
          self.prefs.colors = true;
          set.delete(topic.name);
        } else if (set.has(topic.name)) set.delete(topic.name);
        else set.add(topic.name);
        self.prefs.groupsOff = [...set];
        save(self);
        applyColors(self);
        renderPanel(self);
      },
    },
    h('span.gh__group-dot', { style: { background: color } }),
    h('span.gh__group-name', null, text(topic.name)),
    h('span.gh__group-n', null, text(formatNumber(topic.ids.length))));
    // Ueberfahren zeigt, wo die Gruppe liegt -- ohne sie einzufaerben.
    row.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') self.graph.setHighlight(topic.ids);
    });
    row.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse') self.graph.setHighlight(self.query ? self.matches.map((node) => node.id) : null);
    });
    return h('li', null, row);
  });
  const groupsBody = [
    toggle('Nach Thema einfärben', prefs.colors, (v) => {
      self.prefs.colors = v;
      save(self);
      applyColors(self);
      renderPanel(self);
    }),
    groupRows.length
      ? h('ul.gh__groups', null, ...groupRows)
      : h('p.gh__hint', null, text('Noch keine Themen erkennbar. Sie entstehen, sobald mehrere Einträge miteinander verbunden sind.')),
    groupRows.length ? h('p.gh__hint', null, text('Erkannt aus den Verbindungen, benannt nach Schlagwort oder Titel.')) : null,
  ];

  /* Anzeige */
  const displayBody = [
    slider(self, 'nodeScale', 'Knotengröße', 0.4, 2.5, 0.05),
    slider(self, 'linkScale', 'Liniendicke', 0.2, 3, 0.05),
    slider(self, 'labelZoom', 'Beschriftung ab Zoom', 0.2, 3, 0.05),
    h('div.gh__row', null,
      h('button.btn.btn--small', { type: 'button', onClick: () => self.graph.fitToView() }, text('Einpassen'))),
  ];

  /* Kraefte */
  const forcesBody = [
    slider(self, 'repel', 'Abstoßung', 0.2, 3, 0.05),
    slider(self, 'linkDistance', 'Federlänge', 0.3, 3, 0.05),
    slider(self, 'center', 'Zentrierung', 0, 3, 0.05),
    h('div.gh__row', null,
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => {
          self.graph.reheat(1);
          self.graph.fitToView({ follow: true });
        },
      }, text('Neu anordnen'))),
  ];

  dom.panel.append(
    section(self, 'filter', 'Filter', filterBody, headButtons),
    section(self, 'groups', 'Gruppen', groupsBody),
    section(self, 'display', 'Anzeige', displayBody),
    section(self, 'forces', 'Kräfte', forcesBody),
  );
  renderCount(self);
}

/** Nach einem Neuaufbau des Panels den Treffer-Hinweis wieder fuellen. */
function runSearchHintOnly(self) {
  if (!self.query || !self.dom.searchHint) return;
  clear(self.dom.searchHint);
  self.dom.searchHint.hidden = false;
  self.dom.searchHint.appendChild(text(self.matches.length
    ? `${formatNumber(self.matches.length)} Treffer · Eingabetaste springt hin`
    : 'Nichts gefunden.'));
}

function resetAll(self) {
  self.prefs.settings = { ...GRAPH_DEFAULTS };
  self.prefs.hiddenTypes = [];
  self.prefs.orphans = true;
  self.prefs.colors = false;
  self.prefs.groupsOff = [];
  save(self);
  self.graph.setSettings(self.prefs.settings);
  self.query = '';
  runSearch(self, '');
  applyFilter(self);
  applyColors(self);
  renderPanel(self);
  self.graph.fitToView();
}

/* ---------------------------- Zustand ------------------------------- */

function renderState(self) {
  const { dom } = self;
  clear(dom.state);
  let box = null;
  if (self.loading && !self.nodes.length) {
    box = h('div.gh__state-box', null, h('span.spinner', { 'aria-hidden': 'true' }), h('p.gh__state-text', null, text('Das Gehirn wird geladen …')));
  } else if (self.error && !self.nodes.length) {
    const msg = self.error && self.error.message ? self.error.message : 'Unbekannter Fehler.';
    box = h('div.gh__state-box', { role: 'alert' },
      h('p.gh__state-title', null, text('Das Gehirn konnte nicht geladen werden.')),
      h('p.gh__state-text', null, text(msg)),
      h('button.btn', { type: 'button', onClick: () => load(self, { first: true }) }, text('Nochmal versuchen')));
  } else if (!self.loading && !self.nodes.length) {
    box = h('div.gh__state-box', null,
      h('p.gh__state-title', null, text('Noch leer.')),
      h('p.gh__state-text', null, text('Was die KI über dich lernt, wächst hier als Netz: jede Notiz, jeder Termin, jedes Projekt ein Punkt, jede Verbindung eine Linie.')));
  }
  dom.state.hidden = !box;
  if (box) dom.state.appendChild(box);
  renderCount(self);
}

function renderCount(self) {
  const { dom } = self;
  if (!dom.count) return;
  clear(dom.count);
  if (!self.nodes.length) return;
  const s = self.graph.stats();
  let line = `${formatNumber(s.visibleNodes)} Einträge · ${formatNumber(s.visibleEdges)} Verbindungen`;
  if (self.truncated) line += ` · die neuesten ${formatNumber(self.nodes.length)} von ${formatNumber(self.total)}`;
  dom.count.appendChild(text(line));
}

function describe(self) {
  const { dom } = self;
  if (!dom.canvas || !self.graph) return;
  const s = self.graph.stats();
  const parts = [`Gehirn mit ${formatNumber(s.visibleNodes)} Einträgen und ${formatNumber(s.visibleEdges)} Verbindungen`];
  const node = self.selectedId ? self.byId.get(self.selectedId) : null;
  if (node) parts.push(`gewählt: ${node.label}`);
  parts.push('Ziehen verschiebt, Mausrad oder zwei Finger zoomen, Antippen wählt, zweimal Antippen öffnet, Pfeiltasten verschieben, 0 passt ein');
  dom.canvas.setAttribute('aria-label', `${parts.join('. ')}.`);
}

function announce(self, message) {
  const { dom } = self;
  if (!dom.live) return;
  clear(dom.live);
  if (message) dom.live.appendChild(text(message));
}
