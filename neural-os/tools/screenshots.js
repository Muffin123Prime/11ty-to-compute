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

  // Die Stick-Suche sieht nur dort nach, wo dieses Werkzeug einen „Stick“ hinlegt.
  app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', kopplung: { einhaengepunkte: () => [...STICK_WELT] } });
  await app.loadModules({});
  if (app.graph && app.graph.scanAll) app.graph.scanAll(app.store, {});
  if (app.assist) await app.assist.scan({});
  await app.store.flush();
  const server = await app.listen();
  return { app, home, base: `http://127.0.0.1:${server.server.address().port}` };
}

/** Welche „Sticks“ gerade stecken (Ordner; Abschnitt 12). */
const STICK_WELT = new Set();

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

/** Hell ist eine Wahl, keine Systemvorgabe: dunkel ist die Voreinstellung. Gemerkt je KI (web/lib/lokal.js). */
const THEMA = (kiId) => `neural-os:${kiId}:design`;

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
    await c.addInitScript(([k, t]) => { try { localStorage.setItem(k, t); } catch { /* egal */ } }, [THEMA(app.ki.id), theme]);
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
    // Notizen als Teil des Wissensnetzes (web/views/notes.js): Liste mit
    // Schlagwort-Filter, "Verknuepft mit", die Vorschlagskarte, der Editor
    // mit der Liste hinter "[[", die Rueckfrage beim Verwerfen und das Plus.
    await step('Notizen: Liste, Schlagwort #biologie', async () => {
      await los(p, base, 'notes', 1400);
      await p.locator('.nw__modus .segmented__option', { hasText: 'Liste' }).click();
      await p.locator('.nw__tag[data-tag="biologie"]').click();
      await p.waitForTimeout(500);
      await shot(p, 'notizen-liste-biologie-dunkel');
      // Zurueck auf die ganze Wand: der Filter steht in der Adresse (?tag=),
      // ein erneutes Aufrufen derselben Adresse baut die Ansicht nicht neu.
      await p.locator('.nw__modus .segmented__option', { hasText: 'Wand' }).click();
      await p.locator('.nw__tag', { hasText: /^Alle$/ }).click();
    });
    await step('Notiz: Verknüpft mit, Callout, Haken', async () => {
      await los(p, base, 'notes', 1400);
      await klick(p, /^Photosynthese,/, { warten: 1400 });
      await shot(p, 'notiz-verknuepft-mit-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
    });
    await step('Notiz: Verbindungsvorschläge', async () => {
      await klick(p, /^Chlorophyll absorbiert Licht,/, { warten: 1400 });
      const karte = p.locator('.nw__card');
      await karte.waitFor({ state: 'visible', timeout: 8000 });
      await shot(p, 'notiz-vorschlaege-dunkel');
      await karte.getByRole('button', { name: /^Bearbeiten$/ }).click();
      await p.waitForTimeout(400);
      await shot(p, 'notiz-vorschlaege-bearbeiten-dunkel');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
    });
    await step('Notiz: Editor mit der Liste hinter [[', async () => {
      await klick(p, /^Photosynthese,/, { warten: 1400 });
      await p.locator('.nw__read-foot').getByRole('button', { name: /^Bearbeiten$/ }).click();
      await p.waitForTimeout(700);
      await p.locator('.nos-ne__area').click();
      await p.keyboard.press('Control+End');
      await p.keyboard.type('\n\nSiehe auch [[Zell');
      await p.locator('.nos-ne__list').waitFor({ state: 'visible', timeout: 4000 });
      await shot(p, 'notiz-editor-vervollstaendigung-dunkel');
      await p.keyboard.press('Escape'); // erst die Liste ...
      await p.waitForTimeout(200);
      await p.keyboard.press('Escape'); // ... dann der Editor: die Rueckfrage
      await p.waitForTimeout(500);
      await shot(p, 'notiz-editor-verwerfen-dunkel');
      await p.getByRole('button', { name: /^Verwerfen$/ }).click();
      await p.waitForTimeout(400);
    });
    await step('Notizen: das Plus (Neu)', async () => {
      await p.locator('[data-nw-plus]').click();
      await p.waitForTimeout(400);
      await shot(p, 'notizen-plus-menue-dunkel');
      await p.locator('[data-neu="link"]').click();
      await p.waitForTimeout(500);
      await shot(p, 'notizen-link-speichern-dunkel');
      await p.keyboard.press('Escape');
    });
    await c.close();
  }

  {
    // Die Notiz mit ihren Verknuepfungen auf dem iPad des Nutzers (quer, Finger).
    const { c, p } = await mach('dark', { breite: 1180, hoehe: 820, finger: true });
    await step('iPad: Notiz mit Verknüpfungen', async () => {
      await los(p, base, 'notes', 1500);
      await p.getByRole('button', { name: /^Photosynthese,/ }).first().tap();
      await p.waitForTimeout(1400);
      await shot(p, 'ipad-quer-notiz-verknuepft-dunkel');
    });
    await c.close();
  }

  {
    // Kalender hell, und auf dem iPad des Nutzers (quer, mit dem Finger).
    for (const [mode, name] of [['woche', 'woche'], ['monat', 'monat']]) {
      const { c, p } = await mach('light');
      await p.addInitScript(([k, m]) => { try { localStorage.setItem(k, m); } catch { /* egal */ } }, [`neural-os:${app.ki.id}:kalender-ansicht`, mode]);
      await los(p, base, 'kalender', 1400);
      await step(`Kalender: ${name} (hell)`, async () => { await shot(p, `kalender-${name}-hell`); });
      await c.close();
    }
    for (const [mode, name] of [['woche', 'woche'], ['monat', 'monat'], ['tag', 'tag'], ['liste', 'liste']]) {
      const { c, p } = await mach('dark', { breite: 1180, hoehe: 820, finger: true });
      await p.addInitScript(([k, m]) => { try { localStorage.setItem(k, m); } catch { /* egal */ } }, [`neural-os:${app.ki.id}:kalender-ansicht`, mode]);
      await los(p, base, 'kalender', 1400);
      await step(`Kalender: ${name} (iPad quer)`, async () => { await shot(p, `ipad-quer-kalender-${name}-dunkel`); });
      await c.close();
    }
  }

  /* ================================================== 4 · Das Gehirn */
  //
  // Das Wissensuniversum (Vision vom 27.09.2026): Ebene 0 mit Themenkreisen,
  // hineingezoomt in ein Thema, ein ueberfahrener Knoten mit Nachbarn, ein
  // gewaehlter mit seiner Informationskarte, die ruhige Themenkarte, der
  // leere Zustand -- dunkel, hell und auf dem iPad quer mit dem Finger.
  {
    const { c, p } = await mach('dark');
    const bereit = () => p.waitForFunction(() => {
      const g = document.querySelector('.gh');
      return g && g.gehirn && (g.gehirn.themen > 0 || g.gehirn.leer);
    }, null, { timeout: 15000 });
    const ruhe = () => p.waitForFunction(() => {
      const g = document.querySelector('.gh');
      return g && g.dataset.ruhe === 'ja';
    }, null, { timeout: 12000 });
    const groesstes = () => p.evaluate(() => {
      const g = document.querySelector('.gh').gehirn;
      let best = null;
      for (const id of g.themenIds) {
        const q = g.screenPosition(id);
        if (q && (!best || q.r > best.r)) best = { id, ...q };
      }
      return best;
    });
    await los(p, base, 'graph', 600);
    await step('Gehirn: das Universum', async () => {
      await bereit();
      await p.waitForTimeout(1200);
      await shot(p, 'gehirn-universum-dunkel');
    });
    let kreis = null;
    let box = null;
    await step('Gehirn: ein Thema überfahren', async () => {
      kreis = await groesstes();
      box = await p.locator('.gh').boundingBox();
      if (!kreis || !box) throw new Error('kein Themenkreis');
      await p.mouse.move(box.x + kreis.x, box.y + kreis.y);
      await p.waitForTimeout(500);
      await shot(p, 'gehirn-universum-hover-dunkel');
    });
    await step('Gehirn: hineingezoomt in ein Thema', async () => {
      if (!kreis) throw new Error('kein Themenkreis');
      await p.mouse.click(box.x + kreis.x, box.y + kreis.y);
      await p.waitForFunction(() => document.querySelector('.gh').gehirn.ebene === 1, null, { timeout: 8000 });
      await ruhe();
      await p.waitForTimeout(600);
      await shot(p, 'gehirn-thema-dunkel');
    });
    let knoten = null;
    await step('Gehirn: Knoten überfahren, Nachbarn hell, Rest tritt zurück', async () => {
      knoten = await p.evaluate(() => {
        const g = document.querySelector('.gh').gehirn;
        // Der Knoten mit den meisten Nachbarn ist der lesbarste Fall.
        let best = null;
        for (const id of g.ids) {
          const q = g.screenPosition(id);
          if (q && (!best || q.r > best.r)) best = { id, ...q };
        }
        return best;
      });
      if (!knoten) throw new Error('kein Knoten');
      await p.mouse.move(box.x + knoten.x, box.y + knoten.y);
      await p.waitForTimeout(500);
      await shot(p, 'gehirn-hover-dunkel');
    });
    await step('Gehirn: Auswahl mit Informationskarte', async () => {
      if (!knoten) throw new Error('kein Knoten');
      await p.mouse.click(box.x + knoten.x, box.y + knoten.y);
      await p.locator('.gh__card').waitFor({ state: 'visible', timeout: 6000 });
      await p.locator('.gh__link').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
      await p.waitForTimeout(900);
      await shot(p, 'gehirn-auswahl-karte-dunkel');
    });
    await step('Gehirn: die Themenkarte', async () => {
      await p.getByRole('button', { name: 'Auswahl schließen' }).click().catch(() => {});
      await p.getByRole('tab', { name: 'Karte' }).click();
      await p.locator('.wk__tile').first().waitFor({ state: 'visible', timeout: 6000 });
      await p.waitForTimeout(500);
      await shot(p, 'gehirn-karte-dunkel');
      await p.locator('.wk__tile').first().click();
      await p.locator('.wk__row').first().waitFor({ state: 'visible', timeout: 6000 });
      await p.waitForTimeout(500);
      await shot(p, 'gehirn-karte-thema-dunkel');
    });
    await c.close();
  }
  {
    const { c, p } = await mach('light');
    await los(p, base, 'graph', 600);
    await step('Gehirn: Universum (hell)', async () => {
      await p.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.themen > 0; }, null, { timeout: 15000 });
      await p.waitForTimeout(1200);
      await shot(p, 'gehirn-universum-hell');
    });
    await step('Gehirn: Thema (hell)', async () => {
      const id = await p.evaluate(() => document.querySelector('.gh').gehirn.themenIds[0]);
      await p.evaluate((t) => document.querySelector('.gh').gehirn.tauchen(t), id);
      await p.waitForFunction(() => document.querySelector('.gh').dataset.ruhe === 'ja', null, { timeout: 12000 });
      await p.waitForTimeout(600);
      await shot(p, 'gehirn-thema-hell');
    });
    await c.close();
  }
  {
    // Das iPad des Nutzers, quer, mit dem Finger: Antippen oeffnet ein Thema.
    const { c, p } = await mach('dark', { breite: 1180, hoehe: 820, finger: true });
    await los(p, base, 'graph', 600);
    await step('Gehirn: Universum (iPad quer)', async () => {
      await p.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.themen > 0; }, null, { timeout: 15000 });
      await p.waitForTimeout(1200);
      await shot(p, 'ipad-quer-gehirn-universum-dunkel');
    });
    await step('Gehirn: Thema angetippt (iPad quer)', async () => {
      const kreis = await p.evaluate(() => {
        const g = document.querySelector('.gh').gehirn;
        let best = null;
        for (const id of g.themenIds) {
          const q = g.screenPosition(id);
          if (q && (!best || q.r > best.r)) best = { id, ...q };
        }
        return best;
      });
      const box = await p.locator('.gh').boundingBox();
      if (!kreis || !box) throw new Error('kein Themenkreis');
      await p.touchscreen.tap(box.x + kreis.x, box.y + kreis.y);
      await p.waitForFunction(() => document.querySelector('.gh').dataset.ruhe === 'ja', null, { timeout: 12000 });
      await p.waitForTimeout(600);
      await shot(p, 'ipad-quer-gehirn-thema-dunkel');
    });
    await c.close();
  }
  {
    // Der leere Zustand: ein zweiter, wirklich leerer Tresor (ohne Startsaetze).
    const leerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-os-shots-leer-'));
    const leerApp = await createApp({ home: leerHome, port: 0, host: '127.0.0.1', logLevel: 'error' });
    await leerApp.loadModules({});
    const leerServer = await leerApp.listen();
    const leerBase = `http://127.0.0.1:${leerServer.server.address().port}`;
    const { c, p } = await mach('dark');
    await los(p, leerBase, 'graph', 600);
    await step('Gehirn: leerer Zustand', async () => {
      await p.waitForFunction(() => { const g = document.querySelector('.gh'); return g && g.gehirn && g.gehirn.leer; }, null, { timeout: 15000 });
      await p.waitForTimeout(500);
      await shot(p, 'gehirn-leer-dunkel');
    });
    await c.close();
    await leerApp.close();
    fs.rmSync(leerHome, { recursive: true, force: true });
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
    await step('Chat ohne KI: „Verbinde eine KI“', async () => {
      await p.locator('.cv-verbinden').waitFor({ timeout: 4000 });
      await shot(p, 'chat-verbinde-ki-dunkel');
    });
    await c.close();
  }

  /* ====================================================== 7 · Netz */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'network', 1500);
    await step('Netz: offline', async () => { await shot(p, 'netz-offline-hell'); });
    // Die Ansicht ist schlicht (web/views/network.js): Zustand, Schalter, die
    // Liste der Verbindungen -- wohin Neural OS wollte und ob es durfte.
    await step('Netz: Verbindungen', async () => {
      await p.evaluate(() => {
        const h = [...document.querySelectorAll('h2,h3')].find((x) => /^Verbindungen/.test(x.textContent.trim()));
        if (h) h.scrollIntoView({ block: 'start' });
      });
      await p.waitForTimeout(700);
      await shot(p, 'netz-verbindungen-hell');
    });
    await c.close();
  }

  /* ================================================ 8 · Einstellungen */
  {
    const { c, p } = await mach('light');
    await los(p, base, 'settings', 1600);
    for (const [ueberschrift, name] of [
      ['Name dieser KI', 'einstellungen-name-hell'],
      ['Gedächtnis', 'einstellungen-gedaechtnis-hell'],
      ['Schutz', 'einstellungen-schutz-hell'],
      ['iPad verbinden', 'einstellungen-ipad-hell'],
      ['Speicher', 'einstellungen-speicher-hell'],
      ['Beobachtete Ordner', 'einstellungen-beobachtete-ordner-hell'],
      ['Diagnose', 'einstellungen-diagnose-hell'],
    ]) {
      await step(`Einstellungen: ${ueberschrift}`, async () => {
        const traf = await p.evaluate((t) => {
          // Beobachtete Ordner und Diagnose liegen eingeklappt unter „Für Fortgeschrittene“.
          for (const d of document.querySelectorAll('details')) d.open = true;
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
    await step('Werkstatt: leer', async () => { await shot(p, 'werkstatt-dunkel'); });
    await step('Werkstatt: Code eingefügt', async () => {
      // Das Beispiel aus docs/ERWEITERN.md: ein Werkzeug für die Agenten.
      const code = [
        'module.exports = {',
        "  manifest: { name: 'Offene Aufgaben', description: 'Gibt Agenten eine Liste der offenen Aufgaben.', kind: 'server', capabilities: ['records.read', 'tools.add'] },",
        '  setup(api) {',
        "    api.tool({ name: 'tasks.open', description: 'Listet alle Aufgaben, die noch nicht erledigt sind.', parameters: { type: 'object', properties: {} },",
        "      run() { const t = api.records.list('task').filter((x) => x.data.status !== 'done'); return { anzahl: t.length }; } });",
        '  },',
        '};',
      ].join('\n');
      await p.locator('textarea[aria-label="Code einfügen"]').first().fill(code);
      await p.waitForTimeout(400);
      await shot(p, 'werkstatt-code-eingefuegt-dunkel');
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
    await step('Notiz: Verbindungsvorschläge (hell)', async () => {
      await los(p, base, 'notes', 1500);
      await klick(p, /^Chlorophyll absorbiert Licht,/, { warten: 1400 });
      await p.locator('.nw__card').waitFor({ state: 'visible', timeout: 8000 });
      await shot(p, 'notiz-vorschlaege-hell');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
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
  // Der Bereich "Stick" (docs/STICK-BAUPLAN.md 1.6/1.7): ein leerer Stick
  // mit [Neue KI], die eine Rueckfrage nach dem Internet, der Balken,
  // "Fertig. Stick kann raus.", ein anderer Stick mit [Koppeln], danach
  // "Gekoppelt mit Lena", die Sicherung und die Vorschau vor dem
  // Zurueckspielen. "Beenden" kommt ganz zum Schluss (Abschnitt 99), weil
  // danach kein Server mehr da ist.
  //
  // An diesem Rechner steckt kein Stick. Die Suche ist trotzdem die echte
  // Funktion; nur ihre Einhaengepunkte sind Ordner (STICK_WELT).
  const medien = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-shots-medien-'));
  const stickOrt = path.join(medien, 'USB-STICK');
  fs.mkdirSync(stickOrt);
  STICK_WELT.add(stickOrt);
  // Lena: ein Stick mit eigener KI, einmal gestartet und wieder beendet.
  const lena = path.join(medien, 'LENA');
  {
    const pathsMod = require('../src/kernel/paths');
    fs.mkdirSync(path.join(lena, 'data'), { recursive: true });
    fs.mkdirSync(path.join(lena, 'app'), { recursive: true });
    fs.writeFileSync(path.join(lena, 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version: require('../package.json').version }));
    fs.writeFileSync(path.join(lena, pathsMod.PORTABLE_MARKER), JSON.stringify({ neuralOsPortable: true, dataDir: 'data', appDir: 'app' }, null, 2));
    const b = await createApp({ home: path.join(lena, 'data'), appDir: path.join(lena, 'app'), port: 0, host: '127.0.0.1', logLevel: 'error', kopplung: { automatisch: false, einhaengepunkte: () => [] } });
    b.identitaet.umbenennen('Lena');
    await b.close();
  }
  {
    const { c, p } = await mach('dark');
    await los(p, base, 'stick', 1600);
    await step('Stick: ein leerer Stick, [Neue KI]', async () => { await shot(p, 'stick-leerer-stick-dunkel'); });
    await step('Stick: die eine Rückfrage', async () => {
      await klick(p, /^Neue KI$/, { warten: 900 });
      await shot(p, 'stick-rueckfrage-internet-dunkel');
    });
    await step('Stick: der Balken', async () => {
      // Der Balken gleitet nach (200 ms, mit „Bewegung reduzieren“ noch 1 ms),
      // das Bild entsteht sofort -- und zeigte ihn leer neben „36 %“. Ohne
      // Uebergang zeigt er, was der Satz sagt.
      await p.addStyleTag({ content: '.stickv__bar-fill { transition: none !important; }' });
      await klick(p, /^Nur /, { warten: 10 });
      await p.locator('.stickv__bar').waitFor({ timeout: 10000 });
      for (let i = 0; i < 200; i++) {
        const t = await p.locator('.stickv__lauf-text').innerText().catch(() => '');
        const m = /(\d+) %$/.exec(t);
        if (m && Number(m[1]) >= 15) break;
        await p.waitForTimeout(20);
      }
      await shot(p, 'stick-balken-dunkel');
    });
    await step('Stick: Fertig. Stick kann raus.', async () => {
      await p.locator('.stickv__fertig').waitFor({ timeout: 120000 });
      await p.waitForTimeout(600);
      await shot(p, 'stick-fertig-dunkel');
    });
    await step('Stick: anderer Stick, [Koppeln]', async () => {
      STICK_WELT.delete(stickOrt);
      STICK_WELT.add(lena);
      await klick(p, /^Neu suchen$/, { warten: 900 });
      await p.locator('.stickv__reihe[data-art="fremd"]', { hasText: 'Lena' }).waitFor({ timeout: 10000 });
      await shot(p, 'stick-anderer-stick-dunkel');
    });
    await step('Stick: Gekoppelt mit Lena', async () => {
      await klick(p, /^Koppeln$/, { warten: 400 });
      await p.locator('.stickv__reihe[data-art="partner"]').waitFor({ timeout: 15000 });
      await p.waitForTimeout(500);
      await shot(p, 'stick-gekoppelt-dunkel');
    });
    await step('Stick: Entkoppeln? (in der Seite)', async () => {
      await klick(p, /^Entkoppeln$/, { warten: 400 });
      await p.locator('.stickv__rueckfrage').waitFor({ timeout: 4000 });
      await shot(p, 'stick-entkoppeln-frage-dunkel');
      await klick(p, /^Abbrechen$/, { warten: 300 });
    });
    await step('Sicherung', async () => {
      await klick(p, /^Jetzt sichern$/, { warten: 300 });
      await p.locator('.stickv__sichern [role=status]').waitFor({ timeout: 60000 });
      await p.locator('.stickv__sichern').scrollIntoViewIfNeeded();
      await p.waitForTimeout(600);
      await shot(p, 'sicherung-dunkel');
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

  /* ====================================== 99 · Beenden */
  //
  // Zuletzt, weil danach kein Server mehr da ist. [Beenden] steht unten
  // links in der Leiste (web/app.js). Das Ende ist das echte app.close();
  // nur process.exit (das die Kommandozeile danach aufruft) bleibt hier aus,
  // sonst endete dieses Werkzeug mitten im Bild.
  {
    app.beenden = () => app.close();
    const { c, p } = await mach('dark', { breite: 1180, hoehe: 820, finger: true });
    await los(p, base, 'chat', 1600);
    // Nach dem Beenden antwortet absichtlich kein Server mehr. Was die Schale
    // und die Kacheln danach vergeblich abfragen, ist der Beweis dafuer und
    // kein Fehler der Anwendung -- es zaehlt deshalb nicht als Konsolenfehler.
    const konsoleVorher = konsole.length;
    await step('Beenden', async () => {
      await klick(p, /^Neural OS beenden$/, { warten: 400 });
      await p.locator('#aus').waitFor({ timeout: 30000 });
      await p.waitForTimeout(400);
      await shot(p, 'beendet-ipad-dunkel');
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
