'use strict';

/**
 * Beweis der Chat-Oberflaeche -- im echten Browser, gegen die echte
 * Anwendung, mit einem Statisten an Anthropics Stelle.
 *
 *   node tools/chat-beweis.js                 Bilder nach ./screenshots/chat
 *   node tools/chat-beweis.js --out /pfad     woandershin
 *
 * Was hier geprueft wird, ist das, was der Nutzer tut: Schluessel einfuegen,
 * fragen, zusehen, wie es streamt, eine Rueckfrage antippen (einfach,
 * mehrfach, eigene Antwort, Taste 2), einen Termin eintragen lassen und
 * zuruecknehmen, einen Prompt kopieren (und die Zwischenablage auslesen),
 * mitten im Strom stoppen, eine Nachricht bearbeiten, neu antworten lassen.
 * Dazu die Antwort, die ihre Oberflaeche selbst baut (docs/ANTWORT-BAUSTEINE.md):
 * alle 22 Baustein-Arten aus ```ui-Bloecken, jede wirklich bedient, ihr
 * Zustand nach dem Neuladen; Fassungen, Umwandeln, markierter Text,
 * Codebloecke (Bearbeiten, Ausfuehren im Sandkasten). Jeder Schritt wird am
 * Ende im Tresor nachgesehen, nicht nur am Bildschirm.
 *
 * Was es NICHT beweist: wie sich Anthropic wirklich verhaelt. Der Statist
 * spricht die Form aus docs/CLAUDE-ANBINDUNG.md (dieselben Bausteine wie
 * test/claude-statist.js), nur langsamer -- damit man "sucht im Internet"
 * und "Stopp mitten im Strom" ueberhaupt sehen kann.
 *
 * Playwright wird global gesucht; Neural OS selbst braucht es nicht.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp, seedIfEmpty } = require('../src/app');
const { B, sse } = require('../test/claude-statist');
const geminiStatist = require('../test/gemini-statist');
const { anfrage } = require('../test/antwort-hilfe');
const anhaengeServer = require('../src/models/anhaenge');
const { findPlaywright, findChromium } = require('./lib/browser');

const G = '\u001b[32m'; const R = '\u001b[31m'; const Y = '\u001b[33m';
const D = '\u001b[2m'; const BO = '\u001b[1m'; const X = '\u001b[0m';

const args = process.argv.slice(2);
const OUT = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.resolve(process.cwd(), 'screenshots', 'chat');
})();

const SCHLUESSEL = 'sk-ant-beweis-0123456789abcdef0123456789';

/* ------------------------------------------------------------ Statist */

/**
 * Wie test/claude-statist.js, aber mit Tempo: zwischen zwei Ereignissen
 * liegen `pauseMs`, und ein Pseudo-Ereignis `{type:'__pause', ms}` haelt
 * den Strom an (die Websuche "laeuft"). Merkt sich, ob der Client die
 * Leitung vorzeitig geschlossen hat -- das ist der Beweis fuer "Stopp".
 */
function langsamerStatist() {
  const schlange = [];
  const anfragen = [];
  const stats = { abgebrochen: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      anfragen.push(body);
      if (req.headers['x-api-key'] !== SCHLUESSEL) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      if (!body || body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', model: body && body.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 2 } }));
        return;
      }
      const naechste = schlange.shift();
      if (!naechste) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Statist: keine Antwort mehr in der Schlange' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let i = 0;
      let zu = false;
      res.on('close', () => {
        if (!res.writableEnded) {
          zu = true;
          stats.abgebrochen += 1;
        }
      });
      const liste = naechste.sse;
      const schritt = () => {
        if (zu) return;
        if (i >= liste.length) {
          res.end();
          return;
        }
        const ev = liste[i++];
        if (ev.type === '__pause') {
          setTimeout(schritt, ev.ms);
          return;
        }
        res.write(sse(ev));
        setTimeout(schritt, naechste.pauseMs ?? 8);
      };
      schritt();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        anfragen,
        stats,
        weiter: (...a) => schlange.push(...a),
        offen: () => schlange.length,
        leeren: () => { schlange.length = 0; },
        close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

/** Text in Wortstuecke, damit man das Schreiben sieht. */
function textLang(index, inhalt) {
  const ev = [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }];
  for (const stueck of inhalt.match(/\S+\s*|\s+/g) || []) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: stueck } });
  ev.push({ type: 'content_block_stop', index });
  return ev;
}

const pause = (ms) => [{ type: '__pause', ms }];
/** Ein Textblock, der mittendrin `ms` lang stockt -- so bleibt ein ```ui-Block eine Weile offen. */
function textMitPause(index, teil1, ms, teil2) {
  const ev = [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }];
  for (const stueck of teil1.match(/\S+\s*|\s+/g) || []) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: stueck } });
  ev.push({ type: '__pause', ms });
  for (const stueck of teil2.match(/\S+\s*|\s+/g) || []) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: stueck } });
  ev.push({ type: 'content_block_stop', index });
  return ev;
}
const zug = (teile, pauseMs) => ({ sse: teile.flat(), pauseMs });

/**
 * Ein PNG aus Rauschen: laesst sich nicht packen, ist also so gross, wie es
 * Pixel hat (1800×1400 ≈ 7,6 MB) -- wie ein Foto vom Handy, das ueber der
 * Grenze von 5 MB liegt.
 */
function pngRauschen(breite, hoehe) {
  const zlib = require('node:zlib');
  const crypto = require('node:crypto');
  const zeile = breite * 3 + 1;
  const roh = crypto.randomBytes(zeile * hoehe);
  for (let y = 0; y < hoehe; y += 1) roh[y * zeile] = 0;
  const stueck = (typ, daten) => {
    const laenge = Buffer.alloc(4);
    laenge.writeUInt32BE(daten.length);
    const td = Buffer.concat([Buffer.from(typ, 'latin1'), daten]);
    const pruef = Buffer.alloc(4);
    pruef.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([laenge, td, pruef]);
  };
  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(breite, 0);
  kopf.writeUInt32BE(hoehe, 4);
  kopf[8] = 8; // Bit je Kanal
  kopf[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    stueck('IHDR', kopf),
    stueck('IDAT', zlib.deflateSync(roh, { level: 1 })),
    stueck('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- Pruefen */

const ergebnisse = [];
function check(ok, satz, detail = '') {
  ergebnisse.push({ ok: !!ok, satz, detail });
  console.log(`  ${ok ? `${G}✓${X}` : `${R}✗${X}`} ${satz}${detail ? `  ${D}${String(detail).slice(0, 140)}${X}` : ''}`);
  return !!ok;
}

const bilder = [];
let nr = 0;
async function foto(page, name) {
  const datei = path.join(OUT, `${String(++nr).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: datei });
  bilder.push(datei);
  return datei;
}

function heute(tage = 0) {
  const d = new Date();
  d.setDate(d.getDate() + tage);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Ein Element ins Bild rollen. Eine Antwort wird bei jeder Aenderung ihrer
 * Signatur neu gebaut (auch durch eine spaete Bus-Meldung); trifft das
 * genau zwischen Auffinden und Rollen, meldet Playwright "not attached".
 * Dann noch einmal -- der Locator findet den neuen Knoten.
 */
async function insBild(loc) {
  for (let i = 0; ; i += 1) {
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 4000 });
      return;
    } catch (err) {
      if (i >= 2 || !/not attached|detached/i.test(String(err && err.message))) throw err;
      await loc.page().waitForTimeout(200);
    }
  }
}

async function warteBis(fn, { timeout = 8000, alle = 60 } = {}) {
  const ende = Date.now() + timeout;
  for (;;) {
    const wert = await fn();
    if (wert) return wert;
    if (Date.now() > ende) return wert;
    await new Promise((r) => setTimeout(r, alle));
  }
}

/* ------------------------------------------------------------- Ablauf */

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`\n${BO}Neural OS · Chat im echten Browser${X}`);
  console.log(`${D}Echte Anwendung, echter Tresor, Chromium -- an Anthropics Stelle ein Statist auf 127.0.0.1.${X}`);

  const pw = findPlaywright();
  if (!pw) {
    console.log(`\n${Y}Playwright ist nicht installiert -- nichts geprueft.${X}`);
    process.exit(2);
  }
  const statist = await langsamerStatist();
  // Gemini nur fuer das Umschreiben von Sprache (7c); es antwortet weiter Claude.
  const gemini = await geminiStatist.starten();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-os-chatbeweis-'));
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, claudeBasis: statist.url, geminiBasis: gemini.url });
  await seedIfEmpty(app);
  if (typeof app.loadModules === 'function') await app.loadModules({}).catch(() => {});
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const store = app.store;

  const { chromium: browserTyp } = await import(pw);
  const exe = findChromium();
  // Ein kuenstliches Mikrofon (Chromium spielt einen Ton ein), ohne Rueckfrage:
  // so laesst sich die Aufnahme fuer Gemini (7c) wirklich aufnehmen.
  const browser = await browserTyp.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const konsole = [];

  async function neueSeite({
    breite = 1440, hoehe = 900, finger = false, rechte = true, ohneClipboard = false, hell = false, erkennung = null, stimme = false, mikrofon = false,
  } = {}) {
    const c = await browser.newContext({
      viewport: { width: breite, height: hoehe },
      colorScheme: hell ? 'light' : 'dark',
      hasTouch: finger,
      isMobile: false,
      deviceScaleFactor: finger ? 2 : 1,
      permissions: [...(rechte ? ['clipboard-read', 'clipboard-write'] : []), ...(mikrofon ? ['microphone'] : [])],
      // Der Service Worker laedt die Seite beim ersten Besuch einmal neu
      // (controllerchange, web/app.js). Das ist gewollt, wuerde hier aber
      // mitten in eine Messung fallen.
      serviceWorkers: 'block',
    });
    await c.addInitScript((thema) => { try { localStorage.setItem('neural-os:theme', thema); } catch { /* egal */ } }, hell ? 'light' : 'dark');
    if (ohneClipboard) {
      // So sieht Safari auf dem iPad Neural OS ueber http://<LAN-IP>: ohne
      // sicheren Kontext gibt es navigator.clipboard gar nicht.
      await c.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
        window.__kopiert = null;
        document.addEventListener('copy', () => {
          const el = document.activeElement;
          window.__kopiert = el && typeof el.value === 'string' ? el.value.slice(el.selectionStart, el.selectionEnd) : String(document.getSelection());
        }, true);
      });
    }
    if (erkennung === 'gut' || erkennung === 'kaputt') {
      // Eine nachgebaute Spracherkennung: Chromium hier hat keinen Google-Dienst.
      // 'gut' liefert erst Zwischentext, dann den fertigen Satz; 'kaputt' meldet
      // sofort "network" -- so wie Opera, das die Erkennung nur dem Namen nach hat.
      await c.addInitScript((art) => {
        window.__erkennung = { gestartet: 0, gestoppt: 0 };
        class FalscheErkennung {
          start() {
            window.__erkennung.gestartet += 1;
            if (art === 'kaputt') {
              setTimeout(() => { if (this.onerror) this.onerror({ error: 'network' }); if (this.onend) this.onend(); }, 60);
              return;
            }
            const ergebnis = (t, fertig) => ({ results: [Object.assign([{ transcript: t, confidence: 0.92 }], { isFinal: fertig })] });
            this.uhren = [
              setTimeout(() => { if (this.onresult) this.onresult(ergebnis('Wie wird', false)); }, 250),
              setTimeout(() => { if (this.onresult) this.onresult(ergebnis('Wie wird das Wetter morgen?', true)); }, 800),
            ];
          }
          stop() {
            window.__erkennung.gestoppt += 1;
            setTimeout(() => { if (this.onend) this.onend(); }, 40);
          }
          abort() {
            for (const u of this.uhren || []) clearTimeout(u);
            setTimeout(() => { if (this.onend) this.onend(); }, 10);
          }
        }
        window.webkitSpeechRecognition = FalscheErkennung;
        window.SpeechRecognition = undefined;
      }, erkennung);
    } else if (erkennung === 'keine') {
      await c.addInitScript(() => {
        window.webkitSpeechRecognition = undefined;
        window.SpeechRecognition = undefined;
      });
    }
    if (stimme) {
      // Eine nachgebaute Sprachausgabe: merkt sich jede Aeusserung; ein Satz
      // endet erst, wenn die Pruefung window.__satzEnde() ruft.
      await c.addInitScript(() => {
        window.__gesprochen = [];
        window.__abbrueche = 0;
        const offen = () => window.__gesprochen.filter((u) => !u.fertig);
        class Aeusserung {
          constructor(t) { this.text = t; this.rate = 1; this.volume = 1; }
        }
        const synth = {
          speaking: false,
          pending: false,
          speak(u) { window.__gesprochen.push(u); },
          cancel() {
            window.__abbrueche += 1;
            for (const u of offen()) {
              u.fertig = true;
              if (u.onerror) u.onerror({ error: 'interrupted' });
            }
          },
          pause() {},
          resume() {},
          getVoices: () => [],
          addEventListener() {},
          removeEventListener() {},
        };
        Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
        window.SpeechSynthesisUtterance = Aeusserung;
        window.__satzEnde = () => {
          const u = offen().filter((x) => String(x.text).trim()).pop();
          if (!u) return null;
          u.fertig = true;
          if (u.onend) u.onend();
          return u.text;
        };
      });
    }
    const p = await c.newPage();
    p.on('pageerror', (e) => konsole.push(e.message.slice(0, 160)));
    p.on('console', (m) => { if (m.type() === 'error') konsole.push(`${m.text().slice(0, 160)}  [${((m.location && m.location()) || {}).url || ''}]`); });
    return { c, p };
  }

  const nachrichten = (chatId) => store.list('message', { filter: { chatId } }).items
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.data.ordinal || 0) - (b.data.ordinal || 0)));
  const chatIdAus = (p) => { const m = /[?&]id=([^&]+)/.exec(p.url()); return m ? decodeURIComponent(m[1]) : null; };
  const strom = (p) => p.waitForFunction(() => !document.querySelector('.cv-composer__senden.is-stopp'), null, { timeout: 20000 });
  const letzteAntwort = (p) => p.locator('.cv-msg--bot').last();

  let fehlgeschlagen = null;
  let chatBausteine = null; // der Chat mit den Bausteinen (Abschnitt 5b), fuer iPad und hellen Modus
  let chatAlle = null; // der Chat mit allen Baustein-Arten (Abschnitt 5c)
  try {
    /* ============================================ 1 · Verbinden, Vorlage */
    console.log(`\n${BO}1 · Verbinde Claude, dann die Vorlage nachgestellt (1440×900)${X}`);
    const { c, p } = await neueSeite();
    // Offline: Mit dem Statisten auf 127.0.0.1 laesst die Schleuse Claude
    // auch offline durch (loopback). Wie die Karte fuer einen echten
    // Offline-Stick aussieht, zeigt deshalb EINE nachgestellte Antwort von
    // GET /api/ki -- der Schalter darunter schaltet dann wirklich.
    const echtOffline = app.gate && app.gate.mode;
    await p.route('**/api/ki', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        aktiv: 'claude', name: 'Claude', verbunden: false, schluesselVorhanden: false, grundCode: 'offline', grund: 'Offline — Claude ist gerade nicht erreichbar.', netz: { modus: 'offline', erlaubt: false },
      }) });
    });
    await p.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    await p.locator('.cv-verbinden[data-grund="offline"]').waitFor({ timeout: 8000 });
    check(/Die KI braucht Internet/.test(await p.locator('.cv-verbinden').innerText()) && await p.locator('.cv-verbinden button', { hasText: 'Online schalten' }).count() === 1,
      'Offline: „Die KI braucht Internet“ mit dem Schalter „Online schalten“ – statt eines leeren Chats', String(echtOffline));
    await foto(p, 'offline-1440');
    await p.unroute('**/api/ki');
    // Dieselbe Adresse noch einmal waere nur ein Hash-Wechsel: neu laden.
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.locator('.cv-verbinden').waitFor({ timeout: 8000 });
    const karte = (await p.locator('.cv-verbinden').innerText()).replace(/\s+/g, ' ');
    check(/Verbinde eine KI/.test(karte) && /Kostenlos mit Google/.test(karte) && /aistudio\.google\.com\/apikey/.test(karte),
      'Ohne Schlüssel: statt eines leeren Chats die Karte „Verbinde eine KI“ – Google zuerst, mit dem Satz, wo es den Schlüssel gibt', karte.slice(0, 120));
    check(await p.locator('.cv-verbinden input[aria-label="Google-Schlüssel"]').count() === 1
      && await p.locator('.cv-verbinden details.cv-verbinden__mehr:not([open])').count() === 1,
    'genau ein Feld für Google; Claude darunter zugeklappt („Oder Claude (kostet pro Nutzung)“)');
    await foto(p, 'verbinde-ki-1440');
    // Der Statist spricht Anthropics Schnittstelle: also Claude aufklappen.
    await p.locator('.cv-verbinden details.cv-verbinden__mehr > summary').click();
    const claudeFeld = p.locator('.cv-verbinden input[aria-label="Claude-Schlüssel"]');
    await claudeFeld.waitFor({ timeout: 3000 });
    check(/console\.anthropic\.com/.test(await p.locator('.cv-verbinden').innerText()), 'Aufgeklappt: das Claude-Feld mit dem Satz, wo es den Schlüssel gibt');
    await claudeFeld.fill('sk-ant-falsch-0000000000000000000000');
    await p.locator('.cv-verbinden details.cv-verbinden__mehr form button[type="submit"]').click();
    // Die Karte wird nach der Pruefung neu gebaut (Zustand der KI); der Satz
    // steht dann im Claude-Teil -- der ist wieder zugeklappt, also aufklappen.
    const fehlerSatz = await warteBis(async () => {
      const t = (await p.locator('.cv-verbinden__fehler').evaluateAll((els) => els.map((e) => e.textContent))).map((x) => x.trim()).filter(Boolean);
      return t.length ? t[0] : null;
    }, { timeout: 8000 });
    check(!!fehlerSatz, 'Ein falscher Schlüssel wird mit einem Satz abgelehnt', String(fehlerSatz));
    if (await p.locator('.cv-verbinden details.cv-verbinden__mehr:not([open])').count()) {
      await p.locator('.cv-verbinden details.cv-verbinden__mehr > summary').click();
    }
    await p.locator('.cv-verbinden input[aria-label="Claude-Schlüssel"]').fill(SCHLUESSEL);
    await p.locator('.cv-verbinden details.cv-verbinden__mehr form button[type="submit"]').click();
    await p.locator('.cv-leer__titel').waitFor({ timeout: 10000 });
    check(app.claude.zustand().verbunden === true, 'Danach geht es sofort weiter: Claude ist verbunden, ohne Neuladen');
    check((await p.locator('.cv-leer__titel').innerText()).trim() === 'Womit kann ich dir helfen?', 'Der leere Chat fragt „Womit kann ich dir helfen?“');
    await p.waitForTimeout(400);
    await foto(p, 'leer-1440');

    // Die Vorlage: Plan fuer den Produktlaunch -- mit Suche, Termin, Notiz, Projekt.
    const frage = 'Plane bitte die nächsten Schritte für den Produktlaunch und bereite eine kurze Zusammenfassung vor.';
    statist.weiter(
      zug([
        B.start(),
        B.denken(0, 'Der Nutzer will einen Plan für den Produktlaunch. Ich suche kurz nach aktuellen Trends, trage das Review ein und halte die Schritte fest.'),
        B.serverWerkzeug(1, 'srvtoolu_markt', 'web_search', { query: 'Produktlaunch Marktanalyse Trends 2026' }),
        pause(3200),
        B.suchErgebnis(2, 'srvtoolu_markt', [
          { type: 'web_search_result', url: 'https://www.example.org/produktlaunch-checkliste', title: 'Produktlaunch: die Checkliste für 2026', encrypted_content: 'enc1' },
          { type: 'web_search_result', url: 'https://www.beispiel.de/markttrends', title: 'Markttrends im Überblick', encrypted_content: 'enc2' },
        ]),
        B.werkzeug(3, 'toolu_review', 'termin_anlegen', { titel: 'Produkt-Review', start: `${heute()}T09:00`, ende: `${heute()}T10:00`, ganztaegig: false, ort: 'Besprechungsraum 2' }),
        B.werkzeug(4, 'toolu_notiz', 'notiz_anlegen', { titel: 'Produktlaunch – Nächste Schritte', text: 'Wichtige Aufgaben identifiziert, Ressourcen geprüft und nächste Schritte vorbereitet. Zusammenfassung verfügbar.' }),
        B.werkzeug(5, 'toolu_projekt', 'projekt_anpassen', { name: 'Produktlaunch', beschreibung: 'Launch vorbereiten: Review, Material, Termine.', aufgaben: ['Review vorbereiten', 'Pressetext schreiben'] }),
        B.ende('tool_use', { server_tool_use: { web_search_requests: 1 } }),
      ], 14),
      zug([
        B.start(),
        // Stockt mitten im Satz: so bleibt "Schreibt die Antwort …" eine Weile zu sehen.
        textMitPause(0, 'Gerne. Ich analysiere den aktuellen Stand, ', 1600, 'identifiziere die nächsten Schritte und erstelle eine kompakte Zusammenfassung für dich.\n\n- [x] Projektkontext analysiert\n- [x] Relevante Aufgaben identifiziert\n- [x] Termine und Ressourcen geprüft\n- [x] Zusammenfassung erstellt'),
        B.text(1, '\n\nLaut der Checkliste gehört ein Review vor jeden Launch.', { zitate: [{ type: 'web_search_result_location', url: 'https://www.example.org/produktlaunch-checkliste', title: 'Produktlaunch: die Checkliste für 2026', cited_text: 'Checkliste', encrypted_index: 'e1' }] }),
        B.ende('end_turn'),
      ], 22),
    );
    await p.locator('.cv-composer__feld').fill(frage);
    await p.keyboard.press('Enter');
    await p.locator('.cv-live', { hasText: 'Sucht im Internet' }).waitFor({ timeout: 8000 });
    const kachelAktiv = await warteBis(async () => {
      const t = await p.locator('.tile[data-tile="agenten"]').innerText().catch(() => '');
      return /Recherche-Agent/.test(t) && /Aktiv/.test(t) ? t : null;
    }, { timeout: 3000 });
    check(!!kachelAktiv, 'Während Claude sucht: die ruhige Zeile „Sucht im Internet …“ und die Kachel zeigt den Recherche-Agenten als „Aktiv“',
      String(kachelAktiv || '').replace(/\s+/g, ' ').slice(0, 110));
    check(/#\/chat\?id=chat_/.test(p.url()), 'Der Chat entsteht mit der ersten Nachricht (Adresse #/chat?id=…)', p.url().split('#')[1]);
    await foto(p, 'sucht-im-internet-1440');
    // Live-Fortschritt aus den echten Ereignissen: was erledigt ist, mit Haken; dann "Schreibt die Antwort …".
    await p.locator('.cv-live--schreibt').waitFor({ timeout: 12000 });
    const erledigt = (await p.locator('.cv-fortschritt .cv-live.is-fertig').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    check(erledigt.length === 4 && /^Gesucht: „Produktlaunch Marktanalyse Trends 2026“ · 2 Treffer$/.test(erledigt[0])
      && /^Termin eingetragen · .*09:00 · Produkt-Review$/.test(erledigt[1]) && /^Notiz angelegt/.test(erledigt[2]) && /^Projekt angelegt/.test(erledigt[3]),
    'Während die Antwort kommt: jeder erledigte Schritt mit Haken („Gesucht: …“, „Termin eingetragen …“, „Notiz angelegt …“, „Projekt angelegt …“)', erledigt.join(' | ').slice(0, 160));
    check(/Schreibt die Antwort …/.test(await p.locator('.cv-live--schreibt').innerText()), 'und zuletzt „Schreibt die Antwort …“, solange der Text kommt');
    await foto(p, 'schreibt-die-antwort-1440');
    await strom(p);
    const chatA = chatIdAus(p);
    await p.waitForTimeout(700);
    const antwortA = letzteAntwort(p);
    check(await antwortA.locator('.md-list--haken .md-haken.is-erledigt').count() === 4, 'Die Erledigt-Liste steht als blaue Haken-Kreise da (wie in der Vorlage)');
    check(await antwortA.locator('.cv-karte').count() >= 3, 'Was die KI angelegt hat, steht als Karte in der Antwort',
      (await antwortA.locator('.cv-karte').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | ').slice(0, 140));
    const termKarte = (await antwortA.locator('.cv-karte[data-typ="event"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Termin eingetragen/.test(termKarte) && /09:00/.test(termKarte) && /Produkt-Review/.test(termKarte),
      'Termin-Karte: „Termin eingetragen · <Tag> · 09:00 · Produkt-Review“ mit Öffnen und Rückgängig', termKarte);
    check(await antwortA.locator('.cv-quellen .cv-quelle').count() >= 1, 'Die Quellen der Websuche stehen als kleine Liste unter der Antwort');
    const verweis = antwortA.locator('.cv-md a.cv-verweis');
    check(await verweis.count() === 1 && (await verweis.innerText()).trim() === '1'
      && (await verweis.getAttribute('href')) === 'https://www.example.org/produktlaunch-checkliste' && (await verweis.getAttribute('target')) === '_blank'
      && /Review vor jeden Launch\.1$/.test((await antwortA.locator('.cv-md p', { hasText: 'Laut der Checkliste' }).innerText()).trim()),
    'Hinter dem zitierten Satz steht die Nummer seiner Quelle – antippbar, öffnet sie in einem neuen Tab', String(await verweis.getAttribute('href')));
    check(await antwortA.locator('.cv-denken summary').count() === 1, 'Der Gedankengang ist einklappbar („Gedankengang“)');
    check(await antwortA.locator('.cv-fortschritt').count() === 0 && /^4 Arbeitsschritte · Recherche, Kalender, Notizen, Projekte$/.test((await antwortA.locator('.cv-schritte > summary').innerText()).trim()),
      'Danach ist der Fortschritt eingeklappt zu „4 Arbeitsschritte · Recherche, Kalender, Notizen, Projekte“', (await antwortA.locator('.cv-schritte > summary').innerText()).trim());
    const vorschlaege = await p.locator('.cv-vorschlaege button').count();
    check(vorschlaege === 0, 'Keine geratenen Vorschlags-Knöpfe mehr – nächste Schritte bietet die KI selbst an (Baustein aktionen)', String(vorschlaege));
    const kal = (await p.locator('.tile[data-tile="kalender"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Produkt-Review/.test(kal) && /Besprechungsraum 2/.test(kal), 'Die Kachel „Kalender“ zeigt den neuen Termin, ohne Neuladen', kal.slice(0, 100));
    const notizKachel = (await p.locator('.tile[data-tile="notizen"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Produktlaunch – Nächste Schritte/.test(notizKachel), 'Die Kachel „Notizen“ zeigt die neue Notiz', notizKachel.slice(0, 100));
    const agentKachel = (await p.locator('.tile[data-tile="agenten"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Kalender-Agent/.test(agentKachel) && /Fertig/.test(agentKachel), 'Die Kachel „Agenten aktiv“ zeigt die fertigen Agenten mit grauem Haken', agentKachel.slice(0, 120));
    check((await p.locator('.topbar__title').innerText()).trim().startsWith('Plane bitte'), 'Der Kopf trägt danach den Titel des Chats', (await p.locator('.topbar__title').innerText()).trim());
    await p.mouse.move(700, 300);
    await foto(p, 'antwort-wie-vorlage-1440');
    // Derselbe Chat von oben: Frage und Anfang der Antwort, wie in der Vorlage.
    await p.locator('.cv__scroll').evaluate((el) => { el.scrollTop = 0; });
    await p.waitForTimeout(400);
    await foto(p, 'antwort-von-oben-1440');
    await p.locator('.cv__scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });

    /* ====================================== 2 · Rueckfragen wie ChatGPT */
    console.log(`\n${BO}2 · Rückfragen: Taste 2, Mehrfachwahl, eigene Antwort${X}`);
    await p.locator('.rail__brand').click();
    await p.locator('.cv-leer__titel').waitFor({ timeout: 5000 });
    statist.weiter(zug([
      B.start(),
      textLang(0, 'Gern! Damit der Plan passt, eine Frage vorab.'),
      B.werkzeug(1, 'toolu_f1', 'rueckfrage', { frage: 'Wie lange willst du in Rom bleiben?', optionen: ['Ein Wochenende', 'Eine Woche', 'Zwei Wochen'], mehrfach: false }),
      B.ende('tool_use'),
    ], 14));
    await p.locator('.cv-composer__feld').fill('Plan mir eine Reise nach Rom');
    await p.locator('.cv-composer__senden').click();
    await p.locator('.cv-frage[data-zustand="offen"]').waitFor({ timeout: 8000 });
    await strom(p);
    const chatB = chatIdAus(p);
    // Die Rueckfrage zeichnet DIESELBE Auswahl-Komponente wie der Baustein
    // `auswahl` (web/lib/bausteine/auswahl.js) -- es gibt keine zweite.
    const optionen = p.locator('.cv-frage[data-zustand="offen"] .bs-option');
    check(await optionen.count() === 4 && await p.locator('.cv-frage[data-zustand="offen"] .bs-wahl').count() === 1,
      'Die Rückfrage zeigt drei Optionen und „Eigene Antwort …“ – mit der Auswahl-Komponente der Bausteine', (await optionen.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | '));
    await p.waitForTimeout(300);
    await foto(p, 'rueckfrage-1440');

    statist.weiter(zug([
      B.start(),
      textLang(0, 'Eine Woche, prima.'),
      B.werkzeug(1, 'toolu_f2', 'rueckfrage', { frage: 'Was interessiert dich am meisten?', optionen: ['Antike', 'Essen', 'Kunst', 'Shopping'], mehrfach: true }),
      B.ende('tool_use'),
    ], 14));
    // Taste 2 am Laptop -- der Fokus liegt nach der Frage auf der ersten Option.
    await p.locator('body').press('2').catch(async () => { await p.keyboard.press('2'); });
    await warteBis(() => p.locator('.cv-frage[data-frage="toolu_f2"]').count(), { timeout: 8000 });
    await strom(p);
    const nachF1 = nachrichten(chatB).find((m) => m.data.role === 'assistant');
    const f1 = nachF1 && nachF1.data.rueckfragen.find((f) => f.id === 'toolu_f1');
    check(f1 && f1.zustand === 'beantwortet' && f1.antwort === 'Eine Woche', 'Taste 2 wählt die zweite Option und schickt sie ab (im Tresor: „Eine Woche“)', f1 && `${f1.zustand}: ${f1.antwort}`);
    const erste = p.locator('.cv-frage[data-frage="toolu_f1"]');
    check(await erste.locator('.bs-option.is-gewaehlt').count() === 1 && /Eine Woche/.test(await erste.locator('.bs-option.is-gewaehlt').innerText()),
      'Die beantwortete Karte bleibt im Verlauf und zeigt die gewählte Antwort');

    const f2 = p.locator('.cv-frage[data-frage="toolu_f2"]');
    const anfragenVorMehrfach = statist.anfragen.length;
    await f2.locator('.bs-option', { hasText: 'Antike' }).click();
    await f2.locator('.bs-option.is-gewaehlt', { hasText: 'Antike' }).waitFor({ timeout: 3000 });
    await f2.locator('.bs-option', { hasText: 'Essen' }).click();
    await f2.locator('.bs-option.is-gewaehlt', { hasText: 'Essen' }).waitFor({ timeout: 3000 });
    check(await f2.locator('.bs-option.is-gewaehlt').count() === 2 && statist.anfragen.length === anfragenVorMehrfach, 'Mehrfachauswahl: Antippen markiert, statt sofort zu senden',
      `${await f2.locator('.bs-option.is-gewaehlt').count()} markiert, nichts gesendet`);
    await foto(p, 'rueckfrage-mehrfach-1440');
    statist.weiter(zug([
      B.start(),
      textLang(0, 'Antike und Essen – das passt zu Rom.'),
      B.werkzeug(1, 'toolu_f3', 'rueckfrage', { frage: 'Wann möchtest du fahren?', optionen: ['Im Frühling', 'Im Sommer'], mehrfach: false }),
      B.ende('tool_use'),
    ], 14));
    await f2.getByRole('button', { name: 'Senden' }).click();
    await warteBis(() => p.locator('.cv-frage[data-frage="toolu_f3"][data-zustand="offen"]').count(), { timeout: 8000 });
    await strom(p);
    const f2Satz = nachrichten(chatB).find((m) => m.data.role === 'assistant').data.rueckfragen.find((f) => f.id === 'toolu_f2');
    check(f2Satz && f2Satz.antwort === 'Antike, Essen', '„Senden“ schickt beide Antworten', f2Satz && f2Satz.antwort);

    const f3 = p.locator('.cv-frage[data-frage="toolu_f3"]');
    await f3.locator('.bs-option--eigen').click();
    const eigen = f3.locator('.bs-wahl__eigen input');
    await eigen.waitFor({ timeout: 3000 });
    check(true, '„Eigene Antwort …“ öffnet ein Feld an Ort und Stelle');
    await eigen.fill('Im Oktober, erste Woche');
    await foto(p, 'rueckfrage-eigene-antwort-1440');
    statist.weiter(
      zug([
        B.start(),
        textLang(0, 'Dann trage ich dir die Reise ein.'),
        B.werkzeug(1, 'toolu_rom', 'termin_anlegen', { titel: 'Rom-Reise', start: heute(), ende: heute(6), ganztaegig: true, ort: 'Rom' }),
        B.ende('tool_use'),
      ], 14),
      zug([B.start(), textLang(0, 'Eingetragen: eine Woche Rom ab heute. Soll ich dir einen Plan für die Tage machen?'), B.ende('end_turn')], 14),
    );
    await eigen.press('Enter');
    await warteBis(() => p.locator('.cv-karte[data-typ="event"]', { hasText: 'Rom-Reise' }).count(), { timeout: 10000 });
    await strom(p);
    await p.waitForTimeout(600);
    const f3Satz = nachrichten(chatB).find((m) => m.data.role === 'assistant').data.rueckfragen.find((f) => f.id === 'toolu_f3');
    check(f3Satz && f3Satz.antwort === 'Im Oktober, erste Woche', 'Die eigene Antwort geht mit Enter ab und steht im Tresor', f3Satz && f3Satz.antwort);
    check(/Deine Antwort: Im Oktober/.test(await f3.innerText()), 'und die Karte zeigt „Deine Antwort: …“');
    const rom = store.all('event').find((e) => e.data.title === 'Rom-Reise');
    check(!!rom && rom.data.source === 'auto', 'Ein Termin wird angelegt (im Tresor, Herkunft „auto“)');
    const kal2 = (await p.locator('.tile[data-tile="kalender"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Rom-Reise/.test(kal2), 'Die Kachel „Kalender“ zeigt ihn', kal2.slice(0, 110));
    const ag2 = (await p.locator('.tile[data-tile="agenten"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Kalender-Agent/.test(ag2) && /Rom-Reise/.test(ag2), 'Die Kachel „Agenten“ zeigt den Kalender-Agenten mit dem Termin', ag2.slice(0, 120));
    await foto(p, 'termin-karte-1440');
    const romKarte = p.locator('.cv-karte[data-typ="event"]', { hasText: 'Rom-Reise' });
    await romKarte.getByRole('button', { name: 'Rückgängig' }).click();
    await romKarte.locator('.cv-karte__zurueck').waitFor({ timeout: 6000 }).catch(() => {});
    check(/Zurückgenommen/.test(await romKarte.innerText().catch(() => '')), '„Rückgängig“ – danach steht dort „Zurückgenommen“');
    check(!store.get(rom.id), 'und der Termin ist wirklich aus dem Tresor (über den Änderungsverlauf)');
    await p.waitForTimeout(900);
    check(!/Rom-Reise/.test(await p.locator('.tile[data-tile="kalender"]').innerText().catch(() => '')), 'und aus der Kachel „Kalender“');
    await foto(p, 'termin-zurueckgenommen-1440');

    /* ========================================= 3 · Prompt kopieren */
    console.log(`\n${BO}3 · „Mach mir einen Prompt“: Karte, Kopieren kopiert NUR den Prompt${X}`);
    const prompt = 'Du bist eine erfahrene Personalberaterin. Schreib mir ein kurzes, freundliches Anschreiben für eine Ausbildung zum Mediengestalter.\n\nZiel: eine Seite, Du-Form vermeiden, Stärken: Kreativität, Zuverlässigkeit.\nFormat: drei Absätze, ohne Floskeln.';
    statist.weiter(zug([B.start(), textLang(0, `Hier ist dein Prompt:\n\n\`\`\`prompt\n${prompt}\n\`\`\`\n\nPass die Stärken an, wenn du willst. Und so rufst du es im Terminal auf:\n\n\`\`\`bash\necho "fertig"\n\`\`\``), B.ende('end_turn')], 6));
    await p.locator('.cv-composer__feld').fill('Mach mir einen Prompt für ein Bewerbungsschreiben');
    await p.keyboard.press('Enter');
    await strom(p);
    const promptKarte = letzteAntwort(p).locator('.md-copycard');
    check(await promptKarte.count() === 1 && /Prompt/.test(await promptKarte.locator('.md-copycard__title').innerText()),
      'Der ```prompt-Block erscheint als hervorgehobene Karte „Prompt“ mit „Kopieren“ oben rechts');
    await promptKarte.locator('.md-copycard__copy').click();
    await p.waitForTimeout(250);
    const zwischen = await p.evaluate(() => navigator.clipboard.readText());
    check(zwischen === prompt, 'Kopieren kopiert NUR den Prompt – die Zwischenablage im Browser ausgelesen',
      zwischen === prompt ? `${zwischen.length} Zeichen, genau der Block` : JSON.stringify(zwischen).slice(0, 120));
    check(/Kopiert/.test(await promptKarte.locator('.md-copycard__copy').innerText()), 'und der Knopf sagt „Kopiert“ mit Haken');
    await foto(p, 'prompt-kopiert-1440');
    await p.waitForTimeout(2300);
    check(/^Kopieren$/.test((await promptKarte.locator('.md-copycard__copy').innerText()).trim()), 'nach zwei Sekunden wieder „Kopieren“');
    const code = letzteAntwort(p).locator('.md-code');
    const kopf = (await code.locator('.md-code__head').innerText()).replace(/\s+/g, ' ').trim();
    check(/^Shell Kopieren$/i.test(kopf), 'Codeblock mit Kopfzeile: Sprache links, „Kopieren“ rechts', kopf);
    await code.locator('.md-code__copy').click();
    await p.waitForTimeout(200);
    check((await p.evaluate(() => navigator.clipboard.readText())) === 'echo "fertig"', 'Der Codeblock kopiert nur seinen Code');
    // Die ganze Antwort kopieren (Leiste unter der Antwort).
    await letzteAntwort(p).hover();
    await letzteAntwort(p).getByRole('button', { name: 'Antwort kopieren' }).click();
    await p.waitForTimeout(200);
    const ganz = await p.evaluate(() => navigator.clipboard.readText());
    check(ganz.startsWith('Hier ist dein Prompt:') && ganz.includes('```prompt'), '„Kopieren“ unter der Antwort kopiert die ganze Antwort', `${ganz.length} Zeichen`);
    const kannSprechen = await p.evaluate(() => 'speechSynthesis' in window);
    check(kannSprechen === (await letzteAntwort(p).locator('.cv-aktion[aria-label="Vorlesen"]').count() === 1),
      '„Vorlesen“ gibt es genau dann, wenn der Browser sprechen kann', kannSprechen ? 'speechSynthesis vorhanden, Knopf da' : 'keine Sprachausgabe, kein Knopf');

    /* ========================================== 4 · Tastatur, Stopp */
    console.log(`\n${BO}4 · Enter und Umschalt+Enter, Stopp mitten im Strom, nach unten${X}`);
    const vorher = nachrichten(chatIdAus(p)).length;
    await p.locator('.cv-composer__feld').click();
    await p.keyboard.type('Zeile eins');
    await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('Zeile zwei');
    const wert = await p.locator('.cv-composer__feld').inputValue();
    check(wert === 'Zeile eins\nZeile zwei' && nachrichten(chatIdAus(p)).length === vorher, 'Umschalt+Enter macht eine neue Zeile und sendet nicht', JSON.stringify(wert));
    const lang = Array.from({ length: 140 }, (_, i) => `Satz ${i + 1}: Ein Absatz, damit man das Schreiben sieht und mitten drin anhalten kann.`).join(' ');
    statist.weiter(zug([B.start(), textLang(0, lang), B.ende('end_turn')], 40));
    await p.keyboard.press('Enter');
    const stoppKnopf = p.locator('.cv-composer__senden.is-stopp');
    await stoppKnopf.waitFor({ timeout: 5000 });
    check((await stoppKnopf.getAttribute('aria-label')) === 'Stopp', 'Enter sendet; während Claude schreibt, wird der Senden-Knopf zu „Stopp“');
    await warteBis(async () => (await letzteAntwort(p).locator('.cv-md').innerText().catch(() => '')).length > 400, { timeout: 8000 });
    // Hochrollen: die Ansicht springt nicht mehr mit, der Knopf "nach unten" erscheint.
    await p.locator('.cv__scroll').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await p.waitForTimeout(600);
    const oben1 = await p.locator('.cv__scroll').evaluate((el) => el.scrollTop);
    const nachUntenSichtbar = await p.locator('.cv-nachunten').isVisible();
    check(oben1 < 30 && nachUntenSichtbar, 'Hochgerollt: die Ansicht springt nicht mit, ein runder Knopf „nach unten“ erscheint', `scrollTop ${oben1}`);
    await foto(p, 'schreibt-hochgerollt-1440');
    await stoppKnopf.click();
    await p.locator('.cv-composer__senden:not(.is-stopp)').waitFor({ timeout: 8000 });
    await p.waitForTimeout(500);
    const gestoppt = nachrichten(chatIdAus(p)).filter((m) => m.data.role === 'assistant').pop();
    check(gestoppt.data.status === 'aborted' && gestoppt.data.content.length > 0 && gestoppt.data.content.length < lang.length,
      'Stopp bricht ab, der Teiltext bleibt (im Tresor: status aborted)', `${gestoppt.data.status}, ${gestoppt.data.content.length} von ${lang.length} Zeichen`);
    check(/Abgebrochen – die Antwort ist unvollständig/.test(await letzteAntwort(p).innerText()), 'und ist ehrlich als abgebrochen markiert');
    check(statist.stats.abgebrochen >= 1, 'Die Anfrage an „Anthropic“ wurde wirklich geschlossen (kein bezahlter Zug läuft weiter)');
    await p.locator('.cv-nachunten').click().catch(() => {});
    await p.waitForTimeout(700);
    const rest = await p.locator('.cv__scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    check(rest < 40, '„nach unten“ bringt ans Ende', `${Math.round(rest)} px Rest`);
    await foto(p, 'abgebrochen-1440');

    /* ================================== 5 · Neu antworten, bearbeiten */
    console.log(`\n${BO}5 · Neu antworten, Bearbeiten, Weiter bei max_tokens${X}`);
    statist.weiter(zug([B.start(), textLang(0, 'Neue Fassung: kurz und vollständig.'), B.ende('end_turn')], 10));
    await letzteAntwort(p).hover();
    await letzteAntwort(p).locator('.cv-aktion[aria-label="Neu erstellen"]').click();
    await p.locator('.am[role="menu"]').waitFor({ timeout: 3000 });
    check((await p.locator('.am__eintrag').allInnerTexts()).map((t) => t.trim()).join(' · ') === 'Neu erstellen · Kürzer · Einfacher · Detaillierter · Kreativer · Anders formuliert',
      '„Neu erstellen ▾“ öffnet das Menü mit den Varianten', (await p.locator('.am__eintrag').allInnerTexts()).join(' · '));
    await p.locator('.am__eintrag[data-id="neu"]').click();
    await warteBis(async () => /Neue Fassung/.test(await letzteAntwort(p).innerText().catch(() => '')), { timeout: 8000 });
    await strom(p);
    const nachNeu = nachrichten(chatIdAus(p));
    // Seit den Fassungen (docs/ANTWORT-BAUSTEINE.md 4) bleibt die alte Antwort
    // als Fassung derselben Nachricht erhalten, statt im Papierkorb zu landen.
    const neuSatz = nachNeu[nachNeu.length - 1];
    check(neuSatz.data.content === 'Neue Fassung: kurz und vollständig.' && nachNeu.filter((m) => m.data.role === 'assistant').length === nachrichten(chatIdAus(p)).filter((m) => m.data.role === 'user').length
      && Array.isArray(neuSatz.data.versionen) && neuSatz.data.versionen.length >= 2,
    '„Neu antworten“ ersetzt die letzte Antwort (die alte bleibt als Fassung wählbar)', `${nachNeu.length} Nachrichten, ${(neuSatz.data.versionen || []).length} Fassungen`);

    const eigene = p.locator('.cv-msg--user').last();
    await eigene.hover();
    await eigene.getByRole('button', { name: 'Bearbeiten' }).click();
    const feldB = p.locator('.cv-bearbeiten__feld');
    await feldB.waitFor({ timeout: 3000 });
    await foto(p, 'bearbeiten-1440');
    await feldB.fill('Schreib mir drei kurze Sätze über Rom.');
    statist.weiter(zug([B.start(), textLang(0, 'Rom ist alt. Rom ist laut. Rom ist schön.'), B.ende('max_tokens')], 10));
    await feldB.press('Enter');
    await warteBis(async () => /Rom ist schön/.test(await letzteAntwort(p).innerText().catch(() => '')), { timeout: 8000 });
    await strom(p);
    await p.waitForTimeout(300);
    const nachEdit = nachrichten(chatIdAus(p));
    const letzteEigene = nachEdit.filter((m) => m.data.role === 'user').pop();
    check(letzteEigene.data.content === 'Schreib mir drei kurze Sätze über Rom.' && nachEdit[nachEdit.length - 1].data.role === 'assistant',
      'Bearbeiten ändert die Nachricht, alles danach fällt weg, die KI antwortet neu', `${nachEdit.length} Nachrichten, bearbeitet ${!!letzteEigene.data.bearbeitetAm}`);
    check(/bearbeitet/.test(await p.locator('.cv-msg--user').last().innerText()), 'Die Nachricht trägt „bearbeitet“');
    const weiterKnopf = letzteAntwort(p).getByRole('button', { name: 'Weiter' });
    check(await weiterKnopf.count() === 1, 'Bei max_tokens: ein Knopf „Weiter“');
    await foto(p, 'max-tokens-weiter-1440');

    /* ===================== 5b · Bausteine, Fassungen, Umwandeln, Markieren, Code */
    console.log(`\n${BO}5b · Die Antwort baut ihre Oberfläche: Bausteine, Tabelle, Diagramm, Code, Fassungen${X}`);
    await p.locator('.rail__brand').click();
    await p.locator('.cv-leer__titel').waitFor({ timeout: 5000 });
    const teil1 = '## Dein Plan\n\nEine Stunde am Tag reicht, wenn du dranbleibst.\n\n```ui\n{"typ":"checkliste","titel":"Diese Woche","punkte":["Brüche üben","Gleichungen';
    const teil2 = ' lösen","Probeklausur schreiben"]}\n```\n\n| Tag | Thema | Minuten |\n|---|---|---|\n| Mo | Brüche | 30 |\n| Di | Gleichungen | 45 |\n| Mi | Wiederholen | 60 |\n\n```ui\n{"typ":"diagramm","art":"saeulen","titel":"Lernzeit je Tag","einheit":"min","x":["Mo","Di","Mi"],"reihen":[{"name":"Minuten","werte":[30,45,60]}]}\n```\n\nSo rechnest du die Summe:\n\n```\nconst minuten = [30, 45, 60];\nconsole.log(minuten.reduce((a, b) => a + b, 0));\n```\n\n```ui\n{"typ":"aktionen","aktionen":["Mehr Übungen","Plan als PDF"]}\n```';
    statist.weiter(zug([B.start(), textMitPause(0, teil1, 1100, teil2), B.ende('end_turn')], 6));
    await p.locator('.cv-composer__feld').fill('Mach mir einen Lernplan mit Checkliste');
    await p.keyboard.press('Enter');
    const platzhalter = await warteBis(() => p.locator('.bs--wird').count(), { timeout: 6000 });
    check(!!platzhalter && !/\{"typ"/.test(await letzteAntwort(p).innerText().catch(() => '')),
      'Während der ```ui-Block noch ankommt: „Wird aufgebaut …“, nie rohes JSON');
    await strom(p);
    chatBausteine = chatIdAus(p);
    await p.waitForTimeout(500);
    const bausteinAntwort = letzteAntwort(p);
    const typen = await bausteinAntwort.locator('.bs[data-baustein]').evaluateAll((els) => els.map((e) => e.dataset.baustein));
    check(typen.join(',') === 'checkliste,diagramm,aktionen', 'Danach stehen die Bausteine als Bausteine da: Checkliste, Diagramm, Aktionen', typen.join(','));
    check(await bausteinAntwort.locator('.md-code[data-lang="js"]').count() === 1 && /javascript/i.test(await bausteinAntwort.locator('.md-code__lang').first().innerText()),
      'Ein Codeblock ohne Sprache wird als JavaScript erkannt (und so gefärbt)');
    check(await bausteinAntwort.locator('.cv-md .tb .tb-sort').count() === 3, 'Die Markdown-Tabelle ist sortierbar (Kopfzeile aus Knöpfen)');
    check(await bausteinAntwort.locator('.bs[data-baustein="diagramm"] svg').count() >= 1, 'Das Diagramm ist ein SVG');
    check(!/\{"typ"/.test(await bausteinAntwort.innerText()), 'Nirgends steht JSON');
    await insBild(bausteinAntwort.locator('.bs[data-baustein="checkliste"]'));
    await foto(p, 'bausteine-1440');

    // Checkliste: abhaken -> Fortschritt, gespeichert (PUT …/ui), nach Neuladen noch da, Strg+Z.
    const liste = bausteinAntwort.locator('.bs[data-baustein="checkliste"]');
    await liste.locator('.bs-check__text').first().click();
    await warteBis(async () => /1 von 3/.test(await liste.innerText()), { timeout: 3000 });
    check(/1 von 3/.test(await liste.innerText()), 'Abhaken zählt: „1 von 3“');
    const uiGespeichert = await warteBis(() => {
      const m = nachrichten(chatBausteine).filter((x) => x.data.role === 'assistant').pop();
      const ui = m && m.data.ui && m.data.ui['0'];
      return ui && Object.keys(ui).length ? ui : null;
    }, { timeout: 4000 });
    check(!!uiGespeichert, 'Der Zustand liegt im Tresor (PUT …/ui, entprellt)', JSON.stringify(uiGespeichert).slice(0, 100));
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.locator('.bs[data-baustein="checkliste"]').waitFor({ timeout: 8000 });
    await p.waitForTimeout(400);
    const listeNeu = letzteAntwort(p).locator('.bs[data-baustein="checkliste"]');
    check(/1 von 3/.test(await listeNeu.innerText()) && await listeNeu.locator('.bs-check__punkt.is-erledigt').count() === 1,
      'Nach dem Neuladen ist der Haken noch da');
    await listeNeu.locator('.bs-check__text').nth(1).click();
    await warteBis(async () => /2 von 3/.test(await listeNeu.innerText()), { timeout: 3000 });
    await p.keyboard.press('Control+z');
    await warteBis(async () => /1 von 3/.test(await listeNeu.innerText()), { timeout: 3000 });
    check(/1 von 3/.test(await listeNeu.innerText()), 'Strg+Z nimmt das Abhaken zurück („1 von 3“)');
    await p.keyboard.press('Control+Shift+z');
    await warteBis(async () => /2 von 3/.test(await listeNeu.innerText()), { timeout: 3000 });
    check(/2 von 3/.test(await listeNeu.innerText()), 'Strg+Umschalt+Z holt es wieder („2 von 3“)');

    // Tabelle sortieren, Diagramm als Tabelle.
    const antwortB = letzteAntwort(p);
    await antwortB.locator('.cv-md .tb .tb-sort', { hasText: 'Minuten' }).click();
    await p.waitForTimeout(200);
    const sortiert = (await antwortB.locator('.cv-md .tb tbody tr:not(.tb-leer) td:first-child').allInnerTexts()).filter(Boolean);
    await antwortB.locator('.cv-md .tb .tb-sort', { hasText: 'Minuten' }).click();
    await p.waitForTimeout(200);
    const sortiertAb = (await antwortB.locator('.cv-md .tb tbody tr:not(.tb-leer) td:first-child').allInnerTexts()).filter(Boolean);
    check(sortiert.join(',') === 'Mo,Di,Mi' && sortiertAb.join(',') === 'Mi,Di,Mo', 'Klick auf „Minuten“ sortiert auf, noch ein Klick ab (als Zahl)', `${sortiert.join(',')} → ${sortiertAb.join(',')}`);
    await antwortB.locator('.bs[data-baustein="diagramm"] button', { hasText: 'Als Tabelle' }).click();
    await p.waitForTimeout(250);
    check(await antwortB.locator('.bs[data-baustein="diagramm"] table').count() >= 1 && /60/.test(await antwortB.locator('.bs[data-baustein="diagramm"]').innerText()),
      '„Als Tabelle“ am Diagramm zeigt die echten Zahlen');
    await antwortB.locator('.bs[data-baustein="diagramm"] button', { hasText: 'Als Diagramm' }).click();

    // Code ausfuehren im Sandkasten: die Ausgabe steht darunter.
    const codeBox = antwortB.locator('.cv-code').first();
    await insBild(codeBox);
    await codeBox.locator('.cv-code__knopf', { hasText: 'Ausführen' }).click();
    const ausgabe = await warteBis(async () => {
      const t = await antwortB.locator('.cv-code .sk-lauf').innerText().catch(() => '');
      return /135/.test(t) ? t : null;
    }, { timeout: 10000 });
    check(!!ausgabe, 'Ausführen: JavaScript läuft im Sandkasten, die Ausgabe „135“ steht unter dem Code', String(ausgabe || '').replace(/\s+/g, ' ').slice(0, 80));
    await foto(p, 'code-ausgefuehrt-1440');

    // Markierter Text -> kleines Menue -> Kuerzen aendert nur die Stelle (neue Fassung).
    await insBild(antwortB.locator('.cv-md p', { hasText: 'Eine Stunde am Tag' }));
    await p.evaluate(() => {
      const el = [...document.querySelectorAll('.cv-msg--bot')].pop().querySelector('.cv-md p');
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await p.locator('.am-leiste').waitFor({ timeout: 4000 });
    const leisteText = (await p.locator('.am-leiste').innerText()).replace(/\s+/g, ' ').trim();
    check(/Erklären.*Kürzen.*Umschreiben.*Übersetzen.*Verbessern.*Zusammenfassen.*Frage dazu/.test(leisteText), 'Markierter Text: die Leiste Erklären · Kürzen · Umschreiben · Übersetzen · Verbessern · Zusammenfassen · Frage dazu', leisteText);
    await foto(p, 'markiert-menue-1440');
    statist.weiter(zug([B.start(), textLang(0, 'Eine Stunde täglich genügt.'), B.ende('end_turn')], 6));
    await p.locator('.am-leiste [data-id="kuerzen"]').click();
    await warteBis(async () => /Eine Stunde täglich genügt/.test(await letzteAntwort(p).innerText().catch(() => '')), { timeout: 8000 });
    await strom(p);
    await p.waitForTimeout(300);
    const nachKuerzen = nachrichten(chatBausteine).filter((x) => x.data.role === 'assistant').pop();
    check(nachKuerzen.data.content.includes('Eine Stunde täglich genügt.') && nachKuerzen.data.content.includes('"typ":"checkliste"') && nachKuerzen.data.versionen.length === 2
      && nachKuerzen.data.versionen[1].auswahl === true && nachKuerzen.data.versionen[1].anweisung === 'kuerzen',
    'Kürzen ersetzt nur die Stelle; der Rest (Bausteine, Tabelle, Code) bleibt – als neue Fassung „Stelle: kürzen“', `${nachKuerzen.data.versionen.length} Fassungen`);
    check(await letzteAntwort(p).locator('.cv-md .is-geaendert').count() === 1, 'und die geänderte Stelle ist kurz hervorgehoben');
    const anfrageKuerzen = statist.anfragen[statist.anfragen.length - 1];
    check(anfrageKuerzen && !anfrageKuerzen.tools && JSON.stringify(anfrageKuerzen).includes('Die markierte Stelle'),
      'Die Anfrage an „Anthropic“ hatte keine Werkzeuge und nannte die markierte Stelle');

    // Umwandeln ▾ -> Als Tabelle: eine weitere Fassung, dann blaettern, vergleichen, wiederherstellen.
    await letzteAntwort(p).hover();
    await letzteAntwort(p).locator('.cv-aktion[aria-label="Umwandeln"]').click();
    await p.locator('.am[role="menu"]').waitFor({ timeout: 3000 });
    const menueText = (await p.locator('.am').innerText()).replace(/\s+/g, ' ');
    check(/Verbessern.*Zusammenfassen.*Übersetzen.*Als Tabelle.*Als Diagramm.*Als Checkliste.*Schritt für Schritt.*Wichtigste Punkte.*Nur Text/.test(menueText),
      '„Umwandeln ▾“: Text (Verbessern, Zusammenfassen, Übersetzen ›) und Darstellung (Tabelle … Nur Text)', menueText.slice(0, 120));
    await p.waitForTimeout(300);
    await foto(p, 'umwandeln-menue-1440');
    await p.locator('.am__eintrag[data-id="uebersetzen"]').click();
    await p.waitForTimeout(150);
    check(/Englisch/.test(await p.locator('.am').innerText()) && await p.locator('.am__zurueck').count() === 1, '„Übersetzen ›“ zeigt die Sprachen an Ort und Stelle (mit Zurück)');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(100);
    statist.weiter(zug([B.start(), textLang(0, 'Als Tabelle:\n\n| Tag | Thema |\n|---|---|\n| Mo | Brüche |\n| Di | Gleichungen |'), B.ende('end_turn')], 6));
    await p.locator('.am__eintrag[data-id="tabelle"]').click();
    await warteBis(async () => /Als Tabelle:/.test(await letzteAntwort(p).innerText().catch(() => '')), { timeout: 8000 });
    await strom(p);
    await p.waitForTimeout(300);
    const nachTabelle = nachrichten(chatBausteine).filter((x) => x.data.role === 'assistant').pop();
    check(nachTabelle.data.versionen.length === 3 && nachTabelle.data.version === 2 && nachTabelle.data.versionen[2].anweisung === 'tabelle' && !/checkliste/.test(nachTabelle.data.content),
      '„Als Tabelle“ legt Fassung 3 an (Umgewandelt); Fassung 1 und 2 bleiben', `${nachTabelle.data.versionen.length} Fassungen, aktiv ${nachTabelle.data.version + 1}`);
    await letzteAntwort(p).hover();
    check(/3\/3/.test(await letzteAntwort(p).locator('.cv-fassungen__stand').innerText()) && /Als Tabelle/.test(await letzteAntwort(p).locator('.cv-fassungen__stand').innerText()),
      'Unter der Antwort steht „3/3 · Als Tabelle“', (await letzteAntwort(p).locator('.cv-fassungen__stand').innerText()).trim());
    await letzteAntwort(p).locator('.cv-aktion[aria-label="Vorige Fassung"]').click();
    await p.waitForTimeout(250);
    await letzteAntwort(p).locator('.cv-aktion[aria-label="Vorige Fassung"]').click();
    await p.waitForTimeout(300);
    const angesehen = letzteAntwort(p);
    check(/Fassung 1 von 3 · Original – nur angesehen/.test(await angesehen.innerText()) && await angesehen.locator('.bs[data-baustein="checkliste"]').count() === 1
      && await angesehen.getByRole('button', { name: 'Wiederherstellen' }).count() === 1,
    '‹ ‹ blättert zur ersten Fassung: nur angesehen, mit ihren Bausteinen und [Wiederherstellen]');
    await angesehen.locator('.cv-aktion[aria-label="Vergleichen"]').click();
    await p.waitForTimeout(300);
    const vergleich = angesehen.locator('.cv-vergleich');
    check(await vergleich.count() === 1 && await vergleich.locator('del').count() >= 1 && await vergleich.locator('ins').count() >= 1
      && /Wörter weg/.test(await vergleich.innerText()),
    '„Vergleichen“ zeigt den wortweisen Unterschied zur vorigen Fassung (weg/neu, gezählt)', (await vergleich.locator('.cv-vergleich__zahlen').innerText()).trim());
    await insBild(vergleich);
    await foto(p, 'fassungen-vergleich-1440');
    await angesehen.getByRole('button', { name: 'Wiederherstellen' }).click();
    await warteBis(() => { const m = nachrichten(chatBausteine).filter((x) => x.data.role === 'assistant').pop(); return m.data.version === 0 ? m : null; }, { timeout: 4000 });
    const wieder = nachrichten(chatBausteine).filter((x) => x.data.role === 'assistant').pop();
    check(wieder.data.version === 0 && wieder.data.content.includes('Eine Stunde am Tag reicht') && wieder.data.versionen.length === 3,
      '„Wiederherstellen“ macht Fassung 1 wieder aktiv (PATCH …/version), im Tresor; keine Fassung geht verloren');
    await p.waitForTimeout(300);
    check(/1\/3/.test(await letzteAntwort(p).locator('.cv-fassungen__stand').innerText()) && await letzteAntwort(p).locator('.cv-vergleich').count() === 0,
      'und die Leiste sagt „1/3“');

    // Codeblock bearbeiten -> PATCH …/block -> Fassung „bearbeitet“.
    const codeB = letzteAntwort(p).locator('.cv-code').first();
    await insBild(codeB);
    await codeB.locator('.cv-code__knopf', { hasText: 'Bearbeiten' }).click();
    const codeFeld = codeB.locator('textarea.bs-bearbeiten__feld');
    await codeFeld.waitFor({ timeout: 3000 });
    await codeFeld.fill('const minuten = [30, 45, 60, 15];\nconsole.log(minuten.length);');
    await codeB.getByRole('button', { name: 'Speichern' }).click();
    await warteBis(() => { const m = nachrichten(chatBausteine).filter((x) => x.data.role === 'assistant').pop(); return m.data.versionen.length === 4 ? m : null; }, { timeout: 5000 });
    const nachBlock = nachrichten(chatBausteine).filter((x) => x.data.role === 'assistant').pop();
    check(nachBlock.data.versionen.length === 4 && nachBlock.data.versionen[3].art === 'bearbeitet' && nachBlock.data.content.includes('minuten.length')
      && nachBlock.data.content.includes('"typ":"checkliste"'),
    'Bearbeiten unter dem Code speichert eine Fassung „bearbeitet“ mit dem neuen Code – alles andere bleibt', `${nachBlock.data.versionen.length} Fassungen`);
    await p.waitForTimeout(300);
    check(/minuten\.length/.test(await letzteAntwort(p).locator('.cv-code').first().innerText()) && /4\/4/.test(await letzteAntwort(p).locator('.cv-fassungen__stand').innerText()),
      'und der Chat zeigt sie sofort („4/4“)');

    // "Frage dazu" an der Ueberschrift.
    const kopfB = letzteAntwort(p).locator('.cv-md .cv-abschnitt').first();
    await kopfB.hover();
    await kopfB.locator('.cv-frage-dazu').click();
    const abschnittFeld = letzteAntwort(p).locator('.cv-abschnitt__feld');
    await abschnittFeld.waitFor({ timeout: 3000 });
    statist.weiter(zug([B.start(), textLang(0, 'Weil Brüche die Grundlage für Gleichungen sind.'), B.ende('end_turn')], 6));
    await abschnittFeld.fill('Warum Brüche zuerst?');
    await abschnittFeld.press('Enter');
    await strom(p);
    await p.waitForTimeout(300);
    const frageDazu = nachrichten(chatBausteine).filter((x) => x.data.role === 'user').pop();
    check(frageDazu.data.content === 'Zum Abschnitt „Dein Plan“ deiner Antwort: Warum Brüche zuerst?', '„Frage dazu“ unter der Überschrift fragt zu genau diesem Abschnitt', frageDazu.data.content);

    // Baustein aktionen: ein Tippen sendet.
    statist.weiter(zug([B.start(), textLang(0, 'Hier sind drei weitere Übungen zu Brüchen.'), B.ende('end_turn')], 6));
    const aktionKnopf = p.locator('.bs[data-baustein="aktionen"] button', { hasText: 'Mehr Übungen' });
    await insBild(aktionKnopf);
    await aktionKnopf.click();
    await strom(p);
    await p.waitForTimeout(300);
    const nachAktion = nachrichten(chatBausteine).filter((x) => x.data.role === 'user').pop();
    check(nachAktion.data.content === 'Mehr Übungen' && /drei weitere Übungen/.test(await letzteAntwort(p).innerText()),
      'Der Baustein „aktionen“ schickt beim Antippen wirklich eine Nachricht, und die KI antwortet');
    // Kopieren nimmt die Text-Fassung der Bausteine mit, nie JSON.
    const bausteinMsg = p.locator('.cv-msg--bot', { has: p.locator('.bs[data-baustein="checkliste"]') }).first();
    await bausteinMsg.hover();
    await bausteinMsg.getByRole('button', { name: 'Antwort kopieren' }).click();
    await p.waitForTimeout(250);
    const kopie = await p.evaluate(() => navigator.clipboard.readText());
    check(!/"typ"/.test(kopie) && /Brüche üben/.test(kopie) && /Lernzeit je Tag/.test(kopie), 'Kopieren unter der Antwort kopiert Bausteine als Text (Checkliste, Diagramm-Tabelle), nie JSON', `${kopie.length} Zeichen`);

    /* ================= 5c · Alle 22 Baustein-Arten im Chat, jede bedient */
    // Der Statist streamt Antworten mit jeder Art von ```ui-Block; jeder
    // Baustein wird hier wirklich bedient (Maus, Tastatur), sein Zustand im
    // Tresor nachgesehen (PUT …/ui) und nach dem Neuladen noch einmal
    // gepruefft. Checkliste, Diagramm und Aktionen stehen schon in 5b.
    console.log(`\n${BO}5c · Alle Baustein-Arten im Chat: jede bedient, Zustand nach Neuladen noch da${X}`);
    const ui = (spec) => `\`\`\`ui\n${JSON.stringify(spec)}\n\`\`\``;
    const antwortMd = (md) => zug([B.start(), textLang(0, md), B.ende('end_turn')], 4);
    const bs = (typ) => p.locator(`.bs[data-baustein="${typ}"]`).first();
    const juengsteFrage = (id) => nachrichten(id).filter((x) => x.data.role === 'user').pop();
    const fragen = async (t) => {
      await p.locator('.cv-composer__feld').fill(t);
      await p.keyboard.press('Enter');
      await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 5000 });
      await strom(p);
      await p.waitForTimeout(400);
    };
    const typenDer = (antwortEl) => antwortEl.locator('.bs[data-baustein]').evaluateAll((els) => els.map((e) => e.dataset.baustein));
    await p.locator('.rail__brand').click();
    await p.locator('.cv-leer__titel').waitFor({ timeout: 5000 });

    // --- A · Üben: quiz, lernkarten, lueckentext, zuordnung
    statist.weiter(antwortMd(`Los geht's – vier Übungen:\n\n${ui({ typ: 'quiz', titel: 'Portugal', fragen: [
      { frage: 'Was ist die Hauptstadt von Portugal?', optionen: ['Porto', 'Lissabon', 'Coimbra'], richtig: 1, erklaerung: 'Lissabon ist seit dem 13. Jahrhundert Hauptstadt.' },
      { frage: 'Welcher Fluss fließt durch Lissabon?', optionen: ['Douro', 'Tejo', 'Mondego'], richtig: 1 },
    ] })}\n\n${ui({ typ: 'lernkarten', titel: 'Erste Wörter', karten: [{ vorne: 'Obrigado', hinten: 'Danke' }, { vorne: 'Bom dia', hinten: 'Guten Morgen' }, { vorne: 'Por favor', hinten: 'Bitte' }] })}\n\n${ui({ typ: 'lueckentext', titel: 'Städte', text: 'Die Hauptstadt von Portugal ist {{Lissabon|Lisboa}}. Der Portwein kommt aus {{Porto}}.' })}\n\n${ui({ typ: 'zuordnung', titel: 'Wörter zuordnen', paare: [{ links: 'Hund', rechts: 'cão' }, { links: 'Katze', rechts: 'gato' }, { links: 'Vogel', rechts: 'pássaro' }] })}`));
    await fragen('Ich will Portugiesisch üben – mit Quiz, Karten, Lückentext und Zuordnung');
    chatAlle = chatIdAus(p);
    const typenA = await typenDer(letzteAntwort(p));
    check(typenA.join(',') === 'quiz,lernkarten,lueckentext,zuordnung', 'Üben: Quiz, Lernkarten, Lückentext und Zuordnung stehen als Bausteine da', typenA.join(','));
    const quiz = bs('quiz');
    await quiz.getByRole('radio', { name: /Lissabon/ }).click();
    check((await quiz.locator('.bs-quiz__urteil').innerText()).trim() === 'Richtig' && /13\. Jahrhundert/.test(await quiz.innerText()), 'Quiz: „Lissabon“ → ✓ Richtig, mit Erklärung');
    await quiz.getByRole('button', { name: 'Nächste Frage' }).click();
    await quiz.getByRole('radio', { name: /Douro/ }).click();
    check((await quiz.locator('.bs-quiz__urteil').innerText()).trim() === 'Falsch', 'Quiz: „Douro“ → ✗ Falsch');
    await quiz.getByRole('button', { name: 'Auswertung' }).click();
    check((await quiz.locator('.bs-quiz__zahl').innerText()).trim() === '1/2', 'Quiz: die Auswertung sagt 1/2');
    statist.weiter(antwortMd('Der Tejo mündet bei Lissabon in den Atlantik; der Douro fließt durch Porto.'));
    await quiz.getByRole('button', { name: 'Frage erklären' }).click();
    await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 5000 });
    await strom(p);
    const erkl = juengsteFrage(chatAlle);
    check(/Frage 2/.test(erkl.data.content) && /Douro/.test(erkl.data.content) && /Tejo/.test(erkl.data.content) && /Atlantik/.test(await letzteAntwort(p).innerText()),
      '[Frage erklären] schickt die Frage samt meiner und der richtigen Antwort, und die KI antwortet', erkl.data.content.slice(0, 110));
    const lern = bs('lernkarten');
    await insBild(lern);
    await lern.locator('.bs-lern__karte').click();
    check(await lern.locator('.bs-lern__karte.is-umgedreht').count() === 1 && /Danke/.test(await lern.innerText()), 'Lernkarte: Antippen dreht um („Obrigado“ → „Danke“)');
    await lern.getByRole('button', { name: 'Gewusst' }).click();
    check(/1 von 3 gewusst/.test(await lern.innerText()), 'Lernkarten: [Gewusst] zählt „1 von 3 gewusst“');
    const lt = bs('lueckentext');
    await lt.locator('input.bs-luecke').nth(0).fill('lisboa');
    await lt.locator('input.bs-luecke').nth(1).fill('PORTO');
    await lt.locator('input.bs-luecke').nth(1).press('Enter');
    check(/2 von 2 richtig/.test(await lt.innerText()), 'Lückentext: „lisboa“ und „PORTO“ gelten (Alternative, Groß/Klein egal)');
    const zu = bs('zuordnung');
    await zu.getByRole('button', { name: /^Hund/ }).click();
    await zu.getByRole('button', { name: /^cão/ }).click();
    check(/1 von 3 verbunden/.test(await zu.innerText()), 'Zuordnung: links antippen, dann rechts → „1 von 3 verbunden“');
    await zu.getByRole('button', { name: /^Katze/ }).click();
    await zu.getByRole('button', { name: /^gato/ }).click();
    await zu.getByRole('button', { name: /^Vogel/ }).click();
    await zu.getByRole('button', { name: /^pássaro/ }).click();
    await zu.getByRole('button', { name: 'Prüfen' }).click();
    check(/3 von 3 richtig/.test(await zu.innerText()) && await zu.locator('.bs-zu__linien path.is-richtig').count() === 3, 'Zuordnung: [Prüfen] → „3 von 3 richtig“ mit drei grünen Linien');
    await insBild(quiz);
    await foto(p, 'alle-bausteine-ueben-1440');

    // --- B · Struktur: tabs (mit verschachteltem fortschritt), schritte, abschnitte (mit checkliste), mehr, liste, karten
    statist.weiter(antwortMd(`So geht es:\n\n${ui({ typ: 'tabs', tabs: [
      { titel: 'macOS', inhalt: 'Mit Homebrew: `brew install node`.' },
      { titel: 'Windows', inhalt: `Lade den Installer von nodejs.org.\n\n${ui({ typ: 'fortschritt', titel: 'Download', wert: 64, ziel: 100 })}` },
      { titel: 'Linux', inhalt: '`sudo apt install nodejs`' },
    ] })}\n\n${ui({ typ: 'schritte', titel: 'Node einrichten', schritte: [
      { titel: 'Installieren', inhalt: 'Installer laden und ausführen.' },
      { titel: 'Prüfen', inhalt: '`node -v` zeigt die Version.' },
      { titel: 'Erstes Skript', inhalt: '`node hallo.js`' },
    ] })}\n\n${ui({ typ: 'abschnitte', abschnitte: [
      { titel: 'Was ist npm?', inhalt: 'Der Paketmanager von Node.' },
      { titel: 'Was brauche ich?', inhalt: `Ein Terminal.\n\n${ui({ typ: 'checkliste', punkte: ['Terminal geöffnet', 'Node installiert'] })}` },
    ] })}\n\n${ui({ typ: 'mehr', knopf: 'Genauer erklären', inhalt: 'Node führt JavaScript **außerhalb des Browsers** aus – mit Zugriff auf Dateien und Netz.' })}\n\n${ui({ typ: 'liste', titel: 'Was ist dir am wichtigsten?', punkte: ['Tempo', 'Sicherheit', 'Einfachheit'] })}\n\n${ui({ typ: 'karten', karten: [
      { titel: 'Skript ausführen', symbol: 'code', text: 'Ein erstes Programm', aktion: { text: 'Beispiel zeigen', senden: 'Zeig mir ein erstes Node-Skript.' } },
      { titel: 'Dokumentation', symbol: 'buch', text: 'nodejs.org/docs', aktion: { text: 'Öffnen', link: 'https://nodejs.org/docs' } },
    ] })}`));
    await fragen('Wie richte ich Node ein? Mit Reitern je System, Schritten und einer Rangliste');
    const typenB = await typenDer(letzteAntwort(p));
    check(typenB.join(',') === 'tabs,schritte,abschnitte,mehr,liste,karten', 'Struktur: Reiter, Schritte, Abschnitte, Mehr, Liste und Karten stehen als Bausteine da', typenB.join(','));
    const tabs = bs('tabs');
    await tabs.getByRole('tab', { name: 'Windows' }).click();
    check(await tabs.locator('.bs[data-baustein="fortschritt"]').count() === 1 && /64 %/.test(await tabs.innerText()), 'Reiter „Windows“ zeigt seinen Inhalt – mit einem verschachtelten Baustein (Fortschritt 64 %)');
    const schritteB = bs('schritte');
    await schritteB.getByRole('button', { name: 'Weiter' }).click();
    check(/Schritt 2 von 3/.test(await schritteB.innerText()) && /node -v/.test(await schritteB.innerText()), 'Schritte: [Weiter] → „Schritt 2 von 3“ mit dem Inhalt des zweiten Schritts');
    const abschn = bs('abschnitte');
    await abschn.getByRole('button', { name: 'Was brauche ich?' }).click();
    const innen = abschn.locator('.bs[data-baustein="checkliste"]');
    await innen.waitFor({ timeout: 3000 });
    await innen.locator('.bs-check__text').first().click();
    check(/1 von 2/.test(await innen.innerText()), 'Abschnitte: Aufklappen zeigt eine verschachtelte Checkliste, Abhaken zählt „1 von 2“');
    const mehr = bs('mehr');
    const vorherMehr = !/außerhalb des Browsers/.test(await mehr.innerText());
    await mehr.getByRole('button', { name: 'Genauer erklären' }).click();
    check(vorherMehr && /außerhalb des Browsers/.test(await mehr.innerText()) && await mehr.getByRole('button', { name: 'Weniger' }).count() === 1, '[Genauer erklären] zeigt wirklich mehr (vorher verborgen), danach [Weniger]');
    const listeB = bs('liste');
    await listeB.getByRole('button', { name: /Tempo/ }).focus();
    await p.keyboard.press('Alt+ArrowDown');
    const reihe = (await listeB.locator('.bs-liste__text').allInnerTexts()).join(',');
    check(reihe === 'Sicherheit,Tempo,Einfachheit', 'Liste: Alt+↓ verschiebt „Tempo“ nach unten', reihe);
    statist.weiter(antwortMd('Sicherheit zuerst – gut. Dann fangen wir mit `npm audit` an.'));
    await listeB.getByRole('button', { name: 'Reihenfolge übernehmen' }).click();
    await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 5000 });
    await strom(p);
    const reiheMsg = juengsteFrage(chatAlle);
    check(reiheMsg.data.content === '**Was ist dir am wichtigsten?** – meine Reihenfolge:\n1. Sicherheit\n2. Tempo\n3. Einfachheit', '[Reihenfolge übernehmen] schickt die Reihenfolge als Nachricht', reiheMsg.data.content.replace(/\n/g, ' / '));
    const karten = bs('karten');
    statist.weiter(antwortMd('Ein erstes Skript:\n\n```js\nconsole.log("Hallo");\n```'));
    await karten.getByRole('button', { name: /Skript ausführen/ }).click();
    await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 5000 });
    await strom(p);
    const kartenMsg = juengsteFrage(chatAlle);
    check(kartenMsg.data.content === 'Zeig mir ein erstes Node-Skript.' && (await karten.locator('a.bs-karte').getAttribute('target')) === '_blank',
      'Karten: die ganze Karte sendet ihren Auftrag; die Link-Karte ist ein Link in neuem Tab');
    await insBild(tabs);
    await p.waitForTimeout(200);
    await foto(p, 'alle-bausteine-struktur-1440');

    // --- C · Zeit und Dateien: timer, countdown, termin, datei, vorschau, fortschritt
    const jahr = new Date().getFullYear() + 1;
    statist.weiter(antwortMd(`Hier ist alles beisammen:\n\n${ui({ typ: 'timer', titel: 'Konzentriert arbeiten', dauer: '05:00' })}\n\n${ui({ typ: 'countdown', titel: 'Bis Neujahr', ziel: `${jahr}-01-01T00:00` })}\n\n${ui({ typ: 'termin', titel: 'Lernstunde Portugiesisch', start: `${heute()}T21:30`, ende: `${heute()}T22:00`, ort: 'Zuhause', notiz: 'Karten mitnehmen.' })}\n\n${ui({ typ: 'datei', name: 'lernplan.md', inhalt: '# Lernplan\n\n- Montag: Wörter\n- Dienstag: Sätze\n' })}\n\n${ui({ typ: 'vorschau', art: 'html', titel: 'Zähler', inhalt: '<!doctype html><html><head><style>body{font-family:system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#f5f5f7;color:#111}button{font-size:18px;padding:10px 18px;border-radius:10px;border:0;background:#2f7cf6;color:#fff}</style></head><body><div style="text-align:center"><h1 id="z">0</h1><button id="k">Zählen</button></div><script>let n=0;document.getElementById("k").onclick=()=>{document.getElementById("z").textContent=++n};</script></body></html>' })}\n\n${ui({ typ: 'fortschritt', titel: 'Wochenziel', wert: 3, ziel: 5, einheit: 'Tage' })}`));
    await fragen('Stell mir einen Timer, einen Countdown bis Neujahr, schlag einen Termin vor und gib mir den Plan als Datei und Vorschau');
    const typenC = await typenDer(letzteAntwort(p));
    check(typenC.join(',') === 'timer,countdown,termin,datei,vorschau,fortschritt', 'Zeit und Dateien: Timer, Countdown, Termin, Datei, Vorschau und Fortschritt stehen als Bausteine da', typenC.join(','));
    const timer = bs('timer');
    await timer.getByRole('button', { name: 'Start' }).click();
    await p.waitForTimeout(1300);
    const t1 = (await timer.locator('.bs-timer__zeit').innerText()).trim();
    check(t1 === '04:59' || t1 === '04:58', 'Timer: [Start] – er läuft', t1);
    await timer.getByRole('button', { name: 'Pause' }).click();
    const t2 = (await timer.locator('.bs-timer__zeit').innerText()).trim();
    await p.waitForTimeout(1100);
    check((await timer.locator('.bs-timer__zeit').innerText()).trim() === t2 && /Pausiert/.test(await timer.innerText()), 'Timer: [Pause] hält an („Pausiert“)', t2);
    await timer.getByRole('button', { name: 'Fortsetzen' }).click();
    const cd = bs('countdown');
    const s1 = await cd.locator('[data-teil="sekunden"] .bs-cd__zahl').innerText();
    await p.waitForTimeout(1100);
    const s2 = await cd.locator('[data-teil="sekunden"] .bs-cd__zahl').innerText();
    check(s1 !== s2 && /Tage/.test(await cd.innerText()), 'Countdown: zählt selbst herunter (Tage, Stunden, Minuten, Sekunden)', `${s1} → ${s2}`);
    const termin = bs('termin');
    await termin.getByRole('button', { name: 'Zum Kalender hinzufügen' }).click();
    await termin.getByText('Eingetragen').waitFor({ timeout: 5000 });
    const ev = store.all('event').find((e) => e.data.title === 'Lernstunde Portugiesisch');
    check(!!ev && ev.data.source === 'auto' && ev.data.chatId === chatAlle && ev.data.location === 'Zuhause',
      'Termin: [Zum Kalender hinzufügen] legt ihn wirklich an (Tresor: Herkunft „auto“, mit Chat, Ort)');
    check(await termin.getByRole('button', { name: 'Öffnen' }).count() === 1 && await termin.getByRole('link', { name: /\.ics/ }).count() === 1 && await termin.getByRole('button', { name: 'Rückgängig' }).count() === 1,
      'danach „Eingetragen“ mit [Öffnen], [.ics] und [Rückgängig]');
    // Die Kachel erfaehrt es ueber den Bus (event.created), nicht aus der Antwort auf den POST.
    const kachelTermin = await warteBis(async () => (/Lernstunde Portugiesisch/.test(await p.locator('.tile[data-tile="kalender"]').innerText().catch(() => '')) ? true : null), { timeout: 4000 });
    check(!!kachelTermin, 'und die Kachel „Kalender“ zeigt ihn, ohne Neuladen');
    await termin.getByRole('button', { name: 'Rückgängig' }).click();
    await termin.getByText('Zurückgenommen').waitFor({ timeout: 5000 });
    check(!store.get(ev.id), '[Rückgängig] nimmt den Termin wieder aus dem Tresor');
    const datei = bs('datei');
    await datei.getByRole('button', { name: 'Öffnen' }).click();
    check(await datei.locator('.bs-datei__vorschau .md-heading').count() >= 1 && /Montag: Wörter/.test(await datei.innerText()), 'Datei: [Öffnen] zeigt das Markdown gesetzt');
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), datei.getByRole('button', { name: 'Herunterladen' }).click()]);
    const dlInhalt = fs.readFileSync(await dl.path(), 'utf8');
    check(dl.suggestedFilename() === 'lernplan.md' && dlInhalt.startsWith('# Lernplan'), 'Datei: [Herunterladen] liefert die Datei mit ihrem Inhalt', `${dl.suggestedFilename()}, ${dlInhalt.length} Zeichen`);
    check(await datei.getByRole('button', { name: 'Bearbeiten' }).count() === 1 && await datei.getByRole('button', { name: 'Teilen' }).count() === 0,
      'Datei: [Bearbeiten] ist da, [Teilen] nicht – dieses Gerät kann keine Dateien teilen');
    const vs = bs('vorschau');
    const rahmen = vs.frameLocator('iframe.sk-rahmen');
    await rahmen.getByRole('button', { name: 'Zählen' }).click();
    await rahmen.getByRole('button', { name: 'Zählen' }).click();
    check((await rahmen.locator('#z').innerText()) === '2' && (await vs.locator('iframe.sk-rahmen').getAttribute('sandbox')) === 'allow-scripts',
      'Vorschau: das HTML läuft im Sandkasten (zwei Klicks zählen „2“), sandbox="allow-scripts"');
    const fsC = p.locator('.bs[data-baustein="fortschritt"]').last();
    check(/3 von 5 Tage/.test(await fsC.innerText()) && /60 %/.test(await fsC.innerText()), 'Fortschritt: „3 von 5 Tage · 60 %“');
    await insBild(termin);
    await p.waitForTimeout(200);
    await foto(p, 'alle-bausteine-zeit-dateien-1440');
    await vs.getByRole('button', { name: 'Anhalten' }).click();
    check(await vs.locator('iframe.sk-rahmen').count() === 0 && /Angehalten/.test(await vs.innerText()), 'Vorschau: [Anhalten] entfernt den Rahmen');

    // --- D · Angaben: auswahl (Liste, mehrfach), formular
    statist.weiter(antwortMd(`Zwei Dinge brauche ich noch:\n\n${ui({ typ: 'auswahl', stil: 'liste', mehrfach: true, frage: 'Welche Teile sollen in den Plan?', optionen: [{ text: 'Grundlagen', beschreibung: 'Begriffe und Regeln' }, { text: 'Übungen', beschreibung: 'Mit Lösungen' }, { text: 'Prüfung', beschreibung: 'Eine Probeklausur' }], knopf: 'Weiter' })}\n\n${ui({ typ: 'formular', titel: 'Dein Lernplan', knopf: 'Plan erstellen', felder: [
      { name: 'start', label: 'Start', art: 'datum', pflicht: true },
      { name: 'tage', label: 'Tage pro Woche', art: 'zahl', min: 1, max: 7, wert: 3 },
      { name: 'niveau', label: 'Niveau', art: 'auswahl', optionen: ['A1', 'A2', 'B1'], wert: 'A1' },
      { name: 'erinnern', label: 'Erinnerung', art: 'schalter' },
    ] })}`));
    await fragen('Ich will einen Lernplan – frag mich, was du brauchst');
    const typenD = await typenDer(letzteAntwort(p));
    check(typenD.join(',') === 'auswahl,formular', 'Angaben: Auswahl und Formular stehen als Bausteine da', typenD.join(','));
    const wahl = bs('auswahl');
    await wahl.getByRole('checkbox', { name: /Grundlagen/ }).click();
    await wahl.getByRole('checkbox', { name: /Übungen/ }).click();
    check(/2 gewählt/.test(await wahl.innerText()), 'Auswahl (Liste, mehrfach): zwei Kästchen → „2 gewählt“, nichts gesendet');
    statist.weiter(antwortMd('Grundlagen und Übungen – gut.'));
    await wahl.getByRole('button', { name: 'Weiter' }).click();
    await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 5000 });
    await strom(p);
    check(juengsteFrage(chatAlle).data.content === 'Grundlagen, Übungen', '[Weiter] schickt die Wahl als Nachricht', juengsteFrage(chatAlle).data.content);
    const form = bs('formular');
    await form.getByRole('button', { name: 'Plan erstellen' }).click();
    check(/Bitte ausfüllen\./.test(await form.innerText()), 'Formular: das Pflichtfeld wird vor dem Senden geprüft („Bitte ausfüllen.“)');
    await form.getByLabel('Start').fill(heute(3));
    await form.getByLabel('Niveau').selectOption('A2');
    await form.getByRole('switch').click();
    statist.weiter(antwortMd('Dein Plan ab dem Wochenende, Niveau A2, mit Erinnerung.'));
    await form.getByRole('button', { name: 'Plan erstellen' }).click();
    await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 5000 });
    await strom(p);
    const formMsg = juengsteFrage(chatAlle).data.content;
    check(formMsg.startsWith('**Formular: Dein Lernplan**') && /Niveau: A2/.test(formMsg) && /Erinnerung: Ja/.test(formMsg) && /Tage pro Woche: 3/.test(formMsg) && /Start: /.test(formMsg),
      'Formular: Absenden schickt eine lesbare Nachricht „Formular: Dein Lernplan – Feld: Wert …“', formMsg.replace(/\n/g, ' / '));
    check(/Gesendet/.test(await form.innerText()) && await form.getByLabel('Start').isDisabled(), 'danach steht „Gesendet“ am Formular, die Felder sind zu');
    await insBild(wahl);
    await p.waitForTimeout(200);
    await foto(p, 'alle-bausteine-angaben-1440');

    // --- E · Regler: Antwortstil setzen -> die Antwort wird als neue Fassung neu erstellt
    const reglerSpec = (wert) => ({ typ: 'regler', titel: 'Antwortstil', regler: [{ name: 'laenge', label: 'Länge', links: 'kurz', rechts: 'ausführlich', wert }, { name: 'fachlich', label: 'Fachbegriffe', links: 'einfach', rechts: 'fachlich', wert: 50 }] });
    statist.weiter(antwortMd(`Der Konjunktiv drückt Möglichkeit, Wunsch und indirekte Rede aus. Stell den Stil ein, wenn du es anders willst:\n\n${ui(reglerSpec(50))}`));
    await fragen('Erklär mir den Konjunktiv – und lass mich den Stil einstellen');
    const reg = bs('regler');
    check(await reg.count() === 1 && await reg.locator('input[type="range"]').count() === 2 && /Loslassen übernimmt den Stil/.test(await reg.innerText()), 'Der Regler „Antwortstil“ steht mit zwei Schiebern da – Loslassen übernimmt, ohne Knopf');
    statist.weiter(antwortMd(`Ausführlicher: Der Konjunktiv I steht in der indirekten Rede („er sagte, er komme“), der Konjunktiv II markiert Irreales („wenn ich Zeit hätte“).\n\n${ui(reglerSpec(55))}`));
    await reg.locator('input[type="range"]').first().focus();
    for (let i = 0; i < 5; i += 1) await p.keyboard.press('ArrowRight');
    const stilLaeuft = await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 5000 });
    check(!!stilLaeuft, 'Loslassen (entprellt) erstellt die Antwort mit dem neuen Stil neu – ohne weiteren Knopf');
    await strom(p);
    await p.waitForTimeout(400);
    const nachStil = nachrichten(chatAlle).filter((x) => x.data.role === 'assistant').pop();
    const chatSatz = store.get(chatAlle);
    check(nachStil.data.versionen.length === 2 && nachStil.data.versionen[1].art === 'neu' && nachStil.data.versionen[1].anweisung === 'stil' && /Konjunktiv II/.test(nachStil.data.content),
      'Die neue Antwort ist Fassung 2 („Neuer Stil“); die alte bleibt', `${nachStil.data.versionen.length} Fassungen`);
    check(!!chatSatz.data.stil && chatSatz.data.stil.laenge === 55 && chatSatz.data.stil.fachlich === 50, 'und der Antwortstil des Chats ist gesetzt (Länge 55, Fachbegriffe 50)', JSON.stringify(chatSatz.data.stil));
    const anfrageStil = JSON.stringify(statist.anfragen[statist.anfragen.length - 1] || {});
    check(anfrageStil.includes('[Antwortstil: Länge 55/100'), 'Die KI bekam den Stil als Block in der Frage („[Antwortstil: Länge 55/100 …]“)');
    await letzteAntwort(p).hover();
    check(/2\/2/.test(await letzteAntwort(p).locator('.cv-fassungen__stand').innerText()) && /Neuer Stil/.test(await letzteAntwort(p).locator('.cv-fassungen__stand').innerText()),
      'Unter der Antwort steht „2/2 · Neuer Stil“', (await letzteAntwort(p).locator('.cv-fassungen__stand').innerText()).trim());
    await foto(p, 'alle-bausteine-regler-1440');

    // --- Im Tresor: je Baustein ein Zustand; nach dem Neuladen ist alles noch da.
    const ersteAntwort = nachrichten(chatAlle).find((x) => x.data.role === 'assistant');
    const uiA = await warteBis(() => { const m = store.get(ersteAntwort.id); const z = m && m.data.ui && m.data.ui['0']; return z && ['b0', 'b1', 'b2', 'b3'].every((k) => z[k]) ? z : null; }, { timeout: 4000 });
    check(!!uiA, 'Im Tresor liegt je Baustein ein Zustand (PUT …/ui): Quiz, Lernkarten, Lückentext, Zuordnung', uiA ? Object.keys(uiA).join(', ') : 'fehlt');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.locator('.bs[data-baustein="quiz"]').first().waitFor({ timeout: 8000 });
    await p.waitForTimeout(700);
    const nachher = {
      quiz: (await bs('quiz').locator('.bs-quiz__zahl').innerText().catch(() => '')).trim(),
      lernkarten: /1 von 3 gewusst/.test(await bs('lernkarten').innerText()),
      lueckentext: /2 von 2 richtig/.test(await bs('lueckentext').innerText()),
      zuordnung: /3 von 3 richtig/.test(await bs('zuordnung').innerText()),
      schritte: /Schritt 2 von 3/.test(await bs('schritte').innerText()),
      liste: (await bs('liste').locator('.bs-liste__text').allInnerTexts()).join(','),
      auswahl: /Grundlagen/.test(await bs('auswahl').innerText()) && await bs('auswahl').getByRole('button', { name: 'Weiter' }).count() === 0,
      formular: /Gesendet/.test(await bs('formular').innerText()),
      timer: (await bs('timer').locator('.bs-timer__zeit').innerText()).trim(),
      timerLaeuft: await bs('timer').getByRole('button', { name: 'Pause' }).count() === 1,
    };
    check(nachher.quiz === '1/2' && nachher.lernkarten && nachher.lueckentext && nachher.zuordnung && nachher.schritte && nachher.liste === 'Sicherheit,Tempo,Einfachheit' && nachher.auswahl && nachher.formular,
      'Nach dem Neuladen ist jeder Zustand noch da: Quiz 1/2, Lernkarten, Lückentext, Zuordnung, Schritt 2, Reihenfolge, Wahl, Formular', JSON.stringify(nachher).slice(0, 140));
    check(nachher.timerLaeuft && /^0[34]:\d\d$/.test(nachher.timer) && nachher.timer !== '05:00', 'Der Timer läuft nach dem Neuladen weiter', nachher.timer);
    // Der Regler in einer Antwort, die nicht mehr die letzte ist, sagt ehrlich "Senden" statt "Übernehmen"
    // (Neu erstellen geht nur bei der letzten Antwort) -- geprueft, sobald eine weitere Antwort da ist:
    statist.weiter(antwortMd('Gern – bis morgen.'));
    await fragen('Danke, das reicht für heute.');
    check(await bs('regler').getByRole('button', { name: 'Übernehmen' }).count() === 1 && !/Loslassen übernimmt/.test(await bs('regler').innerText()), 'Der Regler einer älteren Antwort bietet ehrlich [Übernehmen] als Nachricht an – neu erstellen lässt sich nur die letzte Antwort');

    /* ============================ 5d · Bilder und PDF anhängen */
    console.log(`\n${BO}5d · Bilder und PDF: anhängen, Schnellaktionen, an die KI, groß ansehen${X}`);
    // Echte Dateien, im Browser selbst gebaut: ein Aufgabenblatt als PNG, ein Arbeitsblatt als PDF.
    const werkstatt = await browser.newPage({ viewport: { width: 640, height: 400 } });
    await werkstatt.setContent('<body style="margin:0;background:#fff;font:32px system-ui,sans-serif;color:#111"><div style="padding:36px"><b>Aufgabe 1</b><br>12 + 30 = ?<br><br><b>Aufgabe 2</b><br>7 · 8 = ?</div></body>');
    const aufgabePng = await werkstatt.screenshot({ type: 'png' });
    await werkstatt.setContent('<body style="font:18px system-ui,sans-serif"><h1>Arbeitsblatt Brüche</h1><h2>Kapitel 1: Kürzen</h2><p>Ein Bruch wird gekürzt, indem man Zähler und Nenner durch dieselbe Zahl teilt.</p><h2 style="page-break-before:always">Kapitel 2: Erweitern</h2><p>Beim Erweitern werden Zähler und Nenner mit derselben Zahl malgenommen.</p></body>');
    const blattPdf = await werkstatt.pdf({ format: 'A5' });
    const farbBild = async (hex, wort) => {
      await werkstatt.setViewportSize({ width: 320, height: 240 });
      await werkstatt.setContent(`<body style="margin:0;background:${hex};display:grid;place-items:center;height:100vh;font:48px system-ui,sans-serif;color:#fff">${wort}</body>`);
      return werkstatt.screenshot({ type: 'png' });
    };
    const bildEins = await farbBild('#c0392b', 'Eins');
    const bildZwei = await farbBild('#27ae60', 'Zwei');
    const bildDrei = await farbBild('#2f7cf6', 'Drei');
    await werkstatt.close();

    await p.locator('.rail__brand').click();
    await p.locator('.cv-leer__titel').waitFor({ timeout: 5000 });
    const dateiFeld = p.locator('.cv-eingabe input[type="file"]');
    const annahme = String(await dateiFeld.getAttribute('accept'));
    check(annahme.includes('image/png') && annahme.includes('application/pdf') && annahme.includes('.md'), 'Die Büroklammer nimmt Text, Bilder und PDF', annahme.slice(0, 90));
    await dateiFeld.setInputFiles([
      { name: 'aufgabe.png', mimeType: 'image/png', buffer: aufgabePng },
      { name: 'arbeitsblatt.pdf', mimeType: 'application/pdf', buffer: blattPdf },
    ]);
    await p.locator('.cv-anhang[data-art="pdf"]').waitFor({ timeout: 5000 });
    const feldVorschau = await p.locator('.cv-anhang[data-art="bild"] img').evaluate((img) => img.complete && img.naturalWidth > 0);
    const feldText = (await p.locator('.cv-anhaenge').innerText()).replace(/\s+/g, ' ');
    check(feldVorschau && /aufgabe\.png/.test(feldText) && /arbeitsblatt\.pdf/.test(feldText), 'Am Eingabefeld: das Bild als kleine Vorschau, das PDF als Karte – mit Name und Größe', feldText.slice(0, 100));
    const schnell = (await p.locator('.cv-schnell__knopf').allInnerTexts()).map((t) => t.trim());
    check(schnell.join(' · ') === 'Erklären · Aufgaben lösen · Text erkennen · Zusammenfassen · Wichtigste Begriffe · Kapitel',
      'Danach passende Schnellaktionen: fürs Bild Erklären, Aufgaben lösen, Text erkennen; fürs PDF Zusammenfassen, Wichtigste Begriffe, Kapitel', schnell.join(' · '));
    await foto(p, 'anhaenge-am-feld-1440');
    await p.locator('.cv-composer__feld').fill('x');
    check(await p.locator('.cv-schnell').isHidden(), 'Steht etwas im Feld, gehen sie weg – dann gilt, was dort steht');
    await p.locator('.cv-composer__feld').fill('');
    statist.weiter(antwortMd('Aufgabe 1: 12 + 30 = **42**. Aufgabe 2: 7 · 8 = **56**. Das Arbeitsblatt erklärt Kürzen und Erweitern.'));
    const vorAnhang = statist.anfragen.length;
    await p.locator('.cv-schnell__knopf', { hasText: 'Aufgaben lösen' }).click();
    await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 10000 });
    await strom(p);
    await p.waitForTimeout(400);
    const chatAnhang = chatIdAus(p);
    const frageAnhang = nachrichten(chatAnhang).find((m) => m.data.role === 'user');
    check(!!frageAnhang && /^Löse die Aufgaben auf dem Bild/.test(frageAnhang.data.content) && (frageAnhang.data.anhaenge || []).map((a) => a.name).join(',') === 'aufgabe.png,arbeitsblatt.pdf',
      '„Aufgaben lösen“ schickt genau diesen Auftrag mit beiden Dateien (im Tresor: zwei Anhänge an der Nachricht)', frageAnhang && `${frageAnhang.data.content.slice(0, 50)} · ${(frageAnhang.data.anhaenge || []).length} Anhänge`);
    const imTresor = store.all('file').filter((f) => f.data.chatId === chatAnhang);
    check(imTresor.length === 2 && imTresor.every((f) => f.data.quelle === 'chat'), 'Die Dateien liegen im Tresor, zum Chat gehörig', imTresor.map((f) => `${f.data.name} (${f.data.mime})`).join(', '));
    const anfrageAnhang = statist.anfragen.slice(vorAnhang).find((b) => b && b.stream);
    const bloecke = anfrageAnhang ? anfrageAnhang.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) : [];
    const bildBlock = bloecke.find((b) => b.type === 'image');
    const pdfBlock = bloecke.find((b) => b.type === 'document');
    check(!!bildBlock && bildBlock.source.media_type === 'image/png' && Buffer.from(bildBlock.source.data, 'base64').equals(aufgabePng)
      && !!pdfBlock && pdfBlock.source.media_type === 'application/pdf' && Buffer.from(pdfBlock.source.data, 'base64').equals(blattPdf),
    'An „Anthropic“ gingen das Bild (image) und das PDF (document) – Byte für Byte die angehängten Dateien', `${bildBlock ? 'image' : '—'} + ${pdfBlock ? 'document' : '—'}`);
    const eigeneAnhang = p.locator('.cv-msg--user').last();
    const galerieSrc = await eigeneAnhang.locator('.cv-galerie img').evaluate((img) => (img.complete && img.naturalWidth > 0 ? img.getAttribute('src') : null));
    check(/^\/api\/chats\/chat_[^/]+\/anhaenge\/file_/.test(String(galerieSrc)), 'In der Nachricht: das Bild als Vorschau, geladen vom Server', String(galerieSrc));
    const pdfLink = eigeneAnhang.locator('.cv-pdf a', { hasText: 'Anzeigen' });
    const pdfHref = await pdfLink.getAttribute('href');
    const pdfAntwort = await p.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, typ: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength }; }, pdfHref);
    check((await pdfLink.getAttribute('target')) === '_blank' && pdfAntwort.status === 200 && pdfAntwort.typ === 'application/pdf' && pdfAntwort.bytes === blattPdf.length,
      'Das PDF ist eine Karte mit [Anzeigen]: ein neuer Tab mit genau diesem PDF', `${pdfAntwort.status} ${pdfAntwort.typ}, ${pdfAntwort.bytes} Bytes`);
    await insBild(eigeneAnhang);
    await foto(p, 'anhaenge-in-der-nachricht-1440');
    // Leuchtkasten: antippen vergroessert, Esc schliesst, der Fokus kehrt zurueck.
    await eigeneAnhang.locator('.cv-galerie__bild').click();
    await p.locator('.lk').waitFor({ timeout: 3000 });
    const lkBild = await p.locator('.lk__bild').evaluate((img) => ({ breit: img.getBoundingClientRect().width, ok: img.complete && img.naturalWidth > 0 }));
    check(lkBild.ok && lkBild.breit > 500 && /aufgabe\.png/.test(await p.locator('.lk__titel').innerText()), 'Antippen öffnet den Leuchtkasten: das Bild groß, mit Namen', `${Math.round(lkBild.breit)} px breit`);
    await foto(p, 'leuchtkasten-1440');
    await p.keyboard.press('Escape');
    check(await p.locator('.lk').count() === 0 && await p.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('cv-galerie__bild')),
      'Esc schließt ihn, der Fokus ist wieder am Bild');

    // Mehrere Bilder, ein zu grosses Foto und eines aus der Zwischenablage.
    const riesig = pngRauschen(1800, 1400);
    await dateiFeld.setInputFiles([
      { name: 'eins.png', mimeType: 'image/png', buffer: bildEins },
      { name: 'zwei.png', mimeType: 'image/png', buffer: bildZwei },
      { name: 'foto-gross.png', mimeType: 'image/png', buffer: riesig },
    ]);
    await warteBis(async () => (await p.locator('.cv-anhang[data-art="bild"]').count()) === 3, { timeout: 15000 });
    const nachGross = (await p.locator('.cv-anhaenge').innerText()).replace(/\s+/g, ' ');
    check(/foto-gross\.jpg/.test(nachGross) && !/foto-gross\.png/.test(nachGross), `Ein Foto über 5 MB (${(riesig.length / 1048576).toFixed(1).replace('.', ',')} MB) wird verkleinert statt abgelehnt`, nachGross.slice(0, 120));
    await p.locator('.cv-composer__feld').evaluate((feld, b64) => {
      const bytes = Uint8Array.from(atob(b64), (z) => z.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'eingefuegt.png', { type: 'image/png' }));
      feld.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, bildDrei.toString('base64'));
    await warteBis(async () => (await p.locator('.cv-anhang[data-art="bild"]').count()) === 4, { timeout: 5000 });
    check(await p.locator('.cv-anhang[data-art="bild"]').count() === 4 && /eingefuegt\.png/.test(await p.locator('.cv-anhaenge').innerText()), 'Strg+V mit einem Bild in der Zwischenablage hängt es an');
    await dateiFeld.setInputFiles([{ name: 'archiv.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004nichts') }]);
    const zipSatz = await warteBis(async () => (await p.locator('.toast').allInnerTexts().catch(() => [])).find((x) => /archiv\.zip/.test(x)) || null, { timeout: 3000 });
    check(!!zipSatz && /Möglich sind Textdateien, Bilder \(PNG, JPG, WEBP, GIF\) und PDF\./.test(zipSatz), 'Eine ZIP-Datei wird mit einem Satz abgelehnt, statt still zu fehlen', String(zipSatz).replace(/\s+/g, ' '));
    await p.locator('.cv-composer__feld').fill('Welche Farben siehst du?');
    statist.weiter(antwortMd('Rot, Grün, buntes Rauschen und Blau.'));
    await p.keyboard.press('Enter');
    await warteBis(() => p.locator('.cv-composer__senden.is-stopp').count(), { timeout: 15000 });
    await strom(p);
    await p.waitForTimeout(400);
    const vierBilder = p.locator('.cv-msg--user').last();
    check(await vierBilder.locator('.cv-galerie--viele .cv-galerie__bild').count() === 4, 'Vier Bilder in einer Nachricht stehen als Reihe zum Wischen (Karussell)');
    const grossImTresor = store.all('file').find((f) => f.data.chatId === chatAnhang && f.data.name === 'foto-gross.jpg');
    check(!!grossImTresor && grossImTresor.data.mime === 'image/jpeg' && grossImTresor.data.size <= 5 * 1024 * 1024,
      'Das große Foto liegt als JPEG unter 5 MB im Tresor', grossImTresor && `${(grossImTresor.data.size / 1048576).toFixed(2).replace('.', ',')} MB`);
    await insBild(vierBilder);
    await foto(p, 'mehrere-bilder-1440');
    await vierBilder.locator('.cv-galerie__bild').nth(1).click();
    await p.locator('.lk').waitFor({ timeout: 3000 });
    check(/zwei\.png · 2 von 4/.test(await p.locator('.lk__titel').innerText()), 'Der Leuchtkasten kennt alle Bilder der Nachricht („zwei.png · 2 von 4“)', (await p.locator('.lk__titel').innerText()).trim());
    await p.keyboard.press('ArrowRight');
    check(/foto-gross\.jpg · 3 von 4/.test(await p.locator('.lk__titel').innerText()), '→ blättert weiter', (await p.locator('.lk__titel').innerText()).trim());
    await p.locator('.lk__pfeil--links').click();
    check(/2 von 4/.test(await p.locator('.lk__titel').innerText()), '‹ blättert zurück');
    await foto(p, 'leuchtkasten-mehrere-1440');
    await p.locator('.lk__knopf', { hasText: 'Schließen' }).click();
    check(await p.locator('.lk').count() === 0, '[Schließen] schließt ihn');
    await c.close();

    /* ============================ 6 · Kopieren ohne navigator.clipboard */
    console.log(`\n${BO}6 · Kopieren ohne navigator.clipboard (iPad über http://<LAN-IP>)${X}`);
    {
      const { c: c2, p: p2 } = await neueSeite({ breite: 1180, hoehe: 820, finger: true, rechte: false, ohneClipboard: true });
      // Der Chat mit dem Prompt (der zweite, "Plan mir eine Reise nach Rom").
      const promptChat = store.all('message').find((x) => x.data.role === 'assistant' && /```prompt/.test(x.data.content || ''));
      await p2.goto(`${base}/#/chat?id=${encodeURIComponent(promptChat.data.chatId)}`, { waitUntil: 'domcontentloaded' });
      const karte2 = p2.locator('.md-copycard').first();
      await karte2.waitFor({ timeout: 8000 });
      check(await p2.evaluate(() => navigator.clipboard === undefined), 'In diesem Fenster gibt es navigator.clipboard nicht');
      await insBild(karte2);
      await karte2.locator('.md-copycard__copy').tap();
      await p2.waitForTimeout(250);
      const kopiert = await p2.evaluate(() => window.__kopiert);
      check(kopiert === prompt && /Kopiert/.test(await karte2.locator('.md-copycard__copy').innerText()),
        'Rückfall über ein verstecktes Textfeld: kopiert wird trotzdem genau der Prompt', kopiert === prompt ? 'execCommand(copy) mit dem Prompt' : JSON.stringify(kopiert).slice(0, 80));
      await c2.close();
    }

    /* ======================== 7 · iPad quer 1180×820 mit Finger */
    console.log(`\n${BO}7 · iPad quer (1180×820, Finger)${X}`);
    {
      const { c: c3, p: p3 } = await neueSeite({ breite: 1180, hoehe: 820, finger: true });
      await p3.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p3.locator('.cv-leer__titel').waitFor({ timeout: 8000 });
      statist.weiter(zug([
        B.start(),
        textLang(0, 'Gern. Eine Frage, damit der Lernplan passt:'),
        B.werkzeug(1, 'toolu_ipad', 'rueckfrage', { frage: 'Wie viel Zeit hast du pro Tag?', optionen: ['30 Minuten', 'Eine Stunde', 'Zwei Stunden'], mehrfach: false }),
        B.ende('tool_use'),
      ], 10));
      await p3.locator('.cv-composer__feld').tap();
      await p3.locator('.cv-composer__feld').fill('Mach mir einen Lernplan für die Mathearbeit');
      await p3.locator('.cv-composer__feld').press('Enter');
      await p3.locator('.cv-frage[data-zustand="offen"]').waitFor({ timeout: 8000 });
      await p3.waitForFunction(() => !document.querySelector('.cv-composer__senden.is-stopp'), null, { timeout: 15000 });
      await p3.waitForTimeout(300);
      const hoehen = await p3.locator('.cv-frage .bs-option').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      check(hoehen.length === 4 && hoehen.every((x) => x >= 44), 'Optionen sind für den Finger groß genug (≥ 44 px)', hoehen.join(', '));
      const klein = await p3.evaluate(() => [...document.querySelectorAll('.cv button, .cv a[href], .cv input, .cv textarea')]
        .filter((e) => e.offsetWidth && getComputedStyle(e).visibility !== 'hidden')
        .map((e) => [e.className.baseVal === undefined ? e.className : '', Math.round(e.getBoundingClientRect().height)])
        .filter(([, hgt]) => hgt < 44));
      check(klein.length === 0, 'Kein Bedienelement im Chat unter 44 px', klein.slice(0, 5).map(([k, hgt]) => `${String(k).split(' ')[0]} ${hgt}`).join(' · '));
      await foto(p3, 'ipad-rueckfrage-1180');
      statist.weiter(zug([B.start(), textLang(0, '## Dein Lernplan\n\nEine Stunde am Tag reicht, wenn du dranbleibst.\n\n| Tag | Thema |\n|---|---|\n| Mo | Brüche |\n| Di | Gleichungen |\n| Mi | Wiederholen |\n\n- [x] Themen gesammelt\n- [x] Zeit eingeplant'), B.ende('end_turn')], 10));
      await p3.locator('.cv-frage .bs-option', { hasText: 'Eine Stunde' }).tap();
      await p3.waitForFunction(() => document.querySelector('.cv-frage[data-zustand="beantwortet"]'), null, { timeout: 8000 });
      await p3.waitForFunction(() => !document.querySelector('.cv-composer__senden.is-stopp'), null, { timeout: 15000 });
      await p3.waitForTimeout(500);
      check(await p3.locator('.cv-frage .bs-option.is-gewaehlt', { hasText: 'Eine Stunde' }).count() === 1, 'Antippen schickt die Antwort; die Karte zeigt sie danach');
      check(await p3.locator('.cv-md table').count() === 1 && await p3.locator('.cv-md .tb-sort').count() === 2, 'Tabellen werden sauber gesetzt – und sind sortierbar');
      await foto(p3, 'ipad-antwort-1180');
      // Der Chat mit den Bausteinen, mit dem Finger: alles gross genug, alles da.
      await p3.goto(`${base}/#/chat?id=${encodeURIComponent(chatBausteine)}`, { waitUntil: 'domcontentloaded' });
      await p3.locator('.bs[data-baustein="checkliste"]').waitFor({ timeout: 8000 });
      await p3.waitForTimeout(600);
      const kleinB = await p3.evaluate(() => [...document.querySelectorAll('.cv-msg--bot button, .cv-msg--bot a[href], .cv-msg--bot input:not([type="checkbox"])')]
        .filter((e) => e.offsetWidth && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0')
        .map((e) => [String(e.className.baseVal === undefined ? e.className : '').split(' ')[0], Math.round(e.getBoundingClientRect().height)])
        .filter(([, hgt]) => hgt < 44));
      check(kleinB.length === 0, 'iPad: kein sichtbares Bedienelement in den Bausteinen, der Leiste oder den Codeblöcken unter 44 px', kleinB.slice(0, 6).map(([k, hgt]) => `${k} ${hgt}`).join(' · '));
      // Zwei Punkte sind schon abgehakt (Abschnitt 5b); der dritte mit dem Finger.
      // Der Zustand gehoert zur Fassung: die zuletzt bearbeitete Fassung
      // faengt leer an. Geprueft wird, dass Antippen einen Punkt abhakt.
      const listeI = p3.locator('.bs[data-baustein="checkliste"]');
      await insBild(listeI);
      const vorherI = await listeI.locator('.bs-check__punkt.is-erledigt').count();
      await listeI.locator('.bs-check__text').nth(2).tap();
      await warteBis(async () => (await listeI.locator('.bs-check__punkt.is-erledigt').count()) !== vorherI, { timeout: 3000 });
      const nachherI = await listeI.locator('.bs-check__punkt.is-erledigt').count();
      check(nachherI === vorherI + 1 && new RegExp(`${nachherI} von 3`).test(await listeI.innerText()), 'iPad: Antippen hakt ab, der Zähler folgt', `${vorherI} → ${nachherI} von 3`);
      await insBild(p3.locator('.cv-msg--bot').last());
      await foto(p3, 'ipad-bausteine-1180');
      // Der Chat mit allen Baustein-Arten (5c), mit dem Finger: nichts zu klein, Antippen bedient.
      await p3.goto(`${base}/#/chat?id=${encodeURIComponent(chatAlle)}`, { waitUntil: 'domcontentloaded' });
      await p3.locator('.bs[data-baustein="quiz"]').waitFor({ timeout: 8000 });
      await p3.waitForTimeout(700);
      const kleinC = await p3.evaluate(() => [...document.querySelectorAll('.cv-msg--bot button, .cv-msg--bot a[href], .cv-msg--bot input:not([type="checkbox"]), .cv-msg--bot select, .cv-msg--bot [role="tab"]')]
        .filter((e) => e.offsetWidth && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0')
        .map((e) => [String(e.className.baseVal === undefined ? e.className : '').split(' ')[0] || e.tagName.toLowerCase(), Math.round(e.getBoundingClientRect().height)])
        .filter(([, hgt]) => hgt < 44));
      check(kleinC.length === 0, 'iPad: auch im Chat mit allen Baustein-Arten kein sichtbares Bedienelement unter 44 px', kleinC.slice(0, 8).map(([k, hgt]) => `${k} ${hgt}`).join(' · '));
      const lernI = p3.locator('.bs[data-baustein="lernkarten"]').first();
      await insBild(lernI);
      await lernI.locator('.bs-lern__karte').tap();
      check(await lernI.locator('.bs-lern__karte.is-umgedreht').count() === 1, 'iPad: Antippen dreht die Lernkarte um');
      const tabsI = p3.locator('.bs[data-baustein="tabs"]').first();
      await insBild(tabsI);
      await tabsI.getByRole('tab', { name: 'Linux' }).tap();
      check(/apt install nodejs/.test(await tabsI.innerText()), 'iPad: Antippen wechselt den Reiter');
      await insBild(p3.locator('.bs[data-baustein="quiz"]').first());
      await p3.waitForTimeout(200);
      await foto(p3, 'ipad-alle-bausteine-1180');
      await c3.close();
    }

    /* ============================ 7b · Dasselbe im hellen Modus */
    console.log(`\n${BO}7b · Bausteine im hellen Modus (1440×900)${X}`);
    {
      const { c: c5, p: p5 } = await neueSeite({ hell: true });
      await p5.goto(`${base}/#/chat?id=${encodeURIComponent(chatBausteine)}`, { waitUntil: 'domcontentloaded' });
      await p5.locator('.bs[data-baustein="diagramm"] svg').waitFor({ timeout: 8000 });
      await p5.waitForTimeout(700);
      check((await p5.evaluate(() => document.documentElement.dataset.theme || document.documentElement.getAttribute('data-theme') || '')) !== 'dark'
        && await p5.locator('.bs[data-baustein="checkliste"]').count() === 1,
      'Im hellen Modus stehen dieselben Bausteine');
      await insBild(p5.locator('.bs[data-baustein="diagramm"]'));
      await foto(p5, 'bausteine-hell-1440');
      await p5.goto(`${base}/#/chat?id=${encodeURIComponent(chatAlle)}`, { waitUntil: 'domcontentloaded' });
      await p5.locator('.bs[data-baustein="tabs"]').waitFor({ timeout: 8000 });
      await p5.waitForTimeout(700);
      const typenHell = await p5.locator('.bs[data-baustein]').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.baustein))]);
      check(typenHell.length >= 18, 'Im hellen Modus stehen alle Baustein-Arten', `${typenHell.length} Arten`);
      await insBild(p5.locator('.bs[data-baustein="tabs"]').first());
      await p5.waitForTimeout(200);
      await foto(p5, 'alle-bausteine-hell-1440');
      await insBild(p5.locator('.bs[data-baustein="quiz"]').first());
      await p5.waitForTimeout(200);
      await foto(p5, 'alle-bausteine-ueben-hell-1440');
      await c5.close();
    }

    /* ============================ 7c · Sprechen und Vorlesen */
    console.log(`\n${BO}7c · Sprechen statt Tippen, und die Antwort wird vorgelesen${X}`);
    {
      // A · Die Erkennung des Browsers: der Text steht schon beim Sprechen im Feld.
      const { c: c6, p: p6 } = await neueSeite({ erkennung: 'gut', stimme: true });
      await p6.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p6.locator('.cv-leer__titel').waitFor({ timeout: 8000 });
      const mikro6 = p6.locator('.cv-composer__mikro');
      await mikro6.waitFor({ state: 'visible', timeout: 5000 });
      check(await mikro6.isVisible(), 'Im Eingabefeld ist ein Mikrofon: dieser Browser erkennt Sprache');
      await mikro6.click();
      await p6.locator('.cv-sprechen', { hasText: 'Ich höre zu' }).waitFor({ timeout: 3000 });
      check((await mikro6.getAttribute('aria-pressed')) === 'true' && /is-an/.test(String(await mikro6.getAttribute('class'))), 'Antippen: „Ich höre zu …“, und das Mikrofon leuchtet');
      const zwischen = await warteBis(async () => ((await p6.locator('.cv-composer__feld').inputValue()) === 'Wie wird' ? 'Wie wird' : null), { timeout: 3000 });
      check(zwischen === 'Wie wird', 'Schon während des Sprechens steht der Zwischentext im Feld', String(zwischen));
      await foto(p6, 'sprechen-hoert-zu-1440');
      await warteBis(async () => (await p6.locator('.cv-composer__feld').inputValue()) === 'Wie wird das Wetter morgen?', { timeout: 3000 });
      await p6.locator('.cv-sprechen button', { hasText: 'Fertig' }).click();
      await p6.locator('.cv-sprechen').waitFor({ state: 'hidden', timeout: 3000 });
      check((await p6.locator('.cv-composer__feld').inputValue()) === 'Wie wird das Wetter morgen?' && (await p6.evaluate(() => window.__erkennung.gestoppt)) === 1,
        '[Fertig] hält die Erkennung an; der Satz steht im Feld, gesendet ist noch nichts');
      statist.weiter(zug([B.start(), textLang(0, 'Morgen wird es sonnig. Am Nachmittag ziehen ein paar Wolken auf. Es bleibt trocken.'), B.ende('end_turn')], 4));
      await p6.locator('.cv-composer__feld').press('Enter');
      await warteBis(() => p6.locator('.cv-composer__senden.is-stopp').count(), { timeout: 8000 });
      await p6.waitForFunction(() => !document.querySelector('.cv-composer__senden.is-stopp'), null, { timeout: 15000 });
      const spieler = p6.locator('.cv-spieler');
      await spieler.waitFor({ timeout: 5000 });
      const gelesen = await p6.evaluate(() => window.__gesprochen.filter((u) => String(u.text).trim()).map((u) => u.text));
      check(gelesen[0] === 'Morgen wird es sonnig.', 'Die Frage war gesprochen – also wird die Antwort vorgelesen, Satz für Satz', gelesen.join(' | '));
      check(/Satz 1 von 3/.test(await spieler.innerText()) && /1×/.test(await spieler.innerText()) && (await spieler.getByRole('button', { name: 'Pause' }).count()) === 1,
        'Unter der Antwort steht der Spieler: ⏸, Tempo „1×“, „Satz 1 von 3“', (await spieler.innerText()).replace(/\s+/g, ' '));
      const marke = () => p6.evaluate(() => {
        const hl = typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.get('nos-vorlesen') : null;
        return hl ? [...hl].map((r) => r.toString()).join('') : null;
      });
      check((await marke()) === 'Morgen wird es sonnig.', 'Der gerade gelesene Satz ist im Text hervorgehoben (ohne den Text anzufassen)', String(await marke()));
      await foto(p6, 'vorlesen-spieler-1440');
      await p6.evaluate(() => window.__satzEnde());
      await warteBis(async () => /Satz 2 von 3/.test(await spieler.innerText()), { timeout: 2000 });
      check((await marke()) === 'Am Nachmittag ziehen ein paar Wolken auf.' && /Satz 2 von 3/.test(await spieler.innerText()),
        'Ist ein Satz zu Ende, kommt der nächste – die Marke wandert mit', String(await marke()));
      const vorPause = await p6.evaluate(() => window.__gesprochen.length);
      await spieler.getByRole('button', { name: 'Pause' }).click();
      check((await spieler.getByRole('button', { name: 'Weiterlesen' }).count()) === 1
        && (await p6.evaluate((n) => window.__gesprochen.length === n && window.__abbrueche > 0, vorPause)),
      '⏸ hält an – die Stimme wird wirklich abgebrochen, und es kommt kein weiterer Satz');
      await spieler.getByRole('button', { name: 'Weiterlesen' }).click();
      const nachWeiter = await p6.evaluate(() => window.__gesprochen[window.__gesprochen.length - 1].text);
      check(nachWeiter === 'Am Nachmittag ziehen ein paar Wolken auf.', '▶ liest den angehaltenen Satz von vorn', nachWeiter);
      await spieler.locator('.cv-spieler__tempo').click();
      const tempoJetzt = await p6.evaluate(() => { const u = window.__gesprochen[window.__gesprochen.length - 1]; return { text: u.text, rate: u.rate }; });
      check(/1,25×/.test(await spieler.innerText()) && tempoJetzt.rate === 1.25 && tempoJetzt.text === 'Am Nachmittag ziehen ein paar Wolken auf.',
        'Tempo antippen: „1,25×“ – der laufende Satz beginnt neu im neuen Tempo', `${tempoJetzt.rate}× · ${tempoJetzt.text}`);
      await p6.evaluate(() => window.__satzEnde());
      await p6.evaluate(() => window.__satzEnde());
      await spieler.waitFor({ state: 'detached', timeout: 3000 });
      check((await p6.locator('.cv-spieler').count()) === 0 && (await marke()) === null, 'Nach dem letzten Satz verschwindet der Spieler, und die Marke ist weg');
      await letzteAntwort(p6).hover();
      await letzteAntwort(p6).getByRole('button', { name: 'Vorlesen', exact: true }).click();
      await p6.locator('.cv-spieler').waitFor({ timeout: 3000 });
      check(/Satz 1 von 3/.test(await p6.locator('.cv-spieler').innerText()) && /1,25×/.test(await p6.locator('.cv-spieler').innerText()),
        '[Vorlesen] unter der Antwort startet den Spieler von vorn; das Tempo bleibt, wie gewählt');
      await p6.locator('.cv-spieler').getByRole('button', { name: 'Vorlesen beenden' }).click();
      await p6.locator('.cv-spieler').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
      check((await p6.locator('.cv-spieler').count()) === 0 && (await p6.evaluate(() => window.__abbrueche)) > 0, '✕ beendet das Vorlesen (die Stimme verstummt)');
      await c6.close();

      // B · Ohne Erkennung im Browser: aufnehmen, Gemini schreibt um -- aber nur mit Google-Schluessel.
      const { c: c7, p: p7 } = await neueSeite({ erkennung: 'keine', mikrofon: true });
      await p7.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p7.locator('.cv-leer__titel').waitFor({ timeout: 8000 });
      await p7.waitForTimeout(600);
      const mikro7 = p7.locator('.cv-composer__mikro');
      check(await mikro7.isHidden(), 'Ohne Spracherkennung und ohne Google-Schlüssel gibt es kein Mikrofon (kein toter Knopf)');
      const verbunden = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: gemini.schluessel });
      check(verbunden.status === 200 && app.kiDienst.zustand().aktiv === 'claude', 'Gemini wird dazu verbunden; antworten tut weiter Claude', `HTTP ${verbunden.status}`);
      await mikro7.waitFor({ state: 'visible', timeout: 6000 });
      check(await mikro7.isVisible(), 'Kaum ist Gemini verbunden, ist das Mikrofon da – ohne Neuladen');
      gemini.weiterOhneStrom({ text: 'Trag mir morgen um neun den Zahnarzt ein.\n' });
      await mikro7.click();
      await p7.locator('.cv-sprechen__zeit').waitFor({ timeout: 6000 });
      await p7.waitForTimeout(1700);
      const zeitText = (await p7.locator('.cv-sprechen__zeit').innerText()).trim();
      check(/^0:0[12] \/ 1:00$/.test(zeitText) && /Ich höre zu/.test(await p7.locator('.cv-sprechen').innerText()), 'Während der Aufnahme: „Ich höre zu …“, und die Zeit läuft mit (höchstens 1:00)', zeitText);
      await foto(p7, 'aufnahme-laeuft-1440');
      const vorGemini = gemini.anfragen.length;
      await p7.locator('.cv-sprechen button', { hasText: 'Fertig' }).click();
      await warteBis(async () => (await p7.locator('.cv-composer__feld').inputValue()) === 'Trag mir morgen um neun den Zahnarzt ein.', { timeout: 12000 });
      check((await p7.locator('.cv-composer__feld').inputValue()) === 'Trag mir morgen um neun den Zahnarzt ein.', '[Fertig]: Gemini schreibt die Aufnahme um, der Text steht im Feld – gesendet ist noch nichts');
      const aufnahmeAnfrage = gemini.anfragen.slice(vorGemini).find((a) => !a.stream && a.body && JSON.stringify(a.body).includes('inlineData'));
      const tonTeil = aufnahmeAnfrage ? aufnahmeAnfrage.body.contents[0].parts.find((x) => x.inlineData) : null;
      let dauer = null;
      try { dauer = tonTeil ? anhaengeServer.wavPruefen(tonTeil.inlineData.data).sekunden : null; } catch { dauer = null; }
      check(!!tonTeil && tonTeil.inlineData.mimeType === 'audio/wav' && dauer > 1 && dauer < 4, 'An Gemini ging eine echte Aufnahme vom Mikrofon, als WAV, das der Server prüft', dauer ? `${dauer.toFixed(1).replace('.', ',')} s` : 'keine');
      await c7.close();

      // C · Die Erkennung gibt es nur dem Namen nach (Opera): der Chat nimmt von selbst auf.
      const { c: c8, p: p8 } = await neueSeite({ erkennung: 'kaputt', mikrofon: true });
      await p8.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p8.locator('.cv-leer__titel').waitFor({ timeout: 8000 });
      const mikro8 = p8.locator('.cv-composer__mikro');
      await mikro8.waitFor({ state: 'visible', timeout: 6000 });
      gemini.weiterOhneStrom({ text: 'Hallo aus Opera.' }, { text: 'Zweiter Versuch.' });
      await mikro8.click();
      await p8.locator('.cv-sprechen__zeit').waitFor({ timeout: 6000 });
      check((await p8.evaluate(() => window.__erkennung.gestartet)) === 1, 'Meldet die Erkennung des Browsers „network“ (wie Opera), nimmt der Chat stattdessen auf – ohne Zutun');
      await p8.waitForTimeout(800);
      await p8.locator('.cv-sprechen button', { hasText: 'Fertig' }).click();
      await warteBis(async () => (await p8.locator('.cv-composer__feld').inputValue()) === 'Hallo aus Opera.', { timeout: 12000 });
      check((await p8.locator('.cv-composer__feld').inputValue()) === 'Hallo aus Opera.', 'und Gemini schreibt es um');
      await p8.locator('.cv-composer__feld').fill('');
      await mikro8.click();
      await p8.locator('.cv-sprechen__zeit').waitFor({ timeout: 6000 });
      check((await p8.evaluate(() => window.__erkennung.gestartet)) === 1, 'Beim nächsten Mal nimmt er gleich auf – die taube Erkennung wird nicht noch einmal versucht');
      await p8.waitForTimeout(700);
      await p8.locator('.cv-composer__feld').press('Enter');
      await warteBis(async () => (await p8.locator('.cv-composer__feld').inputValue()) === 'Zweiter Versuch.', { timeout: 12000 });
      check((await p8.locator('.cv-composer__feld').inputValue()) === 'Zweiter Versuch.' && (await p8.locator('.cv-sprechen').isHidden()),
        'Enter während der Aufnahme heißt „fertig gesprochen“ – umgeschrieben wird, gesendet nicht');
      await c8.close();
    }

    /* ======================================= 8 · Ansicht Agenten */
    console.log(`\n${BO}8 · Ansicht „Agenten“: Hintergrundaktivität${X}`);
    {
      const { c: c4, p: p4 } = await neueSeite();
      await p4.goto(`${base}/#/agents`, { waitUntil: 'domcontentloaded' });
      await p4.locator('.agv__gruppe').first().waitFor({ timeout: 8000 });
      const text4 = (await p4.locator('.agv').innerText()).replace(/\s+/g, ' ');
      check(/Gerade aktiv/i.test(text4) && /Verlauf/i.test(text4) && /Plane bitte die nächsten Schritte/.test(text4),
        'Nach Chat gruppiert: wer gearbeitet hat, mit Chat-Titel', text4.slice(0, 120));
      check(!(await p4.getByRole('button', { name: /Neuer Agent|Agent anlegen/ }).count()), 'Agenten anlegen gibt es nicht mehr');
      await foto(p4, 'agenten-ansicht-1440');
      const lauf = p4.locator('.agv__lauf', { hasText: 'Produkt-Review' }).first();
      await lauf.locator('summary').click();
      await p4.waitForTimeout(700);
      const det = (await lauf.innerText()).replace(/\s+/g, ' ');
      check(/Ergebnis/i.test(det) && /Termin: Produkt-Review/.test(det) && /Zum Chat/.test(det) && /Kalender-Agent · (unter )?\d/.test(det),
        'Ein Lauf zeigt Dauer, Schritte, Ergebnis und springt zu dem, was er angelegt hat', det.slice(0, 160));
      await foto(p4, 'agenten-lauf-offen-1440');
      await lauf.locator('a.agv__link').first().click();
      await p4.waitForTimeout(900);
      check(/#\/kalender\?id=event_/.test(p4.url()), 'Der Sprung führt zum Termin im Kalender', p4.url().split('#')[1]);
      await c4.close();
    }
  } catch (err) {
    fehlgeschlagen = err;
    console.log(`\n${R}Abgebrochen:${X} ${err && err.message}`);
    if (err && err.stack) console.log(`${D}${err.stack.split('\n').slice(1, 5).join('\n')}${X}`);
  }

  // Neben die Vorlage gelegt: links docs/vorlage/app.png, rechts dieselbe
  // Szene aus der laufenden Anwendung (1440×900).
  try {
    const vorlage = path.join(__dirname, '..', 'docs', 'vorlage', 'app.png');
    const unser = bilder.find((b) => /antwort-von-oben-1440/.test(b)) || bilder.find((b) => /antwort-wie-vorlage/.test(b));
    if (fs.existsSync(vorlage) && unser) {
      const c = await browser.newContext({ viewport: { width: 2900, height: 960 }, serviceWorkers: 'block' });
      const p = await c.newPage();
      const b64 = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
      await p.setContent(`<body style="margin:0;background:#000;display:flex;gap:20px;padding:30px 0 30px 0;font:14px sans-serif;color:#999">
        <figure style="margin:0 0 0 0"><img src="${b64(vorlage)}" style="width:1440px;height:810px;object-fit:contain"><figcaption>Vorlage (docs/vorlage/app.png)</figcaption></figure>
        <figure style="margin:0"><img src="${b64(unser)}" style="width:1440px;height:900px"><figcaption>Neural OS, laufende Anwendung</figcaption></figure></body>`);
      await p.waitForTimeout(300);
      const datei = path.join(OUT, 'vergleich-vorlage.png');
      await p.screenshot({ path: datei, fullPage: true });
      bilder.push(datei);
      await c.close();
    }
  } catch (err) {
    console.log(`${Y}Vergleichsbild nicht gebaut:${X} ${err.message}`);
  }

  await browser.close();
  await app.close();
  await statist.close();
  await gemini.close();
  fs.rmSync(home, { recursive: true, force: true });

  const gut = ergebnisse.filter((e) => e.ok).length;
  const schlecht = ergebnisse.length - gut;
  console.log(`\n${BO}Ergebnis${X}  ${G}${gut} funktionieren${X}${schlecht ? `  ${R}${schlecht} nicht${X}` : ''}  ${D}${bilder.length} Bilder in ${OUT}${X}`);
  // Playwrights `serviceWorkers: 'block'` greift in JEDEM Rahmen nach
  // navigator.serviceWorker -- im Sandkasten (sandbox ohne allow-same-origin)
  // wirft das. Ohne das Blockieren gibt es den Fehler nicht (nachgemessen);
  // er stammt vom Pruefwerkzeug, nicht von der App.
  const echteFehler = konsole.filter((k) => !/Failed to load resource/.test(k) && !/Service worker is disabled because the context is sandboxed/.test(k));
  if (echteFehler.length) {
    console.log(`${Y}Konsolenfehler (${echteFehler.length}):${X}`);
    for (const k of [...new Set(echteFehler)].slice(0, 8)) console.log(`  ${Y}·${X} ${k}`);
  }
  process.exit(fehlgeschlagen || schlecht || echteFehler.length ? 1 : 0);
})().catch((err) => {
  console.error(`\n${R}Das Werkzeug selbst ist gescheitert:${X} ${err && err.stack}`);
  process.exit(2);
});
