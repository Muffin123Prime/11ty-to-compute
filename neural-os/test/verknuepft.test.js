'use strict';

/**
 * Die Routen des Wissensuniversums, durch die echte Tuer (HTTP):
 *   GET  /api/records/:id/verknuepft          (Vertrag B)
 *   GET  /api/graph/universum?tiefe=&thema=    (Vertrag A, F)
 *   POST /api/graph/verbinden, /rueckgaengig, /ablehnen (Vertrag C)
 *   POST /api/graph/zusammenfassung            (ohne KI ehrlich ein Satz)
 * und die Ereignisse ueber den Strom /api/events (Vertrag D, E).
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, tempHome } = require('./harness');

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
        try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath}: keine Antwort nach 5 s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Den Ereignisstrom oeffnen und bis zum ersten passenden Ereignis mit `name` lesen. */
function strom(base, name, passt = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/events', base);
    const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
      let puffer = '';
      let aktuell = null;
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`kein ${name} nach ${ms} ms`)); }, ms);
      res.on('data', (chunk) => {
        puffer += chunk.toString('utf8');
        let idx;
        while ((idx = puffer.indexOf('\n')) >= 0) {
          const zeile = puffer.slice(0, idx);
          puffer = puffer.slice(idx + 1);
          if (zeile.startsWith('event:')) aktuell = zeile.slice(6).trim();
          else if (zeile.startsWith('data:') && aktuell === name) {
            let daten = zeile.slice(5).trim();
            try { daten = JSON.parse(daten); } catch { /* Klartext */ }
            if (!passt(daten)) continue;
            clearTimeout(timer);
            req.destroy();
            resolve(daten);
            return;
          }
        }
      });
      res.on('error', () => {});
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

async function withApp(fn) {
  const { createApp } = require('../src/app');
  const { home, cleanup } = tempHome('nos-verknuepft');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const api = {
      get: (p) => request(base, 'GET', p),
      post: (p, b) => request(base, 'POST', p, b === undefined ? {} : b),
    };
    return await fn({ app, store: app.store, base, api });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
}

function ok(res, was) {
  assert.equal(res.status, 200, `${was}: HTTP ${res.status} ${(res.text || '').slice(0, 200)}`);
  return res.json;
}

test('GET /api/records/:id/verknuepft: eingehend, ausgehend, Vorschlaege mit Grund, Themen', async () => {
  await withApp(async ({ api }) => {
    const foto = ok(await api.post('/api/records', { type: 'note', data: { title: 'Photosynthese', body: 'Chlorophyll im Blatt absorbiert Licht. Siehe [[Zellatmung]].', tags: ['biologie'] } }), 'foto').record;
    const atmung = ok(await api.post('/api/records', { type: 'note', data: { title: 'Zellatmung', body: 'Umkehrung der [[Photosynthese]].', tags: ['biologie'] } }), 'atmung').record;
    const chloro = ok(await api.post('/api/records', { type: 'note', data: { title: 'Chlorophyll absorbiert Licht', body: 'Rotes und blaues Licht.' } }), 'chloro').record;
    // [[Zellatmung]] stand im Text, bevor es die Notiz gab: erst das Nachziehen loest den Link auf.
    ok(await api.post('/api/graph/rescan'), 'rescan');
    await new Promise((r) => setTimeout(r, 150));

    const v = ok(await api.get(`/api/records/${foto.id}/verknuepft`), 'verknuepft');
    assert.equal(v.id, foto.id);
    // Photosynthese -> Zellatmung ([[Link]] im Text) und Zellatmung -> Photosynthese.
    assert.deepEqual(v.ausgehend.map((x) => [x.id, x.kind]), [[atmung.id, 'links-to']]);
    assert.deepEqual(v.eingehend.map((x) => [x.id, x.kind]), [[atmung.id, 'links-to']]);
    for (const x of [...v.eingehend, ...v.ausgehend]) {
      assert.equal(x.type, 'note');
      assert.equal(x.title, 'Zellatmung');
      assert.match(x.reason, /Wiki-Link/);
      assert.equal(x.source, 'derived');
      assert.ok(x.edgeId.startsWith('edge_'));
    }
    // Vorschlag: Chlorophyll (nicht verbunden, teilt Woerter), NICHT Zellatmung (schon verbunden).
    assert.ok(v.vorschlaege.some((s) => s.id === chloro.id), JSON.stringify(v.vorschlaege));
    assert.ok(!v.vorschlaege.some((s) => s.id === atmung.id));
    const s = v.vorschlaege.find((x) => x.id === chloro.id);
    assert.equal(s.type, 'note');
    assert.equal(s.title, 'Chlorophyll absorbiert Licht');
    assert.ok(s.score > 0);
    assert.match(s.grund, /gemeinsame Begriffe: /);
    assert.ok(s.grund.includes('Licht') && s.grund.includes('Chlorophyll'), s.grund);
    // Themen der Karte: #biologie.
    assert.deepEqual(v.themen.map((t) => t.id), ['thema:biologie']);
    assert.equal(v.themen[0].name, 'Biologie');

    const fehlt = await api.get('/api/records/note_gibtesnicht00000000000000/verknuepft');
    assert.equal(fehlt.status, 404);
    const limit = ok(await api.get(`/api/records/${foto.id}/verknuepft?limit=1`), 'limit');
    assert.ok(limit.vorschlaege.length <= 1);
  });
});

test('GET /api/graph/universum: Ebene 0 und 1, Fehler fuer Unsinn, Cache mit Stand', async () => {
  await withApp(async ({ api }) => {
    for (const [title, tags, body] of [
      ['Photosynthese', ['schule', 'biologie'], 'Licht. Siehe [[Zellatmung]].'],
      ['Zellatmung', ['schule', 'biologie'], 'Sauerstoff.'],
      ['Zellen', ['schule', 'biologie'], 'Einheit.'],
      ['Erster Weltkrieg', ['schule', 'geschichte'], '1914.'],
      ['Zweiter Weltkrieg', ['schule', 'geschichte'], '1939. Siehe [[Erster Weltkrieg]].'],
      ['Einkaufszettel', [], 'Milch.'],
    ]) ok(await api.post('/api/records', { type: 'note', data: { title, body, tags } }), title);
    ok(await api.post('/api/graph/rescan'), 'rescan'); // Links auf spaeter angelegte Notizen
    await new Promise((r) => setTimeout(r, 100));

    const e0 = ok(await api.get('/api/graph/universum'), 'ebene 0');
    assert.equal(e0.ebene, 0);
    assert.ok(Array.isArray(e0.themen) && e0.themen.length >= 2);
    assert.ok(e0.themen.length <= 40);
    const schule = e0.themen.find((t) => t.id === 'thema:schule');
    assert.ok(schule, e0.themen.map((t) => t.id).join(', '));
    assert.deepEqual(schule.kinder.map((k) => k.name).sort(), ['Biologie', 'Geschichte']);
    assert.ok(Number.isInteger(schule.farbe) && schule.farbe >= 0 && schule.farbe <= 7);
    assert.ok(schule.knoten.length <= 5);
    assert.ok(e0.gesamt.knoten >= 6);
    assert.equal(typeof e0.stand, 'number');
    assert.equal(typeof e0.dauerMs, 'number');
    assert.ok(Array.isArray(e0.verbindungen));

    const e0b = ok(await api.get('/api/graph/universum?tiefe=0'), 'ebene 0 nochmal');
    assert.equal(e0b.ausCache, true, 'die zweite Antwort kommt aus dem Cache');
    assert.equal(e0b.stand, e0.stand);

    const e1 = ok(await api.get('/api/graph/universum?tiefe=1&thema=thema:biologie'), 'ebene 1');
    assert.equal(e1.ebene, 1);
    assert.equal(e1.thema.name, 'Biologie');
    assert.equal(e1.thema.eltern, 'thema:schule');
    assert.deepEqual(e1.knoten.filter((k) => !k.ausserhalb).map((k) => k.label).sort(), ['Photosynthese', 'Zellatmung', 'Zellen']);
    assert.ok(e1.kanten.length >= 1);
    assert.equal(e1.gekuerzt, false);

    assert.equal((await api.get('/api/graph/universum?tiefe=1')).status, 400, 'Ebene 1 ohne Thema');
    assert.equal((await api.get('/api/graph/universum?tiefe=1&thema=thema:nix')).status, 404);
    assert.equal((await api.get('/api/graph/universum?tiefe=abc')).status, 400);
    assert.equal((await api.get('/api/graph/universum?typen=unsinn')).status, 400);

    // Eine Aenderung: neuer Stand, kein Cache.
    ok(await api.post('/api/records', { type: 'note', data: { title: 'Genetik', body: 'Mendel.', tags: ['schule', 'biologie'] } }), 'genetik');
    const e0c = ok(await api.get('/api/graph/universum'), 'ebene 0 danach');
    assert.equal(e0c.ausCache, false);
    assert.ok(e0c.stand > e0.stand);
    assert.equal(e0c.themen.find((t) => t.id === 'thema:schule').anzahl, schule.anzahl + 1);
  });
});

test('POST verbinden / rueckgaengig / ablehnen ueber HTTP, Ereignisse ueber /api/events', async () => {
  await withApp(async ({ api, base, store }) => {
    const foto = ok(await api.post('/api/records', { type: 'note', data: { title: 'Photosynthese', body: 'Chlorophyll im Blatt absorbiert Licht.', tags: ['biologie'] } }), 'foto').record;
    const pflanzen = ok(await api.post('/api/records', { type: 'note', data: { title: 'Pflanzen brauchen Licht', body: 'Ohne Licht kein Wachstum.' } }), 'pflanzen').record;

    // E: nach dem Speichern kommt 'graph.vorschlaege' ueber den Strom -- fuer GENAU diese Notiz.
    const title = 'Chlorophyll absorbiert Licht';
    const vorschlag = strom(base, 'graph.vorschlaege', (d) => d.payload && d.payload.vorschlaege.every((x) => x.title !== title) && store.get(d.payload.recordId).data.title === title);
    await new Promise((r) => setTimeout(r, 30)); // der Strom muss offen sein, bevor gespeichert wird
    const chloro = ok(await api.post('/api/records', { type: 'note', data: { title, body: 'Rotes und blaues Licht.' } }), 'chloro').record;
    const evt = await vorschlag;
    assert.equal(evt.name, 'graph.vorschlaege');
    assert.equal(evt.payload.recordId, chloro.id);
    assert.ok(evt.payload.vorschlaege.some((v) => v.id === foto.id));
    assert.ok(evt.payload.vorschlaege.every((v) => typeof v.grund === 'string' && v.grund));

    // C: verbinden -- und D: die Kante kommt als 'graph.kante' ueber den Strom.
    const kante = strom(base, 'graph.kante', (d) => d.payload && d.payload.neu && d.payload.edge.data.from === chloro.id);
    await new Promise((r) => setTimeout(r, 30));
    const v = ok(await api.post('/api/graph/verbinden', { from: chloro.id, to: [foto.id, pflanzen.id], kind: 'related', reason: 'Alle verbinden' }), 'verbinden');
    assert.equal(v.edges.length, 2);
    assert.equal(v.neu.length, 2);
    assert.ok(v.edges.every((e) => e.data.source === 'manual' && e.data.reason === 'Alle verbinden'));
    assert.equal(v.rueckgaengig.pfad, '/api/graph/rueckgaengig');
    const k = await kante;
    assert.equal(k.payload.neu, true);
    assert.equal(k.payload.edge.data.from, chloro.id);
    assert.equal(k.payload.von.label, 'Chlorophyll absorbiert Licht');
    // Verbundene sind kein Vorschlag mehr.
    const nach = ok(await api.get(`/api/records/${chloro.id}/verknuepft`), 'verknuepft');
    assert.deepEqual(nach.vorschlaege, []);
    assert.equal(nach.ausgehend.length, 2);

    // Rueckgaengig.
    const z = ok(await api.post(v.rueckgaengig.pfad, v.rueckgaengig.body), 'rueckgaengig');
    assert.equal(z.anzahl, 2);
    assert.equal(store.edges.for(chloro.id).length, 0);
    assert.equal((await api.post('/api/graph/rueckgaengig', { edges: [] })).status, 400);
    assert.equal((await api.post('/api/graph/rueckgaengig', { edges: ['edge_gibtesnicht0000000000000'] })).status, 404);

    // Ablehnen: der Vorschlag kommt nicht wieder.
    const abl = ok(await api.post('/api/graph/ablehnen', { from: chloro.id, to: [foto.id] }), 'ablehnen');
    assert.equal(abl.abgelehnt.length, 1);
    const danach = ok(await api.get(`/api/records/${chloro.id}/verknuepft`), 'verknuepft');
    assert.ok(!danach.vorschlaege.some((s) => s.id === foto.id));
    assert.ok(danach.vorschlaege.some((s) => s.id === pflanzen.id));

    // Eingaben, die nicht durchgehen.
    assert.equal((await api.post('/api/graph/verbinden', { from: chloro.id, to: [] })).status, 400);
    assert.equal((await api.post('/api/graph/verbinden', { from: chloro.id, to: 'kein-array' })).status, 400);
    assert.equal((await api.post('/api/graph/verbinden', { from: chloro.id, to: [foto.id], kind: 'unsinn' })).status, 400);
    assert.equal((await api.post('/api/graph/verbinden', { from: 'note_gibtesnicht00000000000000', to: [foto.id] })).status, 404);
    assert.equal((await api.post('/api/graph/ablehnen', { from: chloro.id })).status, 400);
  });
});

test('POST /api/graph/zusammenfassung sagt ehrlich, dass keine KI verbunden ist', async () => {
  await withApp(async ({ api }) => {
    const n = ok(await api.post('/api/records', { type: 'note', data: { title: 'Photosynthese', body: 'Licht.' } }), 'note').record;
    const z = ok(await api.post('/api/graph/zusammenfassung', { id: n.id }), 'zusammenfassung');
    assert.equal(z.verfuegbar, false);
    assert.equal(z.text, null);
    assert.equal(z.grund, 'Kommt, sobald eine KI verbunden ist.');
    assert.equal((await api.post('/api/graph/zusammenfassung', {})).status, 400);
    assert.equal((await api.post('/api/graph/zusammenfassung', { id: 'note_gibtesnicht00000000000000' })).status, 404);
  });
});
