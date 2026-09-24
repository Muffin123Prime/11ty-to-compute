'use strict';

const crypto = require('node:crypto');

const merge = require('./merge');
const {
  NeuralError,
  ValidationError,
  NotFoundError,
  PermissionError,
  AuthError,
  AbortedError,
  asNeuralError,
} = require('../kernel/errors');

/**
 * Device synchronisation: fetching from a partner, sending to a partner, and
 * writing the result into the vault without ever losing an edit.
 *
 * The one rule everything here is built around
 * --------------------------------------------
 * A synchronisation that silently picks a winner is how people lose work and
 * only notice weeks later. So: when both devices changed the same record, the
 * local record is not touched at all. A `conflict` record is written that
 * carries BOTH versions in full, and the user decides. `merge.js` holds the
 * decision logic and is pure; this file is everything with a side effect.
 *
 * Atomicity
 * ---------
 * A pull downloads every page first and then writes the whole batch inside one
 * `store.transaction()`. The store rolls a failed transaction back in memory
 * *and* writes nothing to the log, so an abort halfway through leaves the
 * vault exactly as it was -- not half-merged. A push cannot have that
 * property (the partner has already accepted what it accepted), so it commits
 * its bookkeeping after every batch, which leaves a consistent, resumable
 * state rather than an atomic one. That difference is real and is reported.
 *
 * Network
 * -------
 * Every request goes through `gate.fetch` with the scope `sync:<peerId>` and,
 * by default, `maxLevel:'lan'`. A partner on the public internet is a
 * deliberate decision: the peer record has to carry `maxLevel:'online'` AND
 * the gate's own policy has to permit it (a grant for `sync:<peerId>`, or
 * global online mode). Nothing here can widen that on its own.
 */

/** Wire protocol version. Bumped when the shape of /api/sync/* changes. */
const SYNC_PROTOCOL = 1;

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
/** Guard against a partner that never advances its cursor. */
const MAX_PAGES = 200;
const DEFAULT_MAX_RECORDS = 20000;
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * The watermark is a wall-clock millisecond value, so a partner whose clock
 * steps backwards could hide edits behind it. Asking for a minute more than we
 * need costs one page and closes that hole; the merge is idempotent, so
 * re-seeing a record is free.
 */
const WATERMARK_SAFETY_MS = 60 * 1000;

/** Above this the base table is no longer a sensible thing to keep in one record. */
const MAX_BASES = 50000;

const DIRECTIONS = ['pull', 'push', 'both'];
const MAX_LEVELS = ['lan', 'online'];

function nowIso() {
  return new Date().toISOString();
}

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

function assertNotAborted(signal, what) {
  if (signal && signal.aborted) {
    throw new AbortedError(`${what} wurde abgebrochen. Es wurde nichts geändert.`);
  }
}

/**
 * @param {string} raw
 * @returns {{url:string, host:string, port:number|null}}
 */
function normalisePeerUrl(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) throw new ValidationError('Ein Partnergerät braucht eine Adresse, z. B. http://192.168.1.20:7777');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new ValidationError(`"${text.slice(0, 120)}" ist keine gültige Adresse. Erwartet wird z. B. http://192.168.1.20:7777`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`Nur http und https sind als Partneradresse erlaubt, nicht "${parsed.protocol}".`);
  }
  if (!parsed.hostname) throw new ValidationError('Der Partneradresse fehlt der Rechnername.');
  if (parsed.username || parsed.password) {
    // Credentials in the URL would end up in the audit log and in every error
    // message. The token field is where they belong.
    throw new ValidationError('Die Partneradresse darf keinen Benutzernamen und kein Passwort enthalten; dafür gibt es das Token.');
  }
  const base = `${parsed.protocol}//${parsed.host}`;
  return { url: base, host: parsed.hostname, port: parsed.port ? Number(parsed.port) : null };
}

/** Records the UI and the partner may see; the token never leaves this module. */
function sanitisePeer(record, extra = {}) {
  const d = (record && record.data) || {};
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    name: d.name || '',
    url: d.url || '',
    direction: d.direction || 'both',
    maxLevel: d.maxLevel === 'online' ? 'online' : 'lan',
    hasToken: typeof d.token === 'string' && d.token.length > 0,
    lastSyncAt: d.lastSyncAt || null,
    lastError: d.lastError || null,
    watermark: Number(d.watermark) || 0,
    enabled: d.enabled !== false,
    autoSync: d.autoSync === true,
    remoteDeviceId: d.remoteDeviceId || null,
    knownRecords: Object.keys(d.bases || {}).length,
    ...extra,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.store   record store (required)
 * @param {object} [deps.gate]  egress gate; without it nothing may leave the device
 * @param {object} [deps.config]
 * @param {object} [deps.bus]
 * @param {Function|object} [deps.logger]
 * @param {object} [deps.auth]  token administration; used to report whether a partner
 *   can reach this device at all. May be attached later via setAuth().
 * @param {object} [deps.paths] used to persist the generated device id
 * @param {{id:string}} [deps.identitaet] die Identität dieser KI (src/kernel/identitaet.js).
 *   Die Kennung wird bei jedem Vorgang frisch von dort gelesen: erneuert sich
 *   die KI (kopierter Datenordner, Zwilling), trägt schon der nächste Abgleich
 *   die neue. Ohne sie (Tests) legt der Abgleich wie bisher selbst eine an.
 */
function createSync(deps = {}) {
  const store = deps.store;
  if (!store || typeof store.create !== 'function' || typeof store.list !== 'function') {
    throw new ValidationError('createSync benötigt einen Store.');
  }
  const gate = deps.gate || null;
  const config = deps.config && typeof deps.config === 'object' ? deps.config : {};
  const bus = deps.bus || null;
  const paths = deps.paths || null;
  const log = typeof deps.logger === 'function' ? deps.logger('sync') : (deps.logger || nullLogger());
  let auth = deps.auth || null;

  const appVersion = safeAppVersion();
  const identitaet = deps.identitaet && typeof deps.identitaet === 'object' ? deps.identitaet : null;
  const eigeneKennung = identitaet ? null : ensureDeviceId();

  /** Die Kennung dieses Geräts, für genau diesen Vorgang. */
  function deviceIdJetzt() {
    return identitaet ? identitaet.id : eigeneKennung;
  }

  /** Peers a pull/push is currently running for, so two clicks cannot race. */
  const busy = new Set();

  function safeAppVersion() {
    try {
      return require('../../package.json').version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * A stable identifier for THIS installation. It is not a secret and not an
   * account: its only jobs are to stop a device from synchronising with itself
   * (which would duplicate every record) and to let the receiving side find
   * the peer record that holds the agreed state for the sender.
   */
  function ensureDeviceId() {
    if (!config.sync || typeof config.sync !== 'object') config.sync = {};
    const existing = config.sync.deviceId;
    if (typeof existing === 'string' && /^dev_[0-9a-f]{24}$/.test(existing)) return existing;
    const created = `dev_${crypto.randomBytes(12).toString('hex')}`;
    config.sync.deviceId = created;
    if (paths && paths.config) {
      try {
        require('../kernel/config').save(paths.config, config);
      } catch (err) {
        // A device id that does not survive a restart makes the self-sync
        // guard weaker, but it is not a reason to refuse to run. Say so.
        log.warn(`Die Geräte-Kennung konnte nicht gespeichert werden (${err && err.message}); sie gilt nur für diesen Prozess.`);
      }
    }
    return created;
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`Bus-Ereignis ${name} fehlgeschlagen: ${err && err.message}`);
    }
  }

  /* ------------------------------------------------------------- peers */

  function peerRecord(id) {
    const record = store.get(id);
    if (!record || record.type !== 'peer') throw new NotFoundError(`Partnergerät ${id}`);
    return record;
  }

  function allPeers() {
    return store.list('peer', { sort: 'createdAt', order: 'asc' }).items;
  }

  function openConflictCount(peerId) {
    return store.list('conflict', {
      filter: (r) => r.data.status === 'open' && (!peerId || r.data.peerId === peerId),
    }).total;
  }

  function listPeers() {
    return allPeers().map((r) => sanitisePeer(r, { openConflicts: openConflictCount(r.id) }));
  }

  function getPeer(id) {
    const record = peerRecord(id);
    return sanitisePeer(record, { openConflicts: openConflictCount(record.id) });
  }

  function readPeerInput(input, { partial = false } = {}) {
    const data = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key);

    if (has('name') || !partial) {
      const name = String(input.name === undefined || input.name === null ? '' : input.name).trim();
      if (!name) throw new ValidationError('Das Partnergerät braucht einen Namen.');
      if (name.length > 200) throw new ValidationError('Der Name des Partnergeräts ist zu lang (max. 200 Zeichen).');
      data.name = name;
    }
    if (has('url') || !partial) {
      data.url = normalisePeerUrl(input.url).url;
    }
    if (has('token')) {
      const token = String(input.token === undefined || input.token === null ? '' : input.token).trim();
      if (token.length > 4096) throw new ValidationError('Das Token des Partnergeräts ist zu lang.');
      data.token = token;
    } else if (!partial) {
      data.token = '';
    }
    if (has('direction')) {
      if (!DIRECTIONS.includes(input.direction)) {
        throw new ValidationError(`Die Richtung muss eine von ${DIRECTIONS.join(', ')} sein.`);
      }
      data.direction = input.direction;
    }
    if (has('maxLevel')) {
      if (!MAX_LEVELS.includes(input.maxLevel)) {
        throw new ValidationError(`maxLevel muss "lan" oder "online" sein (empfangen: ${String(input.maxLevel).slice(0, 40)}).`);
      }
      data.maxLevel = input.maxLevel;
    }
    if (has('enabled')) data.enabled = input.enabled === true;
    if (has('autoSync')) data.autoSync = input.autoSync === true;
    return data;
  }

  function createPeer(input = {}) {
    const data = readPeerInput(input, { partial: false });
    if (!data.maxLevel) data.maxLevel = 'lan';
    const record = store.create('peer', { ...data, watermark: 0, bases: {}, pushWatermark: 0 });
    log.info(`Partnergerät "${data.name}" angelegt (${record.id}).`);
    publish('sync.peer', { action: 'created', peerId: record.id, name: data.name });
    return sanitisePeer(record, { openConflicts: 0 });
  }

  function updatePeer(id, patch = {}) {
    const existing = peerRecord(id);
    const data = readPeerInput(patch, { partial: true });
    if (!Object.keys(data).length) throw new ValidationError('Es wurden keine Felder zum Ändern übergeben.');
    // A new address or a new token means the agreed state no longer describes
    // the same partner. Keeping the old base table would make us believe we
    // already agreed with a device we have never spoken to.
    if ((data.url && data.url !== existing.data.url) || (data.token !== undefined && data.token !== existing.data.token)) {
      data.bases = {};
      data.watermark = 0;
      data.pushWatermark = 0;
      data.remoteDeviceId = null;
    }
    const updated = store.update(id, data);
    publish('sync.peer', { action: 'updated', peerId: id });
    return sanitisePeer(updated, { openConflicts: openConflictCount(id) });
  }

  function removePeer(id) {
    const existing = peerRecord(id);
    const removed = store.remove(existing.id);
    publish('sync.peer', { action: 'removed', peerId: id });
    return sanitisePeer(removed);
  }

  /* --------------------------------------------------------- base table */

  function basesOf(peer) {
    const raw = peer && peer.data && peer.data.bases;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  /**
   * Fold the fingerprints a merge agreed on back into the peer record.
   * Written in the same transaction as the records themselves, so the vault
   * can never hold data whose agreed state was not recorded (which would turn
   * the next sync into an avalanche of false conflicts).
   */
  function mergeBases(peerId, updates) {
    if (!peerId || !updates || !Object.keys(updates).length) return null;
    const peer = store.get(peerId);
    if (!peer || peer.type !== 'peer') return null;
    const bases = { ...basesOf(peer) };
    for (const [id, entry] of Object.entries(updates)) {
      if (entry === null) delete bases[id];
      else bases[id] = entry;
    }
    if (Object.keys(bases).length > MAX_BASES) {
      log.warn(`Die Abgleich-Tabelle für ${peerId} hat ${Object.keys(bases).length} Einträge überschritten; `
        + 'ab dieser Größe gehört der Zustand nicht mehr in einen einzelnen Datensatz.');
    }
    return store.update(peerId, { bases });
  }

  /* ------------------------------------------------------ applying a plan */

  function liveEndpointMissing(record) {
    const { from, to } = record.data || {};
    if (!store.get(from)) return from;
    if (!store.get(to)) return to;
    return null;
  }

  function duplicateEdgeId(record) {
    const { from, to, kind } = record.data || {};
    if (!from || !to) return null;
    let existing = [];
    try {
      existing = store.edges.between(from, to);
    } catch {
      return null;
    }
    const twin = existing.find((e) => e.data.kind === kind);
    return twin && twin.id !== record.id ? twin.id : null;
  }

  /** Content patch for an update. Edge endpoints are immutable in the store. */
  function patchFor(record) {
    const data = { ...(record.data || {}) };
    if (record.type === 'edge') {
      delete data.from;
      delete data.to;
      delete data.kind;
    }
    return data;
  }

  function applyOne(entry) {
    const remote = entry.record;
    const { action } = entry;

    if (remote.type === 'edge') {
      if (action === 'update' || action === 'restore') {
        // from/to/kind are the edge's identity and are indexed; the store
        // refuses to change them. Applying only the remaining fields would
        // leave a link that claims to be in sync while pointing somewhere
        // else, so the whole record is left alone and the difference named.
        const local = store.get(remote.id, { includeDeleted: true });
        const moved = local && ['from', 'to', 'kind'].filter((k) => local.data[k] !== remote.data[k]);
        if (moved && moved.length) {
          return {
            status: 'skipped',
            reason: 'edge-identity-changed',
            detail: `Die Verknüpfung zeigt beim Partner woanders hin (${moved.join(', ')}). `
              + 'Endpunkte einer Verknüpfung lassen sich nicht ändern; lösche sie und lege sie neu an.',
          };
        }
      }
      if (action === 'create' || action === 'restore') {
        const missing = liveEndpointMissing(remote);
        if (missing) {
          return { status: 'skipped', reason: 'endpoint-missing', detail: `Der verknüpfte Eintrag ${missing} ist hier nicht vorhanden.` };
        }
        if (remote.data.from === remote.data.to) {
          return { status: 'skipped', reason: 'self-edge', detail: 'Eine Verknüpfung darf nicht auf ihren eigenen Knoten zeigen.' };
        }
      }
      if (action === 'create') {
        const twin = duplicateEdgeId(remote);
        if (twin) {
          return {
            status: 'skipped',
            reason: 'duplicate',
            note: 'duplicate',
            detail: `Dieselbe Verknüpfung existiert hier bereits als ${twin}.`,
          };
        }
      }
    }

    if (remote.type === 'file' && (action === 'create' || action === 'restore' || action === 'update')) {
      const hash = remote.data && remote.data.hash;
      // Blobs live in vault/files and are NOT part of the change feed yet.
      // Writing the record anyway would produce an entry that looks like a
      // file and throws NotFoundError the moment anyone opens it -- exactly
      // the kind of plausible-looking nothing this project refuses to ship.
      if (typeof hash === 'string' && hash && !store.files.has(hash)) {
        return {
          status: 'skipped',
          reason: 'blob-missing',
          note: 'blob-missing',
          detail: merge.WITHHELD_DETAIL['blob-missing'],
        };
      }
    }

    switch (action) {
      case 'create': {
        const created = store.create(remote.type, remote.data, { id: remote.id });
        return { status: 'applied', action, rev: created.rev, result: created };
      }
      case 'update': {
        const patch = patchFor(remote);
        const updated = Object.keys(patch).length ? store.update(remote.id, patch) : store.get(remote.id);
        return { status: 'applied', action, rev: updated.rev, result: updated };
      }
      case 'restore': {
        store.restore(remote.id);
        const patch = patchFor(remote);
        const updated = Object.keys(patch).length ? store.update(remote.id, patch) : store.get(remote.id);
        return { status: 'applied', action, rev: updated.rev, result: updated };
      }
      case 'delete': {
        const removed = store.remove(remote.id);
        return { status: 'applied', action, rev: removed.rev, result: removed };
      }
      default:
        return { status: 'skipped', reason: 'no-op', detail: 'Es gab nichts zu tun.' };
    }
  }

  function upsertConflict(peerId, conflict) {
    const open = store.list('conflict', {
      filter: (r) => r.data.recordId === conflict.recordId
        && r.data.status === 'open'
        && (r.data.peerId || null) === (peerId || null),
    }).items;

    const payload = {
      recordId: conflict.recordId,
      recordType: conflict.recordType,
      peerId: peerId || null,
      local: conflict.local || { absent: true },
      remote: conflict.remote,
      status: 'open',
      resolution: null,
      resolvedAt: null,
      reason: conflict.reason || '',
    };
    if (open.length) return store.update(open[0].id, payload);
    return store.create('conflict', payload);
  }

  /**
   * Carry out a plan. MUST run inside `store.transaction()`: the caller owns
   * the transaction so that an abort rolls back records, conflicts and the
   * base table together.
   *
   * @returns {{results:Array, bases:object, applied:number, conflicts:number, skipped:number}}
   */
  function applyPlan(planned, opts = {}) {
    const peerId = opts.peerId || null;
    const signal = opts.signal || null;
    const results = [];
    const bases = {};
    let applied = 0;
    let skipped = 0;

    for (const entry of planned.identical) {
      bases[entry.id] = { h: entry.hash, at: nowIso() };
      results.push({ id: entry.id, type: entry.type, status: 'identical' });
    }

    for (const entry of planned.apply) {
      assertNotAborted(signal, 'Der Abgleich');
      let outcome;
      try {
        outcome = applyOne(entry);
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        const neural = asNeuralError(err);
        outcome = { status: 'rejected', reason: neural.code, detail: neural.message };
      }
      if (outcome.status === 'applied') {
        applied++;
        // `store.update` merges a patch, it does not replace the payload, so a
        // key the partner DROPPED (rather than emptied) survives here. The
        // agreed base stays the partner's fingerprint either way: our record
        // is then the strict successor and the next push carries it over,
        // which converges without a conflict. Anything left over is named
        // rather than quietly ignored.
        bases[entry.id] = { h: entry.hash, at: nowIso() };
        const row = { id: entry.id, type: entry.type, status: 'applied', action: outcome.action, rev: outcome.rev };
        if (outcome.result && merge.fingerprint(outcome.result) !== entry.hash) {
          row.drift = 'Der Eintrag wurde übernommen, weicht aber noch in einem Zusatzfeld ab; '
            + 'der nächste Abgleich gleicht das aus.';
        }
        results.push(row);
      } else {
        skipped++;
        if (outcome.note) bases[entry.id] = { h: entry.hash, at: nowIso(), note: outcome.note };
        results.push({ id: entry.id, type: entry.type, status: outcome.status, reason: outcome.reason, detail: outcome.detail });
      }
    }

    for (const entry of planned.skip) {
      skipped++;
      results.push({ id: entry.id, type: entry.type, status: 'skipped', reason: entry.reason, detail: entry.detail });
    }

    for (const conflict of planned.conflicts) {
      assertNotAborted(signal, 'Der Abgleich');
      // The local record is deliberately NOT touched here. This is the exact
      // point where a synchronisation either keeps the user's work or eats it.
      const record = opts.recordConflicts === false ? null : upsertConflict(peerId, conflict);
      results.push({
        id: conflict.recordId,
        type: conflict.recordType,
        status: 'conflict',
        conflictId: record ? record.id : null,
        detail: conflict.reason,
        current: conflict.local || null,
      });
    }

    return { results, bases, applied, skipped, conflicts: planned.conflicts.length };
  }

  /* -------------------------------------------------- serving a partner */

  function recordCount() {
    let n = 0;
    for (const type of merge.SYNC_TYPES) n += store.count(type);
    return n;
  }

  /** Answer for `GET /api/sync/info`. */
  function info() {
    return {
      version: SYNC_PROTOCOL,
      appVersion,
      deviceId: deviceIdJetzt(),
      recordCount: recordCount(),
      now: nowIso(),
      types: [...merge.SYNC_TYPES],
    };
  }

  /**
   * Answer for `GET /api/sync/changes`. Tombstones are included: a deletion is
   * a change like any other and a partner that never hears about it would
   * re-create the record on the next push.
   */
  function changesSince(since = 0, limit = DEFAULT_PAGE_SIZE) {
    const from = Number.isFinite(since) && since > 0 ? Math.trunc(since) : 0;
    const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_PAGE_SIZE));

    const matching = [];
    for (const type of merge.SYNC_TYPES) {
      for (const record of store.list(type, { includeDeleted: true }).items) {
        const at = Date.parse(record.updatedAt);
        if (!Number.isFinite(at) || at < from) continue;
        matching.push({ at, record });
      }
    }
    matching.sort((a, b) => (a.at === b.at ? (a.record.id < b.record.id ? -1 : 1) : a.at - b.at));

    const page = matching.slice(0, size);
    const hasMore = matching.length > size;
    const cursor = page.length ? page[page.length - 1].at : from;
    return { records: page.map((e) => e.record), cursor, hasMore, total: matching.length, now: nowIso() };
  }

  /**
   * Answer for `POST /api/sync/apply`: a partner sends records, we merge them
   * the same way a pull does.
   *
   * The partner may declare, per record, the fingerprint the two devices last
   * agreed on. We prefer our OWN recorded base whenever we have one and fall
   * back to the declared one only for records we have no history for -- so a
   * partner cannot talk us out of a conflict for a record we know about.
   */
  function applyIncoming(payload = {}) {
    const records = Array.isArray(payload.records) ? payload.records : null;
    if (!records) throw new ValidationError('Der Abgleich erwartet eine Liste "records".');
    if (records.length > MAX_PAGE_SIZE) {
      throw new ValidationError(`Es werden höchstens ${MAX_PAGE_SIZE} Datensätze pro Anfrage angenommen (empfangen: ${records.length}).`);
    }
    const senderDeviceId = typeof payload.deviceId === 'string' ? payload.deviceId : null;
    if (senderDeviceId && senderDeviceId === deviceIdJetzt()) {
      throw new ValidationError(
        'Der Absender meldet dieselbe Geräte-Kennung wie dieses Gerät. Das wäre ein Abgleich mit sich selbst und '
        + 'würde jeden Eintrag verdoppeln.',
      );
    }

    const peer = senderDeviceId
      ? allPeers().find((p) => p.data.remoteDeviceId === senderDeviceId) || null
      : null;

    const declared = payload.bases && typeof payload.bases === 'object' && !Array.isArray(payload.bases)
      ? payload.bases
      : {};
    const own = peer ? basesOf(peer) : {};
    const bases = { ...declared, ...own };

    const locals = new Map();
    for (const remote of records) {
      if (!remote || typeof remote.id !== 'string') continue;
      const local = store.get(remote.id, { includeDeleted: true });
      if (local) locals.set(local.id, local);
    }

    const planned = merge.plan(locals, records, { bases });
    const outcome = store.transaction(() => {
      const applied = applyPlan(planned, { peerId: peer ? peer.id : null });
      if (peer) {
        mergeBases(peer.id, applied.bases);
        store.update(peer.id, { lastSyncAt: nowIso() });
      }
      return applied;
    });

    if (outcome.conflicts) {
      publish('sync.conflict', { peerId: peer ? peer.id : null, count: outcome.conflicts, direction: 'incoming' });
    }
    publish('sync.applied', {
      peerId: peer ? peer.id : null,
      direction: 'incoming',
      applied: outcome.applied,
      conflicts: outcome.conflicts,
      skipped: outcome.skipped,
    });

    return {
      accepted: outcome.applied,
      conflicts: outcome.conflicts,
      skipped: outcome.skipped,
      results: outcome.results,
      warnings: planned.warnings,
    };
  }

  /* ------------------------------------------------------------ conflicts */

  function sanitiseConflict(record) {
    const d = record.data || {};
    return {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      recordId: d.recordId,
      recordType: d.recordType,
      peerId: d.peerId || null,
      local: d.local || null,
      remote: d.remote || null,
      status: d.status || 'open',
      resolution: d.resolution || null,
      resolvedAt: d.resolvedAt || null,
      reason: d.reason || '',
    };
  }

  function listConflicts(opts = {}) {
    const status = opts.status === 'resolved' ? 'resolved' : opts.status === 'all' ? null : 'open';
    const result = store.list('conflict', {
      filter: (r) => (!status || r.data.status === status) && (!opts.peerId || r.data.peerId === opts.peerId),
      sort: 'createdAt',
      order: 'desc',
      limit: Number.isInteger(opts.limit) ? opts.limit : 200,
    });
    return { items: result.items.map(sanitiseConflict), total: result.total };
  }

  /**
   * Resolve a conflict. No network: resolving decides what THIS device holds
   * and what fingerprint counts as agreed from now on. The next sync carries
   * the decision to the partner -- choosing 'local' records the partner's
   * version as the agreed base, so the partner sees our record as the genuine
   * successor and accepts it without a second conflict.
   */
  function resolveConflict(id, resolution) {
    if (resolution !== 'local' && resolution !== 'remote') {
      throw new ValidationError('Die Auflösung muss "local" oder "remote" sein.');
    }
    const record = store.get(id);
    if (!record || record.type !== 'conflict') throw new NotFoundError(`Konflikt ${id}`);
    if (record.data.status === 'resolved') {
      throw new ValidationError('Dieser Konflikt wurde bereits entschieden.');
    }
    const remote = record.data.remote;
    if (!remote || typeof remote.id !== 'string') {
      throw new ValidationError('Der Konflikt enthält keine vollständige Fassung des Partners und kann nicht aufgelöst werden.');
    }
    const peerId = record.data.peerId || null;

    const applied = store.transaction(() => {
      let result = null;
      if (resolution === 'remote') {
        const local = store.get(remote.id, { includeDeleted: true });
        const action = merge.actionFor(local, remote);
        result = applyOne({ record: remote, action, id: remote.id, type: remote.type });
        if (result.status !== 'applied' && result.status !== 'skipped') {
          throw new NeuralError('SYNC_APPLY_FAILED', result.detail || 'Die Fassung des Partners konnte nicht übernommen werden.', { status: 500 });
        }
      }
      // Either way the partner's version is now the agreed common ancestor:
      // after 'remote' because we hold it, after 'local' because we know
      // exactly what the partner holds and ours is its successor.
      if (peerId) mergeBases(peerId, { [remote.id]: { h: merge.fingerprint(remote), at: nowIso() } });
      store.update(id, { status: 'resolved', resolution, resolvedAt: nowIso() });
      return result;
    });

    publish('sync.conflict', { action: 'resolved', conflictId: id, peerId, resolution });
    log.info(`Konflikt ${id} entschieden: ${resolution === 'local' ? 'lokale Fassung behalten' : 'Fassung des Partners übernommen'}.`);
    return { conflict: sanitiseConflict(store.get(id)), applied: applied ? applied.status : 'kept-local' };
  }

  /* ------------------------------------------------------------- transport */

  function peerScope(peer) {
    return `sync:${peer.id}`;
  }

  function blockedHint(peer, err) {
    return new NeuralError(
      'NETWORK_BLOCKED',
      `${err.message} Der Abgleich mit "${peer.data.name}" braucht entweder den Netzmodus "lan" oder eine Freigabe `
      + `für den Geltungsbereich ${peerScope(peer)}.`,
      { status: 403, details: { peerId: peer.id, scope: peerScope(peer), url: peer.data.url } },
    );
  }

  async function callPeer(peer, pathAndQuery, opts = {}) {
    if (!gate || typeof gate.fetch !== 'function') {
      throw new NeuralError(
        'SUBSYSTEM_UNAVAILABLE',
        'Die Netzschleuse ist in dieser Instanz nicht verfügbar. Ohne sie wird nichts an ein anderes Gerät geschickt.',
        { status: 503 },
      );
    }
    const target = `${peer.data.url}${pathAndQuery}`;
    const headers = {
      accept: 'application/json',
      // The partner is a Neural OS server and enforces the same CSRF rule as
      // the browser does; a mutating request without this header is refused.
      'x-neural-os': '1',
    };
    if (peer.data.token) headers.authorization = `Bearer ${peer.data.token}`;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await gate.fetch(target, {
        method: opts.method || 'GET',
        headers,
        body,
        scope: peerScope(peer),
        purpose: opts.purpose || 'sync',
        maxLevel: peer.data.maxLevel === 'online' ? 'online' : 'lan',
        allowedHosts: [normalisePeerUrl(peer.data.url).host],
        timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
        signal: opts.signal,
      });
    } catch (err) {
      const neural = asNeuralError(err);
      if (neural.code === 'NETWORK_BLOCKED') throw blockedHint(peer, neural);
      throw neural;
    }

    if (!response.ok) {
      let detail = '';
      let code = null;
      try {
        const parsed = JSON.parse(await response.text());
        if (parsed && parsed.error) {
          code = parsed.error.code || null;
          detail = parsed.error.message || '';
        }
      } catch {
        /* a partner that does not answer JSON still gets a useful message */
      }
      if (response.status === 401) {
        throw new AuthError(
          `"${peer.data.name}" hat das hinterlegte Token abgelehnt${detail ? `: ${detail}` : '.'} `
          + 'Lege auf dem Partnergerät ein Token mit dem Recht "sync" an und trage es hier ein.',
        );
      }
      if (response.status === 403) {
        throw new PermissionError(
          `"${peer.data.name}" verweigert den Abgleich${detail ? `: ${detail}` : '.'}`,
          { peerId: peer.id, code },
        );
      }
      if (response.status === 404) {
        throw new NotFoundError(
          `Die Abgleich-Schnittstelle von "${peer.data.name}" (${target}). Läuft dort eine Version mit Geräte-Abgleich?`,
        );
      }
      throw new NeuralError(
        'SYNC_PEER_ERROR',
        `"${peer.data.name}" antwortete mit HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
        { status: 502, details: { peerId: peer.id, status: response.status, code } },
      );
    }

    try {
      return await response.json();
    } catch (err) {
      throw new NeuralError(
        'SYNC_PEER_ERROR',
        `Die Antwort von "${peer.data.name}" war kein gültiges JSON: ${asNeuralError(err).message}`,
        { status: 502, details: { peerId: peer.id } },
      );
    }
  }

  function noteFailure(peerId, err) {
    const neural = asNeuralError(err);
    try {
      store.update(peerId, { lastError: neural.message, lastErrorAt: nowIso() });
    } catch (nested) {
      log.warn(`lastError für ${peerId} konnte nicht gespeichert werden: ${nested && nested.message}`);
    }
    publish('sync.failed', { peerId, code: neural.code, message: neural.message });
    log.warn(`Abgleich mit ${peerId} fehlgeschlagen: ${neural.message}`);
    return neural;
  }

  function noteSuccess(peerId, patch = {}) {
    try {
      store.update(peerId, { lastSyncAt: nowIso(), lastError: null, ...patch });
    } catch (err) {
      log.warn(`Abgleich-Zeitstempel für ${peerId} konnte nicht gespeichert werden: ${err && err.message}`);
    }
  }

  /**
   * Round-trip the partner's `/api/sync/info` and measure the clock difference.
   * The measurement brackets the request, so the network latency is halved out
   * instead of being charged to the partner's clock.
   */
  async function fetchInfo(peer, opts = {}) {
    const started = Date.now();
    const remote = await callPeer(peer, '/api/sync/info', { purpose: 'sync.info', signal: opts.signal, timeoutMs: opts.timeoutMs });
    const finished = Date.now();
    const remoteNow = Date.parse(remote && remote.now);
    const clockSkewMs = Number.isFinite(remoteNow) ? Math.round(remoteNow - (started + finished) / 2) : null;
    if (remote && remote.deviceId && remote.deviceId === deviceIdJetzt()) {
      throw new ValidationError(
        `"${peer.data.name}" meldet dieselbe Geräte-Kennung wie dieses Gerät. Ein Gerät kann sich nicht mit sich `
        + 'selbst abgleichen; prüfe die Adresse.',
      );
    }
    return { remote, clockSkewMs, roundTripMs: finished - started };
  }

  /** Remember which device answers at this address, so incoming pushes match up. */
  function rememberRemoteDevice(peer, remote) {
    const id = remote && typeof remote.deviceId === 'string' ? remote.deviceId : null;
    if (!id || peer.data.remoteDeviceId === id) return;
    try {
      store.update(peer.id, { remoteDeviceId: id });
    } catch (err) {
      log.warn(`Geräte-Kennung des Partners konnte nicht gespeichert werden: ${err && err.message}`);
    }
  }

  function warnAboutSkew(peer, clockSkewMs) {
    if (clockSkewMs === null || Math.abs(clockSkewMs) <= merge.DEFAULT_SKEW_TOLERANCE_MS) return null;
    const message = `Die Uhr von "${peer.data.name}" weicht um ${Math.round(Math.abs(clockSkewMs) / 1000)} Sekunden `
      + 'von dieser ab. Zeitstempel sind damit als Entscheidungsgrundlage unbrauchbar; eingehende Löschungen werden '
      + 'deshalb als Konflikt vorgelegt statt ausgeführt.';
    log.warn(message);
    publish('sync.warning', { peerId: peer.id, kind: 'clock-skew', clockSkewMs, message });
    return message;
  }

  function assertDirection(peer, wanted) {
    const direction = peer.data.direction || 'both';
    if (direction === 'both' || direction === wanted) return;
    throw new ValidationError(
      `"${peer.data.name}" ist auf "${direction}" eingestellt; ${wanted === 'pull' ? 'Holen' : 'Senden'} ist damit nicht vorgesehen.`,
    );
  }

  function assertEnabled(peer) {
    if (peer.data.enabled === false) {
      throw new ValidationError(`"${peer.data.name}" ist abgeschaltet. Schalte das Gerät in den Einstellungen wieder ein.`);
    }
  }

  function claim(peerId) {
    if (busy.has(peerId)) {
      throw new ValidationError('Für dieses Partnergerät läuft bereits ein Abgleich.');
    }
    busy.add(peerId);
    return () => busy.delete(peerId);
  }

  /* ----------------------------------------------------------------- test */

  /**
   * Probe a partner without changing anything. Unreachable is an answer, not
   * an exception -- but it is still written to `lastError` and published.
   */
  async function test(peerId, opts = {}) {
    const peer = peerRecord(peerId);
    try {
      const { remote, clockSkewMs, roundTripMs } = await fetchInfo(peer, { signal: opts.signal, timeoutMs: opts.timeoutMs });
      rememberRemoteDevice(peer, remote);
      const warning = warnAboutSkew(peer, clockSkewMs);
      noteSuccess(peer.id, {});
      return {
        reachable: true,
        version: remote && remote.version !== undefined ? remote.version : null,
        appVersion: (remote && remote.appVersion) || null,
        deviceId: (remote && remote.deviceId) || null,
        recordCount: Number.isFinite(remote && remote.recordCount) ? remote.recordCount : null,
        clockSkewMs,
        roundTripMs,
        warning,
        error: null,
      };
    } catch (err) {
      const neural = noteFailure(peer.id, err);
      return {
        reachable: false,
        version: null,
        appVersion: null,
        deviceId: null,
        recordCount: null,
        clockSkewMs: null,
        roundTripMs: null,
        warning: null,
        error: neural.message,
        code: neural.code,
      };
    }
  }

  /* ----------------------------------------------------------------- pull */

  async function fetchChanges(peer, since, opts) {
    const collected = [];
    const seen = new Set();
    const maxRecords = Number.isInteger(opts.maxRecords) ? opts.maxRecords : DEFAULT_MAX_RECORDS;
    const warnings = [];
    let cursor = since;
    let pages = 0;
    let truncated = false;
    let remoteNow = null;

    for (;;) {
      assertNotAborted(opts.signal, 'Der Abgleich');
      const page = await callPeer(
        peer,
        `/api/sync/changes?since=${encodeURIComponent(String(cursor))}&limit=${DEFAULT_PAGE_SIZE}`,
        { purpose: 'sync.changes', signal: opts.signal, timeoutMs: opts.timeoutMs },
      );
      pages++;
      const records = Array.isArray(page && page.records) ? page.records : [];
      if (page && page.now) remoteNow = page.now;
      for (const record of records) {
        if (!record || typeof record.id !== 'string' || seen.has(record.id)) continue;
        seen.add(record.id);
        collected.push(record);
      }
      if (collected.length >= maxRecords) {
        truncated = true;
        warnings.push(
          `Es wurden ${collected.length} Änderungen geholt; das ist die Obergrenze für einen Durchgang. `
          + 'Starte den Abgleich erneut, um den Rest zu holen.',
        );
        break;
      }
      if (!page || page.hasMore !== true) break;
      const next = Number(page.cursor);
      if (!Number.isFinite(next)) {
        warnings.push('Der Partner hat keinen brauchbaren Fortsetzungspunkt geliefert; der Abgleich bricht hier ab.');
        break;
      }
      // Many records sharing one millisecond would otherwise loop for ever.
      cursor = next > cursor ? next : cursor + 1;
      if (pages >= MAX_PAGES) {
        truncated = true;
        warnings.push(`Nach ${MAX_PAGES} Seiten wurde abgebrochen; der Partner liefert mehr, als ein Durchgang holt.`);
        break;
      }
    }

    return { records: collected, cursor, pages, truncated, warnings, remoteNow };
  }

  /**
   * Fetch a partner's changes and merge them in.
   *
   * Everything is downloaded before anything is written, and the write happens
   * in ONE transaction. An abort at any point therefore leaves the vault
   * untouched rather than half-merged.
   */
  async function pull(peerId, opts = {}) {
    const release = claim(peerId);
    try {
      const peer = peerRecord(peerId);
      assertEnabled(peer);
      assertDirection(peer, 'pull');
      assertNotAborted(opts.signal, 'Der Abgleich');

      const { remote, clockSkewMs } = await fetchInfo(peer, { signal: opts.signal, timeoutMs: opts.timeoutMs });
      rememberRemoteDevice(peer, remote);
      const skewWarning = warnAboutSkew(peer, clockSkewMs);

      const watermark = Number(peer.data.watermark) || 0;
      const since = Math.max(0, watermark - WATERMARK_SAFETY_MS);
      const fetched = await fetchChanges(peer, since, opts);
      assertNotAborted(opts.signal, 'Der Abgleich');

      const locals = new Map();
      for (const record of fetched.records) {
        const local = store.get(record.id, { includeDeleted: true });
        if (local) locals.set(local.id, local);
      }

      const current = peerRecord(peerId);
      const planned = merge.plan(locals, fetched.records, { bases: basesOf(current) }, { clockSkewMs: clockSkewMs || 0 });

      const highest = fetched.records.reduce((max, record) => {
        const at = Date.parse(record.updatedAt);
        return Number.isFinite(at) && at > max ? at : max;
      }, watermark);

      const outcome = store.transaction(() => {
        assertNotAborted(opts.signal, 'Der Abgleich');
        const result = applyPlan(planned, { peerId, signal: opts.signal });
        mergeBases(peerId, result.bases);
        // A truncated run must not move the watermark past what it merged.
        store.update(peerId, {
          watermark: fetched.truncated ? watermark : highest,
          lastSyncAt: nowIso(),
          lastError: null,
        });
        return result;
      });

      const warnings = [...planned.warnings, ...fetched.warnings];
      if (skewWarning) warnings.push(skewWarning);

      publish('sync.applied', {
        peerId,
        direction: 'pull',
        fetched: fetched.records.length,
        applied: outcome.applied,
        conflicts: outcome.conflicts,
        skipped: outcome.skipped,
      });
      if (outcome.conflicts) publish('sync.conflict', { peerId, count: outcome.conflicts, direction: 'pull' });

      return {
        fetched: fetched.records.length,
        applied: outcome.applied,
        conflicts: outcome.conflicts,
        skipped: outcome.skipped,
        clockSkewMs,
        truncated: fetched.truncated,
        warnings,
        results: outcome.results,
      };
    } catch (err) {
      throw noteFailure(peerId, err);
    } finally {
      release();
    }
  }

  /* ----------------------------------------------------------------- push */

  function localChangesSince(sinceMs) {
    const out = [];
    for (const type of merge.SYNC_TYPES) {
      for (const record of store.list(type, { includeDeleted: true }).items) {
        const at = Date.parse(record.updatedAt);
        if (!Number.isFinite(at) || at < sinceMs) continue;
        out.push({ at, record });
      }
    }
    out.sort((a, b) => (a.at === b.at ? (a.record.id < b.record.id ? -1 : 1) : a.at - b.at));
    return out;
  }

  /**
   * Send local changes to a partner.
   *
   * Unlike a pull this cannot be atomic: once the partner has accepted a
   * batch, no local rollback can undo it. Bookkeeping is therefore committed
   * after every batch, which leaves a consistent and resumable state on abort
   * -- never a half-written one, but also not "as if nothing happened".
   */
  async function push(peerId, opts = {}) {
    const release = claim(peerId);
    try {
      const peer = peerRecord(peerId);
      assertEnabled(peer);
      assertDirection(peer, 'push');
      assertNotAborted(opts.signal, 'Der Abgleich');

      const { remote, clockSkewMs } = await fetchInfo(peer, { signal: opts.signal, timeoutMs: opts.timeoutMs });
      rememberRemoteDevice(peer, remote);
      const skewWarning = warnAboutSkew(peer, clockSkewMs);

      const watermark = Number(peer.data.pushWatermark) || 0;
      const since = Math.max(0, watermark - WATERMARK_SAFETY_MS);
      const changes = localChangesSince(since);

      let sent = 0;
      /** The partner wrote our version. */
      let applied = 0;
      /** The partner already held our version -- accepted, but nothing moved. */
      let unchanged = 0;
      let rejected = 0;
      let conflicts = 0;
      let highest = watermark;
      const warnings = skewWarning ? [skewWarning] : [];
      const results = [];

      for (let offset = 0; offset < changes.length; offset += DEFAULT_PAGE_SIZE) {
        assertNotAborted(opts.signal, 'Der Abgleich');
        const batch = changes.slice(offset, offset + DEFAULT_PAGE_SIZE);
        const currentPeer = peerRecord(peerId);
        const bases = basesOf(currentPeer);
        const payload = {
          deviceId: deviceIdJetzt(),
          records: batch.map((e) => e.record),
          bases: Object.fromEntries(batch
            .map((e) => [e.record.id, merge.baseHash(bases[e.record.id])])
            .filter(([, hash]) => typeof hash === 'string' && hash)),
        };

        const answer = await callPeer(peer, '/api/sync/apply', {
          method: 'POST',
          body: payload,
          purpose: 'sync.apply',
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
        sent += batch.length;

        const byId = new Map(batch.map((e) => [e.record.id, e.record]));
        const baseUpdates = {};
        const conflicted = [];
        let answered = 0;
        for (const entry of Array.isArray(answer && answer.results) ? answer.results : []) {
          if (!entry || typeof entry.id !== 'string') continue;
          const local = byId.get(entry.id);
          if (!local) continue;
          answered++;
          results.push(entry);
          if (entry.status === 'applied' || entry.status === 'identical') {
            if (entry.status === 'applied') applied++;
            else unchanged++;
            baseUpdates[entry.id] = { h: merge.fingerprint(local), at: nowIso() };
          } else if (entry.status === 'conflict') {
            conflicts++;
            // The partner kept its own version and wrote a conflict record
            // there. We write one here too, with both versions, so the
            // decision can be made on whichever device the user is sitting at.
            if (entry.current && typeof entry.current === 'object') {
              conflicted.push({
                recordId: entry.id,
                recordType: local.type,
                local,
                remote: entry.current,
                reason: entry.detail || 'Beide Geräte haben diesen Eintrag seit dem letzten Abgleich geändert.',
              });
            }
          } else {
            rejected++;
          }
        }

        if (conflicted.length || Object.keys(baseUpdates).length) {
          store.transaction(() => {
            for (const conflict of conflicted) upsertConflict(peerId, conflict);
            mergeBases(peerId, baseUpdates);
          });
        }

        for (const entry of batch) if (entry.at > highest) highest = entry.at;
        const unanswered = batch.length - answered;
        if (unanswered > 0) {
          warnings.push(`${unanswered} Datensätze blieben in der Antwort von "${peer.data.name}" unerwähnt.`);
        }
        // A record the partner refused has to be offered again, so the
        // watermark stays where it was until a run comes back clean.
        noteSuccess(peerId, { pushWatermark: (rejected || unanswered) ? watermark : highest });
      }

      if (!changes.length) noteSuccess(peerId, {});

      publish('sync.applied', { peerId, direction: 'push', sent, applied, unchanged, rejected, conflicts });
      if (conflicts) publish('sync.conflict', { peerId, count: conflicts, direction: 'push' });

      // `accepted` is "the partner now holds our version", which includes the
      // records it already had. `applied` is what actually moved, and that is
      // the number that has to fall to zero once both devices agree.
      return { sent, accepted: applied + unchanged, applied, unchanged, rejected, conflicts, clockSkewMs, warnings, results };
    } catch (err) {
      throw noteFailure(peerId, err);
    } finally {
      release();
    }
  }

  /* --------------------------------------------------------------- syncAll */

  async function syncOne(peer, opts) {
    const direction = peer.data.direction || 'both';
    const entry = { peerId: peer.id, name: peer.data.name, pull: null, push: null, error: null };
    if (direction === 'pull' || direction === 'both') {
      entry.pull = await pull(peer.id, opts);
    }
    if (direction === 'push' || direction === 'both') {
      entry.push = await push(peer.id, opts);
    }
    return entry;
  }

  /**
   * Run every enabled partner. One unreachable device must not stop the
   * others, so each failure is reported per peer instead of aborting the run.
   */
  async function syncAll(opts = {}) {
    const startedAt = nowIso();
    const peers = allPeers().filter((p) => p.data.enabled !== false);
    const results = [];
    for (const peer of peers) {
      if (opts.signal && opts.signal.aborted) {
        results.push({ peerId: peer.id, name: peer.data.name, pull: null, push: null, error: 'Abgebrochen, bevor dieses Gerät an der Reihe war.' });
        continue;
      }
      try {
        results.push(await syncOne(peer, opts));
      } catch (err) {
        const neural = asNeuralError(err);
        results.push({ peerId: peer.id, name: peer.data.name, pull: null, push: null, error: neural.message, code: neural.code });
      }
    }
    return {
      startedAt,
      finishedAt: nowIso(),
      peers: results,
      ok: results.every((r) => !r.error),
      openConflicts: openConflictCount(null),
    };
  }

  /**
   * Can a partner reach US at all? Setting up synchronisation from one side
   * and then waiting for data that can never arrive is the most likely way to
   * get this wrong, so the answer is part of the self-report rather than
   * something the user has to deduce from a timeout.
   */
  function incomingReady() {
    const sharing = (config.security && config.security.sharing) || {};
    if (sharing.enabled !== true) {
      return {
        ok: false,
        reason: 'Die Freigabe für andere Geräte ist ausgeschaltet. Solange sie aus ist, kann ein Partnergerät '
          + 'dieses hier nicht erreichen; Senden von hier aus funktioniert trotzdem.',
      };
    }
    if (!auth || typeof auth.listTokens !== 'function') {
      return { ok: false, reason: 'Das Anmeldemodul ist nicht verfügbar; ohne Token nimmt dieses Gerät keinen Abgleich an.' };
    }
    let tokens = [];
    try {
      tokens = auth.listTokens({ includeInactive: false });
    } catch (err) {
      return { ok: false, reason: `Die Tokenliste ist nicht lesbar: ${asNeuralError(err).message}` };
    }
    const usable = tokens.filter((t) => t.active !== false && t.permissions && t.permissions.sync === true);
    if (!usable.length) {
      return {
        ok: false,
        reason: 'Es gibt kein gültiges Token mit dem Recht "sync". Lege eines unter Einstellungen → Freigabe an '
          + 'und trage es auf dem Partnergerät ein.',
      };
    }
    return { ok: true, tokens: usable.length, reason: null };
  }

  /** Compact self-report for `neural-os doctor` and `/api/status`. */
  function summary() {
    const peers = allPeers();
    return {
      deviceId: deviceIdJetzt(),
      protocol: SYNC_PROTOCOL,
      peers: peers.length,
      enabled: peers.filter((p) => p.data.enabled !== false).length,
      lastSyncAt: peers.reduce((latest, p) => {
        const at = p.data.lastSyncAt;
        return at && (!latest || at > latest) ? at : latest;
      }, null),
      failing: peers.filter((p) => p.data.lastError).map((p) => ({ id: p.id, name: p.data.name, error: p.data.lastError })),
      openConflicts: openConflictCount(null),
      gate: !!gate,
      incoming: incomingReady(),
    };
  }

  return {
    get deviceId() { return deviceIdJetzt(); },
    get protocol() { return SYNC_PROTOCOL; },
    setAuth(next) { auth = next || null; return !!auth; },
    get auth() { return auth; },

    listPeers,
    getPeer,
    createPeer,
    updatePeer,
    removePeer,

    listConflicts,
    resolveConflict,

    info,
    changesSince,
    applyIncoming,
    incomingReady,

    test,
    pull,
    push,
    syncAll,
    summary,

    /** Exposed for tests and for the API layer; not part of the contract. */
    __internals: { applyPlan, normalisePeerUrl, sanitisePeer, sanitiseConflict, basesOf },
  };
}

module.exports = {
  createSync,
  normalisePeerUrl,
  sanitisePeer,
  SYNC_PROTOCOL,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  WATERMARK_SAFETY_MS,
};
