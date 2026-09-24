'use strict';

/**
 * Paket S (docs/STICK-BAUPLAN.md, 2.4): Start ohne Fenster.
 *
 * Geprüft wird mit echten Prozessen, so wie der Doppelklick sie erzeugt:
 * `node bin/neural-os.js start --hintergrund --open` ohne TTY, der Dienst
 * abgelöst, der Browser über NEURAL_OS_OEFFNER auf eine Datei umgelenkt.
 * Jeder Test räumt seinen Dienst selbst wieder ab ([Beenden] per HTTP oder
 * SIGKILL im Fehlerfall), damit kein Prozess den Testlauf überlebt.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, tempHome, fakeServer } = require('./harness');
const rechner = require('../src/kernel/rechner');

const WURZEL = path.join(__dirname, '..');
const BIN = path.join(WURZEL, 'bin', 'neural-os.js');

/* ------------------------------------------------------------- Werkzeuge */

/** Einen Node-Prozess ohne TTY laufen lassen: stdin zu, stdout/stderr als Rohr. */
function lauf(args, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const kind = spawn(process.execPath, [BIN, ...args], {
      cwd: os.tmpdir(),
      env: { ...process.env, NEURAL_OS_LOG_LEVEL: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d) => { stdout += d; });
    kind.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      kind.kill('SIGKILL');
      reject(new Error(`Zeitgrenze ${timeoutMs} ms: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    kind.on('error', (err) => { clearTimeout(timer); reject(err); });
    kind.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, pid: kind.pid });
    });
  });
}

function rufe(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const daten = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      agent: false,
      headers: {
        ...(daten ? { 'content-type': 'application/json', 'content-length': daten.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        ...headers,
      },
    }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => {
        const text = Buffer.concat(teile).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* HTML */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Zeitgrenze')));
    if (daten) req.write(daten);
    req.end();
  });
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

function lebt(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function bis(bedingung, { ms = 10000, takt = 50, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  for (;;) {
    const wert = await bedingung();
    if (wert) return wert;
    if (Date.now() > ende) throw new Error(`${was}: nach ${ms} ms nicht erfüllt`);
    await warte(takt);
  }
}

function leseZettel(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.lock'), 'utf8')); } catch { return null; }
}

/** Alle Prozesse, deren Befehlszeile `teil` enthält (nur Linux). */
function prozesseMit(teil) {
  if (process.platform !== 'linux') return [];
  const treffer = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
    if (cmd.includes(teil)) treffer.push(Number(name));
  }
  return treffer;
}

/** Der Dienst eines Tests: am Ende immer weg, notfalls hart. */
async function aufraeumen(home) {
  const z = leseZettel(home);
  for (const pid of new Set([...(z && z.pid && z.pid !== process.pid ? [z.pid] : []), ...prozesseMit(home)])) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* schon weg */ }
  }
}

/** Ein Temp-Heim plus Temp-Profil (gemerkte Geräte) plus Öffner-Datei. */
function umgebung(label) {
  const heim = tempHome(label);
  const profil = tempHome(`${label}-profil`);
  const oeffner = path.join(profil.home, 'geoeffnet.txt');
  return {
    home: heim.home,
    oeffner,
    env: { NEURAL_OS_OEFFNER: oeffner, NEURAL_OS_GERAETE: profil.home, NEURAL_OS_HOME: '', NEURAL_OS_PASSPHRASE: '' },
    geoeffnet() { try { return fs.readFileSync(oeffner, 'utf8').split('\n').filter(Boolean); } catch { return []; } },
    async cleanup() {
      await aufraeumen(heim.home);
      heim.cleanup();
      profil.cleanup();
    },
  };
}

/* ---------------------------------------------------------------- Tests */

test('Laufzettel "bereit" + Attrappe: start --hintergrund --open öffnet nur den Browser, kein zweiter Prozess', async () => {
  const u = umgebung('nos-s-schon');
  const heim = require('../src/kernel/laufzettel').heimKennung(u.home);
  const anfragen = [];
  const srv = await fakeServer((req, res) => {
    anfragen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString(), instanz: 'attrappe0001', heim }));
  });
  try {
    const url = `${srv.url}/`;
    const vorher = {
      v: 2, pid: process.pid, rechner: rechner.kennung(), boot: rechner.bootZeit(), seit: new Date().toISOString(),
      zustand: 'bereit', port: srv.port, url, instanz: 'attrappe0001', heim, version: '0.1.0',
    };
    fs.writeFileSync(path.join(u.home, '.lock'), JSON.stringify(vorher));

    const r = await lauf(['start', '--hintergrund', '--open', '--home', u.home], { env: u.env });
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(u.geoeffnet(), [url], 'der Browser bekommt die Adresse des laufenden Neural OS');
    assert.deepEqual(leseZettel(u.home), vorher, 'der Laufzettel bleibt, wie er war');
    assert.ok(!fs.existsSync(path.join(u.home, 'protokoll', 'dienst.log')), 'kein Dienst hat angefangen');
    assert.deepEqual(prozesseMit(u.home).filter((p) => p !== r.pid), [], 'kein zweiter Prozess');
    assert.ok(anfragen.includes('/api/health'));
    assert.doesNotMatch(r.stdout + r.stderr, /STORAGE_ERROR|Another/);
  } finally {
    await srv.close();
    await u.cleanup();
  }
});

test('start --hintergrund ohne TTY: Ende unter 10 s mit 0, der Dienst lebt abgelöst, [Beenden] räumt alles ab', async () => {
  const u = umgebung('nos-s-dienst');
  try {
    const r = await lauf(['start', '--hintergrund', '--open', '--home', u.home, '--port', '0'], { env: u.env });
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(r.ms < 10000, `der Starter brauchte ${r.ms} ms`);
    assert.match(r.stdout, /Neural OS startet …/);

    const z = leseZettel(u.home);
    assert.ok(z, 'Laufzettel fehlt');
    assert.equal(z.v, 2);
    assert.equal(z.zustand, 'bereit');
    assert.notEqual(z.pid, r.pid, 'der Dienst ist ein eigener Prozess');
    assert.ok(lebt(z.pid), 'der Dienst lebt nach dem Ende des Starters weiter');
    assert.equal(z.url, `http://127.0.0.1:${z.port}/`);
    assert.deepEqual(u.geoeffnet(), [z.url], 'der Browser bekommt die Adresse');

    const g = await rufe(`http://127.0.0.1:${z.port}/api/health`);
    assert.equal(g.status, 200);
    assert.equal(g.json.instanz, z.instanz, '/api/health.instanz ist die des Laufzettels');
    assert.equal(g.json.heim, z.heim);
    assert.equal(g.json.ok, true);

    if (process.platform === 'linux') {
      const cwd = fs.readlinkSync(`/proc/${z.pid}/cwd`);
      assert.ok(!path.resolve(cwd).startsWith(path.resolve(u.home)), `cwd ${cwd} hält den Stick fest`);
      const status = fs.readFileSync(`/proc/${z.pid}/status`, 'utf8');
      const ppid = Number((status.match(/^PPid:\s+(\d+)/m) || [])[1]);
      assert.notEqual(ppid, r.pid, 'der Starter ist nicht mehr der Elternprozess');
      const stat = fs.readFileSync(`/proc/${z.pid}/stat`, 'utf8');
      const sid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
      assert.equal(sid, z.pid, 'eigene Sitzung (setsid): das Schließen des Terminals erreicht ihn nicht');
    }

    const log = fs.readFileSync(path.join(u.home, 'protokoll', 'dienst.log'), 'utf8');
    assert.ok(log.length > 0, 'dienst.log ist leer');
    assert.ok(!log.includes('\u001b'), 'dienst.log enthält Farbcodes');

    // Ein zweiter Doppelklick: nur der Browser.
    const zwei = await lauf(['start', '--hintergrund', '--open', '--home', u.home, '--port', '0'], { env: u.env });
    assert.equal(zwei.code, 0, zwei.stdout + zwei.stderr);
    assert.deepEqual(u.geoeffnet(), [z.url, z.url]);
    assert.equal(leseZettel(u.home).instanz, z.instanz, 'derselbe Dienst');

    // [Beenden]
    const b = await rufe(`http://127.0.0.1:${z.port}/api/system/beenden`, { method: 'POST', body: {} });
    assert.equal(b.status, 202, b.text);
    assert.equal(b.json.ok, true);
    assert.equal(b.json.danach, process.platform === 'darwin' ? 'auswerfen' : 'abziehen');
    await bis(() => !lebt(z.pid), { ms: 5000, was: 'Dienst endet nach [Beenden]' });
    assert.ok(!fs.existsSync(path.join(u.home, '.lock')), 'data/.lock ist weg');
    assert.ok(!fs.existsSync(path.join(u.home, 'vault', '.lock')), 'vault/.lock ist weg');
  } finally {
    await u.cleanup();
  }
});

test('stop: beendet den laufenden Dienst über [Beenden]', async () => {
  const u = umgebung('nos-s-stop');
  try {
    const r = await lauf(['start', '--hintergrund', '--home', u.home, '--port', '0'], { env: u.env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const z = leseZettel(u.home);
    assert.ok(z && lebt(z.pid));
    assert.deepEqual(u.geoeffnet(), [], 'ohne --open kein Browser');

    const s = await lauf(['stop', '--home', u.home], { env: u.env });
    assert.equal(s.code, 0, s.stdout + s.stderr);
    await bis(() => !lebt(z.pid), { ms: 5000, was: 'Dienst endet nach stop' });
    assert.ok(!fs.existsSync(path.join(u.home, '.lock')));

    const nochmal = await lauf(['stop', '--home', u.home], { env: u.env });
    assert.equal(nochmal.code, 0);
    assert.match(nochmal.stdout, /läuft nicht/);
  } finally {
    await u.cleanup();
  }
});

/** Ein Heim mit Notiz und PIN, über die echte Anwendung angelegt. */
async function verschluesseltesHeim(home, pin, geraete) {
  const vorher = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = geraete;
  const { createApp } = require('../src/app');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, sync: { deviceId: 'dev_5a1ad5a1ad5a1ad5a1ad5a1a', deviceName: 'Lena' } }));
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
  try {
    await app.listen({ port: 0 });
    const port = app.server.server.address().port;
    app.store.create('note', { title: 'Hinter der PIN', body: 'Nur mit PIN lesbar.' });
    await app.store.flush();
    const r = await rufe(`http://127.0.0.1:${port}/api/vault/pin`, { method: 'POST', body: { pin } });
    assert.equal(r.status, 200, r.text);
  } finally {
    await app.close();
    if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorher;
  }
}

test('Stick mit PIN: der Starter endet mit 0, der Browser zeigt den Vorraum, nach der PIN läuft die App auf demselben Port', async () => {
  const u = umgebung('nos-s-pin');
  try {
    await verschluesseltesHeim(u.home, '4711', u.env.NEURAL_OS_GERAETE);

    const r = await lauf(['start', '--hintergrund', '--open', '--home', u.home, '--port', '0'], { env: u.env });
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const z = leseZettel(u.home);
    assert.equal(z.zustand, 'gesperrt');
    assert.equal(z.url, `http://127.0.0.1:${z.port}/api/entsperren`);
    assert.deepEqual(u.geoeffnet(), [z.url], 'der Browser öffnet die PIN-Seite, nicht "/"');

    const basis = `http://127.0.0.1:${z.port}`;
    const g = await rufe(`${basis}/api/health`);
    assert.equal(g.json.gesperrt, true);
    assert.equal(g.json.instanz, z.instanz);
    assert.equal((await rufe(`${basis}/api/status`)).json.gesperrt, true);

    // Ein zweiter Doppelklick, solange gesperrt: wieder nur die PIN-Seite.
    const zwei = await lauf(['start', '--hintergrund', '--open', '--home', u.home, '--port', '0'], { env: u.env });
    assert.equal(zwei.code, 0, zwei.stdout + zwei.stderr);
    assert.deepEqual(u.geoeffnet(), [z.url, z.url]);

    const falsch = await rufe(`${basis}/api/vault/unlock`, { method: 'POST', body: { passphrase: '0000' } });
    assert.equal(falsch.status, 401);
    const richtig = await rufe(`${basis}/api/vault/unlock`, { method: 'POST', body: { passphrase: '4711' } });
    assert.equal(richtig.status, 200, richtig.text);
    const cookie = [].concat(richtig.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('nos_s_'));
    assert.ok(cookie, 'Sitzungs-Cookie fehlt');

    await bis(async () => {
      try {
        const s = await rufe(`${basis}/api/status`, { headers: { cookie } });
        return s.status === 200 && s.json && s.json.gesperrt === undefined;
      } catch { return false; }
    }, { ms: 15000, was: 'App übernimmt den Port' });

    const nachher = leseZettel(u.home);
    assert.equal(nachher.zustand, 'bereit');
    assert.equal(nachher.port, z.port, 'derselbe Port');
    assert.equal(nachher.pid, z.pid, 'derselbe Dienst');
    assert.equal(nachher.url, `${basis}/`);
    assert.equal((await rufe(`${basis}/api/health`)).json.instanz, nachher.instanz);

    const notizen = await rufe(`${basis}/api/records?type=note`, { headers: { cookie } });
    assert.equal(notizen.status, 200, notizen.text);
    assert.ok(JSON.stringify(notizen.json).includes('Hinter der PIN'));
    const ohne = await rufe(`${basis}/api/records?type=note`);
    assert.equal(ohne.status, 401, 'ohne das Cookie des Browsers, der entsperrt hat, keine Daten');
    // Ein neu geladener PIN-Tab landet in der Schale, nicht bei einem JSON-404.
    const alterTab = await rufe(`${basis}/api/entsperren`);
    assert.equal(alterTab.status, 303);
    assert.equal(alterTab.headers.location, '/');

    const b = await rufe(`${basis}/api/system/beenden`, { method: 'POST', body: {}, headers: { cookie } });
    assert.equal(b.status, 202, b.text);
    await bis(() => !lebt(z.pid), { ms: 5000, was: 'Dienst endet' });
    assert.ok(!fs.existsSync(path.join(u.home, '.lock')));
    assert.ok(!fs.existsSync(path.join(u.home, 'vault', '.lock')));
  } finally {
    await u.cleanup();
  }
});

test('p1d: SIGHUP an "start" im Vordergrund -> Exit 0, data/.lock und vault/.lock sind weg', async () => {
  if (process.platform === 'win32') return;
  const u = umgebung('nos-s-sighup');
  let kind = null;
  try {
    kind = spawn(process.execPath, [BIN, 'start', '--home', u.home, '--port', '0'], {
      cwd: os.tmpdir(),
      env: { ...process.env, ...u.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ausgabe = '';
    kind.stdout.on('data', (d) => { ausgabe += d; });
    kind.stderr.on('data', (d) => { ausgabe += d; });
    const ende = new Promise((resolve) => kind.on('close', (code, sig) => resolve({ code, sig })));

    await bis(() => { const z = leseZettel(u.home); return z && z.zustand === 'bereit'; }, { ms: 20000, was: 'Vordergrund bereit' });
    assert.ok(fs.existsSync(path.join(u.home, 'vault', '.lock')), 'vault/.lock liegt, solange es läuft');
    assert.doesNotMatch(ausgabe, /\u001b\[/, 'ohne TTY keine Farben');

    kind.kill('SIGHUP');
    const e = await Promise.race([ende, warte(10000).then(() => null)]);
    assert.ok(e, 'Prozess endet nicht nach SIGHUP');
    assert.equal(e.code, 0, `Exit ${e.code} / ${e.sig}\n${ausgabe}`);
    assert.ok(!fs.existsSync(path.join(u.home, '.lock')), 'data/.lock bleibt liegen');
    assert.ok(!fs.existsSync(path.join(u.home, 'vault', '.lock')), 'vault/.lock bleibt liegen');
  } finally {
    if (kind && kind.exitCode === null) kind.kill('SIGKILL');
    await u.cleanup();
  }
});

test('listen({tryPorts:3}): EACCES auf dem ersten Port -> der zweite wird genommen', async () => {
  const { createServer } = require('../src/http/server');
  // Zwei freie Ports hintereinander suchen.
  let basis = 0;
  for (let versuch = 0; versuch < 20 && !basis; versuch++) {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const p = probe.address().port;
    await new Promise((r) => probe.close(r));
    const zweiter = net.createServer();
    const frei = await new Promise((r) => {
      zweiter.once('error', () => r(false));
      zweiter.listen(p + 1, '127.0.0.1', () => r(true));
    });
    if (frei) await new Promise((r) => zweiter.close(r));
    if (frei && p + 1 < 65535) basis = p;
  }
  assert.ok(basis, 'keine zwei freien Ports gefunden');

  const s = await createServer({ config: { server: { host: '127.0.0.1' } } });
  const original = net.Server.prototype.listen;
  let gesperrt = 0;
  net.Server.prototype.listen = function attrappe(port, ...rest) {
    if (this === s.server && port === basis) {
      gesperrt++;
      const err = new Error(`listen EACCES: permission denied 127.0.0.1:${port}`);
      err.code = 'EACCES';
      process.nextTick(() => this.emit('error', err));
      return this;
    }
    return original.call(this, port, ...rest);
  };
  try {
    await s.listen({ port: basis, host: '127.0.0.1', tryPorts: 3 });
    assert.equal(gesperrt, 1);
    assert.equal(s.url, `http://127.0.0.1:${basis + 1}`);
  } finally {
    net.Server.prototype.listen = original;
    await s.close();
  }
});

test('/api/health: {ok, at, instanz, heim}; die Instanz ist je Server fest', async () => {
  const { createServer } = require('../src/http/server');
  const { heimKennung } = require('../src/kernel/laufzettel');
  const u = tempHome('nos-s-health');
  const s = await createServer({ config: { server: { host: '127.0.0.1' } }, paths: { home: u.home } });
  try {
    await s.listen({ port: 0, host: '127.0.0.1' });
    const a = await rufe(`${s.url}/api/health`);
    const b = await rufe(`${s.url}/api/health`);
    assert.equal(a.status, 200);
    assert.equal(a.json.ok, true);
    assert.ok(a.json.at);
    assert.match(a.json.instanz, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(a.json.instanz, b.json.instanz);
    assert.equal(a.json.instanz, s.instanz);
    assert.equal(a.json.heim, heimKennung(u.home));
    const akt = s.aktivitaet();
    assert.equal(akt.streams, 0);
    assert.equal(akt.inFlight, 0);
    assert.ok(Date.now() - akt.letzteAnfrage < 5000, 'letzteAnfrage wird gezählt');
  } finally {
    await s.close();
    u.cleanup();
  }
});

/* ------------------------------------------------------------ Starter */

/** Zeilen innerhalb von Klammerblöcken (if/for ... ( ... )) einer .bat. */
function blockZeilen(text) {
  const zeilen = text.split('\r\n');
  const drin = [];
  let tiefe = 0;
  for (const roh of zeilen) {
    const z = roh.trim();
    if (/^rem\b/i.test(z) || z.startsWith('::')) continue;
    if (tiefe > 0 && !/^\)/.test(z)) drin.push(z);
    tiefe += (z.match(/\($/) ? 1 : 0);
    if (/^\)/.test(z)) tiefe -= 1;
  }
  return drin;
}

function pruefeBat(datei, { knoten }) {
  const roh = fs.readFileSync(datei);
  const text = roh.toString('latin1');
  assert.ok(roh.every((b) => b < 0x80), `${datei}: nur ASCII (cmd.exe liest die Datei in der alten Codepage)`);
  assert.ok(!/[^\r]\n/.test(text) && !text.startsWith('\n'), `${datei}: jede Zeile endet auf CRLF`);
  assert.ok(!/NEURAL_OS_HOME/.test(text), `${datei}: kein NEURAL_OS_HOME, der Marker entscheidet`);
  assert.match(text, /start --hintergrund --open/, `${datei}: Hintergrundstart`);

  // Der Erfolgsweg: vom Aufruf des Starters bis "exit /b 0" steht kein pause.
  const zeilen = text.split('\r\n').map((z) => z.trim());
  const aufruf = zeilen.findIndex((z) => /start --hintergrund --open/.test(z) && !/^rem\b/i.test(z));
  assert.ok(aufruf > 0);
  const ende = zeilen.findIndex((z, i) => i > aufruf && /^exit \/b 0$/i.test(z));
  assert.ok(ende > aufruf, `${datei}: der Erfolgsweg endet auf exit /b 0`);
  const weg = zeilen.slice(aufruf, ende + 1).filter((z) => !/^rem\b/i.test(z));
  assert.ok(!weg.some((z) => /^pause\b/i.test(z)), `${datei}: kein pause im Erfolgsweg`);
  // Auch ein negativer Code (Absturz) ist ein Fehler; "if errorlevel 1" hieße nur ">= 1".
  assert.ok(weg.some((z) => /^if not "%ERRORLEVEL%"=="0" goto :warten$/i.test(z)), `${datei}: Fehler führen zum Halt`);

  // Klammerblöcke: kein echo darin (eine ")" im Text oder im Pfad schlösse
  // den Block), und keine %VAR%-Pfade außer in "set "X=...""-Zuweisungen.
  for (const z of blockZeilen(text)) {
    assert.ok(!/^echo\b/i.test(z), `${datei}: echo in einem Klammerblock: ${z}`);
    if (/%[A-Z_]+%/.test(z)) assert.match(z, /^(set "|if (not )?exist ")/i, `${datei}: %VAR% ungeschützt im Block: ${z}`);
  }
  // Pausen und Fehlertexte: die Sätze aus Teil 1.8, so weit sie hier stehen.
  for (const satz of knoten) assert.ok(text.includes(satz), `${datei}: "${satz}" fehlt`);
  return text;
}

test('Starter Windows (Stick und Projektordner): ASCII, CRLF, kein NEURAL_OS_HOME, Erfolg endet auf exit /b 0 ohne pause', () => {
  const stick = pruefeBat(path.join(WURZEL, 'tools', 'launchers', 'start-windows.bat'), {
    knoten: ['Dieser Rechner laesst keine Programme vom Stick starten.', 'Auf diesem Stick fehlt das Programm fuer Windows.'],
  });
  assert.match(stick, /Inhalt\\runtime\\/, 'neuer Aufbau zuerst');
  assert.match(stick, /"%HIER%runtime\\/, 'alter Aufbau danach');
  assert.ok(stick.indexOf('Inhalt\\app\\bin\\neural-os.js') < stick.indexOf('"%HIER%app\\bin\\neural-os.js"'));
  assert.match(stick, /chcp 65001/, 'Konsole auf UTF-8, damit Node die Umlaute zeigt');
  assert.match(stick, /-e ""/, 'Probe, ob Programme vom Stick starten dürfen');

  const heim = pruefeBat(path.join(WURZEL, 'Neural OS starten.bat'), {
    knoten: ['Dieser Rechner laesst keine Programme vom Stick starten.'],
  });
  assert.match(heim, /%USERPROFILE%\\Downloads/, 'die bewährte Suche nach node.exe bleibt');
  assert.match(heim, /"%HIER%\.\."/, 'auch eine Ebene höher');
});

test('Starter Mac und Linux: sh, LF, kein NEURAL_OS_HOME, macOS-11-Probe, Quarantäne, Erfolg ohne Halt', () => {
  for (const name of ['start-macos.command', 'start-linux.sh']) {
    const datei = path.join(WURZEL, 'tools', 'launchers', name);
    const text = fs.readFileSync(datei, 'utf8');
    assert.ok(text.startsWith('#!/bin/sh\n'), `${name}: Shebang`);
    assert.ok(!text.includes('\r'), `${name}: LF`);
    assert.ok(!/NEURAL_OS_HOME/.test(text), `${name}: kein NEURAL_OS_HOME`);
    assert.match(text, /start --hintergrund --open/);
    assert.ok(!/Festplatte kopieren|auf den Schreibtisch/.test(text), `${name}: kein Rat zum Kopieren auf die Festplatte`);
    const zeilen = text.split('\n');
    const aufruf = zeilen.findIndex((z) => /start --hintergrund --open/.test(z) && !z.trim().startsWith('#'));
    const rest = zeilen.slice(aufruf).filter((z) => !z.trim().startsWith('#')).join('\n');
    assert.match(rest, /exit 0\s*$/, `${name}: Erfolg endet auf exit 0`);
    assert.match(text, /\$INHALT\/app\/bin\/neural-os\.js/);
  }
  const mac = fs.readFileSync(path.join(WURZEL, 'tools', 'launchers', 'start-macos.command'), 'utf8');
  assert.match(mac, /sw_vers -productVersion/);
  assert.ok(mac.includes('Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer.'));
  assert.ok(mac.includes('xattr -dr com.apple.quarantine "$INHALT/runtime/darwin-"*'));
  assert.ok(mac.includes('macOS hat den Start blockiert: Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen.'));
  assert.ok(mac.includes('Auf diesem Stick fehlt das Programm für den Mac.'));
  assert.ok(!/xattr[^\n]*"\$0"/.test(mac), 'das wirkungslose xattr auf "$0" entfällt');
});
