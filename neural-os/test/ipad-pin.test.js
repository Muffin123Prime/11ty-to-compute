'use strict';

/**
 * PIN und iPad über die ECHTE Anwendung (createApp + listen), mit echten
 * Sockets. Geprüft wird, was der Nutzer erlebt, nicht was ein Modul von sich
 * behauptet:
 *  - PIN einrichten verschlüsselt, was schon da ist (auch den Claude-Schlüssel);
 *  - ein zweiter Browser ohne PIN-Sitzung bekommt keine Daten;
 *  - 5 falsche PINs -> 30 s Pause (429 "Zu oft falsch. Kurz warten.");
 *  - "Dieses Gerät merken": der nächste Start braucht keine PIN;
 *  - iPad verbinden: ein zweiter Listener auf der LAN-Adresse OHNE Neustart,
 *    ein Einmal-Link, der gegen ein Cookie getauscht wird und danach nichts
 *    mehr taugt.
 *
 * Der Ordner für gemerkte Geräte zeigt über NEURAL_OS_GERAETE in ein
 * Temp-Verzeichnis; das echte Benutzerprofil wird nie berührt.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, tempHome } = require('./harness');

const { createApp } = require('../src/app');

const KI = 'dev_a1b2c3d4e5f6a7b8c9d0e1f2';

/**
 * Das "iPad" ist hier ein Aufruf aus demselben Prozess. Die Härtung
 * (src/net/harden.js) gilt prozessweit und würde ihn als Verbindung ins
 * lokale Netz abweisen -- ein echtes iPad ist aber ein anderes Gerät, für das
 * sie nicht gilt. Deshalb läuft der Prüf-Client im internen Kontext der Schleuse.
 */
const { runInternal } = require('../src/net/gate');

function anfrage(opts) {
  return runInternal(() => anfrageRoh(opts));
}

function anfrageRoh({ host = '127.0.0.1', port, method = 'GET', pfad, headers = {}, body, hostKopf }) {
  return new Promise((resolve, reject) => {
    const daten = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host,
      port,
      method,
      path: pfad,
      agent: false,
      headers: {
        host: hostKopf || `${host}:${port}`,
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
    req.setTimeout(10000, () => req.destroy(new Error('Zeitüberschreitung')));
    if (daten) req.write(daten);
    req.end();
  });
}

/** Das Cookie "name=wert" aus einer Set-Cookie-Antwort. */
function cookieAus(res, prefix) {
  const liste = [].concat(res.headers['set-cookie'] || []);
  const treffer = liste.find((c) => c.startsWith(prefix));
  return treffer ? treffer.split(';')[0] : null;
}

/** Eine nicht-lokale IPv4 dieses Rechners, über die sich ein "iPad" spielen lässt. */
function fremdeAdresse() {
  for (const liste of Object.values(os.networkInterfaces())) {
    for (const a of liste || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return null;
}

async function mitApp(heim, fn, opts = {}) {
  const vorher = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = opts.profil;
  let app = null;
  try {
    // Eine feste KI-Kennung vorab, so wie sie identitaet.js/der Abgleich anlegt.
    const configPfad = path.join(heim, 'config.json');
    if (!fs.existsSync(configPfad)) {
      fs.mkdirSync(heim, { recursive: true });
      fs.writeFileSync(configPfad, JSON.stringify({ version: 1, sync: { deviceId: KI } }));
    }
    app = await createApp({ home: heim, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, ...(opts.app || {}) });
    await app.listen({ port: 0 });
    const port = app.server.server.address().port;
    return await fn({ app, port, rufe: (o) => anfrage({ port, ...o }) });
  } finally {
    if (app) await app.close().catch(() => {});
    if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorher;
  }
}

test('PIN einrichten: alles Vorhandene wird verschlüsselt, ein zweiter Browser braucht die PIN', async () => {
  const heim = tempHome('ipadpin-pin');
  const profil = tempHome('ipadpin-profil');
  let sitzungMerken = null;
  let anhangHash = null;
  try {
    await mitApp(heim.home, async ({ app, rufe }) => {
      const notiz = app.store.create('note', { title: 'Kanarienvogel-Notiz', body: 'Geheimer Inhalt 7f3a' });
      app.store.update(notiz.id, { body: 'Geheimer Inhalt 7f3a, geändert' });
      const anhang = app.store.files.put(Buffer.from('Anhang mit Kanarienvogel darin'), { name: 'a.txt' });
      anhangHash = anhang.hash;
      await app.store.flush();
      // Ein Claude-Schlüssel im bisherigen Klartext-Format von src/models/claude.js.
      const schluesselDatei = path.join(app.paths.vault, 'claude-schluessel.json');
      const klar = Buffer.from(JSON.stringify({ schluessel: 'sk-ant-KANARIE-0000', geprueftAm: new Date().toISOString() }));
      fs.writeFileSync(schluesselDatei, JSON.stringify({ v: 1, versiegelt: false, inhalt: klar.toString('base64') }));

      const zuKurz = await rufe({ method: 'POST', pfad: '/api/vault/pin', body: { pin: '123' } });
      assert.equal(zuKurz.status, 400, zuKurz.text);
      assert.match(zuKurz.json.error.message, /4 bis 6 Ziffern/);

      const gesetzt = await rufe({ method: 'POST', pfad: '/api/vault/pin', body: { pin: '4711' } });
      assert.equal(gesetzt.status, 200, gesetzt.text);
      assert.equal(gesetzt.json.state, 'unlocked');
      assert.equal(gesetzt.json.schutz.eingerichtet, true);
      assert.equal(gesetzt.json.schutz.art, 'pin');
      assert.equal(gesetzt.json.claudeVersiegelt, true);
      const sitzung = cookieAus(gesetzt, 'nos_s_a1b2c3d4=');
      assert.ok(sitzung, `der Browser, der die PIN setzt, bekommt seine Sitzung: ${gesetzt.headers['set-cookie']}`);

      // Auf der Platte: kein Klartext mehr, weder Notiz noch Claude-Schlüssel.
      const funde = [];
      const durchsuche = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) durchsuche(p);
          else {
            const inhalt = fs.readFileSync(p);
            for (const k of ['Kanarienvogel', 'Geheimer Inhalt 7f3a', 'sk-ant-KANARIE']) {
              if (inhalt.includes(k)) funde.push(`${path.relative(heim.home, p)}: ${k}`);
            }
          }
        }
      };
      durchsuche(heim.home);
      assert.deepEqual(funde, [], `Klartext liegt noch auf der Platte: ${funde.join(', ')}`);
      assert.ok(gesetzt.json.verlaufVersiegelt >= 1, 'der Verlauf hatte Klartext-Zeilen');
      assert.equal(gesetzt.json.dateienVersiegelt, 1);
      // Und alles ist weiter lesbar: der Anhang, der Verlauf.
      assert.equal(app.store.files.read(anhang.hash).toString('utf8'), 'Anhang mit Kanarienvogel darin');
      const verlauf = await rufe({ pfad: '/api/history', headers: { cookie: sitzung } });
      assert.equal(verlauf.status, 200, verlauf.text);

      // Ein anderer Browser (ohne Cookie): Status ja, Daten nein.
      const status = await rufe({ pfad: '/api/status' });
      assert.equal(status.status, 200);
      const daten = await rufe({ pfad: '/api/records?type=note' });
      assert.equal(daten.status, 401);
      assert.equal(daten.json.error.code, 'PIN_NOETIG');
      const tresor = await rufe({ pfad: '/api/vault' });
      assert.equal(tresor.status, 200);
      assert.deepEqual(tresor.json.schutz.sitzung, { noetig: true, vorhanden: false });
      const seite = await rufe({ pfad: '/' });
      assert.equal(seite.status, 200, 'die Oberfläche selbst muss laden, sonst gibt es keinen Ort für die PIN');

      // Mit der Sitzung: Daten.
      const mit = await rufe({ pfad: '/api/records?type=note', headers: { cookie: sitzung } });
      assert.equal(mit.status, 200, mit.text);
      assert.ok(mit.json.items.some((r) => r.data.title === 'Kanarienvogel-Notiz'));
      const mitTresor = await rufe({ pfad: '/api/vault', headers: { cookie: sitzung } });
      assert.deepEqual(mitTresor.json.schutz.sitzung, { noetig: true, vorhanden: true });

      // Ein gefälschtes Cookie gilt nicht.
      const falsch = await rufe({ pfad: '/api/records', headers: { cookie: 'nos_s_a1b2c3d4=v1.abc.def.ghi' } });
      assert.equal(falsch.status, 401);

      // Der zweite Browser gibt die PIN ein und ist dann drin.
      const falschePin = await rufe({ method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '0000' } });
      assert.equal(falschePin.status, 401);
      assert.equal(falschePin.json.error.message, 'Falsche PIN.');
      const richtig = await rufe({ method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '4711' } });
      assert.equal(richtig.status, 200, richtig.text);
      const zweite = cookieAus(richtig, 'nos_s_a1b2c3d4=');
      assert.ok(zweite);
      assert.equal((await rufe({ pfad: '/api/records', headers: { cookie: zweite } })).status, 200);
      assert.equal(richtig.json.gemerkt, false);
      assert.equal(fs.readdirSync(profil.home).length, 0, 'ohne "merken" liegt nichts im Profil');
      sitzungMerken = sitzung;
    }, { profil: profil.home });

    // Neustart mit der PIN aus der Umgebung: kein Browser hat sie eingegeben,
    // also bindet dieser Prozess noch niemanden (sonst sperrte er alle aus).
    // Der Vorraum übergibt mit bindungEinschalten(); dann gilt die Sitzung
    // des Browsers weiter, und der versiegelte Verlauf ist lesbar.
    await mitApp(heim.home, async ({ app, rufe }) => {
      assert.equal(app.vaultCrypto.entsperrtDurch, 'pin');
      assert.equal((await rufe({ pfad: '/api/records' })).status, 200, 'ohne Browser, der die PIN kennt, bindet niemand');
      app.auth.bindungEinschalten();
      assert.equal((await rufe({ pfad: '/api/records' })).status, 401);
      const verlauf = await rufe({ pfad: '/api/history', headers: { cookie: sitzungMerken } });
      assert.equal(verlauf.status, 200, verlauf.text);
      assert.ok(JSON.stringify(verlauf.json).includes('Kanarienvogel'), 'der Verlauf von vor der PIN muss nach dem Neustart lesbar sein');
      assert.equal(app.store.files.read(anhangHash).toString('utf8'), 'Anhang mit Kanarienvogel darin');
    }, { profil: profil.home, app: { passphrase: '4711' } });
  } finally {
    heim.cleanup();
    profil.cleanup();
  }
});

test('5 falsche PINs -> 30 s Pause, auch die richtige PIN wartet', async () => {
  const heim = tempHome('ipadpin-sperre');
  const profil = tempHome('ipadpin-sperre-profil');
  try {
    await mitApp(heim.home, async ({ rufe }) => {
      const gesetzt = await rufe({ method: 'POST', pfad: '/api/vault/pin', body: { pin: '246810' } });
      assert.equal(gesetzt.status, 200, gesetzt.text);
      const antworten = [];
      for (let i = 0; i < 5; i++) {
        antworten.push(await rufe({ method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: `00000${i}` } }));
      }
      assert.deepEqual(antworten.map((a) => a.status), [401, 401, 401, 401, 429]);
      assert.equal(antworten[4].json.error.message, 'Zu oft falsch. Kurz warten.');
      assert.equal(antworten[4].json.error.details.wartenS, 30);
      const trotzdem = await rufe({ method: 'POST', pfad: '/api/vault/unlock', body: { passphrase: '246810' } });
      assert.equal(trotzdem.status, 429, 'während der Pause wird gar nicht erst gerechnet');
      const tresor = await rufe({ pfad: '/api/vault' });
      assert.ok(tresor.json.schutz.pauseS > 0 && tresor.json.schutz.pauseS <= 30);
    }, { profil: profil.home });
  } finally {
    heim.cleanup();
    profil.cleanup();
  }
});

test('Dieses Gerät merken: der nächste Start öffnet ohne PIN und ohne Sitzung; vergessen macht es rückgängig', async () => {
  const heim = tempHome('ipadpin-merken');
  const profil = tempHome('ipadpin-merken-profil');
  try {
    await mitApp(heim.home, async ({ app, rufe }) => {
      app.store.create('note', { title: 'Bleibt da' });
      const gesetzt = await rufe({ method: 'POST', pfad: '/api/vault/pin', body: { pin: '1357', merken: true } });
      assert.equal(gesetzt.status, 200, gesetzt.text);
      assert.equal(gesetzt.json.gemerkt, true);
      assert.equal(gesetzt.json.schutz.diesesGeraetGemerkt, true);
      assert.deepEqual(fs.readdirSync(profil.home), [`${KI}.json`], 'der Schlüssel liegt im Profil, je KI-Kennung');
    }, { profil: profil.home });

    // "Neustart": ohne Passphrase, der gemerkte Rechner öffnet selbst.
    await mitApp(heim.home, async ({ app, rufe }) => {
      assert.equal(app.vaultCrypto.state, 'unlocked');
      assert.equal(app.vaultCrypto.entsperrtDurch, 'geraet');
      const daten = await rufe({ pfad: '/api/records?type=note' });
      assert.equal(daten.status, 200, 'am eigenen Laptop fragt nichts');
      assert.ok(daten.json.items.some((r) => r.data.title === 'Bleibt da'));

      const vergessen = await rufe({ method: 'DELETE', pfad: '/api/vault/geraet' });
      assert.equal(vergessen.status, 200, vergessen.text);
      assert.equal(vergessen.json.entfernt, true);
      assert.equal(fs.readdirSync(profil.home).length, 0);
      // Ab jetzt ist dieser Rechner "fremd": wer keine Sitzung hat, braucht die PIN.
      assert.equal((await rufe({ pfad: '/api/records' })).status, 401);
    }, { profil: profil.home });

    // Und ohne gemerktes Gerät startet der Tresor heute gar nicht (Vorraum: Paket V).
    await assert.rejects(() => mitApp(heim.home, async () => {}, { profil: profil.home }), /gesperrt|locked/i);
    await mitApp(heim.home, async ({ app }) => {
      assert.equal(app.vaultCrypto.entsperrtDurch, 'pin');
    }, { profil: profil.home, app: { passphrase: '1357' } });
  } finally {
    heim.cleanup();
    profil.cleanup();
  }
});

test('iPad verbinden: zweiter Listener ohne Neustart, Einmal-Link gegen Cookie, Trennen und Ausschalten', async () => {
  const lan = fremdeAdresse();
  const heim = tempHome('ipadpin-ipad');
  const profil = tempHome('ipadpin-ipad-profil');
  try {
    await mitApp(heim.home, async ({ app, port, rufe }) => {
      // Die Erkennung nimmt nur private Adressen; hier gibt es vielleicht keine.
      app.lanAdressen = () => (lan ? [{ adresse: lan, schnittstelle: 'test' }] : []);
      const vorher = await rufe({ pfad: '/api/ipad' });
      assert.equal(vorher.status, 200);
      assert.equal(vorher.json.an, false);

      if (!lan) {
        const ohne = await rufe({ method: 'POST', pfad: '/api/ipad' });
        assert.equal(ohne.status, 409);
        assert.match(ohne.json.error.message, /WLAN/);
        return;
      }

      const verbundenEvents = [];
      app.bus.on('ipad.verbunden', (e) => verbundenEvents.push(e));

      const an = await rufe({ method: 'POST', pfad: '/api/ipad' });
      assert.equal(an.status, 200, an.text);
      assert.equal(an.json.an, true);
      const link = new URL(an.json.link);
      assert.equal(link.hostname, lan);
      assert.equal(link.pathname, '/api/verbinden');
      assert.ok(link.searchParams.get('c').length >= 43, 'der Code trägt 256 Bit');
      assert.equal(app.config.security.sharing.enabled, true);
      const lanPort = Number(link.port);
      const vomIpad = (o) => anfrage({ host: lan, port: lanPort, ...o });

      // Ohne Anmeldung kommt das "iPad" nicht an die Daten.
      assert.equal((await vomIpad({ pfad: '/api/records' })).status, 401);
      // Der Laptop bleibt Besitzer, obwohl die Freigabe an ist.
      assert.equal((await rufe({ pfad: '/api/tokens' })).status, 200);

      const ein = await vomIpad({ pfad: `${link.pathname}${link.search}`, headers: { 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' } });
      assert.equal(ein.status, 303, ein.text);
      assert.equal(ein.headers.location, '/', 'der Code verschwindet aus der Adresszeile');
      assert.match(ein.headers['cache-control'], /no-store/);
      const cookie = cookieAus(ein, 'nos_t_a1b2c3d4=');
      assert.ok(cookie, `Token-Cookie mit KI-Kennung im Namen: ${ein.headers['set-cookie']}`);
      assert.match([].concat(ein.headers['set-cookie']).join(), /HttpOnly/);
      assert.equal(verbundenEvents.length, 1, 'erst das Einlösen meldet "verbunden"');
      assert.equal(verbundenEvents[0].payload.geraet, 'iPad');

      const nochmal = await vomIpad({ pfad: `${link.pathname}${link.search}` });
      assert.equal(nochmal.status, 410, 'ein Einmal-Code gilt genau einmal');
      assert.match(nochmal.text, /gilt nicht mehr/);

      // Eine Anfrage vom iPad läuft NICHT im internen Kontext der Schleuse --
      // sonst käme alles, was sie auslöst, an der Härtung vorbei.
      const { isInternalContext } = require('../src/net/gate');
      const kontexte = [];
      const horcher = (req) => { if (req.socket.remoteAddress !== '127.0.0.1') kontexte.push(isInternalContext()); };
      app.server.server.prependListener('request', horcher);
      // Mit dem Cookie: lesen, schreiben, chatten -- aber keine Einstellungen.
      assert.equal((await vomIpad({ pfad: '/', headers: { cookie } })).status, 200);
      const lesen = await vomIpad({ pfad: '/api/records?type=note', headers: { cookie } });
      assert.equal(lesen.status, 200, lesen.text);
      const schreiben = await vomIpad({ method: 'POST', pfad: '/api/records', headers: { cookie }, body: { type: 'note', data: { title: 'Vom iPad' } } });
      assert.equal(schreiben.status, 200, schreiben.text);
      const einstellen = await vomIpad({ method: 'PATCH', pfad: '/api/config', headers: { cookie }, body: { ui: { theme: 'light' } } });
      assert.equal(einstellen.status, 403);
      const pinSetzen = await vomIpad({ method: 'POST', pfad: '/api/vault/pin', headers: { cookie }, body: { pin: '1234' } });
      assert.equal(pinSetzen.status, 403, 'die PIN setzt nur, wer am Laptop sitzt');
      app.server.server.off('request', horcher);
      assert.ok(kontexte.length >= 4, `es kamen nur ${kontexte.length} Anfragen über das WLAN an`);
      assert.deepEqual([...new Set(kontexte)], [false], 'eine iPad-Anfrage lief im internen Kontext der Schleuse');

      const zustand = await rufe({ pfad: '/api/ipad' });
      assert.equal(zustand.json.geraete.length, 1);
      assert.match(zustand.json.geraete[0].name, /^iPad · verbunden am/);

      // Trennen: das Cookie taugt sofort nichts mehr.
      const getrennt = await rufe({ method: 'DELETE', pfad: `/api/ipad/geraete/${zustand.json.geraete[0].id}` });
      assert.equal(getrennt.status, 200, getrennt.text);
      assert.equal((await vomIpad({ pfad: '/api/records', headers: { cookie } })).status, 401);

      // Ausschalten: der Port im WLAN ist zu, der Laptop läuft weiter.
      const aus = await rufe({ method: 'DELETE', pfad: '/api/ipad' });
      assert.equal(aus.json.an, false);
      assert.equal(app.config.security.sharing.enabled, false);
      await assert.rejects(() => vomIpad({ pfad: '/api/status' }), /ECONNREFUSED|ECONNRESET|socket hang up/);
      assert.equal((await rufe({ pfad: '/api/status' })).status, 200);
      assert.equal(port > 0, true);

      // Die Freigabe wird nicht gespeichert: config.json nennt sie nicht.
      const gespeichert = JSON.parse(fs.readFileSync(path.join(heim.home, 'config.json'), 'utf8'));
      assert.notEqual(gespeichert.security && gespeichert.security.sharing && gespeichert.security.sharing.enabled, true);

      // Gehärtet und offline: gebunden wurde über eine sichtbare Einmal-Freigabe
      // der Schleuse für genau die eigene Adresse, die danach widerrufen ist.
      assert.equal(app.config.network.mode, 'offline');
      assert.ok(app.hardening, 'dieser Test soll den gehärteten Alltag prüfen');
      const freigaben = app.gate.listGrants({ includeInactive: true }).filter((g) => (g.data || g).reason && /iPad verbinden/.test((g.data || g).reason));
      assert.ok(freigaben.length >= 1, 'die Freigabe zum Lauschen fehlt im Protokoll');
      assert.ok(freigaben.every((g) => (g.data || g).revoked === true), 'die Freigabe zum Lauschen muss danach widerrufen sein');
      assert.deepEqual([...new Set(freigaben.flatMap((g) => (g.data || g).hosts))], [lan], 'nur die eigene Adresse');

      // Wieder an und die App beenden: der LAN-Listener geht mit (sonst hinge dieser Test).
      await rufe({ method: 'POST', pfad: '/api/ipad' });
    }, { profil: profil.home, app: { harden: true } });
  } finally {
    heim.cleanup();
    profil.cleanup();
  }
});
