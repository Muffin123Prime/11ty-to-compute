'use strict';

/**
 * Tests fuer "das Modell reist mit".
 *
 * Die harte Grenze dieser Umgebung und wie dieser Test damit umgeht
 * ----------------------------------------------------------------
 * Hier gibt es kein echtes Sprachmodell und keinen echten Laufzeitkern. Was
 * hier geprueft wird, ist deshalb nicht das Denken eines Modells, sondern die
 * MASCHINERIE: finden -> planen -> kopieren -> aufDemStick. Dafuer legt dieser
 * Test zwei Statisten an:
 *
 *  1. einen kuenstlichen Ollama-Speicher mit echten Manifesten und echten,
 *     inhaltsadressierten Blobs (der Dateiname IST der sha256 des Inhalts) --
 *     an ihm wird gemessen, dass die Groessenrechnung die Blobs EINES Modells
 *     zaehlt und nicht den ganzen Ordner, und
 *  2. ein winziges Node-Skript, das die Ollama-Schnittstelle spricht
 *     (/api/tags, /api/chat). Es wird auf den Stick kopiert, VOM STICK
 *     gestartet und mit dem echten Anbieter aus src/models/providers/ollama.js
 *     befragt. Das beweist die Kette bis zum Ende: Ausfuehrbar-Bit ueberlebt
 *     die Kopie, der Modellspeicher auf dem Stick hat die Ordnung, die ein
 *     echtes Ollama erwartet, und der Name, den es dort meldet, ist der Name
 *     aus dem Manifest.
 *
 * Der Statist gehoert in diesen Test. Er ist NIE Teil des Auslieferungswegs,
 * und nichts in src/** erfindet eine Antwort, wenn kein Modell da ist.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { test, drain, tempHome } = require('./harness');

const {
  createPortableModels,
  ollamaModellname,
  plattformId,
  FAT_DATEIGRENZE,
} = require('../src/portable/model');
const stickMod = require('../src/portable/stick');
const { createStick, LAYOUT, geschuetzterOrdner, humanBytes } = stickMod;
const ollamaProvider = require('../src/models/providers/ollama');
const { NetworkBlockedError, StorageError, AbortedError, ValidationError } = require('../src/kernel/errors');

/* ------------------------------------------------------------- Statisten */

/**
 * Ein Statist, der die Ollama-Schnittstelle spricht. Er ersetzt KEIN Modell:
 * er sagt nur, was er bekommen hat. Ein Produkt, das so antwortet, waere eine
 * Luege -- ein Test, der so misst, ob die Datei vom Stick startet und die
 * richtige Schnittstelle bedient, ist genau richtig.
 */
const STATIST_QUELLE = [
  '#!/usr/bin/env node',
  "'use strict';",
  '/* STATIST aus test/portable-model.test.js. Niemals ausliefern. */',
  "const fs = require('node:fs');",
  "const http = require('node:http');",
  "const path = require('node:path');",
  'function modelle() {',
  "  const speicher = process.env.OLLAMA_MODELS || '';",
  "  const wurzel = path.join(speicher, 'manifests');",
  '  const out = [];',
  '  const gehe = (dir, rel) => {',
  '    let eintraege = [];',
  '    try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }',
  '    for (const e of eintraege) {',
  "      const kind = rel ? rel + '/' + e.name : e.name;",
  '      if (e.isDirectory()) { gehe(path.join(dir, e.name), kind); continue; }',
  "      const teile = kind.split('/');",
  '      const tag = teile.pop();',
  '      const modell = teile.pop();',
  "      const name = modell + ':' + tag;",
  '      out.push({ name: name, model: name, size: 0, details: {} });',
  '    }',
  '  };',
  "  gehe(wurzel, '');",
  '  return out;',
  '}',
  'const server = http.createServer((req, res) => {',
  "  if (req.url === '/api/tags') {",
  "    res.writeHead(200, { 'content-type': 'application/json' });",
  '    res.end(JSON.stringify({ models: modelle() }));',
  '    return;',
  '  }',
  "  if (req.url === '/api/chat') {",
  "    let body = '';",
  "    req.on('data', (c) => { body += c; });",
  "    req.on('end', () => {",
  '      let anfrage = {};',
  '      try { anfrage = JSON.parse(body); } catch { anfrage = {}; }',
  "      const frage = (anfrage.messages || []).map((m) => m.content).join(' ');",
  "      res.writeHead(200, { 'content-type': 'application/x-ndjson' });",
  "      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Statist, Modell ' + anfrage.model + ', gefragt: ' + frage }, done: false }) + '\\n');",
  "      res.end(JSON.stringify({ done: true, done_reason: 'stop' }) + '\\n');",
  '    });',
  '    return;',
  '  }',
  '  res.writeHead(404);',
  "  res.end('nein');",
  '});',
  "server.listen(0, '127.0.0.1', () => {",
  "  process.stdout.write('BEREIT ' + server.address().port + '\\n');",
  '});',
  '',
].join('\n');

/** Legt den Statisten als ausfuehrbare Datei an -- wie ein installiertes Ollama. */
function statistAnlegen(ordner, name) {
  fs.mkdirSync(ordner, { recursive: true });
  const datei = path.join(ordner, name);
  fs.writeFileSync(datei, STATIST_QUELLE);
  fs.chmodSync(datei, 0o755);
  return datei;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Ein kuenstlicher, inhaltsadressierter Ollama-Speicher.
 *
 * Zwei Modelle, die sich EINEN Blob teilen -- genau der Fall, in dem "miss den
 * Ordner" eine falsche Zahl liefert.
 */
function ollamaSpeicherAnlegen(wurzel) {
  const blobs = path.join(wurzel, 'blobs');
  const manifeste = path.join(wurzel, 'manifests', 'registry.ollama.ai', 'library');
  fs.mkdirSync(blobs, { recursive: true });
  fs.mkdirSync(path.join(manifeste, 'mini'), { recursive: true });
  fs.mkdirSync(path.join(manifeste, 'gross'), { recursive: true });

  const blob = (inhalt) => {
    const buf = Buffer.from(inhalt);
    const hex = sha256(buf);
    fs.writeFileSync(path.join(blobs, `sha256-${hex}`), buf);
    return { digest: `sha256:${hex}`, size: buf.length };
  };

  const konfig = blob('{"model_format":"gguf"}'.padEnd(120, ' '));
  const gewichte = blob('GEWICHTE-MINI'.padEnd(2000, 'x'));
  const lizenz = blob('LIZENZ'.padEnd(500, 'l'));
  // gehoert NUR zu "gross" -- wer den Ordner misst, zaehlt es faelschlich mit
  const grosseGewichte = blob('GEWICHTE-GROSS'.padEnd(50000, 'y'));

  fs.writeFileSync(path.join(manifeste, 'mini', '8b'), JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', ...konfig },
    layers: [
      { mediaType: 'application/vnd.ollama.image.model', ...gewichte },
      { mediaType: 'application/vnd.ollama.image.license', ...lizenz },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(manifeste, 'gross', 'latest'), JSON.stringify({
    schemaVersion: 2,
    config: { ...konfig },
    layers: [
      { mediaType: 'application/vnd.ollama.image.model', ...grosseGewichte },
      // geteilte Schicht: dieselbe Lizenz wie "mini"
      { mediaType: 'application/vnd.ollama.image.license', ...lizenz },
    ],
  }, null, 2));

  return {
    wurzel,
    blobs,
    miniBytes: konfig.size + gewichte.size + lizenz.size,
    grossBytes: konfig.size + grosseGewichte.size + lizenz.size,
    geteiltBytes: lizenz.size + konfig.size,
  };
}

/** Die Summe ALLER Dateien eines Ordners -- die Zahl, die eben NICHT stimmt. */
function ordnerBytes(dir) {
  let summe = 0;
  const gehe = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) gehe(abs);
      else summe += fs.statSync(abs).size;
    }
  };
  gehe(dir);
  return summe;
}

/** sha256 + mtime jeder Datei, damit "unveraendert" beweisbar ist. */
function abdruck(dir) {
  const out = {};
  const gehe = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(d, e.name);
      const kind = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { gehe(abs, kind); continue; }
      const st = fs.statSync(abs, { bigint: true });
      out[kind] = { sha: sha256(fs.readFileSync(abs)), mtime: String(st.mtimeNs), size: String(st.size) };
    }
  };
  gehe(dir, '');
  return out;
}

/** Ein Heim mit Ollama-Speicher, Statist im PATH und einer GGUF-Datei. */
function rechnerAufbauen(heim, { mitKern = true, mitGguf = true } = {}) {
  const speicher = ollamaSpeicherAnlegen(path.join(heim, '.ollama', 'models'));
  const binOrdner = path.join(heim, 'bin');
  let kern = null;
  if (mitKern) kern = statistAnlegen(binOrdner, process.platform === 'win32' ? 'ollama.exe' : 'ollama');
  let gguf = null;
  if (mitGguf) {
    const ordner = path.join(heim, 'models');
    fs.mkdirSync(ordner, { recursive: true });
    gguf = path.join(ordner, 'winzig-q4.gguf');
    fs.writeFileSync(gguf, Buffer.alloc(4096, 7));
  }
  return { speicher, binOrdner, kern, gguf };
}

function werkzeug(heim, extra = {}) {
  return createPortableModels({
    home: heim,
    env: { PATH: path.join(heim, 'bin') },
    ...extra,
  });
}

/* ---------------------------------------------------------------- Schleuse */

const LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Wie in test/models.test.js: nichts verlaesst 127.0.0.1, Scope ist Pflicht. */
function testGate() {
  return {
    classify(host) { return LOOPBACK.test(host) || host === 'localhost' ? 'loopback' : 'public'; },
    async fetch(url, init = {}) {
      if (typeof init.scope !== 'string' || !init.scope) throw new Error('gate.fetch ohne scope');
      const ziel = new URL(url);
      if (!LOOPBACK.test(ziel.hostname)) throw new NetworkBlockedError(`Blockiert: ${ziel.hostname}`);
      return fetch(url, { method: init.method || 'GET', headers: init.headers, body: init.body, signal: init.signal });
    },
  };
}

/** Den Statisten starten und warten, bis er seinen Port nennt. */
function statistStarten(datei, umgebung) {
  return new Promise((resolve, reject) => {
    const kind = spawn(datei, [], {
      env: { ...process.env, ...umgebung },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let aus = '';
    let fehler = '';
    const zeit = setTimeout(() => {
      try { kind.kill('SIGKILL'); } catch { /* egal */ }
      reject(new Error(`Der Statist vom Stick meldete sich nicht: ${fehler || aus || 'keine Ausgabe'}`));
    }, 15000);
    kind.stdout.on('data', (c) => {
      aus += String(c);
      const treffer = /BEREIT (\d+)/.exec(aus);
      if (treffer) {
        clearTimeout(zeit);
        resolve({
          port: Number(treffer[1]),
          stop: () => new Promise((r) => { kind.once('close', r); try { kind.kill('SIGKILL'); } catch { r(); } }),
        });
      }
    });
    kind.stderr.on('data', (c) => { fehler += String(c); });
    kind.on('error', (err) => { clearTimeout(zeit); reject(err); });
    kind.on('close', (code) => {
      if (!/BEREIT/.test(aus)) {
        clearTimeout(zeit);
        reject(new Error(`Der Statist endete mit ${code}: ${fehler.slice(0, 300)}`));
      }
    });
  });
}

/* ===================================================================== 1 */

test('Die Groesse eines Ollama-Modells ist die Summe SEINER Blobs, nicht die des Ordners', () => {
  const heim = tempHome('nos-modell-heim');
  try {
    const { speicher } = rechnerAufbauen(heim.home);
    const befund = werkzeug(heim.home).finden();

    const mini = befund.modelle.find((m) => m.name === 'mini:8b');
    const gross = befund.modelle.find((m) => m.name === 'gross:latest');
    assert.ok(mini, `mini:8b fehlt im Befund: ${JSON.stringify(befund.modelle.map((m) => m.name))}`);
    assert.ok(gross, 'gross:latest fehlt im Befund');

    assert.equal(mini.bytes, speicher.miniBytes, 'mini zaehlt genau seine eigenen Blobs');
    assert.equal(gross.bytes, speicher.grossBytes, 'gross zaehlt genau seine eigenen Blobs');

    // Der Beleg, dass das ueberhaupt ein Unterschied ist -- und zwar in beide
    // Richtungen: der Speicher ist ein Vielfaches des einen Modells (wer ihn
    // misst, kopiert zu viel), und die Summe der Modelle ist GROESSER als der
    // Speicher, weil beide sich Blobs teilen (wer sie addiert, rechnet doppelt).
    const speicherBytes = ordnerBytes(speicher.wurzel);
    const blobBytes = ordnerBytes(speicher.blobs);
    assert.ok(mini.bytes < speicherBytes / 10,
      `mini (${mini.bytes}) muss ein Bruchteil des ganzen Speichers sein (${speicherBytes})`);
    assert.ok(mini.bytes + gross.bytes > blobBytes,
      `geteilte Blobs: ${mini.bytes} + ${gross.bytes} > ${blobBytes} (auf der Platte liegen sie nur einmal)`);
    assert.equal(mini.bytes + gross.bytes - speicher.geteiltBytes, blobBytes,
      'genau die geteilten Blobs sind der Unterschied');

    // Und die Dateiliste eines Modells enthaelt NUR seine eigenen Blobs.
    const blobsVonMini = mini.dateien.filter((d) => d.art === 'blob');
    assert.equal(blobsVonMini.length, 3, 'mini hat drei Blobs (config + Gewichte + Lizenz)');
    assert.ok(mini.dateien[mini.dateien.length - 1].art === 'manifest',
      'das Manifest steht zuletzt in der Liste - erst Nutzlast, dann Zeiger');
  } finally {
    heim.cleanup();
  }
});

test('Der Name eines Modells kommt aus dem Pfad des Manifests', () => {
  assert.equal(ollamaModellname('registry.ollama.ai/library/llama3/8b'), 'llama3:8b');
  assert.equal(ollamaModellname('registry.ollama.ai/meineorg/modell/v2'), 'meineorg/modell:v2');
});

/* ===================================================================== 2 */

test('finden() sieht Laufzeitkern und GGUF-Datei und sagt, was fehlt', () => {
  const heim = tempHome('nos-modell-finden');
  try {
    const { kern, gguf } = rechnerAufbauen(heim.home);
    const befund = werkzeug(heim.home).finden();

    assert.equal(befund.gefunden, true);
    const gefundenerKern = befund.kerne.find((k) => k.pfad === kern);
    assert.ok(gefundenerKern, `der Kern in ${kern} wurde nicht gefunden`);
    assert.equal(gefundenerKern.rolle, 'kern');
    assert.equal(gefundenerKern.ausfuehrbar, true, 'das Ausfuehrbar-Bit wird gelesen, nicht geraten');
    assert.equal(gefundenerKern.plattform, plattformId(), 'ein Kern gilt fuer die Plattform, auf der er liegt');
    assert.ok(gefundenerKern.bytes > 0);

    const ggufFund = befund.modelle.find((m) => m.art === 'gguf');
    assert.ok(ggufFund, 'die .gguf-Datei fehlt im Befund');
    assert.equal(ggufFund.bytes, fs.statSync(gguf).size);
    assert.equal(ggufFund.plattform, null, 'Gewichte sind an keine Plattform gebunden');
  } finally {
    heim.cleanup();
  }
});

test('Kein Modell auf dem Rechner ist ein Befund mit deutschem Satz, kein Fehler', () => {
  const leer = tempHome('nos-modell-leer');
  try {
    const befund = createPortableModels({ home: leer.home, env: { PATH: path.join(leer.home, 'nichts') } }).finden();
    assert.equal(befund.gefunden, false);
    assert.equal(befund.modelle.length, 0);
    assert.equal(befund.kerne.length, 0);
    assert.ok(befund.hinweise.length, 'ohne Fund muss ein Satz dastehen');
    assert.match(befund.hinweise[0], /kein lokales Modell/i);
    assert.match(befund.hinweise[0], /ollama/i, 'der Satz sagt, was zu tun waere');
  } finally {
    leer.cleanup();
  }
});

/* ===================================================================== 3 */

test('planen() schreibt nichts und nennt jedes Hindernis mit Code und Satz', () => {
  const heim = tempHome('nos-modell-plan-heim');
  const stick = tempHome('nos-modell-plan-stick');
  try {
    rechnerAufbauen(heim.home);
    const w = werkzeug(heim.home);
    const befund = w.finden();
    const vorher = abdruck(stick.home);

    const plan = w.planen({ ziel: stick.home, auswahl: befund.modelle.map((m) => m.id), befund });
    assert.deepEqual(abdruck(stick.home), vorher, 'die Vorschau darf keine einzige Datei anlegen');
    assert.equal(plan.kannLosgehen, true, JSON.stringify(plan.hindernisse));
    assert.ok(plan.bytes > 0);
    assert.ok(plan.anzahl >= 5, `es muessen Blobs und Manifeste geplant sein: ${plan.anzahl}`);
    assert.match(plan.zusammenfassung, /Modell/);

    // Ohne Auswahl wird nichts erfunden.
    const leer = w.planen({ ziel: stick.home, auswahl: [], befund });
    assert.equal(leer.kannLosgehen, false);
    assert.ok(leer.hindernisse.some((h) => h.code === 'NICHTS_AUSGEWAEHLT' && /Laufzeitkern/.test(h.satz)));

    // Eine Kennung, die es nicht gibt, wird nicht stillschweigend uebergangen.
    const falsch = w.planen({ ziel: stick.home, auswahl: ['ollama:gibtsnicht:1b'], befund });
    assert.ok(falsch.hindernisse.some((h) => h.code === 'UNBEKANNTE_AUSWAHL'));
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

test('FAT32: eine Datei ueber 4 GB wird VOR dem ersten Byte abgelehnt, mit dem Weg hinaus', async () => {
  const heim = tempHome('nos-modell-fat-heim');
  const stick = tempHome('nos-modell-fat-stick');
  try {
    rechnerAufbauen(heim.home, { mitGguf: false });
    // Eine echte, zu grosse Datei -- als Loch-Datei, damit sie nichts kostet.
    const ordner = path.join(heim.home, 'models');
    fs.mkdirSync(ordner, { recursive: true });
    const riese = path.join(ordner, 'riesig-q8.gguf');
    const fd = fs.openSync(riese, 'w');
    fs.ftruncateSync(fd, 5 * 1024 * 1024 * 1024);
    fs.closeSync(fd);
    assert.ok(fs.statSync(riese).size > FAT_DATEIGRENZE, 'die Statisten-Datei ist wirklich zu gross');

    const w = werkzeug(heim.home, {
      // Der eine Fall, den kein Entwicklungsrechner hat: ein FAT32-Stick.
      dateisystem: () => ({
        writable: true, enforcesModes: false, probed: false, type: 0x4d44,
        typeName: 'FAT (FAT16/FAT32)', maxFileBytes: FAT_DATEIGRENZE, error: null,
      }),
      freeBytes: () => 64 * 1024 * 1024 * 1024, // Platz ist genug: es liegt NUR an FAT32
    });
    const befund = w.finden();
    const riesenFund = befund.modelle.find((m) => m.name.startsWith('riesig'));
    assert.ok(riesenFund, 'die grosse Datei wurde nicht gefunden');

    const plan = w.planen({ ziel: stick.home, auswahl: [riesenFund.id], befund });
    const hindernis = plan.hindernisse.find((h) => h.code === 'DATEI_ZU_GROSS');
    assert.ok(hindernis, `FAT32 muss auffallen: ${JSON.stringify(plan.hindernisse)}`);
    assert.equal(hindernis.schwere, 'stopp');
    assert.match(hindernis.satz, /exFAT/, 'der Satz muss sagen, was hilft');
    assert.match(hindernis.satz, /NTFS/);
    assert.match(hindernis.satz, /ALLE Daten auf dem Stick geloescht/, 'und dass Formatieren alles loescht');
    assert.equal(plan.kannLosgehen, false);
    assert.ok(!plan.hindernisse.some((h) => h.code === 'ZU_WENIG_PLATZ'), 'es liegt an FAT32, nicht am Platz');

    // Und kopieren() faengt gar nicht erst an.
    await assert.rejects(
      () => w.kopieren(stick.home, { auswahl: [riesenFund.id], befund }),
      (err) => /exFAT/.test(err.message),
    );
    assert.equal(fs.existsSync(path.join(stick.home, LAYOUT.models)), false, 'kein einziges Byte geschrieben');
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

test('Zu wenig Platz wird abgelehnt, bevor geschrieben wird', async () => {
  const heim = tempHome('nos-modell-platz-heim');
  const stick = tempHome('nos-modell-platz-stick');
  try {
    rechnerAufbauen(heim.home);
    const w = werkzeug(heim.home, { freeBytes: () => 1024 });
    const befund = w.finden();
    await assert.rejects(
      () => w.kopieren(stick.home, { auswahl: befund.modelle.map((m) => m.id), befund }),
      (err) => err.code === 'STICK_FULL' && err.status === 507 && /Schaffe Platz/.test(err.message),
    );
    assert.equal(fs.existsSync(path.join(stick.home, LAYOUT.models)), false);
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

/* ===================================================================== 4 */

test('Der ganze Weg: finden -> planen -> kopieren -> aufDemStick', async () => {
  const heim = tempHome('nos-modell-weg-heim');
  const stick = tempHome('nos-modell-weg-stick');
  try {
    const { kern } = rechnerAufbauen(heim.home);
    const w = werkzeug(heim.home);
    const befund = w.finden();
    const mini = befund.modelle.find((m) => m.name === 'mini:8b');
    const kernFund = befund.kerne[0];

    const ereignisse = [];
    const ergebnis = await w.kopieren(stick.home, {
      auswahl: [mini.id, kernFund.id],
      befund,
      onProgress: (e) => ereignisse.push(e.phase),
    });

    assert.ok(ergebnis.kopiert.dateien >= 5, `kopierte Dateien: ${ergebnis.kopiert.dateien}`);
    assert.ok(ereignisse.includes('kopieren') && ereignisse.includes('fertig'), ereignisse.join(','));

    // Die Ordnung auf dem Stick ist die, die ein echtes Ollama erwartet.
    const models = path.join(stick.home, LAYOUT.models);
    assert.ok(fs.existsSync(path.join(models, 'ollama', 'manifests', 'registry.ollama.ai', 'library', 'mini', '8b')));
    assert.ok(fs.readdirSync(path.join(models, 'ollama', 'blobs')).every((n) => /^sha256-[0-9a-f]{64}$/.test(n)));
    const kernAufStick = path.join(models, 'kern', plattformId(), path.basename(kern));
    assert.ok(fs.existsSync(kernAufStick), 'der Laufzeitkern liegt unter seiner Plattform');
    if (process.platform !== 'win32') {
      assert.ok((fs.statSync(kernAufStick).mode & 0o111) !== 0, 'das Ausfuehrbar-Bit hat die Kopie ueberlebt');
    }

    // Die Beschreibungsdatei sagt ohne Raten, was dort liegt.
    const beschreibung = JSON.parse(fs.readFileSync(path.join(models, LAYOUT.modelsIndex), 'utf8'));
    assert.equal(beschreibung.version, 1);
    const eintragModell = beschreibung.eintraege.find((e) => e.name === 'mini:8b');
    const eintragKern = beschreibung.eintraege.find((e) => e.rolle === 'kern');
    assert.ok(eintragModell && eintragKern, JSON.stringify(beschreibung.eintraege.map((e) => e.name)));
    assert.equal(eintragModell.plattform, null, 'Gewichte gelten fuer jede Plattform');
    assert.equal(eintragKern.plattform, plattformId(), 'der Kern nennt seine Plattform');
    assert.ok(eintragModell.dateien.every((d) => d.pruefsumme && d.pruefsumme.algo === 'sha256'));
    assert.ok(eintragModell.dateien.some((d) => d.pruefsumme.wert && d.pruefsumme.herkunft === 'berechnet'),
      'kleine Dateien werden wirklich geprueft');
    assert.ok(eintragKern.start && /models\/kern/.test(eintragKern.start), 'es steht da, wie man ihn startet');
    assert.ok(!JSON.stringify(beschreibung).includes(heim.home),
      'der Pfad des Quellrechners (mit Benutzernamen) gehoert nicht auf einen Stick, der verloren gehen kann');

    // Und die Selbstauskunft des Sticks.
    const stand = w.aufDemStick(stick.home);
    assert.equal(stand.vorhanden, true);
    assert.equal(stand.passt, true, stand.satz);
    assert.ok(stand.modelle.some((m) => m.name === 'mini:8b'));
    assert.deepEqual(stand.plattformen, [plattformId()]);
    assert.match(stand.satz, /passt/);
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

/* ===================================================================== 5 */

test('Der kopierte Laufzeitkern startet VOM STICK und spricht die Ollama-Schnittstelle', async () => {
  const heim = tempHome('nos-modell-lauf-heim');
  const stick = tempHome('nos-modell-lauf-stick');
  let laeuft = null;
  try {
    rechnerAufbauen(heim.home, { mitGguf: false });
    const w = werkzeug(heim.home);
    const befund = w.finden();
    await w.kopieren(stick.home, {
      auswahl: [befund.modelle.find((m) => m.name === 'mini:8b').id, befund.kerne[0].id],
      befund,
    });

    const models = path.join(stick.home, LAYOUT.models);
    const kernAufStick = path.join(models, 'kern', plattformId(), process.platform === 'win32' ? 'ollama.exe' : 'ollama');

    // Gestartet wird die Datei AUF DEM STICK, mit dem Modellspeicher AUF DEM
    // STICK -- nichts vom Quellrechner ist hier noch im Spiel.
    laeuft = await statistStarten(kernAufStick, { OLLAMA_MODELS: path.join(models, 'ollama') });
    const basis = `http://127.0.0.1:${laeuft.port}`;
    const gate = testGate();

    const probe = await ollamaProvider.probe({ baseUrl: basis, gate, scope: 'test' });
    assert.equal(probe.available, true, `Probe fehlgeschlagen: ${probe.error}`);
    assert.ok(probe.models.some((m) => m.id === 'mini:8b'),
      `der Name aus dem Manifest auf dem Stick muss ankommen: ${JSON.stringify(probe.models.map((m) => m.id))}`);

    const antwort = await ollamaProvider.chat({
      baseUrl: basis,
      model: 'mini:8b',
      messages: [{ role: 'user', content: 'Laeufst du vom Stick?' }],
      gate,
      scope: 'test',
    });
    assert.match(antwort.content, /Statist/);
    assert.match(antwort.content, /Laeufst du vom Stick\?/, 'die Frage ist wirklich durch die Schnittstelle gegangen');
  } finally {
    if (laeuft) await laeuft.stop();
    heim.cleanup();
    stick.cleanup();
  }
});

/* ===================================================================== 6 */

test('Ein zweites Modell kommt DANEBEN, das erste bleibt Byte fuer Byte liegen', async () => {
  const heim = tempHome('nos-modell-zwei-heim');
  const stick = tempHome('nos-modell-zwei-stick');
  try {
    rechnerAufbauen(heim.home, { mitGguf: false });
    const w = werkzeug(heim.home);
    const befund = w.finden();
    const mini = befund.modelle.find((m) => m.name === 'mini:8b');
    const gross = befund.modelle.find((m) => m.name === 'gross:latest');

    await w.kopieren(stick.home, { auswahl: [mini.id], befund });
    const models = path.join(stick.home, LAYOUT.models);
    const vorher = abdruck(path.join(models, 'ollama'));

    const zweitesMal = await w.kopieren(stick.home, { auswahl: [gross.id], befund });
    // Die geteilten Blobs liegen schon da und werden nicht noch einmal geschoben.
    assert.ok(zweitesMal.uebersprungen > 0,
      'geteilte, inhaltsadressierte Blobs muessen uebersprungen werden');

    const nachher = abdruck(path.join(models, 'ollama'));
    for (const [datei, wert] of Object.entries(vorher)) {
      assert.ok(nachher[datei], `"${datei}" ist verschwunden`);
      assert.equal(nachher[datei].sha, wert.sha, `"${datei}" wurde veraendert`);
      assert.equal(nachher[datei].mtime, wert.mtime, `"${datei}" wurde angefasst`);
    }

    const beschreibung = JSON.parse(fs.readFileSync(path.join(models, LAYOUT.modelsIndex), 'utf8'));
    const namen = beschreibung.eintraege.map((e) => e.name).sort();
    assert.deepEqual(namen, ['gross:latest', 'mini:8b'], 'beide Modelle stehen in der Beschreibung');
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

test('Zwei Modelle mit geteilten Schichten kopieren den geteilten Blob nur einmal', async () => {
  const heim = tempHome('nos-modell-geteilt-heim');
  const stick = tempHome('nos-modell-geteilt-stick');
  try {
    const { speicher } = rechnerAufbauen(heim.home, { mitGguf: false, mitKern: false });
    const w = werkzeug(heim.home);
    const befund = w.finden();
    const beide = befund.modelle.map((m) => m.id);

    const plan = w.planen({ ziel: stick.home, auswahl: beide, befund });
    const ziele = plan.dateien.map((d) => d.rel);
    assert.equal(new Set(ziele).size, ziele.length, 'kein Ziel steht zweimal im Plan');
    // Genau die geteilten Blobs sind der Unterschied zur naiven Summe: wer die
    // Modellgroessen addiert, zaehlt sie doppelt.
    const naiv = befund.modelle.reduce((s, m) => s + m.bytes, 0);
    const blobsGeplant = plan.dateien.filter((d) => d.art === 'blob').reduce((s, d) => s + d.size, 0);
    assert.equal(naiv - blobsGeplant, speicher.geteiltBytes,
      `doppelt gezaehlt: naiv ${naiv}, geplant ${blobsGeplant}`);
    // Beide Modelle zusammen sind genau der ganze Speicher -- einmal.
    assert.equal(plan.bytes, ordnerBytes(speicher.wurzel));

    const ergebnis = await w.kopieren(stick.home, { auswahl: beide, befund });
    assert.equal(ergebnis.kopiert.bytes, plan.bytes, 'kopiert wurde genau das Geplante');
    const blobs = fs.readdirSync(path.join(stick.home, LAYOUT.models, 'ollama', 'blobs'));
    assert.equal(new Set(blobs).size, blobs.length);
    assert.equal(ordnerBytes(path.join(stick.home, LAYOUT.models, 'ollama', 'blobs')),
      ordnerBytes(speicher.blobs), 'auf dem Stick liegt derselbe Blob-Bestand, nicht mehr');
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

test('Ein Abbruch laesst nichts Halbes zurueck', async () => {
  const heim = tempHome('nos-modell-abbruch-heim');
  const stick = tempHome('nos-modell-abbruch-stick');
  try {
    rechnerAufbauen(heim.home, { mitGguf: false });
    const w = werkzeug(heim.home);
    const befund = w.finden();
    const steuerung = new AbortController();

    await assert.rejects(
      () => w.kopieren(stick.home, {
        auswahl: befund.modelle.map((m) => m.id),
        befund,
        signal: steuerung.signal,
        // Beim ersten Lebenszeichen abbrechen -- mitten im Kopieren.
        onProgress: (e) => { if (e.phase === 'kopieren') steuerung.abort(); },
      }),
      (err) => err instanceof AbortedError || err.code === 'ABORTED',
    );

    const reste = fs.readdirSync(stick.home);
    assert.deepEqual(reste.filter((n) => n.startsWith('.models')), [], `halbfertige Ordner geblieben: ${reste}`);
    assert.equal(fs.existsSync(path.join(stick.home, LAYOUT.models)), false,
      'ein abgebrochener erster Lauf hinterlaesst keinen Modellordner');
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

test('Zwei Vorgaenge auf demselben Stick gibt es nicht', async () => {
  const heim = tempHome('nos-modell-sperre-heim');
  const stick = tempHome('nos-modell-sperre-stick');
  try {
    rechnerAufbauen(heim.home, { mitGguf: false });
    const w = werkzeug(heim.home);
    const befund = w.finden();
    const auswahl = befund.modelle.map((m) => m.id);

    const ersterLauf = w.kopieren(stick.home, { auswahl, befund });
    const zweiter = w.kopieren(stick.home, { auswahl, befund });
    await assert.rejects(() => zweiter, (err) => err.code === 'STICK_BUSY' && err.status === 409);
    await ersterLauf;
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

/* ===================================================================== 7 */

test('aufDemStick() sagt auch den unbequemen Satz', () => {
  const heim = tempHome('nos-modell-urteil-heim');
  const stick = tempHome('nos-modell-urteil-stick');
  try {
    const w = werkzeug(heim.home);

    // Leerer Stick: kein erfundener Erfolg.
    const leer = w.aufDemStick(stick.home);
    assert.equal(leer.vorhanden, false);
    assert.equal(leer.passt, false);
    assert.match(leer.satz, /kein Modell/i);

    // Ein Kern fuer eine fremde Plattform.
    const models = path.join(stick.home, LAYOUT.models);
    fs.mkdirSync(path.join(models, 'kern', 'win-x64'), { recursive: true });
    fs.writeFileSync(path.join(models, 'kern', 'win-x64', 'ollama.exe'), Buffer.alloc(2048, 1));
    fs.mkdirSync(path.join(models, 'gguf', 'winzig'), { recursive: true });
    fs.writeFileSync(path.join(models, 'gguf', 'winzig', 'winzig.gguf'), Buffer.alloc(4096, 2));

    const fremd = createPortableModels({
      home: heim.home, env: {}, plattform: { os: 'darwin', arch: 'arm64' },
    }).aufDemStick(stick.home);
    assert.equal(fremd.vorhanden, true);
    assert.equal(fremd.passt, false);
    assert.match(fremd.satz, /win-x64/);
    assert.match(fremd.satz, /darwin-arm64/);
    assert.match(fremd.satz, /startet hier nicht/);
    assert.match(fremd.satz, /Modelldateien selbst/, 'die Gewichte passen trotzdem - das gehoert dazu');

    // Und die Frage fuer ein iPad: dort startet ueberhaupt kein Programm.
    const ipad = w.aufDemStick(stick.home, { fuer: 'ipados' });
    assert.equal(ipad.passt, false);
    assert.match(ipad.satz, /iPad/);
    assert.match(ipad.satz, /kein Programm von einem Stick starten/);
    assert.match(ipad.satz, /Rechner im selben Netz/, 'der Satz sagt, was auf dem iPad hilft');

    // Fehlt die Beschreibung, wird sie nicht erfunden.
    assert.equal(ipad.beschreibung, null);
    assert.ok(ipad.hinweise.some((h) => /keine Beschreibung/.test(h)));
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

test('Eine Beschreibung, deren Dateien fehlen, wird als Warnung gemeldet', () => {
  const stick = tempHome('nos-modell-luecke');
  try {
    const models = path.join(stick.home, LAYOUT.models);
    fs.mkdirSync(path.join(models, 'gguf', 'winzig'), { recursive: true });
    fs.writeFileSync(path.join(models, 'gguf', 'winzig', 'winzig.gguf'), Buffer.alloc(16, 3));
    fs.writeFileSync(path.join(models, LAYOUT.modelsIndex), JSON.stringify({
      version: 1,
      eintraege: [{ id: 'gguf:weg', name: 'weg.gguf', dateien: [{ ziel: 'gguf/weg/weg.gguf', bytes: 99 }] }],
    }));
    const stand = createPortableModels({ home: stick.home, env: {} }).aufDemStick(stick.home);
    assert.ok(stand.warnungen.some((w) => /fehlen auf dem Stick/.test(w)), JSON.stringify(stand.warnungen));
  } finally {
    stick.cleanup();
  }
});

/* ===================================================================== 8 */

test('Der Modellordner ist genauso unantastbar wie der Datenordner', () => {
  // Reine Funktion, ohne Stick pruefbar - deshalb steht sie auf Modulebene.
  assert.equal(geschuetzterOrdner('/stick', '/stick/app/bin/x.js'), null);
  assert.equal(geschuetzterOrdner('/stick', '/stick/data/notes.json').was, 'Datenordner');
  assert.equal(geschuetzterOrdner('/stick', '/stick/models/ollama/blobs/sha256-a').was, 'Modellordner');
  assert.equal(geschuetzterOrdner('/stick', '/stick/models').was, 'Modellordner');
});

test('"Nur Programm erneuern" fasst models/ nicht an', async () => {
  const quelle = tempHome('nos-modell-quelle');
  const stick = tempHome('nos-modell-update');
  try {
    // Eine Quelle, die verify() als vollstaendig ansieht.
    const schreibe = (rel, inhalt) => {
      const datei = path.join(quelle.home, rel);
      fs.mkdirSync(path.dirname(datei), { recursive: true });
      fs.writeFileSync(datei, inhalt);
    };
    schreibe('package.json', JSON.stringify({ name: 'neural-os', version: '0.1.0' }));
    schreibe('bin/neural-os.js', '#!/usr/bin/env node\n');
    schreibe('src/app.js', "'use strict';\n");
    schreibe('src/kernel/paths.js', "'use strict';\n");
    schreibe('web/index.html', '<!doctype html>');
    const launcher = path.join(__dirname, '..', 'tools', 'launchers');
    for (const name of fs.readdirSync(launcher)) {
      schreibe(path.join('tools', 'launchers', name), fs.readFileSync(path.join(launcher, name)));
    }

    const stick1 = createStick({ logger: null });
    await stick1.prepare(stick.home, { sourceRoot: quelle.home, includeRuntimes: false });
    assert.ok(fs.existsSync(path.join(stick.home, LAYOUT.models)), 'prepare() legt den Modellordner an');

    // Ein "Modell" auf dem Stick, mit Zeitstempel.
    const models = path.join(stick.home, LAYOUT.models);
    fs.mkdirSync(path.join(models, 'gguf', 'wichtig'), { recursive: true });
    fs.writeFileSync(path.join(models, 'gguf', 'wichtig', 'wichtig.gguf'), Buffer.alloc(65536, 9));
    fs.writeFileSync(path.join(models, LAYOUT.modelsIndex), JSON.stringify({ version: 1, eintraege: [] }));
    const vorher = abdruck(models);

    await stick1.update(stick.home, { sourceRoot: quelle.home });

    assert.deepEqual(abdruck(models), vorher, 'models/ muss Byte- und zeitstempelgleich bleiben');

    // Und die Vorschau verschweigt den belegten Platz nicht.
    const vorschau = stick1.preview(stick.home, { action: 'update', sourceRoot: quelle.home });
    assert.equal(vorschau.models.exists, true);
    assert.ok(vorschau.models.bytes >= 65536, `models-Groesse fehlt in der Vorschau: ${vorschau.models.bytes}`);
    assert.equal(vorschau.models.index, true);

    // verify() kennt den Ordner.
    const pruefung = await stick1.verify(stick.home);
    assert.equal(pruefung.layout.models.exists, true);
    assert.ok(pruefung.layout.models.bytes >= 65536);
    assert.ok(!pruefung.problems.some((p) => p.code === 'MODELS_UNDOCUMENTED'),
      'mit Beschreibung gibt es nichts zu melden');

    fs.rmSync(path.join(models, LAYOUT.modelsIndex));
    const ohne = await stick1.verify(stick.home);
    const hinweis = ohne.problems.find((p) => p.code === 'MODELS_UNDOCUMENTED');
    assert.ok(hinweis, 'ohne Beschreibung muss verify() das sagen');
    assert.equal(hinweis.level, 'info', 'ein Stick ohne Beschreibung ist nicht kaputt');
    assert.ok(hinweis.fix, 'jedes Problem traegt einen Rat');

    // Der LIESMICH-Text erklaert den Ordner - er ist das Einzige, was ein
    // fremder Mensch am Stick liest.
    const liesmich = fs.readFileSync(path.join(stick.home, LAYOUT.readme), 'utf8');
    assert.match(liesmich, /models/);
    assert.match(liesmich, /modelle\.json/);
    assert.match(liesmich, /Windows startet auf einem Mac nicht|startet auf einem Mac nicht/);
  } finally {
    quelle.cleanup();
    stick.cleanup();
  }
});

/* ===================================================================== 9 */

test('Eine kaputte Kopie wird erkannt und nicht eingesetzt', async () => {
  const heim = tempHome('nos-modell-kaputt-heim');
  const stick = tempHome('nos-modell-kaputt-stick');
  try {
    const { speicher } = rechnerAufbauen(heim.home, { mitGguf: false, mitKern: false });
    // Ein Blob, dessen Inhalt NICHT zu seinem Namen passt: genau das, was ein
    // defekter Stick oder ein wackelndes Kabel hinterlaesst.
    const blob = fs.readdirSync(speicher.blobs)[0];
    fs.writeFileSync(path.join(speicher.blobs, blob), 'etwas ganz anderes');

    const w = werkzeug(heim.home);
    const befund = w.finden();
    await assert.rejects(
      () => w.kopieren(stick.home, { auswahl: befund.modelle.map((m) => m.id), befund, pruefsummen: 'alle' }),
      (err) => err instanceof StorageError && /Pruefsumme weicht ab/.test(err.message),
    );
    assert.equal(fs.existsSync(path.join(stick.home, LAYOUT.models)), false,
      'nichts Kaputtes kommt an seinen Platz');
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

test('Eine Pruefsumme, die nicht berechnet wurde, nennt ihren Grund', async () => {
  const heim = tempHome('nos-modell-summe-heim');
  const stick = tempHome('nos-modell-summe-stick');
  try {
    rechnerAufbauen(heim.home, { mitKern: false });
    const w = werkzeug(heim.home);
    const befund = w.finden();
    const gguf = befund.modelle.find((m) => m.art === 'gguf');
    await w.kopieren(stick.home, { auswahl: [gguf.id], befund, pruefsummen: 'keine' });
    const beschreibung = JSON.parse(
      fs.readFileSync(path.join(stick.home, LAYOUT.models, LAYOUT.modelsIndex), 'utf8'),
    );
    const datei = beschreibung.eintraege[0].dateien[0];
    assert.equal(datei.pruefsumme.wert, null);
    assert.ok(datei.pruefsumme.grund, 'ein leeres Feld ohne Grund waere die Luege');
  } finally {
    heim.cleanup();
    stick.cleanup();
  }
});

test('Ohne Pfad zum Stick wird gefragt, nicht geraten', () => {
  const w = createPortableModels({ home: null, env: {} });
  assert.throws(() => w.planen({ ziel: '' }), (err) => err instanceof ValidationError && /Pfad zum Stick/.test(err.message));
  assert.ok(humanBytes(FAT_DATEIGRENZE).length > 0);
});

module.exports = { name: 'portable-model', tests: drain() };
