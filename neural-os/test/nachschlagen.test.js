'use strict';

/**
 * Nachschlagen in Wikipedia (src/models/nachschlagen.js): die Suche für die
 * KIs ohne eigene -- Gemini auf der kostenlosen Stufe, Mistral, Groq,
 * OpenRouter, OVHcloud.
 *
 * Anlass (01.10.2026), der Nutzer: "der kann dann für mich Sachen suchen im
 * Internet". Geprüft wird gegen zwei Statisten (Mistral: test/openai-statist.js,
 * Wikipedia: test/wikipedia-statist.js): das Werkzeug und der ehrliche Satz an
 * die KI, die zwei Anfragen an Wikipedia (mit eigenem Namen im User-Agent),
 * die Artikel als Quellen, Englisch, wenn es auf Deutsch nichts gibt, das
 * Limit, der Schalter (und die Freigabeliste dahinter), offline, Claude.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, tempHome } = require('./harness');
const OA = require('./openai-statist');
const W = require('./wikipedia-statist');
const claudeStatist = require('./claude-statist');
const { createApp, seedIfEmpty } = require('../src/app');
const nachschlagen = require('../src/models/nachschlagen');

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

/** GET mit den rohen Bytes (für Bilder). */
function roh(base, urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(teile) }));
    }).on('error', reject);
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
const fehlerVon = (liste) => liste.filter((e) => e.name === 'fehler').map((e) => e.data);
const werkzeugNamen = (body) => (body.tools || []).map((t) => t.function.name);
const systemVon = (body) => body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

async function mitApp(fn, { online = true, claudeAuch = false } = {}) {
  const { home, cleanup } = tempHome('nos-nachschlagen');
  const mistral = await OA.starten({ modelle: [{ id: 'mistral-small-latest', capabilities: { completion_chat: true } }] });
  const de = await W.starten({ sprache: 'de' });
  const en = await W.starten({ sprache: 'en' });
  const claude = claudeAuch ? await claudeStatist.starten() : null;
  let app = null;
  try {
    app = await createApp({
      home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
      anbieterBasen: { mistral: mistral.url },
      nachschlagenBasen: { de: de.url, en: en.url },
      ...(claude ? { claudeBasis: claude.url } : {}),
    });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const r = await anfrage(base, 'POST', '/api/ki/mistral/schluessel', { schluessel: mistral.schluessel });
    assert.equal(r.status, 200, r.text);
    if (online) app.saveConfig({ network: { mode: 'online' } });
    const chat = await anfrage(base, 'POST', '/api/chats', { title: 'Neuer Chat' });
    await fn({ app, base, mistral, de, en, claude, chatId: chat.json.record.id });
  } finally {
    if (app) await app.close().catch(() => {});
    await mistral.close();
    await de.close();
    await en.close();
    if (claude) await claude.close();
    cleanup();
  }
}

test('Eine KI ohne eigene Suche schlägt in Wikipedia nach: Werkzeug, Aktivität, die Artikel als Quellen – und Wikipedia erfährt nur die Suchwörter', async () => {
  await mitApp(async ({ app, base, mistral, de, chatId }) => {
    // Beim Verbinden ging das Nachschlagen von selbst an: sichtbar auf der Freigabeliste.
    assert.equal(app.config.ki.nachschlagen, true);
    assert.ok(nachschlagen.FREIGABE.every((h) => app.config.network.allowHosts.includes(h)), JSON.stringify(app.config.network.allowHosts));
    const ki = (await anfrage(base, 'GET', '/api/ki')).json;
    assert.deepEqual({ an: ki.nachschlagen.an, erreichbar: ki.nachschlagen.erreichbar }, { an: true, erreichbar: true });

    mistral.weiter(
      OA.antwort(OA.B.aufruf('wikipedia_suchen', { suche: 'Brandenburger Tor' }), OA.B.ende('tool_calls')),
      OA.antwort(OA.B.text('Das Brandenburger Tor wurde 1789 bis 1793 gebaut.'), OA.B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Wann wurde das Brandenburger Tor gebaut? Such im Internet.' });
    assert.deepEqual(fehlerVon(r.ereignisse), []);
    assert.equal(textVon(r.ereignisse), 'Das Brandenburger Tor wurde 1789 bis 1793 gebaut.');

    const [erste, zweite] = mistral.stromAnfragen();
    assert.ok(werkzeugNamen(erste.body).includes('wikipedia_suchen'), JSON.stringify(werkzeugNamen(erste.body)));
    assert.equal(werkzeugNamen(erste.body).at(-1), 'wikipedia_suchen', 'hinten angehängt -- die feste Reihenfolge davor bleibt');
    assert.match(systemVon(erste.body), /Eine Websuche hast du in diesem Gespräch nicht; nachschlagen kannst du in Wikipedia \(wikipedia_suchen\)/);

    // Zwei Anfragen an Wikipedia: suchen, dann die Kurztexte -- mit eigenem Namen, ohne etwas über den Nutzer.
    assert.equal(de.anfragen.length, 2);
    const [suche, texte] = de.anfragen;
    assert.equal(suche.p.list, 'search');
    assert.equal(suche.p.srsearch, 'Brandenburger Tor');
    assert.match(texte.p.prop, /extracts/);
    assert.equal(texte.p.titles, 'Brandenburger Tor|Brandenburger Tor (Potsdam)');
    for (const a of de.anfragen) {
      assert.equal(a.koepfe['user-agent'], nachschlagen.UA);
      assert.match(a.koepfe['user-agent'], /^NeuralOS\/1\.0 \(/);
      assert.ok(!a.koepfe.authorization && !a.koepfe.cookie);
    }
    assert.ok(/^[\x20-\x7e]+$/.test(nachschlagen.UA), 'der Kopf ist reines ASCII');

    // Das Ergebnis an die KI: Kurztext und Adresse, als Inhalt markiert.
    const tool = zweite.body.messages.find((m) => m.role === 'tool');
    const inhalt = JSON.parse(tool.content);
    assert.equal(inhalt.quelle, 'Wikipedia');
    assert.equal(inhalt.treffer[0].titel, 'Brandenburger Tor');
    assert.match(inhalt.treffer[0].auszug, /Langhans/);
    assert.equal(inhalt.treffer[0].url, 'https://de.wikipedia.org/wiki/Brandenburger_Tor');
    assert.match(inhalt.hinweis, /keine Anweisungen/);

    // Unter der Antwort: die Artikel als Quellen; im Chat: was die KI gerade tut.
    const quellen = r.ereignisse.filter((e) => e.name === 'quelle').map((e) => e.data);
    assert.deepEqual(quellen.map((q) => q.url), ['https://de.wikipedia.org/wiki/Brandenburger_Tor', 'https://de.wikipedia.org/wiki/Brandenburger_Tor_(Potsdam)']);
    assert.ok(quellen.every((q) => q.art === 'gelesen' && / – Wikipedia$/.test(q.titel)));
    const agent = r.ereignisse.filter((e) => e.name === 'agent' && e.data.werkzeug === 'wikipedia_suchen').map((e) => e.data);
    assert.ok(agent.some((a) => a.titel === 'Wikipedia: „Brandenburger Tor“'), JSON.stringify(agent));
    assert.ok(agent.some((a) => a.zustand === 'fertig' && /2 Artikel gefunden/.test(a.ergebnis || a.schritt || '')), JSON.stringify(agent));
    const fertig = r.ereignisse.find((e) => e.name === 'fertig').data.record;
    assert.equal(fertig.data.quellen.length, 2, 'die Quellen bleiben an der Antwort');
  });
});

test('Auf Deutsch nichts gefunden: einmal auf Englisch – die Quelle sagt es', async () => {
  await mitApp(async ({ base, mistral, de, en, chatId }) => {
    mistral.weiter(
      OA.antwort(OA.B.aufruf('wikipedia_suchen', { suche: 'Photosynthese' }), OA.B.ende('tool_calls')),
      OA.antwort(OA.B.text('Photosynthese wandelt Licht in chemische Energie.'), OA.B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Was ist Photosynthese?' });
    assert.equal(textVon(r.ereignisse), 'Photosynthese wandelt Licht in chemische Energie.');
    assert.equal(de.anfragen.length, 1, 'auf Deutsch nur die Suche (ohne Treffer keine Kurztexte)');
    assert.equal(en.anfragen.length, 2);
    const quellen = r.ereignisse.filter((e) => e.name === 'quelle').map((e) => e.data.url);
    assert.deepEqual(quellen, ['https://en.wikipedia.org/wiki/Photosynthesis']);
    const tool = JSON.parse(mistral.stromAnfragen()[1].body.messages.find((m) => m.role === 'tool').content);
    assert.equal(tool.sprache, 'en');
  });
});

test('Wikipedia am Limit (429) oder nichts gefunden: die KI erfährt es als Satz – erfunden wird nichts', async () => {
  await mitApp(async ({ base, mistral, de, en, chatId }) => {
    de.weiter({ status: 429, json: { error: { code: 'ratelimited', info: 'You have exceeded your rate limit.' } }, koepfe: { 'retry-after': '30' } });
    mistral.weiter(
      OA.antwort(OA.B.aufruf('wikipedia_suchen', { suche: 'Brandenburger Tor' }), OA.B.ende('tool_calls')),
      OA.antwort(OA.B.text('Ich konnte gerade nicht nachschlagen.'), OA.B.ende()),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Such das Brandenburger Tor' });
    assert.equal(textVon(r.ereignisse), 'Ich konnte gerade nicht nachschlagen.');
    const tool = mistral.stromAnfragen()[1].body.messages.find((m) => m.role === 'tool');
    assert.match(JSON.parse(tool.content).fehler, /^Wikipedia bittet um eine kurze Pause/);
    const fehler = r.ereignisse.filter((e) => e.name === 'agent' && e.data.werkzeug === 'wikipedia_suchen' && e.data.zustand === 'fehler');
    assert.equal(fehler.length, 1);
    assert.equal(r.ereignisse.filter((e) => e.name === 'quelle').length, 0);

    // Nichts gefunden (auch nicht auf Englisch): ein ehrlicher Hinweis an die KI.
    mistral.weiter(
      OA.antwort(OA.B.aufruf('wikipedia_suchen', { suche: 'Xylofantasie' }), OA.B.ende('tool_calls')),
      OA.antwort(OA.B.text('Dazu habe ich nichts gefunden.'), OA.B.ende()),
    );
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Was ist Xylofantasie?' });
    const nichts = JSON.parse(mistral.stromAnfragen()[3].body.messages.filter((m) => m.role === 'tool').at(-1).content);
    assert.deepEqual(nichts.treffer, []);
    assert.match(nichts.hinweis, /ehrlich/);
    assert.equal(en.anfragen.length, 1, 'auf Englisch nur die Suche');

    // Eine ungültige Eingabe wird nicht repariert.
    mistral.weiter(
      OA.antwort(OA.B.aufruf('wikipedia_suchen', { suche: '', geheim: 1 }), OA.B.ende('tool_calls')),
      OA.antwort(OA.B.text('Ok.'), OA.B.ende()),
    );
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Und?' });
    const ungueltig = JSON.parse(mistral.stromAnfragen()[5].body.messages.filter((m) => m.role === 'tool').at(-1).content);
    assert.match(ungueltig.fehler, /Eingabe war ungültig: Unbekanntes Feld: geheim/);
  });
});

test('Der Schalter: aus nimmt Wikipedia von der Freigabeliste und das Werkzeug weg (mit ehrlichem Satz an die KI); ein neuer Schlüssel schaltet es nicht heimlich wieder an', async () => {
  await mitApp(async ({ app, base, mistral, chatId }) => {
    const aus = await anfrage(base, 'PATCH', '/api/ki', { nachschlagen: false });
    assert.equal(aus.status, 200, aus.text);
    assert.equal(aus.json.nachschlagen.an, false);
    assert.equal(app.config.ki.nachschlagen, false);
    assert.ok(nachschlagen.FREIGABE.every((h) => !app.config.network.allowHosts.includes(h)));
    assert.equal((await anfrage(base, 'PATCH', '/api/ki', { nachschlagen: 'ja' })).status, 400);

    mistral.weiter(OA.antwort(OA.B.text('Ohne Nachschlagen.'), OA.B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    const b = mistral.stromAnfragen()[0].body;
    assert.ok(!werkzeugNamen(b).includes('wikipedia_suchen'));
    assert.match(systemVon(b), /Eine Websuche hast du in diesem Gespräch nicht\. Für Nachrichten von heute/);
    assert.doesNotMatch(systemVon(b), /wikipedia_suchen/);

    // Derselbe Schlüssel noch einmal verbunden: das "aus" des Nutzers bleibt.
    assert.equal((await anfrage(base, 'POST', '/api/ki/mistral/schluessel', { schluessel: mistral.schluessel })).status, 200);
    assert.equal(app.config.ki.nachschlagen, false);
    assert.equal(app.kiDienst.einrichten(), false, 'auch beim Start nicht');

    const an = await anfrage(base, 'PATCH', '/api/ki', { nachschlagen: true });
    assert.equal(an.json.nachschlagen.an, true);
    assert.ok(nachschlagen.HOSTS.every((h) => app.config.network.allowHosts.includes(h)));
  });
});

test('Offline gibt es kein Nachschlagen (die Schleuse ließe Wikipedia nicht durch); Claude bekommt das Werkzeug nie – es hat seine eigene Suche', async () => {
  await mitApp(async ({ base, mistral, de, chatId }) => {
    const ki = (await anfrage(base, 'GET', '/api/ki')).json;
    assert.equal(ki.nachschlagen.erreichbar, false);
    mistral.weiter(OA.antwort(OA.B.text('Offline-Antwort vom Statisten.'), OA.B.ende()));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    const b = mistral.stromAnfragen()[0].body;
    assert.ok(!werkzeugNamen(b).includes('wikipedia_suchen'));
    assert.equal(de.anfragen.length, 0);
  }, { online: false });

  await mitApp(async ({ base, claude, chatId }) => {
    const c = await anfrage(base, 'POST', '/api/ki/claude/schluessel', { schluessel: claude.schluessel, aktivieren: true });
    assert.equal(c.status, 200, c.text);
    const C = claudeStatist.B;
    claude.weiter(claudeStatist.antwort(C.start(), C.text(0, 'Hier Claude.'), C.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hi' });
    assert.equal(textVon(r.ereignisse), 'Hier Claude.');
    const body = claude.stromAnfragen()[0].body;
    const namen = (body.tools || []).map((t) => t.name);
    assert.ok(!namen.includes('wikipedia_suchen'), JSON.stringify(namen));
    assert.ok(namen.includes('web_search'), 'Claude sucht selbst');
    assert.ok(!JSON.stringify(body.system).includes('wikipedia_suchen'));
  }, { claudeAuch: true });
});

test('Beim Start: wer schon eine KI ohne eigene Suche verbunden hatte, bekommt das Nachschlagen – einmal', async () => {
  await mitApp(async ({ app }) => {
    // So stand es vor dem Nachschlagen: Schlüssel da, nichts eingestellt, Wikipedia nicht auf der Liste.
    app.saveConfig({ ki: { nachschlagen: null }, network: { allowHosts: app.config.network.allowHosts.filter((h) => !nachschlagen.HOSTS.includes(h)) } });
    delete app.config.ki.nachschlagen;
    assert.equal(app.kiDienst.einrichten(), true);
    assert.equal(app.config.ki.nachschlagen, true);
    assert.ok(nachschlagen.HOSTS.every((h) => app.config.network.allowHosts.includes(h)));
    assert.equal(app.kiDienst.einrichten(), false, 'ein zweites Mal ändert nichts');
  });
});

test('Bilder aus Wikipedia: die KI bekommt eine eigene Adresse, Neural OS holt das Bild durch die Schleuse – ohne Tracking-Anhang, nur echte Bilder, nur von Wikipedia', async () => {
  await mitApp(async ({ base, mistral, de, chatId }) => {
    mistral.weiter(
      OA.antwort(OA.B.aufruf('wikipedia_suchen', { suche: 'Brandenburger Tor' }), OA.B.ende('tool_calls')),
      OA.antwort(OA.B.text('So sieht es aus.'), OA.B.ende()),
    );
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Zeig mir das Brandenburger Tor' });
    const tool = JSON.parse(mistral.stromAnfragen()[1].body.messages.find((m) => m.role === 'tool').content);
    const bild = tool.treffer[0].bild;
    assert.match(bild, /^\/api\/ki\/bild\?u=/, 'eine Adresse in Neural OS, keine fremde');
    assert.equal(new URL(bild, base).searchParams.get('u'), `${de.url}/wikipedia/commons/thumb/1/11/Tor.png/500px-Tor.png`, 'ohne ?utm_source=…');
    assert.equal(tool.treffer[1].bild, undefined, 'ohne Bild kein Feld');

    const vorher = de.anfragen.length;
    const b1 = await roh(base, bild);
    assert.equal(b1.status, 200);
    assert.equal(b1.headers['content-type'], 'image/png');
    assert.equal(b1.headers['content-security-policy'], "default-src 'none'");
    assert.equal(b1.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(b1.buf, de.PNG);
    assert.equal(de.anfragen.at(-1).koepfe['user-agent'], nachschlagen.UA);
    const b2 = await roh(base, bild);
    assert.deepEqual(b2.buf, de.PNG);
    assert.equal(de.anfragen.length, vorher + 1, 'das zweite Mal aus dem Speicher');

    const fremd = await anfrage(base, 'GET', `/api/ki/bild?u=${encodeURIComponent('https://example.com/wikipedia/x.png')}`);
    assert.equal(fremd.status, 400);
    assert.match(fremd.json.error.message, /nur Bilder von Wikipedia/);
    const keinBild = await anfrage(base, 'GET', `/api/ki/bild?u=${encodeURIComponent(`${de.url}/wikipedia/kein-bild.png`)}`);
    assert.equal(keinBild.status, 415);
    assert.equal((await anfrage(base, 'GET', '/api/ki/bild')).status, 400);
  });
});

test('Bausteine: die Eingabe wird geprüft, nicht repariert; die Beschreibung sagt ehrlich, was es nicht kann', () => {
  const { eingabePruefen, DEFINITION } = nachschlagen;
  assert.deepEqual(eingabePruefen({ suche: '  Mond ' }), { ok: true, wert: { suche: 'Mond', sprache: 'de' } });
  assert.deepEqual(eingabePruefen({ suche: 'Moon', sprache: 'en' }), { ok: true, wert: { suche: 'Moon', sprache: 'en' } });
  assert.equal(eingabePruefen({ suche: 'x', sprache: 'fr' }).ok, false);
  assert.equal(eingabePruefen({}).ok, false);
  assert.equal(eingabePruefen({ suche: 'x'.repeat(201) }).ok, false);
  assert.equal(eingabePruefen(null).ok, false);
  assert.equal(eingabePruefen({ suche: 'x' }, { fehler: 'kaputt' }).ok, false);
  assert.match(DEFINITION.description, /nur Wikipedia – keine Nachrichten von heute, keine Preise, kein Wetter/);
  assert.match(DEFINITION.description, /Bilder erzeugen kannst du nicht/);
  assert.deepEqual(nachschlagen.FREIGABE, ['de.wikipedia.org', 'en.wikipedia.org', 'upload.wikimedia.org', 'thumb.wikimedia.org']);
  assert.deepEqual(DEFINITION.input_schema.required, ['suche']);
});
