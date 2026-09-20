/**
 * views/network.js -- the trust centre of this application.
 *
 * Every other screen makes a promise about privacy; this one is where the
 * promise is made, enforced and, above all, checked. The decisions behind it:
 *
 * 1. **The current stance is the largest thing on the screen.** Not a badge in
 *    a corner: a full-width panel that names the mode, says in plain German
 *    what it means and cannot be confused with decoration. Someone glancing at
 *    this page from two metres away must be able to tell whether this machine
 *    can talk to the internet.
 * 2. **Going online is a deliberate act.** Switching to "Internet" asks for an
 *    explicit confirmation that spells out the consequence. Switching back to
 *    offline never asks: making the safe direction cheap and the risky
 *    direction expensive is the whole point.
 * 3. **The audit log is evidence, not telemetry.** It is read from the file
 *    the server wrote (`/api/network/audit`) and extended live from the bus
 *    (`network.attempt`). Every decision, allowed as well as blocked, appears
 *    with its target, classification, reason and the scope that triggered it.
 *    A log of denials alone would prove nothing about what actually left.
 * 4. **"Ziel prüfen" connects to nothing.** It asks the gate what it *would*
 *    decide (`POST /api/network/test`), with no DNS lookup and no socket --
 *    a lookup is itself egress, because it hands the hostname to a resolver.
 *    The answer says so.
 * 5. **Nothing here is optimistic.** Every change is written through the API
 *    and the panel re-reads the server's own answer afterwards. If a write
 *    fails, the old value stays on screen with the error next to it, because a
 *    UI that shows a policy the server did not accept is worse than no UI.
 */

import {
  h, text, clear, icon, timeAgo, formatDateTime, formatNumber, debounce,
} from '../lib/dom.js';

const STYLE_ID = 'nos-network-view-style';

const VIEW_ICON = '<path d="M10 2.4 16 4.7v4.8c0 3.3-2.4 6.2-6 7.4-3.6-1.2-6-4.1-6-7.4V4.7z"/><path d="m7.5 9.9 1.8 1.8 3.3-3.5"/>';

const ICONS = {
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  block: '<circle cx="10" cy="10" r="7.2"/><path d="m5.2 14.8 9.6-9.6"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  search: '<circle cx="8.8" cy="8.8" r="5.2"/><path d="m12.7 12.7 4 4"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
};

const MODES = [
  {
    value: 'offline',
    label: 'Offline',
    short: 'Nur dieses Gerät',
    headline: 'Nichts verlässt dieses Gerät.',
    body: 'Es sind ausschließlich Verbindungen innerhalb dieses Rechners erlaubt. Lokale Modelle laufen weiter – ein Modell auf 127.0.0.1 ist kein Internet. Jeder Versuch, nach draußen zu gehen, wird abgelehnt und unten protokolliert.',
  },
  {
    value: 'lan',
    label: 'Lokales Netz',
    short: 'Eigenes Netz',
    headline: 'Geräte im eigenen Netz sind erreichbar, das öffentliche Internet nicht.',
    body: 'Sinnvoll, wenn das Modell auf einem anderen Rechner im selben Netz läuft – etwa einem kräftigeren Arbeitsrechner oder einem kleinen Server. Adressen aus dem öffentlichen Internet bleiben gesperrt.',
  },
  {
    value: 'online',
    label: 'Internet',
    short: 'Öffentliches Netz',
    headline: 'Öffentliche Adressen sind erreichbar.',
    body: 'Ab jetzt können Inhalte dieses Geräts an fremde Server gehen – alles, was ein Chat oder ein Agent in eine Anfrage schreibt. Mit der strikten Freigabeliste bleibt das auf die unten eingetragenen Adressen beschränkt.',
  },
];

const CLASSIFICATION_LABEL = {
  loopback: 'lokal (dieses Gerät)',
  private: 'lokales Netz',
  public: 'öffentliches Internet',
  unknown: 'unbekannt',
};

const LEVEL_LABEL = {
  local: 'lokal',
  blocked: 'blockiert',
  offline: 'Offline-Modus',
  lan: 'lokales Netz',
  online: 'Internet',
  grant: 'Freigabe',
};

const AUDIT_KIND_LABEL = {
  'network.allow': 'erlaubt',
  'network.local': 'lokal erlaubt',
  'network.block': 'blockiert',
  'network.dns': 'Namensauflösung',
  'network.grant.added': 'Freigabe erteilt',
  'network.grant.revoked': 'Freigabe widerrufen',
  'network.policy': 'Richtlinie geändert',
};

/** Cap on the rows the table holds; the file on disk keeps everything. */
const MAX_AUDIT_ROWS = 600;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

function modeInfo(mode) {
  return MODES.find((m) => m.value === mode) || null;
}

function parseHosts(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, 200);
}

function targetLabel(entry) {
  const host = entry.host || entry.ip || '–';
  const port = entry.port ? `:${entry.port}` : '';
  return `${host}${port}`;
}

/** One row of the live table, from an audit line or a bus payload. */
function normaliseEntry(raw, fallbackKind) {
  const kind = raw.kind || fallbackKind || null;
  let allowed = raw.allowed;
  if (allowed === undefined && kind) allowed = kind !== 'network.block';
  return {
    at: raw.at || new Date().toISOString(),
    kind,
    host: raw.host || null,
    ip: raw.ip || null,
    port: raw.port === undefined ? null : raw.port,
    scope: raw.scope || null,
    purpose: raw.purpose || null,
    classification: raw.classification || null,
    allowed: allowed === true,
    decided: allowed !== undefined,
    level: raw.level || null,
    reason: raw.reason || null,
    grantId: raw.grantId || null,
    raw,
  };
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'network',
  title: 'Netzwerk',
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

      snapshot: null,
      snapshotError: null,
      busy: false,

      audit: [],
      auditError: null,
      auditLoading: true,
      filter: { textValue: '', decision: 'all', classification: 'all' },
      paused: false,

      testResult: null,
      testError: null,
      testBusy: false,
    };
    view = self;

    buildLayout(self);
    subscribe(self);
    await Promise.all([loadNetwork(self), loadAudit(self)]);
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

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function loadNetwork(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/network', { signal }));
    if (!self.alive) return;
    self.snapshot = result;
    self.snapshotError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.snapshot = null;
    self.snapshotError = err;
  }
}

async function loadAudit(self) {
  self.auditLoading = true;
  try {
    const result = await request(self, (signal) => self.api.get('/network/audit', { query: { limit: 300 }, signal }));
    if (!self.alive) return;
    const items = Array.isArray(result && result.items) ? result.items : [];
    // The server answers newest first; the table keeps that order.
    self.audit = items.map((entry) => normaliseEntry(entry));
    self.auditError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.audit = [];
    self.auditError = err;
  } finally {
    self.auditLoading = false;
  }
}

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;

  self.cleanups.push(ctx.bus.on('network.attempt', (payload) => {
    if (!self.alive || !payload || self.paused) return;
    const entry = normaliseEntry(payload, payload.allowed === false ? 'network.block' : 'network.allow');
    entry.live = true;
    self.audit.unshift(entry);
    if (self.audit.length > MAX_AUDIT_ROWS) self.audit.length = MAX_AUDIT_ROWS;
    renderAudit(self);
  }));

  const refreshSoon = debounce(() => {
    if (!self.alive) return;
    loadNetwork(self).then(() => {
      if (self.alive) {
        renderMode(self);
        renderPolicy(self);
        renderGrants(self);
      }
    });
  }, 400);

  self.cleanups.push(ctx.bus.on('network.grant', () => refreshSoon()));
  self.cleanups.push(ctx.bus.on('config.changed', () => refreshSoon()));
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  /* ------------------------------ mode ------------------------------ */

  dom.modeLabel = h('span.netv__mode-label');
  dom.modeHeadline = h('p.netv__mode-headline');
  dom.modeBody = h('p.netv__mode-body');
  dom.modeFacts = h('ul.netv__facts', { role: 'list' });
  dom.modeButtons = h('div.netv__modebtns', { role: 'group', 'aria-label': 'Netzmodus wählen' });
  dom.modeError = h('p.netv__mode-error.is-danger', { hidden: true, role: 'alert' });

  dom.modePanel = h('section.netv__mode', { 'aria-label': 'Aktueller Netzmodus' },
    h('div.netv__mode-main', null,
      h('span.netv__mode-kicker', null, text('Netzzugang')),
      dom.modeLabel,
      dom.modeHeadline,
      dom.modeBody,
      dom.modeFacts,
      dom.modeError),
    h('div.netv__mode-side', null, dom.modeButtons));

  /* --------------------------- explanation -------------------------- */

  const explain = h('section.card.netv__card', { 'aria-label': 'Was die drei Modi bedeuten' },
    h('div.card__head', null, h('h3', null, text('Was die drei Modi bedeuten'))),
    h('div.card__body.netv__explain', null,
      ...MODES.map((mode) => h('div.netv__explain-item', { dataset: { mode: mode.value } },
        h('h4', null, text(mode.label)),
        h('p', null, text(mode.body))))));

  /* ----------------------------- policy ----------------------------- */

  dom.strictBox = h('input', {
    type: 'checkbox',
    onChange: () => saveStrict(self),
  });
  dom.strictHint = h('span.agentsv__perm-consequence.netv__hint');

  dom.allowChips = h('div.netv__chips');
  dom.allowInput = h('input.input', {
    type: 'text',
    placeholder: 'z. B. api.example.com oder *.wikipedia.org',
    'aria-label': 'Adresse zur Freigabeliste hinzufügen',
    autocomplete: 'off',
    onKeyDown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addHost(self, 'allowHosts', dom.allowInput);
      }
    },
  });
  dom.blockChips = h('div.netv__chips');
  dom.blockInput = h('input.input', {
    type: 'text',
    placeholder: 'z. B. telemetry.example.net',
    'aria-label': 'Adresse zur Sperrliste hinzufügen',
    autocomplete: 'off',
    onKeyDown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addHost(self, 'blockHosts', dom.blockInput);
      }
    },
  });

  dom.policyCard = h('section.card.netv__card', { 'aria-label': 'Freigabe- und Sperrliste' },
    h('div.card__head', null, h('h3', null, text('Freigabeliste und Sperrliste'))),
    h('div.card__body.stack', null,
      h('label.netv__strict', null,
        h('span.netv__strict-box', null, dom.strictBox),
        h('span.netv__strict-body', null,
          h('span.netv__strict-label', null, text('Strikte Freigabeliste')),
          dom.strictHint)),
      h('div.field', null,
        h('span.label', null, text('Erlaubte Adressen')),
        dom.allowChips,
        h('div.row', null, dom.allowInput,
          h('button.btn.btn--small', { type: 'button', onClick: () => addHost(self, 'allowHosts', dom.allowInput) },
            icon(ICONS.plus), text('Aufnehmen'))),
        h('span.hint', null, text('„*“ erlaubt jede Adresse. Ein Eintrag darf einen Port tragen (host:443) und mit „*.“ beginnen.'))),
      h('div.field', null,
        h('span.label', null, text('Immer gesperrte Adressen')),
        dom.blockChips,
        h('div.row', null, dom.blockInput,
          h('button.btn.btn--small', { type: 'button', onClick: () => addHost(self, 'blockHosts', dom.blockInput) },
            icon(ICONS.plus), text('Sperren'))),
        h('span.hint', null, text('Die Sperrliste gewinnt immer – auch gegen eine ausdrückliche Freigabe.')))));

  /* ----------------------------- grants ----------------------------- */

  dom.grantList = h('div.netv__grants');
  dom.grantScope = h('input.input', { type: 'text', value: 'global', 'aria-label': 'Geltungsbereich', placeholder: 'global, chat:… oder agent:…' });
  dom.grantLevel = h('select.select', { 'aria-label': 'Stufe' },
    h('option', { value: 'lan' }, text('Nur lokales Netz')),
    h('option', { value: 'online' }, text('Internet')));
  dom.grantHosts = h('input.input', { type: 'text', 'aria-label': 'Adressen', placeholder: 'host.example.com, *.example.org oder *' });
  dom.grantMinutes = h('input.input', { type: 'number', min: '1', max: '10080', value: '60', 'aria-label': 'Gültigkeit in Minuten' });
  dom.grantUses = h('input.input', { type: 'number', min: '1', max: '1000', placeholder: 'unbegrenzt', 'aria-label': 'Maximale Nutzungen' });
  dom.grantReason = h('input.input', { type: 'text', 'aria-label': 'Grund', placeholder: 'Wofür?' });

  dom.grantCard = h('section.card.netv__card', { 'aria-label': 'Freigaben' },
    h('div.card__head', null,
      h('h3', null, text('Aktive Freigaben')),
      h('span.spacer'),
      h('span.meta', null, text('Eine Freigabe hebt den Modus punktuell auf.'))),
    h('div.card__body.stack', null,
      dom.grantList,
      h('details.netv__newgrant', null,
        h('summary', null, text('Freigabe selbst erteilen')),
        h('div.stack.netv__newgrant-body', null,
          h('div.netv__grid', null,
            h('label.field', null, h('span.label', null, text('Geltungsbereich')), dom.grantScope),
            h('label.field', null, h('span.label', null, text('Stufe')), dom.grantLevel),
            h('label.field', null, h('span.label', null, text('Gültig für (Minuten)')), dom.grantMinutes),
            h('label.field', null, h('span.label', null, text('Höchstens Nutzungen')), dom.grantUses)),
          h('label.field', null, h('span.label', null, text('Adressen (Komma getrennt)')), dom.grantHosts),
          h('label.field', null, h('span.label', null, text('Grund')), dom.grantReason),
          h('div.row', null,
            h('button.btn.btn--primary.btn--small', { type: 'button', onClick: () => createGrant(self) }, text('Freigabe erteilen')),
            h('span.hint', null, text('Ohne Adresse erlaubt eine Freigabe nichts. „*“ steht für jede Adresse.')))))));

  /* ------------------------------ test ------------------------------ */

  dom.testHost = h('input.input', {
    type: 'text',
    placeholder: 'host.example.com',
    'aria-label': 'Zu prüfende Adresse',
    autocomplete: 'off',
    onKeyDown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runTest(self);
      }
    },
  });
  dom.testPort = h('input.input', { type: 'number', min: '1', max: '65535', placeholder: '443', 'aria-label': 'Port (optional)' });
  dom.testScope = h('input.input', { type: 'text', value: 'global', 'aria-label': 'Geltungsbereich' });
  dom.testOut = h('div.netv__testout', { role: 'status' });

  dom.testCard = h('section.card.netv__card', { 'aria-label': 'Ziel prüfen' },
    h('div.card__head', null, h('h3', null, text('Ziel prüfen'))),
    h('div.card__body.stack', null,
      h('p.meta', null, text('Zeigt die Entscheidung der Schleuse, ohne eine Verbindung aufzubauen und ohne den Namen aufzulösen. Eine Namensauflösung wäre selbst schon ein Datenabfluss.')),
      h('div.netv__grid', null,
        h('label.field', null, h('span.label', null, text('Adresse')), dom.testHost),
        h('label.field', null, h('span.label', null, text('Port (optional)')), dom.testPort),
        h('label.field', null, h('span.label', null, text('Geltungsbereich')), dom.testScope)),
      h('div.row', null,
        h('button.btn.btn--primary.btn--small', { type: 'button', onClick: () => runTest(self) }, icon(ICONS.search), text('Prüfen'))),
      dom.testOut));

  /* ------------------------------ audit ----------------------------- */

  dom.auditFilter = h('input.input.netv__auditfilter', {
    type: 'search',
    placeholder: 'Nach Adresse, Grund oder Bereich filtern …',
    'aria-label': 'Protokoll filtern',
    autocomplete: 'off',
    onInput: () => {
      self.filter.textValue = dom.auditFilter.value;
      renderAudit(self);
    },
  });
  dom.auditDecision = h('select.select.netv__auditselect', {
    'aria-label': 'Nach Entscheidung filtern',
    onChange: () => {
      self.filter.decision = dom.auditDecision.value;
      renderAudit(self);
    },
  },
  h('option', { value: 'all' }, text('Alle Entscheidungen')),
  h('option', { value: 'allowed' }, text('Nur erlaubte')),
  h('option', { value: 'blocked' }, text('Nur blockierte')));

  dom.auditClass = h('select.select.netv__auditselect', {
    'aria-label': 'Nach Klassifikation filtern',
    onChange: () => {
      self.filter.classification = dom.auditClass.value;
      renderAudit(self);
    },
  },
  h('option', { value: 'all' }, text('Alle Ziele')),
  h('option', { value: 'loopback' }, text('Nur lokal')),
  h('option', { value: 'private' }, text('Nur lokales Netz')),
  h('option', { value: 'public' }, text('Nur öffentlich')));

  dom.pauseButton = h('button.btn.btn--small', {
    type: 'button',
    onClick: () => {
      self.paused = !self.paused;
      renderAudit(self);
    },
  }, text('Live anhalten'));

  dom.auditBody = h('tbody');
  dom.auditNote = h('p.netv__auditnote.meta');
  dom.auditCard = h('section.card.netv__card', { 'aria-label': 'Protokoll der Netzzugriffe' },
    h('div.card__head', null,
      h('h3', null, text('Protokoll der Netzzugriffe')),
      h('span.spacer'),
      dom.pauseButton,
      h('button.btn.btn--small', {
        type: 'button',
        onClick: async () => {
          await loadAudit(self);
          if (self.alive) renderAudit(self);
        },
      }, icon(ICONS.refresh), text('Neu laden'))),
    h('div.card__body.stack', null,
      h('p.meta', null, text('Jede Entscheidung der Schleuse – erlaubt wie blockiert – steht hier und in der Datei audit.jsonl im Neural-OS-Ordner. Ein Protokoll, das nur Ablehnungen zeigt, würde nichts beweisen.')),
      h('div.row', null, dom.auditFilter, dom.auditDecision, dom.auditClass),
      h('div.netv__tablewrap', null,
        h('table.table.netv__table', null,
          h('thead', null, h('tr', null,
            h('th', null, text('Zeit')),
            h('th', null, text('Ziel')),
            h('th', null, text('Klassifikation')),
            h('th', null, text('Entscheidung')),
            h('th', null, text('Grund')),
            h('th', null, text('Bereich')))),
          dom.auditBody)),
      dom.auditNote));

  dom.root = h('div.netv', null,
    h('div.page.page--wide.netv__page', null,
      dom.modePanel,
      explain,
      dom.policyCard,
      dom.grantCard,
      dom.testCard,
      dom.auditCard));
  container.appendChild(dom.root);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll(self) {
  renderMode(self);
  renderPolicy(self);
  renderGrants(self);
  renderAudit(self);
  renderTest(self);
}

function currentMode(self) {
  if (self.snapshot && typeof self.snapshot.mode === 'string') return self.snapshot.mode;
  return null;
}

function renderMode(self) {
  const { dom } = self;
  const mode = currentMode(self);
  const info = modeInfo(mode);

  dom.modePanel.dataset.mode = mode || 'unknown';

  clear(dom.modeLabel);
  dom.modeLabel.appendChild(text(info ? info.label : 'Unbekannt'));

  clear(dom.modeHeadline);
  dom.modeHeadline.appendChild(text(info ? info.headline : 'Der Netzmodus konnte nicht gelesen werden.'));

  clear(dom.modeBody);
  dom.modeBody.appendChild(text(info ? info.body : 'Solange der Server nicht antwortet, zeigt diese Seite keinen Modus an – auch nicht den zuletzt bekannten. Eine Anzeige, die rät, ist schlimmer als keine.'));

  clear(dom.modeFacts);
  const snapshot = self.snapshot;
  const reach = snapshot && snapshot.reachability ? snapshot.reachability : null;
  if (reach) {
    dom.modeFacts.appendChild(factNode('Dieses Gerät (127.0.0.1)', true, 'lokale Modelle laufen immer'));
    dom.modeFacts.appendChild(factNode('Lokales Netz', reach.lan === true, reach.lan === true ? 'erreichbar' : 'gesperrt'));
    dom.modeFacts.appendChild(factNode('Öffentliches Internet', reach.internet === true, reach.internet === true ? 'erreichbar' : 'gesperrt'));
  }
  if (snapshot && snapshot.stats) {
    const stats = snapshot.stats;
    dom.modeFacts.appendChild(h('li.netv__fact.netv__fact--plain', null,
      text(`${formatNumber(stats.allowed || 0)} erlaubt, ${formatNumber(stats.blocked || 0)} blockiert seit dem Start`
        + (stats.lastBlockedAt ? ` · zuletzt blockiert ${timeAgo(stats.lastBlockedAt)}` : ''))));
  }
  if (snapshot && snapshot.hardened === false) {
    dom.modeFacts.appendChild(h('li.netv__fact.netv__fact--plain', null,
      text('Hinweis: Die prozessweite Absicherung ist in diesem Start nicht aktiv. Die Schleuse entscheidet weiterhin über jeden Abruf, der durch sie läuft.')));
  }

  clear(dom.modeError);
  dom.modeError.hidden = !self.snapshotError;
  if (self.snapshotError) {
    dom.modeError.appendChild(text(`Die Netz-Einstellungen sind nicht abrufbar: ${errorMessage(self.snapshotError)}`));
  }

  clear(dom.modeButtons);
  for (const option of MODES) {
    const active = option.value === mode;
    const button = h('button.netv__modebtn', {
      type: 'button',
      disabled: self.busy,
      'aria-pressed': active ? 'true' : 'false',
      onClick: () => changeMode(self, option.value),
    },
    h('span.netv__modebtn-label', null, text(option.label)),
    h('span.netv__modebtn-sub', null, text(option.short)));
    button.dataset.mode = option.value;
    button.classList.toggle('is-active', active);
    dom.modeButtons.appendChild(button);
  }
}

function factNode(label, ok, note) {
  const node = h('li.netv__fact', null,
    h('span.netv__fact-icon', { 'aria-hidden': 'true' }, icon(ok ? ICONS.check : ICONS.block)),
    h('span.netv__fact-label', null, text(label)),
    h('span.netv__fact-note.meta', null, text(note)));
  node.dataset.ok = ok ? '1' : '0';
  return node;
}

function renderPolicy(self) {
  const { dom } = self;
  const snapshot = self.snapshot;
  const strict = !!(snapshot && snapshot.strictAllowlist);
  dom.strictBox.checked = strict;
  dom.strictBox.disabled = !snapshot || self.busy;

  clear(dom.strictHint);
  dom.strictHint.appendChild(text(strict
    ? 'Aktiv: Auch im Modus „Internet“ wird nur erreicht, was unten in der Freigabeliste steht.'
    : 'Aus: Im Modus „Internet“ ist jede öffentliche Adresse erreichbar. Die Freigabeliste wird dann nicht mehr geprüft.'));

  renderChips(self, dom.allowChips, 'allowHosts', snapshot ? snapshot.allowHosts : [], 'Noch keine Adresse freigegeben.');
  renderChips(self, dom.blockChips, 'blockHosts', snapshot ? snapshot.blockHosts : [], 'Keine Adresse dauerhaft gesperrt.');
}

function renderChips(self, box, key, hosts, emptyText) {
  clear(box);
  const list = Array.isArray(hosts) ? hosts : [];
  if (!list.length) {
    box.appendChild(h('span.meta', null, text(emptyText)));
    return;
  }
  for (const host of list) {
    box.appendChild(h('span.netv__chip', null,
      h('code', null, text(host)),
      h('button.netv__chip-x', {
        type: 'button',
        'aria-label': `${host} entfernen`,
        title: 'Entfernen',
        disabled: self.busy,
        onClick: () => removeHost(self, key, host),
      }, text('×'))));
  }
}

function renderGrants(self) {
  const box = self.dom.grantList;
  clear(box);
  const grants = (self.snapshot && Array.isArray(self.snapshot.grants)) ? self.snapshot.grants : [];
  if (!grants.length) {
    box.appendChild(h('p.meta', null, text('Es ist keine Freigabe aktiv. Es gilt ausschließlich der Modus oben.')));
    return;
  }

  for (const grant of grants) {
    const expires = grant.expiresAt ? Date.parse(grant.expiresAt) : NaN;
    const left = Number.isFinite(grant.maxUses) && grant.maxUses !== null
      ? Math.max(0, Number(grant.maxUses) - Number(grant.uses || 0))
      : null;
    box.appendChild(h('article.netv__grant', null,
      h('div.netv__grant-main', null,
        h('div.row', null,
          h('span.badge.netv__grant-level', { dataset: { level: grant.level || 'online' } },
            text(grant.level === 'lan' ? 'lokales Netz' : 'Internet')),
          h('code.code', null, text(String(grant.scope || 'global')))),
        h('p.netv__grant-hosts', null, text((grant.hosts || []).join(', ') || 'keine Adresse – erlaubt nichts')),
        h('p.meta', null, text([
          Number.isFinite(expires) ? `läuft ab ${formatDateTime(grant.expiresAt)} (${timeAgo(grant.expiresAt)})` : 'ohne Ablauf',
          left === null ? 'ohne Nutzungsgrenze' : `noch ${formatNumber(left)} Nutzung(en) übrig`,
          grant.reason ? `Grund: ${grant.reason}` : null,
        ].filter(Boolean).join(' · ')))),
      h('button.btn.btn--small', {
        type: 'button',
        disabled: self.busy,
        onClick: () => revokeGrant(self, grant.id),
      }, icon(ICONS.trash), text('Widerrufen'))));
  }
}

function renderAudit(self) {
  const { dom } = self;
  clear(dom.auditBody);

  clear(dom.pauseButton);
  dom.pauseButton.appendChild(text(self.paused ? 'Live fortsetzen' : 'Live anhalten'));

  if (self.auditError) {
    dom.auditBody.appendChild(h('tr', null, h('td.is-danger', { colspan: '6' },
      text(`Das Protokoll ist nicht abrufbar: ${errorMessage(self.auditError)}`))));
    clear(dom.auditNote);
    return;
  }
  if (self.auditLoading && !self.audit.length) {
    dom.auditBody.appendChild(h('tr', null, h('td.meta', { colspan: '6' }, text('Protokoll wird geladen …'))));
    clear(dom.auditNote);
    return;
  }

  const needle = self.filter.textValue.trim().toLowerCase();
  const rows = self.audit.filter((entry) => {
    if (self.filter.decision === 'allowed' && !entry.allowed) return false;
    if (self.filter.decision === 'blocked' && entry.allowed) return false;
    if (self.filter.classification !== 'all' && entry.classification !== self.filter.classification) return false;
    if (!needle) return true;
    return [entry.host, entry.ip, entry.reason, entry.scope, entry.purpose, entry.kind]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  if (!rows.length) {
    dom.auditBody.appendChild(h('tr', null, h('td.meta', { colspan: '6' },
      text(self.audit.length
        ? 'Kein Eintrag passt zu diesem Filter.'
        : 'Noch kein Netzzugriff verzeichnet. Das ist der erwartete Zustand im Offline-Modus.'))));
  }

  for (const entry of rows.slice(0, 300)) {
    const row = h('tr.netv__row', null,
      h('td.netv__cell-time', null, text(entry.at ? formatDateTime(entry.at) : '–')),
      h('td', null,
        h('code', null, text(targetLabel(entry))),
        entry.ip && entry.ip !== entry.host ? h('span.meta.netv__cell-ip', null, text(entry.ip)) : null),
      h('td', null, text(CLASSIFICATION_LABEL[entry.classification] || entry.classification || '–')),
      h('td', null, renderDecision(entry)),
      h('td.netv__cell-reason', null, text(entry.reason || AUDIT_KIND_LABEL[entry.kind] || '–')),
      h('td', null, h('code.netv__cell-scope', null, text(entry.scope || '–'))));
    row.dataset.allowed = entry.allowed ? '1' : '0';
    if (entry.live) row.classList.add('is-live');
    dom.auditBody.appendChild(row);
  }

  clear(dom.auditNote);
  dom.auditNote.appendChild(text(
    `${formatNumber(rows.length)} von ${formatNumber(self.audit.length)} Einträgen`
    + (self.paused ? ' · Live-Anzeige angehalten, neue Zugriffe werden nicht ergänzt.' : ' · neue Zugriffe erscheinen sofort.'),
  ));
}

function renderDecision(entry) {
  const label = entry.allowed
    ? (entry.level === 'local' ? 'erlaubt (lokal)' : 'erlaubt')
    : 'blockiert';
  const node = h('span.netv__decision', null,
    icon(entry.allowed ? ICONS.check : ICONS.block),
    text(label),
    entry.grantId ? h('span.meta', null, text(' · Freigabe')) : null);
  node.dataset.allowed = entry.allowed ? '1' : '0';
  return node;
}

function renderTest(self) {
  const box = self.dom.testOut;
  clear(box);
  if (self.testBusy) {
    box.appendChild(h('p.meta', null, text('Die Schleuse wird befragt …')));
    return;
  }
  if (self.testError) {
    box.appendChild(h('p.is-danger', null, text(self.testError)));
    return;
  }
  const result = self.testResult;
  if (!result) return;

  const decision = result.decision || {};
  const allowed = decision.allowed === true;
  const panel = h('div.netv__testresult', null,
    h('div.row', null,
      h('span.netv__decision', { dataset: { allowed: allowed ? '1' : '0' } },
        icon(allowed ? ICONS.check : ICONS.block),
        text(allowed ? 'Würde erlaubt' : 'Würde blockiert')),
      h('code', null, text(targetLabel({ host: decision.host || result.host, port: decision.port })))),
    h('p', null, text(decision.reason || 'Die Schleuse hat keinen Grund genannt.')),
    h('p.meta', null, text(`Klassifikation: ${CLASSIFICATION_LABEL[decision.classification || result.classification] || 'unbekannt'}`
      + (decision.level ? ` · Stufe: ${LEVEL_LABEL[decision.level] || decision.level}` : '')
      + (decision.grantId ? ` · über Freigabe ${decision.grantId}` : ''))),
    h('p.meta', null, text(result.note || 'Es wurde keine Verbindung aufgebaut.')));
  panel.dataset.allowed = allowed ? '1' : '0';
  box.appendChild(panel);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function changeMode(self, mode) {
  if (self.busy) return;
  const previous = currentMode(self);
  if (mode === previous) return;

  if (mode === 'online') {
    const ok = await self.ctx.confirm({
      title: 'Internetzugang einschalten?',
      message: 'Ab dann dürfen Chats, Agenten und Werkzeuge öffentliche Server erreichen. Alles, was dabei in eine Anfrage geschrieben wird – auch Auszüge aus deinen Notizen –, verlässt dieses Gerät. Jeder Zugriff wird unten protokolliert, und du kannst jederzeit zurückschalten.',
      confirmLabel: 'Internet erlauben',
      cancelLabel: 'Offline bleiben',
      danger: true,
    });
    if (!ok || !self.alive) return;
  } else if (mode === 'lan') {
    const ok = await self.ctx.confirm({
      title: 'Lokales Netz freigeben?',
      message: 'Geräte im eigenen Netz werden erreichbar, etwa ein Modellserver auf einem anderen Rechner. Das öffentliche Internet bleibt gesperrt.',
      confirmLabel: 'Lokales Netz erlauben',
    });
    if (!ok || !self.alive) return;
  }

  await writeNetwork(self, { mode }, mode === 'offline'
    ? 'Offline. Es verlässt nichts mehr dieses Gerät.'
    : `Modus gewechselt: ${modeInfo(mode) ? modeInfo(mode).label : mode}.`);
}

async function saveStrict(self) {
  const next = self.dom.strictBox.checked === true;
  if (!next) {
    const ok = await self.ctx.confirm({
      title: 'Strikte Freigabeliste abschalten?',
      message: 'Ohne sie ist im Modus „Internet“ jede öffentliche Adresse erreichbar, nicht nur die eingetragenen. Im Offline-Modus ändert sich dadurch nichts.',
      confirmLabel: 'Abschalten',
      danger: true,
    });
    if (!ok || !self.alive) {
      self.dom.strictBox.checked = true;
      return;
    }
  }
  await writeNetwork(self, { strictAllowlist: next }, next ? 'Strikte Freigabeliste aktiv.' : 'Strikte Freigabeliste abgeschaltet.');
}

async function addHost(self, key, input) {
  const entries = parseHosts(input.value);
  if (!entries.length) return;
  const snapshot = self.snapshot || {};
  const current = Array.isArray(snapshot[key]) ? snapshot[key] : [];
  const next = [...current];
  for (const entry of entries) if (!next.includes(entry)) next.push(entry);
  if (next.length === current.length) {
    input.value = '';
    return;
  }
  const done = await writeNetwork(self, { [key]: next }, key === 'allowHosts' ? 'Adresse freigegeben.' : 'Adresse gesperrt.');
  if (done) input.value = '';
}

async function removeHost(self, key, host) {
  const snapshot = self.snapshot || {};
  const current = Array.isArray(snapshot[key]) ? snapshot[key] : [];
  const next = current.filter((entry) => entry !== host);
  if (next.length === current.length) return;
  await writeNetwork(self, { [key]: next }, key === 'allowHosts' ? 'Freigabe entfernt.' : 'Sperre entfernt.');
}

/**
 * One write path for every policy change: PUT, then adopt the server's own
 * answer. The panel never shows a policy the server has not confirmed.
 */
async function writeNetwork(self, patch, successMessage) {
  self.busy = true;
  renderMode(self);
  renderPolicy(self);
  try {
    const result = await request(self, (signal) => self.api.put('/network', patch, { signal }));
    if (!self.alive) return false;
    self.snapshot = result;
    self.snapshotError = null;
    if (result && result.persisted === false) {
      self.ctx.toast('Die Änderung gilt sofort, konnte aber nicht dauerhaft gespeichert werden.', 'error');
    } else if (successMessage) {
      self.ctx.toast(successMessage, 'success');
    }
    return true;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return false;
    self.ctx.toast(`Änderung abgelehnt: ${errorMessage(err)}`, 'error');
    // Re-read rather than guess: the server is the authority on what is set.
    await loadNetwork(self);
    return false;
  } finally {
    self.busy = false;
    if (self.alive) {
      renderMode(self);
      renderPolicy(self);
      renderGrants(self);
    }
  }
}

async function createGrant(self) {
  const { dom } = self;
  const scope = String(dom.grantScope.value || '').trim() || 'global';
  const hosts = parseHosts(dom.grantHosts.value);
  if (!hosts.length) {
    self.ctx.toast('Eine Freigabe ohne Adresse erlaubt nichts. Trage mindestens eine ein – „*“ steht für alle.', 'error');
    dom.grantHosts.focus();
    return;
  }
  const minutes = Number.parseInt(dom.grantMinutes.value, 10);
  const uses = Number.parseInt(dom.grantUses.value, 10);
  const body = {
    scope,
    level: dom.grantLevel.value === 'lan' ? 'lan' : 'online',
    hosts,
    reason: String(dom.grantReason.value || '').trim(),
  };
  if (Number.isFinite(minutes) && minutes > 0) {
    body.expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
  }
  if (Number.isFinite(uses) && uses > 0) body.maxUses = uses;

  if (body.level === 'online') {
    const ok = await self.ctx.confirm({
      title: 'Freigabe ins Internet erteilen?',
      message: `Für ${hosts.join(', ')} wird der Netzzugang geöffnet – unabhängig vom Modus oben, bis die Freigabe abläuft oder du sie widerrufst.`,
      confirmLabel: 'Freigabe erteilen',
      danger: true,
    });
    if (!ok || !self.alive) return;
  }

  try {
    await request(self, (signal) => self.api.post('/network/grants', body, { signal }));
    if (!self.alive) return;
    dom.grantHosts.value = '';
    dom.grantReason.value = '';
    await loadNetwork(self);
    if (!self.alive) return;
    renderGrants(self);
    renderMode(self);
    self.ctx.toast('Freigabe erteilt.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Freigabe abgelehnt: ${errorMessage(err)}`, 'error');
  }
}

async function revokeGrant(self, id) {
  const ok = await self.ctx.confirm({
    title: 'Freigabe widerrufen?',
    message: 'Laufende Abrufe, die sich auf diese Freigabe stützen, werden danach blockiert.',
    confirmLabel: 'Widerrufen',
    danger: true,
  });
  if (!ok || !self.alive) return;
  try {
    await request(self, (signal) => self.api.del(`/network/grants/${encodeURIComponent(id)}`, { signal }));
    if (!self.alive) return;
    await loadNetwork(self);
    if (!self.alive) return;
    renderGrants(self);
    renderMode(self);
    self.ctx.toast('Freigabe widerrufen.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(`Widerruf fehlgeschlagen: ${errorMessage(err)}`, 'error');
  }
}

async function runTest(self) {
  const host = String(self.dom.testHost.value || '').trim();
  if (!host) {
    self.testError = 'Trage eine Adresse ein, die geprüft werden soll.';
    renderTest(self);
    self.dom.testHost.focus();
    return;
  }
  const port = Number.parseInt(self.dom.testPort.value, 10);
  const scope = String(self.dom.testScope.value || '').trim() || 'global';

  self.testBusy = true;
  self.testError = null;
  renderTest(self);
  try {
    const body = { host, scope };
    if (Number.isFinite(port) && port > 0) body.port = port;
    const result = await request(self, (signal) => self.api.post('/network/test', body, { signal }));
    if (!self.alive) return;
    self.testResult = { ...result, host };
    self.testError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.testResult = null;
    self.testError = `Die Prüfung ist fehlgeschlagen: ${errorMessage(err)}`;
  } finally {
    self.testBusy = false;
    if (self.alive) renderTest(self);
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
.netv { height: 100%; overflow-y: auto; }
.netv__page { display: flex; flex-direction: column; gap: var(--sp-3); max-width: 1000px; }

.netv__mode {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--border-strong);
  border-left: 6px solid var(--net-unknown);
  border-radius: var(--r-3);
  background: var(--surface);
  box-shadow: var(--shadow-1);
}
.netv__mode[data-mode="offline"] { border-left-color: var(--net-offline); }
.netv__mode[data-mode="lan"] { border-left-color: var(--net-lan); }
.netv__mode[data-mode="online"] { border-left-color: var(--net-online); }
.netv__mode-main { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.netv__mode-kicker { font-size: var(--fs-sm); letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-subtle); }
.netv__mode-label { font-size: var(--fs-2xl); font-weight: 600; line-height: var(--lh-tight); }
.netv__mode[data-mode="offline"] .netv__mode-label { color: var(--net-offline); }
.netv__mode[data-mode="lan"] .netv__mode-label { color: var(--net-lan); }
.netv__mode[data-mode="online"] .netv__mode-label { color: var(--net-online); }
.netv__mode-headline { margin: 0; font-size: var(--fs-md); font-weight: 500; }
.netv__mode-body { margin: 0; color: var(--fg-muted); max-width: 62ch; }
.netv__mode-error { margin: 0; }
.netv__facts { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); margin: var(--sp-1) 0 0; padding: 0; list-style: none; }
.netv__fact { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); }
.netv__fact svg { width: 15px; height: 15px; }
.netv__fact[data-ok="1"] .netv__fact-icon { color: var(--ok); }
.netv__fact[data-ok="0"] .netv__fact-icon { color: var(--fg-subtle); }
.netv__fact--plain { color: var(--fg-muted); width: 100%; }
.netv__mode-side { display: flex; align-items: center; }
.netv__modebtns { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 190px; }
.netv__modebtn {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--sp-1) var(--sp-2);
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.netv__modebtn:hover:not(:disabled) { background: var(--surface-3); }
.netv__modebtn:disabled { opacity: 0.6; cursor: not-allowed; }
.netv__modebtn.is-active { border-width: 2px; }
.netv__modebtn[data-mode="offline"].is-active { border-color: var(--net-offline); color: var(--net-offline); }
.netv__modebtn[data-mode="lan"].is-active { border-color: var(--net-lan); color: var(--net-lan); }
.netv__modebtn[data-mode="online"].is-active { border-color: var(--net-online); color: var(--net-online); }
.netv__modebtn-label { font-weight: 600; }
.netv__modebtn-sub { font-size: var(--fs-sm); color: var(--fg-muted); }

.netv__explain { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--sp-2); }
.netv__explain-item h4 { margin: 0 0 var(--sp-05); font-size: var(--fs-base); }
.netv__explain-item[data-mode="offline"] h4 { color: var(--net-offline); }
.netv__explain-item[data-mode="lan"] h4 { color: var(--net-lan); }
.netv__explain-item[data-mode="online"] h4 { color: var(--net-online); }
.netv__explain-item p { margin: 0; color: var(--fg-muted); font-size: var(--fs-sm); }

.netv__strict { display: flex; gap: var(--sp-1); padding: var(--sp-1); border: 1px solid var(--border); border-radius: var(--r-2); cursor: pointer; }
.netv__strict-box { padding-top: 2px; }
.netv__strict-body { display: flex; flex-direction: column; gap: 2px; }
.netv__strict-label { font-weight: 500; }
.netv__hint { font-size: var(--fs-sm); color: var(--fg-muted); }

.netv__chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--sp-05); }
.netv__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  background: var(--surface-3);
  border-radius: var(--r-full);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.netv__chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: var(--r-full);
  background: none;
  color: var(--fg-muted);
  cursor: pointer;
  font-size: var(--fs-base);
  line-height: 1;
}
.netv__chip-x:hover { background: var(--danger-soft); color: var(--danger); }

.netv__grants { display: flex; flex-direction: column; gap: var(--sp-1); }
.netv__grant {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.netv__grant-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.netv__grant-hosts { margin: 0; font-family: var(--font-mono); font-size: var(--fs-sm); word-break: break-all; }
.netv__grant-level[data-level="online"] { color: var(--danger); background: var(--danger-soft); }
.netv__newgrant > summary { cursor: pointer; font-size: var(--fs-sm); color: var(--fg-muted); }
.netv__newgrant-body { margin-top: var(--sp-1); }
.netv__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--sp-2); }

.netv__testout { min-height: 0; }
.netv__testresult { padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface-2); }
.netv__testresult[data-allowed="0"] { border-color: var(--danger); }
.netv__testresult[data-allowed="1"] { border-color: var(--ok); }
.netv__testresult p { margin: var(--sp-05) 0 0; }
.netv__decision { display: inline-flex; align-items: center; gap: 4px; font-weight: 500; }
.netv__decision svg { width: 15px; height: 15px; }
.netv__decision[data-allowed="1"] { color: var(--ok); }
.netv__decision[data-allowed="0"] { color: var(--danger); }

.netv__auditfilter { flex: 1 1 220px; }
.netv__auditselect { width: auto; flex: 0 0 auto; }
.netv__tablewrap { overflow-x: auto; }
.netv__table { min-width: 720px; }
.netv__table td { vertical-align: top; }
.netv__cell-time { white-space: nowrap; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.netv__cell-ip { display: block; }
.netv__cell-reason { max-width: 32ch; }
.netv__cell-scope { font-size: var(--fs-xs); }
.netv__row[data-allowed="0"] { background: color-mix(in srgb, var(--danger) 6%, transparent); }
.netv__row.is-live td { animation: netv-fade var(--dur-2) var(--ease); }
.netv__auditnote { margin: 0; }

@keyframes netv-fade { from { background: var(--accent-soft); } to { background: transparent; } }

@media (prefers-reduced-motion: reduce) {
  .netv__row.is-live td { animation: none; }
}

@media (max-width: 820px) {
  .netv__mode { grid-template-columns: 1fr; }
  .netv__modebtns { flex-direction: row; flex-wrap: wrap; min-width: 0; }
  .netv__modebtn { flex: 1 1 140px; }
}
`;
