/**
 * bausteine/datei.js -- eine Datei, die die KI erzeugt hat.
 *
 * Eine Karte statt eines langen Codeblocks: Name, Art, Groesse, und dann
 * [Öffnen] (Vorschau passend zur Art: Markdown gesetzt, CSV als Tabelle,
 * HTML/SVG im Sandkasten, Code hervorgehoben), [Herunterladen] (Blob im
 * Browser, kein Umweg ueber den Server), [Bearbeiten] (neue Fassung der
 * Antwort) und [Teilen] -- das nur, wenn das Geraet Dateien teilen kann.
 */

import { h, text, cx, icon, formatBytes } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { str, roh, strPflicht, fehler, LAENGE, sym, knopf, ensureStyle, herunterladen, dateiname, S } from './gemeinsam.js';
import { rahmen, svgMasse } from '../sandkasten.js';
import { kannBearbeiten, bearbeitenFeld, BEARBEITEN_CSS } from './bearbeiten.js';

const STYLE_ID = 'nos-bs-datei';

/** Endung -> {art, name, mime, sprache} */
const ARTEN = {
  md: { art: 'markdown', name: 'Markdown', mime: 'text/markdown' },
  markdown: { art: 'markdown', name: 'Markdown', mime: 'text/markdown' },
  csv: { art: 'csv', name: 'CSV-Tabelle', mime: 'text/csv' },
  tsv: { art: 'csv', name: 'TSV-Tabelle', mime: 'text/tab-separated-values' },
  html: { art: 'html', name: 'HTML-Seite', mime: 'text/html' },
  htm: { art: 'html', name: 'HTML-Seite', mime: 'text/html' },
  svg: { art: 'svg', name: 'SVG-Grafik', mime: 'image/svg+xml' },
  json: { art: 'code', name: 'JSON', mime: 'application/json', sprache: 'json' },
  js: { art: 'code', name: 'JavaScript', mime: 'text/javascript', sprache: 'js' },
  mjs: { art: 'code', name: 'JavaScript', mime: 'text/javascript', sprache: 'js' },
  ts: { art: 'code', name: 'TypeScript', mime: 'text/plain', sprache: 'ts' },
  py: { art: 'code', name: 'Python', mime: 'text/x-python', sprache: 'python' },
  sh: { art: 'code', name: 'Shell-Skript', mime: 'text/x-shellscript', sprache: 'sh' },
  css: { art: 'code', name: 'CSS', mime: 'text/css', sprache: 'css' },
  xml: { art: 'code', name: 'XML', mime: 'application/xml', sprache: 'xml' },
  yml: { art: 'code', name: 'YAML', mime: 'text/yaml', sprache: 'yaml' },
  yaml: { art: 'code', name: 'YAML', mime: 'text/yaml', sprache: 'yaml' },
  sql: { art: 'code', name: 'SQL', mime: 'text/plain', sprache: 'sql' },
  ics: { art: 'text', name: 'Kalenderdatei', mime: 'text/calendar' },
  txt: { art: 'text', name: 'Textdatei', mime: 'text/plain' },
};

/** Was fuer eine Datei ist das? Rein. */
export function dateiArt(name, artHinweis) {
  const endung = (/\.([A-Za-z0-9]{1,10})$/.exec(String(name || '')) || [])[1];
  const e = endung ? endung.toLowerCase() : '';
  const bekannt = ARTEN[e];
  if (bekannt) return { endung: e, ...bekannt };
  const hinweis = String(artHinweis || '').toLowerCase();
  if (/markdown/.test(hinweis)) return { endung: e, ...ARTEN.md };
  if (/csv/.test(hinweis)) return { endung: e, ...ARTEN.csv };
  if (/html/.test(hinweis)) return { endung: e, ...ARTEN.html };
  return { endung: e, art: 'text', name: e ? `${e.toUpperCase()}-Datei` : 'Textdatei', mime: 'text/plain' };
}

/**
 * CSV lesen: Anfuehrungszeichen, "" als Zeichen, Zeilenumbrueche in Feldern.
 * Das Trennzeichen (; , Tab) wird aus der ersten Zeile erraten -- deutsche
 * Tabellen trennen meist mit Semikolon.
 * @returns {string[][]}
 */
export function csvLesen(quelle, trenner = null) {
  const s = String(quelle || '').replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  if (!trenner) {
    let erste = '';
    let inQ = false;
    for (const c of s) {
      if (c === '"') inQ = !inQ;
      if (c === '\n' && !inQ) break;
      erste += c;
    }
    const zaehle = (z) => erste.split(z).length - 1;
    trenner = [['\t', zaehle('\t')], [';', zaehle(';')], [',', zaehle(',')]].sort((a, b) => b[1] - a[1])[0][0];
    if (!zaehle(trenner)) trenner = ',';
  }
  const zeilen = [];
  let zeile = [];
  let feld = '';
  let inQ = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { feld += '"'; i += 1; }
      else if (c === '"') inQ = false;
      else feld += c;
    } else if (c === '"' && feld === '') inQ = true;
    else if (c === trenner) { zeile.push(feld); feld = ''; }
    else if (c === '\n') { zeile.push(feld); zeilen.push(zeile); zeile = []; feld = ''; }
    else feld += c;
  }
  if (feld !== '' || zeile.length) { zeile.push(feld); zeilen.push(zeile); }
  return zeilen.filter((z) => z.length > 1 || z[0] !== '');
}

function pruefen(rohSpec) {
  const nameRoh = strPflicht(rohSpec.name, 'name', 160);
  const name = dateiname(nameRoh);
  if (!/\.[A-Za-z0-9]{1,10}$/.test(name)) throw fehler('„name“ braucht eine Endung (z. B. "plan.md").');
  if (typeof rohSpec.inhalt !== 'string') throw fehler('„inhalt“ fehlt (der Text der Datei).');
  const out = { name, inhalt: roh(rohSpec.inhalt, LAENGE.datei) };
  const art = str(rohSpec.art, 60);
  if (art) out.art = art;
  return out;
}

const bytes = (s) => (typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : s.length);

function vorschau(spec, art, b) {
  if (art.art === 'markdown') return h('div.bs-datei__seite', null, b.markdown(spec.inhalt));
  if (art.art === 'csv') return csvTabelle(spec.inhalt);
  if (art.art === 'html' || art.art === 'svg') return sandkastenVorschau(spec, art, b);
  const lang = art.art === 'code' ? (art.sprache || art.endung) : '';
  return h('div.bs-datei__code', null, renderMarkdown(zaunFuer(spec.inhalt, lang)));
}

function zaunFuer(code, sprache) {
  const laengste = Math.max(2, ...(String(code).match(/`+/g) || []).map((s) => s.length));
  const f = '`'.repeat(laengste + 1);
  return `${f}${sprache}\n${code}\n${f}`;
}

const TABELLE_MAX = 300;
function csvTabelle(quelle) {
  const zeilen = csvLesen(quelle);
  if (!zeilen.length) return h('p.bs-leise', null, text('Die Tabelle ist leer.'));
  const [kopf, ...rest] = zeilen;
  const breite = Math.max(...zeilen.map((z) => z.length));
  const zelle = (tag, wert) => h(tag, null, text(wert ?? ''));
  const tabelle = h('table.bs-datei__tabelle', null,
    h('thead', null, h('tr', null, Array.from({ length: breite }, (_, i) => zelle('th', kopf[i])))),
    h('tbody', null, rest.slice(0, TABELLE_MAX).map((z) => h('tr', null, Array.from({ length: breite }, (_, i) => zelle('td', z[i]))))));
  return h('div.bs-datei__tabellen-rahmen', { tabindex: '0', role: 'region', 'aria-label': 'Tabelle' }, tabelle,
    rest.length > TABELLE_MAX ? h('p.bs-leise.bs-datei__mehr', null, text(`… und ${rest.length - TABELLE_MAX} weitere Zeilen (im Download vollständig).`)) : null);
}

/**
 * HTML/SVG im Sandkasten. Der Rahmen startet erst, wenn der Baustein eine
 * kurze Weile im Dokument steht: Waehrend die Antwort noch streamt, baut
 * der Chat die Nachricht in jedem Bild neu -- ein Rahmen, der dabei jedes
 * Mal neu laedt, waere Flackern und verschwendete Arbeit.
 */
export function sandkastenVorschau(spec, art, b, { hoehe = 380 } = {}) {
  const buehne = h('div.bs-sk', { class: cx(`is-${art.art}`) });
  const masse = art.art === 'svg' ? svgMasse(spec.inhalt) : null;
  if (masse) buehne.style.aspectRatio = `${masse.breite} / ${masse.hoehe}`;
  else buehne.style.height = `${hoehe}px`;
  const warte = h('div.bs-sk__warte', null, h('span.spinner', { 'aria-hidden': 'true' }), text('Vorschau wird geöffnet …'));
  buehne.appendChild(warte);
  let r = null;
  const t = setTimeout(async () => {
    if (!buehne.isConnected) return;
    r = rahmen({ titel: spec.titel || spec.name || 'Vorschau' });
    buehne.appendChild(r.element);
    try {
      await r.zeigen(art.art === 'svg' ? 'svg' : 'html', spec.inhalt);
      warte.remove();
    } catch (err) {
      warte.replaceChildren(sym('achtung'), text((err && err.message) || 'Die Vorschau ließ sich nicht öffnen.'));
      warte.classList.add('is-fehler');
      if (r) r.entfernen();
    }
  }, 350);
  b.beiNeubau(() => { clearTimeout(t); if (r) r.entfernen(); });
  return buehne;
}

/** Teilen nur, wenn das Geraet Dateien teilen kann -- sonst kein Knopf. */
function kannTeilen(datei) {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [datei] });
  } catch {
    return false;
  }
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  ensureStyle('nos-bs-bearbeiten', BEARBEITEN_CSS);
  const a = b.ansicht;
  const art = dateiArt(spec.name, spec.art);
  const mime = `${art.mime};charset=utf-8`;
  const datei = typeof File === 'function' ? new File([spec.inhalt], spec.name, { type: art.mime }) : null;
  const teilbar = datei && kannTeilen(datei);

  const kopf = h('div.bs-datei__kopf', null,
    h('span.bs-datei__symbol', { 'aria-hidden': 'true' }, icon(S.datei), art.endung ? h('span.bs-datei__endung', null, text(art.endung.slice(0, 4).toUpperCase())) : null),
    h('div.bs-datei__text', null,
      h('p.bs-datei__name', null, text(spec.name)),
      h('p.bs-meta', null, text(`${art.name} · ${formatBytes(bytes(spec.inhalt))}`))),
    h('div.bs-datei__knoepfe', null,
      knopf(a.offen ? 'Schließen' : 'Öffnen', {
        art: a.offen ? 'leise' : '',
        symbol: a.offen ? 'schliessen' : 'auge',
        key: b.key('oeffnen'),
        attrs: { 'aria-expanded': String(!!a.offen) },
        onClick: () => { a.offen = !a.offen; if (a.offen) a.bearbeiten = false; b.neuZeichnen(); },
      }),
      knopf('', { symbol: 'laden', titel: 'Herunterladen', key: b.key('laden'), onClick: () => herunterladen(spec.name, spec.inhalt, mime) }),
      kannBearbeiten(b) ? knopf('', {
        symbol: 'stift', titel: 'Bearbeiten', key: b.key('bearbeiten'),
        onClick: () => { a.bearbeiten = !a.bearbeiten; a.offen = false; a.gespeichert = false; b.neuZeichnen(); },
      }) : null,
      teilbar ? knopf('', {
        symbol: 'teilen', titel: 'Teilen', key: b.key('teilen'),
        onClick: async () => {
          try {
            await navigator.share({ files: [datei], title: spec.name });
          } catch (err) {
            if (err && err.name !== 'AbortError') { a.fehler = 'Teilen hat nicht geklappt.'; b.neuZeichnen(); }
          }
        },
      }) : null));

  const box = h('div.bs-datei', null, kopf);
  if (a.offen) box.appendChild(h('div.bs-datei__vorschau', null, vorschau(spec, art, b)));
  if (a.bearbeiten) box.appendChild(bearbeitenFeld(b, a, spec.inhalt, { sprache: art.name }));
  if (a.gespeichert) box.appendChild(h('p.bs-meta.bs-datei__hinweis', null, h('span.bs-ok', null, sym('haken')), text(' Gespeichert – als neue Fassung.')));
  if (a.fehler) box.appendChild(h('p.bs-fehler', { role: 'alert' }, text(a.fehler)));
  return box;
}

export const typen = {
  datei: {
    pruefen,
    render,
    text: (s) => `Datei: ${s.name}\n\n${s.inhalt}`,
  },
};

const CSS = `
.bs-datei__kopf { display: flex; align-items: center; gap: 14px; }
.bs-datei__symbol { position: relative; display: grid; place-items: center; flex: none; width: 40px; height: 44px; color: var(--fg-subtle); }
.bs-datei__symbol svg { width: 36px; height: 36px; stroke-width: 1.1; }
.bs-datei__endung { position: absolute; bottom: 5px; left: 50%; transform: translateX(-50%); padding: 1px 4px; font-size: 9px; font-weight: 700; line-height: 1.3; letter-spacing: 0.05em; white-space: nowrap; color: var(--fg); background: var(--surface-3); border: 1px solid var(--border-strong); border-radius: 4px; }
.bs-datei__text { flex: 1 1 auto; min-width: 0; }
.bs-datei__name { margin: 0 0 1px; font-size: var(--fs-md); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bs-datei__text .bs-meta { margin: 0; }
.bs-datei__knoepfe { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.bs-datei__vorschau { margin-top: 14px; animation: bs-ein var(--dur-3) var(--ease); }
.bs-datei__seite { max-height: 460px; overflow: auto; padding: 18px 20px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); }
.bs-datei__code .md-code { margin: 0; }
.bs-datei__code pre { max-height: 420px; }
.bs-datei__tabellen-rahmen { max-height: 420px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-2); }
.bs-datei__tabellen-rahmen:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-datei__tabelle { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.bs-datei__tabelle th, .bs-datei__tabelle td { padding: 7px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
.bs-datei__tabelle th { position: sticky; top: 0; font-weight: 600; color: var(--fg); background: var(--surface-2); }
.bs-datei__tabelle td { color: var(--fg-muted); }
.bs-datei__tabelle tr:last-child td { border-bottom: 0; }
.bs-datei__mehr { margin: 0; padding: 8px 12px; }
.bs-datei__hinweis { display: flex; align-items: center; gap: 4px; margin: 10px 0 0; }
.bs-datei__hinweis svg { width: 14px; height: 14px; }
.bs-sk { position: relative; width: 100%; max-height: 560px; overflow: hidden; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); }
.bs-sk .sk-rahmen { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 0; }
.bs-sk__warte { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: var(--fs-sm); color: var(--fg-muted); }
.bs-sk__warte .spinner { width: 16px; height: 16px; border-width: 2px; }
.bs-sk__warte.is-fehler { color: var(--warn); padding: 0 16px; text-align: center; }
.bs-sk__warte svg { width: 16px; height: 16px; flex: none; }
@media (max-width: 520px) { .bs-datei__kopf { flex-wrap: wrap; } .bs-datei__knoepfe { width: 100%; justify-content: flex-start; } }
`;
