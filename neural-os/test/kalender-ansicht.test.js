'use strict';

/**
 * Die reinen Funktionen hinter Kalender, Notizwand und Projektliste --
 * ohne Browser.
 *
 * Ein Kalender ist nur so gut wie seine Datumsrechnung: ein Monatsblatt, das
 * am Sonntag beginnt, eine KW 1 zur falschen Woche, ein 31. Januar plus ein
 * Monat, der im Maerz landet -- das sieht in jedem Bildschirmfoto richtig aus,
 * bis es der falsche Monat ist. Deshalb werden die Funktionen hier direkt
 * geprueft.
 *
 * Die Ansichten sind Browser-Module (web/**, ESM ohne Bauschritt), das Paket
 * ist CommonJS. Wie in test/compare.test.js wird der Quelltext deshalb
 * unveraendert in ein Wegwerf-Verzeichnis kopiert und bekommt nur die Endung
 * .mjs -- geprueft wird genau das, was der Browser laedt.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

const loaded = new Map();
/** Eine Ansicht (web/views) -- oder mit ordner 'lib' ein Baustein aus web/lib. */
async function load(view, ordner = 'views') {
  const schluessel = `${ordner}/${view}`;
  if (loaded.has(schluessel)) return loaded.get(schluessel);
  const web = path.join(__dirname, '..', 'web');
  const { home, cleanup } = tempHome('nos-kal-view');
  const asModule = (src) => src.replace(/(from\s+')([^']+)\.js(')/g, (m, head, spec, tail) => `${head}./${path.basename(spec)}.mjs${tail}`);
  const copy = (from, to) => fs.writeFileSync(path.join(home, to), asModule(fs.readFileSync(from, 'utf8')));
  for (const file of fs.readdirSync(path.join(web, 'lib'))) {
    if (file.endsWith('.js')) copy(path.join(web, 'lib', file), file.replace(/\.js$/, '.mjs'));
  }
  if (ordner !== 'lib') copy(path.join(web, ordner, `${view}.js`), `${view}.mjs`);
  try {
    const mod = await import(pathToFileURL(path.join(home, `${view}.mjs`)).href);
    loaded.set(schluessel, mod);
    return mod;
  } finally {
    cleanup();
  }
}

/* ---------------------------------------------------------------- Kalender */

test('monthGrid: ganze Wochen von Montag bis Sonntag, vier bis sechs Zeilen', async () => {
  const k = await load('kalender');
  const sept = k.monthGrid('2026-09-23');
  assert.equal(sept.length, 5);
  assert.equal(sept[0][0], '2026-08-31', 'der 1. September 2026 ist ein Dienstag: das Blatt beginnt am Montag davor');
  assert.equal(sept[4][6], '2026-10-04');
  for (const week of sept) assert.equal(week.length, 7);

  // Februar 2027 beginnt an einem Montag und hat 28 Tage: genau vier Zeilen.
  const feb = k.monthGrid('2027-02-10');
  assert.equal(feb.length, 4);
  assert.deepEqual([feb[0][0], feb[3][6]], ['2027-02-01', '2027-02-28']);

  // August 2026 beginnt an einem Samstag und endet an einem Montag: sechs Zeilen.
  assert.equal(k.monthGrid('2026-08-01').length, 6);
});

test('isoWeek: KW nach ISO 8601, auch am Jahreswechsel', async () => {
  const k = await load('kalender');
  assert.equal(k.isoWeek('2026-09-23'), 39);
  assert.equal(k.isoWeek('2026-12-31'), 53, '2026 hat 53 Wochen (der 31.12. ist ein Donnerstag)');
  assert.equal(k.isoWeek('2027-01-01'), 53, 'der 1.1.2027 gehoert noch zur KW 53 des Vorjahrs');
  assert.equal(k.isoWeek('2027-01-04'), 1);
  assert.equal(k.isoWeek('2021-01-03'), 53);
});

test('addMonths und startOfWeek: der 31. wird zum letzten Tag, den es gibt', async () => {
  const k = await load('kalender');
  assert.equal(k.addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(k.addMonths('2028-01-31', 1), '2028-02-29', 'Schaltjahr');
  assert.equal(k.addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(k.addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(k.startOfWeek('2026-09-27'), '2026-09-21', 'Sonntag gehoert zur Woche davor');
  assert.equal(k.startOfWeek('2026-09-21'), '2026-09-21');
  assert.equal(k.addDays('2026-10-24', 2), '2026-10-26', 'ueber die Zeitumstellung hinweg');
});

test('whenOf und spanOf lesen, was der Server annimmt -- und sonst nichts', async () => {
  const k = await load('kalender');
  assert.deepEqual(k.whenOf('2026-09-23'), { kind: 'date', day: '2026-09-23', ms: new Date(2026, 8, 23).getTime(), hm: null, min: 0 });
  const lokal = k.whenOf('2026-09-23T09:30');
  assert.equal(lokal.kind, 'local');
  assert.equal(lokal.hm, '09:30');
  assert.equal(lokal.min, 570);
  assert.equal(k.whenOf('2026-09-23T09:30:00Z').kind, 'zoned');
  for (const kaputt of ['2026-02-30', '2026-09-23T25:00', 'morgen', '', null, undefined, 42]) {
    assert.equal(k.whenOf(kaputt), null, String(kaputt));
  }

  const nacht = k.spanOf({ start: '2026-09-23T22:00', end: '2026-09-24T00:00' });
  assert.equal(nacht.lastDay, '2026-09-23', 'bis Mitternacht belegt den Folgetag nicht');
  const urlaub = k.spanOf({ start: '2026-10-02', end: '2026-10-04', allDay: true });
  assert.deepEqual([urlaub.allDay, urlaub.firstDay, urlaub.lastDay], [true, '2026-10-02', '2026-10-04']);
  assert.equal(k.spanOf({ start: 'kaputt' }), null);
  assert.equal(k.spanOf({ start: '2026-09-23T10:00', end: '2026-09-23T09:00' }).end, null,
    'ein Ende vor dem Beginn wird nicht geglaubt');
});

test('timeLabel beschriftet einen Termin je nach Tag', async () => {
  const k = await load('kalender');
  const einfach = k.spanOf({ start: '2026-09-23T09:00', end: '2026-09-23T10:00' });
  assert.equal(k.timeLabel(einfach), '09:00–10:00');
  assert.equal(k.timeLabel(k.spanOf({ start: '2026-09-23T09:00' })), '09:00');
  const lang = k.spanOf({ start: '2026-09-23T22:00', end: '2026-09-25T01:00' });
  assert.equal(k.timeLabel(lang, '2026-09-23'), 'ab 22:00');
  assert.equal(k.timeLabel(lang, '2026-09-24'), 'ganztägig');
  assert.equal(k.timeLabel(lang, '2026-09-25'), 'bis 01:00');
  assert.equal(k.timeLabel(k.spanOf({ start: '2026-09-23' })), 'ganztägig');
});

test('layoutDay legt Ueberschneidendes nebeneinander und den Rest in volle Breite', async () => {
  const k = await load('kalender');
  const out = k.layoutDay([
    { id: 'a', startMin: 540, endMin: 600 }, // 09:00-10:00
    { id: 'b', startMin: 570, endMin: 630 }, // 09:30-10:30, ueberschneidet a
    { id: 'c', startMin: 600, endMin: 660 }, // 10:00-11:00, ueberschneidet b, nicht a
    { id: 'd', startMin: 720, endMin: 780 }, // 12:00, allein
  ]);
  const by = Object.fromEntries(out.map((x) => [x.id, x]));
  assert.deepEqual([by.a.lane, by.b.lane, by.c.lane], [0, 1, 0], 'c nimmt die Spur, die a frei macht');
  assert.equal(by.a.lanes, 2);
  assert.equal(by.c.lanes, 2);
  assert.deepEqual([by.d.lane, by.d.lanes], [0, 1]);
  assert.deepEqual(k.layoutDay([]), []);
});

test('rasterBloecke: drei halbstuendige Termine hintereinander liegen mit dem Finger nicht uebereinander', async () => {
  const k = await load('kalender');
  const folge = [
    { id: 'dichtung', startMin: 990, endMin: 1020 }, // 16:30-17:00
    { id: 'bank', startMin: 1020, endMin: 1050 }, // 17:00-17:30
    { id: 'kaffee', startMin: 1050, endMin: 1080 }, // 17:30-18:00
  ];
  for (const [hour, minPx] of [[64, 30], [48, 20]]) {
    const b = k.rasterBloecke(folge, { hour, minPx });
    for (const x of b) {
      for (const y of b) {
        if (x === y || x.lane !== y.lane) continue;
        const ueber = Math.min(x.top + x.height, y.top + y.height) - Math.max(x.top, y.top);
        assert.ok(ueber <= 0, `${x.id}/${y.id} ueberlappen sich um ${ueber} px (Stunde ${hour} px)`);
      }
    }
    assert.ok(b.every((x) => x.height >= minPx), 'jeder Block mindestens so hoch wie ein Tippziel');
  }
  // Frueher: Mindesthoehe 44 px bei 56 px je Stunde -- die Folge lag in EINER Spur 16 px uebereinander.
  const alt = k.rasterBloecke(folge, { hour: 56, minPx: 44 });
  assert.ok(alt.some((x) => x.lanes > 1), 'mit groesserer Mindesthoehe weichen sie nebeneinander aus, statt sich zu verdecken');
  // Kurze Termine im Viertelstundentakt am Laptop: nebeneinander, nicht uebereinander.
  const viertel = k.rasterBloecke([{ id: 'a', startMin: 600, endMin: 615 }, { id: 'b', startMin: 615, endMin: 630 }], { hour: 48, minPx: 20 });
  assert.notEqual(viertel[0].lane, viertel[1].lane);
});

test('dauerEnde: der Anfasser folgt der Bewegung -- ein Tipp ohne Bewegung aendert nichts', async () => {
  const k = await load('kalender');
  assert.equal(k.dauerEnde(990, 0, 64, 930), 990, 'kein Weg, keine Aenderung (vorher: 15 Minuten kuerzer)');
  assert.equal(k.dauerEnde(990, 2, 48, 930), 990, '2 px Zittern sind keine Viertelstunde');
  assert.equal(k.dauerEnde(990, 24, 48, 930), 1020, 'eine halbe Stunde tiefer (24 px bei 48 px je Stunde)');
  assert.equal(k.dauerEnde(990, -500, 48, 930), 945, 'nie kuerzer als 15 Minuten nach dem Beginn');
  assert.equal(k.dauerEnde(1410, 200, 48, 1380), 1440, 'nicht ueber Mitternacht hinaus');
});

test('anlegenSpanne: knapp unter der Stundenlinie losgelassen heisst diese Linie', async () => {
  const k = await load('kalender');
  const zwei = 2 / 48 * 60; // 2 px bei 48 px je Stunde
  assert.deepEqual(k.anlegenSpanne(14 * 60 + 1, 15 * 60 + zwei), { startMin: 840, endMin: 900 }, '14:00-15:00, nicht 15:15');
  assert.deepEqual(k.anlegenSpanne(14 * 60 + 1, 14 * 60 + 3), { startMin: 840, endMin: 855 }, 'mindestens eine Viertelstunde');
  assert.deepEqual(k.anlegenSpanne(14 * 60 + 1, 12 * 60 + 58), { startMin: 780, endMin: 855 }, 'nach oben gezogen');
});

test('scrollAnfang: oben klebt kein halber Termin -- ausser einem, der viel frueher begann', async () => {
  const k = await load('kalender');
  const tag = [{ startMin: 540, endMin: 600 }, { startMin: 570, endMin: 615 }];
  assert.equal(k.scrollAnfang(tag, 590), 540, 'Zahnarzt 9-10 und Telefonat 9:30-10:15: ab 9:00');
  assert.equal(k.scrollAnfang(tag, 660), 660, 'nichts schneidet 11:00: bleibt');
  assert.equal(k.scrollAnfang([{ startMin: 480, endMin: 1080 }], 780), 780, 'ein Arbeitstag seit 8 Uhr bleibt angeschnitten, "jetzt" bleibt im Bild');
});

test('layoutDay nennt die Gruppe: mehr als zwei zugleich wird in engen Spalten zu "+n"', async () => {
  const k = await load('kalender');
  const out = k.layoutDay([
    { id: 'a', startMin: 960, endMin: 1020 },
    { id: 'b', startMin: 960, endMin: 1020 },
    { id: 'c', startMin: 960, endMin: 1020 },
    { id: 'd', startMin: 1200, endMin: 1260 },
  ]);
  const by = Object.fromEntries(out.map((x) => [x.id, x]));
  assert.equal(by.a.gruppe, by.c.gruppe);
  assert.notEqual(by.a.gruppe, by.d.gruppe);
  assert.equal(by.c.lanes, 3);
});

/* ------------------------------------- Kalender: Serien, Ziehen, Balken */

test('eintragAus: Einzeltermin und Vorkommen einer Serie (Vertrag B), am Element oder in data', async () => {
  const k = await load('kalender');
  const einzel = k.eintragAus({
    id: 'event_a', type: 'event', occurrence: null, recurring: false,
    data: { title: 'Zahnarzt', start: '2026-09-23T09:00', end: '2026-09-23T10:00', occurrence: null, recurring: false },
  });
  assert.equal(einzel.key, 'event_a@');
  assert.equal(einzel.recurring, false);
  const serie = { freq: 'weekly', interval: 1, byDay: ['TU'], until: null, count: null };
  const vk = k.eintragAus({
    id: 'event_s', occurrence: '2026-09-29', recurring: true, serie: { start: '2026-09-08T18:00', end: '2026-09-08T19:30' },
    data: { title: 'Training', start: '2026-09-29T18:00', end: '2026-09-29T19:30', recurrence: serie, occurrence: '2026-09-29', recurring: true },
  });
  assert.equal(vk.key, 'event_s@2026-09-29', 'jedes Vorkommen hat seinen eigenen Schluessel, die id bleibt die der Serie');
  assert.equal(vk.id, 'event_s');
  assert.equal(vk.recurring, true);
  assert.equal(vk.span.firstDay, '2026-09-29');
  const nurInData = k.eintragAus({ id: 'event_s', data: { title: 'Training', start: '2026-10-06T18:00', recurrence: serie, occurrence: '2026-10-06', recurring: true } });
  assert.equal(nurInData.occurrence, '2026-10-06');
  assert.equal(nurInData.recurring, true);
  assert.equal(k.eintragAus({ id: 'event_x', data: { title: 'kaputt', start: 'morgen' } }), null);
  assert.equal(k.eintragAus(null), null);
  assert.equal(k.eintragAus({ data: { title: 'ohne id', start: '2026-09-23' } }), null);
});

test('verschieben und snap: auf der Wanduhr im 15-Minuten-Raster, auch ueber die Zeitumstellung', async () => {
  const k = await load('kalender');
  assert.deepEqual(k.verschieben('2026-10-24T10:00', '2026-10-24T11:00', 1440), { start: '2026-10-25T10:00', end: '2026-10-25T11:00' },
    'am 25.10.2026 wird die Uhr umgestellt: ein Tag spaeter ist trotzdem 10:00');
  assert.deepEqual(k.verschieben('2026-09-23T23:30', '2026-09-24T00:30', 45), { start: '2026-09-24T00:15', end: '2026-09-24T01:15' });
  assert.deepEqual(k.verschieben('2026-10-03', '2026-10-05', 2 * 1440, true), { start: '2026-10-05', end: '2026-10-07' });
  assert.deepEqual(k.verschieben('2026-10-03', null, 1440, true), { start: '2026-10-04', end: null });
  assert.deepEqual(k.verschieben('2026-09-23T09:00', null, -30), { start: '2026-09-23T08:30', end: null });
  assert.equal(k.verschieben('kaputt', null, 15), null);
  assert.deepEqual([k.snap(7), k.snap(8), k.snap(52), k.snap(53), k.snap(-8)], [0, 15, 45, 60, -15]);
  assert.equal(k.alsWand('2026-09-23T09:30:00'), '2026-09-23T09:30');
  assert.equal(k.alsWand('2026-09-23'), '2026-09-23');
});

test('aufTag: eine Serie auf einen ihrer Tage gelegt, Dauer bleibt', async () => {
  const k = await load('kalender');
  assert.deepEqual(k.aufTag({ start: '2026-09-01T18:00', end: '2026-09-01T19:30' }, '2026-10-27'),
    { start: '2026-10-27T18:00', end: '2026-10-27T19:30' }, 'nach der Zeitumstellung immer noch 18:00');
  assert.deepEqual(k.aufTag({ start: '2026-09-01', end: '2026-09-03', allDay: true }, '2026-10-01'), { start: '2026-10-01', end: '2026-10-03' });
  assert.deepEqual(k.aufTag({ start: '2026-09-01T22:00', end: '2026-09-02T01:00' }, '2026-09-08'), { start: '2026-09-08T22:00', end: '2026-09-09T01:00' });
});

test('serienPatch: "Alle" -- jeden Dienstag gezogen auf Mittwoch wird jeden Mittwoch', async () => {
  const k = await load('kalender');
  const serie = {
    start: '2026-09-08T18:00', end: '2026-09-08T19:30',
    recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'], until: '2026-12-15', count: null },
    exdates: ['2026-09-15'],
  };
  const alt = { start: '2026-09-29T18:00', end: '2026-09-29T19:30' };
  const p = k.serienPatch(serie, alt, { start: '2026-09-30T18:30', end: '2026-09-30T20:00' });
  assert.equal(p.start, '2026-09-09T18:30', 'der Beginn der SERIE wandert, nicht der des angetippten Vorkommens');
  assert.equal(p.end, '2026-09-09T20:00');
  assert.deepEqual(p.recurrence.byDay, ['WE']);
  assert.equal(p.recurrence.until, '2026-12-16', 'das letzte Vorkommen wandert mit und faellt nicht weg');
  assert.deepEqual(p.exdates, ['2026-09-16'], 'der ausgelassene Tag bleibt derselbe Termin');

  const laenger = k.serienPatch(serie, alt, { start: alt.start, end: '2026-09-29T20:00' });
  assert.deepEqual(laenger, { start: '2026-09-08T18:00', end: '2026-09-08T20:00' }, 'nur laenger: Regel und Ausnahmen bleiben, wie sie sind');

  const miete = { start: '2026-09-01', allDay: true, end: null, recurrence: { freq: 'monthly', interval: 1, until: null, count: null } };
  const m = k.serienPatch(miete, { start: '2026-10-01', end: null }, { start: '2026-10-02', end: null });
  assert.equal(m.start, '2026-09-02');
  assert.equal(m.recurrence.freq, 'monthly');
  assert.equal(m.recurrence.byDay, undefined, 'byDay gibt es nur bei woechentlich (Vertrag A)');

  const sonntag = { start: '2026-09-06T23:00', end: '2026-09-06T23:30', recurrence: { freq: 'weekly', interval: 1, byDay: ['SU'], until: null, count: null } };
  const nacht = k.serienPatch(sonntag, { start: '2026-09-27T23:00', end: '2026-09-27T23:30' }, { start: '2026-09-28T00:30', end: '2026-09-28T01:00' });
  assert.deepEqual(nacht.recurrence.byDay, ['MO'], 'ueber Mitternacht gezogen: der Wochentag wandert mit');
});

test('packeBalken und istBalken: Ganztaegiges als Balken, jeder in der obersten freien Zeile', async () => {
  const k = await load('kalender');
  const lanes = Object.fromEntries(k.packeBalken([
    { key: 'feier', von: 5, bis: 5 },
    { key: 'urlaub', von: 0, bis: 4 },
    { key: 'arzt', von: 1, bis: 1 },
    { key: 'messe', von: 3, bis: 5 },
  ]).map((b) => [b.key, b.lane]));
  assert.deepEqual(lanes, { urlaub: 0, arzt: 1, messe: 1, feier: 0 });
  assert.equal(k.istBalken(k.spanOf({ start: '2026-10-03', allDay: true })), true);
  assert.equal(k.istBalken(k.spanOf({ start: '2026-09-26T22:00', end: '2026-09-27T02:00' })), false, 'eine Nacht bleibt im Raster');
  assert.equal(k.istBalken(k.spanOf({ start: '2026-09-26T10:00', end: '2026-09-27T12:00' })), true, 'ab 24 Stunden ein Balken');
});

test('gruppiereNachTag: "Als Naechstes" -- was schon laeuft, steht bei heute', async () => {
  const k = await load('kalender');
  const e = (id, data, occurrence = null) => k.eintragAus({ id, occurrence, data: { title: id, ...data } });
  const gruppen = k.gruppiereNachTag([
    e('spaet', { start: '2026-09-23T18:00' }),
    e('urlaub', { start: '2026-09-21', end: '2026-09-25', allDay: true }),
    e('frueh', { start: '2026-09-23T08:00' }),
    e('vorbei', { start: '2026-09-20T08:00' }),
    e('morgen', { start: '2026-09-24T09:00' }),
    e('zuweit', { start: '2026-12-24' }),
  ], '2026-09-23', '2026-10-22');
  assert.deepEqual(gruppen.map((g) => [g.day, g.eintraege.map((x) => x.id)]), [
    ['2026-09-23', ['urlaub', 'frueh', 'spaet']],
    ['2026-09-24', ['morgen']],
  ]);
});

test('rangeFor: jede Ansicht laedt genau, was sie zeigt', async () => {
  const k = await load('kalender');
  assert.deepEqual(k.rangeFor('woche', '2026-09-23'), { from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual(k.rangeFor('monat', '2026-09-23'), { from: '2026-08-31', to: '2026-10-04' });
  assert.deepEqual(k.rangeFor('tag', '2026-09-23'), { from: '2026-08-31', to: '2026-10-04' }, 'Tag laedt den Monat: der kleine Monat daneben zeigt Punkte');
  assert.deepEqual(k.rangeFor('liste', '2026-01-01', 60, '2026-09-23'), { from: '2026-09-23', to: '2026-11-21' });
});

test('Kachel "Kalender – Heute": ist heute zu viel, weicht zuerst, was schon vorbei ist', async () => {
  const w = await load('kalender', 'widgets');
  const z = (id, past) => ({ id, past });
  const ids = (xs) => xs.map((x) => x.id);
  assert.deepEqual(ids(w.auswahl([z('a', true), z('b', false)])), ['a', 'b'], 'passt alles hinein: alles, auch Vergangenes');
  // 15 Uhr: Zahnarzt (9) und Telefonat (9:30) vorbei, Post (15), Dichtung (16:30), Training (18) kommen.
  const tag = [z('zahnarzt', true), z('telefonat', true), z('post', false), z('dichtung', false), z('training', false)];
  assert.deepEqual(ids(w.auswahl(tag)), ['post', 'dichtung', 'training'], 'nur, was noch kommt');
  const abends = [z('zahnarzt', true), z('telefonat', true), z('post', true), z('training', false)];
  assert.deepEqual(ids(w.auswahl(abends)), ['telefonat', 'post', 'training'], 'Rest aufgefuellt mit den zuletzt vergangenen, Reihenfolge bleibt');
  const ganzOben = [z('urlaub', false), z('zahnarzt', true), z('post', false), z('training', false), z('kino', false)];
  assert.deepEqual(ids(w.auswahl(ganzOben)), ['urlaub', 'post', 'training'], 'Ganztaegiges bleibt vorn');
  assert.deepEqual(ids(w.auswahl([z('a', true), z('b', true), z('c', true), z('d', true)])), ['b', 'c', 'd'], 'alles vorbei: die letzten drei');
  assert.deepEqual(w.auswahl([]), []);
});

/* ------------------------------------------------------------ Erinnerung */

test('Erinnerung in Worten', async () => {
  const r = await load('erinnerung', 'lib');
  assert.deepEqual([null, 0, 5, 15, 60, 120, 1440].map(r.erinnerungInWorten),
    ['Keine', 'Zum Beginn', '5 Min vorher', '15 Min vorher', '1 Std vorher', '2 Std vorher', '1 Tag vorher']);
  assert.deepEqual(r.ERINNERUNG_OPTIONEN, [null, 0, 5, 10, 15, 30, 60, 120, 1440], 'die Stufen aus Vertrag A');
});

test('faellige: eine Erinnerung zur Zeit Beginn minus Vorlauf, bis kurz nach Beginn, nicht wenn weggeklickt', async () => {
  const r = await load('erinnerung', 'lib');
  const um = (h, m) => new Date(2026, 8, 23, h, m).getTime();
  const items = [
    { id: 'event_z', data: { title: 'Zahnarzt', location: 'Bibliothek', start: '2026-09-23T10:00', reminder: 15 } },
    { id: 'event_o', data: { title: 'Ohne Erinnerung', start: '2026-09-23T10:00', reminder: null } },
    { id: 'event_t', occurrence: '2026-09-23', data: { title: 'Training', start: '2026-09-23T10:05', reminder: 30, occurrence: '2026-09-23' } },
  ];
  assert.deepEqual(r.faellige(items, um(9, 30)).map((e) => e.id), []);
  assert.deepEqual(r.faellige(items, um(9, 40)).map((e) => e.id), ['event_t'], 'Training: 10:05 minus 30 Minuten');
  const jetzt = r.faellige(items, um(9, 50));
  assert.deepEqual(jetzt.map((e) => e.id), ['event_z', 'event_t']);
  assert.equal(r.hinweisText(jetzt[0], um(9, 50)), 'In 10 Min · Zahnarzt · Bibliothek');
  assert.equal(jetzt[1].key, 'event_t|2026-09-23|2026-09-23T10:05|30', 'jedes Vorkommen einer Serie erinnert fuer sich');
  assert.equal(r.faellige(items, um(10, 9)).length, 2, 'kurz nach Beginn steht der Hinweis noch');
  assert.equal(r.faellige(items, um(10, 20)).length, 0, 'wer eine Viertelstunde spaeter oeffnet, braucht ihn nicht mehr');
  assert.deepEqual(r.faellige(items, um(9, 50), new Set([jetzt[0].key])).map((e) => e.id), ['event_t'], 'weggeklickt bleibt weg');
  const verschoben = [{ ...items[0], data: { ...items[0].data, start: '2026-09-23T10:05' } }];
  assert.equal(r.faellige(verschoben, um(9, 55), new Set([jetzt[0].key])).length, 1, 'verschoben erinnert neu');
});

test('Erinnerung: ganztaegig um neun, Texte vor, bei und nach Beginn', async () => {
  const r = await load('erinnerung', 'lib');
  assert.equal(r.beginnMs('2026-09-24'), new Date(2026, 8, 24, 9, 0).getTime());
  const vortag = r.faellige([{ id: 'event_m', data: { title: 'Miete', start: '2026-09-24', allDay: true, reminder: 1440 } }], new Date(2026, 8, 23, 9, 1).getTime());
  assert.equal(vortag.length, 1, '"1 Tag vorher" meldet sich am Vortag um neun');
  assert.equal(r.wannText(new Date(2026, 8, 24, 9, 0).getTime(), new Date(2026, 8, 23, 9, 1).getTime()), 'Morgen 09:00');
  const zehn = new Date(2026, 8, 23, 10, 0).getTime();
  assert.equal(r.wannText(zehn, zehn), 'Jetzt');
  assert.equal(r.wannText(zehn, zehn + 2 * 60000), 'Seit 2 Min');
  assert.equal(r.wannText(zehn, zehn - 60 * 60000), 'In 1 Std');
  assert.equal(r.wannText(zehn, zehn - 90 * 60000), 'Heute 10:00');
  assert.equal(r.beginnMs('kaputt'), null);
});

test('Erinnerung ueber die Zeitumstellung: „1 Tag vorher“ ist der Vortag zur selben Uhrzeit, wie TRIGGER:-P1D in der Kalenderdatei', async () => {
  const r = await load('erinnerung', 'lib');
  const vorher = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  try {
    // 25.10.2026: die Uhr wird zurueckgestellt, der Tag hat 25 Stunden.
    assert.equal(r.ausloeseMs('2026-10-25T10:00', 1440), new Date(2026, 9, 24, 10, 0).getTime(),
      'Sa 24.10. um 10:00 -- nicht um 11:00 (1440 echte Minuten)');
    // 29.03.2026: vorgestellt. Ganztaegig "Zum Beginn" bleibt neun Uhr Wandzeit.
    assert.equal(r.ausloeseMs('2026-03-29', 0), new Date(2026, 2, 29, 9, 0).getTime());
    assert.equal(r.ausloeseMs('2026-03-30', 1440), new Date(2026, 2, 29, 9, 0).getTime());
    // Minuten bleiben genaue Minuten.
    assert.equal(r.ausloeseMs('2026-10-25T10:00', 120), new Date(2026, 9, 25, 10, 0).getTime() - 120 * 60000);
    const faellig = r.faellige([{ id: 'event_x', data: { title: 'X', start: '2026-10-25T10:00', reminder: 1440 } }],
      new Date(2026, 9, 24, 10, 1).getTime());
    assert.equal(faellig.length, 1, 'am Vortag um 10:01 ist sie schon da');
  } finally {
    if (vorher === undefined) delete process.env.TZ;
    else process.env.TZ = vorher;
  }
});

/* --------------------------------------------------- Notizwand, Projekte */

test('Notizen: Herkunft und Zeitstempel in Worten', async () => {
  const n = await load('notes');
  assert.equal(n.originLabel({ art: 'chat', chatTitel: 'Produktlaunch' }), 'aus dem Chat „Produktlaunch“');
  assert.equal(n.originLabel({ art: 'chat', chatTitel: 'Alt', chatGeloescht: true }), 'aus einem gelöschten Chat „Alt“');
  assert.equal(n.originLabel({ art: 'hand' }), 'von dir');
  assert.equal(n.originLabel(null), 'von dir');
  const jetzt = new Date(2026, 8, 23, 15, 0);
  assert.equal(n.stamp(new Date(2026, 8, 23, 10, 24).toISOString(), jetzt), 'heute 10:24');
  assert.equal(n.stamp(new Date(2026, 8, 22, 18, 2).toISOString(), jetzt), 'gestern 18:02');
  assert.match(n.stamp(new Date(2026, 8, 12, 9, 5).toISOString(), jetzt), /^12\. Sept?\.? 09:05$/);
  assert.match(n.stamp(new Date(2025, 0, 3).toISOString(), jetzt), /2025/);
  assert.equal(n.stamp('kaputt', jetzt), '');
});

test('Projekte: der naechste Termin kurz beschrieben', async () => {
  const p = await load('projects');
  const jetzt = new Date(2026, 8, 23, 8, 0);
  assert.equal(p.whenShort({ start: '2026-09-23T16:30' }, jetzt), 'heute · 16:30');
  assert.equal(p.whenShort({ start: '2026-09-24T18:00' }, jetzt), 'morgen · 18:00');
  assert.equal(p.whenShort({ start: '2026-09-24', allDay: true }, jetzt), 'morgen');
  assert.match(p.whenShort({ start: '2026-09-28T10:00' }, jetzt), /28\. Sept?\.? · 10:00$/);
  assert.equal(p.whenShort({ start: 'irgendwann' }, jetzt), '');
});
