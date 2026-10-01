'use strict';

/**
 * Das Wissensuniversum (src/graph/universum.js), Vertrag A-F vom 27.09.2026.
 *
 * Alles laeuft gegen die ECHTE Engine mit Bus: die Vorschlaege gehen ueber
 * die Volltextsuche, der Cache haengt am Bus, und die Ereignisse
 * 'graph.kante' / 'graph.vorschlaege' entstehen nur, wenn `attach` wirklich
 * an dem Store haengt, den die Oberflaeche spaeter auch sieht. Jeder Test
 * hier war rot, bevor universum.js existierte -- die Datei gab es nicht.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, tempHome, waitForEvent } = require('./harness');

const { openStore } = require('../src/store/engine');
const { Bus } = require('../src/kernel/bus');
const derive = require('../src/graph/derive');
const view = require('../src/graph/view');
const uni = require('../src/graph/universum');

/** Ein Store wie in app.js verdrahtet: Ableitung, dann das Universum. */
async function offen(label, opts = {}) {
  const { home, cleanup } = tempHome(label);
  const bus = new Bus();
  const store = await openStore({ paths: path.join(home, 'nos'), bus, lock: false });
  bus.on('record.created', (evt) => {
    const r = evt.payload.record;
    if (r && r.type !== 'edge') derive.deriveFor(store, r);
  });
  bus.on('record.updated', (evt) => {
    const r = evt.payload.record;
    if (r && r.type !== 'edge') derive.deriveFor(store, r);
  });
  const anbindung = opts.attach === false ? null : uni.attach({
    store, bus, verzoegerungMs: { neu: 5, aenderung: 5 }, istAusgesetzt: opts.istAusgesetzt,
  });
  return {
    store,
    bus,
    anbindung,
    async close() {
      if (anbindung) anbindung.detach();
      await store.close();
      cleanup();
    },
  };
}

const fest = (type, n) => `${type}_${String(n).padStart(24, '0')}`;

/** Der Schulstoff aus der Vision, mit festen IDs (fuer den Determinismus-Test). */
function schule(store, reihenfolge = 'vor') {
  const saetze = [
    ['entity', 1, { name: 'Biologie', kind: 'topic', description: 'Lehre vom Leben.' }],
    ['entity', 2, { name: 'Schule', kind: 'topic' }],
    ['entity', 3, { name: 'Jonas', kind: 'person', description: 'Hilft beim Prototyp.' }],
    ['note', 1, { title: 'Photosynthese', body: 'Pflanzen wandeln Licht in Energie um. Chlorophyll im Blatt absorbiert Licht. Gegenstück: [[Zellatmung]].', tags: ['schule', 'biologie'] }],
    ['note', 2, { title: 'Zellatmung', body: 'Zucker wird mit Sauerstoff abgebaut. Umkehrung der [[Photosynthese]].', tags: ['schule', 'biologie'] }],
    ['note', 3, { title: 'Zellen', body: 'Kleinste lebende Einheit. Im Kern liegt die [[DNA]].', tags: ['schule', 'biologie'] }],
    ['note', 4, { title: 'DNA', body: 'Doppelhelix aus vier Basen. Siehe [[Genetik]].', tags: ['schule', 'biologie', 'genetik'] }],
    ['note', 5, { title: 'Genetik', body: 'Mendel, dominant und rezessiv. Grundlage ist die [[DNA]].', tags: ['schule', 'biologie', 'genetik'] }],
    ['note', 6, { title: 'Erster Weltkrieg', body: '1914 bis 1918, Stellungskrieg.', tags: ['schule', 'geschichte'] }],
    ['note', 7, { title: 'Zweiter Weltkrieg', body: '1939 bis 1945. Folge des [[Erster Weltkrieg|Ersten Weltkriegs]].', tags: ['schule', 'geschichte'] }],
    ['project', 1, { name: 'Smart Glasses', description: 'Eine Brille, die Notizen einblendet. Mit [[Jonas]].' }],
    ['task', 1, { title: 'Rahmen drucken', projectId: fest('project', 1) }],
    ['note', 8, { title: 'Smart Glasses: Ideen', body: 'Notizen einblenden, Navigation.', projectId: fest('project', 1), tags: [] }],
    ['note', 9, { title: 'Rezept Pfannkuchen', body: 'Mehl, Milch, Eier. Siehe [[Einkauf]].', tags: [] }],
    ['note', 10, { title: 'Einkauf', body: 'Mehl und Milch fuer die [[Rezept Pfannkuchen|Pfannkuchen]].', tags: [] }],
    ['note', 11, { title: 'Zitat des Tages', body: 'Was man nicht aufschreibt, hat man nicht gedacht.', tags: [] }],
  ];
  const liste = reihenfolge === 'zurueck' ? saetze.slice().reverse() : saetze;
  for (const [type, n, data] of liste) store.create(type, data, { id: fest(type, n) });
  // Links, die vor ihrem Ziel geschrieben wurden, sauber nachziehen.
  derive.scanAll(store);
}

function ohneZeit(e) {
  const { at, aufgebautMs, stand, dauerMs, ausCache, ...rest } = e;
  return rest;
}

/* ------------------------------------------------------------ Ebene 0 */

test('Ebene 0: Themen aus Schlagworten, Begriffen, Projekten und dem Rest -- mit Kindern', async () => {
  const h = await offen('uni-e0');
  try {
    schule(h.store);
    const { u } = uni.universum(h.store);
    const e0 = uni.ebene0(u);
    assert.equal(e0.ebene, 0);
    assert.ok(e0.themen.length <= uni.MAX_THEMEN);
    const byName = new Map(e0.themen.map((t) => [t.name, t]));

    // Schlagwort #schule und Begriff "Schule" sind EIN Thema, mit dem Begriff als Hub.
    const schuleT = byName.get('Schule');
    assert.ok(schuleT, `kein Thema Schule: ${[...byName.keys()].join(', ')}`);
    assert.equal(schuleT.quelle, 'tag+begriff');
    assert.equal(schuleT.hub, fest('entity', 2));
    assert.equal(schuleT.id, 'thema:schule');
    // Biologie (5 Notizen + Begriff) und Geschichte (2) liegen ganz in Schule: Kinder.
    const kinder = schuleT.kinder.map((k) => k.name);
    assert.deepEqual(kinder.sort(), ['Biologie', 'Geschichte'], `Kinder: ${kinder.join(', ')}`);
    assert.ok(!byName.has('Biologie') && !byName.has('Genetik'), 'ein Kind steht nicht noch einmal auf Ebene 0');
    // Genetik (2) liegt ganz in Biologie UND ganz in Schule: das speziellere gewinnt -- Schule > Biologie > Genetik.
    const bio = schuleT.kinder.find((k) => k.name === 'Biologie');
    assert.equal(uni.ebene1(u, bio.id).thema.kinder.map((k) => k.name).join(','), 'Genetik');
    // Alle Kinder zaehlen zum Elternteil: Schule umfasst den ganzen Stoff.
    assert.ok(schuleT.anzahl >= 9, `Schule zu klein: ${schuleT.anzahl}`);

    // Projekt: Projekt + Aufgabe (belongs-to) + Notiz mit projectId + [[Jonas]].
    const glasses = byName.get('Smart Glasses');
    assert.ok(glasses);
    assert.equal(glasses.quelle, 'projekt');
    assert.equal(glasses.anzahl, 4, 'Projekt, Aufgabe, Ideen-Notiz, Jonas');

    // Rest per Label-Propagation: Rezept <-> Einkauf, benannt nach dem Hub.
    const gruppe = e0.themen.find((t) => t.quelle === 'gruppe');
    assert.ok(gruppe, 'keine Gruppe aus dem Rest');
    assert.ok(['Rezept Pfannkuchen', 'Einkauf'].includes(gruppe.name), gruppe.name);
    assert.equal(gruppe.anzahl, 2);

    // Ohne alles: ehrlich "Unverbunden", neutrale Farbe.
    const rest = byName.get('Unverbunden');
    assert.ok(rest);
    assert.equal(rest.anzahl, 1);
    assert.equal(rest.farbe, uni.FARBE_NEUTRAL);

    // Vertrag: Farbe ist ein Index 0-7, hoechstens 5 wichtigste Knoten, Kanten gezaehlt.
    for (const t of e0.themen) {
      assert.ok(Number.isInteger(t.farbe) && t.farbe >= 0 && t.farbe < uni.FARBEN, `Farbe ${t.farbe}`);
      assert.ok(t.knoten.length <= 5 && t.knoten.length >= 1);
      assert.ok(Number.isInteger(t.kanten));
      for (const k of t.kinder) assert.ok(k.id && k.name && Number.isInteger(k.anzahl));
    }
    // Der Hub steht vorn bei den Wichtigsten; sonst zaehlt der Grad.
    assert.equal(schuleT.knoten[0], fest('entity', 2));
    // Groesstes Thema zuerst.
    assert.equal(e0.themen[0].name, 'Schule');
    assert.deepEqual(e0.gesamt, { knoten: 16, kanten: u.kanten.length, themen: u.themen.size });
    assert.ok(u.kanten.length >= 10);
  } finally {
    await h.close();
  }
});

test('Eine Notiz mit ihrem einen Bild heisst wie die Notiz, nicht "image.png"', async () => {
  const h = await offen('uni-bild');
  try {
    // file_… steht vor note_…: bei Gleichstand gewann frueher das Bild.
    const bild = h.store.create('file', { name: 'image.png', hash: 'b'.repeat(64), mime: 'image/png', size: 10 }, { id: fest('file', 1) });
    h.store.create('note', { title: 'Urlaub am Meer', body: `Der Strand:\n\n![image.png](/api/notizen/dateien/${bild.id})`, tags: [] }, { id: fest('note', 1) });
    const { u } = uni.universum(h.store);
    const gruppe = uni.ebene0(u).themen.find((t) => t.quelle === 'gruppe');
    assert.ok(gruppe, 'Notiz und Bild bilden keine Gruppe -- haengt das Bild nicht an der Notiz?');
    assert.equal(gruppe.name, 'Urlaub am Meer');
    assert.equal(gruppe.hub, fest('note', 1));
    assert.equal(gruppe.anzahl, 2);
    // Nur Bilder: dann darf eines die Gruppe benennen.
    const h2 = await offen('uni-bild2');
    try {
      const a = h2.store.create('file', { name: 'a.png', hash: 'c'.repeat(64), mime: 'image/png', size: 10 });
      const b = h2.store.create('file', { name: 'b.png', hash: 'd'.repeat(64), mime: 'image/png', size: 10 });
      h2.store.edges.add({ from: a.id, to: b.id, kind: 'related' });
      const g2 = uni.ebene0(uni.universum(h2.store).u).themen.find((t) => t.quelle === 'gruppe');
      assert.ok(g2 && ['a.png', 'b.png'].includes(g2.name), JSON.stringify(g2));
    } finally {
      await h2.close();
    }
  } finally {
    await h.close();
  }
});

test('Ebene 1: Knoten und Kanten eines Themas, Nachbarn ausserhalb markiert, Pfad nach oben', async () => {
  const h = await offen('uni-e1');
  try {
    schule(h.store);
    const { u } = uni.universum(h.store);
    const e1 = uni.ebene1(u, 'thema:biologie');
    assert.equal(e1.ebene, 1);
    assert.equal(e1.thema.name, 'Biologie');
    assert.equal(e1.thema.eltern, 'thema:schule');
    assert.deepEqual(e1.thema.pfad, [{ id: 'thema:schule', name: 'Schule' }]);
    assert.deepEqual(e1.thema.kinder.map((k) => k.id), ['thema:genetik'], 'Genetik liegt ganz in Biologie: ein Unterthema');

    const drinnen = e1.knoten.filter((k) => !k.ausserhalb).map((k) => k.label).sort();
    assert.deepEqual(drinnen, ['Biologie', 'DNA', 'Genetik', 'Photosynthese', 'Zellatmung', 'Zellen']);
    const draussen = e1.knoten.filter((k) => k.ausserhalb).map((k) => k.label);
    assert.deepEqual(draussen, ['Schule'], 'der Begriff Schule haengt an jeder Notiz, gehoert aber nicht zu Biologie');
    for (const k of e1.knoten) {
      assert.ok(k.themen.includes('thema:biologie') || k.ausserhalb);
      assert.ok(typeof k.grad === 'number' && Array.isArray(k.tags) && typeof k.label === 'string');
      assert.ok(Number.isInteger(k.farbe));
    }
    const ids = new Set(e1.knoten.map((k) => k.id));
    const innen = new Set(e1.knoten.filter((k) => !k.ausserhalb).map((k) => k.id));
    assert.ok(e1.kanten.length >= 8, `zu wenige Kanten: ${e1.kanten.length}`);
    for (const e of e1.kanten) {
      assert.ok(ids.has(e.from) && ids.has(e.to), 'eine Kante ins Unsichtbare');
      assert.ok(innen.has(e.from) || innen.has(e.to), 'eine Kante ganz ausserhalb');
      assert.ok(e.id && e.kind && e.source);
    }
    assert.equal(e1.gekuerzt, false);

    // Unbekanntes Thema: 404, kein leeres Bild.
    assert.throws(() => uni.ebene1(u, 'thema:gibtesnicht'), (err) => err.code === 'NOT_FOUND');
    // Ein Kind ist selbst zoombar, drei Ebenen tief: Schule > Biologie > Genetik.
    const gen = uni.ebene1(u, 'thema:genetik');
    assert.deepEqual(gen.knoten.filter((k) => !k.ausserhalb).map((k) => k.label).sort(), ['DNA', 'Genetik']);
    assert.deepEqual(gen.thema.pfad.map((p) => p.name), ['Schule', 'Biologie']);
    assert.equal(gen.thema.eltern, 'thema:biologie');
  } finally {
    await h.close();
  }
});

test('Deterministisch: gleiche Daten in anderer Reihenfolge ergeben dieselbe Karte', async () => {
  const a = await offen('uni-det-a');
  const b = await offen('uni-det-b');
  try {
    schule(a.store, 'vor');
    schule(b.store, 'zurueck');
    const ea = uni.ebene0(uni.universum(a.store).u);
    const eb = uni.ebene0(uni.universum(b.store).u);
    assert.deepEqual(ohneZeit(ea), ohneZeit(eb));
    const ka = uni.ebene1(uni.universum(a.store).u, 'thema:schule');
    const kb = uni.ebene1(uni.universum(b.store).u, 'thema:schule');
    // Kanten-IDs und Zeitstempel sind je Store anders, der Rest muss gleich sein.
    const ohneKantenIds = (e) => ({
      ...ohneZeit(e),
      knoten: e.knoten.map(({ updatedAt, ...rest }) => rest),
      kanten: e.kanten.map(({ id, ...rest }) => rest).sort((x, y) => (x.from + x.to + x.kind < y.from + y.to + y.kind ? -1 : 1)),
    });
    assert.deepEqual(ohneKantenIds(ka), ohneKantenIds(kb));
    // Und zweimal hintereinander auf demselben Store: dasselbe.
    assert.deepEqual(ohneZeit(uni.ebene0(uni.universum(a.store, { frisch: true }).u)), ohneZeit(ea));
  } finally {
    await a.close();
    await b.close();
  }
});

test('Hoechstens ~40 Kreise: der Schwanz wird zu "Weitere Themen", jedes davon bleibt zoombar', async () => {
  const h = await offen('uni-cap');
  try {
    h.store.transaction(() => {
      for (let i = 0; i < 70; i++) {
        h.store.create('note', { title: `Notiz ${i}`, body: `Text ${i}`, tags: [`thema${i}`] });
      }
    });
    const { u } = uni.universum(h.store);
    const e0 = uni.ebene0(u);
    assert.ok(e0.themen.length <= uni.MAX_THEMEN, `${e0.themen.length} Kreise`);
    const weitere = e0.themen.find((t) => t.id === uni.WEITERE);
    assert.ok(weitere, 'kein Sammelthema');
    assert.ok(weitere.kinder.length >= 30, `nur ${weitere.kinder.length} im Sammelthema`);
    assert.equal(weitere.anzahl, weitere.kinder.reduce((n, k) => n + k.anzahl, 0));
    const kind = uni.ebene1(u, weitere.kinder[0].id);
    assert.equal(kind.thema.eltern, uni.WEITERE);
    assert.equal(kind.knoten.filter((k) => !k.ausserhalb).length, 1);
    assert.equal(e0.gesamt.themen, 70);
  } finally {
    await h.close();
  }
});

/* --------------------------------------------------------------- Cache */

test('Cache: die zweite Anfrage kommt aus dem Cache, jede Aenderung laesst ihn verfallen', async () => {
  const h = await offen('uni-cache');
  try {
    schule(h.store);
    const erste = uni.universum(h.store);
    assert.equal(erste.ausCache, false);
    const zweite = uni.universum(h.store);
    assert.equal(zweite.ausCache, true);
    assert.equal(zweite.u.stand, erste.u.stand);

    h.store.update(fest('note', 11), { tags: ['schule'] }); // record.updated
    const dritte = uni.universum(h.store);
    assert.equal(dritte.ausCache, false, 'nach record.updated muss neu gebaut werden');
    assert.ok(dritte.u.stand > erste.u.stand);
    assert.ok(!uni.ebene0(dritte.u).themen.some((t) => t.id === uni.UNVERBUNDEN), 'die Notiz ist jetzt in Schule');

    assert.equal(uni.universum(h.store).ausCache, true);
    h.store.edges.add({ from: fest('note', 9), to: fest('note', 6), kind: 'related', source: 'manual' }); // edge -> record.created
    assert.equal(uni.universum(h.store).ausCache, false, 'eine neue Kante ist eine Aenderung');

    assert.equal(uni.universum(h.store).ausCache, true);
    h.store.remove(fest('note', 6)); // record.deleted
    assert.equal(uni.universum(h.store).ausCache, false);

    // Ereignisse, die das Universum nichts angehen, lassen ihn stehen.
    assert.equal(uni.universum(h.store).ausCache, true);
    h.store.create('memory', { text: 'nur eine Erinnerung' });
    assert.equal(uni.universum(h.store).ausCache, true, 'eine Erinnerung ist kein Knoten');

    // Ohne Anbindung wird ehrlich jedes Mal gebaut -- nie ein stiller alter Stand.
    h.anbindung.detach();
    assert.equal(uni.universum(h.store).ausCache, false);
    assert.equal(uni.universum(h.store).ausCache, false);
  } finally {
    await h.close();
  }
});

/* --------------------------------------------------- Ereignisse D + E */

test('graph.kante: jede neue Kante wird gemeldet, mit beiden Enden -- und ihr Verschwinden auch', async () => {
  const h = await offen('uni-kante');
  try {
    const a = h.store.create('note', { title: 'Alpha', body: 'x' });
    const kommt = waitForEvent(h.bus, 'graph.kante');
    const b = h.store.create('note', { title: 'Beta', body: 'zeigt auf [[Alpha]]' });
    const evt = await kommt;
    assert.equal(evt.payload.neu, true);
    assert.equal(evt.payload.edge.data.from, b.id);
    assert.equal(evt.payload.edge.data.to, a.id);
    assert.equal(evt.payload.edge.data.source, 'derived');
    assert.deepEqual(evt.payload.von, { id: b.id, type: 'note', label: 'Beta' });
    assert.deepEqual(evt.payload.zu, { id: a.id, type: 'note', label: 'Alpha' });

    const weg = waitForEvent(h.bus, 'graph.kante');
    h.store.update(b.id, { body: 'ohne Link' });
    const evt2 = await weg;
    assert.equal(evt2.payload.entfernt, true);
    assert.equal(evt2.payload.edge.id, evt.payload.edge.id);
  } finally {
    await h.close();
  }
});

test('Der Photosynthese-Fall: drei Notizen nacheinander, die Vorschlaege finden einander (graph.vorschlaege)', async () => {
  const h = await offen('uni-foto');
  try {
    const foto = h.store.create('note', { title: 'Photosynthese', body: 'Pflanzen wandeln Licht in Energie um. Chlorophyll im Blatt absorbiert Licht.', tags: ['biologie'] });
    // Die erste Notiz hat niemanden: kein Ereignis, statt einer leeren Karte.
    let leer = true;
    const beobachter = () => { leer = false; };
    h.bus.on('graph.vorschlaege', beobachter);
    await new Promise((r) => setTimeout(r, 40));
    h.bus.off('graph.vorschlaege', beobachter);
    assert.equal(leer, true, 'ohne Kandidaten kein graph.vorschlaege');

    const warte1 = waitForEvent(h.bus, 'graph.vorschlaege');
    const pflanzen = h.store.create('note', { title: 'Pflanzen brauchen Licht', body: 'Ohne Licht wachsen Pflanzen nicht: Keimlinge im Schrank werden lang und blass.' });
    const e1 = await warte1;
    assert.equal(e1.payload.recordId, pflanzen.id);
    assert.equal(e1.payload.type, 'note');
    assert.equal(e1.payload.anzahl, e1.payload.vorschlaege.length);
    assert.ok(e1.payload.vorschlaege.some((v) => v.id === foto.id), 'Photosynthese wird zu "Pflanzen brauchen Licht" vorgeschlagen');
    const v1 = e1.payload.vorschlaege.find((v) => v.id === foto.id);
    assert.match(v1.grund, /^2 gemeinsame Begriffe: /);
    assert.match(v1.grund, /Licht/);
    assert.match(v1.grund, /Pflanzen/);
    assert.equal(v1.title, 'Photosynthese');

    const warte2 = waitForEvent(h.bus, 'graph.vorschlaege');
    const chloro = h.store.create('note', { title: 'Chlorophyll absorbiert Licht', body: 'Chlorophyll absorbiert rotes und blaues Licht, gruenes wird reflektiert.' });
    const e2 = await warte2;
    assert.equal(e2.payload.recordId, chloro.id);
    const ids = e2.payload.vorschlaege.map((v) => v.id);
    assert.ok(ids.includes(foto.id) && ids.includes(pflanzen.id), `gefunden: ${e2.payload.vorschlaege.map((v) => v.title).join(', ')}`);
    assert.ok(e2.payload.vorschlaege.length <= uni.MAX_VORSCHLAEGE);
    const v2 = e2.payload.vorschlaege.find((v) => v.id === foto.id);
    assert.equal(v2.gemeinsam, 3);
    assert.match(v2.grund, /^3 gemeinsame Begriffe: /);
    for (const wort of ['Chlorophyll', 'absorbiert', 'Licht']) assert.ok(v2.grund.includes(wort), `${wort} fehlt in "${v2.grund}"`);
    // Am besten passt, was am meisten teilt.
    assert.equal(e2.payload.vorschlaege[0].id, foto.id);
    // Dieselbe Antwort liefert die Abfrage von Hand (fuer /verknuepft).
    assert.deepEqual(uni.vorschlaegeFuer(h.store, chloro.id).map((v) => v.id), ids);

    // Aendern: nach der Verzoegerung noch einmal, mit dem neuen Text.
    const warte3 = waitForEvent(h.bus, 'graph.vorschlaege');
    h.store.update(chloro.id, { body: 'Nur noch ein Satz ueber Chlorophyll.' });
    const e3 = await warte3;
    assert.equal(e3.payload.recordId, chloro.id);
    assert.ok(e3.payload.vorschlaege.some((v) => v.id === foto.id));
  } finally {
    await h.close();
  }
});

test('Verzoegerung: schnelle Aenderungen ergeben EIN Ereignis; Massenimport keins', async () => {
  let ausgesetzt = false;
  const h = await offen('uni-debounce', { istAusgesetzt: () => ausgesetzt });
  try {
    h.store.create('note', { title: 'Licht und Blatt', body: 'Blatt im Licht.' });
    await new Promise((r) => setTimeout(r, 30)); // ihr eigener Zeitgeber soll durch sein
    const gesehen = [];
    h.bus.on('graph.vorschlaege', (evt) => gesehen.push(evt.payload.recordId));
    const n = h.store.create('note', { title: 'Blatt', body: 'Ein Blatt.' });
    for (let i = 0; i < 5; i++) h.store.update(n.id, { body: `Ein Blatt im Licht, Fassung ${i}.` });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(gesehen, [n.id], `erwartet genau ein Ereignis, bekommen ${gesehen.length}`);

    ausgesetzt = true;
    h.store.create('note', { title: 'Import', body: 'Blatt und Licht aus einer Sicherung.' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(gesehen.length, 1, 'waehrend eines Imports keine Vorschlaege');
    assert.equal(h.anbindung.ausstehend, 0);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------ Verbinden, Ablehnen */

test('Verbinden legt manuelle Kanten an und ist rueckgaengig machbar; Ablehnen unterdrueckt den Vorschlag', async () => {
  const h = await offen('uni-verbinden');
  try {
    const foto = h.store.create('note', { title: 'Photosynthese', body: 'Chlorophyll absorbiert Licht im Blatt.', tags: ['biologie'] });
    const pflanzen = h.store.create('note', { title: 'Pflanzen brauchen Licht', body: 'Ohne Licht kein Wachstum.' });
    const chloro = h.store.create('note', { title: 'Chlorophyll absorbiert Licht', body: 'Rotes und blaues Licht.' });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(uni.vorschlaegeFuer(h.store, chloro.id).map((v) => v.id).sort(), [foto.id, pflanzen.id].sort());

    // [Alle verbinden]
    const gemeldet = [];
    h.bus.on('graph.kante', (evt) => gemeldet.push(evt.payload));
    const v = uni.verbinden(h.store, chloro.id, [foto.id, pflanzen.id], { reason: 'Vorschlag angenommen' });
    assert.equal(v.edges.length, 2);
    assert.deepEqual(v.neu, v.edges.map((e) => e.id));
    assert.deepEqual(v.bereits, []);
    for (const e of v.edges) {
      assert.equal(e.data.source, 'manual');
      assert.equal(e.data.kind, 'related');
      assert.equal(e.data.reason, 'Vorschlag angenommen');
    }
    assert.equal(v.rueckgaengig.pfad, '/api/graph/rueckgaengig');
    assert.deepEqual(v.rueckgaengig.body, { edges: v.neu });
    assert.equal(gemeldet.filter((p) => p.neu).length, 2, 'beide Kanten sofort gemeldet');
    // Verbundene Knoten sind kein Vorschlag mehr.
    assert.deepEqual(uni.vorschlaegeFuer(h.store, chloro.id), []);
    // Noch einmal: nichts Neues, ehrlich als "bereits" gemeldet.
    const wieder = uni.verbinden(h.store, chloro.id, [foto.id]);
    assert.deepEqual(wieder.neu, []);
    assert.deepEqual(wieder.bereits, [v.edges[0].id]);
    assert.equal(wieder.rueckgaengig, null);

    // Rueckgaengig: genau diese Kanten weg, gemeldet, Vorschlaege wieder da.
    const z = uni.rueckgaengig(h.store, v.neu);
    assert.equal(z.anzahl, 2);
    assert.ok(z.entfernt.every((e) => e.deletedAt));
    assert.equal(gemeldet.filter((p) => p.entfernt).length, 2);
    assert.equal(h.store.edges.for(chloro.id).length, 0);
    assert.deepEqual(uni.vorschlaegeFuer(h.store, chloro.id).map((v2) => v2.id).sort(), [foto.id, pflanzen.id].sort());
    // Eine abgeleitete Kante laesst sich hier nicht zuruecknehmen.
    const q = h.store.create('note', { title: 'Quelle', body: 'siehe [[Photosynthese]]' });
    const abgeleitet = h.store.edges.for(q.id, { direction: 'out' })[0];
    assert.equal(abgeleitet.data.source, 'derived');
    assert.throws(() => uni.rueckgaengig(h.store, [abgeleitet.id]), (err) => err.code === 'VALIDATION_FAILED');
    assert.throws(() => uni.rueckgaengig(h.store, ['edge_gibtesnicht0000000000000']), (err) => err.code === 'NOT_FOUND');
    assert.throws(() => uni.verbinden(h.store, chloro.id, ['note_gibtesnicht00000000000000']), (err) => err.code === 'NOT_FOUND');
    assert.throws(() => uni.verbinden(h.store, chloro.id, [chloro.id]), (err) => err.code === 'VALIDATION_FAILED');
    assert.throws(() => uni.verbinden(h.store, chloro.id, [foto.id], { kind: 'unsinn' }), (err) => err.code === 'VALIDATION_FAILED');

    // [Ablehnen]: das Paar kommt nicht wieder -- in beide Richtungen, ohne Kante.
    const abl = uni.ablehnen(h.store, chloro.id, [foto.id]);
    assert.equal(abl.abgelehnt.length, 1);
    assert.equal(abl.abgelehnt[0].id, foto.id);
    const satz = h.store.get(abl.abgelehnt[0].satz);
    assert.equal(satz.type, 'suggestion');
    assert.equal(satz.data.status, 'dismissed');
    assert.equal(satz.data.source, 'graph');
    assert.deepEqual(uni.vorschlaegeFuer(h.store, chloro.id).map((v2) => v2.id), [pflanzen.id]);
    assert.ok(!uni.vorschlaegeFuer(h.store, foto.id).some((v2) => v2.id === chloro.id), 'auch von der anderen Seite her nicht');
    assert.equal(h.store.edges.for(chloro.id).length, 0, 'Ablehnen zieht keine Kante');
    const nochmal = uni.ablehnen(h.store, chloro.id, [foto.id]);
    assert.deepEqual(nochmal.abgelehnt, []);
    assert.deepEqual(nochmal.bereits, [foto.id]);
    assert.equal(h.store.count('suggestion'), 1, 'kein zweiter Satz fuer dasselbe Paar');
    assert.throws(() => uni.ablehnen(h.store, chloro.id, ['note_gibtesnicht00000000000000']), (err) => err.code === 'NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('attach ist je Store einmalig; ohne Store oder Bus wird verweigert', async () => {
  const h = await offen('uni-attach');
  try {
    assert.equal(uni.attach({ store: h.store, bus: h.bus }), h.anbindung);
    assert.throws(() => uni.attach({ store: h.store }), (err) => err.code === 'VALIDATION_FAILED');
    assert.throws(() => uni.attach({ bus: h.bus }), (err) => err.code === 'VALIDATION_FAILED');
    h.anbindung.detach();
    h.anbindung.detach(); // zweimal ist erlaubt
    assert.ok(!h.store.__universum);
  } finally {
    await h.close();
  }
});

/* --------------------------------------------------------- Stammform */

test('Stammform: Pflanzen/Pflanze, Lichts/Licht, Zellen/Zelle -- angezeigt wird das Original', () => {
  assert.equal(view.stamm('pflanzen'), view.stamm('pflanze'));
  assert.equal(view.stamm('lichts'), 'licht');
  assert.equal(view.stamm('licht'), 'licht');
  assert.equal(view.stamm('zellen'), view.stamm('zelle'));
  assert.equal(view.stamm('gruenes'), view.stamm('gruen'));
  assert.equal(view.stamm('dna'), 'dna');
  assert.equal(view.stamm('verbindungen'), view.stamm('verbindung'));
  const map = view.termMap({ type: 'note', data: { title: 'Die Pflanzen im Licht', body: 'Eine Pflanze braucht Licht.', tags: ['garten'] } });
  assert.equal(map.get(view.stamm('pflanzen')), 'Pflanzen', 'die erste Schreibweise gewinnt');
  assert.ok(!map.has('garten'), 'eigene Schlagworte sind keine Begriffe');
  assert.ok(!map.has('die') && !map.has('eine'), 'Stoppwoerter fallen weg');
});
