'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Logging and the tamper-evident audit trail.
 *
 * Two separate concerns deliberately kept apart:
 *  - `log`   : developer/operator diagnostics on stderr. Ephemeral.
 *  - `audit` : an append-only record on disk of every security-relevant
 *              decision (egress allowed/blocked, permission checks, approvals,
 *              vault unlocks, sharing changes). This is the user's evidence
 *              that the privacy guarantees held. It is written even when the
 *              decision was "allow", because a log of only denials tells you
 *              nothing about what actually left the machine.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLevel = LEVELS[process.env.NEURAL_OS_LOG_LEVEL] ?? LEVELS.info;

function setLevel(name) {
  if (name in LEVELS) currentLevel = LEVELS[name];
}

/**
 * Wohin die Diagnose geht. Ohne Senke wie immer nach stderr. Der Dienst
 * (Stick-Bauplan 2.4) hat kein Fenster und kein stderr; er setzt eine Senke
 * in eine Datei (`dateiSenke`), damit der Starter im Fehlerfall die letzten
 * Zeilen zeigen kann.
 * @type {((zeile:string)=>void)|null}
 */
let sink = null;

/** @param {((zeile:string)=>void)|null} fn */
function setSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

function emit(level, scope, message, extra) {
  if (LEVELS[level] > currentLevel) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const suffix = extra ? ` ${safeJson(extra)}` : '';
  if (sink) {
    try {
      sink(line + suffix + '\n');
      return;
    } catch { /* eine kaputte Senke darf die Meldung nicht verschlucken */ }
  }
  process.stderr.write(line + suffix + '\n');
}

/**
 * Eine Senke, die an `datei` anhängt und ab `maxBytes` nach `<datei>.1`
 * dreht (ein Vorgänger, nicht mehr: auf einem Stick zählt jedes Megabyte).
 * Synchron, damit die letzte Zeile vor einem Absturz auch dasteht; die
 * Diagnose schreibt wenig. Farbcodes werden entfernt: Die Datei liest ein
 * Mensch im Fehlerfall, nicht ein Terminal.
 * @param {string} datei
 * @param {{maxBytes?:number}} [opts]
 * @returns {((zeile:string)=>void) & {schliessen:()=>void}}
 */
function dateiSenke(datei, { maxBytes = 512 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(datei), { recursive: true, mode: 0o700 });
  let fd = null;
  let groesse = 0;
  const oeffnen = () => {
    fd = fs.openSync(datei, 'a', 0o600);
    try { groesse = fs.fstatSync(fd).size; } catch { groesse = 0; }
  };
  const senke = (zeile) => {
    const text = String(zeile).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    if (fd === null) oeffnen();
    if (groesse > 0 && groesse + Buffer.byteLength(text) > maxBytes) {
      try { fs.closeSync(fd); } catch { /* schon zu */ }
      fd = null;
      try { fs.renameSync(datei, `${datei}.1`); } catch { /* dann eben weiter anhängen */ }
      oeffnen();
    }
    groesse += fs.writeSync(fd, text);
  };
  senke.schliessen = () => {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* schon zu */ }
      fd = null;
    }
  };
  return senke;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (k, v) => (v instanceof Error ? { name: v.name, message: v.message, code: v.code } : v));
  } catch {
    return '[unserialisable]';
  }
}

function logger(scope) {
  return {
    error: (m, e) => emit('error', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    debug: (m, e) => emit('debug', scope, m, e),
  };
}

/**
 * The factory doubles as a usable logger.
 *
 * Dependency injection across many modules produced two reasonable readings of
 * a `logger` parameter -- "the factory, call it with your scope" and "an
 * instance, call .info() on it". Rather than police that at every call site
 * (where getting it wrong is a crash at exactly the moment something is
 * already going wrong -- a corrupt log tail, a failing export), the factory
 * carries the level methods itself. Both readings are now correct.
 */
Object.assign(logger, {
  error: (m, e) => emit('error', 'app', m, e),
  warn: (m, e) => emit('warn', 'app', m, e),
  info: (m, e) => emit('info', 'app', m, e),
  debug: (m, e) => emit('debug', 'app', m, e),
});

/**
 * Append-only JSONL audit writer.
 *
 * Writes are SYNCHRONOUS on purpose. An audit trail that loses its last lines
 * when the process exits is worse than no audit trail, because it invites
 * trust it hasn't earned. Volume is low (one line per egress decision), so the
 * cost is irrelevant next to the guarantee.
 */
class Audit {
  /** @param {string} filePath @param {{enabled?:boolean, fsync?:boolean}} [opts] */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.enabled = opts.enabled !== false;
    /** fsync each line: survives power loss, not just process death. */
    this.fsync = opts.fsync === true;
    this.fd = null;
    this.buffer = [];
    this.failures = 0;
  }

  open() {
    if (!this.enabled || this.fd !== null) return this;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(this.filePath, 'a', 0o600);
    return this;
  }

  /**
   * @param {string} kind e.g. 'network.allow', 'network.block', 'permission.deny'
   * @param {object} data
   */
  write(kind, data = {}) {
    const entry = { at: new Date().toISOString(), kind, ...data };
    this.buffer.push(entry);
    if (this.buffer.length > 500) this.buffer.shift();
    if (!this.enabled) return entry;
    try {
      if (this.fd === null) this.open();
      fs.writeSync(this.fd, JSON.stringify(entry) + '\n');
      if (this.fsync) fs.fsyncSync(this.fd);
    } catch (err) {
      // Never crash the app on an audit failure, but make it loud and count
      // it: a silently failing audit is a privacy failure.
      this.failures++;
      emit('error', 'audit', `audit write failed (${this.failures}): ${err.message}`);
    }
    return entry;
  }

  /** Most recent in-memory entries, newest first (for the UI panel). */
  tail(n = 100) {
    return this.buffer.slice(-n).reverse();
  }

  /** Read the last `n` lines from disk. Used by the audit viewer. */
  readTail(n = 200) {
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => {
        try { return JSON.parse(l); } catch { return { at: null, kind: 'unparseable', raw: l }; }
      }).reverse();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already gone */ }
      this.fd = null;
    }
  }
}

module.exports = { logger, setLevel, setSink, dateiSenke, LEVELS, Audit };
