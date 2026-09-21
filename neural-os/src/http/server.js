'use strict';

/**
 * The HTTP boundary.
 *
 * Why this file is shaped the way it is:
 *
 * - **One handler, no forgettable middleware.** Security headers, the Host
 *   check and the CSRF check run before the router is consulted, so no route
 *   can be added later that quietly misses them.
 * - **The CSP is not decoration.** `connect-src 'self'` is what turns "the
 *   interface cannot talk to a foreign host" from a promise the code makes
 *   about itself into something the browser enforces. It is therefore emitted
 *   on *every* response -- errors, event streams and static files included.
 * - **Dependencies arrive as one injected `ctx`.** The subsystems are built
 *   independently and any of them may be missing. A route that needs an absent
 *   subsystem answers 503 with a German sentence naming it; it never crashes
 *   the process, and it is never replaced by something that fakes success.
 * - **Handlers return data and throw typed errors.** This module serialises
 *   and maps `err.status` / `err.toJSON()`. Unknown errors become a 500 with a
 *   generic message: the stack goes to the log, never to the client, because
 *   an error message that leaks a filesystem path is a small data leak.
 * - **Streams are accounted for.** Every SSE response lives in `streams` with
 *   a heartbeat and a cleanup handler, so a closed laptop lid cannot leave a
 *   subscription and a timer behind, and shutdown can end them deliberately.
 *
 * Deliberate omission: there is no CORS header anywhere. Same-origin is the
 * whole security model of this server; an `Access-Control-Allow-Origin` would
 * hand it away.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  NeuralError,
  ValidationError,
  NotFoundError,
  PermissionError,
  AuthError,
  asNeuralError,
} = require('../kernel/errors');
const { safeJoin } = require('../kernel/paths');
const { logger: kernelLogger } = require('../kernel/log');

/* ------------------------------------------------------------- constants */

/** Exactly the policy from the build contract. Keep the wording in sync. */
const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  // Redundant next to frame-ancestors, kept for browsers that predate CSP 2.
  'X-Frame-Options': 'DENY',
};

const DEFAULT_BODY_LIMIT = 32 * 1024 * 1024;
/** Browsers give up on a silent event stream after ~45 s; 25 s is comfortably inside. */
const HEARTBEAT_MS = 25000;
const DEFAULT_MAX_STREAMS = 8;
/** A client that stopped reading must not grow this process's heap. */
const STREAM_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const CLOSE_GRACE_MS = 3000;
/** Beat after the last socket is closed, so peers notice before a rebind. */
const SOCKET_SETTLE_MS = 30;
/** Header the UI must send on every mutating request (CSRF). */
const CSRF_HEADER = 'x-neural-os';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const CAPABILITY_LABEL = {
  read: 'Lesen',
  write: 'Ändern',
  chat: 'Chatten',
  agents: 'Agenten steuern',
};

/* ---------------------------------------------------------------- router */

/**
 * A router small enough to read in one sitting. Patterns are literal segments
 * and `:name` parameters -- no regular expressions, because a regex router is
 * where "/api/records/:id" quietly starts matching "/api/records/../../etc".
 */
function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean).map((segment) => (
      segment.startsWith(':') ? { param: segment.slice(1) } : { literal: segment }
    ));
    routes.push({ method, pattern, segments, handler });
  }

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let allowed = null;
    for (const route of routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const segment = route.segments[i];
        if (segment.literal !== undefined) {
          if (segment.literal !== parts[i]) { ok = false; break; }
        } else {
          const raw = parts[i];
          if (!raw) { ok = false; break; }
          params[segment.param] = decodeSegment(raw);
        }
      }
      if (!ok) continue;
      // HEAD is served by the GET handler; the response body is dropped later.
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { route, params };
      allowed = allowed || new Set();
      allowed.add(route.method);
      if (route.method === 'GET') allowed.add('HEAD');
    }
    return allowed ? { allowed: Array.from(allowed).sort() } : null;
  }

  function decodeSegment(raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new ValidationError('Die Adresse enthält eine ungültige Prozent-Kodierung.');
    }
  }

  return {
    add,
    match,
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    list: () => routes.map((r) => `${r.method} ${r.pattern}`),
  };
}

/* ------------------------------------------------------------- utilities */

/** `ctx.logger` is the factory from kernel/log in the real app, a plain object in tests. */
function makeLogger(ctx, scope) {
  const candidate = ctx && ctx.logger;
  if (typeof candidate === 'function') {
    try {
      const made = candidate(scope);
      if (made && typeof made.info === 'function') return made;
    } catch { /* fall through to the kernel logger */ }
  }
  if (candidate && typeof candidate.info === 'function') return candidate;
  return kernelLogger(scope);
}

function isIpLiteral(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every((o) => Number(o) <= 255);
  return /^[0-9a-f:]+$/i.test(host) && host.includes(':');
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '[::1]' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.startsWith('::ffff:')) return isLoopbackHost(h.slice(7));
  return false;
}

function isLoopbackAddress(address) {
  return isLoopbackHost(String(address || '').replace(/^\[|\]$/g, ''));
}

/** Split `host:port`, `[::1]:7777`, `example.com` into a bare hostname. */
function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    return close === -1 ? raw.slice(1) : raw.slice(1, close);
  }
  const colon = raw.indexOf(':');
  // A bare IPv6 literal without brackets has several colons and no port.
  if (colon === -1) return raw;
  if (raw.indexOf(':', colon + 1) !== -1) return raw;
  return raw.slice(0, colon);
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ the server */

/**
 * @param {object} ctx {config, paths, store, gate, registry, chat, runtime,
 *   toolbox, approvals, auth, backup, bus, audit, logger, vaultCrypto, ...}
 * @returns {Promise<{server:import('node:http').Server, listen:Function, close:Function, url:string|null}>}
 */
async function createServer(ctx = {}) {
  const config = ctx.config || {};
  const serverConfig = config.server || {};
  const log = makeLogger(ctx, 'http');

  const bodyLimit = Number.isInteger(serverConfig.maxBodyBytes) && serverConfig.maxBodyBytes > 0
    ? serverConfig.maxBodyBytes
    : DEFAULT_BODY_LIMIT;
  const maxStreams = Number.isInteger(serverConfig.maxEventStreams) && serverConfig.maxEventStreams > 0
    ? serverConfig.maxEventStreams
    : DEFAULT_MAX_STREAMS;
  const heartbeatMs = Number.isInteger(serverConfig.heartbeatMs) && serverConfig.heartbeatMs >= 1000
    ? serverConfig.heartbeatMs
    : HEARTBEAT_MS;
  // Overridable so tests (and a packaged build) can point the shell elsewhere.
  const webRoot = path.resolve(ctx.webRoot || serverConfig.webRoot || path.join(__dirname, '..', '..', 'web'));

  /** @type {Set<object>} every open SSE stream, so shutdown can end them all. */
  const streams = new Set();
  let closing = false;
  let closePromise = null;

  const router = createRouter();
  for (const mod of [
    require('./api/system'),
    require('./api/records'),
    require('./api/graph'),
    require('./api/chat'),
    require('./api/models'),
    require('./api/network'),
    require('./api/agents'),
    require('./api/vault'),
    require('./api/sync'),
    require('./api/modules'),
  ]) {
    mod.register(router);
  }

  // A half-sent request must not hold a connection open for ever
  // (`Content-Length: 5000` and then silence). `requestTimeout` covers
  // *receiving* the request only -- it stops counting once the body is
  // complete -- so a long-lived event stream is unaffected by it, while a
  // stalled upload is not. `connectionsCheckingInterval` is how often that is
  // actually checked; the default (30 s) would make a short timeout a fiction.
  const requestTimeout = Number.isInteger(serverConfig.requestTimeoutMs) && serverConfig.requestTimeoutMs >= 0
    ? serverConfig.requestTimeoutMs
    : 120000;
  const server = http.createServer({
    requestTimeout,
    // Node insists this stays at or below requestTimeout.
    headersTimeout: requestTimeout > 0 ? Math.min(60000, requestTimeout) : 60000,
    // Comfortably above a typical client's own keep-alive, so the browser
    // never picks a socket this server is about to close.
    keepAliveTimeout: 65000,
    connectionsCheckingInterval: Math.max(250, Math.min(30000, Math.round((requestTimeout || 120000) / 4))),
  }, handle);
  server.on('clientError', (err, socket) => {
    if (!socket || socket.destroyed) return;
    // Malformed request line/headers: answer minimally and hang up.
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } catch { /* socket already gone */ }
    log.debug(`clientError: ${err && err.message}`);
  });

  /* ------------------------------------------------------ request context */

  function makeContext(req, res, target) {
    const rc = {
      req,
      res,
      ctx,
      log,
      method: req.method,
      pathname: target.pathname,
      query: target.query,
      params: {},
      identity: null,
      /** set once a handler has taken over the response (SSE, file stream) */
      handled: false,
      stream: null,
      _bodyRead: false,
      _body: undefined,

      /** Raw request body, subject to the 32 MB limit. */
      raw: () => readRaw(rc),
      /** Parsed JSON body; `{}` when the request carried none. */
      body: () => readJson(rc),
      openStream: (opts) => openStream(rc, opts),
      requireCapability: (capability) => requireCapability(rc, capability),
      requireOwner: (what) => requireOwner(rc, what),
      json: (status, payload) => sendJson(rc, status, payload),
    };
    return rc;
  }

  /* ---------------------------------------------------------- body reading */

  function tooLarge(size) {
    return new NeuralError(
      'PAYLOAD_TOO_LARGE',
      `Die Anfrage ist zu groß (${Math.round(size / 1024)} KB, erlaubt sind ${Math.round(bodyLimit / 1024)} KB).`,
      { status: 413, details: { limitBytes: bodyLimit } },
    );
  }

  function readRaw(rc) {
    if (rc._bodyRead) return Promise.resolve(rc._raw || Buffer.alloc(0));
    rc._bodyRead = true;
    rc._raw = Buffer.alloc(0);
    const { req } = rc;
    // How much of a body we already refused we are still willing to read and
    // throw away. Draining lets the client finish writing and then READ the
    // refusal; tearing the socket down instead usually swallows the response
    // and leaves the user with a reset they cannot interpret.
    const drainCap = bodyLimit + 1024 * 1024;

    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      const chunks = [];
      let size = 0;
      let drained = 0;
      let overflowed = false;
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const onData = (chunk) => {
        if (overflowed) {
          drained += chunk.length;
          if (drained > drainCap) req.destroy();
          return;
        }
        size += chunk.length;
        if (size > bodyLimit) {
          chunks.length = 0;
          overflowed = true;
          settle(reject, tooLarge(size));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        if (overflowed) return;
        rc._raw = Buffer.concat(chunks);
        settle(resolve, rc._raw);
      };
      const onError = (err) => settle(reject, asNeuralError(err));
      const onClose = () => {
        if (req.complete) return;
        settle(reject, new NeuralError('CLIENT_ABORTED', 'Die Verbindung wurde abgebrochen, bevor die Anfrage vollständig war.', { status: 499 }));
      };

      // Announced as too large: refuse before reading a single byte of it.
      if (Number.isFinite(declared) && declared > bodyLimit) {
        overflowed = true;
        settle(reject, tooLarge(declared));
      }

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('close', onClose);
    });
  }

  async function readJson(rc) {
    if (rc._body !== undefined) return rc._body;
    const raw = await rc.raw();
    if (!raw.length) {
      rc._body = {};
      return rc._body;
    }
    const type = String(rc.req.headers['content-type'] || '').toLowerCase();
    if (type && !type.includes('json') && !type.includes('text/plain')) {
      throw new ValidationError(`Inhaltstyp "${type}" wird nicht unterstützt; erwartet wird application/json.`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      throw new ValidationError(`Der Anfragekörper ist kein gültiges JSON: ${err.message}`);
    }
    rc._body = parsed;
    return parsed;
  }

  /* --------------------------------------------------------------- output */

  function sendJson(rc, status, payload) {
    const { res } = rc;
    if (res.writableEnded) return;
    let body;
    try {
      body = Buffer.from(JSON.stringify(payload === undefined ? null : payload), 'utf8');
    } catch (err) {
      throw new NeuralError('SERIALISATION_FAILED', `Die Antwort konnte nicht als JSON dargestellt werden: ${err.message}`);
    }
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    if (rc.method === 'HEAD') res.end();
    else res.end(body);
    rc.handled = true;
  }

  function sendError(rc, res, err) {
    const neural = asNeuralError(err);
    const known = err instanceof NeuralError;
    const status = Number.isInteger(neural.status) && neural.status >= 100 && neural.status <= 599
      ? neural.status
      : 500;

    const where = `${(rc && rc.method) || '?'} ${(rc && rc.pathname) || '?'}`;
    if (!known || status >= 500) {
      log.error(`${where} -> ${status} ${neural.code}: ${neural.message}`);
      if (neural.stack && !known) log.debug(neural.stack);
    } else {
      log.debug(`${where} -> ${status} ${neural.code}`);
    }

    const body = known
      ? neural.toJSON()
      : {
        error: {
          code: 'INTERNAL_ERROR',
          // Deliberately vague: the details are in the server log, and an
          // error message is not the place to leak paths or configuration.
          message: 'Interner Fehler im Server. Einzelheiten stehen im Serverprotokoll.',
          details: null,
        },
      };

    if (res.writableEnded) return;

    if (res.headersSent) {
      // Already streaming: say so in the stream's own language, then stop.
      if (rc && rc.stream && !rc.stream.closed) {
        rc.stream.send('error', body);
        rc.stream.close();
      } else {
        res.destroy();
      }
      return;
    }

    let payload;
    try {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
    } catch {
      payload = Buffer.from('{"error":{"code":"INTERNAL_ERROR","message":"Interner Fehler."}}', 'utf8');
    }
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
    };
    if (status === 401) headers['WWW-Authenticate'] = 'Bearer realm="Neural OS"';
    res.writeHead(status, headers);
    // The socket is deliberately left alone here. A client that is still
    // uploading a body we refused keeps writing into `readRaw`, which drains
    // and (only past a hard cap) destroys; tearing the socket down from this
    // side would usually swallow the very response that explains the refusal.
    if (rc && rc.method === 'HEAD') res.end();
    else res.end(payload);
  }

  /* ------------------------------------------------------------------ SSE */

  /**
   * Turn the current response into an event stream.
   * The caller owns the stream afterwards; `handled` stops the framework from
   * writing a JSON body over it.
   */
  function openStream(rc, opts = {}) {
    if (closing) {
      throw new NeuralError('SERVER_CLOSING', 'Der Server wird gerade beendet.', { status: 503 });
    }
    if (streams.size >= maxStreams) {
      throw new NeuralError(
        'TOO_MANY_STREAMS',
        `Es sind bereits ${maxStreams} Ereignis-Verbindungen offen. Schließe einen anderen Tab und versuche es erneut.`,
        { status: 503, details: { open: streams.size, max: maxStreams } },
      );
    }

    if (rc.method === 'HEAD') {
      // A HEAD would open a stream nobody can read and nothing would ever
      // close it; saying so is better than leaking a connection.
      throw new NeuralError('METHOD_NOT_ALLOWED', 'HEAD wird für Ereignisströme nicht unterstützt.', { status: 405 });
    }

    const { req, res } = rc;
    if (req.socket) {
      // Events are small and latency-sensitive; Nagle would batch them.
      try { req.socket.setNoDelay(true); } catch { /* not a TCP socket */ }
      try { req.socket.setTimeout(0); } catch { /* ignore */ }
    }
    if (typeof res.setTimeout === 'function') res.setTimeout(0);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer would defeat the point of a stream.
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    const onCloseHandlers = [];

    function write(chunk) {
      if (closed || res.writableEnded) return false;
      try {
        res.write(chunk);
      } catch (err) {
        log.debug(`Ereignisstrom konnte nicht schreiben: ${err && err.message}`);
        cleanup();
        return false;
      }
      if (res.writableLength > STREAM_BACKPRESSURE_BYTES) {
        log.warn('Ereignisstrom wird beendet: der Client liest nicht mehr mit.');
        stream.close('backpressure');
        return false;
      }
      return true;
    }

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      streams.delete(stream);
      for (const fn of onCloseHandlers) {
        try { fn(); } catch (err) { log.warn(`Aufräumen eines Ereignisstroms schlug fehl: ${err && err.message}`); }
      }
    }

    const stream = {
      get closed() { return closed || res.writableEnded; },
      /** @param {string} event @param {*} data @param {number|string} [id] */
      send(event, data, id) {
        const lines = [];
        if (id !== undefined && id !== null) lines.push(`id: ${id}`);
        if (event) lines.push(`event: ${event}`);
        let payload;
        try {
          payload = typeof data === 'string' ? data : JSON.stringify(data === undefined ? null : data);
        } catch (err) {
          payload = JSON.stringify({ error: { code: 'SERIALISATION_FAILED', message: String(err && err.message) } });
        }
        for (const line of String(payload).split(/\r\n|\r|\n/)) lines.push(`data: ${line}`);
        return write(`${lines.join('\n')}\n\n`);
      },
      /** SSE comments keep the connection warm without reaching the UI. */
      comment(text) {
        return write(`: ${String(text).replace(/[\r\n]+/g, ' ')}\n\n`);
      },
      onClose(fn) {
        if (typeof fn === 'function') onCloseHandlers.push(fn);
      },
      close() {
        const wasOpen = !closed;
        cleanup();
        if (wasOpen && !res.writableEnded) {
          try { res.end(); } catch { /* socket already gone */ }
        }
      },
    };

    const beat = setInterval(() => stream.comment(`hb ${new Date().toISOString()}`), heartbeatMs);
    if (typeof beat.unref === 'function') beat.unref();

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    streams.add(stream);
    rc.handled = true;
    rc.stream = stream;
    if (opts.retryMs) write(`retry: ${Math.trunc(opts.retryMs)}\n\n`);
    return stream;
  }

  /* ------------------------------------------------------------- security */

  function applySecurityHeaders(res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  }

  /**
   * Anti-DNS-rebinding. A browser that was lured to `evil.example` and told it
   * resolves to 127.0.0.1 would otherwise be able to drive this server. The
   * Host header is the one thing such a request cannot forge into a loopback
   * name without the user noticing.
   */
  function guardHost(req) {
    const raw = req.headers.host;
    if (!raw) {
      // HTTP/1.1 requires Host, so a client without one is not a browser --
      // and a rebinding attack always carries one. Tolerated from this
      // machine (curl --http1.0, a supervisor script), refused from outside.
      if (isLoopbackAddress(req.socket && req.socket.remoteAddress)) return;
      throw new PermissionError('Anfrage ohne Host-Kopf abgelehnt.');
    }
    const host = hostnameOf(raw);
    if (isLoopbackHost(host)) return;

    const sharing = (config.security && config.security.sharing) || {};
    const allowed = new Set();
    for (const candidate of [serverConfig.host, sharing.bindHost, ...(Array.isArray(sharing.hostNames) ? sharing.hostNames : [])]) {
      if (typeof candidate === 'string' && candidate.trim()) allowed.add(candidate.trim().toLowerCase());
    }
    if (allowed.has(host)) return;
    // With sharing on, the server is reached by its LAN address. A bare IP
    // cannot be the target of a rebinding attack (there is no name to rebind),
    // so literals are accepted; names still are not.
    if (sharing.enabled === true && isIpLiteral(host)) return;

    throw new PermissionError(
      `Der Host-Kopf "${host}" gehört nicht zu dieser Instanz. Rufe die Oberfläche über 127.0.0.1 auf.`,
      { host },
    );
  }

  /**
   * CSRF. A form on another page can POST here without reading the response,
   * but it cannot set a custom header -- that would need CORS, which this
   * server never grants. The header is therefore proof the request came from
   * our own code.
   */
  function guardCsrf(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const token = req.headers[CSRF_HEADER];
    if (!token || String(token).trim() === '') {
      throw new PermissionError(
        `Ändernde Anfragen brauchen den Kopf ${CSRF_HEADER}: 1. Die Oberfläche setzt ihn automatisch.`,
        { header: CSRF_HEADER },
      );
    }
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let originHost;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        throw new PermissionError('Der Origin-Kopf ist unlesbar.');
      }
      if (originHost !== String(req.headers.host || '').toLowerCase()) {
        throw new PermissionError(`Fremder Origin "${origin}" wurde abgelehnt.`, { origin });
      }
    }
  }

  async function authenticate(rc) {
    const auth = ctx.auth;
    const sharing = (config.security && config.security.sharing) || {};
    if (!auth || typeof auth.middleware !== 'function') {
      if (sharing.enabled === true) {
        // Fail closed: sharing without an auth module would hand the vault to
        // the local network.
        throw new NeuralError(
          'AUTH_UNAVAILABLE',
          'Die Freigabe ist aktiviert, aber das Anmeldemodul fehlt. Der Zugriff bleibt gesperrt.',
          { status: 503 },
        );
      }
      rc.identity = { kind: 'owner', permissions: 'all' };
      return;
    }

    const result = await auth.middleware(rc.req, rc.res);
    if (rc.res.headersSent || rc.res.writableEnded) {
      // The middleware answered by itself (a redirect, a challenge).
      rc.handled = true;
      return;
    }
    if (!result || result.ok !== true) {
      const problem = result && result.error;
      if (problem instanceof Error) throw problem;
      if (problem && typeof problem === 'object') {
        throw new NeuralError(
          problem.code || 'UNAUTHORIZED',
          problem.message || 'Anmeldung erforderlich.',
          { status: problem.status || 401, details: problem.details || null },
        );
      }
      throw new AuthError(typeof problem === 'string' && problem ? problem : 'Anmeldung erforderlich.');
    }
    rc.identity = result.identity || { kind: 'owner', permissions: 'all' };
  }

  function requireCapability(rc, capability) {
    const identity = rc.identity || {};
    if (identity.kind === 'owner') return;
    const permissions = identity.permissions;
    if (permissions === 'all') return;
    if (permissions && permissions[capability] === true) return;
    throw new PermissionError(
      `Dieser Zugang darf nicht: ${CAPABILITY_LABEL[capability] || capability}.`,
      { capability },
    );
  }

  /**
   * Settings that widen what may leave the machine (network policy, vault
   * encryption, tokens, backups) belong to the person at the keyboard, never
   * to a shared token -- otherwise a read-only share could grant itself the
   * internet.
   */
  function requireOwner(rc, what) {
    const identity = rc.identity || {};
    if (identity.kind === 'owner') return;
    throw new PermissionError(
      `${what || 'Diese Einstellung'} darf nur am Gerät selbst geändert werden, nicht über einen geteilten Zugang.`,
    );
  }

  /* -------------------------------------------------------- static assets */

  function serveStatic(rc) {
    const { req, res } = rc;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new NeuralError('METHOD_NOT_ALLOWED', `${req.method} ist für ${rc.pathname} nicht erlaubt.`, { status: 405 });
    }

    let relative;
    try {
      relative = decodeURIComponent(rc.pathname);
    } catch {
      throw new ValidationError('Die Adresse enthält eine ungültige Prozent-Kodierung.');
    }
    if (relative.includes('\0')) throw new ValidationError('Die Adresse enthält ein ungültiges Zeichen.');
    relative = relative.replace(/\\/g, '/').replace(/^\/+/, '');
    if (relative === '') relative = 'index.html';
    // Nothing hidden is ever part of the interface.
    if (relative.split('/').some((segment) => segment.startsWith('.'))) throw new NotFoundError(`Datei ${rc.pathname}`);

    let file;
    try {
      file = safeJoin(webRoot, relative);
    } catch {
      // Traversal attempt: answer exactly as for a missing file, so the
      // response cannot be used to probe the filesystem.
      throw new NotFoundError(`Datei ${rc.pathname}`);
    }

    let stat = statOrNull(file);
    if (stat && stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = statOrNull(file);
    }
    // There is deliberately NO "serve index.html for anything unknown"
    // fallback. The interface routes in the fragment (`#/graph`), so it never
    // needs one, and a server that answers 200 for every made-up path turns
    // probing it into something that looks like it worked.
    if (!stat || !stat.isFile()) {
      if (path.basename(file) === 'index.html') {
        throw new NeuralError(
          'UI_MISSING',
          `Die Oberfläche wurde nicht gefunden (${path.join(webRoot, 'index.html')} fehlt).`,
          { status: 404 },
        );
      }
      throw new NotFoundError(`Datei ${rc.pathname}`);
    }

    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file);
    // Weak validator: size plus mtime changes whenever the file does, and it
    // costs no read. Strong validation would mean hashing every asset.
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const cacheable = ext !== '.html' && base !== 'sw.js';

    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
    res.setHeader('Cache-Control', cacheable ? 'public, max-age=0, must-revalidate' : 'no-cache');

    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((candidate) => candidate.trim() === etag)) {
      rc.handled = true;
      res.writeHead(304);
      res.end();
      return;
    }

    res.setHeader('Content-Length', stat.size);
    rc.handled = true;
    if (req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(200);
    const source = fs.createReadStream(file);
    source.on('error', (err) => {
      log.error(`Datei ${file} konnte nicht gelesen werden: ${err && err.message}`);
      res.destroy();
    });
    res.on('close', () => source.destroy());
    source.pipe(res);
  }

  /* ---------------------------------------------------------- the handler */

  async function handle(req, res) {
    applySecurityHeaders(res);
    let rc = null;
    try {
      const target = parseTarget(req);
      rc = makeContext(req, res, target);

      if (closing) {
        throw new NeuralError('SERVER_CLOSING', 'Der Server wird gerade beendet.', { status: 503 });
      }

      if (req.method === 'OPTIONS') {
        // Same-origin only: no CORS headers, just the allowed verbs.
        res.writeHead(204, { Allow: 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS', 'Content-Length': 0 });
        res.end();
        return;
      }

      // Health is the one route a supervisor may call without a session. It
      // carries no data, so it only has to prove it came from this machine.
      if (target.pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
          throw new PermissionError('Die Zustandsabfrage ist nur lokal erreichbar.');
        }
        sendJson(rc, 200, { ok: true, at: new Date().toISOString() });
        return;
      }

      guardHost(req);
      guardCsrf(req);
      await authenticate(rc);
      if (rc.handled) return;

      const matched = router.match(req.method, target.pathname);
      if (matched && matched.route) {
        rc.params = matched.params;
        const result = await matched.route.handler(rc);
        if (rc.handled || res.writableEnded || res.headersSent) return;
        sendJson(rc, 200, result === undefined || result === null ? { ok: true } : result);
        return;
      }
      if (matched && matched.allowed) {
        res.setHeader('Allow', matched.allowed.join(', '));
        throw new NeuralError(
          'METHOD_NOT_ALLOWED',
          `${req.method} ist für ${target.pathname} nicht erlaubt (erlaubt: ${matched.allowed.join(', ')}).`,
          { status: 405 },
        );
      }
      if (target.pathname === '/api' || target.pathname.startsWith('/api/')) {
        throw new NotFoundError(`Route ${req.method} ${target.pathname}`);
      }

      serveStatic(rc);
    } catch (err) {
      try {
        sendError(rc, res, err);
      } catch (nested) {
        log.error(`Fehlerantwort schlug fehl: ${nested && nested.message}`);
        try { res.destroy(); } catch { /* gone */ }
      }
    }
  }

  function parseTarget(req) {
    let url;
    try {
      // The base is irrelevant: we only use pathname and search. `new URL`
      // also normalises `..` segments before anything touches the filesystem.
      url = new URL(req.url, 'http://neural-os.invalid');
    } catch {
      throw new ValidationError('Die angefragte Adresse ist ungültig.');
    }
    return { pathname: url.pathname, query: url.searchParams };
  }

  /* -------------------------------------------------------------- listen */

  function listen(opts = {}) {
    const port = opts.port !== undefined ? opts.port : (serverConfig.port !== undefined ? serverConfig.port : 7777);
    const host = opts.host || serverConfig.host || '127.0.0.1';
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (err && err.code === 'EADDRINUSE') {
          reject(new NeuralError(
            'PORT_IN_USE',
            `Port ${port} ist bereits belegt. Läuft Neural OS schon? Sonst mit --port einen anderen wählen.`,
            { status: 500, details: { port, host } },
          ));
          return;
        }
        if (err && err.code === 'EACCES') {
          reject(new NeuralError(
            'PORT_FORBIDDEN',
            `Port ${port} darf nicht geöffnet werden. Ports unter 1024 brauchen erhöhte Rechte.`,
            { status: 500, details: { port, host } },
          ));
          return;
        }
        reject(asNeuralError(err));
      };
      const onListening = () => {
        server.off('error', onError);
        log.info(`Oberfläche erreichbar unter ${api.url}`);
        resolve(api);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  /* --------------------------------------------------------------- close */

  /**
   * Graceful shutdown: stop new work, end every event stream deliberately (so
   * the browser sees a clean close instead of a timeout), then make sure the
   * vault is on disk before the process may exit.
   */
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const stream of Array.from(streams)) {
        try {
          stream.send('server', { state: 'closing' });
          stream.close();
        } catch { /* already gone */ }
      }
      streams.clear();

      if (ctx.chat && typeof ctx.chat.abortAll === 'function') {
        try { ctx.chat.abortAll(); } catch (err) { log.warn(`Laufende Antworten konnten nicht abgebrochen werden: ${err && err.message}`); }
      }

      await new Promise((resolve) => {
        let settled = false;
        let grace = null;
        let hard = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (grace) clearTimeout(grace);
          if (hard) clearTimeout(hard);
          resolve();
        };
        server.close(() => finish());
        // Idle keep-alive sockets would otherwise hold the close callback
        // until their own timeout; a request in flight is given CLOSE_GRACE_MS
        // to finish before the rest are cut.
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        grace = setTimeout(() => {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }, CLOSE_GRACE_MS);
        // Both timers are cleared by `finish`, so they cannot outlive the
        // shutdown; leaving them referenced keeps the process alive until it
        // has really finished (an unref'd timer would let Node exit here).
        hard = setTimeout(finish, CLOSE_GRACE_MS * 2);
      });

      // Let peers see the FIN before this port can be bound again. Without
      // this beat a client that still holds a pooled keep-alive socket (the
      // app restarting on the same fixed port, a CLI tool, our own tests)
      // sends its next request into a connection that no longer exists and
      // gets a reset instead of an answer.
      // Deliberately NOT unref'd: an unreferenced timer that something is
      // awaiting lets Node decide the loop is empty and exit mid-shutdown.
      await new Promise((resolve) => { setTimeout(resolve, SOCKET_SETTLE_MS); });

      if (ctx.store && typeof ctx.store.flush === 'function') {
        try {
          await ctx.store.flush();
        } catch (err) {
          log.error(`Der Vault konnte beim Beenden nicht gesichert werden: ${err && err.message}`);
        }
      }
      log.info('HTTP-Server beendet.');
    })();
    return closePromise;
  }

  const api = {
    server,
    listen,
    close,
    get url() {
      const address = server.address();
      if (!address || typeof address === 'string') return null;
      const bare = address.address === '0.0.0.0' || address.address === '::' ? '127.0.0.1' : address.address;
      const host = bare.includes(':') ? `[${bare}]` : bare;
      return `http://${host}:${address.port}`;
    },
    get closing() { return closing; },
    streamCount: () => streams.size,
    routes: router.list(),
    webRoot,
  };

  return api;
}

module.exports = {
  createServer,
  CSP,
  SECURITY_HEADERS,
  DEFAULT_BODY_LIMIT,
  HEARTBEAT_MS,
  CSRF_HEADER,
  MIME,
  // Exported for the tests only; not part of the module's contract.
  __internals: { createRouter, hostnameOf, isLoopbackHost, isIpLiteral },
};
