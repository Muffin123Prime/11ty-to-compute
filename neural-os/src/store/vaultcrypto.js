'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LockedError, StorageError, ValidationError } = require('../kernel/errors');
const { schreibeDauerhaft } = require('../kernel/dateien');

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
 *
 * PIN statt Passphrase (Entscheidung des Nutzers)
 * -----------------------------------------------
 * `MIN_PASSPHRASE = 8` bleibt für frei gewählten Text: Dort ist die Länge das
 * Einzige, was ein Wörterbuch aufhält. Zusätzlich gilt eine PIN aus 4 bis 6
 * Ziffern -- und nur Ziffern. Eine 5-Buchstaben-Passphrase ("hallo") bleibt
 * abgewiesen, denn sie ist schwächer als sie aussieht; eine PIN ist ehrlich
 * das, was sie ist. Was sie kostet, wurde gemessen und steht in der
 * Oberfläche: scrypt N=2^17, r=8, p=1 braucht auf einem Kern eines 2,8-GHz-
 * Xeon 0,44-0,47 s je Versuch (128 MB). Alle 10.000 vierstelligen PINs sind
 * damit in etwa 75 Minuten durchprobiert, alle 1.000.000 sechsstelligen in
 * etwa 5 Tagen auf einem Kern. Eine PIN hält Neugierige ab, keinen Profi mit
 * Zeit. N wird dafür nicht erhöht: 2^18 verdoppelt beides, die Wartezeit des
 * Nutzers bei jedem Start und die des Angreifers -- das ändert an diesem Satz
 * nichts, kostet aber 256 MB auf jedem Schullaptop.
 *
 * Dieses Gerät merken
 * -------------------
 * Auf dem eigenen Laptop soll die PIN nicht bei jedem Start gefragt werden.
 * Dafür liegt NICHT die PIN und NICHT der Datenschlüssel auf dem Rechner,
 * sondern ein zufälliger Geräteschlüssel (32 Byte) im Benutzerprofil, AUSSERHALB
 * des Sticks. Auf dem Stick steht in secrets.json nur der Datenschlüssel,
 * mit diesem Geräteschlüssel verpackt. Folgen:
 *  - Laptop allein (ohne Stick): ein Schlüssel zu nichts.
 *  - Stick allein: ohne PIN verschlossen, wie ohne Merken.
 *  - "Alle gemerkten Geräte vergessen" löscht die Einträge auf dem Stick;
 *    ab da ist jede Datei auf jedem Laptop wertlos, auch auf einem, der
 *    gerade nicht angeschlossen ist.
 * Der Name des Geräts ist mit dem Datenschlüssel versiegelt, damit ein
 * Finder des Sticks nicht liest, an welchen Rechnern er steckte.
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
/** Eine PIN: nur Ziffern, 4 bis 6 Stellen (siehe Kopf). */
const MIN_PIN = 4;
const MAX_PIN = 6;
const PIN_RE = /^[0-9]{4,6}$/;

/** Dateiname eines gemerkten Geräts: die KI-Kennung, nichts, was einen Pfad bilden könnte. */
const KI_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const GERAETE_VERSION = 1;
/** Mehr gemerkte Rechner als das sind keine "eigenen" mehr, sondern ein Leck. */
const MAX_GERAETE = 16;
/** Abgeleitet aus dem Datenschlüssel; nur für die Sitzungsbindung (auth.js). */
const SITZUNG_INFO = Buffer.from('neural-os:pin-sitzung:v1', 'utf8');

/**
 * Jede Instanz unter ihrer Konfiguration, damit src/http/auth.js die
 * Verschlüsselung findet, ohne dass src/app.js sie ihm reichen muss. Eine
 * WeakMap, damit ein beendeter Testlauf nichts festhält.
 */
const INSTANZEN = new WeakMap();

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

/** Eine PIN aus 4 bis 6 Ziffern? */
function istPin(value) {
  return typeof value === 'string' && PIN_RE.test(value);
}

function assertPassphrase(value, label = 'Passphrase') {
  if (typeof value !== 'string') throw new ValidationError(`${label} muss eine Zeichenkette sein.`);
  if (istPin(value)) return;
  if (value.length < MIN_PASSPHRASE) {
    // A KDF cost of 2^17 buys nothing against a four-character passphrase;
    // the length floor is the only part of this that stops a dictionary.
    // Die einzige Ausnahme ist eine erklärte PIN aus Ziffern (siehe Kopf).
    throw new ValidationError(
      `${label} muss eine PIN aus ${MIN_PIN} bis ${MAX_PIN} Ziffern sein oder mindestens ${MIN_PASSPHRASE} Zeichen lang.`,
    );
  }
}

/**
 * Wo "Dieses Gerät merken" seinen Schlüssel ablegt: im Benutzerprofil dieses
 * Rechners, nie auf dem Stick.
 *
 * Windows: %LOCALAPPDATA%, nicht %APPDATA%. "Dieses Gerät" heißt dieser
 * Rechner; ein Roaming-Profil im Schulnetz würde den Schlüssel sonst auf
 * jeden Rechner der Schule mitnehmen und auf einem Server ablegen.
 * `NEURAL_OS_GERAETE` überschreibt den Ort (Tests, Sonderfälle).
 * @returns {string}
 */
function geraeteOrdner(env = process.env, platform = process.platform) {
  if (env.NEURAL_OS_GERAETE) return path.resolve(env.NEURAL_OS_GERAETE);
  const heim = (() => {
    try { return os.homedir(); } catch { return ''; }
  })();
  if (platform === 'win32') {
    const basis = env.LOCALAPPDATA || env.APPDATA || (heim ? path.join(heim, 'AppData', 'Local') : '');
    return path.join(basis, 'NeuralOS', 'geraete');
  }
  if (platform === 'darwin') {
    return path.join(heim, 'Library', 'Application Support', 'NeuralOS', 'geraete');
  }
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(heim, '.config');
  return path.join(xdg, 'neural-os', 'geraete');
}

/** Die KI-Kennung aus der Konfiguration, falls sie als Dateiname taugt. */
function kiIdAus(config) {
  const id = config && config.sync && typeof config.sync === 'object' ? config.sync.deviceId : null;
  return typeof id === 'string' && KI_ID_RE.test(id) ? id : null;
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function istVersiegelt(v) {
  return !!v && typeof v === 'object' && typeof v.iv === 'string' && typeof v.tag === 'string' && typeof v.ct === 'string';
}

/**
 * @param {{paths:object, config:object, geraet?:boolean, geraeteOrdner?:string}} deps
 *   `geraet: false` schaltet das Entsperren über ein gemerktes Gerät ab
 *   (Werkzeuge, die bewusst die PIN verlangen). `geraeteOrdner` ersetzt den
 *   Ort im Benutzerprofil (Tests).
 * @returns {object} VaultCrypto
 */
function createVaultCrypto({ paths, config, geraet: geraetErlaubt = true, geraeteOrdner: ordnerVorgabe } = {}) {
  if (!paths || typeof paths.secrets !== 'string') {
    throw new ValidationError('createVaultCrypto benoetigt paths.secrets.');
  }
  const secretsPath = paths.secrets;
  const ordnerGeraete = () => (ordnerVorgabe ? path.resolve(ordnerVorgabe) : geraeteOrdner());

  /** @type {Buffer|null} the unwrapped data key; null means locked. */
  let dataKey = null;
  /**
   * Womit entsperrt wurde: 'pin' (PIN oder Passphrase), 'geraet' (gemerkter
   * Rechner) oder null (gesperrt). auth.js bindet den Browser nur, wenn NICHT
   * über das gemerkte Gerät entsperrt wurde -- auf dem eigenen Laptop soll
   * nichts fragen, auf einem fremden schon.
   * @type {'pin'|'geraet'|null}
   */
  let entsperrtDurch = null;
  /** Aus dem Datenschlüssel abgeleitet, solange entsperrt. */
  let sitzungsKey = null;
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
    // Gemerkte Geräte sind eine Bequemlichkeit. Ein beschädigter Eintrag darf
    // das Entsperren mit der PIN nie verhindern, also wird er übergangen.
    s.geraete = Array.isArray(s.geraete)
      ? s.geraete.filter((g) => g && typeof g.id === 'string' && istVersiegelt(g.wrappedKey))
      : [];
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
        return {
          ...out,
          kdf: s.kdf,
          N: s.N,
          r: s.r,
          p: s.p,
          art: s.art === 'pin' ? 'pin' : 'passphrase',
          entsperrtDurch: dataKey ? entsperrtDurch : null,
          gemerkteGeraete: s.geraete.length,
          createdAt: s.createdAt ?? null,
          updatedAt: s.updatedAt ?? null,
        };
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
          // Nur für die Wortwahl ("PIN" oder "Passphrase"). Wer den Stick
          // findet, probiert ohnehin zuerst Ziffern; die Länge steht nirgends.
          art: istPin(passphrase) ? 'pin' : 'passphrase',
          geraete: [],
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        zero(key);
        throw err;
      } finally {
        zero(kek);
      }
      setzeSchluessel(key, 'pin');
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
          setzeSchluessel(key, 'pin');
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
      if (sitzungsKey) {
        zero(sitzungsKey);
        sitzungsKey = null;
      }
      entsperrtDurch = null;
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
          art: istPin(nextPassphrase) ? 'pin' : 'passphrase',
          createdAt: secrets.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        zero(key);
        throw err;
      } finally {
        zero(newKek);
      }
      // Wer über das gemerkte Gerät entsperrt hatte, bleibt es: die PIN zu
      // ändern macht aus dem eigenen Laptop keinen fremden.
      setzeSchluessel(key, entsperrtDurch === 'geraet' ? 'geraet' : 'pin');
      markConfigEnabled();
      return true;
    },

    /* ---------------------------------------------------------- PIN & Geräte */

    /** Womit entsperrt wurde: 'pin', 'geraet' oder null. */
    get entsperrtDurch() {
      return dataKey ? entsperrtDurch : null;
    },

    /**
     * Die PIN prüfen, ohne etwas zu ändern -- auch wenn schon entsperrt ist.
     * Gebraucht, wenn ein zweiter Browser dieselbe laufende KI benutzen will
     * oder ein Gerät gemerkt werden soll: dort reicht "ist doch offen" nicht.
     * @throws {LockedError} falsche PIN
     */
    async pruefen(passphrase) {
      if (!isEnabled() || !secretsPresent) {
        throw new ValidationError('Der Vault ist nicht verschluesselt; es gibt keine PIN zu pruefen.');
      }
      assertPassphrase(passphrase);
      const secrets = readSecrets();
      const kek = await deriveAndVerify(passphrase, secrets);
      zero(kek);
      return true;
    },

    /** 'pin' oder 'passphrase' -- nur für die Wortwahl der Oberfläche. */
    art() {
      if (!secretsPresent) return null;
      try {
        return readSecrets().art === 'pin' ? 'pin' : 'passphrase';
      } catch {
        return null;
      }
    },

    /** Der Ordner im Benutzerprofil, in dem gemerkte Geräte liegen. */
    geraeteOrdner() {
      return ordnerGeraete();
    },

    /**
     * Ist DIESER Rechner für diese KI gemerkt (und passt der Eintrag noch)?
     * @param {string} [kiId] Vorgabe: config.sync.deviceId
     */
    geraetGemerkt(kiId = kiIdAus(config)) {
      const datei = geraetDateiLesen(kiId);
      if (!datei || !secretsPresent) return false;
      try {
        return readSecrets().geraete.some((g) => g.id === datei.eintrag);
      } catch {
        return false;
      }
    },

    /**
     * Diesen Rechner merken. Verlangt einen entsperrten Tresor.
     * @param {{kiId:string, name?:string}} opts
     * @returns {{id:string, datei:string}}
     */
    merken({ kiId, name } = {}) {
      requireUnlocked();
      if (!secretsPresent) throw new ValidationError('Ohne PIN gibt es nichts zu merken.');
      if (typeof kiId !== 'string' || !KI_ID_RE.test(kiId)) throw new ValidationError('Die Kennung dieser KI fehlt oder ist ungueltig.');
      const secrets = readSecrets();
      const vorher = geraetDateiLesen(kiId);
      const uebrig = secrets.geraete.filter((g) => !vorher || g.id !== vorher.eintrag);
      if (uebrig.length >= MAX_GERAETE) {
        throw new ValidationError(`Es sind schon ${MAX_GERAETE} Geräte gemerkt. Bitte zuerst alle vergessen.`);
      }
      const geraetKey = crypto.randomBytes(KEY_BYTES);
      const id = `g_${b64url(crypto.randomBytes(9))}`;
      const angelegt = new Date().toISOString();
      const anzeige = String(name || '').slice(0, 80) || 'Dieser Rechner';
      const eintrag = {
        id,
        wrappedKey: seal(geraetKey, dataKey),
        name: seal(dataKey, Buffer.from(anzeige, 'utf8')),
        angelegt,
      };
      const ordner = ordnerGeraete();
      const datei = path.join(ordner, `${kiId}.json`);
      // Erst die Datei auf dem Rechner, dann der Eintrag auf dem Stick:
      // scheitert der zweite Schritt, wird die Datei wieder entfernt, und
      // es bleibt nie ein Eintrag ohne Schlüssel zurück.
      try {
        fs.mkdirSync(ordner, { recursive: true, mode: 0o700 });
        schreibeDauerhaft(datei, JSON.stringify({
          v: GERAETE_VERSION, kiId, eintrag: id, schluessel: geraetKey.toString('base64'), angelegt,
        }) + '\n');
      } catch (err) {
        zero(geraetKey);
        throw new StorageError(`Der Schlüssel konnte auf diesem Rechner nicht abgelegt werden: ${err.message}`);
      }
      zero(geraetKey);
      try {
        writeSecrets({ ...secrets, geraete: [...uebrig, eintrag], updatedAt: angelegt });
      } catch (err) {
        try { fs.unlinkSync(datei); } catch { /* war nie da */ }
        throw err;
      }
      // Ab jetzt gilt dieser Rechner als gemerkt, nicht erst nach dem
      // nächsten Start: wer ihn eben gemerkt hat, will hier nicht mehr gefragt werden.
      entsperrtDurch = 'geraet';
      return { id, datei };
    },

    /**
     * Diesen Rechner vergessen: Datei im Profil und Eintrag auf dem Stick.
     * @returns {{entfernt:boolean}}
     */
    vergessen({ kiId = kiIdAus(config) } = {}) {
      const datei = geraetDateiLesen(kiId);
      let entfernt = false;
      if (datei) {
        if (secretsPresent) {
          const secrets = readSecrets();
          const rest = secrets.geraete.filter((g) => g.id !== datei.eintrag);
          if (rest.length !== secrets.geraete.length) {
            writeSecrets({ ...secrets, geraete: rest, updatedAt: new Date().toISOString() });
          }
        }
        try { fs.unlinkSync(datei.pfad); entfernt = true; } catch { /* schon weg */ }
      }
      if (entfernt && entsperrtDurch === 'geraet') entsperrtDurch = 'pin';
      return { entfernt };
    },

    /**
     * Alle gemerkten Geräte auf dem Stick streichen. Wirkt auch für Rechner,
     * die gerade nicht da sind: ihre Datei öffnet danach nichts mehr.
     * @returns {{entfernt:number}}
     */
    alleVergessen({ kiId = kiIdAus(config) } = {}) {
      let anzahl = 0;
      if (secretsPresent) {
        const secrets = readSecrets();
        anzahl = secrets.geraete.length;
        if (anzahl) writeSecrets({ ...secrets, geraete: [], updatedAt: new Date().toISOString() });
      }
      const datei = geraetDateiLesen(kiId);
      if (datei) {
        try { fs.unlinkSync(datei.pfad); } catch { /* schon weg */ }
      }
      if (entsperrtDurch === 'geraet') entsperrtDurch = 'pin';
      return { entfernt: anzahl };
    },

    /**
     * Die gemerkten Geräte. Namen nur, wenn entsperrt (sie sind versiegelt).
     * @returns {Array<{id:string, name:string|null, angelegt:string|null, diesesGeraet:boolean}>}
     */
    geraete({ kiId = kiIdAus(config) } = {}) {
      if (!secretsPresent) return [];
      let secrets;
      try {
        secrets = readSecrets();
      } catch {
        return [];
      }
      const hier = geraetDateiLesen(kiId);
      return secrets.geraete.map((g) => {
        let name = null;
        if (dataKey && istVersiegelt(g.name)) {
          try { name = open(dataKey, g.name).toString('utf8'); } catch { name = null; }
        }
        return { id: g.id, name, angelegt: typeof g.angelegt === 'string' ? g.angelegt : null, diesesGeraet: !!hier && hier.eintrag === g.id };
      });
    },

    /**
     * HMAC-SHA256 über `nachricht` mit einem aus dem Datenschlüssel
     * abgeleiteten Schlüssel. Damit bindet auth.js einen Browser an das
     * Entsperren: jeder Prozess, der diesen Tresor geöffnet hat (auch der
     * spätere Vorraum), kann das Siegel ausstellen und prüfen, und nach
     * einem Neustart gilt es weiter -- ohne dass irgendwo eine Sitzungsliste
     * liegt. Gesperrt gibt es kein Siegel.
     * @param {string} nachricht
     * @returns {Buffer}
     */
    sitzungsSiegel(nachricht) {
      requireUnlocked();
      if (!sitzungsKey) {
        sitzungsKey = Buffer.from(crypto.hkdfSync('sha256', dataKey, Buffer.alloc(0), SITZUNG_INFO, KEY_BYTES));
      }
      return crypto.createHmac('sha256', sitzungsKey).update(String(nachricht), 'utf8').digest();
    },
  };

  function setzeSchluessel(key, wie) {
    if (dataKey && dataKey !== key) zero(dataKey);
    if (sitzungsKey) {
      zero(sitzungsKey);
      sitzungsKey = null;
    }
    dataKey = key;
    entsperrtDurch = wie;
  }

  /** @returns {{kiId:string, eintrag:string, schluessel:Buffer, pfad:string}|null} */
  function geraetDateiLesen(kiId) {
    if (typeof kiId !== 'string' || !KI_ID_RE.test(kiId)) return null;
    const pfad = path.join(ordnerGeraete(), `${kiId}.json`);
    let roh;
    try {
      roh = JSON.parse(fs.readFileSync(pfad, 'utf8'));
    } catch {
      return null;
    }
    if (!roh || roh.v !== GERAETE_VERSION || roh.kiId !== kiId || typeof roh.eintrag !== 'string' || typeof roh.schluessel !== 'string') return null;
    const schluessel = Buffer.from(roh.schluessel, 'base64');
    if (schluessel.length !== KEY_BYTES) return null;
    return { kiId, eintrag: roh.eintrag, schluessel, pfad };
  }

  /**
   * Beim Erzeugen: ist dieser Rechner gemerkt, öffnet sich der Tresor ohne
   * PIN. Synchron und ohne scrypt (der Geräteschlüssel ist zufällig, nicht
   * erraten), damit src/app.js den Speicher direkt danach lesen kann. Jeder
   * Fehler hier heißt nur "nicht gemerkt" -- dann fragt eben die PIN.
   */
  function perGeraetEntsperren() {
    if (!geraetErlaubt || !secretsPresent || dataKey) return;
    const datei = geraetDateiLesen(kiIdAus(config));
    if (!datei) return;
    try {
      const secrets = readSecrets();
      const eintrag = secrets.geraete.find((g) => g.id === datei.eintrag);
      if (!eintrag) return;
      const key = open(datei.schluessel, eintrag.wrappedKey);
      if (key.length !== KEY_BYTES) {
        zero(key);
        return;
      }
      setzeSchluessel(key, 'geraet');
    } catch {
      /* passt nicht (mehr) -- dann eben die PIN */
    } finally {
      zero(datei.schluessel);
    }
  }

  perGeraetEntsperren();
  if (config && typeof config === 'object') INSTANZEN.set(config, api);
  return api;
}

/** Die Instanz, die zu dieser Konfiguration erzeugt wurde (für auth.js). */
function instanzFuer(config) {
  return config && typeof config === 'object' ? INSTANZEN.get(config) || null : null;
}

module.exports = {
  createVaultCrypto,
  instanzFuer,
  istPin,
  geraeteOrdner,
  kiIdAus,
  SECRETS_VERSION,
  SCRYPT,
  ALGORITHM,
  IV_BYTES,
  TAG_BYTES,
  MIN_PASSPHRASE,
  MIN_PIN,
  MAX_PIN,
  PIN_RE,
};
