'use strict';

/**
 * Die Tuer zum Modell: HTTP-Routen und Kommandozeile fuer "Modell mitnehmen".
 *
 * Was hier geprueft wird -- und was nicht
 * ---------------------------------------
 * `src/portable/model.js` kann seit seiner Entstehung finden, planen und
 * kopieren; sein eigener Test beweist das. Was hier fehlt, war die Tuer: eine
 * Route, die der Browser erreicht, und ein Unterbefehl fuer die
 * Kommandozeile. Dieser Test geht durch genau diese Tueren -- den laufenden
 * HTTP-Server und `bin/neural-os.js` als Kindprozess -- und misst, dass am
 * Ende dieselben Dateien auf dem Stick liegen, die das Modul allein auch
 * geschrieben haette.
 *
 * Die harte Grenze dieser Umgebung: kein Ollama, kein llama-server, keine
 * Gewichte. Der Statist unten spricht die Ollama-Schnittstelle (/api/tags,
 * /api/chat) und steht an der Stelle, an der sonst Ollama installiert waere;
 * der Modellspeicher ist kuenstlich, aber inhaltsadressiert wie der echte.
 * Beides gehoert in diesen Test und ist nie Teil des Auslieferungswegs.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { test, tempHome } = require('./harness');

const { createStick, LAYOUT } = require('../src/portable/stick');
const { plattformId } = require('../src/portable/model');
const paths = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');

/* ------------------------------------------------------------- Statisten */

/** Spricht /api/tags und /api/chat wie Ollama, erfindet aber nichts: er sagt nur, was er bekam. */
const STATIST_QUELLE = [
  '#!/usr/bin/env node',
  "'use strict';",
  '/* STATIST aus test/stick-model-http.test.js. Niemals ausliefern. */',
  "const fs = require('node:fs');",
  "const http = require('node:http');",
  "const path = require('node:path');",
  'function modelle() {',
  "  const wurzel = path.join(process.env.OLLAMA_MODELS || '', 'manifests');",
  '  const out = [];',
  '  const gehe = (dir, rel) => {',
  '    let eintraege = [];',
  '    try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }',
  '    for (const e of eintraege) {',
  "      const kind = rel ? rel + '/' + e.name : e.name;",
  '      if (e.isDirectory()) { gehe(path.join(dir, e.name), kind); continue; }',
  "      const teile = kind.split('/');",
  "      out.push({ name: teile[teile.length - 2] + ':' + teile[teile.length - 1] });",
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
  '  res.writeHead(404);',
  "  res.end('nein');",
  '});',
  "server.listen(0, '127.0.0.1', () => { process.stdout.write('BEREIT ' + server.address().port + '\\n'); });",
  '',
].join('\n');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Ein kuenstlicher, inhaltsadressierter Ollama-Speicher mit einem Modell "mini:8b". */
function ollamaSpeicherAnlegen(wurzel) {
  const blobs = path.join(wurzel, 'blobs');
  const manifeste = path.join(wurzel, 'manifests', 'registry.ollama.ai', 'library', 'mini');
  fs.mkdirSync(blobs, { recursive: true });
  fs.mkdirSync(manifeste, { recursive: true });
  const blob = (inhalt) => {
    const buf = Buffer.from(inhalt);
    const hex = sha256(buf);
    fs.writeFileSync(path.join(blobs, `sha256-${hex}`), buf);
    return { digest: `sha256:${hex}`, size: buf.length };
  };
  const konfig = blob('{"model_format":"gguf"}'.padEnd(120, ' '));
  const gewichte = blob('GEWICHTE-MINI'.padEnd(3000, 'x'));
  fs.writeFileSync(path.join(manifeste, '8b'), JSON.stringify({
    schemaVersion: 2,
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', ...konfig },
    layers: [{ mediaType: 'application/vnd.ollama.image.model', ...gewichte }],
  }));
  return { wurzel, bytes: konfig.size + gewichte.size };
}

/**
 * Ein Rechner mit Ollama: Statist im PATH, Speicher unter OLLAMA_MODELS.
 *
 * Die Routen bauen das Werkzeug mit process.env -- genau wie im echten
 * Betrieb. Deshalb wird hier die Umgebung DIESES Prozesses umgebogen und
 * hinterher zurueckgestellt; ein eingespeistes env haette die Tuer, um die es
 * geht, umgangen.
 */
function rechnerAufbauen(heim) {
  const bin = path.join(heim, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const kern = path.join(bin, process.platform === 'win32' ? 'ollama.exe' : 'ollama');
  fs.writeFileSync(kern, STATIST_QUELLE);
  fs.chmodSync(kern, 0o755);
  const speicher = ollamaSpeicherAnlegen(path.join(heim, 'ollama-speicher'));
  return { bin, kern, speicher };
}

function mitUmgebung(werte, fn) {
  const vorher = {};
  for (const [k, v] of Object.entries(werte)) {
    vorher[k] = process.env[k];
    process.env[k] = v;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(vorher)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/* ----------------------------------------------------------------- HTTP */

function httpRequest(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* ein Ereignisstrom ist kein JSON */ }
        const events = [];
        let name = null;
        for (const zeile of raw.split(/\r?\n/)) {
          if (zeile.startsWith('event:')) name = zeile.slice(6).trim();
          else if (zeile.startsWith('data:')) {
            let daten = zeile.slice(5).trim();
            try { daten = JSON.parse(daten); } catch { /* Klartext */ }
            events.push({ event: name, data: daten });
            name = null;
          }
        }
        resolve({ status: res.statusCode, text: raw, json, events });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeSource(root) {
  const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  write('package.json', JSON.stringify({ name: 'neural-os', version: '0.1.0' }));
  fs.chmodSync(write('bin/neural-os.js', '#!/usr/bin/env node\nconsole.log("neural-os");\n'), 0o755);
  write('src/app.js', "'use strict';\nmodule.exports = {};\n");
  write('web/index.html', '<!doctype html><title>Neural OS</title>');
  const repoLaunchers = path.join(__dirname, '..', 'tools', 'launchers');
  for (const name of fs.readdirSync(repoLaunchers)) {
    write(path.join('tools', 'launchers', name), fs.readFileSync(path.join(repoLaunchers, name)));
  }
}

async function withServer(fn) {
  const { createServer } = require('../src/http/server');
  const vault = tempHome('stick-modell-home');
  const src = tempHome('stick-modell-src');
  const ziel = tempHome('stick-modell-ziel');
  const heim = tempHome('stick-modell-rechner');
  makeSource(src.home);
  const rechner = rechnerAufbauen(heim.home);

  const appPaths = paths.ensureLayout(paths.layout(path.join(vault.home, 'tresor')));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  const bus = new Bus();
  const { openStore } = require('../src/store/engine');
  const silent = () => ({ error() {}, warn() {}, info() {}, debug() {} });
  const store = await openStore({ paths: appPaths, bus, logger: silent });
  fs.writeFileSync(path.join(appPaths.home, 'config.json'), JSON.stringify(configMod.defaults(), null, 2));
  const stick = createStick({ paths: appPaths, config, logger: silent });

  const server = await createServer({
    version: 'test', config, paths: appPaths, store, bus, stick, logger: silent, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const req = (method, urlPath, body) => httpRequest(base, method, urlPath, body);

  try {
    await mitUmgebung({
      OLLAMA_MODELS: rechner.speicher.wurzel,
      PATH: `${rechner.bin}${path.delimiter}${process.env.PATH || ''}`,
    }, () => fn({ req, stick, ziel: ziel.home, rechner, heim: heim.home }));
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    vault.cleanup();
    src.cleanup();
    ziel.cleanup();
    heim.cleanup();
  }
}

/** sha256 + mtime jeder Datei, damit "unveraendert" beweisbar ist. */
function abdruck(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const gehe = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(d, e.name);
      const kind = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { gehe(abs, kind); continue; }
      const st = fs.statSync(abs, { bigint: true });
      out[kind] = { sha: sha256(fs.readFileSync(abs)), mtime: String(st.mtimeNs) };
    }
  };
  gehe(dir, '');
  return out;
}

/* ------------------------------------------------------------------ Tests */

test('GET /api/stick/models sagt vor jedem Klick, was hier liegt, was auf dem Stick liegt und was das Dateisystem kann', async () => {
  await withServer(async ({ req, ziel, rechner }) => {
    // Ohne Pfad: nur dieser Rechner. Kein Stick, ueber den man etwas sagen koennte.
    const ohne = await req('GET', '/api/stick/models');
    assert.equal(ohne.status, 200, ohne.text);
    assert.equal(ohne.json.stick, null);
    assert.equal(ohne.json.vorschau, null);
    assert.equal(ohne.json.rechner.gefunden, true, 'der Statist im PATH wurde nicht gefunden');
    assert.equal(ohne.json.dieserRechner, plattformId());
    const kern = ohne.json.rechner.kerne.find((k) => k.art === 'ollama');
    assert.ok(kern, 'kein Ollama-Kern im Befund');
    assert.equal(kern.pfad, rechner.kern);
    assert.equal(kern.plattform, plattformId(), 'ein Kern ist plattformgebunden und muss das sagen');
    const modell = ohne.json.rechner.modelle.find((m) => m.name === 'mini:8b');
    assert.ok(modell, 'das Modell aus dem Manifest fehlt');
    assert.equal(modell.bytes, rechner.speicher.bytes, 'die Groesse ist die Summe der Blobs DIESES Modells');

    // Mit Pfad: der Stick und der Plan -- und nichts wird angelegt.
    const vorher = fs.readdirSync(ziel);
    const mit = await req('GET', `/api/stick/models?path=${encodeURIComponent(ziel)}`);
    assert.equal(mit.status, 200, mit.text);
    assert.equal(mit.json.stick.vorhanden, false);
    assert.match(mit.json.stick.satz, /kein Modell/);
    assert.equal(mit.json.vorschau.kannLosgehen, true, JSON.stringify(mit.json.vorschau.hindernisse));
    assert.ok(mit.json.vorschau.dateisystem, 'die Vorschau nennt das Dateisystem nicht');
    assert.ok(Number.isFinite(mit.json.vorschau.frei), 'die Vorschau nennt den freien Platz nicht');
    assert.ok(mit.json.vorschau.bytesMitKopfraum > mit.json.vorschau.bytes, 'Platzbedarf ohne Luft');
    assert.equal(mit.json.vorschau.dateien, undefined, 'die Dateiliste gehoert nicht in die Uebersicht');
    assert.ok(mit.json.vorschau.anzahl > 0);
    assert.deepEqual(fs.readdirSync(ziel), vorher, 'GET hat etwas auf den Stick geschrieben');

    // Fuer ein iPad: der unbequeme Satz, nicht ein gruener Haken.
    const ipad = await req('GET', `/api/stick/models?path=${encodeURIComponent(ziel)}&fuer=ipados`);
    assert.equal(ipad.status, 200, ipad.text);
    assert.equal(ipad.json.stick.fuer.kannProgrammeStarten, false);
    assert.equal(ipad.json.stick.passt, false);
  });
});

test('Die Vorschau plant fuer eine Auswahl, ohne ein Byte zu schreiben -- und lehnt Unbekanntes mit Satz ab', async () => {
  await withServer(async ({ req, ziel }) => {
    const befund = (await req('GET', '/api/stick/models')).json.rechner;
    const ids = [...befund.kerne, ...befund.modelle].map((f) => f.id);

    const vorher = abdruck(ziel);
    const plan = await req('POST', '/api/stick/models/preview', { path: ziel, auswahl: ids });
    assert.equal(plan.status, 200, plan.text);
    assert.equal(plan.json.kannLosgehen, true, JSON.stringify(plan.json.hindernisse));
    assert.equal(plan.json.auswahl.length, ids.length);
    assert.match(plan.json.zusammenfassung, /mini:8b/);
    assert.deepEqual(abdruck(ziel), vorher, 'die Vorschau hat geschrieben');
    assert.equal(fs.existsSync(path.join(ziel, LAYOUT.models)), false);

    const falsch = await req('POST', '/api/stick/models/preview', { path: ziel, auswahl: ['kern:gibt-es-nicht'] });
    assert.equal(falsch.status, 200, falsch.text);
    assert.equal(falsch.json.kannLosgehen, false);
    const stopp = falsch.json.hindernisse.find((h) => h.code === 'UNBEKANNTE_AUSWAHL');
    assert.ok(stopp && stopp.schwere === 'stopp' && /nicht \(mehr\) zu finden/.test(stopp.satz));

    // Ohne Pfad: ein ganzer Satz, kein "path required".
    const ohne = await req('POST', '/api/stick/models/preview', {});
    assert.equal(ohne.status, 400, ohne.text);
    assert.match(ohne.json.error.message, /path/);
  });
});

test('Kopieren ueber HTTP: Hindernis vor dem ersten Byte, sonst ein Strom mit gemessenem Fortschritt', async () => {
  await withServer(async ({ req, ziel, rechner }) => {
    // Nichts ausgewaehlt: ein Statuscode, kein halber Ereignisstrom.
    const leer = await req('POST', '/api/stick/models/copy', { path: ziel, auswahl: [] });
    assert.equal(leer.status, 400, leer.text);
    assert.ok(!/^event:/m.test(leer.text), 'es wurde doch ein Strom geoeffnet');
    assert.match(leer.json.error.message, /nichts ausgewaehlt/i);
    assert.equal(leer.json.error.code, 'NICHTS_AUSGEWAEHLT');
    assert.equal(fs.existsSync(path.join(ziel, LAYOUT.models)), false, 'ein abgelehnter Vorgang hat geschrieben');

    // Ein Ordner, den es nicht gibt: 404 mit Satz.
    const weg = await req('POST', '/api/stick/models/copy', { path: path.join(ziel, 'gibt-es-nicht') });
    assert.equal(weg.status, 404, weg.text);
    assert.match(weg.json.error.message, /Steckt der Stick noch/);

    // Und jetzt wirklich: alles Gefundene (auswahl weggelassen = alles).
    const lauf = await req('POST', '/api/stick/models/copy', { path: ziel });
    assert.equal(lauf.status, 200, lauf.text);
    const arten = lauf.events.map((e) => e.event);
    assert.ok(arten.includes('start'), 'kein Startereignis');
    assert.ok(arten.includes('fertig'), `kein Abschluss: ${arten.join(',')}`);
    assert.ok(!arten.includes('fehler'), JSON.stringify(lauf.events.find((e) => e.event === 'fehler')));
    const start = lauf.events.find((e) => e.event === 'start').data;
    assert.equal(start.vorschau.kannLosgehen, true);
    assert.equal(start.vorschau.dateien, undefined, 'die Dateiliste gehoert nicht in den Strom');
    const fortschritt = lauf.events.filter((e) => e.event === 'fortschritt');
    assert.ok(fortschritt.length >= 3, `zu wenige Fortschrittsmeldungen: ${fortschritt.length}`);
    const prozente = fortschritt.map((e) => e.data.percent).filter((v) => Number.isFinite(v));
    assert.equal(prozente[prozente.length - 1], 100, `der Balken endet nicht bei 100: ${prozente.join(',')}`);
    const fertig = lauf.events.find((e) => e.event === 'fertig').data;
    assert.ok(fertig.files > 0 && fertig.bytes > 0, 'die Ansicht koennte keine Zahl nennen');
    assert.equal(fertig.files, fertig.kopiert.dateien);
    assert.ok(Array.isArray(fertig.warnings));

    // Auf dem Stick liegt jetzt die Ollama-Ordnung, der Kern ist ausfuehrbar.
    const models = path.join(ziel, LAYOUT.models);
    assert.ok(fs.existsSync(path.join(models, 'ollama', 'manifests', 'registry.ollama.ai', 'library', 'mini', '8b')));
    const kernAufStick = path.join(models, 'kern', plattformId(), path.basename(rechner.kern));
    assert.ok(fs.existsSync(kernAufStick), 'der Kern liegt nicht unter models/kern/<plattform>/');
    if (process.platform !== 'win32') assert.notEqual(fs.statSync(kernAufStick).mode & 0o111, 0, 'Ausfuehrbar-Bit verloren');
    assert.ok(fs.existsSync(path.join(models, LAYOUT.modelsIndex)));

    // Und die Selbstauskunft sagt es jetzt -- fuer diesen Rechner passt es.
    const danach = await req('GET', `/api/stick/models?path=${encodeURIComponent(ziel)}`);
    assert.equal(danach.status, 200, danach.text);
    assert.equal(danach.json.stick.vorhanden, true);
    assert.equal(danach.json.stick.passt, true, danach.json.stick.satz);
    assert.deepEqual(danach.json.stick.plattformen, [plattformId()]);
    assert.ok(danach.json.stick.modelle.some((m) => m.name === 'mini:8b'));
    assert.match(danach.json.stick.satz, /das passt/);

    // Fuer ein anderes Betriebssystem: der Kern startet dort nicht, und das steht da.
    const fremd = plattformId() === 'win-x64' ? 'darwin-arm64' : 'win-x64';
    const anders = await req('GET', `/api/stick/models?path=${encodeURIComponent(ziel)}&fuer=${fremd}`);
    assert.equal(anders.json.stick.passt, false);
    assert.match(anders.json.stick.satz, /startet hier nicht/);
    assert.match(anders.json.stick.satz, new RegExp(fremd));

    // Ein zweiter Lauf schiebt die Blobs nicht noch einmal ueber den Anschluss
    // (sha256 UND Zeitstempel unveraendert); nur die Zeiger -- Manifest und
    // Beschreibung -- werden neu geschrieben, mit demselben Inhalt.
    const blobsVorher = abdruck(path.join(models, 'ollama', 'blobs'));
    const manifestVorher = sha256(fs.readFileSync(path.join(models, 'ollama', 'manifests', 'registry.ollama.ai', 'library', 'mini', '8b')));
    const zweiter = await req('POST', '/api/stick/models/copy', { path: ziel });
    assert.equal(zweiter.status, 200, zweiter.text);
    const fertig2 = zweiter.events.find((e) => e.event === 'fertig').data;
    assert.ok(fertig2.uebersprungen > 0, 'die schon vorhandenen Blobs wurden nicht uebersprungen');
    assert.deepEqual(abdruck(path.join(models, 'ollama', 'blobs')), blobsVorher, 'der zweite Lauf hat die Blobs angefasst');
    assert.equal(sha256(fs.readFileSync(path.join(models, 'ollama', 'manifests', 'registry.ollama.ai', 'library', 'mini', '8b'))), manifestVorher);
  });
});

/* ------------------------------------------------------- Kommandozeile */

function cli(args, env, cwd) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'neural-os.js'), ...args], {
    env: { ...process.env, ...env, NEURAL_OS_LOG_LEVEL: 'error' },
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
}

/** Den Statisten VOM STICK starten und /api/tags fragen -- ohne ihn, wenn er nicht antwortet. */
function vomStickStarten(programm, modellOrdner) {
  return new Promise((resolve, reject) => {
    const kind = spawn(process.execPath, [programm], {
      env: { ...process.env, OLLAMA_MODELS: modellOrdner },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let puffer = '';
    const timer = setTimeout(() => { kind.kill('SIGKILL'); reject(new Error('Statist meldet sich nicht')); }, 10000);
    kind.stdout.on('data', (c) => {
      puffer += c;
      const m = /BEREIT (\d+)/.exec(puffer);
      if (m) { clearTimeout(timer); resolve({ kind, port: Number(m[1]) }); }
    });
    kind.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Statist beendet mit ${code}`)); });
  });
}

test('Die Kommandozeile geht denselben Weg: "stick model list" und "stick model copy"', async () => {
  const heim = tempHome('stick-cli-rechner');
  const ziel = tempHome('stick-cli-ziel');
  const home = tempHome('stick-cli-home');
  try {
    const rechner = rechnerAufbauen(heim.home);
    const env = {
      OLLAMA_MODELS: rechner.speicher.wurzel,
      PATH: `${rechner.bin}${path.delimiter}${process.env.PATH || ''}`,
      NEURAL_OS_HOME: home.home,
      HOME: heim.home,
    };

    const liste = cli(['stick', 'model', 'list', ziel.home], env);
    assert.equal(liste.status, 0, liste.stderr + liste.stdout);
    assert.match(liste.stdout, /mini:8b/, 'das Modell fehlt in der Liste');
    assert.match(liste.stdout, /ollama/, 'der Kern fehlt in der Liste');
    assert.match(liste.stdout, /kein Modell/i, 'der Stick ist leer, und das muss da stehen');
    assert.equal(fs.existsSync(path.join(ziel.home, LAYOUT.models)), false, 'list hat geschrieben');

    const plan = cli(['stick', 'model', 'plan', ziel.home], env);
    assert.equal(plan.status, 0, plan.stderr + plan.stdout);
    assert.match(plan.stdout, /Nichts spricht dagegen|kann losgehen/i);
    assert.equal(fs.existsSync(path.join(ziel.home, LAYOUT.models)), false, 'plan hat geschrieben');

    const kopie = cli(['stick', 'model', 'copy', ziel.home], env);
    assert.equal(kopie.status, 0, kopie.stderr + kopie.stdout);
    assert.match(kopie.stdout, /liegen jetzt auf dem Stick|Datei\(en\)/);
    const programm = path.join(ziel.home, LAYOUT.models, 'kern', plattformId(), path.basename(rechner.kern));
    assert.ok(fs.existsSync(programm), 'der Kern liegt nicht auf dem Stick');
    const modellOrdner = path.join(ziel.home, LAYOUT.models, 'ollama');
    assert.ok(fs.existsSync(path.join(modellOrdner, 'manifests')));

    // Der Beweis bis zum Ende: das Kopierte startet VOM STICK und meldet den Namen aus dem Manifest.
    const { kind, port } = await vomStickStarten(programm, modellOrdner);
    try {
      const antwort = await httpRequest(`http://127.0.0.1:${port}`, 'GET', '/api/tags');
      assert.equal(antwort.status, 200);
      assert.ok(antwort.json.models.some((m) => m.name === 'mini:8b'), JSON.stringify(antwort.json));
    } finally {
      kind.kill('SIGKILL');
    }

    // Danach sagt "list" fuer diesen Rechner: passt.
    const danach = cli(['stick', 'model', 'list', ziel.home], env);
    assert.equal(danach.status, 0, danach.stderr + danach.stdout);
    assert.match(danach.stdout, /das passt/);

    // Fuer ein iPad sagt es den unbequemen Satz.
    const ipad = cli(['stick', 'model', 'list', ziel.home, '--fuer', 'ipados'], env);
    assert.equal(ipad.status, 0, ipad.stderr + ipad.stdout);
    assert.match(ipad.stdout, /kein Programm von einem Stick starten/);

    // Ohne Modell auf dem Rechner: ein Befund mit Anleitung, kein Absturz.
    const leerHeim = tempHome('stick-cli-leer');
    try {
      const nichts = cli(['stick', 'model', 'list'], { ...env, OLLAMA_MODELS: path.join(leerHeim.home, 'nix'), PATH: leerHeim.home, HOME: leerHeim.home });
      assert.equal(nichts.status, 0, nichts.stderr + nichts.stdout);
      assert.match(nichts.stdout, /ollama pull/);
    } finally {
      leerHeim.cleanup();
    }
  } finally {
    heim.cleanup();
    ziel.cleanup();
    home.cleanup();
  }
});
