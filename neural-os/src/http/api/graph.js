'use strict';

/**
 * The knowledge graph: reading it, and the user's own links.
 *
 * Edges are records, so they are inspectable and revocable -- the UI can
 * always answer "why are these two connected?" from `source` and `reason`.
 * That is only true if every link that enters the vault carries both, which is
 * why this route sets `source:'manual'` for anything a person draws here and
 * refuses to let a client claim `source:'derived'`: a machine-made link that
 * masquerades as the user's own could never be reviewed away.
 *
 * `POST /api/graph/rescan` re-derives every link from the text that implies
 * it. It can touch the whole vault, so it is a write and it reports real
 * counts rather than a cheerful "done".
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
  listParam,
  mustGet,
} = require('./support');

const DIRECTIONS = new Set(['in', 'out', 'both']);

function register(router) {
  router.get('/api/graph', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const graph = needMethod(rc.ctx.graph, 'buildGraph', 'Die Graph-Ansicht');

    const types = listParam(rc.query, 'types');
    if (types) {
      for (const type of types) {
        if (!schema.GRAPH_TYPES.includes(type)) {
          throw new ValidationError(`"${type}" ist keine Art, die im Graphen vorkommt. Möglich: ${schema.GRAPH_TYPES.join(', ')}.`);
        }
      }
    }
    const kinds = listParam(rc.query, 'kinds');
    if (kinds) {
      for (const kind of kinds) {
        if (!schema.EDGE_KINDS.includes(kind)) {
          throw new ValidationError(`"${kind}" ist keine bekannte Verknüpfungsart. Möglich: ${schema.EDGE_KINDS.join(', ')}.`);
        }
      }
    }

    return graph.buildGraph(store, {
      focus: strParam(rc.query, 'focus', 80) || undefined,
      depth: intParam(rc.query, 'depth', 2, 0, 6),
      types: types || undefined,
      kinds: kinds || undefined,
      limit: intParam(rc.query, 'limit', 600, 1, 5000),
      query: strParam(rc.query, 'q', 500) || undefined,
      includeOrphans: boolParam(rc.query, 'includeOrphans', true),
    });
  });

  router.post('/api/graph/rescan', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const graph = needMethod(rc.ctx.graph, 'scanAll', 'Die Link-Ableitung');
    const result = graph.scanAll(store, {});
    if (rc.ctx.bus && typeof rc.ctx.bus.publish === 'function') {
      rc.ctx.bus.publish('graph.rescanned', result);
    }
    return result;
  });

  router.get('/api/edges', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const node = strParam(rc.query, 'node', 80);
    const kinds = listParam(rc.query, 'kinds');
    const limit = intParam(rc.query, 'limit', 200, 1, 2000);

    if (node) {
      const direction = strParam(rc.query, 'direction', 10) || 'both';
      if (!DIRECTIONS.has(direction)) {
        throw new ValidationError(`"direction" muss in, out oder both sein (empfangen: ${direction}).`);
      }
      mustGet(store, node, null, { includeDeleted: true });
      const items = store.edges.for(node, { direction, kinds: kinds || undefined, limit });
      return { items, total: items.length, node, direction };
    }

    const listed = store.list('edge', {
      limit,
      offset: intParam(rc.query, 'offset', 0, 0, 1000000),
      sort: strParam(rc.query, 'sort', 60) || 'createdAt',
      order: strParam(rc.query, 'order', 10) === 'asc' ? 'asc' : 'desc',
    });
    if (!kinds) return listed;
    const items = listed.items.filter((edge) => kinds.includes(edge.data.kind));
    return { items, total: items.length };
  });

  router.post('/api/edges', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const from = requireString(body.from, 'from', { max: 80 });
    const to = requireString(body.to, 'to', { max: 80 });
    if (from === to) throw new ValidationError('Ein Eintrag kann nicht mit sich selbst verknüpft werden.');

    const kind = optionalString(body.kind, 'kind', { max: 40 }) || 'related';
    if (!schema.EDGE_KINDS.includes(kind)) {
      throw new ValidationError(`"${kind}" ist keine bekannte Verknüpfungsart. Möglich: ${schema.EDGE_KINDS.join(', ')}.`);
    }
    const weight = body.weight === undefined ? 1 : Number(body.weight);
    if (!Number.isFinite(weight)) throw new ValidationError('"weight" muss eine Zahl sein.');

    // Drawn by a person in the interface: the provenance is not negotiable.
    const record = store.edges.add({
      from,
      to,
      kind,
      weight,
      source: 'manual',
      reason: optionalString(body.reason, 'reason', { max: 500 }) || 'Von Hand verknüpft',
    });
    return { record };
  });

  router.delete('/api/edges/:id', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const edge = mustGet(store, rc.params.id, 'edge', { includeDeleted: true });
    return { record: store.edges.remove(edge.id) };
  });
}

module.exports = { register };
