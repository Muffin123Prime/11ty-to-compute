'use strict';

/**
 * Link derivation -- turning what the user wrote into graph structure.
 *
 * Design decisions that are not obvious from the code
 * ---------------------------------------------------
 * 1. **Manual edges are sacred.** This module only ever creates, updates or
 *    deletes edges with `source:'derived'` AND one of `OWNED_KINDS`. An edge a
 *    person drew (`source:'manual'`) or an agent proposed (`source:'agent'`) is
 *    never touched, not even when the text it seems to mirror is gone. The user
 *    owns their own connections; a machine that silently deletes them turns the
 *    graph into something you cannot trust.
 * 2. **Ownership is per source node.** `deriveFor(record)` reconciles exactly
 *    the derived OUT-edges of that one record. Incoming derived edges belong to
 *    whoever wrote the text that produced them. This is what makes the function
 *    idempotent and safe to call from a bus listener on every write.
 * 3. **Kind allow-list, not "everything derived".** Other subsystems may later
 *    write `derived-from` edges (a note distilled from a chat). Reconciling by
 *    `source` alone would delete their work on the next save, so we reconcile
 *    only the kinds this module actually produces.
 * 4. **No phantom records.** An unresolvable `[[wiki link]]` produces NOTHING
 *    -- no stub note, no placeholder entity. It is reported back as
 *    `unresolved` so the UI can ask "Notiz anlegen?". Auto-creating records
 *    from typos is how a knowledge base fills up with junk nobody deleted.
 * 5. **Code is not prose.** `extractLinks` masks fenced and inline code before
 *    it looks for anything. Without that, every `#include`, every `#!/bin/sh`
 *    and every CSS colour in a code example becomes a tag, and the tag cloud
 *    stops meaning anything.
 * 6. Folding is borrowed from the search tokeniser (`fold`) on purpose: a
 *    wiki link must resolve exactly when the same text would be found by
 *    search, umlauts and all. Two different normalisations would be two
 *    different systems.
 *
 * Known limitation, stated honestly: renaming a note does not retroactively
 * re-resolve links that pointed at its old title, because `deriveFor` only
 * looks at one record. `scanAll()` (exposed as POST /api/graph/rescan) is the
 * cure and is cheap enough to run on demand.
 */

const { NotFoundError, ValidationError } = require('../kernel/errors');
const { fold } = require('../store/search');

/** Edge kinds this module owns. Anything else is somebody else's data. */
const OWNED_KINDS = ['links-to', 'tagged', 'belongs-to', 'produced'];
const OWNED = new Set(OWNED_KINDS);

/**
 * Long-form fields scanned for `[[links]]` and `#tags`. Deliberately narrow:
 * chat messages and run transcripts churn constantly and would flood the graph
 * with edges the user never asked for.
 */
const TEXT_FIELDS = {
  note: ['body'],
  task: ['body'],
  event: ['body', 'location'],
  project: ['description'],
  entity: ['description'],
};

/** Records whose `data.tags` array feeds `tagged` edges. */
const TAG_FIELD = { note: 'tags', project: 'tags', file: 'tags' };

/** Title lookup priority. A `[[Titel]]` should mean the note first. */
const TITLE_TYPES = ['note', 'project', 'entity', 'task', 'event', 'file', 'chat', 'agent'];

/** Types reconciled by `scanAll` (includes types that only need cleanup). */
const SCAN_TYPES = ['note', 'task', 'event', 'project', 'entity', 'file', 'chat', 'agent', 'run', 'message'];

const KEY_SEP = '\u0000';

/* ------------------------------------------------------------------ text */

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const URL_RE = /\b(?:https?|ftp):\/\/[^\s<>"'`\\\])}]+/gi;
const WIKI_RE = /\[\[([^[\]\n]{1,300})\]\]/g;
/**
 * A tag is `#` + a letter + word-ish characters, and must not sit directly
 * behind a letter, digit, `#`, `&` or `/`. That single look-behind class kills
 * the three big false positives: `a#b`, HTML entities (`&#228;`) and URL
 * fragments that survived masking.
 */
const TAG_RE = /(^|[^\p{L}\p{N}_&#/])#(\p{L}[\p{L}\p{N}_\-/]{0,63})/gu;
const TRAILING_PUNCT_RE = /[.,;:!?'"»«]+$/;

function blanks(n) {
  return n > 0 ? ' '.repeat(n) : '';
}

/**
 * Replace fenced code blocks (``` or ~~~) with spaces, preserving length so
 * every later offset still points at the original text. An unclosed fence
 * swallows the rest of the document, which is what CommonMark does too.
 */
function maskFenced(text) {
  if (!text.includes('`') && !text.includes('~')) return text;
  const lines = text.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE_RE.exec(line);
    if (!fence) {
      if (m) {
        fence = { char: m[2][0], len: m[2].length };
        lines[i] = blanks(line.length);
      }
    } else {
      if (m && m[2][0] === fence.char && m[2].length >= fence.len && !m[3].trim()) fence = null;
      lines[i] = blanks(line.length);
    }
  }
  return lines.join('\n');
}

/**
 * Mask inline code spans. Follows the CommonMark rule that a run of N
 * backticks closes only on a run of exactly N, so `` `a` `` and ``` ``x` `` ```
 * both behave. Unmatched backticks stay literal text.
 */
function maskInlineCode(text) {
  if (!text.includes('`')) return text;

  // Index the backtick runs once instead of rescanning the text for every
  // opener. The naive version is quadratic on a note full of unmatched
  // backticks, and "somebody pasted weird text" must not stall a save.
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue;
    let j = i;
    while (j < text.length && text[j] === '`') j++;
    runs.push({ start: i, len: j - i });
    i = j - 1;
  }
  if (runs.length < 2) return text;

  const byLen = new Map();
  for (let idx = 0; idx < runs.length; idx++) {
    const list = byLen.get(runs[idx].len);
    if (list) list.push(idx);
    else byLen.set(runs[idx].len, [idx]);
  }
  const cursor = new Map();
  const chars = text.split('');
  let i = 0;
  while (i < runs.length) {
    const open = runs[i];
    const list = byLen.get(open.len);
    let c = cursor.get(open.len) || 0;
    while (c < list.length && list[c] <= i) c++;
    cursor.set(open.len, c);
    if (c >= list.length) { i++; continue; } // unmatched: literal backticks
    const close = runs[list[c]];
    blankRange(chars, open.start, close.start + close.len);
    i = list[c] + 1;
  }
  return chars.join('');
}

function blankRange(chars, start, end) {
  for (let p = start; p < end && p < chars.length; p++) {
    if (chars[p] !== '\n') chars[p] = ' ';
  }
}

/**
 * Extract the three link flavours from a piece of Markdown-ish text.
 *
 * Order matters: code first (so examples never leak), then URLs (so a `#`
 * fragment is not a tag), then wiki links (so `[[Foo #bar]]` is one link and
 * not a link plus a tag), then tags.
 *
 * @param {string} text
 * @returns {{wikiLinks:string[], tags:string[], urls:string[]}}
 *          `wikiLinks` are link TARGETS with any `|Alias` stripped; `tags` have
 *          no leading `#`. All three keep document order and are deduplicated
 *          case/umlaut-insensitively, first spelling wins.
 */
function extractLinks(text) {
  const empty = { wikiLinks: [], tags: [], urls: [] };
  if (typeof text !== 'string' || !text) return empty;

  let masked = maskInlineCode(maskFenced(text));

  const urls = [];
  const seenUrl = new Set();
  let chars = masked.split('');
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(masked)) !== null) {
    let raw = m[0].replace(TRAILING_PUNCT_RE, '');
    if (raw.length > 2048) raw = raw.slice(0, 2048);
    if (raw && !seenUrl.has(raw)) { seenUrl.add(raw); urls.push(raw); }
    blankRange(chars, m.index, m.index + m[0].length);
    if (m.index === URL_RE.lastIndex) URL_RE.lastIndex++;
  }
  masked = chars.join('');

  const wikiLinks = [];
  const seenWiki = new Set();
  chars = masked.split('');
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(masked)) !== null) {
    const target = m[1].split('|')[0].trim().replace(/\s+/g, ' ');
    const key = fold(target);
    if (target && key && !seenWiki.has(key)) { seenWiki.add(key); wikiLinks.push(target); }
    blankRange(chars, m.index, m.index + m[0].length);
    if (m.index === WIKI_RE.lastIndex) WIKI_RE.lastIndex++;
  }
  masked = chars.join('');

  const tags = [];
  const seenTag = new Set();
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(masked)) !== null) {
    const tag = m[2].replace(/[-/_]+$/, '');
    const key = fold(tag);
    if (tag && key && !seenTag.has(key)) { seenTag.add(key); tags.push(tag); }
    if (m.index === TAG_RE.lastIndex) TAG_RE.lastIndex++;
  }

  return { wikiLinks, tags, urls };
}

/* ----------------------------------------------------------------- index */

function titleOf(record) {
  const d = record && record.data ? record.data : {};
  if (typeof d.title === 'string' && d.title.trim()) return d.title.trim();
  if (typeof d.name === 'string' && d.name.trim()) return d.name.trim();
  return '';
}

/**
 * Build the title -> id lookup used to resolve `[[wiki links]]` and `#tags`.
 *
 * Built once per `deriveFor` call and reused across a whole `scanAll`, which is
 * the difference between O(n) and O(n^2) on a 2 000 record vault. Records are
 * walked oldest-first so a title collision always resolves to the same record
 * no matter when the scan runs.
 *
 * @param {object} store
 * @returns {{byTitle:Map<string,string>, byEntity:Map<string,string>, size:number}}
 */
function buildIndex(store) {
  const byTitle = new Map();
  const byEntity = new Map();
  for (const type of TITLE_TYPES) {
    let items;
    try {
      items = store.list(type, { sort: 'createdAt', order: 'asc' }).items;
    } catch {
      continue; // a store that does not know this type simply has none
    }
    for (const rec of items) {
      const keys = [];
      const title = titleOf(rec);
      if (title) keys.push(fold(title));
      if (type === 'entity' && Array.isArray(rec.data.aliases)) {
        for (const alias of rec.data.aliases) {
          if (typeof alias === 'string' && alias.trim()) keys.push(fold(alias.trim()));
        }
      }
      for (const key of keys) {
        if (!key) continue;
        if (!byTitle.has(key)) byTitle.set(key, rec.id);
        if (type === 'entity' && !byEntity.has(key)) byEntity.set(key, rec.id);
      }
    }
  }
  return { byTitle, byEntity, size: byTitle.size };
}


/**
 * The title index, kept alive between calls.
 *
 * `deriveFor` runs on every single write, and rebuilding the index each time
 * made a write O(number of notes): measured at 11 ms per record with 5 000
 * notes, which turned importing 5 000 records from 0,6 s into 28 s. At 50 000
 * notes it would be unusable.
 *
 * The cache is maintained incrementally and heals itself instead of trusting
 * its own contents: every hit is validated against the store, and an entry
 * that points at a deleted or renamed record triggers a rebuild. A stale index
 * would otherwise link a note to something that is no longer there -- a wrong
 * answer given quickly, which is worse than a slow right one.
 *
 * Keyed weakly, so a closed store is not kept alive by its index.
 */
const INDEX_CACHE = new WeakMap();

/** Drop the cached index for a store. Used by scanAll and after bulk imports. */
function invalidateIndex(store) {
  if (store && typeof store === 'object') INDEX_CACHE.delete(store);
}

/** Fold a title the same way the index keys do. */
function indexKey(value) {
  return value ? fold(String(value).trim()) : '';
}

/**
 * Index for `store`, built once and then kept current.
 * @param {object} store
 * @param {object} [record] the record being derived, upserted before use
 */
function indexFor(store, record) {
  let index = INDEX_CACHE.get(store);
  if (!index) {
    index = buildIndex(store);
    index.validate = true;
    INDEX_CACHE.set(store, index);
  }
  if (record) upsertIntoIndex(index, record);
  return index;
}

/**
 * Add or refresh one record's titles in a live index.
 *
 * `keysById` exists so a rename costs O(1) instead of a walk over the whole
 * index. Without it the upsert alone was 1,9 ms per write at 5 000 notes --
 * the same O(n)-per-write shape the cache was introduced to remove, just
 * moved one layer down.
 */
function upsertIntoIndex(index, record) {
  if (!record || !record.id || !TITLE_TYPES.includes(record.type)) return;
  if (!index.keysById) index.keysById = buildReverse(index);
  // Remove whatever this record used to be keyed under; a rename must not
  // leave its old title resolving to it.
  const previous = index.keysById.get(record.id);
  if (previous) {
    for (const key of previous) {
      if (index.byTitle.get(key) === record.id) index.byTitle.delete(key);
      if (index.byEntity.get(key) === record.id) index.byEntity.delete(key);
    }
    index.keysById.delete(record.id);
  }
  if (record.deletedAt) return;
  const keys = [];
  const title = titleOf(record);
  if (title) keys.push(indexKey(title));
  if (record.type === 'entity' && Array.isArray(record.data && record.data.aliases)) {
    for (const alias of record.data.aliases) {
      if (typeof alias === 'string' && alias.trim()) keys.push(indexKey(alias));
    }
  }
  const own = [];
  for (const key of keys) {
    if (!key) continue;
    if (!index.byTitle.has(key)) { index.byTitle.set(key, record.id); own.push(key); }
    if (record.type === 'entity' && !index.byEntity.has(key)) index.byEntity.set(key, record.id);
  }
  if (own.length) index.keysById.set(record.id, own);
  index.size = index.byTitle.size;
}

/** id -> keys, derived once from a freshly built index. */
function buildReverse(index) {
  const reverse = new Map();
  for (const [key, id] of index.byTitle) {
    const list = reverse.get(id);
    if (list) list.push(key);
    else reverse.set(id, [key]);
  }
  return reverse;
}

/**
 * Resolve a key through the index, proving the answer is still true.
 * A hit that no longer matches the store means the cache has drifted, so it is
 * thrown away and rebuilt rather than patched around.
 */
function lookupTitle(store, index, key) {
  const id = index.byTitle.get(key);
  if (!id) return null;
  if (!index.validate) return id;
  let record = null;
  try {
    record = store.get(id);
  } catch {
    record = null;
  }
  if (record && !record.deletedAt && indexKey(titleOf(record)) === key) return id;
  INDEX_CACHE.delete(store);
  const fresh = buildIndex(store);
  fresh.validate = true;
  INDEX_CACHE.set(store, fresh);
  Object.assign(index, fresh);
  return index.byTitle.get(key) || null;
}

/* ---------------------------------------------------------------- derive */

function resolveRecord(store, recordOrId) {
  if (typeof recordOrId === 'string') {
    const rec = store.get(recordOrId, { includeDeleted: true });
    if (!rec) throw new NotFoundError(`Record ${recordOrId}`);
    return rec;
  }
  if (!recordOrId || typeof recordOrId !== 'object' || typeof recordOrId.id !== 'string') {
    throw new ValidationError('deriveFor benoetigt einen Datensatz oder eine Datensatz-ID.');
  }
  // Always work from the stored version: a caller may hand us a stale copy.
  return store.get(recordOrId.id, { includeDeleted: true }) || recordOrId;
}

/**
 * Collect every derived edge that SHOULD exist for this record.
 * Pure: reads the store, writes nothing.
 */
function desiredEdges(store, record, index) {
  const wanted = new Map();
  const unresolved = [];
  const seenUnresolved = new Set();
  const data = record.data || {};

  const want = (to, kind, reason, weight = 1) => {
    if (typeof to !== 'string' || !to || to === record.id) return;
    const key = to + KEY_SEP + kind;
    if (!wanted.has(key)) wanted.set(key, { to, kind, reason, weight });
  };
  const miss = (kind, text) => {
    const key = kind + KEY_SEP + fold(text);
    if (seenUnresolved.has(key)) return;
    seenUnresolved.add(key);
    unresolved.push({ recordId: record.id, kind, text });
  };
  const live = (id) => (typeof id === 'string' && id ? store.get(id) : null);

  const inlineTags = [];
  for (const field of TEXT_FIELDS[record.type] || []) {
    const text = typeof data[field] === 'string' ? data[field] : '';
    if (!text) continue;
    const found = extractLinks(text);
    for (const title of found.wikiLinks) {
      const target = lookupTitle(store, index, fold(title));
      if (target && target !== record.id && live(target)) {
        want(target, 'links-to', `Wiki-Link [[${title}]] im Text`);
      } else if (!target) {
        miss('wiki', title);
      }
    }
    inlineTags.push(...found.tags);
  }

  const tagField = TAG_FIELD[record.type];
  const ownTags = tagField && Array.isArray(data[tagField]) ? data[tagField] : [];
  for (const raw of [...ownTags, ...inlineTags]) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/^#/, '');
    if (!tag) continue;
    const target = index.byEntity.get(fold(tag));
    if (target && target !== record.id && live(target)) {
      want(target, 'tagged', `Schlagwort #${tag}`);
    } else if (!target) {
      // Not an error: most tags simply have no entity yet. Reported so the UI
      // can offer to create one, never auto-created here.
      miss('tag', tag);
    }
  }

  if (record.type === 'task' && live(data.projectId)) {
    want(data.projectId, 'belongs-to', 'Aufgabe gehoert zu diesem Projekt');
  }
  if (record.type === 'message' && live(data.chatId)) {
    want(data.chatId, 'belongs-to', 'Nachricht aus diesem Chat');
  }
  // Ein Termin haengt an seinem Projekt und an dem Gespraech, aus dem die KI
  // ihn angelegt hat -- so zeigt das Gehirn, woher er kommt.
  if (record.type === 'event') {
    if (live(data.projectId)) want(data.projectId, 'belongs-to', 'Termin gehoert zu diesem Projekt');
    if (live(data.chatId)) want(data.chatId, 'mentions', 'Termin stammt aus diesem Chat');
  }
  if (record.type === 'run') {
    if (live(data.agentId)) want(data.agentId, 'belongs-to', 'Lauf dieses Agenten');
    if (Array.isArray(data.producedIds)) {
      for (const produced of data.producedIds) {
        if (live(produced)) want(produced, 'produced', 'Von diesem Lauf erzeugt');
      }
    }
  }

  return { wanted, unresolved };
}

function ownDerivedEdges(store, recordId) {
  let edges;
  try {
    edges = store.edges.for(recordId, { direction: 'out' });
  } catch {
    return [];
  }
  return edges.filter((e) => e.data && e.data.source === 'derived' && OWNED.has(e.data.kind));
}

/**
 * Reconcile the derived out-edges of one record.
 *
 * Idempotent by construction: it compares the set that SHOULD exist against
 * the set that DOES exist and only touches the difference. Calling it twice in
 * a row returns empty `created`/`removed`/`updated` the second time.
 *
 * @param {object} store
 * @param {object|string} recordOrId
 * @param {{index?:object}} [opts] pass a shared index when scanning many records
 * @returns {{created:object[], removed:object[], updated:object[], covered:object[],
 *            unresolved:Array<{recordId:string,kind:'wiki'|'tag',text:string}>,
 *            skipped:Array<{to:string,kind:string,error:string}>}}
 *          `covered` are existing manual/agent edges that already express a
 *          connection derivation wanted -- reported, never modified.
 */
function deriveFor(store, recordOrId, opts = {}) {
  if (!store || !store.edges || typeof store.edges.add !== 'function') {
    throw new ValidationError('deriveFor benoetigt einen Store mit edges-API.');
  }
  const record = resolveRecord(store, recordOrId);
  const created = [];
  const removed = [];
  const updated = [];
  const covered = [];
  const skipped = [];

  const existing = ownDerivedEdges(store, record.id);
  const byKey = new Map();
  for (const edge of existing) {
    const key = edge.data.to + KEY_SEP + edge.data.kind;
    // A duplicate behind one key can only come from an older bug or a manual
    // log edit; drop the extra instead of leaving an invisible twin behind.
    if (byKey.has(key)) {
      try { removed.push(store.edges.remove(edge.id)); } catch { /* already gone */ }
      continue;
    }
    byKey.set(key, edge);
  }

  // Edges are structure derived from content. A deleted record has no content,
  // so its derived edges must go -- while its manual edges survive the
  // tombstone and come back with it on restore.
  if (record.deletedAt) {
    for (const edge of byKey.values()) {
      try { removed.push(store.edges.remove(edge.id)); } catch { /* raced */ }
    }
    return { created, removed, updated, covered, unresolved: [], skipped };
  }

  const index = opts.index && opts.index.byTitle ? opts.index : indexFor(store, record);
  const { wanted, unresolved } = desiredEdges(store, record, index);

  for (const [key, spec] of wanted) {
    const current = byKey.get(key);
    if (current) {
      byKey.delete(key);
      // Keep the justification honest: the link may now come from different
      // words even though it points at the same record.
      if (current.data.reason !== spec.reason && typeof store.update === 'function') {
        try { updated.push(store.update(current.id, { reason: spec.reason })); } catch { /* not fatal */ }
      }
      continue;
    }
    try {
      const edge = store.edges.add({
        from: record.id,
        to: spec.to,
        kind: spec.kind,
        source: 'derived',
        reason: spec.reason,
        weight: spec.weight,
      });
      // The store dedupes on (from,to,kind), so this can hand back an edge the
      // USER drew. That connection is already expressed and belongs to them:
      // we neither claim to have created it nor rewrite its reason, and we
      // leave it out of our owned set so it is never reconciled away.
      if (edge.data.source === 'derived') created.push(edge);
      else covered.push(edge);
    } catch (err) {
      // A target deleted between index build and write, or a schema refusal.
      // Losing one derived edge must not abort the whole derivation.
      skipped.push({ to: spec.to, kind: spec.kind, error: (err && err.code) || 'ERROR' });
    }
  }

  for (const edge of byKey.values()) {
    try {
      removed.push(store.edges.remove(edge.id));
    } catch (err) {
      skipped.push({ to: edge.data.to, kind: edge.data.kind, error: (err && err.code) || 'ERROR' });
    }
  }

  return { created, removed, updated, covered, unresolved, skipped };
}

/**
 * Re-derive the whole vault. This is the repair tool: it fixes links that
 * became resolvable after a rename and drops links whose target is gone.
 *
 * @param {object} store
 * @param {{onProgress?:function, types?:string[], maxUnresolved?:number}} [opts]
 * @returns {{scanned:number, created:number, removed:number, updated:number,
 *            unresolved:object[], unresolvedCount:number, skipped:number, ms:number}}
 */
function scanAll(store, opts = {}) {
  const started = Date.now();
  invalidateIndex(store);
  const index = buildIndex(store);
  index.validate = false;
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types : SCAN_TYPES;
  const maxUnresolved = Number.isInteger(opts.maxUnresolved) ? opts.maxUnresolved : 500;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const records = [];
  for (const type of types) {
    try {
      // Tombstones are included on purpose: a deleted record still needs its
      // derived edges cleaned up, and that is exactly what deriveFor does.
      records.push(...store.list(type, { includeDeleted: true }).items);
    } catch { /* unknown type in this store */ }
  }

  let created = 0;
  let removed = 0;
  let updated = 0;
  let skipped = 0;
  let unresolvedCount = 0;
  const unresolved = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    try {
      const res = deriveFor(store, record, { index });
      created += res.created.length;
      removed += res.removed.length;
      updated += res.updated.length;
      skipped += res.skipped.length;
      unresolvedCount += res.unresolved.length;
      for (const u of res.unresolved) {
        if (unresolved.length < maxUnresolved) unresolved.push(u);
      }
    } catch (err) {
      skipped++;
      if (unresolved.length < maxUnresolved) {
        unresolved.push({ recordId: record.id, kind: 'error', text: (err && err.message) || 'unbekannt' });
      }
    }
    if (onProgress && (i % 25 === 0 || i === records.length - 1)) {
      try { onProgress({ scanned: i + 1, total: records.length, recordId: record.id }); } catch { /* caller's problem */ }
    }
  }

  return {
    scanned: records.length,
    created,
    removed,
    updated,
    unresolved,
    unresolvedCount,
    skipped,
    ms: Date.now() - started,
  };
}

module.exports = {
  invalidateIndex,
  extractLinks,
  deriveFor,
  scanAll,
  buildIndex,
  OWNED_KINDS,
  TEXT_FIELDS,
  SCAN_TYPES,
};
