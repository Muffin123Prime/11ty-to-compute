'use strict';

/**
 * Graph views -- everything the UI needs to draw and reason about the vault.
 *
 * Design decisions that are not obvious from the code
 * ---------------------------------------------------
 * 1. **`truncated` is a promise, not decoration.** Every selection path counts
 *    how many candidates existed before the limit cut in and reports the truth.
 *    A graph view that silently drops half your knowledge is worse than one
 *    that says "600 von 2 400 Knoten".
 * 2. **Two degrees, both honest.** `degree` counts the edges actually drawn in
 *    THIS view (so node size matches the picture) and `totalDegree` counts all
 *    live edges of that node in the vault (so the UI can say "12 weitere
 *    Verknuepfungen" and offer to expand). One number could not do both
 *    without lying in one of the two situations.
 * 3. **`suggestLinks` never writes.** A suggestion is a hypothesis about the
 *    user's own material. Turning hypotheses into edges automatically is how a
 *    knowledge graph fills with connections nobody believes. It returns
 *    candidates plus the reason, and a human presses the button.
 * 4. Cluster labels are *suggestions* too, taken from what the component
 *    actually contains (shared tags first, then shared vocabulary, then the
 *    best-connected node's title). Never invented text.
 * 5. Snippets are plain text. Search snippets arrive with \u0001/\u0002 hit
 *    markers; they are stripped here because a graph label is not a search
 *    result and no consumer should have to know about the marker protocol.
 */

const { NotFoundError, ValidationError } = require('../kernel/errors');
const { GRAPH_TYPES, EDGE_KINDS } = require('../store/schema');
const { fold, tokenise } = require('../store/search');

const DEFAULT_LIMIT = 600;
const MAX_LIMIT = 5000;
const LABEL_MAX = 120;
const SNIPPET_MAX = 180;
const MARKERS_RE = /[\u0001\u0002]/g;

/** Fields that carry the readable body of a record, in reading order. */
const BODY_FIELDS = ['body', 'description', 'text', 'content', 'goal', 'result', 'systemPrompt', 'summary'];

/**
 * Words that carry no topical signal. Kept small and explicit on purpose: a
 * 500-word stopword list is a language model in disguise and would quietly
 * drop terms that matter in a personal vault.
 */
const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'aber', 'nicht', 'auch', 'noch', 'schon', 'nur', 'wie', 'wenn', 'dann', 'als',
  'ist', 'sind', 'war', 'waren', 'sein', 'hat', 'habe', 'haben', 'hatte', 'wird', 'werden', 'wurde',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man', 'mich', 'mir', 'dir', 'sich', 'uns',
  'fuer', 'mit', 'von', 'vom', 'zur', 'zum', 'auf', 'aus', 'bei', 'nach', 'ueber', 'unter', 'vor',
  'durch', 'gegen', 'ohne', 'um', 'im', 'in', 'an', 'am', 'zu', 'da', 'dass', 'kann', 'soll',
  'the', 'and', 'or', 'not', 'but', 'for', 'with', 'from', 'this', 'that', 'these', 'those',
  'are', 'was', 'were', 'been', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should',
  'you', 'your', 'our', 'its', 'their', 'into', 'out', 'about', 'more', 'than', 'then', 'them',
]);

/* ---------------------------------------------------------------- labels */

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(MARKERS_RE, '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * A display title for ANY record type, including the bookkeeping ones, because
 * "edge_abc123" on screen helps nobody.
 * @param {object} record
 * @returns {string}
 */
function label(record) {
  if (!record || typeof record !== 'object') return 'Unbekannt';
  const d = record.data || {};
  const first = (...values) => {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return clip(v, LABEL_MAX);
    }
    return '';
  };
  switch (record.type) {
    case 'note': return first(d.title) || 'Notiz ohne Titel';
    case 'chat': return first(d.title) || 'Chat ohne Titel';
    case 'project': return first(d.name) || 'Projekt ohne Namen';
    case 'task': return first(d.title) || 'Aufgabe ohne Titel';
    case 'agent': return first(d.name) || 'Agent ohne Namen';
    case 'file': return first(d.name) || 'Datei ohne Namen';
    case 'entity': return first(d.name) || 'Entitaet ohne Namen';
    case 'run': return first(d.goal) ? `Lauf: ${first(d.goal)}` : 'Lauf ohne Ziel';
    case 'message': return first(d.content) || `Nachricht (${d.role || 'unbekannt'})`;
    case 'memory': return first(d.text) || 'Erinnerung';
    case 'edge': return `${d.kind || 'related'}: ${d.from || '?'} → ${d.to || '?'}`;
    case 'approval': return first(d.summary) || `Freigabe (${d.kind || 'unbekannt'})`;
    case 'grant': return `Netzfreigabe ${d.scope || ''}`.trim();
    case 'token': return first(d.label) || 'Zugriffstoken';
    default: return first(d.title, d.name) || `${record.type || 'Datensatz'} ${String(record.id || '').slice(-6)}`;
  }
}

/** First readable body text of a record, already clipped and plain. */
function snippetOf(record, override) {
  if (typeof override === 'string' && override.trim()) return clip(override, SNIPPET_MAX);
  const d = (record && record.data) || {};
  for (const field of BODY_FIELDS) {
    const value = d[field];
    if (typeof value === 'string' && value.trim()) {
      // Fenced code in a preview is noise: it is never the sentence that tells
      // you what the note is about.
      const plain = value.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1');
      const out = clip(plain, SNIPPET_MAX);
      if (out) return out;
    }
  }
  return '';
}

function tagsOf(record) {
  const d = (record && record.data) || {};
  const out = [];
  if (Array.isArray(d.tags)) {
    for (const t of d.tags) {
      if (typeof t === 'string' && t.trim()) out.push(t.trim().replace(/^#/, ''));
    }
  }
  return out;
}

/* ------------------------------------------------------------ buildGraph */

function normaliseList(value, allowed) {
  if (value === undefined || value === null || value === '') return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const item of raw) {
    const v = String(item).trim();
    if (!v) continue;
    if (allowed && !allowed.includes(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out.length ? out : null;
}

function intOpt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Candidate nodes when no focus is given: the most recently touched records. */
function recentCandidates(store, types, limit) {
  const pool = [];
  let total = 0;
  for (const type of types) {
    let res;
    try {
      res = store.list(type, { sort: 'updatedAt', order: 'desc', limit });
    } catch {
      continue;
    }
    total += res.total;
    pool.push(...res.items);
  }
  pool.sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return a.id < b.id ? -1 : 1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
  return { items: pool.slice(0, limit), total };
}

/** Candidate nodes for a text query: the search index if there is one. */
function queryCandidates(store, query, types, limit) {
  if (typeof store.search === 'function') {
    try {
      const res = store.search(query, { types: types || undefined, limit });
      const items = [];
      const snippets = new Map();
      for (const hit of res.items) {
        if (!hit || !hit.record) continue;
        if (types && !types.includes(hit.record.type)) continue;
        items.push(hit.record);
        if (hit.snippet) snippets.set(hit.record.id, String(hit.snippet).replace(MARKERS_RE, ''));
      }
      return { items, total: res.total, snippets };
    } catch {
      // Fall through to the scan: a broken index must not blank the graph.
    }
  }
  const needle = fold(String(query));
  const items = [];
  let total = 0;
  for (const type of types) {
    let all;
    try { all = store.list(type, {}).items; } catch { continue; }
    for (const rec of all) {
      const hay = fold(`${label(rec)} ${snippetOf(rec)} ${tagsOf(rec).join(' ')}`);
      if (!hay.includes(needle)) continue;
      total++;
      if (items.length < limit) items.push(rec);
    }
  }
  return { items, total, snippets: new Map() };
}

/**
 * Build a drawable graph.
 *
 * @param {object} store
 * @param {{focus?:string, depth?:number, types?:string[]|string, kinds?:string[]|string,
 *          limit?:number, query?:string, includeOrphans?:boolean}} [opts]
 * @returns {{nodes:object[], edges:object[], truncated:boolean, stats:object}}
 */
function buildGraph(store, opts = {}) {
  if (!store || typeof store.list !== 'function' || !store.edges) {
    throw new ValidationError('buildGraph benoetigt einen Store.');
  }
  const limit = intOpt(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const depth = intOpt(opts.depth, 2, 0, 6);
  const types = normaliseList(opts.types, null) || GRAPH_TYPES.slice();
  const kinds = normaliseList(opts.kinds, EDGE_KINDS);
  const includeOrphans = opts.includeOrphans !== false;
  const query = typeof opts.query === 'string' && opts.query.trim() ? opts.query.trim() : null;
  const focus = typeof opts.focus === 'string' && opts.focus.trim() ? opts.focus.trim() : null;

  let records = [];
  let candidateTotal = 0;
  let truncated = false;
  let snippets = new Map();

  if (focus) {
    const start = store.get(focus);
    if (!start) throw new NotFoundError(`Record ${focus}`);
    const nb = store.edges.neighbours(focus, { depth, kinds: kinds || undefined, limit });
    records = nb.nodes.filter((r) => r.id === focus || types.includes(r.type));
    candidateTotal = nb.nodes.length;
    truncated = !!nb.truncated;
  } else if (query) {
    const found = queryCandidates(store, query, types, limit);
    records = found.items;
    candidateTotal = found.total;
    snippets = found.snippets;
    truncated = found.total > records.length;
  } else {
    const found = recentCandidates(store, types, limit);
    records = found.items;
    candidateTotal = found.total;
    truncated = found.total > records.length;
  }

  if (records.length > limit) {
    records = records.slice(0, limit);
    truncated = true;
  }

  const nodeIds = new Set(records.map((r) => r.id));
  const byId = new Map(records.map((r) => [r.id, r]));

  // Only edges whose BOTH endpoints are drawn: an edge to an invisible node is
  // a line into nowhere.
  const edgeById = new Map();
  const degree = new Map();
  const totalDegree = new Map();
  for (const id of nodeIds) {
    let outgoing = [];
    let incident = [];
    try {
      incident = store.edges.for(id, { direction: 'both' });
    } catch { incident = []; }
    totalDegree.set(id, incident.length);
    outgoing = incident.filter((e) => e.data.from === id);
    for (const edge of outgoing) {
      if (kinds && !kinds.includes(edge.data.kind)) continue;
      if (!nodeIds.has(edge.data.to)) continue;
      if (edgeById.has(edge.id)) continue;
      edgeById.set(edge.id, edge);
      degree.set(id, (degree.get(id) || 0) + 1);
      degree.set(edge.data.to, (degree.get(edge.data.to) || 0) + 1);
    }
  }

  let nodes = records;
  if (!includeOrphans) {
    nodes = records.filter((r) => (degree.get(r.id) || 0) > 0 || r.id === focus);
    if (nodes.length !== records.length) {
      const kept = new Set(nodes.map((r) => r.id));
      for (const [edgeId, edge] of edgeById) {
        if (!kept.has(edge.data.from) || !kept.has(edge.data.to)) edgeById.delete(edgeId);
      }
    }
  }

  const byType = {};
  const outNodes = nodes.map((record) => {
    byType[record.type] = (byType[record.type] || 0) + 1;
    return {
      id: record.id,
      type: record.type,
      label: label(record),
      tags: tagsOf(record),
      degree: degree.get(record.id) || 0,
      totalDegree: totalDegree.get(record.id) || 0,
      updatedAt: record.updatedAt,
      pinned: !!(record.data && record.data.pinned),
      snippet: snippetOf(record, snippets.get(record.id)),
    };
  });

  const byKind = {};
  const outEdges = [];
  for (const edge of edgeById.values()) {
    byKind[edge.data.kind] = (byKind[edge.data.kind] || 0) + 1;
    outEdges.push({
      id: edge.id,
      from: edge.data.from,
      to: edge.data.to,
      kind: edge.data.kind,
      source: edge.data.source,
      weight: typeof edge.data.weight === 'number' ? edge.data.weight : 1,
      reason: edge.data.reason || '',
    });
  }

  return {
    nodes: outNodes,
    edges: outEdges,
    truncated,
    stats: {
      nodes: outNodes.length,
      edges: outEdges.length,
      candidates: candidateTotal,
      byType,
      byKind,
      focus: focus || null,
      depth: focus ? depth : null,
      limit,
      query: query || null,
      at: new Date().toISOString(),
    },
  };
}

/* ------------------------------------------------------------- clusters */

/** Union-Find with path compression; components of 2 000 nodes in one pass. */
function makeUnionFind() {
  const parent = new Map();
  const rank = new Map();
  const find = (x) => {
    if (!parent.has(x)) { parent.set(x, x); rank.set(x, 0); return x; }
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const da = rank.get(ra);
    const db = rank.get(rb);
    if (da < db) parent.set(ra, rb);
    else if (da > db) parent.set(rb, ra);
    else { parent.set(rb, ra); rank.set(ra, da + 1); }
  };
  return { find, union };
}

function topEntries(counter, n) {
  return [...counter.entries()]
    .sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .slice(0, n);
}

/**
 * Connected components with a suggested label.
 *
 * The label is derived, never invented: the most common shared tag, else the
 * most common meaningful word across the component's titles, else the title of
 * its best-connected node.
 *
 * @param {{nodes:object[], edges:object[]}} graph a `buildGraph` result
 * @returns {Array<{id:string,size:number,nodeIds:string[],label:string,labelSource:string,
 *                  tags:string[],types:object,edges:number,topNodeId:string|null}>}
 */
function clusters(graph) {
  if (!graph || !Array.isArray(graph.nodes)) {
    throw new ValidationError('clusters benoetigt ein Graph-Objekt mit nodes.');
  }
  const nodes = graph.nodes;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const known = new Set(nodes.map((n) => n.id));
  const uf = makeUnionFind();
  for (const n of nodes) uf.find(n.id);
  for (const e of edges) {
    // An edge to a node outside this view cannot merge two components we can
    // see, so it must not silently do so either.
    if (!known.has(e.from) || !known.has(e.to)) continue;
    uf.union(e.from, e.to);
  }

  const groups = new Map();
  for (const n of nodes) {
    const root = uf.find(n.id);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { root, nodes: [], edges: 0 }));
    g.nodes.push(n);
  }
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    const g = groups.get(uf.find(e.from));
    if (g) g.edges++;
  }

  const out = [];
  for (const g of groups.values()) {
    const tagCount = new Map();
    const wordCount = new Map();
    const typeCount = {};
    let top = null;
    for (const n of g.nodes) {
      typeCount[n.type] = (typeCount[n.type] || 0) + 1;
      if (!top || n.degree > top.degree || (n.degree === top.degree && n.id < top.id)) top = n;
      const seenTag = new Set();
      for (const tag of n.tags || []) {
        const key = fold(tag);
        if (!key || seenTag.has(key)) continue;
        seenTag.add(key);
        tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
      }
      const seenWord = new Set();
      for (const term of tokenise(n.label || '', 3)) {
        if (STOPWORDS.has(term) || seenWord.has(term)) continue;
        seenWord.add(term);
        wordCount.set(term, (wordCount.get(term) || 0) + 1);
      }
    }

    const topTags = topEntries(tagCount, 3);
    const topWords = topEntries(wordCount, 3);
    let clusterLabel;
    let labelSource;
    if (topTags.length && (topTags[0][1] > 1 || g.nodes.length === 1)) {
      clusterLabel = `#${topTags[0][0]}`;
      labelSource = 'tag';
    } else if (topWords.length && topWords[0][1] > 1) {
      const word = topWords[0][0];
      clusterLabel = word.charAt(0).toUpperCase() + word.slice(1);
      labelSource = 'begriff';
    } else if (top) {
      clusterLabel = top.label;
      labelSource = 'knoten';
    } else {
      clusterLabel = 'Gruppe';
      labelSource = 'leer';
    }

    out.push({
      id: g.root,
      size: g.nodes.length,
      nodeIds: g.nodes.map((n) => n.id),
      label: clusterLabel,
      labelSource,
      tags: topTags.map(([t]) => t),
      types: typeCount,
      edges: g.edges,
      topNodeId: top ? top.id : null,
    });
  }

  out.sort((a, b) => (b.size === a.size ? (a.label < b.label ? -1 : 1) : b.size - a.size));
  return out;
}

/* --------------------------------------------------------- suggestLinks */

function textOf(record) {
  const d = (record && record.data) || {};
  const parts = [label(record)];
  for (const field of BODY_FIELDS) {
    if (typeof d[field] === 'string' && d[field]) parts.push(d[field]);
  }
  const tags = tagsOf(record);
  if (tags.length) parts.push(tags.join(' '));
  if (Array.isArray(d.aliases)) parts.push(d.aliases.filter((a) => typeof a === 'string').join(' '));
  return parts.join('\n');
}

function termSet(record) {
  const set = new Set();
  for (const term of tokenise(textOf(record), 3)) {
    if (!STOPWORDS.has(term)) set.add(term);
  }
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) shared++;
  if (!shared) return 0;
  return shared / (a.size + b.size - shared);
}

/**
 * Propose records that look related to `recordId` -- and stop there.
 *
 * Score = 0.6 * tag overlap + 0.4 * vocabulary overlap, both Jaccard. Records
 * that are already connected (in either direction, by any edge) are excluded:
 * suggesting what already exists wastes the user's attention.
 *
 * Nothing is written. The caller shows the proposals; a person decides.
 *
 * @param {object} store
 * @param {string} recordId
 * @param {{limit?:number, minScore?:number, types?:string[], pool?:number}} [opts]
 * @returns {Array<{id:string,type:string,label:string,score:number,tagScore:number,
 *                  termScore:number,sharedTags:string[],sharedTerms:string[],reason:string}>}
 */
function suggestLinks(store, recordId, opts = {}) {
  if (!store || typeof store.list !== 'function' || !store.edges) {
    throw new ValidationError('suggestLinks benoetigt einen Store.');
  }
  const record = typeof recordId === 'string' ? store.get(recordId) : null;
  if (!record) throw new NotFoundError(`Record ${String(recordId)}`);

  const limit = intOpt(opts.limit, 8, 1, 100);
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0.02;
  const types = normaliseList(opts.types, null) || GRAPH_TYPES.slice();
  // Bound the worst case on a huge vault: comparing against every record is
  // O(n) per call, so we look at the most recently touched slice by default.
  const pool = intOpt(opts.pool, 2000, 1, 20000);

  const connected = new Set([record.id]);
  try {
    for (const edge of store.edges.for(record.id, { direction: 'both' })) {
      connected.add(edge.data.from);
      connected.add(edge.data.to);
    }
  } catch { /* a store without edges for this id */ }

  const ownTerms = termSet(record);
  const ownTags = new Set(tagsOf(record).map((t) => fold(t)));
  const ownTagLabels = new Map(tagsOf(record).map((t) => [fold(t), t]));
  if (!ownTerms.size && !ownTags.size) return [];

  let candidates = [];
  for (const type of types) {
    let res;
    try { res = store.list(type, { sort: 'updatedAt', order: 'desc', limit: pool }); } catch { continue; }
    for (const other of res.items) {
      if (connected.has(other.id)) continue;
      candidates.push(other);
    }
  }
  if (candidates.length > pool) {
    candidates.sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : (a.updatedAt < b.updatedAt ? 1 : -1)));
    candidates = candidates.slice(0, pool);
  }

  const scored = [];
  for (const other of candidates) {
    const otherTags = new Set(tagsOf(other).map((t) => fold(t)));
    const sharedTags = [];
    for (const t of otherTags) if (ownTags.has(t)) sharedTags.push(ownTagLabels.get(t) || t);
    const tagScore = jaccard(ownTags, otherTags);

    const otherTerms = termSet(other);
    const termScore = jaccard(ownTerms, otherTerms);
    const score = 0.6 * tagScore + 0.4 * termScore;
    if (score < minScore) continue;

    const sharedTerms = [];
    for (const term of ownTerms) {
      if (otherTerms.has(term)) sharedTerms.push(term);
      if (sharedTerms.length >= 5) break;
    }

    const reasons = [];
    if (sharedTags.length) reasons.push(`gemeinsame Schlagworte: ${sharedTags.slice(0, 3).map((t) => `#${t}`).join(', ')}`);
    if (sharedTerms.length) reasons.push(`gemeinsame Begriffe: ${sharedTerms.slice(0, 3).join(', ')}`);

    scored.push({
      id: other.id,
      type: other.type,
      label: label(other),
      score: Math.round(score * 1000) / 1000,
      tagScore: Math.round(tagScore * 1000) / 1000,
      termScore: Math.round(termScore * 1000) / 1000,
      sharedTags,
      sharedTerms,
      // German, user-visible: this string is the entire justification the user
      // gets before deciding, so it names the actual evidence.
      reason: reasons.length ? `Vorschlag wegen ${reasons.join(' und ')}` : 'Vorschlag wegen Textaehnlichkeit',
    });
  }

  scored.sort((a, b) => (b.score === a.score ? (a.id < b.id ? -1 : 1) : b.score - a.score));
  return scored.slice(0, limit);
}

module.exports = {
  buildGraph,
  label,
  clusters,
  suggestLinks,
  snippetOf,
  STOPWORDS,
};
