'use strict';

/**
 * Die Routen der Notizen als Teil des Wissensnetzes (src/http/api/notizen.js),
 * durch die echte Tuer (HTTP):
 *   GET  /api/notizen/vervollstaendigen   die Liste hinter "[[" und "#"
 *   POST /api/notizen/aufloesen           welche [[Namen]] es gibt
 *   POST /api/notizen/anlegen             "Notiz „Name“ anlegen?" -> Kante sofort
 *   POST/GET /api/notizen/dateien         Bilder im Ablagefach des Tresors
 *   POST /api/notizen/link                Link speichern, offline ehrlich ohne Titel
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, tempHome, waitForEvent } = require('./harness');

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
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, text, json });
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
  const { home, cleanup } = tempHome('nos-notizen-routen');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const api = {
      get: (p) => request(base, 'GET', p),
      post: (p, b) => request(base, 'POST', p, b === undefined ? {} : b),
    };
    return await fn({ app, store: app.store, bus: app.bus, base, api });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
}

function ok(res, was) {
  assert.equal(res.status, 200, `${was}: HTTP ${res.status} ${(res.text || '').slice(0, 200)}`);
  return res.json;
}

/** Ein 1x1-PNG, wie es jeder Bildeditor schreibt. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('vervollstaendigen: "[[" findet Titel (Anfang vor Wortanfang vor irgendwo), "#" Schlagworte mit Anzahl', async () => {
  await withApp(async ({ api, store }) => {
    store.create('note', { title: 'Photosynthese', body: 'Licht.', tags: ['biologie', 'schule'] });
    store.create('note', { title: 'Zellatmung', body: 'Umkehrung der Photosynthese.', tags: ['biologie'] });
    store.create('note', { title: 'Die Photonen', body: '', tags: ['physik'] });
    store.create('project', { name: 'Photoausstellung', tags: ['bio'] });
    store.create('entity', { name: 'Phoebe Meier', kind: 'person' });
    store.create('task', { title: 'Photos sortieren' });
    store.create('event', { title: 'Photokurs', start: '2026-10-01T10:00' });
    await store.flush();

    const links = ok(await api.get('/api/notizen/vervollstaendigen?q=phot'), 'link').items;
    const titel = links.map((i) => i.title);
    // Anfang zuerst: alle, die mit "phot" beginnen, vor "Die Photonen" (Wortanfang).
    assert.ok(titel.indexOf('Photosynthese') < titel.indexOf('Die Photonen'), titel.join(' | '));
    assert.ok(titel.includes('Photoausstellung') && titel.includes('Photos sortieren'), 'Projekte und Aufgaben gehoeren dazu');
    assert.ok(!titel.includes('Photokurs'), 'Termine werden nicht als [[Link]] angeboten');
    assert.ok(!titel.includes('Zellatmung'), 'ein Wort im Text reicht nicht: es geht um Titel');
    const projekt = links.find((i) => i.title === 'Photoausstellung');
    assert.equal(projekt.type, 'project');
    assert.equal(projekt.art, 'Projekt');

    const person = ok(await api.get('/api/notizen/vervollstaendigen?q=phoe'), 'person').items;
    assert.equal(person.length, 1);
    assert.equal(person[0].kind, 'person');
    assert.equal(person[0].art, 'Person');

    // Umlaute und Gross/Klein spielen keine Rolle -- dieselbe Faltung wie die Ableitung.
    const genau = ok(await api.get('/api/notizen/vervollstaendigen?q=PHOTOSYNTHESE'), 'genau').items;
    assert.equal(genau[0].title, 'Photosynthese');

    // Ohne Anfrage: die zuletzt beruehrten, hoechstens `limit`.
    const alle = ok(await api.get('/api/notizen/vervollstaendigen?limit=3'), 'ohne q').items;
    assert.equal(alle.length, 3);

    const tags = ok(await api.get('/api/notizen/vervollstaendigen?art=tag&q=bio'), 'tag').items;
    assert.deepEqual(tags, [{ tag: 'bio', anzahl: 1 }, { tag: 'biologie', anzahl: 2 }], 'genau zuerst, dann Anfang; mit Anzahl');
    const alleTags = ok(await api.get('/api/notizen/vervollstaendigen?art=tag'), 'alle tags').items;
    assert.equal(alleTags[0].tag, 'biologie', 'ohne Anfrage die haeufigsten zuerst');

    const falsch = await api.get('/api/notizen/vervollstaendigen?art=irgendwas');
    assert.equal(falsch.status, 400);
  });
});

test('aufloesen: sagt, welche [[Namen]] es gibt -- gefaltet wie die Ableitung', async () => {
  await withApp(async ({ api, store }) => {
    const foto = store.create('note', { title: 'Photosynthese', body: '' });
    const koeln = store.create('project', { name: 'Umzug nach Köln' });
    await store.flush();
    const res = ok(await api.post('/api/notizen/aufloesen', { namen: ['photosynthese', 'Umzug nach Koeln', 'Gibt es nicht'] }), 'aufloesen');
    assert.deepEqual(res.aufgeloest.photosynthese, { id: foto.id, type: 'note', title: 'Photosynthese' });
    assert.deepEqual(res.aufgeloest['Umzug nach Koeln'], { id: koeln.id, type: 'project', title: 'Umzug nach Köln' });
    assert.equal(res.aufgeloest['Gibt es nicht'], null);
    const leer = await api.post('/api/notizen/aufloesen', { namen: 'x' });
    assert.equal(leer.status, 400);
  });
});

test('anlegen: aus einem unaufgeloesten [[Link]] wird eine Notiz, und die Kante entsteht in derselben Anfrage', async () => {
  await withApp(async ({ api, store, bus }) => {
    const quelle = store.create('note', { title: 'Pflanzen', body: 'Siehe [[Zellatmung]] und [[Photosynthese]].' });
    await store.flush();
    const vorher = ok(await api.get(`/api/records/${quelle.id}/verknuepft`), 'vorher');
    assert.deepEqual(vorher.ausgehend, [], 'ohne Ziel keine Kante -- und kein Phantom');

    const kante = waitForEvent(bus, 'graph.kante', 3000);
    const res = ok(await api.post('/api/notizen/anlegen', { title: 'Zellatmung', vonId: quelle.id }), 'anlegen');
    assert.equal(res.bereits, false);
    assert.equal(res.record.type, 'note');
    assert.equal(res.record.data.title, 'Zellatmung');
    assert.equal(res.record.data.source, 'user');
    assert.equal(res.kanten.neu.length, 1, JSON.stringify(res.kanten));
    assert.deepEqual(res.kanten.unaufgeloest, ['Photosynthese'], 'der andere Link bleibt ehrlich unaufgeloest');
    const evt = await kante;
    assert.equal(evt.payload.edge.data.from, quelle.id);
    assert.equal(evt.payload.edge.data.to, res.record.id);
    assert.equal(evt.payload.edge.data.kind, 'links-to');

    const nachher = ok(await api.get(`/api/records/${quelle.id}/verknuepft`), 'nachher');
    assert.deepEqual(nachher.ausgehend.map((x) => [x.id, x.kind]), [[res.record.id, 'links-to']]);

    // Noch einmal derselbe Titel (anders geschrieben): kein Doppelgaenger.
    const nochmal = ok(await api.post('/api/notizen/anlegen', { title: 'zellatmung' }), 'nochmal');
    assert.equal(nochmal.bereits, true);
    assert.equal(nochmal.record.id, res.record.id);
    assert.equal(store.all('note').filter((n) => n.data.title.toLowerCase() === 'zellatmung').length, 1);

    // Mit Text und Schlagworten.
    const voll = ok(await api.post('/api/notizen/anlegen', { title: 'Chlorophyll', body: 'Grün.', tags: ['biologie'] }), 'voll');
    assert.equal(voll.record.data.body, 'Grün.');
    assert.deepEqual(voll.record.data.tags, ['biologie']);
    const ohne = await api.post('/api/notizen/anlegen', { title: '   ' });
    assert.equal(ohne.status, 400);
  });
});

test('dateien: ein Bild landet im Ablagefach des Tresors und kommt als Bild zurueck; SVG wird abgelehnt', async () => {
  await withApp(async ({ api, store }) => {
    const res = ok(await api.post('/api/notizen/dateien', { name: 'punkt.png', mime: 'image/png', daten: PNG_1X1 }), 'upload');
    assert.equal(res.record.type, 'file');
    assert.equal(res.record.data.mime, 'image/png');
    assert.equal(res.record.data.size, Buffer.from(PNG_1X1, 'base64').length);
    assert.ok(/^[0-9a-f]{64}$/.test(res.record.data.hash), 'inhaltsadressiert');
    assert.equal(res.url, `/api/notizen/dateien/${res.record.id}`);
    assert.equal(res.markdown, `![punkt.png](/api/notizen/dateien/${res.record.id})`);
    assert.ok(store.files.has(res.record.data.hash));

    const bild = await api.get(res.url);
    assert.equal(bild.status, 200);
    assert.equal(bild.headers['content-type'], 'image/png');
    assert.ok(bild.raw.equals(Buffer.from(PNG_1X1, 'base64')), 'Byte fuer Byte dasselbe Bild');
    assert.match(bild.headers['cache-control'], /private/);

    // Auch mit data:-Vorspann, wie FileReader.readAsDataURL es liefert.
    const zwei = ok(await api.post('/api/notizen/dateien', { name: 'punkt2.png', mime: 'image/png', daten: `data:image/png;base64,${PNG_1X1}` }), 'data-url');
    assert.equal(zwei.record.data.hash, res.record.data.hash, 'gleicher Inhalt, gleicher Ablageort');

    const svg = await api.post('/api/notizen/dateien', { name: 'x.svg', mime: 'image/svg+xml', daten: Buffer.from('<svg/>').toString('base64') });
    assert.equal(svg.status, 400);
    const leer = await api.post('/api/notizen/dateien', { name: 'x.png', mime: 'image/png', daten: '' });
    assert.equal(leer.status, 400);
    const weg = await api.get('/api/notizen/dateien/file_gibtesnicht');
    assert.equal(weg.status, 404);
    const keinBild = await api.get(`/api/notizen/dateien/${store.create('note', { title: 'x' }).id}`);
    assert.equal(keinBild.status, 404, 'eine Notiz ist keine Datei');
  });
});

test('link: offline wird ehrlich nur die Adresse gespeichert, mit Grund; ein eigener Titel gilt immer', async () => {
  await withApp(async ({ api, app }) => {
    assert.equal(app.gate.mode, 'offline', 'die Voreinstellung ist offline');
    const res = ok(await api.post('/api/notizen/link', { url: 'https://example.org/artikel/licht' }), 'link');
    assert.equal(res.record.type, 'note');
    assert.equal(res.titelGeholt, false);
    assert.match(res.grund, /offline/i);
    assert.equal(res.record.data.title, 'example.org/artikel/licht');
    assert.ok(res.record.data.body.includes('https://example.org/artikel/licht'));
    assert.deepEqual(res.record.data.tags, ['link']);

    const eigen = ok(await api.post('/api/notizen/link', { url: 'example.org', titel: 'Beispielseite' }), 'eigener Titel');
    assert.equal(eigen.record.data.title, 'Beispielseite');
    assert.equal(eigen.url, 'https://example.org/');
    assert.equal(eigen.grund, null);

    for (const url of ['javascript:alert(1)', 'ftp://x.y/z', 'nur worte hier', '']) {
      const falsch = await api.post('/api/notizen/link', { url });
      assert.equal(falsch.status, 400, `${url} -> ${falsch.status}`);
    }
  });
});

test('reine Helfer: trefferGuete, seitenTitel, titelAusUrl', () => {
  const { trefferGuete, seitenTitel, titelAusUrl } = require('../src/http/api/notizen');
  assert.equal(trefferGuete('photosynthese', 'photosynthese'), 0);
  assert.equal(trefferGuete('photosynthese', 'photo'), 1);
  assert.equal(trefferGuete('die photonen', 'photo'), 2);
  assert.equal(trefferGuete('zellatmung', 'atm'), 3);
  assert.equal(trefferGuete('zellatmung', 'xyz'), -1);
  assert.equal(trefferGuete('irgendwas', ''), 3);
  assert.equal(seitenTitel('<html><head><title>\n  Licht &amp; Blatt – Biologie  </title></head></html>'), 'Licht & Blatt – Biologie');
  assert.equal(seitenTitel('<p>kein titel</p>'), '');
  assert.equal(titelAusUrl(new URL('https://example.org/')), 'example.org');
  assert.equal(titelAusUrl(new URL('https://example.org/a/b/')), 'example.org/a/b');
});
