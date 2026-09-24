'use strict';

/**
 * Paket G (docs/STICK-BAUPLAN.md, Abschnitt 2.1): die drei Grundbausteine,
 * auf denen Welle 1 parallel aufbaut. Die ersten fünf Tests sind genau die
 * im Bauplan genannten; die übrigen sichern die Kanten ab, auf die sich die
 * späteren Pakete verlassen (Rückgabewerte, "nichts schreiben, wenn nichts
 * zu tun ist", Fehlerfälle).
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, tempHome } = require('./harness');

const rechner = require('../src/kernel/rechner');
const dateien = require('../src/kernel/dateien');
const identitaetMod = require('../src/kernel/identitaet');
const pathsMod = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');

const { kiPort, createIdentitaet, standardName } = identitaetMod;

const ID_RE = /^dev_[0-9a-f]{24}$/;
const DEV_A = `dev_${'a'.repeat(24)}`;
const DEV_B = `dev_${'b'.repeat(24)}`;

/** Ein Fehler, wie ihn fs unter Windows bei gesperrten Dateien wirft. */
function fsFehler(code) {
  const err = new Error(`${code}: gespielt`);
  err.code = code;
  return err;
}

/**
 * Ein Temp-Stick in der Form, die `paths.detectPortable` erkennt:
 *   <root>/neural-os.portable   Marker
 *   <root>/data/config.json     Konfiguration der KI
 */
function tempStick({ marker = {}, config = null } = {}) {
  const t = tempHome('grund-stick');
  const root = t.home;
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const info = {
    neuralOsPortable: true,
    dataDir: 'data',
    appDir: 'app',
    createdAt: '2026-09-01T10:00:00.000Z',
    hinweis: 'bleibt stehen',
    ...marker,
  };
  fs.writeFileSync(path.join(root, pathsMod.PORTABLE_MARKER), JSON.stringify(info, null, 2));
  if (config) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config, null, 2));
  const portable = pathsMod.detectPortable(root);
  assert.ok(portable, 'Temp-Stick wird nicht als portabel erkannt');
  const paths = pathsMod.layout(data);
  return { ...t, root, data, portable, paths };
}

function leseJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Konfiguration laden und ein zählendes `speichern` dazu bauen. */
function ladeKonfig(paths) {
  const config = configMod.load(paths.config);
  const gespeichert = [];
  const speichern = (c) => {
    gespeichert.push(JSON.parse(JSON.stringify(c)));
    configMod.save(paths.config, c);
  };
  return { config, speichern, gespeichert };
}

/* --------------------------------------------------- Tests aus dem Bauplan */

test('kiPort liegt für 1000 Zufalls-IDs in 20000–29999 und ist für dieselbe ID stabil', () => {
  for (let i = 0; i < 1000; i++) {
    const id = `dev_${crypto.randomBytes(12).toString('hex')}`;
    const port = kiPort(id);
    assert.ok(Number.isInteger(port), `kein ganzzahliger Port für ${id}: ${port}`);
    assert.ok(port >= 20000 && port <= 29999, `Port ${port} für ${id} liegt außerhalb 20000–29999`);
    assert.equal(kiPort(id), port, `Port für ${id} ist nicht stabil`);
  }
  // Die Formel ist verbindlich: andere Pakete (R, I) rechnen denselben Port aus.
  const erwartet = 20000 + (parseInt(crypto.createHash('sha256').update(DEV_A).digest('hex').slice(0, 8), 16) % 10000);
  assert.equal(kiPort(DEV_A), erwartet);
});

test('umbenennen: zweimal EPERM, dann Erfolg – gelingt unter win32, wirft unter linux sofort', () => {
  function spielFs() {
    const aufrufe = [];
    let fehlschlaege = 0;
    return {
      aufrufe,
      renameSync(von, nach) {
        aufrufe.push([von, nach]);
        if (fehlschlaege < 2) {
          fehlschlaege++;
          throw fsFehler('EPERM');
        }
      },
    };
  }

  const win = spielFs();
  const pausen = [];
  dateien.umbenennen('/x/a.tmp', '/x/a', { fs: win, platform: 'win32', schlafe: (ms) => pausen.push(ms) });
  assert.equal(win.aufrufe.length, 3, 'unter win32 muss nach zwei EPERM ein dritter Versuch kommen');
  assert.deepEqual(pausen, [20, 40], 'Backoff beginnt mit 20 ms und verdoppelt sich');

  const lin = spielFs();
  const pausenLinux = [];
  assert.throws(
    () => dateien.umbenennen('/x/a.tmp', '/x/a', { fs: lin, platform: 'linux', schlafe: (ms) => pausenLinux.push(ms) }),
    (err) => err.code === 'EPERM',
  );
  assert.equal(lin.aufrufe.length, 1, 'unter linux gibt es keine Wiederholung');
  assert.deepEqual(pausenLinux, []);
});

test('schreibeDauerhaft: fsyncSync(tmp) vor renameSync vor fsyncSync(Ordner) – Spion auf fs', () => {
  const { home, cleanup } = tempHome('grund-dauerhaft');
  const ziel = path.join(home, 'snapshot.json');
  const namen = ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync'];
  const original = {};
  const protokoll = [];
  /** fd -> geöffneter Pfad, damit fsync(tmp) und fsync(Ordner) unterscheidbar sind. */
  const fdPfad = new Map();
  for (const name of namen) {
    original[name] = fs[name];
    fs[name] = function spion(...args) {
      const out = original[name].apply(fs, args);
      if (name === 'openSync') fdPfad.set(out, String(args[0]));
      const wo = name === 'renameSync' ? String(args[0]) : fdPfad.get(args[0]);
      protokoll.push({ name, wo });
      return out;
    };
  }
  try {
    dateien.schreibeDauerhaft(ziel, '{"v":1}');
  } finally {
    for (const name of namen) fs[name] = original[name];
  }
  try {
    assert.equal(fs.readFileSync(ziel, 'utf8'), '{"v":1}');
    const istTmp = (p) => typeof p === 'string' && path.dirname(p) === home && /^\.snapshot\.json\.tmp-\d+-[0-9a-f]+$/.test(path.basename(p));
    const fsyncTmp = protokoll.findIndex((e) => e.name === 'fsyncSync' && istTmp(e.wo));
    const rename = protokoll.findIndex((e) => e.name === 'renameSync' && istTmp(e.wo));
    const fsyncOrdner = protokoll.findIndex((e, i) => i > rename && e.name === 'fsyncSync' && e.wo === home);
    assert.ok(fsyncTmp >= 0, `fsyncSync auf die tmp-Datei fehlt: ${JSON.stringify(protokoll)}`);
    assert.ok(rename > fsyncTmp, `renameSync muss nach fsyncSync(tmp) kommen: ${JSON.stringify(protokoll)}`);
    assert.ok(fsyncOrdner > rename, `fsyncSync(Ordner) muss nach renameSync kommen: ${JSON.stringify(protokoll)}`);
    assert.deepEqual(fs.readdirSync(home), ['snapshot.json'], 'es darf keine tmp-Datei liegen bleiben');
  } finally {
    cleanup();
  }
});

test('pruefeMarker: Marker dev_a…, config.json dev_b… → neue ID, Abgleich-Dateien weg, Marker aktualisiert', () => {
  const stick = tempStick({
    marker: { kiId: DEV_A, name: 'Stick Y', eigenesFeld: 42 },
    config: { sync: { deviceId: DEV_B, deviceName: 'Lena' }, server: { host: '127.0.0.1', port: kiPort(DEV_B) } },
  });
  try {
    fs.writeFileSync(path.join(stick.paths.home, 'sync-folder.json'), '{"v":1,"devices":{}}');
    fs.writeFileSync(path.join(stick.paths.home, 'kopplungen.json'), '{"v":1,"partner":[]}');
    const { config, speichern } = ladeKonfig(stick.paths);
    const ereignisse = [];
    const ki = createIdentitaet({
      config, paths: stick.paths, portable: stick.portable, speichern,
      publish: (name, payload) => ereignisse.push({ name, payload }),
    });
    ki.sicherstellen();
    assert.equal(ki.id, DEV_B, 'sicherstellen darf eine vorhandene Kennung nicht ersetzen');

    ki.pruefeMarker();

    assert.match(ki.id, ID_RE);
    assert.notEqual(ki.id, DEV_A);
    assert.notEqual(ki.id, DEV_B);
    assert.equal(ki.port, kiPort(ki.id), 'neue KI, neuer Port');
    assert.equal(ki.name, 'Lena', 'der Name bleibt');
    assert.equal(fs.existsSync(path.join(stick.paths.home, 'sync-folder.json')), false, 'sync-folder.json muss weg sein');
    assert.equal(fs.existsSync(path.join(stick.paths.home, 'kopplungen.json')), false, 'kopplungen.json muss weg sein');

    const aufPlatte = leseJson(stick.paths.config);
    assert.equal(aufPlatte.sync.deviceId, ki.id, 'die neue Kennung muss gespeichert sein');
    assert.equal(aufPlatte.server.port, ki.port);

    const marker = leseJson(stick.portable.marker);
    assert.equal(marker.kiId, ki.id);
    assert.equal(marker.name, 'Lena');
    // Alle vorhandenen Felder bleiben erhalten.
    assert.equal(marker.neuralOsPortable, true);
    assert.equal(marker.dataDir, 'data');
    assert.equal(marker.appDir, 'app');
    assert.equal(marker.createdAt, '2026-09-01T10:00:00.000Z');
    assert.equal(marker.hinweis, 'bleibt stehen');
    assert.equal(marker.eigenesFeld, 42);
    assert.deepEqual(fs.readdirSync(stick.root).sort(), ['data', 'neural-os.portable'], 'keine tmp-Reste neben dem Marker');

    assert.deepEqual(ereignisse, [{ name: 'ki.erneuert', payload: { grund: 'daten-kopiert' } }]);
  } finally {
    stick.cleanup();
  }
});

test("istBegleitdatei('._.app.old-deadbeef') ist wahr, istBegleitdatei('app') nicht", () => {
  assert.equal(dateien.istBegleitdatei('._.app.old-deadbeef'), true);
  assert.equal(dateien.istBegleitdatei('app'), false);
});

/* ------------------------------------------------------ weitere Kanten */

test('umbenennen unter win32 gibt nach 2 s Wartezeit auf und wirft den letzten Fehler', () => {
  let versuche = 0;
  const immerGesperrt = { renameSync() { versuche++; throw fsFehler('EBUSY'); } };
  const pausen = [];
  assert.throws(
    () => dateien.umbenennen('/x/a.tmp', '/x/a', { fs: immerGesperrt, platform: 'win32', schlafe: (ms) => pausen.push(ms) }),
    (err) => err.code === 'EBUSY',
  );
  assert.deepEqual(pausen.slice(0, 6), [20, 40, 80, 160, 320, 640]);
  assert.equal(pausen.reduce((a, b) => a + b, 0), 2000, 'insgesamt höchstens 2 s warten');
  assert.equal(versuche, pausen.length + 1);

  // Andere Fehler sind kein Virenscanner, sondern echt: sofort werfen.
  let enoent = 0;
  const fehlt = { renameSync() { enoent++; throw fsFehler('ENOENT'); } };
  assert.throws(() => dateien.umbenennen('/x/a.tmp', '/x/a', { fs: fehlt, platform: 'win32', schlafe: () => {} }), /ENOENT/);
  assert.equal(enoent, 1);
});

test('umbenennen ohne eingespieltes fs benennt wirklich um, auch über eine bestehende Datei', () => {
  const { home, cleanup } = tempHome('grund-umbenennen');
  try {
    fs.writeFileSync(path.join(home, 'neu'), 'neu');
    fs.writeFileSync(path.join(home, 'alt'), 'alt');
    dateien.umbenennen(path.join(home, 'neu'), path.join(home, 'alt'));
    assert.equal(fs.readFileSync(path.join(home, 'alt'), 'utf8'), 'neu');
    assert.equal(fs.existsSync(path.join(home, 'neu')), false);
  } finally {
    cleanup();
  }
});

test('schreibeDauerhaft räumt bei einem Fehler die tmp-Datei weg, lässt das Ziel stehen und wirft', () => {
  const { home, cleanup } = tempHome('grund-fehler');
  const ziel = path.join(home, 'config.json');
  fs.writeFileSync(ziel, 'alt');
  const original = fs.fsyncSync;
  let erster = true;
  fs.fsyncSync = function kaputt(fd) {
    if (erster) {
      erster = false;
      throw fsFehler('EIO');
    }
    return original.call(fs, fd);
  };
  try {
    assert.throws(() => dateien.schreibeDauerhaft(ziel, 'neu'), (err) => err.code === 'EIO');
  } finally {
    fs.fsyncSync = original;
  }
  try {
    assert.equal(fs.readFileSync(ziel, 'utf8'), 'alt');
    assert.deepEqual(fs.readdirSync(home), ['config.json']);
  } finally {
    cleanup();
  }
});

test('schreibeDauerhaft schreibt Buffer, setzt den Modus und legt keine fehlenden Ordner an', () => {
  const { home, cleanup } = tempHome('grund-modus');
  try {
    const ziel = path.join(home, 'blob.bin');
    dateien.schreibeDauerhaft(ziel, Buffer.from([0, 1, 2, 255]));
    assert.deepEqual([...fs.readFileSync(ziel)], [0, 1, 2, 255]);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(ziel).mode & 0o777, 0o600, 'Vorgabe: nur der Besitzer darf lesen');
      const offen = path.join(home, 'offen.json');
      dateien.schreibeDauerhaft(offen, '{}', { modus: 0o644 });
      const modus = fs.statSync(offen).mode & 0o777;
      assert.equal(modus & 0o600, 0o600);
      assert.equal(modus & 0o022, 0, 'niemand außer dem Besitzer darf schreiben');
    }
    // Ein fehlender Ordner heißt oft: der Stick ist weg. Dann nicht woanders anlegen.
    assert.throws(() => dateien.schreibeDauerhaft(path.join(home, 'fehlt', 'x.json'), '{}'), (err) => err.code === 'ENOENT');
    assert.equal(fs.existsSync(path.join(home, 'fehlt')), false);
  } finally {
    cleanup();
  }
});

test('fsyncOrdner schluckt Fehler still', () => {
  const { home, cleanup } = tempHome('grund-fsync');
  try {
    assert.doesNotThrow(() => dateien.fsyncOrdner(path.join(home, 'gibt-es-nicht')));
    assert.doesNotThrow(() => dateien.fsyncOrdner(home));
    const kaputt = { openSync() { throw fsFehler('EISDIR'); }, fsyncSync() {}, closeSync() {} };
    assert.doesNotThrow(() => dateien.fsyncOrdner(home, { fs: kaputt }));
  } finally {
    cleanup();
  }
});

test('istBegleitdatei kennt alle Begleitdateien, egal ob groß oder klein geschrieben', () => {
  const ja = [
    '._brief.txt', '.DS_Store', '.ds_store', '.Trashes', '.fseventsd', '.Spotlight-V100', '.TemporaryItems',
    '.apdisk', '.VolumeIcon.icns', '.metadata_never_index', 'System Volume Information', 'system volume information',
    '$RECYCLE.BIN', '$Recycle.Bin', 'desktop.ini', 'Desktop.ini', 'Thumbs.db', 'THUMBS.DB',
  ];
  for (const name of ja) assert.equal(dateien.istBegleitdatei(name), true, name);
  const nein = ['app', 'data', 'neural-os.portable', '.lock', '_.app', 'DS_Store', 'Thumbs.db.txt', '', null, undefined, 42];
  for (const name of nein) assert.equal(dateien.istBegleitdatei(name), false, String(name));
  assert.equal(dateien.OS_BEGLEITDATEIEN.length, 13);
  assert.ok(Object.isFrozen(dateien.OS_BEGLEITDATEIEN), 'die Liste darf niemand zur Laufzeit verändern');
});

test('rechner: kennung und profil sind 16 Hex-Zeichen, stabil und folgen der Formel', () => {
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  assert.match(rechner.kennung(), /^[0-9a-f]{16}$/);
  assert.equal(rechner.kennung(), rechner.kennung());
  assert.equal(rechner.kennung(), sha(`nos-rechner|${os.hostname().toLowerCase()}`).slice(0, 16));
  assert.match(rechner.profil(), /^[0-9a-f]{16}$/);
  assert.equal(rechner.profil(), rechner.profil());
  assert.notEqual(rechner.profil(), rechner.kennung());

  // userInfo darf werfen (manche Container kennen den Benutzer nicht) -> ''.
  const original = os.userInfo;
  os.userInfo = () => { throw fsFehler('ENOENT'); };
  let ohneBenutzer;
  try {
    ohneBenutzer = rechner.profil();
  } finally {
    os.userInfo = original;
  }
  assert.equal(ohneBenutzer, sha(`nos-profil|${os.hostname().toLowerCase()}|`).slice(0, 16));
});

test('rechner: bootZeit und gleicherStart', () => {
  const erwartet = Math.round(Date.now() / 1000 - os.uptime());
  assert.ok(Number.isInteger(rechner.bootZeit()));
  assert.ok(Math.abs(rechner.bootZeit() - erwartet) <= 1);
  assert.equal(rechner.gleicherStart(1000, 1120), true);
  assert.equal(rechner.gleicherStart(1120, 1000), true);
  assert.equal(rechner.gleicherStart(1000, 1121), false);
  assert.equal(rechner.gleicherStart(rechner.bootZeit(), rechner.bootZeit() - 86400), false);
  // Eine alte Sperre ohne Bootzeit ist nie "derselbe Start".
  assert.equal(rechner.gleicherStart(undefined, 5), false);
  assert.equal(rechner.gleicherStart(null, 5), false);
  assert.equal(rechner.gleicherStart('5', 5), false);
});

test('sicherstellen: portabel zieht von 7777 auf kiPort um, speichert nur bei Änderung', () => {
  const stick = tempStick({ config: null });
  try {
    const { config, speichern, gespeichert } = ladeKonfig(stick.paths);
    const ki = createIdentitaet({ config, paths: stick.paths, portable: stick.portable, speichern });
    assert.equal(config.server.port, 7777);
    ki.sicherstellen();
    assert.match(ki.id, ID_RE);
    assert.equal(ki.port, kiPort(ki.id));
    assert.equal(ki.name, `KI ${ki.id.slice(4, 8).toUpperCase()}`);
    assert.equal(gespeichert.length, 1);
    assert.equal(leseJson(stick.paths.config).sync.deviceId, ki.id);

    // Zweiter Start: nichts fehlt, also kein Schreiben auf den Stick.
    ki.sicherstellen();
    assert.equal(gespeichert.length, 1);

    // Ein vom Nutzer gewählter Port bleibt, auch portabel.
    config.server.port = 8123;
    ki.sicherstellen();
    assert.equal(ki.port, 8123);
  } finally {
    stick.cleanup();
  }
});

test('sicherstellen: die Heim-Installation bleibt bei 7777, pruefeMarker tut dort nichts', () => {
  const { home, cleanup } = tempHome('grund-heim');
  try {
    const paths = pathsMod.layout(home);
    const { config, speichern, gespeichert } = ladeKonfig(paths);
    config.sync = { deviceId: 'kaputt', deviceName: '   ' };
    const ki = createIdentitaet({ config, paths, portable: null, speichern });
    ki.sicherstellen();
    assert.match(ki.id, ID_RE, 'eine ungültige Kennung zählt als fehlend');
    assert.equal(ki.port, 7777);
    assert.equal(ki.name, `KI ${ki.id.slice(4, 8).toUpperCase()}`);
    assert.equal(gespeichert.length, 1);
    const vorher = ki.id;
    ki.pruefeMarker();
    assert.equal(ki.id, vorher);
    assert.equal(gespeichert.length, 1);
  } finally {
    cleanup();
  }
});

test('pruefeMarker: Marker ohne kiId bekommt kiId und Namen, gleicher Marker bleibt unberührt', () => {
  const stick = tempStick({
    marker: { nodeVersion: 'v22.22.2' },
    config: { sync: { deviceId: DEV_B, deviceName: 'Max' }, server: { host: '127.0.0.1', port: 7777 } },
  });
  try {
    fs.writeFileSync(path.join(stick.paths.home, 'kopplungen.json'), '{"v":1}');
    const { config, speichern } = ladeKonfig(stick.paths);
    const ki = createIdentitaet({ config, paths: stick.paths, portable: stick.portable, speichern });
    ki.sicherstellen();
    assert.equal(ki.port, kiPort(DEV_B), 'portabel mit 7777 zieht auf den eigenen Port um');
    ki.pruefeMarker();
    assert.equal(ki.id, DEV_B, 'ein Marker ohne kiId ist ein alter Stick, keine Kopie');
    assert.equal(fs.existsSync(path.join(stick.paths.home, 'kopplungen.json')), true);
    const marker = leseJson(stick.portable.marker);
    assert.equal(marker.kiId, DEV_B);
    assert.equal(marker.name, 'Max');
    assert.equal(marker.nodeVersion, 'v22.22.2');
    assert.equal(marker.createdAt, '2026-09-01T10:00:00.000Z');

    // Passt der Marker schon, wird er nicht angefasst: jedes Schreiben
    // ersetzt die Datei per rename, also wäre der Inode danach ein anderer.
    const vorher = fs.readFileSync(stick.portable.marker, 'utf8');
    const inode = fs.statSync(stick.portable.marker).ino;
    ki.pruefeMarker();
    assert.equal(ki.id, DEV_B);
    assert.equal(fs.readFileSync(stick.portable.marker, 'utf8'), vorher);
    assert.equal(fs.statSync(stick.portable.marker).ino, inode);
  } finally {
    stick.cleanup();
  }
});

test('umbenennen der KI: 1..60 Zeichen, landet in config und Marker', () => {
  const stick = tempStick({
    marker: { kiId: DEV_B },
    config: { sync: { deviceId: DEV_B, deviceName: 'Max' }, server: { host: '127.0.0.1', port: kiPort(DEV_B) } },
  });
  try {
    const { config, speichern, gespeichert } = ladeKonfig(stick.paths);
    const ki = createIdentitaet({ config, paths: stick.paths, portable: stick.portable, speichern });
    ki.sicherstellen();
    assert.equal(gespeichert.length, 0);
    assert.equal(ki.umbenennen('  Lena  '), 'Lena');
    assert.equal(ki.name, 'Lena');
    assert.equal(leseJson(stick.paths.config).sync.deviceName, 'Lena');
    assert.equal(leseJson(stick.portable.marker).name, 'Lena');
    assert.equal(leseJson(stick.portable.marker).kiId, DEV_B);

    for (const falsch of ['', '   ', 'x'.repeat(61), 'Zeile\nzwei', null, 7]) {
      assert.throws(() => ki.umbenennen(falsch), (err) => err.code === 'VALIDATION_FAILED' && /Name/.test(err.message), String(falsch));
    }
    assert.equal(ki.name, 'Lena');
    assert.equal(ki.umbenennen('ä'.repeat(60)), 'ä'.repeat(60));
  } finally {
    stick.cleanup();
  }
});

test('erneuern: neue Kennung und neuer Port, meldet ki.erneuert über den Bus', () => {
  const stick = tempStick({
    marker: { kiId: DEV_B },
    config: { sync: { deviceId: DEV_B, deviceName: 'Lena' }, server: { host: '127.0.0.1', port: kiPort(DEV_B) } },
  });
  try {
    const { config, speichern } = ladeKonfig(stick.paths);
    const veroeffentlicht = [];
    const bus = { publish: (name, payload) => veroeffentlicht.push({ name, payload }) };
    const ki = createIdentitaet({ config, paths: stick.paths, portable: stick.portable, speichern, bus });
    ki.sicherstellen();
    ki.pruefeMarker();
    assert.equal(ki.id, DEV_B);
    const ergebnis = ki.erneuern('zwilling');
    assert.match(ki.id, ID_RE);
    assert.notEqual(ki.id, DEV_B);
    assert.equal(ergebnis.id, ki.id);
    assert.equal(ergebnis.alteId, DEV_B);
    assert.equal(ki.port, kiPort(ki.id));
    assert.equal(leseJson(stick.portable.marker).kiId, ki.id);
    assert.deepEqual(veroeffentlicht, [{ name: 'ki.erneuert', payload: { grund: 'zwilling' } }]);
  } finally {
    stick.cleanup();
  }
});

test('standardName: Datenträgername am Mac und unter Linux, sonst "KI XXXX"', () => {
  const id = `dev_${'c0ffee'}${'0'.repeat(18)}`;
  const nachId = 'KI C0FF';
  const fall = (root) => standardName(root === null ? null : { root, dataDir: `${root}/data`, marker: `${root}/neural-os.portable`, info: {} }, id);
  assert.equal(fall('/Volumes/LENA'), 'LENA');
  assert.equal(fall('/Volumes/Schulstick/Inhalt'), 'Schulstick');
  assert.equal(fall('/media/max/Mein Stick'), 'Mein Stick');
  assert.equal(fall('/run/media/max/TOM/Inhalt'), 'TOM');
  for (const generisch of ['NO NAME', 'UNTITLED', 'Untitled', 'USB', 'USB DISK', 'usb disk']) {
    assert.equal(fall(`/Volumes/${generisch}`), nachId, generisch);
    assert.equal(fall(`/media/max/${generisch}/Inhalt`), nachId, generisch);
  }
  assert.equal(fall('E:\\Inhalt'), nachId);
  assert.equal(fall('/home/max/stick'), nachId);
  assert.equal(fall(null), nachId);
});

test('createIdentitaet verweigert fehlende Bausteine mit deutscher Meldung', () => {
  assert.throws(() => createIdentitaet({}), (err) => err.code === 'VALIDATION_FAILED' && /config/.test(err.message));
  assert.throws(
    () => createIdentitaet({ config: {}, paths: { home: '/x' } }),
    (err) => err.code === 'VALIDATION_FAILED' && /speichern/.test(err.message),
  );
  assert.throws(
    () => createIdentitaet({ config: {}, paths: {}, speichern() {} }),
    (err) => err.code === 'VALIDATION_FAILED' && /paths\.home/.test(err.message),
  );
});
