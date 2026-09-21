'use strict';

/**
 * The detectors: what the system notices about a vault, without a model.
 *
 * Why model-free at all
 * ---------------------
 * Every one of these six is pure text and graph arithmetic. That is not a
 * compromise for want of a model, it is the point: they run on a laptop with
 * no GPU, in a few hundred milliseconds, with the same answer every time, and
 * they can explain themselves in one sentence a person can check. A language
 * model asked "which of my notes are duplicates?" produces a plausible list
 * that nobody can verify and that changes on the next run. Shingle overlap
 * produces a percentage you can argue with.
 *
 * Rules that hold for all of them
 * -------------------------------
 * 1. A detector READS. It never writes a record, never adds an edge, never
 *    touches the search index. Everything it wants to happen is described in
 *    `action` and waits for the user. `scan()` writing suggestion records is
 *    the only write in the whole subsystem.
 * 2. Every proposal carries a deterministic `key`. Two scans over an unchanged
 *    vault produce the same keys, which is what lets the engine refresh
 *    instead of duplicating and -- more importantly -- what lets a dismissed
 *    suggestion stay dismissed for ever.
 * 3. Nothing is inferred from prose. The `task` detector recognises markers a
 *    person deliberately typed; it does not read "ich sollte mal die Steuer
 *    machen" and invent a task. Guessing here is how an assistant becomes a
 *    thing you have to correct instead of a thing that helps.
 * 4. Text is normalised exactly like the search index normalises it (`fold`
 *    from `store/search`), and wiki links are extracted exactly like the graph
 *    extracts them (`extractLinks` from `graph/derive`). Both are required
 *    from those modules rather than reimplemented: a second normalisation
 *    would be a second, quietly disagreeing system, and the first time it
 *    disagreed the user would be told a link is broken that the graph has
 *    happily resolved.
 */

const crypto = require('node:crypto');

const { extractLinks, buildIndex } = require('../graph/derive');
const { fold } = require('../store/search');

const DAY_MS = 24 * 60 * 60 * 1000;

/* --------------------------------------------------------------- knobs */

/** Word-shingle length for the duplicate detector. */
const SHINGLE_K = 4;
/** Jaccard overlap from which two notes are worth showing as duplicates. */
const DUPLICATE_THRESHOLD = 0.72;
/**
 * Bottom-k sketch size. The k smallest shingle hashes are a *consistent*
 * sample: two documents that share most shingles share most of their bottom-k,
 * so a shared sketch entry is a cheap candidate signal. Eight is enough to
 * make a 0,72-overlap pair collide with near-certainty and small enough that
 * the inverted index stays a rounding error in memory.
 */
const SKETCH_SIZE = 8;
/**
 * A hash that lands in hundreds of sketches is boilerplate (a footer, a
 * template, a quoted signature). Pairing everything in such a bucket is how an
 * inverted index quietly becomes the O(n^2) it was built to avoid, so a large
 * bucket contributes only its first entries.
 */
const MAX_BUCKET = 40;

const ORPHAN_MIN_AGE_DAYS = 14;
const ORPHAN_NEIGHBOURS = 3;

const TAG_MIN_NEIGHBOURS = 2;
const TAG_MAX_TAGS = 3;

/** One checklist note must not flood a scan with its own backlog. */
const TASK_MAX_PER_NOTE = 20;

const REVISIT_MIN_AGE_DAYS = 90;
const REVISIT_MAX = 5;

/* ----------------------------------------------------------- small tools */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Normalise text for comparison: NFC, lower case, German folding
 * (ae/oe/ue/ss), combining marks stripped, whitespace collapsed.
 *
 * The first four steps are `fold`, borrowed from the search tokeniser on
 * purpose -- two notes count as duplicates exactly when search would treat
 * their words as the same words.
 *
 * @param {*} value
 * @returns {string}
 */
function normaliseText(value) {
  if (typeof value !== 'string' || !value) return '';
  return fold(value).replace(/\s+/gu, ' ').trim();
}

/** Word list of a normalised text, punctuation dropped. */
function wordsOf(text) {
  const out = [];
  const matches = normaliseText(text).match(/[\p{L}\p{N}]+/gu);
  if (matches) for (const word of matches) out.push(word);
  return out;
}

/** FNV-1a. Not cryptographic and does not need to be: it only buckets. */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Hashed word shingles of length `k`.
 * A text shorter than `k` words becomes one shingle of the whole text, so a
 * three-word note still compares against another three-word note instead of
 * silently having no features at all.
 *
 * @param {string[]} words
 * @param {number} [k]
 * @returns {Set<number>}
 */
function shingleSet(words, k = SHINGLE_K) {
  const out = new Set();
  if (!words.length) return out;
  if (words.length <= k) {
    out.add(hash32(words.join(' ')));
    return out;
  }
  for (let i = 0; i + k <= words.length; i++) out.add(hash32(words.slice(i, i + k).join(' ')));
  return out;
}

/** The `size` smallest hashes of a set, ascending. */
function sketchOf(shingles, size = SKETCH_SIZE) {
  return Array.from(shingles).sort((a, b) => a - b).slice(0, size);
}

/**
 * Candidate pairs from bottom-k sketches, via an inverted index.
 *
 * This is the whole reason the duplicate detector is affordable: the full
 * similarity is computed for pairs that share at least one sketch entry, not
 * for all n(n-1)/2 pairs. On a vault of unrelated notes the candidate set is
 * roughly empty; on a vault full of copies it is roughly the copies.
 *
 * @param {Array<number[]>} sketches one sketch per document, index = doc index
 * @returns {Array<[number,number]>} index pairs, i < j, each pair once
 */
function candidatePairs(sketches) {
  const buckets = new Map();
  for (let i = 0; i < sketches.length; i++) {
    for (const h of sketches[i]) {
      const list = buckets.get(h);
      if (list) {
        if (list.length < MAX_BUCKET) list.push(i);
      } else {
        buckets.set(h, [i]);
      }
    }
  }
  const seen = new Set();
  const pairs = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(i < j ? [i, j] : [j, i]);
      }
    }
  }
  return pairs;
}

/** Jaccard similarity of two sets, walking the smaller one. */
function jaccardOf(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const v of small) if (large.has(v)) shared++;
  return shared / (a.size + b.size - shared);
}

/** JSON with object keys sorted, so a key never depends on insertion order. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The identity of a proposal: its kind, the records it is *about*, and what it
 * would do. Deliberately not derived from title or wording -- those are allowed
 * to improve between releases without resurrecting suggestions the user already
 * threw away.
 *
 * Note that `subjectIds` are the identity-bearing ids only. The orphan
 * detector lists its three nearest notes in `recordIds`, and those move as the
 * vault grows; hashing them would make the same orphan a new suggestion every
 * week.
 *
 * @param {string} kind
 * @param {string[]} subjectIds
 * @param {object|null} action
 * @returns {string}
 */
function proposalKey(kind, subjectIds, action) {
  const ids = Array.from(new Set((subjectIds || []).filter((id) => typeof id === 'string' && id))).sort();
  const payload = stableStringify([kind, ids, action === undefined ? null : action]);
  return `${kind}:${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24)}`;
}

function titleOf(record) {
  const d = record && record.data ? record.data : {};
  if (typeof d.title === 'string' && d.title.trim()) return d.title.trim();
  if (typeof d.name === 'string' && d.name.trim()) return d.name.trim();
  return '';
}

function bodyOf(record) {
  const d = record && record.data ? record.data : {};
  return typeof d.body === 'string' ? d.body : '';
}

function tagsOf(record) {
  const d = record && record.data ? record.data : {};
  return Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
}

function clip(value, max) {
  const s = String(value === undefined || value === null ? '' : value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** German date, stable regardless of the machine's locale data. */
function germanDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unbekannt';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function daysBetween(fromIso, now) {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** Live notes, oldest first, so every scan sees the same order. */
function notesOf(store) {
  return store.list('note', { sort: 'createdAt', order: 'asc' }).items;
}

function degreeOf(store, id) {
  try {
    return store.edges.for(id, { direction: 'both' }).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------- duplicate */

function detectDuplicate(ctx) {
  const { store } = ctx;
  const notes = notesOf(store).filter((note) => titleOf(note) || bodyOf(note).trim());
  if (notes.length < 2) return [];

  // Two shingle sets per note, not one.
  //
  // Title and body together is the right signal for a long note. For a short
  // one it is the wrong one: "Espressomaschine entkalken" and
  // "Espressomaschine entkalken (Kopie)" with the SAME six-line body score
  // 0.55, because the extra title word pushes three shingles out of the
  // overlap -- and short quick-capture notes are exactly where a person
  // duplicates themselves most often. So the body is also compared on its
  // own, and the higher of the two scores counts. A note copied under a new
  // title is still a copy.
  const docs = notes.map((note) => {
    const shingles = shingleSet(wordsOf(`${titleOf(note)} ${bodyOf(note)}`));
    const bodyShingles = shingleSet(wordsOf(bodyOf(note)));
    return { note, shingles, bodyShingles, sketch: sketchOf(shingles), bodySketch: sketchOf(bodyShingles) };
  });

  /** pair key -> {a, b, score, why} -- so a pair found twice stays one proposal. */
  const found = new Map();
  const remember = (i, j, score, why) => {
    const a = docs[i].note;
    const b = docs[j].note;
    const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
    const current = found.get(key);
    if (current && current.score >= score) return;
    // Oldest first: the older note is the original, the younger one the copy,
    // and that order must not depend on which loop found the pair.
    const [first, second] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
    found.set(key, { a: first, b: second, score, why });
  };

  // Candidates from both sketches: a pair that only the bodies have in common
  // would otherwise never be scored at all.
  const candidates = new Map();
  for (const sketches of [docs.map((d) => d.sketch), docs.map((d) => d.bodySketch)]) {
    for (const [i, j] of candidatePairs(sketches)) candidates.set(`${i}:${j}`, [i, j]);
  }
  for (const [i, j] of candidates.values()) {
    const combined = jaccardOf(docs[i].shingles, docs[j].shingles);
    const bodyOnly = jaccardOf(docs[i].bodyShingles, docs[j].bodyShingles);
    const score = Math.max(combined, bodyOnly);
    if (score >= DUPLICATE_THRESHOLD) {
      remember(i, j, score, bodyOnly > combined ? 'body' : 'shingles');
    }
  }

  // Identical titles are their own signal. Two notes called "Meeting" with
  // completely different bodies share no shingles at all, and are still very
  // likely one thing the user wrote down twice.
  const byTitle = new Map();
  for (let i = 0; i < docs.length; i++) {
    const key = normaliseText(titleOf(docs[i].note));
    if (!key) continue;
    const list = byTitle.get(key);
    if (list) list.push(i);
    else byTitle.set(key, [i]);
  }
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    for (let b = 1; b < list.length && b <= MAX_BUCKET; b++) {
      remember(list[0], list[b], Math.max(0.9, jaccardOf(docs[list[0]].shingles, docs[list[b]].shingles)), 'title');
    }
  }

  const out = [];
  for (const { a, b, score, why } of found.values()) {
    const percent = Math.round(score * 100);
    let reason;
    if (why === 'title') {
      reason = `Beide Notizen tragen nach Normalisierung denselben Titel („${clip(titleOf(a), 60)}“); der Text stimmt zu ${percent} % überein.`;
    } else if (why === 'body') {
      reason = `Die Titel unterscheiden sich, aber ${percent} % der Vier-Wort-Ketten im Text sind identisch `
        + '(verglichen ohne Groß-/Kleinschreibung, Umlaute und Satzzeichen).';
    } else {
      reason = `${percent} % der Vier-Wort-Ketten sind identisch (verglichen ohne Groß-/Kleinschreibung, Umlaute und Satzzeichen).`;
    }
    const action = { op: 'link', from: a.id, to: b.id, kind: 'related', reason };
    out.push({
      kind: 'duplicate',
      key: proposalKey('duplicate', [a.id, b.id], action),
      title: `„${clip(titleOf(a) || 'Ohne Titel', 50)}“ und „${clip(titleOf(b) || 'Ohne Titel', 50)}“ sind fast gleich`,
      detail: `Die beiden Notizen überschneiden sich zu ${percent} %. „Übernehmen“ verknüpft sie als „verwandt“, mehr nicht. `
        + 'Zusammenführen musst du selbst entscheiden — dabei verschwindet Text unwiderruflich, und das ist keine Entscheidung, die ein Programm für dich treffen darf.',
      reason,
      recordIds: [a.id, b.id],
      action,
      confidence: Math.min(0.99, Math.round(score * 100) / 100),
    });
  }
  return out;
}

/* ---------------------------------------------------------------- orphan */

/**
 * The nearest notes by title, through the store's own BM25 index.
 * Returns `null` when the index cannot answer -- the difference between "keine
 * ähnliche Notiz" and "konnte nicht nachsehen" belongs in the detail text.
 */
function nearestByTitle(store, note, count) {
  const title = titleOf(note);
  if (!title || typeof store.search !== 'function') return null;
  // `type:` and quotes are query syntax in the search box; a title containing
  // them would silently turn into a filter instead of a query.
  const query = title.replace(/[:"#]/gu, ' ').trim();
  if (!query) return null;
  let result;
  try {
    result = store.search(query, { types: ['note'], limit: count + 3 });
  } catch {
    return null;
  }
  const out = [];
  for (const hit of result.items) {
    if (!hit.record || hit.record.id === note.id) continue;
    out.push(hit.record);
    if (out.length >= count) break;
  }
  return out;
}

function detectOrphan(ctx) {
  const { store, now } = ctx;
  const out = [];
  for (const note of notesOf(store)) {
    if (!bodyOf(note).trim()) continue;
    const age = daysBetween(note.createdAt, now);
    if (age < ORPHAN_MIN_AGE_DAYS) continue;
    if (degreeOf(store, note.id) > 0) continue;

    const nearest = nearestByTitle(store, note, ORPHAN_NEIGHBOURS);
    let hint;
    if (nearest === null) {
      hint = 'Welche Notizen inhaltlich passen, lässt sich hier gerade nicht ermitteln — der Suchindex steht nicht zur Verfügung.';
    } else if (!nearest.length) {
      hint = 'Es gibt keine Notiz, die vom Titel her erkennbar dazugehört; vielleicht fehlt der Zusammenhang wirklich noch.';
    } else {
      hint = `Am ehesten passen: ${nearest.map((r) => `„${clip(titleOf(r), 60)}“`).join(', ')}.`;
    }

    out.push({
      kind: 'orphan',
      key: proposalKey('orphan', [note.id], null),
      title: `„${clip(titleOf(note) || 'Ohne Titel', 60)}“ hängt ohne Verbindung im Graphen`,
      detail: `Seit ${age} Tagen zeigt keine Kante auf diese Notiz und sie zeigt auf keine. ${hint} `
        + 'Es gibt hier nichts automatisch zu übernehmen: nur du weißt, ob der Zusammenhang stimmt.',
      reason: `Angelegt am ${germanDate(note.createdAt)}, seitdem keine einzige Verknüpfung — weder eingehend noch ausgehend.`,
      recordIds: [note.id, ...(nearest || []).map((r) => r.id)],
      action: null,
      confidence: Math.min(0.85, 0.4 + age / 365),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------- tag */

function detectTag(ctx) {
  const { store } = ctx;
  const out = [];
  for (const note of notesOf(store)) {
    const own = tagsOf(note);
    if (own.length >= 2) continue;
    const ownKeys = new Set(own.map((t) => fold(t.replace(/^#/, ''))));

    let neighbours;
    try {
      neighbours = store.edges.neighbours(note.id, { depth: 1, limit: 60 }).nodes.filter((n) => n.id !== note.id);
    } catch {
      continue; // node vanished between listing and walking
    }
    if (neighbours.length < TAG_MIN_NEIGHBOURS) continue;

    /** folded tag -> {label, holders:string[]} */
    const counted = new Map();
    for (const neighbour of neighbours) {
      for (const raw of new Set(tagsOf(neighbour).map((t) => t.trim().replace(/^#/, '')))) {
        const key = fold(raw);
        if (!key || ownKeys.has(key)) continue;
        const entry = counted.get(key);
        if (entry) entry.holders.push(neighbour.id);
        else counted.set(key, { label: raw, holders: [neighbour.id] });
      }
    }

    const shared = Array.from(counted.values())
      .filter((entry) => entry.holders.length >= TAG_MIN_NEIGHBOURS)
      .sort((a, b) => (b.holders.length - a.holders.length) || (a.label < b.label ? -1 : 1))
      .slice(0, TAG_MAX_TAGS);
    if (!shared.length) continue;

    const tags = shared.map((entry) => entry.label);
    const action = { op: 'addTags', recordId: note.id, tags };
    const list = tags.map((t) => `#${t}`).join(', ');
    const top = shared[0];
    out.push({
      kind: 'tag',
      key: proposalKey('tag', [note.id], action),
      title: `„${clip(titleOf(note) || 'Ohne Titel', 60)}“ könnte ${list} bekommen`,
      detail: `${top.holders.length} der ${neighbours.length} direkt verbundenen Einträge tragen #${top.label}, diese Notiz nicht. `
        + `„Übernehmen“ ergänzt ${list}; vorhandene Schlagwörter bleiben unangetastet.`,
      reason: shared
        .map((entry) => `#${entry.label} bei ${entry.holders.length} Nachbarn`)
        .join(', ') + '.',
      recordIds: [note.id, ...top.holders.slice(0, 5)],
      action,
      confidence: Math.min(0.9, 0.5 + top.holders.length * 0.1),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ task */

/**
 * Markers that mean "hier ist etwas zu tun" because somebody typed them on
 * purpose. Anchored to the start of a trimmed line: `TODO` in the middle of a
 * sentence is prose, and a half-sentence makes a terrible task title.
 *
 * `- [x]` is deliberately not here. A ticked box is done.
 */
const TASK_MARKERS = [
  { re: /^[-*+]\s+\[ \]\s*(.+)$/u, label: 'Kästchen „- [ ]“' },
  { re: /^@todo\s*:?\s+(.+)$/iu, label: 'Merker „@todo“' },
  { re: /^todo\s*:?\s+(.+)$/iu, label: 'Merker „TODO“' },
  { re: /^offen\s*:\s*(.+)$/iu, label: 'Merker „Offen:“' },
  { re: /^zu\s+tun\s*:\s*(.+)$/iu, label: 'Merker „Zu tun:“' },
];

function matchTaskLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const marker of TASK_MARKERS) {
    const m = marker.re.exec(trimmed);
    if (m) {
      const title = m[1].trim().replace(/\s+/gu, ' ');
      if (title) return { title: clip(title, 200), label: marker.label, line: trimmed };
    }
  }
  return null;
}

function detectTask(ctx) {
  const { store } = ctx;

  // Everything that already exists as a task, however it was created. Without
  // this the same checklist would be proposed again after the user has long
  // since turned it into tasks.
  const known = new Set();
  for (const task of store.all('task')) {
    const key = normaliseText(titleOf(task));
    if (key) known.add(key);
  }

  const out = [];
  for (const note of notesOf(store)) {
    const body = bodyOf(note);
    if (!body) continue;
    const lines = body.split('\n');
    let fromThisNote = 0;
    for (let i = 0; i < lines.length && fromThisNote < TASK_MAX_PER_NOTE; i++) {
      const hit = matchTaskLine(lines[i]);
      if (!hit) continue;
      const key = normaliseText(hit.title);
      if (!key || known.has(key)) continue;
      known.add(key); // also dedupes within one scan
      fromThisNote++;

      const projectId = typeof note.data.projectId === 'string' && note.data.projectId ? note.data.projectId : null;
      const action = { op: 'createTask', title: hit.title, sourceId: note.id, projectId };
      out.push({
        kind: 'task',
        key: proposalKey('task', [note.id], action),
        title: `Offene Aufgabe: ${clip(hit.title, 80)}`,
        detail: `Steht in „${clip(titleOf(note) || 'Ohne Titel', 60)}“ (Zeile ${i + 1}) als „${clip(hit.line, 120)}“. `
          + '„Übernehmen“ legt eine Aufgabe an; die Notiz bleibt unverändert.',
        reason: `Die Zeile beginnt mit einem ausdrücklichen Merker: ${hit.label}.`,
        recordIds: [note.id],
        action,
        confidence: 0.8,
      });
      if (out.length >= ctx.limit) return out;
    }
  }
  return out;
}

/* --------------------------------------------------------------- revisit */

function detectRevisit(ctx) {
  const { store, now } = ctx;
  const candidates = [];
  for (const note of notesOf(store)) {
    const age = daysBetween(note.updatedAt, now);
    if (age < REVISIT_MIN_AGE_DAYS) continue;
    const pinned = note.data.pinned === true;
    const degree = degreeOf(store, note.id);
    if (!pinned && degree < 2) continue;
    // A pinned note with no edges would score zero and never surface, although
    // pinning is the strongest signal the user ever gives about a note.
    candidates.push({ note, age, degree, pinned, score: age * Math.max(degree, 1) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.note.id < b.note.id ? -1 : 1));

  return candidates.slice(0, Math.min(REVISIT_MAX, ctx.limit)).map(({ note, age, degree, pinned }) => ({
    kind: 'revisit',
    key: proposalKey('revisit', [note.id], null),
    title: `„${clip(titleOf(note) || 'Ohne Titel', 60)}“ liegt seit ${Math.floor(age / 30)} Monaten unberührt`,
    detail: `Zuletzt geändert am ${germanDate(note.updatedAt)}. ${degree} Verknüpfung${degree === 1 ? '' : 'en'}`
      + `${pinned ? ', angeheftet' : ''}. Hier gibt es nichts zu übernehmen — lies sie noch einmal und entscheide selbst, `
      + 'ob sie noch stimmt.',
    reason: pinned
      ? `Angeheftet und seit ${age} Tagen nicht mehr geändert.`
      : `${degree} Verknüpfungen, aber seit ${age} Tagen nicht mehr geändert.`,
    recordIds: [note.id],
    action: null,
    confidence: Math.min(0.7, 0.3 + age / 730),
  }));
}

/* ------------------------------------------------------------------ link */

function detectLink(ctx) {
  const { store } = ctx;
  // The graph's own title table, built by the graph's own code. Anything it
  // resolves is a working link; anything it does not is a real gap.
  const index = buildIndex(store);

  /** folded target -> {target, subject, referrers:string[]} */
  const missing = new Map();
  for (const note of notesOf(store)) {
    const body = bodyOf(note);
    if (!body) continue;
    for (const target of extractLinks(body).wikiLinks) {
      const key = fold(target);
      if (!key || index.byTitle.has(key)) continue;
      const entry = missing.get(key);
      if (entry) {
        if (!entry.referrers.includes(note.id)) entry.referrers.push(note.id);
      } else {
        missing.set(key, { target, subject: note, referrers: [note.id] });
      }
    }
  }

  const out = [];
  for (const { target, subject, referrers } of missing.values()) {
    const sourceTitle = titleOf(subject) || 'Ohne Titel';
    const body = `Diese Notiz entstand aus einem Verweis in „${sourceTitle}“.\n\n`
      + `Dort steht [[${target}]], aber es gab noch keinen Eintrag mit diesem Titel.`;
    const action = { op: 'createNote', title: target, body, tags: [], linkFrom: subject.id };
    const others = referrers.length > 1 ? ` (und ${referrers.length - 1} weitere Notiz${referrers.length === 2 ? '' : 'en'})` : '';
    out.push({
      kind: 'link',
      key: proposalKey('link', [subject.id], action),
      title: `„${clip(target, 60)}“ wird verlinkt, gibt es aber nicht`,
      detail: `„${clip(sourceTitle, 60)}“${others} verweist mit [[${clip(target, 60)}]] ins Leere. `
        + '„Übernehmen“ legt die Notiz mit einem kurzen Hinweis an und verknüpft sie mit der Fundstelle.',
      reason: `Kein Eintrag trägt den Titel „${clip(target, 60)}“ — verglichen genau so, wie der Graph Wiki-Links auflöst.`,
      recordIds: [subject.id, ...referrers.slice(1, 6)],
      action,
      confidence: 0.7,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/* ------------------------------------------------------------- the table */

/**
 * @typedef {object} Detector
 * @property {string} kind
 * @property {string} label       short German name for the UI
 * @property {string} description one sentence, German, what it looks for
 * @property {string[]} [needs]   subsystems in `ctx` without which it declines
 * @property {(ctx:object)=>object[]} detect
 */

/** @type {Detector[]} */
const DETECTORS = [
  {
    kind: 'duplicate',
    label: 'Doppelte Notizen',
    description: 'Findet Notizen, die sich fast vollständig überschneiden, und schlägt vor, sie zu verknüpfen.',
    detect: detectDuplicate,
  },
  {
    kind: 'orphan',
    label: 'Verwaiste Notizen',
    description: 'Findet ältere Notizen ohne jede Verknüpfung und nennt die inhaltlich nächstgelegenen.',
    detect: detectOrphan,
  },
  {
    kind: 'tag',
    label: 'Fehlende Schlagwörter',
    description: 'Findet Notizen, deren Nachbarn im Graphen ein Schlagwort teilen, das hier fehlt.',
    detect: detectTag,
  },
  {
    kind: 'task',
    label: 'Aufgaben in Notizen',
    description: 'Findet ausdrückliche Merker wie „- [ ]“, „TODO:“ oder „Offen:“ und schlägt daraus Aufgaben vor.',
    detect: detectTask,
  },
  {
    kind: 'revisit',
    label: 'Zum Wiederlesen',
    description: 'Findet lange unberührte Notizen, die angeheftet oder gut verknüpft sind.',
    detect: detectRevisit,
  },
  {
    /**
     * Needs the graph, and declines without it rather than guessing: when the
     * graph subsystem is absent nothing resolves wiki links at all, so every
     * `[[Verweis]]` in the vault would look broken. Thousands of false alarms
     * are worse than an honest "kann ich hier nicht beurteilen".
     */
    kind: 'link',
    label: 'Leere Verweise',
    description: 'Findet [[Verweise]] auf Einträge, die es nicht gibt, und bietet an, sie anzulegen.',
    needs: ['graph'],
    detect: detectLink,
  },
];

const KINDS = DETECTORS.map((d) => d.kind);

module.exports = {
  DETECTORS,
  KINDS,
  proposalKey,
  normaliseText,
  wordsOf,
  shingleSet,
  sketchOf,
  candidatePairs,
  jaccardOf,
  matchTaskLine,
  SHINGLE_K,
  DUPLICATE_THRESHOLD,
  ORPHAN_MIN_AGE_DAYS,
  REVISIT_MIN_AGE_DAYS,
};
