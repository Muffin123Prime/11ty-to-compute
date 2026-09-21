/**
 * views/settings.js -- everything that changes how this installation behaves.
 *
 * The decisions behind this screen
 * --------------------------------
 * 1. **Dangerous settings look dangerous.** Encryption, LAN sharing and import
 *    are the three switches that can lose data or expose it. Each states its
 *    consequence before it is flipped, and each asks for a confirmation that
 *    names the specific loss ("Ohne die Passphrase sind die Daten endgültig
 *    verloren") rather than a generic "Bist du sicher?".
 * 2. **A secret is shown once, and the screen says so.** A newly created
 *    access token is displayed exactly one time, in a block that states
 *    plainly it will never be shown again, with a copy button. The server
 *    stores only a scrypt hash -- so if it is lost, it is lost, and this panel
 *    must not pretend otherwise.
 * 3. **Progress is honest.** Export and import are single server calls with no
 *    progress events behind them. This view therefore shows a running clock
 *    and what it is waiting for, never a percentage it would have to invent.
 * 4. **Diagnosis reports, it does not reassure.** "Doctor" is assembled from
 *    `/api/status`, `/api/models` and `/api/config`; every line says what is
 *    actually known and what is missing, including the failures the server
 *    recorded at boot. A green check that means "not checked" would be worse
 *    than no diagnosis at all.
 * 5. **Appearance applies immediately, and is stored on the server.** Theme
 *    goes through the shell's state (which owns `data-theme` on the root),
 *    density and reduced motion are applied here as root attributes and
 *    written to `config.ui`, so the choice survives a restart.
 */

import {
  h, text, clear, icon, timeAgo, formatDateTime, formatBytes, formatNumber, debounce,
} from '../lib/dom.js';

const STYLE_ID = 'nos-settings-view-style';
/** Global rules for density / reduced motion; separate so they survive unmount. */
const PREF_STYLE_ID = 'nos-ui-preferences';

const VIEW_ICON = '<path d="M2.8 6.4h5.4M13.2 6.4h4M2.8 13.6h3.4M11.2 13.6h6"/><circle cx="10.6" cy="6.4" r="2.2"/><circle cx="8.6" cy="13.6" r="2.2"/>';

const ICONS = {
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  info: '<circle cx="10" cy="10" r="7.4"/><path d="M10 9.2v4.4M10 6.5h.01"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  lock: '<rect x="4.4" y="8.6" width="11.2" height="8" rx="2.6"/><path d="M7 8.6V6.3a3 3 0 0 1 6 0v2.3"/>',
  unlock: '<rect x="4.4" y="8.6" width="11.2" height="8" rx="2.6"/><path d="M7 8.6V6.3a3 3 0 0 1 5.7-1.3"/>',
  copy: '<rect x="6.6" y="6.6" width="9" height="9" rx="2"/><path d="M13 4.4H6.2a1.8 1.8 0 0 0-1.8 1.8V13"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  download: '<path d="M10 3.4v9.2M6.2 9l3.8 3.8L13.8 9M4 16.2h12"/>',
  folder: '<path d="M3 6.4a1.6 1.6 0 0 1 1.6-1.6h2.9l1.6 2h6.3A1.6 1.6 0 0 1 17 8.4v6.2a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 14.6z"/>',
  eye: '<path d="M1.8 10S4.8 4.8 10 4.8 18.2 10 18.2 10 15.2 15.2 10 15.2 1.8 10 1.8 10Z"/><circle cx="10" cy="10" r="2.1"/>',
};

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
];

const DENSITIES = [
  { value: 'comfortable', label: 'Ruhig', hint: 'Mehr Weißraum, größere Klickflächen.' },
  { value: 'compact', label: 'Dicht', hint: 'Mehr Inhalt auf einem Bildschirm.' },
];

const TOKEN_PERMISSIONS = [
  { key: 'read', label: 'Lesen', hint: 'Notizen, Chats und den Graphen ansehen.' },
  { key: 'write', label: 'Schreiben', hint: 'Einträge anlegen, ändern und löschen.' },
  { key: 'chat', label: 'Chatten', hint: 'Mit dem Modell sprechen – verbraucht Rechenzeit auf diesem Gerät.' },
  { key: 'agents', label: 'Agenten', hint: 'Läufe starten und Bestätigungen beantworten.' },
  { key: 'sync', label: 'Abgleich', hint: 'Dieses Gerät als Partner für den Datenabgleich nutzen. Überträgt Notizen, Projekte, Aufgaben, Chats und Verknüpfungen – keine Token, Freigaben oder Agentenrechte.' },
];

const VAULT_STATE_LABEL = {
  unknown: 'Zustand unbekannt',
  disabled: 'Nicht verschlüsselt',
  locked: 'Verschlüsselt und gesperrt',
  unlocked: 'Verschlüsselt und entsperrt',
  unavailable: 'Verschlüsselung nicht verfügbar',
};

const TYPE_LABEL = {
  note: 'Notizen', chat: 'Chats', message: 'Nachrichten', project: 'Projekte',
  task: 'Aufgaben', agent: 'Agenten', run: 'Läufe', file: 'Dateien',
  entity: 'Begriffe', edge: 'Verknüpfungen', memory: 'Erinnerungen',
  approval: 'Bestätigungen', grant: 'Freigaben', token: 'Zugangstoken',
};

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

/** Apply density / reduced motion as root attributes plus one global rule. */
function applyUiPreferences({ density, reduceMotion }) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (density === 'compact') root.setAttribute('data-density', 'compact');
  else root.removeAttribute('data-density');
  if (reduceMotion) root.setAttribute('data-motion', 'reduce');
  else root.removeAttribute('data-motion');

  if (!document.getElementById(PREF_STYLE_ID)) {
    const node = document.createElement('style');
    node.id = PREF_STYLE_ID;
    node.textContent = PREF_CSS;
    document.head.appendChild(node);
  }
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'settings',
  title: 'Einstellungen',
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
      dom: {},

      status: null,
      statusError: null,
      config: null,
      configError: null,
      models: null,
      modelsError: null,
      remote: null,
      remoteError: null,
      remoteTests: new Map(), // id -> the last real test result, never a guess
      tokens: [],
      tokensError: null,
      watch: null,
      watchError: null,
      watchLogs: new Map(),  // id -> das echte Protokoll, oder der Fehler dabei
      watchScans: new Map(), // id -> das letzte echte Ergebnis, nie geraten
      watchOpen: new Set(),  // welche Protokolle aufgeklappt sind

      freshToken: null, // {token, record} -- shown exactly once
      busy: {},          // keyed flags for long-running buttons
    };
    view = self;

    buildLayout(self);
    subscribe(self);
    await Promise.all([loadStatus(self), loadConfig(self), loadModels(self), loadRemote(self), loadTokens(self), loadWatch(self)]);
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

function setBusy(self, key, value) {
  self.busy[key] = value;
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function loadStatus(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/status', { signal }));
    if (!self.alive) return;
    self.status = result;
    self.statusError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.status = null;
    self.statusError = err;
  }
}

async function loadConfig(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/config', { signal }));
    if (!self.alive) return;
    self.config = (result && result.config) || null;
    self.configError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.config = null;
    self.configError = err;
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
    self.modelsError = err;
  }
}

/**
 * The configured online backends.
 *
 * A 403 here is a real answer, not a failure: only the owner may see which
 * online providers exist, because the list is itself a statement about where
 * this installation is allowed to talk to.
 */
async function loadRemote(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/models/remote', { signal }));
    if (!self.alive) return;
    self.remote = result;
    self.remoteError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.remote = null;
    self.remoteError = err;
  }
}

async function loadTokens(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/tokens', { signal }));
    if (!self.alive) return;
    self.tokens = itemsOf(result);
    self.tokensError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.tokens = [];
    // 403 simply means "not the owner": that is an answer, not a breakdown.
    self.tokensError = err;
  }
}

/**
 * Die beobachteten Ordner.
 *
 * Wie bei den Online-Anbietern ist ein 403 hier eine Antwort und kein
 * Ausfall: nur die Eigentümerin darf einen Ordner anlegen oder einschalten,
 * denn ein Gast, der einen Pfad auf diesem Rechner freigeben kann, hat die
 * ganze Platte gelesen. Und ein 503 heißt, dass dieser Teil in dieser
 * Installation gar nicht eingerichtet ist -- das steht dann genau so da.
 */
async function loadWatch(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/watch', { signal }));
    if (!self.alive) return;
    self.watch = result;
    self.watchError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.watch = null;
    self.watchError = err;
  }
}

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;
  const refresh = debounce(() => {
    if (!self.alive) return;
    Promise.all([loadStatus(self), loadConfig(self)]).then(() => {
      if (!self.alive) return;
      renderVault(self);
      renderEncryption(self);
      renderSharing(self);
      renderDiagnosis(self);
    });
  }, 500);

  for (const name of ['vault.locked', 'vault.unlocked', 'vault.encrypted', 'config.changed']) {
    self.cleanups.push(ctx.bus.on(name, () => refresh()));
  }
  self.cleanups.push(ctx.bus.on('models.changed', () => {
    if (!self.alive) return;
    loadModels(self).then(() => {
      if (self.alive) {
        renderModels(self);
        renderDiagnosis(self);
      }
    });
  }));
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function section(title, description, body, extra = {}) {
  const head = h('div.card__head', null,
    h('h3', null, text(title)),
    h('span.spacer'),
    extra.action || null);
  return h('section.card.setv__card', { 'aria-label': title },
    head,
    h('div.card__body.stack', null,
      description ? h('p.meta.setv__desc', null, text(description)) : null,
      body));
}

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.appearance = h('div.stack');
  dom.vault = h('div.stack');
  dom.encryption = h('div.stack');
  dom.backup = h('div.stack');
  dom.watch = h('div.stack');
  dom.sharing = h('div.stack');
  dom.models = h('div.stack');
  dom.remote = h('div.stack');
  dom.diagnosis = h('div.stack');

  dom.refreshButton = h('button.btn.btn--small', {
    type: 'button',
    onClick: async () => {
      await Promise.all([loadStatus(self), loadConfig(self), loadModels(self), loadRemote(self), loadTokens(self), loadWatch(self)]);
      if (self.alive) renderAll(self);
    },
  }, icon(ICONS.refresh), text('Neu laden'));

  dom.root = h('div.setv', null,
    h('div.page.setv__page', null,
      h('header.page__head', null,
        h('div', null,
          h('h1.page__title', null, text('Einstellungen')),
          h('p.page__subtitle', null, text('Alles, was diese Installation ausmacht – und was passiert, wenn du es änderst.'))),
        h('div.page__actions', null, dom.refreshButton)),
      section('Darstellung', 'Gilt sofort und wird im Profil dieses Geräts gespeichert.', dom.appearance),
      section('Tresor', 'Wo deine Daten liegen und wie viel Platz sie brauchen.', dom.vault),
      section('Verschlüsselung', null, dom.encryption),
      section('Sicherung', null, dom.backup),
      section('Beobachtete Ordner',
        'Ein freigegebener Ordner wird gelesen, und was darin auftaucht, landet als Datei im Tresor. '
        + 'Gelesen wird nur \u2013 im Ordner selbst wird nichts gel\u00f6scht und nichts ge\u00e4ndert. '
        + 'Jeder Ordner hat einen Schalter, und unter \u201eWas wurde aufgenommen\u201c steht jede einzelne Datei.',
        dom.watch),
      section('Freigabe im lokalen Netz', null, dom.sharing),
      section('Modelle', 'Welche Modell-Backends gefunden wurden und welches als Vorgabe dient.', dom.models),
      section('Online-Modelle',
        'Ein Anbieter im Internet. Alles, was du an ihn schickst, verl\u00e4sst dieses Ger\u00e4t \u2013 deshalb bleibt er gesperrt, bis du den Host ausdr\u00fccklich freigibst.',
        dom.remote),
      section('Diagnose', 'Was dieses System über sich selbst weiß. Nichts hier ist geraten.', dom.diagnosis)));

  container.appendChild(dom.root);
  buildBackupHinweis(self);
}

/**
 * Nur noch ein Verweis. Die Bedienung liegt seit dieser Fassung im eigenen
 * Bereich „Sicherung".
 *
 * Warum hier ueberhaupt noch etwas steht: wer eine Sicherung sucht, sucht sie
 * erfahrungsgemaess in den Einstellungen. Ein leerer Abschnitt wuerde diesen
 * Menschen ratlos zuruecklassen. Was hier NICHT steht, sind Knoepfe -- eine
 * zweite Bedienung fuer dieselbe Sache waere genau die Art von Halbheit, bei
 * der eine der beiden Stellen irgendwann etwas anderes behauptet als die andere.
 */
function buildBackupHinweis(self) {
  const box = self.dom.backup;
  clear(box);
  box.appendChild(h('p', null, text(
    'Den Wissensstand sichern und wiederherstellen hat einen eigenen Bereich: '
    + '„Sicherung" in der Seitenleiste. Dort steht, wann zuletzt gesichert wurde, wohin, '
    + 'wie groß und wie viele Sätze – und dort wird auch zurückgespielt.')));
  box.appendChild(h('div.row', null,
    h('button.btn.btn--small', {
      type: 'button',
      onClick: () => self.ctx.navigate('/backup'),
    }, text('Zum Bereich „Sicherung“')),
    h('span.hint', null, text('Tastatur: g, dann b.'))));
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll(self) {
  renderAppearance(self);
  renderVault(self);
  renderEncryption(self);
  renderWatch(self);
  renderSharing(self);
  renderModels(self);
  renderRemote(self);
  renderDiagnosis(self);
}

function uiConfig(self) {
  const ui = (self.config && self.config.ui) || {};
  return {
    theme: typeof ui.theme === 'string' ? ui.theme : 'system',
    density: ui.density === 'compact' ? 'compact' : 'comfortable',
    reduceMotion: ui.reduceMotion === true,
    locale: typeof ui.locale === 'string' ? ui.locale : 'de',
  };
}

function renderAppearance(self) {
  const box = self.dom.appearance;
  clear(box);
  const ui = uiConfig(self);
  const activeTheme = (self.ctx.state && self.ctx.state.get('theme')) || ui.theme;

  // Apply what the config says as soon as the panel knows it: the shell owns
  // the theme, but density and motion have no other home. Without a config
  // nothing is applied -- resetting someone's density because the server is
  // briefly unreachable would be a guess with visible consequences.
  if (self.config) applyUiPreferences({ density: ui.density, reduceMotion: ui.reduceMotion });

  const themeGroup = h('div.segmented', { role: 'group', 'aria-label': 'Design' });
  for (const option of THEMES) {
    const button = h('button.segmented__option', {
      type: 'button',
      onClick: () => setTheme(self, option.value),
    }, text(option.label));
    button.classList.toggle('is-active', option.value === activeTheme);
    themeGroup.appendChild(button);
  }

  const densityGroup = h('div.segmented', { role: 'group', 'aria-label': 'Dichte' });
  for (const option of DENSITIES) {
    const button = h('button.segmented__option', {
      type: 'button',
      title: option.hint,
      onClick: () => setUi(self, { density: option.value }),
    }, text(option.label));
    button.classList.toggle('is-active', option.value === ui.density);
    densityGroup.appendChild(button);
  }

  const motionBox = h('input', {
    type: 'checkbox',
    checked: ui.reduceMotion,
    onChange: (event) => setUi(self, { reduceMotion: event.target.checked === true }),
  });

  const localeSelect = h('select.select', {
    'aria-label': 'Sprache',
    onChange: (event) => setUi(self, { locale: event.target.value }),
  }, h('option', { value: 'de' }, text('Deutsch')));
  localeSelect.value = 'de';

  box.appendChild(h('div.setv__grid', null,
    h('div.field', null, h('span.label', null, text('Design')), themeGroup,
      h('span.hint', null, text('„System“ folgt der Einstellung des Betriebssystems.'))),
    h('div.field', null, h('span.label', null, text('Dichte')), densityGroup,
      h('span.hint', null, text('Ändert Abstände und Zeilenhöhen der gesamten Oberfläche.'))),
    h('div.field', null, h('span.label', null, text('Sprache')), localeSelect,
      h('span.hint', null, text('Diese Ausgabe spricht ausschließlich Deutsch. Weitere Sprachen sind nicht eingebaut – die Auswahl täuscht keine vor.')))));

  box.appendChild(h('label.setv__switch', null,
    h('span.setv__switch-box', null, motionBox),
    h('span.setv__switch-body', null,
      h('span.setv__switch-label', null, text('Bewegung reduzieren')),
      h('span.setv__switch-hint', null, text('Schaltet Übergänge und Animationen ab. Die Systemeinstellung „Bewegung reduzieren“ wird ohnehin immer beachtet.')))));

  if (ui.theme !== activeTheme) {
    box.appendChild(h('p.meta', null, text(`Gespeichert ist „${labelOfTheme(ui.theme)}“; in diesem Fenster ist gerade „${labelOfTheme(activeTheme)}“ eingestellt.`)));
  }
}

function labelOfTheme(value) {
  const found = THEMES.find((t) => t.value === value);
  return found ? found.label : value;
}

function renderVault(self) {
  const box = self.dom.vault;
  clear(box);
  const status = self.status;
  const vault = (status && status.vault) || null;

  box.appendChild(h('div.setv__pathrow', null,
    h('span.label', null, text('Speicherort')),
    h('code.code.setv__path', null, text(status && status.home ? status.home : 'unbekannt')),
    h('button.btn.btn--small', {
      type: 'button',
      onClick: () => copyText(self, status && status.home ? status.home : ''),
    }, icon(ICONS.copy), text('Pfad kopieren'))));
  box.appendChild(h('p.hint', null, text('Alles, was dieses Programm besitzt, liegt in diesem einen Ordner: Konfiguration, Tresor, Protokolle, Exporte. Er lässt sich sichern, verschlüsseln oder löschen, ohne dass irgendwo sonst Reste bleiben.')));

  if (!vault) {
    box.appendChild(h('p.is-danger', null, text('Der Zustand des Tresors ist nicht abrufbar.')));
    return;
  }

  const stats = h('dl.setv__stats');
  const add = (label, value) => {
    stats.appendChild(h('div.setv__stat', null,
      h('dt', null, text(label)),
      h('dd', null, text(value))));
  };
  add('Einträge', vault.records === null || vault.records === undefined ? 'unbekannt' : formatNumber(vault.records));
  add('Größe auf der Platte', vault.bytes === null || vault.bytes === undefined ? 'unbekannt' : formatBytes(vault.bytes));
  add('Log-Segmente', vault.logSegments === null || vault.logSegments === undefined ? 'unbekannt' : formatNumber(vault.logSegments));
  add('Letzte Schreibung', vault.lastWrite ? timeAgo(vault.lastWrite) : 'noch keine');
  box.appendChild(stats);

  const counts = vault.counts && typeof vault.counts === 'object' ? vault.counts : {};
  const entries = Object.entries(counts).filter(([, value]) => Number(value) > 0);
  if (entries.length) {
    const chips = h('div.row');
    for (const [type, count] of entries.sort((a, b) => b[1] - a[1])) {
      chips.appendChild(h('span.badge', null, text(`${TYPE_LABEL[type] || type}: ${formatNumber(count)}`)));
    }
    box.appendChild(chips);
  }

  if (vault.recovery && (vault.recovery.dropped || vault.recovery.recovered)) {
    box.appendChild(h('p.setv__warn', null, text(
      `Beim Öffnen wurden ${formatNumber(vault.recovery.recovered || 0)} Zeilen nachgespielt und ${formatNumber(vault.recovery.dropped || 0)} unlesbare Zeile(n) verworfen. `
      + 'Das passiert, wenn der Rechner mitten im Schreiben ausgeht; der Rest des Tresors ist davon nicht betroffen.',
    )));
  }

  box.appendChild(h('div.row', null,
    h('button.btn.btn--small', {
      type: 'button',
      disabled: self.busy.compact === true,
      onClick: () => compactVault(self),
    }, text(self.busy.compact ? 'Wird verdichtet …' : 'Jetzt verdichten')),
    h('span.hint', null, text('Verdichten schreibt einen frischen Schnappschuss und kürzt das Änderungsprotokoll. Es ändert keine Inhalte, macht das Öffnen aber schneller und die Dateien kleiner.'))));
}

function renderEncryption(self) {
  const box = self.dom.encryption;
  clear(box);

  // Without a status there is no honest answer here. "Nicht verschlüsselt"
  // would be a guess about the user's data, which is exactly the kind of
  // comfortable claim this application must not make.
  if (!self.status) {
    box.appendChild(h('div.row', null,
      h('span.badge.setv__state', { dataset: { state: 'unknown' } }, text('Zustand unbekannt'))));
    box.appendChild(h('p.is-danger', null, text(self.statusError
      ? `Der Server antwortet nicht, daher ist unbekannt, ob dieser Tresor verschlüsselt ist: ${errorMessage(self.statusError)}`
      : 'Der Server antwortet nicht, daher ist unbekannt, ob dieser Tresor verschlüsselt ist.')));
    return;
  }

  const vault = self.status.vault || null;
  const state = vault ? (vault.state || 'disabled') : 'unavailable';

  box.appendChild(h('div.row', null,
    h('span.badge.setv__state', { dataset: { state } }, text(VAULT_STATE_LABEL[state] || state))));

  if (state === 'unavailable') {
    box.appendChild(h('p.is-danger', null, text('Die Verschlüsselung ist in dieser Installation nicht verfügbar.')));
    return;
  }

  if (state === 'disabled') {
    const pass1 = h('input.input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Passphrase' });
    const pass2 = h('input.input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Passphrase wiederholen' });
    box.appendChild(h('div.setv__danger', null,
      h('p.setv__danger-title', null, icon(ICONS.alert), text('Passphrase-Verlust bedeutet Datenverlust')),
      h('p', null, text('Die Passphrase wird nirgendwo gespeichert – weder hier noch auf einem Server. Ohne sie sind die Notizen, Chats und Dateien in diesem Tresor endgültig verloren. Es gibt keine Wiederherstellung, keine Hintertür und keinen Support, der helfen könnte. Lege vor dem Einschalten eine Sicherung an und bewahre die Passphrase getrennt auf.'))));
    box.appendChild(h('div.setv__grid', null,
      h('label.field', null, h('span.label', null, text('Passphrase (mindestens 8 Zeichen)')), pass1),
      h('label.field', null, h('span.label', null, text('Passphrase wiederholen')), pass2)));
    box.appendChild(h('div.row', null,
      h('button.btn.btn--danger', {
        type: 'button',
        disabled: self.busy.encrypt === true,
        onClick: () => enableEncryption(self, pass1, pass2),
      }, icon(ICONS.lock), text(self.busy.encrypt ? 'Wird verschlüsselt …' : 'Verschlüsselung einschalten')),
      h('span.hint', null, text('Beim Einschalten werden die vorhandenen Daten neu geschrieben. Das kann bei großen Tresoren einen Moment dauern.'))));
    return;
  }

  if (state === 'locked') {
    const pass = h('input.input', {
      type: 'password',
      autocomplete: 'current-password',
      'aria-label': 'Passphrase',
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          unlockVault(self, pass);
        }
      },
    });
    box.appendChild(h('p', null, text('Der Tresor ist gesperrt. Bis er entsperrt ist, können Notizen, Chats und Aufgaben weder gelesen noch geschrieben werden.')));
    box.appendChild(h('label.field', null, h('span.label', null, text('Passphrase')), pass));
    box.appendChild(h('div.row', null,
      h('button.btn.btn--primary', {
        type: 'button',
        disabled: self.busy.unlock === true,
        onClick: () => unlockVault(self, pass),
      }, icon(ICONS.unlock), text(self.busy.unlock ? 'Wird entsperrt …' : 'Entsperren'))));
    return;
  }

  box.appendChild(h('p', null, text('Der Tresor ist verschlüsselt und derzeit entsperrt. Jede Zeile des Änderungsprotokolls und der Schnappschuss liegen mit AES-256-GCM verschlüsselt auf der Platte.')));
  box.appendChild(h('div.row', null,
    h('button.btn', {
      type: 'button',
      disabled: self.busy.lock === true,
      onClick: () => lockVault(self),
    }, icon(ICONS.lock), text('Jetzt sperren')),
    h('span.hint', null, text('Nach dem Sperren wird der Schlüssel im Speicher überschrieben. Zum Weiterarbeiten ist die Passphrase wieder nötig.'))));
}

function renderSharing(self) {
  const box = self.dom.sharing;
  clear(box);

  if (!self.config) {
    box.appendChild(h('div.setv__danger', { dataset: { tone: 'off' } },
      h('p.setv__danger-title', null, icon(ICONS.alert), text(' Zustand unbekannt')),
      h('p', null, text(self.configError
        ? `Die Konfiguration ist nicht lesbar, daher lässt sich nicht sagen, ob die Freigabe an ist: ${errorMessage(self.configError)}`
        : 'Die Konfiguration ist nicht lesbar, daher lässt sich nicht sagen, ob die Freigabe an ist.'))));
    return;
  }

  const security = self.config.security || {};
  const sharing = security.sharing || {};
  const enabled = sharing.enabled === true;
  const server = self.config.server || {};

  box.appendChild(h('div.setv__danger', { dataset: { tone: enabled ? 'on' : 'off' } },
    h('p.setv__danger-title', null,
      icon(enabled ? ICONS.alert : ICONS.check),
      text(enabled ? ' Die Freigabe ist eingeschaltet' : ' Die Freigabe ist ausgeschaltet')),
    h('p', null, text(enabled
      ? 'Andere Geräte können diese Oberfläche erreichen, sofern sie ein gültiges Token haben. Jeder Zugriff wird protokolliert.'
      : 'Nur dieses Gerät kann Neural OS erreichen. Das ist die Voreinstellung und der sichere Zustand.'))));

  const toggle = h('input', {
    type: 'checkbox',
    checked: enabled,
    onChange: (event) => toggleSharing(self, event.target.checked === true, event.target),
  });
  box.appendChild(h('label.setv__switch', null,
    h('span.setv__switch-box', null, toggle),
    h('span.setv__switch-body', null,
      h('span.setv__switch-label', null, text('Freigabe im lokalen Netz erlauben')),
      h('span.setv__switch-hint', null, text('Beim Einschalten bleibt die Token-Pflicht immer aktiv: ohne Token kommt kein fremdes Gerät herein.')))));

  box.appendChild(h('p.meta', null, text(
    `Der Server hört derzeit auf ${server.host || 'unbekannt'}:${server.port || '?'}. `
    + (String(server.host || '').startsWith('127.') || server.host === '::1' || server.host === 'localhost'
      ? 'Damit ist er ausschließlich von diesem Gerät erreichbar.'
      : 'Damit ist er auch von anderen Geräten erreichbar.'),
  )));

  if (enabled) {
    const hostSelect = h('select.select', {
      'aria-label': 'Adresse, auf der der Server hört',
      onChange: (event) => setBindHost(self, event.target.value),
    },
    h('option', { value: '127.0.0.1' }, text('127.0.0.1 – nur dieses Gerät')),
    h('option', { value: '0.0.0.0' }, text('0.0.0.0 – alle Netzwerkkarten')));
    hostSelect.value = server.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
    box.appendChild(h('label.field', null,
      h('span.label', null, text('Adresse, auf der der Server hört')),
      hostSelect,
      h('span.hint', null, text('Diese Änderung wird erst nach einem Neustart von Neural OS wirksam.'))));
  }

  /* ------------------------------ tokens ---------------------------- */

  if (self.freshToken) {
    const value = String(self.freshToken.token || '');
    const field = h('input.input.setv__tokenvalue', { type: 'text', value, readonly: true, spellcheck: 'false' });
    box.appendChild(h('div.setv__token-new', { role: 'alert' },
      h('p.setv__danger-title', null, icon(ICONS.alert), text(' Dieses Token wird genau einmal angezeigt')),
      h('p', null, text('Der Server speichert nur einen Hash davon. Wenn du es jetzt nicht sicherst, musst du ein neues anlegen.')),
      field,
      h('div.row', null,
        h('button.btn.btn--primary.btn--small', {
          type: 'button',
          onClick: () => {
            field.select();
            copyText(self, value);
          },
        }, icon(ICONS.copy), text('Kopieren')),
        h('button.btn.btn--small', {
          type: 'button',
          onClick: () => {
            self.freshToken = null;
            renderSharing(self);
          },
        }, text('Gesichert – ausblenden')))));
  }

  const tokenList = h('div.setv__tokens');
  if (self.tokensError) {
    tokenList.appendChild(h('p.meta', null, text(`Die Tokenliste ist nicht abrufbar: ${errorMessage(self.tokensError)}`)));
  } else if (!self.tokens.length) {
    tokenList.appendChild(h('p.meta', null, text('Es ist kein Zugangstoken angelegt.')));
  } else {
    for (const token of self.tokens) {
      const permissions = token.permissions || {};
      const granted = TOKEN_PERMISSIONS.filter((p) => permissions[p.key] === true).map((p) => p.label);
      tokenList.appendChild(h('article.setv__token', { dataset: { active: token.active === false ? '0' : '1' } },
        h('div.setv__token-main', null,
          h('div.row', null,
            h('strong', null, text(String(token.label || 'Ohne Bezeichnung'))),
            token.active === false ? h('span.badge.badge--danger', null, text(token.inactiveReason || 'nicht nutzbar')) : null),
          h('p.meta', null, text([
            granted.length ? `Darf: ${granted.join(', ')}` : 'Darf nichts – alle Rechte abgewählt',
            token.expiresAt ? `läuft ab ${formatDateTime(token.expiresAt)}` : 'ohne Ablauf',
            token.lastUsedAt ? `zuletzt benutzt ${timeAgo(token.lastUsedAt)}` : 'noch nie benutzt',
          ].join(' · ')))),
        token.revoked === true
          ? h('span.meta', null, text('widerrufen'))
          : h('button.btn.btn--small', {
            type: 'button',
            onClick: () => revokeToken(self, token.id, token.label),
          }, icon(ICONS.trash), text('Zugriff entziehen'))));
    }
  }
  box.appendChild(tokenList);

  const label = h('input.input', { type: 'text', placeholder: 'z. B. Telefon im Wohnzimmer', 'aria-label': 'Bezeichnung des Tokens' });
  const permissionBoxes = new Map();
  const permissionRow = h('div.setv__permrow');
  for (const permission of TOKEN_PERMISSIONS) {
    const input = h('input', { type: 'checkbox', checked: permission.key === 'read' });
    permissionBoxes.set(permission.key, input);
    permissionRow.appendChild(h('label.setv__perm', { title: permission.hint },
      input, h('span', null, text(permission.label))));
  }
  const days = h('input.input', { type: 'number', min: '1', max: '3650', placeholder: 'ohne Ablauf', 'aria-label': 'Gültig für Tage' });

  box.appendChild(h('details.setv__newtoken', null,
    h('summary', null, text('Neues Zugangstoken anlegen')),
    h('div.stack.setv__newtoken-body', null,
      h('label.field', null, h('span.label', null, text('Bezeichnung')), label),
      h('div.field', null, h('span.label', null, text('Berechtigungen dieses Tokens')), permissionRow),
      h('label.field', null, h('span.label', null, text('Gültig für (Tage, optional)')), days),
      h('div.row', null,
        h('button.btn.btn--primary.btn--small', {
          type: 'button',
          disabled: self.busy.token === true,
          onClick: () => createToken(self, label, permissionBoxes, days),
        }, text('Token erzeugen')),
        h('span.hint', null, text('Das Token erscheint danach genau einmal.'))))));
}

function renderModels(self) {
  const box = self.dom.models;
  clear(box);

  const snapshot = self.models;
  const providers = (snapshot && Array.isArray(snapshot.providers)) ? snapshot.providers : [];

  box.appendChild(h('div.row', null,
    h('button.btn.btn--small', {
      type: 'button',
      disabled: self.busy.models === true,
      onClick: () => refreshModels(self),
    }, icon(ICONS.refresh), text(self.busy.models ? 'Wird gesucht …' : 'Erneut suchen')),
    h('span.meta', null, text(snapshot && snapshot.at
      ? `Zuletzt gesucht ${timeAgo(snapshot.at)}.`
      : 'Es wurde in dieser Sitzung noch nicht gesucht.'))));

  if (self.modelsError) {
    box.appendChild(h('p.is-danger', null, text(`Die Modellverwaltung antwortet nicht: ${errorMessage(self.modelsError)}`)));
    return;
  }

  if (!providers.length) {
    box.appendChild(h('p.meta', null, text('Es ist kein Modell-Backend eingetragen.')));
  }

  for (const provider of providers) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    const card = h('article.setv__provider', { dataset: { available: provider.available ? '1' : '0' } },
      h('div.row', null,
        h('span.setv__provider-dot', { 'aria-hidden': 'true' }),
        h('strong', null, text(String(provider.id || provider.kind || 'Backend'))),
        h('code.meta', null, text(String(provider.baseUrl || ''))),
        h('span.spacer'),
        h('span.meta', null, text(provider.available
          ? `erreichbar${Number.isFinite(provider.latencyMs) ? ` · ${formatNumber(provider.latencyMs)} ms` : ''}`
          : 'nicht erreichbar'))),
      provider.error ? h('p.meta.is-danger', null, text(String(provider.error))) : null,
      models.length
        ? h('div.row.setv__modellist', null, ...models.slice(0, 40).map((model) => {
          const id = typeof model === 'string' ? model : (model && model.id);
          const name = typeof model === 'string' ? model : (model && (model.name || model.id));
          return h('span.badge', { title: id ? String(id) : '' }, text(String(name || id || '')));
        }))
        : h('p.meta', null, text(provider.available ? 'Erreichbar, aber ohne Modell.' : 'Keine Modelle gelesen.')));
    box.appendChild(card);
  }

  if (snapshot && snapshot.available === false && snapshot.hint) {
    box.appendChild(h('div.setv__hintbox', null, text(String(snapshot.hint))));
  }

  /* --------------------------- default model ------------------------ */

  const configDefault = (self.config && self.config.models && self.config.models.default) || null;
  const select = h('select.select', {
    'aria-label': 'Standardmodell',
    onChange: (event) => setDefaultModel(self, event.target.value),
  }, h('option', { value: '' }, text('Automatisch: erstes erreichbares Modell')));

  for (const provider of providers) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (!models.length) continue;
    const group = h('optgroup', { label: `${provider.id}${provider.available ? '' : ' (nicht erreichbar)'}` });
    for (const model of models) {
      const id = typeof model === 'string' ? model : (model && model.id);
      if (!id) continue;
      group.appendChild(h('option', { value: `${provider.id}/${id}` }, text(String(id))));
    }
    select.appendChild(group);
  }

  const currentValue = configDefault && configDefault.model
    ? `${configDefault.provider || ''}/${configDefault.model}`
    : '';
  const hasOption = Array.from(select.options).some((option) => option.value === currentValue);
  if (currentValue && !hasOption) {
    select.appendChild(h('option', { value: currentValue }, text(`${currentValue} (derzeit nicht gefunden)`)));
  }
  select.value = currentValue;

  box.appendChild(h('label.field', null,
    h('span.label', null, text('Standardmodell für neue Chats')),
    select,
    h('span.hint', null, text('Ein Agent oder ein Chat kann davon abweichen. Ist das gewählte Modell nicht erreichbar, meldet das System das – es weicht nicht stillschweigend aus.'))));
}

/* ------------------------------------------------------------------ */
/* Online-Modelle                                                      */
/* ------------------------------------------------------------------ */

/**
 * The one screen in this app where a person deliberately opens a door.
 *
 * Three things are therefore never softened:
 *
 * 1. **A provider that exists is not a provider that may be reached.** Every
 *    entry shows the gate's current verdict for its host, so "angelegt" and
 *    "erlaubt" can never be confused. The server computes that verdict from
 *    policy alone -- looking at this list does not touch the network.
 * 2. **Where the key lives is stated, not implied.** `keySource` comes from
 *    the server: `env` (nowhere on disk), `config` (plain text in config.json),
 *    `env-missing` (a variable was named and is empty -- the case that
 *    otherwise looks like a mysterious 401).
 * 3. **"Testen" really connects.** It is the only honest answer to "geht das?",
 *    and its result distinguishes a gate refusal (a decision the user made)
 *    from an unreachable server (something broken).
 */
function renderRemote(self) {
  const box = self.dom.remote;
  clear(box);

  if (self.remoteError) {
    const denied = self.remoteError && self.remoteError.status === 403;
    box.appendChild(h('p.meta', { class: denied ? 'meta' : 'is-danger' }, text(denied
      ? 'Nur die Eigentümerin oder der Eigentümer dieser Installation darf Online-Anbieter sehen und ändern.'
      : `Die Liste der Online-Anbieter ist nicht lesbar: ${errorMessage(self.remoteError)}`)));
    return;
  }

  const data = self.remote || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const mode = typeof data.mode === 'string' ? data.mode : 'offline';

  box.appendChild(h('div.setv__netmode', { dataset: { mode } },
    h('span.setv__provider-dot', { 'aria-hidden': 'true' }),
    h('span', null, text(mode === 'offline'
      ? 'Netzmodus: offline. Kein Online-Anbieter ist erreichbar, egal was hier steht.'
      : `Netzmodus: ${mode}. Freigegebene Hosts sind erreichbar.`))));

  if (!items.length) {
    box.appendChild(h('p.meta', null, text(
      'Es ist kein Online-Anbieter eingetragen. Ohne einen läuft alles ausschließlich auf diesem Gerät.')));
  }

  for (const item of items) {
    box.appendChild(remoteCard(self, item));
  }

  box.appendChild(remoteForm(self, data));

  box.appendChild(h('p.hint', null, text(String(data.advice
    || 'Ein Schlüssel in einer Umgebungsvariable steht in keiner Datei.'))));
}

function keySourceLabel(item) {
  if (item.keySource === 'env') return `Schlüssel aus der Umgebungsvariable ${item.apiKeyEnv}`;
  if (item.keySource === 'env-missing') return `Die Umgebungsvariable ${item.apiKeyEnv} ist in diesem Prozess leer`;
  if (item.keySource === 'config') return 'Schlüssel liegt im Klartext in config.json';
  return 'Kein Schlüssel hinterlegt';
}

function remoteCard(self, item) {
  const allowed = item.gate && item.gate.allowed === true;
  const testResult = self.remoteTests.get(item.id) || null;
  const busyKey = `remote:${item.id}`;

  const gateLine = h('p.meta', {
    class: allowed ? 'meta' : 'meta is-warn',
  }, text(allowed
    ? `Der Host ${item.host} ist freigegeben.`
    : `Der Host ${item.host} ist gesperrt. ${(item.gate && item.gate.reason) || ''}`.trim()));

  const actions = h('div.row', null,
    h('button.btn.btn--small', {
      type: 'button',
      disabled: self.busy[busyKey] === true,
      onClick: () => testRemote(self, item),
    }, icon(ICONS.refresh), text(self.busy[busyKey] ? 'Wird geprüft …' : 'Verbindung testen')),
    allowed ? null : h('button.btn.btn--small', {
      type: 'button',
      onClick: () => allowRemoteHost(self, item),
    }, text('Host freigeben')),
    h('span.spacer'),
    h('button.btn.btn--small.btn--danger', {
      type: 'button',
      onClick: () => removeRemote(self, item),
    }, icon(ICONS.trash), text('Entfernen')));

  let resultLine = null;
  if (testResult) {
    if (testResult.ok) {
      const names = Array.isArray(testResult.models) ? testResult.models : [];
      resultLine = h('div.setv__hintbox', null, text(
        `Erreichbar${Number.isFinite(testResult.latencyMs) ? ` in ${formatNumber(testResult.latencyMs)} ms` : ''}. `
        + (names.length ? `Gefundene Modelle: ${names.slice(0, 12).join(', ')}` : 'Der Anbieter hat keine Modellliste geliefert.')));
    } else {
      resultLine = h('div.setv__hintbox', { dataset: { level: testResult.blocked ? 'blocked' : 'fail' } },
        h('p', null, text(testResult.blocked
          ? 'Die Netz-Schleuse hat den Versuch verhindert – das ist deine eigene Einstellung, kein Fehler.'
          : 'Der Anbieter war nicht erreichbar.')),
        testResult.error ? h('p.meta', null, text(String(testResult.error))) : null,
        testResult.hint ? h('p.meta', null, text(String(testResult.hint))) : null);
    }
  }

  return h('article.setv__provider', { dataset: { available: allowed ? '1' : '0' } },
    h('div.row', null,
      h('span.setv__provider-dot', { 'aria-hidden': 'true' }),
      h('strong', null, text(String(item.label || item.id))),
      h('code.meta', null, text(String(item.baseUrl || ''))),
      h('span.spacer'),
      h('span.badge', null, text(item.enabled ? 'aktiv' : 'deaktiviert'))),
    gateLine,
    h('p.meta', null, text(keySourceLabel(item))),
    resultLine,
    actions);
}

/**
 * The add form.
 *
 * Presets exist so nobody has to know that Groq's base URL ends in
 * `/openai/v1`. They are constants shipped with the app -- fetching a provider
 * directory would itself be an unannounced online access.
 */
function remoteForm(self, data) {
  const presets = Array.isArray(data.presets) ? data.presets : [];

  const idField = h('input.input', { type: 'text', placeholder: 'z. B. openai', autocomplete: 'off', spellcheck: 'false' });
  const labelField = h('input.input', { type: 'text', placeholder: 'Anzeigename', autocomplete: 'off' });
  const urlField = h('input.input', { type: 'text', placeholder: 'https://…/v1', autocomplete: 'off', spellcheck: 'false' });
  const envField = h('input.input', { type: 'text', placeholder: 'OPENAI_API_KEY', autocomplete: 'off', spellcheck: 'false' });
  const keyField = h('input.input', { type: 'password', placeholder: 'nur wenn keine Umgebungsvariable', autocomplete: 'new-password' });
  const allowBox = h('input', { type: 'checkbox' });
  const noteLine = h('p.hint', null, text('Wähle eine Vorlage oder trage die Adresse selbst ein.'));

  const presetSelect = h('select.select', {
    'aria-label': 'Vorlage',
    onChange: (event) => {
      const preset = presets.find((p) => p.id === event.target.value);
      if (!preset) return;
      idField.value = preset.id;
      labelField.value = preset.label;
      urlField.value = preset.baseUrl;
      envField.value = preset.apiKeyEnv || '';
      clear(noteLine);
      noteLine.appendChild(text(String(preset.note || '')));
    },
  }, h('option', { value: '' }, text('Eigener Anbieter …')));
  for (const preset of presets) {
    presetSelect.appendChild(h('option', { value: preset.id }, text(preset.label)));
  }

  return h('details.setv__newtoken', null,
    h('summary', null, text('Online-Anbieter hinzufügen')),
    h('div.setv__newtoken-body.stack', null,
      h('label.field', null, h('span.label', null, text('Vorlage')), presetSelect),
      noteLine,
      h('label.field', null, h('span.label', null, text('Kennung')), idField,
        h('span.hint', null, text('Kurz und eindeutig. Erscheint später vor dem Modellnamen.'))),
      h('label.field', null, h('span.label', null, text('Anzeigename')), labelField),
      h('label.field', null, h('span.label', null, text('Adresse')), urlField),
      h('label.field', null, h('span.label', null, text('Umgebungsvariable mit dem Schlüssel')), envField,
        h('span.hint', null, text('Empfohlen: der Schlüssel steht dann in keiner Datei dieses Programms.'))),
      h('label.field', null, h('span.label', null, text('… oder Schlüssel direkt eintragen')), keyField,
        h('span.hint', null, text('Er liegt dann im Klartext in config.json. Nur eins von beidem ausfüllen.'))),
      h('label.setv__perm', null, allowBox,
        text('Den Host sofort in der Netz-Schleuse freigeben')),
      h('div.row', null,
        h('button.btn.btn--primary.btn--small', {
          type: 'button',
          disabled: self.busy.remoteAdd === true,
          onClick: () => addRemote(self, {
            id: idField.value.trim(),
            label: labelField.value.trim(),
            baseUrl: urlField.value.trim(),
            apiKeyEnv: envField.value.trim(),
            apiKey: keyField.value,
            allowHost: allowBox.checked,
          }),
        }, text(self.busy.remoteAdd ? 'Wird angelegt …' : 'Anbieter anlegen')),
        h('span.hint', null, text('Anlegen allein schickt noch nichts los.')))));
}

async function addRemote(self, input) {
  if (!input.id || !input.baseUrl) {
    self.ctx.toast('Kennung und Adresse werden gebraucht.', 'error');
    return;
  }
  const body = { id: input.id, baseUrl: input.baseUrl, allowHost: input.allowHost === true };
  if (input.label) body.label = input.label;
  if (input.apiKeyEnv) body.apiKeyEnv = input.apiKeyEnv;
  else if (input.apiKey) body.apiKey = input.apiKey;

  setBusy(self, 'remoteAdd', true);
  renderRemote(self);
  try {
    const result = await request(self, (signal) => self.api.post('/models/remote', body, { signal }));
    if (!self.alive) return;
    self.ctx.toast(result && result.grant
      ? 'Anbieter angelegt und Host freigegeben.'
      : 'Anbieter angelegt. Der Host ist noch gesperrt.', 'success');
    if (result && result.keyWarning) self.ctx.toast(String(result.keyWarning), 'info');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Nicht angelegt: ${errorMessage(err)}`, 'error');
  } finally {
    setBusy(self, 'remoteAdd', false);
    await loadRemote(self);
    if (self.alive) renderRemote(self);
  }
}

async function removeRemote(self, item) {
  const ok = await self.ctx.confirm({
    title: 'Anbieter entfernen?',
    message: `„${item.label || item.id}“ wird aus der Konfiguration gelöscht. Chats, die ihn benutzt haben, bleiben erhalten.`,
    confirmLabel: 'Entfernen',
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await request(self, (signal) => self.api.del(`/models/remote/${encodeURIComponent(item.id)}`, { signal }));
    if (!self.alive) return;
    self.remoteTests.delete(item.id);
    self.ctx.toast('Anbieter entfernt.', 'success');
    if (result && result.note) self.ctx.toast(String(result.note), 'info');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Nicht entfernt: ${errorMessage(err)}`, 'error');
  } finally {
    await loadRemote(self);
    if (self.alive) renderRemote(self);
  }
}

async function testRemote(self, item) {
  const busyKey = `remote:${item.id}`;
  setBusy(self, busyKey, true);
  renderRemote(self);
  try {
    const result = await request(self, (signal) => self.api.post(`/models/remote/${encodeURIComponent(item.id)}/test`, {}, { signal }));
    if (!self.alive) return;
    self.remoteTests.set(item.id, result);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    // A failed request is itself a result -- shown as one, not swallowed.
    self.remoteTests.set(item.id, { ok: false, blocked: false, error: errorMessage(err), hint: null });
  } finally {
    setBusy(self, busyKey, false);
    if (self.alive) renderRemote(self);
  }
}

/**
 * Open the gate for one host, permanently, at global scope.
 *
 * Deliberately a separate button rather than part of "anlegen": the two are
 * different decisions, and the audit log should show them as two entries.
 */
async function allowRemoteHost(self, item) {
  if (!item.host) return;
  const ok = await self.ctx.confirm({
    title: `${item.host} freigeben?`,
    message: 'Ab dann darf dieses Programm diesen Host erreichen – für Modellanfragen und für alles andere, '
      + 'was denselben Geltungsbereich nutzt. Unter „Netzwerk“ kannst du die Freigabe jederzeit zurücknehmen '
      + 'und dort siehst du auch jeden einzelnen Zugriff.',
    confirmLabel: 'Freigeben',
  });
  if (!ok) return;
  try {
    await request(self, (signal) => self.api.post('/network/grants', {
      scope: 'global',
      level: item.gate && item.gate.classification === 'private' ? 'lan' : 'online',
      hosts: [item.host],
      reason: `Modellanbieter „${item.label || item.id}“`,
    }, { signal }));
    if (!self.alive) return;
    self.ctx.toast(`${item.host} ist freigegeben.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Nicht freigegeben: ${errorMessage(err)}`, 'error');
  } finally {
    await loadRemote(self);
    if (self.alive) renderRemote(self);
  }
}

/* ------------------------------------------------------------------ */
/* Beobachtete Ordner                                                  */
/* ------------------------------------------------------------------ */

/**
 * Ein Ordner, der still Dinge in den Tresor schiebt, wäre genau die
 * unsichtbare Automatik, die dieses System sonst vermeidet. Deshalb zeigt
 * jede Karte hier drei Dinge nebeneinander: den Schalter, die Zahlen, und
 * — aufklappbar — die vollständige Liste dessen, was aufgenommen wurde,
 * samt der übersprungenen Dateien mit Grund. Ohne diese Liste wäre die
 * Funktion nicht zu verantworten.
 */
function renderWatch(self) {
  const box = self.dom.watch;
  clear(box);

  if (self.watchError) {
    const err = self.watchError;
    if (err.status === 403) {
      box.appendChild(h('p.meta', null, text(
        'Nur die Eigentümerin oder der Eigentümer dieser Installation darf beobachtete Ordner sehen und ändern.')));
    } else if (err.code === 'SUBSYSTEM_UNAVAILABLE' || err.status === 404) {
      // 503: das Teilsystem fehlt. 404: die Route ist nicht registriert.
      // Für die Nutzerin ist beides dasselbe -- dieser Teil ist nicht da --
      // und das ist eine Auskunft, kein Defekt der Oberfläche.
      box.appendChild(h('p.meta.is-warn', null, text(
        'Die Ordnerbeobachtung ist in dieser Installation nicht eingerichtet. Es wird kein Ordner gelesen.')));
    } else {
      box.appendChild(h('p.meta.is-danger', null, text(
        `Die Liste der beobachteten Ordner ist nicht lesbar: ${errorMessage(err)}`)));
    }
    return;
  }

  const data = self.watch || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const status = data.status || null;

  if (status) {
    box.appendChild(h('div.setv__watchstate', { dataset: { running: status.running ? '1' : '0' } },
      h('span.setv__watch-dot', { 'aria-hidden': 'true' }),
      h('span', null, text(status.running
        ? `Die Beobachtung läuft. ${formatNumber(status.enabled)} von ${formatNumber(status.total)} Ordner(n) eingeschaltet, `
          + `nachgesehen wird spätestens alle ${intervalText(status.sweepIntervalMs)}.`
        : 'Die Beobachtung läuft gerade nicht. Ordner werden nur gelesen, wenn du hier auf „Jetzt aufnehmen“ drückst.'))));
  }

  if (!items.length) {
    box.appendChild(h('p.meta', null, text(
      'Es wird kein Ordner beobachtet. Bis du einen hinzufügst und einschaltest, liest dieses Programm keine Datei von deiner Platte.')));
  }

  for (const item of items) box.appendChild(watchCard(self, item));
  box.appendChild(watchForm(self, data));
}

/** „alle 300 s" ist keine Zeitangabe, die jemand im Kopf umrechnen möchte. */
function intervalText(ms) {
  const seconds = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unbekannte Zeit';
  if (seconds < 90) return `${formatNumber(seconds)} Sekunden`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${formatNumber(minutes)} Minuten`;
  return `${formatNumber(Math.round(minutes / 60))} Stunden`;
}

function watchStateText(item) {
  const state = item.beobachtung || {};
  if (!item.data.enabled) return 'Ausgeschaltet – dieser Ordner wird nicht gelesen.';
  if (state.aktiv) return `Wird beobachtet (${state.art}).`;
  return 'Eingeschaltet. Beobachtet wird erst, wenn Neural OS die Beobachtung gestartet hat.';
}

function watchCard(self, item) {
  const id = item.id;
  const data = item.data || {};
  const state = item.beobachtung || {};
  const busyKey = `watch:${id}`;
  const busy = self.busy[busyKey] === true;

  const toggle = h('input', {
    type: 'checkbox',
    checked: data.enabled === true,
    onChange: (event) => toggleWatch(self, item, event.target),
  });

  // Beide Zahlen sind gemessen, und beide sagen, wozu sie gehören: „aufgenommen"
  // ist die Summe über alle Durchläufe, „übersprungen" gehört zu dem einen
  // Durchlauf, der daneben steht -- als Summe zählte es dieselbe unveränderte
  // Datei bei jedem Rundlauf erneut mit und wüchse ohne Zutun weiter. Wo noch
  // nie ein Durchlauf war, steht deshalb keine Null, sondern genau das.
  const zahlen = h('p.meta', null, text(
    `${formatNumber(data.imported || 0)} Datei(en) aufgenommen · `
    + (data.lastScanAt
      ? `zuletzt durchgesehen ${timeAgo(data.lastScanAt)}, dabei ${formatNumber(data.skipped || 0)} übersprungen`
      : 'noch nie durchgesehen')));

  const actions = h('div.row.setv__watch-actions', null,
    h('button.btn.btn--small', {
      type: 'button',
      disabled: busy,
      onClick: () => scanWatch(self, item, true),
    }, icon(ICONS.eye), text('Erst ansehen')),
    h('button.btn.btn--small', {
      type: 'button',
      disabled: busy || !data.enabled,
      title: data.enabled ? '' : 'Erst einschalten – ein ausgeschalteter Ordner wird nicht gelesen.',
      onClick: () => scanWatch(self, item, false),
    }, icon(ICONS.download), text(busy ? 'Wird gelesen …' : 'Jetzt aufnehmen')),
    h('span.spacer'),
    h('button.btn.btn--small.btn--danger', {
      type: 'button',
      onClick: () => removeWatch(self, item),
    }, icon(ICONS.trash), text('Entfernen')));

  return h('article.setv__watch', { dataset: { on: data.enabled ? '1' : '0' } },
    h('div.row', null,
      h('span.setv__watch-dot', { 'aria-hidden': 'true' }),
      h('strong', null, text(String(data.label || data.path))),
      h('span.spacer'),
      h('span.badge', null, text(data.enabled ? 'eingeschaltet' : 'aus'))),
    h('p.meta.setv__path', null, h('code', null, text(String(data.path)))),
    h('p.meta', null, text(watchStateText(item))),
    state.problem ? h('p.meta.is-warn', null, text(String(state.problem))) : null,
    zahlen,
    h('p.meta', null, text(
      `${data.recursive ? 'Mit Unterordnern' : 'Nur die oberste Ebene'} · Dateien über `
      + `${formatBytes(data.maxFileBytes)} werden übersprungen`
      + (data.tags && data.tags.length ? ` · Schlagwörter: ${data.tags.join(', ')}` : ''))),
    data.lastError ? h('p.meta.is-danger', null, text(`Zuletzt: ${String(data.lastError)}`)) : null,
    h('div.setv__permrow', null, h('label.setv__perm', null, toggle, text('Ordner einschalten'))),
    actions,
    watchScanResult(self, id),
    watchLogDetails(self, item));
}

/** Das letzte echte Ergebnis. Steht hier nichts, ist auch nichts gelaufen. */
function watchScanResult(self, id) {
  const result = self.watchScans.get(id);
  if (!result) return null;
  if (result.fehler) {
    return h('div.setv__hintbox', { dataset: { level: 'fail' } }, text(String(result.fehler)));
  }
  const rows = [];
  const uebersprungen = Array.isArray(result.uebersprungen) ? result.uebersprungen : [];
  if (result.dryRun) {
    // Nicht „gefunden": das wäre die Zahl NACH dem Filtern und klänge wie
    // „so viel liegt in dem Ordner". Genannt werden die beiden Zahlen, die
    // wirklich gemessen wurden -- und darunter steht jede abgelehnte Datei.
    rows.push(h('p', null, text(
      `Nur angesehen: ${formatNumber(result.wuerdeAufnehmen)} Datei(en) würden aufgenommen, `
      + `${formatNumber(uebersprungen.length)} übersprungen. Es wurde nichts gespeichert.`)));
  } else {
    rows.push(h('p', null, text(
      `${formatNumber(result.aufgenommen)} aufgenommen, ${formatNumber(uebersprungen.length)} übersprungen, `
      + `in ${formatNumber(result.dauerMs)} ms.`)));
  }
  if (Array.isArray(result.neu) && result.neu.length) {
    rows.push(h('ul.setv__watch-files', { role: 'list' },
      result.neu.slice(0, 12).map((entry) => h('li', null,
        text(`${entry.datei} (${formatBytes(entry.groesse)})`)))));
    if (result.neu.length > 12) {
      rows.push(h('p.meta', null, text(`… und ${formatNumber(result.neu.length - 12)} weitere.`)));
    }
  }
  // Die übersprungenen Dateien MIT Grund -- der Server liefert ihn mit. Ohne
  // diese Liste bliebe ausgerechnet die Auskunft unsichtbar, für die es das
  // Ansehen vor dem Einschalten gibt: dass hier ein symbolischer Link liegt,
  // der nicht verfolgt wird, dass dort ein Ordner mit Erzeugtem steht, dass
  // eine Datei zu groß ist.
  if (uebersprungen.length) {
    rows.push(h('p.meta', null, text('Übersprungen, mit Grund:')));
    rows.push(h('ul.setv__watch-files', { role: 'list' },
      uebersprungen.slice(0, 12).map((entry) => h('li', null,
        text(`${entry.datei} – ${entry.grund}`)))));
    if (uebersprungen.length > 12) {
      rows.push(h('p.meta', null, text(`… und ${formatNumber(uebersprungen.length - 12)} weitere.`)));
    }
  }
  for (const warnung of Array.isArray(result.warnungen) ? result.warnungen.slice(0, 6) : []) {
    rows.push(h('p.meta.is-warn', null, text(String(warnung))));
  }
  if (result.abgebrochen) rows.push(h('p.meta.is-warn', null, text(String(result.abgebrochen))));
  if (result.hinweis) rows.push(h('p.meta', null, text(String(result.hinweis))));
  return h('div.setv__hintbox', { dataset: { level: result.dryRun ? 'blocked' : 'ok' } }, rows);
}

/**
 * „Was wurde aufgenommen" -- die eigentliche Zusage dieser Funktion.
 *
 * Wird erst beim Aufklappen geholt, weil die Liste lang sein kann; was noch
 * nicht da ist, sagt „wird geladen", nicht „nichts da".
 */
function watchLogDetails(self, item) {
  const id = item.id;
  const entry = self.watchLogs.get(id);
  const body = h('div.setv__watchlog-body.stack');

  if (!entry) {
    body.appendChild(h('p.meta', null, text('Noch nicht geladen.')));
  } else if (entry.loading) {
    body.appendChild(h('p.meta', null, text('Wird geladen …')));
  } else if (entry.error) {
    body.appendChild(h('p.meta.is-danger', null, text(`Nicht lesbar: ${errorMessage(entry.error)}`)));
  } else {
    const log = entry.log || {};
    const taken = Array.isArray(log.aufgenommen) ? log.aufgenommen : [];
    const skipped = Array.isArray(log.uebersprungen) ? log.uebersprungen : [];

    body.appendChild(h('p.meta', null, text(taken.length
      ? `${formatNumber(log.aufgenommenGesamt)} Datei(en) aufgenommen:`
      : 'Aus diesem Ordner wurde noch keine Datei aufgenommen.')));
    if (taken.length) {
      body.appendChild(h('ul.setv__watch-files', { role: 'list' }, taken.map((file) => h('li', null,
        text(`${file.datei} · ${formatBytes(file.groesse)} · ${timeAgo(file.at)}`),
        file.leererText
          ? h('span.meta.is-warn', null, text(' – kein Text gefunden'))
          : null,
        (file.warnungen || []).length
          ? h('span.meta.is-warn', null, text(` – ${file.warnungen.join(' ')}`))
          : null))));
    }

    // Vorgänge, nicht Dateien: dieselbe Datei wird bei jedem Durchlauf erneut
    // übersprungen, und eine Zahl, die wie eine Dateizahl klingt, wäre hier
    // schlicht falsch.
    body.appendChild(h('p.meta', null, text(skipped.length
      ? `${formatNumber(log.uebersprungenGesamt)} Mal übersprungen, seit das Programm läuft – mit Grund:`
      : 'Seit dem Start wurde nichts übersprungen.')));
    if (skipped.length) {
      // Mit Zeitstempel, weil dieselbe Datei bei jedem Durchlauf erneut
      // übersprungen wird: ohne ihn sähe ein Protokoll zweier Durchläufe wie
      // ein doppelter Eintrag aus.
      body.appendChild(h('ul.setv__watch-files', { role: 'list' }, skipped.map((skip) => h('li', null,
        text(`${skip.datei} – ${skip.grund}`),
        skip.at ? h('span.meta', null, text(` (${timeAgo(skip.at)})`)) : null))));
    }
    if (log.hinweis) body.appendChild(h('p.hint', null, text(String(log.hinweis))));
  }

  const details = h('details.setv__watchlog', {
    open: self.watchOpen.has(id),
    onToggle: (event) => {
      if (event.target.open) {
        self.watchOpen.add(id);
        if (!self.watchLogs.has(id)) loadWatchLog(self, id);
      } else {
        self.watchOpen.delete(id);
      }
    },
  }, h('summary', null, text('Was wurde aufgenommen')), body);
  return details;
}

function watchForm(self, data) {
  const readable = Array.isArray(data.lesbareEndungen) ? data.lesbareEndungen : [];
  const pathField = h('input.input', {
    type: 'text', placeholder: '/home/du/Dokumente', autocomplete: 'off', spellcheck: 'false',
  });
  const labelField = h('input.input', { type: 'text', placeholder: 'Anzeigename', autocomplete: 'off' });
  const tagsField = h('input.input', { type: 'text', placeholder: 'posteingang, scans', autocomplete: 'off' });
  const recursiveBox = h('input', { type: 'checkbox', checked: true });

  return h('details.setv__newtoken', null,
    h('summary', null, text('Ordner hinzufügen')),
    h('div.setv__newtoken-body.stack', null,
      h('label.field', null, h('span.label', null, text('Vollständiger Pfad')), pathField,
        h('span.hint', null, text('Der Ordner muss es schon geben und darf den Datenordner von Neural OS nicht enthalten.'))),
      h('label.field', null, h('span.label', null, text('Bezeichnung')), labelField),
      h('label.field', null, h('span.label', null, text('Schlagwörter für aufgenommene Dateien')), tagsField,
        h('span.hint', null, text('Mit Komma trennen. Leer lassen ist auch in Ordnung.'))),
      h('div.setv__permrow', null, h('label.setv__perm', null, recursiveBox, text('Unterordner einbeziehen'))),
      readable.length
        ? h('p.hint', null, text(`Gelesen werden Dateien mit diesen Endungen: ${readable.join(' ')}`))
        : null,
      h('div.row', null,
        h('button.btn.btn--primary.btn--small', {
          type: 'button',
          disabled: self.busy.watchAdd === true,
          onClick: () => addWatch(self, {
            path: pathField.value.trim(),
            label: labelField.value.trim(),
            tags: tagsField.value.split(',').map((t) => t.trim()).filter(Boolean),
            recursive: recursiveBox.checked,
          }, pathField),
        }, text(self.busy.watchAdd ? 'Wird angelegt …' : 'Ordner hinzufügen')),
        h('span.hint', null, text('Hinzufügen liest noch nichts. Gelesen wird erst nach dem Einschalten.')))));
}

async function addWatch(self, input, pathField) {
  if (!input.path) {
    self.ctx.toast('Ohne Pfad gibt es nichts zu beobachten.', 'error');
    pathField.focus();
    return;
  }
  setBusy(self, 'watchAdd', true);
  renderWatch(self);
  try {
    await request(self, (signal) => self.api.post('/watch', input, { signal }));
    if (!self.alive) return;
    pathField.value = '';
    self.ctx.toast('Ordner angelegt – und noch ausgeschaltet. Er wird erst gelesen, wenn du ihn einschaltest.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Nicht angelegt: ${errorMessage(err)}`, 'error');
  } finally {
    setBusy(self, 'watchAdd', false);
    await loadWatch(self);
    if (self.alive) renderWatch(self);
  }
}

/**
 * Der Schalter.
 *
 * Einschalten wird einmal nachgefragt, und die Rückfrage sagt in einem Satz,
 * was ab dann von allein passiert. Ausschalten braucht keine Rückfrage:
 * weniger Automatik ist nie die überraschende Richtung.
 */
async function toggleWatch(self, item, input) {
  const enabled = input.checked === true;
  if (enabled) {
    const ok = await self.ctx.confirm({
      title: `„${item.data.label || item.data.path}“ einschalten?`,
      message: 'Ab dann sieht Neural OS von allein in diesem Ordner nach und nimmt neue und geänderte Dateien '
        + 'als lesbaren Text in den Tresor auf. Im Ordner selbst wird nichts gelöscht und nichts geändert, und '
        + 'unter „Was wurde aufgenommen“ steht jederzeit jede einzelne Datei.',
      confirmLabel: 'Einschalten',
    });
    if (!ok || !self.alive) {
      input.checked = false;
      return;
    }
  }
  try {
    await request(self, (signal) => self.api.patch(`/watch/${encodeURIComponent(item.id)}`, { enabled }, { signal }));
    if (!self.alive) return;
    self.ctx.toast(enabled ? 'Ordner eingeschaltet.' : 'Ordner ausgeschaltet. Er wird nicht mehr gelesen.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Nicht geändert: ${errorMessage(err)}`, 'error');
  } finally {
    await loadWatch(self);
    if (self.alive) renderWatch(self);
  }
}

/**
 * „Erst ansehen" beantwortet, was passieren würde, ohne eine einzige Datei zu
 * öffnen; „Jetzt aufnehmen" tut es dann wirklich. Beide zeigen das Ergebnis,
 * das der Server geliefert hat -- auch wenn das Ergebnis eine Absage ist.
 */
async function scanWatch(self, item, dryRun) {
  const busyKey = `watch:${item.id}`;
  setBusy(self, busyKey, true);
  renderWatch(self);
  try {
    const result = await request(self, (signal) => self.api.post(
      `/watch/${encodeURIComponent(item.id)}/scan`, { dryRun }, { signal, timeoutMs: 120000 },
    ));
    if (!self.alive) return;
    self.watchScans.set(item.id, result);
    if (!dryRun) {
      self.watchLogs.delete(item.id);
      if (self.watchOpen.has(item.id)) loadWatchLog(self, item.id);
      self.ctx.toast(result.aufgenommen
        ? `${result.aufgenommen} Datei(en) aufgenommen.`
        : 'Es gab nichts Neues aufzunehmen.', result.aufgenommen ? 'success' : 'info');
    }
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    // Eine Absage ist ein Ergebnis und wird als solches gezeigt, nicht verschluckt.
    self.watchScans.set(item.id, { fehler: errorMessage(err) });
  } finally {
    setBusy(self, busyKey, false);
    await loadWatch(self);
    if (self.alive) renderWatch(self);
  }
}

async function loadWatchLog(self, id) {
  self.watchLogs.set(id, { loading: true });
  try {
    const log = await request(self, (signal) => self.api.get(`/watch/${encodeURIComponent(id)}/log`, { signal }));
    if (!self.alive) return;
    self.watchLogs.set(id, { log });
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.watchLogs.set(id, { error: err });
  } finally {
    if (self.alive) renderWatch(self);
  }
}

async function removeWatch(self, item) {
  const ok = await self.ctx.confirm({
    title: 'Ordner nicht mehr beobachten?',
    message: `„${item.data.label || item.data.path}“ wird aus der Liste entfernt und nicht mehr gelesen. `
      + 'Die bereits aufgenommenen Dateien bleiben im Tresor.',
    confirmLabel: 'Entfernen',
    danger: true,
  });
  if (!ok || !self.alive) return;
  try {
    await request(self, (signal) => self.api.del(`/watch/${encodeURIComponent(item.id)}`, { signal }));
    if (!self.alive) return;
    self.watchScans.delete(item.id);
    self.watchLogs.delete(item.id);
    self.watchOpen.delete(item.id);
    self.ctx.toast('Ordner entfernt. Die aufgenommenen Dateien bleiben.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Nicht entfernt: ${errorMessage(err)}`, 'error');
  } finally {
    await loadWatch(self);
    if (self.alive) renderWatch(self);
  }
}

function renderDiagnosis(self) {
  const box = self.dom.diagnosis;
  clear(box);

  const checks = buildChecks(self);
  const problems = checks.filter((check) => check.level !== 'ok').length;

  box.appendChild(h('p.meta', null, text(problems
    ? `${formatNumber(problems)} Punkt(e) brauchen Aufmerksamkeit.`
    : 'Alles, was dieses System prüfen kann, sieht in Ordnung aus.')));

  const listNode = h('ul.setv__checks', { role: 'list' });
  for (const check of checks) {
    const row = h('li.setv__check', null,
      h('span.setv__check-icon', { 'aria-hidden': 'true' },
        icon(check.level === 'ok' ? ICONS.check : check.level === 'warn' ? ICONS.info : ICONS.alert)),
      h('span.setv__check-body', null,
        h('span.setv__check-title', null, text(check.title)),
        h('span.setv__check-detail', null, text(check.detail))));
    row.dataset.level = check.level;
    listNode.appendChild(row);
  }
  box.appendChild(listNode);
}

function buildChecks(self) {
  const checks = [];
  const status = self.status;

  if (!status) {
    checks.push({
      level: 'fail',
      title: 'Server nicht erreichbar',
      detail: self.statusError
        ? `Der Statusbericht konnte nicht gelesen werden: ${errorMessage(self.statusError)}`
        : 'Der Statusbericht konnte nicht gelesen werden.',
    });
    return checks;
  }

  checks.push({
    level: 'ok',
    title: `Neural OS ${status.version || ''} läuft`.trim(),
    detail: `Node ${status.node || 'unbekannt'} · seit ${formatNumber(Math.round((status.uptime || 0) / 60))} Minuten · Ordner ${status.home || 'unbekannt'}`,
  });

  const subsystems = status.subsystems || {};
  const NAMES = {
    store: 'Speicher', gate: 'Netz-Schleuse', graph: 'Wissensgraph', models: 'Modellverwaltung',
    chat: 'Chat', agents: 'Agenten-Laufzeit', approvals: 'Bestätigungen', backup: 'Sicherung',
    auth: 'Zugangsverwaltung', vaultCrypto: 'Verschlüsselung',
  };
  const missing = Object.entries(NAMES).filter(([key]) => subsystems[key] === false).map(([, name]) => name);
  checks.push(missing.length
    ? {
      level: 'warn',
      title: 'Nicht alle Teilsysteme sind geladen',
      detail: `Es fehlt: ${missing.join(', ')}. Die betroffenen Bereiche der Oberfläche melden das jeweils selbst, statt leer zu bleiben.`,
    }
    : { level: 'ok', title: 'Alle Teilsysteme geladen', detail: 'Speicher, Schleuse, Graph, Modelle, Chat, Agenten, Sicherung und Zugangsverwaltung sind da.' });

  const vault = status.vault || {};
  if (vault.state === 'locked') {
    checks.push({ level: 'fail', title: 'Tresor gesperrt', detail: 'Ohne Passphrase können keine Daten gelesen oder geschrieben werden. Oben im Abschnitt „Verschlüsselung“ lässt er sich entsperren.' });
  } else if (vault.encrypted) {
    checks.push({ level: 'ok', title: 'Tresor verschlüsselt und entsperrt', detail: `${formatNumber(vault.records || 0)} Einträge, ${formatBytes(vault.bytes || 0)} auf der Platte.` });
  } else {
    checks.push({ level: 'warn', title: 'Tresor unverschlüsselt', detail: 'Die Daten liegen im Klartext im Neural-OS-Ordner. Wer Zugriff auf dieses Benutzerkonto hat, kann sie lesen.' });
  }

  const network = status.network || {};
  if (network.mode === 'offline') {
    checks.push({ level: 'ok', title: 'Netzzugang: offline', detail: 'Es verlässt nichts dieses Gerät. Lokale Modelle laufen weiter.' });
  } else {
    checks.push({
      level: 'warn',
      title: `Netzzugang: ${network.mode === 'lan' ? 'lokales Netz' : 'Internet'}`,
      detail: network.mode === 'online'
        ? 'Öffentliche Adressen sind erreichbar. Im Bereich „Netzwerk“ steht das vollständige Protokoll jedes Zugriffs.'
        : 'Geräte im eigenen Netz sind erreichbar, das öffentliche Internet nicht.',
    });
  }
  if (network.hardened === false) {
    checks.push({ level: 'warn', title: 'Prozessweite Absicherung nicht aktiv', detail: 'Die Schleuse entscheidet weiterhin über jeden Abruf, der durch sie läuft; ausgehende Aufrufe an ihr vorbei würden in diesem Start aber nicht abgefangen.' });
  }

  const models = status.models || {};
  if (models.available) {
    const count = (models.providers || []).filter((p) => p.available).length;
    checks.push({ level: 'ok', title: 'Modell erreichbar', detail: `${formatNumber(count)} Backend(s) antworten.` });
  } else if (models.probed) {
    checks.push({
      level: 'fail',
      title: 'Kein Modell erreichbar',
      detail: 'Ohne Backend kann nicht geantwortet werden – es wird dann auch nichts erfunden. Ollama oder ein anderer lokaler Server muss laufen; „Erneut suchen“ oben prüft es noch einmal.',
    });
  } else {
    checks.push({ level: 'warn', title: 'Noch nicht nach Modellen gesucht', detail: 'Oben im Abschnitt „Modelle“ lässt sich die Suche starten.' });
  }

  const sharing = status.sharing || {};
  if (sharing.enabled) {
    const usable = self.tokens.filter((token) => token.active !== false).length;
    checks.push(usable
      ? { level: 'warn', title: 'Freigabe eingeschaltet', detail: `${formatNumber(usable)} nutzbare(s) Token. Jedes Gerät mit einem davon erreicht diese Oberfläche.` }
      : { level: 'fail', title: 'Freigabe ohne nutzbares Token', detail: 'Die Freigabe ist an, es existiert aber kein gültiges Token – fremde Geräte bekommen nur eine Abweisung.' });
  } else {
    checks.push({ level: 'ok', title: 'Freigabe aus', detail: 'Nur dieses Gerät kann Neural OS erreichen.' });
  }

  const failures = Array.isArray(status.failures) ? status.failures : [];
  for (const failure of failures) {
    checks.push({
      level: 'fail',
      title: `Beim Start fehlgeschlagen: ${failure.subsystem || failure.name || 'unbekannter Teil'}`,
      detail: String(failure.message || failure.error || 'Ohne nähere Angabe.'),
    });
  }

  if (self.configError) {
    checks.push({ level: 'warn', title: 'Konfiguration nicht lesbar', detail: errorMessage(self.configError) });
  }

  return checks;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function setTheme(self, value) {
  if (self.ctx.state && typeof self.ctx.state.set === 'function') self.ctx.state.set('theme', value);
  renderAppearance(self);
  setUi(self, { theme: value }, { silent: true });
}

async function setUi(self, patch, opts = {}) {
  const ui = uiConfig(self);
  const next = { ...ui, ...patch };
  applyUiPreferences({ density: next.density, reduceMotion: next.reduceMotion });
  try {
    const result = await request(self, (signal) => self.api.patch('/config', { ui: patch }, { signal }));
    if (!self.alive) return;
    self.config = (result && result.config) || self.config;
    if (!opts.silent) self.ctx.toast('Gespeichert.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Einstellung nicht gespeichert: ${errorMessage(err)}`, 'error');
    await loadConfig(self);
  } finally {
    if (self.alive) renderAppearance(self);
  }
}

async function compactVault(self) {
  setBusy(self, 'compact', true);
  renderVault(self);
  try {
    const result = await request(self, (signal) => self.api.post('/vault/compact', {}, { signal, timeoutMs: 120000 }));
    if (!self.alive) return;
    self.ctx.toast(`Verdichtet: ${formatNumber((result && result.records) || 0)} Einträge, ${formatBytes((result && result.bytes) || 0)}.`, 'success');
    await loadStatus(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Verdichten fehlgeschlagen: ${errorMessage(err)}`, 'error');
  } finally {
    setBusy(self, 'compact', false);
    if (self.alive) renderVault(self);
  }
}

async function enableEncryption(self, pass1, pass2) {
  const passphrase = String(pass1.value || '');
  const repeat = String(pass2.value || '');
  if (passphrase.length < 8) {
    self.ctx.toast('Die Passphrase muss mindestens 8 Zeichen haben.', 'error');
    pass1.focus();
    return;
  }
  if (passphrase !== repeat) {
    self.ctx.toast('Die beiden Eingaben stimmen nicht überein.', 'error');
    pass2.focus();
    return;
  }
  const ok = await self.ctx.confirm({
    title: 'Verschlüsselung wirklich einschalten?',
    message: 'Wenn du diese Passphrase verlierst, sind alle Daten in diesem Tresor endgültig verloren. Es gibt keine Wiederherstellung. Hast du eine Sicherung angelegt und die Passphrase sicher notiert?',
    confirmLabel: 'Ja, verschlüsseln',
    cancelLabel: 'Abbrechen',
    danger: true,
  });
  if (!ok || !self.alive) return;

  setBusy(self, 'encrypt', true);
  renderEncryption(self);
  try {
    const result = await request(self, (signal) => self.api.post('/vault/encrypt', { passphrase }, { signal, timeoutMs: 300000 }));
    if (!self.alive) return;
    pass1.value = '';
    pass2.value = '';
    const rewritten = result && result.rewritten;
    self.ctx.toast(rewritten
      ? `Verschlüsselung aktiv. ${formatNumber(rewritten.records || 0)} Einträge wurden neu geschrieben.`
      : 'Verschlüsselung aktiv.', 'success');
    await loadStatus(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Verschlüsselung fehlgeschlagen: ${errorMessage(err)}`, 'error');
    await loadStatus(self);
  } finally {
    setBusy(self, 'encrypt', false);
    if (self.alive) {
      renderEncryption(self);
      renderDiagnosis(self);
    }
  }
}

async function unlockVault(self, input) {
  const passphrase = String(input.value || '');
  if (!passphrase) {
    input.focus();
    return;
  }
  setBusy(self, 'unlock', true);
  renderEncryption(self);
  try {
    const result = await request(self, (signal) => self.api.post('/vault/unlock', { passphrase }, { signal, timeoutMs: 120000 }));
    if (!self.alive) return;
    input.value = '';
    if (result && result.reloaded === false) {
      self.ctx.toast(result.hint || 'Entsperrt. Für den vollen Zugriff ist ein Neustart nötig.', 'info', { timeout: 12000 });
    } else {
      self.ctx.toast('Tresor entsperrt.', 'success');
    }
    await loadStatus(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Entsperren fehlgeschlagen: ${errorMessage(err)}`, 'error');
  } finally {
    setBusy(self, 'unlock', false);
    if (self.alive) {
      renderEncryption(self);
      renderDiagnosis(self);
    }
  }
}

async function lockVault(self) {
  const ok = await self.ctx.confirm({
    title: 'Tresor sperren?',
    message: 'Bis zur nächsten Eingabe der Passphrase sind keine Notizen, Chats oder Aufgaben mehr lesbar.',
    confirmLabel: 'Sperren',
  });
  if (!ok || !self.alive) return;
  setBusy(self, 'lock', true);
  renderEncryption(self);
  try {
    await request(self, (signal) => self.api.post('/vault/lock', {}, { signal }));
    if (!self.alive) return;
    self.ctx.toast('Tresor gesperrt.', 'success');
    await loadStatus(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Sperren fehlgeschlagen: ${errorMessage(err)}`, 'error');
  } finally {
    setBusy(self, 'lock', false);
    if (self.alive) {
      renderEncryption(self);
      renderDiagnosis(self);
    }
  }
}

async function toggleSharing(self, enabled, input) {
  if (enabled) {
    const ok = await self.ctx.confirm({
      title: 'Freigabe im lokalen Netz einschalten?',
      message: 'Andere Geräte in deinem Netz können diese Oberfläche danach erreichen, sofern sie ein Token haben. Ohne Token wird jede Anfrage abgewiesen. Du kannst die Freigabe jederzeit wieder abschalten; Token bleiben dabei bestehen und lassen sich einzeln entziehen.',
      confirmLabel: 'Freigabe einschalten',
      danger: true,
    });
    if (!ok || !self.alive) {
      input.checked = false;
      return;
    }
  }

  try {
    const patch = { security: { sharing: { enabled, requireToken: true } } };
    const result = await request(self, (signal) => self.api.patch('/config', patch, { signal }));
    if (!self.alive) return;
    self.config = (result && result.config) || self.config;
    self.ctx.toast(enabled ? 'Freigabe eingeschaltet. Ohne Token kommt niemand herein.' : 'Freigabe ausgeschaltet.', 'success');
    await loadStatus(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Änderung abgelehnt: ${errorMessage(err)}`, 'error');
    await loadConfig(self);
  } finally {
    if (self.alive) {
      renderSharing(self);
      renderDiagnosis(self);
    }
  }
}

async function setBindHost(self, host) {
  try {
    const result = await request(self, (signal) => self.api.patch('/config', { server: { host } }, { signal }));
    if (!self.alive) return;
    self.config = (result && result.config) || self.config;
    self.ctx.toast('Gespeichert. Wirksam nach einem Neustart von Neural OS.', 'info', { timeout: 9000 });
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Adresse abgelehnt: ${errorMessage(err)}`, 'error');
    await loadConfig(self);
  } finally {
    if (self.alive) renderSharing(self);
  }
}

async function createToken(self, labelInput, permissionBoxes, daysInput) {
  const label = String(labelInput.value || '').trim();
  if (!label) {
    self.ctx.toast('Ein Token braucht eine Bezeichnung – sonst weißt du später nicht, welches Gerät es benutzt.', 'error');
    labelInput.focus();
    return;
  }
  const permissions = {};
  for (const [key, input] of permissionBoxes) permissions[key] = input.checked === true;
  const days = Number.parseInt(daysInput.value, 10);
  const body = { label, permissions };
  if (Number.isFinite(days) && days > 0) {
    body.expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  }

  setBusy(self, 'token', true);
  renderSharing(self);
  try {
    const result = await request(self, (signal) => self.api.post('/tokens', body, { signal }));
    if (!self.alive) return;
    if (!result || !result.token) throw new Error('Der Server hat kein Token zurückgegeben.');
    self.freshToken = result;
    labelInput.value = '';
    await loadTokens(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Token konnte nicht erzeugt werden: ${errorMessage(err)}`, 'error');
  } finally {
    setBusy(self, 'token', false);
    if (self.alive) {
      renderSharing(self);
      renderDiagnosis(self);
    }
  }
}

async function revokeToken(self, id, label) {
  const ok = await self.ctx.confirm({
    title: 'Zugriff entziehen?',
    message: `„${label || id}“ kann danach nichts mehr abrufen. Ein bereits angemeldeter Browser wird beim nächsten Klick abgewiesen.`,
    confirmLabel: 'Entziehen',
    danger: true,
  });
  if (!ok || !self.alive) return;
  try {
    await request(self, (signal) => self.api.del(`/tokens/${encodeURIComponent(id)}`, { signal }));
    if (!self.alive) return;
    await loadTokens(self);
    self.ctx.toast('Zugriff entzogen.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Entziehen fehlgeschlagen: ${errorMessage(err)}`, 'error');
  } finally {
    if (self.alive) {
      renderSharing(self);
      renderDiagnosis(self);
    }
  }
}

async function refreshModels(self) {
  setBusy(self, 'models', true);
  renderModels(self);
  try {
    const result = await request(self, (signal) => self.api.post('/models/refresh', {}, { signal, timeoutMs: 40000 }));
    if (!self.alive) return;
    self.models = result;
    self.modelsError = null;
    const count = (result && Array.isArray(result.providers) ? result.providers : []).filter((p) => p.available).length;
    self.ctx.toast(count ? `${formatNumber(count)} Backend(s) erreichbar.` : 'Kein Modell-Backend erreichbar.', count ? 'success' : 'info');
    await loadStatus(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.modelsError = err;
  } finally {
    setBusy(self, 'models', false);
    if (self.alive) {
      renderModels(self);
      renderDiagnosis(self);
    }
  }
}

async function setDefaultModel(self, value) {
  const raw = String(value || '').trim();
  let next = null;
  if (raw) {
    const slash = raw.indexOf('/');
    next = slash === -1
      ? { provider: null, model: raw }
      : { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
  }
  try {
    const result = await request(self, (signal) => self.api.patch('/config', { models: { default: next } }, { signal }));
    if (!self.alive) return;
    self.config = (result && result.config) || self.config;
    const stored = (self.config && self.config.models && self.config.models.default) || null;
    if (!next && stored) {
      // deepMerge on the server keeps an existing object when it is patched
      // with null: say so rather than showing a choice that did not take.
      self.ctx.toast('Die Vorgabe konnte nicht auf „automatisch“ zurückgesetzt werden; es bleibt das bisherige Modell eingetragen.', 'error', { timeout: 10000 });
    } else {
      self.ctx.toast('Standardmodell gespeichert.', 'success');
    }
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Standardmodell nicht gespeichert: ${errorMessage(err)}`, 'error');
    await loadConfig(self);
  } finally {
    if (self.alive) renderModels(self);
  }
}

/** Copy helper: the clipboard API can be refused, so failure is reported. */
async function copyText(self, value) {
  if (!value) return;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      self.ctx.toast('In die Zwischenablage kopiert.', 'success');
      return;
    }
    throw new Error('Zwischenablage nicht verfügbar');
  } catch {
    self.ctx.toast('Der Browser hat das Kopieren abgelehnt. Markiere den Text und kopiere ihn von Hand.', 'error');
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

/**
 * Density and reduced motion are whole-interface preferences, so they are the
 * one thing this view styles outside its own tree. They hang off attributes on
 * <html> and only ever adjust tokens, never individual components.
 */
const PREF_CSS = `
:root[data-density="compact"] {
  --sp-1: 6px;
  --sp-2: 12px;
  --sp-3: 18px;
  --sp-4: 24px;
  --sp-6: 36px;
  --lh: 1.45;
}
:root[data-motion="reduce"] *,
:root[data-motion="reduce"] *::before,
:root[data-motion="reduce"] *::after {
  animation-duration: 1ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 1ms !important;
  scroll-behavior: auto !important;
}
`;

const CSS = `
.setv { height: 100%; overflow-y: auto; }
.setv__page { display: flex; flex-direction: column; gap: var(--sp-3); max-width: 900px; }
.setv__card { scroll-margin-top: var(--sp-3); }
.setv__desc { margin: 0; }
.setv__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--sp-2); }
.setv__block { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); }
.setv__block-title { margin: 0; font-size: var(--fs-base); }

.setv__switch { display: flex; gap: var(--sp-1); padding: var(--sp-1); border: 1px solid var(--border); border-radius: var(--r-2); cursor: pointer; }
.setv__switch:hover { background: var(--surface-2); }
.setv__switch-box { padding-top: 2px; }
.setv__switch-body { display: flex; flex-direction: column; gap: 2px; }
.setv__switch-label { font-weight: 500; }
.setv__switch-hint { font-size: var(--fs-sm); color: var(--fg-muted); }

.setv__pathrow { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
.setv__path { word-break: break-all; }
.setv__stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-2); margin: 0; }
.setv__stat dt { font-size: var(--fs-sm); color: var(--fg-muted); }
.setv__stat dd { margin: 2px 0 0; font-size: var(--fs-lg); }
.setv__warn { padding: var(--sp-1); color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); border-radius: var(--r-1); }

.setv__state[data-state="locked"] { color: var(--danger); background: var(--danger-soft); }
.setv__state[data-state="unlocked"] { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }

.setv__danger { padding: var(--sp-2); border: 1px solid var(--danger); border-radius: var(--r-2); background: var(--danger-soft); }
.setv__danger[data-tone="off"] { border-color: var(--border); background: var(--surface-2); }
.setv__danger p { margin: 0 0 var(--sp-05); }
.setv__danger p:last-child { margin-bottom: 0; }
.setv__danger-title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.setv__danger-title svg { width: 16px; height: 16px; }


.setv__token-new { padding: var(--sp-2); border: 2px solid var(--warn); border-radius: var(--r-2); background: color-mix(in srgb, var(--warn) 10%, transparent); }
.setv__token-new p { margin: 0 0 var(--sp-1); }
.setv__tokenvalue { font-family: var(--font-mono); font-size: var(--fs-sm); margin-bottom: var(--sp-1); }
.setv__tokens { display: flex; flex-direction: column; gap: var(--sp-1); }
.setv__token { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1); border: 1px solid var(--border); border-radius: var(--r-2); }
.setv__token[data-active="0"] { opacity: 0.65; }
.setv__token-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.setv__token-main p { margin: 0; }
.setv__permrow { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.setv__perm { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--r-full); cursor: pointer; }
.setv__newtoken > summary { cursor: pointer; font-size: var(--fs-sm); color: var(--fg-muted); }
.setv__newtoken-body { margin-top: var(--sp-1); }

.setv__provider { display: flex; flex-direction: column; gap: var(--sp-05); padding: var(--sp-1); border: 1px solid var(--border); border-radius: var(--r-2); }
.setv__provider p { margin: 0; }
.setv__provider-dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--fg-subtle); }
.setv__provider[data-available="1"] .setv__provider-dot { background: var(--ok); }
.setv__provider[data-available="0"] .setv__provider-dot { background: var(--danger); }
.setv__modellist { gap: 4px; }
.setv__netmode { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface-2); font-size: var(--fs-sm); }
.setv__netmode[data-mode="offline"] .setv__provider-dot { background: var(--net-offline); }
.setv__netmode[data-mode="lan"] .setv__provider-dot { background: var(--net-lan); }
.setv__netmode[data-mode="online"] .setv__provider-dot { background: var(--net-online); }
.setv__hintbox[data-level="blocked"] { border-color: var(--warn); }
.setv__hintbox[data-level="fail"] { border-color: var(--danger); }
.meta.is-warn { color: var(--warn); }
.setv__hintbox { padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface-2); white-space: pre-wrap; font-size: var(--fs-sm); }

.setv__watch { display: flex; flex-direction: column; gap: var(--sp-05); padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); }
.setv__watch p { margin: 0; }
.setv__watchstate { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface-2); font-size: var(--fs-sm); }
.setv__watchstate[data-running="1"] .setv__watch-dot { background: var(--ok); }
.setv__watch-dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--fg-subtle); flex: none; }
.setv__watch[data-on="1"] .setv__watch-dot { background: var(--ok); }
.setv__watch[data-on="0"] .setv__watch-dot { background: var(--fg-subtle); }
.setv__watch-actions { flex-wrap: wrap; }
.setv__watch-files { margin: 0; padding-left: var(--sp-3); font-size: var(--fs-sm); color: var(--fg-muted); word-break: break-word; }
.setv__watchlog > summary { cursor: pointer; font-size: var(--fs-sm); color: var(--fg-muted); }
.setv__watchlog-body { margin-top: var(--sp-1); }
.setv__hintbox[data-level="ok"] { border-color: var(--ok); }

.setv__checks { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; padding: 0; list-style: none; }
.setv__check { display: flex; gap: var(--sp-1); padding: var(--sp-1); border-left: 3px solid var(--border-strong); border-radius: var(--r-1); background: var(--surface-2); }
.setv__check[data-level="ok"] { border-left-color: var(--ok); }
.setv__check[data-level="warn"] { border-left-color: var(--warn); }
.setv__check[data-level="fail"] { border-left-color: var(--danger); }
.setv__check-icon svg { width: 16px; height: 16px; }
.setv__check[data-level="ok"] .setv__check-icon { color: var(--ok); }
.setv__check[data-level="warn"] .setv__check-icon { color: var(--warn); }
.setv__check[data-level="fail"] .setv__check-icon { color: var(--danger); }
.setv__check-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.setv__check-title { font-weight: 500; }
.setv__check-detail { font-size: var(--fs-sm); color: var(--fg-muted); }
`;
