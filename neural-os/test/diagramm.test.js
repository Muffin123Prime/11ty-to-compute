'use strict';

/**
 * Diagramme und Tabellen im Chat, ohne Browser: web/lib/diagramm.js und
 * web/lib/tabelle.js.
 *
 * Geprueft werden die reinen Funktionen, auf denen alles Sichtbare steht:
 * Zahlen lesen wie ein Mensch sie in eine deutsche Tabelle schreibt, Daten
 * erkennen, runde Achsenschritte, Zeitachsen mit Kalenderstrichen,
 * Sortierschluessel, Filter, das Pruefen der Diagramm-Spezifikation und die
 * Text-Fassung (Kopieren, Vorlesen). Was nur im Browser zu sehen ist
 * (Tooltip, Legende, Als Tabelle, Breiten), bedient die Pruefseite mit
 * Chromium.
 *
 * web/** ist Browser-ESM ohne Bauschritt. Wie test/bausteine.test.js kopiert
 * dieser Test die Dateien unveraendert in ein Zeitverzeichnis (flach, Endung
 * .mjs). Die Bausteine kommen zuerst, web/lib danach -- so ist
 * `diagramm.mjs` das Modul aus web/lib, und bausteine/index.js meldet beim
 * Laden genau dieses an. Damit prueft der Test auch, dass es als Baustein
 * `diagramm` passt.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

const WEB = process.env.NOS_WEB_DIR || path.join(__dirname, '..', 'web');

let geladen = null;
async function laden() {
  if (geladen) return geladen;
  const { home, cleanup } = tempHome('nos-diagramm');
  const alsModul = (src) => src.replace(/(from\s+')([^']+)\.js(')/g, (m, kopf, spec, ende) => `${kopf}./${path.basename(spec)}.mjs${ende}`);
  for (const dir of [path.join(WEB, 'lib', 'bausteine'), path.join(WEB, 'lib')]) {
    if (!fs.existsSync(dir)) continue;
    for (const datei of fs.readdirSync(dir)) {
      if (datei.endsWith('.js')) fs.writeFileSync(path.join(home, datei.replace(/\.js$/, '.mjs')), alsModul(fs.readFileSync(path.join(dir, datei), 'utf8')));
    }
  }
  const imp = (name) => import(pathToFileURL(path.join(home, `${name}.mjs`)).href);
  try {
    geladen = { D: await imp('diagramm'), T: await imp('tabelle'), B: fs.existsSync(path.join(home, 'index.mjs')) ? await imp('index') : null };
  } finally {
    cleanup();
  }
  return geladen;
}

const ok = (erg) => {
  assert.equal(erg.ok, true, erg.fehler);
  return erg.spec;
};
const nein = (erg, muster) => {
  assert.equal(erg.ok, false, 'hätte abgelehnt werden müssen');
  if (muster) assert.match(erg.fehler, muster);
};

/* ------------------------------------------------------------ Zahlen */

test('Diagramm: Zahlen lesen wie in einer deutschen Tabelle', async () => {
  const { T } = await laden();
  const faelle = [
    ['1.234,5', 1234.5], ['12 %', 12], ['3,5 Mio.', 3500000], ['3,5 Mio. €', 3500000], ['1,2 Mrd.', 1200000000],
    ['12 Tsd.', 12000], ['12k', 12000], ['−4,2', -4.2], ['-4,2 %', -4.2], ['+7 %', 7], ['12,50 €', 12.5], ['€ 12,50', 12.5],
    ['1 234,5', 1234.5], ['1 234', 1234], ['12.000 €', 12000], ['12.345.678', 12345678], ['1.234', 1234],
    ['1,5', 1.5], ['1.5', 1.5], ['0.500', 0.5], ['3.14', 3.14], ['1,234.5', 1234.5], ['1,234,567', 1234567],
    ['ca. 500', 500], ['~ 20', 20], ['4 km', 4], ['20 °C', 20], ['80 km/h', 80], [',5', 0.5], [42, 42], ['0', 0],
  ];
  for (const [ein, aus] of faelle) assert.equal(T.zahlLesen(ein), aus, `„${ein}“`);
  const keine = ['', 'abc', '–', 'Kapitel 3', '2026-09-28', '28.09.2026', '14:30', '3 Äpfel und 2 Birnen', '3 von 5', '1.234.5', NaN, null, undefined, {}];
  for (const ein of keine) assert.equal(T.zahlLesen(ein), null, `„${String(ein)}“ ist keine Zahl`);
});

test('Diagramm: deutsche Zahlen schreiben (echtes Minus, Mio., Einheit, Prozent)', async () => {
  const { D } = await laden();
  assert.equal(D.zahlText(1234.5), '1.234,5');
  assert.equal(D.zahlText(1234.567), '1.234,57');
  assert.equal(D.zahlText(-4.2), '−4,2');
  assert.equal(D.zahlText(-0.001), '0', 'keine „−0“');
  assert.equal(D.zahlText(3500000, { kompakt: true }), '3,5 Mio.');
  assert.equal(D.zahlText(3500000, { kompakt: true, einheit: '€' }), '3,5 Mio. €');
  assert.equal(D.zahlText(250000000, { kompakt: true }), '250 Mio.');
  assert.equal(D.zahlText(1.2e9, { kompakt: true }), '1,2 Mrd.');
  assert.equal(D.zahlText(12, { einheit: '%' }), '12 %');
  assert.equal(D.zahlText(null), '–');
  assert.equal(D.prozentText(0.45), '45 %');
  assert.equal(D.prozentText(0.045), '4,5 %');
  // Was geschrieben wird, liest die Tabelle wieder (sie sortiert danach).
  const { T } = await laden();
  for (const n of [1234.5, -4.2, 0.25, 3500000, 12000]) {
    assert.equal(T.zahlLesen(D.zahlText(n, { einheit: '€' })), n);
    assert.equal(T.zahlLesen(D.zahlText(n, { kompakt: true })), Number(D.zahlText(n, { kompakt: true }).replace(/[^\d,]/g, '').replace(',', '.')) * (n >= 1e6 ? 1e6 : 1) * Math.sign(n));
  }
});

/* ------------------------------------------------------------ Achsen */

test('Diagramm: runde Achsenschritte (1, 2, 2,5, 5 × 10^k), Null bei Balken immer ein Strich', async () => {
  const { D } = await laden();
  assert.deepEqual(D.schoeneSkala(0, 87), { min: 0, max: 100, schritt: 20, ticks: [0, 20, 40, 60, 80, 100] });
  assert.deepEqual(D.schoeneSkala(0, 1234, { anzahl: 5 }).ticks, [0, 250, 500, 750, 1000, 1250]);
  const neg = D.schoeneSkala(-12, 30, { anzahl: 4 });
  assert.ok(neg.ticks.includes(0), 'die Null ist ein Strich');
  assert.ok(neg.min <= -12 && neg.max >= 30);
  assert.deepEqual(D.schoeneSkala(0.1, 0.9, { anzahl: 5 }).ticks, [0, 0.2, 0.4, 0.6, 0.8, 1], 'keine 0,6000000001');
  assert.deepEqual(D.schoeneSkala(96, 104, { anzahl: 4, mitNull: false }).ticks, [96, 98, 100, 102, 104], 'eine Linie darf die Daten umschliessen');
  const flach = D.schoeneSkala(5, 5, { mitNull: false });
  assert.ok(flach.min < 5 && flach.max > 5, 'eine flache Linie klebt nicht am Rand');
  assert.deepEqual(D.schoeneSkala(0, 0).ticks.slice(-1), [1], 'lauter Nullen: trotzdem eine Achse');
  assert.equal(D.schoenerSchritt(17.4), 20);
  assert.equal(D.schoenerSchritt(0.023), 0.025);
  assert.equal(D.schoenerSchritt(4200), 5000);
  assert.equal(D.dezimalen(0.25), 2);
  assert.equal(D.dezimalen(2.5), 1);
  assert.equal(D.dezimalen(500), 0);
  const mio = D.achsenFormat({ min: 0, max: 2500000, schritt: 500000 });
  assert.deepEqual(D.schoeneSkala(0, 2400000, { anzahl: 4 }).ticks, [0, 1000000, 2000000, 3000000]);
  assert.deepEqual([0, 500000, 1000000, 2500000].map(mio), ['0', '0,5 Mio.', '1 Mio.', '2,5 Mio.'], 'eine Grössenordnung für alle Striche');
  assert.equal(D.achsenFormat({ min: 0, max: 100, schritt: 25 }, '%')(75), '75 %');
});

/* ------------------------------------------------------------ Daten */

test('Diagramm: Datumsangaben erkennen (ISO, deutsch, Monate, Quartale, Jahre)', async () => {
  const { T } = await laden();
  const U = Date.UTC;
  const faelle = [
    ['2026-09-28', U(2026, 8, 28), 'tag'], ['2026-09-28T14:30', U(2026, 8, 28, 14, 30), 'minute'], ['2026-09', U(2026, 8, 1), 'monat'],
    ['28.09.2026', U(2026, 8, 28), 'tag'], ['28.9.26', U(2026, 8, 28), 'tag'], ['28.09.2026, 14:30', U(2026, 8, 28, 14, 30), 'minute'],
    ['3. Sep 2026', U(2026, 8, 3), 'tag'], ['3. September 2026', U(2026, 8, 3), 'tag'], ['Mo, 28. Sep 2026', U(2026, 8, 28), 'tag'],
    ['Sep 2026', U(2026, 8, 1), 'monat'], ['März 2026', U(2026, 2, 1), 'monat'], ['Mai 26', U(2026, 4, 1), 'monat'], ['09/2026', U(2026, 8, 1), 'monat'],
    ['Q3 2026', U(2026, 6, 1), 'quartal'], ['2026 Q1', U(2026, 0, 1), 'quartal'], ['4. Quartal 2025', U(2025, 9, 1), 'quartal'],
  ];
  for (const [ein, t, genau] of faelle) assert.deepEqual(T.datumLesen(ein), { t, genau }, `„${ein}“`);
  assert.deepEqual(T.datumLesen('28.09.', { jahr: 2026 }), { t: U(2026, 8, 28), genau: 'tag', ohneJahr: true });
  assert.equal(T.datumLesen('2026'), null, 'eine Jahreszahl allein ist erst mit jahrAllein ein Datum');
  assert.deepEqual(T.datumLesen('2026', { jahrAllein: true }), { t: U(2026, 0, 1), genau: 'jahr' });
  for (const kaputt of ['31.02.2026', '2026-13-01', '12.5', 'Montag', 'Sep', 'Hallo 2026', '25:00', '']) assert.equal(T.datumLesen(kaputt), null, `„${kaputt}“`);
});

test('Diagramm: ausführliche Datumsangaben lesen sich zurück (Tabelle sortiert danach)', async () => {
  const { D, T } = await laden();
  const t = Date.UTC(2026, 8, 28, 14, 30);
  assert.equal(D.datumText(Date.UTC(2026, 8, 28), 'tag'), 'Mo, 28. Sep 2026');
  assert.equal(D.datumText(t, 'minute'), '28. Sep 2026, 14:30');
  assert.equal(D.datumText(Date.UTC(2026, 2, 1), 'monat'), 'März 2026');
  assert.equal(D.datumText(Date.UTC(2026, 6, 1), 'quartal'), 'Q3 2026');
  for (const [wert, genau] of [[Date.UTC(2026, 8, 28), 'tag'], [t, 'minute'], [Date.UTC(2026, 2, 1), 'monat'], [Date.UTC(2026, 6, 1), 'quartal'], [Date.UTC(2026, 0, 1), 'jahr']]) {
    assert.equal(T.datumLesen(D.datumText(wert, genau), { jahrAllein: true }).t, wert, `${genau} liest sich zurück`);
  }
  assert.equal(D.datumKurz(Date.UTC(2026, 8, 28), 'tag'), '28. Sep');
  assert.equal(D.datumKurz(Date.UTC(2027, 0, 1), 'monat', { mitJahr: true }), 'Jan 2027');
});

test('Diagramm: Zeitachse nur, wenn alle Beschriftungen Zeitpunkte sind; Jahreswechsel ohne Jahr', async () => {
  const { D } = await laden();
  const U = Date.UTC;
  const iso = D.zeitachse(['2026-09-01', '2026-09-15', '2026-10-01']);
  assert.deepEqual(iso, { t: [U(2026, 8, 1), U(2026, 8, 15), U(2026, 9, 1)], genau: 'tag', ordnung: [0, 1, 2] });
  assert.equal(D.zeitachse(['2026-09-01', 'Montag']), null, 'gemischt bleibt eine Namensliste');
  assert.equal(D.zeitachse(['2026-09-01']), null);
  assert.equal(D.zeitachse(['Jan', 'Feb', 'März']), null, 'Monate ohne Jahr sind Namen, keine Zeitpunkte');
  const jahre = D.zeitachse(['2010', '2015', '2020', '2021']);
  assert.equal(jahre.genau, 'jahr');
  assert.equal(jahre.t[1] - jahre.t[0] > jahre.t[3] - jahre.t[2], true, 'fünf Jahre Abstand sind breiter als eins');
  const wechsel = D.zeitachse(['20.12.', '27.12.', '03.01.', '10.01.'], { jahr: 2026 });
  assert.deepEqual(wechsel.t, [U(2026, 11, 20), U(2026, 11, 27), U(2027, 0, 3), U(2027, 0, 10)], 'Januar nach Dezember ist das nächste Jahr');
  const unsortiert = D.zeitachse(['2026-03', '2026-01', '2026-02']);
  assert.deepEqual(unsortiert.ordnung, [1, 2, 0], 'die Linie läuft in der Zeit, nicht in der Schreibreihenfolge');
  assert.equal(D.zeitachse(['2026-01', '2026-02-10']).genau, 'tag', 'die feinste Genauigkeit gilt');
});

test('Diagramm: Striche einer Zeitachse liegen auf Kalendergrenzen und passen nebeneinander', async () => {
  const { D } = await laden();
  const U = Date.UTC;
  const monate = D.zeitTicks(U(2026, 0, 1), U(2026, 11, 1), { maxAnzahl: 6, genau: 'monat' });
  assert.deepEqual(monate.map((x) => x.text), ['Jan 2026', 'März', 'Mai', 'Juli', 'Sep', 'Nov']);
  const alle = D.zeitTicks(U(2026, 0, 1), U(2026, 11, 1), { maxAnzahl: 12, genau: 'monat' });
  assert.equal(alle.length, 12);
  const tage = D.zeitTicks(U(2026, 8, 1), U(2026, 8, 30), { maxAnzahl: 6, genau: 'tag' });
  assert.ok(tage.length <= 6 && tage.length >= 3);
  for (const tk of tage) assert.equal(new Date(tk.t).getUTCDay(), 1, 'Wochenstriche stehen auf Montagen');
  assert.match(tage[0].text, /^\d{1,2}\. Sep$/);
  const ueberJahr = D.zeitTicks(U(2026, 9, 1), U(2027, 2, 1), { maxAnzahl: 12, genau: 'monat' });
  assert.ok(ueberJahr.some((x) => x.text === 'Jan 2027'), 'der Jahreswechsel trägt das Jahr');
  const jahre = D.zeitTicks(U(1990, 0, 1), U(2026, 0, 1), { maxAnzahl: 5, genau: 'jahr' });
  assert.deepEqual(jahre.map((x) => x.text), ['1990', '2000', '2010', '2020']);
  const stunden = D.zeitTicks(U(2026, 8, 28, 8, 0), U(2026, 8, 28, 18, 0), { maxAnzahl: 6, genau: 'minute' });
  assert.deepEqual(stunden.map((x) => x.text), ['09:00', '12:00', '15:00', '18:00']);
  const eng = D.zeitTicks(U(2026, 0, 1), U(2026, 11, 1), { platz: 200, messen: (s) => s.length * 7, genau: 'monat' });
  assert.ok(eng.length <= 4, 'auf 200 px passen keine zwölf Monatsnamen');
});

/* ------------------------------------------------------------ Tabelle */

test('Tabelle: Spaltenart und Sortierschlüssel (Zahl, Datum, Text), leere Zellen immer unten', async () => {
  const { T } = await laden();
  assert.equal(T.spaltenArt(['1.234,5 €', '12.000 €', '980 €', '–']), 'zahl');
  assert.equal(T.spaltenArt(['28.09.2026', '3. Okt 2026', '2026-01-05']), 'datum');
  assert.equal(T.spaltenArt(['Q1 2026', 'Q3 2025', 'Q2 2026']), 'datum');
  assert.equal(T.spaltenArt(['Berlin', 'Köln', '12']), 'text');
  assert.equal(T.spaltenArt(['12', '13', 'siehe unten', '14', '15']), 'zahl', 'ein Ausreißer macht keine Textspalte');
  assert.equal(T.sortSchluessel('k. A.', 'zahl'), null);
  assert.equal(T.sortSchluessel('3,5 Mio.', 'zahl'), 3500000);

  const preise = [['A', '12.000 €'], ['B', '980 €'], ['C', '–'], ['D', '1.234,5 €'], ['E', '980 €']];
  assert.deepEqual(T.reihenfolge(preise, 1, 'auf'), [1, 4, 3, 0, 2], 'Zahlen als Zahlen, gleiche Werte stabil, leer unten');
  assert.deepEqual(T.reihenfolge(preise, 1, 'ab'), [0, 3, 1, 4, 2], 'absteigend steht leer trotzdem unten');
  assert.deepEqual(T.reihenfolge(preise, 1, null), [0, 1, 2, 3, 4], 'ohne Richtung wie geschrieben');

  const namen = [['Österreich'], ['Zypern'], ['Oman'], ['Ägypten'], ['Punkt 10'], ['Punkt 2']];
  const txt = T.reihenfolge(namen, 0, 'auf').map((i) => namen[i][0]);
  assert.deepEqual(txt, ['Ägypten', 'Oman', 'Österreich', 'Punkt 2', 'Punkt 10', 'Zypern'], 'deutsches Alphabet, Zahlen im Text der Grösse nach');

  const daten = [['03.01.2027'], ['28.12.2026'], ['1. Jan 2027'], ['']];
  assert.deepEqual(T.reihenfolge(daten, 0, 'auf'), [1, 2, 0, 3]);
});

test('Tabelle: Filter ignoriert Gross/Klein und Umlaute, alle Wörter müssen passen', async () => {
  const { T } = await laden();
  const zeile = ['Jürgen Müller', 'Straße 5', 'Köln'];
  assert.ok(T.filterPasst(zeile, 'muller'));
  assert.ok(T.filterPasst(zeile, 'MUELLER'));
  assert.ok(T.filterPasst(zeile, 'strasse koln'));
  assert.ok(!T.filterPasst(zeile, 'müller berlin'), 'jedes Wort muss vorkommen');
  assert.ok(T.filterPasst(zeile, '   '), 'leerer Filter zeigt alles');
  assert.equal(T.normText('  Äpfel   und\tBÄUME '), 'apfel und baume');
});

/* ------------------------------------------------------------ Spezifikation */

test('Diagramm: Spezifikation prüfen -- nachsichtig bei der Form, streng bei Unsinn', async () => {
  const { D } = await laden();
  const linie = ok(D.pruefeSpec({ art: 'linie', titel: 'Umsatz', einheit: '€', x: ['2026-01', '2026-02', '2026-03'], reihen: [{ name: '2026', werte: [1200, '1.350,5', 'x'] }] }));
  assert.deepEqual(linie.reihen[0].werte, [1200, 1350.5, null], 'Text-Zahlen gelesen, Unsinn wird eine Lücke');
  const ohneX = ok(D.pruefeSpec({ art: 'saeulen', reihen: [{ name: 'A', werte: [1, 2, 3] }] }));
  assert.deepEqual(ohneX.x, ['1', '2', '3'], 'fehlende Beschriftungen werden nummeriert');
  const kurz = ok(D.pruefeSpec({ art: 'vergleich', x: ['a', 'b', 'c'], reihen: [{ name: 'A', werte: [1] }, { name: 'B', werte: [1, 2, 3] }] }));
  assert.deepEqual(kurz.reihen[0].werte, [1, null, null], 'kürzere Reihen werden aufgefüllt');
  const ausTeilen = ok(D.pruefeSpec({ art: 'balken', teile: [{ name: 'Miete', wert: 900 }, { name: 'Essen', wert: '400 €' }] }));
  assert.deepEqual([ausTeilen.x, ausTeilen.reihen[0].werte], [['Miete', 'Essen'], [900, 400]]);
  const werte = ok(D.pruefeSpec({ art: 'saeulen', titel: 'Schritte', werte: [3, 4] }));
  assert.equal(werte.reihen[0].name, 'Schritte');
  assert.equal(ok(D.pruefeSpec({ art: 'bar', werte: [1] })).art, 'balken', 'englische Namen gehen');
  assert.equal(ok(D.pruefeSpec({ art: 'Säulen', werte: [1] })).art, 'saeulen');
  assert.equal(ok(D.pruefeSpec({ art: 'donut', teile: [{ name: 'a', wert: 1 }, { name: 'b', wert: 2 }] })).art, 'ring');
  const kreisAusReihe = ok(D.pruefeSpec({ art: 'kreis', x: ['a', 'b'], reihen: [{ name: 'x', werte: [1, 3] }] }));
  assert.deepEqual(kreisAusReihe.teile, [{ name: 'a', wert: 1 }, { name: 'b', wert: 3 }]);
  const fs1 = ok(D.pruefeSpec({ art: 'fortschritt', wert: '3,2', ziel: 5, einheit: 'km' }));
  assert.deepEqual([fs1.wert, fs1.ziel], [3.2, 5]);
  assert.equal(ok(D.pruefeSpec({ art: 'fortschritt', wert: 40 })).ziel, 100, 'Ziel 100, wenn keins da ist');
  const fsTeile = ok(D.pruefeSpec({ art: 'fortschritt', ziel: 10, teile: [{ name: 'Lesen', wert: 4 }, { name: 'Laufen', wert: 12, ziel: 20 }] }));
  assert.deepEqual(fsTeile.teile, [{ name: 'Lesen', wert: 4 }, { name: 'Laufen', wert: 12, ziel: 20 }]);
  const quelle = ok(D.pruefeSpec({ art: 'saeulen', werte: [1], quelle: 'Destatis 2026', boese: '<script>' }));
  assert.equal(quelle.quelle, 'Destatis 2026');
  assert.ok(!('boese' in quelle), 'unbekannte Felder fallen weg');

  nein(D.pruefeSpec({ art: 'torte' }), /„art“/);
  nein(D.pruefeSpec({ art: 'linie' }), /reihen/);
  nein(D.pruefeSpec({ art: 'linie', reihen: [{ name: 'a', werte: [null, 'x'] }] }), /keine Zahlen/);
  nein(D.pruefeSpec({ art: 'linie', reihen: 'nein' }), /Liste/);
  nein(D.pruefeSpec({ art: 'linie', reihen: [{ name: 'a' }] }), /reihen\[0\]/);
  nein(D.pruefeSpec({ art: 'linie', reihen: Array.from({ length: 7 }, (_, i) => ({ name: `R${i}`, werte: [1] })) }), /Höchstens 6 Reihen/);
  nein(D.pruefeSpec({ art: 'saeulen', werte: Array.from({ length: 61 }, (_, i) => i) }), /Zu viele Balken/);
  assert.equal(ok(D.pruefeSpec({ art: 'linie', werte: Array.from({ length: 365 }, (_, i) => i) })).x.length, 365, 'eine Linie darf lang sein');
  nein(D.pruefeSpec({ art: 'kreis', teile: [{ name: 'a', wert: 0 }] }), /0/);
  nein(D.pruefeSpec({ art: 'kreis', teile: [{ name: 'a', wert: 5 }, { name: 'b', wert: -1 }] }), /negativ/);
  nein(D.pruefeSpec({ art: 'kreis' }), /teile/);
  nein(D.pruefeSpec({ art: 'fortschritt', wert: 3, ziel: 0 }), /größer als 0/);
  nein(D.pruefeSpec({ art: 'fortschritt' }), /„wert“/);
  nein(D.pruefeSpec([1, 2]), /JSON-Objekt/);
});

test('Diagramm: Kreis zeigt höchstens sechs Stücke, der Rest wird „Andere“', async () => {
  const { D } = await laden();
  const teile = [['a', 1], ['b', 9], ['c', 5], ['d', 2], ['e', 3], ['f', 7], ['g', 4], ['h', 6]].map(([name, wert]) => ({ name, wert }));
  const f = D.teileFalten(teile);
  assert.deepEqual(f.map((t) => `${t.name}:${t.wert}`), ['b:9', 'c:5', 'f:7', 'g:4', 'h:6', 'Andere (3):6'], 'die fünf grössten in ihrer Reihenfolge');
  assert.deepEqual(f.map((t) => t.farbe), [0, 1, 2, 3, 4, 'x'], 'Farben in fester Reihenfolge, Andere grau');
  assert.deepEqual(f[5].andere, ['a', 'd', 'e']);
  assert.equal(D.teileFalten(teile.slice(0, 6)).length, 6, 'sechs bleiben sechs');
});

test('Diagramm: Text-Fassung ist eine Markdown-Tabelle mit deutschen Zahlen (Kopieren, Vorlesen)', async () => {
  const { D } = await laden();
  const spec = ok(D.pruefeSpec({ art: 'vergleich', titel: 'Umsatz', einheit: '€', x: ['2026-01', '2026-02'], reihen: [{ name: 'Online', werte: [1200, 1350.5] }, { name: 'Laden | Filiale', werte: [900, null] }], quelle: 'Kasse' }));
  assert.equal(D.textFassung(spec), [
    '**Umsatz**',
    '',
    '| Monat | Online | Laden \\| Filiale |',
    '|---|---|---|',
    '| Januar 2026 | 1.200 € | 900 € |',
    '| Februar 2026 | 1.350,5 € | – |',
    '',
    'Quelle: Kasse',
  ].join('\n'));
  const kreis = ok(D.pruefeSpec({ art: 'kreis', teile: [{ name: 'Miete', wert: 900 }, { name: 'Essen', wert: 300 }] }));
  assert.match(D.textFassung(kreis), /\| Miete \| 900 \| 75 % \|/);
  assert.match(D.textFassung(kreis), /\| Summe \| 1\.200 \| 100 % \|/);
  const fs1 = ok(D.pruefeSpec({ art: 'fortschritt', titel: 'Lauf', wert: 3.2, ziel: 5, einheit: 'km' }));
  assert.equal(D.textFassung(fs1), '**Lauf**\n\n3,2 km von 5 km · 64 %');
  assert.match(D.beschreibung(spec), /^Säulenvergleich: Umsatz, 2 Reihen, 2 Werte von Januar 2026 bis Februar 2026, zwischen 900 € und 1\.350,5 €\.$/);
  assert.match(D.beschreibung(kreis), /Miete 75 %, Essen 25 %/);
});

test('Diagramm: passt als Baustein „diagramm“ in bausteine/index.js (Anmelden, Lesen, Kopieren)', async () => {
  const { D, B } = await laden();
  assert.equal(typeof D.typen.diagramm.pruefen, 'function');
  assert.equal(typeof D.typen.diagramm.render, 'function');
  assert.equal(typeof D.typen.diagramm.text, 'function');
  if (!B) return; // ohne die Bausteine gibt es nichts anzumelden
  B.registrieren(D.typen);
  const erg = B.parse('{"typ":"diagramm","art":"saeulen","titel":"Schritte","x":["Mo","Di"],"reihen":[{"name":"Schritte","werte":[8000,"9.500"]}],}');
  assert.equal(erg.ok, true, erg.fehler);
  assert.deepEqual(erg.spec.reihen[0].werte, [8000, 9500]);
  const kaputt = B.parse('{"typ":"diagramm","art":"kreis","teile":[{"name":"a","wert":-3}]}');
  assert.equal(kaputt.ok, false);
  assert.match(kaputt.fehler, /negativ/, 'der deutsche Satz kommt über dem Codeblock an');
  const md = 'Hier die Woche:\n\n```ui\n{"typ":"diagramm","art":"balken","x":["Mo","Di"],"reihen":[{"name":"Schritte","werte":[8000,9500]}]}\n```\n';
  const kopiert = B.markdownOhneUi(md);
  assert.match(kopiert, /\| Kategorie \| Schritte \|/);
  assert.match(kopiert, /\| Di \| 9\.500 \|/);
  assert.ok(!kopiert.includes('"typ"'), 'kein JSON beim Kopieren');
});
