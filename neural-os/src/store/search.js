'use strict';

/**
 * Full-text search: inverted index + BM25, tuned for German.
 *
 * Why an index of our own instead of "just grep the records":
 * a linear scan over the vault is O(records x body length) per keystroke and
 * gives no ranking, so the twentieth note about the same topic buries the one
 * the user meant. An inverted index costs memory proportional to the vocabulary
 * (not the corpus) and turns a query into a handful of Map lookups.
 *
 * German-specific choices, all of which are the difference between "finds it"
 * and "user gives up":
 *  - Folding happens BEFORE diacritic stripping, because NFD-stripping "ä"
 *    yields "a", while German readers expect "ae" ("Bär" == "baer" == "Baer").
 *    So: NFC -> lowercase -> ae/oe/ue/ss expansion -> strip remaining marks.
 *  - German compounds are written closed ("Haushaltsgeraet"), so a query for
 *    "haushalt" must reach it. We do that at QUERY time via a prefix scan over
 *    the sorted vocabulary, scored at a discount, instead of indexing every
 *    prefix of every token (which multiplies the index by ~8x for no gain).
 *  - Tokens of length 1 are dropped (contract: min length 2). They are almost
 *    always noise ("a", "b", initials) and they dominate the postings lists.
 *
 * Scoring is BM25 with per-field weights folded into the term frequency
 * (a BM25F simplification): a hit in a title counts as several hits in a body.
 * Document length uses the same weighted counts so avgdl stays consistent.
 *
 * Snippets never contain HTML. Hits are wrapped in \u0001 / \u0002 and the UI
 * decides what those become; emitting markup here would make every consumer a
 * potential XSS sink. Control characters in the source text are scrubbed at
 * index time so user content cannot forge a marker.
 */

const DEFAULT_OPTS = {
  k1: 1.2,
  b: 0.75,
  minTokenLength: 2,
  /** Score multiplier for a compound/prefix hit vs. an exact term hit. */
  prefixDiscount: 0.4,
  /** A prefix shorter than this expands to half the vocabulary: not useful. */
  minPrefixLength: 3,
  /** Bound the cost of one pathological query ("a*"-style expansions). */
  maxPrefixExpansions: 32,
  /** Characters of context on each side of the best hit. */
  snippetRadius: 90,
  /** Weight of a satisfied "exact phrase" relative to a single term hit. */
  phraseWeight: 1.5,
};

/** Which fields feed the index, and how much a hit in them is worth. */
const FIELD_WEIGHTS = {
  note: { title: 3, tags: 2, body: 1 },
  chat: { title: 3, systemPrompt: 1 },
  message: { content: 1 },
  project: { name: 3, tags: 2, description: 1 },
  task: { title: 3, body: 1 },
  agent: { name: 3, description: 1, systemPrompt: 1 },
  file: { name: 3, tags: 2, text: 1 },
  entity: { name: 3, aliases: 2, description: 1 },
  memory: { text: 1, scope: 1 },
  run: { goal: 2, result: 1 },
};

/**
 * Never indexed, whatever the type: these carry credentials or opaque digests.
 * Indexing them would put secret material into a structure the UI can dump.
 */
const NEVER_INDEX = new Set(['hash', 'salt', 'token', 'wrappedKey', 'keyCheck', 'passphrase']);

const UMLAUTS = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss', 'æ': 'ae', 'ø': 'oe', 'å': 'aa', 'œ': 'oe' };
const UMLAUT_RE = /[äöüßæøåœ]/g;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
/** Strip C0 controls except tab/newline -- including our own hit markers. */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Case- and diacritic-folding with German expansion.
 * @param {string} s
 * @returns {string}
 */
function fold(s) {
  if (!s) return '';
  let out = s.normalize('NFC').toLowerCase();
  if (UMLAUT_RE.test(out)) {
    UMLAUT_RE.lastIndex = 0;
    out = out.replace(UMLAUT_RE, (ch) => UMLAUTS[ch]);
  }
  UMLAUT_RE.lastIndex = 0;
  return out.normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Tokenise, keeping the byte range of every token in the ORIGINAL string so a
 * snippet can highlight the text the user actually wrote, not the folded form.
 * @param {string} text
 * @param {number} minLength
 * @returns {Array<{term:string,start:number,end:number}>}
 */
function tokenSpans(text, minLength = 2) {
  const out = [];
  if (!text) return out;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const term = fold(m[0]);
    if (term.length >= minLength) out.push({ term, start: m.index, end: m.index + m[0].length });
    // Zero-length matches are impossible with '+', but guard against a hang.
    if (m.index === TOKEN_RE.lastIndex) TOKEN_RE.lastIndex++;
  }
  return out;
}

/** Folded tokens only. */
function tokenise(text, minLength = 2) {
  return tokenSpans(text, minLength).map((s) => s.term);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse the query language: free terms, "exact phrases", tag:, type:, -negated.
 * Unknown `word:` prefixes are treated as ordinary text rather than silently
 * dropped -- a user searching for "http://x" should not get an empty result.
 * @param {string} raw
 * @param {number} minLength
 */
function parseQuery(raw, minLength = 2) {
  const out = { terms: [], phrases: [], tags: [], types: [], negated: [], raw: String(raw || '') };
  let text = out.raw;

  // Phrases first, so their contents are not re-parsed as operators.
  text = text.replace(/"([^"]*)"/g, (_all, inner) => {
    const terms = tokenise(inner, minLength);
    if (terms.length) out.phrases.push(terms);
    return ' ';
  });

  for (const piece of text.split(/\s+/)) {
    if (!piece) continue;
    const lower = piece.toLowerCase();
    if (lower.startsWith('tag:') && piece.length > 4) {
      const tag = fold(piece.slice(4).replace(/^#/, ''));
      if (tag) out.tags.push(tag);
      continue;
    }
    if (lower.startsWith('type:') && piece.length > 5) {
      const t = piece.slice(5).toLowerCase().trim();
      if (t) out.types.push(t);
      continue;
    }
    if (piece.startsWith('-') && piece.length > 1) {
      for (const t of tokenise(piece.slice(1), minLength)) out.negated.push(t);
      continue;
    }
    // A bare '#tag' is how tags are written in note bodies; accept it too.
    if (piece.startsWith('#') && piece.length > 1) {
      const tag = fold(piece.slice(1));
      if (tag) out.tags.push(tag);
      continue;
    }
    for (const t of tokenise(piece, minLength)) out.terms.push(t);
  }
  return out;
}

/**
 * @param {object} [options]
 * @returns {object} SearchIndex
 */
function createSearchIndex(options = {}) {
  const opts = { ...DEFAULT_OPTS, ...(options || {}) };
  const fieldWeights = { ...FIELD_WEIGHTS, ...(options.fields || {}) };

  /** term -> Map<docId, weightedTf> */
  const postings = new Map();
  /** docId -> doc entry */
  const docs = new Map();
  /** foldedTag -> Set<docId> */
  const tagIndex = new Map();
  /** type -> Set<docId> */
  const typeIndex = new Map();

  let totalLength = 0;
  /** Sorted vocabulary, rebuilt lazily; only queries with prefixes need it. */
  let sortedTerms = null;

  function invalidateVocabulary() {
    sortedTerms = null;
  }

  function vocabulary() {
    if (sortedTerms === null) sortedTerms = Array.from(postings.keys()).sort();
    return sortedTerms;
  }

  /** Terms in the vocabulary starting with `prefix`, via binary search. */
  function expandPrefix(prefix) {
    const vocab = vocabulary();
    let lo = 0;
    let hi = vocab.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vocab[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < vocab.length; i++) {
      const term = vocab[i];
      if (!term.startsWith(prefix)) break;
      if (term !== prefix) out.push(term);
      if (out.length >= opts.maxPrefixExpansions) break;
    }
    return out;
  }

  /** Collect the text of one field as a string, whatever shape it has. */
  function fieldText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(' ');
    if (isPlainObject(value)) return Object.values(value).map(fieldText).filter(Boolean).join(' ');
    return '';
  }

  function scrub(text) {
    return text.replace(CONTROL_RE, ' ');
  }

  /**
   * Turn a record into the fields we index, with their weights.
   * Unknown types fall back to "every string-ish value in data", so a type
   * added later is searchable without touching this file.
   */
  function fieldsFor(record) {
    const data = isPlainObject(record.data) ? record.data : {};
    const spec = fieldWeights[record.type];
    const out = [];
    if (spec) {
      for (const [name, weight] of Object.entries(spec)) {
        const text = scrub(fieldText(data[name]));
        if (text.trim()) out.push({ name, weight, text });
      }
      return out;
    }
    for (const [name, value] of Object.entries(data)) {
      if (NEVER_INDEX.has(name)) continue;
      const text = scrub(fieldText(value));
      if (text.trim()) out.push({ name, weight: 1, text });
    }
    return out;
  }

  function buildDoc(record) {
    const fields = fieldsFor(record);
    const tf = new Map();
    const foldedParts = [];
    let length = 0;

    for (const field of fields) {
      const terms = tokenise(field.text, opts.minTokenLength);
      for (const term of terms) {
        tf.set(term, (tf.get(term) || 0) + field.weight);
        length += field.weight;
      }
      if (terms.length) foldedParts.push(terms.join(' '));
    }

    const tags = new Set();
    const rawTags = record.data && Array.isArray(record.data.tags) ? record.data.tags : [];
    for (const t of rawTags) {
      if (typeof t !== 'string') continue;
      const folded = fold(t.replace(/^#/, '').trim());
      if (folded) tags.add(folded);
    }

    return {
      id: record.id,
      type: record.type,
      updatedAt: record.updatedAt || record.createdAt || '',
      // Original text (scrubbed) for snippets; folded stream for phrase tests.
      text: fields.map((f) => f.text).join('\n'),
      folded: ` ${foldedParts.join(' ')} `,
      tf,
      length,
      tags,
    };
  }

  function indexDoc(doc) {
    docs.set(doc.id, doc);
    totalLength += doc.length;
    for (const [term, weight] of doc.tf) {
      let list = postings.get(term);
      if (!list) {
        list = new Map();
        postings.set(term, list);
        invalidateVocabulary();
      }
      list.set(doc.id, weight);
    }
    for (const tag of doc.tags) {
      let set = tagIndex.get(tag);
      if (!set) tagIndex.set(tag, (set = new Set()));
      set.add(doc.id);
    }
    let types = typeIndex.get(doc.type);
    if (!types) typeIndex.set(doc.type, (types = new Set()));
    types.add(doc.id);
  }

  function unindexDoc(id) {
    const doc = docs.get(id);
    if (!doc) return false;
    for (const term of doc.tf.keys()) {
      const list = postings.get(term);
      if (!list) continue;
      list.delete(id);
      if (list.size === 0) {
        postings.delete(term);
        invalidateVocabulary();
      }
    }
    for (const tag of doc.tags) {
      const set = tagIndex.get(tag);
      if (set) {
        set.delete(id);
        if (!set.size) tagIndex.delete(tag);
      }
    }
    const types = typeIndex.get(doc.type);
    if (types) {
      types.delete(id);
      if (!types.size) typeIndex.delete(doc.type);
    }
    totalLength -= doc.length;
    docs.delete(id);
    return true;
  }

  function add(record) {
    if (!record || typeof record.id !== 'string' || typeof record.type !== 'string') return false;
    if (docs.has(record.id)) unindexDoc(record.id);
    const doc = buildDoc(record);
    // A record with no indexable text still needs to exist for tag:/type:
    // queries, so we index it even when tf is empty.
    indexDoc(doc);
    return true;
  }

  function update(record) {
    return add(record);
  }

  function remove(id) {
    return unindexDoc(id);
  }

  function clear() {
    postings.clear();
    docs.clear();
    tagIndex.clear();
    typeIndex.clear();
    totalLength = 0;
    invalidateVocabulary();
  }

  function idf(df) {
    const n = docs.size;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Union the postings of a term and its compound expansions into one slot. */
  function buildSlot(term) {
    const hits = new Map();
    const exact = postings.get(term);
    if (exact) for (const [id, weight] of exact) hits.set(id, weight);
    if (term.length >= opts.minPrefixLength) {
      for (const expanded of expandPrefix(term)) {
        const list = postings.get(expanded);
        if (!list) continue;
        for (const [id, weight] of list) {
          hits.set(id, (hits.get(id) || 0) + weight * opts.prefixDiscount);
        }
      }
    }
    return hits;
  }

  /**
   * @param {string} text
   * @param {{types?:string[], limit?:number, offset?:number, tags?:string[]}} [queryOpts]
   * @returns {{items:Array<{id:string,score:number,snippet:string}>, total:number}}
   */
  function query(text, queryOpts = {}) {
    const limit = Number.isInteger(queryOpts.limit) && queryOpts.limit >= 0 ? queryOpts.limit : 30;
    const offset = Number.isInteger(queryOpts.offset) && queryOpts.offset >= 0 ? queryOpts.offset : 0;
    const parsed = parseQuery(text, opts.minTokenLength);

    // opts.types and `type:` both narrow: take the intersection, because a UI
    // filter must never be widened by something typed into the search box.
    const optionTypes = Array.isArray(queryOpts.types) && queryOpts.types.length
      ? queryOpts.types.map((t) => String(t).toLowerCase())
      : null;
    let allowedTypes = null;
    if (optionTypes && parsed.types.length) {
      allowedTypes = new Set(parsed.types.filter((t) => optionTypes.includes(t)));
    } else if (optionTypes) {
      allowedTypes = new Set(optionTypes);
    } else if (parsed.types.length) {
      allowedTypes = new Set(parsed.types);
    }

    const requiredTags = parsed.tags.slice();
    if (Array.isArray(queryOpts.tags)) for (const t of queryOpts.tags) requiredTags.push(fold(String(t)));

    const empty = { items: [], total: 0 };
    if (!parsed.terms.length && !parsed.phrases.length && !requiredTags.length && !allowedTypes) return empty;

    // --- candidate generation -------------------------------------------
    const slots = [];
    for (const term of parsed.terms) {
      const hits = buildSlot(term);
      if (hits.size) slots.push({ term, hits, idf: idf(hits.size) });
    }
    // Terms are OR-ed (a typo in one word should not empty the result), but if
    // NO term exists in the vocabulary the query is honestly empty rather than
    // degrading into "show everything".
    if (parsed.terms.length && !slots.length) return empty;

    let candidates = null;
    if (slots.length) {
      candidates = new Set();
      for (const slot of slots) for (const id of slot.hits.keys()) candidates.add(id);
    } else if (parsed.phrases.length) {
      // No free terms: seed from the rarest phrase token's postings.
      let seed = null;
      for (const phrase of parsed.phrases) {
        for (const term of phrase) {
          const list = postings.get(term);
          if (!list) return empty;
          if (!seed || list.size < seed.size) seed = list;
        }
      }
      if (!seed) return empty;
      candidates = new Set(seed.keys());
    } else if (requiredTags.length) {
      const sets = requiredTags.map((t) => tagIndex.get(t)).filter(Boolean);
      if (sets.length !== requiredTags.length) return empty;
      sets.sort((a, b) => a.size - b.size);
      candidates = new Set(sets[0]);
    } else if (allowedTypes) {
      candidates = new Set();
      for (const t of allowedTypes) {
        const set = typeIndex.get(t);
        if (set) for (const id of set) candidates.add(id);
      }
    }
    if (!candidates || !candidates.size) return empty;

    // --- filtering + scoring --------------------------------------------
    const avgdl = docs.size ? totalLength / docs.size : 1;
    const { k1, b } = opts;
    const phraseNeedles = parsed.phrases.map((terms) => ({ terms, needle: ` ${terms.join(' ')} ` }));
    const scored = [];

    for (const id of candidates) {
      const doc = docs.get(id);
      if (!doc) continue;
      if (allowedTypes && !allowedTypes.has(doc.type)) continue;
      if (requiredTags.length && !requiredTags.every((t) => doc.tags.has(t))) continue;
      if (parsed.negated.length && parsed.negated.some((t) => doc.tf.has(t))) continue;

      let ok = true;
      let phraseScore = 0;
      for (const phrase of phraseNeedles) {
        if (!doc.folded.includes(phrase.needle)) { ok = false; break; }
        for (const term of phrase.terms) {
          const list = postings.get(term);
          phraseScore += opts.phraseWeight * idf(list ? list.size : 0);
        }
      }
      if (!ok) continue;

      let score = phraseScore;
      const norm = k1 * (1 - b + (b * (doc.length || 1)) / (avgdl || 1));
      for (const slot of slots) {
        const tf = slot.hits.get(id);
        if (!tf) continue;
        score += slot.idf * ((tf * (k1 + 1)) / (tf + norm));
      }
      // A pure tag:/type: listing has no term score; rank it by recency.
      if (!slots.length && !phraseNeedles.length) score = 1;
      if (score <= 0 && !phraseNeedles.length && slots.length) continue;
      scored.push({ id, score, doc });
    }

    scored.sort((a, b2) => {
      if (b2.score !== a.score) return b2.score - a.score;
      if (a.doc.updatedAt !== b2.doc.updatedAt) return a.doc.updatedAt < b2.doc.updatedAt ? 1 : -1;
      return a.id < b2.id ? -1 : 1;
    });

    const total = scored.length;
    const page = scored.slice(offset, offset + limit);
    const items = page.map((hit) => ({
      id: hit.id,
      score: Number(hit.score.toFixed(6)),
      snippet: snippetFor(hit.doc, parsed),
    }));
    return { items, total };
  }

  /**
   * +/- `snippetRadius` characters around the densest cluster of hits, with
   * \u0001 / \u0002 around each matched token. Built from the ORIGINAL text so
   * the user recognises their own words.
   */
  function snippetFor(doc, parsed) {
    const radius = opts.snippetRadius;
    const text = doc.text || '';
    if (!text) return '';
    const spans = tokenSpans(text, opts.minTokenLength);
    if (!spans.length) return head(text, radius * 2);

    const marked = new Set();
    const exact = new Set(parsed.terms);
    const prefixes = parsed.terms.filter((t) => t.length >= opts.minPrefixLength);
    for (let i = 0; i < spans.length; i++) {
      const term = spans[i].term;
      if (exact.has(term) || prefixes.some((p) => term.startsWith(p))) marked.add(i);
    }
    for (const phrase of parsed.phrases) markPhrase(spans, phrase, marked);

    if (!marked.size) return head(text, radius * 2);

    // Pick the hit with the most neighbouring hits inside the window.
    const markedList = Array.from(marked).sort((a, b2) => a - b2);
    let best = markedList[0];
    let bestCount = -1;
    for (const idx of markedList) {
      const from = spans[idx].start - radius;
      const to = spans[idx].end + radius;
      let count = 0;
      for (const other of markedList) {
        if (spans[other].start >= from && spans[other].end <= to) count++;
      }
      if (count > bestCount) { bestCount = count; best = idx; }
    }

    let start = Math.max(0, spans[best].start - radius);
    let end = Math.min(text.length, spans[best].end + radius);
    start = snapBackwards(text, start);
    end = snapForwards(text, end);

    const inWindow = markedList.filter((i) => spans[i].start >= start && spans[i].end <= end);
    let out = text.slice(start, end);
    // Insert from the back so earlier offsets stay valid.
    for (let i = inWindow.length - 1; i >= 0; i--) {
      const span = spans[inWindow[i]];
      const s = span.start - start;
      const e = span.end - start;
      out = `${out.slice(0, s)}\u0001${out.slice(s, e)}\u0002${out.slice(e)}`;
    }
    out = out.replace(/\s+/g, ' ').trim();
    if (start > 0) out = `…${out}`;
    if (end < text.length) out = `${out}…`;
    return out;
  }

  function markPhrase(spans, phraseTerms, marked) {
    if (!phraseTerms.length) return;
    const n = phraseTerms.length;
    for (let i = 0; i + n <= spans.length; i++) {
      let hit = true;
      for (let j = 0; j < n; j++) {
        if (spans[i + j].term !== phraseTerms[j]) { hit = false; break; }
      }
      if (hit) for (let j = 0; j < n; j++) marked.add(i + j);
    }
  }

  function head(text, max) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, snapForwards(flat, max))}…`;
  }

  /** Move an offset back to the nearest whitespace so words stay whole. */
  function snapBackwards(text, offset) {
    if (offset <= 0) return 0;
    for (let i = offset; i > offset - 24 && i > 0; i--) {
      if (/\s/.test(text[i - 1])) return i;
    }
    return offset;
  }

  function snapForwards(text, offset) {
    if (offset >= text.length) return text.length;
    for (let i = offset; i < offset + 24 && i < text.length; i++) {
      if (/\s/.test(text[i])) return i;
    }
    return offset;
  }

  return {
    add,
    update,
    remove,
    clear,
    query,
    has: (id) => docs.has(id),
    size: () => docs.size,
    stats: () => ({
      documents: docs.size,
      terms: postings.size,
      tags: tagIndex.size,
      avgLength: docs.size ? totalLength / docs.size : 0,
    }),
  };
}

module.exports = { createSearchIndex, fold, tokenise, tokenSpans, parseQuery, FIELD_WEIGHTS };
