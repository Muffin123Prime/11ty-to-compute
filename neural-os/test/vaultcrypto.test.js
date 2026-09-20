'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');
const pathsMod = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { createVaultCrypto, SCRYPT, MIN_PASSPHRASE } = require('../src/store/vaultcrypto');

/**
 * These tests run the REAL KDF parameters (N=2^17, ~0.9 s per derivation).
 * Weakening them for speed would test a different construction than the one
 * that ships, so the suite is deliberately slow instead of deliberately wrong.
 */

const PASS = 'korrektes-pferd-batterie';
const PASS2 = 'neue-passphrase-2026';

function freshVault(label) {
  const { home, cleanup } = tempHome(label);
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  return { home, paths, config, cleanup, make: () => createVaultCrypto({ paths, config: configMod.defaults() }) };
}

test('disabled vault passes data through untouched', () => {
  const { paths, config, cleanup } = freshVault('vc-off');
  try {
    const vc = createVaultCrypto({ paths, config });
    assert.equal(vc.enabled, false);
    assert.equal(vc.state, 'disabled');
    assert.equal(vc.hasSecrets(), false);
    // The seam stays identical so the store has only one read/write path.
    assert.equal(vc.encryptLine('{"a":1}'), '{"a":1}');
    assert.equal(vc.decryptLine('{"a":1}'), '{"a":1}');
    const buf = Buffer.from('hallo');
    assert.equal(vc.encryptBuffer(buf), buf);
    assert.equal(vc.decryptBuffer(buf), buf);
    vc.lock();
    assert.equal(vc.state, 'disabled');
  } finally {
    cleanup();
  }
});

test('initialise writes contracted secrets.json and encrypts round-trippably', async () => {
  const { paths, config, cleanup } = freshVault('vc-init');
  try {
    const vc = createVaultCrypto({ paths, config });
    await vc.initialise(PASS);

    assert.equal(vc.state, 'unlocked');
    assert.equal(vc.enabled, true);
    assert.equal(config.security.encryption.enabled, true, 'in-memory config must reflect reality');

    const secrets = JSON.parse(fs.readFileSync(paths.secrets, 'utf8'));
    assert.equal(secrets.v, 1);
    assert.equal(secrets.kdf, 'scrypt');
    assert.equal(secrets.N, SCRYPT.N);
    assert.equal(secrets.N, 2 ** 17);
    assert.equal(secrets.r, 8);
    assert.equal(secrets.p, 1);
    assert.ok(secrets.salt && secrets.keyCheck && secrets.wrappedKey);
    for (const part of ['iv', 'tag', 'ct']) {
      assert.equal(typeof secrets.keyCheck[part], 'string');
      assert.equal(typeof secrets.wrappedKey[part], 'string');
    }
    // The raw data key must never be recoverable from the file itself.
    assert.ok(!JSON.stringify(secrets).includes(PASS));

    const mode = fs.statSync(paths.secrets).mode & 0o777;
    assert.equal(mode, 0o600, `secrets.json must be 0600, got ${mode.toString(8)}`);

    const line = JSON.stringify({ v: 1, seq: 1, op: 'create', data: { title: 'Geheime Notiz' } });
    const a = vc.encryptLine(line);
    const b = vc.encryptLine(line);
    assert.notEqual(a, b, 'a fresh IV per record means identical input never yields identical output');
    assert.ok(!a.includes('Geheime'), 'plaintext must not survive in the ciphertext');
    assert.ok(!a.includes('\n'), 'an encrypted line must still fit one JSONL line');
    assert.equal(vc.decryptLine(a), line);
    assert.equal(vc.decryptLine(b), line);

    // IV uniqueness across many records, since reuse would be catastrophic.
    const ivs = new Set();
    for (let i = 0; i < 500; i++) {
      ivs.add(Buffer.from(vc.encryptLine(`record ${i}`), 'base64').subarray(0, 12).toString('hex'));
    }
    assert.equal(ivs.size, 500);

    const blob = crypto.randomBytes(4096);
    const sealed = vc.encryptBuffer(blob);
    assert.ok(!sealed.equals(blob));
    assert.equal(sealed.length, blob.length + 12 + 16);
    assert.ok(vc.decryptBuffer(sealed).equals(blob));

    // Tampering must be detected, not silently decrypted to garbage.
    const tampered = Buffer.from(a, 'base64');
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => vc.decryptLine(tampered.toString('base64')), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      return true;
    });
    assert.throws(() => vc.decryptLine('das ist kein ciphertext'), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      return true;
    });
  } finally {
    cleanup();
  }
});

test('wrong passphrase throws LockedError instead of decrypting garbage', async () => {
  const { paths, config, cleanup } = freshVault('vc-pass');
  try {
    const first = createVaultCrypto({ paths, config });
    await first.initialise(PASS);
    const sealed = first.encryptLine('vertraulich');

    // A cold start: new instance, default config that does not know about
    // encryption. Key material on disk alone must be enough to stay locked.
    const cold = createVaultCrypto({ paths, config: configMod.defaults() });
    assert.equal(cold.enabled, true, 'existing secrets.json implies encryption even if config.json was reset');
    assert.equal(cold.state, 'locked');
    assert.throws(() => cold.decryptLine(sealed), (err) => {
      assert.equal(err.code, 'VAULT_LOCKED');
      return true;
    });

    await assert.rejects(() => cold.unlock('falsche-passphrase'), (err) => {
      assert.equal(err.name, 'LockedError');
      assert.equal(err.code, 'VAULT_LOCKED');
      assert.equal(err.status, 423);
      assert.match(err.message, /Falsche Passphrase/);
      return true;
    });
    assert.equal(cold.state, 'locked', 'a failed attempt must not leave a key behind');

    assert.equal(await cold.unlock(PASS), true);
    assert.equal(cold.state, 'unlocked');
    assert.equal(cold.decryptLine(sealed), 'vertraulich');
  } finally {
    cleanup();
  }
});

test('lock() overwrites the key material in memory', async () => {
  const { paths, config, cleanup } = freshVault('vc-lock');
  const realRandomBytes = crypto.randomBytes;
  /** @type {Buffer[]} */
  const keySized = [];
  try {
    // White-box: capture the 32-byte buffer that becomes the data key so we can
    // prove lock() really zeroes it rather than just dropping the reference.
    crypto.randomBytes = function patched(size, cb) {
      const out = realRandomBytes.call(crypto, size, cb);
      if (size === 32 && Buffer.isBuffer(out)) keySized.push(out);
      return out;
    };
    const vc = createVaultCrypto({ paths, config });
    await vc.initialise(PASS);
    crypto.randomBytes = realRandomBytes;

    assert.equal(keySized.length, 1, 'expected exactly one 32-byte data key');
    const dataKey = keySized[0];
    assert.ok(dataKey.some((b) => b !== 0), 'the live key must not already be zeroed');

    vc.lock();
    assert.equal(vc.state, 'locked');
    assert.ok(dataKey.every((b) => b === 0), 'lock() must fill the key buffer with zeroes');
    assert.throws(() => vc.encryptLine('x'), (err) => {
      assert.equal(err.code, 'VAULT_LOCKED');
      return true;
    });
    vc.lock(); // idempotent
    assert.equal(vc.state, 'locked');

    // Re-initialising over existing key material would strand the vault.
    await assert.rejects(() => vc.initialise('noch-eine-passphrase'), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      assert.match(err.message, /bereits Schluesselmaterial/);
      return true;
    });
  } finally {
    crypto.randomBytes = realRandomBytes;
    cleanup();
  }
});

test('changePassphrase rewraps the same data key, so old ciphertext still opens', async () => {
  const { paths, config, cleanup } = freshVault('vc-rotate');
  try {
    const vc = createVaultCrypto({ paths, config });
    await vc.initialise(PASS);
    const sealedUnderOld = vc.encryptLine('Daten von vorher');
    const saltBefore = JSON.parse(fs.readFileSync(paths.secrets, 'utf8')).salt;

    await vc.changePassphrase(PASS, PASS2);
    const after = JSON.parse(fs.readFileSync(paths.secrets, 'utf8'));
    assert.notEqual(after.salt, saltBefore, 'rotation must use a fresh salt');
    assert.ok(after.updatedAt >= after.createdAt);
    assert.equal(fs.statSync(paths.secrets).mode & 0o777, 0o600);

    // The whole point: no record was rewritten, yet it still decrypts.
    assert.equal(vc.decryptLine(sealedUnderOld), 'Daten von vorher');

    const cold = createVaultCrypto({ paths, config: configMod.defaults() });
    await assert.rejects(() => cold.unlock(PASS), (err) => {
      assert.equal(err.name, 'LockedError');
      return true;
    });
    assert.equal(await cold.unlock(PASS2), true);
    assert.equal(cold.decryptLine(sealedUnderOld), 'Daten von vorher');
  } finally {
    cleanup();
  }
});

test('damaged key material reports corruption, not a wrong passphrase', async () => {
  const { paths, config, cleanup } = freshVault('vc-corrupt');
  try {
    const vc = createVaultCrypto({ paths, config });
    await vc.initialise(PASS);
    const good = JSON.parse(fs.readFileSync(paths.secrets, 'utf8'));

    // 1. Unparseable file.
    fs.writeFileSync(paths.secrets, '{ kaputt');
    await assert.rejects(() => createVaultCrypto({ paths, config: configMod.defaults() }).unlock(PASS), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      assert.match(err.message, /beschaedigt/);
      return true;
    });

    // 2. Absurd KDF parameters must be rejected before scrypt allocates.
    fs.writeFileSync(paths.secrets, JSON.stringify({ ...good, N: 2 ** 30 }));
    await assert.rejects(() => createVaultCrypto({ paths, config: configMod.defaults() }).unlock(PASS), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      assert.match(err.message, /N ausserhalb/);
      return true;
    });

    // 3. keyCheck opens (passphrase right) but the wrapped key is damaged:
    //    this is the case the keyCheck field exists to separate out.
    const broken = { ...good, wrappedKey: { ...good.wrappedKey } };
    const ct = Buffer.from(broken.wrappedKey.ct, 'base64');
    ct[0] ^= 0xff;
    broken.wrappedKey.ct = ct.toString('base64');
    fs.writeFileSync(paths.secrets, JSON.stringify(broken));
    await assert.rejects(() => createVaultCrypto({ paths, config: configMod.defaults() }).unlock(PASS), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR', 'right passphrase + broken key must NOT read as a typo');
      assert.match(err.message, /Passphrase ist korrekt/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test('passphrase input is validated before any key work happens', async () => {
  const { paths, config, cleanup } = freshVault('vc-input');
  try {
    const vc = createVaultCrypto({ paths, config });
    for (const bad of ['', 'kurz', null, 12345]) {
      await assert.rejects(() => vc.initialise(bad), (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        return true;
      });
    }
    assert.equal(fs.existsSync(paths.secrets), false, 'a rejected passphrase must not leave key material');
    assert.ok(MIN_PASSPHRASE >= 8);

    // Unlocking something that was never encrypted is a caller bug, not a lock.
    await assert.rejects(() => vc.unlock(PASS), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    });
    await assert.rejects(() => vc.changePassphrase(PASS, PASS2), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    });
    assert.throws(() => createVaultCrypto({}), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    });
  } finally {
    cleanup();
  }
});

test('concurrent unlock attempts never share a result across passphrases', async () => {
  const { paths, config, cleanup } = freshVault('vc-race');
  try {
    const seed = createVaultCrypto({ paths, config });
    await seed.initialise(PASS);
    const sealed = seed.encryptLine('parallel');

    const cold = createVaultCrypto({ paths, config: configMod.defaults() });
    const results = await Promise.allSettled([
      cold.unlock('voellig-falsche-eingabe'),
      cold.unlock(PASS),
      cold.unlock(PASS), // duplicate of the correct one: must collapse, not re-derive
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].reason.name, 'LockedError');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(results[2].status, 'fulfilled');
    assert.equal(cold.state, 'unlocked');
    assert.equal(cold.decryptLine(sealed), 'parallel');
  } finally {
    cleanup();
  }
});

test('info() exposes parameters but never key material', async () => {
  const { paths, config, cleanup } = freshVault('vc-info');
  try {
    const vc = createVaultCrypto({ paths, config });
    assert.equal(vc.info().state, 'disabled');
    await vc.initialise(PASS);
    const info = vc.info();
    assert.equal(info.state, 'unlocked');
    assert.equal(info.kdf, 'scrypt');
    assert.equal(info.N, SCRYPT.N);
    const serialised = JSON.stringify(info);
    assert.ok(!serialised.includes(PASS));
    assert.ok(!/wrappedKey|keyCheck|salt/.test(serialised), 'info() must not leak the wrapper fields');
  } finally {
    cleanup();
  }
});

module.exports = { name: 'vaultcrypto', tests: drain() };
