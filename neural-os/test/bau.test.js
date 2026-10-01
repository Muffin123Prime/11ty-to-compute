'use strict';

/**
 * Die Bau-Kennung (src/kernel/bau.js): Welche Fassung des Programms läuft?
 *
 * Der Starter vergleicht seine Kennung mit der im Laufzettel und ersetzt eine
 * laufende andere Fassung (test/start-dienst.test.js). Hier: dieselben
 * Dateien ergeben dieselbe Kennung, jede Änderung eine andere -- und was
 * nicht zum Programm gehört, zählt nicht.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, tempHome } = require('./harness');

/** Jeder Aufruf ein frisches Modul: Die Kennung wird je Prozess gemerkt. */
function frisch() {
  delete require.cache[require.resolve('../src/kernel/bau')];
  return require('../src/kernel/bau');
}

function programm(wurzel, dateien) {
  for (const [rel, inhalt] of Object.entries(dateien)) {
    const ziel = path.join(wurzel, rel);
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    fs.writeFileSync(ziel, inhalt);
  }
}

const GRUND = {
  'package.json': '{"name":"neural-os","version":"0.1.0"}',
  'bin/neural-os.js': 'console.log(1);\n',
  'src/app.js': 'module.exports = {};\n',
  'web/index.html': '<!doctype html>\n',
};

test('Dieselben Dateien: dieselbe Kennung, auch an einem anderen Ort; jede Änderung: eine andere', () => {
  const a = tempHome('nos-bau-a');
  const b = tempHome('nos-bau-b');
  try {
    programm(a.home, GRUND);
    programm(b.home, GRUND);
    const ka = frisch().kennung({ wurzel: a.home });
    assert.match(ka, /^[0-9a-f]{16}$/);
    assert.equal(frisch().kennung({ wurzel: b.home }), ka, 'eine zweite entpackte Kopie ist dieselbe Fassung');

    // Ein Zeichen in web/ (gleiche Größe), eine neue Datei, ein umbenannter Pfad: jeweils eine andere Fassung.
    fs.writeFileSync(path.join(b.home, 'web', 'index.html'), '<!DOCTYPE html>\n');
    const kb = frisch().kennung({ wurzel: b.home });
    assert.notEqual(kb, ka);
    programm(b.home, { 'web/index.html': GRUND['web/index.html'], 'src/neu.js': '' });
    assert.notEqual(frisch().kennung({ wurzel: b.home }), ka, 'eine neue Datei');
    fs.rmSync(path.join(b.home, 'src', 'neu.js'));
    assert.equal(frisch().kennung({ wurzel: b.home }), ka, 'wieder wie vorher');
    fs.renameSync(path.join(b.home, 'src', 'app.js'), path.join(b.home, 'src', 'app2.js'));
    assert.notEqual(frisch().kennung({ wurzel: b.home }), ka, 'ein anderer Pfad');
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('Was nicht zum Programm gehört (Daten, Doku, Tests), ändert die Kennung nicht', () => {
  const a = tempHome('nos-bau-daten');
  try {
    programm(a.home, GRUND);
    const vorher = frisch().kennung({ wurzel: a.home });
    programm(a.home, { 'data/vault/x.jsonl': '{}', 'docs/ANLEITUNG.md': '# neu', 'test/x.test.js': '', 'README.md': 'neu' });
    assert.equal(frisch().kennung({ wurzel: a.home }), vorher);
  } finally {
    a.cleanup();
  }
});

test('Je Prozess einmal: Die Kennung des laufenden Codes ändert sich nicht, wenn danach Dateien überschrieben werden', () => {
  const a = tempHome('nos-bau-gemerkt');
  try {
    programm(a.home, GRUND);
    const bau = frisch();
    const erst = bau.kennung({ wurzel: a.home });
    fs.writeFileSync(path.join(a.home, 'src', 'app.js'), 'module.exports = { neu: true };\n');
    assert.equal(bau.kennung({ wurzel: a.home }), erst, 'der Dienst läuft mit dem Code, den er beim Start las');
    assert.notEqual(frisch().kennung({ wurzel: a.home }), erst, 'ein neuer Starter sieht die neuen Dateien');
  } finally {
    a.cleanup();
  }
});

test('Ohne Programmdateien keine Kennung: dann wird nichts ersetzt', () => {
  const leer = tempHome('nos-bau-leer');
  try {
    assert.equal(frisch().kennung({ wurzel: leer.home }), null);
    assert.equal(frisch().kennung({ wurzel: path.join(leer.home, 'gibt-es-nicht') }), null);
  } finally {
    leer.cleanup();
  }
});

test('Das echte Programm hat eine Kennung, und sie ist schnell gebildet', () => {
  const t0 = Date.now();
  const k = frisch().kennung();
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});
