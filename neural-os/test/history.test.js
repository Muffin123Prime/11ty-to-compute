'use strict';

/**
 * Tests for the change journal and "rückgängig".
 *
 * Everything runs against a REAL store (`src/store/engine.js`) in a throwaway
 * home, on a real bus, with a real journal file on disk. The store is never
 * mocked: the whole promise of this subsystem is that undoing really puts the
 * previous state back, and a stubbed store could only prove that the right
 * method was called. So every undo test asserts what is IN THE STORE
 * afterwards, not what `undo()` returned.
 *
 * The HTTP section talks to the real server on an ephemeral loopback port.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { test, drain, tempHome } = require('./harness');

const { createHistory } = require('../src/store/history');
const { withActor } = require('../src/kernel/actor');
const { openStore } = require('../src/store/engine');
const { createServer } = require('../src/http/server');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');

/** Tests must not write diagnostics over the runner's output. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

const RUN_ID = 'run_nachtschicht0000000001';
const AGENT_ID = 'agent_aufraeumer00000000';

/** Reversible stand-in for src/store/vaultcrypto.js, as in test/store.test.js. */
function fakeCrypto() {
  return {
    enabled: true,
    encryptLine: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    decryptLine: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    encryptBuffer: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptBuffer: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
  };
}

/**
 * A real store, a real bus and a started history, all in a temporary home.
 * `make()` builds a SECOND history over the same file, which is how the tests
 * prove something reached the disk rather than only the Map.
 */
async function withHistory(label, fn, opts = {}) {
  const { home, cleanup } = tempHome(label);
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const bus = new Bus();
  const vaultCrypto = opts.vaultCrypto || null;
  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto });
  const make = () => createHistory({
    store, bus, paths, config: opts.config, logger: silentLogger, vaultCrypto,
  });
  const history = make();
  history.start();
  try {
    return await fn({ store, bus, history, paths, home, make });
  } finally {
    try { history.stop(); } catch { /* already stopped by the test */ }
    await store.close().catch(() => {});
    cleanup();
  }
}

function journalFile(paths) {
  return path.join(paths.vault, 'history.jsonl');
}

function journalLines(paths) {
  try {
    return fs.readFileSync(journalFile(paths), 'utf8').split('\n').filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/* ------------------------------------------------------------- recording */

test('a create, an update and a delete each land in the journal with the right before', async () => {
  await withHistory('history-record', async ({ store, history, paths }) => {
    const note = store.create('note', { title: 'Espresso', body: 'Alt', tags: ['kaffee'] });
    store.update(note.id, { title: 'Espresso Doppio', body: 'Neu' });
    store.remove(note.id);

    const { items, total } = history.list();
    assert.equal(total, 3);

    // Newest first: this list is read to find what just went wrong.
    assert.deepEqual(items.map((i) => i.op), ['delete', 'update', 'create']);

    const created = items[2];
    assert.equal(created.before, null, 'nothing existed before a create');
    assert.equal(created.type, 'note');
    assert.equal(created.id, note.id);
    assert.equal(created.rev, 1);
    assert.equal(created.label, 'Notiz „Espresso" angelegt');

    const updated = items[1];
    assert.deepEqual(updated.before, { title: 'Espresso', body: 'Alt' }, 'only the changed fields, with their old values');
    assert.equal(updated.fromRev, 1);
    assert.equal(updated.rev, 2);
    assert.equal(updated.label, 'Notiz „Espresso Doppio" geändert');

    const deleted = items[0];
    assert.equal(deleted.before.title, 'Espresso Doppio', 'a delete keeps the whole record');
    assert.equal(deleted.before.body, 'Neu');
    assert.deepEqual(deleted.before.tags, ['kaffee']);
    assert.equal(deleted.label, 'Notiz „Espresso Doppio" gelöscht');

    assert.equal(journalLines(paths).length, 3, 'three entries, three lines');
  });
});

test('every journalled change is on disk before the call returns', async () => {
  await withHistory('history-durable', async ({ store, paths, make }) => {
    store.create('note', { title: 'Sofort' });
    const lines = journalLines(paths);
    assert.equal(lines.length, 1);

    const reloaded = make();
    const { items, total } = reloaded.list();
    assert.equal(total, 1);
    assert.equal(items[0].label, 'Notiz „Sofort" angelegt');
    assert.equal(items[0].canUndo, true);
  });
});

test('an agent-made change carries the run it came from, a hand-made one does not', async () => {
  await withHistory('history-actor', async ({ store, history }) => {
    // The provenance stamp src/agents/tools.js puts on records an agent writes.
    const byAgent = store.create('note', {
      title: 'Nachtschicht', body: 'Von selbst entstanden', source: 'agent',
      runId: RUN_ID, agentId: AGENT_ID,
    });
    const byUser = store.create('note', { title: 'Von Hand' });

    const items = history.list().items;
    const agentEntry = items.find((i) => i.id === byAgent.id);
    assert.equal(agentEntry.actor.kind, 'agent');
    assert.equal(agentEntry.actor.runId, RUN_ID, 'the real run id, not a guess');
    assert.equal(agentEntry.actor.agentId, AGENT_ID);

    const userEntry = items.find((i) => i.id === byUser.id);
    assert.deepEqual(userEntry.actor, { kind: 'user' });

    assert.equal(history.list({ actor: 'agent' }).total, 1);
    assert.equal(history.list({ actor: 'user' }).total, 1);
    assert.deepEqual(history.stats().byActor, { user: 1, agent: 1 });
  });
});

/**
 * Die Luecke, die der Herkunftsstempel allein nicht schliessen konnte.
 *
 * Der Stempel am Satz beantwortet "wer hat diesen Satz ERZEUGT?". Bei einer
 * AENDERUNG sagt er nichts -- eine Notiz, die der Nutzer geschrieben und ein
 * Agent spaeter bearbeitet hat, sah deshalb aus wie eine Aenderung des
 * Nutzers. Genau das ist der Fall, in dem jemand wissen will, was ueber Nacht
 * passiert ist.
 */
test('eine Aenderung durch einen Agenten wird als solche erkannt, nicht als eigene', async () => {
  await withHistory('nos-history-actor', async ({ store, history }) => {
    const note = store.create('note', { title: 'Meine Notiz', body: 'Von mir' });

    await withActor({ kind: 'agent', runId: 'run_xyz', agentId: 'agent_abc' }, async () => {
      store.update(note.id, { body: 'Vom Agenten umgeschrieben' });
    });
    store.update(note.id, { body: 'Wieder von mir' });

    const items = history.list({}).items;
    const updates = items.filter((e) => e.op === 'update');
    assert.equal(updates.length, 2);

    // Neueste zuerst: die letzte Aenderung war die des Nutzers.
    assert.equal(updates[0].actor.kind, 'user');
    assert.equal(updates[1].actor.kind, 'agent', 'die Aenderung des Agenten wurde dem Nutzer zugeschrieben');
    assert.equal(updates[1].actor.runId, 'run_xyz');
    assert.equal(updates[1].actor.agentId, 'agent_abc');
    assert.equal(updates[1].actor.via, 'kontext', 'die sichere Quelle ist der Kontext, nicht der Stempel');

    // Das Anlegen war der Nutzer -- der Kontext galt da noch nicht.
    const created = items.find((e) => e.op === 'create');
    assert.equal(created.actor.kind, 'user');

    assert.deepEqual(history.stats().byActor, { user: 2, agent: 1 });
  });
});

test('der Kontext endet mit dem Lauf und faerbt nichts danach ein', async () => {
  await withHistory('nos-history-actor-end', async ({ store, history }) => {
    const note = store.create('note', { title: 'Notiz' });
    await withActor({ kind: 'agent', runId: 'run_1' }, async () => {
      store.update(note.id, { body: 'innerhalb' });
    });
    store.update(note.id, { body: 'danach' });
    const updates = history.list({}).items.filter((e) => e.op === 'update');
    assert.equal(updates[0].actor.kind, 'user', 'nach dem Lauf gilt der Kontext nicht mehr');
    assert.equal(updates[1].actor.kind, 'agent');
  });
});

test('ohne Kontext bleibt der Stempel am Satz die Rueckfallantwort', async () => {
  await withHistory('nos-history-actor-stamp', async ({ store, history }) => {
    // So sah es vor dem Urheber-Kontext aus, und so sehen alte Saetze aus:
    // der Stempel steht an den Daten, einen Ereignis-Urheber gibt es nicht.
    store.create('note', { title: 'Alt', runId: 'run_alt', agentId: 'agent_alt', source: 'agent' });
    const entry = history.list({}).items[0];
    assert.equal(entry.actor.kind, 'agent');
    assert.equal(entry.actor.runId, 'run_alt');
    assert.equal(entry.actor.via, 'stempel');
  });
});

/**
 * Ein Massenimport darf den Verlauf nicht leerfegen.
 *
 * Das Journal ist begrenzt. Eine zurueckgespielte Sicherung schreibt
 * Zehntausende Saetze -- ohne Aussetzen waere danach genau das weg, wofuer der
 * Verlauf da ist: die letzten echten Aenderungen, verdraengt von einem Import,
 * bei dem "einen einzelnen Satz zuruecknehmen" ohnehin nichts bedeutet.
 */
test('ein Massenschreibvorgang faellt nicht ins Journal und verdraengt nichts', async () => {
  await withHistory('nos-history-bulk', async ({ store, history }) => {
    const wichtig = store.create('note', { title: 'Wichtige Notiz', body: 'Original' });
    store.update(wichtig.id, { body: 'Von mir geändert' });
    const vorher = history.list({}).total;
    assert.equal(vorher, 2);

    await history.suspend(async () => {
      for (let i = 0; i < 200; i++) store.create('note', { title: `Import ${i}`, body: 'Aus einer Sicherung' });
    });

    const nachher = history.list({});
    assert.equal(nachher.total, vorher, 'der Import steht im Journal');
    assert.ok(nachher.items.some((e) => e.id === wichtig.id && e.op === 'update'),
      'die echte Änderung wurde verdrängt');

    // Und danach zeichnet es wieder auf.
    store.update(wichtig.id, { body: 'Noch einmal geändert' });
    assert.equal(history.list({}).total, vorher + 1, 'nach dem Import wird nichts mehr aufgezeichnet');
  });
});

test('suspend stellt den vorherigen Zustand wieder her, auch bei einem Fehler', async () => {
  await withHistory('nos-history-bulk-throw', async ({ store, history }) => {
    await assert.rejects(history.suspend(async () => {
      store.create('note', { title: 'Waehrend des Imports' });
      throw new Error('Import abgebrochen');
    }), /abgebrochen/);
    // Der Abbruch darf das Journal nicht dauerhaft stumm schalten.
    store.create('note', { title: 'Danach' });
    const items = history.list({}).items;
    assert.ok(items.some((e) => e.label.includes('Danach')), 'das Journal blieb stumm');
    assert.ok(!items.some((e) => e.label.includes('Waehrend des Imports')), 'der Import kam doch hinein');
  });
});

test('bookkeeping types are never journalled', async () => {
  await withHistory('history-skip', async ({ store, history }) => {
    const a = store.create('note', { title: 'A' });
    const b = store.create('note', { title: 'B' });
    const chat = store.create('chat', { title: 'Gespräch' });
    const before = history.list({ limit: 500 }).total;
    assert.equal(before, 3);

    store.edges.add({ from: a.id, to: b.id, kind: 'related', source: 'derived' });
    store.create('run', { agentId: AGENT_ID, goal: 'aufräumen' });
    store.create('message', { chatId: chat.id, role: 'user', content: 'hallo' });
    store.create('suggestion', { kind: 'tag', title: 'Vorschlag' });
    store.create('grant', { scope: 'global', level: 'online' });

    const listed = history.list({ limit: 500 });
    assert.equal(listed.total, before, 'none of the five produced an entry');
    for (const item of listed.items) {
      assert.ok(
        !['edge', 'run', 'message', 'suggestion', 'grant'].includes(item.type),
        `${item.type} must not be journalled`,
      );
    }
  });
});

test('a restore publishes record.updated but is not journalled as one', async () => {
  await withHistory('history-restore', async ({ store, history }) => {
    const note = store.create('note', { title: 'Hin und her' });
    store.remove(note.id);
    const total = history.list().total;
    assert.equal(total, 2);

    // `restore()` carries no `before`; an entry made from it would be an undo
    // button with nothing behind it.
    store.restore(note.id);
    assert.equal(history.list().total, total, 'a restore adds nothing to the journal');
  });
});

/* ------------------------------------------------------------------ undo */

test('undoing a create really removes the record', async () => {
  await withHistory('history-undo-create', async ({ store, history }) => {
    const note = store.create('note', { title: 'Weg damit' });
    const entry = history.list().items[0];

    const result = await history.undo(entry.seq);
    assert.equal(result.applied.op, 'delete');

    assert.equal(store.get(note.id), null, 'the record is gone');
    const tomb = store.get(note.id, { includeDeleted: true });
    assert.ok(tomb.deletedAt, 'soft-deleted, so the user can still get it back');
  });
});

test('undoing an update really puts the previous values back', async () => {
  await withHistory('history-undo-update', async ({ store, history }) => {
    const note = store.create('note', { title: 'Alt', body: 'Erster Text', tags: ['a'] });
    store.update(note.id, { title: 'Neu', body: 'Zweiter Text' });
    assert.equal(store.get(note.id).data.title, 'Neu');

    const entry = history.list().items[0];
    assert.equal(entry.op, 'update');
    await history.undo(entry.seq);

    const after = store.get(note.id);
    assert.equal(after.data.title, 'Alt');
    assert.equal(after.data.body, 'Erster Text');
    assert.deepEqual(after.data.tags, ['a'], 'an untouched field stays untouched');
  });
});

test('a delete whose record is still soft-deleted comes back under the same id', async () => {
  await withHistory('history-undo-delete', async ({ store, history }) => {
    const note = store.create('note', { title: 'Zurückholen', body: 'Inhalt' });
    store.remove(note.id);
    const entry = history.list().items[0];
    assert.equal(entry.op, 'delete');

    const result = await history.undo(entry.seq);
    assert.equal(result.applied.op, 'restore');
    assert.equal(result.applied.id, note.id, 'the same id, because the record never left');

    const back = store.get(note.id);
    assert.ok(back, 'the record is live again');
    assert.equal(back.data.body, 'Inhalt');
  });
});

test('a purged delete is recreated under a NEW id and the answer says so', async () => {
  await withHistory('history-undo-purged', async ({ store, history }) => {
    const note = store.create('note', { title: 'Endgültig', body: 'Inhalt' });
    store.remove(note.id, { hard: true });
    assert.equal(store.get(note.id, { includeDeleted: true }), null, 'really purged');

    const entry = history.list().items[0];
    const result = await history.undo(entry.seq);

    assert.equal(result.applied.op, 'recreate');
    assert.notEqual(result.applied.newId, note.id, 'the old id does NOT come back');
    assert.equal(result.applied.oldId, note.id);
    assert.match(result.applied.note, /neuen Kennung/, 'and the result says so in German');

    assert.equal(store.get(note.id, { includeDeleted: true }), null);
    const recreated = store.get(result.applied.newId);
    assert.equal(recreated.data.title, 'Endgültig');
    assert.equal(recreated.data.body, 'Inhalt');
  });
});

test('the undo itself is never journalled', async () => {
  await withHistory('history-undo-not-journalled', async ({ store, history, paths }) => {
    const note = store.create('note', { title: 'Alt' });
    store.update(note.id, { title: 'Neu' });
    const before = history.list().total;
    assert.equal(before, 2);

    const entry = history.list().items[0];
    await history.undo(entry.seq);

    assert.equal(history.list().total, before, 'the inverse write produced no new entry');
    const ops = journalLines(paths)
      .map((line) => JSON.parse(line))
      .filter((line) => line.op);
    assert.equal(ops.length, 2, 'and none reached the file either');
  });
});

test('a field that had no value before is named, not silently left behind', async () => {
  await withHistory('history-undo-partial', async ({ store, history }) => {
    const note = store.create('note', { title: 'Ohne Extra' });
    // The store merges patches; it cannot remove a key again. An undo that
    // quietly left the field in place would be a half-undo wearing the label
    // of a whole one.
    store.update(note.id, { archiviert: true });

    const entry = history.list().items[0];
    assert.deepEqual(entry.fields, ['archiviert']);
    assert.deepEqual(entry.before, {}, 'there was no previous value to keep');

    const result = await history.undo(entry.seq);
    assert.match(result.applied.note, /archiviert/);
    assert.match(result.applied.note, /keinen Wert/);
    assert.equal(store.get(note.id).data.archiviert, true, 'and it really is still there');
  });
});

test('the bus hears about a recorded change and about an undo', async () => {
  await withHistory('history-events', async ({ store, bus, history }) => {
    const seen = [];
    bus.on('history.recorded', (evt) => seen.push(['recorded', evt.payload]));
    bus.on('history.undone', (evt) => seen.push(['undone', evt.payload]));

    const note = store.create('note', { title: 'Beobachtet' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'recorded');
    assert.equal(seen[0][1].entry.id, note.id);

    await history.undo(history.list().items[0].seq);
    assert.equal(seen.length, 2, 'the undo itself produces no second recording');
    assert.equal(seen[1][0], 'undone');
    assert.equal(seen[1][1].applied.op, 'delete');
    assert.equal(seen[1][1].entry.undone, true);
  });
});

test('an entry that was undone refuses a second undo, with or without force', async () => {
  await withHistory('history-undo-twice', async ({ store, history }) => {
    const note = store.create('note', { title: 'Einmal reicht' });
    const entry = history.list().items[0];
    await history.undo(entry.seq);

    const after = history.get(entry.seq);
    assert.equal(after.canUndo, false);
    assert.equal(after.undone, true);
    assert.ok(after.undoneAt, 'and it says when');
    assert.equal(after.reason, 'Diese Änderung wurde bereits rückgängig gemacht.');

    await assert.rejects(() => history.undo(entry.seq), /bereits rückgängig/);
    await assert.rejects(() => history.undo(entry.seq, { force: true }), /bereits rückgängig/);
    assert.equal(store.get(note.id), null, 'and nothing changed a second time');
  });
});

test('the undone mark survives a reload', async () => {
  await withHistory('history-undone-persist', async ({ store, history, make }) => {
    store.create('note', { title: 'Merken' });
    const entry = history.list().items[0];
    await history.undo(entry.seq);

    const reloaded = make();
    const item = reloaded.get(entry.seq);
    assert.equal(item.undone, true);
    assert.equal(item.canUndo, false);
  });
});

test('Rueckgaengig Schritt fuer Schritt rueckwaerts: nach dem juengsten auch das davor, und nach einem Neuladen genauso', async () => {
  await withHistory('history-kette', async ({ store, history, make }) => {
    // Termin angelegt, zweimal verschoben -- dann alles rueckwaerts zuruecknehmen.
    const ev = store.create('event', { title: 'Zahnarzt', start: '2026-10-01T15:00' });
    store.update(ev.id, { start: '2026-10-02T09:00' });
    store.update(ev.id, { start: '2026-10-02T11:00' });
    const [zweite, erste, anlegen] = history.list({ type: 'event' }).items;
    assert.deepEqual([zweite.op, erste.op, anlegen.op], ['update', 'update', 'create']);

    await history.undo(zweite.seq);
    assert.equal(store.get(ev.id).data.start, '2026-10-02T09:00');
    // Vorher: 409 "Fassung 2 -> 4", weil das Zuruecknehmen selbst die Fassung hochzaehlt.
    assert.equal(history.get(erste.seq).canUndo, true, 'die Aenderung davor ist jetzt wieder die juengste');
    await history.undo(erste.seq);
    assert.equal(store.get(ev.id).data.start, '2026-10-01T15:00');

    // Auch ein zweiter Verlauf ueber derselben Datei (Neustart) kennt die Kette.
    const neu = make();
    assert.equal(neu.get(anlegen.seq).canUndo, true);
    await neu.undo(anlegen.seq);
    assert.equal(store.get(ev.id), null, 'der Termin ist weg');
  });
});

test('Die Kette reisst, sobald danach jemand anderes aendert -- und der Grund nennt, wer, ohne Fassungsnummern', async () => {
  await withHistory('history-kette-fremd', async ({ store, history }) => {
    const ev = store.create('event', { title: 'Training', start: '2026-10-06T18:00' });
    store.update(ev.id, { exdates: ['2026-10-13'] });
    const [aendern, anlegen] = history.list({ type: 'event' }).items;
    await history.undo(aendern.seq);
    store.update(ev.id, { location: 'Halle 5' }); // danach: eine neue Aenderung
    const state = history.get(anlegen.seq);
    assert.equal(state.canUndo, false);
    assert.match(state.reason, /von dir erneut geändert/);
    assert.match(state.reason, /Nimm zuerst diese spätere Änderung zurück/);
    assert.ok(!/Fassung/.test(state.reason), 'keine technischen Fassungsnummern');
  });
});

test('a record changed after the journalled change is not silently overwritten', async () => {
  await withHistory('history-conflict', async ({ store, history }) => {
    const note = store.create('note', { title: 'Alt', body: 'A' });
    store.update(note.id, { body: 'B' });
    const entry = history.list().items[0];

    // Somebody (or something) edits it again afterwards.
    store.update(note.id, { body: 'C' });

    const stale = history.get(entry.seq);
    assert.equal(stale.canUndo, false);
    assert.match(stale.reason, /erneut geändert/);

    await assert.rejects(() => history.undo(entry.seq), (err) => {
      assert.equal(err.code, 'HISTORY_NOT_UNDOABLE');
      assert.equal(err.status, 409);
      assert.match(err.message, /erneut geändert/);
      return true;
    });
    assert.equal(store.get(note.id).data.body, 'C', 'the refusal changed nothing');

    const forced = await history.undo(entry.seq, { force: true });
    assert.equal(forced.applied.op, 'update');
    assert.equal(store.get(note.id).data.body, 'A', 'force really discards the newer value');
  });
});

test('a forced undo that finds the work already done says so instead of claiming it', async () => {
  await withHistory('history-force-noop', async ({ store, history }) => {
    const note = store.create('note', { title: 'Schon weg' });
    const entry = history.list().items[0];

    // Deleted by hand first: the create-entry's inverse has nothing left to do.
    store.remove(note.id);
    const result = await history.undo(entry.seq, { force: true });
    assert.equal(result.applied.op, 'delete');
    assert.match(result.applied.note, /bereits gelöscht/);
    assert.match(result.applied.note, /nichts geändert/);
  });
});

test('an entry whose record was purged cannot be undone, and says why', async () => {
  await withHistory('history-gone', async ({ store, history }) => {
    const note = store.create('note', { title: 'Futsch' });
    store.update(note.id, { title: 'Immer noch da' });
    const entry = history.list().items[0];
    assert.equal(entry.op, 'update');

    store.remove(note.id, { hard: true });

    const stale = history.get(entry.seq);
    assert.equal(stale.canUndo, false);
    assert.equal(stale.reason, 'Der Eintrag existiert nicht mehr.');
    await assert.rejects(() => history.undo(entry.seq), /existiert nicht mehr/);
    await assert.rejects(() => history.undo(entry.seq, { force: true }), /existiert nicht mehr/);
  });
});

test('an unknown entry is a 404, not an empty answer', async () => {
  await withHistory('history-unknown', async ({ history }) => {
    await assert.rejects(() => history.undo(9999), (err) => {
      assert.equal(err.code, 'NOT_FOUND');
      assert.equal(err.status, 404);
      return true;
    });
  });
});

/* ----------------------------------------------------------- the bounds */

test('the journal is capped: the file is trimmed and the newest entries survive', async () => {
  await withHistory('history-cap', async ({ store, history, paths }) => {
    for (let i = 0; i < 40; i++) store.create('note', { title: `N${i}` });

    const listed = history.list({ limit: 500 });
    assert.equal(listed.total, 10, 'maxEntries is respected');
    assert.equal(listed.items[0].label, 'Notiz „N39" angelegt', 'the newest is kept');
    assert.equal(listed.items[9].label, 'Notiz „N30" angelegt');

    const lines = journalLines(paths);
    assert.ok(lines.length <= 13, `the file was trimmed (${lines.length} lines)`);
    // Read the labels back rather than grepping the raw JSON, where the
    // closing quote of a German label is escaped and a substring search
    // quietly matches nothing at all.
    const labels = lines.map((line) => JSON.parse(line)).map((entry) => entry.label);
    assert.ok(!labels.includes('Notiz „N0" angelegt'), 'the oldest is gone from disk too');
    assert.ok(labels.includes('Notiz „N39" angelegt'), 'the newest really is in the file');
    assert.equal(labels.length, lines.length, 'every line is an entry; marks were folded in');
  }, { config: { history: { maxEntries: 10 } } });
});

test('entries older than maxDays fall out of the journal', async () => {
  const { home, cleanup } = tempHome('history-age');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  // A test that had to wait thirty days would not be a test.
  const clock = { at: new Date('2026-01-01T09:00:00.000Z') };
  const history = createHistory({
    store, bus, paths, config: { history: { maxDays: 2 } }, logger: silentLogger, now: () => clock.at,
  });
  history.start();
  try {
    store.create('note', { title: 'Vorgestern' });
    assert.equal(history.list().total, 1);

    clock.at = new Date('2026-01-05T09:00:00.000Z');
    store.create('note', { title: 'Heute' });

    const listed = history.list();
    assert.equal(listed.total, 1, 'the four-day-old entry is past the age cap');
    assert.equal(listed.items[0].label, 'Notiz „Heute" angelegt');
    assert.equal(history.stats().total, 1);
  } finally {
    history.stop();
    await store.close().catch(() => {});
    cleanup();
  }
});

test('config without a history section falls back to the defaults instead of throwing', async () => {
  await withHistory('history-noconfig', async ({ history }) => {
    assert.deepEqual(history.limits, { maxEntries: 2000, maxDays: 30 });
  }, { config: configMod.defaults() });
});

/* ------------------------------------------------------------- lifecycle */

test('stop() really unsubscribes: writes afterwards add nothing', async () => {
  await withHistory('history-stop', async ({ store, bus, history }) => {
    assert.equal(bus.listenerCount('record.created'), 1);
    store.create('note', { title: 'Eins' });
    assert.equal(history.list().total, 1);

    assert.equal(history.stop(), true);
    assert.equal(bus.listenerCount('record.created'), 0, 'a leaked subscription is a bug');
    assert.equal(bus.listenerCount('record.updated'), 0);
    assert.equal(bus.listenerCount('record.deleted'), 0);

    const note = store.create('note', { title: 'Zwei' });
    store.update(note.id, { title: 'Drei' });
    store.remove(note.id);
    assert.equal(history.list().total, 1, 'a stopped journal records nothing');
    assert.equal(history.stop(), false, 'stopping twice is not an error');
  });
});

test('the journal survives a compaction that deletes every log segment', async () => {
  await withHistory('history-compact', async ({ store, history, paths, make }) => {
    const note = store.create('note', { title: 'Überlebt', body: 'A' });
    store.update(note.id, { body: 'B' });
    const before = history.list().total;
    assert.equal(before, 2);

    await store.compact();
    const segments = fs.readdirSync(paths.log).filter((f) => f.endsWith('.jsonl'));
    assert.equal(segments.length, 0, 'compaction really did delete the write log');

    assert.equal(history.list().total, before, 'the journal is untouched by it');
    assert.equal(make().list().total, before, 'and still on disk');

    const entry = history.list().items[0];
    assert.equal(entry.canUndo, true, 'and still undoable');
    await history.undo(entry.seq);
    assert.equal(store.get(note.id).data.body, 'A');
  });
});

test('an encrypted vault gets an encrypted journal', async () => {
  await withHistory('history-crypto', async ({ store, paths, make }) => {
    const note = store.create('note', { title: 'Espresso', body: 'Geheimer Text' });
    store.update(note.id, { body: 'Anderer Text' });

    const raw = fs.readFileSync(journalFile(paths), 'utf8');
    assert.ok(!raw.includes('Espresso'), 'the title must not be readable on disk');
    assert.ok(!raw.includes('Geheimer Text'), 'nor the previous body');
    assert.ok(!raw.includes('Notiz'), 'nor the German label');

    // And it is really encryption, not loss: the same key reads it back.
    const reloaded = make();
    const items = reloaded.list().items;
    assert.equal(items.length, 2);
    assert.equal(items[0].before.body, 'Geheimer Text');
    assert.equal(items[1].label, 'Notiz „Espresso" angelegt');
  }, { vaultCrypto: fakeCrypto() });
});

test('stats report what is there and what is still undoable', async () => {
  await withHistory('history-stats', async ({ store, history }) => {
    assert.deepEqual(history.stats(), {
      total: 0, undoable: 0, byActor: { user: 0, agent: 0 },
      oldest: null, newest: null, bytes: 0, unreadable: 0, failedWrites: 0,
    });

    const keep = store.create('note', { title: 'Bleibt' });
    const undone = store.create('note', { title: 'Wird zurückgenommen' });
    store.create('note', { title: 'Vom Agenten', source: 'agent', runId: RUN_ID, agentId: AGENT_ID });
    await history.undo(history.list().items[1].seq);

    const stats = history.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.undoable, 2, 'the undone one no longer counts');
    assert.deepEqual(stats.byActor, { user: 2, agent: 1 });
    assert.ok(stats.bytes > 0);
    assert.ok(stats.oldest <= stats.newest);
    assert.equal(stats.unreadable, 0);
    assert.ok(store.get(keep.id));
    assert.equal(store.get(undone.id), null);
  });
});

test('a damaged line is kept, not dropped, and does not stop the rest', async () => {
  await withHistory('history-damaged', async ({ store, paths, make }) => {
    store.create('note', { title: 'Erste' });
    store.create('note', { title: 'Zweite' });
    const lines = journalLines(paths);
    fs.writeFileSync(journalFile(paths), `völlig kaputt\n${lines.join('\n')}\n`);

    const reloaded = make();
    assert.equal(reloaded.list().total, 2, 'the readable entries are still there');
    assert.equal(reloaded.stats().unreadable, 1, 'and the damage is reported, not hidden');
  });
});

/* ------------------------------------------------------------------ HTTP */

/**
 * The server builds its router from a fixed list of route files and this agent
 * may not edit that file, so until the integrator adds `require('./api/history')`
 * to it, the registration is injected through the last route module the server
 * loads -- and only for the duration of the call, so no other test file
 * inherits the patch. The server itself is the real one, unpatched.
 */
const SERVER_FILE = require.resolve('../src/http/server');
const SERVER_REGISTERS_HISTORY = /require\(['"]\.\/api\/history['"]\)/
  .test(fs.readFileSync(SERVER_FILE, 'utf8'));
const historyApi = require('../src/http/api/history');

async function createServerWithHistory(ctx) {
  if (SERVER_REGISTERS_HISTORY) return createServer(ctx);
  const lastLoadedApi = require('../src/http/api/automation');
  const original = lastLoadedApi.register;
  lastLoadedApi.register = function registerWithHistory(router) {
    original.call(this, router);
    historyApi.register(router);
  };
  try {
    return await createServer(ctx);
  } finally {
    lastLoadedApi.register = original;
  }
}

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not every route answers JSON */ }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn, opts = {}) {
  const { home, cleanup } = tempHome('history-api');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  const bus = new Bus();
  const audit = new Audit(paths.audit).open();
  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto: null });
  const history = opts.history === undefined
    ? createHistory({ store, bus, paths, logger: silentLogger })
    : opts.history;
  if (history) history.start();

  const ctx = {
    version: 'test', config, paths, store, bus, audit, logger: silentLogger, history, failures: [],
  };
  const server = await createServerWithHistory(ctx);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    await fn({ base, store, history, req: (m, p, b) => request(base, m, p, b) });
  } finally {
    if (history) history.stop();
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    audit.close();
    cleanup();
  }
}

test('GET /api/history lists newest first and filters by actor and type', async () => {
  await withServer(async ({ store, req }) => {
    store.create('note', { title: 'Von Hand' });
    store.create('note', { title: 'Vom Agenten', source: 'agent', runId: RUN_ID, agentId: AGENT_ID });
    store.create('task', { title: 'Aufgabe' });

    const all = await req('GET', '/api/history');
    assert.equal(all.status, 200);
    assert.equal(all.json.total, 3);
    assert.equal(all.json.items[0].label, 'Aufgabe „Aufgabe" angelegt');
    assert.equal(all.json.items[0].canUndo, true);

    const agents = await req('GET', '/api/history?actor=agent');
    assert.equal(agents.json.total, 1);
    assert.equal(agents.json.items[0].actor.runId, RUN_ID);

    const notes = await req('GET', '/api/history?type=note');
    assert.equal(notes.json.total, 2);

    const paged = await req('GET', '/api/history?limit=1&offset=1');
    assert.equal(paged.json.total, 3);
    assert.equal(paged.json.items.length, 1);
    assert.equal(paged.json.items[0].type, 'note');

    const bad = await req('GET', '/api/history?actor=roboter');
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /user oder agent/);
  });
});

test('GET /api/history/stats answers the summary', async () => {
  await withServer(async ({ store, req }) => {
    store.create('note', { title: 'Eins' });
    const res = await req('GET', '/api/history/stats');
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 1);
    assert.equal(res.json.undoable, 1);
    assert.deepEqual(res.json.byActor, { user: 1, agent: 0 });
  });
});

test('POST /api/history/:id/undo really undoes, and refuses a conflict with 409', async () => {
  await withServer(async ({ store, req }) => {
    const note = store.create('note', { title: 'Alt', body: 'A' });
    store.update(note.id, { body: 'B' });

    const listed = await req('GET', '/api/history');
    const entry = listed.json.items[0];
    assert.equal(entry.op, 'update');

    store.update(note.id, { body: 'C' });

    const refused = await req('POST', `/api/history/${entry.seq}/undo`);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, 'HISTORY_NOT_UNDOABLE');
    assert.match(refused.json.error.message, /erneut geändert/);
    assert.equal(store.get(note.id).data.body, 'C');

    const forced = await req('POST', `/api/history/${entry.seq}/undo`, { force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.json.applied.op, 'update');
    assert.equal(store.get(note.id).data.body, 'A', 'the store really changed');

    const missing = await req('POST', '/api/history/9999/undo');
    assert.equal(missing.status, 404);
  });
});

test('without the subsystem the routes answer 503, never an empty list', async () => {
  await withServer(async ({ req }) => {
    const listed = await req('GET', '/api/history');
    assert.equal(listed.status, 503);
    assert.equal(listed.json.error.code, 'SUBSYSTEM_UNAVAILABLE');
    assert.match(listed.json.error.message, /Änderungsverlauf/);

    const undone = await req('POST', '/api/history/1/undo');
    assert.equal(undone.status, 503);
  }, { history: null });
});

module.exports = { name: 'history', tests: drain() };
