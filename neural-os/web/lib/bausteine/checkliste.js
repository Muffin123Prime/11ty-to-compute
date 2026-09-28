/**
 * bausteine/checkliste.js -- echte Kaestchen, die sich merken, was erledigt ist.
 *
 * Anders als `- [ ]` im Markdown der Antwort (das im Chat nur Anzeige ist)
 * ist das hier ein Werkzeug: Abhaken wird gespeichert, "3 von 5" und der
 * Balken stimmen immer, Strg+Z nimmt den letzten Haken zurueck. Mit
 * `sortierbar` laesst sich die Reihenfolge ziehen.
 *
 * Gespeichert wird je Punkt seine urspruengliche Nummer -- nicht die
 * Position: nach dem Umsortieren bleibt der Haken beim richtigen Punkt.
 */

import { h, text, cx } from '../dom.js';
import { str, bool, liste, objekt, LAENGE, sym, inline, ensureStyle, balken, istUmordnung, umordnen, perKey } from './gemeinsam.js';
import { sortierbarMachen, SORTIER_CSS } from './sortieren.js';

const STYLE_ID = 'nos-bs-checkliste';

function punktPruefen(x) {
  if (typeof x === 'string' || typeof x === 'number') {
    const t = str(x, 300);
    return t ? { text: t } : null;
  }
  const o = objekt(x);
  if (!o) return null;
  const t = str(o.text, 300);
  if (!t) return null;
  return o.erledigt === true ? { text: t, erledigt: true } : { text: t };
}

function pruefen(roh) {
  const out = { punkte: liste(roh.punkte, 'punkte', { min: 1, max: 50, je: punktPruefen }) };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  if (bool(roh.sortierbar, false)) out.sortierbar = true;
  return out;
}

/** Welche Punkte erledigt sind: gespeichert, sonst wie im JSON vorgegeben. */
export function erledigteAus(spec, zustand) {
  if (zustand && Array.isArray(zustand.erledigt)) {
    return new Set(zustand.erledigt.filter((i) => Number.isInteger(i) && i >= 0 && i < spec.punkte.length));
  }
  return new Set(spec.punkte.map((p, i) => (p.erledigt ? i : -1)).filter((i) => i >= 0));
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  ensureStyle('nos-bs-sortieren', SORTIER_CSS);
  const z = b.zustand.lesen();
  const erledigt = erledigteAus(spec, z);
  const n = spec.punkte.length;
  const reihe = istUmordnung(z.reihenfolge, n) ? z.reihenfolge : spec.punkte.map((_, i) => i);
  const fertig = erledigt.size;
  const ansage = h('p.bs-nur-leser', { role: 'status', 'aria-live': 'polite' });

  const kopf = h('div.bs-kopf', null,
    spec.titel ? h('p.bs-titel', null, inline(spec.titel)) : h('span'),
    h('span.bs-meta', { class: cx({ 'bs-ok': fertig === n }) }, text(fertig === n ? `Alles erledigt · ${n} von ${n}` : `${fertig} von ${n}`)));

  const box = h('div.bs-check');
  const ul = h('ul.bs-check__liste', { 'aria-label': spec.titel || 'Checkliste' });
  reihe.forEach((idx, platz) => {
    const p = spec.punkte[idx];
    const an = erledigt.has(idx);
    const id = b.key(`p:${idx}`).replace(/[^A-Za-z0-9_-]/g, '_');
    const kaestchen = h('input.bs-check__kaestchen', {
      id,
      type: 'checkbox',
      checked: an,
      'data-key': b.key(`p:${idx}`),
      onClick: (e) => e.stopPropagation(),
      onChange: (e) => {
        const neu = new Set(erledigt);
        if (e.target.checked) neu.add(idx);
        else neu.delete(idx);
        b.zustand.setzen({ erledigt: [...neu].sort((x, y) => x - y) }, { was: e.target.checked ? 'Abgehakt' : 'Haken entfernt' });
      },
    });
    ul.appendChild(h('li.bs-check__punkt', { class: cx({ 'is-erledigt': an }), 'data-sort-index': String(platz) },
      spec.sortierbar ? h('button.bs-griff', {
        type: 'button',
        'data-griff': '',
        'data-key': b.key(`g:${idx}`),
        'aria-label': `„${p.text.slice(0, 60)}“ verschieben (Alt+Pfeil hoch/runter)`,
        title: 'Ziehen oder Alt+↑/↓',
      }, sym('griff')) : null,
      kaestchen,
      h('label.bs-check__text', { for: id }, h('span.bs-check__kreis', { 'aria-hidden': 'true' }, sym('haken')), h('span', null, inline(p.text)))));
  });
  if (spec.sortierbar) {
    sortierbarMachen(ul, (von, nach) => {
      const neu = umordnen(reihe, von, nach);
      const bewegt = reihe[von];
      if (b.zustand.setzen({ reihenfolge: neu }, { was: 'Verschoben' })) {
        const el = perKey(b.key(`g:${bewegt}`), b.huelle());
        if (el) el.focus();
      }
    }, { ansage: (s) => { ansage.textContent = s; } });
  }
  box.append(kopf, balken(n ? fertig / n : 0, `${fertig} von ${n} erledigt`), ul, ansage);
  return box;
}

export const typen = {
  checkliste: {
    pruefen,
    render,
    text: (s) => [s.titel || '', ...s.punkte.map((p) => `${p.erledigt ? '☑' : '☐'} ${p.text}`)].filter(Boolean).join('\n'),
  },
};

const CSS = `
.bs-check .bs-balken { margin: -4px 0 10px; }
.bs-check__liste { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.bs-check__punkt { display: flex; align-items: center; gap: 4px; border-radius: var(--r-2); }
.bs-check__punkt + .bs-check__punkt { border-top: 1px solid var(--border); }
.bs-check__kaestchen { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
.bs-check__text { display: flex; align-items: flex-start; gap: 12px; flex: 1 1 auto; min-width: 0; padding: 10px 4px; font-size: var(--fs-md); line-height: 1.45; color: var(--fg); cursor: pointer; -webkit-tap-highlight-color: transparent; }
.bs-check__kreis { display: inline-grid; place-items: center; flex: none; width: 20px; height: 20px; margin-top: 1px; color: transparent; border: 1.5px solid var(--border-strong); border-radius: 50%; transition: background var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease), color var(--dur-2) var(--ease), transform var(--dur-2) var(--ease); }
.bs-check__kreis svg { width: 12px; height: 12px; stroke-width: 2.4; }
.bs-check__text:hover .bs-check__kreis { border-color: var(--accent); }
.bs-check__kaestchen:focus-visible + .bs-check__text .bs-check__kreis { box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-check__punkt.is-erledigt .bs-check__kreis { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
.bs-check__kaestchen:checked + .bs-check__text .bs-check__kreis { transform: scale(1); animation: bs-haken var(--dur-3) var(--ease); }
.bs-check__punkt.is-erledigt .bs-check__text > span:last-child { color: var(--fg-muted); text-decoration: line-through; text-decoration-color: var(--fg-subtle); }
@keyframes bs-haken { 0% { transform: scale(0.85); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }
@media (pointer: coarse) {
  .bs-check__text { min-height: var(--tap-min); padding: 11px 4px; }
}
`;
