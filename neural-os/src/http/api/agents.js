'use strict';

/**
 * Agents, their runs and the approvals a run waits on.
 *
 * An agent record is a *capability grant*, not a personality sheet: what it
 * may read, write, link and dial is enforced server-side in the tool layer.
 * This route therefore normalises `permissions` through the schema on every
 * write, so an old agent record gains new capability keys as denied rather
 * than inheriting whatever the interface happened to send.
 *
 * Runs are started, never awaited: `runtime.start` returns as soon as the run
 * record exists and the work continues in the background, reporting on the bus
 * (`run.started`, `run.step`, `run.finished`, `run.failed`). An HTTP request
 * that waited for an agent to finish would time out long before a local model
 * had worked through twelve steps.
 *
 * Approvals are answered here and nowhere else. A pending approval blocks the
 * run that asked for it; a denial is a real answer, not an error to retry.
 */

const schema = require('../../store/schema');
const { ValidationError } = require('../../kernel/errors');
const {
  need,
  needMethod,
  asObject,
  requireString,
  optionalString,
  intParam,
  boolParam,
  strParam,
  mustGet,
  pick,
} = require('./support');

const AGENT_FIELDS = ['name', 'description', 'systemPrompt', 'model', 'permissions', 'tools'];
const RUN_STATUS = ['queued', 'running', 'waiting-approval', 'done', 'failed', 'aborted'];

let permissionsMod = null;
try {
  permissionsMod = require('../../agents/permissions');
} catch {
  // Optional: the description is a nicety, the enforcement lives elsewhere.
  permissionsMod = null;
}

function describe(agent, config) {
  if (!permissionsMod || typeof permissionsMod.describe !== 'function') return null;
  try {
    return permissionsMod.describe(agent, config);
  } catch {
    return null;
  }
}

function register(router) {
  router.get('/api/agents', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const listed = store.list('agent', {
      limit: intParam(rc.query, 'limit', 100, 1, 1000),
      offset: intParam(rc.query, 'offset', 0, 0, 100000),
      sort: strParam(rc.query, 'sort', 60) || 'createdAt',
      order: strParam(rc.query, 'order', 10) === 'desc' ? 'desc' : 'asc',
    });
    return {
      ...listed,
      descriptions: Object.fromEntries(
        listed.items.map((agent) => [agent.id, describe(agent, rc.ctx.config)]).filter(([, text]) => text),
      ),
    };
  });

  router.post('/api/agents', async (rc) => {
    rc.requireCapability('agents');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const data = pick(body, AGENT_FIELDS);
    data.name = requireString(data.name, 'name', { max: 200 });
    // Absent capability = denied: fill from the schema defaults, never from
    // whatever the client left out.
    data.permissions = schema.normalisePermissions(data.permissions);
    const record = store.create('agent', data);
    return { record, description: describe(record, rc.ctx.config) };
  });

  router.get('/api/agents/:id', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = mustGet(store, rc.params.id, 'agent');
    const out = { record, description: describe(record, rc.ctx.config) };
    if (rc.ctx.toolbox && typeof rc.ctx.toolbox.list === 'function') {
      try {
        out.tools = rc.ctx.toolbox.list(record);
      } catch (err) {
        out.tools = [];
        out.toolProblem = err && err.message;
      }
    }
    return out;
  });

  router.patch('/api/agents/:id', async (rc) => {
    rc.requireCapability('agents');
    const store = need(rc.ctx.store, 'Der Speicher');
    const existing = mustGet(store, rc.params.id, 'agent');
    const patch = pick(asObject(await rc.body()), AGENT_FIELDS);
    if (!Object.keys(patch).length) throw new ValidationError('Es wurden keine Felder zum Ändern übergeben.');
    if (patch.name !== undefined) patch.name = requireString(patch.name, 'name', { max: 200 });
    if (patch.permissions !== undefined) {
      patch.permissions = schema.normalisePermissions({ ...existing.data.permissions, ...asObject(patch.permissions, 'Das Feld "permissions"') });
    }
    const record = store.update(existing.id, patch);
    return { record, description: describe(record, rc.ctx.config) };
  });

  router.delete('/api/agents/:id', (rc) => {
    rc.requireCapability('agents');
    const store = need(rc.ctx.store, 'Der Speicher');
    const existing = mustGet(store, rc.params.id, 'agent', { includeDeleted: true });
    const hard = boolParam(rc.query, 'hard', false);
    if (hard) rc.requireOwner('Das endgültige Löschen');
    return { record: store.remove(existing.id, { hard }), hard };
  });

  router.post('/api/agents/:id/run', async (rc) => {
    rc.requireCapability('agents');
    const runtime = needMethod(
      rc.ctx.runtime,
      'start',
      'Die Agenten-Laufzeit',
      'Sie braucht ein erreichbares Modell und die Werkzeugschicht.',
    );
    const store = need(rc.ctx.store, 'Der Speicher');
    const agent = mustGet(store, rc.params.id, 'agent');
    const body = asObject(await rc.body());
    const goal = requireString(body.goal, 'goal', { max: 20000 });
    const chatId = optionalString(body.chatId, 'chatId', { max: 80 });
    if (chatId) mustGet(store, chatId, 'chat');

    const run = await runtime.start({
      agentId: agent.id,
      goal,
      chatId: chatId || undefined,
      context: body.context,
    });
    return { runId: run.id, record: run };
  });

  router.get('/api/runs', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const status = strParam(rc.query, 'status', 40);
    if (status && !RUN_STATUS.includes(status)) {
      throw new ValidationError(`Unbekannter Status "${status}". Möglich: ${RUN_STATUS.join(', ')}.`);
    }
    const listed = store.list('run', {
      filter: status ? { status } : undefined,
      limit: intParam(rc.query, 'limit', 50, 1, 500),
      offset: intParam(rc.query, 'offset', 0, 0, 100000),
      sort: strParam(rc.query, 'sort', 60) || 'createdAt',
      order: strParam(rc.query, 'order', 10) === 'asc' ? 'asc' : 'desc',
    });
    let active = [];
    if (rc.ctx.runtime && typeof rc.ctx.runtime.listActive === 'function') {
      try {
        active = rc.ctx.runtime.listActive().map((run) => run.id);
      } catch { active = []; }
    }
    return { ...listed, active };
  });

  router.get('/api/runs/:id', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = mustGet(store, rc.params.id, 'run');
    const out = { record };
    if (boolParam(rc.query, 'transcript', false) && rc.ctx.runtime && typeof rc.ctx.runtime.transcript === 'function') {
      try {
        out.transcript = rc.ctx.runtime.transcript(record.id);
      } catch (err) {
        out.transcript = [];
        out.transcriptProblem = err && err.message;
      }
    }
    return out;
  });

  router.post('/api/runs/:id/abort', (rc) => {
    rc.requireCapability('agents');
    const runtime = needMethod(rc.ctx.runtime, 'abort', 'Die Agenten-Laufzeit');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = mustGet(store, rc.params.id, 'run');
    return { aborted: runtime.abort(record.id), runId: record.id };
  });

  router.get('/api/approvals', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    if (boolParam(rc.query, 'all', false)) {
      return store.list('approval', {
        limit: intParam(rc.query, 'limit', 100, 1, 1000),
        sort: 'createdAt',
        order: 'desc',
      });
    }
    const approvals = rc.ctx.approvals;
    if (approvals && typeof approvals.listPending === 'function') {
      const items = approvals.listPending();
      return { items, total: items.length };
    }
    // Without the approvals service the records still tell the truth.
    return store.list('approval', { filter: { status: 'pending' }, sort: 'createdAt', order: 'asc', limit: 200 });
  });

  router.post('/api/approvals/:id', async (rc) => {
    rc.requireCapability('agents');
    const approvals = needMethod(
      rc.ctx.approvals,
      'resolve',
      'Das Bestätigungssystem',
      'Ohne es wartet kein Lauf auf eine Antwort.',
    );
    const body = asObject(await rc.body());
    const decision = requireString(body.decision, 'decision', { max: 20 });
    if (decision !== 'approved' && decision !== 'denied') {
      throw new ValidationError('"decision" muss "approved" oder "denied" sein.');
    }
    return { record: approvals.resolve(rc.params.id, decision) };
  });
}

module.exports = { register, AGENT_FIELDS, RUN_STATUS };
