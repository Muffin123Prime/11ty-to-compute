'use strict';

/**
 * Paket I (docs/STICK-BAUPLAN.md, Abschnitt 2.6): Jede KI hat genau eine
 * Kennung, einen Namen und einen eigenen Port; ein Tab einer fremden KI wird
 * abgewiesen; ein kopierter Datenordner bekommt eine neue Identität; frische
 * Sticks haben identische Startinhalte.
 *
 * Die ersten sieben Tests sind die im Bauplan genannten. Die übrigen sichern
 * die Kanten ab, auf die sich W1 (Oberfläche) und K1 (Koppeln) verlassen.
 *
 * Ein Temp-Stick ist ein Ordner mit Marker und `data/`. Damit `createApp`
 * ihn als Stick erkennt, bekommt es `appDir` (wo das Programm läge); von dort
 * sucht `detectPortable` den Marker, genau wie vom echten Programmordner aus.
 * `home` wird trotzdem immer ausdrücklich übergeben: Ein Test darf nie im
 * echten Heimordner landen, auch nicht, wenn `appDir` einmal nicht wirkt.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { test, tempHome } = require('./harness');

const { createApp, seedIfEmpty } = require('../src/app');
const pathsMod = require('../src/kernel/paths');
const { kiPort } = require('../src/kernel/identitaet');
const merge = require('../src/sync/merge');

const ID_RE = /^dev_[0-9a-f]{24}$/;
const FREMD = `dev_${'f'.repeat(24)}`;

/* ------------------------------------------------------------- Helfer */

function request(base, method, urlPath, body, headers = {}) {
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
        ...headers,
      },
    }, (res) => {
      // Ein Ereignisstrom endet nie von selbst: der Kopf reicht als Antwort.
      if (String(res.headers['content-type'] || '').startsWith('text/event-stream')) {
        res.destroy();
        resolve({ status: res.statusCode, headers: res.headers, text: '', json: null });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Ein Stick mit Marker, wie ihn "Stick vorbereiten" anlegt. */
function tempStick(label, marker = {}) {
  const t = tempHome(`eigene-ki-${label}`);
  const root = t.home;
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, pathsMod.PORTABLE_MARKER), JSON.stringify({
    neuralOsPortable: true,
    dataDir: 'data',
    appDir: 'app',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...marker,
  }, null, 2));
  return {
    ...t,
    root,
    data: path.join(root, 'data'),
    appDir: path.join(root, 'app'),
    marker: () => JSON.parse(fs.readFileSync(path.join(root, pathsMod.PORTABLE_MARKER), 'utf8')),
  };
}

function starteAufStick(stick, extra = {}) {
  return createApp({
    home: stick.data, appDir: stick.appDir, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, ...extra,
  });
}

async function mitServer(app, fn) {
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  return fn(base);
}

/** Alle Sätze, die beim Koppeln reisen, als `id -> fingerprint`. */
function abgleichbar(app) {
  const out = new Map();
  for (const type of merge.SYNC_TYPES) {
    for (const r of app.store.all(type)) out.set(r.id, merge.fingerprint(r));
  }
  return out;
}

/* --------------------------------------------------- Tests aus dem Bauplan */

test('zwei Temp-Sticks: verschiedene ki.id, beide Ports in 20000–29999 und nicht 7777', async () => {
  const a = tempStick('a');
  const b = tempStick('b');
  let appA = null;
  let appB = null;
  try {
    appA = await starteAufStick(a);
    appB = await starteAufStick(b);
    assert.ok(appA.portable, 'Stick A wird nicht als Stick erkannt');
    assert.ok(appB.portable, 'Stick B wird nicht als Stick erkannt');
    assert.ok(appA.ki && ID_RE.test(appA.ki.id), `ki.id von A: ${appA.ki && appA.ki.id}`);
    assert.ok(appB.ki && ID_RE.test(appB.ki.id), `ki.id von B: ${appB.ki && appB.ki.id}`);
    assert.notEqual(appA.ki.id, appB.ki.id);
    for (const app of [appA, appB]) {
      const port = app.config.server.port;
      assert.ok(port >= 20000 && port <= 29999, `Port ${port}`);
      assert.notEqual(port, 7777);
      assert.equal(port, kiPort(app.ki.id));
      assert.equal(app.identitaet.port, port);
    }
    // Gespeichert, nicht nur im Speicher, und im Marker für andere Sticks lesbar.
    assert.equal(JSON.parse(fs.readFileSync(path.join(a.data, 'config.json'), 'utf8')).server.port, appA.config.server.port);
    assert.equal(a.marker().kiId, appA.ki.id);
    assert.equal(a.marker().name, appA.ki.name);
    assert.equal(a.marker().createdAt, '2026-09-01T10:00:00.000Z', 'vorhandene Marker-Felder bleiben');
  } finally {
    if (appA) await appA.close().catch(() => {});
    if (appB) await appB.close().catch(() => {});
    a.cleanup();
    b.cleanup();
  }
});

test('data/ von Stick X nach Stick Y kopiert: beim Start neue ID, sync-folder.json fehlt', async () => {
  const x = tempStick('x');
  const y = tempStick('y', { kiId: `dev_${'c'.repeat(24)}`, name: 'Lena' });
  let app = null;
  try {
    app = await starteAufStick(x);
    const idX = app.ki.id;
    await app.close();
    app = null;
    fs.writeFileSync(path.join(x.data, 'sync-folder.json'), '{"alt":true}');
    fs.writeFileSync(path.join(x.data, 'kopplungen.json'), '{"v":1,"partner":[]}');

    fs.cpSync(x.data, y.data, { recursive: true });
    app = await starteAufStick(y);
    assert.ok(ID_RE.test(app.ki.id));
    assert.notEqual(app.ki.id, idX, 'die Kopie trägt noch die Kennung von X');
    assert.notEqual(app.ki.id, `dev_${'c'.repeat(24)}`);
    assert.equal(fs.existsSync(path.join(y.data, 'sync-folder.json')), false, 'sync-folder.json der alten KI liegt noch da');
    assert.equal(fs.existsSync(path.join(y.data, 'kopplungen.json')), false, 'kopplungen.json der alten KI liegt noch da');
    assert.equal(y.marker().kiId, app.ki.id);
    assert.equal(app.config.server.port, kiPort(app.ki.id));
    assert.ok(app.bus.since(0).some((e) => e.name === 'ki.erneuert' && e.payload.grund === 'daten-kopiert'),
      'ki.erneuert wurde nicht gemeldet');
    // Das Original bleibt, wie es ist.
    assert.equal(fs.existsSync(path.join(x.data, 'sync-folder.json')), true);
    assert.equal(x.marker().kiId, idX);
  } finally {
    if (app) await app.close().catch(() => {});
    x.cleanup();
    y.cleanup();
  }
});

test('GET /api/status: fremde Kennung -> 409, "1" -> 200, ohne Kopf -> 200', async () => {
  const { home, cleanup } = tempHome('eigene-ki-status');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    await mitServer(app, async (base) => {
      const fremd = await request(base, 'GET', '/api/status', undefined, { 'x-neural-os': FREMD });
      assert.equal(fremd.status, 409, `fremde Kennung: HTTP ${fremd.status}`);
      assert.equal(fremd.json.error.code, 'KI_GEWECHSELT');
      assert.equal(fremd.json.error.message, 'Dieser Tab gehört zu einer anderen KI.');

      const eins = await request(base, 'GET', '/api/status', undefined, { 'x-neural-os': '1' });
      assert.equal(eins.status, 200);
      const ohne = await request(base, 'GET', '/api/status');
      assert.equal(ohne.status, 200);
      const eigen = await request(base, 'GET', '/api/status', undefined, { 'x-neural-os': app.ki.id });
      assert.equal(eigen.status, 200, 'die eigene Kennung muss durchgehen');

      // /api/status nennt die KI, damit der Tab ihre Kennung lernt.
      assert.deepEqual(ohne.json.ki, { id: app.ki.id, name: app.ki.name });
      // Die Zustandsabfrage liegt davor und bleibt frei.
      const health = await request(base, 'GET', '/api/health', undefined, { 'x-neural-os': FREMD });
      assert.equal(health.status, 200);
    });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});

test('POST /api/chats mit fremder Kennung -> 409, und es entsteht kein Chat', async () => {
  const { home, cleanup } = tempHome('eigene-ki-chat');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    await mitServer(app, async (base) => {
      const vorher = app.store.count('chat');
      const fremd = await request(base, 'POST', '/api/chats', { title: 'aus dem alten Tab' }, { 'x-neural-os': FREMD });
      assert.equal(fremd.status, 409, `fremde Kennung: HTTP ${fremd.status}`);
      assert.equal(app.store.count('chat'), vorher, 'der alte Tab hat in diese KI geschrieben');

      const eigen = await request(base, 'POST', '/api/chats', { title: 'aus dem eigenen Tab' }, { 'x-neural-os': app.ki.id });
      assert.equal(eigen.status, 200, `eigene Kennung: HTTP ${eigen.status} ${eigen.text.slice(0, 200)}`);
      assert.equal(app.store.count('chat'), vorher + 1);
    });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});

test('seedIfEmpty auf zwei frischen Homes: gleiche IDs, gleicher fingerprint je Satz', async () => {
  const eins = tempHome('eigene-ki-saat-1');
  const zwei = tempHome('eigene-ki-saat-2');
  let a = null;
  let b = null;
  try {
    a = await createApp({ home: eins.home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    b = await createApp({ home: zwei.home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    assert.equal(await seedIfEmpty(a), true);
    assert.equal(await seedIfEmpty(b), true);

    const fa = abgleichbar(a);
    const fb = abgleichbar(b);
    assert.ok(fa.size >= 6, `zu wenige Startsätze: ${fa.size}`);
    assert.deepEqual([...fa.keys()].sort(), [...fb.keys()].sort(), 'die IDs der Startinhalte unterscheiden sich');
    for (const [id, h] of fa) assert.equal(fb.get(id), h, `${id} ist auf beiden Homes verschieden`);
    for (const id of fa.keys()) assert.match(id, /^[a-z]+_[0-9a-z]{24}$/, `${id} hat nicht das Format mit 24 Zeichen`);

    // Kein Pfad im Text: der wäre auf jedem Stick ein anderer.
    for (const note of a.store.all('note')) {
      assert.ok(!note.data.body.includes(eins.home), `Pfad in "${note.data.title}"`);
    }
  } finally {
    if (a) await a.close().catch(() => {});
    if (b) await b.close().catch(() => {});
    eins.cleanup();
    zwei.cleanup();
  }
});

test('NEURAL_OS_HOME=/anderswo + Marker: home ist das data/ des Sticks', () => {
  const stick = tempStick('env');
  try {
    const env = { NEURAL_OS_HOME: path.join(stick.root, 'anderswo') };
    assert.equal(pathsMod.resolveHome(undefined, { von: stick.appDir, env }), stick.data);
    assert.equal(pathsMod.layout(undefined, { von: stick.appDir, env }).home, stick.data);
    // Ein ausdrückliches --home gewinnt weiter.
    const ausdruecklich = path.join(stick.root, 'ausdruecklich');
    assert.equal(pathsMod.resolveHome(ausdruecklich, { von: stick.appDir, env }), ausdruecklich);
    // Ohne Stick gilt NEURAL_OS_HOME wie bisher.
    const ohneStick = tempHome('eigene-ki-ohne-stick');
    try {
      assert.equal(pathsMod.resolveHome(undefined, { von: ohneStick.home, env }), env.NEURAL_OS_HOME);
    } finally {
      ohneStick.cleanup();
    }
  } finally {
    stick.cleanup();
  }
});

test('createApp auf dem Stick mit NEURAL_OS_HOME woanders: Stick-data/ und eine Zeile Hinweis', async () => {
  const stick = tempStick('env-app');
  const vorher = process.env.NEURAL_OS_HOME;
  const anderswo = path.join(stick.root, 'anderswo');
  let app = null;
  try {
    process.env.NEURAL_OS_HOME = anderswo;
    app = await createApp({ appDir: stick.appDir, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    assert.equal(app.paths.home, stick.data);
    assert.ok(app.portable, 'als Stick erkannt');
    assert.equal(app.homeHinweis, `NEURAL_OS_HOME zeigt auf ${anderswo}, der Stick gewinnt.`);
    assert.equal(fs.existsSync(anderswo), false, 'in NEURAL_OS_HOME wurde trotzdem geschrieben');
  } finally {
    if (vorher === undefined) delete process.env.NEURAL_OS_HOME;
    else process.env.NEURAL_OS_HOME = vorher;
    if (app) await app.close().catch(() => {});
    stick.cleanup();
  }
});

test('portableInfo: e:\\data gegen E:\\data mit path.win32 wird erkannt', () => {
  const gefunden = {
    root: 'E:\\', dataDir: 'E:\\data', marker: 'E:\\neural-os.portable', info: { neuralOsPortable: true },
  };
  assert.equal(pathsMod.portableInfo('e:\\data', { pfad: path.win32, gefunden }), gefunden);
  assert.equal(pathsMod.portableInfo('E:\\data\\', { pfad: path.win32, gefunden }), gefunden);
  assert.equal(pathsMod.portableInfo('E:\\daten', { pfad: path.win32, gefunden }), null);
});

/* ---------------------------------------------------- weitere Absicherung */

test('portableInfo: am Mac ohne Groß/Klein, unter Linux mit', () => {
  const gefunden = { root: '/Volumes/LENA', dataDir: '/Volumes/LENA/data', marker: '/Volumes/LENA/neural-os.portable', info: {} };
  assert.equal(pathsMod.portableInfo('/Volumes/lena/DATA', { pfad: path.posix, plattform: 'darwin', gefunden }), gefunden);
  assert.equal(pathsMod.portableInfo('/Volumes/lena/DATA', { pfad: path.posix, plattform: 'linux', gefunden }), null);
  assert.equal(pathsMod.portableInfo('/Volumes/LENA/data/', { pfad: path.posix, plattform: 'linux', gefunden }), gefunden);
});

test('die Heim-Installation bleibt bei 7777 und bekommt trotzdem Kennung und Namen', async () => {
  const { home, cleanup } = tempHome('eigene-ki-heim');
  let app = null;
  try {
    app = await createApp({ home, logLevel: 'error', harden: false });
    assert.equal(app.portable, null);
    assert.equal(app.config.server.port, 7777);
    assert.ok(ID_RE.test(app.ki.id));
    assert.equal(typeof app.ki.name, 'string');
    assert.ok(app.ki.name.length > 0);
    // Der Abgleich fragt dieselbe Identität, nicht eine eigene.
    assert.equal(app.sync.deviceId, app.ki.id);
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});

test('POST /api/ki/name benennt die KI um, im Marker und sofort in /api/status', async () => {
  const stick = tempStick('name');
  let app = null;
  try {
    app = await starteAufStick(stick);
    await mitServer(app, async (base) => {
      const r = await request(base, 'POST', '/api/ki/name', { name: '  Lena  ' }, { 'x-neural-os': '1' });
      assert.equal(r.status, 200, `HTTP ${r.status} ${r.text.slice(0, 200)}`);
      assert.deepEqual(r.json.ki, { id: app.ki.id, name: 'Lena' });
      assert.equal(app.ki.name, 'Lena');
      assert.equal(stick.marker().name, 'Lena');
      const status = await request(base, 'GET', '/api/status');
      assert.equal(status.json.ki.name, 'Lena');

      const leer = await request(base, 'POST', '/api/ki/name', { name: '   ' }, { 'x-neural-os': '1' });
      assert.equal(leer.status, 400);
      const ohneKopf = await request(base, 'POST', '/api/ki/name', { name: 'Tom' });
      assert.equal(ohneKopf.status, 403, 'ohne X-Neural-OS darf nichts geändert werden');
      assert.equal(app.ki.name, 'Lena');
    });
  } finally {
    if (app) await app.close().catch(() => {});
    stick.cleanup();
  }
});

test('ein offener Ereignisstrom einer fremden KI wird abgewiesen', async () => {
  const { home, cleanup } = tempHome('eigene-ki-sse');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    await mitServer(app, async (base) => {
      const fremd = await request(base, 'GET', '/api/events', undefined, { 'x-neural-os': FREMD, accept: 'text/event-stream' });
      assert.equal(fremd.status, 409);
      const eigen = await request(base, 'GET', '/api/events', undefined, { 'x-neural-os': app.ki.id, accept: 'text/event-stream' });
      assert.equal(eigen.status, 200);
    });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});

test('seedIfEmpty sät nicht, wenn eine Kopplung besteht oder ein Angebot wartet', async () => {
  const heim = tempHome('eigene-ki-gekoppelt');
  const stick = tempStick('angebot');
  let a = null;
  let b = null;
  try {
    fs.writeFileSync(path.join(heim.home, 'kopplungen.json'), '{"v":1,"partner":[]}');
    a = await createApp({ home: heim.home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    assert.equal(await seedIfEmpty(a), false);
    assert.equal(a.store.count('note'), 0);

    fs.mkdirSync(path.join(stick.root, 'sync', 'koppeln'), { recursive: true });
    fs.writeFileSync(path.join(stick.root, 'sync', 'koppeln', `${FREMD}.angebot`), '{}');
    b = await starteAufStick(stick);
    assert.equal(await seedIfEmpty(b), false);
    assert.equal(b.store.count('note'), 0);
  } finally {
    if (a) await a.close().catch(() => {});
    if (b) await b.close().catch(() => {});
    heim.cleanup();
    stick.cleanup();
  }
});

test('Startinhalte: kein "Online"-Schalter, kein Ollama, und die Ableitung ändert nichts mehr', async () => {
  const { home, cleanup } = tempHome('eigene-ki-text');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    await seedIfEmpty(app);
    const texte = app.store.all('note').map((n) => `${n.data.title}\n${n.data.body}`).join('\n');
    assert.ok(!/„Online“ schalten|Oben auf/.test(texte), 'der Online-Schalter oben existiert nicht mehr');
    assert.ok(!/ollama/i.test(texte));

    // Die festen Kanten sind genau die, die die Ableitung selbst ziehen würde:
    // ein späteres "neu ableiten" darf nichts anlegen, löschen oder umschreiben,
    // sonst hätten zwei Sticks wieder verschiedene Kanten.
    const vorher = abgleichbar(app);
    const r = app.graph.scanAll(app.store);
    assert.equal(r.created, 0, `angelegt: ${r.created}`);
    assert.equal(r.removed, 0, `entfernt: ${r.removed}`);
    assert.equal(r.updated, 0, `umgeschrieben: ${r.updated}`);
    assert.deepEqual(abgleichbar(app), vorher);
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});
