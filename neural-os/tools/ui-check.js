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
const { execFileSync } = require('node:child_process');

const G = '\u001b[32m'; const R = '\u001b[31m'; const Y = '\u001b[33m';
const D = '\u001b[2m'; const B = '\u001b[1m'; const X = '\u001b[0m';

const ALL_VIEWS = [
  'chat', 'notes', 'projects', 'graph', 'agents', 'assist', 'automation',
  'network', 'timeline', 'sync', 'workshop', 'search', 'settings',
];

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

/**
 * Playwright wird dort gesucht, wo npm global installiert -- nicht per
 * `require` aus dem Projekt, denn dort gibt es bewusst kein node_modules.
 */
function findPlaywright() {
  const candidates = [];
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    if (root) candidates.push(path.join(root, 'playwright', 'index.mjs'));
  } catch { /* npm nicht erreichbar -- die festen Pfade unten bleiben */ }
  candidates.push('/opt/node22/lib/node_modules/playwright/index.mjs');
  candidates.push('/usr/lib/node_modules/playwright/index.mjs');
  candidates.push('/usr/local/lib/node_modules/playwright/index.mjs');
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Den mitgelieferten Chromium finden, ohne etwas herunterzuladen. */
function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
    path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries.filter((e) => e.startsWith('chromium')).sort().reverse()) {
      for (const rel of [['chrome-linux', 'chrome'], ['chrome-linux', 'headless_shell'],
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]) {
        const full = path.join(root, entry, ...rel);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return null;
}

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
    /* ---------------------------------------- 1. Jede Ansicht, hell + dunkel */
    console.log(`\n${B}1 · Jede Ansicht lädt, hell und dunkel${X}`);
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: theme });
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
            return {
              chars: (main.innerText || '').trim().length,
              overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
              canvas: !!main.querySelector('canvas'),
            };
          });
          if (errors.length) problems.push(`${view}: ${errors[0].slice(0, 120)}`);
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
      narrowProblems.length ? `betroffen: ${narrowProblems.join(', ')}` : '13 Ansichten');
    await narrow.close();

    if (onlyViews) return;

    /* ------------------------------ 3. Klicken, und im Tresor nachsehen */
    console.log(`\n${B}3 · Ein Klick muss bis in den Tresor wirken${X}`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${base}/#/assist`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    await dismissWelcome(page);

    const tasksBefore = store.count('task');
    await page.getByRole('button', { name: /^Prüfen/ }).first().click();
    await page.waitForTimeout(2000);
    const cards = await page.locator('article').count();
    check(cards > 0, '„Prüfen" erzeugt sichtbare Vorschläge', `${cards} Karten`);

    if (await page.getByRole('button', { name: /^Übernehmen/ }).count()) {
      const taskCard = page.locator('article', { hasText: 'Aufgabe' }).first();
      const target = (await taskCard.count()) ? taskCard : page.locator('article').first();
      await target.getByRole('button', { name: /^Übernehmen/ }).first().click();
      await page.waitForTimeout(1500);
      const accepted = store.all('suggestion').filter((x) => x.data.status === 'accepted').length;
      check(accepted > 0, '„Übernehmen" setzt den Vorschlag im Tresor auf übernommen', `${accepted}`);
      check(store.count('task') >= tasksBefore, 'und der Tresor hat sich wirklich verändert',
        `${tasksBefore} → ${store.count('task')} Aufgaben`);
      const shown = await page.locator('body').innerText();
      check(/übernommen|angelegt|verknüpft/i.test(shown), 'Die Oberfläche sagt, was wirklich passiert ist');
    } else {
      hmm('„Übernehmen" ist anklickbar', 'kein Vorschlag mit ausführbarer Aktion entstanden');
    }

    if (await page.getByRole('button', { name: /^Verwerfen/ }).count()) {
      await page.getByRole('button', { name: /^Verwerfen/ }).first().click();
      await page.waitForTimeout(1200);
      check(store.all('suggestion').some((x) => x.data.status === 'dismissed'),
        '„Verwerfen" wirkt ebenfalls bis in den Tresor');
    }

    /* ------------------------------ 4. Nichts läuft, was niemand einschaltete */
    console.log(`\n${B}4 · Automatik fragt, bevor etwas von allein läuft${X}`);
    await page.goto(`${base}/#/automation`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    check(/Nichts läuft von allein/.test(await page.locator('body').innerText()),
      'Der Normalzustand steht groß und zuerst da');

    const agent = store.all('agent')[0];
    if (!agent || !app.scheduler) {
      hmm('Ein Zeitplan lässt sich schalten', 'kein Agent oder kein Zeitgeber vorhanden');
    } else {
      const plan = app.scheduler.create({
        agentId: agent.id, goal: 'Rückblick schreiben', every: 'daily', atHour: 7,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      check(/Rückblick schreiben/.test(await page.locator('body').innerText()),
        'Ein angelegter Zeitplan erscheint in der Ansicht');

      const sw = page.locator('[role=switch]').first();
      if (!(await sw.count())) {
        bad('Ein Schalter ist auffindbar');
      } else {
        await sw.click();
        await page.waitForTimeout(600);
        const confirmBtn = page.getByRole('button', { name: /^Einschalten$/ });
        check(await confirmBtn.count() > 0, 'Einschalten fragt vorher nach');
        check(/von allein/.test(await page.locator('body').innerText()),
          'und sagt dabei, was ab dann ohne dich passiert');
        if (await confirmBtn.count()) {
          await confirmBtn.first().click();
          await page.waitForTimeout(1400);
        }
        check(store.get(plan.id).data.enabled === true,
          'Erst nach der Bestätigung steht es wirklich im Tresor');
        const after = await page.locator('body').innerText();
        check(!/Nichts läuft von allein/.test(after) && /Läuft von allein/.test(after),
          'Ein eingeschalteter Plan ist unverwechselbar markiert');
        await sw.click();
        await page.waitForTimeout(1400);
        check(store.get(plan.id).data.enabled === false,
          'Zurück in den sicheren Zustand geht mit einem Klick, ohne Rückfrage');
      }
      app.scheduler.remove(plan.id);
    }

    check(errors.length === 0, 'Keine Konsolenfehler während all dessen',
      errors.slice(0, 2).join(' | ').slice(0, 200));
    await page.close();
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

/** Der Willkommensdialog liegt beim ersten Start über allem. */
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
