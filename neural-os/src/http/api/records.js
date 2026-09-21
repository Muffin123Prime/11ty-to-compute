'use strict';

/**
 * Records: the uniform CRUD surface over everything the user owns.
 *
 * Two deliberate restrictions:
 *
 * 1. **Not every type may be created here.** Edges have endpoint checks and
 *    de-duplication in `store.edges`, grants are a network policy decision,
 *    tokens must be hashed before they touch the vault, and runs, messages and
 *    approvals record what really happened. Letting a client POST those raw
 *    would let it forge provenance. Each refusal names the right route.
 * 2. **A PATCH cannot rewrite an edge's endpoints.** `from`/`to` are indexed;
 *    changing them through the generic path would leave the graph describing
 *    something that never existed.
 *
 * `?q=` searches instead of listing. The result still carries plain records in
 * `items` so a caller can treat both the same, with score and snippet beside
 * them in `matches` for the ones that want to highlight.
 */

const schema = require('../../store/schema');
const { ValidationError } = require('../../kernel/errors');
const {
  need,
  asObject,
  requireString,
  intParam,
  boolParam,
  strParam,
  listParam,
  mustGet,
} = require('./support');

/**
 * Types a client may create directly. Everything else has its own route.
 *
 * `agent` is deliberately NOT here. POST /api/agents requires the 'agents'
 * capability and passes the permission block through
 * schema.normalisePermissions, so anything the client left out falls back to
 * "denied". Reachable from here, the generic route did neither: a shared token
 * holding only 'write' could mint an agent with fileRoots ['/'], no approval
 * requirement and full network access. A second door into a permission system
 * is a hole in it.
 */
const CREATABLE = new Set(['note', 'project', 'task', 'entity', 'memory', 'file', 'chat']);

const ROUTE_HINT = {
  agent: 'Agenten entstehen über POST /api/agents - nur dort werden ihre Berechtigungen geprüft.',
  edge: 'Verknüpfungen entstehen über POST /api/edges.',
  grant: 'Netz-Freigaben entstehen über POST /api/network/grants.',
  token: 'Zugangstoken entstehen über POST /api/tokens.',
  approval: 'Bestätigungen stellt der Agenten-Lauf selbst.',
  run: 'Läufe startet POST /api/agents/:id/run.',
  message: 'Nachrichten entstehen über POST /api/chats/:id/send.',
};

/** Fields of an edge that may be corrected after the fact. */
const EDGE_PATCHABLE = new Set(['reason', 'weight', 'reviewed', 'kind']);

function assertKnownType(type) {
  if (!schema.TYPES.includes(type)) {
    throw new ValidationError(`Unbekannte Art "${type}". Bekannt sind: ${schema.TYPES.join(', ')}.`);
  }
  return type;
}

/** Accept `{data:{…}}` (the contract) as well as a flat patch object. */
function patchFrom(body) {
  if (Object.prototype.hasOwnProperty.call(body, 'data')) {
    return asObject(body.data, 'Das Feld "data"');
  }
  const { id, type, createdAt, updatedAt, deletedAt, rev, ...rest } = body;
  return rest;
}

function register(router) {
  router.get('/api/records', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');

    const type = strParam(rc.query, 'type', 40);
    if (type) assertKnownType(type);
    const limit = intParam(rc.query, 'limit', 50, 0, 1000);
    const offset = intParam(rc.query, 'offset', 0, 0, 1000000);
    const sort = strParam(rc.query, 'sort', 60) || 'updatedAt';
    const order = strParam(rc.query, 'order', 10) === 'asc' ? 'asc' : 'desc';
    const includeDeleted = boolParam(rc.query, 'includeDeleted', false);
    const query = strParam(rc.query, 'q', 500);

    if (query) {
      const found = store.search(query, { types: type ? [type] : undefined, limit, offset });
      return {
        items: found.items.map((hit) => hit.record),
        total: found.total,
        matches: found.items.map((hit) => ({ id: hit.record.id, score: hit.score, snippet: hit.snippet })),
        query,
      };
    }

    return store.list(type || '*', { limit, offset, sort, order, includeDeleted });
  });

  router.post('/api/records', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const type = requireString(body.type, 'type', { max: 40 });
    assertKnownType(type);
    if (!CREATABLE.has(type)) {
      throw new ValidationError(
        `Einträge der Art "${type}" können hier nicht angelegt werden. ${ROUTE_HINT[type] || ''}`.trim(),
        { type },
      );
    }
    const data = body.data === undefined ? {} : asObject(body.data, 'Das Feld "data"');
    const record = store.create(type, data);
    return { record };
  });

  router.get('/api/records/:id', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const includeDeleted = boolParam(rc.query, 'includeDeleted', false);
    const record = mustGet(store, rc.params.id, null, { includeDeleted });
    const out = { record };
    // Cheap context the detail view always wants; skipped when unavailable.
    if (store.edges && typeof store.edges.for === 'function') {
      try {
        out.edges = store.edges.for(record.id, { limit: 200 });
      } catch { /* a record type without edges is fine */ }
    }
    return out;
  });

  router.patch('/api/records/:id', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const existing = mustGet(store, rc.params.id);
    if (existing.type === 'token' || existing.type === 'grant') {
      throw new ValidationError(
        `Einträge der Art "${existing.type}" werden hier nicht geändert. ${ROUTE_HINT[existing.type] || ''}`.trim(),
      );
    }
    // Same reasoning as CREATABLE: raising an agent's permissions must go
    // through the route that checks the caller may do that at all.
    if (existing.type === 'agent') {
      throw new ValidationError(
        `Agenten werden hier nicht geändert. ${ROUTE_HINT.agent}`,
      );
    }
    const patch = patchFrom(asObject(await rc.body()));
    if (!Object.keys(patch).length) throw new ValidationError('Es wurden keine Felder zum Ändern übergeben.');
    if (existing.type === 'edge') {
      const illegal = Object.keys(patch).filter((key) => !EDGE_PATCHABLE.has(key));
      if (illegal.length) {
        throw new ValidationError(
          `An einer Verknüpfung lassen sich nur ${Array.from(EDGE_PATCHABLE).join(', ')} ändern (nicht: ${illegal.join(', ')}). `
          + 'Für andere Endpunkte die Verknüpfung löschen und neu anlegen.',
        );
      }
    }
    return { record: store.update(existing.id, patch) };
  });

  router.delete('/api/records/:id', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const hard = boolParam(rc.query, 'hard', false);
    if (hard) rc.requireOwner('Das endgültige Löschen');
    const record = mustGet(store, rc.params.id, null, { includeDeleted: true });
    return { record: store.remove(record.id, { hard }), hard };
  });

  router.post('/api/records/:id/restore', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = mustGet(store, rc.params.id, null, { includeDeleted: true });
    return { record: store.restore(record.id) };
  });

  router.get('/api/search', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const query = strParam(rc.query, 'q', 500);
    if (!query) throw new ValidationError('Die Suche braucht einen Suchbegriff ("q").');
    const types = listParam(rc.query, 'types');
    if (types) types.forEach(assertKnownType);
    const limit = intParam(rc.query, 'limit', 30, 1, 200);
    const offset = intParam(rc.query, 'offset', 0, 0, 100000);
    const found = store.search(query, { types: types || undefined, limit, offset });
    return { items: found.items, total: found.total, query };
  });
}

module.exports = { register, CREATABLE };
