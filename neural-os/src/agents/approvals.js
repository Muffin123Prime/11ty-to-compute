'use strict';

const { ValidationError, NotFoundError, ApprovalDeniedError, AbortedError } = require('../kernel/errors');

/**
 * Human-in-the-loop approvals for agent side effects.
 *
 * Design notes
 * ------------
 * - THE RECORD IS THE TRUTH, THE PROMISE IS THE CONVENIENCE. Every request is
 *   an `approval` record in the vault before anyone waits on anything. The
 *   pending promise lives only in this process; the record survives it. That
 *   ordering is what makes the audit trail complete even if the process dies
 *   mid-decision.
 *
 * - NOTHING STAYS 'pending' ACROSS A RESTART. A waiter is an in-memory
 *   promise; when the process ends, every waiter dies with it. A record left
 *   at 'pending' would then sit in the user's approval list for ever,
 *   attached to a run that no longer exists, and clicking "approve" would
 *   approve nothing. So the constructor sweeps every pending approval to
 *   'expired' at boot, and says so in the record. See `sweepOrphaned()`.
 *
 * - A TIMEOUT IS A DENIAL, NOT A PASS. If the user is not there, the side
 *   effect does not happen. `ApprovalDeniedError` is thrown either way; the
 *   record distinguishes 'denied' from 'expired' so the UI can explain which.
 *
 * - IDEMPOTENT DECISIONS. `resolve()` on an already-decided approval returns
 *   the record unchanged instead of throwing, because a double click in the UI
 *   and a retried HTTP request are both normal and neither should produce an
 *   error the user has to understand.
 */

const DEFAULT_TIMEOUT_MS = 300000;
/** An unbounded wait is a hung run; even a patient user gets an hour. */
const MAX_TIMEOUT_MS = 3600000;

const KINDS = ['tool', 'network', 'spawn', 'file', 'other'];

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {{store:object, bus?:object, config?:object, logger?:Function, audit?:object}} deps
 */
function createApprovals({ store, bus, config, logger, audit } = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new ValidationError('createApprovals benötigt einen Store.');
  }
  const log = typeof logger === 'function' ? logger('approvals') : nullLogger();

  /** @type {Map<string, {resolve:Function, reject:Function, timer:any, runId:string|null}>} */
  const waiters = new Map();
  let closed = false;

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`);
    }
  }

  function writeAudit(kind, data) {
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write(kind, data);
    } catch (err) {
      log.warn(`Audit-Eintrag ${kind} fehlgeschlagen: ${err && err.message}`);
    }
  }

  function pendingRecords() {
    try {
      return store.list('approval', { filter: { status: 'pending' }, limit: undefined }).items;
    } catch (err) {
      log.warn(`Ausstehende Bestätigungen konnten nicht gelesen werden: ${err && err.message}`);
      return [];
    }
  }

  function settle(id, status, extra = {}) {
    let record = null;
    try {
      record = store.update(id, {
        status,
        decidedAt: new Date().toISOString(),
        ...extra,
      });
    } catch (err) {
      // The decision still has to reach the waiter: a vault write failure must
      // not turn a denial into an indefinite wait.
      log.error(`Bestätigung ${id} konnte nicht gespeichert werden: ${err && err.message}`);
    }
    publish('approval.resolved', {
      id,
      status,
      runId: record ? record.data.runId : null,
      agentId: record ? record.data.agentId : null,
    });
    writeAudit('agent.approval', { approvalId: id, status, runId: record ? record.data.runId : null });
    return record;
  }

  /**
   * Move approvals left pending by an earlier process to 'expired'.
   * Called once at construction; exported so a test (and a future maintenance
   * command) can trigger it deliberately.
   */
  function sweepOrphaned() {
    const stale = pendingRecords();
    for (const record of stale) {
      if (waiters.has(record.id)) continue; // ours, still genuinely waiting
      settle(record.id, 'expired', { expiredReason: 'Prozess wurde neu gestartet' });
    }
    if (stale.length) log.info(`${stale.length} verwaiste Bestätigung(en) auf "expired" gesetzt.`);
    return stale.length;
  }

  function finishWaiter(id, fn) {
    const waiter = waiters.get(id);
    if (!waiter) return false;
    waiters.delete(id);
    clearTimeout(waiter.timer);
    fn(waiter);
    return true;
  }

  const approvals = {
    /**
     * Ask the user. Resolves `true` on approval; throws `ApprovalDeniedError`
     * on denial or timeout, `AbortedError` when the caller's signal fires.
     *
     * @param {{runId?:string|null, agentId?:string|null, kind:string,
     *          summary?:string, payload?:object, timeoutMs?:number,
     *          signal?:AbortSignal}} opts
     * @returns {Promise<true>}
     */
    async request(opts = {}) {
      if (closed) throw new AbortedError('Das Bestätigungssystem wird beendet.');
      const kind = typeof opts.kind === 'string' && opts.kind.trim() ? opts.kind.trim() : null;
      if (!kind) throw new ValidationError('Eine Bestätigung braucht eine Art (kind).');
      const summary = typeof opts.summary === 'string' ? opts.summary : '';
      const payload = isPlainObject(opts.payload) ? opts.payload : {};

      let timeoutMs = Number(opts.timeoutMs);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
      timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

      const runId = typeof opts.runId === 'string' && opts.runId ? opts.runId : null;
      const agentId = typeof opts.agentId === 'string' && opts.agentId ? opts.agentId : null;

      if (opts.signal && opts.signal.aborted) {
        throw new AbortedError('Der Lauf wurde abgebrochen, bevor die Bestätigung gestellt wurde.');
      }

      const record = store.create('approval', {
        runId,
        agentId,
        kind: KINDS.includes(kind) ? kind : 'other',
        summary,
        payload,
        status: 'pending',
        decidedAt: null,
        // Not part of the schema, kept for the UI countdown. Extra fields on
        // `data` survive validation by design.
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      });

      publish('approval.requested', {
        id: record.id,
        runId,
        agentId,
        kind: record.data.kind,
        summary,
        payload,
        expiresAt: record.data.expiresAt,
      });
      writeAudit('agent.approval.requested', { approvalId: record.id, runId, agentId, kind: record.data.kind, summary });

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          finishWaiter(record.id, () => {
            settle(record.id, 'expired', { expiredReason: 'Zeitüberschreitung' });
            reject(new ApprovalDeniedError(
              `Keine Bestätigung innerhalb von ${Math.round(timeoutMs / 1000)} s: ${summary || record.data.kind}`,
              { approvalId: record.id, status: 'expired' },
            ));
          });
        }, timeoutMs);
        // Deliberately NOT unref'd. An unref'd timer does not fire once it is
        // the only thing left in the event loop, which would turn "denied
        // after five minutes" into "this promise never settles". The timer is
        // cleared on every decision and by close(), so it holds nothing open
        // longer than the wait it is guarding.

        const onAbort = () => {
          finishWaiter(record.id, () => {
            settle(record.id, 'denied', { deniedReason: 'Lauf abgebrochen' });
            reject(new AbortedError('Der Lauf wurde abgebrochen, während auf die Bestätigung gewartet wurde.'));
          });
        };
        if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

        waiters.set(record.id, {
          runId,
          timer,
          resolve: () => {
            if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
            resolve(true);
          },
          reject: (err) => {
            if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
            reject(err);
          },
        });

        // A decision that arrived between store.create() and here (an HTTP
        // request racing the agent) would otherwise wait for the timeout.
        const current = store.get(record.id);
        if (current && current.data.status !== 'pending') {
          finishWaiter(record.id, (w) => {
            if (current.data.status === 'approved') w.resolve();
            else w.reject(new ApprovalDeniedError(`Bestätigung abgelehnt: ${summary}`, { approvalId: record.id, status: current.data.status }));
          });
        }
      });
    },

    /**
     * @param {string} id
     * @param {'approved'|'denied'} decision
     * @returns {object} the approval record
     */
    resolve(id, decision) {
      if (decision !== 'approved' && decision !== 'denied') {
        throw new ValidationError("Entscheidung muss 'approved' oder 'denied' sein.");
      }
      const existing = store.get(id);
      if (!existing || existing.type !== 'approval') throw new NotFoundError(`Bestätigung ${id}`);
      if (existing.data.status !== 'pending') return existing; // idempotent

      const updated = settle(id, decision);
      finishWaiter(id, (w) => {
        if (decision === 'approved') w.resolve();
        else w.reject(new ApprovalDeniedError(
          `Bestätigung abgelehnt: ${existing.data.summary || existing.data.kind}`,
          { approvalId: id, status: 'denied' },
        ));
      });
      return updated || existing;
    },

    /** @returns {object[]} pending approval records, oldest first */
    listPending() {
      return pendingRecords().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },

    get(id) {
      const record = store.get(id);
      if (!record || record.type !== 'approval') throw new NotFoundError(`Bestätigung ${id}`);
      return record;
    },

    /**
     * Cancel everything still waiting for `runId` (the run was aborted).
     * Without a runId, cancels every waiter -- used on shutdown.
     * @returns {number} how many were cancelled
     */
    abortAll(runId) {
      const ids = [];
      for (const [id, waiter] of waiters) {
        if (runId === undefined || runId === null || waiter.runId === runId) ids.push(id);
      }
      for (const id of ids) {
        finishWaiter(id, (w) => {
          settle(id, 'denied', { deniedReason: 'Lauf abgebrochen' });
          w.reject(new AbortedError('Der Lauf wurde abgebrochen; die Bestätigung entfällt.'));
        });
      }
      // Records without a live waiter (e.g. written by a previous process for
      // the same run) would otherwise stay pending for ever.
      for (const record of pendingRecords()) {
        if (runId && record.data.runId !== runId) continue;
        if (waiters.has(record.id)) continue;
        settle(record.id, 'denied', { deniedReason: 'Lauf abgebrochen' });
        ids.push(record.id);
      }
      return ids.length;
    },

    /** How many requests this process is currently waiting on. */
    pendingCount() {
      return waiters.size;
    },

    sweepOrphaned,

    close() {
      closed = true;
      return approvals.abortAll();
    },
  };

  sweepOrphaned();
  return approvals;
}

module.exports = { createApprovals, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, KINDS };
