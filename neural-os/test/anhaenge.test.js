'use strict';

/**
 * Anhänge im Chat (docs/ANTWORT-BAUSTEINE.md 6): Bilder (PNG, JPG, WEBP,
 * GIF, je höchstens 5 MB) und PDF (höchstens 20 MB). Hochladen, ausliefern,
 * an die Nachricht hängen -- und im Verlauf an Claude (image/document,
 * base64) bzw. Gemini (inlineData). Die Statisten prüfen die Form so, wie
 * die Schnittstellen sie verlangen, und lehnen alles andere mit 400 ab.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('./harness');
const { B, antwort, medienIn } = require('./claude-statist');
const G = require('./gemini-statist');
const {
  anfrage, strom, mitKi, nachrichten, PNG_1X1, GIF_1X1, PDF_KLEIN,
} = require('./antwort-hilfe');
const { ANHANG_CSP } = require('../src/http/api/chat');
const anhaenge = require('../src/models/anhaenge');

const hoch = (base, chatId, name, mime, buf, koepfe) => anfrage(base, 'POST', `/api/chats/${chatId}/anhaenge`, { name, mime, daten: buf.toString('base64') }, koepfe);
const letzteStromAnfrage = (statist) => statist.stromAnfragen()[statist.stromAnfragen().length - 1].body;

test('Anhang hochladen: Art am Inhalt geprüft, Grenzen je Art, Auslieferung nur für diesen Chat mit eigener Kopfzeile', async () => {
  await mitKi(async ({ base, chatId }) => {
    const r = await hoch(base, chatId, 'rot.png', 'image/png', PNG_1X1);
    assert.equal(r.status, 200, r.text);
    const a = r.json.anhang;
    assert.deepEqual({ name: a.name, mime: a.mime, size: a.size, art: a.art }, { name: 'rot.png', mime: 'image/png', size: PNG_1X1.length, art: 'bild' });
    assert.equal(a.url, `/api/chats/${chatId}/anhaenge/${a.id}`);

    const g = await anfrage(base, 'GET', a.url);
    assert.equal(g.status, 200);
    assert.equal(g.headers['content-type'], 'image/png');
    assert.ok(g.roh.equals(PNG_1X1), 'dieselben Bytes');
    assert.equal(g.headers['content-security-policy'], ANHANG_CSP);
    assert.equal(g.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(g.headers['content-disposition'], /^inline; filename="rot\.png"/);

    const pdf = await hoch(base, chatId, 'Vertrag.pdf', 'application/pdf', PDF_KLEIN);
    assert.equal(pdf.status, 200, pdf.text);
    assert.equal(pdf.json.anhang.art, 'pdf');
    assert.equal((await anfrage(base, 'GET', pdf.json.anhang.url)).headers['content-type'], 'application/pdf');
    assert.equal((await hoch(base, chatId, 'bewegt.gif', 'image/gif', GIF_1X1)).status, 200);
    assert.equal((await hoch(base, chatId, 'a.jpg', 'image/jpg', Buffer.from('ffd8ffe000104a464946000101', 'hex'))).json.anhang.mime, 'image/jpeg');

    // Falsche Art, gelogene Art, zu groß, kein Base64.
    const exe = await hoch(base, chatId, 'x.exe', 'application/octet-stream', Buffer.from('MZ....'));
    assert.equal(exe.status, 400);
    assert.match(exe.json.error.message, /PNG, JPG, WEBP, GIF und PDF/);
    const luege = await hoch(base, chatId, 'foto.png', 'image/png', PDF_KLEIN);
    assert.equal(luege.status, 400);
    assert.match(luege.json.error.message, /heißt image\/png, ist aber application\/pdf/);
    const gross = Buffer.concat([PNG_1X1, Buffer.alloc(5 * 1024 * 1024)]);
    const zuGross = await hoch(base, chatId, 'riesig.png', 'image/png', gross);
    assert.equal(zuGross.status, 413);
    assert.match(zuGross.json.error.message, /erlaubt sind 5 MB/);
    const kaputt = await anfrage(base, 'POST', `/api/chats/${chatId}/anhaenge`, { name: 'a.png', mime: 'image/png', daten: '%%%' });
    assert.equal(kaputt.status, 400);

    // Ein anderer Chat sieht die Datei nicht.
    const anderer = (await anfrage(base, 'POST', '/api/chats', {})).json.record.id;
    assert.equal((await anfrage(base, 'GET', `/api/chats/${anderer}/anhaenge/${a.id}`)).status, 404);
  });
});

test('Mit PIN: der Blob liegt verschlüsselt in der Ablage, und ausgeliefert wird nur mit Sitzung', async () => {
  await mitKi(async ({ app, base, chatId }) => {
    const pin = await anfrage(base, 'POST', '/api/vault/pin', { pin: '4711' });
    assert.equal(pin.status, 200, pin.text);
    const keks = [].concat(pin.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('nos_s_'));
    assert.ok(keks);
    const r = await hoch(base, chatId, 'rot.png', 'image/png', PNG_1X1, { cookie: keks });
    assert.equal(r.status, 200, r.text);
    const satz = app.store.get(r.json.anhang.id);
    const roh = fs.readFileSync(app.store.files.path(satz.data.hash));
    assert.ok(!roh.includes(PNG_1X1.slice(0, 8)), 'auf dem Stick steht kein PNG im Klartext');
    assert.equal((await anfrage(base, 'GET', r.json.anhang.url)).status, 401);
    const g = await anfrage(base, 'GET', r.json.anhang.url, undefined, { cookie: keks });
    assert.equal(g.status, 200);
    assert.ok(g.roh.equals(PNG_1X1));
  });
});

test('Claude: Bild und PDF gehen als image/document (base64) mit; im Nachrichtensatz steht nur die Kennung', async () => {
  await mitKi(async ({ app, base, claude, chatId }) => {
    const bild = (await hoch(base, chatId, 'rot.png', 'image/png', PNG_1X1)).json.anhang;
    const pdf = (await hoch(base, chatId, 'Vertrag.pdf', 'application/pdf', PDF_KLEIN)).json.anhang;
    claude.weiter(antwort(B.start(), B.text(0, 'Ein rotes Pixel und ein leerer Vertrag.'), B.ende('end_turn')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Was ist das?', anhaenge: [bild.id, pdf.id] });
    assert.equal(r.status, 200);
    assert.ok(!r.ereignisse.some((e) => e.name === 'fehler'), JSON.stringify(r.ereignisse.filter((e) => e.name === 'fehler')));

    const body = letzteStromAnfrage(claude);
    const bloecke = body.messages[0].content;
    assert.deepEqual(bloecke.map((b) => b.type), ['text', 'text', 'image', 'text', 'document', 'text']);
    assert.equal(bloecke[1].text, '[Bild: rot.png]');
    assert.deepEqual(bloecke[2].source, { type: 'base64', media_type: 'image/png', data: PNG_1X1.toString('base64') });
    assert.equal(bloecke[4].source.media_type, 'application/pdf');
    assert.equal(bloecke[4].title, 'Vertrag.pdf');
    assert.equal(bloecke[5].text, 'Was ist das?');
    assert.equal(bloecke[5].cache_control.type, 'ephemeral', 'der Cache-Punkt bleibt auf dem Text');
    assert.deepEqual(medienIn(body).map((m) => [m.art, m.bytes]), [['image', PNG_1X1.length], ['document', PDF_KLEIN.length]]);

    const nutzer = app.store.all('message').find((m) => m.data.role === 'user');
    assert.deepEqual(nutzer.data.anhaenge.map((a) => a.id), [bild.id, pdf.id]);
    assert.ok(!JSON.stringify(nutzer.data).includes(PNG_1X1.toString('base64')), 'kein Base64 im Satz');
    assert.deepEqual(nutzer.data.claude.inhalt.map((b) => b.type), ['text', 'anhang', 'anhang', 'text']);
    const sichtbar = (await nachrichten(base, chatId))[0];
    assert.deepEqual(sichtbar.data.anhaenge.map((a) => a.name), ['rot.png', 'Vertrag.pdf']);

    // Ein Bild ohne Text geht auch; der Chat heißt dann nach dem Bild.
    const chat2 = (await anfrage(base, 'POST', '/api/chats', {})).json.record.id;
    const b2 = (await hoch(base, chat2, 'foto.png', 'image/png', PNG_1X1)).json.anhang;
    claude.weiter(antwort(B.start(), B.text(0, 'Rot.'), B.ende('end_turn')));
    const ohneText = await strom(base, `/api/chats/${chat2}/messages`, { anhaenge: [b2.id] });
    assert.equal(ohneText.status, 200);
    assert.deepEqual(letzteStromAnfrage(claude).messages[0].content.map((b) => b.type), ['text', 'text', 'image']);
    assert.equal(app.store.get(chat2).data.title, 'foto.png');

    // Fremde oder unbekannte Kennungen: vor dem Strom abgelehnt, nichts angelegt.
    const fremd = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'x', anhaenge: [b2.id] });
    assert.equal(fremd.status, 404);
    assert.equal(claude.offen(), 0);
  });
});

test('Grenze je Anfrage: die jüngsten 6 Anhänge gehen als Bild mit, ältere als Text „[Bild: name]“', async () => {
  await mitKi(async ({ base, claude, chatId }) => {
    const ids = [];
    for (let i = 1; i <= 7; i++) ids.push((await hoch(base, chatId, `bild${i}.png`, 'image/png', PNG_1X1)).json.anhang.id);
    claude.weiter(antwort(B.start(), B.text(0, 'Drei.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Erste drei', anhaenge: ids.slice(0, 3) });
    claude.weiter(antwort(B.start(), B.text(0, 'Vier.'), B.ende('end_turn')));
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Noch vier', anhaenge: ids.slice(3) });
    const body = letzteStromAnfrage(claude);
    assert.equal(medienIn(body).length, 6);
    const erste = body.messages[0].content;
    // bild1 ist nur noch Text; bild2 und bild3 gehen mit (je Etikett + Bild).
    assert.deepEqual(erste.slice(1, 7).map((b) => (b.type === 'image' ? 'BILD' : b.text)),
      ['[Bild: bild1.png]', '[Bild: bild2.png]', 'BILD', '[Bild: bild3.png]', 'BILD', 'Erste drei']);
    assert.equal(body.messages[2].content.filter((b) => b.type === 'image').length, 4);
  });
});

test('Gemini: Bilder und PDF als inlineData; GIF kann Gemini nicht lesen und steht als Satz da', async () => {
  await mitKi(async ({ base, gemini, chatId }) => {
    const png = (await hoch(base, chatId, 'rot.png', 'image/png', PNG_1X1)).json.anhang;
    const pdf = (await hoch(base, chatId, 'Vertrag.pdf', 'application/pdf', PDF_KLEIN)).json.anhang;
    const gif = (await hoch(base, chatId, 'bewegt.gif', 'image/gif', GIF_1X1)).json.anhang;
    gemini.weiter(G.antwort(G.B.text('Gesehen.'), G.B.ende('STOP')));
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Schau mal', anhaenge: [png.id, pdf.id, gif.id] });
    assert.ok(!r.ereignisse.some((e) => e.name === 'fehler'), JSON.stringify(r.ereignisse.filter((e) => e.name === 'fehler')));
    const body = gemini.stromAnfragen()[0].body;
    assert.deepEqual(G.medienIn(body), [{ mime: 'image/png', bytes: PNG_1X1.length }, { mime: 'application/pdf', bytes: PDF_KLEIN.length }]);
    const teile = body.contents[0].parts;
    assert.deepEqual(teile[2].inlineData, { mimeType: 'image/png', data: PNG_1X1.toString('base64') });
    assert.ok(teile.some((p) => p.text === '[Bild: bewegt.gif – dieses Format kann Gemini nicht lesen]'));
    assert.equal(teile[teile.length - 1].text, 'Schau mal');
  }, { mit: 'gemini' });
});

test('Der Gemini-Statist lehnt ab, was Google ablehnt (GIF inline, kaputtes Base64) -- die Prüfung ist echt', () => {
  const body = (mime, data) => ({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data } }] }] });
  assert.match(G.medienPruefen(body('image/gif', 'R0lG'), 10), /Unsupported MIME type: image\/gif/);
  assert.match(G.medienPruefen(body('image/png', 'nicht base64!'), 10), /base64/);
  assert.equal(G.medienPruefen(body('image/png', 'iVBORw0KGgo='), 10), null);
  assert.match(G.medienPruefen(body('image/png', 'iVBORw0KGgo='), 21 * 1024 * 1024), /exceeds the limit/);
});

test('aufloesen: Budget je Anbieter, fehlende Datei als Satz, nichts verändert die Nachrichten des Aufrufers', () => {
  const nachrichten = [
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'anhang', id: 'file_a', name: 'a.pdf', mime: 'application/pdf' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: [{ type: 'anhang', id: 'file_weg', name: 'weg.png', mime: 'image/png' }, { type: 'anhang', id: 'file_b', name: 'b.pdf', mime: 'application/pdf' }] },
  ];
  const vorher = JSON.stringify(nachrichten);
  const gross = Buffer.alloc(10 * 1024 * 1024, 1); // 10 MB -> 13,3 MB Base64
  const lesen = (id) => (id === 'file_weg' ? null : { buf: gross, mime: 'application/pdf', name: id });
  const g = anhaenge.aufloesen(nachrichten, { anbieter: 'gemini', lesen });
  assert.equal(JSON.stringify(nachrichten), vorher);
  // Gemini (18 MB Budget): nur das jüngste PDF passt, das ältere steht als Satz da.
  assert.equal(g.mit, 1);
  assert.equal(g.nachrichten[0].content[1].text, '[PDF: a.pdf – zu groß, um es noch einmal mitzuschicken]');
  assert.equal(g.nachrichten[2].content[0].text, '[Bild: weg.png – nicht mehr vorhanden]');
  assert.equal(g.nachrichten[2].content[2].type, 'document');
  // Claude (24 MB): ebenfalls nur eines -- zwei wären 26,7 MB.
  assert.equal(anhaenge.aufloesen(nachrichten, { anbieter: 'claude', lesen }).mit, 1);
  const klein = (id) => (id === 'file_weg' ? null : { buf: Buffer.alloc(1000), mime: 'application/pdf', name: id });
  assert.equal(anhaenge.aufloesen(nachrichten, { anbieter: 'claude', lesen: klein }).mit, 2);
});

test('aufloesen: ein langer Verlauf lässt weniger Platz -- die ganze Anfrage bleibt unter der Grenze des Anbieters', () => {
  const nachrichten = [{ role: 'user', content: [{ type: 'anhang', id: 'file_a', name: 'a.pdf', mime: 'application/pdf' }] }];
  const lesen = () => ({ buf: Buffer.alloc(3 * 1024 * 1024, 1), mime: 'application/pdf', name: 'a.pdf' }); // 4 MB Base64
  assert.equal(anhaenge.aufloesen(nachrichten, { anbieter: 'gemini', lesen, reserve: 1024 * 1024 }).mit, 1);
  // 16 MB Verlauf + 4 MB Base64 wären über Geminis 20 MB: dann als Satz.
  const r = anhaenge.aufloesen(nachrichten, { anbieter: 'gemini', lesen, reserve: 16 * 1024 * 1024 });
  assert.equal(r.mit, 0);
  assert.match(r.nachrichten[0].content[0].text, /zu groß/);
  assert.equal(anhaenge.aufloesen(nachrichten, { anbieter: 'claude', lesen, reserve: 16 * 1024 * 1024 }).mit, 1);
});
