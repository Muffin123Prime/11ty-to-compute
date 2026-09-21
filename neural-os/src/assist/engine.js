'use strict';

/**
 * The assistance engine: turning what the detectors noticed into suggestion
 * records, and applying exactly the ones the user picked.
 *
 * Four decisions that are not obvious from the code
 * -------------------------------------------------
 *
 * 1. NOTHING IS EVER APPLIED BY ITSELF. `scan()` writes suggestion records and
 *    stops. The only code in this file that changes a note, a tag or an edge
 *    sits behind `accept(id)`, and `accept` is only ever reached because a
 *    person pressed a button on a suggestion whose `action` they could read
 *    first. An assistant that edits your vault on its own is one you have to
 *    audit afterwards, and auditing is more work than doing it yourself.
 *
 * 2. A DISMISSED SUGGESTION NEVER COMES BACK. This is the whole reason
 *    proposals carry a deterministic `key`. Without it, "nein, diese beiden
 *    Notizen sind nicht dasselbe" would last until the next scan, and the
 *    feature would become something people switch off. On re-scan a key that
 *    already exists as `dismissed` (or `accepted`) is left exactly as it is --
 *    no update, no second record, no counter.
 *
 * 3. ONE BROKEN DETECTOR DOES NOT BREAK THE SCAN. Each detector runs inside
 *    its own try/catch and a failure is reported in `skipped` with the real
 *    error message, in the result the user sees. Swallowing it silently would
 *    turn "kein Vorschlag" into an ambiguous answer: nothing found, or nothing
 *    looked? The same mechanism reports a detector that declines because a
 *    subsystem it needs is not wired into this instance.
 *
 * 4. AN OPEN SUGGESTION WHOSE KEY NO LONGER APPEARS BECOMES `stale`, NOT
 *    DELETED. The user may have fixed the thing themselves, or renamed a note
 *    out from under it. Either way the record stays, so the list can show that
 *    it no longer applies instead of silently losing history.
 *
 * `now` is injectable into `scan` on purpose: three of the six detectors are
 * about age, and a test that had to wait ninety days would not be a test.
 */

const { ValidationError, NotFoundError, asNeuralError } = require('../kernel/errors');
const { DETECTORS } = require('./detectors');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const STATUSES = ['open', 'accepted', 'dismissed', 'stale'];

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {{store:object, graph?:object|null, bus?:object|null, config?:object,
 *          logger?:function, detectors?:Array<object>}} deps
 *        `detectors` is an escape hatch for tests and for a module that brings
 *        its own detector; production passes none and gets the built-in six.
 */
function createAssist({ store, graph, bus, config, logger, detectors } = {}) {
  if (!store || typeof store.create !== 'function' || typeof store.list !== 'function') {
    throw new ValidationError('createAssist benötigt einen Store.');
  }
  const log = typeof logger === 'function' ? logger('assist') : nullLogger();
  const cfg = isPlainObject(config) ? (isPlainObject(config.assist) ? config.assist : config) : {};
  const table = Array.isArray(detectors) && detectors.length ? detectors.slice() : DETECTORS.slice();
  const known = new Set(table.map((d) => d.kind));

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`);
    }
  }

  /* -------------------------------------------------------------- reading */

  /** The detectors this instance runs, without their implementations. */
  function detectorList() {
    return table.map((d) => ({ kind: d.kind, label: d.label, description: d.description }));
  }

  function assertKinds(kinds) {
    for (const kind of kinds) {
      if (!known.has(kind)) {
        throw new ValidationError(
          `"${kind}" ist keine bekannte Art von Vorschlag. Möglich: ${Array.from(known).join(', ')}.`,
        );
      }
    }
  }

  /** Every suggestion this engine is responsible for: ours, and key-bearing. */
  function ownSuggestions() {
    return store.all('suggestion').filter((rec) => (
      typeof rec.data.key === 'string' && rec.data.key && rec.data.source === 'assist'
    ));
  }

  /* ---------------------------------------------------------------- scan */

  /**
   * Run the detectors and reconcile their proposals with what is already
   * stored.
   *
   * @param {{kinds?:string[], limit?:number, now?:number}} [opts]
   * @returns {Promise<{scannedAt:string, durationMs:number, created:number,
   *                    refreshed:number, stale:number, byKind:object,
   *                    skipped:Array<{kind:string,reason:string}>}>}
   */
  async function scan(opts = {}) {
    const started = Date.now();
    if (opts.kinds !== undefined && opts.kinds !== null && !Array.isArray(opts.kinds)) {
      throw new ValidationError('"kinds" muss eine Liste von Texten sein.');
    }
    const wanted = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds.slice() : null;
    if (wanted) assertKinds(wanted);
    const limit = Number.isInteger(opts.limit) && opts.limit > 0
      ? Math.min(opts.limit, MAX_LIMIT)
      : (Number.isInteger(cfg.limit) && cfg.limit > 0 ? Math.min(cfg.limit, MAX_LIMIT) : DEFAULT_LIMIT);
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();

    const running = table.filter((d) => !wanted || wanted.includes(d.kind));
    const scannedKinds = new Set();
    const skipped = [];
    const byKind = {};
    /** key -> proposal, first one wins: two detectors must not fight over a key. */
    const proposals = new Map();

    for (const detector of running) {
      const missing = (detector.needs || []).filter((dep) => dep === 'graph' && !graph);
      if (missing.length) {
        skipped.push({
          kind: detector.kind,
          reason: 'Der Wissensgraph ist in dieser Instanz nicht verfügbar. Ohne ihn lässt sich nicht feststellen, '
            + 'welche Verweise wirklich ins Leere zeigen — geraten wird hier nicht.',
        });
        continue;
      }
      let found;
      try {
        found = await detector.detect({ store, graph: graph || null, now, limit, config: cfg });
      } catch (err) {
        const wrapped = asNeuralError(err);
        log.warn(`Detektor ${detector.kind} fehlgeschlagen: ${wrapped.message}`);
        skipped.push({ kind: detector.kind, reason: wrapped.message });
        continue;
      }
      // Only now does the kind count as scanned: a detector that never ran
      // must not make its own open suggestions stale.
      scannedKinds.add(detector.kind);
      const list = Array.isArray(found) ? found.slice(0, limit) : [];
      byKind[detector.kind] = list.length;
      for (const proposal of list) {
        if (!proposal || typeof proposal.key !== 'string' || !proposal.key) continue;
        if (!proposals.has(proposal.key)) proposals.set(proposal.key, { ...proposal, kind: detector.kind });
      }
    }

    const existing = new Map();
    for (const rec of ownSuggestions()) {
      const current = existing.get(rec.data.key);
      // A decided record always wins a key collision: whatever else is behind
      // that key, the user's decision is the one thing that must not be lost.
      if (!current || (current.data.status === 'open' && rec.data.status !== 'open')) existing.set(rec.data.key, rec);
    }

    let created = 0;
    let refreshed = 0;
    let stale = 0;

    for (const [key, proposal] of proposals) {
      const current = existing.get(key);
      if (!current) {
        store.create('suggestion', {
          kind: proposal.kind,
          title: String(proposal.title || ''),
          detail: String(proposal.detail || ''),
          reason: String(proposal.reason || ''),
          recordIds: Array.isArray(proposal.recordIds) ? proposal.recordIds.filter((id) => typeof id === 'string') : [],
          action: isPlainObject(proposal.action) ? proposal.action : null,
          confidence: Number.isFinite(proposal.confidence) ? proposal.confidence : 0.5,
          status: 'open',
          source: 'assist',
          key,
        });
        created++;
        continue;
      }
      // Decided is decided. Dismissed above all: this is the line that keeps a
      // rejected suggestion from reappearing on every scan for ever.
      if (current.data.status === 'dismissed' || current.data.status === 'accepted') continue;

      store.update(current.id, {
        // `stale` is not a decision, it is "gilt gerade nicht". When the same
        // key turns up again the thing applies again, so it is open again.
        status: 'open',
        title: String(proposal.title || ''),
        detail: String(proposal.detail || ''),
        reason: String(proposal.reason || ''),
        recordIds: Array.isArray(proposal.recordIds) ? proposal.recordIds.filter((id) => typeof id === 'string') : [],
        confidence: Number.isFinite(proposal.confidence) ? proposal.confidence : 0.5,
      });
      refreshed++;
    }

    for (const [key, rec] of existing) {
      if (rec.data.status !== 'open') continue;
      if (!scannedKinds.has(rec.data.kind)) continue; // not looked at this time
      if (proposals.has(key)) continue;
      store.update(rec.id, { status: 'stale' });
      stale++;
    }

    const result = {
      scannedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      created,
      refreshed,
      stale,
      byKind,
      skipped,
    };
    publish('assist.scanned', result);
    return result;
  }

  /* ---------------------------------------------------------------- list */

  /**
   * @param {{status?:string|null, kind?:string|null, limit?:number, offset?:number}} [opts]
   *        `status: 'all'` lists every status; the default is `open`.
   * @returns {{items:object[], total:number}}
   */
  function list(opts = {}) {
    const status = opts.status === undefined || opts.status === null ? 'open' : String(opts.status);
    if (status !== 'all' && !STATUSES.includes(status)) {
      throw new ValidationError(`"status" muss all, ${STATUSES.join(', ')} sein (empfangen: ${status}).`);
    }
    const kind = opts.kind === undefined || opts.kind === null ? null : String(opts.kind);
    if (kind) assertKinds([kind]);

    const items = store.all('suggestion').filter((rec) => (
      (status === 'all' || rec.data.status === status) && (!kind || rec.data.kind === kind)
    ));
    items.sort((a, b) => {
      const ac = Number.isFinite(a.data.confidence) ? a.data.confidence : 0;
      const bc = Number.isFinite(b.data.confidence) ? b.data.confidence : 0;
      if (ac !== bc) return bc - ac;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });

    const total = items.length;
    const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
    const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : total;
    return { items: items.slice(offset, offset + limit), total };
  }

  /* -------------------------------------------------------------- decide */

  function mustGetSuggestion(id) {
    const record = store.get(id);
    if (!record || record.type !== 'suggestion') throw new NotFoundError(`suggestion ${id}`);
    return record;
  }

  /** Mark a suggestion as no longer applicable, without touching its history. */
  function markStale(record) {
    try {
      if (record.data.status === 'open') store.update(record.id, { status: 'stale' });
    } catch (err) {
      log.warn(`Vorschlag ${record.id} konnte nicht auf stale gesetzt werden: ${err && err.message}`);
    }
  }

  /** The record a suggestion is about, or `null` if it is gone. */
  function liveOrNull(id) {
    if (typeof id !== 'string' || !id) return null;
    try {
      return store.get(id);
    } catch {
      return null;
    }
  }

  /**
   * Carry out one action. Every branch checks that what it is about still
   * exists first: a suggestion is a snapshot of a moment, and the vault has
   * moved on since.
   */
  function apply(record) {
    const action = record.data.action;
    if (!isPlainObject(action)) {
      return {
        op: 'none',
        note: 'Dieser Vorschlag hat keine automatische Aktion — er ist ein Hinweis, den nur du umsetzen kannst.',
      };
    }

    switch (action.op) {
      case 'link': {
        const from = liveOrNull(action.from);
        const to = liveOrNull(action.to);
        if (!from || !to) {
          markStale(record);
          throw new NotFoundError(`Record ${from ? action.to : action.from}`);
        }
        // `agent`, not `manual`: the connection was proposed by a machine and
        // only confirmed by a person. The graph shows agent links distinctly
        // and can bulk-review them, which would be impossible if they were
        // indistinguishable from links the user drew by hand.
        const edge = store.edges.add({
          from: from.id,
          to: to.id,
          kind: typeof action.kind === 'string' && action.kind ? action.kind : 'related',
          source: 'agent',
          reason: typeof action.reason === 'string' && action.reason
            ? action.reason
            : 'Aus einem angenommenen Vorschlag der Assistenz.',
          weight: 1,
        });
        return { op: 'link', edgeId: edge.id };
      }

      case 'addTags': {
        const target = liveOrNull(action.recordId);
        if (!target) {
          markStale(record);
          throw new NotFoundError(`Record ${action.recordId}`);
        }
        const existing = Array.isArray(target.data.tags) ? target.data.tags.slice() : [];
        const seen = new Set(existing.map((t) => String(t).trim().toLowerCase()));
        const added = [];
        for (const raw of Array.isArray(action.tags) ? action.tags : []) {
          if (typeof raw !== 'string') continue;
          const tag = raw.trim().replace(/^#/, '');
          if (!tag || seen.has(tag.toLowerCase())) continue;
          seen.add(tag.toLowerCase());
          existing.push(tag);
          added.push(tag);
        }
        // Nothing to add is not a failure: somebody tagged it in the meantime.
        if (added.length) store.update(target.id, { tags: existing });
        return { op: 'addTags', recordId: target.id, added };
      }

      case 'createTask': {
        const source = liveOrNull(action.sourceId);
        if (!source) {
          markStale(record);
          throw new NotFoundError(`Record ${action.sourceId}`);
        }
        const projectId = liveOrNull(action.projectId) ? action.projectId : null;
        const task = store.create('task', {
          title: String(action.title || '').slice(0, 500),
          projectId,
          body: `Übernommen aus „${String(source.data.title || 'Notiz')}“.`,
          // Not a schema field, kept because the store preserves unknown keys:
          // without it the task would have no way back to where it came from.
          sourceId: source.id,
        });
        return { op: 'createTask', taskId: task.id };
      }

      case 'createNote': {
        const from = liveOrNull(action.linkFrom);
        if (!from) {
          markStale(record);
          throw new NotFoundError(`Record ${action.linkFrom}`);
        }
        const title = String(action.title || '').slice(0, 500);
        if (!title) throw new ValidationError('Dem Vorschlag fehlt der Titel der neuen Notiz.');
        const note = store.create('note', {
          title,
          body: String(action.body || ''),
          tags: Array.isArray(action.tags) ? action.tags.filter((t) => typeof t === 'string') : [],
          source: 'agent',
        });
        // Written as `derived` with the graph's own wording: the link really is
        // derived from `[[title]]` in the source text, and phrasing it the same
        // way means the next rescan recognises the edge as its own and keeps
        // maintaining it instead of adding a second one beside it.
        let edgeId = null;
        try {
          edgeId = store.edges.add({
            from: from.id,
            to: note.id,
            kind: 'links-to',
            source: 'derived',
            reason: `Wiki-Link [[${title}]] im Text`,
          }).id;
        } catch (err) {
          // The note exists and that is the part the user asked for; the edge
          // comes back on the next rescan. Reported, not hidden.
          log.warn(`Kante zur neuen Notiz ${note.id} nicht angelegt: ${err && err.message}`);
        }
        return { op: 'createNote', noteId: note.id, edgeId };
      }

      default:
        throw new ValidationError(`Unbekannte Aktion "${String(action.op)}" — dieser Vorschlag lässt sich nicht übernehmen.`);
    }
  }

  /**
   * Carry out a suggestion's action and record the decision.
   * @param {string} id
   * @returns {Promise<{suggestion:object, applied:object}>}
   */
  async function accept(id) {
    const record = mustGetSuggestion(id);
    if (record.data.status !== 'open') {
      throw new ValidationError(`Dieser Vorschlag ist bereits entschieden (${record.data.status}).`);
    }
    // recordIds[0] is the subject by contract. If it is gone there is nothing
    // left to be right about, whatever the action says.
    const subjectId = Array.isArray(record.data.recordIds) ? record.data.recordIds[0] : null;
    if (subjectId && !liveOrNull(subjectId)) {
      markStale(record);
      throw new NotFoundError(`Record ${subjectId}`);
    }

    const applied = apply(record);
    const suggestion = store.update(record.id, { status: 'accepted', decidedAt: nowIso() });
    publish('assist.decided', { id: suggestion.id, kind: suggestion.data.kind, decision: 'accepted', applied });
    return { suggestion, applied };
  }

  /** @param {string} id @returns {{suggestion:object}} */
  function dismiss(id) {
    const record = mustGetSuggestion(id);
    const suggestion = record.data.status === 'dismissed'
      ? record
      : store.update(record.id, { status: 'dismissed', decidedAt: nowIso() });
    publish('assist.decided', { id: suggestion.id, kind: suggestion.data.kind, decision: 'dismissed', applied: null });
    return { suggestion };
  }

  /**
   * Delete a suggestion outright. Dismissing is almost always the better move
   * -- a deleted key is a key the next scan will propose again.
   * @param {string} id
   */
  function remove(id) {
    const record = mustGetSuggestion(id);
    return { suggestion: store.remove(record.id) };
  }

  /** @returns {{open:number, accepted:number, dismissed:number, stale:number, byKind:object}} */
  function stats() {
    const out = { open: 0, accepted: 0, dismissed: 0, stale: 0, byKind: {} };
    for (const rec of store.all('suggestion')) {
      const status = rec.data.status;
      if (Object.prototype.hasOwnProperty.call(out, status)) out[status]++;
      // byKind counts what is still waiting: that is the number a badge shows.
      if (status === 'open') out.byKind[rec.data.kind] = (out.byKind[rec.data.kind] || 0) + 1;
    }
    return out;
  }

  return {
    detectors: detectorList,
    scan,
    list,
    accept,
    dismiss,
    remove,
    stats,
  };
}

module.exports = { createAssist, DEFAULT_LIMIT, MAX_LIMIT, STATUSES };
