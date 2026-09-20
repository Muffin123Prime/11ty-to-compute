/**
 * api.js -- the only place in the interface that talks to the server.
 *
 * Three deliberate properties:
 *
 * 1. **Same origin, enforced twice.** The server's CSP already pins
 *    `connect-src 'self'`, so the browser refuses any outbound request the UI
 *    might attempt. This module refuses it a second time, in code, before the
 *    request is built -- a mistake here should fail loudly during development,
 *    not silently in a browser whose CSP header got lost behind a proxy.
 * 2. **Errors keep their identity.** The server answers `{error:{code,message,
 *    details}}` with a meaningful status; `ApiError` carries all of it through
 *    so a view can tell "vault locked" from "no model" from "you are offline"
 *    and say something useful in German instead of "Fehler".
 * 3. **Nothing is invented.** A failed request never resolves with a default
 *    value. If the server cannot be reached, the caller finds out.
 *
 * The `X-Neural-OS: 1` header on mutating requests is the client half of the
 * server's CSRF defence (`src/http/auth.js`): a cross-site form post cannot set
 * a custom header, so its absence identifies a request the UI did not make.
 */

const API_PREFIX = '/api';
const DEFAULT_TIMEOUT_MS = 30000;
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export class ApiError extends Error {
  /**
   * @param {string} code    stable identifier, mirrors src/kernel/errors.js
   * @param {string} message German, safe to show to the user
   * @param {{status?:number, details?:any, cause?:any}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'ApiError';
    this.code = code || 'INTERNAL_ERROR';
    this.status = Number.isFinite(opts.status) ? opts.status : 0;
    this.details = opts.details ?? null;
  }

  /** True when the request never reached the server at all. */
  get isTransport() {
    return this.status === 0;
  }

  /** True when the user aborted (stop button, view change) -- not a failure. */
  get isAborted() {
    return this.code === 'ABORTED';
  }
}

/** Build a same-origin URL from a path like 'status', '/status' or '/api/status'. */
function resolveUrl(path) {
  const raw = String(path ?? '');
  let candidate;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) candidate = raw;
  else if (raw.startsWith(API_PREFIX + '/') || raw === API_PREFIX) candidate = raw;
  else if (raw.startsWith('/')) candidate = API_PREFIX + raw;
  else candidate = `${API_PREFIX}/${raw}`;

  const url = new URL(candidate, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new ApiError(
      'FORBIDDEN_ORIGIN',
      'Die Oberfläche spricht ausschließlich mit dem lokalen Server. Ein Ziel außerhalb wurde abgelehnt.',
      { status: 0, details: { url: url.origin } },
    );
  }
  return url;
}

/** Append query parameters, skipping empty ones so '?q=' never shows up. */
function withQuery(url, query) {
  if (!query) return url;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url;
}

/** One AbortSignal from a caller signal plus an optional timeout. */
function combineSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const cleanups = [];
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else {
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }
  }
  if (timeoutMs > 0) {
    const timer = setTimeout(() => controller.abort(new ApiError('TIMEOUT', `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s.`, { status: 0 })), timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  }
  return { signal: controller.signal, done: () => cleanups.forEach((fn) => fn()) };
}

const TRANSPORT_MESSAGE = 'Der lokale Neural-OS-Server ist nicht erreichbar. Läuft er noch?';

/** Turn whatever fetch threw into an ApiError without losing the reason. */
function asTransportError(err) {
  if (err instanceof ApiError) return err;
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    const reason = err.reason || (err.cause instanceof ApiError ? err.cause : null);
    if (reason instanceof ApiError) return reason;
    return new ApiError('ABORTED', 'Die Anfrage wurde abgebrochen.', { status: 0, cause: err });
  }
  return new ApiError('NETWORK_UNREACHABLE', TRANSPORT_MESSAGE, { status: 0, cause: err });
}

const STATUS_FALLBACKS = {
  400: ['VALIDATION_FAILED', 'Die Anfrage war unvollständig oder fehlerhaft.'],
  401: ['UNAUTHORIZED', 'Anmeldung erforderlich.'],
  403: ['PERMISSION_DENIED', 'Diese Aktion ist nicht erlaubt.'],
  404: ['NOT_FOUND', 'Nicht gefunden.'],
  413: ['TOO_LARGE', 'Die Daten sind zu groß für eine Anfrage.'],
  423: ['VAULT_LOCKED', 'Der Tresor ist gesperrt. Bitte zuerst entsperren.'],
  429: ['TOO_MANY', 'Zu viele Anfragen hintereinander.'],
  500: ['INTERNAL_ERROR', 'Im Server ist ein unerwarteter Fehler aufgetreten.'],
  502: ['MODEL_ERROR', 'Das Modell-Backend hat die Anfrage nicht beantwortet.'],
  503: ['SUBSYSTEM_UNAVAILABLE', 'Dieser Teil des Systems ist gerade nicht verfügbar.'],
};

/** Read the body of a failed response and build the richest error it allows. */
async function errorFromResponse(response) {
  const [fallbackCode, fallbackMessage] = STATUS_FALLBACKS[response.status] || ['REQUEST_FAILED', `Die Anfrage ist fehlgeschlagen (HTTP ${response.status}).`];
  let body = null;
  try {
    const raw = await response.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { error: { code: fallbackCode, message: raw.slice(0, 400) } };
      }
    }
  } catch {
    /* body already consumed or connection died mid-read: the status still stands */
  }
  const error = body && typeof body === 'object' ? (body.error || body) : null;
  return new ApiError(
    (error && error.code) || fallbackCode,
    (error && error.message) || fallbackMessage,
    { status: response.status, details: (error && error.details) ?? null },
  );
}

/**
 * @param {string} method
 * @param {string} path
 * @param {any} body JSON-serialisable, or undefined
 * @param {{query?:object, signal?:AbortSignal, timeoutMs?:number, headers?:object, raw?:boolean}} [opts]
 */
async function request(method, path, body, opts = {}) {
  const url = withQuery(resolveUrl(path), opts.query);
  const upper = method.toUpperCase();
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  if (!SAFE_METHODS.has(upper)) headers['X-Neural-OS'] = '1';

  let payload;
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    try {
      payload = JSON.stringify(body);
    } catch (err) {
      throw new ApiError('VALIDATION_FAILED', 'Die Daten konnten nicht als JSON kodiert werden.', { status: 0, cause: err });
    }
  }

  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
  const { signal, done } = combineSignals(opts.signal, timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: upper,
      headers,
      body: payload,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      // `same-origin` turns a cross-origin redirect into a network error, so
      // following redirects cannot be used to walk the UI off this server.
      redirect: 'follow',
      mode: 'same-origin',
    });
  } catch (err) {
    throw asTransportError(err);
  } finally {
    done();
  }

  if (!response.ok) throw await errorFromResponse(response);
  if (opts.raw) return response;
  if (response.status === 204 || response.status === 205) return null;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) return response.text();
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ApiError('BAD_RESPONSE', 'Die Antwort des Servers war kein gültiges JSON.', { status: response.status, cause: err });
  }
}

/* --------------------------------------------------------------------- */
/* Server-sent events                                                     */
/* --------------------------------------------------------------------- */

/**
 * Incremental SSE parser. Handles CRLF and LF, multi-line `data:` fields and
 * comment lines (`:` keep-alives, which are how a proxy-free local stream
 * still notices a dead peer).
 */
function createSseParser(onFrame) {
  let buffer = '';
  let frame = { event: null, data: [], id: null, retry: null };

  const flush = () => {
    if (!frame.data.length && frame.event === null && frame.id === null) {
      frame = { event: null, data: [], id: null, retry: null };
      return;
    }
    const raw = frame.data.join('\n');
    let parsed = raw;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw; // a plain-text payload is legal SSE; keep it as a string
      }
    }
    onFrame({ event: frame.event, data: parsed, raw, id: frame.id, retry: frame.retry });
    frame = { event: null, data: [], id: null, retry: null };
  };

  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer.startsWith('\r\n', index) ? 2 : 1));
        if (line === '') {
          flush();
          continue;
        }
        if (line.startsWith(':')) continue; // keep-alive comment
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') frame.data.push(value);
        else if (field === 'event') frame.event = value;
        else if (field === 'id') frame.id = value;
        else if (field === 'retry') frame.retry = Number(value) || null;
      }
    },
    end() {
      if (buffer.length) {
        this.push('\n');
        buffer = '';
      }
      flush();
    },
  };
}

/**
 * Normalise a frame into the event shape the UI works with.
 *
 * The server may name the event in the SSE `event:` field, inside the JSON
 * payload (`{name, seq, at, payload}` -- the bus envelope) or both. Accepting
 * either keeps the client honest about what it received instead of guessing.
 */
function normaliseEvent(frame) {
  const data = frame.data;
  const envelope = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const seqCandidates = [frame.id, envelope && envelope.seq];
  let seq = null;
  for (const candidate of seqCandidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) seq = value;
  }
  return {
    type: frame.event || (envelope && typeof envelope.name === 'string' ? envelope.name : 'message'),
    seq,
    at: (envelope && envelope.at) || null,
    payload: envelope && 'payload' in envelope ? envelope.payload : data,
    raw: data,
  };
}

/** Read an SSE body to its end, feeding `onEvent`. Resolves when it closes. */
async function consumeEventStream(response, onEvent, onFrameSeen) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new ApiError('STREAM_UNSUPPORTED', 'Dieser Browser kann den Ereignis-Datenstrom nicht lesen.', { status: response.status });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser((frame) => {
    if (onFrameSeen) onFrameSeen();
    const event = normaliseEvent(frame);
    try {
      onEvent(event);
    } catch (err) {
      // A crashing handler must not tear down the stream everything depends on.
      console.error('[neural-os] Ereignis-Handler ist gescheitert:', err);
    }
  });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.end();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released because the stream errored */
    }
  }
}

/**
 * POST a request whose answer is an SSE stream (chat completion).
 *
 * @param {string} path
 * @param {{body?:any, onEvent:(e:object)=>void, signal?:AbortSignal, method?:string}} opts
 * @returns {Promise<{events:number}>}
 */
async function stream(path, opts = {}) {
  const { body, onEvent, signal, method = 'POST' } = opts;
  if (typeof onEvent !== 'function') throw new TypeError('stream(): onEvent fehlt.');
  const url = resolveUrl(path);
  const headers = { Accept: 'text/event-stream', 'X-Neural-OS': '1' };
  let payload;
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      mode: 'same-origin',
    });
  } catch (err) {
    throw asTransportError(err);
  }
  if (!response.ok) throw await errorFromResponse(response);

  let count = 0;
  try {
    await consumeEventStream(response, (event) => {
      count += 1;
      onEvent(event);
    });
  } catch (err) {
    const wrapped = asTransportError(err);
    if (wrapped.isAborted) throw wrapped;
    throw new ApiError('STREAM_INTERRUPTED', 'Die Verbindung ist während der Antwort abgebrochen.', { status: 0, cause: err });
  }
  return { events: count };
}

/**
 * Subscribe to `/api/events`.
 *
 * Written on `fetch` rather than `EventSource` for one reason: we need to pass
 * `?since=<seq>` on every reconnect so the server can replay what was missed.
 * `EventSource` owns its own retry loop and would reconnect to the original
 * URL, silently losing every event that happened while the tab was asleep --
 * and an event the UI never sees is a UI that quietly lies about the system.
 *
 * @param {(event:{type:string,seq:number|null,payload:any})=>void} onEvent
 * @param {{since?:number, onStatus?:(state:string, info?:object)=>void}} [opts]
 * @returns {{close():void, retryNow():void, readonly lastSeq:number, readonly state:string}}
 */
function events(onEvent, opts = {}) {
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  let lastSeq = Number.isFinite(opts.since) ? Number(opts.since) : 0;
  let attempt = 0;
  let state = 'idle';
  let closed = false;
  let controller = null;
  let timer = null;

  const setState = (next, info) => {
    if (state === next && !info) return;
    state = next;
    onStatus(next, info || {});
  };

  /** 0.5 s, 1 s, 2 s ... capped at 15 s, with jitter so retries do not lockstep. */
  const backoffMs = () => {
    const base = Math.min(15000, 500 * 2 ** Math.min(attempt, 5));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  };

  const schedule = () => {
    if (closed) return;
    const delay = backoffMs();
    attempt += 1;
    setState('reconnecting', { delay, attempt });
    timer = setTimeout(connect, delay);
  };

  async function connect() {
    if (closed) return;
    timer = null;
    controller = new AbortController();
    const url = withQuery(resolveUrl('/events'), lastSeq > 0 ? { since: lastSeq } : null);
    setState('connecting');
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
        mode: 'same-origin',
      });
      if (!response.ok) throw await errorFromResponse(response);
      attempt = 0;
      setState('open');
      await consumeEventStream(response, (event) => {
        if (event.seq && event.seq > lastSeq) lastSeq = event.seq;
        if (event.type === 'ready' || event.type === 'open') return; // handshake frame, not a bus event
        onEvent(event);
      });
      // A clean end still means "no live events any more": reconnect.
      if (!closed) schedule();
    } catch (err) {
      if (closed) return;
      const wrapped = asTransportError(err);
      if (wrapped.isAborted) return;
      setState('error', { error: wrapped });
      schedule();
    }
  }

  const retryNow = () => {
    if (closed) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (controller) controller.abort();
    attempt = 0;
    connect();
  };

  // A machine waking from sleep fires 'online' long before a 15 s backoff ends.
  const onOnline = () => {
    if (!closed && state !== 'open') retryNow();
  };
  window.addEventListener('online', onOnline);

  connect();

  return {
    close() {
      closed = true;
      window.removeEventListener('online', onOnline);
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
      setState('closed');
    },
    retryNow,
    get lastSeq() {
      return lastSeq;
    },
    get state() {
      return state;
    },
  };
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),
  request,
  stream,
  events,
};

export default api;
