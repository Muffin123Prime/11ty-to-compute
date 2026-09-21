'use strict';

/**
 * The change journal: what happened, and taking one of them back.
 *
 * Reading is `read`, undoing is `write` -- an undo is a real write through the
 * store, and a shared read-only token must not be able to delete a note by
 * pressing "rückgängig" on the entry that created it.
 *
 * Nothing here decides what can be undone. That judgement lives in
 * `src/store/history.js`, where the record's current revision is actually
 * known, and it is served unchanged: every item carries `canUndo`, and when it
 * is false a German `reason` that says why. A route that guessed a cheerful
 * `canUndo: true` would produce a button that fails on click.
 *
 * `POST /api/history/:id/undo` takes `{ force }` for exactly one situation:
 * the record was changed again after the journalled change. Without `force`
 * that is refused with 409 and the reason names both revisions, because
 * discarding somebody's newer edit in order to undo an older one is the
 * accident undo exists to prevent.
 */

const schema = require('../../store/schema');
const { ValidationError } = require('../../kernel/errors');
const {
  needMethod,
  asObject,
  intParam,
  strParam,
} = require('./support');

const ACTORS = ['user', 'agent'];

/** Missing subsystem answers 503 with a German sentence, never an empty list. */
function history(rc, method) {
  return needMethod(
    rc.ctx.history,
    method,
    'Der Änderungsverlauf',
    'Er wird beim Start zusammen mit dem Speicher aufgebaut.',
  );
}

function register(router) {
  router.get('/api/history', (rc) => {
    rc.requireCapability('read');

    const actor = strParam(rc.query, 'actor', 20);
    if (actor && !ACTORS.includes(actor)) {
      throw new ValidationError(`"actor" muss user oder agent sein (empfangen: ${actor}).`);
    }
    const type = strParam(rc.query, 'type', 40);
    if (type && !schema.TYPES.includes(type)) {
      throw new ValidationError(`"${type}" ist keine bekannte Art von Eintrag.`);
    }

    return history(rc, 'list').list({
      limit: intParam(rc.query, 'limit', 50, 1, 500),
      offset: intParam(rc.query, 'offset', 0, 0, 1000000),
      actor: actor || undefined,
      type: type || undefined,
      // Passed through as text: the subsystem owns the date parsing, so a
      // malformed value produces one message rather than two different ones.
      since: strParam(rc.query, 'since', 40) || undefined,
    });
  });

  router.get('/api/history/stats', (rc) => {
    rc.requireCapability('read');
    return history(rc, 'stats').stats();
  });

  router.post('/api/history/:id/undo', async (rc) => {
    rc.requireCapability('write');
    const body = asObject(await rc.body());
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      throw new ValidationError('"force" muss true oder false sein.');
    }
    return history(rc, 'undo').undo(rc.params.id, { force: body.force === true });
  });
}

module.exports = { register };
