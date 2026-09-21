'use strict';

/**
 * Der Laufzeitkern vom Stick — end to end, mit einem echten Kindprozess.
 *
 * Was hier gemessen wird und warum in dieser Form
 * ----------------------------------------------
 * In dieser Umgebung gibt es KEIN Sprachmodell und KEINEN echten
 * Laufzeitkern. Gebaut wurde die Maschinerie, nicht das Modell — bewiesen
 * werden muss sie trotzdem. Dafür legt dieser Test einen STATISTEN an: ein
 * kleines Node-Programm, das genau die Schnittstelle spricht, die auch
 * llama-server spricht (`GET /v1/models`, `POST /v1/chat/completions` als
 * SSE — siehe src/models/providers/openai.js). Er wird beim Testlauf in einen
 * Wegwerfordner geschrieben, ist an keiner Stelle Teil des Auslieferungswegs
 * und wird am Ende mit dem Ordner gelöscht.
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
