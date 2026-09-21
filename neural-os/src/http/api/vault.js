'use strict';

/**
 * Vault encryption, backups and access tokens -- everything that touches key
 * material or copies the user's data somewhere else. All owner-only.
 *
 * Notes on the decisions here:
 *
 * - **Unlocking is not enough by itself.** The store read its (encrypted)
 *   contents at boot; after a successful unlock the data has to be re-read.
 *   If the store can do that (`reload`), we do it and say so; if it cannot,
 *   the response says plainly that a restart is needed rather than pretending
 *   the vault is now readable.
 * - **Turning on encryption rewrites what is already there.** `initialise`
 *   only creates the key; without a following `compact()` the existing log and
 *   snapshot would stay in plaintext on disk while the UI claimed encryption
 *   was on. The rewrite is the difference between the claim and the fact.
 * - **A passphrase never appears in a URL, a log line or an error message.**
 *   It arrives in a JSON body and is used once.
 * - **The download is a real export**, produced by the backup subsystem and
 *   byte-identical to the file a folder export writes, so it can be imported
 *   again. Attached blobs are not part of a single JSON file; the response
 *   header says so instead of quietly dropping them.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ValidationError, NeuralError } = require('../../kernel/errors');
const {
  need,
  needMethod,
  asObject,
  requireString,
  optionalString,
} = require('./support');

const MODES = new Set(['merge', 'replace', 'fresh']);
const FORMATS = new Set(['json', 'markdown', 'both']);

function publish(rc, name, payload) {
  const bus = rc.ctx.bus;
  if (bus && typeof bus.publish === 'function') bus.publish(name, payload);
}

function audit(rc, kind, data) {
  const writer = rc.ctx.audit;
  if (writer && typeof writer.write === 'function') writer.write(kind, data);
}

function cryptoOf(rc) {
  return needMethod(
    rc.ctx.vaultCrypto,
    'unlock',
    'Die Vault-Verschlüsselung',
    'Ohne sie kann nichts entsperrt oder verschlüsselt werden.',
  );
}

function stateOf(rc) {
  const crypto = rc.ctx.vaultCrypto;
  if (!crypto) return { state: 'unavailable', enabled: false };
  const out = { state: crypto.state, enabled: !!crypto.enabled };
  if (typeof crypto.info === 'function') {
    try {
      Object.assign(out, crypto.info());
    } catch (err) {
      out.problem = err && err.message;
    }
  }
  return out;
}

/** Re-read the vault through the (now available) key, if the store can. */
async function reloadStore(rc) {
  const store = rc.ctx.store;
  if (!store || typeof store.reload !== 'function') {
    return {
      reloaded: false,
      hint: 'Der Speicher kann die Daten nicht im laufenden Betrieb neu einlesen. Starte Neural OS neu, damit der entsperrte Vault gelesen wird.',
    };
  }
  await store.reload();
  return { reloaded: true };
}

function register(router) {
  router.get('/api/vault', (rc) => {
    rc.requireCapability('read');
    return stateOf(rc);
  });

  router.post('/api/vault/unlock', async (rc) => {
    rc.requireOwner('Das Entsperren des Vaults');
    const crypto = cryptoOf(rc);
    const body = asObject(await rc.body());
    const passphrase = requireString(body.passphrase, 'passphrase', { max: 1024, trim: false });
    await crypto.unlock(passphrase);
    const reload = await reloadStore(rc);
    audit(rc, 'vault.unlock', { via: 'http', reloaded: reload.reloaded });
    publish(rc, 'vault.unlocked', { at: new Date().toISOString() });
    return { ...stateOf(rc), ...reload };
  });

  router.post('/api/vault/lock', (rc) => {
    rc.requireOwner('Das Sperren des Vaults');
    const crypto = needMethod(rc.ctx.vaultCrypto, 'lock', 'Die Vault-Verschlüsselung');
    crypto.lock();
    audit(rc, 'vault.lock', { via: 'http' });
    publish(rc, 'vault.locked', { at: new Date().toISOString() });
    return stateOf(rc);
  });

  router.post('/api/vault/encrypt', async (rc) => {
    rc.requireOwner('Das Einschalten der Verschlüsselung');
    const crypto = needMethod(rc.ctx.vaultCrypto, 'initialise', 'Die Vault-Verschlüsselung');
    const body = asObject(await rc.body());
    const passphrase = requireString(body.passphrase, 'passphrase', { min: 8, max: 1024, trim: false });
    if (crypto.enabled) {
      throw new ValidationError('Der Vault ist bereits verschlüsselt. Zum Wechseln der Passphrase gibt es einen eigenen Weg.');
    }

    await crypto.initialise(passphrase);

    // Existing segments and the snapshot are still plaintext on disk until
    // they are written again through the crypto seam.
    let rewritten = null;
    const store = rc.ctx.store;
    if (store && typeof store.compact === 'function') {
      try {
        rewritten = await store.compact();
      } catch (err) {
        throw new NeuralError(
          'ENCRYPTION_INCOMPLETE',
          `Der Schlüssel wurde angelegt, die vorhandenen Daten konnten aber nicht neu geschrieben werden: ${err && err.message}. `
          + 'Bis das gelingt, liegt ein Teil des Vaults weiterhin unverschlüsselt auf der Platte.',
          { status: 500 },
        );
      }
    }
    if (typeof rc.ctx.saveConfig === 'function') {
      try {
        rc.ctx.saveConfig({ security: { encryption: { enabled: true } } });
      } catch (err) {
        rc.log.warn(`Die Einstellung konnte nicht gespeichert werden: ${err && err.message}`);
      }
    }
    audit(rc, 'vault.encrypt', { via: 'http', rewritten });
    publish(rc, 'vault.encrypted', { at: new Date().toISOString() });
    return { ...stateOf(rc), rewritten };
  });

  router.post('/api/backup/export', async (rc) => {
    rc.requireOwner('Der Export');
    const backup = needMethod(rc.ctx.backup, 'exportAll', 'Die Sicherung');
    const body = asObject(await rc.body());
    const format = optionalString(body.format, 'format', { max: 20 }) || 'both';
    if (!FORMATS.has(format)) throw new ValidationError(`Unbekanntes Format "${format}". Erlaubt: json, markdown, both.`);
    const result = await backup.exportAll({
      dir: optionalString(body.dir, 'dir', { max: 4096 }) || undefined,
      format,
      includeFiles: body.includeFiles !== false,
    });
    audit(rc, 'backup.export', { dir: result.dir, records: result.records, format });
    return result;
  });

  router.post('/api/backup/import', async (rc) => {
    rc.requireOwner('Der Import');
    const backup = needMethod(rc.ctx.backup, 'importAll', 'Die Sicherung');
    const body = asObject(await rc.body());
    const dir = optionalString(body.dir, 'dir', { max: 4096 });
    const file = optionalString(body.file, 'file', { max: 4096 });
    if (!dir && !file) throw new ValidationError('Der Import braucht "dir" oder "file".');
    const mode = optionalString(body.mode, 'mode', { max: 20 }) || 'merge';
    if (!MODES.has(mode)) throw new ValidationError(`Unbekannter Modus "${mode}". Erlaubt: merge, replace, fresh.`);
    // A restore is a bulk write. Feeding every record to the embedding model
    // on the way in would cost one model call and one full index write per
    // record -- slower than the import itself, and pointless: one reindex
    // afterwards produces exactly the same index.
    const run = () => backup.importAll({ dir: dir || undefined, file: file || undefined, mode });
    const result = typeof rc.ctx.bulkWrite === 'function'
      ? await rc.ctx.bulkWrite(run)
      : await run();
    audit(rc, 'backup.import', { dir, file, mode, imported: result.imported });
    return result;
  });

  /**
   * One file, straight down the wire. Produced by the same code path as a
   * folder export so it can be handed back to `POST /api/backup/import`.
   */
  router.get('/api/backup/download', async (rc) => {
    rc.requireOwner('Der Export');
    const backup = needMethod(rc.ctx.backup, 'exportAll', 'Die Sicherung');
    const paths = need(rc.ctx.paths, 'Die Verzeichnisstruktur');
    const exportsDir = need(paths.exports, 'Das Export-Verzeichnis');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(exportsDir, `download-${stamp}`);
    const cleanup = () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    };

    try {
      const result = await backup.exportAll({ dir, format: 'json', includeFiles: false });
      const file = path.join(dir, 'export.json');
      const stat = fs.statSync(file);
      const { res } = rc;
      rc.handled = true;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="neural-os-${stamp}.json"`,
        'Cache-Control': 'no-store',
        // Honest about what a single file cannot carry.
        'X-Neural-OS-Blobs': 'excluded',
        'X-Neural-OS-Records': String(result.records),
      });
      audit(rc, 'backup.download', { records: result.records, bytes: stat.size });

      await new Promise((resolve) => {
        const source = fs.createReadStream(file);
        const finish = () => resolve();
        source.on('error', (err) => {
          rc.log.error(`Export konnte nicht gesendet werden: ${err && err.message}`);
          res.destroy();
          finish();
        });
        res.on('close', finish);
        source.on('end', finish);
        source.pipe(res);
      });
      return undefined;
    } finally {
      cleanup();
    }
  });

  router.get('/api/tokens', (rc) => {
    rc.requireOwner('Zugangstoken');
    const auth = needMethod(rc.ctx.auth, 'listTokens', 'Die Zugangsverwaltung');
    const items = auth.listTokens();
    return { items, total: items.length };
  });

  router.post('/api/tokens', async (rc) => {
    rc.requireOwner('Zugangstoken');
    const auth = needMethod(rc.ctx.auth, 'createToken', 'Die Zugangsverwaltung');
    const body = asObject(await rc.body());
    const label = requireString(body.label, 'label', { max: 200 });
    const expiresAt = body.expiresAt === undefined || body.expiresAt === null
      ? null
      : requireString(body.expiresAt, 'expiresAt', { max: 40 });
    if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) {
      throw new ValidationError('"expiresAt" muss ein ISO-Zeitstempel sein.');
    }
    const created = await auth.createToken({
      label,
      permissions: body.permissions && typeof body.permissions === 'object' ? body.permissions : undefined,
      expiresAt,
    });
    audit(rc, 'token.created', { label });
    // The raw token is returned exactly once; it is not stored anywhere.
    return created;
  });

  router.delete('/api/tokens/:id', (rc) => {
    rc.requireOwner('Zugangstoken');
    const auth = needMethod(rc.ctx.auth, 'revokeToken', 'Die Zugangsverwaltung');
    const record = auth.revokeToken(rc.params.id);
    audit(rc, 'token.revoked', { id: rc.params.id });
    return { record };
  });

  /** Verify a previously written export folder without importing it. */
  router.get('/api/backup/verify', async (rc) => {
    rc.requireOwner('Die Prüfung einer Sicherung');
    const backup = needMethod(rc.ctx.backup, 'verify', 'Die Sicherung');
    const dir = rc.query.get('dir');
    if (!dir) throw new ValidationError('Die Prüfung braucht das Verzeichnis ("dir").');
    if (dir.length > 4096) throw new ValidationError('Der Pfad ist zu lang.');
    return backup.verify(dir);
  });

  /** Vault maintenance: fold the log into a fresh snapshot. */
  router.post('/api/vault/compact', async (rc) => {
    rc.requireOwner('Das Verdichten des Vaults');
    const store = needMethod(rc.ctx.store, 'compact', 'Der Speicher');
    const result = await store.compact();
    audit(rc, 'vault.compact', result);
    return result;
  });
}

module.exports = { register };
