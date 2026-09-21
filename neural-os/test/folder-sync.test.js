'use strict';

/**
 * Synchronisation through a shared folder (a USB stick).
 *
 * Two REAL installations in two throwaway homes, two real stores writing real
 * append-only logs, and a third throwaway directory standing in for the stick.
 * Nothing on the merge path is stubbed: when a test says a conflict was
 * raised, a real conflict record went through a real `store.transaction`, and
 * when a test says nothing was written, it looks at the actual file.
 *
 * Nothing here touches the network or the real home directory.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { test, tempHome } = require('./harness');

const merge = require('../src/sync/merge');
const folderMod = require('../src/sync/folder');
const { createFolderSync, MANIFEST_NAME, RECORDS_NAME, FOLDER_PROTOCOL, FORMAT } = folderMod;

const { openStore } = require('../src/store/engine');
const { createVaultCrypto } = require('../src/store/vaultcrypto');
const { Bus } = require('../src/kernel/bus');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');

const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

/* ------------------------------------------------------------- fixtures */

/**
 * A device: its own home, its own store, its own folder-sync instance.
 * `secretsFrom` copies another device's key material, which is what two
 * devices actually have to do to exchange an encrypted mailbox.
 */
async function makeDevice(label, opts = {}) {
  const { home, cleanup } = tempHome(`nos-folder-${label}`);
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.sync = { deviceName: label };

  const bus = new Bus();
  let vaultCrypto = null;
  if (opts.secretsFrom) fs.copyFileSync(opts.secretsFrom, paths.secrets);
  if (opts.passphrase) {
    vaultCrypto = createVaultCrypto({ paths, config });
    if (opts.secretsFrom) await vaultCrypto.unlock(opts.passphrase);
    else await vaultCrypto.initialise(opts.passphrase);
  }

  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto });
  const sync = createFolderSync({ store, merge, bus, logger: silentLogger, config, vaultCrypto, paths });

  const events = [];
  bus.subscribe((evt) => { if (evt.name.startsWith('sync.')) events.push(evt); });

  return {
    label,
    home,
    paths,
    config,
    bus,
    store,
    vaultCrypto,
    sync,
    events,
    get deviceId() { return sync.deviceId; },
    async close() {
      await store.close().catch(() => {});
      cleanup();
    },
  };
}

function makeStick(label = 'stick') {
  const { home, cleanup } = tempHome(`nos-folder-${label}`);
  return { dir: home, cleanup };
}

function fakeDeviceId() {
  return `dev_${crypto.randomBytes(12).toString('hex')}`;
}

function recordsPath(stick, deviceId) {
  return path.join(stick, deviceId, RECORDS_NAME);
}

function manifestPath(stick, deviceId) {
  return path.join(stick, deviceId, MANIFEST_NAME);
}

function readManifest(stick, deviceId) {
  return JSON.parse(fs.readFileSync(manifestPath(stick, deviceId), 'utf8'));
}

/** What is REALLY in the mailbox, read straight off the disk. */
function mailboxRecords(stick, deviceId) {
  const raw = zlib.gunzipSync(fs.readFileSync(recordsPath(stick, deviceId))).toString('utf8');
  return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/**
 * Write a mailbox by hand -- the stand-in for "somebody else's stick". It
 * produces exactly the layout folder.js produces, so a test can plant lines
 * that no well-behaved writer would ever produce.
 */
function writeMailbox(stick, deviceId, lines, over = {}) {
  const dir = path.join(stick, deviceId);
  fs.mkdirSync(dir, { recursive: true });
  const payload = zlib.gzipSync(Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8'));
  fs.writeFileSync(path.join(dir, RECORDS_NAME), payload);
  const manifest = {
    protocol: FOLDER_PROTOCOL,
    format: FORMAT,
    deviceId,
    deviceName: 'Fremdgerät',
    at: new Date().toISOString(),
    count: lines.length,
    appVersion: '0.1.0',
    encrypted: false,
    bytes: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    ...over,
  };
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

function rec(type, id, data, over = {}) {
  return {
    id,
    type,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    rev: 1,
    data,
    ...over,
  };
}

const NOTE_ID = 'note_aaaaaaaaaaaaaaaaaaaaaaaa';

async function withPair(fn, opts = {}) {
  const a = await makeDevice('a', opts.a);
  const b = await makeDevice('b', opts.b);
  const stick = makeStick();
  try {
    assert.notEqual(a.deviceId, b.deviceId, 'zwei Installationen müssen zwei Kennungen haben');
    await fn({ a, b, stick: stick.dir });
  } finally {
    await b.close();
    await a.close();
    stick.cleanup();
  }
}

/* ============================================================== transport */

test('(a) eine einseitige Änderung kommt über den Ordner an', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'Von A', body: 'Text von A' });

    const published = await a.sync.publish(stick);
    assert.equal(published.written, 1);
    assert.equal(published.deviceId, a.deviceId);
    assert.ok(published.bytes > 0);

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].ok, true, boxes[0].problem || '');
    assert.equal(boxes[0].deviceId, a.deviceId);
    assert.equal(boxes[0].deviceName, 'a');
    assert.equal(boxes[0].isSelf, false);
    assert.equal(boxes[0].count, 1);

    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(pulled.fetched, 1);
    assert.equal(pulled.applied, 1);
    assert.equal(pulled.conflicts, 0);

    const notes = b.store.list('note').items;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, a.store.list('note').items[0].id);
    assert.equal(notes[0].data.title, 'Von A');
    assert.equal(notes[0].data.body, 'Text von A');
  });
});

test('(a) auch Löschungen reisen mit, sonst kommen sie zurück', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'kurzlebig' });
    await a.sync.publish(stick);
    await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(b.store.count('note'), 1);

    a.store.remove(note.id);
    await a.sync.publish(stick);
    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });

    assert.equal(pulled.applied, 1);
    assert.equal(b.store.count('note'), 0);
    assert.ok(b.store.get(note.id, { includeDeleted: true }).deletedAt, 'ein Grabstein muss bleiben');
  });
});

test('das eigene Postfach wird erkannt und nicht gegen sich selbst abgeglichen', async () => {
  await withPair(async ({ a, stick }) => {
    a.store.create('note', { title: 'x' });
    await a.sync.publish(stick);

    const boxes = await a.sync.peers(stick);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].isSelf, true);

    await assert.rejects(
      () => a.sync.pull(stick, { deviceId: a.deviceId }),
      /eigene Postfach/,
    );

    const all = await a.sync.syncAll(stick);
    assert.equal(all.applied, 0);
    assert.equal(all.peers.length, 0, 'das eigene Postfach ist kein Partner');
  });
});

/* ============================================================== conflicts */

test('(b) beide Seiten ändern denselben Eintrag: Konflikt, und nichts wird überschrieben', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'gemeinsam', body: 'Ausgangstext' });

    // Ein vollständiger Umlauf, damit beide Seiten denselben Stand als
    // vereinbart kennen -- erst danach ist ein Konflikt ein echter Konflikt.
    await a.sync.publish(stick);
    await b.sync.syncAll(stick);
    await a.sync.syncAll(stick);
    assert.equal(b.store.get(note.id).data.body, 'Ausgangstext');

    a.store.update(note.id, { body: 'A hat weitergeschrieben' });
    b.store.update(note.id, { body: 'B hat etwas anderes geschrieben' });

    await a.sync.publish(stick);
    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });

    assert.equal(pulled.conflicts, 1);
    assert.equal(pulled.applied, 0, 'bei einem Konflikt wird nichts angewendet');

    // Der entscheidende Punkt: der lokale Datensatz bleibt unangetastet.
    assert.equal(b.store.get(note.id).data.body, 'B hat etwas anderes geschrieben');

    const conflicts = b.store.list('conflict').items;
    assert.equal(conflicts.length, 1);
    const c = conflicts[0].data;
    assert.equal(c.status, 'open');
    assert.equal(c.recordId, note.id);
    assert.equal(c.origin, 'folder');
    assert.equal(c.originDeviceId, a.deviceId);
    // BEIDE Fassungen liegen vollständig im Konflikt.
    assert.equal(c.local.data.body, 'B hat etwas anderes geschrieben');
    assert.equal(c.remote.data.body, 'A hat weitergeschrieben');
    assert.ok(c.reason.length > 0);

    // Und in der Gegenrichtung genauso.
    await b.sync.publish(stick);
    const back = await a.sync.pull(stick, { deviceId: b.deviceId });
    assert.equal(back.conflicts, 1);
    assert.equal(a.store.get(note.id).data.body, 'A hat weitergeschrieben');
  });
});

test('(b) derselbe Konflikt entsteht beim erneuten Abgleich nicht doppelt', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'gemeinsam', body: 'Start' });
    await a.sync.publish(stick);
    await b.sync.syncAll(stick);
    await a.sync.syncAll(stick);

    a.store.update(note.id, { body: 'A' });
    b.store.update(note.id, { body: 'B' });
    await a.sync.publish(stick);

    await b.sync.pull(stick, { deviceId: a.deviceId });
    await b.sync.pull(stick, { deviceId: a.deviceId });

    assert.equal(b.store.list('conflict').total, 1, 'ein offener Konflikt je Eintrag und Gerät');
    assert.equal(b.store.get(note.id).data.body, 'B');
  });
});

test('eine entschiedene Fassung erzeugt beim nächsten Abgleich keinen neuen Konflikt', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'gemeinsam', body: 'Start' });
    await a.sync.publish(stick);
    await b.sync.syncAll(stick);
    await a.sync.syncAll(stick);

    a.store.update(note.id, { body: 'A' });
    b.store.update(note.id, { body: 'B bleibt' });
    await a.sync.publish(stick);
    await b.sync.pull(stick, { deviceId: a.deviceId });

    const conflict = b.store.list('conflict').items[0];
    // Genau die Felder, die src/sync/peer.js beim Auflösen schreibt: der
    // Nutzer behält die eigene Fassung.
    b.store.update(conflict.id, {
      status: 'resolved',
      resolution: 'local',
      resolvedAt: new Date().toISOString(),
    });

    const again = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(again.conflicts, 0, 'eine Entscheidung ist auch eine Vereinbarung');
    assert.equal(again.applied, 0);
    assert.equal(b.store.get(note.id).data.body, 'B bleibt');
    const open = b.store.list('conflict', { filter: (r) => r.data.status === 'open' });
    assert.equal(open.total, 0, 'kein neuer offener Konflikt');
    assert.equal(b.store.list('conflict').total, 1, 'die Entscheidung selbst bleibt nachlesbar');
  });
});

/* ============================================================ idempotence */

test('(c) zweimal abgleichen ohne Änderung dazwischen tut nichts', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'von A' });
    b.store.create('note', { title: 'von B' });

    await a.sync.syncAll(stick);
    await b.sync.syncAll(stick);
    await a.sync.syncAll(stick);
    await b.sync.syncAll(stick);

    assert.equal(a.store.count('note'), 2);
    assert.equal(b.store.count('note'), 2);

    const conflictsBefore = b.store.list('conflict', { includeDeleted: true }).total;

    const first = await b.sync.syncAll(stick);
    const second = await b.sync.syncAll(stick);
    const third = await a.sync.syncAll(stick);

    for (const [label, run] of [['1', first], ['2', second], ['3', third]]) {
      assert.equal(run.applied, 0, `Durchgang ${label} hat etwas angewendet`);
      assert.equal(run.conflicts, 0, `Durchgang ${label} hat einen Konflikt erzeugt`);
      assert.equal(run.ok, true, `Durchgang ${label}: ${run.warnings.join(' | ')}`);
    }
    assert.equal(b.store.list('conflict', { includeDeleted: true }).total, conflictsBefore);
    assert.equal(a.store.count('note'), 2);
    assert.equal(b.store.count('note'), 2);
  });
});

test('Verknüpfungen kommen mit, auch wenn sie vor ihren Knoten in der Datei stehen', async () => {
  await withPair(async ({ a, b, stick }) => {
    const one = a.store.create('note', { title: 'eins' });
    const two = a.store.create('note', { title: 'zwei' });
    const edge = a.store.edges.add({ from: one.id, to: two.id, kind: 'related', reason: 'Test' });

    await a.sync.publish(stick);
    // Kante zuerst: genau der Fall, der ohne Zurückstellen scheitern würde.
    const lines = mailboxRecords(stick, a.deviceId);
    const reordered = [
      ...lines.filter((r) => r.type === 'edge'),
      ...lines.filter((r) => r.type !== 'edge'),
    ].map((r) => JSON.stringify(r));
    writeMailbox(stick, a.deviceId, reordered, { deviceName: 'a' });

    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(pulled.applied, 3);
    assert.equal(b.store.count('edge'), 1);
    assert.equal(b.store.get(edge.id).data.from, one.id);

    const again = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(again.applied, 0);
    assert.equal(again.conflicts, 0);
  });
});

/* ====================================================== half-written stick */

test('(d) ein Postfach ohne Beschreibungsdatei wird übersprungen, nicht halb eingelesen', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'darf nicht ankommen' });
    await a.sync.publish(stick);

    // Abgezogen zwischen den beiden Umbenennungen: Datensätze da, Beschreibung nicht.
    fs.unlinkSync(manifestPath(stick, a.deviceId));
    fs.writeFileSync(path.join(stick, a.deviceId, '.tmp-4711'), 'halb geschrieben');

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].ok, false);
    assert.match(boxes[0].problem, /geschrieben|unvollständig/);

    await assert.rejects(
      () => b.sync.pull(stick, { deviceId: a.deviceId }),
      (err) => err.code === 'SYNC_MAILBOX_INVALID',
    );

    const run = await b.sync.syncAll(stick);
    assert.equal(run.applied, 0);
    assert.ok(run.warnings.some((w) => w.includes('übersprungen')), run.warnings.join(' | '));
    assert.equal(b.store.count('note'), 0, 'es darf kein einziger Datensatz angekommen sein');
  });
});

test('(d) eine abgeschnittene Datensatzdatei wird an der Grösse erkannt', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'darf nicht ankommen' });
    await a.sync.publish(stick);

    const file = recordsPath(stick, a.deviceId);
    const full = fs.readFileSync(file);
    fs.writeFileSync(file, full.subarray(0, full.length - 5));

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes[0].ok, false);
    assert.match(boxes[0].problem, /halb geschrieben|halb kopiert/);

    await assert.rejects(
      () => b.sync.pull(stick, { deviceId: a.deviceId }),
      (err) => err.code === 'SYNC_MAILBOX_INVALID',
    );
    assert.equal(b.store.count('note'), 0);
  });
});

test('(d) beschädigte Bytes werden VOR dem Anwenden an der Prüfsumme erkannt', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'darf nicht ankommen' });
    await a.sync.publish(stick);

    // Gleiche Grösse, anderer Inhalt -- das überlebt jede reine Längenprüfung.
    const file = recordsPath(stick, a.deviceId);
    const buf = fs.readFileSync(file);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    fs.writeFileSync(file, buf);

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes[0].ok, true, 'die Grösse stimmt ja noch');

    await assert.rejects(
      () => b.sync.pull(stick, { deviceId: a.deviceId }),
      /Prüfsumme/,
    );
    assert.equal(b.store.count('note'), 0, 'nichts wurde angewendet');
  });
});

test('(d) eine Datei, die gar kein Gzip ist, bricht sauber ab statt Müll zu liefern', async () => {
  await withPair(async ({ b, stick }) => {
    const foreign = fakeDeviceId();
    writeMailbox(stick, foreign, [JSON.stringify(rec('note', NOTE_ID, { title: 'x' }))]);

    // Prüfsumme und Grösse passen -- die Datei ist trotzdem kein Archiv.
    const junk = Buffer.from('das war nie ein gzip-Strom', 'utf8');
    fs.writeFileSync(recordsPath(stick, foreign), junk);
    const manifest = readManifest(stick, foreign);
    manifest.bytes = junk.length;
    manifest.sha256 = crypto.createHash('sha256').update(junk).digest('hex');
    fs.writeFileSync(manifestPath(stick, foreign), JSON.stringify(manifest));

    await assert.rejects(
      () => b.sync.pull(stick, { deviceId: foreign }),
      (err) => typeof err.code === 'string' && /abgebrochen/.test(err.message),
    );
    assert.equal(b.store.count('note'), 0);
  });
});

test('ein Postfach ohne Prüfsumme wird nicht gelesen', async () => {
  await withPair(async ({ b, stick }) => {
    const foreign = fakeDeviceId();
    writeMailbox(stick, foreign, [JSON.stringify(rec('note', NOTE_ID, { title: 'x' }))], { sha256: undefined });
    // sha256 wieder entfernen: writeMailbox setzt es, `over` überschreibt mit undefined.
    const manifest = readManifest(stick, foreign);
    delete manifest.sha256;
    fs.writeFileSync(manifestPath(stick, foreign), JSON.stringify(manifest));

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes[0].ok, false);
    assert.match(boxes[0].problem, /Prüfsumme/);
    assert.equal(b.store.count('note'), 0);
  });
});

/* ================================================ what may never travel */

test('(e) Token, Agenten, Module, Freigaben und Partner stehen NIE im Postfach', async () => {
  await withPair(async ({ a, stick }) => {
    a.store.create('note', { title: 'erlaubt', body: 'darf reisen' });
    a.store.create('token', {
      label: 'Freigabe-Token',
      hash: 'HASHGEHEIMNIS1',
      salt: 'SALTGEHEIMNIS2',
      permissions: { read: true, write: true, sync: true },
    });
    a.store.create('agent', {
      name: 'AGENTGEHEIMNIS3',
      permissions: { network: 'online', allowedHosts: ['*'], writeFiles: true, fileRoots: ['/'] },
    });
    a.store.create('module', { name: 'MODULGEHEIMNIS4', source: 'process.exit(1)' });
    a.store.create('grant', { scope: 'global', level: 'online', hosts: ['*'], reason: 'GRANTGEHEIMNIS5' });
    a.store.create('peer', { name: 'PEERGEHEIMNIS6', url: 'http://192.168.1.5:7777', token: 'TOKENGEHEIMNIS7' });
    a.store.create('run', { agentId: 'agent_aaaaaaaaaaaaaaaaaaaaaaaa', goal: 'RUNGEHEIMNIS8' });
    a.store.create('approval', { kind: 'network', summary: 'APPROVALGEHEIMNIS9' });

    const published = await a.sync.publish(stick);
    assert.equal(published.written, 1, 'nur die Notiz darf geschrieben worden sein');

    // Die Datei selbst, nicht der Rückgabewert.
    const records = mailboxRecords(stick, a.deviceId);
    assert.equal(records.length, 1);
    for (const record of records) {
      assert.ok(merge.SYNC_TYPES.includes(record.type), `Art "${record.type}" gehört nicht ins Postfach`);
    }
    const types = new Set(records.map((r) => r.type));
    for (const forbidden of ['token', 'agent', 'module', 'grant', 'peer', 'run', 'approval', 'conflict']) {
      assert.equal(types.has(forbidden), false, `"${forbidden}" liegt im Postfach`);
    }

    const rawBytes = fs.readFileSync(recordsPath(stick, a.deviceId));
    const plain = zlib.gunzipSync(rawBytes).toString('utf8');
    for (const secret of [
      'HASHGEHEIMNIS1', 'SALTGEHEIMNIS2', 'AGENTGEHEIMNIS3', 'MODULGEHEIMNIS4',
      'GRANTGEHEIMNIS5', 'PEERGEHEIMNIS6', 'TOKENGEHEIMNIS7', 'RUNGEHEIMNIS8', 'APPROVALGEHEIMNIS9',
      'process.exit',
    ]) {
      assert.equal(plain.includes(secret), false, `"${secret}" steht auf dem Datenträger`);
    }
    // Und auch nicht in der Beschreibungsdatei.
    const manifest = fs.readFileSync(manifestPath(stick, a.deviceId), 'utf8');
    assert.equal(manifest.includes('GEHEIMNIS'), false);
  });
});

test('(e) ein fremder Stick kann weder Rechte noch Agenten noch Code einschleusen', async () => {
  await withPair(async ({ b, stick }) => {
    const hostile = fakeDeviceId();
    writeMailbox(stick, hostile, [
      JSON.stringify(rec('note', NOTE_ID, { title: 'harmlos', body: '', tags: [], pinned: false, source: 'user' })),
      JSON.stringify(rec('agent', 'agent_bbbbbbbbbbbbbbbbbbbbbbbb', {
        name: 'Übernahme',
        permissions: { network: 'online', allowedHosts: ['*'], writeFiles: true, fileRoots: ['/'], requireApproval: false },
      })),
      JSON.stringify(rec('token', 'token_cccccccccccccccccccccccc', { label: 'Hintertür', hash: 'h', salt: 's', permissions: { read: true, write: true, sync: true } })),
      JSON.stringify(rec('grant', 'grant_dddddddddddddddddddddddd', { scope: 'global', level: 'online', hosts: ['*'] })),
      JSON.stringify(rec('module', 'module_eeeeeeeeeeeeeeeeeeeeeeee', { name: 'Schadcode', source: 'require("fs").rmSync("/",{recursive:true})' })),
      JSON.stringify(rec('peer', 'peer_ffffffffffffffffffffffff', { name: 'fremd', url: 'http://10.0.0.1:7777', token: 'geheim' })),
    ]);

    const pulled = await b.sync.pull(stick, { deviceId: hostile });

    assert.equal(pulled.applied, 1, 'nur die Notiz');
    assert.equal(pulled.fetched, 1);
    assert.equal(b.store.count('note'), 1);
    for (const forbidden of ['agent', 'token', 'grant', 'module', 'peer']) {
      assert.equal(b.store.count(forbidden), 0, `"${forbidden}" wurde vom Stick übernommen`);
    }
    assert.ok(
      pulled.warnings.some((w) => w.includes('NICHT übernommen')),
      `es muss gemeldet werden, was abgelehnt wurde: ${pulled.warnings.join(' | ')}`,
    );
  });
});

/* =========================================================== broken lines */

test('(f) eine beschädigte Zeile wird übersprungen, gezählt und gemeldet', async () => {
  await withPair(async ({ b, stick }) => {
    const foreign = fakeDeviceId();
    writeMailbox(stick, foreign, [
      JSON.stringify(rec('note', 'note_111111111111111111111111', { title: 'erste', body: '', tags: [], pinned: false, source: 'user' })),
      '{ das ist kein JSON und war einmal eine Zeile',
      JSON.stringify(rec('note', 'note_222222222222222222222222', { title: 'zweite', body: '', tags: [], pinned: false, source: 'user' })),
      '',
      '{"id":"ohne_typ"}',
      JSON.stringify(rec('note', 'note_333333333333333333333333', { title: 'dritte', body: '', tags: [], pinned: false, source: 'user' })),
    ]);

    const pulled = await b.sync.pull(stick, { deviceId: foreign });

    assert.equal(pulled.corrupt, 2, 'kaputte Zeile und Zeile ohne Art');
    assert.equal(pulled.applied, 3, 'alle brauchbaren Zeilen kommen an');
    assert.equal(b.store.count('note'), 3);
    assert.ok(
      pulled.warnings.some((w) => w.includes('unlesbar')),
      `beschädigte Zeilen müssen gemeldet werden: ${pulled.warnings.join(' | ')}`,
    );
  });
});

/* ============================================================ encryption */

test('(g) bei aktiver Verschlüsselung steht im Postfach kein lesbarer Klartext', async () => {
  const enc = await makeDevice('enc', { passphrase: 'stick-passphrase-1' });
  const plain = await makeDevice('plain');
  const stick = makeStick();
  try {
    enc.store.create('note', { title: 'GEHEIMNIS-XYZ', body: 'streng vertraulich ABC' });

    const published = await enc.sync.publish(stick.dir);
    assert.equal(published.encrypted, true);
    assert.equal(
      published.warnings.some((w) => w.includes('Klartext')),
      false,
      'bei Verschlüsselung darf nicht vor Klartext gewarnt werden',
    );

    const raw = fs.readFileSync(recordsPath(stick.dir, enc.deviceId));
    assert.equal(raw.includes('GEHEIMNIS-XYZ'), false);
    assert.equal(raw.includes('vertraulich'), false);
    assert.equal(raw.includes('note'), false);
    assert.throws(() => zlib.gunzipSync(raw), 'verschlüsselt heisst: nicht einmal entpackbar');

    // Die Beschreibungsdatei bleibt lesbar -- sie sagt WER geschrieben hat,
    // aber nichts darüber, WAS.
    const manifest = readManifest(stick.dir, enc.deviceId);
    assert.equal(manifest.encrypted, true);
    assert.equal(manifest.deviceId, enc.deviceId);
    assert.equal(manifest.count, 1);
    assert.equal(JSON.stringify(manifest).includes('GEHEIMNIS'), false);

    // Ein Gerät ohne den Schlüssel sagt das, statt Müll zu liefern.
    const boxes = await plain.sync.peers(stick.dir);
    assert.equal(boxes[0].ok, true);
    assert.equal(boxes[0].encrypted, true);
    await assert.rejects(
      () => plain.sync.pull(stick.dir, { deviceId: enc.deviceId }),
      /verschlüsselt/,
    );
    assert.equal(plain.store.count('note'), 0);
  } finally {
    await plain.close();
    await enc.close();
    stick.cleanup();
  }
});

test('ein Gerät mit demselben Schlüssel liest das verschlüsselte Postfach', async () => {
  const enc = await makeDevice('enc2', { passphrase: 'stick-passphrase-2' });
  const stick = makeStick();
  let twin = null;
  try {
    enc.store.create('note', { title: 'verschlüsselt gereist', body: 'Inhalt' });
    await enc.sync.publish(stick.dir);

    // Zwei Vaults haben verschiedene Zufallsschlüssel; dieselbe Passphrase
    // genügt NICHT. Das Schlüsselmaterial muss übernommen werden.
    twin = await makeDevice('twin', { passphrase: 'stick-passphrase-2', secretsFrom: enc.paths.secrets });
    const pulled = await twin.sync.pull(stick.dir, { deviceId: enc.deviceId });

    assert.equal(pulled.applied, 1);
    assert.equal(twin.store.list('note').items[0].data.title, 'verschlüsselt gereist');
  } finally {
    if (twin) await twin.close();
    await enc.close();
    stick.cleanup();
  }
});

test('ohne Verschlüsselung warnt das Ergebnis vor Klartext auf dem Datenträger', async () => {
  await withPair(async ({ a, stick }) => {
    a.store.create('note', { title: 'offen lesbar' });
    const published = await a.sync.publish(stick);
    assert.equal(published.encrypted, false);
    assert.ok(
      published.warnings.some((w) => w.includes('Klartext')),
      published.warnings.join(' | '),
    );
  });
});

/* ================================================================= clocks */

test('bei abweichenden Uhren wird eine eingehende Löschung zum Konflikt statt zum Sieger', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'bleibt bitte da' });
    await a.sync.publish(stick);
    await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(b.store.count('note'), 1);

    a.store.remove(note.id);
    await a.sync.publish(stick);

    // Die Uhr von A geht zwanzig Minuten vor. Die Prüfsumme deckt nur die
    // Datensatzdatei ab, der Zeitstempel steht daneben.
    const manifest = readManifest(stick, a.deviceId);
    manifest.at = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    fs.writeFileSync(manifestPath(stick, a.deviceId), JSON.stringify(manifest));

    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });

    assert.equal(pulled.conflicts, 1);
    assert.equal(b.store.count('note'), 1, 'die Löschung darf nicht ausgeführt worden sein');
    assert.ok(
      pulled.warnings.some((w) => w.includes('Uhr')),
      `die Abweichung muss gemeldet werden: ${pulled.warnings.join(' | ')}`,
    );
    assert.ok(Math.abs(pulled.clockSkewMs) > 5 * 60 * 1000);
  });
});

/* ================================================================ inspect */

test('inspect beschreibt den Ordner, ohne etwas zu verändern', async () => {
  await withPair(async ({ a, b, stick }) => {
    const before = await b.sync.inspect(stick);
    assert.equal(before.ok, false);
    assert.equal(before.mailboxes.length, 0);
    assert.ok(before.problems.some((p) => p.includes('noch kein Postfach')), before.problems.join(' | '));
    assert.equal(before.writable, true);
    assert.deepEqual(fs.readdirSync(stick), [], 'inspect darf nichts anlegen');

    a.store.create('note', { title: 'x' });
    await a.sync.publish(stick);
    await b.sync.publish(stick);

    const after = await b.sync.inspect(stick);
    assert.equal(after.mailboxes.length, 2);
    assert.ok(after.bytes > 0);
    assert.equal(after.ok, true, after.problems.join(' | '));
    assert.equal(after.deviceId, b.deviceId);
  });
});

test('ein kaputtes Postfach taucht in inspect mit Begründung auf', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'x' });
    await a.sync.publish(stick);
    await b.sync.publish(stick);
    fs.writeFileSync(manifestPath(stick, a.deviceId), '{ kaputt');

    const info = await b.sync.inspect(stick);
    assert.equal(info.ok, false);
    assert.ok(info.problems.some((p) => p.includes('beschädigt')), info.problems.join(' | '));
    assert.equal(info.mailboxes.find((m) => m.deviceId === a.deviceId).ok, false);
  });
});

/* ============================================================ bad input */

test('unbrauchbare Eingaben führen zu typisierten Fehlern mit deutscher Erklärung', async () => {
  await withPair(async ({ a, stick }) => {
    await assert.rejects(() => a.sync.publish(''), (err) => err.code === 'VALIDATION_FAILED');
    await assert.rejects(
      () => a.sync.publish(path.join(stick, 'gibt-es-nicht')),
      (err) => err.code === 'NOT_FOUND' && /Stick angesteckt/.test(err.message),
    );
    await assert.rejects(
      () => a.sync.publish(path.join(a.paths.vault, 'sync')),
      (err) => err.code === 'VALIDATION_FAILED' && /Vault/.test(err.message),
    );
    await assert.rejects(
      () => a.sync.pull(stick, { deviceId: 'kein-gerät' }),
      (err) => err.code === 'VALIDATION_FAILED',
    );
    await assert.rejects(
      () => a.sync.pull(stick, { deviceId: fakeDeviceId() }),
      (err) => err.code === 'SYNC_MAILBOX_INVALID' || err.code === 'NOT_FOUND',
    );

    // Eine Datei statt eines Ordners.
    const file = path.join(stick, 'datei.txt');
    fs.writeFileSync(file, 'x');
    await assert.rejects(() => a.sync.publish(file), (err) => err.code === 'VALIDATION_FAILED');
  });
});

test('fremde Unterordner im Abgleich-Ordner stören nicht', async () => {
  await withPair(async ({ a, b, stick }) => {
    fs.mkdirSync(path.join(stick, 'Urlaubsfotos'));
    fs.writeFileSync(path.join(stick, 'liesmich.txt'), 'nichts für uns');
    a.store.create('note', { title: 'x' });
    await a.sync.publish(stick);

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].deviceId, a.deviceId);

    const run = await b.sync.syncAll(stick);
    assert.equal(run.applied, 1);
    assert.equal(run.ok, true, run.warnings.join(' | '));
  });
});

test('ein Postfach mit falschem Ordnernamen wird gemeldet und nicht gelesen', async () => {
  await withPair(async ({ b, stick }) => {
    const real = fakeDeviceId();
    writeMailbox(stick, real, [JSON.stringify(rec('note', NOTE_ID, { title: 'x' }))]);
    fs.renameSync(path.join(stick, real), path.join(stick, 'kopie-vom-postfach'));

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].ok, false);
    assert.match(boxes[0].problem, /Geräte-Kennung/);
    assert.equal(b.store.count('note'), 0);
  });
});

/* ============================================================== reporting */

test('syncAll meldet Fortschritt und veröffentlicht den bereits zusammengeführten Stand', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'von A' });
    await a.sync.publish(stick);

    const phases = [];
    const run = await b.sync.syncAll(stick, { onProgress: (p) => phases.push(p.phase) });

    assert.equal(run.applied, 1);
    assert.ok(run.published, 'der eigene Stand muss geschrieben werden');
    // Zuerst lesen, dann schreiben: A's Notiz liegt danach auch in B's Postfach,
    // damit ein drittes Gerät sie in einem Schritt bekommt.
    assert.equal(run.published.written, 1);
    assert.deepEqual(mailboxRecords(stick, b.deviceId).map((r) => r.data.title), ['von A']);
    assert.ok(phases.includes('apply'));
    assert.ok(phases.includes('write'));

    assert.ok(b.events.some((e) => e.name === 'sync.folder'));
  });
});

test('ein leerer Ordner ist kein Fehler, sondern eine Ansage', async () => {
  await withPair(async ({ a, stick }) => {
    const run = await a.sync.syncAll(stick);
    assert.equal(run.ok, true);
    assert.equal(run.peers.length, 0);
    assert.ok(
      run.warnings.some((w) => w.includes('noch kein Postfach')),
      run.warnings.join(' | '),
    );
    assert.ok(fs.existsSync(manifestPath(stick, a.deviceId)));
  });
});

test('ein leeres Postfach ist kein Sonderfall', async () => {
  await withPair(async ({ a, b, stick }) => {
    const published = await a.sync.publish(stick);
    assert.equal(published.written, 0);

    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(pulled.fetched, 0);
    assert.equal(pulled.applied, 0);
    assert.equal(pulled.conflicts, 0);
    assert.equal(pulled.corrupt, 0);
  });
});

test('ein erfolgreiches Schreiben hinterlässt keine Reste im Postfach', async () => {
  await withPair(async ({ a, stick }) => {
    a.store.create('note', { title: 'x' });
    await a.sync.publish(stick);
    await a.sync.publish(stick);

    const entries = fs.readdirSync(path.join(stick, a.deviceId)).sort();
    assert.deepEqual(entries, [MANIFEST_NAME, RECORDS_NAME]);
  });
});

test('ein grösserer Bestand geht in mehreren Stapeln durch und bleibt idempotent', async () => {
  await withPair(async ({ a, b, stick }) => {
    // Mehr als BATCH_SIZE, damit der Stapelpfad wirklich läuft.
    for (let i = 0; i < folderMod.BATCH_SIZE + 37; i++) {
      a.store.create('note', { title: `Notiz ${i}`, body: 'x'.repeat(64) });
    }
    const published = await a.sync.publish(stick);
    assert.equal(published.written, folderMod.BATCH_SIZE + 37);

    const first = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(first.applied, folderMod.BATCH_SIZE + 37);
    assert.equal(b.store.count('note'), folderMod.BATCH_SIZE + 37);

    const second = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(second.applied, 0);
    assert.equal(second.conflicts, 0);
  });
});
