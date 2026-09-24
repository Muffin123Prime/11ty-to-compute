'use strict';

/**
 * Was die Chat-Oberfläche vom Server braucht, über das, was das Senden
 * ohnehin liefert: Neu antworten, Bearbeiten, "Rückgängig" für das, was die
 * KI angelegt hat, und die Wirkung am Agenten-Ereignis (die Karte "Termin
 * eingetragen · Do, 25. Sep · 15:00 · Zahnarzt").
 *
 * Wie test/claude.test.js gegen die ECHTE Anwendung und den Statisten aus
 * test/claude-statist.js. Kein Test verlässt 127.0.0.1.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, tempHome } = require('./harness');
const { starten, B, antwort } = require('./claude-statist');

const { createApp, seedIfEmpty } = require('../src/app');
const { SYSTEM_FEST } = require('../src/models/chat');
const { DEFINITIONEN } = require('../src/models/werkzeuge');

/* --------------------------------------------------------------- Helfer */

function anfrage(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' ? { 'x-neural-os': '1' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function strom(base, urlPath, body) {
  const r = await anfrage(base, 'POST', urlPath, body);
  if (!String(r.headers['content-type'] || '').startsWith('text/event-stream')) {
    return { status: r.status, json: r.json, ereignisse: [] };
  }
  const ereignisse = [];
  for (const block of r.text.split('\n\n')) {
    let name = null;
    const daten = [];
    for (const zeile of block.split('\n')) {
      if (zeile.startsWith('event: ')) name = zeile.slice(7);
      else if (zeile.startsWith('data: ')) daten.push(zeile.slice(6));
    }
    if (!name || !daten.length) continue;
    ereignisse.push({ name, data: JSON.parse(daten.join('\n')) });
  }
  return { status: r.status, ereignisse };
}

const arten = (liste) => liste.map((e) => e.name);
const textVon = (liste) => liste.filter((e) => e.name === 'text').map((e) => e.data.delta).join('');

async function mitClaude(fn, { verbinden = true } = {}) {
  const { home, cleanup } = tempHome('nos-chatui');
  const statist = await starten();
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, claudeBasis: statist.url });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    if (verbinden) {
      const r = await anfrage(base, 'POST', '/api/claude/schluessel', { schluessel: statist.schluessel });
      assert.equal(r.status, 200, r.text);
    }
    const chat = await anfrage(base, 'POST', '/api/chats', {});
    await fn({ app, base, statist, chatId: chat.json.record.id });
  } finally {
    if (app) await app.close().catch(() => {});
    await statist.close();
    cleanup();
  }
}

const nachrichten = async (base, chatId) => (await anfrage(base, 'GET', `/api/chats/${chatId}/messages`)).json.items;

/** Ein Zug, in dem Claude einen Termin einträgt und das kurz bestätigt. */
function terminZug(statist, id = 'toolu_t1', eingabe = { titel: 'Zahnarzt', start: '2026-09-25T15:00', ganztaegig: false, ort: 'Praxis am Markt' }) {
  statist.weiter(
    antwort(B.start(), B.werkzeug(0, id, 'termin_anlegen', eingabe), B.ende('tool_use')),
    antwort(B.start(), B.text(0, 'Eingetragen: Do., 25.09., 15:00 Uhr.'), B.ende('end_turn')),
  );
}

/* ------------------------------------------------------- Systemtext */

test('Der feste Systemtext verlangt Texte zum Weiterverwenden allein in ```prompt/```text – ohne Datum, ohne Widerspruch zum Werkzeug', () => {
  assert.match(SYSTEM_FEST, /```prompt/);
  assert.match(SYSTEM_FEST, /```text/);
  assert.match(SYSTEM_FEST, /ohne Einleitung im Block/);
  assert.match(SYSTEM_FEST, /rueckfrage mit 2–5 kurzen Optionen/);
  assert.ok(!/20\d\d/.test(SYSTEM_FEST), 'kein Datum im festen Teil (sonst ist der Cache wertlos)');
  // Die Werkzeugbeschreibung erlaubt 2 bis 6 – 2 bis 5 liegt darin, widerspricht also nicht.
  const frage = DEFINITIONEN.find((d) => d.name === 'rueckfrage');
  assert.match(frage.description, /2 bis 6/);
});

/* ------------------------------------------------ Wirkung am Agenten */

test('Die Wirkung steht am Agenten-Ereignis und in der Antwort: was angelegt wurde, als Schnappschuss', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    terminZug(statist);
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Donnerstag 15 Uhr Zahnarzt' });
    const fertig = r.ereignisse.filter((e) => e.name === 'agent' && e.data.zustand === 'fertig').map((e) => e.data);
    assert.equal(fertig.length, 1);
    assert.equal(fertig[0].werkzeug, 'termin_anlegen');
    const termin = app.store.all('event')[0];
    assert.deepEqual(fertig[0].wirkung, [{
      id: termin.id, typ: 'event', aktion: 'angelegt', titel: 'Zahnarzt',
      start: '2026-09-25T15:00', end: null, ganztaegig: false, ort: 'Praxis am Markt',
    }]);
    // Das "läuft"-Ereignis trägt noch keine Wirkung -- es ist ja noch nichts geschehen.
    const laeuft = r.ereignisse.find((e) => e.name === 'agent' && e.data.zustand === 'laeuft').data;
    assert.equal(laeuft.wirkung, undefined);
    // Gespeichert an der Antwort: die Karte übersteht das Neuladen.
    const antwortSatz = (await nachrichten(base, chatId)).find((m) => m.data.role === 'assistant');
    assert.equal(antwortSatz.data.agenten[0].werkzeug, 'termin_anlegen');
    assert.equal(antwortSatz.data.agenten[0].wirkung[0].id, termin.id);
  });
});

test('Ein gescheitertes Werkzeug hat keine Wirkung – keine Karte für etwas, das nicht geschah', async () => {
  await mitClaude(async ({ base, statist, chatId }) => {
    statist.weiter(
      antwort(B.start(), B.werkzeug(0, 'toolu_x', 'termin_loeschen', { id: 'event_gibtsnicht' }), B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Den Termin gab es nicht.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'lösch den Zahnarzt' });
    const ag = r.ereignisse.filter((e) => e.name === 'agent').map((e) => e.data);
    assert.equal(ag[ag.length - 1].zustand, 'fehler');
    assert.ok(ag.every((a) => a.wirkung === undefined));
  });
});

/* --------------------------------------------------------- Rückgängig */

test('„Rückgängig“ nimmt den Termin der KI über den Verlauf zurück – und die Antwort merkt es sich', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    terminZug(statist);
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Donnerstag 15 Uhr Zahnarzt' });
    const lauf = r.ereignisse.find((e) => e.name === 'agent' && e.data.zustand === 'fertig').data;
    const termin = app.store.all('event')[0];

    const u = await anfrage(base, 'POST', `/api/chats/${chatId}/rueckgaengig`, { runId: lauf.runId });
    assert.equal(u.status, 200, u.text);
    assert.equal(u.json.ok, true);
    assert.deepEqual(u.json.zurueckgenommen.map((z) => [z.id, z.op]), [[termin.id, 'create']]);
    assert.equal(app.store.get(termin.id), null, 'der Termin ist wirklich weg');
    assert.equal(app.store.all('event').length, 0);
    // Der Verlauf sagt es genauso.
    const eintrag = app.history.list({}).items.find((e) => e.id === termin.id && e.op === 'create');
    assert.equal(eintrag.undone, true);
    // Die Antwort trägt den Vermerk, der Lauf auch.
    const antwortSatz = (await nachrichten(base, chatId)).find((m) => m.data.role === 'assistant');
    assert.ok(antwortSatz.data.agenten[0].zurueckgenommen, 'Vermerk an der Antwort');
    assert.ok(app.store.get(lauf.runId).data.zurueckgenommenAm, 'Vermerk am Lauf');

    // Ein zweites Mal ändert nichts und sagt das.
    const nochmal = await anfrage(base, 'POST', `/api/chats/${chatId}/rueckgaengig`, { runId: lauf.runId });
    assert.equal(nochmal.status, 200);
    assert.equal(nochmal.json.schonZurueck, true);
  });
});

test('„Rückgängig“ überschreibt keine spätere Änderung des Nutzers, und fremde Läufe gibt es nicht', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    terminZug(statist);
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Donnerstag 15 Uhr Zahnarzt' });
    const lauf = r.ereignisse.find((e) => e.name === 'agent' && e.data.zustand === 'fertig').data;
    const termin = app.store.all('event')[0];
    // Der Nutzer verschiebt den Termin selbst.
    const p = await anfrage(base, 'PATCH', `/api/events/${termin.id}`, { start: '2026-09-25T16:00', end: '2026-09-25T17:00' });
    assert.equal(p.status, 200, p.text);
    const u = await anfrage(base, 'POST', `/api/chats/${chatId}/rueckgaengig`, { runId: lauf.runId });
    assert.equal(u.status, 409);
    assert.equal(u.json.error.code, 'RUECKGAENGIG_NICHT_MOEGLICH');
    assert.match(u.json.error.message, /Zahnarzt.*seitdem geändert/);
    assert.ok(app.store.get(termin.id), 'der Termin steht noch');
    assert.equal(app.store.get(termin.id).data.start, '2026-09-25T16:00', 'mit der Uhrzeit des Nutzers');

    // Ein Lauf aus einem anderen Chat lässt sich hier nicht zurücknehmen.
    const anderer = (await anfrage(base, 'POST', '/api/chats', {})).json.record.id;
    const fremd = await anfrage(base, 'POST', `/api/chats/${anderer}/rueckgaengig`, { runId: lauf.runId });
    assert.equal(fremd.status, 404);
  });
});

test('„Rückgängig“ nimmt ein Projekt samt Aufgaben zurück und lässt die Notiz eines anderen Laufs stehen', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(
      antwort(
        B.start(),
        B.werkzeug(0, 'toolu_n', 'notiz_anlegen', { titel: 'Einkauf', text: 'Milch' }),
        B.werkzeug(1, 'toolu_p', 'projekt_anpassen', { name: 'Umzug', aufgaben: ['Kartons', 'Transporter'] }),
        B.ende('tool_use'),
      ),
      antwort(B.start(), B.text(0, 'Erledigt.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Umzug planen, Milch notieren' });
    const fertig = r.ereignisse.filter((e) => e.name === 'agent' && e.data.zustand === 'fertig').map((e) => e.data);
    const projekt = fertig.find((a) => a.werkzeug === 'projekt_anpassen');
    assert.deepEqual(projekt.wirkung.map((w) => [w.typ, w.aktion]), [['project', 'angelegt'], ['task', 'angelegt'], ['task', 'angelegt']]);
    assert.ok(projekt.wirkung[1].projectId, 'Aufgaben kennen ihr Projekt');
    const u = await anfrage(base, 'POST', `/api/chats/${chatId}/rueckgaengig`, { runId: projekt.runId });
    assert.equal(u.status, 200, u.text);
    assert.equal(app.store.all('project').filter((p) => p.data.name === 'Umzug').length, 0);
    assert.equal(app.store.all('task').filter((t) => ['Kartons', 'Transporter'].includes(t.data.title)).length, 0);
    assert.equal(app.store.all('note').filter((n) => n.data.title === 'Einkauf').length, 1, 'die Notiz eines anderen Laufs bleibt');
  });
});

/* ----------------------------------------------------- Neu antworten */

test('Neu antworten verwirft die letzte Antwort und fragt Claude noch einmal dasselbe', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(B.start(), B.text(0, 'Erste Fassung.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Schreib mir einen Satz' });
    const vorher = await nachrichten(base, chatId);
    const alteAntwort = vorher.find((m) => m.data.role === 'assistant');

    statist.weiter(antwort(B.start(), B.text(0, 'Zweite Fassung.'), B.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/neu-antworten`, {});
    assert.equal(r.status, 200);
    const n = arten(r.ereignisse);
    assert.deepEqual(n.slice(0, 2), ['verworfen', 'antwort']);
    assert.equal(n[n.length - 1], 'fertig');
    assert.deepEqual(r.ereignisse[0].data.ids, [alteAntwort.id]);
    assert.equal(textVon(r.ereignisse), 'Zweite Fassung.');

    const danach = await nachrichten(base, chatId);
    assert.deepEqual(danach.map((m) => m.data.role), ['user', 'assistant']);
    assert.equal(danach[1].data.content, 'Zweite Fassung.');
    assert.ok(app.store.get(alteAntwort.id, { includeDeleted: true }).deletedAt, 'im Papierkorb, nicht spurlos');
    // Claude bekam genau die Frage von damals, ohne die verworfene Antwort.
    const zweite = statist.stromAnfragen()[1].body;
    assert.equal(zweite.messages.length, 1);
    assert.equal(zweite.messages[0].content[1].text, 'Schreib mir einen Satz');
    assert.deepEqual(statist.stromAnfragen()[0].body.messages[0].content[0].text, zweite.messages[0].content[0].text,
      'derselbe Datumssatz wie damals -- der Anfang bleibt gleich');
  });
});

test('Neu antworten schließt eine offene Rückfrage ab, statt ihren Agenten ewig laufen zu lassen', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(B.start(),
      B.werkzeug(0, 'toolu_f', 'rueckfrage', { frage: 'Wie lange?', optionen: ['Kurz', 'Lang'], mehrfach: false }),
      B.ende('tool_use')));
    const r1 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Plan mir eine Reise' });
    const planung = r1.ereignisse.find((e) => e.name === 'agent' && e.data.rolle === 'planung').data;
    assert.equal(app.store.get(planung.runId).data.status, 'running');

    statist.weiter(antwort(B.start(), B.text(0, 'Neu.'), B.ende('end_turn')));
    const r2 = await strom(base, `/api/chats/${chatId}/neu-antworten`, {});
    assert.equal(app.store.get(planung.runId).data.status, 'done');
    const abgeschlossen = r2.ereignisse.find((e) => e.name === 'agent' && e.data.id === planung.id);
    assert.ok(abgeschlossen && abgeschlossen.data.zustand === 'fertig');
  });
});

test('Neu antworten und Bearbeiten werden vor dem Strom abgewiesen, wenn nichts da ist oder Claude fehlt', async () => {
  await mitClaude(async ({ base, chatId }) => {
    const leer = await strom(base, `/api/chats/${chatId}/neu-antworten`, {});
    assert.equal(leer.status, 400);
    assert.match(leer.json.error.message, /keine Frage/);
    const nichts = await strom(base, `/api/chats/${chatId}/messages/message_gibtsnicht/bearbeiten`, { inhalt: 'x' });
    assert.equal(nichts.status, 404);
  });
  await mitClaude(async ({ app, base, chatId }) => {
    app.store.create('message', { chatId, role: 'user', content: 'Hallo', ordinal: 0 });
    const r = await strom(base, `/api/chats/${chatId}/neu-antworten`, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'CLAUDE_NICHT_VERBUNDEN');
  }, { verbinden: false });
});

/* ------------------------------------------------------- Bearbeiten */

test('Bearbeiten ändert die eigene Nachricht, verwirft alles danach und lässt Claude neu antworten', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(B.start(), B.text(0, 'Antwort eins.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Erste Frage' });
    statist.weiter(antwort(B.start(), B.text(0, 'Antwort zwei.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Zweite Frage' });
    const vorher = await nachrichten(base, chatId);
    assert.equal(vorher.length, 4);
    assert.equal(app.store.get(chatId).data.title, 'Erste Frage');

    statist.weiter(antwort(B.start(), B.text(0, 'Neue Antwort.'), B.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/messages/${vorher[0].id}/bearbeiten`, { inhalt: 'Andere erste Frage' });
    assert.equal(r.status, 200);
    const n = arten(r.ereignisse);
    assert.deepEqual(n.slice(0, 3), ['verworfen', 'nutzer', 'antwort']);
    assert.deepEqual(r.ereignisse[0].data.ids, vorher.slice(1).map((m) => m.id));
    assert.equal(r.ereignisse[1].data.record.id, vorher[0].id, 'dieselbe Nachricht, geändert');
    assert.equal(r.ereignisse[1].data.record.data.content, 'Andere erste Frage');
    assert.ok(r.ereignisse[1].data.record.data.bearbeitetAm);

    const danach = await nachrichten(base, chatId);
    assert.deepEqual(danach.map((m) => [m.data.role, m.data.content]), [['user', 'Andere erste Frage'], ['assistant', 'Neue Antwort.']]);
    assert.equal(app.store.get(chatId).data.title, 'Andere erste Frage', 'der Chat heißt nach der neuen ersten Frage');
    // Claude bekam nur die geänderte Frage.
    const letzte = statist.stromAnfragen()[2].body;
    assert.equal(letzte.messages.length, 1);
    assert.equal(letzte.messages[0].content[1].text, 'Andere erste Frage');

    // Eine Antwort lässt sich nicht "bearbeiten".
    const falsch = await strom(base, `/api/chats/${chatId}/messages/${danach[1].id}/bearbeiten`, { inhalt: 'x' });
    assert.equal(falsch.status, 404);
  });
});

test('Bearbeiten mitten im Chat behält, was davor steht, und einen eigenen Titel', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    await anfrage(base, 'PATCH', `/api/chats/${chatId}`, { title: 'Mein Titel' });
    statist.weiter(antwort(B.start(), B.text(0, 'A1'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'F1' });
    statist.weiter(antwort(B.start(), B.text(0, 'A2'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'F2' });
    const vorher = await nachrichten(base, chatId);
    statist.weiter(antwort(B.start(), B.text(0, 'A2 neu'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages/${vorher[2].id}/bearbeiten`, { inhalt: 'F2 anders' });
    const danach = await nachrichten(base, chatId);
    assert.deepEqual(danach.map((m) => m.data.content), ['F1', 'A1', 'F2 anders', 'A2 neu']);
    assert.equal(app.store.get(chatId).data.title, 'Mein Titel');
    const letzte = statist.stromAnfragen()[2].body;
    assert.deepEqual(letzte.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(letzte.messages[2].content[1].text, 'F2 anders');
  });
});
