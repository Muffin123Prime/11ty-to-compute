'use strict';

/**
 * Claude-Unterbau: Anbieter, Schlüssel, Werkzeuge, Chat-Zug, Rückfrage.
 *
 * Jeder Test läuft gegen die ECHTE Anwendung (createApp, echte Schleuse,
 * echter Tresor, echter HTTP-Server) und gegen den Statisten aus
 * test/claude-statist.js, der die Anthropic-Schnittstelle spricht. Einen
 * echten Schlüssel gibt es hier nicht; kein Test verlässt 127.0.0.1.
 *
 * Gemessen wird beides: was Neural OS an "Anthropic" schickt (der Statist
 * zeichnet jede Anfrage auf) und was es aus der Antwort macht.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { test, drain, tempHome } = require('./harness');
const { starten, B, antwort } = require('./claude-statist');

const { createApp, seedIfEmpty } = require('../src/app');
const anbieter = require('../src/models/providers/anthropic');
const { eingabePruefen, DEFINITIONEN } = require('../src/models/werkzeuge');
const { __internals: chatIntern } = require('../src/models/chat');

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

/** Einen Ereignisstrom lesen, bis der Server ihn schließt. */
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

/**
 * Anwendung + Statist. `verbinden` legt den Schlüssel über die echte Route an.
 */
async function mitClaude(fn, { verbinden = true, appOpts = {} } = {}) {
  const { home, cleanup } = tempHome('nos-claude');
  const statist = await starten();
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, claudeBasis: statist.url, ...appOpts });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    if (verbinden) {
      const r = await anfrage(base, 'POST', '/api/claude/schluessel', { schluessel: statist.schluessel });
      assert.equal(r.status, 200, r.text);
    }
    const chat = await anfrage(base, 'POST', '/api/chats', { title: 'Neuer Chat' });
    await fn({ app, base, home, statist, chatId: chat.json && chat.json.record && chat.json.record.id });
  } finally {
    if (app) await app.close().catch(() => {});
    await statist.close();
    cleanup();
  }
}

/* ------------------------------------------------------ Anfrageform */

test('Die Anfrage hat genau die Form der Vorlage (Modell, Ersatzmodell, Denken, Werkzeuge, Caching)', async () => {
  await mitClaude(async ({ base, statist, chatId }) => {
    statist.weiter(antwort(B.start(), B.text(0, 'Hallo!'), B.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(r.status, 200);
    const [a] = statist.stromAnfragen();
    const k = a.koepfe;
    assert.equal(k['anthropic-version'], '2023-06-01');
    assert.equal(k['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(k['x-api-key'], statist.schluessel);
    const b = a.body;
    assert.equal(b.model, 'claude-opus-5');
    assert.equal(b.stream, true);
    assert.equal(b.max_tokens, 64000);
    assert.equal(b.fallbacks, 'default');
    assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(b.output_config, { effort: 'medium' });
    assert.equal(b.temperature, undefined, 'keine Sampling-Parameter');
    // Werkzeuge: erst die eigenen, streng und eager, dann Suche und Abruf.
    const namen = b.tools.map((t) => t.name);
    assert.deepEqual(namen, ['rueckfrage', 'termin_anlegen', 'notiz_anlegen', 'merken', 'projekt_anpassen', 'web_search', 'web_fetch']);
    for (const t of b.tools.slice(0, 5)) {
      assert.equal(t.strict, true, `${t.name}: strict`);
      assert.equal(t.eager_input_streaming, true, `${t.name}: eager_input_streaming`);
      assert.equal(t.input_schema.additionalProperties, false);
      assert.ok(Array.isArray(t.input_schema.required));
    }
    assert.equal(b.tools[5].type, 'web_search_20260209');
    assert.equal(b.tools[6].type, 'web_fetch_20260209');
    assert.ok(!b.tools.some((t) => /code_execution/.test(t.type || '')), 'kein code_execution daneben');
    // System: fester Teil ohne Datum, dann Gedächtnis mit cache_control.
    assert.equal(b.system.length, 2);
    assert.equal(b.system[0].cache_control, undefined);
    assert.deepEqual(b.system[1].cache_control, { type: 'ephemeral' });
    assert.ok(!/20\d\d/.test(b.system[0].text), 'kein Datum im festen Systemtext');
    assert.match(b.system[0].text, /termin_anlegen/);
    assert.match(b.system[0].text, /rueckfrage/);
    // Das Datum steht in der Nutzernachricht.
    const letzte = b.messages[b.messages.length - 1];
    assert.equal(letzte.role, 'user');
    assert.match(letzte.content[0].text, /Heute ist .*\(\d{4}-\d{2}-\d{2}\)/);
    assert.equal(letzte.content[1].text, 'Hi');
    assert.deepEqual(letzte.content[1].cache_control, { type: 'ephemeral' }, 'Cache-Punkt am Ende des Verlaufs');
  });
});

test('Text kommt an – auch wenn der Strom mitten in Ereignissen und Umlauten zerschnitten wird', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    const satz = 'Grüße aus München – schön, dass du da bist. Übrigens: 3 × 4 = 12.';
    statist.weiter(antwort(B.start(), B.ping(), B.denken(0, 'Der Nutzer grüßt; ich grüße zurück.'), B.text(1, satz), B.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hallo' });
    const n = arten(r.ereignisse);
    assert.equal(n[0], 'nutzer');
    assert.equal(n[1], 'antwort');
    assert.equal(n[n.length - 1], 'fertig');
    assert.ok(n.includes('denken'));
    assert.equal(textVon(r.ereignisse), satz);
    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data;
    assert.equal(fertig.stopReason, 'end_turn');
    const rec = app.store.get(fertig.record.id);
    assert.equal(rec.data.content, satz);
    assert.equal(rec.data.status, 'complete');
    assert.equal(rec.data.denken, 'Der Nutzer grüßt; ich grüße zurück.');
    // Der Denkblock steht mit Signatur im Verlauf -- er geht beim nächsten Mal unverändert zurück.
    const blk = rec.data.claude.verlauf[0].content[0];
    assert.equal(blk.type, 'thinking');
    assert.equal(blk.signature, 'sig_statist');
    // Der Chat heißt nach der ersten Nachricht, der Verbrauch ist gezählt.
    assert.equal(app.store.get(chatId).data.title, 'Hallo');
    const z = app.claude.zustand();
    assert.equal(z.verbrauch.anfragen >= 1, true);
    assert.ok(z.verbrauch.kostenUsd > 0);
    assert.equal(z.verbrauch.geschaetzt, true);

    // Zweiter Zug: der erste geht byte-gleich wieder mit (Caching), Denkblock inklusive.
    statist.weiter(antwort(B.start(), B.text(0, 'Gern.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Danke' });
    const [erste, zweite] = statist.stromAnfragen();
    const ohneCache = (m) => JSON.parse(JSON.stringify(m, (k, v) => (k === 'cache_control' ? undefined : v)));
    assert.deepEqual(ohneCache(zweite.body.messages[0]), ohneCache(erste.body.messages[0]));
    assert.equal(zweite.body.messages[1].role, 'assistant');
    assert.equal(zweite.body.messages[1].content[0].type, 'thinking');
    assert.equal(zweite.body.messages[1].content[0].signature, 'sig_statist');
  });
});

/* -------------------------------------------------------- Werkzeuge */

test('termin_anlegen legt wirklich einen Termin an – mit Herkunft, Lauf und Agenten-Ereignissen', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    const aktivitaet = [];
    app.bus.on('agent.aktivitaet', (e) => aktivitaet.push(e.payload));
    statist.weiter(
      antwort(B.start(), B.text(0, 'Ich trage das ein.'), B.werkzeug(1, 'toolu_t1', 'termin_anlegen', {
        titel: 'Zahnarzt', start: '2026-09-29T10:00', ganztaegig: false, ort: 'Praxis Dr. Weiß',
      }), B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Steht im Kalender: Dienstag, 10 Uhr.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Dienstag um 10 Zahnarzt' });
    const termine = app.store.all('event');
    assert.equal(termine.length, 1, 'genau ein Termin');
    const t = termine[0].data;
    assert.equal(t.title, 'Zahnarzt');
    assert.equal(t.start, '2026-09-29T10:00');
    assert.equal(t.allDay, false);
    assert.equal(t.location, 'Praxis Dr. Weiß');
    assert.equal(t.source, 'auto');
    assert.equal(t.chatId, chatId);
    // Agenten-Ereignis im Chat-Strom: läuft, dann fertig.
    const ag = r.ereignisse.filter((e) => e.name === 'agent').map((e) => e.data);
    assert.deepEqual(ag.map((a) => a.zustand), ['laeuft', 'fertig']);
    assert.equal(ag[0].rolle, 'kalender');
    assert.match(ag[1].ergebnis, /Zahnarzt/);
    assert.ok(Number.isFinite(ag[1].dauerMs));
    // ... und derselbe Vorgang auf dem Bus (für die Kachel) und als Lauf-Satz.
    assert.ok(aktivitaet.some((a) => a.rolle === 'kalender' && a.zustand === 'fertig' && a.chatId === chatId));
    const lauf = app.store.get(ag[1].id);
    assert.equal(lauf.type, 'run');
    assert.equal(lauf.data.status, 'done');
    assert.equal(lauf.data.rolle, 'kalender');
    assert.equal(lauf.data.chatId, chatId);
    assert.ok(lauf.data.producedIds.includes(termine[0].id));
    // Das Ergebnis ging in EINER Nutzernachricht zurück, der Zug lief weiter.
    const zweite = statist.stromAnfragen()[1].body;
    const letzte = zweite.messages[zweite.messages.length - 1];
    assert.equal(letzte.role, 'user');
    assert.equal(letzte.content[0].type, 'tool_result');
    assert.equal(letzte.content[0].tool_use_id, 'toolu_t1');
    assert.equal(textVon(r.ereignisse), 'Ich trage das ein.\n\nSteht im Kalender: Dienstag, 10 Uhr.');
    // Der Änderungsverlauf kennt den Urheber: ein Agent, nicht der Nutzer.
    const eintraege = app.history.list({}).items.filter((e) => e.id === termine[0].id);
    if (eintraege.length) {
      assert.equal(eintraege[0].actor.kind, 'agent');
    }
  });
});

test('Eine kaputte Werkzeugeingabe wird NICHT ausgeführt, sondern als INVALID_JSON zurückgegeben', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(
      antwort(
        B.start(),
        // Abgeschnittenes JSON (so sieht eine eager gestreamte, kaputte Eingabe aus) ...
        B.werkzeug(0, 'toolu_kaputt', 'termin_anlegen', '{"titel": "Zahnarzt", "start": "2026-09-29T10:0'),
        // ... ein zusätzliches Feld, das es nicht gibt ...
        B.werkzeug(1, 'toolu_extra', 'notiz_anlegen', { titel: 'X', text: 'Y', geheim: true }),
        // ... und ein Datum, das es nicht gibt.
        B.werkzeug(2, 'toolu_datum', 'termin_anlegen', { titel: 'Frist', start: '2026-02-30', ganztaegig: true }),
        B.ende('tool_use'),
      ),
      antwort(B.start(), B.text(0, 'Entschuldige, da ging etwas schief.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Trag mir was ein' });
    assert.equal(app.store.all('event').length, 0, 'kein Termin aus kaputter Eingabe');
    assert.equal(app.store.all('note').filter((n) => n.data.source === 'auto').length, 0, 'keine Notiz aus ungültiger Eingabe');
    const zweite = statist.stromAnfragen()[1].body;
    const ergebnisse = zweite.messages[zweite.messages.length - 1].content;
    assert.equal(ergebnisse.length, 3, 'alle drei Ergebnisse in EINER Nachricht');
    for (const e of ergebnisse) {
      assert.equal(e.type, 'tool_result');
      assert.equal(e.is_error, true);
      const inhalt = JSON.parse(e.content);
      assert.ok('INVALID_JSON' in inhalt, 'die Form aus der Vorlage');
      assert.ok(inhalt.grund, 'mit Grund, damit Claude es besser machen kann');
    }
    assert.equal(JSON.parse(ergebnisse[0].content).INVALID_JSON, '{"titel": "Zahnarzt", "start": "2026-09-29T10:0', 'der Rohtext, unverfälscht');
    assert.match(JSON.parse(ergebnisse[1].content).grund, /geheim/);
    assert.match(JSON.parse(ergebnisse[2].content).grund, /kein gültiges Datum/);
    // Sichtbar als gescheiterte Tätigkeit, nicht verschwiegen.
    const fehler = r.ereignisse.filter((e) => e.name === 'agent' && e.data.zustand === 'fehler');
    assert.equal(fehler.length, 3);
  });
});

test('Die strenge Prüfung kennt jede Regel (Typen, Pflichtfelder, Formate, Grenzen)', () => {
  const ok = (n, e) => assert.equal(eingabePruefen(n, e).ok, true, `${n} ${JSON.stringify(e)}: ${eingabePruefen(n, e).fehler}`);
  const nein = (n, e, muster) => {
    const p = eingabePruefen(n, e);
    assert.equal(p.ok, false, `${n} ${JSON.stringify(e)} hätte abgelehnt werden müssen`);
    if (muster) assert.match(p.fehler, muster);
  };
  ok('termin_anlegen', { titel: 'Ferien', start: '2026-10-12', ende: '2026-10-23', ganztaegig: true });
  nein('termin_anlegen', { titel: 'X', start: '2026-10-12T09:00', ganztaegig: true }, /nur das Datum/);
  nein('termin_anlegen', { titel: 'X', start: '2026-10-12', ganztaegig: false }, /Uhrzeit/);
  nein('termin_anlegen', { titel: 'X', start: '2026-10-12T25:00', ganztaegig: false }, /kein gültiges Datum/);
  nein('termin_anlegen', { titel: 'X', start: '2026-10-12T10:00', ende: '2026-10-12T09:00', ganztaegig: false }, /vor/);
  nein('termin_anlegen', { titel: 'X', start: '2026-10-12' }, /Pflichtfeld „ganztaegig“/);
  nein('termin_anlegen', { titel: 7, start: '2026-10-12', ganztaegig: true }, /Text/);
  ok('rueckfrage', { frage: 'Wohin soll es gehen?', optionen: ['Meer', 'Berge'], mehrfach: false });
  nein('rueckfrage', { frage: 'Wohin?', optionen: ['Meer'], mehrfach: false }, /2 bis 6/);
  nein('rueckfrage', { frage: 'Wohin?', optionen: ['Meer', 'meer'], mehrfach: false }, /gleich/);
  ok('merken', { fakt: 'Geht in die 10b.' });
  nein('merken', { fakt: '' });
  ok('projekt_anpassen', { name: 'Referat', status: 'active', aufgaben: ['Gliederung'] });
  nein('projekt_anpassen', { name: 'Referat', status: 'fertig' }, /eines von/);
  nein('notiz_anlegen', { titel: 'x', text: 'y', schlagworte: ['zwei worte'] }, /Schlagwort/);
  nein('unbekannt', {}, /Unbekanntes Werkzeug/);
  // Die Definitionen sagen WANN.
  const termin = DEFINITIONEN.find((d) => d.name === 'termin_anlegen');
  assert.match(termin.description, /Benutze es, wenn der Nutzer einen Termin, eine Verabredung oder eine Frist mit Datum nennt/);
});

test('notiz_anlegen, merken und projekt_anpassen schreiben in den Tresor – das Gedächtnis steht danach im Systemtext', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(
      antwort(
        B.start(),
        B.werkzeug(0, 'toolu_n', 'notiz_anlegen', { titel: 'Einkaufsliste', text: '- Milch\n- Brot', schlagworte: ['einkauf'] }),
        B.werkzeug(1, 'toolu_m', 'merken', { fakt: 'Heißt Lena und geht in die 10b.' }),
        B.werkzeug(2, 'toolu_p', 'projekt_anpassen', { name: 'Referat Klimawandel', beschreibung: 'Bio, 15 Minuten', aufgaben: ['Quellen sammeln', 'Folien bauen'] }),
        B.ende('tool_use'),
      ),
      antwort(B.start(), B.text(0, 'Erledigt.'), B.ende('end_turn')),
      antwort(B.start(), B.text(0, 'Hallo Lena!'), B.ende('end_turn')),
    );
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Ich bin Lena aus der 10b …' });
    const notiz = app.store.all('note').find((n) => n.data.title === 'Einkaufsliste');
    assert.ok(notiz, 'Notiz angelegt');
    assert.equal(notiz.data.source, 'auto');
    assert.equal(notiz.data.chatId, chatId);
    assert.deepEqual(notiz.data.tags, ['einkauf']);
    const fakt = app.store.all('memory').find((m) => /Lena/.test(m.data.text));
    assert.ok(fakt, 'Fakt gemerkt');
    const projekt = app.store.all('project').find((p) => p.data.name === 'Referat Klimawandel');
    assert.ok(projekt, 'Projekt angelegt');
    const aufgaben = app.store.all('task').filter((t) => t.data.projectId === projekt.id);
    assert.deepEqual(aufgaben.map((t) => t.data.title).sort(), ['Folien bauen', 'Quellen sammeln']);
    // Rückgängig: die Notiz stammt von einem Agenten und lässt sich zurücknehmen.
    const eintrag = app.history.list({}).items.find((e) => e.id === notiz.id && e.op === 'create');
    assert.ok(eintrag, 'die Notiz steht im Änderungsverlauf');
    assert.equal(eintrag.actor.kind, 'agent');
    await app.history.undo(eintrag.seq);
    assert.equal(app.store.get(notiz.id), null, 'nach Rückgängig ist die Notiz weg');

    // Neuer Chat: das Gemerkte steht im zweiten Systemblock.
    const c2 = await anfrage(base, 'POST', '/api/chats', {});
    await strom(base, `/api/chats/${c2.json.record.id}/messages`, { inhalt: 'Wer bin ich?' });
    const letzte = statist.stromAnfragen().pop().body;
    assert.match(letzte.system[1].text, /Heißt Lena und geht in die 10b\./);
    assert.ok(!/Lena/.test(letzte.system[0].text), 'der feste Teil bleibt fest');
  });
});

/* --------------------------------------------------------- Rückfrage */

test('Eine Rückfrage hält den Zug an und läuft nach der Antwort in derselben Antwort weiter', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(
      B.start(),
      B.text(0, 'Gern plane ich das.'),
      B.werkzeug(1, 'toolu_frage', 'rueckfrage', { frage: 'Wie lange willst du bleiben?', optionen: ['Ein Wochenende', 'Eine Woche', 'Zwei Wochen'], mehrfach: false }),
      B.ende('tool_use'),
    ));
    const r1 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Plan mir eine Reise nach Rom' });
    const frage = r1.ereignisse.find((e) => e.name === 'rueckfrage');
    assert.ok(frage, 'Rückfrage-Ereignis');
    assert.deepEqual(frage.data, {
      type: 'rueckfrage', id: 'toolu_frage', frage: 'Wie lange willst du bleiben?',
      optionen: [{ label: 'Ein Wochenende' }, { label: 'Eine Woche' }, { label: 'Zwei Wochen' }], mehrfach: false,
    });
    const fertig1 = r1.ereignisse.find((e) => e.name === 'fertig').data;
    assert.equal(fertig1.stopReason, 'rueckfrage');
    assert.equal(statist.stromAnfragen().length, 1, 'der Zug wartet -- keine weitere Anfrage');
    const wartend = app.store.get(fertig1.record.id);
    assert.equal(wartend.data.rueckfrageOffen, true);
    assert.equal(wartend.data.rueckfragen[0].zustand, 'offen');
    const planung = r1.ereignisse.find((e) => e.name === 'agent' && e.data.rolle === 'planung').data;
    assert.equal(planung.zustand, 'laeuft');

    // Eine unbekannte Rückfrage ist ein 404, bevor ein Strom öffnet.
    const falsch = await strom(base, `/api/chats/${chatId}/rueckfrage`, { id: 'toolu_gibtsnicht', antwort: 'x' });
    assert.equal(falsch.status, 404);

    statist.weiter(antwort(B.start(), B.text(0, 'Eine Woche Rom: Tag 1 Kolosseum …'), B.ende('end_turn')));
    const r2 = await strom(base, `/api/chats/${chatId}/rueckfrage`, { id: 'toolu_frage', antwort: 'Eine Woche' });
    const fertig2 = r2.ereignisse.find((e) => e.name === 'fertig').data;
    assert.equal(fertig2.stopReason, 'end_turn');
    assert.equal(fertig2.record.id, fertig1.record.id, 'dieselbe Antwort läuft weiter');
    const zweite = statist.stromAnfragen()[1].body;
    const letzte = zweite.messages[zweite.messages.length - 1];
    assert.equal(letzte.role, 'user');
    assert.deepEqual(letzte.content.map((b) => b.type), ['tool_result']);
    assert.equal(letzte.content[0].tool_use_id, 'toolu_frage');
    assert.match(letzte.content[0].content, /Eine Woche/);
    const fertig = app.store.get(fertig1.record.id);
    assert.equal(fertig.data.content, 'Gern plane ich das.\n\nEine Woche Rom: Tag 1 Kolosseum …');
    assert.equal(fertig.data.rueckfrageOffen, false);
    assert.equal(fertig.data.rueckfragen[0].antwort, 'Eine Woche');
    const lauf = app.store.get(planung.id);
    assert.equal(lauf.data.status, 'done');

    // Zweimal antworten geht nicht.
    const nochmal = await strom(base, `/api/chats/${chatId}/rueckfrage`, { id: 'toolu_frage', antwort: 'Zwei Wochen' });
    assert.equal(nochmal.status, 409);
  });
});

test('Wer statt zu antworten weiterschreibt, übergeht die Rückfrage – der nächste Aufruf bleibt gültig', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(
      antwort(
        B.start(),
        B.werkzeug(0, 'toolu_n1', 'notiz_anlegen', { titel: 'Idee', text: 'Rom' }),
        B.werkzeug(1, 'toolu_f1', 'rueckfrage', { frage: 'Wann?', optionen: ['Sommer', 'Winter'], mehrfach: false }),
        B.ende('tool_use'),
      ),
      antwort(B.start(), B.text(0, 'Alles klar, dann Paris.'), B.ende('end_turn')),
    );
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Reise planen' });
    assert.ok(app.store.all('note').some((n) => n.data.title === 'Idee'), 'die andere Werkzeugarbeit desselben Zuges ist erledigt');
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Ach, lieber Paris' });
    const zweite = statist.stromAnfragen()[1].body;
    // Nach der Antwort mit den zwei Aufrufen kommt EINE Nutzernachricht:
    // beide Ergebnisse zuerst, dann Datum und neuer Text.
    const i = zweite.messages.findIndex((m) => m.role === 'assistant');
    const danach = zweite.messages[i + 1];
    assert.equal(danach.role, 'user');
    assert.deepEqual(danach.content.map((b) => b.type), ['tool_result', 'tool_result', 'text', 'text']);
    assert.deepEqual(danach.content.slice(0, 2).map((b) => b.tool_use_id).sort(), ['toolu_f1', 'toolu_n1']);
    assert.match(danach.content.find((b) => b.tool_use_id === 'toolu_f1').content, /nicht auf die Rückfrage geantwortet/);
    assert.equal(danach.content[3].text, 'Ach, lieber Paris');
    const erste = app.store.list('message', { filter: { chatId, role: 'assistant' }, sort: 'createdAt', order: 'asc' }).items[0];
    assert.equal(erste.data.rueckfragen[0].zustand, 'uebergangen');
  });
});

/* ------------------------------------------------ Suche, Pause, Stopps */

test('pause_turn wird ohne neue Nutzernachricht fortgesetzt; Suche und Quellen werden sichtbar', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    const zitat = {
      type: 'web_search_result_location', url: 'https://www.bahn.de/streik', title: 'Streik bei der Bahn',
      cited_text: 'Der Streik endet am Freitag.', encrypted_index: 'enc_1',
    };
    statist.weiter(
      antwort(B.start(), B.serverWerkzeug(0, 'srvtoolu_1', 'web_search', { query: 'Bahnstreik aktuell' }), B.ende('pause_turn')),
      antwort(
        B.start(),
        B.suchErgebnis(0, 'srvtoolu_1', [
          { type: 'web_search_result', url: 'https://www.bahn.de/streik', title: 'Streik bei der Bahn', encrypted_content: 'enc', page_age: '1 day' },
          { type: 'web_search_result', url: 'https://example.org/b', title: 'Anderes', encrypted_content: 'enc2' },
        ]),
        B.text(1, 'Der Streik endet am Freitag.', { zitate: [zitat] }),
        B.ende('end_turn', { server_tool_use: { web_search_requests: 1 } }),
      ),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Streikt die Bahn gerade?' });
    const [erste, zweite] = statist.stromAnfragen();
    assert.equal(zweite.body.messages.length, erste.body.messages.length + 1, 'genau die pausierte Antwort kam dazu, keine Nutzernachricht');
    const pausiert = zweite.body.messages[zweite.body.messages.length - 1];
    assert.equal(pausiert.role, 'assistant');
    assert.equal(pausiert.content[pausiert.content.length - 1].type, 'server_tool_use', 'der offene Suchaufruf steht am Ende');
    const quellen = r.ereignisse.filter((e) => e.name === 'quelle').map((e) => e.data);
    assert.deepEqual(quellen.map((q) => [q.titel, q.url]), [['Streik bei der Bahn', 'https://www.bahn.de/streik']]);
    const ag = r.ereignisse.filter((e) => e.name === 'agent').map((e) => e.data);
    assert.equal(ag[0].rolle, 'recherche');
    assert.equal(ag[0].titel, 'Sucht: Bahnstreik aktuell');
    assert.equal(ag[ag.length - 1].zustand, 'fertig');
    assert.equal(ag[ag.length - 1].ergebnis, '2 Treffer');
    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data;
    assert.equal(fertig.stopReason, 'end_turn');
    const rec = app.store.get(fertig.record.id);
    assert.equal(rec.data.stats.suchen, 1);
    // Die zusammengeführte Antwort geht beim nächsten Mal als EINE Nachricht zurück, Suche und Ergebnis gepaart.
    const verlauf = rec.data.claude.verlauf;
    assert.equal(verlauf.length, 1);
    assert.deepEqual(verlauf[0].content.map((b) => b.type), ['server_tool_use', 'web_search_tool_result', 'text']);
  });
});

test('Ein Suchfehler wirft nicht – er wird als gescheiterte Recherche gezeigt', async () => {
  await mitClaude(async ({ base, statist, chatId }) => {
    statist.weiter(antwort(
      B.start(),
      B.serverWerkzeug(0, 'srvtoolu_x', 'web_search', { query: 'x' }),
      B.suchErgebnis(1, 'srvtoolu_x', { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }),
      B.text(2, 'Ich konnte nicht weitersuchen.'),
      B.ende('end_turn'),
    ));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Such was' });
    const ag = r.ereignisse.filter((e) => e.name === 'agent').map((e) => e.data);
    assert.equal(ag[ag.length - 1].zustand, 'fehler');
    assert.equal(ag[ag.length - 1].ergebnis, 'Zu viele Suchen in einer Antwort');
    assert.equal(r.ereignisse[r.ereignisse.length - 1].data.stopReason, 'end_turn');
  });
});

test('refusal wird ehrlich gemeldet, und kein Werkzeug dieses Zuges läuft', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(
      B.start(),
      B.text(0, 'Dazu'),
      B.werkzeug(1, 'toolu_nein', 'notiz_anlegen', { titel: 'Sollte nie entstehen', text: 'x' }),
      B.ende('refusal'),
    ));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Etwas Heikles' });
    const fehler = r.ereignisse.find((e) => e.name === 'fehler');
    assert.ok(fehler, 'ein fehler-Ereignis');
    assert.equal(fehler.data.code, 'CLAUDE_ABGELEHNT');
    assert.match(fehler.data.satz, /abgelehnt/);
    assert.ok(!/refusal|cyber|category/i.test(fehler.data.satz), 'keine Rohkategorie in der Oberfläche');
    const fertig = r.ereignisse[r.ereignisse.length - 1];
    assert.equal(fertig.name, 'fertig');
    assert.equal(fertig.data.stopReason, 'refusal');
    assert.equal(app.store.all('note').some((n) => n.data.title === 'Sollte nie entstehen'), false);
    const rec = app.store.get(fertig.data.record.id);
    assert.equal(rec.data.status, 'failed');
    assert.equal(rec.data.claude.abgelehnt, true);
    // Der abgelehnte Zug geht nicht in den nächsten Verlauf.
    statist.weiter(antwort(B.start(), B.text(0, 'Ok.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Etwas anderes' });
    const naechste = statist.stromAnfragen().pop().body;
    assert.ok(naechste.messages.every((m) => m.role === 'user'), 'kein Rest der abgelehnten Antwort');
  });
});

test('max_tokens: kein halber Werkzeugaufruf wird ausgeführt, und die Oberfläche erfährt es', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(
      B.start(),
      B.text(0, 'Hier ist die lange Liste …'),
      B.werkzeug(1, 'toolu_halb', 'termin_anlegen', '{"titel": "Halb", "start": "2026-10-01", "ganztaegig": true}'),
      B.ende('max_tokens'),
    ));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Schreib viel' });
    assert.equal(app.store.all('event').length, 0);
    assert.ok(r.ereignisse.some((e) => e.name === 'hinweis' && /abgeschnitten/.test(e.data.satz)));
    assert.equal(r.ereignisse[r.ereignisse.length - 1].data.stopReason, 'max_tokens');
    // Der nächste Verlauf ist trotzdem gültig: der offene Aufruf bekommt ein ehrliches "nicht ausgeführt".
    statist.weiter(antwort(B.start(), B.text(0, 'Weiter …'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'weiter' });
    const b = statist.stromAnfragen().pop().body;
    const danach = b.messages[b.messages.findIndex((m) => m.role === 'assistant') + 1];
    assert.equal(danach.content[0].type, 'tool_result');
    assert.equal(danach.content[0].tool_use_id, 'toolu_halb');
    assert.equal(danach.content[0].is_error, true);
  });
});

test('Ein Fehler MITTEN im Strom: der Teiltext bleibt, der Satz ist deutsch', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(B.start(), B.text(0, 'Ich fange an und dann'), B.fehler('overloaded_error', 'Overloaded')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Erzähl was' });
    assert.equal(textVon(r.ereignisse), 'Ich fange an und dann');
    const fehler = r.ereignisse.find((e) => e.name === 'fehler').data;
    assert.equal(fehler.satz, 'Claude ist gerade überlastet.');
    assert.equal(fehler.code, 'CLAUDE_UEBERLASTET');
    const fertig = r.ereignisse[r.ereignisse.length - 1];
    assert.equal(fertig.name, 'fertig');
    const rec = app.store.get(fertig.data.record.id);
    assert.equal(rec.data.status, 'failed');
    assert.equal(rec.data.content, 'Ich fange an und dann');
    assert.equal(app.claude.zustand().letzterFehler.code, 'CLAUDE_UEBERLASTET');
  });
});

test('Eine abgerissene Verbindung und HTTP-Fehler werden zu deutschen Sätzen', async () => {
  await mitClaude(async ({ base, statist, chatId }) => {
    statist.weiter({ sse: [...B.start(), ...B.text(0, 'Halb')], abbrechenNach: 4 });
    const r1 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'a' });
    assert.match(r1.ereignisse.find((e) => e.name === 'fehler').data.satz, /abgebrochen|Verbindung/);
    statist.weiter({ status: 429, koepfe: { 'retry-after': '7' }, json: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } } });
    const r2 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'b' });
    assert.equal(r2.ereignisse.find((e) => e.name === 'fehler').data.satz, 'Kurz zu viele Anfragen — gleich nochmal (in etwa 7 s).');
    statist.weiter({ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    const r3 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'c' });
    assert.equal(r3.ereignisse.find((e) => e.name === 'fehler').data.satz, 'Claude ist gerade überlastet.');
  });
});

test('Ein Ersatzmodell übernimmt: Denk- und Werkzeugblöcke vor dem Wechsel gehen nicht zurück, laufen auch nicht', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(
      B.start(),
      B.denken(0, 'abgelehnt …'),
      B.werkzeug(1, 'toolu_vorher', 'notiz_anlegen', { titel: 'Vor dem Wechsel', text: 'x' }),
      B.ersatz(2),
      B.text(3, 'Antwort vom Ersatzmodell.'),
      B.ende('end_turn'),
    ));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'x' });
    assert.ok(r.ereignisse.some((e) => e.name === 'hinweis' && /Ersatzmodell/.test(e.data.satz)));
    assert.equal(app.store.all('note').some((n) => n.data.title === 'Vor dem Wechsel'), false);
    const rec = app.store.get(r.ereignisse[r.ereignisse.length - 1].data.record.id);
    assert.deepEqual(rec.data.claude.verlauf[0].content.map((b) => b.type), ['text']);
  });
});

/* ---------------------------------------------------------- Schlüssel */

test('Schlüssel: falscher wird abgelehnt und nicht gespeichert, richtiger liegt versiegelt im Tresor und kommt nie zurück', async () => {
  await mitClaude(async ({ app, base, home, statist }) => {
    const leer = await anfrage(base, 'GET', '/api/claude');
    assert.equal(leer.json.verbunden, false);
    assert.equal(leer.json.schluesselVorhanden, false);
    assert.match(leer.json.grund, /nicht verbunden/);

    // Ohne Schlüssel: das Senden scheitert VOR dem Strom, mit Satz, ohne Satz im Tresor.
    const chat = await anfrage(base, 'POST', '/api/chats', {});
    const vorher = app.store.count('message');
    const ohne = await strom(base, `/api/chats/${chat.json.record.id}/messages`, { inhalt: 'Hallo?' });
    assert.equal(ohne.status, 409);
    assert.equal(ohne.json.error.code, 'CLAUDE_NICHT_VERBUNDEN');
    assert.match(ohne.json.error.message, /Claude ist nicht verbunden/);
    assert.equal(app.store.count('message'), vorher, 'kein Scheinchat');

    const falsch = await anfrage(base, 'POST', '/api/claude/schluessel', { schluessel: 'sk-ant-falsch-0000000000000000' });
    assert.equal(falsch.status, 400);
    assert.equal(falsch.json.error.message, 'Der Claude-Schlüssel stimmt nicht.');
    assert.equal(fs.existsSync(path.join(home, 'vault', 'claude-schluessel.json')), false, 'nichts gespeichert');

    const kaputt = await anfrage(base, 'POST', '/api/claude/schluessel', { schluessel: 'sk-ant mit leerzeichen 12345' });
    assert.equal(kaputt.status, 400);
    assert.equal(statist.anfragen.filter((a) => a.body && a.body.stream !== true).length, 1, 'ein ungültiges Format wird gar nicht erst geprüft');

    // Verschlüsselung an, dann den richtigen Schlüssel: er liegt versiegelt.
    await app.vaultCrypto.initialise('ein-langes-gutes-geheimnis');
    const gut = await anfrage(base, 'POST', '/api/claude/schluessel', { schluessel: statist.schluessel });
    assert.equal(gut.status, 200, gut.text);
    assert.equal(gut.json.verbunden, true);
    const probe = statist.anfragen.filter((a) => a.body && a.body.stream !== true).pop().body;
    assert.equal(probe.max_tokens, 8, 'der Probeaufruf ist klein');
    assert.equal(probe.tools, undefined);
    const roh = fs.readFileSync(path.join(home, 'vault', 'claude-schluessel.json'), 'utf8');
    assert.ok(!roh.includes(statist.schluessel), 'der Schlüssel steht nicht im Klartext auf der Platte');
    assert.equal(JSON.parse(roh).versiegelt, true);
    const cfg = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
    assert.ok(!cfg.includes(statist.schluessel), 'nicht in config.json');

    for (const route of ['/api/claude', '/api/config', '/api/status', '/api/models']) {
      const r = await anfrage(base, 'GET', route);
      assert.ok(!r.text.includes(statist.schluessel), `${route} darf den Schlüssel nicht zeigen`);
    }
    const audit = fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8');
    assert.ok(!audit.includes(statist.schluessel), 'nicht im Prüfprotokoll');

    const m = await anfrage(base, 'PATCH', '/api/claude', { modell: 'claude-sonnet-5' });
    assert.equal(m.json.modell, 'claude-sonnet-5');
    const mf = await anfrage(base, 'PATCH', '/api/claude', { modell: 'gpt-4' });
    assert.equal(mf.status, 400);

    const weg = await anfrage(base, 'DELETE', '/api/claude/schluessel');
    assert.equal(weg.json.geloescht, true);
    assert.equal(weg.json.schluesselVorhanden, false);
  }, { verbinden: false });
});

test('Mit Sonnet: kein Ersatzmodell-Kopf, und die Werkzeuge bleiben gleich', async () => {
  await mitClaude(async ({ base, statist, chatId }) => {
    await anfrage(base, 'PATCH', '/api/claude', { modell: 'claude-sonnet-5' });
    statist.weiter(antwort(B.start({ model: 'claude-sonnet-5' }), B.text(0, 'Hi'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi', effort: 'high' });
    const a = statist.stromAnfragen().pop();
    assert.equal(a.body.model, 'claude-sonnet-5');
    assert.equal(a.body.fallbacks, undefined);
    assert.equal(a.koepfe['anthropic-beta'], undefined);
    assert.deepEqual(a.body.output_config, { effort: 'high' });
  });
});

test('Offline: ohne Freigabe verlässt nichts den Rechner – nicht einmal der Name api.anthropic.com', async () => {
  const { home, cleanup } = tempHome('nos-claude-offline');
  let app = null;
  try {
    app = await createApp({ home, port: 0, logLevel: 'error', harden: false });
    const versuche = [];
    app.bus.on('network.attempt', (e) => versuche.push(e.payload));
    assert.equal(app.config.network.mode, 'offline');
    await assert.rejects(
      () => app.claude.schluesselSpeichern('sk-ant-irgendein-schluessel-0123456789'),
      (err) => {
        assert.equal(err.code, 'CLAUDE_OFFLINE');
        assert.match(err.message, /offline/);
        return true;
      },
    );
    assert.equal(versuche.length, 0, 'keine einzige Verbindung versucht');
    assert.deepEqual(app.config.network.allowHosts, [], 'offline wird an der Freigabeliste nichts geändert');
    // Und die Schleuse selbst: api.anthropic.com ist zu.
    await assert.rejects(
      () => anbieter.senden({
        apiKey: 'sk-ant-x', gate: app.gate, scope: 'global',
        body: { model: 'claude-opus-5', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] },
      }),
      (err) => err.code === 'CLAUDE_OFFLINE',
    );
    assert.equal(versuche.filter((v) => v.allowed).length, 0);
    assert.ok(versuche.every((v) => v.allowed === false && v.host === 'api.anthropic.com'));
    // Online mit strenger Liste: Claude verbinden trägt genau diesen Host ein.
    app.saveConfig({ network: { mode: 'online' } });
    assert.equal(app.claude.zustand().netz.erlaubt, false);
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});

/* -------------------------------------------- der allgemeine Adapter */

test('Die Registry spricht Claude: Werkzeugnamen mit Punkt, Denkblöcke reisen mit, kein Websuche-Werkzeug', async () => {
  await mitClaude(async ({ app, statist }) => {
    statist.weiter(
      antwort(B.start(), B.denken(0, 'Ich suche Notizen.', 'sig_a'), B.werkzeug(1, 'toolu_a', 'notes__search', { query: 'Rom' }), B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Gefunden.'), B.ende('end_turn')),
    );
    const tools = [{ name: 'notes.search', description: 'Notizen suchen', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
    const r1 = await app.registry.chat(null, {
      messages: [{ role: 'system', content: 'Du bist ein Agent.' }, { role: 'user', content: 'Such Rom' }],
      tools, scope: 'run:test',
    });
    assert.equal(r1.provider, 'claude');
    assert.equal(r1.toolCalls[0].name, 'notes.search', 'Name zurückübersetzt');
    assert.deepEqual(r1.toolCalls[0].arguments, { query: 'Rom' });
    const a1 = statist.stromAnfragen()[0].body;
    assert.deepEqual(a1.tools.map((t) => t.name), ['notes__search']);
    assert.equal(a1.system[0].text, 'Du bist ein Agent.');
    // Zweiter Schritt, so wie der Agentenlauf ihn baut.
    const r2 = await app.registry.chat(null, {
      messages: [
        { role: 'system', content: 'Du bist ein Agent.' },
        { role: 'user', content: 'Such Rom' },
        { role: 'assistant', content: '', toolCalls: r1.toolCalls },
        { role: 'tool', toolCallId: 'toolu_a', name: 'notes.search', content: '1 Treffer' },
      ],
      tools, scope: 'run:test',
    });
    assert.equal(r2.content, 'Gefunden.');
    const a2 = statist.stromAnfragen()[1].body;
    const assistent = a2.messages[1];
    assert.equal(assistent.content[0].type, 'thinking');
    assert.equal(assistent.content[0].signature, 'sig_a');
    assert.equal(a2.messages[2].content[0].type, 'tool_result');
    assert.equal(a2.thinking.type, 'adaptive');
  });
});

test('Ohne Verbindung sagt die Registry "Claude ist nicht verbunden" mit Anleitung', async () => {
  await mitClaude(async ({ app }) => {
    assert.throws(() => app.registry.resolve(null), (err) => {
      assert.equal(err.code, 'NO_MODEL_AVAILABLE');
      assert.match(err.message, /Claude ist nicht verbunden/);
      assert.match(err.message, /console\.anthropic\.com/);
      return true;
    });
    const snap = await app.registry.refresh();
    assert.equal(snap.providers.length, 1);
    assert.equal(snap.providers[0].id, 'claude');
    assert.equal(snap.providers[0].available, false);
  }, { verbinden: false });
});

/* ---------------------------------------------------- Verlauf-Regeln */

test('verlaufHerrichten: jeder Aufruf bekommt sein Ergebnis, Waisen fallen weg, erste Nachricht vom Nutzer', () => {
  const v = chatIntern.verlaufHerrichten([
    { role: 'assistant', content: [{ type: 'text', text: 'verwaist' }] },
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't1', name: 'merken', input: {} }] },
    { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'tool_result', tool_use_id: 'gibtsnicht', content: 'x' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'nur gedacht', signature: 's2' }] },
    { role: 'user', content: [{ type: 'text', text: 'c' }] },
  ]);
  assert.equal(v[0].role, 'user');
  assert.deepEqual(v.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(v[2].content.map((b) => b.type), ['tool_result', 'text', 'text']);
  assert.equal(v[2].content[0].tool_use_id, 't1');
  assert.equal(v[2].content[0].is_error, true);
});

module.exports = { name: 'claude', tests: drain() };
