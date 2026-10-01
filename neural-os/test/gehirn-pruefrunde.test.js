'use strict';

/**
 * Pruefrunde Gehirn, Runde 2 (Befunde 1-15 des Pruefers vom 01.10.2026).
 *
 * Drei Arten von Belegen, je nachdem, wo der Fehler sass:
 *   - Reine Funktionen aus web/lib/universum.js (Rueckweg, Pfad, Eingabetaste
 *     in der Suche, Behaelter, Zaehlung) -- wie test/gehirn-ansicht.test.js
 *     als .mjs-Kopie des unveraenderten Quelltexts geladen.
 *   - Der Zeichner (web/lib/graph-canvas.js) auf einer Attrappe der Leinwand:
 *     Ziehen auf Ebene 0, Groesse der Behaelter, neue Lage beim Nachladen.
 *     Die Attrappe ersetzt nur den Browser (2D-Kontext, Zeiger, Bilder);
 *     gerechnet wird mit dem echten Code.
 *   - Der Server durch die echte Tuer (HTTP): Umfeld eines Chats mit vielen
 *     Nachrichten, "Verknuepft mit" nur mit Wissen, dieselben Arten fuer
 *     kleinen Tresor und Server.
 * Was nur im Browser zu sehen ist (Ueberblenden, Karte unten/rechts, Rennen
 * zwischen Wechsel und Nachladen), belegen die Pruefskripte mit Chromium.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

/* ------------------------------------------------------------ Laden */

let geladen = null;
async function laden() {
  if (geladen) return geladen;
  const web = path.join(__dirname, '..', 'web');
  const { home, cleanup } = tempHome('nos-gehirn-pruefrunde');
  const alsModul = (src) => src.replace(/(from\s+')([^']+)\.js(')/g, (m, kopf, spec, ende) => `${kopf}./${path.basename(spec)}.mjs${ende}`);
  for (const datei of fs.readdirSync(path.join(web, 'lib'))) {
    if (datei.endsWith('.js')) fs.writeFileSync(path.join(home, datei.replace(/\.js$/, '.mjs')), alsModul(fs.readFileSync(path.join(web, 'lib', datei), 'utf8')));
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

/* ------------------------------------------- Attrappe der Leinwand */

/**
 * Gerade so viel Browser, wie createGraphCanvas braucht: ein 2D-Kontext, der
 * alles schluckt, Zeiger-Ereignisse zum Ausloesen und Bilder, die der Test
 * selbst abspielt (mit einer Uhr, die er vorstellt).
 */
async function mitLeinwand(fn, { breite = 800, hoehe = 600 } = {}) {
  const namen = ['window', 'document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const vorher = new Map(namen.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const bilder = [];
  const hoerer = new Map();
  const kontext = new Proxy({ fillStyle: '#000000', strokeStyle: '#000000' }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 7 });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const leinwand = {
    nodeType: 1,
    parentElement: null,
    style: {},
    width: 0,
    height: 0,
    getContext: () => kontext,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: breite, bottom: hoehe, width: breite, height: hoehe }),
    addEventListener: (typ, f) => { if (!hoerer.has(typ)) hoerer.set(typ, []); hoerer.get(typ).push(f); },
    removeEventListener: () => {},
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  kontext.canvas = leinwand;
  const setze = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  setze('window', { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) });
  setze('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  setze('getComputedStyle', () => ({ getPropertyValue: () => '', backgroundColor: 'rgb(9, 10, 10)', fontFamily: 'sans-serif' }));
  setze('requestAnimationFrame', (f) => { bilder.push(f); return bilder.length; });
  setze('cancelAnimationFrame', () => {});
  /** Alle wartenden Bilder zeichnen, als waeren `ms` vergangen. */
  const abspielen = (ms = 2000) => {
    const jetzt = performance.now() + ms;
    for (let runde = 0; runde < 60 && bilder.length; runde++) for (const f of bilder.splice(0)) f(jetzt);
  };
  const zeiger = (typ, x, y, extra = {}) => {
    for (const f of hoerer.get(typ) || []) f({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, preventDefault() {}, ...extra });
  };
  try {
    return await fn({ leinwand, abspielen, zeiger });
  } finally {
    for (const [k, d] of vorher) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
}

/** Themen-Kreise mit der Lage, die die Ansicht rechnet (wie views/graph.js themenZeichnen). */
function kreiseMitLage(canvas, themen, links = []) {
  const lage = canvas.layoutThemen(themen, links);
  return themen.map((t) => ({ ...t, label: t.id, x: lage.get(t.id).x, y: lage.get(t.id).y, kinder: [], knoten: [] }));
}

/* ----------------------------------------------- reine Funktionen */

test('Befund 2: im kleinen Tresor fuehrt aus Umfeld und Thema ein Weg zurueck, der Pfad sagt "Mein Wissen › Thema"', async () => {
  const { universum: u } = await laden();
  const klein = { ebene: 1, klein: true, einThemaId: null, thema: null, pfad: [], fokusId: null, unter: null };
  // An der Wurzel (das ganze Netz) geht es nicht hoeher.
  assert.equal(u.hochZiel(klein), null);
  assert.equal(u.istWurzelNetz(klein), true);
  assert.deepEqual(u.krumenFuer(klein).map((k) => k.name), ['Mein Wissen']);
  // Ein Umfeld (Kachel "Gehirn", [Umfeld], Doppeltipp auf einen Begriff): zurueck zur Wurzel.
  const umfeld = { ...klein, fokusId: 'project_start', fokusName: 'Mein erstes Projekt' };
  assert.deepEqual(u.hochZiel(umfeld), { art: 'wurzel' });
  assert.deepEqual(u.krumenFuer(umfeld).map((k) => [k.id, k.name]), [[null, 'Mein Wissen'], ['__fokus', 'Mein erstes Projekt']]);
  // Ein Thema (Themen-Chip, Suche, Karte): es heisst nicht mehr selbst "Mein Wissen".
  const thema = { ...klein, thema: { id: 'thema:biologie', name: 'Biologie', anzahl: 2 } };
  assert.equal(u.istWurzelNetz(thema), false);
  assert.deepEqual(u.hochZiel(thema), { art: 'wurzel' });
  assert.deepEqual(u.krumenFuer(thema).map((k) => [k.id, k.name]), [[null, 'Mein Wissen'], ['thema:biologie', 'Biologie']]);
  // Ein Unterthema: eine Ebene hoch ist das Elternthema.
  const kind = { ...thema, thema: { id: 'thema:genetik', name: 'Genetik' }, pfad: [{ id: 'thema:biologie', name: 'Biologie' }] };
  assert.deepEqual(u.hochZiel(kind), { art: 'eltern', id: 'thema:biologie' });
  assert.deepEqual(u.krumenFuer(kind).map((k) => k.name), ['Mein Wissen', 'Biologie', 'Genetik']);

  // Das Universum (Ebene 0) und der Behaelter darin bleiben, wie sie waren.
  const uni = { ebene: 0, klein: false, einThemaId: null, thema: null, pfad: [], fokusId: null, unter: null };
  assert.equal(u.hochZiel(uni), null);
  assert.deepEqual(u.hochZiel({ ...uni, unter: { id: 'weitere', name: 'Weitere Themen' } }), { art: 'wurzel' });
  assert.deepEqual(u.krumenFuer({ ...uni, unter: { id: 'weitere', name: 'Weitere Themen' } }).map((k) => k.name), ['Mein Wissen', 'Weitere Themen']);
  assert.deepEqual(u.hochZiel({ ...uni, ebene: 1, thema: { id: 'thema:schule', name: 'Schule' } }), { art: 'wurzel' });
  // Ein einziges Thema ist selbst die Wurzel; sein Kind fuehrt zu ihm zurueck, ohne es doppelt zu nennen.
  const eins = { ...uni, ebene: 1, einThemaId: 'thema:schule', thema: { id: 'thema:schule', name: 'Schule' } };
  assert.equal(u.hochZiel(eins), null);
  assert.deepEqual(u.krumenFuer(eins).map((k) => k.name), ['Mein Wissen']);
  const einsKind = { ...eins, thema: { id: 'thema:bio', name: 'Biologie' }, pfad: [{ id: 'thema:schule', name: 'Schule' }] };
  assert.deepEqual(u.hochZiel(einsKind), { art: 'eltern', id: 'thema:schule' });
  assert.deepEqual(u.krumenFuer(einsKind).map((k) => k.name), ['Mein Wissen', 'Biologie']);
  assert.equal(u.hochZiel(null), null);
});

test('Befund 12: die Eingabetaste springt nur zu Treffern DIESER Anfrage -- sonst wartet sie auf den Server', async () => {
  const { universum: u } = await laden();
  const zahnarzt = { id: 'note_zahn', label: 'Zahnarzt-Termin', type: 'note' };
  const photo = { id: 'note_photo', label: 'Photosynthese', type: 'note' };
  // "Zahnarzt" gesucht, Feld geleert, "Photosynthese" eingefuegt, sofort Enter:
  // die Treffer des Servers gehoeren noch zu "Zahnarzt".
  const alt = { ebene: 0, query: 'Photosynthese', matches: [], fernThemen: [], fernTreffer: [zahnarzt], fernFuer: 'Zahnarzt' };
  assert.deepEqual(u.sprungZiel(alt), { art: 'warten' });
  // Sind sie da (dieselbe Anfrage), geht es ins Umfeld des ersten.
  assert.deepEqual(u.sprungZiel({ ...alt, fernTreffer: [photo], fernFuer: 'Photosynthese' }), { art: 'umfeld', id: 'note_photo' });
  // Der Server fand nichts: kein Sprung, schon gar nicht zum alten Treffer.
  assert.equal(u.sprungZiel({ ...alt, fernTreffer: [], fernFuer: 'Photosynthese' }), null);
  // Treffer hier (Ebene 1) und Themen (Ebene 0) brauchen den Server nicht.
  assert.deepEqual(u.sprungZiel({ ...alt, ebene: 1, matches: [photo] }), { art: 'waehlen', id: 'note_photo' });
  const bio = { thema: { id: 'thema:biologie', name: 'Biologie' }, kinder: [] };
  assert.deepEqual(u.sprungZiel({ ...alt, query: 'Bio', fernThemen: [bio] }), { art: 'thema', id: 'thema:biologie' });
  // Ebene 1 ohne Treffer hier: erst die Eintraege des Servers, sonst das Thema.
  assert.deepEqual(u.sprungZiel({ ebene: 1, query: 'Bio', matches: [], fernThemen: [bio], fernTreffer: [], fernFuer: 'Bio' }), { art: 'thema', id: 'thema:biologie' });
  assert.deepEqual(u.sprungZiel({ ebene: 1, query: 'Bio', matches: [], fernThemen: [bio], fernTreffer: [], fernFuer: null }), { art: 'warten' });
  // Ein Zeichen fragt den Server nicht: nichts, worauf zu warten waere.
  assert.equal(u.sprungZiel({ ebene: 0, query: 'P', fernFuer: null }), null);
  assert.equal(u.sprungZiel({ ebene: 0, query: '   ' }), null);
});

test('Befund 11: ein Eintrag aus "Weitere Themen" oeffnet sein eigenes Thema, nicht die Kreise des Behaelters', async () => {
  const { universum: u } = await laden();
  const behaelter = { id: 'weitere', kinder: [{ id: 'thema:t37' }, { id: 'thema:t38' }] };
  assert.equal(u.themaFuerEintrag({ id: 'n', themen: ['thema:t37'] }, 'weitere', behaelter), 'thema:t37');
  assert.equal(u.themaFuerEintrag({ id: 'n', themen: ['thema:gross', 'thema:t38'] }, 'weitere', behaelter), 'thema:t38', 'zuerst ein Kind des Behaelters');
  assert.equal(u.themaFuerEintrag({ id: 'n', themen: ['weitere', 'thema:x'] }, 'weitere', behaelter), 'thema:x');
  assert.equal(u.themaFuerEintrag({ id: 'n', themen: [] }, 'weitere', behaelter), null, 'ohne eigenes Thema: das Umfeld');
  // Ein gewoehnliches Thema bleibt, wie es ist.
  assert.equal(u.themaFuerEintrag({ id: 'n', themen: ['thema:t37'] }, 'thema:biologie', behaelter), 'thema:biologie');
  assert.equal(u.themaFuerEintrag({ id: 'n' }, null), null);
});

test('Befund 7: ein Behaelter zeigt hoechstens 40 Kreise -- die groessten -- und ihre Lage ist schnell', async () => {
  const { universum: u, canvas } = await laden();
  const kinder = Array.from({ length: 400 }, (_, i) => ({ id: `thema:s${i}`, name: `Schlagwort ${i}`, anzahl: 2 + (i % 7) }));
  const kreise = u.behaelterKreise({ id: 'weitere', kinder });
  assert.equal(kreise.length, u.BEHAELTER_MAX);
  assert.equal(u.BEHAELTER_MAX, 40);
  const kleinste = Math.min(...kreise.map((k) => k.anzahl));
  assert.ok(kinder.filter((k) => !kreise.includes(k)).every((k) => k.anzahl <= kleinste), 'es fehlen nur kleinere');
  assert.deepEqual(u.behaelterKreise({ kinder: kinder.slice(0, 12) }), kinder.slice(0, 12), 'bis 40 bleibt alles, in seiner Reihenfolge');
  assert.deepEqual(u.behaelterKreise(null), []);
  // Vorher: 400 Kreise, ~0,9 s auf dem Hauptfaden (bench-layout: 600 Kreise 3,3 s).
  const t0 = performance.now();
  const lage = canvas.layoutThemen(kreise, []);
  const ms = performance.now() - t0;
  assert.equal(lage.size, 40);
  assert.ok(ms < 400, `die Lage von 40 Kreisen dauerte ${Math.round(ms)} ms`);
});

test('Befund 15: Kopf und Pfad zaehlen dieselben Eintraege; Browser und Server kennen dieselben Arten', async () => {
  const { universum: u } = await laden();
  const nodes = [
    { id: 'a', type: 'note' }, { id: 'b', type: 'task' }, { id: 'c', type: 'run' },
    { id: 'd', type: 'note', ausserhalb: true }, null,
  ];
  assert.equal(u.eintraegeDrin(nodes), 3);
  assert.equal(u.eintraegeDrin(nodes, new Set(['run'])), 2, 'ausgeblendete Arten zaehlen nicht');
  assert.equal(u.eintraegeDrin(null), 0);
  const server = require('../src/graph/universum');
  assert.deepEqual([...u.UNIVERSUM_TYPEN].sort(), [...server.TYPEN].sort(), 'web/lib/universum.js und src/graph/universum.js: dieselben Arten');
  assert.ok(!u.UNIVERSUM_TYPEN.includes('run') && !u.UNIVERSUM_TYPEN.includes('agent') && !u.UNIVERSUM_TYPEN.includes('message'));
});

/* ----------------------------------------------- der Zeichner */

test('Befund 10: Behaelter werden so gross gezeichnet, wie die Lage sie rechnet -- nie groesser als das groesste Thema', async () => {
  const { canvas } = await laden();
  await mitLeinwand(async ({ leinwand, abspielen }) => {
    const c = canvas.createGraphCanvas(leinwand, { themen: true });
    // Wie im Pruefskript t4: das groesste echte Thema hat 10, "Weitere" 69, "Unverbunden" 120.
    const themen = [
      { id: 'thema:gross', anzahl: 10 },
      { id: 'thema:klein', anzahl: 3 },
      { id: 'weitere', anzahl: 69, groesse: 10, rand: true },
      { id: 'unverbunden', anzahl: 120, groesse: 10, rand: true },
    ];
    c.setData({ nodes: kreiseMitLage(canvas, themen), edges: [] });
    c.fitToView({ animate: false });
    abspielen();
    const r = (id) => c.screenPosition(id).r;
    assert.ok(r('weitere') <= r('thema:gross') + 0.01, `Weitere ${r('weitere').toFixed(1)} px > groesstes Thema ${r('thema:gross').toFixed(1)} px`);
    assert.ok(r('unverbunden') <= r('thema:gross') + 0.01, `Unverbunden ${r('unverbunden').toFixed(1)} px > groesstes Thema ${r('thema:gross').toFixed(1)} px`);
    assert.ok(r('thema:klein') < r('thema:gross'));
    // Lage und Zeichnung rechnen mit demselben Radius.
    const lage = canvas.layoutThemen(themen);
    const k = c.transform.k;
    for (const t of themen) assert.ok(Math.abs(r(t.id) - lage.get(t.id).r * k) < 0.01, `${t.id}: gezeichnet ${r(t.id)}, Lage ${lage.get(t.id).r * k}`);
    c.destroy();
  });
  // Beide fragen dieselbe Groesse: gekappt, wo die Ansicht kappt.
  assert.equal(canvas.themaGroesse({ anzahl: 69, groesse: 10 }), 10);
  assert.equal(canvas.themaGroesse({ anzahl: 7 }), 7);
  assert.equal(canvas.themaGroesse(null), 0);
});

test('Befund 4: auf Ebene 0 verschiebt ein Zug, der auf einem Kreis beginnt, die Ansicht -- kein Kreis wandert, keine Kraefte', async () => {
  const { canvas } = await laden();
  await mitLeinwand(async ({ leinwand, abspielen, zeiger }) => {
    const gewaehlt = [];
    const c = canvas.createGraphCanvas(leinwand, { themen: true, onSelect: (n) => gewaehlt.push(n && n.id) });
    const themen = ['schule', 'kochen', 'reisen', 'garten'].map((t) => ({ id: `thema:${t}`, anzahl: 4 }));
    c.setData({ nodes: kreiseMitLage(canvas, themen), edges: [] });
    c.fitToView({ animate: false });
    abspielen();
    const lage = () => Object.fromEntries(themen.map((t) => [t.id, c.screenPosition(t.id)]));
    const a = lage();
    const start = a['thema:schule'];
    // Maus: auf dem Kreis druecken, 150 px nach rechts und 40 nach unten ziehen, loslassen (wie t17).
    zeiger('pointerdown', start.x, start.y);
    for (let i = 1; i <= 10; i++) { zeiger('pointermove', start.x + i * 15, start.y + i * 4); abspielen(16 * i); }
    zeiger('pointerup', start.x + 150, start.y + 40);
    abspielen(3000);
    const b = lage();
    for (const t of themen) {
      assert.ok(Math.abs(b[t.id].x - a[t.id].x - 150) < 0.5 && Math.abs(b[t.id].y - a[t.id].y - 40) < 0.5,
        `${t.id} ist anders gewandert als die Ansicht: (${(b[t.id].x - a[t.id].x).toFixed(1)}, ${(b[t.id].y - a[t.id].y).toFixed(1)})`);
    }
    assert.equal(c.stats().running, false, 'die Kraefte laufen nicht an');
    assert.deepEqual(gewaehlt, [], 'ein Zug ist kein Antippen');
    // Antippen bleibt Antippen: der Kreis unter dem Finger wird gemeldet (die Ansicht taucht hinein).
    const p = c.screenPosition('thema:kochen');
    zeiger('pointerdown', p.x, p.y);
    zeiger('pointerup', p.x, p.y);
    assert.deepEqual(gewaehlt, ['thema:kochen']);
    c.destroy();
  });
});

test('Befund 14: beim Nachladen gleiten bekannte Kreise weich an die neue Lage -- danach ueberlappt nichts', async () => {
  const { canvas } = await laden();
  await mitLeinwand(async ({ leinwand, abspielen }) => {
    const c = canvas.createGraphCanvas(leinwand, { themen: true });
    // Wie t12: sechs gleich kleine Themen; dann waechst "alpha" stark, zwei neue kommen dazu.
    const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const vorher = tags.map((t) => ({ id: `thema:${t}`, anzahl: 3 }));
    c.setData({ nodes: kreiseMitLage(canvas, vorher), edges: [] });
    c.fitToView({ animate: false });
    abspielen();
    const welt = (id) => { const p = c.screenPosition(id); const t = c.transform; return { x: (p.x - t.x) / t.k, y: (p.y - t.y) / t.k, r: p.r / t.k }; };
    const alt = Object.fromEntries(vorher.map((t) => [t.id, welt(t.id)]));

    const nachher = [{ id: 'thema:alpha', anzahl: 63 }, ...vorher.slice(1), { id: 'thema:eta', anzahl: 3 }, { id: 'thema:theta', anzahl: 3 }];
    const neu = kreiseMitLage(canvas, nachher);
    c.setData({ nodes: neu, edges: [] });
    // Im ersten Augenblick steht jeder bekannte Kreis noch dort, wo man ihn sah -- kein Sprung.
    for (const t of vorher) {
      const w = welt(t.id);
      assert.ok(Math.abs(w.x - alt[t.id].x) < 1e-6 && Math.abs(w.y - alt[t.id].y) < 1e-6, `${t.id} sprang`);
    }
    abspielen(3000);
    // Danach liegt jeder Kreis an der neu gerechneten Stelle ...
    for (const n of neu) {
      const w = welt(n.id);
      assert.ok(Math.abs(w.x - n.x) < 1e-6 && Math.abs(w.y - n.y) < 1e-6, `${n.id} liegt nicht an seiner neuen Stelle`);
    }
    // ... und keiner auf einem anderen (vorher: "thema:eta~thema:gamma (Abstand 69, Radien 54+54)").
    const ids = neu.map((n) => n.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const p = welt(ids[i]);
        const q = welt(ids[j]);
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        assert.ok(d >= p.r + q.r - 0.5, `${ids[i]} und ${ids[j]} ueberlappen (Abstand ${d.toFixed(1)}, Radien ${p.r.toFixed(1)} + ${q.r.toFixed(1)})`);
      }
    }
    // Dieselben Daten noch einmal: nichts bewegt sich.
    const ruhig = Object.fromEntries(ids.map((id) => [id, welt(id)]));
    c.setData({ nodes: kreiseMitLage(canvas, nachher), edges: [] });
    for (const id of ids) assert.ok(Math.abs(welt(id).x - ruhig[id].x) < 1e-6, `${id} bewegte sich ohne Grund`);
    c.destroy();
  });
});

/* ----------------------------------------------- der Server */

function anfrage(base, urlPfad) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPfad, base);
    const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, timeout: 10000 }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => {
        const textAntwort = Buffer.concat(teile).toString('utf8');
        let json = null;
        try { json = textAntwort ? JSON.parse(textAntwort) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, text: textAntwort, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${urlPfad}: keine Antwort nach 10 s`)));
    req.on('error', reject);
  });
}

async function mitApp(fn) {
  const { createApp } = require('../src/app');
  const { home, cleanup } = tempHome('nos-gehirn-pruefrunde-app');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    return await fn({ app, store: app.store, base, get: async (p) => {
      const res = await anfrage(base, p);
      assert.equal(res.status, 200, `GET ${p}: HTTP ${res.status} ${(res.text || '').slice(0, 200)}`);
      return res.json;
    } });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
}

async function chatMitNachrichten(app, store, titel, anzahl) {
  const chat = store.create('chat', { title: titel });
  await app.bulkWrite(async () => {
    store.transaction(() => {
      for (let i = 0; i < anzahl; i++) store.create('message', { chatId: chat.id, role: i % 2 ? 'assistant' : 'user', content: `Nachricht ${i}` });
    });
  }, { rederive: true });
  return chat;
}

test('Befund 8: das Umfeld eines Chats mit 450 Nachrichten zeigt die Notizen daraus, nicht nur den Chat', async () => {
  const { universum: u } = await laden();
  await mitApp(async ({ app, store, get }) => {
    const chat = await chatMitNachrichten(app, store, 'Lernplan Abitur', 450);
    // Danach legt die KI aus dem Gespraech Notizen an (notiz_anlegen setzt chatId).
    const notizen = [];
    for (let i = 0; i < 3; i++) notizen.push(store.create('note', { title: `Lernzettel ${i}`, body: 'x', chatId: chat.id, tags: ['abitur'] }));
    assert.ok(store.edges.for(chat.id, { direction: 'both' }).length >= 453, 'die Nachrichten haengen am Chat');
    // So fragt die Ansicht (web/views/graph.js ladeUmfeld) -- und so ohne Arten (Standard: alle Graph-Arten).
    for (const arten of [`&types=${u.UNIVERSUM_TYPEN.join(',')}`, '']) {
      const g = await get(`/api/graph?focus=${chat.id}&depth=2&limit=400&includeOrphans=true${arten}`);
      const ids = g.nodes.map((n) => n.id);
      for (const n of notizen) assert.ok(ids.includes(n.id), `${arten ? 'mit' : 'ohne'} Arten: Notiz ${n.data.title} fehlt im Umfeld (${g.nodes.length} Knoten)`);
      assert.ok(!g.nodes.some((n) => n.type === 'message'), 'Nachrichten sind keine Knoten');
      assert.equal(g.truncated, false, 'das Limit wurde nicht mit Nachrichten gefuellt');
      assert.equal(g.edges.length, 3, 'drei Linien: Notiz -> Chat');
    }
    // Der Graph selbst, ohne HTTP: dieselbe Breitensuche.
    const view = require('../src/graph/view');
    const direkt = view.buildGraph(store, { focus: chat.id, depth: 2, limit: 400 });
    assert.equal(direkt.nodes.length, 4);
  });
});

test('Befund 9: "Verknuepft mit" nennt nur Wissen -- keine Nachrichten, keine Laeufe; die Grenze gilt nach dem Filtern', async () => {
  await mitApp(async ({ app, store, get }) => {
    // 520 Nachrichten zuerst (die aeltesten Kanten), die Notiz danach: frueher verdraengten sie sie.
    const chat = await chatMitNachrichten(app, store, 'Zahnarzt-Fragen', 520);
    const notiz = store.create('note', { title: 'Zahnarzt: Fragen für heute', body: 'Aus dem Chat', chatId: chat.id, tags: ['alltag'] });
    const v = await get(`/api/records/${chat.id}/verknuepft`);
    assert.deepEqual(v.eingehend.map((r) => [r.id, r.type]), [[notiz.id, 'note']], `eingehend: ${v.eingehend.length} Zeilen`);
    assert.deepEqual(v.ausgehend, []);

    // Ein Lauf, der die Notiz angelegt hat: Buchhaltung des Agenten, kein Wissen.
    const agent = store.create('agent', { name: 'Ordner' });
    const lauf = store.create('run', { agentId: agent.id, goal: 'Fragen sammeln', status: 'done' });
    store.edges.add({ from: notiz.id, to: lauf.id, kind: 'derived-from', source: 'agent', reason: 'Vom Agenten angelegt' });
    const n = await get(`/api/records/${notiz.id}/verknuepft`);
    const alle = [...n.eingehend, ...n.ausgehend];
    assert.ok(alle.some((r) => r.id === chat.id && r.type === 'chat'), 'der Chat bleibt');
    assert.ok(!alle.some((r) => r.type === 'run' || r.type === 'agent' || r.type === 'message'), JSON.stringify(alle.map((r) => r.type)));

    // Dieselben Zeilen gehen als Nachbarn in die KI-Zusammenfassung.
    const { verknuepfungenVon } = require('../src/http/api/graph');
    const server = require('../src/graph/universum');
    const z = verknuepfungenVon(store, chat.id);
    assert.equal(z.eingehend.length + z.ausgehend.length, 1);
    for (const r of [...z.eingehend, ...z.ausgehend]) assert.ok(server.TYPEN.includes(r.type));
  });
});

test('Befund 15: im kleinen Tresor zeigt das Netz genau die Eintraege, die der Server zaehlt -- ohne Agenten und Laeufe', async () => {
  const { universum: u } = await laden();
  const { seedIfEmpty } = require('../src/app');
  await mitApp(async ({ app, store, get }) => {
    await seedIfEmpty(app);
    const agent = store.list('agent', {}).items[0];
    for (let i = 0; i < 20; i++) store.create('run', { agentId: agent.id, goal: `Lauf ${i}`, status: 'done' });
    const e0 = await get('/api/graph/universum?tiefe=0');
    assert.ok(e0.gesamt.knoten > 0 && e0.gesamt.knoten < u.KLEIN_AB, `ein kleiner Tresor (${e0.gesamt.knoten})`);
    // So laedt die Ansicht das ganze Netz eines kleinen Tresors (ladeAlles).
    const g = await get(`/api/graph?limit=2500&includeOrphans=true&types=${u.UNIVERSUM_TYPEN.join(',')}`);
    assert.equal(g.nodes.length, e0.gesamt.knoten, `Netz ${g.nodes.length}, Server ${e0.gesamt.knoten}`);
    assert.ok(!g.nodes.some((n) => n.type === 'agent' || n.type === 'run'));
    assert.equal(u.eintraegeDrin(g.nodes, new Set(['run'])), e0.gesamt.knoten, 'Kopf und Pfad zaehlen dasselbe');
    // Vorher (ohne Arten) kamen die eingebauten Agenten und ihre Laeufe mit.
    const ohne = await get('/api/graph?limit=2500&includeOrphans=true');
    assert.ok(ohne.nodes.length > e0.gesamt.knoten);
  });
});
