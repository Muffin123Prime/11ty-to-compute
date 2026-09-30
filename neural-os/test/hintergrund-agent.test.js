'use strict';

/**
 * Der Hintergrund-Agent (agent_starten, docs/UEBERGABE.md 4.3): der Chat
 * gibt eine längere Arbeit ab, der Agent arbeitet weiter, während man redet
 * (src/agents/runtime.js), ändert NICHTS und legt, was er anlegen oder
 * verknüpfen würde, als Vorschlag ab (src/agents/tools.js). Erst
 * [Übernehmen] (src/assist/engine.js accept) ändert etwas.
 *
 * Gegen die ECHTE Anwendung und den Claude-Statisten -- Chat und Agent
 * fragen denselben Statisten, jeder bekommt seine eigenen Antworten (`wenn`).
 * Kein Test verlässt 127.0.0.1.
 */

const assert = require('node:assert/strict');
const { test } = require('./harness');
const { B, antwort } = require('./claude-statist');
const { anfrage, strom, mitKi } = require('./antwort-hilfe');
const { HINTERGRUND } = require('../src/models/werkzeuge');

const istAgent = (body) => !!body && JSON.stringify(body.system || '').includes('Du bist \\"Hintergrund-Agent\\"');
const fuerAgent = (a) => ({ ...a, wenn: istAgent });
const fuerChat = (a) => ({ ...a, wenn: (body) => !istAgent(body) });

async function bisFertig(app, runId, ms = 8000) {
  const bis = Date.now() + ms;
  for (;;) {
    const r = app.store.get(runId);
    if (r && ['done', 'failed', 'aborted'].includes(r.data.status)) return r;
    if (Date.now() > bis) throw new Error(`Lauf ${runId} wurde nicht fertig (${r && r.data.status})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

test('Hintergrund-Agent: der Chat startet ihn, er ändert nichts und legt Vorschläge ab; erst [Übernehmen] legt an', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    const licht = app.store.create('note', { title: 'Photosynthese', body: 'Pflanzen machen aus Licht und Chlorophyll Zucker.' });
    const blatt = app.store.create('note', { title: 'Blattgrün', body: 'Chlorophyll ist grün.' });
    const notizenVorher = app.store.all('note').length;
    // Nur die Kanten eines Agenten zählen: die Ableitung verknüpft neue Notizen nebenher selbst.
    const agentenKanten = () => app.store.all('edge').filter((e) => e.data.source === 'agent').length;
    const kantenVorher = agentenKanten();
    const ereignisse = [];
    app.bus.on('run.finished', (e) => ereignisse.push(e.payload));

    claude.weiter(
      fuerChat(antwort(B.start(), B.werkzeug(0, 'toolu_ag', 'agent_starten', {
        titel: 'Biologie-Notizen ordnen',
        auftrag: 'Geh die Notizen zur Photosynthese durch, schlag eine Überblicksnotiz und passende Verknüpfungen vor.',
      }), B.ende('tool_use'))),
      fuerChat(antwort(B.start(), B.text(0, 'Ein Agent sortiert das im Hintergrund; die Vorschläge findest du unter „Agenten“.'), B.ende('end_turn'))),
      fuerAgent(antwort(B.start(), B.text(0, 'Ich suche.\n<tool name="notes.search">{"query": "Photosynthese", "limit": 5}</tool>'), B.ende('end_turn'))),
      fuerAgent(antwort(B.start(), B.text(0, [
        '<tool name="notes.create">{"title": "Photosynthese – Überblick", "body": "Licht und Chlorophyll werden zu Zucker.", "tags": ["bio"]}</tool>',
        `<tool name="graph.link">{"from": "${licht.id}", "to": "${blatt.id}", "reason": "Beide handeln vom Chlorophyll."}</tool>`,
        `<tool name="notes.update">{"id": "${licht.id}", "body": "überschrieben"}</tool>`,
      ].join('\n')), B.ende('end_turn'))),
      fuerAgent(antwort(B.start(), B.text(0, 'Ich schlage eine Überblicksnotiz und eine Verknüpfung vor.'), B.ende('end_turn'))),
    );

    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Geh bitte meine Photosynthese-Notizen durch und ordne sie.' });
    assert.equal(r.status, 200);
    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data;
    const antwortSatz = app.store.get(fertig.record.id);
    const start = (antwortSatz.data.agenten || []).find((a) => a.werkzeug === 'agent_starten');
    assert.ok(start, 'die Tätigkeit steht an der Antwort');
    assert.equal(start.zustand, 'fertig');
    assert.equal(start.ergebnis, 'Hintergrund-Agent gestartet: Biologie-Notizen ordnen');
    assert.equal(start.wirkung.length, 1);
    const w = start.wirkung[0];
    assert.equal(w.typ, 'run');
    assert.equal(w.titel, 'Biologie-Notizen ordnen');

    const lauf = await bisFertig(app, w.id);
    assert.equal(lauf.data.status, 'done', JSON.stringify(lauf.data.error));
    assert.equal(lauf.data.rolle, 'hintergrund');
    assert.equal(lauf.data.titel, 'Biologie-Notizen ordnen');
    assert.equal(lauf.data.vorschlagsmodus, true);
    assert.equal(lauf.data.chatId, chatId);
    assert.equal(lauf.data.messageId, antwortSatz.id);
    assert.equal(lauf.data.result, 'Ich schlage eine Überblicksnotiz und eine Verknüpfung vor.');
    assert.equal(lauf.data.vorschlaege, 2);
    const agent = app.store.get(lauf.data.agentId);
    assert.equal(agent.data.kennung, HINTERGRUND.kennung);
    assert.equal(agent.data.permissions.network, 'offline');

    // Nichts ist geändert: keine neue Notiz, keine neue Kante, der Text steht noch.
    assert.equal(app.store.all('note').length, notizenVorher);
    assert.equal(agentenKanten(), kantenVorher);
    assert.equal(app.store.get(licht.id).data.body, 'Pflanzen machen aus Licht und Chlorophyll Zucker.');
    // notes.update gehört nicht zu seiner Ausstattung: ein Satz statt einer Ausführung.
    const update = lauf.data.steps.find((st) => st.kind === 'tool' && st.tool === 'notes.update');
    assert.equal(update.ok, false);
    assert.equal(update.error.fehler, 'PERMISSION_DENIED');

    const vorschlaege = app.store.all('suggestion').filter((s) => s.data.runId === lauf.id);
    assert.deepEqual(vorschlaege.map((s) => s.data.kind).sort(), ['link', 'notiz']);
    for (const v of vorschlaege) {
      assert.equal(v.data.source, 'agent');
      assert.equal(v.data.status, 'open');
      assert.equal(v.data.chatId, chatId);
    }
    const ende = ereignisse.find((e) => e.runId === lauf.id);
    assert.equal(ende.vorschlagsmodus, true);
    assert.equal(ende.vorschlaege, 2);
    assert.equal(ende.titel, 'Biologie-Notizen ordnen');

    // [Übernehmen]: erst jetzt entsteht etwas.
    const notizV = vorschlaege.find((s) => s.data.kind === 'notiz');
    assert.equal(notizV.data.title, 'Neue Notiz: „Photosynthese – Überblick“');
    const a1 = await anfrage(base, 'POST', `/api/assist/suggestions/${notizV.id}/accept`, {});
    assert.equal(a1.status, 200, a1.text);
    const neu = app.store.get(a1.json.applied.noteId);
    assert.equal(neu.data.title, 'Photosynthese – Überblick');
    assert.equal(neu.data.body, 'Licht und Chlorophyll werden zu Zucker.');
    assert.deepEqual(neu.data.tags, ['bio']);
    const linkV = vorschlaege.find((s) => s.data.kind === 'link');
    assert.match(linkV.data.title, /„Photosynthese“ und „Blattgrün“/);
    assert.equal(linkV.data.reason, 'Beide handeln vom Chlorophyll.');
    const a2 = await anfrage(base, 'POST', `/api/assist/suggestions/${linkV.id}/accept`, {});
    assert.equal(a2.status, 200, a2.text);
    const kante = app.store.get(a2.json.applied.edgeId);
    assert.deepEqual([kante.data.from, kante.data.to, kante.data.source], [licht.id, blatt.id, 'agent']);
    // Zweimal übernehmen geht nicht.
    assert.equal((await anfrage(base, 'POST', `/api/assist/suggestions/${linkV.id}/accept`, {})).status, 400);
  });
});

test('Hintergrund-Agent: eine ungültige Eingabe startet nichts; der Agent-Satz entsteht nur einmal', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    claude.weiter(
      fuerChat(antwort(B.start(), B.werkzeug(0, 'toolu_x', 'agent_starten', { titel: '', auftrag: 'kurz' }), B.ende('tool_use'))),
      fuerChat(antwort(B.start(), B.text(0, 'Das ging nicht.'), B.ende('end_turn'))),
    );
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Mach mal.' });
    assert.equal(app.store.all('run').filter((x) => x.data.rolle === 'hintergrund').length, 0, 'kein Lauf, auch kein Tätigkeits-Satz');
    const zweite = claude.stromAnfragen()[1].body;
    const ergebnis = zweite.messages[zweite.messages.length - 1].content.find((b) => b.type === 'tool_result');
    assert.equal(ergebnis.is_error, true);
    assert.match(JSON.stringify(ergebnis), /titel|auftrag/);

    // Zwei Läufe, ein Agent-Satz.
    for (const n of [1, 2]) {
      claude.weiter(
        fuerChat(antwort(B.start(), B.werkzeug(0, `toolu_${n}`, 'agent_starten', { titel: `Arbeit ${n}`, auftrag: 'Sammle alles zu Photosynthese und fasse es zusammen.' }), B.ende('tool_use'))),
        fuerChat(antwort(B.start(), B.text(0, 'Läuft.'), B.ende('end_turn'))),
        fuerAgent(antwort(B.start(), B.text(0, 'Nichts gefunden.'), B.ende('end_turn'))),
      );
      await strom(base, `/api/chats/${chatId}/messages`, { inhalt: `Auftrag ${n}` });
      const lauf = app.store.all('run').find((x) => x.data.titel === `Arbeit ${n}`);
      await bisFertig(app, lauf.id);
    }
    assert.equal(app.store.all('agent').filter((a) => a.data.kennung === HINTERGRUND.kennung).length, 1);
    // Je Auftrag genau EIN Lauf in "Agenten" -- die Tätigkeit im Chat legt keinen zweiten an.
    assert.equal(app.store.all('run').filter((x) => x.data.rolle === 'hintergrund').length, 2);
  });
});
