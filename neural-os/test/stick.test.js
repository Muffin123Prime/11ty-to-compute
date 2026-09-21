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

/* ------------------------------------------------------------ the tests */

test('prepare legt das vollstaendige Stick-Layout an', async () => {
  const stick = tempHome('stick-layout');
  const src = tempHome('stick-src');
  try {
    makeSource(src.home);
    const tool = createStick({});
    const result = await tool.prepare(stick.home, { sourceRoot: src.home, includeRuntimes: false });

    assert.equal(result.root, path.resolve(stick.home));
    assert.ok(result.files > 0, 'es wurden Dateien kopiert');
    assert.ok(result.bytes > 0);

    for (const rel of [
      'neural-os.portable',
      'LIESMICH.txt',
      'app/bin/neural-os.js',
      'app/src/app.js',
      'app/web/index.html',
      'data',
      'sync',
      'Neural OS starten.bat',
      'Neural OS starten.command',
      'Neural OS starten.sh',
    ]) {
      assert.ok(fs.existsSync(path.join(stick.home, rel)), `${rel} fehlt auf dem Stick`);
    }

    // The batch file needs CRLF, the shell scripts need their shebang.
    const bat = fs.readFileSync(path.join(stick.home, 'Neural OS starten.bat'), 'utf8');
    assert.ok(bat.includes('\r\n'), 'die .bat muss CRLF-Zeilenenden haben');
    assert.ok(bat.includes('chcp 65001'), 'die .bat muss die Konsole auf UTF-8 stellen');
    for (const name of ['Neural OS starten.sh', 'Neural OS starten.command']) {
      const script = fs.readFileSync(path.join(stick.home, name), 'utf8');
      assert.ok(script.startsWith('#!/bin/sh'), `${name} braucht eine Shebang-Zeile`);
      assert.ok(!script.includes('\r\n'), `${name} darf keine CRLF-Zeilenenden haben`);
      assert.ok((fs.statSync(path.join(stick.home, name)).mode & 0o111) !== 0, `${name} muss ausfuehrbar sein`);
    }
    assert.ok(fs.readFileSync(path.join(stick.home, 'Neural OS starten.command'), 'utf8').includes('xattr -d com.apple.quarantine'),
      'der macOS-Starter muss das Quarantaene-Merkmal entfernen');

    const readme = fs.readFileSync(path.join(stick.home, 'LIESMICH.txt'), 'utf8');
    assert.match(readme, /--safe/);
    assert.match(readme, /Verschluesselung/);
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
    const detected = paths.detectPortable(path.join(stick.home, 'app'));
    assert.ok(detected, 'detectPortable() muss den Stick erkennen');
    assert.equal(detected.dataDir, path.resolve(stick.home, 'data'));
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
    assert.equal(check.ok, true, `verify meldet Probleme: ${JSON.stringify(check.problems)}`);
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
    const dataDir = path.join(stick.home, 'data');
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
    const syncDir = path.join(stick.home, 'sync');
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

    assert.match(fs.readFileSync(path.join(stick.home, 'app/src/app.js'), 'utf8'), /neu: true/);
    assert.ok(fs.existsSync(path.join(stick.home, 'app/src/neu.js')), 'neue Quelldateien muessen ankommen');

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
    assert.ok(fs.existsSync(path.join(stick.home, 'app/src/alt.js')));

    fs.unlinkSync(path.join(src.home, 'src/alt.js'));
    await tool.update(stick.home, { sourceRoot: src.home });
    assert.ok(!fs.existsSync(path.join(stick.home, 'app/src/alt.js')),
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
    fs.unlinkSync(path.join(stick.home, 'app/src/kernel/paths.js'));
    const broken = await tool.verify(stick.home);
    assert.equal(broken.ok, false);
    const incomplete = broken.problems.find((p) => p.code === 'APP_INCOMPLETE');
    assert.ok(incomplete, `APP_INCOMPLETE fehlt in ${JSON.stringify(broken.problems)}`);
    assert.match(incomplete.message, /paths\.js/);
    assert.ok(incomplete.fix && incomplete.fix.length > 10, 'jedes Problem braucht einen Loesungshinweis');

    // Marker gone: the app would silently write to ~/.neural-os instead.
    fs.unlinkSync(path.join(stick.home, 'neural-os.portable'));
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
    fs.renameSync(path.join(stick.home, 'app'), path.join(stick.home, '.app.old-deadbeef'));
    fs.mkdirSync(path.join(stick.home, '.app.tmp-cafebabe'));
    fs.writeFileSync(path.join(stick.home, '.app.tmp-cafebabe/halb.js'), 'x');

    const broken = await tool.verify(stick.home);
    assert.equal(broken.ok, false);
    const problem = broken.problems.find((p) => p.code === 'INTERRUPTED_COPY');
    assert.ok(problem, 'ein unterbrochener Kopiervorgang muss gemeldet werden');
    assert.match(problem.fix, /aktualisieren/i);

    // The repair puts the complete previous version back and drops the scrap.
    const repaired = cleanStale(stick.home);
    assert.deepEqual(repaired.restored, ['app']);
    assert.deepEqual(repaired.removed, ['.app.tmp-cafebabe']);
    assert.ok(fs.existsSync(path.join(stick.home, 'app/bin/neural-os.js')));

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

    const app = path.join(stick.home, 'app');
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

test('prepare sichert den Datenbestand mit und ueberschreibt nie einen vorhandenen', async () => {
  const stick = tempHome('stick-vault');
  const src = tempHome('stick-src10');
  const home = tempHome('stick-home');
  try {
    makeSource(src.home);
    fs.mkdirSync(path.join(home.home, 'vault/log'), { recursive: true });
    fs.writeFileSync(path.join(home.home, 'vault/log/00001.jsonl'), '{"seq":1}\n');
    fs.writeFileSync(path.join(home.home, 'config.json'), '{"network":{"mode":"offline"}}');
    fs.writeFileSync(path.join(home.home, '.lock'), String(process.pid));
    // A .log in a home directory is the user's own file, not build noise:
    // a backup that silently drops files is not a backup.
    fs.writeFileSync(path.join(home.home, 'mein-protokoll.log'), 'wichtig');

    const tool = createStick({});
    const result = await tool.prepare(stick.home, {
      sourceRoot: src.home,
      includeRuntimes: false,
      includeVault: true,
      sourceHome: home.home,
    });
    assert.ok(result.files > 0);
    assert.equal(fs.readFileSync(path.join(stick.home, 'data/vault/log/00001.jsonl'), 'utf8'), '{"seq":1}\n');
    assert.ok(fs.existsSync(path.join(stick.home, 'data/config.json')));
    // A stale lock file from another machine would block the next start.
    assert.ok(!fs.existsSync(path.join(stick.home, 'data/.lock')), '.lock darf nicht mitwandern');
    assert.equal(fs.readFileSync(path.join(stick.home, 'data/mein-protokoll.log'), 'utf8'), 'wichtig',
      'eine Sicherung darf keine Datei des Nutzers stillschweigend weglassen');

    // A second run must refuse rather than overwrite what is already there.
    await assert.rejects(
      () => tool.prepare(stick.home, {
        sourceRoot: src.home, includeRuntimes: false, includeVault: true, sourceHome: home.home,
      }),
      (err) => {
        // 409 statt 500, aus demselben Grund wie beim vollen Stick: "da liegen
        // schon Daten" ist der Zustand des Sticks, kein Defekt dieses Servers.
        // Wer bisher auf StorageError geprueft hat, verliert nichts.
        assert.equal(err.code, 'STICK_DATA_PRESENT');
        assert.equal(err.status, 409);
        assert.ok(err instanceof StorageError);
        assert.match(err.message, /bereits ein Datenbestand/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(path.join(stick.home, 'data/vault/log/00001.jsonl'), 'utf8'), '{"seq":1}\n');
  } finally {
    stick.cleanup();
    src.cleanup();
    home.cleanup();
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
    assert.ok(!fs.existsSync(path.join(stick.home, 'runtime', foreign)));

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
    const written = fs.readFileSync(path.join(stick.home, 'runtime', platform, 'node'));
    assert.ok(written.equals(binary), 'die entpackte Binaerdatei muss byteweise stimmen');
    assert.equal(fs.readFileSync(path.join(stick.home, 'runtime', platform, 'node-version.txt'), 'utf8').trim(), version);

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
    assert.ok(!fs.existsSync(path.join(stick.home, 'runtime', platform, 'node')),
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
    const written = fs.readFileSync(path.join(stick.home, 'runtime', platform, 'node.exe'));
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

    const runtime = path.join(stick.home, 'runtime');
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
      assert.ok(fs.existsSync(path.join(stick.home, rel)), `${rel} fehlt`);
    }
    assert.ok(!fs.existsSync(path.join(stick.home, 'app/node_modules')));
    assert.ok(!fs.existsSync(path.join(stick.home, 'app/.git')));

    // The copied CLI must be a loadable program, not a truncated file.
    const run = spawnSync(process.execPath, [path.join(stick.home, 'app/bin/neural-os.js'), 'version'], {
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
    const alt = snapshotDir(path.join(stick.home, 'app'));

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
    assert.deepEqual(snapshotDir(path.join(stick.home, 'app')), alt);
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

test('ein abgebrochener Datenbestand bleibt nicht als halbe Sicherung liegen', async () => {
  const stick = tempHome('stick-halbe-sicherung');
  const src = tempHome('stick-src31');
  const heim = tempHome('stick-heim');
  try {
    makeSource(src.home);
    // Ein Datenbestand, gross genug, um mittendrin abgebrochen zu werden.
    const blob = Buffer.alloc(512 * 1024, 5);
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(heim.home, `notiz-${i}.bin`), blob);
    const tool = createStick({});

    const controller = new AbortController();
    await assert.rejects(
      () => tool.prepare(stick.home, {
        sourceRoot: src.home,
        sourceHome: heim.home,
        includeVault: true,
        includeRuntimes: false,
        signal: controller.signal,
        onProgress(p) { if (p.label === 'data' && p.copied >= 1) controller.abort(); },
      }),
      (err) => err.code === 'ABORTED',
    );

    // Eine halbe Sicherung sieht aus wie eine ganze: genau das darf nicht
    // liegenbleiben, sonst vertraut ihr jemand.
    const geblieben = fs.readdirSync(path.join(stick.home, 'data'));
    assert.deepEqual(geblieben, [], `halbe Sicherung geblieben: ${geblieben.join(', ')}`);

    // Und danach laeuft dieselbe Sicherung vollstaendig durch.
    const fertig = await tool.prepare(stick.home, {
      sourceRoot: src.home, sourceHome: heim.home, includeVault: true, includeRuntimes: false,
    });
    assert.ok(fertig.files > 60);
    assert.equal(fs.readdirSync(path.join(stick.home, 'data')).length, 60);
  } finally {
    stick.cleanup();
    src.cleanup();
    heim.cleanup();
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
    fs.chmodSync(path.join(stick.home, 'data'), 0o777);
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
      () => tool.prepare(stick.home, {
        sourceRoot: src.home,
        includeRuntimes: false,
        includeVault: true,
        sourceHome: path.join(src.home, 'kein-zuhause'),
      }),
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
    assert.equal(selbst.json.modell.reistMit, false);
    assert.match(selbst.json.modell.grund, /Modell/);
    assert.ok(selbst.json.bekanntePlattformen.includes('win-x64'));

    const status = await req('GET', '/api/status');
    assert.equal(status.status, 200, status.text);
    assert.ok('portable' in status.json, 'der Browser kann nicht erfahren, ob er von einem Stick laeuft');
    assert.equal(status.json.portable, null);
    assert.equal(status.json.subsystems.stick, true);

    // Ohne Pfad: ein ganzer Satz, kein "path required".
    const ohne = await req('GET', '/api/stick/preview');
    assert.equal(ohne.status, 400, ohne.text);
    assert.match(ohne.json.error.message, /Pfad zum Stick/);
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
    assert.ok(fs.existsSync(path.join(ziel, 'neural-os.portable')), 'Marker fehlt');
    assert.ok(fs.existsSync(path.join(ziel, 'app', 'bin', 'neural-os.js')), 'Programm fehlt');

    // Die Pruefung haengt hinter einem GET und darf deshalb nichts schreiben.
    const vorherMtime = fs.statSync(ziel).mtimeMs;
    const pruefung = await req('GET', `/api/stick/verify?path=${encodeURIComponent(ziel)}`);
    assert.equal(pruefung.status, 200, pruefung.text);
    assert.equal(pruefung.json.ok, true, JSON.stringify(pruefung.json.problems));
    assert.equal(pruefung.json.filesystem.probed, false);
    assert.equal(fs.statSync(ziel).mtimeMs, vorherMtime);

    // Und jetzt der Punkt: was vorher entscheidbar ist, wird VOR dem ersten
    // Byte entschieden -- als Statuscode, nicht als halber Ereignisstrom.
    const mitDaten = await req('POST', '/api/stick/prepare', { path: ziel, includeVault: true });
    assert.equal(mitDaten.status, 200, mitDaten.text);
    const nochmal = await req('POST', '/api/stick/prepare', { path: ziel, includeVault: true });
    assert.equal(nochmal.status, 409, nochmal.text);
    assert.equal(nochmal.json.error.code, 'STICK_DATA_PRESENT');
    assert.equal(nochmal.events.length, 0, 'es wurde doch ein Ereignisstrom geoeffnet');
    assert.match(nochmal.json.error.message, /bereits ein Datenbestand/);
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
    assert.equal(danach.json.ok, true, JSON.stringify(danach.json.problems));
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

module.exports = { name: 'stick', tests: drain() };
