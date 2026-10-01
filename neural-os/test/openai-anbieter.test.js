'use strict';

/**
 * Weitere KI-Anbieter: Mistral, Groq, OpenRouter, OVHcloud (und OpenAI) --
 * alle über dieselbe OpenAI-kompatible Schnittstelle
 * (src/models/providers/openai.js).
 *
 * Anlass (01.10.2026), der Nutzer: "mehrere Keys … wenn es noch andere
 * Optionen gibt, wo ich einen API-Key kopieren kann für eine KI, dann nehme
 * ich auch jede andere … falls bei einem das Limit leer geht, wechselt er
 * zum nächsten". Geprüft wird gegen den Statisten (test/openai-statist.js):
 * Verbinden (Modellliste, Probe), ein Chat-Zug mit Werkzeug, die Erkennung
 * des Anbieters am Schlüssel, OVHcloud ganz ohne Schlüssel, das Ausweichen
 * von Gemini auf Mistral und die Fehlersätze.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, tempHome } = require('./harness');
const OA = require('./openai-statist');
const G = require('./gemini-statist');
const { createApp, seedIfEmpty } = require('../src/app');
const openai = require('../src/models/providers/openai');

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

const textVon = (liste) => liste.filter((e) => e.name === 'text').map((e) => e.data.delta).join('');
const hinweise = (liste) => liste.filter((e) => e.name === 'hinweis').map((e) => e.data.satz);
const fehlerVon = (liste) => liste.filter((e) => e.name === 'fehler').map((e) => e.data);

/** So nennt Mistral seine Modelle (GET /v1/models, gekürzt). */
const MISTRAL_MODELLE = [
  { id: 'mistral-medium-latest', object: 'model', capabilities: { completion_chat: true, function_calling: true, vision: true } },
  { id: 'mistral-embed', object: 'model', capabilities: { completion_chat: false } },
  { id: 'mistral-small-latest', object: 'model', capabilities: { completion_chat: true, function_calling: true, vision: true } },
  { id: 'codestral-latest', object: 'model', capabilities: { completion_chat: true } },
  { id: 'mistral-ocr-latest', object: 'model', capabilities: { completion_chat: false } },
  { id: 'ministral-8b-latest', object: 'model', capabilities: { completion_chat: true, function_calling: true, vision: false } },
];

/** So nennt OVHcloud seine Modelle (echt abgefragt am 01.10.2026, gekürzt). */
const OVH_MODELLE = [
  { id: 'bge-m3', object: 'model', max_completion_tokens: 0 },
  { id: 'Mistral-Small-3.2-24B-Instruct-2506', object: 'model', max_completion_tokens: 131072 },
  { id: 'whisper-large-v3', object: 'model', max_completion_tokens: 0 },
  { id: 'Qwen3Guard-Gen-8B', object: 'model', max_completion_tokens: 32768 },
  { id: 'gpt-oss-120b', object: 'model', max_completion_tokens: 131072 },
];

const GROQ_SCHLUESSEL = 'gsk_statistGroq0123456789abcdefABCDEF';

/**
 * Eine App mit Statisten. `anbieter`: {mistral: optionen, groq: …}; `gemini`: mit Gemini-Statist.
 */
/** So lehnt Mistral einen falschen Schlüssel ab (echt beobachtet am 01.10.2026). */
const MISTRAL_FALSCH = { status: 401, json: { detail: 'Invalid API Key' } };

async function mitApp(fn, { anbieter = { mistral: { modelle: MISTRAL_MODELLE, falsch: MISTRAL_FALSCH } }, gemini = false } = {}) {
  const { home, cleanup } = tempHome('nos-openai');
  const statisten = {};
  for (const [id, o] of Object.entries(anbieter)) statisten[id] = await OA.starten(o);
  const g = gemini ? await G.starten({ modelle: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'] }) : null;
  let app = null;
  try {
    app = await createApp({
      home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
      anbieterBasen: Object.fromEntries(Object.entries(statisten).map(([id, s]) => [id, s.url])),
      ...(g ? { geminiBasis: g.url } : {}),
    });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const chat = await anfrage(base, 'POST', '/api/chats', { title: 'Neuer Chat' });
    await fn({ app, base, home, s: statisten, g, chatId: chat.json.record.id });
  } finally {
    if (app) await app.close().catch(() => {});
    for (const s of Object.values(statisten)) await s.close();
    if (g) await g.close();
    cleanup();
  }
}

test('Mistral verbinden: erst die Modellliste mit Schlüssel (nur Chat-Modelle), dann ein kleiner Probeaufruf; der Schlüssel geht nie zurück', async () => {
  await mitApp(async ({ app, base, s }) => {
    const m = s.mistral;
    // Ein falscher Schlüssel: das sagt schon die Modellliste, ohne Probeaufruf.
    const falsch = await anfrage(base, 'POST', '/api/ki/mistral/schluessel', { schluessel: 'falscher-schluessel-0000000000000' });
    assert.equal(falsch.status, 400, falsch.text);
    assert.equal(falsch.json.error.code, 'MISTRAL_SCHLUESSEL_FALSCH');
    assert.equal(falsch.json.error.message, 'Der Mistral-Schlüssel stimmt nicht.');
    assert.equal(m.anfragen.length, 1);
    assert.equal(m.proben().length, 0);

    const r = await anfrage(base, 'POST', '/api/ki/mistral/schluessel', { schluessel: m.schluessel });
    assert.equal(r.status, 200, r.text);
    const [, liste, probe] = m.anfragen;
    assert.equal(liste.methode, 'GET');
    assert.equal(liste.pfad, '/v1/models');
    assert.equal(liste.koepfe.authorization, `Bearer ${m.schluessel}`);
    assert.equal(probe.pfad, '/v1/chat/completions');
    assert.equal(probe.stream, false);
    assert.equal(probe.body.model, 'mistral-small-latest', 'geprobt wird das bekannte gute zuerst');
    assert.equal(probe.body.max_tokens, 16);
    assert.equal(probe.body.tools, undefined, 'der Probeaufruf schickt keine Werkzeuge');

    const ki = (await anfrage(base, 'GET', '/api/ki')).json;
    const z = ki.anbieter.mistral;
    assert.equal(z.verbunden, true);
    assert.equal(z.name, 'Mistral');
    assert.equal(z.kostenlos, true);
    assert.equal(z.info.seite, 'console.mistral.ai → API Keys');
    assert.deepEqual(z.modelle.map((x) => x.id), ['mistral-small-latest', 'mistral-medium-latest', 'ministral-8b-latest'],
      'keine Einbettung, kein OCR, kein Code-Modell; die bekannten guten zuerst');
    assert.equal(z.zugaenge.length, 1);
    assert.equal(z.zugaenge[0].maske, 'stat…cdef');
    assert.doesNotMatch(JSON.stringify(ki), new RegExp(m.schluessel), 'der Schlüssel geht nie zurück');
    assert.equal(app.config.ki.anbieter, 'mistral', 'der erste verbundene Anbieter antwortet');
    assert.equal(ki.aktiv, 'mistral');
    assert.equal(ki.anbieter.mistral.netz.erlaubt, true);
  });
});

test('Ein Chat-Zug über Mistral: Systemtext, eigene Werkzeuge als functions; ein Werkzeugaufruf legt die Notiz an, das Ergebnis geht als tool-Nachricht zurück', async () => {
  await mitApp(async ({ app, base, s, chatId }) => {
    const m = s.mistral;
    assert.equal((await anfrage(base, 'POST', '/api/ki/mistral/schluessel', { schluessel: m.schluessel })).status, 200);
    m.weiter(
      OA.antwort(OA.B.text('Mache ich. '), OA.B.aufruf('notiz_anlegen', { titel: 'Einkauf', text: 'Milch und Brot' }, { id: 'call_Ab12XyZ789' }), OA.B.ende('tool_calls')),
      OA.antwort(OA.B.denken('Die Notiz ist angelegt, kurz bestätigen.'), OA.B.text('Die Notiz „Einkauf“ ist angelegt.'), OA.B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Schreib auf: Milch und Brot' });
    assert.deepEqual(fehlerVon(r.ereignisse), []);
    assert.equal(textVon(r.ereignisse), 'Mache ich. Die Notiz „Einkauf“ ist angelegt.');
    assert.ok(app.store.all('note').some((n) => n.data.title === 'Einkauf'), 'die Notiz ist da');

    const [erste, zweite] = m.stromAnfragen();
    const b = erste.body;
    assert.equal(b.model, 'mistral-small-latest');
    assert.equal(b.stream, true);
    assert.equal(b.messages[0].role, 'system');
    assert.match(b.messages[0].content, /\S/);
    const letzte = b.messages[b.messages.length - 1];
    assert.equal(letzte.role, 'user');
    assert.match(letzte.content, /Schreib auf: Milch und Brot/);
    assert.equal(b.tool_choice, 'auto');
    const namen = b.tools.map((t) => t.function.name);
    assert.ok(namen.includes('notiz_anlegen') && namen.includes('termin_anlegen'), JSON.stringify(namen));
    assert.ok(b.tools.every((t) => t.type === 'function' && t.function.parameters && t.function.parameters.type === 'object'));
    assert.ok(!/"strict"|eager_input_streaming|input_schema|cache_control/.test(JSON.stringify(b)), 'nichts von Anthropic im Körper');
    assert.equal(b.max_tokens, 8192);

    // Die zweite Runde: der Aufruf und sein Ergebnis, mit kurzer, gleicher ID (Mistral verlangt 9 Zeichen a-z0-9).
    const msgs = zweite.body.messages;
    const i = msgs.findIndex((x) => x.role === 'assistant' && Array.isArray(x.tool_calls));
    assert.ok(i > 0, JSON.stringify(msgs));
    const call = msgs[i].tool_calls[0];
    assert.match(call.id, /^[a-z0-9]{9}$/);
    assert.equal(call.id, openai.kurzeId('call_Ab12XyZ789'));
    assert.equal(call.function.name, 'notiz_anlegen');
    assert.deepEqual(JSON.parse(call.function.arguments), { titel: 'Einkauf', text: 'Milch und Brot' });
    assert.equal(msgs[i].content, 'Mache ich. ');
    assert.equal(msgs[i + 1].role, 'tool');
    assert.equal(msgs[i + 1].tool_call_id, call.id);
    assert.match(msgs[i + 1].content, /\S/);

    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data.record;
    assert.equal(fertig.data.model.provider, 'mistral', 'die Antwort sagt, wer geantwortet hat');

    // Der nächste Zug: das eigene Denken von vorhin geht nicht mit (es hat keine Signatur).
    m.weiter(OA.antwort(OA.B.text('Gern.'), OA.B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Danke' });
    const dritte = m.stromAnfragen()[2].body;
    assert.ok(!JSON.stringify(dritte).includes('kurz bestätigen'), 'kein Denktext im Verlauf');
    assert.ok(JSON.stringify(dritte.messages).includes('Die Notiz „Einkauf“ ist angelegt.'));
  });
});

test('Der Schlüssel verrät seinen Anbieter: „gsk_“ im Google-Feld wird Groq; im einen Feld ohne Vorsilbe Mistral; einen unbekannten nimmt Neural OS nicht', async () => {
  await mitApp(async ({ app, base, s }) => {
    const groq = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: GROQ_SCHLUESSEL });
    assert.equal(groq.status, 200, groq.text);
    assert.equal(groq.json.umgeleitet, 'groq');
    assert.equal(groq.json.anbieter.groq.verbunden, true);
    assert.deepEqual(groq.json.anbieter.groq.modelle.map((x) => x.id), ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
      'ohne Spracherkennung und Wächtermodelle');
    assert.equal(s.groq.anfragen[0].koepfe.authorization, `Bearer ${GROQ_SCHLUESSEL}`);
    assert.equal(groq.json.anbieter.gemini.schluesselVorhanden, false, 'beim Google-Feld ist nichts gespeichert');

    const auto = await anfrage(base, 'POST', '/api/ki/auto/schluessel', { schluessel: s.mistral.schluessel });
    assert.equal(auto.status, 200, auto.text);
    assert.equal(auto.json.umgeleitet, 'mistral');
    assert.equal(auto.json.anbieter.mistral.verbunden, true);
    assert.equal(app.config.ki.anbieter, 'groq', 'wer zuerst verbunden war, bleibt eingestellt');

    const unbekannt = await anfrage(base, 'POST', '/api/ki/auto/schluessel', { schluessel: 'unbekannt-0123456789abcdefghij' });
    assert.equal(unbekannt.status, 400);
    assert.equal(unbekannt.json.error.code, 'KI_SCHLUESSEL_UNBEKANNT');
    assert.match(unbekannt.json.error.message, /^Diesen Schlüssel erkenne ich nicht/);
    const leer = await anfrage(base, 'POST', '/api/ki/auto/schluessel', { schluessel: '   ' });
    assert.equal(leer.status, 400);
    assert.equal(leer.json.error.message, 'Bitte den Schlüssel einfügen.');
    const kurz = await anfrage(base, 'POST', '/api/ki/auto/schluessel', { schluessel: 'abc def' });
    assert.equal(kurz.status, 400);
    assert.match(kurz.json.error.message, /^Das sieht nicht nach einem KI-Schlüssel aus/);
    const falschesFeld = await anfrage(base, 'POST', '/api/ki/groq/schluessel', { schluessel: 'nicht-von-groq-0123456789abcdef' });
    assert.equal(falschesFeld.status, 400);
    assert.equal(falschesFeld.json.error.message, 'Ein Groq-Schlüssel beginnt mit „gsk_“.');
  }, {
    anbieter: {
      mistral: { modelle: MISTRAL_MODELLE, falsch: MISTRAL_FALSCH },
      groq: { schluessel: GROQ_SCHLUESSEL, modelle: ['openai/gpt-oss-120b', 'whisper-large-v3', 'meta-llama/llama-guard-4-12b', 'qwen/qwen3.8-27b'] },
    },
  });
});

test('OVHcloud ganz ohne Schlüssel: Einschalten schickt keinen Schlüssel mit; ist ein Modell am Limit, antwortet das nächste', async () => {
  await mitApp(async ({ base, s, chatId }) => {
    const o = s.ovh;
    const r = await anfrage(base, 'POST', '/api/ki/ovh/schluessel', {});
    assert.equal(r.status, 200, r.text);
    const z = r.json.anbieter.ovh;
    assert.equal(z.verbunden, true);
    assert.equal(z.ohneSchluessel, true);
    assert.equal(z.zugaenge[0].maske, 'ohne Schlüssel');
    assert.deepEqual(z.modelle.map((x) => x.id), ['Mistral-Small-3.2-24B-Instruct-2506', 'gpt-oss-120b'], 'nur Modelle, die Text schreiben, ohne Wächter');

    o.weiter(OA.antwort(OA.B.text('Hallo von OVHcloud.'), OA.B.ende()));
    const a = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(a.ereignisse), 'Hallo von OVHcloud.');

    // 2 Anfragen je Minute und Modell -- so sieht das Limit echt aus (01.10.2026).
    o.weiter(
      { status: 429, json: { message: 'API rate limit exceeded', request_id: 'e58c0c7c' }, koepfe: { 'ratelimit-reset': '55', 'ratelimit-remaining': '0' } },
      OA.antwort(OA.B.text('Hier das zweite Modell.'), OA.B.ende()),
    );
    const b = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Noch was' });
    assert.equal(textVon(b.ereignisse), 'Hier das zweite Modell.', JSON.stringify(fehlerVon(b.ereignisse)));
    assert.ok(hinweise(b.ereignisse).includes('Mistral Small 3.2 ist gerade am Limit – es antwortet GPT-OSS 120B.'), JSON.stringify(hinweise(b.ereignisse)));
    assert.deepEqual(o.stromAnfragen().map((x) => x.body.model), ['Mistral-Small-3.2-24B-Instruct-2506', 'Mistral-Small-3.2-24B-Instruct-2506', 'gpt-oss-120b']);
    assert.ok(o.anfragen.every((x) => !x.koepfe.authorization), 'nie ein Schlüssel im Kopf');
  }, { anbieter: { ovh: { ohneSchluessel: true, oeffentlich: true, modelle: OVH_MODELLE } } });
});

test('Gemini am Tageslimit: es antwortet Mistral (mit einem Satz dazu), ohne Geminis Denktext; der nächste Zug fragt Gemini gar nicht erst', async () => {
  await mitApp(async ({ app, base, s, g, chatId }) => {
    assert.equal((await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: g.schluessel })).status, 200);
    assert.equal((await anfrage(base, 'POST', '/api/ki/mistral/schluessel', { schluessel: s.mistral.schluessel })).status, 200);
    assert.equal(app.config.ki.anbieter, 'gemini', 'Gemini bleibt eingestellt');

    g.weiter(G.antwort(G.B.denken('Geheimer Gedanke von Gemini.'), G.B.text('Hallo von Gemini.'), G.B.ende()));
    const eins = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(eins.ereignisse), 'Hallo von Gemini.');

    const tag = () => ({
      status: 429,
      json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.', details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaValue: '250' }] },
      ] } },
    });
    // Je Modell zwei Versuche (mit und ohne Suche), drei Modelle.
    g.weiter(tag(), tag(), tag(), tag(), tag(), tag());
    s.mistral.weiter(OA.antwort(OA.B.text('Hier antwortet Mistral.'), OA.B.ende()));
    const zwei = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Noch was' });
    assert.equal(textVon(zwei.ereignisse), 'Hier antwortet Mistral.', JSON.stringify(fehlerVon(zwei.ereignisse)));
    assert.deepEqual(hinweise(zwei.ereignisse), ['Gemini ist gerade am Limit – es antwortet Mistral.'],
      'genau ein Satz -- nicht einer je Gemini-Modell, das auch am Limit war');
    assert.equal(zwei.ereignisse.find((e) => e.name === 'fertig').data.record.data.model.provider, 'mistral');
    const anMistral = s.mistral.stromAnfragen()[0].body;
    assert.ok(!JSON.stringify(anMistral).includes('Geheimer Gedanke'), 'Geminis Denktext geht nicht an Mistral');
    const verlauf = anMistral.messages.filter((x) => x.role !== 'system');
    assert.deepEqual(verlauf.map((x) => x.role), ['user', 'assistant', 'user']);
    assert.equal(verlauf[1].content, 'Hallo von Gemini.');

    const vorher = g.stromAnfragen().length;
    s.mistral.weiter(OA.antwort(OA.B.text('Wieder Mistral.'), OA.B.ende()));
    const drei = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Und jetzt?' });
    assert.equal(textVon(drei.ereignisse), 'Wieder Mistral.');
    assert.equal(g.stromAnfragen().length, vorher, 'ein volles Tageslimit wird nicht erst vergeblich gefragt');
    assert.ok(hinweise(drei.ereignisse).includes('Gemini ist gerade am Limit – es antwortet Mistral.'), JSON.stringify(hinweise(drei.ereignisse)));
    const ki = (await anfrage(base, 'GET', '/api/ki')).json;
    assert.ok(ki.anbieter.gemini.zugaenge.every((x) => x.status === 'pause'));
    assert.ok(ki.anbieter.gemini.zugaenge[0].bis, 'bis wann, steht dabei');
  }, { gemini: true });
});

test('Lehnt Mistral die Beschreibung der Werkzeuge ab (400), geht die Frage einmal ohne Werkzeuge – mit einem ehrlichen Satz', async () => {
  await mitApp(async ({ base, s, chatId }) => {
    const m = s.mistral;
    assert.equal((await anfrage(base, 'POST', '/api/ki/mistral/schluessel', { schluessel: m.schluessel })).status, 200);
    m.weiter(
      { status: 400, json: { object: 'error', message: 'Invalid tool schema: function parameters must be a JSON object', type: 'invalid_request_error', param: null, code: null } },
      OA.antwort(OA.B.text('Antwort ohne Werkzeuge.'), OA.B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(r.ereignisse), 'Antwort ohne Werkzeuge.', JSON.stringify(fehlerVon(r.ereignisse)));
    assert.ok(hinweise(r.ereignisse).some((h) => /^Ohne Werkzeuge: Mistral hat ihre Beschreibung nicht angenommen/.test(h)), JSON.stringify(hinweise(r.ereignisse)));
    const [mit, ohne] = m.stromAnfragen();
    assert.ok(Array.isArray(mit.body.tools));
    assert.equal(ohne.body.tools, undefined);
    assert.equal(ohne.body.tool_choice, undefined);
  });
});

test('Denken in <think>-Klammern (Qwen bei Groq, offene Modelle) ist Denken, nicht die Antwort – auch über Stückgrenzen', async () => {
  await mitApp(async ({ base, s, chatId }) => {
    const m = s.mistral;
    assert.equal((await anfrage(base, 'POST', '/api/ki/mistral/schluessel', { schluessel: m.schluessel })).status, 200);
    const st = (content) => OA.chunk({ role: 'assistant', content });
    m.weiter(OA.antwort([st('<thi'), st('nk>Ich über'), st('lege kurz.</th'), st('ink>Die Antwort ist 42'), st(' – und a <'), st(' b.')], OA.B.ende()));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Frage' });
    assert.equal(textVon(r.ereignisse), 'Die Antwort ist 42 – und a < b.');
    assert.equal(r.ereignisse.filter((e) => e.name === 'denken').map((e) => e.data.delta).join(''), 'Ich überlege kurz.');
    m.weiter(OA.antwort(OA.B.text('Ok.'), OA.B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Und?' });
    const verlauf = JSON.stringify(m.stromAnfragen()[1].body.messages);
    assert.ok(!verlauf.includes('überlege') && !verlauf.includes('<think>'), 'das Denken geht nicht zurück');
    assert.ok(verlauf.includes('Die Antwort ist 42 – und a < b.'));
  });
});

test('OpenAI bekommt die Länge als max_completion_tokens; sagt ein Anbieter, er kenne den Namen nicht, geht es mit dem anderen', () => {
  const oai = openai.erstellen('openai');
  const b1 = oai.anfrageBauen({ modell: 'gpt-6-luna', nachrichten: [{ role: 'user', content: 'Hi' }] }).body;
  assert.equal(b1.max_completion_tokens, 8192);
  assert.equal(b1.max_tokens, undefined);
  const mistral = openai.erstellen('mistral');
  const b2 = mistral.anfrageBauen({ modell: 'mistral-small-latest', nachrichten: [{ role: 'user', content: 'Hi' }] }).body;
  assert.equal(b2.max_tokens, 8192);
  const { heilen } = mistral.__internals;
  const h1 = heilen(b2, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", []);
  assert.equal(h1.art, 'laengenname');
  assert.equal(h1.body.max_completion_tokens, 8192);
  assert.equal('max_tokens' in h1.body, false);
  const h2 = heilen(b1, 'Unrecognized request argument supplied: max_completion_tokens', []);
  assert.equal(h2.art, 'laengenname');
  assert.equal(h2.body.max_tokens, 8192);
  const h3 = heilen(b2, 'max_tokens is too large: 8192. This model supports at most 4096 completion tokens.', []);
  assert.equal(h3.art, 'laenge');
  assert.equal(h3.body.max_tokens, 2048);
});

test('Bausteine: Erkennung am Schlüssel, kurze IDs, Verlauf von Gemini und Claude, Denken, Fehler als deutsche Sätze', async () => {
  const { anbieterVonSchluessel } = require('../src/models/ki');
  assert.equal(openai.vorlageVonSchluessel('sk-or-v1-0123456789abcdef0123456789'), 'openrouter');
  assert.equal(openai.vorlageVonSchluessel('gsk_0123456789abcdefABCDEF'), 'groq');
  assert.equal(openai.vorlageVonSchluessel('sk-proj-0123456789abcdefABCDEF_-xyz'), 'openai');
  assert.equal(openai.vorlageVonSchluessel('sk-ant-api03-0123456789'), null);
  assert.equal(openai.vorlageVonSchluessel('0123456789abcdefABCDEF0123456789'), null, 'Mistral hat keine Vorsilbe');
  assert.equal(anbieterVonSchluessel('sk-ant-api03-0123456789'), 'claude');
  assert.equal(anbieterVonSchluessel('gsk_0123456789abcdefABCDEF'), 'groq');
  assert.equal(anbieterVonSchluessel('AQ.Ab8RN6KxYz0123456789'), 'gemini');

  const id = openai.kurzeId('toolu_01A09q90qw90lq917835lq9');
  assert.match(id, /^[a-z0-9]{9}$/);
  assert.equal(openai.kurzeId('toolu_01A09q90qw90lq917835lq9'), id, 'immer dieselbe');
  assert.notEqual(openai.kurzeId('anderer'), id);

  const mistral = openai.erstellen('mistral');
  const groq = openai.erstellen('groq');
  const ovh = openai.erstellen('ovh');
  const or = openai.erstellen('openrouter');
  assert.equal(mistral.istModell('gemini-3.8-flash'), false, 'ein Gemini-Modell ist keins von Mistral');
  assert.equal(mistral.istModell('mistral-embed'), false);
  assert.equal(or.istModell('qwen/qwen3.8-27b'), false, 'bei OpenRouter nur die kostenlosen');
  assert.equal(or.istModell('qwen/qwen3.8-27b:free'), true);
  assert.equal(groq.istModell('whisper-large-v3'), false);

  // Ein Verlauf, den Gemini führte: Denkblock fällt weg, Aufruf und Ergebnis bleiben (kurze IDs), Bild als data:-Adresse.
  const { nachrichtenUebersetzen } = mistral.__internals;
  const aus = nachrichtenUebersetzen([
    { role: 'user', content: [{ type: 'text', text: 'Was ist auf dem Bild?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'geheim', gemini: { signatur: 'x' } }, { type: 'text', text: 'Ich schaue nach.' }, { type: 'tool_use', id: 'gemini-aufruf-1', name: 'wissen_suchen', input: { frage: 'Bild' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gemini-aufruf-1', content: [{ type: 'text', text: '{"treffer":[]}' }] }, { type: 'document', title: 'Vertrag.pdf', source: { type: 'base64', data: 'JVBE' } }, { type: 'text', text: 'Und das PDF?', cache_control: { type: 'ephemeral' } }] },
  ]);
  assert.deepEqual(aus.map((x) => x.role), ['user', 'assistant', 'tool', 'user']);
  assert.deepEqual(aus[0].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } });
  assert.equal(aus[1].content, 'Ich schaue nach.');
  assert.equal(aus[1].tool_calls[0].id, openai.kurzeId('gemini-aufruf-1'));
  assert.equal(aus[2].tool_call_id, aus[1].tool_calls[0].id);
  assert.equal(aus[2].content, '{"treffer":[]}');
  assert.match(aus[3].content, /\[PDF: Vertrag\.pdf – Mistral kann keine PDF lesen\]/);
  assert.ok(!JSON.stringify(aus).includes('geheim'));
  // Ein Modell ohne Augen bekommt statt des Bildes einen ehrlichen Satz.
  const ohneAugen = groq.anfrageBauen({ modell: 'openai/gpt-oss-120b', nachrichten: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }, { type: 'text', text: 'Und?' }] }] });
  assert.match(ohneAugen.body.messages[0].content, /\[Bild – Groq kann mit diesem Modell keine Bilder sehen\]/);

  // Claude liest einen Verlauf, den Mistral führte: das Denken fällt weg, der Rest bleibt.
  const anthropic = require('../src/models/providers/anthropic');
  const zurueck = anthropic.bloeckeZurueck([{ type: 'thinking', thinking: 'x', openai: {} }, { type: 'text', text: 'Hallo' }]);
  assert.deepEqual(zurueck, [{ type: 'text', text: 'Hallo' }]);

  // Fehler: deutsch, ohne Schlüssel, die richtige Art (danach richtet sich das Ausweichen).
  const f = (mod, status, json, opts = {}) => mod.fehlerAusAntwort({ status, text: JSON.stringify(json), ...opts });
  const falsch = f(openai.erstellen('openai'), 401, { error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop0123. You can find your API key at https://platform.openai.com.', type: 'invalid_request_error', code: 'invalid_api_key' } });
  assert.equal(falsch.code, 'OPENAI_SCHLUESSEL_FALSCH');
  assert.equal(falsch.message, 'Der OpenAI-Schlüssel stimmt nicht.');
  assert.doesNotMatch(JSON.stringify(falsch.details), /abcdefghijklmnop/, 'kein Schlüssel in den Einzelheiten');
  assert.equal(f(openai.erstellen('openai'), 429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }).code, 'OPENAI_GUTHABEN');
  assert.equal(f(or, 402, { error: { message: 'Insufficient credits', code: 402 } }).code, 'OPENROUTER_GUTHABEN');
  const proTag = f(or, 429, { error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429 } });
  assert.equal(proTag.code, 'OPENROUTER_LIMIT_TAG');
  assert.equal(proTag.message, 'OpenRouter: Tageslimit erreicht – morgen geht es weiter.');
  const groqTag = groq.fehlerAusAntwort({ status: 429, text: JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-120b`', type: 'requests', code: 'rate_limit_exceeded' } }), kopf: (n) => (n === 'x-ratelimit-remaining-requests' ? '0' : null), wiederholenNachS: 7 });
  assert.equal(groqTag.code, 'GROQ_LIMIT_TAG', 'bei Groq ist das Anfragen-Kontingent eines je Tag');
  const minute = f(mistral, 429, { message: 'Requests rate limit exceeded' }, { wiederholenNachS: 12 });
  assert.equal(minute.code, 'MISTRAL_LIMIT');
  assert.equal(minute.message, 'Mistral-Limit erreicht — gleich nochmal (in etwa 12 s).');
  assert.equal(minute.wiederholenNachS, 12);
  assert.equal(f(mistral, 404, { message: 'Invalid model: mistral-fantasie' }).code, 'MISTRAL_MODELL_UNBEKANNT');
  assert.equal(f(ovh, 503, { message: 'upstream unavailable' }).code, 'OVH_UEBERLASTET');
  assert.equal(f(mistral, 400, { message: 'Prompt contains 140000 tokens, too large for model with 131072 maximum context length' }).code, 'MISTRAL_ZU_GROSS');
  const unbekannt = f(groq, 400, { error: { message: 'messages.1.content must be a string', type: 'invalid_request_error' } });
  assert.equal(unbekannt.code, 'GROQ_ANFRAGE_ABGELEHNT');
  assert.equal(unbekannt.message, 'Groq hat die Anfrage nicht angenommen (Groq: „messages.1.content must be a string“).');
});
