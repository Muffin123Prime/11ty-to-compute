'use strict';

/**
 * Authentication, CSRF and DNS-rebinding defence for the HTTP layer.
 *
 * The threat model this file actually defends against
 * ---------------------------------------------------
 * Neural OS normally listens on 127.0.0.1 only. That does NOT make it
 * unreachable from the web: any page in the user's browser can issue requests
 * to http://127.0.0.1:7777, and a hostile page can point its own domain at
 * 127.0.0.1 (DNS rebinding) so the browser treats our server as same-origin.
 * Three independent checks close that hole, and all three run on every
 * request:
 *
 *   1. **Host header allowlist.** A rebound request arrives with the
 *      attacker's NAME in `Host` (that is what makes the browser send its
 *      cookies), so rejecting unknown names defeats it. IP literals are
 *      accepted when sharing is on, because an address cannot be rebound --
 *      there is no name to re-resolve.
 *   2. **Custom header for mutations.** `X-Neural-OS` cannot be set on a
 *      cross-origin request without a CORS preflight, and we answer no
 *      preflight. Its mere presence is the proof, so any non-empty value
 *      counts; the UI sends `1`.
 *   3. **Origin check.** When the browser sends `Origin`, it must equal our
 *      own host:port.
 *
 * Why loopback means "owner"
 * --------------------------
 * With sharing disabled the server is reachable only by processes on this
 * machine. Demanding a password from the person sitting at the keyboard would
 * buy nothing: anyone who can run code here can read the vault directly. So
 * loopback + sharing off = owner, no token, exactly as the contract says.
 *
 * Why enabling sharing locks everyone out, deliberately
 * -----------------------------------------------------
 * The moment sharing is on, a credential is required from EVERY client,
 * loopback included. A "loopback is still free" exception would be a
 * permanent bypass for any local process (and for any rebinding attack that
 * slipped past check 1). The consequence is an ordering requirement, and it is
 * a real one, not an oversight: **mint a token first, then enable sharing.**
 * `createToken()` hands back the raw token exactly once; the settings UI is
 * expected to drop it straight into the `nos_session` cookie via
 * `cookieFor()`, so the owner's own browser stays signed in across the
 * switch-over. `bootstrapNeeded()` reports the stuck state in plain German
 * instead of letting the user stare at a 401.
 *
 * Why the cookie carries a token instead of a session id
 * ------------------------------------------------------
 * There is no session record type, and inventing an in-memory one would add a
 * second credential format that survives no restart and can drift out of sync
 * with token revocation. `nos_session` therefore holds a token and is verified
 * on exactly the same path: revoking the token logs the browser out, which is
 * what a user expects "Zugriff entziehen" to mean. Cookies are auto-attached
 * by the browser, which is precisely why check 2 above is mandatory.
 *
 * Why scrypt here is not about entropy
 * ------------------------------------
 * A raw token is 256 bits from `crypto.randomBytes`; no KDF makes that harder
 * to guess. scrypt is used because the contract specifies it and because it
 * costs an attacker on the LAN ~50 ms per attempt, which is a rate limiter we
 * get for free. The comparison itself is `timingSafeEqual`.
 */

const crypto = require('node:crypto');

const {
  ValidationError,
  AuthError,
  NotFoundError,
  PermissionError,
  asNeuralError,
} = require('../kernel/errors');

/* ------------------------------------------------------------- constants */

const COOKIE_NAME = 'nos_session';

/**
 * scrypt work factor. N=2^14 with r=8 needs ~16 MB and ~50 ms, comfortably
 * inside Node's default maxmem. See the header for why it is not cranked
 * higher: the secret is already 256 random bits.
 */
const KDF = { N: 16384, r: 8, p: 1, keyLen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Methods that cannot change state and therefore need no CSRF proof. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Header whose presence proves the request was not made cross-origin. */
const CSRF_HEADER = 'x-neural-os';

/** Host names that always denote this machine. */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

/** Bind addresses that mean "every interface", so no single name is expected. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*', '']);

/** Paths reachable without a credential, from loopback only. */
const PUBLIC_PATHS = new Set(['/api/health']);

/** A token's `lastUsedAt` is rewritten at most this often, to spare the log. */
const LAST_USED_INTERVAL_MS = 60000;

/* --------------------------------------------------------------- helpers */

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

const scrypt = (secret, salt, keyLen, params) => new Promise((resolve, reject) => {
  crypto.scrypt(secret, salt, keyLen, { ...params, maxmem: SCRYPT_MAXMEM }, (err, key) => {
    if (err) reject(err);
    else resolve(key);
  });
});

/** URL-safe base64 without padding: survives cookies, headers and shells. */
function b64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Strip the port and the IPv6 brackets from an authority.
 * `[::1]:7777` -> `::1`, `Example.COM:80` -> `example.com`, `host.` -> `host`.
 */
function hostnameOf(authority) {
  let s = String(authority === null || authority === undefined ? '' : authority).trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    return close === -1 ? s.slice(1) : s.slice(1, close);
  }
  const first = s.indexOf(':');
  if (first !== -1 && first === s.lastIndexOf(':')) s = s.slice(0, first);
  return s.replace(/\.$/, '');
}

/** An address literal cannot be the target of DNS rebinding: there is no name. */
function isIpLiteral(host) {
  return net4(host) || net6(host);
}

function net4(host) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)
    && host.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
}

function net6(host) {
  // Deliberately permissive: anything with a colon and only hex/colon/dot
  // characters is an address literal, never a DNS name a browser could rebind.
  return host.includes(':') && /^[0-9a-f:.]+$/.test(host);
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || !address) return false;
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  return a.startsWith('127.');
}

/** Parse a Cookie header into a plain object. Malformed pairs are skipped. */
function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // a value that is not percent-encoded is still a value
    }
  }
  return out;
}

function pathnameOf(url) {
  const raw = String(url || '/');
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  return path || '/';
}

/* ------------------------------------------------------------- factory */

/**
 * @param {object} deps
 * @param {object} deps.store   record store (required; token records live here)
 * @param {object} deps.config  application config (required)
 * @param {Function|object} [deps.logger]
 * @param {object} [deps.audit] Audit instance
 */
function createAuth({ store, config, logger, audit } = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new ValidationError('createAuth benötigt einen Store.');
  }
  if (!config || typeof config !== 'object') {
    throw new ValidationError('createAuth benötigt eine Konfiguration.');
  }
  const log = typeof logger === 'function' ? logger('auth') : (logger || nullLogger());

  const sharingConfig = () => (config.security && config.security.sharing) || {};
  const sharingEnabled = () => sharingConfig().enabled === true;
  const requireToken = () => sharingConfig().requireToken !== false;

  function writeAudit(kind, data) {
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write(kind, data);
    } catch (err) {
      log.warn(`Audit-Eintrag ${kind} fehlgeschlagen: ${err && err.message}`);
    }
  }

  /* ------------------------------------------------------- host allowlist */

  /** Every name/address this server legitimately answers to. */
  function allowedHostNames() {
    const out = new Set(LOOPBACK_NAMES);
    const add = (value) => {
      const h = hostnameOf(value);
      if (h && !WILDCARD_BINDS.has(h)) out.add(h);
    };
    add(config.server && config.server.host);
    add(sharingConfig().bindHost);
    // Forward-compatible escape hatch: a user who reaches their machine under
    // a real name (nas.fritz.box) can list it instead of being told to use the
    // IP. Unknown config keys survive load/save, so this needs no schema change.
    const extra = sharingConfig().allowHosts;
    if (Array.isArray(extra)) extra.forEach(add);
    return out;
  }

  /**
   * @throws {PermissionError} when the Host header could be a rebinding attack
   */
  function checkHost(req) {
    const raw = req.headers && req.headers.host;
    const remote = req.socket && req.socket.remoteAddress;

    if (!raw) {
      // HTTP/1.1 requires Host; a client without one is not a browser, and a
      // rebinding attack always carries one. Accept it only from this machine.
      if (isLoopbackAddress(remote)) return { host: '', bypass: 'kein Host-Header, lokale Verbindung' };
      throw new PermissionError('Anfrage ohne Host-Header abgelehnt.');
    }

    const host = hostnameOf(raw);
    if (!host) throw new PermissionError('Der Host-Header ist leer.');

    const allowed = allowedHostNames();
    if (allowed.has(host)) return { host };
    if (host.endsWith('.localhost')) return { host }; // RFC 6761: always this machine

    // An address literal cannot be rebound: the browser had no name to
    // re-resolve. Accepting it is what lets the tablet reach 192.168.1.5.
    if (sharingEnabled() && isIpLiteral(host)) return { host };

    throw new PermissionError(
      `Der Host-Header "${host}" gehört nicht zu diesem Server. `
      + 'Das schützt vor DNS-Rebinding: rufe die Anwendung über localhost oder ihre IP-Adresse auf.',
      { host, allowed: [...allowed] },
    );
  }

  /* ---------------------------------------------------------------- CSRF */

  /** @throws {PermissionError} when a state-changing request lacks its proof */
  function checkCsrf(req) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return { checked: false };

    const marker = req.headers && req.headers[CSRF_HEADER];
    if (typeof marker !== 'string' || !marker.trim()) {
      throw new PermissionError(
        `Ändernde Anfragen müssen den Kopf "X-Neural-OS: 1" mitschicken. Er fehlt bei ${method}.`,
        { method },
      );
    }

    // Browsers that support it tell us directly where the request came from.
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site && site !== 'same-origin' && site !== 'none') {
      throw new PermissionError(`Anfrage von einer fremden Herkunft abgelehnt (sec-fetch-site: ${site}).`, { site });
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let parsed;
      try {
        parsed = new URL(origin);
      } catch {
        throw new PermissionError(`Unlesbarer Origin-Kopf: ${origin.slice(0, 120)}`, { origin });
      }
      const ours = String((req.headers && req.headers.host) || '').trim().toLowerCase();
      if (parsed.host.toLowerCase() !== ours) {
        throw new PermissionError(
          `Origin "${parsed.origin}" passt nicht zu diesem Server (${ours}).`,
          { origin: parsed.origin, host: ours },
        );
      }
    }
    return { checked: true };
  }

  /* -------------------------------------------------------------- tokens */

  function tokenRecords({ includeInactive = false } = {}) {
    let items = [];
    try {
      items = store.list('token', {}).items;
    } catch (err) {
      // Without the token list nobody can authenticate. Fail closed and say so.
      throw asNeuralError(err);
    }
    if (includeInactive) return items;
    const now = Date.now();
    return items.filter((r) => isUsable(r, now).ok);
  }

  function isUsable(record, now = Date.now()) {
    const d = (record && record.data) || {};
    if (d.revoked === true) return { ok: false, reason: 'revoked' };
    if (d.expiresAt) {
      const at = Date.parse(d.expiresAt);
      if (!Number.isFinite(at)) return { ok: false, reason: 'invalid-expiry' };
      if (at <= now) return { ok: false, reason: 'expired' };
    }
    return { ok: true, reason: null };
  }

  /**
   * Tokens look like `nos_<selector>.<secret>`. The selector is a public
   * lookup key so verification touches ONE record instead of running scrypt
   * against every token on every request; the secret is what is hashed.
   * Tokens minted elsewhere (no dot) still work via a full scan.
   */
  function parseToken(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    const body = value.startsWith('nos_') ? value.slice(4) : value;
    const dot = body.indexOf('.');
    if (dot === -1) return { selector: null, secret: body };
    const selector = body.slice(0, dot);
    const secret = body.slice(dot + 1);
    if (!selector || !secret) return null;
    return { selector, secret };
  }

  async function matchesRecord(record, secret) {
    const d = (record && record.data) || {};
    if (typeof d.hash !== 'string' || typeof d.salt !== 'string' || !d.hash || !d.salt) return false;
    let stored;
    try {
      stored = Buffer.from(d.hash, 'hex');
    } catch {
      return false;
    }
    if (!stored.length) return false;
    const params = (d.kdf && typeof d.kdf === 'object') ? d.kdf : KDF;
    let derived;
    try {
      derived = await scrypt(secret, d.salt, stored.length, {
        N: Number(params.N) || KDF.N,
        r: Number(params.r) || KDF.r,
        p: Number(params.p) || KDF.p,
      });
    } catch (err) {
      log.error(`scrypt für Token ${record.id} fehlgeschlagen: ${err && err.message}`);
      return false;
    }
    if (derived.length !== stored.length) return false;
    return crypto.timingSafeEqual(derived, stored);
  }

  /**
   * Verify a raw credential.
   * @returns {Promise<{record:object}>}
   * @throws {AuthError} always with a German message; the reason is only ever
   *   specific once the secret itself matched, so nothing leaks to a guesser.
   */
  async function verifyToken(raw) {
    const parsed = parseToken(raw);
    if (!parsed) throw new AuthError('Das übergebene Zugriffstoken ist unbrauchbar.');

    const all = tokenRecords({ includeInactive: true });
    const candidates = parsed.selector
      ? all.filter((r) => r.data && r.data.selector === parsed.selector)
      : all;

    let matched = null;
    for (const record of candidates) {
      // The hash is checked before revocation or expiry, so a guesser cannot
      // learn from the answer that a selector exists at all.
      if (await matchesRecord(record, parsed.secret)) {
        matched = record;
        break;
      }
    }
    if (!matched) throw new AuthError('Ungültiges Zugriffstoken.');

    const usable = isUsable(matched);
    if (!usable.ok) {
      // The holder of this exact token may be told why it stopped working.
      const message = usable.reason === 'revoked'
        ? 'Dieses Zugriffstoken wurde widerrufen.'
        : usable.reason === 'expired'
          ? 'Dieses Zugriffstoken ist abgelaufen.'
          : 'Dieses Zugriffstoken hat ein unlesbares Ablaufdatum und wird nicht akzeptiert.';
      const err = new AuthError(message);
      err.details = { tokenId: matched.id, reason: usable.reason };
      throw err;
    }

    touch(matched);
    return { record: matched };
  }

  /** Record the last use, but not on every single request. */
  function touch(record) {
    const previous = record.data && record.data.lastUsedAt ? Date.parse(record.data.lastUsedAt) : 0;
    const now = Date.now();
    if (Number.isFinite(previous) && now - previous < LAST_USED_INTERVAL_MS) return;
    try {
      store.update(record.id, { lastUsedAt: new Date(now).toISOString() });
    } catch (err) {
      log.warn(`lastUsedAt für ${record.id} konnte nicht gespeichert werden: ${err && err.message}`);
    }
  }

  function identityOfToken(record) {
    const d = record.data || {};
    return {
      kind: 'token',
      tokenId: record.id,
      label: d.label || '',
      permissions: (d.permissions && typeof d.permissions === 'object')
        ? { ...d.permissions }
        : { read: true, write: false, chat: false, agents: false },
    };
  }

  const OWNER = Object.freeze({ kind: 'owner', permissions: 'all' });

  /* ---------------------------------------------------------- credentials */

  function credentialFrom(req) {
    const authorization = req.headers && req.headers.authorization;
    if (typeof authorization === 'string' && authorization) {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (match) return { value: match[1].trim(), via: 'bearer' };
      return { value: null, via: 'unsupported-scheme' };
    }
    const cookies = parseCookies(req.headers && req.headers.cookie);
    if (cookies[COOKIE_NAME]) return { value: cookies[COOKIE_NAME], via: 'cookie' };
    return { value: null, via: null };
  }

  async function authenticate(req) {
    const remote = req.socket && req.socket.remoteAddress;
    const loopback = isLoopbackAddress(remote);

    if (!sharingEnabled()) {
      if (!loopback) {
        // The server should not even be bound where this could happen; if it
        // is, refusing is the only honest answer.
        throw new PermissionError(
          'Die Freigabe für andere Geräte ist ausgeschaltet. Diese Anwendung nimmt nur lokale Verbindungen an.',
          { remote: String(remote || '') },
        );
      }
      return { identity: OWNER, via: 'loopback' };
    }

    // Health is the one endpoint a local process may poll without a token, so
    // `neural-os doctor` keeps working after sharing was switched on.
    if (loopback && PUBLIC_PATHS.has(pathnameOf(req.url)) && SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) {
      return { identity: { kind: 'health', permissions: { read: true } }, via: 'public-path' };
    }

    if (!requireToken()) {
      // config.validateConfig already refuses this combination on a non-local
      // bind, so reaching here means loopback-only sharing without auth.
      if (!loopback) throw new PermissionError('Freigabe ohne Token-Authentifizierung ist für entfernte Geräte nicht erlaubt.');
      return { identity: OWNER, via: 'loopback-no-token' };
    }

    const credential = credentialFrom(req);
    if (!credential.value) {
      const hint = bootstrapNeeded()
        ? ' Es existiert noch kein gültiges Zugriffstoken: lege in den Einstellungen unter "Freigabe" eines an.'
        : '';
      throw new AuthError(`Für diesen Zugriff wird ein Token benötigt.${hint}`);
    }

    const { record } = await verifyToken(credential.value);
    return { identity: identityOfToken(record), via: credential.via, tokenId: record.id };
  }

  /* ----------------------------------------------------------- middleware */

  /**
   * Run every check for one request.
   *
   * Never throws and never writes a body: it returns a verdict so the server
   * stays in charge of the response shape. `res`, when given, only receives a
   * `WWW-Authenticate` hint on a 401.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} [res]
   * @returns {Promise<{ok:true, identity:object, via:string}|{ok:false, error:Error}>}
   */
  async function middleware(req, res) {
    if (!req || !req.headers) {
      return { ok: false, error: new ValidationError('Ungültige Anfrage.') };
    }
    const method = String(req.method || 'GET').toUpperCase();
    const path = pathnameOf(req.url);
    try {
      checkHost(req);
      checkCsrf(req);
      const result = await authenticate(req);
      if (result.identity.kind === 'token') {
        writeAudit('auth.ok', { tokenId: result.tokenId, via: result.via, method, path });
      }
      return { ok: true, identity: result.identity, via: result.via };
    } catch (err) {
      const error = asNeuralError(err);
      writeAudit('auth.denied', {
        code: error.code,
        reason: error.message,
        method,
        path,
        host: (req.headers && req.headers.host) || null,
        remote: (req.socket && req.socket.remoteAddress) || null,
      });
      if (error.status === 401 && res && typeof res.setHeader === 'function' && !res.headersSent) {
        try {
          res.setHeader('WWW-Authenticate', 'Bearer realm="Neural OS"');
        } catch { /* the response may already be committed */ }
      }
      return { ok: false, error };
    }
  }

  /* --------------------------------------------------------- token admin */

  /**
   * Mint a token. The raw value is returned HERE AND NOWHERE ELSE: only its
   * scrypt hash reaches the vault, so a stolen vault yields no usable
   * credential and re-displaying a lost token is impossible by construction.
   *
   * @param {{label?:string, permissions?:object, expiresAt?:string|null}} [opts]
   * @returns {Promise<{token:string, record:object}>}
   */
  async function createToken(opts = {}) {
    const label = String(opts.label === undefined || opts.label === null ? '' : opts.label).trim();
    if (!label) throw new ValidationError('Ein Token braucht eine Bezeichnung.');
    if (label.length > 200) throw new ValidationError('Die Bezeichnung des Tokens ist zu lang (max. 200 Zeichen).');

    let expiresAt = null;
    if (opts.expiresAt !== undefined && opts.expiresAt !== null && opts.expiresAt !== '') {
      const at = Date.parse(opts.expiresAt);
      if (!Number.isFinite(at)) throw new ValidationError('expiresAt muss ein ISO-Zeitstempel sein.');
      if (at <= Date.now()) throw new ValidationError('Das Ablaufdatum liegt in der Vergangenheit.');
      expiresAt = new Date(at).toISOString();
    }

    const defaults = { read: true, write: false, chat: false, agents: false };
    const permissions = { ...defaults };
    if (opts.permissions && typeof opts.permissions === 'object') {
      for (const [key, value] of Object.entries(opts.permissions)) {
        permissions[key] = value === true;
      }
    }

    const selector = b64url(crypto.randomBytes(9));
    const secret = b64url(crypto.randomBytes(32));
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(secret, salt, KDF.keyLen, KDF);

    const record = store.create('token', {
      label,
      hash: hash.toString('hex'),
      salt,
      selector,
      kdf: { N: KDF.N, r: KDF.r, p: KDF.p },
      permissions,
      expiresAt,
      lastUsedAt: null,
      revoked: false,
    });

    writeAudit('token.created', { tokenId: record.id, label, permissions, expiresAt });
    log.info(`Zugriffstoken "${label}" angelegt (${record.id}).`);

    return { token: `nos_${selector}.${secret}`, record: sanitiseToken(record) };
  }

  /**
   * Revoked tokens are kept, not deleted: the audit trail must still be able
   * to say which credential made which request last week.
   */
  function revokeToken(id) {
    const record = store.get(id);
    if (!record || record.type !== 'token') throw new NotFoundError(`Token ${id}`);
    const updated = store.update(id, { revoked: true });
    writeAudit('token.revoked', { tokenId: id, label: record.data && record.data.label });
    return sanitiseToken(updated);
  }

  /**
   * Hash and salt are stripped. They are not the token, but handing them to a
   * client would turn a read-only credential into material for an offline
   * attack, and no caller has a use for them.
   */
  function sanitiseToken(record) {
    const d = (record && record.data) || {};
    const usable = isUsable(record);
    return {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      label: d.label || '',
      permissions: d.permissions || {},
      expiresAt: d.expiresAt || null,
      lastUsedAt: d.lastUsedAt || null,
      revoked: d.revoked === true,
      active: usable.ok,
      inactiveReason: usable.reason,
    };
  }

  function listTokens(opts = {}) {
    return tokenRecords({ includeInactive: opts.includeInactive !== false }).map(sanitiseToken);
  }

  /** True when sharing demands a token and not one usable token exists. */
  function bootstrapNeeded() {
    if (!sharingEnabled() || !requireToken()) return false;
    try {
      return tokenRecords().length === 0;
    } catch {
      return true;
    }
  }

  /* ------------------------------------------------------------- cookies */

  /**
   * `Set-Cookie` value for a freshly minted token.
   *
   * No `Secure` flag: this server speaks plain HTTP on loopback or the LAN, and
   * a `Secure` cookie would simply never be stored, i.e. a security flag that
   * silently breaks the feature. `SameSite=Strict` plus the mandatory
   * `X-Neural-OS` header carry the CSRF weight instead.
   */
  function cookieFor(rawToken, opts = {}) {
    if (typeof rawToken !== 'string' || !rawToken.trim()) {
      throw new ValidationError('cookieFor() benötigt ein Token.');
    }
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
    ];
    if (Number.isFinite(opts.maxAgeSeconds) && opts.maxAgeSeconds > 0) {
      parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
    }
    return parts.join('; ');
  }

  /** `Set-Cookie` value that removes the session cookie. */
  function clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  /* --------------------------------------------------------- capabilities */

  /**
   * Whether an identity may do something. The owner may do everything; a token
   * may do exactly what it was granted, and an unknown capability is denied.
   * @param {object} identity
   * @param {'read'|'write'|'chat'|'agents'} capability
   */
  function can(identity, capability) {
    if (!identity) return false;
    if (identity.permissions === 'all') return true;
    const perms = identity.permissions;
    if (!perms || typeof perms !== 'object') return false;
    return perms[capability] === true;
  }

  function assertCan(identity, capability) {
    if (can(identity, capability)) return true;
    throw new PermissionError(`Dieses Zugriffstoken hat kein Recht für "${capability}".`, { capability });
  }

  return {
    middleware,
    createToken,
    revokeToken,
    listTokens,
    verifyToken,
    bootstrapNeeded,
    cookieFor,
    clearCookie,
    can,
    assertCan,
    /** Exposed so the server can reuse the same checks on non-API routes. */
    checkHost,
    checkCsrf,
    allowedHostNames,
    COOKIE_NAME,
  };
}

module.exports = {
  createAuth,
  COOKIE_NAME,
  CSRF_HEADER,
  KDF,
  /** Exposed for tests only. */
  __internals: { hostnameOf, parseCookies, isLoopbackAddress, isIpLiteral, b64url },
};
