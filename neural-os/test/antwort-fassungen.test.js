'use strict';

/**
 * Interaktive Antworten, Server-Seite (docs/ANTWORT-BAUSTEINE.md 3-5):
 * Systemtext "Darstellung", Antwortstil, Fassungen (neu erstellen,
 * umwandeln, wählen, Block bearbeiten), Zustand der Bausteine und die
 * KI-Zusammenfassung fürs Gehirn.
 *
 * Gegen die ECHTE Anwendung und die Statisten (test/claude-statist.js,
 * test/gemini-statist.js). Kein Test verlässt 127.0.0.1.
 */

const assert = require('node:assert/strict');
const { test } = require('./harness');
const { B, antwort } = require('./claude-statist');
const G = require('./gemini-statist');
const {
  anfrage, strom, arten, textVon, mitKi, nachrichten,
} = require('./antwort-hilfe');
const { SYSTEM_FEST, SYSTEM_UMWANDELN, DARSTELLUNG } = require('../src/models/chat');
const fassungen = require('../src/models/fassungen');

const TYPEN = ['auswahl', 'aktionen', 'formular', 'regler', 'karten', 'diagramm', 'checkliste', 'schritte',
  'abschnitte', 'mehr', 'tabs', 'liste', 'quiz', 'lernkarten', 'lueckentext', 'zuordnung', 'timer',
  'countdown', 'termin', 'datei', 'vorschau', 'fortschritt'];

const antwortSatz = (items) => items.filter((m) => m.data.role === 'assistant').pop();
const letzteStromAnfrage = (statist) => statist.stromAnfragen()[statist.stromAnfragen().length - 1].body;

/* ------------------------------------------------------------ Systemtext */

test('Systemtext: Absatz „Darstellung“ mit einer Zeile je Baustein (22), fest, ohne Datum und ohne Widerspruch', () => {
  assert.match(SYSTEM_FEST, /^Darstellung:$/m);
  assert.equal(TYPEN.length, 22);
  for (const t of TYPEN) assert.match(SYSTEM_FEST, new RegExp(`^  ${t}: `, 'm'), `Zeile für ${t}`);
  assert.match(SYSTEM_FEST, /einfachste Form, die der Aufgabe dient/);
  assert.match(SYSTEM_FEST, /höchstens zwei pro Antwort, dazu höchstens ein aktionen am Ende/);
  assert.match(SYSTEM_FEST, /Codeblock ```ui mit genau einem JSON-Objekt/);
  assert.match(SYSTEM_FEST, /doppelte Anführungszeichen, keine Kommentare, kein abschließendes Komma/);
  assert.match(SYSTEM_FEST, /kein CDN, keine externen Dateien, alles inline/);
  // Rückfrage (Werkzeug) und auswahl (Baustein) haben klare, getrennte Aufgaben.
  assert.match(SYSTEM_FEST, /nimm das Werkzeug rueckfrage, nicht auswahl/);
  assert.match(SYSTEM_FEST, /rueckfrage mit 2–5 kurzen Optionen/);
  // Texte zum Kopieren bleiben ```prompt/```text; eine Datei ist ein Baustein.
  assert.match(SYSTEM_FEST, /ohne Einleitung im Block/);
  assert.match(SYSTEM_FEST, /```prompt bzw\. ```text; eine Datei zum Herunterladen, mit Dateinamen, ist ein Baustein datei/);
  assert.ok(!/20\d\d/.test(SYSTEM_FEST), 'kein Datum im festen Teil');
  assert.ok(SYSTEM_UMWANDELN.includes(DARSTELLUNG), 'Umwandeln kennt dieselben Bausteine');
});

test('Systemtext: der feste Teil geht byte-gleich in jede Anfrage, mit „Darstellung“', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    claude.weiter(antwort(B.start(), B.text(0, 'Eins.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hallo' });
    claude.weiter(antwort(B.start(), B.text(0, 'Zwei.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Und?' });
    const [a, b] = claude.stromAnfragen().map((x) => x.body.system[0]);
    assert.equal(a.text, SYSTEM_FEST);
    assert.deepEqual(a, b);
    assert.equal(a.cache_control, undefined);
  });
});

/* ------------------------------------------------------------ Antwortstil */

test('Antwortstil: PATCH am Chat, danach steht er in der Nutzernachricht jedes Zuges (nicht im Systemtext); null setzt zurück', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    const falsch = await anfrage(base, 'PATCH', `/api/chats/${chatId}`, { stil: { laenge: 130 } });
    assert.equal(falsch.status, 400);
    assert.match(falsch.json.error.message, /0 bis 100/);

    const p = await anfrage(base, 'PATCH', `/api/chats/${chatId}`, { stil: { laenge: 30, fachlich: 70, kreativ: 50 } });
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.record.data.stil, { laenge: 30, fachlich: 70, kreativ: 50 });

    claude.weiter(antwort(B.start(), B.text(0, 'Kurz.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Erklär Photosynthese' });
    const body = letzteStromAnfrage(claude);
    const nutzer = body.messages[0].content;
    assert.equal(nutzer[1].text, '[Antwortstil: Länge 30/100 (eher kurz), Fachbegriffe 70/100 (eher fachlich), Kreativität 50/100 (ausgewogen)]');
    assert.equal(nutzer[2].text, 'Erklär Photosynthese');
    assert.ok(!body.system.some((s) => s.text.includes('Länge 30/100')), 'nicht im Systemtext (Cache)');

    await anfrage(base, 'PATCH', `/api/chats/${chatId}`, { stil: null });
    claude.weiter(antwort(B.start(), B.text(0, 'Ok.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Danke' });
    const zweite = letzteStromAnfrage(claude).messages;
    // Die erste Frage bleibt byte-gleich (mit ihrem Stil), die neue hat keinen.
    assert.equal(zweite[0].content[1].text, nutzer[1].text);
    assert.deepEqual(zweite[2].content.map((b) => b.text.startsWith('[Antwortstil')), [false, false]);
  });
});

/* -------------------------------------------------------------- Fassungen */

test('Neu erstellen legt eine neue Fassung derselben Antwort an; die alte bleibt und Claude bekommt dieselbe Frage', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    claude.weiter(antwort(B.start(), B.denken(0, 'Kurz überlegen.'), B.text(1, 'Erste Fassung.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Schreib mir einen Satz' });
    const alt = antwortSatz(await nachrichten(base, chatId));
    // Auch eine Antwort von vor den Fassungen zeigt sich als genau eine.
    assert.deepEqual(alt.data.versionen.map((v) => [v.art, v.inhalt]), [['original', 'Erste Fassung.']]);
    assert.equal(alt.data.version, 0);
    assert.equal(alt.data.claude, undefined, 'der Rohverlauf verlässt den Tresor nicht');

    claude.weiter(antwort(B.start(), B.text(0, 'Zweite Fassung.'), B.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/neu-antworten`, {});
    assert.equal(r.status, 200);
    const n = arten(r.ereignisse);
    assert.deepEqual(n.slice(0, 2), ['fassung', 'antwort']);
    assert.equal(n[n.length - 1], 'fertig');
    assert.ok(!n.includes('verworfen'), 'nichts wird verworfen');
    assert.deepEqual(r.ereignisse[0].data, { type: 'fassung', messageId: alt.id, version: 1, anzahl: 2, art: 'neu' });
    assert.equal(r.ereignisse[1].data.record.id, alt.id, 'derselbe Satz');
    assert.equal(r.ereignisse[1].data.record.data.content, '', 'die neue Fassung beginnt leer');
    assert.equal(textVon(r.ereignisse), 'Zweite Fassung.');

    const danach = await nachrichten(base, chatId);
    assert.deepEqual(danach.map((m) => m.data.role), ['user', 'assistant']);
    const satz = danach[1];
    assert.equal(satz.id, alt.id);
    assert.equal(satz.data.content, 'Zweite Fassung.');
    assert.equal(satz.data.version, 1);
    assert.deepEqual(satz.data.versionen.map((v) => [v.art, v.inhalt]), [['original', 'Erste Fassung.'], ['neu', 'Zweite Fassung.']]);
    assert.equal(satz.data.denken, '', 'Gedankengang gehört zur Fassung');
    // Im Tresor: das Original mit seinem Rohverlauf als Abbild.
    const roh = app.store.get(alt.id).data;
    assert.equal(roh.versionen[0]._claude.verlauf[0].content[0].signature, 'sig_statist');
    // Claude bekam genau die Frage von damals, ohne die alte Antwort.
    const zweite = claude.stromAnfragen()[1].body;
    assert.equal(zweite.messages.length, 1);
    assert.equal(zweite.messages[0].content[1].text, 'Schreib mir einen Satz');
    assert.equal(zweite.messages[0].content[0].text, claude.stromAnfragen()[0].body.messages[0].content[0].text, 'derselbe Datumssatz');
  });
});

test('Neu erstellen mit Variante: ein Satz plus die bisherige Antwort nur für diesen Aufruf; unbekannte Variante vor dem Strom', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    claude.weiter(antwort(B.start(), B.text(0, 'Eine lange Antwort über Bäume.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Was sind Bäume?' });
    const falsch = await strom(base, `/api/chats/${chatId}/neu-antworten`, { variante: 'lauter' });
    assert.equal(falsch.status, 400);
    assert.match(falsch.json.error.message, /kuerzer, einfacher, detaillierter, kreativer, anders, stil/);

    claude.weiter(antwort(B.start(), B.text(0, 'Holzpflanzen.'), B.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/neu-antworten`, { variante: 'kuerzer' });
    assert.equal(r.status, 200);
    const body = letzteStromAnfrage(claude);
    const bloecke = body.messages[0].content;
    assert.equal(bloecke[1].text, 'Was sind Bäume?');
    assert.match(bloecke[2].text, /^\[Neu erstellen: Antworte diesmal deutlich kürzer/);
    assert.match(bloecke[2].text, /Eine lange Antwort über Bäume\./);
    // Gespeichert wird die Frage unverändert (der Satz gilt nur für diesen Aufruf).
    const frage = app.store.all('message').find((m) => m.data.role === 'user');
    assert.equal(frage.data.claude.inhalt.length, 2);
    const satz = antwortSatz(await nachrichten(base, chatId));
    assert.equal(satz.data.versionen[1].anweisung, 'kuerzer');

    // Variante "stil" mit neuem Stil: der Chat bekommt ihn, die Frage trägt ihn jetzt.
    claude.weiter(antwort(B.start(), B.text(0, 'Sehr ausführlich …'), B.ende('end_turn')));
    const s = await strom(base, `/api/chats/${chatId}/neu-antworten`, { variante: 'stil', stil: { laenge: 90, fachlich: 50, kreativ: 50 } });
    assert.equal(s.status, 200);
    assert.deepEqual(app.store.get(chatId).data.stil, { laenge: 90, fachlich: 50, kreativ: 50 });
    const b3 = letzteStromAnfrage(claude).messages[0].content;
    assert.match(b3[1].text, /^\[Antwortstil: Länge 90\/100 \(sehr ausführlich\)/);
    assert.equal(b3.length, 3, 'bei "stil" kein zusätzlicher Satz');
    assert.equal((await nachrichten(base, chatId))[1].data.versionen.length, 3);
  });
});

test('Neu erstellen geht nur bei der letzten Antwort (409 vor dem Strom)', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    claude.weiter(antwort(B.start(), B.text(0, 'A1'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'F1' });
    claude.weiter(antwort(B.start(), B.text(0, 'A2'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'F2' });
    const items = await nachrichten(base, chatId);
    const r = await strom(base, `/api/chats/${chatId}/neu-antworten`, { messageId: items[1].id });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'NUR_LETZTE_ANTWORT');
    assert.equal(claude.offen(), 0);
  });
});

test('Fassung wählen: content folgt, der Verlauf für die KI nimmt nur bei Fassung 0 die rohen Blöcke', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    claude.weiter(antwort(B.start(), B.denken(0, 'Hm.', 'sig_eins'), B.text(1, 'Original.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Frage' });
    claude.weiter(antwort(B.start(), B.text(0, 'Neu.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/neu-antworten`, {});
    const satz = antwortSatz(await nachrichten(base, chatId));

    // Aktiv ist Fassung 1: in den Verlauf geht nur ihr Text.
    claude.weiter(antwort(B.start(), B.text(0, 'Weiter.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Und dann?' });
    let msgs = letzteStromAnfrage(claude).messages;
    assert.deepEqual(msgs[1], { role: 'assistant', content: [{ type: 'text', text: 'Neu.' }] });

    // Zurück auf das Original: seine Blöcke gehen wieder unverändert mit (Denk-Signatur).
    const w = await anfrage(base, 'PATCH', `/api/chats/${chatId}/messages/${satz.id}/version`, { version: 0 });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json.record.data.content, 'Original.');
    assert.equal(w.json.record.data.version, 0);
    assert.deepEqual(w.json.record.data.versionen.map((v) => v.inhalt), ['Original.', 'Neu.']);
    assert.equal(w.json.record.data.claude, undefined);
    claude.weiter(antwort(B.start(), B.text(0, 'Gut.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Noch was' });
    msgs = letzteStromAnfrage(claude).messages;
    assert.equal(msgs[1].content[0].type, 'thinking');
    assert.equal(msgs[1].content[0].signature, 'sig_eins');
    assert.equal(msgs[1].content[1].text, 'Original.');

    const weg = await anfrage(base, 'PATCH', `/api/chats/${chatId}/messages/${satz.id}/version`, { version: 5 });
    assert.equal(weg.status, 404);
    const kaputt = await anfrage(base, 'PATCH', `/api/chats/${chatId}/messages/${satz.id}/version`, { version: '1' });
    assert.equal(kaputt.status, 400);
  });
});

test('Umwandeln (ganz): ohne Werkzeuge und Websuche, Strom mit fassung/antwort/text/fertig, Ergebnis ist eine neue Fassung', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    claude.weiter(antwort(B.start(), B.werkzeug(0, 'toolu_t', 'termin_anlegen', { titel: 'Zahnarzt', start: '2026-09-29T10:00', ganztaegig: false }), B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Eingetragen: Di., 29.09., 10:00 Uhr. Äpfel 3 €, Birnen 4 €.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Zahnarzt Dienstag 10 Uhr; und was kostet Obst?' });
    const satz = antwortSatz(await nachrichten(base, chatId));

    claude.weiter(antwort(B.start(), B.text(0, '| Obst | Preis |\n|---|---|\n| Äpfel | 3 € |\n| Birnen | 4 € |'), B.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/messages/${satz.id}/umwandeln`, { anweisung: 'tabelle' });
    assert.equal(r.status, 200);
    const n = arten(r.ereignisse);
    assert.deepEqual(n.slice(0, 2), ['fassung', 'antwort']);
    assert.ok(n.includes('text'));
    assert.equal(n[n.length - 1], 'fertig');
    assert.equal(r.ereignisse[0].data.art, 'umgewandelt');

    const body = letzteStromAnfrage(claude);
    assert.equal(body.tools, undefined, 'keine Werkzeuge, keine Websuche');
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.system[0].text, SYSTEM_UMWANDELN);
    assert.equal(body.messages.length, 1);
    const inhalt = body.messages[0].content.map((b) => b.text).join('\n');
    assert.match(inhalt, /Zahnarzt Dienstag 10 Uhr/);
    assert.match(inhalt, /Äpfel 3 €, Birnen 4 €/);
    assert.match(inhalt, /Markdown-Tabelle/);

    const neu = antwortSatz(await nachrichten(base, chatId));
    assert.match(neu.data.content, /^\| Obst \| Preis \|/);
    assert.equal(neu.data.status, 'complete');
    assert.deepEqual(neu.data.versionen.map((v) => [v.art, v.anweisung || null]), [['original', null], ['umgewandelt', 'tabelle']]);
    // Der eingetragene Termin bleibt als Karte (mit Rückgängig) sichtbar, am Ende.
    const karte = neu.data.agenten.find((a) => a.werkzeug === 'termin_anlegen');
    assert.ok(karte && karte.wirkung.length === 1);
    assert.equal(karte.beiZeichen, neu.data.content.length);
    assert.equal(app.store.all('event').length, 1, 'kein zweiter Termin');

    const unbekannt = await strom(base, `/api/chats/${chatId}/messages/${satz.id}/umwandeln`, { anweisung: 'uebersetzen' });
    assert.equal(unbekannt.status, 400);
    assert.match(unbekannt.json.error.message, /welche Sprache/);
  });
});

test('Umwandeln einer markierten Stelle: nur sie wird ersetzt (Markdown großzügig); nicht gefunden oder mehrdeutig → 409 vor dem Strom', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    const text = '## Plan\n\n- **Montag** ist *Ruhetag*, dann geht es los.\n- Dienstag: laufen.\n\nZum Schluss: laufen.';
    claude.weiter(antwort(B.start(), B.text(0, text), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Trainingsplan' });
    const satz = antwortSatz(await nachrichten(base, chatId));
    const pfad = `/api/chats/${chatId}/messages/${satz.id}/umwandeln`;

    // So liefert der Browser die Markierung: ohne ** und *, Zeilen zusammengefasst.
    claude.weiter(antwort(B.start(), B.text(0, '**Montag** ist frei'), B.ende('end_turn')));
    const r = await strom(base, pfad, { anweisung: 'kuerzen', auswahl: 'Montag ist Ruhetag, dann geht es los.' });
    assert.equal(r.status, 200);
    assert.ok(arten(r.ereignisse).includes('inhalt'));
    assert.ok(!arten(r.ereignisse).includes('text'), 'bei einer Stelle kommt der ganze Text, keine Stücke');
    const body = letzteStromAnfrage(claude).messages[0].content.map((b) => b.text).join('\n');
    assert.match(body, /Die markierte Stelle \(Markdown\):\n<<<\n\*\*Montag\*\* ist \*Ruhetag\*, dann geht es los\.\n>>>/);
    const neu = antwortSatz(await nachrichten(base, chatId));
    assert.equal(neu.data.content, '## Plan\n\n- **Montag** ist frei\n- Dienstag: laufen.\n\nZum Schluss: laufen.');
    assert.equal(neu.data.versionen[1].auswahl, true);

    const weg = await strom(base, pfad, { anweisung: 'kuerzen', auswahl: 'Samstag ist Markttag' });
    assert.equal(weg.status, 409);
    assert.equal(weg.json.error.code, 'AUSWAHL_NICHT_GEFUNDEN');
    const doppelt = await strom(base, pfad, { anweisung: 'verbessern', auswahl: 'laufen.' });
    assert.equal(doppelt.status, 409);
    assert.match(doppelt.json.error.message, /2-mal/);
    // Mit `vorkommen` ist sie eindeutig.
    claude.weiter(antwort(B.start(), B.text(0, 'rennen.'), B.ende('end_turn')));
    const zweite = await strom(base, pfad, { anweisung: 'umschreiben', auswahl: 'laufen.', vorkommen: 1 });
    assert.equal(zweite.status, 200);
    assert.match(antwortSatz(await nachrichten(base, chatId)).data.content, /Dienstag: laufen\.\n\nZum Schluss: rennen\.$/);
    assert.equal(claude.offen(), 0);
  });
});

test('Umwandeln, das scheitert, hinterlässt keine Fassung: die vorige ist wieder aktiv', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    claude.weiter(antwort(B.start(), B.text(0, 'Bleibt so.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hallo' });
    const satz = antwortSatz(await nachrichten(base, chatId));
    claude.weiter(antwort(B.start(), B.text(0, 'Halb'), B.fehler('overloaded_error', 'Overloaded')));
    const r = await strom(base, `/api/chats/${chatId}/messages/${satz.id}/umwandeln`, { anweisung: 'verbessern' });
    const n = arten(r.ereignisse);
    assert.ok(n.includes('fehler'));
    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data;
    assert.equal(fertig.stopReason, 'fehler');
    assert.equal(fertig.record.data.content, 'Bleibt so.');
    const danach = antwortSatz(await nachrichten(base, chatId));
    assert.equal(danach.data.content, 'Bleibt so.');
    assert.equal(danach.data.status, 'complete');
    assert.equal(danach.data.versionen.length, 1);
    assert.equal(danach.data.version, 0);
  });
});

test('Block bearbeiten: Code und datei-Inhalt werden ersetzt (neue Fassung „bearbeitet“), andere Bausteine nicht', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    const text = [
      'Hier der Code:',
      '',
      '```js',
      'console.log(1)',
      '```',
      '',
      '```ui',
      '{"typ":"datei","name":"notiz.md","inhalt":"# Alt"}',
      '```',
      '',
      '```ui',
      '{"typ":"auswahl","optionen":["A","B"]}',
      '```',
    ].join('\n');
    claude.weiter(antwort(B.start(), B.text(0, text), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Code bitte' });
    const satz = antwortSatz(await nachrichten(base, chatId));
    const pfad = `/api/chats/${chatId}/messages/${satz.id}/block`;

    const a = await anfrage(base, 'PATCH', pfad, { nr: 0, inhalt: 'console.log(2)' });
    assert.equal(a.status, 200, a.text);
    assert.match(a.json.record.data.content, /```js\nconsole\.log\(2\)\n```/);
    assert.deepEqual(a.json.record.data.versionen.map((v) => v.art), ['original', 'bearbeitet']);
    assert.equal(a.json.record.data.versionen[1].nr, 0);

    const d = await anfrage(base, 'PATCH', pfad, { nr: 1, inhalt: '# Neu\n\nText' });
    assert.equal(d.status, 200, d.text);
    const zeile = d.json.record.data.content.split('\n')[7];
    assert.deepEqual(JSON.parse(zeile), { typ: 'datei', name: 'notiz.md', inhalt: '# Neu\n\nText' });

    const nein = await anfrage(base, 'PATCH', pfad, { nr: 2, inhalt: 'x' });
    assert.equal(nein.status, 409);
    assert.equal(nein.json.error.code, 'BLOCK_NICHT_BEARBEITBAR');
    const fehlt = await anfrage(base, 'PATCH', pfad, { nr: 9, inhalt: 'x' });
    assert.equal(fehlt.status, 409);
    assert.equal(fehlt.json.error.code, 'BLOCK_NICHT_GEFUNDEN');
    // `alt` findet den Block, auch wenn die Nummer der Oberfläche einmal abweicht.
    const perAlt = await anfrage(base, 'PATCH', pfad, { nr: 5, alt: 'console.log(2)', inhalt: 'console.log(3)' });
    assert.equal(perAlt.status, 200, perAlt.text);
    assert.match(perAlt.json.record.data.content, /console\.log\(3\)/);
    assert.equal(perAlt.json.record.data.versionen.length, 4);
  });
});

/* ------------------------------------------------- Zustand der Bausteine */

test('Zustand der Bausteine: je Fassung und Schlüssel gespeichert, 16 KB je Baustein und 64 KB je Nachricht', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    claude.weiter(antwort(B.start(), B.text(0, '```ui\n{"typ":"checkliste","punkte":["a","b"]}\n```'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Liste' });
    const satz = antwortSatz(await nachrichten(base, chatId));
    const pfad = `/api/chats/${chatId}/messages/${satz.id}/ui`;

    const a = await anfrage(base, 'PUT', pfad, { schluessel: 'liste', zustand: { erledigt: [0] } });
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(a.json, { messageId: satz.id, version: 0, schluessel: 'liste', zustand: { erledigt: [0] }, ui: { liste: { erledigt: [0] } } });
    // Übersteht das Neuladen; gespeichert je Fassung.
    assert.deepEqual(antwortSatz(await nachrichten(base, chatId)).data.ui, { 0: { liste: { erledigt: [0] } } });

    const gross = await anfrage(base, 'PUT', pfad, { schluessel: 'x', zustand: { s: 'a'.repeat(17 * 1024) } });
    assert.equal(gross.status, 413);
    assert.equal(gross.json.error.code, 'UI_ZUSTAND_ZU_GROSS');
    for (let i = 0; i < 4; i++) {
      const ok = await anfrage(base, 'PUT', pfad, { schluessel: `k${i}`, zustand: { s: 'b'.repeat(15 * 1024) } });
      assert.equal(ok.status, 200, ok.text);
    }
    const voll = await anfrage(base, 'PUT', pfad, { schluessel: 'k4', zustand: { s: 'c'.repeat(15 * 1024) } });
    assert.equal(voll.status, 413);
    assert.match(voll.json.error.message, /64 KB/);

    const weg = await anfrage(base, 'PUT', pfad, { schluessel: 'k0', zustand: null });
    assert.equal(weg.status, 200);
    assert.equal(weg.json.ui.k0, undefined);
    assert.equal((await anfrage(base, 'PUT', pfad, { version: 3, schluessel: 'a', zustand: 1 })).status, 404);
    assert.equal((await anfrage(base, 'PUT', pfad, { schluessel: 'a b', zustand: 1 })).status, 400);
    assert.equal((await anfrage(base, 'PUT', pfad, { schluessel: 'a' })).status, 400);
    assert.equal((await anfrage(base, 'PUT', `/api/chats/${chatId}/messages/message_gibtsnicht/ui`, { schluessel: 'a', zustand: 1 })).status, 404);
  });
});

/* ---------------------------------------------------------------- Gemini */

test('Gemini: neu erstellen und umwandeln gehen genauso (Umwandeln ohne Werkzeuge und ohne Google-Suche)', async () => {
  await mitKi(async ({ base, gemini, chatId }) => {
    gemini.weiter(G.antwort(G.B.text('Rom ist die Hauptstadt Italiens.'), G.B.ende('STOP')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hauptstadt von Italien?' });
    gemini.weiter(G.antwort(G.B.text('Rom.'), G.B.ende('STOP')));
    const r = await strom(base, `/api/chats/${chatId}/neu-antworten`, { variante: 'kuerzer' });
    assert.equal(r.status, 200);
    let satz = antwortSatz(await nachrichten(base, chatId));
    assert.deepEqual(satz.data.versionen.map((v) => v.inhalt), ['Rom ist die Hauptstadt Italiens.', 'Rom.']);
    const teile = gemini.stromAnfragen()[1].body.contents[0].parts.map((p) => p.text);
    assert.match(teile[teile.length - 1], /\[Neu erstellen: Antworte diesmal deutlich kürzer/);

    gemini.weiter(G.antwort(G.B.text('Rome.'), G.B.ende('STOP')));
    const u = await strom(base, `/api/chats/${chatId}/messages/${satz.id}/umwandeln`, { anweisung: 'uebersetzen', sprache: 'Englische' });
    assert.equal(u.status, 200);
    const body = gemini.stromAnfragen()[2].body;
    assert.equal(body.tools, undefined, 'keine functionDeclarations, keine googleSearch');
    assert.match(body.contents[0].parts.map((p) => p.text).join('\n'), /Übersetze die Antwort ins Englische/);
    satz = antwortSatz(await nachrichten(base, chatId));
    assert.equal(satz.data.content, 'Rome.');
    assert.equal(satz.data.versionen[2].sprache, 'Englische');
  }, { mit: 'gemini' });
});

/* ------------------------------------------------- Zusammenfassung Gehirn */

test('Gehirn: die Detailkarte bekommt eine echte KI-Zusammenfassung; ohne KI ehrlich „nicht verfügbar“', async () => {
  await mitKi(async ({ app, base, claude }) => {
    const notiz = app.store.create('note', { title: 'Wasserkreislauf', body: 'Verdunstung, Kondensation, Niederschlag.' });
    claude.weiter(antwort(B.start(), B.text(0, 'Die Notiz beschreibt den Wasserkreislauf in drei Schritten.'), B.ende('end_turn')));
    const r = await anfrage(base, 'POST', '/api/graph/zusammenfassung', { id: notiz.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.verfuegbar, true);
    assert.equal(r.json.text, 'Die Notiz beschreibt den Wasserkreislauf in drei Schritten.');
    const body = letzteStromAnfrage(claude);
    assert.equal(body.tools, undefined);
    assert.match(body.messages[0].content.map((b) => b.text).join('\n'), /Verdunstung, Kondensation, Niederschlag/);
  });
  await mitKi(async ({ app, base }) => {
    const notiz = app.store.create('note', { title: 'X', body: 'Y' });
    const r = await anfrage(base, 'POST', '/api/graph/zusammenfassung', { id: notiz.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.verfuegbar, false);
  }, { verbinden: false });
});

/* ----------------------------------------------------------- reine Teile */

test('stelleFinden und codebloecke: großzügig bei Markdown, streng bei Codezäunen', () => {
  const t = 'Ein **fetter** Satz mit [Link](https://x.de) und `code`.\n\n```js\nconst a = 1;\n```\nDanach.';
  const s = fassungen.stelleFinden(t, 'fetter Satz mit Link');
  assert.equal(s.stelle, '**fetter** Satz mit [Link](https://x.de)');
  assert.equal(fassungen.stelleFinden(t, 'const a = 1;').stelle, 'const a = 1;');
  assert.throws(() => fassungen.stelleFinden(t, 'code. const a'), (e) => e.code === 'AUSWAHL_NICHT_GEFUNDEN' && /Codeblock/.test(e.satz));
  const bloecke = fassungen.codebloecke('a\n```ui\n{"typ":"mehr"}\n```\n- Punkt\n  ```py\n  x = 1\n  ```\n~~~\noffen');
  assert.deepEqual(bloecke.map((b) => [b.nr, b.lang, b.code, b.closed]), [[0, 'ui', '{"typ":"mehr"}', true], [1, 'py', 'x = 1', true], [2, '', 'offen', false]]);
  assert.equal(fassungen.stilSatz({ laenge: 0, fachlich: 100, kreativ: 41 }), '[Antwortstil: Länge 0/100 (sehr kurz), Fachbegriffe 100/100 (sehr fachlich), Kreativität 41/100 (mittel)]'.replace('(mittel)', '(ausgewogen)'));
});
