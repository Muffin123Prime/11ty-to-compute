'use strict';

/**
 * Kopfzeilen für den Sandkasten und die App (docs/ANTWORT-BAUSTEINE.md 6-7):
 * /sandbox.html bekommt seine eigene, enge CSP und darf NUR von der App
 * eingebettet werden; die App-CSP nennt frame-src 'self'; das Mikrofon ist
 * für die App erlaubt, für den Sandkasten nicht. Gegen den echten Server
 * mit einer eigenen Oberflächen-Wurzel (die echte web/sandbox.html baut die
 * Oberfläche; hier zählt nur, was der Server mit ihr macht).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test, tempHome } = require('./harness');
const { createServer, CSP, SANDBOX_CSP } = require('../src/http/server');

function holen(base, pfad) {
  return new Promise((resolve, reject) => {
    const url = new URL(pfad, base);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { host: `127.0.0.1:${url.port}` } }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(teile).toString('utf8') }));
    }).on('error', reject);
  });
}

async function mitWurzel(fn) {
  const { home, cleanup } = tempHome('nos-sandbox');
  const web = path.join(home, 'web');
  fs.mkdirSync(path.join(web, 'unter'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Neural OS</title>');
  fs.writeFileSync(path.join(web, 'sandbox.html'), '<!doctype html><title>Sandkasten</title><script>1</script>');
  fs.writeFileSync(path.join(web, 'unter', 'sandbox.html'), '<!doctype html><title>kein Sandkasten</title>');
  const server = await createServer({ webRoot: web, config: {}, logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }) });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  try {
    await fn(base);
  } finally {
    await server.close();
    cleanup();
  }
}

test('Sandkasten: eigene CSP (kein Netz, nur Skripte darin), nur in der App einbettbar, kein Mikrofon', async () => {
  await mitWurzel(async (base) => {
    const r = await holen(base, '/sandbox.html');
    assert.equal(r.status, 200);
    assert.match(r.text, /Sandkasten/);
    assert.equal(r.headers['content-security-policy'], SANDBOX_CSP);
    assert.equal(SANDBOX_CSP, "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'");
    assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(r.headers['permissions-policy'], 'geolocation=(), camera=(), microphone=()');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-cache');
  });
});

test('App: frame-src \'self\', Einbetten weiter verboten, Mikrofon nur für die eigene Seite; die Ausnahme gilt nur für /sandbox.html', async () => {
  await mitWurzel(async (base) => {
    const r = await holen(base, '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-security-policy'], CSP);
    assert.match(CSP, /(^|; )frame-src 'self'(;|$)/);
    assert.match(CSP, /frame-ancestors 'none'/);
    assert.match(CSP, /object-src 'none'/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['permissions-policy'], 'geolocation=(), camera=(), microphone=(self)');
    // Eine gleichnamige Datei woanders ist kein Sandkasten.
    const unter = await holen(base, '/unter/sandbox.html');
    assert.equal(unter.status, 200);
    assert.equal(unter.headers['content-security-policy'], CSP);
    assert.equal(unter.headers['x-frame-options'], 'DENY');
    // Eine API-Antwort bleibt, wie sie war.
    const api = await holen(base, '/api/gibtsnicht');
    assert.equal(api.headers['content-security-policy'], CSP);
  });
});
