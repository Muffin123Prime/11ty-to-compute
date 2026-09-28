/**
 * bausteine/timer.js -- ein Timer, der wirklich laeuft.
 *
 * Gespeichert werden nur Zeitpunkte (Start, bisher verbraucht), nie ein
 * herunterzaehlender Wert: so laeuft der Timer ueber Neuladen, Tabwechsel
 * und einen schlafenden Bildschirm weiter und zeigt danach die richtige
 * Restzeit. Das Ende plant ein Modul-Register, nicht der DOM-Knoten -- der
 * Chat baut Nachrichten staendig neu, der Ton soll trotzdem genau einmal
 * kommen.
 *
 * Der Ton ist mit WebAudio erzeugt (zwei leise Sinustoene): Die App-CSP
 * erlaubt kein Audio aus data:/blob:, und eine Tondatei waere eine weitere
 * Datei fuer genau diesen Zweck. Eine Mitteilung gibt es nur, wenn der
 * Browser sie kann UND der Nutzer sie erlaubt hat.
 */

import { h, text, cx } from '../dom.js';
import { str, fehler, LAENGE, knopf, inline, ensureStyle } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-timer';
export const MAX_SEKUNDEN = 24 * 3600;

/**
 * Dauer lesen: Sekunden (Zahl), "mm:ss", "hh:mm:ss" oder "5 min"/"90 s".
 * @returns {number|null} Sekunden (1..86400)
 */
export function dauerLesen(wert) {
  let s = null;
  if (typeof wert === 'number' && Number.isFinite(wert)) s = Math.round(wert);
  else if (typeof wert === 'string') {
    const t = wert.trim().toLowerCase();
    let m;
    if ((m = /^(\d{1,2}):([0-5]?\d):([0-5]\d)$/.exec(t))) s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    else if ((m = /^(\d{1,4}):([0-5]\d)$/.exec(t))) s = Number(m[1]) * 60 + Number(m[2]);
    else if ((m = /^(\d+(?:[.,]\d+)?)\s*(s|sek|sekunden?|m|min|minuten?|h|std|stunden?)$/.exec(t))) {
      const n = Number(m[1].replace(',', '.'));
      const f = m[2].startsWith('s') ? 1 : (m[2].startsWith('m') ? 60 : 3600);
      s = Math.round(n * f);
    } else if (/^\d+$/.test(t)) s = Number(t);
  }
  if (s === null || !Number.isFinite(s) || s < 1 || s > MAX_SEKUNDEN) return null;
  return s;
}

/** "04:59", "1:02:03" -- Sekunden aufgerundet, damit "00:00" wirklich das Ende ist. */
export function zeitFormat(sekunden) {
  const s = Math.max(0, Math.ceil(Number(sekunden) || 0));
  const std = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sek = s % 60;
  const zz = (n) => String(n).padStart(2, '0');
  return std > 0 ? `${std}:${zz(min)}:${zz(sek)}` : `${zz(min)}:${zz(sek)}`;
}

/** Restzeit in ms aus dem gespeicherten Zustand. Rein. */
export function timerRest(zustand, dauerMs, jetzt = Date.now()) {
  const verbraucht = Math.max(0, Number(zustand && zustand.verbraucht) || 0);
  const laufend = zustand && zustand.laeuft && Number.isFinite(zustand.start) ? Math.max(0, jetzt - zustand.start) : 0;
  return Math.max(0, dauerMs - verbraucht - laufend);
}

function pruefen(roh) {
  const dauer = dauerLesen(roh.dauer);
  if (dauer === null) throw fehler('„dauer“ fehlt oder ist ungültig (z. B. "05:00", "1:30:00" oder 300).');
  const out = { dauer };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  return out;
}

/* ------------------------------------------------------------------ */
/* Ton und Mitteilung                                                   */
/* ------------------------------------------------------------------ */

let audio = null;
/** In einem Klick aufrufen: iPad und Safari geben Ton nur nach einer Geste frei. */
function tonVorbereiten() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audio) audio = new Ctx();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch { /* ohne Ton */ }
}

function tonSpielen() {
  if (!audio) return;
  try {
    const t0 = audio.currentTime + 0.02;
    [[880, 0], [1174.66, 0.22], [880, 0.62], [1174.66, 0.84]].forEach(([f, d]) => {
      const osz = audio.createOscillator();
      const g = audio.createGain();
      osz.type = 'sine';
      osz.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + d);
      g.gain.exponentialRampToValueAtTime(0.09, t0 + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.42);
      osz.connect(g).connect(audio.destination);
      osz.start(t0 + d);
      osz.stop(t0 + d + 0.45);
    });
  } catch { /* still */ }
}

function mitteilungMoeglich() {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext !== false;
}

function mitteilungErbitten() {
  try {
    if (mitteilungMoeglich() && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  } catch { /* egal */ }
}

function mitteilen(titel) {
  try {
    if (mitteilungMoeglich() && Notification.permission === 'granted') {
      // eslint-disable-next-line no-new
      new Notification(titel || 'Timer', { body: 'Die Zeit ist um.', tag: `nos-timer-${titel || ''}` });
    }
  } catch { /* manche Browser wollen das nur im Service Worker */ }
}

/* ------------------------------------------------------------------ */
/* Register der laufenden Timer (ueberlebt den Neubau des DOM)          */
/* ------------------------------------------------------------------ */

const LAUFEND = new Map(); // voll -> {timeout, ende, setzen, titel}

function planen(voll, endeMs, setzen, titel) {
  const alt = LAUFEND.get(voll);
  if (alt && alt.ende === endeMs) {
    alt.setzen = setzen;
    return;
  }
  if (alt) clearTimeout(alt.timeout);
  const eintrag = { ende: endeMs, setzen, titel, timeout: null };
  eintrag.timeout = setTimeout(() => {
    LAUFEND.delete(voll);
    tonSpielen();
    mitteilen(eintrag.titel);
    eintrag.setzen({ laeuft: false, fertig: true, start: null, endeAm: endeMs });
  }, Math.max(0, endeMs - Date.now()));
  LAUFEND.set(voll, eintrag);
}

function abplanen(voll) {
  const alt = LAUFEND.get(voll);
  if (alt) clearTimeout(alt.timeout);
  LAUFEND.delete(voll);
}

/* ------------------------------------------------------------------ */
/* Zeichnen                                                             */
/* ------------------------------------------------------------------ */

const RING_R = 30;
const RING_U = 2 * Math.PI * RING_R;

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const dauerMs = spec.dauer * 1000;
  const z = b.zustand.lesen();
  const setzen = (patch) => b.zustand.setzen(patch, { verlauf: false });
  const jetzt = Date.now();
  let zustand = z.fertig ? 'fertig' : (z.laeuft ? 'laeuft' : ((Number(z.verbraucht) || 0) > 0 ? 'pause' : 'bereit'));
  let rest = zustand === 'fertig' ? 0 : timerRest(z, dauerMs, jetzt);

  // Abgelaufen, waehrend niemand zusah (Tab zu, Neuladen): ohne Ton als fertig.
  if (zustand === 'laeuft' && rest <= 0) {
    abplanen(b.voll);
    const endeAm = (z.start || jetzt) + dauerMs - (Number(z.verbraucht) || 0);
    setTimeout(() => setzen({ laeuft: false, fertig: true, start: null, endeAm }), 0);
    zustand = 'fertig';
    rest = 0;
  } else if (zustand === 'laeuft') {
    planen(b.voll, jetzt + rest, setzen, spec.titel);
  }

  const anzeige = h('span.bs-timer__zeit', { role: 'timer', 'aria-live': 'off', 'aria-label': `Restzeit ${zeitFormat(rest / 1000)}` }, text(zeitFormat(rest / 1000)));
  const ring = h('circle.bs-timer__ring-wert', { cx: '36', cy: '36', r: String(RING_R), 'stroke-dasharray': String(RING_U), 'stroke-dashoffset': String(RING_U * (1 - rest / dauerMs)) });
  const ringSvg = h('svg.bs-timer__ring', { attrs: { viewBox: '0 0 72 72', width: '72', height: '72' }, 'aria-hidden': 'true' },
    h('circle.bs-timer__ring-grund', { cx: '36', cy: '36', r: String(RING_R) }), ring);

  const tick = () => {
    const r = timerRest(b.zustand.lesen(), dauerMs, Date.now());
    anzeige.textContent = zeitFormat(r / 1000);
    ring.setAttribute('stroke-dashoffset', String(RING_U * (1 - r / dauerMs)));
    return r;
  };
  if (zustand === 'laeuft') {
    const iv = setInterval(() => {
      if (!anzeige.isConnected && anzeige.dataset.gesehen) { clearInterval(iv); return; }
      if (anzeige.isConnected) anzeige.dataset.gesehen = '1';
      tick();
    }, 250);
    b.beiNeubau(() => clearInterval(iv));
  }

  const start = () => {
    tonVorbereiten();
    mitteilungErbitten();
    setzen({ laeuft: true, start: Date.now(), fertig: false, verbraucht: zustand === 'fertig' ? 0 : (Number(z.verbraucht) || 0) });
  };
  const pause = () => {
    abplanen(b.voll);
    setzen({ laeuft: false, start: null, verbraucht: dauerMs - timerRest(z, dauerMs, Date.now()) });
  };
  const beenden = () => {
    abplanen(b.voll);
    setzen({ laeuft: false, start: null, verbraucht: 0, fertig: false, endeAm: null });
  };

  const knoepfe = h('div.bs-timer__knoepfe');
  if (zustand === 'bereit') knoepfe.append(knopf('Start', { art: 'haupt', symbol: 'start', key: b.key('start'), onClick: start }));
  if (zustand === 'laeuft') knoepfe.append(knopf('Pause', { symbol: 'pause', key: b.key('pause'), onClick: pause }), knopf('Beenden', { art: 'leise', symbol: 'stopp', key: b.key('beenden'), onClick: beenden }));
  if (zustand === 'pause') knoepfe.append(knopf('Fortsetzen', { art: 'haupt', symbol: 'start', key: b.key('weiter'), onClick: start }), knopf('Beenden', { art: 'leise', symbol: 'stopp', key: b.key('beenden'), onClick: beenden }));
  if (zustand === 'fertig') knoepfe.append(knopf('Nochmal', { symbol: 'nochmal', key: b.key('nochmal'), onClick: () => { tonVorbereiten(); setzen({ laeuft: true, start: Date.now(), verbraucht: 0, fertig: false, endeAm: null }); } }));

  const unter = zustand === 'fertig'
    ? (z.endeAm ? `Zeit ist um · ${new Date(z.endeAm).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : 'Zeit ist um')
    : (zustand === 'pause' ? `Pausiert · von ${zeitFormat(spec.dauer)}` : `von ${zeitFormat(spec.dauer)}`);

  return h('div.bs-timer', { class: cx(`is-${zustand}`) },
    spec.titel ? h('div.bs-kopf', null, h('p.bs-titel', null, inline(spec.titel))) : null,
    h('div.bs-timer__zeile', null,
      h('div.bs-timer__uhr', null, ringSvg),
      h('div.bs-timer__text', null, anzeige, h('span.bs-meta', { role: 'status' }, text(unter))),
      knoepfe));
}

export const typen = {
  timer: {
    pruefen,
    render,
    text: (s) => `${s.titel ? `${s.titel}: ` : ''}Timer ${zeitFormat(s.dauer)}`,
  },
};

const CSS = `
.bs-timer__zeile { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 16px; }
.bs-timer__uhr { flex: none; width: 56px; height: 56px; }
.bs-timer__ring { display: block; width: 56px; height: 56px; transform: rotate(-90deg); }
.bs-timer__ring circle { fill: none; stroke-width: 5; }
.bs-timer__ring-grund { stroke: var(--surface-3); }
.bs-timer__ring-wert { stroke: var(--accent); stroke-linecap: round; transition: stroke-dashoffset 250ms linear; }
.bs-timer.is-pause .bs-timer__ring-wert { stroke: var(--fg-subtle); }
.bs-timer.is-fertig .bs-timer__ring-wert { stroke: var(--ok); }
.bs-timer__text { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 120px; }
.bs-timer__zeit { font-size: var(--fs-2xl); font-weight: 500; line-height: 1.1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.bs-timer.is-fertig .bs-timer__zeit { color: var(--ok); animation: bs-timer-ende 900ms var(--ease) 2; }
.bs-timer__knoepfe { display: flex; flex-wrap: wrap; gap: 8px; }
@keyframes bs-timer-ende { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .bs-timer.is-fertig .bs-timer__zeit { animation: none; } .bs-timer__ring-wert { transition: none; } }
`;
