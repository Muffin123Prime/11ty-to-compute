'use strict';

/**
 * Process-level enforcement of the egress policy.
 *
 * WHAT THIS IS, HONESTLY
 * ----------------------
 * This module monkey-patches the Node standard library entry points that can
 * open an outbound connection, and routes each of them through the gate. That
 * turns "no module may call http.request directly" from a rule in a document
 * into a rule the runtime enforces: a module that ignores the contract, or a
 * dependency that was never told about it, hits the same wall as everything
 * else.
 *
 * It is NOT a firewall. It binds this process only:
 *   - a child process, a native addon with its own socket, or any other
 *     program on the machine is entirely unaffected;
 *   - code that captured a reference to `http.request` BEFORE harden() ran
 *     keeps the original function, which is why the composition root installs
 *     the gate and this patch before any other subsystem is created;
 *   - `dgram`, raw sockets and QUIC are not covered (nothing in Neural OS uses
 *     them, and the DNS resolver -- the one realistic UDP path -- is covered
 *     through the dns.* patches).
 * The offline promise is therefore: this application does not talk to the
 * network behind your back. Not: this machine cannot talk to the network.
 *
 * WHY DNS IS PATCHED AT ALL
 * -------------------------
 * A lookup is not a neutral preliminary. It hands the hostname to a resolver,
 * which is the exact leak an offline-first system exists to prevent. Patched
 * lookups are therefore refused whenever the connection they prepare would be
 * refused, and `localhost` is answered locally instead of being asked about.
 *
 * WHY ALLOWED CALLS APPEAR SEVERAL TIMES IN THE AUDIT
 * --------------------------------------------------
 * One `https.get()` passes the https layer, the socket layer and possibly the
 * DNS layer. Each layer asks the gate and each answer is recorded, with the
 * layer named in `purpose`. Deduplicating would mean trusting one layer to
 * speak for the others; the audit is more useful when it shows every question
 * that was actually asked.
 */

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

const { NetworkBlockedError } = require('../kernel/errors');
const gateModule = require('./gate');

const { INTERNAL, isInternalContext, hasInternalMarker, normaliseHost, ipFamily } = gateModule;

/**
 * Tag an options object with a gate scope so a hardened call is attributed to
 * the run/chat/agent that caused it instead of falling back to 'global'.
 */
const SCOPE = Symbol('neural-os.harden.scope');

const RESOLVE_METHODS = [
  'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
  'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa',
  'resolveSrv', 'resolveTxt', 'reverse',
];

const PATCHED = Symbol('neural-os.harden.patched');

/** Node's own argument normalisation for net.connect / socket.connect. */
function isPipeName(value) {
  return typeof value === 'string' && Number.isNaN(Number(value));
}

function scopeOf(options) {
  if (options && typeof options === 'object' && typeof options[SCOPE] === 'string') return options[SCOPE];
  return null;
}

function targetFromSocketArgs(args) {
  const a0 = args[0];
  if (isPipeName(a0)) return { unix: true };
  if (typeof a0 === 'number' || typeof a0 === 'string') {
    return { port: Number(a0), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  }
  if (a0 && typeof a0 === 'object') {
    if (typeof a0.path === 'string' && a0.path) return { unix: true, options: a0 };
    const host = a0.host || a0.hostname || 'localhost';
    return { host: String(host), port: Number(a0.port) || 0, options: a0 };
  }
  return { unusable: true };
}

function targetFromTlsArgs(args) {
  const a0 = args[0];
  if (typeof a0 === 'number' || typeof a0 === 'string') {
    const options = args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) || null;
    const host = typeof args[1] === 'string' ? args[1] : (options && (options.host || options.servername)) || 'localhost';
    return { port: Number(a0), host: String(host), options };
  }
  if (a0 && typeof a0 === 'object') {
    if (typeof a0.path === 'string' && a0.path) return { unix: true, options: a0 };
    if (a0.socket) return { reusedSocket: true, options: a0 }; // already vetted when it was connected
    const host = a0.host || a0.servername || 'localhost';
    return { host: String(host), port: Number(a0.port) || 443, options: a0 };
  }
  return { unusable: true };
}

function targetFromHttpArgs(args, secure) {
  let url = null;
  let options = null;
  if (typeof args[0] === 'string') {
    try { url = new URL(args[0]); } catch { url = null; }
    if (args[1] && typeof args[1] === 'object') options = args[1];
  } else if (args[0] instanceof URL) {
    url = args[0];
    if (args[1] && typeof args[1] === 'object') options = args[1];
  } else if (args[0] && typeof args[0] === 'object') {
    options = args[0];
  }
  if (options && typeof options.socketPath === 'string' && options.socketPath) return { unix: true, options };
  let host = null;
  let port = null;
  if (options) {
    host = options.hostname || options.host || null;
    port = options.port || null;
  }
  if (!host && url) host = url.hostname;
  if (!port && url) port = url.port || (url.protocol === 'https:' ? 443 : 80);
  if (!host) host = 'localhost';
  if (!port) port = secure ? 443 : 80;
  return { host: String(host), port: Number(port) || (secure ? 443 : 80), options, url };
}

/**
 * @param {object} gate  the gate created by createGate()
 * @param {{logger?:Function|object, allowUnscoped?:boolean}} [opts]
 *   allowUnscoped=true turns enforcement into pure observation for calls that
 *   carry no scope tag -- a diagnostic escape hatch, never a default.
 * @returns {{restore:()=>void, stats:()=>object}}
 */
function harden(gate, opts = {}) {
  if (!gate || typeof gate.check !== 'function') {
    throw new TypeError('harden(gate) benötigt eine Schleuse mit check().');
  }
  const log = typeof opts.logger === 'function' ? opts.logger('harden') : (opts.logger || null);
  const allowUnscoped = opts.allowUnscoped === true;

  const counters = { checked: 0, allowed: 0, blocked: 0, passthrough: 0, unscoped: 0, byLayer: {} };
  /** @type {Array<{restore:()=>void}>} */
  const undo = [];
  let active = true;

  function countLayer(layer, outcome) {
    const entry = counters.byLayer[layer] || { allowed: 0, blocked: 0, passthrough: 0 };
    entry[outcome] = (entry[outcome] || 0) + 1;
    counters.byLayer[layer] = entry;
  }

  /**
   * @returns {NetworkBlockedError|null} null means "let it through"
   */
  function verdict({ layer, host, port, options }) {
    if (isInternalContext() || hasInternalMarker(options)) {
      counters.passthrough++;
      countLayer(layer, 'passthrough');
      return null;
    }
    const scope = scopeOf(options);
    if (!scope) {
      counters.unscoped++;
      if (allowUnscoped) {
        countLayer(layer, 'passthrough');
        return null;
      }
    }
    counters.checked++;
    const decision = gate.check({ host, port, scope: scope || 'global', purpose: layer });
    if (decision.allowed) {
      counters.allowed++;
      countLayer(layer, 'allowed');
      if (decision.grantId && typeof gate.consume === 'function') gate.consume(decision.grantId);
      return null;
    }
    counters.blocked++;
    countLayer(layer, 'blocked');
    if (log && log.warn) log.warn(`${layer} blockiert: ${host}:${port} - ${decision.reason}`);
    return new NetworkBlockedError(decision.reason, {
      host: decision.host,
      port: decision.port,
      classification: decision.classification,
      layer,
    });
  }

  function patch(owner, key, factory, label) {
    const original = owner[key];
    if (typeof original !== 'function') return;
    if (original[PATCHED]) return; // harden() twice must not stack wrappers
    const replacement = factory(original);
    try {
      Object.defineProperty(replacement, 'name', { value: original.name, configurable: true });
    } catch { /* non-fatal cosmetics */ }
    replacement[PATCHED] = true;
    try {
      owner[key] = replacement;
    } catch (err) {
      if (log && log.warn) log.warn(`${label} konnte nicht abgesichert werden: ${err && err.message}`);
      return;
    }
    if (owner[key] !== replacement) {
      if (log && log.warn) log.warn(`${label} konnte nicht abgesichert werden (Eigenschaft schreibgeschützt)`);
      return;
    }
    undo.push({ label, restore() { owner[key] = original; } });
  }

  /* ------------------------------------------------------------ global fetch */

  if (typeof globalThis.fetch === 'function') {
    patch(globalThis, 'fetch', (original) => function patchedFetch(input, init = {}) {
      void original;
      let href;
      try {
        if (typeof input === 'string') href = new URL(input).href;
        else if (input instanceof URL) href = input.href;
        else if (input && typeof input.url === 'string') href = new URL(input.url).href;
        else throw new Error('unsupported input');
      } catch {
        return Promise.reject(new NetworkBlockedError('Diese Anfrage hat kein auswertbares Ziel und wurde blockiert.', { layer: 'fetch' }));
      }
      // Routed through the gate rather than merely checked: that way the global
      // fetch inherits IP pinning and redirect re-checks. The result is the
      // gate's Response-like object, not a WHATWG Response.
      return gate.fetch(href, { ...init, scope: (init && init.scope) || 'global', purpose: 'global.fetch' });
    }, 'globalThis.fetch');
  }

  /* -------------------------------------------------------------- http(s) */

  for (const [mod, key, secure, label] of [
    [http, 'request', false, 'http.request'],
    [http, 'get', false, 'http.get'],
    [https, 'request', true, 'https.request'],
    [https, 'get', true, 'https.get'],
  ]) {
    patch(mod, key, (original) => function patchedHttp(...args) {
      const target = targetFromHttpArgs(args, secure);
      if (target.unix) return original.apply(this, args);
      const err = verdict({ layer: label, host: target.host, port: target.port, options: target.options });
      if (err) throw err; // synchronous: the caller has no request object yet
      return original.apply(this, args);
    }, label);
  }

  /* ---------------------------------------------------------------- sockets */

  patch(net.Socket.prototype, 'connect', (original) => function patchedSocketConnect(...args) {
    const target = targetFromSocketArgs(args);
    if (target.unix || target.unusable) return original.apply(this, args);
    const err = verdict({ layer: 'net.Socket.connect', host: target.host, port: target.port, options: target.options });
    if (err) throw err;
    return original.apply(this, args);
  }, 'net.Socket.prototype.connect');

  for (const key of ['connect', 'createConnection']) {
    patch(net, key, (original) => function patchedNetConnect(...args) {
      const target = targetFromSocketArgs(args);
      if (target.unix || target.unusable) return original.apply(this, args);
      const err = verdict({ layer: `net.${key}`, host: target.host, port: target.port, options: target.options });
      if (err) throw err;
      return original.apply(this, args);
    }, `net.${key}`);
  }

  patch(tls, 'connect', (original) => function patchedTlsConnect(...args) {
    const target = targetFromTlsArgs(args);
    if (target.unix || target.reusedSocket || target.unusable) return original.apply(this, args);
    const err = verdict({ layer: 'tls.connect', host: target.host, port: target.port, options: target.options });
    if (err) throw err;
    return original.apply(this, args);
  }, 'tls.connect');

  /* -------------------------------------------------------------------- dns */

  /** localhost is answered here instead of being handed to a resolver. */
  function localAnswer(hostname, options) {
    const wantsSix = options && Number(options.family) === 6;
    const address = wantsSix ? '::1' : '127.0.0.1';
    const family = wantsSix ? 6 : 4;
    if (options && options.all === true) return [{ address, family }];
    return { address, family };
  }

  function dnsVerdict(hostname, options, layer) {
    const name = normaliseHost(hostname);
    if (!name) return { error: new NetworkBlockedError('Leerer Hostname - Auflösung verweigert.', { layer }) };
    if (name === 'localhost' || name.endsWith('.localhost')) return { local: true };
    if (ipFamily(name)) {
      // A literal needs no query; still subject to policy so a blocked address
      // cannot be laundered through dns.lookup().
      const err = verdict({ layer, host: name, port: null, options });
      return err ? { error: err } : { literal: true };
    }
    const err = verdict({ layer, host: name, port: null, options });
    return err ? { error: err } : {};
  }

  patch(dns, 'lookup', (original) => function patchedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    if (isInternalContext() || hasInternalMarker(opts)) return original.call(this, hostname, options, callback);
    const outcome = dnsVerdict(hostname, opts, 'dns.lookup');
    if (outcome.error) {
      if (typeof cb !== 'function') throw outcome.error;
      return process.nextTick(cb, outcome.error);
    }
    if (outcome.local) {
      const answer = localAnswer(hostname, opts);
      if (typeof cb !== 'function') throw new TypeError('dns.lookup benötigt einen Callback.');
      return Array.isArray(answer)
        ? process.nextTick(cb, null, answer)
        : process.nextTick(cb, null, answer.address, answer.family);
    }
    return original.call(this, hostname, options, callback);
  }, 'dns.lookup');

  if (dns.promises && typeof dns.promises.lookup === 'function') {
    patch(dns.promises, 'lookup', (original) => function patchedLookupPromise(hostname, options = {}) {
      if (isInternalContext() || hasInternalMarker(options)) return original.call(this, hostname, options);
      const outcome = dnsVerdict(hostname, options, 'dns.promises.lookup');
      if (outcome.error) return Promise.reject(outcome.error);
      if (outcome.local) return Promise.resolve(localAnswer(hostname, options));
      return original.call(this, hostname, options);
    }, 'dns.promises.lookup');
  }

  const resolverOwners = [
    [dns, 'dns', false],
    [dns.promises, 'dns.promises', true],
    [dns.Resolver && dns.Resolver.prototype, 'dns.Resolver', false],
    [dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype, 'dns.promises.Resolver', true],
  ];
  for (const [owner, ownerLabel, isPromise] of resolverOwners) {
    if (!owner) continue;
    for (const method of RESOLVE_METHODS) {
      if (typeof owner[method] !== 'function') continue;
      patch(owner, method, (original) => function patchedResolve(...args) {
        if (isInternalContext()) return original.apply(this, args);
        const layer = `${ownerLabel}.${method}`;
        const name = args[0];
        const cb = args.find((a) => typeof a === 'function') || null;
        const outcome = dnsVerdict(name, null, layer);
        if (outcome.error) {
          if (isPromise || !cb) {
            if (isPromise) return Promise.reject(outcome.error);
            throw outcome.error;
          }
          return process.nextTick(cb, outcome.error);
        }
        if (outcome.local) {
          // Answering a PTR/A question about localhost from here keeps the name
          // off the wire; anything else about it is refused rather than faked.
          if (method === 'resolve4' || method === 'resolve') {
            const answer = ['127.0.0.1'];
            if (isPromise) return Promise.resolve(answer);
            if (cb) return process.nextTick(cb, null, answer);
          }
          if (method === 'resolve6') {
            const answer = ['::1'];
            if (isPromise) return Promise.resolve(answer);
            if (cb) return process.nextTick(cb, null, answer);
          }
        }
        return original.apply(this, args);
      }, `${ownerLabel}.${method}`);
    }
  }

  /* --------------------------------------------------------------- WebSocket */

  if (typeof globalThis.WebSocket === 'function') {
    const OriginalWebSocket = globalThis.WebSocket;
    if (!OriginalWebSocket[PATCHED]) {
      function GuardedWebSocket(url, protocols) {
        let host = null;
        let port = null;
        try {
          const u = new URL(String(url));
          host = u.hostname;
          port = u.port ? Number(u.port) : (u.protocol === 'wss:' ? 443 : 80);
        } catch {
          throw new NetworkBlockedError('WebSocket ohne auswertbares Ziel wurde blockiert.', { layer: 'WebSocket' });
        }
        const err = verdict({ layer: 'WebSocket', host, port, options: null });
        if (err) throw err;
        return new OriginalWebSocket(url, protocols);
      }
      GuardedWebSocket.prototype = OriginalWebSocket.prototype;
      for (const key of Object.getOwnPropertyNames(OriginalWebSocket)) {
        if (['length', 'name', 'prototype'].includes(key)) continue;
        try { GuardedWebSocket[key] = OriginalWebSocket[key]; } catch { /* read-only static */ }
      }
      GuardedWebSocket[PATCHED] = true;
      try {
        globalThis.WebSocket = GuardedWebSocket;
        undo.push({ label: 'globalThis.WebSocket', restore() { globalThis.WebSocket = OriginalWebSocket; } });
      } catch { /* frozen global: nothing to undo */ }
    }
  }

  if (log && log.info) log.info(`Netzwerkzugriff prozessweit abgesichert (${undo.length} Einstiegspunkte)`);

  return {
    restore() {
      if (!active) return;
      active = false;
      while (undo.length) {
        const entry = undo.pop();
        try {
          entry.restore();
        } catch (err) {
          if (log && log.warn) log.warn(`${entry.label} konnte nicht zurückgesetzt werden: ${err && err.message}`);
        }
      }
    },
    stats() {
      return {
        active,
        patched: undo.map((u) => u.label),
        allowUnscoped,
        ...counters,
        byLayer: JSON.parse(JSON.stringify(counters.byLayer)),
      };
    },
  };
}

module.exports = { harden, SCOPE, INTERNAL };
