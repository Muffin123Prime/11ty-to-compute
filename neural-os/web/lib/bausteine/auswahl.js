/**
 * bausteine/auswahl.js -- EINE Auswahl-Komponente fuer alles, was waehlen
 * laesst: den Baustein `auswahl` (Knoepfe, Liste, Umfrage, Bestaetigung,
 * Aufklappliste ab 7 Optionen), den Baustein `aktionen` (Knopfreihe fuer
 * Folgeschritte) und die Rueckfrage mitten im Zug (Werkzeug `rueckfrage`,
 * gezeichnet von web/views/chat.js ueber `auswahlKarte`).
 *
 * Warum eine: Eine Rueckfrage und eine Auswahl in der Antwort sind fuer den
 * Nutzer dasselbe -- er tippt eine Option an. Sahen sie verschieden aus oder
 * verhielten sich verschieden (Tasten 1-9 hier, dort nicht), muesste er zwei
 * Dinge lernen. Der Unterschied liegt nur darin, WOHIN die Wahl geht
 * (`onWaehlen`): an /rueckfrage oder als neue Nachricht.
 */

import { h, text, cx } from '../dom.js';
import {
  str, bool, zahl, liste, wahl, objekt, fehler, LAENGE, symbolPruefen, kartenSymbol,
  sym, knopf, inline, ensureStyle, spinner, zahlDeutsch, fokusSpaeter,
} from './gemeinsam.js';

const STYLE_ID = 'nos-bs-auswahl';
const STILE = ['knoepfe', 'liste', 'umfrage', 'bestaetigung'];
/** Ab so vielen Optionen wird aus Knoepfen eine Aufklappliste (Plan, Abschnitt 2). */
export const KNOEPFE_MAX = 6;

/* ------------------------------------------------------------------ */
/* Pruefen                                                              */
/* ------------------------------------------------------------------ */

function optionPruefen(o, mitStimmen) {
  if (typeof o === 'string' || typeof o === 'number') {
    const t = str(o, 160);
    return t ? { text: t } : null;
  }
  const x = objekt(o);
  if (!x) return null;
  const t = str(x.text ?? x.label, 160);
  if (!t) return null;
  const out = { text: t };
  const beschreibung = str(x.beschreibung, 300);
  if (beschreibung) out.beschreibung = beschreibung;
  const senden = str(x.senden, LAENGE.text);
  if (senden) out.senden = senden;
  if (mitStimmen) {
    const s = zahl(x.stimmen, { min: 0, max: 1e9, ganz: true });
    if (s !== null) out.stimmen = s;
  }
  return out;
}

function auswahlPruefen(roh) {
  const stil = wahl(roh.stil, STILE, 'knoepfe');
  const optionen = liste(roh.optionen, 'optionen', {
    min: stil === 'bestaetigung' ? 2 : 1,
    max: 30,
    je: (o) => optionPruefen(o, stil === 'umfrage'),
  });
  // Doppelte Beschriftungen waeren nach dem Senden nicht mehr zu unterscheiden.
  const gesehen = new Set();
  const eindeutig = optionen.filter((o) => (gesehen.has(o.text) ? false : gesehen.add(o.text)));
  if (eindeutig.length < (stil === 'bestaetigung' ? 2 : 1)) throw fehler('„optionen“ braucht verschiedene Einträge.');
  const out = {
    stil,
    optionen: stil === 'bestaetigung' ? eindeutig.slice(0, 2) : eindeutig,
    mehrfach: stil === 'bestaetigung' ? false : bool(roh.mehrfach, false),
    eigene: stil === 'knoepfe' || stil === 'liste' ? bool(roh.eigene, true) : bool(roh.eigene, false) && stil !== 'bestaetigung',
  };
  const frage = str(roh.frage, 300);
  if (frage) out.frage = frage;
  const k = str(roh.knopf, 40);
  if (k) out.knopf = k;
  const senden = str(roh.senden, LAENGE.text);
  if (senden) out.senden = senden;
  return out;
}

function aktionPruefen(o) {
  if (typeof o === 'string') {
    const t = str(o, 80);
    return t ? { text: t } : null;
  }
  const x = objekt(o);
  if (!x) return null;
  const t = str(x.text ?? x.label, 80);
  if (!t) return null;
  const out = { text: t };
  const s = symbolPruefen(x.symbol);
  if (s) out.symbol = s;
  const senden = str(x.senden, LAENGE.text);
  if (senden) out.senden = senden;
  return out;
}

function aktionenPruefen(roh) {
  const aktionen = liste(roh.aktionen, 'aktionen', { min: 1, max: 4, je: aktionPruefen });
  const out = { aktionen };
  const frage = str(roh.frage, 300);
  if (frage) out.frage = frage;
  return out;
}

/* ------------------------------------------------------------------ */
/* Reine Helfer                                                         */
/* ------------------------------------------------------------------ */

/**
 * Was nach einer Wahl als Nachricht an die KI geht.
 * Einzeln: `senden` der Option, sonst die Vorlage mit {auswahl}, sonst der
 * Text. Mehrfach: die Texte mit Komma, durch die Vorlage.
 */
export function auswahlNachricht(spec, gewaehlt, { eigene = false } = {}) {
  const texte = (Array.isArray(gewaehlt) ? gewaehlt : [gewaehlt]).map((t) => String(t));
  if (!eigene && texte.length === 1) {
    const opt = (spec.optionen || []).find((o) => o.text === texte[0]);
    if (opt && opt.senden) return opt.senden;
  }
  const verbunden = texte.join(', ');
  return spec.senden ? spec.senden.split('{auswahl}').join(verbunden) : verbunden;
}

/**
 * Ergebnis einer Umfrage: die Stimmen aus dem JSON (falls die KI welche
 * nennt) plus die eigene. Ohne fremde Stimmen ist das ehrlich 100 % fuer
 * die eigene Wahl -- es wird nichts erfunden.
 */
export function umfrageErgebnis(optionen, gewaehlt) {
  const wahlSet = new Set(gewaehlt || []);
  const zaehler = optionen.map((o) => (o.stimmen || 0) + (wahlSet.has(o.text) ? 1 : 0));
  const summe = zaehler.reduce((a, b) => a + b, 0);
  return optionen.map((o, i) => ({
    text: o.text,
    stimmen: zaehler[i],
    anteil: summe ? zaehler[i] / summe : 0,
    eigene: wahlSet.has(o.text),
  }));
}

/* ------------------------------------------------------------------ */
/* Die Komponente                                                       */
/* ------------------------------------------------------------------ */

/**
 * Die Auswahl-Karte. Reines Zeichnen: sie haelt keinen eigenen Zustand,
 * sondern bekommt ihn (`status`, `gewaehlt`, `entwurf`) und meldet
 * Aenderungen (`neuZeichnen`, `onWaehlen`). So ueberlebt sie den Neubau der
 * Nachricht im Chat.
 *
 * @param {{
 *   frage?:string, optionen:Array<{text:string, beschreibung?:string, stimmen?:number}>,
 *   mehrfach?:boolean, eigene?:boolean, stil?:'knoepfe'|'liste'|'umfrage'|'bestaetigung', knopf?:string,
 *   status?:'offen'|'gesendet'|'uebergangen'|'geschlossen', gewaehlt?:string[], eigeneAntwort?:string|null,
 *   sendet?:string[]|null, fehler?:string|null, bedienbar?:boolean, hinweis?:string|null,
 *   entwurf:{auswahl?:string[], eigenOffen?:boolean, eigenText?:string, klappOffen?:boolean},
 *   neuZeichnen:()=>void, onWaehlen:(antwort:string|string[], info:{eigene:boolean})=>void,
 *   key?:(teil:string)=>string, nummern?:boolean, tipp?:boolean, klasse?:string,
 * }} o
 * @returns {HTMLElement}
 */
export function auswahlKarte(o) {
  ensureStyle(STYLE_ID, CSS);
  const optionen = Array.isArray(o.optionen) ? o.optionen : [];
  const stil = STILE.includes(o.stil) ? o.stil : 'knoepfe';
  const status = o.status || 'offen';
  const offen = status === 'offen';
  const sendet = new Set(o.sendet || []);
  const bedienbar = offen && !sendet.size && o.bedienbar !== false;
  const e = o.entwurf || {};
  if (!Array.isArray(e.auswahl)) e.auswahl = [];
  const gewaehlt = new Set(offen ? [...e.auswahl, ...sendet] : (o.gewaehlt || []));
  const key = typeof o.key === 'function' ? o.key : (t) => `auswahl:${t}`;
  const neu = () => { if (typeof o.neuZeichnen === 'function') o.neuZeichnen(); };
  const mehrfach = !!o.mehrfach && stil !== 'bestaetigung';
  const aufklappen = stil === 'knoepfe' && optionen.length > KNOEPFE_MAX;
  const nummern = o.nummern !== false && bedienbar && !aufklappen && stil !== 'umfrage';

  const waehle = (t) => {
    if (!bedienbar) return;
    if (!mehrfach && stil !== 'umfrage') {
      o.onWaehlen(t, { eigene: false });
      return;
    }
    const set = new Set(e.auswahl);
    if (mehrfach) {
      if (set.has(t)) set.delete(t);
      else set.add(t);
      e.auswahl = optionen.map((x) => x.text).filter((x) => set.has(x));
    } else {
      e.auswahl = [t];
    }
    neu();
  };
  const absenden = () => {
    if (!bedienbar || !e.auswahl.length) return;
    o.onWaehlen(mehrfach ? e.auswahl.slice() : e.auswahl[0], { eigene: false });
  };
  const eigeneSenden = () => {
    const t = String(e.eigenText || '').trim();
    if (!bedienbar || !t) return false;
    o.onWaehlen(t, { eigene: true });
    return true;
  };

  const karte = h('div.bs-wahl', {
    class: cx(o.klasse, `bs-wahl--${stil}`, { 'is-offen': offen, 'is-zu': !offen }),
    'data-zustand': status,
    role: 'group',
    'aria-label': o.frage || 'Auswahl',
    onKeydown: (ev) => {
      // 1-9 waehlt, solange der Fokus in der Karte und nicht in einem Feld ist.
      if (!nummern || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.target && ev.target.closest && ev.target.closest('input, textarea, select')) return;
      const n = Number(ev.key);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, optionen.length)) {
        ev.preventDefault();
        ev.stopPropagation();
        waehle(optionen[n - 1].text);
      }
    },
  });
  if (o.frage) karte.appendChild(h('p.bs-wahl__frage', null, inline(o.frage)));

  if (stil === 'umfrage' && !offen) {
    karte.appendChild(umfrageBalken(optionen, o.gewaehlt || []));
  } else if (stil === 'bestaetigung') {
    const reihe = h('div.bs-wahl__bestaetigen');
    optionen.slice(0, 2).forEach((opt, i) => {
      const an = gewaehlt.has(opt.text);
      reihe.appendChild(h('button', {
        type: 'button',
        class: cx('bs-knopf', i === 1 ? 'bs-knopf--haupt' : '', { 'is-gewaehlt': an, 'is-aus': !offen && !an }),
        disabled: !bedienbar,
        'data-key': key(`opt:${i}`),
        'aria-pressed': !offen ? String(an) : null,
        onClick: (ev) => { ev.stopPropagation(); waehle(opt.text); },
      }, an && !offen ? sym('haken') : null, h('span', null, inline(opt.text, { ohneLinks: true })),
      sendet.has(opt.text) ? spinner() : null));
    });
    karte.appendChild(reihe);
  } else if (aufklappen) {
    karte.appendChild(klappliste({ optionen, e, gewaehlt, bedienbar, mehrfach, key, neu, waehle, absenden, offen }));
  } else if (stil === 'liste' || stil === 'umfrage') {
    const rolle = mehrfach ? 'group' : (stil === 'umfrage' ? 'radiogroup' : 'group');
    const box = h('div.bs-wahl__zeilen', { role: rolle, 'aria-label': o.frage || 'Optionen' });
    optionen.forEach((opt, i) => {
      const an = gewaehlt.has(opt.text);
      const kaestchen = mehrfach || stil === 'umfrage';
      box.appendChild(h('button', {
        type: 'button',
        class: cx('bs-zeile', { 'is-gewaehlt': an, 'is-aus': !offen && !an }),
        role: kaestchen ? (mehrfach ? 'checkbox' : 'radio') : null,
        'aria-checked': kaestchen ? String(an) : null,
        disabled: !bedienbar,
        'data-key': key(`opt:${i}`),
        onClick: (ev) => { ev.stopPropagation(); waehle(opt.text); },
      },
      kaestchen ? h('span.bs-zeile__marke', { class: mehrfach ? 'is-eckig' : 'is-rund', 'aria-hidden': 'true' }, an ? sym('haken') : null)
        : (nummern && i < 9 ? h('span.bs-nr', { 'aria-hidden': 'true' }, text(String(i + 1))) : null),
      h('span.bs-zeile__text', null,
        h('span.bs-zeile__titel', null, inline(opt.text, { ohneLinks: true })),
        opt.beschreibung ? h('span.bs-zeile__beschreibung', null, inline(opt.beschreibung, { ohneLinks: true })) : null),
      !kaestchen && an && !offen ? h('span.bs-zeile__haken', { 'aria-hidden': 'true' }, sym('haken')) : null,
      !kaestchen && offen ? h('span.bs-zeile__pfeil', { 'aria-hidden': 'true' }, sym('rechts')) : null,
      sendet.has(opt.text) ? spinner() : null));
    });
    karte.appendChild(box);
  } else {
    const reihe = h('div.bs-wahl__optionen');
    optionen.forEach((opt, i) => {
      const an = gewaehlt.has(opt.text);
      reihe.appendChild(h('button', {
        type: 'button',
        class: cx('bs-option', { 'is-gewaehlt': an, 'is-aus': (!offen || sendet.size > 0) && !an }),
        disabled: !bedienbar,
        'aria-pressed': mehrfach ? String(an) : null,
        title: opt.beschreibung || null,
        'data-key': key(`opt:${i}`),
        onClick: (ev) => { ev.stopPropagation(); waehle(opt.text); },
      },
      nummern && i < 9 ? h('span.bs-nr', { 'aria-hidden': 'true' }, text(String(i + 1))) : null,
      h('span.bs-option__text', null, inline(opt.text, { ohneLinks: true })),
      an ? h('span.bs-option__haken', { 'aria-hidden': 'true' }, sym('haken')) : null,
      sendet.has(opt.text) ? spinner() : null));
    });
    if (offen && o.eigene) {
      reihe.appendChild(h('button', {
        type: 'button',
        class: cx('bs-option', 'bs-option--eigen', { 'is-offen': e.eigenOffen }),
        disabled: !bedienbar,
        'aria-expanded': String(!!e.eigenOffen),
        'data-key': key('eigen'),
        onClick: (ev) => {
          ev.stopPropagation();
          e.eigenOffen = !e.eigenOffen;
          neu();
          if (e.eigenOffen) fokusSpaeter(key('eigenfeld'));
        },
      }, h('span.bs-option__symbol', { 'aria-hidden': 'true' }, sym('stift')), h('span.bs-option__text', null, text('Eigene Antwort …'))));
    }
    karte.appendChild(reihe);
  }

  // Eigene Antwort in der Liste (dort gibt es keine Pille dafuer)
  if (offen && o.eigene && stil === 'liste' && !e.eigenOffen) {
    karte.appendChild(h('button.bs-wahl__eigen-link', {
      type: 'button',
      disabled: !bedienbar,
      'data-key': key('eigen'),
      onClick: (ev) => { ev.stopPropagation(); e.eigenOffen = true; neu(); fokusSpaeter(key('eigenfeld')); },
    }, sym('stift'), text('Eigene Antwort …')));
  }

  if (offen && o.eigene && e.eigenOffen) {
    const feld = h('input.bs-feld', {
      type: 'text',
      placeholder: 'Deine Antwort …',
      maxlength: 500,
      'aria-label': 'Eigene Antwort',
      enterkeyhint: 'send',
      'data-key': key('eigenfeld'),
      onInput: (ev) => { e.eigenText = ev.target.value; },
      onKeydown: (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) {
          ev.preventDefault();
          ev.stopPropagation();
          if (!eigeneSenden()) feld.focus();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          e.eigenOffen = false;
          neu();
        }
      },
    });
    feld.value = e.eigenText || '';
    karte.appendChild(h('div.bs-wahl__eigen', null, feld,
      knopf('Senden', {
        art: 'haupt',
        disabled: !bedienbar,
        key: key('eigensenden'),
        onClick: () => { if (!eigeneSenden()) feld.focus(); },
      })));
  }

  if (offen && (mehrfach || stil === 'umfrage') && !aufklappen) {
    const n = e.auswahl.length;
    karte.appendChild(h('div.bs-wahl__fuss', null,
      h('span.bs-leise', null, text(stil === 'umfrage' ? (n ? 'Bereit zum Abstimmen' : 'Eine Option wählen') : (n ? `${n} gewählt` : 'Mehreres möglich'))),
      knopf(o.knopf || (stil === 'umfrage' ? 'Abstimmen' : 'Weiter'), {
        art: 'haupt',
        disabled: !n || !bedienbar,
        key: key('weiter'),
        onClick: absenden,
      })));
  }

  if (o.tipp && bedienbar && !mehrfach && stil !== 'umfrage' && !e.eigenOffen && !aufklappen) {
    karte.appendChild(h('p.bs-wahl__tipp', null, text('Antippen schickt die Antwort ab.')));
  }
  if (o.fehler) karte.appendChild(h('p.bs-fehler', { role: 'alert' }, text(o.fehler)));
  if (!offen && o.eigeneAntwort) karte.appendChild(h('p.bs-wahl__antwort', null, text(`Deine Antwort: ${o.eigeneAntwort}`)));
  if (o.hinweis) karte.appendChild(h('p.bs-wahl__antwort', null, text(o.hinweis)));
  return karte;
}

/** Die Aufklappliste fuer viele Optionen: ein Knopf, darunter eine Liste. */
function klappliste({ optionen, e, gewaehlt, bedienbar, mehrfach, key, neu, waehle, absenden, offen }) {
  const box = h('div.bs-klapp', { class: cx({ 'is-auf': !!e.klappOffen && offen }) });
  const auswahlText = offen
    ? (e.auswahl.length ? (mehrfach ? `${e.auswahl.length} gewählt` : e.auswahl[0]) : 'Bitte wählen …')
    : ([...gewaehlt].join(', ') || '—');
  const listenId = `${key('klappliste').replace(/[^A-Za-z0-9_-]/g, '_')}`;
  box.appendChild(h('button.bs-klapp__knopf', {
    type: 'button',
    disabled: !bedienbar,
    'aria-haspopup': 'listbox',
    'aria-expanded': String(!!e.klappOffen && offen),
    'aria-controls': listenId,
    'data-key': key('klapp'),
    onClick: (ev) => {
      ev.stopPropagation();
      e.klappOffen = !e.klappOffen;
      neu();
      if (e.klappOffen) setTimeout(() => { const erste = document.getElementById(listenId)?.querySelector('[role="option"]'); if (erste) erste.focus(); }, 20);
    },
    onKeydown: (ev) => {
      if (ev.key === 'ArrowDown' && !e.klappOffen) {
        ev.preventDefault();
        e.klappOffen = true;
        neu();
      }
    },
  }, h('span.bs-klapp__wert', null, text(auswahlText)), sym('runter')));
  if (e.klappOffen && offen) {
    const lb = h('div.bs-klapp__liste', {
      id: listenId,
      role: 'listbox',
      'aria-multiselectable': mehrfach ? 'true' : null,
      onKeydown: (ev) => {
        const alle = [...lb.querySelectorAll('[role="option"]')];
        const i = alle.indexOf(document.activeElement);
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          ev.stopPropagation();
          const n = alle[Math.max(0, Math.min(alle.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
          if (n) n.focus();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          e.klappOffen = false;
          neu();
        }
      },
    });
    optionen.forEach((opt, i) => {
      const an = gewaehlt.has(opt.text);
      lb.appendChild(h('button.bs-klapp__option', {
        type: 'button',
        role: 'option',
        'aria-selected': String(an),
        class: cx({ 'is-gewaehlt': an }),
        'data-key': key(`kopt:${i}`),
        onClick: (ev) => { ev.stopPropagation(); if (!mehrfach) e.klappOffen = false; waehle(opt.text); },
      }, h('span.bs-klapp__marke', { class: mehrfach ? 'is-eckig' : 'is-rund', 'aria-hidden': 'true' }, an ? sym('haken') : null),
      h('span', null, inline(opt.text, { ohneLinks: true }))));
    });
    box.appendChild(lb);
  }
  if (mehrfach && offen) {
    box.appendChild(h('div.bs-wahl__fuss', null,
      h('span.bs-leise', null, text(e.auswahl.length ? `${e.auswahl.length} gewählt` : 'Mehreres möglich')),
      knopf('Weiter', { art: 'haupt', disabled: !e.auswahl.length || !bedienbar, key: key('weiter'), onClick: absenden })));
  }
  return box;
}

function umfrageBalken(optionen, gewaehlt) {
  const erg = umfrageErgebnis(optionen, gewaehlt);
  const summe = erg.reduce((a, x) => a + x.stimmen, 0);
  const box = h('div.bs-umfrage', { role: 'list' });
  for (const x of erg) {
    const prozent = Math.round(x.anteil * 100);
    box.appendChild(h('div.bs-umfrage__zeile', { role: 'listitem', class: cx({ 'is-eigene': x.eigene }) },
      h('div.bs-umfrage__kopf', null,
        h('span.bs-umfrage__text', null, x.eigene ? sym('haken') : null, inline(x.text, { ohneLinks: true })),
        h('span.bs-meta', null, text(`${prozent} %`))),
      h('div.bs-balken', { 'aria-hidden': 'true' }, h('div.bs-balken__wert', { style: { width: `${prozent}%` } }))));
  }
  box.appendChild(h('p.bs-leise.bs-umfrage__summe', null,
    text(summe === 1 ? 'Deine Stimme ist gezählt.' : `${zahlDeutsch(summe, 0)} Stimmen, deine eingerechnet.`)));
  return box;
}

/* ------------------------------------------------------------------ */
/* Die Bausteine                                                        */
/* ------------------------------------------------------------------ */

function auswahlRender(spec, b) {
  const z = b.zustand.lesen();
  const a = b.ansicht;
  if (!a.entwurf) a.entwurf = { auswahl: [], eigenOffen: false, eigenText: '', klappOffen: false };
  return auswahlKarte({
    frage: spec.frage,
    optionen: spec.optionen,
    mehrfach: spec.mehrfach,
    eigene: spec.eigene && b.kannSenden,
    stil: spec.stil,
    knopf: spec.knopf,
    status: z.gesendet ? 'gesendet' : 'offen',
    gewaehlt: Array.isArray(z.gewaehlt) ? z.gewaehlt : [],
    eigeneAntwort: typeof z.eigene === 'string' ? z.eigene : null,
    sendet: a.sendet || null,
    fehler: a.fehler || null,
    // Ohne Chat (keine Senden-Moeglichkeit) bleibt die Karte eine Anzeige.
    bedienbar: b.kannSenden,
    entwurf: a.entwurf,
    neuZeichnen: b.neuZeichnen,
    key: b.key,
    nummern: true,
    onWaehlen: async (antwort, { eigene }) => {
      const texte = Array.isArray(antwort) ? antwort : [antwort];
      a.fehler = null;
      a.sendet = texte;
      // Sofort als gesendet zeigen: die neue Nachricht erscheint darunter,
      // ein Spinner hier waere doppelt. Scheitert das Senden, geht es zurueck.
      b.zustand.setzen({ gesendet: true, gewaehlt: eigene ? [] : texte, eigene: eigene ? texte[0] : null }, { verlauf: false });
      try {
        await b.senden(auswahlNachricht(spec, texte, { eigene }));
        a.sendet = null;
        a.entwurf = { auswahl: [], eigenOffen: false, eigenText: '', klappOffen: false };
        b.neuZeichnen();
      } catch (err) {
        a.sendet = null;
        a.fehler = (err && err.message) || 'Das ließ sich nicht senden.';
        b.zustand.setzen({ gesendet: false, gewaehlt: [], eigene: null }, { verlauf: false });
      }
    },
  });
}

function aktionenRender(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const z = b.zustand.lesen();
  const benutzt = new Set(Array.isArray(z.benutzt) ? z.benutzt : []);
  const a = b.ansicht;
  const box = h('div.bs-aktionen');
  if (spec.frage) box.appendChild(h('p.bs-wahl__frage', null, inline(spec.frage)));
  const reihe = h('div.bs-aktionen__reihe');
  spec.aktionen.forEach((akt, i) => {
    const an = benutzt.has(i);
    reihe.appendChild(h('button', {
      type: 'button',
      class: cx('bs-knopf', 'bs-knopf--akzent', 'bs-aktion', { 'is-benutzt': an }),
      disabled: !b.kannSenden || a.sendet === i,
      'data-key': b.key(`akt:${i}`),
      title: akt.senden && akt.senden !== akt.text ? akt.senden : null,
      onClick: async (ev) => {
        ev.stopPropagation();
        a.fehler = null;
        a.sendet = i;
        b.zustand.setzen({ benutzt: [...new Set([...benutzt, i])].sort((x, y) => x - y) }, { verlauf: false });
        try {
          await b.senden(akt.senden || akt.text);
        } catch (err) {
          a.fehler = (err && err.message) || 'Das ließ sich nicht senden.';
          const ohne = [...benutzt].filter((x) => x !== i);
          b.zustand.setzen({ benutzt: ohne }, { verlauf: false, zeichnen: false });
        }
        a.sendet = null;
        b.neuZeichnen();
      },
    },
    akt.symbol ? h('span.bs-aktion__symbol', { 'aria-hidden': 'true' }, kartenSymbol(akt.symbol)) : null,
    h('span', null, inline(akt.text, { ohneLinks: true })),
    a.sendet === i ? spinner() : null));
  });
  box.appendChild(reihe);
  if (a.fehler) box.appendChild(h('p.bs-fehler', { role: 'alert' }, text(a.fehler)));
  return box;
}

export const typen = {
  auswahl: {
    pruefen: auswahlPruefen,
    render: auswahlRender,
    text: (s) => [s.frage || '', ...s.optionen.map((o) => `• ${o.text}${o.beschreibung ? ` – ${o.beschreibung}` : ''}`)].filter(Boolean).join('\n'),
  },
  aktionen: {
    pruefen: aktionenPruefen,
    render: aktionenRender,
    flach: true,
    // Angebote sind Bedienung, kein Inhalt: in Kopie und Vorlesen fehlen sie.
    text: (s) => s.frage || '',
  },
};

const CSS = `
.bs-wahl__frage { margin: 0 0 12px; font-size: var(--fs-md); font-weight: 500; line-height: 1.45; color: var(--fg); }
.bs-wahl__optionen { display: flex; flex-wrap: wrap; gap: 10px; }
.bs-option { display: inline-flex; align-items: center; gap: 10px; min-height: 40px; max-width: 100%; padding: 0 18px 0 11px; font: inherit; font-size: var(--fs-md); line-height: 1.3; text-align: left; color: var(--accent-text); background: color-mix(in srgb, var(--accent) 7%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 62%, transparent); border-radius: var(--r-full); cursor: pointer; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease), opacity var(--dur-2) var(--ease); -webkit-tap-highlight-color: transparent; }
.bs-option:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); }
.bs-option:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-option:disabled { cursor: default; }
.bs-option__text { min-width: 0; overflow-wrap: anywhere; padding: 6px 0; }
.bs-option__haken, .bs-option__symbol { display: inline-grid; place-items: center; flex: none; }
.bs-option__haken svg, .bs-option__symbol svg { width: 16px; height: 16px; }
.bs-option.is-gewaehlt { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
.bs-option.is-gewaehlt .bs-nr { color: var(--accent-fg); border-color: color-mix(in srgb, var(--accent-fg) 45%, transparent); }
.bs-option.is-aus { opacity: 0.42; }
.bs-option--eigen { padding-left: 14px; color: var(--fg-muted); background: none; border-style: dashed; border-color: var(--border-strong); }
.bs-option--eigen:hover:not(:disabled), .bs-option--eigen.is-offen { color: var(--fg); background: var(--surface-3); border-color: var(--fg-subtle); }
.bs-nr { display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; font-size: var(--fs-xs); font-weight: 600; color: var(--accent-text); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 6px; font-variant-numeric: tabular-nums; }
.bs-wahl__eigen { display: flex; gap: 8px; margin-top: 12px; }
.bs-wahl__eigen .bs-feld { flex: 1 1 auto; min-width: 0; }
.bs-wahl__fuss { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
.bs-wahl__tipp { margin: 10px 0 0; font-size: var(--fs-xs); color: var(--fg-subtle); }
.bs-wahl__antwort { margin: 12px 0 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.bs-wahl__eigen-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; padding: 6px 2px; font: inherit; font-size: var(--fs-sm); color: var(--fg-muted); background: none; border: 0; cursor: pointer; }
.bs-wahl__eigen-link:hover:not(:disabled) { color: var(--fg); }
.bs-wahl__eigen-link svg { width: 15px; height: 15px; }

.bs-wahl__zeilen { display: flex; flex-direction: column; gap: 6px; }
.bs-zeile { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 10px 14px; font: inherit; text-align: left; color: var(--fg); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); cursor: pointer; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), opacity var(--dur-2) var(--ease); -webkit-tap-highlight-color: transparent; }
.bs-zeile:hover:not(:disabled) { background: var(--surface-3); border-color: var(--border-strong); }
.bs-zeile:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-zeile:disabled { cursor: default; }
.bs-zeile.is-gewaehlt { border-color: var(--accent); background: var(--accent-soft); }
.bs-zeile.is-aus { opacity: 0.5; }
.bs-zeile__text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.bs-zeile__titel { font-size: var(--fs-md); line-height: 1.35; overflow-wrap: anywhere; }
.bs-zeile__beschreibung { font-size: var(--fs-sm); line-height: 1.4; color: var(--fg-muted); }
.bs-zeile__pfeil, .bs-zeile__haken { display: inline-grid; flex: none; color: var(--fg-subtle); }
.bs-zeile__haken { color: var(--accent-text); }
.bs-zeile__pfeil svg, .bs-zeile__haken svg { width: 16px; height: 16px; }
.bs-zeile__marke, .bs-klapp__marke { display: inline-grid; place-items: center; flex: none; width: 20px; height: 20px; color: var(--accent-fg); border: 1.5px solid var(--border-strong); transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }
.bs-zeile__marke.is-rund, .bs-klapp__marke.is-rund { border-radius: 50%; }
.bs-zeile__marke.is-eckig, .bs-klapp__marke.is-eckig { border-radius: 6px; }
.bs-zeile__marke svg, .bs-klapp__marke svg { width: 13px; height: 13px; stroke-width: 2.2; }
.bs-zeile.is-gewaehlt .bs-zeile__marke, .bs-klapp__option.is-gewaehlt .bs-klapp__marke { background: var(--accent); border-color: var(--accent); }

.bs-wahl__bestaetigen { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.bs-wahl__bestaetigen .bs-knopf { min-height: 38px; padding: 0 18px; }
.bs-wahl__bestaetigen .bs-knopf.is-aus { opacity: 0.4; }
.bs-wahl__bestaetigen .bs-knopf.is-gewaehlt:disabled { opacity: 1; }

.bs-klapp { position: relative; }
.bs-klapp__knopf { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 42px; padding: 0 12px 0 14px; font: inherit; font-size: var(--fs-md); text-align: left; color: var(--fg); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-2); cursor: pointer; }
.bs-klapp__knopf:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-klapp__knopf svg { width: 16px; height: 16px; flex: none; color: var(--fg-muted); transition: transform var(--dur-2) var(--ease); }
.bs-klapp.is-auf .bs-klapp__knopf svg { transform: rotate(180deg); }
.bs-klapp__wert { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bs-klapp__liste { display: flex; flex-direction: column; max-height: 272px; overflow-y: auto; margin-top: 6px; padding: 4px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-2); box-shadow: var(--shadow-2); animation: bs-ein var(--dur-2) var(--ease); }
.bs-klapp__option { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 6px 10px; font: inherit; font-size: var(--fs-md); text-align: left; color: var(--fg); background: none; border: 0; border-radius: 8px; cursor: pointer; }
.bs-klapp__option:hover, .bs-klapp__option:focus-visible { outline: none; background: var(--surface-3); }

.bs-umfrage { display: flex; flex-direction: column; gap: 12px; }
.bs-umfrage__kopf { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.bs-umfrage__text { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-md); }
.bs-umfrage__text svg { width: 15px; height: 15px; color: var(--accent-text); flex: none; }
.bs-umfrage__zeile:not(.is-eigene) .bs-balken__wert { background: var(--fg-subtle); }
.bs-umfrage__summe { margin: 2px 0 0; }

.bs-aktionen { margin: 14px 0 0; }
.bs-aktionen__reihe { display: flex; flex-wrap: wrap; gap: 10px; }
.bs-aktion { min-height: 40px; padding: 0 16px; border-radius: var(--r-2); }
.bs-aktion.is-benutzt { background: var(--accent-soft); border-color: var(--accent); }
.bs-aktion__symbol { display: inline-grid; place-items: center; }
.bs-aktion__symbol svg { width: 17px; height: 17px; }

@media (pointer: coarse) {
  .bs-option, .bs-zeile, .bs-klapp__knopf, .bs-klapp__option, .bs-aktion, .bs-wahl__bestaetigen .bs-knopf { min-height: var(--tap-min); }
  .bs-option .bs-nr, .bs-zeile .bs-nr { display: none; }
  .bs-option { padding: 0 20px; }
  .bs-wahl__eigen-link { min-height: var(--tap-min); }
}
`;
