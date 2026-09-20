'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LockedError, StorageError, ValidationError } = require('../kernel/errors');

/**
 * Vault encryption at rest.
 *
 * Why two keys instead of one
 * ---------------------------
 * The passphrase never encrypts user data directly. A random 32-byte *data
 * key* encrypts everything; the passphrase only derives a *key-encryption key*
 * (KEK) that wraps the data key. Changing the passphrase therefore rewraps 32
 * bytes instead of rewriting a multi-gigabyte vault -- which is the difference
 * between a passphrase the user actually rotates and one they never touch.
 *
 * Why a separate keyCheck
 * -----------------------
 * Unwrapping the data key would already fail on a wrong passphrase (GCM
 * authenticates), but then "wrong passphrase" and "secrets.json is damaged"
 * look identical, and the user is told to retype a passphrase that was right
 * all along. keyCheck is a known constant sealed under the KEK: if it opens,
 * the passphrase is correct, so a failure *after* it is corruption and gets a
 * StorageError instead of a LockedError. Two different problems, two different
 * remedies.
 *
 * Why random IVs
 * --------------
 * Every record gets a fresh 12-byte random IV. Under a single key, random
 * 96-bit IVs collide with probability ~2^-33 at 2^32 records -- far beyond any
 * personal vault, and unlike a counter it needs no shared state between
 * processes or across crashes. Honest statement: this is "collision is
 * negligible", not "collision is impossible".
 *
 * Why identity functions when disabled
 * ------------------------------------
 * `encryptLine`/`decryptLine` are pass-throughs when encryption is off, so the
 * store has exactly ONE code path for reads and writes. A second, unencrypted
 * path is where the bug lives that writes plaintext into an encrypted vault.
 *
 * Why secrets.json is fsynced
 * ---------------------------
 * Losing secrets.json loses the data key and therefore the entire vault, with
 * no recovery. It is written to a temp file, fsynced, renamed, and the
 * directory entry is fsynced too -- a crash mid-write can leave the old file
 * or the new one, never a truncated one.
 */

const SECRETS_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

/** Contracted KDF cost. 128 * N * r bytes of memory, ~0.9 s on a 2024 laptop. */
const SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/** Node refuses scrypt when 128*N*r exceeds maxmem, so give it headroom. */
const SCRYPT_MAXMEM = 256 * SCRYPT.N * SCRYPT.r;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_PASSPHRASE = 8;

/** Sealed under the KEK to prove a passphrase before touching the data key. */
const KEY_CHECK_PLAINTEXT = Buffer.from('neural-os:vault:v1', 'utf8');

/** Guard rails for parameters read back from disk: a hostile or corrupt
 *  secrets.json must not be able to request 64 GB of scrypt memory. */
const PARAM_LIMITS = { minN: 2 ** 14, maxN: 2 ** 20, maxR: 32, maxP: 16 };

function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

function deriveKey(passphrase, salt, params) {
  const { N, r, p } = params;
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(passphrase, 'utf8'),
      salt,
      KEY_BYTES,
      { N, r, p, maxmem: Math.max(SCRYPT_MAXMEM, 256 * N * r) },
      (err, key) => (err ? reject(new StorageError(`Schluesselableitung fehlgeschlagen: ${err.message}`)) : resolve(key)),
    );
  });
}

/** @returns {{iv:string, tag:string, ct:string}} base64 parts */
function seal(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/** @throws {Error} plain Error on authentication failure; callers classify it. */
function open(key, sealed) {
  const iv = Buffer.from(String(sealed.iv), 'base64');
  const tag = Buffer.from(String(sealed.tag), 'base64');
  const ct = Buffer.from(String(sealed.ct), 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed sealed blob');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Wire format shared by lines and buffers: iv(12) || tag(16) || ciphertext. */
function packSealed(sealed) {
  return Buffer.concat([
    Buffer.from(sealed.iv, 'base64'),
    Buffer.from(sealed.tag, 'base64'),
    Buffer.from(sealed.ct, 'base64'),
  ]);
}

function unpackSealed(buf) {
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('blob too short');
  return {
    iv: buf.subarray(0, IV_BYTES).toString('base64'),
    tag: buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES).toString('base64'),
    ct: buf.subarray(IV_BYTES + TAG_BYTES).toString('base64'),
  };
}

function zero(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

function assertPassphrase(value, label = 'Passphrase') {
  if (typeof value !== 'string') throw new ValidationError(`${label} muss eine Zeichenkette sein.`);
  if (value.length < MIN_PASSPHRASE) {
    // A KDF cost of 2^17 buys nothing against a four-character passphrase;
    // the length floor is the only part of this that stops a dictionary.
    throw new ValidationError(`${label} muss mindestens ${MIN_PASSPHRASE} Zeichen lang sein.`);
  }
}

/**
 * @param {{paths:object, config:object}} deps
 * @returns {object} VaultCrypto
 */
function createVaultCrypto({ paths, config } = {}) {
  if (!paths || typeof paths.secrets !== 'string') {
    throw new ValidationError('createVaultCrypto benoetigt paths.secrets.');
  }
  const secretsPath = paths.secrets;

  /** @type {Buffer|null} the unwrapped data key; null means locked. */
  let dataKey = null;
  /** Cached because `enabled` is read on every single encrypted line; a stat
   *  syscall per log line would dominate the store's write path. */
  let secretsPresent = fileExists(secretsPath);
  /**
   * Concurrency control for unlock. Two guarantees:
   *  - a repeat of the SAME passphrase (double-clicked button) reuses the
   *    running derivation instead of paying 0.9 s twice;
   *  - a DIFFERENT passphrase never rides on someone else's result, and waits
   *    its turn, so N attempts cannot pin N * 128 MB of scrypt memory at once.
   * @type {{fp:string, promise:Promise<true>}|null}
   */
  let unlockInFlight = null;
  let unlockQueue = Promise.resolve();

  function fingerprint(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
  }

  function fileExists(p) {
    try {
      fs.accessSync(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  function configFlag() {
    return Boolean(config && config.security && config.security.encryption && config.security.encryption.enabled);
  }

  /**
   * Encryption counts as on when the config says so OR key material exists.
   * The second half matters: if config.json is lost or reset to defaults, the
   * vault is still ciphertext, and treating it as plaintext would look like
   * total corruption to the user.
   */
  function isEnabled() {
    return configFlag() || secretsPresent;
  }

  function requireUnlocked() {
    if (!dataKey) throw new LockedError('Der Vault ist gesperrt. Bitte zuerst mit der Passphrase entsperren.');
  }

  function readSecrets() {
    let raw;
    try {
      raw = fs.readFileSync(secretsPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new StorageError('Es ist kein Schluesselmaterial vorhanden (secrets.json fehlt).');
      }
      throw new StorageError(`secrets.json ist nicht lesbar: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new StorageError(`secrets.json ist beschaedigt (kein gueltiges JSON): ${err.message}`);
    }
    return validateSecrets(parsed);
  }

  function validateSecrets(s) {
    const problems = [];
    if (!s || typeof s !== 'object') problems.push('kein Objekt');
    else {
      if (s.v !== SECRETS_VERSION) problems.push(`unbekannte Version ${s.v}`);
      if (s.kdf !== 'scrypt') problems.push(`unbekannte KDF ${s.kdf}`);
      if (typeof s.salt !== 'string' || !s.salt) problems.push('salt fehlt');
      if (!isPowerOfTwo(s.N) || s.N < PARAM_LIMITS.minN || s.N > PARAM_LIMITS.maxN) problems.push('N ausserhalb des zulaessigen Bereichs');
      if (!Number.isInteger(s.r) || s.r < 1 || s.r > PARAM_LIMITS.maxR) problems.push('r ausserhalb des zulaessigen Bereichs');
      if (!Number.isInteger(s.p) || s.p < 1 || s.p > PARAM_LIMITS.maxP) problems.push('p ausserhalb des zulaessigen Bereichs');
      for (const field of ['keyCheck', 'wrappedKey']) {
        const v = s[field];
        if (!v || typeof v !== 'object' || typeof v.iv !== 'string' || typeof v.tag !== 'string' || typeof v.ct !== 'string') {
          problems.push(`${field} fehlt oder ist unvollstaendig`);
        }
      }
    }
    if (problems.length) throw new StorageError(`secrets.json ist beschaedigt: ${problems.join('; ')}`);
    return s;
  }

  function writeSecrets(secrets) {
    const dir = path.dirname(secretsPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${secretsPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let fd = null;
    try {
      // 'wx' so we never clobber a concurrent writer's temp file.
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(secrets, null, 2) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, secretsPath);
      fsyncDir(dir);
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw new StorageError(`secrets.json konnte nicht geschrieben werden: ${err.message}`);
    }
    try { fs.chmodSync(secretsPath, 0o600); } catch { /* exFAT & co. ignore modes */ }
    secretsPresent = true;
  }

  function fsyncDir(dir) {
    let dfd = null;
    try {
      dfd = fs.openSync(dir, 'r');
      fs.fsyncSync(dfd);
    } catch {
      // Directory fsync is unsupported on some platforms/filesystems; the
      // rename is still atomic there, only the ordering guarantee is weaker.
    } finally {
      if (dfd !== null) { try { fs.closeSync(dfd); } catch { /* ignore */ } }
    }
  }

  /** Derive the KEK and prove the passphrase against keyCheck. */
  async function deriveAndVerify(passphrase, secrets) {
    const salt = Buffer.from(secrets.salt, 'base64');
    if (!salt.length) throw new StorageError('secrets.json ist beschaedigt: salt ist leer.');
    const kek = await deriveKey(passphrase, salt, { N: secrets.N, r: secrets.r, p: secrets.p });
    let check;
    try {
      check = open(kek, secrets.keyCheck);
    } catch {
      zero(kek);
      throw new LockedError('Falsche Passphrase.');
    }
    if (check.length !== KEY_CHECK_PLAINTEXT.length || !crypto.timingSafeEqual(check, KEY_CHECK_PLAINTEXT)) {
      zero(kek);
      throw new LockedError('Falsche Passphrase.');
    }
    return kek;
  }

  /** keyCheck already passed, so a failure here is damage, not a typo. */
  function unwrapDataKey(kek, secrets) {
    let key;
    try {
      key = open(kek, secrets.wrappedKey);
    } catch (err) {
      throw new StorageError(
        `Die Passphrase ist korrekt, aber der verpackte Datenschluessel ist beschaedigt: ${err.message}. `
        + 'Bitte eine Sicherung von secrets.json einspielen.',
      );
    }
    if (key.length !== KEY_BYTES) {
      zero(key);
      throw new StorageError('Der entpackte Datenschluessel hat eine ungueltige Laenge.');
    }
    return key;
  }

  function sealNewSecrets(kek, key) {
    return { keyCheck: seal(kek, KEY_CHECK_PLAINTEXT), wrappedKey: seal(kek, key) };
  }

  function markConfigEnabled() {
    // In-memory only: persisting config.json is the caller's job (app.js owns
    // the file). Flipping it here keeps `enabled` truthful for the rest of
    // this process even before the config is saved.
    if (!config || typeof config !== 'object') return;
    if (!config.security || typeof config.security !== 'object') config.security = {};
    if (!config.security.encryption || typeof config.security.encryption !== 'object') config.security.encryption = {};
    config.security.encryption.enabled = true;
    config.security.encryption.kdf = 'scrypt';
    config.security.encryption.algorithm = ALGORITHM;
  }

  const api = {
    get enabled() {
      return isEnabled();
    },

    /** @returns {'disabled'|'locked'|'unlocked'} */
    get state() {
      if (!isEnabled()) return 'disabled';
      return dataKey ? 'unlocked' : 'locked';
    },

    /** Whether key material exists on disk, regardless of the config flag. */
    hasSecrets() {
      return secretsPresent;
    },

    /** Public KDF parameters for the settings UI. Never exposes key material. */
    info() {
      const out = { state: api.state, enabled: api.enabled, algorithm: ALGORITHM, hasSecrets: secretsPresent };
      if (!secretsPresent) return out;
      try {
        const s = readSecrets();
        return { ...out, kdf: s.kdf, N: s.N, r: s.r, p: s.p, createdAt: s.createdAt ?? null, updatedAt: s.updatedAt ?? null };
      } catch (err) {
        return { ...out, problem: err.message };
      }
    },

    /**
     * Turn encryption on: generate the data key, wrap it, persist secrets.json.
     * Leaves the vault UNLOCKED so the caller can immediately rewrite existing
     * plaintext records through the same seam.
     */
    async initialise(passphrase) {
      assertPassphrase(passphrase);
      if (secretsPresent) {
        // Overwriting secrets.json would strand every record already encrypted
        // under the old data key. Refuse loudly instead.
        throw new StorageError('Es existiert bereits Schluesselmaterial. changePassphrase() verwenden oder secrets.json zuerst sichern und entfernen.');
      }
      const salt = crypto.randomBytes(SALT_BYTES);
      const kek = await deriveKey(passphrase, salt, SCRYPT);
      const key = crypto.randomBytes(KEY_BYTES);
      try {
        const { keyCheck, wrappedKey } = sealNewSecrets(kek, key);
        const now = new Date().toISOString();
        writeSecrets({
          v: SECRETS_VERSION,
          kdf: 'scrypt',
          N: SCRYPT.N,
          r: SCRYPT.r,
          p: SCRYPT.p,
          salt: salt.toString('base64'),
          keyCheck,
          wrappedKey,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        zero(key);
        throw err;
      } finally {
        zero(kek);
      }
      if (dataKey) zero(dataKey);
      dataKey = key;
      markConfigEnabled();
      return true;
    },

    /**
     * @param {string} passphrase
     * @returns {Promise<true>}
     * @throws {LockedError} wrong passphrase
     * @throws {StorageError} damaged key material
     */
    async unlock(passphrase) {
      if (!isEnabled()) {
        throw new ValidationError('Der Vault ist nicht verschluesselt; es gibt nichts zu entsperren.');
      }
      if (dataKey) return true;
      assertPassphrase(passphrase);
      const fp = fingerprint(passphrase);
      if (unlockInFlight && unlockInFlight.fp === fp) return unlockInFlight.promise;

      const promise = unlockQueue.then(doUnlock, doUnlock);
      unlockInFlight = { fp, promise };
      // Keep the queue alive after a rejection: a wrong passphrase must not
      // wedge every later attempt.
      unlockQueue = promise.catch(() => {});
      try {
        return await promise;
      } finally {
        if (unlockInFlight && unlockInFlight.promise === promise) unlockInFlight = null;
      }

      async function doUnlock() {
        if (dataKey) return true;
        const secrets = readSecrets();
        const kek = await deriveAndVerify(passphrase, secrets);
        try {
          const key = unwrapDataKey(kek, secrets);
          if (dataKey) zero(dataKey);
          dataKey = key;
        } finally {
          zero(kek);
        }
        // A secrets.json readable by other users is a real exposure; quietly
        // tightening it is more useful than a warning nobody reads.
        try { fs.chmodSync(secretsPath, 0o600); } catch { /* best effort */ }
        return true;
      }
    },

    /** Overwrite the key in memory. Cheap, and the only thing standing between
     *  a core dump and the user's data. */
    lock() {
      if (dataKey) {
        zero(dataKey);
        dataKey = null;
      }
    },

    /**
     * @param {string} line
     * @returns {string} base64(iv|tag|ct), newline-free so it fits JSONL
     */
    encryptLine(line) {
      if (!isEnabled()) return line;
      requireUnlocked();
      if (typeof line !== 'string') throw new ValidationError('encryptLine erwartet eine Zeichenkette.');
      return packSealed(seal(dataKey, Buffer.from(line, 'utf8'))).toString('base64');
    },

    /** @param {string} payload @returns {string} */
    decryptLine(payload) {
      if (!isEnabled()) return payload;
      requireUnlocked();
      if (typeof payload !== 'string') throw new ValidationError('decryptLine erwartet eine Zeichenkette.');
      let buf;
      try {
        buf = Buffer.from(payload, 'base64');
      } catch (err) {
        throw new StorageError(`Zeile ist kein gueltiges Base64: ${err.message}`);
      }
      try {
        return open(dataKey, unpackSealed(buf)).toString('utf8');
      } catch (err) {
        throw new StorageError(
          `Eine Zeile konnte nicht entschluesselt werden (${err.message}). `
          + 'Moegliche Ursachen: beschaedigte Datei oder unverschluesselte Altdaten.',
        );
      }
    },

    /** @param {Buffer} buf @returns {Buffer} iv|tag|ct */
    encryptBuffer(buf) {
      if (!isEnabled()) return buf;
      requireUnlocked();
      if (!Buffer.isBuffer(buf)) throw new ValidationError('encryptBuffer erwartet einen Buffer.');
      return packSealed(seal(dataKey, buf));
    },

    /** @param {Buffer} buf @returns {Buffer} */
    decryptBuffer(buf) {
      if (!isEnabled()) return buf;
      requireUnlocked();
      if (!Buffer.isBuffer(buf)) throw new ValidationError('decryptBuffer erwartet einen Buffer.');
      try {
        return open(dataKey, unpackSealed(buf));
      } catch (err) {
        throw new StorageError(`Eine Datei konnte nicht entschluesselt werden (${err.message}).`);
      }
    },

    /**
     * Rotate the passphrase without touching a single record: the data key is
     * unwrapped with the old KEK and rewrapped under a new KEK with a fresh
     * salt. `old` is always verified, even when the vault is already unlocked --
     * otherwise an unattended unlocked session would let anyone reset it.
     */
    async changePassphrase(oldPassphrase, nextPassphrase) {
      if (!isEnabled() || !secretsPresent) {
        throw new ValidationError('Der Vault ist nicht verschluesselt; es gibt keine Passphrase zu aendern.');
      }
      assertPassphrase(oldPassphrase, 'Alte Passphrase');
      assertPassphrase(nextPassphrase, 'Neue Passphrase');
      const secrets = readSecrets();
      const oldKek = await deriveAndVerify(oldPassphrase, secrets);
      let key;
      try {
        key = unwrapDataKey(oldKek, secrets);
      } finally {
        zero(oldKek);
      }
      const salt = crypto.randomBytes(SALT_BYTES);
      const newKek = await deriveKey(nextPassphrase, salt, SCRYPT);
      try {
        const { keyCheck, wrappedKey } = sealNewSecrets(newKek, key);
        writeSecrets({
          ...secrets,
          v: SECRETS_VERSION,
          kdf: 'scrypt',
          N: SCRYPT.N,
          r: SCRYPT.r,
          p: SCRYPT.p,
          salt: salt.toString('base64'),
          keyCheck,
          wrappedKey,
          createdAt: secrets.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        zero(key);
        throw err;
      } finally {
        zero(newKek);
      }
      if (dataKey && dataKey !== key) zero(dataKey);
      dataKey = key;
      markConfigEnabled();
      return true;
    },
  };

  return api;
}

module.exports = {
  createVaultCrypto,
  SECRETS_VERSION,
  SCRYPT,
  ALGORITHM,
  IV_BYTES,
  TAG_BYTES,
  MIN_PASSPHRASE,
};
