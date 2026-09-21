'use strict';

const {
  NeuralError,
  ValidationError,
  NotFoundError,
  asNeuralError,
} = require('../kernel/errors');

/**
 * Agents that run on a clock.
 *
 * Four decisions that are not obvious from the code
 * -------------------------------------------------
 *
 * 1. NOTHING RUNS THAT THE USER DID NOT SWITCH ON. `enabled` defaults to
 *    false in the schema and this file never flips it. A schedule that was
 *    created but not enabled is a plan, not a process: `tick()` walks past it
 *    without a word, and `status()` counts it as `total` but not as `enabled`.
 *
 * 2. THERE IS NO CATCH-UP BURST. If the laptop was shut for three days, a
 *    daily schedule is three slots behind. Firing three runs at breakfast is
 *    never what the user wanted -- they wanted the daily summary, once, and
 *    now. So a due schedule fires exactly once and its next slot is computed
 *    from the moment it fired, not from the slot it missed. The cost is that
 *    missed slots are gone for good; that is the honest trade, and the
 *    alternative (a queue of stale runs competing for one local model) is
 *    worse in every direction.
 *
 * 3. A SCHEDULE THAT COULD NOT RUN SAYS WHY. Every path out of `fire()` that
 *    does not produce a run writes the real reason into `lastError` -- the run
 *    limit, a deleted agent, a missing runtime -- and still advances
 *    `nextRunAt`. Recording the failure without advancing would mean retrying
 *    every 60 seconds for ever, which is how a temporary problem becomes a
 *    permanent one. A cheerful "erledigt" for a run that never started would
 *    be worse than either.
 *
 * 4. THE CLOCK IS INJECTABLE AND SO IS THE TIMER. `now()` is a dependency, so
 *    the tests move time instead of sleeping through it, and `tick(at)` takes
 *    the moment it is judging. The interval timer is unref'd: a scheduler must
 *    never be the reason a CLI command or a test process refuses to exit.
 */

/** How often the clock is checked. A minute is finer than any schedule here. */
const DEFAULT_INTERVAL_MS = 60000;
/** Below this the timer costs more than the feature; above a day it is asleep. */
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 86400000;

const EVERY = ['hourly', 'daily', 'weekly'];

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @returns {Date|null} null for anything that is not a usable moment. */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function intIn(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * The next moment this schedule should fire, strictly after `from`.
 *
 * LOCAL TIME ON PURPOSE. "Jeden Tag um 8" means eight o'clock where the user
 * is, on both sides of a daylight-saving change. Building the candidate from
 * local calendar components (rather than adding 24h to a timestamp) is what
 * keeps it at 08:00 instead of drifting to 07:00 in October.
 *
 * Strictly after, never equal: a slot that has just fired must not be due
 * again on the same tick.
 *
 * Exported so it can be tested on its own -- it is the one piece of arithmetic
 * here that is easy to get wrong and impossible to notice being wrong.
 *
 * @param {{every?:string, atHour?:number, onWeekday?:number}} scheduleData
 * @param {Date|string|number} [from] defaults to now
 * @returns {string} ISO timestamp
 */
function nextRunAt(scheduleData, from) {
  const data = isPlainObject(scheduleData) ? scheduleData : {};
  const base = toDate(from) || new Date();
  const every = EVERY.includes(data.every) ? data.every : 'daily';
  const atHour = intIn(data.atHour, 0, 23, 8);
  const onWeekday = intIn(data.onWeekday, 0, 6, 1);

  if (every === 'hourly') {
    // Top of the next hour. Truncating first means a schedule created at
    // 14:37 fires at 15:00, not at 15:37 -- predictable beats clever.
    const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), 0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next.toISOString();
  }

  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), atHour, 0, 0, 0);
  if (every === 'daily') {
    if (next.getTime() <= base.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  // weekly: move to the wanted weekday first, then push a whole week if that
  // moment has already passed (which is the case every time the schedule runs
  // on its own weekday).
  next.setDate(next.getDate() + ((onWeekday - next.getDay() + 7) % 7));
  if (next.getTime() <= base.getTime()) next.setDate(next.getDate() + 7);
  return next.toISOString();
}

/** German, and honest about a schedule that is switched off. */
function nextRunLabel(data, dueIn) {
  if (!isPlainObject(data)) return 'Unbekannt';
  if (data.enabled !== true) return 'Ausgeschaltet';
  if (dueIn === null || dueIn === undefined) return 'Kein Termin berechnet';
  if (dueIn <= 0) return 'Jetzt fällig';
  if (dueIn < MINUTE_MS) return 'in weniger als einer Minute';
  if (dueIn < HOUR_MS) {
    const minutes = Math.round(dueIn / MINUTE_MS);
    return `in ${minutes} ${minutes === 1 ? 'Minute' : 'Minuten'}`;
  }
  if (dueIn < DAY_MS) {
    const hours = Math.round(dueIn / HOUR_MS);
    return `in ${hours} ${hours === 1 ? 'Stunde' : 'Stunden'}`;
  }
  const days = Math.round(dueIn / DAY_MS);
  return `in ${days} ${days === 1 ? 'Tag' : 'Tagen'}`;
}

/** "Jeden Tag um 8 Uhr" -- what the UI shows next to the agent's name. */
function rhythmLabel(data) {
  const every = EVERY.includes(data.every) ? data.every : 'daily';
  const atHour = intIn(data.atHour, 0, 23, 8);
  if (every === 'hourly') return 'Jede Stunde';
  if (every === 'daily') return `Jeden Tag um ${atHour} Uhr`;
  return `Jeden ${WEEKDAYS[intIn(data.onWeekday, 0, 6, 1)]} um ${atHour} Uhr`;
}

/**
 * @param {{store:object, runtime?:object, bus?:object, config?:object,
 *          logger?:Function, audit?:object, now?:()=>Date}} deps
 */
function createScheduler({ store, runtime, bus, config, logger, audit, now } = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new ValidationError('createScheduler benötigt einen Store.');
  }
  const log = typeof logger === 'function' ? logger('schedule') : nullLogger();
  const cfg = isPlainObject(config) ? config : {};
  const clock = typeof now === 'function' ? now : () => new Date();

  let timer = null;
  let intervalMs = intIn(
    cfg.agents && cfg.agents.scheduleIntervalMs,
    MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS,
  );

  function at() {
    return toDate(clock()) || new Date();
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

  /** Never let a bookkeeping write take a fire down with it. */
  function patch(id, fields) {
    try {
      return store.update(id, fields);
    } catch (err) {
      log.error(`Zeitplan ${id} konnte nicht aktualisiert werden: ${err && err.message}`);
      return null;
    }
  }

  function records() {
    return store.list('schedule', { limit: undefined, sort: 'createdAt', order: 'asc' }).items;
  }

  function mustGet(id) {
    const record = store.get(id);
    if (!record || record.type !== 'schedule') throw new NotFoundError(`Zeitplan ${id}`);
    return record;
  }

  /* --------------------------------------------------------- validation */

  function requireAgent(agentId) {
    const id = typeof agentId === 'string' ? agentId.trim() : '';
    if (!id) throw new ValidationError('Ein Zeitplan braucht eine Agenten-ID.');
    const agent = store.get(id);
    if (!agent || agent.type !== 'agent') throw new NotFoundError(`Agent ${id}`);
    return agent;
  }

  /**
   * Check and normalise what the caller sent.
   *
   * `name` is not in the schema and is kept anyway (the store preserves
   * unknown keys by design): the list in the interface needs a label the user
   * chose, and using the goal text for that turns a three-sentence instruction
   * into a table cell nobody can read.
   *
   * @param {object} input
   * @param {{partial?:boolean}} [opts]
   */
  function normalise(input, opts = {}) {
    const data = isPlainObject(input) ? input : {};
    const partial = opts.partial === true;
    const out = {};

    const has = (key) => Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined;

    if (!partial || has('agentId')) {
      const agent = requireAgent(data.agentId);
      out.agentId = agent.id;
    }

    if (!partial || has('goal')) {
      const goal = typeof data.goal === 'string' ? data.goal.trim() : '';
      if (!goal) throw new ValidationError('Ein Zeitplan braucht ein Ziel (goal); ein Agent ohne Auftrag tut nichts.');
      if (goal.length > 20000) throw new ValidationError('Das Ziel ist zu lang (erlaubt sind 20000 Zeichen).');
      out.goal = goal;
    }

    if (has('every')) {
      if (!EVERY.includes(data.every)) {
        throw new ValidationError(`"every" muss ${EVERY.join(', ')} sein (empfangen: ${String(data.every)}).`);
      }
      out.every = data.every;
    } else if (!partial) {
      out.every = 'daily';
    }

    if (has('atHour')) {
      const hour = Number(data.atHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new ValidationError(`"atHour" muss eine ganze Zahl zwischen 0 und 23 sein (empfangen: ${String(data.atHour)}).`);
      }
      out.atHour = hour;
    }

    if (has('onWeekday')) {
      const day = Number(data.onWeekday);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new ValidationError(`"onWeekday" muss eine ganze Zahl zwischen 0 (Sonntag) und 6 (Samstag) sein (empfangen: ${String(data.onWeekday)}).`);
      }
      out.onWeekday = day;
    }

    if (has('enabled')) {
      if (typeof data.enabled !== 'boolean') throw new ValidationError('"enabled" muss true oder false sein.');
      out.enabled = data.enabled;
    }

    if (has('name')) {
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (name.length > 200) throw new ValidationError('Der Name ist zu lang (erlaubt sind 200 Zeichen).');
      out.name = name;
    }

    return out;
  }

  /* -------------------------------------------------------------- firing */

  /**
   * Start the run for one schedule.
   *
   * Returns `{fired}` or `{skipped}` -- it never throws, because one broken
   * schedule must not stop the other ones on the same tick. `runNow()` is the
   * path that does throw; it has a user waiting for an answer.
   */
  async function fire(record, when, opts = {}) {
    const data = record.data || {};
    // Computed BEFORE the run is started and written on every path below:
    // this is the "no catch-up" rule. The next slot follows the moment we
    // fired, so three missed days collapse into one run, not three.
    const advanced = nextRunAt(data, when);
    const whenIso = when.toISOString();

    function skip(reason) {
      patch(record.id, { nextRunAt: advanced, lastError: reason });
      log.warn(`Zeitplan ${record.id} nicht ausgeführt: ${reason}`);
      writeAudit('schedule.skipped', { scheduleId: record.id, agentId: data.agentId || null, reason, at: whenIso });
      publish('schedule.skipped', { scheduleId: record.id, agentId: data.agentId || null, reason, at: whenIso });
      return { skipped: { scheduleId: record.id, reason } };
    }

    const goal = typeof data.goal === 'string' ? data.goal.trim() : '';
    if (!goal) return skip('Kein Ziel hinterlegt; es gibt nichts auszuführen.');

    if (!runtime || typeof runtime.start !== 'function') {
      return skip('Die Agenten-Laufzeit ist nicht verfügbar; es wurde kein Lauf gestartet.');
    }

    let run;
    try {
      run = await runtime.start({
        agentId: data.agentId,
        goal,
        // A scheduled run is the user's own run on a clock, so it gets the
        // ordinary top-level budget (depth 0) -- unlike a trigger-started run,
        // it cannot chain, because a clock does not react to its own output.
        context: {
          text: `Dieser Lauf wurde vom Zeitplan „${data.name || rhythmLabel(data)}" um ${whenIso} gestartet, nicht von einem Menschen im Chat.`,
        },
      });
    } catch (err) {
      // RUN_LIMIT_REACHED lands here like anything else: the real message goes
      // into the record, so the user reads "Es laufen bereits 2 Agenten"
      // instead of wondering why nothing happened.
      return skip(asNeuralError(err).message);
    }

    patch(record.id, {
      lastRunAt: whenIso,
      lastRunId: run.id,
      nextRunAt: advanced,
      lastError: null,
      runs: (Number(data.runs) || 0) + 1,
    });
    writeAudit('schedule.fired', {
      scheduleId: record.id,
      agentId: data.agentId,
      runId: run.id,
      at: whenIso,
      manual: opts.manual === true,
    });
    publish('schedule.fired', { scheduleId: record.id, agentId: data.agentId, runId: run.id, at: whenIso });
    log.info(`Zeitplan ${record.id} gestartet: Lauf ${run.id}`);
    return { fired: { scheduleId: record.id, runId: run.id, agentId: data.agentId } };
  }

  const scheduler = {
    /**
     * @returns {{items:object[], total:number}} records plus two computed
     * fields per item -- `dueIn` (ms, negative when overdue) and the German
     * `nextRunLabel`. Both are derived on read and never stored: a label in
     * the vault would be stale the moment the clock moved.
     */
    list() {
      const reference = at().getTime();
      const items = records().map((record) => {
        const next = toDate(record.data.nextRunAt);
        const dueIn = next ? next.getTime() - reference : null;
        return {
          ...record,
          dueIn,
          nextRunLabel: nextRunLabel(record.data, dueIn),
          rhythmLabel: rhythmLabel(record.data),
        };
      });
      return { items, total: items.length };
    },

    get(id) {
      return mustGet(id);
    },

    /** @param {object} data @returns {object} the schedule record */
    create(data) {
      const normalised = normalise(data, { partial: false });
      const record = store.create('schedule', {
        ...normalised,
        // Off until the user says otherwise, unless they said otherwise here.
        enabled: normalised.enabled === true,
        nextRunAt: nextRunAt(normalised, at()),
        lastError: null,
      });
      log.info(`Zeitplan ${record.id} angelegt (${rhythmLabel(record.data)}, ${record.data.enabled ? 'aktiv' : 'aus'}).`);
      publish('schedule.changed', { scheduleId: record.id, action: 'created' });
      return record;
    },

    /**
     * The next slot is recomputed when the rhythm changes, and when a schedule
     * is switched on: a `nextRunAt` from last week would otherwise make it fire
     * the instant it is enabled, which reads as "it ran without me".
     */
    update(id, patchData) {
      const existing = mustGet(id);
      const normalised = normalise(patchData, { partial: true });
      if (!Object.keys(normalised).length) {
        throw new ValidationError('Es wurden keine Felder zum Ändern übergeben.');
      }
      const merged = { ...existing.data, ...normalised };
      const rhythmChanged = ['every', 'atHour', 'onWeekday'].some(
        (key) => normalised[key] !== undefined && normalised[key] !== existing.data[key],
      );
      const switchedOn = normalised.enabled === true && existing.data.enabled !== true;
      if (rhythmChanged || switchedOn || !existing.data.nextRunAt) {
        normalised.nextRunAt = nextRunAt(merged, at());
      }
      const record = store.update(existing.id, normalised);
      publish('schedule.changed', { scheduleId: record.id, action: 'updated' });
      return record;
    },

    remove(id) {
      const existing = mustGet(id);
      const record = store.remove(existing.id);
      publish('schedule.changed', { scheduleId: existing.id, action: 'removed' });
      return record;
    },

    /**
     * Judge every schedule against one moment and start what is due.
     *
     * @param {Date|string|number} [when] defaults to `now()`
     * @returns {Promise<{at:string, fired:object[], skipped:object[]}>}
     */
    async tick(when) {
      const moment = toDate(when) || at();
      const fired = [];
      const skipped = [];

      for (const record of records()) {
        const data = record.data || {};
        if (data.enabled !== true) continue;

        const next = toDate(data.nextRunAt);
        if (!next) {
          // Enabled but never scheduled (or the field was damaged): give it a
          // slot and let a later tick fire it. Treating "no date" as "due now"
          // would start a run at the second the user flipped the switch.
          patch(record.id, { nextRunAt: nextRunAt(data, moment) });
          continue;
        }
        if (next.getTime() > moment.getTime()) continue;

        const outcome = await fire(record, moment);
        if (outcome.fired) fired.push(outcome.fired);
        if (outcome.skipped) skipped.push(outcome.skipped);
      }

      return { at: moment.toISOString(), fired, skipped };
    },

    /**
     * Fire one schedule now, whatever the clock says.
     *
     * Works on a switched-off schedule too: this is a button the user pressed,
     * not the system deciding on its own. Unlike `tick`, the error is thrown --
     * somebody is waiting for the answer and "nothing happened" is not one.
     *
     * @param {string} id
     * @returns {Promise<{runId:string}>}
     */
    async runNow(id) {
      const record = mustGet(id);
      const data = record.data || {};
      const moment = at();
      const goal = typeof data.goal === 'string' ? data.goal.trim() : '';
      if (!goal) throw new ValidationError('Dieser Zeitplan hat kein Ziel; es gibt nichts auszuführen.');
      if (!runtime || typeof runtime.start !== 'function') {
        throw new NeuralError(
          'SUBSYSTEM_UNAVAILABLE',
          'Die Agenten-Laufzeit ist nicht verfügbar; es wurde kein Lauf gestartet.',
          { status: 503 },
        );
      }

      const outcome = await fire(record, moment, { manual: true });
      if (outcome.fired) return { runId: outcome.fired.runId };
      // `fire` has already written the real reason into the record; the caller
      // gets the same sentence rather than a generic failure.
      throw new NeuralError('SCHEDULE_NOT_RUN', outcome.skipped.reason, { status: 409, details: { scheduleId: record.id } });
    },

    /**
     * Start the interval. Calling it twice is a no-op, not a second timer.
     * @param {{intervalMs?:number}} [opts]
     */
    start(opts = {}) {
      if (opts && opts.intervalMs !== undefined) {
        intervalMs = intIn(opts.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS);
      }
      if (timer) return scheduler.status();

      timer = setInterval(() => {
        // A tick error is a logged incident, never an exception thrown into a
        // timer callback -- that one takes the whole process down.
        Promise.resolve(scheduler.tick()).catch((err) => {
          log.error(`Zeitplan-Durchlauf fehlgeschlagen: ${asNeuralError(err).message}`);
        });
      }, intervalMs);
      // Unref'd on purpose: the clock must never be the reason a command-line
      // run or a test process hangs around after its work is done.
      if (typeof timer.unref === 'function') timer.unref();

      log.info(`Zeitplan-Uhr läuft (alle ${Math.round(intervalMs / 1000)} s).`);
      return scheduler.status();
    },

    stop() {
      if (!timer) return false;
      clearInterval(timer);
      timer = null;
      log.info('Zeitplan-Uhr gestoppt.');
      return true;
    },

    /** @returns {{running:boolean, intervalMs:number, enabled:number, total:number, nextDue:string|null}} */
    status() {
      const all = records();
      let nextDue = null;
      let enabled = 0;
      for (const record of all) {
        if (record.data.enabled !== true) continue;
        enabled++;
        const next = toDate(record.data.nextRunAt);
        if (!next) continue;
        if (!nextDue || next.getTime() < nextDue.getTime()) nextDue = next;
      }
      return {
        running: timer !== null,
        intervalMs,
        enabled,
        total: all.length,
        nextDue: nextDue ? nextDue.toISOString() : null,
      };
    },
  };

  return scheduler;
}

module.exports = {
  createScheduler,
  nextRunAt,
  nextRunLabel,
  rhythmLabel,
  EVERY,
  DEFAULT_INTERVAL_MS,
};
