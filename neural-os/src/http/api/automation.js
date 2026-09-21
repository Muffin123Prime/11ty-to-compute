'use strict';

/**
 * Automation: agents that run on a clock, and agents that run on an event.
 *
 * Reading the plan is `read`; changing it -- or making it run -- is `agents`,
 * the same capability `POST /api/agents/:id/run` requires. That is the point:
 * creating an enabled schedule is starting a run, just later and repeatedly,
 * so a shared read-only token must not be able to do it.
 *
 * `POST /api/automation/tick` runs one pass of the clock immediately and
 * answers with what really fired and what was really skipped, including the
 * reason. It exists so the interface (and the feature check) can prove the
 * scheduled path works without waiting a minute for the interval -- and it is
 * the same code path the interval uses, not a simulation of it.
 *
 * Nothing here switches anything on by itself. `enabled` arrives from the
 * client or stays false, which is what the schema defaults to.
 */

const {
  needMethod,
  asObject,
  pick,
} = require('./support');

const SCHEDULE_FIELDS = ['agentId', 'goal', 'every', 'atHour', 'onWeekday', 'enabled', 'name'];
const TRIGGER_FIELDS = [
  'agentId', 'goal', 'on', 'recordType', 'tag', 'titleContains',
  'enabled', 'debounceMs', 'maxPerHour', 'name',
];

/** The subsystems are optional; a missing one answers 503, never a fake list. */
function scheduler(rc, method) {
  return needMethod(
    rc.ctx.scheduler,
    method,
    'Die Zeitplanung',
    'Sie wird beim Start zusammen mit der Agenten-Laufzeit aufgebaut.',
  );
}

function triggers(rc, method) {
  return needMethod(
    rc.ctx.triggers,
    method,
    // Einzahl, weil `unavailable()` daraus "<Bezeichnung> ist in dieser Instanz
    // nicht verfuegbar" baut. Mit "Die Ausloeser" stand dort "Die Ausloeser
    // IST ..." -- ein Satz, den niemand schreibt, und der die Meldung wie eine
    // Maschinenuebersetzung aussehen laesst, ausgerechnet dort, wo sie erklaeren
    // soll, was fehlt.
    'Die Auslöser-Verwaltung',
    'Sie wird beim Start zusammen mit der Agenten-Laufzeit aufgebaut.',
  );
}

/** A status that cannot be read is reported as unavailable, not as empty. */
function statusOf(subsystem) {
  if (!subsystem || typeof subsystem.status !== 'function') return null;
  try {
    return subsystem.status();
  } catch {
    return null;
  }
}

function register(router) {
  router.get('/api/automation', (rc) => {
    rc.requireCapability('read');
    const schedules = scheduler(rc, 'list').list();
    const triggerList = triggers(rc, 'list').list();
    return {
      schedules,
      triggers: triggerList,
      status: {
        scheduler: statusOf(rc.ctx.scheduler),
        triggers: statusOf(rc.ctx.triggers),
      },
    };
  });

  /* ------------------------------------------------------------ schedules */

  router.get('/api/automation/schedules', (rc) => {
    rc.requireCapability('read');
    return scheduler(rc, 'list').list();
  });

  router.post('/api/automation/schedules', async (rc) => {
    rc.requireCapability('agents');
    const body = asObject(await rc.body());
    // The subsystem validates: its rules are the same whether the caller is
    // this route, a module or a test, and duplicating them here is how the
    // two drift apart.
    return { record: scheduler(rc, 'create').create(pick(body, SCHEDULE_FIELDS)) };
  });

  router.patch('/api/automation/schedules/:id', async (rc) => {
    rc.requireCapability('agents');
    const body = asObject(await rc.body());
    return { record: scheduler(rc, 'update').update(rc.params.id, pick(body, SCHEDULE_FIELDS)) };
  });

  router.delete('/api/automation/schedules/:id', (rc) => {
    rc.requireCapability('agents');
    scheduler(rc, 'remove').remove(rc.params.id);
    return { ok: true };
  });

  router.post('/api/automation/schedules/:id/run', async (rc) => {
    rc.requireCapability('agents');
    // `runNow` throws the real reason (run limit, missing agent) rather than
    // reporting a run that never started.
    return scheduler(rc, 'runNow').runNow(rc.params.id);
  });

  router.post('/api/automation/tick', async (rc) => {
    rc.requireCapability('agents');
    return scheduler(rc, 'tick').tick();
  });

  /* ------------------------------------------------------------- triggers */

  router.get('/api/automation/triggers', (rc) => {
    rc.requireCapability('read');
    return triggers(rc, 'list').list();
  });

  router.post('/api/automation/triggers', async (rc) => {
    rc.requireCapability('agents');
    const body = asObject(await rc.body());
    return { record: triggers(rc, 'create').create(pick(body, TRIGGER_FIELDS)) };
  });

  router.patch('/api/automation/triggers/:id', async (rc) => {
    rc.requireCapability('agents');
    const body = asObject(await rc.body());
    return { record: triggers(rc, 'update').update(rc.params.id, pick(body, TRIGGER_FIELDS)) };
  });

  router.delete('/api/automation/triggers/:id', (rc) => {
    rc.requireCapability('agents');
    triggers(rc, 'remove').remove(rc.params.id);
    return { ok: true };
  });
}

module.exports = { register, SCHEDULE_FIELDS, TRIGGER_FIELDS };
