'use strict';

/**
 * Die Kalender-Werkzeuge der KI, direkt aufgerufen -- die Faelle, in denen
 * ein Satz des Nutzers ("ab jetzt um 19 Uhr", "ach, das ist jeden Dienstag")
 * frueher still etwas anderes im Kalender hinterliess, als gemeint war.
 *
 * Echte Anwendung (createApp: Tresor, Bus, Aenderungsverlauf), die Werkzeuge
 * aus src/models/werkzeuge.js ohne Claude davor: hier geht es darum, was
 * Neural OS aus einem Aufruf MACHT, nicht darum, welchen Aufruf Claude
 * waehlt (das zeigt test/termin-agent.test.js mit dem Statisten).
 *
 * Zeitzone Europe/Berlin, wo die Zeitumstellung eine Rolle spielt (29.03.,
 * 25.10.2026) -- Node liest process.env.TZ bei jeder Zuweisung neu.
 */

const assert = require('node:assert/strict');
const { test, tempHome } = require('./harness');
const { createApp } = require('../src/app');
const { createWerkzeuge } = require('../src/models/werkzeuge');
const kalender = require('../src/http/api/events');
const ics = require('../src/kalender/ics');

async function mitWerkzeugen(fn, { tz = 'Europe/Berlin' } = {}) {
  const vorherTz = process.env.TZ;
  process.env.TZ = tz;
  const { home, cleanup } = tempHome('nos-termin-werkzeuge');
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
  try {
    const store = app.store;
    const chat = store.create('chat', { title: 'Termine' });
    const werkzeuge = createWerkzeuge({ store, bus: app.bus });
    let n = 0;
    const rufe = (name, input) => {
      n += 1;
      const r = werkzeuge.ausfuehren({ id: `toolu_${n}`, name, input }, undefined, { chatId: chat.id });
      return { fehler: r.toolResult.is_error === true, inhalt: JSON.parse(r.toolResult.content), produced: r.produced };
    };
    const starts = (titel, von = '2026-08-01', bis = '2027-06-30') => kalender.eventsInRange(store, von, bis)
      .filter((x) => x.data.title === titel).map((x) => x.data.start);
    await fn({ app, store, rufe, starts, history: app.history });
  } finally {
    await app.close().catch(() => {});
    cleanup();
    if (vorherTz === undefined) delete process.env.TZ;
    else process.env.TZ = vorherTz;
  }
}

/* ------------------------------------------------ Serie als Ganzes aendern */

test('termine_lesen nennt den Beginn der ganzen Serie (serie_start/serie_end)', async () => {
  await mitWerkzeugen(async ({ rufe }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Training', start: '2026-09-01T18:00', ende: '2026-09-01T19:30', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich', anzahl: 10 },
    });
    assert.equal(a.fehler, false, JSON.stringify(a.inhalt));
    const l = rufe('termine_lesen', { von: '2026-09-24', bis: '2026-10-31', suche: 'Training' });
    const erstes = l.inhalt.termine[0];
    assert.equal(erstes.vorkommen, '2026-09-29');
    assert.equal(erstes.serie_start, '2026-09-01T18:00', 'ohne ihn hielte Claude den 29.09. fuer den Anfang');
    assert.equal(erstes.serie_end, '2026-09-01T19:30');
  });
});

test('„Ab jetzt um 19 Uhr“ ohne ab_am: die ganze Serie verschiebt sich, Beginn und Anzahl bleiben', async () => {
  await mitWerkzeugen(async ({ rufe, starts }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Training', start: '2026-09-01T18:00', ende: '2026-09-01T19:30', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich', anzahl: 10 },
    });
    // So schickt es Claude nach termine_lesen: das Vorkommen vom 29.09. mit neuer Uhrzeit.
    const r = rufe('termin_aendern', { id: a.inhalt.id, start: '2026-09-29T19:00' });
    assert.equal(r.fehler, false, JSON.stringify(r.inhalt));
    const liste = starts('Training');
    assert.equal(liste.length, 10, 'zehnmal bleibt zehnmal');
    assert.equal(liste[0], '2026-09-01T19:00', 'der 01.09. bleibt der Beginn, nur um 19 Uhr');
    assert.equal(liste[9], '2026-11-03T19:00', 'und die Serie laeuft nicht laenger');
    // Die Dauer blieb (19:00-20:30), auch ueber die Zeitumstellung am 25.10.
    assert.equal(r.inhalt.end, '2026-09-01T20:30');
  });
});

test('„Ab jetzt mittwochs“ mit ab_am: fruehere Vorkommen bleiben, ab dem Tag eine neue Serie -- rueckgaengig in einem Schritt', async () => {
  await mitWerkzeugen(async ({ rufe, starts, store, history }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Chor', start: '2026-09-01T19:30', ende: '2026-09-01T21:00', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich', anzahl: 10 },
    });
    const r = rufe('termin_aendern', { id: a.inhalt.id, ab_am: '2026-09-29', start: '2026-09-30T19:30' });
    assert.equal(r.fehler, false, JSON.stringify(r.inhalt));
    assert.notEqual(r.inhalt.id, a.inhalt.id, 'ab dem Tag eine neue Serie mit eigener id');
    assert.equal(r.inhalt.serie_bisher, a.inhalt.id);
    const liste = starts('Chor');
    assert.deepEqual(liste.slice(0, 5), [
      '2026-09-01T19:30', '2026-09-08T19:30', '2026-09-15T19:30', '2026-09-22T19:30', // vorbei: dienstags, wie es war
      '2026-09-30T19:30', // ab dann mittwochs
    ]);
    assert.equal(liste.length, 10, 'die Anzahl gilt fuer beide Teile zusammen');
    assert.equal(store.get(r.inhalt.id).data.fortsetzungVon.id, a.inhalt.id);

    // Ein Rueckgaengig nimmt beide Haelften zurueck (eine Verlaufsgruppe).
    const eintrag = history.list({ type: 'event', limit: 5 }).items.find((e) => e.id === r.inhalt.id);
    await history.undo(eintrag.seq);
    assert.equal(starts('Chor').length, 10);
    assert.equal(starts('Chor')[4], '2026-09-29T19:30', 'wieder dienstags');
    assert.equal(store.get(r.inhalt.id), null, 'die neue Serie ist weg');
  });
});

test('termin_aendern auf einem Tag, an dem die Serie nicht stattfindet: klarer Fehler, nichts geaendert', async () => {
  await mitWerkzeugen(async ({ rufe, starts }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Yoga', start: '2026-09-03T18:00', ende: '2026-09-03T19:00', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich' },
    });
    const vorher = starts('Yoga', '2026-09-01', '2026-10-31');
    const r = rufe('termin_aendern', { id: a.inhalt.id, start: '2026-09-30T18:00' }); // ein Mittwoch
    assert.equal(r.fehler, true);
    assert.match(r.inhalt.fehler, /findet „Yoga“ nicht statt/);
    assert.match(r.inhalt.fehler, /ab_am/);
    assert.deepEqual(starts('Yoga', '2026-09-01', '2026-10-31'), vorher);
  });
});

/* ------------------------------------------------ doppelt anlegen */

test('Doppelt angelegt, aber mit Wiederholung: der vorhandene Termin wird zur Serie, nicht verschluckt', async () => {
  await mitWerkzeugen(async ({ rufe, starts }) => {
    rufe('termin_anlegen', { titel: 'Chor', start: '2026-09-30T19:30', ende: '2026-09-30T21:00', ganztaegig: false });
    const r = rufe('termin_anlegen', {
      titel: 'Chor', start: '2026-09-30T19:30', ende: '2026-09-30T21:00', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich' },
    });
    assert.equal(r.fehler, false);
    assert.equal(r.inhalt.schonDa, true, 'kein zweiter Termin');
    assert.deepEqual(r.inhalt.ergaenzt, ['Wiederholung']);
    assert.match(r.inhalt.hinweis, /ergänzt: Wiederholung/);
    assert.equal(starts('Chor', '2026-10-01', '2026-10-31').length, 4, 'vier Mittwoche im Oktober');
    assert.equal(starts('Chor', '2026-09-30', '2026-09-30').length, 1, 'und nichts doppelt');
  });
});

test('Doppelt angelegt mit Ende, Ort und Erinnerung: die neuen Angaben kommen an', async () => {
  await mitWerkzeugen(async ({ rufe, store }) => {
    const a = rufe('termin_anlegen', { titel: 'Training', start: '2026-10-06T18:00', ganztaegig: false });
    const r = rufe('termin_anlegen', {
      titel: 'training', start: '2026-10-06T18:00', ende: '2026-10-06T20:00', ganztaegig: false,
      ort: 'Halle 5', erinnerung_minuten: 60,
    });
    assert.equal(r.inhalt.id, a.inhalt.id);
    assert.deepEqual(r.inhalt.ergaenzt, ['Ende', 'Ort', 'Erinnerung']);
    const d = store.get(a.inhalt.id).data;
    assert.equal(d.end, '2026-10-06T20:00');
    assert.equal(d.location, 'Halle 5');
    assert.equal(d.reminder, 60);
    // Genau gleich noch einmal: jetzt wirklich nichts zu tun.
    const nochmal = rufe('termin_anlegen', {
      titel: 'Training', start: '2026-10-06T18:00', ende: '2026-10-06T20:00', ganztaegig: false, ort: 'Halle 5',
    });
    assert.deepEqual(nochmal.inhalt.ergaenzt, []);
    assert.match(nochmal.inhalt.hinweis, /genau so/);
  });
});

/* ------------------------------------------------ Wochentage und Beginn */

test('Serie mit Wochentagen, deren Beginn auf keinem liegt: KI, Kalender und Kalenderdatei nennen dieselben Tage', async () => {
  await mitWerkzeugen(async ({ rufe, starts, store }) => {
    // "Ab heute jeden Montag und Mittwoch 8 Uhr Schwimmen" -- heute ist Donnerstag.
    const r = rufe('termin_anlegen', {
      titel: 'Schwimmen', start: '2026-09-24T08:00', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich', wochentage: ['MO', 'MI'] },
    });
    assert.equal(r.fehler, false);
    assert.equal(r.inhalt.start, '2026-09-28T08:00', 'der Beginn liegt auf dem ersten echten Vorkommen');
    assert.match(r.inhalt.wann, /^Mo\. 28\.09\.2026/, 'Claude bestaetigt den Montag, nicht den Donnerstag');
    assert.match(r.inhalt.hinweis_beginn, /beginnt am Mo\. 28\.09\.2026/);
    assert.deepEqual(starts('Schwimmen', '2026-09-20', '2026-10-01'), ['2026-09-28T08:00', '2026-09-30T08:00']);
    const datei = ics.kalenderDatei([store.get(r.inhalt.id)]);
    assert.match(datei, /DTSTART:20260928T080000/, 'DTSTART zaehlt nach RFC 5545 immer mit -- er muss ein Vorkommen sein');

    // Mit Anzahl: dieselben drei Tage hier wie auf dem iPad.
    const k = rufe('termin_anlegen', {
      titel: 'Kurs', start: '2026-09-23T10:00', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich', wochentage: ['MO', 'FR'], anzahl: 3 },
    });
    assert.deepEqual(starts('Kurs'), ['2026-09-25T10:00', '2026-09-28T10:00', '2026-10-02T10:00']);
    assert.match(ics.kalenderDatei([store.get(k.inhalt.id)]), /DTSTART:20260925T100000\r\n/);
  });
});

test('Aeltere Serie mit falschem Beginn: die Kalenderdatei legt DTSTART trotzdem auf das erste Vorkommen', () => {
  const datei = ics.kalenderDatei([{
    id: 'event_alt',
    data: {
      title: 'Werktags', start: '2026-09-26T08:00', end: '2026-09-26T09:00', allDay: false,
      recurrence: { freq: 'weekly', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], until: null, count: null }, exdates: [],
    },
  }]);
  assert.match(datei, /DTSTART:20260928T080000/);
  assert.match(datei, /DTEND:20260928T090000/);
});

/* ------------------------------------------------ Serie loeschen */

test('termin_loeschen einer Serie nimmt ihre verschobenen Vorkommen mit -- und rueckgaengig holt alle zurueck', async () => {
  await mitWerkzeugen(async ({ rufe, store, history }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Training', start: '2026-10-06T18:00', ende: '2026-10-06T19:00', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich' },
    });
    const verlegt = rufe('termin_aendern', { id: a.inhalt.id, nur_am: '2026-10-13', start: '2026-10-14T18:00' });
    assert.equal(verlegt.fehler, false);
    const r = rufe('termin_loeschen', { id: a.inhalt.id });
    assert.equal(r.fehler, false);
    assert.equal(r.inhalt.mitgeloescht.length, 1);
    assert.match(r.inhalt.hinweis, /samt einem verschobenen Vorkommen/);
    const uebrig = kalender.eventsInRange(store, '2026-10-01', '2026-12-31').filter((x) => /Training/.test(x.data.title));
    assert.deepEqual(uebrig, [], 'kein verlegtes Training bleibt allein zurueck');

    const eintrag = history.list({ type: 'event', limit: 5 }).items[0];
    await history.undo(eintrag.seq);
    const zurueck = kalender.eventsInRange(store, '2026-10-01', '2026-10-31').filter((x) => /Training/.test(x.data.title));
    assert.ok(zurueck.some((x) => x.data.start === '2026-10-14T18:00'), 'das verlegte Vorkommen ist wieder da');
    assert.ok(zurueck.some((x) => x.data.start === '2026-10-20T18:00'), 'die Serie auch');
  });
});

/* ------------------------------------------------ Zeitumstellung */

test('Zeitumstellung am 29.03.: 02:45 liegt vor 03:00, und „wann“ nennt die Uhrzeit, die gespeichert ist', async () => {
  await mitWerkzeugen(async ({ rufe, store }) => {
    const r = rufe('termin_anlegen', { titel: 'Nacht', start: '2026-03-29T02:30', ganztaegig: false });
    assert.equal(r.fehler, false);
    assert.equal(r.inhalt.start, '2026-03-29T02:30');
    assert.match(r.inhalt.wann, /02:30/, 'nicht 03:30');
    const b = rufe('termin_anlegen', { titel: 'Kurz', start: '2026-03-29T02:45', ende: '2026-03-29T03:00', ganztaegig: false });
    assert.equal(b.fehler, false, JSON.stringify(b.inhalt));
    // Ueber die Route genauso, und ein Vorkommen an diesem Tag laesst sich aendern.
    const s = kalender.createEvent(store, {
      title: 'Serie', start: '2026-03-27T02:30', end: '2026-03-27T03:00', recurrence: { freq: 'daily' },
    });
    const neu = kalender.updateEvent(store, s.id, { title: 'Umbenannt' }, { nur: '2026-03-29' });
    assert.equal(neu.data.start, '2026-03-29T02:30');
  });
});

test('Eine Serie mit Ende MIT Zone wird abgelehnt -- sonst verloere jedes Vorkommen sein Ende', async () => {
  await mitWerkzeugen(async ({ store }) => {
    assert.throws(() => kalender.createEvent(store, {
      title: 'Mix', start: '2026-10-20T18:00', end: '2026-10-20T19:00:00+02:00', recurrence: { freq: 'weekly' },
    }), /Uhrzeit vor Ort/);
  });
});

/* ------------------------------------------------ Beschreibungen */

test('Die Werkzeugbeschreibung sagt, dass ein ganztaegiges Ende der letzte Tag EINSCHLIESSLICH ist', () => {
  const { DEFINITIONEN } = require('../src/models/werkzeuge');
  const anlegen = DEFINITIONEN.find((d) => d.name === 'termin_anlegen').input_schema.properties.ende.description;
  const aendern = DEFINITIONEN.find((d) => d.name === 'termin_aendern').input_schema.properties.end.description;
  assert.match(anlegen, /einschließlich/);
  assert.match(anlegen, /5\. bis 9\.10\.“ = ende 9\.10\./);
  assert.match(aendern, /einschließlich/);
});
