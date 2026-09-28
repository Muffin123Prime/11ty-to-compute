/**
 * bausteine/countdown.js -- wie lange noch bis …
 *
 * Das Ziel ist Wandzeit ohne Zone ("2026-12-24T18:00"), genau wie im
 * Kalender: "um sechs" meint sechs Uhr dort, wo das Geraet gerade ist. Der
 * Baustein zaehlt selbst herunter und sagt am Ziel "Jetzt".
 */

import { h, text } from '../dom.js';
import { str, fehler, LAENGE, inline, ensureStyle } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-countdown';
const ZIEL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** "YYYY-MM-DD[THH:MM[:SS]]" als Ortszeit. @returns {Date|null} */
export function zielLesen(wert) {
  const m = ZIEL_RE.exec(String(wert || '').trim());
  if (!m) return null;
  const [j, mo, t, st, mi, se] = [m[1], m[2], m[3], m[4] || '0', m[5] || '0', m[6] || '0'].map(Number);
  if (mo < 1 || mo > 12 || t < 1 || t > 31 || st > 23 || mi > 59 || se > 59) return null;
  const d = new Date(j, mo - 1, t, st, mi, se);
  if (d.getFullYear() !== j || d.getMonth() !== mo - 1 || d.getDate() !== t) return null;
  return d;
}

/** Restzeit in Teilen. Rein. */
export function countdownTeile(zielMs, jetzt = Date.now()) {
  const diff = Math.max(0, Math.ceil((zielMs - jetzt) / 1000));
  return {
    vorbei: zielMs - jetzt <= 0,
    tage: Math.floor(diff / 86400),
    stunden: Math.floor((diff % 86400) / 3600),
    minuten: Math.floor((diff % 3600) / 60),
    sekunden: diff % 60,
  };
}

function pruefen(roh) {
  const ziel = str(roh.ziel, 25);
  if (!zielLesen(ziel)) throw fehler('„ziel“ fehlt oder ist ungültig (z. B. "2026-12-24T18:00").');
  const out = { ziel };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  return out;
}

function zielText(d, mitZeit) {
  const datum = d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  return mitZeit ? `${datum}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : datum;
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const ziel = zielLesen(spec.ziel);
  const mitZeit = /T|\s/.test(spec.ziel);
  const felder = [['tage', 'Tage'], ['stunden', 'Std.'], ['minuten', 'Min.'], ['sekunden', 'Sek.']];
  const zahlen = {};
  const kacheln = h('div.bs-cd__kacheln', { 'aria-hidden': 'true' }, felder.map(([k, name]) => {
    zahlen[k] = h('span.bs-cd__zahl', null, text('0'));
    return h('div.bs-cd__kachel', { dataset: { teil: k } }, zahlen[k], h('span.bs-cd__einheit', null, text(name)));
  }));
  // "Jetzt" ist der Moment selbst. Wer die Antwort Wochen spaeter wieder
  // oeffnet, liest "Erreicht" -- ein "Jetzt" fuer den Januar waere falsch.
  const langeHer = Date.now() - ziel.getTime() > 60000;
  const jetztText = h('div.bs-cd__jetzt', { hidden: true, class: langeHer ? 'is-her' : null }, text(langeHer ? 'Erreicht' : 'Jetzt'));
  const leser = h('p.bs-nur-leser', { role: 'timer', 'aria-live': 'off' });
  const box = h('div.bs-cd');

  const setze = () => {
    const t = countdownTeile(ziel.getTime(), Date.now());
    for (const [k] of felder) zahlen[k].textContent = k === 'tage' ? String(t[k]) : String(t[k]).padStart(2, '0');
    kacheln.hidden = t.vorbei;
    jetztText.hidden = !t.vorbei;
    box.classList.toggle('is-vorbei', t.vorbei);
    // Tage ausblenden, solange es keine sind: "0 Tage" ist Rauschen.
    kacheln.classList.toggle('ohne-tage', t.tage === 0);
    leser.textContent = t.vorbei ? `${jetztText.textContent}.` : `Noch ${t.tage} Tage, ${t.stunden} Stunden, ${t.minuten} Minuten.`;
    return t;
  };
  const t0 = setze();
  if (!t0.vorbei) {
    const iv = setInterval(() => {
      if (!box.isConnected && box.dataset.gesehen) { clearInterval(iv); return; }
      if (box.isConnected) box.dataset.gesehen = '1';
      if (setze().vorbei) clearInterval(iv);
    }, 1000);
    b.beiNeubau(() => clearInterval(iv));
  }
  box.append(
    h('div.bs-kopf', null, h('p.bs-titel', null, spec.titel ? inline(spec.titel) : text('Countdown'))),
    kacheln, jetztText, leser,
    h('p.bs-meta.bs-cd__ziel', null, text(`${t0.vorbei ? 'Am' : 'Bis'} ${zielText(ziel, mitZeit)}`)));
  return box;
}

export const typen = {
  countdown: {
    pruefen,
    render,
    text: (s) => `${s.titel ? `${s.titel}: ` : ''}Countdown bis ${zielText(zielLesen(s.ziel), /T|\s/.test(s.ziel))}`,
  },
};

const CSS = `
.bs-cd__kacheln { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.bs-cd__kacheln.ohne-tage { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.bs-cd__kacheln.ohne-tage [data-teil="tage"] { display: none; }
.bs-cd__kachel { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 12px 6px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); }
.bs-cd__zahl { font-size: var(--fs-2xl); font-weight: 500; line-height: 1.1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.bs-cd__einheit { font-size: var(--fs-xs); color: var(--fg-subtle); }
.bs-cd__jetzt { padding: 8px 0 4px; font-size: var(--fs-display); font-weight: 500; letter-spacing: -0.02em; color: var(--accent-text); animation: bs-ein var(--dur-3) var(--ease); }
.bs-cd__jetzt.is-her { color: var(--fg-muted); font-size: var(--fs-2xl); }
.bs-cd__ziel { margin: 10px 0 0; }
`;
