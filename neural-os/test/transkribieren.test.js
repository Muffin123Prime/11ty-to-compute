'use strict';

/**
 * Sprache in Text (docs/ANTWORT-BAUSTEINE.md 6, "Sprechen"):
 * POST /api/ki/transkribieren {audio: WAV (Base64), höchstens 60 s} geht an
 * Gemini -- auch wenn Claude antwortet -- und liefert {text}. Ohne
 * Google-Schlüssel 409 mit Satz. Bewiesen mit dem Gemini-Statisten, der die
 * Anfrage aufzeichnet und inlineData wie Google prüft.
 */

const assert = require('node:assert/strict');
const { test } = require('./harness');
const { anfrage, mitKi, wav } = require('./antwort-hilfe');

const ohneStromAnfragen = (gemini) => gemini.anfragen.filter((a) => !a.stream && a.body && JSON.stringify(a.body).includes('inlineData'));

test('Transkribieren: WAV an Gemini (inlineData audio/wav, ohne Werkzeuge), zurück kommt der Text', async () => {
  await mitKi(async ({ base, gemini, chatId }) => {
    const ki = await anfrage(base, 'GET', '/api/ki');
    assert.equal(ki.json.transkribieren, true);
    gemini.weiterOhneStrom({ text: 'Erinnere mich morgen an den Zahnarzt.\n' });
    const aufnahme = wav(2.5);
    const r = await anfrage(base, 'POST', '/api/ki/transkribieren', { audio: aufnahme.toString('base64'), chatId });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { text: 'Erinnere mich morgen an den Zahnarzt.', sekunden: 2.5, modell: 'gemini-3.8-flash' });
    const [a] = ohneStromAnfragen(gemini);
    assert.ok(a, 'eine Anfrage ohne Strom mit Inline-Daten');
    assert.equal(a.pfad, '/v1beta/models/gemini-3.8-flash:generateContent');
    const teile = a.body.contents[0].parts;
    assert.match(teile[0].text, /Schreib wörtlich auf, was in dieser Aufnahme gesprochen wird/);
    assert.equal(teile[1].inlineData.mimeType, 'audio/wav');
    assert.ok(Buffer.from(teile[1].inlineData.data, 'base64').equals(aufnahme), 'dieselben Bytes');
    assert.equal(a.body.tools, undefined, 'keine Werkzeuge, keine Suche');
  }, { mit: 'gemini' });
});

test('Transkribieren: auch wenn Claude antwortet, geht die Aufnahme an Gemini (Claude nimmt kein Audio)', async () => {
  await mitKi(async ({ base, gemini, claude }) => {
    const ki = await anfrage(base, 'GET', '/api/ki');
    assert.equal(ki.json.aktiv, 'claude');
    gemini.weiterOhneStrom({ text: 'Hallo Welt' });
    const r = await anfrage(base, 'POST', '/api/ki/transkribieren', { audio: wav(1).toString('base64') });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.text, 'Hallo Welt');
    assert.equal(claude.anfragen.filter((x) => x.body && x.body.stream === true).length, 0);
  }, { mit: 'beide', aktiv: 'claude' });
});

test('Transkribieren: ohne Google-Schlüssel 409 mit Satz; zu lang, kein WAV und kaputtes Base64 werden abgelehnt', async () => {
  await mitKi(async ({ base, gemini }) => {
    const ki = await anfrage(base, 'GET', '/api/ki');
    assert.equal(ki.json.transkribieren, false);
    const r = await anfrage(base, 'POST', '/api/ki/transkribieren', { audio: wav(1).toString('base64') });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'TRANSKRIBIEREN_NICHT_MOEGLICH');
    assert.match(r.json.error.message, /nur Gemini \(kostenlos\)/);
    assert.equal(gemini.anfragen.length, 0);
  }, { mit: 'claude' });
  await mitKi(async ({ base, gemini }) => {
    const lang = await anfrage(base, 'POST', '/api/ki/transkribieren', { audio: wav(61).toString('base64') });
    assert.equal(lang.status, 413);
    assert.equal(lang.json.error.code, 'AUDIO_ZU_LANG');
    assert.match(lang.json.error.message, /höchstens 60/);
    const png = await anfrage(base, 'POST', '/api/ki/transkribieren', { audio: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64') });
    assert.equal(png.status, 400);
    assert.match(png.json.error.message, /kein WAV/);
    const kaputt = await anfrage(base, 'POST', '/api/ki/transkribieren', { audio: '***' });
    assert.equal(kaputt.status, 400);
    const fehlt = await anfrage(base, 'POST', '/api/ki/transkribieren', {});
    assert.equal(fehlt.status, 400);
    assert.equal(ohneStromAnfragen(gemini).length, 0, 'nichts ging an Gemini');
  }, { mit: 'gemini' });
});
