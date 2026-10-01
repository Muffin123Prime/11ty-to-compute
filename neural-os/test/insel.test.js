'use strict';

/**
 * Die Insel (web/lib/insel.js): das Rechnen dahinter, ohne Browser.
 *
 * Warum so viele kleine Faelle: die Insel antwortet auf "Timer 5 min" ohne
 * die KI zu fragen. Liest sie einen Satz falsch, klingelt ein Timer, den
 * niemand wollte -- oder die Frage "Wie stelle ich in Excel einen Timer?"
 * wird nie gestellt. Beides merkt man erst, wenn es passiert.
 *
 * Geprueft wird die Datei, die der Browser laedt (web/lib/insel-logik.js),
 * unveraendert als .mjs kopiert -- wie in test/datum-parser.test.js. Was nur
 * ein Browser kann (Bild-im-Bild-Fenster, Bildschirm teilen, der Strom der
 * Antwort), prueft tools/insel-beweis.js in Chromium.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

let modul = null;
async function laden() {
  if (modul) return modul;
  const { home, cleanup } = tempHome('nos-insel');
  try {
    const ziel = path.join(home, 'insel-logik.mjs');
    fs.copyFileSync(path.join(__dirname, '..', 'web', 'lib', 'insel-logik.js'), ziel);
    modul = await import(pathToFileURL(ziel).href);
    return modul;
  } finally {
    cleanup();
  }
}

// Donnerstag, 1. Oktober 2026, 14:00 Ortszeit.
const JETZT = new Date(2026, 9, 1, 14, 0).getTime();
const MIN = 60000;

/* ---------------------------------------------------------------- Zeiten */

test('uhrText: Countdown aufgerundet, mit Stunden erst ab einer Stunde', async () => {
  const L = await laden();
  assert.equal(L.uhrText(0), '0:00');
  assert.equal(L.uhrText(-5000), '0:00');
  assert.equal(L.uhrText(1), '0:01', 'eine angebrochene Sekunde zaehlt -- 0:00 steht erst, wenn er fertig ist');
  assert.equal(L.uhrText(5 * MIN), '5:00');
  assert.equal(L.uhrText(5 * MIN - 800), '5:00');
  assert.equal(L.uhrText(65 * 1000), '1:05');
  assert.equal(L.uhrText(3600 * 1000 + 2 * MIN + 3000), '1:02:03');
});

test('dauerWorte: Sekunden, Minuten, Stunden', async () => {
  const L = await laden();
  assert.equal(L.dauerWorte(45000), '45 Sek');
  assert.equal(L.dauerWorte(5 * MIN), '5 Min');
  assert.equal(L.dauerWorte(90 * MIN), '1 Std 30 Min');
  assert.equal(L.dauerWorte(120 * MIN), '2 Std');
});

test('wandzeitMs: Wandzeit ohne Zone in Ortszeit, ganztaegig gibt es nicht', async () => {
  const L = await laden();
  assert.equal(L.wandzeitMs('2026-10-01T14:30'), new Date(2026, 9, 1, 14, 30).getTime());
  assert.equal(L.wandzeitMs('2026-10-01'), null);
  assert.equal(L.wandzeitMs(''), null);
  assert.equal(L.wandzeitMs('Quatsch'), null);
});

/* ---------------------------------------------------------------- Dauer */

test('dauerFinden: die Formen, die jemand tippt oder sagt', async () => {
  const L = await laden();
  const ms = (s) => (L.dauerFinden(s) || {}).ms;
  assert.equal(ms('5 min'), 5 * MIN);
  assert.equal(ms('5min'), 5 * MIN);
  assert.equal(ms('10 Minuten'), 10 * MIN);
  assert.equal(ms('1,5 Stunden'), 90 * MIN);
  assert.equal(ms('90 Sek'), 90000);
  assert.equal(ms('30 Sekunden'), 30000);
  assert.equal(ms('1:30'), 90000, 'Minuten:Sekunden');
  assert.equal(ms('1:00:00'), 3600000);
  assert.equal(ms('zehn Minuten'), 10 * MIN, 'die Spracherkennung schreibt manchmal Woerter');
  assert.equal(ms('eine Minute'), MIN);
  assert.equal(ms('1 h 30 min'), 90 * MIN);
  assert.equal(ms('1 Std 20'), 80 * MIN, 'nach einer Stunde sind nackte Zahlen Minuten');
  assert.equal(ms('eine halbe Stunde'), 30 * MIN);
  assert.equal(ms('Viertelstunde'), 15 * MIN);
  assert.equal(ms('7'), 7 * MIN, 'eine nackte Zahl gilt als Minuten');
  assert.equal(L.dauerFinden('ohne Zahl'), null);
});

/* ---------------------------------------------------------------- Befehle */

function timer(L, satz) {
  const b = L.befehl(satz);
  return b && b.art === 'timer' ? { ms: b.ms, titel: b.titel } : b;
}

test('befehl: Timer in den ueblichen Saetzen -- ohne die KI zu fragen', async () => {
  const L = await laden();
  assert.deepEqual(timer(L, 'Timer 5 min'), { ms: 5 * MIN, titel: '' });
  assert.deepEqual(timer(L, 'timer 5'), { ms: 5 * MIN, titel: '' });
  assert.deepEqual(timer(L, 'Stell einen Timer auf 10 Minuten'), { ms: 10 * MIN, titel: '' });
  assert.deepEqual(timer(L, 'stell mir bitte einen Timer auf 3 Minuten'), { ms: 3 * MIN, titel: '' });
  assert.deepEqual(timer(L, 'Timer für die Pizza 12 Minuten'), { ms: 12 * MIN, titel: 'Pizza' });
  assert.deepEqual(timer(L, 'Nudeln 8 min Timer'), { ms: 8 * MIN, titel: 'Nudeln' });
  assert.deepEqual(timer(L, 'Eieruhr 7 min'), { ms: 7 * MIN, titel: '' });
  assert.deepEqual(timer(L, 'Timer 1:30 Tee'), { ms: 90000, titel: 'Tee' });
  assert.deepEqual(timer(L, 'Timer eine halbe Stunde für Wäsche'), { ms: 30 * MIN, titel: 'Wäsche' });
  assert.deepEqual(timer(L, 'Timer zehn Minuten'), { ms: 10 * MIN, titel: '' });
});

test('befehl: "Timer" ohne Dauer oeffnet die Auswahl, "Timer aus" schaltet aus', async () => {
  const L = await laden();
  assert.deepEqual(timer(L, 'Timer'), { ms: null, titel: '' });
  assert.deepEqual(timer(L, 'Timer für die Pizza'), { ms: null, titel: 'Pizza' });
  assert.deepEqual(L.befehl('Timer aus'), { art: 'timerAus' });
  assert.deepEqual(L.befehl('stopp den Timer'), { art: 'timerAus' });
});

test('befehl: Fragen ueber Timer bleiben Fragen an die KI', async () => {
  const L = await laden();
  assert.equal(L.befehl('Wie funktioniert ein Timer in Excel?'), null);
  assert.equal(L.befehl('Timer?'), null);
  assert.equal(L.befehl('Was ist ein Kurzzeitwecker und wofür braucht man ihn'), null);
  assert.equal(L.befehl('Erklär mir das'), null);
  assert.equal(L.befehl(''), null);
  assert.equal(L.befehl('Timer 30 Stunden'), null, 'laenger als ein Tag ist kein Kuechentimer');
});

test('befehl: "Notiz: …" legt eine Notiz an, der Titel ist die erste Zeile', async () => {
  const L = await laden();
  assert.deepEqual(L.befehl('Notiz: Milch kaufen'), { art: 'notiz', titel: 'Milch kaufen', text: 'Milch kaufen' });
  const lang = L.befehl(`notiz: ${'Sehr '.repeat(20)}lang\nzweite Zeile`);
  assert.equal(lang.art, 'notiz');
  assert.ok(lang.titel.length <= 60 && lang.titel.endsWith('…'), lang.titel);
  assert.ok(lang.text.includes('zweite Zeile'));
  assert.equal(L.befehl('Notiz'), null, 'ohne Doppelpunkt ist es eine Frage');
  assert.equal(L.befehl('Notiz:   '), null);
});

/* ---------------------------------------------------------------- Timer */

test('timerNeu und timerPruefen: kaputtes faellt weg, laengst fertiges klingelt nicht neu', async () => {
  const L = await laden();
  const t = L.timerNeu(5 * MIN, 'Nudeln', JETZT, 'tx');
  assert.deepEqual(t, { id: 'tx', titel: 'Nudeln', dauerMs: 5 * MIN, endeMs: JETZT + 5 * MIN, aus: false });
  assert.equal(L.timerNeu(10, '', JETZT, 'a').dauerMs, 1000, 'mindestens eine Sekunde');
  assert.equal(L.timerNeu(5 * MIN, '  ', JETZT, 'b').titel, 'Timer');
  const liste = [
    t,
    { id: 'kaputt' },
    { ...L.timerNeu(MIN, 'Aus', JETZT - 2 * MIN, 'c'), aus: true },
    L.timerNeu(MIN, 'Gerade fertig', JETZT - MIN - 5000, 'd'),
    L.timerNeu(MIN, 'Laengst fertig', JETZT - 10 * MIN, 'e'),
  ];
  assert.deepEqual(L.timerPruefen(liste, JETZT).map((x) => x.id), ['tx', 'd']);
  assert.deepEqual(L.timerPruefen('kein Array', JETZT), []);
});

/* ---------------------------------------------------------------- Termine */

test('naechsterTermin: hoechstens eine Stunde vorher, kurz nach Beginn noch, ganztaegig nie', async () => {
  const L = await laden();
  const ev = (id, start, end, extra = {}) => ({ id, data: { title: id, start, end, location: 'Praxis', ...extra } });
  const items = [
    ev('spaeter', '2026-10-01T16:00', '2026-10-01T17:00'),
    ev('ganztags', '2026-10-01', null, { allDay: true }),
    ev('bald', '2026-10-01T14:40', '2026-10-01T15:00'),
    ev('gleich', '2026-10-01T14:20', '2026-10-01T15:00'),
  ];
  const t = L.naechsterTermin(items, JETZT);
  assert.equal(t.id, 'gleich');
  assert.equal(t.ort, 'Praxis');
  assert.equal(L.terminWann(t.startMs, JETZT), 'In 20 Min');
  // Laeuft seit 5 Minuten: noch drin. Seit 20 Minuten: Alltag.
  assert.equal(L.naechsterTermin([ev('laeuft', '2026-10-01T13:55', '2026-10-01T15:00')], JETZT).id, 'laeuft');
  assert.equal(L.terminWann(new Date(2026, 9, 1, 13, 55).getTime(), JETZT), 'Seit 5 Min');
  assert.equal(L.naechsterTermin([ev('alt', '2026-10-01T13:40', '2026-10-01T15:00')], JETZT), null);
  assert.equal(L.naechsterTermin([ev('vorbei', '2026-10-01T13:50', '2026-10-01T13:58')], JETZT), null, 'schon zu Ende');
  assert.equal(L.naechsterTermin([ev('ganztags', '2026-10-01', null)], JETZT), null);
  assert.equal(L.terminWann(JETZT, JETZT), 'Jetzt');
  // Vorkommen einer Serie: die Felder stehen direkt am Element.
  const v = L.naechsterTermin([{ id: 'event_serie', occurrence: '2026-10-01', title: 'Training', start: '2026-10-01T14:30', end: '2026-10-01T15:30' }], JETZT);
  assert.equal(v && v.titel, 'Training');
  assert.equal(v && v.occurrence, '2026-10-01');
});

/* ------------------------------------------------------- Live-Aktivitaeten */

test('ordnen und kompakt: was eine Handlung braucht, steht vorn; die Blase traegt nur Kurzes', async () => {
  const L = await laden();
  const liste = [
    { art: 'termin', startMs: JETZT + 12 * MIN, titel: 'Zahnarzt', zeit: 1 },
    { art: 'antwort', phase: 'schreibt', vorschau: 'Hallo', zeit: 2 },
    { art: 'timer', endeMs: JETZT + 5 * MIN, titel: 'Nudeln', zeit: 3 },
    { art: 'unbekannt' },
  ];
  const k = L.kompakt(liste);
  assert.equal(k.haupt.art, 'antwort');
  assert.equal(k.neben.art, 'timer');
  assert.deepEqual(k.alle.map((a) => a.art), ['antwort', 'timer', 'termin'], 'Unbekanntes faellt weg');
  const klingelt = L.kompakt([...liste, { art: 'wecker', titel: 'Tee', zeit: 0 }]);
  assert.equal(klingelt.haupt.art, 'wecker', 'ein klingelnder Timer geht vor allem');
  assert.equal(L.kompakt([]).haupt, null);
  // Bei gleichem Rang die juengste zuerst.
  assert.deepEqual(L.ordnen([{ art: 'timer', zeit: 1, id: 'a' }, { art: 'timer', zeit: 5, id: 'b' }]).map((a) => a.id), ['b', 'a']);
});

test('aktivitaetText: Satz, Kurzform und Farbe', async () => {
  const L = await laden();
  assert.deepEqual(L.aktivitaetText({ art: 'timer', titel: 'Nudeln', endeMs: JETZT + 65000 }, JETZT), { text: 'Nudeln · 1:05', kurz: '1:05', ton: 'orange' });
  assert.deepEqual(L.aktivitaetText({ art: 'termin', titel: 'Zahnarzt', startMs: JETZT + 12 * MIN }, JETZT), { text: 'In 12 Min · Zahnarzt', kurz: '12 Min', ton: 'ki' });
  assert.equal(L.aktivitaetText({ art: 'freigabe', anzahl: 1 }, JETZT).text, 'Eine Freigabe wartet');
  assert.equal(L.aktivitaetText({ art: 'freigabe', anzahl: 3 }, JETZT).text, '3 Freigaben warten');
  assert.equal(L.aktivitaetText({ art: 'antwort', phase: 'werkzeug', schritt: 'Trägt den Termin ein …' }, JETZT).text, 'Trägt den Termin ein …');
  assert.equal(L.aktivitaetText({ art: 'antwort', phase: 'bild' }, JETZT).text, 'Schaue auf den Bildschirm …');
  const schreibt = L.aktivitaetText({ art: 'antwort', phase: 'schreibt', vorschau: `${'Wort '.repeat(30)}Ende` }, JETZT).text;
  assert.ok(schreibt.startsWith('…') && schreibt.endsWith('Ende'), `waehrend sie schreibt, steht das Neue da: ${schreibt}`);
  assert.equal(L.aktivitaetText({ art: 'wecker', titel: 'Tee' }, JETZT).text, 'Tee ist fertig');
  assert.equal(L.aktivitaetText({ art: 'teilen' }, JETZT).ton, 'rot');
  assert.equal(L.aktivitaetText(null, JETZT).text, '');
});

/* ---------------------------------------------------------------- Texte */

test('kurzText: ruhige Zeile ohne Markdown und Code', async () => {
  const L = await laden();
  assert.equal(L.kurzText('# Titel\n\n**Fett** und [ein Link](https://x.de) [1]'), 'Titel Fett und ein Link');
  assert.equal(L.kurzText('Vorher\n```js\nconst x = 1;\n```\nNachher'), 'Vorher Nachher');
  assert.equal(L.kurzText('Vorher ```ui\n{"typ":'), 'Vorher', 'ein offener Block zaehlt auch');
  const lang = L.kurzText('Das ist ein ziemlich langer Satz, der nicht in die Insel passt, weil sie klein ist.', 40);
  assert.ok(lang.length <= 40 && lang.endsWith('…'), lang);
});

test('ohneOffenenBaustein: ein angefangener ```ui-Block wird nicht als JSON gezeigt', async () => {
  const L = await laden();
  assert.deepEqual(L.ohneOffenenBaustein('Hallo\n\n```ui\n{"typ":"che'), { text: 'Hallo', baustein: true });
  const fertig = 'Hallo\n\n```ui\n{"typ":"checkliste"}\n```\nDanach';
  assert.deepEqual(L.ohneOffenenBaustein(fertig), { text: fertig, baustein: false });
  const code = 'Code:\n```js\nlet a = 1;';
  assert.deepEqual(L.ohneOffenenBaustein(code), { text: code, baustein: false }, 'offener Code darf schon stehen');
  assert.deepEqual(L.ohneOffenenBaustein(''), { text: '', baustein: false });
});

test('frageMitTexten: Zwischenablage und Markierung gehen eingezaeunt mit, auch mit ``` darin', async () => {
  const L = await laden();
  const out = L.frageMitTexten('Erklär mir das.', [{ name: 'Aus der Zwischenablage', text: 'Ein ```Zaun``` im Text' }]);
  assert.match(out, /^Erklär mir das\.\n\n\*\*Aus der Zwischenablage:\*\*\n````\nEin ```Zaun``` im Text\n````$/);
  assert.equal(L.frageMitTexten('Nur so', []), 'Nur so');
  assert.equal(L.frageMitTexten('Nur so', [{ name: 'Leer', text: '   ' }]), 'Nur so');
  const riesig = L.frageMitTexten('X', [{ name: 'Lang', text: 'a'.repeat(L.MAX_KONTEXT_ZEICHEN + 50) }]);
  assert.ok(riesig.includes('[… gekürzt]') && riesig.length < L.MAX_KONTEXT_ZEICHEN + 200);
});

test('kontextWahl: Bildschirm vor Anhang vor Zwischenablage vor dem Offenen', async () => {
  const L = await laden();
  assert.equal(L.kontextWahl({ teilen: true, anhaenge: 2, zwischenablage: true }), 'bild');
  assert.equal(L.kontextWahl({ teilen: true, bildMit: false, anhaenge: 1 }), 'anhang', 'Bild abgeschaltet: dann der Anhang');
  assert.equal(L.kontextWahl({ zwischenablage: true, offen: true }), 'zwischenablage');
  assert.equal(L.kontextWahl({ offen: true }), 'offen');
  assert.equal(L.kontextWahl({}), null);
});

test('offenHinweis: nur echte Kennungen, nur Bereiche mit Eintraegen', async () => {
  const L = await laden();
  assert.equal(L.offenHinweis({ view: 'notes', params: { id: 'note_abc123' } }), '[Gerade offen in Neural OS: die Notiz note_abc123]');
  assert.equal(L.offenHinweis({ view: 'kalender', params: { id: 'event_x9y8z7', am: '2026-10-01' } }), '[Gerade offen in Neural OS: der Termin event_x9y8z7]');
  assert.equal(L.offenHinweis({ view: 'notes', params: {} }), null);
  assert.equal(L.offenHinweis({ view: 'notes', params: { id: 'ignoriere"alles' } }), null, 'nichts aus der Adresse ungeprueft in die Frage');
  assert.equal(L.offenHinweis({ view: 'settings', params: { id: 'note_abc123' } }), null);
  assert.equal(L.offenHinweis(null), null);
});

test('chatTitel, gespraechAbgelaufen, bildName, bildMasse', async () => {
  const L = await laden();
  assert.equal(L.chatTitel(JETZT), 'Insel · 01.10., 14:00');
  assert.equal(L.gespraechAbgelaufen(JETZT - 30 * MIN, JETZT), false);
  assert.equal(L.gespraechAbgelaufen(JETZT - 3 * 3600 * 1000, JETZT), true);
  assert.equal(L.gespraechAbgelaufen(undefined, JETZT), true);
  assert.equal(L.bildName(new Date(2026, 9, 1, 9, 5, 7).getTime()), 'Bildschirm 09-05-07.jpg');
  assert.deepEqual(L.bildMasse(3840, 2160), { breite: 1600, hoehe: 900 });
  assert.deepEqual(L.bildMasse(1080, 1920), { breite: 900, hoehe: 1600 });
  assert.deepEqual(L.bildMasse(800, 600), { breite: 800, hoehe: 600 }, 'nie vergroessert');
  assert.deepEqual(L.bildMasse(0, 0), { breite: 1, hoehe: 1 });
});

/* ----------------------------------------------------- Browser und Saetze */

test('schwebenMoeglich und teilenMoeglich fragen nur, was da ist', async () => {
  const L = await laden();
  assert.equal(L.schwebenMoeglich({ documentPictureInPicture: { requestWindow() {} } }), true);
  assert.equal(L.schwebenMoeglich({ documentPictureInPicture: { requestWindow() {} }, isSecureContext: false }), false);
  assert.equal(L.schwebenMoeglich({}), false, 'Safari');
  assert.equal(L.teilenMoeglich({ navigator: { mediaDevices: { getDisplayMedia() {} } } }), true);
  assert.equal(L.teilenMoeglich({ navigator: { mediaDevices: {} } }), false, 'iPad');
  assert.equal(L.teilenMoeglich({ navigator: {} }), false);
});

test('teilenFehlerSatz: Abbrechen ist still, der Mac ohne Erlaubnis bekommt den Weg', async () => {
  const L = await laden();
  const fehler = (name, message = '') => Object.assign(new Error(message), { name });
  assert.equal(L.teilenFehlerSatz(fehler('NotAllowedError', 'Permission denied')), null);
  assert.match(L.teilenFehlerSatz(fehler('NotAllowedError', 'Permission denied by system')), /Datenschutz & Sicherheit/);
  assert.equal(L.teilenFehlerSatz(fehler('AbortError')), null);
  assert.match(L.teilenFehlerSatz(fehler('NotReadableError')), /ließ sich nicht aufnehmen/);
  assert.match(L.teilenFehlerSatz(fehler('TypeError')), /kann den Bildschirm nicht teilen/);
  assert.match(L.teilenFehlerSatz(fehler('Seltsam', 'kaputt')), /kaputt/);
  assert.match(L.schwebenFehlerSatz(fehler('NotAllowedError')), /nach einem Klick/);
  assert.equal(L.schwebenFehlerSatz(fehler('NotSupportedError')), L.SCHWEBEN_NICHT);
});

test('Kuerzel: Strg/⌘ + Umschalt + Leertaste, sonst nichts', async () => {
  const L = await laden();
  assert.equal(L.istKuerzel({ code: 'Space', key: ' ', shiftKey: true, ctrlKey: true }), true);
  assert.equal(L.istKuerzel({ code: 'Space', key: ' ', shiftKey: true, metaKey: true }), true);
  assert.equal(L.istKuerzel({ code: 'Space', key: ' ', shiftKey: false, ctrlKey: true }), false, 'Strg+Leertaste wechselt am Mac die Sprache');
  assert.equal(L.istKuerzel({ code: 'Space', key: ' ', shiftKey: true, ctrlKey: true, altKey: true }), false);
  assert.equal(L.istKuerzel({ code: 'KeyK', key: 'k', ctrlKey: true, shiftKey: true }), false);
  assert.equal(L.kuerzelText(true), '⌘ Umschalt Leertaste');
  assert.equal(L.kuerzelText(false), 'Strg Umschalt Leertaste');
});

test('Vorlagen und Anweisung: deutsch, kurz, ehrlich', async () => {
  const L = await laden();
  assert.ok(L.VORLAGEN.length >= 5);
  for (const v of L.VORLAGEN) {
    assert.ok(v.label.length <= 24, `zu lang fuer einen Knopf: ${v.label}`);
    assert.ok(/[.?!]$/.test(v.frage), v.frage);
  }
  assert.match(L.SYSTEM_ANWEISUNG, /Bildschirmfoto/);
  assert.match(L.SYSTEM_ANWEISUNG, /kurz/);
  assert.deepEqual([...L.TIMER_VORGABEN], [1, 3, 5, 10, 15, 25]);
  assert.deepEqual(L.fensterMasse(true), { width: 440, height: 620 });
});

/* ---------------------------------------------------------------- Das Wesen */

test('wesenZustand: was wirklich passiert, in fester Rangfolge -- aus schlaeft vor allem', async () => {
  const L = await laden();
  const z = (e) => L.wesenZustand({ jetzt: JETZT, ...e });
  assert.equal(z({}), 'ruht');
  assert.equal(z({ aus: true, hoert: true, frisst: true }), 'schlaeft', 'Neural OS ist aus: es schlaeft, auch wenn gerade etwas lief');
  assert.equal(z({ frisst: true, hoert: true, verwirrtBis: JETZT + 1000 }), 'frisst', 'Essen geht vor');
  assert.equal(z({ verwirrtBis: JETZT + 1000, hoert: true }), 'verwirrt');
  assert.equal(z({ verwirrtBis: JETZT - 1 }), 'ruht', 'Verwirrung vergeht');
  assert.equal(z({ hoert: true, spricht: true, denkt: true }), 'hoert', 'das Mikrofon geht vor dem Sprechen');
  assert.equal(z({ spricht: true, denkt: true }), 'spricht');
  assert.equal(z({ schreibt: true, denkt: true }), 'spricht', 'Wort fuer Wort: der Mund bewegt sich');
  assert.equal(z({ denkt: true, freutBis: JETZT + 500 }), 'denkt');
  assert.equal(z({ freutBis: JETZT + 500 }), 'freut');
  assert.equal(z({ freutBis: JETZT - 1 }), 'ruht');
  assert.equal(z({ verbunden: false }), 'schlaeft', 'ohne verbundene KI schlaeft es');
  assert.equal(z({ verbunden: false, hoert: true }), 'hoert', 'weckt man es, hoert es trotzdem zu');
  assert.equal(z({ verbunden: null }), 'ruht', 'unbekannt ist nicht "nicht verbunden"');
  for (const name of ['ruht', 'hoert', 'denkt', 'spricht', 'frisst', 'freut', 'verwirrt', 'schlaeft']) assert.ok(L.WESEN_ZUSTAENDE.includes(name), name);
});

test('wesenSatz: eine kurze Zeile je Zustand, ehrlich und deutsch', async () => {
  const L = await laden();
  assert.equal(L.wesenSatz('ruht'), 'Was kann ich für dich tun?');
  assert.equal(L.wesenSatz('hoert'), 'Ich höre zu …');
  assert.equal(L.wesenSatz('denkt'), 'Ich denke …');
  assert.equal(L.wesenSatz('denkt', { schritt: 'Sucht im Internet …' }), 'Sucht im Internet …');
  assert.equal(L.wesenSatz('spricht', { liest: true }), 'Ich spreche … – zum Unterbrechen tippen');
  assert.equal(L.wesenSatz('spricht'), 'Ich schreibe …');
  assert.equal(L.wesenSatz('frisst', { datei: 'Bericht.pdf' }), 'Mmh – ich lese „Bericht.pdf“ …');
  assert.match(L.wesenSatz('schlaeft'), /nicht verbunden/);
  assert.match(L.wesenSatz('schlaeft', { aus: true }), /Neural OS ist aus/);
  assert.equal(L.wesenSatz('verwirrt', { satz: 'Kein Netz.' }), 'Kein Netz.');
  assert.equal(L.wesenSatz('freut'), 'Fertig.');
});

/* ---------------------------------------------------------------- Live */

test('liveSchritt: ein echtes Hin und Her -- zuhoeren, verstehen, denken, antworten, vorlesen, wieder zuhoeren', async () => {
  const L = await laden();
  let p = L.liveSchritt(null, 'an');
  assert.equal(p, 'hoert');
  const folge = [['stille', 'versteht'], ['text', 'denkt'], ['erstesWort', 'schreibt'], ['antwortFertig', 'spricht'], ['vorgelesen', 'hoert']];
  for (const [ereignis, erwartet] of folge) {
    p = L.liveSchritt(p, ereignis);
    assert.equal(p, erwartet, `${ereignis} -> ${erwartet}`);
  }
  assert.equal(L.liveSchritt('spricht', 'unterbrechen'), 'hoert', 'Antippen, waehrend es spricht: es hoert wieder zu');
  assert.equal(L.liveSchritt('versteht', 'nichtVerstanden'), 'hoert', 'nichts verstanden: weiter zuhoeren');
  assert.equal(L.liveSchritt('schreibt', 'ohneVorlesen'), 'hoert', 'ohne Stimme: gleich wieder zuhoeren');
  assert.equal(L.liveSchritt('denkt', 'antwortFehler'), 'hoert');
  assert.equal(L.liveSchritt('hoert', 'text'), 'denkt', 'die Erkennung des Browsers liefert den Text direkt');
  for (const aus of ['aus', 'mikrofonFehler', 'nichtsGehoert', 'nichtVerbunden']) assert.equal(L.liveSchritt('hoert', aus), null, aus);
  assert.equal(L.liveSchritt('hoert', 'vorgelesen'), 'hoert', 'was in einer Phase nichts bedeutet, aendert nichts');
  assert.equal(L.liveSchritt(null, 'stille'), null, 'aus bleibt aus');
  for (const ph of L.LIVE_PHASEN) assert.ok(L.liveSatz(ph).length > 0, ph);
  assert.equal(L.liveSatz('hoert'), 'Ich höre zu …');
  assert.equal(L.liveSatz('denkt'), 'Ich denke …');
  assert.equal(L.liveSatz('spricht'), 'Ich spreche … – zum Unterbrechen tippen');
});

test('liveMoeglich: ohne Mikrofon oder ohne Weg zu Text ein ehrlicher Satz', async () => {
  const L = await laden();
  assert.deepEqual(L.liveMoeglich({ mikrofon: true, weg: 'aufnahme' }), { ok: true, satz: null }, 'Opera: Aufnahme, Gemini schreibt um');
  assert.deepEqual(L.liveMoeglich({ mikrofon: true, weg: 'erkennung' }), { ok: true, satz: null });
  assert.match(L.liveMoeglich({ mikrofon: true, weg: null }).satz, /Google-Schlüssel/);
  assert.match(L.liveMoeglich({ mikrofon: false, weg: 'aufnahme' }).satz, /kein Mikrofon/);
  assert.match(L.liveMoeglich({ sicher: false, weg: 'aufnahme' }).satz, /WLAN/);
});

/** Spielt eine Folge [ms, rms] in Stuecken von 50 ms ab und sammelt die Ereignisse mit Zeit. */
function abspielen(L, folge, grenzen = {}) {
  let z = L.stilleNeu(0, grenzen);
  let t = 0;
  const ereignisse = [];
  for (const [dauer, rms] of folge) {
    for (let i = 0; i < dauer; i += 50) {
      t += 50;
      const r = L.stilleSchritt(z, rms, t);
      z = r.z;
      if (r.ereignis) ereignisse.push([r.ereignis, t]);
    }
  }
  return { ereignisse, z };
}

test('stilleSchritt: nach Sprache 1,2 s still -- fertig; vorher nicht', async () => {
  const L = await laden();
  const { ereignisse, z } = abspielen(L, [[500, 0.003], [1500, 0.12], [2000, 0.004]]);
  assert.deepEqual(ereignisse.map((e) => e[0]), ['sprache', 'stille']);
  const [, stilleBei] = ereignisse[1];
  assert.ok(stilleBei >= 2000 + 1200 && stilleBei <= 2000 + 1300, `fertig nach 1,2 s Stille: ${stilleBei}`);
  assert.ok(z.spracheBeginn >= 500 && z.spracheBeginn <= 600, `Sprache begann bei ${z.spracheBeginn}`);
  assert.equal(L.stilleSchritt(z, 0.2, 99999).ereignis, null, 'danach kommt nichts mehr');
});

test('stilleSchritt: eine Atempause ist kein Ende, ein Klick ist keine Sprache', async () => {
  const L = await laden();
  const pause = abspielen(L, [[500, 0.003], [1000, 0.1], [700, 0.004], [1000, 0.1], [1400, 0.004]]);
  assert.deepEqual(pause.ereignisse.map((e) => e[0]), ['sprache', 'stille'], 'nur EIN Ende -- nach der langen Pause');
  assert.ok(pause.ereignisse[1][1] > 500 + 1000 + 700 + 1000, 'die kurze Pause beendet nichts');
  const klick = abspielen(L, [[500, 0.003], [100, 0.3], [3000, 0.003]]);
  assert.deepEqual(klick.ereignisse, [], 'ein kurzes Klacken (100 ms) ist keine Sprache');
});

test('stilleSchritt: eine Minute nichts -- "nichts"; eine Minute Rede -- "grenze"', async () => {
  const L = await laden();
  const nichts = abspielen(L, [[61000, 0.003]]);
  assert.deepEqual(nichts.ereignisse.map((e) => e[0]), ['nichts']);
  assert.equal(nichts.ereignisse[0][1], 60000);
  const rede = abspielen(L, [[300, 0.003], [61000, 0.1]]);
  assert.deepEqual(rede.ereignisse.map((e) => e[0]), ['sprache', 'grenze']);
  assert.equal(L.STILLE.STILLE_MS, 1200);
  assert.equal(L.STILLE.MAX_MS, 60000);
});

test('stilleSchritt: in einem lauten Raum steigen die Schwellen -- das Rauschen ist keine Sprache', async () => {
  const L = await laden();
  // Rauschen 0,015: mit festen Schwellen (0,02) waere jedes Aufbrausen "Sprache".
  const laut = abspielen(L, [[500, 0.015], [1000, 0.03], [2000, 0.015]]);
  assert.deepEqual(laut.ereignisse, [], `0,03 in einem Raum mit 0,015 Rauschen ist keine Sprache: ${JSON.stringify(laut.ereignisse)}`);
  const s = L.stilleSchwellen(0.015);
  assert.ok(s.sprache > 0.04 && s.stille > 0.025, JSON.stringify(s));
  const deutlich = abspielen(L, [[500, 0.015], [1000, 0.15], [2000, 0.016]]);
  assert.deepEqual(deutlich.ereignisse.map((e) => e[0]), ['sprache', 'stille']);
  assert.deepEqual(L.stilleSchwellen(0.5), L.stilleSchwellen(L.STILLE.BODEN_MAX), 'wer sofort laut redet, verschiebt die Schwellen nicht ins Unendliche');
});

test('rmsVon und pegelAusRms: Lautstaerke messen, als Ring zeigen', async () => {
  const L = await laden();
  assert.equal(L.rmsVon(new Float32Array(0)), 0);
  assert.ok(Math.abs(L.rmsVon(Float32Array.from([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
  assert.equal(L.pegelAusRms(0), 0);
  assert.equal(L.pegelAusRms(0.002), 0, 'Rauschen zeigt keinen Ring');
  assert.ok(L.pegelAusRms(0.02) > 0.1 && L.pegelAusRms(0.02) < L.pegelAusRms(0.2));
  assert.equal(L.pegelAusRms(1), 1);
});

/* ---------------------------------------------------------------- Dateien */

test('dateiPruefen: Bilder, PDF und Textdateien isst es -- alles andere ehrlich nicht', async () => {
  const L = await laden();
  const p = (name, type, size = 1000) => L.dateiPruefen({ name, type, size });
  assert.deepEqual(p('foto.png', 'image/png'), { art: 'bild', mime: 'image/png', satz: null });
  assert.equal(p('foto.JPG', '').art, 'bild', 'ohne Typ: die Endung zaehlt');
  assert.equal(p('foto.jpg', 'image/jpg').mime, 'image/jpeg');
  assert.equal(p('Rechnung.pdf', 'application/pdf').art, 'pdf');
  assert.equal(p('Rechnung.pdf', '').art, 'pdf', 'manche Systeme liefern bei PDF keinen Typ');
  for (const name of ['notizen.txt', 'liste.md', 'tabelle.csv', 'daten.json']) assert.equal(p(name, '').art, 'text', name);
  assert.equal(p('x', 'text/plain').art, 'text');
  assert.equal(p('daten.json', 'application/json').art, 'text');
  const zip = p('Archiv.zip', 'application/zip');
  assert.equal(zip.art, null);
  assert.equal(zip.grund, 'art');
  assert.match(zip.satz, /^„Archiv\.zip“ kann ich nicht lesen\. Ich nehme Bilder/);
  assert.equal(p('film.mp4', 'video/mp4').art, null);
  const gross = p('buch.txt', 'text/plain', 250 * 1024);
  assert.equal(gross.grund, 'gross');
  assert.match(gross.satz, /250 KB/);
  assert.equal(p('genau.txt', 'text/plain', 200 * 1024).art, 'text', '200 KB gehen noch');
  assert.equal(p('leer.txt', 'text/plain', 0).grund, 'leer');
  assert.equal(p('riesig.pdf', 'application/pdf', 21 * 1024 * 1024).grund, 'gross');
  assert.equal(p('handyfoto.jpg', 'image/jpeg', 9 * 1024 * 1024).art, 'bild', 'grosse Fotos werden verkleinert, nicht abgelehnt');
});

test('dateienAuftrag, dateiKuerzel: was mitgeht, was auf der Datei steht', async () => {
  const L = await laden();
  assert.equal(L.dateienAuftrag(1), 'Werte diese Datei aus.');
  assert.equal(L.dateienAuftrag(3), 'Werte diese Dateien aus.');
  assert.equal(L.dateiKuerzel('a.pdf', 'pdf'), 'PDF');
  assert.equal(L.dateiKuerzel('a.png', 'bild'), 'BILD');
  assert.equal(L.dateiKuerzel('liste.csv', 'text'), 'CSV');
  assert.equal(L.dateiKuerzel('ohne', 'text'), 'TEXT');
});

test('textePlanen: eine Textdatei darf mehr mitbringen -- zusammen bleibt alles unter der Grenze, und es sagt, was fehlt', async () => {
  const L = await laden();
  const datei = { name: 'buch.txt', text: 'x'.repeat(50000), max: L.MAX_DATEI_ZEICHEN };
  const eins = L.textePlanen('Werte diese Datei aus.', [datei]);
  assert.ok(eins.inhalt.includes('x'.repeat(50000)), 'eine Datei geht ganz mit (nicht nur 12.000 Zeichen)');
  assert.deepEqual(eins.gekuerzt, []);
  const lang = L.textePlanen('F', [{ name: 'lang.txt', text: 'y'.repeat(L.MAX_DATEI_ZEICHEN + 10), max: L.MAX_DATEI_ZEICHEN }]);
  assert.deepEqual(lang.gekuerzt, ['lang.txt']);
  assert.ok(lang.inhalt.includes('[… gekürzt]'));
  const zwei = L.textePlanen('F', [
    { name: 'a.txt', text: 'a'.repeat(140000), max: L.MAX_DATEI_ZEICHEN },
    { name: 'b.txt', text: 'b'.repeat(140000), max: L.MAX_DATEI_ZEICHEN },
  ]);
  assert.ok(zwei.inhalt.length <= L.MAX_NACHRICHT_ZEICHEN, `zusammen unter der Grenze: ${zwei.inhalt.length}`);
  assert.deepEqual(zwei.gekuerzt, ['b.txt'], 'die zweite wird gekuerzt, damit beide hineinpassen');
  const drei = L.textePlanen('F', [
    { name: 'a.txt', text: 'a'.repeat(150000), max: L.MAX_DATEI_ZEICHEN },
    { name: 'b.txt', text: 'b'.repeat(40000), max: L.MAX_DATEI_ZEICHEN },
    { name: 'c.txt', text: 'c'.repeat(9000), max: L.MAX_DATEI_ZEICHEN },
  ]);
  assert.deepEqual(drei.weggelassen, ['c.txt'], 'was keinen Platz mehr hat, faellt weg -- und das wird gesagt');
  assert.equal(L.frageMitTexten('Nur so', []), 'Nur so', 'frageMitTexten bleibt, wie es war');
});

/* ---------------------------------------------------------------- Lage */

test('randSpur: ab 1000 px mit zugeklappter Spalte bekommt das Wesen eine eigene Spur', async () => {
  const L = await laden();
  assert.equal(L.randSpur({ breite: 1024, rechtsOffen: false }), true);
  assert.equal(L.randSpur({ breite: 1180, rechtsOffen: false }), true, 'iPad quer');
  assert.equal(L.randSpur({ breite: 1440, rechtsOffen: true }), false, 'offene Spalte: es sitzt ueber ihr');
  assert.equal(L.randSpur({ breite: 820, rechtsOffen: false }), false, 'iPad hoch: es schwebt unten rechts');
  assert.equal(L.randSpur({ breite: 390, rechtsOffen: false }), false);
});

test('dockLage: im unteren Drittel der Mitte, nie auf einem Knopf -- und es bleibt, wo es frei sitzt', async () => {
  const L = await laden();
  const frei = L.dockLage({ hoehe: 900 });
  assert.deepEqual(frei, { y: 510, frei: true }, '60 % der Hoehe, mittig');
  // Ein Knopf genau dort: es rueckt an die naechste freie Stelle.
  const knopf = L.dockLage({ hoehe: 900, hindernisse: [{ top: 500, bottom: 540 }] });
  assert.ok(knopf.frei && (knopf.y >= 548 || knopf.y + 60 <= 492), JSON.stringify(knopf));
  assert.ok(Math.abs(knopf.y - 510) <= 52, 'so nah wie moeglich an der Wunschstelle');
  // Bleibt, solange es frei sitzt -- nah an der Wunschstelle, oder weil die Wunschstelle belegt ist.
  assert.deepEqual(L.dockLage({ hoehe: 900, aktuell: 420 }), { y: 420, frei: true }, 'kleine Wege macht es nicht');
  assert.deepEqual(L.dockLage({ hoehe: 900, aktuell: 300, hindernisse: [{ top: 480, bottom: 600 }] }), { y: 300, frei: true });
  assert.notEqual(L.dockLage({ hoehe: 900, aktuell: 420, hindernisse: [{ top: 440, bottom: 460 }] }).y, 420, 'ein neuer Knopf darunter: es rueckt weg');
  // Weit weg (ein Dialog hatte es verdraengt) und die Wunschstelle ist wieder frei: es geht heim.
  assert.deepEqual(L.dockLage({ hoehe: 900, aktuell: 130 }), { y: 510, frei: true }, 'Heimweh');
  // Telefon: unten rechts, ueber dem Eingabefeld.
  const tel = L.dockLage({ hoehe: 844, telefon: true, groesse: 56, unten: 12, hindernisse: [{ top: 759, bottom: 803 }] });
  assert.ok(tel.frei && tel.y + 56 <= 759 - 8 && tel.y > 600, JSON.stringify(tel));
  // Alles belegt: es sitzt an der Wunschstelle und sagt, dass es nicht frei ist.
  assert.deepEqual(L.dockLage({ hoehe: 900, hindernisse: [{ top: 0, bottom: 900 }] }), { y: 510, frei: false });
  // Krumme Bildschirmpunkte (wie getBoundingClientRect sie liefert): die freie Stelle unter einem Knopf
  // ist trotzdem frei -- gemessen im Kalender am iPad hoch, wo das Wesen sonst auf dem Sonntag sass.
  const krumm = L.dockLage({
    hoehe: 1180,
    oben: 73.5,
    hindernisse: [{ top: 230.4, bottom: 821.6 }, { top: 887.2, bottom: 952.8 }, { top: 962.1, bottom: 1014.375 }],
  });
  assert.ok(krumm.frei && krumm.y >= 1014.375 + 8, JSON.stringify(krumm));
  // Zwischen zwei Knoepfen ist zu wenig Platz: nicht dazwischenquetschen.
  const eng = L.dockLage({ hoehe: 900, hindernisse: [{ top: 440, bottom: 500 }, { top: 540, bottom: 600 }] });
  assert.ok(eng.y >= 608 || eng.y + 60 <= 432, JSON.stringify(eng));
});

test('panelLage: am Rechner und iPad ein Feld am Rand, nie der ganze Bildschirm; am Telefon ein Blatt', async () => {
  const L = await laden();
  for (const [b, hh] of [[1440, 900], [1280, 800], [1024, 768], [1180, 820], [820, 1180]]) {
    const p = L.panelLage({ breite: b, hoehe: hh });
    assert.equal(p.art, 'feld', `${b}x${hh}`);
    assert.ok(p.breite <= 420 && p.breite >= 380, `${b}x${hh}: ${p.breite} px breit`);
    assert.ok(p.hoehe <= hh * 0.8 + 1 && p.hoehe <= 760, `${b}x${hh}: ${p.hoehe} px hoch`);
    assert.ok(p.breite < b * 0.5, 'nimmt nicht den ganzen Bildschirm');
  }
  const tel = L.panelLage({ breite: 390, hoehe: 844 });
  assert.equal(tel.art, 'blatt');
  assert.equal(tel.hoehe, Math.round(844 * 0.85));
});

/* ---------------------------------------------------------------- Suchen */

test('schrittSatz: "Sucht im Internet: …" waehrend, "Gesucht: … · 5 Treffer" danach', async () => {
  const L = await laden();
  assert.deepEqual(L.schrittSatz({ rolle: 'recherche', titel: 'Sucht: Wetter Berlin', zustand: 'laeuft' }),
    { text: 'Sucht im Internet: „Wetter Berlin“', laeuft: true, fehler: false, art: 'suche' });
  assert.equal(L.schrittSatz({ rolle: 'recherche', titel: 'Sucht: Wetter Berlin', zustand: 'fertig', ergebnis: '5 Treffer' }).text, 'Gesucht: „Wetter Berlin“ · 5 Treffer');
  assert.equal(L.schrittSatz({ rolle: 'recherche', titel: 'Liest: https://x.de/a', zustand: 'laeuft' }).text, 'Liest: https://x.de/a');
  assert.equal(L.schrittSatz({ rolle: 'recherche', titel: 'Liest: https://x.de/a', zustand: 'fertig', ergebnis: 'Gelesen: Seite A' }).text, 'Gelesen: Seite A');
  const f = L.schrittSatz({ rolle: 'recherche', titel: 'Sucht: x', zustand: 'fehler', ergebnis: 'Zu viele Anfragen' });
  assert.equal(f.fehler, true);
  assert.match(f.text, /Zu viele Anfragen/);
  assert.equal(L.schrittSatz({ rolle: 'wissen', titel: 'Sucht in deinem Wissen: „Oma“', zustand: 'laeuft' }).art, 'wissen');
  assert.equal(L.schrittSatz({ rolle: 'termin', titel: 'Zahnarzt', zustand: 'fertig', wirkung: [{ id: 'event_1' }] }), null, 'was etwas anlegt, steht als Karte da');
  assert.equal(L.schrittSatz(null), null);
  assert.equal(L.quelleHost('https://www.wetter.de/berlin?x=1'), 'wetter.de');
  assert.equal(L.quelleHost('#/notes?id=note_1'), '');
});

test('schrittSatz: jedes andere Werkzeug der Recherche steht mit seinem Titel da -- Wikipedia nachschlagen zum Beispiel', async () => {
  const L = await laden();
  const wiki = { rolle: 'recherche', titel: 'Wikipedia: „Brandenburger Tor“', schritt: 'Schlägt nach', werkzeug: 'wikipedia_suchen' };
  assert.deepEqual(L.schrittSatz({ ...wiki, zustand: 'laeuft' }), { text: 'Wikipedia: „Brandenburger Tor“', laeuft: true, fehler: false, art: 'nachschlagen' });
  assert.equal(L.schrittSatz({ ...wiki, zustand: 'fertig', ergebnis: '2 Artikel gefunden' }).text, 'Wikipedia: „Brandenburger Tor“ · 2 Artikel gefunden');
  const kaputt = L.schrittSatz({ ...wiki, zustand: 'fehler' });
  assert.equal(kaputt.fehler, true);
  assert.equal(kaputt.text, 'Wikipedia: „Brandenburger Tor“ · ging nicht', 'ein Fehler ohne Grund sagt trotzdem, dass es nicht ging');
  // Ein Werkzeug, das die Insel noch nie gesehen hat: sein Titel, sein Ergebnis -- ohne Sonderfall.
  assert.equal(L.schrittSatz({ rolle: 'recherche', titel: 'Fahrplan: Berlin – Hamburg', zustand: 'fertig', ergebnis: '3 Verbindungen' }).text, 'Fahrplan: Berlin – Hamburg · 3 Verbindungen');
  assert.equal(L.schrittSatz({ rolle: 'recherche', titel: 'Recherche', zustand: 'fertig' }).text, 'Im Internet gesucht', 'der Notname der Recherche bleibt die allgemeine Zeile');
  assert.equal(L.quelleHost('https://de.wikipedia.org/wiki/Brandenburger_Tor'), 'de.wikipedia.org');
});

test('chipFuer: kurze Schilder neben dem Wesen -- Mikrofon und Bildschirm mit rotem Punkt', async () => {
  const L = await laden();
  assert.deepEqual(L.chipFuer({ art: 'timer', titel: 'Tee', endeMs: JETZT + 65000 }, JETZT), { text: '1:05 Tee', ton: 'leise', symbol: 'timer' });
  assert.equal(L.chipFuer({ art: 'timer', titel: 'Timer', endeMs: JETZT + 5000 }, JETZT).text, '0:05');
  assert.equal(L.chipFuer({ art: 'termin', titel: 'Zahnarzt', startMs: JETZT + 12 * MIN }, JETZT).text, 'In 12 Min · Zahnarzt');
  assert.equal(L.chipFuer({ art: 'hoeren' }, JETZT).ton, 'aufnahme');
  assert.equal(L.chipFuer({ art: 'teilen' }, JETZT).ton, 'aufnahme');
  assert.equal(L.chipFuer({ art: 'freigabe', anzahl: 2 }, JETZT).text, '2 Freigaben');
  assert.equal(L.chipFuer({ art: 'antwort', phase: 'schreibt' }, JETZT).text, 'Schreibt …');
  assert.equal(L.chipFuer({ art: 'unbekannt' }, JETZT), null);
});

test('naechsterTermin: was als Kapsel haengt oder weggeklickt ist, ueberspringt er -- der naechste kommt dran', async () => {
  const L = await laden();
  const ev = (id, start) => ({ id, data: { title: id, start, end: '2026-10-01T16:00' } });
  const items = [ev('event_kapsel', '2026-10-01T14:10'), ev('event_danach', '2026-10-01T14:20')];
  assert.equal(L.naechsterTermin(items, JETZT).id, 'event_kapsel');
  assert.equal(L.naechsterTermin(items, JETZT, new Set(['event_kapsel'])).id, 'event_danach');
  assert.equal(L.naechsterTermin(items, JETZT, new Set(['event_kapsel', 'event_danach'])), null);
});
