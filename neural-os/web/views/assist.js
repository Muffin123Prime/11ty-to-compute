/**
 * views/assist.js -- "Vorschläge": what the system noticed, and nothing it did.
 *
 * The decisions behind it
 * -----------------------
 * 1. **Proposing and deciding are two different jobs, and they belong to two
 *    different parties.** The system may look through the vault and say "this
 *    looks like a duplicate"; it may not act on that. Every card therefore
 *    reads as a sentence in the subjunctive -- *what would happen* -- with two
 *    buttons underneath. Nothing on this screen changes a single record until
 *    someone presses "Übernehmen".
 * 2. **The consequence is shown before the click, in German.** `data.action`
 *    is a machine object; a user cannot consent to `{"op":"addTags",…}`. So it
 *    is rendered as one plain sentence naming the record and the change. When
 *    the sentence cannot be built -- an action shape this view does not know --
 *    the card says exactly that instead of guessing, and the raw object is one
 *    disclosure away. "Details" always shows the real object, for the people
 *    who would rather read it than trust the translation.
 * 3. **Confidence is never dressed up as certainty.** The number the detector
 *    produced is a self-assessment of a heuristic, not a measurement, and it is
 *    labelled that way: 0.5 appears as "unsicher (50 %)", never as a green
 *    tick. A bar that filled to half and stayed silent would read as approval.
 * 4. **"Prüfen" reports what really happened, skipped detectors included.** A
 *    scan that silently drops half its detectors -- no embedding model, vault
 *    locked -- and then says "3 neue Vorschläge" has told a half-truth. The
 *    report lists every skipped detector with the server's own reason.
 * 5. **After accepting, the card shows `applied`, not the plan.** What the
 *    server says it did wins over what the suggestion said it would do; those
 *    two can differ (tags that were already there, a record deleted in the
 *    meantime). Undo is offered only where it genuinely exists: removing tags
 *    this accept really added is a real reversal through
 *    `PATCH /api/records/:id`; un-creating a note is not something this view
 *    can promise, so it says so and links to the note instead.
 * 6. **An empty list is three different facts.** "Noch nie nachgesehen",
 *    "nachgesehen und nichts gefunden" and "der Teil des Systems fehlt" look
 *    identical if you only count rows. They are kept apart here, because the
 *    first one is a to-do, the second is good news and the third is a defect.
 */

import {
  h, text, clear, on, icon, timeAgo, formatDateTime, formatNumber,
} from '../lib/dom.js';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-assist-view-style';

const VIEW_ICON = '<path d="M10 2.6a4.9 4.9 0 0 0-2.8 8.9v2.1h5.6v-2.1A4.9 4.9 0 0 0 10 2.6z"/><path d="M8.3 16.2h3.4M8.8 17.9h2.4"/>';

const ICONS = {
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  close: '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>',
  scan: '<circle cx="8.8" cy="8.8" r="5.2"/><path d="m12.7 12.7 4 4"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  arrow: '<path d="M3.8 10h11.4M11 5.8l4.2 4.2-4.2 4.2"/>',
  undo: '<path d="M3.4 10a6.6 6.6 0 1 0 2.1-4.8"/><path d="M3.1 3v3.7h3.7"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
};

/**
 * The six detectors, in the order they are offered as filters.
 *
 * `label` is the badge; `blurb` is the one sentence that says what this kind of
 * suggestion is about, shown in the filter's title so the vocabulary never has
 * to be guessed from three examples.
 */
const KINDS = [
  { value: 'duplicate', label: 'Doppelt', blurb: 'Zwei Einträge, die denselben Inhalt zu haben scheinen.' },
  { value: 'orphan', label: 'Verwaist', blurb: 'Ein Eintrag ohne jede Verknüpfung – von nirgendwo erreichbar.' },
  { value: 'tag', label: 'Schlagwort', blurb: 'Ein Schlagwort, das zu diesem Eintrag zu passen scheint.' },
  { value: 'task', label: 'Aufgabe', blurb: 'Ein Satz, der wie eine offene Aufgabe klingt.' },
  { value: 'revisit', label: 'Wiedervorlage', blurb: 'Etwas, das lange liegt und eine erneute Durchsicht verdient.' },
  { value: 'link', label: 'Fehlender Link', blurb: 'Zwei Einträge, die voneinander wissen sollten.' },
];

const KIND_LABEL = Object.fromEntries(KINDS.map((entry) => [entry.value, entry.label]));

const STATUSES = [
  { value: 'open', label: 'Offen', empty: 'Es ist kein Vorschlag offen.' },
  { value: 'accepted', label: 'Übernommen', empty: 'Es wurde noch kein Vorschlag übernommen.' },
  { value: 'dismissed', label: 'Verworfen', empty: 'Es wurde noch kein Vorschlag verworfen.' },
  { value: 'stale', label: 'Veraltet', empty: 'Es ist kein Vorschlag veraltet.' },
];

const STATUS_LABEL = Object.fromEntries(STATUSES.map((entry) => [entry.value, entry.label]));

/** Singular nouns per record type, as in views/search.js. */
const SINGULAR = {
  note: 'Notiz', chat: 'Chat', message: 'Nachricht', project: 'Projekt',
  task: 'Aufgabe', entity: 'Begriff', file: 'Datei', agent: 'Agent',
  run: 'Lauf', memory: 'Erinnerung', edge: 'Verknüpfung', suggestion: 'Vorschlag',
};

/** "… fügt DER NOTIZ …" -- the dative the action sentences need. */
const DATIVE = {
  note: 'der Notiz', chat: 'dem Chat', message: 'der Nachricht', project: 'dem Projekt',
  task: 'der Aufgabe', entity: 'dem Begriff', file: 'der Datei', agent: 'dem Agenten',
  run: 'dem Lauf', memory: 'der Erinnerung',
};

const LIMIT = 100;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

/** True when the server said "this part of the system is not here". */
function isUnavailable(err) {
  return !!err && (err.status === 503 || err.code === 'SUBSYSTEM_UNAVAILABLE');
}

function dataOf(record) {
  return (record && record.data) || {};
}

function typeOfId(id) {
  const raw = String(id || '');
  const cut = raw.indexOf('_');
  return cut > 0 ? raw.slice(0, cut) : '';
}

/** A display title for any record, never an empty string. */
function labelOf(record) {
  const data = dataOf(record);
  const candidate = data.title || data.name || data.goal || data.label
    || (typeof data.text === 'string' ? data.text.slice(0, 80) : '')
    || (typeof data.content === 'string' ? data.content.slice(0, 80) : '');
  const value = String(candidate || '').trim();
  if (value) return value;
  return `${SINGULAR[record.type] || record.type} ${record.id}`;
}

/** Where a record lives in this application (same map as views/search.js). */
function targetFor(type, id) {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case 'note': return `#/notes?id=${encoded}`;
    case 'chat': return `#/chat?id=${encoded}`;
    case 'project':
    case 'task': return `#/projects?id=${encoded}`;
    case 'agent':
    case 'run': return `#/agents?id=${encoded}`;
    default: return `#/graph?focus=${encoded}`;
  }
}

/**
 * Confidence, said out loud.
 *
 * The scale is deliberately pessimistic in its wording: the middle of the range
 * is "unsicher", not "mittel", because a heuristic that is half sure about
 * merging two notes is not a recommendation.
 */
function confidenceInfo(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { level: 'unknown', label: 'ohne Einschätzung', percent: null, ratio: 0 };
  }
  const ratio = Math.max(0, Math.min(1, n));
  const percent = Math.round(ratio * 100);
  if (ratio >= 0.85) return { level: 'high', label: 'ziemlich sicher', percent, ratio };
  if (ratio >= 0.65) return { level: 'medium', label: 'eher wahrscheinlich', percent, ratio };
  if (ratio >= 0.4) return { level: 'low', label: 'unsicher', percent, ratio };
  return { level: 'vague', label: 'sehr unsicher', percent, ratio };
}

function tagList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry || '').trim().replace(/^#/, '')).filter(Boolean);
}

function joinGerman(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'assist',
  title: 'Vorschläge',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyle();
    teardown(); // a failed unmount must not leave two views on one bus

    const params = (ctx.route && ctx.route.params) || {};
    const wantedStatus = typeof params.status === 'string' && STATUS_LABEL[params.status] ? params.status : 'open';
    const wantedKind = typeof params.kind === 'string' && KIND_LABEL[params.kind] ? params.kind : '';

    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      container,
      cleanups: [],
      requests: new Set(),
      dom: {},

      status: wantedStatus,
      kind: wantedKind,

      items: [],
      total: 0,
      loading: true,
      loadError: null,
      unavailable: null, // the ApiError that said 503, kept for its message

      stats: null,
      statsError: null,

      detectors: [],
      detectorsError: null,

      scan: { busy: false, startedAt: 0, seconds: 0, result: null, error: null },
      scanTimer: null,

      /** id -> {busy, applied, error, undo} for suggestions decided here. */
      decisions: new Map(),
      /**
       * Suggestions decided in this session, kept on screen after they have
       * left the current filter. Accepting must not make the card vanish
       * before it has said what the accept actually did.
       */
      recent: new Map(),
      /** recordId -> record | null (null = looked up, does not exist). */
      records: new Map(),
      pendingRecords: new Set(),
      /** Suggestion ids whose "Details" disclosure the user opened. */
      openDetails: new Set(),

      cursor: -1,
      listSeq: 0,
    };
    view = self;

    buildLayout(self);
    subscribe(self);

    await Promise.all([loadSuggestions(self), loadStats(self), loadDetectors(self)]);
    if (!self.alive) return;
    renderAll(self);
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
  if (self.scanTimer) clearInterval(self.scanTimer);
  self.scanTimer = null;
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

async function loadSuggestions(self, opts = {}) {
  const token = ++self.listSeq;
  if (!opts.quiet) self.loading = true;
  const query = { status: self.status, limit: LIMIT, offset: 0 };
  if (self.kind) query.kind = self.kind;

  try {
    const result = await request(self, (signal) => self.api.get('/assist/suggestions', { query, signal }));
    if (!self.alive || token !== self.listSeq) return;
    const items = Array.isArray(result && result.items) ? result.items : [];
    self.items = items.filter((item) => item && item.id);
    self.total = Number.isFinite(result && result.total) ? result.total : self.items.length;
    self.loadError = null;
    self.unavailable = null;
    resolveReferencedRecords(self);
  } catch (err) {
    if (!self.alive || token !== self.listSeq || (err && err.isAborted)) return;
    self.items = [];
    self.total = 0;
    if (isUnavailable(err)) {
      self.unavailable = err;
      self.loadError = null;
    } else {
      self.unavailable = null;
      self.loadError = err;
    }
  } finally {
    if (self.alive && token === self.listSeq) self.loading = false;
  }
}

async function loadStats(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/assist/stats', { signal }));
    if (!self.alive) return;
    self.stats = result && typeof result === 'object' ? result : null;
    self.statsError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    // Counts we cannot read are shown as "unbekannt", never as zero.
    self.stats = null;
    self.statsError = err;
  }
}

async function loadDetectors(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/assist/detectors', { signal }));
    if (!self.alive) return;
    self.detectors = Array.isArray(result && result.items) ? result.items : [];
    self.detectorsError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.detectors = [];
    self.detectorsError = err;
  }
}

/**
 * Fetch the titles of the records the visible suggestions talk about.
 *
 * A suggestion carries ids, not titles, and "Fügt dem Eintrag note_7f3a… ein
 * Schlagwort hinzu" is not a sentence anyone can decide on. Each id is looked
 * up once; a 404 is remembered as `null`, which the card then reports as
 * "existiert nicht mehr" rather than silently dropping the reference.
 */
function resolveReferencedRecords(self) {
  const wanted = new Set();
  for (const item of self.items) {
    for (const id of referencedIds(item)) {
      if (!self.records.has(id) && !self.pendingRecords.has(id)) wanted.add(id);
    }
  }
  for (const id of wanted) {
    self.pendingRecords.add(id);
    request(self, (signal) => self.api.get(`/records/${encodeURIComponent(id)}`, { signal }))
      .then((result) => {
        if (!self.alive) return;
        self.records.set(id, (result && result.record) || null);
      })
      .catch(() => {
        if (!self.alive) return;
        self.records.set(id, null);
      })
      .finally(() => {
        if (!self.alive) return;
        self.pendingRecords.delete(id);
        if (!self.pendingRecords.size) renderList(self);
      });
  }
}

/** Ids a suggestion refers to: its records plus whatever its action names. */
function referencedIds(item) {
  const data = dataOf(item);
  const out = new Set();
  for (const id of Array.isArray(data.recordIds) ? data.recordIds : []) {
    if (typeof id === 'string' && id) out.add(id);
  }
  const action = data.action;
  if (action && typeof action === 'object') {
    for (const key of ['recordId', 'targetId', 'sourceId', 'from', 'to', 'keep', 'drop', 'noteId', 'taskId', 'projectId']) {
      const value = action[key];
      if (typeof value === 'string' && /^[a-z]+_/.test(value)) out.add(value);
    }
  }
  return out;
}

/** The title for an id, or the id itself when it is not (yet) known. */
function titleOf(self, id) {
  if (!id) return '';
  const record = self.records.get(id);
  if (record) return labelOf(record);
  return String(id);
}

function subjectOf(self, id) {
  const record = self.records.get(id);
  const type = record ? record.type : typeOfId(id);
  const dative = DATIVE[type] || 'dem Eintrag';
  return `${dative} «${titleOf(self, id)}»`;
}

/* ------------------------------------------------------------------ */
/* Live events                                                         */
/* ------------------------------------------------------------------ */

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;

  self.cleanups.push(ctx.bus.on('assist.scanned', (payload) => {
    if (!self.alive) return;
    // A scan started elsewhere (an agent, another tab) changes this list too.
    if (!self.scan.busy) applyScanReport(self, payload);
    refreshAfterChange(self);
  }));

  self.cleanups.push(ctx.bus.on('assist.decided', () => {
    if (!self.alive) return;
    refreshAfterChange(self);
  }));
}

async function refreshAfterChange(self) {
  await Promise.all([loadSuggestions(self, { quiet: true }), loadStats(self)]);
  if (!self.alive) return;
  renderAll(self);
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.scanButton = h('button.btn.btn--primary', {
    type: 'button',
    onClick: () => runScan(self),
  }, icon(ICONS.scan), text('Prüfen'));

  dom.reloadButton = h('button.btn', {
    type: 'button',
    title: 'Liste und Zählwerte neu vom Server lesen',
    onClick: () => refreshAfterChange(self),
  }, icon(ICONS.refresh), text('Neu laden'));

  dom.stats = h('div.asv__stats');
  dom.scanPanel = h('div.asv__scan', { 'aria-live': 'polite' });
  dom.statusFilter = h('div.asv__filter', { role: 'radiogroup', 'aria-label': 'Nach Stand filtern' });
  dom.kindFilter = h('div.asv__filter.asv__filter--kinds', { role: 'radiogroup', 'aria-label': 'Nach Art filtern' });
  dom.list = h('div.asv__list');

  dom.root = h('div.asv.page', null,
    h('header.page__head', null,
      h('div', null,
        h('h1.page__title', null, text('Vorschläge')),
        h('p.page__subtitle', null, text('Das System sieht sich deine Einträge an und schlägt etwas vor. '
          + 'Geschehen tut davon nichts, bis du auf „Übernehmen“ drückst.'))),
      h('div.page__actions', null, dom.reloadButton, dom.scanButton)),
    dom.stats,
    dom.scanPanel,
    h('div.asv__filters', null,
      h('div.asv__filter-group', null,
        h('span.label', { id: 'asv-status-label' }, text('Stand')),
        dom.statusFilter),
      h('div.asv__filter-group', null,
        h('span.label', { id: 'asv-kind-label' }, text('Art')),
        dom.kindFilter)),
    h('p.asv__legend.hint', null, text('Die Sicherheit an jedem Vorschlag ist die Selbsteinschätzung der Regel, '
      + 'die ihn erzeugt hat – kein Messwert. Mit ↑ ↓ springst du zwischen den Vorschlägen.')),
    dom.list);

  container.appendChild(dom.root);
  dom.statusFilter.setAttribute('aria-labelledby', 'asv-status-label');
  dom.kindFilter.setAttribute('aria-labelledby', 'asv-kind-label');

  self.cleanups.push(on(dom.root, 'keydown', (event) => onViewKey(self, event)));
}

/* ------------------------------------------------------------------ */
/* Scanning                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run a scan.
 *
 * The duration of a scan is not predictable from here -- it depends on how many
 * records there are and whether an embedding model answers -- so the busy state
 * counts real elapsed seconds instead of animating a percentage nothing has
 * measured.
 */
async function runScan(self) {
  if (self.scan.busy) return;
  self.scan = { busy: true, startedAt: Date.now(), seconds: 0, result: null, error: null };
  renderScanPanel(self);
  renderHeadActions(self);

  if (self.scanTimer) clearInterval(self.scanTimer);
  self.scanTimer = setInterval(() => {
    if (!self.alive || !self.scan.busy) return;
    self.scan.seconds = Math.round((Date.now() - self.scan.startedAt) / 1000);
    renderScanPanel(self);
  }, 1000);

  const body = {};
  if (self.kind) body.kinds = [self.kind];

  try {
    // A scan may walk the whole vault; the default 30 s timeout is too short.
    const result = await request(self, (signal) => self.api.post('/assist/scan', body, { signal, timeoutMs: 180000 }));
    if (!self.alive) return;
    applyScanReport(self, result);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.scan.result = null;
    self.scan.error = err;
  } finally {
    if (self.scanTimer) clearInterval(self.scanTimer);
    self.scanTimer = null;
    if (self.alive) {
      self.scan.busy = false;
      renderScanPanel(self);
      renderHeadActions(self);
      await refreshAfterChange(self);
    }
  }
}

/**
 * Accept a scan report only when it really is one.
 *
 * `assist.scanned` may arrive over the bus with a payload this view knows
 * nothing about. Storing that as the report would paint "0 neu, 0 aufgefrischt,
 * keine Prüfung übersprungen" on the screen -- four claims nobody made.
 */
function applyScanReport(self, report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return;
  const looksLikeReport = ['created', 'refreshed', 'stale', 'scannedAt', 'byKind', 'skipped', 'durationMs']
    .some((key) => report[key] !== undefined);
  if (!looksLikeReport) return;
  self.scan.result = report;
  self.scan.error = null;
}

/* ------------------------------------------------------------------ */
/* Deciding                                                            */
/* ------------------------------------------------------------------ */

/**
 * The record as it stands after the decision.
 *
 * The server's own answer wins; only when it does not send the record back is
 * the status patched locally, so the card cannot claim a `decidedAt` the
 * server never wrote.
 */
function decidedCopy(item, fromServer, status) {
  if (fromServer && fromServer.id === item.id && fromServer.data) return fromServer;
  return { ...item, data: { ...dataOf(item), status } };
}

function decisionOf(self, id) {
  let entry = self.decisions.get(id);
  if (!entry) {
    entry = { busy: false, applied: null, error: null, undo: null };
    self.decisions.set(id, entry);
  }
  return entry;
}

async function acceptSuggestion(self, item) {
  const entry = decisionOf(self, item.id);
  if (entry.busy) return;
  entry.busy = true;
  entry.error = null;
  renderList(self);
  try {
    const result = await request(self, (signal) => self.api.post(`/assist/suggestions/${encodeURIComponent(item.id)}/accept`, {}, { signal, timeoutMs: 60000 }));
    if (!self.alive) return;
    entry.applied = (result && result.applied) || { op: 'none' };
    entry.undo = buildUndo(self, entry.applied);
    self.recent.set(item.id, decidedCopy(item, result && result.suggestion, 'accepted'));
    self.ctx.toast('Vorschlag übernommen.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    entry.applied = null;
    entry.error = err;
  } finally {
    if (self.alive) {
      entry.busy = false;
      await refreshAfterChange(self);
    }
  }
}

async function dismissSuggestion(self, item) {
  const entry = decisionOf(self, item.id);
  if (entry.busy) return;
  entry.busy = true;
  entry.error = null;
  renderList(self);
  try {
    const result = await request(self, (signal) => self.api.post(`/assist/suggestions/${encodeURIComponent(item.id)}/dismiss`, {}, { signal }));
    if (!self.alive) return;
    entry.applied = null;
    self.recent.set(item.id, decidedCopy(item, result && result.suggestion, 'dismissed'));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    entry.error = err;
  } finally {
    if (self.alive) {
      entry.busy = false;
      await refreshAfterChange(self);
    }
  }
}

async function deleteSuggestion(self, item) {
  const ok = await self.ctx.confirm({
    title: 'Vorschlag löschen?',
    message: 'Der Vorschlag verschwindet aus der Liste. An deinen Einträgen ändert das nichts – '
      + 'eine erneute Prüfung kann ihn wieder erzeugen.',
    confirmLabel: 'Löschen',
    danger: true,
  });
  if (!ok || !self.alive) return;
  const entry = decisionOf(self, item.id);
  entry.busy = true;
  renderList(self);
  try {
    await request(self, (signal) => self.api.del(`/assist/suggestions/${encodeURIComponent(item.id)}`, { signal }));
    if (!self.alive) return;
    self.decisions.delete(item.id);
    self.recent.delete(item.id);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    entry.error = err;
    entry.busy = false;
  } finally {
    if (self.alive) await refreshAfterChange(self);
  }
}

/**
 * An undo, but only a real one.
 *
 * The single case this view can genuinely reverse is `addTags`: the server
 * reports the tags it actually added (not the ones it was asked to add), and
 * removing exactly those through `PATCH /api/records/:id` restores the record
 * to what it was. Everything else -- a created note, a drawn edge -- would be
 * an undo this view cannot promise, so none is offered and the card says why.
 */
function buildUndo(self, applied) {
  if (!applied || typeof applied !== 'object') return null;
  const op = String(applied.op || '');
  if (op !== 'addTags') return null;
  const recordId = typeof applied.recordId === 'string' ? applied.recordId : '';
  const added = tagList(applied.added);
  if (!recordId || !added.length) return null;
  return {
    label: added.length === 1 ? 'Schlagwort wieder entfernen' : 'Schlagwörter wieder entfernen',
    run: async () => {
      const current = await request(self, (signal) => self.api.get(`/records/${encodeURIComponent(recordId)}`, { signal }));
      const record = current && current.record;
      if (!record) throw new Error('Der Eintrag ist nicht mehr da.');
      const remaining = tagList(dataOf(record).tags).filter((tag) => !added.includes(tag));
      await request(self, (signal) => self.api.patch(`/records/${encodeURIComponent(recordId)}`, { data: { tags: remaining } }, { signal }));
      self.records.set(recordId, null); // force a fresh title/tag read
    },
  };
}

async function runUndo(self, item, entry) {
  if (!entry.undo || entry.busy) return;
  entry.busy = true;
  entry.error = null;
  renderList(self);
  try {
    await entry.undo.run();
    if (!self.alive) return;
    entry.undo = null;
    entry.undone = true;
    self.ctx.toast('Die Änderung wurde zurückgenommen.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    entry.error = err;
  } finally {
    if (self.alive) {
      entry.busy = false;
      resolveReferencedRecords(self);
      renderList(self);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Describing an action in German                                      */
/* ------------------------------------------------------------------ */

/**
 * Turn `data.action` into one sentence, or return `null`.
 *
 * `null` is a legitimate answer and the card renders it as such. Inventing a
 * plausible-sounding sentence for an action shape this view does not know
 * would be exactly the wrong failure: the user would consent to the sentence,
 * not to the action.
 */
function describeAction(self, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const op = String(action.op || action.type || action.kind || '').trim();

  switch (op) {
    case 'addTags': {
      const tags = tagList(action.tags || action.added || action.values);
      const recordId = action.recordId || action.targetId;
      if (!tags.length || !recordId) return null;
      const list = joinGerman(tags.map((tag) => `#${tag}`));
      return tags.length === 1
        ? `Fügt ${subjectOf(self, recordId)} das Schlagwort ${list} hinzu.`
        : `Fügt ${subjectOf(self, recordId)} die Schlagwörter ${list} hinzu.`;
    }
    case 'createTask': {
      const title = String(action.title || action.goal || '').trim();
      if (!title) return null;
      const from = action.recordId || action.sourceId;
      return from
        ? `Legt die Aufgabe «${title}» an und verknüpft sie mit ${subjectOf(self, from)}.`
        : `Legt die Aufgabe «${title}» an.`;
    }
    case 'createNote': {
      const title = String(action.title || '').trim();
      const from = action.recordId || action.sourceId;
      if (!title) return null;
      return from
        ? `Legt die Notiz «${title}» an und verknüpft sie mit ${subjectOf(self, from)}.`
        : `Legt die Notiz «${title}» an.`;
    }
    case 'link': {
      const from = action.from || action.sourceId || action.recordId;
      const to = action.to || action.targetId;
      if (!from || !to) return null;
      return `Verknüpft ${subjectOf(self, from)} mit ${subjectOf(self, to)}.`;
    }
    case 'none':
      return action.note
        ? `Ändert nichts an deinen Einträgen. ${String(action.note)}`
        : 'Ändert nichts an deinen Einträgen – der Vorschlag wird nur abgehakt.';
    default:
      return null;
  }
}

/** The same job for the server's `applied` report, in the past tense. */
function describeApplied(self, applied) {
  if (!applied || typeof applied !== 'object') return 'Der Server hat nicht mitgeteilt, was geschehen ist.';
  const op = String(applied.op || '');
  switch (op) {
    case 'addTags': {
      const added = tagList(applied.added);
      if (!added.length) {
        return 'Es wurde kein Schlagwort hinzugefügt – alle waren schon vorhanden.';
      }
      const list = joinGerman(added.map((tag) => `#${tag}`));
      const where = applied.recordId ? ` an ${subjectOf(self, applied.recordId)}` : '';
      return added.length === 1
        ? `Das Schlagwort ${list} wurde${where} ergänzt.`
        : `Die Schlagwörter ${list} wurden${where} ergänzt.`;
    }
    case 'createTask':
      return 'Die Aufgabe wurde angelegt.';
    case 'createNote':
      return applied.edgeId
        ? 'Die Notiz wurde angelegt und verknüpft.'
        : 'Die Notiz wurde angelegt.';
    case 'link':
      return 'Die Verknüpfung wurde angelegt.';
    case 'none':
      return applied.note
        ? `Es wurde nichts geändert. ${String(applied.note)}`
        : 'Es wurde nichts geändert.';
    default:
      return op
        ? `Der Server meldet den Vorgang „${op}“. Was er genau bewirkt hat, steht unten in den Einzelheiten.`
        : 'Der Server hat den Vorgang nicht benannt. Die Einzelheiten stehen unten.';
  }
}

/** Records the accept produced, so the card can link to them. */
function producedLinks(applied) {
  if (!applied || typeof applied !== 'object') return [];
  const out = [];
  if (typeof applied.taskId === 'string' && applied.taskId) out.push({ id: applied.taskId, label: 'Aufgabe öffnen' });
  if (typeof applied.noteId === 'string' && applied.noteId) out.push({ id: applied.noteId, label: 'Notiz öffnen' });
  if (typeof applied.recordId === 'string' && applied.recordId && applied.op === 'addTags') {
    out.push({ id: applied.recordId, label: 'Eintrag öffnen' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll(self) {
  renderHeadActions(self);
  renderStats(self);
  renderScanPanel(self);
  renderFilters(self);
  renderList(self);
}

function renderHeadActions(self) {
  const { dom } = self;
  dom.scanButton.disabled = self.scan.busy || !!self.unavailable;
  dom.reloadButton.disabled = self.scan.busy;
  clear(dom.scanButton);
  if (self.scan.busy) {
    dom.scanButton.appendChild(h('span.spinner', { 'aria-hidden': 'true' }));
    dom.scanButton.appendChild(text('Prüft …'));
  } else {
    dom.scanButton.appendChild(icon(ICONS.scan));
    dom.scanButton.appendChild(text(self.kind ? `Nur „${KIND_LABEL[self.kind]}“ prüfen` : 'Prüfen'));
  }
}

function renderStats(self) {
  const box = self.dom.stats;
  clear(box);
  if (self.unavailable) return;

  if (self.statsError) {
    box.appendChild(h('p.meta', null, text(`Die Zählwerte sind nicht abrufbar: ${errorMessage(self.statsError)}`)));
    return;
  }
  if (!self.stats) return;

  const cells = [
    ['open', 'offen'],
    ['accepted', 'übernommen'],
    ['dismissed', 'verworfen'],
    ['stale', 'veraltet'],
  ];
  for (const [key, label] of cells) {
    const value = self.stats[key];
    box.appendChild(h('div.asv__stat', { dataset: { key } },
      h('span.asv__stat-value', null, text(Number.isFinite(value) ? formatNumber(value) : 'unbekannt')),
      h('span.asv__stat-label', null, text(label))));
  }
}

function renderScanPanel(self) {
  const box = self.dom.scanPanel;
  clear(box);

  if (self.scan.busy) {
    box.appendChild(h('div.asv__panel', { role: 'status' },
      h('div.row', null,
        h('span.spinner', { 'aria-hidden': 'true' }),
        h('strong', null, text('Die Einträge werden durchgesehen …'))),
      h('p.meta', null, text(self.scan.seconds > 0
        ? `Läuft seit ${self.scan.seconds} Sekunden. Wie lange es dauert, hängt davon ab, wie viel im Tresor liegt – deshalb steht hier kein Prozentwert.`
        : 'Wie lange es dauert, hängt davon ab, wie viel im Tresor liegt – deshalb steht hier kein Prozentwert.'))));
    return;
  }

  if (self.scan.error) {
    box.appendChild(h('div.asv__panel.asv__panel--danger', { role: 'alert' },
      h('div.row', null, icon(ICONS.alert), h('strong', null, text('Die Prüfung ist fehlgeschlagen.'))),
      h('p', null, text(errorMessage(self.scan.error))),
      h('button.btn.btn--small', { type: 'button', onClick: () => runScan(self) }, text('Noch einmal versuchen'))));
    return;
  }

  const report = self.scan.result;
  if (!report) return;

  const created = Number(report.created) || 0;
  const refreshed = Number(report.refreshed) || 0;
  const stale = Number(report.stale) || 0;
  const skipped = Array.isArray(report.skipped) ? report.skipped : [];

  const panel = h('div.asv__panel');
  panel.appendChild(h('div.row', null,
    icon(ICONS.check),
    h('strong', null, text(report.scannedAt
      ? `Geprüft am ${formatDateTime(report.scannedAt)}`
      : 'Prüfung abgeschlossen')),
    Number.isFinite(report.durationMs)
      ? h('span.meta', null, text(`· ${formatNumber(Math.round(report.durationMs))} ms`))
      : null));

  panel.appendChild(h('ul.asv__report', { role: 'list' },
    h('li', null, text(created === 1 ? '1 neuer Vorschlag' : `${formatNumber(created)} neue Vorschläge`)),
    h('li', null, text(refreshed === 1 ? '1 vorhandener aufgefrischt' : `${formatNumber(refreshed)} vorhandene aufgefrischt`)),
    h('li', null, text(stale === 1 ? '1 als veraltet markiert' : `${formatNumber(stale)} als veraltet markiert`))));

  const byKind = report.byKind && typeof report.byKind === 'object' ? report.byKind : null;
  const kindRows = byKind
    ? Object.entries(byKind).filter(([, value]) => Number(value) > 0)
    : [];
  if (kindRows.length) {
    panel.appendChild(h('p.asv__report-kinds.meta', null,
      text(`Nach Art: ${kindRows.map(([key, value]) => `${KIND_LABEL[key] || key} ${formatNumber(value)}`).join(' · ')}`)));
  }

  if (skipped.length) {
    // The whole point of showing this: a scan that skipped four of six
    // detectors has not checked what the numbers above suggest it checked.
    panel.appendChild(h('div.asv__skipped', null,
      h('p.asv__skipped-title', null,
        icon(ICONS.alert),
        text(skipped.length === 1
          ? 'Eine Prüfung wurde übersprungen:'
          : `${formatNumber(skipped.length)} Prüfungen wurden übersprungen:`)),
      h('ul', { role: 'list' }, ...skipped.map((entry) => h('li', null,
        h('strong', null, text(detectorLabel(self, entry && entry.kind))),
        text(` – ${String((entry && entry.reason) || 'ohne Angabe eines Grundes')}`)))),
      h('p.hint', null, text('Was übersprungen wurde, ist nicht geprüft. Die Zahlen oben sagen nichts über diese Arten aus.'))));
  } else {
    panel.appendChild(h('p.meta', null, text('Alle Prüfungen sind durchgelaufen, keine wurde übersprungen.')));
  }

  self.dom.scanPanel.appendChild(panel);
}

function detectorLabel(self, kind) {
  const found = self.detectors.find((entry) => entry && entry.kind === kind);
  if (found && found.label) return String(found.label);
  return KIND_LABEL[kind] || String(kind || 'unbekannte Prüfung');
}

function renderFilters(self) {
  const statusBox = self.dom.statusFilter;
  clear(statusBox);
  for (const entry of STATUSES) {
    const active = self.status === entry.value;
    const count = self.stats && Number.isFinite(self.stats[entry.value]) ? self.stats[entry.value] : null;
    const chip = h('button.asv__chip', {
      type: 'button',
      role: 'radio',
      'aria-checked': active ? 'true' : 'false',
      tabindex: active ? '0' : '-1',
      dataset: { value: entry.value },
      onClick: () => setStatus(self, entry.value),
    }, text(entry.label), count !== null ? h('span.asv__chip-count', null, text(formatNumber(count))) : null);
    chip.classList.toggle('is-active', active);
    statusBox.appendChild(chip);
  }

  const kindBox = self.dom.kindFilter;
  clear(kindBox);
  const all = h('button.asv__chip', {
    type: 'button',
    role: 'radio',
    'aria-checked': self.kind === '' ? 'true' : 'false',
    tabindex: self.kind === '' ? '0' : '-1',
    dataset: { value: '' },
    onClick: () => setKind(self, ''),
  }, text('Alle Arten'));
  all.classList.toggle('is-active', self.kind === '');
  kindBox.appendChild(all);

  for (const entry of KINDS) {
    const active = self.kind === entry.value;
    const byKind = self.stats && self.stats.byKind && typeof self.stats.byKind === 'object' ? self.stats.byKind : null;
    const count = byKind && Number.isFinite(byKind[entry.value]) ? byKind[entry.value] : null;
    const chip = h('button.asv__chip', {
      type: 'button',
      role: 'radio',
      title: entry.blurb,
      'aria-checked': active ? 'true' : 'false',
      tabindex: active ? '0' : '-1',
      dataset: { value: entry.value },
      onClick: () => setKind(self, entry.value),
    }, text(entry.label), count !== null ? h('span.asv__chip-count', null, text(formatNumber(count))) : null);
    chip.classList.toggle('is-active', active);
    kindBox.appendChild(chip);
  }
}

async function setStatus(self, value) {
  if (self.status === value) return;
  self.status = value;
  self.cursor = -1;
  renderFilters(self);
  syncAddress(self);
  await loadSuggestions(self);
  if (self.alive) renderList(self);
}

async function setKind(self, value) {
  if (self.kind === value) return;
  self.kind = value;
  self.cursor = -1;
  renderFilters(self);
  renderHeadActions(self);
  syncAddress(self);
  await loadSuggestions(self);
  if (self.alive) renderList(self);
}

/** Keep the address shareable without asking the shell to remount the view. */
function syncAddress(self) {
  try {
    const params = new URLSearchParams();
    if (self.status !== 'open') params.set('status', self.status);
    if (self.kind) params.set('kind', self.kind);
    const suffix = params.toString();
    const next = `#/assist${suffix ? `?${suffix}` : ''}`;
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
  } catch {
    /* a browser that refuses replaceState still filters fine */
  }
}

function renderList(self) {
  const box = self.dom.list;
  clear(box);

  if (self.unavailable) {
    box.appendChild(h('div.asv__state.asv__state--danger', { role: 'alert' },
      h('h2', null, text('Die Vorschläge sind hier nicht verfügbar')),
      h('p', null, text(errorMessage(self.unavailable))),
      h('p', null, text('Das ist kein leerer Posteingang: Es ist nicht bekannt, ob es etwas vorzuschlagen gäbe. '
        + 'Dieser Teil des Systems antwortet gerade nicht.')),
      h('button.btn.btn--small', { type: 'button', onClick: () => refreshAfterChange(self) },
        icon(ICONS.refresh), text('Noch einmal versuchen'))));
    return;
  }

  if (self.loadError) {
    box.appendChild(h('div.asv__state.asv__state--danger', { role: 'alert' },
      h('h2', null, text('Die Liste konnte nicht gelesen werden')),
      h('p', null, text(errorMessage(self.loadError))),
      h('button.btn.btn--small', { type: 'button', onClick: () => refreshAfterChange(self) }, text('Erneut versuchen'))));
    return;
  }

  if (self.loading && !self.items.length) {
    box.appendChild(h('div.asv__state', { role: 'status' },
      h('span.spinner', { 'aria-hidden': 'true' }),
      h('p', null, text('Die Vorschläge werden gelesen …'))));
    return;
  }

  // Cards decided in this session that have left the current filter. They sit
  // above the list so the answer to "what did that do?" is where the click was.
  const shown = new Set(self.items.map((item) => item.id));
  const recent = [...self.recent.values()].filter((item) => !shown.has(item.id));
  if (recent.length) {
    const section = h('section.asv__recent', { 'aria-label': 'Gerade entschieden' });
    section.appendChild(h('p.asv__recent-title.meta', null,
      text(recent.length === 1 ? 'Gerade entschieden' : `Gerade entschieden (${formatNumber(recent.length)})`)));
    for (const item of recent) section.appendChild(renderCard(self, item, -1));
    box.appendChild(section);
  }

  if (!self.items.length) {
    if (!recent.length) box.appendChild(renderEmptyState(self));
    return;
  }

  let index = 0;
  for (const item of self.items) {
    box.appendChild(renderCard(self, item, index));
    index += 1;
  }

  if (self.total > self.items.length) {
    box.appendChild(h('p.meta.asv__more', null,
      text(`Es werden ${formatNumber(self.items.length)} von ${formatNumber(self.total)} Vorschlägen gezeigt. `
        + 'Entscheide die ersten, dann rücken die übrigen nach.')));
  }
}

/**
 * The empty state, told apart honestly.
 *
 * There is no endpoint that says when the last scan ran, so this view does not
 * claim to know. What it does know: whether a scan ran in this session, and
 * whether any suggestion exists in any state.
 */
function renderEmptyState(self) {
  const statusEntry = STATUSES.find((entry) => entry.value === self.status);
  const stats = self.stats;
  const totalKnown = stats
    ? ['open', 'accepted', 'dismissed', 'stale'].reduce((sum, key) => sum + (Number(stats[key]) || 0), 0)
    : null;

  // Filtered to nothing while other rows exist: say where they are.
  if (totalKnown !== null && totalKnown > 0) {
    const elsewhere = STATUSES
      .filter((entry) => entry.value !== self.status && Number(stats[entry.value]) > 0)
      .map((entry) => entry);
    return h('div.asv__state', null,
      h('h2', null, text(self.kind
        ? `Nichts unter „${STATUS_LABEL[self.status]}“ und „${KIND_LABEL[self.kind]}“`
        : (statusEntry ? statusEntry.empty : 'Nichts in dieser Auswahl.'))),
      self.kind
        ? h('button.btn.btn--small', { type: 'button', onClick: () => setKind(self, '') }, text('Alle Arten zeigen'))
        : null,
      elsewhere.length
        ? h('div.row', null,
          h('span.meta', null, text('Anderswo liegt etwas:')),
          ...elsewhere.map((entry) => h('button.btn.btn--small', {
            type: 'button',
            onClick: () => setStatus(self, entry.value),
          }, text(`${entry.label} (${formatNumber(stats[entry.value])})`))))
        : null);
  }

  // Nothing anywhere, and a scan ran in this session: that is an answer.
  if (self.scan.result) {
    const skipped = Array.isArray(self.scan.result.skipped) ? self.scan.result.skipped : [];
    return h('div.asv__state', null,
      h('h2', null, text('Geprüft – es gibt nichts anzumerken')),
      h('p', null, text(self.scan.result.scannedAt
        ? `Die letzte Prüfung lief am ${formatDateTime(self.scan.result.scannedAt)} und hat keinen Vorschlag erzeugt.`
        : 'Die letzte Prüfung hat keinen Vorschlag erzeugt.')),
      skipped.length
        ? h('p', null, text(`Dabei ${skipped.length === 1 ? 'wurde 1 Prüfung' : `wurden ${formatNumber(skipped.length)} Prüfungen`} `
          + 'übersprungen – für diese Arten ist damit nichts gesagt. Die Gründe stehen oben.'))
        : h('p.meta', null, text('Alle Prüfungen sind dabei durchgelaufen.')));
  }

  // Nothing anywhere, no scan in this session: we genuinely do not know.
  return h('div.asv__state', null,
    h('h2', null, text('Hier steht noch nichts')),
    h('p', null, text('Es liegt kein Vorschlag vor. Ob überhaupt schon einmal nachgesehen wurde, '
      + 'lässt sich von hier aus nicht feststellen – der Server merkt sich keinen Zeitpunkt der letzten Prüfung.')),
    h('p', null, text('„Prüfen“ sieht jetzt nach. Dabei wird nichts geändert: es entstehen nur Vorschläge, über die du danach entscheidest.')),
    h('button.btn.btn--primary.btn--small', {
      type: 'button',
      disabled: self.scan.busy,
      onClick: () => runScan(self),
    }, icon(ICONS.scan), text('Jetzt prüfen')),
    self.detectors.length
      ? h('details.asv__detectors', null,
        h('summary', null, text(`Diese ${formatNumber(self.detectors.length)} Prüfungen laufen dabei`)),
        h('ul', { role: 'list' }, ...self.detectors.map((entry) => h('li', null,
          h('strong', null, text(String((entry && entry.label) || (entry && entry.kind) || 'unbenannt'))),
          entry && entry.description ? text(` – ${String(entry.description)}`) : null))))
      : (self.detectorsError
        ? h('p.meta', null, text(`Welche Prüfungen es gibt, ist nicht abrufbar: ${errorMessage(self.detectorsError)}`))
        : null));
}

function renderCard(self, item, index) {
  const data = dataOf(item);
  const entry = self.decisions.get(item.id) || null;
  const conf = confidenceInfo(data.confidence);
  const status = String(data.status || 'open');
  const decided = status !== 'open';

  const card = h('article.asv__card', {
    tabindex: '0',
    dataset: { index: String(index), kind: String(data.kind || ''), status },
    'aria-label': `Vorschlag: ${String(data.title || '')}`,
  });
  // index -1 marks a pinned "gerade entschieden" card, which the arrow keys skip.
  if (index >= 0 && index === self.cursor) card.classList.add('is-cursor');

  /* --- head: what kind of thing this is, and how sure ---------------- */
  card.appendChild(h('div.asv__card-head', null,
    h('span.asv__kind', { dataset: { kind: String(data.kind || '') } }, text(KIND_LABEL[data.kind] || String(data.kind || 'Vorschlag'))),
    decided ? h('span.badge', null, text(STATUS_LABEL[status] || status)) : null,
    h('span.spacer'),
    renderConfidence(conf),
    h('span.meta', null, text(item.createdAt ? `vorgeschlagen ${timeAgo(item.createdAt)}` : ''))));

  /* --- body: title, detail, reason ----------------------------------- */
  card.appendChild(h('h2.asv__title', null, text(String(data.title || 'Ohne Titel'))));
  if (data.detail) card.appendChild(h('p.asv__detail', null, text(String(data.detail))));
  if (data.reason) {
    card.appendChild(h('p.asv__reason', null,
      h('span.asv__reason-key', null, text('Warum: ')),
      text(String(data.reason))));
  }

  /* --- the records this is about ------------------------------------- */
  const ids = Array.isArray(data.recordIds) ? data.recordIds.filter((id) => typeof id === 'string' && id) : [];
  if (ids.length) {
    card.appendChild(h('div.asv__records', null,
      h('span.meta', null, text('Betrifft: ')),
      ...ids.map((id) => renderRecordChip(self, id))));
  }

  /* --- what would happen --------------------------------------------- */
  card.appendChild(renderActionBlock(self, item, data));

  /* --- what did happen ------------------------------------------------ */
  if (entry && (entry.applied || entry.error || entry.undone)) {
    card.appendChild(renderOutcome(self, item, entry));
  }

  /* --- decide --------------------------------------------------------- */
  card.appendChild(renderCardActions(self, item, status, entry));
  return card;
}

function renderConfidence(conf) {
  const node = h('span.asv__conf', { dataset: { level: conf.level } });
  node.appendChild(h('span.asv__conf-bar', { 'aria-hidden': 'true' },
    h('span.asv__conf-fill', { style: `width:${Math.round(conf.ratio * 100)}%` })));
  node.appendChild(h('span.asv__conf-text', null,
    text(conf.percent === null ? conf.label : `${conf.label} (${conf.percent} %)`)));
  node.setAttribute('title', conf.percent === null
    ? 'Zu diesem Vorschlag liegt keine Einschätzung vor.'
    : `Die Regel schätzt sich selbst auf ${conf.percent} % ein. Das ist keine Messung.`);
  return node;
}

function renderRecordChip(self, id) {
  const record = self.records.get(id);
  const known = self.records.has(id);
  const type = record ? record.type : typeOfId(id);

  if (known && !record) {
    return h('span.asv__record.is-gone', { title: id },
      text(`${SINGULAR[type] || 'Eintrag'} existiert nicht mehr`));
  }
  const label = record ? labelOf(record) : id;
  return h('button.asv__record', {
    type: 'button',
    title: `${SINGULAR[type] || 'Eintrag'} öffnen (${id})`,
    onClick: () => self.ctx.navigate(targetFor(type, id)),
  },
  h('span.asv__record-type', null, text(SINGULAR[type] || 'Eintrag')),
  h('span.asv__record-label', null, text(record ? label : 'wird gelesen …')),
  icon(ICONS.arrow));
}

function renderActionBlock(self, item, data) {
  const action = data.action;
  const sentence = describeAction(self, action);
  const box = h('div.asv__action');

  if (!action) {
    box.appendChild(h('p.asv__action-text', null,
      text('Zu diesem Vorschlag ist keine Aktion hinterlegt. „Übernehmen“ hakt ihn nur ab und ändert an deinen Einträgen nichts.')));
    return box;
  }

  box.appendChild(h('p.asv__action-text', null,
    h('span.asv__action-key', null, text('Übernehmen bedeutet: ')),
    sentence
      ? text(sentence)
      : h('span.asv__action-unknown', null, text('Diese Aktion lässt sich hier nicht in einen Satz fassen. '
        + 'Sieh sie dir unter „Details“ an, bevor du sie übernimmst.'))));

  const details = h('details.asv__details', {
    open: self.openDetails.has(item.id),
    onToggle: (event) => {
      if (event.target.open) self.openDetails.add(item.id);
      else self.openDetails.delete(item.id);
    },
  },
  h('summary', null, text('Details')),
  h('pre.code', null, text(safeJson(action))));
  box.appendChild(details);
  return box;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Die Aktion lässt sich nicht als JSON darstellen.';
  }
}

function renderOutcome(self, item, entry) {
  if (entry.error) {
    return h('div.asv__outcome.asv__outcome--danger', { role: 'alert' },
      h('div.row', null, icon(ICONS.alert), h('strong', null, text('Das hat nicht geklappt.'))),
      h('p', null, text(errorMessage(entry.error))),
      h('p.hint', null, text('An deinen Einträgen wurde dadurch nichts geändert, soweit der Server das meldet.')));
  }

  if (entry.undone) {
    return h('div.asv__outcome', null,
      h('div.row', null, icon(ICONS.undo), h('strong', null, text('Zurückgenommen.'))),
      h('p', null, text('Die Änderung am Eintrag ist rückgängig gemacht. Der Vorschlag bleibt trotzdem als „übernommen“ vermerkt – '
        + 'das ist ein Protokoll deiner Entscheidung, keine Behauptung über den heutigen Zustand.')));
  }

  const applied = entry.applied;
  const links = producedLinks(applied);
  const node = h('div.asv__outcome', null,
    h('div.row', null, icon(ICONS.check), h('strong', null, text('Übernommen.'))),
    h('p', null, text(describeApplied(self, applied))));

  if (links.length) {
    node.appendChild(h('div.row', null, ...links.map((link) => h('button.btn.btn--small', {
      type: 'button',
      onClick: () => self.ctx.navigate(targetFor(typeOfId(link.id), link.id)),
    }, text(link.label), icon(ICONS.arrow)))));
  }

  if (entry.undo) {
    node.appendChild(h('div.row', null,
      h('button.btn.btn--small', {
        type: 'button',
        disabled: entry.busy,
        onClick: () => runUndo(self, item, entry),
      }, icon(ICONS.undo), text(entry.undo.label)),
      h('span.hint', null, text('Entfernt genau die Schlagwörter, die diese Übernahme ergänzt hat.'))));
  } else {
    node.appendChild(h('p.hint', null, text('Rückgängig machen kann diese Ansicht das nicht. '
      + (links.length
        ? 'Was angelegt wurde, kannst du über die Schaltfläche oben öffnen und dort löschen.'
        : 'Was geändert wurde, musst du im jeweiligen Bereich von Hand zurücknehmen.'))));
  }

  node.appendChild(h('details.asv__details', null,
    h('summary', null, text('Details')),
    h('pre.code', null, text(safeJson(applied)))));
  return node;
}

function renderCardActions(self, item, status, entry) {
  const busy = !!(entry && entry.busy);
  const row = h('div.asv__actions');

  if (status === 'open') {
    row.appendChild(h('button.btn.btn--primary.btn--small', {
      type: 'button',
      disabled: busy,
      onClick: () => acceptSuggestion(self, item),
    }, icon(ICONS.check), text('Übernehmen')));
    row.appendChild(h('button.btn.btn--small', {
      type: 'button',
      disabled: busy,
      onClick: () => dismissSuggestion(self, item),
    }, icon(ICONS.close), text('Verwerfen')));
  } else {
    const data = dataOf(item);
    row.appendChild(h('span.meta', null, text(data.decidedAt
      ? `${STATUS_LABEL[status] || status} · ${formatDateTime(data.decidedAt)}`
      : (STATUS_LABEL[status] || status))));
  }

  row.appendChild(h('span.spacer'));
  if (self.recent.has(item.id)) {
    row.appendChild(h('button.btn.btn--ghost.btn--small', {
      type: 'button',
      title: 'Diese Karte ausblenden – der Vorschlag bleibt gespeichert',
      onClick: () => {
        self.recent.delete(item.id);
        renderList(self);
      },
    }, text('Ausblenden')));
  }
  row.appendChild(h('button.btn.btn--ghost.btn--small', {
    type: 'button',
    disabled: busy,
    title: 'Diesen Vorschlag aus der Liste löschen',
    onClick: () => deleteSuggestion(self, item),
  }, icon(ICONS.trash), text('Löschen')));

  if (busy) row.appendChild(h('span.spinner', { 'aria-hidden': 'true' }));
  return row;
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function onViewKey(self, event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;

  // Arrow keys inside a filter group walk that group (roving tabindex).
  const group = target && target.closest ? target.closest('.asv__filter') : null;
  if (group && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    const chips = [...group.querySelectorAll('.asv__chip')];
    const at = chips.indexOf(target);
    if (at !== -1) {
      event.preventDefault();
      const next = chips[(at + (event.key === 'ArrowRight' ? 1 : chips.length - 1)) % chips.length];
      if (next) {
        const value = next.dataset.value || '';
        next.focus();
        next.click();
        // Choosing a filter rebuilds the group, so the focused node is gone by
        // now; put the caret back on the chip the user just landed on.
        const again = group.querySelector(`.asv__chip[data-value="${value}"]`);
        if (again) again.focus();
      }
    }
    return;
  }

  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (target && target.closest && target.closest('input, textarea, select')) return;

  const cards = [...self.dom.list.querySelectorAll(':scope > .asv__card')];
  if (!cards.length) return;
  event.preventDefault();
  const delta = event.key === 'ArrowDown' ? 1 : -1;
  const next = Math.min(cards.length - 1, Math.max(0, self.cursor + delta));
  self.cursor = next;
  cards.forEach((node, i) => node.classList.toggle('is-cursor', i === next));
  cards[next].focus({ preventScroll: true });
  cards[next].scrollIntoView({ block: 'nearest' });
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
.asv { display: flex; flex-direction: column; gap: var(--sp-2); }
.asv .page__head { margin-bottom: 0; }

.asv__stats { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.asv__stat {
  display: flex;
  flex-direction: column;
  min-width: 96px;
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.asv__stat-value { font-size: var(--fs-lg); font-weight: 600; }
.asv__stat-label { font-size: var(--fs-sm); color: var(--fg-muted); }
.asv__stat[data-key="open"] .asv__stat-value { color: var(--accent); }

.asv__panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-2);
}
.asv__panel p { margin: 0; }
.asv__panel--danger { border-left-color: var(--danger); background: var(--danger-soft); }
.asv__panel svg { width: 18px; height: 18px; flex: none; }
.asv__report { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
.asv__report li { font-weight: 500; }
.asv__report-kinds { margin: 0; }
.asv__skipped {
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--warn);
  border-radius: var(--r-1);
}
.asv__skipped-title { display: flex; align-items: center; gap: 6px; margin: 0 0 var(--sp-05); color: var(--warn); }
.asv__skipped ul { margin: 0; padding-left: var(--sp-3); font-size: var(--fs-sm); }
.asv__skipped .hint { margin: var(--sp-05) 0 0; }

.asv__filters { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
.asv__filter-group { display: flex; flex-direction: column; gap: var(--sp-05); }
.asv__filter { display: flex; flex-wrap: wrap; gap: 6px; }
.asv__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-full);
  cursor: pointer;
}
.asv__chip:hover { background: var(--surface-3); }
.asv__chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.asv__chip.is-active { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.asv__chip-count { font-variant-numeric: tabular-nums; color: var(--fg-subtle); }
.asv__chip.is-active .asv__chip-count { color: var(--accent); }
.asv__legend { margin: 0; }

.asv__list { display: flex; flex-direction: column; gap: var(--sp-2); }
.asv__card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  box-shadow: var(--shadow-1);
}
.asv__card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.asv__card.is-cursor { border-color: var(--accent); }
.asv__card[data-status="accepted"], .asv__card[data-status="dismissed"], .asv__card[data-status="stale"] {
  background: var(--surface-2);
}
.asv__card-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
.asv__kind {
  padding: 1px 8px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--r-full);
}
.asv__title { font-size: var(--fs-md); margin: 0; }
.asv__detail { margin: 0; color: var(--fg-muted); }
.asv__reason { margin: 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.asv__reason-key { color: var(--fg-subtle); }

.asv__conf { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--fg-muted); }
.asv__conf-bar {
  display: inline-block;
  width: 48px;
  height: 6px;
  background: var(--surface-3);
  border-radius: var(--r-full);
  overflow: hidden;
}
.asv__conf-fill { display: block; height: 100%; background: var(--fg-subtle); }
.asv__conf[data-level="high"] .asv__conf-fill { background: var(--ok); }
.asv__conf[data-level="medium"] .asv__conf-fill { background: var(--accent); }
.asv__conf[data-level="low"] .asv__conf-fill { background: var(--warn); }
.asv__conf[data-level="vague"] .asv__conf-fill { background: var(--fg-subtle); }
.asv__conf[data-level="unknown"] .asv__conf-bar { display: none; }

.asv__records { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.asv__record {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 8px;
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--fg);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-full);
  cursor: pointer;
}
.asv__record:hover { border-color: var(--accent); background: var(--accent-soft); }
.asv__record svg { width: 14px; height: 14px; flex: none; color: var(--fg-subtle); }
.asv__record-type { color: var(--fg-subtle); font-size: var(--fs-xs); flex: none; }
.asv__record-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 28ch; }
.asv__record.is-gone {
  color: var(--fg-subtle);
  background: var(--surface-3);
  border-style: dashed;
  cursor: default;
}

.asv__action {
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.asv__action-text { margin: 0; }
.asv__action-key { color: var(--fg-subtle); }
.asv__action-unknown { color: var(--warn); }
.asv__details { margin-top: var(--sp-05); }
.asv__details summary { cursor: pointer; color: var(--fg-muted); font-size: var(--fs-sm); }
.asv__details pre.code { margin: var(--sp-05) 0 0; max-height: 320px; overflow: auto; }

.asv__outcome {
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--ok);
  border-radius: var(--r-2);
}
.asv__outcome p { margin: 0; }
.asv__outcome svg { width: 18px; height: 18px; flex: none; color: var(--ok); }
.asv__outcome--danger { border-left-color: var(--danger); background: var(--danger-soft); }
.asv__outcome--danger svg { color: var(--danger); }

.asv__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }

.asv__state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
  max-width: 62ch;
  padding: var(--sp-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
}
.asv__state h2 { font-size: var(--fs-lg); margin: 0; }
.asv__state p { margin: 0; color: var(--fg-muted); }
.asv__state--danger { border-left: 3px solid var(--danger); }
.asv__detectors summary { cursor: pointer; color: var(--fg-muted); font-size: var(--fs-sm); }
.asv__detectors ul { margin: var(--sp-05) 0 0; padding-left: var(--sp-3); font-size: var(--fs-sm); color: var(--fg-muted); }
.asv__more { margin: 0; }
.asv__recent { display: flex; flex-direction: column; gap: var(--sp-1); }
.asv__recent-title { margin: 0; text-transform: uppercase; letter-spacing: 0.04em; }

@media (max-width: 720px) {
  .asv__card-head { gap: 6px; }
  .asv__filters { gap: var(--sp-2); }
  .asv__record-label { max-width: 18ch; }
}
`;
