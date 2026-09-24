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
 * Jeder Schritt wird am Ende im Tresor nachgesehen, nicht nur am Bildschirm.
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
const zug = (teile, pauseMs) => ({ sse: teile.flat(), pauseMs });

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-os-chatbeweis-'));
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, claudeBasis: statist.url });
  await seedIfEmpty(app);
  if (typeof app.loadModules === 'function') await app.loadModules({}).catch(() => {});
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const store = app.store;

  const { chromium: browserTyp } = await import(pw);
  const exe = findChromium();
  const browser = await browserTyp.launch(exe ? { executablePath: exe } : {});
  const konsole = [];

  async function neueSeite({ breite = 1440, hoehe = 900, finger = false, rechte = true, ohneClipboard = false } = {}) {
    const c = await browser.newContext({
      viewport: { width: breite, height: hoehe },
      colorScheme: 'dark',
      hasTouch: finger,
      isMobile: false,
      deviceScaleFactor: finger ? 2 : 1,
      permissions: rechte ? ['clipboard-read', 'clipboard-write'] : [],
      // Der Service Worker laedt die Seite beim ersten Besuch einmal neu
      // (controllerchange, web/app.js). Das ist gewollt, wuerde hier aber
      // mitten in eine Messung fallen.
      serviceWorkers: 'block',
    });
    await c.addInitScript(() => { try { localStorage.setItem('neural-os:theme', 'dark'); } catch { /* egal */ } });
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
    const p = await c.newPage();
    p.on('pageerror', (e) => konsole.push(e.message.slice(0, 160)));
    p.on('console', (m) => { if (m.type() === 'error') konsole.push(m.text().slice(0, 160)); });
    return { c, p };
  }

  const nachrichten = (chatId) => store.list('message', { filter: { chatId } }).items
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.data.ordinal || 0) - (b.data.ordinal || 0)));
  const chatIdAus = (p) => { const m = /[?&]id=([^&]+)/.exec(p.url()); return m ? decodeURIComponent(m[1]) : null; };
  const strom = (p) => p.waitForFunction(() => !document.querySelector('.cv-composer__senden.is-stopp'), null, { timeout: 20000 });
  const letzteAntwort = (p) => p.locator('.cv-msg--bot').last();

  let fehlgeschlagen = null;
  try {
    /* ============================================ 1 · Verbinden, Vorlage */
    console.log(`\n${BO}1 · Verbinde Claude, dann die Vorlage nachgestellt (1440×900)${X}`);
    const { c, p } = await neueSeite();
    // Offline: Mit dem Statisten auf 127.0.0.1 laesst die Schleuse Claude
    // auch offline durch (loopback). Wie die Karte fuer einen echten
    // Offline-Stick aussieht, zeigt deshalb EINE nachgestellte Antwort von
    // GET /api/claude -- der Schalter darunter schaltet dann wirklich.
    const echtOffline = app.gate && app.gate.mode;
    await p.route('**/api/claude', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        verbunden: false, schluesselVorhanden: false, grundCode: 'offline', grund: 'Offline — Claude ist gerade nicht erreichbar.', netz: { modus: 'offline', erlaubt: false },
      }) });
    });
    await p.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    await p.locator('.cv-verbinden[data-grund="offline"]').waitFor({ timeout: 8000 });
    const offlineText = (await p.locator('.cv-verbinden').innerText()).replace(/\s+/g, ' ');
    check(/braucht Internet/.test(offlineText) && await p.getByRole('button', { name: 'Online schalten' }).count() === 1,
      'Offline: ein Satz, dass die KI Internet braucht, und der Schalter', offlineText.slice(0, 110));
    await foto(p, 'offline-1440');
    await p.unroute('**/api/claude');
    await p.getByRole('button', { name: 'Online schalten' }).click();
    await p.locator('.cv-verbinden[data-grund="kein-schluessel"]').waitFor({ timeout: 8000 });
    check(echtOffline === 'offline' && app.gate.mode === 'online', '„Online schalten“ schaltet wirklich (Netzmodus im Server: online)', `${echtOffline} → ${app.gate.mode}`);
    await p.locator('.cv-verbinden').waitFor({ timeout: 8000 });
    const karte = (await p.locator('.cv-verbinden').innerText()).replace(/\s+/g, ' ');
    check(/Verbinde Claude/.test(karte) && /console\.anthropic\.com/.test(karte),
      'Ohne Schlüssel: statt eines leeren Chats die Karte „Verbinde Claude“ mit dem Satz, wo es ihn gibt', karte.slice(0, 120));
    check(await p.locator('.cv-verbinden input').count() === 1, 'genau ein Feld');
    await foto(p, 'verbinde-claude-1440');

    await p.locator('.cv-verbinden input').fill('sk-ant-falsch-0000000000000000000000');
    await p.locator('.cv-verbinden button[type="submit"]').click();
    await p.locator('.cv-verbinden__fehler:not([hidden])').waitFor({ timeout: 8000 });
    check(!!(await p.locator('.cv-verbinden__fehler').innerText()).trim(), 'Ein falscher Schlüssel wird mit einem Satz abgelehnt',
      (await p.locator('.cv-verbinden__fehler').innerText()).trim());
    await p.locator('.cv-verbinden input').fill(SCHLUESSEL);
    await p.locator('.cv-verbinden button[type="submit"]').click();
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
        textLang(0, 'Gerne. Ich analysiere den aktuellen Stand, identifiziere die nächsten Schritte und erstelle eine kompakte Zusammenfassung für dich.\n\n- [x] Projektkontext analysiert\n- [x] Relevante Aufgaben identifiziert\n- [x] Termine und Ressourcen geprüft\n- [x] Zusammenfassung erstellt'),
        B.text(1, '', { zitate: [{ type: 'web_search_result_location', url: 'https://www.example.org/produktlaunch-checkliste', title: 'Produktlaunch: die Checkliste für 2026', cited_text: 'Checkliste', encrypted_index: 'e1' }] }),
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
    check(await antwortA.locator('.cv-denken summary').count() === 1, 'Der Gedankengang ist einklappbar („Gedankengang“)');
    const vorschlaege = await p.locator('.cv-vorschlaege button').count();
    check(vorschlaege >= 1 && vorschlaege <= 3, 'Nach der fertigen Antwort bis zu drei Vorschlags-Knöpfe', `${vorschlaege}: ${(await p.locator('.cv-vorschlaege').innerText().catch(() => '')).replace(/\s+/g, ' ')}`);
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
    const optionen = p.locator('.cv-frage[data-zustand="offen"] .cv-option');
    check(await optionen.count() === 4, 'Die Rückfrage zeigt drei Optionen und „Eigene Antwort …“', (await optionen.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | '));
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
    check(await erste.locator('.cv-option.is-gewaehlt').count() === 1 && /Eine Woche/.test(await erste.locator('.cv-option.is-gewaehlt').innerText()),
      'Die beantwortete Karte bleibt im Verlauf und zeigt die gewählte Antwort');

    const f2 = p.locator('.cv-frage[data-frage="toolu_f2"]');
    const anfragenVorMehrfach = statist.anfragen.length;
    await f2.locator('.cv-option', { hasText: 'Antike' }).click();
    await f2.locator('.cv-option.is-gewaehlt', { hasText: 'Antike' }).waitFor({ timeout: 3000 });
    await f2.locator('.cv-option', { hasText: 'Essen' }).click();
    await f2.locator('.cv-option.is-gewaehlt', { hasText: 'Essen' }).waitFor({ timeout: 3000 });
    check(await f2.locator('.cv-option.is-gewaehlt').count() === 2 && statist.anfragen.length === anfragenVorMehrfach, 'Mehrfachauswahl: Antippen markiert, statt sofort zu senden',
      `${await f2.locator('.cv-option.is-gewaehlt').count()} markiert, nichts gesendet`);
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
    await f3.locator('.cv-option--eigen').click();
    const eigen = f3.locator('.cv-frage__eigen input');
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
    await letzteAntwort(p).locator('.cv-aktion[aria-label="Neu antworten"]').click();
    await warteBis(async () => /Neue Fassung/.test(await letzteAntwort(p).innerText().catch(() => '')), { timeout: 8000 });
    await strom(p);
    const nachNeu = nachrichten(chatIdAus(p));
    check(nachNeu[nachNeu.length - 1].data.content === 'Neue Fassung: kurz und vollständig.' && nachNeu.filter((m) => m.data.role === 'assistant').length === nachrichten(chatIdAus(p)).filter((m) => m.data.role === 'user').length,
      '„Neu antworten“ ersetzt die letzte Antwort (die alte liegt im Papierkorb)', `${nachNeu.length} Nachrichten`);

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
      await karte2.scrollIntoViewIfNeeded();
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
      const hoehen = await p3.locator('.cv-frage .cv-option').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      check(hoehen.length === 4 && hoehen.every((x) => x >= 44), 'Optionen sind für den Finger groß genug (≥ 44 px)', hoehen.join(', '));
      const klein = await p3.evaluate(() => [...document.querySelectorAll('.cv button, .cv a[href], .cv input, .cv textarea')]
        .filter((e) => e.offsetWidth && getComputedStyle(e).visibility !== 'hidden')
        .map((e) => [e.className.baseVal === undefined ? e.className : '', Math.round(e.getBoundingClientRect().height)])
        .filter(([, hgt]) => hgt < 44));
      check(klein.length === 0, 'Kein Bedienelement im Chat unter 44 px', klein.slice(0, 5).map(([k, hgt]) => `${String(k).split(' ')[0]} ${hgt}`).join(' · '));
      await foto(p3, 'ipad-rueckfrage-1180');
      statist.weiter(zug([B.start(), textLang(0, '## Dein Lernplan\n\nEine Stunde am Tag reicht, wenn du dranbleibst.\n\n| Tag | Thema |\n|---|---|\n| Mo | Brüche |\n| Di | Gleichungen |\n| Mi | Wiederholen |\n\n- [x] Themen gesammelt\n- [x] Zeit eingeplant'), B.ende('end_turn')], 10));
      await p3.locator('.cv-frage .cv-option', { hasText: 'Eine Stunde' }).tap();
      await p3.waitForFunction(() => document.querySelector('.cv-frage[data-zustand="beantwortet"]'), null, { timeout: 8000 });
      await p3.waitForFunction(() => !document.querySelector('.cv-composer__senden.is-stopp'), null, { timeout: 15000 });
      await p3.waitForTimeout(500);
      check(await p3.locator('.cv-frage .cv-option.is-gewaehlt', { hasText: 'Eine Stunde' }).count() === 1, 'Antippen schickt die Antwort; die Karte zeigt sie danach');
      check(await p3.locator('.cv-md table').count() === 1, 'Tabellen werden sauber gesetzt');
      await foto(p3, 'ipad-antwort-1180');
      await c3.close();
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
  fs.rmSync(home, { recursive: true, force: true });

  const gut = ergebnisse.filter((e) => e.ok).length;
  const schlecht = ergebnisse.length - gut;
  console.log(`\n${BO}Ergebnis${X}  ${G}${gut} funktionieren${X}${schlecht ? `  ${R}${schlecht} nicht${X}` : ''}  ${D}${bilder.length} Bilder in ${OUT}${X}`);
  const echteFehler = konsole.filter((k) => !/Failed to load resource/.test(k));
  if (echteFehler.length) {
    console.log(`${Y}Konsolenfehler (${echteFehler.length}):${X}`);
    for (const k of [...new Set(echteFehler)].slice(0, 8)) console.log(`  ${Y}·${X} ${k}`);
  }
  process.exit(fehlgeschlagen || schlecht || echteFehler.length ? 1 : 0);
})().catch((err) => {
  console.error(`\n${R}Das Werkzeug selbst ist gescheitert:${X} ${err && err.stack}`);
  process.exit(2);
});
