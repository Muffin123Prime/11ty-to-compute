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
 * Mit Freigabe bleibt der Rechner selbst der Besitzer (geändert)
 * ---------------------------------------------------------------
 * Früher verlangte eingeschaltete Freigabe von JEDEM ein Token, auch von
 * 127.0.0.1. Damit sperrte "iPad verbinden" den Laptop aus: sein Browser war
 * danach bestenfalls ein Token-Gast, und Gäste dürfen keine Einstellungen
 * ändern -- auch nicht die Freigabe wieder ausschalten. Die Begründung
 * ("sonst ist jeder lokale Prozess Besitzer") trägt nicht: ohne Freigabe ist
 * er das ohnehin, und die Freigabe öffnet nur einen Weg von AUSSEN.
 * Die Regel ist jetzt:
 *  - Wer einen Zugang ausdrücklich vorzeigt (Authorization: Bearer), wird
 *    daran gemessen, auch lokal -- so prüft sich ein Partner-Gerät selbst.
 *  - Lokal ohne Kopf ist der Besitzer. Cookies zählen lokal NICHT: sie hängen
 *    sich von selbst an, und ein altes Cookie darf den Menschen an der
 *    Tastatur nicht still zum Gast machen.
 *  - Von aussen ohne Zugang: 401.
 * Die Host-Prüfung (1) läuft weiter bei jeder Anfrage, und DNS-Rebinding
 * braucht einen Namen, den sie abweist.
 *
 * iPad verbinden: ein Einmal-Code im Link, nie das Token
 * ------------------------------------------------------
 * Der QR-Code enthält `/api/verbinden?c=<Einmal-Code>`, 256 Bit, 10 Minuten
 * gültig, genau einmal einlösbar. Erst beim Einlösen entsteht das eigentliche
 * Token, und es geht nur als HttpOnly-Cookie an das iPad, danach leitet der
 * Server mit 303 auf `/` um -- der Code verschwindet aus der Adresszeile und
 * ist ohnehin verbraucht. Ein Foto des QR-Codes ist danach wertlos. Der Pfad
 * liegt unter /api/, weil der Service Worker jede andere Navigation aus dem
 * Zwischenspeicher bedient; der Code käme dort nie am Server an.
 *
 * PIN-Sitzung: der Browser, der entsperrt hat
 * -------------------------------------------
 * Ist der Tresor mit einer PIN verschlüsselt und wurde er NICHT über ein
 * gemerktes Gerät geöffnet (also auf einem fremden Rechner), wäre sonst jeder
 * Prozess auf diesem Rechner über 127.0.0.1 Besitzer ("offene Loopback-Tür",
 * Bauplan 4.1). Deshalb braucht lokal dann jede Anfrage das Cookie
 * `nos_s_<KI>`, das nur bekommt, wer die PIN eingegeben hat. Die Bindung
 * beginnt, sobald in diesem Prozess ein Browser die PIN eingegeben hat (oder
 * der Vorraum sie mit `bindungEinschalten()` übergibt) -- nicht schon, weil
 * irgendein Code entsperrt hat: eine Passphrase aus der Umgebung oder ein
 * Werkzeug, das in-process verschlüsselt, hat keinen Browser, den man binden
 * könnte, und würde sonst alle aussperren. Sein Siegel ist
 * ein HMAC mit einem Schlüssel aus dem Datenschlüssel (vaultcrypto
 * `sitzungsSiegel`): jeder Prozess, der den Tresor geöffnet hat, kann es
 * ausstellen und prüfen, es übersteht einen Neustart, und nirgends liegt eine
 * Sitzungsliste. Es gilt 12 Stunden. Ohne Sitzung bleiben nur der Status,
 * der Zustand des Tresors und das Entsperren erreichbar (plus die
 * Oberflächendateien, die keine Daten enthalten).
 *
 * Cookies tragen die KI-Kennung im Namen: Browser trennen Cookies nicht nach
 * Port (RFC 6265 §8.5), und zwei Sticks am selben Rechner dürfen einander
 * nicht die Sitzung reichen.
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
  NeuralError,
  ValidationError,
  AuthError,
  NotFoundError,
  PermissionError,
  asNeuralError,
} = require('../kernel/errors');
const vaultcrypto = require('../store/vaultcrypto');

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
/** Das Beenden-Recht von `neural-os stop` (siehe stoppGeheimnisSetzen). */
const STOPP_HEADER = 'x-neural-os-stopp';

/** Host names that always denote this machine. */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

/** Bind addresses that mean "every interface", so no single name is expected. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*', '']);

/** Paths reachable without a credential, from loopback only. */
const PUBLIC_PATHS = new Set(['/api/health']);

/** A token's `lastUsedAt` is rewritten at most this often, to spare the log. */
const LAST_USED_INTERVAL_MS = 60000;

/** Der Link aus dem QR-Code (unter /api/, siehe Kopf). */
const LINK_PATH = '/api/verbinden';
/** Wie lange ein Einmal-Code gilt, und wie viele gleichzeitig offen sein dürfen. */
const EINMAL_GUELTIG_MS = 10 * 60 * 1000;
const EINMAL_MAX = 20;
/** Cookie-Namen; die KI-Kennung wird angehängt. */
const TOKEN_COOKIE_PREFIX = 'nos_t_';
const SITZUNG_COOKIE_PREFIX = 'nos_s_';
/** Ein Bildschirm-Gerät (iPad) bleibt angemeldet, bis es getrennt wird (Browser-Höchstwert 400 Tage). */
const TOKEN_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
/** So lange gilt eine PIN-Sitzung, danach fragt die PIN wieder. */
const SITZUNG_MAX_MS = 12 * 60 * 60 * 1000;

/**
 * Was ohne PIN-Sitzung lokal erreichbar bleibt: genug, um die PIN abzufragen
 * und zu sagen, dass sie fehlt -- nichts, was Daten zeigt.
 */
const FREI_OHNE_SITZUNG = new Set([
  'GET /api/status',
  'GET /api/vault',
  'POST /api/vault/unlock',
]);

/** Die Rechte eines verbundenen Bildschirms (iPad): alles benutzen, nichts einstellen. */
const BILDSCHIRM_RECHTE = Object.freeze({ read: true, write: true, chat: true, agents: true });

/**
 * Der Teil der KI-Kennung, der in Cookie-Namen steht. Fehlt die Kennung noch,
 * trennt wenigstens der Port (jede KI hat ihren eigenen).
 */
function kiTeil(config) {
  const id = config && config.sync && typeof config.sync.deviceId === 'string' ? config.sync.deviceId : '';
  const m = /^dev_([0-9a-f]{8})/.exec(id);
  if (m) return m[1];
  const port = config && config.server && Number(config.server.port);
  return `p${Number.isInteger(port) && port > 0 ? port : 7777}`;
}

/** Name des Sitzungs-Cookies einer KI (auch für den späteren Vorraum). */
function sitzungsCookieName(config) {
  return `${SITZUNG_COOKIE_PREFIX}${kiTeil(config)}`;
}

/** Name des Token-Cookies eines verbundenen Bildschirms. */
function tokenCookieName(config) {
  return `${TOKEN_COOKIE_PREFIX}${kiTeil(config)}`;
}

/**
 * Ein Sitzungs-Cookie ausstellen. Steht als eigene Funktion da, damit der
 * Vorraum (Bauplan Paket V) nach dem Entsperren dasselbe Cookie setzen kann:
 * `res.setHeader('Set-Cookie', pinSitzungCookie({config, vaultCrypto}))`.
 * @returns {string} Set-Cookie-Wert
 */
function pinSitzungCookie({ config, vaultCrypto, jetzt = Date.now() } = {}) {
  if (!vaultCrypto || typeof vaultCrypto.sitzungsSiegel !== 'function') {
    throw new ValidationError('Ohne Tresor-Verschlüsselung gibt es keine PIN-Sitzung.');
  }
  const zeit = Math.floor(jetzt).toString(36);
  const nonce = b64url(crypto.randomBytes(12));
  const siegel = b64url(vaultCrypto.sitzungsSiegel(`v1.${zeit}.${nonce}.${kiTeil(config)}`));
  // 12 Stunden, wie die Prüfung im Server: wer den Browser schließt und
  // wieder öffnet, während Neural OS weiterläuft, soll nicht neu tippen. Die
  // Zeit steht zusätzlich im Siegel, weil ein Cookie-Ablauf beim Client liegt.
  return `${sitzungsCookieName(config)}=v1.${zeit}.${nonce}.${siegel}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SITZUNG_MAX_MS / 1000)}`;
}

/** @returns {boolean} */
function pinSitzungGueltig({ config, vaultCrypto, wert, jetzt = Date.now() } = {}) {
  if (typeof wert !== 'string' || wert.length > 200) return false;
  const teile = wert.split('.');
  if (teile.length !== 4 || teile[0] !== 'v1') return false;
  const zeit = parseInt(teile[1], 36);
  if (!Number.isFinite(zeit) || zeit > jetzt + 60000 || jetzt - zeit > SITZUNG_MAX_MS) return false;
  if (!vaultCrypto || vaultCrypto.state !== 'unlocked') return false;
  let erwartet;
  try {
    erwartet = vaultCrypto.sitzungsSiegel(`v1.${teile[1]}.${teile[2]}.${kiTeil(config)}`);
  } catch {
    return false;
  }
  const gegeben = Buffer.from(teile[3].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return gegeben.length === erwartet.length && crypto.timingSafeEqual(gegeben, erwartet);
}

/** Eine kleine, selbst gestaltete HTML-Seite ohne Skript (CSP: inline style erlaubt). */
function kleineSeite(titel, satz) {
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return '<!doctype html><html lang="de"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${esc(titel)}</title></head>`
    + '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0e;color:#e8e9ec;'
    + 'font:16px/1.5 -apple-system,system-ui,sans-serif">'
    + '<main style="max-width:30rem;margin:24px;padding:32px;border-radius:20px;background:#15171a;border:1px solid rgba(255,255,255,.08)">'
    + `<h1 style="font-size:22px;font-weight:600;margin:0 0 12px">${esc(titel)}</h1>`
    + `<p style="margin:0;color:#a4a8b0">${esc(satz)}</p></main></body></html>`;
}

/* ------------------------------------------------------- welche KI? */

/**
 * Gehört dieser Tab zu dieser KI? (Bauplan 2.6)
 *
 * Ein Tab, der noch offen ist, nachdem sein Stick beendet wurde, spricht
 * weiter mit `127.0.0.1:<port>`. Startet dort inzwischen eine andere KI,
 * landete alles, was der alte Tab schickt, in ihr: gemessen legte ein
 * `POST /api/chats` aus dem Tab von A einen Chat in B an (belegt, v5). Die
 * Oberfläche schickt deshalb die Kennung ihrer KI mit, sobald sie sie aus
 * `/api/status` kennt, und zwar bei **jeder** Anfrage: auch ein GET oder ein
 * Ereignisstrom zeigte sonst die Daten von B in einer Seite, die A meint.
 *
 * - Kopf fehlt oder ist `1` -> erlaubt: das ist der erste Aufruf eines Tabs,
 *   ein Werkzeug oder ein Test. Die CSRF-Regel bleibt davon unberührt.
 * - Kopf ist die Kennung dieser KI -> erlaubt.
 * - sonst `409 KI_GEWECHSELT`; die Oberfläche lädt dann neu.
 *
 * Keine eigene Kennung (ein Server ohne Identität, z. B. in Tests) heißt:
 * es gibt nichts zu vergleichen.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} [kiId] die Kennung dieser KI (`dev_…`)
 * @throws {NeuralError} 409 KI_GEWECHSELT
 */
function guardKi(req, kiId) {
  if (typeof kiId !== 'string' || !kiId) return;
  const roh = req && req.headers ? req.headers[CSRF_HEADER] : undefined;
  const kopf = typeof roh === 'string' ? roh.trim() : '';
  if (!kopf || kopf === '1' || kopf === kiId) return;
  throw new NeuralError('KI_GEWECHSELT', 'Dieser Tab gehört zu einer anderen KI.', { status: 409 });
}

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

  /**
   * Der vorgezeigte Zugang. Lokal zählt nur der ausdrückliche Kopf (siehe
   * Kopf dieser Datei), von aussen auch das Cookie des Bildschirm-Geräts und
   * das alte `nos_session`.
   */
  function credentialFrom(req, loopback) {
    const authorization = req.headers && req.headers.authorization;
    if (typeof authorization === 'string' && authorization) {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (match) return { value: match[1].trim(), via: 'bearer' };
      return { value: null, via: 'unsupported-scheme' };
    }
    if (loopback) return { value: null, via: null };
    const cookies = parseCookies(req.headers && req.headers.cookie);
    const eigenes = cookies[tokenCookieName(config)];
    if (eigenes) return { value: eigenes, via: 'cookie' };
    if (cookies[COOKIE_NAME]) return { value: cookies[COOKIE_NAME], via: 'cookie' };
    return { value: null, via: null };
  }

  function vault() {
    return vaultcrypto.instanzFuer(config);
  }

  /** Ab dem ersten Browser, der die PIN eingegeben hat (siehe Kopf). */
  let bindungAktiv = false;
  /**
   * Das Beenden-Recht von `neural-os stop` (Laufzettel, Paket S): Wer den
   * Laufzettel lesen kann, darf beenden, auch ohne PIN-Sitzung. Beenden gibt
   * nichts preis; unter Windows gibt es sonst keinen sauberen Weg.
   */
  let stoppGeheimnis = null;
  function stoppErlaubt(req, key) {
    if (!stoppGeheimnis || key !== 'POST /api/system/beenden') return false;
    const gegeben = req.headers && req.headers[STOPP_HEADER];
    if (typeof gegeben !== 'string' || !gegeben) return false;
    const a = Buffer.from(gegeben);
    const b = Buffer.from(stoppGeheimnis);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function bindungNoetig(vc) {
    if (!vc || !vc.enabled || !bindungAktiv) return false;
    if (config.security && config.security.pinSitzung === false) return false;
    return vc.entsperrtDurch !== 'geraet';
  }

  /**
   * Braucht dieser lokale Besitzer eine PIN-Sitzung, und hat er sie?
   * @returns {'keine'|'ok'|'frei'} 'keine' = keine Bindung nötig
   * @throws {NeuralError} PIN_NOETIG (401)
   */
  function pinBindung(req) {
    const vc = vault();
    if (!bindungNoetig(vc)) return 'keine';
    const cookies = parseCookies(req.headers && req.headers.cookie);
    if (pinSitzungGueltig({ config, vaultCrypto: vc, wert: cookies[sitzungsCookieName(config)] })) return 'ok';
    const method = String(req.method || 'GET').toUpperCase();
    const path = pathnameOf(req.url);
    const key = `${method === 'HEAD' ? 'GET' : method} ${path}`;
    // Die Dateien der Oberfläche enthalten keine Daten; ohne sie gäbe es
    // nicht einmal die Stelle, an der man die PIN eingibt.
    if (FREI_OHNE_SITZUNG.has(key) || ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/') && path !== '/api')) {
      return 'frei';
    }
    if (stoppErlaubt(req, key)) return 'frei';
    throw new NeuralError(
      'PIN_NOETIG',
      vc.state === 'unlocked'
        ? 'Bitte zuerst die PIN eingeben. Dieser Browser hat die KI noch nicht entsperrt.'
        : 'Der Tresor ist gesperrt. Bitte die PIN eingeben.',
      { status: 401, details: { ziel: '#/settings', gesperrt: vc.state !== 'unlocked' } },
    );
  }

  /** Solange der Tresor gesperrt ist, sieht auch ein verbundenes Gerät nichts. */
  function tresorOffenFuerGaeste() {
    const vc = vault();
    if (vc && vc.enabled && vc.state !== 'unlocked') {
      throw new NeuralError('VAULT_LOCKED', 'Der Tresor ist gesperrt. Am Laptop mit der PIN entsperren.', { status: 423 });
    }
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
      const bindung = pinBindung(req);
      return { identity: OWNER, via: bindung === 'ok' ? 'pin-sitzung' : 'loopback' };
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
      pinBindung(req);
      return { identity: OWNER, via: 'loopback-no-token' };
    }

    const credential = credentialFrom(req, loopback);
    if (!credential.value) {
      if (loopback) {
        const bindung = pinBindung(req);
        return { identity: OWNER, via: bindung === 'ok' ? 'pin-sitzung' : 'loopback' };
      }
      const hint = bootstrapNeeded()
        ? ' Es ist noch kein Gerät verbunden: am Laptop unter Einstellungen → iPad verbinden den Code anzeigen.'
        : '';
      throw new AuthError(`Für diesen Zugriff wird ein Token benötigt.${hint}`);
    }

    const { record } = await verifyToken(credential.value);
    tresorOffenFuerGaeste();
    return { identity: identityOfToken(record), via: credential.via, tokenId: record.id };
  }

  /* ------------------------------------------------ Einmal-Code und Link */

  /** @type {Map<string, {bis:number, label:string, beiEinloesung:Function|null}>} */
  const einmalCodes = new Map();

  function einmalAufraeumen(jetzt = Date.now()) {
    for (const [code, e] of einmalCodes) if (e.bis <= jetzt) einmalCodes.delete(code);
  }

  /**
   * Einen Einmal-Code für den Verbinden-Link ausstellen.
   * @param {{gueltigMs?:number, label?:string, beiEinloesung?:(info:object)=>void}} [opts]
   * @returns {{code:string, bis:string, pfad:string}}
   */
  function einmalCode(opts = {}) {
    einmalAufraeumen();
    while (einmalCodes.size >= EINMAL_MAX) {
      // Der älteste weicht; mehr offene Codes braucht niemand.
      einmalCodes.delete(einmalCodes.keys().next().value);
    }
    const gueltig = Number.isFinite(opts.gueltigMs) && opts.gueltigMs > 0 ? Math.min(opts.gueltigMs, 60 * 60 * 1000) : EINMAL_GUELTIG_MS;
    const code = b64url(crypto.randomBytes(32));
    const bis = Date.now() + gueltig;
    einmalCodes.set(code, {
      bis,
      label: String(opts.label || 'iPad').slice(0, 120),
      beiEinloesung: typeof opts.beiEinloesung === 'function' ? opts.beiEinloesung : null,
    });
    return { code, bis: new Date(bis).toISOString(), pfad: `${LINK_PATH}?c=${code}` };
  }

  /** Alle offenen Codes verwerfen (Freigabe aus). */
  function einmalCodesVerwerfen() {
    einmalCodes.clear();
  }

  function sendeSeite(res, status, titel, satz) {
    const body = kleineSeite(titel, satz);
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  /**
   * GET /api/verbinden?c=… -- den Einmal-Code gegen ein Token-Cookie tauschen
   * und sofort auf `/` umleiten. Antwortet selbst (303 oder eine kleine Seite).
   */
  async function verbinden(req, res) {
    let code = '';
    try {
      code = new URL(req.url, 'http://x.invalid').searchParams.get('c') || '';
    } catch { /* bleibt leer */ }
    einmalAufraeumen();
    const eintrag = code && code.length <= 64 ? einmalCodes.get(code) : null;
    if (!eintrag) {
      writeAudit('auth.link.denied', { remote: (req.socket && req.socket.remoteAddress) || null });
      sendeSeite(res, 410, 'Dieser Code gilt nicht mehr',
        'Er ist abgelaufen oder wurde schon benutzt. Am Laptop unter Einstellungen → iPad verbinden einen neuen Code anzeigen und noch einmal scannen.');
      return;
    }
    // Einmal heißt einmal: auch wenn gleich etwas schiefgeht.
    einmalCodes.delete(code);
    const remote = (req.socket && req.socket.remoteAddress) || '';
    if (!isLoopbackAddress(remote) && !sharingEnabled()) {
      sendeSeite(res, 403, 'Freigabe ist aus', 'Am Laptop ist die Verbindung für das iPad gerade ausgeschaltet.');
      return;
    }
    const agent = String((req.headers && req.headers['user-agent']) || '');
    const geraet = /iPad/.test(agent) ? 'iPad' : /iPhone/.test(agent) ? 'iPhone' : /Macintosh/.test(agent) ? 'Mac' : /Android/.test(agent) ? 'Android' : 'Gerät';
    const datum = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
    const { token, record } = await createToken({
      label: `${eintrag.label === 'iPad' ? geraet : eintrag.label} · verbunden am ${datum}`,
      permissions: BILDSCHIRM_RECHTE,
      art: 'bildschirm',
    });
    // Lax statt Strict: der erste Aufruf kommt aus der Kamera-App, und die
    // Umleitung danach soll das Cookie sicher mitnehmen. Gegen fremde Seiten
    // schützt weiterhin der Pflichtkopf X-Neural-OS bei jeder Änderung.
    res.writeHead(303, {
      'Set-Cookie': `${tokenCookieName(config)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_COOKIE_MAX_AGE_S}`,
      Location: '/',
      'Cache-Control': 'no-store',
      'Content-Length': 0,
    });
    res.end();
    writeAudit('auth.link.ok', { tokenId: record.id, remote });
    if (eintrag.beiEinloesung) {
      try {
        eintrag.beiEinloesung({ token: record, remote, geraet });
      } catch (err) {
        log.warn(`Rückmeldung nach dem Verbinden gescheitert: ${err && err.message}`);
      }
    }
  }

  /**
   * Set-Cookie für die PIN-Sitzung dieses Browsers (nach richtiger PIN).
   * @returns {string|null} null, wenn keine Bindung nötig ist
   */
  function sitzungAusstellen() {
    const vc = vault();
    if (!vc || !vc.enabled || vc.state !== 'unlocked') return null;
    const cookie = pinSitzungCookie({ config, vaultCrypto: vc });
    // Ab jetzt gibt es einen Browser, der die PIN kennt -- alle anderen
    // brauchen sie auch.
    bindungAktiv = true;
    return cookie;
  }

  /**
   * Für den Vorraum (Bauplan Paket V): der Browser hat die PIN dort
   * eingegeben und sein Cookie von dort bekommen; dieser Prozess soll ihn
   * binden, als hätte er es selbst ausgestellt.
   */
  function bindungEinschalten() {
    bindungAktiv = true;
  }

  /** Paket S: das Beenden-Recht aus dem Laufzettel (siehe stoppErlaubt). */
  function stoppGeheimnisSetzen(wert) {
    stoppGeheimnis = typeof wert === 'string' && wert.length >= 16 ? wert : null;
  }

  /** Braucht ein lokaler Browser gerade eine PIN-Sitzung, und hat dieser sie? */
  function sitzungsZustand(req) {
    const vc = vault();
    if (!bindungNoetig(vc)) return { noetig: false, vorhanden: false };
    const cookies = parseCookies(req && req.headers && req.headers.cookie);
    return {
      noetig: true,
      vorhanden: pinSitzungGueltig({ config, vaultCrypto: vc, wert: cookies[sitzungsCookieName(config)] }),
    };
  }

  /* ----------------------------------------------------------- middleware */

  /**
   * Run every check for one request.
   *
   * Never throws. It returns a verdict so the server stays in charge of the
   * response shape -- with one exception: the link from the QR code
   * (`/api/verbinden`) is answered here directly (303 or a small page), which
   * the server recognises by `res.headersSent`. `res`, otherwise, only
   * receives a `WWW-Authenticate` hint on a 401.
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
      if (path === LINK_PATH && method === 'GET' && res && typeof res.writeHead === 'function') {
        await verbinden(req, res);
        return { ok: true, identity: { kind: 'link', permissions: {} }, via: 'link' };
      }
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
      if (error.status === 401 && error.code !== 'PIN_NOETIG' && res && typeof res.setHeader === 'function' && !res.headersSent) {
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

    const art = opts.art === 'bildschirm' ? 'bildschirm' : 'token';
    const record = store.create('token', {
      label,
      art,
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
      art: d.art === 'bildschirm' ? 'bildschirm' : 'token',
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
    einmalCode,
    einmalCodesVerwerfen,
    sitzungAusstellen,
    sitzungsZustand,
    bindungEinschalten,
    stoppGeheimnisSetzen,
    get bindungAktiv() { return bindungAktiv; },
    tokenCookieName: () => tokenCookieName(config),
    sitzungsCookieName: () => sitzungsCookieName(config),
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
    guardKi,
    allowedHostNames,
    COOKIE_NAME,
  };
}

module.exports = {
  createAuth,
  guardKi,
  pinSitzungCookie,
  pinSitzungGueltig,
  sitzungsCookieName,
  tokenCookieName,
  kiTeil,
  COOKIE_NAME,
  CSRF_HEADER,
  STOPP_HEADER,
  LINK_PATH,
  BILDSCHIRM_RECHTE,
  SITZUNG_MAX_MS,
  KDF,
  /** Exposed for tests only. */
  __internals: { hostnameOf, parseCookies, isLoopbackAddress, isIpLiteral, b64url },
};
