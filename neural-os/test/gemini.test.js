'use strict';

/**
 * Gemini-Unterbau: Anbieter, Schlüssel, Werkzeuge, Chat-Zug, Rückfrage,
 * Anbieterwechsel.
 *
 * Jeder Test läuft gegen die ECHTE Anwendung (createApp, echte Schleuse,
 * echter Tresor, echter HTTP-Server) und gegen den Statisten aus
 * test/gemini-statist.js, der die generateContent-Schnittstelle spricht.
 * Einen echten Google-Schlüssel gibt es hier nicht; kein Test verlässt
 * 127.0.0.1. Was Google selbst tut, beweist das nicht -- nur, was Neural OS
 * schickt und wie es mit der dokumentierten Antwortform umgeht.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { test, drain, tempHome } = require('./harness');
const { starten, B, antwort, httpFehler } = require('./gemini-statist');
const claudeStatist = require('./claude-statist');

const { createApp, seedIfEmpty } = require('../src/app');
const gemini = require('../src/models/providers/gemini');
const { SYSTEM_FEST } = require('../src/models/chat');

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
const letzteAnfrage = (statist) => statist.stromAnfragen()[statist.stromAnfragen().length - 1].body;
const letzterInhalt = (body) => body.contents[body.contents.length - 1];

/**
 * Anwendung + Gemini-Statist (+ auf Wunsch der Claude-Statist).
 * `verbinden` legt den Google-Schlüssel über die echte Route an.
 */
async function mitGemini(fn, { verbinden = true, claudeAuch = false, statistOpts = {} } = {}) {
  const { home, cleanup } = tempHome('nos-gemini');
  const statist = await starten(statistOpts);
  const claude = claudeAuch ? await claudeStatist.starten() : null;
  let app = null;
  try {
    app = await createApp({
      home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
      geminiBasis: statist.url, ...(claude ? { claudeBasis: claude.url } : {}),
    });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    if (verbinden) {
      const r = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: statist.schluessel });
      assert.equal(r.status, 200, r.text);
    }
    const chat = await anfrage(base, 'POST', '/api/chats', { title: 'Neuer Chat' });
    await fn({ app, base, home, statist, claude, chatId: chat.json && chat.json.record && chat.json.record.id });
  } finally {
    if (app) await app.close().catch(() => {});
    await statist.close();
    if (claude) await claude.close();
    cleanup();
  }
}

/* ------------------------------------------------------ Anfrageform */

test('Gemini: die Anfrage hat die Form von generateContent (Kopf, Modell, systemInstruction, functionDeclarations + googleSearch, thinkingConfig)', async () => {
  await mitGemini(async ({ app, base, statist, chatId }) => {
    // Nach dem ersten Verbinden ist Gemini der eingestellte Anbieter.
    const ki = await anfrage(base, 'GET', '/api/ki');
    assert.equal(ki.json.aktiv, 'gemini');
    assert.equal(ki.json.eingestellt, 'gemini');
    assert.equal(ki.json.verbunden, true);
    assert.equal(ki.json.anbieter.claude.schluesselVorhanden, false);
    assert.equal(app.config.ki.anbieter, 'gemini');

    statist.weiter(antwort(B.text('Hallo!'), B.ende()));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(r.status, 200);
    const [a] = statist.stromAnfragen();
    assert.equal(a.koepfe['x-goog-api-key'], statist.schluessel);
    assert.equal(a.koepfe['x-api-key'], undefined, 'kein Anthropic-Kopf');
    assert.equal(a.koepfe['anthropic-version'], undefined);
    assert.equal(a.pfad, '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    const b = a.body;
    assert.equal(b.model, undefined, 'das Modell steht im Pfad, nicht im Körper');
    assert.equal(b.stream, undefined);
    // Systemtext: fester Teil + Gedächtnis, als EINE systemInstruction.
    assert.equal(b.systemInstruction.parts.length, 1);
    assert.ok(b.systemInstruction.parts[0].text.startsWith(SYSTEM_FEST));
    assert.match(b.systemInstruction.parts[0].text, /Was du über den Nutzer weißt/);
    assert.match(b.systemInstruction.parts[0].text, /```prompt/, 'der Satz zu Prompt-Blöcken gilt für beide Anbieter');
    // Werkzeuge: eigene Deklarationen, dann die Google-Suche.
    assert.equal(b.tools.length, 2);
    const namen = b.tools[0].functionDeclarations.map((t) => t.name);
    assert.deepEqual(namen, ['rueckfrage', 'termin_anlegen', 'termine_lesen', 'termin_aendern', 'termin_loeschen',
      'notiz_anlegen', 'merken', 'projekt_anpassen', 'wissen_suchen', 'eintrag_lesen', 'agent_starten']);
    const roh = JSON.stringify(b.tools);
    assert.ok(!/"strict"|eager_input_streaming|additionalProperties|input_schema|"anyOf"/.test(roh), 'keine Anthropic-Eigenheiten in den Deklarationen');
    const aendern = b.tools[0].functionDeclarations.find((t) => t.name === 'termin_aendern');
    assert.equal(aendern.parameters.properties.erinnerung_minuten.nullable, true, 'anyOf-mit-null wird nullable');
    assert.equal(aendern.parameters.properties.erinnerung_minuten.type, 'integer');
    assert.equal(aendern.parameters.properties.erinnerung_minuten.enum, undefined, 'Ganzzahl-enum kennt Gemini nicht');
    assert.match(aendern.parameters.properties.erinnerung_minuten.description, /Erlaubt sind genau: 0, 5, 10/);
    assert.equal(aendern.parameters.properties.wiederholung.nullable, true);
    assert.equal(aendern.parameters.properties.wiederholung.type, 'object');
    assert.deepEqual(b.tools[1], { googleSearch: {} });
    assert.deepEqual(b.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
    assert.deepEqual(b.generationConfig, { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' } });
    assert.equal(b.temperature, undefined, 'keine Sampling-Parameter');
    // Der Verlauf: Datumssatz und Text in EINEM user-Content, kein cache_control.
    const letzte = letzterInhalt(b);
    assert.equal(letzte.role, 'user');
    assert.equal(letzte.parts.length, 2);
    assert.match(letzte.parts[0].text, /Heute ist .*\(\d{4}-\d{2}-\d{2}\)/);
    assert.equal(letzte.parts[1].text, 'Hi');
    assert.ok(!/cache_control/.test(JSON.stringify(b)), 'nichts von Anthropic im Körper');
    // Die Antwort trägt ihren Anbieter.
    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data;
    assert.deepEqual(fertig.record.data.model, { provider: 'gemini', model: 'gemini-3.8-flash' });
    // Verbrauch: gezählt, aber kostenlos.
    const z = app.gemini.zustand();
    assert.ok(z.verbrauch.anfragen >= 1);
    assert.equal(z.verbrauch.kostenUsd, 0);
    assert.equal(z.verbrauch.kostenlos, true);
    assert.ok(z.verbrauch.ausgabeTokens > 0);
  });
});

test('Gemini: Text und Gedankengang streamen – auch zerschnitten in Ereignissen und Umlauten; Signaturen gehen byte-gleich zurück', async () => {
  await mitGemini(async ({ app, base, statist, chatId }) => {
    const satz = 'Grüße aus München – schön, dass du da bist. Übrigens: 3 × 4 = 12.';
    statist.weiter(antwort(B.denken('Der Nutzer grüßt; ich grüße zurück.'), B.text(satz, { signatur: 'sig_text_äöü_1' }), B.ende()));
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
    assert.equal(rec.data.denken, 'Der Nutzer grüßt; ich grüße zurück.');
    assert.equal(rec.data.status, 'complete');
    assert.equal(rec.data.claude.anbieter, 'gemini');
    const bloecke = rec.data.claude.verlauf[0].content;
    assert.deepEqual(bloecke.map((b) => b.type), ['thinking', 'text']);
    assert.equal(bloecke[1].gemini.thoughtSignature, 'sig_text_äöü_1');

    // Zweiter Zug: die Modellantwort geht mit allen Teilen und Signaturen zurück.
    statist.weiter(antwort(B.text('Gern.'), B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Danke' });
    const zweite = letzteAnfrage(statist);
    assert.equal(zweite.contents.length, 3);
    assert.equal(zweite.contents[1].role, 'model');
    assert.deepEqual(zweite.contents[1].parts, [
      { text: 'Der Nutzer grüßt; ich grüße zurück.', thought: true },
      { text: satz, thoughtSignature: 'sig_text_äöü_1' },
    ]);
    assert.equal(zweite.contents[2].role, 'user');
    assert.equal(zweite.contents[2].parts[1].text, 'Danke');
  });
});

/* -------------------------------------------------------- Werkzeuge */

test('Gemini: termin_anlegen über functionCall legt wirklich einen Termin an – Lauf, Agenten-Ereignisse, EIN functionResponse-Content, Signatur unverändert', async () => {
  await mitGemini(async ({ app, base, statist, chatId }) => {
    const aktivitaet = [];
    app.bus.on('agent.aktivitaet', (e) => aktivitaet.push(e.payload));
    statist.weiter(
      antwort(
        B.denken('Ein Termin mit Datum: eintragen.'),
        B.text('Ich trage das ein.'),
        B.aufruf('termin_anlegen', { titel: 'Zahnarzt', start: '2026-09-29T10:00', ganztaegig: false, ort: 'Praxis Dr. Weiß' }, { signatur: 'sig_fc_1' }),
        B.aufruf('merken', { fakt: 'Geht zu Dr. Weiß.' }),
        B.ende(),
      ),
      antwort(B.text('Steht im Kalender: Dienstag, 10 Uhr.'), B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Dienstag um 10 Zahnarzt' });
    const termine = app.store.all('event');
    assert.equal(termine.length, 1, 'genau ein Termin');
    const t = termine[0].data;
    assert.equal(t.title, 'Zahnarzt');
    assert.equal(t.start, '2026-09-29T10:00');
    assert.equal(t.location, 'Praxis Dr. Weiß');
    assert.equal(t.source, 'auto');
    assert.equal(t.chatId, chatId);
    assert.ok(app.store.all('memory').some((m) => /Dr\. Weiß/.test(m.data.text)), 'der Fakt ist gemerkt');
    // Agenten-Ereignisse im Strom: Kalender läuft, fertig; Gedächtnis läuft, fertig.
    const ag = r.ereignisse.filter((e) => e.name === 'agent').map((e) => e.data);
    assert.deepEqual(ag.map((a) => [a.rolle, a.zustand]), [['kalender', 'laeuft'], ['kalender', 'fertig'], ['gedaechtnis', 'laeuft'], ['gedaechtnis', 'fertig']]);
    assert.match(ag[1].ergebnis, /Zahnarzt/);
    assert.ok(aktivitaet.some((a) => a.rolle === 'kalender' && a.zustand === 'fertig' && a.chatId === chatId));
    const lauf = app.store.get(ag[1].id);
    assert.equal(lauf.type, 'run');
    assert.equal(lauf.data.status, 'done');
    assert.ok(lauf.data.producedIds.includes(termine[0].id));
    // Zweite Anfrage: die Modellantwort mit Signatur, dann EIN user-Content mit BEIDEN Ergebnissen.
    const zweite = letzteAnfrage(statist);
    const modell = zweite.contents[zweite.contents.length - 2];
    assert.equal(modell.role, 'model');
    assert.deepEqual(modell.parts.map((p) => Object.keys(p).sort().join(',')), ['text,thought', 'text', 'functionCall,thoughtSignature', 'functionCall']);
    assert.equal(modell.parts[2].thoughtSignature, 'sig_fc_1');
    assert.deepEqual(modell.parts[2].functionCall, { name: 'termin_anlegen', args: { titel: 'Zahnarzt', start: '2026-09-29T10:00', ganztaegig: false, ort: 'Praxis Dr. Weiß' } });
    const letzte = letzterInhalt(zweite);
    assert.equal(letzte.role, 'user');
    assert.equal(letzte.parts.length, 2, 'alle Ergebnisse eines Zuges in EINEM Content');
    assert.equal(letzte.parts[0].functionResponse.name, 'termin_anlegen');
    assert.equal(letzte.parts[1].functionResponse.name, 'merken');
    assert.equal(typeof letzte.parts[0].functionResponse.response, 'object');
    assert.match(JSON.stringify(letzte.parts[0].functionResponse.response), /Zahnarzt/);
    assert.ok(!/tool_result|tool_use_id/.test(JSON.stringify(zweite)), 'nichts in Anthropic-Form');
    assert.equal(textVon(r.ereignisse), 'Ich trage das ein.\n\nSteht im Kalender: Dienstag, 10 Uhr.');
    const eintraege = app.history.list({}).items.filter((e) => e.id === termine[0].id);
    if (eintraege.length) assert.equal(eintraege[0].actor.kind, 'agent');
  });
});

test('Gemini: kaputte Werkzeugargumente werden NICHT ausgeführt, sondern als Fehler zurückgegeben', async () => {
  await mitGemini(async ({ app, base, statist, chatId }) => {
    statist.weiter(
      antwort(
        // args ist kein Objekt ...
        B.aufruf('termin_anlegen', '{"titel": "Zahnarzt"', { signatur: 'sig_kaputt' }),
        // ... ein Feld, das es nicht gibt ...
        B.aufruf('notiz_anlegen', { titel: 'X', text: 'Y', geheim: true }),
        // ... und ein Datum, das es nicht gibt.
        B.aufruf('termin_anlegen', { titel: 'Frist', start: '2026-02-30', ganztaegig: true }),
        B.ende(),
      ),
      antwort(B.text('Entschuldige, da ging etwas schief.'), B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Trag mir was ein' });
    assert.equal(app.store.all('event').length, 0, 'kein Termin aus kaputter Eingabe');
    assert.equal(app.store.all('note').filter((n) => n.data.source === 'auto').length, 0, 'keine Notiz aus ungültiger Eingabe');
    const letzte = letzterInhalt(letzteAnfrage(statist));
    assert.equal(letzte.parts.length, 3, 'alle drei Ergebnisse in EINEM Content');
    for (const p of letzte.parts) {
      const antw = p.functionResponse.response;
      assert.equal(antw.error, true, 'als Fehler markiert');
      assert.ok('INVALID_JSON' in antw, 'die Form aus der Vorlage');
      assert.ok(antw.grund, 'mit Grund');
    }
    assert.equal(letzte.parts[0].functionResponse.response.INVALID_JSON, '"{\\"titel\\": \\"Zahnarzt\\""', 'der Rohtext, unverfälscht');
    assert.match(letzte.parts[1].functionResponse.response.grund, /geheim/);
    assert.match(letzte.parts[2].functionResponse.response.grund, /kein gültiges Datum/);
    const fehler = r.ereignisse.filter((e) => e.name === 'agent' && e.data.zustand === 'fehler');
    assert.equal(fehler.length, 3);
    // Die Signatur des kaputten Aufrufs geht trotzdem zurück -- sonst 400 bei Google.
    const modell = letzteAnfrage(statist).contents.slice(-2)[0];
    assert.equal(modell.parts[0].thoughtSignature, 'sig_kaputt');
  });
});

/* --------------------------------------------------------- Rückfrage */

test('Gemini: eine Rückfrage hält den Zug an und läuft nach POST /rueckfrage in derselben Antwort weiter', async () => {
  await mitGemini(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(
      B.text('Gern plane ich das.'),
      B.aufruf('rueckfrage', { frage: 'Wie lange willst du bleiben?', optionen: ['Ein Wochenende', 'Eine Woche', 'Zwei Wochen'], mehrfach: false }, { signatur: 'sig_frage' }),
      B.ende(),
    ));
    const r1 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Plan mir eine Reise nach Rom' });
    const frage = r1.ereignisse.find((e) => e.name === 'rueckfrage');
    assert.ok(frage, 'Rückfrage-Ereignis');
    assert.equal(frage.data.frage, 'Wie lange willst du bleiben?');
    assert.deepEqual(frage.data.optionen, [{ label: 'Ein Wochenende' }, { label: 'Eine Woche' }, { label: 'Zwei Wochen' }]);
    const fertig1 = r1.ereignisse.find((e) => e.name === 'fertig').data;
    assert.equal(fertig1.stopReason, 'rueckfrage');
    assert.equal(statist.stromAnfragen().length, 1, 'der Zug wartet -- keine weitere Anfrage');
    const wartend = app.store.get(fertig1.record.id);
    assert.equal(wartend.data.rueckfrageOffen, true);

    statist.weiter(antwort(B.text('Eine Woche Rom: Tag 1 Kolosseum …'), B.ende()));
    const r2 = await strom(base, `/api/chats/${chatId}/rueckfrage`, { id: frage.data.id, antwort: 'Eine Woche' });
    const fertig2 = r2.ereignisse.find((e) => e.name === 'fertig').data;
    assert.equal(fertig2.stopReason, 'end_turn');
    assert.equal(fertig2.record.id, fertig1.record.id, 'dieselbe Antwort läuft weiter');
    const zweite = letzteAnfrage(statist);
    const modell = zweite.contents[zweite.contents.length - 2];
    assert.equal(modell.parts[1].thoughtSignature, 'sig_frage');
    const letzte = letzterInhalt(zweite);
    assert.equal(letzte.role, 'user');
    assert.equal(letzte.parts.length, 1);
    assert.equal(letzte.parts[0].functionResponse.name, 'rueckfrage');
    assert.match(JSON.stringify(letzte.parts[0].functionResponse.response), /Eine Woche/);
    const fertig = app.store.get(fertig1.record.id);
    assert.equal(fertig.data.content, 'Gern plane ich das.\n\nEine Woche Rom: Tag 1 Kolosseum …');
    assert.equal(fertig.data.rueckfragen[0].antwort, 'Eine Woche');
  });
});

/* ------------------------------------------------------------ Suche */

test('Gemini: Google-Suche wird als Recherche gezeigt, Fundstellen als Quellen', async () => {
  await mitGemini(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(
      B.suche(['Bahnstreik aktuell', 'GDL Streik September 2026'], [
        { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', titel: 'bahn.de' },
        { url: 'https://www.tagesschau.de/streik', titel: 'tagesschau.de' },
      ], { text: 'Der Streik endet am Freitag.' }),
      B.ende('STOP'),
    ));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Streikt die Bahn gerade?' });
    assert.equal(textVon(r.ereignisse), 'Der Streik endet am Freitag.');
    const quellen = r.ereignisse.filter((e) => e.name === 'quelle').map((e) => e.data);
    assert.deepEqual(quellen.map((q) => [q.titel, q.url]), [
      ['bahn.de', 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc'],
      ['tagesschau.de', 'https://www.tagesschau.de/streik'],
    ]);
    const ag = r.ereignisse.filter((e) => e.name === 'agent').map((e) => e.data);
    assert.equal(ag[0].rolle, 'recherche');
    assert.equal(ag[0].titel, 'Sucht: Bahnstreik aktuell · GDL Streik September 2026');
    assert.equal(ag[ag.length - 1].zustand, 'fertig');
    assert.equal(ag[ag.length - 1].ergebnis, '2 Treffer');
    const rec = app.store.get(r.ereignisse.find((e) => e.name === 'fertig').data.record.id);
    assert.equal(rec.data.stats.suchen, 2);
    assert.equal(rec.data.quellen.length, 2);
    // Im Verlauf steht nur der Text -- Gemini nimmt keine Suchblöcke zurück.
    assert.deepEqual(rec.data.claude.verlauf[0].content.map((b) => b.type), ['text']);
    assert.equal(app.gemini.zustand().verbrauch.suchen, 2);
  });
});

/* ------------------------------------------------ Grenzen und Fehler */

test('Gemini: MAX_TOKENS führt kein Werkzeug aus; SAFETY und ein blockierter Prompt sind eine ehrliche Ablehnung', async () => {
  await mitGemini(async ({ app, base, statist, chatId }) => {
    statist.weiter(antwort(
      B.text('Hier ist die lange Liste …'),
      B.aufruf('termin_anlegen', { titel: 'Halb', start: '2026-10-01', ganztaegig: true }),
      B.ende('MAX_TOKENS'),
    ));
    const r1 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Schreib viel' });
    assert.equal(app.store.all('event').length, 0, 'kein Termin bei abgeschnittener Antwort');
    assert.ok(r1.ereignisse.some((e) => e.name === 'hinweis' && /abgeschnitten/.test(e.data.satz)));
    assert.equal(r1.ereignisse[r1.ereignisse.length - 1].data.stopReason, 'max_tokens');

    statist.weiter(antwort(B.text('Dazu'), B.aufruf('notiz_anlegen', { titel: 'Sollte nie entstehen', text: 'x' }), B.ende('SAFETY')));
    const r2 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Etwas Heikles' });
    const fehler = r2.ereignisse.find((e) => e.name === 'fehler').data;
    assert.equal(fehler.code, 'GEMINI_ABGELEHNT');
    assert.match(fehler.satz, /Google hat die Antwort abgelehnt/);
    assert.equal(r2.ereignisse[r2.ereignisse.length - 1].data.stopReason, 'refusal');
    assert.equal(app.store.all('note').some((n) => n.data.title === 'Sollte nie entstehen'), false);

    statist.weiter(antwort(B.blockiert('PROHIBITED_CONTENT')));
    const r3 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Noch etwas' });
    assert.equal(r3.ereignisse.find((e) => e.name === 'fehler').data.code, 'GEMINI_ABGELEHNT');
    assert.equal(r3.ereignisse[r3.ereignisse.length - 1].data.stopReason, 'refusal');
  });
});

test('Gemini: 429 heißt Limit (deutsch, mit Hinweis auf morgen und Claude), 503 überlastet, Fehler im Strom behält den Teiltext', async () => {
  await mitGemini(async ({ app, base, statist, chatId }) => {
    statist.weiter(httpFehler(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.', { 'retry-after': '30' }));
    const r1 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'a' });
    const f1 = r1.ereignisse.find((e) => e.name === 'fehler').data;
    assert.equal(f1.code, 'GEMINI_LIMIT');
    assert.equal(f1.satz, 'Google-Limit erreicht — gleich nochmal (in etwa 30 s), spätestens morgen geht es kostenlos weiter. Oder Claude wählen.');
    assert.ok(!/quota|billing/i.test(f1.satz), 'kein englischer Rohtext');
    assert.equal(app.gemini.zustand().letzterFehler.code, 'GEMINI_LIMIT');

    statist.weiter(httpFehler(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'));
    const r2 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'b' });
    assert.equal(r2.ereignisse.find((e) => e.name === 'fehler').data.satz, 'Gemini ist gerade überlastet.');

    statist.weiter(antwort(B.text('Ich fange an und dann'), B.fehler(503, 'UNAVAILABLE')));
    const r3 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'c' });
    assert.equal(textVon(r3.ereignisse), 'Ich fange an und dann');
    assert.equal(r3.ereignisse.find((e) => e.name === 'fehler').data.code, 'GEMINI_UEBERLASTET');
    const rec = app.store.get(r3.ereignisse[r3.ereignisse.length - 1].data.record.id);
    assert.equal(rec.data.status, 'failed');
    assert.equal(rec.data.content, 'Ich fange an und dann');

    statist.weiter({ sse: [...B.text('Halb')], abbrechenNach: 2 });
    const r4 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'd' });
    assert.match(r4.ereignisse.find((e) => e.name === 'fehler').data.satz, /abgebrochen|Verbindung/);
  });
});

/* ---------------------------------------------------------- Schlüssel */

test('Gemini: falscher Schlüssel -> 400 "Der Google-Schlüssel stimmt nicht.", nichts gespeichert; richtiger liegt versiegelt im Tresor und kommt nie zurück', async () => {
  await mitGemini(async ({ app, base, home, statist }) => {
    const leer = await anfrage(base, 'GET', '/api/ki');
    assert.equal(leer.json.verbunden, false);
    assert.equal(leer.json.aktiv, 'gemini', 'ohne Schlüssel ist Gemini (kostenlos) die erste Wahl');
    assert.equal(leer.json.eingestellt, null);
    assert.equal(leer.json.grundCode, 'kein-schluessel');
    assert.match(leer.json.grund, /Keine KI verbunden/);

    const falsch = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: 'AIzaSyFalsch00000000000000000000000000' });
    assert.equal(falsch.status, 400);
    assert.equal(falsch.json.error.message, 'Der Google-Schlüssel stimmt nicht.');
    assert.equal(falsch.json.error.code, 'GEMINI_SCHLUESSEL_FALSCH');
    assert.equal(fs.existsSync(path.join(home, 'vault', 'gemini-schluessel.json')), false, 'nichts gespeichert');
    assert.equal(app.config.ki, undefined, 'kein Anbieter eingestellt, solange keiner verbunden ist');

    const kaputt = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: 'AIza mit leerzeichen 12345' });
    assert.equal(kaputt.status, 400);
    assert.equal(statist.anfragen.filter((a) => !a.stream).length, 1, 'ein ungültiges Format wird gar nicht erst geprüft');
    const unbekannt = await anfrage(base, 'POST', '/api/ki/openai/schluessel', { schluessel: statist.schluessel });
    assert.equal(unbekannt.status, 400);

    await app.vaultCrypto.initialise('ein-langes-gutes-geheimnis');
    const gut = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: statist.schluessel });
    assert.equal(gut.status, 200, gut.text);
    assert.equal(gut.json.verbunden, true);
    assert.equal(gut.json.aktiv, 'gemini');
    const probe = statist.anfragen.filter((a) => !a.stream).pop();
    assert.equal(probe.pfad, '/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(probe.body.generationConfig.maxOutputTokens, 8, 'der Probeaufruf ist klein');
    assert.equal(probe.body.tools, undefined);
    const roh = fs.readFileSync(path.join(home, 'vault', 'gemini-schluessel.json'), 'utf8');
    assert.ok(!roh.includes(statist.schluessel), 'der Schlüssel steht nicht im Klartext auf der Platte');
    assert.equal(JSON.parse(roh).versiegelt, true);
    assert.ok(!fs.readFileSync(path.join(home, 'config.json'), 'utf8').includes(statist.schluessel), 'nicht in config.json');
    for (const route of ['/api/ki', '/api/claude', '/api/config', '/api/status', '/api/models']) {
      const r = await anfrage(base, 'GET', route);
      assert.ok(!r.text.includes(statist.schluessel), `${route} darf den Schlüssel nicht zeigen`);
    }
    assert.ok(!fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8').includes(statist.schluessel), 'nicht im Prüfprotokoll');

    const m = await anfrage(base, 'PATCH', '/api/ki', { modell: 'gemini-3.5-flash-lite' });
    assert.equal(m.json.modell, 'gemini-3.5-flash-lite');
    assert.equal(app.config.gemini.modell, 'gemini-3.5-flash-lite');
    assert.equal((await anfrage(base, 'PATCH', '/api/ki', { modell: 'gpt-4' })).status, 400);
    assert.equal((await anfrage(base, 'PATCH', '/api/ki', { anbieter: 'openai' })).status, 400);

    const weg = await anfrage(base, 'DELETE', '/api/ki/gemini/schluessel');
    assert.equal(weg.json.geloescht, true);
    assert.equal(weg.json.anbieter.gemini.schluesselVorhanden, false);
  }, { verbinden: false });
});

test('Gemini: ein 401/403 mit "API key" ist ebenfalls "Der Google-Schlüssel stimmt nicht."', async () => {
  for (const status of [401, 403]) {
    await mitGemini(async ({ base }) => {
      const r = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: 'AIzaSyFalsch00000000000000000000000000' });
      assert.equal(r.status, 400, `${status}: HTTP ${r.status}`);
      assert.equal(r.json.error.message, 'Der Google-Schlüssel stimmt nicht.');
    }, { verbinden: false, statistOpts: { schluesselFehlerStatus: status } });
  }
  const { fehlerAusAntwort } = gemini;
  assert.equal(fehlerAusAntwort({ status: 403, statusName: 'PERMISSION_DENIED', text: 'Method doesNotExist is not allowed' }).code, 'GEMINI_KEINE_BERECHTIGUNG');
  assert.equal(fehlerAusAntwort({ status: 404, statusName: 'NOT_FOUND', text: 'models/x is not found' }).code, 'GEMINI_MODELL_UNBEKANNT');
  assert.equal(fehlerAusAntwort({ status: 400, statusName: 'INVALID_ARGUMENT', text: 'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).' }).code, 'GEMINI_ZU_GROSS');
  assert.equal(fehlerAusAntwort({ status: 400, statusName: 'INVALID_ARGUMENT', text: 'Invalid JSON payload' }).code, 'GEMINI_ANFRAGE_ABGELEHNT');
  assert.equal(fehlerAusAntwort({ status: 500, statusName: 'INTERNAL', text: 'x' }).code, 'GEMINI_FEHLER');
});

test('Gemini offline: ohne Freigabe verlässt nichts den Rechner – nicht einmal der Name generativelanguage.googleapis.com', async () => {
  const { home, cleanup } = tempHome('nos-gemini-offline');
  let app = null;
  try {
    app = await createApp({ home, port: 0, logLevel: 'error', harden: false });
    const versuche = [];
    app.bus.on('network.attempt', (e) => versuche.push(e.payload));
    assert.equal(app.config.network.mode, 'offline');
    await assert.rejects(
      () => app.gemini.schluesselSpeichern('AIzaSyIrgendein0000000000000000000000000'),
      (err) => {
        assert.equal(err.code, 'GEMINI_OFFLINE');
        assert.match(err.message, /offline/);
        return true;
      },
    );
    assert.equal(versuche.length, 0, 'keine einzige Verbindung versucht');
    assert.deepEqual(app.config.network.allowHosts, [], 'offline wird an der Freigabeliste nichts geändert');
    assert.equal(fs.existsSync(path.join(home, 'vault', 'gemini-schluessel.json')), false);
    await assert.rejects(
      () => gemini.senden({
        apiKey: 'AIzaX', modell: 'gemini-3.8-flash', gate: app.gate, scope: 'global',
        body: { contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
      }),
      (err) => err.code === 'GEMINI_OFFLINE',
    );
    assert.equal(versuche.filter((v) => v.allowed).length, 0);
    assert.ok(versuche.every((v) => v.allowed === false && v.host === 'generativelanguage.googleapis.com'));

    // Online mit strenger Liste: "Verbinden" trägt genau diesen Host ein.
    app.saveConfig({ network: { mode: 'online' } });
    assert.equal(app.gemini.zustand().netz.erlaubt, false);
    const { createGemini } = require('../src/models/ki');
    const geprueft = [];
    const dienst = createGemini({
      paths: app.paths, config: app.config, gate: app.gate, bus: app.bus, vaultCrypto: app.vaultCrypto,
      konfigSpeichern: (patch) => app.saveConfig(patch),
      anbieter: { ...gemini, probe: async (o) => { geprueft.push(o); return { ok: true }; } },
    });
    const z = await dienst.schluesselSpeichern('AIzaSyStellvertreter00000000000000000000');
    assert.equal(z.verbunden, true);
    assert.deepEqual(app.config.network.allowHosts, ['generativelanguage.googleapis.com']);
    assert.equal(geprueft.length, 1);
    assert.equal(geprueft[0].modell, 'gemini-3.8-flash');
    app.saveConfig({ network: { blockHosts: ['generativelanguage.googleapis.com'] } });
    assert.equal(dienst.zustand().grundCode, 'schleuse');
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});

/* ------------------------------------------------- Anbieterwechsel */

test('Anbieterwechsel per PATCH /api/ki wirkt im nächsten Zug – der Verlauf wird für den anderen Anbieter übersetzt', async () => {
  await mitGemini(async ({ app, base, statist, claude, chatId }) => {
    // Gemini zuerst verbunden (siehe mitGemini) -> Gemini ist eingestellt.
    // Claude dazu: die Einstellung bleibt.
    const c = await anfrage(base, 'POST', '/api/ki/claude/schluessel', { schluessel: claude.schluessel });
    assert.equal(c.status, 200, c.text);
    let ki = (await anfrage(base, 'GET', '/api/ki')).json;
    assert.equal(ki.aktiv, 'gemini');
    assert.equal(ki.anbieter.claude.verbunden, true);
    assert.equal(ki.anbieter.gemini.verbunden, true);

    statist.weiter(antwort(B.denken('Gedanke von Gemini.'), B.text('Antwort von Gemini.', { signatur: 'sig_g' }), B.ende()));
    const r1 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Eins' });
    assert.equal(r1.ereignisse.find((e) => e.name === 'fertig').data.record.data.model.provider, 'gemini');
    assert.equal(claude.stromAnfragen().length, 0);

    // Wechsel auf Claude: der nächste Zug geht an Anthropic, mit dem Verlauf ohne Gemini-Eigenes.
    const p = await anfrage(base, 'PATCH', '/api/ki', { anbieter: 'claude' });
    assert.equal(p.json.aktiv, 'claude');
    assert.equal(app.config.ki.anbieter, 'claude');
    claude.weiter(claudeStatist.antwort(claudeStatist.B.start(), claudeStatist.B.denken(0, 'Gedanke von Claude.', 'sig_c'), claudeStatist.B.text(1, 'Antwort von Claude.'), claudeStatist.B.ende('end_turn')));
    const r2 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Zwei' });
    assert.equal(r2.ereignisse.find((e) => e.name === 'fertig').data.record.data.model.provider, 'claude');
    assert.equal(statist.stromAnfragen().length, 1, 'Gemini bekam den zweiten Zug nicht');
    const anClaude = claude.stromAnfragen()[0].body;
    assert.equal(anClaude.model, 'claude-opus-5');
    assert.equal(anClaude.messages[1].role, 'assistant');
    assert.deepEqual(anClaude.messages[1].content, [{ type: 'text', text: 'Antwort von Gemini.' }], 'Geminis Denkblock und Signatur fallen weg, der Text bleibt');
    assert.ok(!/gemini|thoughtSignature/.test(JSON.stringify(anClaude.messages)));
    assert.equal(anClaude.messages[2].content[1].text, 'Zwei');
    const status = (await anfrage(base, 'GET', '/api/status')).json;
    assert.equal(status.anbieter.aktiv, 'claude');
    assert.equal(status.anbieter.name, 'Claude');

    // Und zurück: Claudes Denkblock geht nicht an Gemini, sein Text schon.
    await anfrage(base, 'PATCH', '/api/ki', { anbieter: 'gemini' });
    statist.weiter(antwort(B.text('Wieder Gemini.'), B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Drei' });
    const anGemini = letzteAnfrage(statist);
    const modelle = anGemini.contents.filter((x) => x.role === 'model');
    assert.equal(modelle.length, 2);
    assert.deepEqual(modelle[1].parts, [{ text: 'Antwort von Claude.' }]);
    assert.ok(!/signature|thinking/.test(JSON.stringify(anGemini.contents)));
    // Die alten Routen bleiben ein Alias auf den Claude-Dienst.
    const alt = await anfrage(base, 'GET', '/api/claude');
    assert.equal(alt.json.verbunden, true);
    assert.equal(alt.json.modell, 'claude-opus-5');
  }, { claudeAuch: true });
});

test('Gemini in der Registry: Werkzeugnamen mit Punkt, Signaturen reisen mit, keine Websuche', async () => {
  await mitGemini(async ({ app, statist }) => {
    statist.weiter(
      antwort(B.aufruf('notes.search', { query: 'Rom' }, { signatur: 'sig_a' }), B.ende()),
      antwort(B.text('Gefunden.'), B.ende()),
    );
    const tools = [{ name: 'notes.search', description: 'Notizen suchen', parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } }];
    const r1 = await app.registry.chat(null, {
      messages: [{ role: 'system', content: 'Du bist ein Agent.' }, { role: 'user', content: 'Such Rom' }],
      tools, scope: 'run:test',
    });
    assert.equal(r1.provider, 'gemini');
    assert.equal(r1.model, 'gemini-3.8-flash');
    assert.equal(r1.toolCalls[0].name, 'notes.search');
    assert.deepEqual(r1.toolCalls[0].arguments, { query: 'Rom' });
    const a1 = statist.stromAnfragen()[0].body;
    assert.deepEqual(a1.tools.map((t) => Object.keys(t)[0]), ['functionDeclarations'], 'keine googleSearch für Agenten');
    assert.equal(a1.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
    assert.equal(a1.systemInstruction.parts[0].text, 'Du bist ein Agent.');
    assert.equal(a1.generationConfig.thinkingConfig.includeThoughts, undefined);
    const r2 = await app.registry.chat(null, {
      messages: [
        { role: 'system', content: 'Du bist ein Agent.' },
        { role: 'user', content: 'Such Rom' },
        { role: 'assistant', content: '', toolCalls: r1.toolCalls },
        { role: 'tool', toolCallId: r1.toolCalls[0].id, name: 'notes.search', content: '1 Treffer' },
      ],
      tools, scope: 'run:test',
    });
    assert.equal(r2.content, 'Gefunden.');
    const a2 = statist.stromAnfragen()[1].body;
    assert.equal(a2.contents[1].role, 'model');
    assert.equal(a2.contents[1].parts[0].thoughtSignature, 'sig_a');
    assert.deepEqual(a2.contents[2].parts[0].functionResponse, { name: 'notes.search', response: { output: '1 Treffer' } });
    const snap = app.registry.list();
    assert.equal(snap.providers[0].id, 'gemini');
    assert.match(snap.providers[0].label, /kostenlos/);
  });
});

test('Gemini: ein Modell, das Suche und Werkzeuge nicht zusammen nimmt, bekommt die Anfrage ohne Suche – und der Nutzer erfährt es', async () => {
  await mitGemini(async ({ base, statist, chatId }) => {
    statist.weiter(
      httpFehler(400, 'INVALID_ARGUMENT', 'Multiple tools are supported only when they are all search tools.'),
      antwort(B.text('Ohne Suche geht es auch.'), B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hallo' });
    assert.equal(textVon(r.ereignisse), 'Ohne Suche geht es auch.');
    assert.ok(r.ereignisse.some((e) => e.name === 'hinweis' && /Ohne Internetsuche/.test(e.data.satz)));
    const [erste, zweite] = statist.stromAnfragen();
    assert.equal(erste.body.tools.length, 2);
    assert.deepEqual(zweite.body.tools.map((t) => Object.keys(t)[0]), ['functionDeclarations']);
  });
});

test('Gemini 2.5 nimmt thinkingBudget statt thinkingLevel; ein unbekanntes Modell wird abgelehnt', async () => {
  await mitGemini(async ({ base, statist, chatId }) => {
    await anfrage(base, 'PATCH', '/api/ki', { modell: 'gemini-2.5-flash' });
    statist.weiter(antwort(B.text('Hi'), B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi', effort: 'high' });
    const a = statist.stromAnfragen().pop();
    assert.equal(a.modell, 'gemini-2.5-flash');
    assert.deepEqual(a.body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 24576 });
    const g = gemini.anfrageBauen({ modell: 'gemini-2.5-flash', nachrichten: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], denken: false });
    assert.deepEqual(g.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  });
});

module.exports = { name: 'gemini', tests: drain() };
