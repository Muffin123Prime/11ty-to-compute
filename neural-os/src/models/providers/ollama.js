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
 * Ollama backend (contract section 7).
 *
 * Why this file is shaped the way it is
 * -------------------------------------
 * - Every byte leaves through `gate.fetch`, including the ones going to
 *   127.0.0.1. Loopback is allowed by policy, but an audit trail that only
 *   records denials proves nothing; a provider that dialled out on its own
 *   would make the whole privacy promise unverifiable.
 * - Ollama answers `/api/chat` with NDJSON. TCP does not respect line
 *   boundaries: a JSON object routinely arrives split across two chunks, and a
 *   multi-byte UTF-8 character (every German umlaut) routinely arrives split
 *   across two chunks as well. Both are handled by ONE streaming TextDecoder
 *   plus a carry buffer for the incomplete tail line (`LineSplitter`). Parsing
 *   each chunk in isolation is the classic bug here.
 * - Two deadlines, not one: a short connect deadline so start-up never hangs
 *   when nothing is listening, and an idle deadline that is reset on every
 *   chunk. A single overall deadline would kill long but perfectly healthy
 *   generations.
 * - Nothing here invents output. Unreachable -> NoModelError, HTTP error ->
 *   ModelError with status and body excerpt, stream that ends before Ollama
 *   said `done` -> ModelError. An empty answer is reported as an empty answer.
 * - The stream/deadline helpers are duplicated in openai.js rather than
 *   extracted: the two wire formats differ in every detail that matters, and
 *   each provider being readable end-to-end in a single file is worth more in
 *   an auditable codebase than saving sixty lines.
 */

const KIND = 'ollama';
/** Probes must be quick: a dead port must not delay start-up. */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
/** Time allowed until the response headers arrive. */
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
/** Time allowed between two stream chunks. Reset on every chunk. */
const DEFAULT_IDLE_TIMEOUT_MS = 120000;
/** A single NDJSON line longer than this means we are not talking to Ollama. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** Transport codes that mean "nothing is listening there", not "it failed". */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT',
]);

// ---------------------------------------------------------------------------
// Incremental framing
// ---------------------------------------------------------------------------

/**
 * Splits a byte or string stream into complete lines across chunk boundaries.
 * The TextDecoder is kept alive between chunks (`stream: true`) so a UTF-8
 * sequence cut in half by the network is reassembled instead of turning into
 * U+FFFD.
 */
class LineSplitter {
  constructor(maxLineBytes = MAX_LINE_BYTES) {
    this.decoder = new TextDecoder('utf-8');
    this.carry = '';
    this.maxLineBytes = maxLineBytes;
  }

  /** @param {Uint8Array|string} chunk @returns {string[]} complete lines */
  push(chunk) {
    if (chunk === null || chunk === undefined) return [];
    this.carry += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.carry.length > this.maxLineBytes) {
      throw new ModelError(
        'Der Modellserver hat eine unplausibel lange Zeile gesendet. Antwortet dort wirklich Ollama?',
        { maxLineBytes: this.maxLineBytes },
      );
    }
    if (this.carry.indexOf('\n') === -1) return [];
    const parts = this.carry.split('\n');
    this.carry = parts.pop();
    return parts.map(stripCr);
  }

  /** Flush the trailing line of a stream that did not end with a newline. */
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

// ---------------------------------------------------------------------------
// Deadlines and cancellation
// ---------------------------------------------------------------------------

/**
 * One AbortController that merges the caller's signal with our own deadlines,
 * and remembers WHY it fired -- without that reason a timeout and a user abort
 * are indistinguishable at the catch site, and they deserve different errors.
 */
class Watchdog {
  constructor(externalSignal) {
    this.controller = new AbortController();
    this.reason = null; // 'caller' | 'connect' | 'idle' | 'consumer'
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

  /** (Re)arm the deadline. Called again on every chunk to keep a stream alive. */
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

/**
 * Yield the response body chunk by chunk, whatever flavour of stream the gate
 * hands back (WHATWG ReadableStream, async iterable, or nothing at all).
 */
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

/** Bounded read of an error body: never pull a gigabyte to quote 600 chars. */
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

/** Ollama puts its real reason in {"error": "..."} -- surface that, not the JSON. */
function describeBody(excerpt) {
  if (!excerpt) return '(leere Antwort)';
  try {
    const parsed = JSON.parse(excerpt);
    if (parsed && typeof parsed.error === 'string') return parsed.error;
    if (parsed && parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
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

/**
 * Turn whatever the transport threw into the right typed error.
 * `phase` matters: a refused connection means "no model there" (NoModelError),
 * the same code mid-stream means the backend failed us (ModelError).
 */
function transportError(err, watchdog, { url, phase }) {
  if (err instanceof NeuralError) return err; // gate denials keep their identity
  const reason = watchdog.reason;
  if (reason === 'caller') return new AbortedError('Die Modellanfrage wurde abgebrochen.');
  if (reason === 'connect') {
    return new NoModelError(
      `Ollama hat unter ${url} nicht innerhalb von ${watchdog.waitedMs} ms geantwortet.`,
      { url, timeoutMs: watchdog.waitedMs, provider: KIND },
    );
  }
  if (reason === 'idle') {
    return new ModelError(
      `Ollama hat ${watchdog.waitedMs} ms lang keine weiteren Daten gesendet; die Antwort ist unvollständig.`,
      { url, timeoutMs: watchdog.waitedMs, provider: KIND },
    );
  }
  if (isAbortError(err)) return new AbortedError('Die Modellanfrage wurde abgebrochen.');
  const detail = describeTransport(err);
  if (phase === 'connect' && UNREACHABLE_CODES.has(errorCode(err))) {
    return new NoModelError(`Ollama ist unter ${url} nicht erreichbar (${detail}).`, { url, provider: KIND });
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

function toOllamaMessages(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
    // Replaying a tool round-trip needs the assistant's own tool calls back in
    // the transcript, otherwise the model cannot connect result to request.
    if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        function: {
          name: tc.name,
          arguments: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : safeParseArgs(tc.arguments).value,
        },
      }));
    }
    if (m.role === 'tool' && typeof m.name === 'string' && m.name) out.tool_name = m.name;
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

function toOllamaOptions(options = {}) {
  const o = {};
  if (Number.isFinite(options.temperature)) o.temperature = options.temperature;
  if (Number.isFinite(options.topP)) o.top_p = options.topP;
  if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) o.num_predict = Math.floor(options.maxTokens);
  if (Number.isFinite(options.seed)) o.seed = Math.floor(options.seed);
  if (Number.isFinite(options.numCtx) && options.numCtx > 0) o.num_ctx = Math.floor(options.numCtx);
  const stop = normaliseStop(options.stop);
  if (stop) o.stop = stop;
  return Object.keys(o).length ? o : undefined;
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
 * Normalise Ollama tool calls to the contract shape `{id, name, arguments}`.
 * Ollama sends arguments as a real object and no id, so an id is synthesised;
 * the runtime needs one to match a result back to its call.
 * When arguments cannot be parsed the call keeps `argumentsError` instead of a
 * silently empty object -- the caller must be able to tell the model it sent
 * something unusable rather than guess.
 */
function normaliseToolCalls(rawCalls, seq) {
  const out = [];
  if (!Array.isArray(rawCalls)) return out;
  for (const raw of rawCalls) {
    const fn = (raw && raw.function) || raw;
    const name = fn && typeof fn.name === 'string' ? fn.name : null;
    if (!name) {
      throw new ModelError('Ollama hat einen Werkzeugaufruf ohne Namen gesendet.', { toolCall: raw });
    }
    const parsed = safeParseArgs(fn.arguments);
    const call = {
      id: (raw && typeof raw.id === 'string' && raw.id) ? raw.id : `call_${seq.next()}_${crypto.randomBytes(4).toString('hex')}`,
      name,
      arguments: parsed.value,
    };
    if (parsed.error) {
      call.argumentsError = parsed.error;
      call.argumentsRaw = typeof fn.arguments === 'string' ? fn.arguments.slice(0, 2000) : null;
    }
    out.push(call);
  }
  return out;
}

function counter() {
  let n = 0;
  return { next: () => ++n };
}

// ---------------------------------------------------------------------------
// Provider API
// ---------------------------------------------------------------------------

function normaliseTagModels(json) {
  const list = Array.isArray(json && json.models) ? json.models : null;
  if (!list) return null;
  const models = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.model === 'string' && m.model ? m.model : (typeof m.name === 'string' ? m.name : null);
    if (!id) continue;
    const details = (m.details && typeof m.details === 'object') ? m.details : {};
    models.push({
      id,
      name: typeof m.name === 'string' && m.name ? m.name : id,
      family: typeof details.family === 'string' ? details.family : null,
      parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : null,
      quantization: typeof details.quantization_level === 'string' ? details.quantization_level : null,
      contextLength: null, // /api/tags does not report it; do not guess a number
      sizeBytes: Number.isFinite(m.size) ? m.size : null,
      modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : null,
    });
  }
  return models;
}

/**
 * Ask the backend what it has. Never throws: a probe failing is an expected,
 * reportable state of the world, not an exception -- the registry probes every
 * configured backend in parallel and must get an answer from each one.
 */
async function probe({ baseUrl, gate, scope = 'global', signal, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, purpose } = {}) {
  const started = Date.now();
  const watchdog = new Watchdog(signal);
  let url = null;
  try {
    url = apiUrl(baseUrl, '/api/tags');
    watchdog.arm(timeoutMs, 'connect');
    const res = await gateFetch(gate, url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      scope,
      purpose: purpose || 'Lokale Modelle suchen (Ollama)',
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
        error: `Unter ${url} antwortet etwas, das kein Ollama ist (unlesbares JSON).`,
        latencyMs: Date.now() - started,
      };
    }
    const models = normaliseTagModels(json);
    if (!models) {
      return {
        available: false,
        models: [],
        error: `Unter ${url} antwortet etwas, das kein Ollama ist (kein "models"-Feld).`,
        latencyMs: Date.now() - started,
      };
    }
    // An Ollama with zero pulled models is available -- the registry says
    // "running, but empty", which needs a different instruction than "absent".
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
 * Streamed chat completion against /api/chat.
 * @returns {Promise<{content:string, toolCalls:Array, stats:object, raw:object, finishReason:string|null}>}
 */
async function chat({
  baseUrl, model, messages, options = {}, tools, gate, scope = 'global', signal, onDelta,
  timeoutMs, idleTimeoutMs, purpose,
} = {}) {
  if (typeof model !== 'string' || !model) throw new ValidationError('Es wurde kein Modellname angegeben.');
  requireMessages(messages);
  if (signal && signal.aborted) throw new AbortedError('Die Modellanfrage wurde abgebrochen.');

  const url = apiUrl(baseUrl, '/api/chat');
  const payload = {
    model,
    messages: toOllamaMessages(messages),
    stream: true,
  };
  const apiTools = toApiTools(tools);
  if (apiTools) payload.tools = apiTools;
  const apiOptions = toOllamaOptions(options);
  if (apiOptions) payload.options = apiOptions;
  if (options.responseFormat === 'json') payload.format = 'json';

  const watchdog = new Watchdog(signal);
  const started = Date.now();
  const seq = counter();
  const state = { consumerError: null };

  let res;
  try {
    watchdog.arm(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS, 'connect');
    res = await gateFetch(gate, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
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
      `Ollama hat die Anfrage mit HTTP ${res.status} abgelehnt: ${describeBody(excerpt)}`,
      { status: res.status, url, model, body: excerpt.slice(0, 600), provider: KIND },
    );
  }

  const splitter = new LineSplitter();
  const idle = Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
  let content = '';
  let toolCalls = [];
  let finalFrame = null;
  let sawDone = false;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      throw new ModelError(
        `Ollama hat eine unlesbare Zeile gesendet: ${trimmed.slice(0, 200)}`,
        { url, model, provider: KIND },
      );
    }
    if (frame && typeof frame.error === 'string') {
      throw new ModelError(`Ollama meldet: ${frame.error}`, { url, model, provider: KIND });
    }
    const message = frame && frame.message;
    if (message && typeof message.content === 'string' && message.content.length) {
      content += message.content;
      if (typeof onDelta === 'function') {
        try {
          onDelta(message.content);
        } catch (err) {
          state.consumerError = state.consumerError || err;
        }
      }
    }
    if (message && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      toolCalls = toolCalls.concat(normaliseToolCalls(message.tool_calls, seq));
    }
    if (frame && frame.done === true) {
      sawDone = true;
      finalFrame = frame;
    }
  };

  try {
    watchdog.arm(idle, 'idle');
    for await (const chunk of readBody(res)) {
      watchdog.arm(idle, 'idle'); // a chunk proves the backend is alive
      for (const line of splitter.push(chunk)) {
        handleLine(line);
        if (state.consumerError) break;
      }
      if (state.consumerError) break;
    }
    if (!state.consumerError) {
      for (const line of splitter.flush()) handleLine(line);
    }
  } catch (err) {
    throw transportError(err, watchdog, { url, phase: 'stream' });
  } finally {
    watchdog.dispose();
  }

  if (state.consumerError) throw state.consumerError;

  if (!sawDone) {
    throw new ModelError(
      'Die Antwort von Ollama brach ab, bevor sie vollständig war.',
      { url, model, provider: KIND, partialContent: content.slice(0, 2000) },
    );
  }

  return {
    content,
    toolCalls,
    stats: {
      promptTokens: Number.isFinite(finalFrame.prompt_eval_count) ? finalFrame.prompt_eval_count : null,
      completionTokens: Number.isFinite(finalFrame.eval_count) ? finalFrame.eval_count : null,
      ms: Date.now() - started,
    },
    finishReason: typeof finalFrame.done_reason === 'string' ? finalFrame.done_reason : null,
    raw: finalFrame,
  };
}

/**
 * Embeddings. Ollama renamed the endpoint: /api/embed (batch) replaced
 * /api/embeddings (single). Try the new one, fall back on 404 so older
 * installations keep working.
 */
async function embed({ baseUrl, model, input, gate, scope = 'global', signal, timeoutMs, purpose } = {}) {
  if (typeof model !== 'string' || !model) throw new ValidationError('Es wurde kein Einbettungsmodell angegeben.');
  const inputs = Array.isArray(input) ? input : [input];
  const texts = inputs.filter((t) => typeof t === 'string' && t.length > 0);
  if (!texts.length) throw new ValidationError('Für die Einbettung wurde kein Text übergeben.');
  if (signal && signal.aborted) throw new AbortedError('Die Modellanfrage wurde abgebrochen.');

  const watchdog = new Watchdog(signal);
  const url = apiUrl(baseUrl, '/api/embed');
  try {
    watchdog.arm(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS, 'connect');
    const res = await gateFetch(gate, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      scope,
      purpose: purpose || `Einbettungen mit ${model}`,
      signal: watchdog.signal,
    });
    if (res.status === 404) {
      watchdog.dispose();
      return embedLegacy({ baseUrl, model, texts, gate, scope, signal, timeoutMs, purpose });
    }
    if (!res.ok) {
      const excerpt = await readExcerpt(res);
      throw new ModelError(
        `Ollama hat die Einbettung mit HTTP ${res.status} abgelehnt: ${describeBody(excerpt)}`,
        { status: res.status, url, model, provider: KIND },
      );
    }
    const text = await readExcerpt(res, 32 * 1024 * 1024);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ModelError('Ollama hat auf die Einbettung mit unlesbarem JSON geantwortet.', { url, model });
    }
    const vectors = Array.isArray(json && json.embeddings) ? json.embeddings : null;
    if (!vectors || !vectors.every((v) => Array.isArray(v))) {
      throw new ModelError('Ollama hat keine Einbettungsvektoren geliefert.', { url, model });
    }
    return { vectors };
  } catch (err) {
    throw transportError(err, watchdog, { url, phase: 'connect' });
  } finally {
    watchdog.dispose();
  }
}

async function embedLegacy({ baseUrl, model, texts, gate, scope, signal, timeoutMs, purpose }) {
  const url = apiUrl(baseUrl, '/api/embeddings');
  const vectors = [];
  for (const prompt of texts) {
    const watchdog = new Watchdog(signal);
    try {
      watchdog.arm(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS, 'connect');
      const res = await gateFetch(gate, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ model, prompt }),
        scope,
        purpose: purpose || `Einbettungen mit ${model}`,
        signal: watchdog.signal,
      });
      if (!res.ok) {
        const excerpt = await readExcerpt(res);
        throw new ModelError(
          `Ollama hat die Einbettung mit HTTP ${res.status} abgelehnt: ${describeBody(excerpt)}`,
          { status: res.status, url, model, provider: KIND },
        );
      }
      const json = JSON.parse(await readExcerpt(res, 32 * 1024 * 1024));
      if (!Array.isArray(json && json.embedding)) {
        throw new ModelError('Ollama hat keinen Einbettungsvektor geliefert.', { url, model });
      }
      vectors.push(json.embedding);
    } catch (err) {
      throw transportError(err, watchdog, { url, phase: 'connect' });
    } finally {
      watchdog.dispose();
    }
  }
  return { vectors };
}

module.exports = {
  kind: KIND,
  probe,
  chat,
  embed,
  /** Exposed for tests only: framing and normalisation are where bugs hide. */
  __internals: { LineSplitter, Watchdog, normaliseToolCalls, normaliseTagModels, apiUrl, describeBody, counter, safeParseArgs },
};
