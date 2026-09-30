#!/usr/bin/env node
'use strict';

/**
 * tools/stick-trennung-check.js -- zwei Sticks am selben Laptop, im echten
 * Browser (docs/STICK-BAUPLAN.md 1.4/1.5, Paket W1).
 *
 * Der schwierige Fall: nacheinander laufen unter DERSELBEN Adresse (gleicher
 * Port, also gleicher Browser-Speicher) erst eine Heim-Installation, dann
 * Stick A, dann Stick B. Geprueft wird:
 *
 *  1. Vom Stick gibt es keinen Service Worker -- einer von frueher wird
 *     abgemeldet, sein Zwischenspeicher geloescht, die Seite danach nicht
 *     mehr von ihm gesteuert.
 *  2. Was sich der Browser merkt, traegt die Kennung der KI; Entwuerfe
 *     liegen nur in sessionStorage.
 *  3. Ist A aus (Stick gezogen), zeigt sein offener Tab nach wenigen
 *     Sekunden nur „Neural OS ist aus.“ -- von der KI bleibt nichts sichtbar.
 *  4. Laeuft danach B unter derselben Adresse, schreibt der alte Tab von A
 *     nie in B (409 KI_GEWECHSELT), und B sieht keinen Schluessel von A.
 *  5. Oben steht der Name von B; [Beenden] zeigt „Gespeichert. Stick kann raus.“
 *
 * Laeuft, wenn Playwright und Chromium da sind; sonst sagt es das ehrlich
 * und endet mit 2. Nichts verlaesst 127.0.0.1.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createApp, seedIfEmpty } = require('../src/app');
const pathsMod = require('../src/kernel/paths');
const { findPlaywright, findChromium } = require('./lib/browser');

const G = '\u001b[32m'; const R = '\u001b[31m'; const Y = '\u001b[33m';
const D = '\u001b[2m'; const BO = '\u001b[1m'; const X = '\u001b[0m';

const ergebnisse = [];
function check(ok, satz, detail = '') {
  ergebnisse.push({ ok: !!ok, satz });
  console.log(`  ${ok ? `${G}✓${X}` : `${R}✗${X}`} ${satz}${detail ? `  ${D}${detail}${X}` : ''}`);
}

function freierPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Ein Stick mit Marker, wie ihn „Stick vorbereiten“ anlegt. */
function stick(wurzel, name) {
  const root = path.join(wurzel, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, pathsMod.PORTABLE_MARKER), JSON.stringify({
    neuralOsPortable: true, dataDir: 'data', appDir: 'app', createdAt: new Date().toISOString(),
  }, null, 2));
  return { root, data: path.join(root, 'data'), appDir: path.join(root, 'app') };
}

async function starten(opts, port) {
  const app = await createApp({ port, host: '127.0.0.1', logLevel: 'error', harden: false, ...opts });
  await seedIfEmpty(app);
  await app.listen();
  return app;
}

async function warteBis(fn, { timeout = 8000, alle = 100 } = {}) {
  const ende = Date.now() + timeout;
  for (;;) {
    const wert = await fn().catch(() => null);
    if (wert) return wert;
    if (Date.now() > ende) return wert;
    await new Promise((r) => setTimeout(r, alle));
  }
}

const speicherVon = (p) => p.evaluate(() => {
  const lies = (s) => {
    const out = {};
    for (let i = 0; i < s.length; i += 1) out[s.key(i)] = s.getItem(s.key(i));
    return out;
  };
  return { dauer: lies(localStorage), sitzung: lies(sessionStorage) };
});

(async () => {
  console.log(`\n${BO}Neural OS · zwei Sticks am selben Laptop${X}`);
  const pw = findPlaywright();
  if (!pw) {
    console.log(`\n${Y}Playwright ist nicht installiert -- nichts geprueft.${X}`);
    process.exit(2);
  }
  const { chromium } = await import(pw);
  const exe = findChromium();
  // Ohne Signal-Haken: [Beenden] schliesst hier die Anwendung, nicht dieses Werkzeug.
  const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-trennung-'));
  const port = await freierPort();
  const base = `http://127.0.0.1:${port}`;
  // EIN Browser-Profil fuer alles -- wie ein Laptop mit einem Browser.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const fehler = [];
  let apps = [];

  try {
    /* 1 · Erst eine Heim-Installation unter dieser Adresse: sie hinterlaesst einen Service Worker. */
    console.log(`\n${BO}1 · Vom Stick gibt es keinen Service Worker${X}`);
    const heim = await starten({ home: path.join(wurzel, 'heim') }, port);
    apps.push(heim);
    const pH = await ctx.newPage();
    pH.on('pageerror', (e) => fehler.push(e.message));
    await pH.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    const heimWorker = await warteBis(() => pH.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return null;
      const reg = await navigator.serviceWorker.getRegistration();
      const namen = await caches.keys();
      return reg && reg.active && namen.some((n) => n.startsWith('neural-os-shell-')) ? { namen } : null;
    }), { timeout: 15000 });
    check(!!heimWorker, 'Zu Hause (nicht vom Stick) registriert sich der Service Worker, die Schale liegt im Zwischenspeicher', heimWorker ? heimWorker.namen.join(', ') : 'keiner');
    await pH.close();
    await heim.close();
    apps = apps.filter((a) => a !== heim);

    const A = stick(wurzel, 'StickA');
    const appA = await starten({ home: A.data, appDir: A.appDir }, port);
    apps.push(appA);
    const idA = appA.ki.id;
    const pA = await ctx.newPage();
    pA.on('pageerror', (e) => fehler.push(e.message));
    await pA.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    await pA.locator('.cv-composer__feld').waitFor({ timeout: 10000 });
    // Die erste Seite kann noch der alte Worker ausgeliefert haben; er ist
    // abgemeldet, gilt aber bis zum Neuladen. Danach steuert ihn keiner mehr.
    await warteBis(() => pA.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length === 0), { timeout: 8000 });
    await pA.reload({ waitUntil: 'domcontentloaded' });
    await pA.locator('.cv-composer__feld').waitFor({ timeout: 10000 });
    const wegA = await warteBis(() => pA.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const namen = (await caches.keys()).filter((n) => n.startsWith('neural-os-shell-'));
      return regs.length === 0 && namen.length === 0 && !navigator.serviceWorker.controller;
    }), { timeout: 8000 });
    check(wegA, 'Stick A: der alte Worker ist abgemeldet, sein Zwischenspeicher gelöscht – die Seite steuert keiner mehr');

    /* 2 · Was sich der Browser von A merkt. */
    console.log(`\n${BO}2 · Alles, was sich der Browser merkt, trägt die Kennung der KI${X}`);
    await pA.goto(`${base}/#/settings`, { waitUntil: 'domcontentloaded' });
    await pA.getByRole('radio', { name: 'Hell' }).click();
    await pA.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    await pA.locator('.cv-composer__feld').fill('Geheimer Entwurf von A');
    await pA.waitForTimeout(600);
    const sA = await speicherVon(pA);
    const alleA = [...Object.keys(sA.dauer), ...Object.keys(sA.sitzung)].filter((k) => k.startsWith('neural-os:'));
    check(alleA.length > 0 && alleA.every((k) => k.startsWith(`neural-os:${idA}:`)),
      'Jeder Schlüssel heißt neural-os:<Kennung von A>:…; die der Heim-Installation sind weg', alleA.map((k) => k.replace(idA, 'A')).join(', '));
    const entwurfLiegt = Object.entries(sA.sitzung).some(([k, v]) => k === `neural-os:${idA}:entwurf:neu` && v === 'Geheimer Entwurf von A');
    const imDauer = Object.values(sA.dauer).some((v) => /Geheimer Entwurf/.test(v));
    check(entwurfLiegt && !imDauer, 'Der Entwurf liegt nur in sessionStorage – im localStorage steht kein Text');

    /* 3 · A wird gezogen: sein Tab zeigt nur noch „Neural OS ist aus.“ */
    console.log(`\n${BO}3 · Stick A gezogen: der Tab zeigt „Neural OS ist aus.“${X}`);
    await appA.close();
    apps = apps.filter((a) => a !== appA);
    const aus = pA.locator('#aus');
    await aus.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    const ausText = (await aus.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const deckt = await pA.evaluate(() => {
      const el = document.getElementById('aus');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const bg = getComputedStyle(el).backgroundColor;
      const shell = document.getElementById('shell') || document.querySelector('.shell');
      return r.width >= window.innerWidth && r.height >= window.innerHeight && !/rgba\(.*, 0\)/.test(bg) && (!shell || shell.inert === true);
    });
    check(/^Neural OS ist aus\. Zum Öffnen den Starter auf dem Stick doppelklicken\.$/.test(ausText) && deckt,
      '„Neural OS ist aus.“ / „Zum Öffnen den Starter auf dem Stick doppelklicken.“ – deckt alles zu, darunter ist nichts bedienbar', ausText);
    const titelAus = await pA.title();
    check(titelAus === 'Neural OS', 'Der Tab-Titel verrät nichts mehr', titelAus);

    /* 4 · B laeuft jetzt unter derselben Adresse. */
    console.log(`\n${BO}4 · Stick B unter derselben Adresse: A schreibt nie in B, B sieht nichts von A${X}`);
    const B = stick(wurzel, 'StickB');
    const appB = await starten({ home: B.data, appDir: B.appDir }, port);
    apps.push(appB);
    const idB = appB.ki.id;
    await appB.identitaet.umbenennen('Lena');
    const notizenVorher = appB.store.all('note').length;
    // Der alte Tab von A versucht zu schreiben -- mit seiner Kennung.
    const versuch = await pA.evaluate(async (kennung) => {
      try {
        const r = await fetch('/api/records', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Neural-OS': kennung },
          body: JSON.stringify({ type: 'note', data: { title: 'Von A geschrieben' } }),
        });
        return r.status;
      } catch {
        return 0;
      }
    }, idA);
    check(versuch === 409 && appB.store.all('note').length === notizenVorher && !appB.store.all('note').some((n) => n.data.title === 'Von A geschrieben'),
      'Der alte Tab von A kommt bei B nicht durch (409 KI_GEWECHSELT) – in B entsteht nichts', `HTTP ${versuch}`);
    const pB = await ctx.newPage();
    pB.on('pageerror', (e) => fehler.push(e.message));
    await pB.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    await pB.locator('.cv-composer__feld').waitFor({ timeout: 10000 });
    await warteBis(() => pB.evaluate(() => /Lena/.test((document.querySelector('.rail__ki') || {}).textContent || '')), { timeout: 8000 });
    const sB = await speicherVon(pB);
    const vonA = [...Object.keys(sB.dauer), ...Object.keys(sB.sitzung)].filter((k) => k.includes(idA));
    const fremd = Object.keys(sB.dauer).filter((k) => k.startsWith('neural-os:') && !k.startsWith(`neural-os:${idB}:`));
    check(vonA.length === 0 && fremd.length === 0, 'B sieht keinen Schlüssel von A – beim Start ist alles Fremde weg', fremd.join(', ') || 'nichts Fremdes');
    const designB = await pB.evaluate(() => document.documentElement.dataset.theme || getComputedStyle(document.body).colorScheme);
    check(!/light/.test(String(designB)), 'Das helle Design von A gilt nicht für B', String(designB));
    const nameOben = (await pB.locator('.rail__ki').innerText().catch(() => '')).trim();
    check(nameOben === 'Lena', 'Oben steht der Name dieser KI: „Lena“', nameOben);
    const titelB = await pB.title();
    check(titelB === 'Chat · Lena', 'Der Tab-Titel: Bereich und Name – nie ein Chat-Titel', titelB);

    /* 5 · [Beenden] */
    console.log(`\n${BO}5 · [Beenden]${X}`);
    const beenden = pB.getByRole('button', { name: 'Neural OS beenden' });
    check(await beenden.isVisible(), 'Unten links steht [Beenden]');
    await beenden.click();
    const ende = pB.locator('#aus');
    await ende.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const endeText = (await ende.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const erwartet = process.platform === 'darwin' ? 'Gespeichert. Stick im Finder auswerfen.' : 'Gespeichert. Stick kann raus.';
    check(endeText === erwartet, `Danach steht nur noch „${erwartet}“`, endeText);
    await pB.waitForTimeout(8000);
    const nochDa = (await pB.locator('#aus').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    check(nochDa === erwartet, 'Auch nachdem Neural OS aus ist, bleibt es beim Endtext (nicht „Neural OS ist aus.“)', nochDa);
    apps = apps.filter((a) => a !== appB);
    check(fehler.length === 0, 'Keine Fehler in den Seiten', fehler.slice(0, 3).join(' | '));
  } catch (err) {
    console.log(`\n${R}Abgebrochen:${X} ${err && err.message}`);
    check(false, 'Der Ablauf lief durch', err && err.message);
  } finally {
    for (const a of apps) await a.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.rmSync(wurzel, { recursive: true, force: true });
  }

  const gut = ergebnisse.filter((e) => e.ok).length;
  const schlecht = ergebnisse.length - gut;
  console.log(`\n${BO}Ergebnis${X}  ${G}${gut} funktionieren${X}${schlecht ? `  ${R}${schlecht} nicht${X}` : ''}`);
  process.exit(schlecht ? 1 : 0);
})();
