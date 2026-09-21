'use strict';

/**
 * The assistance surface: what the system noticed, and what to do about it.
 *
 * Every route here is deliberately boring except for one thing worth saying
 * out loud: reading suggestions is a `read` capability, but accepting one is a
 * `write`, because accepting is the moment a proposal turns into a real change
 * in the vault. A shared read-only link may look at everything the system
 * noticed and may change nothing.
 *
 * `POST /api/assist/scan` is a write too. It does not touch notes, but it does
 * create records, and it walks the whole vault -- so it reports what really
 * happened (created/refreshed/stale, and which detectors were skipped and why)
 * instead of a cheerful "fertig".
 */

const { ValidationError } = require('../../kernel/errors');
const {
  need,
  needMethod,
  asObject,
  requireStringArray,
  intParam,
  strParam,
  mustGet,
} = require('./support');

const STATUSES = ['open', 'accepted', 'dismissed', 'stale', 'all'];

/** The kinds this instance actually has detectors for, asked at request time. */
function kindsOf(assist) {
  return assist.detectors().map((d) => d.kind);
}

function assertKind(assist, kind) {
  const kinds = kindsOf(assist);
  if (!kinds.includes(kind)) {
    throw new ValidationError(`"${kind}" ist keine bekannte Art von Vorschlag. Möglich: ${kinds.join(', ')}.`);
  }
  return kind;
}

function register(router) {
  router.get('/api/assist/suggestions', (rc) => {
    rc.requireCapability('read');
    const assist = needMethod(rc.ctx.assist, 'list', 'Die Assistenz');

    const status = strParam(rc.query, 'status', 20) || 'open';
    if (!STATUSES.includes(status)) {
      throw new ValidationError(`"status" muss einer von ${STATUSES.join(', ')} sein (empfangen: ${status}).`);
    }
    const kind = strParam(rc.query, 'kind', 40);
    if (kind) assertKind(assist, kind);

    return assist.list({
      status,
      kind: kind || null,
      limit: intParam(rc.query, 'limit', 50, 1, 500),
      offset: intParam(rc.query, 'offset', 0, 0, 1000000),
    });
  });

  router.get('/api/assist/detectors', (rc) => {
    rc.requireCapability('read');
    const assist = needMethod(rc.ctx.assist, 'detectors', 'Die Assistenz');
    const items = assist.detectors();
    return { items, total: items.length };
  });

  router.get('/api/assist/stats', (rc) => {
    rc.requireCapability('read');
    const assist = needMethod(rc.ctx.assist, 'stats', 'Die Assistenz');
    return assist.stats();
  });

  router.post('/api/assist/scan', async (rc) => {
    rc.requireCapability('write');
    const assist = needMethod(rc.ctx.assist, 'scan', 'Die Assistenz');
    const body = asObject(await rc.body());

    let kinds;
    if (body.kinds !== undefined && body.kinds !== null) {
      kinds = requireStringArray(body.kinds, 'kinds', { maxItems: 20, max: 40 });
      for (const kind of kinds) assertKind(assist, kind);
    }

    let limit;
    if (body.limit !== undefined && body.limit !== null) {
      limit = Number(body.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ValidationError('"limit" muss eine ganze Zahl zwischen 1 und 500 sein.');
      }
    }

    return assist.scan({ kinds, limit });
  });

  router.post('/api/assist/suggestions/:id/accept', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const assist = needMethod(rc.ctx.assist, 'accept', 'Die Assistenz');
    // A 404 for a suggestion that is simply not there, before the engine gets
    // a chance to answer with a 404 about something inside its action.
    const record = mustGet(store, rc.params.id, 'suggestion');
    return assist.accept(record.id);
  });

  router.post('/api/assist/suggestions/:id/dismiss', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const assist = needMethod(rc.ctx.assist, 'dismiss', 'Die Assistenz');
    const record = mustGet(store, rc.params.id, 'suggestion');
    return assist.dismiss(record.id);
  });

  router.delete('/api/assist/suggestions/:id', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const assist = needMethod(rc.ctx.assist, 'remove', 'Die Assistenz');
    const record = mustGet(store, rc.params.id, 'suggestion');
    assist.remove(record.id);
    return { ok: true };
  });
}

module.exports = { register };
