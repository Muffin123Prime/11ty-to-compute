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
  createStudy, schedule, readNote, dayKey, addDays,
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
