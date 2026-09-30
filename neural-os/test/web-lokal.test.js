'use strict';

/**
 * Paket W1 (docs/STICK-BAUPLAN.md 2.11): was ein Browser von einer KI
 * behalten darf, und dass jede Anfrage sagt, zu welcher KI der Tab gehört.
 *
 * - localStorage und sessionStorage gibt es nur in web/lib/lokal.js; die
 *   Schlüssel tragen die Kennung der KI, fremde und alte verschwinden beim
 *   Start, Entwürfe liegen nur in sessionStorage.
 * - web/lib/api.js schickt die Kennung in X-Neural-OS mit (auch bei GET und
 *   im Ereignisstrom); auf 409 KI_GEWECHSELT lädt die Seite neu.
 * - Vom Stick (status.portable) gibt es keinen Service Worker.
 *
 * Gegen genau den Quelltext, den der Browser holt (kopiert nach .mjs).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

const WEB = path.join(__dirname, '..', 'web');

function alleDateien(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) alleDateien(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

let geladen = null;
async function laden() {
  if (geladen) return geladen;
  const { home, cleanup } = tempHome('nos-web-lokal');
  const alsModul = (src) => src.replace(/(from\s+')(\.[^']+)\.js(')/g, (m, kopf, spec, ende) => `${kopf}${spec}.mjs${ende}`);
  for (const name of ['lokal', 'api']) {
    fs.writeFileSync(path.join(home, `${name}.mjs`), alsModul(fs.readFileSync(path.join(WEB, 'lib', `${name}.js`), 'utf8')));
  }
  try {
    geladen = {
      lokal: await import(pathToFileURL(path.join(home, 'lokal.mjs')).href),
      api: await import(pathToFileURL(path.join(home, 'api.mjs')).href),
    };
  } finally {
    cleanup();
  }
  return geladen;
}

/** Ein Speicher wie im Browser (Web Storage), zum Nachsehen. */
function speicher(start = {}) {
  const m = new Map(Object.entries(start));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    alle: () => Object.fromEntries(m),
  };
}

async function mitSpeicher(dauer, sitzung, fn) {
  const alt = { l: globalThis.localStorage, s: globalThis.sessionStorage };
  Object.defineProperty(globalThis, 'localStorage', { value: dauer, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: sitzung, configurable: true, writable: true });
  const { lokal } = await laden();
  lokal._zuruecksetzen();
  try {
    await fn(lokal);
  } finally {
    lokal._zuruecksetzen();
    Object.defineProperty(globalThis, 'localStorage', { value: alt.l, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'sessionStorage', { value: alt.s, configurable: true, writable: true });
  }
}

test('W1: localStorage und sessionStorage kommen im Browser-Code nur in web/lib/lokal.js vor', () => {
  const funde = [];
  for (const datei of alleDateien(WEB)) {
    if (datei.endsWith(path.join('lib', 'lokal.js'))) continue;
    const zeilen = fs.readFileSync(datei, 'utf8').split('\n');
    zeilen.forEach((z, i) => {
      if (/\b(localStorage|sessionStorage)\b/.test(z)) funde.push(`${path.relative(WEB, datei)}:${i + 1}: ${z.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(funde, [], 'direkt im Browser-Speicher, an lib/lokal.js vorbei');
});

test('W1: der Service Worker wird nur registriert, wenn Neural OS NICHT vom Stick läuft', () => {
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const register = [...app.matchAll(/serviceWorker\.register\(/g)];
  assert.equal(register.length, 1, 'genau eine Registrierung');
  const aufrufe = [...app.matchAll(/(?<!function )\bregisterServiceWorker\(\)/g)].map((m) => m.index);
  assert.equal(aufrufe.length, 1, 'registerServiceWorker wird genau einmal aufgerufen');
  const vorher = app.slice(Math.max(0, aufrufe[0] - 400), aufrufe[0]);
  assert.match(vorher, /function serviceWorkerFuer\(status\)[\s\S]*portable[\s\S]*if \(!portabel\) \{\s*$/, '… und nur hinter der Prüfung auf portable');
  assert.match(app, /serviceWorkerFuer\(state\.get\('status'\)\)/, 'mit dem Status von /api/status');
  assert.match(app, /getRegistrations\(\)[\s\S]*unregister\(\)/, 'vom Stick: vorhandene Worker werden abgemeldet');
  assert.match(app, /n\.startsWith\('neural-os-shell-'\)[\s\S]*caches\.delete/, '… und ihr Zwischenspeicher gelöscht');
});

test('W1: Schlüssel tragen die Kennung der KI; fremde und alte verschwinden beim Start', async () => {
  const dauer = speicher({
    'neural-os:dev_aaaaaaaaaaaaaaaaaaaaaaaa:design': 'light',
    'neural-os:dev_aaaaaaaaaaaaaaaaaaaaaaaa:seiten': '{"breit":{"links":false,"rechts":true}}',
    'neural-os:theme': 'dark',
    'neural-os:active-chat': 'chat_alt',
    'neural-os:chat-entwurf:neu': 'Geheimer Entwurf',
    theme: 'light',
    'chat-draft:chat_x': 'noch älter',
    'fremd:nicht-von-uns': 'bleibt',
  });
  const sitzung = speicher({ 'neural-os:dev_bbbbbbbbbbbbbbbbbbbbbbbb:entwurf:neu': 'Entwurf von B' });
  await mitSpeicher(dauer, sitzung, async (lokal) => {
    // Vor /api/status: die Kennung, deren Vorlieben hier liegen -- nur für den ersten Bildaufbau.
    assert.equal(lokal.vorlaeufig(), 'dev_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(lokal.lesen('design'), 'light');
    // /api/status sagt: das hier ist KI B. Alles von A und alles Alte ist weg.
    assert.equal(lokal.kiSetzen('dev_bbbbbbbbbbbbbbbbbbbbbbbb'), true, 'eine andere KI als vermutet');
    assert.deepEqual(dauer.alle(), { 'fremd:nicht-von-uns': 'bleibt' });
    assert.deepEqual(sitzung.alle(), { 'neural-os:dev_bbbbbbbbbbbbbbbbbbbbbbbb:entwurf:neu': 'Entwurf von B' }, 'der eigene Entwurf bleibt');
    assert.equal(lokal.lesen('design'), null, 'B sieht nichts von A');
    lokal.schreiben('design', 'dark');
    lokal.schreibenJson('seiten', { breit: { links: true, rechts: false } });
    assert.deepEqual(Object.keys(dauer.alle()).sort(), [
      'fremd:nicht-von-uns',
      'neural-os:dev_bbbbbbbbbbbbbbbbbbbbbbbb:design',
      'neural-os:dev_bbbbbbbbbbbbbbbbbbbbbbbb:seiten',
    ]);
    assert.deepEqual(lokal.lesenJson('seiten', {}), { breit: { links: true, rechts: false } });
    assert.equal(lokal.kiSetzen('dev_bbbbbbbbbbbbbbbbbbbbbbbb'), false, 'dieselbe KI: nichts ändert sich');
  });
});

test('W1: im localStorage steht nie Inhalt – nur erlaubte Namen; Entwürfe nur in sessionStorage', async () => {
  const dauer = speicher();
  const sitzung = speicher();
  await mitSpeicher(dauer, sitzung, async (lokal) => {
    assert.equal(lokal.schreiben('design', 'dark'), false, 'ohne Kennung wird nichts geschrieben');
    lokal.kiSetzen('dev_cccccccccccccccccccccccc');
    assert.equal(lokal.schreiben('chat-titel', 'Mein Tagebuch'), false, 'kein erlaubter Name');
    assert.equal(lokal.schreiben('entwurf:neu', 'Text'), false);
    assert.deepEqual(dauer.alle(), {});
    for (const name of ['seiten', 'kalender-ansicht', 'aktiver-chat']) assert.ok(lokal.ERLAUBT.includes(name), name);
    lokal.entwurf.schreiben('chat_1', 'Liebe Oma,');
    assert.deepEqual(dauer.alle(), {}, 'der Entwurf liegt nicht im localStorage');
    assert.deepEqual(sitzung.alle(), { 'neural-os:dev_cccccccccccccccccccccccc:entwurf:chat_1': 'Liebe Oma,' });
    assert.equal(lokal.entwurf.lesen('chat_1'), 'Liebe Oma,');
    lokal.entwurf.loeschen('chat_1');
    assert.deepEqual(sitzung.alle(), {});
    assert.equal(lokal.kiSetzen('nicht gültig!'), false, 'eine Kennung mit Leerzeichen gilt nicht');
    assert.equal(lokal.kiKennung(), 'dev_cccccccccccccccccccccccc');
  });
  // Ein Speicher, der wirft (privates Fenster): nichts bricht.
  const wirft = { get length() { throw new Error('gesperrt'); }, key() { throw new Error('gesperrt'); }, getItem() { throw new Error('gesperrt'); }, setItem() { throw new Error('gesperrt'); }, removeItem() { throw new Error('gesperrt'); } };
  await mitSpeicher(wirft, wirft, async (lokal) => {
    assert.equal(lokal.vorlaeufig(), null);
    lokal.kiSetzen('dev_dddddddddddddddddddddddd');
    assert.equal(lokal.schreiben('design', 'dark'), false);
    assert.equal(lokal.lesen('design', 'dark'), 'dark');
    assert.equal(lokal.entwurf.lesen('x'), null);
  });
});

test('W1: nach /api/status trägt jede Anfrage die Kennung der KI – auch GET und der Ereignisstrom; 409 KI_GEWECHSELT lädt neu', async () => {
  const { api: mod } = await laden();
  const gesehen = [];
  let neu = 0;
  const altFetch = globalThis.fetch;
  const altWindow = globalThis.window;
  globalThis.window = { location: { origin: 'http://127.0.0.1:21234', reload: () => { neu += 1; } }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  globalThis.fetch = async (url, init) => {
    gesehen.push({ url: String(url), methode: init.method || 'GET', kopf: (init.headers || {})['X-Neural-OS'] ?? null });
    if (String(url).includes('/api/fremd')) {
      return new Response(JSON.stringify({ error: { code: 'KI_GEWECHSELT', message: 'Dieser Tab gehört zu einer anderen KI.' } }), { status: 409, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    mod.kiSetzen(null);
    await mod.api.get('/status');
    await mod.api.post('/chats', {});
    assert.deepEqual(gesehen.map((g) => g.kopf), [null, '1'], 'vorher: GET ohne, Änderungen mit „1“');
    mod.kiSetzen('dev_eeeeeeeeeeeeeeeeeeeeeeee');
    await mod.api.get('/records');
    await mod.api.patch('/config', { ui: { design: 'dark' } });
    assert.deepEqual(gesehen.slice(2).map((g) => g.kopf), ['dev_eeeeeeeeeeeeeeeeeeeeeeee', 'dev_eeeeeeeeeeeeeeeeeeeeeeee']);
    await assert.rejects(mod.api.get('/fremd'), (e) => e.code === 'KI_GEWECHSELT' && e.status === 409);
    assert.equal(neu, 1, 'die Seite lädt neu');
    await assert.rejects(mod.api.get('/fremd'));
    assert.equal(neu, 1, 'und nur einmal');
    assert.equal(mod.kiSetzen('mit leer zeichen'), null, 'eine ungültige Kennung wird nicht gesendet');
  } finally {
    globalThis.fetch = altFetch;
    globalThis.window = altWindow;
    mod.kiSetzen(null);
  }
  // Der Ereignisstrom: fetch mit dem Kopf (EventSource könnte keinen setzen).
  const src = fs.readFileSync(path.join(WEB, 'lib', 'api.js'), 'utf8');
  assert.match(src, /headers: \{ Accept: 'text\/event-stream', \.\.\.\(kiKennung \? \{ 'X-Neural-OS': kiKennung \} : \{\}\) \}/);
});

test('W1: der Tab-Titel nennt nie einen Chat oder eine Notiz; der Name der KI steht oben', () => {
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const titelZuweisungen = [...app.matchAll(/document\.title\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(titelZuweisungen.length >= 1);
  for (const t of titelZuweisungen) {
    assert.ok(!/\btitle\b|value|chatTitle/.test(t), `document.title aus einem Inhalt: ${t}`);
  }
  assert.match(app, /state\.set\('kiName'/, 'der Name kommt aus status.ki');
  assert.match(app, /h\('span\.rail__ki'/, '… und steht oben in der Leiste');
});

module.exports = { name: 'web-lokal', tests: require('./harness').drain() };
