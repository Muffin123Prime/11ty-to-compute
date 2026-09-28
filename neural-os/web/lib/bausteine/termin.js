/**
 * bausteine/termin.js -- ein Terminvorschlag mit echtem "Eintragen".
 *
 * Die KI schlaegt vor, der Nutzer entscheidet: [Zum Kalender hinzufügen]
 * legt den Termin wirklich an (POST /api/events, mit derselben Pruefung wie
 * jeder andere Termin und `source: "auto"` + chatId wie beim Werkzeug
 * termin_anlegen). Danach "Eingetragen" mit [Öffnen], [Rückgängig] (der
 * Verlaufseintrag aus der Antwort des Servers) und [.ics] fuer das iPad.
 * Wenn der Nutzer ausdruecklich "trag ein" sagt, benutzt die KI das
 * Werkzeug -- dieser Baustein ist nur der Vorschlag.
 */

import { h, text, icon } from '../dom.js';
import { str, strPflicht, fehler, sym, knopf, inline, ensureStyle, spinner, S } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-termin';
const ZEIT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/;

/** "YYYY-MM-DD" oder "YYYY-MM-DDTHH:MM" pruefen und als Teile liefern. */
export function wandzeitLesen(wert) {
  const m = ZEIT_RE.exec(String(wert || '').trim());
  if (!m) return null;
  const [j, mo, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(j, mo - 1, t, Number(m[4] || 0), Number(m[5] || 0));
  if (d.getFullYear() !== j || d.getMonth() !== mo - 1 || d.getDate() !== t) return null;
  if (m[4] && (Number(m[4]) > 23 || Number(m[5]) > 59)) return null;
  return { text: m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`, ganztaegig: !m[4], datum: d };
}

function pruefen(roh) {
  const titel = strPflicht(roh.titel, 'titel', 160);
  const start = wandzeitLesen(roh.start);
  if (!start) throw fehler('„start“ fehlt oder ist ungültig (z. B. "2026-10-02T10:00" oder "2026-10-02").');
  const out = { titel, start: start.text };
  if (roh.ende !== undefined && roh.ende !== null && roh.ende !== '') {
    const ende = wandzeitLesen(roh.ende);
    if (!ende) throw fehler('„ende“ ist ungültig.');
    if (ende.ganztaegig !== start.ganztaegig) throw fehler('„start“ und „ende“ brauchen dieselbe Form (beide mit oder beide ohne Uhrzeit).');
    if (ende.datum < start.datum || (!start.ganztaegig && ende.datum.getTime() === start.datum.getTime())) throw fehler('„ende“ liegt nicht nach „start“.');
    out.ende = ende.text;
  }
  const ort = str(roh.ort, 160);
  if (ort) out.ort = ort;
  const notiz = str(roh.notiz, 1000);
  if (notiz) out.notiz = notiz;
  return out;
}

/** "Fr., 2. Okt. 2026 · 10:00–11:00 Uhr" */
export function terminWann(spec) {
  const s = wandzeitLesen(spec.start);
  const e = spec.ende ? wandzeitLesen(spec.ende) : null;
  const tag = (d) => d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const uhr = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (s.ganztaegig) {
    if (!e || e.text === s.text) return `${tag(s.datum)} · ganztägig`;
    return `${tag(s.datum)} – ${tag(e.datum)}`;
  }
  if (!e) return `${tag(s.datum)} · ${uhr(s.datum)} Uhr`;
  if (e.text.slice(0, 10) === s.text.slice(0, 10)) return `${tag(s.datum)} · ${uhr(s.datum)}–${uhr(e.datum)} Uhr`;
  return `${tag(s.datum)}, ${uhr(s.datum)} – ${tag(e.datum)}, ${uhr(e.datum)} Uhr`;
}

/** Der Koerper fuer POST /api/events -- dieselben Felder wie beim Werkzeug. */
export function terminKoerper(spec, chatId) {
  const s = wandzeitLesen(spec.start);
  const k = { title: spec.titel, start: s.text, source: 'auto' };
  if (spec.ende) k.end = spec.ende;
  if (s.ganztaegig) k.allDay = true;
  if (spec.ort) k.location = spec.ort;
  if (spec.notiz) k.body = spec.notiz;
  if (chatId) k.chatId = chatId;
  return k;
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const z = b.zustand.lesen();
  const a = b.ansicht;
  const eingetragen = !!z.eventId && !z.zurueck;
  const route = eingetragen ? `#/kalender?id=${encodeURIComponent(z.eventId)}` : null;

  const hinzufuegen = async () => {
    a.laeuft = 'anlegen';
    a.fehler = null;
    b.neuZeichnen();
    try {
      const antwort = await b.api.post('/events', terminKoerper(spec, b.chatId));
      const rec = antwort && antwort.record;
      if (!rec || !rec.id) throw new Error('Der Kalender hat den Termin nicht bestätigt.');
      a.laeuft = null;
      b.zustand.setzen({ eventId: rec.id, rueckgaengig: antwort.rueckgaengig ? antwort.rueckgaengig.pfad : null, zurueck: false }, { verlauf: false });
    } catch (err) {
      a.laeuft = null;
      a.fehler = (err && err.message) || 'Der Termin ließ sich nicht eintragen.';
      b.neuZeichnen();
    }
  };
  const zuruecknehmen = async () => {
    if (!z.rueckgaengig) return;
    a.laeuft = 'zurueck';
    a.fehler = null;
    b.neuZeichnen();
    try {
      await b.api.post(z.rueckgaengig, {});
      a.laeuft = null;
      b.zustand.setzen({ zurueck: true, eventId: null, rueckgaengig: null }, { verlauf: false });
    } catch (err) {
      a.laeuft = null;
      a.fehler = (err && err.message) || 'Das ließ sich nicht zurücknehmen.';
      b.neuZeichnen();
    }
  };

  const kopf = h('div.bs-termin__kopf', null,
    h('span.bs-termin__symbol', { 'aria-hidden': 'true' }, icon(S.kalender)),
    h('div.bs-termin__text', null,
      h('p.bs-termin__titel', null, inline(spec.titel)),
      h('p.bs-termin__wann', null, text(terminWann(spec))),
      spec.ort ? h('p.bs-termin__ort', null, sym('ort'), h('span', null, inline(spec.ort))) : null));

  const fuss = h('div.bs-fuss.bs-termin__fuss');
  if (eingetragen) {
    fuss.append(h('span.bs-meta.bs-termin__status', null, h('span.bs-ok', null, sym('haken')), text('Eingetragen')),
      h('div.bs-fuss__rechts', null,
        b.kannOeffnen
          ? knopf('Öffnen', { art: 'leise', key: b.key('oeffnen'), onClick: () => b.oeffnen(route) })
          : h('a.bs-knopf.bs-knopf--leise', { href: route, 'data-key': b.key('oeffnen'), onClick: (e) => e.stopPropagation() }, text('Öffnen')),
        z.rueckgaengig ? knopf('Rückgängig', { art: 'leise', symbol: 'zurueck', key: b.key('zurueck'), disabled: !!a.laeuft, onClick: zuruecknehmen }) : null,
        h('a.bs-knopf.bs-knopf--leise', {
          href: `/api/events/${encodeURIComponent(z.eventId)}/ics`,
          download: '',
          title: 'Als Kalenderdatei (.ics) – z. B. für den Kalender auf dem iPad',
          'data-key': b.key('ics'),
          onClick: (e) => e.stopPropagation(),
        }, sym('laden'), h('span', null, text('.ics')))));
  } else if (b.api) {
    fuss.append(z.zurueck ? h('span.bs-meta', null, text('Zurückgenommen')) : h('span'),
      h('div.bs-fuss__rechts', null, h('button.bs-knopf.bs-knopf--haupt', {
        type: 'button',
        disabled: !!a.laeuft,
        'data-key': b.key('hinzufuegen'),
        onClick: (e) => { e.stopPropagation(); hinzufuegen(); },
      }, a.laeuft === 'anlegen' ? spinner() : sym('plus'), h('span', null, text('Zum Kalender hinzufügen')))));
  }
  if (a.laeuft === 'zurueck') fuss.prepend(spinner());

  return h('div.bs-termin', { class: eingetragen ? 'is-eingetragen' : null },
    kopf,
    spec.notiz ? h('p.bs-termin__notiz', null, inline(spec.notiz)) : null,
    fuss,
    a.fehler ? h('p.bs-fehler', { role: 'alert' }, text(a.fehler)) : null);
}

export const typen = {
  termin: {
    pruefen,
    render,
    text: (s) => [`Termin: ${s.titel}`, terminWann(s), s.ort ? `Ort: ${s.ort}` : '', s.notiz || ''].filter(Boolean).join('\n'),
  },
};

const CSS = `
.bs-termin__kopf { display: flex; align-items: flex-start; gap: 14px; }
.bs-termin__symbol { display: grid; place-items: center; flex: none; width: 40px; height: 40px; color: var(--accent-text); background: var(--accent-soft); border-radius: var(--r-2); }
.bs-termin__symbol svg { width: 20px; height: 20px; }
.bs-termin.is-eingetragen .bs-termin__symbol { color: var(--accent-fg); background: var(--accent); }
.bs-termin__text { flex: 1 1 auto; min-width: 0; }
.bs-termin__titel { margin: 0; font-size: var(--fs-md); font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.bs-termin__wann { margin: 2px 0 0; font-size: var(--fs-base); color: var(--fg); font-variant-numeric: tabular-nums; }
.bs-termin__ort { display: flex; align-items: center; gap: 5px; margin: 2px 0 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.bs-termin__ort svg { width: 14px; height: 14px; flex: none; }
.bs-termin__notiz { margin: 10px 0 0 54px; font-size: var(--fs-sm); line-height: 1.5; color: var(--fg-muted); }
.bs-termin__fuss { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.bs-termin__status { display: inline-flex; align-items: center; gap: 6px; color: var(--fg); }
.bs-termin__status svg { width: 15px; height: 15px; vertical-align: -2px; }
.bs-termin a.bs-knopf { text-decoration: none; }
@media (max-width: 480px) { .bs-termin__notiz { margin-left: 0; } }
`;
