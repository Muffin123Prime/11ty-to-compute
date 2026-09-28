/**
 * bausteine/vorschau.js -- Webseite, Grafik, Dokument oder Folien ansehen.
 *
 * - `html` / `svg`: im Sandkasten (web/sandbox.html, eigener Ursprung,
 *   kein Netz). [Anhalten] entfernt den Rahmen ganz -- ein laufendes Skript
 *   endet damit wirklich.
 * - `dokument`: Markdown als Seite gesetzt.
 * - `folien`: Markdown, `---` trennt die Folien; blaetterbar mit Knoepfen,
 *   Pfeiltasten und im Vollbild.
 *
 * Immer dabei: [Code] (der Quelltext, mit [Bearbeiten] als neue Fassung),
 * [Vollbild], [Herunterladen].
 */

import { h, text, cx } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { str, roh, wahl, fehler, LAENGE, sym, knopf, inline, ensureStyle, herunterladen, dateiname } from './gemeinsam.js';
import { sandkastenVorschau } from './datei.js';
import { kannBearbeiten, bearbeitenFeld, BEARBEITEN_CSS } from './bearbeiten.js';

const STYLE_ID = 'nos-bs-vorschau';
const ARTEN = ['html', 'svg', 'dokument', 'folien'];
const ART_NAME = { html: 'Webseite', svg: 'Grafik', dokument: 'Dokument', folien: 'Folien' };
const ENDUNG = { html: 'html', svg: 'svg', dokument: 'md', folien: 'md' };
const MIME = { html: 'text/html', svg: 'image/svg+xml', dokument: 'text/markdown', folien: 'text/markdown' };

/**
 * Folien trennen: eine Zeile nur aus `---` (ausserhalb von Codezaeunen).
 * @returns {string[]}
 */
export function folienTeilen(markdown) {
  const zeilen = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const folien = [];
  let aktuell = [];
  let zaun = null;
  for (const z of zeilen) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(z);
    if (f) {
      if (!zaun) zaun = f[1];
      else if (f[1][0] === zaun[0] && f[1].length >= zaun.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(z)) zaun = null;
    }
    if (!zaun && /^\s*---+\s*$/.test(z)) {
      folien.push(aktuell.join('\n'));
      aktuell = [];
      continue;
    }
    aktuell.push(z);
  }
  folien.push(aktuell.join('\n'));
  return folien.map((x) => x.trim()).filter(Boolean);
}

function pruefen(rohSpec) {
  const art = wahl(rohSpec.art, ARTEN, null);
  if (!art) throw fehler('„art“ muss html, svg, dokument oder folien sein.');
  const inhalt = roh(rohSpec.inhalt, LAENGE.datei);
  if (!inhalt.trim()) throw fehler('„inhalt“ fehlt.');
  if (art === 'svg' && !/<svg[\s>]/i.test(inhalt)) throw fehler('Eine SVG-Vorschau braucht ein <svg>-Element.');
  const out = { art, inhalt };
  const titel = str(rohSpec.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  return out;
}

/* Vollbild: die echte Schnittstelle, wo es sie gibt, sonst eine Ebene ueber allem. */
function vollbildUmschalten(el, a, b) {
  const doc = document;
  const aktiv = doc.fullscreenElement || doc.webkitFullscreenElement;
  if (aktiv === el) {
    (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    return;
  }
  const an = el.requestFullscreen || el.webkitRequestFullscreen;
  if (an && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
    try {
      const p = an.call(el);
      if (p && typeof p.catch === 'function') p.catch(() => { a.ebene = true; b.neuZeichnen(); });
      return;
    } catch { /* unten */ }
  }
  a.ebene = !a.ebene;
  b.neuZeichnen();
}

function folienAnsicht(spec, b, a) {
  const folien = folienTeilen(spec.inhalt);
  const n = folien.length;
  const i = Math.max(0, Math.min(n - 1, Number(a.folie) || 0));
  const geh = (k) => { a.folie = Math.max(0, Math.min(n - 1, k)); b.neuZeichnen(); };
  const folie = h('div.bs-vs__folie', {
    tabindex: '0',
    role: 'group',
    'aria-roledescription': 'Folie',
    'aria-label': `Folie ${i + 1} von ${n}`,
    'data-key': b.key('folie'),
    onKeydown: (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); geh(i + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); geh(i - 1); }
      if (e.key === 'Home') { e.preventDefault(); geh(0); }
      if (e.key === 'End') { e.preventDefault(); geh(n - 1); }
    },
  }, h('div.bs-vs__folie-innen', null, b.markdown(folien[i])));
  const leiste = h('div.bs-vs__folien-leiste', null,
    knopf('', { symbol: 'links', titel: 'Vorige Folie', disabled: i === 0, key: b.key('folie-zurueck'), onClick: () => geh(i - 1) }),
    h('span.bs-meta', { 'aria-live': 'polite' }, text(`${i + 1} / ${n}`)),
    knopf('', { symbol: 'rechts', titel: 'Nächste Folie', disabled: i === n - 1, key: b.key('folie-weiter'), onClick: () => geh(i + 1) }));
  return h('div.bs-vs__folien', null, folie, leiste);
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  ensureStyle('nos-bs-bearbeiten', BEARBEITEN_CSS);
  const a = b.ansicht;
  const name = dateiname(`${spec.titel || ART_NAME[spec.art]}.${ENDUNG[spec.art]}`, `vorschau.${ENDUNG[spec.art]}`);
  const sandkasten = spec.art === 'html' || spec.art === 'svg';

  let buehneInhalt;
  if (a.code) {
    buehneInhalt = h('div.bs-vs__code', null, renderMarkdown(zaunFuer(spec.inhalt, sandkasten ? spec.art : 'markdown')));
  } else if (sandkasten && a.angehalten) {
    buehneInhalt = h('div.bs-vs__angehalten', null, h('span', null, text('Angehalten.')),
      knopf('Starten', { art: 'akzent', symbol: 'start', key: b.key('starten'), onClick: () => { a.angehalten = false; b.neuZeichnen(); } }));
  } else if (sandkasten) {
    buehneInhalt = sandkastenVorschau(spec, { art: spec.art }, b, { hoehe: 420 });
  } else if (spec.art === 'folien') {
    buehneInhalt = folienAnsicht(spec, b, a);
  } else {
    buehneInhalt = h('div.bs-vs__seite', null, b.markdown(spec.inhalt));
  }

  const buehne = h('div.bs-vs__buehne', { class: cx(`is-${spec.art}`, { 'is-ebene': !!a.ebene }) });
  buehne.append(buehneInhalt);
  if (a.ebene) {
    buehne.prepend(h('div.bs-vs__ebenen-kopf', null,
      h('span.bs-titel', null, text(spec.titel || ART_NAME[spec.art])),
      knopf('Schließen', { symbol: 'klein', key: b.key('ebene-zu'), onClick: () => { a.ebene = false; b.neuZeichnen(); } })));
  }
  const vollKnopf = knopf('', {
    symbol: 'gross', titel: 'Vollbild', key: b.key('vollbild'),
    onClick: () => vollbildUmschalten(buehne, a, b),
  });

  const kopf = h('div.bs-kopf.bs-vs__kopf', null,
    h('p.bs-titel', null, spec.titel ? inline(spec.titel) : text(ART_NAME[spec.art]),
      h('span.bs-vs__art', null, text(ART_NAME[spec.art]))),
    h('div.bs-vs__knoepfe', null,
      knopf('Code', {
        art: a.code ? 'akzent' : 'leise', symbol: 'quelltext', key: b.key('code'),
        attrs: { 'aria-pressed': String(!!a.code) },
        onClick: () => { a.code = !a.code; b.neuZeichnen(); },
      }),
      sandkasten && !a.code ? knopf('', {
        symbol: a.angehalten ? 'start' : 'stopp', titel: a.angehalten ? 'Starten' : 'Anhalten', key: b.key('anhalten'),
        onClick: () => { a.angehalten = !a.angehalten; b.neuZeichnen(); },
      }) : null,
      vollKnopf,
      knopf('', { symbol: 'laden', titel: 'Herunterladen', key: b.key('laden'), onClick: () => herunterladen(name, spec.inhalt, `${MIME[spec.art]};charset=utf-8`) })));

  const box = h('div.bs-vs', null, kopf, buehne);
  if (a.code && kannBearbeiten(b)) {
    if (a.bearbeiten) box.appendChild(bearbeitenFeld(b, a, spec.inhalt, { sprache: ART_NAME[spec.art] }));
    else box.appendChild(h('div.bs-fuss', null, knopf('Bearbeiten', { art: 'leise', symbol: 'stift', key: b.key('bearbeiten'), onClick: () => { a.bearbeiten = true; a.gespeichert = false; b.neuZeichnen(); } })));
  }
  if (a.gespeichert) box.appendChild(h('p.bs-meta.bs-vs__hinweis', null, h('span.bs-ok', null, sym('haken')), text(' Gespeichert – als neue Fassung.')));
  return box;
}

function zaunFuer(code, sprache) {
  const laengste = Math.max(2, ...(String(code).match(/`+/g) || []).map((s) => s.length));
  const f = '`'.repeat(laengste + 1);
  return `${f}${sprache}\n${code}\n${f}`;
}

export const typen = {
  vorschau: {
    pruefen,
    render,
    text: (s) => (s.art === 'dokument' || s.art === 'folien'
      ? `${s.titel ? `${s.titel}\n\n` : ''}${s.inhalt}`
      : `${s.titel || ART_NAME[s.art]} (${ART_NAME[s.art]}-Vorschau)`),
  },
};

const CSS = `
.bs-vs__kopf { align-items: center; }
.bs-vs__kopf .bs-titel { display: flex; align-items: center; gap: 8px; min-width: 0; }
.bs-vs__art { flex: none; padding: 1px 7px; font-size: var(--fs-xs); font-weight: 500; color: var(--fg-muted); background: var(--surface-3); border-radius: var(--r-full); }
.bs-vs__knoepfe { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
.bs-vs__buehne { position: relative; }
.bs-vs__buehne:fullscreen, .bs-vs__buehne:-webkit-full-screen { display: flex; flex-direction: column; justify-content: center; padding: 24px; background: var(--bg); }
.bs-vs__buehne:fullscreen .bs-sk, .bs-vs__buehne:-webkit-full-screen .bs-sk { flex: 1 1 auto; height: auto !important; max-height: none; aspect-ratio: auto !important; }
.bs-vs__buehne:fullscreen .bs-vs__folie, .bs-vs__buehne:-webkit-full-screen .bs-vs__folie { width: min(100%, calc((100vh - 120px) * 16 / 9)); margin: 0 auto; }
.bs-vs__buehne:fullscreen .bs-vs__seite, .bs-vs__buehne:-webkit-full-screen .bs-vs__seite { max-height: none; flex: 1 1 auto; }
.bs-vs__buehne.is-ebene { position: fixed; inset: 0; z-index: 900; display: flex; flex-direction: column; gap: 12px; padding: 16px 24px 24px; background: var(--bg); animation: bs-ein var(--dur-3) var(--ease); }
.bs-vs__buehne.is-ebene .bs-sk { flex: 1 1 auto; height: auto !important; max-height: none; aspect-ratio: auto !important; }
.bs-vs__ebenen-kopf { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bs-vs__seite { max-height: 520px; overflow: auto; padding: 28px 32px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); font-size: var(--fs-md); line-height: 1.65; }
.bs-vs__seite .md-heading { margin: 18px 0 8px; }
.bs-vs__seite .md-heading:first-child { margin-top: 0; }
.bs-vs__folien { display: flex; flex-direction: column; gap: 10px; }
.bs-vs__folie { position: relative; aspect-ratio: 16 / 9; overflow: hidden; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); box-shadow: var(--shadow-card); }
.bs-vs__folie:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-vs__folie-innen { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 6% 8%; overflow: auto; font-size: clamp(13px, 1.9vw, 20px); line-height: 1.5; animation: bs-ein var(--dur-3) var(--ease); }
.bs-vs__folie-innen .md-heading { margin: 0 0 0.5em; }
.bs-vs__folie-innen .md-heading--1 { font-size: 1.9em; font-weight: 600; letter-spacing: -0.02em; }
.bs-vs__folie-innen .md-heading--2 { font-size: 1.45em; font-weight: 600; letter-spacing: -0.01em; }
.bs-vs__folie-innen .md-heading--3 { font-size: 1.15em; }
.bs-vs__folien-leiste { display: flex; align-items: center; justify-content: center; gap: 12px; }
.bs-vs__code .md-code { margin: 0; }
.bs-vs__code pre { max-height: 440px; }
.bs-vs__angehalten { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: 180px; color: var(--fg-muted); background: var(--surface-2); border: 1px dashed var(--border-strong); border-radius: var(--r-2); }
.bs-vs__hinweis { display: flex; align-items: center; gap: 4px; margin: 10px 0 0; }
.bs-vs__hinweis svg { width: 14px; height: 14px; }
@media (pointer: coarse) { .bs-vs__folie-innen { font-size: clamp(14px, 2vw, 20px); } }
`;
