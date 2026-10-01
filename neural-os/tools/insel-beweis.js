'use strict';

/**
 * Beweis der Insel (web/lib/insel.js, das Wesen in web/lib/insel-wesen.js)
 * -- im echten Browser, gegen die echte Anwendung, mit einem Statisten an
 * Googles Stelle.
 *
 *   node tools/insel-beweis.js                 Bilder nach ./screenshots/insel
 *   node tools/insel-beweis.js --out /pfad     woandershin
 *
 * Geprueft wird, was ein Mensch tut: das kleine Wesen am rechten Rand
 * antippen, es waechst zu einem Feld (nicht zum ganzen Bildschirm), fragen,
 * zusehen, wie es denkt und spricht, mittendrin stoppen; im Internet suchen
 * lassen (Suchzeile, Quellen), einen ruhigen Hinweis bekommen, ein Bild in
 * der Antwort; den Bildschirm zeigen; einen Timer stellen und klingeln
 * lassen; "Notiz: …"; etwas kopieren und uebersetzen lassen; ein Bild
 * einfuegen; Dateien auf das Wesen ziehen (es frisst sie, und sie gehen
 * wirklich an die KI -- oder es schuettelt den Kopf); Live mit der Stimme
 * (zuhoeren, Stille erkennen, umschreiben, antworten, vorlesen, wieder
 * zuhoeren, unterbrechen); eine Rueckfrage antippen; die KI einen Termin
 * eintragen lassen; die Insel ueber alle Fenster legen; eine Erinnerung als
 * Kapsel; Neuladen; viele Groessen (1440, 1280, 1024, iPad, Telefon) --
 * nichts darf einen Knopf verdecken; hell und dunkel. Jeder Schritt wird im
 * Tresor oder an der Anfrage beim Statisten nachgesehen, nicht nur am
 * Bildschirm.
 *
 * Was hier anders ist als am echten Rechner, mit Absicht und nur hier:
 * - Den Bildschirm waehlt ein Mensch im Dialog des Browsers. Ein Browser
 *   ohne Bildschirm hat diesen Dialog nicht; mit --auto-accept-this-tab-capture
 *   nimmt Chromium stattdessen ohne Rueckfrage den eigenen Tab (ein
 *   Vorspann-Skript ergaenzt `preferCurrentTab`). Geteilt wird trotzdem
 *   wirklich, und das Bild ist ein echtes Bild dieses Tabs.
 * - Das Mikrofon ist nachgebaut: getUserMedia liefert einen Ton aus WebAudio,
 *   dessen Lautstaerke der Beweis steuert ("sprechen" = 1,5 s laut, dann
 *   still). Die Stille-Erkennung, die Aufnahme (WAV) und das Hochladen sind
 *   echt -- Gemini (der Statist) bekommt eine echte WAV und antwortet mit
 *   dem Text, den der Beweis vorgibt.
 * - Die Spracherkennung des Browsers ist nachgebaut: einmal wie in Opera
 *   (sie meldet sofort "network" -- dann muss die Aufnahme einspringen),
 *   einmal wie in Chrome (sie liefert den Satz). Die Stimme (speechSynthesis)
 *   merkt sich, was sie sagen soll, und braucht dafuer 0,9 s je Satz.
 * - Mitteilungen des Betriebssystems werden mitgeschrieben statt gezeigt.
 *
 * Was es NICHT beweist: wie gross das schwebende Fenster am echten
 * Bildschirm ist, wie ein echtes Mikrofon in einem lauten Raum klingt, und
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

const { B, antwort, medienIn, httpFehler } = gs;
/** Eine Antwort, die man schreiben sieht (der Statist wartet zwischen den Stuecken). */
const langsam = (ms, ...teile) => ({ ...antwort(...teile), pauseMs: ms });

/* ------------------------------------------------------------- Pruefen */

const ergebnisse = [];
function check(ok, satz, detail = '') {
  ergebnisse.push({ ok: !!ok, satz, detail });
  console.log(`  ${ok ? `${G}✓${X}` : `${R}✗${X}`} ${satz}${detail ? `  ${D}${String(detail).slice(0, 170)}${X}` : ''}`);
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

/* --------------------------------------------- Im Browser: Nachbauten */

/** Ein Mikrofon aus WebAudio: still, bis der Beweis "spricht" (window.__mikro.sprechen(ms)). */
function mikrofonNachbau() {
  const m = { offen: 0, zu: 0, gains: [], verboten: false };
  window.__mikro = m;
  const md = navigator.mediaDevices;
  if (!md) return;
  md.getUserMedia = async (c) => {
    if (!c || !c.audio) throw new DOMException('Nur Audio', 'NotSupportedError');
    if (m.verboten) throw new DOMException('Permission denied', 'NotAllowedError');
    const ac = new AudioContext();
    if (ac.state === 'suspended') await ac.resume().catch(() => {});
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 170;
    const gain = ac.createGain();
    gain.gain.value = m.laut ? 0.3 : 0;
    const ziel = ac.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(ziel);
    osc.start();
    m.offen += 1;
    m.gains.push(gain);
    const strom = ziel.stream;
    for (const t of strom.getTracks()) {
      const stopp = t.stop.bind(t);
      t.stop = () => {
        m.zu += 1;
        m.gains = m.gains.filter((g) => g !== gain);
        stopp();
        ac.close().catch(() => {});
      };
    }
    return strom;
  };
  m.sprechen = (ms) => {
    m.laut = true;
    for (const g of m.gains) g.gain.value = 0.3;
    setTimeout(() => {
      m.laut = false;
      for (const g of m.gains) g.gain.value = 0;
    }, ms);
  };
}

/** Eine Stimme, die sich merkt, was sie sagt, und dafuer je Satz `ms` braucht. */
function stimmeNachbau() {
  window.__gesprochen = [];
  window.__stimme = { ms: 900, abgebrochen: 0 };
  let uhr = null;
  class Aeusserung {
    constructor(t) { this.text = t; this.rate = 1; }
  }
  const synth = {
    speaking: false,
    pending: false,
    speak(u) {
      window.__gesprochen.push(u.text);
      synth.speaking = true;
      clearTimeout(uhr);
      uhr = setTimeout(() => { synth.speaking = false; if (u.onend) u.onend(); }, window.__stimme.ms);
    },
    cancel() {
      if (synth.speaking) window.__stimme.abgebrochen += 1;
      synth.speaking = false;
      clearTimeout(uhr);
    },
    pause() {},
    resume() {},
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = Aeusserung;
}

/** Spracherkennung wie in Opera: es gibt sie dem Namen nach, sie meldet sofort "network". */
function erkennungWieOpera() {
  window.__erkennung = { gestartet: 0 };
  class OperaErkennung {
    start() {
      window.__erkennung.gestartet += 1;
      setTimeout(() => {
        if (this.onerror) this.onerror({ error: 'network' });
        if (this.onend) this.onend();
      }, 60);
    }
    stop() {}
    abort() {}
  }
  window.webkitSpeechRecognition = OperaErkennung;
  window.SpeechRecognition = undefined;
}

/** Spracherkennung wie in Chrome: erst ein Teil, dann der ganze Satz; stop() beendet. */
function erkennungWieChrome() {
  window.__erkennung = { gestartet: 0, gestoppt: 0, satz: 'Wie wird das Wetter morgen?' };
  class FalscheErkennung {
    start() {
      window.__erkennung.gestartet += 1;
      const ergebnis = (t, fertig) => ({ results: [Object.assign([{ transcript: t, confidence: 0.9 }], { isFinal: fertig })] });
      const satz = window.__erkennung.satz;
      this.uhren = [
        setTimeout(() => { if (this.onresult) this.onresult(ergebnis(satz.split(' ').slice(0, 2).join(' '), false)); }, 200),
        setTimeout(() => { if (this.onresult) this.onresult(ergebnis(satz, true)); }, 700),
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
    args: ['--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required'],
  });
  const konsole = [];

  async function neueSeite({
    breite = 1440, hoehe = 900, finger = false, mikro = false, erkennung = null, stimme = false, design = 'dark',
  } = {}) {
    const c = await browser.newContext({
      viewport: { width: breite, height: hoehe },
      hasTouch: finger,
      isMobile: false,
      deviceScaleFactor: finger ? 2 : 1,
      colorScheme: design,
      permissions: ['clipboard-read', 'clipboard-write', 'notifications'],
      serviceWorkers: 'block',
    });
    await c.addInitScript(([k, d]) => { try { localStorage.setItem(k, d); } catch { /* egal */ } }, [`neural-os:${app.ki.id}:design`, design]);
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
      // Jeder Zustand des Wesens wird mitgeschrieben (der Beweis liest die Folge).
      window.__zustaende = [];
      new MutationObserver((liste) => {
        for (const m of liste) {
          if (m.attributeName === 'data-zustand' && m.target.classList && m.target.classList.contains('wesen')) {
            const z = m.target.dataset.zustand;
            if (window.__zustaende[window.__zustaende.length - 1] !== z) window.__zustaende.push(z);
          }
          if (m.attributeName === 'data-geste' && m.target.classList && m.target.classList.contains('wesen') && m.target.dataset.geste) {
            window.__gesten = window.__gesten || [];
            window.__gesten.push(m.target.dataset.geste);
          }
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-zustand', 'data-geste'] });
    });
    if (mikro) await c.addInitScript(mikrofonNachbau);
    if (stimme) await c.addInitScript(stimmeNachbau);
    if (erkennung === 'opera') await c.addInitScript(erkennungWieOpera);
    if (erkennung === 'chrome') await c.addInitScript(erkennungWieChrome);
    const p = await c.newPage();
    p.on('pageerror', (e) => konsole.push(`pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') konsole.push(m.text()); });
    return { c, p };
  }

  const wesenKnopf = (p) => p.locator('.insel-wesen-knopf').first();
  const panelOffen = (p) => p.locator('#insel-panel:not([hidden])');
  async function aufmachen(p) {
    if (!(await panelOffen(p).count())) await p.locator('.insel-dock .insel-wesen-knopf').click();
    await panelOffen(p).waitFor({ timeout: 4000 });
    await p.waitForTimeout(150);
  }
  async function zumachen(p) {
    if (await panelOffen(p).count()) {
      await p.locator('.insel-feld').focus().catch(() => {});
      await p.keyboard.press('Escape');
      await p.waitForTimeout(450);
    }
  }
  async function fragen(p, satz) {
    await p.locator('.insel-feld').fill(satz);
    await p.locator('.insel-feld').press('Enter');
  }
  async function letzteAntwort(p) {
    return (await p.locator('.insel-antwort').last().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  }
  async function zustand(p) {
    return p.evaluate(() => { const w = document.querySelector('.insel-wesen-knopf .wesen'); return w ? w.dataset.zustand : null; });
  }
  async function satz(p) {
    return (await p.locator('.insel-panel__satz').innerText().catch(() => '')).trim();
  }
  async function menue(p, eintrag) {
    await p.locator('.insel-eingabe button[aria-label="Mehr"]').click();
    await p.locator(`.insel-menue button[data-eintrag="${eintrag}"]`).click();
  }
  /**
   * Wo das Wesen sitzt -- und welche Bedienelemente es verdeckt (`verdeckt`,
   * darf nie etwas sein) und welche seine Schilder und Kapseln verdecken
   * (`seiteVerdeckt`, darf nichts sein, solange am Rand Platz ist: frei = 'ganz').
   */
  async function lageAmRand(p) {
    return p.evaluate(() => {
      const dock = document.querySelector('.insel-dock');
      const k = document.querySelector('.insel-dock .insel-wesen-knopf');
      if (!dock || !k || dock.hidden) return { da: false };
      const r = k.getBoundingClientRect();
      const seite = [];
      for (const s of document.querySelectorAll('.insel-dock .insel-schild, .insel-dock .erin__card, .insel-dock .insel__wecker')) {
        const q = s.getBoundingClientRect();
        if (q.width) seite.push(q);
      }
      const sel = 'button, a[href], input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="tab"], [role="switch"]';
      const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]} „${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}“`;
      const trifft = (t, q) => Math.min(t.right, q.right) - Math.max(t.left, q.left) > 2 && Math.min(t.bottom, q.bottom) - Math.max(t.top, q.top) > 2;
      const verdeckt = [];
      const seiteVerdeckt = [];
      let wegrollbar = 0;
      const view = document.getElementById('view');
      // Wie die Insel selbst (web/lib/insel.js hindernisseIm): eine grosse Flaeche (die Vorschau des
      // Gehirns) ist kein Knopf, und was in weit rollendem Inhalt liegt, rollt man unter dem Wesen hervor.
      // Am Telefon sitzt es wie ein schwebender Knopf unten rechts: dort rollt jeder rollende Inhalt darunter durch.
      const weit = innerWidth < 600 ? 4 : 160;
      const gross = (q) => q.height > r.height * 3 && q.width * q.height > r.width * r.height * 6;
      const rolltWeg = (el) => {
        if (!view || !view.contains(el) || el.closest('.cv-composer')) return false;
        for (let x = el.parentElement; x && x !== document.body; x = x.parentElement) {
          if (x.scrollHeight - x.clientHeight > weit && /auto|scroll/.test(getComputedStyle(x).overflowY)) return true;
          if (x === view) break;
        }
        return false;
      };
      for (const el of document.querySelectorAll(sel)) {
        if (dock.contains(el) || document.getElementById('insel-panel').contains(el)) continue;
        const q = el.getBoundingClientRect();
        if (!q.width || !q.height) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (gross(q)) continue;
        if (rolltWeg(el)) {
          if (trifft(r, q)) wegrollbar += 1;
          continue;
        }
        // Liegt es ueberhaupt oben (nicht hinter einer Schublade oder ausserhalb des Fensters)?
        if (q.bottom <= 0 || q.top >= innerHeight || q.right <= 0 || q.left >= innerWidth) continue;
        const mitte = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, q.left + q.width / 2)), Math.min(innerHeight - 1, Math.max(0, q.top + q.height / 2)));
        const sichtbar = mitte && (el === mitte || el.contains(mitte) || dock.contains(mitte));
        if (!sichtbar) continue;
        if (trifft(r, q)) verdeckt.push(name(el));
        else if (seite.some((t) => trifft(t, q))) seiteVerdeckt.push(name(el));
      }
      const composer = document.querySelector('.cv-composer');
      const c = composer ? composer.getBoundingClientRect() : null;
      const aufComposer = !!(c && c.width && trifft(r, c));
      return {
        da: true,
        rechts: Math.round(innerWidth - r.right),
        unten: Math.round(innerHeight - r.bottom),
        mitteY: Math.round(r.top + r.height / 2),
        groesse: Math.round(r.width),
        hoehe: innerHeight,
        breite: innerWidth,
        verdeckt,
        seiteVerdeckt,
        wegrollbar,
        frei: dock.dataset.frei || '',
        aufComposer,
        // Die eigene Spur gibt es erst ab 1000 px (web/lib/insel.js, Aussehen).
        spur: innerWidth >= 1000 && document.querySelector('.shell').dataset.insel === 'spur' && document.querySelector('.shell').dataset.rechts === 'zu',
        buehneRechts: Math.round(document.querySelector('.stage').getBoundingClientRect().right),
        links: Math.round(r.left),
      };
    });
  }
  /** Verdeckt die Seite etwas, obwohl Platz war? (Ohne Platz liegt sie wie eine Mitteilung kurz darueber.) */
  const seiteFalsch = (l) => (l.frei === 'ganz' ? l.seiteVerdeckt : []);
  async function panelMasse(p) {
    return p.evaluate(() => {
      const r = document.getElementById('insel-panel').getBoundingClientRect();
      const k = document.querySelector('.insel-wesen-knopf');
      return {
        l: Math.round(r.left), r: Math.round(innerWidth - r.right), o: Math.round(r.top), u: Math.round(innerHeight - r.bottom),
        b: Math.round(r.width), h: Math.round(r.height), vb: innerWidth, vh: innerHeight,
        wesenDrin: !!(k && k.closest('#insel-panel')), wesen: k ? Math.round(k.getBoundingClientRect().width) : 0,
        art: document.getElementById('insel-panel').dataset.art || '',
      };
    });
  }
  const stromAnfragen = () => gemini.stromAnfragen();

  let fehlgeschlagen = false;
  let appZu = false;
  try {
    const { c, p } = await neueSeite();
    await p.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
    await p.locator('.cv-leer__titel').waitFor({ timeout: 8000 }).catch(() => {});
    await dismissWelcome(p);
    await p.waitForTimeout(1200);

    /* ------------------------------------------------ A. Das Wesen */
    abschnitt('A · Das Wesen am rechten Rand – antippen, es wächst');
    const lageA = await lageAmRand(p);
    check(lageA.da && lageA.rechts >= 8 && lageA.rechts <= 24 && lageA.groesse >= 56 && lageA.groesse <= 64,
      'Zu ist die Insel ein kleines Wesen am rechten Rand (gut 16 px vom Rand, 56–64 px groß)', JSON.stringify({ rechts: lageA.rechts, groesse: lageA.groesse }));
    check(lageA.mitteY > lageA.hoehe * 0.45 && lageA.mitteY < lageA.hoehe * 0.8, 'Es sitzt im unteren Teil der Mitte', `Mitte bei ${lageA.mitteY} von ${lageA.hoehe} px`);
    check(lageA.verdeckt.length === 0 && !lageA.aufComposer && !seiteFalsch(lageA).length, 'Es verdeckt keinen Knopf – auch nicht in der rechten Spalte oder auf dem Eingabefeld',
      [...lageA.verdeckt, ...seiteFalsch(lageA)].join(', ') || 'nichts verdeckt');
    const zuA = await p.evaluate(() => {
      const k = document.querySelector('.insel-dock .insel-wesen-knopf');
      const svg = k.querySelector('svg');
      return {
        label: k.getAttribute('aria-label'),
        zustand: k.querySelector('.wesen').dataset.zustand,
        svg: !!svg && svg.namespaceURI === 'http://www.w3.org/2000/svg',
        bilder: k.querySelectorAll('img').length,
        oben: !document.querySelector('.topbar .insel-dock'),
      };
    });
    check(/^Insel: Was kann ich für dich tun\?/.test(zuA.label) && zuA.zustand === 'ruht', 'Es sagt, was es ist („Insel: Was kann ich für dich tun? … Öffnen“) und ruht', zuA.label);
    check(zuA.svg && zuA.bilder === 0 && zuA.oben, 'Gezeichnet als eigenes SVG (keine Bilddatei) – und nicht mehr oben im Kopf');
    await foto(p, 'wesen-zu', { clip: { x: 1080, y: 380, width: 360, height: 320 } });
    await foto(p, 'wesen-zu-ganz');

    await wesenKnopf(p).click();
    await panelOffen(p).waitFor({ timeout: 4000 });
    await p.waitForTimeout(600);
    const offenA = await panelMasse(p);
    const aufZustand = await p.evaluate(() => ({
      expanded: document.querySelector('.insel-wesen-knopf').getAttribute('aria-expanded'),
      rolle: document.getElementById('insel-panel').getAttribute('role'),
      fokus: document.activeElement && document.activeElement.classList.contains('insel-feld'),
      wege: [...document.querySelectorAll('.insel-weg')].map((b) => b.textContent.trim().slice(0, 28)),
      satz: document.querySelector('.insel-panel__satz').textContent,
    }));
    check(aufZustand.expanded === 'true' && aufZustand.rolle === 'dialog' && aufZustand.fokus, 'Antippen: es wächst zu einem Feld (ein Dialog), und man kann sofort tippen', JSON.stringify({ e: aufZustand.expanded, f: aufZustand.fokus }));
    check(offenA.wesenDrin && offenA.wesen >= 84, 'Oben im Feld sitzt dasselbe Wesen – größer', `${offenA.wesen} px`);
    check(offenA.r >= 12 && offenA.r <= 20 && offenA.b >= 380 && offenA.b <= 420 && offenA.h <= offenA.vh * 0.8 + 1 && offenA.l > offenA.vb / 2,
      'Das Feld hängt am rechten Rand: 380–420 px breit, höchstens 80 % hoch – nicht der ganze Bildschirm', JSON.stringify(offenA));
    check(aufZustand.wege.length >= 4 && /Live/.test(aufZustand.wege.join(' ')), 'Leer sagt es, was geht – jeder Weg ein echter Knopf (auch „Live sprechen“)', aufZustand.wege.join(' · '));
    check(aufZustand.satz === 'Was kann ich für dich tun?', 'Unter dem Wesen eine kurze Zeile', aufZustand.satz);
    const namenlos = await p.evaluate(() => [...document.querySelectorAll('#insel-panel button')]
      .filter((b) => b.offsetWidth && !(b.getAttribute('aria-label') || b.textContent.trim())).length);
    check(namenlos === 0, 'Jeder Knopf im Feld hat einen Namen (für Vorlesehilfen)', `${namenlos} ohne Namen`);
    const leiste = await p.evaluate(() => [...document.querySelectorAll('.insel-eingabe button')].filter((b) => b.offsetWidth).map((b) => b.getAttribute('aria-label') || b.textContent.trim()));
    check(leiste.some((x) => /^Datei geben/.test(x)) && leiste.includes('Mehr') && leiste.includes('Sprechen') && leiste.some((x) => /^Live/.test(x)) && leiste.includes('Senden'),
      'Die Eingabe: Feld, Büroklammer, „…“, Mikrofon, Live, Senden', leiste.join(' · '));
    await foto(p, 'offen-leer');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(500);
    const zu = await p.evaluate(() => ({
      versteckt: document.getElementById('insel-panel').hidden,
      fokus: document.activeElement && document.activeElement.classList.contains('insel-wesen-knopf'),
      imDock: !!document.querySelector('.insel-dock .insel-wesen-knopf'),
    }));
    check(zu.versteckt && zu.fokus && zu.imDock, 'Esc: es wird wieder klein, sitzt am Rand, und der Fokus ist auf ihm');
    await p.keyboard.press('Control+Shift+Space');
    await p.waitForTimeout(450);
    const perTaste = await panelOffen(p).count();
    await p.mouse.click(700, 640);
    await p.waitForTimeout(450);
    const draussen = await p.locator('#insel-panel[hidden]').count();
    check(perTaste === 1 && draussen === 1, 'Strg+Umschalt+Leertaste öffnet es; ein Klick daneben schließt es');
    await aufmachen(p);
    await p.locator('#insel-panel .insel-wesen-knopf').click();
    await p.waitForTimeout(450);
    check(await p.locator('#insel-panel[hidden]').count() === 1, 'Das Wesen im Feld noch einmal antippen: wieder klein');

    /* ------------------------------------------------ B. Fragen */
    abschnitt('B · Fragen: es denkt, es spricht, man kann stoppen');
    await aufmachen(p);
    await p.evaluate(() => { window.__zustaende = []; });
    gemini.weiter(langsam(260, B.text('Vier. Zwei plus zwei ergibt vier – das ist die kleinste Rechnung, die jeder kennt.'), B.ende()));
    const vorB = stromAnfragen().length;
    await fragen(p, 'Was ist zwei plus zwei?');
    const sprichtB = await warteBis(async () => (await zustand(p)) === 'spricht', { timeout: 4000, alle: 30 });
    const satzB = await satz(p);
    check(!!sprichtB && /schreibe/.test(satzB), 'Während die Antwort Wort für Wort kommt, bewegt das Wesen den Mund („Ich schreibe …“)', satzB);
    await warteBis(async () => /kleinste Rechnung/.test(await letzteAntwort(p)), { timeout: 10000 });
    check(/^Vier\./.test(await letzteAntwort(p)), 'Die Antwort steht im Feld', await letzteAntwort(p));
    const folgeB = await warteBis(async () => {
      const f = await p.evaluate(() => window.__zustaende.slice());
      return f.includes('freut') ? f : null;
    }, { timeout: 3000 });
    const folge = folgeB || await p.evaluate(() => window.__zustaende.slice());
    check(folge.indexOf('denkt') >= 0 && folge.indexOf('denkt') < folge.indexOf('spricht') && folge.indexOf('spricht') < folge.indexOf('freut'),
      'Erst denkt es, dann spricht es, dann freut es sich', folge.join(' → '));
    const anB = stromAnfragen().slice(vorB)[0];
    const systemText = JSON.stringify((anB && anB.body && anB.body.systemInstruction) || {});
    check(/über die Insel/.test(systemText) && /kurz/.test(systemText), 'An Gemini ging die Anweisung der Insel mit (kurz, gut vorlesbar, Bilder sind Bildschirmfotos oder Dateien)');
    const inselChats = store.list('chat', { limit: 50 }).items.filter((r) => /^Insel · /.test(r.data.title || ''));
    check(inselChats.length === 1 && /über die Insel/.test(inselChats[0].data.systemPrompt || ''), 'Im Tresor steht ein echter Chat „Insel · …“ mit dieser Anweisung', inselChats.map((r) => r.data.title).join(', '));
    const zuletzt = await warteBis(async () => (await p.locator('.rail').innerText()).includes('Insel · '), { timeout: 5000 });
    check(!!zuletzt, 'Er steht sofort links unter „Zuletzt“');

    // Stoppen mitten im Strom
    gemini.weiter(langsam(120, B.text('Hier kommt eine lange Antwort. '), ...Array.from({ length: 40 }, (_, i) => B.text(`Satz Nummer ${i + 1} von vierzig. `)), B.ende()));
    const abbruecheVorher = gemini.abbrueche();
    await fragen(p, 'Erzähl mir etwas Langes.');
    await warteBis(async () => (await letzteAntwort(p)).length > 20, { timeout: 6000 });
    const stoppUnten = await p.locator('.insel-eintrag').last().locator('.insel-zustand button', { hasText: 'Stopp' }).count();
    await p.locator('.insel-eingabe button[aria-label="Stopp"]').click();
    const gestoppt = await warteBis(async () => /Abgebrochen/.test(await p.locator('.insel-eintrag').last().innerText()), { timeout: 8000 });
    check(stoppUnten === 1 && !!gestoppt && gemini.abbrueche() > abbruecheVorher, '[Stopp] (unter der Antwort und statt Senden) bricht wirklich ab – auch beim Anbieter', `Abbrüche beim Statisten: ${gemini.abbrueche() - abbruecheVorher}`);

    // Fertig, waehrend es zu ist: ein Schild neben dem Wesen
    gemini.weiter(langsam(60, B.text('Erledigt: die Antwort kam, während die Insel zu war.'), B.ende()));
    await fragen(p, 'Antworte, wenn ich weg bin.');
    await p.keyboard.press('Escape');
    const neu = await warteBis(() => p.locator('.insel-dock .insel-schild[data-art="neu"]').count(), { timeout: 8000 });
    const neuText = neu ? (await p.locator('.insel-dock .insel-schild[data-art="neu"]').innerText()).replace(/\s+/g, ' ') : '';
    const punkt = await p.locator('.insel-dock .insel-wesen-knopf').getAttribute('data-neu');
    check(!!neu && /Erledigt/.test(neuText) && punkt === 'ja', 'Kommt die Antwort, während es zu ist: ein Schild daneben und ein blauer Punkt am Wesen', neuText);
    await foto(p, 'wesen-neu', { clip: { x: 980, y: 380, width: 460, height: 320 } });
    await p.locator('.insel-dock .insel-wesen-knopf').click();
    await p.waitForTimeout(400);
    check((await p.locator('.insel-wesen-knopf').getAttribute('data-neu')) !== 'ja', 'Aufmachen heißt gesehen');

    /* ------------------------------------------------ C. Suchen */
    abschnitt('C · Im Internet suchen: Suchzeile, Quellen, ruhige Hinweise, Bilder');
    await aufmachen(p);
    gemini.weiter(antwort(
      B.suche(['Wetter Berlin morgen'], [
        { url: 'https://wetter.example/berlin', titel: 'Wetter in Berlin' },
        { url: 'https://www.dwd.example/vorhersage', titel: 'DWD Vorhersage' },
      ], { text: 'Morgen wird es in Berlin sonnig, bis 21 Grad.' }),
      B.ende(),
    ));
    await fragen(p, 'Wie wird das Wetter morgen in Berlin?');
    await warteBis(async () => /sonnig/.test(await letzteAntwort(p)), { timeout: 10000 });
    await p.waitForTimeout(300);
    const sucheC = await p.evaluate(() => {
      const e = [...document.querySelectorAll('.insel-eintrag')].pop();
      return {
        schritt: [...e.querySelectorAll('.insel-schritt')].map((x) => x.textContent.trim()).join(' | '),
        quellen: [...e.querySelectorAll('.insel-quelle')].map((a) => ({ t: a.textContent.replace(/\s+/g, ' ').trim(), href: a.getAttribute('href'), ziel: a.target })),
        verweise: e.querySelectorAll('.insel-verweis').length,
      };
    });
    check(/Gesucht: „Wetter Berlin morgen“/.test(sucheC.schritt) && /Treffer/.test(sucheC.schritt), 'Über der Antwort steht, wonach gesucht wurde („Gesucht: … · 2 Treffer“)', sucheC.schritt);
    check(sucheC.quellen.length === 2 && /Wetter in Berlin/.test(sucheC.quellen[0].t) && /wetter\.example/.test(sucheC.quellen[0].t) && sucheC.quellen[0].ziel === '_blank',
      'Darunter die Quellen: Titel und Rechner, öffnen im neuen Tab', JSON.stringify(sucheC.quellen.map((q) => q.t)));
    check(sucheC.verweise >= 1, '„[1]“ im Text wird ein Verweis auf die Quelle', `${sucheC.verweise} Verweise`);
    await foto(p, 'suche-quellen');
    gemini.weiter(
      httpFehler(400, 'INVALID_ARGUMENT', 'Multiple tools are supported only when they are all search tools.'),
      antwort(B.text('Ohne Suche geht es auch: Ein Tag hat 24 Stunden.'), B.ende()),
    );
    await fragen(p, 'Wie viele Stunden hat ein Tag?');
    await warteBis(async () => /24 Stunden/.test(await letzteAntwort(p)), { timeout: 10000 });
    const hinweisC = (await p.locator('.insel-eintrag').last().locator('.insel-notiz').innerText().catch(() => '')).trim();
    check(/Ohne Internetsuche/.test(hinweisC), 'Ein Hinweis aus dem Strom steht klein und ruhig unter der Antwort', hinweisC);
    gemini.weiter(antwort(B.text('Das ist das Zeichen von Neural OS:\n\n![Das Zeichen](/icons/icon-192.png)\n\nEin Bild aus dem Netz lade ich nicht: ![Foto](https://bilder.example/foto.png)'), B.ende()));
    await fragen(p, 'Zeig mir ein Bild.');
    await warteBis(() => p.locator('.insel-eintrag').last().locator('img.md-image').count(), { timeout: 10000 });
    await p.waitForTimeout(400);
    const bildC = await p.evaluate(() => {
      const e = [...document.querySelectorAll('.insel-eintrag')].pop();
      const img = e.querySelector('img.md-image');
      const gesperrt = e.querySelector('.md-image-blocked');
      return {
        breite: img ? img.naturalWidth : 0,
        src: img ? img.getAttribute('src') : '',
        gesperrt: gesperrt ? `${gesperrt.textContent} | ${gesperrt.getAttribute('title')}` : '',
        fremdGeladen: [...e.querySelectorAll('img')].some((i) => /bilder\.example/.test(i.src)),
      };
    });
    check(bildC.breite > 0 && bildC.src === '/icons/icon-192.png', 'Ein Bild in der Antwort (von Neural OS selbst) wird gezeigt – wie im Chat', JSON.stringify(bildC));
    check(/bilder\.example/.test(bildC.gesperrt) && !bildC.fremdGeladen, 'Ein Bild aus dem Netz wird nicht geladen, sondern ehrlich genannt (wie im Chat)', bildC.gesperrt.slice(0, 110));
    await p.locator('.insel-eintrag').last().locator('img.md-image').click();
    const leucht = await warteBis(() => p.locator('.lk').count(), { timeout: 3000 });
    check(!!leucht, 'Antippen zeigt das Bild groß');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    // Jedes Werkzeug, das der Chat-Strom meldet -- hier das Nachschlagen in Wikipedia (fuer KIs ohne
    // eigene Websuche), eine gelesene Quelle und genau ein ruhiger Hinweis. Der Strom kommt hier
    // nachgebaut in der Form des Chat-Dienstes (Ereignisse agent, quelle, text, hinweis, fertig):
    // gezeigt wird, dass die Insel jedes Werkzeug gleich ruhig zeigt, ohne es zu kennen.
    await aufmachen(p);
    const sse = (typ, daten) => `event: ${typ}\ndata: ${JSON.stringify(daten)}\n\n`;
    const wiki = { id: 'ag_wiki', rolle: 'recherche', titel: 'Wikipedia: „Brandenburger Tor“', werkzeug: 'wikipedia_suchen' };
    await p.route('**/api/chats/*/messages', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
        body: [
          sse('agent', { ...wiki, schritt: 'Schlägt nach', zustand: 'laeuft' }),
          sse('agent', { ...wiki, schritt: '', zustand: 'fertig', ergebnis: '2 Artikel gefunden' }),
          sse('quelle', { titel: 'Brandenburger Tor – Wikipedia', url: 'https://de.wikipedia.org/wiki/Brandenburger_Tor', art: 'gelesen' }),
          sse('text', { delta: 'Das Brandenburger Tor steht in Berlin-Mitte und wurde 1791 fertig [1].' }),
          sse('hinweis', { satz: 'Gemini ist gerade am Limit – es antwortet Mistral.' }),
          sse('fertig', { stopReason: 'end_turn' }),
        ].join(''),
      });
    });
    await fragen(p, 'Erzähl mir etwas über das Brandenburger Tor.');
    await warteBis(async () => /1791/.test(await letzteAntwort(p)), { timeout: 8000 });
    await p.unroute('**/api/chats/*/messages');
    await p.waitForTimeout(200);
    const wikiC = await p.evaluate(() => {
      const e = [...document.querySelectorAll('.insel-eintrag')].pop();
      return {
        schritt: [...e.querySelectorAll('.insel-schritt')].map((x) => x.textContent.trim()).join(' | '),
        quelle: [...e.querySelectorAll('.insel-quelle')].map((a) => `${a.textContent.replace(/\s+/g, ' ').trim()} ${a.target}`).join(' | '),
        verweis: (e.querySelector('.insel-verweis') || { getAttribute: () => '' }).getAttribute('href'),
        hinweise: [...e.querySelectorAll('.insel-notiz')].map((x) => x.textContent.trim()),
      };
    });
    check(/Wikipedia: „Brandenburger Tor“ · 2 Artikel gefunden/.test(wikiC.schritt), 'Ein anderes Werkzeug (Wikipedia nachschlagen) steht genauso ruhig da: „… · 2 Artikel gefunden“', wikiC.schritt);
    check(/Brandenburger Tor – Wikipedia/.test(wikiC.quelle) && /de\.wikipedia\.org/.test(wikiC.quelle) && /_blank/.test(wikiC.quelle) && /de\.wikipedia\.org/.test(wikiC.verweis),
      'Die gelesene Quelle steht in der Liste, „[1]“ führt zu ihr', `${wikiC.quelle} · ${wikiC.verweis}`);
    check(wikiC.hinweise.length === 1 && wikiC.hinweise[0] === 'Gemini ist gerade am Limit – es antwortet Mistral.', 'Der eine Hinweis des Zuges steht als ein ruhiger Satz darunter', wikiC.hinweise.join(' | '));
    await foto(p, 'wikipedia-hinweis');

    /* ------------------------------------------------ D. Bildschirm */
    abschnitt('D · Bildschirm zeigen: die KI sieht mit');
    await aufmachen(p);
    await menue(p, 'teilen');
    const teilt = await warteBis(() => p.locator('.insel-teilen:not([hidden])').count(), { timeout: 6000 });
    const teilText = teilt ? (await p.locator('.insel-teilen').innerText()).replace(/\s+/g, ' ') : '';
    check(!!teilt && /Ich sehe/.test(teilText) && /Gemini/.test(teilText), '„…“ → Bildschirm zeigen: es wird geteilt – und die Insel sagt ehrlich, wohin das Bild geht', teilText);
    gemini.weiter(antwort(B.text('Ich sehe Neural OS mit einem Chat und der Insel am Rand.'), B.ende()));
    const vorD = stromAnfragen().length;
    await fragen(p, 'Was siehst du?');
    await warteBis(async () => /Ich sehe Neural OS/.test(await letzteAntwort(p)), { timeout: 12000 });
    const anD = stromAnfragen().slice(vorD)[0];
    const medien = medienLetzte(anD && anD.body);
    check(medien.length === 1 && medien[0].mime === 'image/jpeg' && medien[0].bytes > 5000 && medien[0].bytes <= 5 * 1024 * 1024,
      'An Gemini ging mit der Frage ein echtes Bild vom Bildschirm (JPEG, unter 5 MB)', JSON.stringify(medien));
    const abgelegt = store.list('file', { limit: 50 }).items.filter((f) => /^Bildschirm \d\d-\d\d-\d\d\.jpg$/.test(f.data.name || ''));
    check(abgelegt.length === 1, 'Im Insel-Chat liegt das Bild als Anhang – zu sehen und zu löschen wie jeder Anhang', abgelegt.map((f) => f.data.name).join(', '));
    check(await p.locator('.insel-eintrag').last().locator('.insel-frage__bilder img').count() === 1, 'Über der Antwort steht das Bild, das die KI bekommen hat');
    await p.locator('.insel-anhaenge button', { hasText: 'Bildschirm geht mit' }).click();
    gemini.weiter(antwort(B.text('Ohne Bild: gern.'), B.ende()));
    const vorD2 = stromAnfragen().length;
    await fragen(p, 'Und ohne Bild?');
    await warteBis(async () => /Ohne Bild: gern/.test(await letzteAntwort(p)), { timeout: 8000 });
    check(medienLetzte(stromAnfragen().slice(vorD2)[0].body).length === 0, '„Bildschirm geht mit“ antippen: die nächste Frage geht ohne Bild');
    await p.locator('.insel-anhaenge button', { hasText: 'Ohne Bild' }).click();
    await zumachen(p);
    const teilSchild = (await p.locator('.insel-dock .insel-schild[data-art="teilen"]').innerText().catch(() => '')).trim();
    const teilPunkt = await p.locator('.insel-dock .insel-schild[data-art="teilen"] .insel-schild__punkt').count();
    check(/Bildschirm/.test(teilSchild) && teilPunkt === 1, 'Zu: neben dem Wesen „Sieht deinen Bildschirm“ mit rotem Punkt', teilSchild);
    await aufmachen(p);
    await p.locator('.insel-teilen button', { hasText: 'Stopp' }).click();
    await p.waitForTimeout(300);
    const nachStopp = await p.evaluate(() => ({ zeile: !document.querySelector('.insel-teilen:not([hidden])'), video: !document.querySelector('.insel-teilen video').srcObject }));
    check(nachStopp.zeile && nachStopp.video, '[Stopp] beendet das Teilen – die Aufnahme ist wirklich zu');

    /* ------------------------------------------------ E. Kleine Befehle */
    abschnitt('E · Timer und Notiz – ohne die KI zu fragen');
    const vorE = stromAnfragen().length;
    await fragen(p, 'Timer 3 min Tee');
    await p.waitForTimeout(1300);
    const chip = (await p.locator('.insel-live').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Tee/.test(chip) && /2:5\d|3:00/.test(chip), '„Timer 3 min Tee“ läuft sofort, mit Countdown', chip);
    await fragen(p, 'Notiz: Milch und Brot kaufen');
    const notiz = await warteBis(() => store.list('note', { limit: 100 }).items.find((n) => n.data.title === 'Milch und Brot kaufen'), { timeout: 5000 });
    check(!!notiz, '„Notiz: …“ legt die Notiz wirklich an', notiz ? notiz.id : 'keine');
    check(stromAnfragen().length === vorE, 'Beides ohne eine einzige Anfrage an die KI');
    await menue(p, 'timer');
    await p.waitForTimeout(300);
    const wahl = await p.locator('.insel-timerwahl:not([hidden]) button').allInnerTexts();
    check(wahl.join(',') === '1 Min,3 Min,5 Min,10 Min,15 Min,25 Min', '„…“ → Timer zeigt die Auswahl (1, 3, 5, 10, 15, 25 Min)', wahl.join(', '));
    await fragen(p, 'Timer 2 sek Nudeln');
    await zumachen(p);
    const klingelt = await warteBis(() => p.locator('.insel-dock .insel__wecker', { hasText: 'Nudeln ist fertig' }).count(), { timeout: 6000 });
    const klingelZustand = await p.evaluate(() => ({ dock: document.querySelector('.insel-dock').dataset.klingelt, geste: document.querySelector('.insel-dock .wesen').dataset.geste }));
    check(!!klingelt && klingelZustand.dock === 'ja' && klingelZustand.geste === 'aufgeregt', 'Ist er um: das Wesen hüpft, daneben „Nudeln ist fertig“ mit [Aus]', JSON.stringify(klingelZustand));
    const mitteilungen = await p.evaluate(() => window.__mitteilungen);
    check(mitteilungen.some((m) => m.titel === 'Nudeln ist fertig'), 'und das Betriebssystem bekommt eine Mitteilung (für ein anderes Programm im Vordergrund)', JSON.stringify(mitteilungen));
    await foto(p, 'timer-klingelt', { clip: { x: 980, y: 380, width: 460, height: 320 } });
    await p.locator('.insel-dock .insel__wecker button', { hasText: 'Aus' }).click();
    await p.waitForTimeout(350);
    check(await p.locator('.insel__wecker').count() === 0, '[Aus] stellt ihn ab');
    const timerSchild = (await p.locator('.insel-dock .insel-schild[data-art="timer"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/[0-3]:\d\d Tee/.test(timerSchild), 'Der andere Timer läuft weiter – als kleines Schild neben dem Wesen', timerSchild);

    /* ------------------------------------------------ F. Zwischenablage */
    abschnitt('F · Aus einem anderen Programm: kopieren, einfügen, fragen');
    await p.evaluate(() => navigator.clipboard.writeText('The quick brown fox jumps over the lazy dog.'));
    await aufmachen(p);
    await menue(p, 'ablage');
    await warteBis(() => p.locator('.insel-anhaenge', { hasText: 'Aus der Zwischenablage' }).count(), { timeout: 3000 });
    gemini.weiter(antwort(B.text('Der schnelle braune Fuchs springt über den faulen Hund.'), B.ende()));
    const vorF = stromAnfragen().length;
    await p.locator('.insel-vorlagen button', { hasText: 'Übersetz ins Deutsche' }).click();
    await warteBis(async () => /Fuchs/.test(await letzteAntwort(p)), { timeout: 8000 });
    const textF = nutzerText(stromAnfragen().slice(vorF)[0].body);
    check(/Übersetz das ins Deutsche/.test(textF) && /Aus der Zwischenablage/.test(textF) && /quick brown fox/.test(textF),
      '„…“ → Aus der Zwischenablage, dann „Übersetz ins Deutsche“: der kopierte Text geht eingezäunt mit', textF.replace(/\s+/g, ' ').slice(0, 120));
    await p.evaluate(() => { window.__zustaende = []; });
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
    const eingefuegt = await warteBis(() => p.locator('.insel-anhaenge', { hasText: 'kopiert.png' }).count(), { timeout: 5000 });
    const frassF = await p.evaluate(() => window.__zustaende.includes('frisst'));
    check(!!eingefuegt && frassF, 'Ein eingefügtes Bild (Strg+V): das Wesen isst es – es hängt an der nächsten Frage');
    gemini.weiter(antwort(B.text('Ein pinkes Rechteck.'), B.ende()));
    const vorF2 = stromAnfragen().length;
    await fragen(p, 'Was ist das?');
    await warteBis(async () => /pinkes Rechteck/.test(await letzteAntwort(p)), { timeout: 8000 });
    const medienF = medienLetzte(stromAnfragen().slice(vorF2)[0].body);
    check(medienF.length === 1 && medienF[0].mime === 'image/png', 'und geht als Bild an die KI', JSON.stringify(medienF));

    /* ------------------------------------------------ G. Dateien essen */
    abschnitt('G · Dateien: das Wesen frisst sie – und sie gehen wirklich an die KI');
    await zumachen(p);
    await p.evaluate(() => { window.__zustaende = []; window.__happen = 0; });
    await p.evaluate(() => {
      new MutationObserver((l) => { for (const m of l) for (const n of m.addedNodes) if (n.classList && n.classList.contains('wesen-happen')) window.__happen += 1; })
        .observe(document.body, { childList: true });
    });
    gemini.weiter(langsam(120, B.text('Auf deinem Einkaufszettel stehen Milch, Brot und Käse.'), B.ende()));
    const vorG = stromAnfragen().length;
    const zielG = await p.locator('.insel-dock .insel-wesen-knopf').boundingBox();
    await p.evaluate(({ x, y }) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['Milch\nBrot\nKäse\n'], 'einkauf.txt', { type: 'text/plain' }));
      const ziel = document.querySelector('.insel-dock .insel-wesen-knopf');
      ziel.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      window.__hungrig = document.querySelector('.insel-dock .wesen').dataset.geste;
      ziel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, { x: zielG.x + zielG.width / 2, y: zielG.y + zielG.height / 2 });
    await p.waitForTimeout(260);
    await foto(p, 'frisst-datei', { clip: { x: 1100, y: 380, width: 340, height: 320 } });
    const frisstG = await p.evaluate(() => ({ hungrig: window.__hungrig, zustand: document.querySelector('.insel-wesen-knopf .wesen').dataset.zustand, happen: window.__happen }));
    check(frisstG.hungrig === 'hungrig' && frisstG.zustand === 'frisst' && frisstG.happen >= 1, 'Datei aufs Wesen gezogen: Maul auf, die Datei fliegt hinein', JSON.stringify(frisstG));
    await warteBis(async () => /Einkaufszettel/.test(await letzteAntwort(p)), { timeout: 12000 });
    const anG = stromAnfragen().slice(vorG)[0];
    const textG = nutzerText(anG && anG.body);
    const folgeG = await p.evaluate(() => ({ z: window.__zustaende.slice(), g: (window.__gesten || []).slice(-6) }));
    check(/Werte diese Datei aus\./.test(textG) && /einkauf\.txt/.test(textG) && /Milch\nBrot\nKäse/.test(textG),
      'Es kaut – dann geht die Datei mit „Werte diese Datei aus.“ an die KI (Text im Browser gelesen)', textG.replace(/\s+/g, ' ').slice(0, 140));
    check(folgeG.g.includes('kauen') && folgeG.g.includes('verdaut') && (await panelOffen(p).count()) === 1, 'Danach wächst es auf und zeigt Frage und Antwort', JSON.stringify(folgeG));
    const frageG = (await p.locator('.insel-eintrag').last().locator('.insel-frage').innerText()).replace(/\s+/g, ' ');
    check(/einkauf\.txt/.test(frageG) && /Werte diese Datei aus/.test(frageG), 'In der Frage steht, was es gegessen hat', frageG);
    // Ein PDF ins offene Feld
    gemini.weiter(antwort(B.text('Das PDF ist eine Rechnung über 42 Euro.'), B.ende()));
    const vorG2 = stromAnfragen().length;
    await p.evaluate(() => {
      const pdf = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
      const dt = new DataTransfer();
      dt.items.add(new File([pdf], 'Rechnung.pdf', { type: 'application/pdf' }));
      const ziel = document.querySelector('.insel-verlauf');
      ziel.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: 1200, clientY: 500, bubbles: true, cancelable: true }));
      ziel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 1200, clientY: 500, bubbles: true, cancelable: true }));
    });
    await warteBis(async () => /Rechnung über 42/.test(await letzteAntwort(p)), { timeout: 12000 });
    const medienG = medienLetzte((stromAnfragen().slice(vorG2)[0] || {}).body);
    check(medienG.some((m) => m.mime === 'application/pdf'), 'Ein PDF ins offene Feld gezogen: es geht als PDF an die KI', JSON.stringify(medienG));
    // Etwas, das es nicht lesen kann
    await p.evaluate(() => { window.__gesten = []; });
    const vorG3 = stromAnfragen().length;
    await p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['PK\u0003\u0004'], 'archiv.zip', { type: 'application/zip' }));
      const ziel = document.querySelector('.insel-verlauf');
      ziel.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: 1200, clientY: 500, bubbles: true, cancelable: true }));
      ziel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 1200, clientY: 500, bubbles: true, cancelable: true }));
    });
    await p.waitForTimeout(250);
    const neinG = await p.evaluate(() => ({
      geste: (window.__gesten || []).includes('schuetteln'),
      zustand: document.querySelector('.insel-wesen-knopf .wesen').dataset.zustand,
      satz: document.querySelector('.insel-hinweis:not([hidden])') ? document.querySelector('.insel-hinweis').textContent : '',
      kopf: document.querySelector('.insel-panel__satz').textContent,
    }));
    check(neinG.geste && neinG.zustand === 'verwirrt' && /archiv\.zip“ kann ich nicht lesen/.test(neinG.satz), 'Eine ZIP-Datei: es schüttelt den Kopf und sagt ehrlich, warum', `${neinG.satz} | ${neinG.kopf}`);
    await foto(p, 'kopfschuetteln', { clip: { x: 1020, y: 160, width: 420, height: 320 } });
    await p.waitForTimeout(400);
    check(stromAnfragen().length === vorG3, 'und schickt nichts los');
    // Zu gross
    await p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'.repeat(250 * 1024)], 'buch.txt', { type: 'text/plain' }));
      const ziel = document.querySelector('.insel-verlauf');
      ziel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 1200, clientY: 500, bubbles: true, cancelable: true }));
    });
    await p.waitForTimeout(300);
    const grossG = (await p.locator('.insel-hinweis').innerText().catch(() => '')).trim();
    check(/buch\.txt“ ist zu groß/.test(grossG) && stromAnfragen().length === vorG3, 'Eine Textdatei über 200 KB: abgelehnt, mit Satz – nichts geht los', grossG);
    // Die Bueroklammer
    await p.waitForTimeout(3200);
    gemini.weiter(antwort(B.text('Ein grünes Quadrat.'), B.ende()));
    const vorG4 = stromAnfragen().length;
    const png = await p.evaluate(async () => {
      const cv = document.createElement('canvas');
      cv.width = 64;
      cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = '#00aa44';
      g.fillRect(0, 0, 64, 64);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    await p.locator('.insel-eingabe input[type="file"]').setInputFiles({ name: 'quadrat.png', mimeType: 'image/png', buffer: Buffer.from(png) });
    await warteBis(async () => /grünes Quadrat/.test(await letzteAntwort(p)), { timeout: 12000 });
    const medienG4 = medienLetzte((stromAnfragen().slice(vorG4)[0] || {}).body);
    const textG4 = nutzerText((stromAnfragen().slice(vorG4)[0] || {}).body);
    check(medienG4.some((m) => m.mime === 'image/png') && /Werte diese Datei aus/.test(textG4), 'Die Büroklammer: dasselbe – es isst das Bild und wertet es aus', JSON.stringify(medienG4));

    /* ------------------------------------------------ H. Werkzeuge */
    abschnitt('H · Die KI fragt zurück und trägt ein');
    gemini.weiter(antwort(
      B.text('Gern.'),
      B.aufruf('rueckfrage', { frage: 'Um wie viel Uhr?', optionen: ['10:00', '15:00'], mehrfach: false }, { signatur: 'sig_insel_frage' }),
      B.ende(),
    ));
    await fragen(p, 'Trag mir morgen den Zahnarzt ein.');
    const frageDa = await warteBis(() => p.locator('.insel-rueck', { hasText: 'Um wie viel Uhr?' }).count(), { timeout: 8000 });
    check(!!frageDa, 'Eine Rückfrage steht im Feld, mit Antworten zum Antippen');
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
    await foto(p, 'offen-dunkel');
    await p.locator('.insel-eintrag').last().locator('.insel-wirkung button').first().click();
    await p.waitForTimeout(700);
    check(p.url().includes(`#/kalender?id=${termin ? termin.id : 'x'}`), 'Antippen öffnet ihn im Kalender (und die Insel wird wieder klein)', p.url().replace(base, ''));
    await aufmachen(p);
    await p.locator('.insel-eintrag').last().locator('.insel-aktion', { hasText: 'Als Notiz' }).click();
    const alsNotiz = await warteBis(() => store.list('note', { limit: 100 }).items.find((n) => /Eingetragen: morgen/.test(n.data.body || '')), { timeout: 5000 });
    check(!!alsNotiz, '[Als Notiz] legt die Antwort als Notiz ab', alsNotiz ? alsNotiz.data.title : 'keine');

    /* ------------------------------------------------ I. Ueber allen Fenstern */
    abschnitt('I · Über allen Fenstern (Bild-im-Bild)');
    await aufmachen(p);
    await p.locator('.insel-eingabe button[aria-label="Mehr"]').click();
    const knopf = p.locator('.insel-menue button[aria-label^="Über allen Fenstern"]');
    check(await knopf.count() === 1, '„…“ → „Über allen Fenstern“ ist da (Chromium kann es)');
    const seitenVorher = c.pages().length;
    await knopf.click();
    const pip = await warteBis(() => c.pages().find((x) => x !== p), { timeout: 5000 });
    check(!!pip && c.pages().length === seitenVorher + 1, 'Ein eigenes, schwebendes Fenster geht auf');
    if (pip) {
      await pip.locator('.insel-feld').waitFor({ timeout: 4000 });
      const imFenster = await pip.evaluate(() => ({
        koerper: document.body.classList.contains('insel-fenster'),
        wesen: !!document.querySelector('.insel-panel__kopf .insel-wesen-knopf .wesen svg'),
        feld: !!document.querySelector('.insel-feld'),
        verlauf: document.querySelectorAll('.insel-eintrag').length,
      }));
      check(imFenster.koerper && imFenster.wesen && imFenster.feld && imFenster.verlauf > 0, 'Darin: das Wesen, das Feld und das bisherige Gespräch', JSON.stringify(imFenster));
      const daheim = (await p.locator('.insel-dock').innerText()).replace(/\s+/g, ' ');
      check(/Insel schwebt/.test(daheim), 'In Neural OS steht am Rand solange „Insel schwebt · zurückholen“', daheim);
      gemini.weiter(antwort(B.text('Aus dem schwebenden Fenster beantwortet.'), B.ende()));
      await pip.locator('.insel-feld').fill('Hörst du mich im Fenster?');
      await pip.locator('.insel-feld').press('Enter');
      const pipAntwort = await warteBis(async () => /schwebenden Fenster/.test(await pip.locator('.insel-antwort').last().innerText().catch(() => '')), { timeout: 8000 });
      check(!!pipAntwort, 'Fragen geht im schwebenden Fenster genauso');
      await pip.setViewportSize({ width: 440, height: 620 }).catch(() => {});
      await pip.waitForTimeout(300);
      await foto(pip, 'schwebendes-fenster');
      await pip.locator('button[aria-label="Kleiner"]').click();
      await pip.waitForTimeout(250);
      const klein = await pip.evaluate(() => ({
        klein: document.body.classList.contains('is-klein'),
        verlauf: getComputedStyle(document.querySelector('.insel-verlauf')).display,
        satz: document.querySelector('.insel-panel__satz').textContent,
      }));
      check(klein.klein && klein.verlauf === 'none' && klein.satz.length > 0, '[Kleiner]: nur noch das Wesen mit seiner Zeile', JSON.stringify(klein));
      await pip.setViewportSize({ width: 400, height: 96 }).catch(() => {});
      await pip.waitForTimeout(200);
      await foto(pip, 'schwebend-klein');
      await pip.locator('.insel-wesen-knopf').click();
      await pip.waitForTimeout(250);
      check(!(await pip.evaluate(() => document.body.classList.contains('is-klein'))), 'Das Wesen antippen: wieder groß');
      await pip.setViewportSize({ width: 440, height: 620 }).catch(() => {});
      await pip.locator('.insel-eintrag').last().locator('.insel-aktion', { hasText: 'Im Chat öffnen' }).click();
      await p.waitForTimeout(500);
      const chatId = (store.list('chat', { limit: 50 }).items.find((r) => /^Insel · /.test(r.data.title || '')) || {}).id;
      check(!!chatId && p.url().endsWith(`#/chat?id=${chatId}`), '„Im Chat öffnen“ öffnet den Insel-Chat in Neural OS', p.url().replace(base, ''));
      await pip.close();
      const zurueck = await warteBis(() => p.locator('.insel-dock .insel-wesen-knopf:visible').count(), { timeout: 4000 });
      check(!!zurueck && await p.locator('.insel-schwebt:visible').count() === 0, 'Fenster zu: das Wesen ist zurück am Rand');
      await aufmachen(p);
      check(await p.locator('.insel-eintrag').count() >= 3, 'und das Gespräch ist noch da');
      await zumachen(p);
    }

    /* ------------------------------------------------ J. Erinnerung */
    abschnitt('J · Termine: Erinnerung als Kapsel neben dem Wesen, „In 20 Min“ als Schild');
    await p.goto(`${base}/#/kalender`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    const bald = new Date(Date.now() + 10 * 60000);
    store.create('event', { title: 'Inselprobe', start: wandzeit(bald), end: wandzeit(new Date(bald.getTime() + 30 * 60000)), location: 'Flur', reminder: 15 });
    await store.flush();
    const kapsel = await warteBis(() => p.locator('.insel-dock .insel__kapseln .erin__card', { hasText: 'Inselprobe' }).count(), { timeout: 6000 });
    const kapselText = kapsel ? (await p.locator('.insel-dock .insel__kapseln .erin__card').first().innerText()).replace(/\s+/g, ' ') : '';
    check(!!kapsel && /In (9|10) Min/.test(kapselText), 'Eine Erinnerung hängt sich als Kapsel neben das Wesen', kapselText);
    await p.waitForTimeout(1200);
    const lageJ = await lageAmRand(p);
    check(lageJ.verdeckt.length === 0 && !seiteFalsch(lageJ).length && lageJ.frei === 'ganz', 'Wesen und Kapsel suchen sich eine freie Stelle – sie verdecken keinen Knopf (auch nicht den Sonntag im Kalender)',
      `${[...lageJ.verdeckt, ...seiteFalsch(lageJ)].join(', ') || 'nichts'} · Platz: ${lageJ.frei}`);
    const zeileJ = await p.evaluate(() => Math.round(document.querySelector('.insel-dock .erin__card').getBoundingClientRect().height));
    check(zeileJ <= 46, 'Neben dem Wesen ist die Erinnerung eine ruhige Zeile', `${zeileJ} px hoch`);
    check(!(await p.locator('.insel-dock .insel-schild', { hasText: 'Inselprobe' }).count()), 'Derselbe Termin steht nicht noch einmal als Schild da');
    await foto(p, 'erinnerung-kapsel', { clip: { x: 900, y: 300, width: 540, height: 400 } });
    await p.locator('.insel__kapseln button[aria-label="Erinnerung schließen"]').click();
    await p.waitForTimeout(300);
    check(await p.locator('.insel__kapseln .erin__card').count() === 0, '× schließt die Kapsel');
    await p.waitForTimeout(1200);
    check(!/Inselprobe/.test((await p.locator('.insel-dock').innerText()).replace(/\s+/g, ' ')), 'Weggeklickt heißt erledigt: der Termin kommt nicht als Schild zurück');
    const inZwanzig = new Date(Date.now() + 20 * 60000);
    store.create('event', { title: 'Rückruf Bank', start: wandzeit(inZwanzig), end: wandzeit(new Date(inZwanzig.getTime() + 15 * 60000)) });
    await store.flush();
    const terminSchild = await warteBis(async () => {
      const t = (await p.locator('.insel-dock .insel-schild[data-art="termin"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
      return /Rückruf Bank/.test(t) && /(20|19) Min/.test(t) ? t : null;
    }, { timeout: 6000 });
    check(!!terminSchild, 'Ein Termin in 20 Minuten steht als kleines Schild neben dem Wesen', terminSchild || (await p.locator('.insel-dock').innerText()));
    // Noch eine Frage mit Suche (auch hier im Kalender) -- sie muss nach dem Neuladen samt Quellen wiederkommen.
    await aufmachen(p);
    gemini.weiter(antwort(
      B.suche(['Museumsinsel Öffnungszeiten'], [{ url: 'https://museum.example/zeiten', titel: 'Museumsinsel – Öffnungszeiten' }], { text: 'Die Museen auf der Museumsinsel öffnen um 10 Uhr.' }),
      B.ende(),
    ));
    await fragen(p, 'Wann öffnet die Museumsinsel?');
    await warteBis(async () => /10 Uhr/.test(await letzteAntwort(p)), { timeout: 10000 });
    await zumachen(p);

    /* ------------------------------------------------ K. Neu laden */
    abschnitt('K · Neu laden');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1300);
    await aufmachen(p);
    const wieder = await warteBis(() => p.locator('.insel-eintrag').count(), { timeout: 5000 });
    check(wieder >= 3, 'Nach dem Neuladen zeigt die Insel das laufende Gespräch wieder', `${wieder} Fragen`);
    const sucheWieder = await p.evaluate(() => ({
      quelle: [...document.querySelectorAll('.insel-quelle')].some((a) => /Museumsinsel – Öffnungszeiten/.test(a.textContent)),
      schritt: [...document.querySelectorAll('.insel-schritt')].some((s) => /Gesucht: „Museumsinsel Öffnungszeiten“/.test(s.textContent)),
    }));
    check(sucheWieder.quelle && sucheWieder.schritt, 'samt Suchzeile und Quellen aus dem Tresor', JSON.stringify(sucheWieder));
    const timerWieder = (await p.locator('.insel-live').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/Tee/.test(timerWieder), 'und der Timer läuft weiter (nur in diesem Tab gemerkt)', timerWieder);
    const lokal = await p.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.includes('insel')).map((k) => [k.split(':').pop(), localStorage.getItem(k)])));
    check(!JSON.stringify(lokal).includes('Tee') && !JSON.stringify(lokal).includes('Zahnarzt') && /chat_/.test(lokal['insel-chat'] || ''),
      'Im Browser bleibt dauerhaft nur die Kennung des Chats – kein Inhalt', JSON.stringify(lokal).slice(0, 140));
    await menue(p, 'neu');
    await p.waitForTimeout(200);
    const leerWieder = await p.locator('.insel-leer').count();
    gemini.weiter(antwort(B.text('Neues Gespräch, neue Antwort.'), B.ende()));
    await fragen(p, 'Fangen wir neu an?');
    await warteBis(async () => /neue Antwort/.test(await letzteAntwort(p)), { timeout: 8000 });
    const zweiChats = store.list('chat', { limit: 50 }).items.filter((r) => /^Insel · /.test(r.data.title || '')).length;
    check(leerWieder === 1 && zweiChats === 2, '„…“ → Neues Gespräch – das alte bleibt unter „Zuletzt“', `${zweiChats} Insel-Chats`);
    await zumachen(p);
    await c.close();

    /* ------------------------------------------------ L. Live (wie Opera) */
    abschnitt('L · Live wie in Opera: zuhören, Stille, Gemini schreibt um, antworten, vorlesen, wieder zuhören');
    {
      const { c: c6, p: p6 } = await neueSeite({ mikro: true, stimme: true, erkennung: 'opera' });
      await p6.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p6.waitForTimeout(1200);
      await dismissWelcome(p6);
      await aufmachen(p6);
      await p6.waitForTimeout(400);
      gemini.weiterOhneStrom({ text: 'Wie spät ist es?' });
      gemini.weiter(langsam(160, B.text('Es ist halb drei. '), B.text('Noch etwas?'), B.ende()));
      const vorL = stromAnfragen().length;
      const ohneVorL = gemini.ohneStromAnfragen().length;
      await p6.locator('.insel-eingabe .insel-live-knopf').click();
      const hoert = await warteBis(async () => (await zustand(p6)) === 'hoert' && (await p6.evaluate(() => window.__mikro.offen)) >= 1, { timeout: 4000 });
      const satzL = await satz(p6);
      const liveL = await p6.evaluate(() => ({ an: !document.querySelector('.insel-live-an').hidden, gedrueckt: document.querySelector('.insel-live-knopf').getAttribute('aria-pressed'), erkennung: window.__erkennung.gestartet }));
      check(!!hoert && satzL === 'Ich höre zu …' && liveL.an && liveL.gedrueckt === 'true', 'Live an: Ohren hoch, „Ich höre zu …“, das Mikrofon ist offen', `${satzL} ${JSON.stringify(liveL)}`);
      await p6.waitForTimeout(300);
      await p6.evaluate(() => window.__mikro.sprechen(1600));
      await p6.waitForTimeout(700);
      const ring = await p6.evaluate(() => Number(getComputedStyle(document.querySelector('.insel-wesen-knopf .wesen')).getPropertyValue('--pegel')) || 0);
      check(ring > 0.3, 'Beim Sprechen atmet der Ring mit der echten Lautstärke (AnalyserNode)', `Pegel ${ring}`);
      await foto(p6, 'live-hoert');
      const versteht = await warteBis(async () => /denke/.test(await satz(p6)), { timeout: 6000, alle: 40 });
      check(!!versteht, 'Hört es auf (1,2 s Stille), denkt es: „Ich denke …“', await satz(p6));
      await warteBis(() => gemini.ohneStromAnfragen().length > ohneVorL, { timeout: 8000 });
      const wav = gemini.ohneStromAnfragen().slice(ohneVorL).map((a) => medienIn(a.body)).flat().find((m) => m.mime === 'audio/wav');
      check(!!wav && wav.bytes > 20000 && wav.bytes < 400000, 'Die Erkennung von Opera geht nicht – also nimmt es auf und Gemini schreibt die WAV um', JSON.stringify(wav));
      await warteBis(() => stromAnfragen().length > vorL, { timeout: 8000 });
      check(/Wie spät ist es\?/.test(nutzerText(stromAnfragen().slice(vorL)[0].body)), 'Das Gesagte geht als Frage los');
      const spricht = await warteBis(async () => /spreche/.test(await satz(p6)), { timeout: 8000, alle: 40 });
      check(!!spricht && (await zustand(p6)) === 'spricht', 'Die Antwort wird vorgelesen: „Ich spreche … – zum Unterbrechen tippen“', await satz(p6));
      const zuWaehrend = await p6.evaluate(() => window.__mikro.offen - window.__mikro.zu);
      check(zuWaehrend === 0, 'Während es spricht, ist das Mikrofon zu (es hört sich nicht selbst)', `${zuWaehrend} offen`);
      const wieder6 = await warteBis(async () => (await satz(p6)) === 'Ich höre zu …' && (await zustand(p6)) === 'hoert', { timeout: 8000, alle: 40 });
      const gesagt = await p6.evaluate(() => window.__gesprochen.join(' '));
      check(!!wieder6 && /Es ist halb drei/.test(gesagt), 'Fertig vorgelesen: es hört von selbst wieder zu – ein echtes Hin und Her', gesagt);
      // Zweite Runde: unterbrechen
      gemini.weiterOhneStrom({ text: 'Erzähl mir eine lange Geschichte.' });
      gemini.weiter(antwort(B.text('Es war einmal ein kleines Tier. Es wohnte am Rand eines Bildschirms. Jeden Tag half es einem Menschen. Am Abend schlief es ein.'), B.ende()));
      await p6.evaluate(() => { window.__stimme.ms = 1800; window.__mikro.sprechen(1500); });
      const spricht2 = await warteBis(async () => (await zustand(p6)) === 'spricht', { timeout: 12000, alle: 40 });
      await p6.waitForTimeout(400);
      await p6.locator('.insel-wesen-knopf').click();
      const unterbrochen = await warteBis(async () => (await zustand(p6)) === 'hoert', { timeout: 3000, alle: 40 });
      const stimmeL = await p6.evaluate(() => ({ abgebrochen: window.__stimme.abgebrochen, saetze: window.__gesprochen.length }));
      check(!!spricht2 && !!unterbrochen && stimmeL.abgebrochen >= 1, 'Antippen, während es spricht: es verstummt und hört sofort zu', JSON.stringify(stimmeL));
      await p6.keyboard.press('Escape');
      await p6.waitForTimeout(400);
      const aus6 = await p6.evaluate(() => ({ live: !document.querySelector('.insel-live-an').hidden, offen: window.__mikro.offen - window.__mikro.zu, panel: !document.getElementById('insel-panel').hidden }));
      check(!aus6.live && aus6.offen === 0 && aus6.panel, 'Esc: Live ist aus, das Mikrofon zu – das Feld bleibt offen', JSON.stringify(aus6));
      // Mikrofon verboten
      await p6.evaluate(() => { window.__mikro.verboten = true; });
      await p6.locator('.insel-eingabe .insel-live-knopf').click();
      const verboten = await warteBis(async () => /nicht erlaubt/.test(await p6.locator('.insel-hinweis').innerText().catch(() => '')), { timeout: 4000 });
      const nachVerbot = await p6.evaluate(() => ({ live: !document.querySelector('.insel-live-an').hidden, feld: !!document.querySelector('.insel-feld') }));
      check(!!verboten && !nachVerbot.live, 'Mikrofon nicht erlaubt: ein ehrlicher Satz, und es bleibt beim Tippen', (await p6.locator('.insel-hinweis').innerText().catch(() => '')).trim());
      await c6.close();
    }

    /* ------------------------------------------------ M. Live (wie Chrome) */
    abschnitt('M · Live mit der Spracherkennung des Browsers (Chrome)');
    {
      const { c: c7, p: p7 } = await neueSeite({ mikro: true, stimme: true, erkennung: 'chrome' });
      await p7.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p7.waitForTimeout(1200);
      await dismissWelcome(p7);
      await aufmachen(p7);
      gemini.weiter(antwort(B.text('Morgen wird es sonnig.'), B.ende()));
      const vorM = stromAnfragen().length;
      const ohneVorM = gemini.ohneStromAnfragen().length;
      await p7.locator('.insel-eingabe .insel-live-knopf').click();
      await warteBis(async () => (await zustand(p7)) === 'hoert', { timeout: 4000 });
      await p7.evaluate(() => window.__mikro.sprechen(1500));
      const zwischen = await warteBis(async () => /Wetter/.test(await p7.locator('.insel-panel__zwischen').innerText().catch(() => '')), { timeout: 3000, alle: 40 });
      check(!!zwischen, 'Während man spricht, steht das Erkannte unter dem Wesen', await p7.locator('.insel-panel__zwischen').innerText().catch(() => ''));
      await warteBis(() => stromAnfragen().length > vorM, { timeout: 8000 });
      check(/Wie wird das Wetter morgen\?/.test(nutzerText(stromAnfragen().slice(vorM)[0].body)) && gemini.ohneStromAnfragen().length === ohneVorM,
        'Nach der Stille geht der erkannte Satz los – ohne Umweg über Gemini');
      const wieder7 = await warteBis(async () => (await zustand(p7)) === 'hoert' && /sonnig/.test(await p7.evaluate(() => window.__gesprochen.join(' '))), { timeout: 8000, alle: 40 });
      check(!!wieder7, 'Vorgelesen – und es hört wieder zu');
      await p7.locator('.insel-live-an').click();
      await p7.waitForTimeout(300);
      check(await p7.evaluate(() => document.querySelector('.insel-live-an').hidden && window.__mikro.offen === window.__mikro.zu), 'Live oben antippen: aus');
      await c7.close();
    }

    /* ------------------------------------------------ N. Sprechen */
    abschnitt('N · Mikrofon (ohne Live): sprechen statt tippen – die Antwort wird vorgelesen');
    {
      const { c: c4, p: p4 } = await neueSeite({ erkennung: 'chrome', stimme: true, mikro: true });
      await p4.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p4.waitForTimeout(900);
      await dismissWelcome(p4);
      await aufmachen(p4);
      const mikro = p4.locator('.insel-eingabe button[aria-label="Sprechen"]');
      check(await mikro.isVisible(), 'Das Mikrofon ist da (der Browser kann erkennen)');
      await mikro.click();
      const hoert = await warteBis(async () => /Wie wird das Wetter/.test(await p4.locator('.insel-feld').inputValue()), { timeout: 4000 });
      check(!!hoert && (await zustand(p4)) === 'hoert', 'Während man spricht, steht der Text schon im Feld, und das Wesen hört zu');
      gemini.weiter(antwort(B.text('Morgen wird es sonnig. Bis zu 20 Grad.'), B.ende()));
      const vorN = stromAnfragen().length;
      await p4.locator('.insel-eingabe button[aria-label="Fertig gesprochen – senden"]').click();
      await warteBis(async () => /sonnig/.test(await letzteAntwort(p4)), { timeout: 8000 });
      check(/Wie wird das Wetter morgen\?/.test(nutzerText((stromAnfragen().slice(vorN)[0] || {}).body)), 'Mikrofon noch einmal antippen: die gesprochene Frage geht los');
      const gesagt = await warteBis(() => p4.evaluate(() => window.__gesprochen.join(' ')), { timeout: 4000 });
      check(/Morgen wird es sonnig/.test(gesagt || ''), 'Wer spricht, bekommt die Antwort vorgelesen', gesagt);
      await c4.close();
    }

    /* ------------------------------------------------ O. Groessen */
    abschnitt('O · Viele Größen: am Rand, nichts verdeckt, es wächst – aber nie über den ganzen Bildschirm');
    const groessen = [
      ['1440×900', 1440, 900, false],
      ['1280×800', 1280, 800, false],
      ['1024×768', 1024, 768, false],
      ['iPad quer', 1180, 820, true],
      ['iPad hoch', 820, 1180, true],
      ['Telefon', 390, 844, true],
    ];
    for (const [name, breite, hoehe, finger] of groessen) {
      const { c: c5, p: p5 } = await neueSeite({ breite, hoehe, finger });
      await p5.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p5.waitForTimeout(900);
      await dismissWelcome(p5);
      const probleme = [];
      const masse = [];
      for (const view of ['chat', 'kalender', 'notes', 'settings', 'projects']) {
        await p5.goto(`${base}/#/${view}`, { waitUntil: 'domcontentloaded' });
        await p5.waitForTimeout(1400);
        const l = await lageAmRand(p5);
        if (!l.da) { probleme.push(`${view}: kein Wesen`); continue; }
        if (l.verdeckt.length) probleme.push(`${view}: das Wesen verdeckt ${l.verdeckt.join(', ')}`);
        if (seiteFalsch(l).length) probleme.push(`${view}: die Schilder verdecken ${seiteFalsch(l).join(', ')}, obwohl Platz war`);
        if (l.aufComposer) probleme.push(`${view}: liegt auf dem Eingabefeld`);
        if (l.rechts < 8 || l.rechts > 24) probleme.push(`${view}: ${l.rechts} px vom Rand`);
        if (l.groesse < 52 || l.groesse > 64) probleme.push(`${view}: ${l.groesse} px groß`);
        if (l.spur && l.buehneRechts > l.links) probleme.push(`${view}: Spur, aber die Karte reicht unter das Wesen`);
        masse.push(`${view} y${l.mitteY}${l.spur ? ' Spur' : ''}${l.wegrollbar ? ` (${l.wegrollbar} wegrollbar)` : ''}${l.frei !== 'ganz' ? ` (Platz: ${l.frei}${l.seiteVerdeckt.length ? `, Kapsel liegt über ${l.seiteVerdeckt.length}` : ''})` : ''}`);
        if (view === 'chat' && breite < 600 && l.unten > 170) probleme.push(`Telefon: nicht unten rechts (${l.unten} px vom unteren Rand)`);
        if (view === 'chat') await foto(p5, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-zu`);
      }
      check(!probleme.length, `${name}: das Wesen sitzt am Rand und verdeckt nichts (Chat, Kalender, Notizen, Einstellungen, Projekte)`, probleme.join(' · ') || masse.join(', '));
      if (breite >= 1000 && breite < 1280) {
        const spur = await lageAmRand(p5);
        check(spur.spur && spur.buehneRechts <= spur.links, `${name}: rechte Spalte zu – das Wesen hat seine eigene Spur am Rand`, JSON.stringify({ karte: spur.buehneRechts, wesen: spur.links }));
      }
      await p5.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p5.waitForTimeout(900);
      if (finger) await p5.locator('.insel-dock .insel-wesen-knopf').tap();
      else await p5.locator('.insel-dock .insel-wesen-knopf').click();
      await panelOffen(p5).waitFor({ timeout: 4000 });
      await p5.waitForTimeout(600);
      const pm = await panelMasse(p5);
      const schrift = await p5.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.insel-feld')).fontSize));
      const ueber = await p5.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (breite < 600) {
        check(pm.art === 'blatt' && pm.l === 0 && pm.r === 0 && pm.u <= 1 && Math.abs(pm.h - Math.round(hoehe * 0.85)) <= 2 && schrift >= 16 && ueber <= 0,
          `${name}: ein Blatt von unten (85 % hoch), Eingabe ≥ 16 px (kein Hineinzoomen)`, JSON.stringify({ ...pm, schrift }));
      } else {
        check(pm.art === 'feld' && pm.b <= 420 && pm.b < breite * 0.5 && pm.h <= hoehe * 0.8 + 1 && pm.r >= 12 && pm.r <= 20 && pm.wesenDrin && ueber <= 0 && (!finger || schrift >= 16),
          `${name}: ein Feld am rechten Rand (${pm.b}×${pm.h}) – nie der ganze Bildschirm`, JSON.stringify(pm));
      }
      if (name === 'Telefon' || name === 'iPad quer' || name === '1024×768') await foto(p5, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-offen`);
      if (finger) {
        const fingerGross = await p5.evaluate(() => [...document.querySelectorAll('.insel-eingabe button')].filter((b) => b.offsetWidth).every((b) => b.getBoundingClientRect().height >= 44));
        check(fingerGross, `${name}: jeder Knopf der Eingabe ist mindestens 44 px hoch (Finger)`);
      }
      await c5.close();
    }

    /* ------------------------------------------------ P. Hell und die Zustaende */
    abschnitt('P · Hell und dunkel; jeder Zustand des Wesens');
    {
      const { c: c8, p: p8 } = await neueSeite({ design: 'light' });
      await p8.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p8.waitForTimeout(1200);
      await dismissWelcome(p8);
      await foto(p8, 'hell-zu');
      await aufmachen(p8);
      gemini.weiter(antwort(
        B.suche(['Öffnungszeiten Stadtbibliothek'], [{ url: 'https://bibliothek.example/zeiten', titel: 'Stadtbibliothek – Öffnungszeiten' }], { text: 'Die Stadtbibliothek hat heute bis 19 Uhr geöffnet.' }),
        B.ende(),
      ));
      await fragen(p8, 'Wie lange hat die Bibliothek heute offen?');
      await warteBis(async () => /19 Uhr/.test(await letzteAntwort(p8)), { timeout: 10000 });
      await p8.waitForTimeout(1900);
      const hell = await p8.evaluate(() => {
        const panel = getComputedStyle(document.getElementById('insel-panel')).backgroundColor;
        const leib = getComputedStyle(document.querySelector('.insel-wesen-knopf .wesen')).getPropertyValue('--w-hell').trim();
        return { panel, leib };
      });
      check(hell.panel === 'rgb(255, 255, 255)' && /^#4/.test(hell.leib), 'Im hellen Design: helles Feld, dunkles Wesen (die Farben der App)', JSON.stringify(hell));
      await foto(p8, 'offen-hell');
      // Alle Zustaende nebeneinander (dasselbe Modul wie die Insel).
      await p8.evaluate(async () => {
        const m = await import('/lib/insel-wesen.js');
        const box = document.createElement('div');
        box.id = 'galerie';
        box.style.cssText = 'position:fixed;inset:0;z-index:20000;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,1fr);gap:10px;padding:24px;background:#090a0a;font:13px system-ui';
        for (const hellDunkel of ['dunkel', 'hell']) {
          for (const z of ['ruht', 'hoert', 'denkt', 'spricht', 'frisst', 'freut', 'verwirrt', 'schlaeft']) {
            const w = m.wesenErschaffen();
            w.zustand(z);
            if (z === 'hoert') w.pegel(0.75);
            const zelle = document.createElement('div');
            zelle.style.cssText = `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;border-radius:18px;${hellDunkel === 'hell' ? 'background:#fff;color:#15161a' : 'background:#161719;color:#eeeef0'}`;
            // Dieselben Farben wie in web/lib/insel-wesen.js -- hier je Zelle, weil beide Designs auf einem Bild stehen.
            const farben = hellDunkel === 'hell'
              ? { '--w-hell': '#44464d', '--w-dunkel': '#0e0f12', '--w-auge': '#ffffff', '--w-glanz': '#121316', '--w-innen': '#5c5f68', '--w-maul': '#000', '--w-bauch': 'rgba(255,255,255,0.07)', '--w-schatten': 'rgba(16,18,24,0.22)' }
              : { '--w-hell': '#f6f6f8', '--w-dunkel': '#c7c8cf', '--w-auge': '#0c0d0f', '--w-glanz': '#ffffff', '--w-innen': '#d9dae0', '--w-maul': '#17181b', '--w-bauch': 'rgba(255,255,255,0.32)', '--w-schatten': 'rgba(0,0,0,0.55)' };
            for (const [k, v] of Object.entries(farben)) w.el.style.setProperty(k, v);
            const platz = document.createElement('div');
            platz.style.cssText = 'width:84px;height:84px;position:relative';
            platz.appendChild(w.el);
            const t = document.createElement('div');
            t.textContent = { ruht: 'ruht', hoert: 'hört zu', denkt: 'denkt', spricht: 'spricht', frisst: 'frisst', freut: 'freut sich', verwirrt: 'verwirrt', schlaeft: 'schläft' }[z];
            zelle.append(platz, t);
            box.appendChild(zelle);
          }
        }
        document.body.appendChild(box);
      });
      await p8.waitForTimeout(700);
      await foto(p8, 'zustaende');
      const zustaende = await p8.evaluate(() => [...document.querySelectorAll('#galerie .wesen')].map((w) => w.dataset.zustand));
      check(zustaende.length === 16 && new Set(zustaende).size === 8, 'Acht Zustände, jeder mit eigener Haltung (Bild „zustaende“)', zustaende.slice(0, 8).join(', '));
      await c8.close();
    }

    /* ------------------------------------------------ Q. Weniger Bewegung */
    abschnitt('Q · Weniger Bewegung: jede Haltung bleibt, nichts bewegt sich');
    {
      const c9 = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', colorScheme: 'dark', serviceWorkers: 'block' });
      const p9 = await c9.newPage();
      p9.on('pageerror', (e) => konsole.push(`pageerror: ${e.message}`));
      await p9.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p9.waitForTimeout(1200);
      await dismissWelcome(p9);
      const ruhig = await p9.evaluate(() => {
        const w = document.querySelector('.insel-wesen-knopf .wesen');
        const laufend = [...w.querySelectorAll('*')].filter((n) => {
          const cs = getComputedStyle(n);
          return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01;
        }).length;
        return { laufend };
      });
      check(ruhig.laufend === 0, 'Mit „weniger Bewegung“ läuft am Wesen keine Animation', JSON.stringify(ruhig));
      await c9.close();
    }

    /* ------------------------------------------------ R. Neural OS ist aus */
    abschnitt('R · Neural OS ist aus: nichts schwebt mehr, das Wesen schläft');
    {
      const { c: c3, p: p3 } = await neueSeite();
      await p3.goto(`${base}/#/chat`, { waitUntil: 'domcontentloaded' });
      await p3.waitForTimeout(900);
      await dismissWelcome(p3);
      await aufmachen(p3);
      await menue(p3, 'schweben');
      const pip3 = await warteBis(() => c3.pages().find((x) => x !== p3), { timeout: 5000 });
      check(!!pip3, 'Die Insel schwebt …');
      // Der Server geht weg (wie nach [Beenden] oder wenn der Stick gezogen wird).
      await app.close();
      appZu = true;
      const zu3 = await warteBis(() => c3.pages().length === 1, { timeout: 12000 });
      await p3.waitForTimeout(400);
      const aus3 = await p3.evaluate(() => {
        const k = document.querySelector('.insel-dock .insel-wesen-knopf');
        return {
          aus: !!document.getElementById('aus'),
          zustand: k ? k.querySelector('.wesen').dataset.zustand : null,
          gesperrt: k ? k.disabled : null,
          sichtbar: k ? k.getBoundingClientRect().width > 0 : false,
          schilder: getComputedStyle(document.querySelector('.insel-dock__seite')).display,
        };
      });
      check(!!zu3 && aus3.aus && aus3.zustand === 'schlaeft' && aus3.gesperrt === true && aus3.sichtbar && aus3.schilder === 'none',
        '… bis Neural OS aus ist: das schwebende Fenster geht zu, das Wesen schläft am Rand („zzz“, nicht antippbar) – ohne Schilder, die nicht mehr stimmen', JSON.stringify(aus3));
      await foto(p3, 'aus-schlaeft');
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
  // trotzdem -- die Meldung stammt vom Browser, nicht von der App. Ein
  // abgelehnter Probeaufruf an den Statisten (Abschnitt C) meldet der Browser
  // als "Failed to load resource".
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
