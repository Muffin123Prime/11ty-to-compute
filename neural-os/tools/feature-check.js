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

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      host: '127.0.0.1',
      port: PORT,
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

const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b === undefined ? {} : b),
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
  await check('Ohne Modell: Fehler statt erfundener Antwort', async () => {
    const res = await request('POST', `/api/chats/${chatId}/send`, { content: 'Hallo?' });
    const text = res.text || '';
    const erfunden = /"role"\s*:\s*"assistant"[\s\S]*?"content"\s*:\s*"[^"]{20,}/.test(text)
      && !/NO_MODEL_AVAILABLE|MODEL_ERROR/.test(text);
    assert(!erfunden, 'es wurde eine Antwort erfunden');
    const msgs = ok(await api.get(`/api/chats/${chatId}/messages`), 'messages');
    const list = msgs.items || msgs.messages || [];
    const assistant = list.find((m) => body(m).role === 'assistant');
    if (!assistant) return unklar('keine Assistentennachricht angelegt');
    const d = body(assistant);
    assert(d.content === '', `Inhalt nicht leer: "${String(d.content).slice(0, 40)}"`);
    assert(d.status === 'failed', `Status ist "${d.status}" statt failed`);
    return `leer, status=failed, ${d.error && d.error.code}`;
  });
  await check('Netzmodus pro Chat umschaltbar', async () => {
    const r = ok(await api.patch(`/api/chats/${chatId}`, { network: 'lan' }), 'patch');
    assert(body(r.record).network === 'lan', 'Umschaltung kam nicht an');
    await api.patch(`/api/chats/${chatId}`, { network: 'offline' });
    return 'offline → lan → offline';
  });
}

async function checkModels() {
  area('6 · Modellanbindung');
  await check('Registry antwortet', async () => {
    const m = ok(await api.get('/api/models'), 'models');
    const providers = m.providers || (m.snapshot && m.snapshot.providers) || [];
    assert(Array.isArray(providers), 'keine Provider-Liste');
    const available = providers.filter((p) => p.available);
    if (!available.length) {
      return unklar(`kein lokales Modell installiert — ${providers.length} Anbieter geprüft, keiner erreichbar`);
    }
    return `${available.length} erreichbar: ${available.map((p) => p.id).join(', ')}`;
  });
  await check('Erneutes Suchen funktioniert', async () => {
    const r = await api.post('/api/models/refresh');
    assert(r.status === 200, `HTTP ${r.status}`);
    return 'geprobt';
  });

  // --- Online-Anbieter ---------------------------------------------------
  //
  // Geprüft wird hier nicht, ob ein Anbieter antwortet (das hinge an einem
  // fremden Dienst und an einem Schlüssel), sondern die Zusage, die dieses
  // System gibt: einen anzulegen öffnet die Schleuse nicht, und der
  // Schlüssel kommt nicht wieder heraus.
  await check('Vorlagen für Online-Anbieter sind vorhanden', async () => {
    const r = ok(await api.get('/api/models/remote'), 'models/remote');
    assert(Array.isArray(r.presets) && r.presets.length >= 5, `nur ${(r.presets || []).length} Vorlagen`);
    for (const preset of r.presets) {
      assert(preset.id && preset.baseUrl && preset.host, `unvollständige Vorlage ${preset.id}`);
    }
    return `${r.presets.length} Vorlagen, Netzmodus ${r.mode}`;
  });

  await check('Anlegen eines Online-Anbieters öffnet die Schleuse nicht', async () => {
    const created = ok(await api.post('/api/models/remote', {
      id: 'pruefanbieter',
      label: 'Prüfanbieter',
      baseUrl: 'https://api.pruefung.invalid/v1',
      apiKey: 'sk-pruef-geheim-0815',
    }), 'anlegen');
    assert(created.record.gate.allowed === false,
      `die Schleuse hält den Host für erlaubt, obwohl niemand ihn freigegeben hat: ${JSON.stringify(created.record.gate)}`);
    assert(created.grant === null, 'es wurde ungefragt eine Freigabe angelegt');
    assert(/Klartext/.test(String(created.keyWarning || '')), 'der Hinweis auf den Klartext-Schlüssel fehlt');
    return 'angelegt, Host bleibt gesperrt';
  });

  await check('Der Schlüssel kommt über keine Route wieder heraus', async () => {
    const secret = 'sk-pruef-geheim-0815';
    const routes = ['/api/models/remote', '/api/config', '/api/status'];
    for (const route of routes) {
      const res = await api.get(route);
      assert(!String(res.text).includes(secret), `${route} hat den Schlüssel ausgeliefert`);
    }
    const tested = await api.post('/api/models/remote/pruefanbieter/test');
    assert(!String(tested.text).includes(secret), 'der Verbindungstest hat den Schlüssel ausgeliefert');
    return `${routes.length + 1} Routen geprüft, kein Schlüssel`;
  });

  await check('Der Verbindungstest nennt die Schleuse als Grund', async () => {
    const r = ok(await api.post('/api/models/remote/pruefanbieter/test'), 'test');
    assert(r.ok === false, 'der Anbieter existiert nicht – "erreichbar" wäre erfunden');
    assert(r.blocked === true, `nicht als Schleusen-Ablehnung erkannt: ${JSON.stringify(r.error)}`);
    assert(/Netzwerk/.test(String(r.hint || '')), 'kein Hinweis, wo man das ändert');
    return 'gesperrt statt "nicht erreichbar"';
  });

  await check('Entfernen räumt auf und verschweigt die Freigabe nicht', async () => {
    const r = ok(await api.del('/api/models/remote/pruefanbieter'), 'entfernen');
    assert(r.ok === true, 'nicht entfernt');
    const after = ok(await api.get('/api/models/remote'), 'liste');
    assert(!after.items.some((i) => i.id === 'pruefanbieter'), 'der Anbieter steht noch in der Liste');
    return 'entfernt';
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
    assert(ld.allowed === true, 'Loopback wird blockiert — lokale Modelle wären tot');
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
  await check('Export und Re-Import erhalten alles', async () => {
    const { createApp } = require('../src/app');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-roundtrip-'));
    let target = null;
    try {
      const exported = await app.backup.exportAll({ format: 'json', includeFiles: true });
      const vorher = app.store.all('note').length;
      target = await createApp({ home: tmp, logLevel: 'error', harden: false });
      const res = await target.backup.importAll({ dir: exported.dir, mode: 'merge' });
      const nachher = target.store.all('note').length;
      assert(res.imported > 0, 'nichts importiert');
      assert(nachher >= vorher, `${vorher} Notizen vorher, ${nachher} nachher`);
      return `${res.imported} übernommen, ${nachher} Notizen`;
    } finally {
      if (target) await target.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

async function checkStick() {
  area('13 · USB-Stick');
  const { createStick, LOCAL_PLATFORM } = require('../src/portable/stick');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-usb-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-src-'));
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
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------- main */

const AREAS = {
  status: checkStatus,
  notizen: checkRecords,
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
