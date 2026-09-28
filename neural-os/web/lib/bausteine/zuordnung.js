/**
 * bausteine/zuordnung.js -- Paare finden.
 *
 * Links antippen, dann rechts (oder rechts zuerst) -- oder von links nach
 * rechts ziehen. Jede Verbindung ist eine Linie zwischen den beiden
 * Spalten, [Prüfen] faerbt sie richtig/falsch. Die rechte Seite ist
 * gemischt, aber immer GLEICH gemischt (Saat aus dem Inhalt): die Nachricht
 * wird bei jeder Aenderung neu gezeichnet, und springende Karten waeren
 * unbedienbar.
 */

import { h, text, cx } from '../dom.js';
import { str, liste, objekt, LAENGE, sym, knopf, inline, ensureStyle, mischen, saatAus } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-zuordnung';

function pruefen(roh) {
  const out = {
    paare: liste(roh.paare, 'paare', {
      min: 2,
      max: 10,
      je: (x) => {
        const o = objekt(x);
        if (!o) return null;
        const links = str(o.links, 160);
        const rechts = str(o.rechts, 160);
        return links && rechts ? { links, rechts } : null;
      },
    }),
  };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  return out;
}

/** Die (stabile) Reihenfolge der rechten Seite: nie genau die richtige. */
export function rechteReihenfolge(spec) {
  const n = spec.paare.length;
  let r = mischen(n, saatAus(JSON.stringify(spec.paare)));
  if (n > 1 && r.every((x, i) => x === i)) r = r.slice(1).concat(r[0]);
  return r;
}

/** Nur gueltige Verbindungen behalten (gespeicherter Zustand kann alt sein). */
export function zuordnungLesen(roh, n) {
  const out = {};
  const belegt = new Set();
  if (!roh || typeof roh !== 'object') return out;
  for (const [k, v] of Object.entries(roh)) {
    const l = Number(k);
    if (!Number.isInteger(l) || l < 0 || l >= n || !Number.isInteger(v) || v < 0 || v >= n || belegt.has(v)) continue;
    out[l] = v;
    belegt.add(v);
  }
  return out;
}

/** Verbinden: eine rechte Karte gehoert hoechstens zu einer linken. */
export function verbinden(zuordnung, links, rechts) {
  const out = {};
  for (const [k, v] of Object.entries(zuordnung)) if (v !== rechts && Number(k) !== links) out[k] = v;
  if (zuordnung[links] !== rechts) out[links] = rechts;
  return out;
}

/** @returns {{richtig:number, gesamt:number, je:Array<boolean|null>}} */
export function zuordnungPruefen(n, zuordnung) {
  const je = Array.from({ length: n }, (_, i) => (zuordnung[i] === undefined ? null : zuordnung[i] === i));
  return { richtig: je.filter((x) => x === true).length, gesamt: n, je };
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const n = spec.paare.length;
  const z = b.zustand.lesen();
  const a = b.ansicht;
  const zuordnung = zuordnungLesen(z.zuordnung, n);
  const geprueft = !!z.geprueft;
  const wertung = zuordnungPruefen(n, zuordnung);
  const rechts = rechteReihenfolge(spec);
  const belegtVon = {};
  for (const [l, r] of Object.entries(zuordnung)) belegtVon[r] = Number(l);

  const setze = (neu, was) => {
    a.links = null;
    a.rechts = null;
    b.zustand.setzen({ zuordnung: neu, geprueft: false }, { was });
  };
  const tippeLinks = (i) => {
    if (a.rechts !== null && a.rechts !== undefined) return setze(verbinden(zuordnung, i, a.rechts), 'Verbunden');
    a.links = a.links === i ? null : i;
    b.neuZeichnen();
  };
  const tippeRechts = (r) => {
    if (a.links !== null && a.links !== undefined) return setze(verbinden(zuordnung, a.links, r), 'Verbunden');
    if (belegtVon[r] !== undefined) {
      // Eine verbundene rechte Karte antippen loest die Verbindung.
      const neu = { ...zuordnung };
      delete neu[belegtVon[r]];
      return setze(neu, 'Gelöst');
    }
    a.rechts = a.rechts === r ? null : r;
    b.neuZeichnen();
  };

  const farbe = (l) => (geprueft ? (zuordnung[l] === l ? 'is-richtig' : 'is-falsch') : 'is-verbunden');
  const nummer = {};
  Object.keys(zuordnung).map(Number).sort((x, y) => x - y).forEach((l, k) => { nummer[l] = k + 1; });

  const spalteL = h('div.bs-zu__spalte', { role: 'group', 'aria-label': 'Links' });
  spec.paare.forEach((p, i) => {
    const verbunden = zuordnung[i] !== undefined;
    spalteL.appendChild(h('button', {
      type: 'button',
      class: cx('bs-zu__karte', 'is-links', verbunden ? farbe(i) : '', { 'is-aktiv': a.links === i }),
      'data-links': String(i),
      'data-key': b.key(`l:${i}`),
      'aria-pressed': String(a.links === i),
      'aria-label': `${p.links}${verbunden ? ` – verbunden mit ${spec.paare[zuordnung[i]].rechts}` : ''}${geprueft && verbunden ? (zuordnung[i] === i ? ' (richtig)' : ' (falsch)') : ''}`,
      onClick: (e) => { e.stopPropagation(); if (!a.gezogen) tippeLinks(i); a.gezogen = false; },
    }, h('span.bs-zu__text', null, inline(p.links, { ohneLinks: true })),
    verbunden ? h('span.bs-zu__nr', { 'aria-hidden': 'true' }, geprueft ? sym(zuordnung[i] === i ? 'haken' : 'kreuz') : text(String(nummer[i]))) : null));
  });
  const spalteR = h('div.bs-zu__spalte', { role: 'group', 'aria-label': 'Rechts' });
  rechts.forEach((r) => {
    const l = belegtVon[r];
    const verbunden = l !== undefined;
    spalteR.appendChild(h('button', {
      type: 'button',
      class: cx('bs-zu__karte', 'is-rechts', verbunden ? farbe(l) : '', { 'is-aktiv': a.rechts === r, 'is-ziel': a.links !== null && a.links !== undefined }),
      'data-rechts': String(r),
      'data-key': b.key(`r:${r}`),
      'aria-pressed': String(a.rechts === r),
      'aria-label': `${spec.paare[r].rechts}${verbunden ? ` – verbunden mit ${spec.paare[l].links}` : ''}`,
      onClick: (e) => { e.stopPropagation(); tippeRechts(r); },
    }, verbunden ? h('span.bs-zu__nr', { 'aria-hidden': 'true' }, geprueft ? sym(l === r ? 'haken' : 'kreuz') : text(String(nummer[l]))) : null,
    h('span.bs-zu__text', null, inline(spec.paare[r].rechts, { ohneLinks: true }))));
  });

  const svg = h('svg.bs-zu__linien', { 'aria-hidden': 'true' });
  const feld = h('div.bs-zu__feld', null, spalteL, svg, spalteR);

  // Linien zwischen den Spalten, nach dem Layout gemessen.
  const zeichneLinien = (zug) => {
    if (!feld.isConnected) return;
    const f = feld.getBoundingClientRect();
    const s = svg.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, s.width)} ${Math.max(1, f.height)}`);
    svg.replaceChildren();
    const linie = (y1, y2, klasse) => {
      const w = s.width;
      const p = h('path', { d: `M0 ${y1} C ${w * 0.5} ${y1}, ${w * 0.5} ${y2}, ${w} ${y2}`, class: klasse });
      svg.appendChild(p);
    };
    for (const [l, r] of Object.entries(zuordnung)) {
      const el = spalteL.querySelector(`[data-links="${l}"]`);
      const er = spalteR.querySelector(`[data-rechts="${r}"]`);
      if (!el || !er) continue;
      const a1 = el.getBoundingClientRect();
      const a2 = er.getBoundingClientRect();
      linie(a1.top + a1.height / 2 - f.top, a2.top + a2.height / 2 - f.top, farbe(Number(l)));
    }
    if (zug) {
      const w = s.width;
      const x = Math.max(0, Math.min(w, zug.x - s.left));
      const p = h('path', { d: `M0 ${zug.y0 - f.top} L ${x} ${zug.y - f.top}`, class: 'is-zug' });
      svg.appendChild(p);
    }
  };
  requestAnimationFrame(() => zeichneLinien());
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => zeichneLinien());
    ro.observe(feld);
    b.beiNeubau(() => ro.disconnect());
  }

  // Ziehen von links nach rechts (Pointer Events: Maus und Finger).
  let zug = null;
  feld.addEventListener('pointerdown', (e) => {
    const karte = e.target.closest('[data-links]');
    if (!karte || e.button > 0) return;
    const r = karte.getBoundingClientRect();
    zug = { id: e.pointerId, links: Number(karte.dataset.links), y0: r.top + r.height / 2, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, bewegt: false };
  });
  feld.addEventListener('pointermove', (e) => {
    if (!zug || e.pointerId !== zug.id) return;
    if (!zug.bewegt && Math.hypot(e.clientX - zug.px, e.clientY - zug.py) < 8) return;
    if (!zug.bewegt) {
      zug.bewegt = true;
      try { feld.setPointerCapture(e.pointerId); } catch { /* egal */ }
      feld.classList.add('is-ziehen');
    }
    zug.x = e.clientX;
    zug.y = e.clientY;
    zeichneLinien(zug);
  });
  const loslassen = (e) => {
    if (!zug || e.pointerId !== zug.id) return;
    const z2 = zug;
    zug = null;
    feld.classList.remove('is-ziehen');
    if (!z2.bewegt) return;
    a.gezogen = true;
    setTimeout(() => { a.gezogen = false; }, 0);
    const ziel = document.elementFromPoint(e.clientX, e.clientY);
    const karte = ziel && ziel.closest ? ziel.closest('[data-rechts]') : null;
    if (karte && feld.contains(karte)) setze(verbinden(zuordnung, z2.links, Number(karte.dataset.rechts)), 'Verbunden');
    else zeichneLinien();
  };
  feld.addEventListener('pointerup', loslassen);
  feld.addEventListener('pointercancel', () => { zug = null; feld.classList.remove('is-ziehen'); zeichneLinien(); });

  const alle = Object.keys(zuordnung).length === n;
  const box = h('div.bs-zu');
  box.appendChild(h('div.bs-kopf', null,
    h('p.bs-titel', null, spec.titel ? inline(spec.titel) : text('Zuordnen')),
    h('span.bs-meta', { class: cx({ 'bs-ok': geprueft && wertung.richtig === n }) },
      text(geprueft ? `${wertung.richtig} von ${n} richtig` : `${Object.keys(zuordnung).length} von ${n} verbunden`))));
  box.appendChild(feld);
  box.appendChild(h('div.bs-fuss', null,
    h('span.bs-leise', null, text(a.links !== null && a.links !== undefined ? 'Jetzt rechts das Gegenstück antippen.' : 'Links antippen, dann rechts – oder ziehen.')),
    h('div.bs-fuss__rechts', null,
      Object.keys(zuordnung).length ? knopf('Zurücksetzen', { art: 'leise', key: b.key('leeren'), onClick: () => setze({}, 'Zurückgesetzt') }) : null,
      knopf('Prüfen', {
        art: 'haupt', disabled: !alle || geprueft, key: b.key('pruefen'),
        onClick: () => b.zustand.setzen({ geprueft: true }, { was: 'Geprüft' }),
      }))));
  return box;
}

export const typen = {
  zuordnung: {
    pruefen,
    render,
    text: (s) => [s.titel || 'Zuordnen', ...s.paare.map((p) => `${p.links} – ${p.rechts}`)].join('\n'),
  },
};

const CSS = `
.bs-zu__feld { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) clamp(36px, 10%, 72px) minmax(0, 1fr); align-items: stretch; }
.bs-zu__spalte { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.bs-zu__linien { width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.bs-zu__linien path { fill: none; stroke-width: 2; stroke-linecap: round; }
.bs-zu__linien path.is-verbunden { stroke: var(--accent); }
.bs-zu__linien path.is-richtig { stroke: var(--ok); }
.bs-zu__linien path.is-falsch { stroke: var(--danger); stroke-dasharray: 5 5; }
.bs-zu__linien path.is-zug { stroke: var(--accent); stroke-dasharray: 3 5; }
.bs-zu__karte { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 12px; font: inherit; font-size: var(--fs-base); line-height: 1.35; text-align: left; color: var(--fg); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); cursor: pointer; touch-action: pan-y; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease); -webkit-tap-highlight-color: transparent; }
.bs-zu__karte.is-rechts { justify-content: flex-start; touch-action: manipulation; }
.bs-zu__karte:hover { background: var(--surface-3); border-color: var(--border-strong); }
.bs-zu__karte:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-zu__karte.is-aktiv { border-color: var(--accent); background: var(--accent-soft); }
.bs-zu__karte.is-ziel:hover { border-color: var(--accent); }
.bs-zu__karte.is-verbunden { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
.bs-zu__karte.is-richtig { border-color: color-mix(in srgb, var(--ok) 60%, transparent); }
.bs-zu__karte.is-falsch { border-color: color-mix(in srgb, var(--danger) 60%, transparent); }
.bs-zu__text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.bs-zu__nr { display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; font-size: var(--fs-xs); font-weight: 600; color: var(--accent-fg); background: var(--accent); border-radius: 50%; font-variant-numeric: tabular-nums; }
.bs-zu__karte.is-richtig .bs-zu__nr { background: var(--ok); color: var(--surface); }
.bs-zu__karte.is-falsch .bs-zu__nr { background: var(--danger); color: var(--surface); }
.bs-zu__nr svg { width: 13px; height: 13px; stroke-width: 2.4; }
.bs-zu__feld.is-ziehen { user-select: none; -webkit-user-select: none; }
@media (pointer: coarse) { .bs-zu__karte { min-height: var(--tap-min); } }
`;
