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
  'network', 'stick', 'backup',
];

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
    // Die Offline-KI ist gestrichen; die KI ist Claude. Ohne Schluessel (so
    // laeuft diese Pruefung) muss der Chat das sagen, statt leer zu bleiben.
    // Das Muster nimmt beide Fassungen, bis der Chat neu gebaut ist.
    check(/Claude|Schlüssel|kein lokales Modell|Kein Modell/i.test(chatText),
      'Ohne KI sagt der Chat warum, statt leer zu bleiben', chatText.replace(/\s+/g, ' ').slice(0, 90));
    check((await page.locator('.topbar__title').innerText()).trim() !== 'Neuer Chat',
      'Der Kopf zeigt bei einem offenen Chat nicht „Neuer Chat“',
      (await page.locator('.topbar__title').innerText()).trim());
    check(await page.locator('.rail__chat.is-active', { hasText: 'Probe' }).count() === 1,
      'und der Chat ist in „Zuletzt“ markiert');

    /* -------------------- 8. Zweiter Blick: belegbar vs. nicht belegbar */
    console.log(`\n${B}8 · Der zweite Blick trennt Belegbares von Nichtbelegbarem${X}`);
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

    /* ----------------- 9. Sichern: der Knopf muss einen Ordner hinterlassen */
    console.log(`\n${B}9 · „Jetzt sichern" legt wirklich einen Ordner an${X}`);
    // Der Punkt dieser Pruefung: eine gruene Meldung beweist gar nichts. Eine
    // Sicherung ist erst dann eine, wenn danach Dateien auf der Platte liegen,
    // die man wieder einlesen kann. Deshalb wird hier nach dem Klick im
    // Dateisystem nachgesehen und die Sicherung anschliessend geprueft.
    const sicherungsZiel = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-ui-sicher-'));
    /** Der Ordner, den der Klick wirklich angelegt hat -- nicht der getippte. */
    let geschrieben = null;
    try {
      await page.goto(`${base}/#/backup`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const bkpText = await page.locator('main').innerText();
      check(/Zuletzt gesichert|noch keine Sicherung/i.test(bkpText),
        'Der Bereich sagt zuerst, wann zuletzt gesichert wurde');
      check(/Klartext|verschlüsselt/i.test(bkpText),
        'und ob die Sicherung im Klartext liegt — nicht kleingedruckt');

      const zielFeld = page.getByLabel('Zielordner der Sicherung');
      check(await zielFeld.count() > 0, 'Das Ziel lässt sich auswählen');
      if (await zielFeld.count()) {
        await zielFeld.fill(sicherungsZiel);
        const sichernKnopf = page.getByRole('button', { name: /^Jetzt sichern/ });
        check(await sichernKnopf.count() > 0, 'Der Knopf „Jetzt sichern" ist da');
        if (await sichernKnopf.count()) {
          await sichernKnopf.first().click();
          // Der Export laeuft serverseitig; gewartet wird auf die Datei, nicht
          // auf eine Meldung. Im gewaehlten Ziel entsteht ein Unterordner mit
          // Zeitstempel -- so ueberschreibt die naechste Sicherung nicht die
          // letzte gute, und genau das wird hier mitgeprueft.
          for (let i = 0; i < 60 && !geschrieben; i++) {
            await page.waitForTimeout(500);
            try {
              geschrieben = fs.readdirSync(sicherungsZiel)
                .map((name) => path.join(sicherungsZiel, name))
                .find((dir) => fs.existsSync(path.join(dir, 'manifest.json'))) || null;
            } catch { geschrieben = null; }
          }
          const dateien = geschrieben ? fs.readdirSync(geschrieben) : [];
          check(!!geschrieben && dateien.includes('export.json'),
            'Nach dem Klick liegt eine echte Sicherung auf der Platte',
            `${geschrieben || sicherungsZiel}: ${dateien.join(', ') || 'leer'}`);
          if (geschrieben) {
            const pruefung = await app.backup.verify(geschrieben);
            check(pruefung.ok, 'und sie ist vollständig (Manifest und Prüfsummen stimmen)',
              pruefung.ok ? `${dateien.length} Dateien` : JSON.stringify(pruefung.problems.slice(0, 2)));
            const gemeldet = await page.locator('main').innerText();
            check(gemeldet.includes(geschrieben), 'Die Oberfläche nennt denselben Pfad, der wirklich beschrieben wurde');
            check(/Zeitstempel/i.test(gemeldet) || path.basename(geschrieben).startsWith('export-'),
              'und sie liegt in einem eigenen Ordner, überschreibt also keine ältere',
              path.basename(geschrieben));
          }
        }
      }

      /* --- und zurueck: ohne Vorschau wird nichts geschrieben --- */
      const quelleFeld = page.getByLabel('Ordner oder Datei der Sicherung');
      if (!geschrieben) {
        hmm('Die Wiederherstellung lässt sich prüfen', 'es wurde keine Sicherung geschrieben');
      } else if (!(await quelleFeld.count())) {
        bad('Die Quelle einer Wiederherstellung lässt sich eintragen');
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
    } finally {
      fs.rmSync(sicherungsZiel, { recursive: true, force: true });
    }

    check(errors.length === 0, 'Keine Konsolenfehler während all dessen',
      errors.slice(0, 2).join(' | ').slice(0, 200));
    if (claudeFehlt) {
      hmm('GET /api/claude antwortet', 'die Route fehlt noch (Bereich Claude-Unterbau) – der Status sagt deshalb „Online“, nie „verbunden“');
    }
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
 * Heute, Zeitachse und Suche (10× .searchv__chip, 8× .tlv__type).
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
