/**
 * views/timeline.js -- "Zeitachse": the knowledge brain seen along time.
 *
 * The graph answers "what belongs together?". This view answers the other
 * half of the same question: "when did this happen, and what happened around
 * it?". It reads the same records and paints them with the same colours, so
 * that moving between the two screens feels like turning one object around
 * rather than opening a second application.
 *
 * Decisions worth explaining
 * --------------------------
 * 1. **Bundling per pixel column, not per record.** The canvas never draws
 *    one mark per record. Every repaint sorts the visible records into bins
 *    four pixels wide and draws at most a handful of dots per bin and lane.
 *    The work per frame is therefore bounded by the width of the canvas, not
 *    by the size of the vault -- which is the only way this stays smooth at
 *    five thousand points, and the reason panning stays smooth at fifty
 *    thousand too. What a bin cannot draw it still counts: the density band
 *    behind the lanes and the hover read-out report the true number, so the
 *    picture never understates the vault.
 * 2. **One lane per type.** A single scatter with eight colours is pretty and
 *    unreadable. Lanes make "in May I only wrote notes, in June I ran agents"
 *    visible at a glance, and they give the type filter above a direct visual
 *    meaning instead of making it a guessing game.
 * 3. **The colours come from the stylesheet.** They are read from the
 *    `--graph-<type>` custom properties on the canvas, exactly as
 *    `lib/graph-canvas.js` reads them, and re-read whenever the theme
 *    changes. A hard-coded hex value would be right in one theme and wrong in
 *    the other; the fallback table below only exists for an installation that
 *    ships no such tokens, and it is the same table the renderer falls back
 *    to, so both screens stay in step.
 * 4. **Time is read from the record, never from the clock.** Points sit at
 *    `createdAt` (or `updatedAt`, switchable). Nothing is estimated, nothing
 *    is smoothed, and a vault with a single record gets a window around that
 *    record rather than a fabricated range.
 * 5. **The inspector is the graph's inspector.** Same shape, same wording,
 *    same links with their reason and provenance, read from the same
 *    `/api/records/:id`. Two different answers to "what is this?" in one
 *    application would be one answer too many.
 * 6. **Loading is honest about its own limits.** Records are paged per type
 *    with a cap. When the cap bites, the view says how many of how many it is
 *    showing instead of quietly drawing an incomplete history as if it were
 *    the whole one.
 */

import {
  h, text, clear, on, icon, timeAgo, formatDate, formatDateTime, formatNumber, debounce,
} from '../lib/dom.js';
// Dieselbe Zeichenfunktion wie im Gehirn. Zwei Ansichten, die dieselben
// Satzarten zeigen, muessen dieselbe Sprache sprechen -- eine Raute muss
// hier und dort eine Aufgabe sein, sonst muss man zweimal lernen.
import { GRAPH_TYPES, drawNodeShape } from '../lib/graph-canvas.js';

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

/**
 * Where a record can actually be opened. Mirrors the table in `views/graph.js`
 * on purpose: it is that view's private constant, and a shared copy in the
 * design system would tie two independent screens together for six lines.
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

/**
 * Fallback palettes -- identical to the ones in `lib/graph-canvas.js`, which
 * keeps them module-private. They are only reached when the stylesheet
 * defines no `--graph-*` tokens; the tokens, when present, win in both files.
 */

const VIEW_ICON = '<path d="M2.5 10h15"/><circle cx="6" cy="10" r="1.9"/><circle cx="11.4" cy="10" r="1.9"/>'
  + '<circle cx="16" cy="10" r="1.4"/><path d="M6 5.4v2.7M11.4 11.9v2.7"/>';

const ICONS = {
  search: '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 4 4"/>',
  close: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  refresh: '<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16.2 3.4v3.2H13"/>',
  brain: '<circle cx="10" cy="4.6" r="2.1"/><circle cx="4.6" cy="14.4" r="2.1"/><circle cx="15.4" cy="14.4" r="2.1"/>'
    + '<path d="M8.5 6.3 5.8 12.4M11.5 6.3l2.7 6.1M6.7 14.4h6.6"/>',
  open: '<path d="M11.5 4.5h4v4M15.5 4.5 9 11"/>'
    + '<path d="M14 11.8v3.1a1.4 1.4 0 0 1-1.4 1.4H5.1a1.4 1.4 0 0 1-1.4-1.4V7.4A1.4 1.4 0 0 1 5.1 6h3.1"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  minus: '<path d="M4.2 10h11.6"/>',
  fit: '<path d="M3.6 7.4V4.6a1 1 0 0 1 1-1h2.8M12.6 3.6h2.8a1 1 0 0 1 1 1v2.8'
    + 'M16.4 12.6v2.8a1 1 0 0 1-1 1h-2.8M7.4 16.4H4.6a1 1 0 0 1-1-1v-2.8"/>',
  arrowRight: '<path d="M4 10h11M11 6l4 4-4 4"/>',
  arrowLeft: '<path d="M16 10H5M9 6l-4 4 4 4"/>',
  undo: '<path d="M6.8 5.2 4 8l2.8 2.8"/><path d="M4 8h7.6a4.2 4.2 0 0 1 0 8.4H8.2"/>',
};

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The API caps a page at 1000; anything larger would be silently clipped. */
const PAGE_SIZE = 1000;
/** Per type and in total: a bound that keeps a huge vault from freezing the tab. */
const MAX_PER_TYPE = 5000;
const MAX_TOTAL = 20000;

const AXIS_H = 30;
const PLOT_PAD_BOTTOM = 12;
const GUTTER_W = 96;
const GUTTER_MIN_WIDTH = 560;
const BIN_PX = 4;
const DOT_R = 2.7;
const DOT_STEP = 7;
const CLICK_SLOP = 4;

const MIN_SPAN = 5 * MINUTE;
const MAX_SPAN = 120 * 365 * DAY;

const ZOOM_PRESETS = [
  { id: 'day', label: 'Tag', span: DAY },
  { id: 'week', label: 'Woche', span: 7 * DAY },
  { id: 'month', label: 'Monat', span: 30 * DAY },
  { id: 'year', label: 'Jahr', span: 365 * DAY },
];

/* ------------------------------------------------------------------ */
/* Time helpers                                                        */
/* ------------------------------------------------------------------ */

const FIXED_STEPS = [
  MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY,
];
const MONTH_STEPS = [1, 2, 3, 6];
const YEAR_STEPS = [1, 2, 5, 10, 20, 50, 100];

const formatterCache = new Map();

function formatWith(ts, opts) {
  const key = JSON.stringify(opts);
  let fmt = formatterCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('de-DE', opts);
    } catch {
      fmt = null;
    }
    formatterCache.set(key, fmt);
  }
  if (!fmt) return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  return fmt.format(new Date(ts));
}

function unitFor(step) {
  if (step < HOUR) return 'minute';
  if (step < DAY) return 'hour';
  if (step < 7 * DAY) return 'day';
  return 'week';
}

/**
 * Align upwards on a grid that follows the LOCAL clock. Aligning on plain
 * epoch multiples puts the "midnight" tick at 01:00 in half of Europe and at
 * 05:30 in India; the offset is re-read per step so a window that crosses a
 * daylight-saving boundary keeps its ticks on the hour.
 */
function alignUp(ts, step) {
  const offset = -new Date(ts).getTimezoneOffset() * MINUTE;
  return Math.ceil((ts + offset) / step) * step - offset;
}

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday-based, because that is what a German calendar shows. */
function startOfLocalWeek(ts) {
  const d = new Date(startOfLocalDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function chooseTickSpec(span, width) {
  const target = Math.max(2, Math.floor(width / 112));
  for (const step of FIXED_STEPS) {
    if (span / step <= target) return { kind: 'fixed', step, unit: unitFor(step) };
  }
  for (const months of MONTH_STEPS) {
    if (span / (months * 30.44 * DAY) <= target) return { kind: 'month', step: months, unit: 'month' };
  }
  for (const years of YEAR_STEPS) {
    if (span / (years * 365.25 * DAY) <= target) return { kind: 'year', step: years, unit: 'year' };
  }
  return { kind: 'year', step: 200, unit: 'year' };
}

function tickTimes(spec, start, end) {
  const out = [];
  const guard = 400; // a hand-edited window must not spin here
  if (spec.kind === 'fixed' && spec.step >= DAY) {
    const days = Math.round(spec.step / DAY);
    const d = new Date(days === 7 || days === 14 ? startOfLocalWeek(start) : startOfLocalDay(start));
    while (d.getTime() < start) d.setDate(d.getDate() + days);
    while (d.getTime() <= end && out.length < guard) {
      out.push(d.getTime());
      d.setDate(d.getDate() + days);
    }
    return out;
  }
  if (spec.kind === 'fixed') {
    let t = alignUp(start, spec.step);
    while (t <= end && out.length < guard) {
      out.push(t);
      t = alignUp(t + 1, spec.step);
    }
    return out;
  }
  if (spec.kind === 'month') {
    const d = new Date(start);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    while (d.getMonth() % spec.step !== 0) d.setMonth(d.getMonth() - 1);
    while (d.getTime() < start) d.setMonth(d.getMonth() + spec.step);
    while (d.getTime() <= end && out.length < guard) {
      out.push(d.getTime());
      d.setMonth(d.getMonth() + spec.step);
    }
    return out;
  }
  const d = new Date(start);
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  while (d.getFullYear() % spec.step !== 0) d.setFullYear(d.getFullYear() - 1);
  while (d.getTime() < start) d.setFullYear(d.getFullYear() + spec.step);
  while (d.getTime() <= end && out.length < guard) {
    out.push(d.getTime());
    d.setFullYear(d.getFullYear() + spec.step);
  }
  return out;
}

function tickLabel(ts, unit) {
  switch (unit) {
    case 'minute':
    case 'hour':
      return formatWith(ts, { hour: '2-digit', minute: '2-digit' });
    case 'day':
    case 'week':
      return formatWith(ts, { day: 'numeric', month: 'short' });
    case 'month':
      return formatWith(ts, { month: 'short', year: 'numeric' });
    default:
      return String(new Date(ts).getFullYear());
  }
}

/** A human range label for the header: "5. Mai 2026 – 12. Juni 2026". */
function rangeLabel(start, end) {
  const span = end - start;
  const opts = span < 2 * DAY
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' };
  return `${formatWith(start, opts)} – ${formatWith(end, opts)}`;
}

/** "3 Tage", "5 Std.", "2 Jahre" -- the length of the visible window. */
function spanLabel(span) {
  if (span < 2 * HOUR) return `${Math.max(1, Math.round(span / MINUTE))} Min.`;
  if (span < 2 * DAY) return `${Math.round(span / HOUR)} Std.`;
  if (span < 70 * DAY) return `${Math.round(span / DAY)} Tage`;
  if (span < 330 * DAY) return `${Math.round(span / (30.44 * DAY))} Monate`;
  const years = span / (365.25 * DAY);
  return `${years.toLocaleString('de-DE', { maximumFractionDigits: years < 10 ? 1 : 0 })} Jahre`;
}

/* ------------------------------------------------------------------ */
/* Record helpers                                                      */
/* ------------------------------------------------------------------ */

/** Fold for search: German umlauts the way a German reader types them. */
function fold(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.unknown;
}

function typePlural(type) {
  return TYPE_PLURALS[type] || TYPE_PLURALS.unknown;
}

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || 'verwandt mit';
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || 'abgeleitet';
}

function clip(value, max) {
  const s = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The display title of a record. Mirrors `src/graph/view.js#label`, because
 * the timeline reads raw records from `/api/records` rather than graph nodes
 * and both screens must name the same record the same way.
 */
function recordLabel(record) {
  if (!record || typeof record !== 'object') return 'Unbekannt';
  const d = record.data || {};
  const first = (...values) => {
    for (const v of values) if (typeof v === 'string' && v.trim()) return clip(v, 120);
    return '';
  };
  switch (record.type) {
    case 'note': return first(d.title) || 'Notiz ohne Titel';
    case 'chat': return first(d.title) || 'Chat ohne Titel';
    case 'project': return first(d.name) || 'Projekt ohne Namen';
    case 'task': return first(d.title) || 'Aufgabe ohne Titel';
    case 'agent': return first(d.name) || 'Agent ohne Namen';
    case 'file': return first(d.name) || 'Datei ohne Namen';
    case 'entity': return first(d.name) || 'Entität ohne Namen';
    case 'run': return first(d.goal) ? `Lauf: ${first(d.goal)}` : 'Lauf ohne Ziel';
    default: return first(d.title, d.name) || `${typeLabel(record.type)} ${String(record.id || '').slice(-6)}`;
  }
}

const BODY_FIELDS = ['body', 'description', 'text', 'content', 'goal', 'result', 'summary'];

function recordSnippet(record) {
  const d = (record && record.data) || {};
  for (const field of BODY_FIELDS) {
    if (typeof d[field] === 'string' && d[field].trim()) return clip(d[field], 220);
  }
  return '';
}

function recordTags(record) {
  const tags = (record && record.data && record.data.tags) || [];
  return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
}

/** One point on the axis. `at` is resolved lazily so the axis can be switched. */
function toPoint(record) {
  const created = Date.parse(record.createdAt);
  const updated = Date.parse(record.updatedAt);
  const label = recordLabel(record);
  const snippet = recordSnippet(record);
  const tags = recordTags(record);
  return {
    id: record.id,
    type: record.type,
    label,
    snippet,
    tags,
    created: Number.isFinite(created) ? created : null,
    updated: Number.isFinite(updated) ? updated : (Number.isFinite(created) ? created : null),
    haystack: fold(`${label} ${snippet} ${tags.join(' ')}`),
  };
}

function atOf(point, axis) {
  return axis === 'updated' ? point.updated : point.created;
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'timeline',
  title: 'Zeitachse',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyle();
    teardown(); // defensive: a failed unmount must not leak a canvas

    const params = (ctx.route && ctx.route.params) || {};

    const self = {
      alive: true,
      ctx,
      container,
      cleanups: [],
      requests: new Set(),
      dom: {},

      // data
      points: [],
      totals: new Map(), // type -> how many the server says exist
      loaded: new Map(), // type -> how many we hold
      loading: true,
      loadError: null,
      truncated: false,

      // presentation
      axis: params.axis === 'updated' ? 'updated' : 'created',
      activeTypes: new Set(GRAPH_TYPES),
      query: typeof params.q === 'string' ? params.q : '',
      folded: fold(typeof params.q === 'string' ? params.q : ''),

      // viewport (ms)
      viewStart: Date.now() - 30 * DAY,
      viewEnd: Date.now(),

      // derived per paint
      geom: null,
      bins: [],
      binCount: 0,
      lanes: [],
      counts: new Map(),
      countSignature: '',
      visibleCount: 0,
      maxDensity: 0,
      reload: null,

      // interaction
      drag: null,
      selection: null,
      hover: null,
      pointer: null,

      // selection / inspector
      selectedId: null,
      inspector: null,
      inspectorToken: 0,
      picked: null,

      // right-hand side: 'inspector' or 'history'
      sideTab: 'inspector',
      history: newHistoryState(),

      // canvas
      canvasCtx: null,
      dpr: 1,
      width: 0,
      height: 0,
      raf: 0,
      resizeObserver: null,
      themeWatcher: null,
      palette: null,
    };
    view = self;

    buildLayout(self);
    attachCanvas(self);
    subscribe(self);
    renderToolbar(self);
    renderSide(self);
    await load(self, { fit: true });
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
  if (self.raf) cancelAnimationFrame(self.raf);
  self.raf = 0;
  if (self.resizeObserver) {
    try { self.resizeObserver.disconnect(); } catch { /* already gone */ }
    self.resizeObserver = null;
  }
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
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Read every graph type, paged, in parallel. The caps are real limits and are
 * reported as such: a view that silently drops half a vault teaches the user
 * that the picture is complete when it is not.
 */
async function load(self, { fit = false } = {}) {
  self.loading = true;
  self.loadError = null;
  renderToolbar(self);
  renderStage(self);

  const collected = [];
  const totals = new Map();
  const loaded = new Map();
  let truncated = false;

  try {
    await Promise.all(GRAPH_TYPES.map(async (type) => {
      let offset = 0;
      let total = 0;
      const mine = [];
      for (;;) {
        const page = await request(self, (signal) => self.ctx.api.get('/records', {
          query: { type, limit: PAGE_SIZE, offset, sort: 'createdAt', order: 'desc' },
          signal,
          timeoutMs: 30000,
        }));
        const items = Array.isArray(page && page.items) ? page.items : [];
        total = Number.isFinite(page && page.total) ? page.total : (offset + items.length);
        for (const record of items) {
          const point = toPoint(record);
          if (point.created === null && point.updated === null) continue;
          mine.push(point);
        }
        offset += items.length;
        if (!items.length || offset >= total) break;
        if (mine.length >= MAX_PER_TYPE) {
          truncated = true;
          break;
        }
      }
      totals.set(type, total);
      loaded.set(type, mine.length);
      collected.push(...mine);
    }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.loading = false;
    self.loadError = err;
    renderToolbar(self);
    renderStage(self);
    return;
  }
  if (!self.alive) return;

  // Offset paging over a vault that is being written to can hand out the same
  // record twice. A duplicate would inflate every counter, so it is dropped
  // here rather than explained away in six places downstream.
  const seen = new Set();
  const unique = collected.filter((point) => (seen.has(point.id) ? false : (seen.add(point.id), true)));

  if (unique.length > MAX_TOTAL) {
    // Keep the most recent ones: a timeline is read from the present backwards.
    unique.sort((a, b) => (b.created || 0) - (a.created || 0));
    unique.length = MAX_TOTAL;
    truncated = true;
  }

  self.points = unique;
  self.totals = totals;
  self.loaded = loaded;
  self.truncated = truncated;
  self.loading = false;

  if (fit) fitAll(self, { silent: true });
  if (self.selectedId) {
    const point = self.points.find((p) => p.id === self.selectedId) || null;
    if (!point) selectRecord(self, null);
    else if (self.inspector) {
      self.inspector = { ...self.inspector, point };
      renderSide(self);
    }
  }

  renderToolbar(self);
  renderStage(self);
  draw(self);
}

const reloadSoon = (self) => {
  if (!self.reload) {
    self.reload = debounce(() => {
      if (self.alive) load(self);
    }, 500);
  }
  self.reload();
};

function subscribe(self) {
  const { ctx } = self;
  if (ctx.bus && typeof ctx.bus.on === 'function') {
    for (const name of ['record.created', 'record.updated', 'record.deleted']) {
      self.cleanups.push(ctx.bus.on(name, () => {
        if (self.alive) reloadSoon(self);
      }));
    }
    // The journal's own two events (src/store/history.js: publish()). While the
    // panel is closed nothing is fetched -- it is marked stale and read when it
    // is next opened, so a busy agent run does not cause one request per write.
    for (const name of ['history.recorded', 'history.undone']) {
      self.cleanups.push(ctx.bus.on(name, () => {
        if (!self.alive) return;
        self.history.stale = true;
        if (self.sideTab === 'history') refreshHistorySoon(self);
      }));
    }
  }
  // The palette lives in CSS custom properties, so a theme change has to be
  // read again rather than guessed at.
  if (ctx.state && typeof ctx.state.on === 'function') {
    self.cleanups.push(ctx.state.on('theme', () => {
      self.palette = null;
      draw(self);
    }));
  }
  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      self.palette = null;
      draw(self);
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handler);
      self.cleanups.push(() => media.removeEventListener('change', handler));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.searchInput = h('input.input', {
    type: 'search',
    placeholder: 'Titel, Text oder Schlagwort …',
    'aria-label': 'Datensätze auf der Zeitachse durchsuchen',
    autocomplete: 'off',
    spellcheck: 'false',
    value: self.query,
  });
  const runSearch = debounce(() => {
    if (!self.alive) return;
    self.query = dom.searchInput.value;
    self.folded = fold(self.query);
    refilter(self);
  }, 140);
  self.cleanups.push(on(dom.searchInput, 'input', runSearch));

  dom.search = h('div.tlv__search', null,
    h('span.tlv__search-icon', null, icon(ICONS.search)),
    dom.searchInput);

  dom.zoomButtons = h('div.segmented', { role: 'group', 'aria-label': 'Zoomstufe' },
    ...ZOOM_PRESETS.map((preset) => h('button.segmented__option', {
      type: 'button',
      dataset: { preset: preset.id },
      onClick: () => applyPreset(self, preset.span),
    }, text(preset.label))));

  dom.axisToggle = h('div.segmented', { role: 'group', 'aria-label': 'Zeitpunkt' },
    h('button.segmented__option', {
      type: 'button',
      dataset: { axis: 'created' },
      title: 'Punkte sitzen auf dem Zeitpunkt, an dem der Eintrag entstanden ist.',
      onClick: () => setAxis(self, 'created'),
    }, text('Erstellt')),
    h('button.segmented__option', {
      type: 'button',
      dataset: { axis: 'updated' },
      title: 'Punkte sitzen auf der letzten Änderung.',
      onClick: () => setAxis(self, 'updated'),
    }, text('Geändert')));

  dom.rangeLabel = h('span.tlv__range');
  dom.countLabel = h('span.tlv__status');

  dom.bar = h('div.tlv__bar', null,
    dom.search,
    dom.zoomButtons,
    h('button.btn.btn--small', {
      type: 'button',
      title: 'Zeigt den gesamten Zeitraum, in dem Einträge liegen.',
      onClick: () => fitAll(self),
    }, icon(ICONS.fit), text('Alles')),
    dom.axisToggle,
    h('span.spacer'),
    dom.rangeLabel,
    dom.countLabel,
    h('button.icon-button', {
      type: 'button',
      title: 'Daten neu laden',
      'aria-label': 'Daten neu laden',
      onClick: () => load(self),
    }, icon(ICONS.refresh)));

  dom.filters = h('div.tlv__bar.tlv__bar--filters', { role: 'group', 'aria-label': 'Nach Art filtern' });

  dom.canvas = h('canvas.tlv__canvas', {
    tabindex: '0',
    role: 'img',
    'aria-label': 'Zeitachse aller Datensätze. Mit den Pfeiltasten verschieben, mit Plus und Minus zoomen.',
  });
  dom.tooltip = h('div.tlv__tooltip', { hidden: true, role: 'status', 'aria-live': 'off' });
  dom.stageState = h('div.tlv__stage-state', { hidden: true });
  dom.selectionBar = h('div.tlv__selbar', { hidden: true, role: 'group', 'aria-label': 'Ausgewählter Zeitraum' });

  dom.stage = h('div.tlv__stage', null, dom.canvas, dom.tooltip, dom.selectionBar, dom.stageState);

  // Two panels, one column. The Inspektor answers "was ist das?", the journal
  // answers "wer war das?" -- and the second question is asked by somebody who
  // is already unhappy, so it must be one click away, not one screen away.
  dom.sideTabs = h('div.segmented.tlv__side-tabs', { role: 'group', 'aria-label': 'Seitenbereich' },
    h('button.segmented__option', {
      type: 'button',
      dataset: { tab: 'inspector' },
      onClick: () => setSideTab(self, 'inspector'),
    }, text('Inspektor')),
    h('button.segmented__option', {
      type: 'button',
      dataset: { tab: 'history' },
      title: 'Was zuletzt geändert wurde – von dir oder von einem Agenten – und wie du es zurücknimmst.',
      onClick: () => setSideTab(self, 'history'),
    }, text('Letzte Änderungen')));

  dom.sideMain = h('div.tlv__side-body');
  dom.historyPanel = h('div.tlv__side-body.tlv__hist', { hidden: true });
  dom.side = h('aside.tlv__side', { 'aria-label': 'Inspektor und Änderungen' },
    h('div.tlv__side-tabbar', null, dom.sideTabs),
    dom.sideMain,
    dom.historyPanel);

  dom.body = h('div.tlv__body', null, dom.stage, dom.side);

  dom.root = h('div.tlv', null, dom.bar, dom.filters, dom.body);
  container.appendChild(dom.root);
}

/* ------------------------------------------------------------------ */
/* Canvas plumbing                                                     */
/* ------------------------------------------------------------------ */

function attachCanvas(self) {
  const canvas = self.dom.canvas;
  self.canvasCtx = canvas.getContext('2d');
  if (!self.canvasCtx) {
    // Without a 2D context there is no timeline. Say so instead of showing an
    // empty rectangle that looks like an empty vault.
    self.loadError = new Error('Dieser Browser stellt keinen 2D-Zeichenbereich bereit. Die Zeitachse kann nicht gezeichnet werden.');
    renderStage(self);
    return;
  }

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(0, Math.round(rect.width || canvas.clientWidth || 0));
    const height = Math.max(0, Math.round(rect.height || canvas.clientHeight || 0));
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (width === self.width && height === self.height && dpr === self.dpr) return;
    self.width = width;
    self.height = height;
    self.dpr = dpr;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    draw(self);
  };

  if (typeof ResizeObserver === 'function') {
    self.resizeObserver = new ResizeObserver(resize);
    self.resizeObserver.observe(canvas);
  } else {
    self.cleanups.push(on(window, 'resize', resize));
  }
  resize();

  self.cleanups.push(on(canvas, 'wheel', (event) => onWheel(self, event), { passive: false }));
  self.cleanups.push(on(canvas, 'pointerdown', (event) => onPointerDown(self, event)));
  self.cleanups.push(on(canvas, 'pointermove', (event) => onPointerMove(self, event)));
  self.cleanups.push(on(canvas, 'pointerup', (event) => onPointerUp(self, event)));
  self.cleanups.push(on(canvas, 'pointercancel', () => onPointerCancel(self)));
  self.cleanups.push(on(canvas, 'pointerleave', () => {
    self.hover = null;
    self.pointer = null;
    hideTooltip(self);
    draw(self);
  }));
  self.cleanups.push(on(canvas, 'keydown', (event) => onKeyDown(self, event)));
}

function draw(self) {
  if (!self.alive || !self.canvasCtx || self.raf) return;
  self.raf = requestAnimationFrame(() => {
    self.raf = 0;
    if (!self.alive) return;
    paint(self);
  });
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

function readPalette(self) {
  const cs = getComputedStyle(self.dom.canvas);
  const prop = (name, fallback) => {
    const value = cs.getPropertyValue(name).trim();
    return value || fallback;
  };
  const surface = prop('--surface', '#ffffff');
  const dark = isDark(surface);
  return {
    dark,
    bg: prop('--bg', dark ? '#0b0c0f' : '#f4f4f6'),
    surface,
    border: prop('--border', dark ? 'rgba(255,255,255,0.09)' : 'rgba(18,20,24,0.11)'),
    fg: prop('--fg', dark ? '#e8eaee' : '#16181c'),
    muted: prop('--fg-muted', dark ? '#9aa1ac' : '#585e68'),
    subtle: prop('--fg-subtle', dark ? '#6a717c' : '#858b95'),
    accent: prop('--accent', dark ? '#7f9cff' : '#2f5bd0'),
  };
}

/** Rough luminance of an `rgb()`/`#rrggbb` string; only the light/dark question matters. */
function isDark(color) {
  const rgb = String(color).match(/\d+(\.\d+)?/g);
  if (String(color).startsWith('#')) {
    const hex = String(color).slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = Number.parseInt(full.slice(0, 6), 16);
    if (!Number.isFinite(n)) return false;
    return (((n >> 16) & 255) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722) < 120;
  }
  if (!rgb || rgb.length < 3) return false;
  return (Number(rgb[0]) * 0.2126 + Number(rgb[1]) * 0.7152 + Number(rgb[2]) * 0.0722) < 120;
}

/**
 * Die Tinte fuer einen Punkt.
 *
 * Frueher acht gesaettigte Farben, eine je Satzart. Das widersprach der
 * Designregel dieses Projekts ("Schwarz, Weiss und Grau tragen die Struktur,
 * genau ein Akzent") und war hier ausserdem doppelt gemoppelt: in einer
 * Zeitachse hat jede Satzart ohnehin ihre eigene Spur mit Beschriftung am
 * Rand. Die Farbe trug also keine Information, die nicht schon dastand -- sie
 * machte nur die Abweichung, auf die es ankommt (eine Auswahl), schwerer
 * sichtbar. Jetzt: eine neutrale Tinte, und der Akzent bleibt fuer das, was
 * gerade gemeint ist.
 */
/**
 * Die Silhouette einer Satzart als kleines Canvas, gezeichnet mit derselben
 * Funktion wie im Gehirn.
 *
 * Der Renderer selbst laeuft hier nicht (die Zeitachse hat keinen Graphen), die
 * Zeichenfunktion aber schon -- und genau die ist die gemeinsame Wahrheit. Eine
 * Zeitachse mit einer eigenen Vorstellung davon, wie ein Projekt aussieht,
 * waere die zweite Quelle, und die erste, die veraltet.
 */
function typeGlyph(self, type, size = 12) {
  const node = document.createElement('canvas');
  node.className = 'tlv__glyph';
  node.setAttribute('aria-hidden', 'true');
  const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  node.width = Math.round(size * ratio);
  node.height = Math.round(size * ratio);
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;

  const c = node.getContext('2d');
  if (!c) return node;
  const palette = self.palette || (self.palette = readPalette(self));
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.lineJoin = 'round';
  c.beginPath();
  drawNodeShape(c, type, size / 2, size / 2, size * 0.3);
  c.fillStyle = palette.surface;
  c.fill();
  c.lineWidth = 1.2;
  c.strokeStyle = palette.muted;
  c.stroke();
  return node;
}

function colorOf(self) {
  const palette = self.palette || (self.palette = readPalette(self));
  return palette.muted;
}

/* ------------------------------------------------------------------ */
/* Geometry, filtering, binning                                        */
/* ------------------------------------------------------------------ */

function activeLanes(self) {
  const lanes = GRAPH_TYPES.filter((type) => self.activeTypes.has(type));
  return lanes.length ? lanes : GRAPH_TYPES.slice();
}

function geometryOf(self) {
  const lanes = activeLanes(self);
  const gutter = self.width >= GUTTER_MIN_WIDTH ? GUTTER_W : 0;
  const left = gutter;
  const width = Math.max(1, self.width - gutter);
  const top = AXIS_H;
  const height = Math.max(1, self.height - AXIS_H - PLOT_PAD_BOTTOM);
  const laneH = height / lanes.length;
  return { lanes, gutter, left, width, top, height, laneH, right: left + width, bottom: top + height };
}

function xOf(self, geom, ts) {
  return geom.left + ((ts - self.viewStart) / (self.viewEnd - self.viewStart)) * geom.width;
}

function tOf(self, geom, x) {
  return self.viewStart + ((x - geom.left) / geom.width) * (self.viewEnd - self.viewStart);
}

function matchesQuery(self, point) {
  return !self.folded || point.haystack.includes(self.folded);
}

/**
 * Sort the visible records into pixel-wide bins. This is the one pass that
 * feeds everything: the density band, the dots, the counters and hit testing.
 * Per bin we keep the per-lane counts and the records themselves, so a click
 * can name what it hit without a second scan over the vault.
 */
function buildBins(self, geom) {
  const binCount = Math.max(1, Math.ceil(geom.width / BIN_PX));
  const bins = new Array(binCount);
  const laneIndex = new Map(geom.lanes.map((type, i) => [type, i]));
  const counts = new Map(GRAPH_TYPES.map((type) => [type, 0]));
  const span = self.viewEnd - self.viewStart;
  let visible = 0;
  let maxDensity = 0;

  for (const point of self.points) {
    const at = atOf(point, self.axis);
    if (at === null || at < self.viewStart || at > self.viewEnd) continue;
    if (!matchesQuery(self, point)) continue;
    // Counters ignore the type filter on purpose: the number next to a
    // switched-off type has to say what turning it on would show.
    counts.set(point.type, (counts.get(point.type) || 0) + 1);
    if (!self.activeTypes.has(point.type)) continue;
    const lane = laneIndex.get(point.type);
    if (lane === undefined) continue;

    const index = Math.min(binCount - 1, Math.max(0, Math.floor(((at - self.viewStart) / span) * geom.width / BIN_PX)));
    let bin = bins[index];
    if (!bin) {
      bin = { index, total: 0, lanes: new Array(geom.lanes.length).fill(0), items: [] };
      bins[index] = bin;
    }
    bin.total += 1;
    bin.lanes[lane] += 1;
    bin.items.push(point);
    visible += 1;
    if (bin.total > maxDensity) maxDensity = bin.total;
  }

  self.bins = bins;
  self.lanes = geom.lanes;
  self.counts = counts;
  self.visibleCount = visible;
  self.maxDensity = maxDensity;
  self.binCount = binCount;
  return bins;
}

function binRange(self, geom, index) {
  const from = tOf(self, geom, geom.left + index * BIN_PX);
  const to = tOf(self, geom, geom.left + (index + 1) * BIN_PX);
  return { from, to };
}

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

function paint(self) {
  const ctx = self.canvasCtx;
  if (!ctx || !self.width || !self.height) return;
  const palette = self.palette || (self.palette = readPalette(self));
  const geom = geometryOf(self);
  self.geom = geom;
  buildBins(self, geom);

  ctx.save();
  ctx.setTransform(self.dpr, 0, 0, self.dpr, 0, 0);
  ctx.clearRect(0, 0, self.width, self.height);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, self.width, self.height);

  paintDensity(self, ctx, geom, palette);
  paintLanes(self, ctx, geom, palette);
  paintDots(self, ctx, geom, palette);
  paintSelection(self, ctx, geom, palette);
  paintAxis(self, ctx, geom, palette);
  paintGutter(self, ctx, geom, palette);
  paintNow(self, ctx, geom, palette);

  ctx.restore();

  renderToolbar(self);
}

/**
 * The density band: how busy each slice of time was, behind everything else.
 *
 * Capped at a share of the plot rather than its full height. A bar that
 * reaches the top edge stops reading as a bar and starts reading as a
 * highlighted column -- which is exactly the wrong signal when only two
 * slices happen to carry anything.
 */
function paintDensity(self, ctx, geom, palette) {
  if (!self.maxDensity) return;
  ctx.save();
  ctx.globalAlpha = palette.dark ? 0.16 : 0.12;
  ctx.fillStyle = palette.fg;
  const max = self.maxDensity;
  const tallest = geom.height * 0.6;
  for (const bin of self.bins) {
    if (!bin) continue;
    const height = (bin.total / max) * tallest;
    ctx.fillRect(geom.left + bin.index * BIN_PX, geom.bottom - height, BIN_PX - 0.6, height);
  }
  ctx.restore();
}

function paintLanes(self, ctx, geom, palette) {
  ctx.save();
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1;
  for (let i = 1; i < geom.lanes.length; i += 1) {
    const y = Math.round(geom.top + i * geom.laneH) + 0.5;
    ctx.beginPath();
    ctx.moveTo(geom.left, y);
    ctx.lineTo(geom.right, y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Dots, stacked per bin and lane. A stack that does not fit gets a cap mark
 * rather than silently drawing fewer points as if there were fewer records.
 */
function paintDots(self, ctx, geom, palette) {
  const capacity = Math.max(1, Math.floor((geom.laneH - 8) / DOT_STEP));
  ctx.save();
  for (const bin of self.bins) {
    if (!bin) continue;
    const cx = geom.left + bin.index * BIN_PX + BIN_PX / 2;
    for (let lane = 0; lane < geom.lanes.length; lane += 1) {
      const count = bin.lanes[lane];
      if (!count) continue;
      const type = geom.lanes[lane];
      const baseline = geom.top + (lane + 1) * geom.laneH - 5;
      const drawn = Math.min(count, capacity);
      ctx.fillStyle = colorOf(self);
      for (let k = 0; k < drawn; k += 1) {
        ctx.beginPath();
        ctx.arc(cx, baseline - k * DOT_STEP, DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }
      if (count > capacity) {
        // The honest "there is more here than fits" mark.
        ctx.fillRect(cx - DOT_R - 1, baseline - capacity * DOT_STEP - 1.5, (DOT_R + 1) * 2, 2);
      }
    }
  }

  if (self.hover && self.hover.bin) {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1;
    const x = Math.round(geom.left + self.hover.bin.index * BIN_PX) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, geom.top);
    ctx.lineTo(x, geom.bottom);
    ctx.stroke();
  }
  ctx.restore();
}

function paintSelection(self, ctx, geom, palette) {
  const range = self.drag && self.drag.mode === 'select'
    ? { from: Math.min(self.drag.fromTime, self.drag.toTime), to: Math.max(self.drag.fromTime, self.drag.toTime) }
    : self.selection;
  if (!range) return;
  const x1 = xOf(self, geom, range.from);
  const x2 = xOf(self, geom, range.to);
  const left = Math.max(geom.left, Math.min(x1, x2));
  const right = Math.min(geom.right, Math.max(x1, x2));
  if (right <= left) return;
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = palette.accent;
  ctx.fillRect(left, geom.top, right - left, geom.height);
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(left) + 0.5, geom.top);
  ctx.lineTo(Math.round(left) + 0.5, geom.bottom);
  ctx.moveTo(Math.round(right) - 0.5, geom.top);
  ctx.lineTo(Math.round(right) - 0.5, geom.bottom);
  ctx.stroke();
  ctx.restore();
}

const CANVAS_FONT = 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function paintAxis(self, ctx, geom, palette) {
  const spec = chooseTickSpec(self.viewEnd - self.viewStart, geom.width);
  const ticks = tickTimes(spec, self.viewStart, self.viewEnd);

  ctx.save();
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, self.width, AXIS_H);
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, AXIS_H - 0.5);
  ctx.lineTo(self.width, AXIS_H - 0.5);
  ctx.stroke();

  ctx.font = `11px ${CANVAS_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const tick of ticks) {
    const x = Math.round(xOf(self, geom, tick)) + 0.5;
    if (x < geom.left - 1 || x > geom.right + 1) continue;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = palette.border;
    ctx.beginPath();
    ctx.moveTo(x, geom.top);
    ctx.lineTo(x, geom.bottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.muted;
    ctx.fillText(tickLabel(tick, spec.unit), x, AXIS_H / 2);
  }
  ctx.restore();
}

function paintGutter(self, ctx, geom, palette) {
  ctx.save();
  ctx.font = `11px ${CANVAS_FONT}`;
  ctx.textBaseline = 'middle';
  for (let lane = 0; lane < geom.lanes.length; lane += 1) {
    const type = geom.lanes[lane];
    const y = geom.top + (lane + 0.5) * geom.laneH;
    if (geom.gutter) {
      ctx.textAlign = 'right';
      ctx.fillStyle = palette.muted;
      ctx.fillText(typePlural(type), geom.gutter - 20, y);
      // Dieselbe Silhouette wie im Gehirn, damit die Spur ohne einen Blick
      // auf ihre Beschriftung wiedererkennbar ist.
      ctx.fillStyle = palette.muted;
      ctx.strokeStyle = palette.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      drawNodeShape(ctx, type, geom.gutter - 11, y, 4);
      ctx.stroke();
    } else {
      ctx.textAlign = 'left';
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = palette.muted;
      ctx.fillText(typePlural(type), geom.left + 6, geom.top + lane * geom.laneH + 9);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

function paintNow(self, ctx, geom, palette) {
  const now = Date.now();
  if (now < self.viewStart || now > self.viewEnd) return;
  const x = Math.round(xOf(self, geom, now)) + 0.5;
  ctx.save();
  ctx.strokeStyle = palette.accent;
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, geom.top);
  ctx.lineTo(x, geom.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = `10px ${CANVAS_FONT}`;
  ctx.textAlign = x > geom.right - 40 ? 'right' : 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = palette.accent;
  ctx.fillText('jetzt', x + (x > geom.right - 40 ? -4 : 4), geom.top + 3);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Viewport control                                                    */
/* ------------------------------------------------------------------ */

function setWindow(self, start, end) {
  let span = end - start;
  if (!Number.isFinite(span) || span <= 0) span = 30 * DAY;
  if (span < MIN_SPAN) {
    const middle = (start + end) / 2;
    start = middle - MIN_SPAN / 2;
    end = middle + MIN_SPAN / 2;
  } else if (span > MAX_SPAN) {
    const middle = (start + end) / 2;
    start = middle - MAX_SPAN / 2;
    end = middle + MAX_SPAN / 2;
  }
  self.viewStart = start;
  self.viewEnd = end;
  draw(self);
}

function dataBounds(self) {
  let min = null;
  let max = null;
  for (const point of self.points) {
    const at = atOf(point, self.axis);
    if (at === null) continue;
    if (min === null || at < min) min = at;
    if (max === null || at > max) max = at;
  }
  return { min, max };
}

function fitAll(self, { silent = false } = {}) {
  const { min, max } = dataBounds(self);
  if (min === null) {
    const now = Date.now();
    setWindow(self, now - 30 * DAY, now + DAY);
    if (!silent && self.ctx.toast) self.ctx.toast('Es gibt noch nichts, was auf einer Zeitachse liegen könnte.', 'info');
    return;
  }
  const span = Math.max(max - min, HOUR);
  const pad = span * 0.05;
  setWindow(self, min - pad, max + pad);
}

function applyPreset(self, span) {
  const middle = (self.viewStart + self.viewEnd) / 2;
  setWindow(self, middle - span / 2, middle + span / 2);
}

function setAxis(self, axis) {
  if (self.axis === axis) return;
  self.axis = axis;
  refilter(self);
}

/** Anything that changes WHICH records are shown, as opposed to where. */
function refilter(self) {
  renderToolbar(self);
  renderSelectionBar(self);
  draw(self);
}

function zoomAround(self, anchorTime, factor) {
  const start = anchorTime - (anchorTime - self.viewStart) * factor;
  const end = anchorTime + (self.viewEnd - anchorTime) * factor;
  setWindow(self, start, end);
}

/* ------------------------------------------------------------------ */
/* Pointer and keyboard                                                */
/* ------------------------------------------------------------------ */

function pointerPos(self, event) {
  const rect = self.dom.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onWheel(self, event) {
  if (!self.geom) return;
  event.preventDefault();
  const { x } = pointerPos(self, event);
  const geom = self.geom;
  const anchor = tOf(self, geom, Math.min(geom.right, Math.max(geom.left, x)));
  // Browsers report the same gesture in pixels, lines or pages. Normalising to
  // pixels first is what keeps a trackpad from zooming in one jump while a
  // mouse wheel barely moves, and the exponential keeps zooming symmetric:
  // one notch out undoes exactly one notch in.
  const raw = event.deltaMode === 1 ? event.deltaY * 16
    : event.deltaMode === 2 ? event.deltaY * 400
      : event.deltaY;
  const factor = Math.exp(Math.max(-300, Math.min(300, raw)) * 0.0022);
  zoomAround(self, anchor, factor);
}

function onPointerDown(self, event) {
  if (event.button !== 0 || !self.geom) return;
  self.dom.canvas.focus();
  const pos = pointerPos(self, event);
  try { self.dom.canvas.setPointerCapture(event.pointerId); } catch { /* not supported */ }
  const time = tOf(self, self.geom, pos.x);
  self.drag = {
    mode: event.shiftKey ? 'select' : 'pan',
    startX: pos.x,
    startY: pos.y,
    lastX: pos.x,
    moved: 0,
    fromTime: time,
    toTime: time,
    viewStart: self.viewStart,
    viewEnd: self.viewEnd,
  };
  if (self.drag.mode === 'select') {
    self.selection = null;
    renderSelectionBar(self);
  }
}

function onPointerMove(self, event) {
  if (!self.geom) return;
  const pos = pointerPos(self, event);
  self.pointer = pos;

  if (self.drag) {
    self.drag.moved = Math.max(self.drag.moved, Math.abs(pos.x - self.drag.startX), Math.abs(pos.y - self.drag.startY));
    if (self.drag.mode === 'pan') {
      const perPx = (self.viewEnd - self.viewStart) / self.geom.width;
      const shift = (pos.x - self.drag.lastX) * perPx;
      self.drag.lastX = pos.x;
      setWindow(self, self.viewStart - shift, self.viewEnd - shift);
    } else {
      self.drag.toTime = tOf(self, self.geom, Math.min(self.geom.right, Math.max(self.geom.left, pos.x)));
      draw(self);
    }
    return;
  }

  const hit = hitTest(self, pos);
  const changed = (hit && hit.bin ? hit.bin.index : -1) !== (self.hover && self.hover.bin ? self.hover.bin.index : -1)
    || (hit && hit.lane) !== (self.hover && self.hover.lane);
  self.hover = hit;
  if (hit) showTooltip(self, hit, pos);
  else hideTooltip(self);
  if (changed) draw(self);
}

function onPointerUp(self, event) {
  const drag = self.drag;
  self.drag = null;
  try { self.dom.canvas.releasePointerCapture(event.pointerId); } catch { /* fine */ }
  if (!drag || !self.geom) return;

  if (drag.mode === 'select') {
    const from = Math.min(drag.fromTime, drag.toTime);
    const to = Math.max(drag.fromTime, drag.toTime);
    // A shift-click is not a range; requiring a real drag keeps the panel
    // from appearing for an empty selection.
    self.selection = (to - from) > (self.viewEnd - self.viewStart) / self.geom.width * 3 ? { from, to } : null;
    draw(self);
    renderSelectionBar(self);
    return;
  }

  if (drag.moved <= CLICK_SLOP) {
    const hit = hitTest(self, pointerPos(self, event));
    if (hit && hit.items.length === 1) selectRecord(self, hit.items[0].id);
    else if (hit && hit.items.length > 1) showPick(self, hit);
    else selectRecord(self, null);
  }
}

function onPointerCancel(self) {
  self.drag = null;
  draw(self);
}

function onKeyDown(self, event) {
  if (!self.geom) return;
  const span = self.viewEnd - self.viewStart;
  const middle = (self.viewStart + self.viewEnd) / 2;
  switch (event.key) {
    case 'ArrowLeft':
      event.preventDefault();
      setWindow(self, self.viewStart - span * 0.2, self.viewEnd - span * 0.2);
      break;
    case 'ArrowRight':
      event.preventDefault();
      setWindow(self, self.viewStart + span * 0.2, self.viewEnd + span * 0.2);
      break;
    case '+':
    case '=':
      event.preventDefault();
      zoomAround(self, middle, 0.7);
      break;
    case '-':
    case '_':
      event.preventDefault();
      zoomAround(self, middle, 1.4);
      break;
    case 'Home':
      event.preventDefault();
      fitAll(self);
      break;
    case 'Escape':
      if (self.selection) {
        self.selection = null;
        renderSelectionBar(self);
        draw(self);
      } else {
        selectRecord(self, null);
      }
      break;
    default:
      break;
  }
}

function hitTest(self, pos) {
  const geom = self.geom;
  if (!geom || !self.binCount) return null;
  if (pos.x < geom.left || pos.x > geom.right || pos.y < geom.top || pos.y > geom.bottom) return null;
  const lane = Math.min(geom.lanes.length - 1, Math.max(0, Math.floor((pos.y - geom.top) / geom.laneH)));
  const type = geom.lanes[lane];
  const index = Math.min(self.binCount - 1, Math.max(0, Math.floor((pos.x - geom.left) / BIN_PX)));

  // Two columns of forgiveness either way: a four-pixel target is not a target.
  let best = null;
  for (let offset = 0; offset <= 2 && !best; offset += 1) {
    for (const candidate of offset === 0 ? [index] : [index - offset, index + offset]) {
      const bin = self.bins[candidate];
      if (bin && bin.lanes[lane]) {
        best = bin;
        break;
      }
    }
  }
  if (!best) return null;
  const items = best.items.filter((point) => point.type === type)
    .sort((a, b) => atOf(a, self.axis) - atOf(b, self.axis));
  if (!items.length) return null;
  return { bin: best, lane, type, items, range: binRange(self, geom, best.index) };
}

function showTooltip(self, hit, pos) {
  const node = self.dom.tooltip;
  clear(node);
  const first = hit.items[0];
  node.appendChild(h('strong.tlv__tooltip-title', null,
    text(hit.items.length === 1 ? first.label : `${formatNumber(hit.items.length)} × ${typePlural(hit.type)}`)));
  node.appendChild(h('span.tlv__tooltip-meta', null,
    text(hit.items.length === 1
      ? `${typeLabel(hit.type)} · ${formatDateTime(atOf(first, self.axis))}`
      : `${formatDateTime(hit.range.from)} – ${formatDateTime(hit.range.to)}`)));
  if (hit.items.length > 1) {
    node.appendChild(h('span.tlv__tooltip-meta', null, text('Klicken, um die Liste zu öffnen.')));
  }
  node.hidden = false;
  const stageWidth = self.dom.stage.clientWidth || self.width;
  const width = node.offsetWidth || 180;
  const x = Math.max(6, Math.min(stageWidth - width - 6, pos.x + 12));
  node.style.left = `${x}px`;
  node.style.top = `${Math.max(AXIS_H + 4, pos.y + 14)}px`;
}

function hideTooltip(self) {
  if (self.dom.tooltip) self.dom.tooltip.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Toolbar, filters and stage states                                   */
/* ------------------------------------------------------------------ */

function renderToolbar(self) {
  const { dom } = self;
  if (!dom.rangeLabel) return;

  clear(dom.rangeLabel);
  dom.rangeLabel.appendChild(text(`${rangeLabel(self.viewStart, self.viewEnd)} · ${spanLabel(self.viewEnd - self.viewStart)}`));

  clear(dom.countLabel);
  if (self.loading) {
    dom.countLabel.appendChild(text('lädt …'));
  } else if (self.loadError) {
    dom.countLabel.appendChild(text('nicht geladen'));
  } else {
    const total = self.points.length;
    let label = `${formatNumber(self.visibleCount)} von ${formatNumber(total)} im Bild`;
    if (self.truncated) label += ' · gekürzt';
    dom.countLabel.appendChild(text(label));
  }

  const span = self.viewEnd - self.viewStart;
  for (const button of dom.zoomButtons.querySelectorAll('.segmented__option')) {
    const preset = ZOOM_PRESETS.find((p) => p.id === button.dataset.preset);
    // "Active" means the window is within 25 % of that preset -- a wheel zoom
    // lands between the steps and must not light up the wrong one.
    button.classList.toggle('is-active', !!preset && Math.abs(Math.log(span / preset.span)) < 0.25);
  }
  for (const button of dom.axisToggle.querySelectorAll('.segmented__option')) {
    button.classList.toggle('is-active', button.dataset.axis === self.axis);
  }

  renderFilters(self);
}

/**
 * Rebuilt only when a counter actually changed. Panning repaints the canvas
 * sixty times a second; rebuilding eight buttons that often would throw away
 * focus and hover state for no visible gain.
 */
function renderFilters(self) {
  const { dom } = self;
  // Membership, not insertion order: toggling a type off and on again must not
  // count as a change just because the Set reordered itself.
  const signature = `${GRAPH_TYPES.map((t) => (self.activeTypes.has(t) ? '1' : '0')).join('')}`
    + `|${GRAPH_TYPES.map((t) => self.counts.get(t) || 0).join()}`;
  if (signature === self.countSignature && dom.filters.firstChild) return;
  self.countSignature = signature;
  clear(dom.filters);

  for (const type of GRAPH_TYPES) {
    const active = self.activeTypes.has(type);
    const count = self.counts.get(type) || 0;
    const button = h('button.tlv__type', {
      type: 'button',
      class: active ? 'is-active' : '',
      'aria-pressed': active ? 'true' : 'false',
      title: `${typePlural(type)} im sichtbaren Zeitraum: ${formatNumber(count)}`,
      onClick: () => toggleType(self, type),
    },
    typeGlyph(self, type),
    h('span.tlv__type-label', null, text(typePlural(type))),
    h('span.tlv__type-count', null, text(formatNumber(count))));
    dom.filters.appendChild(button);
  }

  dom.filters.appendChild(h('span.spacer'));
  dom.filters.appendChild(h('button.btn.btn--small.btn--ghost', {
    type: 'button',
    onClick: () => {
      self.activeTypes = new Set(GRAPH_TYPES);
      refilter(self);
    },
  }, text('Alle Arten')));
  dom.filters.appendChild(h('span.hint', null, text('Zähler gelten für den sichtbaren Zeitraum.')));
}

function toggleType(self, type) {
  if (self.activeTypes.has(type)) {
    if (self.activeTypes.size === 1) {
      // Zero lanes would be an empty canvas with no way back; invert instead.
      self.activeTypes = new Set(GRAPH_TYPES.filter((t) => t !== type));
    } else {
      self.activeTypes.delete(type);
    }
  } else {
    self.activeTypes.add(type);
  }
  refilter(self);
}

function renderStage(self) {
  const { dom } = self;
  const node = dom.stageState;
  if (!node) return;
  clear(node);

  if (self.loadError) {
    node.hidden = false;
    node.className = 'tlv__stage-state';
    node.appendChild(h('div.empty', null,
      h('h2', null, text('Die Zeitachse konnte nicht geladen werden')),
      h('p', null, text(self.loadError.message || 'Unbekannter Fehler.')),
      h('button.btn.btn--primary.btn--small', { type: 'button', onClick: () => load(self, { fit: true }) },
        text('Erneut versuchen'))));
    return;
  }

  if (self.loading && !self.points.length) {
    node.hidden = false;
    node.className = 'tlv__stage-state';
    node.appendChild(h('div.empty', { role: 'status' },
      h('div.spinner', { 'aria-hidden': 'true' }),
      h('p', null, text('Datensätze werden gelesen …'))));
    return;
  }

  if (!self.points.length) {
    node.hidden = false;
    node.className = 'tlv__stage-state';
    node.appendChild(h('div.empty', null,
      h('h2', null, text('Noch keine Spur in der Zeit')),
      h('p', { style: { maxWidth: '46ch' } }, text(
        'Diese Ansicht zeichnet jeden Datensatz an den Tag, an dem er entstanden ist – Notizen, Chats, '
        + 'Projekte, Aufgaben, Agentenläufe. Sobald das Erste da ist, siehst du hier, wann du woran '
        + 'gearbeitet hast und an welchen Tagen viel los war.')),
      h('div.row', { style: { justifyContent: 'center' } },
        h('button.btn.btn--primary.btn--small', { type: 'button', onClick: () => self.ctx.navigate('#/notes') },
          icon(ICONS.plus), text('Erste Notiz schreiben')),
        h('button.btn.btn--small', { type: 'button', onClick: () => self.ctx.navigate('#/chat') },
          text('Chat öffnen')))));
    return;
  }

  node.hidden = true;
}

function renderSelectionBar(self) {
  const { dom } = self;
  const node = dom.selectionBar;
  if (!node) return;
  clear(node);
  if (!self.selection) {
    node.hidden = true;
    return;
  }

  const items = recordsInSelection(self);
  node.hidden = false;
  node.appendChild(h('div.tlv__selbar-main', null,
    h('strong', null, text(rangeLabel(self.selection.from, self.selection.to))),
    h('span.meta', null, text(items.length
      ? `${formatNumber(items.length)} Einträge in diesem Zeitraum – bei den eingeschalteten Arten und der aktuellen Suche.`
      : 'In diesem Zeitraum liegt nichts, was gerade angezeigt wird.'))));

  node.appendChild(h('div.tlv__selbar-actions', null,
    h('button.btn.btn--small.btn--primary', {
      type: 'button',
      disabled: !items.length,
      onClick: () => showSelectionInGraph(self, items),
    }, icon(ICONS.brain), text('Im Gehirn zeigen')),
    h('button.btn.btn--small', {
      type: 'button',
      onClick: () => {
        setWindow(self, self.selection.from, self.selection.to);
        self.selection = null;
        renderSelectionBar(self);
      },
    }, text('Hineinzoomen')),
    h('button.icon-button', {
      type: 'button',
      title: 'Auswahl aufheben',
      'aria-label': 'Auswahl aufheben',
      onClick: () => {
        self.selection = null;
        renderSelectionBar(self);
        draw(self);
      },
    }, icon(ICONS.close))));

  // With a single record the brain really does open on it (`focus`). With a
  // range it does not yet filter, and saying so is cheaper than a button that
  // quietly means something else than it says.
  if (items.length > 1) {
    node.appendChild(h('p.tlv__selbar-note', null, text(
      'Der Zeitraum wird als from/to an die Adresse übergeben. Das Gehirn wertet diese beiden Angaben '
      + 'noch nicht aus und öffnet bis dahin den vollständigen Ausschnitt.')));
  }
}

function recordsInSelection(self) {
  if (!self.selection) return [];
  const { from, to } = self.selection;
  return self.points.filter((point) => {
    if (!self.activeTypes.has(point.type)) return false;
    if (!matchesQuery(self, point)) return false;
    const at = atOf(point, self.axis);
    return at !== null && at >= from && at <= to;
  });
}

/**
 * Hand the selected range to the brain.
 *
 * With exactly one record the graph can do the right thing today: `focus`
 * loads that record's neighbourhood. For a real range the boundaries travel as
 * `from`/`to` in the address -- `views/graph.js` reads `focus`, `depth` and
 * `q` and does not yet know these two, which is why the panel says so out loud
 * instead of letting the button imply a filter that is not applied.
 */
function showSelectionInGraph(self, items) {
  if (!items.length) return;
  if (items.length === 1) {
    self.ctx.navigate(`#/graph?focus=${encodeURIComponent(items[0].id)}&depth=2`);
    return;
  }
  const params = new URLSearchParams();
  params.set('from', new Date(self.selection.from).toISOString());
  params.set('to', new Date(self.selection.to).toISOString());
  if (self.activeTypes.size !== GRAPH_TYPES.length) params.set('types', [...self.activeTypes].join(','));
  self.ctx.navigate(`#/graph?${params.toString()}`);
}

/* ------------------------------------------------------------------ */
/* Side panel: picker and inspector                                    */
/* ------------------------------------------------------------------ */

function showPick(self, hit) {
  self.picked = hit;
  self.selectedId = null;
  self.inspector = null;
  // A click on the canvas asks "was ist das?" -- so the panel that answers it
  // comes forward, even when the journal was open.
  self.sideTab = 'inspector';
  renderSide(self);
}

function selectRecord(self, id) {
  self.picked = null;
  self.selectedId = id || null;
  if (id) self.sideTab = 'inspector';
  if (!id) {
    self.inspector = null;
    renderSide(self);
    return;
  }
  const point = self.points.find((p) => p.id === id) || null;
  self.inspector = { point, record: null, edges: [], labels: new Map(), loading: true, error: null };
  renderSide(self);
  loadInspector(self, id);
}

async function loadInspector(self, id) {
  const token = ++self.inspectorToken;
  let payload;
  try {
    payload = await request(self, (signal) => self.ctx.api.get(`/records/${encodeURIComponent(id)}`, { signal }));
  } catch (err) {
    if (!self.alive || token !== self.inspectorToken || (err && err.isAborted)) return;
    self.inspector = { ...self.inspector, loading: false, error: err };
    renderSide(self);
    return;
  }
  if (!self.alive || token !== self.inspectorToken) return;

  const record = payload && payload.record ? payload.record : null;
  const edges = Array.isArray(payload && payload.edges) ? payload.edges : [];
  const labels = new Map();
  const unknown = [];
  const byId = new Map(self.points.map((p) => [p.id, p]));
  for (const edge of edges) {
    const other = edge.data && (edge.data.from === id ? edge.data.to : edge.data.from);
    if (!other) continue;
    const known = byId.get(other);
    if (known) labels.set(other, { label: known.label, type: known.type });
    else if (!unknown.includes(other)) unknown.push(other);
  }

  self.inspector = { point: self.inspector && self.inspector.point, record, edges, labels, loading: false, error: null };
  renderSide(self);

  // Endpoints outside the loaded types (messages, memories) only need a title.
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
      if (!other) continue;
      labels.set(wanted[i], { label: recordLabel(other), type: other.type });
      changed = true;
    }
    if (changed) renderSide(self);
  }
}

function renderSide(self) {
  const { dom } = self;
  if (!dom.sideMain) return;
  clear(dom.sideMain);

  if (self.picked) {
    dom.sideMain.appendChild(renderPicker(self));
  } else if (self.selectedId && self.inspector) {
    dom.sideMain.appendChild(renderInspector(self));
  } else {
    dom.sideMain.appendChild(renderSideHelp(self));
  }
  syncSideTabs(self);
}

/** Which of the two panels is on screen; the other one keeps its state. */
function syncSideTabs(self) {
  const { dom } = self;
  if (!dom.sideTabs) return;
  const tab = self.sideTab === 'history' ? 'history' : 'inspector';
  for (const button of dom.sideTabs.querySelectorAll('.segmented__option')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  dom.sideMain.hidden = tab !== 'inspector';
  dom.historyPanel.hidden = tab !== 'history';
}

function setSideTab(self, tab) {
  self.sideTab = tab === 'history' ? 'history' : 'inspector';
  syncSideTabs(self);
  if (self.sideTab === 'history') openHistory(self);
}

function renderSideHelp(self) {
  const lines = [];
  for (const [type, total] of self.totals) {
    const loaded = self.loaded.get(type) || 0;
    if (total > loaded) lines.push(`${typePlural(type)}: ${formatNumber(loaded)} von ${formatNumber(total)}`);
  }

  return h('div.stack', null,
    h('h2.tlv__side-title', null, text('Inspektor')),
    h('p.tlv__hint', null, text(
      'Klicke auf einen Punkt, um Auszug, Schlagwörter und alle Verknüpfungen mit ihrer Begründung zu sehen – '
      + 'dieselbe Ansicht wie im Gehirn.')),
    h('hr.divider'),
    h('p.tlv__hint', null, text('Bedienung')),
    h('ul.tlv__hint', { style: { paddingLeft: '18px', margin: '0' } },
      h('li', null, text('Ziehen verschiebt, Mausrad zoomt um den Mauszeiger.')),
      h('li', null, text('Umschalttaste gedrückt halten und ziehen wählt einen Zeitraum.')),
      h('li', null, text('Pfeiltasten verschieben, Plus und Minus zoomen, Pos1 zeigt alles.')),
      h('li', null, text('Ein Balken über einem Stapel heißt: hier liegt mehr, als der Platz zeigt.'))),
    self.truncated || lines.length
      ? h('div.stack', { style: { gap: 'var(--sp-05)' } },
        h('hr.divider'),
        h('p.tlv__hint', null, text('Nicht vollständig geladen:')),
        ...lines.map((line) => h('p.tlv__hint', null, text(line))),
        h('p.tlv__hint', null, text(`Obergrenze: ${formatNumber(MAX_PER_TYPE)} je Art, ${formatNumber(MAX_TOTAL)} insgesamt.`)))
      : null);
}

function renderPicker(self) {
  const hit = self.picked;
  return h('div.stack', null,
    h('div.tlv__side-head', null,
      h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
        h('span.badge', null, text(typeLabel(hit.type))),
        h('h2.tlv__side-title', null, text(`${formatNumber(hit.items.length)} Einträge an dieser Stelle`))),
      h('button.icon-button', {
        type: 'button',
        title: 'Schließen',
        'aria-label': 'Schließen',
        onClick: () => {
          self.picked = null;
          renderSide(self);
        },
      }, icon(ICONS.close))),
    h('p.meta', null, text(`${formatDateTime(hit.range.from)} – ${formatDateTime(hit.range.to)}`)),
    h('div.list', { role: 'list' },
      ...hit.items.map((point) => h('button.list__row.tlv__pick', {
        type: 'button',
        onClick: () => selectRecord(self, point.id),
      },
      typeGlyph(self, point.type),
      h('span.tlv__pick-main', null,
        h('span.tlv__pick-title', null, text(point.label)),
        h('span.meta', null, text(formatDateTime(atOf(point, self.axis)))))))));
}

function renderInspector(self) {
  const { ctx, inspector } = self;
  const point = inspector.point || { id: self.selectedId, label: self.selectedId, type: 'unknown', tags: [], snippet: '' };
  const record = inspector.record;

  const head = h('div.tlv__side-head', null,
    h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
      h('span.badge', null, text(typeLabel(point.type))),
      h('h2.tlv__side-title', null, text(point.label))),
    h('button.icon-button', {
      type: 'button',
      title: 'Auswahl aufheben',
      'aria-label': 'Auswahl aufheben',
      onClick: () => selectRecord(self, null),
    }, icon(ICONS.close)));

  const meta = [];
  if (point.created) meta.push(`erstellt ${formatDate(point.created)}`);
  if (point.updated && point.updated !== point.created) meta.push(`geändert ${timeAgo(point.updated)}`);
  if (record && Number.isFinite(record.rev)) meta.push(`Fassung ${record.rev}`);

  const actions = h('div.row', null,
    h('button.btn.btn--small.btn--primary', {
      type: 'button',
      onClick: () => {
        const route = OPEN_ROUTES[point.type];
        if (!route) {
          ctx.toast('Für diese Art gibt es noch keine eigene Ansicht.', 'info');
          return;
        }
        ctx.navigate(route(point.id));
      },
    }, icon(ICONS.open), text('Öffnen')),
    h('button.btn.btn--small', {
      type: 'button',
      title: 'Öffnet das Gehirn mit diesem Knoten im Mittelpunkt.',
      onClick: () => ctx.navigate(`#/graph?focus=${encodeURIComponent(point.id)}&depth=2`),
    }, icon(ICONS.brain), text('Im Gehirn')));

  const body = h('div.stack', null,
    head,
    meta.length ? h('p.meta', null, text(meta.join(' · '))) : null,
    point.snippet ? h('p', null, text(point.snippet)) : null,
    (point.tags && point.tags.length)
      ? h('div.row', null, ...point.tags.map((tag) => h('span.tag', null, text(`#${tag}`))))
      : null,
    actions,
    h('hr.divider'));

  if (inspector.loading) {
    body.appendChild(h('p.tlv__hint', { role: 'status' }, text('Verknüpfungen werden geladen …')));
    return body;
  }
  if (inspector.error) {
    body.appendChild(h('p.is-danger', null, text(inspector.error.message || 'Die Verknüpfungen konnten nicht geladen werden.')));
    body.appendChild(h('button.btn.btn--small', { type: 'button', onClick: () => loadInspector(self, point.id) },
      text('Erneut versuchen')));
    return body;
  }

  const edges = inspector.edges.filter((edge) => edge && edge.data && !edge.deletedAt);
  body.appendChild(h('h3', { style: { fontSize: 'var(--fs-base)' } },
    text(`Verknüpfungen (${formatNumber(edges.length)})`)));

  if (!edges.length) {
    body.appendChild(h('p.tlv__hint', null, text(
      'Noch nichts verknüpft. Im Gehirn kannst du von diesem Knoten aus die erste Verbindung selbst legen.')));
    return body;
  }

  // Own links first: what the user decided outranks what the system guessed.
  const order = { manual: 0, agent: 1, derived: 2 };
  edges.sort((a, b) => (order[a.data.source] ?? 3) - (order[b.data.source] ?? 3));
  for (const edge of edges) body.appendChild(renderEdgeRow(self, point, edge));
  return body;
}

function renderEdgeRow(self, point, edge) {
  const data = edge.data || {};
  const outgoing = data.from === point.id;
  const otherId = outgoing ? data.to : data.from;
  const known = self.inspector.labels.get(otherId);
  const label = known ? known.label : otherId;
  const onTimeline = self.points.some((p) => p.id === otherId);

  return h('div.tlv__edge', null,
    h('span', { title: outgoing ? 'zeigt auf' : 'wird verwiesen von', style: { color: 'var(--fg-subtle)', marginTop: '2px' } },
      icon(outgoing ? ICONS.arrowRight : ICONS.arrowLeft)),
    h('div.tlv__edge-main', null,
      h('button.tlv__edge-target', {
        type: 'button',
        title: onTimeline ? 'Auf der Zeitachse anzeigen' : 'Im Gehirn öffnen – dieser Eintrag liegt nicht auf der Zeitachse.',
        onClick: () => {
          if (onTimeline) {
            const other = self.points.find((p) => p.id === otherId);
            const at = other ? atOf(other, self.axis) : null;
            if (at !== null) {
              const span = self.viewEnd - self.viewStart;
              setWindow(self, at - span / 2, at + span / 2);
            }
            selectRecord(self, otherId);
          } else {
            self.ctx.navigate(`#/graph?focus=${encodeURIComponent(otherId)}&depth=2`);
          }
        },
      }, text(label)),
      h('p.meta', null, text(`${kindLabel(data.kind)} · ${sourceLabel(data.source)}`)),
      h('p.tlv__edge-reason', null, text(data.reason || 'Keine Begründung hinterlegt.'))));
}

/* ------------------------------------------------------------------ */
/* Side panel: „Letzte Änderungen" -- the change journal and its undo  */
/* ------------------------------------------------------------------ */

/**
 * Why this sits in the Zeitachse
 * ------------------------------
 * The journal (`src/store/history.js`) had a backend and an HTTP API and no
 * way in. This view already answers "was ist wann passiert?", so it is where
 * somebody goes when something looks wrong -- and the next question they ask
 * is "wer war das?". The panel is a tab next to the Inspektor rather than a
 * screen of its own, because the person reaching for undo is already unhappy.
 *
 * What it refuses to do
 * ---------------------
 * It repeats what the server says and adds nothing: `canUndo` decides whether
 * a button exists, `reason` takes its place when it does not, and what an undo
 * actually did is read off `applied` rather than assumed. `force` is offered
 * only for the one case the server marks as forceable (`details.force`), never
 * on the first click, and with the loss spelled out.
 */

/** One page; a journal is read from the top, not browsed to the end. */
const HISTORY_PAGE = 25;
/** The API caps `limit` at 500; a refresh never asks for more than this. */
const HISTORY_MAX_PAGE = 200;

/**
 * `DEFAULT_MAX_ENTRIES` / `DEFAULT_MAX_DAYS` in src/store/history.js. Both are
 * configurable, and `stats()` does not report them, so the real values are
 * read from `/api/config` and these two only stand in for an untouched config.
 */
const HISTORY_DEFAULT_MAX_ENTRIES = 2000;
const HISTORY_DEFAULT_MAX_DAYS = 30;

/**
 * `UNDOABLE_TYPES` in src/store/history.js -- nothing else is ever journalled,
 * so nothing else can appear here or in the filter.
 */
const JOURNAL_TYPES = ['note', 'chat', 'project', 'task', 'agent', 'file', 'entity', 'memory', 'schedule', 'trigger'];

/**
 * The journal's own German names (`TYPE_LABELS` in src/store/history.js). They
 * are repeated rather than mapped onto this view's table because the server
 * writes them into every `label`: a filter that says "Entität" while every row
 * says "Begriff" would look like two different things.
 */
const JOURNAL_TYPE_LABELS = {
  note: 'Notiz',
  chat: 'Chat',
  project: 'Projekt',
  task: 'Aufgabe',
  agent: 'Agent',
  file: 'Datei',
  entity: 'Begriff',
  memory: 'Erinnerung',
  schedule: 'Zeitplan',
  trigger: 'Auslöser',
};

/** Field names as a reader knows them; anything else is shown as it is. */
const FIELD_LABELS = {
  title: 'Titel',
  name: 'Name',
  body: 'Text',
  text: 'Text',
  description: 'Beschreibung',
  summary: 'Zusammenfassung',
  tags: 'Schlagwörter',
  goal: 'Ziel',
  status: 'Status',
  done: 'Erledigt',
  enabled: 'Eingeschaltet',
  pinned: 'Angeheftet',
  priority: 'Priorität',
  dueAt: 'Fällig am',
  model: 'Modell',
  permissions: 'Rechte',
  projectId: 'Projekt',
};

function newHistoryState() {
  return {
    opened: false,
    loading: false,
    error: null,
    items: [],
    total: 0,
    agentOnly: false,
    type: '',
    stats: null,
    limits: null,
    agents: new Map(),
    agentsLoaded: false,
    /** seq -> true while its undo is in flight */
    busy: new Set(),
    /** seq -> the `applied` object the server answered with */
    results: new Map(),
    /** seq -> {message, force} from a 409 */
    conflicts: new Map(),
    /** seq -> message of anything else that went wrong */
    failures: new Map(),
    stale: false,
    token: 0,
    refresh: null,
  };
}

function openHistory(self) {
  const state = self.history;
  renderHistory(self);
  if (!state.opened) {
    state.opened = true;
    loadHistoryLimits(self);
    loadHistory(self);
    return;
  }
  if (state.stale && !state.loading) loadHistory(self);
}

/**
 * A run writing twenty records publishes twenty `history.recorded` events. The
 * panel is worth one request afterwards, not twenty during.
 */
function refreshHistorySoon(self) {
  const state = self.history;
  if (!state.refresh) {
    state.refresh = debounce(() => {
      if (self.alive && self.sideTab === 'history') loadHistory(self);
    }, 400);
  }
  state.refresh();
}

async function loadHistory(self, { append = false } = {}) {
  const state = self.history;
  const token = ++state.token;
  state.loading = true;
  state.error = null;
  if (!append) state.stale = false;
  renderHistory(self);

  const offset = append ? state.items.length : 0;
  const limit = append
    ? HISTORY_PAGE
    : Math.min(HISTORY_MAX_PAGE, Math.max(HISTORY_PAGE, state.items.length));

  let payload;
  try {
    payload = await request(self, (signal) => self.ctx.api.get('/history', {
      query: {
        limit,
        offset,
        actor: state.agentOnly ? 'agent' : '',
        type: state.type || '',
      },
      signal,
      timeoutMs: 15000,
    }));
  } catch (err) {
    if (!self.alive || token !== state.token || (err && err.isAborted)) return;
    state.loading = false;
    state.error = err;
    renderHistory(self);
    return;
  }
  if (!self.alive || token !== state.token) return;

  const incoming = Array.isArray(payload && payload.items) ? payload.items : [];
  if (append) {
    // Offset paging over a journal that is still being written to can hand out
    // the same entry twice; `seq` is unique, so the duplicate is dropped here.
    const known = new Set(state.items.map((item) => item.seq));
    state.items = state.items.concat(incoming.filter((item) => !known.has(item.seq)));
  } else {
    state.items = incoming;
  }
  state.total = Number.isFinite(payload && payload.total) ? payload.total : state.items.length;
  state.loading = false;
  renderHistory(self);

  if (!append) loadHistoryStats(self);
  loadHistoryAgents(self);
}

/** The counts over the whole journal, not just the page on screen. */
async function loadHistoryStats(self) {
  const state = self.history;
  try {
    const stats = await request(self, (signal) => self.ctx.api.get('/history/stats', { signal, timeoutMs: 10000 }));
    if (!self.alive) return;
    state.stats = stats && typeof stats === 'object' ? stats : null;
    renderHistory(self);
  } catch {
    // The list itself already says when the journal is unreachable; a second
    // red box for the same fact would only be noise.
  }
}

/**
 * The real bounds. `stats()` does not carry them, so they come from the
 * configuration; an untouched config has no `history` section at all, and then
 * the defaults from src/store/history.js are what is actually in force.
 */
async function loadHistoryLimits(self) {
  const state = self.history;
  let maxEntries = HISTORY_DEFAULT_MAX_ENTRIES;
  let maxDays = HISTORY_DEFAULT_MAX_DAYS;
  try {
    const payload = await request(self, (signal) => self.ctx.api.get('/config', { signal, timeoutMs: 10000 }));
    const cfg = payload && payload.config && payload.config.history;
    if (cfg && Number.isFinite(cfg.maxEntries) && cfg.maxEntries > 0) maxEntries = Math.floor(cfg.maxEntries);
    if (cfg && Number.isFinite(cfg.maxDays) && cfg.maxDays > 0) maxDays = Math.floor(cfg.maxDays);
  } catch {
    // Unreadable configuration: the defaults are still what an untouched
    // installation uses, so the sentence below stays true for that case.
  }
  if (!self.alive) return;
  state.limits = { maxEntries, maxDays };
  renderHistory(self);
}

/** Agent names for the attribution line. An id alone answers nobody's question. */
async function loadHistoryAgents(self) {
  const state = self.history;
  if (state.agentsLoaded) return;
  if (!state.items.some((item) => item.actor && item.actor.agentId)) return;
  state.agentsLoaded = true;
  try {
    const payload = await request(self, (signal) => self.ctx.api.get('/agents', {
      query: { limit: 200 },
      signal,
      timeoutMs: 10000,
    }));
    if (!self.alive) return;
    const items = Array.isArray(payload && payload.items) ? payload.items : [];
    for (const agent of items) {
      const name = agent && agent.data && typeof agent.data.name === 'string' ? agent.data.name : '';
      if (agent && agent.id && name) state.agents.set(agent.id, name);
    }
    renderHistory(self);
  } catch {
    // Without names the rows fall back to the id, which is still true.
    state.agentsLoaded = false;
  }
}

async function undoEntry(self, item, { force = false } = {}) {
  const state = self.history;
  const seq = item.seq;
  if (state.busy.has(seq)) return;
  state.busy.add(seq);
  state.conflicts.delete(seq);
  state.failures.delete(seq);
  renderHistory(self);

  let payload;
  try {
    payload = await request(self, (signal) => self.ctx.api.post(
      `/history/${encodeURIComponent(seq)}/undo`,
      force ? { force: true } : {},
      { signal, timeoutMs: 20000 },
    ));
  } catch (err) {
    state.busy.delete(seq);
    if (!self.alive || (err && err.isAborted)) return;
    if (err && err.code === 'HISTORY_NOT_UNDOABLE') {
      // The server names both revisions in `message`; `details.force` says
      // whether forcing would even do anything. Both are shown as they came.
      state.conflicts.set(seq, {
        message: err.message,
        force: !!(err.details && err.details.force === true),
      });
    } else {
      state.failures.set(seq, (err && err.message) || 'Die Änderung konnte nicht zurückgenommen werden.');
    }
    renderHistory(self);
    return;
  }
  if (!self.alive) return;

  state.busy.delete(seq);
  state.results.set(seq, (payload && payload.applied) || null);
  self.ctx.toast(undoToast(payload && payload.applied), 'success');
  // The bus event refreshes this too, but a panel that only works with a live
  // stream would be a panel that sometimes lies.
  loadHistory(self);
}

function undoToast(applied) {
  if (applied && applied.note) return 'Zurückgenommen – mit Einschränkung, siehe Eintrag.';
  return 'Zurückgenommen.';
}

/* ---------------------------------------------------------- rendering */

function buildHistoryChrome(self) {
  const { dom } = self;
  const state = self.history;
  clear(dom.historyPanel);

  dom.histAgentOnly = h('button.tlv__hist-filter', {
    type: 'button',
    'aria-pressed': 'false',
    title: 'Zeigt nur Änderungen, die ein Agentenlauf gemacht hat.',
    onClick: () => {
      state.agentOnly = !state.agentOnly;
      state.items = [];
      loadHistory(self);
    },
  }, text('Nur was ohne mich passiert ist'));

  dom.histType = h('select.select.tlv__hist-type', {
    'aria-label': 'Nach Art des Eintrags filtern',
    onChange: (event) => {
      state.type = event.target.value;
      state.items = [];
      loadHistory(self);
    },
  },
  h('option', { value: '' }, text('Alle Arten')),
  ...JOURNAL_TYPES.map((type) => h('option', { value: type }, text(JOURNAL_TYPE_LABELS[type]))));
  // A select's value can only be set once its options exist.
  dom.histType.value = state.type;

  dom.histSummary = h('p.meta.tlv__hist-summary');
  dom.histList = h('div.tlv__hist-list');
  dom.histMore = h('div.tlv__hist-more');
  dom.histFoot = h('div.tlv__hist-foot');

  dom.historyPanel.appendChild(h('div.tlv__side-head', null,
    h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
      h('h2.tlv__side-title', null, text('Letzte Änderungen')),
      h('p.tlv__hint', null, text('Wer hat was geändert – und wie du es zurücknimmst.'))),
    h('button.icon-button', {
      type: 'button',
      title: 'Änderungen neu laden',
      'aria-label': 'Änderungen neu laden',
      onClick: () => loadHistory(self),
    }, icon(ICONS.refresh))));
  dom.historyPanel.appendChild(h('div.tlv__hist-filters', null, dom.histAgentOnly, dom.histType));
  dom.historyPanel.appendChild(dom.histSummary);
  dom.historyPanel.appendChild(dom.histList);
  dom.historyPanel.appendChild(dom.histMore);
  dom.historyPanel.appendChild(dom.histFoot);
}

function renderHistory(self) {
  const { dom } = self;
  if (!dom.historyPanel) return;
  const state = self.history;
  if (!dom.histList) buildHistoryChrome(self);

  dom.histAgentOnly.classList.toggle('is-active', state.agentOnly);
  dom.histAgentOnly.setAttribute('aria-pressed', state.agentOnly ? 'true' : 'false');
  if (dom.histType.value !== state.type) dom.histType.value = state.type;

  renderHistorySummary(self);

  clear(dom.histList);
  clear(dom.histMore);

  if (state.error) {
    dom.histList.appendChild(renderHistoryError(self, state.error));
  } else if (state.loading && !state.items.length) {
    dom.histList.appendChild(h('p.tlv__hint', { role: 'status' }, text('Änderungen werden gelesen …')));
  } else if (!state.items.length) {
    dom.histList.appendChild(renderHistoryEmpty(self));
  } else {
    for (const item of state.items) dom.histList.appendChild(renderHistoryEntry(self, item));
    if (state.items.length < state.total) {
      dom.histMore.appendChild(h('button.btn.btn--small', {
        type: 'button',
        disabled: state.loading,
        onClick: () => loadHistory(self, { append: true }),
      }, text(state.loading ? 'Lädt …' : 'Weitere laden')));
      dom.histMore.appendChild(h('span.meta', null,
        text(`${formatNumber(state.items.length)} von ${formatNumber(state.total)}`)));
    }
  }

  renderHistoryFoot(self);
}

function renderHistorySummary(self) {
  const { dom } = self;
  const state = self.history;
  clear(dom.histSummary);
  const stats = state.stats;
  if (!stats) {
    if (state.loading) dom.histSummary.appendChild(text('lädt …'));
    return;
  }
  const parts = [`${formatNumber(stats.total)} Änderungen im Journal`];
  const byActor = stats.byActor || {};
  parts.push(`${formatNumber(byActor.agent || 0)} davon von Agenten`);
  if (Number.isFinite(stats.undoable)) parts.push(`${formatNumber(stats.undoable)} noch zurücknehmbar`);
  dom.histSummary.appendChild(text(parts.join(' · ')));
}

function renderHistoryError(self, err) {
  const unavailable = err.status === 503 || err.code === 'SUBSYSTEM_UNAVAILABLE';
  if (unavailable) {
    // Not the same as "nichts passiert": there is no journal running here, so
    // nothing was recorded and nothing can be taken back.
    return h('div.tlv__hist-note', null,
      h('strong', null, text('Der Änderungsverlauf ist in dieser Instanz nicht verfügbar')),
      h('p', null, text(err.message || 'Das Journal läuft hier nicht.')),
      h('p', null, text('Ohne ihn wird nichts aufgezeichnet und es lässt sich nichts zurücknehmen. '
        + 'Die Zeitachse selbst arbeitet weiter.')));
  }
  return h('div.tlv__hist-note.tlv__hist-note--bad', null,
    h('strong', null, text('Die Änderungen konnten nicht gelesen werden')),
    h('p', null, text(err.message || 'Unbekannter Fehler.')),
    h('button.btn.btn--small', { type: 'button', onClick: () => loadHistory(self) }, text('Erneut versuchen')));
}

/** Three different silences, three different sentences. */
function renderHistoryEmpty(self) {
  const state = self.history;
  if (state.agentOnly && state.type) {
    return h('p.tlv__hint', null, text(
      `Nichts, was ohne dich passiert ist – jedenfalls nicht bei „${JOURNAL_TYPE_LABELS[state.type] || state.type}".`));
  }
  if (state.agentOnly) {
    return h('div.stack', { style: { gap: 'var(--sp-05)' } },
      h('p', null, text('Nichts, was ohne dich passiert ist.')),
      h('p.tlv__hint', null, text('Seit das Journal läuft, hat kein Agentenlauf etwas geändert.')));
  }
  if (state.type) {
    return h('p.tlv__hint', null, text(
      `Für „${JOURNAL_TYPE_LABELS[state.type] || state.type}" ist nichts aufgezeichnet.`));
  }
  return h('div.stack', { style: { gap: 'var(--sp-05)' } },
    h('p', null, text('Noch nichts passiert.')),
    h('p.tlv__hint', null, text('Sobald etwas angelegt, geändert oder gelöscht wird, steht es hier – '
      + 'mit dem Weg zurück.')));
}

function actorLabel(self, item) {
  const actor = (item && item.actor) || { kind: 'user' };
  if (actor.kind !== 'agent') return 'Du';
  const name = actor.agentId ? self.history.agents.get(actor.agentId) : '';
  if (name) return `Agent · ${clip(name, 40)}`;
  if (actor.agentId) return 'Agent · Name unbekannt';
  return 'Ein Agent';
}

/**
 * Which fields an update touched. `fields` is the patch's key list, so it says
 * what was written, not what visibly differed -- close enough to be useful and
 * honest enough not to be rewritten into a claim about values.
 */
function fieldsLabel(item) {
  if (item.op !== 'update' || !Array.isArray(item.fields) || !item.fields.length) return '';
  const named = item.fields.slice(0, 4).map((field) => FIELD_LABELS[field] || field);
  const rest = item.fields.length - named.length;
  return `Geändert: ${named.join(', ')}${rest > 0 ? ` und ${rest} weitere` : ''}`;
}

function renderHistoryEntry(self, item) {
  const state = self.history;
  const actor = (item && item.actor) || { kind: 'user' };
  const isAgent = actor.kind === 'agent';
  /**
   * `actorOf()` in src/store/history.js reads two sources. `via: 'kontext'` is
   * the actor carried through the call chain -- it really says who made THIS
   * change. `via: 'stempel'` is the provenance stamp on the record, which was
   * written when the record was CREATED: for a create that is the same thing,
   * for an update or a delete it only says where the record came from. Saying
   * "ein Agent hat das geändert" on that basis would be a guess.
   */
  const stamped = isAgent && actor.via === 'stempel' && item.op !== 'create';

  const row = h('article.tlv__hist-row', { class: item.undone ? 'is-undone' : '' });

  row.appendChild(h('div.tlv__hist-who', null,
    h('span.badge', {
      class: cxClasses(isAgent && !stamped ? 'badge--accent' : '', stamped ? 'tlv__hist-badge--guess' : ''),
      title: isAgent && actor.agentId ? `Agent-Kennung: ${actor.agentId}` : null,
    }, text(actorLabel(self, item))),
    isAgent && actor.runId
      ? h('button.tlv__hist-run', {
        type: 'button',
        title: 'Öffnet den Lauf in der Agentenansicht.',
        onClick: () => self.ctx.navigate(`#/agents?run=${encodeURIComponent(actor.runId)}`),
      }, text('Lauf ansehen'))
      : null,
    item.undone ? h('span.badge', null, text('zurückgenommen')) : null));

  row.appendChild(h('p.tlv__hist-label', null, text(item.label || `${JOURNAL_TYPE_LABELS[item.type] || item.type} geändert`)));

  const meta = [formatDateTime(item.at), timeAgo(item.at)];
  const fields = fieldsLabel(item);
  if (fields) meta.push(fields);
  row.appendChild(h('p.meta', null, text(meta.join(' · '))));

  if (stamped) {
    row.appendChild(h('p.tlv__hist-guess', null, text(
      'Zugeordnet über den Herkunftsstempel: der Eintrag stammt aus diesem Lauf. '
      + 'Wer ihn dieses Mal geändert hat, ist nicht festgehalten.')));
  }
  if (item.undone && item.undoneAt) {
    row.appendChild(h('p.meta', null, text(`Zurückgenommen ${timeAgo(item.undoneAt)}.`)));
  }

  const busy = state.busy.has(item.seq);
  const conflict = state.conflicts.get(item.seq);
  const failure = state.failures.get(item.seq);
  const applied = state.results.has(item.seq) ? state.results.get(item.seq) : undefined;

  if (item.canUndo) {
    row.appendChild(h('div.tlv__hist-actions', null,
      h('button.btn.btn--small', {
        type: 'button',
        disabled: busy,
        onClick: () => undoEntry(self, item),
      }, icon(ICONS.undo), text(busy ? 'Nimmt zurück …' : 'Rückgängig'))));
  } else if (item.reason) {
    // No greyed-out button with a shrug: the server said why, so that is what
    // stands here instead.
    row.appendChild(h('p.tlv__hist-reason', null, text(item.reason)));
    // One way further, and it is an attempt, not a promise: the request goes
    // WITHOUT `force`, so the server decides again and answers with the real
    // reason. Only if it then says the entry is forceable does a second,
    // warned click appear. An entry that is already undone, or of a type this
    // journal cannot undo, gets nothing here -- there would be nothing to try.
    if (!item.undone && JOURNAL_TYPES.includes(item.type) && !conflict && applied === undefined) {
      row.appendChild(h('div.tlv__hist-actions', null,
        h('button.btn.btn--small.btn--ghost', {
          type: 'button',
          disabled: busy,
          title: 'Fragt noch einmal beim Server nach. Ginge dabei etwas Neueres verloren, '
            + 'wird es genannt und muss erst bestätigt werden.',
          onClick: () => undoEntry(self, item),
        }, text(busy ? 'Fragt nach …' : 'Trotzdem versuchen'))));
    }
  }

  if (conflict) row.appendChild(renderHistoryConflict(self, item, conflict));
  if (failure) {
    row.appendChild(h('div.tlv__hist-note.tlv__hist-note--bad', null,
      h('strong', null, text('Das Zurücknehmen ist fehlgeschlagen')),
      h('p', null, text(failure))));
  }
  if (applied !== undefined) row.appendChild(renderHistoryApplied(self, item, applied));

  return row;
}

/** A second click, with the loss named. Never the first one. */
function renderHistoryConflict(self, item, conflict) {
  const state = self.history;
  const block = h('div.tlv__hist-note.tlv__hist-note--warn', null,
    h('strong', null, text('Zurücknehmen abgelehnt')),
    h('p', null, text(conflict.message)));

  if (conflict.force) {
    block.appendChild(h('p', null, text(item.op === 'create'
      ? 'Wenn du trotzdem zurücknimmst, wird der Eintrag gelöscht – die neuere Änderung ist damit ebenfalls weg.'
      : 'Wenn du trotzdem zurücknimmst, geht die neuere Änderung verloren.')));
    block.appendChild(h('div.tlv__hist-actions', null,
      h('button.btn.btn--small.btn--danger', {
        type: 'button',
        disabled: state.busy.has(item.seq),
        onClick: () => undoEntry(self, item, { force: true }),
      }, text('Trotzdem zurücknehmen')),
      h('button.btn.btn--small.btn--ghost', {
        type: 'button',
        onClick: () => {
          state.conflicts.delete(item.seq);
          renderHistory(self);
        },
      }, text('Lassen'))));
  }
  return block;
}

/**
 * What the undo really did, read off `applied`.
 *
 * A `note` means something did not work out the way the button promised -- a
 * field that could not be emptied again, a record that came back under a new
 * id, a change that had already been made by hand. Then the heading says so
 * rather than reporting a clean undo.
 */
function renderHistoryApplied(self, item, applied) {
  if (!applied) {
    return h('div.tlv__hist-note', null, h('strong', null, text('Zurückgenommen')));
  }
  const note = typeof applied.note === 'string' ? applied.note : '';
  const block = h('div.tlv__hist-note.tlv__hist-note--done', null,
    h('strong', null, text(note ? 'Nicht vollständig zurückgenommen' : 'Zurückgenommen')));

  if (applied.op === 'recreate') {
    block.appendChild(h('p', null, text('Der Eintrag ist wieder da – aber unter einer neuen Kennung.')));
    if (note) block.appendChild(h('p', null, text(note)));
    if (applied.newId) {
      block.appendChild(h('p.tlv__hist-id', null, text(`Neue Kennung: ${applied.newId}`)));
      const route = OPEN_ROUTES[item.type];
      if (route) {
        block.appendChild(h('div.tlv__hist-actions', null,
          h('button.btn.btn--small', {
            type: 'button',
            onClick: () => self.ctx.navigate(route(applied.newId)),
          }, icon(ICONS.open), text('Wiederhergestellten Eintrag öffnen'))));
      }
    }
    return block;
  }

  if (note) {
    // The note is the whole truth for "war bereits gelöscht / bereits wieder
    // da"; for a partial update it needs the other half said out loud.
    block.appendChild(h('p', null, text(note)));
    if (applied.op === 'update') {
      block.appendChild(h('p', null, text('Die übrigen Felder stehen wieder auf ihrem vorherigen Wert.')));
    }
    return block;
  }

  const lines = {
    delete: 'Der Eintrag wurde wieder entfernt.',
    update: 'Die vorherigen Werte stehen wieder.',
    restore: 'Der Eintrag ist wieder da.',
  };
  block.appendChild(h('p', null, text(lines[applied.op] || 'Die Änderung wurde zurückgenommen.')));
  return block;
}

/**
 * What the journal cannot do. At the bottom, quiet, and always there: a person
 * who relies on this for longer than it lasts would be relying on nothing.
 */
function renderHistoryFoot(self) {
  const { dom } = self;
  const state = self.history;
  clear(dom.histFoot);
  const limits = state.limits || { maxEntries: HISTORY_DEFAULT_MAX_ENTRIES, maxDays: HISTORY_DEFAULT_MAX_DAYS };
  const stats = state.stats;

  dom.histFoot.appendChild(h('hr.divider'));
  dom.histFoot.appendChild(h('p.tlv__hint', null, text(
    `Das Journal ist kein Archiv: es hält höchstens ${formatNumber(limits.maxEntries)} Änderungen `
    + `oder ${formatNumber(limits.maxDays)} Tage. Was darüber hinausgeht, ist weg – dafür gibt es die Sicherung.`)));
  if (stats && stats.oldest) {
    dom.histFoot.appendChild(h('p.tlv__hint', null,
      text(`Ältester Eintrag: ${formatDateTime(stats.oldest)}.`)));
  }
  dom.histFoot.appendChild(h('p.tlv__hint', null, text(
    'Aufgezeichnet werden Notizen, Chats, Projekte, Aufgaben, Agenten, Dateien, Begriffe, '
    + 'Erinnerungen, Zeitpläne und Auslöser.')));
  dom.histFoot.appendChild(h('p.tlv__hint', null, text(
    'Verknüpfungen (Kanten) stehen nicht hier: sie werden bei jedem Schreiben aus dem Text neu '
    + 'abgeleitet, ein Zurücknehmen wäre sofort wieder überschrieben. Von Hand gezogene Kanten '
    + 'löschst du im Gehirn direkt.')));
  dom.histFoot.appendChild(h('p.tlv__hint', null, text(
    'Auch Nachrichten, Läufe, Freigaben und Vorschläge fehlen hier: sie halten fest, was '
    + 'geschehen ist – ein alter Wert würde das nicht ungeschehen machen.')));

  if (stats && stats.unreadable > 0) {
    dom.histFoot.appendChild(h('p.tlv__hist-reason', null, text(
      `${formatNumber(stats.unreadable)} Zeilen im Journal sind nicht lesbar. Sie bleiben unverändert `
      + 'erhalten, lassen sich aber nicht anzeigen und nicht zurücknehmen.')));
  }
  if (stats && stats.failedWrites > 0) {
    dom.histFoot.appendChild(h('p.tlv__hist-reason', null, text(
      `${formatNumber(stats.failedWrites)} Änderungen konnten nicht aufgezeichnet werden. `
      + 'Diese Liste ist seitdem nicht vollständig.')));
  }
}

/** Join class names for `h()` without pulling `cx` in for two call sites. */
function cxClasses(...names) {
  return names.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* Styles (see decision 5 in views/graph.js: a view owns its layout)   */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-timeline-view-style';

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS; // authored here, never user data
  document.head.appendChild(node);
}

const CSS = `
.main[data-view="timeline"] { overflow: hidden; }
.tlv { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tlv__bar {
  display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap;
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface); border-bottom: 1px solid var(--border);
}
.tlv__bar--filters { gap: var(--sp-05); padding-top: var(--sp-05); padding-bottom: var(--sp-05); }
.tlv__search { position: relative; display: flex; align-items: center; }
.tlv__search .input { width: 15rem; padding-left: 30px; }
.tlv__search-icon {
  position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
  color: var(--fg-subtle); pointer-events: none;
}
.tlv__search-icon svg { width: 15px; height: 15px; }
.tlv__range { font-size: var(--fs-sm); color: var(--fg); font-variant-numeric: tabular-nums; }
.tlv__status { font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }

.tlv__type {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px var(--sp-1); background: none;
  border: 1px solid transparent; border-radius: var(--r-full);
  color: var(--fg-muted); font: inherit; font-size: var(--fs-sm); cursor: pointer;
  opacity: 0.55;
}
.tlv__type:hover { background: var(--surface-3); }
.tlv__type.is-active { opacity: 1; color: var(--fg); border-color: var(--border); }
.tlv__glyph { width: 12px; height: 12px; flex: 0 0 auto; display: block; }
.tlv__type-count { font-variant-numeric: tabular-nums; color: var(--fg-subtle); }

.tlv__body { display: flex; flex: 1 1 auto; min-height: 0; }
.tlv__stage { position: relative; flex: 1 1 auto; min-width: 0; background: var(--bg); }
.tlv__canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }
.tlv__canvas:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: -2px; }

.tlv__tooltip {
  position: absolute; z-index: 4; pointer-events: none;
  display: flex; flex-direction: column; gap: 2px;
  max-width: 22rem; padding: 6px 8px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-2); box-shadow: var(--shadow-2);
  font-size: var(--fs-sm);
}
.tlv__tooltip-title { font-weight: 600; word-break: break-word; }
.tlv__tooltip-meta { color: var(--fg-muted); font-size: var(--fs-xs); }

.tlv__selbar {
  position: absolute; left: var(--sp-2); right: var(--sp-2); bottom: var(--sp-2); z-index: 3;
  display: flex; align-items: flex-start; gap: var(--sp-2); flex-wrap: wrap;
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--r-2); box-shadow: var(--shadow-2);
}
.tlv__selbar-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 16rem; }
.tlv__selbar-actions { display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; }
.tlv__selbar-note { flex: 1 1 100%; margin: 0; color: var(--fg-subtle); font-size: var(--fs-xs); }

.tlv__stage-state {
  position: absolute; inset: 0; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  padding: var(--sp-3); background: var(--bg);
}

/* The two panels share one column: the tab bar stays put, the panel below it
   scrolls on its own, and the hidden one keeps its scroll position. */
.tlv__side {
  flex: 0 0 22rem; width: 22rem; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); border-left: 1px solid var(--border);
}
.tlv__side-tabbar {
  flex: 0 0 auto; padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border);
}
.tlv__side-tabs { display: flex; width: 100%; }
.tlv__side-tabs .segmented__option { flex: 1 1 0; text-align: center; }
.tlv__side-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: var(--sp-2); }
.tlv__side-head { display: flex; align-items: flex-start; gap: var(--sp-1); margin-bottom: var(--sp-1); }
.tlv__side-title { font-size: var(--fs-md); line-height: var(--lh-tight); word-break: break-word; }
.tlv__hint { color: var(--fg-subtle); font-size: var(--fs-sm); }
/* The stack already spaces its children; the rule's own margin doubles it. */
.tlv__side .divider { margin: 0; }

.tlv__pick { width: 100%; background: none; border: 0; border-bottom: 1px solid var(--border); text-align: left; color: inherit; font: inherit; }
.tlv__pick-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tlv__pick-title { word-break: break-word; }

.tlv__edge {
  display: flex; align-items: flex-start; gap: var(--sp-1);
  padding: var(--sp-1) 0; border-top: 1px solid var(--border);
}
.tlv__edge-main { flex: 1 1 auto; min-width: 0; }
.tlv__edge-target {
  display: block; width: 100%; padding: 0; text-align: left; background: none; border: 0;
  color: var(--fg); font-weight: 500; cursor: pointer; word-break: break-word;
}
.tlv__edge-target:hover { color: var(--accent); }
.tlv__edge-reason { margin: 2px 0 0; color: var(--fg-subtle); font-size: var(--fs-sm); word-break: break-word; }

/* --- „Letzte Änderungen" ---------------------------------------- */
.tlv__hist { display: flex; flex-direction: column; gap: var(--sp-1); }
.tlv__hist-filters { display: flex; flex-wrap: wrap; gap: var(--sp-05); align-items: center; }
.tlv__hist-filter {
  flex: 1 1 12rem;
  padding: 4px var(--sp-1); background: none;
  border: 1px solid var(--border); border-radius: var(--r-full);
  color: var(--fg-muted); font: inherit; font-size: var(--fs-sm); text-align: left; cursor: pointer;
}
.tlv__hist-filter:hover { background: var(--surface-3); }
.tlv__hist-filter.is-active {
  color: var(--accent); background: var(--accent-soft); border-color: var(--accent);
}
.tlv__hist-type { flex: 1 1 8rem; width: auto; min-width: 8rem; font-size: var(--fs-sm); }
.tlv__hist-summary { margin: 0; font-variant-numeric: tabular-nums; }
.tlv__hist-list { display: flex; flex-direction: column; }
.tlv__hist-more { display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; }

.tlv__hist-row {
  display: flex; flex-direction: column; gap: 3px;
  padding: var(--sp-1) 0; border-top: 1px solid var(--border);
}
.tlv__hist-row.is-undone { opacity: 0.72; }
.tlv__hist-who { display: flex; align-items: center; gap: var(--sp-05); flex-wrap: wrap; }
.tlv__hist-badge--guess { border: 1px dashed var(--border-strong); }
.tlv__hist-run {
  padding: 0; background: none; border: 0; color: var(--accent);
  font: inherit; font-size: var(--fs-sm); text-decoration: underline; cursor: pointer;
}
.tlv__hist-label { margin: 0; font-weight: 500; word-break: break-word; }
.tlv__hist-guess { margin: 0; color: var(--fg-subtle); font-size: var(--fs-xs); }
.tlv__hist-reason { margin: 2px 0 0; color: var(--fg-muted); font-size: var(--fs-sm); word-break: break-word; }
.tlv__hist-actions { display: flex; align-items: center; gap: var(--sp-05); flex-wrap: wrap; margin-top: 2px; }
.tlv__hist-id { margin: 0; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-muted); word-break: break-all; }

.tlv__hist-note {
  display: flex; flex-direction: column; gap: 3px;
  margin-top: var(--sp-05); padding: var(--sp-1);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--r-1); font-size: var(--fs-sm);
}
.tlv__hist-note p { margin: 0; word-break: break-word; }
.tlv__hist-note--warn { border-color: var(--warn); background: var(--surface-3); }
.tlv__hist-note--bad { border-color: var(--danger); background: var(--danger-soft); }
.tlv__hist-note--done { border-color: var(--accent); background: var(--accent-soft); }
.tlv__hist-foot { display: flex; flex-direction: column; gap: var(--sp-05); margin-top: var(--sp-1); }
.tlv__hist-foot .divider { margin: 0 0 var(--sp-05); }

@media (max-width: 820px) {
  .tlv__body { flex-direction: column; }
  .tlv__side { flex: 0 0 45%; width: auto; border-left: 0; border-top: 1px solid var(--border); }
  .tlv__search .input { width: 9rem; }
}
`;
