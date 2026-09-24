'use strict';

/**
 * Kalender, Notizen, Projekte: die Routen aus src/http/api/events.js.
 *
 * Echter Speicher in einem Wegwerf-Verzeichnis, echter Server auf einem
 * freien Port. Geprueft wird, was im Kalender schiefgehen kann und dann an
 * einer Stelle auftaucht, an der es niemand sucht:
 *
 * 1. Ein Termin, den es nicht gibt (31. Februar, Ende vor Beginn), wird
 *    abgewiesen -- mit einem Satz, nicht still verschoben.
 * 2. Der Zeitraum findet auch Termine, die ueber seine Grenze reichen, und
 *    nicht den, der um Mitternacht endet.
 * 3. Die Herkunft ("aus dem Chat …") laesst sich nicht nachtraeglich
 *    umschreiben, und "automatisch" gibt es nur mit einem Chat.
 * 4. Der Ereignisstrom unter GET /api/events laeuft weiter -- die neue
 *    Familie darf ihn nicht verdecken.
 * 5. Notizen tragen ihre Herkunft, Projekte sammeln ein, was zu ihnen gehoert,
 *    und das zuletzt geaenderte steht oben.
 */

const assert = require('node:assert/strict');
const http = require('node:http');

const { test, tempHome } = require('./harness');
const { openStore } = require('../src/store/engine');
const { Bus } = require('../src/kernel/bus');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');
const events = require('../src/http/api/events');

const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

function request(base, method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        ...(opts.headers || {}),
      },
    }, (res) => {
      if (opts.firstChunk) {
        // Ein Ereignisstrom endet nie von selbst: die erste Lieferung genuegt.
        res.once('data', (chunk) => {
          resolve({ status: res.statusCode, headers: res.headers, text: chunk.toString('utf8') });
          req.destroy();
        });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* nicht jede Antwort ist JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', (err) => (opts.firstChunk ? null : reject(err)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const { createServer } = require('../src/http/server');
  const { home, cleanup } = tempHome('nos-termine');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const server = await createServer({
    version: 'test', config, paths, store, bus, logger: silentLogger, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  try {
    return await fn({ store, base, bus });
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    cleanup();
  }
}

/* ------------------------------------------------------------ Zeitangaben */

test('parseWhen liest Tag, Uhrzeit vor Ort und Zeitpunkt mit Zone -- und nichts Erfundenes', () => {
  const tag = events.parseWhen('2026-09-24');
  assert.equal(tag.kind, 'date');
  assert.equal(tag.day, '2026-09-24');
  const ort = events.parseWhen('2026-09-24T10:00');
  assert.equal(ort.kind, 'local');
  assert.equal(ort.ms, new Date(2026, 8, 24, 10, 0).getTime(), 'Uhrzeit ohne Zone ist Ortszeit');
  const zone = events.parseWhen('2026-09-24T08:00:00Z');
  assert.equal(zone.kind, 'zoned');
  assert.equal(zone.ms, Date.parse('2026-09-24T08:00:00Z'));
  for (const kaputt of ['2026-02-30', '2026-13-01', '2026-09-24T24:00', '2026-09-24T10:60', 'morgen', '', null, 20260924]) {
    assert.equal(events.parseWhen(kaputt), null, `„${kaputt}“ ist kein Zeitpunkt`);
  }
});

test('spanOf: ein Termin bis Mitternacht belegt den Folgetag nicht, ein ganztaegiges Ende zaehlt mit', () => {
  assert.deepEqual(
    (({ firstDay, lastDay }) => ({ firstDay, lastDay }))(events.spanOf({ start: '2026-09-24T22:00', end: '2026-09-25T00:00' })),
    { firstDay: '2026-09-24', lastDay: '2026-09-24' },
  );
  assert.equal(events.spanOf({ start: '2026-09-24T22:00', end: '2026-09-25T01:00' }).lastDay, '2026-09-25');
  assert.equal(events.spanOf({ start: '2026-09-03', end: '2026-09-05', allDay: true }).lastDay, '2026-09-05',
    '„vom 3. bis 5.“ sind drei Tage');
});

/* ---------------------------------------------------------------- Termine */

test('POST /api/events legt einen Termin an, GET /api/events/zeitraum findet ihn', async () => {
  await withServer(async ({ base, store }) => {
    const res = await request(base, 'POST', '/api/events', {
      title: '  Zahnarzt   Dr. Weber ', start: '2026-09-24T10:00', end: '2026-09-24T10:45', location: 'Praxis am Markt',
    });
    assert.equal(res.status, 200, res.text);
    const rec = res.json.record;
    assert.equal(rec.type, 'event');
    assert.equal(rec.data.title, 'Zahnarzt Dr. Weber', 'Leerraum wird bereinigt');
    assert.equal(rec.data.allDay, false);
    assert.equal(rec.data.source, 'user', 'von Hand angelegt heisst: vom Nutzer');
    assert.ok(store.get(rec.id), 'steht wirklich im Tresor');

    const liste = await request(base, 'GET', '/api/events/zeitraum?from=2026-09-01&to=2026-09-30');
    assert.equal(liste.status, 200, liste.text);
    assert.deepEqual(liste.json.items.map((r) => r.id), [rec.id]);
    assert.equal(liste.json.from, '2026-09-01');

    const daneben = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-01&to=2026-10-31');
    assert.equal(daneben.json.total, 0);
  });
});

test('Ein Tag ohne Uhrzeit ist ganztaegig; ganztaegig mit Uhrzeit zaehlt nur den Tag', async () => {
  await withServer(async ({ base }) => {
    const a = await request(base, 'POST', '/api/events', { title: 'Eltern besuchen', start: '2026-09-27' });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.record.data.allDay, true);
    const b = await request(base, 'POST', '/api/events', { title: 'Urlaub', start: '2026-10-03T09:00', end: '2026-10-05T18:00', allDay: true });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.record.data.start, '2026-10-03');
    assert.equal(b.json.record.data.end, '2026-10-05');
    const c = await request(base, 'POST', '/api/events', { title: 'Mit Uhrzeit', start: '2026-10-03', allDay: false });
    assert.equal(c.status, 400, 'ausdruecklich „mit Uhrzeit“, aber keine geschickt: nicht raten');
  });
});

test('Unmoegliches wird mit einem Satz abgewiesen und nicht gespeichert', async () => {
  await withServer(async ({ base, store }) => {
    const faelle = [
      [{ title: 'Kein Tag', start: '2026-02-30T10:00' }, /Beginn/],
      [{ title: '', start: '2026-09-24T10:00' }, /Titel/],
      [{ title: 'Rückwärts', start: '2026-09-24T10:00', end: '2026-09-24T09:00' }, /Ende liegt vor dem Beginn/],
      [{ title: 'Ende ohne Uhrzeit', start: '2026-09-24T10:00', end: '2026-09-25' }, /Uhrzeit/],
      [{ title: 'Fremdes Projekt', start: '2026-09-24', projectId: 'project_00000000000000000000' }, /Projekt/],
      [{ title: 'Auto ohne Chat', start: '2026-09-24', source: 'auto' }, /chatId/],
      [{ title: 'Falsche Quelle', start: '2026-09-24', source: 'ki' }, /source/],
    ];
    for (const [body, muster] of faelle) {
      const res = await request(base, 'POST', '/api/events', body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} → HTTP ${res.status}`);
      assert.match(res.json.error.message, muster);
    }
    assert.equal(store.count('event'), 0, 'nichts davon steht im Tresor');
  });
});

test('Ein automatischer Termin nennt seinen Chat, und die Herkunft laesst sich nicht umschreiben', async () => {
  await withServer(async ({ base, store }) => {
    const chat = store.create('chat', { title: 'Produktlaunch' });
    const res = await request(base, 'POST', '/api/events', {
      data: { title: 'Produkt-Review', start: '2026-09-23T09:00', end: '2026-09-23T10:00', chatId: chat.id, source: 'auto' },
    });
    assert.equal(res.status, 200, res.text);
    const id = res.json.record.id;

    const eins = await request(base, 'GET', `/api/events/${id}`);
    assert.equal(eins.status, 200);
    assert.deepEqual(eins.json.chat, { id: chat.id, title: 'Produktlaunch', deleted: false });

    const umschreiben = await request(base, 'PATCH', `/api/events/${id}`, { source: 'user' });
    assert.equal(umschreiben.status, 400);
    assert.match(umschreiben.json.error.message, /woher/);

    const verschieben = await request(base, 'PATCH', `/api/events/${id}`, { start: '2026-09-23T11:00', end: '2026-09-23T12:00' });
    assert.equal(verschieben.status, 200, verschieben.text);
    assert.equal(verschieben.json.record.data.source, 'auto', 'verschoben bleibt er, woher er kam');
    assert.equal(store.get(id).data.start, '2026-09-23T11:00');

    // Auch ein geloeschter Chat bleibt beim Namen genannt.
    store.remove(chat.id);
    const danach = await request(base, 'GET', '/api/events/zeitraum?from=2026-09-23&to=2026-09-23');
    assert.deepEqual(danach.json.chats[chat.id], { id: chat.id, title: 'Produktlaunch', deleted: true });
  });
});

test('Der Zeitraum findet Termine ueber seine Grenzen und sortiert nach Beginn', async () => {
  await withServer(async ({ base, store }) => {
    const mk = (title, start, end, allDay = false) => store.create('event', { title, start, end: end || null, allDay });
    const ueberGrenze = mk('Messe', '2026-09-29', '2026-10-02', true);
    const spaet = mk('Spät', '2026-10-01T18:00');
    const frueh = mk('Früh', '2026-10-01T07:30');
    mk('Bis Mitternacht', '2026-09-30T22:00', '2026-10-01T00:00');
    mk('Anderer Monat', '2026-11-01T10:00');
    const res = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-01&to=2026-10-31');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.items.map((r) => r.data.title), ['Messe', 'Früh', 'Spät'],
      `gefunden: ${res.json.items.map((r) => r.data.title).join(', ')}`);
    assert.deepEqual(res.json.items.map((r) => r.id), [ueberGrenze.id, frueh.id, spaet.id]);
  });
});

test('Zeitraum: kaputte Grenzen werden abgewiesen, ohne Angabe gilt der laufende Monat', async () => {
  await withServer(async ({ base }) => {
    for (const q of ['from=2026-09-31', 'from=gestern', 'from=2026-10-01&to=2026-09-01', 'from=2020-01-01&to=2026-01-01']) {
      const res = await request(base, 'GET', `/api/events/zeitraum?${q}`);
      assert.equal(res.status, 400, `${q} → HTTP ${res.status}`);
    }
    const jetzt = await request(base, 'GET', '/api/events/zeitraum');
    assert.equal(jetzt.status, 200);
    const heute = new Date();
    assert.equal(jetzt.json.from, `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}-01`);
  });
});

test('Loeschen ist weich und umkehrbar; ein geloeschter Termin erscheint nicht mehr', async () => {
  await withServer(async ({ base, store }) => {
    const ev = store.create('event', { title: 'Weg damit', start: '2026-09-24T10:00' });
    const del = await request(base, 'DELETE', `/api/events/${ev.id}`);
    assert.equal(del.status, 200, del.text);
    assert.equal(store.get(ev.id), null);
    const liste = await request(base, 'GET', '/api/events/zeitraum?from=2026-09-24&to=2026-09-24');
    assert.equal(liste.json.total, 0);
    assert.equal((await request(base, 'GET', `/api/events/${ev.id}`)).status, 404);
    assert.equal((await request(base, 'DELETE', `/api/events/${ev.id}`)).status, 404);
    const zurueck = await request(base, 'POST', `/api/records/${ev.id}/restore`);
    assert.equal(zurueck.status, 200, zurueck.text);
    assert.ok(store.get(ev.id), 'wiederhergestellt');
  });
});

test('Eine andere Satzart ist unter /api/events/:id kein Termin', async () => {
  await withServer(async ({ base, store }) => {
    const note = store.create('note', { title: 'Keine Verabredung' });
    assert.equal((await request(base, 'GET', `/api/events/${note.id}`)).status, 404);
    assert.equal((await request(base, 'PATCH', `/api/events/${note.id}`, { title: 'x' })).status, 404);
    assert.equal((await request(base, 'DELETE', `/api/events/${note.id}`)).status, 404);
    assert.ok(store.get(note.id), 'die Notiz bleibt unberuehrt');
  });
});

test('Der Ereignisstrom unter GET /api/events laeuft weiter', async () => {
  await withServer(async ({ base }) => {
    const res = await request(base, 'GET', '/api/events', undefined, { firstChunk: true, headers: { accept: 'text/event-stream' } });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
  });
});

test('Jede Aenderung an einem Termin geht als record.*-Ereignis auf den Bus', async () => {
  await withServer(async ({ base, bus }) => {
    const gesehen = [];
    bus.on('record.created', (e) => gesehen.push(`created:${(e.payload || e).type}`));
    bus.on('record.updated', (e) => gesehen.push(`updated:${(e.payload || e).type}`));
    bus.on('record.deleted', (e) => gesehen.push(`deleted:${(e.payload || e).type}`));
    const a = await request(base, 'POST', '/api/events', { title: 'Live', start: '2026-09-24T10:00' });
    await request(base, 'PATCH', `/api/events/${a.json.record.id}`, { title: 'Live verschoben' });
    await request(base, 'DELETE', `/api/events/${a.json.record.id}`);
    assert.deepEqual(gesehen, ['created:event', 'updated:event', 'deleted:event'],
      'daran haengen die Kachel „Kalender“ und die Ansicht');
  });
});

/* ---------------------------------------------------------------- Notizen */

test('GET /api/notizen: angeheftet oben, dann das Neueste; jede Notiz mit ihrer Herkunft', async () => {
  await withServer(async ({ base, store }) => {
    const chat = store.create('chat', { title: 'Produktlaunch' });
    const hand = store.create('note', { title: 'Von mir' });
    const auto = store.create('note', { title: 'Nächste Schritte', body: 'Aufgaben geprüft.', source: 'auto', chatId: chat.id });
    const alt = store.create('note', { title: 'Angeheftet', pinned: true });
    await new Promise((r) => setTimeout(r, 5));
    store.update(hand.id, { body: 'heute ergänzt' });

    const res = await request(base, 'GET', '/api/notizen');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.items.map((n) => n.id), [alt.id, hand.id, auto.id]);
    const herkunft = Object.fromEntries(res.json.items.map((n) => [n.id, n.herkunft]));
    assert.deepEqual(herkunft[auto.id], { art: 'chat', chatId: chat.id, chatTitel: 'Produktlaunch', chatGeloescht: false });
    assert.equal(herkunft[hand.id].art, 'hand');
    assert.deepEqual(res.json.zaehler, { alle: 3, automatisch: 1, angeheftet: 1 });

    const nurAuto = await request(base, 'GET', '/api/notizen?quelle=auto&sort=neu&limit=1');
    assert.deepEqual(nurAuto.json.items.map((n) => n.id), [auto.id], 'die neueste automatische -- fuer die Kachel');
    assert.equal((await request(base, 'GET', '/api/notizen?quelle=irgendwas')).status, 400);
  });
});

/* --------------------------------------------------------------- Projekte */

test('GET /api/projekte sammelt Chats, Termine, Notizen und Aufgaben ein; das zuletzt Geaenderte oben', async () => {
  await withServer(async ({ base, store }) => {
    const launch = store.create('project', { name: 'Produktlaunch' });
    const garten = store.create('project', { name: 'Garten' });
    const chat = store.create('chat', { title: 'Launch besprechen' });
    const nebenChat = store.create('chat', { title: 'Nebenbei' });
    store.create('task', { title: 'Folien bauen', projectId: launch.id });
    store.create('task', { title: 'Presse', projectId: launch.id, status: 'done' });
    // Weg 3: die Notiz gehoert per Kante zum Projekt, ihr Chat damit auch.
    const notiz = store.create('note', { title: 'Zusammenfassung', source: 'auto', chatId: chat.id });
    store.edges.add({ from: notiz.id, to: launch.id, kind: 'belongs-to', source: 'agent', reason: 'aus dem Chat' });
    // Weg 1: projectId am Termin.
    const termin = store.create('event', { title: 'Review', start: '2099-01-10T09:00', projectId: launch.id });
    store.create('event', { title: 'Vergangen', start: '2000-01-10T09:00', projectId: launch.id });
    // Weg 1 auch am Chat. Die Pause davor ist noetig: ohne sie entsteht der Chat oft in derselben
    // Millisekunde wie der Termin von "Produktlaunch", und die Reihenfolge waere ein Muenzwurf.
    await new Promise((r) => setTimeout(r, 5));
    store.create('chat', { title: 'Beete', projectId: garten.id });
    await new Promise((r) => setTimeout(r, 5));
    store.update(nebenChat.id, { title: 'Nebenbei, umbenannt' }); // gehoert zu nichts: darf nichts verschieben

    const res = await request(base, 'GET', '/api/projekte');
    assert.equal(res.status, 200, res.text);
    const [erstes, zweites] = res.json.items;
    assert.equal(erstes.id, garten.id, 'Garten wurde zuletzt beruehrt (sein Chat entstand nach allem anderen)');
    assert.equal(zweites.id, launch.id);
    assert.deepEqual(zweites.zaehler, {
      chats: 1, termine: 2, termineAnstehend: 1, notizen: 1, aufgaben: 2, aufgabenOffen: 1, aufgabenErledigt: 1,
    });
    assert.equal(zweites.naechsterTermin.id, termin.id);

    const eins = await request(base, 'GET', `/api/projekte/${launch.id}`);
    assert.equal(eins.status, 200, eins.text);
    const p = eins.json.projekt;
    assert.deepEqual(p.chats.map((c) => c.id), [chat.id]);
    assert.deepEqual(p.aufgaben.map((t) => t.title), ['Folien bauen', 'Presse'], 'Offenes vor Erledigtem');
    assert.deepEqual(p.termine.map((t) => t.title), ['Vergangen', 'Review']);
    assert.equal(p.notizen[0].id, notiz.id);

    assert.equal((await request(base, 'GET', `/api/projekte/${chat.id}`)).status, 404);
  });
});

/* ------------------------------------------------ Serien (Vertrag A-E) */

/**
 * Die ganze Anwendung (mit Aenderungsverlauf), weil "rueckgaengig" hier
 * mitgeprueft wird -- der kleine Server oben hat keinen Verlauf.
 */
async function withApp(fn) {
  const { createApp, seedIfEmpty } = require('../src/app');
  const { home, cleanup } = tempHome('nos-serien');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    return await fn({ app, store: app.store, base });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
}

const TRAINING = {
  title: 'Training', start: '2026-09-29T18:00', end: '2026-09-29T19:30', location: 'Halle 3',
  recurrence: { freq: 'weekly', until: '2026-12-24' },
};

test('Serie: der Zeitraum Okt-Dez liefert jeden Dienstag bis Weihnachten -- je Vorkommen, mit der id der Serie', async () => {
  await withServer(async ({ base }) => {
    const res = await request(base, 'POST', '/api/events', TRAINING);
    assert.equal(res.status, 200, res.text);
    const serie = res.json.record;
    assert.deepEqual(serie.data.recurrence, { freq: 'weekly', interval: 1, byDay: [], until: '2026-12-24', count: null });
    assert.deepEqual(serie.data.exdates, []);
    assert.equal(serie.data.reminder, null);
    const einzel = await request(base, 'POST', '/api/events', { title: 'Elternabend', start: '2026-10-06T19:00', end: '2026-10-06T21:00' });

    const liste = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-01&to=2026-12-31');
    assert.equal(liste.status, 200, liste.text);
    const vorkommen = liste.json.items.filter((x) => x.recurring);
    assert.deepEqual(vorkommen.map((x) => x.occurrence), [
      '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10',
      '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22',
    ]);
    assert.ok(vorkommen.every((x) => x.id === serie.id), 'dieselbe id wie die Serie');
    const okt27 = vorkommen.find((x) => x.occurrence === '2026-10-27');
    assert.equal(okt27.data.start, '2026-10-27T18:00', 'nach der Zeitumstellung weiter 18:00 Wandzeit');
    assert.equal(okt27.data.end, '2026-10-27T19:30');
    assert.equal(okt27.data.occurrence, '2026-10-27', 'auch in data, damit keine Ansicht falsch sucht');
    assert.equal(okt27.data.recurring, true);
    assert.deepEqual(okt27.serie, { start: '2026-09-29T18:00', end: '2026-09-29T19:30' });
    const e = liste.json.items.find((x) => x.id === einzel.json.record.id);
    assert.equal(e.occurrence, null);
    assert.equal(e.recurring, false);
    // Sortiert nach Beginn: am 6.10. erst das Training (18:00), dann der Elternabend (19:00).
    assert.deepEqual(liste.json.items.slice(0, 2).map((x) => x.data.title), ['Training', 'Elternabend']);
    assert.equal(liste.json.total, 13);
  });
});

test('Serie am 27.10. auch in Berliner Zeit: die Sortierung nach Beginn ueberlebt die Zeitumstellung', async () => {
  const vorher = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  try {
    await withServer(async ({ base }) => {
      await request(base, 'POST', '/api/events', TRAINING);
      await request(base, 'POST', '/api/events', { title: 'Vorher', start: '2026-10-27T17:30', end: '2026-10-27T17:45' });
      const tag = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-27&to=2026-10-27');
      assert.deepEqual(tag.json.items.map((x) => [x.data.title, x.data.start]), [['Vorher', '2026-10-27T17:30'], ['Training', '2026-10-27T18:00']]);
      assert.equal(new Date(2026, 9, 27, 18, 0).getHours(), 18);
    });
  } finally {
    if (vorher === undefined) delete process.env.TZ;
    else process.env.TZ = vorher;
  }
});

test('Serien werden streng geprueft; Zeitpunkte mit Zone werden keine Serie', async () => {
  await withServer(async ({ base, store }) => {
    const faelle = [
      [{ ...TRAINING, recurrence: { freq: 'fortnightly' } }, /freq/],
      [{ ...TRAINING, recurrence: { freq: 'weekly', until: '2026-09-01' } }, /bevor sie beginnt/],
      [{ ...TRAINING, recurrence: { freq: 'weekly', until: '2026-12-24', count: 5 } }, /nicht beides/],
      [{ ...TRAINING, recurrence: { freq: 'monthly', byDay: ['TU'] } }, /wöchentlich/],
      [{ ...TRAINING, recurrence: 'jeden Dienstag' }, /Objekt/],
      [{ ...TRAINING, start: '2026-09-29T16:00:00Z', end: null }, /Zone/],
      [{ ...TRAINING, reminder: 7 }, /reminder/],
      [{ ...TRAINING, exdates: ['2026-02-30'] }, /exdates/],
    ];
    for (const [body, muster] of faelle) {
      const res = await request(base, 'POST', '/api/events', body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} → HTTP ${res.status}`);
      assert.match(res.json.error.message, muster);
    }
    assert.equal(store.count('event'), 0);
  });
});

test('Ein Vorkommen verschieben (?nur): Serie bekommt den Tag als Ausnahme, ein Einzeltermin entsteht; rueckgaengig stellt beides her', async () => {
  await withApp(async ({ app, store, base }) => {
    const serie = (await request(base, 'POST', '/api/events', TRAINING)).json.record;
    const res = await request(base, 'PATCH', `/api/events/${serie.id}?nur=2026-10-27`, { start: '2026-10-28T19:00', end: '2026-10-28T20:30' });
    assert.equal(res.status, 200, res.text);
    const neu = res.json.record;
    assert.notEqual(neu.id, serie.id, 'die Antwort ist der NEUE Einzeltermin');
    assert.equal(neu.data.title, 'Training');
    assert.equal(neu.data.location, 'Halle 3', 'erbt die Felder der Serie');
    assert.equal(neu.data.start, '2026-10-28T19:00');
    assert.equal(neu.data.recurrence, null);
    assert.deepEqual(neu.data.ausSerie, { id: serie.id, tag: '2026-10-27' });
    assert.deepEqual(store.get(serie.id).data.exdates, ['2026-10-27']);
    assert.deepEqual(res.json.serie.data.exdates, ['2026-10-27']);

    const woche = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-26&to=2026-11-01');
    assert.deepEqual(woche.json.items.map((x) => [x.id, x.data.start]), [[neu.id, '2026-10-28T19:00']],
      'am 27. kein Training mehr, am 28. der verschobene Termin');

    // Rueckgaengig ueber die Nummer aus der Antwort -- EIN Schritt nimmt beides zurueck.
    assert.ok(res.json.rueckgaengig && Number.isInteger(res.json.rueckgaengig.eintrag), JSON.stringify(res.json.rueckgaengig));
    const undo = await request(base, 'POST', res.json.rueckgaengig.pfad, {});
    assert.equal(undo.status, 200, undo.text);
    assert.equal(undo.json.mitgenommen.length, 1, 'die zweite Hälfte ging mit');
    assert.equal(store.get(neu.id), null, 'der Einzeltermin ist weg');
    assert.deepEqual(store.get(serie.id).data.exdates, [], 'die Ausnahme ist weg');
    const danach = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-26&to=2026-11-01');
    assert.deepEqual(danach.json.items.map((x) => [x.id, x.data.start]), [[serie.id, '2026-10-27T18:00']]);
    assert.ok(app.history);
  });
});

test('Ein Vorkommen auslassen (DELETE ?nur) und die ganze Serie aendern; beides rueckgaengig machbar', async () => {
  await withApp(async ({ app, store, base }) => {
    const serie = (await request(base, 'POST', '/api/events', TRAINING)).json.record;
    const weg = await request(base, 'DELETE', `/api/events/${serie.id}?nur=2026-11-10`);
    assert.equal(weg.status, 200, weg.text);
    assert.equal(weg.json.ausgelassen, '2026-11-10');
    assert.ok(store.get(serie.id), 'die Serie bleibt');
    assert.deepEqual(store.get(serie.id).data.exdates, ['2026-11-10']);
    const nov = await request(base, 'GET', '/api/events/zeitraum?from=2026-11-01&to=2026-11-30');
    assert.deepEqual(nov.json.items.map((x) => x.occurrence), ['2026-11-03', '2026-11-17', '2026-11-24']);
    await app.history.undo(weg.json.rueckgaengig.eintrag);
    assert.deepEqual(store.get(serie.id).data.exdates, []);

    // Ganze Serie: neue Uhrzeit, gilt fuer jedes Vorkommen.
    const alle = await request(base, 'PATCH', `/api/events/${serie.id}`, { start: '2026-09-29T17:00', end: '2026-09-29T18:30' });
    assert.equal(alle.status, 200, alle.text);
    const okt = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-27&to=2026-10-27');
    assert.equal(okt.json.items[0].data.start, '2026-10-27T17:00');

    // Nicht-Vorkommen und Nicht-Serie werden abgewiesen, nichts wird geschrieben.
    const rev = store.get(serie.id).rev;
    const mittwoch = await request(base, 'DELETE', `/api/events/${serie.id}?nur=2026-10-28`);
    assert.equal(mittwoch.status, 404);
    assert.match(mittwoch.json.error.message, /28\.10\.2026 findet „Training“ nicht statt/);
    assert.equal((await request(base, 'PATCH', `/api/events/${serie.id}?nur=2027-01-05`, { title: 'x' })).status, 404, 'nach dem Ende der Serie');
    assert.equal((await request(base, 'PATCH', `/api/events/${serie.id}?nur=gestern`, { title: 'x' })).status, 400);
    const einzel = (await request(base, 'POST', '/api/events', { title: 'Einmal', start: '2026-10-01T10:00' })).json.record;
    assert.equal((await request(base, 'DELETE', `/api/events/${einzel.id}?nur=2026-10-01`)).status, 400, 'kein Vorkommen ohne Serie');
    assert.equal(store.get(serie.id).rev, rev);
    assert.ok(store.get(einzel.id));

    // Ohne ?nur: die ganze Serie weich geloescht.
    const ganz = await request(base, 'DELETE', `/api/events/${serie.id}`);
    assert.equal(ganz.status, 200);
    assert.equal(store.get(serie.id), null);
    assert.equal((await request(base, 'GET', '/api/events/zeitraum?from=2026-10-01&to=2026-12-31')).json.items.filter((x) => x.recurring).length, 0);
  });
});

test('Ein alter Termin ohne die neuen Felder bekommt eine Serie -- und rueckgaengig macht ihn wieder einmalig', async () => {
  await withApp(async ({ app, store, base }) => {
    // So sieht ein Termin von vor dem 23.09.2026 im Tresor aus: ohne
    // recurrence/exdates/reminder. validate() fuellt heute Vorgaben ein;
    // den Altbestand stellt der Test her, indem er die drei Felder fuer
    // einen Augenblick aus dem Schema nimmt.
    const schema = require('../src/store/schema');
    const neu = {};
    for (const k of ['recurrence', 'exdates', 'reminder']) {
      neu[k] = schema.FIELDS.event[k];
      delete schema.FIELDS.event[k];
    }
    let alt;
    try {
      alt = store.create('event', { title: 'Chor', start: '2026-10-01T19:00', allDay: false, source: 'user' });
    } finally {
      Object.assign(schema.FIELDS.event, neu);
    }
    assert.equal('recurrence' in store.get(alt.id).data, false, 'wirklich ein Altbestand');
    const res = await request(base, 'PATCH', `/api/events/${alt.id}`, { recurrence: { freq: 'weekly' } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.record.data.recurrence.freq, 'weekly');
    const r = await app.history.undo(res.json.rueckgaengig.eintrag);
    assert.equal(r.applied.note, undefined, 'kein „Feld hatte vorher keinen Wert“');
    assert.equal(store.get(alt.id).data.recurrence, null, 'wieder ein einzelner Termin');
  });
});

test('Ueberschneidungen: mit Uhrzeit nach Minuten, ganztaegig nur mit ganztaegig, ohne=<id> laesst sich selbst aus', async () => {
  await withServer(async ({ base }) => {
    const training = (await request(base, 'POST', '/api/events', TRAINING)).json.record;
    const eltern = (await request(base, 'POST', '/api/events', { title: 'Elternabend', start: '2026-10-13T19:00', end: '2026-10-13T21:00' })).json.record;
    const ferien = (await request(base, 'POST', '/api/events', { title: 'Herbstferien', start: '2026-10-12', end: '2026-10-23' })).json.record;
    await request(base, 'POST', '/api/events', { title: 'Ohne Ende', start: '2026-10-14T09:00' });
    const u = async (q) => {
      const r = await request(base, 'GET', `/api/events/ueberschneidungen?${q}`);
      assert.equal(r.status, 200, r.text);
      return r.json.items.map((x) => `${x.data.title}${x.occurrence ? `@${x.occurrence}` : ''}`);
    };
    assert.deepEqual(await u('start=2026-10-13T18:30&end=2026-10-13T19:15'), ['Training@2026-10-13', 'Elternabend'],
      'ein Vorkommen der Serie zählt; die Ferien (ganztägig) nicht');
    assert.deepEqual(await u('start=2026-10-13T19:30&end=2026-10-13T20:00'), ['Elternabend'], 'um 19:30 endet das Training');
    assert.deepEqual(await u('start=2026-10-13T21:00&end=2026-10-13T22:00'), [], 'wer um 21 Uhr endet, stößt an, überschneidet nicht');
    assert.deepEqual(await u('start=2026-10-14T09:30'), ['Ohne Ende'], 'ohne Ende zählt eine Stunde');
    assert.deepEqual(await u('start=2026-10-20&end=2026-10-21'), ['Herbstferien'], 'ganztägig nur mit ganztägig');
    assert.deepEqual(await u(`start=2026-10-13T18:30&end=2026-10-13T19:15&ohne=${training.id}`), ['Elternabend']);
    assert.ok(eltern.id && ferien.id);
    assert.equal((await request(base, 'GET', '/api/events/ueberschneidungen')).status, 400);
    assert.equal((await request(base, 'GET', '/api/events/ueberschneidungen?start=morgen')).status, 400);
  });
});

test('Mehr als 2000 Vorkommen in einer Anfrage: ein Satz statt einer Liste, an der der Browser erstickt', async () => {
  await withServer(async ({ base, store }) => {
    for (let i = 0; i < 6; i++) {
      store.create('event', { title: `Täglich ${i}`, start: '2026-01-01T0' + i + ':00', recurrence: { freq: 'daily', interval: 1, byDay: [], until: null, count: null } });
    }
    const zuViel = await request(base, 'GET', '/api/events/zeitraum?from=2026-01-01&to=2027-01-31');
    assert.equal(zuViel.status, 400);
    assert.match(zuViel.json.error.message, /mehr als 2000/);
    const monat = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-01&to=2026-10-31');
    assert.equal(monat.json.total, 6 * 31);
  });
});

test('Projekte nennen bei einer Serie das NAECHSTE Vorkommen', async () => {
  await withServer(async ({ base, store }) => {
    const p = store.create('project', { name: 'Verein' });
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const tag = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    store.create('event', { title: 'Training', start: `${tag}T23:00`, projectId: p.id, recurrence: { freq: 'weekly', interval: 1, byDay: [], until: null, count: null } });
    const res = await request(base, 'GET', '/api/projekte');
    const naechster = res.json.items[0].naechsterTermin;
    assert.ok(naechster, 'die Serie läuft weiter, also gibt es einen nächsten Termin');
    assert.equal(naechster.recurring, true);
    assert.ok(naechster.start.slice(0, 10) >= tag, `${naechster.start} liegt nicht vor dem Beginn`);
    assert.ok(Date.parse(naechster.start) >= Date.now() - 24 * 3600 * 1000, `${naechster.start} ist nicht mehr zwei Wochen alt`);
  });
});

test('Aendert ein PATCH nichts, bietet die Antwort auch kein Rueckgaengig an (sonst naehme es das Anlegen zurueck)', async () => {
  await withApp(async ({ store, base }) => {
    const t = (await request(base, 'POST', '/api/events', { title: 'Zahnarzt', start: '2026-10-02T10:00' })).json;
    assert.ok(t.rueckgaengig, 'das Anlegen selbst ist rückgängig machbar');
    const gleich = await request(base, 'PATCH', `/api/events/${t.record.id}`, { title: 'Zahnarzt' });
    assert.equal(gleich.status, 200, gleich.text);
    assert.equal(gleich.json.rueckgaengig, null, 'nichts geändert, nichts zurückzunehmen');
    const anders = await request(base, 'PATCH', `/api/events/${t.record.id}`, { title: 'Zahnärztin' });
    assert.ok(anders.json.rueckgaengig && anders.json.rueckgaengig.eintrag > t.rueckgaengig.eintrag);
    await request(base, 'POST', anders.json.rueckgaengig.pfad, {});
    assert.equal(store.get(t.record.id).data.title, 'Zahnarzt', 'zurückgenommen wurde die Umbenennung, nicht das Anlegen');
  });
});

test('„Werktags“ an einem Samstag angelegt: der Beginn liegt auf dem Montag, ?nur am Samstag gibt es nicht', async () => {
  await withApp(async ({ base }) => {
    const r = await request(base, 'POST', '/api/events', {
      title: 'Pendeln', start: '2026-09-26T08:00', end: '2026-09-26T08:30',
      recurrence: { freq: 'weekly', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.record.data.start, '2026-09-28T08:00', 'das erste echte Vorkommen');
    assert.equal(r.json.record.data.end, '2026-09-28T08:30', 'das Ende wandert mit');
    const ics = await request(base, 'GET', `/api/events/${r.json.record.id}/ics`);
    assert.match(ics.text, /DTSTART:20260928T080000/, 'das iPad zeigt keinen Samstag, den Neural OS nicht zeigt');
    // Nie ein Vorkommen: bis zum Sonntag davor.
    const nie = await request(base, 'POST', '/api/events', {
      title: 'Nie', start: '2026-09-26T08:00', recurrence: { freq: 'weekly', byDay: ['MO'], until: '2026-09-27' },
    });
    assert.equal(nie.status, 400);
    assert.match(nie.json.error.message, /nie statt/);
  });
});

test('DELETE einer ganzen Serie nimmt die per ?nur geloesten Vorkommen mit; ein Rueckgaengig holt alles zurueck', async () => {
  await withApp(async ({ base }) => {
    const s = (await request(base, 'POST', '/api/events', {
      title: 'Training', start: '2026-10-06T18:00', end: '2026-10-06T19:00', recurrence: { freq: 'weekly' },
    })).json.record;
    await request(base, 'PATCH', `/api/events/${s.id}?nur=2026-10-13`, { title: 'A' });
    await request(base, 'PATCH', `/api/events/${s.id}?nur=2026-11-10`, { start: '2026-11-11T18:00', end: '2026-11-11T19:00' });
    const weg = await request(base, 'DELETE', `/api/events/${s.id}`);
    assert.equal(weg.status, 200, weg.text);
    assert.equal(weg.json.mitgeloescht.length, 2);
    const leer = (await request(base, 'GET', '/api/events/zeitraum?from=2026-09-01&to=2026-12-31')).json.items;
    assert.deepEqual(leer.map((x) => `${x.data.title}@${x.data.start}`), [], 'kein „A“ und kein verlegtes Training bleiben stehen');
    await request(base, 'POST', weg.json.rueckgaengig.pfad, {});
    const zurueck = (await request(base, 'GET', '/api/events/zeitraum?from=2026-10-01&to=2026-11-30')).json.items;
    const namen = zurueck.map((x) => `${x.data.title}@${x.data.start.slice(0, 10)}`);
    assert.ok(namen.includes('A@2026-10-13'));
    assert.ok(namen.includes('Training@2026-11-11'));
    assert.ok(namen.includes('Training@2026-10-20'));
  });
});
