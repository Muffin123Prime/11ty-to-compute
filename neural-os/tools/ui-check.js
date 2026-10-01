'use strict';

/**
 * Die Oberfläche, im echten Browser, mit echten Klicks.
 *
 *   node tools/ui-check.js              alles
 *   node tools/ui-check.js --views      nur: laden alle Ansichten fehlerfrei?
 *   node tools/ui-check.js --keep       Bildschirmfotos behalten und Pfad nennen
 *
 * Warum es dieses Werkzeug gibt
 * -----------------------------
 * `npm test` prüft den Server, `npm run check` prüft die Schnittstelle. Beide
 * können eine Ansicht nicht sehen. Genau dort sind hier zwei Fehler entstanden,
 * die kein einziger Test gefunden hätte: ein erfundener CSS-Name, der eine
 * ganze Ansicht ungestylt rendert, und ein Knopf, der zwar da ist, aber nichts
 * in den Tresor schreibt. Beides sieht in einem Unit-Test völlig gesund aus.
 *
 * Deshalb prüft dieses Werkzeug nicht, ob etwas gerendert wurde, sondern ob
 * ein Klick **bis in den Tresor durchschlägt**: nach „Übernehmen" muss die
 * Aufgabe wirklich im Speicher stehen, nach dem Einschalten eines Zeitplans
 * muss `enabled` wirklich `true` sein. Alles andere wäre eine Oberfläche, die
 * beim Zusehen funktioniert.
 *
 * Zur Abhängigkeit, ehrlich gesagt
 * --------------------------------
 * Neural OS selbst hat **null** Abhängigkeiten und behält sie. Dieses Werkzeug
 * hier ist kein Teil der Anwendung: es braucht ein global installiertes
 * Playwright (`npm i -g playwright`) und läuft sonst gar nicht — es tut dann
 * nicht so, als sei alles in Ordnung, sondern sagt, dass es nichts geprüft hat.
 * Du brauchst es nicht, um Neural OS zu benutzen.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const G = '\u001b[32m'; const R = '\u001b[31m'; const Y = '\u001b[33m';
const D = '\u001b[2m'; const B = '\u001b[1m'; const X = '\u001b[0m';

/**
 * Die Ansichten der neuen Schale (web/app.js, VIEWS). Heute, Vorschlaege,
 * Automatik, Zeitachse, Abgleich und die Suchseite gibt es nicht mehr
 * (Entscheidung des Nutzers); dass ihre alten Adressen in den Chat fuehren,
 * prueft Abschnitt 4.
 */
const ALL_VIEWS = [
  'chat', 'kalender', 'notes', 'projects', 'agents', 'graph', 'workshop', 'settings',
  'network', 'stick',
];
// „backup" steht noch in VIEWS, ist aber nur noch eine Weiterleitung in den
// Bereich Stick (web/views/backup.js). Dass sie dorthin fuehrt, prueft
// Abschnitt 9 -- als eigene Ansicht gezaehlt wuerde sie den Stick zweimal pruefen.

/** Die Eintraege der Leiste, in der Reihenfolge der Vorlage (docs/vorlage/app.png). */
const LEISTE = ['Neuer Chat', 'Kalender', 'Notizen', 'Projekte', 'Agenten', 'Gehirn', 'Werkstatt', 'Einstellungen'];

/** Die Kacheln der rechten Spalte, von oben nach unten. */
const KACHELN = ['agenten', 'kalender', 'notizen', 'gehirn'];

let failed = 0;
let unclear = 0;

function ok(what, detail) {
  console.log(`  ${G}✓${X} ${what}${detail ? `  ${D}${String(detail).slice(0, 110)}${X}` : ''}`);
}
function bad(what, detail) {
  failed++;
  console.log(`  ${R}✗${X} ${what}${detail ? `  ${D}${String(detail).slice(0, 200)}${X}` : ''}`);
}
function hmm(what, detail) {
  unclear++;
  console.log(`  ${Y}?${X} ${what}${detail ? `  ${D}${String(detail).slice(0, 160)}${X}` : ''}`);
}
function check(condition, what, detail) {
  if (condition) ok(what, detail); else bad(what, detail);
}

const { findPlaywright, findChromium } = require('./lib/browser');

async function main() {
  const args = process.argv.slice(2);
  const onlyViews = args.includes('--views');
  const keep = args.includes('--keep');

  console.log(`\n${B}Neural OS · Oberflächenprüfung${X}`);
  console.log(`${D}Echter Browser, echte Klicks. Geprüft wird, ob ein Klick bis in den Tresor wirkt.${X}`);

  const pwPath = findPlaywright();
  if (!pwPath) {
    console.log(`\n${Y}Playwright ist nicht installiert — es wurde nichts geprüft.${X}`);
    console.log(`${D}Neural OS braucht es nicht; dieses Prüfwerkzeug schon: npm i -g playwright${X}\n`);
    process.exit(2);
  }
  const chromium = findChromium();
  const { chromium: pw } = await import(pwPath);

  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-shots-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-'));
  const { createApp, seedIfEmpty } = require('../src/app');
  // Wo die Stick-Suche nachsieht: nur hier, sonst zaehlte, was an diesem
  // Pruefrechner unter /mnt haengt, als „Leerer Stick“.
  const stickWelt = new Set();
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', kopplung: { einhaengepunkte: () => [...stickWelt] } });
  await seedIfEmpty(app);
  await app.loadModules({});
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const store = app.store;

  // Etwas Material, damit keine Ansicht nur ihren Leerzustand zeigt.
  const text = 'Erst den Wassertank leeren. Dann Entkalker einfüllen. Zwei Durchläufe.';
  store.create('note', { title: 'Maschine entkalken', body: text });
  store.create('note', { title: 'Maschine entkalken (Kopie)', body: text });
  store.create('note', { title: 'Küchenplan', body: '- [ ] Dichtung nachbestellen' });
  for (let i = 0; i < 60; i++) {
    store.create('note', {
      title: `Notiz ${i}`,
      body: `Verweist auf [[Notiz ${(i + 1) % 60}]] und [[Maschine entkalken]].`,
      tags: [i % 3 ? 'alltag' : 'technik'],
    });
  }
  if (app.graph && app.graph.scanAll) app.graph.scanAll(store, {});
  await store.flush();

  const browser = await pw.launch(chromium ? { executablePath: chromium } : {});

  try {
    /* ------------------------------------------ 0. Nur echte Marken benutzen */
    console.log(`\n${B}0 · Ansichten und Kacheln benutzen nur Marken, die es gibt${X}`);
    pruefeMarken();

    /* ---------------------------------------- 1. Jede Ansicht, hell + dunkel */
    console.log(`\n${B}1 · Jede Ansicht lädt, hell und dunkel${X}`);
    // Die Darstellung wird ueber den gemerkten Wert gesetzt, nicht ueber die
    // Systemvorgabe: dunkel ist die Voreinstellung der Anwendung und folgt
    // dem System gar nicht -- "hell" hiesse sonst, zweimal dunkel zu pruefen.
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: theme });
      // Gemerkt wird je KI (web/lib/lokal.js): neural-os:<kiId>:design.
      await context.addInitScript(([k, t]) => { try { localStorage.setItem(k, t); } catch { /* egal */ } }, [`neural-os:${app.ki.id}:design`, theme]);
      const problems = [];
      for (const view of ALL_VIEWS) {
        const page = await context.newPage();
        const errors = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        try {
          await page.goto(`${base}/#/${view}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(500);
          await dismissWelcome(page);
          await page.waitForTimeout(500);
          const info = await page.evaluate(() => {
            const main = document.querySelector('main') || document.body;
            const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [];
            return {
              chars: (main.innerText || '').trim().length,
              overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
              canvas: !!main.querySelector('canvas'),
              hell: Number(bg[0]) > 128,
            };
          });
          if (errors.length) problems.push(`${view}: ${errors[0].slice(0, 120)}`);
          // Wirkt die Wahl wirklich? Ein heller Durchlauf auf dunklem Grund
          // haette sonst zweimal dasselbe geprueft.
          else if (info.hell !== (theme === 'light')) problems.push(`${view}: Grund ist nicht ${theme === 'light' ? 'hell' : 'dunkel'}`);
          // Eine Leinwand hat naturgemäß wenig Text; das ist kein leerer Bildschirm.
          else if (info.chars < 40 && !info.canvas) problems.push(`${view}: fast leer (${info.chars} Zeichen)`);
          else if (info.overflow) problems.push(`${view}: waagerechter Scrollbalken`);
          if (keep) await page.screenshot({ path: path.join(shotDir, `${view}-${theme}.png`) });
        } catch (err) {
          problems.push(`${view}: ${err.message.slice(0, 120)}`);
        }
        await page.close();
      }
      check(!problems.length, `${ALL_VIEWS.length} Ansichten im ${theme === 'dark' ? 'dunklen' : 'hellen'} Modus`,
        problems.join(' · ') || 'keine Konsolenfehler, kein waagerechter Scrollbalken');
      await context.close();
    }

    /* ------------------------------------------------ 2. Schmales Fenster */
    console.log(`\n${B}2 · Schmales Fenster (1000 px)${X}`);
    const narrow = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const narrowProblems = [];
    for (const view of ALL_VIEWS) {
      const page = await narrow.newPage();
      await page.goto(`${base}/#/${view}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);
      await dismissWelcome(page);
      await page.waitForTimeout(300);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) {
        narrowProblems.push(view);
      }
      await page.close();
    }
    check(!narrowProblems.length, 'Keine Ansicht erzwingt waagerechtes Scrollen',
      narrowProblems.length ? `betroffen: ${narrowProblems.join(', ')}` : `${ALL_VIEWS.length} Ansichten`);
    await narrow.close();

    /* --------------------------------------------- 3. iPad, mit dem Finger */
    console.log(`\n${B}3 · iPad: mit dem Finger bedienbar${X}`);
    await pruefeIPad(browser, base);

    if (onlyViews) return;

    /* ------------------------------------------- 4. Die Schale selbst */
    console.log(`\n${B}4 · Die Schale: Leiste, Kopf, rechte Spalte, einklappen${X}`);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    let claudeFehlt = false;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // GET /api/claude kommt aus dem Bereich Claude-Unterbau (Vertrag 5).
      // Solange es die Route nicht gibt, fragt die Schale im Online-Modus
      // einmal, bekommt 404 und sagt danach nur "Online", nie "verbunden".
      // Das ist ein bekannter, benannter Zustand und kein Fehler der
      // Oberflaeche -- er steht unten als eigene, offene Zeile.
      const ort = m.location && m.location();
      if (ort && /\/api\/claude$/.test(ort.url || '')) {
        claudeFehlt = true;
        return;
      }
      errors.push(m.text());
    });
    await pruefeSchale(page, base, store, app);

    /* ------------------------------------------- 4b. Das Gehirn */
    console.log(`\n${B}4b · Das Gehirn: ein Netz, das zur Ruhe kommt, und ein Antippen, das wirkt${X}`);
    await pruefeGehirn(page, base, store);

    /* --------------------- 4c. Das Gehirn: leer, und bei 10.000 Eintraegen */
    console.log(`\n${B}4c · Das Gehirn: leer lädt es ein, bei 10.000 Einträgen bleibt es flüssig${X}`);
    await pruefeGehirnGross(browser);

    /* ----------- 4d. Das Gehirn: Import, Unterthemen, Karte, Begriffe */
    console.log(`\n${B}4d · Das Gehirn: importiertes Wissen, Unterthemen als Bereiche, Karte mit Adresse${X}`);
    await pruefeGehirnUnterthemen(browser);

    /* ------------- 4e. Pruefrunde 2: Gehirn und Notizen bleiben behoben */
    console.log(`\n${B}4e · Gehirn und Notizen: was die Prüfer fanden, bleibt behoben${X}`);
    await pruefePruefrunde2(browser);

    /* ------------------------ 5. Schnellerfassung von ueberall aus */
    console.log(`\n${B}5 · Schnell festhalten, ohne den Bereich zu wechseln${X}`);
    // Absichtlich aus dem Gehirn heraus: der ganze Sinn ist, dass man nicht
    // erst irgendwohin navigieren muss.
    await page.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    await dismissWelcome(page);
    const notizenVorher = store.count('note');
    await page.keyboard.press('Control+Shift+KeyN');
    await page.waitForTimeout(500);
    if (!(await page.getByText('Schnell festhalten').count())) {
      bad('Strg+Umschalt+N öffnet die Schnellerfassung');
    } else {
      ok('Strg+Umschalt+N öffnet die Schnellerfassung', 'aus dem Gehirn heraus');
      await page.keyboard.type('Espresso nachbestellen #kaffee');
      await page.waitForTimeout(300);
      const vorschau = await page.locator('body').innerText();
      check(/Wird angelegt als Notiz/.test(vorschau), 'Die Vorschau sagt vorher, was daraus wird');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1300);
      check(store.count('note') === notizenVorher + 1, 'Eine Notiz steht wirklich im Tresor',
        `${notizenVorher} → ${store.count('note')}`);
      const neu = store.all('note').find((n) => n.data.title === 'Espresso nachbestellen #kaffee');
      check(!!neu && (neu.data.tags || []).includes('kaffee'), 'mit dem erkannten Schlagwort',
        neu ? JSON.stringify(neu.data.tags) : 'Notiz nicht gefunden');
    }

    /* --------------- 6. Beobachtete Ordner: erst ansehen, dann aufnehmen */
    console.log(`\n${B}6 · Ein beobachteter Ordner nimmt erst auf, wenn er eingeschaltet ist${X}`);
    const eingang = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-eingang-'));
    fs.writeFileSync(path.join(eingang, 'notiz.md'), '# Espresso\n\nNeun bar, 93 Grad.\n');
    fs.writeFileSync(path.join(eingang, 'liste.txt'), 'Bohnen\nFilter\n');
    try {
      await page.goto(`${base}/#/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(900);
      await dismissWelcome(page);
      await page.waitForTimeout(600);
      check(/Beobachtete Ordner/.test(await page.locator('main').innerText()),
        'Der Abschnitt steht in den Einstellungen');

      const angelegt = await page.evaluate(async ([b, p]) => {
        const res = await fetch(`${b}/api/watch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-neural-os': '1' },
          body: JSON.stringify({ path: p, label: 'Eingang' }),
        });
        return res.status;
      }, [base, eingang]);
      check(angelegt === 200, 'Ein Ordner lässt sich anlegen', `HTTP ${angelegt}`);

      const ordner = store.all('watch')[0];
      check(ordner && ordner.data.enabled === false, 'und ist ab Werk AUS',
        ordner ? `enabled=${ordner.data.enabled}` : 'keiner gefunden');

      if (ordner) {
        const vorher = store.count('file');
        const trocken = await page.evaluate(async ([b, id]) => {
          const res = await fetch(`${b}/api/watch/${id}/scan`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-neural-os': '1' },
            body: JSON.stringify({ dryRun: true }),
          });
          return res.json();
        }, [base, ordner.id]);
        check(store.count('file') === vorher, '„Erst ansehen" legt wirklich nichts an',
          `gefunden: ${trocken && trocken.gefunden}, Dateien unverändert bei ${vorher}`);

        await page.evaluate(async ([b, id]) => {
          await fetch(`${b}/api/watch/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-neural-os': '1' },
            body: JSON.stringify({ enabled: true }),
          });
          await fetch(`${b}/api/watch/${id}/scan`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-neural-os': '1' },
            body: JSON.stringify({}),
          });
        }, [base, ordner.id]);
        check(store.count('file') > vorher, 'Eingeschaltet nimmt er die Dateien wirklich auf',
          `${vorher} → ${store.count('file')}`);
      }
    } finally {
      fs.rmSync(eingang, { recursive: true, force: true });
    }

    /* ------------------------------- 7. Ein Chat, ehrlich ohne KI */
    console.log(`\n${B}7 · Ein offener Chat sagt ohne KI, warum nichts kommt${X}`);
    const probe = store.create('chat', { title: 'Probe' });
    await store.flush();
    await page.goto(`${base}/#/chat?id=${probe.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const chatText = await page.locator('main').innerText();
    // Die KI ist Gemini (kostenlos) oder Claude. Ohne Schluessel (so laeuft
    // diese Pruefung) steht statt eines leeren Chats die Karte "Verbinde eine
    // KI": oben gross Google mit EINEM Feld und dem Satz, wo es den Schluessel
    // gibt (und dass Google Inhalte nutzen darf); Claude darunter zugeklappt.
    // Den ganzen Weg mit Schluessel (Statist), Rueckfragen, Kopieren, Stopp
    // und Bearbeiten prueft tools/chat-beweis.js im Browser.
    check(/Verbinde eine KI/.test(chatText) && /Kostenlos mit Google/.test(chatText)
      && /aistudio\.google\.com\/apikey/.test(chatText) && /Google darf Inhalte zur Verbesserung nutzen/.test(chatText)
      && await page.locator('.cv-verbinden input[aria-label="Google-Schlüssel"]').count() === 1,
    'Ohne KI: „Verbinde eine KI“ – Google zuerst, ein Feld, der Satz, wo es den Schlüssel gibt', chatText.replace(/\s+/g, ' ').slice(0, 90));
    // Zugeklappt heisst: die Ueberschrift ist zu lesen, der Claude-Satz noch nicht.
    check(await page.locator('.cv-verbinden details.cv-verbinden__mehr:not([open])').count() === 1
      && /Oder Claude \(kostet pro Nutzung\)/.test(chatText)
      && !/console\.anthropic\.com/.test(chatText),
    'Claude steht darunter zugeklappt: „Oder Claude (kostet pro Nutzung)“ – sein Satz erst nach dem Aufklappen');
    await page.locator('.cv-verbinden details.cv-verbinden__mehr > summary').click();
    await page.waitForTimeout(200);
    check(await page.locator('.cv-verbinden details.cv-verbinden__mehr[open]').count() === 1
      && await page.locator('.cv-verbinden input[aria-label="Claude-Schlüssel"]').isVisible()
      && /console\.anthropic\.com/.test(await page.locator('.cv-verbinden').innerText()),
    'Aufgeklappt: das Claude-Feld mit dem Satz, wo es den Schlüssel gibt');
    check(await page.locator('.cv-composer__feld').count() === 1 && await page.locator('.cv-composer__clip').count() === 1,
      'Das Eingabefeld ist eine Karte mit Büroklammer und rundem Senden-Knopf');
    check((await page.locator('.topbar__title').innerText()).trim() !== 'Neuer Chat',
      'Der Kopf zeigt bei einem offenen Chat nicht „Neuer Chat“',
      (await page.locator('.topbar__title').innerText()).trim());
    check(await page.locator('.rail__chat.is-active', { hasText: 'Probe' }).count() === 1,
      'und der Chat ist in „Zuletzt“ markiert');

    /* --------- 7b. Eine gespeicherte Antwort baut ihre Oberflaeche, ohne KI */
    // Aus dem Tresor, ohne KI: ```ui-Bloecke werden Bausteine (auch eine
    // Ebene verschachtelt), Tabellen sortier- und filterbar, Codebloecke
    // bekommen ihre Leiste, die Antwort ihre Aktionsleiste und Fassungen
    // (docs/ANTWORT-BAUSTEINE.md). Bedient wird, was ohne KI geht: Abhaken
    // (PUT …/ui, im Tresor), Sortieren und Filtern, Fassung blaettern,
    // Vergleichen, Wiederherstellen (PATCH …/version, im Tresor). Den Rest --
    // Umwandeln, Neu erstellen, Ausfuehren -- beweist tools/chat-beweis.js.
    console.log(`\n${B}7b · Eine gespeicherte Antwort baut ihre Oberfläche – ohne KI${X}`);
    const bsChat = store.create('chat', { title: 'Lernplan' });
    const uiBlock = (spec) => '```ui\n' + JSON.stringify(spec) + '\n```';
    const zeilen = ['Mo|Brüche|30', 'Di|Gleichungen|45', 'Mi|Wiederholen|60', 'Do|Geometrie|20', 'Fr|Prozente|35', 'Sa|Probeklausur|90', 'So|Pause|0', 'Mo|Brüche II|25'];
    const tabelle = '| Tag | Thema | Minuten |\n|---|---|---|\n' + zeilen.map((z) => `| ${z.split('|').join(' | ')} |`).join('\n');
    const fassungAlt = '## Dein Plan\n\nEine Stunde am Tag reicht.\n\n- Brüche\n- Gleichungen';
    const fassungNeu = `## Dein Plan\n\nEine halbe Stunde am Tag reicht, wenn du dranbleibst.\n\n${uiBlock({ typ: 'checkliste', titel: 'Diese Woche', punkte: ['Brüche üben', 'Gleichungen lösen', 'Probeklausur'] })}\n\n${tabelle}\n\n${uiBlock({ typ: 'tabs', tabs: [{ titel: 'Montag', inhalt: 'Brüche kürzen und erweitern.' }, { titel: 'Dienstag', inhalt: `Gleichungen.\n\n${uiBlock({ typ: 'fortschritt', titel: 'Geschafft', wert: 2, ziel: 5 })}` }] })}\n\nSo rechnest du die Summe:\n\n\`\`\`js\nconst minuten = [30, 45, 60];\nconsole.log(minuten.reduce((a, b) => a + b, 0));\n\`\`\``;
    const jetztIso = new Date().toISOString();
    store.create('message', { chatId: bsChat.id, role: 'user', content: 'Mach mir einen Lernplan mit Checkliste', ordinal: 1 });
    const bsAntwort = store.create('message', {
      chatId: bsChat.id, role: 'assistant', status: 'complete', content: fassungNeu, ordinal: 2, version: 1,
      versionen: [{ inhalt: fassungAlt, at: jetztIso, art: 'original' }, { inhalt: fassungNeu, at: jetztIso, art: 'umgewandelt', anweisung: 'checkliste' }],
    });
    await store.flush();
    await page.goto(`${base}/#/chat?id=${bsChat.id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.bs[data-baustein="checkliste"]').waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    const bsMsg = page.locator('.cv-msg--bot').last();
    const bsTypen = await bsMsg.locator('.bs[data-baustein]').evaluateAll((els) => els.map((e) => e.dataset.baustein));
    check(bsTypen.join(',') === 'checkliste,tabs' && !/"typ"/.test(await bsMsg.innerText()),
      '```ui-Blöcke einer gespeicherten Antwort stehen als Bausteine da (Checkliste, Reiter) – nirgends JSON', bsTypen.join(','));
    await bsMsg.locator('.bs[data-baustein="checkliste"] .bs-check__text').first().click();
    check(/1 von 3/.test(await bsMsg.locator('.bs[data-baustein="checkliste"]').innerText()), 'Abhaken zählt „1 von 3“ mit Balken');
    let uiSatz = null;
    for (let i = 0; i < 40 && !uiSatz; i += 1) {
      await page.waitForTimeout(100);
      const m = store.get(bsAntwort.id);
      uiSatz = m && m.data.ui && m.data.ui['1'] && m.data.ui['1'].b0 ? m.data.ui['1'] : null;
    }
    check(!!uiSatz && Array.isArray(uiSatz.b0.erledigt) && uiSatz.b0.erledigt.includes(0), 'und der Zustand liegt im Tresor – je Fassung und Baustein (PUT …/ui)', JSON.stringify(uiSatz));
    await bsMsg.getByRole('tab', { name: 'Dienstag' }).click();
    check(await bsMsg.locator('.bs[data-baustein="tabs"] .bs[data-baustein="fortschritt"]').count() === 1 && /2 von 5/.test(await bsMsg.locator('.bs[data-baustein="tabs"]').innerText()),
      'Ein Reiter zeigt einen verschachtelten Baustein (Fortschritt „2 von 5“)');
    const tb = bsMsg.locator('.cv-md .tb').first();
    check(await tb.locator('.tb-sort').count() === 3 && await tb.locator('.tb-filter__feld').count() === 1,
      'Die Markdown-Tabelle ist sortierbar (Kopf aus Knöpfen) und hat ab 7 Zeilen ein Filterfeld');
    await tb.locator('.tb-sort', { hasText: 'Minuten' }).click();
    await page.waitForTimeout(200);
    const sortiert = (await tb.locator('tbody tr:not(.tb-leer) td:first-child').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    check(sortiert[0] === 'So' && sortiert[sortiert.length - 1] === 'Sa', 'Klick auf „Minuten“ sortiert als Zahl (0 zuerst, 90 zuletzt)', sortiert.join(','));
    await tb.locator('.tb-filter__feld').fill('brueche');
    await page.waitForTimeout(250);
    const gefiltert = (await tb.locator('tbody tr:not(.tb-leer):not([hidden])').evaluateAll((trs) => trs.filter((tr) => tr.offsetParent !== null).map((tr) => tr.querySelector('td:nth-child(2)').textContent.trim())));
    check(gefiltert.length === 2 && gefiltert.every((t) => /Brüche/.test(t)) && /2 von 8/.test(await tb.innerText()),
      'Der Filter „brueche“ findet „Brüche“ und „Brüche II“ (Umlaute egal) und sagt „2 von 8“', gefiltert.join(', '));
    await tb.locator('.tb-filter__feld').fill('');
    const codeLeiste = (await bsMsg.locator('.cv-code__leiste').innerText()).replace(/\s+/g, ' ').trim();
    check(/Bearbeiten.*Ausführen.*Erklären.*Fehler suchen/.test(codeLeiste) && /javascript/i.test(await bsMsg.locator('.md-code__lang').innerText()),
      'Der Codeblock trägt seine Sprache und die Leiste Bearbeiten · Ausführen · Erklären · Fehler suchen', codeLeiste);
    check(await bsMsg.locator('.md-heading--2 .cv-frage-dazu').count() === 1, 'Die Überschrift trägt „Frage dazu“');
    await bsMsg.hover();
    const aktionen = await bsMsg.locator('.cv-aktionen .cv-aktion').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    check(aktionen.includes('Antwort kopieren') && aktionen.includes('Neu erstellen') && aktionen.includes('Umwandeln') && /2\/2/.test(await bsMsg.locator('.cv-fassungen__stand').innerText()),
      'Die Leiste unter der Antwort: Kopieren · Neu erstellen · Umwandeln · Fassungen „2/2“', aktionen.filter(Boolean).join(' · '));
    await bsMsg.locator('.cv-aktion[aria-label="Vorige Fassung"]').click();
    await page.waitForTimeout(300);
    check(/Fassung 1 von 2 · Original – nur angesehen/.test(await bsMsg.innerText()) && await bsMsg.getByRole('button', { name: 'Wiederherstellen' }).count() === 1
      && await bsMsg.locator('.bs[data-baustein]').count() === 0,
    '‹ blättert zur ersten Fassung: nur angesehen, ohne die Bausteine der zweiten, mit [Wiederherstellen]');
    await bsMsg.locator('.cv-aktion[aria-label="Vergleichen"]').click();
    await page.waitForTimeout(300);
    const vergleichZahlen = (await bsMsg.locator('.cv-vergleich__zahlen').innerText().catch(() => '')).trim();
    check(await bsMsg.locator('.cv-vergleich del').count() >= 1 && await bsMsg.locator('.cv-vergleich ins').count() >= 1 && /Wörter weg/.test(vergleichZahlen),
      '[Vergleichen] zeigt den wortweisen Unterschied (weg / neu, gezählt)', vergleichZahlen);
    await bsMsg.getByRole('button', { name: 'Wiederherstellen' }).click();
    let wieder = null;
    for (let i = 0; i < 40 && !wieder; i += 1) {
      await page.waitForTimeout(100);
      const m = store.get(bsAntwort.id);
      wieder = m && m.data.version === 0 ? m : null;
    }
    check(!!wieder && wieder.data.content === fassungAlt && wieder.data.versionen.length === 2, '[Wiederherstellen] macht Fassung 1 aktiv (PATCH …/version) – im Tresor, keine Fassung geht verloren');
    await page.waitForTimeout(300);
    check(/1\/2/.test(await bsMsg.locator('.cv-fassungen__stand').innerText()) && await bsMsg.locator('.cv-vergleich').count() === 0, 'und die Leiste sagt „1/2“');

    /* ------------- 8. Kalender, Notizwand, Projekte: bis in den Tresor */
    // Die alte Notizansicht mit Editor und "Zweiter Blick" gibt es nicht mehr:
    // die Notizen macht die KI, die Ansicht ist eine Wand zum Wiederfinden.
    // Geprueft wird, was man dort tut -- und ob es im Tresor ankommt.
    console.log(`\n${B}8 · Kalender, Notizen, Projekte: ein Klick wirkt im Tresor${X}`);
    await pruefeKalenderNotizenProjekte(page, base, store);

    /* ------------- 9. Stick: ein leerer Stick, [Neue KI], sichern, wiederherstellen */
    console.log(`\n${B}9 · Stick: ein leerer Stick bekommt mit einem Klick eine KI, „Jetzt sichern" legt wirklich etwas ab${X}`);
    // Der Punkt dieser Pruefung: eine gruene Meldung beweist gar nichts. Ein
    // Stick ist erst dann vorbereitet und eine Sicherung erst dann eine, wenn
    // danach Dateien auf der Platte liegen. Deshalb wird nach jedem Klick im
    // Dateisystem nachgesehen. Hier laeuft Neural OS vom Laptop, und hier
    // steckt kein echter Stick: ein leerer Ordner steht an seiner Stelle und
    // wird von Hand eingetragen -- der Weg, den die Ansicht anbietet, wenn die
    // Suche einen Stick nicht findet. Vom Stick aus prueft es Abschnitt 9b.
    const stickOrt = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-stick-'));
    /** Der Ordner, den der Klick wirklich angelegt hat -- nicht der getippte. */
    let geschrieben = null;
    try {
      await page.goto(`${base}/#/backup`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      check(/#\/stick$/.test(page.url()), 'Die alte Adresse #/backup führt in den Bereich „Stick“', page.url());

      const stickText = await page.locator('main').innerText();
      check(/Neural OS läuft von diesem Rechner/.test(stickText),
        'Vom Laptop aus sagt die Ansicht, dass Neural OS nicht vom Stick läuft');
      check(/Kein anderer Stick gefunden/.test(stickText),
        'Die Suche sagt ehrlich, dass sie keinen Stick fand');
      check(!/Modell|Ollama|llama/i.test(stickText), 'Vom Sprachmodell auf dem Stick ist nicht mehr die Rede');
      check(!/Beenden & abziehen/.test(stickText), 'Das alte „Beenden & abziehen“ ist weg (Beenden steht unten links)');
      check(/Zuletzt gesichert|Noch keine Sicherung/.test(stickText),
        'Neben „Jetzt sichern" steht still, wann zuletzt gesichert wurde');

      await page.locator('summary', { hasText: 'Ort von Hand eintragen' }).click();
      const ortFeld = page.getByLabel('Ort des Sticks');
      check(await ortFeld.count() === 1, 'Es gibt genau ein Feld für den Ort des Sticks');

      if (await ortFeld.count()) {
        await ortFeld.fill(stickOrt);
        await page.getByRole('button', { name: /^Prüfen$/ }).click();
        const reihe = page.locator('.stickv__reihe[data-art="leer"]');
        await reihe.first().waitFor({ timeout: 8000 }).catch(() => {});
        const reiheText = await reihe.first().innerText().catch(() => '');
        check(reiheText.startsWith(`Leerer Stick: ${stickOrt}`) && /frei/.test(reiheText),
          'Der Ordner heißt „Leerer Stick: … · … frei“', reiheText.split('\n')[0]);
        check(await reihe.getByRole('button', { name: /^Neue KI$/ }).count() === 1
          && await reihe.getByRole('button', { name: /^Mit dieser KI gekoppelt$/ }).count() === 1,
        'Daneben stehen [Neue KI] und [Mit dieser KI gekoppelt]');

        // --- [Neue KI]: ab Werk ist das Netz zu, also kommt die eine
        // Rueckfrage -- mit zwei Knoepfen, nicht mit einem Dialog.
        await reihe.getByRole('button', { name: /^Neue KI$/ }).click();
        const nurHier = page.getByRole('button', { name: /^Nur / });
        await nurHier.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        check(await page.getByRole('button', { name: /^Erlauben$/ }).count() === 1 && await nurHier.count() === 1,
          'Für Windows/Mac fragt der Knopf einmal – „Erlauben" oder „Nur dieses System"');
        if (await nurHier.count()) {
          await nurHier.first().click();
          // Waehrend der Arbeit: „Wird vorbereitet … 42 %“ -- gemessen, nicht erfunden.
          let laufSatz = '';
          for (let i = 0; i < 400 && !laufSatz; i++) {
            laufSatz = await page.locator('.stickv__lauf-text').first().innerText({ timeout: 200 }).catch(() => '');
            if (!laufSatz) {
              if (await page.locator('.stickv__fertig, .stickv__meldung').count()) break;
              await page.waitForTimeout(25);
            }
          }
          check(/^Wird vorbereitet … \d+ %$/.test(laufSatz), 'Während der Arbeit steht „Wird vorbereitet … 42 %“', laufSatz || 'nicht gesehen');
          await page.locator('.stickv__fertig, .stickv__meldung').first().waitFor({ timeout: 120000 }).catch(() => {});
          const fertigText = await page.locator('main').innerText();
          check(/Fertig\. Stick kann raus\./.test(fertigText), 'Danach steht dort „Fertig. Stick kann raus.“',
            fertigText.split('\n').find((z) => /Fertig/.test(z)) || fertigText.split('\n').find((z) => /Fehler|nicht/i.test(z)) || '');
          // Neuer Aufbau (Bauplan 2.10.4): Marker, Programm und Daten liegen
          // in Inhalt/; die Daten sind die Kennung der neuen KI (config.json).
          const inhalt = path.join(stickOrt, 'Inhalt');
          check(fs.existsSync(path.join(inhalt, 'neural-os.portable'))
            && fs.existsSync(path.join(inhalt, 'app', 'bin', 'neural-os.js'))
            && fs.existsSync(path.join(inhalt, 'data', 'config.json')),
          'und auf dem Stick liegen wirklich Programm, Laufzeit und die neue KI (in Inhalt/)',
          fs.readdirSync(stickOrt).join(', '));
          await page.waitForTimeout(600);
          const danach = page.locator('.stickv__reihe[data-art="fremd"]');
          const danachText = await danach.first().innerText().catch(() => '');
          check(/^Anderer Stick: /.test(danachText) && await danach.getByRole('button', { name: /^Koppeln$/ }).count() === 1,
            'Jetzt wohnt dort eine KI: „Anderer Stick: …“ mit [Koppeln]', danachText.split('\n')[0]);
        }

        // --- Jetzt sichern: Ziel ist der Stick im Feld.
        const sichernKnopf = page.getByRole('button', { name: /^Jetzt sichern/ });
        check(await sichernKnopf.count() === 1, 'Der Knopf „Jetzt sichern" ist da');
        if (await sichernKnopf.count()) {
          await sichernKnopf.first().click();
          const sicherungen = path.join(stickOrt, 'Sicherungen');
          for (let i = 0; i < 60 && !geschrieben; i++) {
            await page.waitForTimeout(500);
            try {
              geschrieben = fs.readdirSync(sicherungen)
                .map((name) => path.join(sicherungen, name))
                .find((dir) => fs.existsSync(path.join(dir, 'manifest.json'))) || null;
            } catch { geschrieben = null; }
          }
          const dateien = geschrieben ? fs.readdirSync(geschrieben) : [];
          check(!!geschrieben && dateien.includes('export.json'),
            'Nach dem Klick liegt eine echte Sicherung auf dem Stick',
            `${geschrieben || sicherungen}: ${dateien.join(', ') || 'leer'}`);
          if (geschrieben) {
            const pruefung = await app.backup.verify(geschrieben);
            check(pruefung.ok, 'und sie ist vollständig (Manifest und Prüfsummen stimmen)',
              pruefung.ok ? `${dateien.length} Dateien` : JSON.stringify(pruefung.problems.slice(0, 2)));
            await page.waitForTimeout(600);
            const gemeldet = await page.locator('main').innerText();
            check(gemeldet.includes(geschrieben), 'Die Oberfläche nennt denselben Pfad, der wirklich beschrieben wurde');
            check(/Zuletzt gesichert gerade eben · auf dem Stick/.test(gemeldet),
              'und daneben steht still „Zuletzt gesichert gerade eben · auf dem Stick"');
          }
        }
      }

      /* --- und zurueck: ohne Vorschau wird nichts geschrieben --- */
      if (!geschrieben) {
        hmm('Die Wiederherstellung lässt sich prüfen', 'es wurde keine Sicherung geschrieben');
      } else {
        await page.locator('summary', { hasText: 'Von einer Sicherung wiederherstellen' }).click();
        await page.waitForTimeout(900);
        const quelleFeld = page.getByLabel('Ordner oder Datei der Sicherung');
        if (!(await quelleFeld.count())) {
          bad('„Von einer Sicherung wiederherstellen" öffnet ein Feld für die Quelle');
        } else {
          await quelleFeld.fill(geschrieben);
          const zurueck = page.getByRole('button', { name: /^Wiederherstellen$/ });
          check(await zurueck.count() > 0 && await zurueck.first().isDisabled(),
            'Ohne Vorschau ist „Wiederherstellen" gesperrt');
          const ansehen = page.getByRole('button', { name: /^Erst ansehen/ });
          check(await ansehen.count() > 0, 'Es gibt einen Weg, vorher zu sehen was passiert');
          if (await ansehen.count()) {
            const saetzeVorher = store.count('note');
            await ansehen.first().click();
            await page.waitForTimeout(2500);
            const vorschauText = await page.locator('main').innerText();
            check(/geschrieben ist noch nichts/i.test(vorschauText),
              'Die Vorschau sagt ausdrücklich, dass noch nichts geschrieben wurde');
            check(store.count('note') === saetzeVorher,
              'und sie hat wirklich nichts geschrieben', `${saetzeVorher} Notizen, unverändert`);
            check(/Zugangstoken/i.test(vorschauText),
              'Was NICHT mitreist, steht in der Vorschau');
            check(await zurueck.first().isDisabled() === false,
              'Erst danach wird „Wiederherstellen" frei');
          }
        }
      }
    } finally {
      fs.rmSync(stickOrt, { recursive: true, force: true });
    }

    check(errors.length === 0, 'Keine Konsolenfehler während all dessen',
      errors.slice(0, 2).join(' | ').slice(0, 200));

    /* ------ 9b. Vom Stick aus: Laufzeit, [Neue KI], [Koppeln], Kopie */
    console.log(`\n${B}9b · Vom Stick aus: Laufzeit-Zeile, leerer Stick, anderer Stick, zwei Sticks mit derselben KI${X}`);
    await pruefeStickKopplung(browser);

    if (claudeFehlt) {
      hmm('GET /api/claude antwortet', 'die Route fehlt noch (Bereich Claude-Unterbau) – der Status sagt deshalb „Online“, nie „verbunden“');
    }
    await page.close();

    /* --------- 10. Einstellungen: PIN per Klick, iPad per QR-Code */
    // Zuletzt, weil die PIN den Tresor dieser Prüfung verschlüsselt: danach
    // braucht jeder andere Browser die PIN, und das soll keinen früheren
    // Abschnitt stören.
    console.log(`\n${B}10 · Einstellungen: PIN per Klick, iPad per QR-Code${X}`);
    await pruefeSchutzUndIpad(browser, base, app);
  } finally {
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
    if (keep) console.log(`\n${D}Bildschirmfotos: ${shotDir}${X}`);
    else fs.rmSync(shotDir, { recursive: true, force: true });
  }

  console.log(`\n${D}${'─'.repeat(64)}${X}`);
  console.log(`${B}Ergebnis${X}  ${failed ? `${R}${failed} defekt${X}` : `${G}alles in Ordnung${X}`}`
    + (unclear ? ` · ${Y}${unclear} nicht prüfbar${X}` : ''));
  console.log('');
  process.exit(failed ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* Stick-Ansicht vom Stick aus (docs/STICK-BAUPLAN.md 1.6/1.7, W2)      */
/* ------------------------------------------------------------------ */

/**
 * Eine KI („Max“), die von einem Stick läuft, und daneben, was man
 * einsteckt: ein leerer Stick, ein Stick mit der KI „Lena“, eine Kopie von
 * Max. Die Sticks sind Ordner; welche „stecken“, sagt die Liste der
 * Einhängepunkte (`kopplung.einhaengepunkte`), genau wie in
 * test/kopplung.test.js. Alles andere ist echt: Suche, Vorbereiten, Koppeln,
 * Postfächer, neue Kennung.
 *
 * Das Einzige, was nachgestellt wird: das Internet fehlt. [Für Mac holen]
 * würde sonst wirklich bei nodejs.org laden; hier scheitert das Holen, wie
 * es ohne Netz scheitert, und die Ansicht muss „Ohne Internet geht das
 * nicht.“ sagen.
 */
async function pruefeStickKopplung(browser) {
  const { createApp, seedIfEmpty } = require('../src/app');
  const pathsMod = require('../src/kernel/paths');
  const VERSION = require('../package.json').version;
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-koppeln-'));
  const welt = new Set();
  const apps = [];
  const stick = (name) => {
    const root = path.join(wurzel, name);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version: VERSION }));
    fs.writeFileSync(path.join(root, pathsMod.PORTABLE_MARKER), JSON.stringify({
      neuralOsPortable: true, dataDir: 'data', appDir: 'app', createdAt: new Date().toISOString(),
    }, null, 2));
    return { root, data: path.join(root, 'data'), appDir: path.join(root, 'app') };
  };
  const starte = (s) => createApp({
    home: s.data, appDir: s.appDir, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
    kopplung: { automatisch: false, einhaengepunkte: () => [...welt] },
  });
  let page = null;
  const fehler = [];
  let dialoge = 0;
  try {
    // Lena: ein Stick mit eigener KI, einmal gestartet und wieder beendet.
    const lena = stick('Lena');
    {
      const b = await starte(lena);
      b.identitaet.umbenennen('Lena');
      await b.close();
    }
    // Max: der Stick, von dem diese KI läuft -- bisher nur mit der Laufzeit für Windows.
    const max = stick('Max');
    fs.mkdirSync(path.join(max.root, 'runtime', 'win-x64'), { recursive: true });
    fs.writeFileSync(path.join(max.root, 'runtime', 'win-x64', 'node.exe'), Buffer.alloc(4096, 7));
    const appA = await starte(max);
    apps.push(appA);
    await seedIfEmpty(appA);
    appA.identitaet.umbenennen('Max');
    const server = await appA.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;

    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    page.on('dialog', async (d) => { dialoge++; await d.dismiss().catch(() => {}); });
    await page.goto(`${base}/#/stick`, { waitUntil: 'domcontentloaded' });
    const karte = (name) => page.locator(`.stickv__karte[data-karte="${name}"]`);
    const neuSuchen = async () => {
      await page.getByRole('button', { name: /^Neu suchen$/ }).click();
      await page.waitForTimeout(700);
    };

    /* --- 1. Die Laufzeit-Zeile: „Läuft bisher nur an Windows.“ [Für Mac holen] */
    const laufzeit = karte('dieser').locator('.stickv__reihe[data-art="laufzeit"]');
    await laufzeit.first().waitFor({ timeout: 10000 }).catch(() => {});
    const laufzeitText = await laufzeit.first().innerText().catch(() => '');
    const holen = laufzeit.getByRole('button', { name: /^Für Mac holen$/ });
    check(/^Läuft bisher nur an Windows\./.test(laufzeitText) && await holen.count() === 1,
      'Dieser Stick: „Läuft bisher nur an Windows.“ mit [Für Mac holen]', laufzeitText.split('\n')[0]);
    if (await holen.count()) {
      const echt = appA.stick.addRuntime;
      let versucht = 0;
      appA.stick.addRuntime = async () => {
        versucht++;
        throw Object.assign(new Error('getaddrinfo ENOTFOUND nodejs.org'), { code: 'ENOTFOUND' });
      };
      try {
        await holen.click();
        await page.locator('.stickv__reihe[data-art="laufzeit"] .stickv__hinweis').first().waitFor({ timeout: 15000 }).catch(() => {});
        const danach = await laufzeit.first().innerText().catch(() => '');
        check(versucht > 0 && (danach.match(/Ohne Internet geht das nicht\./g) || []).length === 1,
          'Ohne Internet: einmal „Ohne Internet geht das nicht.“ – und der Knopf bleibt für später',
          `${versucht} Versuch(e) · ${danach.replace(/\s+/g, ' ').slice(0, 120)}`);
        check(await laufzeit.getByRole('button', { name: /^Für Mac holen$/ }).count() === 1, 'Danach lässt es sich wieder versuchen');
      } finally {
        appA.stick.addRuntime = echt;
      }
    }

    /* --- 2. „Leerer Stick“ -> [Neue KI] */
    const leer = path.join(wurzel, 'LEER');
    fs.mkdirSync(leer);
    welt.add(leer);
    await neuSuchen();
    const leerReihe = karte('andere').locator('.stickv__reihe[data-art="leer"]');
    await leerReihe.first().waitFor({ timeout: 8000 }).catch(() => {});
    const leerText = await leerReihe.first().innerText().catch(() => '');
    check(leerText.startsWith(`Leerer Stick: ${leer} · `) && /GB frei|MB frei/.test(leerText),
      'Ein leerer Stick steckt: „Leerer Stick: … · … frei“', leerText.split('\n')[0]);
    check(await leerReihe.getByRole('button', { name: /^Neue KI$/ }).count() === 1
      && await leerReihe.getByRole('button', { name: /^Mit dieser KI gekoppelt$/ }).count() === 1,
    'mit [Neue KI] und [Mit dieser KI gekoppelt]');
    if (await leerReihe.getByRole('button', { name: /^Neue KI$/ }).count()) {
      await leerReihe.getByRole('button', { name: /^Neue KI$/ }).click();
      // Für den Mac müsste es ins Netz; Windows kommt vom eigenen Stick. Die
      // zweite Antwort heißt deshalb „Ohne Internet“, nicht „Nur Linux“.
      const ohne = page.getByRole('button', { name: /^Ohne Internet$/ });
      await ohne.first().waitFor({ timeout: 8000 }).catch(() => {});
      const frage = await page.locator('.stickv__frage').first().innerText().catch(() => '');
      check(await ohne.count() === 1 && /auch an Mac startet/.test(frage),
        'Die eine Frage nennt, was aus dem Netz käme (der Mac) – und bietet „Ohne Internet“', frage.split('\n')[0]);
      if (await ohne.count()) {
        await ohne.first().click();
        await page.locator('.stickv__fertig, .stickv__meldung').first().waitFor({ timeout: 120000 }).catch(() => {});
        await page.waitForTimeout(800);
        const inhalt = path.join(leer, 'Inhalt');
        let marker = null;
        try { marker = JSON.parse(fs.readFileSync(path.join(inhalt, pathsMod.PORTABLE_MARKER), 'utf8')); } catch { marker = null; }
        const text = await karte('andere').innerText().catch(() => '');
        check(/Fertig\. Stick kann raus\./.test(text) && !!(marker && marker.kiId && marker.kiId !== appA.identitaet.id),
          '[Neue KI]: „Fertig. Stick kann raus.“ – und auf dem Stick wohnt eine neue KI mit eigener Kennung',
          marker ? `${marker.name || ''} ${marker.kiId || ''}` : 'kein Marker');
        check(fs.existsSync(path.join(inhalt, 'runtime', 'win-x64', 'node.exe')),
          'Die Laufzeit für Windows kam ohne Netz vom eigenen Stick mit');
        check(/Läuft bisher nur an Windows\./.test(text), 'und die Ansicht sagt, dass der neue Stick bisher nur an Windows läuft');
      }
      welt.delete(leer);
    }

    /* --- 3. „Anderer Stick: Lena“ -> [Koppeln] -> „Gekoppelt mit Lena …“ */
    welt.add(lena.root);
    await neuSuchen();
    const lenaReihe = karte('andere').locator('.stickv__reihe[data-art="fremd"]', { hasText: 'Anderer Stick: Lena' });
    await lenaReihe.first().waitFor({ timeout: 8000 }).catch(() => {});
    check(await lenaReihe.count() === 1 && await lenaReihe.getByRole('button', { name: /^Koppeln$/ }).count() === 1,
      'Steckt Lenas Stick: „Anderer Stick: Lena“ [Koppeln] – ohne Klick passiert nichts',
      (await karte('andere').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
    check(!fs.existsSync(path.join(lena.root, 'sync', 'koppeln')), 'Vor dem Klick liegt auf Lenas Stick noch kein Angebot');
    if (await lenaReihe.count()) {
      await lenaReihe.getByRole('button', { name: /^Koppeln$/ }).click();
      const partner = karte('gekoppelt').locator('.stickv__reihe[data-art="partner"]');
      await partner.first().waitFor({ timeout: 15000 }).catch(() => {});
      const partnerText = await partner.first().innerText().catch(() => '');
      check(/^Gekoppelt mit Lena · (Lena übernimmt beim nächsten Start|abgeglichen \d\d:\d\d)/.test(partnerText),
        'Nach [Koppeln]: „Gekoppelt mit Lena · Lena übernimmt beim nächsten Start“', partnerText.split('\n')[0]);
      check(await partner.getByRole('button', { name: /^Jetzt abgleichen$/ }).count() === 1
        && await partner.getByRole('button', { name: /^Entkoppeln$/ }).count() === 1,
      'mit [Jetzt abgleichen] und [Entkoppeln]');
      const angebote = fs.existsSync(path.join(lena.root, 'sync', 'koppeln')) ? fs.readdirSync(path.join(lena.root, 'sync', 'koppeln')) : [];
      check(angebote.some((n) => n.endsWith('.angebot')), 'und auf Lenas Stick liegt jetzt wirklich das Angebot', angebote.join(', '));
      check(appA.kopplung.status().partner.some((x) => x.name === 'Lena'), 'Max kennt Lena jetzt als Partner');

      // [Entkoppeln] fragt in der Seite nach -- [Abbrechen] laesst alles, wie es ist.
      await partner.getByRole('button', { name: /^Entkoppeln$/ }).click();
      const rueck = partner.locator('.stickv__rueckfrage');
      await rueck.waitFor({ timeout: 4000 }).catch(() => {});
      const rueckText = await rueck.innerText().catch(() => '');
      check(/Entkoppeln\? Beide behalten, was sie wissen\./.test(rueckText)
        && await rueck.getByRole('button', { name: /^Entkoppeln$/ }).count() === 1
        && await rueck.getByRole('button', { name: /^Abbrechen$/ }).count() === 1,
      '[Entkoppeln] fragt in der Seite: „Entkoppeln? Beide behalten, was sie wissen.“', rueckText.split('\n')[0]);
      await rueck.getByRole('button', { name: /^Abbrechen$/ }).click().catch(() => {});
      await page.waitForTimeout(300);
      check(await partner.locator('.stickv__rueckfrage').count() === 0 && appA.kopplung.status().partner.length === 1,
        '[Abbrechen]: die Frage ist weg, gekoppelt bleibt gekoppelt');
    }

    /* --- 3b. „„Einkaufsliste“ gab es zweimal verschieden – beide sind da.“ [Ansehen] */
    // Die zweite Fassung entsteht beim Abgleich (src/sync/folder.js); er
    // meldet sie mit genau diesem Ereignis. Hier wird es so gemeldet, wie er
    // es tut -- geprüft wird, was die Oberfläche daraus macht.
    {
      const kopieNotiz = appA.store.create('note', { title: 'Einkaufsliste (Fassung von Lena)', body: 'Milch, Brot, Äpfel' });
      const lenaId = (appA.kopplung.status().partner.find((x) => x.name === 'Lena') || {}).id || null;
      appA.bus.publish('kopplung.zweiFassungen', { titel: 'Einkaufsliste', kopieId: kopieNotiz.id, partner: lenaId });
      const fassung = karte('gekoppelt').locator('.stickv__reihe[data-art="fassung"]');
      await fassung.first().waitFor({ timeout: 8000 }).catch(() => {});
      const fassungText = (await fassung.first().innerText().catch(() => '')).split('\n')[0];
      check(fassungText === '„Einkaufsliste“ gab es zweimal verschieden – beide sind da.'
        && await fassung.getByRole('button', { name: /^Ansehen$/ }).count() === 1,
      'Zwei Fassungen: „„Einkaufsliste“ gab es zweimal verschieden – beide sind da.“ [Ansehen]', fassungText);
      const meldung = page.locator('.toast', { hasText: 'gab es zweimal verschieden' });
      check(await meldung.count() >= 1, 'und die App meldet es auch dann, wenn die Stick-Ansicht nicht offen ist (kurzer Hinweis mit [Ansehen])');
      if (await fassung.getByRole('button', { name: /^Ansehen$/ }).count()) {
        await fassung.getByRole('button', { name: /^Ansehen$/ }).click();
        await page.waitForTimeout(900);
        check(page.url().includes(`#/notes?id=${kopieNotiz.id}`), '[Ansehen] öffnet die zweite Fassung', page.url().split('#')[1] || '');
        await page.goto(`${base}/#/stick`, { waitUntil: 'domcontentloaded' });
        await karte('gekoppelt').locator('.stickv__reihe[data-art="partner"]').first().waitFor({ timeout: 10000 }).catch(() => {});
        check(await karte('gekoppelt').locator('.stickv__reihe[data-art="fassung"]').count() === 0,
          'Einmal angesehen, steht sie nicht wieder da');
      }
    }

    /* --- 4. „Zwei Sticks tragen dieselbe KI.“ [Diesen Stick eigenständig machen] */
    const kopie = path.join(wurzel, 'MaxKopie');
    fs.mkdirSync(path.join(kopie, 'app'), { recursive: true });
    fs.copyFileSync(path.join(max.appDir, 'package.json'), path.join(kopie, 'app', 'package.json'));
    fs.copyFileSync(path.join(max.root, pathsMod.PORTABLE_MARKER), path.join(kopie, pathsMod.PORTABLE_MARKER));
    welt.add(kopie);
    const alteKennung = appA.identitaet.id;
    await neuSuchen();
    const zwilling = page.locator('.stickv__reihe[data-art="zwilling"]');
    await zwilling.first().waitFor({ timeout: 8000 }).catch(() => {});
    const zwillingText = await zwilling.first().innerText().catch(() => '');
    const eigen = zwilling.getByRole('button', { name: /^Diesen Stick eigenständig machen$/ });
    check(/^Zwei Sticks tragen dieselbe KI\./.test(zwillingText) && await eigen.count() === 1,
      'Steckt eine Kopie: „Zwei Sticks tragen dieselbe KI.“ [Diesen Stick eigenständig machen]', zwillingText.split('\n')[0]);
    if (await eigen.count()) {
      await Promise.all([
        page.waitForEvent('load', { timeout: 15000 }).catch(() => {}),
        eigen.first().click(),
      ]);
      await page.locator('.stickv__karte[data-karte="andere"] .stickv__reihe, .stickv__karte[data-karte="andere"] [data-leer]').first()
        .waitFor({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      const neuText = await karte('andere').innerText().catch(() => '');
      check(appA.identitaet.id !== alteKennung && !/Zwei Sticks tragen dieselbe KI/.test(neuText),
        'Danach hat dieser Stick eine eigene Kennung, und die Kopie ist ein anderer Stick',
        neuText.replace(/\s+/g, ' ').slice(0, 120));
    }

    check(dialoge === 0, 'Kein Fenster des Browsers (confirm/alert) dabei');
    check(fehler.length === 0, 'Keine Seiten- oder Konsolenfehler dabei', fehler.slice(0, 2).join(' | ').slice(0, 200));
  } catch (err) {
    bad('Die Stick-Ansicht vom Stick aus ließ sich prüfen', err && err.message);
  } finally {
    if (page) await page.close().catch(() => {});
    for (const a of apps) await a.close().catch(() => {});
    fs.rmSync(wurzel, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Marken                                                              */
/* ------------------------------------------------------------------ */

/**
 * Eine Ansicht, die `var(--surface-5)` schreibt, obwohl es die Marke nicht
 * gibt, rendert still ohne Farbe -- genau der "erfundene CSS-Name", mit dem
 * dieses Werkzeug einmal angefangen hat. Das laesst sich ohne Browser pruefen:
 * jede var(--…) ohne Ersatzwert in web/** muss irgendwo definiert sein, in
 * web/app.css oder von der Datei selbst.
 */
function pruefeMarken() {
  const web = path.join(__dirname, '..', 'web');
  const dateien = [path.join(web, 'app.js')];
  for (const ordner of ['views', 'widgets', 'lib']) {
    const voll = path.join(web, ordner);
    if (!fs.existsSync(voll)) continue;
    for (const name of fs.readdirSync(voll)) if (name.endsWith('.js')) dateien.push(path.join(voll, name));
  }
  const definiert = new Set();
  const lies = (datei) => fs.readFileSync(datei, 'utf8');
  for (const m of lies(path.join(web, 'app.css')).matchAll(/(--[a-z0-9-]+)\s*:/g)) definiert.add(m[1]);
  for (const datei of dateien) {
    const src = lies(datei);
    // Eigene Marken einer Ansicht, im CSS-Text oder per setProperty('--x').
    for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/g)) definiert.add(m[1]);
    for (const m of src.matchAll(/['"](--[a-z0-9-]+)['"]/g)) definiert.add(m[1]);
  }
  const fehlend = new Set();
  let benutzt = 0;
  for (const datei of dateien) {
    for (const m of lies(datei).matchAll(/var\((--[a-z0-9-]+)\s*([,)])/g)) {
      benutzt++;
      if (m[2] === ',') continue; // mit Ersatzwert: faellt nicht still aus
      if (!definiert.has(m[1])) fehlend.add(`${path.relative(web, datei)}: ${m[1]}`);
    }
  }
  check(!fehlend.size, 'Jede var(--…) in web/** ist auch definiert',
    fehlend.size ? [...fehlend].slice(0, 6).join(' · ') : `${benutzt} Verwendungen in ${dateien.length} Dateien`);
}

/* ------------------------------------------------------------------ */
/* Die Schale                                                          */
/* ------------------------------------------------------------------ */

/**
 * Die Schale nach docs/vorlage/app.png -- und was der Nutzer woertlich wollte:
 * "die Seiten wegklappen und ausklappen koennen", eingeklappt bleibt nur der
 * Chat, und der Zustand bleibt. Geprueft wird am Zustand des Dokuments und an
 * gemessenen Breiten, nicht an einem Bild.
 */
async function pruefeSchale(page, base, store, app) {
  const warte = (ms) => page.waitForTimeout(ms);
  const zustand = () => page.evaluate(() => {
    const shell = document.querySelector('.shell');
    const rail = document.querySelector('.rail');
    const aside = document.querySelector('.aside');
    const stage = document.querySelector('.stage');
    const aktiv = document.activeElement;
    return {
      links: shell.dataset.links,
      rechts: shell.dataset.rechts,
      leisteSichtbar: getComputedStyle(rail).visibility !== 'hidden' && rail.getBoundingClientRect().width > 100,
      spalteSichtbar: getComputedStyle(aside).visibility !== 'hidden' && aside.getBoundingClientRect().width > 100,
      chatBreite: Math.round(stage.getBoundingClientRect().width),
      fensterBreite: window.innerWidth,
      fokus: aktiv ? (aktiv.getAttribute('aria-label') || aktiv.textContent || '').trim() : '',
    };
  });

  // Sauber anfangen: nichts Gemerktes aus einem frueheren Lauf.
  await page.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((k) => { try { localStorage.removeItem(k); } catch { /* egal */ } }, `neural-os:${app.ki.id}:seiten`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await warte(1000);
  await dismissWelcome(page);

  /* --- die Leiste, wie in der Vorlage --- */
  const eintraege = (await page.locator('.rail__item .rail__label').allInnerTexts()).map((t) => t.trim());
  check(JSON.stringify(eintraege) === JSON.stringify(LEISTE),
    'Die Leiste hat genau die Einträge der Vorlage, in ihrer Reihenfolge', eintraege.join(' · '));
  const marke = (await page.locator('.rail__wordmark').innerText()).replace(/\s+/g, ' ').trim().toUpperCase();
  check(marke === 'NEURAL OS' && await page.locator('.rail__brand svg').count() === 1,
    'Oben steht das eigene Zeichen mit der Wortmarke NEURAL OS', marke);
  check(await page.locator('.rail__item.is-active', { hasText: 'Neuer Chat' }).count() === 1,
    '„Neuer Chat“ ist beim Start der aktive Eintrag');
  check((await page.locator('.topbar__title').innerText()).trim() === 'Neuer Chat',
    'Der Kopf der mittleren Karte sagt „Neuer Chat“');
  const alteChips = await page.locator('.chip--net, [data-model], [data-vault]').count();
  check(alteChips === 0, 'Die alte Kopfleiste mit Offline / Kein Modell / Unverschlüsselt ist weg', `${alteChips} gefunden`);

  /* --- der Status unten links sagt die Wahrheit --- */
  const anzeige = async () => (await page.locator('.rail__status').innerText()).replace(/\s+/g, ' ').trim();
  const modus = await page.evaluate(async () => (await (await fetch('/api/status')).json()).network.mode);
  const vorher = await anzeige();
  check(modus === 'offline' && vorher === 'Offline',
    'Unten links steht der Netzzustand, den /api/status meldet', `Server: ${modus} · Anzeige: ${vorher}`);
  const umschalten = (mode) => page.evaluate(async (m) => {
    const res = await fetch('/api/network', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-neural-os': '1' },
      body: JSON.stringify({ mode: m }),
    });
    return res.status;
  }, mode);
  const gesetzt = await umschalten('online');
  await warte(1600);
  const online = await anzeige();
  // Ohne Schluessel darf dort "Online" stehen, aber nie "verbunden".
  check(gesetzt === 200 && /^Online/.test(online) && !/verbunden/i.test(online),
    'Online geschaltet folgt die Anzeige live – und behauptet ohne KI keine Verbindung',
    `HTTP ${gesetzt} → ${online}`);
  await umschalten('offline');
  await warte(1600);
  check(await anzeige() === 'Offline', 'Zurück auf offline steht dort wieder „Offline“', await anzeige());
  await page.locator('.rail__status').click();
  await warte(700);
  check(page.url().includes('#/network'), 'Ein Klick auf den Status führt ins Netzwerk', page.url().split('#')[1]);

  /* --- die rechte Spalte --- */
  await page.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
  await warte(1200);
  const kacheln = await page.locator('.aside .tile').evaluateAll((els) => els.map((e) => ({
    id: e.dataset.tile,
    titel: ((e.querySelector('.tile__title') || {}).textContent || '').trim(),
  })));
  check(JSON.stringify(kacheln.map((k) => k.id)) === JSON.stringify(KACHELN) && kacheln.every((k) => k.titel),
    'Rechts stehen die vier Kacheln, jede eingehängt und mit Kopf', kacheln.map((k) => k.titel || `${k.id}: leer`).join(' · '));

  /* --- einklappen, ausklappen, merken --- */
  const offen = await zustand();
  check(offen.links === 'offen' && offen.rechts === 'offen' && offen.leisteSichtbar && offen.spalteSichtbar,
    'Bei 1440 px sind Leiste und rechte Spalte offen', `Chat ${offen.chatBreite} px breit`);
  await page.getByRole('button', { name: 'Seitenleiste einklappen' }).click();
  await warte(500);
  const ohneLeiste = await zustand();
  check(ohneLeiste.links === 'zu' && !ohneLeiste.leisteSichtbar && ohneLeiste.chatBreite > offen.chatBreite + 200,
    'Die Leiste klappt weg, der Chat wird breiter', `${offen.chatBreite} → ${ohneLeiste.chatBreite} px`);
  check(ohneLeiste.fokus === 'Seitenleiste ausklappen',
    'Der Fokus landet auf dem Knopf, der sie zurückholt', ohneLeiste.fokus || '(nirgends)');
  // Erst warten, bis die erste Wahl gespeichert ist (PATCH /config nach 600 ms):
  // Danach kam einmal ein Status mit dem älteren Stand an und klappte die
  // eben eingeklappte Spalte wieder auf (gefunden mit tools/screenshots.js).
  await warte(500);
  await page.getByRole('button', { name: 'Übersicht einklappen' }).click();
  await warte(500);
  const nurChat = await zustand();
  check(nurChat.rechts === 'zu' && !nurChat.spalteSichtbar && nurChat.chatBreite >= nurChat.fensterBreite - 48,
    'Beide Seiten eingeklappt: nur der Chat bleibt', `Chat ${nurChat.chatBreite} von ${nurChat.fensterBreite} px`);
  await warte(2500);
  const spaeter = await zustand();
  check(spaeter.links === 'zu' && spaeter.rechts === 'zu',
    'und es bleibt so, auch nachdem gespeichert ist und der Status nachkommt', `Leiste ${spaeter.links}, Spalte ${spaeter.rechts}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await warte(900);
  const gemerkt = await zustand();
  check(gemerkt.links === 'zu' && gemerkt.rechts === 'zu', 'Nach dem Neuladen bleibt es so – der Zustand ist gemerkt',
    `Leiste ${gemerkt.links}, Spalte ${gemerkt.rechts}`);
  await page.getByRole('button', { name: 'Seitenleiste ausklappen' }).click();
  await page.getByRole('button', { name: 'Übersicht ausklappen' }).click();
  await warte(500);
  const wieder = await zustand();
  check(wieder.links === 'offen' && wieder.rechts === 'offen' && wieder.leisteSichtbar && wieder.spalteSichtbar,
    'Und beide lassen sich wieder ausklappen');

  /* --- die letzten Chats, live --- */
  const neu = store.create('chat', { title: 'Reiseplanung Herbst' });
  await store.flush();
  await warte(2000);
  const eintrag = page.locator('.rail__chat', { hasText: 'Reiseplanung Herbst' });
  check(await eintrag.count() === 1, 'Ein neuer Chat erscheint ohne Neuladen unter „Zuletzt“');
  if (await eintrag.count()) {
    await eintrag.first().click();
    await warte(900);
    check(page.url().endsWith(`#/chat?id=${neu.id}`) && (await page.locator('.topbar__title').innerText()).trim() === 'Reiseplanung Herbst',
      'Ein Klick öffnet ihn, und der Kopf trägt seinen Titel', (await page.locator('.topbar__title').innerText()).trim());
    await page.locator('.rail__item', { hasText: 'Neuer Chat' }).click();
    await warte(900);
    check(page.url().endsWith('#/chat') && (await page.locator('.topbar__title').innerText()).trim() === 'Neuer Chat',
      '„Neuer Chat“ führt zurück auf die leere Seite', page.url().split('#')[1]);
  }

  /* --- Suchen ist die Befehlspalette --- */
  await page.goto(`${base}/#/notes`, { waitUntil: 'domcontentloaded' });
  await warte(900);
  await page.evaluate(() => { window.location.hash = '#/search?q=entkalken'; });
  await warte(1400);
  const suche = await page.evaluate(() => ({
    offen: !!document.querySelector('.palette__input'),
    wert: (document.querySelector('.palette__input') || {}).value,
    hash: window.location.hash,
    treffer: [...document.querySelectorAll('.palette__item .palette__label')].map((x) => x.textContent),
  }));
  check(suche.offen && suche.wert === 'entkalken' && suche.hash.startsWith('#/notes'),
    'Eine Suchadresse (#/search?q=…) öffnet die Suche über der Ansicht, statt die Seite zu wechseln',
    `${suche.hash} · „${suche.wert}“`);
  check(suche.treffer.some((t) => /entkalken/i.test(t)), 'und findet, was im Tresor steht', suche.treffer.slice(0, 3).join(' · '));
  await page.keyboard.press('Escape');
  await warte(300);
  await page.keyboard.press('Control+k');
  await warte(400);
  await page.keyboard.type('eins');
  await warte(300);
  await page.keyboard.press('Enter');
  await warte(900);
  check(page.url().includes('#/settings'), 'Strg+K, „eins“, Enter führt in die Einstellungen', page.url().split('#')[1]);

  /* --- alte Adressen --- */
  const falsch = [];
  for (const alt of ['today', 'assist', 'automation', 'timeline', 'sync']) {
    await page.goto(`${base}/#/${alt}`, { waitUntil: 'domcontentloaded' });
    await warte(700);
    const hash = await page.evaluate(() => window.location.hash);
    if (hash !== '#/chat') falsch.push(`${alt} → ${hash}`);
  }
  check(!falsch.length, 'Alte Adressen (Heute, Vorschläge, Automatik, Zeitachse, Abgleich) führen in den Chat',
    falsch.join(' · ') || '5 von 5');
}

/* ------------------------------------------------------------------ */
/* Das Gehirn                                                          */
/* ------------------------------------------------------------------ */

/**
 * Das Gehirn als Wissensuniversum (Vision vom 27.09.2026). Geprueft wird,
 * was man nicht aus einem Unit-Test lesen kann: dass Ebene 0 wirklich
 * Themenkreise zeichnet, dass ein Klick auf einen Kreis in Ebene 1 fuehrt
 * (Brotkrumen, Adresse), dass das Netz zur Ruhe kommt und dann stillsteht
 * (ein Gehirn, das offen liegt, darf auf dem Schullaptop keine Rechenzeit
 * fressen), dass Suchen und Eingabetaste den Eintrag waehlen und die Karte
 * rechts seine Verknuepfungen nennt, dass "Oeffnen" bis zum richtigen
 * Eintrag durchschlaegt, dass Escape eine Ebene hoch geht, dass eine neue
 * Verbindung aus dem Tresor OHNE Neuladen im Bild ankommt (Bus), dass die
 * Karte (Themenkarte) Kacheln und Eintraege zeigt -- und dass die Kachel
 * rechts das Gehirn an ihrer Mitte oeffnet.
 */
async function pruefeGehirn(page, base, store) {
  const warte = (ms) => page.waitForTimeout(ms);
  const zustand = () => page.evaluate(() => {
    const g = document.querySelector('.gh');
    const a = g && g.gehirn;
    return a ? { ebene: a.ebene, thema: a.thema ? a.thema.name : null, sel: a.selectedId, nodes: a.nodes, themen: a.themen, klein: a.klein, leer: a.leer, ids: a.ids } : null;
  });
  await page.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  const start = Date.now();
  const da = await page.waitForFunction(() => {
    const g = document.querySelector('.gh');
    return g && g.gehirn && (g.gehirn.themen > 0 || g.gehirn.leer);
  }, null, { timeout: 15000 }).then(() => true, () => false);
  let z = await zustand();
  check(da && z && z.ebene === 0 && z.themen >= 2, 'Ebene 0 zeigt Themenbereiche (aus Schlagworten und Verbindungen)', z ? `${z.themen} Themen nach ${Date.now() - start} ms` : 'kein Gehirn');

  // Gezeichnet ist, was Pixel hat -- nicht, was im DOM steht.
  const bild = (sel) => page.evaluate((s) => {
    const c = document.querySelector(s);
    if (!c || !c.width) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let gemalt = 0;
    let summe = 0;
    let licht = 0;
    for (let i = 3; i < d.length; i += 4 * 7) {
      if (d[i] > 0) {
        gemalt++;
        licht += d[i];
      }
      summe = (summe * 31 + d[i - 3] + d[i]) % 1000000007;
    }
    return { gemalt, summe, deckung: gemalt ? licht / gemalt : 0 };
  }, sel);
  await warte(1100); // der weiche Aufbau (720 ms) ist dann durch
  const u = await bild('.gh__canvas--uni');
  check(u && u.gemalt > 400, 'Die Leinwand der Ebene 0 zeigt Kreise', u ? `${u.gemalt} gemalte Stichproben` : 'keine Leinwand');
  const krumeOben = (await page.locator('.gh__crumb').allInnerTexts()).map((t) => t.trim());
  check(krumeOben[0] && krumeOben[0].startsWith('Mein Wissen'), 'Die Brotkrumen beginnen mit „Mein Wissen“', krumeOben.join(' › '));

  // Klick auf den groessten Kreis -> Ebene 1 dieses Themas.
  const groesstes = await page.evaluate(() => {
    const g = document.querySelector('.gh').gehirn;
    let best = null;
    for (const id of g.themenIds || []) {
      const p = g.screenPosition(id);
      if (p && (!best || p.r > best.r)) best = { id, ...p };
    }
    return best;
  });
  const box = await page.locator('.gh').boundingBox();
  if (!groesstes || !box) bad('Ein Klick auf einen Themenkreis öffnet das Thema', 'kein Kreis gefunden');
  else {
    await page.mouse.click(box.x + groesstes.x, box.y + groesstes.y);
    const drin = await page.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn.ebene === 1 && g.gehirn.nodes > 0; }, null, { timeout: 8000 }).then(() => true, () => false);
    z = await zustand();
    const hash = await page.evaluate(() => window.location.hash);
    check(drin && z.thema && hash.startsWith('#/graph?thema='), 'Ein Klick auf einen Themenkreis öffnet das Thema als Netz, die Adresse folgt', `${z && z.thema} · ${z && z.nodes} Knoten · ${hash}`);
    const krumen = (await page.locator('.gh__crumb').allInnerTexts()).map((t) => t.trim());
    check(krumen.length >= 2 && krumen[0].startsWith('Mein Wissen') && krumen[1].startsWith(String(z.thema || '')), 'Die Brotkrumen zeigen „Mein Wissen › Thema“', krumen.join(' › '));
  }
  const ruht = await page.waitForFunction(() => {
    const g = document.querySelector('.gh');
    return g && g.dataset.ruhe === 'ja';
  }, null, { timeout: 15000 }).then(() => true, () => false);
  check(ruht, 'Das Netz kommt zur Ruhe', ruht ? `nach ${Date.now() - start} ms` : 'nach 15 s noch in Bewegung');
  await warte(600);
  const a = await bild('.gh__canvas--netz');
  check(a && a.gemalt > 300, 'Die Leinwand der Ebene 1 zeigt ein Netz', a ? `${a.gemalt} gemalte Stichproben` : 'keine Leinwand');
  await warte(900);
  const b = await bild('.gh__canvas--netz');
  check(a && b && a.summe === b.summe, 'In Ruhe steht das Bild still (keine Rechenzeit im Leerlauf)',
    a && b ? (a.summe === b.summe ? 'zwei Aufnahmen im Abstand von 0,9 s sind gleich' : 'das Bild ändert sich noch') : '');

  // Eine neue Verbindung aus dem Tresor kommt ueber den Bus ins Bild -- ohne Neuladen.
  z = await zustand();
  const ids = (z && z.ids) || [];
  if (ids.length >= 2) {
    const vorher = await page.evaluate(() => document.querySelector('.gh').gehirn.stats().visibleEdges);
    // Zwei Knoten des Themas, zwischen denen es noch keine Linie gibt -- der
    // erste (Hub) haengt oft schon an allen, also ueber die Knoten hinweg suchen.
    let von = null;
    let zu = null;
    for (const kandidat of ids.slice(0, 40)) {
      const schon = new Set();
      for (const e of store.edges.for(kandidat, { direction: 'both' })) {
        schon.add(e.data.from);
        schon.add(e.data.to);
      }
      const frei = ids.find((id) => id !== kandidat && !schon.has(id));
      if (frei) { von = kandidat; zu = frei; break; }
    }
    if (!zu) hmm('Eine neue Verbindung erscheint sofort im Netz', 'jeder Knoten des Themas hängt schon an jedem');
    else {
      store.edges.add({ from: von, to: zu, kind: 'related', source: 'manual', reason: 'Prüfung: neue Verbindung' });
      const kam = await page.waitForFunction((n) => document.querySelector('.gh').gehirn.stats().visibleEdges > n, vorher, { timeout: 5000 }).then(() => true, () => false);
      const nachher = await page.evaluate(() => document.querySelector('.gh').gehirn.stats().visibleEdges);
      check(kam, 'Eine neue Verbindung erscheint sofort im Netz (Bus graph.kante, kein Neuladen)', `${vorher} → ${nachher} Linien`);
    }
  } else hmm('Eine neue Verbindung erscheint sofort im Netz', 'zu wenige Knoten im Thema');

  // Suchen -> Eingabetaste -> Karte rechts -> Oeffnen -> der richtige Eintrag.
  const ziel = store.all('note').find((n) => n.data.title === 'Notiz 7');
  const feld = page.getByLabel('Im Gehirn suchen');
  if (!ziel || !(await feld.count())) {
    bad('Die Suche im Gehirn lässt sich bedienen', ziel ? 'kein Suchfeld' : 'Testnotiz fehlt');
  } else {
    await feld.fill('Notiz 7');
    await warte(500);
    await feld.press('Enter');
    const karte = page.locator('.gh__card');
    await karte.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    await warte(700);
    const titel = (await karte.locator('.gh__card-title').innerText().catch(() => '')).trim();
    check(await karte.isVisible() && titel === 'Notiz 7', 'Suchen und Eingabetaste wählen den Eintrag, die Karte rechts nennt ihn', titel || 'keine Karte');
    const abschnitte = (await karte.locator('.gh__sec-title').allInnerTexts()).map((t) => t.trim());
    const links = await karte.locator('.gh__link').count();
    check(abschnitte.some((t) => /Verknüpft mit/i.test(t)) && links >= 1, 'Die Karte zeigt „Verknüpft mit“ mit Verbindungen und ihrem Grund', `${links} Zeilen · ${abschnitte.join(' · ')}`);
    check(abschnitte.some((t) => /KI-Zusammenfassung/i.test(t)), 'Die Karte hat den Abschnitt „KI-Zusammenfassung“', abschnitte.join(' · '));
    await karte.getByRole('button', { name: 'Zusammenfassen' }).click().catch(() => {});
    await warte(900);
    const ki = (await karte.locator('.gh__ki').innerText().catch(() => '')).trim();
    check(ki.length > 0, 'Die KI-Zusammenfassung sagt ehrlich, was sie kann', ki.slice(0, 80));
    // Gewaehlt: der Rest tritt zurueck; Karte zu: alles kommt wieder.
    const gewaehlt = await bild('.gh__canvas--netz');
    await karte.getByRole('button', { name: 'Auswahl schließen' }).click();
    await feld.fill('');
    await feld.press('Escape');
    await warte(700);
    const frei = await bild('.gh__canvas--netz');
    check(gewaehlt && frei && frei.deckung > gewaehlt.deckung * 1.15,
      'Auswahl schließen holt das ganze Netz zurück (der Rest tritt nur bei Auswahl auf ein Viertel zurück)',
      gewaehlt && frei ? `Deckung gewählt ${Math.round(gewaehlt.deckung)} → danach ${Math.round(frei.deckung)}` : '');
    await feld.fill('Notiz 7');
    await warte(500);
    await feld.press('Enter');
    await karte.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    await warte(500);
    await karte.getByRole('button', { name: 'Öffnen' }).click();
    await warte(900);
    const hash = await page.evaluate(() => window.location.hash);
    check(hash === `#/notes?id=${encodeURIComponent(ziel.id)}`, '„Öffnen“ führt zu genau diesem Eintrag', hash);
  }

  // Escape geht eine Ebene hoch; die Themenkarte zeigt Kacheln und Eintraege.
  await page.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.themen > 0; }, null, { timeout: 15000 }).catch(() => {});
  await warte(400);
  const ersteId = await page.evaluate(() => (document.querySelector('.gh').gehirn.themenIds || [])[0] || null);
  if (ersteId) {
    await page.evaluate((id) => document.querySelector('.gh').gehirn.tauchen(id), ersteId);
    await page.waitForFunction(() => document.querySelector('.gh').gehirn.ebene === 1, null, { timeout: 8000 }).catch(() => {});
    await warte(300);
    await page.mouse.click(box.x + 20, box.y + box.height - 20); // nirgendwo: nichts gewaehlt
    await page.keyboard.press('Escape');
    const oben = await page.waitForFunction(() => document.querySelector('.gh').gehirn.ebene === 0, null, { timeout: 5000 }).then(() => true, () => false);
    check(oben, 'Escape geht eine Ebene hoch: vom Thema zurück ins Universum', oben ? 'Ebene 0' : 'noch in Ebene 1');
  } else hmm('Escape geht eine Ebene hoch', 'kein Thema gefunden');
  await page.getByRole('tab', { name: 'Karte' }).click();
  await warte(900);
  const kacheln = await page.locator('.wk__tile').count();
  check(kacheln >= 2, 'Die Themenkarte zeigt die Themen als ruhige Kacheln', `${kacheln} Kacheln`);
  if (kacheln) {
    await page.locator('.wk__tile').first().click();
    await warte(900);
    const zeilen = await page.locator('.wk__row').count();
    const titel = (await page.locator('.wk__title').innerText().catch(() => '')).trim();
    check(zeilen >= 1 && titel.length > 0, 'Antippen einer Kachel führt tiefer: Überschrift und Einträge des Themas', `${titel} · ${zeilen} Einträge`);
  }

  // Die Kachel: ein Ausschnitt mit Mitte im Akzent, Antippen oeffnet das Gehirn dort.
  await page.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
  await warte(600);
  if (await page.evaluate(() => (document.querySelector('.shell') || {}).dataset?.rechts === 'zu')) {
    const auf = page.getByRole('button', { name: 'Übersicht ausklappen' }).first();
    if (await auf.count()) await auf.click();
  }
  const link = page.locator('.tile[data-tile="gehirn"] a.ghk');
  await link.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
  const href = await link.getAttribute('href').catch(() => null);
  check(!!href && href.startsWith('#/graph?focus='), 'Die Kachel „Gehirn“ zeigt einen Ausschnitt und verweist auf seine Mitte', href || 'kein Ausschnitt');
  if (href) {
    await link.click();
    await page.locator('.gh__card').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await warte(600);
    const gewaehlt = (await page.locator('.gh__card-title').innerText().catch(() => '')).trim();
    const krumen = (await page.locator('.gh__crumb').allInnerTexts()).map((t) => t.trim());
    check(!!gewaehlt, 'Antippen öffnet das Gehirn mit genau dieser Mitte gewählt (Umfeld, Karte offen)', gewaehlt ? `${gewaehlt} · ${krumen.join(' › ')}` : 'nichts gewählt');
  }
}

/**
 * Zwei Zustaende, die der geteilte Tresor oben nicht hergibt: das leere
 * Gehirn (Vision: "Dein Wissensuniversum wartet." mit drei Wegen hinein und
 * OHNE Suchfeld ueber dem Nichts) und das volle (Vertrag F: 10.000 Knoten,
 * Ebene 0 sofort, Ebene 1 eines Themas mit 2.000 Knoten fluessig). Beides
 * in einem eigenen Tresor, damit die Zaehlungen der anderen Abschnitte
 * stimmen bleiben. Die Bilder je Sekunde werden IM Browser gezaehlt: je
 * Bild ein synthetisches pointermove, requestAnimationFrame gegen
 * performance.now() -- so misst die Zahl die Arbeit der Seite, nicht die
 * Laufzeit der Fernsteuerung. Chromium hier hat keine GPU; die Zahlen sind
 * also die eines Software-Rasters und damit die Untergrenze.
 */
async function pruefeGehirnGross(browser) {
  const { createApp } = require('../src/app');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-gross-'));
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error' });
  await app.loadModules({});
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const store = app.store;
  let context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  let page = await context.newPage();
  const fehler = [];
  page.on('pageerror', (e) => fehler.push(e.message.slice(0, 120)));
  const warte = (ms) => page.waitForTimeout(ms);
  const gehirn = () => page.evaluate(() => {
    const g = document.querySelector('.gh');
    const a = g && g.gehirn;
    return a ? { ebene: a.ebene, nodes: a.nodes, themen: a.themen, leer: a.leer, thema: a.thema ? a.thema.name : null } : null;
  });
  try {
    // Leer: eingeladen, nicht kaputt.
    await page.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    const leer = await page.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.leer; }, null, { timeout: 15000 }).then(() => true, () => false);
    const titel = (await page.locator('.gh__state-title').innerText().catch(() => '')).trim();
    const satz = (await page.locator('.gh__state-text').innerText().catch(() => '')).trim();
    check(leer && titel === 'Dein Wissensuniversum wartet.' && satz === 'Erstelle deine erste Notiz oder importiere vorhandenes Wissen.',
      'Das leere Gehirn sagt „Dein Wissensuniversum wartet.“', `${titel} · ${satz}`);
    const knoepfe = [];
    for (const name of ['Erste Notiz', 'Importieren', 'KI kennenlernen']) {
      if (await page.locator('.gh__state').getByRole('button', { name, exact: true }).count()) knoepfe.push(name);
    }
    check(knoepfe.length === 3, 'Drei Wege hinein: [Erste Notiz] [Importieren] [KI kennenlernen]', knoepfe.join(' · '));
    check(!(await page.getByLabel('Im Gehirn suchen').count()) && !(await page.locator('.gh__crumb').count()),
      'Über dem leeren Universum steht kein Suchfeld und kein Pfad');
    await page.locator('.gh__state').getByRole('button', { name: 'Erste Notiz', exact: true }).click();
    // Nicht nur die Adresse: der Editor muss offen und sichtbar sein.
    const editorDa = await page.locator('.nw__edit-title').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    const hash = await page.evaluate(() => window.location.hash);
    check(editorDa && hash === '#/notes?neu=notiz', '„Erste Notiz“ öffnet den Editor mit neuem Blatt (Titelfeld sichtbar)', `${hash} · Titelfeld ${editorDa ? 'sichtbar' : 'fehlt'}`);
    await page.keyboard.press('Escape').catch(() => {});

    // „Importieren“ öffnet den Import der Notizen (nicht den Stick).
    await page.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.leer; }, null, { timeout: 15000 }).catch(() => {});
    await page.locator('.gh__state').getByRole('button', { name: 'Importieren', exact: true }).click();
    const importDa = await page.locator('.nw__import-wahl input[type=file]').first().waitFor({ state: 'attached', timeout: 5000 }).then(() => true, () => false);
    const importHash = await page.evaluate(() => window.location.hash);
    check(importDa && importHash.startsWith('#/notes'), '„Importieren“ öffnet den Import von Markdown-Dateien', `${importHash} · Dateiwahl ${importDa ? 'da' : 'fehlt'}`);

    // Voll: 10.000 Notizen, ein Thema mit 2.400, der Rest in 160 Schlagworten.
    // Ebene 1 zeigt hoechstens 2.000 (MAX_KNOTEN) -- die 2.400 pruefen, dass
    // die Kuerzung dasteht statt verschwiegen zu werden.
    // Geschrieben wie ein Import (app.bulkWrite): dabei ruht die Ableitung,
    // und mit ihr die Verbindungsvorschlaege nach dem Speichern. Ohne das
    // stuenden nach 10.000 store.create() 10.000 Vorschlags-Zeitgeber an,
    // die den Server rund 100 s blockieren (gemessen) -- kein Import tut
    // das, weil jeder Import ueber bulkWrite geht. Danach ein neuer
    // Browserkontext, wie nach einem Neustart.
    await page.close();
    const N = 10000;
    const GROSS = 2400;
    const SICHTBAR = 2000;
    const TAGS = 160;
    const t0 = Date.now();
    const ids = [];
    const begriffe = [];
    await app.bulkWrite(async () => {
      store.transaction(() => {
        for (let i = 0; i < 20; i++) begriffe.push(store.create('entity', { name: `Begriff ${i}`, kind: 'topic', description: `Thema ${i}.` }).id);
        for (let i = 0; i < N; i++) {
          const tag = i < GROSS ? 'biologie' : `thema${i % TAGS}`;
          ids.push(store.create('note', { title: `Notiz ${i}`, body: `Inhalt ${i} über ${tag}.`, tags: [tag] }).id);
        }
      });
      store.transaction(() => {
        for (let i = 0; i < GROSS; i++) {
          store.edges.add({ from: ids[i], to: ids[(i + 1) % GROSS], kind: 'links-to', source: 'derived', reason: 'Ring' });
          store.edges.add({ from: ids[i], to: ids[(i * 7 + 13) % GROSS], kind: 'links-to', source: 'derived', reason: 'Quer' });
        }
        for (let i = GROSS; i < N; i++) {
          store.edges.add({ from: ids[i], to: ids[GROSS + ((i - GROSS + TAGS) % (N - GROSS))], kind: 'links-to', source: 'derived', reason: 'Ring' });
          if (i % 5 === 0) store.edges.add({ from: ids[i], to: begriffe[i % 20], kind: 'tagged', source: 'derived', reason: 'Begriff' });
        }
      });
    }, { rederive: false });
    await store.flush();
    const aufbauMs = Date.now() - t0;
    await context.close();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page = await context.newPage();
    page.on('pageerror', (e) => fehler.push(e.message.slice(0, 120)));

    const t1 = Date.now();
    await page.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
    const da = await page.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.themen > 0; }, null, { timeout: 30000 }).then(() => true, () => false);
    const ebene0Ms = Date.now() - t1;
    const route = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/graph/universum')).map((e) => Math.round(e.duration)));
    let z = await gehirn();
    check(da && z && z.ebene === 0 && z.themen >= 2 && z.themen <= 40 && ebene0Ms < 3000,
      `${N.toLocaleString('de-DE')} Einträge: Ebene 0 steht sofort (höchstens 40 Kreise)`,
      `${z ? z.themen : 0} Kreise nach ${ebene0Ms} ms ab Navigation · Route ${route.join('/')} ms · Tresor gebaut in ${aufbauMs} ms`);

    const t2 = Date.now();
    await page.evaluate(() => document.querySelector('.gh').gehirn.tauchen(document.querySelector('.gh').gehirn.themenIds[0]));
    const drin = await page.waitForFunction(() => { const g = document.querySelector('.gh').gehirn; return g.ebene === 1 && g.nodes >= 1000; }, null, { timeout: 30000 }).then(() => true, () => false);
    const ebene1Ms = Date.now() - t2;
    z = await gehirn();
    check(drin && z.nodes >= SICHTBAR, 'Ebene 1 des größten Themas zeigt seine stärksten 2.000 Knoten', `${z && z.thema}: ${z && z.nodes} Knoten nach ${ebene1Ms} ms`);
    const kuerzung = await page.evaluate(() => { const n = document.querySelector('.gh__note'); return n && !n.hidden ? n.innerText.trim() : ''; });
    check(/^2\.000 von 2\.400 Einträgen/.test(kuerzung), 'Das gekürzte Thema sagt es: „2.000 von 2.400 Einträgen – die am stärksten verbundenen …“', kuerzung || 'kein Hinweis');
    const ruht = await page.waitForFunction(() => document.querySelector('.gh').dataset.ruhe === 'ja', null, { timeout: 40000 }).then(() => true, () => false);
    check(ruht, 'Das Netz mit 2.000 Knoten kommt zur Ruhe', `nach ${Date.now() - t2} ms`);
    await warte(300);

    // Bilder je Sekunde, im Browser gezaehlt (siehe oben).
    const bench = (art, dauerMs) => page.evaluate(async ([art, dauerMs]) => {
      const g = document.querySelector('.gh').gehirn;
      const c = document.querySelector('.gh__canvas--netz');
      const r = c.getBoundingClientRect();
      // Ein freier Punkt nahe der Mitte: auf einem Knoten zoege man den Knoten, nicht den Ausschnitt.
      let cx = r.left + r.width / 2;
      let cy = r.top + r.height / 2;
      suche: for (let ring = 0; ring < 30; ring++) {
        for (const [ox, oy] of [[ring * 12, 0], [-ring * 12, 0], [0, ring * 12], [0, -ring * 12], [ring * 9, ring * 9], [-ring * 9, -ring * 9]]) {
          const x = r.width / 2 + ox;
          const y = r.height / 2 + oy;
          if (![[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]].some(([a, b]) => g.nodeAt(x + a, y + b))) { cx = r.left + x; cy = r.top + y; break suche; }
        }
      }
      const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: type === 'pointermove' ? -1 : 0, buttons: art === 'pan' && type !== 'pointerup' ? 1 : 0,
      }));
      if (art === 'pan') ev('pointerdown', cx, cy);
      await new Promise((res) => requestAnimationFrame(res));
      let frames = 0;
      let maxDraw = 0;
      const t0 = performance.now();
      await new Promise((res) => {
        const step = () => {
          frames++;
          const t = (performance.now() - t0) / 1000;
          ev('pointermove', cx + Math.sin(t * 2.5) * 160, cy + Math.cos(t * 1.7) * 90);
          maxDraw = Math.max(maxDraw, g.stats().drawMs);
          if (performance.now() - t0 < dauerMs) requestAnimationFrame(step); else res();
        };
        requestAnimationFrame(step);
      });
      const ms = performance.now() - t0;
      if (art === 'pan') ev('pointerup', cx, cy);
      const s = g.stats();
      return { fps: Math.round((frames / (ms / 1000)) * 10) / 10, frames, maxDrawMs: Math.round(maxDraw), zoom: Math.round(s.zoom * 100) / 100, sichtbar: s.visibleNodes, linien: s.visibleEdges, physik: s.running };
    }, [art, dauerMs]);
    const sage = (r) => `${r.fps} Bilder/s (${r.frames} in 2 s, teuerstes Bild ${r.maxDrawMs} ms) bei Zoom ${r.zoom}, ${r.sichtbar} Knoten / ${r.linien} Linien${r.physik ? ', Physik lief' : ''}`;
    await page.mouse.move(20, 880);
    const panFit = await bench('pan', 2000);
    check(panFit.fps >= 45 && panFit.sichtbar >= SICHTBAR, 'Pan bei 2.000 sichtbaren Knoten, eingepasst: flüssig (Ziel 60 Bilder/s)', sage(panFit));
    for (let i = 0; i < 5; i++) { await page.keyboard.press('+'); await warte(260); }
    await warte(400);
    const panZoom = await bench('pan', 2000);
    check(panZoom.fps >= 45, 'Pan hineingezoomt (Linien quer über den Bildschirm): flüssig dank Zwischenbild', sage(panZoom));
    const hover = await bench('hover', 2000);
    check(hover.fps >= 45, 'Überfahren hineingezoomt: Licht und Zurücktreten ohne Ruckeln', sage(hover));
    const t3 = Date.now();
    await page.keyboard.press('Escape');
    const oben = await page.waitForFunction(() => document.querySelector('.gh').gehirn.ebene === 0, null, { timeout: 10000 }).then(() => true, () => false);
    check(oben, 'Escape führt aus dem großen Thema zurück ins Universum', `nach ${Date.now() - t3} ms`);
    check(!fehler.length, 'Keine Skriptfehler bei 10.000 Einträgen', fehler[0] || '');
  } finally {
    await context.close().catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Ein kleiner Schul-Tresor, wie ihn jemand aus Obsidian mitbringt: echte
 * Markdown-Dateien ueber [Importieren] (Dateiwahl), dann das Gehirn damit.
 * Geprueft wird, was die Pruefer in Runde 1 vermisst haben: Unterthemen sind
 * in Ebene 1 als Bereiche sichtbar und fuehren tiefer (Name antippen), ein
 * Trackpad-Zug taucht ein, ohne das neue Netz weiter zu vergroessern, die
 * Karte rechts verdeckt den gewaehlten Knoten nicht, ein Begriff bietet
 * "Umfeld zeigen" statt eines Oeffnens ins Leere, und die Themenkarte ist
 * direkt aufrufbar und traegt ihren Ort in der Adresse (auch nach Neuladen).
 */
async function pruefeGehirnUnterthemen(browser) {
  const { createApp } = require('../src/app');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-unter-'));
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error' });
  await app.loadModules({});
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const store = app.store;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const fehler = [];
  page.on('pageerror', (e) => fehler.push(e.message.slice(0, 120)));
  const warte = (ms) => page.waitForTimeout(ms);
  const gh = (fn, arg) => page.evaluate(fn, arg);
  // Bis Leinwand und Bereichsnamen stillstehen: nach dem Eintauchen waechst
  // die Netz-Ebene noch (CSS-Uebergang), auch wenn die Physik schon ruht --
  // ein Klick nach Koordinaten von vorher traefe daneben.
  const stillStehen = async () => {
    let vorher = '';
    for (let i = 0; i < 30; i++) {
      const jetzt = await gh(() => {
        const c = document.querySelector('.gh__canvas--netz').getBoundingClientRect();
        const bs = document.querySelector('.gh').gehirn.bereiche();
        return JSON.stringify([Math.round(c.left), Math.round(c.top), Math.round(c.width), bs.map((b) => [Math.round(b.x), Math.round(b.y)])]);
      });
      if (jetzt === vorher) return true;
      vorher = jetzt;
      await warte(200);
    }
    return false;
  };
  const dateien = {
    'Photosynthese.md': '---\ntags: [schule, biologie]\n---\nPflanzen wandeln Licht in Zucker um. Siehe [[Zellatmung]] und [[Chlorophyll]].',
    'Zellatmung.md': 'Umkehrung der [[Photosynthese]]: Zucker wird verbrannt. #biologie #schule',
    'Chlorophyll.md': 'Blattgrün, absorbiert Licht. #biologie #schule',
    'Zelle.md': 'Kleinste Einheit des Lebens, siehe [[Zellatmung]]. #biologie #schule',
    'DNA.md': 'Doppelhelix, Träger der Erbinformation. #biologie #genetik #schule',
    'Mendel.md': 'Vererbungsregeln, siehe [[DNA]]. #biologie #genetik #schule',
    'Mutation.md': 'Veränderung der [[DNA]]. #biologie #genetik #schule',
    'Ökosystem.md': 'Wald und See, siehe [[Photosynthese]]. #biologie #schule',
    'Erster Weltkrieg.md': '1914 bis 1918. #geschichte #schule',
    'Zweiter Weltkrieg.md': 'Folge des [[Erster Weltkrieg]]. #geschichte #schule',
    'Weimarer Republik.md': 'Zwischen [[Erster Weltkrieg]] und [[Zweiter Weltkrieg]]. #geschichte #schule',
    'Französische Revolution.md': '1789. #geschichte #schule',
    'Industrialisierung.md': 'Dampfmaschine und Fabriken. #geschichte #schule',
    'Pasta.md': 'Nudeln al dente, dazu [[Tomatensoße]]. #kochen',
    'Tomatensoße.md': 'Tomaten, Knoblauch, Olivenöl. #kochen',
    'Risotto.md': 'Reis langsam rühren. #kochen',
    'Einkauf.md': 'Milch, Brot.',
    'Ideen.txt': 'Ein Garten auf dem Balkon.',
    'bild.png': 'kein Text',
  };
  const texte = Object.keys(dateien).filter((n) => /\.(md|txt)$/.test(n)).length;
  try {
    /* Import ueber die Oberflaeche: Dateiwahl -> [Importieren]. */
    await page.goto(`${base}/#/notes?neu=import`, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    const wahl = page.locator('.nw__import-wahl input[type=file]').first();
    await wahl.waitFor({ state: 'attached', timeout: 8000 });
    // Als Puffer statt als Pfade: Chromium ohne LANG verliert sonst Dateien mit
    // Umlaut im Namen (gemessen: Ökosystem.md fehlte) -- das waere ein Fehler
    // des Pruefaufbaus, nicht der Seite.
    await wahl.setInputFiles(Object.entries(dateien).map(([name, inhalt]) => ({ name, mimeType: /\.png$/.test(name) ? 'image/png' : 'text/markdown', buffer: Buffer.from(inhalt) })));
    await warte(200);
    const bereit = (await page.locator('.nw__import-status').innerText().catch(() => '')).trim();
    check(new RegExp(`^${texte} Dateien bereit \\(1 andere übersprungen`).test(bereit), 'Import: gewählte Dateien werden gezählt, Fremdes übersprungen', bereit);
    await page.getByRole('button', { name: 'Importieren', exact: true }).last().click();
    const fertig = await page.waitForFunction((n) => {
      const t = [...document.querySelectorAll('.toast')].map((x) => x.innerText).join(' ');
      return new RegExp(`${n} Notizen importiert`).test(t);
    }, texte, { timeout: 20000 }).then(() => true, () => false);
    const kanten = await (async () => {
      for (let i = 0; i < 40; i++) {
        const n = store.all('note').reduce((s, r) => s + store.edges.for(r.id, { direction: 'out' }).filter((e) => e.data.kind === 'links-to').length, 0);
        if (n >= 11) return n;
        await warte(150);
      }
      return store.all('note').reduce((s, r) => s + store.edges.for(r.id, { direction: 'out' }).filter((e) => e.data.kind === 'links-to').length, 0);
    })();
    const tags = (store.all('note').find((r) => r.data.title === 'Photosynthese') || { data: {} }).data.tags || [];
    check(fertig && store.count('note') === texte && kanten >= 11 && tags.includes('biologie'),
      'Import: jede Datei eine Notiz, [[Links]] als Kanten, tags: aus dem Kopf übernommen', `${store.count('note')} Notizen · ${kanten} Wiki-Kanten · Photosynthese: ${tags.join(', ')}`);

    /* Das Universum: Schule traegt Biologie und Geschichte. */
    await page.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.themen > 0; }, null, { timeout: 15000 }).catch(() => {});
    await warte(1200);
    const kreise = await gh(() => document.querySelector('.gh').gehirn.kreise);
    check(kreise.includes('thema:schule') && kreise.includes('thema:kochen'), 'Ebene 0: die importierten Themen stehen als Kreise', kreise.join(', '));

    // Ein Trackpad-Zug ueber Schule taucht ein -- und vergroessert das neue Netz nicht weiter.
    const schule = await gh(() => document.querySelector('.gh').gehirn.screenPosition('thema:schule'));
    const uni = await page.locator('.gh__canvas--uni').boundingBox();
    if (schule && uni) {
      await page.mouse.move(uni.x + schule.x, uni.y + schule.y);
      for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, -40); await warte(16); }
    }
    await page.waitForFunction(() => { const g = document.querySelector('.gh').gehirn; return g.ebene === 1; }, null, { timeout: 8000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.gh').dataset.ruhe === 'ja', null, { timeout: 15000 }).catch(() => {});
    const nachZug = await gh(() => { const g = document.querySelector('.gh').gehirn; return { ebene: g.ebene, thema: g.thema && g.thema.id, zoom: g.stats().zoom }; });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.gh').gehirn.ebene === 0, null, { timeout: 8000 }).catch(() => {});
    await gh(() => document.querySelector('.gh').gehirn.tauchen('thema:schule'));
    await page.waitForFunction(() => document.querySelector('.gh').gehirn.ebene === 1, null, { timeout: 8000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.gh').dataset.ruhe === 'ja', null, { timeout: 15000 }).catch(() => {});
    await stillStehen();
    const eingepasst = await gh(() => document.querySelector('.gh').gehirn.stats().zoom);
    check(nachZug.thema === 'thema:schule' && Math.abs(nachZug.zoom - eingepasst) <= eingepasst * 0.15,
      'Ein Trackpad-Zug über „Schule“ taucht ein und zoomt das neue Netz nicht weiter', `Zoom nach dem Zug ${Math.round(nachZug.zoom * 100) / 100}, eingepasst ${Math.round(eingepasst * 100) / 100}`);

    // Unterthemen: als Bereiche im Netz und als Knoepfe unter dem Pfad.
    const bereiche = await gh(() => document.querySelector('.gh').gehirn.bereiche());
    const chips = (await page.locator('.gh__sub .chip').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const namen = bereiche.map((b) => b.name);
    check(namen.includes('Biologie') && namen.includes('Geschichte') && chips.some((c) => c.startsWith('Biologie')),
      'Ebene 1 „Schule“ zeigt Biologie und Geschichte als Bereiche und als Knöpfe', `Bereiche: ${namen.join(', ')} · Knöpfe: ${chips.join(' · ')}`);
    const netz = await page.locator('.gh__canvas--netz').boundingBox();
    const bio = bereiche.find((b) => b.id === 'thema:biologie');
    if (bio && netz) {
      await page.mouse.click(netz.x + bio.x, netz.y + bio.y);
      // Erst wenn das neue Netz steht, sind Pfad und Adresse nachgezogen.
      await page.waitForFunction(() => {
        const g = document.querySelector('.gh').gehirn;
        return g.thema && g.thema.id === 'thema:biologie' && /biologie/.test(location.hash) && /Biologie/.test(document.querySelector('.gh__crumbs').innerText);
      }, null, { timeout: 8000 }).catch(() => {});
    }
    const tiefer = await gh(() => ({ thema: document.querySelector('.gh').gehirn.thema && document.querySelector('.gh').gehirn.thema.id, pfad: document.querySelector('.gh__crumbs').innerText.replace(/\s+/g, ' ').trim(), hash: location.hash }));
    check(tiefer.thema === 'thema:biologie' && /Schule/.test(tiefer.pfad) && /thema=thema%3Abiologie/.test(tiefer.hash),
      'Den Namen des Bereichs antippen führt tiefer: Mein Wissen › Schule › Biologie', `${tiefer.pfad} · ${tiefer.hash}`);
    await page.keyboard.press('Escape');
    const hoch = await page.waitForFunction(() => { const g = document.querySelector('.gh').gehirn; return g.thema && g.thema.id === 'thema:schule'; }, null, { timeout: 8000 }).then(() => true, () => false);
    check(tiefer.thema === 'thema:biologie' && hoch, 'Escape: eine Ebene hoch, von Biologie zurück nach Schule');

    // Den staerksten Knoten waehlen: die Karte rechts laesst ihn frei.
    await page.waitForFunction(() => document.querySelector('.gh').dataset.ruhe === 'ja', null, { timeout: 15000 }).catch(() => {});
    await stillStehen();
    const hub = await gh(() => {
      const g = document.querySelector('.gh').gehirn;
      let best = null;
      for (const id of g.ids) { const q = g.screenPosition(id); if (q && (!best || q.r > best.r)) best = { id, ...q }; }
      return best;
    });
    if (hub && netz) await page.mouse.click(netz.x + hub.x, netz.y + hub.y);
    await page.locator('.gh__card').waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    await warte(900);
    const frei = await gh(() => {
      const g = document.querySelector('.gh').gehirn;
      const card = document.querySelector('.gh__card').getBoundingClientRect();
      const canvas = document.querySelector('.gh__canvas--netz').getBoundingClientRect();
      const tools = document.querySelector('.gh__tools').getBoundingClientRect();
      const q = g.selectedId ? g.screenPosition(g.selectedId) : null;
      return q ? { x: Math.round(canvas.left + q.x), karte: Math.round(card.left), suche: Math.round(tools.right) } : null;
    });
    check(!!frei && frei.x < frei.karte - 4 && frei.suche <= frei.karte,
      'Die Karte rechts verdeckt den gewählten Knoten nicht, die Suche rückt links daneben', frei ? `Knoten bei x ${frei.x}, Karte ab x ${frei.karte}, Suche bis x ${frei.suche}` : 'nichts gewählt');

    // Ein Begriff: "Umfeld zeigen", kein Oeffnen ins Leere.
    const begriff = store.create('entity', { name: 'Blattgrün', kind: 'topic', description: 'Der grüne Farbstoff der Pflanzen.' });
    for (const titel of ['Chlorophyll', 'Photosynthese']) {
      const n = store.all('note').find((r) => r.data.title === titel);
      if (n) store.edges.add({ from: n.id, to: begriff.id, kind: 'mentions', source: 'derived', reason: 'Begriff im Text' });
    }
    await store.flush();
    // Das Umfeld der Notiz Chlorophyll zeigt den Begriff als Nachbarn; ihn waehlen.
    const chloro = store.all('note').find((r) => r.data.title === 'Chlorophyll');
    await page.goto(`${base}/#/graph?focus=${encodeURIComponent(chloro.id)}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.gh__card').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await warte(600);
    await gh((id) => document.querySelector('.gh').gehirn.select(id), begriff.id);
    await warte(600);
    const kopf = (await page.locator('.gh__card-title').innerText().catch(() => '')).trim();
    const knoepfe = (await page.locator('.gh__card-actions .btn').allInnerTexts()).map((t) => t.trim());
    if (knoepfe.includes('Umfeld zeigen')) await page.locator('.gh__card-actions').getByRole('button', { name: 'Umfeld zeigen' }).click();
    await warte(900);
    const toasts = (await page.locator('.toast').allInnerTexts()).join(' · ');
    const umfeldHash = await page.evaluate(() => location.hash);
    check(kopf === 'Blattgrün' && knoepfe.includes('Umfeld zeigen') && !knoepfe.includes('Öffnen') && !/gibt es nicht|nicht gefunden/.test(toasts)
      && umfeldHash.includes(`focus=${encodeURIComponent(begriff.id)}`),
    'Ein Begriff bietet „Umfeld zeigen“ statt eines Öffnens ins Leere, und es führt in sein Umfeld', `${kopf}: ${knoepfe.join(' · ')} → ${umfeldHash}${toasts ? ` · ${toasts}` : ''}`);

    /* Die Themenkarte: direkt aufrufbar, ihr Ort steht in der Adresse. */
    await page.goto(`${base}/#/graph?ansicht=karte`, { waitUntil: 'domcontentloaded' });
    await page.locator('.wk__tile').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const kacheln = await page.locator('.wk__tile').count();
    check(kacheln >= 2, 'Die Themenkarte öffnet sich beim direkten Aufruf (#/graph?ansicht=karte)', `${kacheln} Kacheln`);
    await page.locator('.wk__tile', { hasText: 'Schule' }).first().click().catch(() => {});
    await warte(900);
    const ort = await page.evaluate(() => location.hash);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.wk__title').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await warte(600);
    const nachReload = (await page.locator('.wk__title').innerText().catch(() => '')).trim();
    check(/ansicht=karte/.test(ort) && /thema=thema%3Aschule/.test(ort) && nachReload === 'Schule',
      'Die Karte trägt ihren Ort in der Adresse und steht nach dem Neuladen wieder bei „Schule“', `${ort} · nach dem Neuladen: ${nachReload || 'nichts'}`);
    const unterzeilen = (await page.locator('.wk__sub').innerText().catch(() => '')).trim();
    check(/\d+ Unterthem/.test(unterzeilen) && !/(^|\D)1 (Unterthemen|Einträge|Einträgen)\b/.test(unterzeilen), 'Die Zahlen darunter sind richtig gebeugt', unterzeilen);
    check(!fehler.length, 'Keine Skriptfehler bei Import, Unterthemen und Karte', fehler[0] || '');
  } finally {
    await context.close().catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Pruefrunde 2: Gehirn und Notizen bleiben behoben                    */
/* ------------------------------------------------------------------ */

/**
 * Was die Pruefer in Runde 2 nur im echten Browser zeigen konnten -- ein
 * Wettlauf, ein Ladefehler, ein Eintrag, der anderswo verschwindet --, hier
 * als feste Pruefpunkte, damit es behoben bleibt (Gehirn 1, 3, 6, 13;
 * Notizen 6, 7, 8). Eigene kleine App: die Faelle brauchen Daten, die im
 * grossen Tresor oben stoeren wuerden.
 */
async function pruefePruefrunde2(browser) {
  const { createApp } = require('../src/app');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-runde2-'));
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error' });
  await app.loadModules({});
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const store = app.store;
  const fehler = [];
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 6; i++) store.create('note', { title: `Schule ${i}`, body: `Mathe ${i}`, tags: ['schule'] });
    for (let i = 0; i < 3; i++) store.create('note', { title: `Physik ${i}`, body: `Kraft ${i}`, tags: ['schule', 'physik'] });
    for (let i = 0; i < 3; i++) store.create('note', { title: `Chemie ${i}`, body: `Stoff ${i}`, tags: ['schule', 'chemie'] });
    for (let i = 0; i < 5; i++) store.create('note', { title: `Kochen ${i}`, body: `Rezept ${i}`, tags: ['kochen'] });
    store.create('entity', { name: 'Biologie', kind: 'topic', description: 'Die Lehre vom Leben.' });
    for (let i = 0; i < 6; i++) store.create('note', { title: `Bio ${i}`, body: `Zelle ${i} #biologie`, tags: ['biologie'] });
    const urlaub = [];
    for (let i = 0; i < 3; i++) urlaub.push(store.create('note', { title: `Urlaub ${i}`, body: `Meer ${i}`, tags: ['urlaub'] }));
    const mitte = store.create('note', { title: 'Mitte', body: 'Siehe [[Schule 0]]' });
    const weg = store.create('note', { title: 'Gleich weg', body: 'x', tags: ['schule'] });
    store.remove(weg.id);
    await warte(500);

    const seite = async (hash, bereit) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', serviceWorkers: 'block' });
      const page = await context.newPage();
      page.on('pageerror', (e) => fehler.push(e.message.slice(0, 120)));
      await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' });
      await dismissWelcome(page);
      if (bereit) await page.waitForFunction(bereit, null, { timeout: 15000 }).catch(() => {});
      await warte(1200);
      return page;
    };
    const zustand = (page) => page.evaluate(() => {
      const g = document.querySelector('.gh');
      const a = g && g.gehirn;
      const schicht = (n) => { const e = document.querySelector(`.gh__layer--${n}`); return e ? e.dataset.zustand : null; };
      return {
        ebene: a ? a.ebene : null,
        nodes: a ? a.nodes : 0,
        kreise: a && Array.isArray(a.kreise) ? a.kreise.length : 0,
        thema: a && a.thema ? a.thema.id : null,
        ansicht: a ? a.ansicht : null,
        uni: schicht('uni'),
        netz: schicht('netz'),
        hash: location.hash,
        karteZu: !!(document.querySelector('.gh__karte') || {}).hidden,
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText.trim()).filter(Boolean),
      };
    });
    const istGehirn = () => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.themen > 0; };
    const imThema = () => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.ebene === 1 && g.gehirn.nodes > 0; };

    // Gehirn 1: Ein Fokus auf einen geloeschten Eintrag -- die Wurzel, keine leere Flaeche.
    {
      const page = await seite('#/graph', istGehirn);
      await page.goto(`${base}/#/notes`, { waitUntil: 'domcontentloaded' });
      await warte(500);
      await page.goto(`${base}/#/graph?focus=${encodeURIComponent(weg.id)}`, { waitUntil: 'domcontentloaded' });
      await warte(2500);
      const z = await zustand(page);
      check(z.ebene === 0 && z.uni === 'da' && z.kreise > 0 && z.hash === '#/graph' && z.toasts.includes('Diesen Eintrag gibt es nicht mehr.'),
        'Gehirn: ein Fokus auf einen gelöschten Eintrag zeigt das Universum mit „Diesen Eintrag gibt es nicht mehr.“', JSON.stringify({ ebene: z.ebene, uni: z.uni, kreise: z.kreise, hash: z.hash, toasts: z.toasts }));
      await page.context().close();
    }

    // Gehirn 3: Laedt das Elternthema nicht (Netz kurz weg), bleibt das Bild stehen.
    {
      const page = await seite(`#/graph?thema=${encodeURIComponent('thema:physik')}`, imThema);
      const vorher = await zustand(page);
      await page.route((url) => url.pathname === '/api/graph/universum' && url.searchParams.get('thema') === 'thema:schule', (route) => route.abort('internetdisconnected'));
      await page.keyboard.press('Escape');
      await warte(1500);
      const z = await zustand(page);
      check(vorher.thema === 'thema:physik' && (z.netz === 'da' || z.uni === 'da') && z.toasts.some((t) => /konnte nicht geladen werden/.test(t)),
        'Gehirn: scheitert das Laden des Elternthemas, bleibt das Bild stehen, und ein Satz sagt es', JSON.stringify({ thema: z.thema, netz: z.netz, uni: z.uni, toasts: z.toasts }));
      await page.context().close();
    }

    // Gehirn 6: [Öffnen] bei einem Begriff in der Karte zeigt sein Umfeld -- sichtbar, Karte zu.
    {
      const page = await seite(`#/graph?ansicht=karte&thema=${encodeURIComponent('thema:biologie')}`, () => !!document.querySelector('.wk__row'));
      const zeile = page.locator('.wk__row', { hasText: 'Biologie' }).filter({ hasText: /Thema/i }).first();
      const da = await zeile.count();
      if (da) await zeile.locator('.icon-button').click();
      await warte(1500);
      const z = await zustand(page);
      check(da > 0 && z.ansicht === 'universum' && z.karteZu && z.ebene === 1 && z.nodes > 0,
        'Gehirn: [Öffnen] bei einem Begriff in der Karte zeigt sein Umfeld (Karte zu, Universum)', JSON.stringify({ zeile: da, ansicht: z.ansicht, karteZu: z.karteZu, ebene: z.ebene, nodes: z.nodes }));
      await page.context().close();
    }

    // Gehirn 13: Was offen ist, verschwindet anderswo -- eine Ebene hoch, mit Meldung.
    {
      const page = await seite(`#/graph?thema=${encodeURIComponent('thema:urlaub')}`, imThema);
      for (const n of urlaub) store.update(n.id, { tags: ['reisen'] });
      store.remove(urlaub[0].id);
      await warte(3500);
      const z = await zustand(page);
      check(z.ebene === 0 && z.hash === '#/graph' && z.toasts.includes('Dieses Thema gibt es nicht mehr.'),
        'Gehirn: verschwindet das offene Thema anderswo, geht es mit „Dieses Thema gibt es nicht mehr.“ zur Wurzel', JSON.stringify({ ebene: z.ebene, hash: z.hash, toasts: z.toasts }));
      await page.context().close();
    }
    {
      const page = await seite(`#/graph?focus=${encodeURIComponent(mitte.id)}`, imThema);
      store.remove(mitte.id);
      await warte(3500);
      const z = await zustand(page);
      check(z.ebene === 0 && z.hash === '#/graph' && z.toasts.includes('Diesen Eintrag gibt es nicht mehr.'),
        'Gehirn: wird der Eintrag des Umfelds gelöscht, geht es mit Meldung zur Wurzel', JSON.stringify({ ebene: z.ebene, hash: z.hash, toasts: z.toasts }));
      await page.context().close();
    }

    // Gehirn 5: Wo die Karte steht, entscheidet das CSS (Container-Abfrage) -- und der Code
    // rechnet mit derselben Lage: kein gewaehlter Knoten liegt unter der Karte.
    {
      const ids = [store.create('note', { title: 'Zelle', body: 'Grundbaustein', tags: ['schule', 'anatomie'] }).id];
      for (let i = 0; i < 12; i++) ids.push(store.create('note', { title: `Anatomie ${i}`, body: `Teil von [[Zelle]] ${i}`, tags: ['schule', 'anatomie'] }).id);
      await warte(600);
      const lagen = new Set();
      for (const [vw, vh] of [[1024, 768], [1440, 900]]) {
        const context = await browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: 'dark', serviceWorkers: 'block' });
        const page = await context.newPage();
        page.on('pageerror', (e) => fehler.push(e.message.slice(0, 120)));
        await page.goto(`${base}/#/graph?thema=${encodeURIComponent('thema:anatomie')}`, { waitUntil: 'domcontentloaded' });
        await dismissWelcome(page);
        await page.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.ebene === 1 && g.gehirn.nodes > 5; }, null, { timeout: 15000 }).catch(() => {});
        await page.waitForFunction(() => document.querySelector('.gh').dataset.ruhe === 'ja', null, { timeout: 20000 }).catch(() => {});
        await warte(500);
        let verdeckt = 0;
        let gezaehlt = 0;
        let lage = null;
        for (const id of ids.slice(0, 5)) {
          const p = await page.evaluate((nid) => {
            const g = document.querySelector('.gh').gehirn;
            const c = document.querySelector('.gh__canvas--netz').getBoundingClientRect();
            const s = g.screenPosition(nid);
            return s ? { x: c.left + s.x, y: c.top + s.y } : null;
          }, id);
          if (!p) continue;
          await page.mouse.click(p.x, p.y);
          await warte(900);
          const r = await page.evaluate((nid) => {
            const g = document.querySelector('.gh').gehirn;
            const root = document.querySelector('.gh').getBoundingClientRect();
            const c = document.querySelector('.gh__canvas--netz').getBoundingClientRect();
            const karte = document.querySelector('.gh__card');
            const k = karte.getBoundingClientRect();
            const s = g.screenPosition(nid);
            const x = c.left + s.x;
            const y = c.top + s.y;
            const krumen = [...document.querySelectorAll('.gh__crumb')];
            const letzte = krumen[krumen.length - 1];
            return {
              gewaehlt: g.selectedId === nid,
              steht: k.top - root.top > 40 ? 'unten' : 'rechts',
              css: getComputedStyle(karte).getPropertyValue('--gh-karte').trim(),
              darunter: x >= k.left && x <= k.right && y >= k.top && y <= k.bottom,
              krumen: krumen.length,
              pfad: krumen.map((b) => b.innerText.replace(/\s+/g, ' ').trim()).join(' › '),
              letzteGanz: letzte ? letzte.scrollWidth <= letzte.clientWidth + 1 : null,
            };
          }, id);
          if (!r.gewaehlt) continue;
          gezaehlt++;
          if (r.darunter) verdeckt++;
          if (!lage) lage = r;
          lagen.add(r.steht);
          await page.keyboard.press('Escape');
          await warte(400);
        }
        check(gezaehlt >= 3 && lage && lage.steht === lage.css && verdeckt === 0,
          `Gehirn bei ${vw}×${vh}: die Karte steht, wo das CSS sie hinlegt, und verdeckt keinen gewählten Knoten`,
          lage ? `Karte ${lage.steht}, CSS „${lage.css}“, ${verdeckt} von ${gezaehlt} verdeckt` : `${gezaehlt} gewählt`);
        // Eng wird es neben der offenen Karte: die aktuelle Stufe bleibt ganz, gekuerzt wird darueber.
        check(!!lage && lage.krumen >= 3 && lage.letzteGanz === true,
          `Gehirn bei ${vw}×${vh} mit offener Karte: die aktuelle Stufe im Pfad bleibt ganz lesbar`,
          lage ? `${lage.pfad} (${lage.krumen} Stufen)` : '');
        await context.close();
      }
      check(lagen.has('unten') && lagen.has('rechts'), 'Gehirn: schmal steht die Karte unten, breit rechts', [...lagen].join(', '));
    }

    // Notizen 6: Das offene Blatt zeigt eine Aenderung von anderswo (iPad, KI) -- auch bei langsamer Wand.
    {
      const n = store.create('note', { title: 'Einkauf', body: 'Milch, Brot' });
      const page = await seite(`#/notes?id=${encodeURIComponent(n.id)}`, () => !!document.querySelector('.nw__read .nw__prose'));
      await page.route(/\/api\/notizen\?/, async (route) => { await warte(300); await route.continue(); });
      store.update(n.id, { body: 'Milch, Brot, Eier (vom iPad)' });
      await warte(2500);
      const prosa = await page.locator('.nw__read .nw__prose').innerText().catch(() => '');
      check(/Eier \(vom iPad\)/.test(prosa), 'Notizen: das offene Blatt zeigt eine Änderung von anderswo, auch wenn die Wand langsam lädt', prosa.slice(0, 60));
      await page.context().close();
    }

    // Notizen 7: Eine Notiz antippen, waehrend der Server langsam ist, dann gleich „Neue Notiz“ -- das Getippte bleibt.
    {
      const a = store.create('note', { title: 'Lernplan', body: 'Siehe [[Zellatmung]] und [[Photosynthese]].' });
      const page = await seite('#/notes', () => !!document.querySelector('.nw__note'));
      await page.route(/\/api\/notizen\/aufloesen/, async (route) => { await warte(1500); await route.continue(); });
      await page.click(`.nw__note[data-id="${a.id}"]`);
      await warte(150);
      await page.click('button[data-nw-plus]');
      await page.click('button[data-neu="notiz"]');
      await page.waitForSelector('input.nw__edit-title', { timeout: 5000 }).catch(() => {});
      await page.fill('input.nw__edit-title', 'Idee');
      await page.click('textarea.nos-ne__area');
      await page.keyboard.type('Wichtiger Gedanke, den ich gerade tippe.');
      await warte(2000);
      const titel = await page.locator('input.nw__edit-title').inputValue().catch(() => null);
      const textInhalt = await page.locator('textarea.nos-ne__area').inputValue().catch(() => null);
      check(titel === 'Idee' && /Wichtiger Gedanke, den ich gerade tippe\./.test(textInhalt || ''),
        'Notizen: eine langsam ladende Notiz verdrängt die gerade begonnene neue nicht', JSON.stringify({ titel, text: textInhalt }));
      await page.context().close();
    }

    // Notizen 8: [Anheften] und gleich [Bearbeiten] -- der Editor bleibt, das Getippte auch.
    {
      const a = store.create('note', { title: 'Vorrat', body: 'Milch' });
      const page = await seite(`#/notes?id=${encodeURIComponent(a.id)}`, () => !!document.querySelector('.nw__read'));
      await page.route(/\/api\/notizen\?/, async (route) => { await warte(700); await route.continue(); });
      await page.click('.nw__read-foot button:has-text("Anheften")');
      await warte(100);
      await page.click('.nw__read-foot button:has-text("Bearbeiten")');
      await page.waitForSelector('textarea.nos-ne__area', { timeout: 5000 }).catch(() => {});
      await page.click('textarea.nos-ne__area');
      await page.keyboard.press('Control+End');
      await page.keyboard.type(', Brot, Eier');
      await warte(1300);
      const textInhalt = await page.locator('textarea.nos-ne__area').inputValue().catch(() => null);
      check(/Milch, Brot, Eier\s*$/.test(textInhalt || '') && store.get(a.id).data.pinned === true,
        'Notizen: [Anheften] und gleich [Bearbeiten] – angeheftet, und der Editor behält das Getippte', JSON.stringify({ text: textInhalt, angeheftet: store.get(a.id).data.pinned }));
      await page.context().close();
    }

    check(!fehler.length, 'Keine Seitenfehler dabei', fehler.join(' | '));
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* egal */ }
  }
}

/* ------------------------------------------------------------------ */
/* Kalender, Notizen, Projekte                                         */
/* ------------------------------------------------------------------ */

/**
 * Kalender, Notizwand und Projekte, jeweils mit dem, was der Nutzer dort
 * wirklich tut: einen Termin eintragen und loeschen, dem automatischen
 * Termin zu seinem Chat folgen, eine Notiz anheften, eine Aufgabe abhaken.
 * Jedes Mal wird im Tresor nachgesehen, nicht auf dem Bildschirm. Dazu die
 * beiden Kacheln rechts: sie muessen einen neuen Termin und eine neue Notiz
 * ohne Neuladen zeigen (Bus), sonst sind sie ein Standbild.
 */
async function pruefeKalenderNotizenProjekte(page, base, store) {
  const warte = (ms) => page.waitForTimeout(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const heute = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const termine = () => store.all('event');

  /* --- Kalender: Monatsblatt --- */
  await page.goto(`${base}/#/kalender`, { waitUntil: 'domcontentloaded' });
  await warte(1200);
  const blatt = await page.evaluate(() => ({
    tage: document.querySelectorAll('.kal__weeks .kal__day').length,
    heute: document.querySelectorAll('.kal__day.is-today').length,
  }));
  check(blatt.tage >= 28 && blatt.tage <= 42 && blatt.tage % 7 === 0 && blatt.heute === 1,
    'Der Kalender zeigt ein Monatsblatt aus ganzen Wochen, heute ist markiert', `${blatt.tage} Tage, ${blatt.heute}× heute`);

  /* --- Schnell eintragen: ein Satz, Vorschau, Enter --- */
  // "heute" ausdruecklich: so trifft die Pruefung zu jeder Tageszeit denselben Tag.
  const vorher = termine().length;
  const feld = page.getByRole('textbox', { name: 'Neuer Termin' });
  await feld.fill('heute 10:00-10:30 Probe beim Zahnarzt');
  await warte(400);
  const vorschau = (await page.locator('.kal__quick-pop').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/10:00–10:30/.test(vorschau) && /Probe beim Zahnarzt/.test(vorschau),
    'Schnell eintragen: die Vorschau sagt vorher, was daraus wird', vorschau.slice(0, 80));
  await feld.press('Enter');
  await warte(1300);
  const probe = termine().find((t) => t.data.title === 'Probe beim Zahnarzt');
  check(termine().length === vorher + 1 && !!probe && probe.data.start === `${heute}T10:00` && probe.data.end === `${heute}T10:30`,
    '„heute 10:00-10:30 Probe beim Zahnarzt“ + Enter legt ihn wirklich im Tresor an',
    probe ? `${probe.data.start}–${probe.data.end}, Herkunft ${probe.data.source}` : `${vorher} → ${termine().length}`);
  check(!!probe && probe.data.source === 'user', 'und zwar als „von dir“, nicht als von der KI');
  check(await page.locator('.kal__day.is-today .kal__pill', { hasText: 'Probe beim Zahnarzt' }).count() === 1,
    'Er steht sofort am heutigen Tag');

  await feld.fill('heute 12:00 Wegwerf-Termin');
  await warte(300);
  await feld.press('Enter');
  await warte(1300);
  const wegwerf = termine().find((t) => t.data.title === 'Wegwerf-Termin');
  const zurueckKnopf = page.locator('.toast', { hasText: 'Wegwerf-Termin' }).getByRole('button', { name: 'Rückgängig' });
  if (wegwerf && await zurueckKnopf.count()) {
    await zurueckKnopf.first().click();
    await warte(1300);
    check(store.get(wegwerf.id) === null, '„Rückgängig“ nimmt einen gerade eingetragenen Termin wieder heraus');
  } else {
    bad('Nach dem Eintragen steht „Rückgängig“ bereit', wegwerf ? 'kein Knopf in der Meldung' : 'nicht angelegt');
  }

  /* --- das ganze Formular, mit Erinnerung --- */
  await page.getByRole('button', { name: 'Mit allen Feldern anlegen' }).click();
  await warte(400);
  await page.getByLabel('Titel', { exact: true }).fill('Formular-Probe');
  await page.getByLabel('von', { exact: true }).fill('13:00');
  await page.getByLabel('bis', { exact: true }).fill('13:45');
  await page.getByLabel('Erinnerung', { exact: true }).selectOption('15');
  await page.getByRole('button', { name: /^Eintragen$/ }).click();
  await warte(1300);
  const formular = termine().find((t) => t.data.title === 'Formular-Probe');
  check(!!formular && formular.data.start === `${heute}T13:00` && formular.data.end === `${heute}T13:45` && formular.data.reminder === 15,
    'Das Formular legt Titel, Zeit und Erinnerung im Tresor an',
    formular ? `${formular.data.start}–${formular.data.end}, Erinnerung ${formular.data.reminder}` : 'nicht angelegt');
  const imDetail = (await page.locator('.kal__sheet').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/Von dir eingetragen/.test(imDetail) && /15 Min vorher/.test(imDetail) && /solange Neural OS offen ist/.test(imDetail),
    'Das Blatt sagt, woher er kommt, und ehrlich, wann erinnert wird', imDetail.slice(0, 110));

  /* --- ein automatischer Termin, live, mit Weg zurueck in den Chat --- */
  const chat = store.create('chat', { title: 'Terminabsprache' });
  const auto = store.create('event', { title: 'Rückruf Werkstatt', start: `${heute}T08:00`, end: `${heute}T08:15`, source: 'auto', chatId: chat.id });
  await store.flush();
  await warte(1500);
  check(await page.locator('.kal__day.is-today .kal__pill', { hasText: 'Rückruf Werkstatt' }).count() === 1,
    'Ein Termin, den die KI anlegt, erscheint ohne Neuladen');
  await page.goto(`${base}/#/kalender?id=${auto.id}`, { waitUntil: 'domcontentloaded' });
  await warte(1300);
  const autoText = (await page.locator('.kal__sheet').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/Von der KI aus dem Chat „Terminabsprache“/.test(autoText),
    'Ein Termin der KI nennt den Chat, aus dem er stammt', autoText.slice(0, 100));
  const zumChat = page.getByRole('button', { name: /Zum Chat/ });
  if (await zumChat.count()) {
    await zumChat.first().click();
    await warte(900);
    check(page.url().endsWith(`#/chat?id=${chat.id}`), '„Zum Chat“ führt in genau dieses Gespräch', page.url().split('#')[1]);
  } else {
    bad('„Zum Chat“ ist am Termin der KI');
  }

  /* --- Woche: ziehen verschiebt, im Tresor, mit Rückgängig --- */
  await page.goto(`${base}/#/kalender`, { waitUntil: 'domcontentloaded' });
  await warte(1200);
  await page.getByRole('button', { name: /^Woche$/ }).click();
  await warte(900);
  const stunde = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.kal')).getPropertyValue('--kal-hour')));
  const ziehe = async (locator, dy, dx = 0, oben = 5) => {
    await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + oben);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + oben + dy, { steps: 8 });
    await page.mouse.up();
  };
  if (probe) {
    await ziehe(page.locator('.kal__block', { hasText: 'Probe beim Zahnarzt' }).first(), stunde);
    await warte(1300);
    const gezogen = store.get(probe.id);
    check(!!gezogen && gezogen.data.start === `${heute}T11:00` && gezogen.data.end === `${heute}T11:30`,
      'Woche: eine Stunde tiefer gezogen ist der Termin im Tresor eine Stunde später', gezogen ? `${gezogen.data.start}–${gezogen.data.end}` : 'weg');
    const rueck = page.locator('.toast', { hasText: 'Probe beim Zahnarzt' }).getByRole('button', { name: 'Rückgängig' });
    if (await rueck.count()) {
      await rueck.first().click();
      await warte(1300);
      check(store.get(probe.id).data.start === `${heute}T10:00`, 'und „Rückgängig“ legt ihn zurück auf 10:00', store.get(probe.id).data.start);
    } else {
      bad('Nach dem Ziehen steht „Rückgängig“ bereit');
    }
  }

  /* --- Serie: "Nur dieser Termin" --- */
  const { createEvent } = require('../src/http/api/events');
  const serie = createEvent(store, {
    title: 'Serien-Probe', start: `${heute}T15:00`, end: `${heute}T15:30`,
    recurrence: { freq: 'daily', interval: 1, until: null, count: 3 },
  });
  await store.flush();
  await warte(1500);
  const vorkommen = page.locator(`.kal__block[data-key="${serie.id}@${heute}"]`);
  if (!(await vorkommen.count())) {
    bad('Eine Serie erscheint je Vorkommen im Raster', 'heutiges Vorkommen nicht gefunden');
  } else {
    await ziehe(vorkommen, stunde);
    await warte(600);
    const frage = page.locator('.kal__frage');
    check(await frage.count() === 1, 'Serie gezogen: die Frage „Nur dieser Termin / Alle“ erscheint');
    if (await frage.count()) {
      await frage.getByRole('button', { name: 'Nur dieser Termin' }).click();
      await warte(1400);
      const danach = store.get(serie.id);
      const einzeln = termine().filter((t) => t.data.title === 'Serien-Probe' && t.id !== serie.id);
      check((danach.data.exdates || []).includes(heute) && einzeln.length === 1 && einzeln[0].data.start === `${heute}T16:00`,
        '„Nur dieser Termin“: der Tag fällt aus der Serie, ein Einzeltermin um 16:00 entsteht',
        `exdates ${JSON.stringify(danach.data.exdates)}, einzeln ${einzeln.map((t) => t.data.start).join(', ')}`);
    }
  }

  /* --- Serie: "Alle" verschiebt die Serie selbst, nicht nur das Vorkommen --- */
  {
    const vor14 = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 14);
    const beginn = `${vor14.getFullYear()}-${pad(vor14.getMonth() + 1)}-${pad(vor14.getDate())}`;
    const wtCode = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()];
    const alle = createEvent(store, {
      title: 'Alle-Probe', start: `${beginn}T17:00`, end: `${beginn}T17:45`,
      recurrence: { freq: 'weekly', interval: 1, byDay: [wtCode], until: null, count: null },
    });
    await store.flush();
    await warte(1500);
    const heutiges = page.locator(`.kal__block[data-key="${alle.id}@${heute}"]`);
    if (!(await heutiges.count())) {
      bad('Eine woechentliche Serie mit Vorgeschichte erscheint heute im Raster', 'nicht gefunden');
    } else {
      await ziehe(heutiges, stunde);
      await warte(600);
      await page.locator('.kal__frage').getByRole('button', { name: 'Alle' }).click().catch(() => {});
      await warte(1400);
      const danach = store.get(alle.id);
      check(danach.data.start === `${beginn}T18:00` && danach.data.end === `${beginn}T18:45`
        && termine().filter((t) => t.data.title === 'Alle-Probe').length === 1,
      '„Alle“: die ganze Serie beginnt eine Stunde später – ab ihrem ersten Tag, ohne Einzeltermin',
      `${danach.data.start}–${danach.data.end}`);
    }
  }

  /* --- ein Klick auf den unteren Rand ohne Ziehen aendert nichts --- */
  if (probe) {
    const block = page.locator('.kal__block', { hasText: 'Probe beim Zahnarzt' }).first();
    await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await block.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
    await warte(900);
    const blattTitel = (await page.locator('.kal__sheet h2').innerText().catch(() => '')).trim();
    check(store.get(probe.id).data.end === `${heute}T10:30` && blattTitel === 'Probe beim Zahnarzt',
      'Ein Klick auf den unteren Rand (ohne Ziehen) ändert die Dauer nicht, sondern öffnet den Termin',
      `Ende ${store.get(probe.id).data.end}, Blatt „${blattTitel}“`);
    await page.keyboard.press('Escape');
    await warte(300);
  }

  /* --- beim Verlaengern zeigt der Geist das Ende, das man gerade waehlt --- */
  if (probe) {
    const block = page.locator('.kal__block', { hasText: 'Probe beim Zahnarzt' }).first();
    await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await block.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3 + stunde, { steps: 6 });
    const geist = await page.evaluate(() => {
      const g = document.querySelector('.kal__block.is-ghost');
      if (!g) return null;
      const bis = g.querySelector('.kal__block-bis');
      const r = bis ? bis.getBoundingClientRect() : null;
      const gr = g.getBoundingClientRect();
      return { bis: bis ? bis.textContent : '', breite: Math.round(gr.width), sichtbar: !!r && r.width > 0 && getComputedStyle(bis).display !== 'none' && r.right <= gr.right + 1 };
    });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await warte(900);
    check(!!geist && geist.sichtbar && geist.bis === '–11:30', 'Beim Verlängern zeigt der Geist das neue Ende, auch in einer schmalen Spalte',
      geist ? `Ende „${geist.bis}“, sichtbar: ${geist.sichtbar}, Geist ${geist.breite} px` : 'kein Geist');
    check(store.get(probe.id).data.end === `${heute}T10:30`, 'Escape bricht das Ziehen ab – nichts geändert', store.get(probe.id).data.end);
  }

  /* --- Blaettern: die Termine der neuen Woche stehen im Bild --- */
  {
    const in7 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
    const tag7 = `${in7.getFullYear()}-${pad(in7.getMonth() + 1)}-${pad(in7.getDate())}`;
    const frueh = createEvent(store, { title: 'Frühe Probe', start: `${tag7}T06:00`, end: `${tag7}T06:45` });
    await store.flush();
    await page.locator('.kal__nav button').last().click();
    await warte(1400);
    const lage = await page.evaluate((key) => {
      const sc = document.querySelector('.kal__rscroll');
      const el = document.querySelector(`.kal__block[data-key="${key}@"]`);
      if (!sc || !el) return null;
      const s = sc.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { imBild: r.top >= s.top - 1 && r.bottom <= s.bottom + 1, scrollTop: Math.round(sc.scrollTop) };
    }, frueh.id);
    check(!!lage && lage.imBild, 'Eine Woche weiter: der erste Termin der neuen Woche (06:00) steht im Bild, statt über dem Rand',
      lage ? `scrollTop ${lage.scrollTop}` : 'Termin nicht gefunden');
    // Liegt ein Termin ausserhalb des Ausschnitts, sagt es ein Hinweis am Rand der Spalte.
    await page.evaluate(() => { const sc = document.querySelector('.kal__rscroll'); sc.scrollTop = sc.scrollHeight; });
    await warte(400);
    const hinweis = (await page.locator(`.kal__rand.is-oben .kal__rand-zelle[data-day="${tag7}"] .kal__rand-knopf`).innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/06:00/.test(hinweis), 'Nach unten gescrollt: oben in der Spalte steht „06:00 …“ als Hinweis', hinweis || 'kein Hinweis');
    await page.locator('.kal__rand.is-oben .kal__rand-knopf').first().click().catch(() => {});
    await warte(900);
    const zurueck = await page.evaluate((key) => {
      const sc = document.querySelector('.kal__rscroll');
      const el = document.querySelector(`.kal__block[data-key="${key}@"]`);
      if (!sc || !el) return false;
      const s = sc.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
    }, frueh.id);
    check(zurueck, 'und der Hinweis scrollt beim Antippen zu ihm');
    store.remove(frueh.id);
    await store.flush();
    await page.getByRole('button', { name: /^Heute$/ }).click();
    await warte(1000);
  }

  /* --- am unteren Rand ziehen verlaengert --- */
  if (probe) {
    const block = page.locator('.kal__block', { hasText: 'Probe beim Zahnarzt' }).first();
    await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await block.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3 + stunde / 2, { steps: 6 });
    await page.mouse.up();
    await warte(1300);
    check(store.get(probe.id).data.end === `${heute}T11:00`, 'Der untere Rand, eine halbe Stunde tiefer gezogen, verlängert bis 11:00',
      store.get(probe.id).data.end);
    const rueck = page.locator('.toast', { hasText: 'Probe beim Zahnarzt' }).getByRole('button', { name: 'Rückgängig' });
    if (await rueck.count()) {
      await rueck.first().click();
      await warte(1300);
    }
    check(store.get(probe.id).data.end === `${heute}T10:30`, 'und „Rückgängig“ kürzt ihn wieder auf 10:30', store.get(probe.id).data.end);
  }

  /* --- loeschen: ohne Rueckfrage, dafuer mit Rueckgaengig --- */
  if (probe) {
    await page.goto(`${base}/#/kalender?id=${probe.id}`, { waitUntil: 'domcontentloaded' });
    await warte(1300);
    await page.locator('.kal__sheet').getByRole('button', { name: /Löschen/ }).click();
    await warte(1200);
    check(store.get(probe.id) === null && !!store.get(probe.id, { includeDeleted: true }),
      '„Löschen“ nimmt ihn aus dem Kalender – weich, also umkehrbar');
    check(await page.locator('.kal__block, .kal__pill', { hasText: 'Probe beim Zahnarzt' }).count() === 0,
      'und er verschwindet aus der Ansicht');
    const wieder = page.locator('.toast', { hasText: 'Probe beim Zahnarzt' }).getByRole('button', { name: 'Rückgängig' });
    if (await wieder.count()) {
      await wieder.first().click();
      await warte(1300);
      check(!!store.get(probe.id), '„Rückgängig“ holt den gelöschten Termin zurück');
    } else {
      bad('Nach dem Löschen steht „Rückgängig“ bereit');
    }
  }

  /* --- Tasten: L, M, T --- */
  await page.keyboard.press('Escape');
  await warte(300);
  await page.locator('.kal__title').click();
  await page.keyboard.press('l');
  await warte(900);
  const liste = (await page.locator('.kal__liste').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/Heute/.test(liste) && /Probe beim Zahnarzt|Formular-Probe/.test(liste), 'Taste L zeigt „Als Nächstes“ ab heute', liste.slice(0, 80));
  await page.keyboard.press('m');
  await warte(900);
  check(await page.locator('.kal__weeks').count() === 1, 'Taste M zurück zum Monat');

  /* --- Ein ausgefallener Tag einer Serie (Karte "Termin fällt einmal aus" -> Öffnen) --- */
  {
    const gitarre = store.create('event', {
      title: 'Gitarre-Probe', start: '2026-10-07T17:00', end: '2026-10-07T17:45', allDay: false, source: 'user',
      recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'], until: '2026-10-28', count: null }, exdates: ['2026-10-14'],
    });
    await store.flush();
    await page.goto(`${base}/#/kalender?id=${gitarre.id}&am=2026-10-14`, { waitUntil: 'domcontentloaded' });
    await warte(1500);
    const blattText = (await page.locator('.kal__sheet').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const knoepfe = await page.locator('.kal__sheet button').allInnerTexts().catch(() => []);
    check(/fällt aus/i.test(blattText) && !knoepfe.some((k) => /Bearbeiten|Löschen/.test(k)),
      'Ein ausgefallener Tag öffnet als „fällt aus“ – ohne Bearbeiten/Löschen eines Termins, den es nicht gibt', blattText.slice(0, 90));
    const doch = page.locator('.kal__sheet').getByRole('button', { name: 'Doch stattfinden lassen' });
    if (await doch.count()) {
      await doch.click();
      await warte(1300);
      check((store.get(gitarre.id).data.exdates || []).length === 0, '„Doch stattfinden lassen“ nimmt den Tag aus den Ausnahmen',
        JSON.stringify(store.get(gitarre.id).data.exdates));
    } else {
      bad('Am ausgefallenen Tag steht „Doch stattfinden lassen“ bereit');
    }
    store.remove(gitarre.id);
    await store.flush();
  }

  /* --- Erinnerung im Kopf, solange Neural OS offen ist --- */
  const bald = new Date(Date.now() + 10 * 60000);
  const wandzeit = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  store.create('event', { title: 'Erinnerungs-Probe', start: wandzeit(bald), end: wandzeit(new Date(bald.getTime() + 30 * 60000)), location: 'Flur', reminder: 15 });
  await store.flush();
  await warte(1800);
  const karte = page.locator('.erin__card', { hasText: 'Erinnerungs-Probe' });
  const karteText = (await karte.innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(await karte.count() === 1 && /In \d+ Min/.test(karteText), 'Eine Erinnerung erscheint im Kopf, ohne Neuladen', karteText.slice(0, 80));
  if (await karte.count()) {
    // Sie liegt in der freien Mitte des Kopfes -- nicht auf "Suchen", "Übersicht" oder einer Kachel.
    const verdeckt = await page.evaluate(() => {
      const k = document.querySelector('.erin__card');
      return [...document.querySelectorAll('button, a, input, [role="button"]')]
        .filter((el) => !k.contains(el) && el.getBoundingClientRect().width > 0)
        .filter((el) => {
          const q = el.getBoundingClientRect();
          const x = q.x + q.width / 2;
          const y = q.y + q.height / 2;
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
          const hit = document.elementFromPoint(x, y);
          return hit && k.contains(hit);
        })
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30));
    });
    check(!verdeckt.length, 'Die Erinnerung verdeckt keinen Knopf (Suchen, Übersicht, Kacheln)', verdeckt.join(' · ') || 'nichts verdeckt');
    await karte.getByRole('button', { name: 'Erinnerung schließen' }).click();
    await warte(300);
    check(await karte.count() === 0, 'und geht mit dem Kreuz wieder weg');
  }

  /* --- iPad: "In Kalender übernehmen (.ics)" ist ein Fingerziel (Vertrag D) --- */
  if (probe) {
    const ipad = await page.context().browser().newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    try {
      const p2 = await ipad.newPage();
      await p2.goto(`${base}/#/kalender?id=${probe.id}`, { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(900);
      await dismissWelcome(p2);
      await p2.locator('.kal__sheet .kal__fact-ics').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const mass = await p2.evaluate(() => [...document.querySelectorAll('.kal__sheet .kal__fact-ics, .kal__sheet .kal__fact a')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => ({ text: el.textContent.trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) })));
      const zuKlein = mass.filter((x) => x.h < 44);
      check(mass.length > 0 && !zuKlein.length, 'iPad: „In Kalender übernehmen (.ics)“ und die Links im Blatt sind mindestens 44 px hoch',
        mass.map((x) => `${x.text}: ${x.h} px`).join(' · ') || 'kein Link im Blatt');
    } finally {
      await ipad.close();
    }
  }

  /* --- die Kachel "Kalender", live --- */
  await page.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
  await warte(1500);
  const kachel = page.locator('.tile[data-tile="kalender"]');
  const kachelText = (await kachel.innerText().catch(() => '')).replace(/\s+/g, ' ');
  // Wie viele Termine heute sind, sagt der Server (Serien je Vorkommen); die
  // Kachel zeigt davon hoechstens drei -- die noch kommenden zuerst -- und
  // nennt den Rest. Gezaehlt, nicht nach einem Titel gesucht: welcher Termin
  // um diese Uhrzeit schon vorbei ist, haengt davon ab, wann die Pruefung laeuft.
  const heuteZahl = await page.evaluate(async (tag) => {
    const r = await fetch(`/api/events/zeitraum?from=${tag}&to=${tag}`, { headers: { Accept: 'application/json' } });
    return r.ok ? (await r.json()).items.length : -1;
  }, heute);
  const zeilen = await kachel.locator('.kwk__row').count();
  const weitere = (await kachel.locator('.kwk__more').innerText().catch(() => '')).trim();
  check(/Heute, /.test(kachelText) && heuteZahl > 0 && zeilen === Math.min(3, heuteZahl)
    && (heuteZahl <= 3 ? weitere === '' : weitere.includes(String(heuteZahl - 3))),
  'Die Kachel „Kalender“ zeigt die heutigen Termine – höchstens drei, der Rest als Zahl',
  `${zeilen} Zeilen von ${heuteZahl}${weitere ? `, „${weitere}“` : ''}`);
  if (weitere) {
    const ziel = await kachel.locator('.kwk__more').getAttribute('href');
    check(ziel === `#/kalender?ansicht=tag&tag=${heute}`, '„+ n weitere heute“ führt zu heute als Tag, nicht ins gemerkte Monatsblatt', ziel);
  }
  // In fuenf Minuten (vor Mitternacht: 23:59) -- noch nicht vorbei, also sichtbar.
  const gleich = new Date(Date.now() + 5 * 60000);
  const paketBeginn = gleich.getDate() === d.getDate() ? `${heute}T${pad(gleich.getHours())}:${pad(gleich.getMinutes())}` : `${heute}T23:59`;
  store.create('event', { title: 'Paket abholen', start: paketBeginn });
  await store.flush();
  await warte(1600);
  check(/Paket abholen/.test(await kachel.innerText().catch(() => '')),
    'und einen neuen Termin von heute ohne Neuladen – was gleich kommt, steht vor dem, was vorbei ist', paketBeginn.slice(11));

  /* --- Notizwand: Herkunft, anheften, Kachel --- */
  const notiz = store.create('note', { title: 'Fragen für die Werkstatt', body: 'Bremsen prüfen lassen.', source: 'auto', chatId: chat.id });
  await store.flush();
  await warte(1500);
  const notizKachel = (await page.locator('.tile[data-tile="notizen"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/Fragen für die Werkstatt/.test(notizKachel) && /Terminabsprache/.test(notizKachel),
    'Die Kachel „Notizen“ zeigt die neueste automatische Notiz, live, mit ihrem Chat', notizKachel.slice(0, 90));
  await page.goto(`${base}/#/notes`, { waitUntil: 'domcontentloaded' });
  await warte(1300);
  const zettel = page.locator('.nw__note', { hasText: 'Fragen für die Werkstatt' });
  const zettelText = (await zettel.innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/aus dem Chat „Terminabsprache“/.test(zettelText),
    'Auf der Wand sagt jede Notiz, aus welchem Chat sie stammt', zettelText.slice(0, 90));
  if (await zettel.count()) {
    await zettel.first().click();
    await warte(700);
    await page.locator('.nw__read').getByRole('button', { name: /^Anheften$/ }).click();
    await warte(1300);
    check(store.get(notiz.id).data.pinned === true, '„Anheften“ steht danach wirklich im Tresor');
    await page.keyboard.press('Escape');
    await warte(500);
    check(await page.locator('.nw__note.is-pinned', { hasText: 'Fragen für die Werkstatt' }).count() === 1,
      'und die Notiz steht angeheftet auf der Wand');
  }

  /* --- Notizen als Teil des Wissensnetzes (web/views/notes.js) --- */
  //
  // Ein Haken im Anzeigen-Modus, "Verknuepft mit", die Liste hinter "[[",
  // ein unaufgeloester Link, der zur Notiz wird, und die Vorschlagskarte
  // nach drei Photosynthese-Notizen -- jedes Mal steht die Antwort im Tresor.
  const nzKueche = store.all('note').find((x) => x.data.title === 'Küchenplan');
  await page.goto(`${base}/#/notes?id=${encodeURIComponent(nzKueche.id)}`, { waitUntil: 'domcontentloaded' });
  await warte(1500);
  await page.locator('.nw__read input.md-check').first().check();
  await warte(1000);
  check(/- \[x\] Dichtung nachbestellen/.test(store.get(nzKueche.id).data.body),
    'Ein Haken im Anzeigen-Modus einer Notiz schreibt die Zeile im Tresor um');
  await page.keyboard.press('Escape');
  await warte(400);
  const nzMaschine = store.all('note').find((x) => x.data.title === 'Maschine entkalken');
  await page.goto(`${base}/#/notes?id=${encodeURIComponent(nzMaschine.id)}`, { waitUntil: 'domcontentloaded' });
  await warte(1500);
  const nzEingehend = await page.locator('.nw__read .nw__link').count();
  const nzVerknuepftText = (await page.locator('.nw__read .nw__links').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(nzEingehend >= 10 && /Hierher verweist/i.test(nzVerknuepftText) && /Wiki-Link/.test(nzVerknuepftText),
    '„Verknüpft mit“ zeigt die eingehenden Kanten mit Art und Grund', `${nzEingehend} Zeilen`);
  check(await page.locator('.nw__read').getByRole('button', { name: /Im Gehirn zeigen/ }).count() === 1, 'und daneben „Im Gehirn zeigen“');
  await page.keyboard.press('Escape');
  await warte(400);

  await page.locator('[data-nw-plus]').click();
  await page.locator('[data-neu="notiz"]').click();
  await warte(500);
  await page.locator('.nw__edit-title').fill('Pflanzen brauchen Licht');
  await page.locator('.nos-ne__area').click();
  await page.keyboard.type('Ohne Licht keine Photosynthese, siehe [[Maschine entkalken');
  await warte(600);
  const nzListe = page.locator('.nos-ne__list');
  // Der genaue Titel steht vor "Maschine entkalken (Kopie)": erst gleich, dann Anfang, dann neuer zuerst.
  check(await nzListe.isVisible() && /^Maschine entkalken\s/.test((await nzListe.innerText()).trim()),
    '„[[“ im Editor öffnet die Liste passender Titel, der genaue Treffer zuerst', (await nzListe.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 80));
  await page.keyboard.press('Enter');
  await warte(200);
  check(/\[\[Maschine entkalken\]\]$/.test(await page.locator('.nos-ne__area').inputValue()), 'Enter setzt [[Maschine entkalken]] ein');
  await page.keyboard.type('. Chlorophyll im Blatt fängt Licht. Siehe [[Lichtreaktion]].');
  await warte(300);
  await page.keyboard.press('Control+Enter');
  await warte(2000);
  const nzPflanzen = store.all('note').find((x) => x.data.title === 'Pflanzen brauchen Licht');
  check(!!nzPflanzen && store.edges.for(nzPflanzen.id, { direction: 'out' }).some((e) => e.data.to === nzMaschine.id),
    'Strg+Enter speichert die Notiz, und der [[Link]] ist im Tresor eine Kante');
  const nzFehlend = page.locator('.nw__prose a.md-wiki--missing', { hasText: 'Lichtreaktion' });
  check(await nzFehlend.count() === 1, 'Ein [[Link]] ohne Ziel ist gestrichelt');
  await nzFehlend.click();
  await warte(600);
  check(/anlegen\?/.test(await page.locator('.dialog').innerText().catch(() => '')), 'Antippen fragt „Notiz „Lichtreaktion“ anlegen?“');
  await page.locator('.dialog').getByRole('button', { name: /^Anlegen$/ }).click();
  await warte(1500);
  const nzLichtreaktion = store.all('note').find((x) => x.data.title === 'Lichtreaktion');
  check(!!nzLichtreaktion && store.edges.for(nzPflanzen.id, { direction: 'out' }).some((e) => e.data.to === nzLichtreaktion.id),
    'Nach [Anlegen] existiert die Notiz, und die Kante steht im Tresor');
  check(await page.locator('.nw__read .nw__link', { hasText: 'Lichtreaktion' }).count() === 1,
    '„Verknüpft mit“ zeigt die neue Kante ohne Neuladen');
  await page.keyboard.press('Escape');
  await warte(400);

  for (const [titel, inhalt] of [
    ['Chlorophyll absorbiert Licht', 'Chlorophyll absorbiert rotes und blaues Licht, grünes wird reflektiert.'],
    ['Blatt und Licht', 'Das Blatt fängt Licht mit Chlorophyll; Photosynthese im Blatt.'],
  ]) {
    await page.locator('[data-nw-plus]').click();
    await page.locator('[data-neu="notiz"]').click();
    await warte(400);
    await page.locator('.nw__edit-title').fill(titel);
    await page.locator('.nos-ne__area').click();
    await page.keyboard.type(inhalt);
    await page.keyboard.press('Control+Enter');
    await warte(2000);
  }
  const nzKarte = page.locator('.nw__read .nw__card');
  const nzKarteText = (await nzKarte.innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/Ich habe \d+ mögliche Verbindung/.test(nzKarteText) && /Pflanzen brauchen Licht|Chlorophyll absorbiert Licht/.test(nzKarteText),
    'Nach der dritten Photosynthese-Notiz: „Ich habe N mögliche Verbindungen gefunden“', nzKarteText.slice(0, 120));
  const nzBlatt = store.all('note').find((x) => x.data.title === 'Blatt und Licht');
  await nzKarte.getByRole('button', { name: /Alle verbinden/ }).click();
  await warte(1500);
  const nzManuell = nzBlatt ? store.edges.for(nzBlatt.id, { direction: 'out' }).filter((e) => e.data.source === 'manual') : [];
  check(nzManuell.length >= 2, '[Alle verbinden] legt manuelle Kanten im Tresor an', nzManuell.length);
  const nzZeilen = (await page.locator('.nw__read .nw__links').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/Verbunden mit/.test(nzZeilen) && /Verwandt/.test(nzZeilen), 'und „Verknüpft mit“ zeigt sie, mit Rückgängig', nzZeilen.slice(0, 120));
  await page.locator('.nw__read .nw__card').getByRole('button', { name: /Rückgängig/ }).click();
  await warte(1200);
  check(store.edges.for(nzBlatt.id, { direction: 'out' }).filter((e) => e.data.source === 'manual').length === 0, 'Rückgängig nimmt genau diese Kanten zurück');
  await page.keyboard.press('Escape');
  await warte(400);

  // Ein Bild einfuegen, dann doch [Abbrechen]: es bleibt kein loses Bild im
  // Tresor -- sonst stand es im Gehirn als „strand.png“ unter „Unverbunden“.
  const bilderVorher = store.count('file');
  await page.locator('[data-nw-plus]').click();
  await page.locator('[data-neu="notiz"]').click();
  await warte(400);
  await page.locator('.nw__edit-title').fill('Am Strand');
  const bildEinfuegen = async (seite = page) => {
    await seite.locator('.nos-ne__area').click();
    await seite.evaluate(() => {
      const feld = document.querySelector('.nos-ne__area');
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([png], 'strand.png', { type: 'image/png' }));
      feld.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await seite.waitForFunction(() => /\/api\/notizen\/dateien\//.test(document.querySelector('.nos-ne__area').value), null, { timeout: 5000 }).catch(() => {});
  };
  await bildEinfuegen();
  const bilderMit = store.count('file');
  await page.locator('.nw__read-foot').getByRole('button', { name: /^Abbrechen$/ }).click();
  const verwerfenKnopf = page.locator('.dialog').getByRole('button', { name: /^Verwerfen$/ });
  if (await verwerfenKnopf.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await verwerfenKnopf.click();
  await warte(1200);
  check(bilderMit === bilderVorher + 1 && store.count('file') === bilderVorher && !store.all('note').some((x) => x.data.title === 'Am Strand'),
    'Ein Bild eingefügt, dann [Abbrechen]: im Tresor bleibt weder Notiz noch loses Bild', `${bilderVorher} → ${bilderMit} → ${store.count('file')} Bilder`);
  // Gespeichert bleibt es, an seiner Notiz -- auch wenn das Blatt danach zugeht.
  await page.locator('[data-nw-plus]').click();
  await page.locator('[data-neu="notiz"]').click();
  await warte(400);
  await page.locator('.nw__edit-title').fill('Am Strand');
  await bildEinfuegen();
  await page.keyboard.press('Control+Enter');
  await warte(2000);
  await page.keyboard.press('Escape');
  await warte(800);
  const nzStrand = store.all('note').find((x) => x.data.title === 'Am Strand');
  const nzStrandBild = nzStrand ? store.edges.for(nzStrand.id, { direction: 'out' }).find((e) => (store.get(e.data.to) || {}).type === 'file') : null;
  check(!!nzStrandBild && store.count('file') === bilderVorher + 1,
    'Mit [Speichern] bleibt das Bild – verbunden mit seiner Notiz', `${store.count('file')} Bilder, Kante ${nzStrandBild ? 'da' : 'fehlt'}`);
  // Und geht der Tab mitten im Bearbeiten zu, kommt das eingefuegte Bild auch weg (keepalive).
  {
    const vorherZu = store.count('file');
    const kontext = await page.context().browser().newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
    const tab = await kontext.newPage();
    await tab.goto(`${base}/#/notes`, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(tab);
    await tab.waitForTimeout(1200);
    await tab.locator('[data-nw-plus]').click();
    await tab.locator('[data-neu="notiz"]').click();
    await tab.waitForTimeout(400);
    await tab.locator('.nw__edit-title').fill('Tab gleich zu');
    await bildEinfuegen(tab);
    const mitBild = store.count('file');
    await tab.close({ runBeforeUnload: false });
    for (let i = 0; i < 30 && store.count('file') !== vorherZu; i++) await warte(100);
    await kontext.close().catch(() => {});
    check(mitBild === vorherZu + 1 && store.count('file') === vorherZu,
      'Ein Bild eingefügt, dann den Tab geschlossen: auch dann bleibt kein loses Bild', `${vorherZu} → ${mitBild} → ${store.count('file')} Bilder`);
  }

  /* --- Projekte: das zuletzt geaenderte oben, abhaken wirkt --- */
  const projekt = store.create('project', { name: 'Auto verkaufen', description: 'Inserat, Probefahrt, Übergabe.' });
  const aufgabe = store.create('task', { title: 'Fotos machen', projectId: projekt.id });
  store.create('event', { title: 'Probefahrt', start: `${heute}T19:00`, projectId: projekt.id });
  await store.flush();
  await page.goto(`${base}/#/projects`, { waitUntil: 'domcontentloaded' });
  await warte(1200);
  const erstes = ((await page.locator('.pj__row .pj__name').first().innerText().catch(() => '')) || '').trim();
  check(erstes === 'Auto verkaufen', 'Das zuletzt geänderte Projekt steht oben', erstes);
  await page.locator('.pj__row', { hasText: 'Auto verkaufen' }).first().click();
  await warte(1200);
  check((await page.locator('.topbar__title').innerText()).trim() === 'Auto verkaufen'
    && /Probefahrt/.test(await page.locator('main').innerText()),
  'Ein Projekt zeigt, was dazugehört – der Kopf trägt seinen Namen');
  await page.getByRole('checkbox', { name: /Fotos machen/ }).check();
  await warte(1300);
  check(store.get(aufgabe.id).data.status === 'done', 'Abhaken setzt die Aufgabe im Tresor auf erledigt',
    store.get(aufgabe.id).data.status);
}

/* ------------------------------------------------------------------ */
/* iPad                                                                */
/* ------------------------------------------------------------------ */

/**
 * Warum das iPad eine eigene Prüfung bekommt.
 *
 * Es ist kein schmales Telefon. Im Querformat steht es 1024 px breit da --
 * breit genug, dass jede Regel für schmale Fenster daneben greift -- und wird
 * trotzdem mit dem Finger bedient. Genau diese Mischung hat hier zwei Fehler
 * erzeugt, die keine Breitenprüfung gefunden hätte:
 *
 *   - Rund die Hälfte aller Knöpfe, Felder und Chips war kleiner als die
 *     44 px, die Apple als Mindestmaß für einen Finger nennt: gemessen
 *     22/54 in „Heute", 24/42 im Chat, 48/64 in „Einstellungen".
 *   - Die Bereichsschiene war 995 px hoch und damit auf 768 px Höhe unten
 *     abgeschnitten. Ein halbes Symbol am Rand liest sich als Fehler, nicht
 *     als Hinweis, dass es weitergeht.
 *
 * `hasTouch` ist deshalb nicht Beiwerk, sondern der Kern: nur damit meldet
 * der Browser `(pointer: coarse)`, und nur dann greifen die Fingermasse aus
 * Abschnitt 13 von web/app.css. Die Aufteilung (Abschnitt 12 und
 * SEITEN_VORGABE in web/app.js) haengt dagegen an der Breite: quer Leiste und
 * Chat, hochkant nur der Chat mit den Seiten als Schublade. Alle Groessen sind
 * echte Geraete: iPad Air quer (1180×820, das Geraet des Nutzers), ein
 * aelteres iPad quer (1024×768) und iPad Air hochkant (820×1180). Ein Laptop
 * mit Maus wird absichtlich NICHT so geprueft -- dort soll sich nichts aendern.
 */
const IPAD_GROESSEN = [
  // Das iPad des Nutzers, quer: Leiste und Chat, die rechte Spalte zu.
  ['Querformat', 1180, 820, { links: 'offen', rechts: 'zu' }],
  // Aeltere iPads quer: dieselbe mittlere Klasse.
  ['Querformat klein', 1024, 768, { links: 'offen', rechts: 'zu' }],
  // Hochkant ist fuer Seiten kein Platz: nur der Chat, die Seiten als Schublade.
  ['Hochformat', 820, 1180, { links: 'zu', rechts: 'zu' }],
];

/**
 * Die Bausteine, die web/app.css selbst anbietet. Hier gilt null Toleranz:
 * sie sind die Wurzel, an der das behoben wurde, und ein neuer Knopf, der
 * unter 44 px landet, ist ein Rückfall in denselben Zustand.
 */
const IPAD_VOKABULAR = '.btn, .chip, .input, .select, .textarea, .icon-button,'
  + ' .segmented__option, .rail__item, .rail__brand, .rail__chat, .rail__status,'
  + ' a.tile__head, .list__row, .palette__item, .toast__action, .toast__close, .skip-link';

/**
 * Die Schwelle für alles Übrige.
 *
 * Sie ist bewusst nicht null. Was übrig bleibt, sind Knöpfe, die
 * Ansichtsmodule mit eigenen Klassen bauen und selbst auf feste Maße setzen
 * (gemessen mit der neuen Schale: 7× label.setv__perm, 3× .notesv__link,
 * 2× a.md-wiki, .notesv__tag-remove, dazu Wiki-Links im Fließtext, die als
 * Textzeile gar nicht 44 px hoch sein können). Die liegen in web/views/** und
 * nicht in der Hand von web/app.css. Die Zahl ist der gemessene Rest (15 quer,
 * 13 hoch) plus etwas Luft -- nicht mehr, sonst deckt sie beim nächsten Mal
 * einen echten Rückfall zu. Vor der neuen Schale lag der Rest bei 35, mit
 * Heute, Zeitachse und Suche (10× .searchv__chip, 8× .tlv__type). Seit die
 * Notizen eine Wand aus Post-its sind statt eines Editors, sind .notesv__link,
 * a.md-wiki und .notesv__tag-remove weg: gemessen 9 quer und 9 hoch
 * (7× label.setv__perm, 1× input, 1× label.stickv__check). Die Schwelle bleibt
 * bei 20, solange andere Bereiche noch umgebaut werden.
 *
 * Dieselbe Messung am Ausgangsstand, bevor es Fingermasse in web/app.css
 * gab: 361 im Querformat und 342 im Hochformat. Diese Schwelle wäre also rot
 * gewesen -- und genau dafür steht sie hier.
 */
const IPAD_SCHWELLE = 20;

async function pruefeIPad(browser, base) {
  for (const [lage, breite, hoehe, erwartet] of IPAD_GROESSEN) {
    const context = await browser.newContext({
      viewport: { width: breite, height: hoehe },
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    await dismissWelcome(page);

    // Die Aufteilung, die der Nutzer fuer dieses Geraet beschrieben hat.
    const seiten = await page.evaluate(() => {
      const shell = document.querySelector('.shell');
      return { links: shell && shell.dataset.links, rechts: shell && shell.dataset.rechts };
    });
    check(seiten.links === erwartet.links && seiten.rechts === erwartet.rechts,
      `${lage} ${breite}×${hoehe}: Leiste ${erwartet.links}, rechte Spalte ${erwartet.rechts}`,
      `gefunden: Leiste ${seiten.links}, Spalte ${seiten.rechts}`);
    if (erwartet.links === 'zu') {
      // Hochkant: die Leiste kommt als Schublade und geht nach der Wahl zu.
      await page.getByRole('button', { name: 'Seitenleiste ausklappen' }).first().tap();
      await page.waitForTimeout(450);
      const offen = await page.evaluate(() => {
        const r = document.querySelector('.rail').getBoundingClientRect();
        return document.querySelector('.shell').dataset.links === 'offen' && r.left >= -1 && r.width > 200;
      });
      check(offen, `${lage}: Antippen klappt die Leiste als Schublade auf`);
      await page.locator('.rail__item', { hasText: 'Notizen' }).first().tap();
      await page.waitForTimeout(700);
      const danach = await page.evaluate(() => ({
        links: document.querySelector('.shell').dataset.links,
        hash: window.location.hash,
      }));
      check(danach.links === 'zu' && danach.hash.startsWith('#/notes'),
        `${lage}: nach der Wahl eines Bereichs geht sie wieder zu`, JSON.stringify(danach));
    }

    const klein = [];
    const vokabel = [];
    const schrift = [];
    const schiene = [];
    const ueberlauf = [];
    let ziele = 0;

    for (const view of ALL_VIEWS) {
      await page.goto(`${base}/#/${view}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(view === 'graph' ? 1600 : 500);
      let m;
      try {
        m = await page.evaluate(messeTippziele, IPAD_VOKABULAR);
      } catch (err) {
        hmm(`${lage}: ${view} ließ sich nicht messen`, err.message.slice(0, 90));
        continue;
      }
      ziele += m.ziele;
      for (const x of m.klein) klein.push(`${view}: ${x}`);
      for (const x of m.vokabel) vokabel.push(`${view}: ${x}`);
      for (const x of m.schrift) schrift.push(`${view}: ${x}`);
      for (const x of m.schiene) schiene.push(`${view}: ${x}`);
      if (m.ueberlauf > 1) ueberlauf.push(`${view}: ${m.ueberlauf} px`);
    }

    console.log(`  ${D}${lage} ${breite}×${hoehe} · ${ziele} Bedienelemente geprüft${X}`);
    check(!vokabel.length, `${lage}: kein Baustein aus web/app.css unter 44 px`,
      vokabel.length ? `${vokabel.length}: ${vokabel.slice(0, 4).join(' · ')}` : IPAD_VOKABULAR.slice(0, 60) + ' …');
    check(klein.length <= IPAD_SCHWELLE,
      `${lage}: höchstens ${IPAD_SCHWELLE} Tippziele unter 44 px in ${ALL_VIEWS.length} Ansichten`,
      `${klein.length} gefunden${klein.length ? `: ${haeufigste(klein)}` : ''}`);
    check(!schrift.length, `${lage}: kein Eingabefeld unter 16 px (sonst zoomt iOS Safari beim Antippen hinein)`,
      schrift.length ? schrift.slice(0, 4).join(' · ') : 'alle Felder ≥ 16 px');
    check(!schiene.length, `${lage}: die Bereichsschiene zeigt jeden Eintrag ganz`,
      schiene.length ? `angeschnitten: ${schiene.slice(0, 4).join(' · ')}` : 'kein Eintrag ragt aus der Schiene');
    check(!ueberlauf.length, `${lage}: keine Ansicht erzwingt waagerechtes Scrollen`,
      ueberlauf.length ? ueberlauf.join(' · ') : `${ALL_VIEWS.length} Ansichten`);

    await context.close();
  }
}

/** Welche Bausteine machen die Zahl aus? Eine Liste von Namen ist zum
 *  Nachbessern brauchbar, eine Liste von Vorkommen nicht. */
function haeufigste(eintraege) {
  const zaehler = new Map();
  for (const eintrag of eintraege) {
    const name = eintrag.split(' ')[1] || eintrag;
    zaehler.set(name, (zaehler.get(name) || 0) + 1);
  }
  return [...zaehler.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => `${n}× ${name}`)
    .join(' · ');
}

/**
 * Läuft IM Browser. Steht hier als eigene Funktion, damit sie nicht in einer
 * Zeichenkette versteckt ist und beim Lesen wie Code aussieht.
 */
function messeTippziele(vokabular) {
  const SEL = 'button, a[href], input, select, textarea, summary,'
    + ' [role="radio"], [role="tab"], [role="switch"], [role="checkbox"], [role="option"], [role="button"]';
  const sichtbar = (e) => (e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== 'hidden';

  // Ein Ankreuzfeld ist nie allein: es steckt in einem <label>, und getippt
  // wird das Label. Gemessen wird deshalb die Fläche, die der Finger wirklich
  // trifft -- nicht die des Kästchens.
  const ziel = (e) => (e.tagName === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio')
    && e.closest('label')) || e;
  const name = (e) => {
    const cls = (e.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return `${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };

  const klein = [];
  const vokabel = [];
  const gesehen = new Set();
  const elemente = [...document.querySelectorAll(SEL)].filter(sichtbar);
  for (const e of elemente) {
    const t = ziel(e);
    if (gesehen.has(t)) continue;
    gesehen.add(t);
    const r = t.getBoundingClientRect();
    if (r.height <= 0 || r.height >= 44) continue;
    const eintrag = `${name(t)} ${Math.round(r.height)}px`;
    klein.push(eintrag);
    if (t.matches(vokabular)) vokabel.push(eintrag);
  }

  const schrift = [];
  for (const e of document.querySelectorAll('input, textarea, select')) {
    if (!sichtbar(e)) continue;
    if (['hidden', 'checkbox', 'radio', 'range'].includes(e.type)) continue;
    const groesse = parseFloat(getComputedStyle(e).fontSize);
    if (groesse < 16) schrift.push(`${name(e)} ${groesse}px`);
  }

  // Ragt ein Bereichseintrag aus seiner eigenen Schiene heraus? Das ist das
  // abgeschnittene Symbol am unteren Rand, gemessen statt angesehen.
  const schiene = [];
  const rail = document.querySelector('.rail');
  if (rail) {
    const aussen = rail.getBoundingClientRect();
    for (const e of rail.querySelectorAll('.rail__item')) {
      if (!sichtbar(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.top < aussen.top - 0.5 || r.bottom > aussen.bottom + 0.5) {
        schiene.push(((e.querySelector('.rail__label') || e).textContent || '?').trim());
      }
    }
  }

  return {
    ziele: gesehen.size,
    klein,
    vokabel,
    schrift,
    schiene,
    ueberlauf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

/** Der Willkommensdialog liegt beim ersten Start über allem. */
/**
 * PIN und iPad, so wie ein Mensch sie bedient -- und geprüft, ob es im Tresor
 * und im Netz wirklich wirkt, nicht nur, ob eine grüne Meldung erscheint.
 * Gemerkte Geräte landen in einem Wegwerf-Ordner, nie im echten Profil.
 */
async function pruefeSchutzUndIpad(browser, base, app) {
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-profil-'));
  const vorher = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = profil;
  const kontext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fehler = [];
  try {
    const seite = await kontext.newPage();
    seite.on('pageerror', (e) => fehler.push(e.message));
    await seite.goto(`${base}/#/settings`, { waitUntil: 'domcontentloaded' });
    await seite.waitForTimeout(1200);
    await dismissWelcome(seite);
    const gruppen = await seite.locator('.setv__gruppe h2').allInnerTexts();
    check(['KI', 'Schutz', 'iPad verbinden', 'Darstellung', 'Netzwerk', 'Speicher'].every((g) => gruppen.includes(g)),
      'Die Einstellungen haben die sechs ruhigen Gruppen', gruppen.join(' · '));
    check(await seite.locator('details.setv__mehr:not([open])').count() === 1,
      'Das Technische liegt eingeklappt unter „Für Fortgeschrittene“');

    // PIN: zweimal dieselbe, dann ist der Tresor wirklich verschlüsselt.
    await seite.getByRole('button', { name: 'PIN einrichten' }).click();
    const feld = seite.locator('.setv__pin').first();
    check(await feld.getAttribute('type') === 'text' && await feld.getAttribute('inputmode') === 'numeric'
      && await seite.locator('form .setv__pin').count() === 0,
      'Das PIN-Feld: Ziffern-Tastatur, kein Passwortfeld, kein Formular (der Browser will sie nicht speichern)');
    await feld.fill('2468');
    await seite.getByRole('button', { name: 'Weiter' }).click();
    await seite.locator('.setv__pin').first().fill('2468');
    const merken = seite.locator('.setv__check input');
    if (await merken.isChecked()) await merken.uncheck();
    await seite.getByRole('button', { name: 'PIN einrichten' }).click();
    await seite.waitForTimeout(2500);
    check(app.vaultCrypto && app.vaultCrypto.enabled === true && app.vaultCrypto.art() === 'pin',
      'Ein Klick auf „PIN einrichten“ verschlüsselt den Tresor wirklich', app.vaultCrypto ? app.vaultCrypto.state : 'keine Verschlüsselung');
    check(/PIN aktiv/.test(await seite.locator('[data-gruppe="schutz"]').innerText()), 'und die Gruppe sagt „PIN aktiv“');

    // Ein zweiter Browser ohne PIN bekommt keine Daten -- und genau hier die PIN-Abfrage.
    const fremd = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const zweit = await fremd.newPage();
      await zweit.goto(`${base}/#/settings`, { waitUntil: 'domcontentloaded' });
      await zweit.waitForTimeout(1500);
      const antwort = await zweit.evaluate(async () => (await fetch('/api/records?type=note')).status);
      check(antwort === 401, 'Ein anderer Browser ohne PIN bekommt keine Notizen', `HTTP ${antwort}`);
      await zweit.locator('.setv__pin').first().fill('1111');
      await zweit.getByRole('button', { name: 'Entsperren' }).click();
      await zweit.waitForTimeout(1500);
      check(/Falsche PIN/.test(await zweit.locator('[data-gruppe="schutz"]').innerText()), 'Eine falsche PIN sagt „Falsche PIN.“');
      await zweit.locator('.setv__pin').first().fill('2468');
      await zweit.getByRole('button', { name: 'Entsperren' }).click();
      await zweit.waitForTimeout(2500);
      const danach = await zweit.evaluate(async () => (await fetch('/api/records?type=note')).status);
      check(danach === 200, 'Mit der richtigen PIN ist dieser Browser drin', `HTTP ${danach}`);
    } finally {
      await fremd.close().catch(() => {});
    }

    // iPad: der Knopf öffnet das WLAN ohne Neustart und zeigt einen QR-Code.
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal);
    if (!lan) {
      hmm('iPad verbinden', 'dieser Rechner hat keine Netzadresse außer 127.0.0.1');
    } else {
      app.lanAdressen = () => [{ adresse: lan.address, schnittstelle: 'Prüfung' }];
      await seite.getByRole('button', { name: 'iPad verbinden', exact: true }).click();
      await seite.waitForTimeout(1200);
      const qr = seite.locator('.setv__qr-bild path');
      const d = (await qr.count()) ? await qr.getAttribute('d') : '';
      check(d.length > 1000, 'Der Knopf zeigt einen QR-Code', `${(d.match(/M/g) || []).length} dunkle Module`);
      const link = (await seite.locator('.setv__link').innerText()).trim();
      check(new URL(link).hostname === lan.address && /\/api\/verbinden\?c=/.test(link),
        'Der Code führt zur eigenen WLAN-Adresse, mit Einmal-Code', link.replace(/c=.*/, 'c=…'));
      check(/Warte auf das iPad/.test(await seite.locator('[data-gruppe="ipad"]').innerText()),
        'Vor dem Scannen steht „Warte auf das iPad“ – nicht schon „verbunden“');
      // Das "iPad" löst ein. Es ist ein Aufruf aus diesem Prozess; die
      // prozessweite Härtung würde ihn abweisen, ein echtes iPad nicht.
      const { runInternal } = require('../src/net/gate');
      const u = new URL(link);
      const status = await runInternal(() => new Promise((resolve, reject) => {
        const http = require('node:http');
        const req = http.get({ host: u.hostname, port: Number(u.port), path: `${u.pathname}${u.search}`, headers: { host: u.host, 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' } }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
      }));
      await seite.waitForTimeout(1500);
      check(status === 303 && /iPad ist verbunden/.test(await seite.locator('[data-gruppe="ipad"]').innerText()),
        'Erst nach dem Einlösen steht dort „iPad ist verbunden.“', `HTTP ${status}`);
      await seite.evaluate(async () => { await fetch('/api/ipad', { method: 'DELETE', headers: { 'x-neural-os': '1' } }); });
      delete app.lanAdressen;
    }
    check(fehler.length === 0, 'Keine Seitenfehler dabei', fehler.slice(0, 2).join(' | '));
  } finally {
    await kontext.close().catch(() => {});
    if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorher;
    fs.rmSync(profil, { recursive: true, force: true });
  }
}

async function dismissWelcome(page) {
  try {
    const btn = page.getByRole('button', { name: /Los geht/ });
    if (await btn.count()) {
      await btn.first().click({ timeout: 3000 });
      await page.waitForTimeout(300);
    }
  } catch { /* schon weg, oder nie da gewesen */ }
}

main().catch((err) => {
  console.error(`\n${R}Die Prüfung selbst ist gescheitert:${X} ${err && err.message}`);
  if (err && err.stack) console.error(`${D}${err.stack.split('\n').slice(0, 6).join('\n')}${X}`);
  process.exit(2);
});
