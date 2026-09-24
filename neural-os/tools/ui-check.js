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
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error' });
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
      await context.addInitScript((t) => { try { localStorage.setItem('neural-os:theme', t); } catch { /* egal */ } }, theme);
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
    // Die KI ist Claude. Ohne Schluessel (so laeuft diese Pruefung) steht
    // statt eines leeren Chats die Karte "Verbinde Claude" mit genau EINEM
    // Feld da. Den ganzen Weg mit Schluessel (Statist), Rueckfragen, Kopieren,
    // Stopp und Bearbeiten prueft tools/chat-beweis.js im Browser.
    check(/Verbinde Claude/.test(chatText) && /console\.anthropic\.com/.test(chatText)
      && await page.locator('.cv-verbinden input').count() === 1,
    'Ohne Claude: „Verbinde Claude“ mit einem Feld und dem Satz, wo es den Schlüssel gibt', chatText.replace(/\s+/g, ' ').slice(0, 90));
    check(await page.locator('.cv-composer__feld').count() === 1 && await page.locator('.cv-composer__clip').count() === 1,
      'Das Eingabefeld ist eine Karte mit Büroklammer und rundem Senden-Knopf');
    check((await page.locator('.topbar__title').innerText()).trim() !== 'Neuer Chat',
      'Der Kopf zeigt bei einem offenen Chat nicht „Neuer Chat“',
      (await page.locator('.topbar__title').innerText()).trim());
    check(await page.locator('.rail__chat.is-active', { hasText: 'Probe' }).count() === 1,
      'und der Chat ist in „Zuletzt“ markiert');

    /* ------------- 8. Kalender, Notizwand, Projekte: bis in den Tresor */
    // Die alte Notizansicht mit Editor und "Zweiter Blick" gibt es nicht mehr:
    // die Notizen macht die KI, die Ansicht ist eine Wand zum Wiederfinden.
    // Geprueft wird, was man dort tut -- und ob es im Tresor ankommt.
    console.log(`\n${B}8 · Kalender, Notizen, Projekte: ein Klick wirkt im Tresor${X}`);
    await pruefeKalenderNotizenProjekte(page, base, store);

    /* ------------- 9. Stick: vorbereiten, sichern, wiederherstellen */
    console.log(`\n${B}9 · Stick: ein Klick bereitet vor, „Jetzt sichern" legt wirklich etwas ab${X}`);
    // Der Punkt dieser Pruefung: eine gruene Meldung beweist gar nichts. Ein
    // Stick ist erst dann vorbereitet und eine Sicherung erst dann eine, wenn
    // danach Dateien auf der Platte liegen. Deshalb wird nach jedem Klick im
    // Dateisystem nachgesehen. Hier steckt kein echter Stick; ein leerer
    // Ordner steht an seiner Stelle und wird von Hand eingetragen -- genau
    // der Weg, den die Ansicht anbietet, wenn die Suche nichts findet.
    const stickOrt = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-stick-'));
    /** Der Ordner, den der Klick wirklich angelegt hat -- nicht der getippte. */
    let geschrieben = null;
    try {
      await page.goto(`${base}/#/backup`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      check(/#\/stick$/.test(page.url()), 'Die alte Adresse #/backup führt in den Bereich „Stick“', page.url());

      const ortFeld = page.getByLabel('Ort des Sticks');
      check(await ortFeld.count() === 1, 'Es gibt genau ein Feld für den Ort des Sticks');
      const stickText = await page.locator('main').innerText();
      check(/Kein Stick gefunden|frei/.test(stickText),
        'Die Suche sagt, was sie gefunden hat – oder ehrlich, dass sie nichts fand');
      check(!/Modell|Ollama|llama/i.test(stickText), 'Vom Sprachmodell auf dem Stick ist nicht mehr die Rede');
      check(/Zuletzt gesichert|Noch keine Sicherung/.test(stickText),
        'Neben „Jetzt sichern" steht still, wann zuletzt gesichert wurde');

      if (await ortFeld.count()) {
        await ortFeld.fill(stickOrt);
        await page.waitForTimeout(900);

        // --- Stick vorbereiten: ab Werk ist das Netz zu, also kommt die
        // eine Rueckfrage -- mit zwei Knoepfen, nicht mit einem Dialog.
        await page.getByRole('button', { name: /^Stick vorbereiten$/ }).click();
        const nurHier = page.getByRole('button', { name: /^Nur / });
        await nurHier.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        check(await page.getByRole('button', { name: /^Erlauben$/ }).count() === 1 && await nurHier.count() === 1,
          'Für Windows/Mac fragt der Knopf einmal – „Erlauben" oder „Nur dieses System"');
        if (await nurHier.count()) {
          await nurHier.first().click();
          await page.locator('.stickv__fertig, .stickv__meldung').first().waitFor({ timeout: 120000 }).catch(() => {});
          const fertigText = await page.locator('main').innerText();
          check(/Der Stick ist fertig/.test(fertigText), 'Nach dem Klick meldet die Ansicht „Der Stick ist fertig"',
            fertigText.split('\n').find((z) => /fertig|Fehler|nicht/i.test(z)) || '');
          check(fs.existsSync(path.join(stickOrt, 'neural-os.portable'))
            && fs.existsSync(path.join(stickOrt, 'app', 'bin', 'neural-os.js'))
            && fs.readdirSync(path.join(stickOrt, 'data')).length > 0,
          'und auf dem Stick liegen wirklich Programm, Laufzeit und Wissen',
          fs.readdirSync(stickOrt).join(', '));
          check(await page.locator('.stickv__schritte li').count() === 3,
            'Danach steht eine Anleitung in drei Sätzen da');
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
async function pruefeSchale(page, base, store) {
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
  await page.evaluate(() => { try { localStorage.removeItem('neural-os:seiten'); } catch { /* egal */ } });
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
  // Ohne Claude-Schluessel darf dort "Online" stehen, aber nie "verbunden".
  check(gesetzt === 200 && /^Online/.test(online) && !/verbunden/i.test(online),
    'Online geschaltet folgt die Anzeige live – und behauptet ohne Claude keine Verbindung',
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
  await page.getByRole('button', { name: 'Übersicht einklappen' }).click();
  await warte(500);
  const nurChat = await zustand();
  check(nurChat.rechts === 'zu' && !nurChat.spalteSichtbar && nurChat.chatBreite >= nurChat.fensterBreite - 48,
    'Beide Seiten eingeklappt: nur der Chat bleibt', `Chat ${nurChat.chatBreite} von ${nurChat.fensterBreite} px`);
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
 * Das Gehirn nach docs/vorlage/gehirn-obsidian.png. Geprueft wird, was man
 * nicht aus einem Unit-Test lesen kann: dass die Leinwand wirklich ein Netz
 * zeigt, dass es zur Ruhe kommt und danach stillsteht (ein Gehirn, das offen
 * liegt, darf auf dem Schullaptop keine Rechenzeit fressen), dass das Panel
 * oben rechts die vier Abschnitte der Vorlage hat, und dass Suchen, Antippen
 * und "Oeffnen" bis zum richtigen Eintrag durchschlagen. Dazu die Kachel
 * rechts: ein kleiner Ausschnitt, dessen Antippen das Gehirn dort oeffnet.
 */
async function pruefeGehirn(page, base, store) {
  const warte = (ms) => page.waitForTimeout(ms);
  await page.evaluate(() => { try { localStorage.removeItem('neural-os:gehirn'); } catch { /* egal */ } });
  await page.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  const start = Date.now();
  const ruht = await page.waitForFunction(() => {
    const g = document.querySelector('.gh');
    return g && g.dataset.ruhe === 'ja';
  }, null, { timeout: 15000 }).then(() => true, () => false);
  check(ruht, 'Die Wolke kommt zur Ruhe', ruht ? `nach ${Date.now() - start} ms` : 'nach 15 s noch in Bewegung');

  // Gezeichnet ist, was Pixel hat -- nicht, was im DOM steht.
  const bild = () => page.evaluate(() => {
    const c = document.querySelector('.gh__canvas');
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
    // Mittlere Deckkraft der gemalten Stichproben: faellt stark, wenn alles
    // ausser dem Gewaehlten zuruecktritt.
    return { gemalt, summe, deckung: gemalt ? licht / gemalt : 0 };
  });
  await warte(600);
  const a = await bild();
  check(a && a.gemalt > 500, 'Die Leinwand zeigt ein Netz', a ? `${a.gemalt} gemalte Stichproben` : 'keine Leinwand');
  await warte(900);
  const b = await bild();
  check(a && b && a.summe === b.summe, 'In Ruhe steht das Bild still (keine Rechenzeit im Leerlauf)',
    a && b ? (a.summe === b.summe ? 'zwei Aufnahmen im Abstand von 0,9 s sind gleich' : 'das Bild ändert sich noch') : '');

  // Auf schmaler Karte ist das Panel zu; der Knopf oben rechts oeffnet es.
  if (await page.locator('.gh__opener').isVisible()) await page.locator('.gh__opener').click();
  const abschnitte = await page.locator('.gh__panel summary').allInnerTexts();
  check(['Filter', 'Gruppen', 'Anzeige', 'Kräfte'].every((t, i) => (abschnitte[i] || '').trim() === t),
    'Oben rechts das Panel der Vorlage: Filter, Gruppen, Anzeige, Kräfte', abschnitte.map((t) => t.trim()).join(' · '));

  // Suchen -> Eingabetaste -> Kaertchen -> Oeffnen -> der richtige Eintrag.
  const ziel = store.all('note').find((n) => n.data.title === 'Notiz 7');
  await page.locator('.gh__panel summary', { hasText: 'Filter' }).first().click();
  await warte(250);
  const feld = page.getByLabel('Im Gehirn suchen');
  if (!ziel || !(await feld.count())) {
    bad('Die Suche im Gehirn lässt sich bedienen', ziel ? 'kein Suchfeld' : 'Testnotiz fehlt');
  } else {
    await feld.fill('Notiz 7');
    await warte(300);
    await feld.press('Enter');
    await warte(700);
    const karte = page.locator('.gh__card');
    const titel = (await karte.locator('.gh__card-title').innerText().catch(() => '')).trim();
    check(await karte.isVisible() && titel === 'Notiz 7', 'Suchen und Eingabetaste wählen den Knoten, das Kärtchen nennt ihn', titel || 'kein Kärtchen');
    // Schliessen und Suche leeren muss das Zuruecktreten wieder aufheben --
    // frueher blieb das Netz danach gedaempft stehen.
    const gewaehlt = await bild();
    await karte.getByRole('button', { name: 'Auswahl schließen' }).click();
    await feld.fill('');
    await feld.press('Escape');
    await warte(700);
    const frei = await bild();
    check(gewaehlt && frei && a && frei.deckung > gewaehlt.deckung * 1.3 && frei.deckung > a.deckung * 0.75,
      'Auswahl schließen und Suche leeren holen das ganze Netz zurück',
      gewaehlt && frei && a ? `Deckung ${Math.round(a.deckung)} → gewählt ${Math.round(gewaehlt.deckung)} → danach ${Math.round(frei.deckung)}` : '');
    await feld.fill('Notiz 7');
    await warte(300);
    await feld.press('Enter');
    await warte(700);
    const zaehler = async () => (await page.locator('.gh__count').innerText().catch(() => '')).trim();
    const vorher = await zaehler();
    const chip = page.locator('.gh__chips .chip', { hasText: 'Notizen' }).first();
    if (await chip.count()) {
      await chip.click();
      await warte(400);
      const nachher = await zaehler();
      check(nachher !== vorher, 'Eine Art ausblenden wirkt sofort', `${vorher} → ${nachher}`);
      await chip.click();
      await warte(300);
    }
    await karte.getByRole('button', { name: 'Öffnen' }).click();
    await warte(900);
    const hash = await page.evaluate(() => window.location.hash);
    check(hash === `#/notes?id=${encodeURIComponent(ziel.id)}`, '„Öffnen“ führt zu genau diesem Eintrag', hash);
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
    await warte(1200);
    const gewaehlt = (await page.locator('.gh__card-title').innerText().catch(() => '')).trim();
    check(!!gewaehlt, 'Antippen öffnet das Gehirn mit genau dieser Mitte gewählt', gewaehlt || 'nichts gewählt');
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
    check(['Claude', 'Schutz', 'iPad verbinden', 'Darstellung', 'Netzwerk', 'Speicher'].every((g) => gruppen.includes(g)),
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
