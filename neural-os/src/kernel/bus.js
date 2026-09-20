'use strict';

const { EventEmitter } = require('node:events');

/**
 * Single in-process event bus.
 *
 * Every subsystem publishes here and the HTTP layer forwards to the browser
 * over one SSE stream. One bus means the UI can never drift out of sync with
 * what the server actually did -- there is no second code path that updates
 * the screen without a real event behind it.
 *
 * Event names are `<domain>.<verb>`:
 *   record.created | record.updated | record.deleted
 *   edge.created   | edge.deleted
 *   chat.delta     | chat.message  | chat.error
 *   run.started    | run.step      | run.finished | run.failed
 *   approval.requested | approval.resolved
 *   network.attempt (every egress decision, allowed or blocked)
 *   models.changed
 *   vault.locked   | vault.unlocked
 */
class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    /** @type {Array<{seq:number,at:string,name:string,payload:any}>} */
    this.recent = [];
    this.seq = 0;
    this.maxRecent = 500;
  }

  /**
   * @param {string} name
   * @param {object} payload
   * @returns {{seq:number,at:string,name:string,payload:any}}
   */
  publish(name, payload = {}) {
    const event = { seq: ++this.seq, at: new Date().toISOString(), name, payload };
    this.recent.push(event);
    if (this.recent.length > this.maxRecent) this.recent.splice(0, this.recent.length - this.maxRecent);
    // A crashing listener must never take down the publisher.
    try {
      this.emit(name, event);
      this.emit('*', event);
    } catch (err) {
      process.emitWarning(`bus listener threw for ${name}: ${err && err.message}`);
    }
    return event;
  }

  /** Replay events a reconnecting client missed. */
  since(seq) {
    if (!Number.isFinite(seq)) return [];
    return this.recent.filter((e) => e.seq > seq);
  }

  /** Subscribe to all events; returns an unsubscribe function. */
  subscribe(handler) {
    this.on('*', handler);
    return () => this.off('*', handler);
  }
}

module.exports = { Bus, bus: new Bus() };
