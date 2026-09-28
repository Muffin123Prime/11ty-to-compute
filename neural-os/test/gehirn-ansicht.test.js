'use strict';

/**
 * Die reinen Funktionen hinter dem Wissensuniversum (web/lib/universum.js)
 * und der Themen-Lage des Zeichners (web/lib/graph-canvas.js), ohne Browser.
 *
 * web/** ist Browser-ESM ohne Bauschritt, dieses Paket ist CommonJS. Der Test
 * kopiert die Dateien deshalb unveraendert in ein Zeitverzeichnis und gibt
 * ihnen nur die Endung .mjs -- geprueft wird genau der Quelltext, den der
 * Browser holt. Was nur im Browser zu sehen ist (Hineinzoomen, Hover,
 * Karte), prueft tools/ui-check.js Abschnitt 4b mit Chromium.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

let geladen = null;
async function laden() {
  if (geladen) return geladen;
  const web = path.join(__dirname, '..', 'web');
  const { home, cleanup } = tempHome('nos-gehirn-ansicht');
  const alsModul = (src) => src.replace(/(from\s+')([^']+)\.js(')/g, (m, kopf, spec, ende) => `${kopf}./${path.basename(spec)}.mjs${ende}`);
  const kopie = (von, nach) => fs.writeFileSync(path.join(home, nach), alsModul(fs.readFileSync(von, 'utf8')));
  for (const datei of fs.readdirSync(path.join(web, 'lib'))) {
    if (datei.endsWith('.js')) kopie(path.join(web, 'lib', datei), datei.replace(/\.js$/, '.mjs'));
  }
  try {
    geladen = {
      universum: await import(pathToFileURL(path.join(home, 'universum.mjs')).href),
      canvas: await import(pathToFileURL(path.join(home, 'graph-canvas.mjs')).href),
    };
  } finally {
    cleanup();
  }
  return geladen;
}

/** Ein kleiner Tresor als Graph-Bild: Schule mit Biologie und Chemie, ein Projekt, Streuner. */
function beispiel() {
  const nodes = [
    { id: 'note_photo', type: 'note', label: 'Photosynthese', tags: ['biologie'], degree: 3 },
    { id: 'note_zell', type: 'note', label: 'Zellatmung', tags: ['biologie'], degree: 2 },
    { id: 'note_dna', type: 'note', label: 'DNA', tags: ['biologie', 'genetik'], degree: 2 },
    { id: 'note_gen', type: 'note', label: 'Gene und Vererbung', tags: ['biologie', 'genetik'], degree: 1 },
    { id: 'note_licht', type: 'note', label: 'Pflanzen brauchen Licht', tags: ['biologie'], degree: 1 },
    { id: 'note_saeure', type: 'note', label: 'Säuren und Basen', tags: ['chemie'], degree: 1 },
    { id: 'note_ph', type: 'note', label: 'pH-Wert', tags: ['chemie'], degree: 1 },
    { id: 'project_garten', type: 'project', label: 'Gartenjahr', tags: [], degree: 2 },
    { id: 'task_beete', type: 'task', label: 'Beete abstecken', tags: [], degree: 1 },
    { id: 'task_saat', type: 'task', label: 'Aussaat', tags: [], degree: 1 },
    { id: 'note_a', type: 'note', label: 'Alpha', tags: [], degree: 1 },
    { id: 'note_b', type: 'note', label: 'Beta', tags: [], degree: 2 },
    { id: 'note_c', type: 'note', label: 'Gamma', tags: [], degree: 1 },
    { id: 'note_allein', type: 'note', label: 'Ganz allein', tags: [], degree: 0 },
    { id: 'run_x', type: 'run', label: 'Lauf: aufräumen', tags: [], degree: 0 },
  ];
  const edges = [
    { id: 'e1', from: 'note_photo', to: 'note_zell', kind: 'links-to' },
    { id: 'e2', from: 'note_photo', to: 'note_dna', kind: 'links-to' },
    { id: 'e3', from: 'note_dna', to: 'note_gen', kind: 'links-to' },
    { id: 'e4', from: 'note_photo', to: 'note_licht', kind: 'links-to' },
    { id: 'e5', from: 'note_saeure', to: 'note_ph', kind: 'links-to' },
    { id: 'e6', from: 'task_beete', to: 'project_garten', kind: 'belongs-to' },
    { id: 'e7', from: 'task_saat', to: 'project_garten', kind: 'belongs-to' },
    { id: 'e8', from: 'note_a', to: 'note_b', kind: 'links-to' },
    { id: 'e9', from: 'note_b', to: 'note_c', kind: 'links-to' },
    { id: 'e10', from: 'note_zell', to: 'note_saeure', kind: 'related' },
  ];
  return { nodes, edges };
}

test('normaliseEbene0: die Antwort des Servers (themen, verbindungen von/zu, gesamt) wird zur Karte', async () => {
  const { universum } = await laden();
  const e0 = universum.normaliseEbene0({
    ebene: 0,
    themen: [
      { id: 'tag:biologie', name: '#biologie', anzahl: 12, farbe: 3, quelle: 'tag', hub: 'note_photo', kanten: 9, knoten: ['note_photo', 'note_dna'], kinder: [{ id: 'tag:genetik', name: '#genetik', anzahl: 4, farbe: 5 }] },
      { id: 'tag:chemie', name: '#chemie', anzahl: 5, farbe: 99, knoten: [], kinder: [] },
      { id: 'tag:biologie', name: 'doppelt', anzahl: 1 },
      { name: 'ohne id' },
    ],
    verbindungen: [{ von: 'tag:biologie', zu: 'tag:chemie', anzahl: 2 }, { von: 'tag:biologie', zu: 'tag:fehlt', anzahl: 9 }],
    gesamt: { knoten: 17, kanten: 12, themen: 3 },
  });
  assert.equal(e0.themen.length, 2, 'doppelte und id-lose Themen fallen weg');
  assert.equal(e0.themen[0].kinder[0].name, '#genetik');
  assert.equal(e0.themen[1].farbe, 0, 'ein Farbindex ausserhalb 0-7 wird 0');
  assert.deepEqual(e0.verbindungen, [{ from: 'tag:biologie', to: 'tag:chemie', anzahl: 2 }], 'nur Linien zwischen bekannten Themen, von/zu wird from/to');
  assert.deepEqual(e0.gesamt, { knoten: 17, kanten: 12, themen: 3 });
  const leer = universum.normaliseEbene0(null);
  assert.deepEqual(leer.themen, []);
  assert.equal(leer.gesamt.knoten, 0);
});

test('normaliseEbene1: Knoten mit ausserhalb, Kanten nur zwischen geladenen Knoten, Pfad fuer Brotkrumen', async () => {
  const { universum } = await laden();
  const e1 = universum.normaliseEbene1({
    ebene: 1,
    thema: { id: 'tag:genetik', name: '#genetik', anzahl: 2, farbe: 5, eltern: 'tag:biologie', pfad: [{ id: 'tag:biologie', name: '#biologie' }], kinder: [] },
    knoten: [
      { id: 'note_dna', type: 'note', label: 'DNA', tags: ['genetik'], grad: 2, ausserhalb: false },
      { id: 'note_photo', type: 'note', label: 'Photosynthese', tags: [], grad: 3, ausserhalb: true },
      { id: 'note_dna', type: 'note', label: 'nochmal' },
    ],
    kanten: [
      { id: 'e2', from: 'note_photo', to: 'note_dna', kind: 'links-to', source: 'derived' },
      { id: 'e9', from: 'note_dna', to: 'note_fehlt', kind: 'links-to' },
    ],
    gekuerzt: false,
  });
  assert.equal(e1.nodes.length, 2);
  assert.equal(e1.nodes[1].ausserhalb, true);
  assert.equal(e1.edges.length, 1, 'eine Kante zu einem ungeladenen Knoten ist eine Linie ins Leere');
  assert.equal(e1.thema.eltern, 'tag:biologie');
  const krumen = universum.brotkrumen(e1.pfad, e1.thema);
  assert.deepEqual(krumen.map((k) => k.name), ['Mein Wissen', '#biologie', '#genetik']);
  assert.equal(krumen[0].id, null, 'die Wurzel hat keine id');
});

test('Suche: Umlaute wie getippt, Wortreihenfolge egal, Themen samt Kindern, Knoten nach Grad', async () => {
  const { universum } = await laden();
  const themen = [
    { id: 'a', name: 'Schule', anzahl: 30, kinder: [{ id: 'a1', name: 'Biologie', anzahl: 10 }, { id: 'a2', name: 'Chemie', anzahl: 5 }] },
    { id: 'b', name: '#küche', anzahl: 4, kinder: [] },
    { id: 'c', name: 'Garten', anzahl: 8, kinder: [] },
  ];
  const t = universum.sucheThemen(themen, 'biologie');
  assert.equal(t.length, 1);
  assert.equal(t[0].thema.id, 'a', 'das Elternthema wird ueber sein Kind gefunden');
  assert.equal(t[0].kinder[0].id, 'a1');
  assert.equal(universum.sucheThemen(themen, 'kueche')[0].thema.id, 'b', '"kueche" findet "#küche"');
  assert.deepEqual(universum.sucheThemen(themen, ''), []);

  const { nodes } = beispiel();
  const hits = universum.sucheKnoten(nodes, 'licht pflanzen');
  assert.equal(hits[0].id, 'note_licht', 'jedes Wort muss vorkommen, in beliebiger Reihenfolge');
  const tags = universum.sucheKnoten(nodes, 'genetik');
  assert.deepEqual(tags.map((n) => n.id), ['note_dna', 'note_gen'], 'Schlagworte zaehlen, der mit mehr Linien zuerst');
  assert.ok(universum.passt('saeure', 'Säuren und Basen'));

  // Der genau so heissende Eintrag steht vorn, auch wenn ein anderer mehr
  // Linien hat und den Suchtext nur enthaelt (Eingabetaste springt zum ersten).
  const nummern = [
    { id: 'n17', type: 'note', label: 'Notiz 17', tags: [], grad: 9 },
    { id: 'n7', type: 'note', label: 'Notiz 7', tags: [], grad: 1 },
    { id: 'n70', type: 'note', label: 'Notiz 7 und mehr', tags: [], grad: 5 },
    { id: 'n71', type: 'note', label: 'Notiz 7a', tags: [], grad: 2 },
  ];
  assert.deepEqual(universum.sucheKnoten(nummern, 'Notiz 7').map((n) => n.id), ['n7', 'n70', 'n71', 'n17'],
    'genauer Titel, dann Titelanfang (nach Grad), dann der Rest');
  assert.equal(universum.sucheKnoten(nummern, 'notiz 7')[0].id, 'n7', 'Gross- und Kleinschreibung sind egal');
});

test('nachbarschaft: der Knoten und seine Nachbarn bis Tiefe 2 (Fokus)', async () => {
  const { universum } = await laden();
  const { edges } = beispiel();
  const eins = universum.nachbarschaft(edges, 'note_photo', 1);
  assert.deepEqual([...eins].sort(), ['note_dna', 'note_licht', 'note_photo', 'note_zell']);
  const zwei = universum.nachbarschaft(edges, 'note_photo', 2);
  assert.ok(zwei.has('note_gen') && zwei.has('note_saeure'), 'Tiefe 2 erreicht die Nachbarn der Nachbarn');
  assert.ok(!zwei.has('note_ph'), 'Tiefe 3 nicht');
  assert.deepEqual([...universum.nachbarschaft(edges, 'note_allein', 2)], ['note_allein']);
});

test('universumLokal: Themen aus Schlagworten, Projekten und Gruppen -- deterministisch, mit Kindern und Linien', async () => {
  const { universum } = await laden();
  const g = beispiel();
  const u = universum.universumLokal(g);
  const namen = u.themen.map((t) => t.name);
  assert.ok(namen.includes('#biologie'), `das Schlagwort wird ein Thema (${namen.join(', ')})`);
  assert.ok(namen.includes('#chemie'));
  assert.ok(namen.includes('Gartenjahr'), 'das Projekt mit seinen Aufgaben wird ein Thema');
  assert.ok(namen.includes('Beta'), 'die Gruppe ohne Schlagwort heisst wie ihr Knoten mit den meisten Linien');
  assert.ok(namen.includes('Unverbunden'), 'was nichts beruehrt, steht ehrlich unter Unverbunden');
  assert.ok(!u._nodes.some((n) => n.type === 'run'), 'Laeufe sind Betrieb, kein Wissen');
  const bio = u.themen.find((t) => t.name === '#biologie');
  assert.equal(bio.anzahl, 5);
  assert.equal(bio.knoten[0], 'note_photo', 'der wichtigste Knoten zuerst');
  assert.ok(bio.kinder.length === 0, 'ein einziges Unter-Schlagwort macht noch keine Kinder (es braucht zwei)');
  const garten = u.themen.find((t) => t.name === 'Gartenjahr');
  assert.equal(garten.anzahl, 3);
  assert.ok(u.verbindungen.some((v) => (v.from === 'tag:biologie' && v.to === 'tag:chemie') || (v.from === 'tag:chemie' && v.to === 'tag:biologie')), 'die related-Kante verbindet Biologie und Chemie auf der Karte');
  assert.equal(u.gesamt.knoten, 14);
  const nochmal = universum.universumLokal(beispiel());
  assert.equal(JSON.stringify(nochmal.themen), JSON.stringify(u.themen), 'gleiche Daten, gleiche Karte');

  // Kinder: zwei Schlagworte innerhalb eines Themas
  const g2 = beispiel();
  g2.nodes.push({ id: 'note_evo', type: 'note', label: 'Evolution', tags: ['biologie', 'evolution'], degree: 0 }, { id: 'note_sel', type: 'note', label: 'Selektion', tags: ['biologie', 'evolution'], degree: 0 });
  const u2 = universum.universumLokal(g2);
  const bio2 = u2.themen.find((t) => t.name === '#biologie');
  assert.deepEqual(bio2.kinder.map((k) => k.name).sort(), ['#evolution', '#genetik']);
  const kind = universum.ebene1Lokal(u2, bio2.kinder.find((k) => k.name === '#genetik').id);
  assert.deepEqual(kind.knoten.filter((n) => !n.ausserhalb).map((n) => n.id).sort(), ['note_dna', 'note_gen']);
  assert.ok(kind.knoten.some((n) => n.id === 'note_photo' && n.ausserhalb), 'der Nachbar ausserhalb des Kindes ist dabei, als ausserhalb');
  assert.deepEqual(kind.thema.pfad.map((p) => p.name), ['#biologie']);
  const e1 = universum.ebene1Lokal(u, 'tag:chemie');
  assert.ok(e1.knoten.some((n) => n.id === 'note_zell' && n.ausserhalb));
  assert.equal(universum.ebene1Lokal(u, 'gibt:es:nicht'), null);
});

test('verknuepft: die Antwort der Route und der Ersatz aus einem Umfeld haben dieselbe Form', async () => {
  const { universum } = await laden();
  const v = universum.normaliseVerknuepft({
    eingehend: [{ id: 'note_photo', type: 'note', title: 'Photosynthese', kind: 'links-to', reason: 'Wiki-Link', source: 'derived', edgeId: 'e2' }],
    ausgehend: [],
    vorschlaege: [{ id: 'note_licht', type: 'note', title: 'Pflanzen brauchen Licht', score: 0.41, grund: '3 gemeinsame Begriffe: Licht, Chlorophyll, Blatt' }, { nix: true }],
    themen: [{ id: 'tag:biologie', name: '#biologie', anzahl: 5, farbe: 3 }],
  });
  assert.equal(v.eingehend[0].title, 'Photosynthese');
  assert.equal(v.vorschlaege.length, 1);
  assert.equal(v.vorschlaege[0].grund, '3 gemeinsame Begriffe: Licht, Chlorophyll, Blatt');
  assert.equal(v.themen[0].name, '#biologie');
  const g = beispiel();
  const ersatz = universum.verknuepftAusGraph('note_photo', g);
  assert.deepEqual(ersatz.ausgehend.map((r) => r.id), ['note_zell', 'note_dna', 'note_licht']);
  assert.deepEqual(ersatz.eingehend, []);
  assert.deepEqual(ersatz.vorschlaege, [], 'ohne die Route gibt es keine Vorschlaege -- und keine erfundenen');
});

test('layoutThemen: deterministisch, Kreise ueberlappen nicht, Groesse nach Anzahl', async () => {
  const { canvas } = await laden();
  const themen = Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, anzahl: (i * 37) % 200 + 1 }));
  const links = [{ from: 't0', to: 't1', anzahl: 5 }, { from: 't3', to: 't9', anzahl: 1 }];
  const a = canvas.layoutThemen(themen, links);
  const b = canvas.layoutThemen(themen.map((t) => ({ ...t })), links.map((l) => ({ ...l })));
  assert.equal(a.size, 24);
  assert.equal(JSON.stringify([...a]), JSON.stringify([...b]), 'gleiche Daten, gleiche Lage');
  const list = [...a.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
      assert.ok(d >= list[i].r + list[j].r - 0.5, `Kreise ${i} und ${j} ueberlappen (Abstand ${d.toFixed(1)}, Radien ${list[i].r.toFixed(1)} + ${list[j].r.toFixed(1)})`);
    }
  }
  const groesstes = themen.reduce((m, t) => (t.anzahl > m.anzahl ? t : m));
  assert.equal(a.get(groesstes.id).r, canvas.THEMA_R_MAX, 'das groesste Thema hat den groessten Kreis');
  // Das groesste Thema startet in der Mitte; die Entspannung darf es nur ein Stueck schieben.
  const sx = list.reduce((s, p) => s + p.x, 0) / list.length;
  const sy = list.reduce((s, p) => s + p.y, 0) / list.length;
  assert.ok(Math.hypot(a.get(groesstes.id).x - sx, a.get(groesstes.id).y - sy) < canvas.THEMA_R_MAX * 1.5, 'das groesste Thema liegt nahe der Mitte der Karte');
  assert.equal(canvas.themaRadius(0, 100), canvas.THEMA_R_MIN);
  assert.equal(canvas.themaRadius(100, 100), canvas.THEMA_R_MAX);
  assert.ok(canvas.themaRadius(25, 100) > canvas.THEMA_R_MIN && canvas.themaRadius(25, 100) < canvas.THEMA_R_MAX);
  assert.equal(canvas.layoutThemen([]).size, 0);
  assert.equal(canvas.THEME_HUES.length, 8, 'acht Themen-Toene, Index 0-7 wie der Server');
});
