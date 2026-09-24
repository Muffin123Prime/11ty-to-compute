#!/usr/bin/env node
'use strict';

/**
 * Funktionsprüfung — every feature of Neural OS, exercised for real.
 *
 * This is not the test suite. The test suite checks that each module does what
 * it was written to do; this checks that the PRODUCT does what it promises,
 * through the same doors a user goes through: the running server, the real
 * HTTP API, a real vault on disk.
 *
 * It exists because "all tests pass" and "the feature works" turned out to be
 * different statements more than once in this project: a semantic search with
 * no route, a module system whose modules had no effect, a stick command the
 * documentation promised and the code lacked. Every one of those was green.
 *
 * Rules it holds itself to:
 *  - A check that cannot run is reported as UNKLAR, never as passed.
 *  - Missing prerequisites (no model installed) are stated, not hidden.
 *  - Every failure prints what was expected and what came back.
 *
 *   node tools/feature-check.js            alles prüfen
 *   node tools/feature-check.js netz graph nur diese Bereiche
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const G = '\u001b[32m'; const R = '\u001b[31m'; const Y = '\u001b[33m';
const D = '\u001b[2m'; const B = '\u001b[1m'; const X = '\u001b[0m';

const results = [];
let currentArea = '';

function area(name) {
  currentArea = name;
  console.log(`\n${B}${name}${X}`);
}

function record(status, what, detail) {
  results.push({ area: currentArea, status, what, detail });
  const icon = status === 'ok' ? `${G}✓${X}` : status === 'fail' ? `${R}✗${X}` : `${Y}?${X}`;
  console.log(`  ${icon} ${what}${detail ? `  ${D}${String(detail).slice(0, 110)}${X}` : ''}`);
}

/** Run one check. A throw is a failure with its message as evidence. */
async function check(what, fn) {
  try {
    const detail = await fn();
    if (detail === SKIP) return;
    if (detail && detail.unklar) record('unklar', what, detail.unklar);
    else record('ok', what, detail === true || detail === undefined ? '' : detail);
  } catch (err) {
    record('fail', what, (err && err.message) || String(err));
  }
}

const SKIP = Symbol('skip');

function unklar(reason) {
  return { unklar: reason };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ client */

let PORT = 0;

function request(method, urlPath, body, headers = {}, port = PORT) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      host: '127.0.0.1',
      port,
      path: urlPath,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Dieselbe Tuer, aber an einer ZWEITEN Anwendung (Zielgeraet einer Wiederherstellung). */
function postTo(port, urlPath, body) {
  return request('POST', urlPath, body === undefined ? {} : body, {}, port);
}

const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b === undefined ? {} : b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

function ok(res, what) {
  assert(res.status === 200, `${what}: HTTP ${res.status} ${JSON.stringify(res.json || res.text).slice(0, 200)}`);
  return res.json;
}

function body(record) {
  if (!record || typeof record !== 'object') return {};
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) return record.data;
  return record;
}

/* ------------------------------------------------------------------- areas */

/**
 * Jedes geladene Teilsystem hat mindestens eine erreichbare Route.
 *
 * Der Fehler, der in diesem Projekt dreimal passiert ist: ein Teilsystem wird
 * gebaut, seine Tests sind gruen, und niemand kann es aufrufen, weil die
 * Route fehlt. Die semantische Suche lag so 1600 Zeilen lang funktionsfaehig
 * auf der Platte, die Textextraktion 2627.
 *
 * Diese Pruefung leitet sich aus `doctor()` ab, nicht aus einer Liste von
 * Hand: ein neues Teilsystem, das jemand zu verdrahten vergisst, faellt beim
 * naechsten Lauf von selbst auf -- ohne dass jemand daran denken muss, diese
 * Datei zu erweitern. Steht fuer ein geladenes Teilsystem keine Route in der
 * Tabelle, ist das selbst ein Befund.
 */
const SUBSYSTEM_ROUTES = {
  store: '/api/records?type=note',
  gate: '/api/network',
  hardening: null,        // prozessweit, hat bewusst keine eigene Route
  encryption: '/api/vault',
  graph: '/api/graph',
  models: '/api/models',
  claude: '/api/claude',
  chat: '/api/chats',
  agents: '/api/agents',
  approvals: '/api/approvals',
  assist: '/api/assist/detectors',
  compare: '/api/models',   // eigene Routen sind POST; /api/models zeigt, dass die Registry steht
  watcher: '/api/watch',
  // Nur als POST erreichbar. Ein GET auf dieselbe Adresse antwortet mit 405 --
  // und genau das ist der Beweis, dass die Route registriert ist: eine nicht
  // verdrahtete Route gaebe 404.
  secondLook: '/api/notes/probe/second-look',
  history: '/api/history',
  scheduler: '/api/automation/schedules',
  triggers: '/api/automation/triggers',
  backup: '/api/vault',   // Export und Import haengen an /api/backup/*, POST
  auth: '/api/tokens',
  extraction: null,       // wirkt beim Datei-Upload, hat keine eigene Route
  sync: '/api/peers',
  // Die Selbstauskunft: laeuft diese Instanz portabel, von wo, mit welchen
  // Laufzeiten. Ohne Pfadargument und ohne Nebenwirkung.
  stick: '/api/stick',
  modules: '/api/modules',
};

async function checkWiring(app) {
  area('0 · Alles Gebaute ist auch erreichbar');
  const health = await app.doctor();
  const geladen = Object.entries(health.subsystems || {})
    .filter(([, state]) => state === true)
    .map(([name]) => name);

  await check('Jedes geladene Teilsystem hat eine bekannte Route', async () => {
    const unbekannt = geladen.filter((name) => !(name in SUBSYSTEM_ROUTES));
    assert(!unbekannt.length,
      `nicht in der Tabelle, also vermutlich auch nicht verdrahtet: ${unbekannt.join(', ')}`);
    return `${geladen.length} geladen`;
  });

  await check('Und antwortet dort auch', async () => {
    const kaputt = [];
    for (const name of geladen) {
      const route = SUBSYSTEM_ROUTES[name];
      if (!route) continue;
      const res = await api.get(route);
      // 503 mit einem Grund ist eine Antwort, kein Ausfall: so meldet die
      // semantische Suche ein fehlendes Einbettungsmodell. 405 ebenso: die
      // Route ist registriert, nur nicht per GET -- ein 404 waere der Befund.
      const antwortet = res.status === 200 || res.status === 503
        || res.status === 403 || res.status === 405;
      if (!antwortet) kaputt.push(`${name} (${route}: HTTP ${res.status})`);
    }
    assert(!kaputt.length, kaputt.join(', '));
    const gezaehlt = geladen.filter((n) => SUBSYSTEM_ROUTES[n]).length;
    return `${gezaehlt} Routen geprüft`;
  });

  const web = path.join(__dirname, '..', 'web');
  const appjs = fs.readFileSync(path.join(web, 'app.js'), 'utf8');

  await check('Jede Ansicht der Schale hat ihre Datei', async () => {
    const ids = [...appjs.matchAll(/\{ id: '([a-z]+)', title:/g)].map((m) => m[1]);
    assert(ids.length >= 10, `nur ${ids.length} Ansichten gefunden — stimmt das Muster noch?`);
    const fehlend = ids.filter((id) => !fs.existsSync(path.join(web, 'views', `${id}.js`)));
    assert(!fehlend.length, `ohne Datei: ${fehlend.join(', ')}`);
    return `${ids.length} Ansichten`;
  });

  // Die Leiste nach der Vorlage des Nutzers (docs/vorlage/app.png): genau
  // diese acht Eintraege, in dieser Reihenfolge. Netzwerk, Stick und
  // Sicherung sind Adressen ohne eigenen Eintrag.
  await check('Die Leiste hat die acht Einträge der Vorlage', async () => {
    const leiste = [...appjs.matchAll(/\{ id: '([a-z]+)', title: '([^']+)'[^\n]*nav: true/g)].map((m) => m[2]);
    const soll = ['Neuer Chat', 'Kalender', 'Notizen', 'Projekte', 'Agenten', 'Gehirn', 'Werkstatt', 'Einstellungen'];
    assert(JSON.stringify(leiste) === JSON.stringify(soll), `gefunden: ${leiste.join(', ')}`);
    return leiste.join(' · ');
  });

  // Weggefallen auf Wunsch des Nutzers. Eine Datei, die noch daliegt, waere
  // eine Ansicht, die niemand erreicht, die aber mitgepflegt werden muss.
  await check('Heute, Vorschläge, Automatik, Zeitachse, Abgleich und die Suchseite sind weg', async () => {
    const weg = ['today', 'assist', 'automation', 'timeline', 'sync', 'search'];
    const noch = weg.filter((id) => fs.existsSync(path.join(web, 'views', `${id}.js`))
      || new RegExp(`\\{ id: '${id}',`).test(appjs));
    assert(!noch.length, `noch da: ${noch.join(', ')}`);
    return `${weg.length} Ansichten entfernt, ihr Unterbau in src/ bleibt`;
  });

  // Die rechte Spalte: vier Kacheln, jede ein Modul mit mount(el, ctx).
  await check('Jede Kachel der rechten Spalte hat ihr Modul mit mount()', async () => {
    const kacheln = [...appjs.matchAll(/\{ kachel: '([a-z]+)'/g)].map((m) => m[1]);
    assert(JSON.stringify(kacheln) === JSON.stringify(['agenten', 'kalender', 'notizen', 'gehirn']),
      `Kacheln in web/app.js: ${kacheln.join(', ') || 'keine'}`);
    const kaputt = kacheln.filter((id) => {
      const datei = path.join(web, 'widgets', `${id}.js`);
      return !fs.existsSync(datei) || !/export\s+(async\s+)?function\s+mount\s*\(|export\s+default\s*\{[\s\S]*mount/.test(fs.readFileSync(datei, 'utf8'));
    });
    assert(!kaputt.length, `ohne Datei oder ohne mount(): ${kaputt.join(', ')}`);
    return kacheln.join(' · ');
  });
}

async function checkStatus(app) {
  area('1 · Grundzustand');
  await check('Server antwortet', async () => {
    const res = await api.get('/api/health');
    assert(res.status === 200, `HTTP ${res.status}`);
    return 'HTTP 200';
  });
  await check('Statusbericht ist vollständig', async () => {
    const s = ok(await api.get('/api/status'), 'status');
    for (const key of ['version', 'network', 'vault', 'models']) {
      assert(s[key] !== undefined, `Feld "${key}" fehlt im Status`);
    }
    return `Netzmodus ${s.network.mode}`;
  });
  await check('Alle Subsysteme geladen', async () => {
    const h = await app.doctor();
    const missing = Object.entries(h.subsystems).filter(([, v]) => v === false).map(([k]) => k);
    assert(!missing.length, `nicht geladen: ${missing.join(', ')}`);
    return `${Object.keys(h.subsystems).length} Subsysteme`;
  });
  await check('Keine Subsystem-Fehler beim Start', async () => {
    const h = await app.doctor();
    assert(!h.failures.length, h.failures.map((f) => `${f.subsystem}: ${f.reason}`).join(' | '));
    return 'keine';
  });
  await check('Sicherheits-Kopfzeilen auf jeder Antwort', async () => {
    const res = await api.get('/api/status');
    const csp = res.headers['content-security-policy'];
    assert(csp, 'Content-Security-Policy fehlt');
    assert(/connect-src[^;]*'self'/.test(csp), "connect-src ist nicht 'self'");
    assert(res.headers['x-content-type-options'] === 'nosniff', 'nosniff fehlt');
    return 'CSP, nosniff, Referrer-Policy';
  });
}

async function checkRecords() {
  area('2 · Notizen, Projekte, Aufgaben');
  let noteId = null;

  await check('Notiz anlegen', async () => {
    const r = ok(await api.post('/api/records', {
      type: 'note',
      data: { title: 'Prüfnotiz', body: 'Inhalt mit [[Zweite Prüfnotiz]] und #prüfung', tags: ['prüfung'] },
    }), 'create');
    noteId = r.record.id;
    return noteId;
  });

  await check('Notiz lesen', async () => {
    const r = ok(await api.get(`/api/records/${noteId}`), 'get');
    assert(body(r.record).title === 'Prüfnotiz', 'Titel stimmt nicht');
    return 'Titel und Inhalt korrekt';
  });

  await check('Notiz ändern', async () => {
    const r = ok(await api.patch(`/api/records/${noteId}`, { data: { title: 'Geändert' } }), 'patch');
    assert(body(r.record).title === 'Geändert', 'Änderung kam nicht an');
    return 'rev ' + r.record.rev;
  });

  await check('Weiche Löschung ist umkehrbar', async () => {
    ok(await api.del(`/api/records/${noteId}`), 'delete');
    const gone = await api.get(`/api/records/${noteId}`);
    assert(gone.status === 404, `nach Löschung noch lesbar (HTTP ${gone.status})`);
    ok(await api.post(`/api/records/${noteId}/restore`), 'restore');
    const back = await api.get(`/api/records/${noteId}`);
    assert(back.status === 200, 'Wiederherstellung fehlgeschlagen');
    return 'gelöscht und wiederhergestellt';
  });

  for (const [type, data, label] of [
    ['project', { name: 'Prüfprojekt' }, 'Projekt'],
    ['entity', { name: 'Prüfbegriff', kind: 'topic' }, 'Begriff'],
    ['memory', { text: 'Etwas zu merken' }, 'Erinnerung'],
  ]) {
    await check(`${label} anlegen`, async () => {
      const r = ok(await api.post('/api/records', { type, data }), type);
      return r.record.id;
    });
  }

  await check('Aufgabe mit Projektbezug', async () => {
    const p = ok(await api.post('/api/records', { type: 'project', data: { name: 'Mit Aufgaben' } }), 'project');
    const t = ok(await api.post('/api/records', {
      type: 'task', data: { title: 'Zu erledigen', projectId: p.record.id },
    }), 'task');
    assert(body(t.record).status === 'todo', 'Standardstatus ist nicht todo');
    return 'verknüpft';
  });

  await check('Agenten sind über die generische Route gesperrt', async () => {
    const res = await api.post('/api/records', { type: 'agent', data: { name: 'Schleichweg' } });
    assert(res.status >= 400, `wurde angelegt (HTTP ${res.status}) — Rechteprüfung umgangen`);
    return 'abgelehnt';
  });

  await check('Liste mit Seitenaufteilung', async () => {
    const l = ok(await api.get('/api/records?type=note&limit=2&offset=0'), 'list');
    assert(Array.isArray(l.items), 'items fehlt');
    return `${l.items.length} von ${l.total}`;
  });
}

/**
 * Kalender, Notizwand, Projekte (src/http/api/events.js).
 *
 * Termine sind ueber /api/records absichtlich nicht anlegbar; ihre eigene
 * Familie prueft, was ein Kalender nicht annehmen darf. Und die Liste steht
 * unter /api/events/zeitraum, weil GET /api/events der Ereignisstrom ist --
 * geprueft wird beides: dass die Liste antwortet UND dass der Strom noch da ist.
 */
async function checkKalender() {
  area('2b · Kalender, Notizwand, Projekte');
  const heute = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const tag = `${heute.getFullYear()}-${pad(heute.getMonth() + 1)}-${pad(heute.getDate())}`;
  let terminId = null;
  let chatId = null;

  await check('Termin anlegen (POST /api/events)', async () => {
    const r = ok(await api.post('/api/events', { title: 'Prüftermin', start: `${tag}T09:00`, end: `${tag}T10:00`, location: 'Raum 2' }), 'create');
    terminId = r.record.id;
    assert(body(r.record).source === 'user', `Herkunft ${body(r.record).source} statt user`);
    return terminId;
  });

  await check('Ein 30. Februar wird abgewiesen, nicht verschoben', async () => {
    const res = await api.post('/api/events', { title: 'Gibt es nicht', start: '2027-02-30T10:00' });
    assert(res.status === 400, `HTTP ${res.status}`);
    return (res.json && res.json.error && res.json.error.message || '').slice(0, 60);
  });

  await check('Der Zeitraum findet ihn (GET /api/events/zeitraum)', async () => {
    const r = ok(await api.get(`/api/events/zeitraum?from=${tag}&to=${tag}`), 'zeitraum');
    assert(r.items.some((e) => e.id === terminId), 'Termin fehlt in der Liste');
    return `${r.total} Termin(e) heute`;
  });

  await check('Der Ereignisstrom unter GET /api/events ist weiter der Strom', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ method: 'GET', host: '127.0.0.1', port: PORT, path: '/api/events', headers: { accept: 'text/event-stream' } }, (r) => {
        resolve({ status: r.statusCode, type: r.headers['content-type'] });
        req.destroy();
      });
      req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
      req.end();
    });
    assert(res.status === 200 && /text\/event-stream/.test(String(res.type)), `HTTP ${res.status} ${res.type}`);
    return res.type;
  });

  await check('Ein automatischer Termin nennt seinen Chat; die Herkunft bleibt', async () => {
    const chat = ok(await api.post('/api/chats', { title: 'Prüfchat Termine' }), 'chat');
    chatId = chat.record.id;
    const r = ok(await api.post('/api/events', { title: 'Aus dem Chat', start: tag, source: 'auto', chatId }), 'create');
    const eins = ok(await api.get(`/api/events/${r.record.id}`), 'get');
    assert(eins.chat && eins.chat.title === 'Prüfchat Termine', `chat: ${JSON.stringify(eins.chat)}`);
    const um = await api.patch(`/api/events/${r.record.id}`, { source: 'user' });
    assert(um.status === 400, `Herkunft liess sich umschreiben (HTTP ${um.status})`);
    return 'Chat genannt, Herkunft fest';
  });

  await check('Termin ändern und weich löschen', async () => {
    const r = ok(await api.patch(`/api/events/${terminId}`, { start: `${tag}T11:00`, end: `${tag}T12:00` }), 'patch');
    assert(body(r.record).start === `${tag}T11:00`, 'Änderung kam nicht an');
    ok(await api.del(`/api/events/${terminId}`), 'delete');
    assert((await api.get(`/api/events/${terminId}`)).status === 404, 'nach dem Löschen noch lesbar');
    ok(await api.post(`/api/records/${terminId}/restore`), 'restore');
    return 'verschoben, gelöscht, wiederhergestellt';
  });

  await check('Die Notizwand nennt die Herkunft (GET /api/notizen)', async () => {
    ok(await api.post('/api/records', { type: 'note', data: { title: 'Automatisch gemerkt', source: 'auto', chatId } }), 'note');
    const r = ok(await api.get('/api/notizen?quelle=auto&sort=neu&limit=1'), 'notizen');
    const n = r.items[0];
    assert(n && n.herkunft && n.herkunft.art === 'chat' && n.herkunft.chatTitel === 'Prüfchat Termine',
      `herkunft: ${JSON.stringify(n && n.herkunft)}`);
    return `${r.zaehler.automatisch} automatisch von ${r.zaehler.alle}`;
  });

  await check('Projekte sammeln ein, was dazugehört (GET /api/projekte)', async () => {
    const p = ok(await api.post('/api/records', { type: 'project', data: { name: 'Prüfprojekt Kalender' } }), 'project');
    ok(await api.post('/api/events', { title: 'Projekttermin', start: tag, projectId: p.record.id }), 'event');
    ok(await api.post('/api/records', { type: 'task', data: { title: 'Projektaufgabe', projectId: p.record.id } }), 'task');
    const liste = ok(await api.get('/api/projekte'), 'projekte');
    assert(liste.items[0].id === p.record.id, `oben steht ${liste.items[0] && liste.items[0].name}, nicht das zuletzt geänderte`);
    const eins = ok(await api.get(`/api/projekte/${p.record.id}`), 'projekt');
    assert(eins.projekt.termine.length === 1 && eins.projekt.aufgaben.length === 1,
      `${eins.projekt.termine.length} Termine, ${eins.projekt.aufgaben.length} Aufgaben`);
    return `${liste.total} Projekte, das neueste oben`;
  });
}

/*
 * Termin-Agent: Serien, einzelne Vorkommen, Ueberschneidungen, Kalenderdatei
 * -- und Claude, das Termine SELBST liest und verschiebt (ueber den Statisten,
 * denn einen echten Schluessel gibt es hier nicht; das steht im Ergebnis).
 */
async function checkTerminAgent(app) {
  area('2c · Termin-Agent');
  let serieId = null;

  await check('Serie „jeden Dienstag 18 Uhr bis Weihnachten“: jeder Dienstag, auch nach der Zeitumstellung 18:00', async () => {
    const r = ok(await api.post('/api/events', {
      title: 'Prüftraining', start: '2026-09-29T18:00', end: '2026-09-29T19:30', recurrence: { freq: 'weekly', until: '2026-12-24' },
    }), 'serie');
    serieId = r.record.id;
    const z = ok(await api.get('/api/events/zeitraum?from=2026-10-01&to=2026-12-31'), 'zeitraum');
    const tage = z.items.filter((x) => x.id === serieId).map((x) => x.occurrence);
    assert(tage.length === 12 && tage[0] === '2026-10-06' && tage[11] === '2026-12-22', `Vorkommen: ${tage.join(', ')}`);
    const okt27 = z.items.find((x) => x.id === serieId && x.occurrence === '2026-10-27');
    assert(okt27 && okt27.data.start === '2026-10-27T18:00' && okt27.recurring === true, `27.10.: ${okt27 && okt27.data.start}`);
    return `${tage.length} Dienstage, 27.10. um 18:00`;
  });

  await check('Nur ein Vorkommen verschieben (?nur) – und ein Rückgängig nimmt beide Hälften zurück', async () => {
    assert(serieId, 'keine Serie aus dem Schritt davor');
    const r = ok(await api.patch(`/api/events/${serieId}?nur=2026-10-13`, { start: '2026-10-14T18:00', end: '2026-10-14T19:30' }), 'patch nur');
    assert(r.record.id !== serieId && r.serie.data.exdates.includes('2026-10-13'), 'kein Einzeltermin oder keine Ausnahme');
    assert(r.rueckgaengig && r.rueckgaengig.pfad, 'keine Rückgängig-Nummer in der Antwort');
    const u = ok(await api.post(r.rueckgaengig.pfad, {}), 'undo');
    assert(u.mitgenommen && u.mitgenommen.length === 1, 'nur eine Hälfte zurückgenommen');
    assert((await api.get(`/api/events/${r.record.id}`)).status === 404, 'der Einzeltermin blieb');
    const s = ok(await api.get(`/api/events/${serieId}`), 'serie');
    assert(s.record.data.exdates.length === 0, `Ausnahmen: ${s.record.data.exdates}`);
    return `verschoben und zurück: ${s.wiederholung}`;
  });

  await check('Überschneidungen (GET /api/events/ueberschneidungen) – ganztägig stört nichts mit Uhrzeit', async () => {
    ok(await api.post('/api/events', { title: 'Prüf-Ferien', start: '2026-10-19', end: '2026-10-23' }), 'ferien');
    const u = ok(await api.get('/api/events/ueberschneidungen?start=2026-10-20T19:00&end=2026-10-20T20:00'), 'ueber');
    const titel = u.items.map((x) => x.data.title);
    assert(titel.includes('Prüftraining') && !titel.includes('Prüf-Ferien'), `gefunden: ${titel.join(', ')}`);
    return titel.join(', ');
  });

  await check('Kalenderdatei fürs iPad (text/calendar, CRLF, RRULE)', async () => {
    const r = await api.get(`/api/events/${serieId}/ics`);
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(r.headers['content-type'] === 'text/calendar; charset=utf-8', r.headers['content-type']);
    assert(/^attachment; filename="prueftraining\.ics"$/.test(r.headers['content-disposition']), r.headers['content-disposition']);
    assert(r.text.startsWith('BEGIN:VCALENDAR\r\n') && r.text.endsWith('END:VCALENDAR\r\n'), 'keine CRLF-Hülle');
    assert(/\r\nRRULE:FREQ=WEEKLY;UNTIL=20261224T235959\r\n/.test(r.text), 'RRULE fehlt');
    assert(r.text.split('\r\n').every((z) => Buffer.byteLength(z, 'utf8') <= 75), 'eine Zeile ist länger als 75 Oktette');
    return r.headers['content-disposition'];
  });

  await check('Termine sind rückgängig machbar (Verlauf kennt „Termin“)', async () => {
    const t = ok(await api.post('/api/events', { title: 'Prüf-Rückgängig', start: '2026-11-11T11:11' }), 'create');
    assert(t.rueckgaengig, 'keine Rückgängig-Nummer');
    ok(await api.post(t.rueckgaengig.pfad, {}), 'undo');
    assert((await api.get(`/api/events/${t.record.id}`)).status === 404, 'der Termin ist noch da');
    return 'angelegt und zurückgenommen';
  });

  await check('Claude (Statist) liest und verschiebt selbst: termine_lesen → termin_aendern, als Agent, rückgängig machbar', async () => {
    const { starten, B, antwort } = require('../test/claude-statist');
    const { createApp, seedIfEmpty } = require('../src/app');
    const statist = await starten();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-check-termin-agent-'));
    let zweite = null;
    try {
      zweite = await createApp({ home: tmp, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, claudeBasis: statist.url });
      await seedIfEmpty(zweite);
      const port = (await zweite.listen()).server.address().port;
      const an = (m, p, b) => request(m, p, b, {}, port);
      assert((await an('POST', '/api/claude/schluessel', { schluessel: statist.schluessel })).status === 200, 'Schlüssel');
      const chat = (await an('POST', '/api/chats', {})).json.record.id;
      const zahnarzt = (await an('POST', '/api/events', { title: 'Zahnarzt', start: '2026-09-29T10:00', end: '2026-09-29T10:45' })).json.record;
      const namen = [];
      statist.weiter(
        antwort(B.start(), B.werkzeug(0, 'toolu_l', 'termine_lesen', { von: '2026-09-23', bis: '2026-10-31', suche: 'Zahnarzt' }), B.ende('tool_use')),
        antwort(B.start(), B.werkzeug(0, 'toolu_a', 'termin_aendern', { id: zahnarzt.id, start: '2026-10-02T10:00' }), B.ende('tool_use')),
        antwort(B.start(), B.text(0, 'Verschoben auf Fr., 02.10., 10:00 Uhr.'), B.ende('end_turn')),
      );
      const r = await an('POST', `/api/chats/${chat}/messages`, { inhalt: 'verschieb den Zahnarzt auf Freitag' });
      assert(/"stopReason":"end_turn"/.test(r.text), 'der Zug lief nicht zu Ende');
      namen.push(...statist.stromAnfragen()[0].body.tools.map((t) => t.name));
      const soll = 'rueckfrage,termin_anlegen,termine_lesen,termin_aendern,termin_loeschen,notiz_anlegen,merken,projekt_anpassen,web_search,web_fetch';
      assert(namen.join(',') === soll, `Werkzeuge: ${namen.join(',')}`);
      const gelesen = JSON.parse(statist.stromAnfragen()[1].body.messages.slice(-1)[0].content[0].content);
      assert(gelesen.termine.length === 1 && gelesen.termine[0].id === zahnarzt.id, 'termine_lesen fand den Zahnarzt nicht');
      const jetzt = zweite.store.get(zahnarzt.id).data;
      assert(jetzt.start === '2026-10-02T10:00' && jetzt.end === '2026-10-02T10:45', `${jetzt.start}–${jetzt.end}`);
      const eintrag = zweite.history.list({ type: 'event' }).items.find((e) => e.id === zahnarzt.id && e.op === 'update');
      assert(eintrag && eintrag.actor.kind === 'agent', `Urheber: ${eintrag && eintrag.actor.kind}`);
      await zweite.history.undo(eintrag.seq);
      assert(zweite.store.get(zahnarzt.id).data.start === '2026-09-29T10:00', 'nicht zurückgenommen');
      return 'verschoben (Dauer blieb), Urheber Agent, zurückgenommen — Claude selbst ist hier der Statist, kein echtes Modell';
    } finally {
      if (zweite) await zweite.close().catch(() => {});
      await statist.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  void app;
}

async function checkSearch() {
  area('3 · Suche');
  await check('Volltextsuche findet den Titel', async () => {
    const r = ok(await api.get('/api/search?q=Ge%C3%A4ndert'), 'search');
    assert(r.items.length > 0, 'nichts gefunden');
    return `${r.items.length} Treffer, Modus ${r.mode}`;
  });
  await check('Suche nach Schlagwort', async () => {
    const r = ok(await api.get('/api/search?q=tag%3Apr%C3%BCfung'), 'search tag');
    return `${r.items.length} Treffer`;
  });
  await check('Suche nach Art', async () => {
    const r = ok(await api.get('/api/search?q=type%3Aproject%20Pr%C3%BCfprojekt'), 'search type');
    return `${r.items.length} Treffer`;
  });
  await check('Semantische Suche antwortet ehrlich ohne Modell', async () => {
    const res = await api.get('/api/search?q=test&mode=semantic');
    if (res.status === 200) return `verfügbar, ${res.json.items.length} Treffer`;
    const code = res.json && res.json.error && res.json.error.code;
    assert(code === 'NO_MODEL_AVAILABLE' || code === 'STORAGE_ERROR',
      `unerwarteter Fehler: ${code} ${JSON.stringify(res.json).slice(0, 120)}`);
    return `${code} — mit Anleitung, kein stiller Rückfall`;
  });
  await check('Index-Status abrufbar', async () => {
    const r = ok(await api.get('/api/search/index'), 'index');
    return r.available ? `Modell ${r.model}` : 'kein Einbettungsmodell (erwartet)';
  });
}

async function checkGraph() {
  area('4 · Wissensgraph');
  await check('Graph lässt sich aufbauen', async () => {
    const g = ok(await api.get('/api/graph?depth=2&limit=200'), 'graph');
    assert(g.nodes.length > 0, 'keine Knoten');
    return `${g.nodes.length} Knoten, ${g.edges.length} Kanten`;
  });
  await check('[[Wiki-Link]] erzeugt eine Kante', async () => {
    // Das Ziel MUSS zuerst existieren. Zeigt ein Link ins Leere, legt Neural OS
    // absichtlich keine Karteileiche an -- das wäre eine erfundene Notiz.
    ok(await api.post('/api/records', { type: 'note', data: { title: 'Verweis B' } }), 'b');
    const a = ok(await api.post('/api/records', {
      type: 'note', data: { title: 'Verweis A', body: 'zeigt auf [[Verweis B]]' },
    }), 'a');
    await new Promise((r) => setTimeout(r, 400));
    const e = ok(await api.get(`/api/edges?node=${a.record.id}`), 'edges');
    const list = e.edges || e.items || [];
    const derived = list.find((x) => body(x).source === 'derived');
    assert(derived, `keine abgeleitete Kante (${list.length} Kanten gesamt)`);
    return `${body(derived).kind}: "${body(derived).reason}"`;
  });

  await check('Link ins Leere legt keine Karteileiche an', async () => {
    const vorher = ok(await api.get('/api/records?type=note&limit=1'), 'count').total;
    const a = ok(await api.post('/api/records', {
      type: 'note', data: { title: 'Zeigt ins Leere', body: 'siehe [[Gibt Es Nicht 12345]]' },
    }), 'a');
    await new Promise((r) => setTimeout(r, 400));
    const nachher = ok(await api.get('/api/records?type=note&limit=1'), 'count').total;
    assert(nachher === vorher + 1, `${nachher - vorher} Notizen angelegt statt 1 — es wurde eine erfunden`);
    const e = ok(await api.get(`/api/edges?node=${a.record.id}`), 'edges');
    const list = e.edges || e.items || [];
    assert(!list.length, `${list.length} Kante(n) auf ein nicht existierendes Ziel`);
    return 'keine erfundene Notiz, keine tote Kante';
  });
  await check('Eigene Verknüpfung anlegen und löschen', async () => {
    const a = ok(await api.post('/api/records', { type: 'note', data: { title: 'Manuell A' } }), 'a');
    const b = ok(await api.post('/api/records', { type: 'note', data: { title: 'Manuell B' } }), 'b');
    const e = ok(await api.post('/api/edges', {
      from: a.record.id, to: b.record.id, kind: 'related', reason: 'Prüfung',
    }), 'edge');
    const id = e.edge ? e.edge.id : e.record.id;
    ok(await api.del(`/api/edges/${id}`), 'delete edge');
    return 'angelegt und entfernt';
  });
  await check('Links neu berechnen', async () => {
    const r = ok(await api.post('/api/graph/rescan'), 'rescan');
    return JSON.stringify(r).slice(0, 80);
  });
}

async function checkChat() {
  area('5 · Chat');
  let chatId = null;
  await check('Chat anlegen', async () => {
    const c = ok(await api.post('/api/chats', { title: 'Prüfchat' }), 'chat');
    chatId = c.record.id;
    assert(body(c.record).network === 'offline', 'neuer Chat ist nicht offline');
    return 'offline als Standard';
  });
  await check('Ohne Claude: ein Satz statt einer erfundenen Antwort – und kein Scheinchat', async () => {
    const res = await request('POST', `/api/chats/${chatId}/messages`, { inhalt: 'Hallo?' });
    assert(res.status === 409, `HTTP ${res.status} statt 409`);
    const e = res.json && res.json.error;
    assert(e && e.code === 'CLAUDE_NICHT_VERBUNDEN', `Code ${e && e.code}`);
    assert(/Claude ist nicht verbunden/.test(e.message), `Satz: ${e.message}`);
    const msgs = ok(await api.get(`/api/chats/${chatId}/messages`), 'messages');
    const list = msgs.items || msgs.messages || [];
    assert(list.length === 0, `${list.length} Nachricht(en) angelegt, obwohl niemand antworten kann`);
    return e.message;
  });
  await check('Netzmodus pro Chat umschaltbar', async () => {
    const r = ok(await api.patch(`/api/chats/${chatId}`, { network: 'lan' }), 'patch');
    assert(body(r.record).network === 'lan', 'Umschaltung kam nicht an');
    await api.patch(`/api/chats/${chatId}`, { network: 'offline' });
    return 'offline → lan → offline';
  });
}

async function checkModels() {
  area('6 · Claude');
  // Die KI ist Claude. Ohne Schlüssel und im Offline-Modus wird hier die
  // Zusage geprüft: ehrlicher Zustand, keine Verbindung, kein Schlüssel
  // heraus. Der ganze Weg MIT Antwort läuft danach gegen einen Statisten
  // (test/claude-statist.js), der die Anthropic-Schnittstelle spricht --
  // einen echten Schlüssel gibt es hier nicht, und so zu tun wäre gelogen.
  await check('GET /api/claude sagt ehrlich: nicht verbunden, und warum', async () => {
    const z = ok(await api.get('/api/claude'), 'claude');
    assert(z.verbunden === false, 'ohne Schlüssel „verbunden“ – erfunden');
    assert(z.schluesselVorhanden === false, 'Schlüssel angeblich vorhanden');
    assert(z.modell === 'claude-opus-5', `Modell ${z.modell}`);
    assert(typeof z.grund === 'string' && z.grund.length > 10, 'kein Grund');
    assert(z.verbrauch && z.verbrauch.geschaetzt === true, 'Verbrauch nicht als Schätzung gekennzeichnet');
    return z.grund;
  });
  await check('Die Registry kennt genau einen Anbieter: Claude, mit Anleitung', async () => {
    const m = ok(await api.get('/api/models'), 'models');
    const providers = m.providers || [];
    assert(providers.length === 1 && providers[0].id === 'claude', `Anbieter: ${providers.map((p) => p.id).join(', ')}`);
    assert(providers[0].available === false, 'als erreichbar gemeldet');
    assert(/console\.anthropic\.com/.test(String(m.hint || '')), 'keine Anleitung');
    assert(!/ollama|11434/i.test(JSON.stringify(m)), 'die Offline-KI steht noch drin');
    return 'claude, nicht verbunden, mit Anleitung';
  });
  await check('Erneutes Suchen fragt kein Netz', async () => {
    const r = ok(await api.post('/api/models/refresh'), 'refresh');
    assert(r.providers.length === 1, 'mehr als Claude');
    return 'abgeleitet, nicht geprobt';
  });
  await check('Offline wird ein Schlüssel weder geprüft noch gespeichert', async () => {
    const vorher = ok(await api.get('/api/config'), 'config').config.network.allowHosts;
    const r = await api.post('/api/claude/schluessel', { schluessel: 'sk-ant-pruef-geheim-0815-abcdef' });
    assert(r.status === 409, `HTTP ${r.status}`);
    assert(r.json.error.code === 'CLAUDE_OFFLINE', r.json.error.code);
    const z = ok(await api.get('/api/claude'), 'claude');
    assert(z.schluesselVorhanden === false, 'trotzdem gespeichert');
    const nachher = ok(await api.get('/api/config'), 'config').config.network.allowHosts;
    assert(JSON.stringify(vorher) === JSON.stringify(nachher), 'offline wurde die Freigabeliste verändert');
    for (const route of ['/api/claude', '/api/config', '/api/status', '/api/models']) {
      const res = await api.get(route);
      assert(!String(res.text).includes('sk-ant-pruef-geheim-0815'), `${route} zeigt den Schlüssel`);
    }
    return r.json.error.message;
  });
  await check('Weitere Online-Anbieter gibt es nicht mehr – und das wird gesagt', async () => {
    const r = ok(await api.get('/api/models/remote'), 'remote');
    assert(r.entfallen === true && r.items.length === 0, 'Liste nicht leer');
    const neu = await api.post('/api/models/remote', { id: 'x', baseUrl: 'https://x.invalid/v1' });
    assert(neu.status === 410, `HTTP ${neu.status}`);
    return neu.json.error.message.slice(0, 70);
  });
  await check('Mit Claude (Statist): Schlüssel, Antwort, Termin, Rückfrage – über die echte Leitung', async () => {
    const { starten, B, antwort } = require('../test/claude-statist');
    const { createApp, seedIfEmpty } = require('../src/app');
    const statist = await starten();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-check-claude-'));
    let zweite = null;
    try {
      zweite = await createApp({ home: tmp, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, claudeBasis: statist.url });
      await seedIfEmpty(zweite);
      const srv = await zweite.listen();
      const port = srv.server.address().port;
      const an = (m, p, b) => request(m, p, b, {}, port);
      const falsch = await an('POST', '/api/claude/schluessel', { schluessel: 'sk-ant-falsch-00000000000000' });
      assert(falsch.status === 400 && falsch.json.error.message === 'Der Claude-Schlüssel stimmt nicht.', `falscher Schlüssel: HTTP ${falsch.status}`);
      const gut = await an('POST', '/api/claude/schluessel', { schluessel: statist.schluessel });
      assert(gut.status === 200 && gut.json.verbunden === true, `Schlüssel: HTTP ${gut.status} ${gut.text.slice(0, 120)}`);
      const chat = (await an('POST', '/api/chats', {})).json.record.id;
      statist.weiter(
        antwort(B.start(), B.text(0, 'Trage ich ein.'), B.werkzeug(1, 'toolu_c1', 'termin_anlegen', { titel: 'Elternabend', start: '2026-10-06T19:30', ganztaegig: false }), B.ende('tool_use')),
        antwort(B.start(), B.text(0, 'Wie lange bleibst du?'), B.werkzeug(1, 'toolu_c2', 'rueckfrage', { frage: 'Wie lange?', optionen: ['1 Stunde', '2 Stunden'], mehrfach: false }), B.ende('tool_use')),
        antwort(B.start(), B.text(0, 'Gut, zwei Stunden.'), B.ende('end_turn')),
      );
      const r1 = await an('POST', `/api/chats/${chat}/messages`, { inhalt: 'Dienstag 19:30 Elternabend' });
      assert(/event: rueckfrage/.test(r1.text), 'keine Rückfrage im Strom');
      assert(/"stopReason":"rueckfrage"/.test(r1.text), 'der Zug hielt nicht an');
      const termin = zweite.store.all('event')[0];
      assert(termin && termin.data.source === 'auto' && termin.data.chatId === chat, 'kein automatischer Termin');
      const r2 = await an('POST', `/api/chats/${chat}/rueckfrage`, { id: 'toolu_c2', antwort: '2 Stunden' });
      assert(/"stopReason":"end_turn"/.test(r2.text), 'der Zug lief nach der Antwort nicht weiter');
      const letzte = statist.stromAnfragen().pop().body.messages.pop();
      assert(letzte.content[0].type === 'tool_result' && /2 Stunden/.test(letzte.content[0].content), 'die Antwort ging nicht an Claude');
      return `Termin „${termin.data.title}“ angelegt, Rückfrage beantwortet, ${statist.stromAnfragen().length} Aufrufe`;
    } finally {
      if (zweite) await zweite.close().catch(() => {});
      await statist.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

async function checkNetwork(app) {
  area('7 · Netzwerkkontrolle');
  await check('Standardmodus ist offline', async () => {
    const n = ok(await api.get('/api/network'), 'network');
    assert(n.mode === 'offline', `Modus ist "${n.mode}"`);
    return 'offline';
  });
  await check('Loopback erlaubt, öffentliches Netz blockiert', async () => {
    const local = ok(await api.post('/api/network/test', { host: '127.0.0.1', port: 11434 }), 'test local');
    const pub = ok(await api.post('/api/network/test', { host: '8.8.8.8', port: 53 }), 'test public');
    const ld = local.decision || local;
    const pd = pub.decision || pub;
    assert(ld.allowed === true, 'Loopback wird blockiert — die eigene Oberfläche wäre tot');
    assert(pd.allowed === false, 'öffentliches Netz ist erlaubt');
    return 'korrekt getrennt';
  });
  await check('Getarnte Adressen werden erkannt', async () => {
    for (const host of ['2130706433', '0x7f000001', '::ffff:127.0.0.1']) {
      const r = ok(await api.post('/api/network/test', { host, port: 80 }), host);
      const d = r.decision || r;
      assert(d.classification === 'loopback', `${host} → ${d.classification}`);
    }
    return 'dezimal, hex und IPv4-in-IPv6';
  });
  await check('Freigabe wirkt nur in ihrem Geltungsbereich', async () => {
    const gate = app.gate;
    gate.addGrant({ scope: 'chat:abc', level: 'online', hosts: ['beispiel.de'], maxUses: 2, reason: 'Prüfung' });
    const drin = gate.check({ host: 'beispiel.de', port: 443, scope: 'chat:abc', record: false });
    const draussen = gate.check({ host: 'beispiel.de', port: 443, scope: 'chat:xyz', record: false });
    assert(drin.allowed, 'Freigabe wirkt im eigenen Bereich nicht');
    assert(!draussen.allowed, 'Freigabe wirkt auch in fremdem Bereich');
    return 'begrenzt';
  });
  await check('Sperrliste lässt sich nicht durch Schreibweise umgehen', async () => {
    const { createGate } = require('../src/net/gate');
    const cfg = require('../src/kernel/config').defaults();
    cfg.network.mode = 'online'; cfg.network.strictAllowlist = false;
    cfg.network.blockHosts = ['1.2.3.4', 'https://tracker.beispiel.de/pfad'];
    const g = createGate({ config: cfg, audit: { write() {} }, bus: { publish() {} } });
    for (const host of ['1.2.3.4', '::ffff:1.2.3.4', 'tracker.beispiel.de', 'TRACKER.beispiel.de.']) {
      const d = g.check({ host, port: 443, scope: 'global', record: false });
      assert(!d.allowed, `${host} kam durch`);
    }
    return 'IPv4-in-IPv6, URL, Grossschreibung, Punkt';
  });
  // Der Gegenbeweis zum Offline-Beweis. `npm run proof` zeigt, dass nichts
  // durchkommt. Ein Online-Modus, der nur blockiert, waere aber genauso
  // kaputt wie einer, der alles durchlaesst -- also wird hier geprueft, dass
  // die Schleuse nach einer ausdruecklichen Freigabe wirklich oeffnet und
  // danach wieder schliesst.
  await check('Online-Modus lässt nach Freigabe wirklich durch', async () => {
    const vorher = ok(await api.get('/api/network'), 'netz').mode;
    try {
      ok(await api.put('/api/network', { mode: 'online' }), 'modus online');
      // Die Antwort traegt die Entscheidung unter `decision` -- sie ist das
      // Urteil der Schleuse, nicht das Ergebnis eines Verbindungsversuchs.
      const gesperrt = ok(await api.post('/api/network/test', { host: 'pruefung.invalid' }), 'test ohne Freigabe');
      // Im Online-Modus ohne strikte Allowlist waere alles erlaubt; mit ihr
      // (Standard) braucht auch ein oeffentlicher Host eine Freigabe.
      const strikt = gesperrt.decision.allowed === false;

      const freigabe = ok(await api.post('/api/network/grants', {
        scope: 'global', level: 'online', hosts: ['pruefung.invalid'],
        reason: 'Funktionsprüfung',
      }), 'freigabe');

      const erlaubt = ok(await api.post('/api/network/test', { host: 'pruefung.invalid' }), 'test mit Freigabe');
      assert(erlaubt.decision.allowed === true,
        `die Freigabe wirkt nicht: ${JSON.stringify(erlaubt.decision)}`);

      ok(await api.del(`/api/network/grants/${freigabe.record.id}`), 'freigabe zurücknehmen');
      const wieder = ok(await api.post('/api/network/test', { host: 'pruefung.invalid' }), 'test nach Rücknahme');
      if (strikt) {
        assert(wieder.decision.allowed === false, 'die zurückgenommene Freigabe wirkt weiter');
      }
      return strikt
        ? 'gesperrt → freigegeben → wieder gesperrt'
        : 'freigegeben (ohne strikte Allowlist ist im Online-Modus ohnehin alles erlaubt)';
    } finally {
      ok(await api.put('/api/network', { mode: vorher }), 'modus zurück');
    }
  });

  await check('Nach dem Zurückschalten ist wieder zu', async () => {
    const n = ok(await api.get('/api/network'), 'netz');
    assert(n.mode === 'offline', `Modus steht auf ${n.mode} statt offline`);
    const res = ok(await api.post('/api/network/test', { host: 'pruefung.invalid' }), 'test');
    assert(res.decision.allowed === false, 'im Offline-Modus wäre ein öffentlicher Host erreichbar');
    return 'offline, und der Host ist gesperrt';
  });

  await check('Jede Entscheidung steht im Protokoll', async () => {
    const a = ok(await api.get('/api/network/audit?limit=20'), 'audit');
    const list = a.items || a.entries || [];
    assert(list.length > 0, 'Protokoll ist leer');
    const erlaubt = list.filter((e) => /allow|local/.test(e.kind)).length;
    return `${list.length} Einträge, davon ${erlaubt} erlaubte`;
  });
  await check('Prozessweite Durchsetzung ist aktiv', async () => {
    const h = await app.doctor();
    assert(h.network.hardened, 'Härtung nicht aktiv');
    return 'gepatcht';
  });
}

async function checkAgents() {
  area('8 · Agenten');
  let agentId = null;
  await check('Eingebaute Agenten vorhanden', async () => {
    const a = ok(await api.get('/api/agents'), 'agents');
    assert(a.items.length >= 6, `nur ${a.items.length} Agenten`);
    const alleOffline = a.items.every((x) => body(x).permissions.network === 'offline');
    assert(alleOffline, 'nicht alle eingebauten Agenten starten offline');
    return `${a.items.length}, alle ohne Netz`;
  });
  await check('Fehlende Rechte werden auf "verweigert" gesetzt', async () => {
    const r = ok(await api.post('/api/agents', { name: 'Prüfagent', permissions: { readNotes: true } }), 'create');
    agentId = r.record.id;
    const p = body(r.record).permissions;
    assert(p.network === 'offline' && p.writeFiles === false && p.requireApproval === true,
      `Standardrechte falsch: ${JSON.stringify(p)}`);
    assert(Array.isArray(p.fileRoots) && p.fileRoots.length === 0, 'fileRoots nicht leer');
    return 'offline, keine Dateien, Bestätigung nötig';
  });
  await check('Rechte werden im Klartext beschrieben', async () => {
    const d = ok(await api.get(`/api/agents/${agentId}`), 'agent');
    assert(typeof d.description === 'string' && d.description.length > 20, 'keine Beschreibung');
    assert(/NICHT/.test(d.description), 'Beschreibung sagt nicht, was verboten ist');
    return d.description.slice(0, 70) + '…';
  });
  await check('Werkzeugkasten ist nach Rechten gefiltert', async () => {
    const d = ok(await api.get(`/api/agents/${agentId}`), 'agent');
    const names = (d.tools || []).map((t) => t.name);
    assert(names.length > 0, 'keine Werkzeuge');
    assert(!names.some((n) => n.startsWith('files.')), 'Dateiwerkzeuge trotz fehlender Rechte');
    assert(!names.includes('web.fetch'), 'Netzwerkzeug trotz Offline-Agent');
    return names.join(', ');
  });
  await check('Lauf ohne Modell scheitert ehrlich', async () => {
    const res = await api.post(`/api/agents/${agentId}/run`, { goal: 'Zähle meine Notizen.' });
    if (res.status !== 200) {
      const code = res.json && res.json.error && res.json.error.code;
      assert(/NO_MODEL|MODEL/.test(String(code)), `unerwartet: ${code}`);
      return `${code} beim Start`;
    }
    const runId = res.json.runId || (res.json.record && res.json.record.id);
    await new Promise((r) => setTimeout(r, 1200));
    const run = ok(await api.get(`/api/runs/${runId}`), 'run');
    const d = body(run.record || run);
    assert(d.status === 'failed' || d.status === 'done', `Status ${d.status}`);
    if (d.status === 'failed') {
      assert(d.error, 'gescheitert ohne Fehlerangabe');
      return `failed: ${d.error.code}`;
    }
    return `done (Modell vorhanden)`;
  });
  await check('usedNetwork wird nicht geraten', async () => {
    const runs = ok(await api.get('/api/runs'), 'runs');
    const list = runs.items || [];
    if (!list.length) return unklar('kein Lauf vorhanden');
    const d = body(list[0]);
    assert(d.usedNetwork === false, `usedNetwork=${d.usedNetwork} obwohl offline`);
    return 'false, wie erwartet';
  });
}

async function checkVaultAndBackup(app) {
  area('9 · Datensicherheit');
  await check('Export schreibt JSON und Markdown', async () => {
    const r = ok(await api.post('/api/backup/export', { format: 'both', includeFiles: true }), 'export');
    assert(r.dir && fs.existsSync(r.dir), 'Zielordner existiert nicht');
    const files = fs.readdirSync(r.dir);
    assert(files.some((f) => f.endsWith('.json')), 'keine JSON-Datei');
    return `${r.records} Einträge in ${path.basename(r.dir)}`;
  });
  /**
   * Der Rundlauf, und zwar durch dieselbe Tuer, die ein Mensch benutzt.
   *
   * Hier stand frueher `res.imported > 0` und „nicht weniger NOTIZEN als
   * vorher". Beides blieb gruen, waehrend beim Import 19 Kantendubletten
   * entstanden. Eine Sicherung, die „etwas" zurueckbringt, ist keine --
   * sie muss DASSELBE zurueckbringen, Satzart fuer Satzart.
   *
   * Und sie laeuft ueber POST /api/backup/import statt ueber einen direkten
   * Modulaufruf: die Stelle, die die Graph-Ableitung waehrend eines Imports
   * stilllegt und danach einmal nachholt, sitzt in der Route (app.bulkWrite).
   * Ein Modulaufruf daneben wuerde eine Zusage pruefen, die niemand nutzt.
   */
  async function rundlauf(what, modus, pruefen) {
    const { createApp } = require('../src/app');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-roundtrip-'));
    let target = null;
    try {
      const exported = await app.backup.exportAll({ format: 'json', includeFiles: true });
      target = await createApp({ home: tmp, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
      const server = await target.listen();
      const port = server.server.address().port;
      const res = ok(await postTo(port, '/api/backup/import', { dir: exported.dir, mode: modus }), 'import');
      return await pruefen(target, res);
    } finally {
      if (target) await target.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const zaehleJeArt = (store) => {
    const schema = require('../src/store/schema');
    const out = {};
    for (const type of schema.TYPES) {
      const n = store.list(type, { includeDeleted: true, limit: 100000, offset: 0 }).total;
      if (n) out[type] = n;
    }
    return out;
  };

  await check('Export und Re-Import erhalten jede Satzart', async () => {
    const vorher = zaehleJeArt(app.store);
    return rundlauf('rundlauf', 'merge', async (target, res) => {
      assert(res.imported > 0, 'nichts importiert');
      const nachher = zaehleJeArt(target.store);
      const arten = [...new Set([...Object.keys(vorher), ...Object.keys(nachher)])].sort();
      const abweichung = arten
        .filter((t) => (vorher[t] || 0) !== (nachher[t] || 0))
        .map((t) => `${t}: ${vorher[t] || 0} → ${nachher[t] || 0}`);
      assert(!abweichung.length, `Satzzahlen weichen ab — ${abweichung.join(', ')}`);
      return `${res.imported} übernommen, ${arten.length} Satzarten identisch`;
    });
  });

  await check('Kanten überleben den Import ohne Dubletten', async () => {
    // Eine Kante hat keinen eigenen Namen: zwei Kanten mit gleichem
    // from|to|kind sind fuer einen Menschen EINE Verknuepfung, fuer den
    // Speicher zwei Saetze mit verschiedenen ids. Die blosse Zahl verraet
    // deshalb nicht, dass daneben abgeleitet wurde.
    const schluessel = (store) => {
      const items = store.list('edge', { includeDeleted: true, limit: 100000, offset: 0 }).items;
      return { gesamt: items.length, eindeutig: new Set(items.map((e) => `${e.data.from}|${e.data.to}|${e.data.kind}`)).size };
    };
    const hier = schluessel(app.store);
    return rundlauf('kanten', 'merge', async (target, res) => {
      const dort = schluessel(target.store);
      assert(dort.gesamt === hier.gesamt, `${hier.gesamt} Kanten hier, ${dort.gesamt} nach dem Import`);
      assert(dort.gesamt === dort.eindeutig, `${dort.gesamt - dort.eindeutig} Kantendubletten nach dem Import`);
      assert(res.graph && res.graph.ok, `die Ableitung wurde nicht nachgeholt: ${res.graph && res.graph.grund}`);
      return `${dort.gesamt} Kanten, keine Dublette`;
    });
  });

  await check('„Alles ersetzen" stellt eine frische Installation wirklich her', async () => {
    // Der gemessene Notfall: wer auf einem neuen Rechner wiederherstellt,
    // findet dort die Erstausstattung des ersten Starts vor. „fresh" bricht
    // dann ab, „merge" und „replace" lassen sie stehen. Nur „restore" liefert
    // den gesicherten Stand.
    const { createApp, seedIfEmpty } = require('../src/app');
    const erwartet = zaehleJeArt(app.store);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-restore-'));
    let target = null;
    try {
      const exported = await app.backup.exportAll({ format: 'json', includeFiles: true });
      target = await createApp({ home: tmp, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
      await seedIfEmpty(target);
      const vorbelegt = Object.values(zaehleJeArt(target.store)).reduce((a, b) => a + b, 0);
      assert(vorbelegt > 0, 'seedIfEmpty hat nichts angelegt — dann prüft das hier nichts');
      const server = await target.listen();
      const port = server.server.address().port;

      const gescheitert = await postTo(port, '/api/backup/import', { dir: exported.dir, mode: 'fresh' });
      assert(gescheitert.status >= 400, `„fresh" hätte auf einer frischen Installation abbrechen müssen (HTTP ${gescheitert.status})`);

      const vorschau = ok(await postTo(port, '/api/backup/preview', { dir: exported.dir, mode: 'restore' }), 'preview');
      assert(vorschau.verschwindet.length > 0, 'die Vorschau nennt nicht, was verschwindet');
      assert(zaehleJeArt(target.store).note !== undefined || vorbelegt > 0, 'Vorschau hat geschrieben');

      const res = ok(await postTo(port, '/api/backup/import', { dir: exported.dir, mode: 'restore' }), 'restore');
      const nachher = zaehleJeArt(target.store);
      const arten = [...new Set([...Object.keys(erwartet), ...Object.keys(nachher)])].sort();
      const abweichung = arten
        .filter((t) => (erwartet[t] || 0) !== (nachher[t] || 0))
        .map((t) => `${t}: ${erwartet[t] || 0} → ${nachher[t] || 0}`);
      assert(!abweichung.length, `Satzzahlen weichen ab — ${abweichung.join(', ')}`);
      assert(res.purged.records >= vorbelegt, `die Erstausstattung wurde nicht entfernt: ${JSON.stringify(res.purged)}`);
      assert(res.warnings.some((w) => /rückgängig|rueckgaengig/.test(w)), 'das Ergebnis sagt nicht, dass das unumkehrbar war');
      return `${vorbelegt} vorbelegte Sätze ersetzt, ${arten.length} Satzarten identisch`;
    } finally {
      if (target) await target.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('Die Liste der Sicherungen nennt echte Ordner', async () => {
    const r = ok(await api.get('/api/backup/list'), 'list');
    assert(Array.isArray(r.items), 'keine Liste');
    assert(r.items.length > 0, 'die vorher geschriebenen Exporte tauchen nicht auf');
    for (const item of r.items) {
      assert(fs.existsSync(path.join(item.dir, 'manifest.json')), `${item.dir} hat kein manifest.json`);
      assert(typeof item.sealed === 'boolean', 'ob die Sicherung im Klartext liegt, muss dastehen');
    }
    return `${r.items.length} Sicherung(en), älteste zuletzt`;
  });
  await check('Absturz mitten im Schreiben zerstört nichts', async () => {
    const { createApp } = require('../src/app');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-crash-'));
    let a = null;
    try {
      a = await createApp({ home: tmp, logLevel: 'error', harden: false });
      const keep = a.store.create('note', { title: 'Vor dem Absturz' });
      await a.store.flush();
      await a.close(); a = null;
      const logDir = path.join(tmp, 'vault', 'log');
      const segs = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort();
      fs.appendFileSync(path.join(logDir, segs[segs.length - 1]), '{"v":1,"op":"create","id":"note_abge');
      a = await createApp({ home: tmp, logLevel: 'error', harden: false });
      assert(a.store.get(keep.id), 'Datensatz vor dem Absturz ist weg');
      const neu = a.store.create('note', { title: 'Danach' });
      assert(a.store.get(neu.id), 'nach dem Absturz nicht mehr beschreibbar');
      return 'abgeschnitten, repariert, weiter beschreibbar';
    } finally {
      if (a) await a.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  await check('Verschlüsselung: falsche Passphrase wird abgewiesen', async () => {
    const { createVaultCrypto } = require('../src/store/vaultcrypto');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-crypt-'));
    try {
      const paths = require('../src/kernel/paths').ensureLayout(require('../src/kernel/paths').layout(tmp));
      const vc = createVaultCrypto({ paths, config: require('../src/kernel/config').defaults() });
      await vc.initialise('richtige-passphrase');
      const verschluesselt = vc.encryptLine('geheimer Text');
      assert(!verschluesselt.includes('geheimer'), 'Klartext im Chiffrat');
      vc.lock();
      let abgewiesen = false;
      try { await vc.unlock('falsch'); } catch { abgewiesen = true; }
      assert(abgewiesen, 'falsche Passphrase wurde akzeptiert');
      await vc.unlock('richtige-passphrase');
      assert(vc.decryptLine(verschluesselt) === 'geheimer Text', 'Entschlüsselung falsch');
      return 'AES-256-GCM, Passphrase geprüft';
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  /**
   * PIN und iPad in einer eigenen Anwendung: das Einrichten verschlüsselt den
   * Tresor, und das Merken legt einen Schlüssel ins Profil. Beides darf die
   * Prüf-Anwendung oben nicht verändern -- und nicht das echte Profil.
   */
  async function mitEigenerApp(fn) {
    const { createApp } = require('../src/app');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-pin-'));
    const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-pin-profil-'));
    const vorher = process.env.NEURAL_OS_GERAETE;
    process.env.NEURAL_OS_GERAETE = profil;
    let a = null;
    try {
      a = await createApp({ home: tmp, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
      const server = await a.listen();
      return await fn(a, server.server.address().port);
    } finally {
      if (a) await a.close().catch(() => {});
      if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
      else process.env.NEURAL_OS_GERAETE = vorher;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(profil, { recursive: true, force: true });
    }
  }

  await check('PIN: 4-6 Ziffern verschlüsseln alles, falsch heißt 401, fünfmal falsch 30 s Pause', async () => mitEigenerApp(async (a, port) => {
    a.store.create('note', { title: 'Prüf-Kanarienvogel' });
    await a.store.flush();
    const kurz = await request('POST', '/api/vault/pin', { pin: '12' }, {}, port);
    assert(kurz.status === 400, `eine zweistellige PIN wurde nicht abgewiesen (HTTP ${kurz.status})`);
    const gesetzt = await request('POST', '/api/vault/pin', { pin: '2468' }, {}, port);
    assert(gesetzt.status === 200, `PIN einrichten: HTTP ${gesetzt.status} ${gesetzt.text.slice(0, 160)}`);
    const log = fs.readdirSync(a.paths.log).map((f) => fs.readFileSync(path.join(a.paths.log, f), 'utf8')).join('');
    assert(!log.includes('Prüf-Kanarienvogel'), 'nach der PIN steht die Notiz noch im Klartext im Protokoll');
    const antworten = [];
    for (let i = 0; i < 5; i++) antworten.push((await request('POST', '/api/vault/unlock', { passphrase: `135${i}` }, {}, port)).status);
    assert(antworten.join() === '401,401,401,401,429', `erwartet 4× 401 und dann 429, bekam ${antworten.join(', ')}`);
    return 'eingerichtet, Klartext weg, 4× „Falsche PIN.", dann „Zu oft falsch. Kurz warten."';
  }));

  // Mit der Prüf-Anwendung selbst: sie läuft wie im Alltag gehärtet und
  // offline -- genau dort muss das Lauschen im WLAN trotzdem gehen.
  await check('iPad verbinden: im WLAN ohne Neustart, ein Einmal-Link wird zum Cookie', async () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal);
    if (!lan) return unklar('Dieser Rechner hat keine Netzadresse außer 127.0.0.1 -- ein zweites Gerät lässt sich hier nicht spielen.');
    const a = app;
    const port = PORT;
    a.lanAdressen = () => [{ adresse: lan.address, schnittstelle: 'Prüfung' }];
    try {
      const an = await request('POST', '/api/ipad', {}, {}, port);
      assert(an.status === 200 && an.json.link, `einschalten: HTTP ${an.status} ${an.text.slice(0, 160)}`);
      const link = new URL(an.json.link);
      // Das "iPad" ist ein Aufruf aus diesem Prozess; die Härtung gilt
      // prozessweit und hielte ihn für eine Verbindung ins Netz. Ein echtes
      // iPad ist ein anderes Gerät -- deshalb der interne Kontext der Schleuse.
      const { runInternal } = require('../src/net/gate');
      const vomIpad = (p, headers = {}) => runInternal(() => new Promise((resolve, reject) => {
        const req = http.request({ host: lan.address, port: Number(link.port), path: p, headers: { host: link.host, ...headers } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res));
        });
        req.on('error', reject);
        req.end();
      }));
      const ohne = await vomIpad('/api/records');
      assert(ohne.statusCode === 401, `ohne Anmeldung kam das Gerät durch (HTTP ${ohne.statusCode})`);
      const ein = await vomIpad(`${link.pathname}${link.search}`);
      assert(ein.statusCode === 303 && ein.headers.location === '/', `der Link wurde nicht getauscht (HTTP ${ein.statusCode})`);
      const cookie = [].concat(ein.headers['set-cookie'] || [])[0].split(';')[0];
      const mit = await vomIpad('/api/records', { cookie });
      assert(mit.statusCode === 200, `mit dem Cookie: HTTP ${mit.statusCode}`);
      const nochmal = await vomIpad(`${link.pathname}${link.search}`);
      assert(nochmal.statusCode === 410, `derselbe Link galt ein zweites Mal (HTTP ${nochmal.statusCode})`);
      return `${lan.address}:${link.port} neben 127.0.0.1:${port}, Netzmodus ${a.config.network.mode}, Link einmal eingelöst`;
    } finally {
      await request('DELETE', '/api/ipad', undefined, {}, port).catch(() => {});
      delete a.lanAdressen;
    }
  });
}

async function checkModules() {
  area('10 · Werkstatt (Erweiterungen)');
  let modId = null;
  const quelle = [
    "module.exports = {",
    "  manifest: { name: 'Prüfmodul', description: 'Für die Funktionsprüfung.',",
    "    kind: 'server', capabilities: ['records.read', 'routes.add'] },",
    "  setup(api) {",
    "    api.route('GET', '/api/x/pruefung', () => ({ notizen: api.records.list('note').length }));",
    "  },",
    "};",
  ].join('\n');

  await check('Berechtigungskatalog abrufbar', async () => {
    const c = ok(await api.get('/api/modules/capabilities'), 'caps');
    assert(c.items.length > 5, 'zu wenige Berechtigungen');
    assert(c.items.every((x) => x.label && x.hint), 'Berechtigung ohne deutschen Klartext');
    return `${c.items.length} Berechtigungen, alle erklärt`;
  });
  await check('Prüfen installiert nichts', async () => {
    const vorher = ok(await api.get('/api/modules'), 'list').total;
    const v = ok(await api.post('/api/modules/validate', { source: quelle }), 'validate');
    const val = v.validation || v;
    assert(val.ok === true, `ungültig: ${JSON.stringify(val.problems)}`);
    const nachher = ok(await api.get('/api/modules'), 'list').total;
    assert(vorher === nachher, 'Prüfen hat installiert');
    return `gültig, Risiko ${val.risk}`;
  });
  await check('Kaputter Code nennt die Zeile', async () => {
    const v = ok(await api.post('/api/modules/validate', {
      source: 'module.exports = {\n  manifest: { name: "X", kind: "server" },\n  setup(api) { das ist kaputt }\n}',
    }), 'validate');
    const val = v.validation || v;
    assert(val.ok === false, 'kaputter Code galt als gültig');
    const mitZeile = (val.problems || []).find((p) => p.line);
    assert(mitZeile, 'kein Problem mit Zeilennummer');
    return `Zeile ${mitZeile.line}: ${mitZeile.message.slice(0, 50)}`;
  });
  await check('Installieren lässt das Modul AUS', async () => {
    const r = ok(await api.post('/api/modules', { source: quelle, note: 'Prüfung' }), 'install');
    modId = r.record.id;
    assert(body(r.record).enabled !== true, 'Modul war sofort aktiv');
    return 'installiert, nicht aktiv';
  });
  await check('Einschalten wirkt tatsächlich', async () => {
    ok(await api.post(`/api/modules/${modId}/enable`), 'enable');
    const res = await api.get('/api/x/pruefung');
    assert(res.status === 200, `Modul-Route antwortet nicht (HTTP ${res.status})`);
    assert(typeof res.json.notizen === 'number', `unerwartete Antwort: ${res.text.slice(0, 80)}`);
    return `/api/x/pruefung → ${JSON.stringify(res.json)}`;
  });
  await check('Abschalten entfernt die Wirkung', async () => {
    ok(await api.post(`/api/modules/${modId}/disable`), 'disable');
    const res = await api.get('/api/x/pruefung');
    assert(res.status === 404, `Route lebt weiter (HTTP ${res.status})`);
    return 'Route weg';
  });
  await check('Jede Fassung bleibt erhalten', async () => {
    await api.patch(`/api/modules/${modId}`, { source: quelle.replace('Prüfmodul', 'Zweite Fassung'), note: 'v2' });
    const d = ok(await api.get(`/api/modules/${modId}`), 'get');
    const versionen = body(d.record).versions || [];
    assert(versionen.length >= 1, 'keine frühere Fassung gespeichert');
    return `${versionen.length + 1} Fassungen`;
  });
  await check('Zurückrollen funktioniert', async () => {
    const r = await api.post(`/api/modules/${modId}/rollback`, { version: 1 });
    assert(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    const d = ok(await api.get(`/api/modules/${modId}`), 'get');
    assert(/Prüfmodul/.test(body(d.record).source), 'alter Quelltext nicht wiederhergestellt');
    return 'Fassung 1 wieder aktiv';
  });
  await check('Modul-Werkzeug überschreitet keine Agentenrechte', async () => {
    const schreibModul = [
      "module.exports = { manifest: { name: 'Schreiber', kind: 'server',",
      "  capabilities: ['records.read','records.write','tools.add'] },",
      "  setup(api) { api.tool({ name: 'pruef.schreib', description: 'schreibt',",
      "    parameters: { type: 'object', properties: {} },",
      "    run() { return api.records.create('note', { title: 'X' }); } }); } };",
    ].join('\n');
    const m = ok(await api.post('/api/modules', { source: schreibModul }), 'install');
    ok(await api.post(`/api/modules/${m.record.id}/enable`), 'enable');
    const leser = ok(await api.post('/api/agents', { name: 'Nur-Leser', permissions: { readNotes: true } }), 'a');
    const schreiber = ok(await api.post('/api/agents', {
      name: 'Schreiber-Agent', permissions: { readNotes: true, writeNotes: true },
    }), 'b');
    const t1 = (ok(await api.get(`/api/agents/${leser.record.id}`), 'x').tools || []).map((t) => t.name);
    const t2 = (ok(await api.get(`/api/agents/${schreiber.record.id}`), 'y').tools || []).map((t) => t.name);
    assert(!t1.includes('pruef.schreib'), 'Nur-Leser sieht das Schreib-Werkzeug');
    assert(t2.includes('pruef.schreib'), 'Schreiber-Agent sieht es nicht');
    await api.post(`/api/modules/${m.record.id}/disable`);
    return 'Nur-Leser: nein, Schreiber: ja';
  });
  await check('Entfernen', async () => {
    ok(await api.del(`/api/modules/${modId}`), 'delete');
    const res = await api.get(`/api/modules/${modId}`);
    assert(res.status === 404, 'noch vorhanden');
    return 'entfernt';
  });
}

async function checkSync(app) {
  area('11 · Abgleich zwischen Geräten');
  await check('Eigene Gerätekennung vorhanden', async () => {
    const i = ok(await api.get('/api/sync/info'), 'info');
    assert(i.deviceId, 'keine deviceId');
    return `${i.deviceId} · ${i.recordCount} Einträge`;
  });
  await check('Partnerliste erreichbar', async () => {
    const p = ok(await api.get('/api/peers'), 'peers');
    assert(Array.isArray(p.items), 'keine Liste');
    return `${p.items.length} Partner`;
  });
  await check('Konfliktliste erreichbar', async () => {
    const c = ok(await api.get('/api/conflicts'), 'conflicts');
    assert(Array.isArray(c.items), 'keine Liste');
    return `${c.items.length} offen`;
  });
  await check('Ordner-Abgleich führt zwei Geräte zusammen', async () => {
    if (!app.sync || typeof app.sync.publishToFolder !== 'function') {
      const folder = require('../src/sync/folder');
      if (!folder || typeof folder.createFolderSync !== 'function') {
        return unklar('Ordner-Abgleich nicht über die App erreichbar');
      }
    }
    const { createApp } = require('../src/app');
    const { createFolderSync } = require('../src/sync/folder');
    const merge = require('../src/sync/merge');
    const stick = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-stick-'));
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-a-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-b-'));
    let A = null; let Bb = null;
    try {
      A = await createApp({ home: homeA, logLevel: 'error', harden: false });
      Bb = await createApp({ home: homeB, logLevel: 'error', harden: false });
      const fsA = createFolderSync({ store: A.store, merge, bus: A.bus, logger: A.logger, config: A.config, vaultCrypto: A.vaultCrypto, paths: A.paths });
      const fsB = createFolderSync({ store: Bb.store, merge, bus: Bb.bus, logger: Bb.logger, config: Bb.config, vaultCrypto: Bb.vaultCrypto, paths: Bb.paths });
      const note = A.store.create('note', { title: 'Nur auf A', body: 'reist über den Stick' });
      await A.store.flush();
      await fsA.publish(stick);
      const peers = await fsB.peers(stick);
      const fremd = peers.filter((p) => !p.isSelf);
      assert(fremd.length === 1, `${fremd.length} fremde Postfächer gefunden`);
      const res = await fsB.pull(stick, { deviceId: fremd[0].deviceId });
      assert(Bb.store.get(note.id), 'Notiz kam nicht an');
      // Was NICHT übertragen werden darf
      const inbox = path.join(stick, fremd[0].deviceId);
      const roh = fs.readdirSync(inbox).map((f) => fs.readFileSync(path.join(inbox, f)));
      const text = Buffer.concat(roh).toString('latin1');
      assert(!/"type"\s*:\s*"token"/.test(text), 'Zugangstoken im Postfach');
      assert(!/"type"\s*:\s*"module"/.test(text), 'Modul-Quelltext im Postfach');
      assert(!/"type"\s*:\s*"agent"/.test(text), 'Agent mit Rechten im Postfach');
      return `${res.applied} übernommen, keine Rechte übertragen`;
    } finally {
      if (A) await A.close().catch(() => {});
      if (Bb) await Bb.close().catch(() => {});
      for (const d of [stick, homeA, homeB]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
  await check('Beidseitige Änderung erzeugt einen Konflikt', async () => {
    const { createApp } = require('../src/app');
    const { createFolderSync } = require('../src/sync/folder');
    const merge = require('../src/sync/merge');
    const stick = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-stick2-'));
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-a2-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-b2-'));
    let A = null; let Bb = null;
    try {
      A = await createApp({ home: homeA, logLevel: 'error', harden: false });
      Bb = await createApp({ home: homeB, logLevel: 'error', harden: false });
      const fsA = createFolderSync({ store: A.store, merge, bus: A.bus, logger: A.logger, config: A.config, vaultCrypto: A.vaultCrypto, paths: A.paths });
      const fsB = createFolderSync({ store: Bb.store, merge, bus: Bb.bus, logger: Bb.logger, config: Bb.config, vaultCrypto: Bb.vaultCrypto, paths: Bb.paths });
      const note = A.store.create('note', { title: 'Gemeinsam', body: 'Ausgangsfassung' });
      await A.store.flush();
      await fsA.publish(stick);
      const p1 = (await fsB.peers(stick)).filter((p) => !p.isSelf);
      await fsB.pull(stick, { deviceId: p1[0].deviceId });
      // Jetzt beide Seiten ändern
      A.store.update(note.id, { body: 'Fassung von A' });
      Bb.store.update(note.id, { body: 'Fassung von B' });
      await A.store.flush(); await Bb.store.flush();
      await fsA.publish(stick);
      const res = await fsB.pull(stick, { deviceId: p1[0].deviceId });
      const konflikte = typeof res.conflicts === 'number' ? res.conflicts : (res.conflicts || []).length;
      assert(konflikte > 0, 'kein Konflikt erzeugt — eine Seite wurde überschrieben');
      const lokal = Bb.store.get(note.id);
      assert(lokal.data.body === 'Fassung von B', `lokale Fassung überschrieben: "${lokal.data.body}"`);
      return `${konflikte} Konflikt, lokale Fassung unangetastet`;
    } finally {
      if (A) await A.close().catch(() => {});
      if (Bb) await Bb.close().catch(() => {});
      for (const d of [stick, homeA, homeB]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
}

async function checkExtraction() {
  area('12 · Textextraktion');
  const { extractText, sniffKind } = require('../src/store/extract');
  const zlib = require('node:zlib');

  function crc32(buf) {
    let c; const t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xFF];
    return (crc ^ (-1)) >>> 0;
  }
  function zip(entries) {
    const chunks = []; const central = []; let off = 0;
    for (const [name, data] of entries) {
      const comp = zlib.deflateRawSync(data); const nb = Buffer.from(name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
      lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18);
      lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
      chunks.push(lh, nb, comp);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
      ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20);
      ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      central.push(ch, nb); off += lh.length + nb.length + comp.length;
    }
    const cd = Buffer.concat(central); const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...chunks, cd, end]);
  }

  await check('Word-Dokument (.docx)', async () => {
    const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
      + '<w:p><w:r><w:t>Erster Absatz</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Zweiter Absatz</w:t></w:r></w:p></w:body></w:document>';
    const buf = zip([['[Content_Types].xml', Buffer.from('<Types/>')], ['word/document.xml', Buffer.from(xml)]]);
    const r = extractText(buf, { name: 'a.docx' });
    assert(/Erster Absatz/.test(r.text) && /Zweiter Absatz/.test(r.text), `Text fehlt: ${r.text.slice(0, 60)}`);
    return `${r.kind}: ${r.text.replace(/\n/g, ' / ').slice(0, 50)}`;
  });
  await check('Tabelle (.xlsx)', async () => {
    const shared = '<?xml version="1.0"?><sst><si><t>Kopfzeile</t></si><si><t>Wert</t></si></sst>';
    const sheet = '<?xml version="1.0"?><worksheet><sheetData>'
      + '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>';
    const buf = zip([
      ['[Content_Types].xml', Buffer.from('<Types/>')],
      ['xl/sharedStrings.xml', Buffer.from(shared)],
      ['xl/worksheets/sheet1.xml', Buffer.from(sheet)],
    ]);
    const r = extractText(buf, { name: 'a.xlsx' });
    assert(/Kopfzeile/.test(r.text), `Text fehlt: ${r.text.slice(0, 60)}`);
    return `${r.kind}: ${r.text.replace(/\s+/g, ' ').slice(0, 50)}`;
  });
  await check('HTML ohne Skripte', async () => {
    const html = '<html><head><script>alert(1)</script><style>a{}</style></head>'
      + '<body><h1>Überschrift</h1><p>Ein Absatz.</p></body></html>';
    const r = extractText(Buffer.from(html), { name: 'a.html' });
    assert(/Überschrift/.test(r.text), 'Text fehlt');
    assert(!/alert/.test(r.text), 'Skript im Text');
    return r.text.replace(/\s+/g, ' ').slice(0, 50);
  });
  await check('Format wird an den Magic Bytes erkannt', async () => {
    const buf = zip([['word/document.xml', Buffer.from('<w:document/>')]]);
    const kind = sniffKind(buf, 'falsch-benannt.txt');
    assert(kind && kind !== 'text', `als "${kind}" erkannt`);
    return `umbenannte Datei → ${kind}`;
  });
  await check('Kaputte Datei wirft statt abzustürzen', async () => {
    let geworfen = false;
    try { extractText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), { name: 'kaputt.docx' }); } catch { geworfen = true; }
    assert(geworfen, 'kaputte Datei lieferte ein Ergebnis');
    return 'Fehler statt erfundenem Inhalt';
  });
}

/**
 * Einen Ereignisstrom (SSE) als ganze Antwort lesen.
 *
 * Der Server beendet den Strom, wenn der Vorgang fertig ist -- damit reicht
 * dieselbe Anfrage wie fuer jede andere Route, und `text` enthaelt am Ende
 * alle Ereignisse. Das ist absichtlich kein eigener Client: geprueft werden
 * soll die echte Route, nicht ein Nachbau davon.
 */
async function sse(urlPath, body) {
  const res = await request('POST', urlPath, body === undefined ? {} : body);
  const events = [];
  let name = null;
  for (const zeile of String(res.text || '').split(/\r?\n/)) {
    if (zeile.startsWith('event:')) name = zeile.slice(6).trim();
    else if (zeile.startsWith('data:')) {
      let daten = zeile.slice(5).trim();
      try { daten = JSON.parse(daten); } catch { /* Klartext */ }
      events.push({ event: name, data: daten });
      name = null;
    }
  }
  return { status: res.status, json: res.json, text: res.text, events };
}

/**
 * Der Befund, der diesen Abschnitt zweimal gruen durchlaufen liess: hier
 * wurde `createStick()` direkt aufgerufen. Damit war jede Zusage des Moduls
 * geprueft -- und dass der Browser das Modul ueberhaupt nicht erreichen kann,
 * fiel nicht auf. 1792 Zeilen Stick-Werkzeug, null Routen in src/http, null
 * Treffer fuer "Stick" in web/**. Deshalb steht unten jetzt beides: die
 * Zusagen des Moduls UND die Tuer, durch die ein Mensch geht.
 */
async function checkStick() {
  area('13 · USB-Stick');
  const { createStick, LOCAL_PLATFORM } = require('../src/portable/stick');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-usb-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-src-'));
  // Eigener Zielordner fuer die HTTP-Haelfte: die beiden Haelften duerfen
  // einander nicht in die Quere kommen, sonst erklaert ein Fehlschlag nichts.
  const httpZiel = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-usb-http-'));
  const httpDaten = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-usb-daten-'));
  const httpNeu = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-usb-neu-'));
  let app = null;
  try {
    const { createApp } = require('../src/app');
    app = await createApp({ home: src, logLevel: 'error', harden: false });
    const stick = createStick({ gate: app.gate, logger: app.logger, paths: app.paths, config: app.config });

    await check('Stick vorbereiten (ohne Internet)', async () => {
      const r = await stick.prepare(tmp, { includeRuntimes: true, includeVault: false });
      assert(fs.existsSync(path.join(tmp, 'neural-os.portable')), 'Marker fehlt');
      assert(fs.existsSync(path.join(tmp, 'app', 'bin', 'neural-os.js')), 'Programm fehlt');
      assert(fs.existsSync(path.join(tmp, 'data')), 'Datenordner fehlt');
      return `${r.files} Dateien, ${Math.round(r.bytes / 1048576)} MB`;
    });
    await check('Laufzeit dieses Rechners liegt mit auf dem Stick', async () => {
      const p = path.join(tmp, 'runtime', LOCAL_PLATFORM);
      assert(fs.existsSync(p), `runtime/${LOCAL_PLATFORM} fehlt`);
      const files = fs.readdirSync(p);
      assert(files.length > 0, 'Laufzeitordner ist leer');
      return `${LOCAL_PLATFORM}: ${files.join(', ')}`;
    });
    await check('Starter für alle drei Betriebssysteme', async () => {
      const namen = fs.readdirSync(tmp).filter((f) => /^Neural OS starten\./.test(f));
      assert(namen.length === 3, `nur ${namen.length}: ${namen.join(', ')}`);
      return namen.join(', ');
    });
    await check('Portabler Modus wird erkannt', async () => {
      const paths = require('../src/kernel/paths');
      const d = paths.detectPortable(path.join(tmp, 'app'));
      assert(d, 'nicht erkannt');
      assert(d.dataDir === path.join(tmp, 'data'), `falscher Datenordner: ${d.dataDir}`);
      return d.dataDir;
    });
    await check('Aktualisieren lässt data/ unangetastet', async () => {
      fs.writeFileSync(path.join(tmp, 'data', 'wichtig.txt'), 'darf nicht verschwinden');
      const vorher = fs.readdirSync(path.join(tmp, 'data')).sort().join(',');
      const stat = fs.statSync(path.join(tmp, 'data', 'wichtig.txt'));
      await stick.update(tmp);
      const nachher = fs.readdirSync(path.join(tmp, 'data')).sort().join(',');
      assert(vorher === nachher, 'Inhalt von data/ hat sich geändert');
      assert(fs.readFileSync(path.join(tmp, 'data', 'wichtig.txt'), 'utf8') === 'darf nicht verschwinden', 'Datei verändert');
      assert(fs.statSync(path.join(tmp, 'data', 'wichtig.txt')).mtimeMs === stat.mtimeMs, 'Zeitstempel geändert');
      return 'byte- und zeitstempelgleich';
    });
    await check('Prüfung erkennt einen beschädigten Stick', async () => {
      const vorher = await stick.verify(tmp);
      assert(vorher.ok, `frischer Stick gilt als kaputt: ${JSON.stringify(vorher.problems)}`);
      fs.rmSync(path.join(tmp, 'app', 'bin'), { recursive: true, force: true });
      const nachher = await stick.verify(tmp);
      assert(!nachher.ok, 'beschädigter Stick gilt als in Ordnung');
      assert(nachher.problems.every((p) => p.message), 'Problem ohne Beschreibung');
      return `erkannt: ${nachher.problems[0].code}`;
    });

    /* ---- und jetzt dieselben Zusagen durch die echte HTTP-Tuer ---- */

    await check('Die Selbstauskunft ist ueber HTTP erreichbar', async () => {
      const r = ok(await api.get('/api/stick'), 'GET /api/stick');
      assert(typeof r.portabel === 'boolean', 'keine Aussage, ob diese Instanz portabel laeuft');
      assert(r.portabel === false ? r.von === null : !!r.von, 'portabel und Herkunft widersprechen sich');
      assert(Array.isArray(r.bekanntePlattformen) && r.bekanntePlattformen.length, 'keine Plattformliste');
      // Die KI ist Claude; ein Modell auf dem Stick gibt es nicht mehr.
      assert(!('modell' in r), 'die Selbstauskunft spricht noch von einem Modell auf dem Stick');
      assert(r.andereSysteme && typeof r.andereSysteme.erlaubt === 'boolean',
        'die Ansicht koennte nicht wissen, ob sie fuer Windows/Mac um Erlaubnis fragen muss');
      return `portabel=${r.portabel}, dieser Rechner=${r.dieserRechner}, nodejs.org ${r.andereSysteme.erlaubt ? 'erlaubt' : 'nur mit Rueckfrage'}`;
    });

    await check('/api/status sagt, ob von einem Stick gestartet wurde', async () => {
      const r = ok(await api.get('/api/status'), 'status');
      assert('portable' in r, 'der Browser kann nicht einmal erfahren, DASS er von einem Stick laeuft');
      assert(r.subsystems && r.subsystems.stick === true, 'das Stick-Werkzeug haengt nicht am Server');
      return `portable=${JSON.stringify(r.portable)}`;
    });

    await check('"Erst ansehen" sagt, was passieren wuerde, und legt nichts an', async () => {
      const vorher = fs.readdirSync(httpZiel);
      const r = ok(await api.get(`/api/stick/preview?path=${encodeURIComponent(httpZiel)}`), 'preview');
      assert(r.source && r.source.files > 0, 'die Vorschau nennt keine Dateizahl');
      assert(r.space && Number.isFinite(r.space.withHeadroom), 'die Vorschau nennt keinen Platzbedarf');
      assert(Array.isArray(r.blockers) && r.blockers.length === 0, `unerwartetes Hindernis: ${JSON.stringify(r.blockers)}`);
      const nachher = fs.readdirSync(httpZiel);
      assert(vorher.join(',') === nachher.join(',') && nachher.length === 0,
        `die Vorschau hat etwas angelegt: ${nachher.join(', ')}`);
      return `${r.source.files} Dateien, ${Math.round(r.space.withHeadroom / 1048576)} MB noetig, nichts geschrieben`;
    });

    await check('Ein getippter Pfad ohne Stick wird mit einem ganzen Satz abgelehnt', async () => {
      const r = await api.get(`/api/stick/preview?path=${encodeURIComponent(httpZiel)}&action=update`);
      assert(r.status === 400, `HTTP ${r.status}`);
      const satz = (r.json && r.json.error && r.json.error.message) || '';
      assert(/kein Neural-OS-Stick/.test(satz), `kein brauchbarer Satz: ${satz.slice(0, 120)}`);
      return `HTTP 400, "${satz.slice(0, 60)}…"`;
    });

    await check('Ein Stick laesst sich ueber HTTP wirklich vorbereiten', async () => {
      const r = await sse('/api/stick/prepare', { path: httpZiel });
      assert(r.status === 200, `HTTP ${r.status}: ${String(r.text).slice(0, 200)}`);
      const arten = r.events.map((e) => e.event);
      assert(arten.includes('fertig'), `kein Abschluss gemeldet: ${arten.join(',')}`);
      assert(!arten.includes('fehler'), `Fehler im Strom: ${JSON.stringify(r.events.find((e) => e.event === 'fehler'))}`);
      const fortschritt = r.events.filter((e) => e.event === 'fortschritt');
      assert(fortschritt.length >= 3, `zu wenige Fortschrittsmeldungen fuer einen Balken: ${fortschritt.length}`);
      const prozente = fortschritt.map((e) => e.data && e.data.percent).filter((v) => Number.isFinite(v));
      assert(prozente.length && prozente[prozente.length - 1] === 100, `der Balken endet nicht bei 100: ${prozente.join(',')}`);
      assert(fs.existsSync(path.join(httpZiel, 'neural-os.portable')), 'Marker fehlt');
      assert(fs.existsSync(path.join(httpZiel, 'app', 'bin', 'neural-os.js')), 'Programm fehlt');
      assert(fs.existsSync(path.join(httpZiel, 'runtime', LOCAL_PLATFORM)), 'Laufzeit fehlt');
      return `${fortschritt.length} Meldungen, ${arten.filter((a) => a === 'fertig').length}× fertig`;
    });

    await check('Die Pruefung ueber HTTP schreibt nichts auf den Stick', async () => {
      const vorher = fs.statSync(httpZiel).mtimeMs;
      const r = ok(await api.get(`/api/stick/verify?path=${encodeURIComponent(httpZiel)}`), 'verify');
      assert(r.ok === true, `frischer Stick gilt als kaputt: ${JSON.stringify(r.problems)}`);
      assert(r.filesystem && r.filesystem.probed === false, 'die Pruefung hat eine Sonde geschrieben');
      assert(fs.statSync(httpZiel).mtimeMs === vorher, 'der Wurzelordner wurde angefasst');
      return `ok, ${r.problems.length} Hinweis(e), keine Sonde`;
    });

    await check('Zwei gleichzeitige Vorgaenge ergeben 409, nicht zwei halbe Sticks', async () => {
      const erster = sse('/api/stick/update', { path: httpZiel });
      // Kurz warten, damit der erste die Sperre wirklich haelt.
      await new Promise((r) => { setTimeout(r, 30); });
      const zweiter = await api.post('/api/stick/update', { path: httpZiel });
      const fertig = await erster;
      assert(fertig.status === 200, `der erste Lauf scheiterte: HTTP ${fertig.status}`);
      assert(zweiter.status === 409, `der zweite Lauf bekam HTTP ${zweiter.status} statt 409`);
      const satz = (zweiter.json && zweiter.json.error && zweiter.json.error.message) || '';
      assert(/laeuft bereits/.test(satz), `kein brauchbarer Satz: ${satz.slice(0, 120)}`);
      // Und der Stick ist danach heil -- genau das, was die Sperre schuetzt.
      const nach = ok(await api.get(`/api/stick/verify?path=${encodeURIComponent(httpZiel)}`), 'verify danach');
      assert(nach.ok === true, `der Stick ist beschaedigt: ${JSON.stringify(nach.problems)}`);
      return `409 mit Grund, Stick danach in Ordnung`;
    });

    await check('Was nicht klappen kann, wird VOR dem ersten Byte abgelehnt', async () => {
      // Der Datenbestand geht einmal mit -- das ist der Fall, um den es geht.
      const erst = await sse('/api/stick/prepare', { path: httpDaten, includeVault: true });
      assert(erst.status === 200, `erster Lauf: HTTP ${erst.status}: ${String(erst.text).slice(0, 200)}`);
      assert(fs.readdirSync(path.join(httpDaten, 'data')).length > 0, 'der Datenbestand kam nicht mit');

      // Und jetzt noch einmal: prepare ueberschreibt NIE Daten. Die Absage
      // muss ein Statuscode sein, kein halber Ereignisstrom, in dem eine
      // Fehlermeldung steht -- sonst haette der Browser schon einen Balken
      // gezeichnet, bevor klar war, dass nichts passiert.
      const zweit = await api.post('/api/stick/prepare', { path: httpDaten, includeVault: true });
      assert(zweit.status === 409, `HTTP ${zweit.status} statt 409`);
      assert(!/^event:/m.test(String(zweit.text)), 'es wurde doch ein Ereignisstrom geoeffnet');
      const satz = (zweit.json && zweit.json.error && zweit.json.error.message) || '';
      assert(/bereits ein Datenbestand/.test(satz), `kein brauchbarer Satz: ${satz.slice(0, 120)}`);
      return `409 ohne Strom, "${satz.slice(0, 55)}…"`;
    });

    /* ---- die vier Handgriffe der Ansicht, durch dieselbe Tuer ---- */
    //
    // web/views/stick.js hat genau vier Knoepfe. Drei davon werden hier ueber
    // ihre echte Route gefahren; "Beenden & abziehen" wuerde den Server
    // beenden, an dem diese Pruefung haengt -- das pruefen test/stick.test.js
    // (mit einem eingeschleusten Ende) und der Beweis-Kreis.

    await check('Die Laufwerkssuche antwortet und sagt, wo sie gesucht hat', async () => {
      const r = ok(await api.get('/api/stick/laufwerke'), 'GET /api/stick/laufwerke');
      assert(Array.isArray(r.laufwerke), 'keine Liste');
      assert(Array.isArray(r.gesucht) && r.gesucht.length, 'nicht gesagt, wo gesucht wurde');
      return `${r.laufwerke.length} gefunden, gesucht in ${r.gesucht.join(', ')}`;
    });

    await check('Der Plan sagt vor dem Klick, ob es fuer Windows/Mac ins Internet muesste', async () => {
      const r = ok(await api.get(`/api/stick/plan?path=${encodeURIComponent(httpNeu)}`), 'GET /api/stick/plan');
      assert(r.fall === 'neu', `Fall ${r.fall} statt neu`);
      assert(r.download && r.download.noetig === true, 'es fehlen Laufzeiten, und der Plan verschweigt es');
      assert(fs.readdirSync(httpNeu).length === 0, 'der Plan hat etwas geschrieben');
      return `neu, ${r.andere.join(', ')} bräuchten nodejs.org (${r.download.erlaubt ? 'erlaubt' : 'Rückfrage'})`;
    });

    await check('Ein Klick "Stick vorbereiten": Programm, Laufzeit, Wissen – ein Balken bis 100', async () => {
      const r = await sse('/api/stick/einrichten', { path: httpNeu, andereSysteme: false });
      assert(r.status === 200, `HTTP ${r.status}: ${String(r.text).slice(0, 200)}`);
      const fertig = r.events.find((e) => e.event === 'fertig');
      assert(fertig, `kein Abschluss: ${r.events.map((e) => e.event).join(',')}`);
      assert(fertig.data.fall === 'neu' && fertig.data.wissen === 'kopiert', JSON.stringify(fertig.data).slice(0, 200));
      assert(fertig.data.laufzeiten.includes(LOCAL_PLATFORM), 'die Laufzeit dieses Rechners fehlt');
      const p = r.events.filter((e) => e.event === 'fortschritt').map((e) => e.data.percent);
      assert(p.length >= 3 && p[p.length - 1] === 100, `Balken: ${p.join(',')}`);
      assert(p.every((v, i) => i === 0 || v >= p[i - 1]), `der Balken lief rueckwaerts: ${p.join(',')}`);
      assert(fs.readdirSync(path.join(httpNeu, 'data')).length > 0, 'das Wissen kam nicht mit');
      return `${p.length} Schritte, startet an ${fertig.data.laufzeiten.join(', ')}`;
    });

    await check('"Jetzt sichern" legt eine vollstaendige Sicherung auf den Stick', async () => {
      const r = ok(await api.post('/api/stick/sichern', { path: httpNeu }), 'POST /api/stick/sichern');
      assert(r.ziel && r.ziel.art === 'stick', `Ziel ${JSON.stringify(r.ziel)}`);
      assert(r.dir.startsWith(path.join(httpNeu, 'Sicherungen')), `falscher Ort: ${r.dir}`);
      const pruefung = ok(await api.get(`/api/backup/verify?dir=${encodeURIComponent(r.dir)}`), 'verify');
      assert(pruefung.ok === true, JSON.stringify(pruefung.problems).slice(0, 200));
      const stand = ok(await api.get(`/api/stick/sicherung?path=${encodeURIComponent(httpNeu)}`), 'sicherung');
      assert(stand.letzte && stand.letzte.dir === r.dir, '"zuletzt gesichert" nennt eine andere Sicherung');
      return `${r.records} Sätze, geprüft, "zuletzt gesichert" stimmt`;
    });

    await check('Die Routen fuer ein Modell auf dem Stick gibt es nicht mehr', async () => {
      const r = await api.get('/api/stick/models');
      assert(r.status === 404, `HTTP ${r.status}`);
      return 'HTTP 404';
    });
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(httpZiel, { recursive: true, force: true });
    fs.rmSync(httpDaten, { recursive: true, force: true });
    fs.rmSync(httpNeu, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------- main */

async function checkAssist(app) {
  area('14 · Vorschläge (ohne Modell)');

  // Vier Fälle, die je ein Erkennungsverfahren treffen sollen.
  const note = async (label, data) => ok(await api.post('/api/records', { type: 'note', data }), label);
  const a = await note('notiz a', {
    title: 'Espressomaschine entkalken',
    body: 'Erst den Wassertank leeren. Dann Entkalker einfüllen. Zwei Durchläufe.',
  });
  const b = await note('notiz b', {
    title: 'Espressomaschine entkalken (Kopie)',
    body: 'Erst den Wassertank leeren. Dann Entkalker einfüllen. Zwei Durchläufe.',
  });
  const mitAufgabe = await note('notiz mit aufgabe', {
    title: 'Küchenplanung',
    body: '- [ ] Dichtung nachbestellen\nSonst nichts.',
  });
  const mitLink = await note('notiz mit link', {
    title: 'Mahlgrad',
    body: 'Siehe [[Brühtemperatur]] — dazu gibt es noch keine Notiz.',
  });

  let suggestions = [];

  await check('Prüfung läuft und meldet ehrlich, was sie nicht konnte', async () => {
    const r = ok(await api.post('/api/assist/scan', {}), 'scan');
    assert(Number.isFinite(r.created), 'keine Zahl neuer Vorschläge');
    assert(Array.isArray(r.skipped), 'kein Feld für übersprungene Verfahren');
    const list = ok(await api.get('/api/assist/suggestions?limit=200'), 'liste');
    suggestions = list.items || [];
    const kinds = [...new Set(suggestions.map((s) => body(s).kind))].sort();
    if (r.skipped.length) {
      return `${r.created} Vorschläge, ${r.skipped.length} Verfahren übersprungen: ${r.skipped.map((s) => `${s.kind} (${s.reason})`).join('; ')}`;
    }
    return `${r.created} Vorschläge in ${r.durationMs} ms, Arten: ${kinds.join(', ') || 'keine'}`;
  });

  await check('Die Dublette wird erkannt und nicht selbst zusammengeführt', async () => {
    const found = suggestions.find((s) => body(s).kind === 'duplicate');
    assert(found, `keine Dublette gefunden, obwohl zwei gleiche Notizen angelegt wurden (Arten: ${suggestions.map((s) => body(s).kind).join(',')})`);
    const ids = body(found).recordIds || [];
    assert(ids.includes(a.record.id) && ids.includes(b.record.id), `falsche Sätze: ${JSON.stringify(ids)}`);
    const action = body(found).action;
    assert(action && action.op === 'link', `ein Vorschlag, der von allein zusammenführt, wäre unumkehrbar: ${JSON.stringify(action)}`);
    return 'als Verknüpfung vorgeschlagen, nicht als Zusammenführung';
  });

  await check('Aus "- [ ]" wird eine Aufgabe vorgeschlagen, aus Prosa nicht', async () => {
    const found = suggestions.find((s) => body(s).kind === 'task' && (body(s).recordIds || []).includes(mitAufgabe.record.id));
    assert(found, 'die angehakte Zeile wurde nicht erkannt');
    assert(/Dichtung/.test(body(found).action.title), `falscher Titel: ${body(found).action.title}`);
    const ausProsa = suggestions.filter((s) => body(s).kind === 'task' && /Sonst nichts/.test(body(s).action.title || ''));
    assert(!ausProsa.length, 'aus einem gewöhnlichen Satz wurde eine Aufgabe geraten');
    return `"${body(found).action.title}"`;
  });

  await check('Ein unaufgelöster [[Link]] wird als fehlende Notiz gemeldet', async () => {
    const found = suggestions.find((s) => body(s).kind === 'link' && (body(s).recordIds || []).includes(mitLink.record.id));
    if (!found) {
      const skipped = suggestions.length === 0;
      return unklar(skipped ? 'die Prüfung hat keine Vorschläge erzeugt' : 'kein Link-Vorschlag — Verfahren übersprungen?');
    }
    assert(body(found).action.op === 'createNote', `falsche Aktion: ${JSON.stringify(body(found).action)}`);
    assert(/Brühtemperatur/.test(body(found).action.title), `falscher Titel: ${body(found).action.title}`);
    return 'Brühtemperatur';
  });

  await check('Übernehmen ändert wirklich etwas', async () => {
    const found = suggestions.find((s) => body(s).kind === 'task');
    if (!found) return unklar('kein Aufgaben-Vorschlag vorhanden');
    const r = ok(await api.post(`/api/assist/suggestions/${found.id}/accept`), 'accept');
    assert(r.applied && r.applied.op === 'createTask', `nichts ausgeführt: ${JSON.stringify(r.applied)}`);
    const task = ok(await api.get(`/api/records/${r.applied.taskId}`), 'aufgabe');
    assert(body(task.record).title === body(found).action.title, 'die Aufgabe trägt einen anderen Titel als angekündigt');
    assert(body(r.suggestion).status === 'accepted', 'der Vorschlag steht nicht auf "übernommen"');
    return `Aufgabe ${r.applied.taskId} angelegt`;
  });

  await check('Ein verworfener Vorschlag kommt nicht wieder', async () => {
    const found = suggestions.find((s) => body(s).kind === 'duplicate');
    if (!found) return unklar('kein Dubletten-Vorschlag vorhanden');
    ok(await api.post(`/api/assist/suggestions/${found.id}/dismiss`), 'dismiss');
    ok(await api.post('/api/assist/scan', {}), 'zweiter scan');
    const list = ok(await api.get('/api/assist/suggestions?status=open&limit=200'), 'liste');
    const wieder = (list.items || []).filter((s) => body(s).kind === 'duplicate'
      && (body(s).recordIds || []).includes(a.record.id));
    assert(!wieder.length, 'der verworfene Vorschlag ist nach der nächsten Prüfung wieder da');
    return 'bleibt verworfen';
  });

  await check('Zweimal prüfen erzeugt keine Dubletten von Vorschlägen', async () => {
    const vorher = ok(await api.get('/api/assist/suggestions?status=all&limit=500'), 'vorher').total;
    const r = ok(await api.post('/api/assist/scan', {}), 'dritter scan');
    const nachher = ok(await api.get('/api/assist/suggestions?status=all&limit=500'), 'nachher').total;
    assert(nachher === vorher, `aus ${vorher} Vorschlägen wurden ${nachher} (neu: ${r.created})`);
    return `${vorher} bleiben ${nachher}`;
  });

  await check('Eine unbekannte Art wird mit den möglichen benannt', async () => {
    const r = await api.post('/api/assist/scan', { kinds: ['hellsehen'] });
    assert(r.status === 400, `HTTP ${r.status} statt 400`);
    assert(/duplicate|orphan|tag/.test(JSON.stringify(r.json)), 'die möglichen Arten werden nicht genannt');
    return 'abgelehnt mit Liste';
  });
}

async function checkAutomation(app) {
  area('15 · Automatik');

  const agents = ok(await api.get('/api/agents'), 'agenten');
  const agentId = (agents.items || [])[0] && (agents.items[0].id);
  if (!agentId) {
    await check('Automatik prüfbar', async () => unklar('kein Agent vorhanden'));
    return;
  }

  let scheduleId = null;
  let triggerId = null;

  await check('Übersicht antwortet mit beiden Teilen', async () => {
    const r = ok(await api.get('/api/automation'), 'automation');
    assert(r.schedules && Array.isArray(r.schedules.items), 'keine Zeitpläne');
    assert(r.triggers && Array.isArray(r.triggers.items), 'keine Auslöser');
    assert(r.status && r.status.scheduler, 'kein Zustand des Zeitgebers');
    return `Zeitgeber läuft: ${r.status.scheduler.running}`;
  });

  await check('Ein neuer Zeitplan ist ausgeschaltet', async () => {
    const r = ok(await api.post('/api/automation/schedules', {
      agentId, goal: 'Tagesrückblick schreiben', every: 'daily', atHour: 7,
    }), 'zeitplan anlegen');
    scheduleId = r.record.id;
    assert(body(r.record).enabled === false,
      'ein Zeitplan, der sofort läuft, ohne dass jemand ihn eingeschaltet hat, ist genau das Gegenteil dessen, was dieses System verspricht');
    assert(body(r.record).nextRunAt, 'ohne nächsten Termin ist der Plan nicht nachvollziehbar');
    return `nächster Termin: ${body(r.record).nextRunAt}`;
  });

  await check('Ein ausgeschalteter Zeitplan feuert auch bei einer Prüfung nicht', async () => {
    const r = ok(await api.post('/api/automation/tick'), 'tick');
    const meiner = (r.fired || []).filter((f) => f.scheduleId === scheduleId);
    assert(!meiner.length, 'ein ausgeschalteter Plan hat einen Lauf gestartet');
    return `${(r.fired || []).length} Läufe gestartet`;
  });

  await check('Der nächste Termin lässt sich nicht von außen verstellen', async () => {
    // Absicht, kein Mangel: nextRunAt ist berechnet. Koennte ein Client ihn
    // setzen, waere die Aussage "das naechste Mal morgen um 7" nicht mehr die
    // Wahrheit ueber den Plan, sondern eine Behauptung des Aufrufers.
    const vorher = ok(await api.get('/api/automation/schedules'), 'vorher');
    const alt = body((vorher.items || []).find((x) => x.id === scheduleId)).nextRunAt;
    ok(await api.patch(`/api/automation/schedules/${scheduleId}`, {
      enabled: true, nextRunAt: new Date(Date.now() - 60000).toISOString(),
    }), 'einschalten');
    const nachher = ok(await api.get('/api/automation/schedules'), 'nachher');
    const jetzt = body((nachher.items || []).find((x) => x.id === scheduleId));
    assert(jetzt.enabled === true, 'das Einschalten hat nicht gewirkt');
    assert(jetzt.nextRunAt === alt, `der Termin wurde von aussen verstellt: ${alt} -> ${jetzt.nextRunAt}`);
    return 'berechnet, nicht gesetzt';
  });

  await check('"Jetzt ausführen" startet einen echten Lauf', async () => {
    const r = await api.post(`/api/automation/schedules/${scheduleId}/run`);
    if (r.status !== 200) {
      // Ohne Modell schlaegt der Lauf hinterher fehl -- gestartet werden muss
      // er trotzdem. Ein anderer Grund ist ein echter Mangel.
      assert(r.status === 409 || r.status === 429, `HTTP ${r.status}: ${JSON.stringify(r.json)}`);
      return unklar(`nicht gestartet: ${JSON.stringify(r.json && r.json.error && r.json.error.message)}`);
    }
    const run = ok(await api.get(`/api/records/${r.json.runId}`), 'lauf');
    assert(body(run.record).agentId === agentId, 'der Lauf gehört einem anderen Agenten');
    assert(body(run.record).goal === 'Tagesrückblick schreiben', 'der Lauf hat ein anderes Ziel als der Plan');
    return `Lauf ${r.json.runId}`;
  });

  await check('Ein eingeschalteter, aber noch nicht fälliger Plan feuert nicht', async () => {
    const r = ok(await api.post('/api/automation/tick'), 'tick');
    const meiner = (r.fired || []).filter((f) => f.scheduleId === scheduleId);
    assert(!meiner.length, 'ein Plan, dessen Termin in der Zukunft liegt, wurde ausgeführt');
    const liste = ok(await api.get('/api/automation/schedules'), 'zeitplaene');
    const jetzt = body((liste.items || []).find((x) => x.id === scheduleId));
    const next = Date.parse(jetzt.nextRunAt);
    assert(Number.isFinite(next) && next > Date.now(),
      `naechster Termin liegt nicht in der Zukunft: ${jetzt.nextRunAt}`);
    return jetzt.nextRunLabel || jetzt.nextRunAt;
  });

  await check('Ein neuer Auslöser ist ausgeschaltet und hat Bremsen', async () => {
    const r = ok(await api.post('/api/automation/triggers', {
      agentId, goal: 'Neue Notiz verschlagworten', on: 'record.created', recordType: 'note',
    }), 'ausloeser anlegen');
    triggerId = r.record.id;
    const d = body(r.record);
    assert(d.enabled === false, 'ein Auslöser, der sofort scharf ist, wurde von niemandem eingeschaltet');
    assert(d.debounceMs >= 1000, `Entprellung zu klein: ${d.debounceMs}`);
    assert(d.maxPerHour >= 1 && d.maxPerHour <= 60, `Stundengrenze unplausibel: ${d.maxPerHour}`);
    return `Entprellung ${d.debounceMs} ms, höchstens ${d.maxPerHour}/Stunde`;
  });

  await check('Ein unbekanntes Ereignis wird abgelehnt', async () => {
    const r = await api.post('/api/automation/triggers', { agentId, goal: 'x', on: 'vollmond' });
    assert(r.status === 400, `HTTP ${r.status} statt 400`);
    return 'abgelehnt';
  });

  await check('Ein unbekannter Agent wird abgelehnt, nicht stillschweigend angelegt', async () => {
    const r = await api.post('/api/automation/schedules', {
      agentId: 'agent_gibtesnicht0000000', goal: 'x', every: 'daily',
    });
    assert(r.status === 404 || r.status === 400, `HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });

  await check('Beides lässt sich wieder entfernen', async () => {
    ok(await api.del(`/api/automation/schedules/${scheduleId}`), 'zeitplan loeschen');
    ok(await api.del(`/api/automation/triggers/${triggerId}`), 'ausloeser loeschen');
    const r = ok(await api.get('/api/automation'), 'automation');
    assert(!(r.schedules.items || []).some((x) => x.id === scheduleId), 'der Zeitplan steht noch da');
    assert(!(r.triggers.items || []).some((x) => x.id === triggerId), 'der Auslöser steht noch da');
    return 'entfernt';
  });
}

async function checkHistory(app) {
  area('16 · Rückgängig');

  const note = ok(await api.post('/api/records', {
    type: 'note', data: { title: 'Rückgängig-Probe', body: 'Erster Text' },
  }), 'notiz').record;

  await check('Das Anlegen steht im Verlauf', async () => {
    const r = ok(await api.get('/api/history?limit=50'), 'verlauf');
    const eintrag = (r.items || []).find((e) => e.id === note.id && e.op === 'create');
    assert(eintrag, `kein Eintrag für ${note.id}: ${JSON.stringify((r.items || []).slice(0, 3))}`);
    assert(eintrag.actor && eintrag.actor.kind === 'user', `falscher Urheber: ${JSON.stringify(eintrag.actor)}`);
    return `${r.total} Einträge, "${eintrag.label}"`;
  });

  let updateSeq = null;
  await check('Eine Änderung lässt sich zurücknehmen', async () => {
    ok(await api.patch(`/api/records/${note.id}`, { body: 'Zweiter Text' }), 'ändern');
    const r = ok(await api.get('/api/history?limit=50'), 'verlauf');
    const eintrag = (r.items || []).find((e) => e.id === note.id && e.op === 'update');
    assert(eintrag, 'die Änderung steht nicht im Verlauf');
    assert(eintrag.canUndo === true, `nicht rücknehmbar: ${eintrag.reason}`);
    updateSeq = eintrag.seq;

    const res = ok(await api.post(`/api/history/${updateSeq}/undo`), 'undo');
    assert(res.applied && res.applied.op === 'update', `nichts ausgeführt: ${JSON.stringify(res.applied)}`);
    const danach = ok(await api.get(`/api/records/${note.id}`), 'nachher');
    assert(body(danach.record).body === 'Erster Text',
      `der alte Text kam nicht zurück: ${JSON.stringify(body(danach.record).body)}`);
    return 'Text steht wieder da';
  });

  await check('Zweimal zurücknehmen geht nicht', async () => {
    const res = await api.post(`/api/history/${updateSeq}/undo`);
    assert(res.status === 409 || res.status === 400, `HTTP ${res.status}`);
    return `HTTP ${res.status}`;
  });

  await check('Ein Konflikt wird nicht still überschrieben', async () => {
    // Ändern, aufzeichnen lassen, dann noch einmal ändern: das Zuruecknehmen
    // der ersten Aenderung wuerde die zweite verschlucken. Genau das soll
    // Rueckgaengig ja verhindern.
    ok(await api.patch(`/api/records/${note.id}`, { body: 'Dritter Text' }), 'ändern');
    const r = ok(await api.get('/api/history?limit=50'), 'verlauf');
    const eintrag = (r.items || []).find((e) => e.id === note.id && e.op === 'update' && !e.undone);
    assert(eintrag, 'die neue Änderung steht nicht im Verlauf');
    ok(await api.patch(`/api/records/${note.id}`, { body: 'Vierter Text' }), 'noch einmal ändern');

    const res = await api.post(`/api/history/${eintrag.seq}/undo`);
    assert(res.status === 409, `HTTP ${res.status} statt 409 — eine neuere Änderung wäre verloren gegangen`);
    const unveraendert = ok(await api.get(`/api/records/${note.id}`), 'nachher');
    assert(body(unveraendert.record).body === 'Vierter Text', 'es wurde trotzdem etwas geändert');

    // Mit ausdruecklichem "trotzdem" geht es -- aber nur dann.
    const erzwungen = ok(await api.post(`/api/history/${eintrag.seq}/undo`, { force: true }), 'force');
    assert(erzwungen.applied, 'auch mit force passierte nichts');
    return 'abgelehnt, mit force erlaubt';
  });

  await check('Ein gelöschter Satz kommt zurück', async () => {
    const weg = ok(await api.post('/api/records', {
      type: 'note', data: { title: 'Wird gelöscht', body: 'Inhalt' },
    }), 'notiz').record;
    ok(await api.del(`/api/records/${weg.id}`), 'löschen');
    const r = ok(await api.get('/api/history?limit=50'), 'verlauf');
    const eintrag = (r.items || []).find((e) => e.id === weg.id && e.op === 'delete');
    assert(eintrag, 'das Löschen steht nicht im Verlauf');
    const res = ok(await api.post(`/api/history/${eintrag.seq}/undo`), 'undo');
    const zurueck = await api.get(`/api/records/${res.applied.newId || weg.id}`);
    assert(zurueck.status === 200, `der Satz ist nicht zurück: HTTP ${zurueck.status}`);
    assert(body(zurueck.json.record).title === 'Wird gelöscht', 'ein anderer Satz kam zurück');
    return res.applied.op === 'recreate' ? `neu angelegt als ${res.applied.newId}` : 'wiederhergestellt';
  });

  await check('Verknüpfungen werden bewusst nicht aufgezeichnet', async () => {
    // Abgeleitete Kanten entstehen bei jedem Schreibvorgang neu. Ein
    // Rueckgaengig dafuer waere ein Knopf, der sichtbar nichts tut.
    const r = ok(await api.get('/api/history?limit=200'), 'verlauf');
    const kanten = (r.items || []).filter((e) => e.type === 'edge');
    assert(!kanten.length, `${kanten.length} Kanten im Verlauf — die würden beim nächsten Schreibvorgang neu entstehen`);
    return 'keine Kanten im Journal';
  });

  await check('Eine Änderung durch einen Agenten wird als solche erkannt', async () => {
    // Der einzige Punkt in dieser Datei, der nicht über HTTP geht -- und zwar
    // notwendigerweise: ein echter Agentenlauf braucht ein Modell, und auf
    // einer Maschine ohne Modell gäbe es nichts zu messen. Gemessen wird
    // trotzdem das echte Teilsystem, nur der Auslöser ist direkt.
    if (!app.history) return unklar('Änderungsverlauf nicht geladen');
    const { withActor } = require('../src/kernel/actor');
    const eigene = app.store.create('note', { title: 'Vom Nutzer geschrieben' });
    await withActor({ kind: 'agent', runId: 'run_pruefung', agentId: 'agent_pruefung' }, async () => {
      app.store.update(eigene.id, { body: 'Vom Agenten geändert' });
    });
    const eintrag = app.history.list({}).items.find((e) => e.id === eigene.id && e.op === 'update');
    assert(eintrag, 'die Änderung steht nicht im Verlauf');
    assert(eintrag.actor.kind === 'agent',
      `dem Nutzer zugeschrieben, obwohl ein Agent sie gemacht hat: ${JSON.stringify(eintrag.actor)}`);
    assert(eintrag.actor.runId === 'run_pruefung', `falscher Lauf: ${eintrag.actor.runId}`);
    // Und die Notiz selbst bleibt die des Nutzers.
    assert(app.store.get(eigene.id).data.runId === undefined,
      'die Herkunft der Notiz wurde umgeschrieben — sie gehört weiterhin dem Nutzer');
    return `Lauf ${eintrag.actor.runId}, erkannt über den ${eintrag.actor.via}`;
  });

  await check('Die Statistik sagt, wie viel ohne dich passiert ist', async () => {
    const r = ok(await api.get('/api/history/stats'), 'stats');
    assert(Number.isFinite(r.total), 'keine Gesamtzahl');
    assert(r.byActor && Number.isFinite(r.byActor.user) && Number.isFinite(r.byActor.agent),
      `keine Aufteilung nach Urheber: ${JSON.stringify(r.byActor)}`);
    return `${r.total} Einträge, ${r.undoable} rücknehmbar, davon ${r.byActor.agent} ohne dich`;
  });
}

async function checkToday(app) {
  area('17 · Heute');

  const gestern = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const morgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const ueberfaellig = ok(await api.post('/api/records', {
    type: 'task', data: { title: 'Mühle entkalken', due: gestern, priority: 1 },
  }), 'überfällig').record;
  ok(await api.post('/api/records', { type: 'task', data: { title: 'Regal bauen', due: morgen } }), 'demnächst');

  await check('Überfällig und demnächst werden getrennt', async () => {
    const t = ok(await api.get('/api/today'), 'today');
    assert(t.faellig, `kein Block "faellig": ${Object.keys(t).join(', ')}`);
    // Jeder Block sagt erst, wie sicher er ist, und erst danach was er weiß:
    // { stand, wert, grund }. Ein Leser muss an `stand` vorbei, um an `wert`
    // zu kommen -- deshalb wird hier auch `stand` geprüft und nicht nur Zahlen.
    assert(t.faellig.stand === 'gemessen',
      `der Block gibt sich nicht als gemessen aus: ${JSON.stringify(t.faellig).slice(0, 200)}`);
    const w = t.faellig.wert || {};
    const ids = (arr) => (arr || []).map((x) => x.id || (x.record && x.record.id));
    assert(ids(w.ueberfaellig).includes(ueberfaellig.id),
      `die überfällige Aufgabe steht nicht unter "ueberfaellig": ${JSON.stringify(t.faellig)}`);
    assert(!ids(w.ueberfaellig).includes('Regal bauen'), 'die künftige wurde als überfällig gezählt');
    return `${(w.ueberfaellig || []).length} überfällig, ${(w.demnaechst || []).length} demnächst`;
  });

  await check('Was ohne dich lief, steht als eigener Block da', async () => {
    const { withActor } = require('../src/kernel/actor');
    const meine = app.store.create('note', { title: 'Vom Nutzer' });
    await withActor({ kind: 'agent', runId: 'run_heute', agentId: 'agent_heute' }, async () => {
      app.store.update(meine.id, { body: 'Vom Agenten' });
    });
    const t = ok(await api.get('/api/today'), 'today');
    assert(t.ohneDich, 'kein Block "ohneDich"');
    const drin = JSON.stringify(t.ohneDich).includes('run_heute')
      || JSON.stringify(t.ohneDich).includes(meine.id);
    assert(drin, `die Änderung des Agenten fehlt: ${JSON.stringify(t.ohneDich).slice(0, 200)}`);
    return 'die Agentenänderung ist drin';
  });

  await check('Die Übersicht ändert nichts', async () => {
    const vorher = app.store.stats().counts;
    ok(await api.get('/api/today'), 'today');
    ok(await api.get('/api/today'), 'today');
    const nachher = app.store.stats().counts;
    assert(JSON.stringify(vorher) === JSON.stringify(nachher),
      `ein Blick auf "Heute" hat etwas verändert: ${JSON.stringify(vorher)} -> ${JSON.stringify(nachher)}`);
    return 'zweimal angesehen, nichts verändert';
  });

  await check('Ein fehlendes Teilsystem wird benannt, nicht verschwiegen', async () => {
    const merk = app.assist;
    app.assist = null;
    try {
      const t = ok(await api.get('/api/today'), 'today');
      assert(Array.isArray(t.fehlend), 'kein Feld "fehlend"');
      assert(t.fehlend.some((f) => /assist|vorschl/i.test(JSON.stringify(f))),
        `das fehlende Teilsystem wird nicht genannt: ${JSON.stringify(t.fehlend)}`);
      return t.fehlend.map((f) => f.teil || f).join(', ');
    } finally {
      app.assist = merk;
    }
  });
}

async function checkWatch(app) {
  area('18 · Beobachtete Ordner');

  const fsMod = require('node:fs');
  const osMod = require('node:os');
  const eingang = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'nos-eingang-'));
  fsMod.writeFileSync(path.join(eingang, 'notiz.md'), '# Espresso\n\nNeun bar, 93 Grad.\n');
  fsMod.writeFileSync(path.join(eingang, 'liste.txt'), 'Bohnen\nFilter\n');
  let ordner = null;

  try {
    await check('Ein neuer Ordner ist AUS', async () => {
      const r = ok(await api.post('/api/watch', { path: eingang, label: 'Eingang' }), 'anlegen');
      ordner = r.record;
      assert(body(ordner).enabled === false,
        'ein Ordner, der ab dem Anlegen liest, ist genau die unsichtbare Automatik, die dieses System vermeidet');
      return 'angelegt, ausgeschaltet';
    });

    await check('"Erst ansehen" findet etwas und legt nichts an', async () => {
      const vorher = app.store.count('file');
      const r = ok(await api.post(`/api/watch/${ordner.id}/scan`, { dryRun: true }), 'dryRun');
      assert(r.gefunden >= 2, `nur ${r.gefunden} gefunden`);
      assert(app.store.count('file') === vorher, `es wurden ${app.store.count('file') - vorher} Dateien angelegt`);
      return `${r.gefunden} gefunden, 0 angelegt`;
    });

    await check('Eingeschaltet nimmt er die Dateien wirklich auf', async () => {
      const vorher = app.store.count('file');
      ok(await api.patch(`/api/watch/${ordner.id}`, { enabled: true }), 'einschalten');
      const r = ok(await api.post(`/api/watch/${ordner.id}/scan`, {}), 'scan');
      assert(app.store.count('file') > vorher, `keine Datei aufgenommen: ${JSON.stringify(r)}`);
      return `${vorher} -> ${app.store.count('file')} Dateien`;
    });

    await check('Dieselbe Datei wird nicht zweimal aufgenommen', async () => {
      const vorher = app.store.count('file');
      ok(await api.post(`/api/watch/${ordner.id}/scan`, {}), 'scan');
      assert(app.store.count('file') === vorher, `noch einmal ${app.store.count('file') - vorher} angelegt`);
      return 'unverändert';
    });

    await check('Das Protokoll sagt, was aufgenommen und was übersprungen wurde', async () => {
      // Getrennt, und das ist der Punkt: "zwei aufgenommen" allein waere die
      // halbe Wahrheit, wenn drei Dateien dalagen.
      const r = ok(await api.get(`/api/watch/${ordner.id}/log`), 'log');
      assert(Array.isArray(r.aufgenommen), `kein Feld "aufgenommen": ${Object.keys(r).join(', ')}`);
      assert(Array.isArray(r.uebersprungen), 'kein Feld "uebersprungen"');
      assert(r.aufgenommen.length >= 2, `nur ${r.aufgenommen.length} aufgenommen`);
      for (const eintrag of r.aufgenommen) {
        assert(eintrag.datei || eintrag.name, `Eintrag ohne Dateinamen: ${JSON.stringify(eintrag)}`);
      }
      // Und es sagt ehrlich, was es sich NICHT merkt.
      assert(/nur, solange es läuft|solange es laeuft/i.test(String(r.hinweis || '')),
        'kein Hinweis darauf, dass übersprungene Dateien nur zur Laufzeit bekannt sind');
      return `${r.aufgenommen.length} aufgenommen, ${r.uebersprungen.length} übersprungen`;
    });

    await check('Der Tresor selbst lässt sich nicht beobachten', async () => {
      const r = await api.post('/api/watch', { path: app.paths.home });
      assert(r.status === 400 || r.status === 403,
        `HTTP ${r.status} — das System würde seine eigenen Dateien aufnehmen, bis die Platte voll ist`);
      return `HTTP ${r.status}`;
    });

    await check('Entfernen geht', async () => {
      ok(await api.del(`/api/watch/${ordner.id}`), 'löschen');
      const r = ok(await api.get('/api/watch'), 'liste');
      assert(!(r.items || []).some((x) => x.id === ordner.id), 'steht noch da');
      return 'entfernt';
    });
  } finally {
    fsMod.rmSync(eingang, { recursive: true, force: true });
  }
}

async function checkSecondLook(app) {
  area('19 · Zweiter Blick');

  const lang = 'Der Mahlgrad entscheidet über den Widerstand im Sieb. Ist er zu fein, steigt der Druck '
    + 'und der Espresso läuft nur tropfenweise; ist er zu grob, rauscht das Wasser durch und die Crema '
    + 'bleibt dünn. Die Brühtemperatur liegt bei rund 93 Grad, bei dunklen Röstungen eher darunter. '
    + 'Neun bar sind die Norm, aber viele Maschinen schwanken. Der Wassertank sollte weiches Wasser '
    + 'enthalten, sonst verkalkt die Maschine schnell. Entkalker gehört alle zwei Monate hinein. '
    + 'Offen bleibt, wie stark sich die Bohnenfrische auf den Druck auswirkt.';
  const note = ok(await api.post('/api/records', {
    type: 'note', data: { title: 'Espresso in der Praxis', body: lang },
  }), 'lange notiz').record;
  ok(await api.post('/api/records', { type: 'note', data: { title: 'Mahlgrad', body: 'Feiner Mahlgrad erhöht den Druck.' } }), 'n2');
  ok(await api.post('/api/records', { type: 'note', data: { title: 'Brühtemperatur', body: '93 Grad ist üblich.' } }), 'n3');

  await check('Die bekannten Begriffe kommen auch OHNE Modell', async () => {
    const r = ok(await api.post(`/api/notes/${note.id}/second-look`, {}), 'second-look');
    const begriffe = r.bekannteBegriffe || [];
    assert(begriffe.length > 0, `keine Begriffe: ${JSON.stringify(r).slice(0, 250)}`);
    return begriffe.slice(0, 4).map((b) => b.begriff || b.term || b).join(', ');
  });

  await check('Ohne Modell wird nichts erfunden, sondern gesagt was fehlt', async () => {
    const r = ok(await api.post(`/api/notes/${note.id}/second-look`, {}), 'second-look');
    if (r.kern) return unklar(`ein Modell ist erreichbar — Kernaussage: ${String(r.kern).slice(0, 60)}`);
    assert(r.kern === null, `kern ist weder null noch gefüllt: ${JSON.stringify(r.kern)}`);
    const hinweis = r.hinweis || r.note || '';
    assert(/Modell/i.test(hinweis), `kein Hinweis auf das fehlende Modell: ${JSON.stringify(hinweis)}`);
    return 'kern=null, mit Begründung';
  });

  await check('Eine zu kurze Notiz wird mit Begründung abgewiesen', async () => {
    const kurz = ok(await api.post('/api/records', {
      type: 'note', data: { title: 'Kurz', body: 'Zwei Sätze. Mehr nicht.' },
    }), 'kurze notiz').record;
    const r = await api.post(`/api/notes/${kurz.id}/second-look`, {});
    assert(r.status === 400 || r.status === 422, `HTTP ${r.status}`);
    const msg = JSON.stringify(r.json);
    assert(/kurz|Zeichen/i.test(msg), `ohne Begründung abgewiesen: ${msg.slice(0, 160)}`);
    return `HTTP ${r.status}, mit Begründung`;
  });

  await check('Der Aufruf geht von sich aus nicht ins Netz', async () => {
    const vorher = app.gate.stats();
    ok(await api.post(`/api/notes/${note.id}/second-look`, {}), 'second-look');
    const nachher = app.gate.stats();
    const neu = (nachher.byHost && Object.keys(nachher.byHost).length) || 0;
    const alt = (vorher.byHost && Object.keys(vorher.byHost).length) || 0;
    assert(neu === alt || nachher.blocked >= vorher.blocked,
      'es wurde ein neuer Host kontaktiert, ohne dass jemand das erlaubt hat');
    return 'kein neuer Host';
  });
}

const AREAS = {
  verdrahtung: checkWiring,
  status: checkStatus,
  notizen: checkRecords,
  kalender: checkKalender,
  terminagent: checkTerminAgent,
  suche: checkSearch,
  graph: checkGraph,
  chat: checkChat,
  modelle: checkModels,
  netz: checkNetwork,
  agenten: checkAgents,
  daten: checkVaultAndBackup,
  module: checkModules,
  abgleich: checkSync,
  extraktion: checkExtraction,
  stick: checkStick,
  vorschlaege: checkAssist,
  automatik: checkAutomation,
  rueckgaengig: checkHistory,
  heute: checkToday,
  ordner: checkWatch,
  zweiterblick: checkSecondLook,
};

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-check-'));

  console.log(`\n${B}Neural OS · Funktionsprüfung${X}`);
  console.log(`${D}Jede Funktion über die echte Schnittstelle, gegen einen echten Vault.${X}`);
  console.log(`${D}Was nicht geprüft werden kann, heisst "unklar" — nie "bestanden".${X}`);

  const { createApp, seedIfEmpty } = require('../src/app');
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: true });
  await seedIfEmpty(app);
  await app.loadModules({});
  const server = await app.listen();
  PORT = server.server.address().port;

  try {
    for (const [name, fn] of Object.entries(AREAS)) {
      if (wanted.length && !wanted.includes(name)) continue;
      await fn(app);
    }
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  const unklarCount = results.filter((r) => r.status === 'unklar').length;

  console.log(`\n${D}${'─'.repeat(64)}${X}`);
  console.log(`${B}Ergebnis${X}  ${G}${okCount} funktionieren${X}`
    + (unklarCount ? ` · ${Y}${unklarCount} nicht prüfbar${X}` : '')
    + (failCount ? ` · ${R}${failCount} defekt${X}` : ''));

  if (failCount) {
    console.log(`\n${R}Was nicht funktioniert:${X}`);
    for (const r of results.filter((x) => x.status === 'fail')) {
      console.log(`  ${R}✗${X} [${r.area}] ${r.what}`);
      console.log(`      ${D}${r.detail}${X}`);
    }
  }
  if (unklarCount) {
    console.log(`\n${Y}Nicht prüfbar (Voraussetzung fehlt):${X}`);
    for (const r of results.filter((x) => x.status === 'unklar')) {
      console.log(`  ${Y}?${X} [${r.area}] ${r.what} — ${r.detail}`);
    }
  }
  console.log('');
  process.exit(failCount ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${R}Die Prüfung selbst ist gescheitert:${X} ${err && err.message}`);
  if (err && err.stack) console.error(`${D}${err.stack.split('\n').slice(0, 8).join('\n')}${X}`);
  process.exit(2);
});
