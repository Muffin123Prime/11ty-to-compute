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
