'use strict';

/**
 * Gemini (Google) -- rohes HTTP durch die Netzschleuse.
 *
 * Warum es diesen Anbieter gibt: der Nutzer will kein Geld ausgeben. Googles
 * Gemini-API hat eine kostenlose Stufe ohne Karte (Stand September 2026,
 * siehe docs/CLAUDE-ANBINDUNG.md, Abschnitt 9). Claude bleibt als zweite
 * Wahl. Damit src/models/chat.js für beide Anbieter derselbe bleibt, spricht
 * diese Datei nach außen dieselbe Blockform wie der Claude-Anbieter
 * (text / thinking / tool_use / tool_result) und übersetzt in BEIDE
 * Richtungen in Geminis Teile (text / thought / functionCall /
 * functionResponse). Alles Gemini-Eigene an einem Block (vor allem die
 * `thoughtSignature`) steht unter `block.gemini`, damit der Claude-Anbieter
 * es beim Anbieterwechsel erkennen und weglassen kann.
 *
 * - **Kein SDK, nur generativelanguage.googleapis.com.** Wie bei Claude: jede
 *   Anfrage geht durch `gate.fetch` mit `allowedHosts`, und der Schlüssel
 *   steht nur im Kopf `x-goog-api-key` -- nie in einer Fehlermeldung.
 * - **generateContent, nicht die neue "Interactions API".** Google bewirbt
 *   inzwischen /v1beta/interactions; generateContent ist weiter dokumentiert
 *   und stabil, und nur dafür gibt es hier eine Vorlage.
 * - **Signaturen reisen unverändert.** Gemini 3 hängt an functionCall-Teile
 *   (und an den letzten Teil einer Antwort) eine `thoughtSignature`. Beim
 *   Zurückschicken der Modellantwort müssen alle Teile mit ihren Signaturen
 *   byte-gleich zurück, sonst antwortet die API mit 400.
 * - **Ergebnisse eines Zuges in EINEM user-Content.** Mehrere functionResponse-
 *   Teile in einem Content, genau wie tool_result-Blöcke bei Claude.
 * - **finishReason zuerst.** MAX_TOKENS und SAFETY werden gelesen, bevor
 *   irgendein functionCall ausgeführt wird (das entscheidet chat.js anhand
 *   von `stopReason`, das hier auf Claudes Namen abgebildet ist).
 * - **Werkzeugargumente werden nicht repariert.** Gemini liefert `args`
 *   als Objekt; ist es keines, steht das in `eingabeFehler`, und
 *   src/models/werkzeuge.js prüft danach streng gegen das Schema.
 * - **Fehler als deutsche Sätze**, Rohtexte nur in `details`.
 */

const { NeuralError, ValidationError, AbortedError } = require('../../kernel/errors');
const strom = require('./strom');

/* ------------------------------------------------------------- Konstanten */

const KIND = 'gemini';
const ANBIETER_ID = 'gemini';
const NAME = 'Gemini';
const API_BASIS = 'https://generativelanguage.googleapis.com';
const API_HOST = 'generativelanguage.googleapis.com';

/** Obergrenze für Denken PLUS Antwort (Flash-Modelle erlauben 65 536). */
const MAX_TOKENS = 65536;
const VERBINDEN_MS = 60000;
/** Gemini schickt keine Pings; drei Minuten Stille heißen: die Verbindung ist tot. */
const LEERLAUF_MS = 180000;

const STANDARD_MODELL = 'gemini-3.8-flash';

/**
 * Die wählbaren Modelle -- alle auf der kostenlosen Stufe. `denken` sagt,
 * wie das Modell seinen Denkaufwand nimmt: Gemini 3.x über `thinkingLevel`,
 * Gemini 2.5 über `thinkingBudget`. Preise gibt es nicht: auf der
 * kostenlosen Stufe kostet der Aufruf nichts, Google begrenzt stattdessen die
 * Zahl der Anfragen (je Minute und je Tag).
 */
const MODELLE = Object.freeze({
  'gemini-3.8-flash': Object.freeze({
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    hinweis: 'Kostenlos. Voreinstellung.',
    denken: 'level',
  }),
  'gemini-3.5-flash-lite': Object.freeze({
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    hinweis: 'Schneller, einfacher. Kostenlos.',
    denken: 'level',
  }),
  'gemini-2.5-flash': Object.freeze({
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    hinweis: 'Das ältere Modell. Kostenlos.',
    denken: 'budget',
  }),
});

const EFFORTS = new Set(['low', 'medium', 'high']);
/** thinkingBudget je Aufwand (Gemini 2.5): -1 lässt das Modell selbst entscheiden. */
const BUDGET = Object.freeze({ low: 1024, medium: -1, high: 24576 });

/** Wie eine abgelehnte Antwort im Chat heißt (chat.js liest das je Anbieter). */
const ABLEHNUNG = Object.freeze({
  code: 'GEMINI_ABGELEHNT',
  satz: 'Google hat die Antwort abgelehnt. Formuliere sie anders oder frag etwas anderes.',
});

function modellInfo(id) {
  return MODELLE[id] || MODELLE[STANDARD_MODELL];
}

function istModell(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MODELLE, id);
}

/* --------------------------------------------------------------- Fehler */

class GeminiFehler extends NeuralError {
  constructor(code, satz, opts = {}) {
    super(code, satz, { status: opts.status || 502, details: opts.details || null });
    this.name = 'GeminiFehler';
    if (Number.isFinite(opts.wiederholenNachS)) this.wiederholenNachS = opts.wiederholenNachS;
    if (Array.isArray(opts.teilInhalt)) this.teilInhalt = opts.teilInhalt;
  }
}

/**
 * HTTP-Status und `error.status` der API -> Satz für den Nutzer.
 *
 * Ein ungültiger Schlüssel kommt bei Google mal als 400 ("API key not
 * valid"), mal als 401 UNAUTHENTICATED, mal als 403 PERMISSION_DENIED. Alle
 * drei heißen hier dasselbe -- und nach außen 400, nicht 401: ein falscher
 * Google-Schlüssel ist für diesen Server eine ungültige Eingabe, keine
 * abgelaufene Sitzung.
 */
function fehlerAusAntwort({ status, statusName, text, wiederholenNachS, teilInhalt }) {
  const details = { status: status || null, typ: statusName || null };
  const roh = String(text || '');
  if (roh) details.api = roh.slice(0, 300);
  const opts = (s) => ({ status: s, details, wiederholenNachS, teilInhalt });
  const schluesselSatz = /api key|api_key|apikey/i.test(roh);
  if (status === 401 || statusName === 'UNAUTHENTICATED' || ((status === 400 || status === 403) && schluesselSatz)) {
    return new GeminiFehler('GEMINI_SCHLUESSEL_FALSCH', 'Der Google-Schlüssel stimmt nicht.', opts(400));
  }
  if (status === 403 || statusName === 'PERMISSION_DENIED') {
    return new GeminiFehler('GEMINI_KEINE_BERECHTIGUNG', 'Dieses Google-Konto darf das Modell nicht benutzen.', opts(403));
  }
  if (status === 429 || statusName === 'RESOURCE_EXHAUSTED') {
    const warte = Number.isFinite(wiederholenNachS) && wiederholenNachS > 0 ? ` (in etwa ${Math.ceil(wiederholenNachS)} s)` : '';
    return new GeminiFehler('GEMINI_LIMIT', `Google-Limit erreicht — gleich nochmal${warte}, spätestens morgen geht es kostenlos weiter. Oder Claude wählen.`, opts(429));
  }
  if (status === 503 || statusName === 'UNAVAILABLE') {
    return new GeminiFehler('GEMINI_UEBERLASTET', 'Gemini ist gerade überlastet.', opts(503));
  }
  if (status === 404 || statusName === 'NOT_FOUND') {
    return new GeminiFehler('GEMINI_MODELL_UNBEKANNT', 'Dieses Modell gibt es bei Google nicht (mehr). Wähle in den Einstellungen ein anderes.', opts(502));
  }
  if (status === 413 || /token count|too large|exceeds the maximum|input token/i.test(roh)) {
    return new GeminiFehler('GEMINI_ZU_GROSS', 'Das Gespräch ist zu lang für eine einzelne Anfrage. Fang einen neuen Chat an.', opts(413));
  }
  if (status === 400 || statusName === 'INVALID_ARGUMENT' || statusName === 'FAILED_PRECONDITION') {
    return new GeminiFehler('GEMINI_ANFRAGE_ABGELEHNT', 'Google hat die Anfrage nicht angenommen.', opts(502));
  }
  return new GeminiFehler('GEMINI_FEHLER', 'Bei Gemini ist ein Fehler aufgetreten. Versuch es gleich noch einmal.', opts(502));
}

/** Satz für Transportfehler (Schleuse, Netz, Zeit). */
function transportFehler(err, waechter, teilInhalt) {
  if (err instanceof GeminiFehler) return err;
  if (waechter && waechter.grund === 'aufrufer') return new AbortedError('Die Antwort wurde abgebrochen.');
  const code = err && err.code;
  if (code === 'NETWORK_BLOCKED' && /Sperrliste|Freigabeliste|Hostliste/.test(String(err.message || ''))) {
    return new GeminiFehler('GEMINI_GESPERRT', `Die Schleuse lässt ${API_HOST} nicht durch. Unter Netzwerk freigeben.`, { status: 409, details: { grund: err.message }, teilInhalt });
  }
  if (code === 'NETWORK_BLOCKED') {
    return new GeminiFehler('GEMINI_OFFLINE', 'Offline — Gemini ist gerade nicht erreichbar. Schalte auf „Online“, dann antwortet Gemini.', { status: 409, details: { grund: err.message }, teilInhalt });
  }
  if (code === 'ABORTED' || (err && err.name === 'AbortError')) {
    if (waechter && waechter.grund === 'leerlauf') {
      return new GeminiFehler('GEMINI_STILLE', 'Gemini hat zu lange nichts mehr gesendet; die Antwort ist unvollständig.', { status: 504, teilInhalt });
    }
    if (waechter && waechter.grund === 'verbinden') {
      return new GeminiFehler('GEMINI_ZEIT', 'Gemini hat nicht rechtzeitig geantwortet.', { status: 504, teilInhalt });
    }
    return new AbortedError('Die Antwort wurde abgebrochen.');
  }
  if (code === 'NAME_RESOLUTION_FAILED' || code === 'REQUEST_FAILED' || code === 'NETWORK_TIMEOUT') {
    return new GeminiFehler('GEMINI_KEIN_NETZ', 'Keine Verbindung zu Gemini. Ist das Internet da?', { status: 502, details: { grund: String(err.message || '').slice(0, 300) }, teilInhalt });
  }
  return new GeminiFehler('GEMINI_FEHLER', 'Die Verbindung zu Gemini ist abgebrochen.', { status: 502, details: { grund: String((err && err.message) || err).slice(0, 300) }, teilInhalt });
}

const stromOpts = {
  zuLang: () => new GeminiFehler('GEMINI_FEHLER', 'Gemini hat eine unplausibel lange Zeile gesendet.'),
  unlesbar: () => new GeminiFehler('GEMINI_FEHLER', 'Die Antwort von Gemini ließ sich nicht lesen.'),
};
const { Waechter, auszug, kopfWert } = strom;
const koerper = (res) => strom.koerper(res, stromOpts);

function fehlerAus(text) {
  try {
    const j = JSON.parse(text);
    if (j && j.error && typeof j.error === 'object') {
      return { statusName: j.error.status || null, nachricht: j.error.message || '' };
    }
  } catch { /* kein JSON */ }
  return { statusName: null, nachricht: text };
}

/* ----------------------------------------------------- Werkzeuge übersetzen */

/** Was Geminis Schema-Teilmenge kennt. Alles andere fällt weg (statt 400). */
const SCHEMA_FELDER = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'maxItems', 'minItems',
  'properties', 'required', 'minProperties', 'maxProperties', 'minLength', 'maxLength',
  'pattern', 'example', 'anyOf', 'propertyOrdering', 'default', 'items', 'minimum', 'maximum',
]);

/**
 * Ein Werkzeug-Schema aus src/models/werkzeuge.js (JSON-Schema mit
 * `additionalProperties:false` und `anyOf … null`) in Geminis OpenAPI-
 * Teilmenge übersetzen:
 * - `additionalProperties` gibt es dort nicht (die Strenge kommt aus
 *   `eingabePruefen`, nicht aus dem Server);
 * - `anyOf: [X, {type:'null'}]` wird zu X mit `nullable: true`;
 * - `enum` kennt Gemini nur für Strings. Ein Ganzzahl-enum wird zu
 *   `type: integer` mit den erlaubten Werten in der Beschreibung -- geprüft
 *   wird er weiter streng in eingabePruefen.
 */
function schemaUebersetzen(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'string' };
  let quelle = schema;
  let nullable = false;
  if (Array.isArray(quelle.anyOf)) {
    const ohneNull = quelle.anyOf.filter((a) => !(a && a.type === 'null'));
    nullable = ohneNull.length !== quelle.anyOf.length;
    if (ohneNull.length === 1) {
      quelle = { ...ohneNull[0], description: quelle.description || ohneNull[0].description };
    } else {
      quelle = { ...quelle, anyOf: ohneNull };
    }
  }
  const aus = {};
  for (const [k, v] of Object.entries(quelle)) {
    if (!SCHEMA_FELDER.has(k)) continue;
    if (k === 'properties') {
      aus.properties = {};
      for (const [name, def] of Object.entries(v || {})) aus.properties[name] = schemaUebersetzen(def);
    } else if (k === 'items') {
      aus.items = schemaUebersetzen(v);
    } else if (k === 'anyOf') {
      aus.anyOf = v.map(schemaUebersetzen);
    } else if (k === 'enum') {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) aus.enum = v.slice();
      else if (Array.isArray(v)) {
        const satz = `Erlaubt sind genau: ${v.map((x) => JSON.stringify(x)).join(', ')}.`;
        aus.description = aus.description ? `${aus.description} ${satz}` : satz;
      }
    } else if (k === 'description' && aus.description) {
      aus.description = `${v} ${aus.description}`;
    } else {
      aus[k] = Array.isArray(v) ? v.slice() : v;
    }
  }
  if (!aus.type && !aus.anyOf) aus.type = 'string';
  if (nullable) aus.nullable = true;
  return aus;
}

/**
 * Werkzeugdefinitionen (Claude-Form `{name, description, input_schema}` oder
 * Registry-Form `{name, description, parameters}`) -> functionDeclarations.
 * `strict` und `eager_input_streaming` sind Claude-Eigenheiten und fallen weg.
 */
function werkzeugeUebersetzen(defs) {
  if (!Array.isArray(defs) || !defs.length) return [];
  return defs.map((t) => {
    const fn = t && t.type === 'function' && t.function ? t.function : t;
    if (!fn || typeof fn.name !== 'string' || !fn.name) throw new ValidationError('Jedes Werkzeug braucht einen Namen.');
    const schema = fn.input_schema || fn.parameters;
    return {
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: schema && typeof schema === 'object' ? schemaUebersetzen(schema) : { type: 'object', properties: {} },
    };
  });
}

/* ------------------------------------------------------ Blöcke <-> Teile */

const WEGLASSEN = new Set(['fallback', 'server_tool_use', 'redacted_thinking']);
/** Nutzerblöcke mit Base64-Daten, die als `inlineData` gehen. */
const INLINE_ARTEN = new Set(['image', 'document', 'audio']);

/** Welche Blöcke einer Antwort zurückgehen: alles Eigene, nichts von Claude, was Gemini nicht kennt. */
function bloeckeZurueck(inhalt) {
  const liste = Array.isArray(inhalt) ? inhalt : [];
  const out = [];
  for (const b of liste) {
    if (!b || typeof b !== 'object' || !b.type) continue;
    if (WEGLASSEN.has(b.type) || /_tool_result$/.test(b.type)) continue;
    // Claudes Denkblöcke (mit Anthropic-Signatur, ohne `gemini`) kann Gemini
    // nicht lesen; die eigenen (mit `gemini`) gehen samt Signatur zurück.
    if (b.type === 'thinking' && !b.gemini) continue;
    out.push(JSON.parse(JSON.stringify(b)));
  }
  return out;
}

function werkzeugAufrufe(inhalt) {
  return (Array.isArray(inhalt) ? inhalt : []).filter((b) => b && b.type === 'tool_use');
}

/** Das Ergebnis eines Werkzeugs als Objekt, wie functionResponse.response es will. */
function antwortObjekt(content, istFehler) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  else if (content && typeof content === 'object') text = JSON.stringify(content);
  let wert = null;
  try {
    wert = JSON.parse(text);
  } catch { /* kein JSON: bleibt Text */ }
  if (wert && typeof wert === 'object' && !Array.isArray(wert)) {
    return istFehler && !('error' in wert) ? { error: true, ...wert } : wert;
  }
  return istFehler ? { error: text || 'Fehler' } : { output: text };
}

/**
 * Den Verlauf in Claudes Blockform (so speichert chat.js ihn) in Geminis
 * `contents` übersetzen. `namen` merkt sich je Werkzeugaufruf den Namen,
 * denn functionResponse trägt den Namen, tool_result nur die id.
 */
function nachrichtenUebersetzen(nachrichten) {
  const namen = new Map();
  const contents = [];
  for (const n of Array.isArray(nachrichten) ? nachrichten : []) {
    if (!n || (n.role !== 'user' && n.role !== 'assistant')) continue;
    const bloecke = Array.isArray(n.content) ? n.content : (typeof n.content === 'string' ? [{ type: 'text', text: n.content }] : []);
    const parts = [];
    for (const b of bloecke) {
      if (!b || typeof b !== 'object') continue;
      if (n.role === 'user') {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length) parts.push({ text: b.text });
        else if (INLINE_ARTEN.has(b.type) && b.source && b.source.type === 'base64'
          && typeof b.source.data === 'string' && b.source.data && typeof b.source.media_type === 'string') {
          // Bilder und PDF in Claudes Form (image/document, base64) -- und die
          // Sprachaufnahme fürs Umschreiben (audio, nur hier) -- sind bei
          // Gemini ein Teil `inlineData` (docs: ai.google.dev, Bild- und
          // Dokumentverständnis; höchstens 20 MB je Anfrage, das Budget hält
          // src/models/anhaenge.js ein).
          parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
        } else if (b.type === 'tool_result') {
          const teil = { functionResponse: { name: namen.get(b.tool_use_id) || 'werkzeug', response: antwortObjekt(b.content, b.is_error === true) } };
          const g = namen.get(`id:${b.tool_use_id}`);
          if (g) teil.functionResponse.id = g;
          parts.push(teil);
        }
        continue;
      }
      const g = b.gemini && typeof b.gemini === 'object' ? b.gemini : {};
      let teil = null;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length) teil = { text: b.text };
      else if (b.type === 'thinking' && b.gemini) teil = { text: String(b.thinking || ''), thought: true };
      else if (b.type === 'tool_use') {
        teil = { functionCall: { name: b.name, args: b.input && typeof b.input === 'object' ? b.input : {} } };
        if (typeof g.id === 'string') teil.functionCall.id = g.id;
        namen.set(b.id, b.name);
        if (typeof g.id === 'string') namen.set(`id:${b.id}`, g.id);
      }
      if (!teil) continue;
      if (typeof g.thoughtSignature === 'string') teil.thoughtSignature = g.thoughtSignature;
      parts.push(teil);
    }
    if (!parts.length) continue;
    const rolle = n.role === 'user' ? 'user' : 'model';
    const letzte = contents[contents.length - 1];
    if (letzte && letzte.role === rolle) letzte.parts.push(...parts);
    else contents.push({ role: rolle, parts });
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

function systemUebersetzen(system) {
  if (typeof system === 'string') return system.trim() ? { parts: [{ text: system }] } : null;
  if (!Array.isArray(system)) return null;
  const text = system.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
  return text.trim() ? { parts: [{ text }] } : null;
}

/* ---------------------------------------------------------- Anfrage */

/**
 * Die Anfrage an generateContent. Dieselben Parameter wie beim Claude-
 * Anbieter, damit chat.js sie ohne Fallunterscheidung übergeben kann.
 *
 * @param {object} p
 * @param {string} p.modell
 * @param {Array|string} [p.system]
 * @param {Array} [p.werkzeuge]     eigene Werkzeugdefinitionen
 * @param {Array} p.nachrichten     Verlauf in Claudes Blockform
 * @param {string} [p.effort]       low | medium | high
 * @param {boolean} [p.websuche=true]
 * @param {boolean} [p.denken=true]
 * @param {number} [p.maxTokens]
 * @param {boolean} [p.stream=true]
 * @returns {{body:object, modell:string, stream:boolean, betas:Array}}
 */
function anfrageBauen(p) {
  const info = modellInfo(p.modell);
  if (!Array.isArray(p.nachrichten) || !p.nachrichten.length) {
    throw new ValidationError('Es wurden keine Nachrichten an Gemini übergeben.');
  }
  const contents = nachrichtenUebersetzen(p.nachrichten);
  if (!contents.length) throw new ValidationError('Es wurden keine Nachrichten an Gemini übergeben.');
  const body = { contents };
  const system = systemUebersetzen(p.system);
  if (system) body.systemInstruction = system;
  const tools = [];
  const eigene = werkzeugeUebersetzen(p.werkzeuge);
  if (eigene.length) tools.push({ functionDeclarations: eigene });
  if (p.websuche !== false) tools.push({ googleSearch: {} });
  if (tools.length) body.tools = tools;
  if (eigene.length) body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  const effort = EFFORTS.has(p.effort) ? p.effort : 'medium';
  const generationConfig = {
    maxOutputTokens: Number.isFinite(p.maxTokens) && p.maxTokens > 0 ? Math.floor(p.maxTokens) : MAX_TOKENS,
  };
  if (p.denken === false) {
    // Gemini 3 kann das Denken nicht abschalten, nur klein halten; 2.5 kann es (Budget 0).
    generationConfig.thinkingConfig = info.denken === 'budget' ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
  } else {
    generationConfig.thinkingConfig = info.denken === 'budget'
      ? { includeThoughts: true, thinkingBudget: BUDGET[effort] }
      : { includeThoughts: true, thinkingLevel: effort };
  }
  body.generationConfig = generationConfig;
  return { body, modell: info.id, stream: p.stream !== false, betas: [] };
}

function koepfe(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new GeminiFehler('GEMINI_KEIN_SCHLUESSEL', 'Gemini ist nicht verbunden: es ist kein Schlüssel gespeichert.', { status: 503 });
  }
  return { 'content-type': 'application/json', 'x-goog-api-key': apiKey.trim() };
}

function adresse(basis, modell, stream) {
  const b = String(basis || API_BASIS).trim().replace(/\/+$/, '');
  const m = encodeURIComponent(modellInfo(modell).id);
  let url;
  try {
    url = new URL(`${b}/v1beta/models/${m}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`);
  } catch {
    throw new ValidationError(`Ungültige Gemini-Adresse: ${basis}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ValidationError('Die Gemini-Adresse muss mit https:// beginnen.');
  return url;
}

let zaehler = 0;
/** Eine eigene Kennung je Werkzeugaufruf -- Gemini vergibt nicht immer eine. */
function neueId() {
  zaehler = (zaehler + 1) % 1e6;
  return `gfc_${Date.now().toString(36)}_${zaehler.toString(36)}`;
}

/* ---------------------------------------------------------- Senden */

/**
 * Eine Anfrage senden und den Strom lesen. Ereignisse an `beiEreignis`
 * haben dieselbe Form wie beim Claude-Anbieter:
 *   {art:'start'|'ende', index, block}, {art:'text'|'denken', index, delta},
 *   {art:'zitat', index, zitat}, {art:'hinweis', satz}
 * Die Websuche erscheint als synthetische Blöcke `server_tool_use` /
 * `web_search_tool_result` NUR in den Ereignissen (damit chat.js seine
 * Recherche-Karte zeigt), nicht im Inhalt -- Gemini nimmt sie nicht zurück.
 *
 * @returns {Promise<{id, modell, inhalt:Array, stopReason, stopDetails, usage, eingabeFehler, ms}>}
 */
async function senden({
  basis, apiKey, modell, body, stream = true, gate, scope, purpose, signal, beiEreignis,
  verbindenMs = VERBINDEN_MS, leerlaufMs = LEERLAUF_MS,
} = {}) {
  if (!gate || typeof gate.fetch !== 'function') {
    throw new ValidationError('Interner Fehler: ohne Netzschleuse darf Neural OS Gemini nicht erreichen.');
  }
  if (typeof scope !== 'string' || !scope) {
    throw new ValidationError('Interner Fehler: jeder Gemini-Aufruf braucht einen Scope für die Schleuse.');
  }
  if (!body || typeof body !== 'object') throw new ValidationError('Interner Fehler: keine Anfrage an Gemini.');
  if (signal && signal.aborted) throw new AbortedError('Die Antwort wurde abgebrochen.');
  const url = adresse(basis, modell, stream);
  const kopf = koepfe(apiKey);
  const begonnen = Date.now();
  const waechter = new Waechter(signal);

  const melden = (e) => {
    if (typeof beiEreignis !== 'function') return;
    try { beiEreignis(e); } catch { /* ein kaputter Zuhörer bricht keinen Aufruf ab */ }
  };

  let res;
  try {
    waechter.stellen(verbindenMs, 'verbinden');
    res = await gate.fetch(url.toString(), {
      method: 'POST',
      headers: { ...kopf, accept: stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(body),
      scope,
      purpose: purpose || 'Antwort von Gemini',
      allowedHosts: [url.hostname],
      stream,
      timeoutMs: verbindenMs,
      signal: waechter.signal,
    });
  } catch (err) {
    waechter.aufraeumen();
    throw transportFehler(err, waechter);
  }
  if (!res || typeof res.status !== 'number') {
    waechter.aufraeumen();
    throw new GeminiFehler('GEMINI_FEHLER', 'Die Netzschleuse hat keine verwertbare Antwort geliefert.');
  }

  if (res.status < 200 || res.status >= 300) {
    waechter.stellen(10000, 'leerlauf');
    const text = await auszug(res);
    waechter.aufraeumen();
    const { statusName, nachricht } = fehlerAus(text);
    const ra = Number(kopfWert(res.headers, 'retry-after'));
    const fehler = fehlerAusAntwort({ status: res.status, statusName, text: nachricht, wiederholenNachS: Number.isFinite(ra) ? ra : undefined });
    // Manche Modelle nehmen Google-Suche und eigene Werkzeuge nicht zusammen.
    // Dann ohne Suche noch einmal -- und ehrlich sagen, dass diesmal keine da ist.
    if (res.status === 400 && sucheUndWerkzeuge(body) && /tool/i.test(nachricht)) {
      melden({ art: 'hinweis', satz: 'Ohne Internetsuche: dieses Gemini-Modell nimmt Suche und Werkzeuge nicht zusammen.' });
      const ohne = { ...body, tools: body.tools.filter((t) => !t.googleSearch) };
      return senden({ basis, apiKey, modell, body: ohne, stream, gate, scope, purpose, signal, beiEreignis, verbindenMs, leerlaufMs });
    }
    throw fehler;
  }

  const z = {
    id: null,
    modell: null,
    bloecke: [],
    finishReason: null,
    blockReason: null,
    usage: null,
    eingabeFehler: {},
    suchen: [],
    quellen: new Map(),
    sucheGemeldet: false,
  };
  const teil = () => z.bloecke.filter(Boolean);

  const abschliessen = (block, index) => {
    if (block && !block._zu) {
      block._zu = true;
      melden({ art: 'ende', index, block: sauber(block) });
    }
  };

  const letzterBlock = () => z.bloecke[z.bloecke.length - 1] || null;

  const textTeil = (teilObj, art) => {
    const kind = art === 'denken' ? 'thinking' : 'text';
    const feld = art === 'denken' ? 'thinking' : 'text';
    let block = letzterBlock();
    // Ein neuer Block, wenn die Art wechselt -- oder wenn auf einen Block,
    // der schon eine Signatur trägt, eine zweite träfe: die gehört zu genau
    // einem Teil und darf nicht mit der ersten verschmelzen.
    const zweiteSignatur = !!(block && block.gemini && block.gemini.thoughtSignature && typeof teilObj.thoughtSignature === 'string');
    if (!block || block.type !== kind || zweiteSignatur) {
      if (block) abschliessen(block, z.bloecke.length - 1);
      block = { type: kind, [feld]: '' };
      z.bloecke.push(block);
      melden({ art: 'start', index: z.bloecke.length - 1, block: sauber(block) });
    }
    const delta = typeof teilObj.text === 'string' ? teilObj.text : '';
    block[feld] += delta;
    if (delta) melden({ art, index: z.bloecke.length - 1, delta });
    if (typeof teilObj.thoughtSignature === 'string') {
      block.gemini = { ...(block.gemini || {}), thoughtSignature: teilObj.thoughtSignature };
    } else if (kind === 'thinking' && !block.gemini) {
      // Auch ohne Signatur: als eigener Denkblock markiert, damit der
      // Claude-Anbieter ihn beim Wechsel weglässt.
      block.gemini = {};
    }
  };

  const aufrufTeil = (teilObj) => {
    const vorher = letzterBlock();
    if (vorher) abschliessen(vorher, z.bloecke.length - 1);
    const fc = teilObj.functionCall || {};
    const block = { type: 'tool_use', id: neueId(), name: String(fc.name || ''), input: {}, gemini: {} };
    if (typeof fc.id === 'string' && fc.id) block.gemini.id = fc.id;
    if (typeof teilObj.thoughtSignature === 'string') block.gemini.thoughtSignature = teilObj.thoughtSignature;
    if (fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args)) {
      block.input = fc.args;
    } else if (fc.args !== undefined && fc.args !== null) {
      // Nicht reparieren: was kein Objekt ist, geht als Fehler zurück.
      let roh;
      try { roh = JSON.stringify(fc.args); } catch { roh = String(fc.args); }
      z.eingabeFehler[block.id] = { roh, fehler: 'Die Eingabe ist kein JSON-Objekt.' };
    }
    z.bloecke.push(block);
    const index = z.bloecke.length - 1;
    melden({ art: 'start', index, block: sauber(block) });
    abschliessen(block, index);
  };

  const grounding = (meta) => {
    if (!meta || typeof meta !== 'object') return;
    const fragen = Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries.filter((q) => typeof q === 'string' && q.trim()) : [];
    for (const q of fragen) if (!z.suchen.includes(q)) z.suchen.push(q);
    if (z.suchen.length && !z.sucheGemeldet) {
      z.sucheGemeldet = true;
      melden({ art: 'ende', index: -1, block: { type: 'server_tool_use', id: 'gsuche', name: 'web_search', input: { query: z.suchen.join(' · ') } } });
    }
    const chunks = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
    chunks.forEach((c) => {
      const web = c && c.web;
      if (!web || typeof web.uri !== 'string' || z.quellen.has(web.uri)) return;
      const q = { type: 'web_search_result', url: web.uri, title: typeof web.title === 'string' ? web.title : web.uri };
      z.quellen.set(web.uri, q);
      let index = -1;
      z.bloecke.forEach((b, i) => { if (b && b.type === 'text') index = i; });
      melden({ art: 'zitat', index, zitat: { type: 'web_search_result_location', url: q.url, title: q.title } });
    });
  };

  const verarbeiten = (d) => {
    if (d && d.error && typeof d.error === 'object') {
      throw fehlerAusAntwort({ status: Number(d.error.code) || null, statusName: d.error.status || null, text: d.error.message || '', teilInhalt: teil() });
    }
    if (typeof d.responseId === 'string') z.id = d.responseId;
    if (typeof d.modelVersion === 'string') z.modell = d.modelVersion;
    if (d.usageMetadata && typeof d.usageMetadata === 'object') z.usage = { ...(z.usage || {}), ...d.usageMetadata };
    if (d.promptFeedback && d.promptFeedback.blockReason) z.blockReason = String(d.promptFeedback.blockReason);
    const kandidat = Array.isArray(d.candidates) ? d.candidates[0] : null;
    if (!kandidat) return;
    const parts = kandidat.content && Array.isArray(kandidat.content.parts) ? kandidat.content.parts : [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      if (p.functionCall) aufrufTeil(p);
      else if (typeof p.text === 'string') textTeil(p, p.thought === true ? 'denken' : 'text');
      else if (typeof p.thoughtSignature === 'string') {
        // Eine Signatur ohne Text: an den letzten Block hängen, sonst ginge sie verloren.
        const b = letzterBlock();
        if (b) b.gemini = { ...(b.gemini || {}), thoughtSignature: p.thoughtSignature };
      }
    }
    if (kandidat.finishReason) z.finishReason = String(kandidat.finishReason);
    grounding(kandidat.groundingMetadata);
  };

  try {
    if (!stream) {
      waechter.stellen(leerlaufMs, 'leerlauf');
      const text = await auszug(res, 32 * 1024 * 1024);
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new GeminiFehler('GEMINI_FEHLER', 'Gemini hat unlesbares JSON geschickt.');
      }
      verarbeiten(j);
    } else {
      const leser = new strom.SseLeser(stromOpts);
      waechter.stellen(leerlaufMs, 'leerlauf');
      const ereignis = (evt) => {
        const roh = evt.data.trim();
        if (!roh) return;
        let d;
        try {
          d = JSON.parse(roh);
        } catch {
          throw new GeminiFehler('GEMINI_FEHLER', 'Gemini hat ein unlesbares Ereignis geschickt.', { details: { auszug: roh.slice(0, 200) } });
        }
        verarbeiten(d);
      };
      for await (const stueck of koerper(res)) {
        waechter.stellen(leerlaufMs, 'leerlauf');
        for (const evt of leser.push(stueck)) ereignis(evt);
      }
      for (const evt of leser.ende()) ereignis(evt);
    }
  } catch (err) {
    if (err instanceof GeminiFehler) {
      if (!err.teilInhalt) err.teilInhalt = teil();
      throw err;
    }
    throw transportFehler(err, waechter, teil());
  } finally {
    waechter.aufraeumen();
    if (typeof res.destroy === 'function') {
      try { res.destroy(); } catch { /* schon zu */ }
    }
  }

  const letzte = letzterBlock();
  if (letzte) abschliessen(letzte, z.bloecke.length - 1);
  if (z.sucheGemeldet) {
    melden({ art: 'start', index: -1, block: { type: 'web_search_tool_result', tool_use_id: 'gsuche', content: [...z.quellen.values()] } });
  }

  if (!z.finishReason && !z.blockReason) {
    throw new GeminiFehler('GEMINI_ABGEBROCHEN', 'Die Verbindung zu Gemini ist mitten in der Antwort abgebrochen.', { teilInhalt: teil() });
  }

  const inhalt = teil().map(sauber);
  return {
    id: z.id,
    modell: z.modell,
    inhalt,
    stopReason: stopReasonAus(z, inhalt),
    stopDetails: z.blockReason || (z.finishReason && z.finishReason !== 'STOP') ? { finishReason: z.finishReason, blockReason: z.blockReason } : null,
    usage: verbrauchAus(z),
    eingabeFehler: z.eingabeFehler,
    ms: Date.now() - begonnen,
  };
}

function sucheUndWerkzeuge(body) {
  const tools = Array.isArray(body && body.tools) ? body.tools : [];
  return tools.some((t) => t && t.googleSearch) && tools.some((t) => t && t.functionDeclarations);
}

/** Der Block ohne interne Marker, als Kopie. */
function sauber(block) {
  const { _zu, ...rest } = block;
  void _zu;
  return JSON.parse(JSON.stringify(rest));
}

const ABLEHNUNGEN = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

/** Geminis finishReason auf die Namen, die chat.js von Claude kennt. */
function stopReasonAus(z, inhalt) {
  if (z.blockReason) return 'refusal';
  const f = z.finishReason || 'STOP';
  if (ABLEHNUNGEN.has(f)) return 'refusal';
  if (f === 'MAX_TOKENS') return 'max_tokens';
  if (inhalt.some((b) => b.type === 'tool_use')) return 'tool_use';
  return 'end_turn';
}

/**
 * Der Verbrauch in der Form, die chat.js und der Dienst zählen
 * (Claudes Feldnamen) -- plus die Rohangaben unter `gemini`.
 */
function verbrauchAus(z) {
  const u = z.usage || {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    input_tokens: n(u.promptTokenCount),
    output_tokens: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
    cache_read_input_tokens: n(u.cachedContentTokenCount),
    cache_creation_input_tokens: 0,
    server_tool_use: { web_search_requests: z.suchen.length },
    gemini: { ...u },
  };
}

/** Kosten auf der kostenlosen Stufe: keine. Google begrenzt die Anfragen statt zu berechnen. */
function kostenSchaetzen() {
  return 0;
}

/** Der kleine Probeaufruf beim Speichern eines Schlüssels: ohne Strom, ohne Werkzeuge, wenige Token. */
async function probe({ basis, apiKey, modell, gate, signal, timeoutMs = 30000 } = {}) {
  const { body, modell: id } = anfrageBauen({
    modell,
    nachrichten: [{ role: 'user', content: [{ type: 'text', text: 'Antworte nur mit: OK' }] }],
    maxTokens: 8,
    stream: false,
    websuche: false,
    denken: false,
  });
  const r = await senden({
    basis, apiKey, modell: id, body, stream: false, gate,
    scope: 'global', purpose: 'Google-Schlüssel prüfen', signal, verbindenMs: timeoutMs,
  });
  return { ok: true, modell: r.modell || id, usage: r.usage, ms: r.ms };
}

/* --------------------------------------- allgemeiner chat()-Adapter */

/**
 * Die Nachrichtenform der übrigen Teilsysteme (Agentenlauf, zweiter Blick,
 * Vergleich) in Claudes Blockform bringen -- von dort übersetzt
 * `anfrageBauen` weiter. Die Blöcke der Modellantwort (mit Signaturen)
 * hängen am ERSTEN Werkzeugaufruf (`gemini.bloecke`), damit sie beim
 * nächsten Schritt unverändert zurückgehen.
 */
function uebersetzen(messages) {
  const system = [];
  const out = [];
  let ergebnisse = null;
  const abschliessen = () => {
    if (ergebnisse && ergebnisse.length) out.push({ role: 'user', content: ergebnisse });
    ergebnisse = null;
  };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system') {
      if (text.trim()) system.push(text);
      continue;
    }
    if (m.role === 'tool') {
      if (!ergebnisse) ergebnisse = [];
      ergebnisse.push({ type: 'tool_result', tool_use_id: String(m.toolCallId || ''), content: text || '(leer)' });
      continue;
    }
    abschliessen();
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const mit = calls.find((c) => c && c.gemini && Array.isArray(c.gemini.bloecke));
      if (mit) {
        out.push({ role: 'assistant', content: JSON.parse(JSON.stringify(mit.gemini.bloecke)) });
        continue;
      }
      const content = [];
      if (text.trim()) content.push({ type: 'text', text });
      for (const c of calls) {
        if (!c || !c.name) continue;
        content.push({ type: 'tool_use', id: String(c.id), name: String(c.name), input: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} });
      }
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }
    if (text.trim()) out.push({ role: 'user', content: [{ type: 'text', text }] });
  }
  abschliessen();
  return { system: system.join('\n\n'), nachrichten: out };
}

/**
 * Der Vertrag der Modell-Registry (`registry.chat`): Nachrichten in, Text und
 * Werkzeugaufrufe `{id, name, arguments}` heraus. Ohne Websuche -- die
 * Agenten haben eigene, an ihre Rechte gebundene Werkzeuge.
 */
async function chat({
  basis, apiKey, model, messages, options = {}, tools, gate, scope = 'global', purpose,
  signal, onDelta, timeoutMs,
} = {}) {
  const { system, nachrichten } = uebersetzen(messages);
  if (!nachrichten.length) throw new ValidationError('Es wurden keine Nachrichten an Gemini übergeben.');
  const gebaut = anfrageBauen({
    modell: model,
    system: system || undefined,
    werkzeuge: tools,
    nachrichten,
    effort: EFFORTS.has(options.effort) ? options.effort : 'medium',
    websuche: false,
    maxTokens: Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : undefined,
  });
  // Der allgemeine Weg braucht keinen lesbaren Gedankengang.
  if (gebaut.body.generationConfig.thinkingConfig) delete gebaut.body.generationConfig.thinkingConfig.includeThoughts;
  const r = await senden({
    basis, apiKey, modell: gebaut.modell, body: gebaut.body, stream: true, gate, scope, purpose, signal,
    verbindenMs: Number.isFinite(timeoutMs) ? timeoutMs : VERBINDEN_MS,
    beiEreignis: (e) => {
      if (e.art === 'text' && typeof onDelta === 'function') onDelta(e.delta);
    },
  });
  if (r.stopReason === 'refusal') throw new GeminiFehler(ABLEHNUNG.code, ABLEHNUNG.satz, { status: 422 });
  const text = r.inhalt.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const aufrufe = r.stopReason === 'max_tokens' ? [] : werkzeugAufrufe(r.inhalt);
  const bloecke = bloeckeZurueck(r.inhalt);
  const toolCalls = aufrufe.map((b, i) => {
    const call = { id: b.id, name: b.name, arguments: b.input || {} };
    const fehler = r.eingabeFehler[b.id];
    if (fehler) {
      call.argumentsError = fehler.fehler;
      call.argumentsRaw = fehler.roh.slice(0, 2000);
    }
    if (i === 0) call.gemini = { bloecke };
    return call;
  });
  const u = r.usage || {};
  return {
    content: text,
    toolCalls,
    stats: { promptTokens: u.input_tokens, completionTokens: u.output_tokens, cacheRead: u.cache_read_input_tokens, ms: r.ms },
    finishReason: r.stopReason,
    usage: u,
    modellAntwort: r.modell,
  };
}

module.exports = {
  kind: KIND,
  anbieterId: ANBIETER_ID,
  NAME,
  API_BASIS,
  API_HOST,
  MAX_TOKENS,
  STANDARD_MODELL,
  MODELLE,
  ABLEHNUNG,
  GeminiFehler,
  modellInfo,
  istModell,
  anfrageBauen,
  senden,
  probe,
  chat,
  bloeckeZurueck,
  werkzeugAufrufe,
  kostenSchaetzen,
  fehlerAusAntwort,
  __internals: { schemaUebersetzen, werkzeugeUebersetzen, nachrichtenUebersetzen, uebersetzen, transportFehler, stopReasonAus },
};
