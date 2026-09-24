'use strict';

/**
 * Abgleich über einen gemeinsamen Ordner (das sync/ eines Sticks),
 * Postfach-Protokoll 2 (docs/STICK-BAUPLAN.md 2.8).
 *
 * Zwei ECHTE Installationen in zwei Wegwerf-Heimordnern, zwei echte Speicher
 * und ein dritter Wegwerf-Ordner als Stick. Die Paarschlüssel liegen hier in
 * einem Zustand im Speicher (`createPostfach` aus src/sync/kopplung.js, ohne
 * Datei); wer sie wann austauscht, prüft test/kopplung.test.js. Nichts auf
 * dem Weg des Zusammenführens ist nachgebaut.
 *
 * Neue Soll-Werte gegenüber Protokoll 1 (Bauplan 2.8):
 *  - Das Postfach ist immer verschlüsselt, auch ohne PIN; es gibt keine
 *    Klartext-Warnung mehr, und zwei Tresore tauschen sich über den
 *    Paarschlüssel aus, nicht über eine kopierte secrets.json.
 *  - Konflikte werden ohne Rückfrage gelöst: beide Fassungen bleiben.
 *  - Ein halbes oder fremdes Postfach wird still übergangen, nicht gemeldet.
 *
 * Nichts hier berührt das Netz oder den echten Heimordner.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { test, tempHome } = require('./harness');

const merge = require('../src/sync/merge');
const folderMod = require('../src/sync/folder');
const {
  createFolderSync, postfachBauen, postfachOeffnen, gabelung, MANIFEST_NAME, RECORDS_NAME, FOLDER_PROTOCOL,
} = folderMod;
const { createPostfach } = require('../src/sync/kopplung');

const { openStore } = require('../src/store/engine');
const { createVaultCrypto } = require('../src/store/vaultcrypto');
const { Bus } = require('../src/kernel/bus');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');

const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

/* ------------------------------------------------------------- fixtures */

function leererZustand() {
  return { v: 1, eigeneGeneration: 0, letzterInhalt: null, verlauf: [], verlaufGekuerzt: false, zwilling: null, partner: [], ausstehend: [] };
}

/**
 * Ein Gerät: eigener Heimordner, eigener Speicher, eigener Ordner-Abgleich
 * und ein Kopplungs-Zustand im Speicher.
 */
async function makeDevice(label, opts = {}) {
  const { home, cleanup } = tempHome(`nos-folder-${label}`);
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.sync = { deviceName: label };

  const bus = new Bus();
  let vaultCrypto = null;
  if (opts.passphrase) {
    vaultCrypto = createVaultCrypto({ paths, config, geraet: false });
    await vaultCrypto.initialise(opts.passphrase);
  }

  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto });
  const zustand = leererZustand();
  let sync = null;
  const postfach = createPostfach({ zustand: () => zustand, sichern: () => {}, ich: () => sync.deviceId });
  sync = createFolderSync({ store, merge, bus, logger: silentLogger, config, vaultCrypto, paths, postfach });

  const events = [];
  bus.subscribe((evt) => { if (evt.name.startsWith('sync.') || evt.name.startsWith('kopplung.')) events.push(evt); });

  return {
    label,
    home,
    paths,
    config,
    bus,
    store,
    vaultCrypto,
    sync,
    zustand,
    events,
    get deviceId() { return sync.deviceId; },
    async close() {
      await store.close().catch(() => {});
      cleanup();
    },
  };
}

function partnerEintrag(id, name, schluessel) {
  return {
    id, name, schluessel: schluessel.toString('base64'), seit: new Date().toISOString(), zustand: 'aktiv',
    gesehen: 0, gesehenInhalt: null, quittung: 0, zuletzt: null, ueber: [], erster: false,
  };
}

/** Zwei Geräte teilen einen Paarschlüssel. */
function koppeln(a, b) {
  const k = crypto.randomBytes(32);
  a.zustand.partner.push(partnerEintrag(b.deviceId, b.label, k));
  b.zustand.partner.push(partnerEintrag(a.deviceId, a.label, k));
  return k;
}

function schluesselZwischen(a, b) {
  const p = a.zustand.partner.find((x) => x.id === b.deviceId);
  return Buffer.from(p.schluessel, 'base64');
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

/** Was WIRKLICH im Postfach steht, mit dem Schlüssel des Lesers geöffnet. */
function mailboxRecords(stick, writer, reader) {
  const { zeilen } = postfachOeffnen({
    manifest: readManifest(stick, writer.deviceId),
    records: fs.readFileSync(recordsPath(stick, writer.deviceId)),
    ich: reader.deviceId,
    schluessel: schluesselZwischen(reader, writer),
  });
  return zeilen.map((z) => JSON.parse(z));
}

/**
 * Ein Postfach von Hand schreiben – der Ersatz für "den Stick eines anderen".
 * Dasselbe Format wie folder.js, damit ein Test Zeilen unterbringen kann, die
 * ein wohlerzogener Schreiber nie schriebe.
 */
function writeMailbox(stick, von, zeilen, { empfaenger, generation = 7, roh, kopf = {} } = {}) {
  const dir = path.join(stick, von);
  fs.mkdirSync(dir, { recursive: true });
  const { manifest, records } = postfachBauen({
    von,
    name: 'Fremdgerät',
    generation,
    kopf: { generation, inhalt: `k${generation}`, anzahl: zeilen.length, version: '0.1.0', partner: [], gesehen: {}, gesehenInhalt: {}, basen: {}, verlauf: [[generation, `k${generation}`]], verlaufVoll: false, ...kopf },
    zeilen,
    empfaenger,
    roh,
  });
  fs.writeFileSync(path.join(dir, RECORDS_NAME), records);
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Ein fremdes Gerät, mit dem `b` gekoppelt ist: nur Kennung und Schlüssel. */
function fremdesGeraet(b, name = 'Fremd') {
  const id = fakeDeviceId();
  const k = crypto.randomBytes(32);
  b.zustand.partner.push(partnerEintrag(id, name, k));
  return { id, empfaenger: [{ id: b.deviceId, schluessel: k }] };
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
    koppeln(a, b);
    await fn({ a, b, stick: stick.dir });
  } finally {
    await b.close();
    await a.close();
    stick.cleanup();
  }
}

function gemeinsam(store) {
  return store.list('note').items.filter((n) => n.data.title.startsWith('gemeinsam')).map((n) => `${n.data.title}=${n.data.body}`).sort();
}

/* ============================================================== transport */

test('(a) eine einseitige Änderung kommt über den Ordner an', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'Von A', body: 'Text von A' });

    const published = await a.sync.publish(stick);
    assert.equal(published.written, 1);
    assert.equal(published.geschrieben, true);
    assert.equal(published.deviceId, a.deviceId);
    assert.equal(published.generation, 1);
    assert.ok(published.bytes > 0);

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].ok, true, boxes[0].problem || '');
    assert.equal(boxes[0].deviceId, a.deviceId);
    assert.equal(boxes[0].deviceName, 'a');
    assert.equal(boxes[0].isSelf, false);
    assert.equal(boxes[0].fuerMich, true);
    assert.equal(boxes[0].protocol, FOLDER_PROTOCOL);
    assert.equal(boxes[0].generation, 1);

    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(pulled.gelesen, true);
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
    const zweite = await a.sync.publish(stick);
    assert.equal(zweite.generation, 2);
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

test('ohne Änderung wird nicht neu geschrieben, die Generation bleibt', async () => {
  await withPair(async ({ a, stick }) => {
    a.store.create('note', { title: 'x' });
    const erste = await a.sync.publish(stick);
    const vorher = fs.readFileSync(manifestPath(stick, a.deviceId), 'utf8');
    const zweite = await a.sync.publish(stick);
    assert.equal(zweite.geschrieben, false);
    assert.equal(zweite.grund, 'unveraendert');
    assert.equal(zweite.generation, erste.generation);
    assert.equal(fs.readFileSync(manifestPath(stick, a.deviceId), 'utf8'), vorher);

    a.store.create('note', { title: 'y' });
    const dritte = await a.sync.publish(stick);
    assert.equal(dritte.geschrieben, true);
    assert.equal(dritte.generation, erste.generation + 1);
  });
});

/* ============================================================== conflicts */

test('(b) beide Seiten ändern denselben Eintrag: beide Fassungen bleiben, ohne Rückfrage', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'gemeinsam', body: 'Ausgangstext' });

    // Ein vollständiger Umlauf, damit beide Seiten denselben Stand als
    // vereinbart kennen – erst danach ist ein Konflikt ein echter Konflikt.
    await a.sync.publish(stick);
    await b.sync.syncAll(stick);
    await a.sync.syncAll(stick);
    assert.equal(b.store.get(note.id).data.body, 'Ausgangstext');

    a.store.update(note.id, { body: 'A hat weitergeschrieben' });
    b.store.update(note.id, { body: 'B hat etwas anderes geschrieben' });

    await a.sync.publish(stick);
    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });

    assert.equal(pulled.conflicts, 1);
    assert.equal(pulled.kopien, 1);
    const beiB = gemeinsam(b.store);
    assert.equal(beiB.length, 2, JSON.stringify(beiB));
    assert.ok(beiB.some((t) => t.endsWith('=A hat weitergeschrieben')), JSON.stringify(beiB));
    assert.ok(beiB.some((t) => t.endsWith('=B hat etwas anderes geschrieben')), JSON.stringify(beiB));
    assert.ok(beiB.some((t) => /^gemeinsam \(Fassung von (a|b)\)=/.test(t)), JSON.stringify(beiB));
    assert.equal(b.store.list('conflict').total, 0, 'niemand wird gefragt');
    assert.ok(b.events.some((e) => e.name === 'kopplung.zweiFassungen' && e.payload.titel === 'gemeinsam'));

    // Und in der Gegenrichtung kommt dasselbe heraus.
    await b.sync.publish(stick);
    await a.sync.pull(stick, { deviceId: b.deviceId });
    assert.deepEqual(gemeinsam(a.store), beiB);
  });
});

test('(b) derselbe Konflikt entsteht beim erneuten Lesen nicht doppelt', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'gemeinsam', body: 'Start' });
    await a.sync.publish(stick);
    await b.sync.syncAll(stick);
    await a.sync.syncAll(stick);

    a.store.update(note.id, { body: 'A' });
    b.store.update(note.id, { body: 'B' });
    await a.sync.publish(stick);

    await b.sync.pull(stick, { deviceId: a.deviceId });
    const zweites = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(zweites.gelesen, false);
    assert.equal(zweites.grund, 'bekannt');

    assert.equal(gemeinsam(b.store).length, 2);
    assert.equal(b.store.list('note').items.filter((n) => merge.istKopieId(n.id)).length, 1);
  });
});

test('nach „beide behalten“ bleiben weitere Umläufe ohne neue Kopie, und beide Seiten sind gleich', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'gemeinsam', body: 'Start' });
    await a.sync.publish(stick);
    await b.sync.syncAll(stick);
    await a.sync.syncAll(stick);

    a.store.update(note.id, { body: 'A' });
    b.store.update(note.id, { body: 'B bleibt' });
    for (const d of [b, a, b, a]) await d.sync.syncAll(stick);
    const stand = gemeinsam(a.store);
    assert.deepEqual(gemeinsam(b.store), stand);
    assert.equal(stand.length, 2);

    for (let i = 0; i < 3; i++) {
      const ra = await a.sync.syncAll(stick);
      const rb = await b.sync.syncAll(stick);
      assert.equal(ra.conflicts + rb.conflicts, 0, `Runde ${i}: neuer Konflikt`);
    }
    assert.deepEqual(gemeinsam(a.store), stand);
    assert.deepEqual(gemeinsam(b.store), stand);
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

    const first = await b.sync.syncAll(stick);
    const second = await b.sync.syncAll(stick);
    const third = await a.sync.syncAll(stick);

    for (const [label, run] of [['1', first], ['2', second], ['3', third]]) {
      assert.equal(run.applied, 0, `Durchgang ${label} hat etwas angewendet`);
      assert.equal(run.conflicts, 0, `Durchgang ${label} hat einen Konflikt erzeugt`);
      assert.equal(run.ok, true, `Durchgang ${label}: ${run.warnings.join(' | ')}`);
    }
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
    const lines = mailboxRecords(stick, a, b);
    const reordered = [
      ...lines.filter((r) => r.type === 'edge'),
      ...lines.filter((r) => r.type !== 'edge'),
    ].map((r) => JSON.stringify(r));
    writeMailbox(stick, a.deviceId, reordered, { empfaenger: [{ id: b.deviceId, schluessel: schluesselZwischen(b, a) }], generation: 5 });

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

test('(d) ein Postfach ohne Beschreibungsdatei wird still übergangen, nicht halb eingelesen', async () => {
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

    const r = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(r.gelesen, false);

    const run = await b.sync.syncAll(stick);
    assert.equal(run.applied, 0);
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

    const r = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(r.gelesen, false);
    assert.equal(b.store.count('note'), 0);
  });
});

test('(d) beschädigte Bytes werden VOR dem Anwenden an der Prüfsumme erkannt; danach wird still wieder gelesen', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'kommt später an' });
    await a.sync.publish(stick);

    // Gleiche Grösse, anderer Inhalt – das überlebt jede reine Längenprüfung.
    const file = recordsPath(stick, a.deviceId);
    const heil = fs.readFileSync(file);
    const buf = Buffer.from(heil);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    fs.writeFileSync(file, buf);

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes[0].ok, true, 'die Grösse stimmt ja noch');

    const r = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(r.gelesen, false);
    assert.equal(r.grund, 'unvollstaendig');
    assert.equal(b.store.count('note'), 0, 'nichts wurde angewendet');

    // Der Partner war nur mitten im Schreiben: beim nächsten Mal klappt es.
    fs.writeFileSync(file, heil);
    const wieder = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(wieder.gelesen, true);
    assert.equal(b.store.count('note'), 1);
  });
});

test('(d) ein Inhalt, der gar kein Gzip ist, wird übergangen statt Müll zu liefern', async () => {
  await withPair(async ({ b, stick }) => {
    const fremd = fremdesGeraet(b);
    writeMailbox(stick, fremd.id, [], { empfaenger: fremd.empfaenger, roh: Buffer.from('das war nie ein gzip-Strom', 'utf8') });

    const r = await b.sync.pull(stick, { deviceId: fremd.id });
    assert.equal(r.gelesen, false);
    assert.equal(r.grund, 'unlesbar');
    assert.equal(b.store.count('note'), 0);
  });
});

test('ein Postfach ohne Prüfsumme wird nicht gelesen', async () => {
  await withPair(async ({ b, stick }) => {
    const fremd = fremdesGeraet(b);
    writeMailbox(stick, fremd.id, [JSON.stringify(rec('note', NOTE_ID, { title: 'x' }))], { empfaenger: fremd.empfaenger });
    const manifest = readManifest(stick, fremd.id);
    delete manifest.sha256;
    fs.writeFileSync(manifestPath(stick, fremd.id), JSON.stringify(manifest));

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes[0].ok, false);
    assert.match(boxes[0].problem, /Prüfsumme/);
    await b.sync.pull(stick, { deviceId: fremd.id });
    assert.equal(b.store.count('note'), 0);
  });
});

/* ================================================ what may never travel */

test('(e) Token, Agenten, Module, Freigaben und Partner stehen NIE im Postfach', async () => {
  await withPair(async ({ a, b, stick }) => {
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

    // Der entschlüsselte Inhalt selbst, nicht der Rückgabewert.
    const records = mailboxRecords(stick, a, b);
    assert.equal(records.length, 1);
    for (const record of records) {
      assert.ok(merge.SYNC_TYPES.includes(record.type), `Art "${record.type}" gehört nicht ins Postfach`);
    }
    const { kopf, zeilen } = postfachOeffnen({
      manifest: readManifest(stick, a.deviceId),
      records: fs.readFileSync(recordsPath(stick, a.deviceId)),
      ich: b.deviceId,
      schluessel: schluesselZwischen(b, a),
    });
    const plain = `${JSON.stringify(kopf)}\n${zeilen.join('\n')}`;
    for (const secret of [
      'HASHGEHEIMNIS1', 'SALTGEHEIMNIS2', 'AGENTGEHEIMNIS3', 'MODULGEHEIMNIS4',
      'GRANTGEHEIMNIS5', 'PEERGEHEIMNIS6', 'TOKENGEHEIMNIS7', 'RUNGEHEIMNIS8', 'APPROVALGEHEIMNIS9',
      'process.exit',
    ]) {
      assert.equal(plain.includes(secret), false, `"${secret}" steht im Postfach`);
    }
    const manifest = fs.readFileSync(manifestPath(stick, a.deviceId), 'utf8');
    assert.equal(manifest.includes('GEHEIMNIS'), false);
  });
});

test('(e) ein fremder Stick kann weder Rechte noch Agenten noch Code einschleusen', async () => {
  await withPair(async ({ b, stick }) => {
    const hostile = fremdesGeraet(b, 'Übernahme');
    writeMailbox(stick, hostile.id, [
      JSON.stringify(rec('note', NOTE_ID, { title: 'harmlos', body: '', tags: [], pinned: false, source: 'user' })),
      JSON.stringify(rec('agent', 'agent_bbbbbbbbbbbbbbbbbbbbbbbb', {
        name: 'Übernahme',
        permissions: { network: 'online', allowedHosts: ['*'], writeFiles: true, fileRoots: ['/'], requireApproval: false },
      })),
      JSON.stringify(rec('token', 'token_cccccccccccccccccccccccc', { label: 'Hintertür', hash: 'h', salt: 's', permissions: { read: true, write: true, sync: true } })),
      JSON.stringify(rec('grant', 'grant_dddddddddddddddddddddddd', { scope: 'global', level: 'online', hosts: ['*'] })),
      JSON.stringify(rec('module', 'module_eeeeeeeeeeeeeeeeeeeeeeee', { name: 'Schadcode', source: 'require("fs").rmSync("/",{recursive:true})' })),
      JSON.stringify(rec('peer', 'peer_ffffffffffffffffffffffff', { name: 'fremd', url: 'http://10.0.0.1:7777', token: 'geheim' })),
    ], { empfaenger: hostile.empfaenger });

    const pulled = await b.sync.pull(stick, { deviceId: hostile.id });

    assert.equal(pulled.applied, 1, 'nur die Notiz');
    assert.equal(pulled.fetched, 1);
    assert.equal(b.store.count('note'), 1);
    for (const forbidden of ['agent', 'token', 'grant', 'module', 'peer']) {
      assert.equal(b.store.count(forbidden), 0, `"${forbidden}" wurde vom Stick übernommen`);
    }
    assert.ok(
      pulled.warnings.some((w) => w.includes('NICHT übernommen')),
      `es muss gesagt werden, was abgelehnt wurde: ${pulled.warnings.join(' | ')}`,
    );
  });
});

test('(e) ein Postfach, das nicht für mich ist oder von keinem Partner kommt, wird still übergangen', async () => {
  await withPair(async ({ b, stick }) => {
    // Kein Partner von b: syncAll übergeht es, ohne ein Wort.
    const unbekannt = fakeDeviceId();
    writeMailbox(stick, unbekannt, [JSON.stringify(rec('note', NOTE_ID, { title: 'Werbung' }))], { empfaenger: [{ id: b.deviceId, schluessel: crypto.randomBytes(32) }] });
    // Ein Partner, aber ohne Eintrag für b.
    const partner = fremdesGeraet(b);
    writeMailbox(stick, partner.id, [JSON.stringify(rec('note', 'note_bbbbbbbbbbbbbbbbbbbbbbbb', { title: 'nicht für b' }))], { empfaenger: [{ id: fakeDeviceId(), schluessel: crypto.randomBytes(32) }] });

    const run = await b.sync.syncAll(stick);
    assert.equal(run.applied, 0);
    assert.equal(run.peers.filter((p) => p.deviceId === unbekannt).length, 0, 'ein Fremder wird nicht einmal angesehen');
    assert.equal(run.peers.find((p) => p.deviceId === partner.id).grund, 'nicht-fuer-mich');
    assert.deepEqual(run.warnings.filter((w) => !/noch kein Postfach/.test(w)), []);
    assert.equal(b.store.count('note'), 0);
  });
});

/* =========================================================== broken lines */

test('(f) eine beschädigte Zeile wird übersprungen, gezählt und gemeldet', async () => {
  await withPair(async ({ b, stick }) => {
    const fremd = fremdesGeraet(b);
    writeMailbox(stick, fremd.id, [
      JSON.stringify(rec('note', 'note_111111111111111111111111', { title: 'erste', body: '', tags: [], pinned: false, source: 'user' })),
      '{ das ist kein JSON und war einmal eine Zeile',
      JSON.stringify(rec('note', 'note_222222222222222222222222', { title: 'zweite', body: '', tags: [], pinned: false, source: 'user' })),
      '',
      '{"id":"ohne_typ"}',
      JSON.stringify(rec('note', 'note_333333333333333333333333', { title: 'dritte', body: '', tags: [], pinned: false, source: 'user' })),
    ], { empfaenger: fremd.empfaenger });

    const pulled = await b.sync.pull(stick, { deviceId: fremd.id });

    assert.equal(pulled.corrupt, 2, 'kaputte Zeile und Zeile ohne Art');
    assert.equal(pulled.applied, 3, 'alle brauchbaren Zeilen kommen an');
    assert.equal(b.store.count('note'), 3);
    assert.ok(pulled.warnings.some((w) => w.includes('unlesbar')), pulled.warnings.join(' | '));
  });
});

/* ============================================================ encryption */

test('(g) das Postfach ist immer verschlüsselt, auch ohne PIN; wer den Paarschlüssel nicht hat, liest nichts', async () => {
  const a = await makeDevice('ohne-pin');
  const b = await makeDevice('partner');
  const c = await makeDevice('fremd');
  const stick = makeStick();
  try {
    koppeln(a, b);
    a.store.create('note', { title: 'GEHEIMNIS-XYZ', body: 'streng vertraulich ABC' });

    const published = await a.sync.publish(stick.dir);
    assert.equal(published.encrypted, true);
    assert.equal(published.warnings.some((w) => w.includes('Klartext')), false, 'es gibt keine Klartext-Warnung mehr');

    const raw = fs.readFileSync(recordsPath(stick.dir, a.deviceId));
    assert.equal(raw.includes('GEHEIMNIS-XYZ'), false);
    assert.equal(raw.includes('vertraulich'), false);
    assert.equal(raw.includes('note'), false);
    assert.throws(() => zlib.gunzipSync(raw), 'verschlüsselt heisst: nicht einmal entpackbar');

    // Das Manifest sagt WER und FÜR WEN, aber nichts darüber, WAS.
    const manifest = readManifest(stick.dir, a.deviceId);
    assert.equal(manifest.protocol, 2);
    assert.equal(manifest.verschluesselung, 'paar-v1');
    assert.deepEqual(Object.keys(manifest.empfaenger), [b.deviceId]);
    assert.equal(JSON.stringify(manifest).includes('GEHEIMNIS'), false);

    // c ist mit a nicht gekoppelt: still nichts.
    koppeln(c, { deviceId: a.deviceId, label: 'a', zustand: leererZustand() });
    const r = await c.sync.pull(stick.dir, { deviceId: a.deviceId });
    assert.equal(r.gelesen, false);
    assert.equal(r.grund, 'nicht-fuer-mich');
    assert.equal(c.store.count('note'), 0);

    const rb = await b.sync.pull(stick.dir, { deviceId: a.deviceId });
    assert.equal(rb.applied, 1);
  } finally {
    await c.close();
    await b.close();
    await a.close();
    stick.cleanup();
  }
});

test('zwei Tresore mit verschiedenen PINs gleichen über den Paarschlüssel ab, ohne secrets.json zu kopieren', async () => {
  const enc = await makeDevice('enc1', { passphrase: '1357' });
  const twin = await makeDevice('enc2', { passphrase: '2468' });
  const stick = makeStick();
  try {
    koppeln(enc, twin);
    enc.store.create('note', { title: 'verschlüsselt gereist', body: 'Inhalt' });
    await enc.sync.publish(stick.dir);

    const pulled = await twin.sync.pull(stick.dir, { deviceId: enc.deviceId });
    assert.equal(pulled.applied, 1);
    assert.equal(twin.store.list('note').items[0].data.title, 'verschlüsselt gereist');
    assert.notEqual(fs.readFileSync(enc.paths.secrets, 'utf8'), fs.readFileSync(twin.paths.secrets, 'utf8'));

    // sync-folder.json bleibt mit dem eigenen Tresorschlüssel versiegelt (Befund 17).
    const roh = fs.readFileSync(path.join(twin.home, 'sync-folder.json'));
    assert.notEqual(roh[0], 0x7b);
    const stand = JSON.parse(twin.vaultCrypto.decryptBuffer(roh).toString('utf8'));
    assert.ok(stand.devices[enc.deviceId]);
  } finally {
    await twin.close();
    await enc.close();
    stick.cleanup();
  }
});

/* ================================================================= clocks */

test('bei einer Uhr, die vorgeht, wird eine eingehende Löschung nicht ausgeführt', async () => {
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
    assert.ok(pulled.warnings.some((w) => w.includes('Uhr')), `die Abweichung muss gemeldet werden: ${pulled.warnings.join(' | ')}`);
    assert.ok(Math.abs(pulled.clockSkewMs) > 5 * 60 * 1000);
  });
});

test('ein Postfach von gestern ist kein Uhrproblem: die Löschung wird ausgeführt (p2b)', async () => {
  await withPair(async ({ a, b, stick }) => {
    const note = a.store.create('note', { title: 'geht' });
    await a.sync.publish(stick);
    await b.sync.pull(stick, { deviceId: a.deviceId });
    a.store.remove(note.id);
    await a.sync.publish(stick);
    const manifest = readManifest(stick, a.deviceId);
    manifest.at = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    fs.writeFileSync(manifestPath(stick, a.deviceId), JSON.stringify(manifest));

    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(pulled.conflicts, 0);
    assert.equal(pulled.clockSkewMs, 0);
    assert.equal(b.store.count('note'), 0);
    assert.equal(pulled.warnings.some((w) => w.includes('Uhr')), false, pulled.warnings.join(' | '));
    assert.equal(b.events.some((e) => e.name === 'sync.warning'), false);
  });
});

/* ================================================================ Zwilling */

test('ein Postfach mit meiner Kennung, das ich nicht geschrieben habe: nichts wird geschrieben', async () => {
  await withPair(async ({ a, b, stick }) => {
    a.store.create('note', { title: 'x' });
    await a.sync.publish(stick);

    // Ein Zwilling (gleiche Kennung) hat inzwischen hier geschrieben.
    writeMailbox(stick, a.deviceId, [], { empfaenger: [{ id: b.deviceId, schluessel: schluesselZwischen(a, b) }], generation: 9 });
    const fremd = fs.readFileSync(manifestPath(stick, a.deviceId), 'utf8');

    a.store.create('note', { title: 'y' });
    const r = await a.sync.publish(stick);
    assert.equal(r.zwilling, true);
    assert.equal(r.geschrieben, false);
    assert.equal(fs.readFileSync(manifestPath(stick, a.deviceId), 'utf8'), fremd, 'das Postfach des Zwillings wurde überschrieben');
  });
});

test('gabelung(): Verlauf passt, fehlt oder widerspricht', () => {
  assert.equal(gabelung([[3, 'a'], [4, 'b']], true, 4, 'b'), false);
  assert.equal(gabelung([[3, 'a'], [4, 'b']], true, 4, 'x'), true, 'anderer Inhalt');
  assert.equal(gabelung([[3, 'a'], [5, 'c']], false, 4, 'b'), true, 'im Bereich, aber nie geschrieben');
  assert.equal(gabelung([[10, 'a']], false, 4, 'b'), false, 'älter als der gekürzte Verlauf: nicht prüfbar');
  assert.equal(gabelung([[10, 'a']], true, 4, 'b'), true, 'vollständiger Verlauf ohne 4');
  assert.equal(gabelung([], false, 0, null), false, 'noch nichts gelesen');
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
    const unbekannt = await a.sync.pull(stick, { deviceId: fakeDeviceId() });
    assert.equal(unbekannt.gelesen, false);

    // Eine Datei statt eines Ordners.
    const file = path.join(stick, 'datei.txt');
    fs.writeFileSync(file, 'x');
    await assert.rejects(() => a.sync.publish(file), (err) => err.code === 'VALIDATION_FAILED');
  });
});

test('ohne Kopplung gibt es kein Postfach', async () => {
  const { home, cleanup } = tempHome('nos-folder-ohne');
  const stick = makeStick();
  try {
    const paths = pathsMod.ensureLayout(pathsMod.layout(home));
    const store = await openStore({ paths, logger: silentLogger });
    const sync = createFolderSync({ store, paths, logger: silentLogger, config: configMod.defaults() });
    await assert.rejects(() => sync.publish(stick.dir), (err) => err.code === 'KOPPLUNG_FEHLT' && err.message === 'Ohne Kopplung gibt es kein Postfach.');
    await store.close();
  } finally {
    stick.cleanup();
    cleanup();
  }
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
    const fremd = fremdesGeraet(b);
    writeMailbox(stick, fremd.id, [JSON.stringify(rec('note', NOTE_ID, { title: 'x' }))], { empfaenger: fremd.empfaenger });
    fs.renameSync(path.join(stick, fremd.id), path.join(stick, 'kopie-vom-postfach'));

    const boxes = await b.sync.peers(stick);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].ok, false);
    assert.match(boxes[0].problem, /Geräte-Kennung/);
    await b.sync.syncAll(stick);
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
    assert.deepEqual(mailboxRecords(stick, b, a).map((r) => r.data.title), ['von A']);
    assert.ok(phases.includes('apply'));
    assert.ok(phases.includes('write'));

    assert.ok(b.events.some((e) => e.name === 'sync.folder'));
  });
});

test('ein leerer Ordner ist kein Fehler', async () => {
  await withPair(async ({ a, stick }) => {
    const run = await a.sync.syncAll(stick);
    assert.equal(run.ok, true);
    assert.equal(run.peers.length, 0);
    assert.ok(fs.existsSync(manifestPath(stick, a.deviceId)));
  });
});

test('ein leeres Postfach ist kein Sonderfall', async () => {
  await withPair(async ({ a, b, stick }) => {
    const published = await a.sync.publish(stick);
    assert.equal(published.written, 0);

    const pulled = await b.sync.pull(stick, { deviceId: a.deviceId });
    assert.equal(pulled.gelesen, true);
    assert.equal(pulled.fetched, 0);
    assert.equal(pulled.applied, 0);
    assert.equal(pulled.conflicts, 0);
    assert.equal(pulled.corrupt, 0);
  });
});

test('ein erfolgreiches Schreiben hinterlässt keine Reste im Postfach, auch keinen Klartext von früher', async () => {
  await withPair(async ({ a, stick }) => {
    // Ein Postfach aus Protokoll 1 lag schon da.
    fs.mkdirSync(path.join(stick, a.deviceId));
    fs.writeFileSync(path.join(stick, a.deviceId, 'records.jsonl.gz'), zlib.gzipSync('{"alt":"Klartext"}\n'));
    a.store.create('note', { title: 'x' });
    await a.sync.publish(stick);
    a.store.create('note', { title: 'y' });
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
