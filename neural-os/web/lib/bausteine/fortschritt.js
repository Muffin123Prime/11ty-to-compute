/**
 * bausteine/fortschritt.js -- wie weit ist etwas?
 *
 * Ein Balken mit der Zahl daneben ("3,2 von 5 km · 64 %"). Die KI rechnet
 * nichts aus, sie nennt nur Wert und Ziel; der Prozentwert entsteht hier,
 * damit er zur Zahl passt.
 */

import { h, text, cx } from '../dom.js';
import { str, zahl, fehler, LAENGE, inline, ensureStyle, balken, zahlDeutsch, sym } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-fortschritt';

function pruefen(roh) {
  const wert = zahl(roh.wert, { min: -1e12, max: 1e12 });
  if (wert === null) throw fehler('„wert“ fehlt oder ist keine Zahl.');
  const ziel = zahl(roh.ziel, { min: -1e12, max: 1e12, standard: 100 });
  if (!(ziel > 0)) throw fehler('„ziel“ muss größer als 0 sein.');
  const out = { wert, ziel };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  const einheit = str(roh.einheit, 24);
  if (einheit) out.einheit = einheit;
  return out;
}

/** Anteil 0..1 (ueber 1 heisst: Ziel ueberschritten). */
export function anteil(spec) {
  return Math.max(0, spec.wert / spec.ziel);
}

export function fortschrittText(spec) {
  const e = spec.einheit ? ` ${spec.einheit}` : '';
  const prozent = Math.round(anteil(spec) * 100);
  if (spec.einheit === '%' || (!spec.einheit && spec.ziel === 100)) return `${zahlDeutsch(spec.wert, 1)} %`;
  return `${zahlDeutsch(spec.wert, 2)} von ${zahlDeutsch(spec.ziel, 2)}${e} · ${prozent} %`;
}

function render(spec) {
  ensureStyle(STYLE_ID, CSS);
  const p = anteil(spec);
  const erreicht = p >= 1;
  return h('div.bs-fs', { class: cx({ 'is-erreicht': erreicht }) },
    h('div.bs-kopf', null,
      h('p.bs-titel', null, spec.titel ? inline(spec.titel) : text('Fortschritt')),
      h('span.bs-meta', null, erreicht ? h('span.bs-ok.bs-fs__ziel', null, sym('haken'), text(' Ziel erreicht · ')) : null, text(fortschrittText(spec)))),
    balken(Math.min(1, p), spec.titel || 'Fortschritt'));
}

export const typen = {
  fortschritt: {
    pruefen,
    render,
    flach: false,
    text: (s) => `${s.titel ? `${s.titel}: ` : ''}${fortschrittText(s)}`,
  },
};

const CSS = `
.bs-fs .bs-kopf { margin-bottom: 10px; }
.bs-fs .bs-balken { height: 8px; }
.bs-fs.is-erreicht .bs-balken__wert { background: var(--ok); }
.bs-fs__ziel svg { width: 13px; height: 13px; vertical-align: -2px; }
`;
