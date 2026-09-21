'use strict';

/**
 * Tests for automation: agents on a clock (`src/agents/schedule.js`) and
 * agents on an event (`src/agents/triggers.js`), plus their HTTP surface.
 *
 * Three rules hold everywhere in this file:
 *
 *   - NO SLEEPS. Time is a dependency here: both subsystems take `now`, and
 *     every test moves the fake clock instead of waiting for the real one. A
 *     test that waits a second to prove a debounce window is a test that will
 *     one day fail on a busy machine for no reason.
 *   - NO REAL AGENT. `runtime` is a double that records what it was asked to
 *     start. The subject is the decision to start a run, not what a model
 *     would then say.
 *   - NO REAL HOME, NO NETWORK. Vaults live in `tempHome()`; the HTTP tests
 *     bind an ephemeral loopback port.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const { test, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const { layout, ensureLayout } = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const { createServer } = require('../src/http/server');
const { ValidationError, NotFoundError, NeuralError } = require('../src/kernel/errors');

const scheduleMod = require('../src/agents/schedule');
const { createScheduler, nextRunAt } = scheduleMod;
const triggersMod = require('../src/agents/triggers');
const { createTriggers, matches } = triggersMod;
const automationApi = require('../src/http/api/automation');

/** Tests must not write diagnostics over the runner's output. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

/* ------------------------------------------------- route registration seam */

/**
 * `src/http/server.js` builds its router from a fixed list of route files and
 * this agent may not edit that file, so until the integrator adds
 * `require('./api/automation')` the registration is injected through a route
 * module the server already loads. The server itself -- headers, auth, CSRF,
 * the router, error serialisation -- is the real, unpatched one, and the seam
 * disappears as soon as the server registers the routes itself (which this
 * checks for rather than assumes).
 */
const SERVER_FILE = require.resolve('../src/http/server');
const SERVER_REGISTERS_AUTOMATION = /require\(['"]\.\/api\/automation['"]\)/
  .test(require('node:fs').readFileSync(SERVER_FILE, 'utf8'));

if (!SERVER_REGISTERS_AUTOMATION) {
  const host = require('../src/http/api/agents');
  const originalRegister = host.register;
  host.register = function registerWithAutomation(router) {
    originalRegister.call(this, router);
    automationApi.register(router);
  };
}

/* ------------------------------------------------------------- utilities */

/** A clock the test moves by hand. */
function fakeClock(start) {
  let current = (start instanceof Date ? start : new Date(start)).getTime();
  return {
    now: () => new Date(current),
    advance(ms) { current += ms; return new Date(current); },
    set(value) { current = (value instanceof Date ? value : new Date(value)).getTime(); },
    get date() { return new Date(current); },
  };
}

/**
 * A runtime double.
 *
 * `active` is what `listActive()` reports and is what the trigger loop
 * protection reads; it is deliberately separate from the runs this double has
 * started, so a test can say "an agent is busy" without starting one.
 */
function fakeRuntime(opts = {}) {
  const runtime = {
    started: [],
    active: [],
    error: opts.error || null,
    statusOf: opts.statusOf || 'running',
    async start(options) {
      if (runtime.error) throw runtime.error;
      const id = `run_${String(runtime.started.length + 1).padStart(21, '0')}`;
      runtime.started.push({ ...options, runId: id });
      return { id, type: 'run', data: { agentId: options.agentId, goal: options.goal, status: 'running' } };
    },
    listActive() { return runtime.active.slice(); },
    get(runId) { return { id: runId, type: 'run', data: { status: runtime.statusOf, producedIds: [] } }; },
  };
  return runtime;
}

/** Store, bus and audit in a throwaway home; no HTTP, no agent, no clock. */
async function makeEnv(opts = {}) {
  const { home, cleanup } = tempHome('automation');
  const paths = ensureLayout(layout(home));
  const config = configMod.defaults();
  const bus = new Bus();
  // Buffered but never written to disk: `tail()` still answers.
  const audit = new Audit(paths.audit, { enabled: false });
  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto: null });
  const clock = fakeClock(opts.now || '2026-03-10T09:00:00.000Z');
  const runtime = opts.runtime || fakeRuntime();

  const agent = store.create('agent', { name: 'Testagent', systemPrompt: 'Du bist ein Testagent.' });

  const deps = { store, runtime, bus, config, logger: silentLogger, audit, now: clock.now };
  const scheduler = createScheduler(deps);
  const triggers = createTriggers(deps);

  return {
    home, paths, config, bus, audit, store, clock, runtime, agent, scheduler, triggers,
    async close() {
      scheduler.stop();
      triggers.stop();
      await triggers.settled();
      await store.close();
      audit.close();
      cleanup();
    },
  };
}

function local(y, m, d, h = 0, min = 0) {
  return new Date(y, m, d, h, min, 0, 0);
}

/* --------------------------------------------------------------- nextRunAt */

test('nextRunAt: stündlich springt auf die nächste volle Stunde', () => {
  const from = local(2026, 2, 10, 14, 37);
  assert.equal(nextRunAt({ every: 'hourly' }, from), local(2026, 2, 10, 15, 0).toISOString());

  // Genau auf der vollen Stunde: der gerade gelaufene Slot zählt nicht noch einmal.
  assert.equal(nextRunAt({ every: 'hourly' }, local(2026, 2, 10, 15, 0)), local(2026, 2, 10, 16, 0).toISOString());
});

test('nextRunAt: stündlich über Mitternacht hinweg', () => {
  assert.equal(nextRunAt({ every: 'hourly' }, local(2026, 2, 10, 23, 30)), local(2026, 2, 11, 0, 0).toISOString());
});

test('nextRunAt: täglich vor und nach der Uhrzeit', () => {
  const data = { every: 'daily', atHour: 8 };
  assert.equal(nextRunAt(data, local(2026, 2, 10, 7, 0)), local(2026, 2, 10, 8, 0).toISOString());
  // Nach acht: erst morgen wieder -- der Tageswechsel ist der Regelfall, nicht die Ausnahme.
  assert.equal(nextRunAt(data, local(2026, 2, 10, 9, 0)), local(2026, 2, 11, 8, 0).toISOString());
  // Punkt acht: echt später, sonst feuert derselbe Slot zweimal.
  assert.equal(nextRunAt(data, local(2026, 2, 10, 8, 0)), local(2026, 2, 11, 8, 0).toISOString());
});

test('nextRunAt: täglich um Mitternacht rollt auf den nächsten Tag', () => {
  assert.equal(
    nextRunAt({ every: 'daily', atHour: 0 }, local(2026, 2, 10, 23, 30)),
    local(2026, 2, 11, 0, 0).toISOString(),
  );
});

test('nextRunAt: wöchentlich trifft den richtigen Wochentag', () => {
  const data = { every: 'weekly', atHour: 9, onWeekday: 1 }; // Montag
  for (let day = 0; day < 7; day++) {
    const from = local(2026, 2, 8 + day, 12, 0);
    const next = new Date(nextRunAt(data, from));
    assert.equal(next.getDay(), 1, `Start ${from.toISOString()} führt nicht auf einen Montag`);
    assert.equal(next.getHours(), 9);
    assert.ok(next.getTime() > from.getTime(), 'der nächste Termin muss in der Zukunft liegen');
    assert.ok(next.getTime() - from.getTime() <= 8 * 86400000, 'höchstens eine Woche entfernt');
  }
});

test('nextRunAt: wöchentlich am eigenen Wochentag springt eine ganze Woche', () => {
  const data = { every: 'weekly', atHour: 9, onWeekday: 1 };
  const monday = new Date(nextRunAt(data, local(2026, 2, 8, 12, 0)));
  assert.equal(monday.getDay(), 1);
  // Von Montag 10:00 aus ist der Slot von heute vorbei -> exakt sieben Tage weiter.
  const from = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 10, 0, 0, 0);
  const next = new Date(nextRunAt(data, from));
  assert.equal(next.getTime() - new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 9, 0, 0, 0).getTime(), 7 * 86400000);
});

/* --------------------------------------------------------------- Zeitpläne */

test('Ein Zeitplan wird ausgeschaltet angelegt und prüft seine Eingaben', async () => {
  const env = await makeEnv();
  try {
    const record = env.scheduler.create({ agentId: env.agent.id, goal: 'Tagesrückblick schreiben', every: 'daily', atHour: 8 });
    assert.equal(record.type, 'schedule');
    assert.equal(record.data.enabled, false, 'ein Zeitplan startet nie von allein');
    assert.ok(record.data.nextRunAt, 'der nächste Termin wird beim Anlegen berechnet');
    assert.ok(new Date(record.data.nextRunAt).getTime() > env.clock.date.getTime());

    assert.throws(() => env.scheduler.create({ agentId: 'agent_gibtesnicht', goal: 'x' }), NotFoundError);
    assert.throws(() => env.scheduler.create({ agentId: env.agent.id, goal: '   ' }), ValidationError);
    assert.throws(() => env.scheduler.create({ agentId: env.agent.id, goal: 'x', every: 'minütlich' }), ValidationError);
    assert.throws(() => env.scheduler.create({ agentId: env.agent.id, goal: 'x', atHour: 24 }), ValidationError);
    assert.throws(() => env.scheduler.create({ agentId: env.agent.id, goal: 'x', onWeekday: 7 }), ValidationError);
  } finally {
    await env.close();
  }
});

test('list() reicht dueIn und eine deutsche Beschriftung mit', async () => {
  const env = await makeEnv();
  try {
    env.scheduler.create({ agentId: env.agent.id, goal: 'Rückblick', every: 'hourly', enabled: true });
    const { items, total } = env.scheduler.list();
    assert.equal(total, 1);
    assert.ok(items[0].dueIn > 0, 'dueIn ist die Zeit bis zum nächsten Termin');
    // Je nach Zeitzone liegt die nächste volle Stunde Minuten oder eine Stunde
    // entfernt; beide Formulierungen sind richtig, beide sind deutsch.
    assert.match(items[0].nextRunLabel, /^in (weniger als einer Minute|\d+ (Minuten?|Stunden?))$/);

    env.scheduler.update(items[0].id, { enabled: false });
    assert.equal(env.scheduler.list().items[0].nextRunLabel, 'Ausgeschaltet');
  } finally {
    await env.close();
  }
});

test('Ein fälliger Zeitplan startet genau einen Lauf, ein künftiger keinen', async () => {
  const env = await makeEnv();
  try {
    const due = env.scheduler.create({ agentId: env.agent.id, goal: 'Fälliger Auftrag', every: 'daily', enabled: true });
    const later = env.scheduler.create({ agentId: env.agent.id, goal: 'Späterer Auftrag', every: 'daily', enabled: true });
    env.store.update(due.id, { nextRunAt: new Date(env.clock.date.getTime() - 60000).toISOString() });

    const result = await env.scheduler.tick();
    assert.equal(result.fired.length, 1, 'nur der fällige Zeitplan feuert');
    assert.equal(result.skipped.length, 0);
    assert.equal(result.fired[0].scheduleId, due.id);
    assert.equal(env.runtime.started.length, 1);
    assert.equal(env.runtime.started[0].agentId, env.agent.id);
    assert.equal(env.runtime.started[0].goal, 'Fälliger Auftrag');

    const after = env.store.get(due.id);
    assert.equal(after.data.runs, 1);
    assert.equal(after.data.lastRunId, result.fired[0].runId);
    assert.equal(after.data.lastError, null);
    assert.equal(env.store.get(later.id).data.runs, 0);

    // Audit: ein Lauf, der stattgefunden hat, steht im Protokoll.
    assert.ok(env.audit.tail().some((entry) => entry.kind === 'schedule.fired' && entry.scheduleId === due.id));

    // Zweiter Durchlauf zur selben Zeit: der Termin ist weitergerückt.
    const again = await env.scheduler.tick();
    assert.equal(again.fired.length, 0);
    assert.equal(env.runtime.started.length, 1);
  } finally {
    await env.close();
  }
});

test('Kein Nachholen: drei versäumte Tage ergeben einen Lauf, nicht drei', async () => {
  const env = await makeEnv();
  try {
    const record = env.scheduler.create({ agentId: env.agent.id, goal: 'Täglicher Rückblick', every: 'daily', atHour: 8, enabled: true });
    // Der Rechner war drei Tage aus.
    env.store.update(record.id, { nextRunAt: new Date(env.clock.date.getTime() - 3 * 86400000).toISOString() });

    const result = await env.scheduler.tick();
    assert.equal(result.fired.length, 1);
    assert.equal(env.runtime.started.length, 1, 'kein Schwall nachgeholter Läufe');

    const after = env.store.get(record.id);
    assert.equal(after.data.runs, 1);
    assert.ok(
      new Date(after.data.nextRunAt).getTime() > env.clock.date.getTime(),
      'der nächste Termin wird ab jetzt gerechnet, nicht ab dem versäumten Slot',
    );

    // Und auch danach bleibt es bei einem Lauf.
    await env.scheduler.tick();
    await env.scheduler.tick();
    assert.equal(env.runtime.started.length, 1);
  } finally {
    await env.close();
  }
});

test('Ein Fehler der Laufzeit landet als echter Grund im Zeitplan', async () => {
  const limit = new NeuralError('RUN_LIMIT_REACHED', 'Es laufen bereits 2 Agenten (Grenze: 2).', { status: 429 });
  const env = await makeEnv({ runtime: fakeRuntime({ error: limit }) });
  try {
    const record = env.scheduler.create({ agentId: env.agent.id, goal: 'Rückblick', every: 'hourly', enabled: true });
    env.store.update(record.id, { nextRunAt: new Date(env.clock.date.getTime() - 1000).toISOString() });

    const result = await env.scheduler.tick(); // wirft nicht
    assert.equal(result.fired.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /Es laufen bereits 2 Agenten/);

    const after = env.store.get(record.id);
    assert.match(after.data.lastError, /Es laufen bereits 2 Agenten/);
    assert.equal(after.data.runs, 0, 'ein Lauf, der nie startete, wird nicht gezählt');
    assert.ok(
      new Date(after.data.nextRunAt).getTime() > env.clock.date.getTime(),
      'der Termin rückt trotzdem weiter, sonst wird jede Minute neu angeklopft',
    );
  } finally {
    await env.close();
  }
});

test('Ohne Laufzeit meldet der Zeitplan den wahren Grund statt Erfolg', async () => {
  const env = await makeEnv();
  try {
    const bare = createScheduler({ store: env.store, bus: env.bus, logger: silentLogger, now: env.clock.now });
    const record = bare.create({ agentId: env.agent.id, goal: 'Rückblick', every: 'hourly', enabled: true });
    env.store.update(record.id, { nextRunAt: new Date(env.clock.date.getTime() - 1000).toISOString() });

    const result = await bare.tick();
    assert.equal(result.fired.length, 0);
    assert.match(result.skipped[0].reason, /Laufzeit ist nicht verfügbar/);
    assert.match(env.store.get(record.id).data.lastError, /Laufzeit ist nicht verfügbar/);
  } finally {
    await env.close();
  }
});

test('Ein ausgeschalteter Zeitplan feuert nie', async () => {
  const env = await makeEnv();
  try {
    const record = env.scheduler.create({ agentId: env.agent.id, goal: 'Rückblick', every: 'hourly' });
    assert.equal(record.data.enabled, false);
    env.store.update(record.id, { nextRunAt: new Date(env.clock.date.getTime() - 86400000).toISOString() });

    const result = await env.scheduler.tick();
    assert.equal(result.fired.length, 0);
    assert.equal(result.skipped.length, 0, 'ein ausgeschalteter Zeitplan ist kein übersprungener Zeitplan');
    assert.equal(env.runtime.started.length, 0);
  } finally {
    await env.close();
  }
});

test('Ein frisch eingeschalteter Zeitplan feuert nicht sofort', async () => {
  const env = await makeEnv();
  try {
    const record = env.scheduler.create({ agentId: env.agent.id, goal: 'Rückblick', every: 'daily', atHour: 8 });
    env.store.update(record.id, { nextRunAt: new Date(env.clock.date.getTime() - 86400000).toISOString() });

    env.scheduler.update(record.id, { enabled: true });
    const result = await env.scheduler.tick();
    assert.equal(result.fired.length, 0, 'der Termin wird beim Einschalten neu berechnet');
    assert.ok(new Date(env.store.get(record.id).data.nextRunAt).getTime() > env.clock.date.getTime());
  } finally {
    await env.close();
  }
});

test('runNow startet sofort und wirft den echten Fehler', async () => {
  const env = await makeEnv();
  try {
    const record = env.scheduler.create({ agentId: env.agent.id, goal: 'Sofort bitte', every: 'weekly' });
    const { runId } = await env.scheduler.runNow(record.id);
    assert.ok(runId);
    assert.equal(env.runtime.started.length, 1);
    assert.equal(env.store.get(record.id).data.runs, 1);

    env.runtime.error = new NeuralError('RUN_LIMIT_REACHED', 'Es laufen bereits 2 Agenten.', { status: 429 });
    await assert.rejects(() => env.scheduler.runNow(record.id), /Es laufen bereits 2 Agenten/);
    await assert.rejects(() => env.scheduler.runNow('schedule_gibtesnicht'), NotFoundError);
  } finally {
    await env.close();
  }
});

test('status() zählt nur, was wirklich eingeschaltet ist', async () => {
  const env = await makeEnv();
  try {
    assert.deepEqual(env.scheduler.status(), { running: false, intervalMs: 60000, enabled: 0, total: 0, nextDue: null });
    env.scheduler.create({ agentId: env.agent.id, goal: 'A', every: 'hourly', enabled: true });
    env.scheduler.create({ agentId: env.agent.id, goal: 'B', every: 'daily' });

    const status = env.scheduler.status();
    assert.equal(status.total, 2);
    assert.equal(status.enabled, 1);
    assert.ok(status.nextDue);
  } finally {
    await env.close();
  }
});

test('start() zweimal legt nur einen Timer an', async () => {
  const env = await makeEnv();
  const realSetInterval = global.setInterval;
  let created = 0;
  try {
    global.setInterval = (...args) => { created++; return realSetInterval(...args); };
    env.scheduler.start({ intervalMs: 1000 });
    env.scheduler.start({ intervalMs: 1000 });
    assert.equal(created, 1);
    assert.equal(env.scheduler.status().running, true);
    assert.equal(env.scheduler.stop(), true);
    assert.equal(env.scheduler.stop(), false, 'zweimal stoppen ist kein Fehler, aber auch kein zweiter Timer');
  } finally {
    global.setInterval = realSetInterval;
    await env.close();
  }
});

/* ---------------------------------------------------------------- matches */

test('matches(): jedes Filterfeld, positiv und negativ', () => {
  const record = {
    id: 'note_x', type: 'note',
    data: { title: 'Rückblick März', tags: ['projekt', 'wichtig'] },
  };
  const event = { name: 'record.created', payload: { id: 'note_x', type: 'note', record } };

  assert.equal(matches({ on: 'record.created' }, event), true);
  assert.equal(matches({ on: 'record.updated' }, event), false, 'anderes Ereignis');

  assert.equal(matches({ on: 'record.created', recordType: 'note' }, event), true);
  assert.equal(matches({ on: 'record.created', recordType: 'task' }, event), false);

  assert.equal(matches({ on: 'record.created', tag: 'projekt' }, event), true);
  assert.equal(matches({ on: 'record.created', tag: '#projekt' }, event), true, 'die Raute ist Schreibweise, kein Unterschied');
  assert.equal(matches({ on: 'record.created', tag: 'privat' }, event), false);

  assert.equal(matches({ on: 'record.created', titleContains: 'rückblick' }, event), true);
  assert.equal(matches({ on: 'record.created', titleContains: 'rueckblick' }, event), true, 'deutsche Faltung');
  assert.equal(matches({ on: 'record.created', titleContains: 'Einkauf' }, event), false);

  // Alle Filter zusammen müssen alle passen.
  assert.equal(matches({ on: 'record.created', recordType: 'note', tag: 'wichtig', titleContains: 'märz' }, event), true);
  assert.equal(matches({ on: 'record.created', recordType: 'note', tag: 'wichtig', titleContains: 'april' }, event), false);

  // Ein Filter, der nicht geprüft werden kann, gilt nicht als Treffer.
  assert.equal(matches({ on: 'record.created', tag: 'projekt' }, { name: 'record.created', payload: { id: 'note_x', type: 'note' } }), false);
  assert.equal(matches({ on: 'record.created' }, null), false);
});

test('matches(): ein Projekt wird über seinen Namen gefunden', () => {
  const record = { id: 'project_1', type: 'project', data: { name: 'Umzug Berlin', tags: [] } };
  const event = { name: 'record.updated', payload: { id: 'project_1', type: 'project', record } };
  assert.equal(matches({ on: 'record.updated', titleContains: 'umzug' }, event), true);
  assert.equal(matches({ on: 'record.updated', titleContains: 'hamburg' }, event), false);
});

/* ---------------------------------------------------------------- Auslöser */

async function withTrigger(opts, fn) {
  const env = await makeEnv(opts.env);
  try {
    const record = env.triggers.create({
      agentId: env.agent.id,
      goal: 'Notiz einsortieren',
      on: 'record.created',
      recordType: 'note',
      enabled: true,
      ...opts.trigger,
    });
    env.triggers.start();
    await fn(env, record);
  } finally {
    await env.close();
  }
}

test('Ein Auslöser wird ausgeschaltet angelegt und prüft seine Eingaben', async () => {
  const env = await makeEnv();
  try {
    const record = env.triggers.create({ agentId: env.agent.id, goal: 'Einsortieren', on: 'record.created' });
    assert.equal(record.data.enabled, false, 'ein Auslöser startet nie von allein');

    assert.throws(() => env.triggers.create({ agentId: env.agent.id, goal: 'x', on: 'record.geloescht' }), ValidationError);
    assert.throws(() => env.triggers.create({ agentId: 'agent_weg', goal: 'x' }), NotFoundError);
    assert.throws(() => env.triggers.create({ agentId: env.agent.id, goal: '' }), ValidationError);
    assert.throws(() => env.triggers.create({ agentId: env.agent.id, goal: 'x', recordType: 'zettel' }), ValidationError);

    // Grenzwerte werden geklemmt, nicht abgelehnt: eine 0 heißt "so oft wie möglich".
    const clamped = env.triggers.create({ agentId: env.agent.id, goal: 'x', debounceMs: 0, maxPerHour: 9999 });
    assert.equal(clamped.data.debounceMs, 1000);
    assert.equal(clamped.data.maxPerHour, 60);
  } finally {
    await env.close();
  }
});

test('Ein Auslöser feuert auf ein passendes Ereignis und nicht auf ein anderes', async () => {
  await withTrigger({ trigger: { tag: 'projekt' } }, async (env, record) => {
    env.store.create('note', { title: 'Passt nicht', tags: ['privat'] });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 0, 'falsches Schlagwort');

    env.store.create('task', { title: 'Falsche Art', tags: ['projekt'] });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 0, 'falsche Art von Eintrag');

    const note = env.store.create('note', { title: 'Neue Projektnotiz', tags: ['projekt'] });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1);
    assert.equal(env.runtime.started[0].agentId, env.agent.id);
    assert.equal(env.runtime.started[0].depth, 1, 'ein ausgelöster Lauf ist bereits eine Ebene tief');
    assert.match(env.runtime.started[0].goal, /Notiz einsortieren/);
    assert.match(env.runtime.started[0].goal, /Neue Projektnotiz/);
    assert.deepEqual(env.runtime.started[0].context.nodeIds, [note.id]);

    const after = env.store.get(record.id);
    assert.equal(after.data.fires, 1);
    assert.ok(after.data.firedAt);
    assert.equal(after.data.lastError, null);
    assert.ok(env.audit.tail().some((entry) => entry.kind === 'trigger.fired' && entry.triggerId === record.id));
  });
});

test('Ein ausgeschalteter Auslöser feuert nie', async () => {
  await withTrigger({ trigger: { enabled: false } }, async (env) => {
    env.store.create('note', { title: 'Irgendwas' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 0);
  });
});

test('Entprellen: zwei Ereignisse im selben Fenster ergeben einen Lauf', async () => {
  await withTrigger({ trigger: { debounceMs: 60000 } }, async (env, record) => {
    env.store.create('note', { title: 'Erste' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1);

    env.clock.advance(5000); // innerhalb des Fensters
    env.store.create('note', { title: 'Zweite' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1, 'das zweite Ereignis wird verworfen');
    assert.ok(env.store.get(record.id).data.droppedByDebounce >= 1, 'und dabei gezählt');

    env.clock.advance(60000); // Fenster vorbei
    env.store.create('note', { title: 'Dritte' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 2);
  });
});

test('maxPerHour: die Grenze stoppt weitere Läufe und nennt den Grund auf Deutsch', async () => {
  await withTrigger({ trigger: { debounceMs: 1000, maxPerHour: 2 } }, async (env, record) => {
    for (let i = 0; i < 4; i++) {
      env.store.create('note', { title: `Notiz ${i}` });
      await env.triggers.settled();
      env.clock.advance(2000); // Entprellen ist nicht der Grund
    }

    assert.equal(env.runtime.started.length, 2, 'nach zwei Läufen ist die Stunde voll');
    const after = env.store.get(record.id);
    assert.match(after.data.lastError, /Grenze von 2 Läufen pro Stunde erreicht/);
    assert.ok(after.data.droppedByCap >= 1);
    assert.ok(env.triggers.status().droppedByCap >= 1);

    // Eine Stunde später ist wieder Platz.
    env.clock.advance(3600000);
    env.store.create('note', { title: 'Nach der Stunde' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 3);
    assert.equal(env.store.get(record.id).data.lastError, null, 'der Grund verschwindet, wenn er nicht mehr gilt');
  });
});

/**
 * Exactly what `stamped()` in src/agents/tools.js writes onto every record a
 * tool creates. Spelled out here rather than imported, so that a change to the
 * stamp breaks this test instead of quietly travelling through it.
 */
function agentStamp(agentId, runId = 'run_aaaaaaaaaaaaaaaaaaaaa') {
  return { runId, agentId, source: 'agent' };
}

test('Schleifenschutz: was ein Agentenlauf erzeugt hat, löst nicht erneut aus', async () => {
  await withTrigger({}, async (env, record) => {
    // 1. Der Stempel, den tools.js wirklich setzt: runId, agentId, source.
    env.store.create('note', { title: 'Vom Agenten geschrieben', ...agentStamp(env.agent.id) });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 0, 'ein Satz mit runId ist die eigene Handschrift des Systems');

    // 2. Auch eine Aufgabe -- vor dem Stempel trug die gar keine Herkunft.
    env.store.create('task', { title: 'Vom Agenten angelegt', ...agentStamp(env.agent.id, 'run_bbbbbbbbbbbbbbbbbbbbb') });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 0);

    // 3. Altbestand aus der Zeit vor runId: damals stand nur source=agent dran.
    env.store.create('note', { title: 'Alte Agentennotiz', source: 'agent' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 0);

    // 4. Kontrollprobe: eine Notiz des Menschen löst sehr wohl aus.
    env.store.create('note', { title: 'Von Hand geschrieben' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1);
    assert.equal(env.store.get(record.id).data.fires, 1);
  });
});

test('Der Mensch schreibt, während ein Agent läuft -- und der Auslöser feuert', async () => {
  // Genau der Fall, den die alte Heuristik verschluckt hat: solange irgendein
  // Lauf aktiv war, wurde jedes Ereignis unterdrückt. Der Stempel sagt jetzt
  // pro Satz, wer ihn geschrieben hat, also ist ein laufender Agent kein Grund
  // mehr, die Schreibarbeit des Nutzers zu ignorieren.
  await withTrigger({ trigger: { debounceMs: 1000 } }, async (env) => {
    env.runtime.active = ['run_ccccccccccccccccccccc'];

    env.store.create('note', { title: 'Von Hand, mitten im Lauf' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1, 'ein fremder Lauf hält den Nutzer nicht auf');

    // Und der Lauf selbst löst weiterhin nichts aus.
    env.clock.advance(2000);
    env.store.create('note', { title: 'Aus dem Lauf', ...agentStamp(env.agent.id, 'run_ccccccccccccccccccccc') });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1);
  });
});

test('Schleifenschutz: auch eine Änderung an einem Agentensatz löst nicht aus', async () => {
  await withTrigger({ trigger: { on: 'record.updated', debounceMs: 1000 } }, async (env) => {
    const vomAgenten = env.store.create('note', { title: 'Vom Agenten angelegt', ...agentStamp(env.agent.id) });
    env.store.update(vomAgenten.id, { body: 'nachträglich geändert' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 0, 'der Stempel bleibt am Satz, auch bei einer Änderung');

    const vomMenschen = env.store.create('note', { title: 'Vom Menschen' });
    env.clock.advance(2000);
    env.store.update(vomMenschen.id, { body: 'von Hand geändert' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1);
  });
});

test('Schleifenschutz: Buchhaltungsarten lösen nur aus, wenn sie gemeint sind', async () => {
  await withTrigger({ trigger: { recordType: null, debounceMs: 1000 } }, async (env) => {
    // Der Auslöser selbst schreibt Datensätze vom Typ trigger/run/edge/memory.
    const run = env.store.create('run', { agentId: env.agent.id, goal: 'x' });
    env.store.create('memory', { text: 'etwas gemerkt' });
    env.store.create('suggestion', { kind: 'tag', title: 'Vorschlag' });
    env.store.edges.add({ from: env.agent.id, to: run.id, kind: 'produced', source: 'derived' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 0, 'Buchhaltung ist kein Ereignis');

    env.store.create('note', { title: 'Eine echte Notiz' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1);
  });
});

test('Der globale Deckel lässt höchstens drei ausgelöste Läufe zu', async () => {
  await withTrigger({ trigger: { debounceMs: 1000, maxPerHour: 60 } }, async (env, record) => {
    for (let i = 0; i < 5; i++) {
      env.store.create('note', { title: `Notiz ${i}` });
      await env.triggers.settled();
      env.clock.advance(2000);
    }
    assert.equal(env.runtime.started.length, triggersMod.MAX_INFLIGHT_RUNS);
    assert.match(env.store.get(record.id).data.lastError, /Es laufen bereits 3 von Auslösern gestartete Agenten/);

    // Melden die Läufe sich fertig, geht es weiter.
    for (const started of env.runtime.started.slice()) {
      env.bus.publish('run.finished', { runId: started.runId, status: 'done' });
    }
    await env.triggers.settled();
    env.clock.advance(2000);
    env.store.create('note', { title: 'Danach' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 4);
  });
});

test('stop() meldet sich wirklich ab -- danach startet nichts mehr', async () => {
  await withTrigger({}, async (env) => {
    env.store.create('note', { title: 'Vorher' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1);

    assert.equal(env.triggers.stop(), true);
    assert.equal(env.bus.listenerCount('record.created'), 0, 'kein zurückgelassenes Abonnement');
    assert.equal(env.bus.listenerCount('run.finished'), 0);

    env.clock.advance(3600000);
    env.store.create('note', { title: 'Nachher' });
    await env.triggers.settled();
    assert.equal(env.runtime.started.length, 1, 'ein gestoppter Auslöser feuert nicht');

    assert.equal(env.triggers.stop(), false);
    // Wieder anschalten funktioniert -- und legt kein zweites Abonnement an.
    env.triggers.start();
    env.triggers.start();
    assert.equal(env.bus.listenerCount('record.created'), 1);
  });
});

test('status() der Auslöser zählt Läufe und Verworfenes', async () => {
  await withTrigger({ trigger: { debounceMs: 60000 } }, async (env) => {
    env.store.create('note', { title: 'Erste' });
    await env.triggers.settled();
    env.clock.advance(1000);
    env.store.create('note', { title: 'Zweite' });
    await env.triggers.settled();

    const status = env.triggers.status();
    assert.equal(status.running, true);
    assert.equal(status.total, 1);
    assert.equal(status.enabled, 1);
    assert.equal(status.firedLastHour, 1);
    assert.equal(status.droppedByDebounce, 1);
  });
});

/* ------------------------------------------------------------ keine Timer */

test('Die Timer halten den Prozess nicht am Leben', () => {
  // Ein Kindprozess ist der ehrliche Test dafür: läuft er von selbst aus,
  // war der Intervall-Timer unref'd. Wäre er es nicht, hinge er hier bis zum
  // Timeout und execFileSync würfe.
  const script = `
    const { createScheduler } = require(${JSON.stringify(require.resolve('../src/agents/schedule'))});
    const { createTriggers } = require(${JSON.stringify(require.resolve('../src/agents/triggers'))});
    const { Bus } = require(${JSON.stringify(require.resolve('../src/kernel/bus'))});
    // Ein Store-Doppel: geprüft wird diese Datei, nicht der Vault.
    const store = {
      create() { return null; }, get() { return null; }, update() { return null; },
      remove() { return null; }, list() { return { items: [], total: 0 }; },
    };
    const bus = new Bus();
    createScheduler({ store, bus }).start({ intervalMs: 1000 });
    createTriggers({ store, bus }).start();
    // Absichtlich kein stop(): wenn der Prozess trotzdem endet, hält nichts fest.
    process.stdout.write('ok');
  `;
  const out = execFileSync(process.execPath, ['-e', script], { timeout: 10000, encoding: 'utf8' });
  assert.equal(out, 'ok');
});

/* ------------------------------------------------------------------- HTTP */

/** Boot the real server on an ephemeral port with automation wired in. */
async function withServer(fn, opts = {}) {
  const { home, cleanup } = tempHome('automation-api');
  const paths = ensureLayout(layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  config.server.port = 7777;

  const bus = new Bus();
  const audit = new Audit(paths.audit, { enabled: false });
  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto: null });
  const clock = fakeClock('2026-03-10T09:00:00.000Z');
  const runtime = fakeRuntime();
  const agent = store.create('agent', { name: 'API-Agent' });

  const deps = { store, runtime, bus, config, logger: silentLogger, audit, now: clock.now };
  const ctx = {
    version: 'test',
    config, paths, store, bus, audit,
    logger: silentLogger,
    runtime,
    scheduler: opts.scheduler === undefined ? createScheduler(deps) : opts.scheduler,
    triggers: opts.triggers === undefined ? createTriggers(deps) : opts.triggers,
    failures: [],
  };
  if (opts.identity) {
    ctx.auth = { async middleware() { return { ok: true, identity: opts.identity }; } };
  }

  const server = await createServer(ctx);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    await fn({
      base, ctx, store, agent, runtime, clock,
      req: (method, urlPath, body) => request(base, method, urlPath, body),
    });
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    audit.close();
    cleanup();
  }
}

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* nicht jede Antwort ist JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('GET /api/automation liefert Zeitpläne, Auslöser und beide Zustände', async () => {
  await withServer(async ({ req, agent }) => {
    await req('POST', '/api/automation/schedules', { agentId: agent.id, goal: 'Rückblick', every: 'daily', atHour: 8 });
    await req('POST', '/api/automation/triggers', { agentId: agent.id, goal: 'Einsortieren', on: 'record.created', recordType: 'note' });

    const res = await req('GET', '/api/automation');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.schedules.total, 1);
    assert.equal(res.json.triggers.total, 1);
    assert.equal(res.json.status.scheduler.running, false);
    assert.equal(res.json.status.triggers.running, false);
    assert.equal(res.json.schedules.items[0].data.enabled, false, 'nichts läuft, was niemand eingeschaltet hat');
  });
});

test('Die Zeitplan-Routen legen an, ändern, führen aus und löschen', async () => {
  await withServer(async ({ req, agent, store, clock, runtime }) => {
    const created = await req('POST', '/api/automation/schedules', {
      agentId: agent.id, goal: 'Tagesrückblick', every: 'daily', atHour: 8, name: 'Abendrunde',
    });
    assert.equal(created.status, 200, created.text);
    const id = created.json.record.id;
    assert.equal(created.json.record.data.name, 'Abendrunde');

    const patched = await req('PATCH', `/api/automation/schedules/${id}`, { enabled: true, atHour: 9 });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.record.data.enabled, true);
    assert.equal(patched.json.record.data.atHour, 9);

    // Fällig machen und die Uhr über HTTP anstoßen.
    store.update(id, { nextRunAt: new Date(clock.date.getTime() - 1000).toISOString() });
    const ticked = await req('POST', '/api/automation/tick');
    assert.equal(ticked.status, 200, ticked.text);
    assert.equal(ticked.json.fired.length, 1);
    assert.equal(ticked.json.skipped.length, 0);
    assert.equal(ticked.json.fired[0].scheduleId, id);
    assert.ok(ticked.json.at);

    const ran = await req('POST', `/api/automation/schedules/${id}/run`);
    assert.equal(ran.status, 200, ran.text);
    assert.ok(ran.json.runId);
    assert.equal(runtime.started.length, 2);

    const listed = await req('GET', '/api/automation/schedules');
    assert.equal(listed.json.total, 1);
    assert.equal(typeof listed.json.items[0].nextRunLabel, 'string');

    const removed = await req('DELETE', `/api/automation/schedules/${id}`);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.json, { ok: true });
    assert.equal((await req('GET', '/api/automation/schedules')).json.total, 0);
  });
});

test('Die Auslöser-Routen legen an, ändern und löschen', async () => {
  await withServer(async ({ req, agent }) => {
    const created = await req('POST', '/api/automation/triggers', {
      agentId: agent.id, goal: 'Einsortieren', on: 'record.created', recordType: 'note', tag: 'projekt',
    });
    assert.equal(created.status, 200, created.text);
    const id = created.json.record.id;
    assert.equal(created.json.record.data.enabled, false);
    assert.equal(created.json.record.data.debounceMs, 5000);

    const patched = await req('PATCH', `/api/automation/triggers/${id}`, { enabled: true, maxPerHour: 99 });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.record.data.enabled, true);
    assert.equal(patched.json.record.data.maxPerHour, 60, 'geklemmt, nicht abgelehnt');

    assert.equal((await req('GET', '/api/automation/triggers')).json.total, 1);
    assert.deepEqual((await req('DELETE', `/api/automation/triggers/${id}`)).json, { ok: true });
  });
});

test('Fehlerhafte Eingaben antworten mit 400, unbekannte IDs mit 404', async () => {
  await withServer(async ({ req, agent }) => {
    const badEvery = await req('POST', '/api/automation/schedules', { agentId: agent.id, goal: 'x', every: 'minütlich' });
    assert.equal(badEvery.status, 400, badEvery.text);
    assert.equal(badEvery.json.error.code, 'VALIDATION_FAILED');

    const noAgent = await req('POST', '/api/automation/triggers', { agentId: 'agent_gibtesnicht', goal: 'x' });
    assert.equal(noAgent.status, 404, noAgent.text);

    const missing = await req('PATCH', '/api/automation/schedules/schedule_gibtesnicht', { enabled: true });
    assert.equal(missing.status, 404, missing.text);
  });
});

test('Ohne Zeitplanung antwortet die Route 503 statt einer leeren Liste', async () => {
  await withServer(async ({ req }) => {
    const res = await req('GET', '/api/automation/schedules');
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.error.code, 'SUBSYSTEM_UNAVAILABLE');
    assert.match(res.json.error.message, /Zeitplanung/);
  }, { scheduler: null });
});

test('Ein Nur-Lese-Zugang darf lesen, aber nichts einschalten', async () => {
  await withServer(async ({ req, agent }) => {
    assert.equal((await req('GET', '/api/automation')).status, 200);
    const denied = await req('POST', '/api/automation/schedules', { agentId: agent.id, goal: 'x' });
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.json.error.code, 'PERMISSION_DENIED');
    assert.equal((await req('POST', '/api/automation/tick')).status, 403);
  }, {
    identity: { kind: 'token', tokenId: 'tok_test', permissions: { read: true, write: true, chat: false, agents: false } },
  });
});
