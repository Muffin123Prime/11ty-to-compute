'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const vaultcrypto = require('../store/vaultcrypto');
const authMod = require('../http/auth');
const { NeuralError, ValidationError } = require('./errors');
const { portableInfo } = require('./paths');
const { logger } = require('./log');

const log = logger('vorraum');

/**
 * Vorraum: ein Stick mit PIN startet gesperrt, die PIN kommt im Browser
 * (Stick-Bauplan 2.5, Paket V).
 *
 * Ohne Passphrase lässt sich der Tresor nicht öffnen, also auch keine
 * Anwendung bauen (belegt, p1a). Bis die PIN da ist, lauscht deshalb nur
 * dieser kleine Server auf dem Port der KI. Er kennt genau die Formen des
 * PIN-Ablaufs (src/http/api/vault.js, src/http/auth.js):
 *  - `POST /api/vault/unlock {passphrase[, merken]}`, nur lokal, mit
 *    `X-Neural-OS`; falsch 401 „Falsche PIN.“, der fünfte Fehlversuch 429
 *    „Zu oft falsch. Kurz warten.“ und 30 s Pause;
 *  - richtig: das Sitzungs-Cookie `nos_s_<KI>` (pinSitzungCookie) für genau
 *    diesen Browser. Es ist ein HMAC aus dem Datenschlüssel, die Anwendung
 *    danach prüft es mit demselben Schlüssel -- die Schale läuft ohne zweite
 *    PIN weiter, sobald der Dienst `app.auth.bindungEinschalten()` ruft.
 *
 * Der Service Worker (web/sw.js) bedient jede Navigation außerhalb von /api/
 * aus seinem Zwischenspeicher. Ein Browser, der die KI schon einmal offen
 * hatte, bekäme unter `/` also die alte Schale statt dieser Seite. Deshalb:
 *  - Die Seite liegt unter `/api/entsperren` (PFAD). Dort reicht der Worker
 *    jede Anfrage ans Netz durch, und dorthin öffnet der Starter den Browser
 *    (`v.url`), solange gesperrt ist.
 *  - Jeder andere Pfad bekommt dieselbe Seite, aber mit 423 und `no-store`.
 *    Der Worker legt nur 2xx ohne `no-store` ab (isCacheable, navigation);
 *    so landet die Seite nie als `index.html` oder `app.js` im Zwischenspeicher.
 *  - Andere /api/-Anfragen (etwa von einer Schale aus dem Zwischenspeicher)
 *    bekommen 423 VAULT_LOCKED als JSON, nie Daten.
 */

/** Die Adresse der Seite, unter /api/ wegen des Service Workers (siehe oben). */
const PFAD = '/api/entsperren';
const SEITE_DATEI = path.join(__dirname, '..', '..', 'web', 'entsperren.html');

const FEHL_MAX = 5;
const PAUSE_MS = 30 * 1000;
const BODY_MAX = 4096;
const CSRF_HEADER = 'x-neural-os';

const SICHERHEIT = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};
const CSP_JSON = "default-src 'none'; frame-ancestors 'none'";

function istLoopbackName(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.startsWith('::ffff:')) return istLoopbackName(h.slice(7));
  return false;
}

/** `127.0.0.1:21064`, `[::1]:21064`, `localhost` -> Rechnername ohne Port. */
function hostnameAus(kopf) {
  const roh = String(kopf || '').trim().toLowerCase();
  if (roh.startsWith('[')) {
    const zu = roh.indexOf(']');
    return zu === -1 ? roh.slice(1) : roh.slice(1, zu);
  }
  const doppelpunkt = roh.indexOf(':');
  if (doppelpunkt === -1 || roh.indexOf(':', doppelpunkt + 1) !== -1) return roh;
  return roh.slice(0, doppelpunkt);
}

/**
 * Eine Kopie der Konfiguration mit der Kennung dieser KI. Eine Kopie, weil
 * vaultcrypto jede Instanz unter ihrem config-Objekt ablegt (für auth.js) --
 * die Anwendung danach soll dort ihre eigene finden, nicht die des Vorraums.
 */
function konfigMitKennung(config, kiId) {
  const basis = config && typeof config === 'object' ? config : {};
  const sync = basis.sync && typeof basis.sync === 'object' ? basis.sync : {};
  return { ...basis, sync: { ...sync, ...(kiId ? { deviceId: kiId } : {}) } };
}

function kennungAus(ki, config) {
  return vaultcrypto.kiIdAus({ sync: { deviceId: ki && ki.id } }) || vaultcrypto.kiIdAus(config);
}

/**
 * Braucht dieser Start den Vorraum? Ja, wenn der Tresor verschlüsselt ist und
 * dieser Rechner nicht gemerkt ist.
 * @param {{paths:object, config:object, ki?:{id?:string}, geraeteOrdner?:string}} opts
 * @returns {boolean}
 */
function noetig({ paths, config, ki, geraeteOrdner } = {}) {
  const vc = vaultcrypto.createVaultCrypto({ paths, config: konfigMitKennung(config, kennungAus(ki, config)), geraeteOrdner });
  try {
    return vc.enabled && vc.state === 'locked';
  } finally {
    vc.lock();
  }
}

/** Die Seite und ihre CSP: jedes Inline-Skript per Hash, nie 'unsafe-inline'. */
function seiteLaden(datei = SEITE_DATEI) {
  const html = fs.readFileSync(datei, 'utf8');
  const hashes = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  const csp = [
    "default-src 'none'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    `script-src ${hashes.length ? hashes.join(' ') : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html: Buffer.from(html, 'utf8'), csp };
}

function fehlerJson(code, message, details = null) {
  return { error: { code, message, details } };
}

function lauschenEinmal(server, host, port) {
  return new Promise((resolve, reject) => {
    const beiFehler = (err) => {
      server.off('listening', beiBereit);
      reject(err);
    };
    const beiBereit = () => {
      server.off('error', beiFehler);
      resolve(server.address().port);
    };
    server.once('error', beiFehler);
    server.once('listening', beiBereit);
    server.listen(port, host);
  });
}

/** Wie server.js: bei belegtem Port der nächste; bei mehreren Versuchen zählt EACCES mit (Paket S). */
async function lauschen(server, host, port, tryPorts) {
  const versuche = Math.max(1, Number(tryPorts) || 1);
  for (let i = 0; i < versuche; i++) {
    const kandidat = port === 0 ? 0 : port + i;
    try {
      return await lauschenEinmal(server, host, kandidat);
    } catch (err) {
      const weiter = err && (err.code === 'EADDRINUSE' || (err.code === 'EACCES' && versuche > 1));
      if (weiter && i < versuche - 1) {
        log.warn(`Port ${kandidat} ist belegt, versuche ${kandidat + 1}.`);
        continue;
      }
      if (err && err.code === 'EADDRINUSE') {
        throw new NeuralError('PORT_IN_USE', `Port ${kandidat} ist bereits belegt.`, { status: 500, details: { port: kandidat, host } });
      }
      if (err && err.code === 'EACCES') {
        throw new NeuralError('PORT_FORBIDDEN', `Port ${kandidat} darf nicht geöffnet werden.`, { status: 500, details: { port: kandidat, host } });
      }
      throw err;
    }
  }
  throw new NeuralError('PORT_IN_USE', 'Kein freier Port.', { status: 500 });
}

/**
 * Den Vorraum öffnen.
 *
 * @param {object} opts
 * @param {object} opts.paths      pathsMod.layout(...) -- gebraucht wird paths.secrets
 * @param {object} opts.config     die geladene Konfiguration (wird nicht verändert)
 * @param {string} [opts.host]     Vorgabe 127.0.0.1; ein nicht-lokaler Wert wird zu 127.0.0.1
 * @param {number} opts.port       0 = irgendein freier (Tests)
 * @param {number} [opts.tryPorts] wie listen() in server.js
 * @param {{id?:string, name?:string}} [opts.ki]
 * @param {string} [opts.instanz]  für /api/health (Laufzettel, Paket S)
 * @param {string} [opts.heim]     für /api/health (Laufzettel, Paket S)
 * @param {string} [opts.geraeteOrdner] Ort gemerkter Geräte (Tests)
 * @returns {Promise<{url:string, port:number, host:string,
 *   entsperrt:Promise<{passphrase:string|null, port:number, sitzung:boolean, gemerkt:boolean}>,
 *   schliessen:()=>Promise<void>}>}
 */
async function oeffnen({
  paths, config, host = '127.0.0.1', port, tryPorts = 1, ki = {}, instanz = null, heim = null, geraeteOrdner,
} = {}) {
  if (!paths || typeof paths.secrets !== 'string') throw new ValidationError('Der Vorraum braucht paths.secrets.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ValidationError('Der Vorraum braucht einen Port.');

  const kiId = kennungAus(ki, config);
  const vc = vaultcrypto.createVaultCrypto({ paths, config: konfigMitKennung(config, kiId), geraeteOrdner });
  const seite = seiteLaden();
  const kiAnzeige = {
    id: kiId || null,
    name: (ki && typeof ki.name === 'string' && ki.name) || (config && config.sync && config.sync.deviceName) || null,
  };
  let portabel = false;
  try { portabel = !!portableInfo(paths.home || path.dirname(paths.secrets)); } catch { /* bleibt false */ }

  const bindHost = istLoopbackName(host) ? host : '127.0.0.1';
  const urlHost = String(bindHost).includes(':') ? `[${bindHost}]` : bindHost;

  const sperre = { fehl: 0, bis: 0 };
  let belegterPort = null;
  let geschlossen = false;
  let aufgeloest = false;
  let aufloesen;
  let ablehnen;
  const entsperrt = new Promise((res, rej) => { aufloesen = res; ablehnen = rej; });
  // Wer `entsperrt` nicht abwartet (Abbruch vor der PIN), darf keinen
  // unbehandelten Fehler erben.
  entsperrt.catch(() => {});

  function fertig(wert) {
    if (aufgeloest) return;
    aufgeloest = true;
    aufloesen(wert);
  }

  function art() {
    return typeof vc.art === 'function' && vc.art() === 'passphrase' ? 'passphrase' : 'pin';
  }

  function pauseS() {
    return Math.max(0, Math.ceil((sperre.bis - Date.now()) / 1000));
  }

  /* ------------------------------------------------------------ Antworten */

  function kopf(res, csp) {
    for (const [k, v] of Object.entries(SICHERHEIT)) res.setHeader(k, v);
    res.setHeader('Content-Security-Policy', csp);
  }

  function json(req, res, status, daten) {
    const body = Buffer.from(JSON.stringify(daten), 'utf8');
    kopf(res, CSP_JSON);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function seiteSenden(req, res, status) {
    kopf(res, seite.csp);
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': seite.html.length });
    res.end(req.method === 'HEAD' ? undefined : seite.html);
  }

  function gesperrtJson(req, res) {
    json(req, res, 423, fehlerJson('VAULT_LOCKED', 'Der Tresor ist gesperrt. Bitte die PIN eingeben.', { gesperrt: true, ziel: PFAD }));
  }

  /** Eine Navigation des Browsers (und kein fetch einer Schale)? */
  function istNavigation(req) {
    const modus = String(req.headers['sec-fetch-mode'] || '');
    if (modus) return modus === 'navigate';
    return String(req.headers.accept || '').includes('text/html');
  }

  function koerperLesen(req) {
    return new Promise((resolve, reject) => {
      const teile = [];
      let groesse = 0;
      req.on('data', (stueck) => {
        groesse += stueck.length;
        if (groesse > BODY_MAX) {
          reject(new NeuralError('PAYLOAD_TOO_LARGE', 'Die Anfrage ist zu groß.', { status: 413 }));
          req.destroy();
          return;
        }
        teile.push(stueck);
      });
      req.on('end', () => resolve(Buffer.concat(teile).toString('utf8')));
      req.on('error', reject);
    });
  }

  /* -------------------------------------------------------------- Routen */

  function status() {
    return {
      gesperrt: true,
      ki: kiAnzeige,
      portable: portabel,
      art: art(),
      pauseS: pauseS(),
      // Für eine Schale aus dem Zwischenspeicher: sie zeigt dann „Tresor gesperrt“.
      vault: { state: 'locked', encrypted: true },
    };
  }

  /** Dieselbe Form wie GET /api/vault im Server, gesperrt. */
  function tresor() {
    return {
      state: 'locked',
      enabled: true,
      hasSecrets: true,
      art: art(),
      schutz: {
        verfuegbar: true,
        eingerichtet: true,
        art: art(),
        zustand: 'locked',
        entsperrtDurch: null,
        diesesGeraetGemerkt: false,
        geraete: [],
        geraeteOrdner: null,
        sitzung: { noetig: false, vorhanden: false },
        pauseS: pauseS(),
      },
    };
  }

  async function entsperren(req, res) {
    const token = req.headers[CSRF_HEADER];
    if (!token || String(token).trim() === '') {
      json(req, res, 403, fehlerJson('PERMISSION_DENIED', `Ändernde Anfragen brauchen den Kopf ${CSRF_HEADER}: 1.`, { header: CSRF_HEADER }));
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let originHost = null;
      try { originHost = new URL(origin).host.toLowerCase(); } catch { /* unlesbar */ }
      if (originHost !== String(req.headers.host || '').toLowerCase()) {
        json(req, res, 403, fehlerJson('PERMISSION_DENIED', `Fremder Origin "${origin}" wurde abgelehnt.`, { origin }));
        return;
      }
    }
    let body;
    try {
      const roh = await koerperLesen(req);
      body = roh ? JSON.parse(roh) : {};
    } catch (err) {
      if (err instanceof NeuralError) { json(req, res, err.status, err.toJSON()); return; }
      json(req, res, 400, fehlerJson('VALIDATION_FAILED', 'Der Inhalt ist kein gültiges JSON.'));
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    const passphrase = body.passphrase;
    if (typeof passphrase !== 'string' || passphrase.length < 1 || passphrase.length > 1024) {
      json(req, res, 400, fehlerJson('VALIDATION_FAILED', '"passphrase" fehlt.'));
      return;
    }
    if (!vc.enabled) {
      json(req, res, 400, fehlerJson('VALIDATION_FAILED', 'Es ist keine PIN eingerichtet; es gibt nichts zu entsperren.'));
      return;
    }
    const rest = pauseS();
    if (rest > 0) {
      json(req, res, 429, fehlerJson('ZU_OFT_FALSCH', 'Zu oft falsch. Kurz warten.', { wartenS: rest }));
      return;
    }
    try {
      // Schon offen (ein anderer Browser war schneller): "ist doch offen" ist
      // kein Beweis -- unlock() nähme dann jede Eingabe an.
      if (vc.state === 'unlocked') await vc.pruefen(passphrase);
      else await vc.unlock(passphrase);
      sperre.fehl = 0;
    } catch (err) {
      if (err && err.code === 'VAULT_LOCKED') {
        sperre.fehl += 1;
        if (sperre.fehl >= FEHL_MAX) {
          sperre.fehl = 0;
          sperre.bis = Date.now() + PAUSE_MS;
          json(req, res, 429, fehlerJson('ZU_OFT_FALSCH', 'Zu oft falsch. Kurz warten.', { wartenS: Math.ceil(PAUSE_MS / 1000) }));
          return;
        }
        json(req, res, 401, fehlerJson('FALSCHE_PIN', art() === 'passphrase' ? 'Falsche Passphrase.' : 'Falsche PIN.', { uebrig: FEHL_MAX - sperre.fehl }));
        return;
      }
      const status = err instanceof NeuralError && Number.isInteger(err.status) ? err.status : 500;
      if (status >= 500) log.error(`Entsperren gescheitert: ${err && err.message}`);
      json(req, res, status, fehlerJson((err && err.code) || 'INTERNAL_ERROR', String((err && err.message) || 'Entsperren gescheitert.')));
      return;
    }

    let gemerkt = false;
    if (body.merken === true && kiId) {
      try {
        let name = 'Dieser Rechner';
        try { name = os.hostname() || name; } catch { /* bleibt */ }
        vc.merken({ kiId, name });
        gemerkt = true;
      } catch (err) {
        log.warn(`Dieser Rechner ließ sich nicht merken: ${err && err.message}`);
      }
    }
    // Dieselbe Sitzung, die auth.js nach einer PIN im Server ausstellt: ihr
    // Name hängt an der KI-Kennung, ihr Siegel am Datenschlüssel.
    const cookieConfig = { sync: { deviceId: kiId || undefined }, server: { port: belegterPort } };
    res.setHeader('Set-Cookie', authMod.pinSitzungCookie({ config: cookieConfig, vaultCrypto: vc }));
    res.once('close', () => fertig({ passphrase, port: belegterPort, sitzung: res.writableFinished, gemerkt }));
    json(req, res, 200, { state: 'unlocked', enabled: true, reloaded: false, sitzung: true, gemerkt });
  }

  async function bearbeiten(req, res) {
    if (geschlossen) {
      json(req, res, 503, fehlerJson('SERVER_CLOSING', 'Der Server wird gerade beendet.'));
      return;
    }
    // Nur dieser Rechner, und nur unter seinem eigenen Namen (DNS-Rebinding).
    if (!istLoopbackName(req.socket && req.socket.remoteAddress)) {
      json(req, res, 403, fehlerJson('PERMISSION_DENIED', 'Entsperren geht nur an diesem Rechner.'));
      return;
    }
    if (req.headers.host !== undefined && !istLoopbackName(hostnameAus(req.headers.host))) {
      json(req, res, 403, fehlerJson('PERMISSION_DENIED', 'Rufe die Seite über 127.0.0.1 auf.'));
      return;
    }
    let pfad;
    try {
      pfad = new URL(req.url, 'http://vorraum.invalid').pathname;
    } catch {
      json(req, res, 400, fehlerJson('VALIDATION_FAILED', 'Die angefragte Adresse ist ungültig.'));
      return;
    }
    const methode = String(req.method || 'GET').toUpperCase();
    const lesen = methode === 'GET' || methode === 'HEAD';

    if (methode === 'OPTIONS') {
      kopf(res, CSP_JSON);
      res.writeHead(204, { Allow: 'GET, HEAD, POST, OPTIONS', 'Content-Length': 0 });
      res.end();
      return;
    }
    if (pfad === '/api/health' && lesen) {
      json(req, res, 200, { ok: true, at: new Date().toISOString(), instanz, heim, gesperrt: true });
      return;
    }
    // Ein alter Tab einer anderen KI (Paket I): dieselbe Regel wie im Server.
    if (kiId && typeof authMod.guardKi === 'function') {
      try {
        authMod.guardKi(req, kiId);
      } catch (err) {
        json(req, res, err.status || 409, fehlerJson(err.code || 'KI_GEWECHSELT', err.message));
        return;
      }
    }
    if (pfad === '/api/status' && lesen) { json(req, res, 200, status()); return; }
    if (pfad === '/api/vault' && lesen) { json(req, res, 200, tresor()); return; }
    if (pfad === '/api/vault/unlock' && methode === 'POST') { await entsperren(req, res); return; }
    if (pfad === PFAD && lesen) { seiteSenden(req, res, 200); return; }
    const api = pfad === '/api' || pfad.startsWith('/api/');
    if (lesen && (!api || istNavigation(req))) { seiteSenden(req, res, 423); return; }
    gesperrtJson(req, res);
  }

  const server = http.createServer((req, res) => {
    bearbeiten(req, res).catch((err) => {
      log.error(`Vorraum: ${err && err.message}`);
      if (!res.headersSent) {
        try { json(req, res, 500, fehlerJson('INTERNAL_ERROR', 'Interner Fehler im Vorraum.')); } catch { res.destroy(); }
      } else {
        res.destroy();
      }
    });
  });

  try {
    belegterPort = await lauschen(server, bindHost, port, tryPorts);
  } catch (err) {
    vc.lock();
    throw err;
  }
  const url = `http://${urlHost}:${belegterPort}${PFAD}`;

  if (vc.state !== 'locked') {
    // Nichts zu tun: ohne PIN, oder dieser Rechner ist gemerkt. Nie abbrechen.
    fertig({ passphrase: null, port: belegterPort, sitzung: false, gemerkt: vc.entsperrtDurch === 'geraet' });
  } else {
    log.info(`Gesperrt; die PIN wird im Browser eingegeben: ${url}`);
  }

  return {
    url,
    port: belegterPort,
    host: bindHost,
    entsperrt,
    /** Den Port freigeben -- sofort, auch mit offenen Keep-alive-Verbindungen. */
    async schliessen() {
      if (geschlossen) return;
      geschlossen = true;
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      vc.lock();
      if (!aufgeloest) {
        aufgeloest = true;
        ablehnen(new NeuralError('VORRAUM_GESCHLOSSEN', 'Der Vorraum wurde geschlossen, bevor die PIN kam.', { status: 503 }));
      }
    },
  };
}

module.exports = { oeffnen, noetig, PFAD, SEITE_DATEI, __internals: { seiteLaden, istLoopbackName, hostnameAus } };
