'use strict';

/**
 * The egress gate -- the single door through which this process is allowed to
 * reach the network.
 *
 * Why this module looks the way it does
 * -------------------------------------
 * 1. CLASSIFICATION IS ADVERSARIAL. `127.0.0.1`, `2130706433`, `0177.0.0.1`,
 *    `0x7f000001`, `127.1`, `::ffff:127.0.0.1` and `0` all reach the local
 *    machine, and `getaddrinfo()` happily accepts every one of them. A policy
 *    engine that only understands dotted quads is a policy engine that can be
 *    walked around, so `classify()` reimplements inet_aton semantics in full
 *    and parses IPv6 down to its 16 bytes. Anything it cannot prove to be an
 *    address is 'unknown' -- never optimistically 'public' or 'private'.
 *
 * 2. DNS IS ITSELF EGRESS. Resolving `secret-project.example.com` hands that
 *    name to a resolver -- usually the ISP's. If the policy would refuse the
 *    connection anyway, performing the lookup would leak the one piece of
 *    information the user was trying to keep at home, in exchange for nothing.
 *    `resolve()` therefore asks the policy BEFORE it asks the resolver.
 *
 * 3. THE RESOLVED IP IS PINNED. Between "DNS said 93.184.216.34" and
 *    "connect()" a second lookup can return 127.0.0.1 (DNS rebinding). So
 *    `fetch()` resolves once, decides on the address it actually got, and then
 *    connects to that address with the original name only in the Host header
 *    and in TLS SNI. Every redirect starts the whole procedure again.
 *
 * 4. ALLOWS ARE AUDITED, NOT ONLY DENIALS. A log that lists only what was
 *    blocked proves nothing about what left the machine. Every decision --
 *    including "this was local" -- is published on the bus and appended to the
 *    audit file.
 *
 * 5. FAIL CLOSED. Unparseable grant timestamps, an unreadable store, an
 *    unknown mode: all of these deny. The only thing that is allowed without
 *    any configuration is loopback, because a local model is not "the
 *    internet" and the app must work with the network stack switched off.
 *
 * Honest limits: this is a policy engine inside one Node process. It is not a
 * firewall. `src/net/harden.js` extends it to the whole process by patching
 * the stdlib entry points; a separate process on the same machine is out of
 * reach of both.
 */

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const {
  NeuralError,
  ValidationError,
  NotFoundError,
  NetworkBlockedError,
  AbortedError,
} = require('../kernel/errors');
const schema = require('../store/schema');

/* ------------------------------------------------------------------ marker */

/**
 * Marks calls that originate inside the gate itself, so that harden.js does
 * not block the one component that is allowed to dial out. The Symbol is
 * module-private: it is reachable only by requiring this module, which is
 * exactly the set of modules that could call `gate.fetch()` anyway. It is a
 * guard against accident and dependency behaviour, not against hostile
 * in-process code -- nothing inside a single process can be.
 */
const INTERNAL = Symbol('neural-os.gate.internal');

/**
 * Socket creation happens several async hops below `gate.fetch()`, where an
 * options object is no longer in reach, so the marker also travels as
 * async-local state.
 */
const internalStore = new AsyncLocalStorage();

function runInternal(fn) {
  return internalStore.run({ internal: true }, fn);
}

function isInternalContext() {
  const s = internalStore.getStore();
  return !!(s && s.internal === true);
}

function hasInternalMarker(value) {
  return !!(value && typeof value === 'object' && value[INTERNAL] === true);
}

/* ------------------------------------------------------- address parsing */

/** Strip brackets, zone id, trailing dot and an unambiguous ":port" suffix. */
function normaliseHost(input) {
  if (input === null || input === undefined) return '';
  let s = String(input).trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close !== -1) s = s.slice(1, close);
  } else {
    const first = s.indexOf(':');
    // Exactly one colon followed by digits is host:port; two or more colons is
    // an IPv6 literal and must be left alone.
    if (first !== -1 && first === s.lastIndexOf(':') && /^[0-9]{1,5}$/.test(s.slice(first + 1))) {
      s = s.slice(0, first);
    }
  }
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.endsWith('.') && !s.endsWith('..')) s = s.slice(0, -1);
  return s;
}

/**
 * inet_aton(3) semantics: 1-4 parts, each decimal, 0-prefixed octal or
 * 0x-prefixed hex, with the final part absorbing all remaining bytes.
 * Returns an unsigned 32-bit number, or null when the input is not an IPv4
 * address in any notation a resolver would accept.
 */
function parseIPv4(input) {
  if (typeof input !== 'string' || !input || input.length > 45) return null;
  if (!/^[0-9a-fx.]+$/i.test(input)) return null;
  const parts = input.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const raw of parts) {
    if (!raw || raw.length > 12) return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(raw)) n = Number.parseInt(raw.slice(2), 16);
    else if (/^0[0-9]+$/.test(raw)) {
      // A leading zero means octal. "09" is therefore not the number nine but
      // a malformed octal literal, and inet_aton rejects it -- reading it as
      // decimal here would make the gate disagree with the resolver.
      if (!/^0[0-7]+$/.test(raw)) return null;
      n = Number.parseInt(raw.slice(1), 8);
    } else if (/^[0-9]+$/.test(raw)) n = Number.parseInt(raw, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (last >= Math.pow(256, 4 - nums.length)) return null;
  for (const n of nums) if (n > 255) return null;
  let value = last;
  for (let i = 0; i < nums.length; i++) value += nums[i] * Math.pow(256, 3 - i);
  return value >>> 0;
}

/** @returns {number[]|null} the 16 bytes of an IPv6 address */
function parseIPv6(input) {
  if (typeof input !== 'string' || !input.includes(':') || input.length > 64) return null;
  let s = input;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const halves = s.split('::');
  if (halves.length > 2) return null;

  const groupsToBytes = (part) => {
    if (part === '') return [];
    const out = [];
    const groups = part.split(':');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.includes('.')) {
        if (i !== groups.length - 1) return null; // embedded IPv4 only at the tail
        const v4 = parseIPv4(g);
        if (v4 === null) return null;
        out.push((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      const n = Number.parseInt(g, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };

  const head = groupsToBytes(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const tail = groupsToBytes(halves[1]);
  if (tail === null) return null;
  // "::" must stand for at least one all-zero group.
  if (head.length + tail.length > 15) return null;
  const out = new Array(16).fill(0);
  for (let i = 0; i < head.length; i++) out[i] = head[i];
  for (let i = 0; i < tail.length; i++) out[16 - tail.length + i] = tail[i];
  return out;
}

function classifyIPv4(n) {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;
  if (a === 127) return 'loopback'; // 127.0.0.0/8
  if (n === 0) return 'loopback'; // connect(0.0.0.0) reaches this host
  if (a === 0) return 'private'; // rest of 0.0.0.0/8: "this network", unroutable
  if (a === 10) return 'private';
  if (a === 172 && (b & 0xf0) === 16) return 'private'; // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'private'; // link-local incl. cloud metadata
  if (a === 100 && (b & 0xc0) === 64) return 'private'; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'private'; // IETF + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'private'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'private'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'private'; // TEST-NET-3
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved and the broadcast address never
  // carry a unicast conversation to the public internet; treating them as LAN
  // scope keeps them out of 'offline' while not pretending they are the web.
  if (a >= 224) return 'private';
  return 'public';
}

function classifyIPv6(bytes) {
  const zeros = (from, to) => {
    for (let i = from; i <= to; i++) if (bytes[i] !== 0) return false;
    return true;
  };
  const embedded = (offset) => ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

  if (zeros(0, 15)) return 'loopback'; // :: behaves like 0.0.0.0
  if (zeros(0, 14) && bytes[15] === 1) return 'loopback'; // ::1
  // Translation prefixes leave the host through a gateway even when the
  // embedded IPv4 looks local, so they are public regardless of what is inside.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return 'public'; // 64:ff9b::/96 NAT64
  if (zeros(0, 7) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) return 'public'; // ::ffff:0:a.b.c.d
  if (zeros(0, 9) && bytes[10] === 0xff && bytes[11] === 0xff) return classifyIPv4(embedded(12)); // ::ffff:a.b.c.d
  if (zeros(0, 11)) return classifyIPv4(embedded(12)); // deprecated ::a.b.c.d
  if ((bytes[0] & 0xfe) === 0xfc) return 'private'; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'private'; // fe80::/10 link local
  if (bytes[0] === 0xff) return 'private'; // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return 'private'; // 2001:db8::/32
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && zeros(2, 7)) return 'private'; // 100::/64 discard
  return 'public';
}

/**
 * Classify a host or address WITHOUT touching DNS.
 * @param {string} hostOrIp
 * @returns {'loopback'|'private'|'public'|'unknown'}
 */
function classify(hostOrIp) {
  const h = normaliseHost(hostOrIp);
  if (!h) return 'unknown';
  // RFC 6761: localhost and anything under it is loopback by definition and
  // must never be sent to a resolver.
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  const v4 = parseIPv4(h);
  if (v4 !== null) return classifyIPv4(v4);
  const v6 = parseIPv6(h);
  if (v6) return classifyIPv6(v6);
  return 'unknown';
}

/** Canonical form of an address, so obfuscated notations compare equal. */
/**
 * One canonical key per address, whatever notation it arrived in.
 *
 * An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) reaches exactly the same host
 * as `1.2.3.4`, so it must produce the same key -- otherwise a blocklist entry
 * written in the obvious notation is bypassed by writing the address the other
 * way round, and a denylist that can be sidestepped by spelling is not a
 * denylist. classify() already folds these; the matcher has to fold them too,
 * or the two disagree about what the same machine is.
 */
function ipKey(host) {
  const h = normaliseHost(host);
  if (!h) return null;
  const v4 = parseIPv4(h);
  if (v4 !== null) return `4:${v4 >>> 0}`;
  const v6 = parseIPv6(h);
  if (!v6) return null;
  const mapped = mappedIPv4(v6);
  if (mapped !== null) return `4:${mapped >>> 0}`;
  return `6:${v6.join('.')}`;
}

/**
 * The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible
 * (::a.b.c.d) IPv6 address, as an unsigned 32-bit number. null otherwise.
 * `parseIPv6` returns 16 bytes.
 */
function mappedIPv4(bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 16) return null;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null;
  const isMapped = bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompat = bytes[10] === 0 && bytes[11] === 0;
  if (!isMapped && !isCompat) return null;
  // ::0.0.0.0 and ::0.0.0.1 are the unspecified address and loopback, not
  // embedded IPv4 hosts; folding them would rename ::1 into 0.0.0.1.
  if (isCompat && (bytes[12] | bytes[13] | bytes[14]) === 0 && bytes[15] <= 1) return null;
  return ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
}

function ipFamily(host) {
  const h = normaliseHost(host);
  if (parseIPv4(h) !== null) return 4;
  if (parseIPv6(h)) return 6;
  return 0;
}

/* --------------------------------------------------------- host patterns */

/**
 * Strip everything around the host in a pattern a person typed.
 *
 * People paste URLs. `https://tracker.example.com/beacon` in the blocklist
 * matched nothing at all, so the user believed a host was blocked while every
 * request to it sailed through -- a list that silently ignores its entries is
 * worse than no list, because it is trusted. The allowlist had the mirror
 * problem: an entry that looked correct simply never granted anything.
 */
function patternHost(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  const at = s.lastIndexOf('@');
  if (at !== -1) s = s.slice(at + 1); // user:pass@
  for (const cut of ['/', '?', '#']) {
    const i = s.indexOf(cut);
    if (i !== -1) s = s.slice(0, i);
  }
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.endsWith('.') && !s.endsWith('..')) s = s.slice(0, -1);
  return s.trim();
}

function splitHostPort(pattern) {
  let s = patternHost(pattern);
  if (!s) return { host: '', port: null };
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close === -1) return { host: s.slice(1), port: null };
    const host = s.slice(1, close);
    const rest = s.slice(close + 1);
    const port = rest.startsWith(':') && /^[0-9]{1,5}$/.test(rest.slice(1)) ? Number(rest.slice(1)) : null;
    return { host, port };
  }
  const first = s.indexOf(':');
  if (first !== -1 && first === s.lastIndexOf(':') && /^[0-9]{1,5}$/.test(s.slice(first + 1))) {
    return { host: s.slice(0, first), port: Number(s.slice(first + 1)) };
  }
  return { host: s, port: null };
}

/**
 * Match one pattern against a host.
 *
 * `denylist` widens `*.example.com` to also cover the apex. The asymmetry is
 * deliberate: on an allowlist a wildcard should grant the least the user could
 * have meant, on a blocklist it should cover the most.
 */
function hostMatches(pattern, host, port, opts = {}) {
  const p = splitHostPort(pattern);
  if (!p.host) return false;
  if (p.port !== null && Number(port) !== p.port) return false;
  if (p.host === '*') return true;
  const h = normaliseHost(host);
  if (!h) return false;
  if (p.host.startsWith('*.')) {
    if (h.endsWith(p.host.slice(1))) return true;
    return opts.denylist === true && h === p.host.slice(2);
  }
  if (p.host === h) return true;
  const a = ipKey(p.host);
  return a !== null && a === ipKey(h);
}

function matchAnyHost(patterns, hosts, port, opts) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  for (const pattern of patterns) {
    for (const host of hosts) {
      if (host && hostMatches(pattern, host, port, opts)) return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------------- scopes */

const SCOPE_RANK = { once: 0, run: 1, agent: 2, chat: 3, global: 4 };

function scopeKind(token) {
  const i = token.indexOf(':');
  return i === -1 ? token : token.slice(0, i);
}

/**
 * Ordered chain of scopes a request is covered by, most specific first.
 * A caller may pass several tokens ("run:r1 agent:a1 chat:c1") because a run
 * belongs to an agent belongs to a chat; 'global' is always the last link.
 * Matching is by exact token, so `chat:x` never covers `chat:y`.
 */
function scopeChain(scope) {
  const tokens = [];
  const push = (raw) => {
    const t = String(raw === null || raw === undefined ? '' : raw).trim();
    if (t && !tokens.includes(t)) tokens.push(t);
  };
  if (Array.isArray(scope)) scope.forEach(push);
  else String(scope === null || scope === undefined ? '' : scope).split(/[\s,|]+/).forEach(push);
  push('global');
  return tokens.sort((a, b) => (SCOPE_RANK[scopeKind(a)] ?? 3.5) - (SCOPE_RANK[scopeKind(b)] ?? 3.5));
}

/* ------------------------------------------------------- policy vocabulary */

const MODES = ['offline', 'lan', 'online'];

/** Which destination classes a permission level covers (loopback is separate). */
const LEVEL_COVERAGE = {
  offline: [],
  // A name is 'unknown' until it is resolved. LAN permits it because the
  // resolver a LAN grant implies is itself on the LAN -- the address it comes
  // back with is classified again before anything connects.
  lan: ['private', 'unknown'],
  online: ['private', 'public', 'unknown'],
};

function levelCovers(level, classification) {
  const list = LEVEL_COVERAGE[level];
  return Array.isArray(list) && list.includes(classification);
}

const CLASS_LABEL = {
  loopback: 'lokale Adresse',
  private: 'lokales Netz',
  public: 'öffentliches Internet',
  unknown: 'noch nicht aufgelöster Name',
};

const MODE_LABEL = { offline: 'offline', lan: 'lokales Netz', online: 'online' };

/* ------------------------------------------------- in-memory grant fallback */

function randomId(type) {
  let s = '';
  while (s.length < 24) s += crypto.randomBytes(8).readBigUInt64BE().toString(36);
  return `${type}_${s.slice(0, 24)}`;
}

/**
 * Used only when the gate is constructed without a store (tests, and the
 * doctor path before the vault is open). Grants then work for the lifetime of
 * the process but are not persisted -- which is stated, never hidden.
 */
function createMemoryGrantStore() {
  const records = new Map();
  return {
    persistent: false,
    create(type, data) {
      const now = new Date().toISOString();
      const record = { id: randomId(type), type, createdAt: now, updatedAt: now, deletedAt: null, rev: 1, data };
      records.set(record.id, record);
      return record;
    },
    get(id) {
      return records.get(id) || null;
    },
    update(id, patch) {
      const record = records.get(id);
      if (!record) throw new NotFoundError(`grant ${id}`);
      record.data = { ...record.data, ...patch };
      record.updatedAt = new Date().toISOString();
      record.rev += 1;
      return record;
    },
    all(type) {
      return [...records.values()].filter((r) => r.type === type && !r.deletedAt);
    },
  };
}

/* ------------------------------------------------------------------- gate */

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_HOST_STATS = 500;

/**
 * @param {{config:object, audit?:object, bus?:object, store?:object, logger?:Function|object,
 *          paths?:object, configPath?:string}} deps
 */
function createGate(deps = {}) {
  const config = deps.config;
  if (!config || typeof config !== 'object' || !config.network) {
    throw new ValidationError('createGate benötigt eine Konfiguration mit einem network-Abschnitt.');
  }
  const bus = deps.bus || null;
  const audit = deps.audit || null;
  const log = typeof deps.logger === 'function' ? deps.logger('gate') : (deps.logger || null);
  const configPath = deps.configPath || (deps.paths && deps.paths.config) || null;
  const grantStore = deps.store || createMemoryGrantStore();
  const persistentGrants = deps.store ? true : false;
  if (!persistentGrants && log && log.warn) {
    log.warn('kein Store übergeben - Freigaben gelten nur für die Laufzeit dieses Prozesses');
  }

  const stats = { allowed: 0, blocked: 0, lastAllowedAt: null, lastBlockedAt: null, byHost: {} };
  let grantReadFailures = 0;

  const net = () => config.network || {};

  /* ---------------------------------------------------------- grant access */

  function readGrantRecords() {
    try {
      if (typeof grantStore.all === 'function') return grantStore.all('grant') || [];
      if (typeof grantStore.list === 'function') return (grantStore.list('grant') || {}).items || [];
      return [];
    } catch (err) {
      // An unreadable store (locked vault, corrupt segment) must not widen the
      // policy: no grants means only the global mode applies.
      grantReadFailures++;
      if (log && log.warn) log.warn(`Freigaben nicht lesbar (${grantReadFailures}): ${err && err.message}`);
      return [];
    }
  }

  function grantIsActive(record, now) {
    if (!record || record.deletedAt) return false;
    const d = record.data || {};
    if (d.revoked === true) return false;
    if (d.expiresAt) {
      const t = Date.parse(d.expiresAt);
      if (!Number.isFinite(t) || t <= now) return false; // unparseable == expired
    }
    if (d.maxUses !== null && d.maxUses !== undefined) {
      const max = Number(d.maxUses);
      if (!Number.isFinite(max) || Number(d.uses || 0) >= max) return false;
    }
    return true;
  }

  function activeGrants(now = Date.now()) {
    return readGrantRecords().filter((r) => grantIsActive(r, now));
  }

  function grantsForScope(scope, now = Date.now()) {
    const chain = scopeChain(scope);
    const rank = (g) => {
      const idx = chain.indexOf(g.data.scope);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };
    return activeGrants(now)
      .filter((g) => chain.includes(g.data.scope))
      .sort((a, b) => rank(a) - rank(b));
  }

  /* -------------------------------------------------------------- decision */

  /**
   * Pure policy decision. `ip`, when given, is the address the name actually
   * resolved to; it decides the classification while the name is still used
   * for pattern matching, because users write names into allow/block lists.
   */
  /**
   * A caller may hand down its own ceiling. It can only ever NARROW the
   * decision, never widen it.
   *
   * This exists because "what the device permits" and "what this caller
   * permits" are different questions. An agent restricted to the local
   * network asked the first question and got an answer to the second: the
   * device was in 'online' mode, so its request to a public host sailed
   * through even though the agent's own permission said LAN only. A ceiling
   * evaluated on the RESOLVED address closes that, and because it is applied
   * per hop it also survives a redirect.
   */
  function applyCallerLimit(decision, names, port, limit) {
    if (!decision.allowed || !limit) return decision;
    // Loopback is exempt for the same reason the device policy exempts it in
    // step 2: it never leaves the machine. A host list exists to say which
    // OUTSIDE hosts may be reached; applying it to 127.0.0.1 would cut an
    // agent off from the local model, which is the opposite of the intent.
    if (decision.classification === 'loopback') return decision;
    const { maxLevel, allowedHosts } = limit;
    if (maxLevel && !levelCovers(maxLevel, decision.classification)) {
      return {
        ...decision,
        allowed: false,
        level: 'blocked',
        reason: `Der Aufrufer ist auf '${MODE_LABEL[maxLevel] || maxLevel}' begrenzt; ${CLASS_LABEL[decision.classification]} (${decision.ip || decision.host}) liegt darüber.`,
      };
    }
    if (Array.isArray(allowedHosts) && !matchAnyHost(allowedHosts, names, port)) {
      return {
        ...decision,
        allowed: false,
        level: 'blocked',
        reason: allowedHosts.length
          ? `${decision.host} steht nicht auf der Hostliste des Aufrufers.`
          : `Der Aufrufer hat keine Hosts freigegeben.`,
      };
    }
    return decision;
  }

  function decide(opts) {
    const limit = (opts.maxLevel || opts.allowedHosts) ? { maxLevel: opts.maxLevel, allowedHosts: opts.allowedHosts } : null;
    const raw = decideDevice(opts);
    const names = [];
    if (opts.host) names.push(normaliseHost(opts.host));
    if (opts.ip && normaliseHost(opts.ip) !== names[0]) names.push(normaliseHost(opts.ip));
    return applyCallerLimit(raw, names, opts.port, limit);
  }

  function decideDevice({ host, ip, port, scope, purpose }) {
    const names = [];
    if (host) names.push(normaliseHost(host));
    if (ip && normaliseHost(ip) !== names[0]) names.push(normaliseHost(ip));
    const target = ip || host;
    const classification = classify(target);
    const n = net();
    const base = { host: normaliseHost(host), ip: ip ? normaliseHost(ip) : null, port: port === undefined || port === null ? null : Number(port), scope: String(scope || 'global'), purpose: purpose || 'unspecified', classification };

    // 1. Block list beats everything, including an explicit grant.
    if (matchAnyHost(n.blockHosts, names, port, { denylist: true })) {
      return { ...base, allowed: false, level: 'blocked', reason: `${base.host} steht auf der Sperrliste und ist immer blockiert.` };
    }

    // 2. Loopback: a local model is not the internet.
    if (classification === 'loopback') {
      return { ...base, allowed: true, level: 'local', reason: `Lokale Adresse (${base.ip || base.host}) - verlässt das Gerät nicht.` };
    }

    // 3. An explicit grant, most specific scope first.
    for (const grant of grantsForScope(scope)) {
      const d = grant.data || {};
      if (!levelCovers(d.level, classification)) continue;
      if (!matchAnyHost(d.hosts, names, port)) continue;
      return {
        ...base,
        allowed: true,
        level: d.level,
        grantId: grant.id,
        reason: `Freigabe für ${d.scope}${d.reason ? ` (${d.reason})` : ''} erlaubt ${CLASS_LABEL[classification]}.`,
      };
    }

    // 4. The global mode.
    const mode = MODES.includes(n.mode) ? n.mode : 'offline';
    if (levelCovers(mode, classification)) {
      const needsAllowlist = n.strictAllowlist === true && (classification === 'public' || classification === 'unknown');
      if (!needsAllowlist) {
        return { ...base, allowed: true, level: mode, reason: `Netzmodus '${MODE_LABEL[mode]}' erlaubt ${CLASS_LABEL[classification]}.` };
      }
      if (matchAnyHost(n.allowHosts, names, port)) {
        return { ...base, allowed: true, level: mode, reason: `Netzmodus '${MODE_LABEL[mode]}' und Eintrag auf der Freigabeliste.` };
      }
      return { ...base, allowed: false, level: 'blocked', reason: `${base.host} steht nicht auf der Freigabeliste (strikte Liste aktiv im Modus '${MODE_LABEL[mode]}').` };
    }

    // 5. Nothing covered it.
    const needed = classification === 'private' ? "'lan'" : "'online'";
    return {
      ...base,
      allowed: false,
      level: 'blocked',
      reason: `Netzmodus ist '${MODE_LABEL[mode]}'. Für ${CLASS_LABEL[classification]} (${base.ip || base.host}) wird Modus ${needed} oder eine Freigabe für '${base.scope}' benötigt.`,
    };
  }

  /** Publish + audit + count. Every decision the gate acts on goes through here. */
  function record(decision, kindOverride) {
    const host = decision.host || decision.ip || '(unbekannt)';
    const entry = stats.byHost[host] || { allowed: 0, blocked: 0, lastAt: null };
    if (decision.allowed) {
      stats.allowed++;
      stats.lastAllowedAt = new Date().toISOString();
      entry.allowed++;
      entry.lastAt = stats.lastAllowedAt;
    } else {
      stats.blocked++;
      stats.lastBlockedAt = new Date().toISOString();
      entry.blocked++;
      entry.lastAt = stats.lastBlockedAt;
    }
    if (!stats.byHost[host] && Object.keys(stats.byHost).length >= MAX_HOST_STATS) {
      // A scan of many hosts must not grow this map without bound; the counters
      // and the audit file still hold the truth.
      delete stats.byHost[Object.keys(stats.byHost)[0]];
    }
    stats.byHost[host] = entry;

    const payload = {
      host: decision.host,
      ip: decision.ip || null,
      port: decision.port,
      scope: decision.scope,
      purpose: decision.purpose,
      classification: decision.classification,
      allowed: decision.allowed,
      level: decision.level,
      reason: decision.reason,
      grantId: decision.grantId || null,
    };
    if (bus && typeof bus.publish === 'function') {
      try { bus.publish('network.attempt', payload); } catch (err) { if (log && log.warn) log.warn(`bus.publish fehlgeschlagen: ${err && err.message}`); }
    }
    if (audit && typeof audit.write === 'function') {
      const kind = kindOverride || (!decision.allowed ? 'network.block' : decision.level === 'local' ? 'network.local' : 'network.allow');
      try { audit.write(kind, payload); } catch (err) { if (log && log.warn) log.warn(`audit.write fehlgeschlagen: ${err && err.message}`); }
    }
    return decision;
  }

  function blockedError(decision) {
    return new NetworkBlockedError(decision.reason, {
      host: decision.host,
      ip: decision.ip,
      port: decision.port,
      scope: decision.scope,
      classification: decision.classification,
      purpose: decision.purpose,
    });
  }

  /* ------------------------------------------------------------ resolution */

  function lookupAll(host) {
    return new Promise((resolve, reject) => {
      // Called through the module object on purpose: when harden.js is active
      // this is its patched lookup, and the internal marker below is what lets
      // the gate's own query through its own patch.
      dns.lookup(host, { all: true, verbatim: true, [INTERNAL]: true }, (err, addresses) => {
        if (err) return reject(err);
        if (!addresses || !addresses.length) return reject(Object.assign(new Error(`no address for ${host}`), { code: 'ENOTFOUND' }));
        resolve(addresses);
      });
    });
  }

  function dnsFailure(host, err) {
    const code = (err && err.code) || 'EAI_FAIL';
    return new NeuralError('NAME_RESOLUTION_FAILED', `Der Name ${host} konnte nicht aufgelöst werden (${code}).`, {
      status: 502,
      details: { host, code },
      cause: err,
    });
  }

  /* ---------------------------------------------------------------- object */

  const gate = {
    classify,
    scopeChain,
    INTERNAL,
    runInternal,
    isInternalContext,
    hasInternalMarker,

    get mode() {
      const m = net().mode;
      return MODES.includes(m) ? m : 'offline';
    },

    get grantsArePersisted() {
      return persistentGrants;
    },

    /** Policy decision without DNS and without connecting. */
    check(opts = {}) {
      const decision = decide(opts);
      if (opts.record === false) return decision;
      return record(decision);
    },

    /** Throwing variant used by harden.js and by callers that want no branch. */
    enforce(opts = {}) {
      const decision = gate.check(opts);
      if (!decision.allowed) throw blockedError(decision);
      return decision;
    },

    /**
     * Resolve a hostname to a single pinned address.
     *
     * The policy is consulted BEFORE the query: a lookup that could never lead
     * to a permitted connection is refused outright, because asking a resolver
     * hands it the hostname whether or not the connection later happens.
     */
    async resolve(host, opts = {}) {
      const name = normaliseHost(host);
      if (!name) throw new ValidationError('resolve() benötigt einen Hostnamen.');
      const scope = opts.scope || 'global';
      const port = opts.port === undefined ? null : opts.port;
      const purpose = opts.purpose || 'dns.resolve';
      const maxLevel = opts.maxLevel || null;
      const allowedHosts = Array.isArray(opts.allowedHosts) ? opts.allowedHosts : null;

      // Literals need no resolver at all.
      const family = ipFamily(name);
      if (family) return { ip: name, family, resolved: false };
      // RFC 6761: localhost must never reach a resolver.
      if (name === 'localhost' || name.endsWith('.localhost')) return { ip: '127.0.0.1', family: 4, resolved: false };

      const pre = decide({ host: name, port, scope, purpose, maxLevel, allowedHosts });
      if (!pre.allowed) {
        record(pre, 'network.dns.block');
        throw blockedError(pre);
      }

      let addresses;
      try {
        addresses = await runInternal(() => lookupAll(name));
      } catch (err) {
        throw dnsFailure(name, err);
      }

      // Every address the name carries must be permitted. A single answer that
      // the policy would refuse means the name is smuggling a destination, and
      // picking the "good" one would be exactly the rebinding hole this guards.
      for (const a of addresses) {
        const post = decide({ host: name, ip: a.address, port, scope, purpose, maxLevel, allowedHosts });
        if (!post.allowed) {
          record(post, 'network.dns.block');
          throw blockedError(post);
        }
      }
      // Prefer IPv4: a machine without IPv6 routing would otherwise stall on an
      // AAAA answer that is technically valid and practically unreachable.
      const chosen = addresses.find((a) => a.family === 4) || addresses[0];
      return { ip: chosen.address, family: chosen.family || ipFamily(chosen.address) || 4, resolved: true, all: addresses.map((a) => a.address) };
    },

    /** Count one use of a grant; a used-up grant stops matching immediately. */
    consume(grantId) {
      if (!grantId) return null;
      try {
        const current = typeof grantStore.get === 'function' ? grantStore.get(grantId) : null;
        const uses = Number((current && current.data && current.data.uses) || 0) + 1;
        const updated = grantStore.update(grantId, { uses });
        if (audit) audit.write('network.grant.used', { grantId, uses });
        return updated;
      } catch (err) {
        if (log && log.warn) log.warn(`Freigabe ${grantId} konnte nicht fortgeschrieben werden: ${err && err.message}`);
        return null;
      }
    },

    async fetch(url, init = {}) {
      return performFetch(url, init);
    },

    setMode(mode) {
      if (!MODES.includes(mode)) {
        throw new ValidationError(`Unbekannter Netzmodus '${mode}'. Erlaubt: ${MODES.join(', ')}.`);
      }
      const previous = gate.mode;
      config.network.mode = mode;
      if (configPath) {
        try {
          require('../kernel/config').save(configPath, config);
        } catch (err) {
          if (log && log.error) log.error(`Netzmodus konnte nicht gespeichert werden: ${err && err.message}`);
        }
      }
      if (audit) audit.write('network.mode', { from: previous, to: mode, persisted: !!configPath });
      if (bus) bus.publish('network.mode', { mode, previous });
    },

    addGrant(input = {}) {
      const data = schema.validate('grant', {
        scope: input.scope,
        level: input.level || 'online',
        hosts: Array.isArray(input.hosts) ? input.hosts : [],
        reason: input.reason || '',
        expiresAt: input.expiresAt === undefined ? null : input.expiresAt,
        maxUses: input.maxUses === undefined ? null : input.maxUses,
        uses: 0,
        revoked: false,
      });
      if (!String(data.scope || '').trim()) throw new ValidationError('Eine Freigabe braucht einen Geltungsbereich (scope).');
      if (data.expiresAt !== null && !Number.isFinite(Date.parse(data.expiresAt))) {
        throw new ValidationError('expiresAt muss ein ISO-Zeitstempel sein.');
      }
      if (data.maxUses !== null && (!Number.isInteger(data.maxUses) || data.maxUses < 1)) {
        throw new ValidationError('maxUses muss eine ganze Zahl >= 1 sein.');
      }
      for (const pattern of data.hosts) {
        if (!String(pattern).trim()) throw new ValidationError('Leere Host-Angabe in der Freigabe.');
      }
      const created = grantStore.create('grant', data);
      if (audit) audit.write('network.grant.added', { grantId: created.id, scope: data.scope, level: data.level, hosts: data.hosts, expiresAt: data.expiresAt, maxUses: data.maxUses, reason: data.reason });
      if (bus) bus.publish('network.grant', { action: 'added', grantId: created.id, scope: data.scope, level: data.level, hosts: data.hosts });
      return created;
    },

    /** Revoked grants are kept, not deleted: the audit trail must stay complete. */
    revokeGrant(id) {
      const existing = typeof grantStore.get === 'function' ? grantStore.get(id) : null;
      if (!existing || existing.type !== 'grant') throw new NotFoundError(`Freigabe ${id}`);
      const updated = grantStore.update(id, { revoked: true });
      if (audit) audit.write('network.grant.revoked', { grantId: id, scope: existing.data && existing.data.scope });
      if (bus) bus.publish('network.grant', { action: 'revoked', grantId: id });
      return updated;
    },

    listGrants(opts = {}) {
      const now = Date.now();
      const all = readGrantRecords();
      if (opts.includeInactive === true) return all;
      return all.filter((r) => grantIsActive(r, now));
    },

    effectiveFor(scope) {
      const chain = scopeChain(scope);
      const grants = grantsForScope(scope);
      const n = net();
      const hosts = [];
      const push = (h) => { const s = String(h || '').trim(); if (s && !hosts.includes(s)) hosts.push(s); };
      if (n.strictAllowlist !== true || gate.mode !== 'offline') (n.allowHosts || []).forEach(push);
      grants.forEach((g) => (g.data.hosts || []).forEach(push));
      return {
        mode: gate.mode,
        strictAllowlist: n.strictAllowlist === true,
        blockHosts: [...(n.blockHosts || [])],
        chain,
        hosts,
        grants: grants.map((g) => ({
          id: g.id,
          scope: g.data.scope,
          level: g.data.level,
          hosts: g.data.hosts,
          reason: g.data.reason,
          expiresAt: g.data.expiresAt,
          maxUses: g.data.maxUses,
          uses: g.data.uses,
        })),
      };
    },

    /** What the policy would permit right now -- derived, never probed. */
    reachability() {
      const mode = gate.mode;
      return {
        mode,
        loopback: true,
        lan: levelCovers(mode, 'private') || activeGrants().some((g) => g.data.level === 'lan' || g.data.level === 'online'),
        internet: levelCovers(mode, 'public') || activeGrants().some((g) => g.data.level === 'online'),
      };
    },

    stats() {
      return {
        allowed: stats.allowed,
        blocked: stats.blocked,
        lastAllowedAt: stats.lastAllowedAt,
        lastBlockedAt: stats.lastBlockedAt,
        grantReadFailures,
        byHost: JSON.parse(JSON.stringify(stats.byHost)),
      };
    },
  };

  /* ----------------------------------------------------------- fetch guts */

  function normaliseHeaders(input) {
    const out = {};
    if (!input) return out;
    const entries = typeof input.entries === 'function' ? [...input.entries()] : Object.entries(input);
    for (const [k, v] of entries) {
      if (v === undefined || v === null) continue;
      out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return out;
  }

  function decodeStream(res) {
    const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
    let out = res;
    if (enc === 'gzip' || enc === 'x-gzip') out = zlib.createGunzip();
    else if (enc === 'deflate') out = zlib.createInflate();
    else if (enc === 'br') out = zlib.createBrotliDecompress();
    if (out !== res) {
      res.on('error', (err) => out.destroy(err));
      res.pipe(out);
    }
    return out;
  }

  function readAll(stream, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy();
          reject(new NeuralError('RESPONSE_TOO_LARGE', `Die Antwort überschreitet ${maxBytes} Bytes und wurde abgebrochen.`, { status: 502 }));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks, size)));
    });
  }

  function makeResponse({ status, statusText, headers, url, redirected, stream, buffered, maxBytes }) {
    let bodyPromise = null;
    const drain = () => {
      if (!bodyPromise) bodyPromise = buffered ? Promise.resolve(buffered) : readAll(stream, maxBytes);
      return bodyPromise;
    };
    const hdrs = { ...headers };
    Object.defineProperty(hdrs, 'get', {
      value: (name) => hdrs[String(name).toLowerCase()] ?? null,
      enumerable: false,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: statusText || '',
      url,
      redirected: !!redirected,
      headers: hdrs,
      /** Buffer in buffered mode, the readable stream when init.stream is set. */
      body: buffered || stream,
      async arrayBuffer() {
        const buf = await drain();
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      async text() {
        return (await drain()).toString('utf8');
      },
      async json() {
        const raw = (await drain()).toString('utf8');
        try {
          return JSON.parse(raw);
        } catch (err) {
          throw new ValidationError(`Antwort von ${url} ist kein gültiges JSON: ${err.message}`, { excerpt: raw.slice(0, 200) });
        }
      },
      /** Line-wise view for NDJSON and SSE; works in both modes. */
      async *lines() {
        if (buffered) {
          for (const line of buffered.toString('utf8').split('\n')) yield line.replace(/\r$/, '');
          return;
        }
        let rest = '';
        for await (const chunk of stream) {
          rest += chunk.toString('utf8');
          let idx;
          while ((idx = rest.indexOf('\n')) !== -1) {
            yield rest.slice(0, idx).replace(/\r$/, '');
            rest = rest.slice(idx + 1);
          }
        }
        if (rest) yield rest;
      },
      destroy() {
        if (stream && typeof stream.destroy === 'function') stream.destroy();
      },
    };
  }

  function requestHop({ target, method, headers, body, pinned, deadline, signal, streamMode, maxBytes, redirected }) {
    return new Promise((resolve, reject) => {
      const secure = target.protocol === 'https:';
      const mod = secure ? https : http;
      const port = target.port ? Number(target.port) : (secure ? 443 : 80);
      const options = {
        host: pinned.ip,
        family: pinned.family,
        port,
        method,
        path: `${target.pathname}${target.search}`,
        headers: { ...headers, host: target.host },
        agent: false,
        // Pin hard: even if something re-resolves, it gets the vetted address.
        lookup: (hostname, lookupOpts, cb) => {
          const done = typeof cb === 'function' ? cb : lookupOpts;
          if (lookupOpts && lookupOpts.all === true) return done(null, [{ address: pinned.ip, family: pinned.family }]);
          return done(null, pinned.ip, pinned.family);
        },
        [INTERNAL]: true,
      };
      if (secure) {
        // SNI and certificate identity must follow the NAME, not the pinned IP.
        if (!ipFamily(target.hostname)) options.servername = target.hostname;
        options.rejectUnauthorized = true;
      }

      let settled = false;
      let timer = null;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { req.destroy(); } catch { /* already gone */ }
        reject(err);
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = signal
        ? () => fail(new AbortedError('Die Anfrage wurde abgebrochen.'))
        : null;

      let req;
      try {
        req = mod.request(options);
      } catch (err) {
        return reject(new NeuralError('REQUEST_FAILED', `Anfrage an ${target.host} nicht möglich: ${err && err.message}`, { status: 502, cause: err }));
      }

      if (signal) {
        if (signal.aborted) return fail(new AbortedError('Die Anfrage wurde abgebrochen.'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const remaining = deadline - Date.now();
      timer = setTimeout(() => {
        fail(new NeuralError('NETWORK_TIMEOUT', `Zeitüberschreitung nach ${Math.max(0, Math.round(remaining))} ms für ${target.host}.`, { status: 504 }));
      }, Math.max(1, remaining));

      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new NeuralError('REQUEST_FAILED', `Verbindung zu ${target.host} fehlgeschlagen: ${err && err.message} (${(err && err.code) || 'unbekannt'}).`, {
          status: 502,
          details: { code: err && err.code, host: target.host, ip: pinned.ip, port },
          cause: err,
        }));
      });

      req.on('response', async (res) => {
        if (settled) { res.destroy(); return; }
        const status = res.statusCode || 0;
        const location = res.headers.location;
        const isRedirect = [301, 302, 303, 307, 308].includes(status) && typeof location === 'string' && location.length > 0;
        if (isRedirect) {
          settled = true;
          cleanup();
          res.resume(); // discard the body, we only need the Location
          resolve({ redirect: { status, location } });
          return;
        }
        const decoded = decodeStream(res);
        if (streamMode) {
          // The caller owns the stream from here: a long model stream must not
          // be killed by a timeout meant for establishing the request.
          settled = true;
          cleanup();
          if (signal) signal.addEventListener('abort', () => res.destroy(), { once: true });
          resolve({
            response: makeResponse({ status, statusText: res.statusMessage, headers: res.headers, url: target.href, redirected, stream: decoded, maxBytes }),
          });
          return;
        }
        try {
          const buffered = await readAll(decoded, maxBytes);
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ response: makeResponse({ status, statusText: res.statusMessage, headers: res.headers, url: target.href, redirected, buffered, maxBytes }) });
        } catch (err) {
          fail(err);
        }
      });

      if (body !== undefined && body !== null) req.end(body);
      else req.end();
    });
  }

  /** Anything a caller may hand us as a body, as bytes -- never as "[object Object]". */
  function toBodyBuffer(body) {
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    try {
      return Buffer.from(JSON.stringify(body), 'utf8');
    } catch (err) {
      throw new ValidationError(`Der Anfrage-Körper ist nicht serialisierbar: ${err.message}`);
    }
  }

  async function performFetch(url, init = {}) {
    const scope = init.scope;
    if (typeof scope !== 'string' || !scope.trim()) {
      throw new ValidationError("gate.fetch() benötigt init.scope (z. B. 'global', 'chat:<id>' oder 'run:<id>').");
    }
    const purpose = init.purpose || 'fetch';
    // Caller-supplied ceiling. Re-evaluated on every hop, so a redirect cannot
    // walk an agent off its own host list.
    const maxLevel = init.maxLevel || null;
    const allowedHosts = Array.isArray(init.allowedHosts) ? init.allowedHosts : null;
    let target;
    try {
      target = new URL(String(url));
    } catch {
      throw new ValidationError(`Ungültige URL: ${String(url).slice(0, 200)}`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new ValidationError(`Nur http und https sind erlaubt, nicht '${target.protocol}'.`);
    }
    if (init.signal && init.signal.aborted) throw new AbortedError('Die Anfrage wurde abgebrochen.');

    const timeoutMs = Number.isFinite(init.timeoutMs) && init.timeoutMs > 0 ? Number(init.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const maxBytes = Number.isFinite(init.maxBytes) && init.maxBytes > 0 ? Number(init.maxBytes) : DEFAULT_MAX_BYTES;
    const deadline = Date.now() + timeoutMs;
    const streamMode = init.stream === true;

    let method = String(init.method || 'GET').toUpperCase();
    let body = init.body;
    const headers = normaliseHeaders(init.headers);
    if (!headers['user-agent']) headers['user-agent'] = 'neural-os'; // no version: less to fingerprint
    if (!headers.accept) headers.accept = '*/*';
    if (body !== undefined && body !== null) {
      body = toBodyBuffer(body);
      if (headers['content-length'] === undefined) headers['content-length'] = String(body.length);
    }

    let redirects = 0;
    let redirected = false;
    const seen = [];

    for (;;) {
      const port = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80);
      const host = target.hostname;

      // Provisional decision on the name. Recorded only when it denies, because
      // otherwise the decision on the pinned address below supersedes it.
      const pre = decide({ host, port, scope, purpose, maxLevel, allowedHosts });
      if (!pre.allowed) {
        record(pre);
        throw blockedError(pre);
      }

      const pinned = await gate.resolve(host, { scope, port, purpose, maxLevel, allowedHosts });
      const post = decide({ host, ip: pinned.ip, port, scope, purpose, maxLevel, allowedHosts });
      if (!post.allowed) {
        record(post);
        throw blockedError(post);
      }
      record(post);
      if (post.grantId) gate.consume(post.grantId);

      if (Date.now() >= deadline) {
        throw new NeuralError('NETWORK_TIMEOUT', `Zeitüberschreitung vor dem Verbindungsaufbau zu ${host}.`, { status: 504 });
      }

      const hop = await runInternal(() => requestHop({
        target, method, headers, body, pinned, deadline,
        signal: init.signal, streamMode, maxBytes, redirected,
      }));

      if (!hop.redirect) return hop.response;

      if (redirects >= MAX_REDIRECTS) {
        throw new NeuralError('TOO_MANY_REDIRECTS', `Mehr als ${MAX_REDIRECTS} Weiterleitungen ab ${seen[0] || target.href} - abgebrochen.`, { status: 502, details: { chain: seen } });
      }
      let next;
      try {
        next = new URL(hop.redirect.location, target);
      } catch {
        throw new ValidationError(`Ungültige Weiterleitung nach ${hop.redirect.location}`);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new ValidationError(`Weiterleitung auf nicht unterstütztes Protokoll '${next.protocol}'.`);
      }
      // Credentials must not follow a redirect to another origin.
      if (next.host !== target.host) {
        delete headers.authorization;
        delete headers.cookie;
      }
      if ([301, 302, 303].includes(hop.redirect.status) && method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        body = undefined;
        delete headers['content-length'];
        delete headers['content-type'];
      }
      seen.push(target.href);
      target = next;
      redirects++;
      redirected = true;
    }
  }

  return gate;
}

module.exports = {
  createGate,
  classify,
  classifyIPv4,
  classifyIPv6,
  parseIPv4,
  parseIPv6,
  normaliseHost,
  hostMatches,
  scopeChain,
  ipFamily,
  ipKey,
  MODES,
  INTERNAL,
  runInternal,
  isInternalContext,
  hasInternalMarker,
};
