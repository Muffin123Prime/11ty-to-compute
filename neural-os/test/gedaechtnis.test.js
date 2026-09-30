'use strict';

/**
 * Das Gedächtnis der KI ansehen und vergessen (src/http/api/gedaechtnis.js,
 * Einstellungen, Gruppe "Gedächtnis"). Vergessen wirkt wirklich: der
 * nächste Chat liest es nicht mehr mit. [Rückgängig] holt genau das zurück.
 *
 * Gegen die ECHTE Anwendung und den Claude-Statisten; kein Test verlässt
 * 127.0.0.1.
 */

const assert = require('node:assert/strict');
const { test } = require('./harness');
const { B, antwort } = require('./claude-statist');
const { anfrage, strom, mitKi } = require('./antwort-hilfe');
const { gedaechtnisWahl, GEDAECHTNIS_MAX } = require('../src/models/chat');

/** Was die KI beim letzten Mal über den Nutzer wusste (der zweite Systemblock). */
const wusste = (claude) => {
  const liste = claude.stromAnfragen();
  return liste[liste.length - 1].body.system[1].text;
};

test('Gedächtnis: neueste zuerst, mit Herkunft; was nur ein Agent weiß, liest der Chat nicht mit', async () => {
  await mitKi(async ({ app, base, chatId }) => {
    app.store.update(chatId, { title: 'Reise nach Rom' });
    // Je eine Millisekunde Abstand: sonst hätten sie dieselbe Zeit, und die Reihenfolge wäre Zufall.
    const spaeter = () => new Promise((r) => setTimeout(r, 3));
    const alt = app.store.create('memory', { text: 'Isst vegetarisch.', scope: 'global', sourceId: chatId });
    await spaeter();
    const lauf = app.store.create('run', { agentId: 'agent_x', goal: 'Planen' });
    const agent = app.store.create('memory', { text: 'Bevorzugt Züge.', scope: 'agent:agent_x', sourceId: lauf.id, source: 'agent' });
    await spaeter();
    const neu = app.store.create('memory', { text: 'Geht in die 10b.', scope: 'global' });
    const r = await anfrage(base, 'GET', '/api/gedaechtnis');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.anzahl, 3);
    assert.equal(r.json.mitgelesen, 2);
    assert.deepEqual(r.json.items.map((f) => f.id), [neu.id, agent.id, alt.id], 'neueste zuerst');
    const [a, b, c] = r.json.items;
    assert.deepEqual([a.text, a.fuerAlle, a.liestMit, a.herkunft], ['Geht in die 10b.', true, true, null], 'ohne Herkunft: von dir');
    assert.deepEqual([b.fuerAlle, b.liestMit], [false, false]);
    assert.deepEqual(b.herkunft, { art: 'agent', id: lauf.id, titel: 'einem Agenten', url: `#/agents?id=${lauf.id}` });
    assert.deepEqual(c.herkunft, { art: 'chat', id: chatId, titel: 'Reise nach Rom', url: `#/chat?id=${chatId}` });
    assert.ok(!Number.isNaN(Date.parse(c.createdAt)));
  });
});

test('Gedächtnis: vergessen wirkt im nächsten Chat; [Rückgängig] holt genau das zurück', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    const veg = app.store.create('memory', { text: 'Isst vegetarisch.', scope: 'global' });
    const klasse = app.store.create('memory', { text: 'Geht in die 10b.', scope: 'global' });
    const frage = async (inhalt) => {
      claude.weiter(antwort(B.start(), B.text(0, 'Gut.'), B.ende('end_turn')));
      const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt });
      assert.equal(r.status, 200);
    };
    await frage('Was koche ich heute?');
    assert.match(wusste(claude), /- Isst vegetarisch\./);

    const weg = await anfrage(base, 'POST', '/api/gedaechtnis/vergessen', { ids: [veg.id] });
    assert.equal(weg.status, 200, weg.text);
    assert.deepEqual(weg.json.ids, [veg.id]);
    assert.deepEqual((await anfrage(base, 'GET', '/api/gedaechtnis')).json.items.map((f) => f.id), [klasse.id]);
    await frage('Und morgen?');
    assert.doesNotMatch(wusste(claude), /vegetarisch/, 'die KI weiß es nicht mehr');
    assert.match(wusste(claude), /- Geht in die 10b\./);

    const zurueck = await anfrage(base, 'POST', '/api/gedaechtnis/zurueck', { ids: weg.json.ids });
    assert.deepEqual(zurueck.json.ids, [veg.id]);
    await frage('Und übermorgen?');
    assert.match(wusste(claude), /- Isst vegetarisch\./, 'wieder da');

    // Alles vergessen: ein Schritt, und [Rückgängig] nimmt genau ihn zurück.
    const alles = await anfrage(base, 'POST', '/api/gedaechtnis/vergessen', { alle: true });
    assert.equal(alles.status, 200, alles.text);
    assert.deepEqual([...alles.json.ids].sort(), [veg.id, klasse.id].sort());
    assert.equal((await anfrage(base, 'GET', '/api/gedaechtnis')).json.anzahl, 0);
    await frage('Was weißt du über mich?');
    assert.match(wusste(claude), /Was du über den Nutzer weißt: noch nichts\./);
    await anfrage(base, 'POST', '/api/gedaechtnis/zurueck', { ids: alles.json.ids });
    assert.equal((await anfrage(base, 'GET', '/api/gedaechtnis')).json.anzahl, 2);
    // Im Papierkorb, nicht endgültig weg (wie jedes Löschen).
    assert.equal(app.store.get(veg.id).deletedAt, null);
  });
});

test('Gedächtnis: nur Gemerktes lässt sich hier vergessen; Unsinn wird mit einem Satz abgelehnt', async () => {
  await mitKi(async ({ app, base, chatId }) => {
    const notiz = app.store.create('note', { title: 'Nicht vergessen', body: 'x' });
    const falsch = await anfrage(base, 'POST', '/api/gedaechtnis/vergessen', { ids: [notiz.id] });
    assert.equal(falsch.status, 400);
    assert.match(falsch.json.error.message, /nichts Gemerktes/);
    assert.ok(app.store.get(notiz.id), 'die Notiz bleibt');
    assert.equal((await anfrage(base, 'POST', '/api/gedaechtnis/vergessen', {})).status, 400);
    assert.equal((await anfrage(base, 'POST', '/api/gedaechtnis/vergessen', { ids: ['memory_gibtesnicht'] })).status, 400);
    assert.equal((await anfrage(base, 'POST', '/api/gedaechtnis/zurueck', { ids: 'x' })).status, 400);
    // Zurückholen überspringt, was kein Gemerktes ist.
    const r = await anfrage(base, 'POST', '/api/gedaechtnis/zurueck', { ids: [chatId] });
    assert.deepEqual(r.json.ids, []);
  });
});

test('gedaechtnisWahl: nur für alle, bei sehr vielen die neuesten – die Reihenfolge bleibt fest', () => {
  const m = (i, scope = 'global', text = `Fakt ${i}`) => ({ id: `memory_${i}`, data: { text, scope } });
  const liste = [m(1), m(2, 'agent:a'), m(3), m(4, 'global', '   ')];
  assert.deepEqual(gedaechtnisWahl(liste).map((x) => x.id), ['memory_1', 'memory_3']);
  const viele = Array.from({ length: GEDAECHTNIS_MAX + 5 }, (_, i) => m(i));
  const wahl = gedaechtnisWahl(viele);
  assert.equal(wahl.length, GEDAECHTNIS_MAX);
  assert.equal(wahl[0].id, 'memory_5', 'die ältesten fünf fallen weg');
  assert.equal(wahl[wahl.length - 1].id, `memory_${GEDAECHTNIS_MAX + 4}`);
  const lang = [m(1, 'global', 'a'.repeat(20000)), m(2, 'global', 'b'.repeat(20000))];
  assert.deepEqual(gedaechtnisWahl(lang).map((x) => x.id), ['memory_2'], 'über 30.000 Zeichen: die neueren zählen');
});
