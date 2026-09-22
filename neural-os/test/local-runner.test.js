'use strict';

/**
 * Der Laufzeitkern vom Stick — end to end, mit einem echten Kindprozess.
 *
 * Was hier gemessen wird und warum in dieser Form
 * ----------------------------------------------
 * In dieser Umgebung gibt es KEIN Sprachmodell und KEINEN echten
 * Laufzeitkern. Gebaut wurde die Maschinerie, nicht das Modell — bewiesen
 * werden muss sie trotzdem. Dafür legt dieser Test zwei STATISTEN an: kleine
 * Node-Programme, die genau die Schnittstellen sprechen, die auch die echten
 * Kerne sprechen — der eine wie llama-server (`GET /v1/models`,
 * `POST /v1/chat/completions` als SSE, siehe src/models/providers/openai.js),
 * der andere wie Ollama (`ollama serve`, OLLAMA_HOST, `GET /api/tags`,
 * `POST /api/chat` als NDJSON, siehe src/models/providers/ollama.js; und wie
 * das echte Ollama sucht er lib/ollama neben seiner eigenen Programmdatei).
 * Beide werden beim Testlauf in einen Wegwerfordner geschrieben, sind an
 * keiner Stelle Teil des Auslieferungswegs und werden am Ende mit dem Ordner
 * gelöscht.
 *
 * Ein Windows gibt es hier ebenso wenig wie ein Modell. Die Pfad- und
 * Entscheidungslogik für Windows wird deshalb mit path.win32 an den reinen
 * Funktionen gemessen; was sich nur auf einem echten Windows messen lässt,
 * steht nicht hier, sondern im Bericht als offen.
 *
 * Der Weg, der gemessen wird, ist der ganze:
 *
 *   Kern liegt auf dem Datenträger
 *     -> Neural OS fährt von diesem Datenträger hoch (echte Stick-Erkennung,
 *        keine Attrappe: die Anwendung wird auf den Stick kopiert und VON
 *        DORT geladen, damit `detectPortable()` wirklich greift)
 *     -> der Kern läuft als eigener Prozess auf 127.0.0.1 und einem Port,
 *        den niemand vorher kannte
 *     -> der Chat bekommt über HTTP eine ECHTE Antwort, die nachweislich aus
 *        genau diesem Prozess stammt (sie trägt dessen PID)
 *     -> Neural OS wird beendet
 *     -> der Kern ist aus der Prozesstabelle verschwunden (nachgesehen mit
 *        `ps`, nicht geglaubt)
 *
 * Und der Gegenfall, der mindestens genauso wichtig ist: ein Kern, der beim
 * Start stirbt. Die Anwendung muss trotzdem hochfahren und sagen, was los
 * ist — samt der letzten Zeilen, die der Kern ausgegeben hat.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { test } = require('./harness');
const { __internals, ZUSTAND, BESCHREIBUNG, createLocalRunner } = require('../src/models/local-runner');

const PROJEKT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------- Statist -- */

/**
 * Der Statist. Kein Modell, kein Inhalt, keine erfundene Klugheit: er gibt
 * zurück, was er gelesen hat, und seine eigene PID. Genau daran erkennt der
 * Test, dass die Antwort aus DIESEM Prozess kam und nicht aus einer Attrappe
 * irgendwo im Produktcode.
 */
const STATIST = `#!/usr/bin/env node
'use strict';
const http = require('node:http');

const argv = process.argv.slice(2);
function wert(...namen) {
  for (const name of namen) {
    const i = argv.indexOf(name);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
  }
  return null;
}
const host = wert('--host') || '0.0.0.0';
const port = Number(wert('--port') || 0);
const modellPfad = wert('-m', '--model') || 'kein-modell';
const modellName = modellPfad.split(/[\\\\/]/).pop();

// Gegenfall 1: der Kern stirbt beim Start (falsche Plattform, zu wenig RAM).
if (process.env.KERN_STIRB === '1') {
  process.stderr.write('llama_model_load: error loading model\\n');
  process.stderr.write('ggml_backend_alloc: nicht genug Arbeitsspeicher fuer 4096 MiB\\n');
  process.stderr.write('abbruch\\n');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'x'));

  // Gegenfall 2: der Prozess lebt, die Schnittstelle bleibt stumm.
  if (process.env.KERN_LAHM === '1') {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Modell laedt noch' }));
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [{ id: modellName, object: 'model', meta: { n_ctx: 4096 } }],
      // Nur fuer den Test: an welche Adresse hat der Kern sich wirklich gebunden?
      gebundenAn: server.address(),
      pid: process.pid,
    }));
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let roh = '';
    req.on('data', (c) => { roh += c; });
    return req.on('end', () => {
      let frage = '(nichts gelesen)';
      try {
        const body = JSON.parse(roh);
        const letzte = (body.messages || []).filter((m) => m.role === 'user').pop();
        if (letzte && typeof letzte.content === 'string') frage = letzte.content;
      } catch { /* dann eben nicht */ }
      const satz = 'STATIST-PID ' + process.pid + ' hat gelesen: ' + frage;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const stueck of satz.match(/[\\s\\S]{1,11}/g) || []) {
        res.write('data: ' + JSON.stringify({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: stueck } }],
        }) + '\\n\\n');
      }
      res.write('data: ' + JSON.stringify({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
      }) + '\\n\\n');
      res.write('data: [DONE]\\n\\n');
      res.end();
    });
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unbekannt' }));
});

server.listen(port, host, () => {
  process.stdout.write('HORCHT ' + JSON.stringify(server.address()) + '\\n');
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;

/**
 * Der zweite Statist: er spricht den Ollama-Dialekt (`ollama serve`,
 * Adresse aus OLLAMA_HOST, `GET /api/tags`, `POST /api/chat` als NDJSON —
 * siehe src/models/providers/ollama.js) und verhält sich in dem einen Punkt
 * wie das echte Programm, um den es hier geht: er sucht seine Bibliotheken
 * RELATIV ZUR EIGENEN PROGRAMMDATEI (lib/ollama neben sich oder, bei der
 * Tarball-Struktur bin/ollama, eine Ebene höher) — nicht im Arbeitsverzeichnis.
 * Fehlt der Ordner, stirbt er mit einer Zeile, in der "lib/ fehlt" steht.
 *
 * Er meldet in /api/tags außerdem seine PID, sein Arbeitsverzeichnis und die
 * beiden Umgebungsvariablen, die der Aufseher setzt (oder eben nicht setzt).
 * Nur daran lässt sich messen, was der Aufseher wirklich getan hat.
 */
const OLLAMA_STATIST = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

if (process.argv[2] !== 'serve') {
  process.stderr.write('Error: unknown command "' + (process.argv[2] || '') + '" for "ollama"\\n');
  process.exit(1);
}
const gesucht = [
  path.join(__dirname, 'lib', 'ollama', 'marker'),
  path.join(__dirname, '..', 'lib', 'ollama', 'marker'),
];
const marker = gesucht.find((k) => fs.existsSync(k)) || null;
if (!marker) {
  process.stderr.write('time=2026-09-22T00:00:00.000Z level=ERROR source=server.go msg="lib/ fehlt: neben '
    + __filename + ' liegt kein Ordner lib/ollama (gesucht: ' + gesucht.join(', ') + ')"\\n');
  process.exit(1);
}
const [host, portRoh] = String(process.env.OLLAMA_HOST || '127.0.0.1:11434').split(':');
const port = Number(portRoh || 11434);

function auskunft() {
  return {
    pid: process.pid,
    cwd: process.cwd(),
    marker,
    umgebung: {
      OLLAMA_MODELS: process.env.OLLAMA_MODELS === undefined ? null : process.env.OLLAMA_MODELS,
      OLLAMA_HOST: process.env.OLLAMA_HOST || null,
    },
    gebundenAn: server.address(),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'x'));
  if (req.method === 'GET' && url.pathname === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      models: [{
        name: 'statist:latest', model: 'statist:latest', modified_at: '2026-09-22T00:00:00Z', size: 1,
        digest: 'sha256:0', details: { family: 'statist', parameter_size: '0B', quantization_level: 'keine' },
      }],
      ...auskunft(),
    }));
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let roh = '';
    req.on('data', (c) => { roh += c; });
    return req.on('end', () => {
      let frage = '(nichts gelesen)';
      let modell = 'statist:latest';
      try {
        const body = JSON.parse(roh);
        modell = body.model || modell;
        const letzte = (body.messages || []).filter((m) => m.role === 'user').pop();
        if (letzte && typeof letzte.content === 'string') frage = letzte.content;
      } catch { /* dann eben nicht */ }
      const satz = 'STATIST-PID ' + process.pid + ' hat gelesen: ' + frage;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const stueck of satz.match(/[\\s\\S]{1,9}/g) || []) {
        res.write(JSON.stringify({
          model: modell, created_at: new Date().toISOString(),
          message: { role: 'assistant', content: stueck }, done: false,
        }) + '\\n');
      }
      res.write(JSON.stringify({
        model: modell, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' },
        done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 11,
      }) + '\\n');
      res.end();
    });
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('404 page not found');
});
server.listen(port, host, () => { process.stdout.write('Listening on ' + host + ':' + port + '\\n'); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;

/* --------------------------------------------------------- Wegwerfstick -- */

/**
 * Legt einen echten portablen Datenträger an: Markierung, Datenordner, eine
 * Kopie der Anwendung unter `app/` und den Statisten unter `models/`.
 *
 * Die Kopie der Anwendung ist der Punkt, an dem dieser Test ernst wird:
 * `detectPortable()` sucht die Markierung von `src/portable/` aus nach oben.
 * Nur wenn die Anwendung WIRKLICH auf dem Stick liegt, hält Neural OS sich
 * für portabel — und genau das ist die Bedingung, an der der Laufzeitkern
 * hängen soll.
 */
function stickBauen({ kernName = 'llama-server', beschreibung, modus = {}, modellDatei = true } = {}) {
  const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-stick-')));

  fs.mkdirSync(path.join(wurzel, 'data'), { recursive: true });
  fs.mkdirSync(path.join(wurzel, 'models'), { recursive: true });
  fs.mkdirSync(path.join(wurzel, 'app'), { recursive: true });

  fs.writeFileSync(path.join(wurzel, 'neural-os.portable'), JSON.stringify({
    neuralOsPortable: true,
    dataDir: 'data',
    appDir: 'app',
    createdAt: new Date().toISOString(),
  }, null, 2));

  fs.cpSync(path.join(PROJEKT, 'src'), path.join(wurzel, 'app', 'src'), { recursive: true });
  fs.copyFileSync(path.join(PROJEKT, 'package.json'), path.join(wurzel, 'app', 'package.json'));

  const kern = path.join(wurzel, 'models', kernName);
  fs.writeFileSync(kern, STATIST, { mode: 0o755 });
  if (modus.kernModus !== undefined) fs.chmodSync(kern, modus.kernModus);

  if (modellDatei) fs.writeFileSync(path.join(wurzel, 'models', 'mini-test.gguf'), 'keine echten Gewichte, nur eine Datei');

  const inhalt = beschreibung !== undefined ? beschreibung : {
    version: 1,
    modelle: [{
      id: 'mini-test',
      kern: 'llama-server',
      programm: kernName,
      modell: 'mini-test.gguf',
      args: ['--ctx-size', '4096'],
    }],
  };
  if (inhalt !== null) {
    fs.writeFileSync(
      path.join(wurzel, BESCHREIBUNG),
      typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt, null, 2),
    );
  }

  return {
    wurzel,
    home: path.join(wurzel, 'data'),
    appModul: path.join(wurzel, 'app', 'src', 'app.js'),
    aufraeumen() {
      try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ }
    },
  };
}

/**
 * Ein Laufzeitkern als ORDNER auf dem Stick — der Vertrag mit
 * src/portable/model.js, Punkt 1 und 2:
 *
 *   models/kern/<plattform>/ollama            (oder bin/ollama)
 *   models/kern/<plattform>/lib/ollama/**     (Marker, DLLs, Runner-Ordner)
 *   modelle.json: "programm": "kern/<plattform>/ollama", "dateien" nennt JEDE Datei.
 *
 * Die Bibliotheken stehen in der Liste ABSICHTLICH vor der Programmdatei:
 * ein Leser, der einfach die erste Datei startet, würde hier eine DLL starten.
 *
 * `libDa: false` ist die unvollständige Kopie (Beschreibung nennt lib/, auf
 * dem Stick liegt es nicht). `programmFeld: false` ist der ältere Stick ohne
 * "programm"; `markiert: false` ist eine Liste ohne "art" je Datei.
 */
function kernOrdnerAnlegen(models, {
  plattform = `${process.platform}-${process.arch}`,
  layout = 'flach',
  libDa = true,
  programmFeld = true,
  markiert = true,
} = {}) {
  const wurzelRel = `kern/${plattform}`;
  const programmRel = layout === 'bin' ? 'bin/ollama' : 'ollama';
  const lib = [
    'lib/ollama/marker',
    'lib/ollama/ggml-base.dll',
    'lib/ollama/cuda_v13/ggml-cuda.dll',
    'lib/ollama/vulkan/ggml-vulkan.dll',
  ];
  const alle = [...lib, programmRel];
  const dateien = [];
  for (const rel of alle) {
    const ziel = `${wurzelRel}/${rel}`;
    const abs = path.join(models, ...ziel.split('/'));
    const istProgramm = rel === programmRel;
    if (istProgramm || libDa) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (istProgramm) fs.writeFileSync(abs, OLLAMA_STATIST, { mode: 0o755 });
      else fs.writeFileSync(abs, Buffer.alloc(64, 0x4c));
    }
    const d = { ziel, bytes: 64, pruefsumme: { algo: 'sha256', wert: null, herkunft: null, grund: 'Test' } };
    if (markiert) d.art = istProgramm ? 'programm' : 'bibliothek';
    dateien.push(d);
  }
  const eintrag = {
    id: 'kern:ollama',
    art: 'ollama',
    rolle: 'kern',
    name: 'ollama',
    plattform,
    bytes: 64 * alle.length,
    dateien,
    zeitpunkt: new Date().toISOString(),
    start: 'Ollama vom Stick',
  };
  if (programmFeld) eintrag.programm = `${wurzelRel}/${programmRel}`;
  return {
    eintrag,
    programm: path.join(models, ...`${wurzelRel}/${programmRel}`.split('/')),
    ordner: path.join(models, ...wurzelRel.split('/')),
    kernWurzel: path.join(models, ...wurzelRel.split('/')),
  };
}

/** Der Ollama-Speicher auf dem Stick (models/ollama) plus sein Eintrag. */
function ollamaSpeicherAnlegen(models) {
  fs.mkdirSync(path.join(models, 'ollama', 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(models, 'ollama', 'blobs', 'sha256-abc'), 'blob');
  return {
    id: 'ollama:statist', art: 'ollama', rolle: 'modell', name: 'statist:latest', plattform: null, bytes: 4,
    dateien: [{ ziel: 'ollama/blobs/sha256-abc', bytes: 4, art: 'blob', pruefsumme: { algo: 'sha256', wert: 'abc' } }],
    zeitpunkt: new Date().toISOString(), start: 'über OLLAMA_MODELS',
  };
}

/** Ordner-Kern und Speicher in einen (vorhandenen oder neuen) Stick schreiben. */
function ollamaStickSchreiben(wurzel, opts = {}) {
  const models = path.join(wurzel, 'models');
  fs.mkdirSync(models, { recursive: true });
  const kern = kernOrdnerAnlegen(models, opts);
  const speicher = ollamaSpeicherAnlegen(models);
  fs.writeFileSync(path.join(wurzel, BESCHREIBUNG), `${JSON.stringify({
    version: 1,
    hinweis: 'Diese Datei beschreibt, was im Ordner "models" liegt.',
    erstellt: new Date().toISOString(),
    aktualisiert: new Date().toISOString(),
    eintraege: [kern.eintrag, speicher],
  }, null, 2)}\n`);
  return { ...kern, models, speicherOrdner: path.join(models, 'ollama') };
}

/** Ein Kern-Ordner auf der Festplatte (nicht auf einem Stick) — der Download-Ordner des Besitzers. */
function heimischerKern({ layout = 'flach', libDa = true } = {}) {
  const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-downloads-')));
  const ordner = path.join(wurzel, 'ollama-linux-amd64');
  const programm = layout === 'bin' ? path.join(ordner, 'bin', 'ollama') : path.join(ordner, 'ollama');
  fs.mkdirSync(path.dirname(programm), { recursive: true });
  fs.writeFileSync(programm, OLLAMA_STATIST, { mode: 0o755 });
  if (libDa) {
    fs.mkdirSync(path.join(ordner, 'lib', 'ollama'), { recursive: true });
    fs.writeFileSync(path.join(ordner, 'lib', 'ollama', 'marker'), 'x');
  }
  return {
    wurzel,
    ordner,
    programm,
    aufraeumen() { try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ } },
  };
}

/** JSON von einer Adresse holen — der Draht, nicht die Schleuse. */
function jsonHolen(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      const teile = [];
      r.on('data', (c) => teile.push(c));
      r.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(teile).toString('utf8'))); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

/** Lebt dieser Prozess noch? Die Prozesstabelle wird gefragt, nicht geraten. */
function inProzesstabelle(pid) {
  if (!pid) return false;
  try {
    // `ps -p` beantwortet genau diese Frage und kennt im Gegensatz zu
    // process.kill(pid, 0) keinen Zombie-Sonderfall: ein beendeter, aber noch
    // nicht abgeholter Kindprozess soll hier NICHT als "läuft" durchgehen.
    const aus = execFileSync('ps', ['-o', 'pid=,stat=', '-p', String(pid)], { encoding: 'utf8' });
    const zeile = aus.trim();
    if (!zeile) return false;
    return !/\bZ\b|Z$|Z\+/.test(zeile.split(/\s+/)[1] || '');
  } catch (err) {
    if (err && err.status === 1) return false; // ps: kein solcher Prozess
    // Kein ps vorhanden (exotische Umgebung): zweitbeste Auskunft.
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}

/** Minimaler HTTP-Client, damit der Test den echten Draht benutzt. */
function anfrage(base, method, pfad, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pfad, base);
    const nutzlast = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        ...(nutzlast ? { 'content-type': 'application/json', 'content-length': nutzlast.length } : {}),
        ...(method !== 'GET' ? { 'x-neural-os': '1' } : {}),
      },
    }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => {
        const text = Buffer.concat(teile).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* SSE ist kein JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (nutzlast) req.write(nutzlast);
    req.end();
  });
}

/** Die `data:`-Zeilen eines fertig gelesenen SSE-Stroms. */
function sseEreignisse(text) {
  const raus = [];
  for (const block of String(text).split(/\n\n/)) {
    for (const zeile of block.split(/\n/)) {
      if (!zeile.startsWith('data:')) continue;
      const roh = zeile.slice(5).trim();
      if (!roh || roh === '[DONE]') continue;
      try { raus.push(JSON.parse(roh)); } catch { /* Kommentarzeile */ }
    }
  }
  return raus;
}

async function warteAuf(pruefen, msMax = 8000, takt = 50) {
  const ende = Date.now() + msMax;
  for (;;) {
    const wert = await pruefen();
    if (wert) return wert;
    if (Date.now() >= ende) return null;
    await new Promise((r) => setTimeout(r, takt));
  }
}

/* ============================ Der ganze Weg ============================= */

test('DER GANZE WEG: Kern auf dem Stick -> Start -> echte Antwort -> Kern ist weg', async () => {
  const stick = stickBauen();
  const { createApp } = require(stick.appModul);
  let app = null;
  let pid = null;
  let base = null;
  try {
    app = await createApp({ home: stick.home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });

    // 1. Die Instanz muss sich selbst für portabel halten -- sonst prüft
    //    dieser Test etwas anderes, als er zu prüfen behauptet.
    assert.ok(app.portable, 'die Instanz muss sich als portabel erkennen');
    assert.equal(app.portable.root, stick.wurzel);
    assert.ok(app.localRunner, 'im portablen Betrieb muss es einen Aufseher geben');

    // 2. createApp() darf NICHTS gestartet haben.
    assert.equal(app.localRunner.zustand().pid, null, 'createApp() darf keinen Prozess starten');

    const server = await app.listen();
    base = `http://127.0.0.1:${server.server.address().port}`;

    // 3. Jetzt läuft ein echter Kindprozess.
    const nachStart = app.localRunner.zustand();
    assert.ok(nachStart.pid, 'nach listen() muss ein Kindprozess laufen');
    assert.ok([ZUSTAND.startet, ZUSTAND.laeuft].includes(nachStart.zustand), `unerwarteter Zustand: ${nachStart.zustand}`);
    pid = nachStart.pid;
    assert.ok(inProzesstabelle(pid), 'der Kern muss in der Prozesstabelle stehen');

    // 4. Er hängt an 127.0.0.1 und an einem Port, den niemand vorgegeben hat.
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(nachStart.baseUrl), `unerwartete Adresse: ${nachStart.baseUrl}`);
    const port = nachStart.port;
    assert.ok(port > 0 && port !== 8080 && port !== 11434, 'der Port muss gesucht und nicht geraten sein');

    // 5. Bereitschaft wird GEMESSEN.
    const bereit = await app.localRunner.bereit();
    assert.equal(bereit.zustand, ZUSTAND.laeuft, `der Kern muss bereit werden, war aber: ${bereit.grund}`);

    // 6. Für die Netzschleuse ist das kein Netzzugriff.
    const urteil = app.gate.check({ host: '127.0.0.1', port, scope: 'stick:modell', purpose: 'Test', record: false });
    assert.equal(urteil.allowed, true, 'die Schleuse muss 127.0.0.1 durchlassen');
    assert.equal(urteil.classification, 'loopback');
    const durchDieSchleuse = await app.gate.fetch(`${nachStart.baseUrl}/models`, {
      scope: 'stick:modell', purpose: 'Test: spricht der Kern vom Stick?',
    });
    assert.equal(durchDieSchleuse.status, 200, 'der Kern muss DURCH die Schleuse erreichbar sein');

    // 7. Und er hat sich wirklich nur an die Rückschleife gebunden.
    const gemeldet = JSON.parse(await durchDieSchleuse.text());
    assert.equal(gemeldet.gebundenAn.address, '127.0.0.1', 'der Kern darf nicht auf 0.0.0.0 lauschen');
    assert.equal(gemeldet.pid, pid, 'die Auskunft muss von genau diesem Prozess kommen');

    // 8. Der Chat findet ihn OHNE dass jemand etwas einstellt.
    const modelle = await warteAuf(async () => {
      const r = await anfrage(base, 'GET', '/api/models');
      const stickAnbieter = (r.json && r.json.providers || []).find((p) => p.id === 'stick');
      return stickAnbieter && stickAnbieter.available ? stickAnbieter : null;
    });
    assert.ok(modelle, 'der Kern vom Stick muss als erreichbarer Anbieter auftauchen');
    assert.equal(modelle.vomStick, true, 'die Selbstauskunft muss sagen, dass dieses Modell vom Stick kommt');
    assert.equal(modelle.quelle, 'stick');
    assert.deepEqual(modelle.models.map((m) => m.id), ['mini-test.gguf']);

    // Und die andere Selbstauskunft sagt dasselbe.
    const befund = await app.doctor();
    const imBefund = befund.models.providers.find((p) => p.id === 'stick');
    assert.ok(imBefund && imBefund.vomStick === true, 'doctor() muss den Kern als "vom Stick" ausweisen');
    assert.equal(befund.stickModell.zustand, ZUSTAND.laeuft);
    assert.equal(befund.stickModell.vomStick, true);

    // 9. Eine ECHTE Antwort, die aus genau diesem Prozess stammt.
    const chat = await anfrage(base, 'POST', '/api/chats', { title: 'Stickprobe' });
    assert.equal(chat.status, 200, chat.text);
    const gesendet = await anfrage(base, 'POST', `/api/chats/${chat.json.record.id}/send`, {
      content: 'Wer antwortet hier eigentlich?',
    });
    assert.equal(gesendet.status, 200, gesendet.text);
    const ereignisse = sseEreignisse(gesendet.text);
    const fehler = ereignisse.find((e) => e.type === 'error');
    assert.equal(fehler, undefined, `kein Fehler erwartet: ${fehler && JSON.stringify(fehler.error)}`);
    const nachricht = ereignisse.find((e) => e.type === 'message');
    assert.ok(nachricht, 'es muss eine Antwortnachricht geben');
    const inhalt = nachricht.record.data.content;
    assert.ok(
      inhalt.includes(`STATIST-PID ${pid}`),
      `die Antwort muss aus dem Kern vom Stick stammen, kam aber als: ${inhalt}`,
    );
    assert.ok(inhalt.includes('Wer antwortet hier eigentlich?'), 'der Kern muss die echte Frage gelesen haben');
    assert.equal(nachricht.record.data.model.provider, 'stick');

    // 10. Beenden -- und der Kern ist WEG.
    await app.close();
    app = null;
    const weg = await warteAuf(async () => !inProzesstabelle(pid), 5000);
    assert.ok(weg, `der Kern (PID ${pid}) läuft nach dem Beenden noch — das ist der Schaden, den es nicht geben darf`);
    // Und die Adresse ist niemandem mehr versprochen.
    await assert.rejects(() => anfrage(`http://127.0.0.1:${port}`, 'GET', '/v1/models'));
  } finally {
    if (app) await app.close().catch(() => {});
    if (pid && inProzesstabelle(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* egal */ } }
    stick.aufraeumen();
  }
});

test('GEGENFALL: der Kern stirbt beim Start — die Anwendung fährt trotzdem hoch und sagt, was los ist', async () => {
  const stick = stickBauen();
  const { createApp } = require(stick.appModul);
  let app = null;
  process.env.KERN_STIRB = '1';
  try {
    app = await createApp({ home: stick.home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;

    // Hochgefahren ist sie.
    const status = await anfrage(base, 'GET', '/api/status');
    assert.equal(status.status, 200, 'die Anwendung muss trotz totem Kern bedienbar sein');

    const zustand = await warteAuf(async () => {
      const z = app.localRunner.zustand();
      return z.zustand === ZUSTAND.gescheitert ? z : null;
    }, 8000);
    assert.ok(zustand, 'ein Kern, der stirbt, muss als gescheitert dastehen');
    assert.equal(zustand.pid, null);

    // Der Satz muss einem Menschen etwas sagen -- inklusive der letzten
    // Zeilen, die der Kern ausgegeben hat.
    assert.match(zustand.grund, /beendet/, `unbrauchbarer Grund: ${zustand.grund}`);
    assert.match(zustand.grund, /nicht genug Arbeitsspeicher/, 'die Fehlerausgabe des Kerns muss im Grund stehen');
    assert.ok(zustand.ausgabe.some((z) => z.includes('error loading model')), 'die letzten Ausgabezeilen müssen erhalten bleiben');

    // Und es steht ehrlich im Selbstbericht statt irgendwo im Log.
    const befund = await app.doctor();
    assert.equal(befund.stickModell.zustand, ZUSTAND.gescheitert);
    assert.ok(
      (status.json.failures || []).concat(befund.failures || []).some((f) => f.subsystem === 'stick-modell'),
      'der Fehlschlag gehört in die Liste der Fehlstarts',
    );

    // Nichts wird erfunden: es gibt keinen Anbieter "stick".
    const modelle = await anfrage(base, 'GET', '/api/models');
    assert.equal((modelle.json.providers || []).some((p) => p.id === 'stick'), false,
      'ein Kern, der nicht läuft, darf nicht als Anbieter auftauchen');
  } finally {
    delete process.env.KERN_STIRB;
    if (app) await app.close().catch(() => {});
    stick.aufraeumen();
  }
});

test('GEGENFALL: der Prozess lebt, die Schnittstelle bleibt stumm — das ist nicht "läuft"', async () => {
  const stick = stickBauen();
  let runner = null;
  process.env.KERN_LAHM = '1';
  try {
    runner = createLocalRunner({ stickRoot: stick.wurzel });
    const gestartet = await runner.starten({ timeoutMs: 1200 });
    assert.equal(gestartet.zustand, ZUSTAND.startet, 'solange nichts antwortet, ist der Zustand "startet"');
    assert.ok(gestartet.pid, 'der Prozess selbst lebt');

    const danach = await runner.bereit();
    assert.equal(danach.zustand, ZUSTAND.gescheitert, 'nach der Frist ist es gescheitert, nicht "läuft"');
    assert.match(danach.grund, /antwortet aber nach 1 Sekunden immer noch nicht/);
  } finally {
    delete process.env.KERN_LAHM;
    if (runner) await runner.stoppen({ fristMs: 500 });
    stick.aufraeumen();
  }
});

test('Ein Kern ohne Ausführbar-Bit bekommt einen Satz, mit dem ein Mensch etwas anfangen kann', async () => {
  const stick = stickBauen({ modus: { kernModus: 0o644 } });
  let runner = null;
  try {
    runner = createLocalRunner({ stickRoot: stick.wurzel });
    const zustand = await runner.starten({ timeoutMs: 1000 });
    assert.equal(zustand.zustand, ZUSTAND.gescheitert);
    assert.match(zustand.grund, /Ausführbar-Bit|EACCES/);
    assert.match(zustand.grund, /chmod \+x/, 'der Satz muss sagen, was zu tun ist');
    assert.equal(zustand.pid, null, 'nach einem gescheiterten Start darf keine PID mehr dastehen');
    // Und es bleibt keine Notbremse mit toter PID hängen.
    assert.ok(process.listenerCount('exit') < 5, 'ein Fehlstart darf keinen Horcher zurücklassen');
  } finally {
    if (runner) await runner.stoppen({ fristMs: 500 });
    stick.aufraeumen();
  }
});

test('stoppen() nimmt auch einen Kern mit, der SIGTERM ignoriert', async () => {
  const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-stur-')));
  let runner = null;
  let pid = null;
  try {
    fs.mkdirSync(path.join(wurzel, 'models'), { recursive: true });
    fs.writeFileSync(path.join(wurzel, 'models', 'llama-server'), [
      '#!/usr/bin/env node',
      "process.on('SIGTERM', () => {});", // stur: hört SIGTERM und tut nichts
      'setInterval(() => {}, 1000);',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(wurzel, 'models', 'stur.gguf'), 'keine echten Gewichte');
    fs.writeFileSync(path.join(wurzel, BESCHREIBUNG), JSON.stringify({
      modelle: [{ id: 'stur', kern: 'llama-server', programm: 'llama-server', modell: 'stur.gguf' }],
    }));

    runner = createLocalRunner({ stickRoot: wurzel });
    const zustand = await runner.starten({ timeoutMs: 300 });
    pid = zustand.pid;
    assert.ok(pid, 'der sture Kern muss laufen');
    assert.ok(inProzesstabelle(pid));

    const ergebnis = await runner.stoppen({ fristMs: 400 });
    assert.equal(ergebnis.hart, true, 'nach der Frist muss SIGKILL folgen');
    assert.equal(ergebnis.gestoppt, true);
    const weg = await warteAuf(async () => !inProzesstabelle(pid), 4000);
    assert.ok(weg, 'auch ein sturer Kern muss verschwinden');
  } finally {
    if (pid && inProzesstabelle(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* egal */ } }
    try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ }
  }
});

test('Ein Port, der zwischen Suchen und Binden belegt wird, kostet einen zweiten Versuch — nicht den Start', async () => {
  const stick = stickBauen();
  let runner = null;
  let pid = null;
  try {
    // Der Kern scheitert beim ERSTEN Start so, wie ein echter Kern an einem
    // belegten Port scheitert -- danach läuft er. Genau dieser Wimpernschlag
    // zwischen "Port war frei" und "Kern bindet ihn" ist gemeint.
    const marke = path.join(stick.wurzel, 'models', '.einmal-gescheitert');
    fs.writeFileSync(path.join(stick.wurzel, 'models', 'llama-server'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const marke = ${JSON.stringify(marke)};`,
      'if (!fs.existsSync(marke)) {',
      "  fs.writeFileSync(marke, 'x');",
      "  process.stderr.write('bind: Address already in use (EADDRINUSE)\\n');",
      '  process.exit(1);',
      '}',
      `process.argv[1] = ${JSON.stringify(path.join(stick.wurzel, 'models', 'echt'))};`,
      `require(${JSON.stringify(path.join(stick.wurzel, 'models', 'echt.js'))});`,
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(stick.wurzel, 'models', 'echt.js'), STATIST);

    runner = createLocalRunner({ stickRoot: stick.wurzel });
    const zustand = await runner.starten({ timeoutMs: 6000, warten: true });
    assert.ok(fs.existsSync(marke), 'der erste Versuch muss wirklich stattgefunden haben');
    assert.equal(zustand.zustand, ZUSTAND.laeuft, `der zweite Versuch muss tragen: ${zustand.grund}`);
    pid = zustand.pid;
    assert.ok(pid);
  } finally {
    if (runner) await runner.stoppen({ fristMs: 800 });
    if (pid && inProzesstabelle(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* egal */ } }
    stick.aufraeumen();
  }
});

test('NOTBREMSE: stirbt Neural OS, ohne close() zu erreichen, stirbt der Kern mit', async () => {
  const stick = stickBauen();
  const hilfe = path.join(stick.wurzel, 'absturz.js');
  let kernPid = null;
  try {
    // Ein eigener Prozess, der den Aufseher benutzt und sich dann UMBRINGT,
    // ohne zu stoppen -- also genau der Absturzfall. Bliebe der Kern übrig,
    // hielte er auf einem fremden Rechner mehrere Gigabyte fest, bis jemand
    // neu startet. Das ist der Schaden, gegen den die Notbremse steht.
    fs.writeFileSync(hilfe, [
      "const { createLocalRunner } = require(process.argv[2]);",
      'createLocalRunner({ stickRoot: process.argv[3] }).starten({ warten: true }).then((z) => {',
      "  process.stdout.write(JSON.stringify({ pid: z.pid, zustand: z.zustand }));",
      '  process.exit(0);', // kein stoppen(), kein close(): nur weg
      '});',
    ].join('\n'));

    const aus = execFileSync(process.execPath, [
      hilfe, path.join(PROJEKT, 'src', 'models', 'local-runner.js'), stick.wurzel,
    ], { encoding: 'utf8', timeout: 30000 });
    const gemeldet = JSON.parse(aus.trim());
    assert.equal(gemeldet.zustand, ZUSTAND.laeuft, 'der Kern muss im Hilfsprozess wirklich gelaufen sein');
    kernPid = gemeldet.pid;
    assert.ok(kernPid);

    const weg = await warteAuf(async () => !inProzesstabelle(kernPid), 5000);
    assert.ok(weg, `der Kern (PID ${kernPid}) hat seinen abgestürzten Elternprozess überlebt`);
  } finally {
    if (kernPid && inProzesstabelle(kernPid)) { try { process.kill(kernPid, 'SIGKILL'); } catch { /* egal */ } }
    stick.aufraeumen();
  }
});

/* ===================== Die Beschreibungsdatei lesen ====================== */

test('Ohne models/modelle.json ist der Zustand "nicht vorhanden" — kein Fehler', async () => {
  const stick = stickBauen({ beschreibung: null });
  try {
    const runner = createLocalRunner({ stickRoot: stick.wurzel });
    const zustand = await runner.starten();
    assert.equal(zustand.zustand, ZUSTAND.fehlt);
    assert.match(zustand.grund, /kein/i);
    assert.equal(zustand.pid, null);
  } finally {
    stick.aufraeumen();
  }
});

test('Eine Beschreibungsdatei, die nicht verstanden wird, führt zu einem Satz — nicht zu einer Vermutung', async () => {
  for (const [datei, erwartet] of [
    ['{kaputt', /kein gültiges JSON/],
    [JSON.stringify({ irgendwas: 'anderes' }), /erkenne darin keine Liste/],
    [JSON.stringify({ modelle: [{ id: 'x', rolle: 'kern', art: 'llama.cpp' }] }), /nicht, welches Programm/],
    [JSON.stringify({ modelle: [{ id: 'x', programm: 'fehlt-komplett' }] }), /liegt nicht auf dem Datenträger/],
    [JSON.stringify({ modelle: [{ id: 'x', programm: '../../../bin/sh' }] }), /aus dem Datenträger hinaus/],
    [JSON.stringify({ modelle: [{ id: 'x', programm: 'mini-test.gguf' }] }), /welche Schnittstelle der Kern spricht/],
    [JSON.stringify({ modelle: [{ id: 'x', kern: 'llama.cpp', programm: 'llama-server' }] }), /keine Modelldatei/],
    [JSON.stringify({ modelle: [{ id: 'x', kern: 'ollama', programm: 'llama-server' }] }), /kein Modellspeicher/],
  ]) {
    const stick = stickBauen({ beschreibung: datei });
    try {
      const runner = createLocalRunner({ stickRoot: stick.wurzel });
      const zustand = await runner.starten({ timeoutMs: 500 });
      assert.equal(zustand.zustand, ZUSTAND.gescheitert, `für "${datei.slice(0, 40)}" wurde ein Scheitern erwartet`);
      assert.match(zustand.grund, erwartet);
      assert.equal(zustand.pid, null, 'bei einer unverstandenen Datei darf NICHTS gestartet werden');
    } finally {
      stick.aufraeumen();
    }
  }
});

test('Ein Eintrag für eine andere Plattform wird übersprungen und benannt', async () => {
  const stick = stickBauen({
    beschreibung: {
      modelle: [{ id: 'fremd', kern: 'llama-server', programm: 'llama-server', plattform: 'plan9-sparc' }],
    },
  });
  try {
    const runner = createLocalRunner({ stickRoot: stick.wurzel });
    const zustand = await runner.starten({ timeoutMs: 500 });
    assert.equal(zustand.zustand, ZUSTAND.gescheitert);
    assert.match(zustand.grund, /nicht für .*gedacht/);
  } finally {
    stick.aufraeumen();
  }
});

test('Verschiedene Schreibweisen derselben Datei werden verstanden', async () => {
  const varianten = [
    { models: [{ name: 'a', engine: 'llama.cpp', bin: 'llama-server', modell: 'mini-test.gguf' }] },
    [{ id: 'c', kind: 'llama-server', command: 'llama-server', gguf: 'mini-test.gguf' }],
    { id: 'd', kern: 'llama-server', programm: 'llama-server', model: 'mini-test.gguf' },
  ];
  for (const variante of varianten) {
    const stick = stickBauen({ beschreibung: variante });
    try {
      const runner = createLocalRunner({ stickRoot: stick.wurzel });
      const gelesen = runner.beschreibungLesen();
      assert.ok(gelesen.eintrag, `nicht verstanden: ${JSON.stringify(variante).slice(0, 70)} -> ${gelesen.fehler || gelesen.grund}`);
      assert.equal(gelesen.eintrag.programm, path.join(stick.wurzel, 'models', 'llama-server'));
      assert.equal(gelesen.eintrag.art, 'openai');
    } finally {
      stick.aufraeumen();
    }
  }
});

/**
 * Der eigentliche Vertrag: die Datei, die der Stick selbst schreibt.
 *
 * `src/portable/model.js` legt models/modelle.json mit `eintraege` an, trennt
 * Kern (`rolle: "kern"`) und Gewichte (`rolle: "modell"`) und nennt die Pfade
 * als `dateien[].ziel` RELATIV ZU models/. Gehört wird hier genau das — mit
 * einem Wächter gegen Auseinanderlaufen: die beiden Namen kommen aus
 * `src/portable/stick.js`, nicht aus einer zweiten Abschrift.
 */
function echterStick({ art = 'llama.cpp', plattform = `${process.platform}-${process.arch}` } = {}) {
  const { LAYOUT } = require('../src/portable/stick');
  assert.equal(path.join(LAYOUT.models, LAYOUT.modelsIndex), BESCHREIBUNG,
    'der Ort der Beschreibungsdatei muss der sein, den der Stick benutzt');

  const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-echt-')));
  const models = path.join(wurzel, LAYOUT.models);
  const kernZiel = `kern/${plattform}/${art === 'ollama' ? 'ollama' : 'llama-server'}`;
  fs.mkdirSync(path.join(models, path.dirname(kernZiel)), { recursive: true });
  fs.writeFileSync(path.join(models, kernZiel), STATIST, { mode: 0o755 });

  const eintraege = [{
    id: `kern:${art}`,
    art,
    rolle: 'kern',
    name: path.basename(kernZiel),
    plattform,
    bytes: 4711,
    dateien: [{ ziel: kernZiel, bytes: 4711, pruefsumme: { algo: 'sha256', wert: null } }],
    zeitpunkt: new Date().toISOString(),
    start: 'irgendein Hinweis für Menschen',
  }];

  if (art === 'ollama') {
    fs.mkdirSync(path.join(models, 'ollama', 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(models, 'ollama', 'blobs', 'sha256-abc'), 'blob');
    eintraege.push({
      id: 'ollama:mini', art: 'ollama', rolle: 'modell', name: 'mini:latest', plattform: null, bytes: 4,
      dateien: [{ ziel: 'ollama/blobs/sha256-abc', bytes: 4, pruefsumme: { algo: 'sha256', wert: 'abc' } }],
      zeitpunkt: new Date().toISOString(), start: 'über OLLAMA_MODELS',
    });
  } else {
    // Mehrteilig: llama.cpp wird mit dem ERSTEN Teil geöffnet.
    fs.mkdirSync(path.join(models, 'gguf', 'mini-test'), { recursive: true });
    for (const teil of ['mini-test-00002-of-00002.gguf', 'mini-test-00001-of-00002.gguf']) {
      fs.writeFileSync(path.join(models, 'gguf', 'mini-test', teil), 'keine echten Gewichte');
    }
    eintraege.push({
      id: 'gguf:mini-test@ab12cd', art: 'gguf', rolle: 'modell', name: 'mini-test', plattform: null, bytes: 42,
      dateien: [
        { ziel: 'gguf/mini-test/mini-test-00002-of-00002.gguf', bytes: 21, pruefsumme: { algo: 'sha256', wert: null } },
        { ziel: 'gguf/mini-test/mini-test-00001-of-00002.gguf', bytes: 21, pruefsumme: { algo: 'sha256', wert: null } },
      ],
      zeitpunkt: new Date().toISOString(), start: 'mit -m öffnen',
    });
  }

  fs.writeFileSync(path.join(models, LAYOUT.modelsIndex), `${JSON.stringify({
    version: 1,
    hinweis: 'Diese Datei beschreibt, was im Ordner "models" liegt.',
    erstellt: new Date().toISOString(),
    aktualisiert: new Date().toISOString(),
    eintraege,
  }, null, 2)}\n`);

  return {
    wurzel,
    models,
    aufraeumen() { try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ } },
  };
}

test('Die Beschreibungsdatei, die der Stick selbst schreibt, wird verstanden — llama.cpp', async () => {
  const stick = echterStick({ art: 'llama.cpp' });
  let runner = null;
  try {
    runner = createLocalRunner({ stickRoot: stick.wurzel });
    const gelesen = runner.beschreibungLesen();
    assert.ok(gelesen.eintrag, `nicht verstanden: ${gelesen.fehler || gelesen.grund}`);
    assert.equal(gelesen.eintrag.art, 'openai', 'llama.cpp spricht den OpenAI-Dialekt');
    assert.equal(gelesen.eintrag.programm, path.join(stick.models, 'kern', `${process.platform}-${process.arch}`, 'llama-server'));
    assert.equal(
      gelesen.eintrag.modell,
      path.join(stick.models, 'gguf', 'mini-test', 'mini-test-00001-of-00002.gguf'),
      'ein mehrteiliges Modell wird über seinen ersten Teil geöffnet',
    );

    // Und er läuft damit auch wirklich.
    const zustand = await runner.starten({ timeoutMs: 6000, warten: true });
    assert.equal(zustand.zustand, ZUSTAND.laeuft, zustand.grund || '');
    const res = await new Promise((resolve, reject) => {
      http.get(`${zustand.baseUrl}/models`, (r) => {
        const teile = [];
        r.on('data', (c) => teile.push(c));
        r.on('end', () => resolve(JSON.parse(Buffer.concat(teile).toString('utf8'))));
      }).on('error', reject);
    });
    assert.equal(res.data[0].id, 'mini-test-00001-of-00002.gguf', 'der Kern muss die echte Modelldatei geöffnet haben');
  } finally {
    if (runner) await runner.stoppen({ fristMs: 800 });
    stick.aufraeumen();
  }
});

test('Die Beschreibungsdatei, die der Stick selbst schreibt, wird verstanden — Ollama', async () => {
  const stick = echterStick({ art: 'ollama' });
  try {
    const runner = createLocalRunner({ stickRoot: stick.wurzel });
    const gelesen = runner.beschreibungLesen();
    assert.ok(gelesen.eintrag, `nicht verstanden: ${gelesen.fehler || gelesen.grund}`);
    assert.equal(gelesen.eintrag.art, 'ollama');
    assert.equal(gelesen.eintrag.modellOrdner, path.join(stick.models, 'ollama'),
      'Ollama muss auf den Speicher vom Stick gezeigt werden, nicht auf den des fremden Rechners');
  } finally {
    stick.aufraeumen();
  }
});

test('Ein Kern für eine andere Plattform wird benannt, nicht gestartet', async () => {
  const stick = echterStick({ art: 'llama.cpp', plattform: 'plan9-sparc' });
  try {
    const runner = createLocalRunner({ stickRoot: stick.wurzel });
    const zustand = await runner.starten({ timeoutMs: 500 });
    assert.equal(zustand.zustand, ZUSTAND.gescheitert);
    assert.match(zustand.grund, /plan9-sparc/);
    assert.match(zustand.grund, /startet hier nicht/);
    assert.equal(zustand.pid, null);
  } finally {
    stick.aufraeumen();
  }
});

/* ======================= Der Kern ist ein Ordner ======================== */

test('DER KERN IST EIN ORDNER: ollama + lib/ollama/** vom Stick -> Start -> echte Antwort im Ollama-Dialekt -> Kern ist weg', async () => {
  const stick = stickBauen({ beschreibung: null, modellDatei: false });
  const kern = ollamaStickSchreiben(stick.wurzel);
  const { createApp } = require(stick.appModul);
  let app = null;
  let pid = null;
  try {
    app = await createApp({ home: stick.home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    assert.ok(app.portable && app.localRunner, 'die Instanz muss sich als portabel erkennen und einen Aufseher haben');
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;

    const nachStart = app.localRunner.zustand();
    pid = nachStart.pid;
    assert.ok(pid, 'nach listen() muss der Kern laufen');
    assert.equal(nachStart.programm, kern.programm, 'gestartet wird die Datei, auf die "programm" zeigt');
    assert.match(nachStart.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, 'Ollama-Adresse ohne /v1');

    // 1. Bereitschaft ist gemessen, und die Herkunft steht dabei.
    const bereit = await app.localRunner.bereit();
    assert.equal(bereit.zustand, ZUSTAND.laeuft, `der Kern muss bereit werden, war aber: ${bereit.grund}`);
    assert.equal(bereit.quelle, 'stick');
    assert.equal(bereit.vomStick, true);
    assert.equal(bereit.herkunft, 'Modell vom Stick');
    assert.equal(bereit.vollstaendig, true, 'alle beschriebenen Dateien liegen da');
    assert.deepEqual(bereit.fehlendeDateien, []);

    // 2. Was der Kern selbst berichtet: sein Ordner ist sein Arbeitsverzeichnis,
    //    lib/ollama liegt NEBEN ihm, OLLAMA_MODELS zeigt auf den Stick.
    const tags = await jsonHolen(`${bereit.baseUrl}/api/tags`);
    assert.equal(tags.pid, pid, 'die Auskunft muss von genau diesem Prozess kommen');
    assert.equal(tags.cwd, kern.ordner, 'cwd muss der Ordner der Programmdatei sein');
    assert.equal(tags.marker, path.join(kern.kernWurzel, 'lib', 'ollama', 'marker'), 'lib/ollama muss neben der Programmdatei gefunden werden');
    assert.equal(tags.umgebung.OLLAMA_MODELS, kern.speicherOrdner, 'Ollama muss den Speicher VOM STICK bekommen');
    assert.equal(tags.umgebung.OLLAMA_HOST, `127.0.0.1:${bereit.port}`);
    assert.equal(tags.gebundenAn.address, '127.0.0.1', 'nie auf 0.0.0.0');

    // 3. Der Chat findet ihn als Anbieter vom Stick, mit dem Modell, das der Kern nennt.
    const anbieter = await warteAuf(async () => {
      const r = await anfrage(base, 'GET', '/api/models');
      const s = (r.json && r.json.providers || []).find((p) => p.id === 'stick');
      return s && s.available ? s : null;
    });
    assert.ok(anbieter, 'der Kern vom Stick muss als erreichbarer Anbieter auftauchen');
    assert.equal(anbieter.vomStick, true);
    assert.deepEqual(anbieter.models.map((m) => m.id), ['statist:latest']);

    // 4. Eine echte Antwort im Ollama-Dialekt, aus genau diesem Prozess.
    const chat = await anfrage(base, 'POST', '/api/chats', { title: 'Ollama vom Stick' });
    assert.equal(chat.status, 200, chat.text);
    const gesendet = await anfrage(base, 'POST', `/api/chats/${chat.json.record.id}/send`, { content: 'Wer bist du?' });
    assert.equal(gesendet.status, 200, gesendet.text);
    const ereignisse = sseEreignisse(gesendet.text);
    const fehler = ereignisse.find((e) => e.type === 'error');
    assert.equal(fehler, undefined, `kein Fehler erwartet: ${fehler && JSON.stringify(fehler.error)}`);
    const nachricht = ereignisse.find((e) => e.type === 'message');
    assert.ok(nachricht, 'es muss eine Antwortnachricht geben');
    assert.ok(nachricht.record.data.content.includes(`STATIST-PID ${pid}`), `Antwort kam nicht vom Kern: ${nachricht.record.data.content}`);
    assert.ok(nachricht.record.data.content.includes('Wer bist du?'));
    assert.equal(nachricht.record.data.model.provider, 'stick');

    // 5. Beenden — und weg.
    await app.close();
    app = null;
    const weg = await warteAuf(async () => !inProzesstabelle(pid), 5000);
    assert.ok(weg, `der Kern (PID ${pid}) läuft nach dem Beenden noch`);
  } finally {
    if (app) await app.close().catch(() => {});
    if (pid && inProzesstabelle(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* egal */ } }
    stick.aufraeumen();
  }
});

test('Tarball-Struktur: bin/ollama + lib/ollama gilt ebenso — die Programmdatei unter bin/ wird gestartet', async () => {
  const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-tar-')));
  const kern = ollamaStickSchreiben(wurzel, { layout: 'bin' });
  let runner = null;
  try {
    runner = createLocalRunner({ stickRoot: wurzel });
    const gelesen = runner.beschreibungLesen();
    assert.ok(gelesen.eintrag, gelesen.fehler || gelesen.grund);
    assert.equal(gelesen.eintrag.programm, kern.programm);
    assert.ok(kern.programm.endsWith(path.join('bin', 'ollama')));

    const zustand = await runner.starten({ timeoutMs: 6000, warten: true });
    assert.equal(zustand.zustand, ZUSTAND.laeuft, zustand.grund || '');
    const tags = await jsonHolen(`${zustand.baseUrl}/api/tags`);
    assert.equal(tags.cwd, path.join(kern.kernWurzel, 'bin'), 'cwd ist der Ordner der Programmdatei, also bin/');
    assert.equal(tags.marker, path.join(kern.kernWurzel, 'lib', 'ollama', 'marker'), 'lib/ liegt eine Ebene über bin/');
  } finally {
    if (runner) await runner.stoppen({ fristMs: 800 });
    try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ }
  }
});

test('GEGENFALL: lib/ fehlt — Neural OS fährt trotzdem hoch, der Satz enthält die Fehlerausgabe und sagt, was zu tun ist', async () => {
  const stick = stickBauen({ beschreibung: null, modellDatei: false });
  const kern = ollamaStickSchreiben(stick.wurzel, { libDa: false });
  const { createApp } = require(stick.appModul);
  let app = null;
  try {
    assert.ok(fs.existsSync(kern.programm), 'die Programmdatei liegt da');
    assert.ok(!fs.existsSync(path.join(kern.kernWurzel, 'lib')), 'lib/ liegt NICHT da');

    app = await createApp({ home: stick.home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;

    // Hochgefahren ist sie.
    const status = await anfrage(base, 'GET', '/api/status');
    assert.equal(status.status, 200, 'die Anwendung muss trotz totem Kern bedienbar sein');

    const zustand = await warteAuf(async () => {
      const z = app.localRunner.zustand();
      return z.zustand === ZUSTAND.gescheitert ? z : null;
    }, 8000);
    assert.ok(zustand, 'ein Kern ohne lib/ muss als gescheitert dastehen');
    assert.equal(zustand.pid, null);

    // Der Satz: deutsch, mit der Fehlerausgabe des Kerns und dem Rat.
    assert.match(zustand.grund, /gleich nach dem Start mit Code 1 beendet/, `unbrauchbarer Grund: ${zustand.grund}`);
    assert.match(zustand.grund, /lib\/ fehlt/, 'die letzte Zeile der Fehlerausgabe muss im Grund stehen');
    assert.match(zustand.grund, /Was zu tun ist/);
    assert.match(zustand.grund, /fehlen 4 von 5 Dateien/, 'die Beschreibung nennt 5 Dateien, 4 fehlen');
    assert.match(zustand.grund, /lib\/ollama\/marker/, 'die fehlenden Dateien werden beim Namen genannt');
    assert.match(zustand.grund, /auf dem Quellrechner noch einmal mit/, 'der Rat: Modell auf dem Quellrechner erneut mitnehmen');
    assert.ok(zustand.ausgabe.some((z) => z.includes('lib/ fehlt')), 'die Ausgabezeilen bleiben erhalten');
    assert.equal(zustand.vollstaendig, false);
    assert.ok(zustand.fehlendeDateien.includes(kern.eintrag.dateien[0].ziel));
    assert.equal(zustand.quelle, 'stick', 'auch ein gescheiterter Kern hat eine Herkunft');

    // Ehrlich im Selbstbericht, und kein Anbieter "stick".
    const befund = await app.doctor();
    assert.equal(befund.stickModell.zustand, ZUSTAND.gescheitert);
    assert.ok((befund.failures || []).some((f) => f.subsystem === 'stick-modell'));
    const modelle = await anfrage(base, 'GET', '/api/models');
    assert.equal((modelle.json.providers || []).some((p) => p.id === 'stick'), false);
  } finally {
    if (app) await app.close().catch(() => {});
    stick.aufraeumen();
  }
});

test('Läuft der Kern trotz fehlender Dateien, steht das als Hinweis da — kein grüner Haken ohne Fußnote', async () => {
  const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-luecke-')));
  let runner = null;
  try {
    // Das echte Ollama startet auch ohne lib/ollama und rechnet dann bloß kein
    // Modell. Hier: der Marker liegt da (der Statist lebt), aber zwei der
    // beschriebenen Bibliotheken fehlen -- die Kopie wurde abgebrochen.
    const kern = ollamaStickSchreiben(wurzel);
    fs.rmSync(path.join(kern.kernWurzel, 'lib', 'ollama', 'cuda_v13'), { recursive: true });
    fs.rmSync(path.join(kern.kernWurzel, 'lib', 'ollama', 'vulkan'), { recursive: true });

    runner = createLocalRunner({ stickRoot: wurzel });
    const zustand = await runner.starten({ timeoutMs: 6000, warten: true });
    assert.equal(zustand.zustand, ZUSTAND.laeuft, zustand.grund || '');
    assert.equal(zustand.vollstaendig, false);
    assert.deepEqual(zustand.fehlendeDateien.sort(), [
      `kern/${process.platform}-${process.arch}/lib/ollama/cuda_v13/ggml-cuda.dll`,
      `kern/${process.platform}-${process.arch}/lib/ollama/vulkan/ggml-vulkan.dll`,
    ]);
    assert.match(zustand.hinweis, /fehlen 2 von 5 Dateien/);
    assert.match(zustand.hinweis, /ggml-cuda\.dll/);
    assert.match(zustand.hinweis, /Quellrechner noch einmal mit/);
  } finally {
    if (runner) await runner.stoppen({ fristMs: 800 });
    try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ }
  }
});

test('Ein älterer Stick ohne "programm": die Programmdatei kommt aus der Dateiliste — nie eine Bibliothek unter lib/', async () => {
  for (const variante of [{ markiert: true }, { markiert: false }]) {
    const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-alt-')));
    try {
      const kern = ollamaStickSchreiben(wurzel, { programmFeld: false, ...variante });
      assert.equal(kern.eintrag.programm, undefined);
      assert.match(kern.eintrag.dateien[0].ziel, /lib\/ollama/, 'die erste Datei der Liste ist eine Bibliothek');
      const runner = createLocalRunner({ stickRoot: wurzel });
      const gelesen = runner.beschreibungLesen();
      assert.ok(gelesen.eintrag, `${JSON.stringify(variante)}: ${gelesen.fehler || gelesen.grund}`);
      assert.equal(gelesen.eintrag.programm, kern.programm, `${JSON.stringify(variante)}: falsche Programmdatei`);
      assert.equal(gelesen.eintrag.modellOrdner, kern.speicherOrdner);
    } finally {
      try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ }
    }
  }
});

test('Zeigt "programm" auf eine Datei, die fehlt, wird nicht auf eine andere ausgewichen', async () => {
  const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-weg-')));
  try {
    const kern = ollamaStickSchreiben(wurzel);
    fs.rmSync(kern.programm);
    const runner = createLocalRunner({ stickRoot: wurzel });
    const zustand = await runner.starten({ timeoutMs: 500 });
    assert.equal(zustand.zustand, ZUSTAND.gescheitert);
    assert.match(zustand.grund, /liegt nicht auf dem Datenträger/);
    assert.match(zustand.grund, /Quellrechner/);
    assert.equal(zustand.pid, null);
  } finally {
    try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ }
  }
});

/* ========================== Der Rechner selbst ========================== */

test('DER RECHNER SELBST: config.models.kern startet einen Kern — ohne modellOrdner bleibt OLLAMA_MODELS unangetastet', async () => {
  const heim = heimischerKern();
  const vorher = process.env.OLLAMA_MODELS;
  delete process.env.OLLAMA_MODELS; // der Fall des Besitzers: die Variable ist NICHT gesetzt
  let runner = null;
  let pid = null;
  try {
    runner = createLocalRunner({ kern: { programm: heim.programm, modellOrdner: null } });
    assert.equal(runner.vorhanden(), true);
    assert.equal(runner.zustand().quelle, 'konfiguration', 'ohne Stick ist die Konfiguration die Quelle — schon vor dem Start');

    const zustand = await runner.starten({ timeoutMs: 6000, warten: true });
    assert.equal(zustand.zustand, ZUSTAND.laeuft, zustand.grund || '');
    pid = zustand.pid;
    assert.ok(inProzesstabelle(pid));
    assert.equal(zustand.quelle, 'konfiguration');
    assert.equal(zustand.vomStick, false);
    assert.equal(zustand.herkunft, 'Modell von diesem Rechner');
    assert.equal(zustand.wurzel, null);
    assert.equal(zustand.modellOrdner, null);
    assert.equal(zustand.programm, heim.programm);
    assert.match(zustand.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const tags = await jsonHolen(`${zustand.baseUrl}/api/tags`);
    assert.equal(tags.pid, pid);
    assert.equal(tags.umgebung.OLLAMA_MODELS, null, 'KEIN OLLAMA_MODELS: Ollama nimmt seinen eigenen Speicher (~/.ollama/models)');
    assert.equal(tags.umgebung.OLLAMA_HOST, `127.0.0.1:${zustand.port}`, 'OLLAMA_HOST auf den freien Port');
    assert.equal(tags.cwd, heim.ordner, 'cwd ist der Ordner der Programmdatei');
    assert.equal(tags.gebundenAn.address, '127.0.0.1');

    const ergebnis = await runner.stoppen({ fristMs: 800 });
    assert.equal(ergebnis.gestoppt, true);
    const weg = await warteAuf(async () => !inProzesstabelle(pid), 4000);
    assert.ok(weg, 'auch der Kern von diesem Rechner muss beim Beenden verschwinden');
    assert.equal(runner.zustand().zustand, ZUSTAND.fehlt);
  } finally {
    if (vorher !== undefined) process.env.OLLAMA_MODELS = vorher;
    if (runner) await runner.stoppen({ fristMs: 300 });
    if (pid && inProzesstabelle(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* egal */ } }
    heim.aufraeumen();
  }
});

test('config.models.kern mit modellOrdner setzt OLLAMA_MODELS genau darauf — und der Ordner der Programmdatei genügt als "programm"', async () => {
  const heim = heimischerKern({ layout: 'bin' });
  const speicher = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-speicher-')));
  let runner = null;
  try {
    runner = createLocalRunner({ kern: { programm: heim.ordner, modellOrdner: speicher } });
    const gelesen = runner.konfigurationLesen();
    assert.ok(gelesen.eintrag, gelesen.fehler);
    assert.equal(gelesen.eintrag.programm, heim.programm, 'im Ordner wird bin/ollama gefunden');

    const zustand = await runner.starten({ timeoutMs: 6000, warten: true });
    assert.equal(zustand.zustand, ZUSTAND.laeuft, zustand.grund || '');
    assert.equal(zustand.modellOrdner, speicher);
    const tags = await jsonHolen(`${zustand.baseUrl}/api/tags`);
    assert.equal(tags.umgebung.OLLAMA_MODELS, speicher);
    assert.equal(tags.marker, path.join(heim.ordner, 'lib', 'ollama', 'marker'));
  } finally {
    if (runner) await runner.stoppen({ fristMs: 800 });
    heim.aufraeumen();
    try { fs.rmSync(speicher, { recursive: true, force: true }); } catch { /* egal */ }
  }
});

test('Ein konfigurierter Kern, der nicht stimmt, scheitert mit einem Satz — nichts startet', async () => {
  const heim = heimischerKern();
  try {
    for (const [kern, erwartet] of [
      [{ programm: path.join(heim.wurzel, 'gibts-nicht', 'ollama'), modellOrdner: null }, /gibt es nicht/],
      [{ programm: 'ollama', modellOrdner: null }, /kein absoluter Pfad/],
      [{ programm: heim.programm, modellOrdner: path.join(heim.wurzel, 'kein-speicher') }, /Modellordner .* gibt es nicht/],
      [{ modellOrdner: null }, /kein "programm"/],
      [{ programm: heim.wurzel, modellOrdner: null }, /ist ein Ordner, aber darin liegt keine Programmdatei/],
    ]) {
      const runner = createLocalRunner({ kern });
      const zustand = await runner.starten({ timeoutMs: 500 });
      assert.equal(zustand.zustand, ZUSTAND.gescheitert, JSON.stringify(kern));
      assert.match(zustand.grund, erwartet, `${JSON.stringify(kern)} -> ${zustand.grund}`);
      assert.equal(zustand.pid, null, 'bei einer falschen Konfiguration darf NICHTS gestartet werden');
      assert.equal(zustand.quelle, 'konfiguration');
    }
  } finally {
    heim.aufraeumen();
  }
});

test('Der Kern aus der Konfiguration stirbt ohne lib/ — der Rat zeigt auf den Ordner neben der Programmdatei, nicht auf einen Stick', async () => {
  const heim = heimischerKern({ libDa: false });
  try {
    const runner = createLocalRunner({ kern: { programm: heim.programm, modellOrdner: null } });
    const zustand = await runner.starten({ timeoutMs: 3000, warten: true });
    assert.equal(zustand.zustand, ZUSTAND.gescheitert);
    assert.match(zustand.grund, /lib\/ fehlt/);
    assert.match(zustand.grund, /Prüfe, ob neben .* der Ordner lib\/ liegt/);
    assert.doesNotMatch(zustand.grund, /Quellrechner/, 'auf dem eigenen Rechner gibt es keinen Quellrechner');
    assert.equal(zustand.pid, null);
  } finally {
    heim.aufraeumen();
  }
});

test('VORRANG: der Stick vor der Konfiguration — startet der Stick hier nicht, greift die Konfiguration mit Hinweis', async () => {
  const heim = heimischerKern();
  const kern = { programm: heim.programm, modellOrdner: null };
  let runner = null;
  try {
    // a) Stick mit brauchbarem Kern: der Stick gewinnt.
    const mitKern = stickBauen();
    try {
      const gewaehlt = createLocalRunner({ stickRoot: mitKern.wurzel, kern }).kernWaehlen();
      assert.ok(gewaehlt.eintrag);
      assert.equal(gewaehlt.eintrag.quelle, 'stick');
      assert.equal(gewaehlt.eintrag.art, 'openai');
    } finally {
      mitKern.aufraeumen();
    }

    // b) Stick ohne Beschreibung: die Konfiguration.
    const leer = stickBauen({ beschreibung: null });
    try {
      const r = createLocalRunner({ stickRoot: leer.wurzel, kern });
      assert.equal(r.kernWaehlen().eintrag.quelle, 'konfiguration');
      assert.equal(r.vorhanden(), true, 'die Konfiguration zählt als "vorhanden"');
      // Ohne Konfiguration bleibt es bei "nicht vorhanden" — kein Fehler.
      const ohne = await createLocalRunner({ stickRoot: leer.wurzel }).starten();
      assert.equal(ohne.zustand, ZUSTAND.fehlt);
    } finally {
      leer.aufraeumen();
    }

    // c) Stick mit Kern für eine andere Plattform: die Konfiguration, und der
    //    Hinweis sagt, warum der Stick nicht dran ist.
    const fremd = echterStick({ art: 'llama.cpp', plattform: 'plan9-sparc' });
    try {
      runner = createLocalRunner({ stickRoot: fremd.wurzel, kern });
      const zustand = await runner.starten({ timeoutMs: 6000, warten: true });
      assert.equal(zustand.zustand, ZUSTAND.laeuft, zustand.grund || '');
      assert.equal(zustand.quelle, 'konfiguration');
      assert.equal(zustand.vomStick, false);
      assert.equal(zustand.herkunft, 'Modell von diesem Rechner');
      assert.match(zustand.hinweis, /Der Kern vom Stick wurde nicht benutzt/);
      assert.match(zustand.hinweis, /plan9-sparc/);
      await runner.stoppen({ fristMs: 800 });
      runner = null;

      // d) Beide unbrauchbar: beide Gründe im Satz.
      const beide = await createLocalRunner({
        stickRoot: fremd.wurzel, kern: { programm: path.join(heim.wurzel, 'nix', 'ollama'), modellOrdner: null },
      }).starten({ timeoutMs: 500 });
      assert.equal(beide.zustand, ZUSTAND.gescheitert);
      assert.match(beide.grund, /gibt es nicht/, 'der Grund der Konfiguration');
      assert.match(beide.grund, /Und vom Stick: .*plan9-sparc/s, 'und der Grund des Sticks');
    } finally {
      fremd.aufraeumen();
    }
  } finally {
    if (runner) await runner.stoppen({ fristMs: 300 });
    heim.aufraeumen();
  }
});

test('Ohne Stick und ohne Konfiguration gibt es keinen Aufseher — das ist ein Fehler beim Bau, kein stiller Leerlauf', () => {
  assert.throws(() => createLocalRunner({}), /stickRoot.*kern|kern.*stickRoot/s);
  assert.throws(() => createLocalRunner({ kern: null }), /Konfiguration/);
});

/* ============================== Kleinteile ============================== */

test('Die Schnittstelle wird erkannt, nicht geraten', () => {
  const { artErkennen } = __internals;
  assert.equal(artErkennen('llama-server', null), 'openai');
  assert.equal(artErkennen('llama.cpp', null), 'openai');
  assert.equal(artErkennen('LM Studio', null), 'openai');
  assert.equal(artErkennen('ollama', null), 'ollama');
  assert.equal(artErkennen(null, '/stick/models/ollama'), 'ollama');
  assert.equal(artErkennen(null, '/stick/models/llama-server'), 'openai');
  // Und das Wichtigste: was unbekannt ist, bleibt unbekannt.
  assert.equal(artErkennen('irgendein-kern', '/stick/models/irgendwas'), null);
  assert.equal(artErkennen(undefined, undefined), null);
});

test('Kein Pfad aus der Beschreibungsdatei führt aus dem Datenträger heraus', () => {
  const { pfadImStick } = __internals;
  const wurzel = path.resolve('/stick');
  const basis = path.join(wurzel, 'models');
  assert.equal(pfadImStick('llama-server', basis, wurzel, 'x').pfad, path.join(basis, 'llama-server'));
  assert.equal(pfadImStick('unter/tief/kern', basis, wurzel, 'x').pfad, path.join(basis, 'unter', 'tief', 'kern'));
  for (const boese of ['/bin/sh', '../../bin/sh', '../../../etc/passwd']) {
    assert.match(pfadImStick(boese, basis, wurzel, 'x').fehler || '', /hinaus/, `${boese} muss abgelehnt werden`);
  }
});

test('Der freie Port kommt vom Betriebssystem und ist wirklich frei', async () => {
  const { freierPort } = __internals;
  const a = await freierPort();
  const b = await freierPort();
  assert.ok(a > 1024 && b > 1024);
  // Er lässt sich sofort belegen -- also war er frei.
  const net = require('node:net');
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(a, '127.0.0.1', () => s.close(resolve));
  });
});

test('Die Registry meldet einen Anbieter nur für diesen Lauf an und wieder ab', async () => {
  const { createRegistry } = require('../src/models/registry');
  const config = { models: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }] } };
  const registry = createRegistry({ config, gate: null });

  registry.anbieterAnmelden({ id: 'stick', kind: 'openai', baseUrl: 'http://127.0.0.1:45678/v1', quelle: 'stick' });
  const liste = registry.list().providers;
  assert.equal(liste[0].id, 'stick', 'der Kern vom Stick steht vorn, damit der Chat ihn ohne Einstellung findet');
  assert.equal(liste[0].vomStick, true);
  assert.equal(liste[0].available, false, 'angemeldet heißt nicht erreichbar — behauptet wird nichts');
  assert.equal(liste[1].vomStick, false);
  assert.equal(liste[1].quelle, 'geraet');

  // Die Konfiguration bleibt unberührt: nichts wird gespeichert.
  assert.equal(config.models.providers.length, 1);

  assert.match(registry.explain(), /\[vom Stick\]/, 'die Erklärung muss die Herkunft nennen');

  assert.equal(registry.anbieterAbmelden('stick'), true);
  assert.equal(registry.list().providers.some((p) => p.id === 'stick'), false);
  assert.equal(registry.anbieterAbmelden('stick'), false);

  // Und es wird nur angemeldet, was auch angesprochen werden kann.
  assert.throws(() => registry.anbieterAnmelden({ id: 'x', kind: 'phantasie', baseUrl: 'http://127.0.0.1:1/v1' }), /Anbietertyp/);
  assert.throws(() => registry.anbieterAnmelden({ id: 'x', kind: 'openai' }), /Adresse/);
});

/* ============================ Windows im Kopf =========================== */

/**
 * Hier gibt es kein Windows. Was sich trotzdem messen lässt, ist die reine
 * Pfad- und Entscheidungslogik — mit path.win32 statt path, und mit einem
 * Dateisystem, das aus drei Funktionen besteht. Was sich NICHT messen lässt
 * (TerminateProcess, ein echtes ollama.exe, DLL-Ladefehler), steht im
 * Bericht als offen — nicht hier als grüner Haken.
 */
test('WINDOWS: Pfade aus der Beschreibungsdatei bleiben auf dem Laufwerk des Sticks (path.win32)', () => {
  const { pfadImStick } = __internals;
  const w = path.win32;
  // Der Stick ist ein Ordner auf dem Laufwerk (so legt ihn "Stick vorbereiten"
  // an), nicht das Laufwerk selbst -- sonst laege E:\Windows "auf dem Stick".
  const wurzel = 'E:\\neural-os';
  const basis = 'E:\\neural-os\\models';
  assert.equal(pfadImStick('kern/win-x64/ollama.exe', basis, wurzel, 'x', w).pfad, 'E:\\neural-os\\models\\kern\\win-x64\\ollama.exe');
  assert.equal(pfadImStick('kern\\win-x64\\lib\\ollama\\ggml-base.dll', basis, wurzel, 'x', w).pfad, 'E:\\neural-os\\models\\kern\\win-x64\\lib\\ollama\\ggml-base.dll');
  assert.equal(pfadImStick('kern/linux-x64/bin/ollama', basis, wurzel, 'x', w).pfad, 'E:\\neural-os\\models\\kern\\linux-x64\\bin\\ollama');
  for (const boese of [
    '..\\..\\Windows\\System32\\cmd.exe',     // nach oben hinaus
    'C:\\Windows\\System32\\cmd.exe',         // anderes Laufwerk
    '\\Windows\\System32\\cmd.exe',           // Laufwerkswurzel (E:\Windows, neben dem Stick)
    '..\\..\\',                               // ueber die Wurzel hinaus
    '..',                                     // die Wurzel selbst
  ]) {
    assert.match(pfadImStick(boese, basis, wurzel, 'x', w).fehler || '', /hinaus/, `${boese} muss abgelehnt werden`);
  }
  // Und dieselbe Logik mit POSIX-Pfaden, zur Kontrolle, dass p wirklich benutzt wird.
  assert.equal(pfadImStick('kern/linux-x64/ollama', '/media/usb/models', '/media/usb', 'x', path.posix).pfad, '/media/usb/models/kern/linux-x64/ollama');
});

test('WINDOWS: config.models.kern mit dem Download-Ordner des Besitzers (path.win32)', () => {
  const { kernAusKonfiguration } = __internals;
  const w = path.win32;
  const exe = 'C:\\Users\\User\\Downloads\\ollama-windows-amd64\\ollama.exe';
  const ordner = 'C:\\Users\\User\\Downloads\\ollama-windows-amd64';
  const speicher = 'C:\\Users\\User\\.ollama\\models';
  const platte = {
    plattform: 'win32',
    p: w,
    istDatei: (x) => x === exe,
    istOrdner: (x) => x === ordner || x === speicher,
  };

  // Genau so, wie es der Vertrag nennt.
  let r = kernAusKonfiguration({ programm: exe, modellOrdner: null }, platte);
  assert.ok(r.eintrag, r.fehler);
  assert.equal(r.eintrag.programm, exe);
  assert.equal(r.eintrag.ordner, ordner, 'cwd wird der Ordner der .exe');
  assert.equal(r.eintrag.art, 'ollama');
  assert.equal(r.eintrag.modellOrdner, null, 'null bleibt null: kein OLLAMA_MODELS');
  assert.equal(r.eintrag.quelle, 'konfiguration');
  assert.equal(r.eintrag.name, 'ollama.exe');

  // Der Ordner statt der Datei: die ollama.exe darin wird gefunden.
  r = kernAusKonfiguration({ programm: ordner, modellOrdner: speicher }, platte);
  assert.ok(r.eintrag, r.fehler);
  assert.equal(r.eintrag.programm, exe);
  assert.equal(r.eintrag.modellOrdner, speicher);

  // Endung vergessen: die Datei ist eindeutig.
  r = kernAusKonfiguration({ programm: `${ordner}\\ollama`, modellOrdner: null }, platte);
  assert.ok(r.eintrag, r.fehler);
  assert.equal(r.eintrag.programm, exe);

  // Vorwärtsschrägstriche, wie sie in JSON oft stehen: path.win32 normalisiert sie.
  r = kernAusKonfiguration({ programm: 'C:/Users/User/Downloads/ollama-windows-amd64/ollama.exe', modellOrdner: null }, platte);
  assert.ok(r.eintrag, r.fehler);
  assert.equal(r.eintrag.programm, exe);

  // Was NICHT geht, sagt einen Satz:
  const platteMitBat = { ...platte, istDatei: (x) => x === exe || x === `${ordner}\\ollama.bat` };
  assert.match(kernAusKonfiguration({ programm: `${ordner}\\ollama.bat` }, platteMitBat).fehler, /nur eine \.exe/);
  assert.match(kernAusKonfiguration({ programm: 'ollama.exe' }, platte).fehler, /kein absoluter Pfad/);
  assert.match(kernAusKonfiguration({ programm: 'D:\\ollama.exe' }, platte).fehler, /gibt es nicht/);
  assert.match(kernAusKonfiguration({ programm: exe, modellOrdner: 'D:\\modelle' }, platte).fehler, /Modellordner .* gibt es nicht/);
  assert.match(kernAusKonfiguration({ programm: exe, modellOrdner: 42 }, platte).fehler, /Pfad oder null/);
  assert.equal(kernAusKonfiguration(null, platte).fehlt, true);
});

test('WINDOWS: die Programmdatei endet auf .exe, und win-x64 passt auf win32/x64', () => {
  const { istProgrammDatei, plattformPasst, programmAusDateien } = __internals;
  assert.equal(istProgrammDatei('E:\\models\\kern\\win-x64\\ollama.exe', 'win32'), true);
  assert.equal(istProgrammDatei('E:\\models\\kern\\win-x64\\ollama', 'win32'), false);
  assert.equal(istProgrammDatei('E:\\models\\kern\\win-x64\\ollama.bat', 'win32'), false);
  assert.equal(istProgrammDatei('/stick/models/kern/linux-x64/ollama', 'linux'), true);

  assert.equal(plattformPasst('win-x64', 'win32', 'x64'), true);
  assert.equal(plattformPasst('win-arm64', 'win32', 'x64'), false);
  assert.equal(plattformPasst('win-x64', 'linux', 'x64'), false);
  assert.equal(plattformPasst('linux-x64', 'linux', 'x64'), true);
  assert.equal(plattformPasst(['linux-x64', 'win-x64'], 'win32', 'x64'), true);

  // Die Dateiliste eines Windows-Kerns, Bibliotheken zuerst: die .exe gewinnt,
  // die DLLs unter lib/ kommen nicht einmal in Betracht.
  const windows = [
    'kern/win-x64/lib/ollama/ggml-base.dll',
    'kern/win-x64/lib/ollama/cuda_v13/ggml-cuda.dll',
    'kern/win-x64/lib/ollama/vulkan/ggml-vulkan.dll',
    'kern\\win-x64\\lib\\ollama\\ollama.exe',    // eine .exe unter lib/ ist trotzdem eine Bibliothek
    'kern/win-x64/ollama.exe',
  ];
  assert.deepEqual(programmAusDateien(windows, { plattform: 'win32' }), ['kern/win-x64/ollama.exe']);
  // Tarball unter Linux: bin/ollama, nicht libggml-base.so.
  const linux = ['kern/linux-x64/lib/ollama/libggml-base.so', 'kern/linux-x64/lib/ollama/libggml-cpu.so.1', 'kern/linux-x64/bin/ollama'];
  assert.deepEqual(programmAusDateien(linux, { plattform: 'linux' }), ['kern/linux-x64/bin/ollama']);
  // Eine Liste, die nur aus Bibliotheken besteht, ergibt NICHTS — kein Raten.
  assert.deepEqual(programmAusDateien(windows.slice(0, 4), { plattform: 'win32' }), []);
  // Zwei Kandidaten: der bekannte Name vor dem unbekannten, flach vor tief.
  assert.deepEqual(
    programmAusDateien(['kern/linux-x64/werkzeug/helfer', 'kern/linux-x64/llama-server', 'kern/linux-x64/ollama'], { plattform: 'linux' }),
    ['kern/linux-x64/llama-server', 'kern/linux-x64/ollama', 'kern/linux-x64/werkzeug/helfer'],
  );
});

test('WINDOWS: ein Programm ohne seine DLLs stirbt stumm mit 0xC0000135 — der Satz übersetzt das', () => {
  const { ratZumTod, todesSatz, bibliothekFehltVermutlich } = __internals;
  const stick = { quelle: 'stick', programm: 'E:\\models\\kern\\win-x64\\ollama.exe', dateienFehlend: [], dateienGesamt: 40 };
  const rechner = { quelle: 'konfiguration', programm: 'C:\\Users\\User\\Downloads\\ollama-windows-amd64\\ollama.exe', dateienFehlend: [], dateienGesamt: null };

  // Node meldet den Code als vorzeichenlose 32-Bit-Zahl; manche Umgebungen negativ.
  for (const code of [3221225781, -1073741515]) {
    const rat = ratZumTod({ eintrag: stick, code, ausgabe: [] });
    assert.match(rat, /0xC0000135/);
    assert.match(rat, /DLL/);
    assert.match(rat, /Quellrechner/);
    const satz = todesSatz({ code, signal: null, programm: stick.programm, ausgabe: [], rat });
    assert.match(satz, /mit Code .* beendet/);
    assert.match(satz, /Was zu tun ist: /);
    assert.match(satz, /nichts ausgegeben/, 'ohne Ausgabe wird das gesagt, nicht verschwiegen');
  }
  // Vom eigenen Rechner: der Rat zeigt auf den Ordner neben der .exe.
  const ratRechner = ratZumTod({ eintrag: rechner, code: 3221225781, ausgabe: [] });
  assert.match(ratRechner, /Prüfe, ob neben C:\\Users\\User\\Downloads\\ollama-windows-amd64\\ollama\.exe der Ordner lib\//);
  assert.doesNotMatch(ratRechner, /Quellrechner/);

  // Falsche Architektur.
  assert.match(ratZumTod({ eintrag: stick, code: 0xC000007B, ausgabe: [] }), /0xC000007B/);
  assert.match(ratZumTod({ eintrag: stick, code: -1073741701, ausgabe: [] }), /0xC000007B/);

  // Fehlende Dateien laut Beschreibung schlagen jede Vermutung: Gewissheit zuerst.
  const unvollstaendig = { ...stick, dateienFehlend: ['kern/win-x64/lib/ollama/ggml-base.dll', 'kern/win-x64/lib/ollama/cuda_v13/ggml-cuda.dll'], dateienGesamt: 40 };
  const ratFehlend = ratZumTod({ eintrag: unvollstaendig, code: 1, ausgabe: [] });
  assert.match(ratFehlend, /fehlen 2 von 40 Dateien/);
  assert.match(ratFehlend, /ggml-base\.dll/);
  assert.match(ratFehlend, /Quellrechner noch einmal mit/);

  // Und ohne jeden Anhaltspunkt gibt es KEINEN Rat — ein erfundener wäre eine falsche Fährte.
  assert.equal(ratZumTod({ eintrag: stick, code: 1, ausgabe: ['irgendein Fehler'] }), '');
  assert.doesNotMatch(todesSatz({ code: 1, signal: null, programm: 'x', ausgabe: ['a'], rat: '' }), /Was zu tun ist/);

  // Die Ausgabe-Heuristik: Bibliothek UND Fehlen in derselben Zeile.
  assert.equal(bibliothekFehltVermutlich(['lib/ fehlt: neben E:\\x\\ollama.exe liegt kein Ordner lib/ollama']), true);
  assert.equal(bibliothekFehltVermutlich(['ollama: error while loading shared libraries: libggml-base.so: cannot open shared object file: No such file or directory']), true);
  assert.equal(bibliothekFehltVermutlich(['The code execution cannot proceed because ggml-base.dll was not found.']), true);
  assert.equal(bibliothekFehltVermutlich(['Error: model "llama3.2" not found, try pulling it first']), false, '"not found" allein ist keine Bibliothek');
  assert.equal(bibliothekFehltVermutlich(['time=... level=INFO msg="inference compute" id=cpu library=cpu']), false);
  assert.equal(bibliothekFehltVermutlich([]), false);
});

test('Ein Windows-Stick nennt keine .exe: der Satz sagt es, statt eine Shell zu suchen', async () => {
  const wurzel = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nos-win-')));
  try {
    const kern = ollamaStickSchreiben(wurzel, { plattform: 'win-x64' });
    // Dieselbe Datei, nur ohne .exe — auf Windows wäre das keine Programmdatei.
    const runner = createLocalRunner({ stickRoot: wurzel, plattform: 'win32', arch: 'x64' });
    const gelesen = runner.beschreibungLesen();
    assert.ok(gelesen.fehler, 'ein Kern ohne .exe darf unter Windows nicht gewählt werden');
    assert.match(gelesen.fehler, /keine \.exe-Datei/);
    assert.ok(fs.existsSync(kern.programm), 'die Datei selbst liegt da — es ist die Endung, die fehlt');
  } finally {
    try { fs.rmSync(wurzel, { recursive: true, force: true }); } catch { /* egal */ }
  }
});
