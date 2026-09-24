'use strict';

/**
 * Wiederkehrende Termine: src/kalender/wiederholung.js.
 *
 * Die reinen Rechnungen, ohne Server. Jede Regel hier ist eine, bei der ein
 * Kalender still das Falsche tut, wenn sie nicht stimmt: das Training am
 * Dienstag nach der Zeitumstellung um 17 statt 18 Uhr, ein "monatlich am
 * 31." am 30. November, ein Geburtstag am 29.02. im Jahr 2027.
 *
 * Die Zeitumstellung wird mit TZ=Europe/Berlin geprueft (am 25.10.2026 wird
 * die Uhr zurueckgestellt). Node liest process.env.TZ bei jeder Zuweisung neu;
 * danach wird der alte Wert wiederhergestellt, damit andere Tests nichts davon
 * merken.
 */

const assert = require('node:assert/strict');
const { test } = require('./harness');
const w = require('../src/kalender/wiederholung');

function inBerlin(fn) {
  const vorher = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  try {
    return fn();
  } finally {
    if (vorher === undefined) delete process.env.TZ;
    else process.env.TZ = vorher;
  }
}

const regel = (r) => ({ freq: 'weekly', interval: 1, byDay: [], until: null, count: null, ...r });

test('„Jeden Dienstag 18 Uhr Training bis Weihnachten“: genau die Dienstage von Oktober bis Dezember', () => {
  const training = {
    title: 'Training',
    start: '2026-09-29T18:00',
    end: '2026-09-29T19:30',
    recurrence: w.regelPruefen({ freq: 'weekly', until: '2026-12-24' }, '2026-09-29'),
    exdates: [],
  };
  assert.deepEqual(training.recurrence, { freq: 'weekly', interval: 1, byDay: [], until: '2026-12-24', count: null });
  const tage = w.vorkommenImZeitraum(training, '2026-10-01', '2026-12-31');
  assert.deepEqual(tage, [
    '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27',
    '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24',
    '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22',
  ], 'der 29.09. liegt vor dem Zeitraum, der 29.12. nach Weihnachten');
  assert.ok(tage.every((t) => w.wochentag(t) === 'TU'), 'alles Dienstage');
});

test('Nach der Zeitumstellung (25.10.2026) ist das Training am 27.10. weiter um 18:00 Wandzeit', () => {
  inBerlin(() => {
    const training = { start: '2026-10-20T18:00', end: '2026-10-20T19:30', recurrence: regel({}), exdates: [] };
    const lage = w.aufTagLegen(training, '2026-10-27');
    assert.equal(lage.start, '2026-10-27T18:00');
    assert.equal(lage.end, '2026-10-27T19:30');
    const lokal = new Date(2026, 9, 27, 18, 0);
    assert.equal(lokal.getHours(), 18);
    // Die falsche Rechnung, gegen die das hier schuetzt: +7 x 24 Stunden.
    const naiv = new Date(new Date(2026, 9, 20, 18, 0).getTime() + 7 * 24 * 3600 * 1000);
    assert.equal(naiv.getHours(), 17, 'Gegenprobe: mit Millisekunden gerechnet waere es 17 Uhr');
    assert.ok(w.istVorkommen(training, '2026-10-27'));
  });
});

test('Monatlich am 31.: im November faellt es aus (RFC 5545), es wird nicht auf den 30. geschoben', () => {
  const miete = { start: '2026-10-31', allDay: true, recurrence: w.regelPruefen({ freq: 'monthly' }, '2026-10-31'), exdates: [] };
  assert.deepEqual(w.vorkommenImZeitraum(miete, '2026-10-01', '2027-04-30'),
    ['2026-10-31', '2026-12-31', '2027-01-31', '2027-03-31']);
  assert.equal(w.istVorkommen(miete, '2026-11-30'), false, 'kein Ersatztermin am 30.11.');
  assert.equal(w.naechstesVorkommen(miete, '2026-11-01'), '2026-12-31');
});

test('Jaehrlich am 29.02. nur in Schaltjahren -- auch ueber 2100 (kein Schaltjahr) hinweg', () => {
  const geburtstag = { start: '2024-02-29', allDay: true, recurrence: w.regelPruefen({ freq: 'yearly' }, '2024-02-29'), exdates: [] };
  assert.deepEqual(w.vorkommenImZeitraum(geburtstag, '2024-01-01', '2033-12-31'), ['2024-02-29', '2028-02-29', '2032-02-29']);
  assert.equal(w.naechstesVorkommen(geburtstag, '2096-03-01'), '2104-02-29', '2100 ist kein Schaltjahr');
  assert.equal(w.istVorkommen(geburtstag, '2027-02-28'), false);
});

test('count zaehlt jedes erzeugte Vorkommen, auch ausgelassene; until gehoert dazu', () => {
  const kurs = {
    start: '2026-10-05T17:00',
    recurrence: w.regelPruefen({ freq: 'weekly', count: 3 }, '2026-10-05'),
    exdates: ['2026-10-12'],
  };
  assert.deepEqual(w.vorkommenImZeitraum(kurs, '2026-10-01', '2026-12-31'), ['2026-10-05', '2026-10-19'],
    'drei Termine, einer davon ausgelassen -- der vierte kommt NICHT dazu');
  const taeglich = { start: '2026-10-01T07:00', recurrence: w.regelPruefen({ freq: 'daily', interval: 2, until: '2026-10-07' }, '2026-10-01'), exdates: [] };
  assert.deepEqual(w.vorkommenImZeitraum(taeglich, '2026-09-01', '2026-12-31'), ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07']);
});

test('Woechentlich an mehreren Tagen, alle zwei Wochen; Wochen beginnen am Montag', () => {
  // Beginn Mittwoch, 30.09.2026: Mo und Mi, jede zweite Woche.
  const r = { start: '2026-09-30T08:00', recurrence: w.regelPruefen({ freq: 'weekly', interval: 2, byDay: ['WE', 'MO'] }, '2026-09-30'), exdates: [] };
  assert.deepEqual(r.recurrence.byDay, ['MO', 'WE'], 'in Wochenreihenfolge gespeichert');
  assert.deepEqual(w.vorkommenImZeitraum(r, '2026-09-28', '2026-10-31'),
    ['2026-09-30', '2026-10-12', '2026-10-14', '2026-10-26', '2026-10-28'],
    'der Montag 28.09. liegt vor dem Beginn; die Woche vom 5.10. faellt aus');
});

test('Ein Vorkommen ueber Mitternacht und ein mehrtaegiges ragen in den Zeitraum hinein', () => {
  const nacht = { start: '2026-10-05T22:00', end: '2026-10-06T02:00', recurrence: regel({}), exdates: [] };
  assert.deepEqual(w.vorkommenImZeitraum(nacht, '2026-10-13', '2026-10-13'), ['2026-10-12'], 'begann am Montag, reicht in den Dienstag');
  const bisMitternacht = { start: '2026-10-05T22:00', end: '2026-10-06T00:00', recurrence: regel({}), exdates: [] };
  assert.deepEqual(w.vorkommenImZeitraum(bisMitternacht, '2026-10-13', '2026-10-13'), [], 'wer um Mitternacht endet, belegt den Folgetag nicht');
  assert.deepEqual(w.aufTagLegen(nacht, '2026-10-12'), { start: '2026-10-12T22:00', end: '2026-10-13T02:00' });
});

test('Eine taegliche Serie seit 1990 zaehlt nicht 13 000 Tage durch, um heute zu finden', () => {
  const alt = { start: '1990-01-01T06:30', recurrence: regel({ freq: 'daily' }), exdates: [] };
  let schritte = 0;
  for (const d of w.erzeugen('1990-01-01', alt.recurrence, w.tagZahl('2026-10-01'))) {
    schritte += 1;
    if (d >= w.tagZahl('2026-10-03')) break;
  }
  assert.ok(schritte <= 5, `${schritte} Schritte`);
  assert.deepEqual(w.vorkommenImZeitraum(alt, '2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('Die Regel wird streng geprueft -- mit einem Satz je Fehler', () => {
  const nein = (r, muster, start = '2026-10-01') => assert.throws(() => w.regelPruefen(r, start), (err) => {
    assert.equal(err.code, 'VALIDATION_FAILED');
    assert.match(err.message, muster);
    return true;
  });
  nein({ freq: 'hourly' }, /freq/);
  nein({ freq: 'weekly', interval: 0 }, /interval/);
  nein({ freq: 'weekly', interval: 100 }, /interval/);
  nein({ freq: 'weekly', interval: 1.5 }, /interval/);
  nein({ freq: 'weekly', byDay: ['DI'] }, /byDay/);
  nein({ freq: 'weekly', byDay: ['MO', 'MO'] }, /doppelt/);
  nein({ freq: 'monthly', byDay: ['MO'] }, /wöchentlich/);
  nein({ freq: 'weekly', until: '2026-02-30' }, /until/);
  nein({ freq: 'weekly', until: '2026-09-01' }, /bevor sie beginnt/);
  nein({ freq: 'weekly', count: 0 }, /count/);
  nein({ freq: 'weekly', count: 1000 }, /count/);
  nein({ freq: 'weekly', until: '2026-12-24', count: 3 }, /nicht beides/);
  nein({ freq: 'weekly', jeden: 'Dienstag' }, /kennt das Feld "jeden"/);
  nein('woechentlich', /Objekt/);
  assert.equal(w.regelPruefen(null, '2026-10-01'), null);
  assert.throws(() => w.ausnahmenPruefen(['2026-13-01']), /exdates/);
  assert.deepEqual(w.ausnahmenPruefen(['2026-10-13', '2026-10-06', '2026-10-13']), ['2026-10-06', '2026-10-13']);
  assert.throws(() => w.erinnerungPruefen(7), /reminder/);
  assert.equal(w.erinnerungPruefen(1440), 1440);
});

test('In Worten steht die Serie so da, wie sie gespeichert ist', () => {
  assert.equal(w.inWorten({ freq: 'weekly', interval: 1, byDay: [], until: '2026-12-24', count: null }, '2026-09-29'), 'jeden Dienstag bis 24.12.2026');
  assert.equal(w.inWorten({ freq: 'weekly', interval: 2, byDay: ['MO', 'TH'], until: null, count: null }, '2026-09-28'), 'alle 2 Wochen am Mo, Do');
  assert.equal(w.inWorten({ freq: 'monthly', interval: 1, byDay: [], until: null, count: 5 }, '2026-10-31'), 'jeden Monat am 31., 5-mal');
  assert.equal(w.inWorten({ freq: 'yearly', interval: 1, byDay: [], until: null, count: null }, '2024-02-29'), 'jedes Jahr am 29.02.');
});
