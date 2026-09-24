'use strict';

/**
 * web/sw.js ohne Browser: der Quelltext läuft in einer vm mit nachgebildetem
 * `self`, `caches` und `fetch`. Geprüft wird zweierlei:
 *
 *  1. Nichts unter /api landet je im Zwischenspeicher -- nicht der Status,
 *     nicht die Vorraum-Seite /api/entsperren, nicht der Einmal-Link des
 *     iPads, und der Ereignisstrom wird gar nicht erst angefasst.
 *  2. Eine neue Fassung übernimmt sofort (skipWaiting nach vollem Cache,
 *     alte Caches weg, clients.claim). Ein wartender Worker bediente sonst
 *     weiter aus dem alten Cache und mischte alte und neue Module -- das
 *     zeigt der Beweis mit zwei Ständen im echten Chromium.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, drain } = require('./harness');

const SW = path.join(__dirname, '..', 'web', 'sw.js');
const ORIGIN = 'http://127.0.0.1:27777';

function schluessel(req) {
  if (typeof req === 'string') return new URL(req, `${ORIGIN}/`).pathname;
  const u = new URL(req.url);
  return u.pathname + u.search;
}

function ladeSw({ netz } = {}) {
  const handler = {};
  const log = [];
  const ablage = new Map();
  const caches = {
    async open(name) {
      log.push(['open', name]);
      if (!ablage.has(name)) ablage.set(name, new Map());
      const m = ablage.get(name);
      return {
        async match(req) {
          log.push(['match', name, schluessel(req)]);
          return m.get(schluessel(req));
        },
        async put(req, res) {
          log.push(['put', name, schluessel(req)]);
          m.set(schluessel(req), res);
        },
      };
    },
    async keys() {
      return [...ablage.keys()];
    },
    async delete(name) {
      log.push(['delete', name]);
      return ablage.delete(name);
    },
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (typ, fn) => { handler[typ] = fn; },
    skipWaiting: async () => { log.push(['skipWaiting']); },
    clients: { claim: async () => { log.push(['claim']); } },
  };
  // Relative Adressen wie im Worker ('./app.js') gegen den Ursprung auflösen.
  class Anfrage extends Request {
    constructor(url, opts) {
      super(typeof url === 'string' ? new URL(url, `${ORIGIN}/`) : url, opts);
    }
  }
  const kontext = vm.createContext({
    self,
    caches,
    fetch: async (req) => {
      log.push(['fetch', schluessel(req)]);
      if (netz) return netz(req);
      return new Response('inhalt', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
    Request: Anfrage,
    Response,
    Headers,
    URL,
    console,
  });
  vm.runInContext(fs.readFileSync(SW, 'utf8'), kontext, { filename: 'web/sw.js' });
  return { handler, log, ablage, version: vm.runInContext('VERSION', kontext), shell: vm.runInContext('SHELL_ASSETS', kontext) };
}

/** Ein fetch-Ereignis; liefert, ob der Worker antwortet, und seine Antwort. */
async function hole(sw, { pfad, method = 'GET', mode = 'cors', accept = '' }) {
  let antwort = null;
  let antwortet = false;
  const request = { url: `${ORIGIN}${pfad}`, method, mode, headers: new Headers(accept ? { accept } : {}) };
  sw.handler.fetch({
    request,
    respondWith(p) {
      antwortet = true;
      antwort = p;
    },
  });
  return { antwortet, antwort: antwort ? await antwort : null };
}

async function warteAuf(event) {
  const versprechen = [];
  await event.handler({ waitUntil: (p) => versprechen.push(p) });
  await Promise.all(versprechen);
}

test('Nichts unter /api landet im Zwischenspeicher, auch nicht der Vorraum oder der iPad-Link', async () => {
  const sw = ladeSw();
  const faelle = [
    { pfad: '/api/status' },
    { pfad: '/api' },
    { pfad: '/api?x=1' },
    { pfad: '/api/records?type=note' },
    { pfad: '/api/claude' },
    { pfad: '/api/entsperren', mode: 'navigate', accept: 'text/html' },
    { pfad: '/api/verbinden?c=einmal', mode: 'navigate', accept: 'text/html' },
  ];
  for (const fall of faelle) {
    sw.log.length = 0;
    const { antwortet, antwort } = await hole(sw, fall);
    assert.ok(antwortet, `${fall.pfad}: der Worker reicht ans Netz weiter`);
    assert.equal(antwort.status, 200, fall.pfad);
    assert.deepEqual(sw.log, [['fetch', fall.pfad]], `${fall.pfad}: nur das Netz, kein Cache: ${JSON.stringify(sw.log)}`);
  }
  // Der Ereignisstrom und alles Schreibende: gar nicht angefasst.
  for (const fall of [
    { pfad: '/api/events' },
    { pfad: '/api/events?since=4', accept: 'text/event-stream' },
    { pfad: '/api/chats', method: 'POST' },
    { pfad: '/api/vault/unlock', method: 'POST' },
  ]) {
    sw.log.length = 0;
    const { antwortet } = await hole(sw, fall);
    assert.equal(antwortet, false, `${fall.method || 'GET'} ${fall.pfad} geht am Worker vorbei`);
    assert.deepEqual(sw.log, []);
  }
  assert.deepEqual([...sw.ablage.values()].flatMap((m) => [...m.keys()]).filter((k) => k.startsWith('/api')), []);
});

test('Ohne Server: /api bekommt ein ehrliches 503, und auch das wird nicht abgelegt', async () => {
  const sw = ladeSw({ netz: async () => { throw new TypeError('Failed to fetch'); } });
  const { antwort } = await hole(sw, { pfad: '/api/status' });
  assert.equal(antwort.status, 503);
  const body = JSON.parse(await antwort.text());
  assert.equal(body.error.code, 'SERVER_UNREACHABLE');
  assert.ok(!sw.log.some(([art]) => art === 'put' || art === 'open'));
});

test('Eine neue Fassung übernimmt sofort: voller Cache, dann skipWaiting; alte Caches weg, dann claim', async () => {
  const sw = ladeSw();
  // Seit v4 wurde web/ in weiten Teilen neu geschrieben; ohne neue Nummer
  // sähe ein Browser mit altem Stand keinen neuen Worker.
  assert.notEqual(sw.version, 'v4');
  const eigener = `neural-os-shell-${sw.version}`;

  await warteAuf({ handler: sw.handler.install });
  const puts = sw.log.filter(([art]) => art === 'put').map(([, name, k]) => [name, k]);
  assert.equal(puts.length, sw.shell.length, 'jede Datei der Schale liegt im neuen Cache');
  assert.ok(puts.every(([name]) => name === eigener));
  const skip = sw.log.findIndex(([art]) => art === 'skipWaiting');
  assert.ok(skip !== -1, 'install ruft skipWaiting -- sonst wartet die neue Fassung, und die alte bedient weiter');
  const letzterPut = sw.log.map(([art]) => art).lastIndexOf('put');
  assert.ok(skip > letzterPut, 'skipWaiting erst, wenn der neue Cache voll ist');

  sw.log.length = 0;
  sw.ablage.set('neural-os-shell-v4', new Map());
  sw.ablage.set('etwas-anderes', new Map());
  await warteAuf({ handler: sw.handler.activate });
  assert.deepEqual(sw.log.filter(([art]) => art === 'delete'), [['delete', 'neural-os-shell-v4']]);
  assert.deepEqual(sw.log[sw.log.length - 1], ['claim'], 'danach übernimmt der Worker die offenen Seiten');
  assert.deepEqual([...sw.ablage.keys()].sort(), ['etwas-anderes', eigener].sort());
});

module.exports = { name: 'service-worker', tests: drain() };
