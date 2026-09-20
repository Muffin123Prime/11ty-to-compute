/**
 * views/agents.js -- agents, their capabilities, their runs.
 *
 * The decisions that shape this file
 * ----------------------------------
 * 1. **An agent record is a permission grant, not a personality.** The panel
 *    therefore reads like a permission dialogue: every capability is a single
 *    switch, and every switch carries one sentence naming the CONSEQUENCE, not
 *    the mechanism ("Darf Dateien ändern -- kann vorhandene Dateien
 *    überschreiben"). A user who cannot say what a permission costs them has
 *    not really granted it.
 * 2. **The network permission is its own block.** It is the only capability
 *    that can move data off the machine, so it is visually separated, states
 *    plainly that the global network mode caps it, and never pretends that
 *    switching it to "online" is the same class of decision as letting an
 *    agent read a note.
 * 3. **Nothing is saved behind the user's back.** Editing marks the form
 *    dirty and shows an explicit save bar; unsaved edits survive a switch to
 *    another agent and the view being unmounted (module-level `drafts`), so a
 *    half-written system prompt is never silently lost -- and never silently
 *    stored either.
 * 4. **Steps are shown as they really happen.** The run panel is fed by the
 *    server bus (`run.started`, `run.step`, `run.finished`, `run.failed`) over
 *    the shell's single SSE connection. Nothing here is optimistic: a tool
 *    call appears when the server says it ran, with its arguments, its result
 *    or its error, and the run's `usedNetwork` flag comes from the gate rather
 *    than from what the agent was allowed to do.
 * 5. **An approval shows the whole request.** The card carries the summary,
 *    the tool name and the complete arguments as formatted JSON, because
 *    "Agent möchte eine Aktion ausführen" is not consent -- it is a prompt to
 *    click yes.
 * 6. **The view owns only its layout CSS.** Colours, spacing and radii come
 *    from the tokens in web/app.css; the rules injected here exist solely to
 *    place a two-column layout, a step list and a permission grid.
 */

import {
  h, text, clear, on, icon, timeAgo, formatDateTime, formatNumber, debounce,
} from '../lib/dom.js';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-agents-view-style';

const VIEW_ICON = '<rect x="3.6" y="6.4" width="12.8" height="9.6" rx="3"/><path d="M10 2.8v3.6M7.6 10.8h.01M12.4 10.8h.01M7.8 13.6h4.4"/>';

const ICONS = {
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  play: '<path d="M6.4 4.4 15.2 10l-8.8 5.6z"/>',
  stop: '<rect x="5.4" y="5.4" width="9.2" height="9.2" rx="1.6"/>',
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  close: '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  net: '<circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c2 2.2 3 4.7 3 7.2s-1 5-3 7.2c-2-2.2-3-4.7-3-7.2s1-5 3-7.2z"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  tool: '<path d="M12.4 3.4a3.8 3.8 0 0 0-4.6 4.9l-4.3 4.3a1.7 1.7 0 0 0 2.4 2.4l4.3-4.3a3.8 3.8 0 0 0 4.9-4.6l-2.3 2.3-2-2z"/>',
};

/**
 * The capability catalogue. `consequence` is the sentence shown under each
 * switch: it says what the user gives up, in the user's terms.
 */
const CAPABILITIES = [
  {
    key: 'readNotes',
    label: 'Darf Notizen lesen',
    consequence: 'Der Agent sieht Titel und Volltext aller Notizen im Tresor – und gibt sie an das Modell weiter, das er benutzt.',
  },
  {
    key: 'writeNotes',
    label: 'Darf Notizen ändern',
    consequence: 'Der Agent kann Notizen anlegen und bestehende Texte überschreiben. Alte Fassungen sind danach nur über eine Sicherung zurückzuholen.',
  },
  {
    key: 'readFiles',
    label: 'Darf Dateien lesen',
    consequence: 'Der Agent liest Dateien aus den unten freigegebenen Ordnern. Ohne freigegebenen Ordner erreicht er keine einzige Datei.',
  },
  {
    key: 'writeFiles',
    label: 'Darf Dateien schreiben',
    consequence: 'Der Agent kann Dateien in den freigegebenen Ordnern anlegen und überschreiben – vorhandene Inhalte gehen dabei verloren.',
  },
  {
    key: 'createEdges',
    label: 'Darf Verknüpfungen anlegen',
    consequence: 'Der Agent verändert die Struktur deines Gehirns. Maschinell gezogene Verknüpfungen sind im Graphen als solche markiert und lassen sich wieder entfernen.',
  },
  {
    key: 'runTasks',
    label: 'Darf Aufgaben verwalten',
    consequence: 'Der Agent legt Aufgaben an und ändert ihren Status – deine Projekttafel kann sich also ohne dein Zutun bewegen.',
  },
  {
    key: 'spawnAgents',
    label: 'Darf andere Agenten starten',
    consequence: 'Der Agent kann weitere Läufe auslösen. Jeder gestartete Agent bringt seine eigenen Berechtigungen mit.',
  },
];

const NETWORK_LEVELS = [
  {
    value: 'offline',
    label: 'Kein Netz',
    consequence: 'Der Agent erreicht ausschließlich lokale Dienste auf diesem Gerät (zum Beispiel das lokale Modell). Nichts verlässt den Rechner.',
  },
  {
    value: 'lan',
    label: 'Nur lokales Netz',
    consequence: 'Der Agent darf Geräte im eigenen Netz ansprechen, etwa einen Modellserver auf einem anderen Rechner. Das öffentliche Internet bleibt gesperrt.',
  },
  {
    value: 'online',
    label: 'Internet',
    consequence: 'Der Agent darf öffentliche Adressen abrufen. Was er dorthin schickt – auch Auszüge aus deinen Notizen – verlässt dieses Gerät.',
  },
];

const RUN_STATUS_LABEL = {
  queued: 'wartet',
  running: 'läuft',
  'waiting-approval': 'wartet auf Bestätigung',
  done: 'fertig',
  failed: 'fehlgeschlagen',
  aborted: 'abgebrochen',
};

const STOP_REASON_LABEL = {
  final: 'Der Agent war mit seiner Antwort fertig.',
  'max-steps': 'Die Schrittgrenze war erreicht.',
  'max-seconds': 'Die Zeitgrenze war erreicht.',
  aborted: 'Du hast den Lauf abgebrochen.',
  loop: 'Der Agent hat sich wiederholt – der Lauf wurde beendet.',
  error: 'Ein Fehler hat den Lauf beendet.',
};

const APPROVAL_KIND_LABEL = {
  tool: 'Werkzeug',
  network: 'Netzzugriff',
  spawn: 'Weiterer Agent',
};

/** Unsaved edits, kept per agent id so switching or leaving loses nothing. */
const drafts = new Map();

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function itemsOf(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.items)) return response.items;
  return [];
}

function recordOf(response) {
  if (!response) return null;
  if (response.record) return response.record;
  if (response.id) return response;
  return null;
}

function dataOf(record) {
  return (record && record.data) || {};
}

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

/** Model reference as the config stores it: `{provider, model}` or null. */
function modelValue(model) {
  if (!model || typeof model !== 'object') return '';
  const provider = String(model.provider || '').trim();
  const name = String(model.model || '').trim();
  if (!name) return '';
  return provider ? `${provider}/${name}` : name;
}

function parseModelValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  if (slash === -1) return { provider: null, model: raw };
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseLines(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, 60);
}

/** Pretty JSON for tool arguments and results, never HTML. */
function pretty(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * The permission object a form edits. Built from the schema defaults so an
 * older agent record gains new capabilities as DENIED rather than as whatever
 * the interface happened to leave out.
 */
function normalisePermissions(perms) {
  const source = perms && typeof perms === 'object' ? perms : {};
  const out = {
    readNotes: source.readNotes === true,
    writeNotes: source.writeNotes === true,
    readFiles: source.readFiles === true,
    writeFiles: source.writeFiles === true,
    createEdges: source.createEdges === true,
    runTasks: source.runTasks === true,
    spawnAgents: source.spawnAgents === true,
    network: NETWORK_LEVELS.some((l) => l.value === source.network) ? source.network : 'offline',
    allowedHosts: Array.isArray(source.allowedHosts) ? source.allowedHosts.filter((x) => typeof x === 'string') : [],
    fileRoots: Array.isArray(source.fileRoots) ? source.fileRoots.filter((x) => typeof x === 'string') : [],
    requireApproval: source.requireApproval !== false,
    maxSteps: clampInt(source.maxSteps, 1, 100, 12),
    maxSeconds: clampInt(source.maxSeconds, 5, 7200, 300),
  };
  return out;
}

function draftFromRecord(record) {
  const data = dataOf(record);
  return {
    name: String(data.name || ''),
    description: String(data.description || ''),
    systemPrompt: String(data.systemPrompt || ''),
    model: data.model && typeof data.model === 'object' ? { ...data.model } : null,
    permissions: normalisePermissions(data.permissions),
  };
}

function sameDraft(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Short German badges summarising what an agent may do. */
function capabilityBadges(permissions) {
  const perms = normalisePermissions(permissions);
  const badges = [];
  if (perms.readNotes) badges.push({ label: 'liest Notizen', tone: 'neutral' });
  if (perms.writeNotes) badges.push({ label: 'schreibt Notizen', tone: 'warn' });
  if (perms.readFiles) badges.push({ label: 'liest Dateien', tone: 'neutral' });
  if (perms.writeFiles) badges.push({ label: 'schreibt Dateien', tone: 'warn' });
  if (perms.createEdges) badges.push({ label: 'verknüpft', tone: 'neutral' });
  if (perms.runTasks) badges.push({ label: 'Aufgaben', tone: 'neutral' });
  if (perms.spawnAgents) badges.push({ label: 'startet Agenten', tone: 'warn' });
  if (perms.network === 'online') badges.push({ label: 'Internet', tone: 'danger' });
  else if (perms.network === 'lan') badges.push({ label: 'lokales Netz', tone: 'warn' });
  else badges.push({ label: 'ohne Netz', tone: 'ok' });
  badges.push(perms.requireApproval
    ? { label: 'fragt nach', tone: 'ok' }
    : { label: 'ohne Rückfrage', tone: 'danger' });
  return badges;
}

function badgeNode(badge) {
  const node = h('span.badge.agentsv__badge', null, text(badge.label));
  node.dataset.tone = badge.tone;
  return node;
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'agents',
  title: 'Agenten',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyle();
    teardown(); // a failed unmount must not leave two views on one bus

    const params = (ctx.route && ctx.route.params) || {};
    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      container,
      cleanups: [],
      requests: new Set(),
      dom: {},

      agents: [],
      descriptions: {},
      loadError: null,
      loading: true,

      selectedId: typeof params.id === 'string' && params.id.startsWith('agent_') ? params.id : null,
      tools: [],
      toolProblem: null,

      runs: [],
      activeRunIds: new Set(),
      run: null, // the run currently shown live: {id, record, steps:[], status, error}
      runBusy: false,

      approvals: [],
      approvalBusy: new Set(),

      models: null,
      modelsError: null,

      historyId: typeof params.run === 'string' ? params.run : (typeof params.id === 'string' && params.id.startsWith('run_') ? params.id : null),
      historyRecord: null,
      historyError: null,
    };
    view = self;

    buildLayout(self);
    subscribe(self);

    await Promise.all([
      loadAgents(self),
      loadRuns(self),
      loadModels(self),
      loadApprovals(self),
    ]);
    if (!self.alive) return;
    if (self.historyId) await openHistory(self, self.historyId);
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
  for (const controller of self.requests) {
    try { controller.abort(); } catch { /* already finished */ }
  }
  self.requests.clear();
  for (const off of self.cleanups) {
    try { off(); } catch { /* a listener that is already gone is fine */ }
  }
  self.cleanups.length = 0;
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

async function loadAgents(self) {
  self.loading = true;
  try {
    const result = await request(self, (signal) => self.api.get('/agents', { query: { limit: 200 }, signal }));
    if (!self.alive) return;
    self.agents = itemsOf(result).filter((record) => record && record.id);
    self.descriptions = (result && result.descriptions) || {};
    self.loadError = null;
    if (self.selectedId && !self.agents.some((a) => a.id === self.selectedId)) self.selectedId = null;
    if (!self.selectedId && self.agents.length) self.selectedId = self.agents[0].id;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.loadError = err;
    self.agents = [];
  } finally {
    self.loading = false;
  }
  if (self.alive && self.selectedId) await loadAgentDetail(self, self.selectedId);
}

/** The tool catalogue is per agent: it is filtered by that agent's rights. */
async function loadAgentDetail(self, id) {
  self.tools = [];
  self.toolProblem = null;
  try {
    const result = await request(self, (signal) => self.api.get(`/agents/${encodeURIComponent(id)}`, { signal }));
    if (!self.alive || self.selectedId !== id) return;
    self.tools = Array.isArray(result && result.tools) ? result.tools : [];
    self.toolProblem = (result && result.toolProblem) || null;
    const record = recordOf(result);
    if (record) {
      const index = self.agents.findIndex((a) => a.id === record.id);
      if (index !== -1) self.agents[index] = record;
    }
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.toolProblem = errorMessage(err);
  }
}

async function loadRuns(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/runs', { query: { limit: 60 }, signal }));
    if (!self.alive) return;
    self.runs = itemsOf(result);
    self.activeRunIds = new Set(Array.isArray(result && result.active) ? result.active : []);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    // The run list is context, not the point of the screen: a failure here
    // must not hide the agents themselves.
    self.runs = [];
  }
}

async function loadModels(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/models', { signal }));
    if (!self.alive) return;
    self.models = result;
    self.modelsError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.models = null;
    self.modelsError = errorMessage(err);
  }
}

async function loadApprovals(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/approvals', { signal }));
    if (!self.alive) return;
    self.approvals = itemsOf(result).filter((row) => {
      const status = row && row.data ? row.data.status : null;
      return !status || status === 'pending';
    });
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.approvals = [];
  }
}

/* ------------------------------------------------------------------ */
/* Live events                                                         */
/* ------------------------------------------------------------------ */

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;

  const refreshRunsSoon = debounce(() => {
    if (!self.alive) return;
    loadRuns(self).then(() => {
      if (self.alive) renderHistoryList(self);
    });
  }, 700);

  self.cleanups.push(ctx.bus.on('run.started', (payload) => {
    if (!self.alive || !payload) return;
    self.activeRunIds.add(payload.runId);
    if (self.run && self.run.id === payload.runId) {
      self.run.status = 'running';
      renderRunPanel(self);
    }
    refreshRunsSoon();
  }));

  self.cleanups.push(ctx.bus.on('run.step', (payload) => {
    if (!self.alive || !payload || !payload.step) return;
    if (!self.run || self.run.id !== payload.runId) return;
    self.run.steps.push(payload.step);
    renderRunPanel(self);
  }));

  const onEnd = (payload, event) => {
    if (!self.alive || !payload) return;
    self.activeRunIds.delete(payload.runId);
    if (self.run && self.run.id === payload.runId) {
      self.run.status = payload.status || (event && event.type === 'run.failed' ? 'failed' : 'done');
      self.run.stopReason = payload.stopReason || null;
      self.run.result = typeof payload.result === 'string' ? payload.result : self.run.result;
      self.run.error = payload.error || null;
      self.run.usedNetwork = payload.usedNetwork === true;
      self.runBusy = false;
      // The record carries the authoritative step list and network verdict.
      refreshRun(self, payload.runId);
      renderRunPanel(self);
    }
    refreshRunsSoon();
  };
  self.cleanups.push(ctx.bus.on('run.finished', onEnd));
  self.cleanups.push(ctx.bus.on('run.failed', onEnd));

  for (const name of ['approval.requested', 'approval.resolved']) {
    self.cleanups.push(ctx.bus.on(name, () => {
      if (!self.alive) return;
      loadApprovals(self).then(() => {
        if (self.alive) renderApprovals(self);
      });
    }));
  }

  // The shell keeps the pending list up to date for its sidebar badge; follow
  // it so both never disagree.
  if (ctx.state && typeof ctx.state.on === 'function') {
    self.cleanups.push(ctx.state.on('approvals', (items) => {
      if (!self.alive || !Array.isArray(items)) return;
      self.approvals = items;
      renderApprovals(self);
    }));
  }
}

async function refreshRun(self, runId) {
  try {
    const result = await request(self, (signal) => self.api.get(`/runs/${encodeURIComponent(runId)}`, { signal }));
    if (!self.alive || !self.run || self.run.id !== runId) return;
    const record = recordOf(result);
    if (!record) return;
    const data = dataOf(record);
    self.run.record = record;
    self.run.status = data.status || self.run.status;
    self.run.steps = Array.isArray(data.steps) ? data.steps : self.run.steps;
    self.run.result = typeof data.result === 'string' ? data.result : self.run.result;
    self.run.error = data.error || self.run.error;
    self.run.usedNetwork = data.usedNetwork === true;
    renderRunPanel(self);
  } catch {
    /* the live steps we already have stay on screen; nothing is invented */
  }
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  /* ----------------------------- sidebar ---------------------------- */

  dom.newButton = h('button.btn.btn--primary.btn--small', {
    type: 'button',
    onClick: () => createAgent(self),
  }, icon(ICONS.plus), text('Neuer Agent'));

  dom.filter = h('input.input', {
    type: 'search',
    placeholder: 'Agenten filtern …',
    'aria-label': 'Agenten filtern',
    autocomplete: 'off',
    onInput: () => renderList(self),
  });

  dom.list = h('ul.agentsv__list', { role: 'list' });
  dom.side = h('aside.agentsv__side', { 'aria-label': 'Agenten' },
    h('div.agentsv__side-head', null, dom.newButton, dom.filter),
    dom.list);

  /* ------------------------------- head ----------------------------- */

  dom.title = h('h2.agentsv__title');
  dom.badges = h('div.agentsv__badges');
  dom.summary = h('p.agentsv__summary.meta');
  dom.deleteButton = h('button.btn.btn--small', {
    type: 'button',
    onClick: () => deleteAgent(self),
  }, icon(ICONS.trash), text('Löschen'));

  dom.head = h('header.agentsv__head', null,
    h('div.agentsv__head-main', null, dom.title, dom.badges, dom.summary),
    h('div.agentsv__head-actions', null, dom.deleteButton));

  dom.saveBar = h('div.agentsv__savebar', { hidden: true, role: 'status' },
    h('span', null, text('Ungespeicherte Änderungen an diesem Agenten.')),
    h('span.spacer'),
    h('button.btn.btn--small', { type: 'button', onClick: () => discardDraft(self) }, text('Verwerfen')),
    h('button.btn.btn--primary.btn--small', { type: 'button', onClick: () => saveAgent(self) }, text('Speichern')));

  /* ------------------------------- run ------------------------------ */

  dom.goal = h('textarea.textarea.agentsv__goal', {
    placeholder: 'Was soll der Agent tun? Zum Beispiel: „Fasse meine Notizen zum Thema Ablage zusammen und lege eine Übersicht an.“',
    'aria-label': 'Zielvorgabe für den Lauf',
    rows: 3,
    onInput: () => updateRunButtons(self),
    onKeyDown: (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        startRun(self);
      }
    },
  });

  dom.startButton = h('button.btn.btn--primary', {
    type: 'button',
    onClick: () => startRun(self),
  }, icon(ICONS.play), text('Agent starten'));

  dom.abortButton = h('button.btn.btn--danger', {
    type: 'button',
    hidden: true,
    onClick: () => abortRun(self),
  }, icon(ICONS.stop), text('Abbrechen'));

  dom.runState = h('span.agentsv__runstate.meta', { role: 'status' });
  dom.steps = h('ol.agentsv__steps', { role: 'list' });
  dom.runResult = h('div.agentsv__result', { hidden: true });

  dom.runCard = h('section.card.agentsv__card', { 'aria-label': 'Lauf starten' },
    h('div.card__head', null, h('h3', null, text('Lauf starten')), h('span.spacer'), dom.runState),
    h('div.card__body.stack', null,
      dom.goal,
      h('div.row', null, dom.startButton, dom.abortButton,
        h('span.hint', null, text('Strg + Eingabe startet ebenfalls.'))),
      dom.steps,
      dom.runResult));

  /* ---------------------------- approvals --------------------------- */

  dom.approvals = h('section.agentsv__approvals', { 'aria-label': 'Offene Bestätigungen' });

  /* ----------------------------- editor ----------------------------- */

  dom.nameInput = h('input.input', {
    type: 'text',
    'aria-label': 'Name des Agenten',
    maxlength: '200',
    onInput: () => updateDraft(self, (draft) => { draft.name = dom.nameInput.value; }),
  });
  dom.descriptionInput = h('input.input', {
    type: 'text',
    'aria-label': 'Beschreibung',
    maxlength: '500',
    placeholder: 'Wofür ist dieser Agent da?',
    onInput: () => updateDraft(self, (draft) => { draft.description = dom.descriptionInput.value; }),
  });
  dom.promptInput = h('textarea.textarea.agentsv__prompt', {
    'aria-label': 'Systemprompt',
    rows: 6,
    placeholder: 'Anweisungen, die vor jedem Lauf gesetzt werden.',
    onInput: () => updateDraft(self, (draft) => { draft.systemPrompt = dom.promptInput.value; }),
  });
  dom.modelSelect = h('select.select', {
    'aria-label': 'Modell',
    onChange: () => updateDraft(self, (draft) => { draft.model = parseModelValue(dom.modelSelect.value); }),
  });
  dom.modelHint = h('p.hint');
  dom.stepsInput = h('input.input', {
    type: 'number',
    min: '1',
    max: '100',
    'aria-label': 'Maximale Schritte',
    onInput: () => updateDraft(self, (draft) => { draft.permissions.maxSteps = clampInt(dom.stepsInput.value, 1, 100, 12); }),
  });
  dom.secondsInput = h('input.input', {
    type: 'number',
    min: '5',
    max: '7200',
    'aria-label': 'Maximale Laufzeit in Sekunden',
    onInput: () => updateDraft(self, (draft) => { draft.permissions.maxSeconds = clampInt(dom.secondsInput.value, 5, 7200, 300); }),
  });

  dom.editorCard = h('section.card.agentsv__card', { 'aria-label': 'Grunddaten' },
    h('div.card__head', null, h('h3', null, text('Grunddaten'))),
    h('div.card__body.stack', null,
      h('label.field', null, h('span.label', null, text('Name')), dom.nameInput),
      h('label.field', null, h('span.label', null, text('Beschreibung')), dom.descriptionInput),
      h('label.field', null, h('span.label', null, text('Systemprompt')), dom.promptInput),
      h('label.field', null, h('span.label', null, text('Modell')), dom.modelSelect, dom.modelHint),
      h('div.agentsv__limits', null,
        h('label.field', null, h('span.label', null, text('Schritte je Lauf')), dom.stepsInput,
          h('span.hint', null, text('Nach so vielen Modellaufrufen endet der Lauf – auch ohne Ergebnis.'))),
        h('label.field', null, h('span.label', null, text('Laufzeit (Sekunden)')), dom.secondsInput,
          h('span.hint', null, text('Harte Grenze. Sie wird eingehalten, auch wenn das Modell noch antwortet.'))))));

  /* --------------------------- permissions -------------------------- */

  dom.permissionGrid = h('div.agentsv__perms');
  dom.approvalSwitch = h('div.agentsv__perm.agentsv__perm--approval');
  dom.fileRoots = h('textarea.textarea.agentsv__roots', {
    'aria-label': 'Freigegebene Ordner',
    rows: 2,
    placeholder: '/home/ich/Dokumente\n/home/ich/Projekte',
    onInput: () => updateDraft(self, (draft) => { draft.permissions.fileRoots = parseLines(dom.fileRoots.value); }),
  });

  dom.permissionCard = h('section.card.agentsv__card', { 'aria-label': 'Berechtigungen' },
    h('div.card__head', null,
      h('h3', null, text('Berechtigungen')),
      h('span.spacer'),
      h('span.meta', null, text('Nicht erteilt heißt verweigert.'))),
    h('div.card__body.stack', null,
      dom.permissionGrid,
      h('label.field', null,
        h('span.label', null, text('Freigegebene Ordner (eine Zeile je Pfad)')),
        dom.fileRoots,
        h('span.hint', null, text('Nur innerhalb dieser Ordner darf der Agent lesen oder schreiben. Ohne Eintrag erreicht er keine Datei.'))),
      dom.approvalSwitch));

  /* ---------------------------- network ----------------------------- */

  dom.networkOptions = h('div.agentsv__netopts', { role: 'radiogroup', 'aria-label': 'Netzberechtigung' });
  dom.networkHosts = h('textarea.textarea', {
    'aria-label': 'Erlaubte Adressen',
    rows: 2,
    placeholder: 'api.example.com\n*.wikipedia.org',
    onInput: () => updateDraft(self, (draft) => { draft.permissions.allowedHosts = parseLines(dom.networkHosts.value); }),
  });
  dom.networkGlobal = h('p.agentsv__netglobal.meta');

  dom.networkCard = h('section.card.agentsv__card.agentsv__net', { 'aria-label': 'Netzberechtigung' },
    h('div.card__head.agentsv__net-head', null,
      h('span.agentsv__net-icon', { 'aria-hidden': 'true' }, icon(ICONS.net)),
      h('h3', null, text('Netzberechtigung')),
      h('span.spacer')),
    h('div.card__body.stack', null,
      h('p', null, text('Dies ist die einzige Berechtigung, mit der Daten dieses Gerät verlassen können. Sie wird deshalb getrennt von allem anderen entschieden.')),
      dom.networkOptions,
      h('label.field', null,
        h('span.label', null, text('Erlaubte Adressen (eine Zeile je Eintrag, * als Platzhalter)')),
        dom.networkHosts,
        h('span.hint', null, text('Leer bedeutet: es gilt allein die globale Freigabeliste im Bereich „Netzwerk“.'))),
      dom.networkGlobal));

  /* ----------------------------- tools ------------------------------ */

  dom.toolList = h('ul.agentsv__tools', { role: 'list' });
  dom.toolsCard = h('section.card.agentsv__card', { 'aria-label': 'Verfügbare Werkzeuge' },
    h('div.card__head', null, h('h3', null, text('Werkzeuge dieses Agenten'))),
    h('div.card__body', null, dom.toolList));

  /* ---------------------------- history ----------------------------- */

  dom.historyList = h('ul.agentsv__runs', { role: 'list' });
  dom.historyDetail = h('div.agentsv__rundetail', { hidden: true });
  dom.historyCard = h('section.card.agentsv__card', { 'aria-label': 'Laufhistorie' },
    h('div.card__head', null,
      h('h3', null, text('Laufhistorie')),
      h('span.spacer'),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: async () => {
          await loadRuns(self);
          if (self.alive) renderHistoryList(self);
        },
      }, text('Aktualisieren'))),
    h('div.card__body.stack', null, dom.historyList, dom.historyDetail));

  dom.main = h('section.agentsv__main', null,
    dom.head,
    dom.saveBar,
    dom.approvals,
    dom.runCard,
    dom.editorCard,
    dom.permissionCard,
    dom.networkCard,
    dom.toolsCard,
    dom.historyCard);

  dom.empty = h('div.empty', { hidden: true },
    h('h3', null, text('Noch kein Agent')),
    h('p', null, text('Ein Agent ist eine Sammlung von Berechtigungen mit einem Auftrag. Lege einen an – er darf zunächst nichts außer Notizen lesen.')),
    h('button.btn.btn--primary', { type: 'button', onClick: () => createAgent(self) }, text('Ersten Agenten anlegen')));

  dom.root = h('div.agentsv', null, dom.side, h('div.agentsv__content', null, dom.main, dom.empty));
  container.appendChild(dom.root);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function selectedAgent(self) {
  if (!self.selectedId) return null;
  return self.agents.find((agent) => agent.id === self.selectedId) || null;
}

function currentDraft(self) {
  const agent = selectedAgent(self);
  if (!agent) return null;
  if (!drafts.has(agent.id)) drafts.set(agent.id, draftFromRecord(agent));
  return drafts.get(agent.id);
}

function isDirty(self) {
  const agent = selectedAgent(self);
  if (!agent) return false;
  const draft = drafts.get(agent.id);
  if (!draft) return false;
  return !sameDraft(draft, draftFromRecord(agent));
}

function renderAll(self) {
  renderList(self);
  renderEditor(self);
  renderApprovals(self);
  renderRunPanel(self);
  renderHistoryList(self);
}

function renderList(self) {
  const { dom } = self;
  clear(dom.list);

  if (self.loadError) {
    dom.list.appendChild(h('li.agentsv__listnote.is-danger', null,
      text(`Die Agenten konnten nicht geladen werden: ${errorMessage(self.loadError)}`)));
    return;
  }
  if (self.loading && !self.agents.length) {
    dom.list.appendChild(h('li.agentsv__listnote.meta', null, text('Agenten werden geladen …')));
    return;
  }

  const needle = String(dom.filter.value || '').trim().toLowerCase();
  const rows = self.agents.filter((agent) => {
    if (!needle) return true;
    const data = dataOf(agent);
    return `${data.name || ''} ${data.description || ''}`.toLowerCase().includes(needle);
  });

  if (!rows.length) {
    dom.list.appendChild(h('li.agentsv__listnote.meta', null,
      text(needle ? 'Kein Agent passt zu diesem Filter.' : 'Noch kein Agent angelegt.')));
  }

  for (const agent of rows) {
    const data = dataOf(agent);
    const perms = normalisePermissions(data.permissions);
    const row = h('li.agentsv__row', null,
      h('button.agentsv__row-main', {
        type: 'button',
        onClick: () => selectAgent(self, agent.id),
      },
      h('span.agentsv__row-title', null,
        text(String(data.name || 'Namenloser Agent')),
        drafts.has(agent.id) && !sameDraft(drafts.get(agent.id), draftFromRecord(agent))
          ? h('span.agentsv__dot', { title: 'Ungespeicherte Änderungen' }, text('•'))
          : null),
      h('span.agentsv__row-sub.meta', null,
        text(data.description ? String(data.description).slice(0, 120) : 'Ohne Beschreibung')),
      h('span.agentsv__row-meta', null,
        badgeNode(perms.network === 'online'
          ? { label: 'Internet', tone: 'danger' }
          : perms.network === 'lan' ? { label: 'lokales Netz', tone: 'warn' } : { label: 'ohne Netz', tone: 'ok' }),
        self.runs.some((run) => dataOf(run).agentId === agent.id && self.activeRunIds.has(run.id))
          ? badgeNode({ label: 'läuft', tone: 'accent' })
          : null)));
    row.classList.toggle('is-active', agent.id === self.selectedId);
    dom.list.appendChild(row);
  }
}

function renderEditor(self) {
  const { dom } = self;
  const agent = selectedAgent(self);
  dom.main.hidden = !agent;
  dom.empty.hidden = !!agent;
  if (!agent) return;

  const draft = currentDraft(self);
  const record = dataOf(agent);

  clear(dom.title);
  dom.title.appendChild(text(draft.name || 'Namenloser Agent'));

  clear(dom.badges);
  for (const badge of capabilityBadges(draft.permissions)) dom.badges.appendChild(badgeNode(badge));

  clear(dom.summary);
  const description = self.descriptions && self.descriptions[agent.id];
  dom.summary.appendChild(text(description
    ? String(description).replace(/\s*\n\s*/g, ' ')
    : 'Der Server hat zu diesem Agenten keine Zusammenfassung geliefert. Es gelten die Schalter unten.'));

  dom.deleteButton.disabled = record.builtin === true;
  dom.deleteButton.title = record.builtin === true
    ? 'Mitgelieferte Agenten lassen sich nicht löschen.'
    : 'Diesen Agenten löschen';

  // Inputs are only written when their value really differs: assigning to a
  // focused field would move the caret to the end while the user types.
  setValue(dom.nameInput, draft.name);
  setValue(dom.descriptionInput, draft.description);
  setValue(dom.promptInput, draft.systemPrompt);
  setValue(dom.stepsInput, String(draft.permissions.maxSteps));
  setValue(dom.secondsInput, String(draft.permissions.maxSeconds));
  setValue(dom.fileRoots, draft.permissions.fileRoots.join('\n'));
  setValue(dom.networkHosts, draft.permissions.allowedHosts.join('\n'));

  renderModelSelect(self, draft);
  renderPermissions(self, draft);
  renderNetwork(self, draft);
  renderTools(self);
  updateSaveBar(self);
  updateRunButtons(self);
}

function setValue(node, value) {
  const next = value === null || value === undefined ? '' : String(value);
  if (node.value !== next) node.value = next;
}

function renderModelSelect(self, draft) {
  const select = self.dom.modelSelect;
  const previous = modelValue(draft.model);
  clear(select);
  select.appendChild(h('option', { value: '' }, text('Standardmodell verwenden')));

  const providers = (self.models && Array.isArray(self.models.providers)) ? self.models.providers : [];
  let options = 0;
  for (const provider of providers) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (!models.length) continue;
    const group = h('optgroup', { label: `${provider.id}${provider.available ? '' : ' (nicht erreichbar)'}` });
    for (const model of models) {
      const id = typeof model === 'string' ? model : model && model.id;
      if (!id) continue;
      const label = typeof model === 'string' ? model : (model.name || model.id);
      group.appendChild(h('option', { value: `${provider.id}/${id}` }, text(label)));
      options += 1;
    }
    select.appendChild(group);
  }

  // A model the agent was configured with may not be on offer right now (the
  // backend is down). Keep it selectable and say so, instead of silently
  // switching the agent to something else.
  if (previous && !select.querySelector(`option[value="${cssEscape(previous)}"]`)) {
    select.appendChild(h('option', { value: previous }, text(`${previous} (derzeit nicht gefunden)`)));
  }
  select.value = previous;

  clear(self.dom.modelHint);
  if (self.modelsError) {
    self.dom.modelHint.appendChild(text(`Die Modellliste konnte nicht geladen werden: ${self.modelsError}`));
  } else if (!options) {
    self.dom.modelHint.appendChild(text('Es wurde noch kein Modell gefunden. Unter „Einstellungen → Modelle“ lässt sich erneut suchen.'));
  } else {
    self.dom.modelHint.appendChild(text('Ohne Auswahl wird das in den Einstellungen hinterlegte Standardmodell benutzt.'));
  }
}

/** Escape a value for use inside an attribute selector without a library. */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function permissionSwitch(self, { key, label, consequence, value, danger, onChange }) {
  const input = h('input', {
    type: 'checkbox',
    checked: value === true,
    onChange: (event) => onChange(event.target.checked === true),
  });
  input.dataset.perm = key;
  const node = h('label.agentsv__perm', null,
    h('span.agentsv__perm-box', null, input),
    h('span.agentsv__perm-body', null,
      h('span.agentsv__perm-label', null, text(label)),
      h('span.agentsv__perm-consequence', null, text(consequence))));
  if (danger) node.classList.add('is-danger-perm');
  if (value === true) node.classList.add('is-on');
  return node;
}

function renderPermissions(self, draft) {
  const grid = self.dom.permissionGrid;
  clear(grid);
  for (const capability of CAPABILITIES) {
    grid.appendChild(permissionSwitch(self, {
      key: capability.key,
      label: capability.label,
      consequence: capability.consequence,
      value: draft.permissions[capability.key] === true,
      danger: capability.key === 'writeFiles' || capability.key === 'spawnAgents',
      onChange: (checked) => {
        updateDraft(self, (d) => { d.permissions[capability.key] = checked; });
        renderPermissions(self, currentDraft(self));
        renderBadgesOnly(self);
      },
    }));
  }

  const approval = self.dom.approvalSwitch;
  clear(approval);
  approval.appendChild(permissionSwitch(self, {
    key: 'requireApproval',
    label: 'Fragt vor jeder Änderung nach',
    consequence: draft.permissions.requireApproval
      ? 'Jede schreibende Aktion wartet auf dein „Erlauben“. Das ist der Normalfall.'
      : 'Der Agent handelt ohne Rückfrage – Änderungen an Notizen, Dateien und Aufgaben geschehen sofort.',
    value: draft.permissions.requireApproval === true,
    danger: draft.permissions.requireApproval !== true,
    onChange: (checked) => {
      updateDraft(self, (d) => { d.permissions.requireApproval = checked; });
      renderPermissions(self, currentDraft(self));
      renderBadgesOnly(self);
    },
  }));
}

function renderBadgesOnly(self) {
  const draft = currentDraft(self);
  if (!draft) return;
  clear(self.dom.badges);
  for (const badge of capabilityBadges(draft.permissions)) self.dom.badges.appendChild(badgeNode(badge));
}

function renderNetwork(self, draft) {
  const box = self.dom.networkOptions;
  clear(box);
  for (const level of NETWORK_LEVELS) {
    const input = h('input', {
      type: 'radio',
      name: 'agent-network',
      value: level.value,
      checked: draft.permissions.network === level.value,
      onChange: () => {
        updateDraft(self, (d) => { d.permissions.network = level.value; });
        renderNetwork(self, currentDraft(self));
        renderBadgesOnly(self);
      },
    });
    const option = h('label.agentsv__netopt', null,
      h('span.agentsv__netopt-box', null, input),
      h('span.agentsv__netopt-body', null,
        h('span.agentsv__netopt-label', null, text(level.label)),
        h('span.agentsv__netopt-text', null, text(level.consequence))));
    option.dataset.level = level.value;
    if (draft.permissions.network === level.value) option.classList.add('is-on');
    box.appendChild(option);
  }

  const globalMode = readGlobalMode(self);
  clear(self.dom.networkGlobal);
  self.dom.networkGlobal.appendChild(text(
    globalMode
      ? `Der globale Netzmodus ist derzeit „${modeLabel(globalMode)}“. Er begrenzt diese Einstellung: Was dort gesperrt ist, bleibt auch für diesen Agenten gesperrt.`
      : 'Der globale Netzmodus ist unbekannt – er begrenzt diese Einstellung zusätzlich.',
  ));
}

function modeLabel(mode) {
  if (mode === 'offline') return 'Offline';
  if (mode === 'lan') return 'Lokales Netz';
  if (mode === 'online') return 'Internet';
  return 'unbekannt';
}

function readGlobalMode(self) {
  const network = self.ctx.state && self.ctx.state.get ? self.ctx.state.get('network') : null;
  if (network && typeof network.mode === 'string') return network.mode;
  const status = self.ctx.state && self.ctx.state.get ? self.ctx.state.get('status') : null;
  if (status && status.network && typeof status.network.mode === 'string') return status.network.mode;
  return null;
}

function renderTools(self) {
  const box = self.dom.toolList;
  clear(box);
  if (self.toolProblem) {
    box.appendChild(h('li.meta.is-danger', null, text(`Werkzeugliste nicht verfügbar: ${self.toolProblem}`)));
    return;
  }
  if (!self.tools.length) {
    box.appendChild(h('li.meta', null, text('Mit den derzeit erteilten Berechtigungen steht diesem Agenten kein einziges Werkzeug zur Verfügung.')));
    return;
  }
  for (const tool of self.tools) {
    box.appendChild(h('li.agentsv__tool', null,
      h('span.agentsv__tool-icon', { 'aria-hidden': 'true' }, icon(ICONS.tool)),
      h('span.agentsv__tool-body', null,
        h('code.code', null, text(String(tool.name || ''))),
        h('span.meta', null, text(String(tool.description || 'Ohne Beschreibung.'))))));
  }
  box.appendChild(h('li.meta.agentsv__tool-note', null,
    text('Diese Liste ist bereits nach den Berechtigungen gefiltert – sie zeigt, was der Agent wirklich aufrufen kann.')));
}

function updateSaveBar(self) {
  const dirty = isDirty(self);
  self.dom.saveBar.hidden = !dirty;
}

function updateRunButtons(self) {
  const agent = selectedAgent(self);
  const running = !!(self.run && (self.run.status === 'running' || self.run.status === 'queued' || self.run.status === 'waiting-approval'));
  self.dom.startButton.disabled = !agent || running || self.runBusy || !String(self.dom.goal.value || '').trim();
  self.dom.abortButton.hidden = !running;
}

/* ------------------------------------------------------------------ */
/* Draft handling                                                      */
/* ------------------------------------------------------------------ */

function updateDraft(self, mutate) {
  const draft = currentDraft(self);
  if (!draft) return;
  mutate(draft);
  updateSaveBar(self);
  if (self.dom.title && typeof draft.name === 'string') {
    clear(self.dom.title);
    self.dom.title.appendChild(text(draft.name || 'Namenloser Agent'));
  }
  renderList(self);
}

function discardDraft(self) {
  const agent = selectedAgent(self);
  if (!agent) return;
  drafts.delete(agent.id);
  renderEditor(self);
  renderList(self);
}

async function saveAgent(self) {
  const agent = selectedAgent(self);
  const draft = currentDraft(self);
  if (!agent || !draft) return;
  const name = String(draft.name || '').trim();
  if (!name) {
    self.ctx.toast('Ein Agent braucht einen Namen.', 'error');
    self.dom.nameInput.focus();
    return;
  }

  const body = {
    name,
    description: draft.description,
    systemPrompt: draft.systemPrompt,
    model: draft.model,
    permissions: draft.permissions,
  };

  try {
    const result = await request(self, (signal) => self.api.patch(`/agents/${encodeURIComponent(agent.id)}`, body, { signal }));
    if (!self.alive) return;
    const record = recordOf(result);
    if (record) {
      const index = self.agents.findIndex((a) => a.id === record.id);
      if (index !== -1) self.agents[index] = record;
      if (result && result.description) self.descriptions[record.id] = result.description;
      drafts.delete(record.id);
    }
    self.ctx.toast('Agent gespeichert.', 'success');
    await loadAgentDetail(self, agent.id);
    if (!self.alive) return;
    renderEditor(self);
    renderList(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Speichern fehlgeschlagen: ${errorMessage(err)}`, 'error');
  }
}

async function createAgent(self) {
  try {
    const result = await request(self, (signal) => self.api.post('/agents', {
      name: 'Neuer Agent',
      description: '',
      systemPrompt: 'Du bist ein sorgfältiger Assistent. Arbeite in kleinen Schritten und erkläre, was du tust.',
      // Absent capability = denied: start from the least privilege that is
      // still useful, and let the user widen it deliberately.
      permissions: {
        readNotes: true,
        writeNotes: false,
        readFiles: false,
        writeFiles: false,
        createEdges: false,
        runTasks: false,
        spawnAgents: false,
        network: 'offline',
        allowedHosts: [],
        fileRoots: [],
        requireApproval: true,
        maxSteps: 12,
        maxSeconds: 300,
      },
    }, { signal }));
    if (!self.alive) return;
    const record = recordOf(result);
    if (!record) throw new Error('Der Server hat keinen Agenten zurückgegeben.');
    self.agents = [record, ...self.agents];
    if (result && result.description) self.descriptions[record.id] = result.description;
    await selectAgent(self, record.id);
    if (!self.alive) return;
    self.dom.nameInput.focus();
    self.dom.nameInput.select();
    self.ctx.toast('Agent angelegt. Er darf zunächst nur Notizen lesen.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Agent konnte nicht angelegt werden: ${errorMessage(err)}`, 'error');
  }
}

async function deleteAgent(self) {
  const agent = selectedAgent(self);
  if (!agent) return;
  const data = dataOf(agent);
  const ok = await self.ctx.confirm({
    title: 'Agent löschen?',
    message: `„${data.name || agent.id}“ wird gelöscht. Bereits gelaufene Läufe bleiben im Tresor erhalten.`,
    confirmLabel: 'Löschen',
    danger: true,
  });
  if (!ok || !self.alive) return;
  try {
    await request(self, (signal) => self.api.del(`/agents/${encodeURIComponent(agent.id)}`, { signal }));
    if (!self.alive) return;
    drafts.delete(agent.id);
    self.agents = self.agents.filter((a) => a.id !== agent.id);
    self.selectedId = self.agents.length ? self.agents[0].id : null;
    if (self.selectedId) await loadAgentDetail(self, self.selectedId);
    if (!self.alive) return;
    renderAll(self);
    self.ctx.toast('Agent gelöscht.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Löschen fehlgeschlagen: ${errorMessage(err)}`, 'error');
  }
}

async function selectAgent(self, id) {
  if (self.selectedId === id) return;
  self.selectedId = id;
  self.run = null;
  self.runBusy = false;
  renderAll(self);
  await loadAgentDetail(self, id);
  if (!self.alive || self.selectedId !== id) return;
  renderEditor(self);
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

async function startRun(self) {
  const agent = selectedAgent(self);
  if (!agent || self.runBusy) return;
  const goal = String(self.dom.goal.value || '').trim();
  if (!goal) {
    self.ctx.toast('Ohne Zielvorgabe kann kein Lauf starten.', 'error');
    self.dom.goal.focus();
    return;
  }
  if (isDirty(self)) {
    const ok = await self.ctx.confirm({
      title: 'Ungespeicherte Änderungen',
      message: 'Der Lauf benutzt die gespeicherten Berechtigungen, nicht die im Formular geänderten. Trotzdem starten?',
      confirmLabel: 'Trotzdem starten',
    });
    if (!ok || !self.alive) return;
  }

  self.runBusy = true;
  updateRunButtons(self);
  self.run = { id: null, steps: [], status: 'queued', result: '', error: null, usedNetwork: false, goal, startedAt: Date.now() };
  renderRunPanel(self);

  try {
    const result = await request(self, (signal) => self.api.post(
      `/agents/${encodeURIComponent(agent.id)}/run`,
      { goal },
      { signal, timeoutMs: 20000 },
    ));
    if (!self.alive) return;
    const runId = (result && result.runId) || (recordOf(result) && recordOf(result).id);
    if (!runId) throw new Error('Der Server hat keine Lauf-Kennung zurückgegeben.');
    self.run.id = runId;
    self.run.record = recordOf(result);
    self.run.status = 'running';
    self.activeRunIds.add(runId);
    renderRunPanel(self);
    // Steps arrive over the bus from here; the record is the fallback if the
    // stream was interrupted while the run continued on the server.
    await loadRuns(self);
    if (self.alive) renderHistoryList(self);
  } catch (err) {
    if (!self.alive) return;
    self.run.status = 'failed';
    self.run.error = { code: err && err.code, message: errorMessage(err) };
    if (!(err && err.isAborted)) self.ctx.toast(`Lauf konnte nicht gestartet werden: ${errorMessage(err)}`, 'error');
  } finally {
    self.runBusy = false;
    if (self.alive) {
      updateRunButtons(self);
      renderRunPanel(self);
    }
  }
}

async function abortRun(self) {
  if (!self.run || !self.run.id) return;
  try {
    await request(self, (signal) => self.api.post(`/runs/${encodeURIComponent(self.run.id)}/abort`, {}, { signal }));
    if (!self.alive) return;
    self.ctx.toast('Abbruch angefordert.', 'info');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Abbruch fehlgeschlagen: ${errorMessage(err)}`, 'error');
  }
}

function renderRunPanel(self) {
  const { dom } = self;
  const run = self.run;

  clear(dom.runState);
  if (!run) {
    dom.runState.appendChild(text('Kein Lauf in dieser Sitzung.'));
  } else {
    const label = RUN_STATUS_LABEL[run.status] || run.status || 'unbekannt';
    dom.runState.appendChild(text(run.id ? `Lauf ${label} · ${run.id}` : `Lauf ${label}`));
  }

  clear(dom.steps);
  if (run && run.steps.length) {
    for (const step of run.steps) dom.steps.appendChild(renderStep(step));
  } else if (run && run.status === 'running') {
    dom.steps.appendChild(h('li.agentsv__step.agentsv__step--wait', null,
      h('span.spinner', { 'aria-hidden': 'true' }),
      h('span', null, text('Der Agent denkt nach. Die Schritte erscheinen hier, sobald der Server sie meldet.'))));
  }

  clear(dom.runResult);
  dom.runResult.hidden = true;
  if (run && (run.status === 'done' || run.status === 'failed' || run.status === 'aborted')) {
    dom.runResult.hidden = false;
    dom.runResult.appendChild(h('div.agentsv__result-head', null,
      h('strong', null, text(run.status === 'done' ? 'Ergebnis' : run.status === 'aborted' ? 'Abgebrochen' : 'Fehlgeschlagen')),
      h('span.spacer'),
      badgeNode(run.usedNetwork
        ? { label: 'Netz benutzt', tone: 'danger' }
        : { label: 'ohne Netz gelaufen', tone: 'ok' })));
    if (run.stopReason && STOP_REASON_LABEL[run.stopReason]) {
      dom.runResult.appendChild(h('p.meta', null, text(STOP_REASON_LABEL[run.stopReason])));
    }
    if (run.error) {
      dom.runResult.appendChild(h('p.is-danger', null,
        text(`${run.error.code ? `${run.error.code}: ` : ''}${run.error.message || 'Unbekannter Fehler.'}`)));
    }
    if (run.result) dom.runResult.appendChild(h('div.agentsv__result-body', null, text(String(run.result))));
  }

  updateRunButtons(self);
}

function renderStep(step) {
  const kind = step && step.kind;
  const node = h('li.agentsv__step');
  node.dataset.kind = String(kind || 'unknown');

  const head = h('div.agentsv__step-head', null,
    h('span.agentsv__step-n', null, text(`#${step.n === undefined ? '?' : step.n}`)),
    h('span.agentsv__step-kind', null, text(
      kind === 'model' ? 'Modell' : kind === 'tool' ? 'Werkzeug' : kind === 'note' ? 'Hinweis' : String(kind || 'Schritt'),
    )),
    h('span.spacer'),
    Number.isFinite(step.ms) ? h('span.meta', null, text(`${formatNumber(step.ms)} ms`)) : null,
    step.at ? h('span.meta', null, text(formatDateTime(step.at))) : null);
  node.appendChild(head);

  if (kind === 'model') {
    if (step.model) {
      node.appendChild(h('p.meta', null, text(
        `${modelRefLabel(step.model)}${step.protocol ? ` · Protokoll: ${step.protocol === 'native' ? 'nativ' : 'Text'}` : ''}`,
      )));
    }
    if (step.content) node.appendChild(h('div.agentsv__step-text', null, text(String(step.content))));
    const calls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    for (const call of calls) {
      node.appendChild(h('div.agentsv__call', null,
        h('span.agentsv__call-name', null, text(`ruft ${call.name || 'unbenanntes Werkzeug'}`)),
        h('pre.code.agentsv__code', null, text(pretty(call.arguments)))));
    }
    if (step.stats && (step.stats.promptTokens || step.stats.completionTokens)) {
      node.appendChild(h('p.meta', null, text(
        `Token: ${formatNumber(step.stats.promptTokens || 0)} hinein, ${formatNumber(step.stats.completionTokens || 0)} heraus.`,
      )));
    }
  } else if (kind === 'tool') {
    node.classList.toggle('is-failed', step.ok !== true);
    node.appendChild(h('p.agentsv__step-tool', null,
      h('code.code', null, text(String(step.tool || 'unbekannt'))),
      h('span.meta', null, text(step.ok === true ? ' · erfolgreich' : ' · fehlgeschlagen'))));
    node.appendChild(h('details.agentsv__details', null,
      h('summary', null, text('Aufrufparameter')),
      h('pre.code.agentsv__code', null, text(pretty(step.args)))));
    if (step.ok === true) {
      node.appendChild(h('details.agentsv__details', null,
        h('summary', null, text('Ergebnis')),
        h('pre.code.agentsv__code', null, text(pretty(step.result)))));
    } else {
      node.appendChild(h('div.agentsv__step-error', null, text(pretty(step.error))));
    }
  } else if (kind === 'note') {
    node.appendChild(h('p', null, text(String(step.note || ''))));
    if (step.detail) node.appendChild(h('p.meta', null, text(String(step.detail))));
  } else {
    node.appendChild(h('pre.code.agentsv__code', null, text(pretty(step))));
  }

  return node;
}

function modelRefLabel(model) {
  if (!model) return 'Modell unbekannt';
  if (typeof model === 'string') return model;
  const provider = model.provider || model.providerId || '';
  const name = model.model || model.id || '';
  return provider ? `${provider}/${name}` : String(name || 'Modell unbekannt');
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

function renderApprovals(self) {
  const box = self.dom.approvals;
  clear(box);
  const pending = self.approvals.filter((row) => row && row.id);
  if (!pending.length) return;

  box.appendChild(h('h3.agentsv__approvals-title', null,
    icon(ICONS.alert),
    text(pending.length === 1 ? 'Ein Agent wartet auf deine Entscheidung' : `${pending.length} Agenten warten auf deine Entscheidung`)));

  for (const record of pending) {
    const data = dataOf(record);
    const agent = self.agents.find((a) => a.id === data.agentId);
    const payload = data.payload || {};
    const busy = self.approvalBusy.has(record.id);

    box.appendChild(h('article.card.agentsv__approval', { 'aria-label': 'Bestätigung erforderlich' },
      h('div.card__body.stack', null,
        h('div.row', null,
          badgeNode({ label: APPROVAL_KIND_LABEL[data.kind] || String(data.kind || 'Aktion'), tone: data.kind === 'network' ? 'danger' : 'warn' }),
          h('span.meta', null, text(agent ? String(dataOf(agent).name || agent.id) : (data.agentId || 'unbekannter Agent'))),
          h('span.spacer'),
          h('span.meta', null, text(record.createdAt ? timeAgo(record.createdAt) : ''))),
        h('p.agentsv__approval-summary', null, text(String(data.summary || 'Der Agent möchte eine Aktion ausführen.'))),
        payload.tool
          ? h('p.meta', null, text('Werkzeug: '), h('code.code', null, text(String(payload.tool))))
          : null,
        h('details.agentsv__details', { open: true },
          h('summary', null, text('Das wird ausgeführt')),
          h('pre.code.agentsv__code', null, text(pretty(payload.args !== undefined ? payload.args : payload)))),
        data.runId
          ? h('p.meta', null, text(`Gehört zum Lauf ${data.runId}.`))
          : null,
        h('div.row', null,
          h('button.btn.btn--primary', {
            type: 'button',
            disabled: busy,
            onClick: () => decideApproval(self, record.id, 'approved'),
          }, icon(ICONS.check), text('Erlauben')),
          h('button.btn.btn--danger', {
            type: 'button',
            disabled: busy,
            onClick: () => decideApproval(self, record.id, 'denied'),
          }, icon(ICONS.close), text('Ablehnen')),
          h('span.hint', null, text('Eine Ablehnung ist eine Antwort, kein Fehler: der Lauf arbeitet ohne diese Aktion weiter oder endet.'))))));
  }
}

async function decideApproval(self, id, decision) {
  if (self.approvalBusy.has(id)) return;
  self.approvalBusy.add(id);
  renderApprovals(self);
  try {
    await request(self, (signal) => self.api.post(`/approvals/${encodeURIComponent(id)}`, { decision }, { signal }));
    if (!self.alive) return;
    self.approvals = self.approvals.filter((row) => row.id !== id);
    self.ctx.toast(decision === 'approved' ? 'Erlaubt.' : 'Abgelehnt.', decision === 'approved' ? 'success' : 'info');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Die Entscheidung konnte nicht übermittelt werden: ${errorMessage(err)}`, 'error');
  } finally {
    self.approvalBusy.delete(id);
    if (self.alive) renderApprovals(self);
  }
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function renderHistoryList(self) {
  const box = self.dom.historyList;
  clear(box);

  const agentId = self.selectedId;
  const rows = self.runs.filter((run) => !agentId || dataOf(run).agentId === agentId);
  if (!rows.length) {
    box.appendChild(h('li.meta', null, text('Für diesen Agenten ist noch kein Lauf verzeichnet.')));
    return;
  }

  for (const run of rows.slice(0, 40)) {
    const data = dataOf(run);
    const active = self.activeRunIds.has(run.id);
    const row = h('li.agentsv__run', null,
      h('button.agentsv__run-main', {
        type: 'button',
        onClick: () => openHistory(self, run.id),
      },
      h('span.agentsv__run-goal', null, text(String(data.goal || 'Ohne Zielvorgabe').slice(0, 160))),
      h('span.agentsv__run-meta', null,
        badgeNode(runTone(data.status, active)),
        data.usedNetwork
          ? badgeNode({ label: 'Netz benutzt', tone: 'danger' })
          : badgeNode({ label: 'ohne Netz', tone: 'ok' }),
        h('span.meta', null, text(run.createdAt ? timeAgo(run.createdAt) : '')),
        h('span.meta', null, text(`${formatNumber((data.steps || []).length)} Schritte`)))));
    row.classList.toggle('is-active', self.historyId === run.id);
    box.appendChild(row);
  }
}

function runTone(status, active) {
  if (active) return { label: 'läuft', tone: 'accent' };
  if (status === 'done') return { label: 'fertig', tone: 'ok' };
  if (status === 'failed') return { label: 'fehlgeschlagen', tone: 'danger' };
  if (status === 'aborted') return { label: 'abgebrochen', tone: 'warn' };
  return { label: RUN_STATUS_LABEL[status] || String(status || 'unbekannt'), tone: 'neutral' };
}

async function openHistory(self, runId) {
  self.historyId = runId;
  self.historyRecord = null;
  self.historyError = null;
  renderHistoryList(self);
  renderHistoryDetail(self, true);
  try {
    const result = await request(self, (signal) => self.api.get(`/runs/${encodeURIComponent(runId)}`, { signal }));
    if (!self.alive || self.historyId !== runId) return;
    self.historyRecord = recordOf(result);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.historyError = errorMessage(err);
  }
  if (self.alive) renderHistoryDetail(self, false);
}

function renderHistoryDetail(self, loading) {
  const box = self.dom.historyDetail;
  clear(box);
  if (!self.historyId) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  if (loading) {
    box.appendChild(h('p.meta', null, text('Protokoll wird geladen …')));
    return;
  }
  if (self.historyError) {
    box.appendChild(h('p.is-danger', null, text(`Das Protokoll konnte nicht geladen werden: ${self.historyError}`)));
    return;
  }
  const record = self.historyRecord;
  if (!record) {
    box.appendChild(h('p.meta', null, text('Zu diesem Lauf liegt kein Datensatz vor.')));
    return;
  }

  const data = dataOf(record);
  const steps = Array.isArray(data.steps) ? data.steps : [];
  box.appendChild(h('div.agentsv__rundetail-head', null,
    h('strong', null, text(String(data.goal || 'Ohne Zielvorgabe'))),
    h('span.spacer'),
    h('button.btn.btn--small', {
      type: 'button',
      onClick: () => {
        self.historyId = null;
        self.historyRecord = null;
        renderHistoryList(self);
        renderHistoryDetail(self, false);
      },
    }, text('Schließen'))));

  box.appendChild(h('div.row', null,
    badgeNode(runTone(data.status, self.activeRunIds.has(record.id))),
    data.usedNetwork
      ? badgeNode({ label: 'Netz benutzt', tone: 'danger' })
      : badgeNode({ label: 'ohne Netz gelaufen', tone: 'ok' }),
    h('span.meta', null, text(`Start: ${data.startedAt ? formatDateTime(data.startedAt) : 'unbekannt'}`)),
    h('span.meta', null, text(`Ende: ${data.finishedAt ? formatDateTime(data.finishedAt) : '–'}`)),
    h('span.meta', null, text(`${formatNumber(steps.length)} Schritte`))));

  if (Array.isArray(data.networkTargets) && data.networkTargets.length) {
    box.appendChild(h('p.meta', null, text(`Angesprochene Ziele: ${data.networkTargets.join(', ')}`)));
  } else if (data.usedNetwork) {
    box.appendChild(h('p.meta', null, text('Der Lauf hat das Netz benutzt; die Ziele stehen im Netz-Protokoll unter „Netzwerk“.')));
  }

  if (data.error) {
    box.appendChild(h('p.is-danger', null,
      text(`${data.error.code ? `${data.error.code}: ` : ''}${data.error.message || 'Unbekannter Fehler.'}`)));
  }
  if (data.result) box.appendChild(h('div.agentsv__result-body', null, text(String(data.result))));

  const stepList = h('ol.agentsv__steps', { role: 'list' });
  if (!steps.length) {
    stepList.appendChild(h('li.meta', null, text('Für diesen Lauf sind keine Schritte gespeichert.')));
  } else {
    for (const step of steps) stepList.appendChild(renderStep(step));
  }
  box.appendChild(stepList);

  if (Array.isArray(data.producedIds) && data.producedIds.length) {
    const produced = h('div.row', null, h('span.meta', null, text('Erzeugt:')));
    for (const id of data.producedIds.slice(0, 20)) {
      produced.appendChild(h('button.btn.btn--small', {
        type: 'button',
        onClick: () => self.ctx.navigate(`#/graph?focus=${encodeURIComponent(id)}`),
      }, text(id)));
    }
    box.appendChild(produced);
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
.agentsv {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.agentsv__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}
.agentsv__side-head { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2); }
.agentsv__list { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 0 var(--sp-1) var(--sp-2); list-style: none; }
.agentsv__listnote { padding: var(--sp-1) var(--sp-1) var(--sp-2); }
.agentsv__row { border-radius: var(--r-2); }
.agentsv__row:hover { background: var(--surface-3); }
.agentsv__row.is-active { background: var(--accent-soft); }
.agentsv__row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: var(--sp-1);
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.agentsv__row-title { display: flex; align-items: center; gap: 6px; font-weight: 500; }
.agentsv__dot { color: var(--accent); font-size: var(--fs-lg); line-height: 0.6; }
.agentsv__row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agentsv__row-meta { display: flex; flex-wrap: wrap; gap: 4px; }
.agentsv__content { min-width: 0; min-height: 0; overflow-y: auto; }
.agentsv__main {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-width: 900px;
  padding: var(--sp-3) var(--sp-3) var(--sp-8);
}
.agentsv__head { display: flex; align-items: flex-start; gap: var(--sp-2); }
.agentsv__head-main { display: flex; flex-direction: column; gap: var(--sp-05); min-width: 0; }
.agentsv__head-actions { margin-left: auto; display: flex; gap: var(--sp-1); }
.agentsv__title { font-size: var(--fs-xl); }
.agentsv__badges { display: flex; flex-wrap: wrap; gap: 4px; }
.agentsv__badge[data-tone="ok"] { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
.agentsv__badge[data-tone="warn"] { color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }
.agentsv__badge[data-tone="danger"] { color: var(--danger); background: var(--danger-soft); }
.agentsv__badge[data-tone="accent"] { color: var(--accent); background: var(--accent-soft); }
.agentsv__summary { margin: 0; }
.agentsv__savebar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: var(--r-2);
}
.agentsv__card { scroll-margin-top: var(--sp-3); }
.agentsv__goal { min-height: 76px; }
.agentsv__prompt { min-height: 130px; font-family: var(--font-mono); font-size: var(--fs-sm); }
.agentsv__roots { min-height: 56px; font-family: var(--font-mono); font-size: var(--fs-sm); }
.agentsv__limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--sp-2); }

.agentsv__perms { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--sp-1); }
.agentsv__perm {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  cursor: pointer;
}
.agentsv__perm:hover { background: var(--surface-2); }
.agentsv__perm.is-on { border-color: var(--border-strong); background: var(--surface-2); }
.agentsv__perm.is-danger-perm.is-on { border-color: var(--danger); background: var(--danger-soft); }
.agentsv__perm-box { display: flex; align-items: flex-start; padding-top: 2px; }
.agentsv__perm-body { display: flex; flex-direction: column; gap: 2px; }
.agentsv__perm-label { font-weight: 500; }
.agentsv__perm-consequence { font-size: var(--fs-sm); color: var(--fg-muted); }
.agentsv__perm--approval { margin-top: var(--sp-1); }

.agentsv__net { border-color: var(--border-strong); box-shadow: var(--shadow-2); }
.agentsv__net-head { background: var(--surface-2); border-top-left-radius: var(--r-3); border-top-right-radius: var(--r-3); }
.agentsv__net-icon { display: inline-flex; color: var(--fg-muted); }
.agentsv__netopts { display: flex; flex-direction: column; gap: var(--sp-1); }
.agentsv__netopt {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  cursor: pointer;
}
.agentsv__netopt.is-on { border-color: var(--border-strong); background: var(--surface-2); }
.agentsv__netopt[data-level="online"].is-on { border-color: var(--net-online); background: var(--danger-soft); }
.agentsv__netopt[data-level="lan"].is-on { border-color: var(--net-lan); }
.agentsv__netopt[data-level="offline"].is-on { border-color: var(--net-offline); }
.agentsv__netopt-box { display: flex; align-items: flex-start; padding-top: 2px; }
.agentsv__netopt-body { display: flex; flex-direction: column; gap: 2px; }
.agentsv__netopt-label { font-weight: 500; }
.agentsv__netopt-text { font-size: var(--fs-sm); color: var(--fg-muted); }
.agentsv__netglobal { margin: 0; }

.agentsv__runstate { text-align: right; }
.agentsv__steps { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; padding: 0; list-style: none; }
.agentsv__step {
  padding: var(--sp-1);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border-strong);
  border-radius: var(--r-2);
  background: var(--surface-2);
}
.agentsv__step[data-kind="tool"] { border-left-color: var(--accent); }
.agentsv__step[data-kind="note"] { border-left-color: var(--warn); }
.agentsv__step.is-failed { border-left-color: var(--danger); }
.agentsv__step--wait { display: flex; align-items: center; gap: var(--sp-1); color: var(--fg-muted); }
.agentsv__step-head { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--fg-muted); }
.agentsv__step-n { font-family: var(--font-mono); }
.agentsv__step-kind { font-weight: 500; color: var(--fg); }
.agentsv__step-text { margin-top: var(--sp-05); white-space: pre-wrap; }
.agentsv__step-tool { margin: var(--sp-05) 0 0; }
.agentsv__step-error { margin-top: var(--sp-05); padding: var(--sp-1); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-1); white-space: pre-wrap; font-family: var(--font-mono); font-size: var(--fs-sm); }
.agentsv__call { margin-top: var(--sp-05); }
.agentsv__call-name { font-size: var(--fs-sm); font-weight: 500; }
.agentsv__code { max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.agentsv__details { margin-top: var(--sp-05); }
.agentsv__details > summary { cursor: pointer; font-size: var(--fs-sm); color: var(--fg-muted); }
.agentsv__result { padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface-2); }
.agentsv__result-head { display: flex; align-items: center; gap: var(--sp-1); margin-bottom: var(--sp-1); }
.agentsv__result-body { white-space: pre-wrap; }

.agentsv__approvals { display: flex; flex-direction: column; gap: var(--sp-1); }
.agentsv__approvals-title { display: flex; align-items: center; gap: var(--sp-1); color: var(--warn); }
.agentsv__approval { border-color: var(--warn); }
.agentsv__approval-summary { margin: 0; font-size: var(--fs-md); }

.agentsv__tools { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; padding: 0; list-style: none; }
.agentsv__tool { display: flex; gap: var(--sp-1); }
.agentsv__tool-icon { color: var(--fg-subtle); }
.agentsv__tool-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.agentsv__tool-note { padding-top: var(--sp-1); border-top: 1px solid var(--border); }

.agentsv__runs { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.agentsv__run { border-bottom: 1px solid var(--border); }
.agentsv__run.is-active { background: var(--accent-soft); }
.agentsv__run-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: var(--sp-1);
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.agentsv__run-goal { font-weight: 500; }
.agentsv__run-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.agentsv__rundetail { display: flex; flex-direction: column; gap: var(--sp-1); padding-top: var(--sp-1); border-top: 1px solid var(--border); }
.agentsv__rundetail-head { display: flex; align-items: center; gap: var(--sp-1); }

@media (max-width: 820px) {
  .agentsv { grid-template-columns: 1fr; }
  .agentsv__side { border-right: 0; border-bottom: 1px solid var(--border); max-height: 40vh; }
  .agentsv__main { padding: var(--sp-2) var(--sp-2) var(--sp-6); }
}
`;
