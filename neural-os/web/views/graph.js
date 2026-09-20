/**
 * views/graph.js -- "Gehirn": the knowledge graph as a place you can work in.
 *
 * Decisions worth explaining
 * --------------------------
 * 1. **Filtering happens in the browser, loading happens on the server.**
 *    `/api/graph` is asked once for the whole selection (optionally focused and
 *    depth-limited); type filters, the "only my own links" switch and the
 *    search all run over the loaded set. Toggling a type is then instant and
 *    costs no round trip -- and, more importantly, it cannot change which
 *    nodes the server picked, so the picture stays stable while you explore
 *    it.
 * 2. **Every edge in the inspector carries its reason.** The inspector reads
 *    `/api/records/:id`, which returns the edge records themselves, so the
 *    panel can show `source` and `reason` for each link and offer to delete
 *    it. A knowledge graph that cannot answer "why are these two connected?"
 *    is decoration; this panel is where that promise is kept.
 * 3. **Hand-drawn links are marked as such by the server.** `POST /api/edges`
 *    always stores `source:'manual'`; the view never claims a provenance. The
 *    new edge is inserted into the local model immediately so it is visible at
 *    once, and the next reload replaces it with the server's own record.
 * 4. **Clusters are computed here, not fetched.** There is no clusters
 *    endpoint in the API contract, and a component labelling that runs over
 *    the nodes actually on screen is the honest one: it describes the picture
 *    the user is looking at, filters included.
 * 5. **The view owns its layout CSS.** `web/app.css` is the design system and
 *    is not edited from a view; the handful of rules that only exist to make a
 *    full-bleed canvas and a side panel fit are injected once, and every
 *    colour in them comes from a design token.
 * 6. **Live events reload instead of patching.** Records and edges change from
 *    chats, agents and rescans. A reload through `setData` keeps node
 *    positions and pinned nodes (the renderer matches on id), so a live update
 *    does not shuffle the map under the user's hands.
 */

import {
  h, text, clear, on, icon, timeAgo, formatNumber, debounce,
} from '../lib/dom.js';
import { createGraphCanvas, GRAPH_TYPES } from '../lib/graph-canvas.js';

/* ------------------------------------------------------------------ */
/* Vocabulary (German UI copy)                                         */
/* ------------------------------------------------------------------ */

const TYPE_LABELS = {
  note: 'Notiz',
  chat: 'Chat',
  project: 'Projekt',
  task: 'Aufgabe',
  agent: 'Agent',
  file: 'Datei',
  entity: 'Entität',
  run: 'Lauf',
  unknown: 'Sonstiges',
};

const TYPE_PLURALS = {
  note: 'Notizen',
  chat: 'Chats',
  project: 'Projekte',
  task: 'Aufgaben',
  agent: 'Agenten',
  file: 'Dateien',
  entity: 'Entitäten',
  run: 'Läufe',
  unknown: 'Sonstiges',
};

const KIND_LABELS = {
  'links-to': 'verweist auf',
  mentions: 'erwähnt',
  tagged: 'gemeinsames Schlagwort',
  'belongs-to': 'gehört zu',
  'derived-from': 'abgeleitet aus',
  produced: 'erzeugt',
  uses: 'nutzt',
  related: 'verwandt mit',
};

const SOURCE_LABELS = {
  manual: 'von dir',
  derived: 'abgeleitet',
  agent: 'Agent-Vorschlag',
};

/** Edge kinds offered when drawing a link by hand (mirrors schema.EDGE_KINDS). */
const DRAWABLE_KINDS = ['links-to', 'related', 'mentions', 'belongs-to', 'derived-from', 'uses'];

/**
 * Where a record is actually editable. The shell only ships eight views, so a
 * file or an entity has no detail screen of its own yet -- they open in the
 * notes list, which is where they are reachable from.
 */
const OPEN_ROUTES = {
  note: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  file: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  entity: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  chat: (id) => `#/chat?id=${encodeURIComponent(id)}`,
  project: (id) => `#/projects?id=${encodeURIComponent(id)}`,
  task: (id) => `#/projects?id=${encodeURIComponent(id)}`,
  agent: (id) => `#/agents?id=${encodeURIComponent(id)}`,
  run: (id) => `#/agents?id=${encodeURIComponent(id)}`,
};

const ICONS = {
  search: '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 4 4"/>',
  close: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  trash: '<path d="M4.6 6.4h10.8M8.2 6.4V5a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.4M6.2 6.4l.7 8.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-8.4"/>',
  fit: '<path d="M3.6 7.4V4.6a1 1 0 0 1 1-1h2.8M12.6 3.6h2.8a1 1 0 0 1 1 1v2.8M16.4 12.6v2.8a1 1 0 0 1-1 1h-2.8M7.4 16.4H4.6a1 1 0 0 1-1-1v-2.8"/>',
  refresh: '<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16.2 3.4v3.2H13"/>',
  arrowRight: '<path d="M4 10h11M11 6l4 4-4 4"/>',
  arrowLeft: '<path d="M16 10H5M9 6l-4 4 4 4"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  minus: '<path d="M4.2 10h11.6"/>',
  chat: '<path d="M4 6.2A2.2 2.2 0 0 1 6.2 4h7.6A2.2 2.2 0 0 1 16 6.2v5a2.2 2.2 0 0 1-2.2 2.2H8.6L5 16.2v-2.8A2.2 2.2 0 0 1 4 11.2z"/>',
  open: '<path d="M11.5 4.5h4v4M15.5 4.5 9 11"/><path d="M14 11.8v3.1a1.4 1.4 0 0 1-1.4 1.4H5.1a1.4 1.4 0 0 1-1.4-1.4V7.4A1.4 1.4 0 0 1 5.1 6h3.1"/>',
  pin: '<path d="M8 3.6h4l-.6 4.2 2.4 2.1v1.3H6.2v-1.3l2.4-2.1z"/><path d="M10 11.2v5"/>',
  brain: '<circle cx="10" cy="4.6" r="2.1"/><circle cx="4.6" cy="14.4" r="2.1"/><circle cx="15.4" cy="14.4" r="2.1"/><path d="M8.5 6.3 5.8 12.4M11.5 6.3l2.7 6.1M6.7 14.4h6.6"/>',
};

/** The one-time layout stylesheet (see decision 5 in the header). */
const STYLE_ID = 'nos-graph-view-style';
const STYLE = `
.main[data-view="graph"] { overflow: hidden; }
.graph-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.graph-view__bar {
  display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap;
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface); border-bottom: 1px solid var(--border);
}
.graph-view__bar--filters { gap: var(--sp-05) var(--sp-1); }
.graph-view__search { position: relative; display: flex; align-items: center; gap: var(--sp-05); }
.graph-view__search .input { width: 15rem; padding-left: 30px; }
.graph-view__search-icon {
  position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
  color: var(--fg-subtle); pointer-events: none;
}
.graph-view__search-icon svg { width: 15px; height: 15px; }
.graph-view__matches {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 6;
  width: min(24rem, 80vw); max-height: 17rem; overflow: auto;
  padding: var(--sp-05); background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--r-2); box-shadow: var(--shadow-2);
}
.graph-view__match {
  display: block; width: 100%; padding: 6px 8px; text-align: left;
  background: none; border: 0; border-radius: var(--r-1); color: var(--fg); cursor: pointer;
}
.graph-view__match:hover, .graph-view__match.is-active { background: var(--surface-3); }
.graph-view__match small { display: block; color: var(--fg-subtle); font-size: var(--fs-xs); }
.graph-view__depth { display: flex; align-items: center; gap: var(--sp-05); color: var(--fg-muted); font-size: var(--fs-sm); }
.graph-view__depth input[type="range"] { width: 6.5rem; accent-color: var(--accent); }
.graph-view__status { color: var(--fg-muted); font-size: var(--fs-sm); }
.graph-view__body { display: flex; flex: 1 1 auto; min-height: 0; }
.graph-view__stage { position: relative; flex: 1 1 auto; min-width: 0; background: var(--bg); }
.graph-view__canvas { display: block; width: 100%; height: 100%; }
.graph-view__canvas:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: -2px; }
.graph-view__float {
  position: absolute; z-index: 2; padding: var(--sp-1);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-2); box-shadow: var(--shadow-1);
}
.graph-view__legend {
  left: var(--sp-2); bottom: var(--sp-2); max-width: min(34rem, calc(100% - var(--sp-4)));
  display: flex; flex-wrap: wrap; gap: var(--sp-05) var(--sp-2);
  font-size: var(--fs-xs); color: var(--fg-muted);
}
.graph-view__legend-item { display: inline-flex; align-items: center; gap: 5px; }
.graph-view__swatch { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid; }
.graph-view__zoom { right: var(--sp-2); bottom: var(--sp-2); display: flex; flex-direction: column; gap: 4px; }
.graph-view__stage-state {
  position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center;
  padding: var(--sp-3); background: var(--bg);
}
.graph-view__stage-state--quiet { background: transparent; pointer-events: none; }
.graph-view__side {
  flex: 0 0 22rem; width: 22rem; min-width: 0; overflow: auto;
  padding: var(--sp-2); background: var(--surface); border-left: 1px solid var(--border);
}
.graph-view__side-head { display: flex; align-items: flex-start; gap: var(--sp-1); margin-bottom: var(--sp-1); }
.graph-view__side-title { font-size: var(--fs-md); line-height: var(--lh-tight); word-break: break-word; }
.graph-view__edge {
  display: flex; align-items: flex-start; gap: var(--sp-1);
  padding: var(--sp-1) 0; border-top: 1px solid var(--border);
}
.graph-view__edge-main { flex: 1 1 auto; min-width: 0; }
.graph-view__edge-target {
  display: block; width: 100%; padding: 0; text-align: left; background: none; border: 0;
  color: var(--fg); font-weight: 500; cursor: pointer; word-break: break-word;
}
.graph-view__edge-target:hover { color: var(--accent); }
.graph-view__edge-reason { margin: 2px 0 0; color: var(--fg-subtle); font-size: var(--fs-sm); word-break: break-word; }
.graph-view__cluster {
  display: flex; align-items: center; gap: var(--sp-1); width: 100%;
  padding: var(--sp-1); text-align: left; background: none;
  border: 0; border-radius: var(--r-2); color: var(--fg); cursor: pointer;
}
.graph-view__cluster:hover, .graph-view__cluster.is-active { background: var(--surface-3); }
.graph-view__cluster-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
.graph-view__hint { color: var(--fg-subtle); font-size: var(--fs-sm); }
@media (max-width: 820px) {
  .graph-view__body { flex-direction: column; }
  .graph-view__side { flex: 0 0 45%; width: auto; border-left: 0; border-top: 1px solid var(--border); }
  .graph-view__search .input { width: 9rem; }
  .graph-view__legend { display: none; }
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = STYLE; // authored here, never user data
  document.head.appendChild(node);
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Fold for search: German umlauts the way a German reader types them. */
function fold(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.unknown;
}

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || 'verwandt mit';
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || 'abgeleitet';
}

/** Display title for a raw record, for endpoints not present in the graph. */
function recordLabel(record) {
  if (!record || typeof record !== 'object') return null;
  const d = record.data || {};
  for (const field of ['title', 'name', 'goal', 'label', 'text', 'content']) {
    if (typeof d[field] === 'string' && d[field].trim()) {
      const clipped = d[field].trim().replace(/\s+/g, ' ');
      return clipped.length > 90 ? `${clipped.slice(0, 89)}…` : clipped;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Clusters (connected components of what is actually on screen)       */
/* ------------------------------------------------------------------ */

const CLUSTER_STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'und', 'oder', 'aber', 'nicht', 'auch', 'noch', 'schon', 'nur', 'wie', 'wenn', 'dann',
  'ist', 'sind', 'war', 'waren', 'hat', 'haben', 'wird', 'werden', 'fuer', 'mit', 'von',
  'zum', 'zur', 'auf', 'aus', 'bei', 'nach', 'ueber', 'unter', 'vor', 'durch', 'ohne',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'neue', 'neuer', 'neues', 'ohne',
]);

/**
 * Union-Find over the visible nodes plus a derived label per component.
 * The label is never invented: a shared tag wins, then a word shared by
 * several titles, then the title of the best-connected node.
 */
function computeClusters(nodes, edges) {
  const parent = new Map();
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const node of nodes) parent.set(node.id, node.id);
  for (const edge of edges) {
    if (!parent.has(edge.from) || !parent.has(edge.to)) continue;
    const a = find(edge.from);
    const b = find(edge.to);
    if (a !== b) parent.set(a, b);
  }

  const groups = new Map();
  for (const node of nodes) {
    const root = find(node.id);
    let group = groups.get(root);
    if (!group) groups.set(root, (group = { root, nodes: [], edges: 0 }));
    group.nodes.push(node);
  }
  for (const edge of edges) {
    if (!parent.has(edge.from) || !parent.has(edge.to)) continue;
    const group = groups.get(find(edge.from));
    if (group) group.edges += 1;
  }

  const out = [];
  for (const group of groups.values()) {
    const tagCount = new Map();
    const wordCount = new Map();
    const typeCount = new Map();
    let top = null;
    for (const node of group.nodes) {
      typeCount.set(node.type, (typeCount.get(node.type) || 0) + 1);
      if (!top || node.degree > top.degree || (node.degree === top.degree && node.id < top.id)) top = node;
      for (const tag of new Set((node.tags || []).map((t) => t.trim()).filter(Boolean))) {
        tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
      }
      const words = new Set(fold(node.label).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !CLUSTER_STOPWORDS.has(w)));
      for (const word of words) wordCount.set(word, (wordCount.get(word) || 0) + 1);
    }
    const best = (map) => [...map.entries()].sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))[0] || null;
    const topTag = best(tagCount);
    const topWord = best(wordCount);
    let label;
    if (topTag && (topTag[1] > 1 || group.nodes.length === 1)) label = `#${topTag[0]}`;
    else if (topWord && topWord[1] > 1) label = topWord[0].charAt(0).toUpperCase() + topWord[0].slice(1);
    else if (top) label = top.label;
    else label = 'Gruppe';
    out.push({
      id: group.root,
      label,
      size: group.nodes.length,
      edges: group.edges,
      nodeIds: group.nodes.map((node) => node.id),
      topNodeId: top ? top.id : null,
      types: [...typeCount.entries()].sort((a, b) => b[1] - a[1]),
    });
  }
  out.sort((a, b) => (b.size === a.size ? (a.label < b.label ? -1 : 1) : b.size - a.size));
  return out;
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

/** Per-mount state. The shell caches the module, so this is reset in mount(). */
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
      console.error('[graph] Aufräumen ist gescheitert:', err);
    }
  }
  for (const controller of dying.requests) {
    try {
      controller.abort();
    } catch { /* already done */ }
  }
  dying.requests.clear();
  closeContextMenu(dying);
  if (dying.reloadSoon && typeof dying.reloadSoon.cancel === 'function') dying.reloadSoon.cancel();
  if (dying.searchSoon && typeof dying.searchSoon.cancel === 'function') dying.searchSoon.cancel();
  if (dying.graph) {
    try {
      dying.graph.destroy();
    } catch (err) {
      console.error('[graph] Renderer konnte nicht abgebaut werden:', err);
    }
  }
}

export default {
  id: 'graph',
  title: 'Gehirn',
  icon: ICONS.brain,

  async mount(container, ctx) {
    ensureStyle();
    teardown(); // defensive: a failed unmount must not leak the old renderer

    const params = (ctx.route && ctx.route.params) || {};
    const depthParam = Number.parseInt(params.depth, 10);

    const self = {
      alive: true,
      ctx,
      container,
      cleanups: [],
      requests: new Set(),
      graph: null,
      dom: {},

      // data
      nodes: [],
      edges: [],
      nodeById: new Map(),
      stats: null,
      truncated: false,
      loading: false,
      loadError: null,
      limit: 1200,

      // query options
      focusId: typeof params.focus === 'string' && params.focus ? params.focus : null,
      depth: Number.isFinite(depthParam) ? Math.min(Math.max(depthParam, 0), 6) : 2,
      serverQuery: typeof params.q === 'string' ? params.q : '',

      // client-side filters
      activeTypes: new Set(GRAPH_TYPES),
      onlyMine: false,
      clusterMode: false,
      manualIds: new Set(),

      // search
      query: '',
      matches: [],
      matchIndex: -1,

      // selection / inspector
      selectedId: null,
      inspector: null, // {record, edges, labels:Map, loading, error}
      inspectorToken: 0,
      clusters: [],
      activeCluster: null,
      drawKind: 'links-to',
    };
    view = self;

    buildLayout(self);
    createRenderer(self);
    subscribe(self);
    renderToolbar(self);
    renderSide(self);
    await load(self, { fit: true });
  },

  async unmount() {
    teardown();
  },
};

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container } = self;
  clear(container);

  const dom = self.dom;

  dom.searchInput = h('input.input', {
    type: 'search',
    placeholder: 'Knoten suchen …',
    'aria-label': 'Knoten im Graphen suchen',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  dom.matchBox = h('div.graph-view__matches', { hidden: true, role: 'listbox' });
  dom.matchCount = h('span.graph-view__status');

  dom.search = h('div.graph-view__search', null,
    h('span.graph-view__search-icon', null, icon(ICONS.search)),
    dom.searchInput,
    dom.matchBox);

  dom.toolbarRight = h('div.row');
  dom.bar = h('div.graph-view__bar', null, dom.search, dom.matchCount, h('span.spacer'), dom.toolbarRight);

  dom.filters = h('div.graph-view__bar.graph-view__bar--filters');

  dom.canvas = h('canvas.graph-view__canvas', {
    role: 'img',
    'aria-label': 'Wissensgraph. Mit den Pfeiltasten verschieben, mit Plus und Minus zoomen, mit 0 einpassen.',
  });
  dom.legend = h('div.graph-view__float.graph-view__legend', { 'aria-label': 'Legende' });
  dom.zoom = h('div.graph-view__float.graph-view__zoom', null,
    h('button.icon-button', { type: 'button', title: 'Vergrößern', 'aria-label': 'Vergrößern', onClick: () => self.graph && self.graph.zoomBy(1.3) }, icon(ICONS.plus)),
    h('button.icon-button', { type: 'button', title: 'Verkleinern', 'aria-label': 'Verkleinern', onClick: () => self.graph && self.graph.zoomBy(0.77) }, icon(ICONS.minus)),
    h('button.icon-button', { type: 'button', title: 'Ansicht einpassen (F)', 'aria-label': 'Ansicht einpassen', onClick: () => self.graph && self.graph.fitToView() }, icon(ICONS.fit)));
  dom.stageState = h('div.graph-view__stage-state', { hidden: true });
  dom.stage = h('div.graph-view__stage', null, dom.canvas, dom.legend, dom.zoom, dom.stageState);

  dom.side = h('aside.graph-view__side', { 'aria-label': 'Inspektor' });
  dom.body = h('div.graph-view__body', null, dom.stage, dom.side);

  container.appendChild(h('div.graph-view', null, dom.bar, dom.filters, dom.body));

  // --- search interactions ---
  self.searchSoon = debounce((value) => {
    if (!self.alive) return;
    applySearch(self, value);
  }, 160);

  self.cleanups.push(on(dom.searchInput, 'input', () => {
    self.searchSoon(dom.searchInput.value);
  }));
  self.cleanups.push(on(dom.searchInput, 'keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      self.searchSoon.cancel();
      const value = dom.searchInput.value.trim();
      if (value === self.query && self.matches.length) {
        // Same query, pressed again: walk to the next hit instead of
        // jumping back to the first one.
        stepMatch(self, event.shiftKey ? -1 : 1);
      } else {
        applySearch(self, value);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dom.searchInput.value = '';
      applySearch(self, '');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      stepMatch(self, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      stepMatch(self, -1);
    }
  }));
  self.cleanups.push(on(dom.searchInput, 'blur', () => {
    // Late enough for a click on a result to land first.
    setTimeout(() => {
      if (self.alive) dom.matchBox.hidden = true;
    }, 140);
  }));
  self.cleanups.push(on(dom.searchInput, 'focus', () => {
    if (self.matches.length) dom.matchBox.hidden = false;
  }));

  // --- view-level shortcuts, deliberately few (the shell owns g, / and ?) ---
  self.cleanups.push(on(document, 'keydown', (event) => {
    if (!self.alive || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (typing) return;
    if (event.key === 'f') {
      event.preventDefault();
      if (self.graph) self.graph.fitToView();
    } else if (event.key === 'Escape' && self.selectedId) {
      event.preventDefault();
      selectNode(self, null);
    }
  }));
}

/* ------------------------------------------------------------------ */
/* Renderer wiring                                                     */
/* ------------------------------------------------------------------ */

function createRenderer(self) {
  const { ctx } = self;
  self.graph = createGraphCanvas(self.dom.canvas, {
    onSelect: (node) => {
      selectNode(self, node ? node.id : null);
    },
    onDoubleClick: (node) => {
      if (!node) return;
      // Double click = "show me this corner of the graph": refocus the query
      // on that node so its neighbourhood is loaded, not just centred.
      setFocus(self, node.id);
    },
    onContext: (node, position) => {
      if (!node) return;
      selectNode(self, node.id);
      openContextMenu(self, node, position);
    },
    onLink: ({ from, to }) => {
      createEdge(self, from, to);
    },
    onTransform: () => {
      // Nothing to persist: the transform is view state, not user data.
    },
  });
  self.cleanups.push(() => {
    /* the renderer itself is destroyed in teardown() */
  });

  // The legend mirrors the renderer's palette, which follows the theme.
  const refreshLegend = () => {
    if (!self.alive) return;
    self.graph.refreshTheme();
    renderLegend(self);
  };
  if (ctx.state && typeof ctx.state.on === 'function') {
    self.cleanups.push(ctx.state.on('theme', refreshLegend));
  }
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => refreshLegend();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handler);
      self.cleanups.push(() => media.removeEventListener('change', handler));
    }
  } catch {
    /* a browser without matchMedia simply keeps the first palette */
  }
  renderLegend(self);
}

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;
  self.reloadSoon = debounce(() => {
    if (!self.alive || self.loading) return;
    load(self, { fit: false });
  }, 900);
  for (const name of ['edge.created', 'edge.deleted', 'record.created', 'record.updated', 'record.deleted', 'graph.rescanned']) {
    self.cleanups.push(ctx.bus.on(name, () => self.reloadSoon()));
  }
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

async function load(self, { fit = false } = {}) {
  const { ctx } = self;
  self.loading = true;
  self.loadError = null;
  renderStage(self);
  renderToolbar(self);

  const query = { limit: self.limit, includeOrphans: true };
  if (self.focusId) {
    query.focus = self.focusId;
    query.depth = self.depth;
  }
  if (self.serverQuery) query.q = self.serverQuery;

  let data;
  try {
    data = await request(self, (signal) => ctx.api.get('/graph', { query, signal, timeoutMs: 20000 }));
  } catch (err) {
    if (!self.alive) return;
    if (err && err.isAborted) return;
    self.loading = false;
    // A focus id that no longer exists must not leave the view stuck on it.
    if (err && err.status === 404 && self.focusId) {
      self.focusId = null;
      ctx.toast('Der Fokus-Knoten existiert nicht mehr. Es wird der ganze Graph gezeigt.', 'info');
      await load(self, { fit: true });
      return;
    }
    self.loadError = err;
    renderStage(self);
    renderToolbar(self);
    return;
  }
  if (!self.alive) return;

  self.nodes = Array.isArray(data && data.nodes) ? data.nodes : [];
  self.edges = Array.isArray(data && data.edges) ? data.edges : [];
  self.stats = (data && data.stats) || null;
  self.truncated = !!(data && data.truncated);
  self.nodeById = new Map(self.nodes.map((node) => [node.id, node]));
  self.manualIds = new Set();
  for (const edge of self.edges) {
    if (edge.source !== 'manual') continue;
    self.manualIds.add(edge.from);
    self.manualIds.add(edge.to);
  }
  self.loading = false;

  self.graph.setData({ nodes: self.nodes, edges: self.edges });
  applyFilter(self);
  if (self.query) applySearch(self, self.query, { jump: false });
  if (self.clusterMode) rebuildClusters(self);
  if (self.selectedId && !self.nodeById.has(self.selectedId)) selectNode(self, null);
  else self.graph.setSelection(self.selectedId);

  if (fit) self.graph.fitToView({ animate: false });
  if (fit && self.focusId && self.nodeById.has(self.focusId)) {
    self.graph.focus(self.focusId, { animate: false });
    selectNode(self, self.focusId);
  }

  renderStage(self);
  renderToolbar(self);
  renderSide(self);
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

function applyFilter(self) {
  const types = self.activeTypes;
  const onlyMine = self.onlyMine;
  const manual = self.manualIds;
  const keepId = self.selectedId;

  const filter = (node) => {
    if (!types.has(node.type)) return node.id === keepId;
    if (onlyMine && !manual.has(node.id)) return node.id === keepId;
    return true;
  };
  // Edge visibility rides along on the node filter: the renderer asks for it
  // separately so that "only my links" can hide derived edges between two
  // nodes that both stay on screen.
  if (onlyMine) filter.edge = (edge) => edge.source === 'manual';

  self.graph.setFilter(filter);
  if (self.clusterMode) rebuildClusters(self);
  renderStage(self);
  renderToolbar(self);
}

function visibleNodes(self) {
  const types = self.activeTypes;
  const onlyMine = self.onlyMine;
  return self.nodes.filter((node) => types.has(node.type) && (!onlyMine || self.manualIds.has(node.id)));
}

function visibleEdges(self, nodeIds) {
  return self.edges.filter((edge) => (!self.onlyMine || edge.source === 'manual')
    && nodeIds.has(edge.from) && nodeIds.has(edge.to));
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

function renderToolbar(self) {
  const { dom, ctx } = self;

  /* --- right-hand actions --- */
  clear(dom.toolbarRight);
  dom.toolbarRight.appendChild(toggleButton('Nur meine Verknüpfungen', self.onlyMine, () => {
    self.onlyMine = !self.onlyMine;
    applyFilter(self);
    renderSide(self);
  }, 'Blendet alles aus, was das System selbst abgeleitet oder ein Agent vorgeschlagen hat.'));
  dom.toolbarRight.appendChild(toggleButton('Cluster', self.clusterMode, () => {
    self.clusterMode = !self.clusterMode;
    if (self.clusterMode) {
      // Asking for the cluster list is a request to see the list, so the
      // inspector steps aside; picking a node afterwards brings it back.
      selectNode(self, null);
      rebuildClusters(self);
    } else {
      self.clusters = [];
      self.activeCluster = null;
      self.graph.setClusters(null);
      self.graph.highlight(self.query ? self.matches.map((n) => n.id) : null);
    }
    renderToolbar(self);
    renderSide(self);
  }, 'Färbt zusammenhängende Gruppen ein und listet sie auf.'));

  dom.toolbarRight.appendChild(h('button.btn.btn--small', {
    type: 'button',
    title: 'Ansicht einpassen (F)',
    onClick: () => self.graph && self.graph.fitToView(),
  }, icon(ICONS.fit), text('Einpassen')));

  dom.toolbarRight.appendChild(h('button.btn.btn--small', {
    type: 'button',
    disabled: self.loading,
    title: 'Leitet alle Verknüpfungen neu aus [[Wiki-Links]], #Schlagwörtern und Zugehörigkeiten ab.',
    onClick: () => rescan(self),
  }, icon(ICONS.refresh), text('Links neu berechnen')));

  /* --- filter row --- */
  clear(dom.filters);
  const counts = new Map();
  for (const node of self.nodes) counts.set(node.type, (counts.get(node.type) || 0) + 1);

  for (const type of GRAPH_TYPES) {
    const count = counts.get(type) || 0;
    const active = self.activeTypes.has(type);
    const chip = h('button.chip', {
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      title: count === 0 ? `Keine ${TYPE_PLURALS[type]} im Ausschnitt` : `${TYPE_PLURALS[type]} ein- oder ausblenden`,
      style: active ? null : { opacity: '0.45' },
      onClick: () => {
        if (self.activeTypes.has(type)) self.activeTypes.delete(type);
        else self.activeTypes.add(type);
        if (!self.activeTypes.size) {
          // Hiding everything is never what someone means.
          for (const t of GRAPH_TYPES) self.activeTypes.add(t);
          ctx.toast('Mindestens eine Art muss sichtbar bleiben.', 'info');
        }
        applyFilter(self);
        renderSide(self);
      },
    },
    h('span.graph-view__swatch', { style: swatchStyle(self, type) }),
    h('span.chip__label', null, text(`${TYPE_PLURALS[type]} ${formatNumber(count)}`)));
    dom.filters.appendChild(chip);
  }

  const depthWrap = h('label.graph-view__depth', {
    title: self.focusId
      ? 'Wie viele Schritte weit die Nachbarschaft des Fokus-Knotens geladen wird.'
      : 'Die Tiefe wirkt erst, wenn ein Knoten im Fokus steht (Doppelklick auf einen Knoten).',
  },
  text('Tiefe'),
  h('input', {
    type: 'range',
    min: '0',
    max: '4',
    step: '1',
    value: String(self.depth),
    disabled: !self.focusId,
    'aria-label': 'Tiefe der geladenen Nachbarschaft',
    onChange: (event) => {
      const next = Number.parseInt(event.target.value, 10);
      if (!Number.isFinite(next) || next === self.depth) return;
      self.depth = next;
      syncRoute(self);
      load(self, { fit: false });
    },
  }),
  h('span', null, text(self.focusId ? String(self.depth) : '–')));
  dom.filters.appendChild(depthWrap);

  if (self.focusId) {
    const node = self.nodeById.get(self.focusId);
    dom.filters.appendChild(h('button.btn.btn--small', {
      type: 'button',
      title: 'Fokus aufheben und wieder den ganzen Graphen zeigen',
      onClick: () => setFocus(self, null),
    }, icon(ICONS.close), text(`Fokus: ${node ? node.label : self.focusId}`)));
  }

  dom.filters.appendChild(h('span.spacer'));
  dom.filters.appendChild(statusLine(self));
}

function statusLine(self) {
  const stats = self.graph ? self.graph.stats() : null;
  const parts = [];
  if (self.loading) parts.push('lädt …');
  else if (stats) {
    parts.push(`${formatNumber(stats.visibleNodes)} von ${formatNumber(self.nodes.length)} Knoten`);
    parts.push(`${formatNumber(stats.visibleEdges)} Verknüpfungen`);
  }
  const line = h('span.graph-view__status', null, text(parts.join(' · ')));
  if (!self.truncated) return line;

  const total = self.stats && Number.isFinite(self.stats.candidates) ? self.stats.candidates : null;
  return h('span.row', null,
    line,
    h('span.badge.badge--danger', {
      title: total
        ? `Es gibt ${formatNumber(total)} passende Einträge; geladen sind ${formatNumber(self.nodes.length)}.`
        : 'Es gibt mehr passende Einträge, als geladen wurden.',
    }, text('Ausschnitt')),
    self.limit < 5000
      ? h('button.btn.btn--small', {
        type: 'button',
        disabled: self.loading,
        onClick: () => {
          self.limit = Math.min(5000, self.limit * 2);
          load(self, { fit: false });
        },
      }, text('Mehr laden'))
      : null);
}

function toggleButton(label, active, onClick, title) {
  return h('button.btn.btn--small', {
    type: 'button',
    'aria-pressed': active ? 'true' : 'false',
    class: active ? 'btn--primary' : '',
    title: title || '',
    onClick,
  }, text(label));
}

function swatchStyle(self, type) {
  const palette = self.graph ? self.graph.getPalette() : null;
  if (!palette) return { borderColor: 'currentColor' };
  const color = palette.types[type] || palette.types.unknown;
  const fill = palette.fillOf(color);
  const css = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
  return { borderColor: css(color), background: css(fill) };
}

function renderLegend(self) {
  const { dom } = self;
  clear(dom.legend);
  for (const type of GRAPH_TYPES) {
    dom.legend.appendChild(h('span.graph-view__legend-item', null,
      h('span.graph-view__swatch', { style: swatchStyle(self, type) }),
      text(TYPE_LABELS[type])));
  }
  const lineIcon = (dash, color) => h('svg', { width: '22', height: '10', viewBox: '0 0 22 10', 'aria-hidden': 'true' },
    h('line', {
      x1: '1', y1: '5', x2: '21', y2: '5',
      stroke: color, 'stroke-width': '1.6', 'stroke-dasharray': dash,
    }));
  dom.legend.appendChild(h('span.graph-view__legend-item', null, lineIcon('', 'currentColor'), text('von dir verknüpft')));
  dom.legend.appendChild(h('span.graph-view__legend-item', null, lineIcon('3 3', 'currentColor'), text('abgeleitet')));
  dom.legend.appendChild(h('span.graph-view__legend-item', null, lineIcon('7 3 1.5 3', 'var(--warn)'), text('Agent-Vorschlag')));
}

/* ------------------------------------------------------------------ */
/* Stage states: loading, error, empty                                 */
/* ------------------------------------------------------------------ */

function renderStage(self) {
  const { dom, ctx } = self;
  const state = dom.stageState;
  clear(state);

  if (self.loadError) {
    state.hidden = false;
    state.appendChild(h('div.view-state', null,
      h('div.view-state__icon', null, icon(ICONS.brain)),
      h('h2.view-state__title', null, text('Der Graph konnte nicht geladen werden')),
      h('p.view-state__text', null, text(self.loadError.message || 'Unbekannter Fehler.')),
      h('div.view-state__actions', null,
        h('button.btn.btn--primary', { type: 'button', onClick: () => load(self, { fit: true }) }, text('Erneut versuchen')))));
    return;
  }

  if (self.loading && !self.nodes.length) {
    state.hidden = false;
    state.appendChild(h('div.view-state', { role: 'status' },
      h('div.spinner', { 'aria-hidden': 'true' }),
      h('p.view-state__text', null, text('Der Graph wird aufgebaut …'))));
    return;
  }

  if (!self.nodes.length) {
    state.hidden = false;
    state.appendChild(h('div.view-state', null,
      h('div.view-state__icon', null, icon(ICONS.brain)),
      h('h2.view-state__title', null, text('Hier ist noch nichts verknüpft')),
      h('p.view-state__text', null, text(
        'Dieses Gehirn wächst aus dem, was du festhältst: Jede Notiz, jeder Chat, '
        + 'jedes Projekt und jede Aufgabe wird ein Knoten. Verknüpfungen entstehen von selbst '
        + 'aus [[Wiki-Links]] und #Schlagwörtern in deinen Texten – und aus allem, was du hier '
        + 'von Hand verbindest.')),
      h('div.view-state__actions', null,
        h('button.btn.btn--primary', { type: 'button', onClick: () => ctx.navigate('#/notes') }, text('Notiz schreiben')),
        h('button.btn', { type: 'button', onClick: () => ctx.navigate('#/chat') }, icon(ICONS.chat), text('Chat öffnen')),
        h('button.btn', { type: 'button', disabled: self.loading, onClick: () => rescan(self) }, icon(ICONS.refresh), text('Links neu berechnen')))));
    return;
  }

  const stats = self.graph ? self.graph.stats() : null;
  if (stats && stats.visibleNodes === 0) {
    state.hidden = false;
    state.appendChild(h('div.view-state', null,
      h('h2.view-state__title', null, text('Keine Knoten in dieser Auswahl')),
      h('p.view-state__text', null, text('Die aktuellen Filter blenden alles aus, was geladen ist.')),
      h('div.view-state__actions', null,
        h('button.btn.btn--primary', {
          type: 'button',
          onClick: () => {
            self.activeTypes = new Set(GRAPH_TYPES);
            self.onlyMine = false;
            applyFilter(self);
            renderToolbar(self);
            renderSide(self);
            self.graph.fitToView();
          },
        }, text('Filter zurücksetzen')))));
    return;
  }

  state.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function applySearch(self, rawValue, { jump = true } = {}) {
  const value = String(rawValue || '').trim();
  self.query = value;
  const { dom } = self;

  if (!value) {
    self.matches = [];
    self.matchIndex = -1;
    dom.matchBox.hidden = true;
    clear(dom.matchBox);
    clear(dom.matchCount);
    self.graph.highlight(null);
    return;
  }

  const needle = fold(value);
  const scored = [];
  for (const node of visibleNodes(self)) {
    const label = fold(node.label);
    let score = 0;
    if (label === needle) score = 100;
    else if (label.startsWith(needle)) score = 80;
    else if (label.includes(needle)) score = 60;
    else if ((node.tags || []).some((tag) => fold(tag).includes(needle))) score = 40;
    else if (fold(node.snippet).includes(needle)) score = 20;
    if (!score) continue;
    scored.push({ node, score: score + Math.min(node.degree, 20) / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  self.matches = scored.map((entry) => entry.node);
  self.matchIndex = self.matches.length ? 0 : -1;

  clear(dom.matchCount);
  dom.matchCount.appendChild(text(self.matches.length
    ? `${self.matches.length} Treffer`
    : 'Kein Treffer im geladenen Ausschnitt'));

  clear(dom.matchBox);
  if (!self.matches.length) {
    dom.matchBox.appendChild(h('div.graph-view__match.is-muted', null,
      text('Nichts gefunden.'),
      h('small', null, text('Im ganzen Tresor suchen: Enter drücken, um die Auswahl neu zu laden.'))));
    dom.matchBox.appendChild(h('button.graph-view__match', {
      type: 'button',
      onClick: () => {
        self.serverQuery = value;
        syncRoute(self);
        load(self, { fit: true });
      },
    }, text(`„${value}“ im ganzen Tresor suchen`)));
    dom.matchBox.hidden = false;
  } else {
    for (const [i, node] of self.matches.slice(0, 12).entries()) {
      dom.matchBox.appendChild(h('button.graph-view__match', {
        type: 'button',
        role: 'option',
        class: i === 0 ? 'is-active' : '',
        onClick: () => {
          self.matchIndex = i;
          jumpToMatch(self);
        },
      }, text(node.label), h('small', null, text(`${typeLabel(node.type)} · ${formatNumber(node.degree)} Verknüpfungen`))));
    }
    dom.matchBox.hidden = false;
  }

  self.graph.highlight(self.matches.map((node) => node.id));
  if (jump && self.matches.length) jumpToMatch(self);
}

function stepMatch(self, delta) {
  if (!self.matches.length) return;
  self.matchIndex = (self.matchIndex + delta + self.matches.length) % self.matches.length;
  jumpToMatch(self);
}

function jumpToMatch(self) {
  const node = self.matches[self.matchIndex];
  if (!node) return;
  self.graph.focus(node.id);
  selectNode(self, node.id);
  const { dom } = self;
  for (const [i, child] of [...dom.matchBox.children].entries()) {
    child.classList.toggle('is-active', i === self.matchIndex);
  }
  clear(dom.matchCount);
  dom.matchCount.appendChild(text(`Treffer ${self.matchIndex + 1} von ${self.matches.length}`));
}

/* ------------------------------------------------------------------ */
/* Focus / route                                                       */
/* ------------------------------------------------------------------ */

function syncRoute(self) {
  const params = new URLSearchParams();
  if (self.focusId) {
    params.set('focus', self.focusId);
    params.set('depth', String(self.depth));
  }
  if (self.serverQuery) params.set('q', self.serverQuery);
  const hash = params.toString() ? `#/graph?${params.toString()}` : '#/graph';
  if (window.location.hash === hash) return;
  // Replace instead of navigate: re-rendering the view here would throw away
  // the simulation the user is looking at.
  try {
    window.history.replaceState(null, '', hash);
  } catch {
    /* file:// or a locked-down browser: the address just stays as it is */
  }
}

function setFocus(self, id) {
  self.focusId = id || null;
  if (!self.focusId) self.serverQuery = '';
  syncRoute(self);
  load(self, { fit: true });
}

/* ------------------------------------------------------------------ */
/* Selection + inspector                                               */
/* ------------------------------------------------------------------ */

function selectNode(self, id) {
  const next = id && self.nodeById.has(id) ? id : null;
  self.selectedId = next;
  self.graph.setSelection(next);
  self.activeCluster = null;
  if (!next) {
    self.inspector = null;
    renderSide(self);
    return;
  }
  self.inspector = { node: self.nodeById.get(next), edges: [], labels: new Map(), loading: true, error: null };
  renderSide(self);
  loadInspector(self, next);
}

async function loadInspector(self, id) {
  const token = ++self.inspectorToken;
  let payload;
  try {
    payload = await request(self, (signal) => self.ctx.api.get(`/records/${encodeURIComponent(id)}`, { signal }));
  } catch (err) {
    if (!self.alive || token !== self.inspectorToken) return;
    if (err && err.isAborted) return;
    self.inspector = { ...self.inspector, loading: false, error: err };
    renderSide(self);
    return;
  }
  if (!self.alive || token !== self.inspectorToken) return;

  const record = payload && payload.record ? payload.record : null;
  const edgeRecords = Array.isArray(payload && payload.edges) ? payload.edges : [];
  const labels = new Map();
  const unknown = [];
  for (const edge of edgeRecords) {
    const other = edge.data && (edge.data.from === id ? edge.data.to : edge.data.from);
    if (!other) continue;
    const known = self.nodeById.get(other);
    if (known) labels.set(other, { label: known.label, type: known.type });
    else if (!unknown.includes(other)) unknown.push(other);
  }

  self.inspector = { node: self.nodeById.get(id), record, edges: edgeRecords, labels, loading: false, error: null };
  renderSide(self);

  // Endpoints outside the loaded excerpt: fetch just their titles, capped so
  // a hub with 200 links cannot fire 200 requests.
  if (unknown.length) {
    const wanted = unknown.slice(0, 24);
    const results = await Promise.allSettled(wanted.map((other) => request(
      self,
      (signal) => self.ctx.api.get(`/records/${encodeURIComponent(other)}`, { signal, timeoutMs: 8000 }),
    )));
    if (!self.alive || token !== self.inspectorToken) return;
    let changed = false;
    for (const [i, result] of results.entries()) {
      if (result.status !== 'fulfilled') continue;
      const other = result.value && result.value.record;
      const label = recordLabel(other);
      if (!label) continue;
      labels.set(wanted[i], { label, type: other.type });
      changed = true;
    }
    if (changed) renderSide(self);
  }
}

function renderSide(self) {
  const { dom } = self;
  clear(dom.side);

  // A selected node outranks the cluster list: the user just pointed at
  // something and expects to see what it is.
  if (self.selectedId && self.inspector) {
    dom.side.appendChild(renderInspector(self));
    return;
  }
  if (self.clusterMode) {
    dom.side.appendChild(renderClusterPanel(self));
    return;
  }
  dom.side.appendChild(renderSideHelp(self));
}

function renderSideHelp(self) {
  const stats = self.graph ? self.graph.stats() : null;
  return h('div.stack', null,
    h('h2.graph-view__side-title', null, text('Inspektor')),
    h('p.graph-view__hint', null, text('Wähle einen Knoten aus, um Auszug, Schlagwörter und alle Verknüpfungen mit ihrer Begründung zu sehen.')),
    h('hr.divider'),
    h('p.graph-view__hint', null, text('Bedienung')),
    h('ul.graph-view__hint', { style: { paddingLeft: '18px', margin: '0' } },
      h('li', null, text('Ziehen auf freier Fläche verschiebt, Mausrad zoomt.')),
      h('li', null, text('Einen Knoten ziehen fixiert ihn an dieser Stelle.')),
      h('li', null, text('Doppelklick lädt die Nachbarschaft dieses Knotens.')),
      h('li', null, text('Alt gedrückt halten und von einem Knoten auf einen zweiten ziehen legt eine eigene Verknüpfung an.')),
      h('li', null, text('Taste F passt die Ansicht ein, Escape hebt die Auswahl auf.'))),
    stats
      ? h('p.graph-view__hint', null, text(`Geladen: ${formatNumber(self.nodes.length)} Knoten, ${formatNumber(self.edges.length)} Verknüpfungen.`))
      : null);
}

function renderInspector(self) {
  const { ctx, inspector } = self;
  const node = inspector.node || { id: self.selectedId, label: self.selectedId, type: 'unknown', tags: [], snippet: '', degree: 0, totalDegree: 0 };
  const pinned = self.graph.isPinned(node.id);

  const head = h('div.graph-view__side-head', null,
    h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
      h('span.badge', null, text(typeLabel(node.type))),
      h('h2.graph-view__side-title', null, text(node.label))),
    h('button.icon-button', {
      type: 'button',
      title: self.clusterMode ? 'Zurück zur Cluster-Liste' : 'Auswahl aufheben',
      'aria-label': self.clusterMode ? 'Zurück zur Cluster-Liste' : 'Auswahl aufheben',
      onClick: () => selectNode(self, null),
    }, icon(ICONS.close)));

  const meta = [];
  if (node.updatedAt) meta.push(`geändert ${timeAgo(node.updatedAt)}`);
  meta.push(`${formatNumber(node.totalDegree || node.degree || 0)} Verknüpfungen`);
  if (pinned) meta.push('fixiert');

  const actions = h('div.row', null,
    h('button.btn.btn--small.btn--primary', {
      type: 'button',
      onClick: () => {
        const route = OPEN_ROUTES[node.type];
        if (!route) {
          ctx.toast('Für diese Art gibt es noch keine eigene Ansicht.', 'info');
          return;
        }
        ctx.navigate(route(node.id));
      },
    }, icon(ICONS.open), text('Öffnen')),
    h('button.btn.btn--small', {
      type: 'button',
      title: 'Hängt diesen Knoten als Kontext an den aktuellen Chat an.',
      onClick: () => addToChat(self, node),
    }, icon(ICONS.chat), text('Zu Chat hinzufügen')),
    h('button.btn.btn--small', {
      type: 'button',
      onClick: () => setFocus(self, node.id),
      title: 'Lädt die Nachbarschaft dieses Knotens.',
    }, text('Fokussieren')),
    pinned
      ? h('button.btn.btn--small', {
        type: 'button',
        onClick: () => {
          self.graph.unpin(node.id);
          renderSide(self);
        },
      }, icon(ICONS.pin), text('Fixierung lösen'))
      : null);

  const body = h('div.stack', null,
    head,
    h('p.meta', null, text(meta.join(' · '))),
    node.snippet ? h('p', null, text(node.snippet)) : null,
    (node.tags && node.tags.length)
      ? h('div.row', null, ...node.tags.map((tag) => h('span.tag', null, text(`#${tag}`))))
      : null,
    actions,
    h('hr.divider'));

  if (inspector.loading) {
    body.appendChild(h('p.graph-view__hint', { role: 'status' }, text('Verknüpfungen werden geladen …')));
    return body;
  }
  if (inspector.error) {
    body.appendChild(h('p.is-danger', null, text(inspector.error.message || 'Die Verknüpfungen konnten nicht geladen werden.')));
    body.appendChild(h('button.btn.btn--small', { type: 'button', onClick: () => loadInspector(self, node.id) }, text('Erneut versuchen')));
    return body;
  }

  const edgeRecords = inspector.edges.filter((edge) => edge && edge.data && !edge.deletedAt);
  body.appendChild(h('h3', { style: { fontSize: 'var(--fs-base)' } },
    text(`Verknüpfungen (${formatNumber(edgeRecords.length)})`)));

  if (!edgeRecords.length) {
    body.appendChild(h('p.graph-view__hint', null, text(
      'Noch nichts verknüpft. Halte Alt gedrückt und ziehe von diesem Knoten auf einen anderen, '
      + 'um die erste Verbindung selbst zu legen.')));
  }

  // Own links first: what the user decided outranks what the system guessed.
  const order = { manual: 0, agent: 1, derived: 2 };
  edgeRecords.sort((a, b) => (order[a.data.source] ?? 3) - (order[b.data.source] ?? 3));

  for (const edge of edgeRecords) {
    body.appendChild(renderEdgeRow(self, node, edge));
  }

  body.appendChild(h('div.row', { style: { marginTop: 'var(--sp-1)' } },
    h('label.graph-view__hint', { for: 'graph-draw-kind' }, text('Neue Verknüpfung als')),
    h('select.select#graph-draw-kind', {
      style: { width: 'auto' },
      onChange: (event) => { self.drawKind = event.target.value; },
    }, ...DRAWABLE_KINDS.map((kind) => h('option', { value: kind, selected: kind === self.drawKind }, text(kindLabel(kind)))))));
  body.appendChild(h('p.graph-view__hint', null, text('Alt gedrückt halten und auf einen zweiten Knoten ziehen.')));

  return body;
}

function renderEdgeRow(self, node, edge) {
  const data = edge.data || {};
  const outgoing = data.from === node.id;
  const otherId = outgoing ? data.to : data.from;
  const known = self.inspector.labels.get(otherId);
  const label = known ? known.label : otherId;

  return h('div.graph-view__edge', null,
    h('span', { title: outgoing ? 'zeigt auf' : 'wird verwiesen von', style: { color: 'var(--fg-subtle)', marginTop: '2px' } },
      icon(outgoing ? ICONS.arrowRight : ICONS.arrowLeft)),
    h('div.graph-view__edge-main', null,
      h('button.graph-view__edge-target', {
        type: 'button',
        title: self.nodeById.has(otherId) ? 'Im Graphen auswählen' : 'Nicht im geladenen Ausschnitt – lädt die Nachbarschaft',
        onClick: () => {
          if (self.nodeById.has(otherId)) {
            self.graph.focus(otherId);
            selectNode(self, otherId);
          } else {
            setFocus(self, otherId);
          }
        },
      }, text(label)),
      h('p.meta', null, text(`${kindLabel(data.kind)} · ${sourceLabel(data.source)}`)),
      h('p.graph-view__edge-reason', null, text(data.reason || 'Keine Begründung hinterlegt.'))),
    h('button.icon-button', {
      type: 'button',
      title: 'Diese Verknüpfung löschen',
      'aria-label': `Verknüpfung zu ${label} löschen`,
      onClick: () => removeEdge(self, edge, label),
    }, icon(ICONS.trash)));
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

async function createEdge(self, from, to) {
  const { ctx } = self;
  if (from === to) return;
  const target = self.nodeById.get(to);
  const source = self.nodeById.get(from);
  try {
    const result = await request(self, (signal) => ctx.api.post('/edges', {
      from,
      to,
      kind: self.drawKind,
      reason: 'Im Graphen von Hand gezogen',
    }, { signal }));
    if (!self.alive) return;
    const record = result && result.record;
    if (!record || !record.data) throw new Error('Der Server hat keine Verknüpfung zurückgegeben.');

    if (self.edges.some((edge) => edge.id === record.id)) {
      ctx.toast('Diese Verknüpfung gibt es bereits.', 'info');
      return;
    }
    // Insert locally so the line appears immediately; the next reload replaces
    // this with the server's own record.
    self.edges.push({
      id: record.id,
      from: record.data.from,
      to: record.data.to,
      kind: record.data.kind,
      source: record.data.source || 'manual',
      weight: Number.isFinite(record.data.weight) ? record.data.weight : 1,
      reason: record.data.reason || '',
    });
    for (const node of [source, target]) {
      if (!node) continue;
      node.degree = (node.degree || 0) + 1;
      node.totalDegree = (node.totalDegree || 0) + 1;
    }
    self.manualIds.add(from);
    self.manualIds.add(to);
    self.graph.setData({ nodes: self.nodes, edges: self.edges });
    applyFilter(self);
    self.graph.setSelection(self.selectedId);
    ctx.toast(`Verknüpft: ${source ? source.label : from} → ${target ? target.label : to}`, 'success');
    if (self.selectedId === from || self.selectedId === to) loadInspector(self, self.selectedId);
    renderToolbar(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    ctx.toast(err && err.message ? err.message : 'Die Verknüpfung konnte nicht angelegt werden.', 'error');
  }
}

async function removeEdge(self, edge, label) {
  const { ctx } = self;
  const data = edge.data || {};
  const confirmed = await ctx.confirm({
    title: 'Verknüpfung löschen?',
    message: `Die Verbindung „${kindLabel(data.kind)} ${label}“ (${sourceLabel(data.source)}) wird entfernt. `
      + 'Abgeleitete Verknüpfungen können beim nächsten Neuberechnen wieder entstehen.',
    confirmLabel: 'Löschen',
    danger: true,
  });
  if (!confirmed || !self.alive) return;

  try {
    await request(self, (signal) => ctx.api.del(`/edges/${encodeURIComponent(edge.id)}`, { signal }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    ctx.toast(err && err.message ? err.message : 'Die Verknüpfung konnte nicht gelöscht werden.', 'error');
    return;
  }
  if (!self.alive) return;

  self.edges = self.edges.filter((item) => item.id !== edge.id);
  if (self.inspector) self.inspector.edges = self.inspector.edges.filter((item) => item.id !== edge.id);
  for (const id of [data.from, data.to]) {
    const node = self.nodeById.get(id);
    if (!node) continue;
    node.degree = Math.max(0, (node.degree || 0) - 1);
    node.totalDegree = Math.max(0, (node.totalDegree || 0) - 1);
  }
  self.manualIds = new Set();
  for (const item of self.edges) {
    if (item.source !== 'manual') continue;
    self.manualIds.add(item.from);
    self.manualIds.add(item.to);
  }
  self.graph.setData({ nodes: self.nodes, edges: self.edges });
  applyFilter(self);
  self.graph.setSelection(self.selectedId);
  renderSide(self);
  renderToolbar(self);
  ctx.toast('Verknüpfung gelöscht.', 'success');
}

async function rescan(self) {
  const { ctx } = self;
  self.loading = true;
  renderToolbar(self);
  try {
    const result = await request(self, (signal) => ctx.api.post('/graph/rescan', null, { signal, timeoutMs: 120000 }));
    if (!self.alive) return;
    const created = Number.isFinite(result && result.created) ? result.created : 0;
    const removed = Number.isFinite(result && result.removed) ? result.removed : 0;
    const scanned = Number.isFinite(result && result.scanned) ? result.scanned : 0;
    ctx.toast(
      `${formatNumber(scanned)} Einträge geprüft: ${formatNumber(created)} neu verknüpft, ${formatNumber(removed)} entfernt.`,
      'success',
    );
    await load(self, { fit: false });
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.loading = false;
    renderToolbar(self);
    ctx.toast(err && err.message ? err.message : 'Die Verknüpfungen konnten nicht neu berechnet werden.', 'error');
  }
}

async function addToChat(self, node) {
  const { ctx } = self;
  const activeId = ctx.state && typeof ctx.state.get === 'function' ? ctx.state.get('activeChatId') : null;
  try {
    let chatId = activeId || null;
    let existing = [];
    if (chatId) {
      try {
        const payload = await request(self, (signal) => ctx.api.get(`/chats/${encodeURIComponent(chatId)}`, { signal }));
        const record = payload && payload.record;
        existing = Array.isArray(record && record.data && record.data.contextNodeIds) ? record.data.contextNodeIds : [];
      } catch (err) {
        // The remembered chat may be gone; fall through to creating one.
        if (err && err.status !== 404) throw err;
        chatId = null;
      }
    }
    if (!self.alive) return;

    if (!chatId) {
      const created = await request(self, (signal) => ctx.api.post('/chats', {
        title: `Kontext: ${node.label}`,
        contextNodeIds: [node.id],
      }, { signal }));
      const record = created && created.record;
      if (!record || !record.id) throw new Error('Der Chat konnte nicht angelegt werden.');
      if (!self.alive) return;
      ctx.toast('Neuer Chat mit diesem Knoten als Kontext angelegt.', 'success');
      ctx.navigate(`#/chat?id=${encodeURIComponent(record.id)}`);
      return;
    }

    if (existing.includes(node.id)) {
      ctx.toast('Dieser Knoten ist im aktuellen Chat bereits als Kontext gesetzt.', 'info');
      return;
    }
    await request(self, (signal) => ctx.api.patch(`/chats/${encodeURIComponent(chatId)}`, {
      contextNodeIds: [...existing, node.id],
    }, { signal }));
    if (!self.alive) return;
    ctx.toast(`„${node.label}“ ist jetzt Kontext im aktuellen Chat.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    ctx.toast(err && err.message ? err.message : 'Der Knoten konnte nicht an den Chat gehängt werden.', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Clusters                                                            */
/* ------------------------------------------------------------------ */

function rebuildClusters(self) {
  const nodes = visibleNodes(self);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = visibleEdges(self, ids);
  self.clusters = computeClusters(nodes, edges);

  const map = new Map();
  for (const [i, cluster] of self.clusters.entries()) {
    for (const id of cluster.nodeIds) map.set(id, i);
  }
  self.graph.setClusters(map);
}

function renderClusterPanel(self) {
  const palette = self.graph.getPalette();
  const css = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

  const wrap = h('div.stack', null,
    h('div.graph-view__side-head', null,
      h('h2.graph-view__side-title', { style: { flex: '1 1 auto' } }, text(`Cluster (${formatNumber(self.clusters.length)})`)),
      h('button.icon-button', {
        type: 'button',
        title: 'Cluster-Ansicht schließen',
        'aria-label': 'Cluster-Ansicht schließen',
        onClick: () => {
          self.clusterMode = false;
          self.clusters = [];
          self.activeCluster = null;
          self.graph.setClusters(null);
          self.graph.highlight(self.query ? self.matches.map((node) => node.id) : null);
          renderToolbar(self);
          renderSide(self);
        },
      }, icon(ICONS.close))),
    h('p.graph-view__hint', null, text('Zusammenhängende Gruppen im aktuellen Ausschnitt. Der Name kommt aus den Inhalten der Gruppe, er ist nicht erfunden.')));

  if (!self.clusters.length) {
    wrap.appendChild(h('p.graph-view__hint', null, text('Nichts zu gruppieren – der Ausschnitt ist leer.')));
    return wrap;
  }

  for (const [i, cluster] of self.clusters.entries()) {
    const color = palette.clusters[i % palette.clusters.length];
    wrap.appendChild(h('button.graph-view__cluster', {
      type: 'button',
      class: self.activeCluster === cluster.id ? 'is-active' : '',
      onClick: () => {
        self.activeCluster = cluster.id;
        self.graph.highlight(cluster.nodeIds);
        self.graph.fitToView({ ids: cluster.nodeIds });
        renderSide(self);
      },
    },
    h('span.graph-view__cluster-dot', { style: { background: css(color) } }),
    h('span', { style: { flex: '1 1 auto', minWidth: '0' } },
      h('span', null, text(cluster.label)),
      h('small.meta', { style: { display: 'block' } }, text(
        `${formatNumber(cluster.size)} Knoten · ${formatNumber(cluster.edges)} Verknüpfungen · `
        + cluster.types.slice(0, 3).map(([type, count]) => `${count} ${TYPE_PLURALS[type] || type}`).join(', '),
      )))));
  }
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

function openContextMenu(self, node, position) {
  const { dom } = self;
  closeContextMenu(self);

  const item = (label, run) => h('button.graph-view__match', {
    type: 'button',
    onClick: () => {
      closeContextMenu(self);
      run();
    },
  }, text(label));

  const rect = dom.stage.getBoundingClientRect();
  const menu = h('div.graph-view__float', {
    role: 'menu',
    style: {
      left: `${Math.min(Math.max(position.clientX - rect.left, 8), Math.max(rect.width - 220, 8))}px`,
      top: `${Math.min(Math.max(position.clientY - rect.top, 8), Math.max(rect.height - 180, 8))}px`,
      width: '13rem',
      zIndex: '5',
    },
  },
  h('p.meta', { style: { padding: '0 8px 4px', margin: '0' } }, text(node.label)),
  item('Fokussieren', () => setFocus(self, node.id)),
  item('Nachbarn hervorheben', () => {
    const ids = self.graph.neighbours(node.id).map((other) => other.id);
    self.graph.highlight([node.id, ...ids]);
  }),
  self.graph.isPinned(node.id)
    ? item('Fixierung lösen', () => {
      self.graph.unpin(node.id);
      renderSide(self);
    })
    : null,
  OPEN_ROUTES[node.type] ? item('Öffnen', () => self.ctx.navigate(OPEN_ROUTES[node.type](node.id))) : null,
  item('Zu Chat hinzufügen', () => addToChat(self, node)));

  dom.stage.appendChild(menu);
  self.contextMenu = menu;
  const close = () => closeContextMenu(self);
  // Dismiss on the next pointer press anywhere else. Presses inside the menu
  // are ignored, because removing the node on `pointerdown` would detach the
  // button before its own `click` could ever fire.
  const offDown = on(window, 'pointerdown', (event) => {
    if (menu.contains(event.target)) return;
    close();
  }, { capture: true });
  const offKey = on(window, 'keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  self.contextCleanups = [offDown, offKey];
}

function closeContextMenu(self) {
  if (self.contextMenu && self.contextMenu.parentNode) self.contextMenu.parentNode.removeChild(self.contextMenu);
  self.contextMenu = null;
  if (self.contextCleanups) {
    for (const off of self.contextCleanups) {
      try {
        off();
      } catch { /* already gone */ }
    }
    self.contextCleanups = null;
  }
}
