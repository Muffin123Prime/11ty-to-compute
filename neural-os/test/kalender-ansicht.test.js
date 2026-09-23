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
async function load(view) {
  if (loaded.has(view)) return loaded.get(view);
  const web = path.join(__dirname, '..', 'web');
  const { home, cleanup } = tempHome('nos-kal-view');
  const asModule = (src) => src.replace(/(from\s+')([^']+)\.js(')/g, (m, head, spec, tail) => `${head}./${path.basename(spec)}.mjs${tail}`);
  const copy = (from, to) => fs.writeFileSync(path.join(home, to), asModule(fs.readFileSync(from, 'utf8')));
  for (const file of fs.readdirSync(path.join(web, 'lib'))) {
    if (file.endsWith('.js')) copy(path.join(web, 'lib', file), file.replace(/\.js$/, '.mjs'));
  }
  copy(path.join(web, 'views', `${view}.js`), `${view}.mjs`);
  try {
    const mod = await import(pathToFileURL(path.join(home, `${view}.mjs`)).href);
    loaded.set(view, mod);
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
