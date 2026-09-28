/**
 * auswahl-menue.js -- kleine schwebende Menues im Chat.
 *
 * Zwei Dinge, die dieselbe Mechanik brauchen (Lage am Bildschirmrand,
 * Schliessen bei Klick daneben, Esc, Tastatur):
 *
 * - `menue()`: das Aufklappmenue einer Leiste ("Neu erstellen ▾",
 *   "Umwandeln ▾"), mit Untermenue ("Übersetzen ›" -> Sprachen) an Ort und
 *   Stelle statt eines zweiten Menues daneben -- auf dem iPad gibt es kein
 *   Ueberfahren, das ein seitliches Untermenue oeffnen koennte.
 * - `auswahlMenue()`: die Leiste ueber markiertem Text einer Antwort
 *   (Erklären, Kürzen, Umschreiben, Übersetzen ▾, Verbessern, Zusammenfassen,
 *   Frage dazu). Mit der Maus steht sie UEBER der Markierung, mit dem Finger
 *   DARUNTER: dort, wo iPadOS sein eigenes Menue (Kopieren, Nachschlagen)
 *   zeigt, waere sie verdeckt.
 *
 * Der markierte Text wird beim Erscheinen festgehalten: ein Tippen auf die
 * Leiste darf die Markierung aufheben, gemeint ist trotzdem, was markiert war.
 * Alles DOM ueber web/lib/dom.js, Texte nie als HTML.
 */

import { h, text, icon, cx } from './dom.js';

const STYLE_ID = 'nos-auswahl-menue';
const RAND = 8;

const SYM = {
  zurueck: '<path d="m12.4 5.4-4.6 4.6 4.6 4.6"/>',
  weiter: '<path d="m7.6 5.4 4.6 4.6-4.6 4.6"/>',
  runter: '<path d="m5.8 8 4.2 4.2L14.2 8"/>',
};

/* ------------------------------------------------------------------ */
/* Lage                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Wohin ein schwebendes Element mit Groesse `groesse` neben `rect` kommt:
 * bevorzugt `seite` ('unten' | 'oben'), sonst die andere Seite, immer ganz
 * im Fenster. Rein, damit es pruefbar ist.
 * @returns {{links:number, oben:number, seite:'unten'|'oben'}}
 */
export function lage(rect, groesse, fenster, { seite = 'unten', ausrichtung = 'links', abstand = 6 } = {}) {
  const platzUnten = fenster.hoehe - rect.bottom - abstand - RAND;
  const platzOben = rect.top - abstand - RAND;
  let s = seite;
  if (s === 'unten' && platzUnten < groesse.hoehe && platzOben > platzUnten) s = 'oben';
  if (s === 'oben' && platzOben < groesse.hoehe && platzUnten > platzOben) s = 'unten';
  let oben = s === 'unten' ? rect.bottom + abstand : rect.top - abstand - groesse.hoehe;
  oben = Math.max(RAND, Math.min(fenster.hoehe - groesse.hoehe - RAND, oben));
  let links = ausrichtung === 'mitte'
    ? rect.left + rect.width / 2 - groesse.breite / 2
    : (ausrichtung === 'rechts' ? rect.right - groesse.breite : rect.left);
  links = Math.max(RAND, Math.min(fenster.breite - groesse.breite - RAND, links));
  return { links: Math.round(links), oben: Math.round(oben), seite: s };
}

function fenster() {
  const vv = window.visualViewport;
  return { breite: vv ? vv.width : window.innerWidth, hoehe: vv ? vv.height : window.innerHeight };
}

function grobZeiger() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/* ------------------------------------------------------------------ */
/* Aufklappmenue                                                        */
/* ------------------------------------------------------------------ */

let offenesMenue = null;

/** Ist gerade ein Menue offen? */
export function menueOffen() {
  return !!offenesMenue;
}

/** Das offene Menue schliessen (z. B. wenn die Ansicht geht). */
export function menueSchliessen() {
  if (offenesMenue) offenesMenue.schliessen();
}

/**
 * Ein Aufklappmenue an einem Knopf.
 *
 * @param {{
 *   anker: Element,
 *   titel?: string,
 *   eintraege: Array<{label?:string, gruppe?:string, trenner?:boolean, untermenue?:Array, titel?:string,
 *     aktion?:() => void, deaktiviert?:boolean, hinweis?:string, id?:string}>,
 *   ausrichtung?: 'links'|'rechts',
 *   onSchliessen?: () => void,
 * }} o
 * @returns {{element:HTMLElement, schliessen:() => void}}
 */
export function menue(o) {
  ensureStyle();
  menueSchliessen();
  const stapel = [{ titel: o.titel || '', eintraege: o.eintraege }];
  const box = h('div.am', { role: 'menu', 'aria-label': o.titel || 'Menü', tabindex: '-1' });
  let zu = false;

  function knoepfe() {
    return [...box.querySelectorAll('.am__eintrag:not(:disabled)')];
  }

  function zeichnen() {
    const ebene = stapel[stapel.length - 1];
    box.replaceChildren();
    if (stapel.length > 1) {
      box.appendChild(h('button.am__eintrag.am__zurueck', {
        type: 'button',
        role: 'menuitem',
        onClick: (e) => { e.stopPropagation(); stapel.pop(); zeichnen(); fokus(0); },
      }, icon(SYM.zurueck), h('span', null, text(ebene.titel || 'Zurück'))));
      box.appendChild(h('div.am__trenner', { role: 'separator' }));
    }
    for (const ein of ebene.eintraege) {
      if (!ein) continue;
      if (ein.trenner) {
        box.appendChild(h('div.am__trenner', { role: 'separator' }));
        continue;
      }
      if (ein.gruppe) {
        box.appendChild(h('div.am__gruppe', { role: 'presentation' }, text(ein.gruppe)));
        continue;
      }
      const hatUnter = Array.isArray(ein.untermenue);
      box.appendChild(h('button.am__eintrag', {
        type: 'button',
        role: 'menuitem',
        disabled: !!ein.deaktiviert,
        title: ein.hinweis || null,
        'aria-haspopup': hatUnter ? 'menu' : null,
        dataset: ein.id ? { id: ein.id } : null,
        onClick: (e) => {
          e.stopPropagation();
          if (hatUnter) {
            stapel.push({ titel: ein.titel || ein.label, eintraege: ein.untermenue });
            zeichnen();
            fokus(0);
            return;
          }
          schliessen({ zurueck: false });
          if (typeof ein.aktion === 'function') ein.aktion();
        },
      }, h('span.am__label', null, text(ein.label || '')), hatUnter ? icon(SYM.weiter) : null));
    }
    platzieren();
  }

  function fokus(i) {
    const k = knoepfe();
    if (!k.length) {
      box.focus({ preventScroll: true });
      return;
    }
    const n = ((i % k.length) + k.length) % k.length;
    k[n].focus({ preventScroll: true });
  }

  function platzieren() {
    if (!box.isConnected) return;
    const r = o.anker.getBoundingClientRect();
    const g = { breite: box.offsetWidth, hoehe: box.offsetHeight };
    const l = lage(r, g, fenster(), { seite: 'unten', ausrichtung: o.ausrichtung || 'links' });
    box.style.left = `${l.links}px`;
    box.style.top = `${l.oben}px`;
    box.dataset.seite = l.seite;
  }

  const draussen = (e) => {
    if (box.contains(e.target) || o.anker.contains(e.target)) return;
    schliessen({ zurueck: false });
  };
  const rollen = (e) => {
    if (e.target && e.target.nodeType === 1 && box.contains(e.target)) return;
    schliessen({ zurueck: false });
  };
  const taste = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (stapel.length > 1) {
        stapel.pop();
        zeichnen();
        fokus(0);
      } else {
        schliessen({ zurueck: true });
      }
      return;
    }
    const k = knoepfe();
    const i = k.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); fokus(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); fokus(i < 0 ? -1 : i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); fokus(0); }
    else if (e.key === 'End') { e.preventDefault(); fokus(-1); }
    else if (e.key === 'ArrowRight' && document.activeElement && document.activeElement.getAttribute('aria-haspopup')) {
      e.preventDefault();
      document.activeElement.click();
    } else if (e.key === 'ArrowLeft' && stapel.length > 1) {
      e.preventDefault();
      stapel.pop();
      zeichnen();
      fokus(0);
    } else if (e.key === 'Tab') {
      schliessen({ zurueck: false });
    }
  };

  function schliessen({ zurueck = false } = {}) {
    if (zu) return;
    zu = true;
    document.removeEventListener('pointerdown', draussen, true);
    window.removeEventListener('scroll', rollen, true);
    window.removeEventListener('resize', rollen);
    box.remove();
    o.anker.setAttribute('aria-expanded', 'false');
    if (offenesMenue && offenesMenue.element === box) offenesMenue = null;
    if (zurueck && o.anker.isConnected) o.anker.focus({ preventScroll: true });
    if (typeof o.onSchliessen === 'function') o.onSchliessen();
  }

  box.addEventListener('keydown', taste);
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  box.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(box);
  o.anker.setAttribute('aria-expanded', 'true');
  zeichnen();
  // Erst nach diesem Klick zuhoeren, sonst schloesse er das Menue gleich wieder.
  setTimeout(() => {
    if (zu) return;
    document.addEventListener('pointerdown', draussen, true);
    window.addEventListener('scroll', rollen, true);
    window.addEventListener('resize', rollen);
  }, 0);
  fokus(0);
  offenesMenue = { element: box, schliessen: () => schliessen({ zurueck: false }) };
  return offenesMenue;
}

/* ------------------------------------------------------------------ */
/* Leiste ueber markiertem Text                                         */
/* ------------------------------------------------------------------ */

/**
 * Die Leiste fuer markierten Text in einem Bereich.
 *
 * @param {{
 *   wurzel: Element,
 *   pruefen: (range: Range) => (object|null),   // was markiert ist (Nachricht, Text) oder null = keine Leiste
 *   eintraege: (info: object) => Array<{id:string, label:string, untermenue?:Array<{label:string, wert:any}>}>,
 *   beiAktion: (id: string, info: object, wert?: any) => void,
 * }} o
 * @returns {{weg: () => void, schliessen: () => void, offen: () => boolean}}
 */
export function auswahlMenue(o) {
  ensureStyle();
  let leiste = null;
  let info = null;
  let geplant = null;
  let weg = false;

  function schliessen() {
    if (leiste) leiste.remove();
    leiste = null;
    info = null;
  }

  function markierung() {
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!o.wurzel.contains(range.commonAncestorContainer)) return null;
    const t = String(sel).trim();
    if (t.replace(/\s/g, '').length < 2) return null;
    return range;
  }

  function zeigen() {
    geplant = null;
    if (weg) return;
    const range = markierung();
    if (!range) {
      // Waehrend jemand in der Leiste tippt, bleibt sie stehen.
      if (leiste && leiste.contains(document.activeElement)) return;
      schliessen();
      return;
    }
    const neu = o.pruefen(range);
    if (!neu) {
      schliessen();
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    if (leiste && info && info.text === neu.text) {
      platzieren(rect);
      return;
    }
    schliessen();
    info = neu;
    leiste = bauen(neu);
    document.body.appendChild(leiste);
    platzieren(rect);
  }

  function bauen(i) {
    const bar = h('div.am-leiste', { role: 'toolbar', 'aria-label': 'Markierter Text' });
    // Die Markierung soll beim Tippen auf die Leiste bleiben (Maus).
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => e.stopPropagation());
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        schliessen();
        return;
      }
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const k = [...bar.querySelectorAll('button')];
      const n = k.indexOf(document.activeElement);
      if (n < 0) return;
      e.preventDefault();
      k[(n + (e.key === 'ArrowRight' ? 1 : -1) + k.length) % k.length].focus();
    });
    for (const ein of o.eintraege(i)) {
      const hatUnter = Array.isArray(ein.untermenue);
      const knopf = h('button.am-leiste__knopf', {
        type: 'button',
        dataset: { id: ein.id },
        'aria-haspopup': hatUnter ? 'menu' : null,
        onClick: (e) => {
          e.stopPropagation();
          const festgehalten = info;
          if (!festgehalten) return;
          if (hatUnter) {
            menue({
              anker: knopf,
              titel: ein.label,
              eintraege: ein.untermenue.map((u) => ({
                label: u.label,
                aktion: () => {
                  schliessen();
                  o.beiAktion(ein.id, festgehalten, u.wert);
                },
              })),
            });
            return;
          }
          schliessen();
          o.beiAktion(ein.id, festgehalten);
        },
      }, h('span', null, text(ein.label)), hatUnter ? icon(SYM.runter) : null);
      bar.appendChild(knopf);
    }
    return bar;
  }

  function platzieren(rect) {
    if (!leiste) return;
    const g = { breite: leiste.offsetWidth, hoehe: leiste.offsetHeight };
    const finger = grobZeiger();
    // Mit dem Finger unter die Markierung (iPadOS zeigt sein Menue darueber)
    // und mit mehr Abstand, damit die Anfasser der Markierung frei bleiben.
    const l = lage(rect, g, fenster(), { seite: finger ? 'unten' : 'oben', ausrichtung: 'mitte', abstand: finger ? 22 : 8 });
    leiste.style.left = `${l.links}px`;
    leiste.style.top = `${l.oben}px`;
    leiste.dataset.seite = l.seite;
  }

  function planen() {
    if (geplant) clearTimeout(geplant);
    geplant = setTimeout(zeigen, 160);
  }

  const beiRollen = () => {
    if (!leiste) return;
    const range = markierung();
    if (!range) {
      schliessen();
      return;
    }
    platzieren(range.getBoundingClientRect());
  };
  const beiTaste = (e) => {
    if (e.key === 'Escape' && leiste) schliessen();
  };

  document.addEventListener('selectionchange', planen);
  window.addEventListener('scroll', beiRollen, true);
  window.addEventListener('resize', beiRollen);
  document.addEventListener('keydown', beiTaste);

  return {
    offen: () => !!leiste,
    schliessen,
    weg() {
      weg = true;
      if (geplant) clearTimeout(geplant);
      document.removeEventListener('selectionchange', planen);
      window.removeEventListener('scroll', beiRollen, true);
      window.removeEventListener('resize', beiRollen);
      document.removeEventListener('keydown', beiTaste);
      schliessen();
      menueSchliessen();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Gestaltung                                                           */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || !document.head || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const CSS = `
.am { position: fixed; z-index: 60; display: flex; flex-direction: column; min-width: 200px; max-width: min(320px, calc(100vw - 16px)); max-height: min(420px, calc(100vh - 16px)); overflow-y: auto; padding: 5px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-3); box-shadow: var(--shadow-3); animation: am-ein var(--dur-2) var(--ease); }
.am:focus { outline: none; }
.am__eintrag { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; padding: 6px 10px; font: inherit; font-size: var(--fs-base); text-align: left; color: var(--fg); background: none; border: 0; border-radius: var(--r-1); cursor: pointer; -webkit-tap-highlight-color: transparent; }
.am__eintrag:hover:not(:disabled), .am__eintrag:focus-visible { outline: none; background: var(--surface-3); }
.am__eintrag:disabled { color: var(--fg-subtle); cursor: default; }
.am__eintrag svg { width: 15px; height: 15px; flex: none; color: var(--fg-subtle); }
.am__zurueck { justify-content: flex-start; color: var(--fg-muted); }
.am__label { min-width: 0; }
.am__gruppe { padding: 8px 10px 4px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-subtle); }
.am__trenner { height: 1px; margin: 4px 6px; background: var(--border); }
.am-leiste { position: fixed; z-index: 60; display: flex; align-items: center; gap: 1px; max-width: calc(100vw - 16px); overflow-x: auto; padding: 4px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-3); box-shadow: var(--shadow-3); animation: am-ein var(--dur-2) var(--ease); scrollbar-width: none; }
.am-leiste::-webkit-scrollbar { display: none; }
.am-leiste__knopf { display: inline-flex; align-items: center; gap: 4px; flex: none; min-height: 32px; padding: 0 10px; font: inherit; font-size: var(--fs-sm); font-weight: 500; color: var(--fg); background: none; border: 0; border-radius: var(--r-2); cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent; }
.am-leiste__knopf:hover, .am-leiste__knopf:focus-visible { outline: none; background: var(--surface-3); }
.am-leiste__knopf[aria-expanded="true"] { background: var(--surface-3); }
.am-leiste__knopf svg { width: 14px; height: 14px; color: var(--fg-subtle); }
@keyframes am-ein { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
@media (pointer: coarse) {
  .am__eintrag { min-height: var(--tap-min); padding: 0 14px; }
  .am-leiste__knopf { min-height: var(--tap-min); padding: 0 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .am, .am-leiste { animation: none; }
}
`;
