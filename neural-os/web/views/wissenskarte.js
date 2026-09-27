/**
 * views/wissenskarte.js -- die ruhige Themenkarte, Unteransicht des Gehirns.
 *
 * Nicht wie der Graph: keine Physik, keine Linien, kein Zoom. Eine Karte
 * zum Lesen -- MEIN WISSEN, darunter die grossen Themen als ruhige Kacheln,
 * antippen fuehrt tiefer (SCHULE -> BIOLOGIE -> ZELLEN, DNA ...), und in
 * einem Thema stehen seine Eintraege als Liste. Sie nutzt dieselben Daten
 * wie das Universum (GET /api/graph/universum), damit beide Ansichten
 * dieselbe Ordnung zeigen; geladen wird ueber die Funktionen, die das
 * Gehirn hereinreicht (und dort zwischenspeichert).
 *
 * Schnittstelle: createWissenskarte(el, {ctx, ladeUniversum, ladeThema,
 * onThema, onKnoten, onOeffnen}) -> {zeige(themaId), aktualisieren(), destroy()}
 */

import { h, text, clear, icon, formatNumber, timeAgo } from '../lib/dom.js';
import { THEME_HUES } from '../lib/graph-canvas.js';
import { WURZEL_NAME, artVon, brotkrumen } from '../lib/universum.js';

const STYLE_ID = 'nos-wissenskarte-style';
const CSS = `
.wk { min-height: 100%; padding: 20px 24px 40px; }
.wk__inner { max-width: 880px; margin: 0 auto; }
.wk__crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin: 0 0 18px -8px; }
.wk__crumb {
  display: inline-flex; align-items: center; min-height: 32px; padding: 0 8px; border: 0; border-radius: var(--r-1);
  background: none; color: var(--fg-muted); font: inherit; font-size: var(--fs-base); cursor: pointer;
}
.wk__crumb:hover { background: var(--surface-3); color: var(--fg); }
.wk__crumb[aria-current="page"] { color: var(--fg); font-weight: 500; cursor: default; }
.wk__crumb[aria-current="page"]:hover { background: none; }
.wk__sep { color: var(--fg-subtle); font-size: var(--fs-sm); }
.wk__head { display: flex; align-items: flex-start; gap: var(--sp-2); margin-bottom: 22px; }
.wk__head-main { flex: 1 1 auto; min-width: 0; }
.wk__title { margin: 0; font-size: var(--fs-2xl); font-weight: 500; letter-spacing: -0.015em; line-height: var(--lh-tight); overflow-wrap: anywhere; }
.wk__sub { margin: 6px 0 0; color: var(--fg-muted); font-size: var(--fs-base); }
.wk__head .btn { flex: none; margin-top: 4px; }
.wk__label { margin: 0 0 10px; color: var(--fg-subtle); font-size: var(--fs-sm); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
.wk__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-bottom: 28px; }
.wk__tile {
  display: flex; flex-direction: column; align-items: flex-start; gap: 10px; min-height: 104px; padding: 14px 14px 12px;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-3);
  color: var(--fg); font: inherit; text-align: left; cursor: pointer;
  transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), transform var(--dur-2) var(--ease);
}
.wk__tile:hover { background: var(--surface-3); border-color: var(--border-strong); }
.wk__tile:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: 2px; }
.wk__tile-dot { width: 12px; height: 12px; border-radius: 50%; }
.wk__tile-name { font-size: var(--fs-md); font-weight: 500; line-height: var(--lh-tight); overflow-wrap: anywhere; }
.wk__tile-n { margin-top: auto; color: var(--fg-subtle); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.wk__tile-kinder { color: var(--fg-subtle); font-size: var(--fs-xs); }
.wk__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
.wk__row { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--border); }
.wk__row-main {
  display: flex; align-items: center; gap: 12px; flex: 1 1 auto; min-width: 0; min-height: 48px; padding: 8px 6px 8px 2px;
  background: none; border: 0; color: var(--fg); font: inherit; text-align: left; cursor: pointer; border-radius: var(--r-1);
}
.wk__row-main:hover { background: var(--surface-2); }
.wk__row-main:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: -2px; }
.wk__row-art { flex: none; width: 64px; color: var(--fg-subtle); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.wk__row-text { flex: 1 1 auto; min-width: 0; }
.wk__row-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk__row-sub { display: block; color: var(--fg-subtle); font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk__row-n { flex: none; color: var(--fg-subtle); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.wk__row .icon-button { width: 36px; height: 36px; }
.wk__row .icon-button svg { width: 16px; height: 16px; }
.wk__state { padding: 40px 0; color: var(--fg-muted); text-align: center; }
.wk__state .gh__state-title { margin-bottom: 8px; }
.wk__more { margin-top: 12px; }
@media (pointer: coarse) { .wk__row-main { min-height: 52px; } .wk__crumb { min-height: 40px; } }
@media (max-width: 760px) { .wk { padding: 14px 16px 32px; } .wk__row-art { display: none; } }
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const MAX_ZEILEN = 120;

function farbeCss(index) {
  return `color-mix(in srgb, ${THEME_HUES[index] || THEME_HUES[0]} 55%, var(--fg-muted))`;
}

export function createWissenskarte(el, hooks) {
  ensureStyle();
  const { ladeUniversum, ladeThema, onThema, onKnoten, onOeffnen } = hooks;
  let alive = true;
  let token = 0;
  let themaId = null; // null = die Wurzel
  let zeigeAlle = false;
  const inner = h('div.wk__inner');
  const root = h('div.wk', null, inner);
  el.appendChild(root);

  function kachel(t, { onClick }) {
    return h('button.wk__tile', { type: 'button', onClick, title: `${t.name} öffnen` },
      h('span.wk__tile-dot', { style: { background: farbeCss(t.farbe) } }),
      h('span.wk__tile-name', null, text(t.name)),
      t.kinder && t.kinder.length ? h('span.wk__tile-kinder', null, text(t.kinder.slice(0, 3).map((k) => k.name).join(' · ') + (t.kinder.length > 3 ? ' …' : ''))) : null,
      h('span.wk__tile-n', null, text(`${formatNumber(t.anzahl)} ${t.anzahl === 1 ? 'Eintrag' : 'Einträge'}`)));
  }

  function krumen(liste) {
    const nav = h('nav.wk__crumbs', { 'aria-label': 'Pfad in der Karte' });
    // An der Wurzel steht der Name schon als Ueberschrift: kein Pfad aus einem Wort.
    if (liste.length < 2) nav.hidden = true;
    liste.forEach((k, i) => {
      const letzte = i === liste.length - 1;
      if (i > 0) nav.appendChild(h('span.wk__sep', { 'aria-hidden': 'true' }, text('›')));
      nav.appendChild(h('button.wk__crumb', {
        type: 'button', 'aria-current': letzte ? 'page' : null, onClick: () => { if (!letzte) zeige(k.id); },
      }, text(k.name)));
    });
    return nav;
  }

  function zustand(satz) {
    clear(inner);
    inner.appendChild(h('div.wk__state', null, h('p.gh__state-text', null, text(satz))));
  }

  async function renderWurzel(my) {
    let u;
    try {
      u = await ladeUniversum();
    } catch (err) {
      if (!alive || my !== token) return;
      zustand(`Die Karte konnte nicht geladen werden: ${err && err.message ? err.message : 'unbekannter Fehler'}`);
      return;
    }
    if (!alive || my !== token) return;
    clear(inner);
    if (!u || !u.themen.length) {
      inner.append(krumen([{ id: null, name: WURZEL_NAME }]),
        h('div.wk__state', null,
          h('p.gh__state-title', null, text(u && u.gesamt.knoten ? 'Noch keine Themen.' : 'Dein Wissensuniversum wartet.')),
          h('p.gh__state-text', null, text(u && u.gesamt.knoten ? 'Themen entstehen aus #Schlagworten, Projekten und Verbindungen zwischen Einträgen.' : 'Erstelle deine erste Notiz oder importiere vorhandenes Wissen.'))));
      return;
    }
    inner.append(
      krumen([{ id: null, name: WURZEL_NAME }]),
      h('header.wk__head', null,
        h('div.wk__head-main', null,
          h('h2.wk__title', null, text(WURZEL_NAME)),
          h('p.wk__sub', null, text(`${formatNumber(u.gesamt.themen)} Themen · ${formatNumber(u.gesamt.knoten)} Einträge · ${formatNumber(u.gesamt.kanten)} Verbindungen`))),
        h('button.btn.btn--ghost', { type: 'button', onClick: () => onThema(null) }, text('Im Universum zeigen'))),
      h('p.wk__label', null, text('Themen')),
      h('div.wk__grid', null, ...u.themen.map((t) => kachel(t, { onClick: () => zeige(t.id) }))));
  }

  async function renderThema(my, id) {
    let e1;
    try {
      e1 = await ladeThema(id);
    } catch (err) {
      if (!alive || my !== token) return;
      if (err && err.status === 404) {
        themaId = null;
        renderWurzel(my);
        return;
      }
      zustand(`Das Thema konnte nicht geladen werden: ${err && err.message ? err.message : 'unbekannter Fehler'}`);
      return;
    }
    if (!alive || my !== token) return;
    const t = e1.thema;
    const innen = e1.nodes.filter((n) => !n.ausserhalb).sort((a, b) => ((b.grad || 0) - (a.grad || 0)) || String(a.label).localeCompare(String(b.label), 'de'));
    const gezeigt = zeigeAlle ? innen : innen.slice(0, MAX_ZEILEN);
    clear(inner);
    inner.append(
      krumen(brotkrumen(e1.pfad, t)),
      h('header.wk__head', null,
        h('div.wk__head-main', null,
          h('h2.wk__title', null, text(t.name)),
          h('p.wk__sub', null, text([
            `${formatNumber(innen.length)} ${innen.length === 1 ? 'Eintrag' : 'Einträge'}`,
            t.kinder.length ? `${formatNumber(t.kinder.length)} Unterthemen` : null,
            `${formatNumber(e1.edges.length)} Verbindungen`,
          ].filter(Boolean).join(' · ')))),
        h('button.btn.btn--ghost', { type: 'button', onClick: () => onThema(t.id) }, text('Im Universum zeigen'))));
    if (t.kinder.length) {
      inner.append(h('p.wk__label', null, text('Unterthemen')),
        h('div.wk__grid', null, ...t.kinder.map((k) => kachel(k, { onClick: () => zeige(k.id) }))));
    }
    inner.append(h('p.wk__label', null, text('Einträge')));
    if (!innen.length) {
      inner.append(h('p.gh__state-text', null, text('Dieses Thema hat noch keine Einträge.')));
      return;
    }
    inner.append(h('ul.wk__list', null, ...gezeigt.map((node) => h('li.wk__row', null,
      h('button.wk__row-main', { type: 'button', title: 'Im Universum zeigen', onClick: () => onKnoten(node, t.id) },
        h('span.wk__row-art', null, text(artVon(node))),
        h('span.wk__row-text', null,
          h('span.wk__row-title', null, text(node.label)),
          h('span.wk__row-sub', null, text([
            node.tags && node.tags.length ? node.tags.slice(0, 4).map((x) => `#${String(x).replace(/^#/, '')}`).join(' ') : null,
            node.updatedAt ? timeAgo(node.updatedAt) : null,
          ].filter(Boolean).join(' · ')))),
        h('span.wk__row-n', null, text(node.grad ? `${formatNumber(node.grad)} ${node.grad === 1 ? 'Verbindung' : 'Verbindungen'}` : ''))),
      h('button.icon-button', { type: 'button', title: 'Öffnen', 'aria-label': `${node.label} öffnen`, onClick: () => onOeffnen(node) },
        icon('<path d="M4 10h11M11 6l4 4-4 4"/>'))))));
    if (innen.length > gezeigt.length) {
      inner.append(h('button.btn.btn--ghost.wk__more', { type: 'button', onClick: () => { zeigeAlle = true; renderThema(++token, id); } },
        text(`Alle ${formatNumber(innen.length)} Einträge zeigen`)));
    }
  }

  function zeige(id) {
    if (!alive) return;
    themaId = id || null;
    zeigeAlle = false;
    const my = ++token;
    root.scrollTop = 0;
    if (el.scrollTop) el.scrollTop = 0;
    if (!inner.firstChild) zustand('Die Karte wird geladen …');
    if (themaId) renderThema(my, themaId);
    else renderWurzel(my);
  }

  return {
    zeige,
    aktualisieren() {
      if (!alive || el.hidden) return;
      const my = ++token;
      if (themaId) renderThema(my, themaId);
      else renderWurzel(my);
    },
    get thema() { return themaId; },
    destroy() {
      alive = false;
      token++;
      clear(el);
    },
  };
}

export default { createWissenskarte };
