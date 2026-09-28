/**
 * bausteine/lernkarten.js -- Karteikarten mit echtem Stapel.
 *
 * Umdrehen (Antippen, Leertaste), dann ehrlich: [Gewusst] nimmt die Karte
 * aus dem Stapel, [Nochmal] legt sie nach hinten. So kommt, was noch nicht
 * sitzt, in derselben Runde wieder -- wie mit Papierkarten. Der Stapel ist
 * gespeichert: nach dem Neuladen geht es an derselben Karte weiter.
 */

import { h, text, cx } from '../dom.js';
import { str, liste, objekt, LAENGE, sym, knopf, inline, ensureStyle, balken } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-lernkarten';

function pruefen(roh) {
  const out = {
    karten: liste(roh.karten, 'karten', {
      min: 1,
      max: 60,
      je: (x) => {
        const o = objekt(x);
        if (!o) return null;
        const vorne = str(o.vorne, 300);
        const hinten = str(o.hinten, 1000);
        return vorne && hinten ? { vorne, hinten } : null;
      },
    }),
  };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  return out;
}

/** Der Stapel aus einem (vielleicht alten oder fremden) Zustand. */
export function stapelAus(zustand, n) {
  const gewusst = Array.isArray(zustand && zustand.gewusst) ? zustand.gewusst.filter((i) => Number.isInteger(i) && i >= 0 && i < n) : [];
  const gSet = new Set(gewusst);
  let reihe = Array.isArray(zustand && zustand.reihe) ? zustand.reihe : null;
  const offen = Array.from({ length: n }, (_, i) => i).filter((i) => !gSet.has(i));
  const gueltig = Array.isArray(reihe) && reihe.length === offen.length && new Set(reihe).size === reihe.length
    && reihe.every((i) => Number.isInteger(i) && i >= 0 && i < n && !gSet.has(i));
  if (!gueltig) reihe = offen;
  return { reihe: reihe.slice(), gewusst: [...gSet], runde: Number.isInteger(zustand && zustand.runde) ? zustand.runde : 1 };
}

/**
 * Ein Schritt am Stapel. Rein: gibt den neuen Zustand zurueck.
 * @param {{reihe:number[], gewusst:number[], runde:number}} st
 * @param {'gewusst'|'nochmal'|'mischen'|'neu'} aktion
 * @param {number} n Anzahl Karten
 * @param {() => number} [zufall]
 */
export function lernSchritt(st, aktion, n, zufall = Math.random) {
  const reihe = st.reihe.slice();
  const gewusst = st.gewusst.slice();
  switch (aktion) {
    case 'gewusst': {
      const k = reihe.shift();
      if (k !== undefined && !gewusst.includes(k)) gewusst.push(k);
      return { reihe, gewusst, runde: st.runde };
    }
    case 'nochmal': {
      const k = reihe.shift();
      if (k !== undefined) reihe.push(k);
      return { reihe, gewusst, runde: st.runde };
    }
    case 'mischen': {
      for (let i = reihe.length - 1; i > 0; i -= 1) {
        const j = Math.floor(zufall() * (i + 1));
        [reihe[i], reihe[j]] = [reihe[j], reihe[i]];
      }
      return { reihe, gewusst, runde: st.runde };
    }
    case 'neu':
      return { reihe: Array.from({ length: n }, (_, i) => i), gewusst: [], runde: (st.runde || 1) + 1 };
    default:
      return { reihe, gewusst, runde: st.runde };
  }
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const n = spec.karten.length;
  const st = stapelAus(b.zustand.lesen(), n);
  const a = b.ansicht;
  const schritt = (aktion, was) => {
    a.umgedreht = false;
    b.zustand.setzen(lernSchritt(st, aktion, n), { was });
  };
  const box = h('div.bs-lern');
  box.appendChild(h('div.bs-kopf', null,
    h('p.bs-titel', null, spec.titel ? inline(spec.titel) : text('Lernkarten')),
    h('span.bs-meta', null, text(`${st.gewusst.length} von ${n} gewusst`))));
  box.appendChild(balken(st.gewusst.length / n, `${st.gewusst.length} von ${n} gewusst`));

  if (!st.reihe.length) {
    box.appendChild(h('div.bs-lern__fertig', null,
      h('span.bs-lern__fertig-symbol', { 'aria-hidden': 'true' }, sym('haken')),
      h('p.bs-lern__fertig-text', null, text(n === 1 ? 'Gewusst.' : `Alle ${n} Karten gewusst.`)),
      knopf('Von vorn', { symbol: 'nochmal', key: b.key('neu'), onClick: () => schritt('neu', 'Stapel neu') })));
    return box;
  }

  const k = spec.karten[st.reihe[0]];
  const antworten = h('div.bs-lern__antworten', { hidden: !a.umgedreht },
    knopf('Nochmal', { symbol: 'nochmal', key: b.key('nochmal'), onClick: () => schritt('nochmal', 'Nochmal') }),
    knopf('Gewusst', { art: 'haupt', symbol: 'haken', key: b.key('gewusst'), onClick: () => schritt('gewusst', 'Gewusst') }));
  const ansage = h('p.bs-nur-leser', { 'aria-live': 'polite' });
  const karte = h('button.bs-lern__karte', {
    type: 'button',
    class: cx({ 'is-umgedreht': !!a.umgedreht }),
    'aria-label': a.umgedreht ? 'Karte zurückdrehen' : 'Karte umdrehen',
    'data-key': b.key('karte'),
    onClick: (e) => { e.stopPropagation(); drehen(); },
  },
  h('span.bs-lern__seite.is-vorne', { 'aria-hidden': a.umgedreht ? 'true' : null },
    h('span.bs-lern__marke', null, text('Frage')), h('span.bs-lern__text', null, inline(k.vorne, { ohneLinks: true })),
    h('span.bs-lern__tipp', null, text('Antippen zum Umdrehen'))),
  h('span.bs-lern__seite.is-hinten', { 'aria-hidden': a.umgedreht ? null : 'true' },
    h('span.bs-lern__marke', null, text('Antwort')), h('span.bs-lern__text', null, inline(k.hinten, { ohneLinks: true }))));
  // Umdrehen ohne Neuzeichnen: nur so laeuft die Drehung als Animation.
  function drehen() {
    a.umgedreht = !a.umgedreht;
    karte.classList.toggle('is-umgedreht', a.umgedreht);
    karte.setAttribute('aria-label', a.umgedreht ? 'Karte zurückdrehen' : 'Karte umdrehen');
    karte.querySelector('.is-vorne').setAttribute('aria-hidden', a.umgedreht ? 'true' : 'false');
    karte.querySelector('.is-hinten').setAttribute('aria-hidden', a.umgedreht ? 'false' : 'true');
    antworten.hidden = !a.umgedreht;
    ansage.textContent = a.umgedreht ? `Antwort: ${k.hinten}` : '';
  }
  box.addEventListener('keydown', (e) => {
    if (e.target !== karte && e.target !== box) return;
    if (a.umgedreht && (e.key === 'ArrowRight' || e.key.toLowerCase() === 'g')) { e.preventDefault(); schritt('gewusst', 'Gewusst'); }
    if (a.umgedreht && (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'n')) { e.preventDefault(); schritt('nochmal', 'Nochmal'); }
  });
  box.append(h('div.bs-lern__buehne', null, karte), ansage,
    h('div.bs-fuss.bs-lern__fuss', null,
      h('span.bs-leise', null, text(st.reihe.length === 1 ? 'Letzte Karte' : `Noch ${st.reihe.length} im Stapel`)),
      st.reihe.length > 1 ? knopf('Mischen', { art: 'leise', symbol: 'mischen', key: b.key('mischen'), onClick: () => schritt('mischen', 'Gemischt') }) : null,
      h('div.bs-fuss__rechts', null, antworten)));
  return box;
}

export const typen = {
  lernkarten: {
    pruefen,
    render,
    text: (s) => [s.titel || 'Lernkarten', ...s.karten.map((k) => `${k.vorne} – ${k.hinten}`)].join('\n'),
  },
};

const CSS = `
.bs-lern > .bs-balken { margin: -4px 0 14px; }
.bs-lern__buehne { perspective: 1200px; }
.bs-lern__karte { position: relative; display: block; width: 100%; min-height: 168px; padding: 0; font: inherit; color: var(--fg); background: none; border: 0; cursor: pointer; transform-style: preserve-3d; transition: transform var(--dur-3) var(--ease); -webkit-tap-highlight-color: transparent; }
.bs-lern__karte.is-umgedreht { transform: rotateY(180deg); }
.bs-lern__karte:focus-visible { outline: none; }
.bs-lern__karte:focus-visible .bs-lern__seite { box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-lern__seite { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 22px 20px; text-align: center; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-3); backface-visibility: hidden; -webkit-backface-visibility: hidden; }
.bs-lern__seite.is-hinten { transform: rotateY(180deg); background: var(--surface-3); }
.bs-lern__marke { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-subtle); }
.bs-lern__seite.is-hinten .bs-lern__marke { color: var(--accent-text); }
.bs-lern__text { font-size: var(--fs-lg); font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; }
.bs-lern__seite.is-hinten .bs-lern__text { font-size: var(--fs-md); font-weight: 400; }
.bs-lern__tipp { position: absolute; bottom: 10px; font-size: var(--fs-xs); color: var(--fg-subtle); }
.bs-lern__antworten { display: flex; gap: 8px; animation: bs-ein var(--dur-2) var(--ease); }
.bs-lern__fertig { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 0 6px; text-align: center; }
.bs-lern__fertig-symbol { display: grid; place-items: center; width: 40px; height: 40px; color: var(--accent-fg); background: var(--accent); border-radius: 50%; }
.bs-lern__fertig-symbol svg { width: 20px; height: 20px; stroke-width: 2.2; }
.bs-lern__fertig-text { margin: 0; font-size: var(--fs-md); font-weight: 500; }
@media (prefers-reduced-motion: reduce) { .bs-lern__karte { transition: none; } }
`;
