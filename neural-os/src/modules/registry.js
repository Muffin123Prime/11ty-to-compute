'use strict';

/**
 * The register of installed extensions: install, check, enable, undo.
 *
 * The one assumption everything here is built on: THE CODE THE USER PASTES
 * WILL CONTAIN MISTAKES. That is the normal case, not the exception -- it was
 * written for them by an assistant that has never seen their data, and they
 * will paste it to find out whether it works. So the question this file has to
 * answer is not "how do we keep bad modules out" but "what happens afterwards".
 *
 * Three answers, in order of importance:
 *
 * 1. THE APP STILL STARTS. Before a module is loaded, its id is written to
 *    `modules-loading.json`; afterwards the file is deleted. If the file is
 *    still there at the next start, that module took the process down with it,
 *    so it is switched off before anything is loaded. A module that crashes at
 *    load time can therefore cost the user one restart, never two.
 *
 * 2. THE APP STAYS USABLE. Every call into a module is wrapped. Errors are
 *    counted, and after three in a row the module is disabled with the reason
 *    recorded. A broken module degrades itself, not the system.
 *
 * 3. THE USER CAN ALWAYS GET BACK. Every version of the source is kept, and
 *    `rollback()` is the one operation here that never refuses: it works even
 *    when the version being restored no longer validates, because a recovery
 *    path that can fail is not a recovery path.
 *
 * What this file does NOT claim: that a module cannot harm the user. It can --
 * with the capabilities they granted it, and only with those. See the header
 * of `sandbox.js` for the honest version of that story.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  NeuralError,
  ValidationError,
  NotFoundError,
  asNeuralError,
} = require('../kernel/errors');
const capabilities = require('./capabilities');
const sandboxMod = require('./sandbox');

/** After this many consecutive errors a module is switched off. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Keeping every version for ever would grow the vault without bound. */
const MAX_VERSIONS = 50;
const CRASH_FILE = 'modules-loading.json';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

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

/** Trim a stack to something a person can actually read in the workshop. */
function shortStack(err) {
  if (!err || typeof err.stack !== 'string') return null;
  return err.stack.split('\n').slice(0, 8).join('\n');
}

/** A `lastError` as the record schema wants it: an object, never a bare string. */
function errorRecord(err, where) {
  const e = asNeuralError(err);
  const details = isPlainObject(e.details) ? e.details : null;
  return {
    code: e.code,
    message: e.message,
    where: where || null,
    line: details && Number.isInteger(details.line) ? details.line : null,
    at: new Date().toISOString(),
    stack: shortStack(e),
  };
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.sandbox
 * @param {object} [deps.bus]
 * @param {Function|object} [deps.logger]
 * @param {object} [deps.config] accepted for symmetry with the other factories;
 *                                the module time limit lives in the sandbox
 * @param {object} [deps.audit]
 * @param {object} [deps.paths] needed for the crash guard; without it the guard
 *                              is off and says so instead of pretending
 */
function createModuleRegistry(deps = {}) {
  const store = deps.store;
  if (!store || typeof store.get !== 'function') {
    throw new ValidationError('createModuleRegistry benötigt einen Store.');
  }
  const sandbox = deps.sandbox;
  if (!sandbox || typeof sandbox.instantiate !== 'function') {
    throw new ValidationError('createModuleRegistry benötigt eine Sandbox.');
  }
  const bus = deps.bus || null;
  const audit = deps.audit || null;
  const paths = deps.paths || null;
  const log = makeLogger(deps.logger, 'modules');

  /** moduleId -> {registered, teardown, consecutive, loadedAt, notes} */
  const loaded = new Map();
  /**
   * Guards against a failure report feeding itself.
   *
   * Recording a failure writes to the module's record, which publishes
   * `record.updated` -- and a module that listens for `record.updated` and
   * throws would be told about its own error report, throw again, and recurse
   * until the stack gives out. The streak still counts; only the write and the
   * announcement are skipped while one is already in flight for that module.
   */
  const reporting = new Set();
  let safeMode = false;
  /** What the crash guard found at the last loadAll(), for the UI to explain. */
  let lastCrashRecovery = null;

  const crashFile = paths && paths.home ? path.join(paths.home, CRASH_FILE) : null;
  if (!crashFile) {
    log.warn('Ohne paths.home gibt es keine Absturzsicherung für Module.');
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try { bus.publish(name, payload); } catch { /* the bus guards its own listeners */ }
  }

  function writeAudit(kind, data) {
    if (!audit || typeof audit.write !== 'function') return;
    try { audit.write(kind, data); } catch { /* never break on an audit failure */ }
  }

  /* --------------------------------------------------------- crash guard */

  function markLoading(record) {
    if (!crashFile) return;
    try {
      fs.writeFileSync(
        crashFile,
        JSON.stringify({ id: record.id, name: record.data.name, at: new Date().toISOString() }),
        { mode: 0o600 },
      );
    } catch (err) {
      log.warn(`Absturzsicherung konnte nicht geschrieben werden: ${err.message}`);
    }
  }

  function clearLoading() {
    if (!crashFile) return;
    try {
      fs.unlinkSync(crashFile);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Absturzsicherung konnte nicht gelöscht werden: ${err.message}`);
    }
  }

  /** Read and remove the marker. Its presence means: this one took us down. */
  function takeCrashMarker() {
    if (!crashFile) return null;
    let raw;
    try {
      raw = fs.readFileSync(crashFile, 'utf8');
    } catch (err) {
      return null; // ENOENT is the normal, healthy case
    }
    clearLoading();
    try {
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) && typeof parsed.id === 'string' ? parsed : null;
    } catch {
      // An unreadable marker still means something went wrong while loading.
      return { id: null, name: null, at: null, unreadable: true };
    }
  }

  /* ------------------------------------------------------------ records */

  function moduleRecord(id, opts = {}) {
    const record = store.get(String(id));
    if (!record || record.type !== 'module') {
      if (opts.optional) return null;
      throw new NotFoundError(`Modul ${id}`);
    }
    return record;
  }

  function allModules() {
    return store.list('module', { sort: 'createdAt', order: 'asc' }).items;
  }

  function patch(id, changes) {
    try {
      return store.update(String(id), changes);
    } catch (err) {
      // During shutdown the store may already be closed. Losing a failure
      // counter is regrettable; throwing here would be worse.
      log.warn(`Modul ${id} konnte nicht gespeichert werden: ${err && err.message}`);
      return moduleRecord(id, { optional: true });
    }
  }

  /* ---------------------------------------------------------- validation */

  function problemFrom(err, fallbackCode) {
    const e = asNeuralError(err);
    const details = isPlainObject(e.details) ? e.details : {};
    return {
      code: fallbackCode || e.code || 'INVALID',
      message: e.message,
      line: Number.isInteger(details.line) ? details.line : null,
    };
  }

  /**
   * Check source without installing anything.
   *
   * Never throws. A check that throws would leave the workshop with an
   * exception instead of a report, and the report IS the product here: the
   * user needs to see every problem at once, with line numbers, not the first
   * one that happened to be raised.
   *
   * @param {string} source
   * @param {{kind?:string, fileRoots?:string[], capabilities?:string[]}} [opts]
   */
  async function validate(source, opts = {}) {
    const problems = [];
    const warnings = [];
    const text = typeof source === 'string' ? source : '';
    let kind = opts.kind === 'ui' || opts.kind === 'server' ? opts.kind : sandboxMod.sniffKind(text);
    let manifest = null;
    let caps = [];
    let registered = null;

    const report = () => ({
      ok: problems.length === 0,
      kind,
      manifest,
      capabilities: caps,
      risk: capabilities.riskOf(caps),
      description: capabilities.describe(caps, kind),
      registered,
      problems,
      warnings,
    });

    if (!text.trim()) {
      problems.push({ code: 'EMPTY', message: 'Es ist kein Quelltext da, der geprüft werden könnte.', line: null });
      return report();
    }

    let evaluated;
    try {
      evaluated = await sandbox.evaluate(text, { kind });
    } catch (err) {
      problems.push(problemFrom(err, 'SYNTAX'));
      return report();
    }
    kind = evaluated.kind || kind;

    if (evaluated.esm) {
      for (const p of evaluated.esm.problems) problems.push(p);
      for (const w of evaluated.esm.warnings) warnings.push(w);
    }
    if (evaluated.runError) {
      warnings.push({
        code: 'UI_TOPLEVEL',
        line: null,
        message: 'Der Quelltext liess sich auf dem Server nicht ganz auswerten '
          + `(${evaluated.runError.message}). Bei Oberflächen-Modulen ist das in Ordnung, `
          + 'solange es im Browser läuft – prüfen kann das nur der Browser.',
      });
    }

    manifest = evaluated.manifest;
    if (!manifest) {
      problems.push({
        code: 'NO_MANIFEST',
        line: null,
        message: 'Es fehlt das manifest. Ein Server-Modul beginnt mit '
          + '`module.exports = { manifest: { name: "…", kind: "server", capabilities: [] }, setup(api) {…} }`, '
          + 'ein Oberflächen-Modul mit `export const manifest = { name: "…", kind: "ui", capabilities: [] }`.',
      });
      return report();
    }
    if (!manifest.name) {
      problems.push({ code: 'NO_NAME', line: null, message: 'Im manifest fehlt ein name. Ohne Namen kann das Modul nicht angezeigt werden.' });
    }
    if (manifest.kind && manifest.kind !== kind) {
      warnings.push({
        code: 'KIND_MISMATCH',
        line: null,
        message: `Das manifest sagt kind: "${manifest.kind}", der Quelltext sieht aber nach `
          + `"${kind}" aus. Es wird als "${manifest.kind}" behandelt.`,
      });
      kind = manifest.kind;
    }

    try {
      caps = capabilities.validate(manifest.capabilities, kind);
    } catch (err) {
      caps = [];
      problems.push(problemFrom(err, 'CAPABILITIES'));
    }

    if (kind === 'server' && typeof evaluated.exports.setup !== 'function') {
      problems.push({
        code: 'NO_SETUP',
        line: null,
        message: 'Dem Modul fehlt setup(api). Das ist die Funktion, die beim Aktivieren '
          + 'aufgerufen wird und in der du Werkzeuge, Adressen und Ereignisse anmeldest.',
      });
    }
    if (kind === 'ui' && !evaluated.runError && !isPlainObject(evaluated.exports.default)) {
      problems.push({
        code: 'NO_DEFAULT_EXPORT',
        line: null,
        message: 'Dem Oberflächen-Modul fehlt `export default { id, title, mount(container, ctx) {…} }`.',
      });
    }

    const wantsFiles = caps.includes('files.read') || caps.includes('files.write');
    const roots = Array.isArray(opts.fileRoots) ? opts.fileRoots.filter((r) => typeof r === 'string' && r.trim()) : [];
    if (wantsFiles && !roots.length) {
      warnings.push({
        code: 'NO_FILE_ROOTS',
        line: null,
        message: 'Das Modul will Dateien lesen oder schreiben. Solange du keinen Ordner dafür '
          + 'freigibst, kann es keine einzige Datei erreichen – die Berechtigung bleibt wirkungslos.',
      });
    }

    // The trial run: build the real api, call setup(), see what happens, throw
    // it all away again. Nothing is written and nothing is sent.
    if (!problems.length) {
      const preview = {
        id: 'module_probelauf00000000000000',
        type: 'module',
        data: {
          name: manifest.name || 'Probelauf',
          description: manifest.description || '',
          kind,
          source: text,
          version: 1,
          capabilities: caps,
          fileRoots: roots,
        },
      };
      try {
        const result = await sandbox.instantiate(preview, { dryRun: true });
        registered = result.registered;
        for (const note of result.notes || []) warnings.push({ code: 'NOTE', line: null, message: note });
      } catch (err) {
        const e = asNeuralError(err);
        if (e.code === 'MODULE_DRYRUN_WRITE') {
          warnings.push({
            code: 'DRYRUN_WRITE',
            line: null,
            message: `${e.message} Der Probelauf konnte deshalb nicht zu Ende laufen; `
              + 'was danach noch angemeldet würde, steht unten nicht.',
          });
        } else {
          problems.push(problemFrom(err, 'SETUP_FAILED'));
        }
      }
    }

    return report();
  }

  /* ------------------------------------------------------------ install */

  function normaliseRoots(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new ValidationError('fileRoots muss eine Liste von Ordnern sein.');
    const out = [];
    for (const raw of value) {
      const p = String(raw || '').trim();
      if (!p) continue;
      if (!path.isAbsolute(p)) {
        throw new ValidationError(`"${p}" ist kein vollständiger Pfad. Gib den Ordner vollständig an, z. B. /home/du/Notizen.`);
      }
      out.push(path.resolve(p));
    }
    return out;
  }

  function invalid(validation, what) {
    const first = validation.problems[0];
    return new ValidationError(
      `${what} nicht möglich: ${first ? first.message : 'Der Quelltext ist nicht in Ordnung.'}`,
      { validation },
    );
  }

  /**
   * @param {{source:string, note?:string, kind?:string, fileRoots?:string[]}} input
   * @returns {Promise<{record:object, validation:object}>}
   */
  async function install(input = {}) {
    const source = typeof input.source === 'string' ? input.source : '';
    const fileRoots = normaliseRoots(input.fileRoots);
    const validation = await validate(source, { kind: input.kind, fileRoots });
    if (!validation.ok) throw invalid(validation, 'Installieren');

    const note = typeof input.note === 'string' ? input.note.slice(0, 500) : '';
    const record = store.create('module', {
      name: validation.manifest.name,
      description: validation.manifest.description || '',
      kind: validation.kind,
      source,
      version: 1,
      versions: [],
      capabilities: validation.capabilities,
      // Nothing runs until the user says so, having seen the permissions.
      enabled: false,
      lastError: null,
      failures: 0,
      author: validation.manifest.author || '',
      builtin: false,
      fileRoots,
      note,
    });
    writeAudit('module.install', {
      moduleId: record.id, name: record.data.name, kind: record.data.kind,
      capabilities: record.data.capabilities,
    });
    publish('module.installed', { id: record.id, record, validation });
    log.info(`Modul „${record.data.name}" installiert (${record.id}), noch nicht aktiviert.`);
    return { record, validation };
  }

  /* ------------------------------------------------- versions + rollback */

  function highestVersion(data) {
    let max = Number.isFinite(data.version) ? data.version : 1;
    for (const entry of Array.isArray(data.versions) ? data.versions : []) {
      if (Number.isFinite(entry.version) && entry.version > max) max = entry.version;
    }
    return max;
  }

  /** Append the currently active version to the history. Append-only. */
  function archiveCurrent(data, note) {
    const versions = Array.isArray(data.versions) ? data.versions.slice() : [];
    versions.push({
      version: Number.isFinite(data.version) ? data.version : 1,
      source: data.source,
      at: new Date().toISOString(),
      note: typeof note === 'string' ? note : (data.note || ''),
    });
    // Drop from the middle, never the first: version 1 is what the user
    // started from and is the last thing they would want to lose.
    while (versions.length > MAX_VERSIONS) versions.splice(1, 1);
    return versions;
  }

  /**
   * Replace the source. The module is switched off afterwards: new code the
   * user has not seen running must not inherit the previous "yes".
   */
  async function update(id, input = {}) {
    const record = moduleRecord(id);
    const source = typeof input.source === 'string' ? input.source : '';
    if (!source.trim()) throw new ValidationError('Für eine Änderung wird Quelltext gebraucht.');

    const fileRoots = input.fileRoots === undefined
      ? (Array.isArray(record.data.fileRoots) ? record.data.fileRoots : [])
      : normaliseRoots(input.fileRoots);

    const validation = await validate(source, { kind: record.data.kind, fileRoots });
    if (!validation.ok) throw invalid(validation, 'Ändern');

    const wasEnabled = record.data.enabled === true;
    if (loaded.has(record.id)) await deactivate(record.id, 'Änderung');

    const versions = archiveCurrent(record.data);
    const nextVersion = highestVersion(record.data) + 1;
    const note = typeof input.note === 'string' ? input.note.slice(0, 500) : '';

    const updated = patch(record.id, {
      name: validation.manifest.name || record.data.name,
      description: validation.manifest.description || record.data.description,
      source,
      version: nextVersion,
      versions,
      capabilities: validation.capabilities,
      fileRoots,
      enabled: false,
      lastError: null,
      failures: 0,
      note,
    });
    writeAudit('module.update', { moduleId: record.id, version: nextVersion, wasEnabled });
    publish('module.updated', { id: record.id, record: updated, version: nextVersion, validation });
    log.info(`Modul „${updated.data.name}" auf Fassung ${nextVersion} geändert; zum Weiterarbeiten neu aktivieren.`);
    return { record: updated, validation, wasEnabled };
  }

  /**
   * Restore an earlier version.
   *
   * Deliberately the only write operation here that does not refuse invalid
   * code: this is the way back out of a broken state, and a way out that can
   * be blocked is not one. The restored version becomes a NEW version number
   * (the old one keeps its place in the history), so a rollback is itself
   * reversible and no version number ever means two different things.
   */
  async function rollback(id, version) {
    const record = moduleRecord(id);
    const wanted = Number(version);
    if (!Number.isFinite(wanted)) throw new ValidationError('Für den Rückschritt wird eine Fassungsnummer gebraucht.');

    const history = Array.isArray(record.data.versions) ? record.data.versions : [];
    const entry = history.find((v) => Number(v.version) === wanted);
    if (!entry) {
      const known = history.map((v) => v.version).join(', ') || 'keine';
      throw new NotFoundError(`Fassung ${wanted} des Moduls (vorhandene Fassungen: ${known})`);
    }

    if (loaded.has(record.id)) await deactivate(record.id, 'Rückschritt');

    const versions = archiveCurrent(record.data);
    const nextVersion = highestVersion(record.data) + 1;

    // Re-read the manifest of the restored source: an older version may well
    // have asked for different capabilities. If it no longer validates we
    // still restore it -- with the old capability list and disabled.
    let validation = null;
    let caps = record.data.capabilities;
    try {
      validation = await validate(entry.source, { kind: record.data.kind, fileRoots: record.data.fileRoots });
      if (validation.ok) caps = validation.capabilities;
    } catch (err) {
      log.warn(`Fassung ${wanted} konnte nicht geprüft werden: ${err && err.message}`);
    }

    const updated = patch(record.id, {
      source: entry.source,
      version: nextVersion,
      versions,
      capabilities: caps,
      enabled: false,
      lastError: null,
      failures: 0,
      note: `Zurück zu Fassung ${wanted}`,
    });
    writeAudit('module.rollback', { moduleId: record.id, from: record.data.version, to: wanted, newVersion: nextVersion });
    publish('module.updated', {
      id: record.id, record: updated, version: nextVersion, rolledBackFrom: record.data.version, rolledBackTo: wanted,
    });
    log.info(`Modul „${updated.data.name}": Fassung ${wanted} wiederhergestellt (jetzt Fassung ${nextVersion}).`);
    return { record: updated, validation, restoredFrom: wanted };
  }

  /* ------------------------------------------------------ enable/disable */

  /** Load one module. Returns a result instead of throwing, so loadAll() survives. */
  async function activate(record) {
    const id = record.id;
    markLoading(record);
    try {
      const result = await sandbox.instantiate(record);
      loaded.set(id, {
        registered: result.registered,
        teardown: result.teardown,
        consecutive: 0,
        loadedAt: new Date().toISOString(),
        notes: result.notes || [],
        name: record.data.name,
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: asNeuralError(err) };
    } finally {
      // Whatever happened, we got here -- so the process did not die and the
      // marker must go, or the next start would disable an innocent module.
      clearLoading();
    }
  }

  async function deactivate(id, reason) {
    const entry = loaded.get(id);
    if (entry && typeof entry.teardown === 'function') {
      try { entry.teardown(); } catch (err) { log.warn(`Aufräumen von ${id} schlug fehl: ${err && err.message}`); }
    }
    loaded.delete(id);
    try { sandbox.dispose(id); } catch { /* already gone */ }
    if (reason) log.debug(`Modul ${id} abgeschaltet (${reason}).`);
    return true;
  }

  /**
   * @param {string} id
   * @param {{capabilities?:string[]}} [opts] the permissions the user confirmed.
   *   Fewer than the module asked for is allowed -- more is not.
   */
  async function enable(id, opts = {}) {
    const record = moduleRecord(id);
    if (safeMode) {
      throw new NeuralError('SAFE_MODE',
        'Der abgesicherte Start ist aktiv: es wird kein Modul geladen. Starte Neural OS ohne --safe, '
        + 'um wieder Module zu aktivieren.',
        { status: 409 });
    }
    if (loaded.has(record.id)) return { record, alreadyRunning: true };

    let confirmed = Array.isArray(record.data.capabilities) ? record.data.capabilities.slice() : [];
    if (opts.capabilities !== undefined) {
      if (!Array.isArray(opts.capabilities)) {
        throw new ValidationError('capabilities muss eine Liste der bestätigten Berechtigungen sein.');
      }
      const asked = new Set(confirmed);
      const extra = opts.capabilities.map(String).filter((c) => !asked.has(c));
      if (extra.length) {
        throw new ValidationError(
          `Diese Berechtigungen hat das Modul gar nicht verlangt: ${extra.join(', ')}. `
          + 'Mehr zu erlauben, als verlangt wurde, ergibt keinen Sinn – weniger schon.',
        );
      }
      confirmed = opts.capabilities.map(String);
    }

    const prepared = confirmed.join(',') === (record.data.capabilities || []).join(',')
      ? record
      : patch(record.id, { capabilities: confirmed });

    const outcome = await activate(prepared);
    if (!outcome.ok) {
      const lastError = errorRecord(outcome.error, 'Aktivieren');
      const failed = patch(record.id, {
        enabled: false,
        lastError,
        failures: (record.data.failures || 0) + 1,
      });
      writeAudit('module.enable.failed', { moduleId: record.id, code: lastError.code, reason: lastError.message });
      publish('module.failed', { id: record.id, record: failed, where: 'Aktivieren', error: lastError });
      throw new NeuralError('MODULE_FAILED',
        `Das Modul „${record.data.name}" liess sich nicht aktivieren: ${lastError.message}`,
        { status: 400, details: { moduleId: record.id, lastError } });
    }

    const enabled = patch(record.id, { enabled: true, lastError: null, failures: 0 });
    writeAudit('module.enable', { moduleId: record.id, name: record.data.name, capabilities: confirmed });
    publish('module.enabled', {
      id: record.id,
      record: enabled,
      registered: summariseRegistered(outcome.result.registered),
    });
    log.info(`Modul „${record.data.name}" ist aktiv.`);
    return { record: enabled, registered: summariseRegistered(outcome.result.registered), notes: outcome.result.notes };
  }

  async function disable(id, opts = {}) {
    const record = moduleRecord(id);
    await deactivate(record.id, opts.reason || 'Nutzerwunsch');
    const updated = patch(record.id, { enabled: false });
    writeAudit('module.disable', { moduleId: record.id, reason: opts.reason || 'user' });
    publish('module.disabled', { id: record.id, record: updated, reason: opts.reason || null });
    return updated;
  }

  /* --------------------------------------------------------- failures */

  /**
   * One error out of a running module. Called by the sandbox for every event
   * handler, timer, tool and route that threw.
   *
   * Consecutive failures are counted in memory, the total in the record. The
   * in-memory counter is what disables the module, so a module that works
   * again is not punished for something that happened an hour ago -- and a
   * successful call does not cost a disk write to say so.
   */
  function reportFailure(id, err, where) {
    const entry = loaded.get(id);
    const e = asNeuralError(err);
    const lastError = errorRecord(e, where);
    if (entry) entry.consecutive += 1;

    if (reporting.has(id)) return lastError;
    reporting.add(id);
    try {
      const record = moduleRecord(id, { optional: true });
      if (record) {
        patch(id, { lastError, failures: (record.data.failures || 0) + 1 });
      }
      writeAudit('module.error', { moduleId: id, where, code: e.code, reason: e.message });
      publish('module.failed', { id, where, error: lastError });
      log.warn(`Modul ${record ? `„${record.data.name}"` : id} (${where}): ${e.message}`);
    } finally {
      reporting.delete(id);
    }

    if (!entry) return lastError;
    if (entry.consecutive >= MAX_CONSECUTIVE_FAILURES && !entry.stopping) {
      entry.stopping = true;
      log.warn(`Modul ${id} wird nach ${entry.consecutive} Fehlern in Folge abgeschaltet.`);
      // Fire and forget: this is called from inside a failing callback, and
      // the caller has no way to await anything.
      Promise.resolve()
        .then(() => deactivate(id, 'zu viele Fehler'))
        .then(() => {
          patch(id, { enabled: false, lastError });
          writeAudit('module.autodisable', { moduleId: id, failures: entry.consecutive, reason: e.message });
          publish('module.disabled', {
            id,
            reason: `${entry.consecutive} Fehler in Folge`,
            error: lastError,
            automatic: true,
          });
        })
        .catch((inner) => log.error(`Abschalten von ${id} schlug fehl: ${inner && inner.message}`));
    }
    return lastError;
  }

  /** A call that worked clears the streak, without touching the disk. */
  function reportSuccess(id) {
    const entry = loaded.get(id);
    if (entry) entry.consecutive = 0;
  }

  /* ------------------------------------------------------------ loadAll */

  /**
   * Start everything the user enabled. Never throws: a start that fails
   * because of an extension is exactly the situation this whole file exists
   * to prevent.
   */
  async function loadAll(opts = {}) {
    safeMode = opts.safeMode === true;
    const records = allModules();
    const wanted = records.filter((r) => r.data.enabled === true);

    lastCrashRecovery = null;
    const marker = takeCrashMarker();
    if (marker) {
      const victim = marker.id ? moduleRecord(marker.id, { optional: true }) : null;
      if (victim) {
        const lastError = {
          code: 'MODULE_CRASH',
          message: `Beim letzten Start hat „${victim.data.name}" die App mitgerissen. `
            + 'Das Modul wurde abgeschaltet, damit du wieder hereinkommst. In der Werkstatt '
            + 'kannst du den Quelltext ansehen, eine frühere Fassung wiederherstellen oder es entfernen.',
          where: 'Laden',
          line: null,
          at: new Date().toISOString(),
          stack: null,
        };
        patch(victim.id, { enabled: false, lastError, failures: (victim.data.failures || 0) + 1 });
        writeAudit('module.crash', { moduleId: victim.id, name: victim.data.name, at: marker.at });
        publish('module.disabled', { id: victim.id, reason: 'Absturz beim letzten Start', error: lastError, automatic: true });
        log.error(`Modul „${victim.data.name}" hat den letzten Start abgebrochen und ist jetzt aus.`);
        lastCrashRecovery = { id: victim.id, name: victim.data.name, at: marker.at };
      } else {
        log.warn('Eine Absturzspur von Modulen wurde gefunden, das Modul selbst aber nicht mehr.');
        lastCrashRecovery = { id: marker.id, name: marker.name || null, at: marker.at || null, missing: true };
      }
    }

    if (safeMode) {
      log.warn(`Abgesicherter Start: ${wanted.length} Modul(e) bleiben aus.`);
      publish('module.safemode', { count: wanted.length });
      return { loaded: 0, failed: 0, disabled: wanted.length, safeMode: true, crashRecovery: lastCrashRecovery };
    }

    let ok = 0;
    let failed = 0;
    for (const record of wanted) {
      // Re-read: the crash guard above may have just disabled this one.
      const fresh = moduleRecord(record.id, { optional: true });
      if (!fresh || fresh.data.enabled !== true) continue;
      const outcome = await activate(fresh);
      if (outcome.ok) {
        ok++;
        publish('module.enabled', {
          id: fresh.id, record: fresh, registered: summariseRegistered(outcome.result.registered), atStartup: true,
        });
      } else {
        failed++;
        const lastError = errorRecord(outcome.error, 'Laden beim Start');
        patch(fresh.id, { enabled: false, lastError, failures: (fresh.data.failures || 0) + 1 });
        writeAudit('module.load.failed', { moduleId: fresh.id, code: lastError.code, reason: lastError.message });
        publish('module.failed', { id: fresh.id, where: 'Laden beim Start', error: lastError });
        log.error(`Modul „${fresh.data.name}" konnte nicht geladen werden und ist jetzt aus: ${lastError.message}`);
      }
    }

    const result = {
      loaded: ok,
      failed,
      disabled: records.filter((r) => r.data.enabled !== true).length,
      safeMode: false,
      crashRecovery: lastCrashRecovery,
    };
    writeAudit('modules.loadAll', result);
    return result;
  }

  /* --------------------------------------------------------- inspection */

  function summariseRegistered(registered) {
    const r = registered || {};
    return {
      tools: (r.tools || []).map((t) => ({ name: t.name, description: t.description })),
      routes: (r.routes || []).map((x) => ({ method: x.method, path: x.path })),
      events: (r.events || []).slice(),
      views: (r.views || []).slice(),
    };
  }

  /** The list for the workshop: everything except the sources, which are big. */
  function list() {
    return allModules().map((record) => {
      const live = loaded.get(record.id);
      const versions = Array.isArray(record.data.versions) ? record.data.versions : [];
      return {
        id: record.id,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        name: record.data.name,
        description: record.data.description,
        kind: record.data.kind,
        version: record.data.version,
        versions: versions.map((v) => ({
          version: v.version,
          at: v.at,
          note: v.note || '',
          bytes: Buffer.byteLength(String(v.source || ''), 'utf8'),
        })),
        capabilities: record.data.capabilities,
        risk: capabilities.riskOf(record.data.capabilities),
        description_permissions: capabilities.describe(record.data.capabilities, record.data.kind),
        enabled: record.data.enabled === true,
        loaded: !!live,
        lastError: record.data.lastError || null,
        failures: record.data.failures || 0,
        fileRoots: Array.isArray(record.data.fileRoots) ? record.data.fileRoots : [],
        author: record.data.author || '',
        builtin: record.data.builtin === true,
        registered: live ? summariseRegistered(live.registered) : null,
        notes: live ? live.notes : [],
      };
    });
  }

  /** Everything about one module, sources included. */
  function get(id) {
    const record = moduleRecord(id, { optional: true });
    if (!record) return null;
    const live = loaded.get(record.id);
    return {
      ...record,
      loaded: !!live,
      registered: live ? summariseRegistered(live.registered) : null,
      notes: live ? live.notes : [],
      risk: capabilities.riskOf(record.data.capabilities),
      permissions: capabilities.describe(record.data.capabilities, record.data.kind),
      log: typeof sandbox.logTail === 'function' ? sandbox.logTail(record.id, 100) : [],
    };
  }

  /** Soft delete: the record keeps its tombstone, so nothing is truly lost. */
  async function remove(id) {
    const record = moduleRecord(id);
    await deactivate(record.id, 'Entfernen');
    const removed = store.remove(record.id);
    if (typeof sandbox.clearLogs === 'function') sandbox.clearLogs(record.id);
    writeAudit('module.remove', { moduleId: record.id, name: record.data.name });
    publish('module.removed', { id: record.id, record: removed });
    log.info(`Modul „${record.data.name}" entfernt.`);
    return removed;
  }

  /** Every tool every live module provides, for agents/tools.js. */
  function tools() {
    const out = [];
    for (const entry of loaded.values()) {
      for (const tool of entry.registered.tools || []) out.push(tool);
    }
    return out;
  }

  /** Every route every live module provides, for the router. */
  function routes() {
    const out = [];
    for (const entry of loaded.values()) {
      for (const route of entry.registered.routes || []) out.push(route);
    }
    return out;
  }

  function status() {
    const records = allModules();
    return {
      total: records.length,
      loaded: loaded.size,
      failed: records.filter((r) => r.data.lastError).length,
      disabled: records.filter((r) => r.data.enabled !== true).length,
      safeMode,
      crashRecovery: lastCrashRecovery,
    };
  }

  async function disposeAll() {
    for (const id of Array.from(loaded.keys())) await deactivate(id, 'Herunterfahren');
    if (typeof sandbox.disposeAll === 'function') sandbox.disposeAll();
    clearLoading();
    return true;
  }

  const registry = {
    validate,
    install,
    update,
    rollback,
    enable,
    disable,
    loadAll,
    list,
    get,
    remove,
    tools,
    routes,
    status,
    reportFailure,
    reportSuccess,
    disposeAll,
    /** For the HTTP layer: the capability catalogue the workshop renders. */
    capabilities: (kind) => capabilities.forKind(kind === 'ui' ? 'ui' : 'server'),
    isLoaded: (id) => loaded.has(id),
    get safeMode() { return safeMode; },
  };

  // The sandbox needs to be able to count failures, but it is created first.
  if (typeof sandbox.attachRegistry === 'function') sandbox.attachRegistry(registry);

  return registry;
}

module.exports = {
  createModuleRegistry,
  MAX_CONSECUTIVE_FAILURES,
  MAX_VERSIONS,
  CRASH_FILE,
};
