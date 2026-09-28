'use strict';

/**
 * Runde 1 der Pruefer (28.09.2026): die Befunde am Wissens-Unterbau, jeder
 * als Test, der VOR der Nachbesserung rot war. Alles gegen die echte Engine
 * mit Bus, verdrahtet wie in src/app.js (erst die Ableitung, dann das
 * Universum); die HTTP-Faelle durch die echte Tuer.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { test, tempHome, waitForEvent } = require('./harness');

const { openStore } = require('../src/store/engine');
const { Bus } = require('../src/kernel/bus');
const derive = require('../src/graph/derive');
const uni = require('../src/graph/universum');

/** Ein Durchgang der Ereignisschleife: danach ist das Nachziehen gelaufen. */
const naechsterDurchgang = () => new Promise((r) => setImmediate(r));

async function offen(label, opts = {}) {
  const { home, cleanup } = tempHome(label);
  const bus = new Bus();
  const store = await openStore({ paths: path.join(home, 'nos'), bus, lock: false });
  const rederive = (evt) => {
    const r = evt.payload.record;
    if (r && r.type !== 'edge') derive.deriveFor(store, r);
  };
  bus.on('record.created', rederive);
  bus.on('record.updated', rederive);
  const anbindung = uni.attach({ store, bus, verzoegerungMs: { neu: 5, aenderung: 5 }, istAusgesetzt: opts.istAusgesetzt });
  return {
    store,
    bus,
    anbindung,
    async close() {
      anbindung.detach();
      await store.close();
      cleanup();
    },
  };
}

const fest = (type, n) => `${type}_${String(n).padStart(24, '0')}`;
const themenVon0 = (store) => uni.ebene0(uni.universum(store).u).themen;

/* ------------------------------------------------ Schlagworte im Text */

test('#Schlagworte im Text (so schreibt sie der Editor) bilden Themen -- eine Quelle fuer Wand und Gehirn', async () => {
  const h = await offen('r1-tags');
  try {
    for (const t of ['Mitose', 'Meiose', 'DNA']) h.store.create('note', { title: t, body: `${t} gehoert zur Zellbiologie. #biologie`, tags: [] });
    h.store.create('note', { title: 'Mendel', body: 'Erbsen und Regeln #biologie #genetik', tags: [] });
    h.store.create('note', { title: 'Vererbung', body: 'Dominant und rezessiv #Genetik #biologie', tags: [] });
    const themen = themenVon0(h.store);
    const bio = themen.find((t) => t.id === 'thema:biologie');
    assert.ok(bio, `kein Thema Biologie: ${themen.map((t) => t.id).join(', ')}`);
    assert.equal(bio.anzahl, 5, 'Genetik liegt als Kind in Biologie, alle fuenf zaehlen');
    const e1 = uni.ebene1(uni.universum(h.store).u, 'thema:genetik');
    assert.equal(e1.thema.name, 'Genetik');
    assert.deepEqual(e1.knoten.filter((k) => !k.ausserhalb).map((k) => k.label).sort(), ['Mendel', 'Vererbung']);
    // Die Knoten tragen ihre Schlagworte (fuer die Karte im Gehirn).
    assert.ok(e1.knoten.find((k) => k.label === 'Mendel').tags.includes('genetik'));
    // Ein Schlagwort, das aus dem Text verschwindet, verschwindet auch aus dem Thema.
    const mendel = h.store.list('note', {}).items.find((n) => n.data.title === 'Mendel');
    h.store.update(mendel.id, { body: 'Erbsen und Regeln #biologie' });
    const e1b = uni.ebene1(uni.universum(h.store).u, 'thema:genetik');
    assert.deepEqual(e1b.knoten.filter((k) => !k.ausserhalb).map((k) => k.label), ['Vererbung']);
  } finally {
    await h.close();
  }
});

test('Themenname: die haeufigste Schreibweise, nicht die des Knotens mit der kleinsten ID', async () => {
  const h = await offen('r1-name');
  try {
    h.store.create('note', { title: 'a', body: 'x', tags: ['Genetik'] }, { id: fest('note', 3) });
    h.store.create('note', { title: 'b', body: 'x', tags: ['genetik'] }, { id: fest('note', 2) });
    h.store.create('note', { title: 'c', body: 'x', tags: ['GENETIK'] }, { id: fest('note', 1) });
    assert.deepEqual(themenVon0(h.store).map((t) => t.name), ['Genetik']);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------ Vorschlaege */

test('Vorschlaege: Fuellwoerter und ein geteiltes Schlagwort allein verbinden nicht -- der Photosynthese-Fall bleibt', async () => {
  const h = await offen('r1-vorschlaege');
  try {
    const s = h.store;
    // Sechs unverwandte Notizen, vier davon mit "morgen" (Pruefer: 4 Vorschlaege aus einem Wort).
    const zahnarzt = s.create('note', { title: 'Zahnarzt', body: 'Morgen um 10 zum Zahnarzt.' });
    s.create('note', { title: 'Geburtstag Oma', body: 'Morgen Blumen kaufen.' });
    s.create('note', { title: 'Fahrrad', body: 'Morgen Reifen flicken.' });
    s.create('note', { title: 'Kuchenrezept', body: 'Mehl, Eier. Morgen backen.' });
    s.create('note', { title: 'Urlaub', body: 'Koffer packen.' });
    assert.deepEqual(uni.vorschlaegeFuer(s, zahnarzt.id).map((v) => v.title), [], 'ein Alltagswort ist kein Grund');

    // "Alles" und ein geteiltes #schule (Schule -> Waesche, Photosynthese -> Erster Weltkrieg).
    const schule = s.create('note', { title: 'Schule', body: 'Alles rund um den Unterricht.', tags: ['schule'] });
    s.create('note', { title: 'Wäsche', body: 'Alles bei 40 Grad waschen.' });
    const weltkrieg = s.create('note', { title: 'Erster Weltkrieg', body: '1914 bis 1918, Stellungskrieg.', tags: ['schule', 'geschichte'] });
    assert.deepEqual(uni.vorschlaegeFuer(s, schule.id).map((v) => v.title), []);

    // Ein Verb, das beide teilen, traegt nicht ("bestellen"); ein Name schon ("Jonas").
    const a = s.create('note', { title: 'Waveguide-Muster bestellen', body: 'Beim Hersteller anfragen.' });
    s.create('note', { title: 'Wasserfilter bestellen', body: 'Zwei Kartuschen.' });
    assert.deepEqual(uni.vorschlaegeFuer(s, a.id).map((v) => v.title), []);
    const jonas = s.create('entity', { name: 'Jonas', kind: 'person' });
    const telefonat = s.create('note', { title: 'Telefonat mit Jonas', body: 'Er baut den Prototyp.' });
    assert.ok(uni.vorschlaegeFuer(s, telefonat.id).some((v) => v.id === jonas.id), 'der Name des Gegenuebers traegt');

    // Die Vision: "Pflanzen brauchen Licht" <-> "Chlorophyll absorbiert Licht".
    const foto = s.create('note', { title: 'Photosynthese', body: 'Pflanzen wandeln Licht in Zucker um. Chlorophyll im Blatt absorbiert Licht.', tags: ['schule', 'biologie'] });
    const pflanzen = s.create('note', { title: 'Pflanzen brauchen Licht', body: 'Ohne Licht kein Wachstum.' });
    const chloro = s.create('note', { title: 'Chlorophyll absorbiert Licht', body: 'Rotes und blaues Licht.' });
    const v = uni.vorschlaegeFuer(s, chloro.id);
    assert.deepEqual(v.map((x) => x.id).sort(), [foto.id, pflanzen.id].sort(), v.map((x) => `${x.title}: ${x.grund}`).join(' | '));
    assert.equal(v[0].id, foto.id, 'wer mehr teilt, steht vorn');
    assert.equal(v.find((x) => x.id === pflanzen.id).grund, '1 gemeinsamer Begriff: Licht');
    assert.ok(!uni.vorschlaegeFuer(s, foto.id).some((x) => x.id === weltkrieg.id), 'nur #schule verbindet Photosynthese nicht mit dem Ersten Weltkrieg');
  } finally {
    await h.close();
  }
});

/* ------------------------------------------- spaete Links, Umbenennen */

test('[[Link]] auf eine Notiz, die erst danach entsteht, verbindet sofort; Umbenennen laesst Text und Netz nicht auseinanderlaufen', async () => {
  const h = await offen('r1-spaet');
  try {
    const s = h.store;
    const lern = s.create('note', { title: 'Lernplan', body: 'Morgen: [[Lichtreaktion]] und [[Calvin-Zyklus]] wiederholen.' });
    const warte = waitForEvent(h.bus, 'graph.kante');
    const licht = s.create('note', { title: 'Lichtreaktion', body: 'Im Thylakoid.' });
    const evt = await warte;
    assert.equal(evt.payload.edge.data.from, lern.id);
    assert.equal(evt.payload.edge.data.to, licht.id);
    const calvin = s.create('entity', { name: 'Calvin-Zyklus', kind: 'term' });
    await naechsterDurchgang(); // das Nachziehen laeuft nach dem Schreibvorgang
    const raus = s.edges.for(lern.id, { direction: 'out' }).map((e) => [e.data.to, e.data.kind]);
    assert.deepEqual(raus.sort(), [[licht.id, 'links-to'], [calvin.id, 'links-to']].sort());

    const kern = s.create('note', { title: 'Zellkern', body: 'Enthaelt die DNA.' });
    const aufbau = s.create('note', { title: 'Zelle Aufbau', body: 'Wichtig: [[Zellkern]].' });
    assert.equal(s.edges.for(aufbau.id, { direction: 'out' }).filter((e) => e.data.to === kern.id).length, 1);
    s.update(kern.id, { title: 'Nucleus' });
    await naechsterDurchgang();
    assert.equal(s.edges.for(aufbau.id, { direction: 'out' }).filter((e) => e.data.to === kern.id).length, 0,
      '[[Zellkern]] zeigt nach dem Umbenennen ins Leere -- dann auch keine Kante');
    const neu = s.create('note', { title: 'Organellen', body: 'Der [[Nucleus]] steuert.' });
    assert.equal(s.edges.for(neu.id, { direction: 'out' }).filter((e) => e.data.to === kern.id).length, 1);
    s.update(kern.id, { title: 'Zellkern' });
    await naechsterDurchgang();
    assert.equal(s.edges.for(aufbau.id, { direction: 'out' }).filter((e) => e.data.to === kern.id).length, 1, 'zurueck umbenannt: der alte Link greift wieder');
  } finally {
    await h.close();
  }
});

test('Nachziehen mitten im Schreiben zoege Dubletten: wer die Kante im selben Zug selbst anlegt (Startinhalte, Abgleich), behaelt seine', async () => {
  // So saet src/app.js die Startinhalte: erst die Quelle, dann das Ziel,
  // dann die Kante mit fester ID -- alles in einem Zug. Nachziehen darf
  // dazwischen keine zweite Kante mit zufaelliger ID ziehen.
  const h = await offen('r1-feste-kante');
  try {
    const s = h.store;
    const quelle = s.create('note', { title: 'Willkommen', body: 'Siehe [[Claude verbinden]].' }, { id: 'note_start00000000000000willk' });
    const ziel = s.create('note', { title: 'Claude verbinden', body: 'Schluessel holen.' }, { id: 'note_start00000000000000claud' });
    s.create('edge', { from: quelle.id, to: ziel.id, kind: 'links-to', source: 'derived', reason: 'Wiki-Link [[Claude verbinden]] im Text', weight: 1 }, { id: 'edge_start000000000willkclaud' });
    await naechsterDurchgang();
    const kanten = s.edges.for(quelle.id, { direction: 'out' }).filter((e) => e.data.to === ziel.id);
    assert.deepEqual(kanten.map((e) => e.id), ['edge_start000000000willkclaud'], 'genau die feste Kante, keine Dublette');
  } finally {
    await h.close();
  }
});

test('Notizen, die die KI aus einem Chat macht, haengen am Chat; eine Notiz mit projectId an ihrem Projekt', async () => {
  const h = await offen('r1-chat');
  try {
    const chat = h.store.create('chat', { title: 'Woche planen' });
    const projekt = h.store.create('project', { name: 'Referat' });
    const n = h.store.create('note', { title: 'Zahnarzt: Fragen', body: 'Was fragen?', chatId: chat.id, projectId: projekt.id, source: 'auto' });
    const raus = h.store.edges.for(n.id, { direction: 'out' }).map((e) => [e.data.to, e.data.kind]).sort();
    assert.deepEqual(raus, [[chat.id, 'mentions'], [projekt.id, 'belongs-to']].sort());
  } finally {
    await h.close();
  }
});

test('[[Link]] auf einen Titel mit 500 Zeichen (so lang darf er sein) verbindet', async () => {
  const h = await offen('r1-lang');
  try {
    const titel = `${'Sehr langer Titel '.repeat(27)}Ende`.padEnd(499, '.').concat('!');
    assert.equal(titel.length, 500);
    const ziel = h.store.create('note', { title: titel, body: 'x' });
    const quelle = h.store.create('note', { title: 'Quelle', body: `Siehe [[${titel}]].` });
    assert.equal(h.store.edges.for(quelle.id, { direction: 'out' }).filter((e) => e.data.to === ziel.id).length, 1);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------ Zeitgeber, Ereignisse */

test('Viele einzeln geschriebene Saetze (Abgleich, Agent) blockieren den Server nicht: eine Warteschlange mit Zeitbudget', async () => {
  const h = await offen('r1-flut');
  try {
    for (let i = 0; i < 1500; i++) {
      h.store.create('note', { title: `Flut ${i}`, body: `Licht und Pflanzen und Wasser, Nummer ${i % 40}. Merkmal Ton${i % 30}.` });
    }
    assert.ok(h.anbindung.ausstehend <= uni.MAX_WARTESCHLANGE, `${h.anbindung.ausstehend} warten`);
    assert.ok(h.anbindung.verworfen >= 1500 - uni.MAX_WARTESCHLANGE);
    // Die Ereignisschleife bleibt frei: kein einzelner Durchgang dauert lange.
    let laengste = 0;
    let letzte = Date.now();
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        const jetzt = Date.now();
        laengste = Math.max(laengste, jetzt - letzte);
        letzte = jetzt;
        if (h.anbindung.ausstehend === 0) { clearInterval(iv); resolve(); }
      }, 2);
    });
    assert.ok(laengste < 250, `die Ereignisschleife stand ${laengste} ms still`);
  } finally {
    await h.close();
  }
});

test('graph.kante nur zwischen Wissen: eine Chat-Nachricht erscheint nicht als Knoten und laesst den Cache stehen', async () => {
  const h = await offen('r1-nachricht');
  try {
    const projekt = h.store.create('project', { name: 'Referat' });
    const chat = h.store.create('chat', { title: 'Referat planen', projectId: projekt.id });
    uni.universum(h.store);
    assert.equal(uni.universum(h.store).ausCache, true);
    const gemeldet = [];
    h.bus.on('graph.kante', (evt) => gemeldet.push(evt.payload));
    h.store.create('message', { chatId: chat.id, role: 'assistant', content: 'Gern!' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(gemeldet, [], 'die Kante Nachricht -> Chat ist kein Wissen');
    assert.equal(uni.universum(h.store).ausCache, true, 'eine Nachricht laesst das Universum stehen');
    // Und verbinden nimmt nur Wissen.
    const kante = h.store.list('edge', {}).items.find((e) => e.data.kind === 'belongs-to');
    assert.throws(() => uni.verbinden(h.store, projekt.id, [kante.id]), /kein Eintrag, der sich verbinden/);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------- Farben, Art */

test('Farben bleiben, wenn ein Thema ein anderes ueberholt; Unverbunden und Weitere Themen sind neutral', async () => {
  const h = await offen('r1-farben');
  try {
    const mk = (tag, n) => { for (let i = 0; i < n; i++) h.store.create('note', { title: `${tag} ${i}`, body: 'x', tags: [tag] }); };
    mk('biologie', 5); mk('geschichte', 4); mk('mathe', 3);
    h.store.create('note', { title: 'Allein', body: 'nichts' });
    const vorher = Object.fromEntries(themenVon0(h.store).map((t) => [t.id, t.farbe]));
    mk('geschichte', 3);
    const nachher = Object.fromEntries(themenVon0(h.store).map((t) => [t.id, t.farbe]));
    for (const id of ['thema:biologie', 'thema:geschichte', 'thema:mathe']) assert.equal(nachher[id], vorher[id], `${id} hat die Farbe gewechselt`);
    assert.equal(new Set([vorher['thema:biologie'], vorher['thema:geschichte'], vorher['thema:mathe']]).size, 3, 'drei Themen, drei Toene');
    assert.equal(nachher[uni.UNVERBUNDEN], uni.FARBE_NEUTRAL);
    // Viele Themen: der Behaelter "Weitere" ist grau, seine Kinder haben eigene Farben.
    for (let i = 0; i < 45; i++) mk(`fach${i}`, 2);
    const themen = themenVon0(h.store);
    const weitere = themen.find((t) => t.id === uni.WEITERE);
    assert.ok(weitere);
    assert.equal(weitere.farbe, uni.FARBE_NEUTRAL);
    assert.ok(weitere.kinder.some((k) => k.farbe !== uni.FARBE_NEUTRAL));
  } finally {
    await h.close();
  }
});

test('Ebene 1 nennt die Art jedes Begriffs (Person, Ort) und das Projekt einer Aufgabe', async () => {
  const h = await offen('r1-art');
  try {
    const p = h.store.create('project', { name: 'Referat' });
    h.store.create('entity', { name: 'Frau Dr. Keller', kind: 'person', description: 'Lehrerin im [[Referat]]' });
    h.store.create('entity', { name: 'Berlin', kind: 'place', description: 'Ort vom [[Referat]]' });
    const task = h.store.create('task', { title: 'Folien bauen', projectId: p.id });
    const e1 = uni.ebene1(uni.universum(h.store).u, `projekt:${p.id}`);
    const art = Object.fromEntries(e1.knoten.map((k) => [k.label, k.kind]));
    assert.equal(art['Frau Dr. Keller'], 'person');
    assert.equal(art.Berlin, 'place');
    assert.equal(e1.knoten.find((k) => k.id === task.id).projectId, p.id);
  } finally {
    await h.close();
  }
});

test('Zahlen: eine Linie ist ein Paar -- Wiki-Link und Schlagwort zwischen denselben Notizen zaehlen einmal', async () => {
  const h = await offen('r1-zahlen');
  try {
    h.store.create('entity', { name: 'Biologie', kind: 'topic' });
    const a = h.store.create('note', { title: 'Zellen', body: 'Siehe [[Biologie]].', tags: ['biologie'] });
    h.store.create('note', { title: 'DNA', body: 'Siehe [[Zellen]].', tags: ['biologie'] });
    const t = themenVon0(h.store).find((x) => x.id === 'thema:biologie');
    // Zellen -> Biologie (Link + Schlagwort = 1 Paar), DNA -> Biologie (Schlagwort), DNA -> Zellen (Link).
    assert.equal(t.kanten, 3);
    void a;
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------- HTTP */

function request(base, method, urlPath, body, kopf = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        ...kopf,
      },
      timeout: 8000,
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
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath}: keine Antwort`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withApp(fn) {
  const { createApp } = require('../src/app');
  const { home, cleanup } = tempHome('nos-r1-http');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    return await fn({ app, base, api: (m, p, b, k) => request(base, m, p, b, k) });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
}

test('PATCH mit rev: gleichzeitiges Bearbeiten verliert nichts still (409 KONFLIKT mit dem aktuellen Stand)', async () => {
  await withApp(async ({ api }) => {
    const neu = await api('POST', '/api/records', { type: 'note', data: { title: 'Einkauf', body: 'Milch\nBrot' } });
    const rec = neu.json.record;
    // Das iPad speichert zuerst ...
    const ipad = await api('PATCH', `/api/records/${rec.id}`, { data: { body: 'Milch\nBrot\nEier (vom iPad)' }, rev: rec.rev });
    assert.equal(ipad.status, 200);
    // ... dann der Rechner, der noch den alten Stand im Editor hat.
    const alt = await api('PATCH', `/api/records/${rec.id}`, { data: { title: 'Einkauf', body: 'Milch\nBrot\nKaese' }, rev: rec.rev });
    assert.equal(alt.status, 409, alt.text);
    assert.equal(alt.json.error.code, 'KONFLIKT');
    assert.equal(alt.json.error.details.aktuell, rec.rev + 1);
    assert.equal(alt.json.error.details.record.data.body, 'Milch\nBrot\nEier (vom iPad)');
    const stand = await api('GET', `/api/records/${rec.id}`);
    assert.equal(stand.json.record.data.body, 'Milch\nBrot\nEier (vom iPad)', 'nichts ueberschrieben');
    // Mit dem neuen Stand geht es; ohne rev wie bisher; If-Match als Kopf.
    assert.equal((await api('PATCH', `/api/records/${rec.id}`, { data: { body: 'Milch\nBrot\nEier (vom iPad)\nKaese' }, rev: rec.rev + 1 })).status, 200);
    assert.equal((await api('PATCH', `/api/records/${rec.id}`, { data: { pinned: true } })).status, 200);
    assert.equal((await api('PATCH', `/api/records/${rec.id}`, { data: { pinned: false } }, { 'if-match': '"1"' })).status, 409);
    assert.equal((await api('PATCH', `/api/records/${rec.id}`, { data: { pinned: false }, rev: 'abc' })).status, 400);
  });
});

test('Ein Thema mit langer ID laesst sich oeffnen; abgelehnte Verbindungen stehen nicht in der Suche der Palette', async () => {
  await withApp(async ({ api }) => {
    const lang = `Fach${'x'.repeat(260)}`;
    for (const t of ['A', 'B']) await api('POST', '/api/records', { type: 'note', data: { title: t, body: 'y', tags: [lang] } });
    const e0 = await api('GET', '/api/graph/universum');
    const thema = e0.json.themen.find((t) => t.name.startsWith('Fach'));
    assert.ok(thema && thema.id.length > 200);
    const e1 = await api('GET', `/api/graph/universum?tiefe=1&thema=${encodeURIComponent(thema.id)}`);
    assert.equal(e1.status, 200, e1.text);

    const a = (await api('POST', '/api/records', { type: 'note', data: { title: 'Chlorophyll absorbiert Licht', body: 'Rot und blau.' } })).json.record;
    const b = (await api('POST', '/api/records', { type: 'note', data: { title: 'Pflanzen brauchen Licht', body: 'Wachstum.' } })).json.record;
    assert.equal((await api('POST', '/api/graph/ablehnen', { from: a.id, to: [b.id] })).status, 200);
    // So sucht die Palette (web/app.js): nur Arten, die man oeffnen kann.
    const typen = 'note,chat,message,project,task,event,file,entity,memory,agent,run';
    const treffer = await api('GET', `/api/search?q=Chlorophyll&limit=8&types=${typen}`);
    assert.ok(treffer.json.items.every((it) => it.record.type !== 'suggestion'), JSON.stringify(treffer.json.items.map((it) => it.record.type)));
    assert.ok(treffer.json.items.some((it) => it.record.id === a.id));
  });
});

test('POST /api/notizen/import: Markdown-Dateien werden Notizen, [[Links]] und #Schlagworte verbinden danach', async () => {
  await withApp(async ({ api, app }) => {
    const res = await api('POST', '/api/notizen/import', {
      dateien: [
        { name: 'Biologie/Photosynthese.md', text: '---\ntags: [schule, biologie]\n---\n\nPflanzen brauchen Licht. Siehe [[Zellatmung]].' },
        { name: 'Biologie/Zellatmung.md', text: 'Umkehrung der [[Photosynthese]]. #biologie' },
        { name: 'bild.png', text: '' },
      ],
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.angelegt, 2);
    assert.deepEqual(res.json.uebersprungen.map((u) => u.name), ['bild.png']);
    assert.equal(res.json.graph && res.json.graph.ok, true);
    const [foto, atmung] = res.json.ids.map((id) => app.store.get(id));
    assert.equal(foto.data.title, 'Photosynthese');
    assert.equal(foto.data.source, 'import');
    assert.deepEqual(foto.data.tags, ['schule', 'biologie']);
    assert.equal(foto.data.body, 'Pflanzen brauchen Licht. Siehe [[Zellatmung]].');
    // Die Links zeigen aufeinander -- auch der auf die spaeter importierte Datei.
    assert.ok(app.store.edges.for(foto.id, { direction: 'out' }).some((e) => e.data.to === atmung.id));
    assert.ok(app.store.edges.for(atmung.id, { direction: 'out' }).some((e) => e.data.to === foto.id));
    // Noch einmal dieselben Dateien: nichts doppelt.
    const nochmal = await api('POST', '/api/notizen/import', { dateien: [{ name: 'Photosynthese.md', text: 'x' }] });
    assert.equal(nochmal.json.angelegt, 0);
    assert.match(nochmal.json.uebersprungen[0].grund, /gibt es schon/);
    // Die #-Vervollstaendigung kennt Schlagworte aus dem Text.
    const tags = await api('GET', '/api/notizen/vervollstaendigen?art=tag&q=bio');
    assert.equal(tags.json.items[0].tag.toLowerCase(), 'biologie');
    assert.equal(tags.json.items[0].anzahl, 2);
  });
});

test('Das Kante fuer Kante nachgefuehrte Netz ist dasselbe wie ein frisch gelesenes (Zufallsfolge aus 150 Aenderungen)', async () => {
  const h = await offen('r1-netz-gleich', { istAusgesetzt: () => true });
  try {
    const s = h.store;
    let saat = 7;
    const zufall = () => { saat = (saat * 1103515245 + 12345) % 2147483648; return saat / 2147483648; };
    const eins = (liste) => liste[Math.floor(zufall() * liste.length)];
    const ids = [];
    for (let i = 0; i < 200; i++) {
      ids.push(s.create('note', { title: `N${i}`, body: i % 5 ? `x [[N${(i * 7) % 200}]]` : 'y', tags: [`t${i % 23}`, `u${i % 7}`] }).id);
    }
    const kanten = [];
    const dazu = (a, b) => { if (a !== b) { try { kanten.push(s.edges.add({ from: a, to: b, kind: 'related', source: 'manual' }).id); } catch { /* gibt es schon */ } } };
    for (let i = 0; i < 400; i++) dazu(eins(ids), eins(ids));
    const bild = (u) => JSON.stringify({
      e0: uni.ebene0(u).themen,
      v: u.verbindungen,
      i: [...u.innere].sort(),
      g: [...u.knoten.values()].map((k) => [k.id, k.grad]).sort(),
      k: u.kanten.map((e) => e.id),
    });
    uni.universum(s);
    for (let r = 0; r < 150; r++) {
      const w = zufall();
      if (w < 0.3 && kanten.length) { try { s.edges.remove(kanten.splice(Math.floor(zufall() * kanten.length), 1)[0]); } catch { /* schon weg */ } }
      else if (w < 0.55) dazu(eins(ids), eins(ids));
      else if (w < 0.75) s.update(eins(ids), { tags: [`t${Math.floor(zufall() * 23)}`], body: `z [[N${Math.floor(zufall() * 200)}]]` });
      else if (w < 0.88) ids.push(s.create('note', { title: `M${r}`, body: `neu [[N${Math.floor(zufall() * 200)}]]`, tags: [`t${r % 23}`] }).id);
      else s.remove(ids.splice(Math.floor(zufall() * ids.length), 1)[0], { hard: zufall() < 0.5 });
      const nachgefuehrt = uni.universum(s).u;
      // Andere Reihenfolge der Arten: am Cache und an den Rohdaten vorbei, frisch gelesen.
      const frisch = uni.universum(s, { typen: uni.TYPEN.slice().reverse(), frisch: true }).u;
      assert.equal(bild(nachgefuehrt), bild(frisch), `Runde ${r}: das nachgefuehrte Netz weicht ab`);
    }
  } finally {
    await h.close();
  }
});

test('Dicht verknuepfter Tresor (10 000 Notizen, 500 Schlagworte, 40 000 Kanten): nach jedem Speichern unter 300 ms', async () => {
  const h = await offen('r1-dicht', { istAusgesetzt: () => true });
  try {
    const s = h.store;
    const N = 10000;
    const ids = [];
    s.transaction(() => {
      for (let i = 0; i < N; i++) {
        ids.push(s.create('note', { title: `Notiz ${i}`, body: `Text ${i}`, tags: [`t${i % 500}`, `t${(i * 7) % 500}`, `t${(i * 13) % 500}`] }).id);
      }
    });
    s.transaction(() => {
      for (let i = 0; i < N; i++) {
        for (const m of [200, 31, 17, 5]) {
          const j = (i * m + 7) % N;
          if (j !== i) s.edges.add({ from: ids[i], to: ids[j], kind: 'links-to', source: 'derived' });
        }
      }
    });
    uni.universum(s); // der erste Bau liest den Tresor einmal ganz
    const zeiten = [];
    for (let r = 0; r < 4; r++) {
      s.update(ids[r * 97], { body: `Geaendert ${r}`, tags: [`t${r}`] });
      const t0 = process.hrtime.bigint();
      const { u, ausCache } = uni.universum(s);
      uni.ebene0(u);
      zeiten.push(Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10);
      assert.equal(ausCache, false);
    }
    console.log(`    Dicht, nach dem Speichern: ${zeiten.join(' / ')} ms`);
    assert.ok(Math.max(...zeiten) < 300, `zu langsam: ${zeiten.join(', ')} ms`);
  } finally {
    await h.close();
  }
});
