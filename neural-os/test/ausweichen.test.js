'use strict';

/**
 * Ausweichen: Modelle abfragen, Suche ohne Freigabe, Limits, mehrere
 * Schlüssel, ein anderer Anbieter.
 *
 * Anlass (01.10.2026): Der Nutzer fügte seinen echten Google-Schlüssel ein --
 * und "es funktioniert gar nichts". Gebaut und geprüft war die Anbindung nur
 * gegen den Statisten. Die Recherche in Googles Unterlagen (Stand
 * 01.10.2026) fand den wahrscheinlichen Grund: Jede Chat-Anfrage trug die
 * Google-Suche, und die gibt es auf der kostenlosen Stufe für die neuen
 * Modelle nicht ("Grounding with Google Search … Not available"); der
 * Probeaufruf ohne Suche ging durch, jede Frage danach nicht. Seitdem:
 *   - beim Verbinden fragt Neural OS Google, welche Modelle der Schlüssel
 *     kann, und probt das beste;
 *   - lehnt Google eine Anfrage MIT Suche ab, geht sie einmal ohne -- und
 *     der Dienst merkt sich das für diesen Schlüssel und dieses Modell;
 *   - Tageslimit, fehlendes Modell, Überlastung: das nächste Modell, der
 *     nächste Schlüssel, der nächste verbundene Anbieter.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { test, tempHome } = require('./harness');
const { starten, B, antwort, httpFehler } = require('./gemini-statist');
const claudeStatist = require('./claude-statist');
const { createApp, seedIfEmpty } = require('../src/app');

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

/** Googles Fehlerkörper mit Einzelheiten, wie die API sie mitschickt. */
function googleFehler(code, status, message, details = []) {
  return { status: code, json: { error: { code, message, status, details } } };
}
const quote = (quotaId, quotaMetric, quotaValue) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaId, quotaMetric, quotaValue }],
});

const MODELLE = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'];

async function mitApp(fn, { modelle = MODELLE, claudeAuch = false, verbinden = true } = {}) {
  const { home, cleanup } = tempHome('nos-ausweichen');
  const statist = await starten({ modelle });
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
    await fn({ app, base, home, statist, claude, chatId: chat.json.record.id });
  } finally {
    if (app) await app.close().catch(() => {});
    await statist.close();
    if (claude) await claude.close();
    cleanup();
  }
}

test('Verbinden fragt Google nach den Modellen des Schlüssels und probt das beste; die Liste steht in den Einstellungen', async () => {
  await mitApp(async ({ app, base, statist }) => {
    const [liste, probe] = statist.anfragen;
    assert.equal(liste.liste, true, 'zuerst die Modellliste');
    assert.equal(liste.koepfe['x-goog-api-key'], statist.schluessel);
    assert.equal(probe.pfad, '/v1beta/models/gemini-3.8-flash:generateContent', 'geprobt wird das beste: Flash, stabil, neueste Version');
    assert.equal(probe.body.generationConfig.thinkingConfig, undefined, 'der Probeaufruf schickt keine Denk-Einstellung');
    const ki = (await anfrage(base, 'GET', '/api/ki')).json;
    const g = ki.anbieter.gemini;
    assert.deepEqual(g.modelle.map((m) => m.id), MODELLE, 'nur Chat-Modelle (keine Einbettung, keine Sprachausgabe), die besten zuerst');
    assert.equal(g.modell, 'gemini-3.8-flash');
    assert.equal(g.zugaenge.length, 1);
    assert.match(g.zugaenge[0].maske, /^AIza…[A-Za-z0-9]{4}$/);
    assert.equal(g.zugaenge[0].status, 'bereit');
    assert.doesNotMatch(JSON.stringify(ki), new RegExp(statist.schluessel), 'der Schlüssel geht nie zurück');
    assert.equal(app.config.ki.anbieter, 'gemini');
  });
});

test('Ein Schlüssel, dessen bestes Modell nicht kostenlos ist: Verbinden probt das nächste und speichert das, das antwortet', async () => {
  await mitApp(async ({ base, statist }) => {
    statist.weiterOhneStrom(googleFehler(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.8-flash',
      [quote('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'generativelanguage.googleapis.com/generate_content_free_tier_requests', '0')]));
    const r = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: statist.schluessel });
    assert.equal(r.status, 200, r.text);
    const proben = statist.ohneStromAnfragen().slice(-2).map((a) => a.modell);
    assert.deepEqual(proben, ['gemini-3.8-flash', 'gemini-3.7-flash']);
    assert.equal(r.json.anbieter.gemini.modell, 'gemini-3.7-flash');
  }, { verbinden: false });
});

test('Google gibt die Suche nicht frei (kostenlose Stufe): dieselbe Frage geht ohne Suche, die Antwort kommt – und beim nächsten Mal gleich ohne', async () => {
  for (const ablehnung of [
    googleFehler(400, 'INVALID_ARGUMENT', 'Search Grounding is not supported.'),
    googleFehler(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: generativelanguage.googleapis.com/search_grounding_requests, limit: 0',
      [quote('SearchGroundingRequestsPerDay-FreeTier', 'generativelanguage.googleapis.com/search_grounding_requests', '0')]),
  ]) {
    await mitApp(async ({ app, base, statist, chatId }) => {
      statist.weiter(ablehnung, antwort(B.text('Hallo ohne Suche!'), B.ende()));
      const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
      assert.equal(textVon(r.ereignisse), 'Hallo ohne Suche!', JSON.stringify(r.ereignisse.filter((e) => e.name === 'fehler')));
      assert.ok(!r.ereignisse.some((e) => e.name === 'fehler'), 'kein Fehler im Chat');
      assert.ok(hinweise(r.ereignisse).some((h) => /^Ohne Internetsuche: Google gibt die Suche/.test(h)), JSON.stringify(hinweise(r.ereignisse)));
      const [mit, ohne] = statist.stromAnfragen();
      assert.ok(mit.body.tools.some((t) => t.googleSearch), 'der erste Versuch mit Suche');
      assert.ok(!(ohne.body.tools || []).some((t) => t.googleSearch), 'der zweite ohne');
      assert.ok((ohne.body.tools || []).some((t) => t.functionDeclarations), 'die eigenen Werkzeuge bleiben');
      assert.equal(mit.modell, ohne.modell, 'dasselbe Modell -- es lag an der Suche, nicht am Modell');

      // Der nächste Zug schickt gleich ohne Suche (gemerkt im Tresor, je Schlüssel und Modell).
      statist.weiter(antwort(B.text('Zweite Antwort.'), B.ende()));
      const r2 = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Noch was' });
      assert.equal(textVon(r2.ereignisse), 'Zweite Antwort.');
      const dritte = statist.stromAnfragen()[2];
      assert.ok(!(dritte.body.tools || []).some((t) => t.googleSearch));
      assert.equal(statist.stromAnfragen().length, 3, 'kein vergeblicher Versuch mit Suche mehr');
      assert.equal(app.gemini.zustand().verbunden, true);
    });
  }
});

test('Tageslimit des Modells: es antwortet das nächste Modell (mit einem Satz dazu), und das volle wird bis morgen übersprungen', async () => {
  await mitApp(async ({ app, base, statist, chatId }) => {
    const tag = () => googleFehler(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.',
      [quote('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'generativelanguage.googleapis.com/generate_content_free_tier_requests', '250'),
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '29s' }]);
    // Erst mit Suche, dann ohne (lag es an der Suche?), dann das nächste Modell.
    statist.weiter(tag(), tag(), antwort(B.text('Antwort vom zweiten Modell.'), B.ende()));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(r.ereignisse), 'Antwort vom zweiten Modell.');
    assert.deepEqual(statist.stromAnfragen().map((a) => a.modell), ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.7-flash']);
    const h = hinweise(r.ereignisse);
    assert.ok(h.includes('Gemini 3.8 Flash hat sein Tageslimit erreicht – es antwortet Gemini 3.7 Flash.'), JSON.stringify(h));
    assert.ok(!h.some((x) => /Ohne Internetsuche/.test(x)), 'es lag nicht an der Suche -- also kein Satz dazu');
    // Das 3.7er bekam eine Denkstufe, wie sie zu ihm passt, und die Suche (für 3.7 ist nichts gemerkt).
    const dritte = statist.stromAnfragen()[2].body;
    assert.equal(dritte.generationConfig.thinkingConfig.thinkingLevel, 'medium');
    assert.ok(dritte.tools.some((t) => t.googleSearch));

    statist.weiter(antwort(B.text('Wieder vom zweiten.'), B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Noch was' });
    assert.equal(statist.stromAnfragen()[3].modell, 'gemini-3.7-flash', 'das volle Modell wird übersprungen');
    const z = app.gemini.zustand();
    assert.equal(z.verbunden, true);
    assert.equal(z.zugaenge[0].status, 'bereit', 'der Schlüssel als Ganzes geht noch');
  });
});

test('Ein Modell, das es nicht mehr gibt (404): das nächste antwortet, und es wird als neues Modell des Schlüssels gemerkt', async () => {
  await mitApp(async ({ base, home, statist, chatId }) => {
    statist.weiter(
      httpFehler(404, 'NOT_FOUND', 'models/gemini-3.8-flash is not found for API version v1beta, or is not supported for generateContent.'),
      antwort(B.text('Da bin ich.'), B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(r.ereignisse), 'Da bin ich.');
    const ki = (await anfrage(base, 'GET', '/api/ki')).json;
    assert.equal(ki.anbieter.gemini.modell, 'gemini-3.7-flash');
    assert.ok(fs.existsSync(path.join(home, 'vault', 'gemini-schluessel.json')));
  });
});

test('Mehrere Schlüssel: ein zweiter kommt dazu, ein widerrufener erste wird übersprungen, einzeln entfernen und nach vorn holen', async () => {
  await mitApp(async ({ app, base, statist, chatId }) => {
    // Ein zweiter Schlüssel (für den Statisten gilt jeder mit dem richtigen Wert; hier derselbe Wert -> kein Doppel).
    const doppelt = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: statist.schluessel, zusaetzlich: true });
    assert.equal(doppelt.status, 200);
    assert.equal(doppelt.json.anbieter.gemini.zugaenge.length, 1, 'derselbe Schlüssel zweimal ist einer');

    // Ein weiterer Schlüssel im Tresor -- so, wie ihn die Route speichern würde.
    const dienst = app.gemini;
    const zweiter = 'AIzaSyZweiter000000000000000000000000000';
    const datei = path.join(app.paths.vault, 'gemini-schluessel.json');
    assert.ok(fs.existsSync(datei));
    // Über die Route geht es nicht (der Statist kennt nur einen Schlüssel); der Dienst nimmt ihn mit Stellvertreter-Probe.
    const { createGemini } = require('../src/models/ki');
    const gemini = require('../src/models/providers/gemini');
    const stell = createGemini({
      paths: app.paths, config: app.config, gate: app.gate, bus: app.bus, vaultCrypto: app.vaultCrypto,
      konfigSpeichern: (patch) => app.saveConfig(patch), basis: statist.url,
      anbieter: { ...gemini, probe: async () => ({ ok: true }), modelleAbfragen: async () => MODELLE.map((id) => ({ id, name: gemini.anzeigeName(id) })) },
    });
    await stell.schluesselSpeichern(zweiter, { zusaetzlich: true });
    dienst.vergessen();
    let z = dienst.zustand();
    assert.deepEqual(z.zugaenge.map((x) => x.nr), [1, 2]);

    // Den zweiten nach vorn: jetzt wird er zuerst gefragt -- der Statist lehnt ihn ab (falscher Schlüssel),
    // also antwortet der erste, ohne dass der Nutzer etwas tun muss.
    const vor = await anfrage(base, 'POST', `/api/ki/gemini/zugaenge/${z.zugaenge[1].id}/vor`);
    assert.equal(vor.status, 200, vor.text);
    statist.weiter(antwort(B.text('Vom ersten Schlüssel.'), B.ende()));
    statist.weiter(antwort(B.text('Vom ersten Schlüssel.'), B.ende()));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(r.ereignisse), 'Vom ersten Schlüssel.', JSON.stringify(r.ereignisse.filter((e) => e.name === 'fehler')));
    const versuche = statist.stromAnfragen().map((a) => a.koepfe['x-goog-api-key']);
    assert.deepEqual(versuche, [zweiter, statist.schluessel]);
    assert.ok(hinweise(r.ereignisse).some((h) => /\(Schlüssel 1\) nimmt den Schlüssel nicht an – es antwortet .*\(Schlüssel 2\)\./.test(h)), JSON.stringify(hinweise(r.ereignisse)));
    z = dienst.zustand();
    assert.equal(z.verbunden, true);
    assert.deepEqual(z.zugaenge.map((x) => x.status), ['falsch', 'bereit']);

    // Den falschen einzeln entfernen.
    const weg = await anfrage(base, 'DELETE', `/api/ki/gemini/schluessel?zugang=${z.zugaenge[0].id}`);
    assert.equal(weg.status, 200, weg.text);
    assert.equal(weg.json.anbieter.gemini.zugaenge.length, 1);
    assert.equal(weg.json.anbieter.gemini.zugaenge[0].status, 'bereit');
  });
});

test('Ein Schlüssel von früher (ohne Liste der Zugänge) wird gelesen und weiter benutzt; geschrieben wird so, dass eine ältere Fassung ihn noch liest', async () => {
  await mitApp(async ({ app, base, statist, chatId }) => {
    const datei = path.join(app.paths.vault, 'gemini-schluessel.json');
    // So schrieb die Fassung bis zum 01.10.2026 (unversiegelt, ohne Verschlüsselung des Tresors).
    const alt = { schluessel: statist.schluessel, geprueftAm: '2026-09-30T10:00:00.000Z', modell: 'gemini-3.8-flash' };
    fs.writeFileSync(datei, JSON.stringify({ v: 1, versiegelt: false, inhalt: Buffer.from(JSON.stringify(alt)).toString('base64') }));
    app.gemini.vergessen();
    const z = app.gemini.zustand();
    assert.equal(z.verbunden, true);
    assert.equal(z.zugaenge.length, 1);
    statist.weiter(antwort(B.text('Geht.'), B.ende()));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(r.ereignisse), 'Geht.');
    // Neu schreiben (etwa durch "Suche fehlt merken") behält oben `schluessel`.
    statist.weiter(googleFehler(400, 'INVALID_ARGUMENT', 'Search Grounding is not supported.'), antwort(B.text('Ohne.'), B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Nochmal' });
    const huelle = JSON.parse(fs.readFileSync(datei, 'utf8'));
    const daten = JSON.parse(Buffer.from(huelle.inhalt, 'base64').toString('utf8'));
    assert.equal(daten.schluessel, statist.schluessel, 'oben steht weiter der (erste) Schlüssel');
    assert.equal(daten.zugaenge.length, 1);
    assert.deepEqual(daten.zugaenge[0].ohneSuche, ['gemini-3.8-flash']);
  }, { verbinden: true });
});

test('Gemini kann gar nicht (alle Modelle am Tageslimit): es antwortet Claude, mit einem Satz dazu', async () => {
  await mitApp(async ({ app, base, statist, claude, chatId }) => {
    const c = await anfrage(base, 'POST', '/api/ki/claude/schluessel', { schluessel: claude.schluessel });
    assert.equal(c.status, 200, c.text);
    assert.equal(app.config.ki.anbieter, 'gemini', 'Gemini bleibt eingestellt');
    const tag = () => googleFehler(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.',
      [quote('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'generativelanguage.googleapis.com/generate_content_free_tier_requests', '250')]);
    // Je Modell zwei Versuche (mit und ohne Suche), drei Modelle.
    statist.weiter(tag(), tag(), tag(), tag(), tag(), tag());
    const C = claudeStatist.B;
    claude.weiter(claudeStatist.antwort(C.start(), C.text(0, 'Hier antwortet Claude.'), C.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(r.ereignisse), 'Hier antwortet Claude.', JSON.stringify(r.ereignisse.filter((e) => e.name === 'fehler')));
    assert.ok(hinweise(r.ereignisse).includes('Gemini ist gerade am Limit – es antwortet Claude.'), JSON.stringify(hinweise(r.ereignisse)));
    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data.record;
    assert.equal(fertig.data.model.provider, 'claude', 'die Antwort sagt, wer geantwortet hat');
  }, { claudeAuch: true });
});

test('Bausteine: Modellnamen, Familien, Auswahl aus Googles Liste, Heilung abgelehnter Anfragen', () => {
  const gemini = require('../src/models/providers/gemini');
  const { heilen, chatModell, nachRang, modellAusListe } = gemini.__internals;
  // Namen und Familien
  assert.equal(gemini.anzeigeName('gemini-3.8-flash'), 'Gemini 3.8 Flash');
  assert.equal(gemini.anzeigeName('gemini-3.5-flash-lite'), 'Gemini 3.5 Flash-Lite');
  assert.equal(gemini.anzeigeName('gemini-3-flash-preview'), 'Gemini 3 Flash (Vorschau)');
  assert.equal(gemini.anzeigeName('gemini-flash-latest'), 'Gemini Flash (neueste)');
  assert.equal(gemini.familie('gemini-3.8-flash'), 'level');
  assert.equal(gemini.familie('gemini-2.5-flash'), 'budget');
  assert.equal(gemini.familie('gemini-2.0-flash'), 'aus');
  assert.equal(gemini.familie('gemini-flash-latest'), 'offen');
  assert.equal(gemini.istModell('gemini-9.1-flash'), true, 'ein Modell, das es heute noch nicht gibt, darf Google morgen nennen');
  assert.equal(gemini.istModell('gpt-4o'), false);
  // Denken je Modell
  assert.deepEqual(gemini.denkenFuer('gemini-3.8-flash', { an: true, aufwand: 'high' }), { includeThoughts: true, thinkingLevel: 'high' });
  assert.deepEqual(gemini.denkenFuer('gemini-2.5-flash', { an: true, aufwand: 'low' }), { includeThoughts: true, thinkingBudget: 1024 });
  assert.equal(gemini.denkenFuer('gemini-2.0-flash', { an: true }), null);
  assert.deepEqual(gemini.denkenFuer('gemini-flash-latest', { an: true }), { includeThoughts: true });
  // Auswahl: Chat-Modelle, Flash vor Lite vor Pro, stabil vor Vorschau vor Alias, neuere Version zuerst
  const roh = ['gemini-3.1-pro-preview', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-3.8-flash',
    'gemini-3.7-flash', 'gemini-embedding-001', 'gemini-3.8-flash-tts', 'gemini-3.8-live', 'gemini-3.1-flash-image']
    .map((id) => modellAusListe({ name: `models/${id}`, supportedGenerationMethods: id.includes('embedding') ? ['embedContent'] : ['generateContent'] }));
  const wahl = roh.filter(chatModell).sort(nachRang).map((m) => m.id);
  assert.deepEqual(wahl, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview']);
  // Heilung
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'x' }] }, { role: 'model', parts: [{ text: 'y' }] }],
    tools: [{ functionDeclarations: [{ name: 'a' }] }, { googleSearch: {} }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' } },
  };
  const fehler = (code) => ({ code });
  const s1 = heilen(body, 'Search Grounding is not supported.', [], { fehler: fehler('GEMINI_ANFRAGE_ABGELEHNT') });
  assert.equal(s1.art, 'suche');
  assert.deepEqual(s1.body.tools, [{ functionDeclarations: [{ name: 'a' }] }]);
  const ohneSuche = { ...body, tools: [{ functionDeclarations: [{ name: 'a' }] }] };
  const d1 = heilen(ohneSuche, 'Invalid value at generation_config.thinking_config.thinking_level', ['suche'], { fehler: fehler('GEMINI_ANFRAGE_ABGELEHNT') });
  assert.equal(d1.art, 'denken');
  assert.deepEqual(d1.body.generationConfig.thinkingConfig, { includeThoughts: true });
  const d2 = heilen(d1.body, 'thinking is not supported by this model', ['suche', 'denken'], { fehler: fehler('GEMINI_ANFRAGE_ABGELEHNT') });
  assert.equal(d2.art, 'denken-ganz');
  assert.equal(d2.body.generationConfig.thinkingConfig, undefined);
  const e1 = heilen(ohneSuche, 'Requests ending with a model turn are not supported.', ['suche'], { fehler: fehler('GEMINI_ANFRAGE_ABGELEHNT') });
  assert.equal(e1.art, 'ende');
  assert.equal(e1.body.contents.length, 1);
  const w1 = heilen(ohneSuche, 'Invalid JSON payload received. Unknown name "foo" at tools[0].function_declarations[0].parameters', ['suche'], { fehler: fehler('GEMINI_ANFRAGE_ABGELEHNT') });
  assert.equal(w1.art, 'werkzeuge');
  assert.equal(w1.body.tools, undefined);
  assert.equal(w1.body.toolConfig, undefined);
  assert.match(w1.hinweis, /^Ohne Werkzeuge: Google hat ihre Beschreibung nicht angenommen/);
  // Ein falscher Schlüssel wird nie "geheilt".
  assert.equal(heilen(body, 'API key not valid', [], { fehler: fehler('GEMINI_SCHLUESSEL_FALSCH') }), null);
});

test('Neue Google-Schlüssel („AQ.“, seit 28.05.2026) werden erkannt; Googles „ACCESS_TOKEN_TYPE_UNSUPPORTED“ sagt, was hilft', () => {
  const { anbieterVonSchluessel } = require('../src/models/ki');
  const gemini = require('../src/models/providers/gemini');
  assert.equal(anbieterVonSchluessel('AQ.Ab8RN6KxYz0123456789abcdefghijk'), 'gemini');
  assert.equal(anbieterVonSchluessel('  AIzaSyAbc0123456789  '), 'gemini');
  const f = gemini.fehlerAusAntwort({ status: 401, statusName: 'UNAUTHENTICATED', text: 'Request had invalid authentication credentials.', grund: 'ACCESS_TOKEN_TYPE_UNSUPPORTED' });
  assert.equal(f.code, 'GEMINI_SCHLUESSEL_FALSCH');
  assert.match(f.message, /mit dem Kopier-Knopf vollständig kopieren/);
  const alt = gemini.fehlerAusAntwort({ status: 403, statusName: 'PERMISSION_DENIED', text: 'The Gemini API rejects requests from unrestricted standard keys.' });
  assert.equal(alt.code, 'GEMINI_SCHLUESSEL_GESPERRT');
  assert.match(alt.message, /beginnt mit „AQ\.“/);
  // Kein Schlüssel im Satz, auch kein neuer.
  const roh = gemini.fehlerAusAntwort({ status: 400, statusName: 'INVALID_ARGUMENT', text: 'bad key AQ.Ab8RN6KxYz0123456789abcdefghijk here' });
  assert.doesNotMatch(roh.message, /Ab8RN6/);
});
