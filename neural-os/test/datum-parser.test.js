'use strict';

/**
 * Das Feld "Neuer Termin …" im Kalender: aus einem deutschen Satz ein Termin.
 *
 * Warum so viele Faelle: jeder davon ist ein Satz, den jemand wirklich tippt,
 * und jeder falsch gelesene ist ein Termin am falschen Tag -- das Schlimmste,
 * was ein Kalender tun kann, weil man es erst merkt, wenn es zu spaet ist.
 * Die Uhr ist fest (Mittwoch, 23.09.2026, 10:00), damit "morgen" morgen bleibt.
 *
 * Geprueft wird die Datei, die der Browser laedt (web/lib/datum-parser.js),
 * unveraendert als .mjs kopiert -- wie in test/kalender-ansicht.test.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

let modul = null;
async function laden() {
  if (modul) return modul;
  const { home, cleanup } = tempHome('nos-datum');
  try {
    const ziel = path.join(home, 'datum-parser.mjs');
    fs.copyFileSync(path.join(__dirname, '..', 'web', 'lib', 'datum-parser.js'), ziel);
    modul = await import(pathToFileURL(ziel).href);
    return modul;
  } finally {
    cleanup();
  }
}

// Mittwoch, 23. September 2026, 10:00 Ortszeit.
const JETZT = new Date(2026, 8, 23, 10, 0);

/** Ein Fall: Satz -> erwartete Felder (nur die genannten werden verglichen). */
function fall(satz, erwartet, jetzt = JETZT) {
  test(`„${satz}“`, async () => {
    const { parse } = await laden();
    const r = parse(satz, jetzt);
    if (erwartet === null) {
      assert.equal(r, null, `erwartet: nichts erkannt, bekommen: ${JSON.stringify(r)}`);
      return;
    }
    assert.ok(r, 'nichts erkannt');
    for (const [k, v] of Object.entries(erwartet)) {
      assert.deepEqual(r[k], v, `${k}: ${JSON.stringify(r[k])} statt ${JSON.stringify(v)}`);
    }
  });
}

const WOECHENTLICH = (byDay, extra = {}) => ({ freq: 'weekly', interval: 1, byDay, until: null, count: null, ...extra });

/* ------------------------------------------------ die drei aus dem Auftrag */
fall('Morgen 15 Uhr Zahnarzt', { titel: 'Zahnarzt', start: '2026-09-24T15:00', end: '2026-09-24T16:00', allDay: false, recurrence: null });
fall('jeden Dienstag 18-19:30 Training', { titel: 'Training', start: '2026-09-29T18:00', end: '2026-09-29T19:30', allDay: false, recurrence: WOECHENTLICH(['TU']) });
fall('Fr 3.10. ganztägig Ausflug', { titel: 'Ausflug', start: '2026-10-03', end: null, allDay: true, hinweis: 'Der 3.10. ist ein Samstag.' });

/* ------------------------------------------------ Tage */
fall('heute', { titel: '', start: '2026-09-23', allDay: true });
fall('Morgen Zahnarzt', { titel: 'Zahnarzt', start: '2026-09-24', end: null, allDay: true });
fall('übermorgen Eltern besuchen', { titel: 'Eltern besuchen', start: '2026-09-25', allDay: true });
fall('uebermorgen Eltern besuchen', { start: '2026-09-25' });
fall('Montag 9 Uhr Team', { titel: 'Team', start: '2026-09-28T09:00', end: '2026-09-28T10:00' });
fall('Mittwoch Arzt', { start: '2026-09-23', allDay: true }); // heute ist Mittwoch: heute
fall('nächsten Mittwoch Arzt', { titel: 'Arzt', start: '2026-09-30' }); // "naechsten" ist nie heute
fall('naechsten Freitag Kino', { start: '2026-09-25' });
fall('übernächsten Freitag Kino', { start: '2026-10-02' });
fall('Sa 10 Uhr Markt', { titel: 'Markt', start: '2026-09-26T10:00' });
fall('Treffen am Di', { titel: 'Treffen', start: '2026-09-29' });
fall('am 3.10. Feier', { titel: 'Feier', start: '2026-10-03', allDay: true });
fall('am 3.10 Feier', { titel: 'Feier', start: '2026-10-03' });
fall('3. Oktober Feier', { titel: 'Feier', start: '2026-10-03' });
fall('Feier am 3. Okt. 2027', { titel: 'Feier', start: '2027-10-03' });
fall('Mo, 5.10. 9:00 Arzt', { titel: 'Arzt', start: '2026-10-05T09:00', hinweis: null });
fall('2026-11-02 Steuer', { titel: 'Steuer', start: '2026-11-02' });
fall('in 3 Tagen Paket abholen', { titel: 'Paket abholen', start: '2026-09-26' });
fall('in einer Woche Nachkontrolle', { start: '2026-09-30' });

/* ------------------------------------------------ Uhrzeiten */
fall('um 15 Uhr Kaffee', { titel: 'Kaffee', start: '2026-09-23T15:00', end: '2026-09-23T16:00' });
fall('8 Uhr Joggen', { titel: 'Joggen', start: '2026-09-24T08:00' }); // heute schon vorbei: morgen
fall('15:30 Anruf', { titel: 'Anruf', start: '2026-09-23T15:30', end: '2026-09-23T16:30' });
fall('15.30 Uhr Tee', { start: '2026-09-23T15:30' });
fall('Zahnarzt morgen um 9', { titel: 'Zahnarzt', start: '2026-09-24T09:00' });
fall('von 14 bis 16 Uhr Workshop', { titel: 'Workshop', start: '2026-09-23T14:00', end: '2026-09-23T16:00' });
fall('14-16 Uhr Workshop morgen', { titel: 'Workshop', start: '2026-09-24T14:00', end: '2026-09-24T16:00' });
fall('zwischen 9 und 11 Uhr Handwerker', { titel: 'Handwerker', start: '2026-09-24T09:00', end: '2026-09-24T11:00' }); // 9 < 10: heute vorbei, also morgen
fall('3-5 Uhr Kinderturnen', { start: '2026-09-23T15:00', end: '2026-09-23T17:00' });
fall('Party Samstag 22-2 Uhr', { titel: 'Party', start: '2026-09-26T22:00', end: '2026-09-27T02:00' });
fall('23:30 Nachtzug', { start: '2026-09-23T23:30', end: '2026-09-24T00:30' });
fall('um drei Kaffee', { titel: 'Kaffee', start: '2026-09-23T15:00' });
fall('viertel nach 4 Tee', { start: '2026-09-23T16:15' });
fall('morgen viertel vor 9 Bus', { titel: 'Bus', start: '2026-09-24T08:45' });

/* ------------------------------------------------ "halb 3" -- die Entscheidung */
// Ohne Tageszeit ist "halb 3" nachmittags (14:30): drei Uhr nachts traegt
// niemand als Termin ein. "nachts"/"frueh" drehen es um.
fall('halb 3 Kaffee', { titel: 'Kaffee', start: '2026-09-23T14:30' });
fall('morgen halb 3 nachmittags Kaffee', { titel: 'Kaffee', start: '2026-09-24T14:30' });
fall('halb 3 nachts Flug', { titel: 'Flug', start: '2026-09-24T02:30' }); // 02:30 ist heute vorbei
fall('morgen früh halb 7 Flughafen', { titel: 'Flughafen', start: '2026-09-24T06:30' });
fall('03:00 Sternschnuppen', { start: '2026-09-24T03:00' }); // zweistellig: genau so gemeint

/* ------------------------------------------------ Tageszeiten, Dauer, Ort */
fall('Kino heute Abend', { titel: 'Kino', start: '2026-09-23T19:00', end: '2026-09-23T20:00' });
fall('Abend mit Freunden', null); // "Abend" allein ist ein Wort, keine Zeit
fall('Mittagessen morgen 12:30 für 90 Min', { titel: 'Mittagessen', start: '2026-09-24T12:30', end: '2026-09-24T14:00' });
fall('Meeting morgen 10 Uhr für 2 Stunden', { titel: 'Meeting', end: '2026-09-24T12:00' });
fall('Telefonat morgen 11 Uhr eine halbe Stunde', { titel: 'Telefonat', end: '2026-09-24T11:30' });
fall('Zahnarzt @ Praxis am Markt morgen 9 Uhr', { titel: 'Zahnarzt', ort: 'Praxis am Markt', start: '2026-09-24T09:00' });
fall('in 30 Minuten Anruf bei Mama', { titel: 'Anruf bei Mama', start: '2026-09-23T10:30', end: '2026-09-23T11:30' });
fall('Treffen so gegen 15 Uhr', { titel: 'Treffen so', start: '2026-09-23T15:00' }); // "so" ist hier kein Sonntag
fall('ganztägig', { start: '2026-09-23', allDay: true, titel: '' });

/* ------------------------------------------------ mehrere Tage */
fall('3.-5.10. Ostsee', { titel: 'Ostsee', start: '2026-10-03', end: '2026-10-05', allDay: true });
fall('vom 30.9. bis 2.10. Messe', { titel: 'Messe', start: '2026-09-30', end: '2026-10-02', allDay: true });
fall('3.10.–5.10. Ostsee', { start: '2026-10-03', end: '2026-10-05' });
fall('3.–5. Oktober Herbstferien', { titel: 'Herbstferien', start: '2026-10-03', end: '2026-10-05' });
fall('vom 3.10. 10 Uhr bis 5.10. 16 Uhr Tagung', { titel: 'Tagung', start: '2026-10-03T10:00', end: '2026-10-05T16:00', allDay: false });

/* ------------------------------------------------ Wiederholungen */
fall('jeden Tag 7 Uhr Tabletten', { titel: 'Tabletten', start: '2026-09-23T07:00', recurrence: { freq: 'daily', interval: 1, until: null, count: null } });
fall('täglich 5 mal Tropfen 8 Uhr', { titel: 'Tropfen', recurrence: { freq: 'daily', interval: 1, until: null, count: 5 } });
fall('jeden Monat am 15. Miete', { titel: 'Miete', start: '2026-10-15', allDay: true, recurrence: { freq: 'monthly', interval: 1, until: null, count: null } });
fall('jedes Jahr am 12.5. Geburtstag Anna', { titel: 'Geburtstag Anna', start: '2027-05-12', recurrence: { freq: 'yearly', interval: 1, until: null, count: null } });
fall('alle 2 Wochen Fr 17 Uhr Putzen', { titel: 'Putzen', start: '2026-09-25T17:00', recurrence: WOECHENTLICH([], { interval: 2 }) });
fall('jede zweite Woche Sport', { recurrence: WOECHENTLICH([], { interval: 2 }) });
fall('alle 3 Tage Blumen gießen', { titel: 'Blumen gießen', recurrence: { freq: 'daily', interval: 3, until: null, count: null } });
fall('jeden zweiten Dienstag Elternabend 19 Uhr', { titel: 'Elternabend', start: '2026-09-29T19:00', recurrence: WOECHENTLICH(['TU'], { interval: 2 }) });
fall('jeden Dienstag bis 20.12. Training 18 Uhr', { titel: 'Training', start: '2026-09-29T18:00', recurrence: WOECHENTLICH(['TU'], { until: '2026-12-20' }) });
fall('jeden Mo und Do 19 Uhr Chor', { titel: 'Chor', start: '2026-09-24T19:00', recurrence: WOECHENTLICH(['MO', 'TH']) });
fall('dienstags und donnerstags 17 Uhr Schwimmen', { titel: 'Schwimmen', start: '2026-09-24T17:00', recurrence: WOECHENTLICH(['TU', 'TH']) });
fall('werktags 8 Uhr Stand-up', { titel: 'Stand-up', start: '2026-09-23T08:00', recurrence: WOECHENTLICH(['MO', 'TU', 'WE', 'TH', 'FR']) });
fall('ab 1.10. jeden Dienstag Kurs 18 Uhr', { titel: 'Kurs', start: '2026-10-06T18:00' }); // erster Dienstag ab dem 1.10.
// Zeitumstellung am 25.10.2026: die Wandzeit bleibt 10:00.
fall('jeden Sonntag 10 Uhr Brunch', { start: '2026-09-27T10:00', end: '2026-09-27T11:00' });
fall('25.10. 10 Uhr Brunch', { start: '2026-10-25T10:00', end: '2026-10-25T11:00' });

/* ------------------------------------------------ Monats- und Jahreswechsel */
fall('morgen Abgabe', { start: '2026-10-01' }, new Date(2026, 8, 30, 9, 0));
fall('morgen Neujahr', { start: '2027-01-01' }, new Date(2026, 11, 31, 9, 0));
fall('übermorgen Rückfahrt', { start: '2027-01-01' }, new Date(2026, 11, 30, 9, 0));
fall('3.1. Neujahrsempfang', { start: '2027-01-03' }, new Date(2026, 11, 20, 9, 0));
fall('Montag Start', { start: '2027-01-04' }, new Date(2026, 11, 30, 9, 0));
fall('vom 30.12. bis 2.1. Skiurlaub', { start: '2026-12-30', end: '2027-01-02', allDay: true }, new Date(2026, 11, 20, 9, 0));
fall('am 15. Miete', { start: '2027-01-15' }, new Date(2026, 11, 20, 9, 0));
fall('29.2. Schalttag', { start: '2028-02-29' }); // 2027 hat keinen

/* ------------------------------------------------ was nicht geht */
fall('Zahnarzt', null);
fall('', null);
fall('   ', null);
fall('31.2. Quatsch', null);
fall('Das mache ich so', null);

test('parse: kein Text ist kein Termin', async () => {
  const { parse } = await laden();
  assert.equal(parse(null, JETZT), null);
  assert.equal(parse(undefined, JETZT), null);
  assert.equal(parse(42, JETZT), null);
});

test('parse: ein Datum in der Vergangenheit bekommt einen Hinweis', async () => {
  const { parse } = await laden();
  assert.equal(parse('3.1.2020 Altes', JETZT).hinweis, 'Das liegt in der Vergangenheit.');
});

/* ------------------------------------------------ Nachbesserung Runde 1: so tippt man wirklich */
// Die Pruefer haben mit Donnerstag, 24.09.2026, 10:05 gerechnet.
const DO = new Date(2026, 8, 24, 10, 5);
const MO = new Date(2026, 8, 28, 10, 5);
const MI = new Date(2026, 8, 30, 10, 5);
// Datum ohne Schlusspunkt: mit einer Uhrzeit daneben, am Anfang, nach einem Wochentag -- oder wenn es keine Uhrzeit sein kann.
fall('Elternabend 6.10 um 19:30', { titel: 'Elternabend', start: '2026-10-06T19:30' }, DO);
fall('Konzert 2.10 20 uhr', { titel: 'Konzert', start: '2026-10-02T20:00' }, DO);
fall('Termin 10.10 um 10', { titel: 'Termin', start: '2026-10-10T10:00' }, DO);
fall('Zahnarzt 06.10 19:30', { titel: 'Zahnarzt', start: '2026-10-06T19:30' }, DO);
fall('6.10 Elternabend', { titel: 'Elternabend', start: '2026-10-06', allDay: true }, DO);
fall('Geburtstag Oma 12.3', { titel: 'Geburtstag Oma', start: '2027-03-12' }, DO);
fall('Friseur Dienstag 29.9 15 Uhr', { titel: 'Friseur', start: '2026-09-29T15:00', hinweis: null }, DO);
// ... aber eine Uhrzeit bleibt eine Uhrzeit.
fall('Treffen um 9.10', { titel: 'Treffen', start: '2026-09-25T09:10' }, DO);
fall('von 8.30 bis 9.10 Sprechstunde', { titel: 'Sprechstunde', start: '2026-09-25T08:30', end: '2026-09-25T09:10' }, DO);
fall('Pause 12.10-13.00', { titel: 'Pause', start: '2026-09-24T12:10', end: '2026-09-24T13:00' }, DO);
fall('Kurs 1.5 Stunden morgen 10 Uhr', { titel: 'Kurs', start: '2026-09-25T10:00', end: '2026-09-25T11:30' }, DO);
// "naechste Woche Mittwoch": der Mittwoch der FOLGENDEN Kalenderwoche.
fall('nächste Woche Mittwoch Friseur', { titel: 'Friseur', start: '2026-10-07' }, MO);
fall('Mittwoch nächste Woche 16 Uhr Friseur', { titel: 'Friseur', start: '2026-10-07T16:00' }, MO);
fall('kommende Woche Freitag Party', { titel: 'Party', start: '2026-10-09' }, MO);
fall('nächste Woche Mittwoch Friseur', { titel: 'Friseur', start: '2026-10-07' }, MI); // nie heute
fall('übernächste Woche Montag Zeugnis', { titel: 'Zeugnis', start: '2026-10-12' }, MO);
// "jeden Morgen": taeglich, nicht "morgen".
fall('Laufen jeden Morgen um 7', { titel: 'Laufen', start: '2026-09-24T07:00', recurrence: { freq: 'daily', interval: 1, until: null, count: null } }, DO);
fall('Laufen jeden Abend 20 Uhr', { titel: 'Laufen', start: '2026-09-24T20:00', recurrence: { freq: 'daily', interval: 1, until: null, count: null } }, DO);
fall('Laufen jeden morgen', { titel: 'Laufen', start: '2026-09-24T08:00', allDay: false }, DO);
// Wochentag in einer Woche in N Wochen.
fall('Friseur Mittwoch in einer Woche', { titel: 'Friseur', start: '2026-09-30' }, DO);
fall('Freitag in 2 Wochen Party', { titel: 'Party', start: '2026-10-09' }, DO);
fall('Zahnarzt in einer Woche am Dienstag', { titel: 'Zahnarzt', start: '2026-09-29' }, DO);
fall('morgen Mittwoch Arzt', { start: '2026-09-25', hinweis: 'Der 25.9. ist ein Freitag.' }, DO);
// "jeden 2. Donnerstag" wie "jeden zweiten Donnerstag".
fall('Müll jeden 2. Donnerstag', { titel: 'Müll', start: '2026-09-24', recurrence: WOECHENTLICH(['TH'], { interval: 2 }), hinweis: null }, DO);
fall('Müll jeden 15.', { titel: 'Müll', start: '2026-10-15', recurrence: { freq: 'monthly', interval: 1, until: null, count: null } }, DO);
// "16h" ist eine Uhrzeit, "für 2h" eine Dauer; "9.30" neben einem Datum die Uhrzeit.
fall('Fahrstunde morgen 16h', { titel: 'Fahrstunde', start: '2026-09-25T16:00', allDay: false }, DO);
fall('um 16h Fahrstunde', { titel: 'Fahrstunde', start: '2026-09-24T16:00' }, DO);
fall('treffen 16h30', { titel: 'Treffen', start: '2026-09-24T16:30' }, DO);
fall('Meeting für 2h morgen 10 Uhr', { titel: 'Meeting', start: '2026-09-25T10:00', end: '2026-09-25T12:00' }, DO);
fall('Arzt 14.10. 9.30', { titel: 'Arzt', start: '2026-10-14T09:30' }, DO);
// Keine Reste im Titel.
fall('Tanzkurs ab dem 5.10. jeden Montag 19 Uhr', { titel: 'Tanzkurs', start: '2026-10-05T19:00', recurrence: WOECHENTLICH(['MO']) }, DO);
fall('Heute Abend 7 Kino', { titel: 'Kino', start: '2026-09-24T19:00' }, DO);
// "Montag bis Freitag" ohne "jeden" ist die eine Woche, keine endlose Serie.
fall('Praktikum Montag bis Freitag', { titel: 'Praktikum', start: '2026-09-28', end: '2026-10-02', allDay: true, recurrence: null }, DO);
fall('jeden Montag bis Freitag Frühdienst', { titel: 'Frühdienst', recurrence: WOECHENTLICH(['MO', 'TU', 'WE', 'TH', 'FR']) }, DO);
fall('montags bis freitags Frühdienst', { recurrence: WOECHENTLICH(['MO', 'TU', 'WE', 'TH', 'FR']) }, DO);

/* ------------------------------------------------ Vorschau und Worte */

test('beschreibe: die Vorschau unter dem Feld', async () => {
  const { parse, beschreibe } = await laden();
  assert.equal(beschreibe(parse('Morgen 15 Uhr Zahnarzt', JETZT), JETZT), 'Do., 24. Sept. · 15:00–16:00 · Zahnarzt');
  assert.equal(beschreibe(parse('Fr 3.10. ganztägig Ausflug', JETZT), JETZT), 'Sa., 3. Okt. · ganztägig · Ausflug');
  assert.equal(beschreibe(parse('3.-5.10. Ostsee', JETZT), JETZT), 'Sa., 3. – Mo., 5. Okt. · ganztägig · Ostsee');
  assert.equal(beschreibe(parse('jeden Dienstag 18-19:30 Training', JETZT), JETZT),
    'Di., 29. Sept. · 18:00–19:30 · Training · jeden Dienstag');
  assert.equal(beschreibe(parse('Party Samstag 22-2 Uhr', JETZT), JETZT), 'Sa., 26. Sept. · 22:00 – So. 02:00 · Party');
  assert.equal(beschreibe(parse('3.1. Neujahrsempfang', JETZT), JETZT), 'So., 3. Jan. 2027 · ganztägig · Neujahrsempfang');
  assert.equal(beschreibe(parse('morgen 9 Uhr', JETZT), JETZT), 'Do., 24. Sept. · 09:00–10:00 · Ohne Titel');
  assert.equal(beschreibe(null), '');
});

test('wiederholungInWorten: so, wie man es sagt', async () => {
  const { wiederholungInWorten: w } = await laden();
  const di = '2026-09-29T18:00';
  assert.equal(w({ freq: 'daily', interval: 1 }, di), 'Täglich');
  assert.equal(w({ freq: 'daily', interval: 2 }, di), 'Alle 2 Tage');
  assert.equal(w({ freq: 'weekly', interval: 1, byDay: ['TU'] }, di), 'Jeden Dienstag');
  assert.equal(w({ freq: 'weekly', interval: 1, byDay: [] }, di), 'Jeden Dienstag', 'leer = Wochentag des Beginns');
  assert.equal(w({ freq: 'weekly', interval: 1, byDay: ['TU'], until: '2026-12-20' }, di), 'Jeden Dienstag bis 20. Dez.');
  assert.equal(w({ freq: 'weekly', interval: 1, byDay: ['TU'], until: '2027-01-12' }, di), 'Jeden Dienstag bis 12. Jan. 2027');
  assert.equal(w({ freq: 'weekly', interval: 2, byDay: ['TU'] }, di), 'Alle 2 Wochen am Dienstag');
  assert.equal(w({ freq: 'weekly', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }, di), 'Werktags');
  assert.equal(w({ freq: 'weekly', interval: 1, byDay: ['TH', 'MO'] }, di), 'Jeden Montag und Donnerstag');
  assert.equal(w({ freq: 'weekly', interval: 1, byDay: ['MO', 'WE', 'FR'] }, di), 'Jeden Montag, Mittwoch und Freitag');
  assert.equal(w({ freq: 'monthly', interval: 1 }, '2026-10-15'), 'Jeden Monat am 15.');
  assert.equal(w({ freq: 'monthly', interval: 3 }, '2026-10-15'), 'Alle 3 Monate am 15.');
  assert.equal(w({ freq: 'yearly', interval: 1 }, '2027-05-12'), 'Jedes Jahr am 12. Mai');
  assert.equal(w({ freq: 'daily', interval: 1, count: 5 }, di), 'Täglich, 5-mal');
  assert.equal(w(null, di), '');
});

test('Wandzeit: Tag fuer Tag gerechnet, auch ueber die Zeitumstellung', async () => {
  const d = await laden();
  assert.equal(d.plusTage('2026-10-24', 2), '2026-10-26');
  assert.equal(d.plusTage('2026-12-31', 1), '2027-01-01');
  assert.equal(d.plusTage('2028-02-28', 1), '2028-02-29');
  assert.equal(d.plusMinuten('2026-10-18T10:00', 7 * 1440), '2026-10-25T10:00', 'eine Woche spaeter ist wieder 10:00');
  assert.equal(d.plusMinuten('2026-09-23T23:30', 60), '2026-09-24T00:30');
  assert.equal(d.plusMinuten('2026-09-23', 90), '2026-09-23T01:30');
  assert.equal(d.minutenZwischen('2026-10-24T10:00', '2026-10-25T10:00'), 1440);
  assert.equal(d.tageZwischen('2026-12-30', '2027-01-02'), 3);
  assert.equal(d.wochentag('2026-09-23'), 2, 'Mittwoch');
  assert.equal(d.wochentag('2026-09-27'), 6, 'Sonntag');
  assert.equal(d.gibtEs(2026, 2, 29), false);
  assert.equal(d.gibtEs(2028, 2, 29), true);
  assert.equal(d.tagKurz('2026-09-24', JETZT), 'Do., 24. Sept.', 'deutsche Kurzform mit Punkt, wie Intl de-DE');
});
