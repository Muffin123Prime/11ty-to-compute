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
    const b = await lz().pruefen(h.paths);
    assert.equal(b.zustand, 'aeltere');
    await assert.rejects(() => lz().anlegen(h.paths, { instanz: 'zweiter0000c' }),
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
