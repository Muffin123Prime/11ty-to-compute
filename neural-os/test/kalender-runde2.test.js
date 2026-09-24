'use strict';

/**
 * Kalender, Nachbesserung Runde 2 (Server): Maengel, die die Pruefer im
 * echten Ablauf gefunden haben. Jeder Test war vor der Aenderung rot.
 *
 * 1. Ein Termin mit einer kaputten Regel (an checkEvent vorbei geschrieben)
 *    legte jede Kalenderanfrage lahm -- interval -1 als Endlosschleife,
 *    byDay 'MO' als 500 bei Zeitraum, Ueberschneidungen und Kalenderdatei.
 * 2. Ein Termin aus einem geloeschten Chat oder Projekt liess sich nicht
 *    mehr verschieben, obwohl Chat und Projekt gar nicht geaendert wurden.
 * 3. Ein leeres `?nur=` wirkte auf die GANZE Serie; DELETE loeschte sie.
 */

const assert = require('node:assert/strict');
const http = require('node:http');

const { test, tempHome } = require('./harness');
const w = require('../src/kalender/wiederholung');

function request(base, method, urlPath, body) {
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
      },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* nicht jede Antwort ist JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath}: keine Antwort nach 5 s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withApp(fn) {
  const { createApp } = require('../src/app');
  const { home, cleanup } = tempHome('nos-kal-r2');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    return await fn({ app, store: app.store, base });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
}

/* ------------------------------------------------ 1. kaputte Regeln */

test('Eine kaputte Regel rechnet nicht endlos: interval -1, 0,5, "2" und byDay als Text ergeben keine Serie', () => {
  const basis = { start: '2026-09-29T18:00', end: '2026-09-29T19:30', exdates: [] };
  for (const recurrence of [
    { freq: 'daily', interval: -1 },
    { freq: 'weekly', interval: -2 },
    { freq: 'daily', interval: 0.5 },
    { freq: 'weekly', interval: '2' },
    { freq: 'weekly', byDay: 'MO' },
    { freq: 'weekly', byDay: ['XX'] },
    { freq: 'monthly', count: -3 },
  ]) {
    const t0 = Date.now();
    const daten = { ...basis, recurrence };
    assert.deepEqual(w.vorkommenImZeitraum(daten, '2026-10-01', '2026-10-31'), [], JSON.stringify(recurrence));
    assert.equal(w.istSerie(daten), false, `${JSON.stringify(recurrence)} ist keine Serie`);
    assert.equal(w.naechstesVorkommen(daten, '2026-10-01'), null);
    assert.equal([...w.erzeugen('2026-09-29', recurrence)].length, 0);
    assert.ok(Date.now() - t0 < 200, 'sofort, nicht nach einer Endlosschleife');
  }
  // Eine gueltige Regel rechnet weiter wie gehabt.
  assert.deepEqual(
    w.vorkommenImZeitraum({ ...basis, recurrence: { freq: 'weekly', interval: 2 } }, '2026-10-01', '2026-10-31'),
    ['2026-10-13', '2026-10-27'],
  );
});

test('PATCH /api/records auf einen Termin prueft wie /api/events -- eine Serie mit interval -1 kommt nicht mehr durch', async () => {
  await withApp(async ({ store, base }) => {
    const ev = (await request(base, 'POST', '/api/events', { title: 'Training', start: '2026-09-29T18:00', end: '2026-09-29T19:30' })).json.record;
    const p = await request(base, 'PATCH', `/api/records/${ev.id}`, { data: { recurrence: { freq: 'weekly', interval: -1 } } });
    assert.equal(p.status, 400, p.text);
    assert.match(p.json.error.message, /interval/);
    assert.equal(store.get(ev.id).data.recurrence, null, 'nichts gespeichert');
    const kaputt = await request(base, 'PATCH', `/api/records/${ev.id}`, { data: { end: 'irgendwann' } });
    assert.equal(kaputt.status, 400, 'ein Ende, das kein Zeitpunkt ist, auch nicht');
    // Ein gueltiger PATCH ueber die allgemeine Route geht weiter.
    const ok = await request(base, 'PATCH', `/api/records/${ev.id}`, { data: { location: 'Halle 5' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(store.get(ev.id).data.location, 'Halle 5');
  });
});

test('Ein Satz mit kaputter Regel (Abgleich, Module) legt den Kalender nicht lahm: er erscheint als Einzeltermin', async () => {
  await withApp(async ({ store, base }) => {
    const ev = (await request(base, 'POST', '/api/events', { title: 'Training', start: '2026-10-06T18:00', end: '2026-10-06T19:30' })).json.record;
    const anderer = (await request(base, 'POST', '/api/events', { title: 'Zahnarzt', start: '2026-10-07T10:00' })).json.record;
    // Am Speicher vorbei, wie es der Abgleich oder ein Modul tun kann.
    store.update(ev.id, { recurrence: { freq: 'daily', interval: -1 } });
    const zeitraum = await request(base, 'GET', '/api/events/zeitraum?from=2026-10-01&to=2026-10-31');
    assert.equal(zeitraum.status, 200, zeitraum.text);
    const training = zeitraum.json.items.filter((x) => x.id === ev.id);
    assert.equal(training.length, 1, 'einmal, am eigenen Tag');
    assert.equal(training[0].recurring, false);
    assert.equal(training[0].data.recurrence, null, 'die Oberflaeche sieht keine Regel, mit der sie nicht rechnen kann');
    assert.ok(zeitraum.json.items.some((x) => x.id === anderer.id), 'die anderen Termine stehen weiter da');

    store.update(ev.id, { recurrence: { freq: 'weekly', byDay: 'MO' } });
    for (const pfad of [
      '/api/events/zeitraum?from=2026-10-01&to=2026-10-31',
      '/api/events/zeitraum?from=2030-01-01&to=2030-01-31',
      '/api/events/ueberschneidungen?start=2026-10-06T18:30&end=2026-10-06T19:00',
      '/api/events/export.ics?from=2026-10-01&to=2026-10-31',
      `/api/events/${ev.id}/ics`,
      `/api/events/${ev.id}`,
    ]) {
      const r = await request(base, 'GET', pfad);
      assert.equal(r.status, 200, `${pfad}: ${r.text.slice(0, 200)}`);
    }
    const blatt = (await request(base, 'GET', `/api/events/${ev.id}`)).json;
    assert.equal(blatt.record.data.recurrence, null);
    assert.equal(blatt.wiederholung, null);
    // Und er laesst sich verschieben, ohne dass erst die Regel repariert werden muss.
    const zug = await request(base, 'PATCH', `/api/events/${ev.id}`, { start: '2026-10-08T18:00', end: '2026-10-08T19:30' });
    assert.equal(zug.status, 200, zug.text);
    assert.equal(store.get(ev.id).data.recurrence, null);
  });
});

/* ------------------------------------------------ 2. geloeschte Herkunft */

test('Ein Termin aus einem geloeschten Chat laesst sich weiter verschieben -- Einzeltermin, ganze Serie, Vorkommen und Claude', async () => {
  await withApp(async ({ app, store, base }) => {
    const { createWerkzeuge } = require('../src/models/werkzeuge');
    const wz = createWerkzeuge({ store, bus: app.bus });
    const chat = store.create('chat', { title: 'Termine' });
    const ctx = { chatId: chat.id };
    const zahnarzt = JSON.parse(wz.ausfuehren({ id: 'a', name: 'termin_anlegen', input: { titel: 'Zahnarzt', start: '2026-10-06T10:00', ende: '2026-10-06T10:45', ganztaegig: false } }, undefined, ctx).toolResult.content);
    const serie = JSON.parse(wz.ausfuehren({ id: 'b', name: 'termin_anlegen', input: { titel: 'Training', start: '2026-09-29T18:00', ende: '2026-09-29T19:30', ganztaegig: false, wiederholung: { rhythmus: 'woechentlich', bis: '2026-12-22' } } }, undefined, ctx).toolResult.content);
    assert.equal((await request(base, 'DELETE', `/api/records/${chat.id}`)).status, 200);

    const p1 = await request(base, 'PATCH', `/api/events/${zahnarzt.id}`, { start: '2026-10-07T10:00', end: '2026-10-07T10:45' });
    assert.equal(p1.status, 200, p1.text);
    assert.equal(p1.json.record.data.chatId, chat.id, 'die Herkunft bleibt wahr');
    const p2 = await request(base, 'PATCH', `/api/events/${serie.id}`, { title: 'Training (Halle 5)' });
    assert.equal(p2.status, 200, p2.text);
    const p3 = await request(base, 'PATCH', `/api/events/${serie.id}?nur=2026-10-13`, { start: '2026-10-14T18:00', end: '2026-10-14T19:30' });
    assert.equal(p3.status, 200, p3.text);
    const claude = wz.ausfuehren({ id: 'c', name: 'termin_aendern', input: { id: zahnarzt.id, start: '2026-10-08T10:00' } }, undefined, {});
    assert.equal(claude.toolResult.is_error, undefined, claude.toolResult.content);
    assert.equal(store.get(zahnarzt.id).data.start, '2026-10-08T10:00');

    // Einen ANDEREN, nicht vorhandenen Chat setzen geht weiterhin nicht.
    const fremd = await request(base, 'POST', '/api/events', { title: 'X', start: '2026-10-09', source: 'auto', chatId: 'chat_gibtsnicht' });
    assert.equal(fremd.status, 400);
    assert.match(fremd.json.error.message, /^Den Chat "chat_gibtsnicht" gibt es nicht\./);
  });
});

test('Ein Termin eines geloeschten Projekts laesst sich verschieben; ein anderes, geloeschtes Projekt setzen nicht', async () => {
  await withApp(async ({ store, base }) => {
    const umzug = store.create('project', { name: 'Umzug' });
    const garten = store.create('project', { name: 'Garten' });
    const ev = (await request(base, 'POST', '/api/events', { title: 'Besichtigung', start: '2026-10-10T10:00', projectId: umzug.id })).json.record;
    await request(base, 'DELETE', `/api/records/${umzug.id}`);
    await request(base, 'DELETE', `/api/records/${garten.id}`);
    const zug = await request(base, 'PATCH', `/api/events/${ev.id}`, { start: '2026-10-11T10:00' });
    assert.equal(zug.status, 200, zug.text);
    assert.equal(zug.json.record.data.projectId, umzug.id);
    const anderes = await request(base, 'PATCH', `/api/events/${ev.id}`, { projectId: garten.id });
    assert.equal(anderes.status, 400);
    assert.match(anderes.json.error.message, /Das Projekt .* gibt es nicht/);
  });
});

/* ------------------------------------------------ 3. leeres ?nur= */

test('Ein leeres ?nur= betrifft nie die ganze Serie: PATCH und DELETE antworten 400, die Serie bleibt', async () => {
  await withApp(async ({ store, base }) => {
    const s = (await request(base, 'POST', '/api/events', {
      title: 'Training', start: '2026-09-29T18:00', end: '2026-09-29T19:30', recurrence: { freq: 'weekly' },
    })).json.record;
    for (const q of ['?nur=', '?nur=%20', '?nur=morgen']) {
      const p = await request(base, 'PATCH', `/api/events/${s.id}${q}`, { title: 'Umbenannt?' });
      assert.equal(p.status, 400, `PATCH ${q}: ${p.text}`);
      assert.match(p.json.error.message, /"nur" muss ein Tag/);
      const d = await request(base, 'DELETE', `/api/events/${s.id}${q}`);
      assert.equal(d.status, 400, `DELETE ${q}: ${d.text}`);
    }
    const danach = store.get(s.id);
    assert.ok(danach, 'die Serie ist noch da');
    assert.equal(danach.data.title, 'Training');
    assert.deepEqual(danach.data.exdates, []);
    // Mit einem echten Tag geht es wie gehabt.
    const ok = await request(base, 'DELETE', `/api/events/${s.id}?nur=2026-10-06`);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.ausgelassen, '2026-10-06');
  });
});
