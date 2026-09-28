/**
 * sandkasten.js -- die Seite der App zum Sandkasten (web/sandbox.html).
 *
 * HTML, SVG und JavaScript aus einer KI-Antwort laufen NIE im Dokument der
 * App, sondern in einem <iframe sandbox="allow-scripts"> ohne
 * allow-same-origin (undurchsichtiger Ursprung, eigene strenge CSP vom
 * Server). Dieses Modul baut den Rahmen, spricht per postMessage mit ihm
 * und nimmt Nachrichten NUR von genau diesem Rahmen an (event.source ist
 * sein contentWindow, und die Nachricht nennt die Kennung, die nur dieser
 * Rahmen in seiner Adresse bekommen hat).
 *
 *   const r = rahmen({ titel: 'Vorschau' });
 *   container.appendChild(r.element);
 *   await r.zeigen('html', '<h1>Hallo</h1>');
 *
 *   const erg = await ausfuehren('console.log(1 + 1)');
 *   // {ausgaben:[{stufe:'log', text:'2'}], grund:'ende', ms: 3}
 *
 * Grenzen, ehrlich: kein Netz (connect-src 'none'), keine externen Dateien,
 * JavaScript hoechstens 3 s (dann wird der Worker beendet).
 */

import { h, text, cx, icon } from './dom.js';

export const ZEIT_MS = 3000;
const KANAL = 'nos-sandkasten';
const BEREIT_MS = 6000;
const STYLE_ID = 'nos-sandkasten';

/** Die Adresse des Sandkastens, relativ zur App (die App kann unter einem Pfad liegen). */
export function sandkastenAdresse(kennung) {
  const basis = typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://localhost/';
  return new URL(`sandbox.html#${encodeURIComponent(kennung)}`, basis).href;
}

function neueKennung() {
  const zufall = typeof crypto !== 'undefined' && crypto.getRandomValues
    ? [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `sk${zufall}`.slice(0, 40);
}

/* Ein Zuhoerer fuer alle Rahmen: ordnet jede Nachricht ihrem Rahmen zu. */
const RAHMEN = new Map(); // kennung -> {iframe, empfangen(d)}
let zuhoererAn = false;
function zuhoeren() {
  if (zuhoererAn || typeof window === 'undefined') return;
  zuhoererAn = true;
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.kanal !== KANAL || typeof d.rahmen !== 'string') return;
    const r = RAHMEN.get(d.rahmen);
    // Nur von genau dem Rahmen, dem die Kennung gehoert.
    if (!r || !r.iframe.contentWindow || ev.source !== r.iframe.contentWindow) return;
    r.empfangen(d);
  });
}

/**
 * Masse eines SVG aus viewBox oder width/height (fuer die Hoehe des Rahmens).
 * @returns {{breite:number, hoehe:number}|null}
 */
export function svgMasse(svg) {
  const kopf = /<svg\b[^>]*>/i.exec(String(svg || ''));
  if (!kopf) return null;
  const attr = (name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(kopf[0]);
    return m ? m[1] : null;
  };
  const vb = attr('viewBox');
  if (vb) {
    const z = vb.trim().split(/[\s,]+/).map(Number);
    if (z.length === 4 && z.every(Number.isFinite) && z[2] > 0 && z[3] > 0) return { breite: z[2], hoehe: z[3] };
  }
  const b = parseFloat(attr('width'));
  const hh = parseFloat(attr('height'));
  if (Number.isFinite(b) && Number.isFinite(hh) && b > 0 && hh > 0) return { breite: b, hoehe: hh };
  return null;
}

/**
 * Einen Sandkasten-Rahmen bauen. Er laedt, sobald er im Dokument haengt.
 * @param {{titel?:string, klasse?:string, versteckt?:boolean}} [opts]
 */
export function rahmen(opts = {}) {
  zuhoeren();
  ensureStyle();
  // Rahmen, die der Chat beim Neuzeichnen verworfen hat, nicht festhalten.
  for (const [k, e] of RAHMEN) if (!e.iframe.isConnected && e.iframe.dataset.geladen) RAHMEN.delete(k);
  const kennung = neueKennung();
  const iframe = h('iframe', {
    class: cx('sk-rahmen', opts.klasse, { 'is-versteckt': !!opts.versteckt }),
    src: sandkastenAdresse(kennung),
    sandbox: 'allow-scripts',
    referrerpolicy: 'no-referrer',
    title: opts.titel || 'Vorschau im Sandkasten',
    'aria-hidden': opts.versteckt ? 'true' : null,
    tabindex: opts.versteckt ? '-1' : null,
  });
  let bereitAufloesen;
  let bereitAblehnen;
  const bereit = new Promise((ok, nein) => { bereitAufloesen = ok; bereitAblehnen = nein; });
  bereit.catch(() => {});
  let bereitTimer = null;
  const auftraege = new Map(); // auftrag -> fn(d)
  let istBereit = false;
  let zahl = 0;

  const eintrag = {
    iframe,
    empfangen(d) {
      if (d.typ === 'bereit') {
        istBereit = true;
        if (bereitTimer) clearTimeout(bereitTimer);
        bereitAufloesen();
        return;
      }
      const fn = d.auftrag ? auftraege.get(d.auftrag) : null;
      if (fn) fn(d);
    },
  };
  RAHMEN.set(kennung, eintrag);

  // Die Wartezeit beginnt erst, wenn der Rahmen im Dokument haengt (vorher laedt er nicht).
  const wacheStarten = () => {
    if (bereitTimer || istBereit) return;
    bereitTimer = setTimeout(() => {
      if (!istBereit) bereitAblehnen(new Error('Der Sandkasten antwortet nicht. Die Vorschau lässt sich hier nicht öffnen.'));
    }, BEREIT_MS);
  };
  iframe.addEventListener('load', () => { iframe.dataset.geladen = '1'; wacheStarten(); });
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { if (iframe.isConnected) wacheStarten(); });

  const posten = (d) => {
    // Ziel '*': der Sandkasten hat keinen Ursprung, den man nennen koennte.
    // Der Inhalt ist nicht geheim (es ist der Code, der dort laufen soll).
    iframe.contentWindow.postMessage({ kanal: KANAL, rahmen: kennung, ...d }, '*');
  };

  return {
    element: iframe,
    kennung,
    bereit,
    /** HTML oder SVG anzeigen. Danach ist der Rahmen nur noch Anzeige. */
    async zeigen(art, inhalt) {
      await bereit;
      const auftrag = `a${(zahl += 1)}`;
      return new Promise((ok) => {
        auftraege.set(auftrag, (d) => {
          if (d.typ === 'angezeigt') {
            auftraege.delete(auftrag);
            ok();
          }
        });
        posten({ typ: art === 'svg' ? 'svg' : 'html', inhalt: String(inhalt || ''), auftrag });
      });
    },
    /**
     * JavaScript im Worker ausfuehren.
     * @returns {Promise<{ausgaben:Array<{stufe:string,text:string}>, grund:'ende'|'zeit'|'fehler'|'gestoppt'|'keine-antwort', ms:number}>}
     */
    async ausfuehren(code, { zeitMs = ZEIT_MS, onAusgabe } = {}) {
      await bereit;
      const auftrag = `a${(zahl += 1)}`;
      const ausgaben = [];
      return new Promise((ok) => {
        let fertig = false;
        const ende = (grund, ms) => {
          if (fertig) return;
          fertig = true;
          auftraege.delete(auftrag);
          clearTimeout(notbremse);
          ok({ ausgaben, grund, ms: Number.isFinite(ms) ? ms : 0 });
        };
        // Falls der Sandkasten selbst haengt: die App wartet nicht ewig.
        const notbremse = setTimeout(() => ende('keine-antwort', zeitMs), zeitMs + 2500);
        auftraege.set(auftrag, (d) => {
          if (d.typ === 'ausgabe' || d.typ === 'ergebnis' || d.typ === 'fehler') {
            const z = {
              stufe: d.typ === 'fehler' ? 'fehler' : (d.typ === 'ergebnis' ? 'ergebnis' : String(d.stufe || 'log')),
              text: String(d.text ?? ''),
            };
            if (d.zeile) z.zeile = d.zeile;
            ausgaben.push(z);
            if (typeof onAusgabe === 'function') onAusgabe(z);
          } else if (d.typ === 'fertig') {
            ende(String(d.grund || 'ende'), Number(d.ms));
          }
        });
        posten({ typ: 'js', code: String(code || ''), auftrag, zeitMs });
      });
    },
    stoppen() {
      if (istBereit) posten({ typ: 'stopp' });
    },
    entfernen() {
      RAHMEN.delete(kennung);
      iframe.remove();
    },
  };
}

/**
 * JavaScript einmal ausfuehren, in einem unsichtbaren Rahmen, der danach
 * wieder verschwindet.
 */
export async function ausfuehren(code, opts = {}) {
  const r = rahmen({ versteckt: true, titel: 'Sandkasten' });
  document.body.appendChild(r.element);
  try {
    return await r.ausfuehren(code, opts);
  } catch (err) {
    return { ausgaben: [{ stufe: 'fehler', text: (err && err.message) || String(err) }], grund: 'fehler', ms: 0 };
  } finally {
    r.entfernen();
  }
}

/* ------------------------------------------------------------------ */
/* Anzeige fuer "Ausfuehren" unter einem Codeblock                      */
/* ------------------------------------------------------------------ */

const SYM = {
  start: '<path d="M6.6 4.4v11.2l8.8-5.6z"/>',
  stopp: '<rect x="5.2" y="5.2" width="9.6" height="9.6" rx="1.8"/>',
  zu: '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>',
};

const GRUND = {
  ende: (ms) => `Fertig · ${ms} ms`,
  fehler: () => 'Mit Fehler beendet',
  zeit: (ms, grenze) => `Abgebrochen nach ${Math.round(grenze / 1000)} s (Zeitgrenze)`,
  gestoppt: () => 'Angehalten',
  'keine-antwort': () => 'Der Sandkasten hat nicht geantwortet',
};

/**
 * "Ausführen" fuer einen Codeblock: JavaScript mit Ausgabe, HTML als
 * Vorschau. Laeuft sofort los.
 * @param {{sprache:'js'|'html', code:string, zeitMs?:number, onSchliessen?:()=>void}} opts
 * @returns {HTMLElement}
 */
export function laufAnzeige({ sprache, code, zeitMs = ZEIT_MS, onSchliessen } = {}) {
  ensureStyle();
  const istHtml = sprache === 'html';
  const status = h('span.sk-lauf__status', { role: 'status' }, text(istHtml ? 'Vorschau' : 'Läuft …'));
  const zeilen = h('div.sk-lauf__zeilen', { role: 'log', 'aria-live': 'polite' });
  const kopf = h('div.sk-lauf__kopf', null, h('span.sk-lauf__titel', null, text(istHtml ? 'Vorschau' : 'Ausgabe')), status);
  const box = h('div.sk-lauf', { class: cx({ 'is-html': istHtml }) }, kopf);
  let r = null;

  const knopf = (label, sym, fn) => h('button.sk-knopf', { type: 'button', onClick: (e) => { e.stopPropagation(); fn(); } }, icon(SYM[sym]), h('span', null, text(label)));
  const schliessen = knopf('Schließen', 'zu', () => {
    if (r) r.entfernen();
    box.remove();
    if (typeof onSchliessen === 'function') onSchliessen();
  });
  const nochmal = knopf('Nochmal', 'start', () => starten());
  const anhalten = knopf('Anhalten', 'stopp', () => {
    if (!r) return;
    if (istHtml) {
      r.entfernen();
      r = null;
      zeilen.replaceChildren(h('p.sk-lauf__leer', null, text('Angehalten.')));
      status.textContent = 'Angehalten';
      anhalten.hidden = true;
      nochmal.hidden = false;
    } else {
      r.stoppen();
    }
  });
  kopf.append(h('span.sk-lauf__knoepfe', null, anhalten, nochmal, schliessen));
  box.append(zeilen);

  const zeile = (z) => {
    zeilen.appendChild(h('div.sk-zeile', { class: `is-${z.stufe}` },
      z.stufe === 'ergebnis' ? h('span.sk-zeile__pfeil', { 'aria-hidden': 'true' }, text('←')) : null,
      h('span', null, text(z.zeile ? `${z.text}  (Zeile ${z.zeile})` : z.text))));
  };

  async function starten() {
    if (r) r.entfernen();
    zeilen.replaceChildren();
    nochmal.hidden = true;
    anhalten.hidden = false;
    r = rahmen({ versteckt: !istHtml, titel: istHtml ? 'HTML-Vorschau' : 'Sandkasten' });
    if (istHtml) {
      zeilen.appendChild(r.element);
      status.textContent = 'Vorschau';
      try {
        await r.zeigen('html', code);
      } catch (err) {
        zeilen.replaceChildren(h('div.sk-zeile.is-fehler', null, text((err && err.message) || 'Die Vorschau ließ sich nicht öffnen.')));
        anhalten.hidden = true;
        nochmal.hidden = false;
      }
      return;
    }
    document.body.appendChild(r.element);
    status.textContent = 'Läuft …';
    let erg;
    try {
      erg = await r.ausfuehren(code, { zeitMs, onAusgabe: zeile });
    } catch (err) {
      erg = { ausgaben: [], grund: 'fehler', ms: 0 };
      zeile({ stufe: 'fehler', text: (err && err.message) || String(err) });
    }
    if (r) r.entfernen();
    r = null;
    if (!erg.ausgaben.length && erg.grund === 'ende') zeilen.appendChild(h('p.sk-lauf__leer', null, text('Keine Ausgabe.')));
    status.textContent = (GRUND[erg.grund] || GRUND.ende)(erg.ms, zeitMs);
    status.classList.toggle('is-fehler', erg.grund !== 'ende' && erg.grund !== 'gestoppt');
    anhalten.hidden = true;
    nochmal.hidden = false;
  }
  starten();
  return box;
}

/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || !document.head || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

// Der Rahmen hat einen weissen Grund, mit Absicht und als einzige feste
// Farbe hier: HTML aus einer Antwort rechnet (wie jede Webseite) mit dem
// weissen Papier des Browsers; auf dem dunklen Grund der App waere schwarzer
// Text unsichtbar. Setzt die Seite selbst einen Hintergrund, liegt er darueber.
const CSS = `
.sk-rahmen { display: block; width: 100%; height: 360px; border: 0; border-radius: var(--r-2); background: #fff; color-scheme: light; }
.sk-rahmen.is-versteckt { position: fixed; left: -10000px; top: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.sk-lauf { margin-top: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; }
.sk-lauf__kopf { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--border); }
.sk-lauf__titel { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-subtle); }
.sk-lauf__status { font-size: var(--fs-xs); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.sk-lauf__status.is-fehler { color: var(--warn); }
.sk-lauf__knoepfe { display: flex; gap: 2px; margin-left: auto; }
.sk-knopf { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 8px; font: inherit; font-size: var(--fs-xs); color: var(--fg-muted); background: none; border: 0; border-radius: var(--r-1); cursor: pointer; }
.sk-knopf:hover { color: var(--fg); background: var(--surface-3); }
.sk-knopf:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.sk-knopf svg { width: 13px; height: 13px; }
.sk-lauf__zeilen { max-height: 280px; overflow: auto; padding: 8px 0; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.55; }
.sk-lauf.is-html .sk-lauf__zeilen { max-height: none; padding: 0; }
.sk-lauf.is-html .sk-rahmen { border-radius: 0; }
.sk-zeile { display: flex; gap: 8px; padding: 1px 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
.sk-zeile.is-warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); }
.sk-zeile.is-error, .sk-zeile.is-fehler { color: var(--danger); background: var(--danger-soft); }
.sk-zeile.is-ergebnis { color: var(--fg-muted); }
.sk-zeile__pfeil { color: var(--fg-subtle); }
.sk-lauf__leer { margin: 0; padding: 2px 12px; color: var(--fg-subtle); font-family: var(--font-sans); }
@media (pointer: coarse) { .sk-knopf { min-height: var(--tap-min); padding: 0 12px; } }
`;
