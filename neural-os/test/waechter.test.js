'use strict';

/**
 * Paket S (docs/STICK-BAUPLAN.md, 2.4 Nr. 6): der Wächter im Dienst.
 *
 *  - Stick weg: zweimal hintereinander kein Marker -> sofort Ende, ohne flush.
 *  - Leerlauf: 10 min ohne offenen Tab (und nach 5 min Schonfrist) -> beenden('leerlauf').
 *  - Ein Zeitsprung (Ruhezustand) setzt den Zähler zurück.
 *
 * Uhr, Zeitgeber und fs sind Attrappen; kein Test wartet echte Minuten.
 */

const assert = require('node:assert/strict');
const { test } = require('./harness');

function waechter() {
  return require('../src/kernel/waechter');
}

const MIN = 60 * 1000;

/** Uhr zum Vorstellen, Zeitgeber, die nie von selbst feuern. */
function attrappen({ start = 1_800_000_000_000, aktivitaet } = {}) {
  let jetzt = start;
  const zeitgeber = [];
  const aufrufe = { beenden: [], ende: [] };
  const statFehler = [];
  return {
    aufrufe,
    statFehler,
    vor(ms) { jetzt += ms; },
    get jetzt() { return jetzt; },
    optionen: {
      marker: '/stick/neural-os.portable',
      aktivitaet: () => aktivitaet(jetzt),
      beenden: (grund) => { aufrufe.beenden.push(grund); },
      ende: (code) => { aufrufe.ende.push(code); },
      jetzt: () => jetzt,
      setInterval: (fn, ms) => { const h = { fn, ms }; zeitgeber.push(h); return h; },
      clearInterval: (h) => { const i = zeitgeber.indexOf(h); if (i >= 0) zeitgeber.splice(i, 1); },
      stat: async () => {
        const naechster = statFehler.shift();
        if (naechster) {
          const err = new Error(`${naechster}: weg`);
          err.code = naechster;
          throw err;
        }
        return { isFile: () => true };
      },
    },
    zeitgeber,
  };
}

test('Stick weg: zweimal ENOENT hintereinander -> sofort Ende mit 0, einmal reicht nicht', async () => {
  const a = attrappen({ aktivitaet: (t) => ({ streams: 1, inFlight: 0, letzteAnfrage: t }) });
  const w = waechter().starte(a.optionen);
  try {
    assert.equal(a.zeitgeber.length, 2, 'ein Zeitgeber für den Stick, einer für den Leerlauf');
    const stickTakt = a.zeitgeber.find((z) => z.ms === 2000);
    assert.ok(stickTakt, 'der Stick wird alle 2 s geprüft');
    assert.ok(a.zeitgeber.find((z) => z.ms === 15000), 'der Leerlauf alle 15 s');

    a.statFehler.push('ENOENT');
    await w.pruefeStick();
    assert.deepEqual(a.aufrufe.ende, [], 'ein einzelner Aussetzer beendet nichts');
    await w.pruefeStick(); // wieder da
    a.statFehler.push('EIO');
    await w.pruefeStick();
    assert.deepEqual(a.aufrufe.ende, []);
    a.statFehler.push('ENOENT');
    await w.pruefeStick();
    assert.deepEqual(a.aufrufe.ende, [0], 'zweimal hintereinander weg: Ende mit 0');
    assert.deepEqual(a.aufrufe.beenden, [], 'ohne beenden(), also ohne flush auf einen Stick, der fehlt');
  } finally {
    w.stoppe();
  }
  assert.equal(a.zeitgeber.length, 0, 'stoppe() räumt beide Zeitgeber ab');
});

test('Stick: andere Fehler (EACCES) zählen nicht als "weg"; ohne Marker gibt es keinen Stick-Wächter', async () => {
  const a = attrappen({ aktivitaet: (t) => ({ streams: 1, inFlight: 0, letzteAnfrage: t }) });
  const w = waechter().starte(a.optionen);
  try {
    a.statFehler.push('EACCES', 'EACCES', 'EACCES');
    await w.pruefeStick();
    await w.pruefeStick();
    await w.pruefeStick();
    assert.deepEqual(a.aufrufe.ende, []);
  } finally {
    w.stoppe();
  }

  const b = attrappen({ aktivitaet: (t) => ({ streams: 1, inFlight: 0, letzteAnfrage: t }) });
  const w2 = waechter().starte({ ...b.optionen, marker: null });
  try {
    assert.equal(b.zeitgeber.length, 1, 'Heim-Installation: nur der Leerlauf');
  } finally {
    w2.stoppe();
  }
});

test('Leerlauf: 10 min ohne Tab -> beenden("leerlauf"), genau einmal', () => {
  const start = 1_800_000_000_000;
  const a = attrappen({ start, aktivitaet: () => ({ streams: 0, inFlight: 0, letzteAnfrage: start }) });
  const w = waechter().starte(a.optionen);
  try {
    // 9:45 min: noch nichts.
    for (let t = 0; t < 39; t++) { a.vor(15000); w.pruefeLeerlauf(); }
    assert.deepEqual(a.aufrufe.beenden, []);
    // Über 10 min.
    for (let t = 0; t < 3; t++) { a.vor(15000); w.pruefeLeerlauf(); }
    assert.deepEqual(a.aufrufe.beenden, ['leerlauf']);
    for (let t = 0; t < 4; t++) { a.vor(15000); w.pruefeLeerlauf(); }
    assert.deepEqual(a.aufrufe.beenden, ['leerlauf'], 'nicht mehrfach');
  } finally {
    w.stoppe();
  }
});

test('Leerlauf: 5 min Schonfrist nach dem Start, auch wenn die letzte Anfrage lange her ist', () => {
  const start = 1_800_000_000_000;
  const a = attrappen({ start, aktivitaet: () => ({ streams: 0, inFlight: 0, letzteAnfrage: start - 60 * MIN }) });
  const w = waechter().starte(a.optionen);
  try {
    for (let t = 0; t < 19; t++) { a.vor(15000); w.pruefeLeerlauf(); } // 4:45 min
    assert.deepEqual(a.aufrufe.beenden, []);
    for (let t = 0; t < 2; t++) { a.vor(15000); w.pruefeLeerlauf(); }
    assert.deepEqual(a.aufrufe.beenden, ['leerlauf']);
  } finally {
    w.stoppe();
  }
});

test('Leerlauf: inFlight > 0 oder ein offener Tab -> kein Ende', () => {
  const start = 1_800_000_000_000;
  for (const akt of [{ streams: 0, inFlight: 1 }, { streams: 2, inFlight: 0 }]) {
    const a = attrappen({ start, aktivitaet: () => ({ ...akt, letzteAnfrage: start }) });
    const w = waechter().starte(a.optionen);
    try {
      for (let t = 0; t < 80; t++) { a.vor(15000); w.pruefeLeerlauf(); } // 20 min
      assert.deepEqual(a.aufrufe.beenden, [], JSON.stringify(akt));
    } finally {
      w.stoppe();
    }
  }
});

test('Leerlauf: ein Zeitsprung über 60 s (Ruhezustand) setzt den Zähler zurück', () => {
  const start = 1_800_000_000_000;
  const a = attrappen({ start, aktivitaet: () => ({ streams: 0, inFlight: 0, letzteAnfrage: start }) });
  const w = waechter().starte(a.optionen);
  try {
    for (let t = 0; t < 36; t++) { a.vor(15000); w.pruefeLeerlauf(); } // 9 min
    a.vor(3 * 60 * MIN); // Deckel zu, drei Stunden
    w.pruefeLeerlauf();
    assert.deepEqual(a.aufrufe.beenden, [], 'nach dem Aufwachen nicht sofort beenden');
    for (let t = 0; t < 38; t++) { a.vor(15000); w.pruefeLeerlauf(); } // 9:30 min nach dem Sprung
    assert.deepEqual(a.aufrufe.beenden, []);
    for (let t = 0; t < 4; t++) { a.vor(15000); w.pruefeLeerlauf(); }
    assert.deepEqual(a.aufrufe.beenden, ['leerlauf'], '10 min nach dem Aufwachen ist Schluss');
  } finally {
    w.stoppe();
  }
});
