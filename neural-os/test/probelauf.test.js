'use strict';

/**
 * Paket P (docs/STICK-BAUPLAN.md, Abschnitt 2.2 und Teil 3): der Probelauf.
 *
 * Die ersten drei Tests sind die im Bauplan genannten (`--trocken`,
 * `--start`, `--auf-stick`). Die übrigen sichern ab, was der Nutzer ohne
 * vorbereiteten Stick braucht: die beiden Starter im Projektordner, die
 * Suche nach einem eingesteckten Stick, wenn der Ort selbst keiner ist, und
 * dass das kopierte Ergebnis kurz bleibt und nichts Persönliches enthält.
 *
 * Kein Test fasst einen echten Stick an: Jeder Lauf bekommt `--suche-in` mit
 * einem Temp-Ordner, dessen Unterordner als "eingesteckte Sticks" gelten.
 * Sonst schriebe der Test auf dem Entwicklerrechner auf einen USB-Stick, der
 * zufällig unter /media steckt.
 *
 * Das Skript wird bei jedem Test neu angefordert (`pl()`), nicht oben in der
 * Datei: So ist vor dem Paket jeder einzelne Test rot ("Cannot find module"),
 * statt dass die ganze Datei schon beim Laden scheitert.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test, tempHome } = require('./harness');

const WURZEL = path.join(__dirname, '..');
const SKRIPT = path.join(WURZEL, 'tools', 'probelauf.js');
const VORLAGE_BAT = path.join(WURZEL, 'tools', 'launchers', 'probelauf-windows.bat');
const VORLAGE_CMD = path.join(WURZEL, 'tools', 'launchers', 'probelauf-macos.command');
const PROJEKT_BAT = path.join(WURZEL, 'Probelauf - Windows.bat');
const PROJEKT_CMD = path.join(WURZEL, 'Probelauf - Mac.command');

function pl() {
  return require(SKRIPT);
}

/**
 * Was jede Ergebnisdatei tragen muss (Bauplan 2.2, "Immer"). Die Liste steht
 * hier und nicht im Skript, damit der Test nicht gegen sich selbst prüft.
 */
const PFLICHT = [
  'probelauf',
  'zeit',
  'rechner',
  'system.os',
  'system.version',
  'system.arch',
  'system.node',
  'system.bootZeit',
  'start.starterBisBereitMs',
  'start.starterBeendet',
  'start.dienstLebtWeiter',
  'ort.art',
  'ort.wechseldatentraeger',
  'messort.wo',
  'messort.stickGefunden',
  'schreibprobe.ok',
  'schreibprobe.ms',
  'umbenennen.anzahl',
  'umbenennen.ok',
  'umbenennen.fehler',
  'umbenennen.gesamtMs',
  'fsync.dateiMs',
  'fsync.ordner',
  'ports.liste',
];

/** Gibt es den Schlüssel (der Wert darf null sein)? */
function hat(obj, pfad) {
  let cur = obj;
  for (const teil of pfad.split('.')) {
    if (!cur || typeof cur !== 'object' || !(teil in cur)) return false;
    cur = cur[teil];
  }
  return true;
}

/** Einen Node-Prozess ohne TTY laufen lassen: stdin zu, stdout/stderr als Rohr.
 * `programm` ersetzt Node, etwa durch eine Node auf dem Test-Stick oder `sh`. */
function lauf(args, { cwd = os.tmpdir(), env = {}, timeoutMs = 60000, programm = process.execPath } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const kind = spawn(programm, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d) => { stdout += d; });
    kind.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      kind.kill('SIGKILL');
      reject(new Error(`Zeitgrenze ${timeoutMs} ms: ${args.join(' ')}\n${stderr}`));
    }, timeoutMs);
    kind.on('error', (err) => { clearTimeout(timer); reject(err); });
    kind.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, pid: kind.pid });
    });
  });
}

function holen(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Zeitgrenze')));
    if (body !== null) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

function warte(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function lebt(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Alle Dateien unter `root`, relativ und mit "/" getrennt. */
function dateienUnter(root) {
  const out = [];
  (function lauf2(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const voll = path.join(dir, e.name);
      if (e.isDirectory()) lauf2(voll);
      else out.push(path.relative(root, voll).split(path.sep).join('/'));
    }
  })(root);
  return out.sort();
}

/** Ein Stick, der schon Laufzeiten trägt (Voraussetzung für --auf-stick). */
function tempStick({ aufbau = 'inhalt' } = {}) {
  const t = tempHome('probe-stick');
  const basis = aufbau === 'inhalt' ? path.join(t.home, 'Inhalt') : t.home;
  for (const [plat, name] of [['win-x64', 'node.exe'], ['darwin-arm64', 'node'], ['darwin-x64', 'node']]) {
    fs.mkdirSync(path.join(basis, 'runtime', plat), { recursive: true });
    fs.writeFileSync(path.join(basis, 'runtime', plat, name), 'attrappe');
  }
  fs.mkdirSync(path.join(basis, 'app', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(basis, 'app', 'bin', 'neural-os.js'), '// attrappe\n');
  fs.writeFileSync(path.join(basis, 'neural-os.portable'), '{"neuralOsPortable":true}\n');
  fs.writeFileSync(path.join(t.home, 'LIESMICH.txt'), 'bleibt\n');
  return { ...t, root: t.home, basis };
}

// ---------------------------------------------------------------------------
// Die drei Tests aus dem Bauplan
// ---------------------------------------------------------------------------

test('--trocken unter Linux liefert JSON mit allen Pflichtfeldern und hinterlässt nichts', async () => {
  const ort = tempHome('probe-ort');
  const leer = tempHome('probe-keine-sticks');
  try {
    const r = await lauf([SKRIPT, '--trocken', '--ort', ort.home, '--suche-in', leer.home]);
    assert.equal(r.code, 0, r.stderr);
    const e = JSON.parse(r.stdout);
    for (const feld of PFLICHT) assert.ok(hat(e, feld), `Pflichtfeld fehlt: ${feld}`);

    assert.equal(e.system.os, process.platform);
    assert.equal(e.system.node, process.version);
    assert.equal(typeof e.system.bootZeit, 'number');
    assert.match(e.rechner, /^[0-9a-f]{16}$/);
    assert.equal(e.start.modus, 'trocken');

    assert.equal(e.ort.wechseldatentraeger, false);
    assert.equal(e.messort.wo, 'am-ort');
    assert.equal(e.messort.stickGefunden, false);

    assert.equal(e.schreibprobe.ok, true);
    assert.equal(e.umbenennen.anzahl, 300);
    const fehlerSumme = Object.values(e.umbenennen.fehler).reduce((a, b) => a + b, 0);
    assert.equal(e.umbenennen.ok + fehlerSumme, 300);
    assert.equal(typeof e.umbenennen.gesamtMs, 'number');
    assert.equal(typeof e.fsync.dateiMs, 'number');

    assert.equal(e.ports.liste.length, 20);
    for (const [port, code] of e.ports.liste) {
      assert.ok(port >= 20000 && port <= 29999, `Port außerhalb: ${port}`);
      assert.ok(code === null || typeof code === 'string');
    }

    // Trocken heißt: messen und ausgeben, aber nichts liegen lassen.
    assert.deepEqual(fs.readdirSync(ort.home), []);
  } finally {
    ort.cleanup();
    leer.cleanup();
  }
});

test('--start ohne TTY endet schnell mit 0, der Dienst lebt abgelöst weiter und hält den Stick nicht fest', async () => {
  const stick = tempHome('probe-start');
  const leer = tempHome('probe-keine-sticks');
  const oeffner = path.join(leer.home, '..', `probe-oeffner-${process.pid}-${Date.now()}.txt`);
  let dienstPid = null;
  try {
    // Alter Aufbau: probelauf.js liegt direkt in der Stick-Wurzel.
    const kopie = path.join(stick.home, 'probelauf.js');
    fs.copyFileSync(SKRIPT, kopie);

    const r = await lauf([kopie, '--start', '--suche-in', leer.home], {
      cwd: stick.home,
      env: { NEURAL_OS_OEFFNER: oeffner },
      timeoutMs: 15000,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 10000, `--start brauchte ${r.ms} ms`);

    // Der Öffner hat die Adresse bekommen, statt einen Browser zu starten.
    const url = fs.readFileSync(oeffner, 'utf8').trim().split('\n').pop();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const stand = JSON.parse((await holen(`${url}api/stand`)).text);
    dienstPid = stand.pid;
    assert.ok(Number.isInteger(dienstPid) && dienstPid !== r.pid);
    assert.ok(lebt(dienstPid), 'Der Dienst lebt nicht mehr');

    // PPID ist nicht mehr der Starter (der ist ja beendet und der Dienst
    // wurde umgehängt), und das Arbeitsverzeichnis liegt nicht auf dem Stick.
    // Beides steht nur unter Linux in /proc; der Bauplan verlangt den Test
    // für Linux, auf einem Mac-Entwicklerrechner entfällt dieser Teil.
    if (fs.existsSync(`/proc/${dienstPid}/stat`)) {
      const stat = fs.readFileSync(`/proc/${dienstPid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      assert.notEqual(ppid, r.pid);
      const cwd = fs.readlinkSync(`/proc/${dienstPid}/cwd`);
      const stickEcht = fs.realpathSync(stick.home);
      assert.ok(!(cwd + path.sep).startsWith(stickEcht + path.sep), `cwd liegt auf dem Stick: ${cwd}`);
    }

    // Die Seite: schlicht, ohne fremde Quellen, mit den zwei Knöpfen.
    const seite = await holen(url);
    assert.equal(seite.status, 200);
    assert.match(seite.headers['content-type'], /text\/html/);
    assert.ok(seite.text.includes('Ergebnis kopieren'));
    assert.ok(seite.text.includes('Fertig'));
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(seite.text), 'Seite lädt etwas von außen');

    // Ändernde Anfragen nur mit dem eigenen Kopf: eine fremde Webseite, die
    // blind an 127.0.0.1 schickt, kann den Probelauf nicht beenden.
    const ohneKopf = await holen(`${url}api/fertig`, { method: 'POST', body: '{}' });
    assert.equal(ohneKopf.status, 403);
    assert.ok(lebt(dienstPid));

    const browser = await holen(`${url}api/browser`, {
      method: 'POST',
      headers: { 'X-Probelauf': '1', 'Content-Type': 'application/json' },
      body: { ua: 'Mozilla/5.0 Chrome/128.0.0.0', localStorage: true, sessionStorage: true, serviceWorker: true, sichererKontext: true },
    });
    assert.equal(browser.status, 200);

    // Warten, bis gemessen ist (Starter weg + 5 s beobachtet, Proben durch).
    let fertig = null;
    for (let i = 0; i < 80 && !fertig; i++) {
      const s = JSON.parse((await holen(`${url}api/stand`)).text);
      if (s.kernFertig) fertig = s;
      else await warte(250);
    }
    assert.ok(fertig, 'Die Messung wurde nicht fertig');
    assert.ok(fertig.text.split('\n').length <= 40);

    const ende = await holen(`${url}api/fertig`, { method: 'POST', headers: { 'X-Probelauf': '1' }, body: '{}' });
    assert.equal(ende.status, 200);
    for (let i = 0; i < 40 && lebt(dienstPid); i++) await warte(125);
    assert.ok(!lebt(dienstPid), 'Der Dienst endet nach [Fertig] nicht');

    // Übrig bleibt genau die Ergebnisdatei, alle Probedateien sind weg.
    const ordner = path.join(stick.home, 'PROBELAUF');
    const rest = fs.readdirSync(ordner);
    assert.equal(rest.length, 1, `übrig: ${rest.join(', ')}`);
    assert.match(rest[0], new RegExp(`^linux-${pl().kennung()}-\\d{4}-\\d{2}-\\d{2}-\\d{4}\\.json$`));
    const e = JSON.parse(fs.readFileSync(path.join(ordner, rest[0]), 'utf8'));
    for (const feld of PFLICHT) assert.ok(hat(e, feld), `Pflichtfeld fehlt in der Datei: ${feld}`);
    assert.equal(e.start.modus, 'dienst');
    assert.equal(e.start.starterBeendet, true);
    assert.equal(e.start.dienstLebtWeiter, true);
    assert.ok(e.start.starterBisBereitMs >= 0 && e.start.starterBisBereitMs < 10000);
    assert.equal(e.browser.name, 'Chrome 128');
    assert.deepEqual(dateienUnter(stick.home), ['PROBELAUF/' + rest[0], 'probelauf.js']);
  } finally {
    if (dienstPid && lebt(dienstPid)) try { process.kill(dienstPid, 'SIGKILL'); } catch { /* weg */ }
    try { fs.unlinkSync(oeffner); } catch { /* nie angelegt */ }
    stick.cleanup();
    leer.cleanup();
  }
});

test('--auf-stick legt genau die fünf Dateien an (neuer Aufbau mit Inhalt/)', async () => {
  const stick = tempStick({ aufbau: 'inhalt' });
  try {
    const vorher = dateienUnter(stick.root);
    const r = await lauf([SKRIPT, '--auf-stick', stick.root]);
    assert.equal(r.code, 0, r.stderr);
    const neu = dateienUnter(stick.root).filter((f) => !vorher.includes(f));
    assert.deepEqual(neu, [
      'Inhalt/Probe.app/Contents/Info.plist',
      'Inhalt/Probe.app/Contents/MacOS/probe',
      'Inhalt/probelauf.js',
      'Probelauf - Mac.command',
      'Probelauf - Windows.bat',
    ]);

    const bat = fs.readFileSync(path.join(stick.root, 'Probelauf - Windows.bat'), 'latin1');
    assert.ok(bat.includes('\r\n'), 'Die .bat hat kein CRLF');
    assert.ok(!/[^\r]\n/.test(bat), 'Die .bat hat eine Zeile nur mit LF');

    const cmd = path.join(stick.root, 'Probelauf - Mac.command');
    assert.ok(fs.statSync(cmd).mode & 0o111, '.command ist nicht ausführbar');
    assert.ok(!fs.readFileSync(cmd, 'latin1').includes('\r'), '.command hat CR');

    const plist = fs.readFileSync(path.join(stick.basis, 'Probe.app', 'Contents', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>probe<\/string>/);
    assert.match(plist, /<key>CFBundlePackageType<\/key>\s*<string>APPL<\/string>/);
    const probe = path.join(stick.basis, 'Probe.app', 'Contents', 'MacOS', 'probe');
    assert.ok(fs.readFileSync(probe, 'utf8').startsWith('#!/bin/sh\n'));
    assert.ok(fs.statSync(probe).mode & 0o111, 'probe ist nicht ausführbar');

    assert.ok(fs.readFileSync(path.join(stick.basis, 'probelauf.js')).equals(fs.readFileSync(SKRIPT)));
  } finally {
    stick.cleanup();
  }
});

// ---------------------------------------------------------------------------
// --auf-stick: alter Aufbau und fehlende Voraussetzung
// ---------------------------------------------------------------------------

test('--auf-stick im alten Aufbau legt probelauf.js und Probe.app in die Wurzel', async () => {
  const stick = tempStick({ aufbau: 'alt' });
  try {
    const vorher = dateienUnter(stick.root);
    const r = await lauf([SKRIPT, '--auf-stick', stick.root]);
    assert.equal(r.code, 0, r.stderr);
    const neu = dateienUnter(stick.root).filter((f) => !vorher.includes(f));
    assert.deepEqual(neu, [
      'Probe.app/Contents/Info.plist',
      'Probe.app/Contents/MacOS/probe',
      'Probelauf - Mac.command',
      'Probelauf - Windows.bat',
      'probelauf.js',
    ]);
    // Kein "Inhalt/" erfinden: Die Stick-Erkennung prüft <Wurzel>/Inhalt.
    assert.ok(!fs.existsSync(path.join(stick.root, 'Inhalt')));
  } finally {
    stick.cleanup();
  }
});

test('--auf-stick ohne Laufzeiten bricht mit einem deutschen Satz ab und legt nichts an', async () => {
  const t = tempHome('probe-leerer-stick');
  try {
    fs.writeFileSync(path.join(t.home, 'neural-os.portable'), '{}');
    const r = await lauf([SKRIPT, '--auf-stick', t.home]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Laufzeit/);
    assert.equal(r.stderr.trim().split('\n').length, 1, 'Mehr als ein Satz');
    assert.deepEqual(fs.readdirSync(t.home), ['neural-os.portable']);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Ohne vorbereiteten Stick: Starter im Projektordner, Stick-Suche
// ---------------------------------------------------------------------------

test('Die Starter im Projektordner sind die Vorlagen, byte-genau (.bat ASCII mit CRLF, .command ausführbar)', () => {
  const bat = fs.readFileSync(PROJEKT_BAT);
  assert.ok(bat.equals(fs.readFileSync(VORLAGE_BAT)), 'Probelauf - Windows.bat weicht von der Vorlage ab');
  const text = bat.toString('latin1');
  assert.ok(!/[^\x00-\x7f]/.test(text), 'Die .bat enthält Nicht-ASCII-Zeichen');
  assert.ok(!/[^\r]\n/.test(text), 'Die .bat hat eine Zeile nur mit LF');
  // Findet Node wie "Neural OS starten.bat" und zusätzlich auf dem Stick.
  for (const stelle of ['%HIER%node.exe', 'node-v*', '%USERPROFILE%\\Downloads', 'where node', 'runtime\\win-x64\\node.exe']) {
    assert.ok(text.includes(stelle), `Die .bat sucht nicht: ${stelle}`);
  }
  assert.ok(text.includes('--start'));
  // Erfolgsweg: Fenster zu, ohne pause (das prüft ja gerade die erste Frage).
  assert.match(text, /--start[^\r\n]*\r\nif not "%ERRORLEVEL%"=="0" goto :fehler\r\nexit \/b 0\r\n/);

  const cmd = fs.readFileSync(PROJEKT_CMD);
  assert.ok(cmd.equals(fs.readFileSync(VORLAGE_CMD)), 'Probelauf - Mac.command weicht von der Vorlage ab');
  const sh = cmd.toString('utf8');
  assert.ok(sh.startsWith('#!/bin/sh\n'));
  assert.ok(!sh.includes('\r'));
  assert.ok(fs.statSync(PROJEKT_CMD).mode & 0o111, 'Probelauf - Mac.command ist nicht ausführbar');
  assert.ok(fs.statSync(VORLAGE_CMD).mode & 0o111, 'probelauf-macos.command ist nicht ausführbar');
});

/**
 * Die .bat Zeile für Zeile, wie cmd.exe sie liest. Ein cmd.exe gibt es hier
 * nicht; die Regeln sind dieselben wie für die Starter aus Paket S
 * (test/start-dienst.test.js) und fassen die Fallen, die sonst erst am
 * fremden Rechner auffielen.
 */
test('Die .bat Zeile für Zeile wie cmd.exe: Sprungziele, Anführungszeichen, Blöcke, rem, jeder Code außer 0 ist ein Fehler', () => {
  const text = fs.readFileSync(VORLAGE_BAT, 'latin1');
  const zeilen = text.split('\r\n').map((z) => z.trim());
  const istRem = (z) => /^rem(\s|$)/i.test(z) || z.startsWith('::');
  const befehle = zeilen.filter((z) => z && !istRem(z));
  const marken = new Set(zeilen.filter((z) => /^:[a-z_]+$/i.test(z)).map((z) => z.slice(1).toLowerCase()));

  // cmd.exe setzt %-Ausdrücke auch in rem-Zeilen ein (ein ungültiges %~
  // bricht ab), und ein ^ am Zeilenende hängt die nächste Zeile an.
  for (const z of zeilen.filter(istRem)) {
    assert.ok(!z.includes('%'), `% in einer rem-Zeile: ${z}`);
    assert.ok(!z.endsWith('^'), `^ am Ende einer rem-Zeile: ${z}`);
  }
  let tiefe = 0;
  for (const z of befehle) {
    for (const m of z.matchAll(/\bgoto\s+:?([a-z_]+)/gi)) {
      assert.ok(marken.has(m[1].toLowerCase()), `goto ohne Marke: ${z}`);
    }
    // Leerzeichen, "(", ")" und "&" im Ordnernamen ("Stick (2)", "Jan & Eva") trennen sonst.
    for (const m of z.matchAll(/%(HIER|NODE|SKRIPT|USERPROFILE)%|%~dp0|%%~[a-z]*[A-Z]\b/gi)) {
      const davor = (z.slice(0, m.index).match(/"/g) || []).length;
      assert.ok(davor % 2 === 1, `Pfad ohne Anführungszeichen: ${z}`);
    }
    if (tiefe > 0 && !/^\)/.test(z)) {
      // Im Klammerblock schlösse eine ")" im Text oder im eingesetzten Pfad den Block.
      assert.ok(!/^echo\b/i.test(z), `echo in einem Klammerblock: ${z}`);
      if (/%[A-Z_]+%/i.test(z)) assert.match(z, /^(set "|if (not )?exist ")/i, `%VAR% ungeschützt im Block: ${z}`);
    }
    if (/^echo\b/i.test(z)) assert.ok(!/[&|<>]/.test(z.replace(/"[^"]*"/g, '')), `Steuerzeichen im echo: ${z}`);
    if (/\($/.test(z)) tiefe++;
    if (/^\)/.test(z)) tiefe--;
    assert.ok(tiefe >= 0, `Klammer zu ohne Klammer auf: ${z}`);
  }
  assert.equal(tiefe, 0, 'Klammerblock nicht geschlossen');

  // Nach jedem Node-Aufruf zählt jeder Code außer 0. Ein Absturz meldet unter
  // Windows einen negativen Code (0xC0000135 = -1073741515), und
  // "if errorlevel 1" heißt ">= 1": Der Probelauf ginge dann still zu.
  const aufrufe = [];
  befehle.forEach((z, i) => { if (/^"%NODE%"/i.test(z)) aufrufe.push(i); });
  assert.equal(aufrufe.length, 2, 'die Probe mit -e "" und der Start');
  for (const i of aufrufe) {
    assert.match(befehle[i + 1], /^if not "%ERRORLEVEL%"=="0" goto :[a-z_]+$/i, `nach ${befehle[i]}`);
  }
  assert.equal(befehle[aufrufe[0] + 1], 'if not "%ERRORLEVEL%"=="0" goto :gesperrt');
  assert.ok(text.includes('Dieser Rechner laesst keine Programme vom Stick starten.'));
});

test('Die .command und das Skript im Probe.app sind POSIX-sh (dash -n); eine gesperrte Laufzeit ergibt den Satz aus 1.3', async () => {
  const shell = ['/usr/bin/dash', '/bin/dash', '/bin/sh'].find((s) => fs.existsSync(s));
  const stick = tempStick();
  try {
    pl().aufStick(stick.root);
    const probe = path.join(stick.basis, 'Probe.app', 'Contents', 'MacOS', 'probe');
    for (const datei of [VORLAGE_CMD, PROJEKT_CMD, probe]) {
      const r = spawnSync(shell, ['-n', datei], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${shell} -n ${datei}: ${r.stderr}`);
    }
    // Eine Laufzeit, die nicht starten darf: der Satz aus 1.3, das Fenster bleibt (Exit 1).
    for (const plat of ['darwin-x64', 'darwin-arm64']) {
      const node = path.join(stick.basis, 'runtime', plat, 'node');
      fs.writeFileSync(node, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(node, 0o755);
    }
    const r = await lauf([path.join(stick.root, 'Probelauf - Mac.command')], { programm: shell, cwd: stick.root, timeoutMs: 20000 });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('macOS hat den Start blockiert: Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen.'), r.stdout);
    assert.ok(!r.stdout.includes('Probelauf startet'), 'nach der gescheiterten Probe startet nichts');
  } finally {
    stick.cleanup();
  }
});

test('Das Ergebnis sagt, ob die Node vom Stick lief; nur dann beantwortet es "Programme vom Stick erlaubt?"', async () => {
  const sticks = tempHome('probe-sticks');
  try {
    const stick = path.join(sticks.home, 'STICK');
    const laufzeit = path.join(stick, 'Inhalt', 'runtime', 'linux-x64');
    fs.mkdirSync(laufzeit, { recursive: true });
    // Die Node dieses Tests als Laufzeit auf dem Stick (fest verlinkt, sonst kopiert).
    const node = path.join(laufzeit, 'node');
    try {
      fs.linkSync(process.execPath, node);
    } catch {
      fs.copyFileSync(process.execPath, node);
      fs.chmodSync(node, 0o755);
    }
    const vomStick = await lauf([SKRIPT, '--trocken', '--ort', stick, '--suche-in', sticks.home], { programm: node });
    assert.equal(vomStick.code, 0, vomStick.stderr);
    const e1 = JSON.parse(vomStick.stdout);
    assert.equal(e1.system.nodeVomStick, true);
    assert.match(pl().ergebnisText(e1).split('\n')[1], /· Node v[\d.]+ vom Stick$/);

    // Ein Starter, dem die Laufzeit fehlt, nimmt ein installiertes Node.
    const fremd = await lauf([SKRIPT, '--trocken', '--ort', stick, '--suche-in', sticks.home]);
    assert.equal(fremd.code, 0, fremd.stderr);
    const e2 = JSON.parse(fremd.stdout);
    assert.equal(e2.system.nodeVomStick, false);
    assert.match(pl().ergebnisText(e2).split('\n')[1], /· Node v[\d.]+ nicht vom Stick$/);
    assert.ok(!JSON.stringify(e1).includes(sticks.home), 'kein Pfad im Ergebnis');
  } finally {
    sticks.cleanup();
  }
});

test('Ort ohne Wechseldatenträger: gemessen wird auf dem eingesteckten Stick, PROBELAUF ist danach weg', async () => {
  const projekt = tempHome('probe-projekt');
  const sticks = tempHome('probe-sticks');
  try {
    const stick = path.join(sticks.home, 'STICK');
    fs.mkdirSync(stick);
    fs.writeFileSync(path.join(stick, 'meine-datei.txt'), 'bleibt');
    const r = await lauf([SKRIPT, '--trocken', '--ort', projekt.home, '--suche-in', sticks.home]);
    assert.equal(r.code, 0, r.stderr);
    const e = JSON.parse(r.stdout);
    assert.equal(e.ort.wechseldatentraeger, false);
    assert.equal(e.messort.wo, 'stick');
    assert.equal(e.messort.stickGefunden, true);
    assert.equal(e.messort.ordnerEntfernt, true);
    assert.equal(e.schreibprobe.ok, true);
    assert.equal(e.umbenennen.anzahl, 300);
    assert.deepEqual(fs.readdirSync(stick), ['meine-datei.txt']);
    assert.deepEqual(fs.readdirSync(projekt.home), []);
    assert.ok(!r.stdout.includes(stick), 'Der Pfad des Sticks steht im Ergebnis');
  } finally {
    projekt.cleanup();
    sticks.cleanup();
  }
});

test('Ein schon vorhandener Ordner PROBELAUF auf dem Stick bleibt samt Inhalt stehen', async () => {
  const projekt = tempHome('probe-projekt');
  const sticks = tempHome('probe-sticks');
  try {
    const alt = path.join(sticks.home, 'STICK', 'PROBELAUF');
    fs.mkdirSync(alt, { recursive: true });
    fs.writeFileSync(path.join(alt, 'windows-0000000000000000-2026-09-01-1000.json'), '{}');
    const r = await lauf([SKRIPT, '--trocken', '--ort', projekt.home, '--suche-in', sticks.home]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).messort.wo, 'stick');
    assert.deepEqual(fs.readdirSync(alt), ['windows-0000000000000000-2026-09-01-1000.json']);
  } finally {
    projekt.cleanup();
    sticks.cleanup();
  }
});

test('Liegt der Ort selbst auf einem Stick, wird dort gemessen und nicht weitergesucht', async () => {
  const sticks = tempHome('probe-sticks');
  try {
    const eigener = path.join(sticks.home, 'EIGENER');
    const anderer = path.join(sticks.home, 'ANDERER');
    fs.mkdirSync(eigener);
    fs.mkdirSync(anderer);
    const r = await lauf([SKRIPT, '--trocken', '--ort', eigener, '--suche-in', sticks.home]);
    assert.equal(r.code, 0, r.stderr);
    const e = JSON.parse(r.stdout);
    assert.equal(e.ort.wechseldatentraeger, true);
    assert.equal(e.ort.art, 'stick');
    assert.equal(e.messort.wo, 'am-ort');
    assert.deepEqual(fs.readdirSync(anderer), []);
    assert.deepEqual(fs.readdirSync(eigener), []);
  } finally {
    sticks.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Das kopierte Ergebnis und die Fragen
// ---------------------------------------------------------------------------

/** Ein Windows-Ergebnis mit allem, was lang werden kann. */
function beispielWindows() {
  const laufwerke = [];
  for (let c = 68; c <= 90; c++) {
    const b = String.fromCharCode(c);
    laufwerke.push({ b, ms: b === 'Z' ? 3000 : 1, code: b === 'E' ? null : b === 'Z' ? null : 'ENOENT', zeitGrenze: b === 'Z' });
  }
  const bereiche = [];
  for (let i = 0; i < 12; i++) bereiche.push([49000 + i * 100, 49099 + i * 100]);
  bereiche.push([24950, 25049]);
  return {
    probelauf: 1,
    zeit: '2026-09-23T12:03:00.000Z',
    rechner: '3fa4c2d19b0e7a61',
    system: { os: 'win32', version: '10.0.22631', arch: 'x64', node: 'v22.22.2', bootZeit: 1790000000, bootZeitAbweichungS: 0, uptimeS: 10800 },
    start: { modus: 'dienst', starterBisBereitMs: 412, starterBeendet: true, starterEndeNachMs: 650, dienstLebtWeiter: true, beobachtetS: 6 },
    ort: { art: 'projektordner', wechseldatentraeger: false, laufwerk: 'C:', dateisystem: 'NTFS' },
    messort: { wo: 'stick', stickGesucht: true, stickGefunden: true, laufwerk: 'E:', dateisystem: 'exFAT', ordnerEntfernt: true, erkennung: 'cim' },
    schreibprobe: { ok: true, ms: 35, fehler: null },
    umbenennen: { anzahl: 300, ok: 297, fehler: { EPERM: 2, EBUSY: 1 }, gesamtMs: 1890 },
    fsync: { dateiMs: 3, dateiMaxMs: 12, ordner: 'EPERM' },
    ports: { liste: Array.from({ length: 20 }, (_, i) => [20000 + i * 500, i === 9 ? 'EACCES' : null]) },
    windows: {
      powershell: { exit: 0, sprache: 'FullLanguage', dateisystem: 'exFAT', ms: 900 },
      laufwerksarten: { quelle: 'cim' },
      netsh: { exit: 0, bereiche },
      verben: { exit: 0, namen: ['Öffnen', 'In neuem Fenster öffnen', 'Formatieren…', 'Auswerfen', 'Kopieren', 'Umbenennen', 'Eigenschaften'] },
      laufwerke,
    },
    browser: { name: 'Edge 128', sichererKontext: true, localStorage: true, sessionStorage: true, serviceWorker: true, zwischenablage: true },
    antworten: { fenster: 'nein', warnung: 'ja' },
    fehler: ['PowerShell: Zeitgrenze'],
  };
}

test('Das kopierte Ergebnis ist kurz und nennt, was die Entscheidungen brauchen', () => {
  const text = pl().ergebnisText(beispielWindows());
  const zeilen = text.split('\n');
  assert.ok(zeilen.length <= 40, `${zeilen.length} Zeilen`);
  assert.ok(zeilen.every((z) => z.length <= 120), 'Eine Zeile ist länger als 120 Zeichen');
  assert.ok(text.includes('3fa4c2d19b0e7a61'));
  assert.match(text, /Umbenennen[^\n]*EPERM 2/);
  assert.match(text, /24950/, 'Der Sperrbereich in 20000–29999 fehlt');
  assert.match(text, /Auswerfen/);
  assert.match(text, /EACCES/);
  assert.match(text, /Z[^\n]*Zeitgrenze|Zeitgrenze[^\n]*Z/);
  assert.match(text, /Schwarzes Fenster[^\n]*nein/i);
  assert.match(text, /Warnung[^\n]*ja/i);
});

test('Ergebnis und Ergebnisdatei enthalten weder Benutzer noch Rechnernamen noch Pfade', async () => {
  const ort = tempHome('probe-privat');
  const leer = tempHome('probe-keine-sticks');
  try {
    const r = await lauf([SKRIPT, '--trocken', '--ort', ort.home, '--suche-in', leer.home]);
    assert.equal(r.code, 0, r.stderr);
    const e = JSON.parse(r.stdout);
    const text = pl().ergebnisText(e);
    const verboten = [ort.home, fs.realpathSync(ort.home), leer.home, os.homedir()];
    let benutzer = '';
    try { benutzer = os.userInfo().username; } catch { /* ohne Eintrag */ }
    // Kurze Namen ("vm", "pi") kämen zufällig in jedem Text vor; die prüft
    // der Test nicht, lange schon.
    if (os.hostname().length >= 4) verboten.push(os.hostname());
    if (benutzer.length >= 4) verboten.push(benutzer);
    for (const wort of verboten) {
      if (!wort || wort === '/') continue;
      assert.ok(!text.includes(wort), `Im Text steht: ${wort}`);
      assert.ok(!r.stdout.includes(wort), `In der Datei steht: ${wort}`);
    }
    assert.ok(text.split('\n').length <= 40);
  } finally {
    ort.cleanup();
    leer.cleanup();
  }
});

test('Höchstens drei Ja/Nein-Fragen, wörtlich aus dem Bauplan', () => {
  const win = pl().fragen('win32');
  assert.deepEqual(win.map((f) => f.text), [
    'Ist ein schwarzes Fenster offen geblieben?',
    'Kam eine Warnung (SmartScreen, Virenschutz)?',
  ]);
  const mac = pl().fragen('darwin');
  assert.ok(mac.length <= 3);
  assert.deepEqual(mac.slice(0, 2).map((f) => f.text), [
    'Ist das Terminal-Fenster noch offen?',
    'Hat macOS nach Zugriff auf einen Wechseldatenträger gefragt?',
  ]);
  // Die dritte kommt erst, wenn "Probe" sich 60 s lang nicht gemeldet hat.
  assert.equal(mac[2].text, 'Kam eine Meldung?');
  assert.equal(mac[2].nachSekunden, 60);
});

test('Die Rechner-Kennung ist dieselbe wie rechner.kennung() aus Paket G', () => {
  const kennung = pl().kennung();
  assert.match(kennung, /^[0-9a-f]{16}$/);
  const g = path.join(WURZEL, 'src', 'kernel', 'rechner.js');
  // Paket G läuft parallel; ohne das Modul bleibt der Vergleich aus.
  if (fs.existsSync(g)) assert.equal(kennung, require(g).kennung());
});

test('Auswertung fremder Ausgaben: netsh-Sperrbereiche und die mount-Zeile vom Mac', () => {
  const netsh = [
    '',
    'Protocol tcp Port Exclusion Ranges',
    '',
    'Start Port    End Port',
    '----------    --------',
    '     24950       25049',
    '     50000       50059     *',
    '',
    '* - Administered port exclusions.',
    '',
  ].join('\r\n');
  assert.deepEqual(pl().netshBereiche(netsh), [[24950, 25049], [50000, 50059]]);

  const mount = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk4s1 on /Volumes/NEURAL OS (exfat, local, nodev, nosuid, noowners, noatime)',
  ].join('\n');
  const zeile = pl().mountZeile(mount, '/Volumes/NEURAL OS/Inhalt');
  assert.equal(zeile.punkt, '/Volumes/NEURAL OS');
  assert.equal(zeile.typ, 'exfat');
  assert.equal(zeile.readOnly, false);
  assert.equal(zeile.noexec, false);
  assert.equal(zeile.noowners, true);
  assert.equal(pl().mountZeile(mount, '/Users/x/Downloads').punkt, '/');
});
