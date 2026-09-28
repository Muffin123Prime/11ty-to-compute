/**
 * bausteine/tabs.js -- Reiter innerhalb einer Antwort.
 *
 * Fuer Varianten desselben Inhalts (Windows / macOS / Linux, Anfaenger /
 * Profi). Tastatur nach dem ARIA-Muster: Pfeile wechseln den Reiter, Pos1
 * und Ende springen an den Rand; der Inhalt ist ein tabpanel.
 */

import { h, text, cx } from '../dom.js';
import { str, strPflicht, liste, objekt, LAENGE, inline, ensureStyle, perKey } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-tabs';

function pruefen(roh) {
  return {
    tabs: liste(roh.tabs, 'tabs', {
      min: 2,
      max: 8,
      je: (x, i) => {
        const o = objekt(x);
        if (!o) return null;
        return { titel: strPflicht(o.titel, `tabs[${i}].titel`, 60), inhalt: str(o.inhalt, LAENGE.inhalt) };
      },
    }),
  };
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const a = b.ansicht;
  const n = spec.tabs.length;
  const aktiv = Number.isInteger(a.aktiv) && a.aktiv < n ? a.aktiv : 0;
  const basis = b.key('t').replace(/[^A-Za-z0-9_-]/g, '_');
  const waehle = (i, fokus) => {
    a.aktiv = (i + n) % n;
    b.neuZeichnen();
    if (fokus) {
      const el = perKey(b.key(`tab:${a.aktiv}`), b.huelle());
      if (el) el.focus();
    }
  };
  const leiste = h('div.bs-tabs__leiste', {
    role: 'tablist',
    onKeydown: (e) => {
      const k = e.key;
      if (k === 'ArrowRight') { e.preventDefault(); waehle(aktiv + 1, true); }
      else if (k === 'ArrowLeft') { e.preventDefault(); waehle(aktiv - 1, true); }
      else if (k === 'Home') { e.preventDefault(); waehle(0, true); }
      else if (k === 'End') { e.preventDefault(); waehle(n - 1, true); }
    },
  });
  spec.tabs.forEach((t, i) => {
    leiste.appendChild(h('button', {
      type: 'button',
      class: cx('bs-tab', { 'is-aktiv': i === aktiv }),
      role: 'tab',
      id: `${basis}_${i}`,
      'aria-selected': String(i === aktiv),
      'aria-controls': `${basis}_panel`,
      tabindex: i === aktiv ? '0' : '-1',
      'data-key': b.key(`tab:${i}`),
      onClick: (e) => { e.stopPropagation(); waehle(i, false); },
    }, inline(t.titel, { ohneLinks: true })));
  });
  const t = spec.tabs[aktiv];
  return h('div.bs-tabs', null, leiste,
    h('div.bs-tabs__panel', { role: 'tabpanel', id: `${basis}_panel`, 'aria-labelledby': `${basis}_${aktiv}`, tabindex: '0' },
      t.inhalt ? b.markdown(t.inhalt, { ui: true, teil: aktiv }) : h('p.bs-leise', null, text('(leer)'))));
}

export const typen = {
  tabs: {
    pruefen,
    render,
    text: (s) => s.tabs.map((t) => `${t.titel}\n${t.inhalt}`).join('\n\n'),
  },
};

const CSS = `
.bs-tabs__leiste { display: flex; gap: 2px; margin: -4px -4px 14px; padding: 3px; overflow-x: auto; background: var(--surface-3); border-radius: var(--r-2); scrollbar-width: none; }
.bs-tabs__leiste::-webkit-scrollbar { display: none; }
.bs-tab { flex: 1 0 auto; min-height: 32px; padding: 0 14px; font: inherit; font-size: var(--fs-sm); font-weight: 500; color: var(--fg-muted); white-space: nowrap; background: none; border: 0; border-radius: 7px; cursor: pointer; transition: background var(--dur-2) var(--ease), color var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease); }
.bs-tab:hover { color: var(--fg); }
.bs-tab.is-aktiv { color: var(--fg); background: var(--surface); box-shadow: var(--shadow-1); }
.bs-tab:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-ring); }
.bs-tabs__panel { animation: bs-ein var(--dur-3) var(--ease); }
.bs-tabs__panel:focus-visible { outline: none; }
@media (pointer: coarse) { .bs-tab { min-height: 40px; } }
`;
