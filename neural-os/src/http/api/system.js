'use strict';

/**
 * Status, configuration and the live event stream.
 *
 * `/api/status` is the honest self-report the whole UI hangs off: it never
 * probes a model backend (that would make opening a tab wait on the network)
 * and it never claims a subsystem exists when it does not. Whatever is
 * missing is named, in German, with the reason the app recorded at boot.
 *
 * `/api/events` is the single channel through which the browser learns that
 * anything changed. One bus, one stream: there is no second code path that
 * updates the screen without a real event behind it. Replay via `?since=<seq>`
 * exists because a reconnect that silently skips events is worse than one that
 * repeats a few -- the UI can dedupe by `seq`, it cannot invent what it missed.
 */

const configMod = require('../../kernel/config');
const { describePortable } = require('../../kernel/paths');
const {
  need,
  asObject,
  intParam,
  listParam,
} = require('./support');

let packageVersion = '0.0.0';
try {
  packageVersion = require('../../../package.json').version || packageVersion;
} catch { /* running from a stripped tree: the version is cosmetic */ }

/**
 * Keys whose values must never cross the HTTP boundary, at any depth.
 * Matched exactly, not by suffix: `requireToken` is a setting, `token` is a
 * secret, and a sloppy pattern would blank out half the settings screen.
 */
const SECRET_KEYS = new Set([
  'apikey', 'api_key', 'passphrase', 'password', 'secret', 'token', 'hash', 'salt', 'wrappedkey', 'keycheck',
]);
const isSecretKey = (key) => SECRET_KEYS.has(String(key).toLowerCase());

function sanitiseConfig(value) {
  if (Array.isArray(value)) return value.map(sanitiseConfig);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      // Report presence, never content: the settings UI needs to show "set"
      // without ever holding the value.
      out[key] = entry === null || entry === undefined || entry === '' ? null : '[gesetzt]';
      continue;
    }
    out[key] = sanitiseConfig(entry);
  }
  return out;
}

function vaultState(ctx) {
  const crypto = ctx.vaultCrypto;
  const stats = ctx.store && typeof ctx.store.stats === 'function' ? safeStats(ctx.store) : {};
  return {
    state: crypto && crypto.state ? crypto.state : 'disabled',
    encrypted: !!(crypto && crypto.enabled),
    records: Number.isFinite(stats.records) ? stats.records : null,
    bytes: Number.isFinite(stats.bytes) ? stats.bytes : null,
    counts: stats.counts || {},
    logSegments: stats.logSegments ?? null,
    lastWrite: stats.lastWrite ?? null,
    recovery: stats.recovery || null,
  };
}

function safeStats(store) {
  try {
    return store.stats() || {};
  } catch {
    return {};
  }
}

/** The last probe result, never a fresh probe: status must not wait on I/O. */
function modelState(ctx) {
  const registry = ctx.registry;
  if (!registry || typeof registry.list !== 'function') {
    return { available: false, providers: [], reason: 'Die Modellverwaltung ist nicht verfügbar.' };
  }
  let snapshot = null;
  try {
    snapshot = registry.list();
  } catch {
    snapshot = null;
  }
  if (!snapshot || !Array.isArray(snapshot.providers)) {
    return { available: false, providers: [], probed: false, reason: 'Es wurde noch nicht nach Modellen gesucht.' };
  }
  return {
    available: snapshot.providers.some((p) => p.available),
    probed: true,
    at: snapshot.at || null,
    providers: snapshot.providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      baseUrl: p.baseUrl,
      available: !!p.available,
      models: Array.isArray(p.models) ? p.models.map((m) => m.id) : [],
      error: p.error || null,
      latencyMs: p.latencyMs ?? null,
    })),
  };
}

function networkState(ctx) {
  const config = ctx.config || {};
  const mode = (config.network && config.network.mode) || 'offline';
  const state = {
    mode,
    online: mode !== 'offline',
    strictAllowlist: !!(config.network && config.network.strictAllowlist),
    hardened: !!ctx.hardening,
    classification: { loopback: true, lan: false, internet: false },
  };
  const gate = ctx.gate;
  if (gate) {
    try {
      if (typeof gate.reachability === 'function') state.classification = gate.reachability();
      if (typeof gate.stats === 'function') state.stats = gate.stats();
      if (gate.mode) state.mode = gate.mode;
      state.online = state.mode !== 'offline';
    } catch (err) {
      state.problem = `Die Netz-Schleuse konnte nicht befragt werden: ${err && err.message}`;
    }
  } else {
    state.problem = 'Die Netz-Schleuse ist nicht verfügbar.';
  }
  return state;
}

function agentState(ctx) {
  const runtime = ctx.runtime;
  let active = 0;
  if (runtime && typeof runtime.listActive === 'function') {
    try { active = runtime.listActive().length; } catch { active = 0; }
  }
  let pending = 0;
  if (ctx.approvals && typeof ctx.approvals.listPending === 'function') {
    try { pending = ctx.approvals.listPending().length; } catch { pending = 0; }
  }
  return { active, available: !!runtime, pendingApprovals: pending };
}

function register(router) {
  router.get('/api/status', (rc) => {
    rc.requireCapability('read');
    const ctx = rc.ctx;
    const config = ctx.config || {};
    return {
      version: ctx.version || packageVersion,
      node: process.version,
      uptime: Math.round(process.uptime()),
      home: (ctx.paths && ctx.paths.home) || null,
      // Laeuft dieser Prozess von einem Stick? Bisher stand das nur im
      // Startbanner im Terminal -- der Browser konnte nicht einmal erfahren,
      // DASS er von einem Stick bedient wird, obwohl genau das die Antwort auf
      // "wo liegen meine Daten gerade" ist. null heisst: von der Platte.
      portable: describePortable(ctx.portable),
      network: networkState(ctx),
      vault: vaultState(ctx),
      models: modelState(ctx),
      agents: agentState(ctx),
      sharing: { enabled: !!(config.security && config.security.sharing && config.security.sharing.enabled) },
      subsystems: {
        store: !!ctx.store,
        gate: !!ctx.gate,
        graph: !!ctx.graph,
        models: !!ctx.registry,
        chat: !!ctx.chat,
        agents: !!ctx.runtime,
        approvals: !!ctx.approvals,
        backup: !!ctx.backup,
        auth: !!ctx.auth,
        stick: !!ctx.stick,
        vaultCrypto: !!ctx.vaultCrypto,
      },
      // Whatever failed at boot is part of the status, not a secret.
      failures: Array.isArray(ctx.failures) ? ctx.failures : [],
    };
  });

  router.get('/api/config', (rc) => {
    rc.requireCapability('read');
    return { config: sanitiseConfig(rc.ctx.config || {}) };
  });

  router.patch('/api/config', async (rc) => {
    rc.requireOwner('Die Konfiguration');
    const patch = asObject(await rc.body());
    const ctx = rc.ctx;

    if (typeof ctx.saveConfig === 'function') {
      // The composition root knows how to apply a change live (network mode,
      // bus notification); prefer it over writing the file behind its back.
      const updated = ctx.saveConfig(patch);
      return { config: sanitiseConfig(updated) };
    }

    const current = need(ctx.config, 'Die Konfiguration');
    const next = configMod.deepMerge(current, patch);
    configMod.validateConfig(next);
    let persisted = false;
    if (ctx.paths && ctx.paths.config) {
      configMod.save(ctx.paths.config, next);
      persisted = true;
    }
    Object.assign(current, next);
    if (ctx.bus && typeof ctx.bus.publish === 'function') {
      ctx.bus.publish('config.changed', { config: sanitiseConfig(current) });
    }
    return { config: sanitiseConfig(current), persisted };
  });

  /**
   * Server-sent events. One stream carries every bus event; the browser
   * reconnects by itself and passes the last `seq` it saw back as `?since=`.
   */
  router.get('/api/events', (rc) => {
    rc.requireCapability('read');
    const bus = need(rc.ctx.bus, 'Der Ereignis-Bus');
    const since = intParam(rc.query, 'since', 0, 0);
    const only = listParam(rc.query, 'names');
    const wanted = only ? new Set(only) : null;

    const stream = rc.openStream({ retryMs: 2000 });
    stream.comment(`verbunden ${new Date().toISOString()}`);

    const forward = (event) => {
      if (!event || typeof event.name !== 'string') return;
      if (wanted && !wanted.has(event.name)) return;
      stream.send(
        event.name.replace(/[\r\n]/g, ''),
        { seq: event.seq, at: event.at, name: event.name, payload: event.payload },
        event.seq,
      );
    };

    if (since > 0 && typeof bus.since === 'function') {
      let missed = [];
      try {
        missed = bus.since(since) || [];
      } catch (err) {
        stream.send('warning', { message: `Frühere Ereignisse konnten nicht nachgeliefert werden: ${err && err.message}` });
      }
      for (const event of missed) forward(event);
    }

    let unsubscribe = null;
    if (typeof bus.subscribe === 'function') {
      unsubscribe = bus.subscribe(forward);
    } else if (typeof bus.on === 'function') {
      bus.on('*', forward);
      unsubscribe = () => bus.off('*', forward);
    }
    stream.onClose(() => {
      if (typeof unsubscribe === 'function') unsubscribe();
    });

    stream.send('hello', {
      at: new Date().toISOString(),
      seq: Number.isFinite(bus.seq) ? bus.seq : null,
      replayed: since > 0,
      heartbeatSeconds: 25,
    });
    return undefined; // the stream owns the response from here
  });
}

module.exports = { register, sanitiseConfig };
