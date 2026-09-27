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
 *
 * Das Wissensuniversum (Vertrag A-F vom 27.09.2026, src/graph/universum.js)
 * --------------------------------------------------------------------------
 *   GET  /api/graph/universum?tiefe=0            Themenbereiche (<= ~40)
 *   GET  /api/graph/universum?tiefe=1&thema=<id> ein Thema: Knoten, Kanten,
 *                                                Nachbarn ausserhalb
 *   POST /api/graph/verbinden    {from, to:[ids], kind?, reason?}
 *                                -> {edges, neu, bereits, rueckgaengig}
 *   POST /api/graph/rueckgaengig {edges:[ids]}   nimmt genau diese zurueck
 *   POST /api/graph/ablehnen     {from, to:[ids]} merkt sich das Paar
 *   POST /api/graph/zusammenfassung {id}         KI-Zusammenfassung eines
 *                                                Knotens -- ehrlich: solange
 *                                                kein Dienst sie liefert,
 *                                                sagt die Antwort das.
 *
 * "Rueckgaengig" laeuft hier bewusst nicht ueber den Aenderungsverlauf:
 * der nimmt Kanten ausdruecklich nicht auf (src/store/history.js, weil
 * abgeleitete Kanten beim naechsten Speichern ohnehin neu entstuenden).
 * Eine von Hand gezogene Kante hat ihre Umkehrung deshalb direkt neben sich.
 */

const schema = require('../../store/schema');
const universum = require('../../graph/universum');
const { ValidationError } = require('../../kernel/errors');
const {
  need,
  needMethod,
  asObject,
  requireString,
  optionalString,
  requireStringArray,
  intParam,
  boolParam,
  strParam,
  listParam,
  mustGet,
} = require('./support');

const DIRECTIONS = new Set(['in', 'out', 'both']);

/** Der Satz, den die Karte zeigt, solange keine KI zusammenfassen kann. */
const KI_FEHLT = 'Kommt, sobald eine KI verbunden ist.';

function register(router) {
  router.get('/api/graph/universum', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const t0 = Date.now();
    const tiefe = intParam(rc.query, 'tiefe', 0, 0, 1);
    const thema = strParam(rc.query, 'thema', 200);
    const typen = listParam(rc.query, 'typen');
    if (typen) {
      for (const type of typen) {
        if (!schema.GRAPH_TYPES.includes(type)) {
          throw new ValidationError(`"${type}" ist keine Art, die im Graphen vorkommt. Möglich: ${schema.GRAPH_TYPES.join(', ')}.`);
        }
      }
    }
    if (tiefe === 1 && !thema) throw new ValidationError('Ebene 1 braucht ein Thema ("thema").');

    const { u, ausCache } = universum.universum(store, { typen: typen || undefined });
    const out = tiefe === 1 ? universum.ebene1(u, thema) : universum.ebene0(u);
    out.ausCache = ausCache;
    out.dauerMs = Date.now() - t0;
    return out;
  });

  router.post('/api/graph/verbinden', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const from = requireString(body.from, 'from', { max: 80 });
    const to = requireStringArray(body.to, 'to', { max: 80, maxItems: 100 });
    const kind = optionalString(body.kind, 'kind', { max: 40 }) || 'related';
    const reason = optionalString(body.reason, 'reason', { max: 500 }) || undefined;
    return universum.verbinden(store, from, to, { kind, reason });
  });

  router.post('/api/graph/rueckgaengig', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const edges = requireStringArray(body.edges, 'edges', { max: 80, maxItems: 100 });
    return universum.rueckgaengig(store, edges);
  });

  router.post('/api/graph/ablehnen', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const from = requireString(body.from, 'from', { max: 80 });
    const to = requireStringArray(body.to, 'to', { max: 80, maxItems: 100 });
    return universum.ablehnen(store, from, to);
  });

  /**
   * Die KI-Zusammenfassung eines Knotens. Der Chat-Dienst liefert sie ueber
   * `zusammenfassen({record, verknuepft})` -> {text, modell?}, sobald ein
   * spaeterer Schritt sie einbaut. Bis dahin sagt die Antwort ehrlich, dass
   * nichts da ist -- mit 200, damit die Karte den Satz zeigt statt eines
   * Fehlers, und mit `verfuegbar: false`, damit niemand ihn fuer eine
   * Zusammenfassung haelt.
   */
  router.post('/api/graph/zusammenfassung', async (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const id = requireString(body.id, 'id', { max: 80 });
    const record = mustGet(store, id);
    const dienst = rc.ctx.chat && typeof rc.ctx.chat.zusammenfassen === 'function' ? rc.ctx.chat : null;
    if (!dienst) return { id: record.id, verfuegbar: false, text: null, grund: KI_FEHLT };
    const verknuepft = verknuepfungenVon(store, record.id);
    const ergebnis = await dienst.zusammenfassen({ record, verknuepft });
    const text = ergebnis && typeof ergebnis.text === 'string' ? ergebnis.text.trim() : '';
    if (!text) return { id: record.id, verfuegbar: false, text: null, grund: KI_FEHLT };
    return { id: record.id, verfuegbar: true, text, modell: (ergebnis && ergebnis.modell) || null };
  });

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

/**
 * Eingehende und ausgehende Verknuepfungen eines Satzes, mit dem Titel der
 * Gegenseite (Vertrag B). Ein Nachbar, den es nicht mehr gibt (Tombstone),
 * wird ausgelassen statt als "Unbekannt" angezeigt.
 */
function verknuepfungenVon(store, id) {
  const label = require('../../graph/view').label;
  const eingehend = [];
  const ausgehend = [];
  let edges = [];
  try {
    edges = store.edges.for(id, { direction: 'both', limit: 500 });
  } catch { /* ein Satz ohne Kanten */ }
  for (const edge of edges) {
    const d = edge.data || {};
    const raus = d.from === id;
    const other = store.get(raus ? d.to : d.from);
    if (!other) continue;
    (raus ? ausgehend : eingehend).push({
      id: other.id,
      type: other.type,
      title: label(other),
      kind: d.kind,
      reason: d.reason || '',
      source: d.source || 'manual',
      edgeId: edge.id,
    });
  }
  return { eingehend, ausgehend };
}

module.exports = { register, verknuepfungenVon, KI_FEHLT };
