/**
 * bausteine/formular.js -- mehrere Angaben auf einmal.
 *
 * Wenn die KI fuenf Dinge wissen muss, sind fuenf Rueckfragen hintereinander
 * zaeh. Ein Formular fragt alles auf einmal, prueft Pflichtfelder VOR dem
 * Absenden (mit dem Fehler am Feld, nicht in einem Dialog) und schickt eine
 * lesbare Nachricht, die im Verlauf auch fuer Menschen Sinn ergibt:
 *
 *     **Formular: Reise**
 *     Ziel: Lissabon
 *     Abreise: Fr., 02.10.2026
 */

import { h, text, cx } from '../dom.js';
import { str, bool, zahl, liste, wahl, objekt, fehler, LAENGE, sym, knopf, inline, ensureStyle, zahlDeutsch, perKey, reglerFuellen } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-formular';
export const ARTEN = ['text', 'textfeld', 'zahl', 'datum', 'uhrzeit', 'auswahl', 'mehrfach', 'schalter', 'regler'];

const DATUM_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZEIT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Ist "YYYY-MM-DD" ein echter Tag (kein 31. Februar)? */
export function datumOk(s) {
  const m = DATUM_RE.exec(String(s || ''));
  if (!m) return false;
  const [j, mo, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(j, mo - 1, t));
  return d.getUTCFullYear() === j && d.getUTCMonth() === mo - 1 && d.getUTCDate() === t;
}

function feldPruefen(roh, i, namen) {
  const x = objekt(roh);
  if (!x) return null;
  const art = wahl(x.art, ARTEN, 'text');
  const label = str(x.label ?? x.name, 120);
  if (!label) throw fehler(`Feld ${i + 1} braucht ein „label“.`);
  let name = str(x.name, 40).replace(/[^\p{L}\p{N}_-]+/gu, '_') || label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40) || `feld${i + 1}`;
  while (namen.has(name)) name = `${name}_${i + 1}`;
  namen.add(name);
  const f = { name, label, art };
  if (bool(x.pflicht, false)) f.pflicht = true;
  const platz = str(x.platzhalter, 120);
  if (platz && ['text', 'textfeld', 'zahl'].includes(art)) f.platzhalter = platz;
  if (art === 'auswahl' || art === 'mehrfach') {
    const gesehen = new Set();
    f.optionen = liste(x.optionen, `${label}: optionen`, {
      min: 1,
      max: 30,
      je: (o) => {
        const t = str(typeof o === 'object' && o ? o.text : o, 120);
        if (!t || gesehen.has(t)) return null;
        gesehen.add(t);
        return t;
      },
    });
  }
  if (art === 'zahl' || art === 'regler') {
    const min = zahl(x.min);
    const max = zahl(x.max);
    const lo = min ?? (art === 'regler' ? 0 : null);
    const hi = max ?? (art === 'regler' ? 100 : null);
    if (lo !== null) f.min = lo;
    if (hi !== null) f.max = hi;
    if (lo !== null && hi !== null && lo > hi) throw fehler(`Bei „${label}“ ist „min“ größer als „max“.`);
    const schritt = zahl(x.schritt, { min: 1e-9, max: 1e9 });
    if (schritt !== null) f.schritt = schritt;
  }
  // Voreinstellung, passend zur Art -- sonst still weg.
  const w = x.wert;
  switch (art) {
    case 'text': case 'textfeld': { const s = str(w, art === 'text' ? 500 : 4000); if (s) f.wert = s; break; }
    case 'zahl': case 'regler': { const n = zahl(w, { min: f.min ?? -Infinity, max: f.max ?? Infinity }); if (n !== null) f.wert = n; break; }
    case 'datum': if (datumOk(w)) f.wert = w; break;
    case 'uhrzeit': if (ZEIT_RE.test(String(w || ''))) f.wert = w; break;
    case 'auswahl': if (f.optionen.includes(w)) f.wert = w; break;
    case 'mehrfach': if (Array.isArray(w)) { const v = w.filter((o) => f.optionen.includes(o)); if (v.length) f.wert = [...new Set(v)]; } break;
    case 'schalter': if (typeof w === 'boolean') f.wert = w; break;
    default: break;
  }
  return f;
}

function pruefen(roh) {
  const namen = new Set();
  const felder = liste(roh.felder, 'felder', { min: 1, max: 20, je: (x, i) => feldPruefen(x, i, namen) });
  const out = { felder };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  const k = str(roh.knopf, 40);
  if (k) out.knopf = k;
  return out;
}

/* ------------------------------------------------------------------ */
/* Reine Helfer                                                         */
/* ------------------------------------------------------------------ */

/** Anfangswerte aus den Voreinstellungen. */
export function startWerte(spec) {
  const w = {};
  for (const f of spec.felder) {
    if (f.wert !== undefined) w[f.name] = Array.isArray(f.wert) ? f.wert.slice() : f.wert;
    else if (f.art === 'mehrfach') w[f.name] = [];
    else if (f.art === 'schalter') w[f.name] = false;
    else if (f.art === 'regler') w[f.name] = f.min ?? 0;
    else w[f.name] = '';
  }
  return w;
}

const leer = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

/**
 * Werte pruefen. @returns {{ok:boolean, fehler:Object<string,string>}}
 * Ein Satz je Feld -- er steht unter dem Feld.
 */
export function wertepruefen(spec, werte) {
  const out = {};
  for (const f of spec.felder) {
    const v = werte ? werte[f.name] : undefined;
    if (f.art === 'schalter') {
      if (f.pflicht && v !== true) out[f.name] = 'Bitte bestätigen.';
      continue;
    }
    if (leer(v)) {
      if (f.pflicht) out[f.name] = f.art === 'auswahl' || f.art === 'mehrfach' ? 'Bitte etwas auswählen.' : 'Bitte ausfüllen.';
      continue;
    }
    if (f.art === 'zahl' || f.art === 'regler') {
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) out[f.name] = 'Bitte eine Zahl eingeben.';
      else if (f.min !== undefined && n < f.min) out[f.name] = `Mindestens ${zahlDeutsch(f.min)}.`;
      else if (f.max !== undefined && n > f.max) out[f.name] = `Höchstens ${zahlDeutsch(f.max)}.`;
    } else if (f.art === 'datum' && !datumOk(v)) out[f.name] = 'Bitte ein gültiges Datum wählen.';
    else if (f.art === 'uhrzeit' && !ZEIT_RE.test(String(v))) out[f.name] = 'Bitte eine Uhrzeit wie 14:30 eingeben.';
    else if (f.art === 'auswahl' && !f.optionen.includes(v)) out[f.name] = 'Bitte etwas aus der Liste wählen.';
  }
  return { ok: Object.keys(out).length === 0, fehler: out };
}

const WOCHENTAG = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];

/** Ein Wert, wie er in der Nachricht steht (deutsch, lesbar). */
export function wertText(f, v) {
  switch (f.art) {
    case 'schalter': return v === true ? 'Ja' : 'Nein';
    case 'mehrfach': return (Array.isArray(v) ? v : []).join(', ');
    case 'datum': {
      if (!datumOk(v)) return String(v || '');
      const [j, m, t] = v.split('-').map(Number);
      return `${WOCHENTAG[new Date(Date.UTC(j, m - 1, t)).getUTCDay()]}, ${String(t).padStart(2, '0')}.${String(m).padStart(2, '0')}.${j}`;
    }
    case 'uhrzeit': return `${v} Uhr`;
    case 'zahl': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      return Number.isFinite(n) ? zahlDeutsch(n, 6) : String(v);
    }
    case 'regler': return f.max !== undefined ? `${zahlDeutsch(Number(v), 6)} von ${zahlDeutsch(f.max, 6)}` : zahlDeutsch(Number(v), 6);
    default: return String(v ?? '');
  }
}

/** Die Nachricht an die KI. Leere, freiwillige Felder fehlen darin. */
export function formularText(spec, werte) {
  const zeilen = [`**Formular${spec.titel ? `: ${spec.titel}` : ''}**`];
  for (const f of spec.felder) {
    const v = werte ? werte[f.name] : undefined;
    if (f.art !== 'schalter' && leer(v)) continue;
    const label = f.label.replace(/[:：]\s*$/, '');
    const w = wertText(f, v);
    zeilen.push(w.includes('\n') ? `${label}:\n${w}` : `${label}: ${w}`);
  }
  return zeilen.join('\n');
}

/* ------------------------------------------------------------------ */
/* Zeichnen                                                             */
/* ------------------------------------------------------------------ */

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const z = b.zustand.lesen();
  const a = b.ansicht;
  const gesendet = !!z.gesendet && !a.bearbeiten;
  if (!a.werte) a.werte = z.werte && typeof z.werte === 'object' ? { ...startWerte(spec), ...z.werte } : startWerte(spec);
  if (!a.fehler) a.fehler = {};
  const werte = gesendet && z.werte ? z.werte : a.werte;
  const aus = gesendet || !!a.sendet;

  const setze = (name, v, zeichnen = false) => {
    a.werte[name] = v;
    if (a.fehler[name]) {
      delete a.fehler[name];
      zeichnen = true;
    }
    if (zeichnen) b.neuZeichnen();
  };

  const form = h('form.bs-form', {
    novalidate: true,
    onSubmit: (e) => { e.preventDefault(); e.stopPropagation(); absenden(); },
  });
  if (spec.titel) form.appendChild(h('div.bs-kopf', null, h('p.bs-titel', null, inline(spec.titel))));
  const gitter = h('div.bs-form__gitter');
  spec.felder.forEach((f, i) => {
    const id = `${b.key(`f:${i}`)}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const fehlerId = `${id}_fehler`;
    const satz = a.fehler[f.name];
    const gemeinsam = {
      id,
      disabled: aus,
      'data-key': b.key(`f:${i}`),
      'aria-invalid': satz ? 'true' : null,
      'aria-describedby': satz ? fehlerId : null,
      'aria-required': f.pflicht ? 'true' : null,
    };
    const v = werte[f.name];
    let feld;
    switch (f.art) {
      case 'textfeld':
        feld = h('textarea.bs-feld.bs-form__textfeld', { ...gemeinsam, rows: 3, placeholder: f.platzhalter || null, maxlength: 4000, onInput: (e) => setze(f.name, e.target.value) });
        feld.value = v || '';
        break;
      case 'zahl':
        feld = h('input.bs-feld', {
          ...gemeinsam, type: 'number', inputmode: 'decimal', placeholder: f.platzhalter || null,
          min: f.min, max: f.max, step: f.schritt ?? 'any',
          onInput: (e) => setze(f.name, e.target.value),
        });
        feld.value = v === '' || v === undefined ? '' : String(v);
        break;
      case 'datum':
        feld = h('input.bs-feld', { ...gemeinsam, type: 'date', onInput: (e) => setze(f.name, e.target.value) });
        feld.value = v || '';
        break;
      case 'uhrzeit':
        feld = h('input.bs-feld', { ...gemeinsam, type: 'time', onInput: (e) => setze(f.name, e.target.value) });
        feld.value = v || '';
        break;
      case 'auswahl': {
        feld = h('select.bs-feld.bs-form__select', { ...gemeinsam, onChange: (e) => setze(f.name, e.target.value) },
          h('option', { value: '', disabled: !!f.pflicht }, text('Bitte wählen …')),
          f.optionen.map((o) => h('option', { value: o }, text(o))));
        feld.value = v || '';
        break;
      }
      case 'mehrfach': {
        const an = new Set(Array.isArray(v) ? v : []);
        feld = h('div.bs-form__chips', { role: 'group', id, 'aria-labelledby': `${id}_label`, 'aria-describedby': satz ? fehlerId : null });
        f.optionen.forEach((o, k) => {
          const drin = an.has(o);
          feld.appendChild(h('button', {
            type: 'button',
            class: cx('bs-chip', { 'is-an': drin }),
            role: 'checkbox',
            'aria-checked': String(drin),
            disabled: aus,
            'data-key': b.key(`f:${i}:${k}`),
            onClick: (e) => {
              e.stopPropagation();
              const neu = new Set(an);
              if (drin) neu.delete(o);
              else neu.add(o);
              setze(f.name, f.optionen.filter((x) => neu.has(x)), true);
            },
          }, drin ? sym('haken') : null, h('span', null, text(o))));
        });
        break;
      }
      case 'schalter':
        feld = h('button', {
          ...gemeinsam,
          type: 'button',
          class: cx('bs-schalter', { 'is-an': v === true }),
          role: 'switch',
          'aria-checked': String(v === true),
          'aria-labelledby': `${id}_label`,
          onClick: (e) => { e.stopPropagation(); setze(f.name, !(v === true), true); },
        }, h('span.bs-schalter__knopf', { 'aria-hidden': 'true' }));
        break;
      case 'regler': {
        const ausgabe = h('output.bs-form__wert', { for: id }, text(zahlDeutsch(Number(v))));
        const r = h('input.bs-regler', {
          ...gemeinsam, type: 'range', min: f.min ?? 0, max: f.max ?? 100, step: f.schritt ?? 1,
          onInput: (e) => { ausgabe.textContent = zahlDeutsch(Number(e.target.value)); reglerFuellen(e.target); setze(f.name, Number(e.target.value)); },
        });
        r.value = String(v ?? f.min ?? 0);
        reglerFuellen(r);
        feld = h('div.bs-form__regler', null, r, ausgabe);
        break;
      }
      default:
        feld = h('input.bs-feld', { ...gemeinsam, type: 'text', placeholder: f.platzhalter || null, maxlength: 500, onInput: (e) => setze(f.name, e.target.value) });
        feld.value = v || '';
    }
    const labelKnoten = f.art === 'mehrfach' || f.art === 'schalter'
      ? h('span.bs-form__label', { id: `${id}_label` }, text(f.label), f.pflicht ? h('span.bs-form__pflicht', { 'aria-hidden': 'true' }, text(' *')) : null)
      : h('label.bs-form__label', { for: id, id: `${id}_label` }, text(f.label), f.pflicht ? h('span.bs-form__pflicht', { 'aria-hidden': 'true' }, text(' *')) : null);
    gitter.appendChild(h('div.bs-form__feld', { class: cx(`bs-form__feld--${f.art}`, { 'is-breit': f.art === 'textfeld' || f.art === 'mehrfach' }) },
      f.art === 'schalter' ? h('div.bs-form__zeile', null, labelKnoten, feld) : [labelKnoten, feld],
      satz ? h('p.bs-form__fehler', { id: fehlerId }, text(satz)) : null));
  });
  form.appendChild(gitter);

  const fuss = h('div.bs-fuss');
  if (gesendet) {
    fuss.append(h('span.bs-meta.bs-form__gesendet', null, sym('haken'), text('Gesendet')),
      h('div.bs-fuss__rechts', null, knopf('Ändern', {
        art: 'leise', symbol: 'stift', key: b.key('aendern'),
        onClick: () => { a.bearbeiten = true; a.werte = { ...startWerte(spec), ...(z.werte || {}) }; b.neuZeichnen(); },
      })));
  } else if (b.kannSenden) {
    const pflicht = spec.felder.some((f) => f.pflicht);
    fuss.append(pflicht ? h('span.bs-leise', null, text('* Pflichtfeld')) : null,
      h('div.bs-fuss__rechts', null,
        a.bearbeiten ? knopf('Abbrechen', { art: 'leise', key: b.key('abbrechen'), onClick: () => { a.bearbeiten = false; a.fehler = {}; b.neuZeichnen(); } }) : null,
        h('button.bs-knopf.bs-knopf--haupt', { type: 'submit', disabled: !!a.sendet, 'data-key': b.key('absenden') },
          a.sendet ? h('span.spinner', { 'aria-hidden': 'true' }) : null, h('span', null, text(spec.knopf || 'Absenden')))));
  }
  form.appendChild(fuss);
  if (a.sendeFehler) form.appendChild(h('p.bs-fehler', { role: 'alert' }, text(a.sendeFehler)));

  async function absenden() {
    if (a.sendet || gesendet || !b.kannSenden) return;
    const erg = wertepruefen(spec, a.werte);
    a.fehler = erg.fehler;
    a.sendeFehler = null;
    if (!erg.ok) {
      b.neuZeichnen();
      const erstes = spec.felder.findIndex((f) => erg.fehler[f.name]);
      const el = perKey(b.key(`f:${erstes}`), b.huelle()) || perKey(b.key(`f:${erstes}:0`), b.huelle());
      if (el) el.focus();
      return;
    }
    const werteJetzt = { ...a.werte };
    a.sendet = true;
    b.neuZeichnen();
    try {
      await b.senden(formularText(spec, werteJetzt));
      a.sendet = false;
      a.bearbeiten = false;
      b.zustand.setzen({ gesendet: true, werte: werteJetzt }, { verlauf: false });
    } catch (err) {
      a.sendet = false;
      a.sendeFehler = (err && err.message) || 'Das ließ sich nicht senden.';
      b.neuZeichnen();
    }
  }
  return form;
}

export const typen = {
  formular: {
    pruefen,
    render,
    text: (s) => [s.titel || 'Formular', ...s.felder.map((f) => `${f.label}: ___`)].join('\n'),
  },
};

const CSS = `
.bs-form__gitter { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px 16px; }
.bs-form__feld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.bs-form__feld.is-breit { grid-column: 1 / -1; }
.bs-form__label { font-size: var(--fs-sm); font-weight: 500; color: var(--fg-muted); }
.bs-form__pflicht { color: var(--accent-text); }
.bs-form__textfeld { min-height: 84px; resize: vertical; line-height: var(--lh); }
.bs-form__select { appearance: none; -webkit-appearance: none; padding-right: 34px; background-image: linear-gradient(45deg, transparent 50%, var(--fg-muted) 50%), linear-gradient(135deg, var(--fg-muted) 50%, transparent 50%); background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
.bs-form__fehler { margin: 0; font-size: var(--fs-sm); color: var(--danger); }
.bs-form__zeile { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; }
.bs-form__chips { display: flex; flex-wrap: wrap; gap: 8px; }
.bs-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 14px; font: inherit; font-size: var(--fs-base); color: var(--fg); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-full); cursor: pointer; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }
.bs-chip:hover:not(:disabled) { background: var(--surface-3); }
.bs-chip:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-chip svg { width: 14px; height: 14px; }
.bs-chip.is-an { color: var(--accent-text); background: var(--accent-soft); border-color: var(--accent); }
.bs-chip:disabled { cursor: default; opacity: 0.7; }
.bs-schalter { position: relative; flex: none; width: 44px; height: 26px; padding: 0; background: var(--surface-4); border: 1px solid var(--border-strong); border-radius: var(--r-full); cursor: pointer; transition: background var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease); }
.bs-schalter__knopf { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; background: var(--accent-fg); border-radius: 50%; box-shadow: var(--shadow-1); transition: transform var(--dur-2) var(--ease); }
.bs-schalter.is-an { background: var(--accent); border-color: var(--accent); }
.bs-schalter.is-an .bs-schalter__knopf { transform: translateX(18px); background: var(--accent-fg); }
.bs-schalter:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-schalter:disabled { cursor: default; opacity: 0.7; }
.bs-form__regler { display: flex; align-items: center; gap: 12px; min-height: 38px; }
.bs-form__wert { min-width: 3ch; font-size: var(--fs-base); font-variant-numeric: tabular-nums; color: var(--fg); text-align: right; }
.bs-form__gesendet { display: inline-flex; align-items: center; gap: 6px; color: var(--ok); }
.bs-form__gesendet svg { width: 15px; height: 15px; }
.bs-form .bs-feld:disabled { opacity: 0.75; cursor: default; }
@media (pointer: coarse) {
  .bs-chip { min-height: var(--tap-min); }
  .bs-schalter { width: 52px; height: 32px; }
  .bs-schalter__knopf { width: 26px; height: 26px; }
  .bs-schalter.is-an .bs-schalter__knopf { transform: translateX(20px); }
}
`;
