'use strict';

/**
 * Paket S (docs/STICK-BAUPLAN.md, 2.4 Nr. 1): der Laufzettel `data/.lock`.
 *
 * Eine Sperre, die ein anderer Rechner oder ein früherer Start hinterlassen
 * hat, darf den Start nicht blockieren (p1b); eine, hinter der wirklich ein
 * laufendes Neural OS steht, muss zu diesem führen statt zu einem zweiten.
 *
 * Das Modul wird in jedem Test neu angefordert (`lz()`), damit vor dem Paket
 * jeder Test einzeln rot ist ("Cannot find module").
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, tempHome, fakeServer } = require('./harness');
const rechner = require('../src/kernel/rechner');
const pathsMod = require('../src/kernel/paths');

function lz() {
  return require('../src/kernel/laufzettel');
}

function heimAnlegen(label) {
  const t = tempHome(label);
  const paths = pathsMod.ensureLayout(pathsMod.layout(t.home));
  return { ...t, paths };
}

function schreibe(paths, inhalt) {
  fs.writeFileSync(paths.lock, typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt));
}

/** Ein Zettel, wie ihn ein laufendes Neural OS auf DIESEM Rechner schriebe. */
function zettel(paths, felder = {}) {
  return {
    v: 2,
    pid: process.pid,
    rechner: rechner.kennung(),
    boot: rechner.bootZeit(),
    seit: new Date().toISOString(),
    zustand: 'bereit',
    port: 1,
    url: 'http://127.0.0.1:1/',
    instanz: 'abcdefghijkl',
    heim: lz().heimKennung(paths.home),
    version: '0.1.0',
    ...felder,
  };
}

/** Eine PID, die sicher nicht lebt (größer als jede pid_max). */
const TOTE_PID = 2 ** 22 + 12345;

test('Laufzettel eines anderen Rechners mit PID 1 ist verwaist, und der Start gelingt (p1b)', async () => {
  const h = heimAnlegen('nos-lz-fremd');
  try {
    schreibe(h.paths, { v: 2, rechner: 'ffffffffffffffff', pid: 1, boot: rechner.bootZeit(), zustand: 'bereit', port: 1, instanz: 'x', heim: 'y' });
    const befund = await lz().pruefen(h.paths);
    assert.equal(befund.zustand, 'verwaist');
    assert.match(befund.grund, /Rechner/);

    const eigen = await lz().anlegen(h.paths, { instanz: 'neuinstanz01' });
    const jetzt = JSON.parse(fs.readFileSync(h.paths.lock, 'utf8'));
    assert.equal(jetzt.pid, process.pid);
    assert.equal(jetzt.instanz, 'neuinstanz01');
    assert.equal(jetzt.zustand, 'startet');
    assert.equal(jetzt.rechner, rechner.kennung());
    await eigen.freigeben();
    assert.ok(!fs.existsSync(h.paths.lock), 'freigeben löscht den eigenen Zettel');
  } finally {
    h.cleanup();
  }
});

test('frei, andere Bootzeit, tote PID, unlesbar: jeweils der richtige Befund', async () => {
  const h = heimAnlegen('nos-lz-regeln');
  try {
    assert.equal((await lz().pruefen(h.paths)).zustand, 'frei');

    schreibe(h.paths, zettel(h.paths, { boot: rechner.bootZeit() - 86400 }));
    let b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'verwaist');
    assert.match(b.grund, /Start/);

    schreibe(h.paths, zettel(h.paths, { pid: TOTE_PID }));
    b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'verwaist');
    assert.match(b.grund, /Prozess/);

    schreibe(h.paths, '{"v":2,"pid":');
    const alt = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(h.paths.lock, alt, alt);
    b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'verwaist');
    assert.match(b.grund, /unlesbar/);
  } finally {
    h.cleanup();
  }
});

test('bereit + Gesundheitsabfrage mit gleicher Instanz und gleichem Heim: läuft; sonst verwaist', async () => {
  const h = heimAnlegen('nos-lz-laeuft');
  const heim = lz().heimKennung(h.paths.home);
  let antwort = { ok: true, instanz: 'abcdefghijkl', heim };
  const srv = await fakeServer((req, res) => {
    if (req.url !== '/api/health') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(antwort));
  });
  try {
    schreibe(h.paths, zettel(h.paths, { port: srv.port, url: `${srv.url}/` }));
    let b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'laeuft');
    assert.equal(b.url, `${srv.url}/`);

    // Ein zweiter Start weigert sich, auf Deutsch, und nennt die Adresse.
    await assert.rejects(() => lz().anlegen(h.paths, { instanz: 'zweiter0000a' }), (err) => {
      assert.equal(err.code, 'LAEUFT_SCHON');
      assert.match(err.message, /läuft schon/);
      assert.equal(err.details.url, `${srv.url}/`);
      return true;
    });

    // Anderes Neural OS auf dem Port (andere Instanz): die PID wurde neu vergeben.
    antwort = { ok: true, instanz: 'jemandanders', heim };
    b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'verwaist');

    // Gleiche Instanz, aber ein anderer Datenordner.
    antwort = { ok: true, instanz: 'abcdefghijkl', heim: 'ffffffffffffffff' };
    b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'verwaist');

    // gesperrt (Vorraum) zählt wie bereit.
    antwort = { ok: true, instanz: 'abcdefghijkl', heim, gesperrt: true };
    schreibe(h.paths, zettel(h.paths, { port: srv.port, zustand: 'gesperrt', url: `${srv.url}/api/entsperren` }));
    b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'laeuft');
    assert.equal(b.url, `${srv.url}/api/entsperren`);
  } finally {
    await srv.close();
    h.cleanup();
  }
});

test('startet: jung heißt warten, älter als 120 s heißt verwaist', async () => {
  const h = heimAnlegen('nos-lz-startet');
  try {
    schreibe(h.paths, zettel(h.paths, { zustand: 'startet', port: null, url: null }));
    let b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'startet');
    assert.ok(b.seit);
    await assert.rejects(() => lz().anlegen(h.paths, { instanz: 'zweiter0000b' }), /startet gerade/);

    schreibe(h.paths, zettel(h.paths, { zustand: 'startet', seit: new Date(Date.now() - 200 * 1000).toISOString() }));
    b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'verwaist');
  } finally {
    h.cleanup();
  }
});

test('alte Sperre {pid, at}: tot oder vor dem Start verwaist, sonst "ältere Version"', async () => {
  const h = heimAnlegen('nos-lz-alt');
  try {
    schreibe(h.paths, { pid: TOTE_PID, at: new Date().toISOString() });
    assert.equal((await lz().pruefen(h.paths)).zustand, 'verwaist');

    const vorDemStart = new Date((rechner.bootZeit() - 3600) * 1000).toISOString();
    schreibe(h.paths, { pid: process.pid, at: vorDemStart });
    assert.equal((await lz().pruefen(h.paths)).zustand, 'verwaist');

    schreibe(h.paths, { pid: process.pid, at: new Date().toISOString() });
    // Hinter der PID läuft ein Neural OS, das kurz vor `at` startete.
    const altesNeuralOs = { prozess: async () => ({ start: Date.now() - 2000, befehl: 'node /media/x/STICK/app/bin/neural-os.js start --open', name: null }) };
    const b = await lz().pruefen(h.paths, altesNeuralOs);
    assert.equal(b.zustand, 'aeltere');
    assert.equal(b.sicher, true);
    await assert.rejects(() => lz().anlegen(h.paths, { instanz: 'zweiter0000c' }, altesNeuralOs),
      /Neural OS läuft schon \(ältere Version\)\. Bitte dort beenden\./);
  } finally {
    h.cleanup();
  }
});

test('anlegen über einem verwaisten Zettel löscht vault/.lock nur mit derselben PID', async () => {
  const h = heimAnlegen('nos-lz-vault');
  const vaultLock = path.join(h.paths.vault, '.lock');
  try {
    schreibe(h.paths, zettel(h.paths, { pid: TOTE_PID }));
    fs.writeFileSync(vaultLock, JSON.stringify({ pid: TOTE_PID, at: new Date().toISOString(), scope: 'store' }));
    const a = await lz().anlegen(h.paths, { instanz: 'eigeninst001' });
    assert.ok(!fs.existsSync(vaultLock), 'die Tresor-Sperre der toten Instanz ist weg');
    await a.freigeben();

    schreibe(h.paths, zettel(h.paths, { pid: TOTE_PID }));
    fs.writeFileSync(vaultLock, JSON.stringify({ pid: TOTE_PID + 1, at: new Date().toISOString(), scope: 'store' }));
    const b = await lz().anlegen(h.paths, { instanz: 'eigeninst002' });
    assert.ok(fs.existsSync(vaultLock), 'eine fremde Tresor-Sperre bleibt liegen');
    await b.freigeben();
  } finally {
    h.cleanup();
  }
});

test('aktualisieren schreibt den Zustand, freigeben löscht nur den eigenen Zettel', async () => {
  const h = heimAnlegen('nos-lz-aktuell');
  try {
    const eigen = await lz().anlegen(h.paths, { instanz: 'eigeninst003', version: '9.9.9' });
    eigen.aktualisieren({ zustand: 'bereit', port: 21064, url: 'http://127.0.0.1:21064/' });
    const z = JSON.parse(fs.readFileSync(h.paths.lock, 'utf8'));
    assert.equal(z.v, 2);
    assert.equal(z.zustand, 'bereit');
    assert.equal(z.port, 21064);
    assert.equal(z.url, 'http://127.0.0.1:21064/');
    assert.equal(z.version, '9.9.9');
    assert.equal(z.heim, lz().heimKennung(h.paths.home));
    assert.equal(z.instanz.length, 12);

    // Ein anderer hat übernommen: dessen Zettel bleibt.
    schreibe(h.paths, zettel(h.paths, { instanz: 'fremdinst004' }));
    await eigen.freigeben();
    assert.ok(fs.existsSync(h.paths.lock));
    assert.equal(lz().freigeben(h.paths, 'eigeninst003'), false);
    assert.equal(lz().freigeben(h.paths, 'fremdinst004'), true);
    assert.ok(!fs.existsSync(h.paths.lock));
  } finally {
    h.cleanup();
  }
});

test('acquireLock bleibt als dünner Wrapper und weigert sich auf Deutsch', async () => {
  const h = heimAnlegen('nos-lz-wrapper');
  const { acquireLock } = require('../src/app');
  let release = null;
  try {
    release = await acquireLock(h.paths);
    await assert.rejects(() => acquireLock(h.paths), /Neural OS (läuft schon|startet gerade)/);
    await release();
    assert.ok(!fs.existsSync(h.paths.lock));
    release = null;
  } finally {
    if (release) await release();
    h.cleanup();
  }
});

test('heimKennung: 16 Hex-Zeichen, derselbe Ordner gibt dieselbe Kennung', () => {
  const h = heimAnlegen('nos-lz-heim');
  try {
    const a = lz().heimKennung(h.paths.home);
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(lz().heimKennung(`${h.paths.home}${path.sep}.`), a);
    assert.notEqual(lz().heimKennung(path.join(h.paths.home, 'vault')), a);
    assert.match(lz().neueInstanz(), /^[A-Za-z0-9_-]{12}$/);
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------ Prüfung Runde 1 (S) */

test('Stick kopiert, während er läuft: ein Zettel mit fremdem heim ist verwaist, auch wenn dort jemand antwortet', async () => {
  const h = heimAnlegen('nos-lz-kopie');
  const fremdesHeim = 'aaaaaaaaaaaaaaaa';
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Das ORIGINAL antwortet: dieselbe Instanz, sein eigenes heim.
    res.end(JSON.stringify({ ok: true, instanz: 'abcdefghijkl', heim: fremdesHeim }));
  });
  try {
    assert.notEqual(lz().heimKennung(h.paths.home), fremdesHeim);
    schreibe(h.paths, zettel(h.paths, { port: srv.port, url: `${srv.url}/`, heim: fremdesHeim }));
    const b = await lz().pruefen(h.paths, { pauseMs: 0 });
    assert.equal(b.zustand, 'verwaist', 'die Kopie darf nicht das Original öffnen');
    const eigen = await lz().anlegen(h.paths, { instanz: 'kopieinst001' }, { pauseMs: 0 });
    assert.equal(JSON.parse(fs.readFileSync(h.paths.lock, 'utf8')).instanz, 'kopieinst001');
    eigen.freigeben();
  } finally {
    await srv.close();
    h.cleanup();
  }
});

test('Uhrkorrektur: lebt die PID und antwortet /api/health passend, läuft der Dienst, egal was boot sagt', async () => {
  const h = heimAnlegen('nos-lz-uhr');
  const heim = lz().heimKennung(h.paths.home);
  const vaultLock = path.join(h.paths.vault, '.lock');
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, instanz: 'abcdefghijkl', heim }));
  });
  try {
    schreibe(h.paths, zettel(h.paths, { port: srv.port, url: `${srv.url}/` }));
    fs.writeFileSync(vaultLock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), scope: 'store' }));
    // Die Wanduhr springt um 1 h: bootZeit() = Date.now()/1000 - uptime springt mit.
    const opts = { boot: rechner.bootZeit() + 3600, pauseMs: 0 };
    const b = await lz().pruefen(h.paths, opts);
    assert.equal(b.zustand, 'laeuft', JSON.stringify(b));
    await assert.rejects(() => lz().anlegen(h.paths, { instanz: 'zweiter0000b' }, opts), (err) => err.code === 'LAEUFT_SCHON');
    assert.ok(fs.existsSync(vaultLock), 'die Tresor-Sperre des laufenden Dienstes bleibt');

    // Ohne passende Antwort bleibt es bei "früherer Start".
    const tot = await lz().pruefen(h.paths, { boot: rechner.bootZeit() + 3600, pauseMs: 0, gesundheit: async () => null });
    assert.equal(tot.zustand, 'verwaist');
    assert.match(tot.grund, /Start/);
  } finally {
    await srv.close();
    h.cleanup();
  }
});

test('Zwei Starts sehen denselben verwaisten Zettel: nur einer bekommt ihn, der andere löscht den frischen nicht', async () => {
  const h = heimAnlegen('nos-lz-race');
  try {
    // bereit, PID lebt (wiederverwendet), auf dem Port antwortet nichts Passendes.
    schreibe(h.paths, zettel(h.paths, { port: 1, instanz: 'verwaist0001' }));
    const langsam = { pauseMs: 0, gesundheit: () => new Promise((r) => { setTimeout(() => r(null), 300); }) };
    const a = lz().anlegen(h.paths, { instanz: 'startaaaaaaa' }, langsam);
    await new Promise((r) => { setTimeout(r, 150); });
    const b = lz().anlegen(h.paths, { instanz: 'startbbbbbbb' }, langsam);
    const [ra, rb] = await Promise.allSettled([a, b]);
    const gewonnen = [ra, rb].filter((r) => r.status === 'fulfilled');
    assert.equal(gewonnen.length, 1, `beide bekamen den Laufzettel: ${JSON.stringify([ra.status, rb.status])}`);
    const verloren = [ra, rb].find((r) => r.status === 'rejected');
    assert.match(verloren.reason.code, /STARTET_SCHON|LAEUFT_SCHON/);
    const jetzt = JSON.parse(fs.readFileSync(h.paths.lock, 'utf8'));
    assert.equal(jetzt.instanz, gewonnen[0].value.instanz, 'im Zettel steht der Gewinner');
    gewonnen[0].value.freigeben();
  } finally {
    h.cleanup();
  }
});

test('Derselbe Stick unter einem zweiten Pfad (realpath löst ihn nicht auf): läuft, kein zweiter Dienst, vault/.lock bleibt; eine Kopie bleibt verwaist', async () => {
  const h = heimAnlegen('nos-lz-zweitpfad');
  const heimErsterPfad = 'aaaaaaaaaaaaaaaa';
  const heimZweiterPfad = 'bbbbbbbbbbbbbbbb'; // was heimKennung für den Bind-Mount liefert
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, instanz: 'erstinst0001', heim: heimErsterPfad }));
  });
  const kopie = tempHome('nos-lz-zweitpfad-kopie');
  const vaultLock = path.join(h.paths.vault, '.lock');
  try {
    // Der laufende Dienst, gestartet über den ersten Pfad.
    const erster = await lz().anlegen(h.paths, { instanz: 'erstinst0001', heim: heimErsterPfad, zustand: 'bereit', port: srv.port, url: `${srv.url}/` });
    fs.writeFileSync(vaultLock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), scope: 'store' }));

    // Doppelklick über den zweiten Pfad.
    const b = await lz().pruefen(h.paths, { heim: heimZweiterPfad, pauseMs: 0 });
    assert.equal(b.zustand, 'laeuft', `derselbe Ordner: der Browser geht zum laufenden Dienst (${b.grund || ''})`);
    await assert.rejects(
      lz().anlegen(h.paths, { instanz: 'zweitinst001', heim: heimZweiterPfad }, { heim: heimZweiterPfad, pauseMs: 0 }),
      (err) => err.code === 'LAEUFT_SCHON',
    );
    assert.equal(JSON.parse(fs.readFileSync(h.paths.lock, 'utf8')).instanz, 'erstinst0001', 'der Zettel des laufenden Dienstes bleibt');
    assert.ok(fs.existsSync(vaultLock), 'die Tresor-Sperre des laufenden Dienstes bleibt');

    // Gegenprobe: dieselben Dateien, KOPIERT (anderer Ordner) -> verwaist, die Kopie startet selbst.
    fs.cpSync(h.home, kopie.home, { recursive: true });
    const kPaths = pathsMod.ensureLayout(pathsMod.layout(kopie.home));
    // Der Dienst des Originals ist ein anderer Prozess als dieser Test (sonst ließe das Wegräumen die eigene PID stehen).
    const kz = JSON.parse(fs.readFileSync(kPaths.lock, 'utf8'));
    fs.writeFileSync(kPaths.lock, JSON.stringify({ ...kz, pid: process.ppid }));
    fs.writeFileSync(path.join(kPaths.vault, '.lock'), JSON.stringify({ pid: process.ppid, at: new Date().toISOString(), scope: 'store' }));
    const k = await lz().pruefen(kPaths, { heim: heimZweiterPfad, pauseMs: 0 });
    assert.equal(k.zustand, 'verwaist', 'die Kopie darf nicht das Original öffnen');
    const eigen = await lz().anlegen(kPaths, { instanz: 'kopieinst002' }, { heim: heimZweiterPfad, pauseMs: 0 });
    assert.ok(!fs.existsSync(path.join(kPaths.vault, '.lock')), 'die mitkopierte Tresor-Sperre der Kopie ist weg');
    assert.ok(fs.existsSync(vaultLock), 'die des Originals nicht');
    eigen.freigeben();
    erster.freigeben();
  } finally {
    await srv.close();
    kopie.cleanup();
    h.cleanup();
  }
});

test('alte Sperre {pid, at}: gehört die PID hier einem anderen Programm, ist sie verwaist; sagt das System nichts, bleibt es "ältere Version", aber nie sicher', async () => {
  const h = heimAnlegen('nos-lz-alt-fremd');
  try {
    const at = new Date().toISOString();
    schreibe(h.paths, { pid: process.pid, at });
    const mit = (info) => ({ prozess: async () => info });
    // Ein anderes Programm (Befehlszeile, unter Windows nur der Name aus tasklist).
    assert.equal((await lz().pruefen(h.paths, mit({ start: Date.now() - 5000, befehl: 'C:\\Programme\\Spiel\\spiel.exe -x', name: null }))).zustand, 'verwaist');
    assert.equal((await lz().pruefen(h.paths, mit({ start: null, befehl: null, name: 'chrome.exe' }))).zustand, 'verwaist');
    // Ein Ordner namens neural-os in der Befehlszeile ist noch kein Neural OS.
    assert.equal((await lz().pruefen(h.paths, mit({ start: Date.now() - 5000, befehl: 'node /home/x/neural-os/test/run.js', name: null }))).zustand, 'verwaist');
    // Ein Neural OS, das erst NACH der Sperre startete (oder Stunden davor), hat sie nicht geschrieben.
    assert.equal((await lz().pruefen(h.paths, mit({ start: Date.now() + 5 * 60 * 1000, befehl: 'node bin/neural-os.js start', name: null }))).zustand, 'verwaist');
    assert.equal((await lz().pruefen(h.paths, mit({ start: Date.now() - 5 * 3600 * 1000, befehl: 'node bin/neural-os.js start', name: null }))).zustand, 'verwaist');
    // Windows mit gesperrter PowerShell: nur "node.exe" bekannt -> unklar, nicht sicher.
    const unklar = await lz().pruefen(h.paths, mit({ start: null, befehl: null, name: 'node.exe' }));
    assert.equal(unklar.zustand, 'aeltere');
    assert.equal(unklar.sicher, false);
    const nichts = await lz().pruefen(h.paths, mit(null));
    assert.equal(nichts.zustand, 'aeltere');
    assert.equal(nichts.sicher, false);
    // Das echte Betriebssystem (Linux): der Testlauf selbst ist kein Neural OS.
    if (process.platform === 'linux') {
      const info = await lz().prozessInfo(process.pid);
      assert.ok(info && Math.abs(info.start - (Date.now() - process.uptime() * 1000)) < 5000, JSON.stringify(info));
      assert.equal((await lz().pruefen(h.paths)).zustand, 'verwaist');
    }
  } finally {
    h.cleanup();
  }
});

test('Derselbe Stick unter einem zweiten Pfad, wo Gerät und Dateinummer nichts sagen (Windows: subst, zweiter Laufwerksbuchstabe): läuft, kein zweiter Dienst; eine Kopie bleibt verwaist', async () => {
  const h = heimAnlegen('nos-lz-zweitpfad-win');
  const kopie = tempHome('nos-lz-zweitpfad-win-kopie');
  const heimErsterPfad = 'cccccccccccccccc';
  const heimZweiterPfad = 'dddddddddddddddd';
  // Der laufende Dienst: prüft die Probe-Datei in SEINEM Datenordner (wie /api/health?probe=).
  const srv = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const probe = u.searchParams.get('probe');
    const antwort = { ok: true, instanz: 'erstinst0002', heim: heimErsterPfad };
    if (probe) antwort.probe = fs.existsSync(path.join(h.home, `.heimprobe-${probe}`));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(antwort));
  });
  const vaultLock = path.join(h.paths.vault, '.lock');
  try {
    schreibe(h.paths, zettel(h.paths, { instanz: 'erstinst0002', heim: heimErsterPfad, port: srv.port, url: `${srv.url}/` }));
    fs.writeFileSync(vaultLock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), scope: 'store' }));
    const windows = { heim: heimZweiterPfad, ordner: null, pauseMs: 0 };
    const b = await lz().pruefen(h.paths, windows);
    assert.equal(b.zustand, 'laeuft', `zweiter Pfad: ${b.grund || ''}`);
    await assert.rejects(lz().anlegen(h.paths, { instanz: 'zweitinst002', heim: heimZweiterPfad }, windows), (err) => err.code === 'LAEUFT_SCHON');
    assert.ok(fs.existsSync(vaultLock), 'die Tresor-Sperre des laufenden Dienstes bleibt');
    assert.deepEqual(fs.readdirSync(h.home).filter((n) => n.startsWith('.heimprobe-')), [], 'die Probe-Datei bleibt liegen');

    // Gegenprobe: dieselben Dateien kopiert -> verwaist, die Kopie startet selbst.
    fs.cpSync(h.home, kopie.home, { recursive: true });
    const kPaths = pathsMod.ensureLayout(pathsMod.layout(kopie.home));
    const k = await lz().pruefen(kPaths, windows);
    assert.equal(k.zustand, 'verwaist', 'die Kopie darf nicht das Original öffnen');
  } finally {
    await srv.close();
    kopie.cleanup();
    h.cleanup();
  }
});
