'use strict';

/**
 * Tests for the deck: the SM-2 schedule, the daily queue, what a note may turn
 * into, and what happens to a card whose source note is deleted.
 *
 * Everything runs against the REAL store in a throwaway home. The only seam is
 * `now`, which `createStudy` takes as a function -- so a test can move through
 * six days, or from morning to evening of the same day, without sleeping for a
 * single millisecond. A test that waited would not be testing the schedule, it
 * would be testing setTimeout.
 *
 * Dates are written WITHOUT a timezone suffix on purpose ('2026-09-21T09:00'):
 * `due` is a local calendar day, and a test that pinned everything to UTC
 * would pass in Greenwich and fail in Berlin.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const {
  createStudy, schedule, addDays,
  MIN_EASE, MAX_INTERVAL_DAYS, DEFAULT_EASE, GRADE_LABELS,
} = require('../src/study/cards');
const studyApi = require('../src/http/api/study');

/** Tests must not write diagnostics over the runner's output. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

const MORNING = '2026-09-21T09:00';
const EVENING = '2026-09-21T21:30';

/**
 * A real vault, a real deck, a clock the test owns.
 * @param {(env:{store:object, study:object, bus:object, clock:{at:Date}}) => any} fn
 */
async function withDeck(fn, opts = {}) {
  const { Bus } = require('../src/kernel/bus');
  const { home, cleanup } = tempHome('nos-study');
  const bus = new Bus();
  const store = await openStore({ paths: path.join(home, 'nos'), bus, lock: false, logger: silentLogger });
  const clock = { at: new Date(opts.start || MORNING) };
  const study = createStudy({ store, bus, logger: silentLogger, now: () => clock.at });
  try {
    await fn({ store, study, bus, clock, home });
  } finally {
    study.stop();
    await store.close().catch(() => {});
    cleanup();
  }
}

/** Front sides of a queue, in order. */
function fronts(result) {
  return result.items.map((item) => item.record.data.front);
}

/* ------------------------------------------------------------- schedule */

test('schedule: die vier Noten tun vier verschiedene Dinge', () => {
  const fresh = { ease: DEFAULT_EASE, intervalDays: 0, reps: 0, lapses: 0 };
  const at = new Date(MORNING);

  const nochmal = schedule(fresh, 0, at);
  assert.equal(nochmal.intervalDays, 0, 'Nochmal heißt heute');
  assert.equal(nochmal.due, '2026-09-21');
  assert.equal(nochmal.lapses, 1);
  assert.equal(nochmal.reps, 0, 'die Folge beginnt von vorn');
  assert.ok(nochmal.ease < DEFAULT_EASE, 'Nochmal senkt die Leichtigkeit');

  const schwer = schedule(fresh, 1, at);
  assert.equal(schwer.intervalDays, 1);
  assert.equal(schwer.reps, 1);
  assert.equal(schwer.lapses, 0, 'Schwer ist kein Rückfall');
  assert.ok(schwer.ease < DEFAULT_EASE, 'aber es kostet Leichtigkeit');

  const gut = schedule(fresh, 2, at);
  assert.equal(gut.intervalDays, 1);
  assert.equal(gut.ease, DEFAULT_EASE, 'Gut lässt die Leichtigkeit, wie sie ist');

  const leicht = schedule(fresh, 3, at);
  assert.equal(leicht.intervalDays, 1, 'beim ersten Mal ist auch Leicht ein Tag');
  assert.ok(leicht.ease > DEFAULT_EASE, 'der Unterschied steckt in der Leichtigkeit');

  assert.deepEqual(GRADE_LABELS, ['Nochmal', 'Schwer', 'Gut', 'Leicht']);
});

test('schedule: erst 1 Tag, dann 6, danach mal Leichtigkeit', () => {
  const at = new Date(MORNING);
  let data = { ease: DEFAULT_EASE, intervalDays: 0, reps: 0, lapses: 0 };

  const first = schedule(data, 2, at);
  assert.equal(first.intervalDays, 1);
  assert.equal(first.due, '2026-09-22');
  data = { ...data, ...first };

  const second = schedule(data, 2, addDays(at, 1));
  assert.equal(second.intervalDays, 6);
  assert.equal(second.due, '2026-09-28');
  data = { ...data, ...second };

  const third = schedule(data, 2, addDays(at, 7));
  assert.equal(third.intervalDays, Math.round(6 * DEFAULT_EASE), '6 * 2,5 = 15');
  assert.equal(third.intervalDays, 15);
  assert.equal(third.reps, 3);
});

test('schedule: die Leichtigkeit fällt nie unter 1,3', () => {
  let data = { ease: DEFAULT_EASE, intervalDays: 20, reps: 5, lapses: 0 };
  const at = new Date(MORNING);
  for (let i = 0; i < 30; i++) {
    const next = schedule(data, 0, at);
    data = { ...data, ...next };
    assert.ok(data.ease >= MIN_EASE, `nach ${i + 1} Fehlversuchen: ${data.ease}`);
  }
  assert.equal(data.ease, MIN_EASE, 'und bleibt genau dort stehen');
  assert.equal(data.lapses, 30, 'jeder Rückfall wird gezählt');
});

test('schedule: das Intervall überschreitet die Obergrenze nicht', () => {
  let data = { ease: 3, intervalDays: 1, reps: 3, lapses: 0 };
  let at = new Date(MORNING);
  for (let i = 0; i < 40; i++) {
    const next = schedule(data, 3, at);
    data = { ...data, ...next };
    assert.ok(data.intervalDays <= MAX_INTERVAL_DAYS, `Schritt ${i}: ${data.intervalDays} Tage`);
    at = addDays(at, data.intervalDays);
  }
  assert.equal(data.intervalDays, MAX_INTERVAL_DAYS, 'die Grenze wird erreicht und gehalten');
});

test('schedule: nach einem Rückfall beginnt die Folge wieder bei einem Tag', () => {
  const at = new Date(MORNING);
  let data = { ease: DEFAULT_EASE, intervalDays: 15, reps: 3, lapses: 0 };
  data = { ...data, ...schedule(data, 0, at) };
  assert.equal(data.intervalDays, 0);
  data = { ...data, ...schedule(data, 2, at) };
  assert.equal(data.intervalDays, 1, 'wieder ein Tag');
  data = { ...data, ...schedule(data, 2, addDays(at, 1)) };
  assert.equal(data.intervalDays, 6, 'und dann sechs');
});

test('schedule: eine unbekannte Note wird abgelehnt, nicht gerundet', () => {
  const data = { ease: DEFAULT_EASE };
  for (const bad of [-1, 4, 2.5, '2', null, undefined, NaN]) {
    assert.throws(() => schedule(data, bad, new Date(MORNING)), /grade/, `angenommen: ${String(bad)}`);
  }
});

test('schedule: ein Intervall wächst auch dann, wenn die Rundung es nicht täte', () => {
  // 1 * 1,3 rundet auf 1 -- eine Karte, die für immer auf einem Tag steht.
  const data = { ease: MIN_EASE, intervalDays: 1, reps: 3, lapses: 0 };
  const next = schedule(data, 2, new Date(MORNING));
  assert.ok(next.intervalDays > 1, `blieb bei ${next.intervalDays}`);
});

/* ------------------------------------------------------------ der Stapel */

test('due: eine morgens gelernte Karte ist abends nicht wieder fällig', async () => {
  await withDeck(async ({ study, clock }) => {
    const card = study.create({ front: 'Kondensator', back: 'Speichert Ladung.' });
    assert.equal(study.due().items.length, 1, 'eine neue Karte ist sofort dran');

    study.review(card.id, 2);
    assert.equal(study.due().items.length, 0, 'direkt danach nicht mehr');

    clock.at = new Date(EVENING);
    assert.equal(study.due().items.length, 0, 'und abends immer noch nicht');
    assert.equal(study.due().naechste, '2026-09-22');

    clock.at = new Date('2026-09-22T06:00');
    assert.equal(study.due().items.length, 1, 'am nächsten Morgen schon');
  });
});

test('due: die Uhrzeit des Lernens bestimmt den Tagesrhythmus nicht', async () => {
  await withDeck(async ({ study, clock }) => {
    const card = study.create({ front: 'Spät', back: 'Kurz vor Mitternacht gelernt.' });
    clock.at = new Date('2026-09-21T23:30');
    const { record } = study.review(card.id, 2);
    assert.equal(record.data.due, '2026-09-22', 'fällig ist ein Tag, keine 24 Stunden');

    clock.at = new Date('2026-09-22T00:30');
    assert.equal(study.due().items.length, 1, 'eine Stunde später ist der nächste Tag');
  });
});

test('due: "Nochmal" bringt die Karte heute zurück', async () => {
  await withDeck(async ({ study, clock }) => {
    const card = study.create({ front: 'Schwierig', back: 'Sitzt nicht.' });
    study.review(card.id, 0);
    clock.at = new Date(EVENING);
    const queue = study.due();
    assert.deepEqual(fronts(queue), ['Schwierig']);
    assert.equal(queue.items[0].record.data.intervalDays, 0);
    assert.equal(queue.items[0].record.data.lapses, 1);
  });
});

test('due: überfällige zuerst, dann neue', async () => {
  await withDeck(async ({ study, clock }) => {
    const alt = study.create({ front: 'Lange überfällig' });
    const juengst = study.create({ front: 'Seit gestern fällig' });
    study.review(alt.id, 2);
    clock.at = new Date('2026-09-25T09:00');
    study.review(juengst.id, 2);

    // Beide sind jetzt fällig, die eine deutlich länger als die andere.
    clock.at = new Date('2026-10-01T09:00');
    study.create({ front: 'Ganz neu' });

    const queue = study.due();
    assert.deepEqual(fronts(queue), ['Lange überfällig', 'Seit gestern fällig', 'Ganz neu']);
    assert.equal(queue.faellig, 2);
    assert.equal(queue.neu, 1);
  });
});

test('due: eine ausgesetzte Karte kommt nie', async () => {
  await withDeck(async ({ study }) => {
    const card = study.create({ front: 'Ruht' });
    study.create({ front: 'Läuft' });
    study.suspend(card.id, true);

    assert.deepEqual(fronts(study.due()), ['Läuft']);
    assert.equal(study.due().ausgesetzt, 1);
    assert.equal(study.stats().ausgesetzt, 1);
    assert.throws(() => study.review(card.id, 2), /ausgesetzt/);

    study.suspend(card.id, false);
    assert.equal(study.due().items.length, 2, 'wieder aufgenommen ist sie wieder dabei');
  });
});

test('due: eine Karte ohne lesbaren Termin verschwindet nicht, sie wird eingeplant', async () => {
  await withDeck(async ({ store, study }) => {
    // So etwas entsteht nicht hier, aber es koennte importiert werden. Eine
    // Karte, die zwischen die Faecher faellt, waere der schlimmste Ausgang.
    store.create('card', { front: 'Krummer Termin', due: 'irgendwann', lastReviewedAt: '2026-01-01T10:00:00.000Z' });
    const queue = study.due();
    assert.deepEqual(fronts(queue), ['Krummer Termin']);
    assert.equal(study.stats().neu, 1);
    const { record } = study.review(queue.items[0].record.id, 2);
    assert.equal(record.data.due, '2026-09-22', 'danach hat sie einen richtigen Termin');
  });
});

test('due: die Vorschau auf den Knöpfen ist das, was wirklich passiert', async () => {
  await withDeck(async ({ study, clock }) => {
    const card = study.create({ front: 'Vorschau' });
    study.review(card.id, 2);
    clock.at = new Date('2026-09-22T09:00');

    const item = study.due().items[0];
    const gut = item.vorschau.find((entry) => entry.grade === 2);
    assert.equal(gut.intervalDays, 6);
    assert.equal(gut.wann, 'in 6 Tagen');
    assert.equal(item.vorschau.find((e) => e.grade === 0).wann, 'heute');

    const { record } = study.review(card.id, 2);
    assert.equal(record.data.due, gut.due, 'der Knopf hat nicht gelogen');
    assert.equal(record.data.intervalDays, gut.intervalDays);
  });
});

test('stapel und stats: die Zahlen sagen, was sie heißen', async () => {
  await withDeck(async ({ study, clock }) => {
    const a = study.create({ front: 'A', deck: 'Latein' });
    study.create({ front: 'B', deck: 'Latein' });
    study.create({ front: 'C', deck: 'Physik' });
    study.review(a.id, 2); // fällig morgen

    const stats = study.stats();
    assert.equal(stats.gesamt, 3);
    // "faellig" und "neu" werden getrennt gezählt: fällig ist, was einen
    // Termin hat, der heute oder früher war. Zusammen sind sie das, was heute
    // im Stapel liegt -- die Ansicht addiert sie, die Zahl lügt nicht.
    assert.equal(stats.neu, 2);
    assert.equal(stats.faellig, 0, 'die einzige geplante Karte ist erst morgen dran');
    assert.equal(study.due().items.length, 2, 'im Stapel liegen trotzdem zwei');
    assert.equal(stats.gelernt, 1, 'einmal beantwortet zählt als gelernt');
    assert.equal(stats.morgen, 1);
    assert.equal(stats.nachStapel.length, 2);
    assert.deepEqual(stats.nachStapel.map((d) => d.name), ['Latein', 'Physik']);
    assert.equal(stats.nachStapel[0].gesamt, 2);

    assert.deepEqual(fronts(study.due({ deck: 'Physik' })), ['C']);

    clock.at = new Date('2026-09-22T09:00');
    assert.equal(study.stats().morgen, 0, 'morgen ist jetzt heute');
    assert.equal(study.stats().faellig, 1, 'und die geplante Karte ist jetzt dran');
    assert.equal(study.due().items.length, 3);
  });
});

test('Der Lernstand lässt sich nicht von Hand setzen', async () => {
  await withDeck(async ({ study }) => {
    const card = study.create({ front: 'Fest' });
    assert.throws(() => study.update(card.id, { ease: 9 }), /Lernstand/);
    assert.throws(() => study.update(card.id, { due: '2030-01-01' }), /Lernstand/);
    const renamed = study.update(card.id, { front: 'Anders', deck: 'Neu' });
    assert.equal(renamed.data.front, 'Anders');
    assert.equal(renamed.data.deck, 'Neu');
  });
});

/* ------------------------------------------------------ aus einer Notiz */

const NOTE_BODY = [
  '# Elektronik',
  '',
  'Eine Einleitung, die nur Fließtext ist — mit Gedankenstrich, wie hier üblich,',
  'und trotzdem keine Karte. Sie erklärt nichts, sie leitet ein.',
  '',
  '## Kondensator',
  '',
  'Speichert Ladung in einem elektrischen Feld. Die Kapazität wird in Farad',
  'gemessen.',
  '',
  '## Diode',
  'Lässt Strom nur in eine Richtung durch.',
  '',
  'Widerstand :: Begrenzt den Strom, gemessen in Ohm.',
  '',
  '**Spule** — Speichert Energie in einem Magnetfeld.',
  '',
  '```',
  '## Das hier ist Code',
  'Nicht anfassen :: auch das nicht',
  '```',
  '',
  '## Ohne Absatz',
  '## Auch ohne',
  'Doch mit.',
].join('\n');

test('proposeFromNote: erkennt die drei Formen und rät nicht aus Fließtext', async () => {
  await withDeck(async ({ store, study }) => {
    const note = store.create('note', { title: 'Elektronik', body: NOTE_BODY });
    const result = study.proposeFromNote(note.id);
    const byFront = new Map(result.items.map((item) => [item.front, item]));

    assert.equal(byFront.get('Kondensator').form, 'ueberschrift');
    assert.match(byFront.get('Kondensator').back, /^Speichert Ladung in einem elektrischen Feld\./);
    assert.match(byFront.get('Kondensator').back, /Farad gemessen\.$/, 'der ganze Absatz, in einer Zeile');
    assert.equal(byFront.get('Diode').back, 'Lässt Strom nur in eine Richtung durch.');
    assert.equal(byFront.get('Widerstand').form, 'trenner');
    assert.equal(byFront.get('Widerstand').back, 'Begrenzt den Strom, gemessen in Ohm.');
    assert.equal(byFront.get('Spule').form, 'definition');
    assert.equal(byFront.get('Spule').back, 'Speichert Energie in einem Magnetfeld.');
    assert.equal(byFront.get('Auch ohne').back, 'Doch mit.');

    assert.ok(!byFront.has('Elektronik'), 'die Titelüberschrift wird nicht zur Frage');
    assert.ok(!byFront.has('Das hier ist Code'), 'in einem Codeblock steht keine Karte');
    assert.ok(!byFront.has('Nicht anfassen'), 'auch kein Trenner im Codeblock');
    assert.ok(!byFront.has('Ohne Absatz'), 'eine Überschrift ohne Absatz ergibt nichts');
    assert.equal(result.items.length, 5, `gefunden: ${[...byFront.keys()].join(', ')}`);

    for (const item of result.items) {
      assert.ok(item.key && typeof item.key === 'string');
      assert.equal(item.schonVorhanden, false);
    }
    assert.ok(result.uebersprungen.some((entry) => /Ohne Absatz/.test(entry.grund)),
      'und es steht dort, warum');
  });
});

test('proposeFromNote: ein Gedankenstrich allein ist kein Trenner', async () => {
  await withDeck(async ({ store, study }) => {
    const note = store.create('note', {
      title: 'Prosa',
      body: 'Der Abgleich läuft über einen Ordner — und das ist Absicht.\n'
        + 'Zwei Geräte, ein Stapel — das ginge schief.\n',
    });
    const result = study.proposeFromNote(note.id);
    assert.equal(result.items.length, 0, `geraten: ${result.items.map((i) => i.front).join(' / ')}`);
    assert.match(result.hinweis, /nichts geraten/);
    assert.equal(result.formen.length, 3, 'stattdessen steht da, was erkannt wird');
  });
});

test('proposeFromNote: ein zu langer Absatz wird übersprungen und begründet', async () => {
  await withDeck(async ({ store, study }) => {
    const note = store.create('note', {
      title: 'Lang',
      body: `## Abschweifung\n\n${'Sehr viel Text. '.repeat(120)}`,
    });
    const result = study.proposeFromNote(note.id);
    assert.equal(result.items.length, 0);
    assert.ok(result.uebersprungen.some((entry) => /zu lang/.test(entry.grund)), 'der Grund wird genannt');
  });
});

test('createFromNote: legt genau das Angehakte an und verknüpft es', async () => {
  await withDeck(async ({ store, study }) => {
    const note = store.create('note', { title: 'Elektronik', body: NOTE_BODY });
    const proposal = study.proposeFromNote(note.id);
    const auswahl = proposal.items
      .filter((item) => item.front === 'Kondensator' || item.front === 'Spule')
      .map((item) => item.key);

    const result = study.createFromNote(note.id, auswahl, { deck: 'Elektronik' });
    assert.equal(result.created.length, 2);
    assert.deepEqual(result.created.map((c) => c.data.front).sort(), ['Kondensator', 'Spule']);
    assert.equal(result.created[0].data.deck, 'Elektronik');
    assert.equal(result.created[0].data.noteId, note.id);
    assert.equal(result.created[0].data.source, 'note');
    assert.equal(store.count('card'), 2, 'und nur das Angehakte');

    const edges = store.edges.for(result.created[0].id, { direction: 'out' });
    assert.equal(edges.length, 1, 'die Karte weiß, woher sie kommt');
    assert.equal(edges[0].data.to, note.id);
    assert.equal(edges[0].data.kind, 'derived-from');
    assert.equal(edges[0].data.source, 'derived');
    assert.ok(edges[0].data.reason, 'mit einer Begründung, wie jede Kante hier');

    // Ein zweiter Durchgang schlägt dieselben Karten vor, markiert sie aber.
    const again = study.proposeFromNote(note.id);
    const known = again.items.filter((item) => item.schonVorhanden).map((item) => item.front);
    assert.deepEqual(known.sort(), ['Kondensator', 'Spule']);
    assert.equal(again.offen, 3);

    const second = study.createFromNote(note.id, auswahl);
    assert.equal(second.created.length, 0, 'nichts doppelt');
    assert.equal(second.uebersprungen.length, 2);
    assert.match(second.uebersprungen[0].grund, /bereits eine Karte/);
  });
});

test('createFromNote: derselbe Schlüssel mehrfach ist eine Karte, nicht fünf', async () => {
  await withDeck(async ({ store, study }) => {
    const note = store.create('note', { title: 'Kurz', body: 'Alpha :: Erste Erklärung' });
    const key = study.proposeFromNote(note.id).items[0].key;

    // „Nichts doppelt" muss auch innerhalb EINES Aufrufs gelten: der Schutz
    // darf nicht an einer Momentaufnahme hängen, die vor der Schleife entstand.
    const result = study.createFromNote(note.id, [key, key, key, key, key]);
    assert.equal(result.created.length, 1, 'fünfmal derselbe Wunsch ist ein Wunsch');
    assert.equal(store.count('card'), 1);
    assert.equal(store.edges.for(result.created[0].id, { direction: 'out' }).length, 1,
      'und genau eine Kante zur Notiz');
    assert.equal(study.due().items.length, 1, 'der Stapel zeigt „Alpha" einmal');
  });
});

test('createFromNote: ein Schlüssel, den es nicht mehr gibt, wird benannt', async () => {
  await withDeck(async ({ store, study }) => {
    const note = store.create('note', { title: 'Kurz', body: 'Begriff :: Erklärung' });
    assert.throws(() => study.createFromNote(note.id, ['gibtsnicht']), /steht nicht mehr/);
    assert.throws(() => study.createFromNote(note.id, []), /auswahl/);
    assert.equal(store.count('card'), 0, 'und es wurde nichts angelegt');
  });
});

/* ----------------------------------------------- gelöschte Quellnotiz */

test('Eine gelöschte Quellnotiz setzt ihre Karten aus, statt sie zu löschen', async () => {
  await withDeck(async ({ store, study }) => {
    const note = store.create('note', { title: 'Elektronik', body: NOTE_BODY });
    const proposal = study.proposeFromNote(note.id);
    study.createFromNote(note.id, [proposal.items[0].key]);
    const cardId = study.list().items[0].id;
    const vorher = study.list().items[0].data;

    store.remove(note.id);

    const card = store.get(cardId);
    assert.ok(card, 'die Karte lebt weiter — sie trägt ihren Inhalt selbst');
    assert.equal(card.data.suspended, true, 'aber sie wird nicht mehr abgefragt');
    assert.ok(card.data.orphanedAt, 'und es ist erkennbar, warum');
    assert.equal(card.data.ease, vorher.ease, 'der Lernstand bleibt unangetastet');
    assert.equal(study.due().items.length, 0);

    store.restore(note.id);
    const zurueck = store.get(cardId);
    assert.equal(zurueck.data.suspended, false, 'mit der Notiz kommt die Karte zurück');
    assert.equal(zurueck.data.orphanedAt, null);
    assert.equal(study.due().items.length, 1);
  });
});

test('Eine von Hand ausgesetzte Karte bleibt ausgesetzt, wenn die Notiz zurückkommt', async () => {
  await withDeck(async ({ store, study }) => {
    const note = store.create('note', { title: 'Quelle', body: 'Begriff :: Erklärung' });
    const proposal = study.proposeFromNote(note.id);
    study.createFromNote(note.id, [proposal.items[0].key]);
    const cardId = study.list().items[0].id;

    study.suspend(cardId, true);
    store.remove(note.id);
    store.restore(note.id);

    assert.equal(store.get(cardId).data.suspended, true,
      'die Entscheidung des Menschen wird nicht stillschweigend zurückgenommen');
  });
});

test('stop(): nach dem Abbau hängt kein Zuhörer mehr am Bus', async () => {
  const { Bus } = require('../src/kernel/bus');
  const { home, cleanup } = tempHome('nos-study-stop');
  const bus = new Bus();
  const store = await openStore({ paths: path.join(home, 'nos'), bus, lock: false, logger: silentLogger });
  // Was der Speicher selbst schon hört, gehört nicht dem Stapel.
  const vorher = {
    geloescht: bus.listenerCount('record.deleted'),
    geaendert: bus.listenerCount('record.updated'),
  };
  const study = createStudy({ store, bus, logger: silentLogger });
  try {
    assert.ok(bus.listenerCount('record.deleted') > vorher.geloescht, 'solange er läuft, hört er zu');

    const note = store.create('note', { title: 'Quelle', body: 'Begriff :: Erklärung' });
    study.createFromNote(note.id, [study.proposeFromNote(note.id).items[0].key]);
    const cardId = study.list().items[0].id;

    study.stop();
    assert.equal(bus.listenerCount('record.deleted'), vorher.geloescht, 'danach nicht mehr');
    assert.equal(bus.listenerCount('record.updated'), vorher.geaendert);

    // Ein abgebautes Teilsystem fasst den Speicher nicht mehr an -- genau
    // deshalb ruft app.close() stop() auf.
    store.remove(note.id);
    assert.equal(store.get(cardId).data.suspended, false);

    study.stop();
    assert.equal(bus.listenerCount('record.deleted'), vorher.geloescht, 'zweimal abbauen schadet nicht');
  } finally {
    await store.close().catch(() => {});
    cleanup();
  }
});

/* ------------------------------------------------------- die Ansicht */

/**
 * Die Ansicht ist Browser-ESM, dieses Projekt ist CommonJS -- `require` kann
 * sie nicht lesen. Sie wird deshalb unverändert in ein Verzeichnis kopiert,
 * dessen package.json `"type": "module"` sagt, und von dort geladen: geprüft
 * wird die echte Datei, keine Abschrift.
 *
 * Geprüft werden hier nur ihre reinen Entscheidungen -- welcher Zustand gilt,
 * was gemessen ist und was nicht. Alles, was ein Dokument braucht, gehört in
 * einen echten Browser; dafür gibt es tools/ui-check.js.
 */
let viewModule = null;
async function studyView() {
  if (viewModule) return viewModule;
  const { pathToFileURL } = require('node:url');
  const { home, cleanup } = tempHome('nos-study-view');
  const web = path.join(__dirname, '..', 'web');
  fs.writeFileSync(path.join(home, 'package.json'), '{"type":"module"}\n');
  fs.mkdirSync(path.join(home, 'lib'));
  fs.mkdirSync(path.join(home, 'views'));
  fs.copyFileSync(path.join(web, 'lib', 'dom.js'), path.join(home, 'lib', 'dom.js'));
  fs.copyFileSync(path.join(web, 'views', 'study.js'), path.join(home, 'views', 'study.js'));
  try {
    viewModule = await import(pathToFileURL(path.join(home, 'views', 'study.js')).href);
    return viewModule;
  } finally {
    cleanup();
  }
}

test('Ansicht: welcher Zustand gilt, entscheidet eine Stelle', async () => {
  const { modeFor } = await studyView();

  assert.equal(modeFor({ queue: [], cursor: 0, sessionSize: 0 }), 'leer');
  assert.equal(modeFor({ queue: [1, 2], cursor: 0, sessionSize: 2 }), 'lernen');
  assert.equal(modeFor({ queue: [1], cursor: 1, sessionSize: 1 }), 'fertig');

  // Der Fall des ersten Tages: im Formular wurde eine Karte angelegt, die
  // Runde von vorhin ist nicht mehr der Stapel. „leer" wäre hier gelogen.
  assert.equal(modeFor({ queue: [], cursor: 0, sessionSize: 0, stale: true }), 'laden');
  assert.equal(modeFor({ queue: [1], cursor: 1, sessionSize: 1, stale: true }), 'laden');
  assert.equal(modeFor({ queue: [1, 2], cursor: 1, sessionSize: 2, stale: true }), 'lernen',
    'eine angefangene Runde wird darüber nicht weggeworfen');
});

test('Ansicht: der Fortschritt wird am Stapel gemessen, nicht mitgezählt', async () => {
  const { progressOf } = await studyView();
  const karte = (id) => ({ record: { id, data: {} } });

  // Zwei Karten; „a" wurde mit „Nochmal" bewertet und steht hinten wieder an.
  const mitten = {
    queue: [karte('a'), karte('b'), karte('a')],
    cursor: 2,
    sessionSize: 2,
    answered: new Set(['a', 'b']),
  };
  assert.deepEqual(progressOf(mitten), { erledigt: 1, gesamt: 2, offen: 1, wieder: 1 },
    'was noch einmal kommt, ist nicht geschafft');

  // Runde zu Ende: nichts steht mehr aus, also wird auch nichts versprochen.
  const ende = { ...mitten, cursor: 3 };
  assert.deepEqual(progressOf(ende), { erledigt: 2, gesamt: 2, offen: 0, wieder: 0 });

  const anfang = {
    queue: [karte('a'), karte('b')], cursor: 0, sessionSize: 2, answered: new Set(),
  };
  assert.deepEqual(progressOf(anfang), { erledigt: 0, gesamt: 2, offen: 2, wieder: 0 });
});

test('Ansicht: der leere Bildschirm behauptet nur Gemessenes', async () => {
  const { emptyMessage, nextDay } = await studyView();

  // „nicht gemessen" darf nicht unterwegs zu „es steht nichts an" werden.
  assert.equal(nextDay(undefined), undefined, 'keine Antwort ist keine Aussage');
  assert.equal(nextDay({}), undefined);
  assert.equal(nextDay({ naechste: null }), null, 'gemessen: es kommt keine');
  assert.equal(nextDay({ naechste: '2026-12-24' }), '2026-12-24');

  const leer = emptyMessage({ gesamt: 0 }, null);
  assert.match(leer.titel, /Noch keine Karten/);

  // Der Befund: eine einzige, frisch angelegte, nicht ausgesetzte Karte.
  const frisch = emptyMessage({ gesamt: 1, faellig: 1, neu: 0, ausgesetzt: 0 }, null);
  assert.doesNotMatch(frisch.satz, /ausgesetzt/, 'nichts ist ausgesetzt — also wird es nicht behauptet');
  assert.doesNotMatch(frisch.titel, /nichts fällig/, 'und „nichts fällig" wäre das Gegenteil der Zahlen');
  assert.match(frisch.satz, /1 Karte wartet/, 'sondern die gezählte Karte wird benannt');

  const alle = emptyMessage({ gesamt: 3, faellig: 0, neu: 0, ausgesetzt: 3 }, null);
  assert.match(alle.satz, /ausgesetzt/, 'wenn es zutrifft, darf es gesagt werden');

  const spaeter = emptyMessage({ gesamt: 2, faellig: 0, neu: 0, ausgesetzt: 0 }, '2026-12-24');
  assert.match(spaeter.satz, /nächste Karte/);
  assert.doesNotMatch(spaeter.satz, /ausgesetzt/);

  const ungemessen = emptyMessage({ gesamt: 2, faellig: 0, neu: 0, ausgesetzt: 1 }, undefined);
  assert.doesNotMatch(ungemessen.satz, /keine weitere Wiederholung/,
    'ohne Auskunft wird keine Auskunft erfunden');
});

/* -------------------------------------------------------------- HTTP */

// Solange `src/http/server.js` die Route noch nicht selbst lädt (die
// Verdrahtung macht jemand anderes), wird sie hier angehängt -- genauso wie
// test/assist.test.js es getan hat, als die Assistenz neu war.
const SERVER_FILE = require.resolve('../src/http/server');
if (!/require\(['"]\.\/api\/study['"]\)/.test(fs.readFileSync(SERVER_FILE, 'utf8'))) {
  const lastLoadedApi = require('../src/http/api/history');
  const originalRegister = lastLoadedApi.register;
  lastLoadedApi.register = function registerWithStudy(router) {
    originalRegister.call(this, router);
    studyApi.register(router);
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

  const { home, cleanup } = tempHome('nos-study-http');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  config.server.port = 7777;

  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const clock = { at: new Date(MORNING) };
  const study = createStudy({ store, bus, logger: silentLogger, now: () => clock.at });
  const server = await createServer({
    version: 'test', config, paths, store, bus, study, logger: silentLogger, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    const note = store.create('note', { title: 'Elektronik', body: NOTE_BODY });

    const created = await request(base, 'POST', '/api/study/cards', { front: 'Von Hand', back: 'Angelegt.' });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.record.data.front, 'Von Hand');
    assert.equal(created.json.record.data.deck, 'Standard');

    const leer = await request(base, 'POST', '/api/study/cards', { front: '   ' });
    assert.equal(leer.status, 400, leer.text);

    const queue = await request(base, 'GET', '/api/study/due?limit=5');
    assert.equal(queue.status, 200, queue.text);
    assert.equal(queue.json.items.length, 1);
    assert.equal(queue.json.items[0].vorschau.length, 4);
    assert.equal(queue.json.items[0].vorschau[2].label, 'Gut');

    const cardId = created.json.record.id;
    const falsch = await request(base, 'POST', `/api/study/cards/${cardId}/review`, { grade: 7 });
    assert.equal(falsch.status, 400, falsch.text);
    assert.match(falsch.json.error.message, /Nochmal/, 'die vier Noten werden genannt');

    const reviewed = await request(base, 'POST', `/api/study/cards/${cardId}/review`, { grade: 2 });
    assert.equal(reviewed.status, 200, reviewed.text);
    assert.equal(reviewed.json.record.data.due, '2026-09-22');
    assert.equal(reviewed.json.wann, 'morgen');

    const stats = await request(base, 'GET', '/api/study/stats');
    assert.equal(stats.json.gesamt, 1);
    assert.equal(stats.json.morgen, 1);
    assert.equal(stats.json.gelernt, 1);

    const vorschlaege = await request(base, 'GET', `/api/study/from-note/${note.id}`);
    assert.equal(vorschlaege.status, 200, vorschlaege.text);
    assert.equal(vorschlaege.json.items.length, 5);
    assert.equal(store.count('card'), 1, 'Vorschläge legen nichts an');

    const keys = vorschlaege.json.items.slice(0, 2).map((item) => item.key);
    const angelegt = await request(base, 'POST', `/api/study/from-note/${note.id}`, { auswahl: keys, deck: 'Elektronik' });
    assert.equal(angelegt.status, 200, angelegt.text);
    assert.equal(angelegt.json.created.length, 2);
    assert.equal(store.count('card'), 3);

    // Derselbe Schlüssel mehrfach in einer Anfrage: „nichts doppelt" gilt
    // auch dann, denn die Route reicht die Liste durch, wie sie kommt.
    const key = vorschlaege.json.items[2].key;
    const doppelt = await request(base, 'POST', `/api/study/from-note/${note.id}`,
      { auswahl: [key, key, key, key, key], deck: 'Doppelt' });
    assert.equal(doppelt.status, 200, doppelt.text);
    assert.equal(doppelt.json.created.length, 1, 'fünfmal derselbe Wunsch ist ein Wunsch');
    assert.equal(store.count('card'), 4);

    const fehlend = await request(base, 'GET', '/api/study/from-note/note_gibtesnicht00000000');
    assert.equal(fehlend.status, 404, fehlend.text);

    const patched = await request(base, 'PATCH', `/api/study/cards/${cardId}`, { deck: 'Anders' });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.record.data.deck, 'Anders');

    const verboten = await request(base, 'PATCH', `/api/study/cards/${cardId}`, { ease: 9 });
    assert.equal(verboten.status, 400, verboten.text);
    assert.match(verboten.json.error.message, /Lernstand/);

    const liste = await request(base, 'GET', '/api/study/cards?deck=Elektronik');
    assert.equal(liste.json.total, 2);

    const geloescht = await request(base, 'DELETE', `/api/study/cards/${cardId}`);
    assert.equal(geloescht.status, 200, geloescht.text);
    assert.equal(store.get(cardId), null);
  } finally {
    study.stop();
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    cleanup();
  }
});

test('Ohne Teilsystem antwortet die Route 503 und sagt das auf Deutsch', async () => {
  const { createServer } = require('../src/http/server');
  const { Bus } = require('../src/kernel/bus');
  const configMod = require('../src/kernel/config');
  const pathsMod = require('../src/kernel/paths');

  const { home, cleanup } = tempHome('nos-study-503');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const server = await createServer({
    version: 'test', config, paths, store, bus, logger: silentLogger, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const res = await request(base, 'GET', '/api/study/due');
    assert.equal(res.status, 503, res.text);
    assert.match(res.json.error.message, /Kartenstapel/);
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    cleanup();
  }
});

module.exports = { name: 'study', tests: drain() };
