'use strict';

const {
  ValidationError,
  NotFoundError,
  asNeuralError,
} = require('../kernel/errors');
const schema = require('../store/schema');

/**
 * Agents that run when something happens.
 *
 * THE WHOLE FILE IS ABOUT NOT RUNNING. Starting an agent because a note was
 * written is four lines; the rest keeps an agent which writes a note in
 * reaction to a note being written from turning into a loop the user
 * discovers as a full disk. One brake answers "did an agent write this?"
 * exactly; the other three bound how often anything can happen at all, which
 * is a different question and stays useful even where provenance is silent.
 *
 *   1. BOOKKEEPING TYPES ARE INVISIBLE. The system writes `run`, `message`,
 *      `edge`, `memory`, `approval`, `grant`, `token`, `peer`, `conflict`,
 *      `module`, `suggestion`, `schedule` and `trigger` records constantly,
 *      and this file writes some of them itself -- every fire updates the
 *      trigger record, which publishes `record.updated`. Those types are
 *      ignored unless a trigger names the type in `recordType` explicitly,
 *      which is the user saying "yes, I meant that one". A trigger never
 *      reacts to its own record either, whatever it names.
 *
 *   2. NOTHING AN AGENT PRODUCED COUNTS AS AN EVENT. Every record a tool
 *      creates carries the id of the run that created it (`runId`, stamped by
 *      `stamped()` in tools.js); a record that has one is the system's own
 *      doing and is never an event. This is read off the record, so it costs
 *      no timing window and no guess -- see `producedByAgent()` for the one
 *      thing the stamp deliberately does not say.
 *
 *   3. DEBOUNCE. A fire closes the window for `debounceMs`; everything inside
 *      it is dropped and counted, and the count reaches the record so the user
 *      can see their trigger is being held back rather than being broken.
 *
 *   4. `maxPerHour`, ROLLING. Not "per clock hour": a cap that resets at the
 *      top of the hour lets a loop fire its whole budget twice in two minutes.
 *      When the cap is reached the reason goes into `lastError` in German and
 *      is logged once, not once per event.
 *
 *   5. A GLOBAL CEILING OF THREE runs in flight from triggers at once, across
 *      all of them. One runaway trigger must not be able to occupy the whole
 *      machine, and the skip is recorded rather than swallowed.
 *
 * Trigger-started runs get `depth: 1`, which the tool layer reads as "already
 * one level deep": such a run may still spawn a sub-agent, but that sub-agent
 * may not spawn further (see `agents.spawn` in tools.js, which refuses at
 * depth >= 2). A reaction that can start an unbounded chain of reactions is
 * the same disk-filling loop wearing a different hat.
 *
 * There is deliberately NO TIMER in this file. Both rolling windows are read
 * from timestamps when an event arrives, so nothing has to be unref'd and
 * nothing can outlive `stop()` -- the only thing that could is a bus
 * subscription, and removing exactly those is what `stop()` is for.
 */

/** Below a second the window is decoration; above an hour it is an off switch. */
const MIN_DEBOUNCE_MS = 1000;
const MAX_DEBOUNCE_MS = 3600000;
/** One an hour is the slowest useful trigger; one a minute is already a lot. */
const MIN_PER_HOUR = 1;
const MAX_PER_HOUR = 60;
/** Across every trigger together, not per trigger. */
const MAX_INFLIGHT_RUNS = 3;
const HOUR_MS = 3600000;

/**
 * A run this file started but never saw finish is assumed finished after this
 * long, so a lost `run.finished` event cannot hold a slot under the global
 * ceiling for ever. The runtime's own limit is `maxSeconds` (300 s); an hour
 * is generous enough to never cut a real run short.
 */
const RUN_ASSUMED_DONE_MS = HOUR_MS;

const EVENTS = ['record.created', 'record.updated', 'record.deleted'];

const EVENT_LABEL = {
  'record.created': 'Neuer Eintrag',
  'record.updated': 'Eintrag geändert',
  'record.deleted': 'Eintrag gelöscht',
};

/**
 * Record types the system writes for itself. Taken from `TYPES` in
 * `src/store/schema.js`: everything that is not one of the user's own things
 * (note, chat, project, task, agent, file, entity). `message` is on the list
 * because every chat turn writes one, `edge` because the graph derives them in
 * bulk, `schedule`/`trigger` because this file and its sibling write them on
 * every fire -- each of those would otherwise be a loop with one step in it.
 */
const BOOKKEEPING_TYPES = new Set([
  'run', 'message', 'edge', 'memory', 'approval', 'grant', 'token',
  'peer', 'conflict', 'module', 'suggestion', 'schedule', 'trigger',
]);

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Case- and diacritic-folding with German expansion, the same idea as
 * `fold()` in `src/store/search.js`: a trigger on "Rückblick" has to match a
 * note titled "rueckblick", because the user typed one of them months ago and
 * does not remember which.
 */
function fold(s) {
  if (typeof s !== 'string' || !s) return '';
  const lowered = s.normalize('NFC').toLowerCase().replace(/[äöüß]/g, (ch) => UMLAUTS[ch]);
  return lowered.normalize('NFD').replace(/\p{M}/gu, '');
}

function intIn(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function titleOf(record) {
  const data = (record && record.data) || {};
  for (const key of ['title', 'name', 'text', 'goal']) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key];
  }
  return '';
}

/**
 * Accept both shapes an event arrives in: the bus envelope
 * `{name, payload:{id, type, record}}` and a bare payload, so `matches()` can
 * be called from a test with the obvious literal.
 */
function normaliseEvent(event) {
  if (!isPlainObject(event)) return null;
  const payload = isPlainObject(event.payload) ? event.payload : event;
  const name = typeof event.name === 'string' && event.name
    ? event.name
    : (typeof payload.name === 'string' ? payload.name : '');
  const record = isPlainObject(payload.record) ? payload.record : null;
  const type = typeof payload.type === 'string' && payload.type
    ? payload.type
    : (record && typeof record.type === 'string' ? record.type : null);
  const id = typeof payload.id === 'string' && payload.id
    ? payload.id
    : (record && typeof record.id === 'string' ? record.id : null);
  return { name, id, type, record };
}

/**
 * Does this trigger's filter describe this event?
 *
 * Pure, and exported, because every "why did my trigger not fire?" question
 * is answered here and a question that can only be answered by starting an
 * agent is not answerable at all.
 *
 * @param {object} triggerData the `data` of a trigger record
 * @param {object} event bus envelope or payload
 * @returns {boolean}
 */
function matches(triggerData, event) {
  const data = isPlainObject(triggerData) ? triggerData : {};
  const evt = normaliseEvent(event);
  if (!evt || !evt.name) return false;

  const on = typeof data.on === 'string' && data.on ? data.on : 'record.created';
  if (evt.name !== on) return false;

  const wantType = typeof data.recordType === 'string' ? data.recordType.trim() : '';
  if (wantType && evt.type !== wantType) return false;

  const wantTag = typeof data.tag === 'string' ? data.tag.trim() : '';
  const wantTitle = typeof data.titleContains === 'string' ? data.titleContains.trim() : '';
  if (!wantTag && !wantTitle) return true;

  // A filter we cannot check is a filter that does not match. Claiming a hit
  // on a record we never saw would start an agent on a guess.
  const record = evt.record;
  if (!record) return false;
  const recordData = isPlainObject(record.data) ? record.data : {};

  if (wantTag) {
    const tags = Array.isArray(recordData.tags) ? recordData.tags : [];
    const wanted = fold(wantTag.replace(/^#/, ''));
    if (!tags.some((tag) => fold(String(tag).replace(/^#/, '')) === wanted)) return false;
  }

  if (wantTitle) {
    if (!fold(titleOf(record)).includes(fold(wantTitle))) return false;
  }

  return true;
}

/**
 * @param {{store:object, runtime?:object, bus?:object, config?:object,
 *          logger?:Function, audit?:object, now?:()=>Date}} deps
 */
function createTriggers({ store, runtime, bus, config, logger, audit, now } = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new ValidationError('createTriggers benötigt einen Store.');
  }
  const log = typeof logger === 'function' ? logger('triggers') : nullLogger();
  const cfg = isPlainObject(config) ? config : {};
  const clock = typeof now === 'function' ? now : () => new Date();

  /** Per-trigger bookkeeping that is not worth a vault write on every event. */
  const states = new Map();
  /** Runs this file started, so the global ceiling is a real count. */
  const inflight = new Map();
  /** Handlers as they were registered, so `stop()` can remove exactly those. */
  const subscriptions = [];
  /** In-flight handler promises, so tests and shutdown can wait without sleeping. */
  const working = new Set();

  let running = false;
  let droppedByDebounce = 0;
  let droppedByCap = 0;
  let droppedByLoop = 0;
  let droppedByCeiling = 0;

  function at() {
    const value = clock();
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`);
    }
  }

  function writeAudit(kind, data) {
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write(kind, data);
    } catch (err) {
      log.warn(`Audit-Eintrag ${kind} fehlgeschlagen: ${err && err.message}`);
    }
  }

  function patch(id, fields) {
    try {
      return store.update(id, fields);
    } catch (err) {
      log.error(`Auslöser ${id} konnte nicht aktualisiert werden: ${err && err.message}`);
      return null;
    }
  }

  function records() {
    return store.list('trigger', { limit: undefined, sort: 'createdAt', order: 'asc' }).items;
  }

  function mustGet(id) {
    const record = store.get(id);
    if (!record || record.type !== 'trigger') throw new NotFoundError(`Auslöser ${id}`);
    return record;
  }

  function stateOf(id) {
    let state = states.get(id);
    if (!state) {
      state = {
        lastFireAt: 0,
        fires: [],
        pendingDebounce: 0,
        pendingCap: 0,
        lastDropWriteAt: 0,
        capped: false,
      };
      states.set(id, state);
    }
    return state;
  }

  /**
   * Write the counters that were kept in memory into the record.
   * Called sparingly on purpose: one vault write per dropped event is the
   * write amplification the debounce exists to prevent.
   */
  function flush(record, state, extra = {}) {
    const fields = { ...extra };
    if (state.pendingDebounce) {
      fields.droppedByDebounce = (Number(record.data.droppedByDebounce) || 0) + state.pendingDebounce;
    }
    if (state.pendingCap) {
      fields.droppedByCap = (Number(record.data.droppedByCap) || 0) + state.pendingCap;
    }
    if (!Object.keys(fields).length) return null;
    const written = patch(record.id, fields);
    if (written) {
      state.pendingDebounce = 0;
      state.pendingCap = 0;
    }
    return written;
  }

  /* -------------------------------------------------------- loop protection */

  /**
   * Was this record written by an agent rather than by the user?
   *
   * ONE QUESTION, ONE FIELD. Every record a tool creates carries `runId` --
   * the id of the run that made it -- stamped by `stamped()` in
   * `src/agents/tools.js`. Reading it is exact: it needs no timing window, no
   * guess about what was happening at the moment the event arrived, and it is
   * as true a week later as it was in the same millisecond.
   *
   * This replaced a heuristic that suppressed every record event while any run
   * was in flight. That brake closed the loop, but it also swallowed the
   * user's own writes whenever an agent happened to be busy -- a reaction that
   * silently does not happen is exactly the kind of quiet wrongness this
   * system is built to avoid. With the stamp it is not needed, so it is gone,
   * and `runtime.listActive()` is not consulted here at all any more.
   *
   * WHAT THE STAMP SAYS AND WHAT IT DOES NOT. It says who CREATED the record.
   * For `record.created` -- the event nearly every trigger listens to -- that
   * is the same as who caused the event, so the answer is complete. For
   * `record.updated` the two can differ, deliberately: `notes.update` does not
   * relabel a record (a note the user wrote stays theirs even after an agent
   * edited it), so an agent editing the user's note produces an event with no
   * `runId` on it, and a user editing an agent's note produces one that has.
   * Both directions are visible and neither is guessed at here:
   *
   *   - agent edits the user's record: provenance cannot see it, so the three
   *     volume brakes below are what bounds it -- debounce, `maxPerHour` and
   *     the ceiling of three. A trigger on `record.updated` whose agent writes
   *     back to the same record will re-fire, at most `maxPerHour` times an
   *     hour, and its `lastError` will say so.
   *   - user edits an agent's record: treated as the agent's, so it does not
   *     fire. The safe direction of the same ambiguity.
   *
   * An event that carries no record at all (which the store never publishes)
   * has no provenance to read and is let through; `matches()` has already
   * refused it if the trigger filters on anything about the record.
   *
   * @param {object|null} record the record from the event payload
   * @returns {string|null} the German reason to drop it, or null to go on
   */
  function producedByAgent(record) {
    const data = (record && record.data) || {};
    if (typeof data.runId === 'string' && data.runId) {
      return `Von Agentenlauf ${data.runId} erzeugt.`;
    }
    // Written before the stamp existed. The vault is append-only and older
    // records keep whatever they were given, so the one stamp that did exist
    // back then is still read -- on notes and edges it was `source: 'agent'`.
    if (data.source === 'agent') {
      return 'Von einem Agentenlauf erzeugt (source=agent, vor der Einführung von runId).';
    }
    return null;
  }

  function pruneInflight() {
    const cutoff = at().getTime() - RUN_ASSUMED_DONE_MS;
    for (const [runId, startedAt] of inflight) {
      if (startedAt < cutoff) {
        inflight.delete(runId);
        continue;
      }
      if (!runtime || typeof runtime.get !== 'function') continue;
      try {
        const record = runtime.get(runId);
        const status = record && record.data ? record.data.status : null;
        if (status === 'done' || status === 'failed' || status === 'aborted') inflight.delete(runId);
      } catch {
        // Gone from the store: it certainly is not occupying the machine.
        inflight.delete(runId);
      }
    }
    return inflight.size;
  }

  /* --------------------------------------------------------- validation */

  function requireAgent(agentId) {
    const id = typeof agentId === 'string' ? agentId.trim() : '';
    if (!id) throw new ValidationError('Ein Auslöser braucht eine Agenten-ID.');
    const agent = store.get(id);
    if (!agent || agent.type !== 'agent') throw new NotFoundError(`Agent ${id}`);
    return agent;
  }

  /**
   * `name` is not in the schema and is kept anyway (the store preserves
   * unknown keys by design): the list needs a label the user chose, and the
   * goal text is an instruction, not a title. `droppedByDebounce` and
   * `droppedByCap` are extra for the same reason -- a trigger that is being
   * held back must be able to say so in the interface.
   */
  function normalise(input, opts = {}) {
    const data = isPlainObject(input) ? input : {};
    const partial = opts.partial === true;
    const out = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined;

    if (!partial || has('agentId')) {
      out.agentId = requireAgent(data.agentId).id;
    }

    if (!partial || has('goal')) {
      const goal = typeof data.goal === 'string' ? data.goal.trim() : '';
      if (!goal) throw new ValidationError('Ein Auslöser braucht ein Ziel (goal); ein Agent ohne Auftrag tut nichts.');
      if (goal.length > 20000) throw new ValidationError('Das Ziel ist zu lang (erlaubt sind 20000 Zeichen).');
      out.goal = goal;
    }

    if (has('on')) {
      if (!EVENTS.includes(data.on)) {
        throw new ValidationError(`"on" muss ${EVENTS.join(', ')} sein (empfangen: ${String(data.on)}).`);
      }
      out.on = data.on;
    } else if (!partial) {
      out.on = 'record.created';
    }

    if (has('recordType')) {
      if (data.recordType === null || data.recordType === '') out.recordType = null;
      else {
        const type = String(data.recordType).trim();
        if (!schema.TYPES.includes(type)) {
          throw new ValidationError(`"${type}" ist keine bekannte Art von Eintrag.`);
        }
        out.recordType = type;
      }
    }

    for (const key of ['tag', 'titleContains']) {
      if (!has(key)) continue;
      if (data[key] === null || data[key] === '') { out[key] = null; continue; }
      const value = String(data[key]).trim();
      if (value.length > 300) throw new ValidationError(`"${key}" ist zu lang (erlaubt sind 300 Zeichen).`);
      out[key] = value;
    }

    if (has('enabled')) {
      if (typeof data.enabled !== 'boolean') throw new ValidationError('"enabled" muss true oder false sein.');
      out.enabled = data.enabled;
    }

    // Clamped rather than rejected: these are safety rails, and a user who
    // types 0 means "as often as possible", not "refuse to save my trigger".
    if (has('debounceMs')) {
      const raw = Number(data.debounceMs);
      if (!Number.isFinite(raw)) throw new ValidationError('"debounceMs" muss eine Zahl sein.');
      out.debounceMs = intIn(raw, MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS, 5000);
    }
    if (has('maxPerHour')) {
      const raw = Number(data.maxPerHour);
      if (!Number.isFinite(raw)) throw new ValidationError('"maxPerHour" muss eine Zahl sein.');
      out.maxPerHour = intIn(raw, MIN_PER_HOUR, MAX_PER_HOUR, 12);
    }

    if (has('name')) {
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (name.length > 200) throw new ValidationError('Der Name ist zu lang (erlaubt sind 200 Zeichen).');
      out.name = name;
    }

    return out;
  }

  /* -------------------------------------------------------------- firing */

  function goalFor(data, evt) {
    const label = titleOf(evt.record) || evt.id || 'ein Eintrag';
    const kind = EVENT_LABEL[evt.name] || evt.name;
    return `${data.goal}\n\nAuslöser: ${kind} – ${evt.type || 'Eintrag'} „${label}" (${evt.id || 'ohne ID'}).`;
  }

  /** One trigger against one event, after `matches()` has already said yes. */
  async function consider(record, evt, moment) {
    const data = record.data || {};
    const state = stateOf(record.id);
    const nowMs = moment.getTime();

    // 1. bookkeeping types, unless the user named this one on purpose
    if (BOOKKEEPING_TYPES.has(evt.type) && data.recordType !== evt.type) {
      return null;
    }
    // ... and never the trigger's own record, whatever it names: a fire
    // updates it, which publishes an event, which would fire it again.
    if (evt.id && evt.id === record.id) return null;

    // 2. anything an agent produced, read off the record's own stamp
    const provenance = producedByAgent(evt.record);
    if (provenance) {
      droppedByLoop++;
      log.debug(`Auslöser ${record.id} ignoriert ${evt.id}: ${provenance}`);
      return null;
    }

    // 3. debounce
    const debounceMs = intIn(data.debounceMs, MIN_DEBOUNCE_MS, MAX_DEBOUNCE_MS, 5000);
    if (state.lastFireAt && nowMs - state.lastFireAt < debounceMs) {
      state.pendingDebounce++;
      droppedByDebounce++;
      // At most one write per window, so a runaway cannot fill the log with
      // the very counter that is measuring it.
      if (nowMs - state.lastDropWriteAt >= debounceMs) {
        state.lastDropWriteAt = nowMs;
        flush(record, state);
      }
      return null;
    }

    // 4. rolling hour cap
    const maxPerHour = intIn(data.maxPerHour, MIN_PER_HOUR, MAX_PER_HOUR, 12);
    state.fires = state.fires.filter((t) => nowMs - t < HOUR_MS);
    if (state.fires.length >= maxPerHour) {
      state.pendingCap++;
      droppedByCap++;
      const reason = `Grenze von ${maxPerHour} Läufen pro Stunde erreicht; weitere Ereignisse werden vorerst ignoriert.`;
      if (!state.capped) {
        state.capped = true;
        log.warn(`Auslöser ${record.id}: ${reason}`); // once per episode, not per event
        flush(record, state, { lastError: reason });
        writeAudit('trigger.capped', { triggerId: record.id, agentId: data.agentId, maxPerHour });
        publish('trigger.capped', { triggerId: record.id, agentId: data.agentId, maxPerHour, reason });
      }
      return null;
    }
    state.capped = false;

    // 5. global ceiling
    if (pruneInflight() >= MAX_INFLIGHT_RUNS) {
      droppedByCeiling++;
      const reason = `Es laufen bereits ${MAX_INFLIGHT_RUNS} von Auslösern gestartete Agenten; dieses Ereignis wurde übersprungen.`;
      if (record.data.lastError !== reason) flush(record, state, { lastError: reason });
      log.warn(`Auslöser ${record.id}: ${reason}`);
      return null;
    }

    if (!runtime || typeof runtime.start !== 'function') {
      const reason = 'Die Agenten-Laufzeit ist nicht verfügbar; es wurde kein Lauf gestartet.';
      if (record.data.lastError !== reason) flush(record, state, { lastError: reason });
      return null;
    }

    let run;
    try {
      run = await runtime.start({
        agentId: data.agentId,
        goal: goalFor(data, evt),
        context: {
          text: `Dieser Lauf wurde durch ein Ereignis ausgelöst: ${EVENT_LABEL[evt.name] || evt.name}.`,
          // A deleted record cannot be loaded, so it is described in the text
          // above instead of pretending it is still there to read.
          nodeIds: evt.name === 'record.deleted' || !evt.id ? [] : [evt.id],
        },
        // See the file header: one level deep already, so the run it starts
        // may delegate once and no further.
        depth: 1,
      });
    } catch (err) {
      const message = asNeuralError(err).message;
      flush(record, state, { lastError: message });
      log.warn(`Auslöser ${record.id} konnte keinen Lauf starten: ${message}`);
      writeAudit('trigger.skipped', { triggerId: record.id, agentId: data.agentId, reason: message });
      return null;
    }

    state.lastFireAt = nowMs;
    state.fires.push(nowMs);
    inflight.set(run.id, nowMs);
    flush(record, state, {
      firedAt: moment.toISOString(),
      fires: (Number(data.fires) || 0) + 1,
      lastError: null,
    });
    writeAudit('trigger.fired', {
      triggerId: record.id,
      agentId: data.agentId,
      runId: run.id,
      on: evt.name,
      recordId: evt.id,
      at: moment.toISOString(),
    });
    publish('trigger.fired', { triggerId: record.id, agentId: data.agentId, runId: run.id, recordId: evt.id });
    log.info(`Auslöser ${record.id} gestartet: Lauf ${run.id}`);
    return { triggerId: record.id, runId: run.id, agentId: data.agentId };
  }

  /**
   * Handle one record event against every enabled trigger.
   * @returns {Promise<object[]>} what was started (for tests and callers)
   */
  async function handle(event) {
    const evt = normaliseEvent(event);
    if (!evt || !EVENTS.includes(evt.name)) return [];

    let candidates;
    try {
      candidates = store.list('trigger', { limit: undefined, filter: { enabled: true } }).items;
    } catch (err) {
      log.error(`Auslöser nicht lesbar: ${err && err.message}`);
      return [];
    }
    if (!candidates.length) return [];

    const moment = at();
    const started = [];
    for (const record of candidates) {
      if (!matches(record.data, evt)) continue;
      try {
        const outcome = await consider(record, evt, moment);
        if (outcome) started.push(outcome);
      } catch (err) {
        // One broken trigger must not stop the others on the same event.
        log.error(`Auslöser ${record.id} fehlgeschlagen: ${asNeuralError(err).message}`);
      }
    }
    return started;
  }

  /** Run a handler without ever letting it reject into the bus. */
  function track(promise) {
    const task = Promise.resolve(promise).catch((err) => {
      log.error(`Ereignisverarbeitung fehlgeschlagen: ${asNeuralError(err).message}`);
    });
    working.add(task);
    task.finally(() => working.delete(task));
    return task;
  }

  const triggers = {
    list() {
      const items = records().map((record) => ({
        ...record,
        // Computed, never stored: how much of the hourly budget is left right
        // now is a property of the clock, not of the record.
        firesLastHour: firesLastHour(record.id),
      }));
      return { items, total: items.length };
    },

    get(id) {
      return mustGet(id);
    },

    create(data) {
      const normalised = normalise(data, { partial: false });
      const record = store.create('trigger', {
        ...normalised,
        enabled: normalised.enabled === true,
        lastError: null,
      });
      log.info(`Auslöser ${record.id} angelegt (${record.data.on}, ${record.data.enabled ? 'aktiv' : 'aus'}).`);
      publish('trigger.changed', { triggerId: record.id, action: 'created' });
      return record;
    },

    update(id, patchData) {
      const existing = mustGet(id);
      const normalised = normalise(patchData, { partial: true });
      if (!Object.keys(normalised).length) {
        throw new ValidationError('Es wurden keine Felder zum Ändern übergeben.');
      }
      // A trigger that is being edited starts from a clean slate: its old
      // debounce window and its old cap episode belong to the old rules.
      states.delete(existing.id);
      const record = store.update(existing.id, normalised);
      publish('trigger.changed', { triggerId: record.id, action: 'updated' });
      return record;
    },

    remove(id) {
      const existing = mustGet(id);
      states.delete(existing.id);
      const record = store.remove(existing.id);
      publish('trigger.changed', { triggerId: existing.id, action: 'removed' });
      return record;
    },

    /** Exposed so the API and the tests can ask without going through the bus. */
    matches,

    /**
     * Handle one event directly. `start()` wires the bus to exactly this, and
     * a caller that wants to know what happened can await it.
     */
    handle,

    /** Resolve when every event taken in so far has been handled. */
    async settled() {
      while (working.size) {
        await Promise.allSettled(Array.from(working));
      }
    },

    /**
     * Subscribe to the bus. The handler references are kept so `stop()` can
     * remove exactly the listeners this instance added -- a subscription that
     * survives `stop()` is a trigger that fires after the user switched the
     * system off, which is the bug this file exists to prevent.
     */
    start() {
      if (running) return triggers.status();
      if (!bus || typeof bus.on !== 'function') {
        log.warn('Kein Ereignisbus vorhanden; Auslöser bleiben untätig.');
        return triggers.status();
      }

      for (const name of EVENTS) {
        const handler = (event) => { track(handle(event)); };
        bus.on(name, handler);
        subscriptions.push([name, handler]);
      }

      // The only run bookkeeping left: a run that has ended frees its slot
      // under the global ceiling. Provenance is read off the record itself and
      // needs to know nothing about which runs are live.
      const onRunEnded = (event) => {
        const runId = event && event.payload && event.payload.runId;
        if (runId) inflight.delete(runId);
      };
      bus.on('run.finished', onRunEnded);
      bus.on('run.failed', onRunEnded);
      subscriptions.push(['run.finished', onRunEnded], ['run.failed', onRunEnded]);

      running = true;
      log.info(`Auslöser hören auf ${EVENTS.join(', ')}.`);
      return triggers.status();
    },

    stop() {
      if (!running) return false;
      for (const [name, handler] of subscriptions) {
        if (bus && typeof bus.off === 'function') bus.off(name, handler);
      }
      subscriptions.length = 0;
      running = false;
      log.info('Auslöser gestoppt.');
      return true;
    },

    /** @returns {{running:boolean, enabled:number, total:number, firedLastHour:number,
     *             droppedByDebounce:number, droppedByCap:number}} */
    status() {
      const all = records();
      let enabled = 0;
      let firedLast = 0;
      for (const record of all) {
        if (record.data.enabled === true) enabled++;
        firedLast += firesLastHour(record.id);
      }
      return {
        running,
        enabled,
        total: all.length,
        firedLastHour: firedLast,
        droppedByDebounce,
        droppedByCap,
        // Not in the agreed shape, but the two other brakes are just as real
        // and a status that hides them would be a half-truth.
        droppedByLoop,
        droppedByCeiling,
        inflight: inflight.size,
      };
    },
  };

  function firesLastHour(id) {
    const state = states.get(id);
    if (!state) return 0;
    const cutoff = at().getTime() - HOUR_MS;
    state.fires = state.fires.filter((t) => t >= cutoff);
    return state.fires.length;
  }

  return triggers;
}

module.exports = {
  createTriggers,
  matches,
  fold,
  EVENTS,
  BOOKKEEPING_TYPES,
  MAX_INFLIGHT_RUNS,
  MIN_DEBOUNCE_MS,
  MAX_DEBOUNCE_MS,
  MIN_PER_HOUR,
  MAX_PER_HOUR,
};
