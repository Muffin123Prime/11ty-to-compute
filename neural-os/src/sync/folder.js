'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');

const defaultMerge = require('./merge');
const { withActor } = require('../kernel/actor');
const {
  NeuralError,
  ValidationError,
  StorageError,
  LockedError,
  asNeuralError,
} = require('../kernel/errors');

/**
 * Abgleich über einen gemeinsamen ORDNER: das `sync/` eines Sticks. Kein
 * Netz, kein Server, kein Partner, der gleichzeitig laufen muss.
 *
 * Wer mit wem abgleicht, entscheidet src/sync/kopplung.js; hier ist nur das
 * Postfach: schreiben, lesen, zusammenführen. Jede Entscheidung darüber, wer
 * gewinnt und was überhaupt reisen darf, kommt aus `merge.js` – dasselbe
 * Modul, das auch der Netzabgleich benutzt.
 *
 * Nichts in dieser Datei spricht mit dem Netz. Die einzige Ein- und Ausgabe
 * ist `node:fs` im Ordner, auf den gezeigt wurde, und im eigenen Heimordner.
 *
 * Postfach-Protokoll 2 (Bauplan 2.8)
 * ----------------------------------
 *   <ordner>/<deviceId>/manifest.json   Klartext, klein: wer, wann, welche
 *                                       Generation, für wen (je Empfänger der
 *                                       Inhaltsschlüssel, mit dem Paarschlüssel
 *                                       versiegelt), Größe und SHA-256
 *   <ordner>/<deviceId>/records.enc     AES-256-GCM(Inhaltsschlüssel,
 *                                       gzip(Kopfzeile + ein Satz je Zeile))
 *
 * Immer verschlüsselt, auch ohne PIN: Wer den Paarschlüssel nicht hat, liest
 * nichts, und wer ihn hat, weiß, dass das Postfach vom Partner kommt. Die
 * Generation steht in der AAD, also lässt sich eine ältere Kopie nicht als
 * neuere ausgeben. Protokoll 1 (Klartext) wird still übergangen.
 *
 * Jede KI schreibt NUR in ihr eigenes Unterverzeichnis und liest die der
 * anderen. Geschrieben wird erst `records.enc`, dann das Manifest: Das
 * Manifest ist die Festschreibung. Größe und Prüfsumme im Manifest fangen
 * einen Stick ab, der mitten im Kopieren gezogen wurde; so ein Postfach wird
 * still übergangen und beim nächsten Mal wieder versucht.
 *
 * Zwei Nähte (Befund 17): `deps.postfach` liefert die Paarschlüssel, die
 * Generationen und was von jedem Partner schon gelesen wurde (liegt in
 * kopplungen.json). `deps.vaultCrypto` versiegelt nur `sync-folder.json`,
 * den Stand je Partner und je Zielordner.
 */

/** Wire version of the mailbox layout. Bumped when the on-disk shape changes. */
const FOLDER_PROTOCOL = 2;
/** Written into every manifest so a foreign folder cannot be mistaken for ours. */
const FORMAT = 'neural-os-folder-sync';
const VERSCHLUESSELUNG = 'paar-v1';

const MANIFEST_NAME = 'manifest.json';
const RECORDS_NAME = 'records.enc';
/** Die Datensatzdatei von Protokoll 1 (Klartext). Wird beim Schreiben entfernt. */
const ALT_RECORDS_NAME = 'records.jsonl.gz';
const TMP_PREFIX = '.tmp-';
const STATE_FILE = 'sync-folder.json';
const STATE_VERSION = 2;

/** Same shape peer.js generates, so one installation is one device everywhere. */
const DEVICE_ID_RE = /^dev_[0-9a-f]{24}$/;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ------------------------------------------------------------ Verschlüsselung */

/** AES-256-GCM, gepackt als iv(12) | tag(16) | Chiffrat, mit AAD. */
function siegeln(schluessel, klartext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', schluessel, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(klartext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** @throws {Error} wenn Schlüssel, AAD oder Inhalt nicht passen */
function oeffnen(schluessel, buf, aad) {
  if (!Buffer.isBuffer(buf) || buf.length < IV_BYTES + TAG_BYTES) throw new Error('zu kurz');
  const decipher = crypto.createDecipheriv('aes-256-gcm', schluessel, buf.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

const aadPostfach = (von, generation) => `nos-postfach|${von}|${generation}`;
const aadPaar = (von, an, generation) => `nos-paar|${von}|${an}|${generation}`;

/**
 * Ein Postfach bauen (rein, ohne Datei). Auch für Tests, die ein Postfach
 * gezielt fälschen müssen.
 * @param {{von:string, name?:string, generation:number, at?:string, kopf:object,
 *   zeilen:string[], empfaenger:Array<{id:string, schluessel:Buffer}>, roh?:Buffer}} p
 *   `roh` ersetzt den gepackten Inhalt (nur Tests).
 * @returns {{manifest:object, records:Buffer}}
 */
function postfachBauen({ von, name = null, generation, at = nowIso(), kopf, zeilen = [], empfaenger = [], roh }) {
  const klartext = Buffer.from(`${JSON.stringify(kopf)}\n${zeilen.length ? `${zeilen.join('\n')}\n` : ''}`, 'utf8');
  const gepackt = roh !== undefined ? roh : zlib.gzipSync(klartext);
  const cek = crypto.randomBytes(KEY_BYTES);
  try {
    const records = siegeln(cek, gepackt, aadPostfach(von, generation));
    const fuer = {};
    for (const e of empfaenger) fuer[e.id] = siegeln(e.schluessel, cek, aadPaar(von, e.id, generation)).toString('base64');
    const manifest = {
      protocol: FOLDER_PROTOCOL,
      format: FORMAT,
      deviceId: von,
      deviceName: name,
      at,
      generation,
      bytes: records.length,
      sha256: sha256(records),
      verschluesselung: VERSCHLUESSELUNG,
      empfaenger: fuer,
    };
    return { manifest, records };
  } finally {
    cek.fill(0);
  }
}

/**
 * Ein Postfach öffnen (rein). Für Tests und Werkzeuge; der Abgleich selbst
 * liest zeilenweise.
 * @returns {{kopf:object, zeilen:string[]}}
 */
function postfachOeffnen({ manifest, records, ich, schluessel }) {
  const eintrag = manifest && manifest.empfaenger && manifest.empfaenger[ich];
  if (typeof eintrag !== 'string') throw new Error('kein Eintrag für diesen Empfänger');
  const cek = oeffnen(schluessel, Buffer.from(eintrag, 'base64'), aadPaar(manifest.deviceId, ich, manifest.generation));
  const gepackt = oeffnen(cek, records, aadPostfach(manifest.deviceId, manifest.generation));
  const text = zlib.gunzipSync(gepackt).toString('utf8');
  const [erste, ...rest] = text.split('\n');
  return { kopf: JSON.parse(erste), zeilen: rest.filter((z) => z.trim()) };
}

/**
 * Passt eine gesehene Generation zu einem Verlauf? Der Verlauf ist die Liste
 * `[generation, inhalt]` der letzten Schreibvorgänge eines Postfachs. Fehlt
 * die Generation in einem Verlauf, der sie abdecken müsste, oder steht dort
 * ein anderer Inhalt, gibt es zwei Schreiber mit derselben Kennung: eine
 * Gabelung (Zwilling oder zurückgespielte Sicherung).
 */
function gabelung(verlauf, voll, generation, inhalt) {
  if (!(Number.isInteger(generation) && generation > 0) || typeof inhalt !== 'string' || !inhalt) return false;
  const liste = Array.isArray(verlauf) ? verlauf.filter((e) => Array.isArray(e) && Number.isInteger(e[0])) : [];
  const treffer = liste.find((e) => e[0] === generation);
  if (treffer) return treffer[1] !== inhalt;
  if (voll === true) return true;
  if (!liste.length) return false;
  return generation >= Math.min(...liste.map((e) => e[0]));
}

/** Ein Abbruch beim Lesen, bevor ein einziger Satz angewendet wurde. */
class Uebergangen extends Error {
  constructor(grund) {
    super(grund);
    this.grund = grund;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.store        record store (required)
 * @param {object} deps.paths        layout; `home` is where the agreed state lives
 * @param {object} [deps.postfach]   Paarschlüssel und Generationen (src/sync/kopplung.js)
 * @param {object} [deps.identitaet] Kennung und Name dieser KI; sonst config.sync
 * @param {object} [deps.merge]      merge rules; defaults to the real ./merge
 * @param {object} [deps.bus]
 * @param {Function|object} [deps.logger]
 * @param {object} [deps.config]
 * @param {object} [deps.vaultCrypto] nur für sync-folder.json
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
  const identitaet = deps.identitaet || null;
  const postfach = deps.postfach || null;
  const log = typeof deps.logger === 'function' ? deps.logger('sync.folder') : (deps.logger || nullLogger());

  const appVersion = safeAppVersion();
  const statePath = path.join(paths.home, STATE_FILE);
  /** Nur ohne Identität (Tests): die Kennung aus config.sync, notfalls neu. */
  let eigeneKennung = null;

  /** One folder operation at a time: two clicks must not write the same mailbox twice. */
  let running = null;

  /** @type {{v:number, devices:object, ziele:object}|null} lazily loaded, kept in memory */
  let state = null;

  function safeAppVersion() {
    try {
      return require('../../package.json').version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * Die Kennung dieser KI, bei jedem Vorgang frisch: `identitaet.erneuern()`
   * kann sie ändern, während der Prozess läuft.
   */
  function deviceId() {
    const id = identitaet ? identitaet.id : null;
    if (typeof id === 'string' && DEVICE_ID_RE.test(id)) return id;
    if (!eigeneKennung) eigeneKennung = ensureDeviceId();
    return eigeneKennung;
  }

  /** Rückfall ohne Identität: dasselbe Format wie peer.js und identitaet.js. */
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
   * Der Name im Klartext-Manifest. Er kommt aus der Identität ("Name dieser
   * KI"), nie aus dem Rechnernamen: Der Stick wandert, der Name des Laptops,
   * an dem er zuletzt steckte, soll nicht mitreisen.
   */
  function deviceName() {
    const ausIdentitaet = identitaet && typeof identitaet.name === 'string' ? identitaet.name.trim() : '';
    if (ausIdentitaet) return ausIdentitaet.slice(0, 100);
    const configured = config.sync && typeof config.sync.deviceName === 'string' ? config.sync.deviceName.trim() : '';
    if (configured) return configured.slice(0, 100);
    return `KI ${deviceId().slice(4, 8).toUpperCase()}`;
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

  function requirePostfach() {
    if (!postfach || typeof postfach.empfaenger !== 'function') {
      throw new NeuralError('KOPPLUNG_FEHLT', 'Ohne Kopplung gibt es kein Postfach.', { status: 409 });
    }
    return postfach;
  }

  /* ------------------------------------------------ sync-folder.json (Tresor) */

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
          'Der Vault ist verschlüsselt, aber die Verschlüsselung stellt kein encryptBuffer bereit.',
          { status: 503 },
        );
      }
      return vaultCrypto.encryptBuffer(buf);
    },
    decrypt(buf) {
      if (typeof vaultCrypto?.decryptBuffer !== 'function') {
        throw new NeuralError('SUBSYSTEM_UNAVAILABLE', 'Dieses Gerät stellt keine Entschlüsselung bereit.', { status: 503 });
      }
      return vaultCrypto.decryptBuffer(buf);
    },
  };

  function requireUnlocked(what) {
    if (vault.enabled && vault.state === 'locked') {
      throw new LockedError(`Der Vault ist gesperrt. ${what} braucht den Schlüssel; entsperre zuerst mit der PIN.`);
    }
  }

  function emptyState() {
    return { v: STATE_VERSION, devices: {}, ziele: {} };
  }

  /**
   * Was diese KI mit jedem Partner zuletzt vereinbart hat (je Satz ein
   * Fingerabdruck), und was sie zuletzt in welchen Zielordner geschrieben hat.
   * Ein Verlust kostet keine Daten, nur Konflikte, die sonst keine wären.
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
    // Aus der Zeit vor der PIN: Fingerabdrücke jedes Satzes nicht länger im
    // Klartext neben einem verschlüsselten Tresor.
    if (raw.length && raw[0] === 0x7b && vault.enabled && vault.state === 'unlocked') saveState();
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
          const ziele = parsed.ziele && typeof parsed.ziele === 'object' && !Array.isArray(parsed.ziele) ? parsed.ziele : {};
          return { v: STATE_VERSION, devices: parsed.devices, ziele };
        }
      } catch {
        /* try the other encoding before giving up */
      }
    }
    log.warn(`${STATE_FILE} ist beschädigt oder mit einem anderen Schlüssel geschrieben; der nächste Abgleich beginnt ohne gemeinsamen Stand.`);
    return emptyState();
  }

  /** @returns {boolean} ob der Stand auf der Platte ist */
  function saveState() {
    if (!state) return true;
    const json = Buffer.from(JSON.stringify(state), 'utf8');
    let payload = json;
    try {
      payload = vault.enabled ? vault.encrypt(json) : json;
    } catch (err) {
      // Fingerabdrücke jedes Satzes im Klartext neben einem verschlüsselten
      // Tresor wären eine stille Herabstufung. Dann lieber nicht schreiben.
      log.warn(`${STATE_FILE} konnte nicht verschlüsselt werden (${asNeuralError(err).message}); es wurde nichts geschrieben.`);
      return false;
    }
    const tmp = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeSync(fd, payload);
      try { fs.fsyncSync(fd); } catch { /* exFAT & co. */ }
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, statePath);
      fsyncDir(path.dirname(statePath));
      return true;
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      log.warn(`${STATE_FILE} konnte nicht gespeichert werden (${err.message}).`);
      return false;
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
   * Aus Protokoll 1 können noch entschiedene Konflikte im Tresor liegen. Eine
   * Entscheidung ist auch eine Vereinbarung; sie gilt weiter als Basis.
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
      throw new ValidationError('Es wurde kein Ordner angegeben.');
    }
    const abs = path.resolve(text);

    // Der Tresor ist ein Protokoll, das dem Speicher gehört. Postfächer darin
    // vermischten zwei Ablagen, die sich verschieden erholen.
    if (paths.vault && isInside(abs, paths.vault)) {
      throw new ValidationError(`${abs} liegt im Vault dieses Geräts. Der Abgleich-Ordner muss ausserhalb liegen.`);
    }

    let stats;
    try {
      stats = fs.statSync(abs);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw notFound(`Der Ordner ${abs} existiert nicht. Ist der Stick angesteckt?`);
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
        log.debug(`Schreibrecht auf ${abs} ist laut Betriebssystem nicht gegeben; der Schreibversuch entscheidet.`);
      }
    }
    return abs;
  }

  function mailboxDir(folder, id) {
    if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) {
      throw new ValidationError(`"${String(id).slice(0, 60)}" ist keine gültige Geräte-Kennung.`);
    }
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
   * Everything this device holds that is allowed to travel, in a fixed order
   * (Art, dann ID): Derselbe Bestand ergibt dieselben Zeilen, also denselben
   * Inhalt, und damit keinen neuen Schreibvorgang.
   *
   * `merge.SYNC_TYPES` is the only list consulted. Access tokens, network
   * grants, agents with their permissions, the partner list, runs, approvals
   * and modules are not on it, and a stick that is plugged into somebody
   * else's computer must not hand out rights, network access or executable
   * code there. The second check inside the loop is not redundant.
   */
  function collectLocal(report) {
    const lines = [];
    let count = 0;
    for (const type of merge.SYNC_TYPES) {
      if (!merge.isSyncable(type)) continue;
      const items = store.list(type, { includeDeleted: true }).items
        .filter((record) => record && merge.isSyncable(record.type))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const record of items) {
        lines.push(JSON.stringify(record));
        count++;
      }
      report({ phase: 'collect', type, done: count });
    }
    return { lines, count };
  }

  function passt(manifest, stand) {
    return !!(manifest && stand && manifest.generation === stand.generation && manifest.sha256 === stand.sha256);
  }

  /** Das Manifest, das gerade in meinem Postfach liegt: {generation, sha256} oder null. */
  async function eigenesManifest(dir) {
    let raw;
    try {
      const st = await fs.promises.stat(path.join(dir, MANIFEST_NAME));
      if (st.size > MAX_MANIFEST_BYTES) return { generation: null, sha256: null };
      raw = await fs.promises.readFile(path.join(dir, MANIFEST_NAME), 'utf8');
    } catch {
      return null;
    }
    try {
      const m = JSON.parse(raw);
      return { generation: Number.isInteger(m.generation) ? m.generation : null, sha256: typeof m.sha256 === 'string' ? m.sha256 : null };
    } catch {
      return { generation: null, sha256: null };
    }
  }

  /**
   * Den eigenen Stand in das eigene Postfach dieses Ordners schreiben.
   *
   * Geschrieben wird nur, wenn sich seit dem letzten Schreiben in diesen
   * Ordner etwas geändert hat. Liegt dort ein Postfach mit meiner Kennung,
   * das ich nicht geschrieben habe, schreibt eine zweite KI mit derselben
   * Kennung (ein Zwilling): Dann wird nichts geschrieben.
   *
   * @param {string} folder
   * @param {{ziel?:string, onProgress?:Function}} [opts] `ziel`: unter welchem
   *   Namen der Stand dieses Ordners gemerkt wird (die Kennung des Sticks, dem
   *   der Ordner gehört; Laufwerksbuchstaben wechseln)
   */
  async function publish(folder, opts = {}) {
    const release = claim('Veröffentlichen');
    try {
      return await publishUnguarded(folder, opts);
    } finally {
      release();
    }
  }

  async function publishUnguarded(folder, opts = {}) {
    const report = reporter(opts.onProgress);
    const dir = resolveFolder(folder, { write: true });
    requireUnlocked('Das Schreiben ins Postfach');
    const pf = requirePostfach();
    const ich = deviceId();
    const mine = mailboxDir(dir, ich);
    const zielKey = typeof opts.ziel === 'string' && opts.ziel ? opts.ziel : path.resolve(dir);
    const out = {
      written: 0, bytes: 0, deviceId: ich, at: null, encrypted: true, warnings: [], path: mine,
      geschrieben: false, generation: null, grund: null, zwilling: false,
    };

    const empfaenger = (pf.empfaenger() || []).filter((e) => e && e.id !== ich && DEVICE_ID_RE.test(e.id)
      && Buffer.isBuffer(e.schluessel) && e.schluessel.length === KEY_BYTES);
    if (!empfaenger.length) return { ...out, grund: 'keine-partner' };

    report({ phase: 'collect', done: 0 });
    const { lines, count } = collectLocal(report);
    const partner = empfaenger.map((e) => ({ id: e.id, name: typeof e.name === 'string' ? e.name : null }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    // Der eigene Name steht im Manifest: ein neuer Name ist ein neuer Stand.
    const inhalt = sha256(`${lines.join('\n')}\n#${JSON.stringify(partner)}\n#${deviceName()}`).slice(0, 24);

    const s = loadState();
    const zielStand = s.ziele[zielKey] && typeof s.ziele[zielKey] === 'object' ? s.ziele[zielKey] : null;
    const vorhanden = await eigenesManifest(mine);
    const lesbar = !!(vorhanden && Number.isInteger(vorhanden.generation) && isHex64(vorhanden.sha256));
    if (lesbar && zielStand && !passt(vorhanden, zielStand) && !passt(vorhanden, zielStand.vorher)) {
      log.warn(`In ${mine} liegt ein Postfach mit der Kennung dieser KI, das sie nicht geschrieben hat.`);
      emit('sync.folder', { action: 'zwilling', folder: dir, deviceId: ich });
      return { ...out, grund: 'zwilling', zwilling: true };
    }

    const generation = pf.vergeben(inhalt);
    if (vorhanden && zielStand && zielStand.generation === generation && passt(vorhanden, zielStand)) {
      return { ...out, written: count, generation, grund: 'unveraendert' };
    }

    try {
      await fs.promises.mkdir(mine, { recursive: true });
    } catch (err) {
      throw storageError(err, 'Das Anlegen des Postfachs');
    }
    const sweptTmp = await sweepTmp(mine);

    const stand = pf.stand();
    const kopf = {
      generation,
      inhalt,
      anzahl: count,
      version: appVersion,
      partner,
      gesehen: {},
      gesehenInhalt: {},
      basen: {},
      verlauf: stand.verlauf,
      verlaufVoll: stand.voll === true,
    };
    for (const e of empfaenger) {
      const g = pf.gelesen(e.id) || {};
      kopf.gesehen[e.id] = Number.isInteger(g.generation) ? g.generation : 0;
      if (typeof g.inhalt === 'string') kopf.gesehenInhalt[e.id] = g.inhalt;
      const eigene = (s.devices[e.id] && s.devices[e.id].bases) || {};
      const basen = {};
      for (const [id, b] of Object.entries(eigene)) {
        const h = merge.baseHash(b);
        if (h) basen[id] = h;
      }
      kopf.basen[e.id] = basen;
    }

    report({ phase: 'compress', done: count, total: count });
    const at = nowIso();
    let gebaut;
    try {
      const klartext = Buffer.from(`${JSON.stringify(kopf)}\n${lines.length ? `${lines.join('\n')}\n` : ''}`, 'utf8');
      const gepackt = await gzipAsync(klartext);
      gebaut = postfachBauen({ von: ich, name: deviceName(), generation, at, kopf, empfaenger, roh: gepackt });
    } catch (err) {
      throw new StorageError(`Die Daten konnten nicht gepackt werden: ${err && err.message}`);
    }
    const { manifest, records } = gebaut;

    // Erst merken, dann schreiben: Bricht es danach ab, liegt dort entweder
    // das alte Postfach (steht als "vorher" im Stand) oder das neue.
    s.ziele[zielKey] = {
      generation,
      sha256: manifest.sha256,
      at,
      vorher: zielStand ? { generation: zielStand.generation, sha256: zielStand.sha256 } : null,
    };
    if (!saveState()) {
      if (zielStand) s.ziele[zielKey] = zielStand;
      else delete s.ziele[zielKey];
      throw new StorageError('Der Abgleich-Stand ließ sich nicht sichern; das Postfach wurde nicht geschrieben.');
    }

    report({ phase: 'write', done: 0, total: records.length });
    await writeFileAtomic(path.join(mine, RECORDS_NAME), records, 'Das Schreiben der Datensätze');
    await writeFileAtomic(
      path.join(mine, MANIFEST_NAME),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      'Das Schreiben der Beschreibungsdatei',
    );
    // Ein Postfach aus Protokoll 1 lag im Klartext; es hat hier nichts mehr zu suchen.
    try { await fs.promises.unlink(path.join(mine, ALT_RECORDS_NAME)); } catch { /* war nicht da */ }
    report({ phase: 'write', done: records.length, total: records.length });

    const warnings = [];
    if (sweptTmp) warnings.push(`${sweptTmp} Reste eines abgebrochenen Schreibvorgangs wurden entfernt.`);
    log.info(`${count} Einträge (Generation ${generation}) nach ${mine} geschrieben.`);
    emit('sync.folder', { action: 'published', folder: dir, deviceId: ich, count, bytes: records.length, generation });

    return {
      ...out, written: count, bytes: records.length, at, warnings, geschrieben: true, generation,
    };
  }

  /* ------------------------------------------------------------- reading */

  function validateManifest(raw, expectedId) {
    const problems = [];
    if (!raw || typeof raw !== 'object') return ['Die Beschreibungsdatei enthält kein Objekt.'];
    if (raw.format !== undefined && raw.format !== FORMAT) problems.push('Die Beschreibungsdatei gehört nicht zu Neural OS.');
    if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) {
      problems.push('Die Geräte-Kennung in der Beschreibungsdatei fehlt oder ist ungültig.');
    } else if (raw.deviceId !== expectedId) {
      problems.push(`Der Ordner heisst ${expectedId}, die Beschreibungsdatei nennt aber ${raw.deviceId}.`);
    }
    if (!Number.isInteger(raw.generation) || raw.generation < 1) problems.push('Die Generation fehlt.');
    if (!Number.isInteger(raw.bytes) || raw.bytes < 0) problems.push('Die Grösse der Datensatzdatei fehlt.');
    if (!isHex64(raw.sha256)) problems.push('Die Prüfsumme fehlt; es wird nichts daraus gelesen.');
    if (parseTime(raw.at) === null) problems.push('Der Zeitstempel fehlt oder ist unlesbar.');
    if (raw.verschluesselung !== VERSCHLUESSELUNG) problems.push('Die Verschlüsselung ist unbekannt.');
    if (!raw.empfaenger || typeof raw.empfaenger !== 'object' || Array.isArray(raw.empfaenger)) {
      problems.push('Die Empfängerliste fehlt.');
    }
    return problems;
  }

  /**
   * Die Beschreibung eines Postfachs lesen. Billig mit Absicht: Die teure
   * Prüfung (Prüfsumme über die Datensatzdatei) kommt erst direkt vor dem
   * Anwenden.
   */
  async function readMailbox(folder, id) {
    const dir = path.join(folder, id);
    const entry = {
      deviceId: id,
      deviceName: null,
      at: null,
      count: null,
      generation: null,
      protocol: null,
      appVersion: null,
      encrypted: null,
      fuerMich: false,
      neuer: false,
      isSelf: id === deviceId(),
      stale: false,
      skewMs: null,
      bytes: 0,
      ok: false,
      problem: null,
      path: dir,
      manifest: null,
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
          ? 'Dieses Postfach wird gerade geschrieben oder der Schreibvorgang wurde abgebrochen.'
          : 'Dem Postfach fehlt die Beschreibungsdatei; es ist unvollständig.')
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
    if (!manifest || typeof manifest !== 'object') {
      entry.problem = 'Die Beschreibungsdatei ist beschädigt.';
      return entry;
    }

    entry.deviceName = typeof manifest.deviceName === 'string' ? manifest.deviceName.slice(0, 100) : null;
    entry.at = typeof manifest.at === 'string' ? manifest.at : null;
    entry.protocol = manifest.protocol;
    entry.bytes = Number.isInteger(manifest.bytes) ? manifest.bytes : 0;
    entry.generation = Number.isInteger(manifest.generation) ? manifest.generation : null;
    entry.encrypted = manifest.protocol === FOLDER_PROTOCOL || manifest.encrypted === true;

    if (manifest.protocol !== FOLDER_PROTOCOL) {
      // Ein neueres Protokoll wird nie halb gelesen; ein älteres ist Klartext
      // von vor der Kopplung und wird übergangen.
      entry.neuer = typeof manifest.protocol === 'number' && manifest.protocol > FOLDER_PROTOCOL;
      entry.problem = entry.neuer
        ? `Das Postfach ist in Version ${manifest.protocol} geschrieben; diese KI versteht Version ${FOLDER_PROTOCOL}.`
        : 'Das Postfach stammt aus einer älteren Version und wird nicht gelesen.';
      return entry;
    }

    const problems = validateManifest(manifest, id);
    if (problems.length) {
      entry.problem = problems.join(' ');
      return entry;
    }
    entry.fuerMich = typeof manifest.empfaenger[deviceId()] === 'string';

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
        + `${manifest.bytes}. Das Postfach wurde nur halb geschrieben oder nur halb kopiert.`;
      return entry;
    }

    const at = parseTime(manifest.at);
    const now = Date.now();
    entry.skewMs = at === null ? null : at - now;
    entry.stale = at !== null && now - at > STALE_AFTER_MS;
    entry.sha256 = manifest.sha256;
    entry.manifest = manifest;
    entry.ok = true;
    return entry;
  }

  /**
   * Jedes Postfach im Ordner, das eigene eingeschlossen (`isSelf`). Für die
   * Anzeige und `inspect`; der Abgleich selbst liest nur Partner.
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
        const box = await readMailbox(dir, item.name);
        const { manifest, ...ohne } = box;
        void manifest;
        out.push(ohne);
        continue;
      }
      const claimsToBe = fs.existsSync(path.join(dir, item.name, MANIFEST_NAME));
      if (!claimsToBe) continue;
      out.push({
        deviceId: item.name,
        deviceName: null,
        at: null,
        count: null,
        generation: null,
        protocol: null,
        encrypted: null,
        fuerMich: false,
        neuer: false,
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
   * written at all.
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
            detail: `Die Verknüpfung zeigt auf dem anderen Gerät woanders hin (${moved.join(', ')}).`,
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
      // Dateiinhalte reisen erst mit Paket K2. Ein Satz ohne Inhalt sähe aus
      // wie eine Datei und scheiterte beim ersten Öffnen.
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

  /**
   * MUST run inside `store.transaction()` so records land together or not at
   * all. Konflikte werden hier ohne Rückfrage gelöst: beide Fassungen bleiben
   * (merge.beideBehalten).
   */
  function applyPlan(planned, ctx) {
    const bases = {};
    const results = [];
    const neueKopien = [];
    let applied = 0;
    let skipped = 0;

    const push = (row) => { if (results.length < MAX_RESULTS) results.push(row); };
    const at = nowIso();

    for (const entry of planned.identical) {
      bases[entry.id] = { h: entry.hash, at };
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
        // Eine Kopie bekommt KEINE Basis: Mit Basis hielte der Partner sie
        // über die mitgereiste Basis für "hier endgültig gelöscht" (v8).
        if (!merge.istKopieId(entry.id)) bases[entry.id] = { h: entry.hash, at };
        else if (entry.action === 'create') neueKopien.push({ titel: merge.titelOhneZusatz(entry.record), kopieId: entry.id });
        push({ id: entry.id, type: entry.type, status: 'applied', action: outcome.action, rev: outcome.rev });
      } else {
        skipped++;
        if (outcome.note) bases[entry.id] = { h: entry.hash, at, note: outcome.note };
        push({ id: entry.id, type: entry.type, status: outcome.status, reason: outcome.reason, detail: outcome.detail });
      }
    }

    for (const entry of planned.skip) {
      skipped++;
      push({ id: entry.id, type: entry.type, status: 'skipped', reason: entry.reason, detail: entry.detail });
    }

    for (const conflict of planned.conflicts) {
      const remote = conflict.remote;
      const hash = merge.fingerprint(remote);
      const { sieger, kopie } = merge.beideBehalten(conflict, { nameLokal: ctx.nameLokal, nameFern: ctx.nameFern });
      let status = 'zwei-fassungen';
      if (sieger === 'fern') {
        const action = merge.actionFor(conflict.local, remote);
        let outcome = { status: 'applied', action };
        if (action !== 'none') {
          try {
            outcome = applyOne({ record: remote, action });
          } catch (err) {
            const neural = asNeuralError(err);
            outcome = { status: 'rejected', reason: neural.code, detail: neural.message };
          }
        }
        if (outcome.status === 'applied') {
          applied++;
          bases[conflict.recordId] = { h: hash, at };
        } else {
          skipped++;
          status = outcome.status;
        }
      } else {
        // Die eigene Fassung bleibt. Als vereinbart gilt die des Partners:
        // Hat er sie beim nächsten Mal noch, ist meine die neuere, und derselbe
        // Konflikt entsteht nicht wieder.
        bases[conflict.recordId] = { h: hash, at, note: 'fassung' };
      }
      let kopieId = null;
      if (kopie && !store.get(kopie.id, { includeDeleted: true })) {
        let outcome;
        try {
          outcome = applyOne({ record: kopie, action: 'create' });
        } catch (err) {
          outcome = { status: 'rejected', reason: asNeuralError(err).code };
        }
        if (outcome.status === 'applied') {
          kopieId = kopie.id;
          neueKopien.push({ titel: merge.titelOhneZusatz({ type: kopie.type, data: kopie.data }), kopieId });
        }
      }
      push({ id: conflict.recordId, type: conflict.recordType, status, sieger, kopieId });
    }

    return { results, bases, applied, skipped, conflicts: planned.conflicts.length, neueKopien };
  }

  /* ------------------------------------------------------------------ pull */

  function leer(remoteId, grund = null) {
    return {
      deviceId: remoteId,
      deviceName: null,
      gelesen: false,
      grund,
      generation: null,
      fetched: 0,
      applied: 0,
      conflicts: 0,
      kopien: 0,
      skipped: 0,
      identical: 0,
      corrupt: 0,
      clockSkewMs: 0,
      neuer: false,
      gabelung: false,
      zwilling: false,
      partner: null,
      warnings: [],
      results: [],
    };
  }

  /**
   * Das neueste Postfach eines Partners aus einem der Ordner lesen und
   * zusammenführen. Übergangen wird still: was schon gelesen ist
   * (`generation ≤ gesehen`), was nicht für mich ist, was gerade geschrieben
   * wird, was sich nicht öffnen lässt, was von einer Gabelung stammt.
   *
   * @param {string[]} ordnerListe
   * @param {string} remoteId
   * @param {{onProgress?:Function}} [opts]
   */
  async function lesen(ordnerListe, remoteId, opts = {}) {
    const release = claim('Einlesen');
    try {
      return await lesenUnguarded(ordnerListe, remoteId, opts);
    } finally {
      release();
    }
  }

  async function lesenUnguarded(ordnerListe, remoteId, opts = {}) {
    const report = reporter(opts.onProgress);
    if (typeof remoteId !== 'string' || !DEVICE_ID_RE.test(remoteId)) {
      throw new ValidationError('Für das Einlesen muss angegeben werden, von welchem Gerät gelesen werden soll.');
    }
    if (remoteId === deviceId()) {
      throw new ValidationError('Das ist das eigene Postfach. Eine KI gleicht sich nicht mit sich selbst ab.');
    }
    requireUnlocked('Das Einlesen eines Postfachs');
    const pf = requirePostfach();
    const result = leer(remoteId);

    const boxen = [];
    for (const ordner of ordnerListe) {
      let dir;
      try {
        dir = resolveFolder(ordner, { write: false });
      } catch {
        continue;
      }
      boxen.push(await readMailbox(dir, remoteId));
    }
    if (boxen.some((b) => b.neuer)) result.neuer = true;
    const lesbar = boxen.filter((b) => b.ok && b.fuerMich).sort((a, b) => b.generation - a.generation);
    if (!lesbar.length) {
      result.grund = boxen.some((b) => b.ok) ? 'nicht-fuer-mich' : (boxen.length ? 'kein-postfach' : 'kein-ordner');
      const erstes = boxen.find((b) => b.problem);
      if (erstes && !boxen.some((b) => b.ok)) result.problem = erstes.problem;
      return result;
    }

    const gesehen = pf.gelesen(remoteId) || {};
    const bisher = Number.isInteger(gesehen.generation) ? gesehen.generation : 0;
    for (const box of lesbar) {
      if (box.generation <= bisher) {
        result.grund = 'bekannt';
        result.generation = box.generation;
        break;
      }
      const r = await leseBox(box, remoteId, gesehen, report);
      if (r.gelesen || r.zwilling) return { ...r, neuer: result.neuer || r.neuer };
      result.grund = r.grund;
      result.gabelung = result.gabelung || r.gabelung;
      result.problem = r.problem;
      // Eine Gabelung oder ein halbes Postfach: vielleicht ist ein älteres
      // in einem anderen Ordner in Ordnung.
    }
    return result;
  }

  async function leseBox(box, remoteId, gesehen, report) {
    const pf = postfach;
    const ich = deviceId();
    const manifest = box.manifest;
    const result = leer(remoteId);
    result.deviceName = box.deviceName;
    result.generation = box.generation;

    const schluessel = pf.schluessel(remoteId);
    if (!Buffer.isBuffer(schluessel) || schluessel.length !== KEY_BYTES) return { ...result, grund: 'kein-schluessel' };

    // Ganz in den Speicher: Ein versiegelter Block wird als Ganzes geprüft,
    // bevor ein einziges Byte daraus als Satz gilt.
    let buf;
    try {
      buf = await fs.promises.readFile(path.join(box.path, RECORDS_NAME));
    } catch (err) {
      return { ...result, grund: 'unvollstaendig', problem: storageError(err, 'Das Lesen der Datensatzdatei').message };
    }
    report({ phase: 'verify', done: buf.length });
    if (buf.length !== box.bytes || sha256(buf) !== box.sha256) {
      // Der Partner schreibt vielleicht gerade: still später noch einmal.
      return { ...result, grund: 'unvollstaendig', problem: 'Prüfsumme stimmt nicht' };
    }

    let gepackt;
    try {
      const cek = oeffnen(schluessel, Buffer.from(manifest.empfaenger[ich], 'base64'), aadPaar(remoteId, ich, box.generation));
      try {
        gepackt = oeffnen(cek, buf, aadPostfach(remoteId, box.generation));
      } finally {
        cek.fill(0);
      }
    } catch {
      return { ...result, grund: 'schluessel' };
    }

    const warnings = result.warnings;
    const addWarning = (text) => { if (warnings.length < MAX_WARNINGS) warnings.push(text); };

    /**
     * Nur ein Zeitstempel in der ZUKUNFT sagt etwas über die Uhr des anderen:
     * ein Postfach von gestern ist einfach eines von gestern (p2b).
     */
    const clockSkewMs = Number.isFinite(box.skewMs) ? Math.max(0, box.skewMs) : 0;
    result.clockSkewMs = clockSkewMs;
    if (clockSkewMs > merge.DEFAULT_SKEW_TOLERANCE_MS) {
      const msg = `Die Uhr von "${box.deviceName || remoteId}" geht ${Math.round(clockSkewMs / 1000)} Sekunden vor; `
        + 'eingehende Löschungen werden deshalb nicht ausgeführt.';
      addWarning(msg);
      log.warn(msg);
      emit('sync.warning', { kind: 'clock-skew', deviceId: remoteId, clockSkewMs, message: msg });
    }
    if (box.stale) addWarning(`Das Postfach von "${box.deviceName || remoteId}" wurde zuletzt am ${box.at} geschrieben.`);

    const entry = deviceState(remoteId);
    const eigeneBasen = basesFromResolvedConflicts(remoteId, { ...entry.bases });
    let bases = eigeneBasen;
    let kopf = null;
    const nameLokal = deviceName();
    let nameFern = box.deviceName || null;

    const totals = { fetched: 0, applied: 0, conflicts: 0, skipped: 0, identical: 0, corrupt: 0, kopien: 0 };
    const refusedTypes = new Map();
    const results = [];
    const baseUpdates = {};
    let resultsTruncated = false;
    let angewendet = false;

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

      angewendet = true;
      const outcome = withActor(
        { kind: 'sync', label: nameFern || remoteId },
        () => store.transaction(() => applyPlan(planned, { remoteId, nameLokal, nameFern })),
      );

      Object.assign(bases, outcome.bases);
      Object.assign(baseUpdates, outcome.bases);
      totals.applied += outcome.applied;
      totals.skipped += outcome.skipped;
      totals.conflicts += outcome.conflicts;
      totals.identical += planned.identical.length;
      totals.kopien += outcome.neueKopien.length;
      for (const k of outcome.neueKopien) emit('kopplung.zweiFassungen', { titel: k.titel, kopieId: k.kopieId, partner: remoteId });
      collectResults(outcome.results);
      report({ phase: 'apply', done: totals.fetched });
    };

    /** Die Kopfzeile: prüfen, bevor ein einziger Satz angewendet wird. */
    const handleKopf = (text) => {
      try {
        kopf = JSON.parse(text);
      } catch {
        throw new Uebergangen('unlesbar');
      }
      if (!kopf || typeof kopf !== 'object' || kopf.generation !== box.generation) throw new Uebergangen('unlesbar');
      // Eine Gabelung beim Partner: sein Verlauf kennt die Generation nicht,
      // die ich zuletzt von ihm gelesen habe (Zwilling, alte Sicherung).
      if (gabelung(kopf.verlauf, kopf.verlaufVoll === true, gesehen.generation, gesehen.inhalt)) {
        throw new Uebergangen('gabelung');
      }
      // Umgekehrt: Der Partner hat eine Generation von MIR gesehen, die ich
      // nie geschrieben habe. Dann gibt es mich zweimal.
      const quittung = kopf.gesehen && Number.isInteger(kopf.gesehen[ich]) ? kopf.gesehen[ich] : 0;
      const quittInhalt = kopf.gesehenInhalt && typeof kopf.gesehenInhalt[ich] === 'string' ? kopf.gesehenInhalt[ich] : null;
      if (quittung > 0) {
        const stand = pf.stand();
        if (quittung > (stand.generation || 0) || gabelung(stand.verlauf, stand.voll === true, quittung, quittInhalt)) {
          throw new Uebergangen('zwilling');
        }
      }
      // Die mitgereiste Basis: was der Partner mit mir vereinbart hat. Die
      // eigene gewinnt (peer.js); die mitgereiste füllt nur Lücken (p2c).
      const mitgereist = kopf.basen && typeof kopf.basen[ich] === 'object' && kopf.basen[ich] ? kopf.basen[ich] : {};
      const sauber = {};
      for (const [id, h] of Object.entries(mitgereist)) if (typeof h === 'string' && h) sauber[id] = { h };
      bases = { ...sauber, ...eigeneBasen };
      if (Array.isArray(kopf.partner)) {
        const selbst = kopf.partner.find((p) => p && p.id === remoteId);
        if (selbst && typeof selbst.name === 'string' && !nameFern) nameFern = selbst.name;
      }
    };

    let batch = [];
    let deferredEdges = [];

    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      if (!kopf) {
        handleKopf(text);
        return;
      }
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
      // Die Sicherheitslinie dieses Moduls. merge.plan lehnte diese auch ab,
      // aber ein Stick aus einem fremden Rechner ist genau der Fall, in dem
      // die Ablehnung nicht an einer einzigen Prüfung hängen darf.
      if (!merge.isSyncable(record.type)) {
        refusedTypes.set(record.type, (refusedTypes.get(record.type) || 0) + 1);
        return;
      }
      totals.fetched++;
      if (record.type === 'edge') {
        deferredEdges.push(record);
        if (deferredEdges.length >= MAX_DEFERRED_EDGES) {
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

    try {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let discarding = false;
      await pipeline(
        Readable.from([gepackt]),
        zlib.createGunzip(),
        async function consume(chunks) {
          for await (const chunk of chunks) {
            pending += decoder.write(chunk);
            let index = pending.indexOf('\n');
            while (index !== -1) {
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              if (discarding) discarding = false;
              else handleLine(line);
              index = pending.indexOf('\n');
            }
            if (pending.length > MAX_LINE_BYTES) {
              totals.corrupt++;
              pending = '';
              discarding = true;
            }
          }
          pending += decoder.end();
          if (pending.trim() && !discarding) handleLine(pending);
        },
      );
      if (!kopf) throw new Uebergangen('unlesbar');
      flush(batch);
      batch = [];
      for (let i = 0; i < deferredEdges.length; i += BATCH_SIZE) flush(deferredEdges.slice(i, i + BATCH_SIZE));
      deferredEdges = [];
    } catch (err) {
      if (err instanceof Uebergangen && !angewendet) {
        return {
          ...result,
          grund: err.grund,
          gabelung: err.grund === 'gabelung',
          zwilling: err.grund === 'zwilling',
        };
      }
      if (!angewendet) return { ...result, grund: 'unlesbar', problem: asNeuralError(err).message };
      const neural = asNeuralError(err);
      throw new NeuralError(
        neural.code === 'INTERNAL_ERROR' ? 'SYNC_MAILBOX_INVALID' : neural.code,
        `Der Abgleich mit "${box.deviceName || remoteId}" wurde abgebrochen: ${neural.message} `
        + `${totals.applied} Einträge waren bereits übernommen; sie bleiben gültig.`,
        { status: neural.status && neural.status !== 500 ? neural.status : 409, cause: err, details: { deviceId: remoteId, applied: totals.applied } },
      );
    } finally {
      // Was angewendet wurde, gilt als vereinbart, auch nach einem Fehler:
      // ein angewendeter Satz ohne Basis würde später ein falscher Konflikt.
      if (Object.keys(baseUpdates).length) {
        Object.assign(entry.bases, baseUpdates);
        if (Object.keys(entry.bases).length > MAX_BASES) {
          log.warn(`Die Abgleich-Tabelle für ${remoteId} hat ${Object.keys(entry.bases).length} Einträge überschritten.`);
        }
      }
      if (angewendet) {
        entry.lastPullAt = nowIso();
        entry.deviceName = nameFern;
        saveState();
      }
    }

    if (totals.corrupt) {
      addWarning(`${totals.corrupt} Zeile(n) im Postfach waren unlesbar und wurden übersprungen.`);
    }
    for (const [type, count] of refusedTypes) {
      addWarning(`${count} Eintrag/Einträge der Art "${type}" lagen im Postfach und wurden NICHT übernommen. `
        + 'Zugangstoken, Netz-Freigaben, Agenten, Partnerlisten und Module werden grundsätzlich nicht übertragen.');
    }
    if (resultsTruncated) {
      addWarning(`Es werden nur die ersten ${MAX_RESULTS} Einzelmeldungen aufgeführt; die Zahlen oben sind vollständig.`);
    }

    pf.merkeGelesen(remoteId, {
      generation: box.generation,
      inhalt: typeof kopf.inhalt === 'string' ? kopf.inhalt : null,
      quittung: kopf.gesehen && Number.isInteger(kopf.gesehen[ich]) ? kopf.gesehen[ich] : 0,
      partner: Array.isArray(kopf.partner) ? kopf.partner.filter((p) => p && typeof p.id === 'string').map((p) => ({ id: p.id, name: typeof p.name === 'string' ? p.name : null })) : [],
      name: nameFern,
      version: typeof kopf.version === 'string' ? kopf.version : null,
      at: nowIso(),
    });

    emit('sync.folder', {
      action: 'pulled', deviceId: remoteId, generation: box.generation,
      fetched: totals.fetched, applied: totals.applied, conflicts: totals.conflicts, kopien: totals.kopien,
    });
    log.info(`${totals.applied} übernommen, ${totals.conflicts} zweimal verschieden, ${totals.skipped} übersprungen (von ${remoteId}).`);

    return {
      ...result,
      gelesen: true,
      grund: null,
      deviceName: nameFern,
      fetched: totals.fetched,
      applied: totals.applied,
      conflicts: totals.conflicts,
      kopien: totals.kopien,
      skipped: totals.skipped,
      identical: totals.identical,
      corrupt: totals.corrupt,
      partner: Array.isArray(kopf.partner) ? kopf.partner : [],
      warnings,
      results,
    };
  }

  /**
   * Ein Postfach aus EINEM Ordner lesen (für Werkzeuge und Tests).
   * @param {string} folder
   * @param {{deviceId:string, onProgress?:Function}} opts
   */
  async function pull(folder, opts = {}) {
    resolveFolder(folder, { write: false });
    return lesen([folder], opts.deviceId, opts);
  }

  /* --------------------------------------------------------------- syncAll */

  /**
   * Alle Partner-Postfächer in einem Ordner lesen, dann das eigene schreiben.
   * In dieser Reihenfolge, damit das eben Zusammengeführte schon im eigenen
   * Stand steht: Ein Dritter bekommt es so in einem Schritt statt in zweien.
   * Postfächer, die nicht von Partnern sind (`nur`), werden still übergangen.
   *
   * @param {string} folder
   * @param {{nur?:Set<string>|string[], ziel?:string, onProgress?:Function}} [opts]
   */
  async function syncAll(folder, opts = {}) {
    const report = reporter(opts.onProgress);
    const dir = resolveFolder(folder, { write: true });
    const pf = requirePostfach();
    const startedAt = nowIso();
    const ich = deviceId();
    const nur = opts.nur instanceof Set
      ? opts.nur
      : new Set(Array.isArray(opts.nur) ? opts.nur : (pf.empfaenger() || []).map((e) => e.id));

    const all = await peers(dir);
    const others = all.filter((p) => !p.isSelf && nur.has(p.deviceId));
    const warnings = [];
    const pulled = [];
    const totals = { fetched: 0, applied: 0, conflicts: 0, kopien: 0, skipped: 0 };
    let zwilling = false;

    let index = 0;
    for (const box of others) {
      index++;
      report({ phase: 'peer', done: index, total: others.length, deviceId: box.deviceId });
      try {
        const result = await lesen([dir], box.deviceId, { onProgress: opts.onProgress });
        totals.fetched += result.fetched;
        totals.applied += result.applied;
        totals.conflicts += result.conflicts;
        totals.kopien += result.kopien;
        totals.skipped += result.skipped;
        if (result.zwilling) zwilling = true;
        for (const text of result.warnings) if (warnings.length < MAX_WARNINGS) warnings.push(text);
        pulled.push({ ...result, skipped: !result.gelesen, error: null });
      } catch (err) {
        const neural = asNeuralError(err);
        warnings.push(`Postfach "${box.deviceName || box.deviceId}": ${neural.message}`);
        pulled.push({ deviceId: box.deviceId, deviceName: box.deviceName, skipped: false, error: neural.message, code: neural.code });
      }
    }

    let published = null;
    let publishError = null;
    if (!zwilling) {
      try {
        published = await publish(dir, { onProgress: opts.onProgress, ziel: opts.ziel });
        if (published.zwilling) zwilling = true;
        for (const text of published.warnings) if (warnings.length < MAX_WARNINGS) warnings.push(text);
      } catch (err) {
        const neural = asNeuralError(err);
        publishError = neural.message;
        warnings.push(`Der eigene Stand konnte nicht geschrieben werden: ${neural.message}`);
      }
    }

    if (!others.length) {
      warnings.push('In diesem Ordner liegt noch kein Postfach eines Partners. Der eigene Stand wurde geschrieben.');
    }

    const result = {
      folder: dir,
      deviceId: ich,
      startedAt,
      finishedAt: nowIso(),
      published,
      publishError,
      zwilling,
      peers: pulled,
      ...totals,
      warnings,
      ok: !publishError && !zwilling && pulled.every((p) => !p.error),
    };
    emit('sync.folder', { action: 'synced', folder: dir, deviceId: ich, ...totals, ok: result.ok });
    return result;
  }

  /* --------------------------------------------------------------- inspect */

  /**
   * "Ist dieser Ordner brauchbar, und was liegt darin?" – ohne etwas zu
   * ändern.
   */
  async function inspect(folder) {
    const problems = [];
    let dir;
    try {
      dir = resolveFolder(folder, { write: false });
    } catch (err) {
      return {
        ok: false, problems: [asNeuralError(err).message], mailboxes: [], bytes: 0,
        folder: String(folder || ''), deviceId: deviceId(), writable: false, freeBytes: null,
      };
    }

    let writable = true;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      writable = false;
      problems.push(`In ${dir} kann diese KI nicht schreiben.`);
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
      else if (box.stale && !box.isSelf) problems.push(`Das Postfach von "${box.deviceName || box.deviceId}" ist seit dem ${box.at} unverändert.`);
    }

    let freeBytes = null;
    if (typeof fs.statfsSync === 'function') {
      try {
        const st = fs.statfsSync(dir);
        freeBytes = Number(st.bavail) * Number(st.bsize);
        if (Number.isFinite(freeBytes) && freeBytes < 16 * 1024 * 1024) {
          problems.push(`Auf dem Datenträger sind nur noch ${Math.round(freeBytes / 1024 / 1024)} MB frei.`);
        }
      } catch {
        /* not every platform and filesystem answers statfs */
      }
    }

    if (!mailboxes.some((m) => m.isSelf)) {
      problems.push('Diese KI hat in diesem Ordner noch kein Postfach.');
    }

    return { ok: problems.length === 0, problems, mailboxes, bytes, folder: dir, deviceId: deviceId(), writable, freeBytes };
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

  /**
   * Liegt in diesem Ordner ein Postfach mit meiner Kennung, das ich nicht
   * geschrieben habe? Prüft nur, schreibt nichts.
   */
  async function fremdesPostfach(folder, opts = {}) {
    const dir = resolveFolder(folder, { write: false });
    const zielKey = typeof opts.ziel === 'string' && opts.ziel ? opts.ziel : path.resolve(dir);
    const zielStand = loadState().ziele[zielKey] || null;
    const vorhanden = await eigenesManifest(mailboxDir(dir, deviceId()));
    const lesbar = !!(vorhanden && Number.isInteger(vorhanden.generation) && isHex64(vorhanden.sha256));
    return !!(lesbar && zielStand && !passt(vorhanden, zielStand) && !passt(vorhanden, zielStand.vorher));
  }

  /**
   * Das eigene Postfach in diesem Ordner entfernen, aber nur, wenn es wirklich
   * von mir ist. Vor "eigenständig": Der andere Zwilling soll danach nicht
   * über ein liegengebliebenes Postfach stolpern.
   * @returns {Promise<boolean>} ob etwas entfernt wurde
   */
  async function eigenesEntfernen(folder, opts = {}) {
    let dir;
    try {
      dir = resolveFolder(folder, { write: false });
    } catch {
      return false;
    }
    const zielKey = typeof opts.ziel === 'string' && opts.ziel ? opts.ziel : path.resolve(dir);
    const zielStand = loadState().ziele[zielKey] || null;
    const mine = mailboxDir(dir, deviceId());
    const vorhanden = await eigenesManifest(mine);
    if (!vorhanden || !zielStand || !(passt(vorhanden, zielStand) || passt(vorhanden, zielStand.vorher))) return false;
    try {
      await fs.promises.rm(mine, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Eine PIN kam dazu: den Stand sofort versiegelt neu schreiben.
   * @returns {boolean} ob etwas geschrieben wurde
   */
  function neuVersiegeln() {
    if (!vault.enabled || vault.state !== 'unlocked') return false;
    if (!state && !fs.existsSync(statePath)) return false;
    loadState();
    return saveState();
  }

  /** Nach `identitaet.erneuern()`: sync-folder.json ist weg, der Speicherstand auch. */
  function vergessen() {
    state = null;
    eigeneKennung = null;
  }

  return {
    get deviceId() { return deviceId(); },
    get deviceName() { return deviceName(); },
    get protocol() { return FOLDER_PROTOCOL; },

    publish,
    peers,
    pull,
    lesen,
    syncAll,
    inspect,
    fremdesPostfach,
    eigenesEntfernen,
    neuVersiegeln,
    vergessen,

    /** Exposed for tests and the API layer; not part of the contract. */
    __internals: { resolveFolder, readMailbox, applyPlan, loadState, saveState, statePath },
  };
}

module.exports = {
  createFolderSync,
  postfachBauen,
  postfachOeffnen,
  gabelung,
  FOLDER_PROTOCOL,
  FORMAT,
  VERSCHLUESSELUNG,
  MANIFEST_NAME,
  RECORDS_NAME,
  ALT_RECORDS_NAME,
  TMP_PREFIX,
  STATE_FILE,
  DEVICE_ID_RE,
  BATCH_SIZE,
  STALE_AFTER_MS,
};
