/**
 * bausteine/mehr.js -- Vertiefung auf Wunsch.
 *
 * Zeigt erst nichts als [Mehr anzeigen]; dann den Inhalt und [Weniger].
 * Fuer das, was nicht jeder lesen will: Herleitung, Hintergrund, Details.
 */

import { h, text } from '../dom.js';
import { str, strPflicht, LAENGE, sym, ensureStyle } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-mehr';

function pruefen(roh) {
  const out = { inhalt: strPflicht(roh.inhalt, 'inhalt', LAENGE.inhalt) };
  const k = str(roh.knopf, 60);
  if (k) out.knopf = k;
  return out;
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const a = b.ansicht;
  const id = b.key('inhalt').replace(/[^A-Za-z0-9_-]/g, '_');
  const umschalten = (e) => {
    e.stopPropagation();
    a.auf = !a.auf;
    b.neuZeichnen();
  };
  if (!a.auf) {
    return h('div.bs-mehr', null, h('button.bs-mehr__knopf', {
      type: 'button', 'aria-expanded': 'false', 'aria-controls': id, 'data-key': b.key('knopf'), onClick: umschalten,
    }, h('span', null, text(spec.knopf || 'Mehr anzeigen')), sym('runter')));
  }
  return h('div.bs-mehr.is-auf', null,
    h('div.bs-mehr__inhalt', { id }, b.markdown(spec.inhalt, { ui: true })),
    h('button.bs-mehr__knopf', {
      type: 'button', 'aria-expanded': 'true', 'aria-controls': id, 'data-key': b.key('knopf'), onClick: umschalten,
    }, h('span', null, text('Weniger')), sym('runter')));
}

export const typen = {
  mehr: { pruefen, render, flach: true, text: (s) => s.inhalt },
};

const CSS = `
.bs-mehr__knopf { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 12px 0 14px; font: inherit; font-size: var(--fs-base); font-weight: 500; color: var(--accent-text); background: none; border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: var(--r-full); cursor: pointer; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }
.bs-mehr__knopf:hover { background: var(--accent-soft); border-color: var(--accent); }
.bs-mehr__knopf:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-mehr__knopf svg { width: 15px; height: 15px; transition: transform var(--dur-3) var(--ease); }
.bs-mehr.is-auf .bs-mehr__knopf svg { transform: rotate(180deg); }
.bs-mehr__inhalt { margin-bottom: 10px; padding-left: 14px; border-left: 2px solid var(--border-strong); animation: bs-ein var(--dur-3) var(--ease); }
@media (pointer: coarse) { .bs-mehr__knopf { min-height: var(--tap-min); padding: 0 16px 0 18px; } }
`;
