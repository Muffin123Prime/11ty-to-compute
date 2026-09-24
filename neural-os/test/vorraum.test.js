'use strict';

/**
 * Paket V (Stick-Bauplan 2.5): Vorraum -- ein Stick mit PIN startet gesperrt,
 * die PIN kommt im Browser.
 *
 * Geprüft wird mit echten Sockets und genau so, wie der Dienst (Paket S) den
 * Vorraum benutzt: `oeffnen` ohne Passphrase, PIN über HTTP, `entsperrt`
 * abwarten, `schliessen`, dann `createApp({passphrase})` und `listen` auf
 * DEMSELBEN Port. Danach muss derselbe Browser mit dem Cookie aus dem Vorraum
 * weiterkommen, ohne zweite PIN -- und ein Browser ohne dieses Cookie nicht.
 *
 * Gemerkte Geräte landen über NEURAL_OS_GERAETE in einem Temp-Ordner; das
 * echte Benutzerprofil wird nie berührt.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test, tempHome } = require('./harness');

const vorraum = require('../src/kernel/vorraum');
const pathsMod = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { createVaultCrypto } = require('../src/store/vaultcrypto');
const { createApp } = require('../src/app');

const KI = 'dev_5e11ab1e5e11ab1e5e11ab1e';
const KI_TEIL = '5e11ab1e';
const SEITE = path.join(__dirname, '..', 'web', 'entsperren.html');

function rufe({ port, method = 'GET', pfad, headers = {}, body, hostKopf }) {
  return new Promise((resolve, reject) => {
    const daten = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pfad,
      agent: false,
      headers: {
        host: hostKopf || `127.0.0.1:${port}`,
        ...(daten ? { 'content-type': 'application/json', 'content-length': daten.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        ...headers,
      },
    }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => {
        const text = Buffer.concat(teile).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* HTML oder leer */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Zeitüberschreitung')));
    if (daten) req.write(daten);
    req.end();
  });
}

function cookieAus(res, prefix) {
  const liste = [].concat(res.headers['set-cookie'] || []);
  const treffer = liste.find((c) => c.startsWith(prefix));
  return treffer ? treffer.split(';')[0] : null;
}

/** NEURAL_OS_GERAETE für die Dauer von fn auf einen Temp-Ordner. */
async function mitProfil(fn) {
  const profil = tempHome('vorraum-profil');
  const vorher = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = profil.home;
  try {
    return await fn(profil.home);
  } finally {
    if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorher;
    profil.cleanup();
  }
}

/** Ein Heim mit Notiz und PIN, über die echte Anwendung angelegt. */
async function verschluesseltesHeim(home, pin) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, sync: { deviceId: KI, deviceName: 'Lena' } }));
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
  try {
    await app.listen({ port: 0 });
    const port = app.server.server.address().port;
    app.store.create('note', { title: 'Vorraum-Notiz', body: 'Liegt hinter der PIN.' });
    await app.store.flush();
    const r = await rufe({ port, method: 'POST', pfad: '/api/vault/pin', body: { pin } });
    assert.equal(r.status, 200, r.text);
  } finally {
    await app.close();
  }
}

/** Nur secrets.json (für Tests, die keinen Speicher brauchen). */
async function nurSchluessel(home, pin) {
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = { sync: { deviceId: KI }, security: { encryption: { enabled: true } }, server: { port: 7777 } };
  const vc = createVaultCrypto({ paths, config });
  await vc.initialise(pin);
  vc.lock();
  return { paths, config };
}

test('Vorraum: ohne Passphrase gesperrt starten, falsche PIN 401, richtige öffnet – dieselbe KI danach ohne zweite PIN', async () => {
  const heim = tempHome('vorraum-ganz');
  let v = null;
  let app = null;
  try {
    await mitProfil(async () => {
      await verschluesseltesHeim(heim.home, '4711');

      // So wie der Dienst: Konfiguration lesen, keine Passphrase.
      const paths = pathsMod.ensureLayout(pathsMod.layout(heim.home));
      const config = configMod.load(paths.config);
      assert.equal(vorraum.noetig({ paths, config }), true, 'verschlüsselt und nicht gemerkt: der Vorraum ist nötig');

      v = await vorraum.oeffnen({
        paths, config, host: '127.0.0.1', port: 0, tryPorts: 1,
        ki: { id: KI, name: 'Lena' }, instanz: 'inst12345678', heim: 'heimabcdef012345',
      });
      const port = v.port;
      assert.ok(port > 0);
      assert.equal(v.url, `http://127.0.0.1:${port}/api/entsperren`);

      const gesundheit = await rufe({ port, pfad: '/api/health' });
      assert.equal(gesundheit.status, 200);
      assert.equal(gesundheit.json.ok, true);
      assert.equal(gesundheit.json.instanz, 'inst12345678');
      assert.equal(gesundheit.json.heim, 'heimabcdef012345');
      assert.equal(gesundheit.json.gesperrt, true);

      const status = await rufe({ port, pfad: '/api/status' });
      assert.equal(status.status, 200);
      assert.equal(status.json.gesperrt, true);
      assert.deepEqual(status.json.ki, { id: KI, name: 'Lena' });
      assert.equal(status.headers['cache-control'], 'no-store');
      // Ein alter Tab einer anderen KI wird abgewiesen, wie im Server (Paket I).
      const fremdeKi = await rufe({ port, pfad: '/api/status', headers: { 'x-neural-os': 'dev_000000000000000000000000' } });
      assert.equal(fremdeKi.status, 409);
      assert.equal((await rufe({ port, pfad: '/api/status', headers: { 'x-neural-os': KI } })).status, 200);

      // Die Seite: unter /api/ (dort bedient der Service Worker nie aus dem
      // Zwischenspeicher) und für jeden anderen Pfad -- dort nie mit 2xx,
      // damit kein Zwischenspeicher sie als Schale ablegt.
      const seite = await rufe({ port, pfad: '/api/entsperren' });
      assert.equal(seite.status, 200);
      assert.match(seite.headers['content-type'], /^text\/html/);
      assert.equal(seite.headers['cache-control'], 'no-store');
      assert.match(seite.text, /inputmode="numeric"/);
      for (const pfad of ['/', '/index.html', '/app.js', '/irgendwas/tief']) {
        const r = await rufe({ port, pfad, headers: { accept: 'text/html' } });
        assert.equal(r.status, 423, pfad);
        assert.match(r.headers['content-type'], /^text\/html/, pfad);
        assert.equal(r.headers['cache-control'], 'no-store', pfad);
        assert.equal(r.text, seite.text, pfad);
      }
      // Die Schale (falls ein Service Worker sie zeigt) bekommt keine Daten.
      const daten = await rufe({ port, pfad: '/api/records?type=note' });
      assert.equal(daten.status, 423);
      assert.equal(daten.json.error.code, 'VAULT_LOCKED');
      assert.equal(daten.text.includes('Vorraum-Notiz'), false);

      // CSRF und DNS-Rebinding wie im Server.
      const ohneKopf = await rufe({ port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '4711' }, headers: { 'x-neural-os': '' } });
      assert.equal(ohneKopf.status, 403);
      const fremderUrsprung = await rufe({ port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '4711' }, headers: { origin: 'http://boese.example' } });
      assert.equal(fremderUrsprung.status, 403);
      const fremderHost = await rufe({ port, pfad: '/api/status', hostKopf: `boese.example:${port}` });
      assert.equal(fremderHost.status, 403);

      const falsch = await rufe({ port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '0000' } });
      assert.equal(falsch.status, 401, falsch.text);
      assert.equal(falsch.json.error.code, 'FALSCHE_PIN');
      assert.equal(falsch.json.error.message, 'Falsche PIN.');
      assert.equal(cookieAus(falsch, 'nos_s_'), null);

      let entsperrt = null;
      v.entsperrt.then((e) => { entsperrt = e; });
      const richtig = await rufe({ port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '4711' } });
      assert.equal(richtig.status, 200, richtig.text);
      const cookie = cookieAus(richtig, `nos_s_${KI_TEIL}=`);
      assert.ok(cookie, 'der entsperrende Browser bekommt die PIN-Sitzung');
      assert.match([].concat(richtig.headers['set-cookie']).join(';'), /HttpOnly/);

      const e = await v.entsperrt;
      assert.deepEqual(e, { passphrase: '4711', port, sitzung: true, gemerkt: false });
      assert.ok(entsperrt);

      // Bis der Dienst umschaltet, bleibt der Vorraum gesperrt -- und nimmt
      // danach keine beliebige PIN an, nur weil er schon offen ist.
      assert.equal((await rufe({ port, pfad: '/api/status' })).json.gesperrt, true);
      const danachFalsch = await rufe({ port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '1111' } });
      assert.equal(danachFalsch.status, 401);

      // Der Dienst: schließen, echte Anwendung auf DEMSELBEN Port.
      await v.schliessen();
      v = null;
      app = await createApp({ home: heim.home, port, host: '127.0.0.1', logLevel: 'error', harden: false, passphrase: e.passphrase });
      app.auth.bindungEinschalten();
      await app.listen({ port });

      const offen = await rufe({ port, pfad: '/api/status' });
      assert.equal(offen.status, 200);
      assert.equal('gesperrt' in offen.json, false, 'die Seite wartet genau darauf');
      const notizen = await rufe({ port, pfad: '/api/records?type=note', headers: { cookie } });
      assert.equal(notizen.status, 200, notizen.text);
      assert.ok(notizen.json.items.some((r) => r.data.title === 'Vorraum-Notiz'), 'die Notiz hinter der PIN');
      // Gegenprobe: ohne das Cookie aus dem Vorraum kommt niemand an die Daten.
      const ohneCookie = await rufe({ port, pfad: '/api/records?type=note' });
      assert.equal(ohneCookie.status, 401);
      assert.equal(ohneCookie.json.error.code, 'PIN_NOETIG');
    });
  } finally {
    if (v) await v.schliessen().catch(() => {});
    if (app) await app.close().catch(() => {});
    heim.cleanup();
  }
});

test('Vorraum: nach 5 Fehlversuchen 30 s Pause (429), auch für die richtige PIN', async () => {
  const heim = tempHome('vorraum-sperre');
  let v = null;
  try {
    await mitProfil(async () => {
      const { paths, config } = await nurSchluessel(heim.home, '2468');
      v = await vorraum.oeffnen({ paths, config, port: 0, ki: { id: KI, name: 'Max' }, instanz: 'i', heim: 'h' });
      for (let i = 1; i <= 4; i++) {
        const r = await rufe({ port: v.port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: `000${i}` } });
        assert.equal(r.status, 401, `Versuch ${i}`);
        assert.equal(r.json.error.message, 'Falsche PIN.');
      }
      const fuenfter = await rufe({ port: v.port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '0005' } });
      assert.equal(fuenfter.status, 429);
      assert.equal(fuenfter.json.error.code, 'ZU_OFT_FALSCH');
      assert.equal(fuenfter.json.error.message, 'Zu oft falsch. Kurz warten.');
      assert.equal(fuenfter.json.error.details.wartenS, 30);
      const richtig = await rufe({ port: v.port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '2468' } });
      assert.equal(richtig.status, 429, 'in der Pause wird nicht geprüft');
      assert.equal(cookieAus(richtig, 'nos_s_'), null);
      // Ohne Passphrase-Feld: wie im Server 400, zählt nicht.
      const leer = await rufe({ port: v.port, method: 'POST', pfad: '/api/vault/unlock', body: {} });
      assert.equal(leer.status, 400);
    });
  } finally {
    if (v) await v.schliessen().catch(() => {});
    heim.cleanup();
  }
});

test('Vorraum: nicht nötig ohne PIN oder am gemerkten Rechner; dann gleich "entsperrt"', async () => {
  const heim = tempHome('vorraum-gemerkt');
  const klar = tempHome('vorraum-klar');
  let v = null;
  try {
    await mitProfil(async () => {
      const klarPaths = pathsMod.ensureLayout(pathsMod.layout(klar.home));
      assert.equal(vorraum.noetig({ paths: klarPaths, config: { sync: { deviceId: KI } } }), false, 'ohne PIN kein Vorraum');

      const { paths, config } = await nurSchluessel(heim.home, '135790');
      assert.equal(vorraum.noetig({ paths, config }), true);
      const vc = createVaultCrypto({ paths, config });
      await vc.unlock('135790');
      vc.merken({ kiId: KI, name: 'Testrechner' });
      assert.equal(vorraum.noetig({ paths, config }), false, 'am gemerkten Rechner öffnet der Tresor selbst');

      // Ruft der Dienst trotzdem, bricht nichts ab: sofort "entsperrt", ohne Passphrase.
      v = await vorraum.oeffnen({ paths, config, port: 0, ki: { id: KI, name: 'Max' }, instanz: 'i', heim: 'h' });
      const e = await v.entsperrt;
      assert.deepEqual(e, { passphrase: null, port: v.port, sitzung: false, gemerkt: true });
    });
  } finally {
    if (v) await v.schliessen().catch(() => {});
    heim.cleanup();
    klar.cleanup();
  }
});

test('Vorraum: {merken:true} wie im PIN-Ablauf -- der nächste Start an diesem Rechner braucht keinen Vorraum', async () => {
  const heim = tempHome('vorraum-merken');
  let v = null;
  try {
    await mitProfil(async (profil) => {
      const { paths, config } = await nurSchluessel(heim.home, '5791');
      v = await vorraum.oeffnen({ paths, config, port: 0, ki: { id: KI, name: 'Max' }, instanz: 'i', heim: 'h' });
      const r = await rufe({ port: v.port, method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '5791', merken: true } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.gemerkt, true);
      const e = await v.entsperrt;
      assert.equal(e.gemerkt, true);
      assert.ok(fs.existsSync(path.join(profil, `${KI}.json`)), 'der Schlüssel liegt im Profil dieses Rechners');
      assert.equal(vorraum.noetig({ paths, config }), false);
    });
  } finally {
    if (v) await v.schliessen().catch(() => {});
    heim.cleanup();
  }
});

test('Vorraum: belegter Port -> der nächste (tryPorts), und schliessen gibt den Port sofort frei', async () => {
  const heim = tempHome('vorraum-port');
  let v = null;
  const blocker = http.createServer(() => {});
  try {
    await mitProfil(async () => {
      const { paths, config } = await nurSchluessel(heim.home, '9753');
      await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
      const belegt = blocker.address().port;
      v = await vorraum.oeffnen({ paths, config, port: belegt, tryPorts: 3, ki: { id: KI, name: 'Max' }, instanz: 'i', heim: 'h' });
      assert.equal(v.port, belegt + 1);
      // Ein offener Keep-alive-Tab darf das Umschalten nicht aufhalten.
      const agent = new http.Agent({ keepAlive: true });
      await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: v.port, path: '/api/status', agent }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
      });
      const frei = v.port;
      await v.schliessen();
      v = null;
      const neu = http.createServer(() => {});
      await new Promise((resolve, reject) => { neu.once('error', reject); neu.listen(frei, '127.0.0.1', resolve); });
      await new Promise((r) => neu.close(r));
      agent.destroy();
    });
  } finally {
    if (v) await v.schliessen().catch(() => {});
    await new Promise((r) => blocker.close(() => r()));
    heim.cleanup();
  }
});

test('entsperren.html: ohne form, ohne type=password, PIN-Feld numerisch, Texte aus 1.8 wörtlich', () => {
  const html = fs.readFileSync(SEITE, 'utf8');
  assert.equal(/<form[\s>]/i.test(html), false, 'kein <form>');
  assert.equal(/type\s*=\s*["']?password/i.test(html), false, 'kein type=password');
  const feld = /<input\b[^>]*>/i.exec(html);
  assert.ok(feld, 'ein Eingabefeld');
  assert.match(feld[0], /inputmode="numeric"/);
  assert.match(feld[0], /autocomplete="off"/);
  for (const satz of ['PIN', 'Öffnen', 'Falsche PIN.', 'Zu oft falsch. Kurz warten.']) {
    assert.ok(html.includes(satz), satz);
  }
  // Route, Feldname und Pflichtkopf wie im PIN-Ablauf (src/http/api/vault.js).
  assert.ok(html.includes('/api/vault/unlock'));
  assert.ok(html.includes('passphrase'));
  assert.ok(/X-Neural-OS/i.test(html));
  // Schwarz und genau ein Blau, das aus web/app.css.
  const farben = new Set((html.match(/#[0-9a-f]{6}\b/gi) || []).map((f) => f.toLowerCase()));
  const blau = [...farben].filter((f) => {
    const r = parseInt(f.slice(1, 3), 16); const g = parseInt(f.slice(3, 5), 16); const b = parseInt(f.slice(5, 7), 16);
    return b > r + 60 && b > g + 30;
  });
  assert.deepEqual(blau, ['#2f7cf6'], `genau ein Blau, gefunden: ${blau.join(', ')}`);
});

test('Vorraum: CSP ohne unsafe-inline für Skripte, das Skript der Seite per Hash erlaubt', async () => {
  const heim = tempHome('vorraum-csp');
  let v = null;
  try {
    await mitProfil(async () => {
      const { paths, config } = await nurSchluessel(heim.home, '8642');
      v = await vorraum.oeffnen({ paths, config, port: 0, ki: { id: KI, name: 'Max' }, instanz: 'i', heim: 'h' });
      const r = await rufe({ port: v.port, pfad: '/api/entsperren' });
      const csp = r.headers['content-security-policy'];
      assert.ok(csp, 'CSP gesetzt');
      const skript = /script-src ([^;]+)/.exec(csp)[1];
      assert.equal(skript.includes('unsafe-inline'), false);
      const crypto = require('node:crypto');
      const inhalt = /<script>([\s\S]*?)<\/script>/.exec(r.text)[1];
      const hash = crypto.createHash('sha256').update(inhalt, 'utf8').digest('base64');
      assert.ok(skript.includes(`'sha256-${hash}'`), 'der Hash des Skripts steht in der CSP');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    });
  } finally {
    if (v) await v.schliessen().catch(() => {});
    heim.cleanup();
  }
});
