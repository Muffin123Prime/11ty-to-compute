'use strict';

/**
 * Gemeinsame Helfer für die Tests der interaktiven Antworten
 * (test/antwort-fassungen, anhaenge, transkribieren): die ECHTE Anwendung
 * mit einem oder beiden Statisten, HTTP-Aufrufe und ein SSE-Leser. Keine
 * Testdatei (endet nicht auf .test.js); kein Aufruf verlässt 127.0.0.1.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { tempHome } = require('./harness');
const claudeStatist = require('./claude-statist');
const geminiStatist = require('./gemini-statist');
const { createApp, seedIfEmpty } = require('../src/app');

function anfrage(base, method, urlPath, body, koepfe = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        ...koepfe,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const roh = Buffer.concat(chunks);
        const text = roh.toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, roh });
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
 * Anwendung mit Statisten. `mit`: 'claude' | 'gemini' | 'beide' (welche
 * Schlüssel verbunden werden; bei 'beide' ist der zuerst verbundene aktiv,
 * `aktiv` wählt ausdrücklich).
 */
async function mitKi(fn, { mit = 'claude', aktiv = null, verbinden = true } = {}) {
  const { home, cleanup } = tempHome('nos-antwort');
  const claude = await claudeStatist.starten();
  const gemini = await geminiStatist.starten();
  let app = null;
  try {
    app = await createApp({
      home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
      claudeBasis: claude.url, geminiBasis: gemini.url,
    });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    if (verbinden && (mit === 'claude' || mit === 'beide')) {
      const r = await anfrage(base, 'POST', '/api/claude/schluessel', { schluessel: claude.schluessel });
      assert.equal(r.status, 200, r.text);
    }
    if (verbinden && (mit === 'gemini' || mit === 'beide')) {
      const r = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: gemini.schluessel });
      assert.equal(r.status, 200, r.text);
    }
    if (aktiv) {
      const r = await anfrage(base, 'PATCH', '/api/ki', { anbieter: aktiv });
      assert.equal(r.status, 200, r.text);
    }
    const chat = await anfrage(base, 'POST', '/api/chats', {});
    await fn({ app, base, home, claude, gemini, chatId: chat.json.record.id });
  } finally {
    if (app) await app.close().catch(() => {});
    await claude.close();
    await gemini.close();
    cleanup();
  }
}

const nachrichten = async (base, chatId) => (await anfrage(base, 'GET', `/api/chats/${chatId}/messages`)).json.items;

/** Ein kleines, echtes PNG (1x1, rot) -- für Bytes, die der Server als PNG erkennt. */
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478da63f8cfc0000003010100c9fe92ef0000000049454e44ae426082',
  'hex',
);
/** Ein GIF (1x1). */
const GIF_1X1 = Buffer.from('47494638396101000100800000ff000000000021f90401000000002c00000000010001000002024401003b', 'hex');
/** Ein kleines, gültiges PDF (eine leere Seite). */
const PDF_KLEIN = Buffer.from([
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
  'trailer << /Root 1 0 R >>',
  '%%EOF',
].join('\n'), 'latin1');

/** Eine WAV-Aufnahme (16 kHz, mono, 16 bit) mit `sekunden` Stille. */
function wav(sekunden, rate = 16000) {
  const daten = Math.round(sekunden * rate) * 2;
  const buf = Buffer.alloc(44 + daten);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + daten, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byteRate
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(daten, 40);
  return buf;
}

module.exports = {
  anfrage, strom, arten, textVon, mitKi, nachrichten, PNG_1X1, GIF_1X1, PDF_KLEIN, wav,
};
