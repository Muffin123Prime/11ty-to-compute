/**
 * universum.js -- die reinen Funktionen hinter dem Wissensuniversum.
 *
 * Was hier liegt, braucht keinen Browser: die Antworten des Servers
 * (Vertrag A und B, src/graph/universum.js) in EINE Form bringen, Brotkrumen
 * bauen, im Wissen suchen, eine Nachbarschaft bis Tiefe 2 ausrechnen -- und
 * ein Ersatz-Universum aus einem gewoehnlichen /api/graph-Bild, falls ein
 * aelterer Server die Universum-Route noch nicht kennt (404). Das ist kein
 * Fake: es rechnet dieselben Gruppen, nur im Browser und ohne Cache.
 *
 * Die Ansichten (views/graph.js, views/wissenskarte.js) und die Kachel
 * teilen sich von hier aus auch den Wortschatz der Arten, damit "Termin"
 * ueberall "Termin" heisst.
 */

/* ------------------------------------------------------------------ */
/* Wortschatz                                                          */
/* ------------------------------------------------------------------ */

export const TYPE_LABELS = {
  note: 'Notiz',
  chat: 'Chat',
  project: 'Projekt',
  task: 'Aufgabe',
  event: 'Termin',
  agent: 'Agent',
  file: 'Datei',
  entity: 'Begriff',
  run: 'Lauf',
};

export const TYPE_PLURALS = {
  note: 'Notizen',
  chat: 'Chats',
  project: 'Projekte',
  task: 'Aufgaben',
  event: 'Termine',
  agent: 'Agenten',
  file: 'Dateien',
  entity: 'Begriffe',
  run: 'Läufe',
};

/** Begriffe tragen eine Art: Person, Ort, Organisation, Thema, Begriff. */
export const KIND_LABELS = {
  person: 'Person',
  place: 'Ort',
  org: 'Organisation',
  topic: 'Thema',
  term: 'Begriff',
};

/** "Notiz", "Person", "Ort" -- die Art eines Knotens in einem Wort. */
export function artVon(node) {
  if (!node) return 'Eintrag';
  if (node.type === 'entity' && node.kind && KIND_LABELS[node.kind]) return KIND_LABELS[node.kind];
  return TYPE_LABELS[node.type] || 'Eintrag';
}

/** Wo ein Eintrag sich oeffnen laesst. */
export const OPEN_ROUTES = {
  note: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  file: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  entity: (id) => `#/notes?id=${encodeURIComponent(id)}`,
  chat: (id) => `#/chat?id=${encodeURIComponent(id)}`,
  project: (id) => `#/projects?id=${encodeURIComponent(id)}`,
  task: (id) => `#/projects?id=${encodeURIComponent(id)}`,
  event: (id) => `#/kalender?id=${encodeURIComponent(id)}`,
  agent: (id) => `#/agents?id=${encodeURIComponent(id)}`,
  run: (id) => `#/agents?id=${encodeURIComponent(id)}`,
};

/** Die Wurzel der Karte heisst immer so. */
export const WURZEL_NAME = 'Mein Wissen';

/** Unter so vielen Eintraegen gibt es keine Themen-Ebene: das Netz direkt. */
export const KLEIN_AB = 8;

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/** Fuer die Suche: Umlaute so, wie ein Deutscher sie tippt, ohne Akzente. */
export function fold(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Passt ein Suchtext zu einem Namen? Jedes Wort der Anfrage muss irgendwo
 * vorkommen -- "pflanzen licht" findet "Pflanzen brauchen Licht", auch in
 * anderer Reihenfolge.
 */
export function passt(query, ...haystacks) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const hay = haystacks.map((x) => fold(Array.isArray(x) ? x.join(' ') : x)).join(' ');
  return words.every((w) => hay.includes(w));
}

/* ------------------------------------------------------------------ */
/* Antworten des Servers                                               */
/* ------------------------------------------------------------------ */

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function farbeIndex(value) {
  const n = Math.trunc(num(value, -1));
  return n >= 0 && n < 8 ? n : 0;
}

function kindKarte(k) {
  if (!k || typeof k.id !== 'string') return null;
  return { id: k.id, name: String(k.name || 'Thema'), anzahl: num(k.anzahl), farbe: farbeIndex(k.farbe), quelle: k.quelle || null };
}

/**
 * Ebene 0 in einer Form, mit der die Ansicht zeichnet. Nimmt die Antwort von
 * GET /api/graph/universum?tiefe=0 (themen, verbindungen {von, zu, anzahl},
 * gesamt) -- und toleriert die englischen Schluessel eines Zwischenstands.
 * @returns {{themen:object[], verbindungen:Array<{from:string,to:string,anzahl:number}>, gesamt:{knoten:number,kanten:number,themen:number}}}
 */
export function normaliseEbene0(data) {
  const src = data && typeof data === 'object' ? data : {};
  const roh = Array.isArray(src.themen) ? src.themen : Array.isArray(src.topics) ? src.topics : [];
  const themen = [];
  const bekannt = new Set();
  for (const t of roh) {
    if (!t || typeof t.id !== 'string' || bekannt.has(t.id)) continue;
    bekannt.add(t.id);
    themen.push({
      id: t.id,
      name: String(t.name || t.label || 'Thema'),
      anzahl: num(t.anzahl, num(t.size)),
      farbe: farbeIndex(t.farbe),
      quelle: t.quelle || null,
      hub: typeof t.hub === 'string' ? t.hub : null,
      kanten: num(t.kanten),
      knoten: Array.isArray(t.knoten) ? t.knoten.filter((id) => typeof id === 'string') : [],
      kinder: (Array.isArray(t.kinder) ? t.kinder : []).map(kindKarte).filter(Boolean),
    });
  }
  const links = Array.isArray(src.verbindungen) ? src.verbindungen : Array.isArray(src.links) ? src.links : [];
  const verbindungen = [];
  for (const l of links) {
    if (!l) continue;
    const from = typeof l.von === 'string' ? l.von : l.from;
    const to = typeof l.zu === 'string' ? l.zu : l.to;
    if (!bekannt.has(from) || !bekannt.has(to) || from === to) continue;
    verbindungen.push({ from, to, anzahl: Math.max(1, num(l.anzahl, 1)) });
  }
  const g = src.gesamt && typeof src.gesamt === 'object' ? src.gesamt : {};
  const gesamt = {
    knoten: num(g.knoten, themen.reduce((s, t) => s + t.anzahl, 0)),
    kanten: num(g.kanten),
    themen: num(g.themen, themen.length),
  };
  return { themen, verbindungen, gesamt };
}

/**
 * Ebene 1: ein Thema mit Knoten und Kanten. Nimmt die Antwort von
 * GET /api/graph/universum?tiefe=1&thema=<id> (thema mit pfad, knoten,
 * kanten, gekuerzt).
 * @returns {{thema:object, pfad:Array<{id:string,name:string}>, nodes:object[], edges:object[], gekuerzt:boolean}}
 */
export function normaliseEbene1(data) {
  const src = data && typeof data === 'object' ? data : {};
  const t = src.thema && typeof src.thema === 'object' ? src.thema : {};
  const thema = {
    id: typeof t.id === 'string' ? t.id : '',
    name: String(t.name || t.label || 'Thema'),
    anzahl: num(t.anzahl),
    farbe: farbeIndex(t.farbe),
    quelle: t.quelle || null,
    hub: typeof t.hub === 'string' ? t.hub : null,
    eltern: typeof t.eltern === 'string' ? t.eltern : null,
    kinder: (Array.isArray(t.kinder) ? t.kinder : []).map(kindKarte).filter(Boolean),
  };
  const pfad = (Array.isArray(t.pfad) ? t.pfad : []).map(kindKarte).filter(Boolean);
  const rohKnoten = Array.isArray(src.knoten) ? src.knoten : Array.isArray(src.nodes) ? src.nodes : [];
  const nodes = [];
  const seen = new Set();
  for (const k of rohKnoten) {
    if (!k || typeof k.id !== 'string' || seen.has(k.id)) continue;
    seen.add(k.id);
    nodes.push({
      id: k.id,
      type: k.type || 'note',
      kind: k.kind || null,
      label: String(k.label || k.title || k.name || 'Ohne Titel'),
      tags: Array.isArray(k.tags) ? k.tags.map(String) : [],
      grad: num(k.grad, num(k.degree)),
      updatedAt: k.updatedAt || null,
      pinned: !!k.pinned,
      ausserhalb: !!k.ausserhalb,
      thema: typeof k.thema === 'string' ? k.thema : null,
      themen: Array.isArray(k.themen) ? k.themen : [],
      snippet: typeof k.snippet === 'string' ? k.snippet : '',
    });
  }
  const rohKanten = Array.isArray(src.kanten) ? src.kanten : Array.isArray(src.edges) ? src.edges : [];
  const edges = [];
  for (const e of rohKanten) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') continue;
    if (!seen.has(e.from) || !seen.has(e.to)) continue;
    edges.push({ id: e.id || `${e.from}>${e.to}`, from: e.from, to: e.to, kind: e.kind || 'related', source: e.source || 'manual', reason: e.reason || '' });
  }
  return { thema, pfad, nodes, edges, gekuerzt: !!src.gekuerzt };
}

/**
 * Brotkrumen: "Mein Wissen › Schule › Biologie". Der erste Eintrag hat keine
 * id (die Wurzel), die weiteren sind Themen von aussen nach innen.
 */
export function brotkrumen(pfad, thema) {
  const out = [{ id: null, name: WURZEL_NAME }];
  for (const p of pfad || []) if (p && p.id) out.push({ id: p.id, name: String(p.name || 'Thema') });
  if (thema && thema.id) out.push({ id: thema.id, name: String(thema.name || 'Thema') });
  return out;
}

/**
 * "Verknuepft mit" (GET /api/records/:id/verknuepft) in einer Form, die die
 * Karte zeigt. Faellt die Route aus, baut `verknuepftAusGraph` dasselbe aus
 * einem /api/graph-Umfeld -- dann ohne Vorschlaege.
 */
export function normaliseVerknuepft(data) {
  const src = data && typeof data === 'object' ? data : {};
  const zeile = (r) => (r && typeof r.id === 'string' ? {
    id: r.id,
    type: r.type || 'note',
    title: String(r.title || r.label || 'Ohne Titel'),
    kind: r.kind || 'related',
    reason: String(r.reason || ''),
    source: r.source || 'manual',
    edgeId: typeof r.edgeId === 'string' ? r.edgeId : null,
  } : null);
  const vorschlag = (v) => (v && typeof v.id === 'string' ? {
    id: v.id,
    type: v.type || 'note',
    title: String(v.title || v.label || 'Ohne Titel'),
    score: num(v.score),
    grund: String(v.grund || v.reason || ''),
  } : null);
  return {
    eingehend: (Array.isArray(src.eingehend) ? src.eingehend : []).map(zeile).filter(Boolean),
    ausgehend: (Array.isArray(src.ausgehend) ? src.ausgehend : []).map(zeile).filter(Boolean),
    vorschlaege: (Array.isArray(src.vorschlaege) ? src.vorschlaege : []).map(vorschlag).filter(Boolean),
    themen: (Array.isArray(src.themen) ? src.themen : []).map(kindKarte).filter(Boolean),
  };
}

export function verknuepftAusGraph(id, graph) {
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const eingehend = [];
  const ausgehend = [];
  for (const e of edges) {
    if (!e || (e.from !== id && e.to !== id) || e.from === e.to) continue;
    const other = byId.get(e.from === id ? e.to : e.from);
    if (!other) continue;
    (e.from === id ? ausgehend : eingehend).push({
      id: other.id, type: other.type || 'note', title: String(other.label || 'Ohne Titel'),
      kind: e.kind || 'related', reason: String(e.reason || ''), source: e.source || 'manual', edgeId: e.id || null,
    });
  }
  return { eingehend, ausgehend, vorschlaege: [], themen: [] };
}

/* ------------------------------------------------------------------ */
/* Suchen und Nachbarschaft                                            */
/* ------------------------------------------------------------------ */

/** Themen (und ihre Kinder), deren Name zur Anfrage passt -- groesste zuerst. */
export function sucheThemen(themen, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const out = [];
  for (const t of themen || []) {
    const kinder = (t.kinder || []).filter((k) => passt(q, k.name));
    if (passt(q, t.name) || kinder.length) out.push({ thema: t, kinder });
  }
  out.sort((a, b) => (passt(q, b.thema.name) - passt(q, a.thema.name)) || (b.thema.anzahl - a.thema.anzahl));
  return out;
}

/**
 * Knoten, deren Titel oder Schlagworte zur Anfrage passen. Zuerst der genau
 * so heissende Eintrag, dann die, deren Titel so anfaengt, dann der Rest --
 * innerhalb jeder Stufe die mit den meisten Linien zuerst. "Notiz 7" muss
 * "Notiz 7" finden, nicht "Notiz 17", nur weil die mehr Verbindungen hat.
 */
export function sucheKnoten(nodes, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const fq = fold(q);
  const stufe = (node) => {
    const fl = fold(node.label);
    return fl === fq ? 0 : fl.startsWith(fq) ? 1 : 2;
  };
  return (nodes || [])
    .filter((node) => passt(q, node.label, node.tags || []))
    .sort((a, b) => (stufe(a) - stufe(b))
      || ((b.grad || b.degree || 0) - (a.grad || a.degree || 0))
      || String(a.label).localeCompare(String(b.label), 'de'));
}

/**
 * Alle ids bis zur Tiefe `depth` um einen Knoten, ihn selbst eingeschlossen.
 * Fuer "Fokus": nur der gewaehlte Knoten und seine Nachbarn bis Tiefe 2.
 */
export function nachbarschaft(edges, id, depth = 2) {
  const adj = new Map();
  for (const e of edges || []) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') continue;
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  }
  const out = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) || []) {
        if (out.has(nb)) continue;
        out.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ersatz: das Universum im Browser                                    */
/* ------------------------------------------------------------------ */

/** Stabile Farbe je Name (djb2), Index 0-7 -- dieselbe Regel wie auf dem Server. */
export function farbeFuer(name) {
  let h = 5381;
  const s = fold(name || '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h % 8;
}

/** Arten, aus denen das Universum besteht: Agenten und Laeufe sind Betrieb, kein Wissen. */
export const UNIVERSUM_TYPEN = ['note', 'entity', 'project', 'task', 'event', 'file', 'chat'];

/**
 * Themen aus einem gewoehnlichen Graph-Bild, deterministisch:
 *   1. Schlagworte mit mindestens zwei Eintraegen (#biologie), groesste zuerst;
 *      ein Knoten gehoert zu seinem groessten Schlagwort.
 *   2. Projekte mit dem, was an ihnen haengt (belongs-to).
 *   3. Was noch ohne Thema ist, aber an einem Thema haengt, lagert sich an.
 *   4. Der Rest per Label Propagation, benannt nach dem Knoten mit den
 *      meisten Verbindungen; was nichts beruehrt, steht unter "Unverbunden".
 * Kinder eines Themas: Schlagworte darin mit mindestens zwei Eintraegen,
 * sobald es mindestens zwei davon gibt.
 */
export function universumLokal(graph) {
  const alle = (Array.isArray(graph && graph.nodes) ? graph.nodes : []).filter((n) => n && typeof n.id === 'string' && UNIVERSUM_TYPEN.includes(n.type));
  const ids = new Set(alle.map((n) => n.id));
  const edges = (Array.isArray(graph && graph.edges) ? graph.edges : []).filter((e) => e && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const nodes = alle.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map(nodes.map((n) => [n.id, new Map()]));
  for (const e of edges) {
    adj.get(e.from).set(e.to, (adj.get(e.from).get(e.to) || 0) + 1);
    adj.get(e.to).set(e.from, (adj.get(e.to).get(e.from) || 0) + 1);
  }
  const grad = (id) => adj.get(id).size;
  const haupt = new Map(); // id -> thema id
  const themen = new Map(); // id -> {id, name, quelle, mitglieder:Set, tag}
  const neuesThema = (id, name, quelle) => {
    const t = { id, name, quelle, mitglieder: new Set(), kinder: [] };
    themen.set(id, t);
    return t;
  };
  const zuordnen = (t, id) => {
    if (haupt.has(id)) return;
    haupt.set(id, t.id);
    t.mitglieder.add(id);
  };

  // 1. Schlagworte
  const tagCount = new Map();
  for (const n of nodes) for (const tag of new Set((n.tags || []).map((t) => fold(t).replace(/^#/, '')).filter(Boolean))) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
  const tags = [...tagCount.entries()].filter(([, c]) => c >= 2).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const tagName = new Map();
  for (const n of nodes) for (const t of n.tags || []) { const k = fold(t).replace(/^#/, ''); if (k && !tagName.has(k)) tagName.set(k, String(t).replace(/^#/, '')); }
  for (const [tag] of tags) {
    const t = neuesThema(`tag:${tag}`, `#${tagName.get(tag) || tag}`, 'tag');
    for (const n of nodes) if ((n.tags || []).some((x) => fold(x).replace(/^#/, '') === tag)) zuordnen(t, n.id);
    if (!t.mitglieder.size) themen.delete(t.id);
  }
  // 2. Projekte
  for (const n of nodes) {
    if (n.type !== 'project') continue;
    const t = themen.get(`projekt:${n.id}`) || neuesThema(`projekt:${n.id}`, n.label || 'Projekt', 'projekt');
    zuordnen(t, n.id);
    for (const e of edges) {
      if (e.kind !== 'belongs-to') continue;
      if (e.to === n.id) zuordnen(t, e.from);
      else if (e.from === n.id) zuordnen(t, e.to);
    }
    if (!t.mitglieder.size) themen.delete(t.id);
  }
  // 3. Anlagern, bis sich nichts mehr aendert (hoechstens vier Runden)
  for (let runde = 0; runde < 4; runde++) {
    let changed = 0;
    for (const n of nodes) {
      if (haupt.has(n.id)) continue;
      const count = new Map();
      for (const [nb, w] of adj.get(n.id)) { const t = haupt.get(nb); if (t) count.set(t, (count.get(t) || 0) + w); }
      let best = null;
      let bestN = 0;
      for (const [t, c] of count) if (c > bestN || (c === bestN && t < best)) { best = t; bestN = c; }
      if (best) { zuordnen(themen.get(best), n.id); changed++; }
    }
    if (!changed) break;
  }
  // 4. Label Propagation ueber den Rest
  const rest = nodes.filter((n) => !haupt.has(n.id));
  const label = new Map(rest.map((n) => [n.id, n.id]));
  const restIds = new Set(rest.map((n) => n.id));
  const order = rest.slice().sort((a, b) => (grad(b.id) - grad(a.id)) || (a.id < b.id ? -1 : 1));
  for (let runde = 0; runde < 8; runde++) {
    let changed = 0;
    for (const n of order) {
      const count = new Map();
      for (const [nb, w] of adj.get(n.id)) if (restIds.has(nb)) count.set(label.get(nb), (count.get(label.get(nb)) || 0) + w);
      if (!count.size) continue;
      let best = label.get(n.id);
      let bestN = count.get(best) || 0;
      for (const [l, c] of count) if (c > bestN || (c === bestN && l < best)) { best = l; bestN = c; }
      if (best !== label.get(n.id)) { label.set(n.id, best); changed++; }
    }
    if (!changed) break;
  }
  const gruppen = new Map();
  for (const n of rest) {
    const l = label.get(n.id);
    if (!gruppen.has(l)) gruppen.set(l, []);
    gruppen.get(l).push(n.id);
  }
  let unverbunden = null;
  for (const [, members] of [...gruppen.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : 1))) {
    const verbunden = members.filter((id) => grad(id) > 0);
    if (verbunden.length >= 2) {
      let hub = verbunden[0];
      for (const id of verbunden) if (grad(id) > grad(hub) || (grad(id) === grad(hub) && id < hub)) hub = id;
      const t = neuesThema(`gruppe:${hub}`, byId.get(hub).label || 'Gruppe', 'gruppe');
      for (const id of members) zuordnen(t, id);
    } else {
      if (!unverbunden) unverbunden = neuesThema('rest', 'Unverbunden', 'rest');
      for (const id of members) zuordnen(unverbunden, id);
    }
  }
  // Kinder: Schlagworte innerhalb eines Themas (nicht das eigene)
  for (const t of themen.values()) {
    const innen = new Map();
    for (const id of t.mitglieder) {
      for (const tag of new Set((byId.get(id).tags || []).map((x) => fold(x).replace(/^#/, '')).filter(Boolean))) {
        if (`tag:${tag}` === t.id) continue;
        innen.set(tag, (innen.get(tag) || 0) + 1);
      }
    }
    const kinder = [...innen.entries()].filter(([, c]) => c >= 2).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    if (kinder.length >= 2) {
      t.kinder = kinder.map(([tag, c]) => ({ id: `${t.id}/tag:${tag}`, name: `#${tagName.get(tag) || tag}`, anzahl: c, farbe: farbeFuer(`#${tag}`), quelle: 'tag', eltern: t.id, tag }));
    }
  }
  // Verbindungen zwischen Themen
  const zwischen = new Map();
  for (const e of edges) {
    const a = haupt.get(e.from);
    const b = haupt.get(e.to);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    zwischen.set(key, (zwischen.get(key) || 0) + 1);
  }
  const verbindungen = [...zwischen.entries()].map(([key, anzahl]) => { const [from, to] = key.split('\u0000'); return { from, to, anzahl }; })
    .sort((a, b) => (b.anzahl - a.anzahl) || (a.from < b.from ? -1 : 1));
  const wichtigste = (t) => [...t.mitglieder].sort((a, b) => (grad(b) - grad(a)) || (a < b ? -1 : 1)).slice(0, 5);
  const liste = [...themen.values()].sort((a, b) => (b.mitglieder.size - a.mitglieder.size) || (a.id < b.id ? -1 : 1)).slice(0, 40);
  return {
    themen: liste.map((t) => ({ id: t.id, name: t.name, anzahl: t.mitglieder.size, farbe: farbeFuer(t.name), quelle: t.quelle, hub: wichtigste(t)[0] || null, kanten: 0, knoten: wichtigste(t), kinder: t.kinder.map((k) => ({ id: k.id, name: k.name, anzahl: k.anzahl, farbe: k.farbe, quelle: k.quelle })) })),
    verbindungen,
    gesamt: { knoten: nodes.length, kanten: edges.length, themen: themen.size },
    // Fuer ebene1Lokal: die Zuordnung und die Rohdaten.
    _haupt: haupt,
    _themen: themen,
    _nodes: nodes,
    _edges: edges,
  };
}

/** Ebene 1 aus einem lokalen Universum: die Knoten des Themas plus Nachbarn ausserhalb. */
export function ebene1Lokal(u, themaId) {
  if (!u || !u._themen) return null;
  let t = u._themen.get(themaId);
  let mitglieder;
  let pfad = [];
  if (t) mitglieder = new Set(t.mitglieder);
  else {
    // Ein Kind "thema/tag:x": die Mitglieder des Elternthemas mit diesem Schlagwort.
    const cut = String(themaId).indexOf('/tag:');
    if (cut < 0) return null;
    const eltern = u._themen.get(themaId.slice(0, cut));
    const tag = themaId.slice(cut + 5);
    if (!eltern) return null;
    const kind = eltern.kinder.find((k) => k.id === themaId);
    if (!kind) return null;
    mitglieder = new Set([...eltern.mitglieder].filter((id) => (u._nodes.find((n) => n.id === id).tags || []).some((x) => fold(x).replace(/^#/, '') === tag)));
    pfad = [{ id: eltern.id, name: eltern.name }];
    t = { id: kind.id, name: kind.name, quelle: 'tag', kinder: [] };
  }
  const draussen = new Map();
  for (const e of u._edges) {
    const a = mitglieder.has(e.from);
    const b = mitglieder.has(e.to);
    if (a && !b) draussen.set(e.to, (draussen.get(e.to) || 0) + 1);
    else if (b && !a) draussen.set(e.from, (draussen.get(e.from) || 0) + 1);
  }
  const ausserhalb = [...draussen.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, 150).map(([id]) => id);
  const sichtbar = new Set([...mitglieder, ...ausserhalb]);
  const byId = new Map(u._nodes.map((n) => [n.id, n]));
  const nodes = [...mitglieder, ...ausserhalb].map((id) => ({ ...byId.get(id), ausserhalb: !mitglieder.has(id), thema: u._haupt.get(id) || null }));
  const edges = u._edges.filter((e) => sichtbar.has(e.from) && sichtbar.has(e.to) && (mitglieder.has(e.from) || mitglieder.has(e.to)));
  return {
    thema: { id: t.id, name: t.name, anzahl: mitglieder.size, farbe: farbeFuer(t.name), quelle: t.quelle, kinder: (t.kinder || []).map((k) => ({ id: k.id, name: k.name, anzahl: k.anzahl, farbe: k.farbe, quelle: k.quelle })), pfad },
    knoten: nodes,
    kanten: edges,
    gekuerzt: false,
  };
}

