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
 *
 * PIN (Entscheidung des Nutzers, Abstimmung mit dem Stick-Bauplan, Paket V)
 * -----------------------------------------------------------------------
 * - `POST /api/vault/pin {pin, merken}` richtet die PIN ein: 4 bis 6 Ziffern,
 *   Verschlüsselung über dieselbe `initialise` wie bisher, danach wird alles
 *   Vorhandene neu geschrieben -- auch der Claude-Schlüssel, der in einer
 *   eigenen Datei liegt.
 * - `POST /api/vault/unlock {passphrase, merken}` bleibt der eine Weg zum
 *   Entsperren (Feldname und Pflichtkopf wie im Bauplan). Nach 5 falschen
 *   Versuchen gibt es 30 s Pause: 429 "Zu oft falsch. Kurz warten.";
 *   falsch ist 401 "Falsche PIN.". Richtig setzt das Sitzungs-Cookie dieses
 *   Browsers (src/http/auth.js). Ist schon offen (anderer Browser, gemerktes
 *   Gerät), wird die PIN trotzdem geprüft -- "ist doch offen" ist kein Beweis.
 * - Die Sperre zählt pro laufender KI, nicht pro Browser: wer rät, kann den
 *   Browser wechseln.
 * - "Dieses Gerät merken" legt den Schlüssel im Benutzerprofil ab (siehe
 *   src/store/vaultcrypto.js), je KI-Kennung (`config.sync.deviceId`).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ValidationError, NeuralError } = require('../../kernel/errors');
const vaultcryptoMod = require('../../store/vaultcrypto');
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

/**
 * Re-read the vault through the (now available) key, if the store can.
 *
 * Ohne `reload` ist das kein Problem mehr, das man melden müsste: ein
 * verschlüsselter Tresor lässt sich heute nur ENTSPERRT öffnen (createApp
 * scheitert sonst), die Sätze liegen also schon im Speicher. Gesperrt wird
 * danach nur das Schreiben; Entsperren gibt es zurück.
 */
async function reloadStore(rc) {
  const store = rc.ctx.store;
  if (!store || typeof store.reload !== 'function') return { reloaded: false };
  await store.reload();
  return { reloaded: true };
}

/* ------------------------------------------------------------------ PIN */

const PIN_FEHL_MAX = 5;
const PIN_PAUSE_MS = 30 * 1000;
/** Pro laufender KI (ctx), nicht pro Browser. */
const SPERREN = new WeakMap();

function sperreVon(ctx) {
  let s = SPERREN.get(ctx);
  if (!s) {
    s = { fehl: 0, bis: 0 };
    SPERREN.set(ctx, s);
  }
  return s;
}

function pauseNoetig(rc) {
  const s = sperreVon(rc.ctx);
  const rest = s.bis - Date.now();
  if (rest > 0) {
    throw new NeuralError('ZU_OFT_FALSCH', 'Zu oft falsch. Kurz warten.', {
      status: 429,
      details: { wartenS: Math.ceil(rest / 1000) },
    });
  }
}

/**
 * Eine PIN prüfen oder damit entsperren -- mit Zählung. Wirft 401/429 wie im
 * Bauplan; jede andere Ausnahme (beschädigte Datei) geht unverändert weiter.
 */
async function mitZaehlung(rc, fn) {
  pauseNoetig(rc);
  const s = sperreVon(rc.ctx);
  try {
    const r = await fn();
    s.fehl = 0;
    return r;
  } catch (err) {
    if (err && err.code === 'VAULT_LOCKED') {
      s.fehl += 1;
      audit(rc, 'vault.pin.falsch', { fehl: s.fehl });
      if (s.fehl >= PIN_FEHL_MAX) {
        s.fehl = 0;
        s.bis = Date.now() + PIN_PAUSE_MS;
        throw new NeuralError('ZU_OFT_FALSCH', 'Zu oft falsch. Kurz warten.', {
          status: 429,
          details: { wartenS: Math.ceil(PIN_PAUSE_MS / 1000) },
        });
      }
      const art = rc.ctx.vaultCrypto && typeof rc.ctx.vaultCrypto.art === 'function' ? rc.ctx.vaultCrypto.art() : 'pin';
      throw new NeuralError('FALSCHE_PIN', art === 'passphrase' ? 'Falsche Passphrase.' : 'Falsche PIN.', {
        status: 401,
        details: { uebrig: PIN_FEHL_MAX - s.fehl },
      });
    }
    throw err;
  }
}

function pinLesen(value, feld = 'pin') {
  if (typeof value !== 'string' || !vaultcryptoMod.istPin(value)) {
    throw new ValidationError(`Die PIN besteht aus ${vaultcryptoMod.MIN_PIN} bis ${vaultcryptoMod.MAX_PIN} Ziffern.`, { feld });
  }
  return value;
}

/**
 * Die Kennung dieser KI. Fehlt sie noch, wird sie hier angelegt -- im selben
 * Format wie src/kernel/identitaet.js, das eine gültige Kennung übernimmt.
 */
function kiIdSicherstellen(rc) {
  const config = rc.ctx.config || {};
  const vorhanden = vaultcryptoMod.kiIdAus(config);
  if (vorhanden) return vorhanden;
  const { neueKiId } = require('../../kernel/identitaet');
  const id = neueKiId();
  if (typeof rc.ctx.saveConfig === 'function') {
    rc.ctx.saveConfig({ sync: { deviceId: id } });
  } else {
    config.sync = { ...(config.sync || {}), deviceId: id };
  }
  return id;
}

function geraetMerken(rc) {
  const crypto = rc.ctx.vaultCrypto;
  const kiId = kiIdSicherstellen(rc);
  let name = 'Dieser Rechner';
  try { name = os.hostname() || name; } catch { /* bleibt */ }
  const r = crypto.merken({ kiId, name });
  audit(rc, 'vault.geraet.gemerkt', { eintrag: r.id });
  publish(rc, 'vault.geraet', { gemerkt: true });
  return r;
}

/** Set-Cookie für diesen Browser, wenn eine PIN-Sitzung nötig ist. */
function sitzungSetzen(rc) {
  const auth = rc.ctx.auth;
  if (!auth || typeof auth.sitzungAusstellen !== 'function') return false;
  const cookie = auth.sitzungAusstellen();
  if (!cookie) return false;
  rc.res.setHeader('Set-Cookie', cookie);
  return true;
}

/**
 * Der Claude-Schlüssel liegt in einer eigenen Datei neben dem Speicher. Wird
 * die PIN eingerichtet, muss auch er versiegelt werden -- sonst läge der
 * teuerste Zugang als einziger im Klartext neben einem verschlüsselten Tresor.
 * (src/models/claude.js versiegelt ihn sonst erst beim nächsten Lesen nach
 * einem Neustart.) Format wie dort: {v:1, versiegelt, inhalt:base64}.
 */
function claudeNachversiegeln(rc) {
  const vault = rc.ctx.paths && rc.ctx.paths.vault;
  const crypto = rc.ctx.vaultCrypto;
  if (!vault || !crypto || typeof crypto.encryptBuffer !== 'function') return false;
  const datei = path.join(vault, 'claude-schluessel.json');
  let huelle;
  try {
    huelle = JSON.parse(fs.readFileSync(datei, 'utf8'));
  } catch {
    return false;
  }
  if (!huelle || huelle.versiegelt || typeof huelle.inhalt !== 'string') return false;
  const klar = Buffer.from(huelle.inhalt, 'base64');
  const neu = { v: 1, versiegelt: true, inhalt: crypto.encryptBuffer(klar).toString('base64') };
  const tmp = `${datei}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(neu), { mode: 0o600 });
  fs.renameSync(tmp, datei);
  klar.fill(0);
  return true;
}

/**
 * Der Änderungsverlauf (history.jsonl) schreibt neue Zeilen versiegelt, alte
 * bleiben, wie sie sind -- also im Klartext, samt der früheren Fassung jeder
 * geänderten Notiz (gemessen: test/ipad-pin.test.js fand die Notiz dort).
 * Hier werden die Klartext-Zeilen ersetzt. Alles synchron in einem Zug:
 * src/store/history.js hängt Zeilen ebenfalls synchron an und hält keinen
 * Dateideskriptor offen, dazwischen kann also nichts verloren gehen.
 * Eine Zeile, die mit "{" beginnt, ist Klartext (dieselbe Regel wie dort).
 */
function verlaufVersiegeln(rc) {
  const crypto = rc.ctx.vaultCrypto;
  const history = rc.ctx.history;
  const datei = (history && typeof history.file === 'string' && history.file)
    || (rc.ctx.paths && rc.ctx.paths.vault ? path.join(rc.ctx.paths.vault, 'history.jsonl') : null);
  if (!datei || !crypto || typeof crypto.encryptLine !== 'function') return 0;
  let roh;
  try {
    roh = fs.readFileSync(datei, 'utf8');
  } catch {
    return 0;
  }
  let ersetzt = 0;
  const zeilen = roh.split('\n').map((zeile) => {
    const t = zeile.trim();
    if (!t || t.charCodeAt(0) !== 0x7b) return zeile;
    ersetzt += 1;
    return crypto.encryptLine(t);
  });
  if (!ersetzt) return 0;
  const tmp = `${datei}.tmp-pin-${process.pid}`;
  fs.writeFileSync(tmp, zeilen.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, datei);
  return ersetzt;
}

/**
 * Angehängte Dateien liegen unter ihrem SHA-256 des KLARTEXTS
 * (src/store/engine.js). Vor der PIN geschriebene bleiben sonst im Klartext
 * liegen -- und wären danach sogar unlesbar, weil `files.read` sie
 * entschlüsseln will. Der Name verrät, welche es sind: stimmt der Hash des
 * Inhalts mit dem Namen überein, ist es Klartext (versiegelte Dateien haben
 * eine zufällige IV und damit nie diesen Hash).
 */
function dateienVersiegeln(rc) {
  const crypto = rc.ctx.vaultCrypto;
  const ordner = rc.ctx.paths && rc.ctx.paths.files;
  if (!ordner || !crypto || typeof crypto.encryptBuffer !== 'function') return 0;
  const nodeCrypto = require('node:crypto');
  let anzahl = 0;
  let faecher = [];
  try { faecher = fs.readdirSync(ordner, { withFileTypes: true }); } catch { return 0; }
  for (const fach of faecher) {
    if (!fach.isDirectory() || !/^[0-9a-f]{2}$/.test(fach.name)) continue;
    const dir = path.join(ordner, fach.name);
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const pfad = path.join(dir, name);
      const inhalt = fs.readFileSync(pfad);
      if (nodeCrypto.createHash('sha256').update(inhalt).digest('hex') !== name) continue;
      const tmp = path.join(dir, `.tmp-pin-${process.pid}-${name.slice(0, 8)}`);
      fs.writeFileSync(tmp, crypto.encryptBuffer(inhalt), { mode: 0o600 });
      fs.renameSync(tmp, pfad);
      anzahl += 1;
    }
  }
  return anzahl;
}

/** Alles, was neben dem Satz-Speicher liegt, nachversiegeln. Meldet, was es tat. */
function nebendateienVersiegeln(rc) {
  const out = { claude: false, verlauf: 0, dateien: 0, probleme: [] };
  for (const [feld, fn] of [['claude', claudeNachversiegeln], ['verlauf', verlaufVersiegeln], ['dateien', dateienVersiegeln]]) {
    try {
      out[feld] = fn(rc);
    } catch (err) {
      out.probleme.push(`${feld}: ${err && err.message}`);
      rc.log.warn(`Nachversiegeln (${feld}) gescheitert: ${err && err.message}`);
    }
  }
  return out;
}

/** Was die Einstellungen über den Schutz wissen müssen. Nie Schlüsselmaterial. */
function schutzVon(rc) {
  const crypto = rc.ctx.vaultCrypto;
  const auth = rc.ctx.auth;
  if (!crypto) return { verfuegbar: false };
  const eingerichtet = !!crypto.enabled;
  const sperre = sperreVon(rc.ctx);
  const besitzer = !!(rc.identity && rc.identity.kind === 'owner');
  let geraete = [];
  if (eingerichtet && typeof crypto.geraete === 'function') {
    try { geraete = crypto.geraete(); } catch { geraete = []; }
  }
  return {
    verfuegbar: true,
    eingerichtet,
    art: eingerichtet && typeof crypto.art === 'function' ? crypto.art() : null,
    zustand: crypto.state,
    entsperrtDurch: crypto.entsperrtDurch || null,
    diesesGeraetGemerkt: eingerichtet && typeof crypto.geraetGemerkt === 'function' ? crypto.geraetGemerkt() : false,
    geraete,
    // Ein Pfad auf diesem Rechner geht nur den Menschen an der Tastatur etwas an.
    geraeteOrdner: besitzer && typeof crypto.geraeteOrdner === 'function' ? crypto.geraeteOrdner() : null,
    sitzung: auth && typeof auth.sitzungsZustand === 'function' ? auth.sitzungsZustand(rc.req) : { noetig: false, vorhanden: false },
    pauseS: Math.max(0, Math.ceil((sperre.bis - Date.now()) / 1000)),
  };
}

function register(router) {
  router.get('/api/vault', (rc) => {
    rc.requireCapability('read');
    return { ...stateOf(rc), schutz: schutzVon(rc) };
  });

  /**
   * Entsperren -- oder, wenn schon offen, diesen Browser an die PIN binden.
   * Body: { passphrase, merken? }. Antwort 200 | 401 "Falsche PIN." | 429.
   */
  router.post('/api/vault/unlock', async (rc) => {
    rc.requireOwner('Das Entsperren des Vaults');
    const crypto = cryptoOf(rc);
    const body = asObject(await rc.body());
    const passphrase = requireString(body.passphrase, 'passphrase', { max: 1024, trim: false });
    if (!crypto.enabled) {
      throw new ValidationError('Es ist keine PIN eingerichtet; es gibt nichts zu entsperren.');
    }
    const warGesperrt = crypto.state !== 'unlocked';
    await mitZaehlung(rc, () => (warGesperrt ? crypto.unlock(passphrase) : crypto.pruefen(passphrase)));
    const reload = warGesperrt ? await reloadStore(rc) : { reloaded: false };
    let gemerkt = null;
    if (body.merken === true) gemerkt = geraetMerken(rc);
    const sitzung = sitzungSetzen(rc);
    audit(rc, 'vault.unlock', { via: 'http', reloaded: reload.reloaded, warGesperrt, sitzung, gemerkt: !!gemerkt });
    if (warGesperrt) publish(rc, 'vault.unlocked', { at: new Date().toISOString() });
    return { ...stateOf(rc), ...reload, sitzung, gemerkt: !!gemerkt, schutz: schutzVon(rc) };
  });

  /** PIN einrichten: { pin, merken? }. Verschlüsselt alles Vorhandene. */
  router.post('/api/vault/pin', async (rc) => {
    rc.requireOwner('Das Einrichten der PIN');
    const crypto = needMethod(rc.ctx.vaultCrypto, 'initialise', 'Die Vault-Verschlüsselung');
    const body = asObject(await rc.body());
    const pin = pinLesen(body.pin);
    if (crypto.enabled) {
      throw new ValidationError('Es gibt schon eine PIN. Sie lässt sich unter „PIN ändern“ ersetzen.');
    }
    await crypto.initialise(pin);
    let rewritten = null;
    const store = rc.ctx.store;
    if (store && typeof store.compact === 'function') {
      try {
        rewritten = await store.compact();
      } catch (err) {
        throw new NeuralError(
          'ENCRYPTION_INCOMPLETE',
          `Die PIN ist eingerichtet, die vorhandenen Daten konnten aber nicht neu geschrieben werden: ${err && err.message}. `
          + 'Bis das gelingt, liegt ein Teil davon weiterhin unverschlüsselt auf dem Stick.',
          { status: 500 },
        );
      }
    }
    const neben = nebendateienVersiegeln(rc);
    if (neben.probleme.length) {
      throw new NeuralError(
        'ENCRYPTION_INCOMPLETE',
        `Die PIN ist eingerichtet, aber nicht alles ließ sich versiegeln: ${neben.probleme.join('; ')}.`,
        { status: 500, details: neben },
      );
    }
    if (typeof rc.ctx.saveConfig === 'function') {
      try {
        rc.ctx.saveConfig({ security: { encryption: { enabled: true } } });
      } catch (err) {
        rc.log.warn(`Die Einstellung konnte nicht gespeichert werden: ${err && err.message}`);
      }
    }
    let gemerkt = null;
    if (body.merken === true) gemerkt = geraetMerken(rc);
    const sitzung = sitzungSetzen(rc);
    audit(rc, 'vault.pin.eingerichtet', { rewritten, neben, gemerkt: !!gemerkt });
    publish(rc, 'vault.encrypted', { at: new Date().toISOString() });
    return {
      ...stateOf(rc), rewritten, claudeVersiegelt: neben.claude, verlaufVersiegelt: neben.verlauf,
      dateienVersiegelt: neben.dateien, sitzung, gemerkt: !!gemerkt, schutz: schutzVon(rc),
    };
  });

  /** PIN ändern: { alt, neu }. Der falsche alte Wert zählt als Fehlversuch. */
  router.post('/api/vault/pin/aendern', async (rc) => {
    rc.requireOwner('Das Ändern der PIN');
    const crypto = needMethod(rc.ctx.vaultCrypto, 'changePassphrase', 'Die Vault-Verschlüsselung');
    const body = asObject(await rc.body());
    const alt = requireString(body.alt, 'alt', { max: 1024, trim: false });
    const neu = pinLesen(body.neu, 'neu');
    await mitZaehlung(rc, () => crypto.changePassphrase(alt, neu));
    const sitzung = sitzungSetzen(rc);
    audit(rc, 'vault.pin.geaendert', {});
    publish(rc, 'vault.pin', { geaendert: true });
    return { ...stateOf(rc), sitzung, schutz: schutzVon(rc) };
  });

  /** Diesen Rechner merken: { pin }. Die PIN wird geprüft, auch wenn offen ist. */
  router.post('/api/vault/geraet', async (rc) => {
    rc.requireOwner('Das Merken dieses Geräts');
    const crypto = needMethod(rc.ctx.vaultCrypto, 'merken', 'Die Vault-Verschlüsselung');
    const body = asObject(await rc.body());
    const pin = requireString(body.pin, 'pin', { max: 1024, trim: false });
    if (!crypto.enabled) throw new ValidationError('Ohne PIN gibt es nichts zu merken.');
    await mitZaehlung(rc, () => (crypto.state === 'unlocked' ? crypto.pruefen(pin) : crypto.unlock(pin)));
    geraetMerken(rc);
    return { ...stateOf(rc), schutz: schutzVon(rc) };
  });

  /** Diesen Rechner vergessen. Nimmt Vertrauen weg, braucht deshalb keine PIN. */
  router.delete('/api/vault/geraet', (rc) => {
    rc.requireOwner('Das Vergessen dieses Geräts');
    const crypto = needMethod(rc.ctx.vaultCrypto, 'vergessen', 'Die Vault-Verschlüsselung');
    const r = crypto.vergessen();
    // Wer eben noch als gemerktes Gerät lief, braucht ab jetzt eine Sitzung.
    sitzungSetzen(rc);
    audit(rc, 'vault.geraet.vergessen', r);
    publish(rc, 'vault.geraet', { gemerkt: false });
    return { ...r, ...stateOf(rc), schutz: schutzVon(rc) };
  });

  /** Alle gemerkten Rechner vergessen -- auch die, die gerade nicht da sind. */
  router.delete('/api/vault/geraete', (rc) => {
    rc.requireOwner('Das Vergessen der Geräte');
    const crypto = needMethod(rc.ctx.vaultCrypto, 'alleVergessen', 'Die Vault-Verschlüsselung');
    const r = crypto.alleVergessen();
    sitzungSetzen(rc);
    audit(rc, 'vault.geraete.vergessen', r);
    publish(rc, 'vault.geraet', { gemerkt: false, alle: true });
    return { ...r, ...stateOf(rc), schutz: schutzVon(rc) };
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
    // Die Länge entscheidet vaultcrypto (PIN aus 4-6 Ziffern oder >= 8 Zeichen).
    const passphrase = requireString(body.passphrase, 'passphrase', { max: 1024, trim: false });
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
    const neben = nebendateienVersiegeln(rc);
    const sitzung = sitzungSetzen(rc);
    audit(rc, 'vault.encrypt', { via: 'http', rewritten });
    publish(rc, 'vault.encrypted', { at: new Date().toISOString() });
    return { ...stateOf(rc), rewritten, neben, sitzung };
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
