'use strict';

const assert = require('node:assert/strict');

const { test, drain } = require('./harness');
const { createSearchIndex, fold, tokenise, parseQuery } = require('../src/store/search');

const MARK_START = '\u0001';
const MARK_END = '\u0002';

let counter = 0;

/** Build a record envelope the index accepts, without going through the store. */
function rec(type, data, extra = {}) {
  counter += 1;
  const id = `${type}_${String(counter).padStart(24, '0').replace(/0/g, 'a')}`;
  const at = extra.updatedAt || `2026-01-01T00:00:${String(counter % 60).padStart(2, '0')}.000Z`;
  return { id, type, createdAt: at, updatedAt: at, deletedAt: null, rev: 1, data };
}

function note(title, body = '', tags = []) {
  return rec('note', { title, body, tags, pinned: false, source: 'user' });
}

function indexOf(records) {
  const index = createSearchIndex();
  for (const record of records) index.add(record);
  return index;
}

function markedTerms(snippet) {
  const out = [];
  const re = new RegExp(`${MARK_START}([^${MARK_END}]*)${MARK_END}`, 'g');
  let m;
  while ((m = re.exec(snippet)) !== null) out.push(m[1]);
  return out;
}

/* ------------------------------------------------------------- tokeniser */

test('folding handles umlauts, sharp s and diacritics the German way', () => {
  assert.equal(fold('Bär'), 'baer');
  assert.equal(fold('ÜBER'), 'ueber');
  assert.equal(fold('Straße'), 'strasse');
  assert.equal(fold('Strasse'), 'strasse');
  assert.equal(fold('Café'), 'cafe');
  assert.equal(fold('naïve Ñandú'), 'naive nandu');
  // Pre-composed and decomposed input must fold identically.
  assert.equal(fold('Mädchen'), fold('Mädchen'));
  assert.equal(fold('Mädchen'), 'maedchen');
});

test('tokenisation drops single characters and keeps digits', () => {
  assert.deepEqual(tokenise('Ein Test 2026 x!'), ['ein', 'test', '2026']);
  assert.deepEqual(tokenise('a b cd'), ['cd']);
  assert.deepEqual(tokenise(''), []);
  assert.deepEqual(tokenise('E-Mail-Adresse'), ['mail', 'adresse']);
});

test('the query language parses phrases, tag:, type: and negation', () => {
  const q = parseQuery('"rote katze" tag:Büro type:note -hund bericht');
  assert.deepEqual(q.phrases, [['rote', 'katze']]);
  assert.deepEqual(q.tags, ['buero']);
  assert.deepEqual(q.types, ['note']);
  assert.deepEqual(q.negated, ['hund']);
  assert.deepEqual(q.terms, ['bericht']);
  // A bare colon word that is not an operator stays searchable text.
  assert.deepEqual(parseQuery('http://example.com').terms, ['http', 'example', 'com']);
});

/* ------------------------------------------------------------- retrieval */

test('an exact term finds its document and nothing else', () => {
  const a = note('Backup-Strategie', 'Sicherung der Daten auf eine externe Platte.');
  const b = note('Kochrezept', 'Zwiebeln anbraten, dann ablöschen.');
  const index = indexOf([a, b]);

  const hits = index.query('sicherung');
  assert.equal(hits.total, 1);
  assert.equal(hits.items[0].id, a.id);
  assert.ok(hits.items[0].score > 0);
  assert.equal(index.query('kernfusion').total, 0, 'an unknown term must not invent hits');
  assert.deepEqual(index.query(''), { items: [], total: 0 });
  assert.deepEqual(index.query('   '), { items: [], total: 0 });
});

test('search is case-, umlaut- and diacritic-insensitive in both directions', () => {
  const a = note('Straßenbahn', 'Die Straße war gesperrt.');
  const index = indexOf([a]);
  for (const q of ['strasse', 'Straße', 'STRASSE', 'strassé']) {
    assert.equal(index.query(q).total, 1, `query ${q} must find the document`);
  }
});

test('German compounds are reachable by their prefix, at a discount', () => {
  const compound = note('Haushaltsgeraete', 'Ein Text über Geräte.');
  const exact = note('Haushalt', 'Der Haushalt und nochmal Haushalt.');
  const index = indexOf([compound, exact]);

  const hits = index.query('haushalt');
  assert.equal(hits.total, 2, 'the compound is found through its prefix');
  assert.equal(hits.items[0].id, exact.id, 'but the exact match still ranks first');
  // A two-letter prefix must NOT explode into the whole vocabulary.
  assert.equal(index.query('ha').total, 0);
});

test('BM25 ranks title hits above body hits and rare terms above common ones', () => {
  const inTitle = note('Quantenverschraenkung erklaert', 'Allgemeiner Text ohne Bezug.');
  const inBody = note('Physik-Notizen', 'Irgendwo steht auch Quantenverschraenkung im Fliesstext.');
  const filler = [];
  for (let i = 0; i < 20; i++) filler.push(note(`Notiz ${i}`, 'Allgemeiner Text ohne Bezug.'));
  const index = indexOf([inTitle, inBody, ...filler]);

  const hits = index.query('quantenverschraenkung');
  assert.equal(hits.total, 2);
  assert.equal(hits.items[0].id, inTitle.id, 'a title hit outweighs a body hit');

  const mixed = index.query('quantenverschraenkung allgemeiner');
  assert.equal(mixed.items[0].id, inTitle.id, 'the rare term dominates the common one');
});

test('multiple terms are OR-ed but documents matching more of them rank higher', () => {
  const both = note('Alpha Beta', 'Alpha und Beta zusammen.');
  const one = note('Nur Alpha', 'Alpha alleine.');
  const index = indexOf([both, one, note('Unbeteiligt', 'Gamma.')]);
  const hits = index.query('alpha beta');
  assert.equal(hits.total, 2);
  assert.equal(hits.items[0].id, both.id);
});

/* ------------------------------------------------------------- operators */

test('tag: filters and works on its own', () => {
  const a = note('Mit Tag', 'Inhalt', ['Büro', 'wichtig']);
  const b = note('Ohne Tag', 'Inhalt');
  const index = indexOf([a, b]);

  assert.equal(index.query('inhalt').total, 2);
  assert.equal(index.query('inhalt tag:buero').total, 1);
  assert.equal(index.query('inhalt tag:Büro').items[0].id, a.id, 'tags fold like everything else');
  assert.equal(index.query('tag:wichtig').total, 1, 'a tag alone is a valid query');
  assert.equal(index.query('tag:existiertnicht').total, 0);
  assert.equal(index.query('inhalt tag:buero tag:wichtig').total, 1, 'several tags are ANDed');
  assert.equal(index.query('#wichtig').total, 1, 'a bare #tag is accepted too');
});

test('type: filters, and an explicit types option can only narrow it further', () => {
  const n = note('Bericht', 'Quartalszahlen');
  const t = rec('task', { title: 'Bericht schreiben', status: 'todo', priority: 2, body: 'Quartalszahlen' });
  const index = indexOf([n, t]);

  assert.equal(index.query('quartalszahlen').total, 2);
  assert.equal(index.query('quartalszahlen type:note').total, 1);
  assert.equal(index.query('quartalszahlen type:note').items[0].id, n.id);
  assert.equal(index.query('quartalszahlen', { types: ['task'] }).total, 1);
  assert.equal(index.query('quartalszahlen type:note', { types: ['task'] }).total, 0,
    'the UI filter must never be widened by the search box');
  assert.equal(index.query('type:task').total, 1, 'a type alone lists that type');
});

test('an exact phrase is required, not merely preferred', () => {
  const ordered = note('Katzenbuch', 'Die rote Katze schlaeft auf dem Sofa.');
  const scrambled = note('Wortsalat', 'Die Katze ist rote Farbe egal.');
  const index = indexOf([ordered, scrambled]);

  assert.equal(index.query('rote katze').total, 2, 'loose terms match both');
  const phrase = index.query('"rote katze"');
  assert.equal(phrase.total, 1);
  assert.equal(phrase.items[0].id, ordered.id);
  assert.equal(index.query('"katze rote"').total, 0);
  assert.equal(index.query('"rote katze" tag:fehlt').total, 0, 'a phrase combines with filters');
  assert.equal(index.query('"schlaeft auf dem sofa"').total, 1, 'longer phrases work');
});

test('a negated term removes documents', () => {
  const withDog = note('Tierheim', 'Katze und Hund.');
  const catOnly = note('Katzenhaus', 'Nur eine Katze.');
  const index = indexOf([withDog, catOnly]);
  assert.equal(index.query('katze').total, 2);
  const hits = index.query('katze -hund');
  assert.equal(hits.total, 1);
  assert.equal(hits.items[0].id, catOnly.id);
});

/* -------------------------------------------------------------- snippets */

test('the snippet centres on the hit, marks it and stays bounded', () => {
  const filler = 'Dies ist Fuellmaterial ohne jede Bedeutung. '.repeat(20);
  const target = note('Langer Text', `${filler}Das gesuchte Stichwort steht mittendrin. ${filler}`);
  const index = indexOf([target]);

  const snippet = index.query('stichwort').items[0].snippet;
  assert.deepEqual(markedTerms(snippet), ['Stichwort'], 'the original spelling is preserved');
  assert.ok(snippet.includes('…'), 'truncation is shown honestly');
  assert.ok(snippet.length < 260, `snippet is ~2x90 chars, got ${snippet.length}`);
  assert.ok(!snippet.includes('\n'), 'snippets are single-line');
});

test('snippets never contain HTML, even when the record does', () => {
  const evil = note('Gefaehrlich', '<script>alert(1)</script> Das Geheimnis liegt hier.');
  const index = indexOf([evil]);
  const snippet = index.query('geheimnis').items[0].snippet;
  assert.ok(!/<mark|<\/mark|<b>|&lt;/.test(snippet), 'no markup is generated');
  assert.ok(snippet.includes('<script>'), 'source text is passed through verbatim, not escaped here');
  assert.deepEqual(markedTerms(snippet), ['Geheimnis']);
});

test('markers in user content cannot forge a highlight', () => {
  const forged = note('Angriff', `Alarm ${MARK_START}gefaelscht${MARK_END} und dann Ende.`);
  const index = indexOf([forged]);
  const snippet = index.query('ende').items[0].snippet;
  assert.equal((snippet.match(new RegExp(MARK_START, 'g')) || []).length, 1);
  assert.equal((snippet.match(new RegExp(MARK_END, 'g')) || []).length, 1);
  assert.deepEqual(markedTerms(snippet), ['Ende']);
});

test('every hit inside the window is marked, including a whole phrase', () => {
  const doc = note('Wiederholung', 'Alpha kommt hier vor und Alpha kommt gleich nochmal.');
  const index = indexOf([doc]);
  assert.deepEqual(markedTerms(index.query('alpha').items[0].snippet), ['Alpha', 'Alpha']);

  const phraseDoc = note('Phrase', 'Der rote Faden zieht sich durch den Text.');
  const phraseIndex = indexOf([phraseDoc]);
  assert.deepEqual(markedTerms(phraseIndex.query('"rote faden"').items[0].snippet), ['rote', 'Faden']);
});

test('a filter-only query still returns a readable snippet', () => {
  const doc = note('Nur getaggt', 'Ein kurzer Inhalt.', ['wichtig']);
  const index = indexOf([doc]);
  const snippet = index.query('tag:wichtig').items[0].snippet;
  assert.ok(snippet.length > 0);
  assert.ok(!snippet.includes(MARK_START), 'nothing was searched for, so nothing is highlighted');
});

test('a compound hit is highlighted at its real position', () => {
  const doc = note('Geraete', 'Wir reparieren Haushaltsgeraete seit 1998.');
  const index = indexOf([doc]);
  assert.deepEqual(markedTerms(index.query('haushalt').items[0].snippet), ['Haushaltsgeraete']);
});

/* ------------------------------------------------------- index lifecycle */

test('update re-indexes and remove makes a document unfindable', () => {
  const doc = note('Ursprung', 'Erster Inhalt.');
  const index = indexOf([doc]);
  assert.equal(index.query('erster').total, 1);

  index.update({ ...doc, data: { ...doc.data, body: 'Zweiter Inhalt.' }, rev: 2 });
  assert.equal(index.query('erster').total, 0, 'the old text is gone');
  assert.equal(index.query('zweiter').total, 1);
  assert.equal(index.size(), 1, 'updating must not duplicate the document');

  assert.equal(index.remove(doc.id), true);
  assert.equal(index.remove(doc.id), false);
  assert.equal(index.query('zweiter').total, 0);
  assert.equal(index.size(), 0);
  assert.equal(index.stats().terms, 0, 'emptied postings are released');
});

test('clear empties the index completely', () => {
  const index = indexOf([note('A', 'eins'), note('B', 'zwei', ['t'])]);
  index.clear();
  assert.equal(index.size(), 0);
  assert.equal(index.query('eins').total, 0);
  assert.equal(index.query('tag:t').total, 0);
  assert.deepEqual(index.stats(), { documents: 0, terms: 0, tags: 0, avgLength: 0 });
});

test('malformed input is refused rather than half-indexed', () => {
  const index = createSearchIndex();
  assert.equal(index.add(null), false);
  assert.equal(index.add({ id: 'x' }), false);
  assert.equal(index.add({ type: 'note', data: {} }), false);
  assert.equal(index.size(), 0);
  // A record with no indexable text is still addressable by type and tag.
  assert.equal(index.add(rec('note', { title: '', body: '', tags: ['leer'] })), true);
  assert.equal(index.query('tag:leer').total, 1);
});

test('limit and offset page through an honest total', () => {
  const docs = [];
  for (let i = 0; i < 12; i++) docs.push(note(`Eintrag ${i}`, 'Gemeinsamer Suchbegriff Traktor.'));
  const index = indexOf(docs);

  const first = index.query('traktor', { limit: 5 });
  assert.equal(first.total, 12);
  assert.equal(first.items.length, 5);

  const second = index.query('traktor', { limit: 5, offset: 5 });
  assert.equal(second.total, 12);
  assert.equal(second.items.length, 5);
  const overlap = first.items.filter((a) => second.items.some((b) => b.id === a.id));
  assert.equal(overlap.length, 0, 'pages must not repeat results');

  const tail = index.query('traktor', { limit: 5, offset: 10 });
  assert.equal(tail.items.length, 2);
  assert.equal(index.query('traktor', { limit: 5, offset: 99 }).items.length, 0);
});

test('results are deterministic when scores tie', () => {
  const docs = [];
  for (let i = 0; i < 6; i++) docs.push(note(`Gleich ${i}`, 'Identischer Text.'));
  const index = indexOf(docs);
  const a = index.query('identischer').items.map((h) => h.id);
  const b = index.query('identischer').items.map((h) => h.id);
  assert.deepEqual(a, b);
});

test('other record types are indexed through their own fields', () => {
  const index = createSearchIndex();
  index.add(rec('project', { name: 'Hausbau', description: 'Ein Projekt über Ziegel.', status: 'active', tags: [] }));
  index.add(rec('message', { chatId: 'chat_x', role: 'user', content: 'Wie lege ich Ziegel?' }));
  index.add(rec('entity', { name: 'Ziegel', kind: 'term', description: '', aliases: ['Backstein'] }));
  index.add(rec('memory', { text: 'Der Nutzer mag Ziegel.', scope: 'global', importance: 1 }));

  assert.equal(index.query('ziegel').total, 4);
  assert.equal(index.query('backstein').total, 1, 'aliases are indexed');
  assert.equal(index.query('ziegel type:message').total, 1);
});

/* -------------------------------------------------------------- capacity */

test('5000 documents index and query within a sane budget', () => {
  const words = ['Projekt', 'Notiz', 'Bericht', 'Übersicht', 'Straße', 'Messung', 'Analyse', 'Entwurf'];
  const index = createSearchIndex();
  const t0 = Date.now();
  for (let i = 0; i < 5000; i++) {
    index.add(note(
      `${words[i % words.length]} ${i}`,
      `Inhalt ${i} über ${words[(i + 3) % words.length]} und Haushaltsgeraete für den Alltag.`,
      i % 10 === 0 ? ['wichtig'] : ['routine'],
    ));
  }
  const indexMs = Date.now() - t0;
  assert.equal(index.size(), 5000);
  assert.ok(indexMs < 20000, `indexing took ${indexMs}ms`);

  const t1 = Date.now();
  const hits = index.query('haushalt', { limit: 10 });
  const queryMs = Date.now() - t1;
  assert.equal(hits.total, 5000);
  assert.equal(hits.items.length, 10);
  assert.ok(hits.items.every((h) => h.snippet.includes(MARK_START)));
  assert.ok(queryMs < 5000, `query took ${queryMs}ms`);

  assert.equal(index.query('tag:wichtig', { limit: 10000 }).total, 500);
  assert.equal(index.query('"über Analyse"', { limit: 10000 }).total > 0, true);
});

module.exports = { name: 'search', tests: drain() };
