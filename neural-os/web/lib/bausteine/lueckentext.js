/**
 * bausteine/lueckentext.js -- Luecken im Text selbst fuellen.
 *
 * Die KI schreibt `{{Loesung}}` oder `{{Loesung|Alternative}}` in den Text.
 * Geprueft wird nachsichtig, wie ein Lehrer es tut: Gross/klein egal,
 * Umlaute egal (Muenchen = München = Munchen), Leerraum egal. Falsch ist,
 * was wirklich falsch ist.
 */

import { h, text, cx } from '../dom.js';
import { str, strPflicht, LAENGE, fehler, sym, knopf, inline, ensureStyle } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-lueckentext';
const LUECKE_RE = /\{\{([^{}]{1,200})\}\}/g;

/**
 * Text in Stuecke teilen.
 * @returns {Array<{art:'text', text:string} | {art:'luecke', loesungen:string[], nr:number}>}
 */
export function lueckenParsen(quelle) {
  const out = [];
  let rest = 0;
  let nr = 0;
  const s = String(quelle || '');
  for (const m of s.matchAll(LUECKE_RE)) {
    if (m.index > rest) out.push({ art: 'text', text: s.slice(rest, m.index) });
    const loesungen = m[1].split('|').map((x) => x.trim()).filter(Boolean);
    if (loesungen.length) {
      out.push({ art: 'luecke', loesungen, nr });
      nr += 1;
    } else {
      out.push({ art: 'text', text: m[0] });
    }
    rest = m.index + m[0].length;
  }
  if (rest < s.length) out.push({ art: 'text', text: s.slice(rest) });
  return out;
}

/** Die Formen, in denen zwei Eingaben als gleich gelten. */
export function lueckeFormen(wert) {
  const basis = String(wert || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
  const ae = basis.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const ohne = basis.replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
  return new Set([basis, ae, ohne]);
}

/** Passt die Eingabe zu einer der Loesungen? */
export function lueckeRichtig(eingabe, loesungen) {
  if (!String(eingabe || '').trim()) return false;
  const e = lueckeFormen(eingabe);
  return (loesungen || []).some((l) => {
    for (const f of lueckeFormen(l)) if (e.has(f)) return true;
    return false;
  });
}

function pruefen(roh) {
  const t = strPflicht(roh.text, 'text', 6000);
  const stuecke = lueckenParsen(t);
  const n = stuecke.filter((x) => x.art === 'luecke').length;
  if (!n) throw fehler('Im Text fehlt eine Lücke wie {{Lösung}}.');
  if (n > 40) throw fehler('Höchstens 40 Lücken.');
  const out = { text: t };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  return out;
}

function textKnoten(t) {
  const teile = t.split('\n');
  const out = [];
  teile.forEach((zeile, i) => {
    if (i > 0) out.push(h('br'));
    if (zeile) out.push(inline(zeile));
  });
  return out;
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const stuecke = lueckenParsen(spec.text);
  const luecken = stuecke.filter((x) => x.art === 'luecke');
  const n = luecken.length;
  const z = b.zustand.lesen();
  const a = b.ansicht;
  if (!Array.isArray(a.eingaben)) a.eingaben = Array.isArray(z.eingaben) ? z.eingaben.slice(0, n).map((x) => String(x || '')) : [];
  while (a.eingaben.length < n) a.eingaben.push('');
  if (!a.geaendert) a.geaendert = new Set();
  const geprueft = !!z.geprueft;
  const geloest = !!z.geloest;
  const werte = geloest ? luecken.map((l) => l.loesungen[0]) : a.eingaben;
  const richtig = luecken.map((l, i) => lueckeRichtig(werte[i], l.loesungen));
  const anzahlRichtig = richtig.filter(Boolean).length;

  const fokusNaechste = (i) => {
    const felder = [...b.huelle().querySelectorAll('.bs-luecke')];
    if (felder[i + 1]) felder[i + 1].focus();
    else pruefenJetzt();
  };
  const pruefenJetzt = () => {
    a.geaendert = new Set();
    b.zustand.setzen({ eingaben: a.eingaben.slice(), geprueft: true }, { was: 'Geprüft' });
  };

  const absatz = h('p.bs-lt__text');
  for (const s of stuecke) {
    if (s.art === 'text') {
      absatz.append(...textKnoten(s.text));
      continue;
    }
    const i = s.nr;
    // Breite nach der laengsten Loesung -- und mit der Eingabe wachsend: wer
    // "Muenchen" statt "München" tippt, soll sein Wort ganz sehen.
    const breite = Math.max(5, Math.min(26, Math.max(...s.loesungen.map((l) => l.length)) + 3));
    const breiteFuer = (wert) => `${Math.min(30, Math.max(breite, String(wert || '').length + 3))}ch`;
    const markiert = (geprueft || geloest) && !a.geaendert.has(i);
    const feld = h('input.bs-luecke', {
      type: 'text',
      class: cx({ 'is-richtig': markiert && richtig[i], 'is-falsch': markiert && !richtig[i] && !geloest, 'is-geloest': geloest }),
      style: { width: breiteFuer(werte[i]) },
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      readonly: geloest,
      'aria-label': `Lücke ${i + 1}${markiert ? (richtig[i] ? ', richtig' : ', falsch') : ''}`,
      'aria-invalid': markiert && !richtig[i] && !geloest ? 'true' : null,
      'data-key': b.key(`l:${i}`),
      enterkeyhint: i < n - 1 ? 'next' : 'done',
      onInput: (e) => {
        a.eingaben[i] = e.target.value;
        e.target.style.width = breiteFuer(e.target.value);
        if (markiert) {
          a.geaendert.add(i);
          e.target.classList.remove('is-richtig', 'is-falsch');
          e.target.removeAttribute('aria-invalid');
        }
      },
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          fokusNaechste(i);
        }
      },
      onClick: (e) => e.stopPropagation(),
    });
    feld.value = werte[i] || '';
    absatz.appendChild(h('span.bs-lt__platz', null, feld,
      markiert && !geloest ? h('span.bs-lt__marke', { class: richtig[i] ? 'is-richtig' : 'is-falsch', 'aria-hidden': 'true' }, sym(richtig[i] ? 'haken' : 'kreuz')) : null));
  }

  const box = h('div.bs-lt');
  box.appendChild(h('div.bs-kopf', null,
    h('p.bs-titel', null, spec.titel ? inline(spec.titel) : text('Lückentext')),
    h('span.bs-meta', { class: cx({ 'bs-ok': geprueft && anzahlRichtig === n && !geloest }) },
      text(geloest ? 'Lösung' : (geprueft ? `${anzahlRichtig} von ${n} richtig` : `${n} ${n === 1 ? 'Lücke' : 'Lücken'}`)))));
  box.appendChild(absatz);
  box.appendChild(h('div.bs-fuss', null,
    geloest
      ? knopf('Selbst versuchen', {
        art: 'leise', symbol: 'nochmal', key: b.key('neu'),
        onClick: () => { a.eingaben = new Array(n).fill(''); b.zustand.setzen({ eingaben: [], geprueft: false, geloest: false }, { was: 'Neu versucht' }); },
      })
      : knopf('Lösung zeigen', { art: 'leise', symbol: 'auge', key: b.key('loesung'), onClick: () => b.zustand.setzen({ eingaben: a.eingaben.slice(), geloest: true }, { was: 'Lösung gezeigt' }) }),
    h('div.bs-fuss__rechts', null, geloest ? null : knopf('Prüfen', { art: 'haupt', key: b.key('pruefen'), onClick: pruefenJetzt }))));
  return box;
}

export const typen = {
  lueckentext: {
    pruefen,
    render,
    text: (s) => [s.titel || '', lueckenParsen(s.text).map((x) => (x.art === 'text' ? x.text : '_____')).join('')].filter(Boolean).join('\n'),
  },
};

const CSS = `
.bs-lt__text { margin: 0; font-size: var(--fs-md); line-height: 2.35; overflow-wrap: anywhere; }
.bs-lt__platz { position: relative; display: inline-flex; align-items: center; gap: 2px; vertical-align: baseline; }
.bs-luecke { max-width: 100%; height: 32px; margin: 0 3px; padding: 0 8px; font: inherit; font-size: var(--fs-md); line-height: 1; color: var(--accent-text); text-align: center; background: var(--surface-2); border: 0; border-bottom: 2px solid var(--border-strong); border-radius: 6px 6px 2px 2px; transition: border-color var(--dur-2) var(--ease), background var(--dur-2) var(--ease); }
.bs-luecke:focus { outline: none; border-bottom-color: var(--accent); background: var(--accent-soft); }
.bs-luecke.is-richtig { color: var(--ok); border-bottom-color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.bs-luecke.is-falsch { color: var(--danger); border-bottom-color: var(--danger); background: var(--danger-soft); }
.bs-luecke.is-geloest { color: var(--fg); border-bottom-color: var(--accent); }
.bs-lt__marke { display: inline-grid; place-items: center; width: 16px; height: 16px; margin-left: -2px; margin-right: 2px; }
.bs-lt__marke svg { width: 14px; height: 14px; stroke-width: 2.2; }
.bs-lt__marke.is-richtig { color: var(--ok); }
.bs-lt__marke.is-falsch { color: var(--danger); }
@media (pointer: coarse) { .bs-luecke { height: var(--tap-min); } .bs-lt__text { line-height: 2.9; } }
`;
