'use strict';

/**
 * iPad verbinden -- ein Knopf.
 *
 *   GET    /api/ipad               -> Zustand: an/aus, Adressen, verbundene Geräte
 *   POST   /api/ipad               -> einschalten (falls aus) + neuer Einmal-Link für den QR-Code
 *   DELETE /api/ipad               -> ausschalten: das lokale Netz kommt nicht mehr herein
 *   DELETE /api/ipad/geraete/:id   -> ein verbundenes Gerät trennen (Token widerrufen)
 *
 * Warum ein zweiter Listener statt `host: 0.0.0.0`
 * ------------------------------------------------
 * Bisher hieß "Freigabe im Netz" ein Neustart mit `server.host = 0.0.0.0`.
 * Ein Knopf, nach dem man neu starten muss, ist kein Knopf. Stattdessen
 * lauscht ein zusätzlicher `net.Server` auf der LAN-Adresse (z. B.
 * 192.168.1.5) am selben Port und reicht jede Verbindung an den laufenden
 * HTTP-Server weiter (`emit('connection')`). Damit gelten für das iPad
 * dieselben Prüfungen, derselbe Router und dieselben Kopfzeilen wie für den
 * Laptop, ohne dass src/http/server.js davon wissen muss.
 *  - Gebunden wird an die konkrete Adresse, nicht an 0.0.0.0: 0.0.0.0 neben
 *    einem schon belegten 127.0.0.1:<port> scheitert unter Linux, und es
 *    würde jede Schnittstelle öffnen (auch VPN und öffentliche Adressen).
 *  - Nur private IPv4-Adressen (RFC 1918). Ein Laptop mit öffentlicher
 *    Adresse (manche Hochschulnetze) würde sonst dem Internet antworten.
 *  - Die Freigabe gilt, bis Neural OS beendet wird oder "Ausschalten"
 *    gedrückt wird. Sie wird NICHT gespeichert: auf einem Schullaptop soll
 *    sich beim nächsten Start kein Port öffnen, den niemand angefordert hat.
 *    Ein schon verbundenes iPad lädt nach erneutem Einschalten einfach neu;
 *    sein Cookie gilt weiter, solange die Adresse gleich bleibt.
 *
 * Was hier nicht zu lösen ist, und deshalb in der Oberfläche steht
 * ----------------------------------------------------------------
 *  - Windows fragt beim ersten Lauschen im Netz, ob Node.js das darf. Ohne
 *    Administratorrechte (Schullaptop) lässt sich das oft nicht erlauben;
 *    dann kommt das iPad nicht durch, und nichts in diesem Prozess merkt das.
 *  - Viele Schul- und Gast-WLANs trennen die Geräte voneinander.
 * Deshalb gilt "verbunden" erst, wenn das iPad den Link wirklich eingelöst
 * hat (Bus-Ereignis `ipad.verbunden`), nie schon beim Einschalten.
 */

const http = require('node:http');
const net = require('node:net');
const os = require('node:os');

const { NeuralError, NotFoundError } = require('../../kernel/errors');
const { needMethod } = require('./support');

/** Laufende LAN-Listener, je laufender KI (ctx). */
const LAN = new WeakMap();

function publish(rc, name, payload) {
  const bus = rc.ctx.bus;
  if (bus && typeof bus.publish === 'function') bus.publish(name, payload || {});
}

function audit(rc, kind, data) {
  const writer = rc.ctx.audit;
  if (writer && typeof writer.write === 'function') writer.write(kind, data);
}

/** RFC 1918. */
function privat(adresse) {
  const t = String(adresse).split('.').map(Number);
  if (t.length !== 4 || t.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return t[0] === 10 || (t[0] === 172 && t[1] >= 16 && t[1] <= 31) || (t[0] === 192 && t[1] === 168);
}

/** Virtuelle Adapter (VM, Container, VPN) sind selten das WLAN, in dem das iPad ist. */
const VIRTUELL = /vethernet|virtualbox|vmware|vmnet|docker|^br-|^veth|utun|hyper-v|wsl|tailscale|zerotier|^zt|vboxnet|loopback/i;
const WLAN = /wi-?fi|wlan|wlp|wireless|^en0$|drahtlos/i;

function rang(schnittstelle, adresse) {
  let r = 0;
  if (WLAN.test(schnittstelle)) r -= 20;
  if (VIRTUELL.test(schnittstelle)) r += 50;
  if (adresse.startsWith('192.168.')) r -= 5;
  else if (adresse.startsWith('10.')) r -= 2;
  return r;
}

/**
 * Die privaten IPv4-Adressen dieses Rechners, die beste zuerst.
 * `ctx.lanAdressen` ersetzt die Erkennung (Tests, Sonderfälle).
 * @returns {Array<{adresse:string, schnittstelle:string}>}
 */
function lanAdressen(ctx) {
  if (ctx && typeof ctx.lanAdressen === 'function') return ctx.lanAdressen();
  const out = [];
  let alle = {};
  try { alle = os.networkInterfaces() || {}; } catch { alle = {}; }
  for (const [schnittstelle, liste] of Object.entries(alle)) {
    for (const a of liste || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || !privat(a.address)) continue;
      out.push({ adresse: a.address, schnittstelle });
    }
  }
  return out
    .map((a) => ({ ...a, r: rang(a.schnittstelle, a.adresse) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 4)
    .map(({ adresse, schnittstelle }) => ({ adresse, schnittstelle }));
}

function httpServerVon(rc) {
  const s = rc.ctx.server && rc.ctx.server.server;
  if (s instanceof http.Server) return s;
  // Die Anfrage kam über den Haupt-Listener; dessen Server IST der HTTP-Server.
  const ueber = rc.req && rc.req.socket && rc.req.socket.server;
  return ueber instanceof http.Server ? ueber : null;
}

function url(adresse, port) {
  return `http://${adresse}:${port}`;
}

/**
 * Eine Freigabe der Schleuse für genau diese eigene Adresse, solange gebunden wird.
 *
 * Warum überhaupt: `listen(port, adresse)` ruft in Node intern `dns.lookup`
 * für die Adresse auf, und src/net/harden.js fragt dafür die Schleuse -- im
 * Modus "offline" sagt sie zu 192.168.x.x nein. Lauschen ist aber keine
 * Verbindung nach draußen, und die Adresse gehört diesem Rechner selbst.
 *
 * Warum nicht einfach `runInternal` der Schleuse: dessen Zustand hängt an
 * AsyncLocalStorage und würde an den Server-Socket vererbt -- und von dort an
 * jede angenommene iPad-Verbindung. Jede Anfrage vom iPad liefe dann "intern",
 * und was sie auslöst (ein Agent, eine Erweiterung), käme an der Schleuse
 * vorbei. Stattdessen eine sichtbare Freigabe: nur diese eine Adresse, höchstens
 * drei Nutzungen, eine Minute, danach sofort widerrufen. Sie steht mit Grund
 * im Protokoll.
 */
async function mitBindeFreigabe(ctx, adresse, fn) {
  const gate = ctx && ctx.gate;
  let freigabe = null;
  if (gate && typeof gate.addGrant === 'function') {
    try {
      freigabe = gate.addGrant({
        scope: 'global',
        level: 'lan',
        hosts: [adresse],
        maxUses: 3,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        reason: 'iPad verbinden: an der eigenen WLAN-Adresse lauschen (keine Verbindung nach außen)',
      });
    } catch {
      /* ohne Freigabe versucht es listen trotzdem und sagt dann, woran es scheitert */
    }
  }
  try {
    return await fn();
  } finally {
    if (freigabe && typeof gate.revokeGrant === 'function') {
      try { gate.revokeGrant(freigabe.id); } catch { /* schon aufgebraucht */ }
    }
  }
}

/** Einen Listener auf `adresse` öffnen; belegter Port -> ein freier. */
function lauschen(httpServer, adresse, port) {
  const sockets = new Set();
  const make = () => net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    httpServer.emit('connection', socket);
  });
  const versuch = (server, p) => new Promise((resolve, reject) => {
    const fehler = (err) => {
      server.off('listening', ok);
      reject(err);
    };
    const ok = () => {
      server.off('error', fehler);
      resolve(server);
    };
    server.once('error', fehler);
    server.once('listening', ok);
    server.listen(p, adresse);
  });
  return versuch(make(), port)
    .catch((err) => {
      if (err && err.code === 'EADDRINUSE') return versuch(make(), 0);
      throw err;
    })
    .then((server) => ({ server, sockets, adresse, port: server.address().port }));
}

function schliessen(eintrag) {
  return new Promise((resolve) => {
    for (const s of eintrag.sockets) {
      try { s.destroy(); } catch { /* schon zu */ }
    }
    try {
      eintrag.server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** Die Freigabe im Speicher setzen (Host-Prüfung, auth.js) -- und zurücknehmen. */
function freigabeSetzen(config, an, bindHost) {
  if (!config.security || typeof config.security !== 'object') config.security = {};
  const s = config.security.sharing && typeof config.security.sharing === 'object' ? config.security.sharing : {};
  const vorher = { enabled: s.enabled === true, bindHost: s.bindHost, requireToken: s.requireToken };
  config.security.sharing = { ...s, enabled: an, requireToken: true, bindHost: an ? bindHost : (s.bindHost || '127.0.0.1') };
  return vorher;
}

async function einschalten(rc) {
  const vorhanden = LAN.get(rc.ctx);
  if (vorhanden && vorhanden.listener.length) return vorhanden;
  const httpServer = httpServerVon(rc);
  if (!httpServer || !httpServer.listening) {
    throw new NeuralError('SUBSYSTEM_UNAVAILABLE', 'Der Server dieser KI ist nicht bekannt; die Freigabe lässt sich so nicht einschalten.', { status: 503 });
  }
  const adressen = lanAdressen(rc.ctx);
  if (!adressen.length) {
    throw new NeuralError(
      'KEIN_LAN',
      'Dieser Rechner ist in keinem WLAN oder Heimnetz. Verbinde ihn mit demselben WLAN wie das iPad und versuche es noch einmal.',
      { status: 409 },
    );
  }
  const port = httpServer.address().port;
  const listener = [];
  const fehler = [];
  for (const a of adressen) {
    try {
      const l = await mitBindeFreigabe(rc.ctx, a.adresse, () => lauschen(httpServer, a.adresse, port));
      listener.push({ ...l, schnittstelle: a.schnittstelle });
    } catch (err) {
      fehler.push(`${a.adresse}: ${err && err.message}`);
    }
  }
  if (!listener.length) {
    throw new NeuralError(
      'LAN_NICHT_MOEGLICH',
      `Neural OS konnte sich im Netz nicht öffnen (${fehler.join('; ')}).`,
      { status: 500 },
    );
  }
  const vorher = freigabeSetzen(rc.ctx.config, true, listener[0].adresse);
  const eintrag = { listener, vorher, seit: new Date().toISOString() };
  // Endet der HTTP-Server (Beenden), gehen die LAN-Listener mit. Sonst hielte
  // ein offener Port den Prozess am Leben.
  eintrag.beiEnde = () => { ausschalten(rc.ctx).catch(() => {}); };
  httpServer.once('close', eintrag.beiEnde);
  eintrag.httpServer = httpServer;
  LAN.set(rc.ctx, eintrag);
  audit(rc, 'ipad.an', { adressen: listener.map((l) => `${l.adresse}:${l.port}`) });
  publish(rc, 'ipad.an', { adressen: listener.map((l) => ({ adresse: l.adresse, port: l.port })) });
  return eintrag;
}

async function ausschalten(ctx) {
  const eintrag = LAN.get(ctx);
  if (!eintrag) return false;
  LAN.delete(ctx);
  if (eintrag.httpServer && eintrag.beiEnde) eintrag.httpServer.off('close', eintrag.beiEnde);
  await Promise.all(eintrag.listener.map(schliessen));
  const config = ctx.config || {};
  const s = (config.security && config.security.sharing) || {};
  config.security.sharing = {
    ...s,
    enabled: eintrag.vorher.enabled,
    bindHost: eintrag.vorher.bindHost || '127.0.0.1',
    requireToken: eintrag.vorher.requireToken !== false,
  };
  if (ctx.auth && typeof ctx.auth.einmalCodesVerwerfen === 'function') ctx.auth.einmalCodesVerwerfen();
  return true;
}

function geraeteVon(rc) {
  const auth = rc.ctx.auth;
  if (!auth || typeof auth.listTokens !== 'function') return [];
  try {
    return auth.listTokens()
      .filter((t) => t.art === 'bildschirm' && t.active)
      .map((t) => ({ id: t.id, name: t.label, seit: t.createdAt, zuletzt: t.lastUsedAt }));
  } catch {
    return [];
  }
}

function zustandVon(rc) {
  const eintrag = LAN.get(rc.ctx);
  const besitzer = rc.identity && rc.identity.kind === 'owner';
  if (!besitzer) {
    // Das iPad selbst fragt: es darf wissen, dass es verbunden ist, sonst nichts.
    return { an: !!eintrag, besitzer: false, diesesGeraet: rc.identity && rc.identity.kind === 'token' };
  }
  const adressen = eintrag
    ? eintrag.listener.map((l) => ({ adresse: l.adresse, port: l.port, schnittstelle: l.schnittstelle, url: url(l.adresse, l.port) }))
    : [];
  return {
    an: !!eintrag,
    besitzer: true,
    seit: eintrag ? eintrag.seit : null,
    adressen,
    netzGefunden: eintrag ? true : lanAdressen(rc.ctx).length > 0,
    geraete: geraeteVon(rc),
    windows: process.platform === 'win32',
  };
}

function register(router) {
  router.get('/api/ipad', (rc) => {
    rc.requireCapability('read');
    return zustandVon(rc);
  });

  /** Einschalten und einen neuen Einmal-Link ausstellen. */
  router.post('/api/ipad', async (rc) => {
    rc.requireOwner('Das Verbinden eines iPads');
    const auth = needMethod(rc.ctx.auth, 'einmalCode', 'Die Anmeldung', 'Ohne sie kann kein Gerät sicher verbunden werden.');
    const eintrag = await einschalten(rc);
    const ziel = eintrag.listener[0];
    const bus = rc.ctx.bus;
    const { code, bis, pfad } = auth.einmalCode({
      label: 'iPad',
      beiEinloesung: (info) => {
        if (bus && typeof bus.publish === 'function') {
          bus.publish('ipad.verbunden', { geraet: info.geraet, id: info.token && info.token.id, name: info.token && info.token.label });
        }
      },
    });
    audit(rc, 'ipad.code', { bis });
    return { ...zustandVon(rc), link: `${url(ziel.adresse, ziel.port)}${pfad}`, bis, codeLaenge: code.length };
  });

  router.delete('/api/ipad', async (rc) => {
    rc.requireOwner('Das Ausschalten der Freigabe');
    const war = await ausschalten(rc.ctx);
    audit(rc, 'ipad.aus', { war });
    publish(rc, 'ipad.aus', {});
    return zustandVon(rc);
  });

  router.delete('/api/ipad/geraete/:id', (rc) => {
    rc.requireOwner('Das Trennen eines Geräts');
    const auth = needMethod(rc.ctx.auth, 'revokeToken', 'Die Anmeldung');
    const vorhanden = geraeteVon(rc).some((g) => g.id === rc.params.id);
    if (!vorhanden) throw new NotFoundError(`Verbundenes Gerät ${rc.params.id}`);
    auth.revokeToken(rc.params.id);
    audit(rc, 'ipad.getrennt', { id: rc.params.id });
    publish(rc, 'ipad.getrennt', { id: rc.params.id });
    return zustandVon(rc);
  });
}

module.exports = { register, __internals: { privat, lanAdressen, ausschalten } };
