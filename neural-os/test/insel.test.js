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

test('naechsterTermin: was als Kapsel haengt oder weggeklickt ist, ueberspringt er -- der naechste kommt dran', async () => {
  const L = await laden();
  const ev = (id, start) => ({ id, data: { title: id, start, end: '2026-10-01T16:00' } });
  const items = [ev('event_kapsel', '2026-10-01T14:10'), ev('event_danach', '2026-10-01T14:20')];
  assert.equal(L.naechsterTermin(items, JETZT).id, 'event_kapsel');
  assert.equal(L.naechsterTermin(items, JETZT, new Set(['event_kapsel'])).id, 'event_danach');
  assert.equal(L.naechsterTermin(items, JETZT, new Set(['event_kapsel', 'event_danach'])), null);
});
