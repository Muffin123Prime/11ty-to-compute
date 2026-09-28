/**
 * bausteine/karten.js -- Karten im Raster oder als Karussell.
 *
 * Fuer Dinge, die nebeneinander gehoeren: Optionen mit ein paar Zeilen
 * Beschreibung, Rezepte, Reiseziele, Werkzeuge. Hat eine Karte eine
 * `aktion`, ist die GANZE Karte antippbar (ein Knopf oder ein Link) -- ein
 * kleiner Knopf unten in einer grossen Karte ist auf dem iPad eine
 * Suchaufgabe.
 */

import { h, text, cx } from '../dom.js';
import { safeUrl } from '../markdown.js';
import { str, liste, wahl, objekt, LAENGE, symbolPruefen, kartenSymbol, sym, inline, ensureStyle, spinner } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-karten';

function kartePruefen(roh) {
  const x = objekt(roh);
  if (!x) return null;
  const titel = str(x.titel, 120);
  if (!titel) return null;
  const k = { titel };
  const s = symbolPruefen(x.symbol);
  if (s) k.symbol = s;
  const t = str(x.text, 600);
  if (t) k.text = t;
  const zeilen = Array.isArray(x.zeilen) ? x.zeilen.slice(0, 6).map((z) => str(z, 160)).filter(Boolean) : [];
  if (zeilen.length) k.zeilen = zeilen;
  const a = objekt(x.aktion);
  if (a) {
    const at = str(a.text, 60);
    const link = typeof a.link === 'string' && safeUrl(a.link) ? str(a.link, 2000) : '';
    const senden = str(a.senden, LAENGE.text);
    if (at && (link || senden || !a.link)) {
      k.aktion = { text: at };
      if (link) k.aktion.link = link;
      else k.aktion.senden = senden || at;
    }
  }
  return k;
}

function pruefen(roh) {
  return {
    layout: wahl(roh.layout, ['raster', 'karussell'], 'raster'),
    karten: liste(roh.karten, 'karten', { min: 1, max: 12, je: kartePruefen }),
  };
}

function karteInhalt(k) {
  return [
    k.symbol ? h('span.bs-karte__symbol', { 'aria-hidden': 'true' }, kartenSymbol(k.symbol)) : null,
    h('span.bs-karte__titel', null, inline(k.titel, { ohneLinks: true })),
    k.text ? h('span.bs-karte__text', null, inline(k.text, { ohneLinks: !!k.aktion })) : null,
    k.zeilen ? h('span.bs-karte__zeilen', null, k.zeilen.map((z) => h('span.bs-karte__zeile', null, inline(z, { ohneLinks: !!k.aktion })))) : null,
  ];
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const z = b.zustand.lesen();
  const a = b.ansicht;
  const benutzt = new Set(Array.isArray(z.benutzt) ? z.benutzt : []);
  const karussell = spec.layout === 'karussell';
  const bahn = h(`div.bs-karten__${karussell ? 'bahn' : 'raster'}`, karussell ? { role: 'list', tabindex: '0', 'aria-label': 'Karten, waagrecht blätterbar' } : { role: 'list' });

  spec.karten.forEach((k, i) => {
    let karte;
    const klasse = cx('bs-karte', { 'is-aktion': !!k.aktion, 'is-benutzt': benutzt.has(i) });
    const fuss = k.aktion ? h('span.bs-karte__aktion', null, h('span', null, text(k.aktion.text)), a.sendet === i ? spinner() : sym(k.aktion.link && safeUrl(k.aktion.link)?.external ? 'extern' : 'pfeil')) : null;
    if (k.aktion && k.aktion.link) {
      const ziel = safeUrl(k.aktion.link);
      karte = h('a', {
        class: klasse,
        href: ziel.href,
        target: ziel.external ? '_blank' : null,
        rel: ziel.external ? 'noopener noreferrer nofollow' : null,
        'data-key': b.key(`k:${i}`),
        title: ziel.external ? `Öffnet ${ziel.host || ziel.href} im Browser` : null,
        onClick: (e) => e.stopPropagation(),
      }, karteInhalt(k), fuss);
    } else if (k.aktion && b.kannSenden) {
      karte = h('button', {
        type: 'button',
        class: klasse,
        disabled: a.sendet === i,
        'data-key': b.key(`k:${i}`),
        onClick: async (e) => {
          e.stopPropagation();
          a.sendet = i;
          a.fehler = null;
          b.zustand.setzen({ benutzt: [...new Set([...benutzt, i])] }, { verlauf: false });
          try {
            await b.senden(k.aktion.senden);
          } catch (err) {
            a.fehler = (err && err.message) || 'Das ließ sich nicht senden.';
            b.zustand.setzen({ benutzt: [...benutzt].filter((x) => x !== i) }, { verlauf: false, zeichnen: false });
          }
          a.sendet = null;
          b.neuZeichnen();
        },
      }, karteInhalt(k), fuss);
    } else {
      karte = h('div', { class: cx('bs-karte') }, karteInhalt(k));
    }
    bahn.appendChild(h('div.bs-karten__platz', { role: 'listitem' }, karte));
  });

  const box = h('div.bs-karten', { class: cx({ 'is-karussell': karussell }) }, bahn);
  if (karussell && spec.karten.length > 1) {
    const zurueck = h('button.bs-karten__blaettern.is-links', { type: 'button', 'aria-label': 'Vorige Karten', title: 'Vorige', 'data-key': b.key('zurueck') }, sym('links'));
    const weiter = h('button.bs-karten__blaettern.is-rechts', { type: 'button', 'aria-label': 'Nächste Karten', title: 'Nächste', 'data-key': b.key('weiter') }, sym('rechts'));
    const schritt = () => Math.max(200, bahn.clientWidth * 0.85);
    const lage = () => {
      const max = bahn.scrollWidth - bahn.clientWidth - 2;
      zurueck.hidden = bahn.scrollLeft <= 2;
      weiter.hidden = bahn.scrollLeft >= max;
      a.scroll = bahn.scrollLeft;
    };
    zurueck.addEventListener('click', (e) => { e.stopPropagation(); bahn.scrollBy({ left: -schritt(), behavior: 'smooth' }); });
    weiter.addEventListener('click', (e) => { e.stopPropagation(); bahn.scrollBy({ left: schritt(), behavior: 'smooth' }); });
    bahn.addEventListener('scroll', lage, { passive: true });
    bahn.addEventListener('keydown', (e) => {
      if (e.target !== bahn) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); bahn.scrollBy({ left: schritt(), behavior: 'smooth' }); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); bahn.scrollBy({ left: -schritt(), behavior: 'smooth' }); }
    });
    zurueck.hidden = true;
    box.append(zurueck, weiter);
    // Nach dem Einhaengen: alte Rollposition wieder her und Pfeile richtig stellen.
    requestAnimationFrame(() => {
      if (a.scroll) bahn.scrollLeft = a.scroll;
      lage();
    });
  }
  if (a.fehler) box.appendChild(h('p.bs-fehler', { role: 'alert' }, text(a.fehler)));
  return box;
}

export const typen = {
  karten: {
    pruefen,
    render,
    flach: true,
    text: (s) => s.karten.map((k) => [k.titel, k.text || '', ...(k.zeilen || [])].filter(Boolean).join('\n')).join('\n\n'),
  },
};

const CSS = `
.bs-karten { position: relative; }
.bs-karten__raster { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
.bs-karten__bahn { display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding: 0 2px; padding: 2px 2px 8px; margin: -2px -2px -8px; scrollbar-width: none; }
.bs-karten__bahn::-webkit-scrollbar { display: none; }
.bs-karten__bahn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); border-radius: var(--r-3); }
.bs-karten__bahn .bs-karten__platz { flex: 0 0 min(250px, 78%); scroll-snap-align: start; }
.bs-karten__platz { display: flex; min-width: 0; }
.bs-karte { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; width: 100%; min-height: 100%; padding: 16px; font: inherit; text-align: left; color: var(--fg); text-decoration: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); box-shadow: var(--shadow-card); transition: border-color var(--dur-2) var(--ease), background var(--dur-2) var(--ease), transform var(--dur-2) var(--ease); -webkit-tap-highlight-color: transparent; }
.bs-karte.is-aktion { cursor: pointer; }
.bs-karte.is-aktion:hover { border-color: var(--border-strong); background: var(--surface-2); }
.bs-karte.is-aktion:active { transform: scale(0.99); }
.bs-karte:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-karte.is-benutzt { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.bs-karte__symbol { display: grid; place-items: center; width: 34px; height: 34px; margin-bottom: 4px; color: var(--accent-text); background: var(--accent-soft); border-radius: 50%; }
.bs-karte__symbol svg { width: 18px; height: 18px; }
.bs-karte__titel { font-size: var(--fs-md); font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.bs-karte__text { font-size: var(--fs-sm); line-height: 1.5; color: var(--fg-muted); overflow-wrap: anywhere; }
.bs-karte__zeilen { display: flex; flex-direction: column; gap: 3px; width: 100%; padding-top: 6px; margin-top: 2px; border-top: 1px solid var(--border); }
.bs-karte__zeile { font-size: var(--fs-sm); line-height: 1.45; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.bs-karte__aktion { display: inline-flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 10px; font-size: var(--fs-sm); font-weight: 500; color: var(--accent-text); }
.bs-karte__aktion svg { width: 15px; height: 15px; transition: transform var(--dur-2) var(--ease); }
.bs-karte.is-aktion:hover .bs-karte__aktion svg { transform: translateX(2px); }
.bs-karte__aktion .spinner { width: 14px; height: 14px; border-width: 2px; }
.bs-karten__blaettern { position: absolute; top: 50%; z-index: 1; display: grid; place-items: center; width: 34px; height: 34px; padding: 0; color: var(--fg); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 50%; box-shadow: var(--shadow-2); cursor: pointer; transform: translateY(-50%); transition: opacity var(--dur-2) var(--ease), background var(--dur-1) var(--ease); }
.bs-karten__blaettern:hover { background: var(--surface-3); }
.bs-karten__blaettern:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-karten__blaettern svg { width: 16px; height: 16px; }
.bs-karten__blaettern.is-links { left: -12px; }
.bs-karten__blaettern.is-rechts { right: -12px; }
@media (pointer: coarse) {
  .bs-karten__blaettern { width: var(--tap-min); height: var(--tap-min); }
  .bs-karten__blaettern.is-links { left: -8px; }
  .bs-karten__blaettern.is-rechts { right: -8px; }
}
`;
