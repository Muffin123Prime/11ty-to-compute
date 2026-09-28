'use strict';

/**
 * Der Gemini-Statist: ein Server auf 127.0.0.1, der die Google-Schnittstelle
 * `POST /v1beta/models/{modell}:streamGenerateContent?alt=sse` (und
 * `:generateContent` für den Probeaufruf) spricht -- in der Form aus
 * docs/CLAUDE-ANBINDUNG.md, Abschnitt 9.
 *
 * Warum es ihn gibt: in dieser Umgebung gibt es keinen echten Google-
 * Schlüssel, und ein Test, der das Internet braucht, beweist nichts, sobald
 * das Netz fehlt. Der Statist prüft zweierlei:
 *   1. was Neural OS SCHICKT (jede Anfrage wird mit Köpfen und Körper
 *      aufgezeichnet, die Tests lesen sie nach), und
 *   2. wie Neural OS mit dem umgeht, was ZURÜCKKOMMT (Text in Stücken,
 *      thought-Teile, functionCall mit thoughtSignature, groundingMetadata,
 *      finishReason MAX_TOKENS/SAFETY, Fehler 400/401/429/503).
 *
 * Was er NICHT beweist: dass Google sich genau so verhält. Die Form stammt
 * aus der Schnittstellenbeschreibung, nicht aus einem Mitschnitt.
 */

const http = require('node:http');

/** Ein SSE-Ereignis, wie Google es sendet: nur `data:`, kein `event:`, mit \r\n. */
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\r\n\r\n`;
}

/** Text in Stücke schneiden (auch mitten in Umlauten -- der Leser muss das aushalten). */
function stuecke(text, n = 3) {
  const out = [];
  const groesse = Math.max(1, Math.ceil(text.length / n));
  for (let i = 0; i < text.length; i += groesse) out.push(text.slice(i, i + groesse));
  return out.length ? out : [''];
}

function chunk(parts, extra = {}) {
  const kandidat = { content: { role: 'model', parts }, index: 0, ...(extra.kandidat || {}) };
  const out = { candidates: [kandidat], responseId: 'resp_statist', modelVersion: extra.modelVersion || 'gemini-3.8-flash' };
  if (extra.usage) out.usageMetadata = extra.usage;
  return out;
}

/** Bausteine für eine geskriptete Antwort. Jeder liefert eine Liste von SSE-Ereignissen. */
const B = {
  /** Sichtbarer Text in Stücken; `signatur` hängt am LETZTEN Stück (so macht es Gemini 3). */
  text(text, { signatur = null } = {}) {
    const teile = stuecke(text);
    return teile.map((s, i) => chunk([{ text: s, ...(signatur && i === teile.length - 1 ? { thoughtSignature: signatur } : {}) }]));
  },
  /** Gedankengang (thought:true) in Stücken. */
  denken(text) {
    return stuecke(text).map((s) => chunk([{ text: s, thought: true }]));
  },
  /** Ein Werkzeugaufruf: EIN Teil mit fertigen args (Gemini streamt sie nicht in Stücken). */
  aufruf(name, args, { signatur = null, id = null } = {}) {
    const teil = { functionCall: { name, args, ...(id ? { id } : {}) } };
    if (signatur) teil.thoughtSignature = signatur;
    return [chunk([teil])];
  },
  /** Google-Suche: groundingMetadata am Kandidaten (Anfragen, Fundstellen, Belege). */
  suche(fragen, quellen, { text = null } = {}) {
    const groundingChunks = quellen.map((q) => ({ web: { uri: q.url, title: q.titel } }));
    const groundingSupports = text ? [{ segment: { startIndex: 0, endIndex: text.length, text }, groundingChunkIndices: quellen.map((_, i) => i) }] : [];
    return [chunk(text ? [{ text }] : [], {
      kandidat: {
        groundingMetadata: {
          webSearchQueries: fragen,
          groundingChunks,
          groundingSupports,
          searchEntryPoint: { renderedContent: '<div>Suche</div>' },
        },
      },
    })];
  },
  /** Das Ende: finishReason und Verbrauch. */
  ende(finishReason = 'STOP', usage = {}) {
    return [chunk([], {
      kandidat: { finishReason },
      usage: { promptTokenCount: 120, candidatesTokenCount: 42, thoughtsTokenCount: 10, totalTokenCount: 172, ...usage },
    })];
  },
  /** Google lehnt die EINGABE ab: kein Kandidat, nur promptFeedback. */
  blockiert(grund = 'SAFETY') {
    return [{ promptFeedback: { blockReason: grund, safetyRatings: [] }, usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 } }];
  },
  /** Ein Fehler mitten im Strom (kommt bei Google als eigenes data-Ereignis). */
  fehler(code = 503, status = 'UNAVAILABLE', message = 'The model is overloaded. Please try again later.') {
    return [{ error: { code, message, status } }];
  },
};

/** Eine vollständige Antwort aus Bausteinen. */
function antwort(...teile) {
  return { sse: teile.flat() };
}

/* ------------------------------------------------ Bilder, PDF, Audio */

/**
 * Welche Inline-Arten Gemini annimmt (ai.google.dev: Bild-, Dokument- und
 * Audioverständnis). GIF gehört NICHT dazu.
 */
const INLINE_ARTEN = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Inline-Daten und Text zusammen höchstens 20 MB je Anfrage. */
const MAX_ANFRAGE_BYTES = 20 * 1024 * 1024;

/** Prüft inlineData-Teile wie die Schnittstelle; gibt die Fehlermeldung oder null. */
function medienPruefen(body, roheLaenge) {
  if (roheLaenge > MAX_ANFRAGE_BYTES) return 'Request payload size exceeds the limit: 20971520 bytes.';
  for (const [i, c] of (Array.isArray(body && body.contents) ? body.contents : []).entries()) {
    for (const [j, p] of (Array.isArray(c && c.parts) ? c.parts : []).entries()) {
      if (!p || !p.inlineData) continue;
      const d = p.inlineData;
      if (typeof d.mimeType !== 'string' || !INLINE_ARTEN.has(d.mimeType)) return `contents[${i}].parts[${j}].inline_data.mime_type: Unsupported MIME type: ${d.mimeType}`;
      if (typeof d.data !== 'string' || !d.data.length || !BASE64.test(d.data)) return `contents[${i}].parts[${j}].inline_data.data: Invalid value (base64)`;
    }
  }
  return null;
}

/** Was eine aufgezeichnete Anfrage an Inline-Daten mitschickte: [{mime, bytes}]. */
function medienIn(body) {
  const out = [];
  for (const c of (Array.isArray(body && body.contents) ? body.contents : [])) {
    for (const p of (Array.isArray(c && c.parts) ? c.parts : [])) {
      if (p && p.inlineData) out.push({ mime: p.inlineData.mimeType, bytes: Buffer.from(String(p.inlineData.data || ''), 'base64').length });
    }
  }
  return out;
}

/** Eine HTTP-Fehlerantwort in Googles Form. */
function httpFehler(code, status, message, koepfe = {}) {
  return { status: code, json: { error: { code, message, status } }, koepfe };
}

/**
 * Den Statisten starten.
 *
 * @param {object} [opts]
 * @param {string} [opts.schluessel]  der einzige Schlüssel, der gilt
 * @param {number} [opts.schluesselFehlerStatus]  wie ein falscher Schlüssel abgelehnt wird (400, 401 oder 403)
 *
 * `weiter(a, b, …)` stellt die nächsten Antworten in die Schlange. Eine
 * Antwort ist `{sse:[…]}`, `{status, json}` oder `{sse, abbrechenNach:n}`.
 * Ist die Schlange leer, kommt ein 500 -- ein Test, der mehr Anfragen
 * auslöst als er erwartet, fällt auf.
 */
function starten({ schluessel = 'AIzaSyStatist0123456789abcdefghijklmnop', schluesselFehlerStatus = 400 } = {}) {
  const anfragen = [];
  const schlange = [];
  // Antworten für Aufrufe OHNE Strom (generateContent), z. B. das Umschreiben
  // einer Sprachaufnahme. Leer: die kleine Antwort des Probeaufrufs.
  const ohneStrom = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const m = /^\/v1beta\/models\/([^:/]+):(streamGenerateContent|generateContent)(\?alt=sse)?$/.exec(req.url || '');
      const eintrag = {
        methode: req.method, pfad: req.url, koepfe: { ...req.headers }, body,
        modell: m ? decodeURIComponent(m[1]) : null,
        stream: !!(m && m[2] === 'streamGenerateContent'),
      };
      anfragen.push(eintrag);
      const json = (code, obj, koepfe = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...koepfe });
        res.end(JSON.stringify(obj));
      };

      if (req.method !== 'POST' || !m || (m[2] === 'streamGenerateContent' && !m[3])) {
        json(404, { error: { code: 404, message: `Not found: ${req.url}`, status: 'NOT_FOUND' } });
        return;
      }
      if (req.headers['x-goog-api-key'] !== schluessel) {
        // Google meldet einen falschen Schlüssel mal so, mal so -- der Test wählt.
        if (schluesselFehlerStatus === 401) json(401, { error: { code: 401, message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.', status: 'UNAUTHENTICATED' } });
        else if (schluesselFehlerStatus === 403) json(403, { error: { code: 403, message: 'API key not valid. Please pass a valid API key.', status: 'PERMISSION_DENIED' } });
        else json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(MODELLE_BEKANNT, eintrag.modell)) {
        json(404, { error: { code: 404, message: `models/${eintrag.modell} is not found for API version v1beta`, status: 'NOT_FOUND' } });
        return;
      }
      const medienFehler = medienPruefen(body, Buffer.byteLength(text, 'utf8'));
      if (medienFehler) {
        json(400, { error: { code: 400, message: medienFehler, status: 'INVALID_ARGUMENT' } });
        return;
      }
      if (!eintrag.stream && ohneStrom.length) {
        const n = ohneStrom.shift();
        if (n.status) { json(n.status, n.json || {}, n.koepfe || {}); return; }
        json(200, {
          candidates: [{ content: { role: 'model', parts: [{ text: n.text || '' }] }, finishReason: n.finishReason || 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12, totalTokenCount: 52 },
          modelVersion: eintrag.modell, responseId: 'resp_ohne_strom',
        });
        return;
      }
      // Der Probeaufruf: ohne Strom, eine kleine Antwort.
      if (!eintrag.stream) {
        json(200, {
          candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, totalTokenCount: 14 },
          modelVersion: eintrag.modell, responseId: 'resp_probe',
        });
        return;
      }
      const naechste = schlange.shift();
      if (!naechste) {
        json(500, { error: { code: 500, message: 'Statist: keine Antwort mehr in der Schlange', status: 'INTERNAL' } });
        return;
      }
      if (naechste.status) {
        json(naechste.status, naechste.json || {}, naechste.koepfe || {});
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
        stromAnfragen: () => anfragen.filter((a) => a.stream),
        weiter: (...antworten) => schlange.push(...antworten),
        /** Nächste Antworten ohne Strom: {text, finishReason?} oder {status, json}. */
        weiterOhneStrom: (...antworten) => ohneStrom.push(...antworten),
        offen: () => schlange.length,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

const MODELLE_BEKANNT = { 'gemini-3.8-flash': 1, 'gemini-3.7-flash': 1, 'gemini-3.5-flash-lite': 1, 'gemini-2.5-flash': 1 };

module.exports = { starten, B, antwort, httpFehler, sse, medienIn, medienPruefen };
