/**
 * views/workshop.js -- the window the user pastes code into.
 *
 * This screen exists for one sentence the user said: they want to change the
 * application without starting over every time something goes wrong. So the
 * design question is never "how do we run pasted code" -- the sandbox answers
 * that -- but "what does this screen look like when the code is wrong?",
 * because wrong is the normal case here, not the exception.
 *
 * What follows from that:
 *
 * 1. **Checking is free, running is not.** "Prüfen" installs nothing and
 *    "Installieren" stores the module switched OFF. Pasting code and running
 *    it are two separate acts, and only the second one shows a dialog.
 * 2. **A refusal is a report, not a sentence.** Every problem the server found
 *    is listed with its line number, and clicking one marks that line in the
 *    editor. A failed install renders the same panel as a check, because the
 *    server hands the whole report back in `details.validation`.
 * 3. **The history is the answer to the actual worry.** "Verlauf" lists every
 *    version with its date and note and offers "Zurück zu dieser Fassung" on
 *    each row. Rolling back is itself reversible -- the registry appends the
 *    current version before restoring the old one -- so there is no step on
 *    this screen the user cannot walk back out of.
 * 4. **The off switch is never behind a dialog.** Enabling asks and explains;
 *    disabling just happens. Making the safe direction cheap and the risky one
 *    expensive is the whole shape of this view.
 * 5. **The security note is honest.** The isolation protects against MISTAKES,
 *    not against ATTACKS. What actually protects the user is the permission
 *    list they approve, the network gate, the log and the fact that everything
 *    is reversible. The note says exactly that, calmly, once.
 *
 * Defensive detail worth knowing: `GET /api/modules` is read through
 * `normaliseModule`, which accepts both a flat module summary and a wrapped
 * `{id, data:{…}}` record. The two halves of the server disagree about that
 * shape today (see the report handed to the integrator), and a view that
 * renders nothing because of a wrapper level would be the worst possible way
 * for the user to learn about it.
 */

import {
  h, text, clear, icon, on, list, timeAgo, formatDateTime, formatBytes, debounce,
} from '../lib/dom.js';
import { createEditor } from '../lib/editor.js';

const STYLE_ID = 'nos-workshop-view-style';

const VIEW_ICON = '<path d="M7.6 3.2 3.2 7.6l3 3 4.4-4.4z"/><path d="m10.6 6.2 6.2 6.2-2.4 2.4-6.2-6.2"/><path d="M4.4 16.4h3"/>';

const ICONS = {
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  alert: '<path d="M10 3.4 2.8 16.2h14.4z"/><path d="M10 8v3.4M10 13.7v.1"/>',
  play: '<path d="M6.4 4.2 15.4 10l-9 5.8z"/>',
  stop: '<rect x="5" y="5" width="10" height="10" rx="2"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  download: '<path d="M10 3.2v9M6.4 8.6 10 12.2l3.6-3.6"/><path d="M3.8 14.2v1.4a1.2 1.2 0 0 0 1.2 1.2h10a1.2 1.2 0 0 0 1.2-1.2v-1.4"/>',
  history: '<path d="M3.6 10a6.4 6.4 0 1 0 2-4.6"/><path d="M3.3 3.2v3.6h3.6"/><path d="M10 6.4V10l2.6 1.6"/>',
  template: '<rect x="3.2" y="3.4" width="13.6" height="13.2" rx="2"/><path d="M3.2 7.6h13.6M7.8 7.6v9"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  save: '<path d="M4.2 4.2h8.4l3.2 3.2v8.4a.8.8 0 0 1-.8.8H4.2a.8.8 0 0 1-.8-.8V5a.8.8 0 0 1 .8-.8z"/><path d="M6.6 4.2v4h5.4v-4M6.6 16.6v-4.4h6.8v4.4"/>',
  book: '<path d="M4 4.4h4.2c1 0 1.8.8 1.8 1.8v9.4a1.4 1.4 0 0 0-1.4-1.4H4z"/><path d="M16 4.4h-4.2c-1 0-1.8.8-1.8 1.8v9.4a1.4 1.4 0 0 1 1.4-1.4H16z"/>',
};

/** How loudly the interface has to talk about a permission set. */
const RISK = {
  low: { label: 'gering', tone: 'low' },
  medium: { label: 'mittel', tone: 'medium' },
  high: { label: 'hoch', tone: 'high' },
};

/**
 * What can actually go wrong, per high-risk permission. Spelled out in the
 * enable dialog rather than left to the user's imagination -- "hohes Risiko"
 * on its own is a colour, not an explanation. Permissions not listed here fall
 * back to the catalogue text from the server; nothing is invented.
 */
const CONSEQUENCE = {
  'records.write': 'Ein Fehler im Modul kann Notizen, Projekte oder Aufgaben überschreiben. '
    + 'Gelöschtes lässt sich zurückholen, falsch Überschriebenes nur aus einer Sicherung.',
  'routes.add': 'Die neuen Adressen sind für jedes Gerät erreichbar, das die Oberfläche erreicht. '
    + 'Ist die Netzfreigabe an, gilt das auch für andere Geräte in deinem Netz.',
  'files.read': 'Das Modul liest Dateien in den freigegebenen Ordnern. Was es mit ihrem Inhalt tut, '
    + 'entscheidet allein sein Code.',
  'files.write': 'Überschriebene Dateien sind weg. Neural OS sichert Dateien ausserhalb seines '
    + 'eigenen Verzeichnisses nicht.',
  'net.lan': 'Das Modul kann Geräte in deinem Netz erreichen und ihnen Daten schicken. '
    + 'Die Schleuse protokolliert jeden Versuch.',
  'net.online': 'Alles, was das Modul sendet, verlässt dein Gerät. Die Schleuse hält es fest und '
    + 'protokolliert es – verhindern kann sie es dann nicht mehr.',
};

const TABS = [
  { id: 'report', label: 'Prüfbericht' },
  { id: 'log', label: 'Protokoll' },
  { id: 'history', label: 'Verlauf' },
];

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Starting points that really run.
 *
 * Two constraints the server puts on this text, both easy to break by accident:
 * the kind is sniffed from whether any LINE starts with `export`, and the
 * server's line-preserving ES-module rewrite only understands
 * `export const x = …` and `export default …` at the start of a line. So a
 * server template must contain no such line at all, and an interface template
 * must use exactly those two forms.
 */
const TEMPLATES = [
  {
    id: 'view',
    label: 'Neue Ansicht',
    hint: 'Eine eigene Seite in der Seitenleiste (läuft im Browser).',
    source: [
      "export const manifest = {",
      "  name: 'Meine Ansicht',",
      "  description: 'Eine eigene Seite, die in der Seitenleiste auftaucht.',",
      "  kind: 'ui',",
      "  capabilities: ['ui.view', 'ui.api'],",
      "};",
      "",
      "// ctx ist derselbe Werkzeugkasten, den die eingebauten Ansichten bekommen:",
      "// h, text, clear, icon, api, toast, navigate, bus, confirm.",
      "export default {",
      "  id: 'meine-ansicht',",
      "  title: 'Meine Ansicht',",
      "  icon: '<circle cx=\"10\" cy=\"10\" r=\"6.5\"/><path d=\"M10 6.5v7M6.5 10h7\"/>',",
      "",
      "  async mount(container, ctx) {",
      "    const { h, text, clear } = ctx;",
      "    clear(container);",
      "",
      "    const ausgabe = h('p', null, text('Wird geladen …'));",
      "",
      "    container.appendChild(",
      "      h('div.page', null,",
      "        h('header.page__head', null,",
      "          h('h2.page__title', null, text('Meine Ansicht'))),",
      "        h('section.card', null,",
      "          h('div.card__body', null, ausgabe))),",
      "    );",
      "",
      "    // ui.api: dieselben Adressen, die auch die App selbst benutzt.",
      "    try {",
      "      const status = await ctx.api.get('/status');",
      "      clear(ausgabe);",
      "      ausgabe.appendChild(text('Neural OS läuft, Fassung ' + (status.version || '?') + '.'));",
      "    } catch (fehler) {",
      "      clear(ausgabe);",
      "      ausgabe.appendChild(text('Konnte den Status nicht laden: ' + fehler.message));",
      "    }",
      "  },",
      "",
      "  async unmount() {",
      "    // Hier Listener abmelden, Timer stoppen, offene Anfragen abbrechen.",
      "  },",
      "};",
      "",
    ].join('\n'),
  },
  {
    id: 'tool',
    label: 'Neues Werkzeug',
    hint: 'Ein Werkzeug, das Agenten benutzen können (läuft im Server).',
    source: [
      "module.exports = {",
      "  manifest: {",
      "    name: 'Notizen zählen',",
      "    description: 'Gibt Agenten ein Werkzeug, das die Notizen zählt.',",
      "    kind: 'server',",
      "    capabilities: ['records.read', 'tools.add'],",
      "  },",
      "",
      "  // setup() läuft beim Aktivieren. Was es zurückgibt, wird beim",
      "  // Deaktivieren aufgerufen – dort alles wieder abräumen.",
      "  setup(api) {",
      "    api.tool({",
      "      // Nur Kleinbuchstaben und Ziffern, in der Form bereich.name.",
      "      name: 'notizen.zaehlen',",
      "      description: 'Zählt die vorhandenen Notizen.',",
      "      parameters: {",
      "        type: 'object',",
      "        properties: {},",
      "      },",
      "      run(args, ctx) {",
      "        // api.records.list(typ) liefert eine Liste von Einträgen.",
      "        const notizen = api.records.list('note');",
      "        return { anzahl: notizen.length };",
      "      },",
      "    });",
      "",
      "    api.log('Werkzeug \"notizen.zaehlen\" ist angemeldet.');",
      "",
      "    return function abmelden() {",
      "      api.log('Werkzeug wird abgemeldet.');",
      "    };",
      "  },",
      "};",
      "",
    ].join('\n'),
  },
  {
    id: 'route',
    label: 'Neue Adresse',
    hint: 'Eine eigene Adresse unter /api/x/ … (läuft im Server).',
    source: [
      "module.exports = {",
      "  manifest: {",
      "    name: 'Eigene Adresse',",
      "    description: 'Beantwortet GET /api/x/hallo.',",
      "    kind: 'server',",
      "    capabilities: ['routes.add'],",
      "  },",
      "",
      "  setup(api) {",
      "    // Der Pfad MUSS mit /api/x/ beginnen: Module bekommen einen eigenen",
      "    // Adressbereich, damit sie keine bestehende Adresse überschreiben.",
      "    api.route('GET', '/api/x/hallo', (anfrage) => {",
      "      // anfrage hat: method, path, params, query, body.",
      "      return {",
      "        hallo: anfrage.query.name || 'Welt',",
      "        modul: api.name,",
      "        zeit: new Date().toISOString(),",
      "      };",
      "    });",
      "",
      "    return function abmelden() {};",
      "  },",
      "};",
      "",
    ].join('\n'),
  },
  {
    id: 'events',
    label: 'Auf Ereignisse reagieren',
    hint: 'Hört mit, wenn sich etwas ändert (läuft im Server).',
    source: [
      "module.exports = {",
      "  manifest: {",
      "    name: 'Auf Ereignisse reagieren',",
      "    description: 'Schreibt ins Protokoll, sobald ein Eintrag angelegt wird.',",
      "    kind: 'server',",
      "    capabilities: ['bus.listen'],",
      "  },",
      "",
      "  setup(api) {",
      "    let anzahl = 0;",
      "",
      "    // Ein Ereignis kommt als { seq, at, name, payload }.",
      "    const ab = api.on('record.created', (ereignis) => {",
      "      anzahl += 1;",
      "      const typ = ereignis.payload ? ereignis.payload.type : 'unbekannt';",
      "      api.log('Eintrag Nr. ' + anzahl + ' vom Typ ' + typ + ' angelegt.');",
      "    });",
      "",
      "    // Weitere Namen: record.updated, record.deleted, chat.message,",
      "    // agent.run.finished, network.attempt.",
      "    return function abmelden() {",
      "      ab();",
      "    };",
      "  },",
      "};",
      "",
    ].join('\n'),
  },
];

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'workshop',
  title: 'Werkstatt',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyle();
    teardown();

    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      container,
      cleanups: [],
      requests: new Set(),
      timers: new Set(),
      dialogs: new Set(),
      dom: {},
      editor: null,

      modules: [],
      listError: null,
      listLoading: true,
      status: null,

      catalogue: null,
      catalogueError: null,

      selectedId: null,
      detail: null,
      dirty: false,

      validation: null,
      validationError: null,
      logLines: [],
      tab: 'report',
      bottomBig: false,
      busy: null,
      menuOpen: false,
    };
    view = self;

    buildLayout(self);
    subscribe(self);

    await Promise.all([loadCatalogue(self), loadModules(self)]);
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
  for (const controller of self.requests) {
    try { controller.abort(); } catch { /* already done */ }
  }
  self.requests.clear();
  for (const timer of self.timers) clearTimeout(timer);
  self.timers.clear();
  for (const close of Array.from(self.dialogs)) {
    try { close(false); } catch { /* already gone */ }
  }
  self.dialogs.clear();
  for (const off of self.cleanups) {
    try { off(); } catch { /* listener already gone */ }
  }
  self.cleanups.length = 0;
  if (self.editor) {
    try { self.editor.destroy(); } catch { /* already gone */ }
    self.editor = null;
  }
}

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

function later(self, fn, ms) {
  const timer = setTimeout(() => {
    self.timers.delete(timer);
    if (self.alive) fn();
  }, ms);
  self.timers.add(timer);
  return timer;
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

/**
 * Accept both shapes a module can arrive in: the registry's flat summary and
 * a stored record wrapped in `{id, data}`. Reading one and refusing the other
 * would make this screen fail in a way the user cannot act on.
 */
function normaliseModule(raw, description) {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
  return {
    id: String(raw.id || data.id || ''),
    name: data.name || '(ohne Namen)',
    description: data.description || '',
    kind: data.kind === 'ui' ? 'ui' : 'server',
    version: Number.isFinite(data.version) ? data.version : 1,
    versions: versions.map((entry) => ({
      version: entry && Number.isFinite(entry.version) ? entry.version : null,
      at: (entry && entry.at) || null,
      note: (entry && entry.note) || '',
      bytes: entry && Number.isFinite(entry.bytes)
        ? entry.bytes
        : (entry && typeof entry.source === 'string' ? entry.source.length : null),
      source: entry && typeof entry.source === 'string' ? entry.source : null,
    })),
    capabilities: caps,
    enabled: data.enabled === true,
    loaded: raw.loaded === true || data.loaded === true,
    lastError: data.lastError || null,
    failures: Number(data.failures) || 0,
    builtin: data.builtin === true,
    author: data.author || '',
    fileRoots: Array.isArray(data.fileRoots) ? data.fileRoots : [],
    source: typeof data.source === 'string' ? data.source : null,
    updatedAt: raw.updatedAt || data.updatedAt || null,
    registered: raw.registered || null,
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    log: Array.isArray(raw.log) ? raw.log : [],
    risk: (description && description.risk) || raw.risk || null,
    permissionText: (description && description.text) || raw.description_permissions || raw.permissions || '',
  };
}

async function loadCatalogue(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/modules/capabilities', { signal }));
    if (!self.alive) return;
    self.catalogue = new Map((result && result.items ? result.items : []).map((entry) => [entry.id, entry]));
    self.catalogueError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    // Not fatal: without the catalogue the permission cards fall back to the
    // bare identifier, which is worse but still true.
    self.catalogue = null;
    self.catalogueError = err;
  }
}

async function loadModules(self) {
  self.listLoading = true;
  try {
    const result = await request(self, (signal) => self.api.get('/modules', { signal }));
    if (!self.alive) return;
    const items = Array.isArray(result && result.items) ? result.items : [];
    const descriptions = (result && result.descriptions) || {};
    self.modules = items
      .map((item) => normaliseModule(item, descriptions[item && item.id]))
      .filter(Boolean);
    self.status = (result && result.status) || null;
    self.listError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.modules = [];
    self.listError = err;
  } finally {
    self.listLoading = false;
  }
}

async function loadDetail(self, id) {
  try {
    const result = await request(self, (signal) => self.api.get(`/modules/${encodeURIComponent(id)}`, { signal }));
    if (!self.alive) return null;
    const record = (result && result.record) || result;
    return normaliseModule(record, result && result.description);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return null;
    self.ctx.toast(`Das Modul konnte nicht geladen werden: ${errorMessage(err)}`, 'error');
    return null;
  }
}

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;

  const refreshSoon = debounce(() => {
    if (!self.alive) return;
    loadModules(self).then(() => {
      if (!self.alive) return;
      renderList(self);
      renderBar(self);
      renderError(self);
      if (self.tab === 'history') renderPanel(self);
    });
  }, 250);
  self.cleanups.push(() => refreshSoon.cancel());

  for (const name of ['module.installed', 'module.updated', 'module.enabled', 'module.disabled', 'module.removed', 'module.safemode']) {
    self.cleanups.push(ctx.bus.on(name, () => refreshSoon()));
  }

  self.cleanups.push(ctx.bus.on('module.failed', (payload) => {
    if (!self.alive) return;
    pushLog(self, {
      at: new Date().toISOString(),
      level: 'error',
      text: `${(payload && payload.where) || 'Modul'}: ${(payload && payload.error && payload.error.message) || 'Fehler'}`,
      id: payload && payload.id,
    });
    refreshSoon();
  }));

  self.cleanups.push(ctx.bus.on('module.log', (payload) => {
    if (!self.alive || !payload) return;
    pushLog(self, {
      at: payload.at || new Date().toISOString(),
      level: payload.level || 'info',
      text: payload.text || '',
      id: payload.id,
      name: payload.name,
    });
  }));
}

function pushLog(self, entry) {
  self.logLines.push(entry);
  if (self.logLines.length > 400) self.logLines.splice(0, self.logLines.length - 400);
  if (self.tab === 'log') renderPanel(self);
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  /* ------------------------------- head ------------------------------- */

  dom.templateMenu = h('div.wsv__menu', { hidden: true, role: 'menu' });
  dom.templateButton = h('button.btn', {
    type: 'button',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    onClick: (event) => {
      event.stopPropagation();
      toggleMenu(self, !self.menuOpen);
    },
  }, icon(ICONS.template), text('Vorlagen'));

  const head = h('header.wsv__head', null,
    h('div.wsv__head-main', null,
      h('h2.wsv__title', null, text('Werkstatt')),
      h('p.wsv__sub', null, text(
        'Code einfügen, prüfen, einschalten – und jederzeit wieder ausschalten oder zurücknehmen.',
      ))),
    h('div.wsv__head-actions', null,
      h('div.wsv__menu-wrap', null, dom.templateButton, dom.templateMenu),
      h('button.btn', {
        type: 'button',
        onClick: () => startNew(self),
      }, icon(ICONS.plus), text('Neu')),
      h('button.btn.btn--ghost', {
        type: 'button',
        title: 'Liste neu laden',
        onClick: async () => {
          await loadModules(self);
          if (self.alive) renderAll(self);
        },
      }, icon(ICONS.refresh), text('Aktualisieren'))));

  buildTemplateMenu(self);

  /* ------------------------------- side ------------------------------- */

  dom.listNode = h('ul.wsv__list');
  dom.listState = h('div.wsv__list-state');
  dom.statusLine = h('p.wsv__status');

  const side = h('aside.wsv__side', null,
    h('div.wsv__side-head', null,
      h('span.wsv__side-title', null, text('Module')),
      dom.statusLine),
    h('div.wsv__side-body', null, dom.listState, dom.listNode),
    h('div.wsv__note', null,
      h('p.wsv__note-head', null, icon(ICONS.book), text('Bevor du etwas einfügst')),
      h('p', null, text(
        'Eingefügter Code läuft auf diesem Gerät. Füge nur ein, was du verstehst oder was von '
        + 'einer Quelle kommt, der du vertraust.',
      )),
      h('p', null, text(
        'Was ein Modul darf, steht vor dem Einschalten als Liste da. Alles lässt sich wieder '
        + 'ausschalten, und jede Fassung bleibt im Verlauf erhalten.',
      )),
      h('p.wsv__note-honest', null, text(
        'Die Abschottung schützt vor Fehlern, nicht vor Angriffen. Der Schutz kommt aus den '
        + 'Berechtigungen, der Netzschleuse, dem Protokoll – und daraus, dass du jeden Schritt '
        + 'zurücknehmen kannst.',
      ))));

  /* ------------------------------- main ------------------------------- */

  dom.barTitle = h('span.wsv__bar-title');
  dom.barBadges = h('span.wsv__bar-badges');
  dom.barActions = h('div.wsv__bar-actions');
  const bar = h('div.wsv__bar', null,
    h('div.wsv__bar-main', null, dom.barTitle, dom.barBadges),
    dom.barActions);

  dom.errorBand = h('div.wsv__errband', { hidden: true, role: 'alert' });

  dom.editorHost = h('div.wsv__editor');
  dom.welcome = h('div.wsv__welcome', { hidden: true });
  const editorWrap = h('div.wsv__editorwrap', null, dom.editorHost, dom.welcome);

  dom.tabsNode = h('div.wsv__tabs', { role: 'tablist' });
  dom.panelNode = h('div.wsv__panel');
  dom.bottom = h('div.wsv__bottom', null,
    h('div.wsv__tabsbar', null,
      dom.tabsNode,
      h('button.icon-button.wsv__grow', {
        type: 'button',
        title: 'Bereich vergrößern oder verkleinern',
        'aria-label': 'Bereich vergrößern oder verkleinern',
        onClick: () => {
          self.bottomBig = !self.bottomBig;
          dom.bottom.dataset.big = self.bottomBig ? '1' : '0';
        },
      }, icon(ICONS.history))),
    dom.panelNode);
  dom.bottom.dataset.big = '0';

  const main = h('section.wsv__main', null, bar, dom.errorBand, editorWrap, dom.bottom);

  dom.root = h('div.wsv', null, head, h('div.wsv__body', null, side, main));
  container.appendChild(dom.root);

  buildWelcome(self);
  buildTabs(self);

  self.editor = createEditor(dom.editorHost, {
    label: 'Quelltext des Moduls',
    placeholder: 'Hier den Code einfügen, den du bekommen hast – oder oben eine Vorlage wählen.',
    onChange: () => {
      self.dirty = true;
      // The old report described the old text; keeping it on screen next to
      // changed code would be the interface telling a small lie.
      if (self.validation || self.validationError) {
        self.validation = null;
        self.validationError = null;
        if (self.tab === 'report') renderPanel(self);
      }
      renderBar(self);
      updateWelcome(self);
    },
    onSave: () => {
      if (self.selectedId) saveModule(self);
      else installModule(self);
    },
  });

  // Shown at once rather than after the first load: an empty editor with no
  // explanation is the first thing the user would otherwise see.
  updateWelcome(self);

  // A click anywhere else closes the template menu; Escape does too.
  self.cleanups.push(on(document, 'click', () => toggleMenu(self, false)));
  self.cleanups.push(on(document, 'keydown', (event) => {
    if (event.key === 'Escape' && self.menuOpen) toggleMenu(self, false);
  }));
}

function buildTemplateMenu(self) {
  const menu = self.dom.templateMenu;
  clear(menu);
  menu.appendChild(h('p.wsv__menu-head', null, text('Ein lauffähiges Grundgerüst in den Editor legen:')));
  for (const template of TEMPLATES) {
    menu.appendChild(h('button.wsv__menu-item', {
      type: 'button',
      role: 'menuitem',
      onClick: (event) => {
        event.stopPropagation();
        toggleMenu(self, false);
        useTemplate(self, template);
      },
    },
    h('span.wsv__menu-label', null, text(template.label)),
    h('span.wsv__menu-hint', null, text(template.hint))));
  }
}

function toggleMenu(self, open) {
  if (self.menuOpen === open) return;
  self.menuOpen = open;
  self.dom.templateMenu.hidden = !open;
  self.dom.templateButton.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function buildWelcome(self) {
  const node = self.dom.welcome;
  clear(node);
  node.appendChild(h('div.wsv__welcome-inner', null,
    h('h3.wsv__welcome-title', null, text('Die Werkstatt')),
    h('p', null, text(
      'Hier fügst du Code ein, der Neural OS erweitert – eine eigene Ansicht, ein Werkzeug für '
      + 'Agenten, eine eigene Adresse.',
    )),
    h('p', null, text(
      'Nichts davon läuft, bevor du es geprüft und ausdrücklich eingeschaltet hast; beim Prüfen '
      + 'wird nichts installiert.',
    )),
    h('p', null, text(
      'Geht etwas schief, schaltest du das Modul aus oder gehst im Verlauf zur vorherigen Fassung '
      + 'zurück – die App startet auch dann noch.',
    )),
    h('div.wsv__welcome-actions', null,
      h('button.btn.btn--primary', {
        type: 'button',
        onClick: () => useTemplate(self, TEMPLATES[0]),
      }, icon(ICONS.template), text(`Vorlage „${TEMPLATES[0].label}“ laden`)))));
}

function buildTabs(self) {
  const node = self.dom.tabsNode;
  clear(node);
  self.dom.tabButtons = new Map();
  for (const tab of TABS) {
    const button = h('button.wsv__tab', {
      type: 'button',
      role: 'tab',
      onClick: () => {
        self.tab = tab.id;
        renderTabs(self);
        renderPanel(self);
      },
    }, text(tab.label));
    self.dom.tabButtons.set(tab.id, button);
    node.appendChild(button);
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll(self) {
  renderList(self);
  renderBar(self);
  renderError(self);
  renderTabs(self);
  renderPanel(self);
  updateWelcome(self);
}

function selected(self) {
  if (self.detail && self.detail.id === self.selectedId) return self.detail;
  return self.modules.find((entry) => entry.id === self.selectedId) || null;
}

function stateOf(module) {
  if (!module) return { key: 'none', label: '–', tone: 'muted' };
  if (module.lastError) return { key: 'failed', label: 'FEHLERHAFT', tone: 'danger' };
  if (module.enabled && module.loaded) return { key: 'on', label: 'aktiv', tone: 'ok' };
  if (module.enabled) return { key: 'stalled', label: 'eingeschaltet, läuft nicht', tone: 'warn' };
  return { key: 'off', label: 'aus', tone: 'muted' };
}

function renderList(self) {
  const { dom } = self;
  clear(dom.listState);

  clear(dom.statusLine);
  if (self.status) {
    const bits = [`${self.modules.length} insgesamt`];
    if (Number.isFinite(self.status.loaded)) bits.push(`${self.status.loaded} aktiv`);
    if (self.status.failed) bits.push(`${self.status.failed} fehlerhaft`);
    if (self.status.safeMode) bits.push('abgesicherter Start');
    dom.statusLine.appendChild(text(bits.join(' · ')));
  } else if (self.modules.length) {
    dom.statusLine.appendChild(text(`${self.modules.length} insgesamt`));
  }

  if (self.listError) {
    dom.listState.appendChild(h('div.wsv__side-error', null,
      h('p.wsv__side-error-text', null, text(errorMessage(self.listError))),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: async () => {
          await loadModules(self);
          if (self.alive) renderAll(self);
        },
      }, text('Erneut versuchen'))));
    clear(dom.listNode);
    return;
  }

  if (self.listLoading && !self.modules.length) {
    dom.listState.appendChild(h('p.wsv__side-hint', null, text('Module werden geladen …')));
    return;
  }

  if (!self.modules.length) {
    dom.listState.appendChild(h('p.wsv__side-hint', null, text(
      'Noch kein Modul installiert. Wähle oben eine Vorlage oder füge Code in den Editor ein.',
    )));
    clear(dom.listNode);
    return;
  }

  list(dom.listNode, self.modules, (module) => module.id, (module, existing) => {
    const node = existing || h('li.wsv__item');
    clear(node);
    const state = stateOf(module);
    node.dataset.state = state.key;
    node.classList.toggle('is-active', module.id === self.selectedId);
    node.appendChild(h('button.wsv__item-btn', {
      type: 'button',
      onClick: () => selectModule(self, module.id),
    },
    h('span.wsv__item-top', null,
      h('span.wsv__item-name', null, text(module.name)),
      h('span.wsv__item-dot', { 'data-tone': state.tone })),
    h('span.wsv__item-meta', null, text(
      `${module.kind === 'ui' ? 'Oberfläche' : 'Server'} · Fassung ${module.version} · ${state.label}`,
    )),
    module.lastError
      ? h('span.wsv__item-error', null, text(shorten(module.lastError.message, 120)))
      : null));
    return node;
  });
}

function renderBar(self) {
  const { dom } = self;
  const module = selected(self);
  const state = stateOf(module);
  const hasText = !!(self.editor && self.editor.getValue().trim());

  clear(dom.barTitle);
  dom.barTitle.appendChild(text(module ? module.name : 'Neues Modul'));

  clear(dom.barBadges);
  if (module) {
    dom.barBadges.appendChild(h('span.wsv__badge', { 'data-tone': state.tone }, text(state.label)));
    dom.barBadges.appendChild(h('span.badge', null, text(module.kind === 'ui' ? 'Oberfläche' : 'Server')));
    dom.barBadges.appendChild(h('span.badge', null, text(`Fassung ${module.version}`)));
    if (module.risk) {
      dom.barBadges.appendChild(h('span.wsv__badge', { 'data-tone': RISK[module.risk] ? module.risk : 'low' },
        text(`Risiko ${(RISK[module.risk] || RISK.low).label}`)));
    }
  } else {
    dom.barBadges.appendChild(h('span.badge', null, text('noch nicht installiert')));
  }
  if (self.dirty) {
    dom.barBadges.appendChild(h('span.wsv__badge', { 'data-tone': 'warn' }, text('ungespeichert')));
  }

  clear(dom.barActions);
  const busy = self.busy;
  const add = (node) => dom.barActions.appendChild(node);

  add(h('button.btn.btn--primary', {
    type: 'button',
    disabled: !hasText || !!busy,
    onClick: () => validateSource(self),
  }, icon(ICONS.check), text(busy === 'validate' ? 'Wird geprüft …' : 'Prüfen')));

  if (!module) {
    add(h('button.btn', {
      type: 'button',
      disabled: !hasText || !!busy,
      onClick: () => installModule(self),
    }, icon(ICONS.download), text(busy === 'install' ? 'Wird installiert …' : 'Installieren')));
  } else {
    add(h('button.btn', {
      type: 'button',
      disabled: !self.dirty || !hasText || !!busy,
      title: 'Den Quelltext als neue Fassung speichern. Die alte bleibt im Verlauf.',
      onClick: () => saveModule(self),
    }, icon(ICONS.save), text(busy === 'save' ? 'Wird gespeichert …' : 'Speichern')));

    if (module.enabled) {
      add(h('button.btn', {
        type: 'button',
        disabled: !!busy,
        onClick: () => disableModule(self),
      }, icon(ICONS.stop), text(busy === 'disable' ? 'Wird ausgeschaltet …' : 'Deaktivieren')));
    } else {
      add(h('button.btn', {
        type: 'button',
        disabled: !!busy,
        onClick: () => enableModule(self),
      }, icon(ICONS.play), text(busy === 'enable' ? 'Wird eingeschaltet …' : 'Aktivieren')));
    }

    add(h('button.btn.btn--ghost', {
      type: 'button',
      onClick: () => {
        self.tab = 'history';
        renderTabs(self);
        renderPanel(self);
      },
    }, icon(ICONS.history), text('Verlauf')));
  }

  add(h('button.btn.btn--ghost', {
    type: 'button',
    disabled: !hasText,
    title: 'Den Quelltext als Datei sichern',
    onClick: () => exportSource(self),
  }, icon(ICONS.download), text('Exportieren')));

  if (module && !module.builtin) {
    // Ghost + a colour of its own: `.btn--ghost` is declared after
    // `.btn--danger` in app.css, so combining the two would quietly produce a
    // grey button and the destructive action would read as a neutral one.
    add(h('button.btn.btn--ghost.wsv__btn-danger', {
      type: 'button',
      disabled: !!busy,
      onClick: () => removeModule(self),
    }, icon(ICONS.trash), text('Entfernen')));
  }
}

function renderError(self) {
  const { dom } = self;
  const module = selected(self);
  const failure = module && module.lastError;
  clear(dom.errorBand);
  dom.errorBand.hidden = !failure;
  if (!failure) return;

  dom.errorBand.appendChild(h('div.wsv__errband-head', null,
    icon(ICONS.alert, { class: 'wsv__errband-icon' }),
    h('span.wsv__errband-title', null, text(
      `„${module.name}“ ist fehlerhaft${failure.where ? ` (${failure.where})` : ''}.`,
    )),
    failure.at ? h('span.meta', null, text(timeAgo(failure.at))) : null));
  dom.errorBand.appendChild(h('p.wsv__errband-msg', null, text(failure.message || 'Unbekannter Fehler.')));
  if (module.failures > 1) {
    dom.errorBand.appendChild(h('p.wsv__errband-note', null, text(
      `${module.failures} Fehlschläge in Folge. Nach drei Fehlschlägen bleibt ein Modul aus, bis du es wieder einschaltest.`,
    )));
  }
  if (failure.stack) {
    dom.errorBand.appendChild(h('details.wsv__errband-more', null,
      h('summary', null, text('Technische Einzelheiten')),
      h('pre.code', null, text(failure.stack))));
  }

  const actions = h('div.wsv__errband-actions');
  if (Number.isInteger(failure.line)) {
    actions.appendChild(h('button.btn.btn--small', {
      type: 'button',
      onClick: () => markLine(self, failure.line, failure.message),
    }, text(`Zeile ${failure.line} zeigen`)));
  }
  actions.appendChild(h('button.btn.btn--small', {
    type: 'button',
    onClick: () => enableModule(self),
  }, text('Erneut versuchen')));
  if (module.versions.length) {
    actions.appendChild(h('button.btn.btn--small', {
      type: 'button',
      onClick: () => {
        self.tab = 'history';
        renderTabs(self);
        renderPanel(self);
      },
    }, text('Zu einer früheren Fassung zurück')));
  }
  dom.errorBand.appendChild(actions);
}

function renderTabs(self) {
  if (!self.dom.tabButtons) return;
  for (const [id, button] of self.dom.tabButtons) {
    const active = id === self.tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }
}

function renderPanel(self) {
  const node = self.dom.panelNode;
  clear(node);
  if (self.tab === 'log') node.appendChild(buildLogPanel(self));
  else if (self.tab === 'history') node.appendChild(buildHistoryPanel(self));
  else node.appendChild(buildReportPanel(self));
}

function updateWelcome(self) {
  const empty = !self.selectedId && !(self.editor && self.editor.getValue().trim());
  self.dom.welcome.hidden = !empty;
}

/* ----------------------------- report ------------------------------ */

function buildReportPanel(self) {
  if (self.validationError) {
    return h('div.wsv__report', null, buildApiError(self, self.validationError));
  }
  const report = self.validation;
  if (!report) {
    return h('div.empty', null,
      h('p', null, text('Noch nichts geprüft.')),
      h('p.meta', null, text(
        '„Prüfen“ liest das Manifest, prüft die Syntax und lässt das Modul einmal probeweise '
        + 'anlaufen. Installiert wird dabei nichts.',
      )));
  }

  const wrap = h('div.wsv__report');

  wrap.appendChild(h('div.wsv__verdict', { 'data-ok': report.ok ? '1' : '0' },
    icon(report.ok ? ICONS.check : ICONS.alert),
    h('span', null, text(report.ok
      ? 'Die Prüfung ist bestanden. Das Modul lässt sich installieren.'
      : `Die Prüfung ist nicht bestanden: ${count(report.problems, 'Problem', 'Probleme')}.`))));

  if (report.manifest) {
    const manifest = report.manifest;
    wrap.appendChild(h('section.wsv__block', null,
      h('h4.wsv__block-title', null, text('Manifest')),
      h('dl.wsv__facts', null,
        fact('Name', manifest.name || '–'),
        fact('Beschreibung', manifest.description || '–'),
        fact('Art', (report.kind || manifest.kind) === 'ui' ? 'Oberflächen-Modul (läuft im Browser)' : 'Server-Modul (läuft im Server)'),
        manifest.author ? fact('Autor', manifest.author) : null)));
  }

  wrap.appendChild(buildCapabilityBlock(self, report.capabilities || [], report.risk, report.description));

  if (report.registered) wrap.appendChild(buildRegisteredBlock(report.registered));

  if (report.problems && report.problems.length) {
    wrap.appendChild(buildIssueBlock(self, 'Probleme', report.problems, 'error'));
  }
  if (report.warnings && report.warnings.length) {
    wrap.appendChild(buildIssueBlock(self, 'Hinweise', report.warnings, 'warn'));
  }
  return wrap;
}

function buildCapabilityBlock(self, caps, risk, summary) {
  const tone = RISK[risk] ? risk : 'low';
  const block = h('section.wsv__block', null,
    h('h4.wsv__block-title', null,
      text('Verlangte Berechtigungen'),
      h('span.wsv__badge', { 'data-tone': tone }, text(`Risiko ${(RISK[tone] || RISK.low).label}`))));

  if (!caps.length) {
    block.appendChild(h('p.wsv__block-text', null, text(
      'Keine. Das Modul kann weder Daten lesen noch ändern und nichts senden.',
    )));
    return block;
  }

  const cards = h('div.wsv__caps');
  for (const id of caps) cards.appendChild(buildCapabilityCard(self, id));
  block.appendChild(cards);
  if (summary) block.appendChild(h('p.wsv__block-text', null, text(summary)));
  return block;
}

function buildCapabilityCard(self, id) {
  const entry = self.catalogue ? self.catalogue.get(id) : null;
  const tone = entry && RISK[entry.risk] ? entry.risk : 'low';
  return h('article.wsv__cap', { 'data-tone': tone },
    h('div.wsv__cap-head', null,
      h('span.wsv__cap-label', null, text(entry ? entry.label : id)),
      h('span.wsv__badge', { 'data-tone': tone }, text((RISK[tone] || RISK.low).label))),
    h('p.wsv__cap-hint', null, text(entry
      ? entry.hint
      : `Zu „${id}“ liegt keine Erklärung vor – der Katalog des Servers war nicht erreichbar.`)),
    h('code.wsv__cap-id', null, text(id)));
}

function buildRegisteredBlock(registered) {
  const rows = [];
  for (const tool of registered.tools || []) rows.push(`Werkzeug ${tool.name}${tool.description ? ` – ${tool.description}` : ''}`);
  for (const route of registered.routes || []) rows.push(`Adresse ${route.method} ${route.path}`);
  for (const event of registered.events || []) rows.push(`Ereignis ${event}`);
  for (const uiView of registered.views || []) rows.push(`Ansicht ${uiView}`);
  if (!rows.length) return h('section.wsv__block', null,
    h('h4.wsv__block-title', null, text('Was das Modul anmeldet')),
    h('p.wsv__block-text', null, text('Nichts. Der Probelauf hat weder Werkzeug noch Adresse noch Ereignis angemeldet.')));

  return h('section.wsv__block', null,
    h('h4.wsv__block-title', null, text('Was das Modul anmeldet')),
    h('ul.wsv__plain', null, ...rows.map((row) => h('li', null, text(row)))));
}

function buildIssueBlock(self, title, issues, kind) {
  const node = h('section.wsv__block', null, h('h4.wsv__block-title', null, text(title)));
  const ul = h('ul.wsv__issues');
  for (const raw of issues) {
    const issue = typeof raw === 'string' ? { message: raw, line: null } : (raw || {});
    const line = Number.isInteger(issue.line) ? issue.line : null;
    const row = h('li.wsv__issue', { 'data-kind': kind });
    if (line) {
      row.appendChild(h('button.wsv__issue-line', {
        type: 'button',
        title: `Zeile ${line} im Editor markieren`,
        onClick: () => markLine(self, line, issue.message, kind),
      }, text(`Zeile ${line}`)));
    } else {
      row.appendChild(h('span.wsv__issue-line.is-muted', null, text('—')));
    }
    row.appendChild(h('span.wsv__issue-text', null, text(issue.message || String(raw))));
    if (issue.code) row.appendChild(h('code.wsv__issue-code', null, text(issue.code)));
    ul.appendChild(row);
  }
  node.appendChild(ul);
  return node;
}

/* ------------------------------- log ------------------------------- */

function buildLogPanel(self) {
  const module = selected(self);
  const fromRecord = module && module.log ? module.log : [];
  const live = self.logLines.filter((entry) => !module || !entry.id || entry.id === module.id);
  const rows = [...fromRecord, ...live];

  if (!rows.length) {
    return h('div.empty', null,
      h('p', null, text('Noch keine Ausgaben.')),
      h('p.meta', null, text(
        'Hier erscheint, was ein laufendes Modul mit api.log(…) schreibt, und jeder Fehler, den es auslöst.',
      )));
  }

  const listNode = h('ul.wsv__log');
  for (const entry of rows.slice(-300)) {
    listNode.appendChild(h('li.wsv__log-row', { 'data-level': entry.level || 'info' },
      h('span.wsv__log-time', null, text(entry.at ? formatDateTime(entry.at) : '')),
      h('span.wsv__log-text', null, text(entry.text || ''))));
  }
  return listNode;
}

/* ----------------------------- history ----------------------------- */

function buildHistoryPanel(self) {
  const module = selected(self);
  if (!module) {
    return h('div.empty', null,
      h('p', null, text('Kein Modul ausgewählt.')),
      h('p.meta', null, text('Der Verlauf zeigt jede gespeicherte Fassung eines installierten Moduls.')));
  }

  const wrap = h('div.wsv__history');
  wrap.appendChild(h('p.wsv__history-lead', null, text(
    'Jede Fassung bleibt erhalten. Ein Rückschritt ist selbst wieder umkehrbar: die aktuelle '
    + 'Fassung wird vorher an den Verlauf angehängt.',
  )));

  const table = h('table.table.wsv__history-table', null,
    h('thead', null, h('tr', null,
      h('th', null, text('Fassung')),
      h('th', null, text('Wann')),
      h('th', null, text('Notiz')),
      h('th', null, text('Größe')),
      h('th', null, text('')))),
  );
  const tbody = h('tbody');

  tbody.appendChild(h('tr.wsv__history-current', null,
    h('td', null, h('strong', null, text(`${module.version}`)), text(' (aktuell)')),
    h('td', null, text(module.updatedAt ? formatDateTime(module.updatedAt) : '–')),
    h('td', null, text('Die aktive Fassung.')),
    h('td', null, text(module.source ? formatBytes(module.source.length) : '–')),
    h('td', null, module.source
      ? h('button.btn.btn--small', {
        type: 'button',
        onClick: () => loadIntoEditor(self, module.source, false),
      }, text('In den Editor'))
      : null)));

  const past = module.versions.slice().sort((a, b) => (b.version || 0) - (a.version || 0));
  for (const entry of past) {
    const actions = h('div.wsv__history-actions');
    if (entry.source) {
      actions.appendChild(h('button.btn.btn--small.btn--ghost', {
        type: 'button',
        title: 'Diese Fassung ansehen, ohne etwas zu ändern',
        onClick: () => loadIntoEditor(self, entry.source, true),
      }, text('Ansehen')));
    }
    if (Number.isInteger(entry.version)) {
      actions.appendChild(h('button.btn.btn--small', {
        type: 'button',
        onClick: () => rollback(self, entry.version),
      }, text('Zurück zu dieser Fassung')));
    }
    tbody.appendChild(h('tr', null,
      h('td', null, text(entry.version === null ? '?' : String(entry.version))),
      h('td', null, text(entry.at ? formatDateTime(entry.at) : '–')),
      h('td', null, text(entry.note || '—')),
      h('td', null, text(Number.isFinite(entry.bytes) ? formatBytes(entry.bytes) : '–')),
      h('td', null, actions)));
  }

  if (!past.length) {
    tbody.appendChild(h('tr', null, h('td', { colspan: '5' },
      h('span.meta', null, text('Noch keine frühere Fassung – bisher gibt es nur die erste.')))));
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function selectModule(self, id) {
  if (self.dirty && !(await confirmDiscard(self))) return;
  self.selectedId = id;
  self.detail = null;
  self.validation = null;
  self.validationError = null;
  self.dirty = false;
  // Emptied while the source travels: leaving the previous module's code on
  // screen under the new module's name is the interface telling a lie, and
  // "Speichern" would then offer to write it there.
  self.editor.setValue('');
  renderAll(self);

  const detail = await loadDetail(self, id);
  if (!self.alive || self.selectedId !== id) return;
  self.detail = detail;
  if (detail && typeof detail.source === 'string') {
    self.editor.setValue(detail.source);
    self.dirty = false;
  }
  renderAll(self);
}

async function startNew(self) {
  if (self.dirty && !(await confirmDiscard(self))) return;
  self.selectedId = null;
  self.detail = null;
  self.validation = null;
  self.validationError = null;
  self.dirty = false;
  self.editor.setValue('');
  self.editor.focus();
  renderAll(self);
}

async function useTemplate(self, template) {
  if (self.dirty && !(await confirmDiscard(self))) return;
  self.selectedId = null;
  self.detail = null;
  self.validation = null;
  self.validationError = null;
  self.editor.setValue(template.source);
  // A template is unsaved text like any other; it is only "clean" once stored.
  self.dirty = true;
  self.tab = 'report';
  self.editor.focus();
  renderAll(self);
  self.ctx.toast(`Vorlage „${template.label}“ eingefügt. Mit „Prüfen“ siehst du, was sie darf.`, 'info');
}

function loadIntoEditor(self, source, asDraft) {
  self.editor.setValue(typeof source === 'string' ? source : '');
  self.dirty = !!asDraft;
  self.validation = null;
  self.validationError = null;
  renderAll(self);
  if (asDraft) {
    self.ctx.toast(
      'Diese alte Fassung liegt jetzt im Editor. Am Modul hat sich nichts geändert – mit '
      + '„Speichern“ würde sie zur neuen Fassung.',
      'info',
    );
  }
}

function markLine(self, line, message, kind = 'error') {
  if (!self.editor) return;
  self.editor.clearMarkers();
  const ok = self.editor.setMarker(line, shorten(message, 140), { kind, focus: true });
  if (!ok) self.ctx.toast('Zu diesem Problem gibt es keine Zeilennummer.', 'info');
}

async function validateSource(self) {
  const source = self.editor.getValue();
  if (!source.trim()) return;
  self.busy = 'validate';
  self.validationError = null;
  renderBar(self);
  try {
    const result = await request(self, (signal) => self.api.post('/modules/validate', { source }, { signal }));
    if (!self.alive) return;
    self.validation = (result && result.validation) || null;
    self.tab = 'report';
    if (self.validation && !self.validation.ok) {
      const first = (self.validation.problems || [])[0];
      if (first && Number.isInteger(first.line)) self.editor.setMarker(first.line, shorten(first.message, 140));
    } else {
      self.editor.clearMarkers();
    }
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.validation = validationFrom(err);
    self.validationError = self.validation ? null : err;
    self.tab = 'report';
  } finally {
    if (self.alive) {
      self.busy = null;
      renderBar(self);
      renderTabs(self);
      renderPanel(self);
    }
  }
}

async function installModule(self) {
  const source = self.editor.getValue();
  if (!source.trim()) return;
  self.busy = 'install';
  renderBar(self);
  try {
    const result = await request(self, (signal) => self.api.post('/modules', { source, note: 'Erste Fassung' }, { signal }));
    if (!self.alive) return;
    const record = result && result.record;
    const module = normaliseModule(record, result && result.description);
    self.validation = (result && result.validation) || self.validation;
    self.validationError = null;
    await loadModules(self);
    if (!self.alive) return;
    if (module && module.id) {
      self.selectedId = module.id;
      self.detail = module.source ? module : await loadDetail(self, module.id);
    }
    self.dirty = false;
    self.ctx.toast('Installiert – und bewusst noch ausgeschaltet. Mit „Aktivieren“ läuft es.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    const report = validationFrom(err);
    if (report) {
      self.validation = report;
      self.validationError = null;
      const first = (report.problems || [])[0];
      if (first && Number.isInteger(first.line)) self.editor.setMarker(first.line, shorten(first.message, 140));
    } else {
      self.validationError = err;
    }
    self.tab = 'report';
    self.ctx.toast(`Nicht installiert: ${errorMessage(err)}`, 'error');
  } finally {
    if (self.alive) {
      self.busy = null;
      self.tab = self.tab === 'log' ? 'log' : 'report';
      renderAll(self);
    }
  }
}

async function saveModule(self) {
  const module = selected(self);
  if (!module) return;
  const source = self.editor.getValue();
  if (!source.trim()) return;

  const note = await askText(self, {
    title: 'Neue Fassung speichern',
    intro: `Die bisherige Fassung ${module.version} bleibt im Verlauf und lässt sich jederzeit zurückholen. `
      + 'Das Modul wird dabei ausgeschaltet, bis du es wieder aktivierst.',
    label: 'Notiz zu dieser Fassung (freiwillig)',
    placeholder: 'z. B. „Zählt jetzt auch Aufgaben“',
    confirmLabel: 'Speichern',
  });
  if (note === null) return;

  self.busy = 'save';
  renderBar(self);
  try {
    const result = await request(self, (signal) => self.api.patch(
      `/modules/${encodeURIComponent(module.id)}`, { source, note }, { signal },
    ));
    if (!self.alive) return;
    self.dirty = false;
    await loadModules(self);
    if (!self.alive) return;
    self.detail = await loadDetail(self, module.id);
    for (const line of (result && result.notes) || []) self.ctx.toast(line, 'info');
    if (!(result && result.notes && result.notes.length)) {
      self.ctx.toast('Gespeichert. Die alte Fassung liegt im Verlauf.', 'success');
    }
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    const report = validationFrom(err);
    if (report) {
      self.validation = report;
      self.tab = 'report';
      const first = (report.problems || [])[0];
      if (first && Number.isInteger(first.line)) self.editor.setMarker(first.line, shorten(first.message, 140));
    }
    self.ctx.toast(`Nicht gespeichert: ${errorMessage(err)}`, 'error');
  } finally {
    if (self.alive) {
      self.busy = null;
      renderAll(self);
    }
  }
}

async function enableModule(self) {
  const module = selected(self);
  if (!module) return;
  const confirmed = await confirmEnable(self, module);
  if (!confirmed) return;

  self.busy = 'enable';
  renderBar(self);
  try {
    const result = await request(self, (signal) => self.api.post(
      `/modules/${encodeURIComponent(module.id)}/enable`,
      { capabilities: module.capabilities },
      { signal },
    ));
    if (!self.alive) return;
    await loadModules(self);
    if (!self.alive) return;
    self.detail = await loadDetail(self, module.id);
    const registered = result && result.registered;
    self.ctx.toast(registered
      ? `„${module.name}“ läuft: ${describeRegistered(registered)}`
      : `„${module.name}“ läuft.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    await loadModules(self);
    if (self.alive) self.detail = await loadDetail(self, module.id);
    const line = err && err.details && err.details.lastError && err.details.lastError.line;
    if (Number.isInteger(line)) self.editor.setMarker(line, shorten(errorMessage(err), 140));
    self.ctx.toast(
      `Nicht eingeschaltet: ${errorMessage(err)} Das Modul bleibt aus – die App läuft weiter.`,
      'error',
    );
  } finally {
    if (self.alive) {
      self.busy = null;
      renderAll(self);
    }
  }
}

async function disableModule(self) {
  const module = selected(self);
  if (!module) return;
  // No dialog: getting out of trouble must never be harder than getting in.
  self.busy = 'disable';
  renderBar(self);
  try {
    await request(self, (signal) => self.api.post(`/modules/${encodeURIComponent(module.id)}/disable`, {}, { signal }));
    if (!self.alive) return;
    await loadModules(self);
    if (!self.alive) return;
    self.detail = await loadDetail(self, module.id);
    self.ctx.toast(`„${module.name}“ ist ausgeschaltet. Der Quelltext bleibt erhalten.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Konnte nicht ausgeschaltet werden: ${errorMessage(err)}`, 'error');
  } finally {
    if (self.alive) {
      self.busy = null;
      renderAll(self);
    }
  }
}

async function rollback(self, version) {
  const module = selected(self);
  if (!module) return;
  const ok = await confirmDialog(self, {
    title: `Zurück zu Fassung ${version}?`,
    build: () => [
      h('p.dialog__text', null, text(
        `Fassung ${version} wird wieder die aktive. Die jetzige Fassung ${module.version} wird vorher `
        + 'an den Verlauf angehängt – du kannst diesen Schritt also selbst wieder zurücknehmen.',
      )),
      h('p.dialog__text', null, text('Das Modul bleibt danach ausgeschaltet, bis du es aktivierst.')),
    ],
    confirmLabel: 'Zurückgehen',
  });
  if (!ok) return;

  self.busy = 'rollback';
  renderBar(self);
  try {
    const result = await request(self, (signal) => self.api.post(
      `/modules/${encodeURIComponent(module.id)}/rollback`, { version }, { signal },
    ));
    if (!self.alive) return;
    await loadModules(self);
    if (!self.alive) return;
    self.detail = await loadDetail(self, module.id);
    if (self.detail && typeof self.detail.source === 'string') {
      self.editor.setValue(self.detail.source);
      self.dirty = false;
    }
    self.ctx.toast((result && result.note) || `Fassung ${version} ist wieder aktiv.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Rückschritt nicht möglich: ${errorMessage(err)}`, 'error');
  } finally {
    if (self.alive) {
      self.busy = null;
      renderAll(self);
    }
  }
}

async function removeModule(self) {
  const module = selected(self);
  if (!module) return;
  const ok = await confirmDialog(self, {
    title: `„${module.name}“ entfernen?`,
    danger: true,
    build: () => [
      h('p.dialog__text', null, text(
        'Das Modul wird ausgeschaltet und aus der Liste entfernt. Der Eintrag bleibt als gelöscht '
        + 'im Speicher, aber diese Oberfläche kann ihn nicht zurückholen.',
      )),
      h('p.dialog__text', null, text(
        'Wenn du den Quelltext behalten willst, brich hier ab und speichere ihn vorher mit '
        + '„Exportieren“ als Datei.',
      )),
    ],
    confirmLabel: 'Entfernen',
    ackLabel: 'Ich habe den Quelltext, falls ich ihn noch brauche.',
  });
  if (!ok) return;

  self.busy = 'remove';
  renderBar(self);
  try {
    await request(self, (signal) => self.api.del(`/modules/${encodeURIComponent(module.id)}`, { signal }));
    if (!self.alive) return;
    self.selectedId = null;
    self.detail = null;
    self.dirty = false;
    self.editor.setValue('');
    await loadModules(self);
    self.ctx.toast(`„${module.name}“ wurde entfernt.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Nicht entfernt: ${errorMessage(err)}`, 'error');
  } finally {
    if (self.alive) {
      self.busy = null;
      renderAll(self);
    }
  }
}

function exportSource(self) {
  const source = self.editor.getValue();
  if (!source.trim()) return;
  const module = selected(self);
  const name = fileNameFor(module ? module.name : 'modul');

  try {
    const blob = new Blob([source], { type: 'text/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = h('a', { href: url, download: name, style: { display: 'none' } });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked late on purpose: some browsers start the download asynchronously
    // and a URL revoked immediately produces an empty file.
    later(self, () => URL.revokeObjectURL(url), 10000);
    self.ctx.toast(`„${name}“ wurde gespeichert.`, 'success');
  } catch {
    copyToClipboard(self, source);
  }
}

function copyToClipboard(self, source) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(source).then(
      () => self.ctx.toast('Die Datei liess sich nicht speichern – der Quelltext liegt jetzt in der Zwischenablage.', 'info'),
      () => self.ctx.toast('Weder Speichern noch Kopieren hat geklappt. Markiere den Text im Editor und kopiere ihn von Hand.', 'error'),
    );
    return;
  }
  self.ctx.toast('Dieser Browser erlaubt beides nicht. Markiere den Text im Editor und kopiere ihn von Hand.', 'error');
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

/**
 * A modal built here rather than through `ctx.confirm`, because the enable
 * dialog is not a sentence: it is a list of permissions, a consequence per
 * high-risk entry and an acknowledgement that starts unchecked. `ctx.confirm`
 * takes a title and a line of text and pre-focuses its confirm button, which
 * is exactly what this decision must not do.
 */
function openModal(self, { title, body, actions, labelledBy }) {
  const backdrop = h('div.overlay.wsv__overlay');
  const panel = h('div.overlay__panel.overlay__panel--wide', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': labelledBy,
  }, h('div.dialog.wsv__dialog', null, title, body, actions));
  backdrop.appendChild(panel);

  const previousFocus = document.activeElement;
  let closed = false;
  const offs = [];

  function close(result) {
    if (closed) return;
    closed = true;
    for (const off of offs) {
      try { off(); } catch { /* already gone */ }
    }
    backdrop.remove();
    self.dialogs.delete(close);
    if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) {
      previousFocus.focus();
    }
    if (typeof close.onClose === 'function') close.onClose(result);
  }

  offs.push(on(backdrop, 'mousedown', (event) => {
    if (event.target === backdrop) close(false);
  }));
  offs.push(on(panel, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(false);
      return;
    }
    if (event.key === 'Tab') trapFocus(event, panel);
  }));

  document.body.appendChild(backdrop);
  self.dialogs.add(close);
  return { close, panel };
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(event, root) {
  const nodes = [...root.querySelectorAll(FOCUSABLE)];
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function dialogId() {
  return `wsv-dlg-${Math.random().toString(36).slice(2, 8)}`;
}

function confirmDialog(self, options) {
  return new Promise((resolve) => {
    const id = dialogId();
    const titleNode = h('h2.dialog__title', { id }, text(options.title));
    const bodyNode = h('div.wsv__dialog-body', null, ...(options.build ? options.build() : []));

    let ackBox = null;
    const confirmButton = h('button.btn', {
      type: 'button',
      class: options.danger ? 'btn--danger' : 'btn--primary',
      disabled: !!options.ackLabel,
      onClick: () => modal.close(true),
    }, text(options.confirmLabel || 'Bestätigen'));

    if (options.ackLabel) {
      ackBox = h('input', {
        type: 'checkbox',
        id: `${id}-ack`,
        onChange: (event) => { confirmButton.disabled = !event.target.checked; },
      });
      bodyNode.appendChild(h('label.wsv__ack', { htmlFor: `${id}-ack` },
        ackBox, h('span', null, text(options.ackLabel))));
    }

    const cancelButton = h('button.btn', {
      type: 'button',
      onClick: () => modal.close(false),
    }, text(options.cancelLabel || 'Abbrechen'));

    const actions = h('div.dialog__actions', null, cancelButton, confirmButton);
    const modal = openModal(self, { title: titleNode, body: bodyNode, actions, labelledBy: id });
    modal.close.onClose = (result) => resolve(result === true);
    // Focus lands on "Abbrechen": nothing about running pasted code is
    // pre-selected, and Enter must not be able to approve it by reflex.
    cancelButton.focus();
  });
}

/** Resolves with the entered text, or `null` when the user cancelled. */
function askText(self, options) {
  return new Promise((resolve) => {
    const id = dialogId();
    const input = h('input.input', {
      type: 'text',
      id: `${id}-text`,
      maxlength: '200',
      placeholder: options.placeholder || '',
    });
    const titleNode = h('h2.dialog__title', { id }, text(options.title));
    const bodyNode = h('div.wsv__dialog-body', null,
      options.intro ? h('p.dialog__text', null, text(options.intro)) : null,
      h('div.field', null,
        h('label.label', { htmlFor: `${id}-text` }, text(options.label || 'Notiz')),
        input));

    const actions = h('div.dialog__actions', null,
      h('button.btn', { type: 'button', onClick: () => modal.close(null) }, text('Abbrechen')),
      h('button.btn.btn--primary', {
        type: 'button',
        onClick: () => modal.close(input.value),
      }, text(options.confirmLabel || 'Weiter')));

    const modal = openModal(self, { title: titleNode, body: bodyNode, actions, labelledBy: id });
    modal.close.onClose = (result) => resolve(typeof result === 'string' ? result : null);
    input.focus();
  });
}

function confirmDiscard(self) {
  return confirmDialog(self, {
    title: 'Ungespeicherten Text verwerfen?',
    build: () => [h('p.dialog__text', null, text(
      'Im Editor steht Text, der noch nicht gespeichert ist. Wenn du weitergehst, ist er weg. '
      + 'Brich ab und nutze „Exportieren“, wenn du ihn behalten willst.',
    ))],
    confirmLabel: 'Verwerfen',
    danger: true,
  });
}

/**
 * The one dialog this whole screen is really about: the moment pasted code
 * starts running. It names every permission, spells out what can go wrong for
 * the high-risk ones, and starts with nothing selected.
 */
function confirmEnable(self, module) {
  const risk = RISK[module.risk] ? module.risk : 'low';
  const caps = module.capabilities || [];
  const highs = caps.filter((id) => {
    const entry = self.catalogue ? self.catalogue.get(id) : null;
    return (entry && entry.risk === 'high') || CONSEQUENCE[id];
  });

  return confirmDialog(self, {
    title: `„${module.name}“ einschalten?`,
    danger: risk === 'high',
    confirmLabel: 'Jetzt einschalten',
    ackLabel: risk === 'high'
      ? 'Ich habe gelesen, was schiefgehen kann, und will es trotzdem einschalten.'
      : 'Ich habe die Berechtigungen gelesen.',
    build: () => {
      const parts = [];
      parts.push(h('p.dialog__text', null, text(
        module.kind === 'ui'
          ? 'Ab jetzt läuft dieser Code in deinem Browser, jedes Mal wenn du die Ansicht öffnest.'
          : 'Ab jetzt läuft dieser Code in Neural OS auf diesem Gerät – auch im Hintergrund.',
      )));

      if (!caps.length) {
        parts.push(h('p.dialog__text', null, text(
          'Das Modul verlangt keine einzige Berechtigung. Es kann weder Daten lesen noch ändern '
          + 'und nichts senden.',
        )));
      } else {
        parts.push(h('h3.wsv__dialog-h', null, text('Das Modul darf dann:')));
        const cards = h('div.wsv__caps');
        for (const id of caps) cards.appendChild(buildCapabilityCard(self, id));
        parts.push(cards);
      }

      if (module.permissionText) {
        parts.push(h('p.wsv__dialog-summary', null, text(module.permissionText)));
      }

      if (risk === 'high' && highs.length) {
        const ul = h('ul.wsv__consequences');
        for (const id of highs) {
          const entry = self.catalogue ? self.catalogue.get(id) : null;
          const line = CONSEQUENCE[id] || (entry && entry.hint) || id;
          ul.appendChild(h('li', null,
            h('strong', null, text(entry ? entry.label : id)), text(' — '), text(line)));
        }
        parts.push(h('section.wsv__danger', null,
          h('h3.wsv__dialog-h', null, icon(ICONS.alert), text('Was dabei schiefgehen kann')),
          ul));
      }

      if (module.fileRoots && module.fileRoots.length) {
        parts.push(h('p.dialog__text', null,
          text('Freigegebene Ordner: '),
          ...module.fileRoots.map((root) => h('code.wsv__cap-id', null, text(root)))));
      }

      parts.push(h('p.wsv__dialog-foot', null, text(
        'Du kannst das Modul jederzeit wieder ausschalten, und jede bisherige Fassung bleibt im '
        + 'Verlauf. Die Abschottung schützt vor Fehlern, nicht vor Angriffen – deshalb steht hier, '
        + 'was das Modul darf.',
      )));
      return parts;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function fact(label, value) {
  return h('div.wsv__fact', null,
    h('dt', null, text(label)),
    h('dd', null, text(value)));
}

function count(items, one, many) {
  const n = Array.isArray(items) ? items.length : 0;
  return `${n} ${n === 1 ? one : many}`;
}

function shorten(value, max) {
  const source = String(value || '');
  return source.length > max ? `${source.slice(0, max - 1)}…` : source;
}

function describeRegistered(registered) {
  const bits = [];
  if (registered.tools && registered.tools.length) bits.push(count(registered.tools, 'Werkzeug', 'Werkzeuge'));
  if (registered.routes && registered.routes.length) bits.push(count(registered.routes, 'Adresse', 'Adressen'));
  if (registered.events && registered.events.length) bits.push(count(registered.events, 'Ereignis', 'Ereignisse'));
  if (registered.views && registered.views.length) bits.push(count(registered.views, 'Ansicht', 'Ansichten'));
  return bits.length ? `${bits.join(', ')} angemeldet.` : 'nichts angemeldet.';
}

/** The server hands the whole report back inside a refusal; use it. */
function validationFrom(err) {
  const report = err && err.details && err.details.validation;
  return report && typeof report === 'object' ? report : null;
}

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  return err.message || String(err);
}

function buildApiError(self, err) {
  return h('div.wsv__apierror', { role: 'alert' },
    h('p.wsv__apierror-msg', null, icon(ICONS.alert), text(errorMessage(err))),
    err && err.code ? h('code.wsv__issue-code', null, text(err.code)) : null,
    h('button.btn.btn--small', {
      type: 'button',
      onClick: () => validateSource(self),
    }, text('Erneut prüfen')));
}

function fileNameFor(name) {
  const slug = String(name || 'modul')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'modul'}.js`;
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
.wsv { display: flex; flex-direction: column; height: 100%; min-height: 0; }

.wsv__head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.wsv__head-main { min-width: 0; }
.wsv__title { font-size: var(--fs-lg); }
.wsv__sub { margin: 2px 0 0; color: var(--fg-muted); font-size: var(--fs-sm); max-width: 62ch; }
.wsv__head-actions { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-left: auto; }

.wsv__menu-wrap { position: relative; }
.wsv__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  width: min(330px, 80vw);
  padding: var(--sp-1);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  box-shadow: var(--shadow-2);
}
.wsv__menu-head { margin: 0 0 var(--sp-05); padding: 0 var(--sp-1); font-size: var(--fs-xs); color: var(--fg-subtle); }
.wsv__menu-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 6px var(--sp-1);
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  border-radius: var(--r-1);
  font: inherit;
  cursor: pointer;
}
.wsv__menu-item:hover { background: var(--surface-3); }
.wsv__menu-label { font-weight: 500; }
.wsv__menu-hint { font-size: var(--fs-sm); color: var(--fg-muted); }

.wsv__body {
  display: grid;
  grid-template-columns: minmax(230px, 280px) minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.wsv__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}
.wsv__side-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border);
}
.wsv__side-title { font-weight: 600; }
.wsv__status { margin: 0 0 0 auto; font-size: var(--fs-xs); color: var(--fg-subtle); text-align: right; }
.wsv__side-body { flex: 1; min-height: 0; overflow-y: auto; }
.wsv__side-hint { margin: 0; padding: var(--sp-2); font-size: var(--fs-sm); color: var(--fg-subtle); }
.wsv__side-error { display: flex; flex-direction: column; gap: var(--sp-1); align-items: flex-start; padding: var(--sp-2); }
.wsv__side-error-text { margin: 0; font-size: var(--fs-sm); color: var(--danger); }

.wsv__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.wsv__item { border-bottom: 1px solid var(--border); }
.wsv__item-btn {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  border-left: 3px solid transparent;
  font: inherit;
  cursor: pointer;
}
.wsv__item-btn:hover { background: var(--surface-3); }
.wsv__item.is-active .wsv__item-btn { background: var(--accent-soft); border-left-color: var(--accent); }
.wsv__item-top { display: flex; align-items: center; gap: var(--sp-1); }
.wsv__item-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsv__item-dot { width: 8px; height: 8px; margin-left: auto; border-radius: var(--r-full); background: var(--fg-subtle); flex: 0 0 auto; }
.wsv__item-dot[data-tone="ok"] { background: var(--ok); }
.wsv__item-dot[data-tone="warn"] { background: var(--warn); }
.wsv__item-dot[data-tone="danger"] { background: var(--danger); }
.wsv__item-meta { font-size: var(--fs-xs); color: var(--fg-subtle); }
.wsv__item-error { font-size: var(--fs-xs); color: var(--danger); }

.wsv__note {
  padding: var(--sp-2);
  border-top: 1px solid var(--border);
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  background: var(--surface);
}
.wsv__note p { margin: 0 0 var(--sp-05); }
.wsv__note-head { display: flex; align-items: center; gap: 6px; font-weight: 600; color: var(--fg); }
.wsv__note-head svg { width: 15px; height: 15px; }
.wsv__note-honest { color: var(--fg-subtle); }

.wsv__main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }

.wsv__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.wsv__bar-main { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-1); min-width: 0; }
.wsv__bar-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsv__bar-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.wsv__bar-actions { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-left: auto; }
.wsv__btn-danger { color: var(--danger); }
.wsv__btn-danger:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }

.wsv__badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  font-size: var(--fs-xs);
  font-weight: 600;
  border-radius: var(--r-full);
  color: var(--fg-muted);
  background: var(--surface-3);
}
.wsv__badge[data-tone="ok"], .wsv__badge[data-tone="low"] { color: var(--ok); }
.wsv__badge[data-tone="warn"], .wsv__badge[data-tone="medium"] { color: var(--warn); }
.wsv__badge[data-tone="danger"], .wsv__badge[data-tone="high"] { color: var(--danger); background: var(--danger-soft); }

.wsv__errband {
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border);
  border-left: 4px solid var(--danger);
  background: var(--danger-soft);
}
.wsv__errband-head { display: flex; align-items: center; gap: 6px; }
.wsv__errband-icon { color: var(--danger); width: 16px; height: 16px; }
.wsv__errband-title { font-weight: 600; color: var(--danger); }
.wsv__errband-msg { margin: var(--sp-05) 0 0; font-size: var(--fs-sm); }
.wsv__errband-note { margin: var(--sp-05) 0 0; font-size: var(--fs-xs); color: var(--fg-muted); }
.wsv__errband-more { margin-top: var(--sp-05); font-size: var(--fs-sm); }
.wsv__errband-more summary { cursor: pointer; color: var(--fg-muted); }
.wsv__errband-actions { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-top: var(--sp-1); }

.wsv__editorwrap { position: relative; flex: 1; min-height: 0; padding: var(--sp-2); }
.wsv__editor { height: 100%; min-height: 0; }

.wsv__welcome {
  position: absolute;
  inset: var(--sp-2);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-3);
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-2);
}
.wsv__welcome-inner { max-width: 54ch; }
.wsv__welcome-title { font-size: var(--fs-lg); margin-bottom: var(--sp-1); }
.wsv__welcome-inner p { margin: 0 0 var(--sp-1); color: var(--fg-muted); }
.wsv__welcome-actions { margin-top: var(--sp-2); }

.wsv__bottom {
  display: flex;
  flex-direction: column;
  flex: 0 0 34%;
  min-height: 170px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.wsv__bottom[data-big="1"] { flex-basis: 62%; }
.wsv__tabsbar { display: flex; align-items: center; gap: var(--sp-1); padding: 0 var(--sp-1); border-bottom: 1px solid var(--border); }
.wsv__tabs { display: flex; gap: 2px; }
.wsv__tab {
  padding: 7px var(--sp-2);
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.wsv__tab:hover { color: var(--fg); }
.wsv__tab.is-active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
.wsv__grow { margin-left: auto; }
.wsv__panel { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-2); }

.wsv__report { display: flex; flex-direction: column; gap: var(--sp-2); }
.wsv__verdict {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-2);
  border: 1px solid var(--border);
  font-weight: 500;
}
.wsv__verdict[data-ok="1"] { color: var(--ok); border-color: var(--ok); }
.wsv__verdict[data-ok="0"] { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
.wsv__verdict svg { width: 17px; height: 17px; flex: 0 0 auto; }

.wsv__block { display: flex; flex-direction: column; gap: var(--sp-1); }
.wsv__block-title { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-base); }
.wsv__block-text { margin: 0; font-size: var(--fs-sm); color: var(--fg-muted); max-width: 72ch; }

.wsv__facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px var(--sp-2); margin: 0; font-size: var(--fs-sm); }
.wsv__fact { display: contents; }
.wsv__fact dt { color: var(--fg-subtle); }
.wsv__fact dd { margin: 0; }

.wsv__caps { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--sp-1); }
.wsv__cap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--sp-1);
  border: 1px solid var(--border);
  border-left: 4px solid var(--fg-subtle);
  border-radius: var(--r-2);
  background: var(--surface-2);
}
.wsv__cap[data-tone="low"] { border-left-color: var(--ok); }
.wsv__cap[data-tone="medium"] { border-left-color: var(--warn); }
.wsv__cap[data-tone="high"] { border-left-color: var(--danger); background: var(--danger-soft); }
.wsv__cap-head { display: flex; align-items: center; gap: var(--sp-1); }
.wsv__cap-label { font-weight: 600; font-size: var(--fs-sm); }
.wsv__cap-head .wsv__badge { margin-left: auto; }
.wsv__cap-hint { margin: 0; font-size: var(--fs-xs); color: var(--fg-muted); }
.wsv__cap-id { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-subtle); }

.wsv__plain { margin: 0; padding-left: var(--sp-3); font-size: var(--fs-sm); color: var(--fg-muted); }

.wsv__issues { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.wsv__issue {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
  padding: 5px var(--sp-1);
  border-radius: var(--r-1);
  border-left: 3px solid var(--danger);
  background: var(--danger-soft);
  font-size: var(--fs-sm);
}
.wsv__issue[data-kind="warn"] { border-left-color: var(--warn); background: var(--surface-3); }
.wsv__issue-line {
  flex: 0 0 auto;
  padding: 1px 7px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-1);
  cursor: pointer;
}
.wsv__issue-line.is-muted { cursor: default; color: var(--fg-subtle); border-style: dashed; }
.wsv__issue-line:hover:not(.is-muted) { border-color: var(--accent); color: var(--accent); }
.wsv__issue-text { min-width: 0; }
.wsv__issue-code { margin-left: auto; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-subtle); }

.wsv__apierror { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-1); }
.wsv__apierror-msg { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--danger); }
.wsv__apierror-msg svg { width: 16px; height: 16px; flex: 0 0 auto; }

.wsv__log { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; font-family: var(--font-mono); font-size: var(--fs-xs); }
.wsv__log-row { display: flex; gap: var(--sp-1); padding: 2px 4px; border-radius: var(--r-1); }
.wsv__log-row[data-level="error"] { color: var(--danger); background: var(--danger-soft); }
.wsv__log-row[data-level="warn"] { color: var(--warn); }
.wsv__log-time { flex: 0 0 auto; color: var(--fg-subtle); }
.wsv__log-text { white-space: pre-wrap; word-break: break-word; }

.wsv__history { display: flex; flex-direction: column; gap: var(--sp-1); }
.wsv__history-lead { margin: 0; font-size: var(--fs-sm); color: var(--fg-muted); max-width: 72ch; }
.wsv__history-table td { vertical-align: top; }
.wsv__history-current { background: var(--accent-soft); }
.wsv__history-actions { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }

.wsv__overlay { z-index: 110; }
.wsv__dialog { display: flex; flex-direction: column; gap: var(--sp-1); }
.wsv__dialog-body { display: flex; flex-direction: column; gap: var(--sp-1); }
.wsv__dialog-h { display: flex; align-items: center; gap: 6px; font-size: var(--fs-base); margin-top: var(--sp-1); }
.wsv__dialog-h svg { width: 16px; height: 16px; color: var(--danger); }
.wsv__dialog-summary { margin: 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.wsv__dialog-foot { margin: 0; font-size: var(--fs-xs); color: var(--fg-subtle); }

.wsv__danger {
  padding: var(--sp-1);
  border: 1px solid var(--danger);
  border-radius: var(--r-2);
  background: var(--danger-soft);
}
.wsv__consequences { margin: 0; padding-left: var(--sp-3); font-size: var(--fs-sm); }
.wsv__consequences li { margin-bottom: var(--sp-05); }

.wsv__ack {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  margin-top: var(--sp-1);
  padding: var(--sp-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  font-size: var(--fs-sm);
  cursor: pointer;
}

@media (max-width: 860px) {
  .wsv__body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .wsv__side { border-right: 0; border-bottom: 1px solid var(--border); max-height: 34vh; }
  .wsv__note { display: none; }
}
`;
