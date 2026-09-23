'use strict';

/**
 * Die Symbole fuer den Startbildschirm erzeugen.
 *
 *   node tools/make-icons.js
 *
 * Warum es dieses Werkzeug gibt und warum die Ergebnisse eingecheckt sind
 * ----------------------------------------------------------------------
 * iOS legt beim "Zum Home-Bildschirm" nur dann ein richtiges App-Symbol an,
 * wenn eine PNG-Datei dafuer da ist -- ein SVG nimmt es an dieser Stelle nicht.
 * Neural OS hat aber null Abhaengigkeiten und darf zur Laufzeit nichts
 * rastern. Also wird EINMAL hier gerastert und das Ergebnis eingecheckt: die
 * Anwendung liefert danach fertige Dateien aus und braucht dieses Werkzeug nie.
 *
 * Gerastert wird mit dem Chromium, den auch tools/ui-check.js benutzt. Er ist
 * kein Teil der Anwendung, sondern Werkzeug -- fehlt er, sagt das Programm das
 * und tut nichts, statt ein kaputtes Symbol zu hinterlassen.
 */

const fs = require('node:fs');
const path = require('node:path');
const { findPlaywright, findChromium } = require('./lib/browser');

const OUT = path.join(__dirname, '..', 'web', 'icons');

/**
 * Die Bildmarke der Anwendung, identisch mit ICONS.brand in web/app.js: eine
 * Umlaufbahn und ein Knoten in ihrer Mitte, der ueber den Rand hinaus eine
 * Verbindung haelt. Sie steht hier ein zweites Mal, weil dieses Werkzeug ohne
 * Browser-Module laeuft und web/app.js ein ES-Modul ist. Aendert sich die
 * Marke dort, gehoert sie hier nachgezogen -- ein Test wacht darueber.
 *
 * Die beiden Knoten sind gefuellt (fill="currentColor"); deshalb setzt die
 * Seite unten `color` auf die Strichfarbe.
 */
const MARK = '<path d="M16.2 7.1A6.8 6.8 0 1 1 12.9 3.8"/><path d="M11.6 8.4 13.6 6.4"/>'
  + '<circle cx="14.8" cy="5.2" r="1.5" fill="currentColor" stroke="none"/>'
  + '<circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none"/>';

/** Der Grund der Oberflaeche (--surface) mit der hellen Marke (--fg). */
const GRUND = '#101112';
const STRICH = '#eeeef0';

/**
 * `padding` ist der Anteil des Randes. Ein gewoehnliches Symbol bekommt wenig,
 * ein `maskable` viel: Android schneidet daraus einen Kreis, und was im
 * aeusseren Fuenftel liegt, ist dann weg.
 */
const SYMBOLE = [
  // Ohne eigene Rundung: iOS legt seine eigene Maske darueber, und zwei
  // Rundungen uebereinander ergeben einen sichtbar eingedellten Rand.
  { datei: 'icon-180.png', groesse: 180, padding: 0.20, rund: 0 },
  { datei: 'icon-192.png', groesse: 192, padding: 0.20, rund: 0.22 },
  { datei: 'icon-512.png', groesse: 512, padding: 0.20, rund: 0.22 },
  { datei: 'icon-maskable-512.png', groesse: 512, padding: 0.30, rund: 0 },
];

function seite({ groesse, padding, rund }) {
  const innen = groesse * (1 - 2 * padding);
  const rand = groesse * padding;
  const radius = rund ? `${groesse * rund}px` : '0';
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    .feld{width:${groesse}px;height:${groesse}px;background:${GRUND};border-radius:${radius};
          display:flex;align-items:center;justify-content:center}
    svg{width:${innen}px;height:${innen}px;color:${STRICH}}
  </style><div class="feld"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"
    fill="none" stroke="${STRICH}" stroke-width="1.5" stroke-linecap="round"
    >${MARK}</svg></div><!-- Rand ${rand} -->`;
}

async function main() {
  const pwPath = findPlaywright();
  if (!pwPath) {
    console.error('Playwright ist nicht installiert — es wurde nichts erzeugt.');
    console.error('Neural OS braucht es nicht; dieses Werkzeug schon: npm i -g playwright');
    process.exit(2);
  }
  const { chromium: pw } = await import(pwPath);
  const chromium = findChromium();
  const browser = await pw.launch(chromium ? { executablePath: chromium } : {});
  fs.mkdirSync(OUT, { recursive: true });

  for (const symbol of SYMBOLE) {
    const context = await browser.newContext({
      viewport: { width: symbol.groesse, height: symbol.groesse },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent(seite(symbol));
    await page.waitForTimeout(80);
    const ziel = path.join(OUT, symbol.datei);
    await page.locator('.feld').screenshot({ path: ziel, omitBackground: true });
    const { size } = fs.statSync(ziel);
    console.log(`  ${symbol.datei.padEnd(24)} ${symbol.groesse}x${symbol.groesse}  ${size} Bytes`);
    await context.close();
  }

  await browser.close();
  console.log(`\n${SYMBOLE.length} Symbole in ${OUT}`);
}

main().catch((err) => {
  console.error('Das Werkzeug ist gescheitert:', err && err.message);
  process.exit(2);
});
