'use strict';

/**
 * Der Statist: ein Server auf 127.0.0.1, der die Anthropic-Schnittstelle
 * (`POST /v1/messages`) spricht -- so, wie docs/CLAUDE-ANBINDUNG.md sie
 * beschreibt, mit Server-Sent Events in der echten Reihenfolge.
 *
 * Warum es ihn gibt: in dieser Umgebung gibt es keinen echten Schlüssel,
 * und ein Test, der das Internet braucht, beweist nichts, sobald das Netz
 * fehlt. Der Statist prüft deshalb zweierlei:
 *   1. was Neural OS SCHICKT (jede Anfrage wird mit Köpfen und Körper
 *      aufgezeichnet, die Tests lesen sie nach), und
 *   2. wie Neural OS mit dem umgeht, was ZURÜCKKOMMT (die Antworten sind
 *      pro Test geskriptet: Text, Denken, Werkzeugaufrufe in Stücken,
 *      Websuche, pause_turn, refusal, Fehler mitten im Strom).
 *
 * Was er NICHT beweist: dass Anthropic selbst sich genau so verhält. Die
 * Form stammt aus der Schnittstellenbeschreibung, nicht aus einem Mitschnitt.
 */

const http = require('node:http');

/** Ein SSE-Ereignis in der Form, die Anthropic sendet: `event:` plus `data:`. */
function sse(obj) {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/** Text in Stücke schneiden (auch mitten in Umlauten -- der Leser muss das aushalten). */
function stuecke(text, n = 3) {
  const out = [];
  const groesse = Math.max(1, Math.ceil(text.length / n));
  for (let i = 0; i < text.length; i += groesse) out.push(text.slice(i, i + groesse));
  return out.length ? out : [''];
}

/** Bausteine für eine geskriptete Antwort. Jeder liefert eine Liste von Ereignissen. */
const B = {
  start({ id = 'msg_statist', model = 'claude-opus-5', usage = {} } = {}) {
    return [{
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model, content: [], stop_reason: null,
        usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
      },
    }];
  },
  text(index, text, { zitate = [] } = {}) {
    const ev = [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }];
    for (const s of stuecke(text)) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: s } });
    for (const z of zitate) ev.push({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation: z } });
    ev.push({ type: 'content_block_stop', index });
    return ev;
  },
  denken(index, text, signatur = 'sig_statist') {
    const ev = [{ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }];
    for (const s of stuecke(text)) ev.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: s } });
    ev.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: signatur } });
    ev.push({ type: 'content_block_stop', index });
    return ev;
  },
  /** `eingabe` als Objekt (wird zu JSON) oder als roher String (auch kaputt). */
  werkzeug(index, id, name, eingabe) {
    const roh = typeof eingabe === 'string' ? eingabe : JSON.stringify(eingabe);
    const ev = [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }];
    for (const s of stuecke(roh, 4)) ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: s } });
    ev.push({ type: 'content_block_stop', index });
    return ev;
  },
  serverWerkzeug(index, id, name, eingabe) {
    const roh = JSON.stringify(eingabe);
    const ev = [{ type: 'content_block_start', index, content_block: { type: 'server_tool_use', id, name, input: {} } }];
    for (const s of stuecke(roh, 2)) ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: s } });
    ev.push({ type: 'content_block_stop', index });
    return ev;
  },
  suchErgebnis(index, toolUseId, inhalt) {
    return [
      { type: 'content_block_start', index, content_block: { type: 'web_search_tool_result', tool_use_id: toolUseId, content: inhalt } },
      { type: 'content_block_stop', index },
    ];
  },
  ersatz(index, von = 'claude-opus-5', zu = 'claude-opus-4-8') {
    return [
      { type: 'content_block_start', index, content_block: { type: 'fallback', from: { model: von }, to: { model: zu } } },
      { type: 'content_block_stop', index },
    ];
  },
  ende(stopReason, usage = {}) {
    return [
      { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42, ...usage } },
      { type: 'message_stop' },
    ];
  },
  ping() {
    return [{ type: 'ping' }];
  },
  fehler(typ = 'overloaded_error', nachricht = 'Overloaded') {
    return [{ type: 'error', error: { type: typ, message: nachricht } }];
  },
};

/** Eine vollständige Antwort aus Bausteinen. */
function antwort(...teile) {
  return { sse: teile.flat() };
}

/**
 * Den Statisten starten.
 *
 * @param {object} [opts]
 * @param {string} [opts.schluessel]  der einzige Schlüssel, der gilt
 * @returns {Promise<{url:string, anfragen:Array, weiter:(...a:object[])=>void, close:()=>Promise<void>}>}
 *
 * `weiter(a, b, …)` stellt die nächsten Antworten in die Schlange. Eine
 * Antwort ist `{sse:[…]}`, `{status, json}` oder `{sse, abbrechenNach:n}`
 * (Verbindung nach n Ereignissen hart trennen). Ist die Schlange leer, kommt
 * ein 500 -- ein Test, der mehr Anfragen auslöst als er erwartet, fällt auf.
 */
function starten({ schluessel = 'sk-ant-statist-0123456789abcdef' } = {}) {
  const anfragen = [];
  const schlange = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const eintrag = { methode: req.method, pfad: req.url, koepfe: { ...req.headers }, body };
      anfragen.push(eintrag);

      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
        return;
      }
      if (req.headers['x-api-key'] !== schluessel) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      if (req.headers['anthropic-version'] !== '2023-06-01') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version fehlt' } }));
        return;
      }
      // Der Probeaufruf: ohne Strom, eine kleine Antwort.
      if (body && body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_probe', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 2 },
        }));
        return;
      }
      const naechste = schlange.shift();
      if (!naechste) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Statist: keine Antwort mehr in der Schlange' } }));
        return;
      }
      if (naechste.status) {
        res.writeHead(naechste.status, { 'content-type': 'application/json', ...(naechste.koepfe || {}) });
        res.end(JSON.stringify(naechste.json || {}));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const liste = naechste.sse;
      let i = 0;
      const schreiben = () => {
        if (naechste.abbrechenNach !== undefined && i >= naechste.abbrechenNach) {
          res.destroy();
          return;
        }
        if (i >= liste.length) {
          res.end();
          return;
        }
        // Absichtlich mitten im Ereignis getrennt -- in BYTES, also auch mitten
        // in einem Umlaut --, damit der Zerleger zeigen muss, dass er Pakete
        // und UTF-8-Zeichen wieder zusammensetzt.
        const roh = Buffer.from(sse(liste[i++]), 'utf8');
        let mitte = Math.floor(roh.length / 2);
        // Wenn möglich genau in ein Mehrbyte-Zeichen hinein schneiden.
        for (let j = mitte; j < roh.length - 1; j++) {
          if ((roh[j] & 0xc0) === 0x80) { mitte = j; break; }
        }
        res.write(roh.slice(0, mitte));
        setImmediate(() => {
          res.write(roh.slice(mitte));
          setImmediate(schreiben);
        });
      };
      schreiben();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        schluessel,
        anfragen,
        /** Nur die Anfragen mit Strom (also ohne den Probeaufruf). */
        stromAnfragen: () => anfragen.filter((a) => a.body && a.body.stream === true),
        weiter: (...antworten) => schlange.push(...antworten),
        offen: () => schlange.length,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

module.exports = { starten, B, antwort, sse };
