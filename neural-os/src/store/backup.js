'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { StorageError, ValidationError } = require('../kernel/errors');
const { safeJoin } = require('../kernel/paths');
const { logger: makeLogger } = require('../kernel/log');
const schema = require('./schema');

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
 */

const EXPORT_VERSION = 1;
const EXPORT_KIND = 'neural-os-export';
const MANIFEST_KIND = 'neural-os-manifest';
const EXPORT_FILE = 'export.json';
const MANIFEST_FILE = 'manifest.json';
const PAGE_SIZE = 500;
/** Nothing legitimate pages this often; the cap stops a broken `list()`
 *  implementation that ignores `offset` from spinning forever. */
const MAX_PAGES_PER_TYPE = 100000;

const ROLE_LABELS = { user: 'Nutzer', assistant: 'Assistent', system: 'System', tool: 'Werkzeug' };
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
 * @param {{store:object, paths:object, config?:object, logger?:object}} deps
 */
function createBackup({ store, paths, config, logger } = {}) {
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

  /** One synchronous pass over the whole vault. No awaits: see header. */
  function collect() {
    const records = [];
    const seen = new Set();
    for (const type of schema.TYPES) {
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
    return records;
  }

  /** Keep the envelope explicit: unknown extra top-level keys are dropped, so
   *  an import never resurrects transient in-memory bookkeeping as user data. */
  function envelope(record) {
    return toPlain({
      id: record.id,
      type: record.type,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
      deletedAt: record.deletedAt ?? null,
      rev: Number.isFinite(record.rev) ? record.rev : 1,
      data: record.data && typeof record.data === 'object' ? record.data : {},
    }, `Record ${record.id}`);
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
    };
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

  function indexDoc(counts, fileEntries, deletedCount, at) {
    const parts = [frontMatter({ type: 'index', kind: EXPORT_KIND, created: at, version: EXPORT_VERSION })];
    parts.push('# Neural-OS-Export\n');
    parts.push(`Erstellt am ${germanDateTime(at)}.\n`);
    parts.push('> **Achtung:** Dieser Ordner enthaelt saemtliche Inhalte im Klartext — auch dann, '
      + 'wenn der Vault selbst verschluesselt ist. Bitte entsprechend sicher aufbewahren.\n');
    parts.push('## Inhalt\n');
    const labels = {
      note: 'Notizen', chat: 'Chats', message: 'Nachrichten', project: 'Projekte', task: 'Aufgaben',
      agent: 'Agenten', run: 'Agentenlaeufe', file: 'Dateien', entity: 'Entitaeten', edge: 'Verknuepfungen',
      memory: 'Erinnerungen', approval: 'Freigaben', grant: 'Netz-Freigaben', token: 'Zugangstoken',
    };
    for (const type of schema.TYPES) {
      if (!counts[type]) continue;
      parts.push(`- ${labels[type] || type}: ${counts[type]}`);
    }
    parts.push('');
    if (deletedCount) {
      parts.push(`_${deletedCount} geloeschte Eintraege sind nur in \`${EXPORT_FILE}\` enthalten, nicht in den Markdown-Dateien._\n`);
    }
    parts.push('## Wiederherstellung\n');
    parts.push(`Die Datei \`${EXPORT_FILE}\` ist die vollstaendige, maschinenlesbare Sicherung. `
      + 'Die Markdown-Dateien sind zum Lesen gedacht und werden beim Import nicht ausgewertet.\n');
    if (fileEntries.length) {
      parts.push('## Angehaengte Dateien\n');
      for (const f of fileEntries) {
        parts.push(`- [${f.name}](${f.path}) — ${f.size} Bytes, \`sha256:${f.hash.slice(0, 16)}…\``);
      }
      parts.push('');
    }
    return parts.join('\n');
  }

  // ----------------------------------------------------------------- export

  function exportFiles(records, writer) {
    /** @type {Array<{hash:string, path:string, name:string, mime:string, size:number}>} */
    const out = [];
    if (!store.files || typeof store.files.read !== 'function') return out;
    const seen = new Map();
    for (const record of records) {
      if (record.type !== 'file') continue;
      const d = record.data || {};
      const hash = typeof d.hash === 'string' && d.hash ? d.hash : null;
      if (!hash || seen.has(hash)) continue;
      let buf;
      try {
        if (typeof store.files.has === 'function' && !store.files.has(hash)) {
          log.warn(`Blob ${hash} fehlt im Vault, Datei-Record ${record.id} wird ohne Inhalt exportiert`);
          continue;
        }
        buf = store.files.read(hash);
      } catch (err) {
        // A missing blob must not abort the backup: exporting everything else
        // is far more valuable than failing on one damaged attachment.
        log.warn(`Blob ${hash} nicht lesbar (${err.message}); Export laeuft ohne diese Datei weiter`);
        continue;
      }
      if (!Buffer.isBuffer(buf)) continue;
      // Human-readable name + hash prefix: navigable in a file manager, still
      // unique, and the manifest carries the exact path so import never guesses.
      const rawName = String(d.name || 'datei');
      const stem = path.basename(rawName, path.extname(rawName));
      const rel = `files/${slugify(stem, 'datei')}-${hash.slice(0, 8)}${safeExt(rawName)}`;
      writer.write(rel, buf);
      const entry = { hash, path: rel, name: String(d.name || 'datei'), mime: String(d.mime || 'application/octet-stream'), size: buf.length };
      seen.set(hash, entry);
      out.push(entry);
    }
    return out;
  }

  function writeMarkdown(records, writer, fileEntries, at) {
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

    const counts = {};
    for (const [type, list] of byType(records)) counts[type] = list.length;
    const deletedCount = records.length - live(records).length;
    writer.write('INDEX.md', indexDoc(counts, fileEntries, deletedCount, at));
  }

  // ----------------------------------------------------------------- import

  function readPayload(source) {
    let raw;
    try {
      raw = fs.readFileSync(source, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new ValidationError(`Sicherungsdatei nicht gefunden: ${source}`);
      throw new StorageError(`Sicherungsdatei ist nicht lesbar: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ValidationError(`Sicherungsdatei ist kein gueltiges JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new ValidationError('Sicherungsdatei enthaelt kein Objekt.');
    if (parsed.kind !== EXPORT_KIND) throw new ValidationError(`Unbekanntes Sicherungsformat: ${parsed.kind ?? 'ohne Kennung'}`);
    if (parsed.v !== EXPORT_VERSION) throw new ValidationError(`Nicht unterstuetzte Sicherungsversion: ${parsed.v}`);
    if (!Array.isArray(parsed.records)) throw new ValidationError('Sicherungsdatei enthaelt keine Record-Liste.');
    return parsed;
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
      if (mode === 'fresh') {
        // vaultIsEmpty() already gated this; reaching here means the vault
        // changed underneath us.
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

  function importFiles(payload, dir, result) {
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
        const buf = fs.readFileSync(abs);
        const actual = sha256(buf);
        if (actual !== entry.hash) {
          // Importing content that does not match its address would poison the
          // content-addressed store for every record referencing that hash.
          result.errors.push({ id: entry.hash, reason: `Pruefsumme von ${entry.path} stimmt nicht (${actual.slice(0, 12)} statt ${entry.hash.slice(0, 12)})` });
          continue;
        }
        store.files.put(buf, { name: entry.name, mime: entry.mime });
        result.files++;
      } catch (err) {
        result.errors.push({ id: entry.hash, reason: `Anhang ${entry.path} konnte nicht eingelesen werden: ${err.message}` });
      }
    }
  }

  // -------------------------------------------------------------- public API

  const api = {
    /**
     * @param {{dir?:string, format?:'json'|'markdown'|'both', includeFiles?:boolean}} [opts]
     * @returns {Promise<{dir:string, files:number, records:number, bytes:number, manifest:object}>}
     */
    async exportAll(opts = {}) {
      const format = opts.format ?? 'both';
      if (!['json', 'markdown', 'both'].includes(format)) {
        throw new ValidationError(`Unbekanntes Exportformat: ${format}. Erlaubt sind json, markdown, both.`);
      }
      const includeFiles = opts.includeFiles !== false;
      const at = new Date().toISOString();
      const dir = opts.dir
        ? path.resolve(opts.dir)
        : path.join(paths.exports, `export-${at.replace(/[:.]/g, '-')}`);

      // Snapshot first, disk second: see the header note on tearing.
      const records = collect();

      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        throw new StorageError(`Export-Verzeichnis ${dir} konnte nicht angelegt werden: ${err.message}`);
      }
      prunePrevious(dir);

      const writer = makeWriter(dir);
      const fileEntries = includeFiles ? exportFiles(records, writer) : [];

      const counts = {};
      for (const [type, list] of byType(records)) counts[type] = list.length;

      if (format === 'json' || format === 'both') {
        writer.write(EXPORT_FILE, JSON.stringify({
          v: EXPORT_VERSION,
          kind: EXPORT_KIND,
          at,
          generator: { app: 'neural-os', version: appVersion(), node: process.version },
          // Context for whoever restores this, never anything secret.
          vault: {
            networkMode: config?.network?.mode ?? null,
            encrypted: Boolean(config?.security?.encryption?.enabled),
          },
          counts: { records: records.length, byType: counts, files: fileEntries.length },
          files: fileEntries,
          records,
        }, null, 2) + '\n');
      }
      if (format === 'markdown' || format === 'both') {
        writeMarkdown(records, writer, fileEntries, at);
      }

      const manifest = {
        v: EXPORT_VERSION,
        kind: MANIFEST_KIND,
        at,
        format,
        includeFiles,
        counts: { records: records.length, byType: counts, files: fileEntries.length, written: writer.entries.length },
        // manifest.json cannot list its own hash, so it is the one file not
        // covered here; verify() reports that honestly.
        files: writer.entries.slice().sort((a, b) => a.path.localeCompare(b.path)),
      };
      const manifestBytes = writer.write(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');

      log.info(`Export nach ${dir}: ${records.length} Records, ${writer.entries.length} Dateien`);
      return {
        dir,
        files: writer.entries.length,
        records: records.length,
        bytes: writer.bytes,
        manifest,
        manifestBytes,
      };
    },

    /**
     * @param {{dir?:string, file?:string, mode?:'merge'|'replace'|'fresh'}} opts
     * @returns {Promise<{imported:number, skipped:number, conflicts:Array<{id:string,type:string,reason:string}>, files:number, filesSkipped:number, errors:Array}>}
     */
    async importAll(opts = {}) {
      const mode = opts.mode ?? 'merge';
      if (!['merge', 'replace', 'fresh'].includes(mode)) {
        throw new ValidationError(`Unbekannter Importmodus: ${mode}. Erlaubt sind merge, replace, fresh.`);
      }
      if (!opts.dir && !opts.file) throw new ValidationError('importAll benoetigt dir oder file.');
      const dir = opts.dir ? path.resolve(opts.dir) : null;
      const source = opts.file ? path.resolve(opts.file) : path.join(dir, EXPORT_FILE);
      const payload = readPayload(source);

      if (mode === 'fresh') {
        const present = remainingRecords();
        if (present > 0) {
          throw new ValidationError(
            `Modus "fresh" verlangt einen leeren Vault, es liegen aber ${present} Eintraege darin `
            + '(auch geloeschte zaehlen). Bitte "merge" oder "replace" waehlen.',
          );
        }
      }

      const result = { imported: 0, skipped: 0, conflicts: [], files: 0, filesSkipped: 0, errors: [] };

      // Nodes before edges: an edge whose endpoint is still missing would be
      // rejected by a store that validates endpoints.
      const ordered = [
        ...payload.records.filter((r) => r && r.type !== 'edge'),
        ...payload.records.filter((r) => r && r.type === 'edge'),
      ];

      const apply = () => {
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

      importFiles(payload, dir, result);

      if (typeof store.flush === 'function') {
        try { await store.flush(); } catch (err) { throw new StorageError(`Import konnte nicht gesichert werden: ${err.message}`); }
      }
      log.info(`Import aus ${source}: ${result.imported} uebernommen, ${result.skipped} uebersprungen, ${result.errors.length} Fehler`);
      return result;
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
  EXPORT_KIND,
  MANIFEST_KIND,
  EXPORT_FILE,
  MANIFEST_FILE,
  slugify,
};
