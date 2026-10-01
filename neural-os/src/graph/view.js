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
const { fold, tokenise, tokenSpans } = require('../store/search');

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
  // Fuellwoerter, die in Notizen staendig vorkommen und nie ein Thema tragen.
  'siehe', 'sowie', 'bzw', 'etwa', 'sehr', 'ganz', 'wieder', 'immer', 'dabei', 'dazu', 'hier', 'dort',
  'alle', 'allem', 'aller', 'jede', 'jeder', 'jedes', 'kein', 'keine', 'keinen', 'mein', 'meine',
  'dein', 'deine', 'seine', 'ihre', 'unsere', 'muss', 'sollte', 'koennen', 'koennte', 'wollen',
  'machen', 'macht', 'gibt', 'geht', 'kommt', 'steht', 'liegt', 'zwischen', 'seit', 'bis', 'beim',
  'ins', 'ans', 'aufs', 'eher', 'also', 'doch', 'mal', 'gut', 'viel', 'viele', 'wenig', 'zwei', 'drei',
  // Runde 1 der Pruefer (28.09.2026): Woerter, die im Demo-Tresor und im
  // Alltag Vorschlaege aus dem Nichts erzeugten ("1 gemeinsamer Begriff:
  // Alles", "... morgen", "... Frau"). Zeitwoerter, Mengen, Ordnungszahlen,
  // Anreden -- sie verbinden zwei Notizen nie inhaltlich.
  'alles', 'nichts', 'etwas', 'mehr', 'weniger', 'rest', 'ganze', 'ganzen', 'andere', 'anderen', 'anderes',
  'erste', 'erster', 'erstes', 'ersten', 'zweite', 'zweiten', 'dritte', 'dritten', 'letzte', 'letzten', 'naechste', 'naechsten',
  'selbe', 'selben', 'gleich', 'gleiche', 'gleichen', 'offen', 'offene', 'offenen', 'gehoert', 'gehoeren',
  'tag', 'tage', 'tages', 'tagen', 'heute', 'morgen', 'gestern', 'uebermorgen', 'jetzt', 'bald', 'spaeter',
  'frueher', 'woche', 'wochen', 'monat', 'monate', 'jahr', 'jahre', 'jahren', 'uhr', 'stunde', 'stunden', 'minuten',
  'frau', 'herr', 'herrn', 'bitte', 'danke', 'neu', 'neue', 'neuen', 'neues', 'alt', 'alte', 'alten', 'altes',
  'einfach', 'genau', 'wichtig', 'wirklich', 'schnell', 'fertig', 'weiter', 'wegen', 'damit', 'dafuer', 'davon',
  'darauf', 'daran', 'darin', 'dann', 'denn', 'weil', 'ob', 'nie', 'oft', 'manchmal', 'sonst', 'trotzdem',
  'welche', 'welcher', 'welches', 'dieser', 'diese', 'dieses', 'diesen', 'jeden', 'jedem', 'einige', 'beide', 'beiden',
  'waere', 'wuerde', 'hatten', 'bin', 'bist', 'seid', 'werde', 'wirst', 'wird', 'sollen', 'duerfen', 'darf', 'muessen',
  'machen', 'gemacht', 'geben', 'nehmen', 'lassen', 'bleiben', 'sagen', 'sehen',
]);

/**
 * Nur Ziffern ("2027", "10") sind kein Begriff: eine Jahreszahl im Titel
 * verbindet eine Beetplanung nicht mit einem Gartenjahr.
 */
const NUR_ZIFFERN_RE = /^\d+$/;

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

/**
 * Die Schlagworte eines Satzes: das Feld `tags` UND die #worte im Text --
 * EINE Quelle fuer alle, die fragen (Universum, Vorschlaege, Graph-Bild,
 * Vervollstaendigung). Frueher las der Server nur das Feld; der Editor
 * schreibt #biologie aber in den Text, und so entstand das Thema
 * "Biologie" nie, waehrend die Notizwand denselben Chip zeigte (Pruefer,
 * Runde 1). Welche Textfelder zaehlen, entscheidet dieselbe Liste wie bei
 * der Ableitung der `tagged`-Kanten (derive.TEXT_FIELDS), damit Schlagwort
 * und Kante nie auseinanderlaufen. Doppelte (Gross/Klein, Umlaute) fallen
 * weg, die erste Schreibweise gewinnt -- das Feld vor dem Text.
 *
 * Zwischengespeichert je Satz, solange Text und Feld gleich sind: das
 * Universum fragt bei jedem Neubau alle 10 000 Saetze, und den Text dafuer
 * jedes Mal neu zu zerlegen kostete mehr als der ganze Bau.
 */
const TAG_CACHE = new Map();
const TAG_CACHE_MAX = 200000;

function tagsOf(record) {
  const d = (record && record.data) || {};
  const feld = Array.isArray(d.tags) ? d.tags : [];
  const felder = (derive().TEXT_FIELDS[record && record.type]) || [];
  let text = '';
  for (const f of felder) if (typeof d[f] === 'string' && d[f].includes('#')) text += `${d[f]}\n`;
  const schluessel = feld.length ? feld.join('\u0000') : '';
  const id = record && typeof record.id === 'string' ? record.id : null;
  if (id) {
    const hit = TAG_CACHE.get(id);
    if (hit && hit.text === text && hit.feld === schluessel) return hit.out.slice();
  }
  const out = [];
  const seen = new Set();
  const nimm = (raw) => {
    if (typeof raw !== 'string') return;
    const t = raw.trim().replace(/^#/, '');
    if (!t) return;
    const key = fold(t);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const t of feld) nimm(t);
  if (text) {
    try {
      for (const t of derive().extractLinks(text).tags) nimm(t);
    } catch { /* ein Text, der sich nicht zerlegen laesst, hat eben keine Schlagworte */ }
  }
  if (id) {
    if (TAG_CACHE.size >= TAG_CACHE_MAX) TAG_CACHE.clear();
    TAG_CACHE.set(id, { text, feld: schluessel, out });
  }
  return out.slice();
}

/** derive.js erst beim ersten Gebrauch laden: es braucht view.js nicht, aber so bleibt die Reihenfolge egal. */
let deriveMod = null;
function derive() {
  if (!deriveMod) deriveMod = require('./derive');
  return deriveMod;
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
    // Die Arten gehen in die Breitensuche selbst, nicht erst danach: sonst
    // fuellt sie ihr Limit mit Saetzen, die gleich wieder herausfallen. Ein
    // Chat mit 450 Nachrichten hatte so ein Umfeld aus nichts als sich
    // selbst (Pruefer Gehirn, Runde 2).
    const nb = store.edges.neighbours(focus, { depth, types, kinds: kinds || undefined, limit });
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

/**
 * Flexionsendungen, die zwei Schreibweisen desselben Wortes trennen.
 * Laengste zuerst, damit "-ungen" nicht als "-en" endet.
 */
const ENDUNGEN = ['ungen', 'ung', 'ern', 'en', 'er', 'em', 'es', 'e', 'n', 's'];
const STAMM_MIN = 4;

/**
 * Eine kleine, ehrliche Stammform fuer Deutsch: Endungen abschneiden, bis
 * nichts mehr passt (hoechstens zwei Runden), nie unter vier Zeichen.
 *
 * "Pflanzen", "Pflanze" und "pflanz" landen so auf demselben Schluessel,
 * "Lichts" bei "licht". Das ist kein Lemmatisierer: "Blaetter" und "Blatt"
 * bleiben getrennt, und die Doku sagt das auch. Es ist genau so viel, dass
 * "Pflanzen brauchen Licht" und "Die Pflanze im Licht" einander finden,
 * ohne dass ein Sprachmodell im Spiel ist. Nur fuer den Vergleich gedacht --
 * angezeigt wird immer das Wort, wie der Nutzer es geschrieben hat.
 */
function stamm(term) {
  let out = term;
  for (let runde = 0; runde < 2; runde++) {
    let getroffen = false;
    for (const endung of ENDUNGEN) {
      if (out.length - endung.length >= STAMM_MIN && out.endsWith(endung)) {
        out = out.slice(0, -endung.length);
        getroffen = true;
        break;
      }
    }
    if (!getroffen) break;
  }
  return out;
}

/**
 * Stammform -> Schreibweise im Text (die erste), fuer alles, was der Nutzer
 * spaeter zu lesen bekommt ("3 gemeinsame Begriffe: Licht, Chlorophyll, Blatt").
 */
/**
 * Die eigenen Schlagworte zaehlen nicht als Begriffe: sie gehen schon in die
 * Schlagwort-Aehnlichkeit ein, und "2 gemeinsame Begriffe: schule, biologie"
 * neben "2 gemeinsame Schlagworte: #schule, #biologie" waere dieselbe
 * Beobachtung zweimal.
 */
function eigeneTags(record) {
  return new Set(tagsOf(record).map((t) => fold(t)));
}

function zaehlt(term, tags) {
  return !STOPWORDS.has(term) && !tags.has(term) && !NUR_ZIFFERN_RE.test(term);
}

function termMap(record) {
  const text = textOf(record);
  const tags = eigeneTags(record);
  const map = new Map();
  for (const span of tokenSpans(text, 3)) {
    if (!zaehlt(span.term, tags)) continue;
    const key = stamm(span.term);
    if (!map.has(key)) map.set(key, text.slice(span.start, span.end));
  }
  return map;
}

function termSet(record) {
  const set = new Set();
  const tags = eigeneTags(record);
  for (const term of tokenise(textOf(record), 3)) {
    if (zaehlt(term, tags)) set.add(stamm(term));
  }
  return set;
}

/** Zeichen, nach denen ein Wort einen Satz (oder eine Zeile, eine Liste) anfaengt. */
const SATZANFANG_RE = /[.!?:;\n\r#*>|(\[\-\u2013\u2014\u201e\u201c"'\u00bb\u00ab\u2026]/;

/**
 * Wie ein Wort im Text steht, je Stammform: `gross` -- mindestens einmal
 * mitten im Satz gross geschrieben (im Deutschen: ein Hauptwort, ein Name),
 * `klein` -- mindestens einmal klein geschrieben (ein Verb, ein Adjektiv,
 * "drucken" neben "Druck"). Fuer die Regel, wann EIN gemeinsames Wort als
 * Grund genuegt (suggestLinks): "Licht" ja, "bestellen" nein.
 */
function termInfo(record) {
  const text = textOf(record);
  const tags = eigeneTags(record);
  const map = new Map();
  for (const span of tokenSpans(text, 3)) {
    if (!zaehlt(span.term, tags)) continue;
    const key = stamm(span.term);
    let info = map.get(key);
    if (!info) map.set(key, (info = { gross: false, klein: false }));
    const erstes = text[span.start];
    const istGross = erstes !== erstes.toLowerCase();
    if (!istGross) { info.klein = true; continue; }
    let i = span.start - 1;
    while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
    if (i >= 0 && !SATZANFANG_RE.test(text[i])) info.gross = true;
  }
  return map;
}

/** Die Stammform eines Titels aus genau einem Wort ("Jonas", "Crema"), sonst null. */
function titelWort(record) {
  const woerter = tokenise(label(record), 3);
  return woerter.length === 1 ? stamm(woerter[0]) : null;
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
 * Score = 0.6 * tag overlap + 0.4 * vocabulary overlap (Jaccard). Records
 * that are already connected (in either direction, by any edge) are excluded:
 * suggesting what already exists wastes the user's attention.
 *
 * Nothing is written. The caller shows the proposals; a person decides.
 *
 * `opts.candidates` laesst den Aufrufer die Vergleichsmenge vorgeben (etwa
 * aus der Volltextsuche vorgefiltert, siehe src/graph/universum.js); ohne sie
 * gilt wie bisher die juengste Scheibe des Tresors.
 *
 * Seit Runde 1 der Pruefer (28.09.2026) gilt ausserdem:
 *   - Ein gemeinsames Schlagwort allein ist kein Vorschlag; es braucht
 *     mindestens ein gemeinsames Wort im Inhalt.
 *   - EIN gemeinsames Wort genuegt nur, wenn es der Titel einer Seite ist
 *     oder ein Hauptwort, das in beiden Texten nie klein steht (und, mit
 *     `opts.df`, selten ist). "Licht" traegt, "bestellen" nicht.
 *   - Mit `opts.df` (Stammform -> in wie vielen Saetzen, `opts.dfN` Saetze
 *     gesamt) fallen Allerweltswoerter heraus (in mehr als 10 %, mindestens
 *     5 Saetzen) und seltene Woerter wiegen schwerer (gewichtete Jaccard).
 *
 * @param {object} store
 * @param {string} recordId
 * @param {{limit?:number, minScore?:number, types?:string[], pool?:number,
 *          candidates?:object[], exclude?:Set<string>, df?:Map<string,number>, dfN?:number}} [opts]
 * @returns {Array<{id:string,type:string,label:string,score:number,tagScore:number,
 *                  termScore:number,sharedTags:string[],sharedTerms:string[],
 *                  gemeinsam:number,reason:string,grund:string}>}
 *          `sharedTerms` in der Schreibweise des Ausgangstextes; `grund` ist
 *          der Satz fuer die Karte ("3 gemeinsame Begriffe: Licht, …").
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
  const exclude = opts.exclude instanceof Set ? opts.exclude : null;

  const connected = new Set([record.id]);
  try {
    for (const edge of store.edges.for(record.id, { direction: 'both' })) {
      connected.add(edge.data.from);
      connected.add(edge.data.to);
    }
  } catch { /* a store without edges for this id */ }

  const ownWords = termMap(record);
  const ownTerms = new Set(ownWords.keys());
  const ownTags = new Set(tagsOf(record).map((t) => fold(t)));
  const ownTagLabels = new Map(tagsOf(record).map((t) => [fold(t), t]));
  if (!ownTerms.size) return [];
  let ownInfo = null; // erst gebraucht, wenn ein Kandidat nur EIN Wort teilt
  const ownTitel = titelWort(record);

  // Wie haeufig ein Wort im Tresor ist (Vertrag E, Runde 1): wer es mitgibt
  // (src/graph/universum.js), bekommt seltene Woerter hoeher gewichtet und
  // Allerweltswoerter ganz heraus. Ohne Tabelle zaehlen alle gleich.
  const df = opts.df && typeof opts.df.get === 'function' ? opts.df : null;
  const n = df ? Math.max(1, Number(opts.dfN) || 1) : 0;
  const gemeinAb = df ? Math.max(5, Math.ceil(n * 0.1)) : Infinity;
  const seltenBis = df ? Math.max(3, Math.ceil(n * 0.03)) : Infinity;
  const gewicht = (t) => (df ? Math.log(1 + n / Math.max(1, df.get(t) || 1)) : 1);
  const informativ = (t) => !df || (df.get(t) || 0) <= gemeinAb;

  let candidates = [];
  const seen = new Set();
  if (Array.isArray(opts.candidates)) {
    for (const other of opts.candidates) {
      if (!other || typeof other.id !== 'string' || seen.has(other.id)) continue;
      if (connected.has(other.id) || (exclude && exclude.has(other.id))) continue;
      if (!types.includes(other.type)) continue;
      seen.add(other.id);
      candidates.push(other);
    }
  } else {
    for (const type of types) {
      let res;
      try { res = store.list(type, { sort: 'updatedAt', order: 'desc', limit: pool }); } catch { continue; }
      for (const other of res.items) {
        if (connected.has(other.id) || (exclude && exclude.has(other.id))) continue;
        candidates.push(other);
      }
    }
    if (candidates.length > pool) {
      candidates.sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : (a.updatedAt < b.updatedAt ? 1 : -1)));
      candidates = candidates.slice(0, pool);
    }
  }

  const scored = [];
  for (const other of candidates) {
    const otherTags = new Set(tagsOf(other).map((t) => fold(t)));
    const sharedTags = [];
    for (const t of otherTags) if (ownTags.has(t)) sharedTags.push(ownTagLabels.get(t) || t);
    const tagScore = jaccard(ownTags, otherTags);

    const otherTerms = termSet(other);
    const geteilt = [];
    for (const term of ownTerms) if (otherTerms.has(term) && informativ(term)) geteilt.push(term);
    // Ein gemeinsames Schlagwort allein ist kein Grund: beide haengen ueber
    // #schule ohnehin im selben Thema. Verbunden wird, was INHALT teilt.
    if (!geteilt.length) continue;
    if (geteilt.length === 1) {
      // EIN Wort genuegt nur, wenn es etwas traegt: der Titel einer der
      // beiden Seiten ("Jonas" -> "Telefonat mit Jonas"), oder ein seltenes
      // Hauptwort, das nirgends klein geschrieben steht ("Licht" ja,
      // "bestellen" und "drucken" nein).
      const t = geteilt[0];
      const titel = t === ownTitel || t === titelWort(other);
      if (!titel) {
        if (!ownInfo) ownInfo = termInfo(record);
        const a = ownInfo.get(t) || { gross: false, klein: true };
        const b = termInfo(other).get(t) || { gross: false, klein: true };
        const hauptwort = (a.gross || b.gross) && !a.klein && !b.klein;
        const selten = !df || (df.get(t) || 0) <= seltenBis;
        if (!hauptwort || !selten) continue;
      }
    }

    // Die Zahl, die zaehlt (und die Schwelle), bleibt die einfache Jaccard-
    // Aehnlichkeit -- nur ohne Allerweltswoerter im Schnitt. Fuer die
    // Reihenfolge zaehlen seltene Woerter mehr (gewichtete Jaccard): wer
    // "Chloroplasten" teilt, steht vor dem, der "Wasser" teilt.
    let vereinigung = ownTerms.size;
    for (const t of otherTerms) if (!ownTerms.has(t)) vereinigung++;
    const termScore = vereinigung > 0 ? geteilt.length / vereinigung : 0;
    const score = 0.6 * tagScore + 0.4 * termScore;
    if (score < minScore) continue;
    let schnittW = 0;
    let vereinigungW = 0;
    for (const t of ownTerms) {
      const w = gewicht(t);
      vereinigungW += w;
      if (otherTerms.has(t) && informativ(t)) schnittW += w;
    }
    for (const t of otherTerms) if (!ownTerms.has(t)) vereinigungW += gewicht(t);
    const rang = 0.6 * tagScore + 0.4 * (vereinigungW > 0 ? schnittW / vereinigungW : 0);

    const gemeinsam = geteilt.length;
    const sharedTerms = geteilt.slice(0, 5).map((term) => ownWords.get(term) || term);

    const reasons = [];
    if (sharedTags.length) reasons.push(`gemeinsame Schlagworte: ${sharedTags.slice(0, 3).map((t) => `#${t}`).join(', ')}`);
    if (sharedTerms.length) reasons.push(`gemeinsame Begriffe: ${sharedTerms.slice(0, 3).join(', ')}`);

    scored.push({
      id: other.id,
      type: other.type,
      label: label(other),
      score: Math.round(score * 1000) / 1000,
      rang,
      tagScore: Math.round(tagScore * 1000) / 1000,
      termScore: Math.round(termScore * 1000) / 1000,
      sharedTags,
      sharedTerms,
      gemeinsam,
      // German, user-visible: this string is the entire justification the user
      // gets before deciding, so it names the actual evidence.
      reason: reasons.length ? `Vorschlag wegen ${reasons.join(' und ')}` : 'Vorschlag wegen Textaehnlichkeit',
      grund: grundSatz(sharedTags, sharedTerms, gemeinsam),
    });
  }

  scored.sort((a, b) => (b.rang - a.rang) || (b.score - a.score) || (a.id < b.id ? -1 : 1));
  return scored.slice(0, limit).map(({ rang, ...rest }) => rest);
}

/**
 * Der Satz auf der Vorschlagskarte. Zaehlt ehrlich (alle gemeinsamen
 * Begriffe, nicht nur die drei genannten) und beugt richtig:
 * "1 gemeinsamer Begriff: Licht" / "3 gemeinsame Begriffe: Licht, Blatt, …".
 */
function grundSatz(sharedTags, sharedTerms, gemeinsam) {
  const teile = [];
  if (sharedTags.length) {
    const n = sharedTags.length;
    const liste = sharedTags.slice(0, 3).map((t) => `#${t}`).join(', ') + (n > 3 ? ', …' : '');
    teile.push(n === 1 ? `1 gemeinsames Schlagwort: ${liste}` : `${n} gemeinsame Schlagworte: ${liste}`);
  }
  if (sharedTerms.length) {
    const n = Math.max(gemeinsam, sharedTerms.length);
    const liste = sharedTerms.slice(0, 3).join(', ') + (n > 3 ? ', …' : '');
    teile.push(n === 1 ? `1 gemeinsamer Begriff: ${liste}` : `${n} gemeinsame Begriffe: ${liste}`);
  }
  return teile.length ? teile.join(' · ') : 'Aehnlicher Text';
}

module.exports = {
  buildGraph,
  label,
  clusters,
  suggestLinks,
  snippetOf,
  tagsOf,
  stamm,
  termMap,
  termSet,
  termInfo,
  STOPWORDS,
};
