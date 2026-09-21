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

const { IMPORT_MODES } = require('../../store/backup');

const MODES = new Set(IMPORT_MODES);
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
      // „parent" ist der Ordner, IN DEM eine neue Sicherung mit Zeitstempel
      // entsteht. Das ist, was ein Mensch meint, wenn er ein Ziel auswaehlt --
      // „dir" wuerde die dort liegende aeltere Sicherung ersetzen, und dann
      // haette man immer genau eine.
      parent: optionalString(body.parent, 'parent', { max: 4096 }) || undefined,
      format,
      includeFiles: body.includeFiles !== false,
      // Ohne Passphrase bleibt der Export Klartext und sagt das selbst. Die
      // Verschluesselung war in der Sicherung fertig, aber ueber HTTP nicht
      // erreichbar -- eine Funktion, die niemand aufrufen kann, ist keine.
      passphrase: optionalString(body.passphrase, 'passphrase', { max: 1024, trim: false }) || undefined,
    });
    audit(rc, 'backup.export', { dir: result.dir, records: result.records, format, sealed: result.sealed });
    return result;
  });

  /**
   * Was ein Import taete -- ohne etwas zu schreiben.
   *
   * POST und nicht GET, weil die Passphrase einer verschluesselten Sicherung
   * im Koerper stehen muss und nicht in einer URL, die in jedem Protokoll
   * landet. Geschrieben wird trotzdem nichts; darauf baut die Ansicht auf,
   * die das beim Oeffnen aufruft.
   */
  router.post('/api/backup/preview', async (rc) => {
    rc.requireOwner('Die Vorschau einer Wiederherstellung');
    const backup = needMethod(rc.ctx.backup, 'preview', 'Die Sicherung');
    const body = asObject(await rc.body());
    const dir = optionalString(body.dir, 'dir', { max: 4096 });
    const file = optionalString(body.file, 'file', { max: 4096 });
    if (!dir && !file) throw new ValidationError('Die Vorschau braucht "dir" oder "file".');
    const mode = optionalString(body.mode, 'mode', { max: 20 }) || 'merge';
    if (!MODES.has(mode)) throw new ValidationError(`Unbekannter Modus "${mode}". Erlaubt: ${[...MODES].join(', ')}.`);
    return backup.preview({
      dir: dir || undefined,
      file: file || undefined,
      mode,
      passphrase: optionalString(body.passphrase, 'passphrase', { max: 1024, trim: false }) || undefined,
    });
  });

  router.post('/api/backup/import', async (rc) => {
    rc.requireOwner('Der Import');
    const backup = needMethod(rc.ctx.backup, 'importAll', 'Die Sicherung');
    const body = asObject(await rc.body());
    const dir = optionalString(body.dir, 'dir', { max: 4096 });
    const file = optionalString(body.file, 'file', { max: 4096 });
    if (!dir && !file) throw new ValidationError('Der Import braucht "dir" oder "file".');
    const mode = optionalString(body.mode, 'mode', { max: 20 }) || 'merge';
    if (!MODES.has(mode)) throw new ValidationError(`Unbekannter Modus "${mode}". Erlaubt: ${[...MODES].join(', ')}.`);
    // A restore is a bulk write. Feeding every record to the embedding model
    // on the way in would cost one model call and one full index write per
    // record -- slower than the import itself, and pointless: one reindex
    // afterwards produces exactly the same index.
    //
    // `bulkWrite` legt waehrenddessen auch die Ableitung der Verknuepfungen
    // still und holt sie danach EINMAL nach; ohne das kamen zu 24 gesicherten
    // Kanten 19 abgeleitete Dubletten hinzu. Ob das Nachholen gelungen ist,
    // wandert ins Ergebnis -- eine Wiederherstellung, deren Graph nicht
    // nachgezogen wurde, darf nicht wie eine vollstaendige aussehen.
    const run = () => backup.importAll({
      dir: dir || undefined,
      file: file || undefined,
      mode,
      passphrase: optionalString(body.passphrase, 'passphrase', { max: 1024, trim: false }) || undefined,
    });
    let ableitung = null;
    const result = typeof rc.ctx.bulkWrite === 'function'
      ? await rc.ctx.bulkWrite(run, { onRederive: (bericht) => { ableitung = bericht; } })
      : await run();
    if (ableitung) {
      result.graph = ableitung;
      if (!ableitung.ok) {
        if (!Array.isArray(result.warnings)) result.warnings = [];
        result.warnings.push(ableitung.grund);
      }
    }
    audit(rc, 'backup.import', { dir, file, mode, imported: result.imported, purged: result.purged && result.purged.records });
    return result;
  });

  /**
   * Die vorhandenen Sicherungen, damit die Ansicht nicht raten muss, ob je
   * eine geschrieben wurde. Gelesen wird nur `manifest.json` -- die Sicherung
   * selbst wird dabei nicht geoeffnet und nicht geprueft; das tut
   * `/api/backup/verify` auf Wunsch fuer eine einzelne.
   */
  router.get('/api/backup/list', (rc) => {
    rc.requireOwner('Die Liste der Sicherungen');
    const paths = need(rc.ctx.paths, 'Die Verzeichnisstruktur');
    const orte = [];
    const merken = (dir, label) => {
      if (typeof dir !== 'string' || !dir) return;
      if (orte.some((o) => o.dir === dir)) return;
      orte.push({ dir, label });
    };
    merken(paths.exports, 'Im Programmverzeichnis');
    // Wer woanders hin sichert, soll seine Sicherungen auch wiederfinden. Der
    // Server kennt dieses Ziel nicht von sich aus -- die Ansicht reicht es
    // durch. Gelesen wird dabei nur, was dort liegt.
    const gewaehlt = rc.query.get('dir');
    if (gewaehlt) {
      if (gewaehlt.length > 4096) throw new ValidationError('Der Pfad ist zu lang.');
      merken(path.resolve(gewaehlt), 'Gewähltes Ziel');
    }
    // Auf einem Stick zeigt paths.home auf den Stick selbst. Dort liegen
    // Sicherungen, die einen Plattendefekt ueberleben -- sie gehoeren in
    // dieselbe Liste, sonst sieht der Mensch nur die, die mit untergehen.
    if (rc.ctx.portable && paths.home) merken(path.join(paths.home, 'exports'), 'Auf dem Stick');

    const items = [];
    const orteGeprueft = [];
    for (const ort of orte) {
      let namen = [];
      try {
        namen = fs.readdirSync(ort.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        orteGeprueft.push({ ...ort, lesbar: false });
        continue;
      }
      orteGeprueft.push({ ...ort, lesbar: true });
      for (const name of namen) {
        const dir = path.join(ort.dir, name);
        let manifest;
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        } catch {
          continue; // kein Manifest: kein Export, sondern irgendein Ordner
        }
        if (!manifest || manifest.kind !== 'neural-os-manifest') continue;
        let bytes = 0;
        for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
          if (Number.isFinite(f && f.bytes)) bytes += f.bytes;
        }
        const counts = manifest.counts || {};
        items.push({
          dir,
          name,
          ort: ort.label,
          at: manifest.at || null,
          format: manifest.format || null,
          sealed: manifest.sealed === true,
          includeFiles: manifest.includeFiles !== false,
          bytes,
          records: Number.isFinite(counts.records) ? counts.records : null,
          files: Number.isFinite(counts.files) ? counts.files : null,
          byType: counts.byType && typeof counts.byType === 'object' ? counts.byType : {},
        });
      }
    }
    items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return { items, total: items.length, orte: orteGeprueft, exportsDir: paths.exports, home: paths.home, portable: !!rc.ctx.portable };
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
