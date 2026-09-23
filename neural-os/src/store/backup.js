'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { StorageError, ValidationError } = require('../kernel/errors');
const { safeJoin } = require('../kernel/paths');
const { logger: makeLogger } = require('../kernel/log');
const schema = require('./schema');
const configMod = require('../kernel/config');
const vaultcrypto = require('./vaultcrypto');

/**
 * Export and restore. The promise this module makes is narrow and absolute:
 * the user can always get their data out, and always get it back in.
 *
 * Two formats, one purpose each
 * -----------------------------
 * `export.json` is the machine format and the ONLY thing `importAll` reads. It
 * carries complete record envelopes, tombstones included, so a restore
 * reproduces the vault rather than a flattened impression of it.
 * The Markdown tree is for humans and for the day this program no longer
 * exists: plain files, readable in any editor, with YAML front-matter so
 * Obsidian and friends can pick them up. It is deliberately NOT re-imported --
 * a lossy parse of prose back into records would be a data-loss machine
 * dressed up as a feature.
 *
 * Front-matter keys are English (`title`, `tags`, `created`) even though the
 * UI is German: they are identifiers other tools match on, not user-facing
 * copy. The prose, headings and labels in the documents are German.
 *
 * Why the snapshot is collected in one synchronous pass
 * ----------------------------------------------------
 * `collect()` reads every record without awaiting anything, so no concurrent
 * write can land between two types and tear the snapshot. Writing to disk
 * happens afterwards, from the frozen copy.
 *
 * Why exports are 0600/0700
 * -------------------------
 * An export is the whole vault in plaintext. If the vault itself is encrypted,
 * this directory is the weakest point in the system, so it gets the tightest
 * modes the filesystem will take and INDEX.md says so in plain German.
 *
 * Why edges are imported last
 * ---------------------------
 * `store.edges.add` rejects edges whose endpoints are missing, and a `replace`
 * import purges a record before recreating it. Importing nodes first, edges
 * afterwards, means an edge never looks for an endpoint that is mid-replace.
 *
 * Why the configuration travels but the network mode does not
 * -----------------------------------------------------------
 * A restore that reproduces the records but not the settings is only half a
 * restore: the person is back in front of an empty-looking system whose
 * models, theme, allow-lists and limits all read "factory". So the settings
 * travel -- with one deliberate exception.
 *
 * `network.mode` is not a preference, it is a security decision about THIS
 * machine. A backup taken on a device that was allowed online must not be able
 * to quietly open a device that is deliberately kept offline: restoring a file
 * would then widen the network stance without anybody saying yes. The mode is
 * therefore REPORTED in the import result ("in der Sicherung stand: lan") so
 * the surface can ask, and never written back. The same reasoning applies to
 * `security.sharing` (would open a LAN port) and `security.encryption`
 * (key material lives on the device, not in the backup -- writing the flag
 * back would tell a plaintext vault it is encrypted, which is how a vault
 * becomes unreadable). Everything else is applied.
 *
 * Why access tokens do not travel
 * -------------------------------
 * A `token` record carries hash, salt, selector and KDF parameters for LAN
 * access. That is verification material for a door on one specific device --
 * credentials, not knowledge. Anyone handed a backup would be handed the
 * material to attack that door offline. Tokens are therefore left out of the
 * export entirely, and INDEX.md says so. Network grants (`grant`) DO travel:
 * they are the user's own policy about what may be reached, and they open
 * nothing on their own. Peer records travel as well, but with their replayable
 * access token blanked, for exactly the token reason above.
 *
 * Why the export passphrase is off by default
 * -------------------------------------------
 * An export is the whole vault in the clear. A passphrase closes that, and
 * `vaultcrypto.js` already has the pieces (scrypt KEK, random data key, AES-
 * 256-GCM), so the export reuses that module rather than inventing a second
 * cryptosystem. It is nevertheless OFF unless asked for: a forgotten export
 * passphrase turns the backup into noise, and a backup you cannot open is a
 * worse outcome than a 0600 folder on a disk you control. When it is off, the
 * export says so in plain German instead of implying safety it does not have.
 *
 * Why the change journal travels and the network log does not
 * -----------------------------------------------------------
 * `vault/history.jsonl` is part of what the user knows: it is the undo trail
 * of their own edits and it belongs to the vault. `audit.jsonl` is a record of
 * what THIS device attempted on the network -- a device log. Carrying it to a
 * new machine would mix two machines' histories into one file and make the one
 * thing the network view must be able to prove ("this is what this computer
 * did") impossible to read.
 *
 * Warum es einen vierten Modus gibt: `restore`
 * --------------------------------------------
 * Der Zweck einer Sicherung ist "falls alles verloren geht, auf einem neuen
 * Gerät wiederherstellen". Genau dieser Weg fehlte, und zwar messbar: eine
 * frische Installation legt beim ersten Start eine Erstausstattung an
 * (`seedIfEmpty`: Willkommensnotiz, zwei Aufgaben, ein Projekt, sechs
 * eingebaute Agenten -- 14 Sätze). Danach scheitert `fresh` mit "der Vault ist
 * nicht leer", und `merge` wie `replace` lassen die Erstausstattung stehen:
 * gemessen +2 Notizen, +1 Projekt, +2 Aufgaben, +6 Agenten gegenüber dem
 * gesicherten Stand. Keiner der drei Modi stellt also den Wissensstand her.
 *
 * `restore` tut das: er LÖSCHT zuerst alles, was hier liegt -- Sätze,
 * Grabsteine, Kanten und, wenn die Sicherung Anhänge trägt, auch die Blobs,
 * die nicht in ihr stehen -- und spielt danach die Sicherung ein. Hinterher
 * ist dieser Tresor der gesicherte Tresor, nicht seine Vereinigung mit dem,
 * was hier zufällig schon lag.
 *
 * Drei Dinge daran sind bewusst so und nicht anders:
 *  - Er ist NIE Voreinstellung. `importAll()` ohne Modus bleibt `merge`, der
 *    einzige Modus, der nichts wegnimmt.
 *  - Er sagt vorher, was verschwindet. `preview()` liefert die Zahlen, bevor
 *    irgendetwas geschrieben wird; die Oberfläche zeigt sie und fragt.
 *  - Er löscht KEINE Anhänge, wenn die Sicherung ohne Anhänge geschrieben
 *    wurde (`includeFiles:false`). Eine Sicherung, die nie behauptet hat,
 *    Dateien zu enthalten, darf keine löschen. Das steht dann im Ergebnis.
 */

const EXPORT_VERSION = 2;
/**
 * A v1 export (no configuration, tokens still inside, never sealed) has to
 * keep restoring. A backup that a newer version refuses to read is not a
 * backup, so the reader accepts both and the writer only ever emits the
 * current one.
 */
const SUPPORTED_EXPORT_VERSIONS = [1, 2];
const EXPORT_KIND = 'neural-os-export';
const MANIFEST_KIND = 'neural-os-manifest';
const EXPORT_FILE = 'export.json';
/** Same payload, sealed under the export passphrase. */
const SEALED_FILE = 'export.json.enc';
/** Wrapped data key + scrypt parameters for the sealed payload. */
const KEYS_FILE = 'export-keys.json';
const MANIFEST_FILE = 'manifest.json';
const HISTORY_FILE = 'history.jsonl';
const PAGE_SIZE = 500;

/**
 * Record types that are deliberately left out of every export.
 * See the header: these are device credentials, not knowledge.
 */
const EXCLUDED_TYPES = new Set(['token']);

/**
 * Die erlaubten Importmodi. Reihenfolge ist Absicht: von "nimmt nichts weg"
 * nach "nimmt alles weg". `merge` steht vorn, weil es die Voreinstellung ist
 * und bleibt.
 */
const IMPORT_MODES = ['merge', 'replace', 'fresh', 'restore'];

/**
 * Settings that are reported on import instead of applied, because writing
 * them back would change a security posture nobody agreed to on this machine.
 */
const REPORTED_ONLY = [
  ['network.mode', 'Der Netzmodus ist eine Entscheidung dieses Geraets.'],
  ['security.sharing', 'Die Freigabe im lokalen Netz oeffnet einen Port und bleibt daher aus.'],
  ['security.encryption', 'Die Verschluesselung haengt am Schluesselmaterial dieses Geraets.'],
];
/** Nothing legitimate pages this often; the cap stops a broken `list()`
 *  implementation that ignores `offset` from spinning forever. */
const MAX_PAGES_PER_TYPE = 100000;

const ROLE_LABELS = { user: 'Nutzer', assistant: 'Assistent', system: 'System', tool: 'Werkzeug' };
/**
 * German names for every record type in `schema.TYPES`. INDEX.md is read by a
 * person, so it may not fall back to the raw English type name -- a table that
 * says "schedule: 3" tells a German reader nothing. `typeLabel()` keeps the
 * raw name visible for a type this version does not know yet, but says in
 * German that it does not know it.
 */
const TYPE_LABELS = {
  note: 'Notizen', chat: 'Chats', message: 'Nachrichten', project: 'Projekte', task: 'Aufgaben', event: 'Termine',
  agent: 'Agenten', run: 'Agentenlaeufe', file: 'Dateien', entity: 'Entitaeten', edge: 'Verknuepfungen',
  memory: 'Erinnerungen', approval: 'Freigaben', grant: 'Netz-Freigaben', token: 'Zugangstoken',
  peer: 'Gekoppelte Geraete', conflict: 'Abgleich-Konflikte', module: 'Erweiterungen',
  suggestion: 'Vorschlaege', schedule: 'Zeitplaene', trigger: 'Ausloeser',
  watch: 'Beobachtete Ordner',
};

function typeLabel(type) {
  return TYPE_LABELS[type] || `${type} (unbekannte Art)`;
}

/** "1 Eintrag", nicht "1 Eintraege". Der Text ist fuer Menschen. */
function anzahl(n, einzahl, mehrzahl) {
  return `${n} ${n === 1 ? einzahl : mehrzahl}`;
}
const STATUS_LABELS = {
  todo: 'offen', doing: 'in Arbeit', blocked: 'blockiert', done: 'erledigt',
  active: 'aktiv', paused: 'pausiert', archived: 'archiviert',
};

function appVersion() {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Deep copy through JSON so the export can never alias live store state. */
function toPlain(value, what) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    throw new StorageError(`${what} ist nicht serialisierbar: ${err.message}`);
  }
}

function isThenable(v) {
  return v && typeof v.then === 'function';
}

/**
 * Fold German text into an ASCII slug. Umlauts are expanded BEFORE Unicode
 * decomposition, otherwise "Grüße" would decompose to "Grusse" and lose the
 * spelling a German reader expects ("gruesse").
 */
function slugify(input, fallback = 'ohne-titel') {
  const folded = String(input ?? '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const slug = folded.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug || fallback;
}

/**
 * Filenames stay stable across exports (so two backups diff cleanly) by always
 * carrying the record's id tail instead of a collision counter that would
 * shuffle when records are added.
 */
function recordSlug(record, title, fallback) {
  const tail = String(record.id || '').slice(-6) || crypto.randomBytes(3).toString('hex');
  return `${slugify(title, fallback)}-${tail}`;
}

function safeExt(name) {
  const ext = path.extname(String(name || ''));
  return /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '';
}

/**
 * YAML front-matter values are emitted as JSON literals. JSON is a subset of
 * YAML 1.2, so this is valid YAML AND correctly escapes quotes, colons,
 * newlines and umlauts without hand-rolling an escaper that gets one of them
 * wrong on a title like `Meeting: "Q3" — Notizen`.
 */
function frontMatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value === null ? null : value)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** Normalise line endings so exported documents are stable across platforms. */
function body(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function germanDateTime(iso) {
  if (!iso) return 'unbekannt';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function modelLabel(model) {
  if (!model || typeof model !== 'object') return null;
  const provider = model.provider || model.kind || null;
  const name = model.model || model.id || null;
  if (provider && name) return `${provider}/${name}`;
  return name || provider || null;
}

/**
 * @param {{store:object, paths:object, config?:object, logger?:object,
 *          vaultCrypto?:object}} deps
 *
 * `vaultCrypto` is optional and only used to read the change journal of an
 * ENCRYPTED vault. Without it the journal's sealed lines are counted and named
 * rather than silently dropped -- see `readJournal()`.
 */
function createBackup({ store, paths, config, logger, vaultCrypto } = {}) {
  if (!store || typeof store.list !== 'function') {
    throw new ValidationError('createBackup benoetigt einen Store mit list().');
  }
  if (!paths || typeof paths.exports !== 'string') {
    throw new ValidationError('createBackup benoetigt paths.exports.');
  }
  const log = logger || makeLogger('backup');

  // ---------------------------------------------------------------- reading

  function listPage(type, offset) {
    // Order explicitly by createdAt: it is the one envelope field that never
    // changes, so paging with an offset cannot skip or repeat a record. The
    // store's default order is `updatedAt` descending, which would reshuffle
    // under any concurrent write and silently drop rows between two pages.
    const page = store.list(type, { includeDeleted: true, limit: PAGE_SIZE, offset, sort: 'createdAt', order: 'asc' });
    if (isThenable(page)) {
      // The contract says the store is synchronous; an async one would make a
      // torn snapshot possible, so refuse rather than paper over it.
      throw new StorageError('store.list() hat ein Promise geliefert; der Vertrag verlangt eine synchrone API.');
    }
    if (Array.isArray(page)) return { items: page, total: page.length };
    if (!page || !Array.isArray(page.items)) {
      throw new StorageError(`store.list('${type}') lieferte kein {items,total}-Objekt.`);
    }
    return page;
  }

  /**
   * One synchronous pass over the whole vault. No awaits: see header.
   * `withheld` counts what was deliberately left behind, so the export can
   * say it out loud instead of letting the number quietly not add up.
   */
  function collect() {
    const records = [];
    const seen = new Set();
    const withheld = {};
    for (const type of schema.TYPES) {
      if (EXCLUDED_TYPES.has(type)) {
        withheld[type] = listPage(type, 0).total || 0;
        continue;
      }
      let offset = 0;
      for (let page = 0; page < MAX_PAGES_PER_TYPE; page++) {
        const { items, total } = listPage(type, offset);
        if (!items.length) break;
        for (const item of items) {
          if (!item || typeof item.id !== 'string') continue;
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          records.push(envelope(item));
        }
        offset += items.length;
        if (items.length < PAGE_SIZE) break;
        if (Number.isFinite(total) && offset >= total) break;
      }
    }
    return { records, withheld };
  }

  /** Keep the envelope explicit: unknown extra top-level keys are dropped, so
   *  an import never resurrects transient in-memory bookkeeping as user data. */
  function envelope(record) {
    return redact(toPlain({
      id: record.id,
      type: record.type,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
      deletedAt: record.deletedAt ?? null,
      rev: Number.isFinite(record.rev) ? record.rev : 1,
      data: record.data && typeof record.data === 'object' ? record.data : {},
    }, `Record ${record.id}`));
  }

  /**
   * Strip credentials that would otherwise ride along inside an ordinary
   * record.
   *
   * `peer.token` is not verification material like a `token` record's hash --
   * it is the key itself, replayed to the other device on every sync. In a
   * plaintext folder that is a spare key to the computer next door. The peer
   * itself travels (that this device exists is the user's own knowledge); the
   * pairing is confirmed again on the new machine. The blanking is marked on
   * the record so it is visible to anyone who opens export.json, rather than
   * looking like the user never had a token.
   */
  function redact(rec) {
    if (rec.type === 'peer' && rec.data && typeof rec.data.token === 'string' && rec.data.token) {
      rec.data = { ...rec.data, token: '' };
      rec.redacted = ['token'];
    }
    return rec;
  }

  /**
   * The part of the configuration that belongs to the knowledge, not to the
   * machine. `server` (host and port) is left out on purpose: where this
   * program listens is a property of the computer it runs on.
   *
   * `apiKey` is dropped from remote providers even though the config is not
   * supposed to hold one -- a backup is the wrong place to find out that an
   * earlier version, or a hand-edited config.json, did.
   */
  function configSnapshot(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const n = c.network || {};
    const m = c.models || {};
    const u = c.ui || {};
    const sec = c.security || {};
    const ag = c.agents || {};
    const hist = c.history || {};
    const enc = sec.encryption || {};
    const share = sec.sharing || {};
    const cleanProvider = (entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const copy = { ...entry };
      delete copy.apiKey;
      return copy;
    };
    return toPlain({
      network: {
        mode: n.mode ?? null,
        strictAllowlist: n.strictAllowlist ?? null,
        allowHosts: Array.isArray(n.allowHosts) ? n.allowHosts : [],
        blockHosts: Array.isArray(n.blockHosts) ? n.blockHosts : [],
        audit: n.audit ?? null,
      },
      models: {
        providers: Array.isArray(m.providers) ? m.providers.map(cleanProvider).filter(Boolean) : [],
        default: m.default ?? null,
        remote: Array.isArray(m.remote) ? m.remote.map(cleanProvider).filter(Boolean) : [],
      },
      ui: {
        theme: u.theme ?? null,
        density: u.density ?? null,
        reduceMotion: u.reduceMotion ?? null,
        locale: u.locale ?? null,
      },
      security: {
        encryption: { enabled: Boolean(enc.enabled) },
        sharing: {
          enabled: Boolean(share.enabled),
          requireToken: share.requireToken !== false,
          bindHost: share.bindHost ?? null,
        },
        globalApprovalOverride: Boolean(sec.globalApprovalOverride),
      },
      agents: {
        maxConcurrentRuns: ag.maxConcurrentRuns ?? null,
        defaultMaxSteps: ag.defaultMaxSteps ?? null,
        defaultMaxSeconds: ag.defaultMaxSeconds ?? null,
      },
      history: {
        maxEntries: hist.maxEntries ?? null,
        maxDays: hist.maxDays ?? null,
      },
    }, 'Konfiguration');
  }

  /**
   * Group by type, chronologically.
   *
   * Records arrive from `collect()` already sorted by createdAt ascending, so
   * this sort only regroups them. Ties keep the order collect() saw rather
   * than being broken on the (random) id, which would print a reply above its
   * question whenever both landed in the same millisecond.
   *
   * Honest limit: at millisecond granularity the store's own tie-break is all
   * there is. engine.js orders ties by id, i.e. arbitrarily. Real messages are
   * seconds apart so this shows up mainly in bulk imports; a monotonic
   * sequence number on `message` would close the gap for good.
   */
  function byType(records) {
    const grouped = new Map();
    records.forEach((record, index) => {
      if (!grouped.has(record.type)) grouped.set(record.type, []);
      grouped.get(record.type).push({ record, index });
    });
    const out = new Map();
    for (const [type, entries] of grouped) {
      entries.sort((a, b) => String(a.record.createdAt).localeCompare(String(b.record.createdAt)) || a.index - b.index);
      out.set(type, entries.map((e) => e.record));
    }
    return out;
  }

  function live(records) {
    return records.filter((r) => !r.deletedAt);
  }

  // ---------------------------------------------------------------- writing

  function makeWriter(dir) {
    /** @type {Array<{path:string, bytes:number, sha256:string}>} */
    const entries = [];
    let bytes = 0;
    return {
      entries,
      get bytes() { return bytes; },
      /** @param {string} rel @param {Buffer|string} content */
      write(rel, content) {
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
        const tmp = `${abs}.tmp-${process.pid}`;
        try {
          fs.writeFileSync(tmp, buf, { mode: 0o600 });
          fs.renameSync(tmp, abs);
        } catch (err) {
          try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
          throw new StorageError(`Export-Datei ${rel} konnte nicht geschrieben werden: ${err.message}`);
        }
        entries.push({ path: rel.split(path.sep).join('/'), bytes: buf.length, sha256: sha256(buf) });
        bytes += buf.length;
        return buf.length;
      },
      /**
       * Record a file that something else wrote into the export directory.
       * `export-keys.json` is produced by vaultcrypto at its final path, and a
       * manifest that does not list it would let `prunePrevious` leave the old
       * key file behind next to a new export -- two key files, one of which
       * opens nothing.
       */
      register(rel, buf) {
        entries.push({ path: rel.split(path.sep).join('/'), bytes: buf.length, sha256: sha256(buf) });
        bytes += buf.length;
        return buf.length;
      },
    };
  }

  // --------------------------------------------------- eigene Passphrase

  /**
   * Seal an export under a passphrase that is INDEPENDENT of the vault key.
   *
   * Deliberately no new cryptography: this is `vaultcrypto.js` pointed at a
   * key file inside the export folder. Random data key, wrapped under a
   * scrypt-derived KEK, AES-256-GCM -- the same construction, the same
   * parameters and the same reviewed code path the vault itself uses.
   *
   * The throwaway `{}` config is not cosmetic: vaultcrypto sets
   * `security.encryption.enabled` on whatever config object it is handed, and
   * handing it the application's config would tell a plaintext vault that it
   * is encrypted -- after which the store would try to decrypt plain lines.
   */
  function exportCrypto(keysPath) {
    return vaultcrypto.createVaultCrypto({ paths: { secrets: keysPath }, config: {} });
  }

  /**
   * Every blob in the vault, referenced or not.
   *
   * Prefers an enumeration the store offers and otherwise reads the
   * content-addressed layout directly (`vault/files/<aa>/<hash>`) -- a blob
   * that no record points at is precisely the case no record can lead us to.
   */
  function allBlobHashes() {
    const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
    if (store.files && typeof store.files.list === 'function') {
      try {
        const listed = store.files.list();
        if (Array.isArray(listed)) {
          return listed.map((e) => (typeof e === 'string' ? e : e && e.hash)).filter(isHash);
        }
      } catch (err) {
        log.warn(`Die Dateiliste des Speichers ist nicht lesbar (${err.message}); es wird direkt im Ordner nachgesehen.`);
      }
    }
    const root = paths.files;
    if (typeof root !== 'string') return [];
    const out = [];
    let shards;
    try {
      shards = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out; // kein Dateiordner: dann gibt es auch keine verwaisten Blobs
    }
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      let names;
      try {
        names = fs.readdirSync(path.join(root, shard.name));
      } catch {
        continue;
      }
      for (const name of names) if (isHash(name)) out.push(name);
    }
    return out;
  }

  /**
   * The change journal, decoded as far as it can be.
   *
   * The journal is encrypted line by line with the VAULT key, which this
   * module does not hold (`createBackup` is given the store, not the key). A
   * line that starts with `{` is plain JSON and travels; a sealed line is
   * counted and named. `vaultCrypto` may be handed in later without changing
   * anything else here.
   */
  function readJournal() {
    const file = typeof paths.vault === 'string' ? path.join(paths.vault, HISTORY_FILE) : null;
    const out = { lines: [], sealed: 0, broken: 0, file };
    if (!file) return out;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Der Aenderungsverlauf ist nicht lesbar (${err.message}); die Sicherung laeuft ohne ihn weiter.`);
      return out;
    }
    for (const rawLine of raw.split('\n')) {
      const text = rawLine.trim();
      if (!text) continue;
      if (text.charCodeAt(0) !== 0x7b /* { */) {
        if (vaultCrypto && typeof vaultCrypto.decryptLine === 'function') {
          try {
            out.lines.push(JSON.parse(vaultCrypto.decryptLine(text)));
            continue;
          } catch { /* faellt unten als versiegelt durch */ }
        }
        out.sealed++;
        continue;
      }
      try {
        out.lines.push(JSON.parse(text));
      } catch {
        out.broken++;
      }
    }
    return out;
  }

  /**
   * Remove only the files a PREVIOUS export of this directory wrote. Anything
   * else in the directory belongs to the user and is never touched -- an
   * export must not be able to delete data it did not create.
   */
  function prunePrevious(dir) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
    } catch {
      return 0;
    }
    if (!manifest || manifest.kind !== MANIFEST_KIND || !Array.isArray(manifest.files)) return 0;
    let removed = 0;
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== 'string') continue;
      let abs;
      try {
        abs = safeJoin(dir, entry.path);
      } catch {
        continue; // a manifest claiming ../../etc/passwd gets ignored, not obeyed
      }
      try {
        fs.unlinkSync(abs);
        removed++;
      } catch { /* already gone */ }
    }
    try { fs.unlinkSync(path.join(dir, MANIFEST_FILE)); } catch { /* ignore */ }
    return removed;
  }

  // --------------------------------------------------------------- markdown

  function noteDoc(record) {
    const d = record.data || {};
    return frontMatter({
      id: record.id,
      type: 'note',
      title: d.title ?? '',
      tags: Array.isArray(d.tags) ? d.tags : [],
      pinned: Boolean(d.pinned),
      source: d.source ?? 'user',
      created: record.createdAt,
      updated: record.updatedAt,
    }) + `# ${body(d.title) || 'Ohne Titel'}\n\n${body(d.body)}\n`;
  }

  function chatDoc(record, messages) {
    const d = record.data || {};
    const model = modelLabel(d.model);
    const parts = [frontMatter({
      id: record.id,
      type: 'chat',
      title: d.title ?? '',
      model: d.model ?? null,
      network: d.network ?? 'offline',
      agentId: d.agentId ?? null,
      messages: messages.length,
      created: record.createdAt,
      updated: record.updatedAt,
    })];
    parts.push(`# ${body(d.title) || 'Chat'}\n`);
    parts.push(`> Modell: ${model || 'nicht festgelegt'} · Netzzugriff: ${d.network ?? 'offline'} · ${messages.length} Nachrichten\n`);
    if (d.systemPrompt) parts.push(`## Systemanweisung\n\n${body(d.systemPrompt)}\n`);
    if (!messages.length) parts.push('_Dieser Chat enthaelt keine Nachrichten._\n');

    for (const m of messages) {
      const md = m.data || {};
      const role = ROLE_LABELS[md.role] || md.role || 'Unbekannt';
      const meta = [germanDateTime(m.createdAt)];
      const mModel = modelLabel(md.model);
      if (mModel) meta.push(mModel);
      if (md.status && md.status !== 'complete') meta.push(`Status: ${md.status}`);
      parts.push(`## ${role} · ${meta.join(' · ')}\n`);
      // Truthful provenance carries into the export: a reader must be able to
      // see which answers involved the network.
      if (md.usedNetwork) {
        const targets = Array.isArray(md.networkTargets) && md.networkTargets.length ? md.networkTargets.join(', ') : 'unbekanntes Ziel';
        parts.push(`> Netzzugriff erfolgt: ${targets}\n`);
      }
      parts.push(`${body(md.content) || '_(leer)_'}\n`);
      if (Array.isArray(md.toolCalls) && md.toolCalls.length) {
        parts.push('### Werkzeugaufrufe\n');
        for (const call of md.toolCalls) {
          const args = call && call.arguments !== undefined ? JSON.stringify(call.arguments) : '{}';
          parts.push(`- \`${(call && call.name) || 'unbekannt'}\` ${args}`);
        }
        parts.push('');
      }
      if (md.error) parts.push(`> Fehler: ${body(md.error.message || JSON.stringify(md.error))}\n`);
    }
    return parts.join('\n');
  }

  function projectDoc(record, tasks, taskPaths) {
    const d = record.data || {};
    const open = tasks.filter((t) => (t.data || {}).status !== 'done').length;
    const parts = [frontMatter({
      id: record.id,
      type: 'project',
      name: d.name ?? '',
      status: d.status ?? 'active',
      tags: Array.isArray(d.tags) ? d.tags : [],
      tasks: tasks.length,
      created: record.createdAt,
      updated: record.updatedAt,
    })];
    parts.push(`# ${body(d.name) || 'Projekt'}\n`);
    parts.push(`> Status: ${STATUS_LABELS[d.status] || d.status || 'aktiv'}\n`);
    if (d.description) parts.push(`${body(d.description)}\n`);
    parts.push(`## Aufgaben (${open} offen von ${tasks.length})\n`);
    if (!tasks.length) parts.push('_Keine Aufgaben in diesem Projekt._\n');
    for (const t of tasks) {
      const td = t.data || {};
      const box = td.status === 'done' ? '[x]' : '[ ]';
      const extra = [];
      if (td.status && td.status !== 'todo' && td.status !== 'done') extra.push(STATUS_LABELS[td.status] || td.status);
      if (td.due) extra.push(`faellig ${td.due}`);
      if (td.priority === 1) extra.push('hohe Prioritaet');
      const link = taskPaths.get(t.id);
      const suffix = extra.length ? ` — ${extra.join(' · ')}` : '';
      parts.push(`- ${box} ${link ? `[${body(td.title) || 'Aufgabe'}](../${link})` : body(td.title) || 'Aufgabe'}${suffix}`);
    }
    parts.push('');
    return parts.join('\n');
  }

  function taskDoc(record, projectName) {
    const d = record.data || {};
    const parts = [frontMatter({
      id: record.id,
      type: 'task',
      title: d.title ?? '',
      status: d.status ?? 'todo',
      priority: Number.isFinite(d.priority) ? d.priority : 2,
      due: d.due ?? null,
      projectId: d.projectId ?? null,
      project: projectName ?? null,
      created: record.createdAt,
      updated: record.updatedAt,
    })];
    parts.push(`# ${body(d.title) || 'Aufgabe'}\n`);
    const meta = [`Status: ${STATUS_LABELS[d.status] || d.status || 'offen'}`, `Prioritaet: ${Number.isFinite(d.priority) ? d.priority : 2}`];
    if (d.due) meta.push(`faellig am ${d.due}`);
    if (projectName) meta.push(`Projekt: ${projectName}`);
    parts.push(`> ${meta.join(' · ')}\n`);
    if (d.body) parts.push(`${body(d.body)}\n`);
    return parts.join('\n');
  }

  function agentDoc(record) {
    const d = record.data || {};
    const p = schema.normalisePermissions(d.permissions);
    const parts = [frontMatter({
      id: record.id,
      type: 'agent',
      name: d.name ?? '',
      model: d.model ?? null,
      builtin: Boolean(d.builtin),
      created: record.createdAt,
      updated: record.updatedAt,
    })];
    parts.push(`# ${body(d.name) || 'Agent'}\n`);
    if (d.description) parts.push(`${body(d.description)}\n`);
    parts.push('## Berechtigungen\n');
    const granted = ['readNotes', 'writeNotes', 'readFiles', 'writeFiles', 'createEdges', 'runTasks', 'spawnAgents']
      .filter((k) => p[k] === true);
    parts.push(`- Faehigkeiten: ${granted.length ? granted.join(', ') : 'keine'}`);
    parts.push(`- Netzzugriff: ${p.network}`);
    parts.push(`- Bestaetigung noetig: ${p.requireApproval ? 'ja' : 'nein'}`);
    parts.push(`- Dateiwurzeln: ${Array.isArray(p.fileRoots) && p.fileRoots.length ? p.fileRoots.join(', ') : 'keine'}\n`);
    if (d.systemPrompt) parts.push(`## Systemanweisung\n\n${body(d.systemPrompt)}\n`);
    return parts.join('\n');
  }

  // ---- Listen: die Saetze, fuer die eine eigene Datei je Eintrag nur Laerm
  // waere. Sie fehlten bisher ganz -- wer im Notfall die Markdown-Dateien
  // oeffnet, fand weder seine Zeitplaene noch seine Netz-Freigaben.

  const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

  function yesNo(value) {
    return value ? 'ja' : 'nein';
  }

  /** @param {{title:string, type:string, intro?:string, empty:string}} head */
  function listDoc(head, records, row, at) {
    const parts = [frontMatter({
      type: head.type, kind: 'liste', count: records.length, created: at,
    })];
    parts.push(`# ${head.title}\n`);
    if (head.intro) parts.push(`${head.intro}\n`);
    if (!records.length) {
      parts.push(`_${head.empty}_\n`);
      return parts.join('\n');
    }
    for (const record of records) parts.push(row(record));
    parts.push('');
    return parts.join('\n');
  }

  function scheduleRow(record, agentNames) {
    const d = record.data || {};
    const wann = d.every === 'hourly' ? 'stuendlich'
      : d.every === 'weekly' ? `woechentlich, ${WEEKDAYS[Number(d.onWeekday) % 7] || 'Montag'} um ${Number(d.atHour) || 0} Uhr`
        : `taeglich um ${Number(d.atHour) || 0} Uhr`;
    const lines = [`## ${agentNames.get(d.agentId) || 'Unbekannter Agent'} — ${wann}\n`];
    lines.push(`- Eingeschaltet: ${yesNo(d.enabled)}`);
    if (d.goal) lines.push(`- Auftrag: ${body(d.goal)}`);
    lines.push(`- Bisherige Laeufe: ${Number(d.runs) || 0}`);
    if (d.lastRunAt) lines.push(`- Zuletzt gelaufen: ${germanDateTime(d.lastRunAt)}`);
    if (d.nextRunAt) lines.push(`- Naechster Lauf: ${germanDateTime(d.nextRunAt)}`);
    if (d.lastError) lines.push(`- Letzter Fehler: ${body(d.lastError)}`);
    return `${lines.join('\n')}\n`;
  }

  function triggerRow(record, agentNames) {
    const d = record.data || {};
    const ereignis = { 'record.created': 'neu angelegt', 'record.updated': 'geaendert', 'record.deleted': 'geloescht' }[d.on] || d.on || 'unbekannt';
    const lines = [`## ${agentNames.get(d.agentId) || 'Unbekannter Agent'} — wenn etwas ${ereignis} wird\n`];
    lines.push(`- Eingeschaltet: ${yesNo(d.enabled)}`);
    if (d.recordType) lines.push(`- Nur fuer: ${typeLabel(d.recordType)}`);
    if (d.tag) lines.push(`- Nur mit Schlagwort: ${body(d.tag)}`);
    if (d.titleContains) lines.push(`- Nur wenn der Titel enthaelt: ${body(d.titleContains)}`);
    if (d.goal) lines.push(`- Auftrag: ${body(d.goal)}`);
    lines.push(`- Hoechstens ${Number(d.maxPerHour) || 0} Mal pro Stunde, Beruhigungszeit ${Number(d.debounceMs) || 0} ms`);
    lines.push(`- Bisher ausgeloest: ${Number(d.fires) || 0}`);
    if (d.lastError) lines.push(`- Letzter Fehler: ${body(d.lastError)}`);
    return `${lines.join('\n')}\n`;
  }

  function grantRow(record) {
    const d = record.data || {};
    const lines = [`## ${body(d.scope) || 'ohne Geltungsbereich'} — Stufe ${d.level || 'online'}\n`];
    const hosts = Array.isArray(d.hosts) ? d.hosts : [];
    lines.push(`- Ziele: ${hosts.length ? (hosts.includes('*') ? 'alle (*)' : hosts.join(', ')) : 'keine'}`);
    if (d.reason) lines.push(`- Begruendung: ${body(d.reason)}`);
    lines.push(`- Zurueckgenommen: ${yesNo(d.revoked)}`);
    if (d.expiresAt) lines.push(`- Laeuft ab: ${germanDateTime(d.expiresAt)}`);
    lines.push(`- Benutzt: ${Number(d.uses) || 0}${Number.isFinite(d.maxUses) && d.maxUses !== null ? ` von hoechstens ${d.maxUses}` : ''}`);
    return `${lines.join('\n')}\n`;
  }

  function watchRow(record) {
    const d = record.data || {};
    const lines = [`## ${body(d.label) || body(d.path) || 'Ordner'}\n`];
    lines.push(`- Pfad: \`${body(d.path)}\``);
    lines.push(`- Eingeschaltet: ${yesNo(d.enabled)} · mit Unterordnern: ${yesNo(d.recursive)}`);
    const ext = Array.isArray(d.extensions) ? d.extensions : [];
    lines.push(`- Endungen: ${ext.length ? ext.join(', ') : 'alle lesbaren'}`);
    const tags = Array.isArray(d.tags) ? d.tags : [];
    if (tags.length) lines.push(`- Schlagwoerter: ${tags.join(', ')}`);
    lines.push(`- Aufgenommen: ${Number(d.imported) || 0} · uebersprungen: ${Number(d.skipped) || 0}`);
    if (d.lastError) lines.push(`- Letzter Fehler: ${body(d.lastError)}`);
    return `${lines.join('\n')}\n`;
  }

  function peerRow(record) {
    const d = record.data || {};
    const richtung = { pull: 'nur holen', push: 'nur senden', both: 'in beide Richtungen' }[d.direction] || d.direction || 'unbekannt';
    const lines = [`## ${body(d.name) || 'Geraet'}\n`];
    lines.push(`- Adresse: ${body(d.url)}`);
    lines.push(`- Abgleich: ${richtung}`);
    if (d.lastSyncAt) lines.push(`- Zuletzt abgeglichen: ${germanDateTime(d.lastSyncAt)}`);
    if (d.lastError) lines.push(`- Letzter Fehler: ${body(d.lastError)}`);
    lines.push('- Zugangstoken: **nicht in der Sicherung** — die Kopplung wird auf dem neuen Geraet neu bestaetigt.');
    return `${lines.join('\n')}\n`;
  }

  function memoryRow(record) {
    const d = record.data || {};
    return `- ${body(d.text) || '(leer)'} ${d.importance !== undefined ? `_(Gewicht ${d.importance})_` : ''}`.trimEnd();
  }

  function entityRow(record) {
    const d = record.data || {};
    const aliases = Array.isArray(d.aliases) && d.aliases.length ? ` — auch: ${d.aliases.join(', ')}` : '';
    return `- **${body(d.name) || 'ohne Namen'}** (${body(d.kind) || 'unbekannte Art'})${aliases}`;
  }

  function runRow(record, agentNames) {
    const d = record.data || {};
    const lines = [`## ${agentNames.get(d.agentId) || 'Unbekannter Agent'} — ${STATUS_LABELS[d.status] || d.status || 'unbekannt'}\n`];
    lines.push(`- Zeitpunkt: ${germanDateTime(record.createdAt)}`);
    if (d.goal) lines.push(`- Auftrag: ${body(d.goal)}`);
    if (d.result) lines.push(`- Ergebnis: ${body(d.result)}`);
    if (d.error) lines.push(`- Fehler: ${body(typeof d.error === 'string' ? d.error : JSON.stringify(d.error))}`);
    return `${lines.join('\n')}\n`;
  }

  /**
   * The settings, in German, for the day this program is gone and only the
   * folder is left. What is NOT applied on import is marked right here, so the
   * document cannot promise a restore it does not perform.
   */
  function configDoc(snapshot, at) {
    if (!snapshot) return null;
    const parts = [frontMatter({ type: 'config', kind: 'einstellungen', created: at })];
    parts.push('# Einstellungen\n');
    parts.push('Diese Werte werden beim Import uebernommen — mit den unten ausdruecklich '
      + 'genannten Ausnahmen, die zur Sicherheit nur gemeldet und nicht gesetzt werden.\n');

    const n = snapshot.network || {};
    parts.push('## Netz\n');
    parts.push(`- Netzmodus in dieser Sicherung: **${n.mode ?? 'unbekannt'}** — wird beim Import NICHT gesetzt, sondern gemeldet.`);
    parts.push(`- Strenge Positivliste: ${n.strictAllowlist === null ? 'unbekannt' : yesNo(n.strictAllowlist)}`);
    parts.push(`- Erlaubte Ziele: ${(n.allowHosts || []).length ? n.allowHosts.join(', ') : 'keine'}`);
    parts.push(`- Gesperrte Ziele: ${(n.blockHosts || []).length ? n.blockHosts.join(', ') : 'keine'}`);
    parts.push(`- Netzprotokoll: ${n.audit === null ? 'unbekannt' : yesNo(n.audit)}\n`);

    const m = snapshot.models || {};
    parts.push('## Modelle\n');
    for (const provider of m.providers || []) {
      parts.push(`- Lokal: \`${provider.id}\` (${provider.kind}) unter ${provider.baseUrl} — ${provider.enabled === false ? 'aus' : 'an'}`);
    }
    for (const provider of m.remote || []) {
      parts.push(`- Entfernt: \`${provider.id}\` (${provider.kind}) unter ${provider.baseUrl} — Schluessel aus der Umgebungsvariablen \`${provider.apiKeyEnv || 'nicht gesetzt'}\`, ${provider.enabled === false ? 'aus' : 'an'}`);
    }
    if (!(m.providers || []).length && !(m.remote || []).length) parts.push('- Keine Anbieter eingerichtet.');
    parts.push(`- Standardmodell: ${m.default ? JSON.stringify(m.default) : 'keines festgelegt'}\n`);

    const u = snapshot.ui || {};
    parts.push('## Oberflaeche\n');
    parts.push(`- Erscheinungsbild: ${u.theme ?? 'unbekannt'}`);
    parts.push(`- Dichte: ${u.density ?? 'unbekannt'}`);
    parts.push(`- Bewegung reduzieren: ${u.reduceMotion === null ? 'unbekannt' : yesNo(u.reduceMotion)}`);
    parts.push(`- Sprache: ${u.locale ?? 'unbekannt'}\n`);

    const sec = snapshot.security || {};
    parts.push('## Sicherheit\n');
    parts.push(`- Vault war verschluesselt: ${yesNo(sec.encryption && sec.encryption.enabled)} — wird beim Import NICHT gesetzt (das Schluesselmaterial bleibt auf dem alten Geraet).`);
    parts.push(`- Freigabe im lokalen Netz: ${yesNo(sec.sharing && sec.sharing.enabled)} — wird beim Import NICHT gesetzt.`);
    parts.push(`- Nachfragen vor jeder Agenten-Aktion: ${yesNo(sec.globalApprovalOverride)}\n`);

    const ag = snapshot.agents || {};
    const hist = snapshot.history || {};
    parts.push('## Grenzen\n');
    parts.push(`- Gleichzeitige Agentenlaeufe: ${ag.maxConcurrentRuns ?? 'unbekannt'}`);
    parts.push(`- Schritte je Lauf: ${ag.defaultMaxSteps ?? 'unbekannt'}`);
    parts.push(`- Sekunden je Lauf: ${ag.defaultMaxSeconds ?? 'unbekannt'}`);
    parts.push(`- Aenderungsverlauf: hoechstens ${hist.maxEntries ?? 'unbekannt'} Eintraege / ${hist.maxDays ?? 'unbekannt'} Tage\n`);
    return parts.join('\n');
  }

  /**
   * The cover sheet. It has one job beyond listing what is inside: to say what
   * is NOT inside, and why. A backup that quietly omits things is worse than
   * one that omits them loudly, because only the loud one can be planned
   * around.
   *
   * When the export is sealed, this page stays in the clear -- somebody has to
   * be able to tell what the folder is -- but it drops the per-type counts and
   * the attachment list. A sealed export whose cover sheet announces "47
   * Notizen, Bericht-Steuerpruefung.pdf" has given away most of what mattered.
   */
  function indexDoc(info) {
    const { counts, fileEntries, deletedCount, at, withheld, sealed, journal, config } = info;
    const parts = [frontMatter({
      type: 'index', kind: EXPORT_KIND, created: at, version: EXPORT_VERSION, sealed: Boolean(sealed),
    })];
    parts.push('# Neural-OS-Export\n');
    parts.push(`Erstellt am ${germanDateTime(at)}.\n`);

    if (sealed) {
      parts.push('> **Verschluesselt.** Der Inhalt liegt in `' + SEALED_FILE + '` und ist mit einer '
        + 'eigenen Passphrase gesichert — nicht mit der des Tresors. `' + KEYS_FILE + '` enthaelt nur '
        + 'den verpackten Schluessel; ohne die Passphrase oeffnet ihn niemand, auch dieses Programm nicht.\n');
      parts.push('> **Es gibt keine Wiederherstellung fuer eine vergessene Passphrase.** '
        + 'Bewahre sie getrennt von diesem Ordner auf.\n');
      parts.push('Die lesbaren Markdown-Dateien entfallen in diesem Modus: sie wuerden den Inhalt '
        + 'genau daneben im Klartext hinlegen und die Passphrase damit wertlos machen.\n');
    } else {
      parts.push('> **Achtung: Dieser Ordner liegt im Klartext.** Jeder, der ihn lesen kann, liest '
        + 'damit saemtliche Notizen, Chats und Dateien — auch dann, wenn der Tresor selbst '
        + 'verschluesselt ist. Die Dateirechte stehen auf 0600/0700, das schuetzt aber nur auf '
        + 'diesem Rechner: eine Kopie auf einem USB-Stick, in einer Cloud oder in einem Mail-Anhang '
        + 'ist ungeschuetzt.\n');
      parts.push('> Ein Export kann mit einer **eigenen Passphrase** verschluesselt werden (beim '
        + 'Export anzugeben). Das ist bewusst nicht die Voreinstellung: eine vergessene Passphrase '
        + 'macht die Sicherung endgueltig wertlos, und das waere der groessere Schaden.\n');
    }

    if (!sealed) {
      parts.push('## Inhalt\n');
      for (const type of schema.TYPES) {
        if (!counts[type]) continue;
        parts.push(`- ${typeLabel(type)}: ${counts[type]}`);
      }
      parts.push('');
      if (deletedCount) {
        parts.push(`_${deletedCount} geloeschte Eintraege sind nur in \`${EXPORT_FILE}\` enthalten, nicht in den Markdown-Dateien._\n`);
      }
    }

    parts.push('## Was NICHT mitreist\n');
    const withheldTokens = (withheld && withheld.token) || 0;
    parts.push(`- **Zugangstoken** (${withheldTokens ? `${withheldTokens} Stueck` : 'in diesem Tresor gab es keine'}): `
      + 'Sie enthalten Hash, Salt, Selektor und '
      + 'die Ableitungsparameter fuer den Zugang ueber das lokale Netz. Das ist Pruefmaterial fuer '
      + 'eine Tuer an genau diesem Geraet — Zugangsdaten, kein Wissen. Wer eine Sicherung '
      + 'weitergibt, soll damit nicht die Tuer weitergeben. Neue Token werden auf dem neuen Geraet '
      + 'angelegt.');
    parts.push('- **Das Zugangstoken gekoppelter Geraete** (`peer`): Es wird beim Abgleich an das '
      + 'andere Geraet zurueckgespielt, ist also der Schluessel selbst. Das Geraet selbst steht in '
      + 'der Sicherung, die Kopplung wird neu bestaetigt.');
    parts.push('- **Das Netzprotokoll** (`audit.jsonl`): Es haelt fest, was DIESER Rechner im Netz '
      + 'versucht hat. Auf einen anderen Rechner gespielt wuerden zwei Geraetegeschichten zu einer '
      + 'Datei verschmelzen, und genau das, was die Netzansicht beweisen koennen muss, waere nicht '
      + 'mehr lesbar.');
    parts.push('- **Adresse und Port des Servers**: Wo dieses Programm horcht, ist eine Eigenschaft '
      + 'des Rechners, nicht des Wissens.');
    parts.push('- **Das Schluesselmaterial des Tresors** (`secrets.json`): Es bleibt auf dem Geraet. '
      + 'Eine Sicherung, die es mitnimmt, ist keine Sicherung mehr, sondern ein Generalschluessel.\n');

    parts.push('## Was mitreist, aber leicht uebersehen wird\n');
    parts.push(`- **Die Einstellungen**: ${config ? 'Netz-Regeln, Modelle (auch entfernte, nur mit dem Namen der Umgebungsvariablen, nie mit einem Schluessel), Oberflaeche, Agenten- und Verlaufsgrenzen.' : 'nicht vorhanden.'} `
      + 'Der **Netzmodus** wird beim Import ausdruecklich NICHT gesetzt, sondern gemeldet: eine '
      + 'Sicherung aus einem Geraet mit Netzzugang darf ein bewusst offline gehaltenes Geraet nicht '
      + 'stillschweigend oeffnen.');
    parts.push(`- **Der Aenderungsverlauf** (\`vault/${HISTORY_FILE}\`, ${anzahl(journal.lines, 'Eintrag', 'Eintraege')}): `
      + 'Er gehoert zum Wissensstand — es ist die Spur der eigenen Bearbeitungen.'
      + (journal.sealed ? ` Verschluesselt und daher nicht mitgenommen: ${anzahl(journal.sealed, 'Zeile', 'Zeilen')} — der Tresorschluessel liegt nicht bei der Sicherung.` : ''));
    parts.push('- **Netz-Freigaben** (`grant`): Sie sind die Richtlinie des Nutzers, was erreicht '
      + 'werden darf, und oeffnen von sich aus nichts.');
    parts.push('- **Geloeschte Eintraege** als Grabsteine, damit eine Wiederherstellung nicht '
      + 'aufraeumt, was bewusst weggeraeumt wurde.\n');

    parts.push('## Wiederherstellung\n');
    if (sealed) {
      parts.push(`Die Datei \`${SEALED_FILE}\` ist die vollstaendige Sicherung. Beim Import dieses `
        + 'Ordners wird nach der Passphrase gefragt.\n');
    } else {
      parts.push(`Die Datei \`${EXPORT_FILE}\` ist die vollstaendige, maschinenlesbare Sicherung. `
        + 'Die Markdown-Dateien sind zum Lesen gedacht und werden beim Import nicht ausgewertet.\n');
    }

    if (!sealed && fileEntries.length) {
      const regular = fileEntries.filter((f) => !f.orphan);
      const orphans = fileEntries.filter((f) => f.orphan);
      if (regular.length) {
        parts.push('## Angehaengte Dateien\n');
        for (const f of regular) {
          parts.push(`- [${f.name}](${f.path}) — ${f.size} Bytes, \`sha256:${f.hash.slice(0, 16)}…\``);
        }
        parts.push('');
      }
      if (orphans.length) {
        parts.push('## Inhalte ohne Datei-Eintrag\n');
        parts.push(`${orphans.length} Datei(en) liegen im Tresor, ohne dass ein Eintrag auf sie zeigt. `
          + 'Sie reisen trotzdem mit — verlorene Eintraege lassen sich wiederherstellen, verlorene '
          + 'Inhalte nicht.\n');
        for (const f of orphans) {
          parts.push(`- [${f.name}](${f.path}) — ${f.size} Bytes, \`sha256:${f.hash.slice(0, 16)}…\``);
        }
        parts.push('');
      }
    }
    return parts.join('\n');
  }

  // ----------------------------------------------------------------- export

  function exportFiles(records, writer, seal) {
    /** @type {Array<{hash:string, path:string, name:string, mime:string, size:number, orphan?:boolean}>} */
    const out = [];
    if (!store.files || typeof store.files.read !== 'function') return out;
    const seen = new Map();

    /** @returns {Buffer|null} */
    const load = (hash, what) => {
      try {
        if (typeof store.files.has === 'function' && !store.files.has(hash)) {
          log.warn(`Blob ${hash} fehlt im Vault, ${what} wird ohne Inhalt exportiert`);
          return null;
        }
        const buf = store.files.read(hash);
        return Buffer.isBuffer(buf) ? buf : null;
      } catch (err) {
        // A missing blob must not abort the backup: exporting everything else
        // is far more valuable than failing on one damaged attachment.
        log.warn(`Blob ${hash} nicht lesbar (${err.message}); Export laeuft ohne diese Datei weiter`);
        return null;
      }
    };

    const put = (rel, buf, entry) => {
      // Sealed attachments get `.enc` so the folder never lies about what is
      // inside a file. The entry keeps the PLAINTEXT hash: it is the content
      // address the records point at, and the import verifies against it after
      // decrypting.
      const target = seal ? `${rel}.enc` : rel;
      writer.write(target, seal ? seal(buf) : buf);
      const full = { ...entry, path: target, size: buf.length };
      seen.set(entry.hash, full);
      out.push(full);
    };

    for (const record of records) {
      if (record.type !== 'file') continue;
      const d = record.data || {};
      const hash = typeof d.hash === 'string' && d.hash ? d.hash : null;
      if (!hash || seen.has(hash)) continue;
      const buf = load(hash, `Datei-Record ${record.id}`);
      if (!buf) continue;
      // Human-readable name + hash prefix: navigable in a file manager, still
      // unique, and the manifest carries the exact path so import never guesses.
      const rawName = String(d.name || 'datei');
      const stem = path.basename(rawName, path.extname(rawName));
      put(`files/${slugify(stem, 'datei')}-${hash.slice(0, 8)}${safeExt(rawName)}`, buf, {
        hash,
        name: String(d.name || 'datei'),
        mime: String(d.mime || 'application/octet-stream'),
      });
    }

    // Blobs that no `file` record points at. They used to fall out of the
    // export without a word, which is the one thing a backup may never do with
    // bytes it can still read: a lost record is recoverable, lost content is
    // not. They travel under an honest name and are counted in the result and
    // in INDEX.md, so nobody mistakes them for regular attachments.
    for (const hash of allBlobHashes()) {
      if (seen.has(hash)) continue;
      const buf = load(hash, `verwaister Blob ${hash.slice(0, 8)}`);
      if (!buf) continue;
      put(`files/ohne-eintrag-${hash.slice(0, 12)}.bin`, buf, {
        hash,
        name: `ohne-eintrag-${hash.slice(0, 12)}.bin`,
        mime: 'application/octet-stream',
        orphan: true,
      });
    }
    return out;
  }

  function writeMarkdown(records, writer, fileEntries, at, extra = {}) {
    const grouped = byType(live(records));
    const notes = grouped.get('note') || [];
    const chats = grouped.get('chat') || [];
    const messages = grouped.get('message') || [];
    const projects = grouped.get('project') || [];
    const tasks = grouped.get('task') || [];
    const agents = grouped.get('agent') || [];

    for (const note of notes) {
      writer.write(path.join('notes', `${recordSlug(note, (note.data || {}).title, 'notiz')}.md`), noteDoc(note));
    }

    const byChat = new Map();
    for (const m of messages) {
      const chatId = (m.data || {}).chatId;
      if (!chatId) continue;
      if (!byChat.has(chatId)) byChat.set(chatId, []);
      byChat.get(chatId).push(m);
    }
    for (const chat of chats) {
      writer.write(path.join('chats', `${recordSlug(chat, (chat.data || {}).title, 'chat')}.md`), chatDoc(chat, byChat.get(chat.id) || []));
    }

    const projectNames = new Map(projects.map((p) => [p.id, (p.data || {}).name || '']));
    const taskPaths = new Map();
    for (const task of tasks) {
      const rel = path.join('tasks', `${recordSlug(task, (task.data || {}).title, 'aufgabe')}.md`);
      taskPaths.set(task.id, rel.split(path.sep).join('/'));
      writer.write(rel, taskDoc(task, projectNames.get((task.data || {}).projectId) || null));
    }
    for (const project of projects) {
      const own = tasks.filter((t) => (t.data || {}).projectId === project.id);
      writer.write(path.join('projects', `${recordSlug(project, (project.data || {}).name, 'projekt')}.md`), projectDoc(project, own, taskPaths));
    }
    for (const agent of agents) {
      writer.write(path.join('agents', `${recordSlug(agent, (agent.data || {}).name, 'agent')}.md`), agentDoc(agent));
    }

    // Alles, was bisher nur in export.json stand. Wer im Notfall die Dateien
    // oeffnet, soll auch seine Automatik, seine Netz-Freigaben und sein
    // Gelerntes finden, nicht nur Notizen und Chats.
    const agentNames = new Map(agents.map((a) => [a.id, (a.data || {}).name || '']));
    const list = (type) => grouped.get(type) || [];

    writer.write(path.join('automatik', 'zeitplaene.md'), listDoc({
      title: 'Zeitplaene', type: 'schedule',
      intro: 'Agenten, die nach der Uhr laufen. Ein Zeitplan, der hier als "aus" steht, laeuft nach einer Wiederherstellung auch nicht an.',
      empty: 'Keine Zeitplaene eingerichtet.',
    }, list('schedule'), (r) => scheduleRow(r, agentNames), at));

    writer.write(path.join('automatik', 'ausloeser.md'), listDoc({
      title: 'Ausloeser', type: 'trigger',
      intro: 'Agenten, die auf ein Ereignis reagieren.',
      empty: 'Keine Ausloeser eingerichtet.',
    }, list('trigger'), (r) => triggerRow(r, agentNames), at));

    writer.write(path.join('automatik', 'beobachtete-ordner.md'), listDoc({
      title: 'Beobachtete Ordner', type: 'watch',
      intro: 'Ordner, aus denen Dateien aufgenommen werden. Die Pfade gelten fuer das alte Geraet und muessen auf einem neuen geprueft werden.',
      empty: 'Keine beobachteten Ordner.',
    }, list('watch'), watchRow, at));

    writer.write(path.join('netz', 'freigaben.md'), listDoc({
      title: 'Netz-Freigaben', type: 'grant',
      intro: 'Was erreicht werden darf. Eine Freigabe oeffnet von sich aus nichts — sie gilt erst innerhalb des eingestellten Netzmodus.',
      empty: 'Keine Netz-Freigaben erteilt.',
    }, list('grant'), grantRow, at));

    writer.write(path.join('netz', 'geraete.md'), listDoc({
      title: 'Gekoppelte Geraete', type: 'peer',
      intro: 'Andere Rechner, mit denen abgeglichen wird. Die Zugangstoken reisen nicht mit.',
      empty: 'Keine gekoppelten Geraete.',
    }, list('peer'), peerRow, at));

    writer.write(path.join('wissen', 'erinnerungen.md'), listDoc({
      title: 'Erinnerungen', type: 'memory',
      intro: 'Was sich das System ueber dich gemerkt hat.',
      empty: 'Keine Erinnerungen gespeichert.',
    }, list('memory'), memoryRow, at));

    writer.write(path.join('wissen', 'entitaeten.md'), listDoc({
      title: 'Entitaeten', type: 'entity',
      intro: 'Personen, Orte und Dinge, die aus den Notizen erkannt wurden.',
      empty: 'Keine Entitaeten erkannt.',
    }, list('entity'), entityRow, at));

    // Bewusst NICHT unter agents/: dort liegt eine Datei je Agent, und eine
    // Liste dazwischen liest sich wie ein Agent namens "Laeufe".
    writer.write('agentenlaeufe.md', listDoc({
      title: 'Agentenlaeufe', type: 'run',
      intro: 'Was Agenten getan haben.',
      empty: 'Keine Agentenlaeufe aufgezeichnet.',
    }, list('run'), (r) => runRow(r, agentNames), at));

    const cfgDoc = configDoc(extra.config, at);
    if (cfgDoc) writer.write('konfiguration.md', cfgDoc);

    const counts = {};
    for (const [type, list2] of byType(records)) counts[type] = list2.length;
    const deletedCount = records.length - live(records).length;
    writer.write('INDEX.md', indexDoc({
      counts,
      fileEntries,
      deletedCount,
      at,
      withheld: extra.withheld || {},
      sealed: false,
      journal: extra.journal || { lines: 0, sealed: 0 },
      config: extra.config || null,
    }));
  }

  // ----------------------------------------------------------------- import

  function parsePayload(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ValidationError(`Sicherungsdatei ist kein gueltiges JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new ValidationError('Sicherungsdatei enthaelt kein Objekt.');
    if (parsed.kind !== EXPORT_KIND) throw new ValidationError(`Unbekanntes Sicherungsformat: ${parsed.kind ?? 'ohne Kennung'}`);
    if (!SUPPORTED_EXPORT_VERSIONS.includes(parsed.v)) {
      throw new ValidationError(`Nicht unterstuetzte Sicherungsversion: ${parsed.v}`);
    }
    if (!Array.isArray(parsed.records)) throw new ValidationError('Sicherungsdatei enthaelt keine Record-Liste.');
    return parsed;
  }

  function readPayload(source) {
    let raw;
    try {
      raw = fs.readFileSync(source, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new ValidationError(`Sicherungsdatei nicht gefunden: ${source}`);
      throw new StorageError(`Sicherungsdatei ist nicht lesbar: ${err.message}`);
    }
    return parsePayload(raw);
  }

  /** Which file in this folder is the payload, and is it sealed? */
  function locateExport(dir, file) {
    if (file) {
      const abs = path.resolve(file);
      return { file: abs, sealed: abs.endsWith('.enc'), dir: dir || path.dirname(abs) };
    }
    const plain = path.join(dir, EXPORT_FILE);
    if (fs.existsSync(plain)) return { file: plain, sealed: false, dir };
    const sealed = path.join(dir, SEALED_FILE);
    if (fs.existsSync(sealed)) return { file: sealed, sealed: true, dir };
    // Neither is there: point at the expected name so the error names the
    // file the user was looking for.
    return { file: plain, sealed: false, dir };
  }

  /**
   * @returns {Promise<{payload:object, unseal:((b:Buffer)=>Buffer)|null}>}
   */
  async function openExport(loc, passphrase) {
    if (!loc.sealed) return { payload: readPayload(loc.file), unseal: null };
    const keysPath = path.join(loc.dir || path.dirname(loc.file), KEYS_FILE);
    if (!fs.existsSync(keysPath)) {
      throw new ValidationError(
        `Zu dieser verschluesselten Sicherung fehlt ${KEYS_FILE}. Ohne diese Datei laesst sie sich `
        + 'nicht mehr oeffnen — auch nicht mit der richtigen Passphrase.',
      );
    }
    if (typeof passphrase !== 'string' || !passphrase) {
      throw new ValidationError('Diese Sicherung ist mit einer eigenen Passphrase verschluesselt. Bitte die Passphrase angeben.');
    }
    const crypt = exportCrypto(keysPath);
    // Falsche Passphrase kommt hier als LockedError heraus -- ein anderer
    // Fehler als "Datei kaputt", und genau das soll der Mensch auch lesen.
    await crypt.unlock(passphrase);
    let raw;
    try {
      raw = fs.readFileSync(loc.file);
    } catch (err) {
      throw new StorageError(`Sicherungsdatei ist nicht lesbar: ${err.message}`);
    }
    const plain = crypt.decryptBuffer(raw);
    return { payload: parsePayload(plain.toString('utf8')), unseal: (buf) => crypt.decryptBuffer(buf) };
  }

  /**
   * Counts tombstones as content. A vault holding only soft-deleted records is
   * not empty -- `store.count()` would call it empty and the import would then
   * collide with every id it tried to restore.
   */
  function remainingRecords() {
    let n = 0;
    for (const type of schema.TYPES) n += listPage(type, 0).total || 0;
    return n;
  }

  /**
   * Envelope hints are passed as create options. `opts.id` is contracted; the
   * timestamp/rev hints are additive, so an engine that ignores them still
   * produces a correct restore -- only createdAt and rev are then regenerated.
   */
  function createFromEnvelope(rec) {
    return store.create(rec.type, rec.data, {
      id: rec.id,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      rev: rec.rev,
      deletedAt: rec.deletedAt,
    });
  }

  function restoreOne(rec, mode, result) {
    const existing = typeof store.get === 'function' ? store.get(rec.id, { includeDeleted: true }) : null;
    if (existing) {
      if (mode === 'merge') {
        result.skipped++;
        result.conflicts.push({ id: rec.id, type: rec.type, reason: 'existiert bereits, behalten' });
        return;
      }
      if (mode === 'fresh' || mode === 'restore') {
        // `fresh` wurde vorher geprueft, `restore` hat vorher alles geloescht.
        // Hier zu landen heisst: der Tresor hat sich unter uns veraendert.
        throw new StorageError(`Der Vault ist nicht mehr leer (${rec.id} existiert bereits).`);
      }
      // 'replace': a hard purge plus recreate is the only way through the
      // contracted API to drop keys that the incoming record no longer has.
      // Note the cost: the engine cascades a hard purge to that record's
      // edges, so an edge that exists only locally and is not in the backup
      // disappears with it. That is what the user asked for by choosing
      // 'replace', but it is worth knowing before choosing it.
      store.remove(rec.id, { hard: true });
      result.conflicts.push({ id: rec.id, type: rec.type, reason: 'ersetzt' });
    }
    const created = createFromEnvelope(rec);
    // Re-tombstone if the engine ignored the deletedAt hint, so a restored
    // vault has the same visible contents as the exported one.
    if (rec.deletedAt && created && !created.deletedAt && typeof store.remove === 'function') {
      store.remove(rec.id);
    }
    result.imported++;
  }

  function importFiles(payload, dir, result, unseal) {
    if (!Array.isArray(payload.files) || !payload.files.length) return;
    if (!store.files || typeof store.files.put !== 'function') {
      result.errors.push({ id: null, reason: 'Der Store unterstuetzt keine Dateiablage; Anhaenge wurden uebersprungen.' });
      return;
    }
    if (!dir) {
      result.errors.push({ id: null, reason: 'Ohne Verzeichnis koennen keine Anhaenge eingelesen werden (nur export.json angegeben).' });
      return;
    }
    for (const entry of payload.files) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.hash !== 'string') continue;
      try {
        if (typeof store.files.has === 'function' && store.files.has(entry.hash)) {
          result.filesSkipped++;
          continue;
        }
        const abs = safeJoin(dir, entry.path);
        const raw = fs.readFileSync(abs);
        // Sealed attachments carry the PLAINTEXT hash in the manifest, so the
        // check below still proves the content, not the packaging.
        const buf = entry.path.endsWith('.enc') && unseal ? unseal(raw) : raw;
        const actual = sha256(buf);
        if (actual !== entry.hash) {
          // Importing content that does not match its address would poison the
          // content-addressed store for every record referencing that hash.
          result.errors.push({ id: entry.hash, reason: `Pruefsumme von ${entry.path} stimmt nicht (${actual.slice(0, 12)} statt ${entry.hash.slice(0, 12)})` });
          continue;
        }
        store.files.put(buf, { name: entry.name, mime: entry.mime });
        result.files++;
        if (entry.orphan) result.orphanFiles++;
      } catch (err) {
        result.errors.push({ id: entry.hash, reason: `Anhang ${entry.path} konnte nicht eingelesen werden: ${err.message}` });
      }
    }
  }

  /**
   * Apply the settings from the backup -- minus the ones that would change a
   * security posture nobody agreed to on THIS machine.
   *
   * The network mode is the clear case and the reason this split exists: a
   * backup taken while the old device was online must not silently open a new
   * device that is deliberately kept offline. It is handed back in the result
   * so the surface can ask ("in der Sicherung stand: lan"). LAN sharing would
   * open a port, and the encryption flag without the key material on this
   * machine would tell a plaintext vault it is ciphertext -- which is how a
   * vault stops being readable. Both follow the same rule.
   */
  function applyConfig(payload, result) {
    const incoming = payload.config;
    result.config = { applied: [], reported: [], persisted: false, message: '' };
    const currentMode = (config && config.network && config.network.mode) || null;
    result.networkMode = {
      inBackup: null,
      current: currentMode,
      applied: false,
      message: 'Die Sicherung nennt keinen Netzmodus.',
    };
    if (!incoming || typeof incoming !== 'object') {
      result.config.message = 'Diese Sicherung enthaelt keine Einstellungen (aeltere Fassung). Es wurde nichts geaendert.';
      return;
    }
    const inNet = incoming.network || {};
    if (inNet.mode) {
      result.networkMode.inBackup = inNet.mode;
      result.networkMode.message = inNet.mode === currentMode
        ? `In der Sicherung stand: ${inNet.mode}. Dieses Geraet steht bereits darauf.`
        : `In der Sicherung stand: ${inNet.mode}. Dieses Geraet bleibt auf ${currentMode || 'offline'} — `
          + 'der Netzmodus wird aus einer Sicherung nicht gesetzt, weil das eine Sicherheitsentscheidung '
          + 'dieses Geraets ist. Umstellen laesst er sich unter Netzwerk.';
    }
    for (const [key, why] of REPORTED_ONLY) {
      result.config.reported.push({ key, value: valueAt(incoming, key), reason: why });
    }
    if (!config || typeof config !== 'object') {
      result.config.message = 'Ohne Konfigurationsobjekt konnten die Einstellungen nicht uebernommen werden.';
      return;
    }

    const patch = {};
    const applied = [];
    const netPatch = {};
    for (const key of ['strictAllowlist', 'allowHosts', 'blockHosts', 'audit']) {
      if (inNet[key] !== undefined && inNet[key] !== null) {
        netPatch[key] = inNet[key];
        applied.push(`network.${key}`);
      }
    }
    if (Object.keys(netPatch).length) patch.network = netPatch;
    for (const section of ['models', 'ui', 'agents', 'history']) {
      if (incoming[section] && typeof incoming[section] === 'object') {
        patch[section] = incoming[section];
        applied.push(section);
      }
    }
    const inSec = incoming.security || {};
    if (typeof inSec.globalApprovalOverride === 'boolean') {
      // Der einzige Sicherheitsschalter, der mitreist: er macht das System
      // strenger, nie durchlaessiger.
      patch.security = { globalApprovalOverride: inSec.globalApprovalOverride };
      applied.push('security.globalApprovalOverride');
    }
    if (!applied.length) {
      result.config.message = 'Die Sicherung enthielt keine uebernehmbaren Einstellungen.';
      return;
    }

    const next = configMod.deepMerge(config, patch);
    try {
      configMod.validateConfig(next);
    } catch (err) {
      result.errors.push({ id: null, reason: `Die Einstellungen aus der Sicherung sind ungueltig und wurden nicht uebernommen: ${err.message}` });
      result.config.message = 'Die Einstellungen wurden verworfen, weil sie ungueltig sind.';
      return;
    }
    if (typeof paths.config === 'string') {
      try {
        configMod.save(paths.config, next);
        result.config.persisted = true;
      } catch (err) {
        result.errors.push({ id: null, reason: `Die Einstellungen konnten nicht gespeichert werden: ${err.message}` });
      }
    }
    // Das laufende Programm haelt genau dieses Objekt -- ohne die Zuweisung
    // stimmt die Datei auf der Platte, der laufende Prozess aber nicht.
    Object.assign(config, next);
    result.config.applied = applied;
    result.config.message = `${applied.length} Einstellungsbereich(e) uebernommen. `
      + 'Die Oberflaeche zeigt sie nach dem naechsten Laden.';
  }

  function valueAt(obj, dotted) {
    let cur = obj;
    for (const part of dotted.split('.')) {
      if (!cur || typeof cur !== 'object') return null;
      cur = cur[part];
    }
    return cur === undefined ? null : cur;
  }

  /**
   * Say out loud whether this vault is encrypted.
   *
   * Without this the user sees "88 Eintraege uebernommen", believes the state
   * is restored, and does not notice that the door is open: key material never
   * travels in a backup, so a restore onto a fresh machine always lands in a
   * plaintext vault until somebody turns encryption on again.
   */
  function reportEncryption(payload, result) {
    const here = typeof store.encrypted === 'boolean'
      ? store.encrypted
      : Boolean(config && config.security && config.security.encryption && config.security.encryption.enabled);
    const there = payload.vault && typeof payload.vault.encrypted === 'boolean' ? payload.vault.encrypted : null;
    result.encryption = { here, inBackup: there, message: '' };
    if (here) {
      result.encryption.message = 'Dieser Tresor ist verschluesselt.';
      return;
    }
    if (there === true) {
      result.encryption.message = 'Achtung: Der gesicherte Tresor war verschluesselt, dieser hier ist es NICHT. '
        + 'Die wiederhergestellten Inhalte liegen auf dieser Platte im Klartext. Das Schluesselmaterial '
        + 'reist nie mit einer Sicherung — die Verschluesselung muss unter Einstellungen neu '
        + 'eingeschaltet werden.';
      result.warnings.push(result.encryption.message);
      return;
    }
    if (there === false) {
      // Nichts hat sich verschlechtert: die Tuer stand vorher schon offen.
      // Es steht im Ergebnis, aber es ist keine Warnung.
      result.encryption.message = 'Dieser Tresor ist nicht verschluesselt; die Sicherung war es auch nicht.';
      return;
    }
    result.encryption.message = 'Dieser Tresor ist nicht verschluesselt. Ob die Sicherung es war, sagt sie nicht.';
    result.warnings.push(result.encryption.message);
  }

  /**
   * Put the change journal back.
   *
   * Only into an empty journal, and never into an encrypted vault. Both limits
   * come from the same place: `history.js` owns this file, keeps its entries in
   * memory and rewrites the whole file from memory when it trims. Lines
   * appended behind its back would then disappear without a word, and lines
   * written in the clear next to an encrypted vault would be exactly the
   * plaintext leak the encryption exists to prevent. Where it cannot be done,
   * it is said -- not skipped quietly.
   */
  function importHistory(payload, result, mode) {
    const entries = payload.history && Array.isArray(payload.history.entries) ? payload.history.entries : [];
    const sealedInBackup = (payload.history && Number(payload.history.sealed)) || 0;
    result.history = { inBackup: entries.length, written: 0, message: '' };
    if (!entries.length) {
      result.history.message = sealedInBackup
        ? `Der Aenderungsverlauf der Sicherung war verschluesselt (${sealedInBackup} Zeilen) und konnte nicht mitgenommen werden.`
        : 'Die Sicherung enthaelt keinen Aenderungsverlauf.';
      if (sealedInBackup) result.warnings.push(result.history.message);
      return;
    }
    if (typeof paths.vault !== 'string') {
      result.history.message = 'Ohne Tresorverzeichnis kann der Aenderungsverlauf nicht abgelegt werden.';
      result.warnings.push(result.history.message);
      return;
    }
    const encryptedHere = typeof store.encrypted === 'boolean'
      ? store.encrypted
      : Boolean(config && config.security && config.security.encryption && config.security.encryption.enabled);
    if (encryptedHere) {
      result.history.message = `Der Aenderungsverlauf (${entries.length} Eintraege) wurde NICHT eingespielt: `
        + 'dieser Tresor ist verschluesselt, und die Sicherung wuerde ihn im Klartext daneben ablegen.';
      result.warnings.push(result.history.message);
      return;
    }
    const file = path.join(paths.vault, HISTORY_FILE);
    let vorhanden = 0;
    try {
      vorhanden = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
    } catch { /* noch keiner da: genau der Fall, fuer den das hier gedacht ist */ }
    // Bei `restore` wird der vorhandene Verlauf UEBERSCHRIEBEN, und zwar aus
    // demselben Grund, aus dem der Modus ueberhaupt existiert: die Saetze, die
    // er beschreibt, sind gerade geloescht worden. Ein Journal, das Aenderungen
    // an Eintraegen auffuehrt, die es nicht mehr gibt, ist kein Verlauf mehr,
    // sondern eine Liste toter Verweise. Bei jedem anderen Modus bleibt er
    // stehen -- dort liegen die beschriebenen Saetze ja noch da.
    if (vorhanden && mode !== 'restore') {
      result.history.message = `Der Aenderungsverlauf (${entries.length} Eintraege) wurde NICHT eingespielt: `
        + `auf diesem Geraet stehen bereits ${vorhanden} Eintraege darin, und zwei Verlaeufe lassen sich `
        + 'nicht zusammenfuehren, ohne die Reihenfolge zu erfinden.';
      result.warnings.push(result.history.message);
      return;
    }
    try {
      fs.mkdirSync(paths.vault, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
      // `mode` greift nur beim Anlegen. Lag dort schon eine leere Datei mit
      // weiteren Rechten, stuende der halbe Verlauf des Nutzers offen.
      try { fs.chmodSync(file, 0o600); } catch { /* exFAT & Co. kennen keine Modi */ }
      result.history.written = entries.length;
      result.history.replaced = vorhanden;
      result.history.message = `${entries.length} Eintraege des Aenderungsverlaufs eingespielt`
        + (vorhanden ? ` und die ${vorhanden} Zeilen dieses Geraets dabei ersetzt` : '')
        + '. Sichtbar werden sie nach einem Neustart des Programms.';
    } catch (err) {
      result.history.message = `Der Aenderungsverlauf konnte nicht geschrieben werden: ${err.message}`;
      result.errors.push({ id: null, reason: result.history.message });
    }
  }

  /**
   * Edges that exist here and are NOT in the backup, so `replace` can put them
   * back.
   *
   * `replace` hard-purges a record before recreating it, and the engine
   * cascades that purge to the record's edges. A connection the user drew on
   * THIS machine after the backup was taken -- or one the graph derived here --
   * would vanish as collateral damage of restoring an unrelated note. The edges
   * are therefore taken down before the purge and re-created afterwards, with
   * their own ids and timestamps.
   */
  function localOnlyEdges(incomingIds) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES_PER_TYPE; page++) {
      const { items, total } = listPage('edge', offset);
      if (!items.length) break;
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || incomingIds.has(item.id)) continue;
        out.push(envelope(item));
      }
      offset += items.length;
      if (items.length < PAGE_SIZE) break;
      if (Number.isFinite(total) && offset >= total) break;
    }
    return out;
  }

  /**
   * Jeden Satz im Tresor aufzaehlen, Grabsteine eingeschlossen.
   *
   * Erst vollstaendig einsammeln, dann loeschen: waehrend des Loeschens weiter
   * zu blaettern wuerde die Seitengrenzen unter dem Offset wegziehen und einen
   * Teil des Tresors stehen lassen -- also genau das, was `restore` nicht darf.
   */
  function allRecordRefs() {
    const refs = [];
    for (const type of schema.TYPES) {
      let offset = 0;
      for (let page = 0; page < MAX_PAGES_PER_TYPE; page++) {
        let got;
        try {
          got = listPage(type, offset);
        } catch {
          break; // Typ, den dieser Speicher nicht kennt
        }
        if (!got.items.length) break;
        for (const item of got.items) {
          if (item && typeof item.id === 'string') refs.push({ id: item.id, type });
        }
        offset += got.items.length;
        if (got.items.length < PAGE_SIZE) break;
        if (Number.isFinite(got.total) && offset >= got.total) break;
      }
    }
    return refs;
  }

  /**
   * Alles hart loeschen. Nur fuer den Modus `restore`.
   *
   * Kanten zuerst: das harte Loeschen eines Knotens zieht seine Kanten mit,
   * und eine Kante, die dabei schon verschwunden ist, wuerde beim eigenen
   * Loeschversuch als Fehler zurueckkommen. Die Reihenfolge macht aus einem
   * erwarteten Vorgang keinen gemeldeten Fehler.
   */
  function purgeEverything(result) {
    const refs = allRecordRefs();
    const zuerst = refs.filter((r) => r.type === 'edge');
    const danach = refs.filter((r) => r.type !== 'edge');
    for (const ref of [...zuerst, ...danach]) {
      try {
        store.remove(ref.id, { hard: true });
        result.purged.records++;
        result.purged.byType[ref.type] = (result.purged.byType[ref.type] || 0) + 1;
      } catch (err) {
        // Schon weg (als Kante eines geloeschten Knotens mitgenommen) ist kein
        // Fehler. Alles andere schon -- und wird gesagt.
        if (typeof store.get === 'function' && !store.get(ref.id, { includeDeleted: true })) continue;
        result.errors.push({ id: ref.id, reason: `konnte nicht entfernt werden: ${err.message}` });
      }
    }
  }

  /**
   * Blobs wegraeumen, die in dieser Sicherung nicht vorkommen.
   *
   * Nur wenn die Sicherung ueberhaupt Anhaenge traegt: ein Export mit
   * `includeFiles:false` hat nie behauptet, Dateien zu enthalten, und darf
   * deshalb auch keine loeschen. Der Unterschied steht im Ergebnis, damit
   * niemand "Anhaenge identisch" annimmt, wo nichts geprueft wurde.
   */
  function purgeUnknownBlobs(payload, result) {
    const traegtDateien = payload.includeFiles === true
      || (Array.isArray(payload.files) && payload.files.length > 0);
    if (!traegtDateien) {
      result.purged.filesKept = allBlobHashes().length;
      result.purged.filesMessage = 'Diese Sicherung enthaelt keine Anhaenge. Vorhandene Dateiinhalte '
        + `wurden deshalb NICHT geloescht (${result.purged.filesKept} Stueck bleiben liegen).`;
      return;
    }
    if (!store.files || typeof store.files.remove !== 'function') {
      result.purged.filesMessage = 'Der Speicher kann keine Dateiinhalte entfernen; vorhandene Anhaenge bleiben liegen.';
      return;
    }
    const behalten = new Set(
      payload.files.map((f) => f && f.hash).filter((h) => typeof h === 'string'),
    );
    for (const hash of allBlobHashes()) {
      if (behalten.has(hash)) continue;
      try {
        store.files.remove(hash);
        result.purged.files++;
      } catch (err) {
        result.errors.push({ id: hash, reason: `Dateiinhalt konnte nicht entfernt werden: ${err.message}` });
      }
    }
  }

  function restoreLocalEdges(edges, result) {
    for (const edge of edges) {
      if (typeof store.get === 'function' && store.get(edge.id, { includeDeleted: true })) continue;
      try {
        createFromEnvelope(edge);
        result.edgesRestored++;
      } catch (err) {
        // Ein Endpunkt, den es nach dem Ersetzen nicht mehr gibt: die Kante
        // kann nicht zurueck. Das wird gesagt, nicht verschwiegen.
        result.conflicts.push({ id: edge.id, type: 'edge', reason: `nur lokal vorhanden und nicht wiederherstellbar: ${err.message}` });
      }
    }
  }

  // -------------------------------------------------------------- public API

  const api = {
    /**
     * @param {{dir?:string, parent?:string, format?:'json'|'markdown'|'both',
     *          includeFiles?:boolean, passphrase?:string}} [opts]
     *        `dir` ist der Ordner SELBST -- eine dort liegende aeltere Sicherung
     *        wird dabei ersetzt. `parent` ist der Ordner, IN DEM eine neue
     *        Sicherung mit Zeitstempel angelegt wird; so sammeln sich mehrere
     *        nebeneinander, statt sich gegenseitig zu ueberschreiben. Wer ein
     *        Ziel auswaehlt, meint fast immer das zweite. Ohne beides: der
     *        exports-Ordner dieses Geraets, ebenfalls mit Zeitstempel.
     *        `passphrase` verschluesselt den Export mit einem EIGENEN Schluessel
     *        (nicht dem des Tresors). Ohne Angabe bleibt der Export Klartext
     *        und sagt das auch.
     * @returns {Promise<{dir:string, files:number, records:number, bytes:number,
     *          manifest:object, sealed:boolean, withheld:object, orphanFiles:number,
     *          historyEntries:number, historySealed:number, config:object}>}
     */
    async exportAll(opts = {}) {
      const format = opts.format ?? 'both';
      if (!['json', 'markdown', 'both'].includes(format)) {
        throw new ValidationError(`Unbekanntes Exportformat: ${format}. Erlaubt sind json, markdown, both.`);
      }
      const includeFiles = opts.includeFiles !== false;
      // AUS, solange niemand ausdruecklich eine Passphrase nennt. Siehe Kopf:
      // eine vergessene Passphrase ist der groessere Schaden.
      const passphrase = typeof opts.passphrase === 'string' && opts.passphrase ? opts.passphrase : null;
      const at = new Date().toISOString();
      const stempel = `export-${at.replace(/[:.]/g, '-')}`;
      const dir = opts.dir
        ? path.resolve(opts.dir)
        : path.join(opts.parent ? path.resolve(opts.parent) : paths.exports, stempel);

      // Snapshot first, disk second: see the header note on tearing.
      const { records, withheld } = collect();
      const journal = readJournal();
      const configPart = configSnapshot(config);

      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        throw new StorageError(`Export-Verzeichnis ${dir} konnte nicht angelegt werden: ${err.message}`);
      }
      prunePrevious(dir);

      const writer = makeWriter(dir);

      /** @type {((buf:Buffer)=>Buffer)|null} */
      let seal = null;
      if (passphrase) {
        const keysPath = path.join(dir, KEYS_FILE);
        // A stale key file from an earlier sealed export would make
        // `initialise()` refuse (it never overwrites key material). Here that
        // refusal is wrong: prunePrevious already removed the ciphertext it
        // belonged to, so the old key opens nothing.
        try { fs.unlinkSync(keysPath); } catch { /* war nicht da */ }
        const crypt = exportCrypto(keysPath);
        await crypt.initialise(passphrase);
        seal = (buf) => {
          const out = crypt.encryptBuffer(buf);
          if (!Buffer.isBuffer(out)) throw new StorageError('Der Export konnte nicht verschluesselt werden.');
          return out;
        };
        try {
          writer.register(KEYS_FILE, fs.readFileSync(keysPath));
        } catch (err) {
          throw new StorageError(`Das Schluesselmaterial des Exports ist nicht lesbar: ${err.message}`);
        }
      }

      const fileEntries = includeFiles ? exportFiles(records, writer, seal) : [];
      const orphanEntries = fileEntries.filter((f) => f.orphan);

      const counts = {};
      for (const [type, list] of byType(records)) counts[type] = list.length;

      if (format === 'json' || format === 'both') {
        const payload = JSON.stringify({
          v: EXPORT_VERSION,
          kind: EXPORT_KIND,
          at,
          generator: { app: 'neural-os', version: appVersion(), node: process.version },
          // Context for whoever restores this, never anything secret.
          vault: {
            networkMode: config?.network?.mode ?? null,
            encrypted: Boolean(config?.security?.encryption?.enabled),
            sealed: Boolean(seal),
          },
          // Die Einstellungen gehoeren zum Wissensstand. Was davon beim Import
          // NICHT gesetzt wird, entscheidet der Import -- hier steht der
          // vollstaendige Stand, damit die Oberflaeche fragen kann.
          config: configPart,
          withheld,
          // Der Unterschied zwischen "keine Anhaenge im Tresor" und "Anhaenge
          // bewusst nicht mitgenommen" ist beim Wiederherstellen ein
          // Loeschbefehl oder keiner. Er muss deshalb IN der Sicherung stehen,
          // nicht nur im Manifest daneben.
          includeFiles,
          counts: {
            records: records.length,
            byType: counts,
            files: fileEntries.length,
            orphanFiles: orphanEntries.length,
            historyEntries: journal.lines.length,
          },
          files: fileEntries,
          history: { entries: journal.lines, sealed: journal.sealed, broken: journal.broken },
          records,
        }, null, 2) + '\n';
        if (seal) writer.write(SEALED_FILE, seal(Buffer.from(payload, 'utf8')));
        else writer.write(EXPORT_FILE, payload);
      }
      if (format === 'markdown' || format === 'both') {
        if (seal) {
          // Eine lesbare Fassung neben der verschluesselten waere genau die
          // Klartextkopie, die die Passphrase verhindern soll. Es bleibt das
          // Deckblatt, damit erkennbar ist, was dieser Ordner ueberhaupt ist.
          writer.write('INDEX.md', indexDoc({
            counts, fileEntries: [], deletedCount: 0, at, withheld, sealed: true, journal: { lines: journal.lines.length, sealed: journal.sealed }, config: configPart,
          }));
        } else {
          writeMarkdown(records, writer, fileEntries, at, {
            withheld,
            journal: { lines: journal.lines.length, sealed: journal.sealed },
            config: configPart,
          });
        }
      }

      const manifest = {
        v: EXPORT_VERSION,
        kind: MANIFEST_KIND,
        at,
        format,
        includeFiles,
        sealed: Boolean(seal),
        counts: {
          records: records.length,
          byType: counts,
          files: fileEntries.length,
          orphanFiles: orphanEntries.length,
          historyEntries: journal.lines.length,
          written: writer.entries.length,
        },
        // manifest.json cannot list its own hash, so it is the one file not
        // covered here; verify() reports that honestly.
        files: writer.entries.slice().sort((a, b) => a.path.localeCompare(b.path)),
      };
      const manifestBytes = writer.write(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');

      log.info(`Export nach ${dir}: ${records.length} Records, ${writer.entries.length} Dateien`
        + `${seal ? ', mit eigener Passphrase verschluesselt' : ', im Klartext'}`);
      if (withheld.token) log.info(`${withheld.token} Zugangstoken wurden bewusst nicht exportiert.`);
      if (journal.sealed) log.warn(`${journal.sealed} Zeilen des Aenderungsverlaufs sind verschluesselt und reisen nicht mit.`);
      if (orphanEntries.length) log.info(`${orphanEntries.length} Datei(en) ohne zugehoerigen Eintrag wurden mitgenommen.`);

      return {
        dir,
        files: writer.entries.length,
        records: records.length,
        bytes: writer.bytes,
        manifest,
        manifestBytes,
        // Honest extras: what the export deliberately did not take, and what
        // it took that nobody would look for.
        sealed: Boolean(seal),
        withheld,
        orphanFiles: orphanEntries.length,
        historyEntries: journal.lines.length,
        historySealed: journal.sealed,
        config: configPart,
      };
    },

    /**
     * @param {{dir?:string, file?:string, mode?:'merge'|'replace'|'fresh', passphrase?:string}} opts
     * @returns {Promise<object>} the counts, plus what the restore did NOT do
     */
    async importAll(opts = {}) {
      // Voreinstellung bleibt `merge`: der einzige Modus, der nichts wegnimmt.
      const mode = opts.mode ?? 'merge';
      if (!IMPORT_MODES.includes(mode)) {
        throw new ValidationError(`Unbekannter Importmodus: ${mode}. Erlaubt sind ${IMPORT_MODES.join(', ')}.`);
      }
      if (!opts.dir && !opts.file) throw new ValidationError('importAll benoetigt dir oder file.');
      const dir = opts.dir ? path.resolve(opts.dir) : null;
      const loc = locateExport(dir, opts.file || null);
      const { payload, unseal } = await openExport(loc, opts.passphrase);

      if (mode === 'fresh') {
        const present = remainingRecords();
        if (present > 0) {
          throw new ValidationError(
            `Modus "fresh" verlangt einen leeren Vault, es liegen aber ${present} Eintraege darin `
            + '(auch geloeschte zaehlen). Bitte "merge" oder "replace" waehlen.',
          );
        }
      }

      const result = {
        imported: 0,
        skipped: 0,
        conflicts: [],
        files: 0,
        filesSkipped: 0,
        errors: [],
        // Alles ab hier ist neu und ausschliesslich additiv: was die
        // Wiederherstellung NICHT geleistet hat, steht jetzt drin statt
        // stillschweigend zu fehlen.
        warnings: [],
        orphanFiles: 0,
        edgesRestored: 0,
        sealed: Boolean(loc.sealed),
        mode,
        // Nur `restore` raeumt vorher ab. Bei allen anderen Modi bleiben diese
        // Zahlen auf null -- und das ist dann auch die Wahrheit.
        purged: { records: 0, byType: {}, files: 0, filesKept: 0, filesMessage: null },
      };

      // Nodes before edges: an edge whose endpoint is still missing would be
      // rejected by a store that validates endpoints.
      const ordered = [
        ...payload.records.filter((r) => r && r.type !== 'edge'),
        ...payload.records.filter((r) => r && r.type === 'edge'),
      ];

      // Vor dem ersten harten Loeschen festhalten, welche Kanten es nur hier
      // gibt -- danach sind sie weg und niemand kann sie mehr zaehlen.
      const localEdges = mode === 'replace'
        ? localOnlyEdges(new Set(payload.records.map((r) => r && r.id).filter(Boolean)))
        : [];

      const apply = () => {
        // Abraeumen und Einspielen liegen in DERSELBEN Transaktion: ein
        // Fehlschlag nach dem Loeschen und vor dem Schreiben waere ein leerer
        // Tresor -- der Schaden, gegen den eine Sicherung eigentlich hilft.
        //
        // Die Blobs bleiben bewusst draussen: eine Transaktion kann einen
        // geloeschten Satz zuruecknehmen, eine geloeschte Datei nicht. Sie
        // werden erst aufgeraeumt, wenn die Saetze sicher stehen.
        if (mode === 'restore') purgeEverything(result);
        for (const rec of ordered) {
          if (!rec || typeof rec.id !== 'string' || typeof rec.type !== 'string') {
            result.errors.push({ id: rec && rec.id, reason: 'Record ohne id oder type uebersprungen' });
            continue;
          }
          if (!schema.TYPES.includes(rec.type)) {
            result.errors.push({ id: rec.id, reason: `Unbekannter Record-Typ ${rec.type}` });
            continue;
          }
          try {
            restoreOne(rec, mode, result);
          } catch (err) {
            // One bad record must not cost the user the other 9 999.
            result.errors.push({ id: rec.id, reason: err.message });
          }
        }
        if (localEdges.length) restoreLocalEdges(localEdges, result);
      };

      if (typeof store.transaction === 'function') {
        try {
          store.transaction(apply);
        } catch (err) {
          throw new StorageError(`Import fehlgeschlagen: ${err.message}`);
        }
      } else {
        apply();
      }

      // Anhaenge nur aus einem ausdruecklich genannten Verzeichnis: wer nur
      // eine einzelne Datei angibt, hat nicht gesagt, dass daneben liegende
      // Dateien mit eingelesen werden duerfen.
      importFiles(payload, dir, result, unseal);
      // NACH dem Einlesen: was jetzt noch dasteht und nicht in der Sicherung
      // vorkommt, gehoerte zum alten Stand dieses Geraets. Und erst hier ist
      // sicher, dass die Saetze wirklich geschrieben wurden -- ein Fehlschlag
      // davor hat dann keine einzige Datei gekostet.
      if (mode === 'restore') {
        try {
          purgeUnknownBlobs(payload, result);
        } catch (err) {
          result.errors.push({ id: null, reason: `Dateiinhalte konnten nicht aufgeraeumt werden: ${err.message}` });
        }
      }
      // Diese drei sind Beiwerk zu den Saetzen. Was hier schiefgeht, wird
      // gemeldet, darf aber niemals eine gelungene Wiederherstellung von
      // zehntausend Eintraegen zu einem Fehlschlag machen.
      for (const [was, schritt] of [
        ['Einstellungen', () => applyConfig(payload, result)],
        ['Aenderungsverlauf', () => importHistory(payload, result, mode)],
        ['Verschluesselungsstand', () => reportEncryption(payload, result)],
      ]) {
        try {
          schritt();
        } catch (err) {
          result.errors.push({ id: null, reason: `${was}: ${err.message}` });
        }
      }

      const withheld = payload.withheld && typeof payload.withheld === 'object' ? payload.withheld : {};
      if (withheld.token) {
        result.warnings.push(`${withheld.token} Zugangstoken standen nicht in der Sicherung — sie gehoeren `
          + 'zum alten Geraet. Fuer den Zugriff aus dem lokalen Netz muss hier ein neues Token angelegt werden.');
      }
      if (result.networkMode && result.networkMode.inBackup && result.networkMode.inBackup !== result.networkMode.current) {
        result.warnings.push(result.networkMode.message);
      }
      if (result.config && !result.config.applied.length && result.config.message) {
        // Nur melden, wenn NICHTS uebernommen wurde. Ein gelungener Import ist
        // keine Warnung -- sonst steht die eine Zeile, auf die es ankommt,
        // zwischen lauter Erfolgsmeldungen.
        result.warnings.push(result.config.message);
      }
      if (result.config && result.config.applied.length && !result.config.persisted) {
        result.warnings.push('Die Einstellungen gelten nur bis zum naechsten Start: sie konnten nicht gespeichert werden.');
      }
      if (result.orphanFiles) {
        result.warnings.push(`${result.orphanFiles} Datei(en) aus der Sicherung haben keinen Eintrag, der auf `
          + 'sie zeigt. Sie wurden trotzdem uebernommen.');
      }
      if (mode === 'restore') {
        result.warnings.push(`Dieser Tresor wurde ersetzt: ${result.purged.records} vorhandene(r) Satz/Saetze `
          + `wurden geloescht${result.purged.files ? ` und ${result.purged.files} Dateiinhalt(e) entfernt` : ''}, `
          + `danach ${result.imported} aus der Sicherung eingespielt. Das laesst sich nicht rueckgaengig machen.`);
        if (result.purged.filesMessage) result.warnings.push(result.purged.filesMessage);
      }
      // Dieselbe Meldung zweimal zu lesen macht sie nicht wahrer.
      result.warnings = [...new Set(result.warnings)];

      if (typeof store.flush === 'function') {
        try { await store.flush(); } catch (err) { throw new StorageError(`Import konnte nicht gesichert werden: ${err.message}`); }
      }
      log.info(`Import aus ${loc.file}: ${result.imported} uebernommen, ${result.skipped} uebersprungen, ${result.errors.length} Fehler`);
      for (const warning of result.warnings) log.warn(warning);
      return result;
    },

    /**
     * Was ein Import TUN WUERDE -- ohne etwas zu schreiben.
     *
     * Der Grund, warum das eine eigene Funktion ist und nicht ein Absatz in
     * der Oberflaeche: nur dieses Modul weiss, was in der Sicherung steht,
     * was davon bewusst nicht mitreist und was der gewaehlte Modus mit dem
     * anrichtet, was hier schon liegt. Eine Oberflaeche, die das nachbaut,
     * behauptet frueher oder spaeter etwas anderes, als danach passiert.
     *
     * Schreibt NICHTS. Das ist die Zusage, auf der die Ansicht aufbaut: sie
     * ruft das beim Oeffnen auf.
     *
     * @param {{dir?:string, file?:string, mode?:string, passphrase?:string}} opts
     */
    async preview(opts = {}) {
      const mode = opts.mode ?? 'merge';
      if (!IMPORT_MODES.includes(mode)) {
        throw new ValidationError(`Unbekannter Importmodus: ${mode}. Erlaubt sind ${IMPORT_MODES.join(', ')}.`);
      }
      if (!opts.dir && !opts.file) throw new ValidationError('preview benoetigt dir oder file.');
      const dir = opts.dir ? path.resolve(opts.dir) : null;
      const loc = locateExport(dir, opts.file || null);
      const { payload } = await openExport(loc, opts.passphrase);

      const zaehle = (liste) => {
        const out = {};
        for (const rec of liste) {
          if (!rec || typeof rec.type !== 'string') continue;
          out[rec.type] = (out[rec.type] || 0) + 1;
        }
        return out;
      };
      const kommt = zaehle(payload.records);
      const hierNach = {};
      let hierGesamt = 0;
      for (const type of schema.TYPES) {
        let n;
        try { n = listPage(type, 0).total || 0; } catch { n = 0; }
        if (n) { hierNach[type] = n; hierGesamt += n; }
      }
      const traegtDateien = payload.includeFiles === true
        || (Array.isArray(payload.files) && payload.files.length > 0);

      const hinweise = [];
      const verschwindet = [];
      if (mode === 'merge') {
        hinweise.push('Vorhandene Eintraege bleiben unveraendert. Es kommt nur hinzu, was hier fehlt.');
      } else if (mode === 'replace') {
        hinweise.push('Eintraege mit derselben Kennung werden durch die Fassung aus der Sicherung ersetzt. '
          + 'Was hier zusaetzlich liegt, bleibt liegen.');
      } else if (mode === 'fresh') {
        hinweise.push('Dieser Modus bricht ab, sobald hier irgendetwas liegt — auch Geloeschtes.');
        if (hierGesamt > 0) {
          hinweise.push(`Er wird hier abbrechen: es liegen ${hierGesamt} Eintraege im Tresor.`);
        }
      } else if (mode === 'restore') {
        verschwindet.push(`alle ${hierGesamt} Eintraege, die jetzt in diesem Tresor liegen (auch Geloeschtes)`);
        if (traegtDateien) verschwindet.push('alle Dateiinhalte, die nicht in der Sicherung stehen');
        hinweise.push('Danach ist dieser Tresor genau der gesicherte Tresor. Das laesst sich nicht '
          + 'rueckgaengig machen — auch die Erstausstattung des ersten Starts ist dann weg.');
        if (!traegtDateien) {
          hinweise.push('Diese Sicherung enthaelt keine Anhaenge. Vorhandene Dateiinhalte werden deshalb NICHT geloescht.');
        }
      }

      // Was grundsaetzlich nicht mitreist -- unabhaengig vom Modus, und
      // deshalb hier und nicht in der Oberflaeche formuliert.
      const reistNichtMit = [
        'Zugangstoken fuer den Zugriff aus dem lokalen Netz. Sie gehoeren zum alten Geraet '
        + 'und muessen hier neu angelegt werden.',
        'Der Zugangsschluessel gekoppelter Geraete. Die Kopplung ist danach neu zu bestaetigen.',
        'Das Netzprotokoll dieses Geraets (audit.jsonl).',
        'Adresse und Port des Servers — das ist eine Eigenschaft dieses Geraets.',
      ];
      const netzInSicherung = payload.config?.network?.mode
        ?? payload.vault?.networkMode ?? null;
      if (netzInSicherung) {
        reistNichtMit.push(`Der Netzmodus. In der Sicherung steht "${netzInSicherung}"; dieses Geraet bleibt `
          + `auf "${config?.network?.mode || 'offline'}", bis du das ausdruecklich aenderst.`);
      }
      if (payload.vault && payload.vault.encrypted) {
        reistNichtMit.push('Das Schluesselmaterial der Verschluesselung. Der gesicherte Tresor war '
          + 'verschluesselt; dieser hier wird es nach dem Einspielen NICHT sein.');
      }

      return {
        mode,
        dir: loc.dir || dir,
        file: loc.file,
        sealed: Boolean(loc.sealed),
        version: payload.v ?? null,
        at: payload.at ?? null,
        sicherung: {
          records: payload.records.length,
          byType: kommt,
          files: Array.isArray(payload.files) ? payload.files.length : 0,
          includeFiles: traegtDateien,
          historyEntries: Array.isArray(payload.history?.entries) ? payload.history.entries.length : 0,
          networkMode: netzInSicherung,
          encrypted: Boolean(payload.vault && payload.vault.encrypted),
          withheld: payload.withheld && typeof payload.withheld === 'object' ? payload.withheld : {},
        },
        hier: { records: hierGesamt, byType: hierNach, files: allBlobHashes().length },
        verschwindet,
        hinweise,
        reistNichtMit,
      };
    },

    /**
     * @param {string} dir
     * @returns {Promise<{ok:boolean, problems:Array<{path:string, kind:string, message:string}>}>}
     */
    async verify(dir) {
      if (typeof dir !== 'string' || !dir) throw new ValidationError('verify benoetigt ein Verzeichnis.');
      const root = path.resolve(dir);
      const problems = [];
      const push = (p, kind, message) => problems.push({ path: p, kind, message });

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8'));
      } catch (err) {
        push(MANIFEST_FILE, 'manifest', `manifest.json fehlt oder ist unlesbar: ${err.message}`);
        return { ok: false, problems };
      }
      if (!manifest || manifest.kind !== MANIFEST_KIND || !Array.isArray(manifest.files)) {
        push(MANIFEST_FILE, 'manifest', 'manifest.json hat ein unbekanntes Format.');
        return { ok: false, problems };
      }

      const listed = new Set();
      for (const entry of manifest.files) {
        if (!entry || typeof entry.path !== 'string') {
          push(MANIFEST_FILE, 'manifest', 'Manifest-Eintrag ohne Pfad.');
          continue;
        }
        listed.add(entry.path);
        let abs;
        try {
          abs = safeJoin(root, entry.path);
        } catch {
          push(entry.path, 'manifest', 'Manifest-Eintrag zeigt aus dem Export-Verzeichnis heraus.');
          continue;
        }
        let buf;
        try {
          buf = fs.readFileSync(abs);
        } catch (err) {
          push(entry.path, err.code === 'ENOENT' ? 'missing' : 'unreadable', err.code === 'ENOENT' ? 'Datei fehlt.' : `Datei nicht lesbar: ${err.message}`);
          continue;
        }
        if (Number.isFinite(entry.bytes) && buf.length !== entry.bytes) {
          push(entry.path, 'mismatch', `Groesse weicht ab: ${buf.length} statt ${entry.bytes} Bytes.`);
          continue;
        }
        if (typeof entry.sha256 === 'string' && sha256(buf) !== entry.sha256) {
          push(entry.path, 'mismatch', 'sha256 stimmt nicht mit dem Manifest ueberein.');
        }
      }

      // export.json is the restorable artefact: check it actually parses and
      // agrees with the manifest, not just that its bytes are intact.
      if (listed.has(EXPORT_FILE)) {
        try {
          const payload = readPayload(path.join(root, EXPORT_FILE));
          const expected = manifest.counts && manifest.counts.records;
          if (Number.isFinite(expected) && payload.records.length !== expected) {
            push(EXPORT_FILE, 'mismatch', `Enthaelt ${payload.records.length} Records, das Manifest nennt ${expected}.`);
          }
        } catch (err) {
          push(EXPORT_FILE, 'unreadable', err.message);
        }
      } else if (listed.has(SEALED_FILE)) {
        // Verschluesselt: ohne Passphrase ist pruefbar, dass die Bytes stimmen
        // (oben schon geschehen) und dass das Schluesselmaterial daneben liegt.
        // Ohne dieses ist die Sicherung endgueltig nicht mehr zu oeffnen, und
        // das ist ein Fehler, kein Hinweis.
        if (!listed.has(KEYS_FILE)) {
          push(KEYS_FILE, 'missing', `${KEYS_FILE} fehlt; die verschluesselte Sicherung laesst sich ohne diese Datei nicht mehr oeffnen.`);
        }
      }

      for (const found of walk(root)) {
        if (found === MANIFEST_FILE || listed.has(found)) continue;
        // Reported, but not a failure: the user may keep their own notes next
        // to a backup, and that does not make the backup invalid.
        push(found, 'extra', 'Datei steht nicht im Manifest.');
      }

      const ok = !problems.some((p) => p.kind !== 'extra');
      return { ok, problems };
    },
  };

  function* walk(root, prefix = '') {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) yield* walk(root, rel);
      else yield rel;
    }
  }

  return api;
}

module.exports = {
  createBackup,
  EXPORT_VERSION,
  SUPPORTED_EXPORT_VERSIONS,
  EXPORT_KIND,
  MANIFEST_KIND,
  EXPORT_FILE,
  SEALED_FILE,
  KEYS_FILE,
  MANIFEST_FILE,
  EXCLUDED_TYPES,
  IMPORT_MODES,
  TYPE_LABELS,
  slugify,
};
