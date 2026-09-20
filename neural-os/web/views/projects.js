/**
 * views/projects.js -- projects, their tasks, and what they are made of.
 *
 * The decisions behind it
 * -----------------------
 * 1. **The board is a view of records, not a second data model.** A column is
 *    `task.status`; moving a card is a `PATCH` of that one field. The card
 *    moves optimistically because the drop already happened in the user's
 *    hands -- but if the server refuses, it snaps back and says why. Nothing
 *    on this board is true only in the browser.
 * 2. **Drag is not the only way.** Every card is focusable and moves with the
 *    left/right arrow keys; the detail panel has a plain status selector. A
 *    board that can only be operated with a mouse excludes people for no
 *    reason, and it breaks the moment a touchpad misfires.
 * 3. **Links come from the graph, not from a guess.** The notes and chats
 *    shown beside a project are the neighbours `/api/graph?focus=…&depth=1`
 *    reports, which is the same answer the "Gehirn" view gives. One request
 *    serves both the lists and the embedded map, so the two can never
 *    contradict each other.
 * 4. **The embedded map is the real renderer.** It is the same canvas engine
 *    as the graph view, limited to this project's neighbourhood. A decorative
 *    picture that is not the actual graph would teach the user to distrust
 *    both.
 * 5. **Text saves visibly.** Name, description and tags are written back after
 *    a short pause, and the status line says which state the text is in, so
 *    nobody has to wonder whether a rename survived.
 */

import {
  h, text, clear, icon, timeAgo, formatDate, formatNumber, debounce,
} from '../lib/dom.js';
import { createGraphCanvas } from '../lib/graph-canvas.js';

const STYLE_ID = 'nos-projects-view-style';

const VIEW_ICON = '<path d="M2.6 6.4a2 2 0 0 1 2-2h2.7l1.6 2h6.5a2 2 0 0 1 2 2v5.4a2 2 0 0 1-2 2h-10.8a2 2 0 0 1-2-2z"/>';

const ICONS = {
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  graph: '<circle cx="4.6" cy="14.4" r="1.9"/><circle cx="10" cy="4.4" r="1.9"/><circle cx="15.4" cy="12.8" r="1.9"/><path d="M5.6 12.7 9 6.1M11.3 5.9l3.2 5.2M6.4 14.8l7.1-1.5"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  note: '<rect x="4" y="2.5" width="12" height="15" rx="2.6"/><path d="M7 6.6h6M7 10h6M7 13.4h3.6"/>',
  chat: '<rect x="2.5" y="3.5" width="15" height="10.5" rx="3.2"/><path d="M6.6 14v3.2L10.3 14"/>',
};

const COLUMNS = [
  { status: 'todo', label: 'Offen', hint: 'Noch nicht angefangen.' },
  { status: 'doing', label: 'In Arbeit', hint: 'Läuft gerade.' },
  { status: 'blocked', label: 'Blockiert', hint: 'Wartet auf etwas anderes.' },
  { status: 'done', label: 'Erledigt', hint: 'Fertig.' },
];

const STATUS_INDEX = new Map(COLUMNS.map((column, index) => [column.status, index]));

const PROJECT_STATES = [
  { value: 'active', label: 'Aktiv' },
  { value: 'paused', label: 'Pausiert' },
  { value: 'done', label: 'Abgeschlossen' },
  { value: 'archived', label: 'Archiviert' },
];

const PRIORITIES = [
  { value: 1, label: 'Hoch' },
  { value: 2, label: 'Normal' },
  { value: 3, label: 'Niedrig' },
];

const SAVE_DEBOUNCE_MS = 700;
const TASK_PAGE = 500;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

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

function parseTags(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 40);
}

function dueState(due) {
  if (!due) return null;
  const ts = Date.parse(due);
  if (!Number.isFinite(ts)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (ts < today.getTime()) return 'overdue';
  if (ts < today.getTime() + 86400000 * 2) return 'soon';
  return 'later';
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'projects',
  title: 'Projekte',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyle();
    teardown();

    const params = (ctx.route && ctx.route.params) || {};
    const wanted = typeof params.id === 'string' ? params.id : null;

    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      container,
      cleanups: [],
      requests: new Set(),
      dom: {},

      projects: [],
      projectsError: null,
      loading: true,

      projectId: wanted && wanted.startsWith('project_') ? wanted : null,
      pendingTaskId: wanted && wanted.startsWith('task_') ? wanted : null,

      tasks: [],
      taskTotal: 0,
      tasksTruncated: false,
      tasksError: null,

      selectedTaskId: null,
      dragTaskId: null,

      neighbours: null,   // {nodes, edges} from /api/graph
      neighbourError: null,

      graph: null,
      saveState: 'clean',  // clean | dirty | saving | error
      saveError: null,
      saveSeq: 0,
    };
    view = self;

    buildLayout(self);
    subscribe(self);
    await loadProjects(self);
    if (!self.alive) return;
    await selectProject(self, self.projectId || (self.projects[0] ? self.projects[0].id : null), { initial: true });
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
  if (self.saveSoon) self.saveSoon.cancel();
  if (self.graph) {
    try { self.graph.destroy(); } catch { /* canvas already detached */ }
    self.graph = null;
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

async function loadProjects(self) {
  self.loading = true;
  try {
    const result = await request(self, (signal) => self.api.get('/records', {
      query: { type: 'project', limit: 200, sort: 'updatedAt', order: 'desc' },
      signal,
    }));
    if (!self.alive) return;
    self.projects = itemsOf(result);
    self.projectsError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.projects = [];
    self.projectsError = err;
  } finally {
    self.loading = false;
    if (self.alive) renderProjectList(self);
  }
}

/**
 * The records API filters by type, not by field, so the tasks are fetched in
 * one page and grouped here. When there are more than one page, the board says
 * so instead of quietly showing a part of the truth.
 */
async function loadTasks(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/records', {
      query: { type: 'task', limit: TASK_PAGE, sort: 'updatedAt', order: 'desc' },
      signal,
    }));
    if (!self.alive) return;
    const all = itemsOf(result);
    self.taskTotal = Number.isFinite(result && result.total) ? result.total : all.length;
    self.tasksTruncated = self.taskTotal > all.length;
    self.tasks = all.filter((task) => dataOf(task).projectId === self.projectId);
    self.tasksError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.tasks = [];
    self.tasksError = err;
  }
}

async function loadNeighbours(self) {
  if (!self.projectId) {
    self.neighbours = null;
    return;
  }
  try {
    const result = await request(self, (signal) => self.api.get('/graph', {
      query: { focus: self.projectId, depth: 1, limit: 150 },
      signal,
    }));
    if (!self.alive) return;
    self.neighbours = {
      nodes: Array.isArray(result && result.nodes) ? result.nodes : [],
      edges: Array.isArray(result && result.edges) ? result.edges : [],
    };
    self.neighbourError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.neighbours = null;
    self.neighbourError = err;
  }
}

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;
  const refresh = debounce(() => {
    if (!self.alive || !self.projectId) return;
    Promise.all([loadTasks(self), loadNeighbours(self)]).then(() => {
      if (!self.alive) return;
      renderBoard(self);
      renderLinks(self);
      renderGraph(self);
      renderProjectList(self);
    });
  }, 900);

  for (const name of ['record.created', 'record.updated', 'record.deleted', 'edge.created', 'edge.deleted']) {
    self.cleanups.push(ctx.bus.on(name, () => refresh()));
  }
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.newButton = h('button.btn.btn--primary.btn--small', {
    type: 'button',
    onClick: () => createProject(self),
  }, icon(ICONS.plus), text('Neues Projekt'));

  dom.filter = h('input.input', {
    type: 'search',
    placeholder: 'Projekte filtern …',
    'aria-label': 'Projekte filtern',
    autocomplete: 'off',
    onInput: () => renderProjectList(self),
  });

  dom.projectList = h('ul.projv__list', { role: 'list' });
  dom.side = h('aside.projv__side', { 'aria-label': 'Projekte' },
    h('div.projv__side-head', null, dom.newButton, dom.filter),
    dom.projectList);

  /* ------------------------------ header ---------------------------- */

  dom.nameInput = h('input.projv__name', {
    type: 'text',
    placeholder: 'Name des Projekts',
    'aria-label': 'Name des Projekts',
    onInput: () => markDirty(self),
    onBlur: () => flushSave(self),
  });
  dom.statusSelect = h('select.select.projv__status', {
    'aria-label': 'Status des Projekts',
    onChange: () => {
      markDirty(self);
      flushSave(self);
    },
  }, ...PROJECT_STATES.map((state) => h('option', { value: state.value }, text(state.label))));

  dom.saveState = h('span.projv__savestate.meta', { role: 'status' });

  dom.graphButton = h('button.btn.btn--small', {
    type: 'button',
    onClick: () => self.projectId && self.ctx.navigate(`#/graph?focus=${encodeURIComponent(self.projectId)}`),
  }, icon(ICONS.graph), text('Im Gehirn öffnen'));

  dom.deleteButton = h('button.btn.btn--small', {
    type: 'button',
    onClick: () => deleteProject(self),
  }, icon(ICONS.trash), text('Löschen'));

  dom.description = h('textarea.textarea.projv__description', {
    rows: 2,
    placeholder: 'Worum geht es in diesem Projekt?',
    'aria-label': 'Beschreibung',
    onInput: () => markDirty(self),
    onBlur: () => flushSave(self),
  });

  dom.tagsInput = h('input.input.projv__tags', {
    type: 'text',
    placeholder: 'Schlagworte, durch Komma getrennt',
    'aria-label': 'Schlagworte',
    onInput: () => markDirty(self),
    onBlur: () => flushSave(self),
  });

  dom.head = h('header.projv__head', null,
    h('div.projv__head-row', null, dom.nameInput, dom.statusSelect),
    h('div.projv__head-row', null, dom.saveState, h('span.spacer'), dom.graphButton, dom.deleteButton),
    dom.description,
    dom.tagsInput);

  /* ------------------------------- board ---------------------------- */

  dom.board = h('div.projv__board', { 'aria-label': 'Aufgaben' });
  dom.boardNote = h('p.projv__boardnote.meta');

  /* --------------------------- task detail -------------------------- */

  dom.taskDetail = h('section.card.projv__taskdetail', { hidden: true, 'aria-label': 'Aufgabe bearbeiten' });

  /* ------------------------------ links ----------------------------- */

  dom.noteList = h('ul.projv__links', { role: 'list' });
  dom.chatList = h('ul.projv__links', { role: 'list' });
  dom.linkNote = h('p.meta');
  dom.linksCard = h('section.card.projv__card', { 'aria-label': 'Verknüpfte Einträge' },
    h('div.card__head', null, h('h3', null, text('Verknüpft mit diesem Projekt'))),
    h('div.card__body.projv__linkgrid', null,
      h('div', null, h('h4.projv__linktitle', null, text('Notizen')), dom.noteList),
      h('div', null, h('h4.projv__linktitle', null, text('Chats')), dom.chatList)),
    h('div.card__foot', null, dom.linkNote));

  /* ------------------------------ graph ----------------------------- */

  dom.canvas = h('canvas.projv__canvas', {
    role: 'img',
    'aria-label': 'Ausschnitt des Wissensgraphen rund um dieses Projekt',
  });
  dom.graphNote = h('p.meta.projv__graphnote');
  dom.graphCard = h('section.card.projv__card', { 'aria-label': 'Graph-Ausschnitt' },
    h('div.card__head', null,
      h('h3', null, text('Umgebung im Gehirn')),
      h('span.spacer'),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => self.projectId && self.ctx.navigate(`#/graph?focus=${encodeURIComponent(self.projectId)}`),
      }, text('Groß öffnen'))),
    h('div.card__body', null,
      h('div.projv__canvaswrap', null, dom.canvas),
      dom.graphNote));

  dom.main = h('section.projv__main', null,
    dom.head,
    dom.board,
    dom.boardNote,
    dom.taskDetail,
    dom.linksCard,
    dom.graphCard);

  dom.empty = h('div.empty', { hidden: true },
    h('h3', null, text('Noch kein Projekt')),
    h('p', null, text('Ein Projekt bündelt Aufgaben, Notizen und Chats zu einem Vorhaben – und zeigt, wie sie zusammenhängen.')),
    h('button.btn.btn--primary', { type: 'button', onClick: () => createProject(self) }, text('Erstes Projekt anlegen')));

  dom.root = h('div.projv', null, dom.side, h('div.projv__content', null, dom.main, dom.empty));
  container.appendChild(dom.root);

  self.saveSoon = debounce(() => {
    if (self.alive) saveProject(self);
  }, SAVE_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

function selectedProject(self) {
  if (!self.projectId) return null;
  return self.projects.find((project) => project.id === self.projectId) || null;
}

async function selectProject(self, id, opts = {}) {
  if (!opts.initial && self.projectId === id) return;
  // Anything typed but not yet written must land before the panel changes.
  if (self.saveState === 'dirty') await saveProject(self);
  if (!self.alive) return;

  self.projectId = id || null;
  self.selectedTaskId = null;
  self.tasks = [];
  self.neighbours = null;
  self.saveState = 'clean';
  self.saveError = null;

  renderProjectList(self);
  renderHeader(self);
  renderBoard(self);
  renderTaskDetail(self);
  renderLinks(self);

  if (!self.projectId) {
    renderGraph(self);
    return;
  }

  await Promise.all([loadTasks(self), loadNeighbours(self)]);
  if (!self.alive || self.projectId !== id) return;

  if (self.pendingTaskId) {
    const found = self.tasks.find((task) => task.id === self.pendingTaskId);
    if (found) self.selectedTaskId = found.id;
    self.pendingTaskId = null;
  }

  renderBoard(self);
  renderTaskDetail(self);
  renderLinks(self);
  renderGraph(self);
}

/* ------------------------------------------------------------------ */
/* Project list and header                                             */
/* ------------------------------------------------------------------ */

function renderProjectList(self) {
  const box = self.dom.projectList;
  clear(box);

  if (self.projectsError) {
    box.appendChild(h('li.projv__listnote.is-danger', null,
      text(`Projekte konnten nicht geladen werden: ${errorMessage(self.projectsError)}`)));
    return;
  }
  if (self.loading && !self.projects.length) {
    box.appendChild(h('li.projv__listnote.meta', null, text('Projekte werden geladen …')));
    return;
  }

  const needle = String(self.dom.filter.value || '').trim().toLowerCase();
  const rows = self.projects.filter((project) => {
    if (!needle) return true;
    const data = dataOf(project);
    return `${data.name || ''} ${data.description || ''}`.toLowerCase().includes(needle);
  });

  if (!rows.length) {
    box.appendChild(h('li.projv__listnote.meta', null,
      text(needle ? 'Kein Projekt passt zu diesem Filter.' : 'Noch kein Projekt angelegt.')));
  }

  for (const project of rows) {
    const data = dataOf(project);
    const mine = project.id === self.projectId ? self.tasks : null;
    const openCount = mine ? mine.filter((task) => dataOf(task).status !== 'done').length : null;
    const row = h('li.projv__row', null,
      h('button.projv__row-main', {
        type: 'button',
        onClick: () => selectProject(self, project.id),
      },
      h('span.projv__row-title', null, text(String(data.name || 'Ohne Namen'))),
      h('span.projv__row-meta', null,
        h('span.badge', { dataset: { state: data.status || 'active' } },
          text((PROJECT_STATES.find((s) => s.value === data.status) || PROJECT_STATES[0]).label)),
        openCount === null
          ? null
          : h('span.meta', null, text(openCount ? `${formatNumber(openCount)} offen` : 'alles erledigt')),
        h('span.meta', null, text(project.updatedAt ? timeAgo(project.updatedAt) : '')))));
    row.classList.toggle('is-active', project.id === self.projectId);
    box.appendChild(row);
  }
}

function renderHeader(self) {
  const { dom } = self;
  const project = selectedProject(self);
  dom.main.hidden = !project;
  dom.empty.hidden = !!project;
  if (!project) return;

  const data = dataOf(project);
  setValue(dom.nameInput, data.name || '');
  setValue(dom.description, data.description || '');
  setValue(dom.tagsInput, Array.isArray(data.tags) ? data.tags.join(', ') : '');
  dom.statusSelect.value = PROJECT_STATES.some((s) => s.value === data.status) ? data.status : 'active';

  renderSaveState(self);
}

function setValue(node, value) {
  const next = value === null || value === undefined ? '' : String(value);
  if (node.value !== next) node.value = next;
}

function renderSaveState(self) {
  const box = self.dom.saveState;
  clear(box);
  if (self.saveState === 'saving') box.appendChild(text('speichert …'));
  else if (self.saveState === 'dirty') box.appendChild(text('ungespeichert'));
  else if (self.saveState === 'error') {
    box.appendChild(text(`nicht gespeichert: ${self.saveError || 'unbekannter Fehler'}`));
    box.classList.add('is-danger');
    return;
  } else box.appendChild(text('gespeichert'));
  box.classList.remove('is-danger');
}

function markDirty(self) {
  self.saveState = 'dirty';
  renderSaveState(self);
  self.saveSoon();
}

function flushSave(self) {
  if (self.saveState !== 'dirty') return;
  self.saveSoon.cancel();
  saveProject(self);
}

async function saveProject(self) {
  const project = selectedProject(self);
  if (!project) return;
  const { dom } = self;
  const patch = {
    name: String(dom.nameInput.value || '').trim() || 'Ohne Namen',
    description: String(dom.description.value || ''),
    tags: parseTags(dom.tagsInput.value),
    status: dom.statusSelect.value,
  };

  const token = ++self.saveSeq;
  self.saveState = 'saving';
  renderSaveState(self);
  try {
    const result = await request(self, (signal) => self.api.patch(
      `/records/${encodeURIComponent(project.id)}`,
      { data: patch },
      { signal },
    ));
    if (!self.alive || token !== self.saveSeq) return;
    const record = recordOf(result);
    if (record) {
      const index = self.projects.findIndex((p) => p.id === record.id);
      if (index !== -1) self.projects[index] = record;
    }
    self.saveState = 'clean';
    self.saveError = null;
    renderProjectList(self);
  } catch (err) {
    if (!self.alive || token !== self.saveSeq || (err && err.isAborted)) return;
    self.saveState = 'error';
    self.saveError = errorMessage(err);
  } finally {
    if (self.alive && token === self.saveSeq) renderSaveState(self);
  }
}

async function createProject(self) {
  try {
    const result = await request(self, (signal) => self.api.post('/records', {
      type: 'project',
      data: { name: 'Neues Projekt', description: '', status: 'active', tags: [] },
    }, { signal }));
    if (!self.alive) return;
    const record = recordOf(result);
    if (!record) throw new Error('Der Server hat kein Projekt zurückgegeben.');
    self.projects = [record, ...self.projects];
    await selectProject(self, record.id);
    if (!self.alive) return;
    self.dom.nameInput.focus();
    self.dom.nameInput.select();
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Projekt konnte nicht angelegt werden: ${errorMessage(err)}`, 'error');
  }
}

async function deleteProject(self) {
  const project = selectedProject(self);
  if (!project) return;
  const open = self.tasks.length;
  const ok = await self.ctx.confirm({
    title: 'Projekt löschen?',
    message: open
      ? `„${dataOf(project).name || project.id}“ wird gelöscht. Die ${formatNumber(open)} zugehörigen Aufgaben bleiben erhalten, verlieren aber ihre Zuordnung.`
      : `„${dataOf(project).name || project.id}“ wird gelöscht. Gelöschte Einträge lassen sich über eine Sicherung zurückholen.`,
    confirmLabel: 'Löschen',
    danger: true,
  });
  if (!ok || !self.alive) return;
  try {
    await request(self, (signal) => self.api.del(`/records/${encodeURIComponent(project.id)}`, { signal }));
    if (!self.alive) return;
    self.projects = self.projects.filter((p) => p.id !== project.id);
    await selectProject(self, self.projects.length ? self.projects[0].id : null, { initial: true });
    if (self.alive) self.ctx.toast('Projekt gelöscht.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Löschen fehlgeschlagen: ${errorMessage(err)}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

function renderBoard(self) {
  const box = self.dom.board;
  clear(box);
  if (!self.projectId) return;

  if (self.tasksError) {
    box.appendChild(h('p.is-danger', null, text(`Aufgaben konnten nicht geladen werden: ${errorMessage(self.tasksError)}`)));
    return;
  }

  for (const column of COLUMNS) {
    const tasks = self.tasks
      .filter((task) => (dataOf(task).status || 'todo') === column.status)
      .sort((a, b) => (dataOf(a).priority || 2) - (dataOf(b).priority || 2));

    const listNode = h('div.projv__cards', { role: 'list' });
    for (const task of tasks) listNode.appendChild(renderCard(self, task));
    if (!tasks.length) {
      listNode.appendChild(h('p.projv__emptycol.meta', null, text('Nichts hier.')));
    }

    const input = h('input.input.projv__add', {
      type: 'text',
      placeholder: 'Aufgabe hinzufügen …',
      'aria-label': `Aufgabe in „${column.label}“ hinzufügen`,
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          createTask(self, column.status, input);
        }
      },
    });

    // Drag and drop: the column is the drop target, the card carries the id.
    // The handlers live on the node itself, so they are collected with it on
    // the next render rather than piling up in the view's cleanup list.
    let columnNode;
    columnNode = h('section.projv__column', {
      'aria-label': column.label,
      onDragOver: (event) => {
        if (!self.dragTaskId) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        columnNode.classList.add('is-dropping');
      },
      onDragLeave: (event) => {
        if (event.target === columnNode || !columnNode.contains(event.relatedTarget)) {
          columnNode.classList.remove('is-dropping');
        }
      },
      onDrop: (event) => {
        event.preventDefault();
        columnNode.classList.remove('is-dropping');
        const id = self.dragTaskId || (event.dataTransfer ? event.dataTransfer.getData('text/plain') : '');
        self.dragTaskId = null;
        if (id) moveTask(self, id, column.status);
      },
    },
    h('header.projv__column-head', null,
      h('h3.projv__column-title', null, text(column.label)),
      h('span.badge', null, text(formatNumber(tasks.length)))),
    listNode,
    input);
    columnNode.dataset.status = column.status;

    box.appendChild(columnNode);
  }

  clear(self.dom.boardNote);
  const parts = [`${formatNumber(self.tasks.length)} Aufgabe(n) in diesem Projekt.`];
  if (self.tasksTruncated) {
    parts.push(`Es wurden die ${formatNumber(TASK_PAGE)} zuletzt geänderten Aufgaben aller Projekte gelesen; bei insgesamt ${formatNumber(self.taskTotal)} Aufgaben können ältere hier fehlen.`);
  }
  parts.push('Karten lassen sich ziehen oder mit den Pfeiltasten ← → verschieben.');
  self.dom.boardNote.appendChild(text(parts.join(' ')));
}

function renderCard(self, task) {
  const data = dataOf(task);
  const due = dueState(data.due);
  const card = h('article.projv__card', {
    role: 'listitem',
    tabindex: '0',
    draggable: 'true',
    'aria-label': `Aufgabe ${data.title || task.id}`,
    onClick: () => {
      self.selectedTaskId = self.selectedTaskId === task.id ? null : task.id;
      renderTaskDetail(self);
      renderBoard(self);
    },
    onKeyDown: (event) => onCardKey(self, event, task),
    onDragStart: (event) => {
      self.dragTaskId = task.id;
      card.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', task.id); } catch { /* some browsers restrict this */ }
      }
    },
    onDragEnd: () => {
      self.dragTaskId = null;
      card.classList.remove('is-dragging');
    },
  },
  h('span.projv__card-title', null, text(String(data.title || 'Ohne Titel'))),
  h('span.projv__card-meta', null,
    data.priority === 1 ? h('span.badge.badge--danger', null, text('Hoch')) : null,
    data.due ? h('span.badge.projv__due', { dataset: { due: due || 'later' } }, text(formatDate(data.due))) : null,
    data.body ? h('span.meta', null, text('Notiz')) : null));

  card.dataset.id = task.id;
  if (task.id === self.selectedTaskId) card.classList.add('is-selected');
  return card;
}

function onCardKey(self, event, task) {
  const current = STATUS_INDEX.get(dataOf(task).status || 'todo') ?? 0;
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    const next = COLUMNS[Math.min(COLUMNS.length - 1, current + 1)];
    if (next) moveTask(self, task.id, next.status, { keepFocus: true });
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    const next = COLUMNS[Math.max(0, current - 1)];
    if (next) moveTask(self, task.id, next.status, { keepFocus: true });
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    self.selectedTaskId = task.id;
    renderTaskDetail(self);
    renderBoard(self);
  } else if (event.key === 'Delete') {
    event.preventDefault();
    deleteTask(self, task.id);
  }
}

async function createTask(self, status, input) {
  const title = String(input.value || '').trim();
  if (!title || !self.projectId) return;
  input.value = '';
  try {
    const result = await request(self, (signal) => self.api.post('/records', {
      type: 'task',
      data: { title, status, projectId: self.projectId, priority: 2 },
    }, { signal }));
    if (!self.alive) return;
    const record = recordOf(result);
    if (record) self.tasks = [record, ...self.tasks];
    renderBoard(self);
    renderProjectList(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    input.value = title; // give the text back rather than losing it
    self.ctx.toast(`Aufgabe konnte nicht angelegt werden: ${errorMessage(err)}`, 'error');
  }
}

/**
 * The card has already moved under the user's hand, so the board moves with
 * it -- and moves back, with the reason, if the server does not agree.
 */
async function moveTask(self, taskId, status, opts = {}) {
  const index = self.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) return;
  const task = self.tasks[index];
  const previous = dataOf(task).status || 'todo';
  if (previous === status) return;

  self.tasks[index] = { ...task, data: { ...dataOf(task), status } };
  renderBoard(self);
  renderTaskDetail(self);
  if (opts.keepFocus) focusCard(self, taskId);

  try {
    const result = await request(self, (signal) => self.api.patch(
      `/records/${encodeURIComponent(taskId)}`,
      { data: { status } },
      { signal },
    ));
    if (!self.alive) return;
    const record = recordOf(result);
    if (record) {
      const at = self.tasks.findIndex((entry) => entry.id === record.id);
      if (at !== -1) self.tasks[at] = record;
    }
    renderProjectList(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    const at = self.tasks.findIndex((entry) => entry.id === taskId);
    if (at !== -1) self.tasks[at] = { ...self.tasks[at], data: { ...dataOf(self.tasks[at]), status: previous } };
    self.ctx.toast(`Verschieben fehlgeschlagen: ${errorMessage(err)}`, 'error');
  } finally {
    if (self.alive) {
      renderBoard(self);
      renderTaskDetail(self);
      if (opts.keepFocus) focusCard(self, taskId);
    }
  }
}

function focusCard(self, taskId) {
  const card = self.dom.board.querySelector(`.projv__card[data-id="${cssEscape(taskId)}"]`);
  if (card) card.focus({ preventScroll: false });
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

async function deleteTask(self, taskId) {
  const task = self.tasks.find((entry) => entry.id === taskId);
  if (!task) return;
  const ok = await self.ctx.confirm({
    title: 'Aufgabe löschen?',
    message: `„${dataOf(task).title || taskId}“ wird gelöscht.`,
    confirmLabel: 'Löschen',
    danger: true,
  });
  if (!ok || !self.alive) return;
  try {
    await request(self, (signal) => self.api.del(`/records/${encodeURIComponent(taskId)}`, { signal }));
    if (!self.alive) return;
    self.tasks = self.tasks.filter((entry) => entry.id !== taskId);
    if (self.selectedTaskId === taskId) self.selectedTaskId = null;
    renderBoard(self);
    renderTaskDetail(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Löschen fehlgeschlagen: ${errorMessage(err)}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Task detail                                                         */
/* ------------------------------------------------------------------ */

function renderTaskDetail(self) {
  const box = self.dom.taskDetail;
  clear(box);
  const task = self.tasks.find((entry) => entry.id === self.selectedTaskId) || null;
  box.hidden = !task;
  if (!task) return;

  const data = dataOf(task);
  const title = h('input.input', { type: 'text', value: String(data.title || ''), 'aria-label': 'Titel der Aufgabe' });
  const body = h('textarea.textarea', { rows: 3, 'aria-label': 'Notiz zur Aufgabe' });
  body.value = String(data.body || '');
  const status = h('select.select', { 'aria-label': 'Status' },
    ...COLUMNS.map((column) => h('option', { value: column.status }, text(column.label))));
  status.value = data.status || 'todo';
  const priority = h('select.select', { 'aria-label': 'Priorität' },
    ...PRIORITIES.map((entry) => h('option', { value: String(entry.value) }, text(entry.label))));
  priority.value = String(data.priority || 2);
  const due = h('input.input', { type: 'date', 'aria-label': 'Fällig am' });
  due.value = data.due ? String(data.due).slice(0, 10) : '';

  const state = h('span.meta', { role: 'status' });

  const save = async () => {
    const patch = {
      title: String(title.value || '').trim() || 'Ohne Titel',
      body: String(body.value || ''),
      status: status.value,
      priority: Number.parseInt(priority.value, 10) || 2,
      due: due.value ? new Date(`${due.value}T00:00:00`).toISOString() : null,
    };
    clear(state);
    state.appendChild(text('speichert …'));
    try {
      const result = await request(self, (signal) => self.api.patch(
        `/records/${encodeURIComponent(task.id)}`,
        { data: patch },
        { signal },
      ));
      if (!self.alive) return;
      const record = recordOf(result);
      if (record) {
        const at = self.tasks.findIndex((entry) => entry.id === record.id);
        if (at !== -1) self.tasks[at] = record;
      }
      clear(state);
      state.appendChild(text('gespeichert'));
      renderBoard(self);
    } catch (err) {
      if (!self.alive || (err && err.isAborted)) return;
      clear(state);
      state.appendChild(text(`nicht gespeichert: ${errorMessage(err)}`));
      state.classList.add('is-danger');
    }
  };

  box.appendChild(h('div.card__head', null,
    h('h3', null, text('Aufgabe')),
    h('span.spacer'),
    state,
    h('button.btn.btn--small', {
      type: 'button',
      onClick: () => {
        self.selectedTaskId = null;
        renderTaskDetail(self);
        renderBoard(self);
      },
    }, text('Schließen'))));

  box.appendChild(h('div.card__body.stack', null,
    h('label.field', null, h('span.label', null, text('Titel')), title),
    h('label.field', null, h('span.label', null, text('Notiz')), body),
    h('div.projv__detailgrid', null,
      h('label.field', null, h('span.label', null, text('Status')), status),
      h('label.field', null, h('span.label', null, text('Priorität')), priority),
      h('label.field', null, h('span.label', null, text('Fällig am')), due)),
    h('div.row', null,
      h('button.btn.btn--primary.btn--small', { type: 'button', onClick: save }, text('Speichern')),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => self.ctx.navigate(`#/graph?focus=${encodeURIComponent(task.id)}`),
      }, icon(ICONS.graph), text('Im Gehirn zeigen')),
      h('span.spacer'),
      h('button.btn.btn--small', { type: 'button', onClick: () => deleteTask(self, task.id) },
        icon(ICONS.trash), text('Löschen')))));
}

/* ------------------------------------------------------------------ */
/* Linked records                                                      */
/* ------------------------------------------------------------------ */

function renderLinks(self) {
  const { dom } = self;
  clear(dom.noteList);
  clear(dom.chatList);
  clear(dom.linkNote);

  if (!self.projectId) return;

  if (self.neighbourError) {
    dom.linkNote.appendChild(text(`Die Umgebung konnte nicht geladen werden: ${errorMessage(self.neighbourError)}`));
    return;
  }

  const nodes = (self.neighbours && self.neighbours.nodes) || [];
  const notes = nodes.filter((node) => node.type === 'note' && node.id !== self.projectId);
  const chats = nodes.filter((node) => node.type === 'chat' && node.id !== self.projectId);

  fillLinkList(self, dom.noteList, notes, 'note', 'Keine Notiz ist mit diesem Projekt verknüpft.');
  fillLinkList(self, dom.chatList, chats, 'chat', 'Kein Chat ist mit diesem Projekt verknüpft.');

  dom.linkNote.appendChild(text(
    'Verknüpfungen entstehen durch [[Wiki-Links]] und #Schlagworte in Notizen, durch die Zuordnung von Aufgaben – oder von Hand im Gehirn.',
  ));
}

function fillLinkList(self, box, nodes, type, emptyText) {
  if (!nodes.length) {
    box.appendChild(h('li.meta', null, text(emptyText)));
    return;
  }
  for (const node of nodes.slice(0, 30)) {
    box.appendChild(h('li.projv__link', null,
      h('button.projv__link-main', {
        type: 'button',
        onClick: () => self.ctx.navigate(type === 'note'
          ? `#/notes?id=${encodeURIComponent(node.id)}`
          : `#/chat?id=${encodeURIComponent(node.id)}`),
      },
      h('span.projv__link-icon', { 'aria-hidden': 'true' }, icon(type === 'note' ? ICONS.note : ICONS.chat)),
      h('span.projv__link-label', null, text(String(node.label || node.id))),
      node.updatedAt ? h('span.meta', null, text(timeAgo(node.updatedAt))) : null)));
  }
}

/* ------------------------------------------------------------------ */
/* Embedded graph                                                      */
/* ------------------------------------------------------------------ */

function renderGraph(self) {
  const { dom } = self;
  clear(dom.graphNote);

  if (!self.projectId) {
    if (self.graph) self.graph.setData({ nodes: [], edges: [] });
    return;
  }

  if (!self.neighbours) {
    dom.graphNote.appendChild(text(self.neighbourError
      ? 'Der Ausschnitt ist nicht verfügbar.'
      : 'Der Ausschnitt wird geladen …'));
    return;
  }

  if (!self.graph) {
    try {
      self.graph = createGraphCanvas(dom.canvas, {
        onDoubleClick: (node) => {
          if (node && node.id) self.ctx.navigate(`#/graph?focus=${encodeURIComponent(node.id)}`);
        },
      });
    } catch (err) {
      dom.graphNote.appendChild(text(`Der Graph-Ausschnitt lässt sich nicht zeichnen: ${errorMessage(err)}`));
      return;
    }
  }

  const { nodes, edges } = self.neighbours;
  self.graph.setData({ nodes, edges });
  self.graph.setSelection(self.projectId);
  self.graph.fitToView({ animate: false });

  dom.graphNote.appendChild(text(nodes.length > 1
    ? `${formatNumber(nodes.length)} Knoten und ${formatNumber(edges.length)} Verknüpfung(en) rund um dieses Projekt. Doppelklick öffnet einen Knoten im großen Graphen.`
    : 'Dieses Projekt hat noch keine Nachbarn im Graphen. Verknüpfungen entstehen, sobald Notizen darauf verweisen oder Aufgaben zugeordnet sind.'));
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
.projv {
  display: grid;
  grid-template-columns: minmax(200px, 270px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.projv__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}
.projv__side-head { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2); }
.projv__list { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 0 var(--sp-1) var(--sp-2); list-style: none; }
.projv__listnote { padding: var(--sp-1); }
.projv__row { border-radius: var(--r-2); }
.projv__row:hover { background: var(--surface-3); }
.projv__row.is-active { background: var(--accent-soft); }
.projv__row-main {
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
.projv__row-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.projv__row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.projv__row-meta .badge[data-state="archived"], .projv__row-meta .badge[data-state="done"] { opacity: 0.7; }

.projv__content { min-width: 0; min-height: 0; overflow-y: auto; }
.projv__main { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--sp-3) var(--sp-8); }
.projv__head { display: flex; flex-direction: column; gap: var(--sp-1); }
.projv__head-row { display: flex; align-items: center; gap: var(--sp-1); }
.projv__name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xl);
  font-weight: 600;
  background: none;
  border: 0;
  color: inherit;
  padding: 2px 0;
}
.projv__name:focus { outline: none; border-bottom: 2px solid var(--accent); }
.projv__status { width: auto; }
.projv__description { min-height: 54px; }
.projv__savestate { white-space: nowrap; }

.projv__board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-1); }
.projv__column {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-height: 160px;
  padding: var(--sp-1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.projv__column.is-dropping { border-color: var(--accent); background: var(--accent-soft); }
.projv__column-head { display: flex; align-items: center; gap: var(--sp-1); }
.projv__column-title { font-size: var(--fs-base); margin: 0; }
.projv__cards { display: flex; flex-direction: column; gap: 6px; min-height: 40px; }
.projv__emptycol { margin: 0; padding: var(--sp-1); }
.projv__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--sp-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  cursor: grab;
}
.projv__card:hover { border-color: var(--border-strong); }
.projv__card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.projv__card.is-selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.projv__card.is-dragging { opacity: 0.5; }
.projv__card-title { font-weight: 500; }
.projv__card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.projv__due[data-due="overdue"] { color: var(--danger); background: var(--danger-soft); }
.projv__due[data-due="soon"] { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.projv__add { font-size: var(--fs-sm); }
.projv__boardnote { margin: 0; }

.projv__detailgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-2); }

.projv__linkgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--sp-2); }
.projv__linktitle { margin: 0 0 var(--sp-05); font-size: var(--fs-sm); color: var(--fg-muted); }
.projv__links { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.projv__link-main {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px var(--sp-05);
  text-align: left;
  background: none;
  border: 0;
  border-radius: var(--r-1);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.projv__link-main:hover { background: var(--surface-3); }
.projv__link-icon { color: var(--fg-subtle); display: inline-flex; }
.projv__link-icon svg { width: 16px; height: 16px; }
.projv__link-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.projv__canvaswrap { position: relative; height: 260px; border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; background: var(--surface-2); }
.projv__canvas { display: block; width: 100%; height: 100%; }
.projv__graphnote { margin: var(--sp-1) 0 0; }

@media (max-width: 1020px) {
  .projv__board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 820px) {
  .projv { grid-template-columns: 1fr; }
  .projv__side { border-right: 0; border-bottom: 1px solid var(--border); max-height: 38vh; }
  .projv__main { padding: var(--sp-2) var(--sp-2) var(--sp-6); }
  .projv__board { grid-template-columns: 1fr; }
}
`;
