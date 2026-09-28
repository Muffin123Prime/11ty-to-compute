'use strict';

/**
 * Paket H (docs/STICK-BAUPLAN.md, Abschnitt 2.3): haltbar schreiben und die
 * Tresor-Sperre, die nur noch ein lebender Prozess desselben Rechners und
 * desselben Starts hält. Dazu die Konfiguration ohne die toten Voreinstellungen
 * für lokale Modellserver (ollama, llama.cpp, LM Studio), samt Migration alter
 * config.json-Dateien beim Lesen.
 *
 * Die Reihenfolge der Dateisystemaufrufe wird mit einem Spion auf `node:fs`
 * geprüft: engine.js, history.js, config.js und dateien.js sprechen `fs` über
 * das Modulobjekt an, ein ersetzter `fs.fsyncSync` sieht also jeden Aufruf.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const { createHistory } = require('../src/store/history');
const { withActor } = require('../src/kernel/actor');
const { Bus } = require('../src/kernel/bus');
const rechner = require('../src/kernel/rechner');
const pathsMod = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');

const STILL = { error() {}, warn() {}, info() {}, debug() {} };
const SEGMENT_RE = /[\\/]\d{5,}\.jsonl$/;

/**
 * Zeichnet die genannten `fs`-Aufrufe samt erstem Argument auf, solange `fn`
 * läuft, und stellt danach die Originale wieder her. Aufgezeichnet wird, was
 * wirklich aufgerufen wurde, auch wenn es wirft.
 */
async function mitSpion(namen, fn) {
  const aufrufe = [];
  const orig = {};
  const fdPfad = new Map();
  for (const name of namen) {
    orig[name] = fs[name];
    fs[name] = function spion(...args) {
      const eintrag = { name, arg: args[0] };
      if (typeof args[0] === 'number' && fdPfad.has(args[0])) eintrag.pfad = fdPfad.get(args[0]);
      aufrufe.push(eintrag);
      const ergebnis = orig[name].apply(fs, args);
      if (name === 'openSync' && typeof ergebnis === 'number') fdPfad.set(ergebnis, String(args[0]));
      return ergebnis;
    };
  }
  try {
    await fn(aufrufe);
  } finally {
    Object.assign(fs, orig);
  }
  return aufrufe;
}

/** Eine Uhr-Attrappe für `setTimeout`/`clearTimeout`: Zeit vergeht nur mit `vorspulen`. */
function uhrAttrappe() {
  let jetzt = 0;
  let naechste = 0;
  const wartend = new Map();
  const griffe = [];
  return {
    setTimeout(fn, ms) {
      const griff = { id: ++naechste, unrefd: false, unref() { this.unrefd = true; return this; } };
      wartend.set(griff.id, { fn, faellig: jetzt + Math.max(0, Number(ms) || 0) });
      griffe.push(griff);
      return griff;
    },
    clearTimeout(griff) {
      if (griff && typeof griff === 'object') wartend.delete(griff.id);
    },
    vorspulen(ms) {
      const ziel = jetzt + ms;
      for (;;) {
        let erster = null;
        for (const [id, t] of wartend) {
          if (t.faellig <= ziel && (!erster || t.faellig < erster.t.faellig)) erster = { id, t };
        }
        if (!erster) break;
        wartend.delete(erster.id);
        jetzt = erster.t.faellig;
        erster.t.fn();
      }
      jetzt = ziel;
    },
    get offen() { return wartend.size; },
    griffe,
  };
}

async function mitTresor(label, fn, optionen = {}) {
  const { home, cleanup } = tempHome(label);
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const store = await openStore({ paths, logger: STILL, ...optionen });
  try {
    return await fn({ store, paths, home });
  } finally {
    await store.close().catch(() => {});
    cleanup();
  }
}

function sperreSchreiben(home, inhalt) {
  const vault = pathsMod.layout(home).vault;
  fs.mkdirSync(vault, { recursive: true });
  const datei = path.join(vault, '.lock');
  fs.writeFileSync(datei, JSON.stringify(inhalt));
  return datei;
}

/* ------------------------------------------------- Tests aus dem Bauplan */

test('compact(): fsync der Momentaufnahme kommt vor dem Löschen des ersten Segments, der Log-Ordner danach', async () => {
  await mitTresor('haltbar-compact', async ({ store, paths }) => {
    for (let i = 0; i < 5; i++) store.create('note', { title: `Notiz ${i}` });
    const aufrufe = await mitSpion(['openSync', 'fsyncSync', 'renameSync', 'unlinkSync', 'closeSync'], async () => {
      await store.compact();
    });
    const ersterSegmentLoescher = aufrufe.findIndex((a) => a.name === 'unlinkSync' && SEGMENT_RE.test(String(a.arg)));
    assert.ok(ersterSegmentLoescher >= 0, 'compact() hat kein Segment gelöscht');
    const ersterFsync = aufrufe.findIndex((a) => a.name === 'fsyncSync');
    assert.ok(ersterFsync >= 0 && ersterFsync < ersterSegmentLoescher, 'kein fsync vor dem Löschen der Segmente (p1c)');

    const umbenennen = aufrufe.findIndex((a) => a.name === 'renameSync');
    assert.ok(umbenennen >= 0 && umbenennen < ersterSegmentLoescher, 'Momentaufnahme erst nach dem Löschen umbenannt');
    assert.ok(aufrufe.slice(0, umbenennen).some((a) => a.name === 'fsyncSync' && /snapshot\.json\.tmp-/.test(a.pfad || '')),
      'die tmp-Datei der Momentaufnahme wurde vor dem Umbenennen nicht gesichert');

    const letzterLoescher = aufrufe.map((a) => a.name === 'unlinkSync' && SEGMENT_RE.test(String(a.arg))).lastIndexOf(true);
    assert.ok(aufrufe.slice(letzterLoescher).some((a) => a.name === 'fsyncSync' && a.pfad === paths.log),
      'der Log-Ordner wurde nach dem Löschen nicht gesichert');

    // Und der Tresor ist danach vollständig.
    assert.equal(store.count('note'), 5);
  });
});

test('Tresor-Sperre eines anderen Rechners (pid 1, rechner ffff…) blockiert nicht mehr', async () => {
  const { home, cleanup } = tempHome('haltbar-sperre-fremd');
  try {
    const datei = sperreSchreiben(home, {
      pid: 1, rechner: 'ffffffffffffffff', boot: rechner.bootZeit(), at: new Date().toISOString(), scope: 'store',
    });
    const store = await openStore({ paths: home, logger: STILL });
    const eigen = JSON.parse(fs.readFileSync(datei, 'utf8'));
    assert.equal(eigen.pid, process.pid, 'die verwaiste Sperre wurde nicht durch die eigene ersetzt');
    await store.close();
    assert.equal(fs.existsSync(datei), false);
  } finally {
    cleanup();
  }
});

test('Tresor-Sperre dieses Rechners aus einem früheren Start (boot − 1 Tag) blockiert nicht mehr', async () => {
  const { home, cleanup } = tempHome('haltbar-sperre-boot');
  try {
    sperreSchreiben(home, {
      pid: 1, rechner: rechner.kennung(), boot: rechner.bootZeit() - 86400, at: new Date().toISOString(), scope: 'store',
    });
    const store = await openStore({ paths: home, logger: STILL });
    await store.close();
  } finally {
    cleanup();
  }
});

test('Gegenprobe: lebender Prozess mit eigenem Rechner und eigener Bootzeit führt zur Weigerung', async () => {
  const { home, cleanup } = tempHome('haltbar-sperre-lebt');
  const kind = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve, reject) => { kind.once('spawn', resolve); kind.once('error', reject); });
    sperreSchreiben(home, {
      pid: kind.pid, rechner: rechner.kennung(), boot: rechner.bootZeit(), at: new Date().toISOString(), scope: 'store',
    });
    await assert.rejects(() => openStore({ paths: home, logger: STILL }), (err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      assert.match(err.message, new RegExp(`^Der Vault wird bereits von Prozess ${kind.pid} verwendet\\.`));
      return true;
    });
  } finally {
    kind.kill();
    cleanup();
  }
});

test('config.save sichert per fsync (Spion)', async () => {
  const { home, cleanup } = tempHome('haltbar-config');
  try {
    const ziel = path.join(home, 'config.json');
    const config = configMod.defaults();
    const aufrufe = await mitSpion(['openSync', 'fsyncSync', 'renameSync'], () => { configMod.save(ziel, config); });
    const umbenennen = aufrufe.findIndex((a) => a.name === 'renameSync');
    assert.ok(umbenennen >= 0, 'nicht umbenannt');
    assert.ok(aufrufe.slice(0, umbenennen).some((a) => a.name === 'fsyncSync' && path.dirname(a.pfad || '') === home),
      'config.json wurde vor dem Umbenennen nicht gesichert');
    assert.ok(aufrufe.slice(umbenennen).some((a) => a.name === 'fsyncSync' && a.pfad === home), 'Ordner nicht gesichert');
    assert.deepEqual(configMod.load(ziel), config);
    assert.deepEqual(fs.readdirSync(home), ['config.json'], 'eine tmp-Datei blieb liegen');
  } finally {
    cleanup();
  }
});

test('entprelltes Sichern: 3 Schreibvorgänge, 2,5 s mit Uhr-Attrappe -> genau ein flush', async () => {
  const uhr = uhrAttrappe();
  await mitTresor('haltbar-entprellt', async ({ store }) => {
    // Ein flush = ein fsync auf dem Log-Segment (beim ersten kommt der Ordner dazu).
    const flushes = (liste) => liste.filter((a) => a.name === 'fsyncSync' && SEGMENT_RE.test(a.pfad || '')).length;
    const aufrufe = await mitSpion(['openSync', 'fsyncSync'], (bisher) => {
      store.create('note', { title: 'eins' });
      store.create('note', { title: 'zwei' });
      store.transaction(() => { store.create('note', { title: 'drei' }); });
      uhr.vorspulen(1900);
      assert.equal(flushes(bisher), 0, 'vor Ablauf der 2 s gesichert');
      uhr.vorspulen(600);
    });
    assert.equal(flushes(aufrufe), 1, `flush ${flushes(aufrufe)}-mal statt genau einmal`);
    assert.equal(uhr.offen, 0);
    assert.ok(uhr.griffe.length >= 1 && uhr.griffe.every((g) => g.unrefd), 'der Zeitgeber hält den Prozess wach (nicht unref)');
  }, { uhr });
});

test('Änderung unter withActor({kind:"sync", label:"Lena"}) steht im Journal als sync', async () => {
  const { home, cleanup } = tempHome('haltbar-sync-akteur');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: STILL });
  const history = createHistory({ store, bus, paths, logger: () => STILL });
  history.start();
  try {
    const note = withActor({ kind: 'sync', label: 'Lena' }, () => store.create('note', { title: 'Einkaufsliste' }));
    const eintrag = history.list().items.find((i) => i.id === note.id);
    assert.equal(eintrag.actor.kind, 'sync');
    assert.equal(eintrag.actor.label, 'Lena');
    assert.equal(eintrag.actor.via, 'kontext');

    // Und so steht es auch in der Datei: ein zweites Journal liest es zurück.
    history.stop();
    const zweites = createHistory({ store, bus, paths, logger: () => STILL });
    zweites.start();
    assert.equal(zweites.list().items.find((i) => i.id === note.id).actor.kind, 'sync');
    zweites.stop();
  } finally {
    try { history.stop(); } catch { /* schon gestoppt */ }
    await store.close().catch(() => {});
    cleanup();
  }
});

/* ------------------------------------------- weitere Stellen aus Paket H */

test('files.put: fsync der tmp-Datei vor dem Umbenennen, danach der Ordner', async () => {
  await mitTresor('haltbar-blob', async ({ store }) => {
    let ablage = null;
    const aufrufe = await mitSpion(['openSync', 'fsyncSync', 'renameSync'], () => {
      ablage = store.files.put(Buffer.from('Anhang, der das Abziehen übersteht'));
    });
    const umbenennen = aufrufe.findIndex((a) => a.name === 'renameSync' && path.basename(String(a.arg)).startsWith('.'));
    assert.ok(umbenennen >= 0, 'nicht über eine tmp-Datei geschrieben');
    assert.ok(aufrufe.slice(0, umbenennen).some((a) => a.name === 'fsyncSync' && path.dirname(a.pfad || '') === path.dirname(ablage.path)),
      'Blob vor dem Umbenennen nicht gesichert');
    assert.ok(aufrufe.slice(umbenennen).some((a) => a.name === 'fsyncSync' && a.pfad === path.dirname(ablage.path)),
      'Ordner des Blobs nicht gesichert');
    assert.equal(store.files.read(ablage.hash).toString('utf8'), 'Anhang, der das Abziehen übersteht');
  });
});

test('close() räumt den Zeitgeber ab und sichert selbst', async () => {
  const uhr = uhrAttrappe();
  const { home, cleanup } = tempHome('haltbar-close');
  try {
    const store = await openStore({ paths: home, logger: STILL, uhr });
    store.create('note', { title: 'kurz vor dem Beenden' });
    assert.equal(uhr.offen, 1, 'nach dem Schreiben ist kein Sichern geplant');
    const aufrufe = await mitSpion(['fsyncSync'], () => store.close());
    assert.equal(uhr.offen, 0, 'close() hat den Zeitgeber nicht abgeräumt');
    assert.ok(aufrufe.length >= 1, 'close() hat nicht gesichert');
  } finally {
    cleanup();
  }
});

test('Sichern spätestens 2 s nach dem ersten ungesicherten Schreiben, auch wenn weiter geschrieben wird', async () => {
  const uhr = uhrAttrappe();
  await mitTresor('haltbar-dauerlast', async ({ store }) => {
    const aufrufe = await mitSpion(['openSync', 'fsyncSync'], () => {
      // Alle 0,5 s ein Schreibvorgang, 6 s lang: ein reines Entprellen
      // würde nie sichern und beim Abziehen alles seit dem Start verlieren.
      for (let i = 0; i < 12; i++) {
        store.create('note', { title: `Tippen ${i}` });
        uhr.vorspulen(500);
      }
    });
    const n = aufrufe.filter((a) => a.name === 'fsyncSync' && SEGMENT_RE.test(a.pfad || '')).length;
    assert.ok(n >= 2, `unter Dauerlast ${n}-mal gesichert`);
  }, { uhr });
});

test('neues Log-Segment: der erste flush sichert auch den Log-Ordner', async () => {
  await mitTresor('haltbar-segment', async ({ store, paths }) => {
    store.create('note', { title: 'vorher' });
    await store.compact(); // löscht alle Segmente; das nächste wird neu angelegt
    const aufrufe = await mitSpion(['openSync', 'fsyncSync'], async () => {
      store.create('note', { title: 'danach' });
      await store.flush();
    });
    assert.ok(aufrufe.some((a) => a.name === 'fsyncSync' && a.pfad === paths.log), 'Ordnereintrag des neuen Segments nicht gesichert');
    const nochmal = await mitSpion(['openSync', 'fsyncSync'], async () => {
      store.create('note', { title: 'noch eine' });
      await store.flush();
    });
    assert.ok(!nochmal.some((a) => a.name === 'fsyncSync' && a.pfad === paths.log), 'Ordner bei jedem flush gesichert');
  });
});

test('Segmentwechsel sichert das alte Segment, bevor es geschlossen wird', async () => {
  const { home, cleanup } = tempHome('haltbar-rotation');
  try {
    const store = await openStore({ paths: home, logger: STILL, segmentMaxBytes: 200 });
    const aufrufe = await mitSpion(['openSync', 'fsyncSync', 'closeSync'], () => {
      store.create('note', { title: 'x'.repeat(300) });
    });
    const schliessen = aufrufe.findIndex((a) => a.name === 'closeSync' && /00001\.jsonl$/.test(a.pfad || ''));
    assert.ok(schliessen >= 0, 'kein Segmentwechsel');
    assert.ok(aufrufe.slice(0, schliessen).some((a) => a.name === 'fsyncSync' && /00001\.jsonl$/.test(a.pfad || '')),
      'altes Segment ungesichert geschlossen');
    await store.close();
  } finally {
    cleanup();
  }
});

test('history: Neuschreiben des Journals sichert per fsync', async () => {
  const { home, cleanup } = tempHome('haltbar-journal');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: STILL });
  const history = createHistory({ store, bus, paths, config: { history: { maxEntries: 2 } }, logger: () => STILL });
  history.start();
  try {
    const journal = path.join(paths.vault, 'history.jsonl');
    store.create('note', { title: 'eins' });
    store.create('note', { title: 'zwei' });
    store.create('note', { title: 'drei' });
    const aufrufe = await mitSpion(['openSync', 'fsyncSync', 'renameSync'], () => {
      store.create('note', { title: 'vier' }); // 4 Zeilen > 2 × 1,3: das Journal wird neu geschrieben
    });
    const umbenennen = aufrufe.findIndex((a) => a.name === 'renameSync' && /history\.jsonl\.tmp-/.test(String(a.arg)));
    assert.ok(umbenennen >= 0, 'das Journal wurde nicht neu geschrieben');
    assert.ok(aufrufe.slice(0, umbenennen).some((a) => a.name === 'fsyncSync' && /history\.jsonl\.tmp-/.test(a.pfad || '')),
      'Journal vor dem Umbenennen nicht gesichert');
    assert.equal(fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).length, 2);
  } finally {
    history.stop();
    await store.close().catch(() => {});
    cleanup();
  }
});

test('alte Sperre ohne rechner wird wie bisher nach der PID beurteilt', async () => {
  const { home, cleanup } = tempHome('haltbar-sperre-alt');
  try {
    sperreSchreiben(home, { pid: 1, at: new Date().toISOString() });
    await assert.rejects(() => openStore({ paths: home, logger: STILL }), /bereits von Prozess 1/);
    sperreSchreiben(home, { pid: 2147483646, at: new Date().toISOString() });
    const store = await openStore({ paths: home, logger: STILL });
    await store.close();
  } finally {
    cleanup();
  }
});

test('die eigene Sperre trägt rechner und boot', async () => {
  const { home, cleanup } = tempHome('haltbar-sperre-inhalt');
  try {
    const store = await openStore({ paths: home, logger: STILL });
    const sperre = JSON.parse(fs.readFileSync(path.join(pathsMod.layout(home).vault, '.lock'), 'utf8'));
    assert.equal(sperre.pid, process.pid);
    assert.equal(sperre.rechner, rechner.kennung());
    assert.ok(rechner.gleicherStart(sperre.boot, rechner.bootZeit()));
    assert.equal(sperre.scope, 'store');
    assert.ok(!Number.isNaN(Date.parse(sperre.at)));
    await store.close();
  } finally {
    cleanup();
  }
});

/* ---------------------------- Konfiguration ohne tote Anbieter-Vorgaben */

const TOTE_ANBIETER = [
  { id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true },
  { id: 'llamacpp', kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true },
  { id: 'lmstudio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
];

test('defaults() nennt keine lokalen Modellserver mehr', () => {
  const d = configMod.defaults();
  assert.deepEqual(d.models.providers, []);
  assert.ok(!/ollama|llamacpp|lmstudio|11434|:8080|:1234/.test(JSON.stringify(d)));
});

test('alte config.json mit ollama/llamacpp/lmstudio lädt, die toten Einträge fallen weg, der Rest bleibt', () => {
  const { home, cleanup } = tempHome('haltbar-config-alt');
  try {
    const ziel = path.join(home, 'config.json');
    const eigener = { id: 'mein-server', kind: 'openai', baseUrl: 'http://127.0.0.1:9999/v1', enabled: false };
    const alt = {
      version: 1,
      server: { host: '127.0.0.1', port: 23456 },
      network: { mode: 'offline' },
      models: { providers: [...TOTE_ANBIETER, eigener], default: { provider: 'ollama', model: 'llama3.2' }, remote: [] },
      ui: { theme: 'dark' },
    };
    fs.writeFileSync(ziel, JSON.stringify(alt, null, 2));
    const config = configMod.load(ziel);
    assert.deepEqual(config.models.providers, [eigener]);
    assert.equal(config.models.default, null, 'Standardmodell zeigt noch auf einen entfernten Anbieter');
    assert.equal(config.server.port, 23456);
    assert.equal(config.ui.theme, 'dark');
    assert.equal(configMod.validateConfig(config), true);

    // Einmal gespeichert, stehen sie auch nicht mehr in der Datei.
    configMod.save(ziel, config);
    assert.ok(!/ollama|llamacpp|lmstudio/.test(fs.readFileSync(ziel, 'utf8')));
  } finally {
    cleanup();
  }
});

test('alte config.json mit genau den drei Vorgaben und fremdem Standardmodell', () => {
  const { home, cleanup } = tempHome('haltbar-config-alt2');
  try {
    const ziel = path.join(home, 'config.json');
    fs.writeFileSync(ziel, JSON.stringify({
      models: { providers: TOTE_ANBIETER, default: { provider: 'claude', model: 'claude-sonnet-4-5' } },
    }));
    const config = configMod.load(ziel);
    assert.deepEqual(config.models.providers, []);
    assert.deepEqual(config.models.default, { provider: 'claude', model: 'claude-sonnet-4-5' });
    // Kaputte Formen brechen das Laden nicht.
    fs.writeFileSync(ziel, JSON.stringify({ models: { providers: 'ollama', default: 'ollama/llama3.2' } }));
    const schief = configMod.load(ziel);
    assert.equal(schief.models.providers, 'ollama');
    assert.equal(schief.models.default, null);
  } finally {
    cleanup();
  }
});
