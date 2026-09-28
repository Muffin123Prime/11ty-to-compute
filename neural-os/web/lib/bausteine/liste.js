/**
 * bausteine/liste.js -- eine Reihenfolge festlegen.
 *
 * Fuer "Ordne nach Wichtigkeit", "In welcher Reihenfolge willst du das
 * lernen?": Ziehen mit Maus oder Finger am Griff, Alt+↑/↓ mit der Tastatur,
 * und [Reihenfolge übernehmen] schickt die Liste als Nachricht. Jede
 * Verschiebung ist ein Schritt fuer Strg+Z.
 */

import { h, text, cx } from '../dom.js';
import { str, bool, liste as listePruefen, LAENGE, sym, knopf, inline, ensureStyle, istUmordnung, umordnen, perKey } from './gemeinsam.js';
import { sortierbarMachen, SORTIER_CSS } from './sortieren.js';

const STYLE_ID = 'nos-bs-liste';

function pruefen(roh) {
  const out = {
    punkte: listePruefen(roh.punkte, 'punkte', { min: 2, max: 30, je: (x) => str(typeof x === 'object' && x ? x.text : x, 300) || null }),
    sortierbar: bool(roh.sortierbar, true),
  };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  const k = str(roh.knopf, 40);
  if (k) out.knopf = k;
  return out;
}

/** Die Nachricht mit der gewaehlten Reihenfolge. */
export function reihenfolgeText(spec, reihe) {
  const kopf = spec.titel ? `**${spec.titel}** – meine Reihenfolge:` : 'Meine Reihenfolge:';
  return [kopf, ...reihe.map((idx, i) => `${i + 1}. ${spec.punkte[idx]}`)].join('\n');
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  ensureStyle('nos-bs-sortieren', SORTIER_CSS);
  const z = b.zustand.lesen();
  const a = b.ansicht;
  const n = spec.punkte.length;
  const reihe = istUmordnung(z.reihenfolge, n) ? z.reihenfolge : spec.punkte.map((_, i) => i);
  const geaendert = reihe.some((x, i) => x !== i);
  const gesendetGleich = Array.isArray(z.gesendet) && z.gesendet.join(',') === reihe.join(',');
  const ansage = h('p.bs-nur-leser', { role: 'status', 'aria-live': 'polite' });

  const ol = h('ol.bs-liste', { 'aria-label': spec.titel || 'Liste' });
  reihe.forEach((idx, platz) => {
    ol.appendChild(h('li.bs-liste__punkt', { 'data-sort-index': String(platz) },
      spec.sortierbar ? h('button.bs-griff', {
        type: 'button',
        'data-griff': '',
        'data-key': b.key(`g:${idx}`),
        'aria-label': `„${spec.punkte[idx].slice(0, 60)}“, Platz ${platz + 1} – verschieben mit Alt+Pfeil hoch/runter`,
        title: 'Ziehen oder Alt+↑/↓',
      }, sym('griff')) : null,
      h('span.bs-liste__nr', { 'aria-hidden': 'true' }, text(String(platz + 1))),
      h('span.bs-liste__text', null, inline(spec.punkte[idx]))));
  });
  if (spec.sortierbar) {
    sortierbarMachen(ol, (von, nach) => {
      const bewegt = reihe[von];
      if (b.zustand.setzen({ reihenfolge: umordnen(reihe, von, nach) }, { was: 'Verschoben' })) {
        const el = perKey(b.key(`g:${bewegt}`), b.huelle());
        if (el) el.focus();
      }
    }, { ansage: (s) => { ansage.textContent = s; } });
  }

  const box = h('div.bs-listebox');
  if (spec.titel) box.appendChild(h('div.bs-kopf', null, h('p.bs-titel', null, inline(spec.titel))));
  box.append(ol, ansage);
  if (spec.sortierbar && b.kannSenden) {
    box.appendChild(h('div.bs-fuss', null,
      h('span.bs-leise', { class: cx({ 'bs-ok': gesendetGleich }) }, gesendetGleich ? [sym('haken'), text(' Übernommen')] : text(geaendert ? 'Geändert' : 'Zum Ordnen am Griff ziehen')),
      h('div.bs-fuss__rechts', null, knopf(spec.knopf || 'Reihenfolge übernehmen', {
        art: 'haupt',
        key: b.key('senden'),
        disabled: !!a.sendet || gesendetGleich,
        onClick: async () => {
          a.sendet = true;
          a.fehler = null;
          b.neuZeichnen();
          try {
            await b.senden(reihenfolgeText(spec, reihe));
            b.zustand.setzen({ gesendet: reihe.slice() }, { verlauf: false, zeichnen: false });
          } catch (err) {
            a.fehler = (err && err.message) || 'Das ließ sich nicht senden.';
          }
          a.sendet = false;
          b.neuZeichnen();
        },
      }))));
  }
  if (a.fehler) box.appendChild(h('p.bs-fehler', { role: 'alert' }, text(a.fehler)));
  return box;
}

export const typen = {
  liste: {
    pruefen,
    render,
    text: (s) => [s.titel || '', ...s.punkte.map((p, i) => `${i + 1}. ${p}`)].filter(Boolean).join('\n'),
  },
};

const CSS = `
.bs-liste { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.bs-liste__punkt { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 4px 12px 4px 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); }
.bs-liste__nr { display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; font-size: var(--fs-xs); font-weight: 600; color: var(--fg-muted); background: var(--surface-3); border-radius: 50%; font-variant-numeric: tabular-nums; }
.bs-liste__text { flex: 1 1 auto; min-width: 0; font-size: var(--fs-md); line-height: 1.4; overflow-wrap: anywhere; }
.bs-listebox .bs-fuss .bs-leise { display: inline-flex; align-items: center; gap: 4px; }
.bs-listebox .bs-fuss .bs-leise svg { width: 14px; height: 14px; }
@media (pointer: coarse) {
  .bs-liste__punkt { min-height: 52px; }
}
`;
