'use strict';

/**
 * Leistung des Wissensuniversums bei 10 000 Knoten (Vertrag F).
 *
 * Gemessen wird gegen die ECHTE Engine: 10 000 Notizen in 200 Schlagworten,
 * 20 Themenbegriffe, ein Ring aus 10 000 Links-Kanten plus 10 000
 * Schlagwort-Kanten -- also 20 000 Kanten. Die Zahlen werden ausgegeben,
 * nicht nur mit einer Grenze verglichen: "unter 300 ms" ist die Zusage,
 * die gemessene Zahl ist der Beweis.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const { Bus } = require('../src/kernel/bus');
const uni = require('../src/graph/universum');

const N = 10000;
const TAGS = 200;
const BEGRIFFE = 20;
const GRENZE_MS = 300;

test(`${N.toLocaleString('de-DE')} Knoten: GET /api/graph/universum (Ebene 0) unter ${GRENZE_MS} ms, Ebene 1 unter ${GRENZE_MS} ms, Cache unter 5 ms`, async () => {
  const { home, cleanup } = tempHome('uni-10k');
  const bus = new Bus();
  const store = await openStore({ paths: path.join(home, 'nos'), bus, lock: false });
  const anbindung = uni.attach({ store, bus, istAusgesetzt: () => true });
  try {
    const t0 = Date.now();
    const ids = [];
    const begriffe = [];
    store.transaction(() => {
      for (let i = 0; i < BEGRIFFE; i++) {
        begriffe.push(store.create('entity', { name: `Begriff ${i}`, kind: 'topic', description: `Thema ${i}.` }).id);
      }
      for (let i = 0; i < N; i++) {
        ids.push(store.create('note', {
          title: `Notiz ${i}`,
          // Ein Merkmal teilen je 25 Notizen: daran erkennen die Vorschlaege
          // Verwandte. Die Floskeln drumherum ("Inhalt", "Thema") stehen in
          // allen 10 000 und duerfen nichts verbinden (Runde 1).
          body: `Inhalt ${i} ueber Thema ${i % 37} und Begriff ${i % 53}. Merkmal Farbton${i % 400}.`,
          tags: [`thema${i % TAGS}`],
        }).id);
      }
    });
    store.transaction(() => {
      for (let i = 0; i < N; i++) {
        // Ring innerhalb des Schlagworts, dazu jede Notiz an einen Begriff.
        store.edges.add({ from: ids[i], to: ids[(i + TAGS) % N], kind: 'links-to', source: 'derived', reason: 'Ring' });
        store.edges.add({ from: ids[i], to: begriffe[i % BEGRIFFE], kind: 'tagged', source: 'derived', reason: 'Begriff' });
      }
    });
    const aufbauMs = Date.now() - t0;
    assert.equal(store.count('note'), N);
    assert.equal(store.count('edge'), 2 * N);

    // Kalt: bauen.
    const t1 = process.hrtime.bigint();
    const erste = uni.universum(store);
    const e0 = uni.ebene0(erste.u);
    const kaltMs = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.equal(erste.ausCache, false);
    assert.equal(e0.gesamt.knoten, N + BEGRIFFE);
    assert.equal(e0.gesamt.kanten, 2 * N);
    assert.ok(e0.themen.length <= uni.MAX_THEMEN, `${e0.themen.length} Kreise auf Ebene 0`);

    // Warm: aus dem Cache.
    const t2 = process.hrtime.bigint();
    const zweite = uni.universum(store);
    uni.ebene0(zweite.u);
    const warmMs = Number(process.hrtime.bigint() - t2) / 1e6;
    assert.equal(zweite.ausCache, true);

    // Ebene 1 fuer das groesste Thema.
    const groesstes = e0.themen[0];
    const t3 = process.hrtime.bigint();
    const e1 = uni.ebene1(zweite.u, groesstes.id);
    const ebene1Ms = Number(process.hrtime.bigint() - t3) / 1e6;
    assert.ok(e1.knoten.length >= 1);
    assert.ok(e1.knoten.filter((k) => !k.ausserhalb).length <= uni.MAX_KNOTEN, 'Ebene 1 haelt die Obergrenze');

    // Vorschlaege fuer eine Notiz: die Suche filtert vor, kein Vergleich mit allen 10 000.
    // Der erste Aufruf zaehlt einmal die Worthaeufigkeiten des Tresors (in der
    // Anwendung geschieht das 3 s nach dem Start im Hintergrund); gemessen und
    // begrenzt wird der Aufruf danach, so wie jedes Speichern ihn ausloest.
    const t40 = process.hrtime.bigint();
    uni.vorschlaegeFuer(store, ids[7]);
    const ersterVorschlagMs = Number(process.hrtime.bigint() - t40) / 1e6;
    const t4 = process.hrtime.bigint();
    const vorschlaege = uni.vorschlaegeFuer(store, ids[123]);
    const vorschlagMs = Number(process.hrtime.bigint() - t4) / 1e6;
    assert.ok(vorschlaege.length >= 1);
    for (const v of vorschlaege) {
      assert.match(v.grund, /Farbton123/, `nur das gemeinsame Merkmal verbindet, nicht die Floskeln: ${v.title}: ${v.grund}`);
    }

    const zahlen = {
      knoten: N + BEGRIFFE,
      kanten: 2 * N,
      themenEbene0: e0.themen.length,
      themenGesamt: e0.gesamt.themen,
      aufbauDesTresorsMs: aufbauMs,
      universumKaltMs: Math.round(kaltMs * 10) / 10,
      universumAusCacheMs: Math.round(warmMs * 100) / 100,
      ebene1Ms: Math.round(ebene1Ms * 10) / 10,
      groesstesThema: `${groesstes.name} (${groesstes.anzahl} Knoten, ${e1.kanten.length} Kanten)`,
      vorschlaegeMs: Math.round(vorschlagMs * 10) / 10,
      ersterVorschlagMitZaehlungMs: Math.round(ersterVorschlagMs * 10) / 10,
    };
    console.log(`    Leistung 10.000 Knoten: ${JSON.stringify(zahlen)}`);

    assert.ok(kaltMs < GRENZE_MS, `Universum kalt zu langsam: ${kaltMs.toFixed(1)} ms (Grenze ${GRENZE_MS} ms)`);
    assert.ok(ebene1Ms < GRENZE_MS, `Ebene 1 zu langsam: ${ebene1Ms.toFixed(1)} ms`);
    assert.ok(warmMs < 5, `aus dem Cache zu langsam: ${warmMs.toFixed(2)} ms`);
    assert.ok(vorschlagMs < GRENZE_MS, `Vorschlaege zu langsam: ${vorschlagMs.toFixed(1)} ms`);
    assert.ok(ersterVorschlagMs < 3 * GRENZE_MS, `erster Vorschlag samt Zaehlung zu langsam: ${ersterVorschlagMs.toFixed(1)} ms`);
  } finally {
    anbindung.detach();
    await store.close();
    cleanup();
  }
});
