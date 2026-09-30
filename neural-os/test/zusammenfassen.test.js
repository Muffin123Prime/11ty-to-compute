'use strict';

/**
 * Die KI-Zusammenfassung in der Detailkarte des Gehirns
 * (src/models/zusammenfassen.js, POST /api/graph/zusammenfassung):
 * einmal fragen, dann merken -- bis sich der Eintrag oder sein Verknüpftes
 * ändert. Beim Öffnen der Karte nur nachsehen (`nurGespeichert`), nie die
 * KI fragen. Ohne KI ehrlich ein Satz.
 *
 * Gegen die ECHTE Anwendung und den Claude-Statisten; kein Test verlässt
 * 127.0.0.1.
 */

const assert = require('node:assert/strict');
const { test } = require('./harness');
const { B, antwort } = require('./claude-statist');
const { anfrage, mitKi } = require('./antwort-hilfe');
const z = require('../src/models/zusammenfassen');

const PFAD = '/api/graph/zusammenfassung';

test('Zusammenfassung, reine Teile: Anfrage nur aus dem Eintrag, Schlüssel je Fassung und Nachbarn, Speicher mit Obergrenze', () => {
  const record = { id: 'note_a', type: 'note', rev: 1, updatedAt: '2026-09-30T10:00:00.000Z', data: { title: 'Wasserkreislauf', body: 'Verdunstung, Kondensation.' } };
  const verknuepft = { ausgehend: [{ id: 'note_b', title: 'Wetter', type: 'note', kind: 'related' }], eingehend: [] };
  const a = z.anfrageFuer({ record, verknuepft });
  const alles = a.nachrichten[0].content.map((b) => b.text).join('\n');
  assert.match(alles, /Titel: Wasserkreislauf/);
  assert.match(alles, /Verdunstung, Kondensation\./);
  assert.match(alles, /- Wetter \(note, related\)/);
  assert.match(alles, /Nur aus dem, was hier steht\./);
  assert.equal(a.system, z.SYSTEM);
  assert.match(a.purpose, /Wasserkreislauf/);
  assert.equal(z.anfrageFuer({ record: { ...record, data: { title: 'Leer' } }, verknuepft: null }).nachrichten[0].content[1].text, 'Inhalt: (leer)');

  const k = z.schluesselVon(record, verknuepft);
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(z.schluesselVon({ ...record }, { ...verknuepft }), k, 'derselbe Stand, derselbe Schlüssel');
  assert.notEqual(z.schluesselVon({ ...record, rev: 2, updatedAt: '2026-09-30T10:05:00.000Z' }, verknuepft), k, 'bearbeitet: neuer Schlüssel');
  assert.notEqual(z.schluesselVon(record, { ausgehend: [], eingehend: [] }), k, 'Verknüpfung weg: neuer Schlüssel');
  assert.notEqual(z.schluesselVon({ ...record, id: 'note_c' }, verknuepft), k);

  const g = z.createGedaechtnis({ max: 2 });
  g.ablegen('a', { text: 'A' });
  g.ablegen('b', { text: 'B' });
  assert.deepEqual(g.holen('a'), { text: 'A' }, 'holen macht „a“ wieder frisch');
  g.ablegen('c', { text: 'C' });
  assert.equal(g.groesse, 2);
  assert.equal(g.holen('b'), null, 'der am längsten nicht gebrauchte geht zuerst');
  assert.deepEqual(g.holen('a'), { text: 'A' });
  assert.deepEqual(g.holen('c'), { text: 'C' });
});

test('Zusammenfassung: beim Öffnen nur nachsehen, einmal fragen, dann gemerkt – bis der Eintrag sich ändert', async () => {
  await mitKi(async ({ app, base, claude }) => {
    const notiz = app.store.create('note', { title: 'Wasserkreislauf', body: 'Verdunstung, Kondensation, Niederschlag.' });
    const wetter = app.store.create('note', { title: 'Wetter', body: 'Regen.' });
    const fragen = () => claude.stromAnfragen().length;
    const vorher = fragen();

    // Die Karte öffnet sich: nachsehen kostet keine Anfrage.
    const offen = await anfrage(base, 'POST', PFAD, { id: notiz.id, nurGespeichert: true });
    assert.equal(offen.status, 200, offen.text);
    assert.deepEqual(offen.json, { id: notiz.id, verfuegbar: false, text: null, modell: null, am: null, gespeichert: false, kiVerbunden: true, grund: null });
    assert.equal(fragen(), vorher, 'nachsehen fragt die KI nicht');

    // [Zusammenfassen]: die KI wird einmal gefragt.
    claude.weiter(antwort(B.start(), B.text(0, 'Die Notiz beschreibt den Wasserkreislauf in drei Schritten.'), B.ende('end_turn')));
    const erst = await anfrage(base, 'POST', PFAD, { id: notiz.id });
    assert.equal(erst.status, 200, erst.text);
    assert.equal(erst.json.verfuegbar, true);
    assert.equal(erst.json.text, 'Die Notiz beschreibt den Wasserkreislauf in drei Schritten.');
    assert.equal(erst.json.gespeichert, false);
    assert.equal(erst.json.kiVerbunden, true);
    assert.ok(erst.json.modell, 'das Modell steht dabei');
    assert.ok(!Number.isNaN(Date.parse(erst.json.am)));
    assert.equal(fragen(), vorher + 1);

    // Noch einmal öffnen und noch einmal drücken: gemerkt, keine zweite Anfrage.
    const wieder = await anfrage(base, 'POST', PFAD, { id: notiz.id, nurGespeichert: true });
    assert.equal(wieder.json.text, erst.json.text);
    assert.equal(wieder.json.gespeichert, true);
    assert.equal(wieder.json.am, erst.json.am);
    const nochmal = await anfrage(base, 'POST', PFAD, { id: notiz.id });
    assert.equal(nochmal.json.gespeichert, true);
    assert.equal(fragen(), vorher + 1, 'die gemerkte gilt, solange sich nichts ändert');

    // Eine neue Verknüpfung: die alte Zusammenfassung gilt nicht mehr.
    app.store.edges.add({ from: notiz.id, to: wetter.id, kind: 'related', source: 'manual' });
    const nachKante = await anfrage(base, 'POST', PFAD, { id: notiz.id, nurGespeichert: true });
    assert.equal(nachKante.json.text, null);
    assert.equal(nachKante.json.kiVerbunden, true);

    // Bearbeitet: ebenso. Die neue Anfrage enthält den neuen Text und den Nachbarn.
    app.store.update(notiz.id, { body: 'Verdunstung, Kondensation, Niederschlag, Versickerung.' });
    claude.weiter(antwort(B.start(), B.text(0, 'Jetzt mit Versickerung.'), B.ende('end_turn')));
    const neu = await anfrage(base, 'POST', PFAD, { id: notiz.id });
    assert.equal(neu.json.text, 'Jetzt mit Versickerung.');
    assert.equal(neu.json.gespeichert, false);
    const body = claude.stromAnfragen()[claude.stromAnfragen().length - 1].body;
    assert.equal(body.tools, undefined, 'keine Werkzeuge, keine Websuche');
    const gesendet = body.messages[0].content.map((b) => b.text).join('\n');
    assert.match(gesendet, /Versickerung/);
    assert.match(gesendet, /- Wetter \(note, related\)/);

    // [Neu zusammenfassen]: fragt trotz gemerkter noch einmal und merkt die neue.
    claude.weiter(antwort(B.start(), B.text(0, 'Anders gesagt: Wasser wandert im Kreis.'), B.ende('end_turn')));
    const anders = await anfrage(base, 'POST', PFAD, { id: notiz.id, neu: true });
    assert.equal(anders.json.text, 'Anders gesagt: Wasser wandert im Kreis.');
    assert.equal(anders.json.gespeichert, false);
    const danach = await anfrage(base, 'POST', PFAD, { id: notiz.id, nurGespeichert: true, neu: true });
    assert.equal(danach.json.text, 'Anders gesagt: Wasser wandert im Kreis.', '`neu` zusammen mit `nurGespeichert` fragt nie');
    assert.equal(danach.json.gespeichert, true);
  });
});

test('Zusammenfassung: gibt die KI nichts zurück, sagt die Karte das; ohne KI ein Satz und kein Knopf', async () => {
  await mitKi(async ({ app, base, claude }) => {
    const notiz = app.store.create('note', { title: 'X', body: 'Y' });
    claude.weiter(antwort(B.start(), B.text(0, '   '), B.ende('end_turn')));
    const r = await anfrage(base, 'POST', PFAD, { id: notiz.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.verfuegbar, false);
    assert.equal(r.json.kiVerbunden, true);
    assert.equal(r.json.grund, 'Die KI hat diesmal nichts zurückgegeben. Versuch es gleich noch einmal.');
    const offen = await anfrage(base, 'POST', PFAD, { id: notiz.id, nurGespeichert: true });
    assert.equal(offen.json.text, null, 'nichts Leeres gemerkt');
  });
  await mitKi(async ({ app, base, claude }) => {
    const notiz = app.store.create('note', { title: 'X', body: 'Y' });
    for (const nurGespeichert of [true, false]) {
      const r = await anfrage(base, 'POST', PFAD, { id: notiz.id, nurGespeichert });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.verfuegbar, false);
      assert.equal(r.json.kiVerbunden, false);
      assert.equal(r.json.grund, 'Kommt, sobald eine KI verbunden ist.');
    }
    assert.equal(claude.stromAnfragen().length, 0);
  }, { verbinden: false });
});
