'use strict';

/**
 * Quellen im Text (docs/ANTWORT-BAUSTEINE.md 6): "Quellen: nummeriert,
 * antippbar (neuer Tab), Zahlen im Text verweisen darauf." Hinter dem Satz,
 * der sich auf eine Quelle stuetzt, steht ihre Nummer ("[1]"), in derselben
 * Zaehlung wie die Liste unter der Antwort -- bei Claude an den Textbloecken
 * mit Zitaten, bei Gemini an den Belegen der Google-Suche (groundingSupports).
 * An die KI geht weiter der rohe Block, nie die Marke.
 */

const assert = require('node:assert/strict');
const { test } = require('./harness');
const { strom, mitKi } = require('./antwort-hilfe');
const claudeStatist = require('./claude-statist');
const geminiStatist = require('./gemini-statist');

const QA = { url: 'https://www.bahn.de/streik', titel: 'Streik bei der Bahn' };
const QB = { url: 'https://www.tagesschau.de/streik', titel: 'tagesschau.de' };
const zitat = (q, text) => ({ type: 'web_search_result_location', url: q.url, title: q.titel, cited_text: text, encrypted_index: `enc_${q.titel.length}` });

test('Claude: hinter einem zitierten Satz steht die Nummer seiner Quelle – der Absatz bricht an den Zitaten nicht mehr um', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    const B = claudeStatist.B;
    claude.weiter(claudeStatist.antwort(
      B.start(),
      B.serverWerkzeug(0, 'srvtoolu_q', 'web_search', { query: 'Bahnstreik' }),
      B.suchErgebnis(1, 'srvtoolu_q', [
        { type: 'web_search_result', url: QA.url, title: QA.titel, encrypted_content: 'e1' },
        { type: 'web_search_result', url: QB.url, title: QB.titel, encrypted_content: 'e2' },
      ]),
      B.text(2, 'Laut den Meldungen: '),
      B.text(3, 'Der Streik endet am Freitag.', { zitate: [zitat(QA, 'endet am Freitag')] }),
      B.text(4, ' Die S-Bahn fährt ab Samstag wieder.', { zitate: [zitat(QA, 'S-Bahn'), zitat(QB, 'Samstag')] }),
      B.text(5, ' Mehr weiß ich nicht.'),
      // Ein leerer Block mit Zitat (kommt vor): keine Nummer ins Leere.
      B.text(6, '', { zitate: [zitat(QB, 'x')] }),
      B.ende('end_turn', { server_tool_use: { web_search_requests: 1 } }),
    ));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Streikt die Bahn?' });
    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data;
    const rec = app.store.get(fertig.record.id);
    assert.equal(rec.data.content, 'Laut den Meldungen: Der Streik endet am Freitag.[1] Die S-Bahn fährt ab Samstag wieder.[1][2] Mehr weiß ich nicht.');
    assert.deepEqual(rec.data.quellen.map((q) => q.url), [QA.url, QB.url], 'dieselbe Zählung wie die Liste darunter');
    // Die Marken gingen als Text an die Oberfläche, nicht erst beim Neuladen.
    const gestreamt = r.ereignisse.filter((e) => e.name === 'text').map((e) => e.data.delta).join('');
    assert.equal(gestreamt, rec.data.content);
    // An Claude geht beim nächsten Zug der rohe Block -- ohne Marke.
    const roh = JSON.stringify(rec.data.claude.verlauf);
    assert.doesNotMatch(roh, /\[1\]/);
    assert.match(roh, /Der Streik endet am Freitag\./);
  });
});

test('Claude: nach einem Werkzeug beginnt weiter ein neuer Absatz', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    const B = claudeStatist.B;
    claude.weiter(
      claudeStatist.antwort(B.start(), B.text(0, 'Ich schaue nach.'), B.werkzeug(1, 'toolu_t', 'termine_lesen', { von: '2026-10-01', bis: '2026-10-02' }), B.ende('tool_use')),
      claudeStatist.antwort(B.start(), B.text(0, 'Da ist nichts eingetragen.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Was steht morgen an?' });
    const rec = app.store.get(r.ereignisse.find((e) => e.name === 'fertig').data.record.id);
    assert.equal(rec.data.content, 'Ich schaue nach.\n\nDa ist nichts eingetragen.');
  });
});

test('Gemini: die Belege der Google-Suche setzen die Nummern hinter genau die Sätze, die sich darauf stützen', async () => {
  await mitKi(async ({ app, base, gemini, chatId }) => {
    const text = 'Der Streik endet am Freitag. Die S-Bahn fährt ab Samstag wieder. Mehr weiß ich nicht.';
    const kandidat = {
      content: { role: 'model', parts: [{ text }] },
      index: 0,
      groundingMetadata: {
        webSearchQueries: ['Bahnstreik'],
        groundingChunks: [{ web: { uri: QA.url, title: QA.titel } }, { web: { uri: QB.url, title: QB.titel } }],
        groundingSupports: [
          { segment: { startIndex: 0, endIndex: 28, text: 'Der Streik endet am Freitag.' }, groundingChunkIndices: [0] },
          { segment: { startIndex: 29, endIndex: 65, text: 'Die S-Bahn fährt ab Samstag wieder.' }, groundingChunkIndices: [0, 1] },
          // Ein Beleg, dessen Text nicht vorkommt, wird still übergangen.
          { segment: { text: 'Das steht nirgends.' }, groundingChunkIndices: [1] },
        ],
      },
    };
    gemini.weiter(geminiStatist.antwort([{ candidates: [kandidat], modelVersion: 'gemini-3.8-flash' }], geminiStatist.B.ende('STOP')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Streikt die Bahn?' });
    const rec = app.store.get(r.ereignisse.find((e) => e.name === 'fertig').data.record.id);
    assert.equal(rec.data.content, 'Der Streik endet am Freitag.[1] Die S-Bahn fährt ab Samstag wieder.[1][2] Mehr weiß ich nicht.');
    assert.deepEqual(rec.data.quellen.map((q) => q.url), [QA.url, QB.url]);
    // Die Oberfläche bekommt den ganzen Text mit den Nummern als `inhalt`.
    const inhalt = r.ereignisse.filter((e) => e.name === 'inhalt').map((e) => e.data.content);
    assert.deepEqual(inhalt, [rec.data.content]);
    // Im Verlauf für Gemini steht der Text ohne Marken.
    assert.doesNotMatch(JSON.stringify(rec.data.claude.verlauf), /\[1\]/);
  }, { mit: 'gemini' });
});

test('Gemini: keine Nummer in einen Codeblock; ohne Belege bleibt der Text, wie er ist', async () => {
  await mitKi(async ({ app, base, gemini, chatId }) => {
    const text = 'So geht es:\n\n```\nnpm start\n```\n\nFertig.';
    gemini.weiter(geminiStatist.antwort([{
      candidates: [{
        content: { role: 'model', parts: [{ text }] },
        index: 0,
        groundingMetadata: {
          groundingChunks: [{ web: { uri: QA.url, title: QA.titel } }],
          groundingSupports: [
            { segment: { text: 'npm start' }, groundingChunkIndices: [0] },
            { segment: { text: 'Fertig.' }, groundingChunkIndices: [0] },
          ],
        },
      }],
    }], geminiStatist.B.ende('STOP')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Wie starte ich es?' });
    const rec = app.store.get(r.ereignisse.find((e) => e.name === 'fertig').data.record.id);
    assert.equal(rec.data.content, 'So geht es:\n\n```\nnpm start\n```\n\nFertig.[1]', 'der Code bleibt unberührt');

    gemini.weiter(geminiStatist.antwort(geminiStatist.B.text('Einfach so.'), geminiStatist.B.ende('STOP')));
    const r2 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Und ohne Suche?' });
    const rec2 = app.store.get(r2.ereignisse.find((e) => e.name === 'fertig').data.record.id);
    assert.equal(rec2.data.content, 'Einfach so.');
    assert.equal(r2.ereignisse.filter((e) => e.name === 'inhalt').length, 0);
  }, { mit: 'gemini' });
});

/* ------------------------------------------- Prüfrunde: Ränder der Marken */

const fassungen = require('../src/models/fassungen');
const { anfrage } = require('./antwort-hilfe');

test('Claude: keine Nummer in einen Codeblock; endet der zitierte Block mit einem Umbruch, steht sie davor', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    const B = claudeStatist.B;
    claude.weiter(claudeStatist.antwort(
      B.start(),
      B.serverWerkzeug(0, 'srvtoolu_c', 'web_search', { query: 'npm' }),
      B.suchErgebnis(1, 'srvtoolu_c', [{ type: 'web_search_result', url: QA.url, title: QA.titel, encrypted_content: 'e1' }]),
      B.text(2, 'So startest du es:\n\n```bash\n'),
      B.text(3, 'npm start', { zitate: [zitat(QA, 'npm start')] }),
      B.text(4, '\n```\n\n'),
      B.text(5, 'Der Streik endet am Freitag.\n', { zitate: [zitat(QA, 'Freitag')] }),
      B.text(6, '```\nnoch Code\n```'),
      B.ende('end_turn', { server_tool_use: { web_search_requests: 1 } }),
    ));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Wie starte ich es?' });
    const rec = app.store.get(r.ereignisse.find((e) => e.name === 'fertig').data.record.id);
    assert.equal(rec.data.content, 'So startest du es:\n\n```bash\nnpm start\n```\n\nDer Streik endet am Freitag.[1]\n```\nnoch Code\n```');
    // Die Oberfläche bekam die eingeschobene Nummer als ganzen Text.
    const inhalt = r.ereignisse.filter((e) => e.name === 'inhalt').map((e) => e.data.content);
    assert.equal(inhalt.length, 1);
    assert.equal(inhalt[0], 'So startest du es:\n\n```bash\nnpm start\n```\n\nDer Streik endet am Freitag.[1]\n');
  });
});

test('Gemini: endet ein Beleg mit einem Umbruch, steht die Nummer hinter dem Satz, nicht am Anfang der nächsten Zeile', async () => {
  await mitKi(async ({ app, base, gemini, chatId }) => {
    const text = 'Der Streik endet am Freitag.\n```\nnpm start\n```';
    gemini.weiter(geminiStatist.antwort([{
      candidates: [{
        content: { role: 'model', parts: [{ text }] },
        index: 0,
        groundingMetadata: {
          groundingChunks: [{ web: { uri: QA.url, title: QA.titel } }],
          groundingSupports: [{ segment: { text: 'Der Streik endet am Freitag.\n' }, groundingChunkIndices: [0] }],
        },
      }],
    }], geminiStatist.B.ende('STOP')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Streik?' });
    const rec = app.store.get(r.ereignisse.find((e) => e.name === 'fertig').data.record.id);
    assert.equal(rec.data.content, 'Der Streik endet am Freitag.[1]\n```\nnpm start\n```', 'der Zaun bleibt ein Zaun');
  }, { mit: 'gemini' });
});

test('ohneVerweise: Nummern raus, aber nicht aus Code, nicht aus Links', () => {
  assert.equal(
    fassungen.ohneVerweise('A.[1] B.[1][2] Code `a[1]` und [Link](https://x.de) und [3](https://y.de).\n\n```js\nx[1]\n```\nC.[4]'),
    'A. B. Code `a[1]` und [Link](https://x.de) und [3](https://y.de).\n\n```js\nx[1]\n```\nC.',
  );
  assert.equal(fassungen.ohneVerweise('Ohne Nummern.'), 'Ohne Nummern.');
  assert.equal(fassungen.ohneVerweise(''), '');
});

test('Umschreiben einer Markierung bis zur Nummer: die Klammer gehört dazu, kein „]“ bleibt stehen', () => {
  const t = 'Der Streik endet am Freitag.[1] Mehr weiß ich nicht.';
  assert.equal(fassungen.stelleFinden(t, 'Der Streik endet am Freitag.[1]').stelle, 'Der Streik endet am Freitag.[1]');
  assert.equal(fassungen.stelleFinden(t, 'endet am Freitag.1').stelle, 'endet am Freitag.[1]');
  // Ein Link bleibt ganz, wie bisher.
  assert.equal(fassungen.stelleFinden('Siehe [die Seite](https://x.de) hier.', 'Siehe die Seite').stelle, 'Siehe [die Seite](https://x.de)');
});

test('Fassungen: jede behält ihre Quellen; an die KI gehen keine Nummern ohne Quelle', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    const B = claudeStatist.B;
    const gesucht = (id, q, satz) => claudeStatist.antwort(
      B.start(),
      B.serverWerkzeug(0, id, 'web_search', { query: 'Bahn' }),
      B.suchErgebnis(1, id, [{ type: 'web_search_result', url: q.url, title: q.titel, encrypted_content: `e_${id}` }]),
      B.text(2, satz, { zitate: [zitat(q, 'x')] }),
      B.ende('end_turn', { server_tool_use: { web_search_requests: 1 } }),
    );
    claude.weiter(gesucht('srvtoolu_a', QA, 'Der Streik endet am Freitag.'));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Streikt die Bahn?' });
    // Kürzer: eine neue Fassung mit einer anderen Quelle.
    claude.weiter(gesucht('srvtoolu_b', QB, 'Streik bis Freitag.'));
    const r = await strom(base, `/api/chats/${chatId}/neu-antworten`, { variante: 'kuerzer' });
    assert.equal(r.status, 200);
    const zweite = claude.stromAnfragen()[1].body;
    const auftrag = JSON.stringify(zweite.messages[zweite.messages.length - 1]);
    assert.match(auftrag, /Der Streik endet am Freitag\./, 'die bisherige Antwort geht als Vorlage mit');
    assert.doesNotMatch(auftrag, /Freitag\.\[1\]/, '… ohne ihre Nummer');

    const items = (await anfrage(base, 'GET', `/api/chats/${chatId}/messages`)).json.items;
    const satz = items.find((m) => m.data.role === 'assistant');
    assert.equal(satz.data.content, 'Streik bis Freitag.[1]');
    assert.deepEqual(satz.data.quellen.map((q) => q.url), [QB.url], 'oben: die Quellen der aktiven Fassung');
    assert.deepEqual(satz.data.versionen[0].quellen, [{ titel: QA.titel, url: QA.url, art: 'zitat' }], 'die ältere bringt ihre eigenen mit');
    assert.equal(satz.data.versionen[1].quellen, undefined, 'die aktive trägt sie oben, nicht doppelt');

    // Die nächste Frage: die spätere Fassung geht als Text mit -- ohne "[1]".
    claude.weiter(claudeStatist.antwort(B.start(), B.text(0, 'Gern.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Danke' });
    const dritte = claude.stromAnfragen()[2].body;
    const verlauf = JSON.stringify(dritte.messages);
    assert.match(verlauf, /Streik bis Freitag\./);
    assert.doesNotMatch(verlauf, /\[1\]/);
  });
});
