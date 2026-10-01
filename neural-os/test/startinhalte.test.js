'use strict';

/**
 * Die Startinhalte: was eine frische KI zuerst liest.
 *
 * Anlass (01.10.2026): Die Einfuehrung sagte noch "Die KI ist Claude" und
 * "1. Claude verbinden" -- aus der Zeit, als Claude die einzige KI war. Der
 * Nutzer wollte den kostenlosen Gemini-Schluessel eingeben und fand nur den
 * Weg zu Claude. Seitdem:
 *   - eine frische KI bekommt die Einfuehrung mit Gemini zuerst;
 *   - eine alte Einfuehrung, die nie angefasst wurde, wird beim Start
 *     aufgefrischt (src/app.js startInhalteAuffrischen) -- mit derselben
 *     festen ID der Kante zwischen den beiden Notizen, damit zwei Sticks
 *     danach ohne zweite Fassungen koppeln;
 *   - was der Nutzer geaendert hat, bleibt.
 */

const assert = require('node:assert/strict');
const { test, tempHome } = require('./harness');
const {
  createApp, seedIfEmpty, startInhalteAuffrischen, startBasen, fruehereStartTexte, START_IDS,
} = require('../src/app');
const merge = require('../src/sync/merge');

async function mitApp(fn) {
  const { home, cleanup } = tempHome('nos-startinhalte');
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
  try {
    return await fn(app);
  } finally {
    await app.close().catch(() => {});
    cleanup();
  }
}

/** Ein Tresor, wie ihn die Fassung bis zum 01.10.2026 anlegte (dieselben IDs, die alten Texte). */
function altAnlegen(app) {
  const alt = fruehereStartTexte();
  const S = START_IDS;
  // Reihenfolge wie damals in seedIfEmpty: Einfuehrung vor ihrem Ziel, Aufgaben vor dem Projekt, Kanten zuletzt.
  app.store.create('note', alt[S.willkommen], { id: S.willkommen });
  app.store.create('note', alt[S.claude], { id: S.claude });
  app.store.create('task', alt[S.aufgabeClaude], { id: S.aufgabeClaude });
  app.store.create('task', { title: 'Gehirn ansehen', projectId: S.projekt }, { id: S.aufgabeGehirn });
  app.store.create('project', { name: 'Mein erstes Projekt', description: 'Ein Platz, um Notizen, Aufgaben und Chats zu einem Vorhaben zu bündeln.' }, { id: S.projekt });
  const kante = (id, from, to, kind, reason) => app.store.create('edge', { from, to, kind, source: 'derived', reason, weight: 1 }, { id });
  kante(S.kanteLink, S.willkommen, S.claude, 'links-to', 'Wiki-Link [[Claude verbinden]] im Text');
  kante(S.kanteClaude, S.aufgabeClaude, S.projekt, 'belongs-to', 'Aufgabe gehoert zu diesem Projekt');
  kante(S.kanteGehirn, S.aufgabeGehirn, S.projekt, 'belongs-to', 'Aufgabe gehoert zu diesem Projekt');
}

const linksVon = (app, id) => app.store.list('edge', { limit: 500 }).items.filter((e) => e.data.from === id && e.data.kind === 'links-to');

test('Eine frische KI liest zuerst: Gemini, kostenlos – Claude nur als Möglichkeit', async () => {
  await mitApp(async (app) => {
    assert.equal(await seedIfEmpty(app), true);
    const S = START_IDS;
    const will = app.store.get(S.willkommen).data;
    assert.match(will.body, /Die KI ist Gemini von Google, kostenlos/);
    assert.match(will.body, /\[\[KI verbinden\]\]/);
    assert.doesNotMatch(will.body, /Die KI ist Claude|Claude verbinden/);
    const anleitung = app.store.get(S.claude).data;
    assert.equal(anleitung.title, 'KI verbinden');
    assert.match(anleitung.body, /aistudio\.google\.com\/apikey/);
    assert.match(anleitung.body, /beginnt mit „AIza“/);
    assert.ok(anleitung.body.indexOf('Gemini') < anleitung.body.indexOf('Claude'), 'Gemini steht vor Claude');
    assert.equal(app.store.get(S.aufgabeClaude).data.title, 'KI verbinden');
    // Die feste Kante ist genau die, die die Ableitung selbst zoege.
    const links = linksVon(app, S.willkommen);
    assert.deepEqual(links.map((e) => [e.id, e.data.to, e.data.reason]), [[S.kanteLink, S.claude, 'Wiki-Link [[KI verbinden]] im Text']]);
    // Und jeder Startsatz hat genau den Fingerabdruck, den der Abgleich als gemeinsamen Ausgangsstand kennt.
    const basen = startBasen();
    for (const [id, h] of Object.entries(basen)) assert.equal(merge.fingerprint(app.store.get(id)), h, id);
    // Nichts mehr aufzufrischen.
    assert.deepEqual(await startInhalteAuffrischen(app), []);
  });
});

test('Eine alte, nie angefasste Einführung wird aufgefrischt – die Kante behält ihre feste ID', async () => {
  await mitApp(async (app) => {
    altAnlegen(app);
    await app.store.flush();
    const S = START_IDS;
    const vorher = linksVon(app, S.willkommen);
    assert.deepEqual(vorher.map((e) => e.id), [S.kanteLink], 'Ausgangslage: eine Kante mit fester ID');
    const neu = await startInhalteAuffrischen(app);
    assert.deepEqual(neu.sort(), [S.aufgabeClaude, S.claude, S.willkommen].sort());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(app.store.get(S.claude).data.title, 'KI verbinden');
    assert.match(app.store.get(S.willkommen).data.body, /\[\[KI verbinden\]\]/);
    assert.equal(app.store.get(S.aufgabeClaude).data.title, 'KI verbinden');
    const links = linksVon(app, S.willkommen);
    assert.deepEqual(links.map((e) => [e.id, e.data.reason]), [[S.kanteLink, 'Wiki-Link [[KI verbinden]] im Text']], 'dieselbe Kante, nur der Grund ist neu');
    const basen = startBasen();
    for (const [id, h] of Object.entries(basen)) assert.equal(merge.fingerprint(app.store.get(id)), h, `${id} entspricht den heutigen Startinhalten`);
    // Ein zweiter Start aendert nichts mehr.
    assert.deepEqual(await startInhalteAuffrischen(app), []);
  });
});

test('Was der Nutzer angefasst hat, bleibt – die Einführung nur zusammen mit ihrem Ziel', async () => {
  await mitApp(async (app) => {
    altAnlegen(app);
    const S = START_IDS;
    // Die Einfuehrung losgeheftet, die Aufgabe abgehakt: beides seine Aenderung.
    app.store.update(S.willkommen, { pinned: false });
    app.store.update(S.aufgabeClaude, { status: 'done' });
    await app.store.flush();
    assert.deepEqual(await startInhalteAuffrischen(app), [], 'nichts angefasst, was er geaendert hat');
    assert.equal(app.store.get(S.claude).data.title, 'Claude verbinden', 'das Ziel seines Links bleibt -- sonst zeigte [[Claude verbinden]] ins Leere');
    assert.equal(app.store.get(S.willkommen).data.pinned, false);
    assert.equal(app.store.get(S.aufgabeClaude).data.status, 'done');
    // Eine selbst umgeschriebene Anleitung bleibt auch.
    app.store.update(S.claude, { body: 'Mein eigener Text.' });
    assert.deepEqual(await startInhalteAuffrischen(app), []);
    assert.equal(app.store.get(S.claude).data.body, 'Mein eigener Text.');
  });
});

test('Gelöschte Startinhalte kommen nicht zurück', async () => {
  await mitApp(async (app) => {
    altAnlegen(app);
    const S = START_IDS;
    app.store.remove(S.claude);
    app.store.remove(S.aufgabeClaude);
    await app.store.flush();
    assert.deepEqual(await startInhalteAuffrischen(app), []);
    assert.ok(app.store.get(S.claude, { includeDeleted: true }).deletedAt, 'bleibt geloescht');
  });
});

/* ------------------------------------- vor den festen IDs (bis 24.09.2026) */

/** So legten die ersten Fassungen an: zufaellige IDs, je nach Fassung Claude oder ein lokales Modell. */
function fruehAnlegen(app, { anleitung = 'Claude verbinden', aufgabe = 'Claude verbinden' } = {}) {
  const a = app.store.create('note', { title: anleitung, body: `So geht ${anleitung}.\n\n#anleitung`, tags: ['anleitung'] });
  const w = app.store.create('note', {
    title: 'Willkommen in Neural OS',
    body: `Dies ist deine eigene KI.\n\n## Erste Schritte\n\n1. ${anleitung}: [[${anleitung}]]\n2. Einfach losschreiben.\n\n#willkommen #anleitung`,
    tags: ['willkommen', 'anleitung'],
    pinned: true,
  });
  const p = app.store.create('project', { name: 'Mein erstes Projekt', description: 'Ein Platz.' });
  const t = app.store.create('task', { title: aufgabe, projectId: p.id, priority: 1 });
  const g = app.store.create('task', { title: 'Graph-Ansicht ausprobieren', projectId: p.id });
  return { a, w, p, t, g };
}

const warteAbleitung = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 30));
};

test('Ein Tresor von vor den festen IDs: die nie angefasste Einführung wird an ihrer Stelle aufgefrischt', async () => {
  await mitApp(async (app) => {
    const { a, w, p, t, g } = fruehAnlegen(app);
    await app.store.flush();
    await warteAbleitung();
    const vorher = linksVon(app, w.id);
    assert.deepEqual(vorher.map((e) => e.data.to), [a.id], 'die Ableitung hat den Link gezogen');
    const neu = await startInhalteAuffrischen(app);
    assert.deepEqual(neu.sort(), [a.id, w.id, t.id].sort());
    await warteAbleitung();
    assert.equal(app.store.get(a.id).data.title, 'KI verbinden');
    assert.match(app.store.get(a.id).data.body, /aistudio\.google\.com\/apikey/);
    assert.match(app.store.get(w.id).data.body, /Die KI ist Gemini von Google, kostenlos/);
    assert.equal(app.store.get(w.id).data.pinned, true);
    assert.equal(app.store.get(t.id).data.title, 'KI verbinden');
    assert.equal(app.store.get(t.id).data.projectId, p.id, 'die Aufgabe bleibt in ihrem Projekt');
    assert.equal(app.store.get(g.id).data.title, 'Graph-Ansicht ausprobieren', 'was nicht von Claude handelt, bleibt');
    const nachher = linksVon(app, w.id);
    assert.deepEqual(nachher.map((e) => [e.id, e.data.to]), [[vorher[0].id, a.id]], 'dieselbe Kante, kein zweiter Link');
    assert.equal(app.store.get(START_IDS.willkommen), null, 'keine zweite Einführung unter fester ID');
    assert.deepEqual(await startInhalteAuffrischen(app), [], 'ein zweiter Start ändert nichts');
  });
});

test('Die allerersten Fassungen („Lokales Modell einrichten“) werden genauso aufgefrischt', async () => {
  await mitApp(async (app) => {
    const { a, w, t } = fruehAnlegen(app, { anleitung: 'Lokales Modell einrichten', aufgabe: 'Lokales Modell installieren' });
    await app.store.flush();
    assert.deepEqual((await startInhalteAuffrischen(app)).sort(), [a.id, w.id, t.id].sort());
    assert.equal(app.store.get(a.id).data.title, 'KI verbinden');
    assert.deepEqual(app.store.get(a.id).data.tags, ['anleitung']);
    assert.equal(app.store.get(t.id).data.title, 'KI verbinden');
  });
});

test('Vor den festen IDs gilt dasselbe: Angefasstes bleibt, und im Zweifel wird nichts geändert', async () => {
  // Die Einführung umgeschrieben: nichts, auch nicht ihr Ziel.
  await mitApp(async (app) => {
    const { a, w, t } = fruehAnlegen(app);
    app.store.update(w.id, { body: `${app.store.get(w.id).data.body}\nMeine Zeile.` });
    await app.store.flush();
    assert.deepEqual(await startInhalteAuffrischen(app), []);
    assert.equal(app.store.get(a.id).data.title, 'Claude verbinden');
    assert.equal(app.store.get(t.id).data.title, 'Claude verbinden');
  });
  // Zwei Einführungen (etwa selbst kopiert): welche gemeint ist, ist unklar -- nichts.
  await mitApp(async (app) => {
    const { a } = fruehAnlegen(app);
    app.store.create('note', { title: 'Willkommen in Neural OS', body: 'Kopie [[Claude verbinden]]', pinned: true });
    await app.store.flush();
    assert.deepEqual(await startInhalteAuffrischen(app), []);
    assert.equal(app.store.get(a.id).data.title, 'Claude verbinden');
  });
  // Nur eine eigene Notiz „Claude verbinden“, keine Einführung: sie gehört dem Nutzer.
  await mitApp(async (app) => {
    const eigen = app.store.create('note', { title: 'Claude verbinden', body: 'Mein Plan.' });
    await app.store.flush();
    assert.deepEqual(await startInhalteAuffrischen(app), []);
    assert.equal(app.store.get(eigen.id).data.body, 'Mein Plan.');
  });
  // Die Aufgabe abgehakt: Einführung und Anleitung werden neu, die Aufgabe bleibt.
  await mitApp(async (app) => {
    const { a, w, t } = fruehAnlegen(app);
    app.store.update(t.id, { status: 'done' });
    await app.store.flush();
    assert.deepEqual((await startInhalteAuffrischen(app)).sort(), [a.id, w.id].sort());
    assert.equal(app.store.get(t.id).data.title, 'Claude verbinden');
    assert.equal(app.store.get(t.id).data.status, 'done');
  });
});
