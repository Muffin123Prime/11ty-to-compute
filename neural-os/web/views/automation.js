/**
 * views/automation.js -- "Automatik": the things that run without being asked.
 *
 * The decisions behind it
 * -----------------------
 * 1. **The switch is the screen.** Everything else on a card -- agent, goal,
 *    hour, filters -- is detail; the one fact a user must never be unsure
 *    about is whether this thing runs on its own. So the switch is the largest
 *    control, it is read out as "Läuft von allein" rather than "Aktiv", the
 *    card is marked along its whole left edge when it is on, and the page
 *    opens with a single sentence counting how many things run by themselves.
 *    In a system whose promise is "nothing happens behind your back", a subtle
 *    toggle would be the wrong kind of elegant.
 * 2. **Everything starts switched off.** New schedules and triggers are
 *    created disabled (the schema default), and the form says so instead of
 *    quietly flipping the switch on save. Turning something on is a separate,
 *    deliberate act.
 * 3. **A trigger explains itself in one sentence, while you type it.** Four
 *    dropdowns cannot be evaluated in your head; "Läuft, sobald eine Notiz mit
 *    dem Schlagwort #projekt angelegt wird." can. A trigger without any filter
 *    is flagged as very broad before it is saved, not after it has fired forty
 *    times.
 * 4. **debounceMs and maxPerHour are safety rails, so they are described as
 *    safety rails.** A bare "5000" tells nobody that it is what stops an agent
 *    which writes notes from triggering itself forever.
 * 5. **A failure is not hidden in a tooltip.** `lastError` gets a red band at
 *    the top of the card. A schedule that has silently failed for three weeks
 *    while showing a friendly green dot is precisely the dishonesty this
 *    project exists to avoid.
 * 6. **"Jetzt ausführen" and "Zeitplan jetzt prüfen" report what happened,
 *    including what did not.** The tick answer names every schedule it skipped
 *    and why; that list is shown, not dropped because it looks like noise.
 */

import {
  h, text, clear, list, icon, timeAgo, formatDateTime, formatNumber, debounce,
} from '../lib/dom.js';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-automation-view-style';

const VIEW_ICON = '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.6V10l3 1.8"/>';

const ICONS = {
  clock: '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.6V10l3 1.8"/>',
  bolt: '<path d="M11.2 2.6 4.8 11h4l-1 6.4L14.2 9h-4z"/>',
  play: '<path d="M6.4 4.4 15.2 10l-8.8 5.6z"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  arrow: '<path d="M3.8 10h11.4M11 5.8l4.2 4.2-4.2 4.2"/>',
};

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

const EVERY = [
  { value: 'hourly', label: 'Stündlich' },
  { value: 'daily', label: 'Täglich' },
  { value: 'weekly', label: 'Wöchentlich' },
];

const EVENTS = [
  { value: 'record.created', label: 'Angelegt', verb: 'angelegt wird' },
  { value: 'record.updated', label: 'Geändert', verb: 'geändert wird' },
  { value: 'record.deleted', label: 'Gelöscht', verb: 'gelöscht wird' },
];

const EVENT_BY_VALUE = Object.fromEntries(EVENTS.map((entry) => [entry.value, entry]));

/** The range src/agents/triggers.js clamps to; typing outside it is silently corrected. */
const DEBOUNCE_MIN_MS = 1000;
const DEBOUNCE_MAX_MS = 3600000;
const PER_HOUR_MIN = 1;
const PER_HOUR_MAX = 60;

/**
 * Record types a trigger can watch, with the indefinite article the sentence
 * needs and the relative pronoun for the "Titel enthält" clause.
 */
const RECORD_TYPES = [
  { value: '', label: 'Jede Satzart', indefinite: 'ein beliebiger Eintrag', relative: 'dessen' },
  { value: 'note', label: 'Notiz', indefinite: 'eine Notiz', relative: 'deren' },
  { value: 'task', label: 'Aufgabe', indefinite: 'eine Aufgabe', relative: 'deren' },
  { value: 'project', label: 'Projekt', indefinite: 'ein Projekt', relative: 'dessen' },
  { value: 'chat', label: 'Chat', indefinite: 'ein Chat', relative: 'dessen' },
  { value: 'file', label: 'Datei', indefinite: 'eine Datei', relative: 'deren' },
  { value: 'entity', label: 'Begriff', indefinite: 'ein Begriff', relative: 'dessen' },
  { value: 'message', label: 'Nachricht', indefinite: 'eine Nachricht', relative: 'deren' },
  { value: 'run', label: 'Lauf', indefinite: 'ein Lauf', relative: 'dessen' },
];

const TYPE_BY_VALUE = Object.fromEntries(RECORD_TYPES.map((entry) => [entry.value, entry]));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

function isUnavailable(err) {
  return !!err && (err.status === 503 || err.code === 'SUBSYSTEM_UNAVAILABLE');
}

function dataOf(record) {
  return (record && record.data) || {};
}

function pad2(value) {
  return String(Math.max(0, Math.min(23, Math.round(Number(value) || 0)))).padStart(2, '0');
}

function itemsOf(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && Array.isArray(value.items)) return value.items.filter(Boolean);
  return [];
}

function totalOf(value, fallback) {
  if (value && Number.isFinite(value.total)) return value.total;
  return fallback;
}

/** "5 Sekunden", "2 Minuten", "800 ms" -- whatever reads best at that size. */
function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 'unbekannt lange';
  if (n === 0) return 'gar nicht';
  if (n < 1000) return `${formatNumber(Math.round(n))} ms`;
  const seconds = n / 1000;
  if (seconds < 90) {
    const rounded = Math.round(seconds * 10) / 10;
    return `${rounded.toLocaleString('de-DE', { maximumFractionDigits: 1 })} ${rounded === 1 ? 'Sekunde' : 'Sekunden'}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${formatNumber(minutes)} ${minutes === 1 ? 'Minute' : 'Minuten'}`;
}

/**
 * When a schedule with these settings would next come up, computed here for
 * the form preview. For a saved schedule the server's own `nextRunAt` wins --
 * this view never overrules the side that actually fires it.
 */
function nextOccurrence(every, atHour, onWeekday, from = new Date()) {
  const date = new Date(from.getTime());
  if (every === 'hourly') {
    date.setMinutes(0, 0, 0);
    date.setHours(date.getHours() + 1);
    return date;
  }
  date.setHours(Math.max(0, Math.min(23, Math.round(Number(atHour) || 0))), 0, 0, 0);
  if (every === 'weekly') {
    const target = ((Math.round(Number(onWeekday) || 0) % 7) + 7) % 7;
    let delta = (target - date.getDay() + 7) % 7;
    if (delta === 0 && date.getTime() <= from.getTime()) delta = 7;
    date.setDate(date.getDate() + delta);
    return date;
  }
  if (date.getTime() <= from.getTime()) date.setDate(date.getDate() + 1);
  return date;
}

/** "heute um 14:00 Uhr", "morgen um 08:00 Uhr", "am Montag um 08:00 Uhr". */
function whenPhrase(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const clock = `${pad2(date.getHours())}:${String(date.getMinutes()).padStart(2, '0')} Uhr`;
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(now)) / 86400000);
  if (days === 0) return `heute um ${clock}`;
  if (days === 1) return `morgen um ${clock}`;
  if (days === 2) return `übermorgen um ${clock}`;
  if (days > 2 && days < 7) return `am ${WEEKDAYS[date.getDay()]} um ${clock}`;
  return `am ${date.getDate()}. ${date.toLocaleDateString('de-DE', { month: 'long' })} um ${clock}`;
}

/** The rhythm, as a sentence: "Jeden Montag um 08:00 Uhr." */
function rhythmSentence(every, atHour, onWeekday) {
  if (every === 'hourly') return 'Jede Stunde, zur vollen Stunde.';
  if (every === 'weekly') {
    const day = WEEKDAYS[((Math.round(Number(onWeekday) || 0) % 7) + 7) % 7];
    return `Jeden ${day} um ${pad2(atHour)}:00 Uhr.`;
  }
  return `Täglich um ${pad2(atHour)}:00 Uhr.`;
}

/**
 * The sentence that says what a trigger reacts to.
 *
 * Built from whatever is set right now, so it can be recomputed on every
 * keystroke in the form. Returns the sentence plus whether the filters are
 * empty -- a trigger that matches everything is a fact the form has to show
 * before it is saved.
 */
function triggerSentence(draft) {
  const event = EVENT_BY_VALUE[draft.on] || EVENTS[0];
  const type = TYPE_BY_VALUE[draft.recordType || ''] || RECORD_TYPES[0];
  const tag = String(draft.tag || '').trim().replace(/^#/, '');
  const contains = String(draft.titleContains || '').trim();

  const parts = [type.indefinite];
  if (tag) parts.push(`mit dem Schlagwort #${tag}`);
  if (contains) parts.push(`${type.relative} Titel „${contains}“ enthält`);

  const subject = parts.length > 2
    ? `${parts[0]} ${parts[1]}, ${parts[2]},`
    : parts.join(' ');

  return {
    sentence: `Läuft, sobald ${subject} ${event.verb}.`,
    broad: !draft.recordType && !tag && !contains,
  };
}

/** The scheduler/trigger status object, described without guessing. */
function describeSubsystem(value, label) {
  if (value === undefined || value === null) {
    return { text: `${label}: Der Server hat dazu nichts gemeldet.`, level: 'unknown' };
  }
  if (typeof value === 'boolean') {
    return value
      ? { text: `${label}: läuft.`, level: 'on' }
      : { text: `${label}: läuft nicht.`, level: 'off' };
  }
  if (typeof value === 'string') return { text: `${label}: ${value}`, level: 'unknown' };
  if (typeof value === 'object') {
    const running = typeof value.running === 'boolean' ? value.running : (value.active ?? value.available);
    const parts = [];
    if (typeof running === 'boolean') parts.push(running ? 'läuft' : 'läuft nicht');
    if (Number.isFinite(value.enabled)) {
      parts.push(Number.isFinite(value.total)
        ? `${formatNumber(value.enabled)} von ${formatNumber(value.total)} eingeschaltet`
        : `${formatNumber(value.enabled)} eingeschaltet`);
    } else if (Number.isFinite(value.total)) {
      parts.push(`${formatNumber(value.total)} insgesamt`);
    }
    if (Number.isFinite(value.intervalMs)) parts.push(`prüft alle ${formatDuration(value.intervalMs)}`);
    if (value.nextDue) parts.push(`nächster Termin ${whenPhrase(new Date(value.nextDue))}`);
    if (Number.isFinite(value.firedLastHour)) parts.push(`${formatNumber(value.firedLastHour)} Starts in der letzten Stunde`);
    if (Number.isFinite(value.inflight) && value.inflight > 0) parts.push(`${formatNumber(value.inflight)} laufen gerade`);
    // The brakes are as real as the starts; a status that hides them is half
    // the truth (src/agents/triggers.js says so itself).
    const held = [
      [value.droppedByDebounce, 'wegen der Wartezeit'],
      [value.droppedByCap, 'wegen der Stundengrenze'],
      [value.droppedByLoop, 'als Schleife erkannt'],
      [value.droppedByCeiling, 'wegen der Gesamtgrenze'],
    ].filter(([n]) => Number.isFinite(n) && n > 0);
    for (const [n, why] of held) parts.push(`${formatNumber(n)} ${why} zurückgehalten`);
    if (value.lastTickAt) parts.push(`zuletzt geprüft ${timeAgo(value.lastTickAt)}`);
    if (value.reason) parts.push(String(value.reason));
    if (!parts.length) return { text: `${label}: gemeldet, aber ohne verständliche Angaben.`, level: 'unknown' };
    const body = parts.join(' · ');
    return {
      text: `${label}: ${body}${/[.!?]$/.test(body) ? '' : '.'}`,
      level: typeof running === 'boolean' ? (running ? 'on' : 'off') : 'unknown',
    };
  }
  return { text: `${label}: unverständliche Angabe.`, level: 'unknown' };
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'automation',
  title: 'Automatik',
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

      schedules: [],
      scheduleTotal: 0,
      triggers: [],
      triggerTotal: 0,
      statusInfo: null,

      loading: true,
      loadError: null,
      unavailable: null,

      agents: [],
      agentsError: null,

      tick: { busy: false, result: null, error: null },
      busy: new Set(),          // record ids with a write in flight
      rowError: new Map(),      // record id -> ApiError from the last write
      lastRun: new Map(),       // schedule id -> {runId} from "Jetzt ausführen"
      drafts: new Map(),        // record id -> edited fields, kept across renders
      openEditors: new Set(),   // record ids whose "Ändern" panel stands open
      /**
       * Cards that must be rebuilt on the next render even though their editor
       * is open: an explicit write on a card (the switch above all) has to be
       * visible immediately, or the switch would keep showing the old state.
       */
      forceRebuild: new Set(),

      newSchedule: { name: '', agentId: '', goal: '', every: 'daily', atHour: 8, onWeekday: 1, busy: false, error: null },
      /** What the create forms were last built for; see renderScheduleForm. */
      scheduleFormKey: null,
      triggerFormKey: null,
      newTrigger: {
        name: '', agentId: '', goal: '', on: 'record.created', recordType: '', tag: '', titleContains: '',
        debounceMs: 5000, maxPerHour: 12, busy: false, error: null,
      },
    };
    view = self;

    buildLayout(self);
    subscribe(self);

    await Promise.all([loadAutomation(self), loadAgents(self)]);
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
  if (self.refreshSoon) self.refreshSoon.cancel();
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

async function loadAutomation(self, opts = {}) {
  if (!opts.quiet) self.loading = true;
  try {
    const result = await request(self, (signal) => self.api.get('/automation', { signal }));
    if (!self.alive) return;
    self.schedules = itemsOf(result && result.schedules);
    self.scheduleTotal = totalOf(result && result.schedules, self.schedules.length);
    self.triggers = itemsOf(result && result.triggers);
    self.triggerTotal = totalOf(result && result.triggers, self.triggers.length);
    self.statusInfo = (result && result.status) || null;
    self.loadError = null;
    self.unavailable = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.schedules = [];
    self.triggers = [];
    self.scheduleTotal = 0;
    self.triggerTotal = 0;
    self.statusInfo = null;
    if (isUnavailable(err)) {
      self.unavailable = err;
      self.loadError = null;
    } else {
      self.unavailable = null;
      self.loadError = err;
    }
  } finally {
    if (self.alive) self.loading = false;
  }
}

async function loadAgents(self) {
  try {
    const result = await request(self, (signal) => self.api.get('/agents', { query: { limit: 200 }, signal }));
    if (!self.alive) return;
    self.agents = itemsOf(result);
    self.agentsError = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.agents = [];
    self.agentsError = err;
  }
}

function agentName(self, agentId) {
  const agent = self.agents.find((entry) => entry && entry.id === agentId);
  if (!agent) return null;
  return String(dataOf(agent).name || agent.id);
}

/* ------------------------------------------------------------------ */
/* Live events                                                         */
/* ------------------------------------------------------------------ */

function subscribe(self) {
  const { ctx } = self;
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;

  self.refreshSoon = debounce(() => {
    if (!self.alive) return;
    loadAutomation(self, { quiet: true }).then(() => {
      if (self.alive) renderAll(self);
    });
  }, 600);

  // Guaranteed ground truth: schedules and triggers are ordinary records, so
  // the store's own events fire whether or not the automation subsystem
  // publishes anything of its own.
  for (const name of ['record.created', 'record.updated', 'record.deleted']) {
    self.cleanups.push(ctx.bus.on(name, (payload) => {
      const type = payload && payload.type;
      if (type === 'schedule' || type === 'trigger') self.refreshSoon();
    }));
  }

  // A run tells us a schedule or trigger actually fired.
  for (const name of ['run.started', 'run.finished', 'run.failed']) {
    self.cleanups.push(ctx.bus.on(name, () => self.refreshSoon()));
  }

  // What src/agents/schedule.js and src/agents/triggers.js publish. The record
  // events above would catch most of it anyway; a skipped schedule and a capped
  // trigger write nothing, so without these two the counters would go stale.
  for (const name of ['schedule.fired', 'schedule.skipped', 'schedule.changed',
    'trigger.fired', 'trigger.changed', 'trigger.capped']) {
    self.cleanups.push(ctx.bus.on(name, () => self.refreshSoon()));
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

function setBusy(self, id, value) {
  if (value) self.busy.add(id);
  else self.busy.delete(id);
}

async function patchRecord(self, kind, record, patch) {
  const path = kind === 'schedule' ? '/automation/schedules' : '/automation/triggers';
  setBusy(self, record.id, true);
  self.rowError.delete(record.id);
  renderLists(self);
  try {
    const result = await request(self, (signal) => self.api.patch(`${path}/${encodeURIComponent(record.id)}`, patch, { signal }));
    if (!self.alive) return null;
    const updated = (result && result.record) || null;
    if (updated) replaceRecord(self, kind, updated);
    return updated;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return null;
    // The old value stays on screen: showing a state the server refused would
    // be worse than showing the error next to the unchanged truth.
    self.rowError.set(record.id, err);
    return null;
  } finally {
    if (self.alive) {
      setBusy(self, record.id, false);
      self.forceRebuild.add(record.id);
      renderAll(self);
    }
  }
}

function replaceRecord(self, kind, updated) {
  const listKey = kind === 'schedule' ? 'schedules' : 'triggers';
  const at = self[listKey].findIndex((entry) => entry && entry.id === updated.id);
  if (at === -1) self[listKey] = [...self[listKey], updated];
  else self[listKey] = self[listKey].map((entry, i) => (i === at ? updated : entry));
}

async function toggleEnabled(self, kind, record) {
  const data = dataOf(record);
  const next = data.enabled !== true;
  if (next) {
    const label = kind === 'schedule' ? 'Diesen Zeitplan einschalten?' : 'Diesen Auslöser einschalten?';
    const message = kind === 'schedule'
      ? `Ab dann startet „${agentName(self, data.agentId) || data.agentId}“ von allein: ${rhythmSentence(data.every, data.atHour, data.onWeekday)} Du musst dafür nichts mehr tun – und bekommst es nur hier und in den Läufen zu sehen.`
      : `Ab dann startet „${agentName(self, data.agentId) || data.agentId}“ von allein. ${triggerSentence(data).sentence}`;
    const ok = await self.ctx.confirm({ title: label, message, confirmLabel: 'Einschalten' });
    if (!ok || !self.alive) return;
  }
  await patchRecord(self, kind, record, { enabled: next });
}

async function removeRecord(self, kind, record) {
  const data = dataOf(record);
  const ok = await self.ctx.confirm({
    title: kind === 'schedule' ? 'Zeitplan löschen?' : 'Auslöser löschen?',
    message: `„${data.goal || agentName(self, data.agentId) || record.id}“ wird gelöscht. `
      + 'Bereits gelaufene Läufe bleiben erhalten; ausgelöst wird ab jetzt nichts mehr.',
    confirmLabel: 'Löschen',
    danger: true,
  });
  if (!ok || !self.alive) return;

  const path = kind === 'schedule' ? '/automation/schedules' : '/automation/triggers';
  setBusy(self, record.id, true);
  renderLists(self);
  try {
    await request(self, (signal) => self.api.del(`${path}/${encodeURIComponent(record.id)}`, { signal }));
    if (!self.alive) return;
    const listKey = kind === 'schedule' ? 'schedules' : 'triggers';
    self[listKey] = self[listKey].filter((entry) => entry.id !== record.id);
    self.drafts.delete(record.id);
    self.openEditors.delete(record.id);
    self.ctx.toast(kind === 'schedule' ? 'Zeitplan gelöscht.' : 'Auslöser gelöscht.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.rowError.set(record.id, err);
  } finally {
    if (self.alive) {
      setBusy(self, record.id, false);
      self.forceRebuild.add(record.id);
      renderAll(self);
    }
  }
}

async function runNow(self, record) {
  setBusy(self, record.id, true);
  self.rowError.delete(record.id);
  renderLists(self);
  try {
    const result = await request(self, (signal) => self.api.post(`/automation/schedules/${encodeURIComponent(record.id)}/run`, {}, { signal, timeoutMs: 60000 }));
    if (!self.alive) return;
    const runId = result && result.runId;
    if (runId) {
      self.lastRun.set(record.id, { runId, at: new Date().toISOString() });
      self.ctx.toast('Der Lauf wurde gestartet.', 'success', {
        action: { label: 'Ansehen', run: () => self.ctx.navigate(`#/agents?run=${encodeURIComponent(runId)}`) },
      });
    } else {
      // No id means we cannot link to anything; say that instead of pretending.
      self.ctx.toast('Der Server hat den Start bestätigt, aber keine Lauf-Nummer genannt.', 'info');
    }
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.rowError.set(record.id, err);
  } finally {
    if (self.alive) {
      setBusy(self, record.id, false);
      await loadAutomation(self, { quiet: true });
      if (self.alive) {
        self.forceRebuild.add(record.id);
        renderAll(self);
      }
    }
  }
}

async function runTick(self) {
  if (self.tick.busy) return;
  self.tick = { busy: true, result: null, error: null };
  renderTickPanel(self);
  try {
    const result = await request(self, (signal) => self.api.post('/automation/tick', {}, { signal, timeoutMs: 60000 }));
    if (!self.alive) return;
    self.tick.result = result && typeof result === 'object' ? result : null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.tick.error = err;
  } finally {
    if (self.alive) {
      self.tick.busy = false;
      await loadAutomation(self, { quiet: true });
      if (self.alive) renderAll(self);
    }
  }
}

async function createSchedule(self) {
  const form = self.newSchedule;
  if (form.busy) return;
  if (!form.agentId) {
    form.error = new Error('Ohne Agenten kann kein Zeitplan laufen. Bitte einen auswählen.');
    renderScheduleForm(self, true);
    return;
  }
  if (!String(form.goal || '').trim()) {
    form.error = new Error('Ein Zeitplan braucht einen Auftrag; ein Agent ohne Auftrag tut nichts.');
    renderScheduleForm(self, true);
    return;
  }
  form.busy = true;
  form.error = null;
  renderScheduleForm(self, true);
  try {
    const body = {
      name: String(form.name || '').trim(),
      agentId: form.agentId,
      goal: form.goal,
      every: form.every,
      atHour: Number(form.atHour) || 0,
      onWeekday: Number(form.onWeekday) || 0,
    };
    const result = await request(self, (signal) => self.api.post('/automation/schedules', body, { signal }));
    if (!self.alive) return;
    const record = result && result.record;
    if (record) self.schedules = [...self.schedules, record];
    self.scheduleTotal += 1;
    self.newSchedule = {
      name: '', agentId: form.agentId, goal: '', every: form.every,
      atHour: form.atHour, onWeekday: form.onWeekday, busy: false, error: null,
    };
    self.ctx.toast('Zeitplan angelegt – ausgeschaltet.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    form.error = err;
  } finally {
    if (self.alive) {
      self.newSchedule.busy = false;
      renderAll(self);
      renderScheduleForm(self, true);
    }
  }
}

async function createTrigger(self) {
  const form = self.newTrigger;
  if (form.busy) return;
  if (!form.agentId) {
    form.error = new Error('Ohne Agenten kann kein Auslöser laufen. Bitte einen auswählen.');
    renderTriggerForm(self, true);
    return;
  }
  if (!String(form.goal || '').trim()) {
    form.error = new Error('Ein Auslöser braucht einen Auftrag; ein Agent ohne Auftrag tut nichts.');
    renderTriggerForm(self, true);
    return;
  }
  form.busy = true;
  form.error = null;
  renderTriggerForm(self, true);
  try {
    const body = {
      name: String(form.name || '').trim(),
      agentId: form.agentId,
      goal: form.goal,
      on: form.on,
      recordType: form.recordType || null,
      tag: String(form.tag || '').trim().replace(/^#/, '') || null,
      titleContains: String(form.titleContains || '').trim() || null,
      debounceMs: Number(form.debounceMs) || 0,
      maxPerHour: Number(form.maxPerHour) || 0,
    };
    const result = await request(self, (signal) => self.api.post('/automation/triggers', body, { signal }));
    if (!self.alive) return;
    const record = result && result.record;
    if (record) self.triggers = [...self.triggers, record];
    self.triggerTotal += 1;
    self.newTrigger = {
      name: '', agentId: form.agentId, goal: '', on: form.on, recordType: form.recordType, tag: '', titleContains: '',
      debounceMs: form.debounceMs, maxPerHour: form.maxPerHour, busy: false, error: null,
    };
    self.ctx.toast('Auslöser angelegt – ausgeschaltet.', 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    form.error = err;
  } finally {
    if (self.alive) {
      self.newTrigger.busy = false;
      renderAll(self);
      renderTriggerForm(self, true);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.banner = h('div.autov__banner', { role: 'status' });
  dom.status = h('div.autov__status');
  dom.tickPanel = h('div.autov__tick', { 'aria-live': 'polite' });
  dom.scheduleNote = h('div.autov__note');
  dom.scheduleList = h('div.autov__list');
  dom.scheduleForm = h('div.autov__form');
  dom.triggerNote = h('div.autov__note');
  dom.triggerList = h('div.autov__list');
  dom.triggerForm = h('div.autov__form');

  dom.tickButton = h('button.btn', {
    type: 'button',
    onClick: () => runTick(self),
  }, icon(ICONS.clock), text('Zeitplan jetzt prüfen'));

  dom.reloadButton = h('button.btn.btn--ghost', {
    type: 'button',
    onClick: () => loadAutomation(self).then(() => self.alive && renderAll(self)),
  }, icon(ICONS.refresh), text('Neu laden'));

  dom.root = h('div.autov.page.page--wide', null,
    h('header.page__head', null,
      h('div', null,
        h('h1.page__title', null, text('Automatik')),
        h('p.page__subtitle', null, text('Zeitpläne starten einen Agenten nach der Uhr, Auslöser starten ihn, '
          + 'wenn sich etwas ändert. Beides ist ausgeschaltet, solange du es nicht einschaltest.'))),
      h('div.page__actions', null, dom.reloadButton, dom.tickButton)),
    dom.banner,
    dom.status,
    dom.tickPanel,
    h('section.autov__section', null,
      h('h2.autov__section-title', null, icon(ICONS.clock), text('Zeitpläne')),
      h('p.autov__section-lead', null, text('Ein Zeitplan startet einen Agenten nach der Uhr – auch wenn du nicht davorsitzt.')),
      dom.scheduleNote,
      dom.scheduleList,
      dom.scheduleForm),
    h('section.autov__section', null,
      h('h2.autov__section-title', null, icon(ICONS.bolt), text('Auslöser')),
      h('p.autov__section-lead', null, text('Ein Auslöser startet einen Agenten, sobald ein Eintrag angelegt, geändert oder gelöscht wird.')),
      dom.triggerNote,
      dom.triggerList,
      dom.triggerForm));

  container.appendChild(dom.root);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll(self) {
  renderBanner(self);
  renderStatus(self);
  renderTickPanel(self);
  renderLists(self);
  renderScheduleForm(self);
  renderTriggerForm(self);
  self.dom.tickButton.disabled = self.tick.busy || !!self.unavailable;
}

function renderLists(self) {
  renderScheduleList(self);
  renderTriggerList(self);
}

/**
 * The one sentence this page exists for.
 *
 * It counts enabled schedules and triggers and says so in words. When nothing
 * is on, that is stated just as plainly -- "Nichts läuft von allein" is the
 * answer to a question people ask a privacy-first system, and it deserves a
 * line of its own rather than the absence of a warning.
 */
function renderBanner(self) {
  const box = self.dom.banner;
  clear(box);

  if (self.unavailable) {
    box.dataset.state = 'unknown';
    box.appendChild(icon(ICONS.alert));
    box.appendChild(h('div', null,
      h('strong', null, text('Ob etwas von allein läuft, ist gerade nicht feststellbar.')),
      h('p', null, text(errorMessage(self.unavailable)))));
    return;
  }
  if (self.loadError) {
    box.dataset.state = 'unknown';
    box.appendChild(icon(ICONS.alert));
    box.appendChild(h('div', null,
      h('strong', null, text('Die Automatik konnte nicht gelesen werden.')),
      h('p', null, text(errorMessage(self.loadError))),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => loadAutomation(self).then(() => self.alive && renderAll(self)),
      }, text('Erneut versuchen'))));
    return;
  }
  if (self.loading) {
    box.dataset.state = 'unknown';
    box.appendChild(h('span.spinner', { 'aria-hidden': 'true' }));
    box.appendChild(h('div', null, h('strong', null, text('Die Automatik wird gelesen …'))));
    return;
  }

  const onSchedules = self.schedules.filter((entry) => dataOf(entry).enabled === true);
  const onTriggers = self.triggers.filter((entry) => dataOf(entry).enabled === true);
  const count = onSchedules.length + onTriggers.length;

  if (!count) {
    box.dataset.state = 'off';
    box.appendChild(icon(ICONS.check));
    box.appendChild(h('div', null,
      h('strong', null, text('Nichts läuft von allein.')),
      h('p', null, text(self.schedules.length || self.triggers.length
        ? 'Alle Zeitpläne und Auslöser sind ausgeschaltet. Es startet nur, was du selbst startest.'
        : 'Es ist weder ein Zeitplan noch ein Auslöser angelegt. Es startet nur, was du selbst startest.'))));
    return;
  }

  const parts = [];
  if (onSchedules.length) parts.push(onSchedules.length === 1 ? '1 Zeitplan' : `${formatNumber(onSchedules.length)} Zeitpläne`);
  if (onTriggers.length) parts.push(onTriggers.length === 1 ? '1 Auslöser' : `${formatNumber(onTriggers.length)} Auslöser`);

  box.dataset.state = 'on';
  box.appendChild(icon(ICONS.bolt));
  box.appendChild(h('div', null,
    h('strong', null, text(`${parts.join(' und ')} ${count === 1 ? 'läuft' : 'laufen'} von allein.`)),
    h('p', null, text('Diese Agenten starten ohne dein Zutun und benutzen dabei genau die Rechte, die du ihnen gegeben hast.')),
    h('ul.autov__banner-list', { role: 'list' },
      ...onSchedules.map((record) => h('li', null,
        text(`${agentName(self, dataOf(record).agentId) || dataOf(record).agentId}: ${rhythmSentence(dataOf(record).every, dataOf(record).atHour, dataOf(record).onWeekday)}`))),
      ...onTriggers.map((record) => h('li', null,
        text(`${agentName(self, dataOf(record).agentId) || dataOf(record).agentId}: ${triggerSentence(dataOf(record)).sentence}`))))));
}

function renderStatus(self) {
  const box = self.dom.status;
  clear(box);
  if (!self.statusInfo || typeof self.statusInfo !== 'object') return;

  const rows = [
    describeSubsystem(self.statusInfo.scheduler, 'Uhrwerk'),
    describeSubsystem(self.statusInfo.triggers, 'Auslöser-Wache'),
  ];
  for (const row of rows) {
    box.appendChild(h('span.autov__status-pill', { dataset: { level: row.level } }, text(row.text)));
  }
}

function renderTickPanel(self) {
  const box = self.dom.tickPanel;
  clear(box);
  self.dom.tickButton.disabled = self.tick.busy || !!self.unavailable;
  clear(self.dom.tickButton);
  if (self.tick.busy) {
    self.dom.tickButton.appendChild(h('span.spinner', { 'aria-hidden': 'true' }));
    self.dom.tickButton.appendChild(text('Wird geprüft …'));
  } else {
    self.dom.tickButton.appendChild(icon(ICONS.clock));
    self.dom.tickButton.appendChild(text('Zeitplan jetzt prüfen'));
  }

  if (self.tick.busy) {
    box.appendChild(h('div.autov__panel', { role: 'status' },
      h('div.row', null,
        h('span.spinner', { 'aria-hidden': 'true' }),
        h('strong', null, text('Es wird nachgesehen, was fällig ist …')))));
    return;
  }

  if (self.tick.error) {
    box.appendChild(h('div.autov__panel.autov__panel--danger', { role: 'alert' },
      h('div.row', null, icon(ICONS.alert), h('strong', null, text('Die Prüfung ist fehlgeschlagen.'))),
      h('p', null, text(errorMessage(self.tick.error)))));
    return;
  }

  const result = self.tick.result;
  if (!result) return;

  const fired = Array.isArray(result.fired) ? result.fired : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];

  const panel = h('div.autov__panel', null,
    h('div.row', null,
      icon(ICONS.check),
      h('strong', null, text(result.at ? `Geprüft am ${formatDateTime(result.at)}` : 'Geprüft'))));

  if (fired.length) {
    panel.appendChild(h('p', null, text(fired.length === 1 ? '1 Zeitplan wurde gestartet:' : `${formatNumber(fired.length)} Zeitpläne wurden gestartet:`)));
    panel.appendChild(h('ul.autov__panel-list', { role: 'list' }, ...fired.map((entry) => {
      const name = agentName(self, entry && entry.agentId) || (entry && entry.agentId) || 'unbekannter Agent';
      return h('li', null,
        text(`${name} `),
        entry && entry.runId
          ? h('button.btn.btn--small', {
            type: 'button',
            onClick: () => self.ctx.navigate(`#/agents?run=${encodeURIComponent(entry.runId)}`),
          }, text('Lauf ansehen'), icon(ICONS.arrow))
          : h('span.meta', null, text('– ohne Lauf-Nummer gemeldet')));
    })));
  } else {
    panel.appendChild(h('p', null, text('Es war nichts fällig – es wurde nichts gestartet.')));
  }

  if (skipped.length) {
    panel.appendChild(h('div.autov__skipped', null,
      h('p.autov__skipped-title', null,
        icon(ICONS.alert),
        text(skipped.length === 1 ? '1 Zeitplan wurde übergangen:' : `${formatNumber(skipped.length)} Zeitpläne wurden übergangen:`)),
      h('ul', { role: 'list' }, ...skipped.map((entry) => {
        const record = self.schedules.find((row) => row.id === (entry && entry.scheduleId));
        const name = record ? (agentName(self, dataOf(record).agentId) || dataOf(record).agentId) : (entry && entry.scheduleId) || 'unbekannt';
        return h('li', null,
          h('strong', null, text(String(name))),
          text(` – ${String((entry && entry.reason) || 'ohne Angabe eines Grundes')}`));
      }))));
  }

  box.appendChild(panel);
}

/* --------------------------- schedules ----------------------------- */

function renderScheduleList(self) {
  const note = self.dom.scheduleNote;
  clear(note);

  if (self.unavailable || self.loadError) {
    emptyList(self.dom.scheduleList);
    return;
  }
  if (self.loading) {
    note.appendChild(h('p.meta', { role: 'status' }, text('Zeitpläne werden gelesen …')));
    emptyList(self.dom.scheduleList);
    return;
  }
  if (!self.schedules.length) {
    note.appendChild(h('p.autov__empty', null, text('Es ist kein Zeitplan angelegt. Nach der Uhr startet also nichts.')));
    emptyList(self.dom.scheduleList);
    return;
  }

  if (self.scheduleTotal > self.schedules.length) {
    note.appendChild(h('p.meta', null,
      text(`Es werden ${formatNumber(self.schedules.length)} von ${formatNumber(self.scheduleTotal)} Zeitplänen gezeigt.`)));
  }

  // Keyed, so a card the user is editing keeps its node -- and with it the
  // caret, the scroll position and the half-typed goal.
  list(self.dom.scheduleList, self.schedules, (record) => record.id, (record, existing) => {
    const forced = self.forceRebuild.delete(record.id);
    if (!forced && existing && isBeingEdited(self, record.id)) return existing;
    return renderScheduleCard(self, record);
  });
}

/** An open editor holds the caret and possibly unsaved input: do not rebuild. */
function isBeingEdited(self, id) {
  return self.drafts.has(id) || self.openEditors.has(id);
}

/** Empty a keyed list container without leaving its reconciler state behind. */
function emptyList(container) {
  list(container, [], (entry) => entry.id, () => h('div'));
}

function renderScheduleCard(self, record) {
  const data = dataOf(record);
  const enabled = data.enabled === true;
  const busy = self.busy.has(record.id);
  const name = agentName(self, data.agentId);
  // `name` on a schedule is not in the schema; the store keeps it anyway and
  // the scheduler treats it as the label the user chose (src/agents/schedule.js).
  const title = typeof data.name === 'string' ? data.name.trim() : '';

  const card = h('article.autov__card', { dataset: { on: enabled ? '1' : '0' } });

  if (data.lastError) card.appendChild(renderErrorBand(data.lastError, data.lastRunAt));
  const rowError = self.rowError.get(record.id);
  if (rowError) {
    card.appendChild(h('div.autov__band.autov__band--danger', { role: 'alert' },
      icon(ICONS.alert),
      h('div', null,
        h('strong', null, text('Die letzte Änderung wurde nicht gespeichert.')),
        h('p', null, text(errorMessage(rowError))))));
  }

  card.appendChild(h('div.autov__card-head', null,
    renderSwitch(enabled, busy, () => toggleEnabled(self, 'schedule', record)),
    h('div.autov__card-ident', null,
      h('h3.autov__card-title', null, text(title || name || `Agent ${data.agentId || '?'}`)),
      title && name && title !== name ? h('p.meta', null, text(`Agent: ${name}`)) : null,
      name ? null : h('p.hint', null, text('Dieser Agent ist nicht (mehr) in der Agentenliste. Ein Zeitplan ohne Agenten kann nicht laufen.')),
      h('p.autov__rhythm', null, icon(ICONS.clock), text(rhythmOf(record))))));

  card.appendChild(h('p.autov__goal', null,
    h('span.autov__goal-key', null, text('Auftrag: ')),
    text(data.goal ? String(data.goal) : 'kein Auftrag hinterlegt – der Agent bekommt nur sein eigenes Systemziel.')));

  card.appendChild(h('p.autov__next', null, text(nextRunSentence(self, record))));

  /* facts row */
  const facts = h('div.autov__facts');
  facts.appendChild(h('span.meta', null, text(Number.isFinite(data.runs) ? `${formatNumber(data.runs)} Läufe bisher` : 'Läufe unbekannt')));
  facts.appendChild(h('span.meta', null, text(data.lastRunAt ? `zuletzt ${timeAgo(data.lastRunAt)}` : 'noch nie gelaufen')));
  const lastRunId = (self.lastRun.get(record.id) || {}).runId || data.lastRunId;
  if (lastRunId) {
    facts.appendChild(h('button.btn.btn--small.btn--ghost', {
      type: 'button',
      onClick: () => self.ctx.navigate(`#/agents?run=${encodeURIComponent(lastRunId)}`),
    }, text('Letzten Lauf ansehen'), icon(ICONS.arrow)));
  }
  card.appendChild(facts);

  /* actions */
  card.appendChild(h('div.autov__actions', null,
    h('button.btn.btn--small', {
      type: 'button',
      disabled: busy,
      onClick: () => runNow(self, record),
    }, icon(ICONS.play), text('Jetzt ausführen')),
    h('span.spacer'),
    busy ? h('span.spinner', { 'aria-hidden': 'true' }) : null,
    h('button.btn.btn--small.btn--ghost', {
      type: 'button',
      disabled: busy,
      onClick: () => removeRecord(self, 'schedule', record),
    }, icon(ICONS.trash), text('Löschen'))));

  card.appendChild(renderScheduleEditor(self, record));
  return card;
}

/**
 * What the server says about the next run -- never this view's own guess.
 *
 * `dueIn` and `nextRunLabel` are computed by `src/agents/schedule.js` and put
 * on the record itself, not inside `data`. The label there is relative ("in 2
 * Tagen"); the clock time comes from `nextRunAt`, so both are shown: the
 * moment, and how far away it is.
 */
function nextRunSentence(self, record) {
  const data = dataOf(record);
  if (data.enabled !== true) {
    const preview = whenPhrase(nextOccurrence(data.every, data.atHour, data.onWeekday));
    return `Läuft nicht. Eingeschaltet wäre das nächste Mal ${preview}.`;
  }
  const label = typeof record.nextRunLabel === 'string' ? record.nextRunLabel.trim() : '';
  if (data.nextRunAt) {
    const when = whenPhrase(new Date(data.nextRunAt));
    const relative = label && !/^(Ausgeschaltet|Unbekannt|Kein Termin)/.test(label) ? ` (${label})` : '';
    return when
      ? `Das nächste Mal: ${when}${relative}.`
      : `Das nächste Mal: ${formatDateTime(data.nextRunAt)}${relative}.`;
  }
  if (label) return `Das nächste Mal: ${label}${/[.!?]$/.test(label) ? '' : '.'}`;
  return 'Wann es das nächste Mal läuft, hat der Server nicht mitgeteilt.';
}

/** The server's own rhythm wording wins; ours only fills a gap. */
function rhythmOf(record) {
  const label = typeof record.rhythmLabel === 'string' ? record.rhythmLabel.trim() : '';
  if (label) return `${label}${/[.!?]$/.test(label) ? '' : '.'}`;
  const data = dataOf(record);
  return rhythmSentence(data.every, data.atHour, data.onWeekday);
}

function renderScheduleEditor(self, record) {
  const data = dataOf(record);
  const draft = self.drafts.get(record.id) || {
    name: String(data.name || ''),
    goal: String(data.goal || ''),
    every: String(data.every || 'daily'),
    atHour: Number.isFinite(data.atHour) ? data.atHour : 8,
    onWeekday: Number.isFinite(data.onWeekday) ? data.onWeekday : 1,
  };
  const preview = h('p.autov__preview');

  const refreshPreview = () => {
    clear(preview);
    preview.appendChild(text(`${rhythmSentence(draft.every, draft.atHour, draft.onWeekday)} Eingeschaltet wäre das nächste Mal `
      + `${whenPhrase(nextOccurrence(draft.every, draft.atHour, draft.onWeekday))}.`));
  };

  // A draft is only recorded once the user actually changes something: its
  // presence is what tells the list "this card is being edited, leave it".
  const update = (patch) => {
    Object.assign(draft, patch);
    self.drafts.set(record.id, draft);
    refreshPreview();
  };

  const goal = h('textarea.textarea.autov__goal-input', {
    rows: '2',
    value: draft.goal,
    'aria-label': 'Auftrag',
    onInput: (event) => update({ goal: event.target.value }),
  });

  const box = h('details.autov__editor', {
    open: isBeingEdited(self, record.id),
    onToggle: (event) => {
      if (event.target.open) self.openEditors.add(record.id);
      else self.openEditors.delete(record.id);
    },
  },
  h('summary', null, text('Ändern')),
  h('div.autov__grid', null,
    h('label.field', null, h('span.label', null, text('Name (frei)')),
      h('input.input', {
        type: 'text', value: draft.name,
        onInput: (event) => update({ name: event.target.value }),
      })),
    h('label.field.autov__field--wide', null, h('span.label', null, text('Auftrag')), goal),
      h('label.field', null, h('span.label', null, text('Rhythmus')),
        everySelect(draft.every, (value) => { update({ every: value }); })),
      h('label.field', null, h('span.label', null, text('Uhrzeit')),
        hourSelect(draft.atHour, (value) => update({ atHour: value }))),
      h('label.field', null, h('span.label', null, text('Wochentag')),
        weekdaySelect(draft.onWeekday, (value) => update({ onWeekday: value })))),
    preview,
    h('div.row', null,
      h('button.btn.btn--primary.btn--small', {
        type: 'button',
        disabled: self.busy.has(record.id),
        onClick: async () => {
          const saved = await patchRecord(self, 'schedule', record, {
            name: String(draft.name || '').trim(),
            goal: draft.goal,
            every: draft.every,
            atHour: Number(draft.atHour) || 0,
            onWeekday: Number(draft.onWeekday) || 0,
          });
          if (!saved) return;
          self.drafts.delete(record.id);
          self.openEditors.delete(record.id);
          self.forceRebuild.add(record.id);
          renderScheduleList(self);
        },
      }, text('Speichern')),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => {
          self.drafts.delete(record.id);
          self.openEditors.delete(record.id);
          renderScheduleList(self);
        },
      }, text('Verwerfen')),
      h('span.hint', null, text('Das Einschalten bleibt eine eigene Entscheidung – Speichern schaltet nichts ein.'))));

  refreshPreview();
  return box;
}

/**
 * One select builder for all of them.
 *
 * The selected option is set through `element.value` after the options exist,
 * rather than through a `selected` attribute on the option: the attribute only
 * describes the *default* selection, which quietly stops matching the state
 * once the element has been interacted with.
 */
function buildSelect(options, value, onChange) {
  const el = h('select.select', {
    onChange: (event) => onChange(event.target.value),
  }, ...options.map((entry) => h('option', { value: String(entry.value) }, text(entry.label))));
  el.value = String(value === null || value === undefined ? '' : value);
  return el;
}

function everySelect(value, onChange) {
  return buildSelect(EVERY, value, onChange);
}

function hourSelect(value, onChange) {
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) options.push({ value: hour, label: `${pad2(hour)}:00` });
  return buildSelect(options, Number(value) || 0, (raw) => onChange(Number(raw)));
}

function weekdaySelect(value, onChange) {
  const options = WEEKDAYS.map((label, index) => ({ value: index, label }));
  return buildSelect(options, Number(value) || 0, (raw) => onChange(Number(raw)));
}

/**
 * The create form is rebuilt only when it has to be.
 *
 * A live event (a schedule fired, a record changed) re-renders this page every
 * few seconds; rebuilding an open form under the user's hands would move the
 * caret out of the goal they are typing. The field values live in
 * `self.newSchedule`, so skipping the rebuild loses nothing.
 */
function renderScheduleForm(self, force = false) {
  const box = self.dom.scheduleForm;
  const key = formKey(self);
  if (!force && box.firstChild && self.scheduleFormKey === key) return;
  self.scheduleFormKey = key;
  clear(box);
  // Offering to create something while the endpoint that would store it is
  // unreachable is a promise this view cannot keep.
  if (self.unavailable || self.loadError) return;

  const form = self.newSchedule;
  if (!self.agents.length) {
    box.appendChild(renderNoAgents(self, 'Ein Zeitplan braucht einen Agenten, der etwas tut.'));
    return;
  }

  const preview = h('p.autov__preview');
  const refreshPreview = () => {
    clear(preview);
    preview.appendChild(text(`${rhythmSentence(form.every, form.atHour, form.onWeekday)} `
      + `Eingeschaltet wäre das nächste Mal ${whenPhrase(nextOccurrence(form.every, form.atHour, form.onWeekday))}.`));
  };

  const goal = h('textarea.textarea', {
    rows: '2',
    value: form.goal,
    placeholder: 'Zum Beispiel: Fasse die Notizen der letzten Woche zusammen.',
    onInput: (event) => { form.goal = event.target.value; },
  });

  box.appendChild(h('details.autov__new', {
    open: form.open === true,
    onToggle: (event) => { form.open = event.target.open; },
  },
  h('summary', null, icon(ICONS.plus), text('Neuer Zeitplan')),
  h('div.autov__grid', null,
    h('label.field', null, h('span.label', null, text('Name (frei)')),
      h('input.input', {
        type: 'text', value: form.name, placeholder: 'z. B. Wochenrückblick',
        onInput: (event) => { form.name = event.target.value; },
      })),
    h('label.field', null, h('span.label', null, text('Agent')), agentSelect(self, form.agentId, (value) => { form.agentId = value; })),
    h('label.field', null, h('span.label', null, text('Rhythmus')), everySelect(form.every, (value) => { form.every = value; refreshPreview(); })),
      h('label.field', null, h('span.label', null, text('Uhrzeit')), hourSelect(form.atHour, (value) => { form.atHour = value; refreshPreview(); })),
      h('label.field', null, h('span.label', null, text('Wochentag')), weekdaySelect(form.onWeekday, (value) => { form.onWeekday = value; refreshPreview(); })),
      h('label.field.autov__field--wide', null, h('span.label', null, text('Auftrag')), goal)),
    preview,
    h('p.hint', null, text('Der Wochentag gilt nur für „Wöchentlich“, die Uhrzeit nicht für „Stündlich“.')),
    form.error ? h('p.autov__form-error', { role: 'alert' }, text(errorMessage(form.error))) : null,
    h('div.row', null,
      h('button.btn.btn--primary.btn--small', {
        type: 'button',
        disabled: form.busy,
        onClick: () => createSchedule(self),
      }, icon(ICONS.plus), text('Anlegen')),
      form.busy ? h('span.spinner', { 'aria-hidden': 'true' }) : null,
      h('span.hint', null, text('Wird ausgeschaltet angelegt. Er läuft erst, wenn du den Schalter umlegst.')))));

  refreshPreview();
}

/* --------------------------- triggers ------------------------------ */

function renderTriggerList(self) {
  const note = self.dom.triggerNote;
  clear(note);

  if (self.unavailable || self.loadError) {
    emptyList(self.dom.triggerList);
    return;
  }
  if (self.loading) {
    note.appendChild(h('p.meta', { role: 'status' }, text('Auslöser werden gelesen …')));
    emptyList(self.dom.triggerList);
    return;
  }
  if (!self.triggers.length) {
    note.appendChild(h('p.autov__empty', null, text('Es ist kein Auslöser angelegt. Auf Änderungen reagiert also nichts.')));
    emptyList(self.dom.triggerList);
    return;
  }

  if (self.triggerTotal > self.triggers.length) {
    note.appendChild(h('p.meta', null,
      text(`Es werden ${formatNumber(self.triggers.length)} von ${formatNumber(self.triggerTotal)} Auslösern gezeigt.`)));
  }

  list(self.dom.triggerList, self.triggers, (record) => record.id, (record, existing) => {
    const forced = self.forceRebuild.delete(record.id);
    if (!forced && existing && isBeingEdited(self, record.id)) return existing;
    return renderTriggerCard(self, record);
  });
}

function renderTriggerCard(self, record) {
  const data = dataOf(record);
  const enabled = data.enabled === true;
  const busy = self.busy.has(record.id);
  const name = agentName(self, data.agentId);
  const title = typeof data.name === 'string' ? data.name.trim() : '';
  const described = triggerSentence(data);

  const card = h('article.autov__card', { dataset: { on: enabled ? '1' : '0' } });

  if (data.lastError) card.appendChild(renderErrorBand(data.lastError, data.firedAt));
  const rowError = self.rowError.get(record.id);
  if (rowError) {
    card.appendChild(h('div.autov__band.autov__band--danger', { role: 'alert' },
      icon(ICONS.alert),
      h('div', null,
        h('strong', null, text('Die letzte Änderung wurde nicht gespeichert.')),
        h('p', null, text(errorMessage(rowError))))));
  }

  card.appendChild(h('div.autov__card-head', null,
    renderSwitch(enabled, busy, () => toggleEnabled(self, 'trigger', record)),
    h('div.autov__card-ident', null,
      h('h3.autov__card-title', null, text(title || name || `Agent ${data.agentId || '?'}`)),
      title && name && title !== name ? h('p.meta', null, text(`Agent: ${name}`)) : null,
      name ? null : h('p.hint', null, text('Dieser Agent ist nicht (mehr) in der Agentenliste. Ein Auslöser ohne Agenten kann nicht laufen.')),
      h('p.autov__rhythm', null, icon(ICONS.bolt), text(described.sentence)))));

  if (described.broad) {
    card.appendChild(h('div.autov__band.autov__band--warn', null,
      icon(ICONS.alert),
      h('div', null,
        h('strong', null, text('Sehr weit gefasst.')),
        h('p', null, text('Ohne Satzart, Schlagwort oder Titelteil reagiert dieser Auslöser auf jede einzelne Änderung an jedem Eintrag – '
          + 'auch auf die, die der Agent selbst verursacht.')))));
  }

  card.appendChild(h('p.autov__goal', null,
    h('span.autov__goal-key', null, text('Auftrag: ')),
    text(data.goal ? String(data.goal) : 'kein Auftrag hinterlegt – der Agent bekommt nur sein eigenes Systemziel.')));

  /* the two safety rails, as sentences */
  card.appendChild(h('ul.autov__rails', { role: 'list' },
    h('li', null,
      h('strong', null, text('Wartezeit: ')),
      text(Number(data.debounceMs) > 0
        ? `Nach einem Start bleibt dieser Auslöser ${formatDuration(data.debounceMs)} still. Ohne diese Sperre kann ein Agent, der selbst Einträge schreibt, sich endlos wieder selbst starten.`
        : 'Keine Wartezeit. Ein Agent, der selbst Einträge schreibt, kann sich damit ohne Ende wieder selbst starten.')),
    h('li', null,
      h('strong', null, text('Obergrenze: ')),
      text(Number(data.maxPerHour) > 0
        ? `Höchstens ${formatNumber(data.maxPerHour)} Starts pro Stunde. Ist die Grenze erreicht, lässt der Auslöser die Ereignisse liegen, statt weiterzulaufen.`
        : 'Keine Obergrenze pro Stunde. Der Auslöser startet so oft, wie etwas passiert.'),
      Number.isFinite(record.firesLastHour)
        ? text(` In der letzten Stunde ${record.firesLastHour === 1 ? 'wurde 1 Start' : `wurden ${formatNumber(record.firesLastHour)} Starts`} verbraucht.`)
        : null)));

  const facts = h('div.autov__facts');
  facts.appendChild(h('span.meta', null, text(Number.isFinite(data.fires) ? `${formatNumber(data.fires)} Mal ausgelöst` : 'Auslösungen unbekannt')));
  facts.appendChild(h('span.meta', null, text(data.firedAt ? `zuletzt ${timeAgo(data.firedAt)}` : 'noch nie ausgelöst')));
  card.appendChild(facts);

  card.appendChild(h('div.autov__actions', null,
    h('span.spacer'),
    busy ? h('span.spinner', { 'aria-hidden': 'true' }) : null,
    h('button.btn.btn--small.btn--ghost', {
      type: 'button',
      disabled: busy,
      onClick: () => removeRecord(self, 'trigger', record),
    }, icon(ICONS.trash), text('Löschen'))));

  card.appendChild(renderTriggerEditor(self, record));
  return card;
}

function renderTriggerEditor(self, record) {
  const data = dataOf(record);
  const draft = self.drafts.get(record.id) || {
    name: String(data.name || ''),
    goal: String(data.goal || ''),
    on: String(data.on || 'record.created'),
    recordType: data.recordType ? String(data.recordType) : '',
    tag: data.tag ? String(data.tag) : '',
    titleContains: data.titleContains ? String(data.titleContains) : '',
    debounceMs: Number.isFinite(data.debounceMs) ? data.debounceMs : 5000,
    maxPerHour: Number.isFinite(data.maxPerHour) ? data.maxPerHour : 12,
  };
  const preview = h('p.autov__preview');

  const refreshPreview = () => {
    const described = triggerSentence(draft);
    clear(preview);
    preview.appendChild(text(described.sentence));
    preview.dataset.broad = described.broad ? '1' : '0';
    if (described.broad) {
      preview.appendChild(h('span.autov__preview-warn', null,
        text(' Ohne jeden Filter betrifft das jeden Eintrag.')));
    }
  };

  const update = (patch) => {
    Object.assign(draft, patch);
    self.drafts.set(record.id, draft);
    refreshPreview();
  };

  const box = h('details.autov__editor', {
    open: isBeingEdited(self, record.id),
    onToggle: (event) => {
      if (event.target.open) self.openEditors.add(record.id);
      else self.openEditors.delete(record.id);
    },
  },
  h('summary', null, text('Ändern')),
  h('div.autov__grid', null,
    h('label.field', null, h('span.label', null, text('Name (frei)')),
      h('input.input', {
        type: 'text', value: draft.name,
        onInput: (event) => update({ name: event.target.value }),
      })),
    h('label.field.autov__field--wide', null, h('span.label', null, text('Auftrag')),
      h('textarea.textarea', {
        rows: '2',
        value: draft.goal,
        onInput: (event) => update({ goal: event.target.value }),
      })),
      h('label.field', null, h('span.label', null, text('Ereignis')), eventSelect(draft.on, (value) => update({ on: value }))),
      h('label.field', null, h('span.label', null, text('Satzart')), typeSelect(draft.recordType, (value) => update({ recordType: value }))),
      h('label.field', null, h('span.label', null, text('Schlagwort')),
        h('input.input', {
          type: 'text', value: draft.tag, placeholder: 'ohne #',
          onInput: (event) => update({ tag: event.target.value }),
        })),
      h('label.field', null, h('span.label', null, text('Titel enthält')),
        h('input.input', {
          type: 'text', value: draft.titleContains,
          onInput: (event) => update({ titleContains: event.target.value }),
        })),
      h('label.field', null, h('span.label', null, text('Wartezeit (ms)')),
        h('input.input', {
          type: 'number', min: String(DEBOUNCE_MIN_MS), max: String(DEBOUNCE_MAX_MS), step: '500',
          value: String(draft.debounceMs),
          onInput: (event) => update({ debounceMs: Number(event.target.value) }),
        })),
      h('label.field', null, h('span.label', null, text('Starts je Stunde')),
        h('input.input', {
          type: 'number', min: String(PER_HOUR_MIN), max: String(PER_HOUR_MAX), step: '1',
          value: String(draft.maxPerHour),
          onInput: (event) => update({ maxPerHour: Number(event.target.value) }),
        }))),
    preview,
    h('div.row', null,
      h('button.btn.btn--primary.btn--small', {
        type: 'button',
        disabled: self.busy.has(record.id),
        onClick: async () => {
          const saved = await patchRecord(self, 'trigger', record, {
            name: String(draft.name || '').trim(),
            goal: draft.goal,
            on: draft.on,
            recordType: draft.recordType || null,
            tag: String(draft.tag || '').trim().replace(/^#/, '') || null,
            titleContains: String(draft.titleContains || '').trim() || null,
            debounceMs: Number(draft.debounceMs) || 0,
            maxPerHour: Number(draft.maxPerHour) || 0,
          });
          if (!saved) return;
          self.drafts.delete(record.id);
          self.openEditors.delete(record.id);
          self.forceRebuild.add(record.id);
          renderTriggerList(self);
        },
      }, text('Speichern')),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => {
          self.drafts.delete(record.id);
          self.openEditors.delete(record.id);
          renderTriggerList(self);
        },
      }, text('Verwerfen')),
      h('span.hint', null, text('Speichern schaltet nichts ein.'))));

  refreshPreview();
  return box;
}

function eventSelect(value, onChange) {
  return buildSelect(EVENTS, value, onChange);
}

function typeSelect(value, onChange) {
  return buildSelect(RECORD_TYPES, String(value || ''), onChange);
}

function agentSelect(self, value, onChange) {
  const options = [{ value: '', label: '– bitte wählen –' }].concat(
    self.agents.map((agent) => ({ value: agent.id, label: String(dataOf(agent).name || agent.id) })),
  );
  return buildSelect(options, value || '', onChange);
}

function renderTriggerForm(self, force = false) {
  const box = self.dom.triggerForm;
  const key = formKey(self);
  if (!force && box.firstChild && self.triggerFormKey === key) return;
  self.triggerFormKey = key;
  clear(box);
  if (self.unavailable || self.loadError) return;

  const form = self.newTrigger;
  if (!self.agents.length) {
    box.appendChild(renderNoAgents(self, 'Ein Auslöser braucht einen Agenten, der etwas tut.'));
    return;
  }

  // Declared before the markup that references it: the two number fields
  // rewrite these two sentences as they are typed.
  const hints = h('ul.autov__rails', { role: 'list' });
  const preview = h('p.autov__preview');
  const refreshPreview = () => {
    const described = triggerSentence(form);
    clear(preview);
    preview.appendChild(text(described.sentence));
    preview.dataset.broad = described.broad ? '1' : '0';
    if (described.broad) {
      preview.appendChild(h('span.autov__preview-warn', null,
        text(' Das ist sehr weit gefasst: jeder Eintrag, jede Änderung. Setze wenigstens eine Satzart oder ein Schlagwort.')));
    }
  };

  box.appendChild(h('details.autov__new', {
    open: form.open === true,
    onToggle: (event) => { form.open = event.target.open; },
  },
  h('summary', null, icon(ICONS.plus), text('Neuer Auslöser')),
  h('div.autov__grid', null,
    h('label.field', null, h('span.label', null, text('Name (frei)')),
      h('input.input', {
        type: 'text', value: form.name, placeholder: 'z. B. Neue Notizen einordnen',
        onInput: (event) => { form.name = event.target.value; },
      })),
    h('label.field', null, h('span.label', null, text('Agent')), agentSelect(self, form.agentId, (value) => { form.agentId = value; })),
    h('label.field', null, h('span.label', null, text('Ereignis')), eventSelect(form.on, (value) => { form.on = value; refreshPreview(); })),
      h('label.field', null, h('span.label', null, text('Satzart')), typeSelect(form.recordType, (value) => { form.recordType = value; refreshPreview(); })),
      h('label.field', null, h('span.label', null, text('Schlagwort')),
        h('input.input', {
          type: 'text', value: form.tag, placeholder: 'ohne #',
          onInput: (event) => { form.tag = event.target.value; refreshPreview(); },
        })),
      h('label.field', null, h('span.label', null, text('Titel enthält')),
        h('input.input', {
          type: 'text', value: form.titleContains,
          onInput: (event) => { form.titleContains = event.target.value; refreshPreview(); },
        })),
      h('label.field.autov__field--wide', null, h('span.label', null, text('Auftrag')),
        h('textarea.textarea', {
          rows: '2',
          value: form.goal,
          placeholder: 'Zum Beispiel: Ordne die neue Notiz dem passenden Projekt zu.',
          onInput: (event) => { form.goal = event.target.value; },
        })),
      h('label.field', null, h('span.label', null, text('Wartezeit (ms)')),
        h('input.input', {
          type: 'number', min: String(DEBOUNCE_MIN_MS), max: String(DEBOUNCE_MAX_MS), step: '500',
          value: String(form.debounceMs),
          onInput: (event) => { form.debounceMs = Number(event.target.value); renderRailHints(self, hints, form); },
        })),
      h('label.field', null, h('span.label', null, text('Starts je Stunde')),
        h('input.input', {
          type: 'number', min: String(PER_HOUR_MIN), max: String(PER_HOUR_MAX), step: '1',
          value: String(form.maxPerHour),
          onInput: (event) => { form.maxPerHour = Number(event.target.value); renderRailHints(self, hints, form); },
        }))),
    preview,
    hints,
    form.error ? h('p.autov__form-error', { role: 'alert' }, text(errorMessage(form.error))) : null,
    h('div.row', null,
      h('button.btn.btn--primary.btn--small', {
        type: 'button',
        disabled: form.busy,
        onClick: () => createTrigger(self),
      }, icon(ICONS.plus), text('Anlegen')),
      form.busy ? h('span.spinner', { 'aria-hidden': 'true' }) : null,
      h('span.hint', null, text('Wird ausgeschaltet angelegt. Er reagiert erst, wenn du den Schalter umlegst.')))));

  refreshPreview();
  renderRailHints(self, hints, form);
}

/** The create forms only need rebuilding when one of these three changes. */
function formKey(self) {
  return `${self.agents.length}|${self.unavailable ? 'u' : '-'}|${self.loadError ? 'e' : '-'}`;
}

function renderRailHints(self, box, form) {
  clear(box);
  box.appendChild(h('li', null,
    h('strong', null, text('Wartezeit: ')),
    text(Number(form.debounceMs) > 0
      ? `Nach einem Start bleibt der Auslöser ${formatDuration(form.debounceMs)} still – das verhindert, dass ein Agent sich über seine eigenen Änderungen endlos neu startet.`
      : 'Ohne Wartezeit kann ein Agent, der selbst Einträge schreibt, sich ohne Ende wieder selbst starten.')));
  box.appendChild(h('li', null,
    h('strong', null, text('Obergrenze: ')),
    text(Number(form.maxPerHour) > 0
      ? `Höchstens ${formatNumber(form.maxPerHour)} Starts pro Stunde; danach werden Ereignisse liegen gelassen.`
      : 'Ohne Obergrenze startet der Auslöser so oft, wie etwas passiert.')));
  box.appendChild(h('li.hint', null,
    text(`Der Server hält beide Werte in seinen Grenzen: Wartezeit ${formatDuration(DEBOUNCE_MIN_MS)} bis `
      + `${formatDuration(DEBOUNCE_MAX_MS)}, ${PER_HOUR_MIN} bis ${PER_HOUR_MAX} Starts je Stunde. `
      + 'Was darüber hinausgeht, wird beim Speichern auf diese Grenzen gesetzt.')));
}

/* --------------------------- pieces -------------------------------- */

/**
 * The switch.
 *
 * A `<button role="switch">` rather than a styled checkbox: it reads as one
 * control to a screen reader, it carries the state in `aria-checked`, and its
 * visible label is a sentence about the world ("Läuft von allein"), not a
 * state word like "Aktiv" that could describe either side.
 */
function renderSwitch(enabled, busy, onToggle) {
  const button = h('button.autov__switch', {
    type: 'button',
    role: 'switch',
    'aria-checked': enabled ? 'true' : 'false',
    disabled: busy,
    onClick: onToggle,
  },
  h('span.autov__switch-track', { 'aria-hidden': 'true' }, h('span.autov__switch-knob')),
  h('span.autov__switch-label', null, text(enabled ? 'Läuft von allein' : 'Angehalten')));
  button.dataset.on = enabled ? '1' : '0';
  return button;
}

function renderErrorBand(message, at) {
  return h('div.autov__band.autov__band--danger', { role: 'alert' },
    icon(ICONS.alert),
    h('div', null,
      h('strong', null, text('Der letzte Versuch ist fehlgeschlagen.')),
      h('p', null, text(String(message))),
      at ? h('p.meta', null, text(`zuletzt ${timeAgo(at)} · ${formatDateTime(at)}`)) : null));
}

function renderNoAgents(self, why) {
  if (self.agentsError) {
    return h('p.autov__empty', null,
      text(`Die Agentenliste ist nicht abrufbar: ${errorMessage(self.agentsError)} `),
      text('Ohne sie lässt sich hier nichts anlegen.'));
  }
  return h('div.autov__empty', null,
    h('p', null, text(`${why} Es ist noch keiner angelegt.`)),
    h('button.btn.btn--small', {
      type: 'button',
      onClick: () => self.ctx.navigate('#/agents'),
    }, text('Zu den Agenten'), icon(ICONS.arrow)));
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
.autov { display: flex; flex-direction: column; gap: var(--sp-2); max-width: 980px; }
.autov .page__head { margin-bottom: 0; }

.autov__banner {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  padding: var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 4px solid var(--fg-subtle);
  border-radius: var(--r-3);
}
.autov__banner p { margin: var(--sp-05) 0 0; color: var(--fg-muted); }
.autov__banner strong { font-size: var(--fs-md); }
.autov__banner svg { width: 22px; height: 22px; flex: none; color: var(--fg-subtle); }
.autov__banner[data-state="off"] { border-left-color: var(--ok); }
.autov__banner[data-state="off"] svg { color: var(--ok); }
.autov__banner[data-state="on"] { border-left-color: var(--warn); background: var(--surface-2); }
.autov__banner[data-state="on"] svg { color: var(--warn); }
.autov__banner[data-state="unknown"] { border-left-color: var(--danger); }
.autov__banner[data-state="unknown"] svg { color: var(--danger); }
.autov__banner-list { margin: var(--sp-1) 0 0; padding-left: var(--sp-3); font-size: var(--fs-sm); color: var(--fg-muted); }

.autov__status { display: flex; flex-wrap: wrap; gap: 6px; }
.autov__status-pill {
  padding: 2px 10px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-full);
}
.autov__status-pill[data-level="on"] { color: var(--ok); border-color: var(--ok); }
.autov__status-pill[data-level="off"] { color: var(--warn); border-color: var(--warn); }

.autov__panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-2);
}
.autov__panel p { margin: 0; }
.autov__panel svg { width: 18px; height: 18px; flex: none; }
.autov__panel--danger { border-left-color: var(--danger); background: var(--danger-soft); }
.autov__panel-list { display: flex; flex-direction: column; gap: var(--sp-05); margin: 0; padding-left: var(--sp-3); }
.autov__skipped {
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--warn);
  border-radius: var(--r-1);
}
.autov__skipped-title { display: flex; align-items: center; gap: 6px; margin: 0 0 var(--sp-05); color: var(--warn); }
.autov__skipped ul { margin: 0; padding-left: var(--sp-3); font-size: var(--fs-sm); }

.autov__section { display: flex; flex-direction: column; gap: var(--sp-1); }
.autov__section-title { display: flex; align-items: center; gap: 8px; margin: var(--sp-2) 0 0; font-size: var(--fs-lg); }
.autov__section-title svg { width: 18px; height: 18px; color: var(--fg-subtle); }
.autov__section-lead { margin: 0; color: var(--fg-muted); font-size: var(--fs-sm); }

.autov__list { display: flex; flex-direction: column; gap: var(--sp-2); }
.autov__empty {
  margin: 0;
  padding: var(--sp-2);
  color: var(--fg-muted);
  background: var(--surface-2);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-2);
}
.autov__empty p { margin: 0 0 var(--sp-1); }

.autov__card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 4px solid var(--border);
  border-radius: var(--r-3);
  box-shadow: var(--shadow-1);
}
.autov__card[data-on="1"] { border-left-color: var(--warn); }
.autov__card-head { display: flex; align-items: flex-start; gap: var(--sp-2); flex-wrap: wrap; }
.autov__card-ident { flex: 1; min-width: 200px; }
.autov__card-title { margin: 0; font-size: var(--fs-md); }
.autov__card-ident .hint { margin: var(--sp-05) 0 0; color: var(--danger); }
.autov__rhythm { display: flex; align-items: center; gap: 6px; margin: var(--sp-05) 0 0; color: var(--fg-muted); }
.autov__rhythm svg { width: 15px; height: 15px; flex: none; }
.autov__goal { margin: 0; }
.autov__goal-key { color: var(--fg-subtle); }
.autov__next { margin: 0; font-weight: 500; }
.autov__facts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
.autov__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
.autov__rails { display: flex; flex-direction: column; gap: var(--sp-05); margin: 0; padding: var(--sp-1) var(--sp-2); list-style: none;
  font-size: var(--fs-sm); color: var(--fg-muted); background: var(--surface-2); border-radius: var(--r-2); }
.autov__rails strong { color: var(--fg); }

.autov__switch {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 6px var(--sp-2) 6px 6px;
  font: inherit;
  font-weight: 600;
  color: var(--fg-muted);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-full);
  cursor: pointer;
  transition: background var(--dur-2) var(--ease), color var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease);
}
.autov__switch:hover:not(:disabled) { background: var(--surface-3); }
.autov__switch:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.autov__switch:disabled { opacity: 0.6; cursor: not-allowed; }
.autov__switch-track {
  display: inline-block;
  position: relative;
  width: 40px;
  height: 22px;
  background: var(--surface-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-full);
}
.autov__switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--fg-subtle);
  border-radius: var(--r-full);
  transition: transform var(--dur-2) var(--ease), background var(--dur-2) var(--ease);
}
.autov__switch[data-on="1"] { color: var(--accent-fg); background: var(--warn); border-color: var(--warn); }
.autov__switch[data-on="1"] .autov__switch-track { background: var(--surface); border-color: var(--surface); }
.autov__switch[data-on="1"] .autov__switch-knob { transform: translateX(18px); background: var(--warn); }
.autov__switch-label { white-space: nowrap; }

.autov__band {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-2);
}
.autov__band p { margin: var(--sp-05) 0 0; }
.autov__band svg { width: 18px; height: 18px; flex: none; }
.autov__band--danger { color: var(--danger); background: var(--danger-soft); }
.autov__band--danger p { color: var(--fg); }
.autov__band--warn { color: var(--warn); background: var(--surface-2); border: 1px solid var(--warn); }
.autov__band--warn p { color: var(--fg-muted); }

.autov__editor, .autov__new {
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.autov__new { background: var(--surface); }
.autov__editor > summary, .autov__new > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  font-weight: 500;
}
.autov__new > summary { color: var(--accent); font-size: var(--fs-base); }
.autov__new > summary svg { width: 16px; height: 16px; }
.autov__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--sp-1);
  margin: var(--sp-1) 0;
}
.autov__field--wide { grid-column: 1 / -1; }
.autov__goal-input { min-height: 56px; }
.autov__preview {
  margin: 0 0 var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  font-weight: 500;
  background: var(--accent-soft);
  border-radius: var(--r-2);
}
.autov__preview[data-broad="1"] { background: var(--danger-soft); }
.autov__preview-warn { font-weight: 400; color: var(--danger); }
.autov__form-error { margin: 0 0 var(--sp-1); color: var(--danger); }

@media (max-width: 720px) {
  .autov__card-head { gap: var(--sp-1); }
  .autov__grid { grid-template-columns: 1fr; }
}
`;
