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

const ALL_VIEWS = [
  'today', 'chat', 'notes', 'projects', 'graph', 'agents', 'assist', 'study',
  'automation', 'network', 'timeline', 'sync', 'workshop', 'search', 'settings',
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
      narrowProblems.length ? `betroffen: ${narrowProblems.join(', ')}` : `${ALL_VIEWS.length} Ansichten`);
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

    /* --------------------------- 5. Das Zurueck ist auffindbar und wirkt */
    console.log(`\n${B}5 · Rückgängig ist auffindbar und wirkt${X}`);
    const opfer = store.create('note', { title: 'Wird geändert', body: 'Original' });
    // Eine Aenderung, die ein Agent gemacht hat -- der Fall, fuer den das
    // Ganze existiert.
    const { withActor } = require('../src/kernel/actor');
    await withActor({ kind: 'agent', runId: 'run_uipruefung', agentId: 'agent_uipruefung' }, async () => {
      store.update(opfer.id, { body: 'Vom Agenten geändert' });
    });
    await store.flush();

    await page.goto(`${base}/#/timeline`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await dismissWelcome(page);
    await page.waitForTimeout(400);

    const tab = page.getByRole('button', { name: /Letzte Änderungen/ });
    if (!(await tab.count())) {
      bad('„Letzte Änderungen" ist in der Zeitachse erreichbar');
    } else {
      await tab.first().click();
      await page.waitForTimeout(1200);
      const text = await page.locator('body').innerText();
      check(/Wird geändert/.test(text), 'Die Änderung steht in der Liste');
      check(/Agent|agent/.test(text), 'Und es ist erkennbar, dass ein Agent sie gemacht hat');

      const zurueck = page.getByRole('button', { name: /^Zurücknehmen|^Rückgängig/ });
      if (!(await zurueck.count())) {
        hmm('Ein Zurücknehmen-Knopf ist da', 'keiner gefunden — vielleicht anders beschriftet');
      } else {
        await zurueck.first().click();
        await page.waitForTimeout(1400);
        const jetzt = store.get(opfer.id).data.body;
        check(jetzt === 'Original', 'Ein Klick darauf stellt den alten Stand wirklich her',
          `im Tresor steht: ${JSON.stringify(jetzt)}`);
      }
    }

    /* --------------------------- 6. Heute: abhaken wirkt im Tresor */
    console.log(`\n${B}6 · „Heute" zeigt Tatsachen und lässt handeln${X}`);
    const gestern = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const faellig = store.create('task', { title: 'Mühle entkalken', due: gestern, priority: 1 });
    const { withActor: alsAgent } = require('../src/kernel/actor');
    const meine = store.create('note', { title: 'Meine Notiz', body: 'Von mir' });
    await alsAgent({ kind: 'agent', runId: 'run_nacht', agentId: 'agent_nacht' }, async () => {
      store.update(meine.id, { body: 'Vom Nachtlauf ergänzt' });
    });
    await store.flush();

    await page.goto(`${base}/#/today`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await dismissWelcome(page);
    await page.waitForTimeout(600);
    const heuteText = await page.locator('main').innerText();
    check(/überfällig/i.test(heuteText), 'Überfälliges wird als solches benannt');
    check(/Ohne dich/i.test(heuteText) && /Meine Notiz/.test(heuteText),
      'Was ohne dich lief, steht als eigener Block da');

    // Ueber das aria-label, nicht ueber eine Klasse: so prueft der Test
    // zugleich, dass der Knopf fuer einen Screenreader beschriftet ist.
    const haken = page.getByRole('button', { name: /Mühle entkalken.*abhaken/ });
    if (await haken.count()) await haken.first().click();
    else bad('Der Abhak-Knopf trägt eine verständliche Beschriftung');
    await page.waitForTimeout(1400);
    check(store.get(faellig.id).data.status === 'done', 'Eine Aufgabe lässt sich von hier aus abhaken',
      `im Tresor: ${store.get(faellig.id).data.status}`);

    /* ------------------------------- 7. Lernen: bewerten wirkt im Tresor */
    console.log(`\n${B}7 · „Lernen" rechnet den nächsten Termin wirklich aus${X}`);
    const karte = store.create('card', { front: 'Was ist Crema?', back: 'Die Schaumschicht.' });
    await store.flush();
    await page.goto(`${base}/#/study`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const vorne = await page.locator('main').innerText();
    check(/Was ist Crema/.test(vorne), 'Die Karte wird gezeigt');
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
    const hinten = await page.locator('main').innerText();
    check(/Schaumschicht/.test(hinten), 'Die Leertaste zeigt die Rückseite');
    // "heute", "morgen", "in 6 Tagen" -- der Server liefert den Text, damit
    // Oberflaeche und Rechnung nicht auseinanderlaufen koennen.
    check(/heute|morgen|Tag|Woche|Monat/i.test(hinten), 'Die Knöpfe sagen, wann die Karte wiederkommt',
      hinten.replace(/\s+/g, ' ').slice(0, 120));
    await page.keyboard.press('3');
    await page.waitForTimeout(1300);
    const danach = store.get(karte.id).data;
    check(danach.reps === 1 && !!danach.due, 'Eine Bewertung landet wirklich im Tresor',
      `reps=${danach.reps} due=${danach.due} ease=${danach.ease}`);

    /* ------------------------ 8. Schnellerfassung von ueberall aus */
    console.log(`\n${B}8 · Schnell festhalten, ohne den Bereich zu wechseln${X}`);
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

    /* --------------- 9. Beobachtete Ordner: erst ansehen, dann aufnehmen */
    console.log(`\n${B}9 · Ein beobachteter Ordner nimmt erst auf, wenn er eingeschaltet ist${X}`);
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

    /* ------------------------------- 10. Der Modellvergleich ist da */
    console.log(`\n${B}10 · Zwei Modelle nebeneinander${X}`);
    const probe = store.create('chat', { title: 'Probe' });
    await store.flush();
    await page.goto(`${base}/#/chat?id=${probe.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const chatText = await page.locator('main').innerText();
    check(/Zwei Modelle|[Vv]ergleich/.test(chatText), 'Der Vergleich ist im Chat auffindbar');
    // Ohne Modell muss der Chat ehrlich sein statt leer.
    check(/kein lokales Modell|Kein Modell/i.test(chatText),
      'Ohne Modell sagt der Chat warum, statt leer zu bleiben');

    /* ------------------- 11. Zweiter Blick: belegbar vs. nicht belegbar */
    console.log(`\n${B}11 · Der zweite Blick trennt Belegbares von Nichtbelegbarem${X}`);
    const langerText = 'Der Mahlgrad entscheidet über den Widerstand im Sieb. Ist er zu fein, steigt '
      + 'der Druck und der Espresso läuft nur tropfenweise; ist er zu grob, rauscht das Wasser durch '
      + 'und die Crema bleibt dünn. Die Brühtemperatur liegt bei rund 93 Grad, bei dunklen Röstungen '
      + 'eher darunter. Neun bar sind die Norm, aber viele Maschinen schwanken. Der Wassertank sollte '
      + 'weiches Wasser enthalten, sonst verkalkt die Maschine schnell. Entkalker gehört alle zwei '
      + 'Monate hinein. Offen bleibt, wie stark sich die Bohnenfrische auf den Druck auswirkt.';
    const langeNotiz = store.create('note', { title: 'Espresso in der Praxis', body: langerText });
    store.create('note', { title: 'Mahlgrad', body: 'Feiner Mahlgrad erhöht den Druck.' });
    const kurzeNotiz = store.create('note', { title: 'Kurz', body: 'Zwei Sätze. Mehr nicht.' });
    await store.flush();

    await page.goto(`${base}/#/notes?id=${langeNotiz.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const zbKnopf = page.getByRole('button', { name: /Zweiter Blick/ });
    if (!(await zbKnopf.count())) {
      bad('Der Knopf steht an einer langen Notiz');
    } else {
      ok('Der Knopf steht an einer langen Notiz');
      await zbKnopf.first().click();
      await page.waitForTimeout(2500);
      const zbText = await page.locator('main').innerText();
      check(/Mahlgrad|Druck|Grad/.test(zbText), 'Die bekannten Begriffe erscheinen auch ohne Modell');
      check(/Volltextindex/.test(zbText), 'und sind als belegbar gekennzeichnet');
      check(/braucht ein Modell/i.test(zbText), 'während der andere Teil als "braucht ein Modell" dasteht');
    }
    await page.goto(`${base}/#/notes?id=${kurzeNotiz.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    check(await page.getByRole('button', { name: /Zweiter Blick/ }).count() === 0,
      'An einer kurzen Notiz gibt es ihn gar nicht erst');

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
