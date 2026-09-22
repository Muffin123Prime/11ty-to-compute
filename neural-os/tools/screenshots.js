'use strict';

/**
 * Bildschirmfotos von Neural OS -- aus der laufenden Anwendung, nicht gemalt.
 *
 *   node tools/screenshots.js                 alles, nach ./screenshots/
 *   node tools/screenshots.js --out /pfad     woandershin
 *
 * Was hier anders ist als in tools/ui-check.js
 * --------------------------------------------
 * ui-check.js prueft, ob ein Klick bis in den Tresor durchschlaegt. Dieses
 * Werkzeug prueft nichts -- es zeigt. Deshalb darf es an einer Stelle einen
 * Klick am Mauszeiger vorbei ausloesen (Werkstatt, siehe dort); ob ein echter
 * Klick durchkommt, ist Sache von ui-check.js und bleibt es.
 *
 * Was es trotzdem nicht tut
 * -------------------------
 * Ein Schritt, der sein Bedienelement nicht findet, wird am Ende namentlich
 * gemeldet und NICHT durch ein aehnliches Bild ersetzt. Eine Sammlung, in der
 * das fehlende Bild stillschweigend durch ein anderes ersetzt wird, behauptet
 * etwas ueber eine Funktion, die keiner gesehen hat.
 *
 * Playwright wird global gesucht (npm i -g playwright); Neural OS selbst
 * braucht es nicht und hat weiterhin null Abhaengigkeiten.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, seedIfEmpty } = require('../src/app');
const demo = require('./demo-vault');
const { findPlaywright, findChromium } = require('./lib/browser');

const G = '\u001b[32m'; const R = '\u001b[31m'; const Y = '\u001b[33m';
const D = '\u001b[2m'; const B = '\u001b[1m'; const X = '\u001b[0m';

/**
 * Tresor bauen, altern lassen, Server hochfahren.
 *
 * Zwei Starts, nicht einer: der erste legt an, dann wird das Protokoll
 * umdatiert, der zweite liest es wieder ein. Erst danach sind Notizen
 * wirklich Monate alt und die Vorschlaege finden, was sie finden sollen.
 */
async function hochfahren() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-os-shots-'));
  let app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error' });
  await seedIfEmpty(app);
  await app.loadModules({});
  const { alt } = await demo.befuellen(app);
  await app.close();
  demo.altern(path.join(home, 'vault', 'log'), alt);

  app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error' });
  await app.loadModules({});
  if (app.graph && app.graph.scanAll) app.graph.scanAll(app.store, {});
  if (app.assist) await app.assist.scan({});
  await app.store.flush();
  const server = await app.listen();
  return { app, home, base: `http://127.0.0.1:${server.server.address().port}` };
}

const args = process.argv.slice(2);
const OUT = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.resolve(process.cwd(), 'screenshots');
})();
const VIEWS = [
  ['today', 'heute'], ['chat', 'chat'], ['notes', 'notizen'], ['projects', 'projekte'],
  ['graph', 'gehirn'], ['agents', 'agenten'], ['assist', 'vorschlaege'],
  ['automation', 'automatik'], ['network', 'netz'], ['timeline', 'zeitachse'], ['sync', 'abgleich'],
  ['stick', 'stick'], ['workshop', 'werkstatt'], ['search', 'suche'],
  ['backup', 'sicherung'], ['settings', 'einstellungen'],
];

let n = 0;
const gemacht = [];
const fehlt = [];

function nr() { return String(++n).padStart(2, '0'); }

async function shot(page, name) {
  const file = path.join(OUT, `${nr()}-${name}.png`);
  await page.screenshot({ path: file });
  gemacht.push(path.basename(file));
  return file;
}

/** Ein Schritt, der scheitern darf -- er sagt dann, dass er gescheitert ist. */
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    // Die Nummer bleibt stehen: sie zaehlt aufgenommene Bilder, nicht Schritte.
    fehlt.push(`${name}: ${String(err.message).split('\n')[0].slice(0, 120)}`);
  }
}

async function klick(page, muster, opts = {}) {
  const b = page.getByRole('button', { name: muster }).first();
  await b.waitFor({ state: 'visible', timeout: opts.timeout || 4000 });
  await b.click({ timeout: opts.timeout || 4000 });
  await page.waitForTimeout(opts.warten || 600);
}

async function los(page, base, view, warten = 1000) {
  await page.goto(`${base}/#/${view}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(warten);
}

async function weg(page) {
  const w = page.getByRole('button', { name: /Los geht/ });
  if (await w.count()) { await w.first().click(); await page.waitForTimeout(400); }
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`\n${B}Neural OS · Bildschirmfotos${X}`);
  console.log(`${D}Aus der laufenden Anwendung, mit echtem Chromium.${X}`);

  const pwPath = findPlaywright();
  if (!pwPath) {
    console.log(`\n${Y}Playwright ist nicht installiert — es wurde nichts aufgenommen.${X}`);
    console.log(`${D}Neural OS braucht es nicht; dieses Werkzeug schon: npm i -g playwright${X}\n`);
    process.exit(2);
  }

  const { app, base, home } = await hochfahren();
  console.log(`${D}Tresor: ${home}${X}`);
  const { chromium: pw } = await import(pwPath);
  const chromium = findChromium();
  const browser = await pw.launch(chromium ? { executablePath: chromium } : {});

  const konsole = [];
  const mach = async (theme) => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    const p = await c.newPage();
    p.on('pageerror', (e) => konsole.push(`${theme}: ${e.message.slice(0, 100)}`));
    p.on('console', (m) => { if (m.type() === 'error') konsole.push(`${theme}: ${m.text().slice(0, 100)}`); });
    return { c, p };
  };

  /* ================================================= 0 · Der erste Start */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'today', 1200);
    await step('Willkommensdialog', async () => {
      await p.getByRole('button', { name: /Los geht/ }).first().waitFor({ timeout: 5000 });
      await shot(p, 'willkommen-erster-start-hell');
    });
    await c.close();
  }

  /* ============================== 1 · Jede Ansicht, hell und dunkel */
  for (const theme of ['light', 'dark']) {
    const suffix = theme === 'dark' ? 'dunkel' : 'hell';
    const { c, p } = await mach(theme);
    await los(p, base, 'today', 1000);
    await weg(p);
    for (const [view, name] of VIEWS) {
      await los(p, base, view, view === 'graph' ? 2600 : 1200);
      await step(`Ansicht ${view} (${suffix})`, async () => { await shot(p, `${name}-${suffix}`); });
    }
    await c.close();
  }

  /* ======================================= 2 · Tastatur: Palette, Erfassung */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'today', 1000);
    await weg(p);
    await step('Befehlspalette', async () => {
      await p.keyboard.press('Control+k');
      await p.waitForTimeout(600);
      await shot(p, 'befehlspalette-strg-k-dunkel');
      await p.keyboard.type('gehirn');
      await p.waitForTimeout(500);
      await shot(p, 'befehlspalette-gefiltert-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
    });
    await c.close();
  }
  {
    const { c, p } = await mach('light');
    await los(p, base, 'notes', 1200);
    await weg(p);
    await step('Schnell festhalten', async () => {
      await p.keyboard.press('Control+Shift+n');
      await p.waitForTimeout(700);
      await shot(p, 'schnell-festhalten-leer-hell');
      await p.keyboard.type('Dichtung für den Siebträger bestellen #werkstatt bis morgen');
      await p.waitForTimeout(900);
      await shot(p, 'schnell-festhalten-vorschau-hell');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
    });
    await c.close();
  }

  /* ============================================== 3 · Notizen im Detail */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'notes', 1400);
    await weg(p);
    await step('Notiz geöffnet', async () => {
      await klick(p, /Espresso in der Praxis/, { warten: 900 });
      await shot(p, 'notiz-geteilt-hell');
    });
    await step('Notiz: Vorschau', async () => {
      await klick(p, /^Vorschau$/, { warten: 700 });
      await shot(p, 'notiz-vorschau-hell');
    });
    await step('Notiz: Text', async () => {
      await klick(p, /^Text$/, { warten: 700 });
      await shot(p, 'notiz-text-hell');
    });
    await step('Zweiter Blick', async () => {
      await klick(p, /Zweiter Blick/, { warten: 2500 });
      await shot(p, 'notiz-zweiter-blick-hell');
    });
    await c.close();
  }

  /* ================================================== 4 · Das Gehirn */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'graph', 3000);
    await weg(p);
    await step('Gehirn: Knoten gewählt', async () => {
      const box = await p.locator('canvas').first().boundingBox();
      await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await p.waitForTimeout(1200);
      await shot(p, 'gehirn-inspektor-dunkel');
    });
    await step('Gehirn: Fokus', async () => {
      await klick(p, /^Fokus$/, { warten: 1800 });
      await shot(p, 'gehirn-fokus-dunkel');
      await klick(p, /^Fokus$/, { warten: 1200 });
    });
    await step('Gehirn: Gruppen', async () => {
      await klick(p, /^Gruppen$/, { warten: 2000 });
      await shot(p, 'gehirn-gruppen-dunkel');
    });
    await step('Gehirn: nur Notizen', async () => {
      await klick(p, /^Notizen \d+$/, { warten: 1500 });
      await shot(p, 'gehirn-nur-notizen-dunkel');
    });
    await c.close();
  }

  /* ====================================================== 5 · Chat */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'chat', 1600);
    await weg(p);
    await step('Chat: Verlauf', async () => {
      await klick(p, /Über Mahlgrad und Druck/, { warten: 1200 });
      await shot(p, 'chat-verlauf-dunkel');
    });
    await step('Chat: kein Modell, ehrlich gesagt', async () => {
      await klick(p, /Beetplanung 2027/, { warten: 1200 });
      await shot(p, 'chat-kein-modell-dunkel');
    });
    await step('Chat: Internetzugang wird gefragt', async () => {
      await klick(p, /^Online$/, { warten: 1200 });
      await shot(p, 'chat-internet-nachfrage-dunkel');
      await klick(p, /^Abbrechen$/, { warten: 900 });
    });
    await step('Chat: zwei Modelle', async () => {
      await klick(p, /Zwei Modelle/, { warten: 1200 });
      await shot(p, 'chat-zwei-modelle-dunkel');
      await klick(p, /Zwei Modelle/, { warten: 800 });
    });
    await step('Chat: Kontext anheften', async () => {
      await klick(p, /Kontext anheften/, { warten: 1400 });
      await shot(p, 'chat-kontext-anheften-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(500);
    });
    await c.close();
  }

  /* ==================================================== 6 · Agenten */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'agents', 1600);
    await weg(p);
    await step('Agent: Grunddaten', async () => {
      await klick(p, /Wissensgärtner/, { warten: 1200 });
      await shot(p, 'agent-wissensgaertner-hell');
    });
    for (const [ueberschrift, name] of [
      ['Berechtigungen', 'agent-berechtigungen-hell'],
      ['Netzberechtigung', 'agent-netzberechtigung-hell'],
      ['Werkzeuge dieses Agenten', 'agent-werkzeuge-hell'],
      ['Laufhistorie', 'agent-laufhistorie-hell'],
    ]) {
      await step(`Agent: ${ueberschrift}`, async () => {
        const traf = await p.evaluate((t) => {
          const h = [...document.querySelectorAll('h2,h3')].find((x) => x.textContent.trim().startsWith(t));
          if (!h) return false;
          h.scrollIntoView({ block: 'start' });
          return true;
        }, ueberschrift);
        if (!traf) throw new Error(`Überschrift „${ueberschrift}“ nicht gefunden`);
        await p.waitForTimeout(700);
        await shot(p, name);
      });
    }
    await step('Agent: Start ohne Modell', async () => {
      // „Agent starten“ ist ohne Modell abgeschaltet. Genau das soll man sehen.
      await p.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /Agent starten/.test(x.textContent));
        if (b) b.scrollIntoView({ block: 'center' });
      });
      await p.waitForTimeout(600);
      await shot(p, 'agent-start-ohne-modell-hell');
    });
    await c.close();
  }

  /* ================================================= 7 · Vorschläge */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'assist', 1600);
    await weg(p);
    await step('Vorschläge: Liste', async () => { await shot(p, 'vorschlaege-liste-hell'); });
    const chip = async (muster) => {
      const r = p.getByRole('radio', { name: muster }).first();
      await r.waitFor({ state: 'visible', timeout: 4000 });
      await r.click();
      await p.waitForTimeout(900);
    };
    await step('Vorschläge: nur Doppelte', async () => {
      await chip(/Doppelt/);
      await shot(p, 'vorschlaege-doppelt-hell');
    });
    await step('Vorschläge: nur verwaist', async () => {
      await chip(/Verwaist/);
      await shot(p, 'vorschlaege-verwaist-hell');
    });
    await step('Vorschläge: nur Wiedervorlage', async () => {
      await chip(/Wiedervorlage/);
      await shot(p, 'vorschlaege-wiedervorlage-hell');
    });
    await c.close();
  }

  /* ================================================== 8 · Automatik */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'automation', 1500);
    await weg(p);
    await step('Automatik: Zeitpläne', async () => { await shot(p, 'automatik-zeitplaene-dunkel'); });
    await step('Automatik: ein Zeitplan im Detail', async () => {
      const traf = await p.evaluate(() => {
        const h = [...document.querySelectorAll('h2,h3,h4')].find((x) => /Wochenputz/.test(x.textContent));
        if (!h) return false;
        h.scrollIntoView({ block: 'center' });
        return true;
      });
      if (!traf) throw new Error('Zeitplan „Wochenputz“ nicht gefunden');
      await p.waitForTimeout(700);
      await shot(p, 'automatik-zeitplan-detail-dunkel');
    });
    await step('Automatik: Auslöser', async () => {
      await p.evaluate(() => {
        const h = [...document.querySelectorAll('h2,h3')].find((x) => /Auslöser/.test(x.textContent));
        if (h) h.scrollIntoView({ block: 'center' });
      });
      await p.waitForTimeout(600);
      await shot(p, 'automatik-ausloeser-dunkel');
    });
    await c.close();
  }

  /* ====================================================== 9 · Netz */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'network', 1500);
    await weg(p);
    await step('Netz: offline', async () => { await shot(p, 'netz-offline-hell'); });
    await step('Netz: Ziel prüfen', async () => {
      const feld = p.locator('input[type="text"], input:not([type])').first();
      await feld.fill('api.openai.com');
      await klick(p, /^Prüfen$/, { warten: 1500 });
      await shot(p, 'netz-ziel-gepruft-hell');
    });
    await step('Netz: Protokoll', async () => {
      await p.evaluate(() => {
        const h = [...document.querySelectorAll('h2,h3')].find((x) => /Protokoll der Netzzugriffe/.test(x.textContent));
        if (h) h.scrollIntoView({ block: 'center' });
      });
      await p.waitForTimeout(700);
      await shot(p, 'netz-protokoll-hell');
    });
    await step('Netz: Freigaben', async () => {
      await p.evaluate(() => {
        const h = [...document.querySelectorAll('h2,h3')].find((x) => /Aktive Freigaben/.test(x.textContent));
        if (h) h.scrollIntoView({ block: 'center' });
      });
      await p.waitForTimeout(700);
      await shot(p, 'netz-freigaben-hell');
    });
    await c.close();
  }

  /* ================================================== 10 · Zeitachse */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'timeline', 1800);
    await weg(p);
    await step('Zeitachse: Woche', async () => {
      await klick(p, /^Woche$/, { warten: 1200 });
      await shot(p, 'zeitachse-woche-dunkel');
    });
    await step('Zeitachse: Jahr', async () => {
      await klick(p, /^Jahr$/, { warten: 1400 });
      await shot(p, 'zeitachse-jahr-dunkel');
    });
    await step('Zeitachse: letzte Änderungen', async () => {
      await klick(p, /Letzte Änderungen/, { warten: 1400 });
      await shot(p, 'zeitachse-letzte-aenderungen-dunkel');
    });
    await c.close();
  }

  /* ==================================================== 11 · Suche */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'search', 1300);
    await weg(p);
    await step('Suche: Treffer', async () => {
      const feld = p.locator('input').first();
      await feld.fill('mahlgrad druck');
      await p.waitForTimeout(1600);
      await shot(p, 'suche-treffer-hell');
    });
    await step('Suche: nur Notizen', async () => {
      await klick(p, /^Notizen$/, { warten: 1200 });
      await shot(p, 'suche-nur-notizen-hell');
    });
    await c.close();
  }

  /* =============================================== 12 · Einstellungen */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'settings', 1600);
    await weg(p);
    for (const [ueberschrift, name] of [
      ['Tresor', 'einstellungen-tresor-hell'],
      ['Verschlüsselung', 'einstellungen-verschluesselung-hell'],
      ['Beobachtete Ordner', 'einstellungen-beobachtete-ordner-hell'],
      ['Freigabe im lokalen Netz', 'einstellungen-lan-freigabe-hell'],
      ['Online-Modelle', 'einstellungen-online-modelle-hell'],
      ['Diagnose', 'einstellungen-diagnose-hell'],
    ]) {
      await step(`Einstellungen: ${ueberschrift}`, async () => {
        const traf = await p.evaluate((t) => {
          const h = [...document.querySelectorAll('h2,h3')].find((x) => x.textContent.trim().startsWith(t));
          if (!h) return false;
          h.scrollIntoView({ block: 'start' });
          return true;
        }, ueberschrift);
        if (!traf) throw new Error(`Überschrift „${ueberschrift}“ nicht gefunden`);
        await p.waitForTimeout(700);
        await shot(p, name);
      });
    }
    await c.close();
  }

  /* ================================================= 13 · Projekte */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'projects', 1500);
    await weg(p);
    await step('Projekt: Detail', async () => {
      await klick(p, /Küche einrichten/, { warten: 1200 });
      await shot(p, 'projekt-detail-dunkel');
    });
    await c.close();
  }

  /* ================================================= 14 · Werkstatt */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'workshop', 1800);
    await weg(p);
    await step('Werkstatt: Vorlagen-Auswahl', async () => {
      await klick(p, /^Vorlagen$/, { warten: 1400 });
      await shot(p, 'werkstatt-vorlagen-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(700);
    });
    await step('Werkstatt: Modul aus der Vorlage', async () => {
      // „Prüfen“ ist abgeschaltet, solange es nichts zu prüfen gibt. Erst die
      // Vorlage laden, dann prüfen -- sonst fotografiert man einen toten Knopf.
      await los(p, base, 'workshop', 1800);
      // Der Knopf steckt in der Erklaerkarte, die ueber dem Editor liegt;
      // Playwright kommt mit dem Mauszeiger nicht daran vorbei. Ob ein echter
      // Klick durchkommt, ist Sache von tools/ui-check.js, nicht dieses hier.
      const traf = await p.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('laden'));
        if (!b) return false;
        b.click();
        return true;
      });
      if (!traf) throw new Error('Der Knopf „Vorlage laden“ ist nicht da');
      await p.waitForTimeout(1800);
      await shot(p, 'werkstatt-modul-geladen-dunkel');
    });
    await step('Werkstatt: Prüfbericht', async () => {
      await klick(p, /^Prüfen$/, { warten: 2800 });
      await shot(p, 'werkstatt-pruefbericht-dunkel');
    });
    await c.close();
  }

  /* ========================================== 14b · Einzelne Zustaende */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'today', 1400);
    await weg(p);
    await step('Tastenkürzel', async () => {
      await p.locator('button[aria-label="Tastenkürzel anzeigen"]').first().click();
      await p.waitForTimeout(800);
      await shot(p, 'tastenkuerzel-hell');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
    });
    await step('Heute: unterer Teil', async () => {
      await p.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        const main = document.querySelector('main');
        (main && main.scrollHeight > main.clientHeight ? main : el).scrollBy(0, 900);
      });
      await p.waitForTimeout(700);
      await shot(p, 'heute-unten-hell');
    });
    await step('Netz: Freigabe erteilen', async () => {
      await los(p, base, 'network', 1500);
      // Das Formular steckt in einem zugeklappten Abschnitt; aufgeklappt zeigt
      // es, was eine Freigabe alles benennen muss: Ziel, Zweck, Gueltigkeit.
      await p.evaluate(() => {
        for (const d of document.querySelectorAll('details')) d.open = true;
      });
      await p.waitForTimeout(600);
      const traf = await p.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /Freigabe erteilen/.test(x.textContent));
        if (!b) return false;
        b.scrollIntoView({ block: 'center' });
        return true;
      });
      if (!traf) throw new Error('„Freigabe erteilen“ nicht gefunden');
      await p.waitForTimeout(600);
      await shot(p, 'netz-freigabe-erteilen-hell');
    });
    await step('Stick: Modell mitnehmen', async () => {
      // Der Abschnitt steht unten im Bereich; geknipst wird, was er auf DIESEM
      // Rechner sagt -- ohne Ollama also der Befund samt Anleitung, nicht ein
      // gestelltes Bild mit einem Modell, das es hier nicht gibt.
      await los(p, base, 'stick', 1800);
      const traf = await p.evaluate(() => {
        const kopf = [...document.querySelectorAll('.card__head strong')].find((x) => x.textContent.trim() === 'Modell mitnehmen');
        if (!kopf) return false;
        kopf.closest('section').scrollIntoView({ block: 'start' });
        return true;
      });
      if (!traf) throw new Error('Der Abschnitt „Modell mitnehmen“ ist nicht da');
      await p.waitForTimeout(700);
      await shot(p, 'stick-modell-mitnehmen-hell');
    });
    await step('Abgleich: Partnergerät hinzufügen', async () => {
      await los(p, base, 'sync', 1400);
      await klick(p, /Partnergerät hinzufügen/, { warten: 1200 });
      await shot(p, 'abgleich-partnergeraet-hell');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
    });
    await step('Notiz: im Gehirn zeigen', async () => {
      await los(p, base, 'notes', 1500);
      await klick(p, /Beetplanung/, { warten: 1000 });
      await klick(p, /Im Gehirn zeigen/, { warten: 2800 });
      await shot(p, 'notiz-im-gehirn-hell');
    });
    await step('Zeitachse: Inspektor', async () => {
      await los(p, base, 'timeline', 1800);
      await klick(p, /^Inspektor$/, { warten: 1200 });
      await shot(p, 'zeitachse-inspektor-hell');
    });
    await c.close();
  }

  /* ============================================== 14c · Sicherung */
  //
  // Die Sicherung ist der Grund, aus dem jemand dieses Programm ueberhaupt
  // einem Dienst vorzieht -- und war bis vor kurzem auf keinem einzigen der
  // 93 Bilder zu sehen. Drei Zustaende sind es wert, festgehalten zu werden:
  // "noch nie gesichert" (der Zustand, in dem die meisten sind), die fertige
  // Sicherung samt Pfad, und die Vorschau vor dem Zurueckspielen.
  {
    const { c, p } = await mach('light');
    // Bewusst OHNE eigenes Ziel: der Vorgabeordner ist genau der, in dem die
    // Liste nachsieht. Ein Bild von einer Sicherung, die anschliessend in der
    // eigenen Liste fehlt, waere eine Anleitung zum Missverstaendnis.
    const exportOrdner = path.join(home, 'exports');
    await los(p, base, 'backup', 1400);
    await weg(p);
    await step('Sicherung: noch nie gesichert', async () => {
      await shot(p, 'sicherung-noch-keine-hell');
    });
    await step('Sicherung: geschrieben', async () => {
      await klick(p, /^Jetzt sichern/, { warten: 600 });
      // Auf die Datei warten, nicht auf eine Meldung: was gezeigt wird, soll
      // dem entsprechen, was wirklich auf der Platte liegt.
      for (let i = 0; i < 40; i++) {
        await p.waitForTimeout(400);
        try {
          if (fs.readdirSync(exportOrdner).some((d) => fs.existsSync(path.join(exportOrdner, d, 'manifest.json')))) break;
        } catch { /* noch nicht da */ }
      }
      await p.waitForTimeout(1500);
      await shot(p, 'sicherung-geschrieben-hell');
    });
    await step('Sicherung: Liste und Prüfung', async () => {
      await klick(p, /^Prüfen$/, { warten: 2500 });
      await shot(p, 'sicherung-geprueft-hell');
    });
    await step('Sicherung: Vorschau vor dem Zurückspielen', async () => {
      await klick(p, /Zum Wiederherstellen wählen/, { warten: 2500 });
      await shot(p, 'sicherung-vorschau-hell');
    });
    await step('Sicherung: alles ersetzen', async () => {
      await p.getByRole('radio', { name: /vollständig ersetzen/ }).first().check();
      await klick(p, /^Erst ansehen/, { warten: 2500 });
      await shot(p, 'sicherung-alles-ersetzen-hell');
    });
    await c.close();
  }

  /* ============================================= 14d · Sicherung, dunkel */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'backup', 1400);
    await weg(p);
    await step('Sicherung: dunkel', async () => { await shot(p, 'sicherung-zustand-dunkel'); });
    await c.close();
  }

  /* =============================================== 15 · Schmales Fenster */
  {
    const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: 'light' });
    const p = await c.newPage();
    await los(p, base, 'today', 1200);
    await weg(p);
    for (const [view, name] of [['today', 'heute'], ['notes', 'notizen'], ['graph', 'gehirn']]) {
      await los(p, base, view, view === 'graph' ? 2600 : 1200);
      await step(`Schmal: ${view}`, async () => { await shot(p, `schmal-1024-${name}-hell`); });
    }
    await c.close();
  }

  await browser.close();
  await app.close();

  fs.rmSync(home, { recursive: true, force: true });

  console.log(`\n${G}${gemacht.length} Bilder${X} in ${OUT}`);
  if (fehlt.length) {
    console.log(`\n${R}Nicht aufgenommen (${fehlt.length})${X} — diese Funktionen fehlen in der Sammlung:`);
    for (const f of fehlt) console.log(`  ${R}·${X} ${f}`);
  }
  if (konsole.length) {
    console.log(`\n${Y}Konsolenfehler (${konsole.length})${X}`);
    for (const k of [...new Set(konsole)].slice(0, 10)) console.log(`  ${Y}·${X} ${k}`);
  }
  console.log('');
  process.exit(fehlt.length ? 1 : 0);
})().catch((err) => {
  console.error(`\n${R}Das Werkzeug selbst ist gescheitert:${X} ${err && err.message}`);
  if (err && err.stack) console.error(`${D}${err.stack.split('\n').slice(0, 6).join('\n')}${X}`);
  process.exit(2);
});
