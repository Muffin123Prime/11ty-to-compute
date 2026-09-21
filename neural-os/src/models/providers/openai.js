'use strict';

const crypto = require('node:crypto');
const {
  NeuralError,
  ValidationError,
  NoModelError,
  ModelError,
  AbortedError,
} = require('../../kernel/errors');

/**
 * OpenAI-compatible backend (contract section 7).
 *
 * One provider serves llama.cpp (`llama-server`, port 8080), LM Studio
 * (port 1234), vLLM and genuinely remote services, because they all speak the
 * same `/chat/completions` dialect. `baseUrl` already carries the `/v1` prefix,
 * so endpoints are appended as `/models`, `/chat/completions`, `/embeddings`.
 *
 * Why this file is shaped the way it is
 * -------------------------------------
 * - Every request goes through `gate.fetch`. A remote provider is a public
 *   destination and MUST be refused by the gate unless the user allowed it;
 *   that decision does not belong in this file, which is exactly why this file
 *   never touches `fetch`, `http` or a socket itself.
 * - The wire format is SSE, which is far more fragile than it looks: a `data:`
 *   line is regularly cut in half by TCP, one event may carry several `data:`
 *   lines, servers inject `:` keep-alive comments, and line endings are
 *   sometimes CRLF. So this is a real incremental SSE parser (LineSplitter +
 *   SseParser) fed by ONE streaming TextDecoder, not a `chunk.split('data: ')`.
 * - Tool calls arrive as fragments: `{index, id, function:{name, arguments}}`
 *   where `arguments` is a JSON string spread over many chunks. They are
 *   reassembled per index and only then parsed, and normalised to the
 *   contract's `{id, name, arguments}` shape, identical to Ollama's.
 * - Some "OpenAI-compatible" servers silently ignore `stream:true` and answer
 *   with one plain JSON object. That is detected and handled instead of
 *   reporting an empty answer.
 * - Nothing here invents output: unreachable -> NoModelError, HTTP error ->
 *   ModelError with status and body excerpt.
 * - The stream/deadline helpers are deliberately duplicated from ollama.js
 *   rather than shared: the formats differ in every detail that matters, and
 *   in an auditable codebase a provider that can be read end-to-end in one
 *   file is worth more than sixty saved lines.
 */

const KIND = 'openai';
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/**
 * Cap on the raw body kept for the "server ignored stream:true" fallback.
 * Accumulation stops as soon as the first SSE event arrives, so on the normal
 * streaming path this buffer stays at one chunk.
 */
const MAX_RAW_FALLBACK_BYTES = 16 * 1024 * 1024;

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT',
]);

// ---------------------------------------------------------------------------
// Incremental framing
// ---------------------------------------------------------------------------

/**
 * Splits a byte or string stream into complete lines across chunk boundaries.
 * The TextDecoder survives between chunks (`stream: true`) so a UTF-8 sequence
 * cut in half by the network is reassembled instead of becoming U+FFFD.
 */
class LineSplitter {
  constructor(maxLineBytes = MAX_LINE_BYTES) {
    this.decoder = new TextDecoder('utf-8');
    this.carry = '';
    this.maxLineBytes = maxLineBytes;
  }

  /** @param {Uint8Array|string} chunk @returns {string[]} */
  push(chunk) {
    if (chunk === null || chunk === undefined) return [];
    this.carry += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.carry.length > this.maxLineBytes) {
      throw new ModelError(
        'Der Modellserver hat eine unplausibel lange Zeile gesendet. Spricht dort wirklich ein OpenAI-kompatibler Server?',
        { maxLineBytes: this.maxLineBytes },
      );
    }
    if (this.carry.indexOf('\n') === -1) return [];
    const parts = this.carry.split('\n');
    this.carry = parts.pop();
    return parts.map(stripCr);
  }

  flush() {
    this.carry += this.decoder.decode();
    const rest = stripCr(this.carry);
    this.carry = '';
    return rest.length ? [rest] : [];
  }
}

function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Server-Sent Events parser per the WHATWG rules that actually matter here:
 * blank line dispatches, `:` starts a comment, multiple `data:` lines join
 * with "\n", and a single leading space after the colon is stripped.
 */
class SseParser {
  constructor(maxLineBytes = MAX_LINE_BYTES) {
    this.lines = new LineSplitter(maxLineBytes);
    this.data = [];
    this.eventName = null;
  }

  /** @returns {Array<{event:string, data:string}>} */
  push(chunk) {
    const events = [];
    for (const line of this.lines.push(chunk)) this.feed(line, events);
    return events;
  }

  /** Dispatch whatever a server left behind when it closed without a blank line. */
  flush() {
    const events = [];
    for (const line of this.lines.flush()) this.feed(line, events);
    this.dispatch(events);
    return events;
  }

  feed(line, events) {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.charCodeAt(0) === 58 /* ':' */) return; // keep-alive comment
    const idx = line.indexOf(':');
    let field;
    let value;
    if (idx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, idx);
      value = line.slice(idx + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
    }
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.eventName = value;
    // `id` and `retry` are irrelevant: we never reconnect a completion stream.
  }

  dispatch(events) {
    if (!this.data.length) {
      this.eventName = null;
      return;
    }
    events.push({ event: this.eventName || 'message', data: this.data.join('\n') });
    this.data = [];
    this.eventName = null;
  }
}

// ---------------------------------------------------------------------------
// Deadlines and cancellation
// ---------------------------------------------------------------------------

/**
 * Merges the caller's AbortSignal with our own deadlines and remembers WHY it
 * fired -- without that reason a timeout and a user abort look identical at
 * the catch site, and they deserve different errors.
 */
class Watchdog {
  constructor(externalSignal) {
    this.controller = new AbortController();
    this.reason = null; // 'caller' | 'connect' | 'idle'
    this.timer = null;
    this.waitedMs = 0;
    this.external = externalSignal || null;
    this.onExternalAbort = () => this.trip('caller');
    if (this.external) {
      if (this.external.aborted) this.trip('caller');
      else this.external.addEventListener('abort', this.onExternalAbort, { once: true });
    }
  }

  get signal() {
    return this.controller.signal;
  }

  trip(reason) {
    if (!this.reason) this.reason = reason;
    this.clear();
    try { this.controller.abort(); } catch { /* already aborted */ }
  }

  arm(ms, reason) {
    this.clear();
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.waitedMs = ms;
    this.timer = setTimeout(() => this.trip(reason), ms);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    this.clear();
    if (this.external) {
      try { this.external.removeEventListener('abort', this.onExternalAbort); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing (always via the gate)
// ---------------------------------------------------------------------------

function apiUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new ValidationError('Für diesen Modellanbieter ist keine Adresse (baseUrl) hinterlegt.');
  let url;
  try {
    url = new URL(base + suffix);
  } catch {
    throw new ValidationError(`Ungültige Modell-Adresse: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`Modell-Adressen müssen http oder https sein, nicht "${url.protocol}".`);
  }
  return url.toString();
}

function authHeaders(apiKey) {
  // A key is only ever read from the caller, never from a file or the config:
  // config.models.remote stores apiKeyEnv, the registry resolves it.
  if (typeof apiKey === 'string' && apiKey.trim()) return { authorization: `Bearer ${apiKey.trim()}` };
  return {};
}

async function gateFetch(gate, url, init) {
  if (!gate || typeof gate.fetch !== 'function') {
    throw new ValidationError(
      'Interner Fehler: Die Netzwerkschleuse fehlt. Ohne sie darf kein Modul eine Verbindung aufbauen.',
    );
  }
  if (typeof init.scope !== 'string' || init.scope.length === 0) {
    throw new ValidationError('Interner Fehler: Jeder Modellaufruf braucht einen Scope für die Netzwerkschleuse.');
  }
  return gate.fetch(url, init);
}

async function* readBody(res) {
  const body = res && res.body;
  if (!body) {
    if (res && typeof res.text === 'function') {
      const text = await res.text();
      if (text) yield text;
    }
    return;
  }
  // Already buffered: the gate hands back a Buffer unless streaming was asked
  // for, and an error body is never streamed. One chunk, same parser.
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
      try {
        const cancelled = reader.cancel();
        if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
      } catch { /* stream already closed */ }
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) if (chunk) yield chunk;
    return;
  }
  throw new ModelError('Die Antwort des Modellservers konnte nicht gelesen werden (unbekannter Stream-Typ).');
}

async function readExcerpt(res, max = 600) {
  try {
    const decoder = new TextDecoder('utf-8');
    let out = '';
    for await (const chunk of readBody(res)) {
      out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (out.length >= max) break;
    }
    return out.slice(0, max).trim();
  } catch {
    return '';
  }
}

function describeBody(excerpt) {
  if (!excerpt) return '(leere Antwort)';
  try {
    const parsed = JSON.parse(excerpt);
    if (parsed && parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
    if (parsed && typeof parsed.error === 'string') return parsed.error;
    if (parsed && typeof parsed.message === 'string') return parsed.message;
  } catch { /* not JSON, quote it verbatim */ }
  return excerpt;
}

function errorCode(err) {
  let cur = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (typeof cur.code === 'string') return cur.code;
    cur = cur.cause;
  }
  return null;
}

function isAbortError(err) {
  let cur = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (cur.name === 'AbortError' || cur.code === 'ABORT_ERR') return true;
    cur = cur.cause;
  }
  return false;
}

function describeTransport(err) {
  switch (errorCode(err)) {
    case 'ECONNREFUSED': return 'Verbindung abgelehnt – dort lauscht kein Server';
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return 'Adresse nicht auflösbar';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return 'Host nicht erreichbar';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT': return 'Zeitüberschreitung beim Verbindungsaufbau';
    case 'ECONNRESET':
    case 'EPIPE': return 'Verbindung vom Server abgebrochen';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT': return 'TLS-Zertifikat nicht vertrauenswürdig';
    default: return (err && err.message) ? err.message : String(err);
  }
}

function transportError(err, watchdog, { url, phase }) {
  if (err instanceof NeuralError) return err; // gate denials keep their identity
  const reason = watchdog.reason;
  if (reason === 'caller') return new AbortedError('Die Modellanfrage wurde abgebrochen.');
  if (reason === 'connect') {
    return new NoModelError(
      `Der Modellserver unter ${url} hat nicht innerhalb von ${watchdog.waitedMs} ms geantwortet.`,
      { url, timeoutMs: watchdog.waitedMs, provider: KIND },
    );
  }
  if (reason === 'idle') {
    return new ModelError(
      `Der Modellserver hat ${watchdog.waitedMs} ms lang keine weiteren Daten gesendet; die Antwort ist unvollständig.`,
      { url, timeoutMs: watchdog.waitedMs, provider: KIND },
    );
  }
  if (isAbortError(err)) return new AbortedError('Die Modellanfrage wurde abgebrochen.');
  const detail = describeTransport(err);
  if (phase === 'connect' && UNREACHABLE_CODES.has(errorCode(err))) {
    return new NoModelError(`Der Modellserver unter ${url} ist nicht erreichbar (${detail}).`, { url, provider: KIND });
  }
  return new ModelError(`Verbindung zu ${url} fehlgeschlagen: ${detail}`, { url, provider: KIND });
}

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

function requireMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ValidationError('Es wurden keine Nachrichten an das Modell übergeben.');
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw new ValidationError('Ungültige Nachricht im Gesprächsverlauf.');
    if (!ROLES.has(m.role)) {
      throw new ValidationError(`Unbekannte Rolle "${m && m.role}" – erlaubt sind: ${[...ROLES].join(', ')}.`);
    }
    if (m.content !== null && m.content !== undefined && typeof m.content !== 'string') {
      throw new ValidationError(`Der Inhalt der Nachricht (${m.role}) muss Text sein.`);
    }
  }
}

function argumentsToString(args) {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args === null || args === undefined ? {} : args);
  } catch {
    return '{}';
  }
}

function toOpenAiMessages(messages) {
  return messages.map((m, i) => {
    if (m.role === 'tool') {
      // Without tool_call_id the model cannot match the result to its request;
      // guessing an id would produce a wrong conversation, so refuse instead.
      if (typeof m.toolCallId !== 'string' || !m.toolCallId) {
        throw new ValidationError('Eine Werkzeug-Antwort ohne toolCallId kann das Modell nicht zuordnen.');
      }
      return { role: 'tool', tool_call_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : '' };
    }
    const out = { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
    if (m.role !== 'assistant' && typeof m.name === 'string' && m.name) out.name = m.name;
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map((tc, j) => ({
        id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${i}_${j}`,
        type: 'function',
        function: { name: tc.name, arguments: argumentsToString(tc.arguments) },
      }));
      // The API expects null, not "", next to tool_calls.
      if (!out.content) out.content = null;
    }
    return out;
  });
}

function toApiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => {
    if (t && t.type === 'function' && t.function && typeof t.function.name === 'string') return t;
    if (!t || typeof t.name !== 'string' || !t.name) {
      throw new ValidationError('Jedes Werkzeug braucht einen Namen (name) und ein JSON-Schema (parameters).');
    }
    return {
      type: 'function',
      function: {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        parameters: t.parameters && typeof t.parameters === 'object'
          ? t.parameters
          : { type: 'object', properties: {} },
      },
    };
  });
}

function normaliseStop(stop) {
  if (typeof stop === 'string' && stop) return [stop];
  if (Array.isArray(stop)) {
    const list = stop.filter((s) => typeof s === 'string' && s.length);
    return list.length ? list : undefined;
  }
  return undefined;
}

function safeParseArgs(raw) {
  if (raw === null || raw === undefined) return { value: {}, error: null };
  if (typeof raw === 'object') return { value: raw, error: null };
  if (typeof raw !== 'string') return { value: {}, error: `Argumente vom Typ ${typeof raw} sind nicht verwertbar.` };
  const trimmed = raw.trim();
  if (!trimmed) return { value: {}, error: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed, error: null };
    return { value: {}, error: 'Werkzeug-Argumente waren kein JSON-Objekt.' };
  } catch (err) {
    return { value: {}, error: `Werkzeug-Argumente waren kein gültiges JSON: ${err.message}` };
  }
}

/**
 * Collects streamed tool-call fragments per `index` and normalises them to the
 * contract shape. `arguments` is a JSON string that arrives in pieces, so it
 * may only be parsed once the stream is finished.
 */
class ToolCallAccumulator {
  constructor() {
    this.byIndex = new Map();
  }

  /** Merge a `delta.tool_calls` array. */
  mergeDeltas(list) {
    if (!Array.isArray(list)) return;
    list.forEach((tc, pos) => {
      if (!tc || typeof tc !== 'object') return;
      const idx = Number.isFinite(tc.index) ? tc.index : pos;
      let cur = this.byIndex.get(idx);
      if (!cur) {
        cur = { id: null, name: '', args: '' };
        this.byIndex.set(idx, cur);
      }
      if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
      const fn = (tc.function && typeof tc.function === 'object') ? tc.function : {};
      if (typeof fn.name === 'string' && fn.name) {
        // Most servers send the name once; a few repeat it in full in every
        // fragment. Appending blindly would yield "zeitzeit", so an identical
        // fragment is treated as a re-send rather than a continuation.
        if (cur.name !== fn.name) cur.name += fn.name;
      }
      if (typeof fn.arguments === 'string' && fn.arguments) cur.args += fn.arguments;
    });
  }

  /** Replace everything with a complete (non-streamed) tool_calls array. */
  setComplete(list) {
    if (!Array.isArray(list)) return;
    this.byIndex.clear();
    list.forEach((tc, pos) => {
      if (!tc || typeof tc !== 'object') return;
      const fn = (tc.function && typeof tc.function === 'object') ? tc.function : {};
      this.byIndex.set(Number.isFinite(tc.index) ? tc.index : pos, {
        id: typeof tc.id === 'string' && tc.id ? tc.id : null,
        name: typeof fn.name === 'string' ? fn.name : '',
        args: typeof fn.arguments === 'string' ? fn.arguments : argumentsToString(fn.arguments),
      });
    });
  }

  get size() {
    return this.byIndex.size;
  }

  /** @returns {Array<{id:string,name:string,arguments:object}>} */
  finish() {
    const out = [];
    const indices = [...this.byIndex.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const cur = this.byIndex.get(idx);
      if (!cur.name) {
        throw new ModelError('Der Modellserver hat einen Werkzeugaufruf ohne Namen gesendet.', { index: idx });
      }
      const parsed = safeParseArgs(cur.args);
      const call = {
        id: cur.id || `call_${idx}_${crypto.randomBytes(4).toString('hex')}`,
        name: cur.name,
        arguments: parsed.value,
      };
      if (parsed.error) {
        call.argumentsError = parsed.error;
        call.argumentsRaw = cur.args.slice(0, 2000);
      }
      out.push(call);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Provider API
// ---------------------------------------------------------------------------

function normaliseModelList(json) {
  const list = Array.isArray(json && json.data) ? json.data : (Array.isArray(json) ? json : null);
  if (!list) return null;
  const models = [];
  for (const m of list) {
    if (!m) continue;
    const id = typeof m === 'string' ? m : (typeof m.id === 'string' ? m.id : null);
    if (!id) continue;
    const meta = (m && m.meta && typeof m.meta === 'object') ? m.meta : {};
    models.push({
      id,
      name: (m && typeof m.name === 'string' && m.name) ? m.name : id,
      family: (m && typeof m.owned_by === 'string') ? m.owned_by : null,
      parameterSize: Number.isFinite(meta.n_params) ? String(meta.n_params) : null,
      // llama.cpp reports meta.n_ctx, vLLM max_model_len; never invent one.
      contextLength: Number.isFinite(m && m.context_length) ? m.context_length
        : (Number.isFinite(meta.n_ctx) ? meta.n_ctx
          : (Number.isFinite(m && m.max_model_len) ? m.max_model_len : null)),
      sizeBytes: Number.isFinite(meta.size) ? meta.size : null,
    });
  }
  return models;
}

/**
 * Ask the backend what it serves. Never throws -- the registry probes every
 * configured backend in parallel and needs an answer from each one.
 */
async function probe({ baseUrl, gate, scope = 'global', signal, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, apiKey, purpose } = {}) {
  const started = Date.now();
  const watchdog = new Watchdog(signal);
  let url = null;
  try {
    url = apiUrl(baseUrl, '/models');
    watchdog.arm(timeoutMs, 'connect');
    const res = await gateFetch(gate, url, {
      method: 'GET',
      headers: { accept: 'application/json', ...authHeaders(apiKey) },
      scope,
      purpose: purpose || 'Lokale Modelle suchen (OpenAI-kompatibel)',
      timeoutMs,
      signal: watchdog.signal,
    });
    if (!res || typeof res.status !== 'number') {
      return {
        available: false,
        models: [],
        error: 'Die Netzwerkschleuse hat keine verwertbare Antwort geliefert.',
        latencyMs: Date.now() - started,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        available: false,
        models: [],
        error: `Der Server unter ${url} hat den Zugriff abgelehnt (HTTP ${res.status}). Fehlt oder stimmt der API-Schlüssel nicht?`,
        latencyMs: Date.now() - started,
      };
    }
    if (!res.ok) {
      const excerpt = await readExcerpt(res, 300);
      return {
        available: false,
        models: [],
        error: `HTTP ${res.status}: ${describeBody(excerpt)}`,
        latencyMs: Date.now() - started,
      };
    }
    const text = await readExcerpt(res, 2 * 1024 * 1024);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        available: false,
        models: [],
        error: `Unter ${url} antwortet kein OpenAI-kompatibler Server (unlesbares JSON).`,
        latencyMs: Date.now() - started,
      };
    }
    const models = normaliseModelList(json);
    if (!models) {
      return {
        available: false,
        models: [],
        error: `Unter ${url} antwortet kein OpenAI-kompatibler Server (kein "data"-Feld).`,
        latencyMs: Date.now() - started,
      };
    }
    return { available: true, models, latencyMs: Date.now() - started };
  } catch (err) {
    const mapped = transportError(err, watchdog, { url: url || String(baseUrl), phase: 'connect' });
    // The code travels with the message. Without it a caller can only guess
    // from German prose whether the gate refused (a decision the user made)
    // or the server was unreachable (a fault) -- two opposite answers.
    return { available: false, models: [], error: mapped.message, code: mapped.code || null, latencyMs: Date.now() - started };
  } finally {
    watchdog.dispose();
  }
}

/**
 * Streamed chat completion against /chat/completions.
 * @returns {Promise<{content:string, toolCalls:Array, stats:object, raw:object, finishReason:string|null}>}
 */
async function chat({
  baseUrl, model, messages, options = {}, tools, gate, scope = 'global', signal, onDelta,
  timeoutMs, idleTimeoutMs, apiKey, purpose,
} = {}) {
  if (typeof model !== 'string' || !model) throw new ValidationError('Es wurde kein Modellname angegeben.');
  requireMessages(messages);
  if (signal && signal.aborted) throw new AbortedError('Die Modellanfrage wurde abgebrochen.');

  const url = apiUrl(baseUrl, '/chat/completions');
  const payload = {
    model,
    messages: toOpenAiMessages(messages),
    stream: true,
    // Without this most servers send no token counts at all; the UI must not
    // display an invented number, so we ask for the real one.
    stream_options: { include_usage: true },
  };
  if (Number.isFinite(options.temperature)) payload.temperature = options.temperature;
  if (Number.isFinite(options.topP)) payload.top_p = options.topP;
  // `max_tokens` rather than `max_completion_tokens`: llama.cpp, LM Studio and
  // vLLM only understand the former, and every remote service still accepts it.
  if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) payload.max_tokens = Math.floor(options.maxTokens);
  if (Number.isFinite(options.seed)) payload.seed = Math.floor(options.seed);
  const stop = normaliseStop(options.stop);
  if (stop) payload.stop = stop;
  if (options.responseFormat === 'json') payload.response_format = { type: 'json_object' };
  const apiTools = toApiTools(tools);
  if (apiTools) {
    payload.tools = apiTools;
    if (options.toolChoice) payload.tool_choice = options.toolChoice;
  }

  const watchdog = new Watchdog(signal);
  const started = Date.now();
  const state = { consumerError: null };

  let res;
  try {
    watchdog.arm(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS, 'connect');
    res = await gateFetch(gate, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify(payload),
      scope,
      purpose: purpose || `Antwort des Modells ${model}`,
      // Ask the gate for an unbuffered body. Without it the gate collects the
      // whole answer before returning, and "streaming" would mean the user
      // stares at nothing and then gets everything at once. A gate that
      // returns a WHATWG Response ignores this flag; both shapes are handled.
      stream: true,
      signal: watchdog.signal,
    });
  } catch (err) {
    watchdog.dispose();
    throw transportError(err, watchdog, { url, phase: 'connect' });
  }

  // Defensive: the gate is another subsystem, and a non-Response here would
  // otherwise surface as an unrelated TypeError three lines further down.
  if (!res || typeof res.status !== 'number') {
    watchdog.dispose();
    throw new ModelError('Die Netzwerkschleuse hat keine verwertbare Antwort geliefert.', { url, provider: KIND });
  }

  if (!res.ok) {
    watchdog.arm(5000, 'idle');
    const excerpt = await readExcerpt(res);
    watchdog.dispose();
    throw new ModelError(
      `Der Modellserver hat die Anfrage mit HTTP ${res.status} abgelehnt: ${describeBody(excerpt)}`,
      { status: res.status, url, model, body: excerpt.slice(0, 600), provider: KIND },
    );
  }

  const accumulator = new ToolCallAccumulator();
  let content = '';
  let finishReason = null;
  let usage = null;
  let lastFrame = null;
  let sawDone = false;
  let sawPayload = false;

  const emit = (text) => {
    if (!text) return;
    content += text;
    if (typeof onDelta !== 'function') return;
    try {
      onDelta(text);
    } catch (err) {
      state.consumerError = state.consumerError || err;
    }
  };

  const handleFrame = (frame) => {
    lastFrame = frame;
    if (frame && frame.error) {
      const message = typeof frame.error === 'string' ? frame.error : (frame.error.message || 'Unbekannter Fehler');
      throw new ModelError(`Der Modellserver meldet: ${message}`, { url, model, provider: KIND });
    }
    if (frame && frame.usage && typeof frame.usage === 'object') usage = frame.usage;
    const choice = frame && Array.isArray(frame.choices) ? frame.choices[0] : null;
    if (!choice) return;
    sawPayload = true;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
    if (delta) {
      if (typeof delta.content === 'string') emit(delta.content);
      if (Array.isArray(delta.tool_calls)) accumulator.mergeDeltas(delta.tool_calls);
    }
    // A server that ignored stream:true answers with `message` instead.
    const message = choice.message && typeof choice.message === 'object' ? choice.message : null;
    if (message) {
      if (typeof message.content === 'string') emit(message.content);
      if (Array.isArray(message.tool_calls)) accumulator.setComplete(message.tool_calls);
    }
  };

  const handleEvent = (evt) => {
    const data = evt.data.trim();
    if (!data) return;
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      throw new ModelError(
        `Der Modellserver hat ein unlesbares SSE-Datenfeld gesendet: ${data.slice(0, 200)}`,
        { url, model, provider: KIND },
      );
    }
    handleFrame(frame);
  };

  const idle = Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
  const sse = new SseParser();
  const decoder = new TextDecoder('utf-8');
  let raw = '';
  let sawEvent = false;

  try {
    watchdog.arm(idle, 'idle');
    for await (const chunk of readBody(res)) {
      watchdog.arm(idle, 'idle'); // a chunk proves the backend is alive
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (!sawEvent && raw.length < MAX_RAW_FALLBACK_BYTES) raw += text;
      // The SSE parser runs regardless of the declared content type: some
      // servers label a real event stream as application/json, and a plain
      // JSON body produces no `data:` field, so it simply yields no events.
      for (const evt of sse.push(text)) {
        sawEvent = true;
        handleEvent(evt);
        if (state.consumerError) break;
      }
      if (state.consumerError) break;
    }
    // Flush the decoder: a multi-byte character may sit half-decoded at the end.
    const tail = decoder.decode();
    if (tail && !sawEvent && raw.length < MAX_RAW_FALLBACK_BYTES) raw += tail;
    if (!state.consumerError) {
      if (tail) {
        for (const evt of sse.push(tail)) {
          sawEvent = true;
          handleEvent(evt);
        }
      }
      for (const evt of sse.flush()) {
        sawEvent = true;
        handleEvent(evt);
      }
    }
    if (!state.consumerError && !sawEvent) {
      // No SSE event at all: the server ignored stream:true and answered with
      // one plain JSON object. Parse it instead of reporting an empty answer.
      const body = raw.trim();
      if (body) {
        let frame;
        try {
          frame = JSON.parse(body);
        } catch {
          throw new ModelError(
            `Der Modellserver hat weder SSE noch gültiges JSON gesendet: ${body.slice(0, 200)}`,
            { url, model, provider: KIND },
          );
        }
        handleFrame(frame);
        sawDone = true;
      }
    }
  } catch (err) {
    throw transportError(err, watchdog, { url, phase: 'stream' });
  } finally {
    watchdog.dispose();
  }

  if (state.consumerError) throw state.consumerError;

  if (!sawDone && !sawPayload) {
    throw new ModelError(
      'Der Modellserver hat die Verbindung beendet, ohne eine Antwort zu senden.',
      { url, model, provider: KIND },
    );
  }

  const toolCalls = accumulator.finish();
  return {
    content,
    toolCalls,
    stats: {
      promptTokens: usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
      completionTokens: usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
      ms: Date.now() - started,
    },
    finishReason,
    raw: { usage, finishReason, lastFrame },
  };
}

/** Embeddings via POST /embeddings. */
async function embed({ baseUrl, model, input, gate, scope = 'global', signal, timeoutMs, apiKey, purpose } = {}) {
  if (typeof model !== 'string' || !model) throw new ValidationError('Es wurde kein Einbettungsmodell angegeben.');
  const inputs = Array.isArray(input) ? input : [input];
  const texts = inputs.filter((t) => typeof t === 'string' && t.length > 0);
  if (!texts.length) throw new ValidationError('Für die Einbettung wurde kein Text übergeben.');
  if (signal && signal.aborted) throw new AbortedError('Die Modellanfrage wurde abgebrochen.');

  const watchdog = new Watchdog(signal);
  const url = apiUrl(baseUrl, '/embeddings');
  try {
    watchdog.arm(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS, 'connect');
    const res = await gateFetch(gate, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ model, input: texts }),
      scope,
      purpose: purpose || `Einbettungen mit ${model}`,
      signal: watchdog.signal,
    });
    if (!res.ok) {
      const excerpt = await readExcerpt(res);
      throw new ModelError(
        `Der Modellserver hat die Einbettung mit HTTP ${res.status} abgelehnt: ${describeBody(excerpt)}`,
        { status: res.status, url, model, provider: KIND },
      );
    }
    const text = await readExcerpt(res, 32 * 1024 * 1024);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ModelError('Der Modellserver hat auf die Einbettung mit unlesbarem JSON geantwortet.', { url, model });
    }
    const rows = Array.isArray(json && json.data) ? json.data : null;
    if (!rows) throw new ModelError('Der Modellserver hat keine Einbettungsvektoren geliefert.', { url, model });
    const ordered = rows.slice().sort((a, b) => (Number(a && a.index) || 0) - (Number(b && b.index) || 0));
    const vectors = ordered.map((row) => (Array.isArray(row && row.embedding) ? row.embedding : null));
    if (vectors.some((v) => v === null)) {
      throw new ModelError('Mindestens ein Einbettungsvektor fehlte in der Antwort.', { url, model });
    }
    return { vectors };
  } catch (err) {
    throw transportError(err, watchdog, { url, phase: 'connect' });
  } finally {
    watchdog.dispose();
  }
}

module.exports = {
  kind: KIND,
  probe,
  chat,
  embed,
  /** Exposed for tests only: framing and normalisation are where bugs hide. */
  __internals: {
    LineSplitter, SseParser, Watchdog, ToolCallAccumulator,
    normaliseModelList, toOpenAiMessages, apiUrl, describeBody, safeParseArgs,
  },
};
