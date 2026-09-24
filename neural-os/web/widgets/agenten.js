/**
 * widgets/agenten.js -- Kachel "Agenten aktiv (N) · Automatisch erkannt".
 *
 * Wie in der Vorlage: je Zeile ein rundes Symbol der Rolle, der Name
 * ("Recherche-Agent"), darunter, was er gerade tut, rechts ein blauer Punkt
 * "Aktiv" -- oder ein grauer Haken "Fertig". Die Zahl oben zaehlt nur, wer
 * WIRKLICH gerade arbeitet.
 *
 * Woher die Zeilen kommen:
 * - beim Einhaengen die letzten Laeufe (GET /api/runs), damit die Kachel
 *   nach einem Neuladen nicht leer tut, als sei nie etwas geschehen;
 * - danach live ueber den Bus: jedes `agent.aktivitaet` (Vertrag 7) ersetzt
 *   die Zeile seines Laufs. Ohne Neuladen, auch waehrend die Antwort im
 *   Chat noch streamt.
 *
 * Ehrlich statt fleissig: ein Lauf, der seit einer Viertelstunde "laeuft"
 * (Neustart mitten im Zug), zaehlt nicht als aktiv, sondern steht als
 * unterbrochen da.
 *
 * Schnittstelle (Vertrag 2): export function mount(el, ctx) -> { unmount() }
 */

import { rolle, zustandVon } from '../lib/agenten.js';

const STYLE_ID = 'nos-kachel-agenten';
const ZEILEN = 3;

const CSS = `
.kwa__list { display: flex; flex-direction: column; gap: 14px; margin: 0; padding: 0; list-style: none; }
.kwa__row { display: flex; align-items: center; gap: 14px; min-width: 0; color: inherit; text-decoration: none; border-radius: var(--r-3); }
.kwa__row:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
@media (hover: hover) { .kwa__row:hover .tile__item-title { text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 3px; } }
.kwa__row.is-alt { opacity: 0.62; }
.kwa__side { display: inline-flex; align-items: center; gap: 7px; flex: none; font-size: var(--fs-sm); color: var(--fg-muted); }
.kwa__side svg { width: 15px; height: 15px; color: var(--fg-subtle); }
.kwa__side.is-laeuft { color: var(--fg); }
.kwa__side.is-fehler, .kwa__side.is-fehler svg { color: var(--danger); }
@media (pointer: coarse) { .kwa__row { min-height: var(--tap-min); } }
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

/** Ein Lauf-Satz (GET /api/runs) in die Form des Bus-Ereignisses. */
function ausSatz(r) {
  const d = r.data || {};
  return {
    id: r.id,
    runId: r.id,
    rolle: d.rolle || null,
    titel: d.titel || d.goal || '',
    schritt: Array.isArray(d.steps) && d.steps.length && d.status === 'running' ? String(d.steps[d.steps.length - 1].text || '') : '',
    status: d.status,
    startedAt: d.startedAt || r.createdAt,
    zeit: Date.parse(r.updatedAt || r.createdAt) || 0,
    chatId: d.chatId || null,
  };
}

export function mount(el, ctx) {
  ensureStyle();
  const { h, text, clear, icon, icons, tileHead, api, bus } = ctx;
  const laeufe = new Map();
  const offs = [];
  let alive = true;
  let head = null;
  let fehler = null;
  const body = h('div.tile__body');

  function zeichne() {
    if (!alive) return;
    const jetzt = Date.now();
    const alle = [...laeufe.values()].map((l) => ({ ...l, sicht: zustandVon(l, jetzt) }));
    const aktiv = alle.filter((l) => l.sicht === 'laeuft').sort((a, b) => b.zeit - a.zeit);
    const rest = alle.filter((l) => l.sicht !== 'laeuft').sort((a, b) => b.zeit - a.zeit);
    const zeigen = [...aktiv, ...rest].slice(0, Math.max(ZEILEN, aktiv.length));

    const neuerKopf = tileHead({ icon: icons.agents, title: 'Agenten aktiv', count: aktiv.length, meta: 'Automatisch erkannt', href: '#/agents' });
    if (head) head.replaceWith(neuerKopf);
    else el.prepend(neuerKopf);
    head = neuerKopf;

    clear(body);
    if (fehler && !alle.length) {
      body.appendChild(h('p.tile__empty', null, text(`Nicht abrufbar: ${fehler}`)));
      return;
    }
    if (!zeigen.length) {
      body.appendChild(h('p.tile__empty', null, text('Noch keiner. Sobald ein Agent für dich sucht, plant oder einträgt, steht er hier.')));
      return;
    }
    const ul = h('ul.kwa__list');
    for (const l of zeigen) {
      const r = rolle(l.rolle);
      const was = l.sicht === 'laeuft' ? (l.titel || l.schritt || r.kurz) : (l.titel || r.kurz);
      let seite;
      if (l.sicht === 'laeuft') {
        seite = h('span.kwa__side.is-laeuft', null, h('span.dot.dot--accent'), text('Aktiv'));
      } else if (l.sicht === 'fehler') {
        seite = h('span.kwa__side.is-fehler', null, icon(icons.alert), text('Fehler'));
      } else if (l.sicht === 'unterbrochen') {
        seite = h('span.kwa__side', null, icon(icons.info), text('Unterbrochen'));
      } else {
        seite = h('span.kwa__side', null, icon(icons.check), text('Fertig'));
      }
      ul.appendChild(h('li', null, h('a.kwa__row', {
        href: `#/agents?id=${encodeURIComponent(l.runId || l.id)}`,
        class: l.sicht === 'laeuft' ? '' : 'is-alt',
        'data-zustand': l.sicht,
        'aria-label': `${r.name}: ${was} – ${seite.textContent}`,
      },
      h('span.tile__avatar', { 'aria-hidden': 'true' }, icon(icons[r.symbol] || icons.agents)),
      h('span.tile__item-main', null,
        h('span.tile__item-title', null, text(r.name)),
        h('span.tile__item-sub', null, text(was))),
      seite)));
    }
    body.appendChild(ul);
  }

  let geplant = null;
  const bald = () => {
    if (geplant) return;
    geplant = setTimeout(() => {
      geplant = null;
      zeichne();
    }, 120);
  };

  async function laden() {
    try {
      const res = await api.get('/runs', { query: { limit: 30, sort: 'createdAt', order: 'desc' }, timeoutMs: 8000 });
      if (!alive) return;
      fehler = null;
      const items = Array.isArray(res && res.items) ? res.items : [];
      for (const r of items) {
        const neu = ausSatz(r);
        const alt = laeufe.get(neu.id);
        // Ein Bus-Ereignis, das juenger ist als die Liste, gewinnt.
        if (!alt || alt.zeit <= neu.zeit) laeufe.set(neu.id, neu);
      }
    } catch (err) {
      if (!alive) return;
      fehler = (err && err.message) || 'unbekannter Fehler';
    }
    zeichne();
  }

  offs.push(bus.on('agent.aktivitaet', (p) => {
    if (!p || !p.id) return;
    const alt = laeufe.get(p.id) || {};
    laeufe.set(p.id, {
      ...alt,
      id: p.id,
      runId: p.runId || alt.runId || p.id,
      rolle: p.rolle || alt.rolle,
      titel: p.titel || alt.titel || '',
      schritt: p.schritt || '',
      zustand: p.zustand,
      status: undefined,
      startedAt: alt.startedAt || new Date(Date.now() - (Number(p.dauerMs) || 0)).toISOString(),
      zeit: Date.now(),
      chatId: p.chatId || alt.chatId || null,
    });
    bald();
  }));
  // Die alte Agenten-Laufzeit (Zeitplaene) meldet sich mit run.*.
  let nachladen = null;
  const spaeter = () => {
    clearTimeout(nachladen);
    nachladen = setTimeout(laden, 400);
  };
  for (const name of ['run.started', 'run.finished', 'run.failed', 'hello']) offs.push(bus.on(name, spaeter));
  // Einmal die Minute: ein liegengebliebener Lauf wird als unterbrochen erkannt.
  const tick = setInterval(zeichne, 60000);

  el.appendChild(body);
  zeichne();
  laden();

  return {
    unmount() {
      alive = false;
      clearTimeout(geplant);
      clearTimeout(nachladen);
      clearInterval(tick);
      for (const off of offs) {
        try { off(); } catch { /* weiter */ }
      }
      clear(el);
    },
  };
}

export default { mount };
