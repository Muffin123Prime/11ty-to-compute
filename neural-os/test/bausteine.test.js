'use strict';

/**
 * Die Antwort-Bausteine (web/lib/bausteine/*) ohne Browser: Lesen und
 * Pruefen je Typ, die Wertungen (Quiz, Lueckentext, Zuordnung), Zeitformate,
 * Umordnen, Zustandsgrenzen und der Rueckgaengig-Stapel.
 *
 * web/** ist Browser-ESM ohne Bauschritt. Wie test/chat-ansicht.test.js
 * kopiert dieser Test die Dateien unveraendert in ein Zeitverzeichnis (flach,
 * mit der Endung .mjs) und importiert sie -- geprueft wird genau der
 * Quelltext, den der Browser holt. Dass dabei nichts `document` anfasst,
 * ist Teil der Pruefung: die Module muessen ohne DOM ladbar sein.
 *
 * Was nur im Browser zu sehen ist (Ziehen, Umdrehen, Sandkasten), bedient
 * das Pruefskript mit Chromium.
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
  const { home, cleanup } = tempHome('nos-bausteine');
  const alsModul = (src) => src.replace(/(from\s+')([^']+)\.js(')/g, (m, kopf, spec, ende) => `${kopf}./${path.basename(spec)}.mjs${ende}`);
  const ordner = [path.join(WEB, 'lib'), path.join(WEB, 'lib', 'bausteine')];
  for (const dir of ordner) {
    for (const datei of fs.readdirSync(dir)) {
      if (datei.endsWith('.js')) fs.writeFileSync(path.join(home, datei.replace(/\.js$/, '.mjs')), alsModul(fs.readFileSync(path.join(dir, datei), 'utf8')));
    }
  }
  const imp = (name) => import(pathToFileURL(path.join(home, `${name}.mjs`)).href);
  try {
    geladen = {
      B: await imp('index'),
      G: await imp('gemeinsam'),
      Z: await imp('zustand'),
      auswahl: await imp('auswahl'),
      formular: await imp('formular'),
      regler: await imp('regler'),
      quiz: await imp('quiz'),
      lt: await imp('lueckentext'),
      zu: await imp('zuordnung'),
      timer: await imp('timer'),
      cd: await imp('countdown'),
      lern: await imp('lernkarten'),
      termin: await imp('termin'),
      datei: await imp('datei'),
      vorschau: await imp('vorschau'),
      fs: await imp('fortschritt'),
      check: await imp('checkliste'),
      liste: await imp('liste'),
      abschnitte: await imp('abschnitte'),
      sk: await imp('sandkasten'),
    };
  } finally {
    cleanup();
  }
  return geladen;
}

const ok = (erg) => {
  assert.equal(erg.ok, true, erg.fehler);
  return erg.spec;
};
const nein = (erg, teil) => {
  assert.equal(erg.ok, false, 'hätte abgelehnt werden müssen');
  if (teil) assert.match(erg.fehler, teil);
  return erg.fehler;
};

/* ---------------------------------------------------------------- Lesen */

test('Bausteine: alle 22 Typen des Katalogs sind angemeldet (diagramm aus web/lib/diagramm.js)', async () => {
  const { B } = await laden();
  const erwartet = ['auswahl', 'aktionen', 'formular', 'regler', 'karten', 'checkliste', 'schritte', 'abschnitte', 'mehr', 'tabs',
    'liste', 'quiz', 'lernkarten', 'lueckentext', 'zuordnung', 'timer', 'countdown', 'termin', 'datei', 'vorschau', 'fortschritt', 'diagramm'];
  assert.equal(erwartet.length, 22);
  const da = new Set(B.typen());
  for (const t of erwartet) assert.ok(da.has(t), `Typ „${t}“ fehlt`);
});

test('Bausteine: parse liest strenges JSON, repariert Kommentare und Endkommas, sonst ein Satz', async () => {
  const { B } = await laden();
  const s = ok(B.parse('{"typ":"auswahl","frage":"Wie?","optionen":["A","B"]}'));
  assert.equal(s.typ, 'auswahl');
  assert.deepEqual(s.optionen, [{ text: 'A' }, { text: 'B' }]);

  const rep = ok(B.parse('{\n  // Kommentar\n  "typ": "auswahl", /* noch einer */\n  "optionen": ["A", "B",],\n}'));
  assert.equal(rep.optionen.length, 2);
  // Ein "//" in einer Zeichenkette ist kein Kommentar.
  const url = ok(B.parse('{"typ":"karten","karten":[{"titel":"x","aktion":{"text":"Öffnen","link":"https://example.org/a"}}],}'));
  assert.equal(url.karten[0].aktion.link, 'https://example.org/a');

  nein(B.parse(''), /leer/);
  nein(B.parse('{"typ": "auswahl", "optionen": [}'), /Kein gültiges JSON/);
  nein(B.parse('[1,2]'), /JSON-Objekt/);
  nein(B.parse('{"frage":"x"}'), /„typ“ fehlt/);
  nein(B.parse('{"typ":"rakete"}'), /Unbekannter Baustein „rakete“/);
  nein(B.parse(`{"typ":"mehr","inhalt":"${'x'.repeat(B.MAX_QUELLE)}"}`), /zu groß/);
});

test('Bausteine: unbekannte Felder fallen weg, Längen werden gekappt, id nur als fester Schlüssel', async () => {
  const { B } = await laden();
  const s = ok(B.parse(JSON.stringify({ typ: 'auswahl', id: 'wahl-1', frage: 'F'.repeat(900), optionen: ['A', 'B'], boese: '<script>', onclick: 'x' })));
  assert.equal(s.id, 'wahl-1');
  assert.ok(!('boese' in s) && !('onclick' in s));
  assert.ok(s.frage.length <= 300, 'frage gekappt');
  const ohneId = ok(B.parse(JSON.stringify({ typ: 'mehr', id: 'hat leerzeichen', inhalt: 'x' })));
  assert.ok(!('id' in ohneId), 'eine ungültige id fällt weg');
});

test('Bausteine: pruefen je Typ -- gültige Beispiele gehen durch, fehlende Pflichtfelder nennen das Feld', async () => {
  const { B } = await laden();
  const gut = [
    { typ: 'aktionen', aktionen: ['Mehr Beispiele', { text: 'Als Tabelle', symbol: 'datei' }] },
    { typ: 'formular', titel: 'Reise', felder: [{ name: 'ziel', label: 'Ziel', art: 'text', pflicht: true }] },
    { typ: 'regler', regler: [{ name: 'laenge', label: 'Länge', links: 'kurz', rechts: 'ausführlich', wert: 30 }] },
    { typ: 'karten', karten: [{ titel: 'Lissabon', symbol: 'ort', zeilen: ['3 Tage'] }] },
    { typ: 'checkliste', punkte: ['Pass', { text: 'Ticket', erledigt: true }] },
    { typ: 'schritte', schritte: [{ titel: 'Öffnen', inhalt: 'Klick' }] },
    { typ: 'abschnitte', abschnitte: [{ titel: 'A', inhalt: 'x' }] },
    { typ: 'mehr', inhalt: 'Details' },
    { typ: 'tabs', tabs: [{ titel: 'Mac', inhalt: 'a' }, { titel: 'Windows', inhalt: 'b' }] },
    { typ: 'liste', punkte: ['Eins', 'Zwei'] },
    { typ: 'quiz', fragen: [{ frage: '2+2?', optionen: ['3', '4'], richtig: 1 }] },
    { typ: 'lernkarten', karten: [{ vorne: 'Hund', hinten: 'dog' }] },
    { typ: 'lueckentext', text: 'Die Hauptstadt ist {{Berlin}}.' },
    { typ: 'zuordnung', paare: [{ links: 'a', rechts: '1' }, { links: 'b', rechts: '2' }] },
    { typ: 'timer', dauer: '05:00' },
    { typ: 'countdown', ziel: '2026-12-24T18:00' },
    { typ: 'termin', titel: 'Zahnarzt', start: '2026-10-02T10:00', ende: '2026-10-02T11:00' },
    { typ: 'datei', name: 'plan.md', inhalt: '# Plan' },
    { typ: 'vorschau', art: 'html', inhalt: '<h1>Hi</h1>' },
    { typ: 'fortschritt', wert: 3, ziel: 5, einheit: 'km' },
  ];
  for (const g of gut) ok(B.pruefen(g));

  nein(B.pruefen({ typ: 'auswahl' }), /optionen/);
  nein(B.pruefen({ typ: 'aktionen', aktionen: [] }), /mindestens einen/);
  nein(B.pruefen({ typ: 'formular', felder: [{ art: 'text' }] }), /label/);
  nein(B.pruefen({ typ: 'formular', felder: [{ label: 'Wahl', art: 'auswahl' }] }), /optionen/);
  nein(B.pruefen({ typ: 'schritte', schritte: [{ inhalt: 'x' }] }), /titel/);
  nein(B.pruefen({ typ: 'tabs', tabs: [{ titel: 'nur einer', inhalt: 'x' }] }), /mindestens 2/);
  nein(B.pruefen({ typ: 'liste', punkte: ['nur einer'] }), /mindestens 2/);
  nein(B.pruefen({ typ: 'quiz', fragen: [{ frage: 'x', optionen: ['a', 'b'], richtig: 5 }] }), /gibt/);
  nein(B.pruefen({ typ: 'lueckentext', text: 'Ohne Lücke.' }), /Lücke/);
  nein(B.pruefen({ typ: 'timer', dauer: 'bald' }), /dauer/);
  nein(B.pruefen({ typ: 'countdown', ziel: '2026-02-30T10:00' }), /ziel/);
  nein(B.pruefen({ typ: 'termin', titel: 'x', start: '2026-10-02T10:00', ende: '2026-10-02T09:00' }), /nicht nach/);
  nein(B.pruefen({ typ: 'termin', titel: 'x', start: '2026-10-02', ende: '2026-10-03T09:00' }), /dieselbe Form/);
  nein(B.pruefen({ typ: 'datei', name: 'ohne-endung', inhalt: 'x' }), /Endung/);
  nein(B.pruefen({ typ: 'vorschau', art: 'video', inhalt: 'x' }), /art/);
  nein(B.pruefen({ typ: 'vorschau', art: 'svg', inhalt: '<div>kein svg</div>' }), /svg/);
  nein(B.pruefen({ typ: 'fortschritt', wert: 'viel' }), /wert/);
  nein(B.pruefen({ typ: 'fortschritt', wert: 1, ziel: 0 }), /ziel/);
});

/* ------------------------------------------------------ Auswahl / Aktionen */

test('Auswahl: Bestätigung nimmt genau zwei, Doppeltes fällt weg, Vorlage mit {auswahl}', async () => {
  const { B, auswahl } = await laden();
  const b = ok(B.pruefen({ typ: 'auswahl', stil: 'bestaetigung', optionen: ['Abbrechen', 'Löschen', 'Egal'] }));
  assert.deepEqual(b.optionen.map((o) => o.text), ['Abbrechen', 'Löschen']);
  assert.equal(b.eigene, false, 'eine Bestätigung hat keine eigene Antwort');
  const d = ok(B.pruefen({ typ: 'auswahl', optionen: ['A', 'A', 'B'] }));
  assert.equal(d.optionen.length, 2);
  assert.equal(d.eigene, true, 'eigene ist Standard');

  const spec = ok(B.pruefen({ typ: 'auswahl', senden: 'Erkläre es {auswahl}.', optionen: ['einfach', { text: 'genau', senden: 'Bitte ganz genau.' }] }));
  assert.equal(auswahl.auswahlNachricht(spec, ['einfach']), 'Erkläre es einfach.');
  assert.equal(auswahl.auswahlNachricht(spec, ['genau']), 'Bitte ganz genau.', 'senden der Option gewinnt');
  assert.equal(auswahl.auswahlNachricht(spec, ['einfach', 'genau']), 'Erkläre es einfach, genau.');
  assert.equal(auswahl.auswahlNachricht(spec, 'mit Bildern', { eigene: true }), 'Erkläre es mit Bildern.');
  assert.equal(auswahl.KNOEPFE_MAX, 6, 'ab 7 Optionen Aufklappliste');
});

test('Auswahl: Umfrage-Ergebnis zählt nur echte Stimmen (die eigene plus genannte)', async () => {
  const { auswahl } = await laden();
  const r = auswahl.umfrageErgebnis([{ text: 'A' }, { text: 'B' }], ['B']);
  assert.deepEqual(r.map((x) => [x.stimmen, Math.round(x.anteil * 100), x.eigene]), [[0, 0, false], [1, 100, true]]);
  const m = auswahl.umfrageErgebnis([{ text: 'A', stimmen: 3 }, { text: 'B', stimmen: 0 }], ['B']);
  assert.deepEqual(m.map((x) => x.stimmen), [3, 1]);
  assert.equal(Math.round(m[0].anteil * 100), 75);
});

test('Aktionen: höchstens vier, Symbol nur aus der festen Liste oder ein Emoji', async () => {
  const { B, G } = await laden();
  const s = ok(B.pruefen({ typ: 'aktionen', aktionen: ['1', '2', '3', '4', '5'] }));
  assert.equal(s.aktionen.length, 4);
  const sym = ok(B.pruefen({ typ: 'aktionen', aktionen: [{ text: 'a', symbol: 'rakete' }, { text: 'b', symbol: 'KALENDER' }, { text: 'c', symbol: '🚀' }, { text: 'd', symbol: '🚀🚀' }] }));
  assert.deepEqual(sym.aktionen.map((a) => a.symbol || null), [null, 'kalender', '🚀', null]);
  assert.equal(G.istEmoji('👍🏽'), true, 'Hautton gehört zum Emoji');
  assert.equal(G.istEmoji('ab'), false);
});

test('Karten: unsichere Links werden verworfen, nicht zu "Senden" umgedeutet', async () => {
  const { B } = await laden();
  const s = ok(B.pruefen({ typ: 'karten', karten: [
    { titel: 'böse', aktion: { text: 'Klick', link: 'javascript:alert(1)' } },
    { titel: 'gut', aktion: { text: 'Mehr', senden: 'Erzähl mehr über gut' } },
    { titel: 'ohne Ziel', aktion: { text: 'Mach' } },
  ] }));
  assert.equal(s.karten[0].aktion, undefined, 'javascript: fällt weg');
  assert.equal(s.karten[1].aktion.senden, 'Erzähl mehr über gut');
  assert.equal(s.karten[2].aktion.senden, 'Mach', 'ohne senden schickt die Aktion ihren Text');
});

/* ------------------------------------------------------------ Formular */

test('Formular: Pflichtfelder, Zahlengrenzen, echtes Datum; die Nachricht ist lesbar', async () => {
  const { B, formular } = await laden();
  const spec = ok(B.pruefen({ typ: 'formular', titel: 'Reise', felder: [
    { name: 'ziel', label: 'Ziel', art: 'text', pflicht: true },
    { name: 'tage', label: 'Tage', art: 'zahl', min: 1, max: 14 },
    { name: 'ab', label: 'Abreise', art: 'datum' },
    { name: 'um', label: 'Uhrzeit', art: 'uhrzeit' },
    { name: 'mit', label: 'Mit', art: 'mehrfach', optionen: ['Bahn', 'Auto', 'Flug'] },
    { name: 'art', label: 'Unterkunft', art: 'auswahl', optionen: ['Hotel', 'Ferienwohnung'] },
    { name: 'hund', label: 'Mit Hund', art: 'schalter' },
    { name: 'budget', label: 'Budget', art: 'regler', min: 0, max: 5000 },
    { name: 'notiz', label: 'Notiz', art: 'textfeld' },
  ] }));
  const w = formular.startWerte(spec);
  assert.deepEqual(w.mit, []);
  assert.equal(w.hund, false);
  assert.equal(w.budget, 0);

  let p = formular.wertepruefen(spec, w);
  assert.equal(p.ok, false);
  assert.deepEqual(Object.keys(p.fehler), ['ziel']);
  p = formular.wertepruefen(spec, { ...w, ziel: 'Lissabon', tage: '20', ab: '2026-02-30', um: '25:00' });
  assert.deepEqual(Object.keys(p.fehler).sort(), ['ab', 'tage', 'um']);
  assert.match(p.fehler.tage, /Höchstens 14/);
  assert.equal(formular.datumOk('2026-02-28'), true);
  assert.equal(formular.datumOk('2026-02-29'), false, '2026 ist kein Schaltjahr');

  const text = formular.formularText(spec, { ...w, ziel: 'Lissabon', tage: '4', ab: '2026-10-02', um: '09:30', mit: ['Bahn', 'Flug'], art: 'Hotel', hund: true, budget: 1200 });
  assert.equal(text, [
    '**Formular: Reise**',
    'Ziel: Lissabon',
    'Tage: 4',
    'Abreise: Fr., 02.10.2026',
    'Uhrzeit: 09:30 Uhr',
    'Mit: Bahn, Flug',
    'Unterkunft: Hotel',
    'Mit Hund: Ja',
    'Budget: 1.200 von 5.000',
  ].join('\n'), 'leere freiwillige Felder (Notiz) fehlen');
});

test('Regler: Stilnamen stellen den Antwortstil ein, andere Namen werden gesendet', async () => {
  const { B, regler } = await laden();
  const stil = ok(B.pruefen({ typ: 'regler', regler: [{ name: 'laenge', label: 'Länge', wert: 30 }, { name: 'kreativ', label: 'Kreativität', wert: 140 }] }));
  assert.equal(stil.anwenden, 'stil');
  assert.equal(stil.regler[1].wert, 100, 'auf 0–100 gekappt');
  assert.deepEqual(regler.stilAus(stil, { laenge: 12.4 }), { laenge: 12, kreativ: 100 });
  const anders = ok(B.pruefen({ typ: 'regler', regler: [{ name: 'schaerfe', label: 'Schärfe', links: 'mild', rechts: 'scharf', wert: 70 }] }));
  assert.equal(anders.anwenden, 'senden');
  assert.equal(regler.reglerText(anders, { schaerfe: 80 }), '**Meine Einstellung**\nSchärfe: 80/100 (mild ↔ scharf)');
  nein(B.pruefen({ typ: 'regler', anwenden: 'stil', regler: [{ name: 'schaerfe', label: 'x' }] }), /nur mit den Namen/);
});

/* ------------------------------------------------------------ Lernen */

test('Lückentext: Groß/klein, Umlaute (ä = ae = a) und Alternativen sind egal, Falsches bleibt falsch', async () => {
  const { lt } = await laden();
  const teile = lt.lueckenParsen('Die {{Hauptstadt}} von Bayern ist {{München|Muenchen}}. {{}}');
  assert.deepEqual(teile.filter((x) => x.art === 'luecke').map((x) => x.loesungen), [['Hauptstadt'], ['München', 'Muenchen']]);
  assert.equal(teile[teile.length - 1].text.includes('{{}}'), true, 'eine leere Lücke bleibt Text');

  const r = (e, l) => lt.lueckeRichtig(e, l);
  assert.equal(r('münchen', ['München']), true);
  assert.equal(r('MUENCHEN', ['München']), true);
  assert.equal(r('Munchen', ['München']), true);
  assert.equal(r('  München  ', ['München']), true);
  assert.equal(r('Strasse', ['Straße']), true);
  assert.equal(r('koeln', ['Köln', 'Cologne']), true);
  assert.equal(r('cologne', ['Köln', 'Cologne']), true);
  assert.equal(r('Berlin', ['München']), false);
  assert.equal(r('', ['München']), false);
  assert.equal(r('Münch', ['München']), false, 'ein Teil ist nicht die Lösung');
});

test('Quiz: richtig ab 0, als Text, 1-basiert erkannt; Wertung genau', async () => {
  const { quiz } = await laden();
  const opt = ['A', 'B', 'C', 'D'];
  assert.deepEqual(quiz.richtigLesen(1, opt), [1]);
  assert.deepEqual(quiz.richtigLesen([2, 0], opt), [0, 2]);
  assert.deepEqual(quiz.richtigLesen('c', opt), [2]);
  assert.deepEqual(quiz.richtigLesen(4, opt), [3], '4 bei vier Optionen kann nur 1-basiert gemeint sein');
  assert.throws(() => quiz.richtigLesen('Z', opt), /gibt/);

  const spec = { fragen: [
    { frage: '1', optionen: opt, richtig: [1] },
    { frage: '2', optionen: opt, richtig: [0, 2] },
    { frage: '3', optionen: opt, richtig: [3] },
  ] };
  assert.equal(quiz.antwortRichtig(spec.fragen[1], [2, 0]), true, 'Reihenfolge egal');
  assert.equal(quiz.antwortRichtig(spec.fragen[1], [0]), false, 'halb richtig ist falsch');
  const w = quiz.quizWerten(spec, { 0: [1], 1: [0] });
  assert.deepEqual(w, { richtig: 1, beantwortet: 2, gesamt: 3, je: [true, false, null] });
});

test('Lernkarten: Gewusst nimmt heraus, Nochmal legt nach hinten, kaputter Zustand wird neu', async () => {
  const { lern } = await laden();
  let st = lern.stapelAus({}, 3);
  assert.deepEqual(st, { reihe: [0, 1, 2], gewusst: [], runde: 1 });
  st = lern.lernSchritt(st, 'nochmal', 3);
  assert.deepEqual(st.reihe, [1, 2, 0]);
  st = lern.lernSchritt(st, 'gewusst', 3);
  assert.deepEqual([st.reihe, st.gewusst], [[2, 0], [1]]);
  const gemischt = lern.lernSchritt(st, 'mischen', 3, () => 0);
  assert.deepEqual([...gemischt.reihe].sort(), [0, 2]);
  assert.deepEqual(lern.lernSchritt(st, 'neu', 3), { reihe: [0, 1, 2], gewusst: [], runde: 2 });
  assert.deepEqual(lern.stapelAus({ reihe: [0, 0, 7], gewusst: [1] }, 3).reihe, [0, 2], 'ungültige Reihe wird ersetzt');
});

test('Zuordnung: rechts stabil gemischt (nie die Lösung), eine rechte Karte gehört zu einer linken', async () => {
  const { B, zu } = await laden();
  const spec = ok(B.pruefen({ typ: 'zuordnung', paare: [{ links: 'Hund', rechts: 'dog' }, { links: 'Katze', rechts: 'cat' }, { links: 'Maus', rechts: 'mouse' }] }));
  const r1 = zu.rechteReihenfolge(spec);
  assert.deepEqual(r1, zu.rechteReihenfolge(spec), 'dieselbe Reihenfolge bei jedem Zeichnen');
  assert.deepEqual([...r1].sort(), [0, 1, 2]);
  assert.ok(r1.some((x, i) => x !== i), 'nie schon gelöst');
  let z = zu.verbinden({}, 0, 1);
  z = zu.verbinden(z, 2, 1);
  assert.deepEqual(z, { 2: 1 }, 'rechts 1 wandert von links 0 zu links 2');
  z = zu.verbinden(z, 2, 1);
  assert.deepEqual(z, {}, 'dieselbe Verbindung noch einmal löst sie');
  assert.deepEqual(zu.zuordnungPruefen(3, { 0: 0, 1: 2, 2: 1 }), { richtig: 1, gesamt: 3, je: [true, false, false] });
  assert.deepEqual(zu.zuordnungLesen({ 0: 1, 1: 1, 5: 0, x: 2 }, 3), { 0: 1 });
});

/* ---------------------------------------------------------------- Zeit */

test('Timer: Dauer in allen erlaubten Formen, Anzeige und Restzeit über Pause', async () => {
  const { timer } = await laden();
  const d = timer.dauerLesen;
  assert.equal(d('05:00'), 300);
  assert.equal(d('1:30:00'), 5400);
  assert.equal(d(90), 90);
  assert.equal(d('90'), 90);
  assert.equal(d('25 min'), 1500);
  assert.equal(d('1,5 h'), 5400);
  assert.equal(d('0:00'), null);
  assert.equal(d('25:00:00'), null, 'mehr als 24 Stunden');
  assert.equal(d('bald'), null);
  assert.equal(timer.zeitFormat(299.2), '05:00', 'aufgerundet: 00:00 ist wirklich das Ende');
  assert.equal(timer.zeitFormat(59), '00:59');
  assert.equal(timer.zeitFormat(3723), '1:02:03');
  assert.equal(timer.zeitFormat(-4), '00:00');
  const dauer = 60000;
  assert.equal(timer.timerRest({}, dauer, 1000), 60000);
  assert.equal(timer.timerRest({ laeuft: true, start: 1000, verbraucht: 0 }, dauer, 11000), 50000);
  assert.equal(timer.timerRest({ laeuft: false, verbraucht: 20000 }, dauer, 999999), 40000, 'pausiert läuft nichts');
  assert.equal(timer.timerRest({ laeuft: true, start: 0, verbraucht: 20000 }, dauer, 100000), 0);
});

test('Countdown: Wandzeit ohne Zone, ungültige Tage abgelehnt, Teile stimmen', async () => {
  const { cd } = await laden();
  assert.equal(cd.zielLesen('2026-02-30T10:00'), null);
  assert.equal(cd.zielLesen('2026-12-24T24:00'), null);
  const z = cd.zielLesen('2026-12-24T18:00');
  assert.equal(z.getHours(), 18, 'Ortszeit, nicht UTC');
  const t = cd.countdownTeile(z.getTime(), z.getTime() - ((2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000));
  assert.deepEqual(t, { vorbei: false, tage: 2, stunden: 3, minuten: 4, sekunden: 5 });
  assert.equal(cd.countdownTeile(z.getTime(), z.getTime() + 1).vorbei, true);
});

test('Termin: Felder wie beim Werkzeug (source auto, chatId), ganztägig erkannt', async () => {
  const { B, termin } = await laden();
  const s = ok(B.pruefen({ typ: 'termin', titel: 'Zahnarzt', start: '2026-10-02 10:00:00', ort: 'Praxis', notiz: 'Karte mitnehmen' }));
  assert.equal(s.start, '2026-10-02T10:00', 'Sekunden und Leerzeichen werden zur Kalenderform');
  assert.deepEqual(termin.terminKoerper(s, 'chat_1'), { title: 'Zahnarzt', start: '2026-10-02T10:00', source: 'auto', location: 'Praxis', body: 'Karte mitnehmen', chatId: 'chat_1' });
  const g = ok(B.pruefen({ typ: 'termin', titel: 'Urlaub', start: '2026-10-05', ende: '2026-10-09' }));
  assert.equal(termin.terminKoerper(g).allDay, true);
  assert.match(termin.terminWann(g), /– /);
});

/* ------------------------------------------------------ Ordnen, Zustand */

test('Umordnen: verschiebt ohne das Original zu ändern, erkennt kaputte Reihenfolgen', async () => {
  const { G } = await laden();
  const a = ['a', 'b', 'c', 'd'];
  assert.deepEqual(G.umordnen(a, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(G.umordnen(a, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(G.umordnen(a, 1, 99), ['a', 'c', 'd', 'b'], 'über das Ende hinaus = ans Ende');
  assert.deepEqual(G.umordnen(a, 9, 0), a, 'unbekannte Quelle ändert nichts');
  assert.deepEqual(a, ['a', 'b', 'c', 'd']);
  assert.equal(G.istUmordnung([2, 0, 1], 3), true);
  assert.equal(G.istUmordnung([0, 0, 1], 3), false);
  assert.equal(G.istUmordnung([0, 1], 3), false);
  const m = G.mischen(10, 42);
  assert.deepEqual(m, G.mischen(10, 42));
  assert.deepEqual([...m].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('Checkliste und Liste: gespeicherter Zustand gewinnt, Nachricht mit der Reihenfolge', async () => {
  const { B, check, liste } = await laden();
  const c = ok(B.pruefen({ typ: 'checkliste', punkte: ['a', { text: 'b', erledigt: true }, 'c'] }));
  assert.deepEqual([...check.erledigteAus(c, {})], [1]);
  assert.deepEqual([...check.erledigteAus(c, { erledigt: [0, 2, 9] })], [0, 2], 'fremde Nummern fallen weg');
  const l = ok(B.pruefen({ typ: 'liste', titel: 'Prioritäten', punkte: ['Sport', 'Lesen', 'Kochen'] }));
  assert.equal(l.sortierbar, true, 'sortierbar ist Standard');
  assert.equal(liste.reihenfolgeText(l, [2, 0, 1]), '**Prioritäten** – meine Reihenfolge:\n1. Kochen\n2. Sport\n3. Lesen');
});

test('Zustand: Grenzen 16 KB je Baustein und 64 KB je Nachricht, in UTF-8 gezählt', async () => {
  const { Z } = await laden();
  assert.equal(Z.groesse({ a: 'ä' }), JSON.stringify({ a: 'x' }).length + 1, 'ä zählt zwei Bytes');
  assert.equal(Z.passt({ x: 'a'.repeat(16000) }).ok, true);
  const gross = Z.passt({ x: 'a'.repeat(16400) });
  assert.equal(gross.ok, false);
  assert.match(gross.grund, /16 KB/);
  const voll = Z.passt({ x: 'a'.repeat(1000) }, 64 * 1024 - 500);
  assert.equal(voll.ok, false);
  assert.match(voll.grund, /64 KB/);
});

test('Zustand: Rückgängig/Wiederholen je Nachricht in der richtigen Reihenfolge, über mehrere Bausteine', async () => {
  const { Z } = await laden();
  const n = `m_${Date.now()}`;
  const stand = { a: {}, b: {} };
  Z.anmelden(n, 'a', (z) => { stand.a = z; });
  Z.anmelden(n, 'b', (z) => { stand.b = z; });
  const schreibe = (k, neu) => {
    Z.aufzeichnen(n, { schluessel: k, vorher: stand[k], nachher: neu, was: 'x' });
    stand[k] = neu;
  };
  schreibe('a', { erledigt: [0] });
  schreibe('b', { reihenfolge: [1, 0] });
  schreibe('a', { erledigt: [0, 2] });
  assert.equal(Z.stapelStand(n).bei, 'a');
  Z.rueckgaengig(n);
  assert.deepEqual(stand.a, { erledigt: [0] });
  assert.equal(Z.stapelStand(n).bei, 'b', 'als Nächstes wird die Liste zurückgenommen');
  Z.rueckgaengig(n);
  assert.deepEqual(stand.b, {});
  Z.wiederholen(n);
  assert.deepEqual(stand.b, { reihenfolge: [1, 0] });
  schreibe('b', { reihenfolge: [0, 1] });
  assert.equal(Z.stapelStand(n).kannVor, false, 'eine neue Änderung verwirft das Wiederholen');
  assert.equal(Z.rueckgaengig('gibt_es_nicht'), null);
  // Strg+Z in einem Textfeld gehört dem Feld
  const ereignis = (ziel, extra = {}) => ({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: ziel, preventDefault() { this.defaultPrevented = true; }, ...extra });
  const imFeld = { closest: () => ({}) };
  const draussen = { closest: () => null };
  assert.equal(Z.tasteBehandeln(ereignis(imFeld), n), false);
  assert.equal(Z.tasteBehandeln(ereignis(draussen), n), true);
  assert.deepEqual(stand.b, { reihenfolge: [1, 0] });
  assert.equal(Z.tasteBehandeln(ereignis(draussen, { shiftKey: true }), n), true);
  assert.deepEqual(stand.b, { reihenfolge: [0, 1] });
});

test('Zustand: nachrichtenZustand speichert entprellt und lehnt Übergroßes ab', async () => {
  const { Z } = await laden();
  const gespeichert = [];
  const z = Z.nachrichtenZustand({ start: { b0: { x: 1 } }, verzoegerungMs: 20, speichern: async (k, v) => { gespeichert.push([k, v]); } });
  assert.deepEqual(z.fuer('b0').lesen(), { x: 1 });
  z.fuer('b1').schreiben({ y: 1 });
  z.fuer('b1').schreiben({ y: 2 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(gespeichert, [['b1', { y: 2 }]], 'zweimal schreiben = einmal speichern, mit dem letzten Stand');
  assert.throws(() => z.fuer('b2').schreiben({ riesig: 'x'.repeat(17000) }), /16 KB/);
  assert.deepEqual(z.alle(), { b0: { x: 1 }, b1: { y: 2 } });
});

/* ---------------------------------------------------------- Im Markdown */

test('Segmente: ```ui-Blöcke gefunden, ```ui in anderem Zaun bleibt Text, offene Blöcke erkannt', async () => {
  const { B } = await laden();
  const md = [
    'Vorher',
    '```ui',
    '{"typ":"mehr","inhalt":"x"}',
    '```',
    '````markdown',
    '```ui',
    '{"typ":"quiz"}',
    '```',
    '````',
    'Danach',
    '~~~ui',
    '{"typ":"mehr",',
  ].join('\n');
  const s = B.segmente(md);
  assert.deepEqual(s.map((x) => x.art), ['text', 'ui', 'text', 'ui']);
  assert.equal(s[1].closed, true);
  assert.equal(s[3].closed, false);
  assert.ok(s[2].text.includes('{"typ":"quiz"}'), 'Beispiel im Markdown-Zaun ist kein Baustein');
  assert.equal(B.istUi('ui'), true);
  assert.equal(B.istUi('UI extra'), true);
  assert.equal(B.istUi('uix'), false);
});

test('Text-Fassung: Kopieren und Vorlesen bekommen lesbaren Text statt JSON', async () => {
  const { B } = await laden();
  const md = 'Wähle:\n\n```ui\n{"typ":"auswahl","frage":"Wie?","optionen":["Kurz","Lang"]}\n```\n\n```ui\n{kaputt\n```';
  const out = B.markdownOhneUi(md);
  assert.ok(out.includes('Wie?\n• Kurz\n• Lang'));
  assert.ok(!out.includes('"typ"'), 'kein JSON eines gültigen Bausteins');
  assert.ok(out.includes('{kaputt'), 'ein kaputter Block bleibt als Code stehen');
  assert.equal(B.zaun('a ``` b', 'json').startsWith('````json'), true, 'der Zaun ist länger als jede Backtick-Folge');
  assert.equal(B.textFassung({ typ: 'aktionen', aktionen: [{ text: 'x' }] }), '', 'Angebote sind kein Inhalt');
});

/* -------------------------------------------------- Dateien, Vorschau */

test('Datei: CSV mit Semikolon, Anführungszeichen und Umbruch im Feld; Art aus der Endung', async () => {
  const { datei } = await laden();
  assert.deepEqual(datei.csvLesen('Name;Preis\n"Müller; Sohn";"3,50"\n"Zeile\nzwei";"sagt ""hi"""\n'), [
    ['Name', 'Preis'], ['Müller; Sohn', '3,50'], ['Zeile\nzwei', 'sagt "hi"'],
  ]);
  assert.deepEqual(datei.csvLesen('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(datei.csvLesen('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.equal(datei.dateiArt('Plan.MD').art, 'markdown');
  assert.equal(datei.dateiArt('seite.html').art, 'html');
  assert.equal(datei.dateiArt('x.py').sprache, 'python');
  assert.equal(datei.dateiArt('daten.xyz').art, 'text');
});

test('Datei: Name ohne Pfad und ohne verbotene Zeichen', async () => {
  const { B } = await laden();
  const s = ok(B.pruefen({ typ: 'datei', name: '../../etc/pa:ss?wd.txt', inhalt: 'x' }));
  assert.equal(s.name, 'etcpasswd.txt');
});

test('Vorschau: Folien trennen an ---, nicht in Codezäunen; SVG-Maße aus viewBox', async () => {
  const { vorschau, sk } = await laden();
  const f = vorschau.folienTeilen('# Eins\n\n---\n\n# Zwei\n```yaml\n---\nkey: x\n```\n---\n# Drei\n---\n');
  assert.equal(f.length, 3);
  assert.ok(f[1].includes('key: x'));
  assert.deepEqual(sk.svgMasse('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">'), { breite: 400, hoehe: 200 });
  assert.deepEqual(sk.svgMasse('<svg width="120" height="80">'), { breite: 120, hoehe: 80 });
  assert.equal(sk.svgMasse('<div>'), null);
});

test('Fortschritt und Abschnitte: Prozent passt zur Zahl, der erste Abschnitt ist offen', async () => {
  const { B, fs: f, abschnitte } = await laden();
  assert.equal(f.fortschrittText(ok(B.pruefen({ typ: 'fortschritt', wert: 3.2, ziel: 5, einheit: 'km' }))), '3,2 von 5 km · 64 %');
  assert.equal(f.fortschrittText(ok(B.pruefen({ typ: 'fortschritt', wert: 40 }))), '40 %');
  assert.deepEqual(abschnitte.startOffen(ok(B.pruefen({ typ: 'abschnitte', abschnitte: [{ titel: 'a', inhalt: '' }, { titel: 'b', inhalt: '' }] }))), [0]);
  assert.deepEqual(abschnitte.startOffen(ok(B.pruefen({ typ: 'abschnitte', abschnitte: [{ titel: 'a', inhalt: '' }, { titel: 'b', inhalt: '', offen: true }] }))), [1]);
});

