/**
 * bausteine/schritte.js -- eine Anleitung, Schritt fuer Schritt.
 *
 * Immer genau ein Schritt sichtbar: wer beim Nachmachen zwischen Anleitung
 * und Werkzeug wechselt, findet so die Stelle wieder. "Erledigt" je Schritt
 * wird gespeichert (mit Strg+Z), der aktuelle Schritt ebenfalls -- auch
 * nach dem Neuladen steht man wieder bei Schritt 3.
 */

import { h, text, cx } from '../dom.js';
import { str, strPflicht, liste, objekt, LAENGE, sym, knopf, inline, ensureStyle } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-schritte';

function pruefen(roh) {
  const out = {
    schritte: liste(roh.schritte, 'schritte', {
      min: 1,
      max: 20,
      je: (x, i) => {
        const o = objekt(x);
        if (!o) return null;
        return { titel: strPflicht(o.titel, `schritte[${i}].titel`, 120), inhalt: str(o.inhalt, LAENGE.inhalt) };
      },
    }),
  };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  return out;
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const z = b.zustand.lesen();
  const n = spec.schritte.length;
  const aktuell = Number.isInteger(z.aktuell) && z.aktuell >= 0 && z.aktuell < n ? z.aktuell : 0;
  const erledigt = new Set(Array.isArray(z.erledigt) ? z.erledigt.filter((i) => Number.isInteger(i) && i < n) : []);
  const s = spec.schritte[aktuell];
  const geh = (i) => b.zustand.setzen({ aktuell: Math.max(0, Math.min(n - 1, i)) }, { verlauf: false });

  const box = h('div.bs-schritte', {
    onKeydown: (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight' && aktuell < n - 1) { e.preventDefault(); geh(aktuell + 1); }
      if (e.key === 'ArrowLeft' && aktuell > 0) { e.preventDefault(); geh(aktuell - 1); }
    },
  });
  box.appendChild(h('div.bs-kopf', null,
    h('p.bs-titel', null, spec.titel ? inline(spec.titel) : text('Anleitung')),
    h('span.bs-meta', { 'aria-live': 'polite' }, text(`Schritt ${aktuell + 1} von ${n}`))));

  const punkte = h('div.bs-punkte.bs-schritte__punkte', { role: 'tablist', 'aria-label': 'Schritte' });
  spec.schritte.forEach((x, i) => {
    punkte.appendChild(h('button', {
      type: 'button',
      class: cx('bs-punkt', { 'is-aktiv': i === aktuell, 'is-fertig': erledigt.has(i) && i !== aktuell }),
      role: 'tab',
      'aria-selected': String(i === aktuell),
      'aria-label': `Schritt ${i + 1}: ${x.titel}${erledigt.has(i) ? ' (erledigt)' : ''}`,
      title: x.titel,
      'data-key': b.key(`punkt:${i}`),
      onClick: (e) => { e.stopPropagation(); geh(i); },
    }));
  });

  const fertig = erledigt.has(aktuell);
  const seite = h('div.bs-schritte__seite', { role: 'tabpanel', 'aria-label': `Schritt ${aktuell + 1}` },
    h('div.bs-schritte__kopf', null,
      h('span.bs-schritte__nr', { class: cx({ 'is-fertig': fertig }), 'aria-hidden': 'true' }, fertig ? sym('haken') : text(String(aktuell + 1))),
      h('p.bs-schritte__titel', null, inline(s.titel))),
    s.inhalt ? b.markdown(s.inhalt, { ui: true, teil: aktuell }) : null);

  const fuss = h('div.bs-fuss.bs-schritte__fuss', null,
    knopf('Zurück', { symbol: 'links', art: 'leise', disabled: aktuell === 0, key: b.key('zurueck'), onClick: () => geh(aktuell - 1) }),
    punkte,
    h('div.bs-schritte__rechts', null,
      h('button', {
        type: 'button',
        class: cx('bs-knopf', 'bs-schritte__erledigt', { 'is-an': fertig }),
        'aria-pressed': String(fertig),
        'data-key': b.key('erledigt'),
        onClick: (e) => {
          e.stopPropagation();
          const neu = new Set(erledigt);
          if (fertig) neu.delete(aktuell);
          else neu.add(aktuell);
          const patch = { erledigt: [...neu].sort((x, y) => x - y) };
          // Erledigt heisst meistens: weiter zum naechsten.
          if (!fertig && aktuell < n - 1) patch.aktuell = aktuell + 1;
          b.zustand.setzen(patch, { was: fertig ? 'Nicht mehr erledigt' : 'Erledigt' });
        },
      }, sym('haken'), h('span', null, text(fertig ? 'Erledigt' : 'Als erledigt markieren'))),
      aktuell < n - 1
        ? knopf('Weiter', { art: 'haupt', key: b.key('weiter'), onClick: () => geh(aktuell + 1) })
        : null));
  // Das Symbol "Weiter →" steht rechts vom Wort.
  const weiterKnopf = fuss.querySelector('.bs-knopf--haupt');
  if (weiterKnopf) weiterKnopf.appendChild(sym('rechts'));

  box.append(seite, fuss);
  if (erledigt.size === n) box.appendChild(h('p.bs-leise.bs-ok.bs-schritte__alle', null, sym('haken'), text(' Alle Schritte erledigt.')));
  return box;
}

export const typen = {
  schritte: {
    pruefen,
    render,
    text: (s) => [s.titel || '', ...s.schritte.map((x, i) => `${i + 1}. ${x.titel}${x.inhalt ? `\n${x.inhalt}` : ''}`)].filter(Boolean).join('\n\n'),
  },
};

const CSS = `
.bs-schritte__seite { min-height: 72px; padding: 14px 0 4px; border-top: 1px solid var(--border); animation: bs-ein var(--dur-3) var(--ease); }
.bs-schritte__kopf { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.bs-schritte__nr { display: inline-grid; place-items: center; flex: none; width: 26px; height: 26px; font-size: var(--fs-sm); font-weight: 600; color: var(--accent-text); background: var(--accent-soft); border-radius: 50%; font-variant-numeric: tabular-nums; }
.bs-schritte__nr.is-fertig { color: var(--accent-fg); background: var(--accent); }
.bs-schritte__nr svg { width: 14px; height: 14px; stroke-width: 2.2; }
.bs-schritte__titel { margin: 0; font-size: var(--fs-md); font-weight: 600; line-height: 1.35; }
.bs-schritte__seite .bs-md { padding-left: 36px; color: var(--fg); }
.bs-schritte__fuss { justify-content: space-between; }
.bs-schritte__punkte { flex: 1 1 auto; }
.bs-schritte__rechts { display: flex; flex-wrap: wrap; gap: 8px; }
.bs-schritte__erledigt { color: var(--fg-muted); }
.bs-schritte__erledigt svg { color: var(--fg-subtle); }
.bs-schritte__erledigt.is-an { color: var(--accent-text); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: var(--accent-soft); }
.bs-schritte__erledigt.is-an svg { color: var(--accent-text); }
.bs-schritte__alle { display: flex; align-items: center; gap: 4px; margin: 10px 0 0; }
.bs-schritte__alle svg { width: 14px; height: 14px; }
@media (max-width: 560px) {
  .bs-schritte__punkte { order: -1; flex-basis: 100%; }
  .bs-schritte__seite .bs-md { padding-left: 0; }
}
`;
