/**
 * bausteine/abschnitte.js -- langer Stoff in aufklappbaren Bereichen.
 *
 * Knoepfe mit aria-expanded statt <details>: dasselbe fuer Screenreader,
 * aber der Zustand liegt ausserhalb des DOM (b.ansicht) und ueberlebt so
 * den Neubau der Nachricht, und das Auf- und Zuklappen darf sanft sein.
 * Offen ist der erste, wenn keiner `offen` sagt.
 *
 * Die Ueberschrift ist ein div mit role="heading" statt <h3>: Der Chat haengt
 * an echte h2/h3 der Antwort ein "Frage dazu" -- ein Abschnittskopf, der
 * selbst ein Knopf ist, soll das nicht zusaetzlich bekommen.
 */

import { h, text, cx } from '../dom.js';
import { str, strPflicht, bool, liste, objekt, LAENGE, sym, inline, ensureStyle } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-abschnitte';

function pruefen(roh) {
  return {
    abschnitte: liste(roh.abschnitte, 'abschnitte', {
      min: 1,
      max: 20,
      je: (x, i) => {
        const o = objekt(x);
        if (!o) return null;
        const a = { titel: strPflicht(o.titel, `abschnitte[${i}].titel`, 160), inhalt: str(o.inhalt, LAENGE.inhalt) };
        if (bool(o.offen, false)) a.offen = true;
        return a;
      },
    }),
  };
}

/** Welche Abschnitte zu Beginn offen sind. */
export function startOffen(spec) {
  const offen = spec.abschnitte.map((a, i) => (a.offen ? i : -1)).filter((i) => i >= 0);
  return offen.length ? offen : [0];
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const a = b.ansicht;
  if (!Array.isArray(a.offen)) a.offen = startOffen(spec);
  const offen = new Set(a.offen);
  const box = h('div.bs-abschnitte');
  spec.abschnitte.forEach((x, i) => {
    const auf = offen.has(i);
    const id = b.key(`a:${i}`).replace(/[^A-Za-z0-9_-]/g, '_');
    box.appendChild(h('section.bs-abschnitt', { class: cx({ 'is-offen': auf }) },
      h('div.bs-abschnitt__h', { role: 'heading', 'aria-level': '3' }, h('button.bs-abschnitt__kopf', {
        type: 'button',
        'aria-expanded': String(auf),
        'aria-controls': `${id}_inhalt`,
        id: `${id}_kopf`,
        'data-key': b.key(`a:${i}`),
        onClick: (e) => {
          e.stopPropagation();
          const neu = new Set(a.offen);
          if (auf) neu.delete(i);
          else neu.add(i);
          a.offen = [...neu];
          b.neuZeichnen();
        },
      }, h('span.bs-abschnitt__titel', null, inline(x.titel, { ohneLinks: true })), h('span.bs-abschnitt__pfeil', { 'aria-hidden': 'true' }, sym('runter')))),
      auf ? h('div.bs-abschnitt__inhalt', { id: `${id}_inhalt`, role: 'region', 'aria-labelledby': `${id}_kopf` },
        x.inhalt ? b.markdown(x.inhalt, { ui: true, teil: i }) : h('p.bs-leise', null, text('(leer)'))) : null));
  });
  return box;
}

export const typen = {
  abschnitte: {
    pruefen,
    render,
    flach: true,
    text: (s) => s.abschnitte.map((x) => `${x.titel}\n${x.inhalt}`).join('\n\n'),
  },
};

const CSS = `
.bs-abschnitte { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); overflow: hidden; }
.bs-abschnitt + .bs-abschnitt { border-top: 1px solid var(--border); }
.bs-abschnitt__h { margin: 0; font: inherit; }
.bs-abschnitt__kopf { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 48px; padding: 12px 16px; font: inherit; font-size: var(--fs-md); font-weight: 500; text-align: left; color: var(--fg); background: none; border: 0; cursor: pointer; transition: background var(--dur-1) var(--ease); -webkit-tap-highlight-color: transparent; }
.bs-abschnitt__kopf:hover { background: var(--surface-2); }
.bs-abschnitt__kopf:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.bs-abschnitt__titel { min-width: 0; overflow-wrap: anywhere; }
.bs-abschnitt__pfeil { display: inline-grid; flex: none; color: var(--fg-subtle); transition: transform var(--dur-3) var(--ease); }
.bs-abschnitt__pfeil svg { width: 16px; height: 16px; }
.bs-abschnitt.is-offen .bs-abschnitt__pfeil { transform: rotate(180deg); color: var(--fg-muted); }
.bs-abschnitt__inhalt { padding: 0 16px 16px; animation: bs-ein var(--dur-3) var(--ease); }
`;
