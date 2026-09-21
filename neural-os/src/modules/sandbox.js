'use strict';

/**
 * The execution environment for code the user pasted into the workshop.
 *
 * HONEST SECURITY NOTE -- read this before trusting anything below
 * ---------------------------------------------------------------
 * `node:vm` is NOT a security boundary. It is a separate *realm*, not a
 * separate *process*, and code that is deliberately trying to escape one can
 * do so: every host object handed into the context (`Buffer`, a thrown host
 * `Error`, anything returned from `api.*`) carries a reference chain back to
 * the host realm's `Function` constructor. People have been walking out of
 * `vm` contexts for a decade and node's own documentation says plainly that it
 * must not be used as a sandbox for untrusted code.
 *
 * So what is this for? It protects against MISTAKES, not against ATTACKS:
 *   - a loop without an exit condition cannot freeze the app (timeout),
 *   - a forgotten `setInterval` cannot outlive the module (timers are tracked),
 *   - `require('fs')` fails with an explanation instead of reaching the disk,
 *   - a module that throws is caught, counted and switched off,
 *   - a module that crashed the process last time is not loaded again.
 *
 * The actual safety of this feature lies elsewhere and is not a matter of
 * opinion:
 *   - CAPABILITIES: a permission that was not granted is not a function that
 *     refuses -- the property is absent from `api` entirely.
 *   - THE GATE: a module without a network capability has no `api.fetch`, and
 *     `src/net/harden.js` blocks the raw stdlib for the whole process anyway.
 *   - THE AUDIT TRAIL: every write a module performs is on disk afterwards.
 *   - REVERSIBILITY: every version of every module is kept, so any change the
 *     user makes can be undone -- which is the only reason experimenting with
 *     pasted code is a reasonable thing to do at all.
 *
 * The user is told this in the workshop in the same words. Pasting code from a
 * source you do not trust is running that code on your machine; a sandbox that
 * claims otherwise would be lying to them.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  NeuralError,
  ValidationError,
  NotFoundError,
  PermissionError,
  NoModelError,
  asNeuralError,
} = require('../kernel/errors');
const { safeJoin } = require('../kernel/paths');
const schema = require('../store/schema');
const capabilities = require('./capabilities');

/* ------------------------------------------------------------- constants */

const DEFAULT_TIMEOUT_MS = 2000;
/** Tearing down gets its own, shorter budget: cleanup must not hang shutdown. */
const TEARDOWN_TIMEOUT_MS = 1000;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_STORAGE_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_TIMERS = 200;
/** A `setInterval(fn, 0)` is always a mistake and would burn a core. */
const MIN_INTERVAL_MS = 50;
const MAX_LOG_LINES = 200;

/** Module routes live in their own namespace so they can never shadow ours. */
const ROUTE_PREFIX = '/api/x/';
const ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Namespaces the built-in agent tools occupy (see src/agents/tools.js). A
 * module tool called `files.write` would be answered by the toolbox first --
 * or, worse, would answer instead of it -- and an agent's permission check
 * would then apply to the wrong implementation.
 */
const RESERVED_TOOL_NAMESPACES = new Set([
  'notes', 'graph', 'tasks', 'files', 'memory', 'web', 'agents', 'time', 'math',
]);

/**
 * Types a module may never write, because writing them is a way to grant
 * itself something the user did not:
 *   module   -- could add capabilities to itself
 *   token    -- could mint an access token for a remote device
 *   grant    -- could write its own network grant and walk past the gate
 *   agent    -- could give an agent fileRoots ['/'] and no approval requirement
 *   approval -- could approve the request it is waiting on
 *   peer     -- could point synchronisation at a machine it controls
 *   run/message/conflict -- provenance; forging them makes the history lie
 */
const FORBIDDEN_WRITE_TYPES = new Set([
  'module', 'token', 'grant', 'agent', 'approval', 'peer', 'run', 'message', 'conflict',
]);

/** Token records hold hash + salt. That is credential material, not content. */
const FORBIDDEN_READ_TYPES = new Set(['token']);

/** Same allowlist the HTTP layer uses: a second door would be a hole. */
const CREATABLE_TYPES = new Set(['note', 'project', 'task', 'entity', 'memory', 'file', 'chat']);

/** What to suggest when a module calls require(). */
const REQUIRE_HINTS = {
  fs: 'api.files',
  'fs/promises': 'api.files',
  'node:fs': 'api.files',
  'node:fs/promises': 'api.files',
  path: 'api.files (Pfade gibst du relativ zu den freigegebenen Ordnern an)',
  'node:path': 'api.files (Pfade gibst du relativ zu den freigegebenen Ordnern an)',
  http: 'api.fetch',
  https: 'api.fetch',
  'node:http': 'api.fetch',
  'node:https': 'api.fetch',
  'node-fetch': 'api.fetch',
  axios: 'api.fetch',
  got: 'api.fetch',
  undici: 'api.fetch',
  crypto: 'api.storage, wenn du nur etwas ablegen willst',
  'node:crypto': 'api.storage, wenn du nur etwas ablegen willst',
};

/* --------------------------------------------------------------- helpers */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

/** `logger` may be the factory from kernel/log or an already-scoped logger. */
function makeLogger(candidate, scope) {
  if (typeof candidate === 'function') {
    try {
      const made = candidate(scope);
      if (made && typeof made.info === 'function') return made;
    } catch { /* fall through */ }
  }
  if (candidate && typeof candidate.info === 'function') return candidate;
  return nullLogger();
}

/**
 * Turn anything a module handed us into plain host data.
 *
 * Two reasons this is not optional: objects created inside the vm realm keep
 * that realm (and thus the module's own prototypes) alive if we store them,
 * and a live reference handed into the store could be mutated by the module
 * after the write. Data crosses the border, references do not.
 */
function toPlain(value) {
  if (value === undefined || value === null) return value === undefined ? undefined : null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function') return undefined;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new ValidationError(
      `Der Wert lässt sich nicht als Daten darstellen (${err.message}). `
      + 'Module tauschen nur Daten aus – keine Funktionen, keine Verweise, keine Zyklen.',
    );
  }
  if (text === undefined) return undefined;
  return JSON.parse(text);
}

/**
 * A trial run reads, but never writes and never sends.
 *
 * The alternative would be to let the write happen (checking a module would
 * then change the user's data) or to return a convincing fake (which would be
 * a lie). Refusing out loud is the only honest third option, and the registry
 * turns this particular refusal into a hint rather than a verdict.
 */
function dryRunRefusal(what) {
  return new NeuralError(
    'MODULE_DRYRUN_WRITE',
    `Beim Probelauf kann das Modul nicht ${what}. Geprüft wird, ohne etwas zu verändern – `
    + 'richtig arbeiten kann das Modul erst, wenn du es aktivierst.',
    { status: 409, details: { what } },
  );
}

/**
 * The line number of a syntax or runtime error inside module source.
 *
 * `err.lineNumber` is not populated by node for vm SyntaxErrors (checked on
 * v22), so the stack is the real source: its first line is `<filename>:<line>`
 * for a syntax error and `at <filename>:<line>:<col>` for a runtime one.
 */
function lineFromError(err, filename) {
  if (!err) return null;
  if (Number.isInteger(err.lineNumber) && err.lineNumber > 0) return err.lineNumber;
  const stack = typeof err.stack === 'string' ? err.stack : '';
  if (!stack) return null;
  const escaped = String(filename).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(`${escaped}:(\\d+)`).exec(stack);
  if (direct) {
    const n = Number(direct[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** A module that starts with `export` is an interface module, whatever the form said. */
function sniffKind(source) {
  return /^[ \t]*export[\s{]/m.test(String(source || '')) ? 'ui' : 'server';
}

/**
 * Line-preserving rewrite of the ES-module export forms into CommonJS.
 *
 * Why not a real parser: there is no dependency budget for one, and
 * `vm.SourceTextModule` needs `--experimental-vm-modules`, which would mean
 * telling every user to start node differently. Why line-preserving: a syntax
 * error must point at the line the user actually sees in the editor, so no
 * rewrite may add or remove a line above the code it touches.
 *
 * Its limits are real and reported rather than hidden: a multi-line
 * `export {...}`, several declarators in one `export const a = 1, b = 2`, and
 * a template literal whose line happens to start with `export ` are not
 * handled. Interface modules are executed in the browser, where they are
 * parsed as real ES modules -- this rewrite only exists so the server can read
 * the manifest and check the syntax.
 */
function rewriteEsm(source) {
  const lines = String(source).split('\n');
  const problems = [];
  const warnings = [];
  const tail = [];
  let touched = 0;

  const exportName = (name) => tail.push(`module.exports[${JSON.stringify(name)}] = ${name};`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (/^[ \t]*import[\s{(]/.test(line) || /^[ \t]*export[ \t]+.*[ \t]from[ \t]/.test(line)) {
      problems.push({
        code: 'ESM_IMPORT',
        line: lineNo,
        message: 'Ein Modul kann nichts importieren. Alles, was es braucht, bekommt es über '
          + '`ctx` (Oberfläche) bzw. `api` (Server). Diese Zeile bitte entfernen.',
      });
      continue;
    }
    if (!/^[ \t]*export\b/.test(line)) continue;
    touched++;

    let m = /^([ \t]*)export[ \t]+default[ \t]+/.exec(line);
    if (m) {
      lines[i] = `${m[1]}module.exports.default = ${line.slice(m[0].length)}`;
      continue;
    }
    m = /^([ \t]*)export[ \t]+(const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/.exec(line);
    if (m) {
      lines[i] = `${m[1]}${m[2]} ${m[3]} =${line.slice(m[0].length)}`;
      exportName(m[3]);
      if (/,[ \t]*[A-Za-z_$][\w$]*[ \t]*=/.test(line.slice(m[0].length))) {
        warnings.push({
          code: 'ESM_MULTI_DECLARATOR',
          line: lineNo,
          message: `Mehrere Deklarationen in einer export-Zeile: nur "${m[3]}" wird exportiert. `
            + 'Schreibe sie lieber einzeln.',
        });
      }
      continue;
    }
    m = /^([ \t]*)export[ \t]+(async[ \t]+function|function|class)[ \t]+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) {
      lines[i] = `${m[1]}${line.slice(m[1].length + 'export'.length).replace(/^[ \t]+/, '')}`;
      exportName(m[3]);
      continue;
    }
    m = /^[ \t]*export[ \t]*\{([^}]*)\}[ \t]*;?[ \t]*$/.exec(line);
    if (m) {
      lines[i] = '';
      for (const raw of m[1].split(',')) {
        const part = raw.trim();
        if (!part) continue;
        const as = /^([A-Za-z_$][\w$]*)[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(part);
        if (as) tail.push(`module.exports[${JSON.stringify(as[2])}] = ${as[1]};`);
        else if (/^[A-Za-z_$][\w$]*$/.test(part)) exportName(part);
      }
      continue;
    }
    problems.push({
      code: 'ESM_UNSUPPORTED',
      line: lineNo,
      message: 'Diese export-Form wird nicht unterstützt. Verwende `export const manifest = {…}` '
        + 'und `export default {…}`, jeweils in einer Zeile beginnend.',
    });
  }

  const out = tail.length ? `${lines.join('\n')}\n${tail.join('')}` : lines.join('\n');
  return { source: out, problems, warnings, rewritten: touched > 0 };
}

/**
 * Pull `manifest` out of source without running it.
 *
 * The fallback for an interface module whose top level touches the browser
 * (`document`, `window`) and therefore cannot run on the server at all. The
 * manifest is a literal by contract, so evaluating just that literal is both
 * possible and harmless.
 */
function extractManifestLiteral(source, timeoutMs = 200) {
  const text = String(source);
  const start = /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+manifest[ \t]*=[ \t]*\{/.exec(text);
  if (!start) return null;
  const open = text.indexOf('{', start.index + start[0].length - 1);
  if (open === -1) return null;
  let depth = 0;
  let end = -1;
  // Good enough for a literal of plain data; a brace inside a string would
  // break it, and then we simply report no manifest rather than a wrong one.
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    const literal = text.slice(open, end + 1);
    const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    const value = new vm.Script(`(${literal})`, { filename: 'manifest.js' })
      .runInContext(ctx, { timeout: timeoutMs });
    return isPlainObject(value) ? toPlain(value) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the sandbox */

/**
 * @param {object} deps
 * @param {object} deps.store        the vault (mandatory)
 * @param {object} [deps.gate]       egress gate; without it `api.fetch` reports honestly
 * @param {object} [deps.bus]
 * @param {object} [deps.registry]   either the model registry or the module
 *                                   registry -- both readings appear in the
 *                                   contract and in app.js, so both are accepted
 * @param {object} [deps.models]     the model registry, unambiguously
 * @param {object} [deps.config]
 * @param {Function|object} [deps.logger]
 * @param {object} [deps.paths]
 * @param {object} [deps.audit]
 */
function createSandbox(deps = {}) {
  const store = deps.store;
  if (!store || typeof store.get !== 'function') {
    throw new ValidationError('createSandbox benötigt einen Store.');
  }
  const bus = deps.bus || null;
  const gate = deps.gate || null;
  const audit = deps.audit || null;
  const config = deps.config || {};
  const loggerDep = deps.logger;
  const log = makeLogger(loggerDep, 'modules');

  /** `registry` is overloaded in the contract; sort it out by shape, not by name. */
  let models = deps.models || (deps.registry && typeof deps.registry.chat === 'function' ? deps.registry : null);
  let moduleRegistry = deps.registry && typeof deps.registry.reportFailure === 'function' ? deps.registry : null;

  /** moduleId -> instance */
  const instances = new Map();
  /** moduleId -> ring buffer of log lines, for the workshop's log panel */
  const logs = new Map();

  function writeAudit(kind, data) {
    if (!audit || typeof audit.write !== 'function') return;
    try { audit.write(kind, data); } catch { /* an audit failure must not break the module */ }
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try { bus.publish(name, payload); } catch { /* the bus already guards its listeners */ }
  }

  function pushLog(moduleId, entry) {
    let buffer = logs.get(moduleId);
    if (!buffer) { buffer = []; logs.set(moduleId, buffer); }
    buffer.push(entry);
    if (buffer.length > MAX_LOG_LINES) buffer.splice(0, buffer.length - MAX_LOG_LINES);
  }

  /** Runtime failures go to the registry, which counts them and switches off. */
  function reportFailure(moduleId, err, where) {
    const e = asNeuralError(err);
    if (moduleRegistry && typeof moduleRegistry.reportFailure === 'function') {
      try {
        moduleRegistry.reportFailure(moduleId, e, where);
        return;
      } catch (inner) {
        log.error(`Fehlerzählung für ${moduleId} fehlgeschlagen: ${inner && inner.message}`);
      }
    }
    log.warn(`Modul ${moduleId} (${where}): ${e.message}`);
    publish('module.failed', { id: moduleId, where, error: { code: e.code, message: e.message } });
  }

  /* ------------------------------------------------------------- the realm */

  /**
   * One vm context plus everything that has to be cleaned up with it.
   * @param {{id:string, name:string, timeoutMs:number}} spec
   */
  function createRealm(spec) {
    const { id, name } = spec;
    const timeoutMs = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0
      ? spec.timeoutMs : DEFAULT_TIMEOUT_MS;
    const filename = spec.filename || 'modul.js';
    const timers = new Set();
    const moduleObject = { exports: {} };
    let disposed = false;

    const moduleLog = makeLogger(loggerDep, `modul:${name}`);

    function emit(level, args) {
      const text = args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
      const line = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
      if (typeof moduleLog[level] === 'function') moduleLog[level](line);
      pushLog(id, { at: new Date().toISOString(), level, text: line });
      publish('module.log', { id, name, level, text: line });
      return line;
    }

    function requireStub(specifier) {
      const key = String(specifier || '');
      const hint = REQUIRE_HINTS[key];
      throw new ValidationError(
        `require(${JSON.stringify(key)}) gibt es in einem Modul nicht. `
        + 'Ein Modul bekommt alles, was es darf, über den api-Parameter von setup(api). '
        + (hint
          ? `Für "${key}" ist das ${hint}.`
          : `Für "${key}" gibt es keine Entsprechung – wenn dir eine Fähigkeit fehlt, `
            + 'fehlt sie dem System, nicht deinem Modul.'),
      );
    }

    function trackTimer(kind, fn, delay, extra) {
      if (disposed) {
        throw new ValidationError(`Das Modul „${name}" ist deaktiviert; es kann keine neuen Zeitgeber mehr setzen.`);
      }
      if (typeof fn !== 'function') {
        throw new ValidationError(`${kind}() benötigt als ersten Parameter eine Funktion.`);
      }
      if (timers.size >= MAX_TIMERS) {
        throw new ValidationError(
          `Das Modul „${name}" hat bereits ${MAX_TIMERS} Zeitgeber laufen. `
          + 'Das ist fast immer eine Schleife, die Zeitgeber erzeugt, statt einem Plan.',
        );
      }
      let ms = Number(delay);
      if (!Number.isFinite(ms) || ms < 0) ms = 0;
      if (kind === 'setInterval' && ms < MIN_INTERVAL_MS) {
        moduleLog.warn(`setInterval(${ms}ms) auf ${MIN_INTERVAL_MS}ms angehoben – kürzer wäre eine Dauerschleife.`);
        ms = MIN_INTERVAL_MS;
      }
      let handle = null;
      const fire = () => {
        if (kind === 'setTimeout') timers.delete(handle);
        if (disposed) return;
        try {
          call(fn, extra, { where: kind });
        } catch (err) {
          reportFailure(id, err, kind);
        }
      };
      handle = kind === 'setTimeout' ? setTimeout(fire, ms) : setInterval(fire, ms);
      // A forgotten timer must never be the reason the process refuses to exit.
      if (handle && typeof handle.unref === 'function') handle.unref();
      timers.add(handle);
      return handle;
    }

    function dropTimer(handle) {
      if (handle === null || handle === undefined) return;
      timers.delete(handle);
      try { clearTimeout(handle); } catch { /* not a timer */ }
      try { clearInterval(handle); } catch { /* not a timer */ }
    }

    /**
     * Globals inside the context.
     *
     * Deliberately NOT listed: `JSON`, `Math`, `Date`, `Promise`, the error
     * types and every other ECMAScript intrinsic. A fresh vm context already
     * has its own, and assigning the host's versions over them would replace
     * clean in-realm objects with references straight back into this process
     * for no gain whatsoever. What is listed here is what node adds on top of
     * the language -- those genuinely do not exist in a bare context.
     */
    const globals = {
      module: moduleObject,
      exports: moduleObject.exports,
      console: {
        log: (...a) => emit('info', a),
        info: (...a) => emit('info', a),
        warn: (...a) => emit('warn', a),
        error: (...a) => emit('error', a),
        debug: (...a) => emit('debug', a),
      },
      setTimeout: (fn, delay, ...extra) => trackTimer('setTimeout', fn, delay, extra),
      setInterval: (fn, delay, ...extra) => trackTimer('setInterval', fn, delay, extra),
      clearTimeout: dropTimer,
      clearInterval: dropTimer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Buffer,
      structuredClone,
      require: requireStub,
    };

    const context = vm.createContext(globals, {
      name: `neural-os:${name}`,
      // Blocks eval() and new Function() inside the module. Neither is needed
      // to write an extension, and both are the shortest route from a mistake
      // to arbitrary code.
      codeGeneration: { strings: false, wasm: false },
    });

    // The call stack lives INSIDE the context so that invoking a module
    // function goes through runInContext -- which is the only place node's
    // timeout watchdog exists. Calling a context function directly from here
    // would run it with no time limit at all.
    vm.runInContext('globalThis.__nosCalls = [];', context);
    const callStack = context.__nosCalls;
    const callScript = new vm.Script(
      'var __c = __nosCalls[__nosCalls.length - 1]; __c.fn.apply(undefined, __c.args);',
      { filename: 'neural-os:aufruf' },
    );

    function describeError(err, where, limitMs) {
      if (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        return new NeuralError(
          'MODULE_TIMEOUT',
          `Das Modul „${name}" hat bei ${where} das Zeitlimit von ${limitMs} ms überschritten `
          + 'und wurde abgebrochen. Häufigste Ursache: eine Schleife ohne Abbruchbedingung.',
          { status: 504, details: { moduleId: id, where, timeoutMs: limitMs } },
        );
      }
      if (err && err.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') {
        return new ValidationError(
          'import(...) gibt es in einem Modul nicht. Alles, was ein Modul darf, '
          + 'bekommt es über den api-Parameter von setup(api).',
        );
      }
      if (err instanceof NeuralError) return err;
      const wrapped = asNeuralError(err);
      const line = lineFromError(err, filename);
      if (line) wrapped.details = { ...(wrapped.details || {}), line, where };
      return wrapped;
    }

    /** Run module code with the watchdog attached. Never call a module fn directly. */
    function call(fn, args = [], opts = {}) {
      if (typeof fn !== 'function') {
        throw new ValidationError(`Das Modul „${name}" hat bei ${opts.where || 'einem Aufruf'} keine Funktion geliefert.`);
      }
      const limitMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : timeoutMs;
      callStack.push({ fn, args: Array.isArray(args) ? args : [] });
      try {
        return callScript.runInContext(context, { timeout: limitMs, displayErrors: true });
      } catch (err) {
        throw describeError(err, opts.where || 'einem Aufruf', limitMs);
      } finally {
        callStack.pop();
      }
    }

    /** Compile and run the module's top level. Returns `module.exports`. */
    function run(source, opts = {}) {
      const limitMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : timeoutMs;
      let script;
      try {
        script = new vm.Script(source, { filename });
      } catch (err) {
        const line = lineFromError(err, filename);
        throw new ValidationError(
          `Der Quelltext lässt sich nicht lesen: ${err.message}`,
          { line, syntax: true },
        );
      }
      try {
        script.runInContext(context, { timeout: limitMs, displayErrors: true });
      } catch (err) {
        throw describeError(err, 'der Auswertung des Quelltextes', limitMs);
      }
      return moduleObject.exports;
    }

    function dispose() {
      disposed = true;
      for (const handle of Array.from(timers)) dropTimer(handle);
      timers.clear();
      try { callStack.length = 0; } catch { /* context already gone */ }
    }

    return {
      id,
      name,
      filename,
      context,
      timers,
      run,
      call,
      dispose,
      get disposed() { return disposed; },
      get exports() { return moduleObject.exports; },
    };
  }

  /* ------------------------------------------------------------ the api */

  /**
   * Build the capability api.
   *
   * The rule that makes this worth anything: a capability that was NOT granted
   * leaves no trace on the object. Not a stub that throws, not a property set
   * to null -- absent. That way `if (api.records)` is a truthful check a module
   * can make, and a module that ignores the check fails with
   * "Cannot read properties of undefined", which says what actually happened,
   * instead of a permission error that reads like the system is broken.
   */
  function buildApi(record, instance, realm, opts = {}) {
    const dryRun = opts.dryRun === true;
    const id = record.id;
    const data = record.data || {};
    const name = data.name || id;
    const granted = new Set(Array.isArray(data.capabilities) ? data.capabilities : []);
    const kind = data.kind === 'ui' ? 'ui' : 'server';

    const api = {
      id,
      name,
      version: Number.isFinite(data.version) ? data.version : 1,
      kind,
      log: (...args) => {
        const text = args.map((a) => (typeof a === 'string' ? a : (() => {
          try { return JSON.stringify(a); } catch { return String(a); }
        })())).join(' ');
        const line = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
        pushLog(id, { at: new Date().toISOString(), level: 'info', text: line });
        publish('module.log', { id, name, level: 'info', text: line });
        return line;
      },
      storage: buildStorage(id, name, dryRun),
    };

    if (granted.has('records.read') || granted.has('records.write')) {
      api.records = buildRecords(id, name, granted, dryRun);
    }
    if (granted.has('bus.listen')) {
      api.on = (eventName, fn) => {
        if (typeof eventName !== 'string' || !eventName.trim()) {
          throw new ValidationError('api.on() benötigt einen Ereignisnamen, z. B. "record.created".');
        }
        if (typeof fn !== 'function') {
          throw new ValidationError('api.on() benötigt eine Funktion als zweiten Parameter.');
        }
        if (!bus || typeof bus.on !== 'function') {
          throw new NeuralError('SUBSYSTEM_UNAVAILABLE',
            'Der Ereignis-Bus ist in dieser Instanz nicht verfügbar; api.on() kann nichts anmelden.',
            { status: 503 });
        }
        const handler = (event) => {
          if (instance.disposed) return;
          try {
            realm.call(fn, [toPlain(event)], { where: `Ereignis ${eventName}` });
          } catch (err) {
            reportFailure(id, err, `Ereignis ${eventName}`);
          }
        };
        bus.on(eventName, handler);
        instance.subscriptions.push(() => bus.off(eventName, handler));
        if (!instance.registered.events.includes(eventName)) instance.registered.events.push(eventName);
        return () => { try { bus.off(eventName, handler); } catch { /* already gone */ } };
      };
    }
    if (granted.has('tools.add')) {
      api.tool = (definition) => registerTool(definition, { id, name, instance, realm });
    }
    if (granted.has('routes.add')) {
      api.route = (method, routePath, handler) => registerRoute(
        method, routePath, handler, { id, name, instance, realm },
      );
    }
    if (granted.has('files.read') || granted.has('files.write')) {
      api.files = buildFiles(record, granted, dryRun);
    }
    if (granted.has('model.use')) {
      api.model = {
        async chat(request = {}) {
          if (dryRun) throw dryRunRefusal('das Sprachmodell aufrufen');
          if (!models || typeof models.chat !== 'function') {
            throw new NoModelError(
              'Es ist kein Modell-Register verfügbar. Das Modul kann das Sprachmodell nicht benutzen – '
              + 'nichts wird erfunden, der Aufruf schlägt fehl.',
            );
          }
          const req = isPlainObject(request) ? request : {};
          const result = await models.chat(req.model ?? null, {
            messages: toPlain(req.messages) || [],
            options: toPlain(req.options) || {},
            scope: capabilities.networkScope(id),
            purpose: `Modul „${name}"`,
          });
          return toPlain(result);
        },
      };
    }
    if (granted.has('net.lan') || granted.has('net.online')) {
      const scope = capabilities.networkScope(id);
      const maxLevel = capabilities.networkLevel(Array.from(granted));
      api.fetch = async (url, init = {}) => {
        if (dryRun) throw dryRunRefusal('etwas aus dem Netz holen');
        if (!gate || typeof gate.fetch !== 'function') {
          throw new NeuralError('SUBSYSTEM_UNAVAILABLE',
            'Die Netzschleuse ist in dieser Instanz nicht verfügbar; ohne sie wird nichts gesendet.',
            { status: 503 });
        }
        const given = isPlainObject(init) ? init : {};
        // Only these travel on. `scope`, `maxLevel` and `allowedHosts` are set
        // by us afterwards: a module that could pass its own would be setting
        // its own network permission.
        const passed = {
          method: given.method,
          headers: toPlain(given.headers),
          body: typeof given.body === 'string' ? given.body : toPlain(given.body),
          timeoutMs: given.timeoutMs,
          maxBytes: given.maxBytes,
          stream: given.stream === true,
        };
        writeAudit('module.fetch', { moduleId: id, module: name, url: String(url).slice(0, 500), maxLevel });
        return gate.fetch(String(url), {
          ...passed,
          scope,
          maxLevel,
          purpose: `Modul „${name}"`,
        });
      };
    }

    return api;
  }

  /* --------------------------------------------------------- api.storage */

  function buildStorage(moduleId, moduleName, dryRun = false) {
    // A trial run gets a scratch copy: checking a module must not leave a
    // trace in the vault, but reading back what you just wrote must still work
    // or half the modules would fail a check they would pass when enabled.
    let scratch = null;
    const readMap = () => {
      if (dryRun) {
        if (!scratch) {
          const current = store.get(moduleId);
          const raw = current && current.data ? current.data.storage : null;
          scratch = isPlainObject(raw) ? JSON.parse(JSON.stringify(raw)) : {};
        }
        return scratch;
      }
      const current = store.get(moduleId);
      const raw = current && current.data ? current.data.storage : null;
      return isPlainObject(raw) ? raw : {};
    };
    const writeMap = (next) => {
      const text = JSON.stringify(next);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_STORAGE_BYTES) {
        throw new ValidationError(
          `Der Speicher des Moduls „${moduleName}" ist voll (${Math.round(bytes / 1024)} KB, `
          + `erlaubt sind ${Math.round(MAX_STORAGE_BYTES / 1024)} KB). `
          + 'Ein Modul soll Einstellungen ablegen, nicht Daten sammeln – dafür sind Einträge da.',
        );
      }
      if (dryRun) { scratch = next; return; }
      store.update(moduleId, { storage: next });
      writeAudit('module.write', { moduleId, module: moduleName, op: 'storage', bytes });
    };
    const keyOf = (key) => {
      if (typeof key !== 'string' || !key.trim()) {
        throw new ValidationError('api.storage benötigt einen nicht-leeren Schlüssel als Text.');
      }
      if (key.length > 200) throw new ValidationError('Der Schlüssel ist zu lang (höchstens 200 Zeichen).');
      return key;
    };

    return {
      get(key) {
        const map = readMap();
        const k = keyOf(key);
        return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
      },
      set(key, value) {
        const k = keyOf(key);
        const map = readMap();
        const plain = toPlain(value);
        if (plain === undefined) {
          throw new ValidationError(
            `api.storage.set("${k}", …) hat keinen speicherbaren Wert bekommen. `
            + 'Funktionen und undefined lassen sich nicht ablegen.',
          );
        }
        map[k] = plain;
        writeMap(map);
        return plain;
      },
      delete(key) {
        const k = keyOf(key);
        const map = readMap();
        if (!Object.prototype.hasOwnProperty.call(map, k)) return false;
        delete map[k];
        writeMap(map);
        return true;
      },
      keys() {
        return Object.keys(readMap());
      },
      all() {
        return readMap();
      },
      clear() {
        writeMap({});
        return true;
      },
      get bytes() {
        return Buffer.byteLength(JSON.stringify(readMap()), 'utf8');
      },
      limitBytes: MAX_STORAGE_BYTES,
    };
  }

  /* --------------------------------------------------------- api.records */

  function buildRecords(moduleId, moduleName, granted, dryRun = false) {
    const readable = (type) => !FORBIDDEN_READ_TYPES.has(type);
    const assertReadable = (type) => {
      if (!readable(type)) {
        throw new PermissionError(
          `Einträge vom Typ "${type}" enthalten Zugangsdaten und stehen Modulen nicht offen.`,
        );
      }
    };
    const assertWritable = (type) => {
      if (FORBIDDEN_WRITE_TYPES.has(type)) {
        throw new PermissionError(
          `Ein Modul darf Einträge vom Typ "${type}" nicht ändern. `
          + 'Über diesen Typ werden Berechtigungen, Zugänge oder die Herkunft von Daten festgelegt – '
          + 'ein Modul könnte sich damit selbst mehr Rechte geben, als du ihm gegeben hast.',
        );
      }
    };
    const readableTypes = () => schema.TYPES.filter(readable);

    const records = {};

    if (granted.has('records.read')) {
      records.get = (recordId) => {
        const found = store.get(String(recordId));
        if (!found) return null;
        assertReadable(found.type);
        return toPlain(found);
      };
      records.list = (type, query = {}) => {
        const wanted = (type === undefined || type === null || type === '*')
          ? readableTypes()
          : (Array.isArray(type) ? type.map(String) : [String(type)]);
        for (const t of wanted) assertReadable(t);
        const q = toPlain(query) || {};
        // A filter function cannot cross the realm boundary safely, and a
        // module that wants one can filter the result itself.
        delete q.filter;
        const result = store.list(wanted.length === 1 ? wanted[0] : wanted, q);
        return toPlain(result.items);
      };
      records.search = (query, opts = {}) => {
        const result = store.search(String(query || ''), toPlain(opts) || {});
        return toPlain(result.items.filter((hit) => readable(hit.record.type)));
      };
      records.edges = {
        for: (recordId, opts = {}) => toPlain(store.edges.for(String(recordId), toPlain(opts) || {})),
      };
    }

    if (granted.has('records.write')) {
      records.create = (type, data) => {
        if (dryRun) throw dryRunRefusal('Einträge anlegen');
        const t = String(type);
        assertWritable(t);
        if (!CREATABLE_TYPES.has(t)) {
          throw new PermissionError(
            `Ein Modul darf keine Einträge vom Typ "${t}" anlegen. `
            + `Erlaubt sind: ${Array.from(CREATABLE_TYPES).join(', ')}.`,
          );
        }
        const created = store.create(t, toPlain(data) || {});
        writeAudit('module.write', { moduleId, module: moduleName, op: 'create', type: t, id: created.id });
        return toPlain(created);
      };
      records.update = (recordId, patch) => {
        if (dryRun) throw dryRunRefusal('Einträge ändern');
        const existing = store.get(String(recordId));
        if (!existing) throw new NotFoundError(`Eintrag ${recordId}`);
        assertWritable(existing.type);
        const updated = store.update(String(recordId), toPlain(patch) || {});
        writeAudit('module.write', { moduleId, module: moduleName, op: 'update', type: existing.type, id: existing.id });
        return toPlain(updated);
      };
      records.remove = (recordId) => {
        if (dryRun) throw dryRunRefusal('Einträge löschen');
        const existing = store.get(String(recordId));
        if (!existing) throw new NotFoundError(`Eintrag ${recordId}`);
        assertWritable(existing.type);
        // Soft delete only: a module must not be able to purge anything.
        const removed = store.remove(String(recordId));
        writeAudit('module.write', { moduleId, module: moduleName, op: 'remove', type: existing.type, id: existing.id });
        return toPlain(removed);
      };
      records.edges = records.edges || {};
      records.edges.add = (spec) => {
        if (dryRun) throw dryRunRefusal('Verknüpfungen anlegen');
        const created = store.edges.add({ ...(toPlain(spec) || {}), source: 'agent' });
        writeAudit('module.write', { moduleId, module: moduleName, op: 'edge.add', id: created.id });
        return toPlain(created);
      };
    }

    return records;
  }

  /* ----------------------------------------------------------- api.files */

  function buildFiles(record, granted, dryRun = false) {
    const moduleId = record.id;
    const moduleName = (record.data && record.data.name) || moduleId;
    const configured = Array.isArray(record.data && record.data.fileRoots) ? record.data.fileRoots : [];
    const roots = configured.filter((r) => typeof r === 'string' && r.trim() && path.isAbsolute(r));

    function noRoots() {
      return new PermissionError(
        `Für das Modul „${moduleName}" ist kein Ordner freigegeben. `
        + 'Die Berechtigung "Dateien lesen/schreiben" wirkt erst, wenn du in der Werkstatt '
        + 'einen Ordner dafür benennst.',
      );
    }

    /**
     * Resolve a module-supplied path and prove it stays inside a shared folder.
     *
     * Two checks, because one is not enough: `safeJoin` stops `../` in the
     * string, and `realpathSync` stops a symlink inside the folder that points
     * out of it. A file that does not exist yet is resolved through its
     * deepest existing ancestor, so `write` is held to the same rule as `read`.
     */
    function resolveInside(input) {
      if (!roots.length) throw noRoots();
      if (typeof input !== 'string' || !input.trim()) {
        throw new ValidationError('api.files benötigt einen Pfad als Text.');
      }
      const realRoots = [];
      for (const root of roots) {
        try { realRoots.push(fs.realpathSync(root)); } catch { /* a root that is gone grants nothing */ }
      }
      if (!realRoots.length) {
        throw new PermissionError(
          `Der freigegebene Ordner für „${moduleName}" existiert nicht (mehr): ${roots.join(', ')}.`,
        );
      }

      const candidates = path.isAbsolute(input)
        ? [path.resolve(input)]
        // A relative path always means "inside the first shared folder", so it
        // is predictable which one it lands in.
        : [safeJoin(roots[0], input)];

      const target = candidates[0];
      let probe = target;
      const missing = [];
      for (;;) {
        if (fs.existsSync(probe)) break;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        missing.unshift(path.basename(probe));
        probe = parent;
      }
      let real;
      try {
        real = path.join(fs.realpathSync(probe), ...missing);
      } catch {
        throw new PermissionError(`Der Pfad "${input}" ist nicht erreichbar.`);
      }
      const inside = realRoots.some((root) => real === root || real.startsWith(root + path.sep));
      if (!inside) {
        throw new PermissionError(
          `"${input}" liegt ausserhalb der für „${moduleName}" freigegebenen Ordner `
          + `(${roots.join(', ')}). Auch ein Verweis (Symlink) aus dem Ordner heraus zählt als ausserhalb.`,
        );
      }
      return real;
    }

    const files = {};

    if (granted.has('files.read')) {
      files.read = (relative) => {
        const target = resolveInside(relative);
        const stat = fs.statSync(target);
        if (!stat.isFile()) throw new ValidationError(`"${relative}" ist keine Datei.`);
        if (stat.size > MAX_FILE_BYTES) {
          throw new ValidationError(
            `"${relative}" ist ${Math.round(stat.size / 1024)} KB gross; Module lesen höchstens `
            + `${Math.round(MAX_FILE_BYTES / 1024)} KB auf einmal.`,
          );
        }
        writeAudit('module.read', { moduleId, module: moduleName, op: 'file.read', path: target });
        return fs.readFileSync(target, 'utf8');
      };
      files.list = (relative = '.') => {
        const target = resolveInside(relative);
        const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, MAX_LIST_ENTRIES);
        return entries.map((entry) => {
          const full = path.join(target, entry.name);
          let size = null;
          try { size = entry.isFile() ? fs.statSync(full).size : null; } catch { /* vanished */ }
          return {
            name: entry.name,
            path: full,
            type: entry.isDirectory() ? 'dir' : (entry.isFile() ? 'file' : 'other'),
            size,
          };
        });
      };
    }

    if (granted.has('files.write')) {
      files.write = (relative, text) => {
        if (dryRun) throw dryRunRefusal('Dateien schreiben');
        if (typeof text !== 'string') {
          throw new ValidationError('api.files.write() schreibt Text; übergib einen String.');
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > MAX_FILE_BYTES) {
          throw new ValidationError(
            `Der Text ist ${Math.round(bytes / 1024)} KB gross; Module schreiben höchstens `
            + `${Math.round(MAX_FILE_BYTES / 1024)} KB auf einmal.`,
          );
        }
        const target = resolveInside(relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Temp file + rename: an interrupted write must not leave a half file
        // where a whole one used to be.
        const tmp = path.join(path.dirname(target), `.nos-modul-${process.pid}-${Date.now()}`);
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, target);
        writeAudit('module.write', { moduleId, module: moduleName, op: 'file.write', path: target, bytes });
        return { path: target, bytes };
      };
    }

    return files;
  }

  /* ------------------------------------------------------ tools + routes */

  function registerTool(definition, owner) {
    const { id, name, instance, realm } = owner;
    if (!isPlainObject(definition)) {
      throw new ValidationError('api.tool() benötigt eine Beschreibung als Objekt.');
    }
    const toolName = String(definition.name || '').trim();
    if (!/^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/.test(toolName)) {
      throw new ValidationError(
        `"${toolName}" ist kein gültiger Werkzeugname. Erwartet wird "bereich.name", `
        + 'nur Kleinbuchstaben und Ziffern, z. B. "statistik.schlagworte".',
      );
    }
    const namespace = toolName.slice(0, toolName.indexOf('.'));
    if (RESERVED_TOOL_NAMESPACES.has(namespace)) {
      throw new ValidationError(
        `Der Bereich "${namespace}." gehört den eingebauten Werkzeugen. Würde ein Modul ihn `
        + 'überschreiben, liefe die Rechteprüfung des Agenten gegen das falsche Werkzeug. '
        + 'Wähle einen eigenen Bereich.',
      );
    }
    if (instance.registered.tools.some((t) => t.name === toolName)) {
      throw new ValidationError(`Das Werkzeug "${toolName}" wurde von diesem Modul bereits angemeldet.`);
    }
    if (typeof definition.run !== 'function') {
      throw new ValidationError(`Dem Werkzeug "${toolName}" fehlt die Funktion run(args, ctx).`);
    }
    const parameters = isPlainObject(definition.parameters)
      ? toPlain(definition.parameters)
      : { type: 'object', properties: {} };
    const fn = definition.run;

    const entry = {
      name: toolName,
      description: String(definition.description || `Werkzeug aus dem Modul „${name}"`).slice(0, 1000),
      parameters,
      moduleId: id,
      moduleName: name,
      /**
       * The toolbox awaits this. Everything the module returns is turned into
       * plain data before it leaves: an agent transcript must not hold a live
       * reference into a module's realm.
       */
      async run(args, ctx = {}) {
        const safeCtx = {
          agentId: (ctx && ctx.agent && ctx.agent.id) || null,
          runId: (ctx && ctx.run && ctx.run.id) || null,
        };
        const result = await realm.call(fn, [toPlain(args) || {}, safeCtx], {
          where: `Werkzeug ${toolName}`,
        });
        return toPlain(result);
      },
    };
    instance.registered.tools.push(entry);
    return entry;
  }

  function registerRoute(method, routePath, handler, owner) {
    const { id, name, instance, realm } = owner;
    const verb = String(method || '').toUpperCase();
    if (!ROUTE_METHODS.has(verb)) {
      throw new ValidationError(
        `"${method}" ist keine gültige Methode. Erlaubt: ${Array.from(ROUTE_METHODS).join(', ')}.`,
      );
    }
    const p = String(routePath || '');
    if (!p.startsWith(ROUTE_PREFIX) || p.length <= ROUTE_PREFIX.length) {
      throw new ValidationError(
        `Die Adresse "${p}" muss mit "${ROUTE_PREFIX}" beginnen. Module bekommen einen eigenen `
        + 'Adressbereich, damit sie keine bestehende Adresse überschreiben können – sonst liesse '
        + 'sich über ein Modul die Rechteprüfung der App umgehen.',
      );
    }
    if (/\s/.test(p) || p.includes('..') || p.includes('//')) {
      throw new ValidationError(`Die Adresse "${p}" enthält unerlaubte Zeichen.`);
    }
    if (typeof handler !== 'function') {
      throw new ValidationError(`Für "${verb} ${p}" fehlt die Behandlungsfunktion.`);
    }
    if (instance.registered.routes.some((r) => r.method === verb && r.path === p)) {
      throw new ValidationError(`"${verb} ${p}" wurde von diesem Modul bereits angemeldet.`);
    }

    const entry = {
      method: verb,
      path: p,
      moduleId: id,
      moduleName: name,
      /**
       * Adapter between the HTTP layer's request context and the plain object
       * a module sees. The module never touches `req`/`res`: it gets data and
       * returns data, so it cannot hijack a response or leak a socket.
       */
      async handler(rc) {
        let body = null;
        if (rc && typeof rc.body === 'function' && verb !== 'GET') {
          try { body = await rc.body(); } catch { body = null; }
        }
        const request = {
          method: verb,
          path: (rc && rc.pathname) || p,
          params: toPlain((rc && rc.params) || {}) || {},
          query: toPlain((rc && rc.query) || {}) || {},
          body: toPlain(body),
        };
        const result = await realm.call(handler, [request], { where: `Adresse ${verb} ${p}` });
        return toPlain(result);
      },
      /** The unwrapped function, for tests and for diagnostics. */
      raw: handler,
    };
    instance.registered.routes.push(entry);
    return entry;
  }

  /* --------------------------------------------------------- public api */

  function emptyRegistered() {
    return { tools: [], routes: [], events: [], views: [] };
  }

  function readManifest(exportsObject, source, kind) {
    let manifest = null;
    if (exportsObject && isPlainObject(exportsObject.manifest)) {
      manifest = toPlain(exportsObject.manifest);
    }
    if (!manifest) manifest = extractManifestLiteral(source);
    if (!manifest) return null;
    return {
      name: typeof manifest.name === 'string' ? manifest.name.trim() : '',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      kind: manifest.kind === 'ui' || manifest.kind === 'server' ? manifest.kind : kind,
      capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
      author: typeof manifest.author === 'string' ? manifest.author : '',
    };
  }

  /**
   * Evaluate source WITHOUT calling `setup()`. This is what the pre-flight
   * check in the workshop uses: it answers "does this compile, and what does it
   * claim to be" without letting the module register anything.
   *
   * @param {string} source
   * @param {{kind?:string, timeoutMs?:number, name?:string}} [opts]
   * @returns {Promise<{manifest:object|null, exports:object, kind:string, realm:object, esm:object|null}>}
   */
  async function evaluate(source, opts = {}) {
    const text = String(source == null ? '' : source);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_SOURCE_BYTES) {
      throw new ValidationError(
        `Der Quelltext ist ${Math.round(bytes / 1024)} KB gross; erlaubt sind `
        + `${Math.round(MAX_SOURCE_BYTES / 1024)} KB. Ein Modul ist ein Werkzeug, kein Programm.`,
      );
    }
    const kind = opts.kind === 'ui' || opts.kind === 'server' ? opts.kind : sniffKind(text);
    const name = opts.name || 'Vorprüfung';
    const esm = kind === 'ui' ? rewriteEsm(text) : null;
    const prepared = esm ? esm.source : text;

    const realm = createRealm({
      id: opts.id || 'preview',
      name,
      timeoutMs: opts.timeoutMs,
    });

    let exportsObject = {};
    let runError = null;
    try {
      exportsObject = realm.run(prepared);
    } catch (err) {
      runError = err;
    } finally {
      // Anything the top level scheduled is a side effect of a check the user
      // asked for, not of a module they enabled. It does not get to keep running.
      realm.dispose();
    }
    // A syntax error is fatal for every kind; a runtime error at the top level
    // is fatal only on the server, where the module really has to run.
    if (runError && (kind === 'server' || (runError.details && runError.details.syntax))) throw runError;

    return {
      manifest: readManifest(exportsObject, text, kind),
      exports: exportsObject,
      kind,
      realm,
      esm,
      /** Set for an interface module whose top level cannot run on the server. */
      runError: runError || null,
    };
  }

  /**
   * Build the api, run `setup(api)` and collect what the module registered.
   *
   * @param {object} record  a `module` record from the store
   * @param {{dryRun?:boolean, timeoutMs?:number}} [opts]
   * @returns {Promise<{api:object, teardown:Function, registered:object, manifest:object|null}>}
   */
  async function instantiate(record, opts = {}) {
    if (!record || !record.id || !record.data) {
      throw new ValidationError('instantiate() benötigt einen module-Datensatz.');
    }
    const id = record.id;
    const data = record.data;
    const name = data.name || id;
    const kind = data.kind === 'ui' ? 'ui' : 'server';
    const dryRun = opts.dryRun === true;

    if (!dryRun && instances.has(id)) {
      throw new ValidationError(`Das Modul „${name}" läuft bereits. Erst deaktivieren, dann neu laden.`);
    }

    const source = String(data.source || '');
    if (!source.trim()) {
      throw new ValidationError(`Das Modul „${name}" hat keinen Quelltext.`);
    }
    const esm = kind === 'ui' ? rewriteEsm(source) : null;
    const prepared = esm ? esm.source : source;

    const realm = createRealm({ id, name, timeoutMs: opts.timeoutMs });
    const instance = {
      id,
      name,
      kind,
      realm,
      registered: emptyRegistered(),
      subscriptions: [],
      teardownFn: null,
      disposed: false,
      startedAt: new Date().toISOString(),
      notes: [],
    };

    /** Always safe to call, never throws, idempotent. */
    const teardown = () => disposeInstance(instance);

    let exportsObject;
    try {
      exportsObject = realm.run(prepared);
    } catch (err) {
      if (kind === 'server') { teardown(); throw err; }
      // An interface module runs in the BROWSER. Its top level may legitimately
      // reach for `document`, which does not exist here. That is not a reason
      // to refuse it -- the browser is where it is really judged.
      exportsObject = realm.exports || {};
      instance.notes.push(
        `Der Quelltext liess sich auf dem Server nicht vollständig auswerten (${err.message}). `
        + 'Bei Oberflächen-Modulen ist das normal, solange es im Browser läuft.',
      );
    }

    const manifest = readManifest(exportsObject, source, kind);
    const api = buildApi(record, instance, realm, { dryRun });

    try {
      if (kind === 'server') {
        if (typeof exportsObject.setup !== 'function') {
          throw new ValidationError(
            `Dem Modul „${name}" fehlt setup(api). Ein Server-Modul sieht so aus: `
            + 'module.exports = { manifest: {…}, setup(api) { … } };',
          );
        }
        let result = realm.call(exportsObject.setup, [api], { where: 'setup(api)' });
        if (result && typeof result.then === 'function') result = await result;
        if (typeof result === 'function') instance.teardownFn = result;
      } else {
        const view = exportsObject.default;
        if (view && typeof view === 'object') {
          instance.registered.views.push({
            id: String(view.id || '').trim() || id,
            title: String(view.title || (manifest && manifest.name) || name),
            icon: typeof view.icon === 'string' ? view.icon : null,
            hasMount: typeof view.mount === 'function',
          });
        } else {
          instance.registered.views.push({
            id,
            title: (manifest && manifest.name) || name,
            icon: null,
            hasMount: false,
          });
          instance.notes.push(
            'Der Standard-Export (export default {…}) konnte auf dem Server nicht gelesen werden; '
            + 'die Ansicht wird erst im Browser sichtbar.',
          );
        }
      }
    } catch (err) {
      teardown();
      throw err;
    }

    if (dryRun) {
      const snapshot = {
        tools: instance.registered.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        routes: instance.registered.routes.map((r) => ({ method: r.method, path: r.path })),
        events: instance.registered.events.slice(),
        views: instance.registered.views.slice(),
      };
      teardown();
      return { api, teardown: () => {}, registered: snapshot, manifest, notes: instance.notes };
    }

    instances.set(id, instance);
    return { api, teardown, registered: instance.registered, manifest, notes: instance.notes };
  }

  /** Never throws: cleaning up must work even when the module is broken. */
  function disposeInstance(instance) {
    if (!instance || instance.disposed) return [];
    instance.disposed = true;
    const problems = [];

    if (typeof instance.teardownFn === 'function') {
      try {
        instance.realm.call(instance.teardownFn, [], {
          where: 'Aufräumen beim Deaktivieren',
          timeoutMs: TEARDOWN_TIMEOUT_MS,
        });
      } catch (err) {
        problems.push(asNeuralError(err).message);
      }
    }
    for (const off of instance.subscriptions) {
      try { off(); } catch (err) { problems.push(String(err && err.message)); }
    }
    instance.subscriptions.length = 0;
    try { instance.realm.dispose(); } catch (err) { problems.push(String(err && err.message)); }
    instance.registered = emptyRegistered();
    instances.delete(instance.id);
    if (problems.length) {
      log.warn(`Beim Deaktivieren von „${instance.name}" gab es Probleme: ${problems.join('; ')}`);
    }
    return problems;
  }

  function dispose(moduleId) {
    const instance = instances.get(moduleId);
    if (!instance) return false;
    disposeInstance(instance);
    return true;
  }

  function disposeAll() {
    for (const instance of Array.from(instances.values())) disposeInstance(instance);
    return true;
  }

  return {
    evaluate,
    instantiate,
    dispose,
    disposeAll,
    has: (moduleId) => instances.has(moduleId),
    get: (moduleId) => instances.get(moduleId) || null,
    /** Every live instance, for the registry's tools()/routes(). */
    live: () => Array.from(instances.values()),
    /** The last log lines a module produced, for the workshop. */
    logTail: (moduleId, n = 50) => (logs.get(moduleId) || []).slice(-n),
    clearLogs: (moduleId) => logs.delete(moduleId),
    /** Late binding: the module registry needs the sandbox to exist first. */
    attachRegistry(value) {
      if (value && typeof value.reportFailure === 'function') moduleRegistry = value;
      return value;
    },
    /** Late binding for the model registry, which app.js creates before us. */
    attachModels(value) {
      if (value && typeof value.chat === 'function') models = value;
      return value;
    },
    get config() { return config; },
  };
}

module.exports = {
  createSandbox,
  rewriteEsm,
  sniffKind,
  lineFromError,
  extractManifestLiteral,
  toPlain,
  ROUTE_PREFIX,
  RESERVED_TOOL_NAMESPACES,
  FORBIDDEN_WRITE_TYPES,
  FORBIDDEN_READ_TYPES,
  CREATABLE_TYPES,
  MAX_STORAGE_BYTES,
  MAX_SOURCE_BYTES,
  DEFAULT_TIMEOUT_MS,
};
