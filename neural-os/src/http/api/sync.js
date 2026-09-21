'use strict';

/**
 * Device synchronisation over HTTP.
 *
 * Two audiences, two permission stances:
 *
 * 1. `/api/sync/*` is what ANOTHER DEVICE calls. Those routes additionally
 *    demand the `sync` capability, so the token a user carries to their tablet
 *    to read notes cannot also merge records into their vault. Reaching them
 *    from a second device means sharing has to be switched on and a token
 *    minted -- `src/http/auth.js` enforces that, not this file.
 *
 * 2. `/api/peers` and `/api/conflicts` are what the interface calls. Creating,
 *    changing or deleting a partner widens what may leave this machine and
 *    stores that partner's access token, so it is owner-only for the same
 *    reason the network policy and the token list are: a shared read-only
 *    session must not be able to point this vault at a new destination.
 *
 * Nothing here decides a merge. Every decision lives in `src/sync/merge.js`
 * and every side effect in `src/sync/peer.js`; this file is policy and shape.
 */

const { ValidationError, PermissionError } = require('../../kernel/errors');
const {
  need,
  asObject,
  intParam,
  strParam,
} = require('./support');

/**
 * Merging records into someone's vault is a capability of its own.
 *
 * `rc.requireCapability` would answer "Dieser Zugang darf nicht: sync.", which
 * is true but tells the person on the other device nothing about what to do.
 */
function requireSync(rc) {
  const identity = rc.identity || {};
  if (identity.kind === 'owner' || identity.permissions === 'all') return;
  const permissions = identity.permissions;
  if (permissions && permissions.sync === true) return;
  throw new PermissionError(
    'Dieser Zugang darf nicht synchronisieren. Auf dem Zielgerät braucht es ein Token mit dem Recht "sync"; '
    + 'lege es dort unter Einstellungen → Freigabe an und trage es beim Partnergerät ein.',
    { capability: 'sync' },
  );
}

function syncOf(rc) {
  return need(
    rc.ctx.sync,
    'Die Geräte-Synchronisation',
    'Ohne sie kann dieses Gerät weder Daten holen noch senden.',
  );
}

/**
 * An HTTP client that hangs up mid-sync should not leave the run going.
 *
 * The listener sits on the RESPONSE, not on the request: since Node 16 an
 * `IncomingMessage` emits 'close' as soon as the body has been read, which
 * for every POST here is long before the work is done -- listening there
 * would abort every single run instantly. `res` closes either when we finish
 * it (by then `done()` has disarmed the signal) or when the client is gone,
 * which is exactly the case we want to react to.
 */
function requestSignal(rc) {
  const controller = new AbortController();
  let settled = false;
  const onClose = () => {
    if (!settled) controller.abort();
  };
  rc.res.on('close', onClose);
  return {
    signal: controller.signal,
    done() {
      settled = true;
      rc.res.off('close', onClose);
    },
  };
}

function register(router) {
  /* ------------------------------------------------- what a partner calls */

  router.get('/api/sync/info', (rc) => {
    rc.requireCapability('read');
    requireSync(rc);
    return syncOf(rc).info();
  });

  router.get('/api/sync/changes', (rc) => {
    rc.requireCapability('read');
    requireSync(rc);
    const sync = syncOf(rc);
    const since = intParam(rc.query, 'since', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(rc.query, 'limit', 200, 1, 1000);
    return sync.changesSince(since, limit);
  });

  router.post('/api/sync/apply', async (rc) => {
    rc.requireCapability('write');
    requireSync(rc);
    const sync = syncOf(rc);
    const body = asObject(await rc.body());
    return sync.applyIncoming({
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
      records: body.records,
      bases: body.bases,
    });
  });

  /* ---------------------------------------------- what the interface calls */

  router.get('/api/peers', (rc) => {
    rc.requireCapability('read');
    const sync = syncOf(rc);
    const peers = sync.listPeers();
    return { items: peers, total: peers.length, deviceId: sync.deviceId, protocol: sync.protocol };
  });

  router.post('/api/peers', async (rc) => {
    rc.requireCapability('write');
    rc.requireOwner('Ein Partnergerät einzutragen');
    const sync = syncOf(rc);
    const body = asObject(await rc.body());
    return { peer: sync.createPeer(body) };
  });

  router.patch('/api/peers/:id', async (rc) => {
    rc.requireCapability('write');
    rc.requireOwner('Ein Partnergerät zu ändern');
    const sync = syncOf(rc);
    const body = asObject(await rc.body());
    return { peer: sync.updatePeer(rc.params.id, body) };
  });

  router.delete('/api/peers/:id', (rc) => {
    rc.requireCapability('write');
    rc.requireOwner('Ein Partnergerät zu entfernen');
    return { peer: syncOf(rc).removePeer(rc.params.id) };
  });

  router.post('/api/peers/:id/sync', async (rc) => {
    rc.requireCapability('write');
    const sync = syncOf(rc);
    const body = asObject(await rc.body());
    const direction = body.direction === undefined ? 'both' : body.direction;
    if (!['pull', 'push', 'both'].includes(direction)) {
      throw new ValidationError('Die Richtung muss "pull", "push" oder "both" sein.');
    }
    const { signal, done } = requestSignal(rc);
    try {
      const out = { peerId: rc.params.id, direction, pull: null, push: null };
      if (direction === 'pull' || direction === 'both') out.pull = await sync.pull(rc.params.id, { signal });
      if (direction === 'push' || direction === 'both') out.push = await sync.push(rc.params.id, { signal });
      out.peer = sync.getPeer(rc.params.id);
      return out;
    } finally {
      done();
    }
  });

  router.post('/api/peers/:id/test', async (rc) => {
    rc.requireCapability('read');
    const sync = syncOf(rc);
    const { signal, done } = requestSignal(rc);
    try {
      return await sync.test(rc.params.id, { signal });
    } finally {
      done();
    }
  });

  router.post('/api/sync', async (rc) => {
    rc.requireCapability('write');
    const sync = syncOf(rc);
    const { signal, done } = requestSignal(rc);
    try {
      return await sync.syncAll({ signal });
    } finally {
      done();
    }
  });

  router.get('/api/conflicts', (rc) => {
    rc.requireCapability('read');
    const sync = syncOf(rc);
    const status = strParam(rc.query, 'status', 20) || 'open';
    if (!['open', 'resolved', 'all'].includes(status)) {
      throw new ValidationError('"status" muss "open", "resolved" oder "all" sein.');
    }
    const peerId = strParam(rc.query, 'peer', 80);
    const limit = intParam(rc.query, 'limit', 200, 1, 1000);
    return sync.listConflicts({ status, peerId: peerId || undefined, limit });
  });

  router.post('/api/conflicts/:id', async (rc) => {
    rc.requireCapability('write');
    const sync = syncOf(rc);
    const body = asObject(await rc.body());
    // No default: choosing for the user is the one thing this whole subsystem
    // exists to avoid.
    if (body.resolution !== 'local' && body.resolution !== 'remote') {
      throw new ValidationError(
        'Bitte "resolution" mit "local" (eigene Fassung behalten) oder "remote" (Fassung des Partners übernehmen) angeben.',
      );
    }
    return sync.resolveConflict(rc.params.id, body.resolution);
  });
}

module.exports = { register, requireSync };
