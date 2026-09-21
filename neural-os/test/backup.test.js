'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');
const pathsMod = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const schema = require('../src/store/schema');
const { NotFoundError, ValidationError } = require('../src/kernel/errors');
const { createBackup, EXPORT_FILE, MANIFEST_FILE, slugify } = require('../src/store/backup');

/**
 * src/store/engine.js is being written in parallel, so these tests run against
 * a hand-built store that implements section 1 of the contract: the same
 * signatures, the same return shapes, soft deletes, content-addressed blobs,
 * paginated list(). It is a stand-in for the engine, not a stub for backup --
 * every method here does the real work, so a bug in backup.js still fails.
 *
 * `honourHints` models the one genuine unknown: whether the real engine will
 * accept createdAt/updatedAt/rev/deletedAt hints on create(). Both answers are
 * tested, so the round-trip guarantee holds either way.
 */

function newId(type) {
  let s = '';
  while (s.length < 24) s += crypto.randomBytes(16).toString('hex');
  const id = `${type}_${s.slice(0, 24)}`;
  assert.ok(schema.ID_RE.test(id), `generated id must satisfy the contract: ${id}`);
  return id;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function createFakeStore({ honourHints = true, encrypted = false } = {}) {
  /** @type {Map<string, object>} */
  const records = new Map();
  /** @type {Map<string, Buffer>} */
  const blobs = new Map();
  const stats = { flushes: 0, transactions: 0 };

  function hint(opts, key, fallback) {
    return honourHints && opts[key] !== undefined && opts[key] !== null ? opts[key] : fallback;
  }

  const store = {
    stats,
    // engine.js meldet das ebenso; der Import muss sagen koennen, ob die Tuer
    // nach der Wiederherstellung offen steht.
    encrypted,
    create(type, data, opts = {}) {
      const clean = schema.validate(type, data);
      const id = opts.id || newId(type);
      if (records.has(id)) throw new ValidationError(`Record ${id} existiert bereits`);
      if (type === 'edge') {
        for (const end of [clean.from, clean.to]) {
          if (!records.has(end)) throw new NotFoundError(`edge endpoint ${end}`);
        }
      }
      const now = new Date().toISOString();
      const rec = {
        id,
        type,
        createdAt: hint(opts, 'createdAt', now),
        updatedAt: hint(opts, 'updatedAt', now),
        deletedAt: honourHints && opts.deletedAt ? opts.deletedAt : null,
        rev: honourHints && Number.isFinite(opts.rev) ? opts.rev : 1,
        data: clean,
      };
      records.set(id, rec);
      return clone(rec);
    },
    get(id, opts = {}) {
      const rec = records.get(id);
      if (!rec) return null;
      if (rec.deletedAt && !opts.includeDeleted) return null;
      return clone(rec);
    },
    update(id, patch, opts = {}) {
      const rec = records.get(id);
      if (!rec || (rec.deletedAt && !opts.includeDeleted)) throw new NotFoundError(`record ${id}`);
      rec.data = schema.validate(rec.type, { ...rec.data, ...patch });
      rec.rev += 1;
      rec.updatedAt = new Date().toISOString();
      return clone(rec);
    },
    remove(id, opts = {}) {
      const rec = records.get(id);
      if (!rec) throw new NotFoundError(`record ${id}`);
      const copy = clone(rec);
      if (opts.hard) {
        records.delete(id);
        return copy;
      }
      rec.deletedAt = new Date().toISOString();
      rec.rev += 1;
      return clone(rec);
    },
    restore(id) {
      const rec = records.get(id);
      if (!rec) throw new NotFoundError(`record ${id}`);
      rec.deletedAt = null;
      rec.rev += 1;
      return clone(rec);
    },
    list(type, q = {}) {
      let items = [...records.values()].filter((r) => r.type === type);
      if (!q.includeDeleted) items = items.filter((r) => !r.deletedAt);
      // Mirrors engine.js: default sort is updatedAt descending, ties broken
      // deterministically by id. Backup must not depend on anything softer.
      const sort = typeof q.sort === 'string' && q.sort ? q.sort : 'updatedAt';
      const dir = q.order === 'asc' ? 1 : -1;
      items.sort((a, b) => {
        const av = String(a[sort] ?? '');
        const bv = String(b[sort] ?? '');
        if (av === bv) return a.id < b.id ? -1 : 1;
        return av < bv ? -dir : dir;
      });
      const total = items.length;
      const offset = q.offset || 0;
      const limit = Number.isFinite(q.limit) ? q.limit : total;
      return { items: items.slice(offset, offset + limit).map(clone), total };
    },
    all(type) {
      return store.list(type, {}).items;
    },
    count(type) {
      return store.list(type, {}).total;
    },
    transaction(fn) {
      stats.transactions++;
      return fn();
    },
    async flush() {
      stats.flushes++;
    },
    files: {
      put(buffer, { name, mime } = {}) {
        if (!Buffer.isBuffer(buffer)) throw new ValidationError('files.put erwartet einen Buffer');
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        blobs.set(hash, Buffer.from(buffer));
        return { hash, size: buffer.length, path: `files/${hash.slice(0, 2)}/${hash}`, name, mime };
      },
      read(hash) {
        const buf = blobs.get(hash);
        if (!buf) throw new NotFoundError(`blob ${hash}`);
        return Buffer.from(buf);
      },
      has(hash) {
        return blobs.has(hash);
      },
      /** Wie die echte Ablage: jeder Blob ist auffindbar, auch der, auf den
       *  kein file-Record zeigt. */
      list() {
        return [...blobs.keys()];
      },
      remove(hash) {
        return blobs.delete(hash);
      },
    },
    edges: {
      add({ from, to, kind = 'related', source = 'manual', reason = '', weight = 1 }) {
        for (const existing of records.values()) {
          if (existing.type === 'edge' && !existing.deletedAt
            && existing.data.from === from && existing.data.to === to && existing.data.kind === kind) {
            return clone(existing);
          }
        }
        return store.create('edge', { from, to, kind, source, reason, weight });
      },
    },
  };
  return store;
}

/** A vault with one of everything, including the awkward cases. */
function seed(store) {
  const noteA = store.create('note', {
    title: 'Größe & Maß: Übersicht',
    body: '# Überschrift\n\nEin [[Verweis]] und ein #tag mit "Anführungszeichen", Backslash \\ und Zeilenumbruch.\n\n- Punkt 1\n- Punkt 2\n',
    tags: ['wissen', 'öffentlich'],
    pinned: true,
  });
  const noteB = store.create('note', { title: '', body: 'Notiz ohne Titel', tags: [] });
  const noteC = store.create('note', { title: 'Gelöschte Notiz', body: 'weg, aber wiederherstellbar' });
  store.remove(noteC.id); // soft delete: must survive the backup as a tombstone

  const project = store.create('project', {
    name: 'Neural OS bauen',
    description: 'Offline-first, alles lokal.',
    status: 'active',
    tags: ['bau'],
  });
  const task1 = store.create('task', { title: 'Vault verschlüsseln', status: 'done', projectId: project.id, priority: 1, body: 'AES-256-GCM' });
  const task2 = store.create('task', { title: 'Sicherung schreiben', status: 'doing', projectId: project.id, due: '2026-10-01' });
  const task3 = store.create('task', { title: 'Aufgabe ohne Projekt', status: 'todo' });

  const chat = store.create('chat', {
    title: 'Erstes Gespräch',
    model: { provider: 'ollama', model: 'llama3' },
    network: 'offline',
    systemPrompt: 'Du bist hilfreich.',
  });
  // Echte Nachrichten liegen Sekunden auseinander (das Modell braucht Zeit);
  // explizite Zeitstempel machen die Transkript-Reihenfolge pruefbar.
  const t0 = Date.parse('2026-09-19T10:00:00.000Z');
  const at = (sec) => new Date(t0 + sec * 1000).toISOString();
  const m1 = store.create('message', { chatId: chat.id, role: 'user', content: 'Was ist ein Wissensgraph?' }, { createdAt: at(0), updatedAt: at(0) });
  const m2 = store.create('message', {
    chatId: chat.id,
    role: 'assistant',
    content: 'Ein Graph aus Notizen und Kanten.',
    model: { provider: 'ollama', model: 'llama3' },
    stats: { promptTokens: 12, completionTokens: 34, ms: 900 },
    toolCalls: [{ id: 'c1', name: 'notes.search', arguments: { q: 'graph' } }],
  }, { createdAt: at(4), updatedAt: at(4) });
  const m3 = store.create('message', {
    chatId: chat.id,
    role: 'assistant',
    content: 'Mit Netz geholt.',
    usedNetwork: true,
    networkTargets: ['example.invalid'],
    status: 'complete',
  }, { createdAt: at(9), updatedAt: at(9) });
  const emptyChat = store.create('chat', { title: 'Leerer Chat' });

  const agent = store.create('agent', {
    name: 'Rechercheur',
    description: 'Sucht in Notizen.',
    systemPrompt: 'Antworte knapp.',
    permissions: { ...schema.normalisePermissions({}), readNotes: true, writeNotes: true, network: 'lan' },
  });
  const entity = store.create('entity', { name: 'Ada Lovelace', kind: 'person', aliases: ['Ada'] });
  const memory = store.create('memory', { text: 'Nutzer mag kurze Antworten.', importance: 2 });
  const run = store.create('run', { agentId: agent.id, goal: 'Notizen zusammenfassen', status: 'done', result: 'fertig', producedIds: [noteA.id] });

  const blob1 = Buffer.from('PDF-Inhalt mit Umlauten: äöü', 'utf8');
  const blob2 = crypto.randomBytes(2048);
  const put1 = store.files.put(blob1, { name: 'Bericht.pdf', mime: 'application/pdf' });
  const put2 = store.files.put(blob2, { name: 'bild.png', mime: 'image/png' });
  const file1 = store.create('file', { name: 'Bericht.pdf', hash: put1.hash, mime: 'application/pdf', size: blob1.length, tags: ['arbeit'] });
  const file2 = store.create('file', { name: 'bild.png', hash: put2.hash, mime: 'image/png', size: blob2.length });
  // A record whose blob was never stored: the export must survive it.
  const file3 = store.create('file', { name: 'verschwunden.txt', hash: 'a'.repeat(64), mime: 'text/plain', size: 10 });

  store.edges.add({ from: noteA.id, to: project.id, kind: 'links-to', source: 'manual', reason: 'vom Nutzer gezogen' });
  store.edges.add({ from: task1.id, to: project.id, kind: 'belongs-to', source: 'derived' });
  store.edges.add({ from: run.id, to: noteA.id, kind: 'produced', source: 'agent' });

  return { noteA, noteB, noteC, project, task1, task2, task3, chat, emptyChat, m1, m2, m3, agent, entity, memory, run, file1, file2, file3, blob1, blob2, put1, put2 };
}

/** Every record in the vault, deleted ones included, in a stable order. */
function snapshot(store) {
  const out = [];
  for (const type of schema.TYPES) {
    out.push(...store.list(type, { includeDeleted: true, limit: 100000, offset: 0 }).items);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The subset every conforming engine must reproduce, hints or no hints. */
function projection(store) {
  return snapshot(store).map((r) => ({ id: r.id, type: r.type, data: r.data, deleted: Boolean(r.deletedAt) }));
}

/** Zahlen je Satzart, Grabsteine eingeschlossen -- die Waehrung einer Wiederherstellung. */
function zaehleJeArt(store) {
  const out = {};
  for (const type of schema.TYPES) {
    const n = store.list(type, { includeDeleted: true, limit: 100000, offset: 0 }).total;
    if (n) out[type] = n;
  }
  return out;
}

function makeBackup(store, label) {
  const { home, cleanup } = tempHome(label);
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  // A capturing logger keeps the suite's output clean and turns the diagnostics
  // into something assertable, instead of noise scrolling past on stderr.
  const logged = { warn: [], info: [], error: [], debug: [] };
  const logger = {
    warn: (m) => logged.warn.push(m),
    info: (m) => logged.info.push(m),
    error: (m) => logged.error.push(m),
    debug: (m) => logged.debug.push(m),
  };
  return { home, paths, config, cleanup, logged, backup: createBackup({ store, paths, config, logger }) };
}

// ---------------------------------------------------------------------------

test('voller Rundlauf: Export, frischer Vault, Import — alle Records identisch', async () => {
  const source = createFakeStore();
  const seeded = seed(source);
  const ctx = makeBackup(source, 'bk-roundtrip');
  try {
    const before = snapshot(source);
    assert.ok(before.length >= 22, `Testdaten zu duenn: ${before.length} Records`);
    // Vielfalt ist hier der Punkt: ein Rundlauf ueber nur Notizen beweist nichts.
    const seededTypes = new Set(before.map((r) => r.type));
    for (const type of ['note', 'chat', 'message', 'project', 'task', 'agent', 'run', 'file', 'entity', 'memory', 'edge']) {
      assert.ok(seededTypes.has(type), `Testdaten enthalten keinen Record vom Typ ${type}`);
    }

    const result = await ctx.backup.exportAll({ format: 'both' });
    // Ein Datei-Record ohne Blob darf den Export nicht abbrechen, muss aber
    // sichtbar gemeldet werden -- stilles Weglassen waere Datenverlust.
    assert.ok(ctx.logged.warn.some((m) => m.includes(seeded.file3.data.hash)), 'fehlender Blob muss gemeldet werden');
    assert.ok(result.dir.startsWith(ctx.paths.exports));
    assert.equal(result.records, before.length);
    assert.ok(result.bytes > 0);
    assert.ok(result.files >= 5);
    assert.equal(result.manifest.counts.records, before.length);

    const verified = await ctx.backup.verify(result.dir);
    assert.deepEqual(verified.problems, [], 'ein frischer Export muss fehlerfrei verifizieren');
    assert.equal(verified.ok, true);

    // A brand new, completely empty vault.
    const target = createFakeStore();
    const targetCtx = makeBackup(target, 'bk-roundtrip-target');
    try {
      assert.equal(snapshot(target).length, 0);
      const imported = await targetCtx.backup.importAll({ dir: result.dir, mode: 'fresh' });
      assert.deepEqual(imported.errors, [], 'der Import darf keine Fehler melden');
      assert.equal(imported.imported, before.length);
      assert.equal(imported.skipped, 0);
      assert.deepEqual(imported.conflicts, []);

      // THE guarantee: byte-for-byte the same vault.
      assert.deepEqual(snapshot(target), before);

      // Attachments come back with identical content, addressed by the same hash.
      assert.equal(imported.files, 2);
      assert.ok(target.files.read(seeded.put1.hash).equals(seeded.blob1));
      assert.ok(target.files.read(seeded.put2.hash).equals(seeded.blob2));

      // The tombstone is still a tombstone, not a resurrected note.
      assert.equal(target.get(seeded.noteC.id), null);
      assert.ok(target.get(seeded.noteC.id, { includeDeleted: true }).deletedAt);
      // ...and restorable, which is the whole reason for keeping it.
      assert.equal(target.restore(seeded.noteC.id).deletedAt, null);
    } finally {
      targetCtx.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Rundlauf haelt auch, wenn der Store die Envelope-Hinweise ignoriert', async () => {
  const source = createFakeStore();
  seed(source);
  const ctx = makeBackup(source, 'bk-nohints');
  try {
    const result = await ctx.backup.exportAll({ format: 'json' });
    const target = createFakeStore({ honourHints: false });
    const targetCtx = makeBackup(target, 'bk-nohints-target');
    try {
      const imported = await targetCtx.backup.importAll({ dir: result.dir, mode: 'fresh' });
      assert.deepEqual(imported.errors, []);
      // ids, types, payloads and the deleted flag are guaranteed regardless;
      // createdAt/rev are storage metadata the engine may regenerate.
      assert.deepEqual(projection(target), projection(source));
      for (const rec of snapshot(target)) {
        // Ohne Hinweise vergibt der Store eigene Metadaten: frische Records
        // starten bei rev 1, nachtraeglich wieder entfernte bei rev 2.
        assert.equal(rec.rev, rec.deletedAt ? 2 : 1, `unerwartete rev fuer ${rec.id}`);
        assert.notEqual(rec.createdAt, null);
      }
    } finally {
      targetCtx.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Markdown-Export ist lesbar, vollstaendig und korrekt ausgezeichnet', async () => {
  const source = createFakeStore();
  const seeded = seed(source);
  const ctx = makeBackup(source, 'bk-md');
  try {
    const { dir } = await ctx.backup.exportAll({ format: 'markdown' });
    assert.equal(fs.existsSync(path.join(dir, EXPORT_FILE)), false, 'format:markdown schreibt keine export.json');

    const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
    const ls = (sub) => fs.readdirSync(path.join(dir, sub)).sort();

    const notes = ls('notes');
    assert.equal(notes.length, 2, 'die geloeschte Notiz gehoert nicht in den Markdown-Baum');
    const noteFile = notes.find((f) => f.startsWith('groesse-mass-uebersicht-'));
    assert.ok(noteFile, `Umlaute muessen sauber gefaltet werden, gefunden: ${notes.join(', ')}`);
    const noteMd = read(path.join('notes', noteFile));

    // Front-matter must be valid YAML *and* survive quoting hazards.
    assert.match(noteMd, /^---\n/);
    const fm = noteMd.slice(4, noteMd.indexOf('\n---\n'));
    const fields = {};
    for (const line of fm.split('\n')) {
      const at = line.indexOf(': ');
      fields[line.slice(0, at)] = JSON.parse(line.slice(at + 2));
    }
    assert.equal(fields.id, seeded.noteA.id);
    assert.equal(fields.title, 'Größe & Maß: Übersicht');
    assert.deepEqual(fields.tags, ['wissen', 'öffentlich']);
    assert.equal(fields.pinned, true);
    assert.ok(noteMd.includes('Ein [[Verweis]] und ein #tag'));
    assert.ok(noteMd.includes('Backslash \\ und'));

    const chatFile = ls('chats').find((f) => f.startsWith('erstes-gespraech-'));
    assert.ok(chatFile);
    const chatMd = read(path.join('chats', chatFile));
    assert.ok(chatMd.includes('## Nutzer'));
    assert.ok(chatMd.includes('## Assistent'));
    // Frage vor Antwort. Nachrichten entstehen oft in derselben Millisekunde,
    // deshalb darf die Reihenfolge nicht an createdAt allein haengen.
    const iFrage = chatMd.indexOf('Was ist ein Wissensgraph?');
    const iAntwort = chatMd.indexOf('Ein Graph aus Notizen und Kanten.');
    const iSpaeter = chatMd.indexOf('Mit Netz geholt.');
    assert.ok(iFrage > 0 && iAntwort > 0 && iSpaeter > 0);
    assert.ok(iFrage < iAntwort && iAntwort < iSpaeter, 'das Transkript muss die Gespraechsreihenfolge bewahren');
    assert.ok(chatMd.includes('`notes.search`'), 'Werkzeugaufrufe gehoeren ins Transkript');
    assert.ok(chatMd.includes('Netzzugriff erfolgt: example.invalid'), 'Provenienz muss im Export sichtbar bleiben');
    assert.ok(chatMd.includes('ollama/llama3'));
    const emptyChatMd = read(path.join('chats', ls('chats').find((f) => f.startsWith('leerer-chat-'))));
    assert.ok(emptyChatMd.includes('keine Nachrichten'));

    const projectMd = read(path.join('projects', ls('projects')[0]));
    assert.ok(projectMd.includes('# Neural OS bauen'));
    assert.ok(projectMd.includes('## Aufgaben (1 offen von 2)'));
    assert.ok(projectMd.includes('- [x] '), 'erledigte Aufgaben als abgehakt');
    assert.ok(projectMd.includes('- [ ] '), 'offene Aufgaben als leere Box');
    assert.ok(projectMd.includes('faellig 2026-10-01'));
    assert.ok(/\]\(\.\.\/tasks\/.+\.md\)/.test(projectMd), 'Aufgaben verlinken auf ihre eigene Datei');

    assert.equal(ls('tasks').length, 3, 'auch die projektlose Aufgabe wird exportiert');
    const agentMd = read(path.join('agents', ls('agents')[0]));
    assert.ok(agentMd.includes('Netzzugriff: lan'));
    assert.ok(agentMd.includes('Bestaetigung noetig: ja'));

    const index = read('INDEX.md');
    assert.ok(index.includes('Klartext'), 'INDEX.md muss vor dem Klartext-Inhalt warnen');
    assert.ok(index.includes('Notizen: 3'));
    assert.ok(index.includes('1 geloeschte'));

    const files = ls('files');
    assert.ok(files.some((f) => /^bericht-[0-9a-f]{8}\.pdf$/.test(f)), `Dateinamen lesbar halten: ${files.join(', ')}`);
    assert.ok(fs.readFileSync(path.join(dir, 'files', files.find((f) => f.startsWith('bericht-')))).equals(seeded.blob1));

    assert.equal((await ctx.backup.verify(dir)).ok, true);
  } finally {
    ctx.cleanup();
  }
});

test('manifest.json fuehrt jede Datei mit Groesse und sha256', async () => {
  const source = createFakeStore();
  seed(source);
  const ctx = makeBackup(source, 'bk-manifest');
  try {
    const { dir, manifest } = await ctx.backup.exportAll({ format: 'both' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
    assert.deepEqual(onDisk.files, manifest.files);
    assert.ok(onDisk.files.length > 5);
    for (const entry of onDisk.files) {
      const buf = fs.readFileSync(path.join(dir, entry.path));
      assert.equal(buf.length, entry.bytes, `${entry.path}: Groesse`);
      assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), entry.sha256, `${entry.path}: Pruefsumme`);
      assert.ok(!entry.path.includes('\\'), 'Manifest-Pfade immer mit /');
    }
    assert.ok(onDisk.files.some((f) => f.path === EXPORT_FILE));
    assert.ok(!onDisk.files.some((f) => f.path === MANIFEST_FILE), 'das Manifest listet sich nicht selbst');
    assert.equal(onDisk.counts.files, 2);
    assert.ok(onDisk.counts.byType.note >= 3);
  } finally {
    ctx.cleanup();
  }
});

test('verify erkennt Manipulation, Verlust und fremde Dateien', async () => {
  const source = createFakeStore();
  seed(source);
  const ctx = makeBackup(source, 'bk-verify');
  try {
    const { dir } = await ctx.backup.exportAll({ format: 'both' });

    // 1. Ein gekipptes Bit in export.json.
    const exportPath = path.join(dir, EXPORT_FILE);
    const original = fs.readFileSync(exportPath);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 20] = tampered[tampered.length - 20] === 0x20 ? 0x21 : 0x20;
    fs.writeFileSync(exportPath, tampered);
    let report = await ctx.backup.verify(dir);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.path === EXPORT_FILE && p.kind === 'mismatch'));
    fs.writeFileSync(exportPath, original);
    assert.equal((await ctx.backup.verify(dir)).ok, true);

    // 2. Eine fehlende Datei.
    const victim = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')).files.find((f) => f.path.startsWith('notes/'));
    const victimAbs = path.join(dir, victim.path);
    const victimBuf = fs.readFileSync(victimAbs);
    fs.unlinkSync(victimAbs);
    report = await ctx.backup.verify(dir);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.path === victim.path && p.kind === 'missing'));
    fs.writeFileSync(victimAbs, victimBuf);

    // 3. Eine fremde Datei ist kein Integritaetsfehler.
    fs.writeFileSync(path.join(dir, 'meine-eigenen-notizen.txt'), 'gehoert dem Nutzer');
    report = await ctx.backup.verify(dir);
    assert.equal(report.ok, true, 'zusaetzliche Dateien duerfen die Sicherung nicht entwerten');
    assert.deepEqual(report.problems.map((p) => p.kind), ['extra']);

    // 4. Gar kein Manifest.
    const empty = tempHome('bk-verify-empty');
    try {
      const none = await ctx.backup.verify(empty.home);
      assert.equal(none.ok, false);
      assert.equal(none.problems[0].kind, 'manifest');
    } finally {
      empty.cleanup();
    }
    await assert.rejects(() => ctx.backup.verify(''), (err) => err.code === 'VALIDATION_FAILED');
  } finally {
    ctx.cleanup();
  }
});

test('Importmodi: merge behaelt, replace ueberschreibt, fresh verweigert', async () => {
  const source = createFakeStore();
  const seeded = seed(source);
  const ctx = makeBackup(source, 'bk-modes');
  try {
    const { dir } = await ctx.backup.exportAll({ format: 'json' });

    // Ein Ziel, in dem derselbe Record bereits mit anderem Inhalt liegt.
    const target = createFakeStore();
    const targetCtx = makeBackup(target, 'bk-modes-target');
    try {
      target.create('note', { title: 'Lokale Fassung', body: 'nicht ueberschreiben' }, { id: seeded.noteA.id });

      const merged = await targetCtx.backup.importAll({ dir, mode: 'merge' });
      assert.equal(target.get(seeded.noteA.id).data.title, 'Lokale Fassung', 'merge behaelt die vorhandene Fassung');
      assert.equal(merged.skipped, 1);
      assert.equal(merged.conflicts.length, 1);
      assert.equal(merged.conflicts[0].id, seeded.noteA.id);
      assert.ok(merged.imported > 20, 'alles andere wird trotzdem uebernommen');

      // Ein zweiter merge-Lauf ist idempotent: nichts Neues, nur Konflikte.
      const again = await targetCtx.backup.importAll({ dir, mode: 'merge' });
      assert.equal(again.imported, 0);
      assert.equal(again.conflicts.length, merged.imported + 1);

      // fresh verweigert den nicht mehr leeren Vault.
      await assert.rejects(() => targetCtx.backup.importAll({ dir, mode: 'fresh' }), (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /leeren Vault/);
        return true;
      });

      // replace stellt den Export-Stand her, auch ueber die lokale Fassung hinweg.
      const replaced = await targetCtx.backup.importAll({ dir, mode: 'replace' });
      assert.equal(replaced.skipped, 0);
      assert.equal(target.get(seeded.noteA.id).data.title, 'Größe & Maß: Übersicht');
      assert.deepEqual(snapshot(target), snapshot(source), 'replace stellt den exportierten Zustand vollstaendig her');

      await assert.rejects(() => targetCtx.backup.importAll({ dir, mode: 'unsinn' }), (err) => err.code === 'VALIDATION_FAILED');
      await assert.rejects(() => targetCtx.backup.importAll({}), (err) => err.code === 'VALIDATION_FAILED');
    } finally {
      targetCtx.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
});

test('kaputte Sicherungsdateien werden abgewiesen statt halb eingelesen', async () => {
  const store = createFakeStore();
  const ctx = makeBackup(store, 'bk-broken');
  try {
    const dir = path.join(ctx.home, 'kaputt');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, EXPORT_FILE);

    fs.writeFileSync(file, '{ kein json');
    await assert.rejects(() => ctx.backup.importAll({ dir }), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /kein gueltiges JSON/);
      return true;
    });

    fs.writeFileSync(file, JSON.stringify({ v: 1, kind: 'etwas-anderes', records: [] }));
    await assert.rejects(() => ctx.backup.importAll({ dir }), (err) => /Unbekanntes Sicherungsformat/.test(err.message));

    fs.writeFileSync(file, JSON.stringify({ v: 99, kind: 'neural-os-export', records: [] }));
    await assert.rejects(() => ctx.backup.importAll({ dir }), (err) => /Sicherungsversion/.test(err.message));

    fs.writeFileSync(file, JSON.stringify({ v: 1, kind: 'neural-os-export', records: 'nein' }));
    await assert.rejects(() => ctx.backup.importAll({ dir }), (err) => /Record-Liste/.test(err.message));

    await assert.rejects(() => ctx.backup.importAll({ file: path.join(dir, 'gibtsnicht.json') }), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /nicht gefunden/);
      return true;
    });
    assert.equal(snapshot(store).length, 0, 'nach lauter Fehlschlaegen ist der Vault unveraendert');
  } finally {
    ctx.cleanup();
  }
});

test('einzelne unbrauchbare Records kosten nicht den ganzen Import', async () => {
  const source = createFakeStore();
  const seeded = seed(source);
  const ctx = makeBackup(source, 'bk-partial');
  try {
    const { dir } = await ctx.backup.exportAll({ format: 'json' });
    const file = path.join(dir, EXPORT_FILE);
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const healthy = payload.records.length;
    payload.records.push({ id: 'note_zzzzzzzzzzzzzzzzzzzzzzzz', type: 'unbekannt', data: {} });
    payload.records.push({ type: 'note', data: { title: 'ohne id' } });
    payload.records.push({ id: 'note_yyyyyyyyyyyyyyyyyyyyyyyy', type: 'note', data: {} }); // title fehlt
    // Eine Kante ins Leere: der Store lehnt sie ab, der Rest muss durchgehen.
    payload.records.push({ id: 'edge_xxxxxxxxxxxxxxxxxxxxxxxx', type: 'edge', createdAt: null, updatedAt: null, deletedAt: null, rev: 1, data: { from: seeded.noteA.id, to: 'note_gibtsnicht0000000000', kind: 'related', source: 'manual', reason: '', weight: 1, reviewed: false } });
    fs.writeFileSync(file, JSON.stringify(payload));

    const target = createFakeStore();
    const targetCtx = makeBackup(target, 'bk-partial-target');
    try {
      const result = await targetCtx.backup.importAll({ dir, mode: 'merge' });
      assert.equal(result.imported, healthy, 'alle gesunden Records kommen an');
      assert.equal(result.errors.length, 4);
      assert.ok(result.errors.some((e) => /Unbekannter Record-Typ/.test(e.reason)));
      assert.ok(result.errors.some((e) => /ohne id oder type/.test(e.reason)));
      assert.ok(result.errors.some((e) => /title/.test(e.reason)));
      assert.ok(result.errors.some((e) => /not found/.test(e.reason)));
      assert.deepEqual(projection(target), projection(source));
    } finally {
      targetCtx.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
});

test('manipulierte Anhaenge werden nicht in den Store gelassen', async () => {
  const source = createFakeStore();
  const seeded = seed(source);
  const ctx = makeBackup(source, 'bk-blob');
  try {
    const { dir } = await ctx.backup.exportAll({ format: 'json' });
    const payload = JSON.parse(fs.readFileSync(path.join(dir, EXPORT_FILE), 'utf8'));
    const entry = payload.files.find((f) => f.hash === seeded.put1.hash);
    fs.writeFileSync(path.join(dir, entry.path), 'untergeschobener Inhalt');

    const target = createFakeStore();
    const targetCtx = makeBackup(target, 'bk-blob-target');
    try {
      const result = await targetCtx.backup.importAll({ dir, mode: 'fresh' });
      assert.equal(result.files, 1, 'nur der unveraenderte Anhang wird uebernommen');
      assert.ok(result.errors.some((e) => /Pruefsumme/.test(e.reason)));
      assert.equal(target.files.has(seeded.put1.hash), false, 'der inhaltsadressierte Store bleibt konsistent');
      assert.equal(target.files.has(seeded.put2.hash), true);
      // Die Records sind trotzdem vollstaendig da -- nur der Inhalt einer Datei fehlt.
      assert.deepEqual(projection(target), projection(source));
    } finally {
      targetCtx.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
});

test('includeFiles:false laesst Anhaenge weg, behaelt aber die Datei-Records', async () => {
  const source = createFakeStore();
  seed(source);
  const ctx = makeBackup(source, 'bk-nofiles');
  try {
    const { dir, manifest } = await ctx.backup.exportAll({ format: 'json', includeFiles: false });
    assert.equal(manifest.counts.files, 0);
    assert.equal(fs.existsSync(path.join(dir, 'files')), false);
    const payload = JSON.parse(fs.readFileSync(path.join(dir, EXPORT_FILE), 'utf8'));
    assert.deepEqual(payload.files, []);
    assert.equal(payload.records.filter((r) => r.type === 'file').length, 3);
    assert.equal((await ctx.backup.verify(dir)).ok, true);

    const target = createFakeStore();
    const targetCtx = makeBackup(target, 'bk-nofiles-target');
    try {
      const result = await targetCtx.backup.importAll({ dir, mode: 'fresh' });
      assert.equal(result.files, 0);
      assert.deepEqual(projection(target), projection(source));
      assert.equal(target.files.has(seedHash(payload)), false, 'ohne Anhaenge gibt es keinen Blob-Inhalt');
    } finally {
      targetCtx.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
  function seedHash(payload) {
    return payload.records.find((r) => r.type === 'file' && r.data.hash && !/^a+$/.test(r.data.hash)).data.hash;
  }
});

test('ein erneuter Export ins selbe Verzeichnis raeumt nur eigene Altdateien weg', async () => {
  const source = createFakeStore();
  const seeded = seed(source);
  const ctx = makeBackup(source, 'bk-reexport');
  try {
    const dir = path.join(ctx.home, 'ziel');
    await ctx.backup.exportAll({ dir, format: 'both' });
    const staleName = fs.readdirSync(path.join(dir, 'notes')).find((f) => f.startsWith('groesse-'));
    assert.ok(staleName);
    // Fremde Datei des Nutzers: muss den Export ueberleben.
    fs.writeFileSync(path.join(dir, 'nicht-anfassen.txt'), 'privat');

    source.remove(seeded.noteA.id, { hard: true });
    const second = await ctx.backup.exportAll({ dir, format: 'both' });

    assert.equal(fs.existsSync(path.join(dir, 'notes', staleName)), false, 'veraltete Exportdatei muss verschwinden');
    assert.equal(fs.readFileSync(path.join(dir, 'nicht-anfassen.txt'), 'utf8'), 'privat');
    assert.equal(second.records, snapshot(source).length);
    const report = await ctx.backup.verify(dir);
    assert.equal(report.ok, true);
    assert.deepEqual(report.problems.map((p) => p.path), ['nicht-anfassen.txt']);
  } finally {
    ctx.cleanup();
  }
});

test('ein leerer Vault exportiert und importiert sauber', async () => {
  const source = createFakeStore();
  const ctx = makeBackup(source, 'bk-empty');
  try {
    const result = await ctx.backup.exportAll({ format: 'both' });
    assert.equal(result.records, 0);
    assert.equal((await ctx.backup.verify(result.dir)).ok, true);
    const index = fs.readFileSync(path.join(result.dir, 'INDEX.md'), 'utf8');
    assert.ok(index.includes('Neural-OS-Export'));

    const target = createFakeStore();
    const targetCtx = makeBackup(target, 'bk-empty-target');
    try {
      const imported = await targetCtx.backup.importAll({ dir: result.dir, mode: 'fresh' });
      assert.equal(imported.imported, 0);
      assert.deepEqual(imported.errors, []);
      assert.equal(snapshot(target).length, 0);
    } finally {
      targetCtx.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Export blaettert ueber grosse Bestaende und bleibt in einem Rutsch konsistent', async () => {
  const source = createFakeStore();
  for (let i = 0; i < 1200; i++) source.create('note', { title: `Notiz ${i}`, body: 'x'.repeat(50) });
  const ctx = makeBackup(source, 'bk-paging');
  try {
    const result = await ctx.backup.exportAll({ format: 'json' });
    assert.equal(result.records, 1200, 'die Seitengroesse von 500 darf nichts verschlucken');
    const payload = JSON.parse(fs.readFileSync(path.join(result.dir, EXPORT_FILE), 'utf8'));
    assert.equal(new Set(payload.records.map((r) => r.id)).size, 1200, 'keine Duplikate ueber Seitengrenzen');
    assert.equal(source.stats.transactions, 0);

    const target = createFakeStore();
    const targetCtx = makeBackup(target, 'bk-paging-target');
    try {
      await targetCtx.backup.importAll({ dir: result.dir, mode: 'fresh' });
      assert.equal(target.count('note'), 1200);
      assert.equal(target.stats.transactions, 1, 'der Import laeuft in einer Transaktion');
      assert.equal(target.stats.flushes, 1, 'und wird genau einmal gesichert');
    } finally {
      targetCtx.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Exportdateien liegen nur fuer den Eigentuemer lesbar', async () => {
  const source = createFakeStore();
  seed(source);
  const ctx = makeBackup(source, 'bk-modes-fs');
  try {
    const { dir } = await ctx.backup.exportAll({ format: 'both' });
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'Export-Verzeichnis nur fuer den Eigentuemer');
    for (const rel of [EXPORT_FILE, MANIFEST_FILE, 'INDEX.md']) {
      assert.equal(fs.statSync(path.join(dir, rel)).mode & 0o777, 0o600, `${rel} darf nicht weltlesbar sein`);
    }
    await assert.rejects(() => ctx.backup.exportAll({ format: 'xml' }), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    });
    assert.throws(() => createBackup({ paths: ctx.paths }), (err) => err.code === 'VALIDATION_FAILED');
    assert.throws(() => createBackup({ store: source }), (err) => err.code === 'VALIDATION_FAILED');
  } finally {
    ctx.cleanup();
  }
});

test('gleiche Zeitstempel ergeben trotzdem eine stabile, reproduzierbare Reihenfolge', async () => {
  const source = createFakeStore();
  const chat = source.create('chat', { title: 'Gleichzeitig' });
  const stamp = '2026-09-19T12:00:00.000Z';
  for (let i = 0; i < 12; i++) {
    source.create('message', { chatId: chat.id, role: i % 2 ? 'assistant' : 'user', content: `Nachricht ${i}` }, { createdAt: stamp, updatedAt: stamp });
  }
  const ctx = makeBackup(source, 'bk-ties');
  try {
    // Bei identischer Millisekunde kann keine Quelle die echte Reihenfolge
    // kennen; garantiert wird deshalb nur, dass sie deterministisch ist --
    // zwei Exporte desselben Vaults duerfen nicht verschieden aussehen.
    const first = await ctx.backup.exportAll({ dir: path.join(ctx.home, 'a'), format: 'markdown' });
    const second = await ctx.backup.exportAll({ dir: path.join(ctx.home, 'b'), format: 'markdown' });
    const readChat = (dir) => fs.readFileSync(path.join(dir, 'chats', fs.readdirSync(path.join(dir, 'chats'))[0]), 'utf8');
    assert.equal(readChat(first.dir), readChat(second.dir));
    const transcript = readChat(first.dir);
    for (let i = 0; i < 12; i++) assert.ok(transcript.includes(`Nachricht ${i}`), `Nachricht ${i} fehlt`);
  } finally {
    ctx.cleanup();
  }
});

/**
 * Integration gegen den echten Store. engine.js entsteht parallel; faellt das
 * Modul ganz aus, wird das laut gemeldet statt still uebersprungen -- ein Test,
 * der nichts geprueft hat, darf nicht wie ein bestandener aussehen.
 */
test('voller Rundlauf gegen die echte engine.js (meldet sich ab, falls nicht vorhanden)', async () => {
  let openStore = null;
  try {
    ({ openStore } = require('../src/store/engine'));
  } catch (err) {
    console.warn(`  ! engine.js nicht ladbar, Integrationstest uebersprungen: ${err.message}`);
    return;
  }
  if (typeof openStore !== 'function') {
    console.warn('  ! engine.js exportiert kein openStore(), Integrationstest uebersprungen');
    return;
  }

  const a = tempHome('bk-engine-a');
  const b = tempHome('bk-engine-b');
  let sourceStore = null;
  let targetStore = null;
  try {
    const pathsA = pathsMod.ensureLayout(pathsMod.layout(a.home));
    const pathsB = pathsMod.ensureLayout(pathsMod.layout(b.home));
    sourceStore = await openStore({ paths: pathsA });
    targetStore = await openStore({ paths: pathsB });

    const seeded = seed(sourceStore);
    const before = projection(sourceStore);
    assert.ok(before.length >= 22);

    const backupA = createBackup({ store: sourceStore, paths: pathsA, config: configMod.defaults(), logger: { warn() {}, info() {}, error() {}, debug() {} } });
    const backupB = createBackup({ store: targetStore, paths: pathsB, config: configMod.defaults(), logger: { warn() {}, info() {}, error() {}, debug() {} } });

    const exported = await backupA.exportAll({ format: 'both' });
    assert.equal(exported.records, before.length);
    assert.equal((await backupA.verify(exported.dir)).ok, true);

    const imported = await backupB.importAll({ dir: exported.dir, mode: 'fresh' });
    assert.deepEqual(imported.errors, [], 'der echte Store darf keinen Record ablehnen');
    assert.equal(imported.imported, before.length);
    assert.deepEqual(projection(targetStore), before, 'echter Store: identische Records nach dem Rundlauf');
    assert.ok(targetStore.files.read(seeded.put1.hash).equals(seeded.blob1));

    // Und der Nachweis, dass es wirklich auf der Platte steht: schliessen,
    // neu oeffnen, noch einmal vergleichen.
    await targetStore.close();
    targetStore = await openStore({ paths: pathsB });
    assert.deepEqual(projection(targetStore), before, 'nach Neustart des Stores unveraendert');
  } finally {
    for (const s of [sourceStore, targetStore]) {
      if (s && typeof s.close === 'function') { try { await s.close(); } catch { /* egal */ } }
    }
    a.cleanup();
    b.cleanup();
  }
});

test('slugify faltet Deutsch nachvollziehbar', () => {
  assert.equal(slugify('Größe & Maß'), 'groesse-mass');
  assert.equal(slugify('Über allen Gipfeln'), 'ueber-allen-gipfeln');
  assert.equal(slugify('Café Crème'), 'cafe-creme');
  assert.equal(slugify(''), 'ohne-titel');
  assert.equal(slugify('   '), 'ohne-titel');
  assert.equal(slugify(null), 'ohne-titel');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd', 'niemals Pfadtrenner im Slug');
  assert.equal(slugify('a'.repeat(200)).length, 60);
  assert.equal(slugify('日本語のみ'), 'ohne-titel');
});


// ---------------------------------------------------------------------------
// Die Sicherung als das, was sie verspricht: den Wissensstand retten und auf
// einem neuen Rechner wiederherstellen. Jeder Test unten haelt genau einen
// gemessenen Befund fest.
// ---------------------------------------------------------------------------

const backupMod = require('../src/store/backup');

/** Saetze, die es im Grundbestand nicht gibt und auf die es hier ankommt. */
function seedExtras(store) {
  const agent = store.create('agent', { name: 'Zeitgeber', description: 'Laeuft nach der Uhr.' });
  return {
    agent,
    token: store.create('token', {
      label: 'Handy im WLAN',
      hash: 'a1'.repeat(32),
      salt: 'b2'.repeat(16),
      permissions: { read: true, write: true, chat: false, agents: false },
    }),
    grant: store.create('grant', { scope: 'global', level: 'lan', hosts: ['modelle.lan'], reason: 'Modellserver im Keller' }),
    peer: store.create('peer', { name: 'Laptop', url: 'http://192.168.1.20:7777', token: 'GEHEIM-PEER-TOKEN' }),
    schedule: store.create('schedule', { agentId: agent.id, goal: 'Tagesueberblick', every: 'daily', atHour: 7, enabled: true }),
    trigger: store.create('trigger', { agentId: agent.id, goal: 'Verschlagworten', on: 'record.created', recordType: 'note', enabled: true }),
    watch: store.create('watch', { path: '/heim/scans', label: 'Scans', enabled: true, tags: ['papier'] }),
  };
}

/** Eine Konfiguration, die sich von der Voreinstellung sichtbar unterscheidet. */
function configuredVault() {
  const config = configMod.defaults();
  config.network.mode = 'lan';
  config.network.allowHosts = ['modelle.lan'];
  config.network.strictAllowlist = false;
  config.ui.theme = 'dark';
  config.ui.density = 'kompakt';
  config.models.remote = [{ id: 'oai', kind: 'openai', baseUrl: 'https://api.example.invalid/v1', apiKeyEnv: 'OAI_KEY', enabled: true, apiKey: 'DARF-NICHT-MITREISEN' }];
  config.security.globalApprovalOverride = true;
  config.security.sharing.enabled = true;
  config.security.sharing.bindHost = '0.0.0.0';
  config.agents.maxConcurrentRuns = 5;
  config.history.maxEntries = 500;
  config.history.maxDays = 7;
  return config;
}

function readPayload(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, EXPORT_FILE), 'utf8'));
}

function allFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...allFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

test('BEFUND 1: die Einstellungen reisen mit — der Netzmodus wird gemeldet, nicht gesetzt', async () => {
  const source = createFakeStore();
  seed(source);
  const src = makeBackup(source, 'bk-cfg-a');
  const dst = makeBackup(createFakeStore(), 'bk-cfg-b');
  // Tresor A steht auf lan/dark mit einem Online-Anbieter, Tresor B ab Werk.
  Object.assign(src.config, configuredVault());
  try {
    const exported = await src.backup.exportAll({ format: 'both' });
    const payload = readPayload(exported.dir);

    assert.ok(payload.config, 'die Konfiguration fehlt im Export');
    assert.equal(payload.config.network.mode, 'lan');
    assert.deepEqual(payload.config.network.allowHosts, ['modelle.lan']);
    assert.equal(payload.config.ui.theme, 'dark');
    assert.equal(payload.config.models.remote.length, 1);
    assert.equal(payload.config.models.remote[0].apiKeyEnv, 'OAI_KEY');
    assert.equal(payload.config.models.remote[0].apiKey, undefined, 'ein Schluessel darf nie in die Sicherung');
    assert.equal(payload.config.security.globalApprovalOverride, true);
    assert.equal(payload.config.agents.maxConcurrentRuns, 5);
    assert.equal(payload.config.history.maxEntries, 500);
    // Der Serverport gehoert dem Geraet, nicht dem Wissen.
    assert.equal(payload.config.server, undefined);

    const result = await dst.backup.importAll({ dir: exported.dir, mode: 'merge' });

    assert.equal(dst.config.ui.theme, 'dark', 'die Oberflaeche muss nach dem Import so aussehen wie vorher');
    assert.equal(dst.config.ui.density, 'kompakt');
    assert.equal(dst.config.models.remote.length, 1, 'der Online-Anbieter fehlt nach dem Import');
    assert.equal(dst.config.agents.maxConcurrentRuns, 5);
    assert.equal(dst.config.history.maxEntries, 500);
    assert.deepEqual(dst.config.network.allowHosts, ['modelle.lan']);
    assert.equal(dst.config.network.strictAllowlist, false);

    // Und die eine Ausnahme: der Netzmodus.
    assert.equal(dst.config.network.mode, 'offline', 'eine Sicherung darf ein offline gehaltenes Geraet nicht oeffnen');
    assert.equal(result.networkMode.inBackup, 'lan');
    assert.equal(result.networkMode.applied, false);
    assert.match(result.networkMode.message, /In der Sicherung stand: lan/);
    assert.ok(result.warnings.some((w) => /In der Sicherung stand: lan/.test(w)), 'der Modus muss im Ergebnis auftauchen, damit die Oberflaeche fragen kann');
    // Ebenso alles, was sonst noch Tueren oeffnen wuerde.
    assert.equal(dst.config.security.sharing.enabled, false, 'die Netzfreigabe darf nicht aus einer Sicherung angehen');
    assert.equal(dst.config.server.host, '127.0.0.1');
    const reported = result.config.reported.map((r) => r.key);
    assert.deepEqual(reported, ['network.mode', 'security.sharing', 'security.encryption']);

    // Auf der Platte, nicht nur im Speicher: sonst ist es nach dem Neustart weg.
    const saved = JSON.parse(fs.readFileSync(dst.paths.config, 'utf8'));
    assert.equal(saved.ui.theme, 'dark');
    assert.equal(saved.network.mode, 'offline');
    assert.equal(result.config.persisted, true);

    // Und lesbar fuer einen Menschen.
    const cfgDoc = fs.readFileSync(path.join(exported.dir, 'konfiguration.md'), 'utf8');
    assert.match(cfgDoc, /# Einstellungen/);
    assert.match(cfgDoc, /Netzmodus in dieser Sicherung: \*\*lan\*\*/);
    assert.match(cfgDoc, /wird beim Import NICHT gesetzt/);
    assert.ok(!cfgDoc.includes('DARF-NICHT-MITREISEN'));
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

test('BEFUND 2: Zugangstoken bleiben am alten Geraet, Netzfreigaben reisen mit', async () => {
  const source = createFakeStore();
  seed(source);
  const extras = seedExtras(source);
  const src = makeBackup(source, 'bk-token-a');
  const targetStore = createFakeStore();
  const dst = makeBackup(targetStore, 'bk-token-b');
  try {
    const exported = await src.backup.exportAll({ format: 'both' });
    const payload = readPayload(exported.dir);
    const raw = fs.readFileSync(path.join(exported.dir, EXPORT_FILE), 'utf8');

    assert.equal(payload.records.filter((r) => r.type === 'token').length, 0, 'Zugangstoken gehoeren nicht in eine Sicherung');
    assert.ok(!raw.includes(extras.token.data.hash), 'der Hash darf nirgends im Export stehen');
    assert.ok(!raw.includes(extras.token.data.salt), 'das Salt darf nirgends im Export stehen');
    assert.equal(payload.withheld.token, 1, 'was zurueckgehalten wurde, muss gezaehlt werden');
    assert.equal(exported.withheld.token, 1);

    // Netzfreigaben BLEIBEN: sie sind die Richtlinie des Nutzers.
    const grant = payload.records.find((r) => r.id === extras.grant.id);
    assert.ok(grant, 'Netz-Freigaben muessen mitreisen');
    assert.deepEqual(grant.data.hosts, ['modelle.lan']);

    // Ein gekoppeltes Geraet reist mit, sein replaybarer Schluessel nicht.
    const peer = payload.records.find((r) => r.id === extras.peer.id);
    assert.ok(peer, 'das gekoppelte Geraet selbst ist Wissen des Nutzers');
    assert.equal(peer.data.token, '', 'das Peer-Token ist der Schluessel selbst und bleibt hier');
    assert.deepEqual(peer.redacted, ['token'], 'die Schwaerzung muss sichtbar sein, nicht stillschweigend');
    assert.ok(!raw.includes('GEHEIM-PEER-TOKEN'));

    // INDEX.md sagt ausdruecklich, was nicht mitreist und warum.
    const index = fs.readFileSync(path.join(exported.dir, 'INDEX.md'), 'utf8');
    assert.match(index, /## Was NICHT mitreist/);
    assert.match(index, /\*\*Zugangstoken\*\* \(1 Stueck\)/);
    assert.match(index, /Zugangsdaten, kein Wissen/);
    assert.match(index, /audit\.jsonl/);
    assert.match(index, /secrets\.json/);

    const result = await dst.backup.importAll({ dir: exported.dir, mode: 'merge' });
    assert.equal(targetStore.count('token'), 0);
    assert.equal(targetStore.count('grant'), source.count('grant'), 'Netzfreigaben muessen vollstaendig ankommen');
    assert.ok(result.warnings.some((w) => /Zugangstoken/.test(w)), 'der Nutzer muss erfahren, dass er ein neues Token braucht');
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

test('BEFUND 3: mit eigener Passphrase steht nichts im Klartext — ohne sagt der Export das klar', async () => {
  const source = createFakeStore();
  seed(source);
  source.create('note', { title: 'Geheim', body: 'Butterblume' });
  const src = makeBackup(source, 'bk-seal-a');
  const targetStore = createFakeStore();
  const dst = makeBackup(targetStore, 'bk-seal-b');
  try {
    // Voreinstellung: AUS. Und der Export sagt unmissverstaendlich, dass er
    // im Klartext liegt -- eine vergessene Passphrase waere der groessere
    // Schaden, also wird hier gewarnt statt stillschweigend verschluesselt.
    const offen = await src.backup.exportAll({ format: 'both' });
    assert.equal(offen.sealed, false);
    assert.ok(fs.readFileSync(path.join(offen.dir, EXPORT_FILE), 'utf8').includes('Butterblume'));
    const offenIndex = fs.readFileSync(path.join(offen.dir, 'INDEX.md'), 'utf8');
    assert.match(offenIndex, /Achtung: Dieser Ordner liegt im Klartext/);
    assert.match(offenIndex, /eigenen Passphrase/);

    const zu = await src.backup.exportAll({ dir: path.join(src.paths.exports, 'zu'), format: 'both', passphrase: 'gutes-langes-geheimnis' });
    assert.equal(zu.sealed, true);
    const namen = allFiles(zu.dir);
    assert.ok(namen.includes(backupMod.SEALED_FILE));
    assert.ok(namen.includes(backupMod.KEYS_FILE));
    assert.ok(!namen.includes(EXPORT_FILE), 'neben der verschluesselten Fassung darf keine offene liegen');
    for (const name of namen) {
      const bytes = fs.readFileSync(path.join(zu.dir, name));
      assert.ok(!bytes.includes('Butterblume'), `${name} enthaelt Klartext`);
      assert.ok(!bytes.includes('Größe & Maß'), `${name} enthaelt Klartext`);
    }
    // Das Deckblatt bleibt lesbar, verraet aber keine Zahlen und keine Dateinamen.
    const zuIndex = fs.readFileSync(path.join(zu.dir, 'INDEX.md'), 'utf8');
    assert.match(zuIndex, /\*\*Verschluesselt\.\*\*/);
    assert.match(zuIndex, /keine Wiederherstellung fuer eine vergessene Passphrase/);
    assert.ok(!/^- Notizen: /m.test(zuIndex), 'ein verschluesselter Export darf seinen Inhalt nicht auf dem Deckblatt zaehlen');
    assert.equal((await src.backup.verify(zu.dir)).ok, true);

    await assert.rejects(
      () => dst.backup.importAll({ dir: zu.dir, mode: 'merge' }),
      (err) => /eigenen Passphrase verschluesselt/.test(err.message),
      'ohne Passphrase muss der Import klar sagen, woran es liegt',
    );
    await assert.rejects(
      () => dst.backup.importAll({ dir: zu.dir, mode: 'merge', passphrase: 'falsche-passphrase' }),
      (err) => /Falsche Passphrase/.test(err.message),
      'eine falsche Passphrase ist etwas anderes als eine kaputte Datei',
    );

    const result = await dst.backup.importAll({ dir: zu.dir, mode: 'merge', passphrase: 'gutes-langes-geheimnis' });
    assert.equal(result.sealed, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(projection(targetStore), projection(source), 'der verschluesselte Rundlauf muss dasselbe zurueckgeben');
    // Auch die Anhaenge, inklusive Pruefsumme gegen den Klartext-Hash.
    assert.ok(result.files >= 2);
    const bericht = source.list('file', { limit: 100 }).items.find((r) => r.data.name === 'Bericht.pdf');
    assert.ok(targetStore.files.read(bericht.data.hash).length > 0);
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

test('BEFUND 4: nach dem Import sagt das Ergebnis, ob die Tuer offen steht', async () => {
  const source = createFakeStore({ encrypted: true });
  seed(source);
  const src = makeBackup(source, 'bk-enc-a');
  src.config.security.encryption.enabled = true;
  const dst = makeBackup(createFakeStore({ encrypted: false }), 'bk-enc-b');
  try {
    const exported = await src.backup.exportAll({ format: 'json' });
    const result = await dst.backup.importAll({ dir: exported.dir, mode: 'merge' });

    assert.equal(result.encryption.inBackup, true);
    assert.equal(result.encryption.here, false);
    assert.match(result.encryption.message, /dieser hier ist es NICHT/);
    assert.match(result.encryption.message, /Schluesselmaterial reist nie mit/);
    assert.ok(result.warnings.some((w) => /dieser hier ist es NICHT/.test(w)), 'das darf nicht nur im Protokoll stehen');

    // Und der ehrliche Gegenfall: nichts hat sich verschlechtert, also keine Warnung.
    const plainSrc = makeBackup(createFakeStore(), 'bk-enc-c');
    const plainDst = makeBackup(createFakeStore(), 'bk-enc-d');
    try {
      const e2 = await plainSrc.backup.exportAll({ format: 'json' });
      const r2 = await plainDst.backup.importAll({ dir: e2.dir, mode: 'merge' });
      assert.equal(r2.encryption.here, false);
      assert.equal(r2.encryption.inBackup, false);
      assert.ok(!r2.warnings.some((w) => /NICHT/.test(w)));
    } finally {
      plainSrc.cleanup();
      plainDst.cleanup();
    }
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

test('BEFUND 5: Blobs ohne Datei-Eintrag verschwinden nicht mehr still', async () => {
  const source = createFakeStore();
  const put1 = source.files.put(Buffer.from('mit Eintrag'), { name: 'da.txt', mime: 'text/plain' });
  source.files.put(Buffer.from('verwaist eins'), { name: 'weg1.txt', mime: 'text/plain' });
  source.files.put(Buffer.from('verwaist zwei'), { name: 'weg2.txt', mime: 'text/plain' });
  source.create('file', { name: 'da.txt', hash: put1.hash, mime: 'text/plain', size: 11 });
  const src = makeBackup(source, 'bk-orphan-a');
  const targetStore = createFakeStore();
  const dst = makeBackup(targetStore, 'bk-orphan-b');
  try {
    const exported = await src.backup.exportAll({ format: 'both' });
    const payload = readPayload(exported.dir);
    assert.equal(payload.files.length, 3, 'drei Blobs auf der Platte, drei im Export');
    assert.equal(payload.files.filter((f) => f.orphan).length, 2);
    assert.equal(exported.orphanFiles, 2);

    const index = fs.readFileSync(path.join(exported.dir, 'INDEX.md'), 'utf8');
    assert.match(index, /## Inhalte ohne Datei-Eintrag/);
    assert.match(index, /2 Datei\(en\) liegen im Tresor/);

    const result = await dst.backup.importAll({ dir: exported.dir, mode: 'merge' });
    assert.equal(result.files, 3);
    assert.equal(result.orphanFiles, 2);
    assert.ok(result.warnings.some((w) => /keinen Eintrag/.test(w)));
    for (const entry of payload.files) {
      assert.ok(targetStore.files.has(entry.hash), `Blob ${entry.hash.slice(0, 8)} ging verloren`);
      assert.equal(sha256Hex(targetStore.files.read(entry.hash)), entry.hash);
    }
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('BEFUND 6: der lesbare Teil zeigt auch Zeitplaene, Ausloeser und Netzfreigaben', async () => {
  const source = createFakeStore();
  seed(source);
  seedExtras(source);
  const ctx = makeBackup(source, 'bk-md');
  try {
    const exported = await ctx.backup.exportAll({ format: 'markdown' });
    const read = (rel) => fs.readFileSync(path.join(exported.dir, rel), 'utf8');

    const zeit = read(path.join('automatik', 'zeitplaene.md'));
    assert.match(zeit, /# Zeitplaene/);
    assert.match(zeit, /## Zeitgeber — taeglich um 7 Uhr/);
    assert.match(zeit, /Eingeschaltet: ja/);
    assert.match(zeit, /Auftrag: Tagesueberblick/);

    const ausloeser = read(path.join('automatik', 'ausloeser.md'));
    assert.match(ausloeser, /# Ausloeser/);
    assert.match(ausloeser, /wenn etwas neu angelegt wird/);
    assert.match(ausloeser, /Nur fuer: Notizen/, 'auch hier keine rohen englischen Typnamen');

    const ordner = read(path.join('automatik', 'beobachtete-ordner.md'));
    assert.match(ordner, /\/heim\/scans/);

    const freigaben = read(path.join('netz', 'freigaben.md'));
    assert.match(freigaben, /# Netz-Freigaben/);
    assert.match(freigaben, /Ziele: modelle\.lan/);
    assert.match(freigaben, /Begruendung: Modellserver im Keller/);

    const geraete = read(path.join('netz', 'geraete.md'));
    assert.match(geraete, /Laptop/);
    assert.match(geraete, /Zugangstoken: \*\*nicht in der Sicherung\*\*/);
    assert.ok(!geraete.includes('GEHEIM-PEER-TOKEN'));

    assert.match(read(path.join('wissen', 'erinnerungen.md')), /kurze Antworten/);
    assert.match(read(path.join('wissen', 'entitaeten.md')), /Ada Lovelace/);
    assert.match(read('agentenlaeufe.md'), /Notizen zusammenfassen/);

    // Leere Listen luegen nicht, sie sagen es.
    const leer = makeBackup(createFakeStore(), 'bk-md-leer');
    try {
      const e = await leer.backup.exportAll({ format: 'markdown' });
      assert.match(fs.readFileSync(path.join(e.dir, 'netz', 'freigaben.md'), 'utf8'), /_Keine Netz-Freigaben erteilt\._/);
    } finally {
      leer.cleanup();
    }
  } finally {
    ctx.cleanup();
  }
});

test('BEFUND 7: INDEX.md nennt jede Art auf Deutsch', async () => {
  const source = createFakeStore();
  seed(source);
  seedExtras(source);
  const ctx = makeBackup(source, 'bk-index');
  try {
    const exported = await ctx.backup.exportAll({ format: 'both' });
    const index = fs.readFileSync(path.join(exported.dir, 'INDEX.md'), 'utf8');
    for (const type of schema.TYPES) {
      assert.ok(!index.includes(`- ${type}: `), `INDEX.md druckt den rohen englischen Typnamen "${type}"`);
    }
    for (const label of ['Zeitplaene', 'Ausloeser', 'Beobachtete Ordner', 'Gekoppelte Geraete', 'Netz-Freigaben']) {
      assert.ok(index.includes(`- ${label}: `), `INDEX.md nennt "${label}" nicht`);
    }
    // Und die Tabelle darf nicht zurueckfallen, wenn schema.js eine Art dazubekommt.
    for (const type of schema.TYPES) {
      assert.ok(backupMod.TYPE_LABELS[type], `fuer den Typ "${type}" fehlt ein deutsches Label`);
    }
  } finally {
    ctx.cleanup();
  }
});

test('BEFUND 9: das Aenderungsjournal reist mit, das Netzprotokoll bleibt am Geraet', async () => {
  const source = createFakeStore();
  seed(source);
  const src = makeBackup(source, 'bk-journal-a');
  const dst = makeBackup(createFakeStore(), 'bk-journal-b');
  try {
    const eintraege = [];
    for (let i = 1; i <= 70; i++) {
      eintraege.push({ at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), seq: i, op: 'create', id: `note_${String(i).padStart(24, '0')}`, type: 'note', label: `Notiz ${i}`, before: null, actor: 'user', undone: false });
    }
    fs.writeFileSync(path.join(src.paths.vault, 'history.jsonl'), eintraege.map((e) => JSON.stringify(e)).join('\n') + '\n');
    // Das Netzprotokoll liegt daneben und darf NICHT mitgenommen werden.
    fs.writeFileSync(src.paths.audit, JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: 'net.deny', host: 'beispiel.invalid' }) + '\n');

    const exported = await src.backup.exportAll({ format: 'both' });
    const payload = readPayload(exported.dir);
    assert.equal(payload.history.entries.length, 70, 'der Aenderungsverlauf gehoert zum Wissensstand');
    assert.equal(exported.historyEntries, 70);
    const raw = fs.readFileSync(path.join(exported.dir, EXPORT_FILE), 'utf8');
    assert.ok(!raw.includes('beispiel.invalid'), 'das Netzprotokoll ist ein Geraeteprotokoll und bleibt hier');
    assert.ok(!allFiles(exported.dir).some((f) => f.includes('audit')));

    const index = fs.readFileSync(path.join(exported.dir, 'INDEX.md'), 'utf8');
    assert.match(index, /Der Aenderungsverlauf.*70 Eintraege/s);
    assert.match(index, /\*\*Das Netzprotokoll\*\* \(`audit\.jsonl`\)/);

    const result = await dst.backup.importAll({ dir: exported.dir, mode: 'merge' });
    assert.equal(result.history.inBackup, 70);
    assert.equal(result.history.written, 70);
    const restored = fs.readFileSync(path.join(dst.paths.vault, 'history.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(restored.length, 70);
    assert.equal(JSON.parse(restored[0]).label, 'Notiz 1');
    assert.equal(fs.existsSync(dst.paths.audit), false, 'das Netzprotokoll des alten Geraets darf hier nicht auftauchen');

    // Ein zweiter Import schreibt nicht daneben, sondern sagt, warum nicht.
    const zweiter = await dst.backup.importAll({ dir: exported.dir, mode: 'merge' });
    assert.equal(zweiter.history.written, 0);
    assert.match(zweiter.history.message, /NICHT eingespielt/);
    assert.ok(zweiter.warnings.some((w) => /NICHT eingespielt/.test(w)));
    assert.equal(fs.readFileSync(path.join(dst.paths.vault, 'history.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length, 70);
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

test('BEFUND 9b: ein verschluesselter Verlauf wird benannt, nicht stillschweigend verloren', async () => {
  const source = createFakeStore();
  seed(source);
  const src = makeBackup(source, 'bk-journal-enc');
  try {
    // So sieht das Journal eines verschluesselten Tresors aus: base64 statt JSON.
    fs.writeFileSync(path.join(src.paths.vault, 'history.jsonl'), `${Buffer.from('nicht lesbar').toString('base64')}\n${Buffer.from('auch nicht').toString('base64')}\n`);
    const exported = await src.backup.exportAll({ format: 'both' });
    assert.equal(exported.historyEntries, 0);
    assert.equal(exported.historySealed, 2);
    assert.ok(src.logged.warn.some((m) => /Zeilen des Aenderungsverlaufs sind verschluesselt/.test(m)));
    const index = fs.readFileSync(path.join(exported.dir, 'INDEX.md'), 'utf8');
    assert.match(index, /Verschluesselt und daher nicht mitgenommen: 2 Zeilen/);

    const dst = makeBackup(createFakeStore(), 'bk-journal-enc-b');
    try {
      const result = await dst.backup.importAll({ dir: exported.dir, mode: 'merge' });
      assert.match(result.history.message, /war verschluesselt \(2 Zeilen\)/);
      assert.ok(result.warnings.some((w) => /verschluesselt \(2 Zeilen\)/.test(w)));
    } finally {
      dst.cleanup();
    }
  } finally {
    src.cleanup();
  }
});

test('eine Sicherung der Fassung 1 laesst sich weiterhin einlesen', async () => {
  const targetStore = createFakeStore();
  const dst = makeBackup(targetStore, 'bk-v1');
  try {
    const id = `note_${'1'.repeat(24)}`;
    const file = path.join(dst.paths.exports, 'alt.json');
    fs.writeFileSync(file, JSON.stringify({
      v: 1,
      kind: 'neural-os-export',
      at: '2026-01-01T00:00:00.000Z',
      counts: { records: 1 },
      files: [],
      records: [{ id, type: 'note', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, deletedAt: null, rev: 1, data: { title: 'Alt', body: 'Aus Fassung 1' } }],
    }));
    const result = await dst.backup.importAll({ file, mode: 'merge' });
    assert.equal(result.imported, 1);
    assert.equal(targetStore.get(id).data.title, 'Alt');
    // Ohne config-Block wird nichts geaendert, und das wird gesagt.
    assert.deepEqual(result.config.applied, []);
    assert.match(result.config.message, /keine Einstellungen/);
    assert.equal(result.history.inBackup, 0);
  } finally {
    dst.cleanup();
  }
});

test('BEFUND 8: "replace" reisst keine Kanten mit, die es nur hier gibt', async () => {
  // Muss gegen engine.js laufen: der harte Purge kaskadiert dort auf die
  // Kanten eines Satzes, und genau dieser Schaden wird hier geprueft. Der
  // Ersatzspeicher oben kaskadiert nicht und wuerde nichts beweisen.
  let openStore = null;
  try {
    ({ openStore } = require('../src/store/engine'));
  } catch (err) {
    console.warn(`  ! engine.js nicht ladbar, Test uebersprungen: ${err.message}`);
    return;
  }

  const a = tempHome('bk-replace-a');
  const b = tempHome('bk-replace-b');
  let storeA = null;
  let storeB = null;
  try {
    const pathsA = pathsMod.ensureLayout(pathsMod.layout(a.home));
    const pathsB = pathsMod.ensureLayout(pathsMod.layout(b.home));
    storeA = await openStore({ paths: pathsA });
    storeB = await openStore({ paths: pathsB });
    const quiet = { warn() {}, info() {}, error() {}, debug() {} };
    const backupA = createBackup({ store: storeA, paths: pathsA, config: configMod.defaults(), logger: quiet });
    const backupB = createBackup({ store: storeB, paths: pathsB, config: configMod.defaults(), logger: quiet });

    const eins = storeA.create('note', { title: 'Eins', body: 'a' });
    const zwei = storeA.create('note', { title: 'Zwei', body: 'b' });
    storeA.edges.add({ from: eins.id, to: zwei.id, kind: 'related', source: 'manual', reason: 'aus der Sicherung' });
    const exported = await backupA.exportAll({ format: 'json' });

    await backupB.importAll({ dir: exported.dir, mode: 'fresh' });

    // Was NACH der Sicherung auf diesem Geraet entstanden ist: eine eigene
    // Notiz und zwei Kanten, die in keiner Sicherung stehen.
    const drei = storeB.create('note', { title: 'Nur hier', body: 'c' });
    const lokal1 = storeB.edges.add({ from: eins.id, to: drei.id, kind: 'links-to', source: 'manual', reason: 'hier gezogen' });
    const lokal2 = storeB.edges.add({ from: zwei.id, to: eins.id, kind: 'related', source: 'derived', reason: 'hier abgeleitet' });
    assert.equal(storeB.count('edge'), 3);

    const result = await backupB.importAll({ dir: exported.dir, mode: 'replace' });

    assert.equal(result.edgesRestored, 2, 'beide nur lokalen Kanten muessen den Ersetzen-Lauf ueberleben');
    assert.equal(storeB.count('edge'), 3, 'nach dem Ersetzen duerfen nicht weniger Kanten dastehen als davor');
    for (const edge of [lokal1, lokal2]) {
      const wieder = storeB.get(edge.id);
      assert.ok(wieder, `die nur lokale Kante ${edge.data.kind} ist verschwunden`);
      assert.equal(wieder.data.from, edge.data.from);
      assert.equal(wieder.data.to, edge.data.to);
      assert.equal(wieder.data.kind, edge.data.kind);
      assert.equal(wieder.data.reason, edge.data.reason);
    }
    assert.ok(storeB.get(drei.id), 'die nur lokale Notiz bleibt ohnehin');
    assert.ok(storeB.edges.between(eins.id, zwei.id).length > 0, 'die Kante aus der Sicherung ist auch da');

    // Und nach einem Neustart steht es wirklich auf der Platte.
    await storeB.close();
    storeB = await openStore({ paths: pathsB });
    assert.equal(storeB.count('edge'), 3);
  } finally {
    for (const st of [storeA, storeB]) {
      if (st && typeof st.close === 'function') { try { await st.close(); } catch { /* egal */ } }
    }
    a.cleanup();
    b.cleanup();
  }
});

test('BEFUND 5b: verwaiste Blobs findet die Sicherung auch im echten Dateiordner', async () => {
  let openStore = null;
  try {
    ({ openStore } = require('../src/store/engine'));
  } catch (err) {
    console.warn(`  ! engine.js nicht ladbar, Test uebersprungen: ${err.message}`);
    return;
  }
  const a = tempHome('bk-orphan-engine-a');
  const b = tempHome('bk-orphan-engine-b');
  let storeA = null;
  let storeB = null;
  try {
    const pathsA = pathsMod.ensureLayout(pathsMod.layout(a.home));
    const pathsB = pathsMod.ensureLayout(pathsMod.layout(b.home));
    storeA = await openStore({ paths: pathsA });
    storeB = await openStore({ paths: pathsB });
    const quiet = { warn() {}, info() {}, error() {}, debug() {} };
    const backupA = createBackup({ store: storeA, paths: pathsA, config: configMod.defaults(), logger: quiet });
    const backupB = createBackup({ store: storeB, paths: pathsB, config: configMod.defaults(), logger: quiet });

    const mit = storeA.files.put(Buffer.from('mit Eintrag'), { name: 'da.txt', mime: 'text/plain' });
    const ohne = storeA.files.put(Buffer.from('ohne Eintrag'), { name: 'weg.txt', mime: 'text/plain' });
    storeA.create('file', { name: 'da.txt', hash: mit.hash, mime: 'text/plain', size: 11 });
    await storeA.flush();

    const exported = await backupA.exportAll({ format: 'json' });
    assert.equal(exported.orphanFiles, 1, 'der Blob ohne Eintrag muss gefunden werden — er steht in keinem Record');

    const result = await backupB.importAll({ dir: exported.dir, mode: 'fresh' });
    assert.equal(result.orphanFiles, 1);
    assert.ok(storeB.files.read(ohne.hash).equals(Buffer.from('ohne Eintrag')), 'der Inhalt darf nicht verloren gehen');
    assert.ok(storeB.files.read(mit.hash).equals(Buffer.from('mit Eintrag')));
  } finally {
    for (const st of [storeA, storeB]) {
      if (st && typeof st.close === 'function') { try { await st.close(); } catch { /* egal */ } }
    }
    a.cleanup();
    b.cleanup();
  }
});

/* ===========================================================================
 * Der Weg für eine wirklich frische Installation: Modus `restore`.
 *
 * Die Lücke, die diese Tests schließen: eine frische Installation ist nicht
 * leer. `seedIfEmpty` legt beim ersten Start 14 Sätze an. Danach scheitert
 * `fresh` ("der Vault ist nicht leer"), und `merge` wie `replace` lassen die
 * Erstausstattung stehen -- der Mensch bekommt also NIE seinen gesicherten
 * Stand zurück, sondern immer dessen Vereinigung mit der Erstausstattung.
 * ======================================================================== */

test('restore: aus einer frischen Installation wird genau der gesicherte Stand', async () => {
  const quelle = createFakeStore();
  seed(quelle);
  const a = makeBackup(quelle, 'bk-restore-a');

  // Das Ziel ist NICHT leer: so sieht eine frische Installation nach dem
  // ersten Start aus.
  const ziel = createFakeStore();
  const erst = ziel.create('note', { title: 'Willkommen in Neural OS', body: 'Erstausstattung' });
  const eingebaut = ziel.create('agent', { name: 'Rechercheur', systemPrompt: 'knapp' });
  ziel.edges.add({ from: erst.id, to: eingebaut.id, kind: 'links-to', source: 'derived' });
  ziel.create('project', { name: 'Mein erstes Projekt' });
  const b = makeBackup(ziel, 'bk-restore-b');

  try {
    const vorher = zaehleJeArt(ziel);
    assert.ok(Object.values(vorher).reduce((x, y) => x + y, 0) >= 4, 'das Ziel muss vorbelegt sein, sonst prueft der Test nichts');

    const exportiert = await a.backup.exportAll({ format: 'json', includeFiles: true });
    const erwartet = zaehleJeArt(quelle);

    const ergebnis = await b.backup.importAll({ dir: exportiert.dir, mode: 'restore' });

    const nachher = zaehleJeArt(ziel);
    assert.deepEqual(nachher, erwartet,
      `je Satzart identisch erwartet.\n  Sicherung: ${JSON.stringify(erwartet)}\n  danach:    ${JSON.stringify(nachher)}`);
    assert.equal(ziel.get(erst.id, { includeDeleted: true }), null, 'die Erstausstattung muss weg sein');
    assert.equal(ziel.get(eingebaut.id, { includeDeleted: true }), null, 'auch der eingebaute Agent');
    assert.ok(ergebnis.purged.records >= 4, `es wurde nichts geloescht: ${JSON.stringify(ergebnis.purged)}`);
    assert.deepEqual(projection(ziel), projection(quelle), 'Inhalte, nicht nur Zahlen');
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('restore ist nicht die Voreinstellung und sagt vorher, was verschwindet', async () => {
  const quelle = createFakeStore();
  seed(quelle);
  const a = makeBackup(quelle, 'bk-restore-default-a');
  const ziel = createFakeStore();
  ziel.create('note', { title: 'Steht hier schon', body: 'x' });
  const b = makeBackup(ziel, 'bk-restore-default-b');
  try {
    const exportiert = await a.backup.exportAll({ format: 'json' });

    // Ohne Modus wird zusammengefuehrt. Ein Import, der ohne Angabe loescht,
    // waere eine Falle -- und diese Zusage muss ein Test halten, nicht ein
    // Kommentar.
    const ohneAngabe = await b.backup.importAll({ dir: exportiert.dir });
    assert.equal(ohneAngabe.mode, 'merge', 'ohne Angabe darf niemals geloescht werden');
    assert.equal(ohneAngabe.purged.records, 0);
    assert.ok(ziel.get(ziel.list('note', { limit: 100 }).items.find((n) => n.data.title === 'Steht hier schon').id),
      'die vorhandene Notiz muss den Zusammenfuehren-Lauf ueberleben');

    const vorschau = await b.backup.preview({ dir: exportiert.dir, mode: 'restore' });
    assert.equal(vorschau.mode, 'restore');
    assert.ok(vorschau.verschwindet.length, 'die Vorschau muss benennen, was verschwindet');
    assert.ok(vorschau.verschwindet.join(' ').includes(String(vorschau.hier.records)),
      `die Zahl der betroffenen Saetze muss dastehen: ${JSON.stringify(vorschau.verschwindet)}`);
    assert.ok(vorschau.hinweise.join(' ').includes('nicht rueckgaengig')
      || vorschau.hinweise.join(' ').includes('nicht rückgängig'),
    'die Unumkehrbarkeit muss dastehen');
    assert.ok(vorschau.reistNichtMit.some((s) => /token/i.test(s)), 'Zugangstoken muessen als "reist nicht mit" dastehen');
    assert.ok(vorschau.sicherung.records > 0 && Object.keys(vorschau.sicherung.byType).length > 1,
      'die Vorschau muss die Satzarten der Sicherung nennen');
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('preview() schreibt nichts — darauf baut die Ansicht auf', async () => {
  const quelle = createFakeStore();
  seed(quelle);
  const a = makeBackup(quelle, 'bk-preview-a');
  const ziel = createFakeStore();
  ziel.create('note', { title: 'Unberuehrt', body: 'x' });
  const b = makeBackup(ziel, 'bk-preview-b');
  try {
    const exportiert = await a.backup.exportAll({ format: 'json', includeFiles: true });
    const vorher = projection(ziel);
    for (const modus of ['merge', 'replace', 'fresh', 'restore']) {
      await b.backup.preview({ dir: exportiert.dir, mode: modus });
    }
    assert.deepEqual(projection(ziel), vorher, 'keine einzige Vorschau darf etwas veraendert haben');
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('restore loescht keine Anhaenge, wenn die Sicherung gar keine traegt', async () => {
  // Der gefaehrliche Fall: ein Export mit includeFiles:false hat nie
  // behauptet, Dateien zu enthalten. Wuerde `restore` daraufhin die
  // vorhandenen Blobs loeschen, waere die "Wiederherstellung" ein Datenverlust.
  const quelle = createFakeStore();
  seed(quelle);
  const a = makeBackup(quelle, 'bk-restore-nofiles-a');
  const ziel = createFakeStore();
  const eigener = ziel.files.put(Buffer.from('gehoert diesem Geraet'), { name: 'eigen.txt', mime: 'text/plain' });
  const b = makeBackup(ziel, 'bk-restore-nofiles-b');
  try {
    const exportiert = await a.backup.exportAll({ format: 'json', includeFiles: false });
    const ergebnis = await b.backup.importAll({ dir: exportiert.dir, mode: 'restore' });
    assert.equal(ergebnis.purged.files, 0, 'ohne Anhaenge in der Sicherung darf nichts geloescht werden');
    assert.ok(ziel.files.read(eigener.hash), 'der vorhandene Dateiinhalt muss noch da sein');
    assert.ok(ergebnis.purged.filesMessage && /keine Anhaenge/.test(ergebnis.purged.filesMessage),
      `das muss im Ergebnis stehen, nicht stillschweigend geschehen: ${ergebnis.purged.filesMessage}`);
    assert.ok(ergebnis.warnings.some((w) => /nicht rueckgaengig|nicht rückgängig/.test(w)),
      'der Loeschvorgang muss als Warnung dastehen');
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('restore raeumt Anhaenge weg, die in der Sicherung nicht stehen', async () => {
  const quelle = createFakeStore();
  seed(quelle);
  const a = makeBackup(quelle, 'bk-restore-files-a');
  const ziel = createFakeStore();
  const fremd = ziel.files.put(Buffer.from('kennt die Sicherung nicht'), { name: 'fremd.txt', mime: 'text/plain' });
  const b = makeBackup(ziel, 'bk-restore-files-b');
  try {
    const exportiert = await a.backup.exportAll({ format: 'json', includeFiles: true });
    const ergebnis = await b.backup.importAll({ dir: exportiert.dir, mode: 'restore' });
    assert.equal(ergebnis.purged.files, 1, 'genau der fremde Blob muss weg sein');
    assert.equal(ziel.files.has(fremd.hash), false);
    // Und was in der Sicherung steht, ist danach da.
    assert.ok(ergebnis.files >= 2, `die Anhaenge der Sicherung muessen ankommen: ${ergebnis.files}`);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('restore spielt den Aenderungsverlauf ein, auch wenn hier schon einer steht', async () => {
  // Der gemessene Fall: seedIfEmpty erzeugt ueber den Bus Journalzeilen, bevor
  // irgendjemand wiederherstellt. `merge` laesst die Sicherung deshalb liegen
  // (zwei Verlaeufe lassen sich nicht zusammenfuehren) -- `restore` darf das
  // nicht, denn die Saetze, die der hiesige Verlauf beschreibt, hat er gerade
  // geloescht.
  const quelle = createFakeStore();
  seed(quelle);
  const a = makeBackup(quelle, 'bk-restore-journal-a');
  const ziel = createFakeStore();
  const b = makeBackup(ziel, 'bk-restore-journal-b');
  try {
    const journalA = path.join(a.paths.vault, 'history.jsonl');
    const zeilen = [];
    for (let i = 0; i < 30; i++) zeilen.push(JSON.stringify({ seq: i, op: 'update', id: `note_${i}` }));
    fs.writeFileSync(journalA, zeilen.join('\n') + '\n');

    const journalB = path.join(b.paths.vault, 'history.jsonl');
    fs.writeFileSync(journalB, JSON.stringify({ seq: 1, op: 'create', id: 'note_erstausstattung' }) + '\n');

    const exportiert = await a.backup.exportAll({ format: 'json' });
    assert.equal(exportiert.historyEntries, 30);

    const ergebnis = await b.backup.importAll({ dir: exportiert.dir, mode: 'restore' });
    assert.equal(ergebnis.history.written, 30, `der Verlauf muss ankommen: ${ergebnis.history.message}`);
    assert.equal(ergebnis.history.replaced, 1, 'und die Zeile des Geraets ersetzen');
    const danach = fs.readFileSync(journalB, 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(danach.length, 30);
    assert.ok(!danach.join('\n').includes('note_erstausstattung'), 'die alte Zeile darf nicht stehenbleiben');

    // Gegenprobe: bei jedem anderen Modus bleibt der Verlauf des Geraets liegen.
    const ziel2 = createFakeStore();
    const c = makeBackup(ziel2, 'bk-restore-journal-c');
    try {
      const journalC = path.join(c.paths.vault, 'history.jsonl');
      fs.writeFileSync(journalC, JSON.stringify({ seq: 1, op: 'create', id: 'note_bleibt' }) + '\n');
      const r2 = await c.backup.importAll({ dir: exportiert.dir, mode: 'merge' });
      assert.equal(r2.history.written, 0);
      assert.ok(fs.readFileSync(journalC, 'utf8').includes('note_bleibt'));
    } finally {
      c.cleanup();
    }
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('ein unbekannter Modus wird abgelehnt und nennt alle erlaubten', async () => {
  const store = createFakeStore();
  const ctx = makeBackup(store, 'bk-modus-unbekannt');
  try {
    await assert.rejects(
      () => ctx.backup.importAll({ dir: ctx.paths.exports, mode: 'loeschen' }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        for (const m of ['merge', 'replace', 'fresh', 'restore']) {
          assert.ok(err.message.includes(m), `der erlaubte Modus ${m} muss in der Meldung stehen: ${err.message}`);
        }
        return true;
      },
    );
    await assert.rejects(() => ctx.backup.preview({ dir: ctx.paths.exports, mode: 'loeschen' }), ValidationError);
  } finally {
    ctx.cleanup();
  }
});

module.exports = { name: 'backup', tests: drain() };
