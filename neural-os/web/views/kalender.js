/**
 * views/kalender.js -- Platzhalter der Schale fuer den Bereich Kalender.
 *
 * Der Bereich Kalender ersetzt diese Datei durch den richtigen Kalender
 * (Woche, Monat, GET /api/events). Bis dahin ist die Adresse #/kalender nicht
 * leer und nicht erfunden: die Ansicht zeigt die Termine, die wirklich im
 * Tresor stehen (Satzart `event`, ueber die allgemeine Route gelesen), ab
 * heute, nach Tagen geordnet -- oder sagt, dass es keine gibt.
 */

const STYLE_ID = 'nos-kalender-platzhalter';

const CSS = `
.kalv { max-width: var(--content-max); margin: 0 auto; padding: var(--sp-4) var(--sp-4) var(--sp-8); }
.kalv__lead { margin: 0 0 var(--sp-3); color: var(--fg-muted); }
.kalv__tag { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: 500; color: var(--fg-subtle); }
.kalv__liste { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; padding: 0; list-style: none; }
.kalv__termin { display: flex; gap: var(--sp-2); align-items: stretch; padding: 12px var(--sp-2); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-3); }
.kalv__zeit { flex: none; width: 52px; font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.kalv__balken { flex: none; width: 3px; border-radius: var(--r-full); background: var(--accent); }
.kalv__text { min-width: 0; }
.kalv__titel { margin: 0; color: var(--fg); }
.kalv__ort { margin: 0; font-size: var(--fs-sm); color: var(--fg-subtle); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function tagVon(start) {
  return String(start || '').slice(0, 10);
}

export default {
  id: 'kalender',
  title: 'Kalender',
  async mount(container, ctx) {
    const { h, text, api, formatDate } = ctx;
    ensureStyle();
    const root = h('div.kalv', null, h('p.kalv__lead', null, text('Termine, die im Chat entstehen oder die du anlegst.')));
    container.appendChild(root);

    let termine = [];
    try {
      const res = await api.get('/records', { query: { type: 'event', limit: 500 } });
      termine = (res && Array.isArray(res.items) ? res.items : []).map((r) => ({ id: r.id, ...(r.data || {}) }));
    } catch (err) {
      root.appendChild(h('p.is-danger', null, text(`Termine konnten nicht gelesen werden: ${(err && err.message) || 'unbekannter Fehler'}`)));
      return;
    }

    const heute = new Date().toISOString().slice(0, 10);
    const kommend = termine
      .filter((t) => t.start && tagVon(t.start) >= heute)
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));

    if (!kommend.length) {
      root.appendChild(h('div.empty', null,
        h('p', null, text('Keine anstehenden Termine.')),
        h('p.meta', null, text('Sag im Chat einfach „das ist ein Termin“ – er landet dann hier.'))));
      return;
    }

    let tag = null;
    let liste = null;
    for (const t of kommend) {
      if (tagVon(t.start) !== tag) {
        tag = tagVon(t.start);
        root.appendChild(h('h2.kalv__tag', null, text(tag === heute ? 'Heute' : formatDate(tag, { weekday: 'long', day: 'numeric', month: 'long' }))));
        liste = h('ul.kalv__liste');
        root.appendChild(liste);
      }
      const zeit = t.allDay || !/T\d\d:\d\d/.test(t.start) ? 'ganztägig' : String(t.start).slice(11, 16);
      liste.appendChild(h('li.kalv__termin', null,
        h('span.kalv__zeit', null, text(zeit)),
        h('span.kalv__balken', { 'aria-hidden': 'true' }),
        h('div.kalv__text', null,
          h('p.kalv__titel', null, text(t.title || 'Termin')),
          t.location ? h('p.kalv__ort', null, text(t.location)) : null)));
    }
  },
  async unmount() {},
};
