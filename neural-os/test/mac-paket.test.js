'use strict';

/**
 * Paket M (docs/STICK-BAUPLAN.md, 2.13): der Mac startet ohne Terminal-Fenster
 * („Neural OS starten - Mac.app“, das .command bleibt als „Notstart - Mac“ im
 * Inhalt) und wirft den Stick nach [Beenden] selbst aus.
 *
 * Einen Mac gibt es hier nicht. Was sich ohne ihn belegen laesst, wird
 * belegt: Das Skript im Buendel laeuft unter dash (POSIX), mit nachgestellten
 * Mac-Befehlen (sw_vers, uname, xattr, osascript) im PATH; der Helfer fuers
 * Auswerfen laeuft unter echtem sh gegen ein nachgestelltes diskutil.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { test, tempHome } = require('./harness');

const WURZEL = path.join(__dirname, '..');
const VORLAGE_APP = path.join(WURZEL, 'tools', 'launchers', 'start-macos-app.sh');
const SHELL = ['/usr/bin/dash', '/bin/dash', '/bin/sh'].find((s) => fs.existsSync(s));
const BUENDEL = 'Neural OS starten - Mac.app';
const PROGRAMM = path.join(BUENDEL, 'Contents', 'MacOS', 'neural-os-starten');

function ausfuehrbar(datei, inhalt) {
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  fs.writeFileSync(datei, inhalt);
  fs.chmodSync(datei, 0o755);
}

/**
 * Ein Stick, wie das Vorbereiten ihn am Mac hinterlaesst -- nur mit einer
 * nachgestellten App: Sie schreibt ihren Aufruf in eine Datei und scheitert
 * auf Wunsch mit einem Satz. Die „Laufzeit“ ist die Node dieses Tests.
 */
function macStick(label, { aufbau = 'inhalt', unter = null } = {}) {
  const t = tempHome(`mac-${label}`);
  const wurzel = unter ? path.join(t.home, unter) : t.home;
  const inhalt = aufbau === 'inhalt' ? path.join(wurzel, 'Inhalt') : wurzel;
  ausfuehrbar(path.join(wurzel, PROGRAMM), fs.readFileSync(VORLAGE_APP, 'utf8'));
  fs.mkdirSync(path.join(inhalt, 'app', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(inhalt, 'app', 'bin', 'neural-os.js'), [
    "const fs = require('node:fs');",
    'fs.writeFileSync(process.env.AUFRUF, process.argv.slice(2).join(" "));',
    'console.log("Neural OS startet …");',
    'if (process.env.FEHLER) { console.error(process.env.FEHLER); process.exit(1); }',
    'console.log("Fertig.");',
    '',
  ].join('\n'));
  ausfuehrbar(path.join(inhalt, 'runtime', 'darwin-x64', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  const stubs = path.join(t.home, '.stubs');
  ausfuehrbar(path.join(stubs, 'sw_vers'), '#!/bin/sh\necho "${MACOS_VERSION:-14.5}"\n');
  ausfuehrbar(path.join(stubs, 'uname'), '#!/bin/sh\necho x86_64\n');
  ausfuehrbar(path.join(stubs, 'xattr'), '#!/bin/sh\nexit 0\n');
  // osascript: der Satz kommt als letztes Argument (on run argv).
  ausfuehrbar(path.join(stubs, 'osascript'), '#!/bin/sh\nfor a in "$@"; do letztes="$a"; done\nprintf "%s\\n" "$letztes" >> "$DIALOG"\nexit 0\n');
  return {
    ...t,
    wurzel,
    inhalt,
    stubs,
    programm: path.join(wurzel, PROGRAMM),
    aufruf: path.join(t.home, 'aufruf.txt'),
    dialog: path.join(t.home, 'dialog.txt'),
  };
}

function starte(s, env = {}) {
  const r = spawnSync(SHELL, [s.programm], {
    cwd: '/',
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PATH: `${s.stubs}:${process.env.PATH}`, AUFRUF: s.aufruf, DIALOG: s.dialog, ...env },
  });
  const dialog = fs.existsSync(s.dialog) ? fs.readFileSync(s.dialog, 'utf8').trim() : null;
  const aufruf = fs.existsSync(s.aufruf) ? fs.readFileSync(s.aufruf, 'utf8') : null;
  return { code: r.status, dialog, aufruf, stderr: r.stderr };
}

/* ------------------------------------------------- das Skript im Buendel */

test('Mac-Programm: POSIX-sh, LF, Dialog statt Fenster, der Satz geht als Argument hinein, kein Warten auf die Eingabetaste', () => {
  const text = fs.readFileSync(VORLAGE_APP, 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\n'), 'Shebang');
  assert.ok(!text.includes('\r'), 'LF');
  assert.ok(fs.statSync(VORLAGE_APP).mode & 0o111, 'die Vorlage ist ausfuehrbar');
  const r = spawnSync(SHELL, ['-n', VORLAGE_APP], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${SHELL} -n: ${r.stderr}`);
  assert.match(text, /start --hintergrund --open/);
  assert.ok(!/\bread -r\b/.test(text), 'ohne Terminal gibt es keine Eingabetaste');
  assert.ok(!/NEURAL_OS_HOME/.test(text));
  // on run argv: der Satz ist Daten, nie AppleScript-Quelltext.
  assert.match(text, /'on run argv'/);
  assert.match(text, /message \(item 1 of argv\)/);
  assert.ok(!/display alert[^\n]*\$1/.test(text), 'der Satz darf nicht in den AppleScript-Text eingesetzt werden');
  for (const satz of [
    'Auf diesem Stick fehlt das Programm für den Mac.',
    'Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer.',
    'macOS hat den Start blockiert: Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen.',
  ]) assert.ok(text.includes(satz), satz);
  assert.ok(text.includes('xattr -dr com.apple.quarantine "$INHALT/runtime/darwin-"*'));
  assert.match(text, /AppTranslocation/);
  assert.match(text, /Notstart - Mac/);
});

test('Mac-Programm: findet den Stick vom Buendel aus, startet ohne Dialog -- und sagt einen Fehler in einem Dialog, Wort fuer Wort', () => {
  const s = macStick('start');
  try {
    const ok = starte(s);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.aufruf, 'start --hintergrund --open');
    assert.equal(ok.dialog, null, 'bei Erfolg kein Dialog');

    fs.rmSync(s.aufruf);
    const satz = 'Der Ordner "Inhalt" ist schreibgeschützt.';
    const fehl = starte(s, { FEHLER: satz });
    assert.equal(fehl.code, 1);
    assert.ok(fehl.dialog && fehl.dialog.includes(satz), `Dialog: ${fehl.dialog}`);
    assert.ok(!fehl.dialog.includes('Neural OS startet'), 'die Fortschrittszeile gehoert nicht in den Dialog');

    // „Neural OS startet gerade; …“ ist ein Grund, keine Fortschrittszeile.
    const gerade = starte(s, { FEHLER: 'Neural OS startet gerade; gleich noch einmal versuchen.' });
    assert.equal(gerade.code, 1);
    assert.match(gerade.dialog, /Neural OS startet gerade; gleich noch einmal versuchen\.$/);
  } finally {
    s.cleanup();
  }
});

test('Mac-Programm: alter Aufbau, fehlendes Programm, zu alter Mac, vom Stick getrennt -- jedes Mal der Satz, nie ein leerer Start', () => {
  const alt = macStick('alt', { aufbau: 'alt' });
  const ohne = macStick('ohne');
  const ur = macStick('ur');
  const versetzt = macStick('versetzt', { unter: path.join('AppTranslocation', 'A1B2', 'd') });
  try {
    const a = starte(alt);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.aufruf, 'start --hintergrund --open', 'der alte Aufbau (app/ in der Wurzel) startet genauso');

    fs.rmSync(path.join(ohne.inhalt, 'app'), { recursive: true, force: true });
    const o = starte(ohne);
    assert.equal(o.code, 1);
    assert.equal(o.dialog, 'Auf diesem Stick fehlt das Programm für den Mac.');

    const u = starte(ur, { MACOS_VERSION: '10.15.7' });
    assert.equal(u.code, 1);
    assert.equal(u.dialog, 'Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer.');
    assert.equal(u.aufruf, null, 'ein zu alter Mac startet nichts');

    const v = starte(versetzt);
    assert.equal(v.code, 1);
    assert.match(v.dialog || '', /Notstart - Mac/);
    assert.equal(v.aufruf, null, 'aus einer versetzten Kopie startet nichts');
  } finally {
    for (const s of [alt, ohne, ur, versetzt]) s.cleanup();
  }
});

/* ------------------------------------------- Vorbereiten und Erneuern */

test('Erneuern baut einen Stick von vor Paket M um: kein .command mehr in der Wurzel, das Programm da, der Notstart im Inhalt', async () => {
  const { createStick } = require('../src/portable/stick');
  const stick = tempHome('mac-erneuern');
  const src = tempHome('mac-erneuern-src');
  try {
    // Ein Quelltext, der genug ist, um einen Stick daraus zu bauen.
    for (const rel of ['bin/neural-os.js', 'src/app.js', 'web/index.html']) {
      fs.mkdirSync(path.join(src.home, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(src.home, rel), '// x\n');
    }
    fs.writeFileSync(path.join(src.home, 'package.json'), JSON.stringify({ name: 'neural-os', version: '0.1.0' }));
    fs.mkdirSync(path.join(src.home, 'tools', 'launchers'), { recursive: true });
    for (const n of fs.readdirSync(path.join(WURZEL, 'tools', 'launchers'))) {
      fs.copyFileSync(path.join(WURZEL, 'tools', 'launchers', n), path.join(src.home, 'tools', 'launchers', n));
    }
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    // So sah ein Stick vor Paket M aus: das .command in der Wurzel, kein Programm.
    fs.rmSync(path.join(stick.home, BUENDEL), { recursive: true, force: true });
    fs.rmSync(path.join(stick.home, 'Inhalt', 'Notstart - Mac.command'), { force: true });
    fs.writeFileSync(path.join(stick.home, 'Neural OS starten - Mac.command'), '#!/bin/sh\necho alt\n');
    const vorher = await tool.verify(stick.home);
    assert.ok(vorher.problems.some((p) => p.code === 'LAUNCHER_MISSING' && /Mac\.app/.test(p.message)), JSON.stringify(vorher.problems));

    await tool.update(stick.home, { sourceRoot: src.home });
    assert.equal(fs.existsSync(path.join(stick.home, 'Neural OS starten - Mac.command')), false, 'der alte Mac-Starter liegt noch in der Wurzel');
    assert.ok(fs.existsSync(path.join(stick.home, PROGRAMM)));
    assert.ok(fs.existsSync(path.join(stick.home, 'Inhalt', 'Notstart - Mac.command')));
    const nachher = await tool.verify(stick.home);
    assert.ok(!nachher.problems.some((p) => p.code === 'LAUNCHER_MISSING'), JSON.stringify(nachher.problems));
    const sichtbar = fs.readdirSync(stick.home).filter((n) => !n.startsWith('.')).sort();
    assert.deepEqual(sichtbar, ['Inhalt', 'LIESMICH.txt', BUENDEL, 'Neural OS starten - Windows.bat']);

    // Fehlt im Buendel das Skript, ist der Starter nicht da -- auch wenn der Ordner steht.
    fs.rmSync(path.join(stick.home, PROGRAMM));
    const kaputt = await tool.verify(stick.home);
    assert.ok(kaputt.problems.some((p) => p.code === 'LAUNCHER_MISSING' && /Mac\.app/.test(p.message)), JSON.stringify(kaputt.problems));
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

/* ------------------------------------------- nach [Beenden] auswerfen */

const PLIST = (felder) => [
  '<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0">', '<dict>',
  ...Object.entries(felder).map(([k, v]) => (typeof v === 'boolean'
    ? `\t<key>${k}</key>\n\t<${v}/>`
    : `\t<key>${k}</key>\n\t<string>${v}</string>`)),
  '</dict>', '</plist>', '',
].join('\n');

test('macAuswerfbar: nur ein auswerfbarer, nicht eingebauter Datenträger unter /Volumes -- sonst null, und ohne Mac wird nichts gefragt', async () => {
  const { macAuswerfbar } = require('../src/portable/stick');
  const fragen = [];
  const antwort = (felder, code = 0) => async (cmd, args) => { fragen.push([cmd, ...args]); return { code, stdout: PLIST(felder), stderr: '' }; };
  const stick = { MountPoint: '/Volumes/LENA &amp; CO', DeviceIdentifier: 'disk4s1', Ejectable: true, Internal: false, Removable: true };

  assert.deepEqual(await macAuswerfbar('/Volumes/LENA & CO', { platform: 'darwin', run: antwort(stick) }), { punkt: '/Volumes/LENA & CO', geraet: 'disk4s1' });
  assert.deepEqual(fragen[0], ['/usr/sbin/diskutil', 'info', '-plist', '/Volumes/LENA & CO']);
  assert.equal(await macAuswerfbar('/Volumes/X', { platform: 'darwin', run: antwort({ ...stick, Ejectable: false }) }), null);
  assert.equal(await macAuswerfbar('/Volumes/X', { platform: 'darwin', run: antwort({ ...stick, Internal: true }) }), null);
  assert.equal(await macAuswerfbar('/', { platform: 'darwin', run: antwort({ ...stick, MountPoint: '/' }) }), null, 'nie das Systemvolume');
  assert.equal(await macAuswerfbar('/Volumes/X', { platform: 'darwin', run: antwort(stick, 1) }), null, 'diskutil scheitert: kein Auswerfen');
  assert.equal(await macAuswerfbar('/Volumes/X', { platform: 'darwin', run: async () => { throw new Error('weg'); } }), null);
  const vorher = fragen.length;
  assert.equal(await macAuswerfbar('E:\\', { platform: 'win32', run: antwort(stick) }), null);
  assert.equal(await macAuswerfbar('/media/x', { platform: 'linux', run: antwort(stick) }), null);
  assert.equal(fragen.length, vorher, 'ohne Mac wird diskutil nie aufgerufen');
});

test('auswerfenNachEnde: /bin/sh des Systems, abgeloest, im Verzeichnis / und ohne Ausgabe -- nichts haelt den Stick', () => {
  const { auswerfenNachEnde, MAC_AUSWERFEN_SKRIPT } = require('../src/portable/stick');
  const aufrufe = [];
  let losgelassen = false;
  const kind = auswerfenNachEnde({ pid: 4242, punkt: '/Volumes/LENA', spawn: (cmd, args, opts) => { aufrufe.push({ cmd, args, opts }); return { unref() { losgelassen = true; } }; } });
  assert.ok(kind);
  assert.equal(aufrufe.length, 1);
  const a = aufrufe[0];
  assert.equal(a.cmd, '/bin/sh');
  assert.deepEqual(a.args, ['-c', MAC_AUSWERFEN_SKRIPT, 'neural-os-auswerfen', '4242', '/Volumes/LENA', '/usr/sbin/diskutil']);
  assert.deepEqual(a.opts, { cwd: '/', detached: true, stdio: 'ignore' });
  assert.ok(losgelassen, 'der Dienst wartet nicht auf den Helfer');
  assert.equal(auswerfenNachEnde({ punkt: '', spawn: () => { throw new Error('darf nicht'); } }), null);
  const r = spawnSync(SHELL, ['-n', '-c', MAC_AUSWERFEN_SKRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('Der Helfer wirft erst aus, wenn der Dienst weg ist -- und versucht es weiter, solange der Stick noch belegt ist', async () => {
  const { MAC_AUSWERFEN_SKRIPT } = require('../src/portable/stick');
  const t = tempHome('mac-helfer');
  try {
    const protokoll = path.join(t.home, 'diskutil.txt');
    const zaehler = path.join(t.home, 'versuche');
    // Die ersten beiden Versuche: „belegt“, der dritte klappt.
    const diskutil = path.join(t.home, 'diskutil');
    ausfuehrbar(diskutil, `#!/bin/sh\nn=$(cat "${zaehler}" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "${zaehler}"\necho "$n $*" >> "${protokoll}"\n[ "$n" -ge 3 ]\n`);
    const dienst = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const helfer = spawn('/bin/sh', ['-c', MAC_AUSWERFEN_SKRIPT, 'neural-os-auswerfen', String(dienst.pid), '/Volumes/LENA', diskutil], { cwd: '/', stdio: 'ignore' });
    const ende = new Promise((r) => helfer.on('exit', (code) => r(code)));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(fs.existsSync(protokoll), false, 'ausgeworfen, waehrend der Dienst noch lief');
    dienst.kill();
    const code = await ende;
    assert.equal(code, 0);
    const zeilen = fs.readFileSync(protokoll, 'utf8').trim().split('\n');
    assert.deepEqual(zeilen, ['1 eject /Volumes/LENA', '2 eject /Volumes/LENA', '3 eject /Volumes/LENA']);
  } finally {
    t.cleanup();
  }
});

/** Ein Stick im alten Aufbau mit laufender KI, wie test/beenden.test.js. */
async function portableApp(label) {
  const { createApp } = require('../src/app');
  const pathsMod = require('../src/kernel/paths');
  const t = tempHome(`mac-beenden-${label}`);
  fs.mkdirSync(path.join(t.home, 'data'), { recursive: true });
  fs.mkdirSync(path.join(t.home, 'app'), { recursive: true });
  fs.writeFileSync(path.join(t.home, 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version: require('../package.json').version }));
  fs.writeFileSync(path.join(t.home, pathsMod.PORTABLE_MARKER), JSON.stringify({ neuralOsPortable: true, dataDir: 'data', appDir: 'app' }));
  const app = await createApp({
    home: path.join(t.home, 'data'), appDir: path.join(t.home, 'app'), port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
    kopplung: { automatisch: false, einhaengepunkte: () => [] },
  });
  return { app, stick: t };
}

function beendenPer(app) {
  const http = require('node:http');
  const port = app.server.server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/system/beenden', method: 'POST',
      headers: { 'x-neural-os': '1', 'content-type': 'application/json', host: `127.0.0.1:${port}` },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('HTTP [Beenden] vom Stick am Mac: danach "auswerfen-auto", und der Helfer startet mit dieser PID und dem Einhaengepunkt; kann der Mac nicht auswerfen, bleibt es beim Satz', async () => {
  const geraete = tempHome('mac-beenden-geraete');
  const vorher = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = geraete.home;
  const offen = [];
  try {
    for (const [fall, antwort, erwartet] of [
      ['auswerfbar', { punkt: '/Volumes/LENA', geraet: 'disk4s1' }, 'auswerfen-auto'],
      ['nicht', null, 'auswerfen'],
    ]) {
      const { app, stick } = await portableApp(fall);
      offen.push({ app, stick });
      const gefragt = [];
      const gestartet = [];
      let fertig = null;
      const zu = new Promise((r) => { fertig = r; });
      app.plattform = 'darwin';
      app.macAuswerfbar = async (wurzel, opts) => { gefragt.push({ wurzel, opts }); return antwort; };
      app.auswerfenNachEnde = (o) => { gestartet.push(o); };
      app.beenden = async () => { await app.close(); fertig(); };
      await app.listen({ port: 0 });
      const r = await beendenPer(app);
      assert.equal(r.status, 202, JSON.stringify(r.json));
      assert.equal(r.json.danach, erwartet, fall);
      await zu;
      assert.deepEqual(gefragt.map((g) => g.wurzel), [path.resolve(stick.home)], 'gefragt wird nach der Wurzel des Sticks');
      assert.equal(gefragt[0].opts.platform, 'darwin');
      if (antwort) assert.deepEqual(gestartet, [{ pid: process.pid, punkt: '/Volumes/LENA' }]);
      else assert.deepEqual(gestartet, [], 'ohne Auswerfen kein Helfer');
    }
    // Nicht am Mac: nichts wird gefragt, danach "abziehen".
    const { app, stick } = await portableApp('linux');
    offen.push({ app, stick });
    let gefragt = 0;
    let fertig = null;
    const zu = new Promise((r) => { fertig = r; });
    app.plattform = 'linux';
    app.macAuswerfbar = async () => { gefragt++; return { punkt: '/Volumes/X' }; };
    app.auswerfenNachEnde = () => { throw new Error('darf nicht'); };
    app.beenden = async () => { await app.close(); fertig(); };
    await app.listen({ port: 0 });
    const r = await beendenPer(app);
    assert.equal(r.json.danach, 'abziehen');
    await zu;
    assert.equal(gefragt, 0);
  } finally {
    for (const { app, stick } of offen) {
      await app.close().catch(() => {});
      stick.cleanup();
    }
    if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorher;
    geraete.cleanup();
  }
});
