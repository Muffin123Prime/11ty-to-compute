'use strict';

/**
 * Tests for the knowledge graph: link derivation and graph views.
 *
 * Most tests run against a FAKE store implemented here to the contract in
 * docs/CONTRACTS.md §1. Two reasons: the graph must be provably independent of
 * the storage implementation, and a fake makes the awkward cases (a target
 * deleted mid-flight, 2 000 nodes) cheap to set up. The last two tests run the
 * same code against the REAL engine so the contract is not just a document.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, drain, tempHome } = require('./harness');

const derive = require('../src/graph/derive');
const view = require('../src/graph/view');
const schema = require('../src/store/schema');

/* ------------------------------------------------------- the fake store */

/**
 * In-memory store implementing the subset of the contract the graph uses.
 * Deliberately mirrors the real engine's semantics: exposed records are clones,
 * edges dedupe on (from,to,kind), deletes are soft, and an edge to a missing
 * endpoint throws NotFoundError.
 */
function makeStore() {
  const byId = new Map();
  const edgesFrom = new Map();
  const edgesTo = new Map();
  const edgeKey = new Map();
  let seq = 0;
  let tick = 0;

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const now = () => new Date(Date.UTC(2026, 0, 1) + (tick++) * 1000).toISOString();
  const newId = (type) => `${type}_${(seq++).toString(36).padStart(24, '0')}`;
  const live = (id) => {
    const r = byId.get(id);
    return r && !r.deletedAt ? r : null;
  };
  const notFound = (what) => {
    const err = new Error(`${what} not found`);
    err.code = 'NOT_FOUND';
    err.status = 404;
    return err;
  };

  function link(edge) {
    const { from, to, kind } = edge.data;
    if (!edgesFrom.has(from)) edgesFrom.set(from, new Set());
    edgesFrom.get(from).add(edge.id);
    if (!edgesTo.has(to)) edgesTo.set(to, new Set());
    edgesTo.get(to).add(edge.id);
    edgeKey.set(`${from}\u0000${to}\u0000${kind}`, edge.id);
  }
  function unlink(edge) {
    const { from, to } = edge.data;
    if (edgesFrom.has(from)) edgesFrom.get(from).delete(edge.id);
    if (edgesTo.has(to)) edgesTo.get(to).delete(edge.id);
  }

  function create(type, data, opts = {}) {
    const normalised = schema.validate(type, data || {});
    const id = opts.id || newId(type);
    if (byId.has(id)) throw new Error(`duplicate id ${id}`);
    const at = now();
    const record = { id, type, createdAt: at, updatedAt: at, deletedAt: null, rev: 1, data: normalised };
    byId.set(id, record);
    if (type === 'edge') link(record);
    return clone(record);
  }

  function get(id, opts = {}) {
    const r = byId.get(id);
    if (!r) return null;
    if (r.deletedAt && !opts.includeDeleted) return null;
    return clone(r);
  }

  function update(id, patch, opts = {}) {
    const r = byId.get(id);
    if (!r || (r.deletedAt && !opts.includeDeleted)) throw notFound(`Record ${id}`);
    const normalised = schema.validate(r.type, patch, { partial: true });
    r.data = { ...r.data, ...normalised };
    r.updatedAt = now();
    r.rev += 1;
    return clone(r);
  }

  function remove(id, opts = {}) {
    const r = byId.get(id);
    if (!r) throw notFound(`Record ${id}`);
    if (opts.hard) {
      if (r.type === 'edge') unlink(r);
      byId.delete(id);
      return clone(r);
    }
    if (!r.deletedAt) {
      r.deletedAt = now();
      r.updatedAt = r.deletedAt;
      r.rev += 1;
      if (r.type === 'edge') unlink(r);
    }
    return clone(r);
  }

  function list(type, q = {}) {
    const wanted = type == null || type === '*' ? null : (Array.isArray(type) ? type : [type]);
    let items = [];
    for (const r of byId.values()) {
      if (wanted && !wanted.includes(r.type)) continue;
      if (r.deletedAt && !q.includeDeleted) continue;
      if (typeof q.filter === 'function' && !q.filter(clone(r))) continue;
      items.push(r);
    }
    const field = q.sort || 'updatedAt';
    const dir = q.order === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      const av = field in a ? a[field] : a.data[field];
      const bv = field in b ? b[field] : b.data[field];
      if (av === bv) return a.id < b.id ? -1 : 1;
      return av < bv ? -dir : dir;
    });
    const total = items.length;
    const offset = Number.isInteger(q.offset) ? q.offset : 0;
    const limit = Number.isInteger(q.limit) ? q.limit : total;
    return { items: items.slice(offset, offset + limit).map(clone), total };
  }

  function search(query, opts = {}) {
    const needle = String(query || '').toLowerCase();
    const items = [];
    for (const r of byId.values()) {
      if (r.deletedAt) continue;
      if (opts.types && !opts.types.includes(r.type)) continue;
      const hay = JSON.stringify(r.data).toLowerCase();
      const at = hay.indexOf(needle);
      if (at < 0) continue;
      items.push({ record: clone(r), score: 1, snippet: `\u0001${needle}\u0002` });
    }
    const total = items.length;
    const limit = Number.isInteger(opts.limit) ? opts.limit : total;
    return { items: items.slice(0, limit), total };
  }

  function incident(id, direction = 'both', kinds = null) {
    const out = new Set();
    const push = (set) => {
      if (!set) return;
      for (const edgeId of set) {
        const e = byId.get(edgeId);
        if (!e || e.deletedAt) continue;
        if (kinds && !kinds.includes(e.data.kind)) continue;
        out.add(edgeId);
      }
    };
    if (direction === 'out' || direction === 'both') push(edgesFrom.get(id));
    if (direction === 'in' || direction === 'both') push(edgesTo.get(id));
    return [...out];
  }

  const edges = {
    add(spec = {}) {
      const { from, to, kind = 'related', source = 'manual', reason = '', weight = 1 } = spec;
      if (from === to) throw new Error('self edge');
      if (!live(from)) throw notFound(`Record ${from}`);
      if (!live(to)) throw notFound(`Record ${to}`);
      const existingId = edgeKey.get(`${from}\u0000${to}\u0000${kind}`);
      const existing = existingId ? byId.get(existingId) : null;
      if (existing && !existing.deletedAt) return clone(existing);
      return create('edge', { from, to, kind, source, reason, weight });
    },
    remove(id) {
      const r = byId.get(id);
      if (!r) throw notFound(`Edge ${id}`);
      return remove(id);
    },
    for(id, opts = {}) {
      const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : null;
      const out = incident(id, opts.direction || 'both', kinds).map((eid) => clone(byId.get(eid)));
      out.sort((a, b) => (a.id < b.id ? -1 : 1));
      return Number.isInteger(opts.limit) ? out.slice(0, opts.limit) : out;
    },
    between(a, b) {
      return edges.for(a).filter((e) => e.data.from === b || e.data.to === b);
    },
    neighbours(id, opts = {}) {
      const start = live(id);
      if (!start) throw notFound(`Record ${id}`);
      const depth = Number.isInteger(opts.depth) ? opts.depth : 1;
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 300;
      const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : null;
      const types = Array.isArray(opts.types) && opts.types.length ? opts.types : null;
      const nodes = new Map([[id, start]]);
      const found = new Map();
      let truncated = false;
      let frontier = [id];
      for (let d = 0; d < depth && frontier.length; d++) {
        const next = [];
        for (const nodeId of frontier) {
          for (const edgeId of incident(nodeId, 'both', kinds)) {
            const e = byId.get(edgeId);
            const otherId = e.data.from === nodeId ? e.data.to : e.data.from;
            const other = live(otherId);
            if (!other) continue;
            if (types && !types.includes(other.type)) continue;
            if (!nodes.has(otherId)) {
              if (nodes.size >= limit) { truncated = true; continue; }
              nodes.set(otherId, other);
              next.push(otherId);
            }
            found.set(edgeId, e);
          }
        }
        frontier = next;
      }
      for (const nodeId of nodes.keys()) {
        for (const edgeId of incident(nodeId, 'out', kinds)) {
          const e = byId.get(edgeId);
          if (!found.has(edgeId) && nodes.has(e.data.to)) found.set(edgeId, e);
        }
      }
      return {
        nodes: [...nodes.values()].map(clone),
        edges: [...found.values()].map(clone),
        truncated,
      };
    },
  };

  return {
    create, get, update, remove, list, search, edges,
    all: (type) => list(type, {}).items,
    count: (type) => list(type, {}).total,
    liveEdges: () => list('edge', {}).items,
  };
}

/** Convenience: all live edges out of `id`, sorted for stable comparison. */
function outKinds(store, id) {
  return store.edges
    .for(id, { direction: 'out' })
    .map((e) => `${e.data.kind}:${e.data.to}:${e.data.source}`)
    .sort();
}

/* ------------------------------------------------------- extractLinks */

test('extractLinks findet Wiki-Links, Tags und nackte URLs', () => {
  const { wikiLinks, tags, urls } = derive.extractLinks(
    'Siehe [[Zweites Gehirn]] und [[Notiz|dazu mehr]].\n' +
    'Themen: #wissen #zettelkasten\n' +
    'Quelle: https://example.org/pfad?x=1 und http://localhost:11434/api/tags',
  );
  assert.deepEqual(wikiLinks, ['Zweites Gehirn', 'Notiz']);
  assert.deepEqual(tags, ['wissen', 'zettelkasten']);
  assert.deepEqual(urls, ['https://example.org/pfad?x=1', 'http://localhost:11434/api/tags']);
});

test('extractLinks ignoriert Code-Bloecke vollstaendig', () => {
  const text = [
    'Echt: #wichtig und [[Echte Notiz]]',
    '```bash',
    '#!/bin/sh',
    '# ein Kommentar mit #falschertag',
    'curl https://boese.example/leak',
    'siehe [[Falsche Notiz]]',
    '```',
    'Danach wieder #echt',
  ].join('\n');
  const res = derive.extractLinks(text);
  assert.deepEqual(res.tags, ['wichtig', 'echt']);
  assert.deepEqual(res.wikiLinks, ['Echte Notiz']);
  assert.deepEqual(res.urls, []);
});

test('extractLinks ignoriert Inline-Code und Markdown-Ueberschriften', () => {
  const res = derive.extractLinks(
    '# Ueberschrift ist kein Tag\n' +
    'Die Farbe `#fff` und `[[kein Link]]` stehen in Code.\n' +
    'Aber #design zaehlt.',
  );
  assert.deepEqual(res.tags, ['design']);
  assert.deepEqual(res.wikiLinks, []);
});

test('extractLinks laesst URL-Fragmente und Entities keine Tags werden', () => {
  const res = derive.extractLinks('Link: https://example.org/doc#abschnitt und &#228; sowie x#kein');
  assert.deepEqual(res.tags, []);
  assert.deepEqual(res.urls, ['https://example.org/doc#abschnitt']);
});

test('extractLinks kennt Umlaute in Tags und dedupliziert umlaut-tolerant', () => {
  const res = derive.extractLinks('#Übung und #übung und #ÜBUNG, dazu #größe.');
  assert.deepEqual(res.tags, ['Übung', 'größe']);
});

test('extractLinks ueberlebt leere, kaputte und riesige Eingaben', () => {
  assert.deepEqual(derive.extractLinks(''), { wikiLinks: [], tags: [], urls: [] });
  assert.deepEqual(derive.extractLinks(null), { wikiLinks: [], tags: [], urls: [] });
  assert.deepEqual(derive.extractLinks(42), { wikiLinks: [], tags: [], urls: [] });
  // Unclosed fence swallows the rest, exactly like CommonMark.
  assert.deepEqual(derive.extractLinks('#vorher\n```\n#drin [[Drin]]').tags, ['vorher']);
  // Unclosed brackets and backticks must not hang or throw.
  assert.deepEqual(derive.extractLinks('[[offen und `code').wikiLinks, []);
  const huge = ('lorem ipsum '.repeat(5000)) + ' #ende';
  assert.deepEqual(derive.extractLinks(huge).tags, ['ende']);
  // Pathological backticks: unmatched runs must not turn the scan quadratic.
  const backticks = 'x ```y '.repeat(4000) + ' #danach';
  const t0 = Date.now();
  assert.deepEqual(derive.extractLinks(backticks).tags, ['danach']);
  assert.ok(Date.now() - t0 < 1000, 'Backtick-Wuest darf nicht haengen');
});

/* ------------------------------------------------------------ deriveFor */

test('deriveFor verknuepft aufloesbare Wiki-Links und meldet den Rest als unresolved', () => {
  const store = makeStore();
  const ziel = store.create('note', { title: 'Zweites Gehirn', body: '' });
  const quelle = store.create('note', { title: 'Start', body: 'Siehe [[Zweites Gehirn]] und [[Gibt Es Nicht]].' });

  const res = derive.deriveFor(store, quelle);
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0].data.to, ziel.id);
  assert.equal(res.created[0].data.kind, 'links-to');
  assert.equal(res.created[0].data.source, 'derived');
  assert.match(res.created[0].data.reason, /Zweites Gehirn/);
  assert.deepEqual(res.unresolved.filter((u) => u.kind === 'wiki').map((u) => u.text), ['Gibt Es Nicht']);
  // Cardinal rule: an unresolvable link creates NO placeholder record.
  assert.equal(store.count('note'), 2);
});

test('deriveFor ist idempotent', () => {
  const store = makeStore();
  store.create('note', { title: 'Ziel' });
  const quelle = store.create('note', { title: 'Quelle', body: 'Link auf [[Ziel]] #thema' });

  const first = derive.deriveFor(store, quelle);
  const before = outKinds(store, quelle.id);
  const second = derive.deriveFor(store, quelle);
  const third = derive.deriveFor(store, quelle);

  assert.equal(first.created.length, 1);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.updated, []);
  assert.deepEqual(third.created, []);
  assert.deepEqual(outKinds(store, quelle.id), before);
  assert.equal(store.count('edge'), 1);
});

test('manuelle Kanten ueberleben jede Ableitung -- die Kernregel', () => {
  const store = makeStore();
  const a = store.create('note', { title: 'A', body: 'zeigt auf [[B]]' });
  const b = store.create('note', { title: 'B' });
  const c = store.create('note', { title: 'C' });

  const manual = store.edges.add({ from: a.id, to: c.id, kind: 'links-to', source: 'manual', reason: 'von Hand' });
  const agentEdge = store.edges.add({ from: a.id, to: b.id, kind: 'related', source: 'agent', reason: 'Agent' });
  derive.deriveFor(store, a);
  // Even a manual edge that duplicates what derivation would produce stays.
  const manualTwin = store.edges.add({ from: a.id, to: b.id, kind: 'mentions', source: 'manual' });

  // Text gone: the derived link must go, the manual ones must not.
  const updated = store.update(a.id, { body: 'kein Link mehr' });
  const res = derive.deriveFor(store, updated);

  assert.equal(res.removed.length, 1);
  assert.equal(res.removed[0].data.kind, 'links-to');
  assert.equal(res.removed[0].data.to, b.id);
  assert.ok(store.get(manual.id), 'manuelle Kante geloescht');
  assert.ok(store.get(manualTwin.id), 'manueller Zwilling geloescht');
  assert.ok(store.get(agentEdge.id), 'Agenten-Kante geloescht');
  assert.deepEqual(
    outKinds(store, a.id),
    [`links-to:${c.id}:manual`, `mentions:${b.id}:manual`, `related:${b.id}:agent`].sort(),
  );
});

test('eine manuelle Kante auf demselben Schluessel wird gemeldet, nicht beansprucht', () => {
  const store = makeStore();
  const ziel = store.create('note', { title: 'Ziel' });
  const quelle = store.create('note', { title: 'Quelle', body: '[[Ziel]]' });
  // The user drew exactly the link derivation would want, with their own reason.
  const manual = store.edges.add({
    from: quelle.id, to: ziel.id, kind: 'links-to', source: 'manual', reason: 'meine eigene Verbindung',
  });

  const first = derive.deriveFor(store, quelle);
  assert.deepEqual(first.created, []);
  assert.equal(first.covered.length, 1);
  assert.equal(first.covered[0].id, manual.id);
  assert.equal(store.count('edge'), 1, 'keine zweite Kante auf demselben Schluessel');

  const second = derive.deriveFor(store, quelle);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.updated, []);
  assert.equal(store.get(manual.id).data.reason, 'meine eigene Verbindung', 'Begruendung des Nutzers bleibt');
  assert.equal(store.get(manual.id).data.source, 'manual');

  // And when the text disappears, the user's edge still stays.
  const cleared = store.update(quelle.id, { body: '' });
  const third = derive.deriveFor(store, cleared);
  assert.deepEqual(third.removed, []);
  assert.ok(store.get(manual.id));
});

test('deriveFor loest Titel case-insensitiv und umlaut-tolerant auf', () => {
  const store = makeStore();
  const ziel = store.create('note', { title: 'Überblick Ökosystem' });
  const quelle = store.create('note', { title: 'Q', body: 'siehe [[ueberblick oekosystem]] und [[ÜBERBLICK ÖKOSYSTEM]]' });
  const res = derive.deriveFor(store, quelle);
  assert.equal(res.created.length, 1, 'beide Schreibweisen sind derselbe Link');
  assert.equal(res.created[0].data.to, ziel.id);
});

test('deriveFor nutzt bei [[Titel|Alias]] den Titel und kennt Entitaets-Aliase', () => {
  const store = makeStore();
  const ziel = store.create('note', { title: 'Langer Titel' });
  const entity = store.create('entity', { name: 'Kubernetes', aliases: ['k8s'] });
  const quelle = store.create('note', { title: 'Q', body: '[[Langer Titel|kurz]] und [[k8s]]' });
  const res = derive.deriveFor(store, quelle);
  const targets = res.created.map((e) => e.data.to).sort();
  assert.deepEqual(targets, [ziel.id, entity.id].sort());
});

test('Tags werden nur zu Kanten, wenn es die Entitaet wirklich gibt', () => {
  const store = makeStore();
  const entity = store.create('entity', { name: 'Wissen' });
  const note = store.create('note', { title: 'N', body: 'Text #wissen #unbekannt', tags: ['Wissen'] });

  const res = derive.deriveFor(store, note);
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0].data.kind, 'tagged');
  assert.equal(res.created[0].data.to, entity.id);
  assert.deepEqual(res.unresolved.filter((u) => u.kind === 'tag').map((u) => u.text), ['unbekannt']);
  assert.equal(store.count('entity'), 1, 'kein Karteileichen-Entity angelegt');
});

test('Containment-Kanten folgen den Daten und wandern mit', () => {
  const store = makeStore();
  const p1 = store.create('project', { name: 'Projekt Eins' });
  const p2 = store.create('project', { name: 'Projekt Zwei' });
  const task = store.create('task', { title: 'Aufgabe', projectId: p1.id });
  const chat = store.create('chat', { title: 'Chat' });
  const msg = store.create('message', { chatId: chat.id, role: 'user', content: 'hallo' });
  const agent = store.create('agent', { name: 'Helfer' });
  const note = store.create('note', { title: 'Ergebnis' });
  const run = store.create('run', { agentId: agent.id, goal: 'Ziel', producedIds: [note.id] });

  derive.deriveFor(store, task);
  derive.deriveFor(store, msg);
  derive.deriveFor(store, run);

  assert.deepEqual(outKinds(store, task.id), [`belongs-to:${p1.id}:derived`]);
  assert.deepEqual(outKinds(store, msg.id), [`belongs-to:${chat.id}:derived`]);
  assert.deepEqual(outKinds(store, run.id), [`belongs-to:${agent.id}:derived`, `produced:${note.id}:derived`].sort());

  const moved = store.update(task.id, { projectId: p2.id });
  const res = derive.deriveFor(store, moved);
  assert.equal(res.created.length, 1);
  assert.equal(res.removed.length, 1);
  assert.deepEqual(outKinds(store, task.id), [`belongs-to:${p2.id}:derived`]);
});

test('ein geloeschter Datensatz verliert abgeleitete, nicht manuelle Kanten', () => {
  const store = makeStore();
  const ziel = store.create('note', { title: 'Ziel' });
  const quelle = store.create('note', { title: 'Quelle', body: '[[Ziel]]' });
  const manual = store.edges.add({ from: quelle.id, to: ziel.id, kind: 'related', source: 'manual' });
  derive.deriveFor(store, quelle);
  assert.equal(outKinds(store, quelle.id).length, 2);

  store.remove(quelle.id);
  const res = derive.deriveFor(store, quelle.id);
  assert.equal(res.removed.length, 1);
  assert.equal(res.removed[0].data.kind, 'links-to');
  assert.ok(store.get(manual.id), 'manuelle Kante ueberlebt den Tombstone');
  // Idempotent on tombstones too.
  assert.deepEqual(derive.deriveFor(store, quelle.id).removed, []);
});

test('ein geloeschtes Ziel laesst keine Kante ins Leere zurueck', () => {
  const store = makeStore();
  const ziel = store.create('note', { title: 'Ziel' });
  const quelle = store.create('note', { title: 'Quelle', body: '[[Ziel]]' });
  derive.deriveFor(store, quelle);
  store.remove(ziel.id);
  const res = derive.deriveFor(store, quelle);
  assert.equal(res.removed.length, 1);
  assert.deepEqual(outKinds(store, quelle.id), []);
  assert.deepEqual(res.unresolved.map((u) => u.text), ['Ziel']);
});

test('deriveFor haelt die Begruendung aktuell, ohne die Kante neu zu bauen', () => {
  const store = makeStore();
  const ziel = store.create('entity', { name: 'Ziel', aliases: ['Zweitname'] });
  const quelle = store.create('note', { title: 'Q', body: '[[Ziel]]' });
  const first = derive.deriveFor(store, quelle);
  const edgeId = first.created[0].id;

  const changed = store.update(quelle.id, { body: '[[Zweitname]]' });
  const res = derive.deriveFor(store, changed);
  assert.deepEqual(res.created, []);
  assert.deepEqual(res.removed, []);
  assert.equal(res.updated.length, 1);
  assert.equal(res.updated[0].id, edgeId, 'dieselbe Kante, nur neue Begruendung');
  assert.match(store.get(edgeId).data.reason, /Zweitname/);
});

test('deriveFor weist unbrauchbare Eingaben typisiert zurueck', () => {
  const store = makeStore();
  assert.throws(() => derive.deriveFor(store, 'note_gibtesnicht'), (err) => err.code === 'NOT_FOUND');
  assert.throws(() => derive.deriveFor(store, null), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => derive.deriveFor({}, 'x'), (err) => err.code === 'VALIDATION_FAILED');
});

test('scanAll repariert Links nach einer Umbenennung', () => {
  const store = makeStore();
  const quelle = store.create('note', { title: 'Quelle', body: 'siehe [[Neuer Name]]' });
  const ziel = store.create('note', { title: 'Alter Name' });

  let res = derive.scanAll(store);
  assert.equal(res.created, 0);
  assert.equal(res.unresolvedCount, 1);

  store.update(ziel.id, { title: 'Neuer Name' });
  res = derive.scanAll(store);
  assert.equal(res.created, 1);
  assert.equal(res.unresolvedCount, 0);
  assert.deepEqual(outKinds(store, quelle.id), [`links-to:${ziel.id}:derived`]);

  const progress = [];
  res = derive.scanAll(store, { onProgress: (p) => progress.push(p) });
  assert.equal(res.created, 0);
  assert.equal(res.removed, 0);
  assert.ok(progress.length > 0 && progress[progress.length - 1].scanned === res.scanned);
});

/* ------------------------------------------------------------ buildGraph */

function seedSmallGraph() {
  const store = makeStore();
  const hub = store.create('note', { title: 'Hub', body: '[[Blatt A]] [[Blatt B]] #thema', tags: ['thema'] });
  const a = store.create('note', { title: 'Blatt A', body: 'nichts', tags: ['thema'] });
  const b = store.create('note', { title: 'Blatt B', body: '[[Tief]]' });
  const tief = store.create('note', { title: 'Tief', body: 'ganz unten' });
  const einsam = store.create('note', { title: 'Einsam', body: 'ohne Verbindung' });
  derive.scanAll(store);
  return { store, hub, a, b, tief, einsam };
}

test('buildGraph liefert Knoten mit Label, Snippet, Tags und Grad', () => {
  const { store, hub } = seedSmallGraph();
  const g = view.buildGraph(store);
  const node = g.nodes.find((n) => n.id === hub.id);
  assert.equal(node.label, 'Hub');
  assert.equal(node.type, 'note');
  assert.deepEqual(node.tags, ['thema']);
  assert.equal(node.degree, 2);
  assert.equal(node.totalDegree, 2);
  assert.ok(node.snippet.includes('Blatt A'));
  assert.ok(node.updatedAt);
  assert.equal(node.pinned, false);
  assert.equal(g.nodes.length, 5);
  assert.equal(g.edges.length, 3);
  assert.equal(g.truncated, false);
  assert.equal(g.stats.candidates, 5);
  assert.deepEqual(g.stats.byKind, { 'links-to': 3 });
  for (const e of g.edges) {
    assert.ok(e.id && e.from && e.to && e.kind && e.source);
    assert.equal(typeof e.weight, 'number');
  }
});

test('buildGraph respektiert das Limit und sagt ehrlich truncated', () => {
  const { store } = seedSmallGraph();
  const g = view.buildGraph(store, { limit: 2 });
  assert.equal(g.nodes.length, 2);
  assert.equal(g.truncated, true);
  assert.equal(g.stats.candidates, 5);

  const full = view.buildGraph(store, { limit: 500 });
  assert.equal(full.truncated, false);
});

test('buildGraph folgt bei focus der Tiefenbegrenzung', () => {
  const { store, hub, b, tief } = seedSmallGraph();
  const d1 = view.buildGraph(store, { focus: hub.id, depth: 1 });
  assert.deepEqual(d1.nodes.map((n) => n.label).sort(), ['Blatt A', 'Blatt B', 'Hub']);
  assert.equal(d1.stats.focus, hub.id);
  assert.equal(d1.stats.depth, 1);

  const d2 = view.buildGraph(store, { focus: hub.id, depth: 2 });
  assert.ok(d2.nodes.some((n) => n.id === tief.id), 'Tiefe 2 erreicht den entfernten Knoten');
  assert.ok(!d2.nodes.some((n) => n.label === 'Einsam'));

  const near = view.buildGraph(store, { focus: b.id, depth: 1 });
  assert.deepEqual(near.nodes.map((n) => n.label).sort(), ['Blatt B', 'Hub', 'Tief']);

  const d0 = view.buildGraph(store, { focus: hub.id, depth: 0 });
  assert.equal(d0.nodes.length, 1);
  assert.equal(d0.edges.length, 0);
});

test('buildGraph meldet Kuerzung auch bei focus und kennt unbekannte Knoten nicht', () => {
  const { store, hub } = seedSmallGraph();
  const g = view.buildGraph(store, { focus: hub.id, depth: 2, limit: 2 });
  assert.equal(g.nodes.length, 2);
  assert.equal(g.truncated, true);
  assert.throws(() => view.buildGraph(store, { focus: 'note_gibtesnicht' }), (err) => err.code === 'NOT_FOUND');
});

test('buildGraph filtert Typen, Kantenarten, Waisen und Suchtext', () => {
  const { store, hub, einsam } = seedSmallGraph();
  const projekt = store.create('project', { name: 'Projekt' });
  store.edges.add({ from: hub.id, to: projekt.id, kind: 'belongs-to', source: 'manual' });

  const onlyNotes = view.buildGraph(store, { types: ['note'] });
  assert.ok(!onlyNotes.nodes.some((n) => n.type === 'project'));
  assert.ok(!onlyNotes.edges.some((e) => e.to === projekt.id));

  const onlyLinks = view.buildGraph(store, { kinds: ['links-to'] });
  assert.deepEqual(Object.keys(onlyLinks.stats.byKind), ['links-to']);

  const noOrphans = view.buildGraph(store, { includeOrphans: false });
  assert.ok(!noOrphans.nodes.some((n) => n.id === einsam.id));
  assert.ok(noOrphans.nodes.every((n) => n.degree > 0));

  const found = view.buildGraph(store, { query: 'ganz unten' });
  assert.deepEqual(found.nodes.map((n) => n.label), ['Tief']);
  assert.ok(!found.nodes[0].snippet.includes('\u0001'), 'Marker duerfen nicht durchsickern');
});

test('label beschriftet jeden Datensatztyp lesbar', () => {
  const store = makeStore();
  assert.equal(view.label(store.create('note', { title: 'Titel' })), 'Titel');
  assert.equal(view.label(store.create('project', { name: 'Name' })), 'Name');
  assert.equal(view.label(store.create('chat', {})), 'Neuer Chat');
  assert.equal(view.label(store.create('entity', { name: 'Begriff' })), 'Begriff');
  assert.match(view.label(store.create('message', { chatId: 'chat_x', role: 'user', content: 'Hallo Welt' })), /Hallo Welt/);
  assert.match(view.label(store.create('agent', { name: 'Agent' })), /Agent/);
  assert.match(view.label(store.create('run', { agentId: 'agent_x', goal: 'Ziel finden' })), /Ziel finden/);
  assert.equal(view.label(null), 'Unbekannt');
  const long = view.label(store.create('note', { title: 'x'.repeat(400) }));
  assert.ok(long.length <= 120);
});

/* -------------------------------------------------------------- clusters */

test('clusters findet Zusammenhangskomponenten und schlaegt Label vor', () => {
  const store = makeStore();
  const a = store.create('note', { title: 'Garten Beet', body: '[[Garten Erde]]', tags: ['garten'] });
  store.create('note', { title: 'Garten Erde', body: 'Humus', tags: ['garten'] });
  const c = store.create('note', { title: 'Server Backup', body: '[[Server Netz]]' });
  store.create('note', { title: 'Server Netz', body: 'Router' });
  store.create('note', { title: 'Alleine' });
  derive.scanAll(store);

  const g = view.buildGraph(store);
  const comps = view.clusters(g);
  assert.equal(comps.length, 3);
  assert.deepEqual(comps.map((c2) => c2.size), [2, 2, 1]);

  const garten = comps.find((k) => k.nodeIds.includes(a.id));
  assert.equal(garten.label, '#garten');
  assert.equal(garten.labelSource, 'tag');
  assert.equal(garten.edges, 1);

  const server = comps.find((k) => k.nodeIds.includes(c.id));
  assert.equal(server.label, 'Server');
  assert.equal(server.labelSource, 'begriff');

  const allein = comps.find((k) => k.size === 1);
  assert.equal(allein.label, 'Alleine');
  assert.equal(allein.labelSource, 'knoten');

  assert.deepEqual(view.clusters({ nodes: [], edges: [] }), []);
  assert.throws(() => view.clusters(null), (err) => err.code === 'VALIDATION_FAILED');
});

/* ---------------------------------------------------------- suggestLinks */

test('suggestLinks schlaegt vor, ohne zu verknuepfen', () => {
  const store = makeStore();
  const ziel = store.create('note', {
    title: 'Kompost im Garten',
    body: 'Kompost braucht Feuchtigkeit und Belueftung im Garten.',
    tags: ['garten', 'boden'],
  });
  const nah = store.create('note', {
    title: 'Erde und Boden',
    body: 'Guter Kompost verbessert die Belueftung der Erde.',
    tags: ['garten'],
  });
  const fern = store.create('note', { title: 'Steuererklaerung', body: 'Belege sortieren', tags: ['buero'] });
  const verbunden = store.create('note', { title: 'Schon verbunden', body: 'Kompost Garten Belueftung', tags: ['garten'] });
  store.edges.add({ from: ziel.id, to: verbunden.id, kind: 'links-to', source: 'manual' });

  const edgesBefore = store.count('edge');
  const out = view.suggestLinks(store, ziel.id, { limit: 5 });

  assert.equal(store.count('edge'), edgesBefore, 'ein Vorschlag darf nichts verknuepfen');
  assert.ok(out.length >= 1);
  assert.equal(out[0].id, nah.id);
  assert.ok(out[0].score > 0);
  assert.deepEqual(out[0].sharedTags, ['garten']);
  assert.ok(out[0].sharedTerms.length > 0);
  assert.match(out[0].reason, /gemeinsame/);
  assert.ok(!out.some((s) => s.id === verbunden.id), 'bereits verbundene Knoten sind kein Vorschlag');
  assert.ok(!out.some((s) => s.id === ziel.id), 'sich selbst nie vorschlagen');
  const weit = out.find((s) => s.id === fern.id);
  assert.ok(!weit || weit.score < out[0].score);

  assert.equal(view.suggestLinks(store, ziel.id, { limit: 1 }).length, 1);
  assert.throws(() => view.suggestLinks(store, 'note_gibtesnicht'), (err) => err.code === 'NOT_FOUND');
  const leer = store.create('note', { title: '' , body: ''});
  assert.deepEqual(view.suggestLinks(store, leer.id), []);
});

/* ------------------------------------------------------------ Skalierung */

test('2000 Knoten: Ableitung, Graph und Cluster bleiben schnell', () => {
  const store = makeStore();
  const N = 2000;
  const ids = [];
  for (let i = 0; i < N; i++) {
    ids.push(store.create('note', {
      title: `Knoten ${i}`,
      body: `Inhalt ${i} verweist auf [[Knoten ${(i + 1) % N}]] #gruppe${i % 20}`,
      tags: [`gruppe${i % 20}`],
    }).id);
  }
  for (let i = 0; i < 20; i++) store.create('entity', { name: `gruppe${i}` });

  const t0 = Date.now();
  const scan = derive.scanAll(store);
  const scanMs = Date.now() - t0;
  assert.equal(scan.scanned, N + 20);
  assert.equal(scan.created, N * 2, 'je Knoten ein Wiki-Link und ein Tag');

  const t1 = Date.now();
  const g = view.buildGraph(store, { limit: N, types: ['note'] });
  const buildMs = Date.now() - t1;
  assert.equal(g.nodes.length, N);
  assert.equal(g.edges.length, N, 'Ring aus N Kanten');
  assert.equal(g.truncated, false);

  const t2 = Date.now();
  const comps = view.clusters(g);
  const clusterMs = Date.now() - t2;
  assert.equal(comps.length, 1, 'der Ring ist eine einzige Komponente');
  assert.equal(comps[0].size, N);

  const t3 = Date.now();
  const focused = view.buildGraph(store, { focus: ids[0], depth: 3, kinds: ['links-to'] });
  const focusMs = Date.now() - t3;
  // BFS is undirected, so three steps reach three nodes in each direction.
  assert.equal(focused.nodes.length, 7, 'nur der Ring, drei Schritte weit');
  // Without the kind filter the shared tag entities act as hubs -- that is the
  // real topology, and the view must show it rather than hide it.
  const viaTags = view.buildGraph(store, { focus: ids[0], depth: 2, limit: 50 });
  assert.ok(viaTags.nodes.length > 7);
  assert.equal(viaTags.truncated, true);

  const t4 = Date.now();
  const sug = view.suggestLinks(store, ids[0], { limit: 5 });
  const sugMs = Date.now() - t4;
  assert.ok(sug.length > 0);

  // Generous budgets: they catch an accidental O(n^2), not a slow machine.
  assert.ok(scanMs < 8000, `scanAll zu langsam: ${scanMs}ms`);
  assert.ok(buildMs < 3000, `buildGraph zu langsam: ${buildMs}ms`);
  assert.ok(clusterMs < 1000, `clusters zu langsam: ${clusterMs}ms`);
  assert.ok(focusMs < 500, `focus zu langsam: ${focusMs}ms`);
  assert.ok(sugMs < 3000, `suggestLinks zu langsam: ${sugMs}ms`);
});

/* ------------------------------------------------- gegen die echte Engine */

test('gegen die echte Store-Engine: ableiten, idempotent, Graph bauen', async () => {
  const { home, cleanup } = tempHome('graph-engine');
  const { openStore } = require('../src/store/engine');
  const store = await openStore({ paths: path.join(home, 'nos'), lock: false });
  try {
    const ziel = store.create('note', { title: 'Zielnotiz', body: 'Inhalt', tags: ['thema'] });
    const quelle = store.create('note', { title: 'Quellnotiz', body: 'siehe [[Zielnotiz]] und [[Fehlt]]' });
    const manual = store.edges.add({ from: quelle.id, to: ziel.id, kind: 'related', source: 'manual' });

    const first = derive.deriveFor(store, quelle);
    assert.equal(first.created.length, 1);
    assert.equal(first.created[0].data.kind, 'links-to');
    assert.deepEqual(first.unresolved.map((u) => u.text), ['Fehlt']);

    const second = derive.deriveFor(store, quelle);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.removed, []);

    store.update(quelle.id, { body: 'ohne Link' });
    const third = derive.deriveFor(store, quelle.id);
    assert.equal(third.removed.length, 1);
    assert.ok(store.get(manual.id), 'manuelle Kante ueberlebt auch in der echten Engine');

    const g = view.buildGraph(store, { limit: 10 });
    assert.equal(g.nodes.length, 2);
    assert.equal(g.edges.length, 1);
    assert.equal(g.edges[0].source, 'manual');
    assert.equal(view.clusters(g).length, 1);

    const scan = derive.scanAll(store);
    assert.equal(scan.scanned, 2);
    assert.equal(scan.created, 0);
  } finally {
    await store.close();
    cleanup();
  }
});

test('als Bus-Listener verdrahtet wie in app.js: kein Kreislauf', async () => {
  const { home, cleanup } = tempHome('graph-bus');
  const { openStore } = require('../src/store/engine');
  const { Bus } = require('../src/kernel/bus');
  const bus = new Bus();
  const store = await openStore({ paths: path.join(home, 'nos'), bus, lock: false });
  let calls = 0;
  const rederive = (evt) => {
    const record = evt && evt.payload && evt.payload.record;
    if (!record || record.type === 'edge') return;
    calls++;
    derive.deriveFor(store, record);
  };
  bus.on('record.created', rederive);
  bus.on('record.updated', rederive);
  try {
    store.create('note', { title: 'Ziel' });
    const quelle = store.create('note', { title: 'Quelle', body: 'siehe [[Ziel]]' });
    // Derivation happens inside create(); an edge write must not re-enter it.
    assert.equal(calls, 2);
    assert.equal(store.edges.for(quelle.id, { direction: 'out' }).length, 1);

    store.update(quelle.id, { body: 'nichts mehr' });
    assert.equal(calls, 3);
    assert.equal(store.edges.for(quelle.id, { direction: 'out' }).length, 0);
    assert.equal(store.count('edge'), 0);
  } finally {
    await store.close();
    cleanup();
  }
});

test('gegen die echte Engine: Suche speist die Graph-Ansicht', async () => {
  const { home, cleanup } = tempHome('graph-search');
  const { openStore } = require('../src/store/engine');
  const store = await openStore({ paths: path.join(home, 'nos'), lock: false });
  try {
    store.create('note', { title: 'Bienenstock', body: 'Imkerei und Honig', tags: ['garten'] });
    store.create('note', { title: 'Steuerkram', body: 'Belege', tags: ['buero'] });
    const g = view.buildGraph(store, { query: 'Imkerei' });
    assert.equal(g.nodes.length, 1);
    assert.equal(g.nodes[0].label, 'Bienenstock');
    assert.ok(!/[\u0001\u0002]/.test(g.nodes[0].snippet));
  } finally {
    await store.close();
    cleanup();
  }
});

module.exports = { name: 'graph', tests: drain() };
