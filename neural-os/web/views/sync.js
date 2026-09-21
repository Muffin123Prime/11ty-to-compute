/**
 * views/sync.js -- "Abgleich": partner devices, and the one screen where the
 * user decides which version of their own text survives.
 *
 * Decisions worth explaining
 * --------------------------
 * 1. **Conflict resolution is the point of this view, not a footnote.** Every
 *    other panel here is scaffolding around it. A conflict is shown as both
 *    versions side by side with a real line diff between them, each side
 *    carrying its own timestamp, revision and origin, and each button saying
 *    in plain German what is lost by pressing it. Nothing is preselected and
 *    no version is marked "recommended": the server refuses to guess (see
 *    `src/sync/merge.js`), and a interface that guesses on its behalf would
 *    put the guess back exactly where it was removed from.
 * 2. **The diff is written here, by hand.** A longest-common-subsequence over
 *    lines, with the common prefix and suffix trimmed first and a hard cell
 *    budget. Beyond that budget the two versions are shown as one changed
 *    block and the panel says so, rather than freezing the tab or pretending
 *    to a precision it did not compute.
 * 3. **The safe direction is cheap, the destructive one is not.** Keeping the
 *    local version destroys nothing on this device and needs no confirmation.
 *    Taking the partner's version overwrites what is here, so it asks once,
 *    with the consequence spelled out. Same asymmetry as `views/network.js`.
 * 4. **Progress is not invented.** A synchronisation is one request whose
 *    duration nothing here can predict, so the bar is indeterminate and the
 *    live lines underneath come from real bus events (`sync.applied`,
 *    `sync.conflict`, `sync.warning`). A percentage would be a decoration
 *    that lies.
 * 5. **The summary is the server's own count.** Übernommen, Konflikte,
 *    Übersprungen and every warning come straight out of the answer to
 *    `POST /api/peers/:id/sync`. When a run was truncated or a partner left
 *    records unmentioned, that is shown, not smoothed away.
 * 6. **Tokens go in and never come back.** The API returns `hasToken` and
 *    nothing else, so this view can never display a partner's access token --
 *    not even to the person who typed it.
 */

import {
  h, text, clear, icon, timeAgo, formatDateTime, formatNumber,
} from '../lib/dom.js';

/* ------------------------------------------------------------------ */
/* Vocabulary (German UI copy)                                         */
/* ------------------------------------------------------------------ */

const VIEW_ICON = '<rect x="2.5" y="4" width="7" height="12" rx="1.8"/><rect x="12" y="6.5" width="5.5" height="9" rx="1.6"/>'
  + '<path d="M10.4 8.6h1.1M10.4 11.4h1.1"/>';

const ICONS = {
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  plug: '<path d="M7.2 3.4v3.8M12.8 3.4v3.8"/><path d="M5.4 7.2h9.2v2.6a4.6 4.6 0 0 1-9.2 0z"/><path d="M10 14.4v2.4"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  edit: '<path d="M13.2 3.9a1.7 1.7 0 0 1 2.4 2.4L7.4 14.5l-3.2.8.8-3.2z"/>',
  close: '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>',
  device: '<rect x="4.2" y="2.6" width="11.6" height="14.8" rx="2.4"/><path d="M8.6 14.8h2.8"/>',
};

const TYPE_LABELS = {
  note: 'Notiz',
  chat: 'Chat',
  project: 'Projekt',
  task: 'Aufgabe',
  entity: 'Entität',
  memory: 'Erinnerung',
  message: 'Nachricht',
  file: 'Datei',
  edge: 'Verknüpfung',
};

const DIRECTION_LABELS = {
  both: 'holen und senden',
  pull: 'nur holen',
  push: 'nur senden',
};

const LEVEL_LABELS = {
  lan: 'nur im eigenen Netz',
  online: 'auch über das Internet',
};

/**
 * The record types that travel between devices, as `src/sync/merge.js`
 * defines them. Repeated here only as UI copy -- the server is the authority
 * and refuses anything else; this list exists so the user can read what is
 * actually at stake before switching the first partner on.
 */
const SYNC_TYPE_COPY = 'Notizen, Projekte, Aufgaben, Entitäten, Erinnerungen, Chats samt Nachrichten, '
  + 'Dateien und Verknüpfungen';
const NO_SYNC_TYPE_COPY = 'Zugangstoken, Netz-Freigaben, Agenten mit ihren Berechtigungen, die Partnerliste selbst '
  + 'sowie Läufe, Bestätigungen und Konflikte';

/** Matches `merge.DEFAULT_SKEW_TOLERANCE_MS`; above it the server stops trusting timestamps. */
const SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Cell budget for the line diff: above it the two versions are shown as one block. */
const DIFF_MAX_CELLS = 640000;
/** Unchanged lines shown around a change before the rest is folded away. */
const DIFF_CONTEXT = 3;

const BODY_FIELDS = ['body', 'description', 'text', 'content', 'goal', 'result', 'summary', 'systemPrompt'];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

function typeLabel(type) {
  return TYPE_LABELS[type] || type || 'Datensatz';
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

/** "4 Sekunden vor", "2 Minuten nach" -- the partner clock against this one. */
function skewLabel(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unbekannt';
  const abs = Math.abs(ms);
  if (abs < 1500) return 'keine messbare Abweichung';
  const seconds = Math.round(abs / 1000);
  const value = seconds < 120 ? `${seconds} Sekunden` : `${Math.round(seconds / 60)} Minuten`;
  return ms > 0 ? `${value} vor dieser Uhr` : `${value} hinter dieser Uhr`;
}

function peerStatus(peer) {
  if (peer.enabled === false) return { kind: 'off', label: 'abgeschaltet' };
  if (peer.lastError) return { kind: 'error', label: 'letzter Versuch fehlgeschlagen' };
  if (peer.openConflicts) return { kind: 'conflict', label: `${formatNumber(peer.openConflicts)} offene Konflikte` };
  if (peer.lastSyncAt) return { kind: 'ok', label: `abgeglichen ${timeAgo(peer.lastSyncAt)}` };
  return { kind: 'new', label: 'noch nie abgeglichen' };
}

/* ------------------------------------------------------------------ */
/* Record rendering and the line diff                                  */
/* ------------------------------------------------------------------ */

/**
 * Turn a record into the lines the diff compares.
 *
 * Body-ish fields come first and keep their own line breaks, because that is
 * where the user's text lives and where a diff has to be exact. Everything
 * else follows as `feld: wert`, sorted, so that two versions of the same
 * record always produce the same line order -- otherwise key order alone
 * would show up as a difference.
 */
function recordToLines(record) {
  if (!record || record.absent) return [];
  const lines = [];
  if (record.deletedAt) lines.push(`(gelöscht am ${formatDateTime(record.deletedAt)})`);
  const data = record.data && typeof record.data === 'object' ? record.data : {};
  const used = new Set();

  for (const field of BODY_FIELDS) {
    const value = data[field];
    if (typeof value !== 'string' || !value.length) continue;
    used.add(field);
    lines.push(`${field}:`);
    for (const line of value.replace(/\r\n/g, '\n').split('\n')) lines.push(`  ${line}`);
  }

  for (const key of Object.keys(data).filter((k) => !used.has(k)).sort()) {
    const value = data[key];
    if (value === null || value === undefined) {
      lines.push(`${key}: –`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}: ${value.length ? value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ') : '(leer)'}`);
    } else if (typeof value === 'object') {
      const json = JSON.stringify(value, null, 2).split('\n');
      lines.push(`${key}: ${json[0]}`);
      for (let i = 1; i < json.length; i += 1) lines.push(`  ${json[i]}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines;
}

/**
 * Longest common subsequence over lines.
 *
 * The table is the classic O(n·m) one. It is honest about its cost: the
 * caller trims the common prefix and suffix first and checks the budget, so
 * this only ever runs over the part that actually differs.
 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((line) => ({ op: 'add', a: null, b: line }));
  if (!m) return a.map((line) => ({ op: 'remove', a: line, b: null }));

  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] = a[i] === b[j]
        ? table[(i + 1) * w + (j + 1)] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'equal', a: a[i], b: b[j] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
      ops.push({ op: 'remove', a: a[i], b: null });
      i += 1;
    } else {
      ops.push({ op: 'add', a: null, b: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ op: 'remove', a: a[i], b: null });
    i += 1;
  }
  while (j < m) {
    ops.push({ op: 'add', a: null, b: b[j] });
    j += 1;
  }
  return ops;
}

/** @returns {{ops:Array, exact:boolean, changed:number}} */
function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ op: 'equal', a: a[i], b: b[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let exact = true;
  if (midA.length * midB.length > DIFF_MAX_CELLS) {
    exact = false;
    for (const line of midA) ops.push({ op: 'remove', a: line, b: null });
    for (const line of midB) ops.push({ op: 'add', a: null, b: line });
  } else {
    for (const op of lcsOps(midA, midB)) ops.push(op);
  }

  for (let i = endA; i < a.length; i += 1) ops.push({ op: 'equal', a: a[i], b: b[endB + (i - endA)] });

  const changed = ops.reduce((n, op) => (op.op === 'equal' ? n : n + 1), 0);
  return { ops, exact, changed };
}

/**
 * Pair the operations into side-by-side rows. A block of removals next to a
 * block of additions becomes rows that line up, which is what makes "this
 * sentence became that sentence" readable instead of "six lines gone, six
 * lines new".
 */
function pairRows(ops) {
  const rows = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === 'equal') {
      rows.push({ kind: 'equal', left: ops[i].a, right: ops[i].b });
      i += 1;
      continue;
    }
    const removes = [];
    const adds = [];
    while (i < ops.length && ops[i].op !== 'equal') {
      if (ops[i].op === 'remove') removes.push(ops[i].a);
      else adds.push(ops[i].b);
      i += 1;
    }
    const count = Math.max(removes.length, adds.length);
    for (let k = 0; k < count; k += 1) {
      const left = k < removes.length ? removes[k] : null;
      const right = k < adds.length ? adds[k] : null;
      rows.push({
        kind: left !== null && right !== null ? 'changed' : (left !== null ? 'removed' : 'added'),
        left,
        right,
      });
    }
  }
  return rows;
}

/** Fold long stretches of identical lines so the differences stand out. */
function foldRows(rows, expanded) {
  if (expanded) return rows.map((row) => ({ ...row }));
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].kind === 'equal') continue;
    for (let k = Math.max(0, i - DIFF_CONTEXT); k <= Math.min(rows.length - 1, i + DIFF_CONTEXT); k += 1) keep[k] = true;
  }
  const out = [];
  let hidden = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (keep[i]) {
      if (hidden) {
        out.push({ kind: 'fold', hidden });
        hidden = 0;
      }
      out.push(rows[i]);
    } else {
      hidden += 1;
    }
  }
  if (hidden) out.push({ kind: 'fold', hidden });
  return out;
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'sync',
  title: 'Abgleich',
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

      peers: [],
      deviceId: null,
      protocol: null,
      peersError: null,
      peersLoading: true,

      conflicts: [],
      conflictsError: null,
      conflictsLoading: true,
      conflictFilter: 'open',
      expandedDiffs: new Set(),
      busyConflicts: new Set(),

      tests: new Map(), // peerId -> {busy, result, error}
      results: new Map(), // peerId -> last sync summary
      busyPeers: new Set(),
      runLog: [],
      running: false,

      editing: null, // peer id being edited, or 'new'
      formError: null,
    };
    view = self;

    buildLayout(self);
    subscribe(self);
    await Promise.all([loadPeers(self), loadConflicts(self)]);
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

async function loadPeers(self) {
  self.peersLoading = true;
  try {
    const result = await request(self, (signal) => self.api.get('/peers', { signal }));
    if (!self.alive) return;
    self.peers = Array.isArray(result && result.items) ? result.items : [];
    self.deviceId = (result && result.deviceId) || null;
    self.protocol = (result && result.protocol) !== undefined ? result.protocol : null;
    self.peersError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.peers = [];
    self.peersError = err;
  } finally {
    self.peersLoading = false;
  }
}

async function loadConflicts(self) {
  self.conflictsLoading = true;
  try {
    const result = await request(self, (signal) => self.api.get('/conflicts', {
      query: { status: self.conflictFilter, limit: 200 },
      signal,
    }));
    if (!self.alive) return;
    self.conflicts = Array.isArray(result && result.items) ? result.items : [];
    self.conflictsError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.conflicts = [];
    self.conflictsError = err;
  } finally {
    self.conflictsLoading = false;
  }
}

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;

  self.cleanups.push(ctx.bus.on('sync.applied', (payload) => {
    if (!self.alive || !payload) return;
    const name = peerName(self, payload.peerId);
    const parts = payload.direction === 'push'
      ? [`gesendet ${formatNumber(payload.sent || 0)}`, `angenommen ${formatNumber(payload.accepted || 0)}`,
        `abgelehnt ${formatNumber(payload.rejected || 0)}`, `Konflikte ${formatNumber(payload.conflicts || 0)}`]
      : [`geholt ${formatNumber(payload.fetched || 0)}`, `übernommen ${formatNumber(payload.applied || 0)}`,
        `Konflikte ${formatNumber(payload.conflicts || 0)}`, `übersprungen ${formatNumber(payload.skipped || 0)}`];
    pushLog(self, `${name}: ${payload.direction === 'push' ? 'gesendet' : 'geholt'} – ${parts.join(', ')}`);
  }));

  self.cleanups.push(ctx.bus.on('sync.warning', (payload) => {
    if (!self.alive || !payload) return;
    pushLog(self, `${peerName(self, payload.peerId)}: ${payload.message || 'Warnung'}`, 'warn');
  }));

  self.cleanups.push(ctx.bus.on('sync.conflict', (payload) => {
    if (!self.alive || !payload) return;
    if (payload.action !== 'resolved' && payload.count) {
      pushLog(self, `${peerName(self, payload.peerId)}: ${formatNumber(payload.count)} Konflikte vorgelegt`, 'warn');
    }
    loadConflicts(self).then(() => {
      if (self.alive) renderConflicts(self);
    });
  }));

  self.cleanups.push(ctx.bus.on('sync.peer', () => {
    if (!self.alive) return;
    loadPeers(self).then(() => {
      if (self.alive) renderPeers(self);
    });
  }));
}

function peerName(self, peerId) {
  const peer = self.peers.find((p) => p.id === peerId);
  return peer ? peer.name : 'Partnergerät';
}

function pushLog(self, message, kind = 'info') {
  self.runLog.unshift({ at: new Date().toISOString(), message, kind });
  if (self.runLog.length > 60) self.runLog.length = 60;
  renderRunPanel(self);
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.intro = h('section.card.syncv__card', { 'aria-label': 'Was ein Abgleich tut' });
  dom.peerList = h('div.syncv__peers');
  dom.peerForm = h('div.syncv__form');
  dom.runPanel = h('div.syncv__run', { hidden: true, role: 'status', 'aria-live': 'polite' });
  dom.conflictHead = h('div.card__head');
  dom.conflictBody = h('div.card__body.stack');
  dom.deviceNote = h('p.meta.syncv__device');

  const peerCard = h('section.card.syncv__card', { 'aria-label': 'Partnergeräte' },
    h('div.card__head', null,
      h('h3', null, text('Partnergeräte')),
      h('span.spacer'),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => syncAll(self),
      }, icon(ICONS.refresh), text('Alle abgleichen'))),
    h('div.card__body.stack', null,
      dom.peerList,
      dom.runPanel,
      dom.peerForm,
      dom.deviceNote));

  dom.conflictCard = h('section.card.syncv__card.syncv__card--conflicts', { 'aria-label': 'Konflikte' },
    dom.conflictHead,
    dom.conflictBody);

  dom.page = h('div.page.page--wide.syncv', null,
    h('div.page__head', null,
      h('div', null,
        h('h1.page__title', null, text('Abgleich')),
        h('p.page__subtitle', null, text(
          'Zwei eigene Geräte halten denselben Wissensstand – direkt miteinander, ohne Zwischenstation.')))),
    h('div.stack', null, dom.intro, dom.conflictCard, peerCard));

  container.appendChild(dom.page);
}

function renderAll(self) {
  renderIntro(self);
  renderPeers(self);
  renderForm(self);
  renderRunPanel(self);
  renderConflicts(self);
}

/* ------------------------------------------------------------------ */
/* The explanation                                                     */
/* ------------------------------------------------------------------ */

function renderIntro(self) {
  const node = self.dom.intro;
  clear(node);
  node.appendChild(h('div.card__head', null, h('h3', null, text('Was beim Abgleich wirklich passiert'))));
  node.appendChild(h('div.card__body.stack.syncv__intro', null,
    h('p', null, text(
      'Ein Abgleich überträgt Daten von diesem Gerät an das andere und holt dessen Daten hierher. '
      + 'Das ist eine echte Datenübertragung: Was hier steht, steht danach auch dort.')),
    h('p', null, text(
      'Beide Geräte müssen dafür gleichzeitig laufen und sich erreichen können – in der Regel im selben '
      + 'Netz. Es gibt keine Zwischenablage, keinen Server dazwischen und keinen fremden Cloud-Anbieter. '
      + 'Ist das andere Gerät aus, passiert schlicht nichts; nichts geht dabei verloren.')),
    h('p', null, text(
      `Abgeglichen werden: ${SYNC_TYPE_COPY}. Bewusst nicht abgeglichen werden: ${NO_SYNC_TYPE_COPY}. `
      + 'Ein Partnergerät kann sich darüber also weder Rechte noch Netzzugang verschaffen.')),
    h('p', null, text(
      'Haben beide Geräte denselben Eintrag geändert, wird hier nichts überschrieben. Der Eintrag landet '
      + 'unten als Konflikt mit beiden Fassungen, und du entscheidest.')),
    h('p.hint', null, text(
      'Der Abgleich braucht mindestens den Netzmodus „Lokales Netz“ oder eine Freigabe für den '
      + 'Geltungsbereich sync:<Partner>. Im Modus „Offline“ lehnt die Schleuse ihn ab – das ist richtig so '
      + 'und wird im Netzwerk-Bereich geändert.'))));
}

/* ------------------------------------------------------------------ */
/* Peers                                                               */
/* ------------------------------------------------------------------ */

function renderPeers(self) {
  const { dom } = self;
  clear(dom.peerList);

  clear(dom.deviceNote);
  if (self.deviceId) {
    dom.deviceNote.appendChild(text(
      `Kennung dieses Geräts: ${self.deviceId}${self.protocol !== null ? ` · Protokollfassung ${self.protocol}` : ''}. `
      + 'Auf dem Partnergerät brauchst du ein Zugangstoken mit dem Recht „sync“ (Einstellungen → Freigabe).'));
  }

  if (self.peersError) {
    dom.peerList.appendChild(h('div.syncv__error', { role: 'alert' },
      h('span.syncv__error-icon', null, icon(ICONS.alert)),
      h('div', null,
        h('p', null, text('Die Partnerliste konnte nicht gelesen werden.')),
        h('p.meta', null, text(errorMessage(self.peersError))),
        h('button.btn.btn--small', {
          type: 'button',
          onClick: () => loadPeers(self).then(() => renderPeers(self)),
        }, text('Erneut versuchen')))));
    return;
  }

  if (self.peersLoading && !self.peers.length) {
    dom.peerList.appendChild(h('p.meta', { role: 'status' }, text('Partnergeräte werden gelesen …')));
    return;
  }

  if (!self.peers.length) {
    dom.peerList.appendChild(h('div.empty', null,
      h('h2', null, text('Noch kein Partnergerät')),
      h('p', { style: { maxWidth: '48ch' } }, text(
        'Trage unten die Adresse des anderen Geräts ein – etwa http://192.168.1.20:7777 – und das Token, '
        + 'das du dort unter Einstellungen → Freigabe angelegt hast. Ohne Token weist das andere Gerät '
        + 'jede Anfrage ab, und das ist gut so.'))));
    return;
  }

  for (const peer of self.peers) dom.peerList.appendChild(renderPeerRow(self, peer));
}

function renderPeerRow(self, peer) {
  const status = peerStatus(peer);
  const busy = self.busyPeers.has(peer.id);
  const test = self.tests.get(peer.id) || null;
  const result = self.results.get(peer.id) || null;

  const facts = [
    `${DIRECTION_LABELS[peer.direction] || peer.direction}`,
    `${LEVEL_LABELS[peer.maxLevel] || peer.maxLevel}`,
    peer.hasToken ? 'Token hinterlegt' : 'kein Token',
  ];
  if (peer.knownRecords) facts.push(`${formatNumber(peer.knownRecords)} bekannte Einträge`);

  return h('article.syncv__peer', { dataset: { status: status.kind } },
    h('div.syncv__peer-head', null,
      h('span.syncv__peer-icon', { 'aria-hidden': 'true' }, icon(ICONS.device)),
      h('div.syncv__peer-main', null,
        h('h4.syncv__peer-name', null, text(peer.name || hostOf(peer.url))),
        h('p.syncv__peer-url', null, text(peer.url)),
        h('p.meta', null, text(facts.join(' · ')))),
      h('span.syncv__status', { dataset: { kind: status.kind } }, text(status.label))),

    peer.lastError
      ? h('p.syncv__peer-error', null, text(peer.lastError))
      : null,

    h('div.row.syncv__peer-actions', null,
      h('button.btn.btn--small', {
        type: 'button',
        disabled: busy,
        title: 'Fragt das andere Gerät nach Fassung, Anzahl der Einträge und Uhrzeit. Es wird nichts übertragen.',
        onClick: () => testPeer(self, peer),
      }, icon(ICONS.plug), text('Verbindung prüfen')),
      h('button.btn.btn--small.btn--primary', {
        type: 'button',
        disabled: busy || peer.enabled === false,
        onClick: () => syncPeer(self, peer),
      }, icon(ICONS.refresh), text('Jetzt abgleichen')),
      h('span.spacer'),
      h('button.icon-button', {
        type: 'button',
        title: 'Partnergerät bearbeiten',
        'aria-label': `${peer.name} bearbeiten`,
        onClick: () => {
          self.editing = peer.id;
          self.formError = null;
          renderForm(self);
        },
      }, icon(ICONS.edit)),
      h('button.icon-button', {
        type: 'button',
        title: 'Partnergerät entfernen',
        'aria-label': `${peer.name} entfernen`,
        onClick: () => removePeer(self, peer),
      }, icon(ICONS.trash))),

    test && (test.busy || test.result || test.error) ? renderTestResult(self, peer, test) : null,
    result ? renderSyncSummary(self, peer, result) : null);
}

function renderTestResult(self, peer, test) {
  if (test.busy) {
    return h('div.syncv__panel', { role: 'status' },
      h('p.meta', null, text(`„${peer.name}“ wird angefragt …`)));
  }
  if (test.error) {
    return h('div.syncv__panel', { dataset: { tone: 'bad' } },
      h('p', null, text('Die Prüfung selbst ist fehlgeschlagen.')),
      h('p.meta', null, text(errorMessage(test.error))));
  }

  const r = test.result;
  if (!r.reachable) {
    return h('div.syncv__panel', { dataset: { tone: 'bad' } },
      h('p.syncv__decision', { dataset: { ok: '0' } }, icon(ICONS.alert), text('Nicht erreichbar')),
      h('p.meta', null, text(r.error || 'Das Gerät hat nicht geantwortet.')),
      h('p.hint', null, text(
        'Läuft Neural OS auf dem anderen Gerät? Stimmen Adresse und Port? Erlaubt der Netzmodus hier '
        + 'überhaupt eine Verbindung dorthin?')));
  }

  const skew = r.clockSkewMs;
  const skewBad = Number.isFinite(skew) && Math.abs(skew) > SKEW_TOLERANCE_MS;
  return h('div.syncv__panel', { dataset: { tone: skewBad ? 'warn' : 'good' } },
    h('p.syncv__decision', { dataset: { ok: '1' } }, icon(ICONS.check), text('Erreichbar')),
    h('dl.syncv__facts', null,
      fact('Protokollfassung', r.version === null ? 'unbekannt' : String(r.version)),
      fact('Programmfassung', r.appVersion || 'unbekannt'),
      fact('Datensätze dort', r.recordCount === null ? 'unbekannt' : formatNumber(r.recordCount)),
      fact('Antwortzeit', r.roundTripMs === null ? 'unbekannt' : `${formatNumber(r.roundTripMs)} ms`),
      fact('Uhr des Partners', skewLabel(skew)),
      fact('Gerätekennung', r.deviceId || 'unbekannt')),
    skewBad
      ? h('p.syncv__warn', null, text(
        'Die Uhren der beiden Geräte laufen zu weit auseinander. Der Abgleich läuft trotzdem, legt aber '
        + 'eingehende Löschungen als Konflikt vor, statt sie auszuführen – Zeitstempel taugen hier nicht '
        + 'als Entscheidungsgrundlage.'))
      : null,
    r.warning ? h('p.syncv__warn', null, text(r.warning)) : null);
}

function fact(label, value) {
  return h('div.syncv__fact', null,
    h('dt', null, text(label)),
    h('dd', null, text(value)));
}

function renderSyncSummary(self, peer, result) {
  const rows = [];
  if (result.pull) {
    rows.push(h('li', null, text(
      `Geholt: ${formatNumber(result.pull.fetched || 0)} Änderungen angesehen, `
      + `${formatNumber(result.pull.applied || 0)} übernommen, `
      + `${formatNumber(result.pull.conflicts || 0)} Konflikte, `
      + `${formatNumber(result.pull.skipped || 0)} übersprungen.`)));
  }
  if (result.push) {
    rows.push(h('li', null, text(
      `Gesendet: ${formatNumber(result.push.sent || 0)} Änderungen, `
      + `${formatNumber(result.push.accepted || 0)} angenommen, `
      + `${formatNumber(result.push.rejected || 0)} abgelehnt, `
      + `${formatNumber(result.push.conflicts || 0)} Konflikte.`)));
  }
  if (result.error) {
    rows.push(h('li.is-danger', null, text(result.error)));
  }

  const warnings = [
    ...((result.pull && result.pull.warnings) || []),
    ...((result.push && result.push.warnings) || []),
  ];
  const conflicts = ((result.pull && result.pull.conflicts) || 0) + ((result.push && result.push.conflicts) || 0);

  return h('div.syncv__panel', { dataset: { tone: result.error ? 'bad' : (conflicts ? 'warn' : 'good') } },
    h('p.syncv__panel-title', null, text(`Ergebnis vom ${formatDateTime(result.at)}`)),
    rows.length ? h('ul.syncv__summary', null, ...rows) : h('p.meta', null, text('Es gab nichts zu tun.')),
    result.pull && result.pull.truncated
      ? h('p.syncv__warn', null, text(
        'Es wurde nicht alles geholt – die Obergrenze für einen Durchgang war erreicht. Starte den Abgleich '
        + 'erneut, um den Rest zu holen.'))
      : null,
    ...warnings.map((warning) => h('p.syncv__warn', null, text(warning))),
    conflicts
      ? h('button.btn.btn--small', {
        type: 'button',
        onClick: () => {
          const card = self.dom.conflictCard;
          if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start' });
        },
      }, text(`${formatNumber(conflicts)} Konflikte ansehen`))
      : null);
}

/* ------------------------------------------------------------------ */
/* Peer actions                                                        */
/* ------------------------------------------------------------------ */

async function testPeer(self, peer) {
  self.tests.set(peer.id, { busy: true, result: null, error: null });
  renderPeers(self);
  try {
    const result = await request(self, (signal) => self.api.post(`/peers/${encodeURIComponent(peer.id)}/test`, null, {
      signal,
      timeoutMs: 40000,
    }));
    if (!self.alive) return;
    self.tests.set(peer.id, { busy: false, result, error: null });
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.tests.set(peer.id, { busy: false, result: null, error: err });
  }
  await loadPeers(self);
  if (self.alive) renderPeers(self);
}

async function syncPeer(self, peer) {
  if (self.busyPeers.has(peer.id)) return;
  self.busyPeers.add(peer.id);
  self.running = true;
  self.runLog = [];
  pushLog(self, `Abgleich mit „${peer.name}“ gestartet.`);
  renderPeers(self);
  renderRunPanel(self);

  try {
    const result = await request(self, (signal) => self.api.post(
      `/peers/${encodeURIComponent(peer.id)}/sync`,
      { direction: peer.direction || 'both' },
      { signal, timeoutMs: 0 },
    ));
    if (!self.alive) return;
    self.results.set(peer.id, { ...result, at: new Date().toISOString(), error: null });
    const conflicts = ((result.pull && result.pull.conflicts) || 0) + ((result.push && result.push.conflicts) || 0);
    pushLog(self, conflicts
      ? `Abgleich mit „${peer.name}“ beendet – ${formatNumber(conflicts)} Konflikte warten auf deine Entscheidung.`
      : `Abgleich mit „${peer.name}“ beendet.`, conflicts ? 'warn' : 'ok');
    self.ctx.toast(conflicts
      ? `Abgleich beendet: ${formatNumber(conflicts)} Konflikte offen.`
      : 'Abgleich beendet.', conflicts ? 'info' : 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.results.set(peer.id, { pull: null, push: null, at: new Date().toISOString(), error: errorMessage(err) });
    pushLog(self, `Abgleich mit „${peer.name}“ fehlgeschlagen: ${errorMessage(err)}`, 'error');
    self.ctx.toast(errorMessage(err), 'error');
  } finally {
    self.busyPeers.delete(peer.id);
    self.running = self.busyPeers.size > 0;
  }
  await Promise.all([loadPeers(self), loadConflicts(self)]);
  if (!self.alive) return;
  renderPeers(self);
  renderRunPanel(self);
  renderConflicts(self);
}

async function syncAll(self) {
  if (self.running) return;
  if (!self.peers.some((peer) => peer.enabled !== false)) {
    self.ctx.toast('Es ist kein eingeschaltetes Partnergerät eingetragen.', 'info');
    return;
  }
  self.running = true;
  self.runLog = [];
  pushLog(self, 'Abgleich mit allen eingeschalteten Geräten gestartet.');
  renderRunPanel(self);
  renderPeers(self);

  try {
    const result = await request(self, (signal) => self.api.post('/sync', null, { signal, timeoutMs: 0 }));
    if (!self.alive) return;
    for (const entry of (result && result.peers) || []) {
      self.results.set(entry.peerId, {
        pull: entry.pull,
        push: entry.push,
        at: result.finishedAt || new Date().toISOString(),
        error: entry.error || null,
      });
    }
    pushLog(self, result && result.ok
      ? 'Alle Geräte abgeglichen.'
      : 'Abgleich beendet – mindestens ein Gerät hat nicht geantwortet.', result && result.ok ? 'ok' : 'warn');
    if (result && result.openConflicts) {
      pushLog(self, `${formatNumber(result.openConflicts)} Konflikte warten auf deine Entscheidung.`, 'warn');
    }
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    pushLog(self, `Abgleich fehlgeschlagen: ${errorMessage(err)}`, 'error');
    self.ctx.toast(errorMessage(err), 'error');
  } finally {
    self.running = false;
  }
  await Promise.all([loadPeers(self), loadConflicts(self)]);
  if (!self.alive) return;
  renderPeers(self);
  renderRunPanel(self);
  renderConflicts(self);
}

async function removePeer(self, peer) {
  const ok = await self.ctx.confirm({
    title: `„${peer.name}“ entfernen?`,
    message: 'Das Partnergerät wird aus dieser Liste gestrichen, samt hinterlegtem Token und dem gemerkten '
      + 'Abgleichstand. Deine Daten bleiben unangetastet – auf beiden Geräten.',
    confirmLabel: 'Entfernen',
    danger: true,
  });
  if (!ok || !self.alive) return;
  try {
    await request(self, (signal) => self.api.del(`/peers/${encodeURIComponent(peer.id)}`, { signal }));
    self.tests.delete(peer.id);
    self.results.delete(peer.id);
    self.ctx.toast(`„${peer.name}“ wurde entfernt.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(errorMessage(err), 'error');
  }
  await loadPeers(self);
  if (!self.alive) return;
  renderPeers(self);
  // The form may still be pointing at the peer that just disappeared.
  renderForm(self);
}

/* ------------------------------------------------------------------ */
/* The peer form                                                       */
/* ------------------------------------------------------------------ */

function renderForm(self) {
  const { dom } = self;
  clear(dom.peerForm);

  if (!self.editing) {
    dom.peerForm.appendChild(h('button.btn.btn--small', {
      type: 'button',
      onClick: () => {
        self.editing = 'new';
        self.formError = null;
        renderForm(self);
      },
    }, icon(ICONS.plus), text('Partnergerät hinzufügen')));
    return;
  }

  const existing = self.editing === 'new' ? null : self.peers.find((p) => p.id === self.editing);
  if (self.editing !== 'new' && !existing) {
    self.editing = null;
    renderForm(self);
    return;
  }

  const fields = {};
  fields.name = h('input.input', { type: 'text', value: existing ? existing.name : '', placeholder: 'z. B. Arbeitsrechner', autocomplete: 'off' });
  fields.url = h('input.input', { type: 'text', value: existing ? existing.url : '', placeholder: 'http://192.168.1.20:7777', autocomplete: 'off', spellcheck: 'false' });
  fields.token = h('input.input', {
    type: 'password',
    value: '',
    placeholder: existing && existing.hasToken ? 'unverändert lassen' : 'Token vom anderen Gerät',
    autocomplete: 'off',
  });
  fields.direction = h('select.select', null,
    ...Object.entries(DIRECTION_LABELS).map(([value, label]) => h('option', {
      value,
      selected: (existing ? existing.direction : 'both') === value,
    }, text(label))));
  fields.maxLevel = h('select.select', null,
    ...Object.entries(LEVEL_LABELS).map(([value, label]) => h('option', {
      value,
      selected: (existing ? existing.maxLevel : 'lan') === value,
    }, text(label))));
  fields.enabled = h('input', { type: 'checkbox', checked: existing ? existing.enabled !== false : true });

  const error = h('p.is-danger', { hidden: !self.formError, role: 'alert' }, text(self.formError || ''));

  dom.peerForm.appendChild(h('div.syncv__formbox', null,
    h('h4', null, text(existing ? `„${existing.name}“ bearbeiten` : 'Partnergerät hinzufügen')),
    h('div.syncv__grid', null,
      h('label.field', null, h('span.label', null, text('Name')), fields.name),
      h('label.field', null, h('span.label', null, text('Adresse')), fields.url)),
    h('label.field', null,
      h('span.label', null, text('Token')),
      fields.token,
      h('span.hint', null, text(
        'Das Token stammt vom ANDEREN Gerät: dort unter Einstellungen → Freigabe anlegen, mit dem Recht „sync“. '
        + 'Es wird hier gespeichert und nie wieder angezeigt.'))),
    h('details.syncv__advanced', null,
      h('summary', null, text('Weitere Einstellungen')),
      h('div.stack.syncv__advanced-body', null,
        h('div.syncv__grid', null,
          h('label.field', null, h('span.label', null, text('Richtung')), fields.direction),
          h('label.field', null, h('span.label', null, text('Erlaubte Netzstufe')), fields.maxLevel)),
        h('label.row', null, fields.enabled, h('span', null, text('Dieses Gerät ist eingeschaltet'))),
        h('p.hint', null, text(
          '„Auch über das Internet“ erlaubt der Schleuse noch nichts – sie braucht zusätzlich den passenden '
          + 'Netzmodus oder eine Freigabe. Beides zusammen ist Absicht.')))),
    error,
    h('div.row', null,
      h('button.btn.btn--primary.btn--small', {
        type: 'button',
        onClick: () => savePeer(self, existing, fields),
      }, text(existing ? 'Änderungen speichern' : 'Hinzufügen')),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => {
          self.editing = null;
          self.formError = null;
          renderForm(self);
        },
      }, text('Abbrechen')))));
}

async function savePeer(self, existing, fields) {
  const body = {
    name: fields.name.value.trim(),
    url: fields.url.value.trim(),
    direction: fields.direction.value,
    maxLevel: fields.maxLevel.value,
    enabled: fields.enabled.checked,
  };
  const token = fields.token.value;
  // An empty token field on an edit means "leave it alone" -- sending an empty
  // string would silently delete the credential and reset the agreed state.
  if (token || !existing) body.token = token;

  try {
    if (existing) await request(self, (signal) => self.api.patch(`/peers/${encodeURIComponent(existing.id)}`, body, { signal }));
    else await request(self, (signal) => self.api.post('/peers', body, { signal }));
    if (!self.alive) return;
    self.editing = null;
    self.formError = null;
    self.ctx.toast(existing ? 'Partnergerät geändert.' : 'Partnergerät hinzugefügt.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.formError = errorMessage(err);
    renderForm(self);
    return;
  }
  await loadPeers(self);
  if (!self.alive) return;
  renderPeers(self);
  renderForm(self);
}

/* ------------------------------------------------------------------ */
/* Run panel                                                           */
/* ------------------------------------------------------------------ */

function renderRunPanel(self) {
  const node = self.dom.runPanel;
  if (!node) return;
  clear(node);
  if (!self.running && !self.runLog.length) {
    node.hidden = true;
    return;
  }
  node.hidden = false;

  node.appendChild(h('div.syncv__run-head', null,
    h('strong', null, text(self.running ? 'Abgleich läuft …' : 'Letzter Durchgang')),
    h('span.spacer'),
    self.running
      ? null
      : h('button.icon-button', {
        type: 'button',
        title: 'Protokoll leeren',
        'aria-label': 'Protokoll leeren',
        onClick: () => {
          self.runLog = [];
          renderRunPanel(self);
        },
      }, icon(ICONS.close))));

  if (self.running) {
    // Indeterminate on purpose: nothing here knows how much is still coming,
    // and a bar that pretends to know is worse than one that admits it.
    node.appendChild(h('div.syncv__bar', { role: 'progressbar', 'aria-label': 'Abgleich läuft' },
      h('span.syncv__bar-fill')));
  }

  node.appendChild(h('ul.syncv__log', null,
    ...self.runLog.map((entry) => h('li.syncv__log-row', { dataset: { kind: entry.kind } },
      h('span.syncv__log-time', null, text(formatDateTime(entry.at))),
      h('span', null, text(entry.message))))));
}

/* ------------------------------------------------------------------ */
/* Conflicts -- the heart of this view                                 */
/* ------------------------------------------------------------------ */

function renderConflicts(self) {
  const { dom } = self;
  clear(dom.conflictHead);
  clear(dom.conflictBody);

  const open = self.conflicts.filter((c) => c.status === 'open').length;

  dom.conflictHead.appendChild(h('h3', null, text('Konflikte')));
  dom.conflictHead.appendChild(h('span.spacer'));
  dom.conflictHead.appendChild(h('div.segmented', { role: 'group', 'aria-label': 'Konflikte filtern' },
    ...[['open', 'Offen'], ['resolved', 'Entschieden'], ['all', 'Alle']].map(([value, label]) =>
      h('button.segmented__option', {
        type: 'button',
        class: self.conflictFilter === value ? 'is-active' : '',
        onClick: () => {
          if (self.conflictFilter === value) return;
          self.conflictFilter = value;
          renderConflicts(self);
          loadConflicts(self).then(() => {
            if (self.alive) renderConflicts(self);
          });
        },
      }, text(label)))));

  if (self.conflictsError) {
    dom.conflictBody.appendChild(h('div.syncv__error', { role: 'alert' },
      h('span.syncv__error-icon', null, icon(ICONS.alert)),
      h('div', null,
        h('p', null, text('Die Konflikte konnten nicht gelesen werden.')),
        h('p.meta', null, text(errorMessage(self.conflictsError))))));
    return;
  }

  if (self.conflictsLoading && !self.conflicts.length) {
    dom.conflictBody.appendChild(h('p.meta', { role: 'status' }, text('Konflikte werden gelesen …')));
    return;
  }

  if (!self.conflicts.length) {
    dom.conflictBody.appendChild(h('div.empty', null,
      h('h2', null, text(self.conflictFilter === 'open' ? 'Keine offenen Konflikte' : 'Nichts vorhanden')),
      h('p', { style: { maxWidth: '48ch' } }, text(self.conflictFilter === 'open'
        ? 'Solange beide Geräte denselben Eintrag nicht gleichzeitig ändern, gibt es hier nichts zu tun. '
          + 'Passiert es doch, wird nichts überschrieben – der Eintrag landet hier mit beiden Fassungen.'
        : 'In dieser Auswahl liegt nichts.'))));
    return;
  }

  if (open && self.conflictFilter !== 'resolved') {
    dom.conflictBody.appendChild(h('p.syncv__lead', null, text(
      `${formatNumber(open)} ${open === 1 ? 'Eintrag wurde' : 'Einträge wurden'} auf beiden Geräten geändert. `
      + 'Beide Fassungen sind vollständig erhalten. Es ist nichts vorausgewählt: '
      + 'erst deine Entscheidung verändert etwas.')));
  }

  for (const conflict of self.conflicts) dom.conflictBody.appendChild(renderConflict(self, conflict));
}

function renderConflict(self, conflict) {
  const local = conflict.local && !conflict.local.absent ? conflict.local : null;
  const remote = conflict.remote || null;
  const partner = peerName(self, conflict.peerId);
  const busy = self.busyConflicts.has(conflict.id);
  const resolved = conflict.status === 'resolved';
  const label = titleOf(local, remote, conflict);

  const head = h('div.syncv__conflict-head', null,
    h('div.syncv__conflict-title', null,
      h('span.badge', null, text(typeLabel(conflict.recordType))),
      h('h4', null, text(label)),
      h('p.meta', null, text(`${conflict.recordId} · aufgetreten ${timeAgo(conflict.createdAt)} · Partner: ${partner}`))),
    resolved
      ? h('span.syncv__status', { dataset: { kind: 'ok' } },
        text(conflict.resolution === 'remote'
          ? `Fassung von „${partner}“ übernommen`
          : 'eigene Fassung behalten'))
      : h('span.syncv__status', { dataset: { kind: 'conflict' } }, text('offen')));

  const node = h('article.syncv__conflict', { dataset: { state: resolved ? 'resolved' : 'open' } }, head);

  if (conflict.reason) node.appendChild(h('p.syncv__conflict-reason', null, text(conflict.reason)));

  if (!remote) {
    node.appendChild(h('p.is-danger', null, text(
      'Zu diesem Konflikt fehlt die Fassung des Partners. Er lässt sich damit nicht auflösen; ein erneuter '
      + 'Abgleich legt ihn vollständig noch einmal vor.')));
    return node;
  }

  node.appendChild(renderDiff(self, conflict, local, remote, partner));

  if (resolved) {
    node.appendChild(h('p.meta', null, text(
      `Entschieden ${timeAgo(conflict.resolvedAt)} (${formatDateTime(conflict.resolvedAt)}).`)));
    return node;
  }

  node.appendChild(h('div.syncv__stakes', null,
    h('p.syncv__stakes-title', null, text('Was deine Entscheidung bedeutet')),
    h('ul', null,
      h('li', null, text(local
        ? `Eigene Fassung behalten: Auf diesem Gerät ändert sich nichts. Beim nächsten Abgleich ersetzt `
          + `deine Fassung die von „${partner}“ – die dortige Fassung ist danach fort.`
        : `Eigene Fassung behalten: Dieser Eintrag existiert hier nicht und bleibt es. Beim nächsten `
          + `Abgleich wird er auch auf „${partner}“ entfernt.`)),
      h('li', null, text(local
        ? `Fassung von „${partner}“ übernehmen: Die Fassung auf diesem Gerät wird überschrieben und ist `
          + 'danach nicht mehr da.'
        : `Fassung von „${partner}“ übernehmen: Der Eintrag wird auf diesem Gerät angelegt.`)))));

  node.appendChild(h('div.row.syncv__decide', null,
    h('button.btn.btn--small', {
      type: 'button',
      disabled: busy,
      onClick: () => resolveConflict(self, conflict, 'local', partner),
    }, text('Eigene Fassung behalten')),
    h('button.btn.btn--small.btn--danger', {
      type: 'button',
      disabled: busy,
      onClick: () => resolveConflict(self, conflict, 'remote', partner),
    }, text(`Fassung von „${partner}“ übernehmen`)),
    busy ? h('span.meta', { role: 'status' }, text('wird gespeichert …')) : null));

  return node;
}

function titleOf(local, remote, conflict) {
  const pick = (record) => {
    const d = (record && record.data) || {};
    for (const key of ['title', 'name', 'goal', 'text', 'content']) {
      if (typeof d[key] === 'string' && d[key].trim()) return d[key].trim().slice(0, 120);
    }
    return '';
  };
  return pick(local) || pick(remote) || `${typeLabel(conflict.recordType)} ${String(conflict.recordId).slice(-6)}`;
}

function renderDiff(self, conflict, local, remote, partner) {
  const leftLines = recordToLines(local);
  const rightLines = recordToLines(remote);
  const diff = diffLines(leftLines, rightLines);
  const expanded = self.expandedDiffs.has(conflict.id);
  const rows = foldRows(pairRows(diff.ops), expanded);
  const hiddenTotal = rows.reduce((n, row) => (row.kind === 'fold' ? n + row.hidden : n), 0);

  const sideHead = (title, record, tone) => h('div.syncv__side-head', { dataset: { tone } },
    h('strong', null, text(title)),
    h('span.meta', null, text(record
      ? `${formatDateTime(record.updatedAt)}${Number.isFinite(record.rev) ? ` · Fassung ${record.rev}` : ''}`
        + `${record.deletedAt ? ' · gelöscht' : ''}`
      : 'nicht vorhanden')));

  const body = h('div.syncv__diff', { role: 'table', 'aria-label': 'Zeilenweiser Vergleich beider Fassungen' });
  for (const row of rows) {
    if (row.kind === 'fold') {
      body.appendChild(h('div.syncv__diff-fold', { role: 'row' },
        text(`${formatNumber(row.hidden)} unveränderte ${row.hidden === 1 ? 'Zeile' : 'Zeilen'}`)));
      continue;
    }
    body.appendChild(h('div.syncv__diff-row', { role: 'row', dataset: { kind: row.kind } },
      h('div.syncv__diff-cell', { role: 'cell', dataset: { side: 'left' } },
        row.left === null ? null : text(row.left || ' ')),
      h('div.syncv__diff-cell', { role: 'cell', dataset: { side: 'right' } },
        row.right === null ? null : text(row.right || ' '))));
  }

  return h('div.syncv__compare', null,
    h('div.syncv__sides', null,
      sideHead('Dieses Gerät', local, 'local'),
      sideHead(`„${partner}“`, remote, 'remote')),
    diff.changed === 0
      ? h('p.meta', null, text('Die beiden Fassungen sind zeilenweise gleich – der Konflikt kommt aus einem '
        + 'anderen Feld oder aus einer Löschung.'))
      : null,
    body,
    h('div.row.syncv__diff-foot', null,
      h('span.meta', null, text(`${formatNumber(diff.changed)} geänderte Zeilen`)),
      hiddenTotal
        ? h('button.btn.btn--small.btn--ghost', {
          type: 'button',
          onClick: () => {
            self.expandedDiffs.add(conflict.id);
            renderConflicts(self);
          },
        }, text(`${formatNumber(hiddenTotal)} unveränderte Zeilen einblenden`))
        : null,
      expanded
        ? h('button.btn.btn--small.btn--ghost', {
          type: 'button',
          onClick: () => {
            self.expandedDiffs.delete(conflict.id);
            renderConflicts(self);
          },
        }, text('Unveränderte Zeilen ausblenden'))
        : null,
      diff.exact
        ? null
        : h('span.syncv__warn', null, text(
          'Die Fassungen sind zu umfangreich für einen zeilengenauen Vergleich. Sie werden als ein '
          + 'geänderter Block gezeigt – links vollständig die alte, rechts vollständig die neue Fassung.'))));
}

async function resolveConflict(self, conflict, resolution, partner) {
  if (self.busyConflicts.has(conflict.id)) return;

  if (resolution === 'remote') {
    const hasLocal = conflict.local && !conflict.local.absent;
    const ok = await self.ctx.confirm({
      title: `Fassung von „${partner}“ übernehmen?`,
      message: hasLocal
        ? 'Die Fassung auf diesem Gerät wird damit überschrieben. Sie lässt sich danach nicht '
          + 'zurückholen – nur der Partner hält sie dann noch, bis auch dort abgeglichen wird.'
        : 'Der Eintrag des Partners wird auf diesem Gerät angelegt.',
      confirmLabel: 'Übernehmen',
      danger: hasLocal,
    });
    if (!ok || !self.alive) return;
  }

  self.busyConflicts.add(conflict.id);
  renderConflicts(self);
  try {
    await request(self, (signal) => self.api.post(`/conflicts/${encodeURIComponent(conflict.id)}`, { resolution }, { signal }));
    if (!self.alive) return;
    self.ctx.toast(resolution === 'remote'
      ? `Fassung von „${partner}“ übernommen.`
      : 'Eigene Fassung behalten.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ctx.toast(errorMessage(err), 'error');
  } finally {
    self.busyConflicts.delete(conflict.id);
  }
  await Promise.all([loadConflicts(self), loadPeers(self)]);
  if (!self.alive) return;
  renderConflicts(self);
  renderPeers(self);
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-sync-view-style';

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS; // authored here, never user data
  document.head.appendChild(node);
}

const CSS = `
.syncv { max-width: 1100px; }
.syncv__card { overflow: hidden; }
.syncv__intro p { margin: 0; max-width: 72ch; }
.syncv__device { margin: 0; word-break: break-all; }

.syncv__peers { display: flex; flex-direction: column; gap: var(--sp-2); }
.syncv__peer {
  display: flex; flex-direction: column; gap: var(--sp-1);
  padding: var(--sp-2);
  border: 1px solid var(--border); border-left: 4px solid var(--fg-subtle);
  border-radius: var(--r-2); background: var(--surface-2);
}
.syncv__peer[data-status="ok"] { border-left-color: var(--ok); }
.syncv__peer[data-status="error"] { border-left-color: var(--danger); }
.syncv__peer[data-status="conflict"] { border-left-color: var(--warn); }
.syncv__peer[data-status="off"] { opacity: 0.72; }
.syncv__peer-head { display: flex; align-items: flex-start; gap: var(--sp-1); }
.syncv__peer-icon { color: var(--fg-subtle); flex: 0 0 auto; }
.syncv__peer-main { flex: 1 1 auto; min-width: 0; }
.syncv__peer-name { margin: 0; font-size: var(--fs-md); word-break: break-word; }
.syncv__peer-url { margin: 1px 0 2px; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--fg-muted); word-break: break-all; }
.syncv__peer-error { margin: 0; color: var(--danger); font-size: var(--fs-sm); }
.syncv__peer-actions { margin-top: var(--sp-05); }

.syncv__status {
  flex: 0 0 auto; padding: 2px 8px; border-radius: var(--r-full);
  font-size: var(--fs-xs); font-weight: 500; background: var(--surface-3); color: var(--fg-muted);
}
.syncv__status[data-kind="ok"] { color: var(--ok); }
.syncv__status[data-kind="error"] { color: var(--danger); background: var(--danger-soft); }
.syncv__status[data-kind="conflict"] { color: var(--warn); }

.syncv__panel {
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface);
}
.syncv__panel[data-tone="good"] { border-color: var(--ok); }
.syncv__panel[data-tone="warn"] { border-color: var(--warn); }
.syncv__panel[data-tone="bad"] { border-color: var(--danger); }
.syncv__panel p { margin: var(--sp-05) 0 0; }
.syncv__panel p:first-child { margin-top: 0; }
.syncv__panel-title { font-weight: 600; }
.syncv__decision { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.syncv__decision svg { width: 15px; height: 15px; }
.syncv__decision[data-ok="1"] { color: var(--ok); }
.syncv__decision[data-ok="0"] { color: var(--danger); }
.syncv__warn { color: var(--warn); font-size: var(--fs-sm); }
.syncv__summary { margin: var(--sp-05) 0 0; padding-left: var(--sp-3); font-size: var(--fs-sm); }

.syncv__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--sp-1); margin: var(--sp-1) 0 0; }
.syncv__fact dt { font-size: var(--fs-xs); color: var(--fg-subtle); }
.syncv__fact dd { margin: 0; font-size: var(--fs-sm); word-break: break-all; }

.syncv__formbox {
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--r-2);
}
.syncv__formbox h4 { margin: 0; font-size: var(--fs-md); }
.syncv__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--sp-2); }
.syncv__advanced > summary { cursor: pointer; font-size: var(--fs-sm); color: var(--fg-muted); }
.syncv__advanced-body { margin-top: var(--sp-1); }

.syncv__run { padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface-2); }
.syncv__run-head { display: flex; align-items: center; gap: var(--sp-1); }
.syncv__bar { position: relative; height: 4px; margin: var(--sp-1) 0; overflow: hidden; background: var(--surface-3); border-radius: var(--r-full); }
.syncv__bar-fill { position: absolute; top: 0; bottom: 0; width: 34%; background: var(--accent); border-radius: var(--r-full); animation: syncv-slide 1.1s var(--ease) infinite; }
@keyframes syncv-slide { from { left: -34%; } to { left: 100%; } }
.syncv__log { display: flex; flex-direction: column; gap: 2px; margin: var(--sp-05) 0 0; padding: 0; list-style: none; font-size: var(--fs-sm); }
.syncv__log-row { display: flex; gap: var(--sp-1); }
.syncv__log-row[data-kind="warn"] { color: var(--warn); }
.syncv__log-row[data-kind="error"] { color: var(--danger); }
.syncv__log-row[data-kind="ok"] { color: var(--ok); }
.syncv__log-time { flex: 0 0 auto; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }

.syncv__error { display: flex; gap: var(--sp-1); padding: var(--sp-1); border: 1px solid var(--danger); border-radius: var(--r-2); }
.syncv__error-icon { color: var(--danger); flex: 0 0 auto; }
.syncv__error p { margin: 0 0 2px; }
.syncv__lead { margin: 0; max-width: 72ch; }

.syncv__conflict {
  display: flex; flex-direction: column; gap: var(--sp-1);
  padding: var(--sp-2);
  border: 1px solid var(--border-strong); border-left: 4px solid var(--warn);
  border-radius: var(--r-2); background: var(--surface-2);
}
.syncv__conflict[data-state="resolved"] { border-left-color: var(--ok); opacity: 0.85; }
.syncv__conflict-head { display: flex; align-items: flex-start; gap: var(--sp-1); }
.syncv__conflict-title { flex: 1 1 auto; min-width: 0; }
.syncv__conflict-title h4 { margin: 2px 0 0; font-size: var(--fs-md); word-break: break-word; }
.syncv__conflict-title .meta { word-break: break-all; }
.syncv__conflict-reason { margin: 0; color: var(--fg-muted); font-size: var(--fs-sm); }

.syncv__compare { display: flex; flex-direction: column; gap: var(--sp-05); }
.syncv__sides { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; }
.syncv__side-head { display: flex; flex-direction: column; gap: 1px; padding: var(--sp-05) var(--sp-1); border-radius: var(--r-1) var(--r-1) 0 0; }
.syncv__side-head[data-tone="local"] { background: color-mix(in srgb, var(--danger) 10%, var(--surface)); }
.syncv__side-head[data-tone="remote"] { background: color-mix(in srgb, var(--ok) 10%, var(--surface)); }

.syncv__diff {
  display: flex; flex-direction: column;
  max-height: 26rem; overflow: auto;
  border: 1px solid var(--border); border-radius: 0 0 var(--r-1) var(--r-1);
  background: var(--surface);
  font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.5;
}
.syncv__diff-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; }
.syncv__diff-cell { padding: 1px var(--sp-05); white-space: pre-wrap; word-break: break-word; min-height: 1.5em; }
.syncv__diff-cell:empty { background: repeating-linear-gradient(135deg, transparent, transparent 5px, var(--surface-3) 5px, var(--surface-3) 10px); }
.syncv__diff-row[data-kind="removed"] .syncv__diff-cell[data-side="left"],
.syncv__diff-row[data-kind="changed"] .syncv__diff-cell[data-side="left"] { background: var(--danger-soft); }
.syncv__diff-row[data-kind="added"] .syncv__diff-cell[data-side="right"],
.syncv__diff-row[data-kind="changed"] .syncv__diff-cell[data-side="right"] { background: color-mix(in srgb, var(--ok) 14%, transparent); }
.syncv__diff-fold { padding: 2px var(--sp-1); color: var(--fg-subtle); background: var(--surface-3); text-align: center; font-family: var(--font-sans); }
.syncv__diff-foot { gap: var(--sp-1); }

.syncv__stakes {
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border-strong); border-radius: var(--r-2); background: var(--surface);
}
.syncv__stakes-title { margin: 0 0 var(--sp-05); font-weight: 600; font-size: var(--fs-sm); }
.syncv__stakes ul { margin: 0; padding-left: var(--sp-3); font-size: var(--fs-sm); }
.syncv__stakes li + li { margin-top: 3px; }
.syncv__decide { margin-top: var(--sp-05); }

@media (prefers-reduced-motion: reduce) {
  .syncv__bar-fill { animation: none; width: 100%; left: 0; opacity: 0.5; }
}

@media (max-width: 760px) {
  .syncv__sides, .syncv__diff-row { grid-template-columns: 1fr; }
  .syncv__diff-cell[data-side="left"] { border-bottom: 1px solid var(--border); }
  .syncv__diff-cell:empty { display: none; }
}
`;
