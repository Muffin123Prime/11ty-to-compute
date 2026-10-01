'use strict';

/**
 * Pruefrunde Notizen (Runde 2): was sich ohne Browser belegen laesst, durch
 * die echte Tuer (HTTP) oder als reine Funktion der Ansicht.
 *
 *   1  Wand mit mehr als 600 Notizen   GET /api/notizen/auswahl, wandAuswahl
 *   2  Vorschlagskarte "Bearbeiten"     kartenWahl (+ /api/graph/ablehnen)
 *   3  Schlagworte aus dem Feld `tags`  schlagworteZumBearbeiten, "#"-Liste
 *   4  Import gegen Termin/Chat/Person  POST /api/notizen/import
 *   5  Doppelter Titel umbenannt        Titelverzeichnis der Ableitung
 *   8  Link-Zwischenspeicher            aufloesungVeraltet
 *   9  Link-Ziele                       indexKey/linkKeys = titelSchluessel/linkSchluessel
 *  10  Laeufe in "Verknuepft mit"       artInfo, ohneLaeufe
 *  11  Herkunft im Blatt                GET /api/notizen/auswahl?id=
 *  12  Bild im Text                     Kante Notiz -> Datei
 *  13  404 in der Ansicht               errorText
 *
 * Was nur im Browser zu sehen ist (6: das Blatt nach einer Aenderung
 * anderswo, 7: Wartezeiten in openNote/togglePin), belegen die Laeufe im
 * echten Chromium (Pruefer-Skripte b6, b7, b8).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

/* ------------------------------------------------------------ Helfer */

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
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath}: keine Antwort nach 10 s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withApp(fn) {
  const { createApp } = require('../src/app');
  const { home, cleanup } = tempHome('nos-notizen-pruefrunde');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const api = {
      get: (p) => request(base, 'GET', p),
      post: (p, b) => request(base, 'POST', p, b === undefined ? {} : b),
      patch: (p, b) => request(base, 'PATCH', p, b),
      del: (p) => request(base, 'DELETE', p),
    };
    return await fn({ app, store: app.store, bus: app.bus, api });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
}

function ok(res, was) {
  assert.equal(res.status, 200, `${was}: HTTP ${res.status} ${(res.text || '').slice(0, 200)}`);
  return res.json;
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bis `pruefe()` stimmt (Nachziehen und Ableitung laufen nach dem Schreiben). */
async function bis(pruefe, was, ms = 2000) {
  const ende = Date.now() + ms;
  for (;;) {
    if (pruefe()) return;
    if (Date.now() > ende) assert.fail(`${was}: nach ${ms} ms nicht erreicht`);
    await warte(20);
  }
}

/** Abgeleitete links-to-Ziele eines Satzes. */
function linkZiele(store, id) {
  return store.edges.for(id, { direction: 'out' })
    .filter((e) => e.data.kind === 'links-to' && e.data.source === 'derived')
    .map((e) => e.data.to)
    .sort();
}

/** Die Browser-Module unveraendert als .mjs laden (wie test/notizen-editor.test.js). */
let geladen = null;
async function laden() {
  if (geladen) return geladen;
  const web = path.join(__dirname, '..', 'web');
  const { home, cleanup } = tempHome('nos-notizen-pruefrunde-web');
  const alsModul = (src) => src.replace(/(from\s+')([^']+)\.js(')/g, (m, kopf, spec, ende) => `${kopf}./${path.basename(spec)}.mjs${ende}`);
  for (const datei of fs.readdirSync(path.join(web, 'lib'))) {
    if (!datei.endsWith('.js')) continue;
    fs.writeFileSync(path.join(home, datei.replace(/\.js$/, '.mjs')), alsModul(fs.readFileSync(path.join(web, 'lib', datei), 'utf8')));
  }
  fs.writeFileSync(path.join(home, 'notes.mjs'), alsModul(fs.readFileSync(path.join(web, 'views', 'notes.js'), 'utf8')));
  try {
    geladen = {
      editor: await import(pathToFileURL(path.join(home, 'editor.mjs')).href),
      markdown: await import(pathToFileURL(path.join(home, 'markdown.mjs')).href),
      notes: await import(pathToFileURL(path.join(home, 'notes.mjs')).href),
    };
  } finally {
    cleanup();
  }
  return geladen;
}

/* -------------------------------------- 1: mehr als 600 Notizen */

test('1: Filter "Automatisch" und #schlagwort finden auch Notizen, die nicht unter den 600 neuesten sind', async () => {
  await withApp(async ({ api, store, app }) => {
    const chat = store.create('chat', { title: 'Steuer' });
    const alt = [];
    for (let i = 0; i < 5; i++) alt.push(store.create('note', { title: `KI-Notiz ${i}`, body: `Inhalt ${i} #steuer`, source: 'auto', chatId: chat.id }));
    const angeheftet = store.create('note', { title: 'Alt, aber angeheftet', body: 'x', pinned: true });
    await warte(5);
    await app.bulkWrite(() => { for (let i = 0; i < 620; i++) store.create('note', { title: `Neuer ${i}`, body: 'x' }); });

    const wand = ok(await api.get('/api/notizen?limit=600'), 'wand');
    assert.equal(wand.total, 626);
    assert.equal(wand.items.length, 600);
    assert.ok(!wand.items.some((n) => alt.some((a) => a.id === n.id)), 'die fuenf KI-Notizen sind die aeltesten und fehlen auf der Wand');

    const auto = ok(await api.get('/api/notizen/auswahl?filter=auto&limit=600'), 'auto');
    assert.equal(auto.total, 5);
    assert.deepEqual(auto.items.map((n) => n.id).sort(), alt.map((n) => n.id).sort());
    assert.ok(auto.items.every((n) => n.herkunft.art === 'chat' && n.herkunft.chatTitel === 'Steuer'), 'in der Form der Wand, mit Herkunft');

    const steuer = ok(await api.get('/api/notizen/auswahl?tag=steuer'), 'tag');
    assert.equal(steuer.total, 5, 'das Schlagwort ueber ALLE Notizen');
    assert.deepEqual(steuer.schlagworte.find((s) => s.tag === 'steuer'), { tag: 'steuer', anzahl: 5 }, 'die Leiste zaehlt ueber alle Notizen');
    assert.equal(ok(await api.get('/api/notizen/auswahl?tag=%23STEUER'), 'gross').total, 5, 'mit # und in Grossbuchstaben dasselbe');

    const nurZahlen = ok(await api.get('/api/notizen/auswahl?limit=0'), 'zahlen');
    assert.deepEqual(nurZahlen.items, []);
    assert.equal(nurZahlen.total, 626);
    assert.ok(nurZahlen.schlagworteAnzahl >= 1);

    const gepinnt = ok(await api.get('/api/notizen/auswahl?filter=angeheftet'), 'angeheftet');
    assert.deepEqual(gepinnt.items.map((n) => n.id), [angeheftet.id]);
    const beides = ok(await api.get('/api/notizen/auswahl?filter=auto&tag=steuer&limit=2'), 'beides');
    assert.equal(beides.total, 5);
    assert.equal(beides.items.length, 2, 'limit gilt');
    assert.equal((await api.get('/api/notizen/auswahl?filter=unsinn')).status, 400);
  });
});

test('1: wandAuswahl -- gekuerzt geladen, nimmt die Wand fuer Filter und Schlagwort die Auswahl des Servers', async () => {
  const { wandAuswahl, auswahlSchluessel, sichtbareNotizen } = (await laden()).notes;
  const items = Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, data: { title: `Neu ${i}`, body: '', tags: [] } }));
  const alt = [{ id: 'a1', data: { title: 'Alt', body: '#steuer', source: 'auto' } }];

  let s = wandAuswahl({ items: items.slice(0, 20), total: 20, filter: 'auto' });
  assert.equal(s.vomServer, false, 'alles geladen: die Wand filtert selbst');
  assert.equal(s.quelle.length, 20);
  assert.equal(s.hinweis, null);
  assert.equal(s.schluss, null);

  s = wandAuswahl({ items, total: 625 });
  assert.equal(s.vomServer, false);
  assert.match(s.schluss, /600 neuesten von 625 Notizen/, 'unter der Wand steht, dass es mehr gibt');
  s = wandAuswahl({ items, total: 625, q: 'licht' });
  assert.equal(s.hinweis, 'Durchsucht sind die 600 neuesten Notizen. Alle 625 findet Strg+K.');

  s = wandAuswahl({ items, total: 625, filter: 'auto' });
  assert.equal(s.laedt, true, 'ohne Auswahl: laden, nicht "Noch keine automatische Notiz" behaupten');
  assert.equal(s.quelle, null);
  s = wandAuswahl({ items, total: 625, tag: 'steuer', auswahl: { schluessel: auswahlSchluessel('auto', null), items: alt, total: 1 } });
  assert.equal(s.laedt, true, 'eine Auswahl fuer etwas anderes gilt nicht');

  const auswahl = { schluessel: auswahlSchluessel('alle', 'steuer'), items: alt, total: 1, laedt: false, fehler: null };
  s = wandAuswahl({ items, total: 625, tag: 'Steuer', auswahl });
  assert.equal(s.laedt, false);
  assert.equal(s.vomServer, true);
  assert.deepEqual(s.quelle, alt);
  assert.deepEqual(sichtbareNotizen(s.quelle, { q: '' }).map((n) => n.id), ['a1']);
  assert.equal(s.hinweis, null, 'die Auswahl ist vollstaendig');

  s = wandAuswahl({ items, total: 2000, filter: 'auto', auswahl: { schluessel: auswahlSchluessel('auto', null), items, total: 900 } });
  assert.equal(s.hinweis, 'Gezeigt sind die 600 neuesten der 900 passenden Notizen.');
  s = wandAuswahl({ items, total: 2000, filter: 'auto', q: 'x', auswahl: { schluessel: auswahlSchluessel('auto', null), items, total: 900 } });
  assert.match(s.hinweis, /Durchsucht sind die 600 neuesten der 900 passenden Notizen/);
  s = wandAuswahl({ items, total: 625, filter: 'auto', auswahl: { schluessel: auswahlSchluessel('auto', null), items: [], total: 0, fehler: 'weg' } });
  assert.equal(s.fehler, 'weg');
  assert.equal(s.quelle, null);
});

/* ----------------------------------------- 2: Vorschlagskarte */

test('2: Bearbeiten -> einen abwaehlen -> Ablehnen lehnt genau den abgewaehlten ab', async () => {
  const { kartenWahl } = (await laden()).notes;
  await withApp(async ({ api, store }) => {
    const mk = async (title, body) => ok(await api.post('/api/records', { type: 'note', data: { title, body } }), title).record;
    const foto = await mk('Photosynthese', 'Chlorophyll im Blatt absorbiert Licht und bildet Zucker aus Wasser und Kohlendioxid.');
    await mk('Chlorophyll absorbiert Licht', 'Chlorophyll absorbiert rotes und blaues Licht im Blatt.');
    await mk('Blatt und Licht', 'Das Blatt faengt Licht, Chlorophyll macht es gruen, Wasser kommt dazu.');
    await mk('Zucker aus Wasser', 'Kohlendioxid und Wasser werden zu Zucker, mit Licht und Chlorophyll.');
    const v = ok(await api.get(`/api/records/${foto.id}/verknuepft`), 'verknuepft');
    const zucker = v.vorschlaege.find((s) => s.title === 'Zucker aus Wasser');
    assert.ok(zucker && v.vorschlaege.length >= 3, JSON.stringify(v.vorschlaege.map((s) => s.title)));

    // Ohne Bearbeiten: alles fuer alle.
    const alle = kartenWahl(v.vorschlaege, new Set(v.vorschlaege.map((s) => s.id)), false);
    assert.equal(alle.verbindenText, 'Alle verbinden');
    assert.equal(alle.ablehnenText, 'Alle ablehnen');
    assert.equal(alle.ablehnen.length, v.vorschlaege.length);

    // Bearbeiten: "Zucker aus Wasser" abgewaehlt (durchgestrichen).
    const gewaehlt = new Set(v.vorschlaege.filter((s) => s.id !== zucker.id).map((s) => s.id));
    const wahl = kartenWahl(v.vorschlaege, gewaehlt, true);
    assert.deepEqual(wahl.ablehnen.map((s) => s.title), ['Zucker aus Wasser']);
    assert.ok(!wahl.verbinden.some((s) => s.id === zucker.id));
    assert.equal(wahl.ablehnenText, 'Abgewählte ablehnen (1)');
    assert.equal(wahl.verbindenText, `Ausgewählte verbinden (${v.vorschlaege.length - 1})`);

    ok(await api.post('/api/graph/ablehnen', { from: foto.id, to: wahl.ablehnen.map((s) => s.id) }), 'ablehnen');
    const abgelehnt = store.all('suggestion').filter((s) => s.data.status === 'dismissed').map((s) => s.data.title);
    assert.deepEqual(abgelehnt, ['Verbindung abgelehnt: Photosynthese – Zucker aus Wasser'], 'dauerhaft abgelehnt ist nur der abgewaehlte');
    const danach = ok(await api.get(`/api/records/${foto.id}/verknuepft`), 'danach');
    assert.ok(danach.vorschlaege.some((s) => s.title === 'Chlorophyll absorbiert Licht') && !danach.vorschlaege.some((s) => s.id === zucker.id));

    // Alles angehakt: es gibt nichts abzulehnen (der Knopf ist aus).
    assert.deepEqual(kartenWahl(v.vorschlaege, new Set(v.vorschlaege.map((s) => s.id)), true).ablehnen, []);
  });
});

/* --------------------------------------------- 3: Schlagworte */

test('3: schlagworteZumBearbeiten -- was sich nicht als #wort schreiben laesst, bleibt im Feld; nach dem Speichern fehlt keines', async () => {
  const { schlagworteZumBearbeiten, tagsVon } = (await laden()).notes;
  const faelle = [
    { body: 'Belege bis Mai sammeln.', tags: ['2025', 'steuer'], text: 'Belege bis Mai sammeln.\n\n#steuer', feld: ['2025'] },
    { body: 'Filament bestellen', tags: ['3d-druck'], text: 'Filament bestellen', feld: ['3d-druck'] },
    { body: 'Notizen', tags: ['v1.2'], text: 'Notizen', feld: ['v1.2'] },
    { body: 'Lernen', tags: ['c++'], text: 'Lernen', feld: ['c++'] },
    { body: 'Formulare', tags: ['steuer erklärung'], text: 'Formulare', feld: ['steuer erklärung'] },
    { body: '', tags: ['biologie', 'Biologie', '#schule'], text: '#biologie #schule', feld: [] },
    { body: 'Schon da #Übung', tags: ['übung'], text: 'Schon da #Übung', feld: [] },
    // Am Ende eines offenen Codeblocks waere "#steuer" Code: es bleibt im Feld.
    { body: 'Beispiel:\n```js\nconst x = 1;', tags: ['steuer'], text: 'Beispiel:\n```js\nconst x = 1;', feld: ['steuer'] },
  ];
  for (const f of faelle) {
    const r = schlagworteZumBearbeiten(f.body, f.tags);
    assert.equal(r.text, f.text, JSON.stringify(f.tags));
    assert.deepEqual(r.feld, f.feld, JSON.stringify(f.tags));
    // So speichert der Editor: Text und Feld. Kein Schlagwort geht verloren oder wird verstuemmelt.
    const vorher = tagsVon({ data: { body: f.body, tags: f.tags } }).map((t) => t.toLowerCase()).sort();
    const nachher = tagsVon({ data: { body: r.text, tags: r.feld } }).map((t) => t.toLowerCase()).sort();
    assert.deepEqual(nachher, vorher, JSON.stringify(f));
  }
  assert.deepEqual(schlagworteZumBearbeiten('Text', undefined), { text: 'Text', feld: [] });
});

test('3: eine Notiz der KI mit "2025" und "steuer" behaelt nach dem Bearbeiten beide; die "#"-Liste bietet nur schreibbare an', async () => {
  const { schlagworteZumBearbeiten } = (await laden()).notes;
  const { tagsOf } = require('../src/graph/view');
  await withApp(async ({ api, store, app }) => {
    const { createWerkzeuge } = require('../src/models/werkzeuge');
    const chat = store.create('chat', { title: 'Steuer 2025' });
    const w = createWerkzeuge({ store, bus: app.bus });
    const r = w.ausfuehren({ id: 'toolu_1', name: 'notiz_anlegen', input: { titel: 'Belege Steuer', text: 'Belege bis Mai sammeln.', schlagworte: ['2025', 'steuer'] } }, undefined, { chatId: chat.id });
    const id = r.produced[0];
    const note = store.get(id);
    assert.deepEqual(note.data.tags, ['2025', 'steuer']);

    // Wie der Editor: oeffnen, ein Wort ergaenzen, speichern.
    const start = schlagworteZumBearbeiten(note.data.body, note.data.tags);
    const body = start.text.replace('sammeln.', 'sammeln. Quittungen auch.');
    ok(await api.patch(`/api/records/${id}`, { data: { title: note.data.title, body, tags: start.feld }, rev: note.rev }), 'speichern');
    const danach = store.get(id);
    assert.deepEqual(danach.data.tags, ['2025']);
    assert.deepEqual(tagsOf(danach).sort(), ['2025', 'steuer'], 'beide Schlagworte sind noch da');

    const zwanzig = ok(await api.get('/api/notizen/vervollstaendigen?art=tag&q=20'), '#20').items;
    assert.ok(!zwanzig.some((t) => t.tag === '2025'), '"#2025" waere im Text kein Schlagwort -- also nicht angeboten');
    const st = ok(await api.get('/api/notizen/vervollstaendigen?art=tag&q=st'), '#st').items;
    assert.ok(st.some((t) => t.tag === 'steuer'));
  });
  const { isTextTag } = require('../src/graph/derive');
  for (const t of ['steuer', 'Übung', 'a/b', 'foo-bar', 'x1']) assert.equal(isTextTag(t), true, t);
  for (const t of ['2025', '3d-druck', 'v1.2', 'c++', 'foo-', 'zwei worte', '', 'a'.repeat(65)]) assert.equal(isTextTag(t), false, t);
});

/* -------------------------------------------------- 4: Import */

test('4: Import legt "Zahnarzt.md" an, auch wenn es den Termin "Zahnarzt" gibt -- doppelt ist nur eine Notiz', async () => {
  await withApp(async ({ api, store }) => {
    ok(await api.post('/api/events', { title: 'Zahnarzt', start: '2026-10-05T10:00', end: '2026-10-05T11:00' }), 'termin');
    store.create('chat', { title: 'Rezept für Lasagne' });
    store.create('entity', { name: 'Anna', kind: 'person' });
    store.create('note', { title: 'Schon da', body: 'alt' });
    const res = ok(await api.post('/api/notizen/import', {
      dateien: [
        { name: 'Vault/Zahnarzt.md', text: 'Fragen an die Zahnaerztin.' },
        { name: 'Vault/Rezept für Lasagne.md', text: '500 g Hack.' },
        { name: 'Vault/Anna.md', text: 'Geburtstag 3. Mai.' },
        { name: 'Vault/schon  DA.md', text: 'neu' },
      ],
    }), 'import');
    assert.equal(res.angelegt, 3, JSON.stringify(res.uebersprungen));
    assert.deepEqual(res.uebersprungen.map((u) => u.name), ['Vault/schon  DA.md'], 'eine gleichnamige NOTIZ bleibt einmalig (auch mit zwei Leerzeichen)');
    assert.match(res.uebersprungen[0].grund, /gibt es schon/);
    const titel = store.all('note').map((n) => n.data.title).sort();
    assert.deepEqual(titel, ['Anna', 'Rezept für Lasagne', 'Schon da', 'Zahnarzt']);
    // [[Zahnarzt]] meint jetzt die Notiz, nicht den Termin.
    const auf = ok(await api.post('/api/notizen/aufloesen', { namen: ['Zahnarzt', 'Anna'] }), 'aufloesen').aufgeloest;
    assert.equal(auf.Zahnarzt.type, 'note');
    assert.equal(auf.Anna.type, 'note');
  });
});

/* -------------------------------------- 5: doppelter Titel */

test('5: zwei Notizen "Zellkern", die aeltere wird umbenannt -- [[Zellkern]] verbindet mit der zweiten, in Ansicht UND Netz', async () => {
  await withApp(async ({ api, store }) => {
    const mk = async (title, body) => ok(await api.post('/api/records', { type: 'note', data: { title, body } }), title).record;
    const a = await mk('Zellkern', 'erste');
    await warte(5);
    const b = await mk('Zellkern', 'zweite');
    await warte(5);
    const lern = await mk('Lernplan', 'Siehe [[Zellkern]].');
    await bis(() => linkZiele(store, lern.id).length === 1, 'Kante vorher');
    assert.deepEqual(linkZiele(store, lern.id), [a.id], 'der aeltere Titel gilt');

    ok(await api.patch(`/api/records/${a.id}`, { data: { title: 'Nucleus', body: 'erste', tags: [] }, rev: a.rev }), 'umbenennen');
    await bis(() => linkZiele(store, lern.id).join() === b.id, 'Kante zur zweiten Notiz');
    const auf = ok(await api.post('/api/notizen/aufloesen', { namen: ['Zellkern', 'Nucleus'] }), 'aufloesen').aufgeloest;
    assert.equal(auf.Zellkern.id, b.id, 'die Ansicht sagt dasselbe wie das Netz');
    assert.equal(auf.Nucleus.id, a.id);
    const v = ok(await api.get(`/api/records/${lern.id}/verknuepft`), 'verknuepft');
    assert.deepEqual(v.ausgehend.map((z) => z.id), [b.id], '"Verknüpft mit" zeigt die Verbindung');

    // Auch B umbenannt: der Titel ist frei, der Link ehrlich offen.
    ok(await api.patch(`/api/records/${b.id}`, { data: { title: 'Kern' }, rev: store.get(b.id).rev }), 'B umbenennen');
    await bis(() => linkZiele(store, lern.id).length === 0, 'keine Kante mehr');
    assert.equal(ok(await api.post('/api/notizen/aufloesen', { namen: ['Zellkern'] }), 'frei').aufgeloest.Zellkern, null);
    // Und zurueck: A heisst wieder "Zellkern".
    ok(await api.patch(`/api/records/${a.id}`, { data: { title: 'Zellkern' }, rev: store.get(a.id).rev }), 'A zurueck');
    await bis(() => linkZiele(store, lern.id).join() === a.id, 'Kante zu A');
  });
});

test('5: zwei Notizen "Zellkern", die aeltere wird geloescht -- [[Zellkern]] verbindet sofort mit der zweiten, in Ansicht UND Netz; Wiederherstellen dreht es zurueck', async () => {
  await withApp(async ({ api, store }) => {
    const mk = async (title, body) => ok(await api.post('/api/records', { type: 'note', data: { title, body } }), title).record;
    const a = await mk('Zellkern', 'erste');
    await warte(5);
    const b = await mk('Zellkern', 'zweite');
    await warte(5);
    const lern = await mk('Lernplan', 'Siehe [[Zellkern]].');
    await bis(() => linkZiele(store, lern.id).join() === a.id, 'Kante vorher zur aelteren');

    const weg = await api.del(`/api/records/${a.id}`);
    assert.equal(weg.status, 200, weg.text);
    // Ohne dass jemand den Lernplan neu speichert.
    await bis(() => linkZiele(store, lern.id).join() === b.id, 'Kante zur zweiten Notiz');
    const auf = ok(await api.post('/api/notizen/aufloesen', { namen: ['Zellkern'] }), 'aufloesen').aufgeloest;
    assert.equal(auf.Zellkern.id, b.id, 'die Ansicht sagt dasselbe wie das Netz');
    const v = ok(await api.get(`/api/records/${lern.id}/verknuepft`), 'verknuepft');
    assert.deepEqual(v.ausgehend.map((z) => z.id), [b.id], '"Verknüpft mit" zeigt die Verbindung');

    // Rueckgaengig: die aeltere ist wieder da und traegt den Titel wieder.
    store.restore(a.id);
    await bis(() => linkZiele(store, lern.id).join() === a.id, 'Kante wieder zur aelteren');
    // Endgueltig geloescht (ohne Grabstein) gilt dasselbe.
    store.remove(a.id, { hard: true });
    await bis(() => linkZiele(store, lern.id).join() === b.id, 'Kante zur zweiten nach dem endgueltigen Loeschen');
  });
});

test('5: das gepflegte Titelverzeichnis sagt nach jedem Schritt dasselbe wie ein frisch gebautes (Zufallsfolge)', async () => {
  const derive = require('../src/graph/derive');
  await withApp(async ({ store }) => {
    const TITEL = ['Zellkern', 'zellkern', 'Nucleus', 'Kern', 'Lernplan', 'Zahnarzt'];
    const TYPEN = ['note', 'event', 'project', 'entity'];
    const lebend = [];
    let saat = 11;
    const zufall = (n) => { saat = (saat * 1103515245 + 12345) % 2147483648; return saat % n; };
    const daten = (type, titel) => {
      if (type === 'project' || type === 'entity') return { name: titel, ...(type === 'entity' ? { kind: 'topic' } : {}) };
      if (type === 'event') return { title: titel, start: '2026-10-05T10:00' };
      return { title: titel, body: '' };
    };
    for (let schritt = 0; schritt < 160; schritt++) {
      const was = zufall(10);
      if (was < 4 || !lebend.length) {
        const type = TYPEN[zufall(TYPEN.length)];
        lebend.push(store.create(type, daten(type, TITEL[zufall(TITEL.length)])).id);
      } else if (was < 7) {
        const id = lebend[zufall(lebend.length)];
        const rec = store.get(id);
        const titel = TITEL[zufall(TITEL.length)];
        store.update(id, rec.type === 'project' || rec.type === 'entity' ? { name: titel } : { title: titel });
      } else if (was < 9) {
        const id = lebend.splice(zufall(lebend.length), 1)[0];
        store.remove(id);
        if (zufall(2)) { store.restore(id); lebend.push(id); }
      } else {
        derive.scanAll(store);
      }
      const frisch = derive.buildIndex(store).byTitle;
      for (const t of TITEL) {
        const soll = frisch.get(derive.indexKey(t)) || null;
        assert.equal(derive.resolveLink(store, t), soll, `Schritt ${schritt}: [[${t}]]`);
      }
    }
  });
});

/* ------------------------------------- 8: Link-Zwischenspeicher */

test('8: aufloesungVeraltet -- Wiederherstellen und Umbenennen loesen Links neu, eine Textaenderung nicht', async () => {
  const { aufloesungVeraltet } = (await laden()).notes;
  assert.equal(aufloesungVeraltet('record.created', { id: 'x' }), true);
  assert.equal(aufloesungVeraltet('record.deleted', { id: 'x' }), true);
  assert.equal(aufloesungVeraltet('record.updated', { restored: true }), true);
  assert.equal(aufloesungVeraltet('record.updated', { patch: { title: 'Neu' }, before: { title: 'Alt' } }), true);
  assert.equal(aufloesungVeraltet('record.updated', { patch: { aliases: ['k8s'] }, before: { aliases: [] } }), true);
  assert.equal(aufloesungVeraltet('record.updated', { patch: { title: 'Gleich', body: 'x' }, before: { title: 'Gleich', body: 'y' } }), false);
  assert.equal(aufloesungVeraltet('record.updated', { patch: { body: 'x' }, before: { body: 'y' } }), false);
  assert.equal(aufloesungVeraltet('record.updated', null), false);

  // Und so kommt "Rueckgaengig" nach dem Loeschen wirklich an.
  await withApp(async ({ api, bus }) => {
    const kern = ok(await api.post('/api/records', { type: 'note', data: { title: 'Zellkern', body: '' } }), 'kern').record;
    ok(await api.del(`/api/records/${kern.id}`), 'loeschen');
    const gesehen = [];
    const mitschreiben = (evt) => gesehen.push(evt.payload);
    bus.on('record.updated', mitschreiben);
    ok(await api.post(`/api/records/${kern.id}/restore`), 'wiederherstellen');
    bus.off('record.updated', mitschreiben);
    const p = gesehen.find((x) => x.id === kern.id);
    assert.ok(p, 'record.updated kam');
    assert.equal(aufloesungVeraltet('record.updated', p), true);
  });
});

/* ------------------------------------------------ 9: Link-Ziele */

test('9: eine Schluesselregel fuer Ansicht, Aufloesung und Ableitung', async () => {
  const { titelSchluessel, linkSchluessel, abschnittName } = (await laden()).notes;
  const derive = require('../src/graph/derive');
  for (const s of ['Projekt  Alpha', ' Projekt\tAlpha ', 'Überblick Ökosystem', 'Straße', 'Ålesund æøœ', 'Rechnung [bezahlt]', 'Ein|Aus', 'Café', 'C#-Kurs', '#1 Liste', '🍕 Pizza', '']) {
    assert.equal(titelSchluessel(s), derive.indexKey(s), JSON.stringify(s));
  }
  for (const s of ['Zellatmung#Ablauf', 'Foo #bar', 'C#', 'C#-Kurs', 'C#.NET', '#1 Liste', 'Notiz#H1#H2', 'Q#A', 'Zellatmung# ', 'x']) {
    assert.deepEqual(linkSchluessel(s), derive.linkKeys(s), JSON.stringify(s));
  }
  assert.equal(abschnittName('Zellatmung#Ablauf'), 'Zellatmung');
  assert.equal(abschnittName('Notiz#H1#H2'), 'Notiz');
  assert.equal(abschnittName('C#'), null);
  assert.equal(abschnittName('C#-Kurs'), null, '"#-" ist kein Abschnitt');
  assert.equal(abschnittName('#1 Liste'), null);
  assert.deepEqual(derive.linkKeys('Zellatmung#Ablauf'), ['zellatmung#ablauf', 'zellatmung'], 'erst der ganze Text, dann der Name');
});

test('9: [[Projekt  Alpha]], [[Zellatmung#Ablauf]] und Titel mit [ ] | aus der "[["-Liste verbinden -- und die Ansicht zeigt genau das', async () => {
  const { editor, markdown } = await laden();
  await withApp(async ({ api, store }) => {
    const ziele = {};
    for (const t of ['Projekt  Alpha', 'Rechnung [bezahlt]', 'Ein|Aus', 'Zellatmung', 'C#-Kurs', 'C#']) {
      ziele[t] = ok(await api.post('/api/records', { type: 'note', data: { title: t, body: 'Ziel' } }), t).record.id;
    }
    // So setzt die Liste hinter "[[" die Titel ein:
    let body = '';
    for (const t of ['Projekt  Alpha', 'Rechnung [bezahlt]', 'Ein|Aus', 'C#-Kurs', 'C#']) {
      const vorher = `${body}- [[${t.slice(0, 3)}`;
      body = `${editor.applyCompletion(vorher, editor.completionContext(vorher, vorher.length), t).value}\n`;
    }
    assert.match(body, /\[\[Rechnung bezahlt\]\]/);
    assert.match(body, /\[\[Ein Aus\]\]/);
    assert.match(body, /\[\[Projekt Alpha\]\]/);
    body += '- [[Zellatmung#Ablauf]] (Obsidian)\n- [[Projekt  Alpha|mit zwei Leerzeichen]]\n';
    const quelle = ok(await api.post('/api/records', { type: 'note', data: { title: 'Sammlung', body } }), 'quelle').record;
    await bis(() => linkZiele(store, quelle.id).length === 6, 'sechs Kanten', 3000);
    assert.deepEqual(linkZiele(store, quelle.id), Object.values(ziele).sort());

    // Die Ansicht fragt nach genau den Namen, die ihr Renderer liest -- und bekommt dieselben Ziele.
    const namen = markdown.extractLinks(body).wikiLinks;
    assert.deepEqual(namen, derive().extractLinks(body).wikiLinks, 'Renderer und Ableitung lesen dieselben Ziele');
    const auf = ok(await api.post('/api/notizen/aufloesen', { namen }), 'aufloesen').aufgeloest;
    for (const name of namen) assert.ok(auf[name] && Object.values(ziele).includes(auf[name].id), `${name} aufgeloest`);
    assert.equal(auf['Zellatmung#Ablauf'].id, ziele.Zellatmung);
    assert.equal(auf['C#'].id, ziele['C#'], '"C#" bleibt ein Titel');

    // Ein Link auf einen Abschnitt, dessen Notiz erst danach entsteht: das Nachziehen findet ihn.
    const spaet = ok(await api.post('/api/records', { type: 'note', data: { title: 'Plan', body: 'Erst [[Glykolyse#Schritte]].' } }), 'plan').record;
    const glyk = ok(await api.post('/api/records', { type: 'note', data: { title: 'Glykolyse', body: '' } }), 'glykolyse').record;
    await bis(() => linkZiele(store, spaet.id).join() === glyk.id, 'nachgezogen');
  });
  // Ein Titel mit [ oder ] ist auch beim Lesen kein Link -- wie in der Ableitung.
  assert.deepEqual(markdown.extractLinks('Siehe [[Rechnung [bezahlt]]]').wikiLinks, []);
  assert.deepEqual(derive().extractLinks('Siehe [[Rechnung [bezahlt]]]').wikiLinks, []);
  assert.equal(editor.linkText('  Ein|Aus [x]  '), 'Ein Aus x');
});

function derive() {
  return require('../src/graph/derive');
}

/* ------------------------------------ 10, 11: Laeufe, Herkunft */

test('10: eine Notiz der KI aus dem Chat -- "Verknüpft mit" zeigt den Chat, keinen rohen "run"', async () => {
  const { artInfo, kantenText, ohneLaeufe } = (await laden()).notes;
  assert.deepEqual(artInfo('run'), { label: 'Lauf', glyph: 'agent' });
  await withApp(async ({ api, store, app }) => {
    const { createWerkzeuge } = require('../src/models/werkzeuge');
    const chat = ok(await api.post('/api/records', { type: 'chat', data: { title: 'Zahnarzt morgen' } }), 'chat').record;
    const w = createWerkzeuge({ store, bus: app.bus });
    const r = w.ausfuehren({ id: 'toolu_1', name: 'notiz_anlegen', input: { titel: 'Zahnarzt: Fragen', text: 'Weisheitszahn?' } }, undefined, { chatId: chat.id });
    await warte(50);
    const v = ok(await api.get(`/api/records/${r.produced[0]}/verknuepft`), 'verknuepft');
    const zeilen = [...ohneLaeufe(v.ausgehend), ...ohneLaeufe(v.eingehend)];
    assert.ok(zeilen.every((z) => z.type !== 'run'));
    const texte = zeilen.map((z) => `${z.title} · ${artInfo(z.type, z.entityKind).label} · ${kantenText(z)}`);
    assert.deepEqual(texte, ['Zahnarzt morgen · Chat · Erwähnung · Notiz stammt aus diesem Chat']);
  });
});

test('11: eine Notiz, die nicht auf der Wand steht, hat im Blatt dieselbe Herkunft wie auf der Wand', async () => {
  const { originLabel } = (await laden()).notes;
  await withApp(async ({ api, store }) => {
    const imp = ok(await api.post('/api/notizen/import', { dateien: [{ name: 'Vault/Alt importiert.md', text: 'aus Obsidian' }] }), 'import').ids[0];
    const ag = store.create('note', { title: 'Vom Agenten', body: 'Bericht', source: 'agent' });
    const hand = store.create('note', { title: 'Von Hand', body: '' });
    const chat = store.create('chat', { title: 'Weg' });
    const ausWeg = store.create('note', { title: 'Aus einem geloeschten Chat', body: '', source: 'auto', chatId: chat.id });
    store.remove(chat.id);
    const ohneChat = store.create('note', { title: 'Automatisch', body: '', source: 'auto' });
    const projekt = store.create('project', { name: 'Umzug' });
    const imProjekt = store.create('note', { title: 'Kartons', body: '', projectId: projekt.id });

    const wand = ok(await api.get('/api/notizen?limit=2000'), 'wand').items;
    for (const id of [imp, ag.id, hand.id, ausWeg.id, ohneChat.id, imProjekt.id]) {
      const einzeln = ok(await api.get(`/api/notizen/auswahl?id=${id}`), id).items[0];
      const dort = wand.find((n) => n.id === id);
      assert.deepEqual(einzeln.herkunft, dort.herkunft, `Herkunft ${id}`);
      assert.deepEqual(einzeln.projekt, dort.projekt, `Projekt ${id}`);
      assert.equal(einzeln.rev, dort.rev);
    }
    const blatt = async (id) => originLabel(ok(await api.get(`/api/notizen/auswahl?id=${id}`), 'blatt').items[0].herkunft);
    assert.equal(await blatt(imp), 'importiert');
    assert.equal(await blatt(ag.id), 'von einem Agenten');
    assert.equal(await blatt(ausWeg.id), 'aus einem gelöschten Chat „Weg“');
    // Ebenso die Auswahl der Wand (Befund 1) -- auch sie ist in derselben Form.
    const alle = ok(await api.get('/api/notizen/auswahl'), 'auswahl alle').items;
    for (const n of alle) assert.deepEqual(n.herkunft, wand.find((x) => x.id === n.id).herkunft);

    assert.equal((await api.get('/api/notizen/auswahl?id=note_gibtesnicht000000000000')).status, 404);
    assert.equal((await api.get(`/api/notizen/auswahl?id=${projekt.id}`)).status, 404, 'ein Projekt ist keine Notiz');
  });
});

/* ------------------------------------------------- 12: Bilder */

test('12: ein eingefuegtes Bild ist mit seiner Notiz verbunden -- und nur, solange es im Text steht', async () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await withApp(async ({ api, store }) => {
    const up = ok(await api.post('/api/notizen/dateien', { name: 'image.png', mime: 'image/png', daten: PNG }), 'upload');
    const note = ok(await api.post('/api/records', { type: 'note', data: { title: 'Pflanze', body: `Foto vom Balkon:\n\n${up.markdown}` } }), 'notiz').record;
    await bis(() => linkZiele(store, note.id).includes(up.record.id), 'Kante zum Bild');
    const kante = store.edges.for(note.id, { direction: 'out' }).find((e) => e.data.to === up.record.id);
    assert.equal(kante.data.kind, 'links-to');
    assert.equal(kante.data.reason, 'Bild im Text');
    const v = ok(await api.get(`/api/records/${note.id}/verknuepft`), 'verknuepft');
    assert.deepEqual(v.ausgehend.map((z) => [z.type, z.title]), [['file', 'image.png']]);

    // Das Bild nur noch als Beispiel im Code: keine Kante.
    const rec = store.get(note.id);
    ok(await api.patch(`/api/records/${note.id}`, { data: { body: `Beispiel:\n\n\`${up.markdown}\`` }, rev: rec.rev }), 'nur Code');
    await bis(() => !linkZiele(store, note.id).includes(up.record.id), 'Kante weg');
  });
  assert.deepEqual(derive().fileRefs('![a](/api/notizen/dateien/file_abc) und ![b](/api/notizen/dateien/file_abc) [c](/api/notizen/dateien/file_x9)'), ['file_abc', 'file_x9']);
  assert.deepEqual(derive().fileRefs('```\n![a](/api/notizen/dateien/file_abc)\n```'), []);
});

/* --------------------------------------------------- 13: 404 */

test('13: "… not found" erscheint in der Notizansicht nicht -- und Speichern einer anderswo geloeschten Notiz ist ein 404', async () => {
  const { errorText } = (await laden()).notes;
  assert.equal(errorText({ status: 404, code: 'NOT_FOUND', message: 'Eintrag note_6emx not found' }), 'Diesen Eintrag gibt es nicht mehr.');
  assert.equal(errorText({ code: 'NOT_FOUND', message: 'Record x not found' }), 'Diesen Eintrag gibt es nicht mehr.');
  assert.equal(errorText({ status: 500, message: 'Der Speicher ist voll.' }), 'Der Speicher ist voll.');
  assert.equal(errorText(null), 'Unbekannter Fehler.');
  await withApp(async ({ api }) => {
    const n = ok(await api.post('/api/records', { type: 'note', data: { title: 'Gleich weg', body: '' } }), 'notiz').record;
    ok(await api.del(`/api/records/${n.id}`), 'loeschen');
    const res = await api.patch(`/api/records/${n.id}`, { data: { title: 'Gleich weg', body: 'mein Text' }, rev: n.rev });
    assert.equal(res.status, 404, 'darauf reagiert der Editor mit "Als neue Notiz speichern"');
  });
});
