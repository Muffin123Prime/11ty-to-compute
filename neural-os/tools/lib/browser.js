'use strict';

/**
 * Playwright und Chromium finden -- ohne etwas herunterzuladen.
 *
 * Neural OS selbst hat null Abhaengigkeiten und behaelt sie. Die Werkzeuge in
 * tools/, die einen echten Browser brauchen, sind kein Teil der Anwendung: sie
 * suchen ein global installiertes Playwright und sagen ehrlich, dass sie nichts
 * geprueft haben, wenn keines da ist. Beide Funktionen standen frueher doppelt
 * in ui-check.js und im Bildschirmfoto-Werkzeug; doppelter Suchpfad heisst
 * frueher oder spaeter zwei verschiedene Suchpfade.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Der Pfad zu einem global installierten Playwright, oder null. */
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

/**
 * Ein bereits vorhandener Chromium. Null bedeutet: Playwright soll selbst
 * entscheiden -- nicht, dass einer heruntergeladen werden soll.
 */
function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
    path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    // Erst die vollstaendige Fassung, dann die Sparfassung: alphabetisch
    // stuende `chromium_headless_shell-1194` vor `chromium-1194`, und dann
    // liefe alles in der Huelle ohne Oberflaechenteile.
    const gefunden = entries.filter((e) => e.startsWith('chromium'));
    const sortiert = [
      ...gefunden.filter((e) => /^chromium-/.test(e)).sort().reverse(),
      ...gefunden.filter((e) => !/^chromium-/.test(e)).sort().reverse(),
    ];
    for (const entry of sortiert) {
      for (const rel of [['chrome-linux', 'chrome'], ['chrome-linux', 'headless_shell'],
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]) {
        const full = path.join(root, entry, ...rel);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return null;
}

module.exports = { findPlaywright, findChromium };
