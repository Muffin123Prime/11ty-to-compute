'use strict';

/**
 * Beweis der Insel (web/lib/insel.js) -- im echten Browser, gegen die echte
 * Anwendung, mit einem Statisten an Googles Stelle.
 *
 *   node tools/insel-beweis.js                 Bilder nach ./screenshots/insel
 *   node tools/insel-beweis.js --out /pfad     woandershin
 *
 * Geprueft wird, was ein Mensch tut: die Pille antippen, fragen, zusehen,
 * wie es schreibt, mittendrin stoppen; den Bildschirm zeigen und fragen
 * "was siehst du?" (an den Statisten geht dann ein echtes Bild vom
 * Bildschirm); einen Timer stellen und klingeln lassen; "Notiz: …";
 * etwas kopieren und "Erklär mir das"; ein Bild einfuegen; eine Rueckfrage
 * antippen; die KI einen Termin eintragen lassen; die Insel ueber alle
 * Fenster legen (Document Picture-in-Picture) und dort weiterfragen; eine
 * Erinnerung als Kapsel; Neuladen; Telefon und iPad. Jeder Schritt wird im
 * Tresor oder an der Anfrage beim Statisten nachgesehen, nicht nur am
 * Bildschirm.
 *
 * Zwei Dinge sind hier anders als am echten Rechner, mit Absicht und nur
 * hier:
 * - Den Bildschirm waehlt ein Mensch im Dialog des Browsers. Ein Browser
 *   ohne Bildschirm hat diesen Dialog nicht; mit --auto-accept-this-tab-capture
 *   nimmt Chromium stattdessen ohne Rueckfrage den eigenen Tab. Dafuer
 *   ergaenzt ein Vorspann-Skript beim Aufruf von getDisplayMedia
 *   `preferCurrentTab` -- geteilt wird trotzdem wirklich, und das Bild ist
 *   ein echtes Bild dieses Tabs.
 * - Mitteilungen des Betriebssystems werden mitgeschrieben statt gezeigt.
 *
 * Was es NICHT beweist: wie gross das schwebende Fenster am echten
 * Bildschirm ist (ohne Bildschirm nimmt Chromium die Groesse des Tabs) und
 * wie sich Google wirklich verhaelt (der Statist spricht die Form aus
 * docs/CLAUDE-ANBINDUNG.md, Abschnitt 9).
 *
 * Playwright wird global gesucht; Neural OS selbst braucht es nicht.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, seedIfEmpty } = require('../src/app');
const gs = require('../test/gemini-statist');
const { anfrage } = require('../test/antwort-hilfe');
const { findPlaywright, findChromium } = require('./lib/browser');

const G = '\u001b[32m'; const R = '\u001b[31m'; const Y = '\u001b[33m';
const D = '\u001b[2m'; const BO = '\u001b[1m'; const X = '\u001b[0m';

const args = process.argv.slice(2);
const OUT = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.resolve(process.cwd(), 'screenshots', 'insel');
})();

const { B, antwort, medienIn } = gs;
/** Eine Antwort, die man schreiben sieht (der Statist wartet zwischen den Stuecken). */
const langsam = (ms, ...teile) => ({ ...antwort(...teile), pauseMs: ms });

/* ------------------------------------------------------------- Pruefen */

const ergebnisse = [];
function check(ok, satz, detail = '') {
  ergebnisse.push({ ok: !!ok, satz, detail });
  console.log(`  ${ok ? `${G}✓${X}` : `${R}✗${X}`} ${satz}${detail ? `  ${D}${String(detail).slice(0, 150)}${X}` : ''}`);
  return !!ok;
}
function abschnitt(titel) {
  console.log(`\n${BO}${titel}${X}`);
}

const bilder = [];
let nr = 0;
async function foto(page, name, opts = {}) {
  const datei = path.join(OUT, `${String(++nr).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: datei, ...opts });
  bilder.push(datei);
  return datei;
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

async function dismissWelcome(page) {
  try {
    const btn = page.getByRole('button', { name: /Los geht/ });
    if (await btn.count()) {
      await btn.first().click({ timeout: 3000 });
      await page.waitForTimeout(300);
    }
  } catch { /* schon weg, oder nie da gewesen */ }
}

const wandzeit = (t) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
};

/**
 * Die Bilder der LETZTEN Nutzernachricht einer Anfrage. medienIn zaehlt
 * alles -- und mit jeder Frage gehen die letzten Anhaenge des Gespraechs
 * wieder mit (src/models/anhaenge.js), damit die KI sich darauf beziehen kann.
 */
function medienLetzte(anfrageBody) {
  const inhalte = (anfrageBody && anfrageBody.contents) || [];
  for (let i = inhalte.length - 1; i >= 0; i -= 1) {
    if (inhalte[i].role === 'user' && inhalte[i].parts.some((x) => x.text || x.inlineData)) {
      return medienIn({ contents: [inhalte[i]] });
    }
  }
  return [];
}

/** Der Text der letzten Nutzernachricht einer Anfrage an Gemini. */
function nutzerText(anfrageBody) {
  const inhalte = (anfrageBody && anfrageBody.contents) || [];
  for (let i = inhalte.length - 1; i >= 0; i -= 1) {
    if (inhalte[i].role === 'user') return inhalte[i].parts.map((p) => p.text || '').join('\n');
  }
  return '';
}

/* ------------------------------------------------------------- Ablauf */

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`\n${BO}Neural OS · Die Insel im echten Browser${X}`);
  console.log(`${D}Echte Anwendung, echter Tresor, Chromium -- an Googles Stelle ein Statist auf 127.0.0.1.${X}`);

  const pw = findPlaywright();
  if (!pw) {
    console.log(`\n${Y}Playwright ist nicht installiert -- nichts geprueft.${X}`);
    process.exit(2);
  }
  const gemini = await gs.starten();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-os-inselbeweis-'));
  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, geminiBasis: gemini.url });
  await seedIfEmpty(app);
  const server = await app.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const store = app.store;
  const verbunden = await anfrage(base, 'POST', '/api/ki/gemini/schluessel', { schluessel: gemini.schluessel });
  if (verbunden.status !== 200) throw new Error(`Gemini liess sich nicht verbinden: HTTP ${verbunden.status}`);

  const { chromium } = await import(pw);
  const exe = findChromium();
  const browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : {}),
    // Ohne Bildschirm gibt es keine Auswahl; Chromium nimmt dann den eigenen Tab (siehe oben).
    args: ['--auto-accept-this-tab-capture'],
  });
  const konsole = [];

  async function neueSeite({ breite = 1440, hoehe = 900, finger = false, sprache = false } = {}) {
    const c = await browser.newContext({
      viewport: { width: breite, height: hoehe },
      hasTouch: finger,
      deviceScaleFactor: finger ? 2 : 1,
      colorScheme: 'dark',
      permissions: ['clipboard-read', 'clipboard-write', 'notifications'],
      serviceWorkers: 'block',
    });
    await c.addInitScript(([k]) => { try { localStorage.setItem(k, 'dark'); } catch { /* egal */ } }, [`neural-os:${app.ki.id}:design`]);
    await c.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (md && typeof md.getDisplayMedia === 'function') {
        const echt = md.getDisplayMedia.bind(md);
        window.__geteilt = 0;
        md.getDisplayMedia = (o = {}) => {
          window.__geteilt += 1;
          return echt({ ...o, preferCurrentTab: true, selfBrowserSurface: 'include' });
        };
      }
      const Echt = window.Notification;
      window.__mitteilungen = [];
      if (typeof Echt === 'function') {
        const Probe = function Probe(titel, opts) {
          window.__mitteilungen.push({ titel, body: opts && opts.body });
          try { return new Echt(titel, opts); } catch { return {}; }
        };
        Object.defineProperty(Probe, 'permission', { get: () => Echt.permission });
        Probe.requestPermission = (...a) => Echt.requestPermission(...a);
        window.Notification = Probe;
      }
    });
    if (sprache) {
      // Chromium ohne Bildschirm hat keine Spracherkennung und keine Stimmen:
      // beides nachgebaut -- die Erkennung liefert erst einen Teil, dann den
      // ganzen Satz; die Stimme merkt sich, was sie sagen soll.
      await c.addInitScript(() => {
        window.__erkennung = { gestartet: 0, gestoppt: 0 };
        class FalscheErkennung {
          start() {
            window.__erkennung.gestartet += 1;
            const ergebnis = (t, fertig) => ({ results: [Object.assign([{ transcript: t, confidence: 0.9 }], { isFinal: fertig })] });
            this.uhren = [
              setTimeout(() => { if (this.onresult) this.onresult(ergebnis('Wie wird', false)); }, 200),
              setTimeout(() => { if (this.onresult) this.onresult(ergebnis('Wie wird das Wetter morgen?', true)); }, 700),
            ];
          }
          stop() {
            window.__erkennung.gestoppt += 1;
            setTimeout(() => { if (this.onend) this.onend(); }, 40);
          }
          abort() {
            for (const u of this.uhren || []) clearTimeout(u);
            setTimeout(() => { if (this.onend) this.onend(); }, 10);
          }
        }
        window.webkitSpeechRecognition = FalscheErkennung;
        window.SpeechRecognition = undefined;
        window.__gesprochen = [];
        class Aeusserung {
          constructor(t) { this.text = t; this.rate = 1; }
        }
        const synth = {
          speaking: false,
          pending: false,
          speak(u) { window.__gesprochen.push(u.text); setTimeout(() => { if (u.onend) u.onend(); }, 30); },
          cancel() {},
          pause() {},
          resume() {},
          getVoices: () => [],
          addEventListener() {},
          removeEventListener() {},
        };
        Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
        window.SpeechSynthesisUtterance = Aeusserung;
      });
    }
    const p = await c.newPage();
    p.on('pageerror', (e) => konsole.push(`pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') konsole.push(m.text()); });
    return { c, p };
  }

  const pille = (p) => p.locator('.topbar .insel__pille:not(.is-schwebt), body.insel-fenster .insel__pille').first();
  async function aufmachen(p) {
    const offen = await p.locator('#insel-panel:not([hidden])').count();
    if (!offen) await pille(p).click();
    await p.locator('#insel-panel:not([hidden])').waitFor({ timeout: 4000 });
  }
  async function fragen(p, satz) {
    await p.locator('.insel-feld').fill(satz);
    await p.locator('.insel-feld').press('Enter');
  }
  async function letzteAntwort(p) {
    return (await p.locator('.insel-antwort').last().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  }
  const stromAnfragen = () => gemini.stromAnfragen();

  let fehlgeschlagen = false;
  let appZu = false;
  try {
    const { c, p } = await neueSeite();
    await p.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    await p.locator('.cv-leer__titel').waitFor({ timeout: 8000 }).catch(() => {});
    await dismissWelcome(p);
    await p.waitForTimeout(500);

    /* ------------------------------------------------ A. Die Pille */
    abschnitt('A · Die Pille oben in der Mitte');
    const lage = await p.evaluate(() => {
      const q = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
      const pl = q('.topbar .insel__pille:not(.is-schwebt)');
      const titel = q('.topbar__title');
      const rechts = q('.topbar__right');
      const kopf = q('.topbar');
      const mitte = pl ? pl.left + pl.width / 2 : 0;
      return {
        da: !!pl,
        hoehe: pl ? Math.round(pl.height) : 0,
        zwischen: !!(pl && titel && rechts && pl.left > titel.right && pl.right < rechts.left),
        abweichung: pl && kopf ? Math.round(Math.abs(mitte - (kopf.left + kopf.width / 2))) : 999,
        label: (document.querySelector('.topbar .insel__pille:not(.is-schwebt)') || { getAttribute: () => '' }).getAttribute('aria-label'),
      };
    });
    check(lage.da && lage.zwischen, 'Die Insel steht im Kopf zwischen Titel und Knöpfen', `Höhe ${lage.hoehe} px, ${lage.abweichung} px neben der Mitte`);
    check(lage.abweichung <= 60, 'und ungefähr in der Mitte (wie am iPhone)', `${lage.abweichung} px`);
    check(/^Insel: Frag mich/.test(lage.label), 'Sie sagt, was sie ist: „Insel: Frag mich … Öffnen“', lage.label);
    await foto(p, 'pille-ruhe', { clip: { x: 248, y: 0, width: 820, height: 90 } });

    await pille(p).click();
    await p.locator('#insel-panel:not([hidden])').waitFor({ timeout: 4000 });
    const aufZustand = await p.evaluate(() => ({
      expanded: document.querySelector('.topbar .insel__pille').getAttribute('aria-expanded'),
      rolle: document.getElementById('insel-panel').getAttribute('role'),
      fokus: document.activeElement && document.activeElement.classList.contains('insel-feld'),
      wege: [...document.querySelectorAll('.insel-weg')].map((b) => b.textContent.trim().slice(0, 30)),
    }));
    check(aufZustand.expanded === 'true' && aufZustand.rolle === 'dialog' && aufZustand.fokus,
      'Antippen klappt sie auf (ein Dialog), und man kann sofort tippen', JSON.stringify({ e: aufZustand.expanded, f: aufZustand.fokus }));
    check(aufZustand.wege.length >= 4, 'Leer sagt sie, was geht – jeder Weg ist ein echter Knopf', aufZustand.wege.join(' · '));
    await foto(p, 'insel-offen');
    const namenlos = await p.evaluate(() => [...document.querySelectorAll('#insel-panel button')]
      .filter((b) => b.offsetWidth && !(b.getAttribute('aria-label') || b.textContent.trim())).length);
    check(namenlos === 0, 'Jeder Knopf in der Insel hat einen Namen (für Vorlesehilfen)', `${namenlos} ohne Namen`);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(350);
    const zu = await p.evaluate(() => ({
      versteckt: document.getElementById('insel-panel').hidden,
      fokus: document.activeElement && document.activeElement.classList.contains('insel__pille'),
    }));
    check(zu.versteckt && zu.fokus, 'Esc schließt sie, der Fokus geht zurück auf die Pille');
    await p.keyboard.press('Control+Shift+Space');
    await p.waitForTimeout(350);
    const perTaste = await p.locator('#insel-panel:not([hidden])').count();
    await p.mouse.click(700, 700);
    await p.waitForTimeout(350);
    const draussen = await p.locator('#insel-panel[hidden]').count();
    check(perTaste === 1 && draussen === 1, 'Strg+Umschalt+Leertaste öffnet sie; ein Klick daneben schließt sie');

    /* ------------------------------------------------ B. Fragen */
    abschnitt('B · Fragen, zusehen, stoppen');
    await aufmachen(p);
    gemini.weiter(langsam(25, B.text('Vier. Zwei plus zwei ergibt vier – das ist die kleinste Rechnung, die jeder kennt.'), B.ende()));
    const vorB = stromAnfragen().length;
    await fragen(p, 'Was ist zwei plus zwei?');
    const welle = await warteBis(() => p.locator('.insel-zustand .insel__welle, .insel-panel__titel .insel__welle').count(), { timeout: 3000 });
    check(welle > 0, 'Während sie schreibt, läuft die Welle');
    await warteBis(async () => /kleinste Rechnung/.test(await letzteAntwort(p)), { timeout: 10000 });
    check(/^Vier\./.test(await letzteAntwort(p)), 'Die Antwort steht in der Insel', await letzteAntwort(p));
    const anB = stromAnfragen().slice(vorB)[0];
    const systemText = JSON.stringify((anB && anB.body && anB.body.systemInstruction) || {});
    check(/über die Insel/.test(systemText) && /kurz/.test(systemText), 'An Gemini ging die Anweisung der Insel mit (kurz antworten, Bilder sind Bildschirmfotos)');
    const inselChats = store.list('chat', { limit: 50 }).items.filter((r) => /^Insel · /.test(r.data.title || ''));
    check(inselChats.length === 1 && /über die Insel/.test(inselChats[0].data.systemPrompt || ''), 'Im Tresor steht ein echter Chat „Insel · …“ mit dieser Anweisung', inselChats.map((r) => r.data.title).join(', '));
    const zuletzt = await warteBis(async () => (await p.locator('.rail').innerText()).includes('Insel · '), { timeout: 5000 });
    check(!!zuletzt, 'Er steht sofort links unter „Zuletzt“');
    await foto(p, 'antwort');

    // Stoppen mitten im Strom
    gemini.weiter(langsam(120, B.text('Hier kommt eine lange Antwort. '), ...Array.from({ length: 40 }, (_, i) => B.text(`Satz Nummer ${i + 1} von vierzig. `)), B.ende()));
    const abbruecheVorher = gemini.abbrueche();
    await fragen(p, 'Erzähl mir etwas Langes.');
    await warteBis(async () => (await letzteAntwort(p)).length > 20, { timeout: 6000 });
    await p.locator('.insel-eingabe button[aria-label="Stopp"]').click();
    const gestoppt = await warteBis(async () => /Abgebrochen/.test(await p.locator('.insel-eintrag').last().innerText()), { timeout: 8000 });
    check(!!gestoppt && gemini.abbrueche() > abbruecheVorher, '[Stopp] bricht die Antwort wirklich ab – auch beim Anbieter', `Abbrüche beim Statisten: ${gemini.abbrueche() - abbruecheVorher}`);

    // Fertig, waehrend sie zu ist: die Pille sagt es
    gemini.weiter(langsam(60, B.text('Erledigt: die Antwort kam, während die Insel zu war.'), B.ende()));
    await fragen(p, 'Antworte, wenn ich weg bin.');
    await p.keyboard.press('Escape');
    const neu = await warteBis(async () => (await pille(p).getAttribute('data-art')) === 'neu', { timeout: 8000 });
    const neuText = await pille(p).innerText();
    check(!!neu && /Erledigt/.test(neuText), 'Kommt die Antwort, während die Insel zu ist, zeigt die Pille sie grün an', neuText.replace(/\s+/g, ' '));
    await foto(p, 'pille-neu', { clip: { x: 248, y: 0, width: 820, height: 90 } });
    await pille(p).click();
    await p.waitForTimeout(300);
    check((await pille(p).getAttribute('data-art')) !== 'neu', 'Aufmachen heißt gesehen');

    /* ------------------------------------------------ C. Bildschirm */
    abschnitt('C · Bildschirm zeigen: die KI sieht mit');
    await aufmachen(p);
    await p.locator('.insel-eingabe button[aria-label^="Bildschirm zeigen"]').click();
    const teilt = await warteBis(() => p.locator('.insel-teilen:not([hidden])').count(), { timeout: 6000 });
    const teilText = teilt ? (await p.locator('.insel-teilen').innerText()).replace(/\s+/g, ' ') : '';
    check(!!teilt && /Ich sehe/.test(teilText) && /Gemini/.test(teilText), 'Es wird geteilt – und die Insel sagt ehrlich, wohin das Bild geht', teilText);
    gemini.weiter(antwort(B.text('Ich sehe Neural OS mit einem Chat und der Insel oben.'), B.ende()));
    const vorC = stromAnfragen().length;
    await fragen(p, 'Was siehst du?');
    await warteBis(async () => /Ich sehe Neural OS/.test(await letzteAntwort(p)), { timeout: 12000 });
    const anC = stromAnfragen().slice(vorC)[0];
    const medien = medienLetzte(anC && anC.body);
    check(medien.length === 1 && medien[0].mime === 'image/jpeg' && medien[0].bytes > 5000 && medien[0].bytes <= 5 * 1024 * 1024,
      'An Gemini ging mit der Frage ein echtes Bild vom Bildschirm (JPEG, unter 5 MB)', JSON.stringify(medien));
    const teilData = anC ? anC.body.contents.flatMap((x) => x.parts).find((x) => x.inlineData) : null;
    const masse = teilData ? await p.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      const g = cv.getContext('2d');
      g.drawImage(bmp, 0, 0);
      // Die Leiste links ist dunkel, die Karte in der Mitte auch -- aber nicht alles ist eine Farbe.
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const farben = new Set();
      for (let i = 0; i < d.length; i += 4 * 997) farben.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
      return { b: bmp.width, h: bmp.height, farben: farben.size };
    }, teilData.inlineData.data) : null;
    check(!!masse && masse.b === 1440 && masse.h >= 600 && masse.h <= 1600 && masse.farben > 3,
      'Das Bild ist ein echtes Bild dieses Tabs (so breit wie das Fenster, viele Farben, höchstens 1600 px)', JSON.stringify(masse));
    const abgelegt = store.list('file', { limit: 50 }).items.filter((f) => /^Bildschirm \d\d-\d\d-\d\d\.jpg$/.test(f.data.name || ''));
    check(abgelegt.length === 1, 'Im Insel-Chat liegt das Bild als Anhang – zu sehen und zu löschen wie jeder Anhang', abgelegt.map((f) => f.data.name).join(', '));
    check(await p.locator('.insel-eintrag').last().locator('.insel-frage__bilder img').count() === 1, 'Über der Antwort steht das Bild, das die KI bekommen hat');
    check((await pille(p).getAttribute('aria-label')).includes('Ich schaue mit') || (await p.locator('.insel-panel__titel').innerText()).length > 0, 'Solange geteilt wird, sagt die Insel „Ich schaue mit“');
    await foto(p, 'bildschirm-geteilt');
    // Bild abschalten: die naechste Frage geht ohne
    await p.locator('.insel-anhaenge button', { hasText: 'Bildschirm geht mit' }).click();
    gemini.weiter(antwort(B.text('Ohne Bild: gern.'), B.ende()));
    const vorC2 = stromAnfragen().length;
    await fragen(p, 'Und ohne Bild?');
    await warteBis(async () => /Ohne Bild: gern/.test(await letzteAntwort(p)), { timeout: 8000 });
    check(medienLetzte(stromAnfragen().slice(vorC2)[0].body).length === 0, '„Bildschirm geht mit“ antippen: die nächste Frage geht ohne Bild');
    await p.locator('.insel-anhaenge button', { hasText: 'Ohne Bild' }).click();
    await p.locator('.insel-teilen button', { hasText: 'Stopp' }).click();
    await p.waitForTimeout(300);
    const nachStopp = await p.evaluate(() => ({ zeile: !document.querySelector('.insel-teilen:not([hidden])'), video: !document.querySelector('.insel-teilen video').srcObject }));
    check(nachStopp.zeile && nachStopp.video, '[Stopp] beendet das Teilen – die Aufnahme ist wirklich zu');

    /* ------------------------------------------------ D. Kleine Befehle */
    abschnitt('D · Timer und Notiz – ohne die KI zu fragen');
    const vorD = stromAnfragen().length;
    await fragen(p, 'Timer 3 min Tee');
    await p.waitForTimeout(1300);
    const chip = (await p.locator('.insel-live').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Tee/.test(chip) && /2:5\d|3:00/.test(chip), '„Timer 3 min Tee“ läuft sofort, mit Countdown', chip);
    await fragen(p, 'Notiz: Milch und Brot kaufen');
    const notiz = await warteBis(() => store.list('note', { limit: 100 }).items.find((n) => n.data.title === 'Milch und Brot kaufen'), { timeout: 5000 });
    check(!!notiz, '„Notiz: …“ legt die Notiz wirklich an', notiz ? notiz.id : 'keine');
    check(stromAnfragen().length === vorD, 'Beides ohne eine einzige Anfrage an die KI');
    await fragen(p, 'Timer');
    await p.waitForTimeout(300);
    const wahl = await p.locator('.insel-timerwahl:not([hidden]) button').allInnerTexts();
    check(wahl.join(',') === '1 Min,3 Min,5 Min,10 Min,15 Min,25 Min', '„Timer“ allein zeigt die Auswahl (1, 3, 5, 10, 15, 25 Min)', wahl.join(', '));
    // Ein kurzer Timer klingelt
    await fragen(p, 'Timer 2 sek Nudeln');
    await p.keyboard.press('Escape');
    const klingelt = await warteBis(() => p.locator('.insel__wecker', { hasText: 'Nudeln ist fertig' }).count(), { timeout: 6000 });
    const puls = await pille(p).getAttribute('data-klingelt');
    const doppelt = /Nudeln ist fertig/.test(await pille(p).innerText());
    check(!!klingelt && puls === 'ja' && !doppelt, 'Ist er um, klingelt er: die Insel pulsiert, daneben „Nudeln ist fertig“ mit [Aus] (nur einmal)', `Puls: ${puls}`);
    const mitteilungen = await p.evaluate(() => window.__mitteilungen);
    check(mitteilungen.some((m) => m.titel === 'Nudeln ist fertig'), 'und das Betriebssystem bekommt eine Mitteilung (für ein anderes Programm im Vordergrund)', JSON.stringify(mitteilungen));
    await foto(p, 'timer-klingelt', { clip: { x: 248, y: 0, width: 820, height: 90 } });
    await p.locator('.insel__wecker button', { hasText: 'Aus' }).click();
    await p.waitForTimeout(300);
    check(await p.locator('.insel__wecker').count() === 0, '[Aus] stellt ihn ab');
    const timerPille = (await pille(p).innerText()).replace(/\s+/g, ' ');
    check(/Tee · [0-3]:\d\d/.test(timerPille), 'Der andere Timer läuft weiter und steht jetzt in der Pille', timerPille);

    /* ------------------------------------------------ E. Zwischenablage */
    abschnitt('E · Aus einem anderen Programm: kopieren, fragen');
    await p.evaluate(() => navigator.clipboard.writeText('The quick brown fox jumps over the lazy dog.'));
    await aufmachen(p);
    gemini.weiter(antwort(B.text('Der schnelle braune Fuchs springt über den faulen Hund.'), B.ende()));
    const vorE = stromAnfragen().length;
    await p.locator('.insel-vorlagen button', { hasText: 'Übersetz ins Deutsche' }).click();
    await warteBis(async () => /Fuchs/.test(await letzteAntwort(p)), { timeout: 8000 });
    const textE = nutzerText(stromAnfragen().slice(vorE)[0].body);
    check(/Übersetz das ins Deutsche/.test(textE) && /Aus der Zwischenablage/.test(textE) && /quick brown fox/.test(textE),
      'Kopierter Text geht mit „Übersetz ins Deutsche“ an die KI – eingezäunt, als Zitat', textE.replace(/\s+/g, ' ').slice(0, 120));
    // Ein Bild einfuegen (Strg+V)
    await p.evaluate(async () => {
      const cv = document.createElement('canvas');
      cv.width = 120;
      cv.height = 80;
      const g = cv.getContext('2d');
      g.fillStyle = '#ff00ff';
      g.fillRect(0, 0, 120, 80);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'kopiert.png', { type: 'image/png' }));
      const feld = document.querySelector('.insel-feld');
      feld.focus();
      feld.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await p.waitForTimeout(300);
    check(await p.locator('.insel-anhaenge', { hasText: 'kopiert.png' }).count() === 1, 'Ein eingefügtes Bild (Strg+V) hängt an der nächsten Frage');
    gemini.weiter(antwort(B.text('Ein pinkes Rechteck.'), B.ende()));
    const vorE2 = stromAnfragen().length;
    await fragen(p, 'Was ist das?');
    await warteBis(async () => /pinkes Rechteck/.test(await letzteAntwort(p)), { timeout: 8000 });
    const medienE = medienLetzte(stromAnfragen().slice(vorE2)[0].body);
    check(medienE.length === 1 && medienE[0].mime === 'image/png', 'und geht als Bild an die KI', JSON.stringify(medienE));

    /* ------------------------------------------------ F. Werkzeuge */
    abschnitt('F · Die KI fragt zurück und trägt ein');
    gemini.weiter(antwort(
      B.text('Gern.'),
      B.aufruf('rueckfrage', { frage: 'Um wie viel Uhr?', optionen: ['10:00', '15:00'], mehrfach: false }, { signatur: 'sig_insel_frage' }),
      B.ende(),
    ));
    await fragen(p, 'Trag mir morgen den Zahnarzt ein.');
    const frageDa = await warteBis(() => p.locator('.insel-rueck', { hasText: 'Um wie viel Uhr?' }).count(), { timeout: 8000 });
    check(!!frageDa && (await pille(p).getAttribute('aria-label') || '').length > 0, 'Eine Rückfrage steht in der Insel, mit Antworten zum Antippen');
    const morgen = new Date();
    morgen.setDate(morgen.getDate() + 1);
    const tag = wandzeit(morgen).slice(0, 10);
    gemini.weiter(
      antwort(B.aufruf('termin_anlegen', { titel: 'Zahnarzt', start: `${tag}T15:00`, ganztaegig: false, ort: 'Praxis' }, { signatur: 'sig_insel_termin' }), B.ende()),
      antwort(B.text('Eingetragen: morgen, 15:00 Uhr.'), B.ende()),
    );
    await p.locator('.insel-rueck button', { hasText: '15:00' }).click();
    await warteBis(async () => /Eingetragen/.test(await letzteAntwort(p)), { timeout: 10000 });
    const termin = store.list('event', { limit: 50 }).items.find((e) => e.data.title === 'Zahnarzt');
    check(!!termin && termin.data.start === `${tag}T15:00`, 'Die Antwort auf die Rückfrage geht zurück, und der Termin steht wirklich im Kalender', termin ? termin.data.start : 'kein Termin');
    const wirkung = (await p.locator('.insel-eintrag').last().locator('.insel-wirkung').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Termin eingetragen/.test(wirkung) && /Zahnarzt/.test(wirkung), 'Unter der Antwort steht, was die KI angelegt hat – zum Antippen', wirkung);
    await foto(p, 'termin-eingetragen');
    await p.locator('.insel-eintrag').last().locator('.insel-wirkung button').first().click();
    await p.waitForTimeout(600);
    check(p.url().includes(`#/kalender?id=${termin ? termin.id : 'x'}`), 'Antippen öffnet ihn im Kalender (und die Insel geht zu)', p.url().replace(base, ''));
    // Als Notiz
    await aufmachen(p);
    await p.locator('.insel-eintrag').last().locator('.insel-aktion', { hasText: 'Als Notiz' }).click();
    const alsNotiz = await warteBis(() => store.list('note', { limit: 100 }).items.find((n) => /Eingetragen: morgen/.test(n.data.body || '')), { timeout: 5000 });
    check(!!alsNotiz, '[Als Notiz] legt die Antwort als Notiz ab', alsNotiz ? alsNotiz.data.title : 'keine');

    /* ------------------------------------------------ G. Ueber allen Fenstern */
    abschnitt('G · Über allen Fenstern (Bild-im-Bild)');
    await aufmachen(p);
    const knopf = p.locator('#insel-panel button[aria-label^="Über allen Fenstern"]');
    check(await knopf.count() === 1, 'Der Knopf „Über allen Fenstern“ ist da (Chromium kann es)');
    const seitenVorher = c.pages().length;
    await knopf.click();
    const pip = await warteBis(() => c.pages().find((x) => x !== p), { timeout: 5000 });
    check(!!pip && c.pages().length === seitenVorher + 1, 'Ein eigenes, schwebendes Fenster geht auf');
    if (pip) {
      await pip.locator('.insel-feld').waitFor({ timeout: 4000 });
      const imFenster = await pip.evaluate(() => ({
        koerper: document.body.classList.contains('insel-fenster'),
        pille: !!document.querySelector('.insel__pille'),
        feld: !!document.querySelector('.insel-feld'),
        verlauf: document.querySelectorAll('.insel-eintrag').length,
        stil: getComputedStyle(document.querySelector('.insel-panel')).backgroundColor,
      }));
      check(imFenster.koerper && imFenster.pille && imFenster.feld && imFenster.verlauf > 0, 'Darin: die ganze Insel, mit dem bisherigen Gespräch', JSON.stringify(imFenster));
      const daheim = (await p.locator('.topbar .insel-dock').innerText()).replace(/\s+/g, ' ');
      check(/Insel schwebt/.test(daheim), 'In Neural OS steht solange „Insel schwebt · zurückholen“', daheim);
      gemini.weiter(antwort(B.text('Aus dem schwebenden Fenster beantwortet.'), B.ende()));
      await pip.locator('.insel-feld').fill('Hörst du mich im Fenster?');
      await pip.locator('.insel-feld').press('Enter');
      const pipAntwort = await warteBis(async () => /schwebenden Fenster/.test(await pip.locator('.insel-antwort').last().innerText().catch(() => '')), { timeout: 8000 });
      check(!!pipAntwort, 'Fragen geht im schwebenden Fenster genauso');
      await pip.setViewportSize({ width: 440, height: 620 }).catch(() => {});
      await pip.waitForTimeout(300);
      await foto(pip, 'schwebendes-fenster');
      const satzImFenster = await pip.evaluate(() => {
        const t = document.querySelector('.insel__pille .insel__text');
        return t && getComputedStyle(t).display !== 'none' ? t.textContent : '';
      });
      check(satzImFenster.length > 0, 'Auch schmal (440 px) steht im Fenster der ganze Satz – es ist kein Telefon', satzImFenster);
      await pip.locator('button[aria-label="Kleiner"]').click();
      await pip.waitForTimeout(250);
      const klein = await pip.evaluate(() => ({ klein: document.body.classList.contains('is-klein'), panel: getComputedStyle(document.querySelector('.insel-panel')).display }));
      check(klein.klein && klein.panel === 'none', '[Kleiner]: nur noch die Zeile mit dem, was gerade lebt');
      await pip.locator('.insel__pille').first().click();
      await pip.waitForTimeout(250);
      check(!(await pip.evaluate(() => document.body.classList.contains('is-klein'))), 'Die Pille antippen: wieder groß');
      await pip.locator('.insel-eintrag').last().locator('.insel-aktion', { hasText: 'Im Chat öffnen' }).click();
      await p.waitForTimeout(500);
      const chatId = (store.list('chat', { limit: 50 }).items.find((r) => /^Insel · /.test(r.data.title || '')) || {}).id;
      check(!!chatId && p.url().endsWith(`#/chat?id=${chatId}`), '„Im Chat öffnen“ öffnet den Insel-Chat in Neural OS', p.url().replace(base, ''));
      await pip.close();
      const zurueck = await warteBis(() => p.locator('.topbar .insel__pille:not(.is-schwebt):visible').count(), { timeout: 4000 });
      check(!!zurueck && await p.locator('.topbar .insel__pille.is-schwebt:visible').count() === 0, 'Fenster zu: die Insel ist zurück im Kopf');
      await aufmachen(p);
      check(await p.locator('.insel-eintrag').count() >= 3, 'und das Gespräch ist noch da');
      await p.keyboard.press('Escape');
    }

    /* ------------------------------------------------ H. Erinnerung */
    abschnitt('H · Termine: Erinnerung als Kapsel, „In 20 Min“ in der Pille');
    await p.goto(`${base}/#/kalender`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    const bald = new Date(Date.now() + 10 * 60000);
    store.create('event', { title: 'Inselprobe', start: wandzeit(bald), end: wandzeit(new Date(bald.getTime() + 30 * 60000)), location: 'Flur', reminder: 15 });
    await store.flush();
    const kapsel = await warteBis(() => p.locator('.insel__kapseln .erin__card', { hasText: 'Inselprobe' }).count(), { timeout: 6000 });
    const kapselText = kapsel ? (await p.locator('.insel__kapseln .erin__card').first().innerText()).replace(/\s+/g, ' ') : '';
    check(!!kapsel && /In (9|10) Min/.test(kapselText), 'Eine Erinnerung hängt sich als Kapsel an die Insel', kapselText);
    const verdeckt = await p.evaluate(() => {
      const k = document.querySelector('.insel__kapseln .erin__card');
      return [...document.querySelectorAll('button, a, input, [role="button"]')]
        .filter((el) => !k.contains(el) && el.getBoundingClientRect().width > 0)
        .filter((el) => {
          const q = el.getBoundingClientRect();
          const hit = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2);
          return hit && k.contains(hit);
        }).length;
    });
    check(verdeckt === 0, 'und verdeckt dabei keinen Knopf');
    check(!/Inselprobe/.test(await pille(p).innerText()), 'Derselbe Termin steht nicht noch einmal in der Pille');
    await foto(p, 'erinnerung-kapsel', { clip: { x: 248, y: 0, width: 820, height: 90 } });
    await p.locator('.insel__kapseln button[aria-label="Erinnerung schließen"]').click();
    await p.waitForTimeout(300);
    check(await p.locator('.insel__kapseln .erin__card').count() === 0, '× schließt die Kapsel');
    await p.waitForTimeout(1200);
    check(!/Inselprobe|10 Min|9 Min/.test((await p.locator('.topbar .insel-dock').innerText()).replace(/\s+/g, ' ')),
      'Weggeklickt heißt erledigt: der Termin kommt nicht als Live-Anzeige zurück');
    const inZwanzig = new Date(Date.now() + 20 * 60000);
    store.create('event', { title: 'Rückruf Bank', start: wandzeit(inZwanzig), end: wandzeit(new Date(inZwanzig.getTime() + 15 * 60000)) });
    await store.flush();
    const terminPille = await warteBis(async () => {
      const t = (await p.locator('.topbar .insel-dock').innerText()).replace(/\s+/g, ' ');
      return /Rückruf Bank|20 Min|19 Min/.test(t) ? t : null;
    }, { timeout: 6000 });
    check(!!terminPille, 'Ein Termin in 20 Minuten (ohne Erinnerung) steht als Live-Aktivität in der Insel', terminPille || (await p.locator('.topbar .insel-dock').innerText()));

    /* ------------------------------------------------ I. Neu laden */
    abschnitt('I · Neu laden');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1200);
    await aufmachen(p);
    const wieder = await warteBis(() => p.locator('.insel-eintrag').count(), { timeout: 5000 });
    check(wieder >= 3, 'Nach dem Neuladen zeigt die Insel das laufende Gespräch wieder', `${wieder} Fragen`);
    const timerWieder = (await p.locator('.insel-live').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Tee/.test(timerWieder), 'und der Timer läuft weiter (nur in diesem Tab gemerkt)', timerWieder);
    const lokal = await p.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.includes('insel')).map((k) => [k.split(':').pop(), localStorage.getItem(k)])));
    check(!JSON.stringify(lokal).includes('Tee') && !JSON.stringify(lokal).includes('Zahnarzt') && /chat_/.test(lokal['insel-chat'] || ''),
      'Im Browser bleibt dauerhaft nur die Kennung des Chats – kein Inhalt', JSON.stringify(lokal).slice(0, 140));
    // [+] Neues Gespraech: die naechste Frage beginnt einen neuen Insel-Chat, der alte bleibt.
    await p.locator('#insel-panel button[aria-label="Neues Gespräch"]').click();
    await p.waitForTimeout(200);
    const leerWieder = await p.locator('.insel-leer').count();
    gemini.weiter(antwort(B.text('Neues Gespräch, neue Antwort.'), B.ende()));
    await fragen(p, 'Fangen wir neu an?');
    await warteBis(async () => /neue Antwort/.test(await letzteAntwort(p)), { timeout: 8000 });
    const zweiChats = store.list('chat', { limit: 50 }).items.filter((r) => /^Insel · /.test(r.data.title || '')).length;
    check(leerWieder === 1 && zweiChats === 2, '[+] beginnt ein neues Gespräch – das alte bleibt unter „Zuletzt“', `${zweiChats} Insel-Chats`);
    await p.keyboard.press('Escape');
    await c.close();

    /* ------------------------------------------------ J. Telefon, iPad */
    abschnitt('J · Telefon und iPad');
    for (const [name, breite, hoehe, finger] of [['Telefon', 390, 844, true], ['iPad hochkant', 820, 1180, true], ['iPad quer', 1180, 820, true]]) {
      const { c: c2, p: p2 } = await neueSeite({ breite, hoehe, finger });
      await p2.goto(`${base}/#/notes`, { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(900);
      await dismissWelcome(p2);
      const m = await p2.evaluate(() => {
        const pl = document.querySelector('.topbar .insel__pille:not(.is-schwebt)');
        const t = document.querySelector('.topbar__title');
        const r = pl ? pl.getBoundingClientRect() : null;
        return { h: r ? Math.round(r.height) : 0, titel: t ? Math.round(t.getBoundingClientRect().width) : 0, ueber: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      await pille(p2).tap();
      await p2.waitForTimeout(400);
      const panelRand = await p2.evaluate(() => {
        const r = document.getElementById('insel-panel').getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(innerWidth - r.right), unten: Math.round(innerHeight - r.bottom) };
      });
      const feldGroesse = await p2.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.insel-feld')).fontSize));
      check(m.h >= 44 && m.ueber <= 0 && m.titel >= 40 && panelRand.l >= 8 && panelRand.r >= 8 && panelRand.unten >= 0 && feldGroesse >= 16,
        `${name}: Pille ≥ 44 px, nichts ragt heraus, das Panel passt, Eingabe ≥ 16 px (kein Hineinzoomen)`,
        `Pille ${m.h} px, Titel ${m.titel} px, Rand ${panelRand.l}/${panelRand.r}, Schrift ${feldGroesse} px`);
      if (name === 'Telefon') await foto(p2, 'telefon');
      await c2.close();
    }

    /* ------------------------------------------------ M. Der Kopf */
    abschnitt('M · Der Kopf: nichts überlappt, der Titel bleibt lesbar');
    for (const [breite, spalteAuf] of [[1024, true], [1024, false], [1280, true], [1440, true]]) {
      const { c: c5, p: p5 } = await neueSeite({ breite, hoehe: 800 });
      await p5.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p5.waitForTimeout(800);
      await dismissWelcome(p5);
      const offen = await p5.evaluate(() => document.querySelector('.shell').dataset.rechts === 'offen');
      if (offen !== spalteAuf) {
        await p5.locator('.topbar__toggle').click();
        await p5.waitForTimeout(450);
      }
      const probleme = [];
      for (const view of ['chat', 'kalender', 'notes', 'projects', 'graph', 'settings']) {
        await p5.goto(`${base}/#/${view}`, { waitUntil: 'domcontentloaded' });
        await p5.waitForTimeout(view === 'graph' ? 1300 : 600);
        const m = await p5.evaluate(() => {
          const kinder = [...document.querySelector('.topbar').children]
            .filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none');
          const r = kinder.map((el) => ({ n: (el.className || el.tagName).toString().split(' ')[0], l: el.getBoundingClientRect().left, r: el.getBoundingClientRect().right }));
          const ueber = [];
          for (let i = 1; i < r.length; i += 1) if (r[i].l < r[i - 1].r - 1) ueber.push(`${r[i - 1].n}/${r[i].n} ${Math.round(r[i - 1].r - r[i].l)} px`);
          // Auch der INHALT eines Teils darf nicht ueber dessen Rand rutschen (ein Umschalter unter "Suchen").
          for (const el of kinder) {
            if (el.classList.contains('topbar__title')) continue;
            if (el.classList.contains('insel-dock')) {
              // Die Insel: Pille (und Kapseln daneben) muessen in ihr Feld passen; eine
              // heruntergefallene Kapsel haengt absichtlich UNTER dem Kopf.
              const feld = el.getBoundingClientRect();
              const teile = [el.querySelector('.insel__pille:not([hidden])')];
              if (el.dataset.kapseln !== 'unten') teile.push(el.querySelector('.insel__kapseln'));
              for (const t of teile) {
                if (!t || !t.getBoundingClientRect().width) continue;
                const q = t.getBoundingClientRect();
                if (q.left < feld.left - 1 || q.right > feld.right + 1) ueber.push(`Insel: ${Math.round(Math.max(feld.left - q.left, q.right - feld.right))} px über ihrem Platz`);
              }
              const k = el.querySelector('.insel__kapseln');
              if (el.dataset.kapseln === 'unten' && k && k.children.length) {
                const q = k.getBoundingClientRect();
                const kopfUnten = document.querySelector('.topbar').getBoundingClientRect().bottom;
                if (q.top < kopfUnten - 1 || q.left < 0 || q.right > innerWidth) ueber.push('heruntergefallene Kapsel liegt im Kopf oder ragt aus dem Fenster');
              }
              continue;
            }
            if (el.scrollWidth > el.clientWidth + 1) ueber.push(`${(el.className || el.tagName).toString().split(' ')[0]}: Inhalt ${el.scrollWidth - el.clientWidth} px zu breit`);
          }
          const kopf = document.querySelector('.topbar').getBoundingClientRect();
          const letzte = r[r.length - 1];
          if (letzte && letzte.r > kopf.right + 1) ueber.push(`${letzte.n} ragt ${Math.round(letzte.r - kopf.right)} px hinaus`);
          const t = document.querySelector('.topbar__title');
          const pl = document.querySelector('.topbar .insel__pille:not(.is-schwebt)');
          return { ueber, titel: t ? Math.round(t.getBoundingClientRect().width) : 0, pille: pl ? Math.round(pl.getBoundingClientRect().width) : 0 };
        });
        if (m.ueber.length) probleme.push(`${view}: ${m.ueber.join(', ')}`);
        if (m.pille < 34) probleme.push(`${view}: Insel nur ${m.pille} px`);
        if (m.titel < 20) probleme.push(`${view}: Titel nur ${m.titel} px`);
      }
      check(!probleme.length, `${breite} px${spalteAuf ? ' mit offener Spalte' : ''}: im Kopf überlappt nichts, Insel und Titel bleiben sichtbar`, probleme.join(' · ') || '6 Bereiche');
      if (breite === 1024 && spalteAuf) {
        await p5.goto(`${base}/#/graph`, { waitUntil: 'domcontentloaded' });
        await p5.waitForTimeout(1300);
        await foto(p5, 'kopf-1024-gehirn', { clip: { x: 248, y: 0, width: 460, height: 150 } });
      }
      await c5.close();
    }

    /* ------------------------------------------------ L. Sprechen */
    abschnitt('L · Sprechen statt tippen – die Antwort wird vorgelesen');
    {
      const { c: c4, p: p4 } = await neueSeite({ sprache: true });
      await p4.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p4.waitForTimeout(900);
      await dismissWelcome(p4);
      await aufmachen(p4);
      const mikro = p4.locator('.insel-eingabe button[aria-label="Sprechen"]');
      check(await mikro.isVisible(), 'Das Mikrofon ist da (der Browser kann erkennen)');
      await mikro.click();
      const hoert = await warteBis(async () => /Wie wird das Wetter/.test(await p4.locator('.insel-feld').inputValue()), { timeout: 4000 });
      const titel4 = (await p4.locator('.insel-panel__titel').innerText()).replace(/\s+/g, ' ');
      check(!!hoert && /Wetter|höre/.test(titel4), 'Während man spricht, steht der Text schon im Feld, und die Insel zeigt, dass sie zuhört', titel4);
      gemini.weiter(antwort(B.text('Morgen wird es sonnig. Bis zu 20 Grad.'), B.ende()));
      const vorL = stromAnfragen().length;
      await p4.locator('.insel-eingabe button[aria-label="Fertig gesprochen – senden"]').click();
      await warteBis(async () => /sonnig/.test(await letzteAntwort(p4)), { timeout: 8000 });
      check(/Wie wird das Wetter morgen\?/.test(nutzerText((stromAnfragen().slice(vorL)[0] || {}).body)), 'Mikrofon noch einmal antippen: die gesprochene Frage geht los');
      const gesagt = await warteBis(() => p4.evaluate(() => window.__gesprochen.join(' ')), { timeout: 4000 });
      check(/Morgen wird es sonnig/.test(gesagt || ''), 'Wer spricht, bekommt die Antwort vorgelesen', gesagt);
      await c4.close();
    }

    /* ------------------------------------------------ K. Neural OS ist aus */
    abschnitt('K · Neural OS ist aus: nichts schwebt mehr');
    {
      const { c: c3, p: p3 } = await neueSeite();
      await p3.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p3.waitForTimeout(900);
      await dismissWelcome(p3);
      await aufmachen(p3);
      await p3.locator('#insel-panel button[aria-label^="Über allen Fenstern"]').click();
      const pip3 = await warteBis(() => c3.pages().find((x) => x !== p3), { timeout: 5000 });
      check(!!pip3, 'Die Insel schwebt …');
      // Der Server geht weg (wie nach [Beenden] oder wenn der Stick gezogen wird).
      await app.close();
      appZu = true;
      const zu3 = await warteBis(() => c3.pages().length === 1, { timeout: 12000 });
      const aus3 = await p3.evaluate(() => ({ aus: !!document.getElementById('aus'), dock: document.querySelector('.insel-dock').hidden }));
      check(!!zu3 && aus3.aus && aus3.dock, '… bis Neural OS aus ist: dann geht das schwebende Fenster zu, und auch oben ist die Insel weg', JSON.stringify(aus3));
      await c3.close();
    }
  } catch (err) {
    fehlgeschlagen = true;
    console.log(`\n${R}Abgebrochen:${X} ${err && err.stack}`);
  }

  await browser.close();
  if (!appZu) await app.close();
  await gemini.close();
  fs.rmSync(home, { recursive: true, force: true });

  const gut = ergebnisse.filter((e) => e.ok).length;
  const schlecht = ergebnisse.length - gut;
  console.log(`\n${BO}Ergebnis${X}  ${G}${gut} funktionieren${X}${schlecht ? `  ${R}${schlecht} nicht${X}` : ''}  ${D}${bilder.length} Bilder in ${OUT}${X}`);
  // Chromium meldet beim Teilen eines Tabs "camera is not allowed" (die
  // Seite verbietet die Kamera, Permissions-Policy camera=()). Geteilt wird
  // trotzdem -- die Meldung stammt vom Browser, nicht von der App.
  const echteFehler = konsole.filter((k) => !/Failed to load resource/.test(k)
    && !/Permissions policy violation: camera is not allowed/.test(k));
  if (echteFehler.length) {
    console.log(`${Y}Konsolenfehler (${echteFehler.length}):${X}`);
    for (const k of [...new Set(echteFehler)].slice(0, 8)) console.log(`  ${Y}·${X} ${k}`);
  }
  process.exit(fehlgeschlagen || schlecht || echteFehler.length ? 1 : 0);
})().catch((err) => {
  console.error(`\n${R}Das Werkzeug selbst ist gescheitert:${X} ${err && err.stack}`);
  process.exit(2);
});
