'use strict';

/**
 * Tests for the model-free assistance: the six detectors, the scan that turns
 * their proposals into suggestion records, and what "übernehmen" really does.
 *
 * Everything here runs against the REAL store in a throwaway home, because the
 * things worth proving are exactly the things a fake would paper over:
 * idempotency across two scans, a dismissed suggestion staying dismissed, and
 * `accept` actually changing a record. The only injected seam is `now`, which
 * `scan()` accepts so the age-based detectors can be tested without waiting
 * ninety days.
 *
 * Nothing here touches the internet, the real home directory, or any model.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const { createAssist } = require('../src/assist/engine');
const detectorsMod = require('../src/assist/detectors');
const assistApi = require('../src/http/api/assist');

/** Tests must not write diagnostics over the runner's output. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

const DAY = 24 * 60 * 60 * 1000;

/** The graph object the app assembles: derivation plus views, one object. */
const GRAPH = { ...require('../src/graph/derive'), ...require('../src/graph/view') };

/**
 * Real store, real assist engine, thrown away afterwards.
 * @param {(env:{store:object, assist:object, now:number}) => any} fn
 * @param {{graph?:object|null, detectors?:Array<object>}} [opts]
 */
async function withVault(fn, opts = {}) {
  const { home, cleanup } = tempHome('nos-assist');
  const store = await openStore({ paths: path.join(home, 'nos'), lock: false, logger: silentLogger });
  const assist = createAssist({
    store,
    graph: opts.graph === undefined ? GRAPH : opts.graph,
    logger: silentLogger,
    detectors: opts.detectors,
  });
  try {
    await fn({ store, assist, home });
  } finally {
    await store.close().catch(() => {});
    cleanup();
  }
}

/** Suggestions of one kind, open ones only. */
function of(assist, kind) {
  return assist.list({ kind, limit: 100 }).items;
}

/* ------------------------------------------------------------- detectors */

const BEE_BODY = 'Der Imker prueft im Fruehjahr jeden Stock auf Futter und Koenigin. '
  + 'Danach wird der Boden gereinigt, das Volk umgesetzt und der Honigraum aufgelegt. '
  + 'Wichtig ist, dass die Waben nicht zu kalt stehen und das Flugloch offen bleibt. '
  + 'Bei Regen bleibt der Deckel zu, sonst kuehlt die Brut aus und das Volk schwaechelt. '
  + 'Zum Schluss wird alles notiert, damit im naechsten Jahr nichts vergessen wird.';

test('duplicate: fast gleiche Notizen werden gefunden, unterschiedliche nicht', async () => {
  await withVault(async ({ store, assist }) => {
    const a = store.create('note', { title: 'Bienen im Frühjahr', body: BEE_BODY });
    const b = store.create('note', { title: 'Frühjahrsdurchsicht', body: `${BEE_BODY} Dazu noch ein Satz.` });
    store.create('note', { title: 'Steuer', body: 'Belege sortieren, Fahrtkosten eintragen, Fristen im Blick behalten.' });

    await assist.scan({ kinds: ['duplicate'] });
    const items = of(assist, 'duplicate');
    assert.equal(items.length, 1, 'genau ein Paar, nicht drei');
    assert.deepEqual(items[0].data.recordIds.slice().sort(), [a.id, b.id].sort());
    assert.equal(items[0].data.action.op, 'link');
    assert.equal(items[0].data.action.kind, 'related');
    assert.match(items[0].data.detail, /Zusammenführen musst du selbst entscheiden/);
    assert.ok(items[0].data.confidence >= detectorsMod.DUPLICATE_THRESHOLD);
  });
});

test('duplicate: gleiche Titel nach Normalisierung zählen auch ohne gleichen Text', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Müsli', body: 'Hafer, Nüsse, Rosinen.' });
    store.create('note', { title: 'MUESLI', body: 'Ganz anderer Inhalt über Fahrräder und Ketten.' });
    await assist.scan({ kinds: ['duplicate'] });
    const items = of(assist, 'duplicate');
    assert.equal(items.length, 1);
    assert.match(items[0].data.reason, /denselben Titel/);
  });
});

/**
 * Der Fall, den `npm run check` gefunden hat.
 *
 * Kurze Notiz, gleicher Text, Titel um ein Wort verschieden: wird Titel und
 * Text zusammen verglichen, druecken die drei verschobenen Ketten den Wert auf
 * 0,55 und der Vorschlag faellt aus. Genau bei kurzen, schnell getippten
 * Notizen verdoppelt man sich aber am ehesten. Deshalb wird der Text auch
 * allein verglichen und der hoehere der beiden Werte zaehlt.
 */
test('duplicate: gleicher Text unter anderem Titel ist trotzdem eine Dublette', async () => {
  await withVault(async ({ store, assist }) => {
    const text = 'Erst den Wassertank leeren. Dann Entkalker einfüllen. Zwei Durchläufe.';
    const a = store.create('note', { title: 'Espressomaschine entkalken', body: text });
    const b = store.create('note', { title: 'Espressomaschine entkalken (Kopie)', body: text });
    await assist.scan({ kinds: ['duplicate'] });
    const items = of(assist, 'duplicate');
    assert.equal(items.length, 1, 'der Fall wurde wieder übersehen');
    assert.deepEqual(items[0].data.recordIds.slice().sort(), [a.id, b.id].sort());
    assert.match(items[0].data.reason, /Titel unterscheiden sich/,
      'der Grund soll sagen, woran es erkannt wurde – nicht nur dass');
  });
});

test('duplicate: zwei kurze Notizen mit verschiedenem Text bleiben zwei Notizen', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Espresso', body: 'Erst den Wassertank leeren. Dann Entkalker einfüllen.' });
    store.create('note', { title: 'Fahrrad', body: 'Kette reinigen. Dann Bremsbeläge prüfen. Luftdruck messen.' });
    const res = await assist.scan({ kinds: ['duplicate'] });
    assert.equal(res.created, 0, 'der Textvergleich darf nicht jedes kurze Paar zur Dublette erklären');
  });
});

test('duplicate: ein sauberer Speicher erzeugt keinen Vorschlag', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Imkerei', body: BEE_BODY });
    store.create('note', { title: 'Steuer', body: 'Belege sortieren, Fahrtkosten eintragen, Fristen beachten.' });
    const res = await assist.scan({ kinds: ['duplicate'] });
    assert.equal(res.created, 0);
    assert.deepEqual(res.skipped, []);
    assert.equal(of(assist, 'duplicate').length, 0);
  });
});

test('orphan: alte Notiz ohne Kanten wird gemeldet und nennt die nächsten Notizen', async () => {
  await withVault(async ({ store, assist }) => {
    const lonely = store.create('note', { title: 'Imkerei Grundlagen', body: BEE_BODY });
    const near = store.create('note', { title: 'Imkerei Werkzeug', body: 'Stockmeissel, Smoker, Besen.' });
    // Verknüpft und damit kein Waisenkind.
    const x = store.create('note', { title: 'Anker', body: 'Text' });
    const y = store.create('note', { title: 'Gegenstück', body: 'Text' });
    store.edges.add({ from: x.id, to: y.id, kind: 'related', source: 'manual' });

    await assist.scan({ kinds: ['orphan'], now: Date.now() + 30 * DAY });
    const ids = of(assist, 'orphan').map((s) => s.data.recordIds[0]);
    assert.ok(ids.includes(lonely.id));
    assert.ok(ids.includes(near.id));
    assert.ok(!ids.includes(x.id), 'verknüpfte Notizen sind keine Waisen');

    const item = of(assist, 'orphan').find((s) => s.data.recordIds[0] === lonely.id);
    assert.equal(item.data.action, null, 'orphan hat keine mechanische Aktion');
    assert.ok(item.data.recordIds.length > 1, 'die nächsten Notizen stehen hinter dem Betreff');
    assert.match(item.data.detail, /Imkerei Werkzeug/);
  });
});

test('orphan: eine frische Notiz ist noch keine Waise', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Heute notiert', body: 'Gerade eben geschrieben.' });
    const res = await assist.scan({ kinds: ['orphan'] });
    assert.equal(res.created, 0);
  });
});

test('tag: ein Schlagwort, das zwei Nachbarn teilen, wird vorgeschlagen', async () => {
  await withVault(async ({ store, assist }) => {
    const subject = store.create('note', { title: 'Ohne Schlagwort', body: 'Text', tags: [] });
    const hubs = [
      store.create('note', { title: 'Nachbar A', body: 'Text', tags: ['garten', 'imkerei'] }),
      store.create('note', { title: 'Nachbar B', body: 'Text', tags: ['garten', 'balkon'] }),
    ];
    for (const hub of hubs) store.edges.add({ from: subject.id, to: hub.id, kind: 'related', source: 'manual' });

    // Kontrollfall: zwei Nachbarn, aber kein gemeinsames Schlagwort.
    const clean = store.create('note', { title: 'Sauber', body: 'Text', tags: [] });
    const c1 = store.create('note', { title: 'C eins', body: 'Text', tags: ['alpha'] });
    const c2 = store.create('note', { title: 'C zwei', body: 'Text', tags: ['beta'] });
    store.edges.add({ from: clean.id, to: c1.id, kind: 'related', source: 'manual' });
    store.edges.add({ from: clean.id, to: c2.id, kind: 'related', source: 'manual' });

    await assist.scan({ kinds: ['tag'] });
    const items = of(assist, 'tag');
    assert.equal(items.length, 1, 'nur der Fall mit geteiltem Schlagwort');
    assert.equal(items[0].data.recordIds[0], subject.id);
    assert.deepEqual(items[0].data.action, { op: 'addTags', recordId: subject.id, tags: ['garten'] });
  });
});

test('task: nur ausdrückliche Merker werden zu Aufgaben, Prosa nicht', async () => {
  await withVault(async ({ store, assist }) => {
    const note = store.create('note', {
      title: 'Wochenplan',
      body: [
        '- [ ] Rechnung schreiben',
        '* [ ] Reifen wechseln',
        'TODO: Dach prüfen',
        'TODO Regenrinne reinigen',
        '@todo Kalender aufräumen',
        'Offen: Anruf beim Amt',
        'Zu tun: Kellerregal bauen',
        '- [x] Schon erledigt',
        'Ich sollte irgendwann mal die Steuer machen.',
      ].join('\n'),
    });

    await assist.scan({ kinds: ['task'] });
    const titles = of(assist, 'task').map((s) => s.data.action.title).sort();
    assert.deepEqual(titles, [
      'Anruf beim Amt',
      'Dach prüfen',
      'Kalender aufräumen',
      'Kellerregal bauen',
      'Rechnung schreiben',
      'Regenrinne reinigen',
      'Reifen wechseln',
    ]);
    for (const item of of(assist, 'task')) {
      assert.equal(item.data.action.op, 'createTask');
      assert.equal(item.data.action.sourceId, note.id);
      assert.equal(item.data.action.projectId, null);
    }
  });
});

test('task: eine Aufgabe, die es schon gibt, wird nicht noch einmal vorgeschlagen', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('task', { title: 'Rechnung schreiben' });
    store.create('note', { title: 'Plan', body: '- [ ] Rechnung schreiben\n- [ ] Etwas anderes' });
    await assist.scan({ kinds: ['task'] });
    const titles = of(assist, 'task').map((s) => s.data.action.title);
    assert.deepEqual(titles, ['Etwas anderes']);
  });
});

test('task: ein Projekt der Notiz landet in der Aufgabe', async () => {
  await withVault(async ({ store, assist }) => {
    const project = store.create('project', { name: 'Hausbau' });
    store.create('note', { title: 'Bau', body: 'Offen: Fenster bestellen', projectId: project.id });
    await assist.scan({ kinds: ['task'] });
    assert.equal(of(assist, 'task')[0].data.action.projectId, project.id);
  });
});

test('revisit: lange unberührte, verknüpfte Notizen -- höchstens fünf', async () => {
  await withVault(async ({ store, assist }) => {
    const hub = store.create('note', { title: 'Drehkreuz', body: 'Text' });
    for (let i = 0; i < 8; i++) {
      const note = store.create('note', { title: `Alt ${i}`, body: 'Text' });
      store.edges.add({ from: note.id, to: hub.id, kind: 'related', source: 'manual' });
      store.edges.add({ from: hub.id, to: note.id, kind: 'links-to', source: 'manual' });
    }
    const pinnedAlone = store.create('note', { title: 'Angeheftet', body: 'Text', pinned: true });

    await assist.scan({ kinds: ['revisit'], now: Date.now() + 200 * DAY });
    const items = of(assist, 'revisit');
    assert.ok(items.length <= 5, `höchstens fünf, waren ${items.length}`);
    assert.ok(items.length > 0);
    for (const item of items) assert.equal(item.data.action, null);

    // Eine frisch angelegte, unverknüpfte Notiz darf nie dabei sein.
    const fresh = store.create('note', { title: 'Neu', body: 'Text' });
    const second = await assist.scan({ kinds: ['revisit'] });
    assert.equal(second.byKind.revisit, 0, 'ohne Alter kein Wiederlesen');
    assert.ok(!of(assist, 'revisit').some((s) => s.data.recordIds[0] === fresh.id));
    assert.ok(pinnedAlone.id);
  });
});

test('link: ein [[Verweis]] ohne Ziel wird gemeldet, ein aufgelöster nicht', async () => {
  await withVault(async ({ store, assist }) => {
    const source = store.create('note', { title: 'Projektnotiz', body: 'Siehe [[Fehlende Notiz]] und [[Vorhandenes]].' });
    store.create('note', { title: 'Vorhandenes', body: 'Gibt es.' });

    await assist.scan({ kinds: ['link'] });
    const items = of(assist, 'link');
    assert.equal(items.length, 1);
    assert.equal(items[0].data.action.op, 'createNote');
    assert.equal(items[0].data.action.title, 'Fehlende Notiz');
    assert.equal(items[0].data.action.linkFrom, source.id);
    assert.match(items[0].data.action.body, /Projektnotiz/, 'der Stub nennt die Fundstelle');
    assert.equal(items[0].data.recordIds[0], source.id);
  });
});

test('link: die Auflösung stimmt mit der des Graphen überein', async () => {
  await withVault(async ({ store, assist }) => {
    // Umlaut-Schreibweise und Alias-Pipe: beides muss genau so aufgelöst
    // werden, wie derive.js es tut, sonst meldet die Assistenz Lücken, die
    // der Graph längst verknüpft hat.
    store.create('note', { title: 'Grüne Soße', body: 'Rezept.' });
    store.create('note', { title: 'Küche', body: 'Siehe [[Gruene Sosse|die Soße]] und [[`[[im Code]]`]].' });
    const res = await assist.scan({ kinds: ['link'] });
    assert.equal(res.created, 0, 'gefaltete Titel und Code-Spannen gelten wie im Graphen');
  });
});

/* ------------------------------------------------------------------ scan */

test('Ein zweiter Scan legt nichts Neues an, sondern frischt auf', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Bienen', body: BEE_BODY });
    store.create('note', { title: 'Bienen zwei', body: `${BEE_BODY} Zusatz.` });
    store.create('note', { title: 'Plan', body: 'TODO: Dach prüfen' });
    store.create('note', { title: 'Verweis', body: 'Siehe [[Nichts]].' });

    const first = await assist.scan({ now: Date.now() + 30 * DAY });
    assert.ok(first.created > 0);
    const before = assist.list({ status: 'all', limit: 200 }).total;

    const second = await assist.scan({ now: Date.now() + 30 * DAY });
    assert.equal(second.created, 0, 'ein zweiter Scan legt nichts an');
    assert.equal(second.refreshed, first.created);
    assert.equal(second.stale, 0);
    assert.equal(assist.list({ status: 'all', limit: 200 }).total, before, 'keine Dubletten im Speicher');
  });
});

test('Ein abgelehnter Vorschlag kommt nach einem neuen Scan nicht zurück', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Plan', body: 'TODO: Dach prüfen' });
    await assist.scan({ kinds: ['task'] });
    const item = of(assist, 'task')[0];
    assist.dismiss(item.id);

    const second = await assist.scan({ kinds: ['task'] });
    assert.equal(second.created, 0);
    assert.equal(second.refreshed, 0);
    assert.equal(of(assist, 'task').length, 0, 'nichts Offenes mehr');
    const all = assist.list({ status: 'all', limit: 100 }).items.filter((s) => s.data.kind === 'task');
    assert.equal(all.length, 1, 'und auch keine zweite Kopie');
    assert.equal(all[0].data.status, 'dismissed');
    assert.ok(all[0].data.decidedAt);
  });
});

test('Ein Vorschlag, der nicht mehr zutrifft, wird stale', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Verweis', body: 'Siehe [[Fehlende Notiz]].' });
    await assist.scan({ kinds: ['link'] });
    const item = of(assist, 'link')[0];
    assert.ok(item);

    // Der Nutzer legt die Notiz selbst an: der Verweis zeigt nicht mehr ins Leere.
    store.create('note', { title: 'Fehlende Notiz', body: 'Jetzt da.' });
    const second = await assist.scan({ kinds: ['link'] });
    assert.equal(second.stale, 1);
    assert.equal(store.get(item.id).data.status, 'stale');
    assert.equal(of(assist, 'link').length, 0);
  });
});

test('Ein kaputter Detektor landet in skipped, die anderen laufen weiter', async () => {
  const broken = {
    kind: 'duplicate',
    label: 'Kaputt',
    description: 'Wirft absichtlich.',
    detect() { throw new Error('Absichtlich kaputt'); },
  };
  const working = detectorsMod.DETECTORS.find((d) => d.kind === 'task');
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Plan', body: 'TODO: Dach prüfen' });
    const res = await assist.scan();
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].kind, 'duplicate');
    assert.match(res.skipped[0].reason, /Absichtlich kaputt/, 'der echte Grund, nicht "unbekannt"');
    assert.equal(res.created, 1, 'der gesunde Detektor läuft trotzdem');
    assert.equal(of(assist, 'task').length, 1);
  }, { detectors: [broken, working] });
});

test('Ohne Graph meldet sich der Link-Detektor selbst als übersprungen', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Verweis', body: 'Siehe [[Fehlende Notiz]].\nTODO: trotzdem arbeiten' });
    const res = await assist.scan();
    const skipped = res.skipped.find((s) => s.kind === 'link');
    assert.ok(skipped, 'link muss sich melden');
    assert.match(skipped.reason, /Wissensgraph/);
    assert.equal(of(assist, 'link').length, 0);
    assert.equal(of(assist, 'task').length, 1, 'der Rest arbeitet weiter');
  }, { graph: null });
});

/* ---------------------------------------------------------------- accept */

test('accept addTags ergänzt die Schlagwörter wirklich', async () => {
  await withVault(async ({ store, assist }) => {
    const subject = store.create('note', { title: 'Ohne', body: 'Text', tags: ['eigenes'] });
    for (const tags of [['garten', 'imkerei'], ['garten', 'balkon']]) {
      const hub = store.create('note', { title: `Nachbar ${tags[1]}`, body: 'Text', tags });
      store.edges.add({ from: subject.id, to: hub.id, kind: 'related', source: 'manual' });
    }
    await assist.scan({ kinds: ['tag'] });
    const item = of(assist, 'tag')[0];

    const { suggestion, applied } = await assist.accept(item.id);
    assert.deepEqual(applied, { op: 'addTags', recordId: subject.id, added: ['garten'] });
    assert.equal(suggestion.data.status, 'accepted');
    assert.ok(suggestion.data.decidedAt);
    assert.deepEqual(store.get(subject.id).data.tags, ['eigenes', 'garten']);
  });
});

test('accept createTask legt eine echte Aufgabe an', async () => {
  await withVault(async ({ store, assist }) => {
    const note = store.create('note', { title: 'Plan', body: 'Offen: Fenster bestellen' });
    await assist.scan({ kinds: ['task'] });
    const item = of(assist, 'task')[0];

    const { applied } = await assist.accept(item.id);
    assert.equal(applied.op, 'createTask');
    const task = store.get(applied.taskId);
    assert.equal(task.type, 'task');
    assert.equal(task.data.title, 'Fenster bestellen');
    assert.equal(task.data.status, 'todo');
    assert.equal(task.data.sourceId, note.id, 'die Herkunft bleibt am Datensatz');
  });
});

test('accept createNote legt die Notiz an und verknüpft sie mit der Fundstelle', async () => {
  await withVault(async ({ store, assist }) => {
    const source = store.create('note', { title: 'Projektnotiz', body: 'Siehe [[Fehlende Notiz]].' });
    await assist.scan({ kinds: ['link'] });
    const item = of(assist, 'link')[0];

    const { applied } = await assist.accept(item.id);
    assert.equal(applied.op, 'createNote');
    const note = store.get(applied.noteId);
    assert.equal(note.data.title, 'Fehlende Notiz');
    assert.match(note.data.body, /Projektnotiz/);

    const edge = store.get(applied.edgeId);
    assert.equal(edge.data.from, source.id);
    assert.equal(edge.data.to, note.id);
    assert.equal(edge.data.kind, 'links-to');
    // Der Graph erkennt die Kante beim nächsten Rescan als seine eigene und
    // lässt sie stehen, statt eine zweite daneben zu legen.
    const again = GRAPH.deriveFor(store, source.id);
    assert.equal(again.created.length, 0);
    assert.equal(again.removed.length, 0);
  });
});

test('accept link verknüpft zwei Doppelgänger, ohne etwas zusammenzuführen', async () => {
  await withVault(async ({ store, assist }) => {
    const a = store.create('note', { title: 'Bienen', body: BEE_BODY });
    const b = store.create('note', { title: 'Bienen zwei', body: `${BEE_BODY} Zusatz.` });
    await assist.scan({ kinds: ['duplicate'] });
    const item = of(assist, 'duplicate')[0];

    const { applied } = await assist.accept(item.id);
    const edge = store.get(applied.edgeId);
    assert.equal(edge.data.kind, 'related');
    assert.equal(edge.data.source, 'agent', 'die Herkunft bleibt sichtbar');
    assert.ok(edge.data.reason, 'und begründet');
    // Beide Notizen sind unverändert da: nichts wurde zusammengeführt.
    assert.equal(store.get(a.id).data.body, BEE_BODY);
    assert.ok(store.get(b.id));
  });
});

test('accept ohne Aktion sagt ehrlich, dass es nichts zu tun gibt', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Allein', body: 'Text ohne Verbindung.' });
    await assist.scan({ kinds: ['orphan'], now: Date.now() + 30 * DAY });
    const item = of(assist, 'orphan')[0];
    const { applied, suggestion } = await assist.accept(item.id);
    assert.equal(applied.op, 'none');
    assert.match(applied.note, /keine automatische Aktion/);
    assert.equal(suggestion.data.status, 'accepted');
  });
});

test('accept auf einem gelöschten Betreff wirft und markiert den Vorschlag als stale', async () => {
  await withVault(async ({ store, assist }) => {
    const note = store.create('note', { title: 'Plan', body: 'Offen: Fenster bestellen' });
    await assist.scan({ kinds: ['task'] });
    const item = of(assist, 'task')[0];

    store.remove(note.id);
    await assert.rejects(
      () => assist.accept(item.id),
      (err) => err.code === 'NOT_FOUND',
      'es wird kein Erfolg vorgetäuscht',
    );
    assert.equal(store.get(item.id).data.status, 'stale');
    assert.equal(store.count('task'), 0, 'und nichts wurde angelegt');
  });
});

test('dismiss, remove und stats', async () => {
  await withVault(async ({ store, assist }) => {
    store.create('note', { title: 'Plan', body: 'TODO: Dach prüfen\nOffen: Anruf beim Amt' });
    await assist.scan({ kinds: ['task'] });
    const items = of(assist, 'task');
    assert.equal(items.length, 2);

    assist.dismiss(items[0].id);
    let s = assist.stats();
    assert.equal(s.open, 1);
    assert.equal(s.dismissed, 1);
    assert.equal(s.byKind.task, 1, 'byKind zählt, was noch wartet');

    assist.remove(items[1].id);
    s = assist.stats();
    assert.equal(s.open, 0);
    assert.equal(assist.list({ status: 'all', limit: 10 }).total, 1);
  });
});

test('Unbekannte Arten werden mit den möglichen benannt abgelehnt', async () => {
  await withVault(async ({ assist }) => {
    await assert.rejects(
      () => assist.scan({ kinds: ['gibtsnicht'] }),
      (err) => err.code === 'VALIDATION_FAILED' && /duplicate/.test(err.message),
    );
  });
});

/* ------------------------------------------------------------ complexity */

test('duplicate vergleicht nicht alle Paare: 400 Notizen bleiben bezahlbar', async () => {
  // Strukturell: der invertierte Index darf über 400 unterschiedliche Texte
  // nur einen Bruchteil der 79 800 möglichen Paare erzeugen.
  const sketches = [];
  for (let i = 0; i < 400; i++) {
    const words = [];
    for (let w = 0; w < 60; w++) words.push(`wort${i}x${w}`);
    sketches.push(detectorsMod.sketchOf(detectorsMod.shingleSet(words)));
  }
  const pairs = detectorsMod.candidatePairs(sketches);
  assert.ok(pairs.length < 400, `Kandidatenpaare: ${pairs.length}, nicht ${(400 * 399) / 2}`);

  // Und praktisch: derselbe Lauf gegen den echten Speicher.
  await withVault(async ({ store, assist }) => {
    for (let i = 0; i < 400; i++) {
      store.create('note', {
        title: `Notiz ${i}`,
        body: `Thema ${i}: ${Array.from({ length: 40 }, (_, w) => `begriff${i}n${w}`).join(' ')}`,
      });
    }
    const twinBody = 'Ein Text, der zweimal im Speicher liegt und deshalb auffallen muss, mit genug Worten für Vier-Wort-Ketten.';
    store.create('note', { title: 'Zwilling A', body: twinBody });
    store.create('note', { title: 'Zwilling B', body: `${twinBody} Fast.` });

    const t0 = Date.now();
    const res = await assist.scan({ kinds: ['duplicate'] });
    const ms = Date.now() - t0;
    assert.equal(res.created, 1, 'genau das eine echte Paar');
    assert.ok(ms < 5000, `Scan über 402 Notizen dauerte ${ms} ms`);
  });
});

/* ----------------------------------------------------------------- HTTP */

/**
 * Make the real server serve /api/assist even before the integrator has added
 * the route file to its loader list: the last route module it loads gets a
 * wrapper that also registers ours. The server itself stays unpatched, and the
 * seam disappears by itself once `src/http/server.js` requires the file.
 */
const SERVER_FILE = require.resolve('../src/http/server');
if (!/require\(['"]\.\/api\/assist['"]\)/.test(fs.readFileSync(SERVER_FILE, 'utf8'))) {
  const lastLoadedApi = require('../src/http/api/modules');
  const originalRegister = lastLoadedApi.register;
  lastLoadedApi.register = function registerWithAssist(router) {
    originalRegister.call(this, router);
    assistApi.register(router);
  };
}

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* nicht jede Route antwortet JSON */ }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Die HTTP-Routen liefern den vereinbarten Vertrag', async () => {
  const { createServer } = require('../src/http/server');
  const { Bus } = require('../src/kernel/bus');
  const configMod = require('../src/kernel/config');
  const pathsMod = require('../src/kernel/paths');

  const { home, cleanup } = tempHome('nos-assist-http');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  config.server.port = 7777;

  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const assist = createAssist({ store, graph: GRAPH, bus, logger: silentLogger });
  const server = await createServer({
    version: 'test', config, paths, store, bus, assist, graph: GRAPH, logger: silentLogger, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    const note = store.create('note', { title: 'Plan', body: 'TODO: Dach prüfen' });

    const detectors = await request(base, 'GET', '/api/assist/detectors');
    assert.equal(detectors.status, 200, detectors.text);
    assert.equal(detectors.json.items.length, 6);
    assert.deepEqual(detectors.json.items.map((d) => d.kind).sort(),
      ['duplicate', 'link', 'orphan', 'revisit', 'tag', 'task']);

    const bad = await request(base, 'POST', '/api/assist/scan', { kinds: ['gibtsnicht'] });
    assert.equal(bad.status, 400, bad.text);
    assert.match(bad.json.error.message, /duplicate/, 'die möglichen Arten werden genannt');

    const scan = await request(base, 'POST', '/api/assist/scan', { kinds: ['task'], limit: 10 });
    assert.equal(scan.status, 200, scan.text);
    assert.equal(scan.json.created, 1);
    assert.ok(Array.isArray(scan.json.skipped));
    assert.ok(typeof scan.json.durationMs === 'number');

    const listed = await request(base, 'GET', '/api/assist/suggestions?status=open&kind=task&limit=10');
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.total, 1);
    const suggestion = listed.json.items[0];
    assert.equal(suggestion.data.recordIds[0], note.id);

    const stats = await request(base, 'GET', '/api/assist/stats');
    assert.equal(stats.json.open, 1);
    assert.equal(stats.json.byKind.task, 1);

    const accepted = await request(base, 'POST', `/api/assist/suggestions/${suggestion.id}/accept`);
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json.applied.op, 'createTask');
    assert.equal(store.get(accepted.json.applied.taskId).data.title, 'Dach prüfen');

    const missing = await request(base, 'POST', '/api/assist/suggestions/note_doesnotexist000000000/dismiss');
    assert.equal(missing.status, 404, missing.text);

    const second = await request(base, 'POST', '/api/assist/scan', { kinds: ['task'] });
    assert.equal(second.json.created, 0, 'auch über HTTP idempotent');

    const gone = await request(base, 'DELETE', `/api/assist/suggestions/${suggestion.id}`);
    assert.equal(gone.status, 200, gone.text);
    assert.deepEqual(gone.json, { ok: true });
    assert.equal(store.get(suggestion.id), null);
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    cleanup();
  }
});

module.exports = { name: 'assist', tests: drain() };
