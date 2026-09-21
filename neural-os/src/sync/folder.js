'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');

const defaultMerge = require('./merge');
const {
  NeuralError,
  ValidationError,
  StorageError,
  LockedError,
  asNeuralError,
} = require('../kernel/errors');

/**
 * Synchronisation through a shared FOLDER -- a USB stick, an external disk, a
 * folder two machines both happen to see. No network, no server, no partner
 * that has to be switched on at the same time.
 *
 * Why this exists next to src/sync/peer.js
 * ----------------------------------------
 * If the whole installation lives on the stick, nothing needs to be
 * synchronised at all: the data IS where the user is. This module is for the
 * OTHER case -- a computer that holds its own vault and wants to be brought
 * together with the one on the stick. The two cases must not be confused, so
 * they are separate code paths with separate words in the interface.
 *
 * What is NOT reinvented here
 * ---------------------------
 * Every decision about who wins, what is a conflict and what may travel at
 * all comes from `merge.js` -- the same module the network sync uses. This
 * file is transport and side effects only: read bytes, write bytes, apply a
 * plan somebody else made. A second copy of the conflict rule would sooner or
 * later disagree with the first one, and the user would lose work at whichever
 * of the two is wrong.
 *
 * Nothing in this file talks to the network. Not through `fetch`, not through
 * `http.request`, not indirectly: the only I/O is `node:fs` inside the folder
 * the user pointed at and inside their own home directory.
 *
 * The mailbox layout
 * ------------------
 *   <folder>/<deviceId>/manifest.json      who wrote this, when, how much
 *   <folder>/<deviceId>/records.jsonl.gz   one record per line, gzip
 *
 * Every device writes ONLY into its own subfolder and reads the others. A
 * device therefore cannot damage another one's data even with a bug, and two
 * devices writing at the same moment cannot collide.
 *
 * The stick is pulled out mid-write
 * ---------------------------------
 * Everything is written to `.tmp-*` in the same directory and renamed at the
 * end, records first, manifest last. The manifest is the commit marker: a
 * mailbox without one was never finished. The manifest also carries the size
 * and the SHA-256 of the records file, which is what catches the other way
 * this goes wrong -- the user copying the folder in their file manager and
 * unplugging halfway through. A mailbox that fails either check is reported
 * and skipped. It is never read halfway.
 */

/** Wire version of the mailbox layout. Bumped when the on-disk shape changes. */
const FOLDER_PROTOCOL = 1;
/** Written into every manifest so a foreign folder cannot be mistaken for ours. */
const FORMAT = 'neural-os-folder-sync';

const MANIFEST_NAME = 'manifest.json';
const RECORDS_NAME = 'records.jsonl.gz';
const TMP_PREFIX = '.tmp-';
const STATE_FILE = 'sync-folder.json';
const STATE_VERSION = 1;

/** Same shape peer.js generates, so one installation is one device everywhere. */
const DEVICE_ID_RE = /^dev_[0-9a-f]{24}$/;

/** A manifest is a handful of fields; anything bigger is not one. */
const MAX_MANIFEST_BYTES = 64 * 1024;
/** Records are applied in batches so memory stays bounded on a large vault. */
const BATCH_SIZE = 500;
/**
 * Edges are held back until every node in the mailbox has been applied,
 * because an edge whose endpoints are not there yet gets refused. They are
 * small; if there are absurdly many, the buffer is flushed early and said so.
 */
const MAX_DEFERRED_EDGES = 20000;
/** A single line longer than this is damage, not data. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Above this the agreed-state table stops being a sensible single file. */
const MAX_BASES = 50000;
/** A mailbox nobody has refreshed in this long is probably a dead device. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Leftover temp files older than this are from a run that never finished. */
const TMP_STALE_MS = 60 * 60 * 1000;
/** A result list is for a human to look at, not a second copy of the vault. */
const MAX_RESULTS = 2000;
const MAX_WARNINGS = 50;

function nowIso() {
  return new Date().toISOString();
}

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

function notFound(message) {
  return new NeuralError('NOT_FOUND', message, { status: 404 });
}

function mailboxInvalid(message, details) {
  return new NeuralError('SYNC_MAILBOX_INVALID', message, { status: 409, details: details || null });
}

/**
 * Turn a filesystem failure into something the user can act on. A stick is
 * full, write-protected or simply gone far more often than a hard disk is,
 * and "EACCES" on a screen helps nobody.
 */
function storageError(err, what) {
  const code = err && err.code;
  if (code === 'ENOSPC') {
    return new StorageError(
      `Auf dem Datenträger ist kein Platz mehr frei. ${what} wurde nicht geschrieben; `
      + 'der bisherige Stand im Postfach bleibt unverändert. Schaffe Platz und versuche es erneut.',
    );
  }
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
    return new StorageError(
      `${what} ist nicht möglich: der Ordner ist schreibgeschützt oder dieser Benutzer darf dort nicht schreiben `
      + `(${code}). Bei einem Stick hilft oft, ihn neu anzustecken oder den Schreibschutzschalter zu prüfen.`,
    );
  }
  if (code === 'ENOENT') {
    return notFound(`${what} ist fehlgeschlagen: der Ordner oder die Datei ist nicht mehr da. Wurde der Stick abgezogen?`);
  }
  if (code === 'EIO' || code === 'EBUSY') {
    return new StorageError(
      `${what} ist fehlgeschlagen: der Datenträger antwortet nicht mehr (${code}). `
      + 'Sehr wahrscheinlich wurde er abgezogen oder ist defekt. Es wurde nichts Halbes geschrieben.',
    );
  }
  return new StorageError(`${what} ist fehlgeschlagen: ${err && err.message ? err.message : String(err)}`);
}

/** Directory fsync: best effort, unsupported on several filesystems. */
function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* the rename is still atomic there, only the ordering guarantee is weaker */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseTime(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * @param {object} deps
 * @param {object} deps.store        record store (required)
 * @param {object} [deps.merge]      merge rules; defaults to the real ./merge
 * @param {object} [deps.bus]
 * @param {Function|object} [deps.logger]
 * @param {object} [deps.config]
 * @param {object} [deps.vaultCrypto]
 * @param {object} deps.paths        layout; `home` is where the agreed state lives
 * @returns {object} FolderSync
 */
function createFolderSync(deps = {}) {
  const store = deps.store;
  if (!store || typeof store.create !== 'function' || typeof store.list !== 'function') {
    throw new ValidationError('createFolderSync benötigt einen Store.');
  }
  const paths = deps.paths;
  if (!paths || typeof paths.home !== 'string' || !paths.home) {
    throw new ValidationError('createFolderSync benötigt paths.home; dort wird gespeichert, was mit welchem Gerät bereits abgeglichen wurde.');
  }
  const merge = deps.merge && typeof deps.merge.plan === 'function' ? deps.merge : defaultMerge;
  const bus = deps.bus || null;
  const config = deps.config && typeof deps.config === 'object' ? deps.config : {};
  const vaultCrypto = deps.vaultCrypto || null;
  const log = typeof deps.logger === 'function' ? deps.logger('sync.folder') : (deps.logger || nullLogger());

  const appVersion = safeAppVersion();
  const deviceId = ensureDeviceId();
  const statePath = path.join(paths.home, STATE_FILE);

  /** One folder operation at a time: two clicks must not write the same mailbox twice. */
  let running = null;

  /** @type {{v:number, devices:object}|null} lazily loaded, kept in memory */
  let state = null;

  function safeAppVersion() {
    try {
      return require('../../package.json').version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * The same identifier peer.js uses. A device has ONE identity, whether it
   * synchronises over the network or over a stick -- otherwise the same
   * computer would appear twice and merge with itself.
   */
  function ensureDeviceId() {
    if (!config.sync || typeof config.sync !== 'object') config.sync = {};
    const existing = config.sync.deviceId;
    if (typeof existing === 'string' && DEVICE_ID_RE.test(existing)) return existing;
    const created = `dev_${crypto.randomBytes(12).toString('hex')}`;
    config.sync.deviceId = created;
    if (paths && paths.config) {
      try {
        require('../kernel/config').save(paths.config, config);
      } catch (err) {
        log.warn(`Die Geräte-Kennung konnte nicht gespeichert werden (${err && err.message}); sie gilt nur für diesen Prozess.`);
      }
    }
    return created;
  }

  /**
   * The name other devices see in the folder listing. It is written to the
   * stick in clear text on purpose -- without it nobody can tell two mailboxes
   * apart -- which is exactly why it is configurable: `config.sync.deviceName`
   * overrides the machine's hostname for anyone who would rather not have it
   * travel on an object that gets lost.
   */
  function deviceName() {
    const configured = config.sync && typeof config.sync.deviceName === 'string' ? config.sync.deviceName.trim() : '';
    if (configured) return configured.slice(0, 100);
    try {
      const host = os.hostname();
      if (host) return String(host).slice(0, 100);
    } catch {
      /* hostname is unavailable in some containers */
    }
    return `Gerät ${deviceId.slice(4, 10)}`;
  }

  function emit(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`Bus-Ereignis ${name} fehlgeschlagen: ${err && err.message}`);
    }
  }

  function claim(what) {
    if (running) {
      throw new ValidationError(`Es läuft bereits ein Ordner-Abgleich (${running}). Warte, bis er fertig ist.`);
    }
    running = what;
    return () => { running = null; };
  }

  /** A progress callback belongs to the caller; a throw in it is not our failure. */
  function reporter(onProgress) {
    if (typeof onProgress !== 'function') return () => {};
    return (payload) => {
      try {
        onProgress(payload);
      } catch (err) {
        log.debug(`onProgress hat geworfen: ${err && err.message}`);
      }
    };
  }

  /* ------------------------------------------------------------ encryption */

  const vault = {
    get enabled() {
      return !!(vaultCrypto && vaultCrypto.enabled);
    },
    /** 'disabled' | 'locked' | 'unlocked' */
    get state() {
      if (!vault.enabled) return 'disabled';
      const reported = vaultCrypto.state;
      return reported === 'locked' || reported === 'unlocked' ? reported : 'unlocked';
    },
    encrypt(buf) {
      if (!vault.enabled) return buf;
      if (typeof vaultCrypto.encryptBuffer !== 'function') {
        throw new NeuralError(
          'SUBSYSTEM_UNAVAILABLE',
          'Der Vault ist verschlüsselt, aber die Verschlüsselung stellt kein encryptBuffer bereit. '
          + 'Es wird nichts im Klartext auf den Stick geschrieben.',
          { status: 503 },
        );
      }
      return vaultCrypto.encryptBuffer(buf);
    },
    decrypt(buf) {
      if (typeof vaultCrypto?.decryptBuffer !== 'function') {
        throw new NeuralError(
          'SUBSYSTEM_UNAVAILABLE',
          'Das Postfach ist verschlüsselt, aber dieses Gerät stellt keine Entschlüsselung bereit.',
          { status: 503 },
        );
      }
      return vaultCrypto.decryptBuffer(buf);
    },
  };

  function requireUnlocked(what) {
    if (vault.enabled && vault.state === 'locked') {
      throw new LockedError(
        `Der Vault ist gesperrt. ${what} braucht den Schlüssel; entsperre zuerst mit der Passphrase.`,
      );
    }
  }

  /* ---------------------------------------------------------- agreed state */

  function emptyState() {
    return { v: STATE_VERSION, devices: {} };
  }

  /**
   * What this device and another one last agreed on, per record. Losing this
   * file costs no data: records that are identical on both sides are
   * recognised as identical anyway. It only costs conflicts the user would
   * otherwise not have been asked about, so a damaged file is reported and
   * replaced rather than treated as a disaster.
   */
  function loadState() {
    if (state) return state;
    let raw;
    try {
      raw = fs.readFileSync(statePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn(`${STATE_FILE} ist nicht lesbar (${err.message}); der nächste Abgleich beginnt ohne gemeinsamen Stand.`);
      }
      state = emptyState();
      return state;
    }
    state = decodeState(raw);
    return state;
  }

  function decodeState(raw) {
    const attempts = raw.length && raw[0] === 0x7b /* '{' */
      ? [() => raw.toString('utf8'), () => vault.decrypt(raw).toString('utf8')]
      : [() => vault.decrypt(raw).toString('utf8'), () => raw.toString('utf8')];
    for (const attempt of attempts) {
      try {
        const parsed = JSON.parse(attempt());
        if (parsed && typeof parsed === 'object' && parsed.devices && typeof parsed.devices === 'object') {
          return { v: STATE_VERSION, devices: parsed.devices };
        }
      } catch {
        /* try the other encoding before giving up */
      }
    }
    log.warn(`${STATE_FILE} ist beschädigt oder mit einem anderen Schlüssel geschrieben; `
      + 'der nächste Abgleich beginnt ohne gemeinsamen Stand und fragt im Zweifel nach.');
    return emptyState();
  }

  function saveState() {
    if (!state) return;
    const json = Buffer.from(JSON.stringify(state), 'utf8');
    let payload = json;
    try {
      payload = vault.enabled ? vault.encrypt(json) : json;
    } catch (err) {
      // Writing fingerprints of every record in clear text next to an
      // encrypted vault would be a quiet downgrade. Skip the write instead.
      log.warn(`${STATE_FILE} konnte nicht verschlüsselt werden (${asNeuralError(err).message}); es wurde nichts geschrieben.`);
      return;
    }
    const tmp = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, statePath);
      fsyncDir(path.dirname(statePath));
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      log.warn(`${STATE_FILE} konnte nicht gespeichert werden (${err.message}); der nächste Abgleich fragt im Zweifel nach.`);
    }
  }

  function deviceState(remoteId) {
    const s = loadState();
    if (!s.devices[remoteId] || typeof s.devices[remoteId] !== 'object') {
      s.devices[remoteId] = { bases: {}, lastPullAt: null, deviceName: null };
    }
    const entry = s.devices[remoteId];
    if (!entry.bases || typeof entry.bases !== 'object' || Array.isArray(entry.bases)) entry.bases = {};
    return entry;
  }

  /**
   * A conflict the user has already decided is an agreement too. Without this,
   * choosing "keep my version" would raise the very same conflict again on the
   * next sync, for ever: the decision changes what this device holds but not
   * what the two devices last agreed on.
   */
  function basesFromResolvedConflicts(remoteId, bases) {
    let resolved;
    try {
      resolved = store.list('conflict', {
        filter: (r) => r.data.status === 'resolved'
          && r.data.origin === 'folder'
          && r.data.originDeviceId === remoteId,
        limit: 5000,
      }).items;
    } catch (err) {
      log.warn(`Gelöste Konflikte konnten nicht gelesen werden: ${err && err.message}`);
      return bases;
    }
    for (const record of resolved) {
      const remote = record.data.remote;
      if (!remote || typeof remote.id !== 'string') continue;
      const at = record.data.resolvedAt || record.updatedAt;
      const known = bases[remote.id];
      const knownAt = known && typeof known === 'object' ? known.at : null;
      // Newest agreement wins: a decision taken after the last merge replaces
      // the base that merge recorded, and never the other way round.
      if (knownAt && at && knownAt >= at) continue;
      bases[remote.id] = { h: merge.fingerprint(remote), at: at || nowIso(), note: 'resolved' };
    }
    return bases;
  }

  /* --------------------------------------------------------------- folder */

  /**
   * @param {string} input
   * @param {{write?:boolean}} [opts]
   * @returns {string} absolute path
   */
  function resolveFolder(input, opts = {}) {
    const text = String(input === undefined || input === null ? '' : input).trim();
    if (!text) {
      throw new ValidationError(
        'Es wurde kein Ordner angegeben. Wähle den Ordner auf dem Stick, in dem die Postfächer liegen sollen, '
        + 'zum Beispiel E:\\neural-os-sync oder /Volumes/STICK/neural-os-sync.',
      );
    }
    const abs = path.resolve(text);

    // The vault is an append-only log the store owns. Dropping mailbox files
    // into it would mix two storage layers that recover differently.
    if (paths.vault && isInside(abs, paths.vault)) {
      throw new ValidationError(
        `${abs} liegt im Vault dieses Geräts. Der Abgleich-Ordner muss ausserhalb liegen, sonst vermischen sich `
        + 'Datenbestand und Austauschablage.',
      );
    }

    let stats;
    try {
      stats = fs.statSync(abs);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw notFound(
          `Der Ordner ${abs} existiert nicht. Ist der Stick angesteckt und trägt er denselben Laufwerksbuchstaben `
          + 'wie beim letzten Mal?',
        );
      }
      throw storageError(err, `Der Ordner ${abs}`);
    }
    if (!stats.isDirectory()) {
      throw new ValidationError(`${abs} ist kein Ordner, sondern eine Datei.`);
    }

    if (opts.write) {
      try {
        fs.accessSync(abs, fs.constants.W_OK);
      } catch {
        // Some filesystems have no permission model at all and answer this
        // wrongly in both directions, so it is a warning path, not a verdict:
        // the real answer comes from the write itself.
        log.debug(`Schreibrecht auf ${abs} ist laut Betriebssystem nicht gegeben; der Schreibversuch entscheidet.`);
      }
    }
    return abs;
  }

  function mailboxDir(folder, id) {
    if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) {
      throw new ValidationError(`"${String(id).slice(0, 60)}" ist keine gültige Geräte-Kennung.`);
    }
    // Defence in depth: the id is validated above, so this can only ever fail
    // if that regex is later loosened.
    const dir = path.resolve(folder, id);
    if (!isInside(dir, folder)) {
      throw new ValidationError('Die Geräte-Kennung zeigt aus dem Abgleich-Ordner heraus.');
    }
    return dir;
  }

  /* ------------------------------------------------------------- writing */

  async function writeFileAtomic(target, buffer, what) {
    const dir = path.dirname(target);
    const tmp = path.join(dir, `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    let handle = null;
    try {
      handle = await fs.promises.open(tmp, 'wx', 0o600);
      await handle.writeFile(buffer);
      try {
        await handle.sync();
      } catch {
        /* exFAT and some network mounts refuse fsync; the rename still orders */
      }
      await handle.close();
      handle = null;
      await fs.promises.rename(tmp, target);
      fsyncDir(dir);
    } catch (err) {
      if (handle) { try { await handle.close(); } catch { /* already gone */ } }
      try { await fs.promises.unlink(tmp); } catch { /* nothing to clean */ }
      throw storageError(err, what);
    }
  }

  /** Leftovers from a run that was interrupted. They only take up space. */
  async function sweepTmp(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - TMP_STALE_MS;
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const full = path.join(dir, name);
      try {
        const stats = await fs.promises.stat(full);
        // A fresh temp file may belong to a second process writing right now.
        if (stats.mtimeMs > cutoff) continue;
        await fs.promises.unlink(full);
        removed++;
      } catch {
        /* someone else cleaned it up, or we may not; either is fine */
      }
    }
    return removed;
  }

  async function hasTmp(dir) {
    try {
      const entries = await fs.promises.readdir(dir);
      return entries.some((name) => name.startsWith(TMP_PREFIX));
    } catch {
      return false;
    }
  }

  const gzipAsync = (buf) => new Promise((resolve, reject) => {
    zlib.gzip(buf, (err, out) => (err ? reject(err) : resolve(out)));
  });

  /**
   * Everything this device holds that is allowed to travel.
   *
   * `merge.SYNC_TYPES` is the only list consulted. Access tokens, network
   * grants, agents with their permissions, the partner list, runs, approvals
   * and modules are not on it, and a stick that is plugged into somebody
   * else's computer must not hand out rights, network access or executable
   * code there. The second check inside the loop is not redundant: it is the
   * line that has to hold even if the store ever returns something unexpected.
   */
  function collectLocal(report) {
    const lines = [];
    let count = 0;
    for (const type of merge.SYNC_TYPES) {
      if (!merge.isSyncable(type)) continue;
      const items = store.list(type, { includeDeleted: true }).items;
      for (const record of items) {
        if (!record || !merge.isSyncable(record.type)) continue;
        lines.push(JSON.stringify(record));
        count++;
      }
      report({ phase: 'collect', type, done: count });
    }
    return { lines, count };
  }

  /**
   * Write this device's state into its own mailbox.
   *
   * @param {string} folder
   * @param {{onProgress?:Function}} [opts]
   * @returns {Promise<{written:number, bytes:number, deviceId:string, at:string, encrypted:boolean, warnings:string[]}>}
   */
  async function publish(folder, opts = {}) {
    const release = claim('Veröffentlichen');
    try {
      const report = reporter(opts.onProgress);
      const dir = resolveFolder(folder, { write: true });
      requireUnlocked('Das Schreiben ins Postfach');

      const mine = mailboxDir(dir, deviceId);
      try {
        await fs.promises.mkdir(mine, { recursive: true });
      } catch (err) {
        throw storageError(err, `Das Anlegen des Postfachs ${deviceId}`);
      }
      const sweptTmp = await sweepTmp(mine);

      report({ phase: 'collect', done: 0 });
      const { lines, count } = collectLocal(report);

      report({ phase: 'compress', done: count, total: count });
      let payload;
      try {
        // The store keeps every record in memory anyway, so streaming the
        // write would save nothing here; the compressed copy is the smaller
        // one of the two. Reading is a different matter -- see readRecords().
        payload = await gzipAsync(Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8'));
      } catch (err) {
        throw new StorageError(`Die Daten konnten nicht gepackt werden: ${err && err.message}`);
      }
      const encrypted = vault.enabled;
      if (encrypted) payload = vault.encrypt(payload);

      const at = nowIso();
      const manifest = {
        protocol: FOLDER_PROTOCOL,
        format: FORMAT,
        deviceId,
        deviceName: deviceName(),
        at,
        count,
        appVersion,
        encrypted,
        bytes: payload.length,
        sha256: crypto.createHash('sha256').update(payload).digest('hex'),
      };

      report({ phase: 'write', done: 0, total: payload.length });
      // Records first, manifest last: the manifest is the commit marker, so a
      // run that dies in between leaves a mailbox that is recognisably
      // unfinished instead of one that lies about its contents.
      await writeFileAtomic(path.join(mine, RECORDS_NAME), payload, 'Das Schreiben der Datensätze');
      await writeFileAtomic(
        path.join(mine, MANIFEST_NAME),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
        'Das Schreiben der Beschreibungsdatei',
      );
      report({ phase: 'write', done: payload.length, total: payload.length });

      const warnings = [];
      if (!encrypted) {
        warnings.push(
          `Der Vault dieses Geräts ist nicht verschlüsselt, deshalb liegen ${count} Einträge im Klartext auf dem `
          + 'Datenträger -- lesbar für jeden, der ihn findet. Schalte die Verschlüsselung in den Einstellungen ein, '
          + 'wenn der Stick das Haus verlässt.',
        );
      }
      if (sweptTmp) {
        warnings.push(`${sweptTmp} Reste eines abgebrochenen Schreibvorgangs wurden entfernt.`);
      }

      log.info(`${count} Einträge (${payload.length} Bytes) nach ${mine} geschrieben.`);
      emit('sync.folder', { action: 'published', folder: dir, deviceId, count, bytes: payload.length, encrypted });

      return { written: count, bytes: payload.length, deviceId, at, encrypted, warnings, path: mine };
    } finally {
      release();
    }
  }

  /* ------------------------------------------------------------- reading */

  function validateManifest(raw, expectedId) {
    const problems = [];
    if (!raw || typeof raw !== 'object') return ['Die Beschreibungsdatei enthält kein Objekt.'];
    if (raw.protocol !== FOLDER_PROTOCOL) {
      problems.push(`Das Postfach ist in Version ${JSON.stringify(raw.protocol)} geschrieben, dieses Gerät versteht `
        + `Version ${FOLDER_PROTOCOL}.`);
    }
    if (raw.format !== undefined && raw.format !== FORMAT) {
      problems.push('Die Beschreibungsdatei gehört nicht zu Neural OS.');
    }
    if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) {
      problems.push('Die Geräte-Kennung in der Beschreibungsdatei fehlt oder ist ungültig.');
    } else if (raw.deviceId !== expectedId) {
      problems.push(`Der Ordner heisst ${expectedId}, die Beschreibungsdatei nennt aber ${raw.deviceId}. `
        + 'Wurde der Ordner umbenannt oder kopiert?');
    }
    if (!Number.isInteger(raw.count) || raw.count < 0) problems.push('Die Anzahl der Einträge fehlt.');
    if (!Number.isInteger(raw.bytes) || raw.bytes < 0) problems.push('Die Grösse der Datensatzdatei fehlt.');
    if (!isHex64(raw.sha256)) {
      problems.push('Die Prüfsumme fehlt. Ohne sie lässt sich nicht feststellen, ob das Postfach vollständig ist, '
        + 'und es wird nichts daraus gelesen.');
    }
    if (parseTime(raw.at) === null) problems.push('Der Zeitstempel fehlt oder ist unlesbar.');
    return problems;
  }

  /**
   * Read one mailbox's metadata. Cheap on purpose: the expensive integrity
   * check (hashing the records file) happens in pull(), right before anything
   * would be written.
   */
  async function readMailbox(folder, id) {
    const dir = path.join(folder, id);
    const entry = {
      deviceId: id,
      deviceName: null,
      at: null,
      count: null,
      appVersion: null,
      encrypted: null,
      isSelf: id === deviceId,
      stale: false,
      skewMs: null,
      bytes: 0,
      ok: false,
      problem: null,
      path: dir,
    };

    let raw;
    try {
      const stats = await fs.promises.stat(path.join(dir, MANIFEST_NAME));
      if (stats.size > MAX_MANIFEST_BYTES) {
        entry.problem = 'Die Beschreibungsdatei ist unplausibel gross und wird nicht gelesen.';
        return entry;
      }
      raw = await fs.promises.readFile(path.join(dir, MANIFEST_NAME), 'utf8');
    } catch (err) {
      entry.problem = err.code === 'ENOENT'
        ? (await hasTmp(dir)
          ? 'Dieses Postfach wird gerade geschrieben oder der Schreibvorgang wurde abgebrochen. '
            + 'Es wird übersprungen, bis es vollständig ist.'
          : 'Dem Postfach fehlt die Beschreibungsdatei; es ist unvollständig und wird übersprungen.')
        : `Die Beschreibungsdatei ist nicht lesbar: ${err.message}`;
      return entry;
    }

    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      entry.problem = `Die Beschreibungsdatei ist beschädigt (kein gültiges JSON): ${err.message}`;
      return entry;
    }

    entry.deviceName = typeof manifest.deviceName === 'string' ? manifest.deviceName.slice(0, 100) : null;
    entry.at = typeof manifest.at === 'string' ? manifest.at : null;
    entry.count = Number.isInteger(manifest.count) ? manifest.count : null;
    entry.appVersion = typeof manifest.appVersion === 'string' ? manifest.appVersion : null;
    entry.encrypted = manifest.encrypted === true;
    entry.bytes = Number.isInteger(manifest.bytes) ? manifest.bytes : 0;

    const problems = validateManifest(manifest, id);
    if (problems.length) {
      entry.problem = problems.join(' ');
      return entry;
    }

    let stats;
    try {
      stats = await fs.promises.stat(path.join(dir, RECORDS_NAME));
    } catch (err) {
      entry.problem = err.code === 'ENOENT'
        ? 'Die Datensatzdatei fehlt, obwohl die Beschreibungsdatei da ist. Das Postfach ist unvollständig.'
        : `Die Datensatzdatei ist nicht lesbar: ${err.message}`;
      return entry;
    }
    if (stats.size !== manifest.bytes) {
      entry.problem = `Die Datensatzdatei ist ${stats.size} Bytes gross, die Beschreibungsdatei nennt `
        + `${manifest.bytes}. Das Postfach wurde nur halb geschrieben oder nur halb kopiert und wird übersprungen.`;
      return entry;
    }

    const at = parseTime(manifest.at);
    const now = Date.now();
    entry.skewMs = at === null ? null : at - now;
    entry.stale = at !== null && now - at > STALE_AFTER_MS;
    entry.sha256 = manifest.sha256;
    entry.ok = true;
    return entry;
  }

  /**
   * Every mailbox in the folder, this device's own included (marked `isSelf`).
   * A mailbox that is half-written, damaged or from an incompatible version is
   * listed with `ok:false` and a `problem` the user can read -- it is never
   * silently dropped and never half-read.
   *
   * @param {string} folder
   * @returns {Promise<Array>}
   */
  async function peers(folder) {
    const dir = resolveFolder(folder, { write: false });
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw storageError(err, `Das Lesen des Ordners ${dir}`);
    }

    const out = [];
    for (const item of entries) {
      if (!item.isDirectory()) continue;
      if (DEVICE_ID_RE.test(item.name)) {
        out.push(await readMailbox(dir, item.name));
        continue;
      }
      // Unrelated folders are none of our business -- unless they claim to be
      // a mailbox, in which case staying quiet would hide a real problem.
      const claimsToBe = fs.existsSync(path.join(dir, item.name, MANIFEST_NAME));
      if (!claimsToBe) continue;
      out.push({
        deviceId: item.name,
        deviceName: null,
        at: null,
        count: null,
        appVersion: null,
        encrypted: null,
        isSelf: false,
        stale: false,
        skewMs: null,
        bytes: 0,
        ok: false,
        problem: `"${item.name}" sieht aus wie ein Postfach, trägt aber keine gültige Geräte-Kennung als Ordnernamen. `
          + 'Es wird nicht gelesen.',
        path: path.join(dir, item.name),
      });
    }

    out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return out;
  }

  async function hashFile(file, report) {
    const hash = crypto.createHash('sha256');
    let done = 0;
    try {
      const stream = fs.createReadStream(file);
      for await (const chunk of stream) {
        hash.update(chunk);
        done += chunk.length;
        report({ phase: 'verify', done });
      }
    } catch (err) {
      throw storageError(err, 'Das Prüfen der Datensatzdatei');
    }
    return { digest: hash.digest('hex'), bytes: done };
  }

  /**
   * A byte source for the records file.
   *
   * Plain mailboxes are streamed straight off the disk, which keeps memory
   * flat no matter how large the vault is. An encrypted mailbox cannot be
   * streamed: it is sealed as one authenticated block, and handing out bytes
   * before the authentication tag has been checked would mean trusting data
   * that might have been tampered with. So it is decrypted as a whole -- the
   * memory cost is the price of not trusting unverified bytes -- and from
   * there the LINE handling is the same code for both.
   */
  function byteSource(file, encrypted) {
    if (!encrypted) return fs.createReadStream(file);
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (err) {
      throw storageError(err, 'Das Lesen der Datensatzdatei');
    }
    let plain;
    try {
      plain = vault.decrypt(buf);
    } catch (err) {
      throw mailboxInvalid(
        'Das Postfach ist verschlüsselt und lässt sich mit dem Schlüssel dieses Geräts nicht öffnen. '
        + 'Es wurde nichts eingelesen. Achtung: jeder Vault hat einen eigenen Zufallsschlüssel -- dieselbe '
        + 'Passphrase allein genügt nicht. Damit sich zwei Geräte verschlüsselt über einen Datenträger abgleichen '
        + 'können, muss die secrets.json des ersten Geräts auf das zweite übernommen worden sein. '
        + `(${asNeuralError(err).message})`,
      );
    }
    return Readable.from([plain]);
  }

  /* ----------------------------------------------------- applying a plan */

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

  /** Edge endpoints are immutable in the store, so they are never patched. */
  function patchFor(record) {
    const data = { ...(record.data || {}) };
    if (record.type === 'edge') {
      delete data.from;
      delete data.to;
      delete data.kind;
    }
    return data;
  }

  /**
   * Carry out ONE entry of a plan. This mirrors `applyOne` in src/sync/peer.js
   * deliberately, refusal for refusal: a record that would end up dangling
   * (an edge without endpoints, a file whose content is not here) is not
   * written at all. The decision of WHAT to apply was made by `merge.plan`;
   * this only executes it.
   */
  function applyOne(entry) {
    const remote = entry.record;
    const { action } = entry;

    if (remote.type === 'edge') {
      if (action === 'update' || action === 'restore') {
        const local = store.get(remote.id, { includeDeleted: true });
        const moved = local && ['from', 'to', 'kind'].filter((k) => local.data[k] !== remote.data[k]);
        if (moved && moved.length) {
          return {
            status: 'skipped',
            reason: 'edge-identity-changed',
            detail: `Die Verknüpfung zeigt auf dem anderen Gerät woanders hin (${moved.join(', ')}). `
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
      // Blobs are not part of the mailbox. Writing the record anyway would
      // produce an entry that looks like a file and fails the moment anyone
      // opens it.
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

  function upsertConflict(remoteId, folder, conflict) {
    const open = store.list('conflict', {
      filter: (r) => r.data.recordId === conflict.recordId
        && r.data.status === 'open'
        && r.data.origin === 'folder'
        && r.data.originDeviceId === remoteId,
      limit: 1,
    }).items;

    const payload = {
      recordId: conflict.recordId,
      recordType: conflict.recordType,
      peerId: null,
      origin: 'folder',
      originDeviceId: remoteId,
      originFolder: folder,
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
   * MUST run inside `store.transaction()` so records and conflicts land
   * together or not at all.
   */
  function applyPlan(planned, ctx) {
    const bases = {};
    const results = [];
    let applied = 0;
    let skipped = 0;

    const push = (row) => { if (results.length < MAX_RESULTS) results.push(row); };

    for (const entry of planned.identical) {
      bases[entry.id] = { h: entry.hash, at: nowIso() };
    }

    for (const entry of planned.apply) {
      let outcome;
      try {
        outcome = applyOne(entry);
      } catch (err) {
        const neural = asNeuralError(err);
        outcome = { status: 'rejected', reason: neural.code, detail: neural.message };
      }
      if (outcome.status === 'applied') {
        applied++;
        bases[entry.id] = { h: entry.hash, at: nowIso() };
        push({ id: entry.id, type: entry.type, status: 'applied', action: outcome.action, rev: outcome.rev });
      } else {
        skipped++;
        if (outcome.note) bases[entry.id] = { h: entry.hash, at: nowIso(), note: outcome.note };
        push({ id: entry.id, type: entry.type, status: outcome.status, reason: outcome.reason, detail: outcome.detail });
      }
    }

    for (const entry of planned.skip) {
      skipped++;
      push({ id: entry.id, type: entry.type, status: 'skipped', reason: entry.reason, detail: entry.detail });
    }

    for (const conflict of planned.conflicts) {
      // The local record is deliberately NOT touched. This is the exact point
      // where a synchronisation either keeps the user's work or eats it.
      const record = upsertConflict(ctx.remoteId, ctx.folder, conflict);
      push({
        id: conflict.recordId,
        type: conflict.recordType,
        status: 'conflict',
        conflictId: record ? record.id : null,
        detail: conflict.reason,
      });
    }

    return { results, bases, applied, skipped, conflicts: planned.conflicts.length };
  }

  /* ------------------------------------------------------------------ pull */

  /**
   * Read another device's mailbox and merge it in.
   *
   * @param {string} folder
   * @param {{deviceId:string, onProgress?:Function}} opts
   * @returns {Promise<{fetched:number, applied:number, conflicts:number, skipped:number, warnings:string[]}>}
   */
  async function pull(folder, opts = {}) {
    const release = claim('Einlesen');
    try {
      return await pullUnguarded(folder, opts);
    } finally {
      release();
    }
  }

  async function pullUnguarded(folder, opts = {}) {
    const report = reporter(opts.onProgress);
    const dir = resolveFolder(folder, { write: false });
    const remoteId = opts.deviceId;
    if (typeof remoteId !== 'string' || !DEVICE_ID_RE.test(remoteId)) {
      throw new ValidationError('Für das Einlesen muss angegeben werden, von welchem Gerät gelesen werden soll.');
    }
    if (remoteId === deviceId) {
      throw new ValidationError(
        'Das ist das eigene Postfach. Ein Gerät kann sich nicht mit sich selbst abgleichen; jeder Eintrag würde sich verdoppeln.',
      );
    }
    requireUnlocked('Das Einlesen eines Postfachs');

    const box = await readMailbox(dir, remoteId);
    if (!box.ok) {
      throw mailboxInvalid(`Das Postfach von ${box.deviceName || remoteId} wurde nicht eingelesen: ${box.problem}`, {
        deviceId: remoteId,
      });
    }
    if (box.encrypted && !vault.enabled) {
      throw mailboxInvalid(
        `Das Postfach von "${box.deviceName || remoteId}" ist verschlüsselt, der Vault dieses Geräts aber nicht. `
        + 'Ohne den Schlüssel des anderen Geräts lässt es sich nicht lesen -- und dieselbe Passphrase allein '
        + 'genügt nicht, weil jeder Vault einen eigenen Zufallsschlüssel hat. Übernimm die secrets.json des '
        + 'anderen Geräts, dann können sich beide verschlüsselt abgleichen.',
      );
    }

    const warnings = [];
    const addWarning = (text) => { if (warnings.length < MAX_WARNINGS) warnings.push(text); };

    if (!box.encrypted && vault.enabled) {
      addWarning(`Das Postfach von "${box.deviceName || remoteId}" liegt im Klartext auf dem Datenträger, `
        + 'obwohl dieses Gerät verschlüsselt speichert.');
    }
    if (box.stale) {
      addWarning(`Das Postfach von "${box.deviceName || remoteId}" wurde zuletzt am ${box.at} geschrieben und ist `
        + 'seitdem nicht aktualisiert worden.');
    }

    /**
     * There is no handshake in a folder: the only statement about the other
     * device's clock is the timestamp it wrote. It is measured against ours,
     * and a large difference is reported AND handed to merge.plan, which then
     * turns incoming deletions into conflicts instead of carrying them out.
     */
    const clockSkewMs = Number.isFinite(box.skewMs) ? box.skewMs : 0;
    if (Math.abs(clockSkewMs) > merge.DEFAULT_SKEW_TOLERANCE_MS) {
      const msg = `Die Uhr von "${box.deviceName || remoteId}" weicht um ${Math.round(Math.abs(clockSkewMs) / 1000)} `
        + 'Sekunden von dieser ab. Zeitstempel taugen damit nicht als Entscheidungsgrundlage; eingehende Löschungen '
        + 'werden deshalb als Konflikt vorgelegt statt ausgeführt.';
      addWarning(msg);
      log.warn(msg);
      emit('sync.warning', { kind: 'clock-skew', deviceId: remoteId, clockSkewMs, message: msg });
    }

    const file = path.join(box.path, RECORDS_NAME);

    // Pass one: prove the file is intact BEFORE a single record is written.
    // Half-applying a truncated mailbox and finding out afterwards is exactly
    // the failure this project refuses to ship.
    const { digest, bytes } = await hashFile(file, report);
    if (bytes !== box.bytes || digest !== box.sha256) {
      throw mailboxInvalid(
        `Das Postfach von "${box.deviceName || remoteId}" ist unvollständig oder beschädigt (Prüfsumme stimmt nicht). `
        + 'Wahrscheinlich wurde der Datenträger während des Schreibens oder Kopierens abgezogen. '
        + 'Es wurde nichts eingelesen. Lass das andere Gerät sein Postfach neu schreiben.',
        { deviceId: remoteId },
      );
    }

    const entry = deviceState(remoteId);
    const bases = basesFromResolvedConflicts(remoteId, { ...entry.bases });

    const totals = { fetched: 0, applied: 0, conflicts: 0, skipped: 0, identical: 0, corrupt: 0 };
    const refusedTypes = new Map();
    const results = [];
    const baseUpdates = {};
    let resultsTruncated = false;

    const collectResults = (rows) => {
      for (const row of rows) {
        if (results.length >= MAX_RESULTS) { resultsTruncated = true; break; }
        results.push(row);
      }
    };

    const flush = (batch) => {
      if (!batch.length) return;
      const locals = new Map();
      for (const rec of batch) {
        const local = store.get(rec.id, { includeDeleted: true });
        if (local) locals.set(local.id, local);
      }
      const planned = merge.plan(locals, batch, { bases }, { clockSkewMs });
      for (const text of planned.warnings) addWarning(text);

      const outcome = store.transaction(() => applyPlan(planned, { remoteId, folder: dir }));

      Object.assign(bases, outcome.bases);
      Object.assign(baseUpdates, outcome.bases);
      totals.applied += outcome.applied;
      totals.skipped += outcome.skipped;
      totals.conflicts += outcome.conflicts;
      totals.identical += planned.identical.length;
      collectResults(outcome.results);
      report({ phase: 'apply', done: totals.fetched, total: box.count });
    };

    let batch = [];
    /** Edges wait for their endpoints; see MAX_DEFERRED_EDGES. */
    let deferredEdges = [];

    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        totals.corrupt++;
        return;
      }
      if (!record || typeof record.id !== 'string' || typeof record.type !== 'string') {
        totals.corrupt++;
        return;
      }
      // The security line of this module. merge.plan would refuse these too,
      // but a stick coming out of somebody else's computer is exactly the case
      // where the refusal must not depend on a single check.
      if (!merge.isSyncable(record.type)) {
        refusedTypes.set(record.type, (refusedTypes.get(record.type) || 0) + 1);
        return;
      }
      totals.fetched++;
      if (record.type === 'edge') {
        deferredEdges.push(record);
        if (deferredEdges.length >= MAX_DEFERRED_EDGES) {
          addWarning(`Es lagen mehr als ${MAX_DEFERRED_EDGES} Verknüpfungen im Postfach; sie wurden vorzeitig `
            + 'angewendet. Verknüpfungen, deren Einträge erst später kamen, holt der nächste Abgleich nach.');
          const pending = deferredEdges;
          deferredEdges = [];
          for (let i = 0; i < pending.length; i += BATCH_SIZE) flush(pending.slice(i, i + BATCH_SIZE));
        }
        return;
      }
      batch.push(record);
      if (batch.length >= BATCH_SIZE) {
        const ready = batch;
        batch = [];
        flush(ready);
      }
    };

    // Opened before the loop below so that "this mailbox cannot be decrypted"
    // stays the precise error it is instead of being wrapped in a report about
    // a partially applied run that never started.
    const source = byteSource(file, box.encrypted);

    try {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let discarding = false;

      await pipeline(
        source,
        zlib.createGunzip(),
        async function consume(chunks) {
          for await (const chunk of chunks) {
            pending += decoder.write(chunk);
            let index = pending.indexOf('\n');
            while (index !== -1) {
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              if (discarding) {
                // We dropped a runaway line; resume at the next newline.
                discarding = false;
              } else {
                handleLine(line);
              }
              index = pending.indexOf('\n');
            }
            if (pending.length > MAX_LINE_BYTES) {
              // A line this long is damage. Drop it, count it and carry on --
              // one broken line must not cost the whole synchronisation.
              totals.corrupt++;
              pending = '';
              discarding = true;
            }
          }
          pending += decoder.end();
          if (pending.trim() && !discarding) handleLine(pending);
        },
      );

      flush(batch);
      batch = [];
      for (let i = 0; i < deferredEdges.length; i += BATCH_SIZE) {
        flush(deferredEdges.slice(i, i + BATCH_SIZE));
      }
      deferredEdges = [];
    } catch (err) {
      const neural = asNeuralError(err);
      // The cause could be either side of the loop -- a damaged file, or the
      // store refusing to write -- so the original code is kept rather than
      // relabelling a storage failure as a bad mailbox. What is added is the
      // one thing the user needs to hear: how much of the run already landed.
      const code = neural.code === 'INTERNAL_ERROR' ? 'SYNC_MAILBOX_INVALID' : neural.code;
      throw new NeuralError(
        code,
        `Der Abgleich mit dem Postfach von "${box.deviceName || remoteId}" wurde abgebrochen: ${neural.message} `
        + `${totals.applied} Einträge waren zu diesem Zeitpunkt bereits übernommen; sie bleiben gültig, und ein `
        + 'erneuter Abgleich setzt dort fort, ohne etwas zu verdoppeln.',
        {
          status: neural.status && neural.status !== 500 ? neural.status : 409,
          cause: err,
          details: { deviceId: remoteId, applied: totals.applied },
        },
      );
    } finally {
      // Whatever was applied must be recorded as agreed, even after a failure:
      // an applied record without a base turns into a false conflict later.
      if (Object.keys(baseUpdates).length) {
        Object.assign(entry.bases, baseUpdates);
        if (Object.keys(entry.bases).length > MAX_BASES) {
          log.warn(`Die Abgleich-Tabelle für ${remoteId} hat ${Object.keys(entry.bases).length} Einträge überschritten.`);
        }
      }
      entry.lastPullAt = nowIso();
      entry.deviceName = box.deviceName;
      entry.folder = dir;
      saveState();
    }

    if (totals.corrupt) {
      addWarning(`${totals.corrupt} Zeile(n) im Postfach waren unlesbar und wurden übersprungen. `
        + 'Alle übrigen Einträge wurden normal verarbeitet.');
    }
    for (const [type, count] of refusedTypes) {
      addWarning(`${count} Eintrag/Einträge der Art "${type}" lagen im Postfach und wurden NICHT übernommen. `
        + 'Zugangstoken, Netz-Freigaben, Agenten, Partnerlisten und Module werden grundsätzlich nicht über einen '
        + 'Datenträger übertragen.');
    }
    if (Number.isInteger(box.count) && box.count !== totals.fetched + totals.corrupt + [...refusedTypes.values()].reduce((a, b) => a + b, 0)) {
      addWarning(`Die Beschreibungsdatei nennt ${box.count} Einträge, gelesen wurden ${totals.fetched}. `
        + 'Das Postfach passt nicht zu seiner eigenen Beschreibung.');
    }
    if (resultsTruncated) {
      addWarning(`Es werden nur die ersten ${MAX_RESULTS} Einzelmeldungen aufgeführt; die Zahlen oben sind vollständig.`);
    }

    emit('sync.folder', {
      action: 'pulled',
      folder: dir,
      deviceId: remoteId,
      fetched: totals.fetched,
      applied: totals.applied,
      conflicts: totals.conflicts,
      skipped: totals.skipped,
    });
    if (totals.conflicts) {
      emit('sync.conflict', { peerId: null, deviceId: remoteId, count: totals.conflicts, direction: 'folder' });
    }
    log.info(`${totals.applied} übernommen, ${totals.conflicts} Konflikte, ${totals.skipped} übersprungen (von ${remoteId}).`);

    return {
      fetched: totals.fetched,
      applied: totals.applied,
      conflicts: totals.conflicts,
      skipped: totals.skipped,
      identical: totals.identical,
      corrupt: totals.corrupt,
      clockSkewMs,
      deviceId: remoteId,
      deviceName: box.deviceName,
      warnings,
      results,
    };
  }

  /* --------------------------------------------------------------- syncAll */

  /**
   * Read every foreign mailbox, then write our own.
   *
   * In that order on purpose: what we just merged is then already part of what
   * we publish, so a third device picks it up in one hop instead of two. One
   * unreadable mailbox must not stop the others, so failures are collected per
   * device rather than thrown.
   *
   * @param {string} folder
   * @param {{onProgress?:Function}} [opts]
   */
  async function syncAll(folder, opts = {}) {
    const report = reporter(opts.onProgress);
    const dir = resolveFolder(folder, { write: true });
    const startedAt = nowIso();

    const all = await peers(dir);
    const others = all.filter((p) => !p.isSelf);
    const warnings = [];
    const pulled = [];
    const totals = { fetched: 0, applied: 0, conflicts: 0, skipped: 0 };

    let index = 0;
    for (const box of others) {
      index++;
      report({ phase: 'peer', done: index, total: others.length, deviceId: box.deviceId });
      if (!box.ok) {
        warnings.push(`Postfach "${box.deviceName || box.deviceId}" übersprungen: ${box.problem}`);
        pulled.push({ deviceId: box.deviceId, deviceName: box.deviceName, skipped: true, problem: box.problem, error: null });
        continue;
      }
      try {
        const result = await pull(dir, { deviceId: box.deviceId, onProgress: opts.onProgress });
        totals.fetched += result.fetched;
        totals.applied += result.applied;
        totals.conflicts += result.conflicts;
        totals.skipped += result.skipped;
        for (const text of result.warnings) if (warnings.length < MAX_WARNINGS) warnings.push(text);
        pulled.push({ ...result, skipped: false, problem: null, error: null });
      } catch (err) {
        const neural = asNeuralError(err);
        warnings.push(`Postfach "${box.deviceName || box.deviceId}": ${neural.message}`);
        pulled.push({
          deviceId: box.deviceId,
          deviceName: box.deviceName,
          skipped: false,
          problem: null,
          error: neural.message,
          code: neural.code,
        });
      }
    }

    let published = null;
    let publishError = null;
    try {
      published = await publish(dir, { onProgress: opts.onProgress });
      for (const text of published.warnings) if (warnings.length < MAX_WARNINGS) warnings.push(text);
    } catch (err) {
      const neural = asNeuralError(err);
      publishError = neural.message;
      warnings.push(`Der eigene Stand konnte nicht geschrieben werden: ${neural.message}`);
    }

    if (!others.length) {
      warnings.push(
        'In diesem Ordner liegt noch kein Postfach eines anderen Geräts. Der eigene Stand wurde geschrieben -- '
        + 'stecke den Datenträger jetzt in das andere Gerät und gleiche dort ab.',
      );
    }

    const result = {
      folder: dir,
      deviceId,
      startedAt,
      finishedAt: nowIso(),
      published,
      publishError,
      peers: pulled,
      ...totals,
      warnings,
      ok: !publishError && pulled.every((p) => !p.error),
    };
    emit('sync.folder', { action: 'synced', folder: dir, deviceId, ...totals, ok: result.ok });
    return result;
  }

  /* --------------------------------------------------------------- inspect */

  /**
   * Answer "is this folder usable, and what is in it?" without changing
   * anything. This is what the interface should show before the user presses
   * anything, and what `doctor` should print.
   *
   * @param {string} folder
   * @returns {Promise<{ok:boolean, problems:string[], mailboxes:Array, bytes:number}>}
   */
  async function inspect(folder) {
    const problems = [];
    let dir;
    try {
      dir = resolveFolder(folder, { write: false });
    } catch (err) {
      return {
        ok: false,
        problems: [asNeuralError(err).message],
        mailboxes: [],
        bytes: 0,
        folder: String(folder || ''),
        deviceId,
        writable: false,
        freeBytes: null,
      };
    }

    let writable = true;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      writable = false;
      problems.push(
        `In ${dir} kann dieses Gerät nicht schreiben. Lesen geht trotzdem; der eigene Stand lässt sich dort aber `
        + 'nicht ablegen.',
      );
    }

    let mailboxes = [];
    try {
      mailboxes = await peers(dir);
    } catch (err) {
      problems.push(asNeuralError(err).message);
    }

    let bytes = 0;
    for (const box of mailboxes) {
      bytes += await dirBytes(box.path);
      if (!box.ok) problems.push(`Postfach "${box.deviceName || box.deviceId}": ${box.problem}`);
      else if (box.stale && !box.isSelf) {
        problems.push(`Das Postfach von "${box.deviceName || box.deviceId}" ist seit dem ${box.at} unverändert.`);
      }
    }

    let freeBytes = null;
    if (typeof fs.statfsSync === 'function') {
      try {
        const st = fs.statfsSync(dir);
        freeBytes = Number(st.bavail) * Number(st.bsize);
        if (Number.isFinite(freeBytes) && freeBytes < 16 * 1024 * 1024) {
          problems.push(`Auf dem Datenträger sind nur noch ${Math.round(freeBytes / 1024 / 1024)} MB frei. `
            + 'Der nächste Abgleich wird sehr wahrscheinlich scheitern.');
        }
      } catch {
        /* not every platform and filesystem answers statfs */
      }
    }

    if (!mailboxes.some((m) => m.isSelf)) {
      problems.push('Dieses Gerät hat in diesem Ordner noch kein Postfach. Veröffentliche einmal, damit andere '
        + 'Geräte den Stand lesen können.');
    }

    return {
      ok: problems.length === 0,
      problems,
      mailboxes,
      bytes,
      folder: dir,
      deviceId,
      writable,
      freeBytes,
    };
  }

  async function dirBytes(dir) {
    let total = 0;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const item of entries) {
      if (!item.isFile()) continue;
      try {
        total += (await fs.promises.stat(path.join(dir, item.name))).size;
      } catch {
        /* vanished between readdir and stat */
      }
    }
    return total;
  }

  return {
    get deviceId() { return deviceId; },
    get deviceName() { return deviceName(); },
    get protocol() { return FOLDER_PROTOCOL; },

    publish,
    peers,
    pull,
    syncAll,
    inspect,

    /** Exposed for tests and the API layer; not part of the contract. */
    __internals: { resolveFolder, readMailbox, applyPlan, loadState, saveState, statePath },
  };
}

module.exports = {
  createFolderSync,
  FOLDER_PROTOCOL,
  FORMAT,
  MANIFEST_NAME,
  RECORDS_NAME,
  TMP_PREFIX,
  STATE_FILE,
  DEVICE_ID_RE,
  BATCH_SIZE,
  STALE_AFTER_MS,
};
