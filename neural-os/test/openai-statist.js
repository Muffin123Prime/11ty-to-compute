'use strict';

/**
 * Der Statist für OpenAI-kompatible Anbieter (Mistral, Groq, OpenRouter,
 * OVHcloud, OpenAI): ein Server auf 127.0.0.1, der
 *   GET  /v1/models            (Liste; mit Schlüssel, außer `oeffentlich`)
 *   GET  /v1/key               (OpenRouter: prüft den Schlüssel)
 *   POST /v1/chat/completions  (mit und ohne Strom)
 * spricht -- in der Form, die die Anbieter dokumentieren (Server-Sent Events,
 * je Ereignis ein chat.completion.chunk, am Ende `data: [DONE]`;
 * Werkzeugaufrufe in Stücken über `delta.tool_calls[].function.arguments`).
 *
 * Was er NICHT beweist: dass ein Anbieter sich genau so verhält. Geprüft
 * gegen das Echte ist nur, was ohne Schlüssel geht (OVHcloud hat am
 * 01.10.2026 ohne Schlüssel echt geantwortet, siehe docs/CLAUDE-ANBINDUNG.md
 * Abschnitt 10).
 */

const http = require('node:http');

function chunk(delta, { finish = null, model = 'statist-modell', usage = null } = {}) {
  const out = { id: 'chatcmpl-statist', object: 'chat.completion.chunk', created: 1790000000, model, choices: [{ index: 0, delta, finish_reason: finish }] };
  if (usage) out.usage = usage;
  return out;
}

/** Bausteine: jeder liefert eine Liste von Ereignissen (Objekte oder der String '[DONE]'). */
const B = {
  text(text, { n = 3 } = {}) {
    const out = [];
    const g = Math.max(1, Math.ceil(text.length / n));
    for (let i = 0; i < text.length; i += g) out.push(chunk({ role: 'assistant', content: text.slice(i, i + g) }));
    return out;
  },
  denken(text) {
    return [chunk({ role: 'assistant', reasoning: text })];
  },
  /** Ein Werkzeugaufruf; die Argumente kommen in Stücken (wie bei den Anbietern). */
  aufruf(name, args, { id = 'call_statist1', index = 0 } = {}) {
    const roh = typeof args === 'string' ? args : JSON.stringify(args);
    const mitte = Math.floor(roh.length / 2);
    return [
      chunk({ role: 'assistant', tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }),
      chunk({ tool_calls: [{ index, function: { arguments: roh.slice(0, mitte) } }] }),
      chunk({ tool_calls: [{ index, function: { arguments: roh.slice(mitte) } }] }),
    ];
  },
  ende(finish = 'stop') {
    return [chunk({}, { finish, usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 } }), '[DONE]'];
  },
};

function antwort(...teile) {
  return { sse: teile.flat() };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.schluessel]   der eine Schlüssel, der gilt
 * @param {boolean} [opts.ohneSchluessel]  wie OVHcloud: kein Kopf nötig
 * @param {Array} [opts.modelle]        was /models nennt: Strings oder Objekte
 * @param {boolean} [opts.oeffentlich]  /models ohne Schlüssel (OpenRouter, OVH)
 * @param {object} [opts.falsch]        {status, json}: so sieht ein falscher Schlüssel aus
 */
function starten({
  schluessel = 'statist-schluessel-0123456789abcdef', ohneSchluessel = false, modelle = ['statist-modell'],
  oeffentlich = false, falsch = { status: 401, json: { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } } },
} = {}) {
  const anfragen = [];
  const schlange = [];
  const ohneStrom = [];
  const server = http.createServer((req, res) => {
    const teile = [];
    req.on('data', (c) => teile.push(c));
    req.on('end', () => {
      const text = Buffer.concat(teile).toString('utf8');
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const pfad = (req.url || '').split('?')[0];
      const eintrag = { methode: req.method, pfad, koepfe: { ...req.headers }, body, stream: !!(body && body.stream) };
      anfragen.push(eintrag);
      const json = (code, obj, koepfe = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...koepfe });
        res.end(JSON.stringify(obj));
      };
      const auth = req.headers.authorization || '';
      const gilt = ohneSchluessel || auth === `Bearer ${schluessel}`;
      if (req.method === 'GET' && pfad === '/v1/models') {
        if (!oeffentlich && !gilt) { json(falsch.status, falsch.json); return; }
        json(200, { object: 'list', data: modelle.map((m) => (typeof m === 'string' ? { id: m, object: 'model' } : m)) });
        return;
      }
      if (req.method === 'GET' && pfad === '/v1/key') {
        if (!gilt) { json(401, { error: { message: 'User not found.', code: 401 } }); return; }
        json(200, { data: { label: 'statist', is_free_tier: true } });
        return;
      }
      if (req.method !== 'POST' || pfad !== '/v1/chat/completions') {
        json(404, { error: { message: `Not found: ${req.url}` } });
        return;
      }
      if (!gilt) { json(falsch.status, falsch.json); return; }
      if (!eintrag.stream) {
        const n = ohneStrom.shift();
        if (n && n.status) { json(n.status, n.json || {}, n.koepfe || {}); return; }
        json(200, {
          id: 'chatcmpl-probe', object: 'chat.completion', model: body && body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: (n && n.text) || 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        });
        return;
      }
      const naechste = schlange.shift();
      if (!naechste) { json(500, { error: { message: 'Statist: keine Antwort mehr in der Schlange' } }); return; }
      if (naechste.status) { json(naechste.status, naechste.json || {}, naechste.koepfe || {}); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      // Ein Kommentar wie bei OpenRouter (": OPENROUTER PROCESSING") -- der Leser muss ihn überspringen.
      res.write(': STATIST PROCESSING\n\n');
      for (const e of naechste.sse) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        schluessel,
        anfragen,
        stromAnfragen: () => anfragen.filter((a) => a.pfad === '/v1/chat/completions' && a.stream),
        proben: () => anfragen.filter((a) => a.pfad === '/v1/chat/completions' && !a.stream),
        weiter: (...a) => schlange.push(...a),
        weiterOhneStrom: (...a) => ohneStrom.push(...a),
        close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

module.exports = { starten, B, antwort, chunk };
