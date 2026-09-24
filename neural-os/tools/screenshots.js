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
  ['network', 'netz'], ['stick', 'stick'],
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
    // Kalender (Bereich Kalender-Oberflaeche): jede Ansicht, das Seitenblatt,
    // Schnell-Eintragen mit Vorschau, Ziehen mitten im Vorgang, die Frage bei
    // Serien und der Erinnerungshinweis.
    await los(p, base, 'kalender', 1400);
    await step('Kalender: Monat', async () => { await shot(p, 'kalender-monat-dunkel'); });
    await step('Kalender: Termin der KI mit seinem Chat', async () => {
      const eintrag = p.locator('.kal__entry', { hasText: 'Zahnarzt' }).first();
      await eintrag.waitFor({ state: 'visible', timeout: 4000 });
      await eintrag.click();
      await p.waitForTimeout(900);
      await shot(p, 'kalender-termin-der-ki-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
    });
    await step('Kalender: Woche', async () => {
      await klick(p, /^Woche$/, { warten: 900 });
      await shot(p, 'kalender-woche-dunkel');
    });
    await step('Kalender: Serie im Seitenblatt', async () => {
      const block = p.locator('.kal__block', { hasText: 'Training' }).first();
      await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await block.click();
      await p.waitForTimeout(900);
      await shot(p, 'kalender-serie-seitenblatt-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
    });
    await step('Kalender: Ziehen mitten im Vorgang', async () => {
      const block = p.locator('.kal__block', { hasText: 'Dichtung' }).first();
      await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const box = await block.boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + 6);
      await p.mouse.down();
      await p.mouse.move(box.x + box.width * 1.5, box.y + 70, { steps: 10 });
      await p.waitForTimeout(200);
      await shot(p, 'kalender-ziehen-dunkel');
      await p.keyboard.press('Escape');
      await p.mouse.up();
      await p.waitForTimeout(400);
    });
    await step('Kalender: Serie gezogen -- nur dieser oder alle', async () => {
      const block = p.locator('.kal__block', { hasText: 'Training' }).last();
      await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const box = await block.boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + 6);
      await p.mouse.down();
      await p.mouse.move(box.x + box.width / 2, box.y + 54, { steps: 8 });
      await p.mouse.up();
      await p.waitForTimeout(500);
      await shot(p, 'kalender-serie-frage-dunkel');
      await klick(p, /^Abbrechen$/, { warten: 400 });
    });
    await step('Kalender: Tag', async () => {
      await klick(p, /^Tag$/, { warten: 900 });
      await shot(p, 'kalender-tag-dunkel');
    });
    await step('Kalender: Liste „Als Nächstes“', async () => {
      await klick(p, /^Liste$/, { warten: 900 });
      await shot(p, 'kalender-liste-dunkel');
    });
    await step('Kalender: Schnell eintragen mit Vorschau', async () => {
      const feld = p.getByRole('textbox', { name: 'Neuer Termin' });
      await feld.click();
      await p.keyboard.type('jeden Dienstag 18-19:30 Chorprobe @ Gemeindehaus', { delay: 15 });
      await p.waitForTimeout(700);
      await shot(p, 'kalender-schnell-eintragen-dunkel');
      await feld.fill('');
      await p.keyboard.press('Escape');
      await klick(p, /^Monat$/, { warten: 600 });
    });
    await step('Kalender: Erinnerung oben rechts', async () => {
      // Ein eigener Termin, der jetzt faellig ist -- und danach wieder weg,
      // damit der Hinweis nicht auf den Bildern der anderen Bereiche steht.
      const pad = (n) => String(n).padStart(2, '0');
      const wand = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
      const bald = new Date(Date.now() + 12 * 60000);
      const probe = app.store.create('event', { title: 'Rückruf Hausverwaltung', start: wand(bald), end: wand(new Date(bald.getTime() + 15 * 60000)), location: 'Büro', reminder: 15 });
      try {
        await p.locator('.erin__card').first().waitFor({ state: 'visible', timeout: 6000 });
        await p.waitForTimeout(400);
        await shot(p, 'kalender-erinnerung-dunkel');
      } finally {
        app.store.remove(probe.id);
      }
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

  {
    // Kalender hell, und auf dem iPad des Nutzers (quer, mit dem Finger).
    for (const [mode, name] of [['woche', 'woche'], ['monat', 'monat']]) {
      const { c, p } = await mach('light');
      await p.addInitScript((m) => { try { localStorage.setItem('neural-os:kalender-ansicht', m); } catch { /* egal */ } }, mode);
      await los(p, base, 'kalender', 1400);
      await step(`Kalender: ${name} (hell)`, async () => { await shot(p, `kalender-${name}-hell`); });
      await c.close();
    }
    for (const [mode, name] of [['woche', 'woche'], ['monat', 'monat'], ['tag', 'tag'], ['liste', 'liste']]) {
      const { c, p } = await mach('dark', { breite: 1180, hoehe: 820, finger: true });
      await p.addInitScript((m) => { try { localStorage.setItem('neural-os:kalender-ansicht', m); } catch { /* egal */ } }, mode);
      await los(p, base, 'kalender', 1400);
      await step(`Kalender: ${name} (iPad quer)`, async () => { await shot(p, `ipad-quer-kalender-${name}-dunkel`); });
      await c.close();
    }
  }

  /* ================================================== 4 · Das Gehirn */
  //
  // Nach docs/vorlage/gehirn-obsidian.png: das ruhende Netz, das Panel oben
  // rechts mit Filter, Gruppen, Anzeige, Kraefte, ein gewaehlter Knoten mit
  // seinem schmalen Kaertchen.
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'graph', 800);
    const ruhe = () => p.waitForFunction(() => {
      const g = document.querySelector('.gh');
      return g && g.dataset.ruhe === 'ja';
    }, null, { timeout: 12000 });
    await step('Gehirn: das ruhende Netz', async () => {
      await ruhe();
      await p.waitForTimeout(700);
      await shot(p, 'gehirn-dunkel');
    });
    await step('Gehirn: Suchen und Wählen', async () => {
      // Das Panel ist auf schmaler Karte zu; dann wird es erst geoeffnet.
      if (await p.locator('.gh__opener').isVisible()) await p.locator('.gh__opener').click();
      await p.locator('.gh__panel summary', { hasText: 'Filter' }).first().click();
      await p.getByLabel('Im Gehirn suchen').fill('Espresso');
      await p.getByLabel('Im Gehirn suchen').press('Enter');
      await p.locator('.gh__card').waitFor({ state: 'visible', timeout: 4000 });
      await p.waitForTimeout(900);
      await shot(p, 'gehirn-auswahl-dunkel');
    });
    await step('Gehirn: Gruppen nach Thema', async () => {
      await p.getByRole('button', { name: 'Auswahl schließen' }).click();
      await p.getByLabel('Im Gehirn suchen').fill('');
      await p.getByLabel('Im Gehirn suchen').press('Escape');
      await p.locator('.gh__panel summary', { hasText: 'Filter' }).first().click();
      await p.locator('.gh__panel summary', { hasText: 'Gruppen' }).first().click();
      await p.getByRole('switch', { name: 'Nach Thema einfärben' }).click();
      await p.keyboard.press('0');
      await p.waitForTimeout(1200);
      await shot(p, 'gehirn-gruppen-dunkel');
    });
    await step('Gehirn: Anzeige und Kräfte', async () => {
      await p.locator('.gh__panel summary', { hasText: 'Gruppen' }).first().click();
      await p.locator('.gh__panel summary', { hasText: 'Anzeige' }).first().click();
      await p.locator('.gh__panel summary', { hasText: 'Kräfte' }).first().click();
      await p.waitForTimeout(500);
      await shot(p, 'gehirn-panel-dunkel');
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
  //
  // Die Ansicht "Agenten" ist die Hintergrundaktivitaet (wer arbeitet, wie
  // lange, was entstand) -- Agenten anlegen und einstellen gibt es nicht
  // mehr. Der Chat mit Claude, Rueckfragen und die Karten "Termin
  // eingetragen" fotografiert tools/chat-beweis.js, denn dafuer braucht es
  // einen Statisten an Anthropics Stelle; hier gibt es keinen Schluessel.
  {
    const { c, p } = await mach('light');
    await los(p, base, 'agents', 1600);
    await step('Agenten: Hintergrundaktivität', async () => {
      await p.locator('.agv__abschnitt').first().waitFor({ timeout: 4000 });
      await shot(p, 'agenten-hintergrund-hell');
    });
    await step('Agenten: ein Lauf aufgeklappt', async () => {
      const lauf = p.locator('.agv__lauf').first();
      await lauf.waitFor({ timeout: 4000 });
      await lauf.locator('summary').click();
      await p.waitForTimeout(700);
      await shot(p, 'agenten-lauf-offen-hell');
    });
    await c.close();
  }
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'chat', 1400);
    await step('Chat ohne Claude: „Verbinde Claude“', async () => {
      await p.locator('.cv-verbinden').waitFor({ timeout: 4000 });
      await shot(p, 'chat-verbinde-claude-dunkel');
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

  /* ======================================= 12 · Stick und Sicherung */
  //
  // Der Bereich "Stick" hat vier Knoepfe: Stick vorbereiten, Jetzt sichern,
  // (klein) Wiederherstellen, Beenden & abziehen. Festgehalten wird jeder
  // Zustand, den ein Mensch dort sieht -- die Rueckfrage nach dem Internet,
  // der Balken, "fertig" mit der Anleitung, die Sicherung auf dem Stick und
  // die Vorschau vor dem Zurueckspielen. "Beenden" kommt ganz zum Schluss
  // (Abschnitt 99), weil danach kein Server mehr da ist.
  //
  // An diesem Rechner steckt kein Stick. Die Suche ist trotzdem die echte
  // Funktion; nur ihre Wurzel zeigt auf einen Ordner, der wie /media aussieht.
  const medien = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-shots-medien-'));
  const stickOrt = path.join(medien, 'USB-STICK');
  fs.mkdirSync(stickOrt);
  {
    const stickMod = require('../src/portable/stick');
    app.findeLaufwerke = (opts) => stickMod.findeLaufwerke({
      ...opts, platform: 'linux', wurzeln: [medien], einhaengepunkt: (d) => d === stickOrt,
    });
    const { c, p } = await mach('dark');
    await los(p, base, 'stick', 1600);
    await step('Stick: gefunden, ein Knopf', async () => { await shot(p, 'stick-gefunden-dunkel'); });
    await step('Stick: die eine Rückfrage', async () => {
      await klick(p, /^Stick vorbereiten$/, { warten: 900 });
      await shot(p, 'stick-rueckfrage-internet-dunkel');
    });
    await step('Stick: der Balken', async () => {
      await klick(p, /^Nur /, { warten: 10 });
      await p.locator('.stickv__bar').waitFor({ timeout: 10000 });
      for (let i = 0; i < 200; i++) {
        const t = await p.locator('.stickv__lauf-text').innerText().catch(() => '');
        const m = /^(\d+) %/.exec(t);
        if (m && Number(m[1]) >= 15) break;
        await p.waitForTimeout(20);
      }
      await shot(p, 'stick-balken-dunkel');
    });
    await step('Stick: fertig, drei Sätze', async () => {
      await p.locator('.stickv__fertig').waitFor({ timeout: 120000 });
      await p.waitForTimeout(600);
      await shot(p, 'stick-fertig-dunkel');
    });
    await step('Sicherung: auf dem Stick', async () => {
      await klick(p, /^Jetzt sichern$/, { warten: 300 });
      await p.locator('.stickv__sichern [role=status]').waitFor({ timeout: 60000 });
      await p.waitForTimeout(600);
      await shot(p, 'sicherung-auf-dem-stick-dunkel');
    });
    await step('Sicherung: Vorschau vor dem Zurückspielen', async () => {
      await p.locator('summary', { hasText: 'Von einer Sicherung wiederherstellen' }).click();
      await p.waitForTimeout(900);
      await p.locator('.stickv__eintrag').first().click();
      await p.locator('.stickv__vorschau').waitFor({ timeout: 30000 });
      await p.locator('.stickv__vorschau').scrollIntoViewIfNeeded();
      await p.waitForTimeout(500);
      await shot(p, 'sicherung-vorschau-dunkel');
    });
    await c.close();
  }
  {
    const { c, p } = await mach('light');
    await los(p, base, 'stick', 1600);
    await step('Stick: hell', async () => { await shot(p, 'stick-hell'); });
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

  /* ====================================== 99 · Beenden & abziehen */
  //
  // Zuletzt, weil danach kein Server mehr da ist. Das Ende ist das echte
  // app.close(); nur process.exit (das die Kommandozeile danach aufruft)
  // bleibt hier aus, sonst endete dieses Werkzeug mitten im Bild.
  {
    app.beenden = () => app.close();
    const { c, p } = await mach('dark', { breite: 1180, hoehe: 820, finger: true });
    await los(p, base, 'stick', 1600);
    // Nach dem Beenden antwortet absichtlich kein Server mehr. Was die Schale
    // und die Kacheln danach vergeblich abfragen, ist der Beweis dafuer und
    // kein Fehler der Anwendung -- es zaehlt deshalb nicht als Konsolenfehler.
    const konsoleVorher = konsole.length;
    await step('Beenden & abziehen', async () => {
      await klick(p, /Beenden & abziehen/, { warten: 400 });
      await klick(p, /^Beenden$/, { warten: 200 });
      await p.locator('.stickv__ende[data-zustand="fertig"]').waitFor({ timeout: 30000 });
      await p.waitForTimeout(400);
      await shot(p, 'stick-jetzt-abziehen-ipad-dunkel');
    });
    await c.close();
    konsole.splice(konsoleVorher);
  }

  await browser.close();
  await app.close();

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(medien, { recursive: true, force: true });

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
