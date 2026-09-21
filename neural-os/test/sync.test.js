'use strict';

/**
 * Device synchronisation.
 *
 * The end-to-end part builds TWO real installations in two throwaway homes --
 * two stores, two gates, two HTTP servers, two access tokens -- and lets them
 * talk over real sockets on 127.0.0.1. Nothing is stubbed on the merge path:
 * when a test says a conflict was raised, a real record went through a real
 * request and a real `store.transaction`.
 *
 * The routes are mounted by a small shell in this file rather than by
 * `src/http/server.js`, because that file's module list is owned elsewhere and
 * does not require `./api/sync` yet. The shell uses the REAL router and the
 * REAL `createAuth` middleware, so the host check, the CSRF rule and the token
 * verification are exercised exactly as they are in production.
 *
 * Nothing here touches the internet or the real home directory.
 */

const assert = require('node:assert/strict');
const http = require('node:http');

const { test, drain, tempHome } = require('./harness');

const merge = require('../src/sync/merge');
const { createSync } = require('../src/sync/peer');
const syncApi = require('../src/http/api/sync');

const { openStore } = require('../src/store/engine');
const { createGate } = require('../src/net/gate');
const { createAuth } = require('../src/http/auth');
const { __internals: serverInternals } = require('../src/http/server');
const { Bus } = require('../src/kernel/bus');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');
const { asNeuralError, PermissionError } = require('../src/kernel/errors');

const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

/* ------------------------------------------------------------- fixtures */

function record(over = {}) {
  return {
    id: 'note_aaaaaaaaaaaaaaaaaaaaaaaa',
    type: 'note',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    rev: 1,
    data: { title: 'A', body: '', tags: [], pinned: false, source: 'user' },
    ...over,
  };
}

function withData(base, data, over = {}) {
  return { ...base, data: { ...base.data, ...data }, rev: base.rev + 1, updatedAt: '2026-01-02T00:00:00.000Z', ...over };
}

/* ---------------------------------------------------- the test HTTP shell */

/**
 * The same request context `src/http/server.js` builds, reduced to what the
 * sync routes actually use. Capability and owner checks are copied verbatim so
 * a route that passes here passes there.
 */
function makeContext(req, res, url, ctx) {
  const rc = {
    req,
    res,
    ctx,
    method: req.method,
    pathname: url.pathname,
    query: url.searchParams,
    params: {},
    identity: null,
    handled: false,
    async body() {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? JSON.parse(raw) : {};
    },
    requireCapability(capability) {
      const identity = rc.identity || {};
      if (identity.kind === 'owner') return;
      if (identity.permissions === 'all') return;
      if (identity.permissions && identity.permissions[capability] === true) return;
      throw new PermissionError(`Dieser Zugang darf nicht: ${capability}.`, { capability });
    },
    requireOwner(what) {
      if ((rc.identity || {}).kind === 'owner') return;
      throw new PermissionError(`${what || 'Diese Einstellung'} darf nur am Gerät selbst geändert werden.`);
    },
  };
  return rc;
}

function send(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

async function mountSyncApi(ctx, hooks = {}) {
  const router = serverInternals.createRouter();
  syncApi.register(router);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://neural-os.invalid');
      if (typeof hooks.onRequest === 'function') hooks.onRequest(req, url);
      const rc = makeContext(req, res, url, ctx);
      const verdict = await ctx.auth.middleware(req, res);
      if (!verdict.ok) throw verdict.error;
      rc.identity = verdict.identity;
      const matched = router.match(req.method, url.pathname);
      if (!matched || !matched.route) {
        send(res, 404, { error: { code: 'NOT_FOUND', message: `Route ${req.method} ${url.pathname} not found` } });
        return;
      }
      rc.params = matched.params;
      const result = await matched.route.handler(rc);
      if (res.writableEnded) return;
      send(res, 200, result === undefined || result === null ? { ok: true } : result);
    } catch (err) {
      const neural = asNeuralError(err);
      if (res.writableEnded) return;
      send(res, neural.status >= 100 && neural.status <= 599 ? neural.status : 500, neural.toJSON());
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ------------------------------------------------------------- a device */

async function makeDevice(label, hooks = {}, opts = {}) {
  const { home, cleanup } = tempHome(`nos-sync-${label}`);
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger, vaultCrypto: null });
  const gate = createGate({ config, bus, store, logger: silentLogger });
  const auth = createAuth({ store, config, logger: silentLogger });

  // A partner needs read+write+sync. Minting the token before switching
  // sharing on is the documented order in src/http/auth.js.
  const partnerToken = await auth.createToken({
    label: `partner-${label}`,
    permissions: { read: true, write: true, sync: true },
  });
  const readerToken = await auth.createToken({ label: `reader-${label}`, permissions: { read: true } });
  // Sharing off means loopback == owner and no token, which is how the
  // interface itself talks to this server. On means every caller needs a
  // token, which is how a partner device talks to it.
  config.security.sharing.enabled = opts.sharing !== false;
  config.security.sharing.requireToken = true;

  const sync = createSync({ store, gate, config, bus, logger: silentLogger, paths });
  const ctx = { config, paths, store, gate, bus, sync, auth, logger: silentLogger };
  const http_ = await mountSyncApi(ctx, hooks);

  const events = [];
  bus.subscribe((evt) => { if (evt.name.startsWith('sync.')) events.push(evt); });

  return {
    label,
    home,
    paths,
    config,
    bus,
    store,
    gate,
    auth,
    sync,
    events,
    url: http_.url,
    token: partnerToken.token,
    readerToken: readerToken.token,
    async close() {
      await http_.close();
      await store.close().catch(() => {});
      cleanup();
    },
  };
}

/** Point `a` at `b` and learn `b`'s device id, as the settings screen would. */
async function link(a, b, over = {}) {
  const peer = a.sync.createPeer({ name: b.label, url: b.url, token: b.token, ...over });
  if (!over.token) {
    const probe = await a.sync.test(peer.id);
    assert.equal(probe.reachable, true, `${a.label} erreicht ${b.label} nicht: ${probe.error}`);
  }
  return peer.id;
}

async function withPair(fn, hooks = {}) {
  const a = await makeDevice('a', hooks.a);
  const b = await makeDevice('b', hooks.b);
  try {
    const toB = await link(a, b);
    const toA = await link(b, a);
    await fn({ a, b, toB, toA });
  } finally {
    await b.close();
    await a.close();
  }
}

function titleOf(device, id) {
  const found = device.store.get(id, { includeDeleted: true });
  return found ? found.data.title : null;
}

/* ============================================================ merge tests */

test('fingerprint ignoriert Schlüsselreihenfolge, rev und Zeitstempel', () => {
  const one = record({ data: { title: 'A', body: 'x', tags: ['t'] } });
  const two = record({ rev: 9, updatedAt: '2030-01-01T00:00:00.000Z', data: { tags: ['t'], body: 'x', title: 'A' } });
  assert.equal(merge.fingerprint(one), merge.fingerprint(two));
  assert.notEqual(merge.fingerprint(one), merge.fingerprint(withData(one, { title: 'B' })));
});

test('ein Grabstein und ein nie vorhandener Eintrag sind derselbe Zustand', () => {
  assert.equal(merge.fingerprint(null), merge.GONE);
  assert.equal(merge.fingerprint(record({ deletedAt: '2026-02-01T00:00:00.000Z' })), merge.GONE);
});

test('classify deckt jeden Fall ab und rät nie', () => {
  const base0 = record();
  const hash0 = merge.fingerprint(base0);
  const localEdit = withData(base0, { title: 'lokal' });
  const remoteEdit = withData(base0, { title: 'entfernt' });

  assert.equal(merge.classify(base0, base0, null), 'identical');
  assert.equal(merge.classify(base0, remoteEdit, { h: hash0 }), 'remote-newer');
  assert.equal(merge.classify(localEdit, base0, { h: hash0 }), 'local-newer');
  assert.equal(merge.classify(localEdit, remoteEdit, { h: hash0 }), 'conflict');
  assert.equal(merge.classify(null, base0, null), 'remote-only');
  assert.equal(merge.classify(base0, null, null), 'local-only');

  // Ohne gemeinsamen Stand wird NICHT geraten, auch nicht über Zeitstempel.
  assert.equal(merge.classify(localEdit, remoteEdit, null), 'conflict');
  assert.throws(() => merge.classify(null, null, null), /mindestens eine/);
});

test('classify behandelt Löschungen wie jede andere Änderung', () => {
  const live = record();
  const hash = merge.fingerprint(live);
  const tombstone = { ...live, deletedAt: '2026-02-01T00:00:00.000Z', rev: 2 };
  const edited = withData(live, { title: 'weiterbearbeitet' });

  // Löschung gegen unveränderten lokalen Stand: sauberer Nachfolger.
  assert.equal(merge.classify(live, tombstone, { h: hash }), 'remote-newer');
  // Löschung gegen NEUERE lokale Bearbeitung: Konflikt, kein Sieg.
  assert.equal(merge.classify(edited, tombstone, { h: hash }), 'conflict');
  // Beide gelöscht, und "hier nie gehabt" zählt als gelöscht.
  assert.equal(merge.classify(null, tombstone, null), 'identical');
  assert.equal(merge.classify({ ...live, deletedAt: '2026-03-01T00:00:00.000Z' }, tombstone, null), 'identical');
  // Der Partner hat einen gemeinsam als gelöscht bekannten Eintrag zurückgeholt.
  assert.equal(merge.classify(null, live, { h: merge.GONE }), 'remote-newer');
});

test('eine endgültige Löschung wird nicht rückgängig gemacht, sondern gemeldet', () => {
  const live = record();
  const planned = merge.plan([], [live], { bases: { [live.id]: { h: merge.fingerprint(live) } } });
  assert.equal(planned.apply.length, 0);
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.skip.length, 1);
  assert.equal(planned.skip[0].reason, 'purged');
  assert.match(planned.skip[0].detail, /endgültig gelöscht/);
});

test('plan überschreibt bei beidseitiger Änderung nichts und führt beide Fassungen mit', () => {
  const base0 = record();
  const hash = merge.fingerprint(base0);
  const local = withData(base0, { title: 'lokal' });
  const remote = withData(base0, { title: 'entfernt' });

  const planned = merge.plan([local], [remote], { bases: { [base0.id]: { h: hash } } });
  assert.equal(planned.apply.length, 0, 'bei einem Konflikt darf nichts angewendet werden');
  assert.equal(planned.conflicts.length, 1);
  assert.equal(planned.conflicts[0].local.data.title, 'lokal');
  assert.equal(planned.conflicts[0].remote.data.title, 'entfernt');
  assert.ok(planned.conflicts[0].reason.length > 10, 'der Konflikt muss erklärt werden');
});

test('ein fehlender Eintrag in einer Teillieferung ist keine Löschung', () => {
  const kept = record({ id: 'note_bbbbbbbbbbbbbbbbbbbbbbbb' });
  const sent = record({ id: 'note_cccccccccccccccccccccccc' });
  const planned = merge.plan([kept], [sent], {});
  assert.equal(planned.apply.length, 1);
  assert.equal(planned.apply[0].id, sent.id);
  assert.equal(planned.skip.length, 0);
  assert.equal(planned.localOnly.length, 0, 'ohne includeLocalOnly wird der lokale Eintrag gar nicht bewertet');
});

test('Berechtigungen, Token und Partner werden niemals übertragen', () => {
  const rows = ['token', 'grant', 'agent', 'peer', 'conflict', 'approval', 'run'].map((type, i) => record({
    id: `${type}_${String(i).repeat(24)}`.slice(0, type.length + 25),
    type,
    data: { label: 'x' },
  }));
  const planned = merge.plan([], rows, {});
  assert.equal(planned.apply.length, 0);
  assert.equal(planned.skip.length, rows.length);
  for (const entry of planned.skip) assert.equal(entry.reason, 'type-not-synced');
});

test('bei großer Uhrenabweichung wird eine eingehende Löschung zum Konflikt', () => {
  const live = record();
  const hash = merge.fingerprint(live);
  const tombstone = { ...live, deletedAt: '2026-02-01T00:00:00.000Z', rev: 2 };

  const calm = merge.plan([live], [tombstone], { bases: { [live.id]: { h: hash } } }, { clockSkewMs: 1000 });
  assert.equal(calm.apply.length, 1);
  assert.equal(calm.apply[0].action, 'delete');

  const skewed = merge.plan([live], [tombstone], { bases: { [live.id]: { h: hash } } }, { clockSkewMs: 9 * 60 * 1000 });
  assert.equal(skewed.apply.length, 0);
  assert.equal(skewed.conflicts.length, 1);
  assert.equal(skewed.skewed, true);
  assert.match(skewed.warnings.join(' '), /Uhren/);
});

test('ein Eintrag derselben ID mit anderer Art wird nicht überschrieben', () => {
  const local = record();
  const remote = { ...record(), type: 'task', data: { title: 'T', status: 'todo' } };
  const planned = merge.plan([local], [remote], {});
  assert.equal(planned.apply.length, 0);
  assert.equal(planned.skip[0].reason, 'type-mismatch');
});

/* ======================================================== end-to-end tests */

test('einseitige Änderungen kommen beim Partner an (holen und senden)', async () => {
  await withPair(async ({ a, b, toB, toA }) => {
    const note = a.store.create('note', { title: 'Von A', body: 'Text A' });
    const pushed = await a.sync.push(toB);
    assert.equal(pushed.sent, 1);
    assert.equal(pushed.accepted, 1);
    assert.equal(pushed.rejected, 0);
    assert.equal(titleOf(b, note.id), 'Von A');

    const project = b.store.create('project', { name: 'Von B' });
    const pulled = await a.sync.pull(toB);
    assert.ok(pulled.fetched >= 1);
    assert.equal(pulled.conflicts, 0);
    const mirrored = a.store.get(project.id);
    assert.ok(mirrored, 'das Projekt von B muss bei A ankommen');
    assert.equal(mirrored.data.name, 'Von B');
    assert.equal(mirrored.type, 'project');

    // Die Gegenrichtung sieht denselben Bestand.
    await b.sync.pull(toA);
    assert.equal(titleOf(b, note.id), 'Von A');
  });
});

test('beidseitige Änderungen am selben Eintrag erzeugen einen Konflikt und überschreiben nichts', async () => {
  await withPair(async ({ a, b, toB }) => {
    const note = a.store.create('note', { title: 'Original', body: 'x' });
    await a.sync.push(toB);
    await b.sync.pull(await peerIdOf(b, a));
    assert.equal(titleOf(b, note.id), 'Original');

    a.store.update(note.id, { title: 'A ändert' });
    b.store.update(note.id, { title: 'B ändert' });

    const pushed = await a.sync.push(toB);
    assert.equal(pushed.conflicts, 1, 'beidseitige Änderung muss ein Konflikt sein');
    assert.equal(pushed.accepted, 0);

    // Nichts wurde überschrieben -- auf beiden Geräten steht die eigene Fassung.
    assert.equal(titleOf(a, note.id), 'A ändert');
    assert.equal(titleOf(b, note.id), 'B ändert');

    const onB = b.sync.listConflicts({ status: 'open' });
    assert.equal(onB.total, 1);
    assert.equal(onB.items[0].recordId, note.id);
    assert.equal(onB.items[0].local.data.title, 'B ändert');
    assert.equal(onB.items[0].remote.data.title, 'A ändert');

    // Auch der sendende Seite wird der Konflikt vorgelegt, mit beiden Fassungen.
    const onA = a.sync.listConflicts({ status: 'open' });
    assert.equal(onA.total, 1);
    assert.equal(onA.items[0].local.data.title, 'A ändert');
    assert.equal(onA.items[0].remote.data.title, 'B ändert');
  });
});

test('nach der Auflösung stimmen beide Seiten überein', async () => {
  await withPair(async ({ a, b, toB, toA }) => {
    const note = a.store.create('note', { title: 'Original' });
    await a.sync.push(toB);
    await b.sync.pull(toA);

    a.store.update(note.id, { title: 'A ändert' });
    b.store.update(note.id, { title: 'B ändert' });
    await a.sync.push(toB);

    const conflict = b.sync.listConflicts({ status: 'open' }).items[0];
    const resolved = b.sync.resolveConflict(conflict.id, 'remote');
    assert.equal(resolved.conflict.status, 'resolved');
    assert.equal(resolved.conflict.resolution, 'remote');
    assert.equal(titleOf(b, note.id), 'A ändert');
    assert.equal(b.sync.listConflicts({ status: 'open' }).total, 0);

    // Aufräumen auf der Senderseite: A behält seine Fassung, die jetzt auch B hat.
    const onA = a.sync.listConflicts({ status: 'open' }).items[0];
    a.sync.resolveConflict(onA.id, 'local');

    // Ein weiterer Durchgang darf keinen neuen Konflikt erzeugen.
    const again = await a.sync.pull(toB);
    assert.equal(again.conflicts, 0);
    assert.equal(again.applied, 0);
    const back = await b.sync.pull(toA);
    assert.equal(back.conflicts, 0);
    assert.equal(titleOf(a, note.id), 'A ändert');
    assert.equal(titleOf(b, note.id), 'A ändert');
  });
});

test('eine entfernte Löschung räumt eine neuere lokale Bearbeitung nicht weg', async () => {
  await withPair(async ({ a, b, toB, toA }) => {
    const note = a.store.create('note', { title: 'Wichtig', body: 'darf nicht verschwinden' });
    await a.sync.push(toB);
    await b.sync.pull(toA);
    assert.equal(titleOf(b, note.id), 'Wichtig');

    a.store.remove(note.id); // Tombstone auf A
    b.store.update(note.id, { body: 'B hat gerade daran gearbeitet' });

    const pushed = await a.sync.push(toB);
    assert.equal(pushed.conflicts, 1);

    const survivor = b.store.get(note.id);
    assert.ok(survivor, 'die lokale Bearbeitung darf nicht gelöscht worden sein');
    assert.equal(survivor.deletedAt, null);
    assert.equal(survivor.data.body, 'B hat gerade daran gearbeitet');

    const open = b.sync.listConflicts({ status: 'open' });
    assert.equal(open.total, 1);
    assert.ok(open.items[0].remote.deletedAt, 'die Fassung des Partners ist die Löschung');
  });
});

test('mehrfaches Synchronisieren ist idempotent: keine Duplikate, kein Aufschaukeln', async () => {
  await withPair(async ({ a, b, toB, toA }) => {
    a.store.create('note', { title: 'Eins' });
    a.store.create('note', { title: 'Zwei' });
    const project = b.store.create('project', { name: 'Projekt B' });
    b.store.create('task', { title: 'Aufgabe B', projectId: project.id });

    const rounds = [];
    for (let i = 0; i < 3; i++) {
      const pull = await a.sync.pull(toB);
      const push = await a.sync.push(toB);
      await b.sync.pull(toA);
      rounds.push({
        fetched: pull.fetched,
        applied: pull.applied + push.applied,
        conflicts: pull.conflicts + push.conflicts,
      });
    }

    assert.equal(a.store.count('note'), 2);
    assert.equal(b.store.count('note'), 2);
    assert.equal(a.store.count('project'), 1);
    assert.equal(a.store.count('task'), 1);
    assert.equal(b.store.count('project'), 1);
    assert.equal(rounds[1].applied, 0, `zweiter Durchgang darf nichts mehr bewegen, bewegte ${rounds[1].applied}`);
    assert.equal(rounds[2].applied, 0);
    // Erneut geholt wird durchaus (das Sicherheitsfenster des Wasserstands),
    // nur bewirken darf es nichts mehr.
    assert.ok(rounds[2].fetched > 0, 'das Sicherheitsfenster holt bewusst noch einmal');
    for (const round of rounds) assert.equal(round.conflicts, 0);
    assert.equal(a.sync.listConflicts({ status: 'all' }).total, 0);
    assert.equal(b.sync.listConflicts({ status: 'all' }).total, 0);
  });
});

test('ein Abbruch mitten im Vorgang hinterlässt keinen halben Zustand', async () => {
  const controller = new AbortController();
  await withPair(async ({ a, b, toB }) => {
    b.store.create('note', { title: 'B eins' });
    b.store.create('note', { title: 'B zwei' });
    b.store.create('note', { title: 'B drei' });
    const before = a.store.stats();

    await assert.rejects(
      () => a.sync.pull(toB, { signal: controller.signal }),
      (err) => {
        assert.equal(err.code, 'ABORTED');
        assert.match(err.message, /abgebrochen/i);
        return true;
      },
    );

    assert.equal(a.store.count('note'), 0, 'ein abgebrochener Abgleich darf nichts angelegt haben');
    assert.equal(a.store.count('conflict'), 0);
    assert.equal(a.store.stats().counts.note || 0, before.counts.note || 0);
    // Der Wasserstand darf sich nicht bewegt haben, sonst wären die Einträge
    // beim nächsten Durchgang für immer verloren.
    assert.equal(a.sync.getPeer(toB).watermark, 0);
    assert.ok(a.sync.getPeer(toB).lastError, 'der Abbruch muss am Partner vermerkt sein');

    // Danach holt ein normaler Durchgang alles nach.
    const done = await a.sync.pull(toB);
    assert.equal(done.applied, 3);
    assert.equal(a.store.count('note'), 3);
  }, {
    b: {
      onRequest(req, url) {
        // Genau dann abbrechen, wenn der Vorgang wirklich mitten drin ist.
        if (url.pathname === '/api/sync/changes') controller.abort();
      },
    },
  });
});

test('ein Partner mit falschem Token wird abgewiesen und der Fehler wird vermerkt', async () => {
  const a = await makeDevice('a');
  const b = await makeDevice('b');
  try {
    const peerId = await link(a, b, { token: 'nos_falsch.komplettfalsch' });
    const probe = await a.sync.test(peerId);
    assert.equal(probe.reachable, false);
    assert.match(probe.error, /Token/);

    await assert.rejects(() => a.sync.pull(peerId), (err) => {
      assert.equal(err.code, 'UNAUTHORIZED');
      return true;
    });

    const peer = a.sync.getPeer(peerId);
    assert.ok(peer.lastError, 'der Fehler muss am Partner stehen, nicht verschluckt werden');
    assert.match(peer.lastError, /Token/);
    assert.ok(a.events.some((e) => e.name === 'sync.failed'), 'der Fehler muss auf dem Bus liegen');
    assert.equal(b.store.count('note'), 0);
  } finally {
    await b.close();
    await a.close();
  }
});

test('ein Token ohne das Recht "sync" darf nicht abgleichen', async () => {
  const a = await makeDevice('a');
  const b = await makeDevice('b');
  try {
    const peerId = await link(a, b, { token: b.readerToken });
    const probe = await a.sync.test(peerId);
    assert.equal(probe.reachable, false);
    assert.match(probe.error, /synchronisieren/);
    assert.match(probe.error, /sync/);
  } finally {
    await b.close();
    await a.close();
  }
});

test('ein Gerät gleicht sich nicht mit sich selbst ab', async () => {
  const a = await makeDevice('a');
  try {
    const peerId = a.sync.createPeer({ name: 'ich selbst', url: a.url, token: a.token }).id;
    const probe = await a.sync.test(peerId);
    assert.equal(probe.reachable, false);
    assert.match(probe.error, /sich selbst/);
  } finally {
    await a.close();
  }
});

test('HTTP: /api/sync/changes liefert Tombstones und einen Fortsetzungspunkt', async () => {
  const a = await makeDevice('a');
  const b = await makeDevice('b');
  try {
    const note = b.store.create('note', { title: 'gleich weg' });
    b.store.remove(note.id);
    const peerId = await link(a, b);

    const peer = a.store.get(peerId);
    const res = await a.gate.fetch(`${peer.data.url}/api/sync/changes?since=0&limit=100`, {
      scope: `sync:${peerId}`,
      headers: { authorization: `Bearer ${b.token}`, 'x-neural-os': '1' },
    });
    assert.equal(res.status, 200);
    const page = await res.json();
    const found = page.records.find((r) => r.id === note.id);
    assert.ok(found, 'eine Löschung muss als Grabstein übertragen werden');
    assert.ok(found.deletedAt);
    assert.equal(page.hasMore, false);
    assert.ok(Number.isFinite(page.cursor));
  } finally {
    await b.close();
    await a.close();
  }
});

test('ein Partnergerät darf nur am Gerät selbst eingetragen werden', async () => {
  const a = await makeDevice('a');
  const b = await makeDevice('b');
  try {
    const peer = a.store.get(await link(a, b));
    const res = await a.gate.fetch(`${peer.data.url}/api/peers`, {
      method: 'POST',
      scope: 'sync:test',
      headers: { authorization: `Bearer ${b.token}`, 'x-neural-os': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'geschmuggelt', url: 'http://10.0.0.1:7777' }),
    });
    assert.equal(res.status, 403);
    assert.equal(b.store.count('peer'), 0, 'b hat selbst keinen Partner eingetragen und darf auch keinen bekommen');
  } finally {
    await b.close();
    await a.close();
  }
});

test('eine unbrauchbare Partneradresse wird sofort abgelehnt', async () => {
  const a = await makeDevice('a');
  try {
    assert.throws(() => a.sync.createPeer({ name: 'x', url: 'ftp://host/' }), /http und https/);
    assert.throws(() => a.sync.createPeer({ name: 'x', url: 'nicht mal eine url' }), /gültige Adresse/);
    assert.throws(() => a.sync.createPeer({ name: 'x', url: 'http://u:p@host:1/' }), /Token/);
    assert.throws(() => a.sync.createPeer({ name: '', url: 'http://host:1/' }), /Namen/);
  } finally {
    await a.close();
  }
});

test('ein Partner im Internet braucht eine ausdrückliche Freigabe', async () => {
  const a = await makeDevice('a');
  try {
    const peerId = a.sync.createPeer({ name: 'fern', url: 'http://203.0.113.9:7777', token: 'x' }).id;
    const probe = await a.sync.test(peerId);
    assert.equal(probe.reachable, false);
    assert.equal(probe.code, 'NETWORK_BLOCKED');
    assert.match(probe.error, /sync:/, 'die Meldung muss den nötigen Geltungsbereich nennen');
    assert.equal(a.gate.stats().blocked > 0, true);
  } finally {
    await a.close();
  }
});


test('Kanten werden mitsamt ihrer Identität übertragen', async () => {
  await withPair(async ({ a, b, toB }) => {
    const one = a.store.create('note', { title: 'Eins' });
    const two = a.store.create('note', { title: 'Zwei' });
    const edge = a.store.edges.add({ from: one.id, to: two.id, kind: 'links-to', reason: 'von Hand' });

    const pushed = await a.sync.push(toB);
    assert.equal(pushed.rejected, 0, JSON.stringify(pushed.results));
    const mirrored = b.store.get(edge.id);
    assert.ok(mirrored, 'die Kante muss unter derselben ID ankommen');
    assert.equal(mirrored.data.from, one.id);
    assert.equal(mirrored.data.to, two.id);
    assert.equal(mirrored.data.reason, 'von Hand');
    assert.equal(b.store.edges.between(one.id, two.id).length, 1);

    // Eine gelöschte Kante ist eine gewöhnliche Änderung.
    a.store.edges.remove(edge.id);
    await a.sync.push(toB);
    assert.equal(b.store.edges.between(one.id, two.id).length, 0);
  });
});

test('dieselbe Verbindung, beidseitig eigenständig gezogen, wird nicht verdoppelt', async () => {
  await withPair(async ({ a, b, toB }) => {
    const one = a.store.create('note', { title: 'Eins' });
    const two = a.store.create('note', { title: 'Zwei' });
    await a.sync.push(toB);

    // Beide Geräte ziehen dieselbe Verbindung, jedes mit eigener ID.
    const mine = a.store.edges.add({ from: one.id, to: two.id, kind: 'links-to', reason: 'auf A' });
    const theirs = b.store.edges.add({ from: one.id, to: two.id, kind: 'links-to', reason: 'auf B' });
    assert.notEqual(mine.id, theirs.id);

    const pushed = await a.sync.push(toB);
    const entry = pushed.results.find((r) => r.id === mine.id);
    assert.equal(entry.status, 'skipped');
    assert.equal(entry.reason, 'duplicate');
    assert.equal(b.store.edges.between(one.id, two.id).length, 1, 'es darf keine doppelte Kante entstehen');
    assert.equal(b.store.get(theirs.id).data.reason, 'auf B', 'die eigene Kante bleibt unangetastet');

    // Beim nächsten Durchgang wird es genauso erklärt, nicht als Löschung.
    const again = await a.sync.push(toB);
    const repeat = again.results.find((r) => r.id === mine.id);
    assert.equal(repeat.status, 'skipped');
    assert.match(repeat.detail, /anderen ID/);
  });
});

test('eine Kante ohne ihre Endpunkte wird gemeldet statt angelegt', async () => {
  await withPair(async ({ a, b, toB }) => {
    const agent = a.store.create('agent', { name: 'Nicht übertragen' });
    const note = a.store.create('note', { title: 'Notiz' });
    const edge = a.store.edges.add({ from: agent.id, to: note.id, kind: 'uses' });

    const pushed = await a.sync.push(toB);
    const entry = pushed.results.find((r) => r.id === edge.id);
    assert.equal(entry.status, 'skipped');
    assert.equal(entry.reason, 'endpoint-missing');
    assert.match(entry.detail, new RegExp(agent.id));
    assert.equal(b.store.get(edge.id), null);
    assert.equal(b.store.get(agent.id), null, 'Agenten werden bewusst nicht übertragen');
  });
});

test('syncAll läuft über alle Partner und meldet jeden einzeln', async () => {
  const a = await makeDevice('a');
  const b = await makeDevice('b');
  try {
    const good = await link(a, b);
    const bad = a.sync.createPeer({ name: 'aus', url: 'http://127.0.0.1:1', token: 'x' }).id;
    a.store.create('note', { title: 'verteilt sich' });

    const summary = await a.sync.syncAll();
    assert.equal(summary.peers.length, 2);
    assert.equal(summary.ok, false, 'ein unerreichbarer Partner muss als Fehler gemeldet werden');
    const ok = summary.peers.find((p) => p.peerId === good);
    assert.equal(ok.error, null);
    assert.equal(ok.push.applied, 1);
    const broken = summary.peers.find((p) => p.peerId === bad);
    assert.ok(broken.error, 'der unerreichbare Partner braucht eine Begründung');
    assert.equal(b.store.count('note'), 1, 'der erreichbare Partner wurde trotzdem bedient');
  } finally {
    await b.close();
    await a.close();
  }
});

test('eine neue Adresse oder ein neues Token setzt den bekannten Stand zurück', async () => {
  await withPair(async ({ a, b, toB }) => {
    a.store.create('note', { title: 'irgendwas' });
    await a.sync.push(toB);
    assert.ok(a.sync.getPeer(toB).knownRecords > 0);

    const changed = a.sync.updatePeer(toB, { url: 'http://192.168.77.77:7777' });
    assert.equal(changed.knownRecords, 0, 'ein anderer Partner hat keinen gemeinsamen Stand mit uns');
    assert.equal(changed.watermark, 0);
    assert.equal(a.sync.getPeer(toB).remoteDeviceId, null);
  });
});

test('HTTP: die Oberfläche verwaltet Partner und Konflikte über das eigene Gerät', async () => {
  const ui = await makeDevice('ui', {}, { sharing: false });
  const partner = await makeDevice('partner');
  try {
    const created = await callJson(ui, 'POST', '/api/peers', { name: 'Tablet', url: partner.url, token: partner.token });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.peer.name, 'Tablet');
    assert.equal(created.json.peer.hasToken, true);
    assert.equal(created.json.peer.token, undefined, 'das Token des Partners darf die Schnittstelle nie verlassen');
    const peerId = created.json.peer.id;

    const listed = await callJson(ui, 'GET', '/api/peers');
    assert.equal(listed.json.total, 1);
    assert.equal(listed.json.deviceId, ui.sync.deviceId);

    const probe = await callJson(ui, 'POST', `/api/peers/${peerId}/test`);
    assert.equal(probe.status, 200, probe.text);
    assert.equal(probe.json.reachable, true);
    assert.equal(probe.json.deviceId, partner.sync.deviceId);

    // Einen echten Konflikt erzeugen und über die Schnittstelle auflösen.
    const note = ui.store.create('note', { title: 'UI-Original' });
    await ui.sync.push(peerId);
    await partner.store.update(note.id, { title: 'Partner ändert' });
    ui.store.update(note.id, { title: 'UI ändert' });
    await ui.sync.push(peerId);

    const conflicts = await callJson(ui, 'GET', '/api/conflicts');
    assert.equal(conflicts.json.total, 1);
    const conflictId = conflicts.json.items[0].id;

    const bad = await callJson(ui, 'POST', `/api/conflicts/${conflictId}`, {});
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /resolution/);

    const resolved = await callJson(ui, 'POST', `/api/conflicts/${conflictId}`, { resolution: 'remote' });
    assert.equal(resolved.status, 200, resolved.text);
    assert.equal(titleOf(ui, note.id), 'Partner ändert');
    assert.equal((await callJson(ui, 'GET', '/api/conflicts')).json.total, 0);

    const removed = await callJson(ui, 'DELETE', `/api/peers/${peerId}`);
    assert.equal(removed.status, 200);
    assert.equal((await callJson(ui, 'GET', '/api/peers')).json.total, 0);
  } finally {
    await partner.close();
    await ui.close();
  }
});

/** Plain HTTP call against a device's own interface routes. */
function callJson(device, method, urlPath, body) {
  const url = new URL(urlPath, device.url);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'x-neural-os': '1',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not every answer is JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('HTTP: ein Abgleich lässt sich über die Schnittstelle anstoßen', async () => {
  const ui = await makeDevice('ui', {}, { sharing: false });
  const partner = await makeDevice('partner');
  try {
    const created = await callJson(ui, 'POST', '/api/peers', { name: 'Tablet', url: partner.url, token: partner.token });
    const peerId = created.json.peer.id;
    ui.store.create('note', { title: 'über die Schnittstelle' });
    partner.store.create('note', { title: 'vom Partner' });

    const run = await callJson(ui, 'POST', `/api/peers/${peerId}/sync`, { direction: 'both' });
    assert.equal(run.status, 200, run.text);
    assert.equal(run.json.pull.applied, 1);
    assert.equal(run.json.push.applied, 1);
    assert.equal(run.json.peer.lastError, null);
    assert.ok(run.json.peer.lastSyncAt);
    assert.equal(ui.store.count('note'), 2);
    assert.equal(partner.store.count('note'), 2);

    const bad = await callJson(ui, 'POST', `/api/peers/${peerId}/sync`, { direction: 'seitwärts' });
    assert.equal(bad.status, 400);
  } finally {
    await partner.close();
    await ui.close();
  }
});

test('summary sagt ehrlich, ob ein Partner dieses Gerät überhaupt erreichen kann', async () => {
  const open = await makeDevice('offen');
  const closed = await makeDevice('zu', {}, { sharing: false });
  try {
    open.sync.setAuth(open.auth);
    const ready = open.sync.summary();
    assert.equal(ready.incoming.ok, true);
    assert.equal(ready.deviceId, open.sync.deviceId);
    assert.equal(ready.gate, true);

    closed.sync.setAuth(closed.auth);
    const blocked = closed.sync.summary().incoming;
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /Freigabe/);

    // Freigabe an, aber das einzige taugliche Token ist widerrufen.
    closed.config.security.sharing.enabled = true;
    assert.equal(closed.sync.summary().incoming.ok, true);
    for (const token of closed.auth.listTokens()) {
      if (token.permissions && token.permissions.sync === true) closed.auth.revokeToken(token.id);
    }
    const noToken = closed.sync.summary().incoming;
    assert.equal(noToken.ok, false);
    assert.match(noToken.reason, /Recht "sync"/);
  } finally {
    await closed.close();
    await open.close();
  }
});

test('eine Verknüpfung, die beim Partner woanders hinzeigt, wird nicht halb übernommen', async () => {
  const dev = await makeDevice('kante');
  try {
    const one = dev.store.create('note', { title: 'Eins' });
    const two = dev.store.create('note', { title: 'Zwei' });
    const three = dev.store.create('note', { title: 'Drei' });
    const edge = dev.store.edges.add({ from: one.id, to: two.id, kind: 'links-to' });

    const moved = { ...edge, data: { ...edge.data, to: three.id }, rev: edge.rev + 1 };
    const planned = merge.plan([edge], [moved], { bases: { [edge.id]: { h: merge.fingerprint(edge) } } });
    assert.equal(planned.apply.length, 1);

    const out = dev.store.transaction(() => dev.sync.__internals.applyPlan(planned, { peerId: null }));
    assert.equal(out.results[0].status, 'skipped');
    assert.equal(out.results[0].reason, 'edge-identity-changed');
    assert.equal(dev.store.get(edge.id).data.to, two.id, 'die Verknüpfung darf nicht teilweise geändert werden');
  } finally {
    await dev.close();
  }
});

test('ein beim Partner entferntes Zusatzfeld überlebt die Übernahme und wird gemeldet', async () => {
  const dev = await makeDevice('drift');
  try {
    // schema.validate lässt unbekannte Felder bewusst stehen (Vorwärts-
    // kompatibilität). store.update führt einen Patch zusammen, es ersetzt die
    // Nutzdaten nicht -- ein Feld, das der Partner GELÖSCHT hat, bleibt darum
    // hier erhalten. Das ist kein Datenverlust, aber es ist eine Abweichung,
    // und sie wird benannt statt verschwiegen.
    const local = dev.store.create('note', { title: 'A', zusatz: 'bleibt liegen' });
    const remote = {
      ...local,
      rev: local.rev + 1,
      data: { title: 'B', body: '', tags: [], pinned: false, source: 'user' },
    };
    const planned = merge.plan([local], [remote], { bases: { [local.id]: { h: merge.fingerprint(local) } } });
    const out = dev.store.transaction(() => dev.sync.__internals.applyPlan(planned, { peerId: null }));

    assert.equal(out.results[0].status, 'applied');
    assert.ok(out.results[0].drift, 'die Abweichung muss im Protokoll stehen');
    const after = dev.store.get(local.id);
    assert.equal(after.data.title, 'B', 'der Inhalt des Partners wurde übernommen');
    assert.equal(after.data.zusatz, 'bleibt liegen', 'das Zusatzfeld bleibt -- bekannte Grenze, kein Verlust');
  } finally {
    await dev.close();
  }
});

test('ein Datei-Eintrag ohne seinen Inhalt wird nicht angelegt, sondern begründet', async () => {
  await withPair(async ({ a, b, toB }) => {
    const blob = a.store.files.put(Buffer.from('Inhalt liegt nur auf A'), { name: 'a.txt', mime: 'text/plain' });
    const withBlob = a.store.create('file', { name: 'a.txt', hash: blob.hash, mime: 'text/plain', size: blob.size });
    const linked = a.store.create('file', { name: 'extern.txt', externalPath: '/tmp/extern.txt' });

    const pushed = await a.sync.push(toB);
    const refused = pushed.results.find((r) => r.id === withBlob.id);
    assert.equal(refused.status, 'skipped');
    assert.equal(refused.reason, 'blob-missing');
    assert.match(refused.detail, /Dateiinhalte werden noch nicht/);
    assert.equal(b.store.get(withBlob.id), null, 'kein Eintrag, der ins Leere zeigt');

    // Eine verknüpfte Datei ohne eigenen Inhalt hat dieses Problem nicht.
    assert.equal(b.store.get(linked.id).data.externalPath, '/tmp/extern.txt');

    // Auch beim zweiten Durchgang bleibt die Begründung dieselbe.
    const again = await a.sync.push(toB);
    const repeat = again.results.find((r) => r.id === withBlob.id);
    assert.equal(repeat.status, 'skipped');
    assert.match(repeat.detail, /Dateiinhalte werden noch nicht/);
  });
});

/** The peer record `b` holds for `a`. */
async function peerIdOf(from, to) {
  const found = from.sync.listPeers().find((p) => p.url === to.url);
  assert.ok(found, `${from.label} kennt ${to.label} nicht`);
  return found.id;
}

module.exports = { name: 'sync', tests: drain() };
