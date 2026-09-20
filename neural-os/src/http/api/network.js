'use strict';

/**
 * The network panel: the one screen that decides what may leave this machine.
 *
 * Every route here is owner-only. A shared read token must never be able to
 * widen egress -- a guest who can grant themselves the internet makes the
 * whole gate decorative.
 *
 * `POST /api/network/test` answers what the policy *would* decide, without
 * connecting and without a DNS lookup (a lookup is itself egress: it hands the
 * hostname to a resolver). That is why the UI can offer "would this work?"
 * honestly while still being offline.
 *
 * The audit view reads the real file on disk, not an in-memory copy, because
 * the point of the audit trail is that it survives the process that wrote it.
 */

const configMod = require('../../kernel/config');
const { ValidationError, NotFoundError } = require('../../kernel/errors');
const {
  need,
  needMethod,
  asObject,
  requireString,
  optionalString,
  requireStringArray,
  intParam,
  boolParam,
} = require('./support');

const LEVELS = new Set(['lan', 'online']);

function gateOf(rc) {
  return needMethod(
    rc.ctx.gate,
    'check',
    'Die Netz-Schleuse',
    'Ohne sie gibt es keine durchsetzbare Zusage darüber, was das Gerät verlässt.',
  );
}

function snapshot(rc, gate) {
  const config = rc.ctx.config || {};
  const network = config.network || {};
  const out = {
    mode: typeof gate.mode === 'string' ? gate.mode : network.mode || 'offline',
    strictAllowlist: network.strictAllowlist !== false,
    allowHosts: Array.isArray(network.allowHosts) ? network.allowHosts.slice() : [],
    blockHosts: Array.isArray(network.blockHosts) ? network.blockHosts.slice() : [],
    audit: network.audit !== false,
    hardened: !!rc.ctx.hardening,
    grants: [],
    stats: null,
    reachability: null,
  };
  if (typeof gate.listGrants === 'function') {
    out.grants = gate.listGrants().map((record) => ({ id: record.id, createdAt: record.createdAt, ...record.data }));
  }
  if (typeof gate.stats === 'function') out.stats = gate.stats();
  if (typeof gate.reachability === 'function') out.reachability = gate.reachability();
  return out;
}

/** Persist a network change through the composition root when it is there. */
function applyConfig(rc, patch) {
  const ctx = rc.ctx;
  if (typeof ctx.saveConfig === 'function') return { config: ctx.saveConfig(patch), persisted: true };
  const current = need(ctx.config, 'Die Konfiguration');
  const next = configMod.deepMerge(current, patch);
  configMod.validateConfig(next);
  let persisted = false;
  if (ctx.paths && ctx.paths.config) {
    configMod.save(ctx.paths.config, next);
    persisted = true;
  }
  Object.assign(current, next);
  return { config: current, persisted };
}

function register(router) {
  router.get('/api/network', (rc) => {
    rc.requireCapability('read');
    const gate = gateOf(rc);
    const scope = rc.query.get('scope');
    const out = snapshot(rc, gate);
    if (scope && typeof gate.effectiveFor === 'function') out.effective = gate.effectiveFor(scope);
    return out;
  });

  router.put('/api/network', async (rc) => {
    rc.requireOwner('Die Netz-Einstellung');
    const gate = gateOf(rc);
    const body = asObject(await rc.body());

    const patch = { network: {} };
    let mode = null;
    if (body.mode !== undefined) {
      mode = requireString(body.mode, 'mode', { max: 20 });
      if (!configMod.NETWORK_MODES.includes(mode)) {
        throw new ValidationError(`Unbekannter Netzmodus "${mode}". Erlaubt: ${configMod.NETWORK_MODES.join(', ')}.`);
      }
      patch.network.mode = mode;
    }
    if (body.strictAllowlist !== undefined) {
      if (typeof body.strictAllowlist !== 'boolean') throw new ValidationError('"strictAllowlist" muss true oder false sein.');
      patch.network.strictAllowlist = body.strictAllowlist;
    }
    if (body.allowHosts !== undefined) {
      patch.network.allowHosts = requireStringArray(body.allowHosts, 'allowHosts', { maxItems: 200, max: 255 });
    }
    if (body.blockHosts !== undefined) {
      patch.network.blockHosts = requireStringArray(body.blockHosts, 'blockHosts', { maxItems: 200, max: 255 });
    }
    if (!Object.keys(patch.network).length) throw new ValidationError('Es wurde keine Änderung übergeben.');

    const applied = applyConfig(rc, patch);
    // `saveConfig` already tells the gate about a mode change; without it we
    // must, or the running process would keep the old policy.
    if (mode && typeof rc.ctx.saveConfig !== 'function' && typeof gate.setMode === 'function') gate.setMode(mode);
    if (rc.ctx.audit && typeof rc.ctx.audit.write === 'function') {
      rc.ctx.audit.write('network.policy', { ...patch.network, via: 'http' });
    }
    return { ...snapshot(rc, gate), persisted: applied.persisted };
  });

  router.post('/api/network/grants', async (rc) => {
    rc.requireOwner('Eine Netz-Freigabe');
    const gate = needMethod(rc.ctx.gate, 'addGrant', 'Die Netz-Schleuse');
    const body = asObject(await rc.body());

    const scope = requireString(body.scope, 'scope', { max: 120 });
    const level = optionalString(body.level, 'level', { max: 20 }) || 'online';
    if (!LEVELS.has(level)) throw new ValidationError(`"level" muss lan oder online sein (empfangen: ${level}).`);
    const hosts = body.hosts === undefined ? [] : requireStringArray(body.hosts, 'hosts', { maxItems: 100, max: 255 });
    if (!hosts.length) {
      throw new ValidationError('Eine Freigabe ohne Hosts erlaubt nichts. Trage mindestens einen Host ein, oder "*" für alle.');
    }
    const expiresAt = body.expiresAt === undefined || body.expiresAt === null
      ? null
      : requireString(body.expiresAt, 'expiresAt', { max: 40 });
    if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) {
      throw new ValidationError('"expiresAt" muss ein ISO-Zeitstempel sein.');
    }
    let maxUses = null;
    if (body.maxUses !== undefined && body.maxUses !== null) {
      maxUses = Number(body.maxUses);
      if (!Number.isInteger(maxUses) || maxUses < 1) throw new ValidationError('"maxUses" muss eine ganze Zahl ab 1 sein.');
    }

    const record = gate.addGrant({
      scope,
      level,
      hosts,
      expiresAt,
      maxUses,
      reason: optionalString(body.reason, 'reason', { max: 500 }) || '',
    });
    return { record };
  });

  router.delete('/api/network/grants/:id', (rc) => {
    rc.requireOwner('Eine Netz-Freigabe');
    const gate = needMethod(rc.ctx.gate, 'revokeGrant', 'Die Netz-Schleuse');
    return { record: gate.revokeGrant(rc.params.id) };
  });

  router.get('/api/network/audit', (rc) => {
    rc.requireOwner('Das Netz-Protokoll');
    const audit = need(rc.ctx.audit, 'Das Protokoll');
    const limit = intParam(rc.query, 'limit', 200, 1, 2000);
    const all = boolParam(rc.query, 'all', false);

    let entries = [];
    if (typeof audit.readTail === 'function') {
      try {
        entries = audit.readTail(all ? limit : limit * 4);
      } catch (err) {
        // A missing or unreadable file must not hide the entries this process
        // still holds in memory.
        rc.log.warn(`Protokolldatei nicht lesbar: ${err && err.message}`);
      }
    }
    if (!entries.length && typeof audit.tail === 'function') entries = audit.tail(limit);
    const items = all ? entries : entries.filter((entry) => typeof entry.kind === 'string' && entry.kind.startsWith('network.'));
    return { items: items.slice(0, limit), total: items.length, filtered: !all };
  });

  router.post('/api/network/test', async (rc) => {
    rc.requireOwner('Die Netz-Prüfung');
    const gate = gateOf(rc);
    const body = asObject(await rc.body());
    const host = requireString(body.host, 'host', { max: 255 });
    let port = null;
    if (body.port !== undefined && body.port !== null && body.port !== '') {
      port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ValidationError('"port" muss eine ganze Zahl zwischen 1 und 65535 sein.');
      }
    }
    const scope = optionalString(body.scope, 'scope', { max: 120 }) || 'global';

    // `record:false` keeps a what-if question out of the egress statistics.
    // Nothing is connected and no name is resolved: this is policy only.
    const decision = gate.check({ host, port, scope, purpose: 'Prüfung in der Oberfläche', record: false });
    return {
      decision,
      classification: typeof gate.classify === 'function' ? gate.classify(host) : null,
      connected: false,
      note: 'Es wurde keine Verbindung aufgebaut und kein Name aufgelöst; dies ist ausschließlich die Entscheidung der Schleuse.',
    };
  });

  // Convenience for the panel: which policy applies to one scope chain.
  router.get('/api/network/scope/:scope', (rc) => {
    rc.requireCapability('read');
    const gate = needMethod(rc.ctx.gate, 'effectiveFor', 'Die Netz-Schleuse');
    const scope = rc.params.scope;
    if (!scope) throw new NotFoundError('Geltungsbereich');
    return gate.effectiveFor(scope);
  });
}

module.exports = { register };
