'use strict';

/**
 * Claude (Anthropic) -- rohes HTTP durch die Netzschleuse.
 *
 * Vorlage und Vertrag: docs/CLAUDE-ANBINDUNG.md. Was dort steht, gilt hier;
 * dieser Kopf sagt nur, WARUM die Datei so gebaut ist.
 *
 * - **Kein SDK.** Neural OS startet vom Stick ohne `npm install`, und jede
 *   Verbindung muss durch `src/net/gate.js`. Ein SDK brächte seinen eigenen
 *   HTTP-Stapel mit und ginge an der Schleuse vorbei. Deshalb spricht diese
 *   Datei `POST /v1/messages` selbst -- und sonst nichts: sie ruft nie
 *   `fetch`, `http` oder einen Socket direkt auf.
 * - **Nur api.anthropic.com.** Jeder Aufruf gibt der Schleuse eine eigene
 *   Obergrenze mit (`allowedHosts`). Sie wird bei jeder Weiterleitung neu
 *   geprüft; ein Schlüssel im Kopf `x-api-key` kann so nie einer Umleitung
 *   auf einen fremden Host folgen (die Schleuse entfernt beim Hostwechsel nur
 *   `authorization` und `cookie`, `x-api-key` kennt sie nicht).
 * - **Ein echter SSE-Leser.** Eine `data:`-Zeile wird von TCP regelmäßig
 *   mitten durchgeschnitten, UTF-8-Zeichen ebenso. Darum ein inkrementeller
 *   Zerleger mit EINEM durchlaufenden TextDecoder, kein `split('data: ')`.
 * - **`stop_reason` zuerst.** `senden()` liefert Inhalt UND Grund; wer den
 *   Inhalt liest, bevor er den Grund geprüft hat, führt bei `refusal` oder
 *   `max_tokens` womöglich ein halb gestreamtes Werkzeug aus.
 * - **Werkzeugeingaben werden streng gelesen.** Mit `eager_input_streaming`
 *   prüft der Server die Eingabe nicht mehr. Hier wird sie mit `JSON.parse`
 *   gelesen; was nicht parst, wird NICHT still repariert, sondern mit dem
 *   Rohtext als Fehler gemeldet (`eingabeFehler`). Die Schemaprüfung macht
 *   der Aufrufer (src/models/werkzeuge.js).
 * - **Fehler als deutsche Sätze.** Englische Rohtexte der API landen nur in
 *   `details` (fürs Protokoll), nie in `message`, denn `message` zeigt die
 *   Oberfläche an.
 * - **Kein Schlüssel im Protokoll.** Er steht nur im Kopf der Anfrage. Keine
 *   Fehlermeldung, kein `details` und kein Log enthält ihn.
 */

const {
  NeuralError,
  ValidationError,
  AbortedError,
} = require('../../kernel/errors');

/* ------------------------------------------------------------- Konstanten */

const KIND = 'anthropic';
const API_BASIS = 'https://api.anthropic.com';
const API_HOST = 'api.anthropic.com';
const API_VERSION = '2023-06-01';
/** Gehört exakt zu `fallbacks: "default"`; die Listenform hätte einen anderen Kopf. */
const BETA_ERSATZMODELL = 'server-side-fallback-2026-07-01';

/** Obergrenze für Denken PLUS Antwort. Beim Streamen großzügig, sonst bricht die Antwort ab. */
const MAX_TOKENS = 64000;
/** Bis die Antwortköpfe da sind. */
const VERBINDEN_MS = 60000;
/**
 * Wie lange der Strom schweigen darf. Anthropic schickt zwischendurch `ping`;
 * drei Minuten ohne ein einziges Byte heißt: die Verbindung ist tot.
 */
const LEERLAUF_MS = 180000;
const MAX_ZEILE = 16 * 1024 * 1024;

const STANDARD_MODELL = 'claude-opus-5';

/**
 * Die wählbaren Modelle -- genau diese IDs, ohne Datumsanhang.
 *
 * Nicht jedes Modell kann alles: Haiku 4.5 kennt weder adaptives Denken noch
 * `effort` und nur die ältere Websuche. Die Fähigkeiten stehen deshalb hier
 * und nicht verstreut als `if (modell === …)` im Code. Preise in US-Dollar
 * je Million Token (Stand der Referenz, 2026) -- sie dienen nur der
 * Verbrauchsschätzung und heißen in der Oberfläche auch so.
 */
const MODELLE = Object.freeze({
  'claude-opus-5': Object.freeze({
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    hinweis: 'Das stärkste Modell. Voreinstellung.',
    adaptiv: true,
    effort: true,
    ersatzmodell: true,
    suche: 'web_search_20260209',
    abruf: 'web_fetch_20260209',
    preis: { ein: 5, aus: 25 },
  }),
  'claude-sonnet-5': Object.freeze({
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    hinweis: 'Günstiger, für den Alltag fast genauso gut.',
    adaptiv: true,
    effort: true,
    ersatzmodell: false,
    suche: 'web_search_20260209',
    abruf: 'web_fetch_20260209',
    preis: { ein: 2, aus: 10 },
  }),
  'claude-haiku-4-5': Object.freeze({
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    hinweis: 'Am günstigsten und schnellsten, denkt nicht lange nach.',
    adaptiv: false,
    effort: false,
    ersatzmodell: false,
    suche: 'web_search_20250305',
    abruf: 'web_fetch_20250910',
    preis: { ein: 1, aus: 5 },
  }),
});

/** Websuche: 10 US-Dollar je 1000 Suchen. */
const PREIS_JE_SUCHE = 0.01;

const EFFORTS = new Set(['low', 'medium', 'high']);

function modellInfo(id) {
  return MODELLE[id] || MODELLE[STANDARD_MODELL];
}

function istModell(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MODELLE, id);
}

/* --------------------------------------------------------------- Fehler */

/**
 * Ein Fehler von oder auf dem Weg zu Claude. `message` ist immer ein
 * deutscher Satz für die Oberfläche; `code` ist stabil und maschinenlesbar.
 */
class ClaudeFehler extends NeuralError {
  constructor(code, satz, opts = {}) {
    super(code, satz, { status: opts.status || 502, details: opts.details || null });
    this.name = 'ClaudeFehler';
    if (Number.isFinite(opts.wiederholenNachS)) this.wiederholenNachS = opts.wiederholenNachS;
    if (Array.isArray(opts.teilInhalt)) this.teilInhalt = opts.teilInhalt;
  }
}

/**
 * HTTP-Status und Fehlertyp der API -> Satz für den Nutzer.
 *
 * Der HTTP-Status NACH außen ist bewusst ein anderer als der von Anthropic:
 * ein falscher Claude-Schlüssel ist für diesen Server eine ungültige Eingabe
 * (400), kein "du bist nicht angemeldet" (401) -- sonst hielte die
 * Oberfläche einen falschen Claude-Schlüssel für eine abgelaufene Sitzung.
 */
function fehlerAusAntwort({ status, typ, text, wiederholenNachS, teilInhalt }) {
  const details = { status: status || null, typ: typ || null };
  if (text) details.api = String(text).slice(0, 300);
  const opts = (s) => ({ status: s, details, wiederholenNachS, teilInhalt });
  if (status === 401 || typ === 'authentication_error') {
    return new ClaudeFehler('CLAUDE_SCHLUESSEL_FALSCH', 'Der Claude-Schlüssel stimmt nicht.', opts(400));
  }
  if (status === 403 || typ === 'permission_error') {
    return new ClaudeFehler('CLAUDE_KEINE_BERECHTIGUNG', 'Dieses Konto darf das Modell nicht benutzen.', opts(403));
  }
  if (status === 402 || typ === 'billing_error') {
    return new ClaudeFehler('CLAUDE_GUTHABEN', 'Das Guthaben bei Anthropic reicht nicht. Unter console.anthropic.com aufladen.', opts(402));
  }
  if (status === 429 || typ === 'rate_limit_error') {
    const warte = Number.isFinite(wiederholenNachS) && wiederholenNachS > 0 ? ` (in etwa ${Math.ceil(wiederholenNachS)} s)` : '';
    return new ClaudeFehler('CLAUDE_ZU_VIELE_ANFRAGEN', `Kurz zu viele Anfragen — gleich nochmal${warte}.`, opts(429));
  }
  if (status === 529 || typ === 'overloaded_error') {
    return new ClaudeFehler('CLAUDE_UEBERLASTET', 'Claude ist gerade überlastet.', opts(503));
  }
  if (status === 404 || typ === 'not_found_error') {
    return new ClaudeFehler('CLAUDE_MODELL_UNBEKANNT', 'Dieses Modell gibt es bei Claude nicht (mehr). Wähle in den Einstellungen ein anderes.', opts(502));
  }
  if (status === 413 || typ === 'request_too_large') {
    return new ClaudeFehler('CLAUDE_ZU_GROSS', 'Das Gespräch ist zu lang für eine einzelne Anfrage. Fang einen neuen Chat an.', opts(413));
  }
  if (status === 400 || typ === 'invalid_request_error') {
    return new ClaudeFehler('CLAUDE_ANFRAGE_ABGELEHNT', 'Claude hat die Anfrage nicht angenommen.', opts(502));
  }
  return new ClaudeFehler('CLAUDE_FEHLER', 'Bei Claude ist ein Fehler aufgetreten. Versuch es gleich noch einmal.', opts(502));
}

/** Satz für Transportfehler (Schleuse, Netz, Zeit). */
function transportFehler(err, waechter, teilInhalt) {
  if (err instanceof ClaudeFehler) return err;
  if (waechter && waechter.grund === 'aufrufer') return new AbortedError('Die Antwort wurde abgebrochen.');
  const code = err && err.code;
  if (code === 'NETWORK_BLOCKED' && /Sperrliste|Freigabeliste|Hostliste/.test(String(err.message || ''))) {
    // Online, aber die Schleuse lässt genau diesen Host nicht durch: das ist
    // eine andere Abhilfe als "schalte auf Online".
    return new ClaudeFehler(
      'CLAUDE_GESPERRT',
      'Die Schleuse lässt api.anthropic.com nicht durch. Unter Netzwerk freigeben.',
      { status: 409, details: { grund: err.message }, teilInhalt },
    );
  }
  if (code === 'NETWORK_BLOCKED') {
    return new ClaudeFehler(
      'CLAUDE_OFFLINE',
      'Offline — Claude ist gerade nicht erreichbar. Schalte auf „Online“, dann antwortet Claude.',
      { status: 409, details: { grund: err.message }, teilInhalt },
    );
  }
  if (code === 'ABORTED' || (err && err.name === 'AbortError')) {
    if (waechter && waechter.grund === 'leerlauf') {
      return new ClaudeFehler('CLAUDE_STILLE', 'Claude hat zu lange nichts mehr gesendet; die Antwort ist unvollständig.', { status: 504, teilInhalt });
    }
    if (waechter && waechter.grund === 'verbinden') {
      return new ClaudeFehler('CLAUDE_ZEIT', 'Claude hat nicht rechtzeitig geantwortet.', { status: 504, teilInhalt });
    }
    return new AbortedError('Die Antwort wurde abgebrochen.');
  }
  if (code === 'NAME_RESOLUTION_FAILED' || code === 'REQUEST_FAILED' || code === 'NETWORK_TIMEOUT') {
    return new ClaudeFehler(
      'CLAUDE_KEIN_NETZ',
      'Keine Verbindung zu Claude. Ist das Internet da?',
      { status: 502, details: { grund: String(err.message || '').slice(0, 300) }, teilInhalt },
    );
  }
  return new ClaudeFehler(
    'CLAUDE_FEHLER',
    'Die Verbindung zu Claude ist abgebrochen.',
    { status: 502, details: { grund: String((err && err.message) || err).slice(0, 300) }, teilInhalt },
  );
}

/* --------------------------------------------------------- SSE zerlegen */

/**
 * Zerlegt einen Byte-Strom in ganze Zeilen über Paketgrenzen hinweg. Der
 * TextDecoder überlebt zwischen den Stücken, damit ein halbiertes
 * UTF-8-Zeichen wieder zusammengesetzt statt zu U+FFFD wird.
 */
class Zeilen {
  constructor() {
    this.decoder = new TextDecoder('utf-8');
    this.rest = '';
  }

  push(stueck) {
    this.rest += typeof stueck === 'string' ? stueck : this.decoder.decode(stueck, { stream: true });
    if (this.rest.length > MAX_ZEILE) {
      throw new ClaudeFehler('CLAUDE_FEHLER', 'Claude hat eine unplausibel lange Zeile gesendet.');
    }
    if (this.rest.indexOf('\n') === -1) return [];
    const teile = this.rest.split('\n');
    this.rest = teile.pop();
    return teile.map(ohneCr);
  }

  ende() {
    this.rest += this.decoder.decode();
    const letzte = ohneCr(this.rest);
    this.rest = '';
    return letzte ? [letzte] : [];
  }
}

function ohneCr(zeile) {
  return zeile.endsWith('\r') ? zeile.slice(0, -1) : zeile;
}

/**
 * Server-Sent Events nach den Regeln, die hier zählen: Leerzeile schickt ab,
 * `:` ist ein Kommentar, mehrere `data:`-Zeilen werden mit "\n" verbunden,
 * ein einzelnes Leerzeichen nach dem Doppelpunkt fällt weg.
 */
class SseLeser {
  constructor() {
    this.zeilen = new Zeilen();
    this.daten = [];
    this.name = null;
  }

  push(stueck) {
    const aus = [];
    for (const zeile of this.zeilen.push(stueck)) this.zeile(zeile, aus);
    return aus;
  }

  ende() {
    const aus = [];
    for (const zeile of this.zeilen.ende()) this.zeile(zeile, aus);
    this.abschicken(aus);
    return aus;
  }

  zeile(zeile, aus) {
    if (zeile === '') {
      this.abschicken(aus);
      return;
    }
    if (zeile.charCodeAt(0) === 58 /* ':' */) return;
    const i = zeile.indexOf(':');
    const feld = i === -1 ? zeile : zeile.slice(0, i);
    let wert = i === -1 ? '' : zeile.slice(i + 1);
    if (wert.charCodeAt(0) === 32) wert = wert.slice(1);
    if (feld === 'data') this.daten.push(wert);
    else if (feld === 'event') this.name = wert;
  }

  abschicken(aus) {
    if (!this.daten.length) {
      this.name = null;
      return;
    }
    aus.push({ event: this.name || 'message', data: this.daten.join('\n') });
    this.daten = [];
    this.name = null;
  }
}

/* -------------------------------------------------------- Zeitwächter */

/** Verbindet das Abbruchsignal des Aufrufers mit eigenen Fristen und merkt sich, WARUM abgebrochen wurde. */
class Waechter {
  constructor(aussen) {
    this.controller = new AbortController();
    this.grund = null; // 'aufrufer' | 'verbinden' | 'leerlauf'
    this.timer = null;
    this.aussen = aussen || null;
    this.beiAussen = () => this.ausloesen('aufrufer');
    if (this.aussen) {
      if (this.aussen.aborted) this.ausloesen('aufrufer');
      else this.aussen.addEventListener('abort', this.beiAussen, { once: true });
    }
  }

  get signal() {
    return this.controller.signal;
  }

  ausloesen(grund) {
    if (!this.grund) this.grund = grund;
    this.stoppen();
    try { this.controller.abort(); } catch { /* schon abgebrochen */ }
  }

  stellen(ms, grund) {
    this.stoppen();
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.timer = setTimeout(() => this.ausloesen(grund), ms);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stoppen() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  aufraeumen() {
    this.stoppen();
    if (this.aussen) {
      try { this.aussen.removeEventListener('abort', this.beiAussen); } catch { /* egal */ }
    }
  }
}

async function* koerper(res) {
  const body = res && res.body;
  if (!body) {
    if (res && typeof res.text === 'function') {
      const t = await res.text();
      if (t) yield t;
    }
    return;
  }
  if (typeof body === 'string' || ArrayBuffer.isView(body)) {
    if (body.length) yield body;
    return;
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      try { reader.cancel().catch(() => {}); } catch { /* schon zu */ }
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const stueck of body) if (stueck) yield stueck;
    return;
  }
  throw new ClaudeFehler('CLAUDE_FEHLER', 'Die Antwort von Claude ließ sich nicht lesen.');
}

async function auszug(res, max = 4000) {
  try {
    const decoder = new TextDecoder('utf-8');
    let out = '';
    for await (const s of koerper(res)) {
      out += typeof s === 'string' ? s : decoder.decode(s, { stream: true });
      if (out.length >= max) break;
    }
    return out.slice(0, max);
  } catch {
    return '';
  }
}

function fehlerTypAus(text) {
  try {
    const j = JSON.parse(text);
    if (j && j.error && typeof j.error.type === 'string') return { typ: j.error.type, nachricht: j.error.message || '' };
  } catch { /* kein JSON */ }
  return { typ: null, nachricht: text };
}

function kopfWert(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || null;
}

/* ---------------------------------------------------------- Anfrage */

function basisUrl(basis) {
  const b = String(basis || API_BASIS).trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(`${b}/v1/messages`);
  } catch {
    throw new ValidationError(`Ungültige Claude-Adresse: ${basis}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('Die Claude-Adresse muss mit https:// beginnen.');
  }
  return url;
}

/**
 * Die Anfrage an /v1/messages, genau in der Form aus docs/CLAUDE-ANBINDUNG.md.
 *
 * Reihenfolge der Werkzeuge: erst die eigenen, dann Suche und Abruf -- und
 * das immer gleich, denn `tools` ist der Anfang des gecachten Präfixes.
 *
 * @param {object} p
 * @param {string} p.modell
 * @param {Array}  [p.system]      Systemblöcke (fester Teil zuerst)
 * @param {Array}  [p.werkzeuge]   eigene Werkzeugdefinitionen
 * @param {Array}  p.nachrichten
 * @param {string} [p.effort]      low | medium | high
 * @param {boolean} [p.websuche=true]
 * @param {boolean} [p.denken=true] adaptives Denken (nur wo das Modell es kann)
 * @param {number} [p.maxTokens]
 * @param {boolean} [p.stream=true]
 */
function anfrageBauen(p) {
  const info = modellInfo(p.modell);
  const body = {
    model: info.id,
    max_tokens: Number.isFinite(p.maxTokens) && p.maxTokens > 0 ? Math.floor(p.maxTokens) : MAX_TOKENS,
  };
  if (p.stream !== false) body.stream = true;
  const betas = [];
  if (info.ersatzmodell) {
    body.fallbacks = 'default';
    betas.push(BETA_ERSATZMODELL);
  }
  if (info.adaptiv) {
    body.thinking = p.denken === false
      ? { type: 'disabled' }
      : { type: 'adaptive', display: 'summarized' };
  }
  if (info.effort) {
    const effort = EFFORTS.has(p.effort) ? p.effort : 'medium';
    body.output_config = { effort };
  }
  if (Array.isArray(p.system) && p.system.length) body.system = p.system;
  const tools = Array.isArray(p.werkzeuge) ? p.werkzeuge.slice() : [];
  if (p.websuche !== false) {
    tools.push({ type: info.suche, name: 'web_search' }, { type: info.abruf, name: 'web_fetch' });
  }
  if (tools.length) body.tools = tools;
  if (!Array.isArray(p.nachrichten) || !p.nachrichten.length) {
    throw new ValidationError('Es wurden keine Nachrichten an Claude übergeben.');
  }
  body.messages = p.nachrichten;
  return { body, betas };
}

function koepfe(apiKey, betas) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new ClaudeFehler('CLAUDE_KEIN_SCHLUESSEL', 'Claude ist nicht verbunden: es ist kein Schlüssel gespeichert.', { status: 503 });
  }
  const h = {
    'content-type': 'application/json',
    'x-api-key': apiKey.trim(),
    'anthropic-version': API_VERSION,
  };
  if (Array.isArray(betas) && betas.length) h['anthropic-beta'] = betas.join(',');
  return h;
}

function hostVon(url) {
  return url.hostname;
}

/* ---------------------------------------------------------- Senden */

/**
 * Eine Anfrage an /v1/messages senden und den Strom lesen.
 *
 * `beiEreignis` bekommt, während der Strom läuft:
 *   {art:'start', index, block}      ein Block beginnt (Kopie)
 *   {art:'text', index, delta}       sichtbarer Text
 *   {art:'denken', index, delta}     Zusammenfassung des Gedankengangs
 *   {art:'zitat', index, zitat}      eine Quellenangabe an einem Textblock
 *   {art:'ende', index, block}       ein Block ist fertig (Werkzeugeingaben geparst)
 *
 * Zurück kommt das vollständige Ergebnis. Wer es benutzt, prüft ZUERST
 * `stopReason`.
 *
 * @returns {Promise<{id:string|null, modell:string|null, inhalt:Array,
 *   stopReason:string|null, stopDetails:object|null, usage:object,
 *   eingabeFehler:Object<string,{roh:string, fehler:string}>, ms:number}>}
 */
async function senden({
  basis, apiKey, body, betas, gate, scope, purpose, signal, beiEreignis,
  verbindenMs = VERBINDEN_MS, leerlaufMs = LEERLAUF_MS,
} = {}) {
  if (!gate || typeof gate.fetch !== 'function') {
    throw new ValidationError('Interner Fehler: ohne Netzschleuse darf Neural OS Claude nicht erreichen.');
  }
  if (typeof scope !== 'string' || !scope) {
    throw new ValidationError('Interner Fehler: jeder Claude-Aufruf braucht einen Scope für die Schleuse.');
  }
  if (signal && signal.aborted) throw new AbortedError('Die Antwort wurde abgebrochen.');
  const url = basisUrl(basis);
  const kopf = koepfe(apiKey, betas);
  const stream = body && body.stream === true;
  const begonnen = Date.now();
  const waechter = new Waechter(signal);

  let res;
  try {
    waechter.stellen(verbindenMs, 'verbinden');
    res = await gate.fetch(url.toString(), {
      method: 'POST',
      headers: { ...kopf, accept: stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(body),
      scope,
      purpose: purpose || 'Antwort von Claude',
      // Nur dieser eine Host, auch nach einer Weiterleitung. Siehe Kopf.
      allowedHosts: [hostVon(url)],
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
    throw new ClaudeFehler('CLAUDE_FEHLER', 'Die Netzschleuse hat keine verwertbare Antwort geliefert.');
  }

  if (res.status < 200 || res.status >= 300) {
    waechter.stellen(10000, 'leerlauf');
    const text = await auszug(res);
    waechter.aufraeumen();
    const { typ, nachricht } = fehlerTypAus(text);
    const ra = Number(kopfWert(res.headers, 'retry-after'));
    throw fehlerAusAntwort({ status: res.status, typ, text: nachricht, wiederholenNachS: Number.isFinite(ra) ? ra : undefined });
  }

  if (!stream) {
    try {
      const text = await auszug(res, 32 * 1024 * 1024);
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new ClaudeFehler('CLAUDE_FEHLER', 'Claude hat unlesbares JSON geschickt.');
      }
      return {
        id: j.id || null,
        modell: j.model || null,
        inhalt: Array.isArray(j.content) ? j.content : [],
        stopReason: j.stop_reason || null,
        stopDetails: j.stop_details || null,
        usage: j.usage || {},
        eingabeFehler: {},
        ms: Date.now() - begonnen,
      };
    } finally {
      waechter.aufraeumen();
    }
  }

  const z = {
    id: null,
    modell: null,
    bloecke: [],
    roh: new Map(),
    stopReason: null,
    stopDetails: null,
    usage: {},
    eingabeFehler: {},
    fertig: false,
  };

  const melden = (e) => {
    if (typeof beiEreignis !== 'function') return;
    // Ein kaputter Zuhörer (geschlossener Tab) darf einen laufenden,
    // bezahlten Aufruf nicht abbrechen.
    try { beiEreignis(e); } catch { /* bewusst geschluckt */ }
  };

  const teil = () => z.bloecke.filter(Boolean);

  const verarbeiten = (evt) => {
    const roh = evt.data.trim();
    if (!roh) return;
    let d;
    try {
      d = JSON.parse(roh);
    } catch {
      throw new ClaudeFehler('CLAUDE_FEHLER', 'Claude hat ein unlesbares Ereignis geschickt.', { details: { auszug: roh.slice(0, 200) } });
    }
    switch (d.type) {
      case 'message_start': {
        const m = d.message || {};
        z.id = m.id || null;
        z.modell = m.model || null;
        z.usage = { ...(m.usage || {}) };
        break;
      }
      case 'content_block_start': {
        const i = d.index;
        const block = JSON.parse(JSON.stringify(d.content_block || {}));
        if (block.type === 'text' && typeof block.text !== 'string') block.text = '';
        if (block.type === 'thinking' && typeof block.thinking !== 'string') block.thinking = '';
        if (block.type === 'tool_use' || block.type === 'server_tool_use') z.roh.set(i, '');
        z.bloecke[i] = block;
        melden({ art: 'start', index: i, block: JSON.parse(JSON.stringify(block)) });
        break;
      }
      case 'content_block_delta': {
        const i = d.index;
        const block = z.bloecke[i];
        const delta = d.delta || {};
        if (!block) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text += delta.text;
          melden({ art: 'text', index: i, delta: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking += delta.thinking;
          melden({ art: 'denken', index: i, delta: delta.thinking });
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = (block.signature || '') + delta.signature;
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          z.roh.set(i, (z.roh.get(i) || '') + delta.partial_json);
        } else if (delta.type === 'citations_delta' && delta.citation) {
          if (!Array.isArray(block.citations)) block.citations = [];
          block.citations.push(delta.citation);
          melden({ art: 'zitat', index: i, zitat: delta.citation });
        }
        break;
      }
      case 'content_block_stop': {
        const i = d.index;
        const block = z.bloecke[i];
        if (!block) break;
        if (z.roh.has(i)) {
          const text = z.roh.get(i);
          z.roh.delete(i);
          if (!text.trim()) {
            block.input = {};
          } else {
            try {
              const wert = JSON.parse(text);
              if (wert && typeof wert === 'object' && !Array.isArray(wert)) {
                block.input = wert;
              } else {
                block.input = {};
                z.eingabeFehler[block.id] = { roh: text, fehler: 'Die Eingabe ist kein JSON-Objekt.' };
              }
            } catch (err) {
              // Nicht reparieren: was nicht parst, geht als Fehler an Claude
              // zurück. Für die Wiederholung im Verlauf braucht der Block
              // trotzdem ein Objekt, sonst lehnt die API den Verlauf ab.
              block.input = {};
              z.eingabeFehler[block.id] = { roh: text, fehler: `Kein gültiges JSON (${err.message}).` };
            }
          }
        }
        melden({ art: 'ende', index: i, block: JSON.parse(JSON.stringify(block)) });
        break;
      }
      case 'message_delta': {
        const delta = d.delta || {};
        if (delta.stop_reason) z.stopReason = delta.stop_reason;
        if (delta.stop_details) z.stopDetails = delta.stop_details;
        if (d.stop_details) z.stopDetails = d.stop_details;
        if (d.usage && typeof d.usage === 'object') Object.assign(z.usage, d.usage);
        break;
      }
      case 'message_stop':
        z.fertig = true;
        break;
      case 'ping':
        break;
      case 'error': {
        const e = d.error || {};
        throw fehlerAusAntwort({ status: null, typ: e.type || 'api_error', text: e.message || '', teilInhalt: teil() });
      }
      default:
        // Unbekannte Ereignisse (neue Arten) werden ignoriert, nicht geraten.
        break;
    }
  };

  const leser = new SseLeser();
  try {
    waechter.stellen(leerlaufMs, 'leerlauf');
    for await (const stueck of koerper(res)) {
      waechter.stellen(leerlaufMs, 'leerlauf');
      for (const evt of leser.push(stueck)) verarbeiten(evt);
    }
    for (const evt of leser.ende()) verarbeiten(evt);
  } catch (err) {
    if (err instanceof ClaudeFehler) {
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

  if (!z.fertig && !z.stopReason) {
    throw new ClaudeFehler('CLAUDE_ABGEBROCHEN', 'Die Verbindung zu Claude ist mitten in der Antwort abgebrochen.', { teilInhalt: teil() });
  }

  return {
    id: z.id,
    modell: z.modell,
    inhalt: teil(),
    stopReason: z.stopReason,
    stopDetails: z.stopDetails,
    usage: z.usage,
    eingabeFehler: z.eingabeFehler,
    ms: Date.now() - begonnen,
  };
}

/**
 * Der kleine Probeaufruf beim Speichern eines Schlüssels.
 *
 * Wenige Token, ohne Werkzeuge, ohne Strom. Jede 200 beweist, dass Schlüssel,
 * Konto und Modell zusammenpassen; alles andere wird als deutscher Satz
 * geworfen. Denken bleibt aus, damit acht Token auch wirklich reichen.
 */
async function probe({ basis, apiKey, modell, gate, signal, timeoutMs = 30000 } = {}) {
  const { body, betas } = anfrageBauen({
    modell,
    nachrichten: [{ role: 'user', content: 'Antworte nur mit: OK' }],
    maxTokens: 8,
    stream: false,
    websuche: false,
    denken: false,
  });
  // Ohne Ersatzmodell: geprüft wird DAS gewählte Modell, nicht ein anderes.
  delete body.fallbacks;
  const ohneErsatz = betas.filter((b) => b !== BETA_ERSATZMODELL);
  const r = await senden({
    basis, apiKey, body, betas: ohneErsatz, gate,
    scope: 'global', purpose: 'Claude-Schlüssel prüfen', signal, verbindenMs: timeoutMs,
  });
  return { ok: true, modell: r.modell || modellInfo(modell).id, usage: r.usage, ms: r.ms };
}

/* ------------------------------------------------ Blöcke zurückgeben */

const DENKBLOECKE = new Set(['thinking', 'redacted_thinking']);
const SERVER_ERGEBNIS = /_tool_result$/;

/**
 * Welche Blöcke einer Antwort im nächsten Aufruf zurückgehen.
 *
 * Grundsätzlich ALLE, unverändert -- auch die Denkblöcke mit Signatur.
 * Zwei Ausnahmen aus der Referenz:
 * - Nach einem Wechsel auf das Ersatzmodell (`fallback`-Block) fallen vor
 *   dem letzten Wechsel Denk- und Werkzeugblöcke des abgelehnten Modells weg;
 *   Text und vollständige Suchpaare bleiben. Der Marker selbst fällt auch weg.
 * - Ein `server_tool_use` ohne sein Ergebnis (Abbruch mitten in der Suche)
 *   würde die nächste Anfrage ablehnen lassen; er fällt weg. AUSSER nach
 *   `pause_turn` (`offeneSuche: true`): dort ist genau dieser letzte, offene
 *   Aufruf das Zeichen für den Server, an dieser Stelle weiterzumachen.
 */
function bloeckeZurueck(inhalt, { offeneSuche = false } = {}) {
  const liste = Array.isArray(inhalt) ? inhalt : [];
  let grenze = -1;
  liste.forEach((b, i) => { if (b && b.type === 'fallback') grenze = i; });
  const ergebnisse = new Set(liste
    .filter((b) => b && SERVER_ERGEBNIS.test(b.type || '') && b.tool_use_id)
    .map((b) => b.tool_use_id));
  const out = [];
  liste.forEach((b, i) => {
    if (!b || typeof b !== 'object') return;
    if (b.type === 'fallback') return;
    if (i < grenze && (DENKBLOECKE.has(b.type) || b.type === 'tool_use')) return;
    if (b.type === 'server_tool_use' && !ergebnisse.has(b.id) && !offeneSuche) return;
    out.push(JSON.parse(JSON.stringify(b)));
  });
  return out;
}

/** Die eigenen Werkzeugaufrufe, die AUSGEFÜHRT werden dürfen: nur nach dem letzten Modellwechsel. */
function werkzeugAufrufe(inhalt) {
  const liste = Array.isArray(inhalt) ? inhalt : [];
  let grenze = -1;
  liste.forEach((b, i) => { if (b && b.type === 'fallback') grenze = i; });
  return liste.filter((b, i) => b && b.type === 'tool_use' && i > grenze);
}

/* ------------------------------------------------ Verbrauch schätzen */

/** Geschätzte Kosten in US-Dollar für eine `usage`. Nur eine Schätzung. */
function kostenSchaetzen(modell, usage) {
  const info = modellInfo(modell);
  const u = usage || {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const ein = n(u.input_tokens);
  const aus = n(u.output_tokens);
  const gelesen = n(u.cache_read_input_tokens);
  const geschrieben = n(u.cache_creation_input_tokens);
  const suchen = n(u.server_tool_use && u.server_tool_use.web_search_requests);
  return (
    (ein * info.preis.ein
      + geschrieben * info.preis.ein * 1.25
      + gelesen * info.preis.ein * 0.1
      + aus * info.preis.aus) / 1e6
  ) + suchen * PREIS_JE_SUCHE;
}

/* --------------------------------------- allgemeiner chat()-Adapter */

/**
 * Werkzeugnamen der Agenten tragen Punkte ("notes.search"); Claude erlaubt
 * nur Buchstaben, Ziffern, "_" und "-". Die Abbildung ist umkehrbar, weil
 * kein Werkzeugname "__" enthält.
 */
function nameHin(name) {
  return String(name).replace(/\./g, '__');
}
function nameZurueck(name) {
  return String(name).replace(/__/g, '.');
}

/**
 * Die Nachrichtenform der übrigen Teilsysteme (Agentenlauf, zweiter Blick,
 * Vergleich, Erweiterungen) in die Form von Claude übersetzen.
 *
 * Die Denkblöcke einer Antwort mit Werkzeugaufrufen hängen am ERSTEN
 * Werkzeugaufruf (`anthropic.bloecke`). Der Agentenlauf gibt seine
 * Werkzeugaufrufe unverändert zurück, also kommen sie im nächsten Schritt
 * mit -- und Claude bekommt seine eigenen Denkblöcke zurück, wie verlangt.
 * Fehlen sie doch, sagt `ohneDenkbloecke` es, und der Aufruf läuft ohne
 * Denken (sonst lehnt die API den Verlauf ab).
 */
function uebersetzen(messages) {
  const system = [];
  const out = [];
  let ohneDenkbloecke = false;
  let werkzeugErgebnisse = null;
  const ergebnisseAbschliessen = () => {
    if (werkzeugErgebnisse && werkzeugErgebnisse.length) out.push({ role: 'user', content: werkzeugErgebnisse });
    werkzeugErgebnisse = null;
  };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system') {
      if (text.trim()) system.push(text);
      continue;
    }
    if (m.role === 'tool') {
      if (!werkzeugErgebnisse) werkzeugErgebnisse = [];
      werkzeugErgebnisse.push({ type: 'tool_result', tool_use_id: String(m.toolCallId || ''), content: text || '(leer)' });
      continue;
    }
    ergebnisseAbschliessen();
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const mitBloecken = calls.find((c) => c && c.anthropic && Array.isArray(c.anthropic.bloecke));
      if (mitBloecken) {
        out.push({ role: 'assistant', content: JSON.parse(JSON.stringify(mitBloecken.anthropic.bloecke)) });
        continue;
      }
      const content = [];
      if (text.trim()) content.push({ type: 'text', text });
      for (const c of calls) {
        if (!c || !c.name) continue;
        content.push({ type: 'tool_use', id: String(c.id), name: nameHin(c.name), input: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} });
      }
      if (calls.length) ohneDenkbloecke = true;
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }
    // user
    if (text.trim()) {
      const last = out[out.length - 1];
      if (last && last.role === 'user') last.content.push({ type: 'text', text });
      else out.push({ role: 'user', content: [{ type: 'text', text }] });
    }
  }
  ergebnisseAbschliessen();
  // Werkzeugergebnisse gefolgt von Nutzertext: EINE Nutzernachricht.
  const verschmolzen = [];
  for (const m of out) {
    const last = verschmolzen[verschmolzen.length - 1];
    if (last && last.role === 'user' && m.role === 'user') last.content.push(...m.content);
    else verschmolzen.push(m);
  }
  while (verschmolzen.length && verschmolzen[0].role !== 'user') verschmolzen.shift();
  return { system: system.join('\n\n'), nachrichten: verschmolzen, ohneDenkbloecke };
}

function werkzeugeUebersetzen(tools) {
  if (!Array.isArray(tools) || !tools.length) return [];
  return tools.map((t) => {
    const fn = t && t.type === 'function' && t.function ? t.function : t;
    if (!fn || typeof fn.name !== 'string' || !fn.name) {
      throw new ValidationError('Jedes Werkzeug braucht einen Namen.');
    }
    return {
      name: nameHin(fn.name),
      description: typeof fn.description === 'string' ? fn.description : '',
      input_schema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
    };
  });
}

/**
 * Der Vertrag der Modell-Registry (`registry.chat`): Nachrichten in, Text und
 * Werkzeugaufrufe `{id, name, arguments}` heraus. Ohne Websuche -- die
 * Agenten haben eigene, an ihre Rechte gebundene Werkzeuge, und eine
 * Websuche bei Anthropic ginge an diesen Rechten vorbei.
 */
async function chat({
  basis, apiKey, model, messages, options = {}, tools, gate, scope = 'global', purpose,
  signal, onDelta, timeoutMs,
} = {}) {
  const { system, nachrichten, ohneDenkbloecke } = uebersetzen(messages);
  if (!nachrichten.length) throw new ValidationError('Es wurden keine Nachrichten an Claude übergeben.');
  const werkzeuge = werkzeugeUebersetzen(tools);
  const { body, betas } = anfrageBauen({
    modell: model,
    system: system ? [{ type: 'text', text: system }] : undefined,
    werkzeuge,
    nachrichten,
    effort: EFFORTS.has(options.effort) ? options.effort : 'medium',
    websuche: false,
    denken: !ohneDenkbloecke,
    maxTokens: Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : undefined,
  });
  // Der allgemeine Weg braucht keinen lesbaren Gedankengang.
  if (body.thinking && body.thinking.type === 'adaptive') delete body.thinking.display;

  const r = await senden({
    basis, apiKey, body, betas, gate, scope, purpose, signal,
    verbindenMs: Number.isFinite(timeoutMs) ? timeoutMs : VERBINDEN_MS,
    beiEreignis: (e) => {
      if (e.art === 'text' && typeof onDelta === 'function') onDelta(e.delta);
    },
  });

  if (r.stopReason === 'refusal') {
    throw new ClaudeFehler('CLAUDE_ABGELEHNT', 'Claude hat diese Anfrage abgelehnt.', { status: 422 });
  }
  const text = r.inhalt.filter((b) => b.type === 'text').map((b) => b.text).join('');
  // Abgeschnitten heißt: auch ein Werkzeugaufruf kann halb sein. Keiner wird geliefert.
  const aufrufe = r.stopReason === 'max_tokens' ? [] : werkzeugAufrufe(r.inhalt);
  const bloecke = bloeckeZurueck(r.inhalt);
  const toolCalls = aufrufe.map((b, i) => {
    const call = { id: b.id, name: nameZurueck(b.name), arguments: b.input || {} };
    const fehler = r.eingabeFehler[b.id];
    if (fehler) {
      call.argumentsError = fehler.fehler;
      call.argumentsRaw = fehler.roh.slice(0, 2000);
    }
    if (i === 0) call.anthropic = { bloecke };
    return call;
  });
  const u = r.usage || {};
  return {
    content: text,
    toolCalls,
    stats: {
      promptTokens: Number.isFinite(u.input_tokens) ? u.input_tokens : null,
      completionTokens: Number.isFinite(u.output_tokens) ? u.output_tokens : null,
      cacheRead: Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : null,
      ms: r.ms,
    },
    finishReason: r.stopReason,
    usage: u,
    modellAntwort: r.modell,
  };
}

module.exports = {
  kind: KIND,
  API_BASIS,
  API_HOST,
  API_VERSION,
  BETA_ERSATZMODELL,
  MAX_TOKENS,
  STANDARD_MODELL,
  MODELLE,
  PREIS_JE_SUCHE,
  ClaudeFehler,
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
  __internals: { SseLeser, Zeilen, uebersetzen, werkzeugeUebersetzen, nameHin, nameZurueck, transportFehler },
};
