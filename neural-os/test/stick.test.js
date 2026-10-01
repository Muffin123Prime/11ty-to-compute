'use strict';

/**
 * Tests for the USB stick tool.
 *
 * Everything here happens in a temporary directory that stands in for a stick.
 * No test touches the real home directory and no test reaches the network: the
 * one code path that would is exercised twice -- once against a real gate in
 * offline mode (it must refuse with an explanation) and once against a fake
 * gate serving archives this file builds itself (so checksum verification and
 * unpacking are tested without downloading 30 MB).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const { test, drain, tempHome } = require('./harness');

const { createStick, LOCAL_PLATFORM, probeFilesystem, cleanStale, pickFromZip } = require('../src/portable/stick');
const { StorageError } = require('../src/kernel/errors');
const paths = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { createGate } = require('../src/net/gate');

/* ------------------------------------------------------------- fixtures */

/**
 * A minimal source tree that `verify()` accepts as complete, plus every kind
 * of file the exclusion list is supposed to keep off the stick.
 */
function makeSource(root, { withJunk = true } = {}) {
  const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  write('package.json', JSON.stringify({ name: 'neural-os', version: '0.1.0' }));
  const bin = write('bin/neural-os.js', '#!/usr/bin/env node\nconsole.log("neural-os");\n');
  fs.chmodSync(bin, 0o755);
  write('src/app.js', "'use strict';\nmodule.exports = {};\n");
  write('src/kernel/paths.js', "'use strict';\nmodule.exports = {};\n");
  write('web/index.html', '<!doctype html><title>Neural OS</title>');
  write('docs/ANLEITUNG.md', '# Anleitung\n');
  // The launchers must come from the source tree, not from thin air.
  const repoLaunchers = path.join(__dirname, '..', 'tools', 'launchers');
  for (const name of fs.readdirSync(repoLaunchers)) {
    write(path.join('tools', 'launchers', name), fs.readFileSync(path.join(repoLaunchers, name)));
  }

  if (withJunk) {
    write('node_modules/left-pad/index.js', 'module.exports = 1;');
    write('.git/config', '[core]\n');
    write('vault/log/00001.jsonl', '{"secret":true}\n');
    write('data/notes.json', '{"secret":true}');
    write('exports/export.md', '# geheim');
    write('runs/run1.json', '{}');
    write('trash/old.json', '{}');
    write('audit.jsonl', '{"kind":"network.block"}\n');
    write('secrets.json', '{"wrappedKey":"x"}');
    write('debug.log', 'log');
    write('src/.DS_Store', 'junk');
    write('src/nested/deep.log', 'log');
  }
  return root;
}

/** sha256 + mtime of every file under `dir`, so "unchanged" can be proven. */
function snapshotDir(dir) {
  const out = {};
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(abs, childRel); continue; }
      const stat = fs.statSync(abs, { bigint: true });
      out[childRel] = {
        sha: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
        mtimeNs: String(stat.mtimeNs),
        size: String(stat.size),
      };
    }
  };
  walk(dir, '');
  return out;
}

/** A gate stand-in: answers from a table, records exactly how it was called. */
function fakeGate(routes) {
  const calls = [];
  return {
    calls,
    async fetch(url, init = {}) {
      calls.push({ url, init });
      if (!Object.prototype.hasOwnProperty.call(routes, url)) {
        throw new Error(`Der Test kennt diese URL nicht: ${url}`);
      }
      const value = routes[url];
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      return {
        ok: true,
        status: 200,
        url,
        async text() { return buf.toString('utf8'); },
        async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
      };
    },
  };
}

/* ---------------------------------------------------- archive fixtures */

/** One ustar entry with a valid header checksum, plus its padding. */
function tarEntry(name, data) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')} `, 124, 12, 'ascii');
  header.write('00000000000 ', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum is computed over spaces
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

function makeTarGz(entries) {
  const parts = entries.map(({ name, data }) => tarEntry(name, data));
  parts.push(Buffer.alloc(1024)); // end-of-archive
  return zlib.gzipSync(Buffer.concat(parts));
}

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(data) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc >>> 0, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += 30 + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** Die Probleme eines Sticks ohne FEHLT_WINDOWS/FEHLT_MAC und Hinweise -- fuer Sticks, die ohne Netz angelegt wurden. */
function nurFehlt(problems) {
  return (problems || []).filter((p) => !/^FEHLT_/.test(p.code) && p.level !== 'info' && p.level !== 'warn');
}

/* ------------------------------------------------------------ the tests */

test('prepare legt das vollstaendige Stick-Layout an', async () => {
  const stick = tempHome('stick-layout');
  const src = tempHome('stick-src');
  try {
    makeSource(src.home);
    const tool = createStick({});
    const result = await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    assert.equal(result.root, path.resolve(stick.home));
    assert.equal(result.basis, path.join(stick.home, 'Inhalt'));
    assert.equal(result.aufbau, 'inhalt');
    assert.ok(result.files > 0, 'es wurden Dateien kopiert');
    assert.ok(result.bytes > 0);

    // Bauplan 1.1 / 2.10.4: in der Wurzel nur Inhalt, LIESMICH und die zwei
    // Starter; alles andere im Inhalt. Die Spotlight-Sperre ist unsichtbar.
    const sichtbar = fs.readdirSync(stick.home).filter((n) => !n.startsWith('.')).sort();
    assert.deepEqual(sichtbar, ['Inhalt', 'LIESMICH.txt', 'Neural OS starten - Mac.command', 'Neural OS starten - Windows.bat']);
    assert.ok(fs.existsSync(path.join(stick.home, '.metadata_never_index')), '.metadata_never_index fehlt');
    for (const n of fs.readdirSync(stick.home)) assert.ok(!/[()&!%]/.test(n), `Sonderzeichen im Namen: ${n}`);
    for (const rel of [
      'Inhalt/neural-os.portable',
      'Inhalt/app/bin/neural-os.js',
      'Inhalt/app/src/app.js',
      'Inhalt/app/web/index.html',
      'Inhalt/data',
      'Inhalt/data/config.json',
      'Inhalt/sync',
      'Inhalt/Starter fuer Linux.sh',
    ]) {
      assert.ok(fs.existsSync(path.join(stick.home, rel)), `${rel} fehlt auf dem Stick`);
    }
    for (const alt of ['Neural OS starten.bat', 'Neural OS starten.command', 'Neural OS starten.sh']) {
      assert.ok(!fs.existsSync(path.join(stick.home, alt)), `alter Starter ${alt} liegt in der Wurzel`);
    }

    // The batch file needs CRLF, the shell scripts need their shebang.
    const bat = fs.readFileSync(path.join(stick.home, 'Neural OS starten - Windows.bat'), 'utf8');
    assert.ok(bat.includes('\r\n'), 'die .bat muss CRLF-Zeilenenden haben');
    assert.ok(bat.includes('chcp 65001'), 'die .bat muss die Konsole auf UTF-8 stellen');
    for (const name of ['Inhalt/Starter fuer Linux.sh', 'Neural OS starten - Mac.command']) {
      const script = fs.readFileSync(path.join(stick.home, name), 'utf8');
      assert.ok(script.startsWith('#!/bin/sh'), `${name} braucht eine Shebang-Zeile`);
      assert.ok(!script.includes('\r\n'), `${name} darf keine CRLF-Zeilenenden haben`);
      assert.ok((fs.statSync(path.join(stick.home, name)).mode & 0o111) !== 0, `${name} muss ausfuehrbar sein`);
    }
    assert.ok(fs.readFileSync(path.join(stick.home, 'Neural OS starten - Mac.command'), 'utf8').includes('xattr -d com.apple.quarantine'),
      'der macOS-Starter muss das Quarantaene-Merkmal entfernen');

    // Die LIESMICH: genau die fuenf Zeilen aus Bauplan 1.1, sonst nichts.
    const readme = fs.readFileSync(path.join(stick.home, 'LIESMICH.txt'), 'utf8');
    assert.deepEqual(readme.replace(/\r\n$/, '').split('\r\n'), [
      'Windows:  "Neural OS starten - Windows" doppelklicken.',
      'Mac:      "Neural OS starten - Mac" doppelklicken.',
      'Fertig:   in der App auf "Beenden".',
      'Deine Daten liegen im Ordner "Inhalt". Sichern = ganzen Stick kopieren.',
      'Geht etwas nicht, steht der Grund im Fenster, das dann offen bleibt.',
    ]);
    assert.ok(!/Festplatte|Rechtsklick/.test(readme), 'die alten Ratschlaege sind weg');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('der Marker macht den Stick fuer detectPortable() erkennbar', async () => {
  const stick = tempHome('stick-marker');
  const src = tempHome('stick-src2');
  try {
    makeSource(src.home);
    await createStick({}).prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    // This is what the running app does on the foreign PC: it starts in app/
    // and walks up until it finds the marker.
    const detected = paths.detectPortable(path.join(stick.home, 'Inhalt', 'app'));
    assert.ok(detected, 'detectPortable() muss den Stick erkennen');
    assert.equal(detected.dataDir, path.resolve(stick.home, 'Inhalt', 'data'));
    assert.equal(detected.root, path.resolve(stick.home, 'Inhalt'));
    assert.equal(detected.info.neuralOsPortable, true);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('die Laufzeit des laufenden Systems wird ohne Netz kopiert und laeuft', async () => {
  const stick = tempHome('stick-runtime');
  const src = tempHome('stick-src3');
  try {
    makeSource(src.home);
    // No gate at all: if this needed the network it could not possibly work.
    const tool = createStick({ gate: null });
    const result = await tool.prepare(stick.home, { sourceRoot: src.home });

    assert.ok(LOCAL_PLATFORM, 'dieses Testsystem muss eine bekannte Plattform sein');
    assert.deepEqual(result.runtimes.map((r) => r.platform), [LOCAL_PLATFORM]);

    const found = tool.detectPlatforms(stick.home);
    assert.equal(found.length, 1);
    assert.equal(found[0].platform, LOCAL_PLATFORM);
    assert.equal(found[0].isLocal, true);
    assert.equal(found[0].version, process.version);
    assert.ok(found[0].bytes > 1024 * 1024, 'die Laufzeit muss eine echte Binaerdatei sein');
    assert.ok(found[0].executableBit, 'die kopierte Laufzeit braucht das Ausfuehrbar-Bit');

    const run = spawnSync(found[0].file, ['-e', 'process.stdout.write(process.version)'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, `die kopierte Laufzeit liess sich nicht starten: ${run.stderr}`);
    assert.equal(run.stdout.trim(), process.version);

    const check = await tool.verify(stick.home);
    assert.deepEqual(nurFehlt(check.problems), [], `verify meldet Probleme: ${JSON.stringify(check.problems)}`);
    assert.ok(check.freeBytes === null || check.freeBytes > 0);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('update erneuert den Quelltext und laesst data/ voellig unangetastet', async () => {
  const stick = tempHome('stick-update');
  const src = tempHome('stick-src4');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    // Put a realistic data set on the stick: vault log, config, secrets, blobs.
    const dataDir = path.join(stick.home, 'Inhalt', 'data');
    const put = (rel, content) => {
      const file = path.join(dataDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    put('config.json', JSON.stringify({ network: { mode: 'offline' } }));
    put('vault/log/00001.jsonl', '{"seq":1,"op":"create","type":"note"}\n');
    put('vault/snapshot.json', '{"v":1,"records":[]}');
    put('vault/files/aa/aabbcc', 'blob');
    put('secrets.json', '{"wrappedKey":"x"}');
    put('audit.jsonl', '{"kind":"network.allow"}\n');
    const syncDir = path.join(stick.home, 'Inhalt', 'sync');
    fs.writeFileSync(path.join(syncDir, 'postfach.json'), '{"peer":"laptop"}');

    const before = snapshotDir(dataDir);
    const syncBefore = snapshotDir(syncDir);
    assert.ok(Object.keys(before).length >= 6);

    // Change the source so the update has real work to do, and wait long
    // enough that any touch of data/ would show up as a new mtime.
    fs.writeFileSync(path.join(src.home, 'src/app.js'), "'use strict';\nmodule.exports = { neu: true };\n");
    fs.writeFileSync(path.join(src.home, 'src/neu.js'), "'use strict';\n");
    await new Promise((r) => setTimeout(r, 30));

    const result = await tool.update(stick.home, { sourceRoot: src.home });
    assert.ok(result.files > 0);
    assert.equal(result.dataDir, path.resolve(dataDir));

    assert.match(fs.readFileSync(path.join(stick.home, 'Inhalt', 'app/src/app.js'), 'utf8'), /neu: true/);
    assert.ok(fs.existsSync(path.join(stick.home, 'Inhalt', 'app/src/neu.js')), 'neue Quelldateien muessen ankommen');

    assert.deepEqual(snapshotDir(dataDir), before, 'update() hat den Datenordner veraendert');
    assert.deepEqual(snapshotDir(syncDir), syncBefore, 'update() hat den Sync-Ordner veraendert');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('update entfernt Dateien, die es im Quelltext nicht mehr gibt', async () => {
  const stick = tempHome('stick-update2');
  const src = tempHome('stick-src5');
  try {
    makeSource(src.home);
    fs.writeFileSync(path.join(src.home, 'src/alt.js'), "'use strict';\n");
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    assert.ok(fs.existsSync(path.join(stick.home, 'Inhalt', 'app/src/alt.js')));

    fs.unlinkSync(path.join(src.home, 'src/alt.js'));
    await tool.update(stick.home, { sourceRoot: src.home });
    assert.ok(!fs.existsSync(path.join(stick.home, 'Inhalt', 'app/src/alt.js')),
      'app/ wird ersetzt, nicht ueberlagert - sonst bleiben alte Module liegen');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('verify erkennt einen beschaedigten Stick und sagt, was zu tun ist', async () => {
  const stick = tempHome('stick-verify');
  const src = tempHome('stick-src6');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    // Half a copy: one load-bearing file gone.
    fs.unlinkSync(path.join(stick.home, 'Inhalt', 'app/src/kernel/paths.js'));
    const broken = await tool.verify(stick.home);
    assert.equal(broken.ok, false);
    const incomplete = broken.problems.find((p) => p.code === 'APP_INCOMPLETE');
    assert.ok(incomplete, `APP_INCOMPLETE fehlt in ${JSON.stringify(broken.problems)}`);
    assert.match(incomplete.message, /paths\.js/);
    assert.ok(incomplete.fix && incomplete.fix.length > 10, 'jedes Problem braucht einen Loesungshinweis');

    // Marker gone: the app would silently write to ~/.neural-os instead.
    fs.unlinkSync(path.join(stick.home, 'Inhalt', 'neural-os.portable'));
    const noMarker = await tool.verify(stick.home);
    assert.ok(noMarker.problems.some((p) => p.code === 'MARKER_MISSING'));

    // A directory that was never a stick.
    const plain = tempHome('stick-plain');
    try {
      const nothing = await tool.verify(plain.home);
      assert.equal(nothing.ok, false);
      assert.ok(nothing.problems.some((p) => p.code === 'MARKER_MISSING' || p.code === 'APP_MISSING'));
    } finally {
      plain.cleanup();
    }

    const missing = await tool.verify(path.join(stick.home, 'gibt-es-nicht'));
    assert.equal(missing.ok, false);
    assert.equal(missing.problems[0].code, 'NO_STICK');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('ein mittendrin abgezogener Stick wird erkannt und repariert', async () => {
  const stick = tempHome('stick-interrupted');
  const src = tempHome('stick-src7');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    // Exactly the state a yank between the two renames leaves behind:
    // the old app/ parked under its temporary name, no app/ at all.
    fs.renameSync(path.join(stick.home, 'Inhalt', 'app'), path.join(stick.home, 'Inhalt', '.app.old-deadbeef'));
    fs.mkdirSync(path.join(stick.home, 'Inhalt', '.app.tmp-cafebabe'));
    fs.writeFileSync(path.join(stick.home, 'Inhalt', '.app.tmp-cafebabe/halb.js'), 'x');

    const broken = await tool.verify(stick.home);
    assert.equal(broken.ok, false);
    const problem = broken.problems.find((p) => p.code === 'INTERRUPTED_COPY');
    assert.ok(problem, 'ein unterbrochener Kopiervorgang muss gemeldet werden');
    assert.match(problem.fix, /aktualisieren/i);

    // The repair puts the complete previous version back and drops the scrap.
    const repaired = cleanStale(path.join(stick.home, 'Inhalt'));
    assert.deepEqual(repaired.restored, ['app']);
    assert.deepEqual(repaired.removed, ['.app.tmp-cafebabe']);
    assert.ok(fs.existsSync(path.join(stick.home, 'Inhalt', 'app/bin/neural-os.js')));

    const after = await tool.verify(stick.home);
    assert.ok(!after.problems.some((p) => p.code === 'INTERRUPTED_COPY'), 'die Reste sind weg');
    assert.ok(!after.problems.some((p) => p.code === 'APP_MISSING' || p.code === 'APP_INCOMPLETE'),
      `app/ ist wieder vollstaendig: ${JSON.stringify(after.problems)}`);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('zu wenig Platz bricht ab, BEVOR irgendetwas geschrieben wird', async () => {
  const stick = tempHome('stick-full');
  const src = tempHome('stick-src8');
  try {
    makeSource(src.home);
    const tool = createStick({ freeBytes: () => 4096 });
    await assert.rejects(
      () => tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false }),
      (err) => {
        // 507 statt 500: ein voller Stick ist ein Zustand der Welt, kein
        // Defekt dieses Servers -- und die Oberflaeche soll "Platz schaffen"
        // anbieten statt eines Fehlerberichts.
        assert.equal(err.code, 'STICK_FULL');
        assert.equal(err.status, 507);
        assert.match(err.message, /frei/);
        assert.match(err.message, /nichts geschrieben/);
        return true;
      },
    );
    const left = fs.readdirSync(stick.home);
    assert.deepEqual(left, [], `es darf nichts zurueckbleiben, gefunden: ${left.join(', ')}`);

    // With the real free-space function the same call succeeds.
    const ok = createStick({});
    const result = await ok.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    assert.ok(result.files > 0);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('die Ausschlussliste haelt Daten und Ballast vom Stick fern', async () => {
  const stick = tempHome('stick-exclude');
  const src = tempHome('stick-src9');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    const app = path.join(stick.home, 'Inhalt', 'app');
    for (const rel of [
      'node_modules', '.git', 'vault', 'data', 'exports', 'runs', 'trash',
      'audit.jsonl', 'secrets.json', 'debug.log', 'src/.DS_Store', 'src/nested/deep.log',
    ]) {
      assert.ok(!fs.existsSync(path.join(app, rel)), `${rel} haette nicht kopiert werden duerfen`);
    }
    // ... while everything that belongs to the program is there.
    for (const rel of ['bin/neural-os.js', 'src/app.js', 'src/kernel/paths.js', 'web/index.html', 'docs/ANLEITUNG.md']) {
      assert.ok(fs.existsSync(path.join(app, rel)), `${rel} fehlt`);
    }
    // The executable bit of the CLI entry point survives the copy.
    assert.ok((fs.statSync(path.join(app, 'bin/neural-os.js')).mode & 0o111) !== 0);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('[Neue KI]: Marker und config.json tragen dieselbe Kennung, der Port liegt in 20000-29999; ein belegtes data/ heisst KI_VORHANDEN; die Rohkopie gibt es nicht mehr', async () => {
  const stick = tempHome('stick-neue-ki');
  const src = tempHome('stick-src10');
  const home = tempHome('stick-home');
  try {
    makeSource(src.home);
    fs.mkdirSync(path.join(home.home, 'vault/log'), { recursive: true });
    fs.writeFileSync(path.join(home.home, 'vault/log/00001.jsonl'), '{"seq":1}\n');
    const tool = createStick({});

    // Die Rohkopie (Befunde 11 und 13) ist weg: ein alter Aufruf bekommt den Satz, nichts wird geschrieben.
    await assert.rejects(
      () => tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false, includeVault: true, sourceHome: home.home }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.message, 'Gibt es nicht mehr. Stattdessen: Mit dieser KI gekoppelt.');
        return true;
      },
    );
    assert.deepEqual(fs.readdirSync(stick.home), [], 'trotz Absage wurde etwas geschrieben');

    const result = await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false, ki: 'neu' });
    assert.match(result.ki.id, /^dev_[0-9a-f]{24}$/);
    assert.ok(result.ki.port >= 20000 && result.ki.port <= 29999, `Port ${result.ki.port}`);
    assert.ok(result.ki.name && result.ki.name.length > 0);

    const basis = path.join(stick.home, 'Inhalt');
    const marker = JSON.parse(fs.readFileSync(path.join(basis, 'neural-os.portable'), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(basis, 'data', 'config.json'), 'utf8'));
    assert.equal(marker.kiId, result.ki.id);
    assert.equal(marker.name, result.ki.name);
    assert.ok(marker.createdAt, 'createdAt fehlt im Marker');
    assert.equal(config.sync.deviceId, marker.kiId, 'Marker und config.json nennen verschiedene KIs');
    assert.equal(config.sync.deviceName, marker.name);
    assert.equal(config.server.port, result.ki.port);
    assert.equal(config.server.port, require('../src/kernel/identitaet').kiPort(marker.kiId));
    // Nichts von dieser Installation reist mit: kein Tresor, kein Abgleich-Stand, keine Freigaben.
    assert.deepEqual(fs.readdirSync(path.join(basis, 'data')), ['config.json']);

    // Die Kennung ist jedes Mal neu: zwei Sticks sind nie Zwillinge.
    const zweiter = tempHome('stick-neue-ki-2');
    try {
      const r2 = await tool.prepare(zweiter.home, { sourceRoot: src.home, includeRuntimes: false });
      assert.notEqual(r2.ki.id, result.ki.id);
    } finally {
      zweiter.cleanup();
    }

    // [Neue KI] auf einen Stick, auf dem schon eine wohnt: der Satz aus 1.6, und die alte bleibt still erhalten.
    const vorher = snapshotDir(path.join(basis, 'data'));
    await assert.rejects(
      () => tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false, ki: 'neu' }),
      (err) => {
        assert.equal(err.code, 'KI_VORHANDEN');
        assert.equal(err.status, 409);
        assert.equal(err.message, 'Auf diesem Stick wohnt schon eine KI.');
        return true;
      },
    );
    assert.deepEqual(snapshotDir(path.join(basis, 'data')), vorher, 'die vorhandene KI wurde angefasst');
    // Dieselbe Absage in der Vorschau, wortgleich.
    const v = tool.preview(stick.home, { action: 'prepare', sourceRoot: src.home, includeRuntimes: false });
    assert.ok(v.blockers.some((b) => b.code === 'KI_VORHANDEN' && b.message === 'Auf diesem Stick wohnt schon eine KI.'), JSON.stringify(v.blockers));
    assert.equal(v.marker.kiId, result.ki.id);
  } finally {
    stick.cleanup();
    src.cleanup();
    home.cleanup();
  }
});

test('der Name der neuen KI: gewuenscht, sonst vom Datentraeger, sonst "KI XXXX"; ein unbrauchbarer Name wird abgelehnt', async () => {
  const src = tempHome('stick-src-name');
  const medien = tempHome('stick-medien-name');
  try {
    makeSource(src.home);
    const tool = createStick({});
    const a = path.join(medien.home, 'a');
    const r = await tool.prepare(a, { sourceRoot: src.home, includeRuntimes: false, name: '  Lena  ' });
    assert.equal(r.ki.name, 'Lena');
    assert.equal(JSON.parse(fs.readFileSync(path.join(a, 'Inhalt', 'neural-os.portable'), 'utf8')).name, 'Lena');
    const b = path.join(medien.home, 'b');
    const r2 = await tool.prepare(b, { sourceRoot: src.home, includeRuntimes: false });
    assert.match(r2.ki.name, /^KI [0-9A-F]{4}$/);
    await assert.rejects(
      () => tool.prepare(path.join(medien.home, 'c'), { sourceRoot: src.home, includeRuntimes: false, name: 'x'.repeat(61) }),
      (err) => err.code === 'VALIDATION_FAILED',
    );
  } finally {
    src.cleanup();
    medien.cleanup();
  }
});

test('ineinander liegende Ordner werden abgelehnt statt endlos kopiert', async () => {
  const src = tempHome('stick-src11');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await assert.rejects(
      () => tool.prepare(path.join(src.home, 'stick'), { sourceRoot: src.home, includeRuntimes: false }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /endlos|ausserhalb/);
        return true;
      },
    );
  } finally {
    src.cleanup();
  }
});

test('eine Datei als Ziel wird als solche benannt', async () => {
  const dir = tempHome('stick-file');
  try {
    const file = path.join(dir.home, 'kein-ordner.txt');
    fs.writeFileSync(file, 'x');
    const tool = createStick({});
    await assert.rejects(
      () => tool.prepare(file, { includeRuntimes: false }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /eine Datei, kein Ordner/);
        return true;
      },
    );
  } finally {
    dir.cleanup();
  }
});

test('update verlangt einen echten Stick und erfindet keinen', async () => {
  const plain = tempHome('stick-notastick');
  const src = tempHome('stick-src12');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await assert.rejects(
      () => tool.update(plain.home, { sourceRoot: src.home }),
      (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /kein Neural-OS-Stick/);
        return true;
      },
    );
    assert.deepEqual(fs.readdirSync(plain.home), []);
  } finally {
    plain.cleanup();
    src.cleanup();
  }
});

test('eine blockierte Schleuse liefert eine Erklaerung, keinen rohen Fehler', async () => {
  const stick = tempHome('stick-blocked');
  const src = tempHome('stick-src13');
  let second = null;
  try {
    makeSource(src.home);
    // A real gate in its default state: offline, nothing allowed outwards.
    const config = configMod.defaults();
    assert.equal(config.network.mode, 'offline');
    const gate = createGate({ config, bus: new Bus() });
    const tool = createStick({ gate });
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    const foreign = LOCAL_PLATFORM === 'win-x64' ? 'linux-x64' : 'win-x64';
    await assert.rejects(
      () => tool.addRuntime(stick.home, foreign),
      (err) => {
        assert.equal(err.code, 'NETWORK_BLOCKED');
        assert.match(err.message, /online/);
        assert.match(err.message, /stick:runtime/);
        assert.match(err.message, /kein Fehler des Stick-Werkzeugs/);
        assert.equal(err.details.needs.allowHost, 'nodejs.org');
        return true;
      },
    );
    // Nothing was written for the platform that could not be fetched.
    assert.ok(!fs.existsSync(path.join(stick.home, 'Inhalt', 'runtime', foreign)));

    // The same denial inside prepare() is a warning, not a failure: the stick
    // is still complete for the machine it was made on.
    second = tempHome('stick-blocked2');
    const result = await tool.prepare(second.home, {
      sourceRoot: src.home,
      includeRuntimes: [foreign],
    });
    assert.ok(result.warnings.some((w) => w.includes(foreign) && w.includes('stick:runtime')),
      `die Warnung fehlt: ${JSON.stringify(result.warnings)}`);
    assert.ok(result.runtimes.some((r) => r.platform === LOCAL_PLATFORM),
      'die lokale Laufzeit muss trotzdem auf dem Stick liegen');
  } finally {
    stick.cleanup();
    src.cleanup();
    if (second) second.cleanup();
  }
});

test('ohne Schleuse sagt addRuntime, was fehlt', async () => {
  const stick = tempHome('stick-nogate');
  const src = tempHome('stick-src14');
  try {
    makeSource(src.home);
    const tool = createStick({ gate: null });
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    const foreign = LOCAL_PLATFORM === 'win-x64' ? 'linux-x64' : 'win-x64';
    await assert.rejects(
      () => tool.addRuntime(stick.home, foreign),
      (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /Netzschleuse/);
        return true;
      },
    );
    await assert.rejects(
      () => tool.addRuntime(stick.home, 'plan9-risc'),
      (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /keine bekannte Plattform/);
        return true;
      },
    );
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('addRuntime prueft die Pruefsumme und entpackt die tar.gz', async () => {
  const stick = tempHome('stick-tar');
  const src = tempHome('stick-src15');
  try {
    makeSource(src.home);
    const version = process.version;
    const platform = 'linux-arm64';
    const filename = `node-${version}-${platform}.tar.gz`;
    const binary = Buffer.from('#!/fake/node\n'.padEnd(5000, 'x'), 'utf8');
    const archive = makeTarGz([
      { name: `node-${version}-${platform}/README.md`, data: Buffer.from('lies mich') },
      { name: `node-${version}-${platform}/bin/node`, data: binary },
      { name: `node-${version}-${platform}/CHANGELOG.md`, data: Buffer.alloc(3000, 0x41) },
    ]);
    const sum = crypto.createHash('sha256').update(archive).digest('hex');
    const base = `https://nodejs.org/dist/${version}`;
    const gate = fakeGate({
      [`${base}/SHASUMS256.txt`]: `${'0'.repeat(64)}  node-${version}-irgendwas.tar.gz\n${sum}  ${filename}\n`,
      [`${base}/${filename}`]: archive,
    });

    const tool = createStick({ gate });
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    const added = await tool.addRuntime(stick.home, platform);

    assert.equal(added.platform, platform);
    assert.equal(added.version, version);
    const written = fs.readFileSync(path.join(stick.home, 'Inhalt', 'runtime', platform, 'node'));
    assert.ok(written.equals(binary), 'die entpackte Binaerdatei muss byteweise stimmen');
    assert.equal(fs.readFileSync(path.join(stick.home, 'Inhalt', 'runtime', platform, 'node-version.txt'), 'utf8').trim(), version);

    // Every request must have gone through the gate with the narrow limits.
    assert.equal(gate.calls.length, 2);
    for (const call of gate.calls) {
      assert.equal(call.init.scope, 'stick:runtime');
      assert.equal(call.init.maxLevel, 'online');
      assert.deepEqual(call.init.allowedHosts, ['nodejs.org']);
      assert.ok(call.init.purpose, 'jede Anfrage braucht einen Zweck');
      assert.ok(call.url.startsWith('https://nodejs.org/dist/'));
    }

    const platforms = tool.detectPlatforms(stick.home);
    assert.ok(platforms.some((p) => p.platform === platform && p.isLocal === false));
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('eine falsche Pruefsumme landet NICHT auf dem Stick', async () => {
  const stick = tempHome('stick-badsum');
  const src = tempHome('stick-src16');
  try {
    makeSource(src.home);
    const version = process.version;
    const platform = 'linux-arm64';
    const filename = `node-${version}-${platform}.tar.gz`;
    const archive = makeTarGz([{ name: `node-${version}-${platform}/bin/node`, data: Buffer.from('manipuliert') }]);
    const base = `https://nodejs.org/dist/${version}`;
    const gate = fakeGate({
      [`${base}/SHASUMS256.txt`]: `${'a'.repeat(64)}  ${filename}\n`, // passt nicht
      [`${base}/${filename}`]: archive,
    });

    const tool = createStick({ gate });
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    await assert.rejects(
      () => tool.addRuntime(stick.home, platform),
      (err) => {
        assert.equal(err.code, 'STORAGE_ERROR');
        assert.match(err.message, /Pr(ü|ue)fsumme/);
        assert.match(err.message, /VERWORFEN/);
        return true;
      },
    );
    assert.ok(!fs.existsSync(path.join(stick.home, 'Inhalt', 'runtime', platform, 'node')),
      'eine Datei mit falscher Pruefsumme darf nicht geschrieben werden');

    // Same for an archive that is not listed in SHASUMS256.txt at all.
    const gate2 = fakeGate({ [`${base}/SHASUMS256.txt`]: 'nichts passendes\n' });
    const tool2 = createStick({ gate: gate2 });
    await assert.rejects(
      () => tool2.addRuntime(stick.home, platform),
      (err) => {
        assert.equal(err.code, 'STORAGE_ERROR');
        assert.match(err.message, /keinen Eintrag/);
        return true;
      },
    );
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('der ZIP-Leser holt node.exe aus einem Windows-Archiv', async () => {
  const stick = tempHome('stick-zip');
  const src = tempHome('stick-src17');
  try {
    makeSource(src.home);
    const version = process.version;
    const platform = 'win-x64';
    const filename = `node-${version}-${platform}.zip`;
    const binary = Buffer.from('MZ'.padEnd(4096, 'w'), 'latin1');
    const archive = makeZip([
      { name: `node-${version}-${platform}/LICENSE`, data: Buffer.from('MIT') },
      { name: `node-${version}-${platform}/node.exe`, data: binary },
    ]);
    const sum = crypto.createHash('sha256').update(archive).digest('hex');
    const base = `https://nodejs.org/dist/${version}`;
    const gate = fakeGate({
      [`${base}/SHASUMS256.txt`]: `${sum}  ${filename}\n`,
      [`${base}/${filename}`]: archive,
    });

    const tool = createStick({ gate });
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    await tool.addRuntime(stick.home, platform);
    const written = fs.readFileSync(path.join(stick.home, 'Inhalt', 'runtime', platform, 'node.exe'));
    assert.ok(written.equals(binary));

    // And the reader on its own, including the "not in there" answer.
    assert.equal(pickFromZip(archive, (n) => n.endsWith('/gibtsnicht'), 1 << 20), null);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('probeFilesystem beantwortet die Rechtefrage durch Ausprobieren', () => {
  const dir = tempHome('stick-probe');
  try {
    const info = probeFilesystem(dir.home);
    assert.equal(info.writable, true);
    if (process.platform === 'win32') {
      assert.equal(info.enforcesModes, null);
    } else {
      // tmpdir on a test machine keeps modes; a stick with exFAT would not,
      // and that is exactly the difference this probe exists to find.
      assert.equal(info.enforcesModes, true);
    }
    assert.equal(info.error, null);
    // Nothing of the probe may stay behind.
    assert.deepEqual(fs.readdirSync(dir.home).filter((n) => n.startsWith('.neural-os-probe')), []);
  } finally {
    dir.cleanup();
  }
});

test('detectPlatforms zaehlt nur echte Laufzeiten', async () => {
  const stick = tempHome('stick-detect');
  const src = tempHome('stick-src18');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    assert.deepEqual(tool.detectPlatforms(stick.home), []);

    const runtime = path.join(stick.home, 'Inhalt', 'runtime');
    fs.mkdirSync(path.join(runtime, 'darwin-arm64'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'darwin-arm64', 'node'), 'x'.repeat(100));
    fs.writeFileSync(path.join(runtime, 'darwin-arm64', 'node-version.txt'), 'v22.11.0\n');
    // An empty file is not a runtime, and neither is a made-up platform name.
    fs.mkdirSync(path.join(runtime, 'linux-x64'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'linux-x64', 'node'), '');
    fs.mkdirSync(path.join(runtime, 'haiku-m68k'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'haiku-m68k', 'node'), 'x');

    const found = tool.detectPlatforms(stick.home);
    assert.deepEqual(found.map((p) => p.platform), ['darwin-arm64']);
    assert.equal(found[0].version, 'v22.11.0');

    const check = await tool.verify(stick.home);
    assert.ok(check.problems.some((p) => p.code === 'NO_LOCAL_RUNTIME'),
      'eine fehlende Laufzeit fuer dieses System muss auffallen');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('der Fortschritt wird gemeldet und ein Fehler darin bricht nichts ab', async () => {
  const stick = tempHome('stick-progress');
  const src = tempHome('stick-src19');
  try {
    makeSource(src.home);
    const phases = [];
    const tool = createStick({});
    const result = await tool.prepare(stick.home, {
      sourceRoot: src.home,
      includeRuntimes: false,
      onProgress(evt) {
        phases.push(evt.phase);
        assert.ok(typeof evt.message === 'string' && evt.message.length > 0);
        throw new Error('ein kaputter Fortschrittsbalken darf nichts kaputt machen');
      },
    });
    assert.ok(result.files > 0);
    assert.ok(phases.includes('check'));
    assert.ok(phases.includes('source'));
    assert.ok(phases.includes('done'));
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('ein echter Stick laesst sich aus dem echten Quelltext bauen', async () => {
  const stick = tempHome('stick-real');
  try {
    const tool = createStick({});
    // No sourceRoot: this is the path the application itself takes.
    const result = await tool.prepare(stick.home, { includeRuntimes: false });
    assert.ok(result.files > 50, 'der echte Quelltext hat mehr als 50 Dateien');
    for (const rel of ['app/bin/neural-os.js', 'app/src/net/gate.js', 'app/src/portable/stick.js', 'app/web/app.js']) {
      assert.ok(fs.existsSync(path.join(stick.home, 'Inhalt', rel)), `${rel} fehlt`);
    }
    assert.ok(!fs.existsSync(path.join(stick.home, 'Inhalt', 'app/node_modules')));
    assert.ok(!fs.existsSync(path.join(stick.home, 'Inhalt', 'app/.git')));

    // The copied CLI must be a loadable program, not a truncated file.
    const run = spawnSync(process.execPath, [path.join(stick.home, 'Inhalt', 'app/bin/neural-os.js'), 'version'], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(run.status, 0, `der kopierte Starter laeuft nicht: ${run.stderr}`);
    assert.match(run.stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally {
    stick.cleanup();
  }
});

/* ------------------------------------------- Serverbetrieb: Punkte 1 bis 7 */

/**
 * Ein Quelltextbaum mit echtem Gewicht.
 *
 * Die Messungen brauchen eine Kopie, die lange genug dauert, um ueberhaupt
 * etwas beobachten zu koennen -- mit zehn winzigen Dateien ist jede Aussage
 * ueber den Ereignisring Zufall.
 */
function makeHeavySource(root, { files = 150, bytes = 1024 * 1024 } = {}) {
  makeSource(root, { withJunk: false });
  const blob = Buffer.alloc(bytes, 7);
  const dir = path.join(root, 'gross');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `teil-${i}.bin`), blob);
  return root;
}

/** Ein Ordner, in dem dieser Prozess nichts anlegen darf -- oder null. */
function readOnlyDir() {
  for (const dir of (process.platform === 'linux' ? ['/sys'] : [])) {
    if (!fs.existsSync(dir)) continue;
    const probe = path.join(dir, `.neural-os-test-${Date.now()}`);
    try {
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
    } catch {
      return dir;
    }
  }
  if (process.getuid && process.getuid() !== 0) {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stick-ro-'));
    fs.chmodSync(dir, 0o500);
    return dir;
  }
  return null;
}

test('waehrend des Kopierens bleibt der Server bedienbar', async () => {
  const stick = tempHome('stick-ring');
  const src = tempHome('stick-src20');
  try {
    makeHeavySource(src.home);
    const tool = createStick({});

    // Der Zeitgeber steht fuer alles, was ein Server nebenher tun muss.
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    // Und das hier fuer eine zweite Anfrage, die waehrenddessen ankommt.
    let fremdeAntwort = 0;
    const fremderAufruf = new Promise((resolve) => {
      setTimeout(() => { fremdeAntwort = Date.now(); resolve(); }, 20);
    });

    const begonnen = Date.now();
    const result = await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: true });
    const kopieFertig = Date.now();
    await fremderAufruf;
    clearInterval(timer);

    const dauer = kopieFertig - begonnen;
    assert.ok(dauer > 50, `die Kopie war mit ${dauer} ms zu kurz, um etwas zu messen`);
    assert.ok(result.files > 150);
    // Vor der Umstellung auf fs.promises.copyFile stand der Ring hier komplett
    // still: null Ticks, und die zweite Anfrage kam erst NACH der Kopie an.
    assert.ok(ticks >= 3, `der Ereignisring bekam waehrend ${dauer} ms nur ${ticks} Runden`);
    assert.ok(fremdeAntwort > 0 && fremdeAntwort < kopieFertig,
      'der andere Aufruf wurde erst nach der Kopie beantwortet - der Server stand still');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('ein Abbruch stoppt die Kopie und laesst den alten Stand stehen', async () => {
  const stick = tempHome('stick-abbruch');
  const src = tempHome('stick-src21');
  try {
    makeHeavySource(src.home, { files: 60 });
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    const alt = snapshotDir(path.join(stick.home, 'Inhalt', 'app'));

    const controller = new AbortController();
    let gesehen = 0;
    await assert.rejects(
      () => tool.update(stick.home, {
        sourceRoot: src.home,
        signal: controller.signal,
        onProgress(p) { if (p.copied >= 1 && ++gesehen === 1) controller.abort(); },
      }),
      (err) => {
        assert.equal(err.code, 'ABORTED');
        assert.equal(err.status, 499);
        assert.match(err.message, /abgebrochen/);
        assert.ok(!/abort(ed)?\b/i.test(err.message.replace(/abgebrochen/gi, '')),
          `die Meldung muss deutsch sein: ${err.message}`);
        return true;
      },
    );

    // Die zweistufige Umbenennung haelt ihr Versprechen: app/ ist weder halb
    // noch weg, sondern unveraendert der vollstaendige Stand von vorher.
    assert.deepEqual(snapshotDir(path.join(stick.home, 'Inhalt', 'app')), alt);
    const reste = fs.readdirSync(stick.home).filter((n) => /^\.app\.(tmp|old)-/.test(n));
    assert.deepEqual(reste, [], `nach dem Abbruch blieb liegen: ${reste.join(', ')}`);

    const nachher = await tool.verify(stick.home);
    assert.ok(!nachher.problems.some((p) => p.code === 'APP_MISSING' || p.code === 'APP_INCOMPLETE'),
      `der Stick ist nach dem Abbruch benutzbar: ${JSON.stringify(nachher.problems)}`);
    // Und die Sperre ist wieder frei.
    const wieder = await tool.update(stick.home, { sourceRoot: src.home });
    assert.ok(wieder.files > 0);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('ein Abbruch beim ersten Anlegen hinterlaesst einen Zustand, den verify erklaert', async () => {
  const stick = tempHome('stick-abbruch2');
  const src = tempHome('stick-src22');
  try {
    makeHeavySource(src.home, { files: 60 });
    const tool = createStick({});
    const controller = new AbortController();
    await assert.rejects(
      () => tool.prepare(stick.home, {
        sourceRoot: src.home,
        includeRuntimes: false,
        signal: controller.signal,
        onProgress(p) { if (p.copied >= 1) controller.abort(); },
      }),
      (err) => err.code === 'ABORTED',
    );

    // Halbes darf nicht liegenbleiben, und was fehlt, muss verify benennen.
    const reste = fs.readdirSync(stick.home).filter((n) => /^\.app\.tmp-/.test(n));
    assert.deepEqual(reste, [], `halb kopierter Ordner blieb liegen: ${reste.join(', ')}`);
    const geprueft = await tool.verify(stick.home);
    assert.equal(geprueft.ok, false);
    const fehlt = geprueft.problems.find((p) => p.code === 'APP_MISSING' || p.code === 'MARKER_MISSING');
    assert.ok(fehlt, `verify muss den abgebrochenen Stick erklaeren: ${JSON.stringify(geprueft.problems)}`);
    assert.ok(fehlt.fix && fehlt.fix.length > 10, 'und sagen, was zu tun ist');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('ein bereits abgebrochenes Signal laesst nichts mehr anfangen', async () => {
  const stick = tempHome('stick-abbruch3');
  const ziel = tempHome('stick-abbruch3b');
  const src = tempHome('stick-src23');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    const vorher = snapshotDir(stick.home);

    const controller = new AbortController();
    controller.abort();
    for (const lauf of [
      () => tool.prepare(ziel.home, { sourceRoot: src.home, includeRuntimes: false, signal: controller.signal }),
      () => tool.update(stick.home, { sourceRoot: src.home, signal: controller.signal }),
      () => tool.addRuntime(stick.home, LOCAL_PLATFORM || 'linux-x64', { signal: controller.signal }),
    ]) {
      await assert.rejects(lauf, (err) => {
        assert.equal(err.code, 'ABORTED');
        return true;
      });
    }
    assert.deepEqual(snapshotDir(stick.home), vorher, 'ein abgebrochener Aufruf darf nichts anfassen');
  } finally {
    stick.cleanup();
    ziel.cleanup();
    src.cleanup();
  }
});

test('zwei Vorgaenge auf demselben Stick schliessen einander aus', async () => {
  const stick = tempHome('stick-sperre');
  const zweiter = tempHome('stick-sperre2');
  const src = tempHome('stick-src24');
  try {
    makeHeavySource(src.home, { files: 80 });
    const a = createStick({});
    // Ein zweiter Browsertab holt sich sein eigenes Werkzeug: die Sperre muss
    // deshalb am Pfad haengen, nicht am Objekt.
    const b = createStick({});

    const laeuft = a.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    await assert.rejects(
      () => b.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false }),
      (err) => {
        assert.equal(err.code, 'STICK_BUSY');
        assert.equal(err.status, 409);
        assert.match(err.message, /laeuft bereits "Stick vorbereiten"/);
        assert.match(err.message, /Warte/);
        return true;
      },
    );
    // Ein anderer Stick ist davon nicht betroffen.
    const daneben = await b.prepare(zweiter.home, { sourceRoot: src.home, includeRuntimes: false });
    assert.ok(daneben.files > 0);

    const erste = await laeuft;
    assert.ok(erste.files > 80);
    // Der erste Vorgang ist vollstaendig durchgelaufen, nichts wurde ihm
    // unter den Haenden weggeraeumt.
    const geprueft = await a.verify(stick.home);
    assert.ok(!geprueft.problems.some((p) => p.code === 'APP_INCOMPLETE' || p.code === 'INTERRUPTED_COPY'),
      `der parallele Aufruf hat den Stick beschaedigt: ${JSON.stringify(geprueft.problems)}`);
    // Danach ist die Wurzel wieder frei.
    const nochmal = await b.update(stick.home, { sourceRoot: src.home });
    assert.ok(nochmal.files > 0);
  } finally {
    stick.cleanup();
    zweiter.cleanup();
    src.cleanup();
  }
});

test('prepare ohne includeRuntimes: Windows, Mac (Apple-Chip) und Mac (Intel) kommen aus dem Attrappen-Gate auf den Stick', async () => {
  const stick = tempHome('stick-ziel-lz');
  const src = tempHome('stick-src-ziel-lz');
  try {
    makeSource(src.home);
    const ziel = ['win-x64', 'darwin-arm64', 'darwin-x64'];
    const andere = ziel.filter((p) => p !== LOCAL_PLATFORM);
    const { routes, binaries } = laufzeitArchive(andere);
    const gate = fakeGate(routes);
    const tool = createStick({ gate });
    const r = await tool.prepare(stick.home, { sourceRoot: src.home });
    assert.deepEqual(r.fehlend, [], JSON.stringify(r.fehlend));
    for (const p of ziel) {
      const spec = require('../src/portable/stick').PLATFORMS[p];
      const datei = path.join(stick.home, 'Inhalt', 'runtime', p, spec.file);
      assert.ok(fs.existsSync(datei), `runtime/${p} fehlt`);
      if (p !== LOCAL_PLATFORM) assert.ok(fs.readFileSync(datei).equals(binaries[p]), `${p}: falscher Inhalt`);
    }
    assert.ok(r.runtimes.some((x) => x.platform === LOCAL_PLATFORM && x.source === 'lokal'), 'die eigene Laufzeit kam nicht ohne Netz');
    // Nur nodejs.org, nur der Bereich stick:runtime -- fuer jede geholte Laufzeit zweimal.
    assert.equal(gate.calls.length, andere.length * 2);
    assert.ok(gate.calls.every((c) => c.init.scope === 'stick:runtime' && /^https:\/\/nodejs\.org\//.test(c.url)));
    const pruefung = await tool.verify(stick.home);
    assert.equal(pruefung.ok, true, JSON.stringify(pruefung.problems));
    assert.deepEqual(pruefung.startklar, { hier: true, windows: true, mac: true });
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('Laufzeitquellen: der eigene Stick und der Zwischenspeicher kommen vor nodejs.org, und ein Download landet im Zwischenspeicher', async () => {
  const eigener = tempHome('stick-lz-eigener');
  const ziel = tempHome('stick-lz-ziel');
  const heim = tempHome('stick-lz-heim');
  const src = tempHome('stick-lz-src');
  try {
    makeSource(src.home);
    const fremde = ['win-x64', 'darwin-arm64', 'darwin-x64'].filter((p) => p !== LOCAL_PLATFORM);
    const { PLATFORMS } = require('../src/portable/stick');

    // 1) Der eigene Stick traegt eine Laufzeit: sie wird kopiert, ohne Netz.
    const vomStick = fremde[0];
    const eigeneBasis = path.join(eigener.home, 'Inhalt');
    fs.mkdirSync(path.join(eigeneBasis, 'runtime', vomStick), { recursive: true });
    fs.writeFileSync(path.join(eigeneBasis, 'neural-os.portable'), JSON.stringify({ neuralOsPortable: true }));
    fs.writeFileSync(path.join(eigeneBasis, 'runtime', vomStick, PLATFORMS[vomStick].file), 'vom eigenen Stick');
    fs.writeFileSync(path.join(eigeneBasis, 'runtime', vomStick, 'node-version.txt'), 'v0.0.0\n');
    // 2) Der Zwischenspeicher der Heim-Installation hat eine zweite, in der richtigen Version.
    const ausCache = fremde[1];
    const cache = path.join(heim.home, 'laufzeiten', ausCache);
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, PLATFORMS[ausCache].file), 'aus dem Zwischenspeicher');
    fs.writeFileSync(path.join(cache, 'node-version.txt'), `${process.version}\n`);
    // 3) Fuer alles andere: nodejs.org (Attrappe), die nur die dritte kennt.
    const rest = fremde.slice(2);
    const { routes, binaries } = laufzeitArchive(rest);
    const gate = fakeGate(routes);

    const tool = createStick({ gate, paths: { home: heim.home }, portable: { root: eigeneBasis } });
    const r = await tool.prepare(ziel.home, { sourceRoot: src.home });
    assert.deepEqual(r.fehlend, [], JSON.stringify(r.fehlend));
    const quelle = Object.fromEntries(r.runtimes.map((x) => [x.platform, x.source]));
    assert.equal(quelle[vomStick], 'eigener-stick');
    assert.equal(quelle[ausCache], 'zwischenspeicher');
    for (const p of rest) assert.equal(quelle[p], 'nodejs.org');
    assert.equal(fs.readFileSync(path.join(ziel.home, 'Inhalt', 'runtime', vomStick, PLATFORMS[vomStick].file), 'utf8'), 'vom eigenen Stick');
    assert.equal(fs.readFileSync(path.join(ziel.home, 'Inhalt', 'runtime', ausCache, PLATFORMS[ausCache].file), 'utf8'), 'aus dem Zwischenspeicher');
    for (const p of rest) assert.ok(fs.readFileSync(path.join(ziel.home, 'Inhalt', 'runtime', p, PLATFORMS[p].file)).equals(binaries[p]));
    // nodejs.org wurde nur fuer den Rest gefragt.
    assert.equal(gate.calls.length, rest.length * 2, gate.calls.map((c) => c.url).join('\n'));
    // Ein Download wird nicht zwischengespeichert, solange die Instanz vom Stick laeuft (dort ist runtime/ der Vorrat) ...
    for (const p of rest) assert.equal(fs.existsSync(path.join(heim.home, 'laufzeiten', p)), false);

    // ... von der Heim-Installation aus schon: der naechste Stick bekommt sie ohne Netz.
    const zweiter = tempHome('stick-lz-ziel2');
    const dritter = tempHome('stick-lz-ziel3');
    try {
      const heimisch = createStick({ gate: fakeGate(laufzeitArchive(fremde).routes), paths: { home: heim.home }, portable: null });
      const r2 = await heimisch.prepare(zweiter.home, { sourceRoot: src.home });
      assert.deepEqual(r2.fehlend, []);
      for (const p of fremde) {
        assert.ok(fs.existsSync(path.join(heim.home, 'laufzeiten', p, PLATFORMS[p].file)), `${p} liegt nicht im Zwischenspeicher`);
        assert.equal(fs.readFileSync(path.join(heim.home, 'laufzeiten', p, 'node-version.txt'), 'utf8').trim(), process.version);
      }
      const ohneNetz = createStick({ paths: { home: heim.home }, portable: null });
      const r3 = await ohneNetz.prepare(dritter.home, { sourceRoot: src.home });
      assert.deepEqual(r3.fehlend, [], JSON.stringify(r3.fehlend));
      for (const p of fremde) assert.equal(r3.runtimes.find((x) => x.platform === p).source, 'zwischenspeicher');
    } finally {
      zweiter.cleanup();
      dritter.cleanup();
    }
  } finally {
    eigener.cleanup();
    ziel.cleanup();
    heim.cleanup();
    src.cleanup();
  }
});

test('verify: ohne darwin-* ist es FEHLT_MAC, ohne win-* FEHLT_WINDOWS -- mit den Saetzen aus 1.8; mit allen dreien ist der Stick in Ordnung', async () => {
  const stick = tempHome('stick-fehlt');
  const src = tempHome('stick-src-fehlt');
  try {
    makeSource(src.home);
    const { PLATFORMS } = require('../src/portable/stick');
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    const lege = (p) => {
      const dir = path.join(stick.home, 'Inhalt', 'runtime', p);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, PLATFORMS[p].file), 'x');
    };
    const weg = (p) => fs.rmSync(path.join(stick.home, 'Inhalt', 'runtime', p), { recursive: true, force: true });
    const codes = async () => (await tool.verify(stick.home)).problems.filter((p) => /^FEHLT_/.test(p.code));

    lege('win-x64');
    if (LOCAL_PLATFORM) lege(LOCAL_PLATFORM);
    let f = await codes();
    assert.deepEqual(f.map((p) => p.code), ['FEHLT_MAC']);
    assert.equal(f[0].level, 'error');
    assert.equal(f[0].message, 'Läuft bisher nur an Windows.');
    assert.equal(f[0].fix, 'Für Mac holen');

    weg('win-x64');
    lege('darwin-arm64');
    f = await codes();
    assert.deepEqual(f.map((p) => p.code), ['FEHLT_WINDOWS']);
    assert.equal(f[0].message, 'Läuft bisher nur am Mac.');
    assert.equal(f[0].fix, 'Für Windows holen');

    lege('win-x64');
    lege('darwin-x64');
    const ok = await tool.verify(stick.home);
    assert.deepEqual(ok.problems.filter((p) => /^FEHLT_/.test(p.code)), []);
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    assert.equal(ok.startklar.windows, true);
    assert.equal(ok.startklar.mac, true);
    assert.equal(ok.ki.id, JSON.parse(fs.readFileSync(path.join(stick.home, 'Inhalt', 'neural-os.portable'), 'utf8')).kiId);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('Begleitdateien: "._.app.old-deadbeef" in der Wurzel ist kein Rest -- verify ohne INTERRUPTED_COPY, nach update kein "_.app", und ".DS_Store" kommt nie ins Programm', async () => {
  const stick = tempHome('stick-begleit');
  const src = tempHome('stick-src-begleit');
  try {
    makeSource(src.home);
    fs.writeFileSync(path.join(src.home, 'src', '._app.js'), 'AppleDouble');
    fs.writeFileSync(path.join(src.home, 'Thumbs.db'), 'x');
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    const basis = path.join(stick.home, 'Inhalt');
    assert.ok(!fs.existsSync(path.join(basis, 'app', 'src', '._app.js')), 'die AppleDouble-Datei wurde ins Programm kopiert');
    assert.ok(!fs.existsSync(path.join(basis, 'app', 'Thumbs.db')));

    // Was macOS auf einem exFAT-Stick neben jeden Ordner legt (belegt, win-mac v4):
    fs.writeFileSync(path.join(stick.home, '._.app.old-deadbeef'), 'AppleDouble');
    fs.writeFileSync(path.join(basis, '._.app.old-deadbeef'), 'AppleDouble');
    fs.writeFileSync(path.join(basis, '.DS_Store'), 'x');
    const v = await tool.verify(stick.home);
    assert.ok(!v.problems.some((p) => p.code === 'INTERRUPTED_COPY'), JSON.stringify(v.problems));
    assert.deepEqual(tool.preview(stick.home, { action: 'update', sourceRoot: src.home }).stale, []);

    await tool.update(stick.home, { sourceRoot: src.home });
    assert.ok(!fs.existsSync(path.join(stick.home, '_.app')), 'aus der Begleitdatei wurde ein Ordner "_.app"');
    assert.ok(!fs.existsSync(path.join(basis, '_.app')), 'aus der Begleitdatei wurde ein Ordner "_.app"');
    assert.ok(fs.existsSync(path.join(basis, '._.app.old-deadbeef')), 'die Begleitdatei wurde weggeraeumt, als waere sie ein Rest');
    // Ein echter Rest wird weiterhin erkannt und weggeraeumt.
    fs.mkdirSync(path.join(basis, '.app.tmp-cafebabe'));
    assert.ok((await tool.verify(stick.home)).problems.some((p) => p.code === 'INTERRUPTED_COPY'));
    await tool.update(stick.home, { sourceRoot: src.home });
    assert.ok(!fs.existsSync(path.join(basis, '.app.tmp-cafebabe')));
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('"Programm auf dem Stick ist älter." [Erneuern]: verify, einrichtenPlan und findeLaufwerke sagen es, update behebt es', async () => {
  const medien = tempHome('stick-medien-alt');
  const src = tempHome('stick-src-alt');
  try {
    makeSource(src.home);
    const stickMod = require('../src/portable/stick');
    const ziel = path.join(medien.home, 'USB');
    const tool = createStick({});
    await tool.prepare(ziel, { sourceRoot: src.home, includeRuntimes: false });
    const pkg = path.join(ziel, 'Inhalt', 'app', 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ name: 'neural-os', version: '0.0.1' }));

    const v = await tool.verify(ziel);
    const alt = v.problems.find((p) => p.code === 'PROGRAMM_AELTER');
    assert.ok(alt, JSON.stringify(v.problems));
    assert.equal(alt.message, 'Programm auf dem Stick ist älter.');
    assert.equal(alt.fix, 'Erneuern');
    assert.equal(v.version, '0.0.1');
    assert.equal(tool.einrichtenPlan(ziel, {}).aelter, true);
    const lw = await stickMod.findeLaufwerke({ platform: 'linux', wurzeln: [medien.home], einhaengepunkt: () => true });
    assert.equal(lw.laufwerke.length, 1);
    assert.equal(lw.laufwerke[0].istStick, true);
    assert.equal(lw.laufwerke[0].aufbau, 'inhalt');
    assert.equal(lw.laufwerke[0].aelter, true);
    assert.equal(lw.laufwerke[0].version, '0.0.1');
    assert.match(lw.laufwerke[0].ki.id, /^dev_/);

    // [Erneuern] ist update(): danach ist die Version die des Quelltexts.
    // (Die Attrappe traegt dieselbe Version wie das Repository, deshalb kein "aelter" mehr.)
    fs.writeFileSync(path.join(src.home, 'package.json'), JSON.stringify({ name: 'neural-os', version: require('../package.json').version }));
    await tool.update(ziel, { sourceRoot: src.home });
    assert.ok(!(await tool.verify(ziel)).problems.some((p) => p.code === 'PROGRAMM_AELTER'));
    assert.equal(tool.einrichtenPlan(ziel, {}).aelter, false);
  } finally {
    medien.cleanup();
    src.cleanup();
  }
});

test('Mac: die Zeile aus /sbin/mount fuer die Wurzel -- bei apfs oder hfs "Windows sieht diesen Stick nicht."', async () => {
  const stick = tempHome('stick-apfs');
  const src = tempHome('stick-src-apfs');
  try {
    makeSource(src.home);
    const echt = fs.realpathSync.native(stick.home);
    const mount = [
      '/dev/disk1s1 on / (apfs, local, journaled)',
      `/dev/disk4s1 on ${echt} (apfs, local, nodev, nosuid, journaled, noowners)`,
      '/dev/disk5s1 on /Volumes/LENA (exfat, local, nodev, nosuid, noowners)',
    ].join('\n');
    const ausfuehren = async (cmd) => (cmd === '/sbin/mount' ? { code: 0, stdout: `${mount}\n`, stderr: '', error: null } : { code: 1, stdout: '', stderr: '', error: 'ENOENT' });
    const tool = createStick({ platform: 'darwin', ausfuehren });
    const r = await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });
    assert.equal(r.dateisystem, 'apfs');
    assert.deepEqual(r.hinweise.map((h) => h.satz), ['Windows sieht diesen Stick nicht.']);
    assert.ok(r.warnings.includes('Windows sieht diesen Stick nicht.'));
    const v = await tool.verify(stick.home);
    assert.ok(v.problems.some((p) => p.code === 'KEIN_WINDOWS' && p.message === 'Windows sieht diesen Stick nicht.'), JSON.stringify(v.problems));
    assert.equal(v.filesystem.name, 'apfs');

    // Ein exFAT-Stick bekommt keinen Hinweis; NTFS liest der Mac nur.
    const stickMod = require('../src/portable/stick');
    assert.equal(stickMod.dateisystemHinweis('exfat'), null);
    assert.equal(stickMod.dateisystemHinweis('msdos'), null);
    assert.equal(stickMod.dateisystemHinweis('hfs').satz, 'Windows sieht diesen Stick nicht.');
    assert.equal(stickMod.dateisystemHinweis('ntfs').code, 'NUR_LESEN_MAC');
    assert.equal(stickMod.dateisystemHinweis('FUSE (z. B. exfat-fuse, ntfs-3g)'), null);
    // Nicht am Mac: mount wird gar nicht gefragt.
    let gefragt = 0;
    const linux = createStick({ platform: 'linux', ausfuehren: async () => { gefragt++; return { code: 0, stdout: mount }; } });
    await linux.verify(stick.home);
    assert.equal(gefragt, 0);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('alter Aufbau (alles in der Wurzel): update erneuert an Ort und Stelle, verschiebt data/ nie, tauscht die alten Starter, legt kein "Inhalt" an', async () => {
  const stick = tempHome('stick-alt-aufbau');
  const src = tempHome('stick-src-alt-aufbau');
  try {
    makeSource(src.home);
    const stickMod = require('../src/portable/stick');
    // So sieht ein Stick von vor Paket R aus.
    fs.mkdirSync(path.join(stick.home, 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(stick.home, 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version: '0.0.1' }));
    fs.mkdirSync(path.join(stick.home, 'data'), { recursive: true });
    fs.writeFileSync(path.join(stick.home, 'data', 'config.json'), '{"sync":{"deviceId":"dev_000000000000000000000001"}}');
    fs.writeFileSync(path.join(stick.home, 'neural-os.portable'), JSON.stringify({ neuralOsPortable: true, dataDir: 'data', appDir: 'app', createdAt: '2026-01-01T00:00:00.000Z', kiId: 'dev_000000000000000000000001' }));
    for (const alt of ['Neural OS starten.bat', 'Neural OS starten.command', 'Neural OS starten.sh']) fs.writeFileSync(path.join(stick.home, alt), 'alt');

    const lage = stickMod.aufbauVon(stick.home);
    assert.deepEqual(lage, { wurzel: path.resolve(stick.home), basis: path.resolve(stick.home), aufbau: 'alt', istStick: true });
    // Dieselbe Antwort fuer einen neuen Stick, egal ob Wurzel oder Inhalt gefragt wird.
    const neu = tempHome('stick-neu-aufbau');
    try {
      await createStick({}).prepare(neu.home, { sourceRoot: src.home, includeRuntimes: false });
      const vonWurzel = stickMod.aufbauVon(neu.home);
      const vonInhalt = stickMod.aufbauVon(path.join(neu.home, 'Inhalt'));
      assert.deepEqual(vonWurzel, vonInhalt);
      assert.equal(vonWurzel.aufbau, 'inhalt');
      assert.equal(vonWurzel.basis, path.join(path.resolve(neu.home), 'Inhalt'));
      // Die laufende App kennt nur den Inhalt-Ordner; verify und update nehmen ihn genauso.
      const v = await createStick({}).verify(path.join(neu.home, 'Inhalt'));
      assert.equal(v.root, path.resolve(neu.home));
      assert.equal(v.layout.readme.exists, true);
    } finally {
      neu.cleanup();
    }

    const tool = createStick({});
    const daten = snapshotDir(path.join(stick.home, 'data'));
    const r = await tool.update(stick.home, { sourceRoot: src.home });
    assert.equal(r.aufbau, 'alt');
    assert.ok(!fs.existsSync(path.join(stick.home, 'Inhalt')), 'ein bestehender Stick wurde umgebaut');
    assert.deepEqual(snapshotDir(path.join(stick.home, 'data')), daten, 'data/ wurde angefasst');
    assert.ok(fs.existsSync(path.join(stick.home, 'app', 'bin', 'neural-os.js')));
    for (const alt of ['Neural OS starten.bat', 'Neural OS starten.command', 'Neural OS starten.sh']) {
      assert.ok(!fs.existsSync(path.join(stick.home, alt)), `${alt} liegt noch da`);
    }
    for (const n of ['Neural OS starten - Windows.bat', 'Neural OS starten - Mac.command', 'Starter fuer Linux.sh', 'LIESMICH.txt']) {
      assert.ok(fs.existsSync(path.join(stick.home, n)), `${n} fehlt`);
    }
    const marker = JSON.parse(fs.readFileSync(path.join(stick.home, 'neural-os.portable'), 'utf8'));
    assert.equal(marker.kiId, 'dev_000000000000000000000001', 'die KI des alten Sticks wurde ersetzt');
    const v = await tool.verify(stick.home);
    assert.equal(v.aufbau, 'alt');
    assert.ok(!v.problems.some((p) => p.code === 'LAUNCHER_MISSING' || p.code === 'PROGRAMM_AELTER'), JSON.stringify(v.problems));
    assert.equal(tool.einrichtenPlan(stick.home, {}).fall, 'erneuern');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('waehrend ein Vorgang laeuft, nennt verify das beim Namen', async () => {
  const stick = tempHome('stick-laeuft');
  const src = tempHome('stick-src30');
  try {
    makeHeavySource(src.home, { files: 80 });
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    const laeuft = tool.update(stick.home, { sourceRoot: src.home });
    const mittendrin = await tool.verify(stick.home);
    await laeuft;

    // Der Arbeitsordner eines laufenden Vorgangs heisst genauso wie der Rest
    // eines abgebrochenen. Ihn als Abbruch zu melden waere ein erfundener Befund.
    assert.ok(!mittendrin.problems.some((p) => p.code === 'INTERRUPTED_COPY'),
      `ein laufender Vorgang ist kein Abbruch: ${JSON.stringify(mittendrin.problems)}`);
    const hinweis = mittendrin.problems.find((p) => p.code === 'OPERATION_RUNNING');
    assert.ok(hinweis, 'der laufende Vorgang muss dastehen');
    assert.equal(hinweis.level, 'info');
    assert.match(hinweis.message, /Stick aktualisieren/);

    // Danach ist der Hinweis weg und der Stick wieder ein gewoehnlicher Stick.
    const danach = await tool.verify(stick.home);
    assert.ok(!danach.problems.some((p) => p.code === 'OPERATION_RUNNING' || p.code === 'INTERRUPTED_COPY'));
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('verify legt keine Datei an - die Sonde muss man verlangen', async () => {
  const stick = tempHome('stick-lesen');
  const src = tempHome('stick-src25');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    const vorher = fs.statSync(stick.home, { bigint: true }).mtimeNs;
    const gelesen = await tool.verify(stick.home);
    assert.equal(gelesen.filesystem.probed, false);
    assert.equal(fs.statSync(stick.home, { bigint: true }).mtimeNs, vorher,
      'verify hat im Wurzelverzeichnis etwas angelegt oder geloescht');
    assert.deepEqual(fs.readdirSync(stick.home).filter((n) => n.startsWith('.neural-os-probe')), []);

    // Gegenprobe: mit ausdruecklicher Sonde AENDERT sich die Zeit. Damit misst
    // der Test oben nachweislich das Richtige und nicht nur eine grobe Uhr.
    const mitSonde = await tool.verify(stick.home, { probe: true });
    assert.equal(mitSonde.filesystem.probed, true);
    assert.notEqual(fs.statSync(stick.home, { bigint: true }).mtimeNs, vorher);
    assert.deepEqual(fs.readdirSync(stick.home).filter((n) => n.startsWith('.neural-os-probe')), []);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('die Rechtefrage beantwortet verify aus den Zeugen, nicht durch Schreiben', async () => {
  if (process.platform === 'win32') return; // dort gibt es keine Unix-Modi
  const stick = tempHome('stick-rechte');
  const src = tempHome('stick-src26');
  const fremd = tempHome('stick-fremd');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    const gut = await tool.verify(stick.home);
    assert.equal(gut.filesystem.enforcesModes, true);
    assert.ok(!gut.problems.some((p) => p.code === 'NO_PERMISSIONS' || p.code === 'PERMISSIONS_UNKNOWN'));

    // Genau das tut ein exFAT-Treiber: der gesetzte Modus kommt nicht zurueck.
    fs.chmodSync(path.join(stick.home, 'Inhalt', 'data'), 0o777);
    const ohneRechte = await tool.verify(stick.home);
    assert.equal(ohneRechte.filesystem.enforcesModes, false);
    const warnung = ohneRechte.problems.find((p) => p.code === 'NO_PERMISSIONS');
    assert.ok(warnung, `ein Dateisystem ohne Rechte muss auffallen: ${JSON.stringify(ohneRechte.problems)}`);
    assert.match(warnung.fix, /Verschlüsselung/);

    // Ohne Zeugen wird nichts behauptet: die Frage bleibt offen und sagt das.
    const unbekannt = await tool.verify(fremd.home);
    assert.equal(unbekannt.filesystem.enforcesModes, null);
    const offen = unbekannt.problems.find((p) => p.code === 'PERMISSIONS_UNKNOWN');
    assert.ok(offen, 'eine ungeklaerte Frage muss als ungeklaert dastehen');
    assert.equal(offen.level, 'info');
    assert.ok(!unbekannt.problems.some((p) => p.code === 'NO_PERMISSIONS'));
  } finally {
    stick.cleanup();
    src.cleanup();
    fremd.cleanup();
  }
});

test('auch die Fehler aus der Fehlertaxonomie sind ganze deutsche Saetze', async () => {
  const stick = tempHome('stick-deutsch');
  const src = tempHome('stick-src27');
  try {
    makeSource(src.home);
    const tool = createStick({});
    const faelle = [
      () => tool.prepare(stick.home, { sourceRoot: path.join(src.home, 'gibt-es-nicht') }),
      () => tool.update(path.join(stick.home, 'auch-nicht'), { sourceRoot: src.home }),
    ];
    for (const fall of faelle) {
      await assert.rejects(fall, (err) => {
        assert.equal(err.code, 'NOT_FOUND');
        assert.equal(err.status, 404);
        // "Der Quellordner /media/usb not found" ist kein deutscher Satz.
        assert.ok(!/not found/i.test(err.message), `englischer Rest in: ${err.message}`);
        assert.match(err.message, /gibt es nicht/);
        assert.match(err.message, /[.?]$/, 'ein ganzer Satz endet auch wie einer');
        return true;
      });
    }
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('ein voller oder schreibgeschuetzter Stick ist kein Serverdefekt', async () => {
  const stick = tempHome('stick-status');
  const src = tempHome('stick-src28');
  try {
    makeSource(src.home);
    const eng = createStick({ freeBytes: () => 4096 });
    await assert.rejects(
      () => eng.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false }),
      (err) => {
        assert.equal(err.status, 507, 'kein Platz ist 507, nicht 500');
        assert.equal(err.code, 'STICK_FULL');
        // Wer bisher auf StorageError geprueft hat, verliert nichts.
        assert.ok(err instanceof StorageError);
        return true;
      },
    );

    const gesperrt = readOnlyDir();
    if (gesperrt) {
      const tool = createStick({ freeBytes: () => 1e12 });
      await assert.rejects(
        () => tool.prepare(gesperrt, { sourceRoot: src.home, includeRuntimes: false }),
        (err) => {
          assert.equal(err.status, 403, 'Schreibschutz ist ein fehlendes Recht, kein Defekt');
          assert.equal(err.code, 'PERMISSION_DENIED');
          assert.match(err.message, /schreiben/);
          return true;
        },
      );
    }
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('der Fortschritt traegt Prozent, Plattform und mehr als nur die Schlussmeldung', async () => {
  const stick = tempHome('stick-fortschritt');
  const src = tempHome('stick-src29');
  try {
    makeSource(src.home, { withJunk: false });
    const events = [];
    const tool = createStick({});
    await tool.prepare(stick.home, {
      sourceRoot: src.home,
      includeRuntimes: true,
      onProgress(evt) { events.push(evt); },
    });

    const kopie = events.filter((e) => e.label === 'source');
    // Vorher gab es bei weniger als 25 Dateien ueberhaupt nur die Schlussmeldung.
    assert.ok(kopie.length >= 2, `zu wenige Meldungen fuer einen Balken: ${kopie.length}`);
    assert.equal(kopie[0].copied, 1, 'die erste Datei meldet sich sofort');
    for (const evt of kopie) {
      assert.equal(typeof evt.percent, 'number');
      assert.ok(evt.percent >= 0 && evt.percent <= 100, `Prozent ausserhalb 0..100: ${evt.percent}`);
      assert.ok(evt.total > 0 && evt.copied <= evt.total);
      assert.equal(typeof evt.totalBytes, 'number');
    }
    assert.equal(kopie[kopie.length - 1].percent, 100);
    let letzte = -1;
    for (const evt of kopie) {
      assert.ok(evt.percent >= letzte, 'der Balken darf nicht zurueckspringen');
      letzte = evt.percent;
    }

    // Die lokale Laufzeit meldete ihre Plattform bisher nicht -- eine Anzeige
    // haette dort ein leeres Feld gezeigt, wo bei addRuntime der Name steht.
    const laufzeit = events.filter((e) => e.phase === 'runtime');
    assert.ok(laufzeit.length > 0);
    if (LOCAL_PLATFORM) {
      assert.ok(laufzeit.some((e) => e.platform === LOCAL_PLATFORM),
        `keine Laufzeitmeldung mit platform: ${JSON.stringify(laufzeit)}`);
    }
    const fertig = events.find((e) => e.phase === 'done');
    assert.equal(fertig.percent, 100);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

/* ==================================================================== */
/* Die Vorschau -- und die Tuer, durch die ein Mensch geht               */
/* ==================================================================== */

test('die Vorschau sagt, was passieren wuerde, und schreibt dabei nichts', async () => {
  const stick = tempHome('stick-preview');
  const src = tempHome('stick-src-preview');
  try {
    makeSource(src.home);
    const tool = createStick({});

    const vorher = snapshotDir(stick.home);
    const mtime = fs.statSync(stick.home).mtimeMs;
    const v = tool.preview(stick.home, { action: 'prepare', sourceRoot: src.home, includeRuntimes: false });

    assert.equal(v.action, 'prepare');
    assert.equal(v.isStick, false);
    assert.ok(v.source.files > 0, 'die Vorschau nennt keine Dateizahl');
    assert.equal(v.source.bytes > 0, true);
    assert.deepEqual(v.blockers, [], 'auf einem leeren, beschreibbaren Ordner spricht nichts dagegen');
    // Der eigentliche Punkt: eine Vorschau, die etwas anlegt, ist keine.
    assert.deepEqual(snapshotDir(stick.home), vorher, 'die Vorschau hat etwas geschrieben');
    assert.equal(fs.statSync(stick.home).mtimeMs, mtime, 'der Zielordner wurde angefasst');
    assert.equal(v.filesystem.probed, false, 'die Vorschau hat eine Sonde gelegt');

    // Und auf einem Pfad, den es noch gar nicht gibt, antwortet sie trotzdem.
    const nochNicht = tool.preview(path.join(stick.home, 'gibt', 'es', 'nicht'), {
      action: 'prepare', sourceRoot: src.home, includeRuntimes: false,
    });
    assert.equal(nochNicht.exists, false);
    assert.ok(Number.isFinite(nochNicht.space.free), 'ohne Zielordner keine Platzangabe');
    assert.equal(fs.existsSync(path.join(stick.home, 'gibt')), false, 'die Vorschau hat den Ordner angelegt');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('Vorschau und Vorgang rechnen mit derselben Formel', async () => {
  const stick = tempHome('stick-formel');
  const src = tempHome('stick-src-formel');
  try {
    makeSource(src.home);
    // Derselbe kuenstlich enge Stick, mit dem prepare() weiter oben abbricht.
    const eng = createStick({ freeBytes: () => 4096 });
    const v = eng.preview(stick.home, { action: 'prepare', sourceRoot: src.home, includeRuntimes: false });

    assert.equal(v.space.fits, false);
    const voll = v.blockers.find((b) => b.code === 'STICK_FULL');
    assert.ok(voll, `kein Hindernis "voll": ${JSON.stringify(v.blockers)}`);
    assert.equal(voll.status, 507);

    // Wortgleich: wuerde die Vorschau anders formulieren als der Vorgang,
    // haette der Benutzer zwei verschiedene Wahrheiten vor sich.
    let gefangen = null;
    await eng.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false }).catch((err) => { gefangen = err; });
    assert.ok(gefangen, 'prepare haette ablehnen muessen');
    assert.equal(gefangen.code, 'STICK_FULL');
    assert.equal(gefangen.message, voll.message,
      'Vorschau und Vorgang sagen nicht dasselbe');
    assert.deepEqual(fs.readdirSync(stick.home), [], 'trotz Absage wurde etwas geschrieben');
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('die Vorschau meldet einen laufenden Vorgang, statt ihn zu uebersehen', async () => {
  const stick = tempHome('stick-preview-busy');
  const src = tempHome('stick-src-preview-busy');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    let gesehen = null;
    const lauf = tool.update(stick.home, {
      sourceRoot: src.home,
      onProgress: (p) => {
        if (p.phase === 'source' && !gesehen) {
          gesehen = tool.preview(stick.home, { action: 'update', sourceRoot: src.home });
        }
      },
    });
    await lauf;

    assert.ok(gesehen, 'waehrend des Laufs kam keine Vorschau zustande');
    assert.ok(gesehen.running, 'der laufende Vorgang fehlt in der Vorschau');
    const busy = gesehen.blockers.find((b) => b.code === 'STICK_BUSY');
    assert.ok(busy, `kein Hindernis "laeuft schon": ${JSON.stringify(gesehen.blockers)}`);
    assert.equal(busy.status, 409);

    // Danach ist die Wurzel wieder frei.
    const danach = tool.preview(stick.home, { action: 'update', sourceRoot: src.home });
    assert.equal(danach.running, null);
    assert.deepEqual(danach.blockers, []);
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

/* ------------------------------------------------------------- HTTP */

/**
 * Warum diese Tests ueber einen echten Server laufen
 * --------------------------------------------------
 * Der Befund, der diesen Bereich ausgeloest hat, war nicht "die Funktion ist
 * kaputt" -- sie war tadellos und vollstaendig getestet. Der Befund war: sie
 * hat keine Tuer. 1792 Zeilen Stick-Werkzeug, null Routen, null Treffer fuer
 * "Stick" in web/**. Ein Test, der `createStick()` direkt aufruft, kann das
 * per Bauart nicht bemerken. Deshalb hier: echter Server, echte Anfragen.
 */
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
        // Ereignisse eines SSE-Stroms, falls es einer war.
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

async function withStickServer(fn) {
  const { createServer } = require('../src/http/server');
  const vault = tempHome('stick-http-home');
  const src = tempHome('stick-http-src');
  const ziel = tempHome('stick-http-ziel');
  makeSource(src.home);

  const appPaths = paths.ensureLayout(paths.layout(path.join(vault.home, 'tresor')));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  const bus = new Bus();
  const { openStore } = require('../src/store/engine');
  const silent = () => ({ error() {}, warn() {}, info() {}, debug() {} });
  const store = await openStore({ paths: appPaths, bus, logger: silent });
  // Ein Datenbestand, der wirklich etwas enthaelt: sonst kopiert
  // includeVault null Dateien, und "prepare ueberschreibt nie Daten" liesse
  // sich gar nicht ausloesen -- der Test wuerde gruen sein, ohne etwas zu zeigen.
  store.create('note', { title: 'Auf dem Stick', body: 'Diese Notiz soll mitreisen.' });
  fs.writeFileSync(path.join(appPaths.home, 'config.json'), JSON.stringify(configMod.defaults(), null, 2));
  const stick = createStick({ paths: appPaths, config, logger: silent });

  const server = await createServer({
    version: 'test', config, paths: appPaths, store, bus, stick, logger: silent, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const req = (method, urlPath, body) => httpRequest(base, method, urlPath, body);

  try {
    await fn({ req, stick, ziel: ziel.home, quelle: src.home, appPaths });
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    vault.cleanup();
    src.cleanup();
    ziel.cleanup();
  }
}

test('der Stick ist ueber HTTP erreichbar, und die Selbstauskunft sagt die Wahrheit', async () => {
  await withStickServer(async ({ req, ziel, appPaths }) => {
    const selbst = await req('GET', '/api/stick');
    assert.equal(selbst.status, 200, selbst.text);
    assert.equal(selbst.json.portabel, false, 'ein Server aus einem Tresorordner laeuft nicht portabel');
    assert.equal(selbst.json.von, null);
    assert.equal(selbst.json.datenOrdner, appPaths.home);
    // Ein Sprachmodell reist nicht mehr mit -- die KI ist Claude. Die
    // Selbstauskunft spricht deshalb auch nicht mehr davon.
    assert.equal('modell' in selbst.json, false);
    assert.ok(selbst.json.bekanntePlattformen.includes('win-x64'));
    // Ohne Netzschleuse darf "Stick vorbereiten" nicht behaupten, es komme
    // an nodejs.org heran.
    assert.equal(selbst.json.andereSysteme.erlaubt, false);
    assert.ok(selbst.json.andereSysteme.plattformen.every((p) => p !== LOCAL_PLATFORM));

    const modelle = await req('GET', '/api/stick/models');
    assert.equal(modelle.status, 404, 'die Modell-Routen gibt es nicht mehr');

    const status = await req('GET', '/api/status');
    assert.equal(status.status, 200, status.text);
    assert.ok('portable' in status.json, 'der Browser kann nicht erfahren, ob er von einem Stick laeuft');
    assert.equal(status.json.portable, null);
    assert.equal(status.json.subsystems.stick, true);

    // Ohne Pfad: ein ganzer Satz, kein "path required".
    const ohne = await req('GET', '/api/stick/preview');
    assert.equal(ohne.status, 400, ohne.text);
    assert.match(ohne.json.error.message, /Ort des Sticks/);
    assert.match(ohne.json.error.message, /getippt/);

    const vorschau = await req('GET', `/api/stick/preview?path=${encodeURIComponent(ziel)}`);
    assert.equal(vorschau.status, 200, vorschau.text);
    assert.equal(vorschau.json.blockers.length, 0);
    assert.deepEqual(fs.readdirSync(ziel), [], 'die Vorschau hat etwas angelegt');
  });
});

test('ein langer Vorgang kommt als Ereignisstrom, und die Absage kommt davor', async () => {
  await withStickServer(async ({ req, ziel }) => {
    const lauf = await req('POST', '/api/stick/prepare', { path: ziel });
    assert.equal(lauf.status, 200, lauf.text);
    const arten = lauf.events.map((e) => e.event);
    assert.ok(arten.includes('start'), `kein Anfang gemeldet: ${arten.join(',')}`);
    assert.ok(arten.includes('fertig'), `kein Abschluss gemeldet: ${arten.join(',')}`);
    assert.ok(!arten.includes('fehler'), `Fehler im Strom: ${lauf.text.slice(0, 300)}`);
    const prozente = lauf.events
      .filter((e) => e.event === 'fortschritt')
      .map((e) => e.data && e.data.percent)
      .filter((v) => Number.isFinite(v));
    assert.ok(prozente.length >= 2, `zu wenige Prozentmeldungen fuer einen Balken: ${prozente.length}`);
    assert.equal(prozente[prozente.length - 1], 100);
    assert.ok(fs.existsSync(path.join(ziel, 'Inhalt', 'neural-os.portable')), 'Marker fehlt');
    assert.ok(fs.existsSync(path.join(ziel, 'Inhalt', 'app', 'bin', 'neural-os.js')), 'Programm fehlt');

    // Die Pruefung haengt hinter einem GET und darf deshalb nichts schreiben.
    const vorherMtime = fs.statSync(ziel).mtimeMs;
    const pruefung = await req('GET', `/api/stick/verify?path=${encodeURIComponent(ziel)}`);
    assert.equal(pruefung.status, 200, pruefung.text);
    assert.deepEqual(nurFehlt(pruefung.json.problems), [], JSON.stringify(pruefung.json.problems));
    assert.equal(pruefung.json.filesystem.probed, false);
    assert.equal(pruefung.json.aufbau, 'inhalt');
    assert.equal(fs.statSync(ziel).mtimeMs, vorherMtime);

    // Und jetzt der Punkt: was vorher entscheidbar ist, wird VOR dem ersten
    // Byte entschieden -- als Statuscode, nicht als halber Ereignisstrom.
    // Auf dem Stick wohnt seit eben eine KI; ein zweites [Neue KI] ist 409.
    const nochmal = await req('POST', '/api/stick/prepare', { path: ziel, ki: 'neu' });
    assert.equal(nochmal.status, 409, nochmal.text);
    assert.equal(nochmal.json.error.code, 'KI_VORHANDEN');
    assert.equal(nochmal.json.error.message, 'Auf diesem Stick wohnt schon eine KI.');
    assert.equal(nochmal.events.length, 0, 'es wurde doch ein Ereignisstrom geoeffnet');
    // Die Rohkopie gibt es nicht mehr: 400 mit dem Satz aus Bauplan 2.10.3.
    const roh = await req('POST', '/api/stick/prepare', { path: ziel, includeVault: true });
    assert.equal(roh.status, 400, roh.text);
    assert.equal(roh.json.error.message, 'Gibt es nicht mehr. Stattdessen: Mit dieser KI gekoppelt.');
    assert.equal(roh.events.length, 0);
  });
});

test('zwei Anfragen auf denselben Stick ergeben 409, nicht zwei halbe Sticks', async () => {
  await withStickServer(async ({ req, ziel }) => {
    const erst = await req('POST', '/api/stick/prepare', { path: ziel });
    assert.equal(erst.status, 200, erst.text);

    const beide = await Promise.all([
      req('POST', '/api/stick/update', { path: ziel }),
      req('POST', '/api/stick/update', { path: ziel }),
    ]);
    const stroeme = beide.filter((r) => r.events.length > 0);
    const abgelehnt = beide.filter((r) => r.status === 409);
    assert.equal(stroeme.length, 1, `es liefen ${stroeme.length} Vorgaenge gleichzeitig`);
    assert.equal(abgelehnt.length, 1, `Statuscodes: ${beide.map((r) => r.status).join(',')}`);
    assert.equal(abgelehnt[0].json.error.code, 'STICK_BUSY');
    assert.match(abgelehnt[0].json.error.message, /laeuft bereits/);

    // Der Stick hat es unbeschadet ueberstanden -- genau das schuetzt die Sperre.
    const danach = await req('GET', `/api/stick/verify?path=${encodeURIComponent(ziel)}`);
    assert.deepEqual(nurFehlt(danach.json.problems), [], JSON.stringify(danach.json.problems));
  });
});

test('ohne Stick-Werkzeug sagt die Route das, statt so zu tun als ob', async () => {
  const { createServer } = require('../src/http/server');
  const vault = tempHome('stick-http-ohne');
  const appPaths = paths.ensureLayout(paths.layout(path.join(vault.home, 'tresor')));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  const bus = new Bus();
  const { openStore } = require('../src/store/engine');
  const silent = () => ({ error() {}, warn() {}, info() {}, debug() {} });
  const store = await openStore({ paths: appPaths, bus, logger: silent });
  const server = await createServer({
    version: 'test', config, paths: appPaths, store, bus, stick: null, logger: silent, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const r = await httpRequest(base, 'GET', '/api/stick');
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.error.code, 'SUBSYSTEM_UNAVAILABLE');
    assert.match(r.json.error.message, /Stick-Werkzeug/);
    const status = await httpRequest(base, 'GET', '/api/status');
    assert.equal(status.json.subsystems.stick, false, 'ein fehlendes Teilsystem wird verschwiegen');
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    vault.cleanup();
  }
});

/* ------------------------------------------------ ein Klick: einrichten */

/** Laufzeit-Archive fuer die Plattformen, die ein fremder Rechner braucht. */
function laufzeitArchive(plattformen) {
  const version = process.version;
  const base = `https://nodejs.org/dist/${version}`;
  const routes = {};
  const sums = [];
  const binaries = {};
  for (const platform of plattformen) {
    const zip = platform.startsWith('win');
    const filename = `node-${version}-${platform}.${zip ? 'zip' : 'tar.gz'}`;
    const binary = Buffer.from(`#!/fake/node ${platform}\n`.padEnd(4000, 'x'), 'utf8');
    const archive = zip
      ? makeZip([{ name: `node-${version}-${platform}/node.exe`, data: binary }])
      : makeTarGz([{ name: `node-${version}-${platform}/bin/node`, data: binary }]);
    routes[`${base}/${filename}`] = archive;
    sums.push(`${crypto.createHash('sha256').update(archive).digest('hex')}  ${filename}`);
    binaries[platform] = binary;
  }
  routes[`${base}/SHASUMS256.txt`] = `${sums.join('\n')}\n`;
  return { routes, binaries };
}

test('einrichten: ein leerer Stick bekommt Programm, Laufzeiten und das Wissen', async () => {
  const stick = tempHome('stick-ein1');
  const src = tempHome('stick-ein1-src');
  const home = tempHome('stick-ein1-home');
  try {
    makeSource(src.home);
    fs.writeFileSync(path.join(home.home, 'notiz.txt'), 'mein Wissen');
    const andere = ['win-x64', 'darwin-arm64'].filter((p) => p !== LOCAL_PLATFORM);
    const { routes, binaries } = laufzeitArchive(andere);
    const gate = fakeGate(routes);
    const tool = createStick({ gate });

    const plan = tool.einrichtenPlan(stick.home, { plattformen: andere });
    assert.equal(plan.fall, 'neu');
    assert.deepEqual(plan.andere, andere);
    assert.deepEqual(fs.readdirSync(stick.home), [], 'der Plan hat etwas geschrieben');

    const prozente = [];
    const saetze = [];
    const r = await tool.einrichten(stick.home, {
      sourceRoot: src.home, plattformen: andere,
      onProgress: (e) => { prozente.push(e.percent); saetze.push(e.message); },
    });
    assert.equal(r.fall, 'neu');
    // Kein Wissen reist mit (die Rohkopie ist weg): der Stick bekommt eine eigene KI.
    assert.equal(r.wissen, 'neu');
    assert.match(r.ki.id, /^dev_[0-9a-f]{24}$/);
    assert.deepEqual(r.fehlend, []);
    assert.deepEqual(fs.readdirSync(path.join(stick.home, 'Inhalt', 'data')), ['config.json'], 'nur die Identitaet liegt in data/');
    for (const p of andere) {
      const spec = require('../src/portable/stick').PLATFORMS[p];
      assert.ok(fs.readFileSync(path.join(stick.home, 'Inhalt', 'runtime', p, spec.file)).equals(binaries[p]), `${p} fehlt`);
      assert.ok(r.laufzeiten.includes(p));
    }
    assert.ok(r.laufzeiten.includes(LOCAL_PLATFORM), 'die Laufzeit dieses Rechners fehlt');

    // Ein Balken: nie rueckwaerts, endet bei 100, und kein Satz traegt eine
    // zweite Prozentzahl neben der des Balkens.
    for (let i = 1; i < prozente.length; i++) assert.ok(prozente[i] >= prozente[i - 1], `rueckwaerts: ${prozente.join(',')}`);
    assert.equal(prozente[prozente.length - 1], 100);
    assert.ok(prozente.filter((p) => p > 0 && p < 100).length >= 3, `zu wenige Zwischenstaende: ${prozente.join(',')}`);
    assert.ok(saetze.every((m) => !/\d+ %/.test(String(m))), `Prozent im Satz: ${saetze.find((m) => /\d+ %/.test(String(m)))}`);

    // Die LIESMICH redet nicht von einem Modell -- sie hat nur die fuenf Zeilen.
    const liesmich = fs.readFileSync(path.join(stick.home, 'LIESMICH.txt'), 'utf8');
    assert.ok(!/Sprachmodell|Ollama|models/i.test(liesmich), 'die LIESMICH spricht noch vom Modell');
    assert.equal(liesmich.trim().split(/\r?\n/).length, 5);
    assert.equal(fs.existsSync(path.join(stick.home, 'Inhalt', 'models')), false, 'ein models/-Ordner wird nicht mehr angelegt');
  } finally {
    stick.cleanup();
    src.cleanup();
    home.cleanup();
  }
});

test('einrichten: liegt schon Wissen auf dem Stick, bleibt es unberuehrt', async () => {
  const stick = tempHome('stick-ein2');
  const src = tempHome('stick-ein2-src');
  const home = tempHome('stick-ein2-home');
  try {
    makeSource(src.home);
    fs.writeFileSync(path.join(home.home, 'notiz.txt'), 'vom Laptop');
    const tool = createStick({});
    const erst = await tool.einrichten(stick.home, { sourceRoot: src.home, andereSysteme: false });
    // Auf einem anderen Rechner weitergeschrieben:
    fs.writeFileSync(path.join(stick.home, 'Inhalt', 'data', 'notiz.txt'), 'auf dem fremden Rechner geaendert');
    const vorher = snapshotDir(path.join(stick.home, 'Inhalt', 'data'));
    fs.writeFileSync(path.join(src.home, 'src', 'neu.js'), '// neu\n');

    assert.equal(tool.einrichtenPlan(stick.home, {}).fall, 'erneuern');
    const r = await tool.einrichten(stick.home, { sourceRoot: src.home, andereSysteme: false });
    assert.equal(r.fall, 'erneuern');
    assert.equal(r.wissen, 'blieb');
    assert.equal(r.ki.id, erst.ki.id, 'die KI auf dem Stick bleibt dieselbe');
    assert.deepEqual(snapshotDir(path.join(stick.home, 'Inhalt', 'data')), vorher, 'das Wissen auf dem Stick wurde angefasst');
    assert.ok(fs.existsSync(path.join(stick.home, 'Inhalt', 'app', 'src', 'neu.js')), 'das Programm wurde nicht erneuert');
  } finally {
    stick.cleanup();
    src.cleanup();
    home.cleanup();
  }
});

test('einrichten: ohne Netz ist der Stick trotzdem fertig und sagt, was fehlt', async () => {
  const stick = tempHome('stick-ein3');
  const src = tempHome('stick-ein3-src');
  try {
    makeSource(src.home);
    const tool = createStick({}); // keine Schleuse
    const r = await tool.einrichten(stick.home, { sourceRoot: src.home, plattformen: ['win-x64', 'darwin-x64'] });
    const erwartet = ['win-x64', 'darwin-x64'].filter((p) => p !== LOCAL_PLATFORM);
    assert.deepEqual(r.fehlend.map((f) => f.platform), erwartet);
    assert.ok(r.fehlend.every((f) => f.grund && f.grund.length > 20), 'ein fehlender Grund ist keine Auskunft');
    // Die Ansicht zeigt nur den einen Satz (1.8), der Grund bleibt fuers Protokoll.
    assert.ok(r.fehlend.every((f) => f.satz === 'Ohne Internet geht das nicht.'), JSON.stringify(r.fehlend));
    const pruefung = await tool.verify(stick.home);
    // Fertig heisst: kein anderer Fehler; was fehlt, sagt verify als FEHLT_*.
    assert.deepEqual(nurFehlt(pruefung.problems), [], JSON.stringify(pruefung.problems));
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('einrichten: der eigene Stick bekommt nur fehlende Laufzeiten, das Programm bleibt', async () => {
  const stick = tempHome('stick-ein4');
  const src = tempHome('stick-ein4-src');
  try {
    makeSource(src.home);
    const tool = createStick({});
    await tool.einrichten(stick.home, { sourceRoot: src.home, andereSysteme: false });
    const app = snapshotDir(path.join(stick.home, 'Inhalt', 'app'));
    const andere = ['darwin-arm64'].filter((p) => p !== LOCAL_PLATFORM);
    const { routes } = laufzeitArchive(andere);
    const mitSchleuse = createStick({ gate: fakeGate(routes) });
    const r = await mitSchleuse.einrichten(stick.home, { eigenerStick: stick.home, plattformen: andere });
    assert.equal(r.fall, 'eigener');
    assert.deepEqual(snapshotDir(path.join(stick.home, 'Inhalt', 'app')), app, 'das laufende Programm wurde ueberschrieben');
    for (const p of andere) assert.ok(r.laufzeiten.includes(p));
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

test('einrichten: bricht es waehrend der Laufzeiten ab, wohnt noch keine KI auf dem Stick, und [Neue KI] faengt von vorn an (Pruefung W2, Befund 1)', async () => {
  const stick = tempHome('stick-abbruch-lz');
  const src = tempHome('stick-abbruch-lz-src');
  try {
    makeSource(src.home);
    const andere = ['win-x64', 'darwin-arm64'].filter((p) => p !== LOCAL_PLATFORM);
    const { routes } = laufzeitArchive(andere);
    const tool = createStick({ gate: fakeGate(routes) });
    const basis = path.join(stick.home, 'Inhalt');

    // Der Tab geht zu, waehrend die erste Laufzeit fuer ein anderes System kommt.
    const controller = new AbortController();
    let beiLaufzeit = null;
    await assert.rejects(
      () => tool.einrichten(stick.home, {
        sourceRoot: src.home,
        plattformen: andere,
        signal: controller.signal,
        onProgress(e) {
          if (!beiLaufzeit && e.phase === 'runtime' && e.platform && e.platform !== LOCAL_PLATFORM) {
            beiLaufzeit = e.message;
            controller.abort();
          }
        },
      }),
      (err) => err.code === 'ABORTED',
    );
    assert.ok(beiLaufzeit, 'Vorbedingung: der Abbruch kam waehrend einer Laufzeit');
    assert.ok(fs.existsSync(path.join(basis, 'app', 'package.json')), 'Vorbedingung: das Programm lag schon auf dem Stick');
    assert.equal(fs.existsSync(path.join(basis, 'neural-os.portable')), false, 'ein Marker auf einem halben Stick');
    assert.equal(fs.existsSync(path.join(basis, 'data', 'config.json')), false, 'auf dem halben Stick wohnt schon eine KI');

    // Die Ansicht zeigt ihn wieder als leeren Stick, und der Klick darauf geht.
    assert.equal(tool.einrichtenPlan(stick.home, { plattformen: andere }).fall, 'neu');
    const vorschau = tool.preview(stick.home, { action: 'prepare', includeRuntimes: andere, sourceRoot: src.home });
    assert.deepEqual(vorschau.blockers.map((b) => b.code), [], JSON.stringify(vorschau.blockers));
    const r = await tool.einrichten(stick.home, { sourceRoot: src.home, plattformen: andere });
    assert.equal(r.fall, 'neu');
    assert.deepEqual(r.fehlend, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(basis, 'neural-os.portable'), 'utf8')).kiId, r.ki.id);
    const konfig = JSON.parse(fs.readFileSync(path.join(basis, 'data', 'config.json'), 'utf8'));
    assert.equal(konfig.sync.deviceId, r.ki.id);

    // Ein Stick, den eine aeltere Fassung halb vorbereitet hat: config.json
    // ohne Marker. Auch dort wohnt noch keine KI -- [Neue KI] ersetzt sie.
    const alt = tempHome('stick-abbruch-lz-alt');
    try {
      fs.mkdirSync(path.join(alt.home, 'Inhalt', 'data'), { recursive: true });
      fs.writeFileSync(path.join(alt.home, 'Inhalt', 'data', 'config.json'), JSON.stringify({ sync: { deviceId: 'dev_000000000000000000000000' } }));
      assert.equal(tool.einrichtenPlan(alt.home, { andereSysteme: false }).fall, 'neu');
      const v = tool.preview(alt.home, { action: 'prepare', includeRuntimes: [], sourceRoot: src.home });
      assert.ok(!v.blockers.some((b) => b.code === 'KI_VORHANDEN'), JSON.stringify(v.blockers));
      const neu = await tool.einrichten(alt.home, { sourceRoot: src.home, andereSysteme: false });
      assert.equal(neu.fall, 'neu');
      const k2 = JSON.parse(fs.readFileSync(path.join(alt.home, 'Inhalt', 'data', 'config.json'), 'utf8'));
      assert.equal(k2.sync.deviceId, neu.ki.id, 'die halbe Identitaet blieb stehen');
      // Wohnt dagegen mehr als die Identitaet dort, bleibt es beim Satz.
      fs.writeFileSync(path.join(alt.home, 'Inhalt', 'data', 'notiz.txt'), 'Wissen');
      fs.rmSync(path.join(alt.home, 'Inhalt', 'neural-os.portable'));
      await assert.rejects(
        () => tool.einrichten(alt.home, { sourceRoot: src.home, andereSysteme: false }),
        (err) => err.code === 'KI_VORHANDEN',
      );
    } finally {
      alt.cleanup();
    }
  } finally {
    stick.cleanup();
    src.cleanup();
  }
});

/* ------------------------------------------ Laufwerke finden, auswerfen */

test('findeLaufwerke findet eingehaengte Sticks und sagt ehrlich, wenn keiner da ist', async () => {
  const stickMod = require('../src/portable/stick');
  const medien = tempHome('medien');
  try {
    const leer = await stickMod.findeLaufwerke({ platform: 'linux', wurzeln: [medien.home], einhaengepunkt: () => true });
    assert.deepEqual(leer.laufwerke, []);
    assert.deepEqual(leer.gesucht, [medien.home]);

    // /media/<benutzer>/<stick>: der Benutzerordner ist kein Einhaengepunkt.
    const benutzer = path.join(medien.home, 'anna');
    const a = path.join(benutzer, 'USB-STICK');
    const b = path.join(benutzer, 'NEURAL');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(b, 'neural-os.portable'), JSON.stringify({ neuralOsPortable: true, dataDir: 'data' }));
    const punkte = new Set([a, b]);
    const r = await stickMod.findeLaufwerke({
      platform: 'linux', wurzeln: [medien.home], einhaengepunkt: (d) => punkte.has(d), eigenerStick: null,
    });
    assert.deepEqual(r.laufwerke.map((l) => l.pfad), [b, a], 'ein Neural-OS-Stick gehoert nach vorn');
    assert.equal(r.laufwerke[0].istStick, true);
    assert.equal(r.laufwerke[1].istStick, false);
    assert.ok(Number.isFinite(r.laufwerke[0].frei));

    // Der Stick, von dem diese Instanz laeuft, rutscht ans Ende.
    const eigen = await stickMod.findeLaufwerke({
      platform: 'linux', wurzeln: [medien.home], einhaengepunkt: (d) => punkte.has(d), eigenerStick: b,
    });
    assert.equal(eigen.laufwerke[eigen.laufwerke.length - 1].pfad, b);
    assert.equal(eigen.laufwerke[eigen.laufwerke.length - 1].eigener, true);

    // Windows: ein Netz- oder CD-Laufwerk wird nicht einmal befragt.
    const win = await stickMod.findeLaufwerke({
      platform: 'win32',
      buchstaben: ['D', 'E', 'Z'],
      klassifiziere: async () => new Map([['D:', { art: 'cd', name: '' }], ['Z:', { art: 'netz', name: 'Schule' }]]),
    });
    assert.deepEqual(win.laufwerke, []);
    assert.deepEqual(win.gesucht, ['D: bis Z:']);
  } finally {
    medien.cleanup();
  }
});

test('auswerfen: Windows ueber die Shell, nie das Systemlaufwerk, sonst ehrlich', async () => {
  const stickMod = require('../src/portable/stick');
  const aufrufe = [];
  const ps = async (skript) => { aufrufe.push(skript); return { code: 0, stdout: '', stderr: '', error: null }; };
  const ok = await stickMod.auswerfen('E:\\', { platform: 'win32', ps });
  assert.equal(ok.ausgeworfen, true);
  assert.match(aufrufe[0], /Shell\.Application/);
  assert.match(aufrufe[0], /Namespace\(17\)\.ParseName\(\$ziel\)/);
  assert.match(aufrufe[0], /\$ziel = 'E:'/);
  assert.match(aufrufe[0], /Test-Path/, 'ob es geklappt hat, sagt erst der verschwundene Buchstabe');

  const belegt = await stickMod.auswerfen('F:\\', { platform: 'win32', ps: async () => ({ code: 2, stdout: '', stderr: '', error: null }) });
  assert.equal(belegt.ausgeworfen, false);
  assert.match(belegt.grund, /nicht freigegeben/);

  const ohne = await stickMod.auswerfen('F:\\', { platform: 'win32', ps: async () => ({ code: null, stdout: '', stderr: '', error: 'ENOENT' }) });
  assert.equal(ohne.ausgeworfen, false);
  assert.match(ohne.grund, /PowerShell/);

  const vorher = process.env.SystemDrive;
  process.env.SystemDrive = 'C:';
  try {
    let gerufen = false;
    const system = await stickMod.auswerfen('C:\\Users\\anna', { platform: 'win32', ps: async () => { gerufen = true; return { code: 0 }; } });
    assert.equal(system.ausgeworfen, false);
    assert.equal(gerufen, false, 'das Systemlaufwerk wurde auszuwerfen versucht');
  } finally {
    if (vorher === undefined) delete process.env.SystemDrive; else process.env.SystemDrive = vorher;
  }

  const mac = [];
  const r = await stickMod.auswerfen('/Volumes/STICK', { platform: 'darwin', run: async (cmd, args) => { mac.push([cmd, ...args]); return { code: 0 }; } });
  assert.equal(r.ausgeworfen, true);
  assert.deepEqual(mac[0], ['diskutil', 'eject', '/Volumes/STICK']);

  const lin = [];
  const l = await stickMod.auswerfen('/media/anna/STICK', { platform: 'linux', run: async (cmd) => { lin.push(cmd); return { code: 0 }; } });
  assert.equal(l.ausgeworfen, null, 'unter Linux wird nichts ausgeworfen -- und das wird nicht behauptet');
  assert.deepEqual(lin, ['sync']);
});

/* ------------------------------------------------- die neuen HTTP-Tueren */

/**
 * Eine ganze Anwendung (createApp), weil "Jetzt sichern" die Sicherung und
 * "Beenden" den ganzen Abbau braucht -- nicht nur den Server.
 */
async function withApp(fn, opts = {}) {
  const { createApp, seedIfEmpty } = require('../src/app');
  const home = tempHome('stick-app');
  const { vorher, ...appOpts } = opts;
  if (typeof vorher === 'function') await vorher(home.home);
  const app = await createApp({ home: home.home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, ...appOpts });
  await seedIfEmpty(app);
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const req = (method, urlPath, body) => httpRequest(base, method, urlPath, body);
  try {
    await fn({ app, req, home: home.home });
  } finally {
    await app.close().catch(() => {});
    home.cleanup();
  }
}

test('HTTP: Laufwerke, Plan und ein Klick "Stick vorbereiten" mit einmaliger Erlaubnis', async () => {
  await withApp(async ({ app, req }) => {
    const medien = tempHome('stick-http-medien');
    const ziel = path.join(medien.home, 'USB-STICK');
    fs.mkdirSync(ziel);
    const stickMod = require('../src/portable/stick');
    app.findeLaufwerke = (opts) => stickMod.findeLaufwerke({ ...opts, platform: 'linux', wurzeln: [medien.home], einhaengepunkt: () => true });
    // Kein Test geht ins Netz: das Stick-Werkzeug holt seine Laufzeiten aus
    // einer Tabelle. Die Freigabe dagegen legt die ECHTE Schleuse an.
    const andere = stickMod.ZIEL_PLATTFORMEN.filter((p) => p !== LOCAL_PLATFORM);
    const { routes } = laufzeitArchive(andere);
    app.stick = createStick({ gate: fakeGate(routes), paths: app.paths, config: app.config });
    try {
      const lw = await req('GET', '/api/stick/laufwerke');
      assert.equal(lw.status, 200, lw.text);
      assert.deepEqual(lw.json.laufwerke.map((l) => l.pfad), [ziel]);

      const plan = await req('GET', `/api/stick/plan?path=${encodeURIComponent(ziel)}`);
      assert.equal(plan.status, 200, plan.text);
      assert.equal(plan.json.fall, 'neu');
      assert.equal(plan.json.download.noetig, true);
      assert.equal(plan.json.download.erlaubt, false, 'der Netzmodus ab Werk erlaubt nodejs.org nicht');
      assert.deepEqual(fs.readdirSync(ziel), [], 'der Plan hat etwas geschrieben');

      // "Erlauben": die Schleuse bekommt genau eine, enge Freigabe -- und
      // nach dem Vorgang ist sie zurueckgezogen.
      const lauf = await req('POST', '/api/stick/einrichten', { path: ziel, erlaubnis: true });
      assert.equal(lauf.status, 200, lauf.text);
      const arten = lauf.events.map((e) => e.event);
      assert.ok(arten.includes('fertig'), `kein Abschluss: ${arten.join(',')} ${lauf.text.slice(0, 300)}`);
      const fertig = lauf.events.find((e) => e.event === 'fertig').data;
      assert.equal(fertig.fall, 'neu');
      assert.equal(fertig.wissen, 'neu');
      assert.match(fertig.ki.id, /^dev_[0-9a-f]{24}$/);
      assert.notEqual(fertig.ki.id, app.identitaet.id, 'der neue Stick traegt die Kennung dieser KI (Befund 11)');
      assert.equal(fertig.gekoppelt, null);
      assert.ok(fertig.laufzeiten.includes(LOCAL_PLATFORM));
      for (const p of andere) assert.ok(fertig.laufzeiten.includes(p), `${p} fehlt: ${JSON.stringify(fertig.fehlend)}`);
      assert.deepEqual(fertig.fehlend, []);
      const prozente = lauf.events.filter((e) => e.event === 'fortschritt').map((e) => e.data.percent);
      assert.equal(prozente[prozente.length - 1], 100);
      for (let i = 1; i < prozente.length; i++) assert.ok(prozente[i] >= prozente[i - 1]);
      assert.deepEqual(fs.readdirSync(path.join(ziel, 'Inhalt', 'data')), ['config.json'], 'in data/ liegt mehr als die Identitaet');

      const freigaben = app.store.all ? app.store.all('grant') : app.store.list('grant').items;
      const unsere = freigaben.filter((g) => g.data.scope === stickMod.RUNTIME_SCOPE);
      assert.equal(unsere.length, 1, 'es wurde nicht genau eine Freigabe angelegt');
      assert.deepEqual(unsere[0].data.hosts, ['nodejs.org']);
      assert.equal(unsere[0].data.revoked, true, 'die Freigabe blieb nach dem Vorgang stehen');
      assert.ok(Date.parse(unsere[0].data.expiresAt) - Date.now() <= 31 * 60 * 1000, 'die Freigabe gilt zu lange');

      // Ohne "Erlauben" wird keine Freigabe angelegt.
      const nochmal = await req('POST', '/api/stick/einrichten', { path: ziel, andereSysteme: false });
      assert.equal(nochmal.status, 200, nochmal.text);
      const danach = (app.store.all ? app.store.all('grant') : app.store.list('grant').items)
        .filter((g) => g.data.scope === stickMod.RUNTIME_SCOPE);
      assert.equal(danach.length, 1);
      assert.equal(nochmal.events.find((e) => e.event === 'fertig').data.fall, 'erneuern');

      // [Neue KI] auf den belegten Stick (1.6): der Satz, kein Strom, und die
      // KI auf dem Stick bleibt, wie sie ist. [Erneuern] ist der Aufruf ohne `ki`.
      const belegt = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'neu', andereSysteme: false });
      assert.equal(belegt.status, 409, belegt.text);
      assert.equal(belegt.json.error.code, 'KI_VORHANDEN');
      assert.equal(belegt.json.error.message, 'Auf diesem Stick wohnt schon eine KI.');
      assert.equal(belegt.events.length, 0, 'es wurde doch ein Strom geoeffnet');
      const konfig = JSON.parse(fs.readFileSync(path.join(ziel, 'Inhalt', 'data', 'config.json'), 'utf8'));
      assert.equal(konfig.sync.deviceId, fertig.ki.id, 'die KI auf dem Stick wurde ersetzt');
    } finally {
      medien.cleanup();
    }
  });
});

test('HTTP: "Jetzt sichern" schreibt auf den Stick, sonst in den Sicherungsordner', async () => {
  await withApp(async ({ app, req }) => {
    const stick = tempHome('stick-sichern');
    try {
      const vorher = await req('GET', `/api/stick/sicherung?path=${encodeURIComponent(stick.home)}`);
      assert.equal(vorher.status, 200, vorher.text);
      assert.equal(vorher.json.ziel.art, 'stick');
      assert.equal(vorher.json.letzte, null);

      const r = await req('POST', '/api/stick/sichern', { path: stick.home });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.dir.startsWith(path.join(stick.home, 'Sicherungen')), r.json.dir);
      assert.ok(fs.existsSync(path.join(r.json.dir, 'manifest.json')), 'keine echte Sicherung auf dem Stick');
      const pruefung = await app.backup.verify(r.json.dir);
      assert.equal(pruefung.ok, true, JSON.stringify(pruefung.problems));

      const danach = await req('GET', `/api/stick/sicherung?path=${encodeURIComponent(stick.home)}`);
      assert.equal(danach.json.letzte.dir, r.json.dir);
      assert.equal(danach.json.letzte.art, 'stick');

      // Ohne Stick: der Sicherungsordner dieser Installation.
      const ohne = await req('POST', '/api/stick/sichern', {});
      assert.equal(ohne.status, 200, ohne.text);
      assert.equal(ohne.json.ziel.art, 'ordner');
      assert.ok(ohne.json.dir.startsWith(app.paths.exports));

      // Ein Stick, der nicht (mehr) steckt, wird nicht still durch einen
      // anderen Ort ersetzt.
      const weg = await req('POST', '/api/stick/sichern', { path: path.join(stick.home, 'gibt-es-nicht') });
      assert.equal(weg.status, 404, weg.text);
      assert.match(weg.json.error.message, /finde ich nicht/);
      assert.ok(!/not found/.test(weg.json.error.message));
    } finally {
      stick.cleanup();
    }
  });
});

test('HTTP: "Beenden & abziehen" speichert, antwortet, und schliesst erst danach', async () => {
  await withApp(async ({ app, req }) => {
    const stickMod = require('../src/portable/stick');
    const stick = tempHome('stick-beenden');
    let beendet = 0;
    const ausgeworfen = [];
    app.beenden = () => { beendet++; };
    app.auswerfen = async (root) => { ausgeworfen.push(root); return { ausgeworfen: true, wie: 'test', grund: null }; };
    try {
      // Laeuft gerade ein Vorgang auf irgendeinem Stick: nichts passiert.
      const frei = stickMod.lockRoot(path.join(stick.home, 'anderer'), 'Stick vorbereiten');
      const belegt = await req('POST', '/api/stick/beenden', { path: stick.home });
      frei();
      assert.equal(belegt.status, 409, belegt.text);
      assert.match(belegt.json.error.message, /Warte/);
      await new Promise((r) => { setTimeout(r, 300); });
      assert.equal(beendet, 0, 'trotz laufendem Vorgang beendet');

      const note = app.store.create('note', { title: 'Kurz vor dem Abziehen', body: 'muss auf die Platte' });
      const r = await req('POST', '/api/stick/beenden', { path: stick.home });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.gespeichert, true);
      assert.equal(r.json.vomStick, false);
      assert.equal(r.json.auswurf.ausgeworfen, true);
      assert.deepEqual(ausgeworfen, [path.resolve(stick.home)]);
      await new Promise((res) => { setTimeout(res, 400); });
      assert.equal(beendet, 1, 'nach der Antwort wurde nicht beendet');
      const log = fs.readdirSync(path.join(app.paths.home, 'vault', 'log'))
        .map((f) => fs.readFileSync(path.join(app.paths.home, 'vault', 'log', f), 'utf8')).join('');
      assert.ok(log.includes(note.id), 'die letzte Notiz steht nicht im Protokoll auf der Platte');

      // Das Laufwerk, auf dem das Programm liegt, wird nie ausgeworfen.
      ausgeworfen.length = 0;
      const programm = await req('POST', '/api/stick/beenden', { path: path.parse(__dirname).root });
      assert.equal(programm.status, 200, programm.text);
      assert.equal(programm.json.auswurf, null);
      assert.deepEqual(ausgeworfen, []);
    } finally {
      stick.cleanup();
    }
  });
});


/* -------------------------------- Befund 11: [Mit dieser KI gekoppelt] */

/** Die Kopplung von A aus gesehen und was auf dem neuen Stick liegt -- fuer beide PIN-Faelle gleich. */
function pruefeGekoppelt(app, ziel, fertig) {
  const basis = path.join(ziel, 'Inhalt');
  assert.equal(fertig.fall, 'neu');
  assert.match(fertig.ki.id, /^dev_[0-9a-f]{24}$/);
  // Befund 11: keine geklonte Kennung ...
  assert.notEqual(fertig.ki.id, app.identitaet.id, 'der neue Stick traegt die Kennung dieser KI');
  assert.equal(JSON.parse(fs.readFileSync(path.join(basis, 'neural-os.portable'), 'utf8')).kiId, fertig.ki.id);
  // ... kein Paarschluessel und kein Abgleich-Stand dieser Installation auf dem neuen Stick ...
  const inData = fs.readdirSync(path.join(basis, 'data'));
  assert.ok(!inData.includes('kopplungen.json'), 'kopplungen.json dieser KI liegt auf dem neuen Stick');
  assert.ok(!inData.includes('sync-folder.json'), 'der Abgleich-Stand dieser KI liegt auf dem neuen Stick');
  assert.ok(!inData.includes('vault'), 'der Tresor dieser KI wurde kopiert');
  // ... sondern ein Angebot und das Postfach von A, wie beim Koppeln (K1).
  assert.ok(fs.existsSync(path.join(basis, 'sync', 'koppeln', `${app.identitaet.id}.angebot`)), 'kein Angebot auf dem neuen Stick');
  assert.ok(fs.existsSync(path.join(basis, 'sync', app.identitaet.id, 'manifest.json')), 'A hat sein Postfach nicht auf den neuen Stick gelegt');
  assert.ok(fertig.gekoppelt, 'die Antwort nennt den Partner nicht');
  assert.equal(fertig.gekoppelt.id, fertig.ki.id);
  assert.equal(fertig.gekoppelt.zustand, 'wartet', '"Lena übernimmt beim nächsten Start"');
  const st = app.kopplung.status();
  assert.equal(st.partner.length, 1);
  assert.equal(st.partner[0].id, fertig.ki.id);
  assert.equal(st.partner[0].name, fertig.ki.name);
  return basis;
}

/** Den neuen Stick starten, wie bin/neural-os.js es taete, und die Kopplung annehmen. */
async function starteNeuenStick(basis, { pin } = {}) {
  const { createApp } = require('../src/app');
  return createApp({
    home: path.join(basis, 'data'),
    appDir: path.join(basis, 'app'),
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    harden: false,
    passphrase: pin,
    kopplung: { automatisch: false, einhaengepunkte: () => [] },
  });
}

test('HTTP [Mit dieser KI gekoppelt] ohne PIN: neue Kennung, kein Paarschluessel und kein Abgleich-Stand auf dem neuen Stick (Befund 11); der neue Stick uebernimmt beim ersten Start', async () => {
  await withApp(async ({ app, req }) => {
    const medien = tempHome('stick-gekoppelt');
    const ziel = path.join(medien.home, 'LENA');
    fs.mkdirSync(ziel);
    app.stick = createStick({ paths: app.paths, config: app.config });
    app.identitaet.umbenennen('Max');
    const note = app.store.create('note', { title: 'Nur auf A', body: 'reist per Kopplung' });
    let appB = null;
    try {
      const selbst = await req('GET', '/api/stick');
      assert.equal(selbst.json.pinNoetig, false);
      assert.equal(selbst.json.koppelnMoeglich, true);

      const lauf = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'gekoppelt', andereSysteme: false });
      assert.equal(lauf.status, 200, lauf.text);
      const arten = lauf.events.map((e) => e.event);
      assert.ok(arten.includes('fertig') && !arten.includes('fehler'), lauf.text.slice(0, 600));
      const fertig = lauf.events.find((e) => e.event === 'fertig').data;
      const basis = pruefeGekoppelt(app, ziel, fertig);
      assert.deepEqual(fs.readdirSync(path.join(basis, 'data')).sort(), ['config.json']);
      // Ohne PIN reist das Angebot im Klartext -- es gibt keinen Tresor, der es siegeln koennte.
      const angebot = JSON.parse(fs.readFileSync(path.join(basis, 'sync', 'koppeln', `${app.identitaet.id}.angebot`), 'utf8'));
      assert.equal(angebot.versiegelt, undefined);
      assert.equal(angebot.an, fertig.ki.id);
      assert.equal(angebot.name, 'Max');

      // Ein zweites [Mit dieser KI gekoppelt] auf denselben Stick: dort wohnt schon eine KI.
      const nochmal = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'gekoppelt', andereSysteme: false });
      assert.equal(nochmal.status, 409, nochmal.text);
      assert.equal(nochmal.json.error.code, 'KI_VORHANDEN');
      assert.equal(nochmal.json.error.message, 'Auf diesem Stick wohnt schon eine KI.');

      // Der neue Stick startet zum ersten Mal: er nimmt an, hat die Notiz von A, und ist eine eigene KI.
      appB = await starteNeuenStick(basis);
      assert.equal(appB.identitaet.id, fertig.ki.id, 'der Start hat die Kennung ersetzt (Marker und config.json passen nicht)');
      assert.equal(appB.identitaet.name, fertig.ki.name);
      assert.equal(appB.identitaet.port, JSON.parse(fs.readFileSync(path.join(basis, 'data', 'config.json'), 'utf8')).server.port);
      await appB.kopplung.starten();
      const st = appB.kopplung.status();
      assert.equal(st.partner.length, 1, JSON.stringify(st));
      assert.equal(st.partner[0].id, app.identitaet.id);
      assert.equal(st.partner[0].name, 'Max');
      assert.equal(st.hinweis, 'Gekoppelt mit Max.');
      assert.ok(appB.store.get(note.id), 'die Notiz von A ist nicht auf dem neuen Stick');
      assert.ok(!fs.existsSync(path.join(basis, 'sync', 'koppeln', `${app.identitaet.id}.angebot`)), 'das Angebot muss weg sein');
    } finally {
      if (appB) await appB.close().catch(() => {});
      medien.cleanup();
    }
  }, { kopplung: { automatisch: false, einhaengepunkte: () => [] } });
});

test('HTTP [Mit dieser KI gekoppelt] mit PIN: Feld "PIN für den neuen Stick" ist Pflicht, der neue Stick bekommt einen eigenen Tresor, das Angebot reist versiegelt', async () => {
  const geraete = tempHome('stick-geraete');
  const vorher = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = geraete.home;
  try {
    await withApp(async ({ app, req, home }) => {
      const medien = tempHome('stick-gekoppelt-pin');
      const ziel = path.join(medien.home, 'LENA');
      fs.mkdirSync(ziel);
      app.stick = createStick({ paths: app.paths, config: app.config });
      const note = app.store.create('note', { title: 'Nur auf A', body: 'versiegelt unterwegs' });
      let appB = null;
      try {
        assert.equal(app.vaultCrypto.enabled, true, 'die Probe braucht eine KI mit PIN');
        assert.equal((await req('GET', '/api/stick')).json.pinNoetig, true);
        const plan = await req('GET', `/api/stick/plan?path=${encodeURIComponent(ziel)}`);
        assert.equal(plan.json.pinNoetig, true);
        assert.equal(plan.json.leer, true);

        // Ohne PIN fuer den neuen Stick: Absage vor dem Strom, nichts geschrieben.
        const ohne = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'gekoppelt', andereSysteme: false });
        assert.equal(ohne.status, 400, ohne.text);
        assert.equal(ohne.json.error.message, 'PIN für den neuen Stick');
        assert.deepEqual(fs.readdirSync(ziel), []);

        const lauf = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'gekoppelt', pin: '4321', andereSysteme: false });
        assert.equal(lauf.status, 200, lauf.text);
        const arten = lauf.events.map((e) => e.event);
        assert.ok(arten.includes('fertig') && !arten.includes('fehler'), lauf.text.slice(0, 600));
        const fertig = lauf.events.find((e) => e.event === 'fertig').data;
        const basis = pruefeGekoppelt(app, ziel, fertig);

        // Ein eigener Tresor: nicht der von A (Befund 13), und die config.json weiss davon.
        assert.deepEqual(fs.readdirSync(path.join(basis, 'data')).sort(), ['config.json', 'secrets.json']);
        const meins = JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'));
        const seins = JSON.parse(fs.readFileSync(path.join(basis, 'data', 'secrets.json'), 'utf8'));
        assert.notEqual(seins.wrappedKey, meins.wrappedKey, 'der Schluessel von A wurde kopiert');
        assert.notEqual(seins.salt, meins.salt);
        const konfig = JSON.parse(fs.readFileSync(path.join(basis, 'data', 'config.json'), 'utf8'));
        assert.equal(konfig.security.encryption.enabled, true);
        assert.equal(konfig.sync.deviceId, fertig.ki.id);
        // Das Angebot ist mit der PIN des neuen Sticks versiegelt (K1: mit PIN nur versiegelt).
        const angebot = JSON.parse(fs.readFileSync(path.join(basis, 'sync', 'koppeln', `${app.identitaet.id}.angebot`), 'utf8'));
        assert.equal(typeof angebot.versiegelt, 'string');
        assert.equal(angebot.an, undefined);
        // Und unter sync/ steht nirgends Klartext der Notiz.
        const dateien = [];
        const lies = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) lies(p); else dateien.push(p); } };
        lies(path.join(basis, 'sync'));
        for (const d of dateien) assert.ok(!fs.readFileSync(d).includes('versiegelt unterwegs'), `Klartext in ${d}`);

        // Der neue Stick startet mit seiner PIN und nimmt an.
        appB = await starteNeuenStick(basis, { pin: '4321' });
        assert.equal(appB.identitaet.id, fertig.ki.id);
        assert.equal(appB.vaultCrypto.state, 'unlocked');
        await appB.kopplung.starten();
        const st = appB.kopplung.status();
        assert.equal(st.partner.length, 1, JSON.stringify(st));
        assert.equal(st.partner[0].id, app.identitaet.id);
        assert.equal(st.selbst.pin, true);
        assert.ok(appB.store.get(note.id), 'die Notiz von A ist nicht auf dem neuen Stick');
      } finally {
        if (appB) await appB.close().catch(() => {});
        medien.cleanup();
      }
    }, {
      passphrase: '1234',
      kopplung: { automatisch: false, einhaengepunkte: () => [] },
      vorher: async (home) => {
        const { createVaultCrypto } = require('../src/store/vaultcrypto');
        const vc = createVaultCrypto({ paths: { secrets: path.join(home, 'secrets.json') }, config: {}, geraet: false });
        await vc.initialise('1234');
        vc.lock();
      },
    });
  } finally {
    if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorher;
    geraete.cleanup();
  }
});

test('HTTP: ohne Koppeln-Dienst ist [Mit dieser KI gekoppelt] ein 501 mit einem Satz, und es wird nichts geschrieben', async () => {
  await withApp(async ({ app, req }) => {
    const medien = tempHome('stick-ohne-koppeln');
    const ziel = path.join(medien.home, 'USB');
    fs.mkdirSync(ziel);
    app.stick = createStick({ paths: app.paths, config: app.config });
    app.kopplung = null;
    try {
      assert.equal((await req('GET', '/api/stick')).json.koppelnMoeglich, false);
      for (const route of ['/api/stick/einrichten', '/api/stick/prepare']) {
        const r = await req('POST', route, { path: ziel, ki: 'gekoppelt', andereSysteme: false });
        assert.equal(r.status, 501, r.text);
        assert.equal(r.json.error.message, 'Koppeln gibt es noch nicht.');
        assert.equal(r.events.length, 0);
      }
      assert.deepEqual(fs.readdirSync(ziel), []);
      // Ein unbekanntes ki ist ein 400; [Neue KI] geht weiterhin.
      const falsch = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'kopie' });
      assert.equal(falsch.status, 400, falsch.text);
    } finally {
      medien.cleanup();
    }
  }, { kopplung: { automatisch: false, einhaengepunkte: () => [] } });
});

test('HTTP [Für Mac holen]: POST /api/stick/runtime {platforms} holt beide Macs mit einmaliger Erlaubnis; ohne Netz steht "Ohne Internet geht das nicht." dabei', async () => {
  await withApp(async ({ app, req }) => {
    const medien = tempHome('stick-runtime-http');
    const ziel = path.join(medien.home, 'USB');
    fs.mkdirSync(ziel);
    const stickMod = require('../src/portable/stick');
    const macs = ['darwin-arm64', 'darwin-x64'].filter((p) => p !== LOCAL_PLATFORM);
    const { routes, binaries } = laufzeitArchive(macs);
    try {
      app.stick = createStick({ paths: app.paths, config: app.config });
      const erst = await req('POST', '/api/stick/einrichten', { path: ziel, andereSysteme: false });
      assert.equal(erst.status, 200, erst.text);
      const v = await req('GET', `/api/stick/verify?path=${encodeURIComponent(ziel)}`);
      assert.ok(v.json.problems.some((p) => p.code === 'FEHLT_MAC' && p.fix === 'Für Mac holen'), JSON.stringify(v.json.problems));

      // Ohne Netz: der Stick bleibt, wie er ist, und die Antwort sagt den einen Satz.
      const ohne = await req('POST', '/api/stick/runtime', { path: ziel, platforms: macs });
      assert.equal(ohne.status, 200, ohne.text);
      const f1 = ohne.events.find((e) => e.event === 'fertig').data;
      assert.deepEqual(f1.geholt, []);
      assert.deepEqual(f1.fehlend.map((x) => x.platform), macs);
      assert.ok(f1.fehlend.every((x) => x.satz === 'Ohne Internet geht das nicht.'), JSON.stringify(f1.fehlend));

      // Mit Erlaubnis: nodejs.org (Attrappe), beide Macs, Freigabe danach zurueckgezogen.
      app.stick = createStick({ gate: fakeGate(routes), paths: app.paths, config: app.config });
      const lauf = await req('POST', '/api/stick/runtime', { path: ziel, platforms: macs, erlaubnis: true });
      assert.equal(lauf.status, 200, lauf.text);
      const fertig = lauf.events.find((e) => e.event === 'fertig').data;
      assert.deepEqual(fertig.fehlend, []);
      assert.deepEqual(fertig.geholt.map((x) => x.platform), macs);
      for (const p of macs) {
        assert.ok(fertig.laufzeiten.includes(p));
        assert.ok(fs.readFileSync(path.join(ziel, 'Inhalt', 'runtime', p, stickMod.PLATFORMS[p].file)).equals(binaries[p]));
      }
      const freigaben = (app.store.all ? app.store.all('grant') : app.store.list('grant').items)
        .filter((g) => g.data.scope === stickMod.RUNTIME_SCOPE);
      assert.equal(freigaben.length, 1);
      assert.equal(freigaben[0].data.revoked, true);
      const danach = await req('GET', `/api/stick/verify?path=${encodeURIComponent(ziel)}`);
      assert.ok(!danach.json.problems.some((p) => p.code === 'FEHLT_MAC'), JSON.stringify(danach.json.problems));
      assert.equal(danach.json.startklar.mac, true);
      // Die Einzelform bleibt.
      const einzeln = await req('POST', '/api/stick/runtime', { path: ziel, platform: LOCAL_PLATFORM });
      assert.equal(einzeln.status, 200, einzeln.text);
      assert.equal(einzeln.events.find((e) => e.event === 'fertig').data.geholt[0].platform, LOCAL_PLATFORM);
      const unbekannt = await req('POST', '/api/stick/runtime', { path: ziel, platforms: ['amiga'] });
      assert.equal(unbekannt.status, 400, unbekannt.text);
    } finally {
      medien.cleanup();
    }
  }, { kopplung: { automatisch: false, einhaengepunkte: () => [] } });
});

test('HTTP: GET /api/stick/plan und /laufwerke sagen der Ansicht, was sie fuer die Karte braucht (leer, frei, aelter, Aufbau, KI)', async () => {
  await withApp(async ({ app, req }) => {
    const medien = tempHome('stick-plan-http');
    const ziel = path.join(medien.home, 'USB');
    fs.mkdirSync(ziel);
    const stickMod = require('../src/portable/stick');
    app.findeLaufwerke = (opts) => stickMod.findeLaufwerke({ ...opts, platform: 'linux', wurzeln: [medien.home], einhaengepunkt: () => true });
    app.stick = createStick({ paths: app.paths, config: app.config });
    try {
      const leer = await req('GET', `/api/stick/plan?path=${encodeURIComponent(ziel)}`);
      assert.equal(leer.status, 200, leer.text);
      assert.equal(leer.json.leer, true);
      assert.equal(leer.json.fall, 'neu');
      assert.ok(Number.isFinite(leer.json.frei), 'kein freier Platz fuer "· 14,2 GB frei"');
      assert.equal(leer.json.pinNoetig, false);
      assert.equal(leer.json.koppelnMoeglich, true);
      assert.equal(leer.json.aufbau, 'inhalt');
      let lw = await req('GET', '/api/stick/laufwerke');
      assert.equal(lw.json.laufwerke[0].istStick, false);
      assert.equal(lw.json.laufwerke[0].ki, null);

      const lauf = await req('POST', '/api/stick/einrichten', { path: ziel, andereSysteme: false, name: 'Lena' });
      assert.equal(lauf.status, 200, lauf.text);
      const fertig = lauf.events.find((e) => e.event === 'fertig').data;
      assert.equal(fertig.ki.name, 'Lena');
      fs.writeFileSync(path.join(ziel, 'Inhalt', 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version: '0.0.1' }));

      const plan = await req('GET', `/api/stick/plan?path=${encodeURIComponent(ziel)}`);
      assert.equal(plan.json.leer, false);
      assert.equal(plan.json.fall, 'erneuern');
      assert.equal(plan.json.aelter, true, '"Programm auf dem Stick ist älter." [Erneuern]');
      assert.equal(plan.json.ki.name, 'Lena');
      lw = await req('GET', '/api/stick/laufwerke');
      const l = lw.json.laufwerke.find((x) => x.pfad === ziel);
      assert.equal(l.istStick, true);
      assert.equal(l.aufbau, 'inhalt');
      assert.equal(l.aelter, true);
      assert.equal(l.ki.name, 'Lena');
      // [Erneuern] = POST /api/stick/update.
      const erneuert = await req('POST', '/api/stick/update', { path: ziel });
      assert.equal(erneuert.status, 200, erneuert.text);
      assert.ok(erneuert.events.some((e) => e.event === 'fertig'), erneuert.text.slice(0, 300));
      assert.equal((await req('GET', `/api/stick/plan?path=${encodeURIComponent(ziel)}`)).json.aelter, false);
      // Die Vorschau kennt die Rohkopie nicht mehr.
      const roh = await req('GET', `/api/stick/preview?path=${encodeURIComponent(ziel)}&vault=1`);
      assert.equal(roh.status, 400, roh.text);
    } finally {
      medien.cleanup();
    }
  }, { kopplung: { automatisch: false, einhaengepunkte: () => [] } });
});

test('einrichten vom eigenen Stick: was dort liegt, kommt ohne Netz mit; der Plan fragt nur nach dem Rest', async () => {
  const eigen = tempHome('stick-eigen');
  const ziel = tempHome('stick-eigen-ziel');
  const src = tempHome('stick-eigen-src');
  try {
    makeSource(src.home);
    const { PLATFORMS } = require('../src/portable/stick');
    // Auf dem eigenen Stick liegt eine Laufzeit, die nicht die dieses Rechners ist.
    const dort = ['win-x64', 'darwin-arm64'].find((p) => p !== LOCAL_PLATFORM);
    fs.mkdirSync(path.join(eigen.home, 'runtime', dort), { recursive: true });
    const binaer = Buffer.alloc(2048, 3);
    fs.writeFileSync(path.join(eigen.home, 'runtime', dort, PLATFORMS[dort].file), binaer);
    const gate = fakeGate({});
    const tool = createStick({ gate, portable: { root: eigen.home } });

    const plan = tool.einrichtenPlan(ziel.home, {});
    assert.ok(plan.andere.includes(dort));
    assert.ok(!plan.ausDemNetz.includes(dort), 'was auf dem eigenen Stick liegt, muss nicht ins Netz');
    assert.deepEqual(plan.ausDemNetz, plan.andere.filter((p) => p !== dort));
    assert.equal(plan.pin, false, 'ein leerer Stick hat keine PIN');

    // „Ohne Internet“: nur, was ohne Netz kommt.
    const r = await tool.einrichten(ziel.home, { sourceRoot: src.home, plattformen: [dort] });
    assert.deepEqual(r.fehlend, []);
    assert.ok(r.laufzeiten.includes(dort) && r.laufzeiten.includes(LOCAL_PLATFORM), r.laufzeiten.join(','));
    assert.ok(fs.readFileSync(path.join(ziel.home, 'Inhalt', 'runtime', dort, PLATFORMS[dort].file)).equals(binaer));
    assert.equal(gate.calls.length, 0, 'es ging nichts ins Netz');

    // Hat die KI auf einem Stick eine PIN, sagt es der Plan (für „PIN von …“).
    fs.writeFileSync(path.join(ziel.home, 'Inhalt', 'data', 'secrets.json'), '{}');
    assert.equal(tool.einrichtenPlan(ziel.home, {}).pin, true);
  } finally {
    eigen.cleanup();
    ziel.cleanup();
    src.cleanup();
  }
});

test('HTTP: andereSysteme "ohneNetz" holt nichts aus dem Netz und legt keine Freigabe an; der Plan nennt ausDemNetz', async () => {
  await withApp(async ({ app, req }) => {
    const medien = tempHome('stick-ohnenetz');
    const ziel = path.join(medien.home, 'LEER');
    fs.mkdirSync(ziel);
    const gate = fakeGate({});
    app.stick = createStick({ gate, paths: app.paths, config: app.config });
    try {
      const plan = await req('GET', `/api/stick/plan?path=${encodeURIComponent(ziel)}`);
      assert.equal(plan.status, 200, plan.text);
      assert.deepEqual(plan.json.ausDemNetz, plan.json.andere, 'vom Laptop ohne Zwischenspeicher kommt alles aus dem Netz');
      assert.equal(plan.json.ausDemNetzNamen.length, plan.json.andere.length);
      assert.equal(plan.json.download.noetig, true);
      const freigabenVorher = app.gate.listGrants({ includeInactive: true }).length;
      const lauf = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'neu', andereSysteme: 'ohneNetz', erlaubnis: true });
      assert.equal(lauf.status, 200, lauf.text);
      const fertig = (lauf.events.find((e) => e.event === 'fertig') || {}).data;
      assert.ok(fertig, lauf.text.slice(0, 300));
      assert.deepEqual(fertig.laufzeiten, [LOCAL_PLATFORM]);
      assert.deepEqual(fertig.fehlend, []);
      assert.equal(gate.calls.length, 0, 'es ging nichts ins Netz');
      assert.equal(app.gate.listGrants({ includeInactive: true }).length, freigabenVorher, '"ohneNetz" legt nie eine Freigabe an');
    } finally {
      medien.cleanup();
    }
  }, { kopplung: { automatisch: false, einhaengepunkte: () => [] } });
});

test('HTTP: sagt die Vorschau vor dem Strom ab (Stick voll), ist die Freigabe fuer nodejs.org schon wieder zurueckgezogen (Pruefung W2, Befund 2)', async () => {
  await withApp(async ({ app, req }) => {
    const medien = tempHome('stick-voll-freigabe');
    const ziel = path.join(medien.home, 'VOLL');
    fs.mkdirSync(ziel);
    const stickMod = require('../src/portable/stick');
    const gate = fakeGate({});
    app.stick = createStick({ gate, paths: app.paths, config: app.config, freeBytes: () => 1024 });
    try {
      const aktivVorher = app.gate.listGrants().length;
      const lauf = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'neu', erlaubnis: true });
      assert.equal(lauf.status, 507, lauf.text);
      assert.equal(lauf.json.error.code, 'STICK_FULL');
      assert.equal(lauf.events.length, 0, 'es wurde doch ein Strom geoeffnet');
      assert.deepEqual(fs.readdirSync(ziel), [], 'trotz Absage wurde geschrieben');
      assert.equal(gate.calls.length, 0, 'trotz Absage ging etwas ins Netz');
      // Die Freigabe gab es (sonst prueft der Test nichts) -- und sie ist zu.
      const unsere = app.gate.listGrants({ includeInactive: true }).filter((g) => g.data.scope === stickMod.RUNTIME_SCOPE);
      assert.equal(unsere.length, 1, 'Vorbedingung: "Erlauben" hat eine Freigabe angelegt');
      assert.equal(unsere[0].data.revoked, true, 'die Freigabe blieb nach der Absage 30 Minuten offen');
      assert.equal(app.gate.listGrants().length, aktivVorher);
    } finally {
      medien.cleanup();
    }
  }, { kopplung: { automatisch: false, einhaengepunkte: () => [] } });
});

test('HTTP [Mit dieser KI gekoppelt]: ist diese KI ein Zwilling, kommt der Satz vor dem Vorbereiten, und auf den Stick kommt nichts (Pruefung W2, Befund 3)', async () => {
  const punkte = [];
  await withApp(async ({ app, req }) => {
    const medien = tempHome('stick-zwilling');
    const ziel = path.join(medien.home, 'LEER');
    const kopie = path.join(medien.home, 'KOPIE');
    fs.mkdirSync(ziel);
    // Ein Stick, auf den jemand diese KI samt Marker kopiert hat.
    fs.mkdirSync(path.join(kopie, 'data'), { recursive: true });
    fs.mkdirSync(path.join(kopie, 'app'), { recursive: true });
    fs.writeFileSync(path.join(kopie, 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version: require('../package.json').version }));
    fs.writeFileSync(path.join(kopie, paths.PORTABLE_MARKER), JSON.stringify({
      neuralOsPortable: true, dataDir: 'data', appDir: 'app', kiId: app.identitaet.id, name: app.identitaet.name,
    }));
    punkte.push(kopie);
    app.stick = createStick({ paths: app.paths, config: app.config });
    try {
      const stand = await req('GET', '/api/kopplung?suchen=1');
      assert.equal(stand.status, 200, stand.text);
      assert.equal(stand.json.selbst.zwilling, true, 'Vorbedingung: diese KI sieht sich als Zwilling');

      const lauf = await req('POST', '/api/stick/einrichten', { path: ziel, ki: 'gekoppelt', andereSysteme: false });
      assert.equal(lauf.status, 409, lauf.text);
      assert.equal(lauf.json.error.code, 'KOPPLUNG_ZWILLING');
      assert.equal(lauf.json.error.message, 'Zwei Sticks tragen dieselbe KI.');
      assert.equal(lauf.events.length, 0, 'es wurde doch ein Strom geoeffnet');
      assert.deepEqual(fs.readdirSync(ziel), [], 'der Stick wurde vorbereitet und stuende ungekoppelt da');
      assert.equal(app.kopplung.status().partner.length, 0);
    } finally {
      medien.cleanup();
    }
  }, { kopplung: { automatisch: false, einhaengepunkte: () => [...punkte] } });
});

module.exports = { name: 'stick', tests: drain() };
