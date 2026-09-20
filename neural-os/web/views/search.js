/**
 * views/search.js -- one search field over everything in the vault.
 *
 * The decisions behind it
 * -----------------------
 * 1. **Hits are marked, not interpolated.** The search index wraps matches in
 *    the control characters \\u0001/\\u0002 instead of HTML, precisely so this
 *    layer can turn them into real `<mark>` nodes. `snippet()` from dom.js
 *    builds those nodes; no string in this view ever reaches `innerHTML`, so a
 *    note whose title contains angle brackets is a note, not an injection.
 * 2. **The address bar follows the query without remounting the view.** The
 *    shell re-renders on `hashchange`, so navigating on every keystroke would
 *    tear down the field the user is typing in. `history.replaceState` keeps
 *    `#/search?q=…` shareable and the input alive.
 * 3. **Full keyboard control.** Arrow keys walk the results from inside the
 *    input, Enter opens, `g` (or Alt+Enter) jumps into the graph, Escape
 *    clears. Nothing here needs a mouse.
 * 4. **Grouping tells the truth about the ranking.** Results are grouped by
 *    type for scanning, but each group keeps the index's own order, and the
 *    keyboard walks the groups in the order they are shown -- so the first hit
 *    the keyboard reaches is the best hit of the best-scoring group.
 * 5. **An empty result is an answer.** It names the query, repeats the
 *    operators the index understands and offers to widen the type filter,
 *    instead of leaving a blank page that looks broken.
 */

import {
  h, text, clear, on, icon, snippet, timeAgo, formatNumber, debounce,
} from '../lib/dom.js';

const STYLE_ID = 'nos-search-view-style';

const VIEW_ICON = '<circle cx="8.8" cy="8.8" r="5.2"/><path d="m12.7 12.7 4 4"/>';

const ICONS = {
  search: '<circle cx="8.8" cy="8.8" r="5.2"/><path d="m12.7 12.7 4 4"/>',
  graph: '<circle cx="4.6" cy="14.4" r="1.9"/><circle cx="10" cy="4.4" r="1.9"/><circle cx="15.4" cy="12.8" r="1.9"/><path d="M5.6 12.7 9 6.1M11.3 5.9l3.2 5.2M6.4 14.8l7.1-1.5"/>',
  arrow: '<path d="M3.8 10h11.4M11 5.8l4.2 4.2-4.2 4.2"/>',
};

/** Types the index can hold, in the order the groups are shown when tied. */
const TYPES = [
  { value: 'note', label: 'Notizen' },
  { value: 'chat', label: 'Chats' },
  { value: 'message', label: 'Nachrichten' },
  { value: 'project', label: 'Projekte' },
  { value: 'task', label: 'Aufgaben' },
  { value: 'entity', label: 'Begriffe' },
  { value: 'file', label: 'Dateien' },
  { value: 'agent', label: 'Agenten' },
  { value: 'run', label: 'Läufe' },
  { value: 'memory', label: 'Erinnerungen' },
];

const TYPE_LABEL = Object.fromEntries(TYPES.map((entry) => [entry.value, entry.label]));

const SINGULAR = {
  note: 'Notiz', chat: 'Chat', message: 'Nachricht', project: 'Projekt',
  task: 'Aufgabe', entity: 'Begriff', file: 'Datei', agent: 'Agent',
  run: 'Lauf', memory: 'Erinnerung', edge: 'Verknüpfung',
};

const DEBOUNCE_MS = 180;
const LIMIT = 60;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

function dataOf(record) {
  return (record && record.data) || {};
}

/** A display title for any record type, never an empty string. */
function labelOf(record) {
  const data = dataOf(record);
  const candidate = data.title || data.name || data.goal || data.label
    || (typeof data.text === 'string' ? data.text.slice(0, 80) : '')
    || (typeof data.content === 'string' ? data.content.slice(0, 80) : '');
  const value = String(candidate || '').trim();
  if (value) return value;
  return `${SINGULAR[record.type] || record.type} ${record.id}`;
}

/** Where a record lives in this application. */
function targetFor(record) {
  const id = encodeURIComponent(record.id);
  switch (record.type) {
    case 'note': return `#/notes?id=${id}`;
    case 'chat': return `#/chat?id=${id}`;
    case 'message': {
      const chatId = dataOf(record).chatId;
      return chatId ? `#/chat?id=${encodeURIComponent(chatId)}` : `#/graph?focus=${id}`;
    }
    case 'project':
    case 'task': return `#/projects?id=${id}`;
    case 'agent':
    case 'run': return `#/agents?id=${id}`;
    default: return `#/graph?focus=${id}`;
  }
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'search',
  title: 'Suche',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyle();
    teardown();

    const params = (ctx.route && ctx.route.params) || {};
    const initialQuery = typeof params.q === 'string' ? params.q : '';
    const initialTypes = typeof params.types === 'string' && params.types
      ? params.types.split(',').map((t) => t.trim()).filter((t) => TYPE_LABEL[t])
      : [];

    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      container,
      cleanups: [],
      requests: new Set(),
      dom: {},

      query: initialQuery,
      types: new Set(initialTypes),
      loading: false,
      error: null,
      total: 0,
      hits: [],          // [{record, score, snippet}]
      groups: [],        // [{type, label, hits}]
      flat: [],          // hits in keyboard order
      cursor: -1,
      searchSeq: 0,
    };
    view = self;

    buildLayout(self);
    subscribe(self);

    if (self.query) {
      self.dom.input.value = self.query;
      await runSearch(self, self.query);
    } else {
      renderResults(self);
    }
    if (!self.alive) return;
    self.dom.input.focus();
    self.dom.input.select();
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
  if (self.searchSoon) self.searchSoon.cancel();
  for (const controller of self.requests) {
    try { controller.abort(); } catch { /* already done */ }
  }
  self.requests.clear();
  for (const off of self.cleanups) {
    try { off(); } catch { /* listener already gone */ }
  }
  self.cleanups.length = 0;
}

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.input = h('input.searchv__input', {
    type: 'search',
    placeholder: 'Alles durchsuchen …',
    'aria-label': 'Volltextsuche über alle Einträge',
    autocomplete: 'off',
    spellcheck: 'false',
    onInput: () => {
      self.query = dom.input.value;
      self.cursor = -1;
      self.searchSoon(self.query);
    },
    onKeyDown: (event) => onInputKey(self, event),
  });

  dom.count = h('span.searchv__count.meta', { role: 'status' });
  dom.filters = h('div.searchv__filters', { role: 'group', 'aria-label': 'Nach Art filtern' });
  dom.results = h('div.searchv__results');

  dom.root = h('div.searchv', null,
    h('div.searchv__head', null,
      h('div.searchv__field', null,
        h('span.searchv__icon', { 'aria-hidden': 'true' }, icon(ICONS.search)),
        dom.input,
        dom.count),
      dom.filters,
      h('p.searchv__ops.hint', null, text('Operatoren: tag:reise · type:note · "wörtliche Wendung". Mit ↑ ↓ durch die Treffer, Eingabe öffnet, G zeigt im Gehirn.'))),
    dom.results);

  container.appendChild(dom.root);

  self.searchSoon = debounce((value) => {
    if (!self.alive) return;
    runSearch(self, value);
  }, DEBOUNCE_MS);

  renderFilters(self);

  // Results are reachable from anywhere in the view, not just the input.
  self.cleanups.push(on(dom.root, 'keydown', (event) => onViewKey(self, event)));
}

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;
  const again = debounce(() => {
    if (!self.alive || !self.query.trim()) return;
    runSearch(self, self.query, { quiet: true });
  }, 1500);
  for (const name of ['record.created', 'record.updated', 'record.deleted']) {
    self.cleanups.push(ctx.bus.on(name, () => again()));
  }
}

/* ------------------------------------------------------------------ */
/* Searching                                                           */
/* ------------------------------------------------------------------ */

async function runSearch(self, rawQuery, opts = {}) {
  const query = String(rawQuery || '').trim();
  syncAddress(self, query);

  if (!query) {
    self.hits = [];
    self.groups = [];
    self.flat = [];
    self.total = 0;
    self.error = null;
    self.loading = false;
    renderResults(self);
    return;
  }

  const token = ++self.searchSeq;
  if (!opts.quiet) {
    self.loading = true;
    renderResults(self);
  }

  const queryParams = { q: query, limit: LIMIT };
  if (self.types.size) queryParams.types = [...self.types].join(',');

  try {
    const result = await request(self, (signal) => self.api.get('/search', { query: queryParams, signal }));
    if (!self.alive || token !== self.searchSeq) return;
    const items = Array.isArray(result && result.items) ? result.items : [];
    self.hits = items.filter((hit) => hit && hit.record && hit.record.id);
    self.total = Number.isFinite(result && result.total) ? result.total : self.hits.length;
    self.error = null;
    regroup(self);
  } catch (err) {
    if (!self.alive || token !== self.searchSeq || (err && err.isAborted)) return;
    self.hits = [];
    self.groups = [];
    self.flat = [];
    self.total = 0;
    self.error = err;
  } finally {
    if (self.alive && token === self.searchSeq) {
      self.loading = false;
      renderResults(self);
    }
  }
}

/**
 * Group by type while keeping the index's ranking: groups are ordered by
 * their best hit, and inside a group the order is untouched.
 */
function regroup(self) {
  const byType = new Map();
  for (const hit of self.hits) {
    const type = hit.record.type || 'unknown';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(hit);
  }
  const groups = [...byType.entries()].map(([type, hits]) => ({
    type,
    label: TYPE_LABEL[type] || SINGULAR[type] || type,
    hits,
    best: hits.reduce((max, hit) => Math.max(max, Number(hit.score) || 0), 0),
  }));
  groups.sort((a, b) => b.best - a.best);
  self.groups = groups;
  self.flat = groups.flatMap((group) => group.hits);
  if (self.cursor >= self.flat.length) self.cursor = self.flat.length - 1;
}

/** Keep the address shareable without triggering the shell's router. */
function syncAddress(self, query) {
  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (self.types.size) params.set('types', [...self.types].join(','));
    const suffix = params.toString();
    const next = `#/search${suffix ? `?${suffix}` : ''}`;
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
  } catch {
    /* a browser that refuses replaceState still searches fine */
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderFilters(self) {
  const box = self.dom.filters;
  clear(box);

  const all = h('button.searchv__chip', {
    type: 'button',
    'aria-pressed': self.types.size === 0 ? 'true' : 'false',
    onClick: () => {
      self.types.clear();
      renderFilters(self);
      runSearch(self, self.query);
    },
  }, text('Alles'));
  all.classList.toggle('is-active', self.types.size === 0);
  box.appendChild(all);

  for (const entry of TYPES) {
    const active = self.types.has(entry.value);
    const chip = h('button.searchv__chip', {
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      onClick: () => {
        if (self.types.has(entry.value)) self.types.delete(entry.value);
        else self.types.add(entry.value);
        renderFilters(self);
        runSearch(self, self.query);
      },
    }, text(entry.label));
    chip.classList.toggle('is-active', active);
    box.appendChild(chip);
  }
}

function renderResults(self) {
  const { dom } = self;
  clear(dom.results);
  clear(dom.count);

  if (self.loading) {
    dom.count.appendChild(text('sucht …'));
  } else if (self.error) {
    // "0 Treffer" after a failed request would claim knowledge we do not have.
    dom.count.appendChild(text('nicht ermittelbar'));
  } else if (self.query.trim()) {
    dom.count.appendChild(text(self.total === 1 ? '1 Treffer' : `${formatNumber(self.total)} Treffer`));
  }

  if (self.error) {
    dom.results.appendChild(h('div.searchv__state.is-danger', { role: 'alert' },
      h('p', null, text(`Die Suche ist fehlgeschlagen: ${errorMessage(self.error)}`)),
      h('button.btn.btn--small', { type: 'button', onClick: () => runSearch(self, self.query) }, text('Erneut versuchen'))));
    return;
  }

  if (!self.query.trim()) {
    dom.results.appendChild(h('div.searchv__state', null,
      h('h2', null, text('Was suchst du?')),
      h('p', null, text('Die Suche liest Titel, Texte, Schlagworte und Chatverläufe – alles bleibt dabei auf diesem Gerät.')),
      h('ul.searchv__tips', null,
        h('li', null, text('tag:reise findet alles mit diesem Schlagwort.')),
        h('li', null, text('type:note beschränkt auf Notizen – oder nutze die Filter oben.')),
        h('li', null, text('"genau diese Wendung" sucht die wörtliche Folge.')))));
    return;
  }

  if (self.loading && !self.hits.length) {
    dom.results.appendChild(h('div.searchv__state', { role: 'status' },
      h('span.spinner', { 'aria-hidden': 'true' }),
      h('p', null, text('Der Index wird durchsucht …'))));
    return;
  }

  if (!self.hits.length) {
    dom.results.appendChild(h('div.searchv__state', null,
      h('h2', null, text('Nichts gefunden')),
      h('p', null, text(`Für „${self.query.trim()}“ gibt es keinen Treffer${self.types.size ? ' in den gewählten Arten' : ''}.`)),
      self.types.size
        ? h('button.btn.btn--small', {
          type: 'button',
          onClick: () => {
            self.types.clear();
            renderFilters(self);
            runSearch(self, self.query);
          },
        }, text('In allen Arten suchen'))
        : null,
      h('p.hint', null, text('Die Suche findet auch Wortanfänge und behandelt Umlaute wie ihre Umschrift (ä wie ae). Sehr kurze Wörter unter zwei Zeichen werden nicht indiziert.'))));
    return;
  }

  let index = 0;
  for (const group of self.groups) {
    const section = h('section.searchv__group', { 'aria-label': group.label });
    section.appendChild(h('h2.searchv__group-title', null,
      text(group.label),
      h('span.meta', null, text(` ${formatNumber(group.hits.length)}`))));

    const listNode = h('ul.searchv__list', { role: 'list' });
    for (const hit of group.hits) {
      listNode.appendChild(renderHit(self, hit, index));
      index += 1;
    }
    section.appendChild(listNode);
    self.dom.results.appendChild(section);
  }

  if (self.total > self.hits.length) {
    self.dom.results.appendChild(h('p.searchv__more.meta', null,
      text(`Es werden die besten ${formatNumber(self.hits.length)} von ${formatNumber(self.total)} Treffern gezeigt. Grenze die Suche ein, um die übrigen zu sehen.`)));
  }
}

function renderHit(self, hit, index) {
  const record = hit.record;
  const data = dataOf(record);
  const tags = Array.isArray(data.tags) ? data.tags : [];

  const open = () => openHit(self, hit);

  const row = h('li.searchv__hit', null,
    h('button.searchv__hit-main', {
      type: 'button',
      onClick: open,
      onFocus: () => {
        self.cursor = index;
        markCursor(self);
      },
    },
    h('span.searchv__hit-title', null, text(labelOf(record))),
    hit.snippet
      ? h('span.searchv__hit-snippet', null, snippet(hit.snippet))
      : h('span.searchv__hit-snippet.meta', null, text('Kein Textausschnitt vorhanden.')),
    h('span.searchv__hit-meta', null,
      h('span.badge', null, text(SINGULAR[record.type] || record.type)),
      ...tags.slice(0, 4).map((tag) => h('span.tag', null, text(`#${tag}`))),
      h('span.meta', null, text(record.updatedAt ? `geändert ${timeAgo(record.updatedAt)}` : '')),
      Number.isFinite(hit.score) ? h('span.meta', null, text(`Treffergüte ${hit.score.toFixed(2)}`)) : null)),
    h('div.searchv__hit-actions', null,
      h('button.btn.btn--small', {
        type: 'button',
        title: 'Eintrag öffnen',
        onClick: open,
      }, icon(ICONS.arrow), text('Öffnen')),
      h('button.btn.btn--small', {
        type: 'button',
        title: 'Diesen Eintrag im Wissensgraphen zeigen',
        onClick: () => self.ctx.navigate(`#/graph?focus=${encodeURIComponent(record.id)}`),
      }, icon(ICONS.graph), text('Im Gehirn zeigen'))));

  row.dataset.index = String(index);
  if (index === self.cursor) row.classList.add('is-cursor');
  return row;
}

function markCursor(self) {
  const rows = self.dom.results.querySelectorAll('.searchv__hit');
  rows.forEach((row) => {
    row.classList.toggle('is-cursor', Number(row.dataset.index) === self.cursor);
  });
}

function openHit(self, hit) {
  if (!hit || !hit.record) return;
  self.ctx.navigate(targetFor(hit.record));
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function moveCursor(self, delta) {
  if (!self.flat.length) return;
  const next = self.cursor + delta;
  self.cursor = Math.min(self.flat.length - 1, Math.max(0, next));
  markCursor(self);
  const row = self.dom.results.querySelector(`.searchv__hit[data-index="${self.cursor}"]`);
  if (row) {
    const button = row.querySelector('.searchv__hit-main');
    if (button) button.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  }
}

function onInputKey(self, event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (self.cursor < 0) self.cursor = -1;
    moveCursor(self, 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveCursor(self, -1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    self.searchSoon.cancel();
    if (self.cursor >= 0 && self.flat[self.cursor]) openHit(self, self.flat[self.cursor]);
    else runSearch(self, self.dom.input.value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (self.dom.input.value) {
      self.dom.input.value = '';
      self.query = '';
      self.searchSoon.cancel();
      runSearch(self, '');
    }
  }
}

function onViewKey(self, event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
  const target = event.target;
  const inInput = target === self.dom.input;

  if (event.key === 'ArrowDown' && !inInput) {
    event.preventDefault();
    moveCursor(self, 1);
  } else if (event.key === 'ArrowUp' && !inInput) {
    event.preventDefault();
    if (self.cursor <= 0) {
      self.cursor = -1;
      markCursor(self);
      self.dom.input.focus();
      return;
    }
    moveCursor(self, -1);
  } else if (event.key === 'Enter' && !inInput) {
    const hit = self.flat[self.cursor];
    if (!hit) return;
    event.preventDefault();
    if (event.altKey) self.ctx.navigate(`#/graph?focus=${encodeURIComponent(hit.record.id)}`);
    else openHit(self, hit);
  } else if ((event.key === 'g' || event.key === 'G') && !inInput) {
    const hit = self.flat[self.cursor];
    if (!hit) return;
    event.preventDefault();
    self.ctx.navigate(`#/graph?focus=${encodeURIComponent(hit.record.id)}`);
  } else if (event.key === 'Escape' && !inInput) {
    event.preventDefault();
    self.cursor = -1;
    markCursor(self);
    self.dom.input.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const CSS = `
.searchv { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.searchv__head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.searchv__field {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-3);
}
.searchv__field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.searchv__icon { display: inline-flex; color: var(--fg-subtle); }
.searchv__input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-lg);
  background: none;
  border: 0;
  color: inherit;
}
.searchv__input:focus { outline: none; }
.searchv__count { white-space: nowrap; }
.searchv__filters { display: flex; flex-wrap: wrap; gap: 6px; }
.searchv__chip {
  padding: 3px 10px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-full);
  cursor: pointer;
}
.searchv__chip:hover { background: var(--surface-3); }
.searchv__chip.is-active { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.searchv__ops { margin: 0; }

.searchv__results { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-2) var(--sp-3) var(--sp-8); }
.searchv__group + .searchv__group { margin-top: var(--sp-3); }
.searchv__group-title { font-size: var(--fs-md); margin: 0 0 var(--sp-1); }
.searchv__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.searchv__hit {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  border-bottom: 1px solid var(--border);
  border-radius: var(--r-2);
}
.searchv__hit:hover { background: var(--surface-2); }
.searchv__hit.is-cursor { background: var(--accent-soft); }
.searchv__hit-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
  padding: var(--sp-1);
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.searchv__hit-main:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--r-2); }
.searchv__hit-title { font-weight: 500; }
.searchv__hit-snippet {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  white-space: pre-wrap;
}
.searchv__hit-snippet mark { padding: 0 1px; color: inherit; background: var(--accent-soft); border-radius: 2px; }
.searchv__hit-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.searchv__hit-actions { display: flex; flex-wrap: wrap; gap: 4px; padding: var(--sp-1) var(--sp-1) var(--sp-1) 0; }

.searchv__state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
  max-width: 60ch;
  margin: var(--sp-4) auto;
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  background: var(--surface);
}
.searchv__state h2 { font-size: var(--fs-lg); }
.searchv__state p { margin: 0; color: var(--fg-muted); }
.searchv__tips { margin: 0; padding-left: var(--sp-3); color: var(--fg-muted); font-size: var(--fs-sm); }
.searchv__more { margin: var(--sp-2) 0 0; }

@media (max-width: 820px) {
  .searchv__head { padding: var(--sp-2); }
  .searchv__results { padding: var(--sp-1) var(--sp-2) var(--sp-6); }
  .searchv__hit { flex-direction: column; }
  .searchv__hit-actions { padding: 0 var(--sp-1) var(--sp-1); }
}
`;
