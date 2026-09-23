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
  ['chat', 'chat'], ['kalender', 'kalender'], ['notes', 'notizen'], ['projects', 'projekte'],
  ['agents', 'agenten'], ['graph', 'gehirn'], ['workshop', 'werkstatt'], ['settings', 'einstellungen'],
  ['network', 'netz'], ['stick', 'stick'], ['backup', 'sicherung'],
];

/** Hell ist eine Wahl, keine Systemvorgabe: dunkel ist die Voreinstellung. */
const THEMA = 'neural-os:theme';

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
  const mach = async (theme, opts = {}) => {
    const c = await browser.newContext({
      viewport: { width: opts.breite || 1440, height: opts.hoehe || 900 },
      colorScheme: theme,
      hasTouch: !!opts.finger,
    });
    await c.addInitScript(([k, t]) => { try { localStorage.setItem(k, t); } catch { /* egal */ } }, [THEMA, theme]);
    const p = await c.newPage();
    p.on('pageerror', (e) => konsole.push(`${theme}: ${e.message.slice(0, 100)}`));
    p.on('console', (m) => { if (m.type() === 'error') konsole.push(`${theme}: ${m.text().slice(0, 100)}`); });
    return { c, p };
  };

  /* ============================================ 0 · Die Schale selbst */
  //
  // Nach docs/vorlage/app.png: Leiste, Chat, rechte Spalte -- und was der
  // Nutzer woertlich wollte: die Seiten weg- und wieder ausklappen.
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'chat', 1600);
    await step('Schale: Leiste und Spalte offen', async () => { await shot(p, 'schale-offen-dunkel'); });
    await step('Schale: Leiste eingeklappt', async () => {
      await klick(p, /^Seitenleiste einklappen$/, { warten: 600 });
      await shot(p, 'schale-leiste-zu-dunkel');
    });
    await step('Schale: beide eingeklappt, nur der Chat', async () => {
      await klick(p, /^Übersicht einklappen$/, { warten: 600 });
      await shot(p, 'schale-nur-chat-dunkel');
      await klick(p, /^Seitenleiste ausklappen$/, { warten: 300 });
      await klick(p, /^Übersicht ausklappen$/, { warten: 600 });
    });
    await step('Schale: offener Chat aus „Zuletzt“', async () => {
      const link = p.locator('.rail__chat').first();
      await link.waitFor({ state: 'visible', timeout: 4000 });
      await link.click();
      await p.waitForTimeout(1200);
      await shot(p, 'schale-chat-aus-zuletzt-dunkel');
    });
    await c.close();
  }
  {
    const { c, p } = await mach('light');
    await los(p, base, 'chat', 1600);
    await step('Schale: hell', async () => { await shot(p, 'schale-offen-hell'); });
    await c.close();
  }
  {
    // Das iPad des Nutzers, quer: Leiste und Chat, die Spalte zu.
    const { c, p } = await mach('dark', { breite: 1180, hoehe: 820, finger: true });
    await los(p, base, 'chat', 1600);
    await step('iPad quer', async () => { await shot(p, 'ipad-quer-1180-dunkel'); });
    await step('iPad quer: Spalte ausgeklappt', async () => {
      await klick(p, /^Übersicht ausklappen$/, { warten: 700 });
      await shot(p, 'ipad-quer-1180-spalte-offen-dunkel');
    });
    await c.close();
  }
  {
    const { c, p } = await mach('dark', { breite: 820, hoehe: 1180, finger: true });
    await los(p, base, 'chat', 1600);
    await step('iPad hoch', async () => { await shot(p, 'ipad-hoch-820-dunkel'); });
    await step('iPad hoch: Leiste als Schublade', async () => {
      await klick(p, /^Seitenleiste ausklappen$/, { warten: 700 });
      await shot(p, 'ipad-hoch-820-schublade-dunkel');
    });
    await c.close();
  }

  /* ============================== 1 · Jede Ansicht, hell und dunkel */
  for (const theme of ['light', 'dark']) {
    const suffix = theme === 'dark' ? 'dunkel' : 'hell';
    const { c, p } = await mach(theme);
    await los(p, base, 'chat', 1000);
    for (const [view, name] of VIEWS) {
      await los(p, base, view, view === 'graph' ? 2600 : 1200);
      await step(`Ansicht ${view} (${suffix})`, async () => { await shot(p, `${name}-${suffix}`); });
    }
    await c.close();
  }

  /* ======================================= 2 · Tastatur: Palette, Erfassung */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'chat', 1000);
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
    // Suchen ist die Palette: dieselbe Adresse, die ein Schlagwort in einer
    // Notiz aufruft.
    await step('Suche: Treffer', async () => {
      await p.evaluate(() => { window.location.hash = '#/search?q=mahlgrad druck'; });
      await p.waitForTimeout(1600);
      await shot(p, 'suche-treffer-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
    });
    await c.close();
  }
  {
    const { c, p } = await mach('light');
    await los(p, base, 'notes', 1200);
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

  /* ================================= 3 · Kalender und Notizwand im Detail */
  //
  // Die alte Notizansicht (Editor, Vorschau, Zweiter Blick) gibt es nicht mehr:
  // die Notizen macht die KI, die Ansicht ist eine Wand aus Post-its. Gezeigt
  // wird, was der Nutzer dort tut -- und woher ein Eintrag stammt.
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'kalender', 1400);
    await step('Kalender: automatischer Termin mit seinem Chat', async () => {
      const eintrag = p.locator('.kal__entry').first();
      await eintrag.waitFor({ state: 'visible', timeout: 4000 });
      await eintrag.click();
      await p.waitForTimeout(900);
      await shot(p, 'kalender-termin-aus-dem-chat-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
    });
    await step('Kalender: Woche', async () => {
      await klick(p, /^Woche$/, { warten: 900 });
      await shot(p, 'kalender-woche-dunkel');
    });
    await step('Kalender: neuer Termin', async () => {
      await klick(p, /^Termin$/, { warten: 600 });
      await shot(p, 'kalender-neuer-termin-dunkel');
      await p.keyboard.press('Escape');
      await klick(p, /^Monat$/, { warten: 400 });
    });
    await step('Notiz aus dem Chat, geöffnet', async () => {
      await los(p, base, 'notes', 1400);
      const zettel = p.locator('.nw__note', { hasText: 'aus dem Chat' }).first();
      await zettel.waitFor({ state: 'visible', timeout: 4000 });
      await zettel.click();
      await p.waitForTimeout(800);
      await shot(p, 'notiz-aus-dem-chat-dunkel');
      await p.keyboard.press('Escape');
    });
    await c.close();
  }

  /* ================================================== 4 · Das Gehirn */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'graph', 3000);
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
  //
  // Der Chat wird vom Bereich Chat-Oberflaeche neu gebaut; hier steht nur,
  // was die Schale zum Chat beitraegt: der leere Anfang und ein Chat aus
  // "Zuletzt". Die Offline-KI (Ollama) und der Vergleich zweier Modelle sind
  // auf Wunsch des Nutzers gestrichen und werden nicht mehr fotografiert.
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'chat', 1600);
    await step('Chat: Verlauf', async () => {
      const link = p.locator('.rail__chat', { hasText: 'Über Mahlgrad und Druck' }).first();
      await link.waitFor({ state: 'visible', timeout: 4000 });
      await link.click();
      await p.waitForTimeout(1200);
      await shot(p, 'chat-verlauf-dunkel');
    });
    await c.close();
  }

  /* ==================================================== 6 · Agenten */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'agents', 1600);
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

  /* ====================================================== 7 · Netz */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'network', 1500);
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

  /* ================================================ 8 · Einstellungen */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'settings', 1600);
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

  /* ================================================== 9 · Projekte */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'projects', 1500);
    await step('Projekt: Detail', async () => {
      await klick(p, /Küche einrichten/, { warten: 1200 });
      await shot(p, 'projekt-detail-dunkel');
    });
    await c.close();
  }

  /* ================================================= 10 · Werkstatt */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'workshop', 1800);
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

  /* =========================================== 11 · Einzelne Zustaende */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'chat', 1400);
    await step('Tastenkürzel', async () => {
      await p.locator('main').click({ position: { x: 5, y: 5 } }).catch(() => {});
      await p.keyboard.press('Shift+?');
      await p.waitForTimeout(800);
      if (!(await p.getByRole('heading', { name: 'Tastenkürzel' }).count())) throw new Error('„?“ öffnet die Übersicht nicht');
      await shot(p, 'tastenkuerzel-hell');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
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
    await step('Notiz: im Gehirn zeigen', async () => {
      await los(p, base, 'notes', 1500);
      // Die Notiz "Beetplanung", nicht eine aus dem Chat "Beetplanung 2027".
      await klick(p, /^Beetplanung,/, { warten: 1000 });
      await klick(p, /Im Gehirn zeigen/, { warten: 2800 });
      await shot(p, 'notiz-im-gehirn-hell');
    });
    await c.close();
  }

  /* =============================================== 12 · Sicherung */
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

  /* ============================================== 13 · Sicherung, dunkel */
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'backup', 1400);
    await step('Sicherung: dunkel', async () => { await shot(p, 'sicherung-zustand-dunkel'); });
    await c.close();
  }

  /* =============================================== 14 · Schmales Fenster */
  {
    const { c, p } = await mach('dark', { breite: 1024, hoehe: 768 });
    for (const [view, name] of [['chat', 'chat'], ['notes', 'notizen'], ['graph', 'gehirn']]) {
      await los(p, base, view, view === 'graph' ? 2600 : 1200);
      await step(`Schmal: ${view}`, async () => { await shot(p, `schmal-1024-${name}-dunkel`); });
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
