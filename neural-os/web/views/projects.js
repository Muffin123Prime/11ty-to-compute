/**
 * views/projects.js -- die Projekte und was zu ihnen gehoert.
 *
 * Projekte entstehen und wachsen aus den Chats: die KI legt sie an, haengt
 * Notizen, Termine und Aufgaben daran. Diese Ansicht zeigt deshalb vor allem
 * den Zusammenhang, nicht ein Werkzeug zum Planen:
 *
 * - **Liste, zuletzt geaendert oben.** "Zuletzt" heisst: das Projekt selbst
 *   ODER irgendetwas, das dazugehoert -- ein Projekt, ueber das heute
 *   gesprochen wurde, ist das aktuelle, auch wenn sein Name alt ist.
 * - **Was dazugehoert, rechnet der Server aus** (GET /api/projekte): projectId,
 *   Kanten im Gehirn und die Chats, aus denen diese Dinge stammen. So zeigen
 *   Liste, Einzelansicht und Gehirn dieselbe Wahrheit.
 * - **Abhaken geht direkt.** Eine Aufgabe als erledigt zu markieren ist das
 *   Einzige, was man hier typischerweise tut -- es schreibt sofort in den
 *   Tresor und sagt es, wenn es nicht klappt.
 */

const STYLE_ID = 'nos-projects-list';

const GLYPH = {
  back: '<path d="M8.2 5 3.2 10l5 5M3.6 10h13.2"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  task: '<rect x="3.4" y="3.4" width="13.2" height="13.2" rx="3.2"/><path d="m7 10.2 2.1 2.1 4-4.3"/>',
};

const STATES = [
  ['active', 'Aktiv'],
  ['paused', 'Pausiert'],
  ['done', 'Abgeschlossen'],
  ['archived', 'Archiviert'],
];
const STATE_LABEL = Object.fromEntries(STATES);

const CSS = `
.pj { min-height: 100%; container-type: inline-size; }
.pj__inner { max-width: 1080px; margin: 0 auto; padding: var(--sp-3) var(--sp-4) var(--sp-8); }
.pj__lead { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--fg-subtle); }
.pj__lead strong { font-weight: 500; color: var(--fg-muted); }
.pj__list { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.pj__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 250px);
  gap: var(--sp-3);
  width: 100%;
  padding: 18px 20px;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  box-shadow: var(--shadow-1);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.pj__row:hover { background: var(--surface-3); border-color: var(--border-strong); }
.pj__row:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.pj__row.is-quiet .pj__name { color: var(--fg-muted); }
.pj__main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pj__head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pj__icon { display: grid; place-items: center; flex: none; width: 34px; height: 34px; color: var(--fg); background: var(--surface-3); border: 1px solid var(--border); border-radius: 50%; }
.pj__icon svg { width: 18px; height: 18px; }
.pj__name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-md); font-weight: 500; }
.pj__desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--fg-muted); }
.pj__stats { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 2px 0 0; font-size: var(--fs-sm); color: var(--fg-subtle); }
.pj__stat { display: inline-flex; align-items: center; gap: 6px; }
.pj__stat svg { width: 15px; height: 15px; }
.pj__stat b { font-weight: 500; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.pj__progress { height: 3px; margin-top: 4px; background: var(--surface-4); border-radius: var(--r-full); overflow: hidden; }
.pj__progress span { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
.pj__side { display: flex; flex-direction: column; justify-content: space-between; gap: 10px; min-width: 0; }
.pj__next { display: grid; grid-template-columns: 3px minmax(0, 1fr); gap: 10px; }
.pj__next-bar { border-radius: var(--r-full); background: var(--accent); }
.pj__next-when { display: block; font-size: var(--fs-xs); color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.pj__next-title { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg); }
.pj__none { font-size: var(--fs-sm); color: var(--fg-subtle); }
.pj__when { font-size: var(--fs-xs); color: var(--fg-subtle); }
.pj__empty { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 480px; margin: var(--sp-8) auto; text-align: center; color: var(--fg-subtle); }
.pj__empty-icon { display: grid; place-items: center; width: 56px; height: 56px; color: var(--fg-muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 50%; }
.pj__empty-icon svg { width: 24px; height: 24px; }
.pj__empty h2 { margin: 6px 0 0; font-size: var(--fs-lg); font-weight: 500; color: var(--fg); }
.pj__empty p { margin: 0; line-height: var(--lh); }
.pj__notice { display: flex; align-items: center; gap: 12px; padding: 12px var(--sp-2); margin-bottom: var(--sp-2); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-3); font-size: var(--fs-sm); }

/* ---- Ein Projekt ---- */
.pj__top { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.pj__about { flex: 1 1 320px; min-width: 0; }
.pj__about p { margin: 0; line-height: var(--lh); color: var(--fg-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.pj__about .pj__when { display: block; margin-top: 8px; }
.pj__grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sp-2); align-items: start; }
.pj__col { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.pj__card { padding: 16px 18px 18px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-3); box-shadow: var(--shadow-1); min-width: 0; }
.pj__card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.pj__card-head svg { width: 19px; height: 19px; color: var(--fg); }
.pj__card-title { margin: 0; font-size: var(--fs-md); font-weight: 500; }
.pj__card-count { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 7px; font-size: var(--fs-xs); font-weight: 600; color: var(--fg-muted); background: var(--surface-3); border-radius: var(--r-full); }
.pj__card-empty { margin: 0; font-size: var(--fs-sm); color: var(--fg-subtle); line-height: 1.5; }
.pj__items { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.pj__items > li + li { border-top: 1px solid var(--border); }
.pj__item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 44px;
  padding: 9px 4px;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: none;
  border: 0;
  border-radius: var(--r-2);
  cursor: pointer;
  text-decoration: none;
}
.pj__item:hover { background: var(--surface-3); }
.pj__item:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.pj__item svg { flex: none; width: 17px; height: 17px; color: var(--fg-subtle); }
.pj__item-main { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.pj__item-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pj__item-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg-subtle); }
.pj__item-side { flex: none; font-size: var(--fs-xs); color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.pj__item.is-past { opacity: 0.6; }
.pj__termin-bar { flex: none; align-self: stretch; width: 3px; border-radius: var(--r-full); background: var(--accent); }
.pj__termin-when { display: flex; flex-direction: column; gap: 2px; flex: none; width: 104px; font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.pj__task { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 6px 4px; cursor: pointer; border-radius: var(--r-2); }
.pj__task:hover { background: var(--surface-3); }
.pj__task input { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.pj__task.is-done .pj__item-title { color: var(--fg-subtle); text-decoration: line-through; text-decoration-color: var(--border-strong); }
.pj__task.is-busy { opacity: 0.6; pointer-events: none; }
.pj__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: var(--sp-3); }
.pj__actions .spacer { flex: 1 1 auto; }
.pj__danger { color: var(--danger); }

@container (max-width: 760px) {
  .pj__grid { grid-template-columns: minmax(0, 1fr); }
  .pj__row { grid-template-columns: minmax(0, 1fr); gap: 12px; }
}
@container (max-width: 560px) {
  .pj__inner { padding: var(--sp-2) var(--sp-2) var(--sp-6); }
}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Wann ein Termin ist, kurz: "heute 09:00", "Do, 25. Sept. · 09:00",
 * "Sa, 27. Sept." (ganztaegig). Liest dieselben drei Formen wie der Kalender.
 */
export function whenShort(ev, now = new Date()) {
  const s = String((ev && ev.start) || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
  if (!m) return '';
  let d;
  let timed = !!m[4] && !(ev && ev.allDay);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && m[4]) d = new Date(Date.parse(s));
  else d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  if (!Number.isFinite(d.getTime())) return '';
  const hm = timed ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let label;
  if (day(d) === day(now)) label = 'heute';
  else if (day(d) === day(tomorrow)) label = 'morgen';
  else {
    try {
      label = new Intl.DateTimeFormat('de-DE', d.getFullYear() === now.getFullYear()
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
    } catch {
      label = s.slice(0, 10);
    }
  }
  timed = timed && !!hm;
  return timed ? `${label} · ${hm}` : label;
}

function errorText(err) {
  return (err && err.message) || 'Unbekannter Fehler.';
}

function plural(n, eins, viele) {
  return `${n} ${n === 1 ? eins : viele}`;
}

export default {
  id: 'projects',
  title: 'Projekte',

  async mount(container, ctx) {
    ensureStyle();
    const { h, text, clear, icon, api, icons, bus, toast, confirm, navigate, timeAgo } = ctx;
    const I = { ...icons, ...GLYPH };
    const detailId = ctx.route && ctx.route.params ? ctx.route.params.id || null : null;

    const st = { items: [], projekt: null, loaded: false, error: null, token: 0, alive: true, busy: new Set() };
    const cleanups = [];
    const root = h('div.pj');
    const inner = h('div.pj__inner');
    root.appendChild(inner);
    container.appendChild(root);

    if (detailId) {
      ctx.setHeadActions(h('button.btn.btn--ghost.btn--small', { type: 'button', onClick: () => navigate('#/projects') },
        icon(I.back), text('Alle Projekte')));
    }

    /* ---------------- Daten ---------------- */

    async function load() {
      const token = ++st.token;
      try {
        if (detailId) {
          const res = await api.get(`/projekte/${encodeURIComponent(detailId)}`);
          if (!st.alive || token !== st.token) return;
          st.projekt = res.projekt;
          ctx.setTitle(st.projekt.name);
        } else {
          const res = await api.get('/projekte');
          if (!st.alive || token !== st.token) return;
          st.items = Array.isArray(res && res.items) ? res.items : [];
        }
        st.error = null;
      } catch (err) {
        if (!st.alive || token !== st.token) return;
        st.error = err;
      }
      st.loaded = true;
      render();
    }

    let reloadTimer = null;
    const reloadSoon = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => load(), 300);
    };

    /* ---------------- Zeichnen ---------------- */

    function render() {
      if (!st.alive) return;
      clear(inner);
      if (st.error) {
        if (detailId && st.error.status === 404) {
          inner.appendChild(emptyState('Dieses Projekt gibt es nicht mehr', 'Vielleicht wurde es gelöscht. Alle übrigen Projekte stehen in der Liste.',
            h('button.btn', { type: 'button', onClick: () => navigate('#/projects') }, text('Zur Liste'))));
          return;
        }
        inner.appendChild(h('div.pj__notice', { role: 'alert' },
          text(`${detailId ? 'Das Projekt' : 'Die Projekte'} konnte${detailId ? '' : 'n'} nicht geladen werden: ${errorText(st.error)}`),
          h('button.btn.btn--small', { type: 'button', onClick: () => load() }, text('Erneut versuchen'))));
        return;
      }
      if (!st.loaded) return;
      if (detailId) renderDetail();
      else renderList();
    }

    function emptyState(title, line, action) {
      return h('div.pj__empty', null,
        h('span.pj__empty-icon', { 'aria-hidden': 'true' }, icon(I.projects)),
        h('h2', null, text(title)),
        h('p', null, text(line)),
        action || null);
    }

    function renderList() {
      if (!st.items.length) {
        inner.appendChild(emptyState('Noch keine Projekte',
          'Sprich im Chat über ein Vorhaben – die KI legt das Projekt an und sammelt hier, was dazugehört: Chats, Termine, Notizen und Aufgaben.'));
        return;
      }
      const aktiv = st.items.filter((p) => p.status === 'active').length;
      inner.appendChild(h('p.pj__lead', null,
        h('strong', null, text(plural(st.items.length, 'Projekt', 'Projekte'))),
        text(`${aktiv !== st.items.length ? ` · ${aktiv} aktiv` : ''} · zuletzt geändert oben`)));
      const list = h('ul.pj__list');
      for (const p of st.items) list.appendChild(h('li', null, renderRow(p)));
      inner.appendChild(list);
    }

    function renderRow(p) {
      const z = p.zaehler || {};
      const quiet = p.status !== 'active';
      const stats = h('span.pj__stats', null,
        stat(I.chat, z.chats, 'Chat', 'Chats'),
        stat(I.calendar, z.termine, 'Termin', 'Termine'),
        stat(I.notes, z.notizen, 'Notiz', 'Notizen'),
        z.aufgaben
          ? h('span.pj__stat', null, icon(GLYPH.task), h('b', null, text(`${z.aufgabenErledigt}/${z.aufgaben}`)), text(' erledigt'))
          : stat(GLYPH.task, 0, 'Aufgabe', 'Aufgaben'));
      const next = p.naechsterTermin;
      return h('button.pj__row', {
        type: 'button',
        class: quiet ? 'is-quiet' : '',
        onClick: () => navigate(`#/projects?id=${encodeURIComponent(p.id)}`),
      },
      h('span.pj__main', null,
        h('span.pj__head', null,
          h('span.pj__icon', { 'aria-hidden': 'true' }, icon(I.projects)),
          h('span.pj__name', null, text(p.name)),
          quiet ? h('span.badge', null, text(STATE_LABEL[p.status] || p.status)) : null),
        p.description ? h('span.pj__desc', null, text(p.description)) : null,
        stats,
        z.aufgaben ? h('span.pj__progress', { 'aria-hidden': 'true' },
          h('span', { style: { width: `${Math.round((z.aufgabenErledigt / z.aufgaben) * 100)}%` } })) : null),
      h('span.pj__side', null,
        next
          ? h('span.pj__next', null, h('span.pj__next-bar', { 'aria-hidden': 'true' }),
            h('span', null,
              h('span.pj__next-when', null, text(`Nächster Termin · ${whenShort(next)}`)),
              h('span.pj__next-title', null, text(next.title))))
          : h('span.pj__none', null, text('Kein anstehender Termin')),
        h('span.pj__when', null, text(`geändert ${timeAgo(p.zuletzt)}`))));
    }

    function stat(glyph, n, eins, viele) {
      return h('span.pj__stat', null, icon(glyph), h('b', null, text(String(n || 0))), text(` ${n === 1 ? eins : viele}`));
    }

    function renderDetail() {
      const p = st.projekt;
      const z = p.zaehler || {};

      const states = h('div.segmented', { role: 'group', 'aria-label': 'Stand des Projekts' });
      for (const [value, label] of STATES) {
        states.appendChild(h('button.segmented__option', {
          type: 'button',
          class: p.status === value ? 'is-active' : '',
          'aria-pressed': p.status === value ? 'true' : 'false',
          onClick: () => setStatus(value),
        }, text(label)));
      }

      inner.appendChild(h('div.pj__top', null,
        h('div.pj__about', null,
          p.description ? h('p', null, text(p.description)) : h('p', null, text('Noch keine Beschreibung – die KI ergänzt sie, wenn ihr darüber sprecht.')),
          h('span.pj__when', null, text(`Angelegt ${timeAgo(p.createdAt)} · zuletzt geändert ${timeAgo(p.zuletzt)}`))),
        states));

      const left = h('div.pj__col', null, card(GLYPH.task, 'Aufgaben', z.aufgaben, renderTasks(p.aufgaben || []), 'Noch keine Aufgaben.'),
        card(I.calendar, 'Termine', z.termine, renderEvents(p.termine || []), 'Noch keine Termine.'));
      const right = h('div.pj__col', null, card(I.chat, 'Chats', z.chats, renderChats(p.chats || []), 'Noch kein Chat gehört dazu.'),
        card(I.notes, 'Notizen', z.notizen, renderNotes(p.notizen || []), 'Noch keine Notizen.'));
      inner.appendChild(h('div.pj__grid', null, left, right));

      inner.appendChild(h('div.pj__actions', null,
        h('button.btn', { type: 'button', onClick: () => navigate(`#/graph?focus=${encodeURIComponent(p.id)}`) }, icon(I.graph), text('Im Gehirn zeigen')),
        h('span.spacer'),
        h('button.btn.btn--ghost.pj__danger', { type: 'button', onClick: () => removeProject(p) }, icon(GLYPH.trash), text('Projekt löschen'))));
    }

    function card(glyph, title, count, list, emptyLine) {
      return h('section.pj__card', { 'aria-label': title },
        h('header.pj__card-head', null, icon(glyph), h('h3.pj__card-title', null, text(title)),
          count ? h('span.pj__card-count', null, text(String(count))) : null),
        list || h('p.pj__card-empty', null, text(emptyLine)));
    }

    function renderTasks(tasks) {
      if (!tasks.length) return null;
      const ul = h('ul.pj__items');
      for (const t of tasks) {
        const done = t.status === 'done';
        const box = h('input', { type: 'checkbox', checked: done, 'aria-label': `${t.title} ${done ? 'wieder öffnen' : 'abhaken'}` });
        box.addEventListener('change', () => toggleTask(t, box.checked));
        ul.appendChild(h('li', null, h('label.pj__task', { class: { 'is-done': done, 'is-busy': st.busy.has(t.id) } },
          box,
          h('span.pj__item-main', null,
            h('span.pj__item-title', null, text(t.title)),
            t.due || t.status === 'doing' || t.status === 'blocked'
              ? h('span.pj__item-sub', null, text([
                t.status === 'doing' ? 'in Arbeit' : t.status === 'blocked' ? 'blockiert' : null,
                t.due ? `fällig ${whenShort({ start: t.due, allDay: true })}` : null,
              ].filter(Boolean).join(' · ')))
              : null))));
      }
      return ul;
    }

    function renderEvents(events) {
      if (!events.length) return null;
      const now = Date.now();
      // Anstehendes zuerst, Vergangenes danach und blasser.
      const past = (e) => {
        const d = Date.parse(e.end || e.start);
        return Number.isFinite(d) && d + (e.end ? 0 : 3600000) < now && !/^\d{4}-\d{2}-\d{2}$/.test(e.end || e.start);
      };
      const ordered = [...events.filter((e) => !past(e)), ...events.filter(past).reverse()];
      const ul = h('ul.pj__items');
      for (const e of ordered) {
        const [tag, zeit] = whenShort(e).split(' · ');
        ul.appendChild(h('li', null, h('a.pj__item', { href: `#/kalender?id=${encodeURIComponent(e.id)}`, class: past(e) ? 'is-past' : '' },
          h('span.pj__termin-when', null, h('span', null, text(tag)), zeit ? h('span', null, text(zeit)) : null),
          h('span.pj__termin-bar', { 'aria-hidden': 'true' }),
          h('span.pj__item-main', null,
            h('span.pj__item-title', null, text(e.title)),
            e.location ? h('span.pj__item-sub', null, text(e.location)) : null))));
      }
      return ul;
    }

    function renderChats(chats) {
      if (!chats.length) return null;
      const ul = h('ul.pj__items');
      for (const c of chats) {
        ul.appendChild(h('li', null, h('a.pj__item', { href: `#/chat?id=${encodeURIComponent(c.id)}` },
          icon(I.chat),
          h('span.pj__item-main', null, h('span.pj__item-title', null, text(c.title))),
          h('span.pj__item-side', null, text(timeAgo(c.updatedAt))))));
      }
      return ul;
    }

    function renderNotes(notes) {
      if (!notes.length) return null;
      const ul = h('ul.pj__items');
      for (const n of notes) {
        const excerpt = String(n.body || '').replace(/[#*_>`[\]]+/g, '').replace(/\s+/g, ' ').trim();
        ul.appendChild(h('li', null, h('a.pj__item', { href: `#/notes?id=${encodeURIComponent(n.id)}` },
          icon(I.notes),
          h('span.pj__item-main', null,
            h('span.pj__item-title', null, text(n.title)),
            excerpt ? h('span.pj__item-sub', null, text(excerpt)) : null),
          h('span.pj__item-side', null, text(n.source === 'auto' ? 'automatisch' : timeAgo(n.updatedAt))))));
      }
      return ul;
    }

    /* ---------------- Aendern ---------------- */

    async function toggleTask(task, done) {
      st.busy.add(task.id);
      render();
      try {
        await api.patch(`/records/${encodeURIComponent(task.id)}`, { data: { status: done ? 'done' : 'todo' } });
        if (!st.alive) return;
        toast(done ? `„${task.title}“ erledigt.` : `„${task.title}“ wieder offen.`, 'success', { timeout: 3000 });
      } catch (err) {
        toast(`Das hat nicht geklappt: ${errorText(err)}`, 'error');
      } finally {
        st.busy.delete(task.id);
      }
      await load();
    }

    async function setStatus(status) {
      const p = st.projekt;
      if (!p || p.status === status) return;
      try {
        await api.patch(`/records/${encodeURIComponent(p.id)}`, { data: { status } });
      } catch (err) {
        toast(`Das hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      await load();
    }

    async function removeProject(p) {
      const ok = await confirm({
        title: 'Projekt löschen?',
        message: `„${p.name}“ verschwindet aus der Liste. Chats, Termine, Notizen und Aufgaben bleiben erhalten. Du kannst es gleich danach rückgängig machen.`,
        confirmLabel: 'Löschen',
        danger: true,
      });
      if (!ok || !st.alive) return;
      try {
        await api.del(`/records/${encodeURIComponent(p.id)}`);
      } catch (err) {
        toast(`Löschen hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      toast(`„${p.name}“ gelöscht.`, 'success', {
        action: {
          label: 'Rückgängig',
          run: async () => {
            try {
              await api.post(`/records/${encodeURIComponent(p.id)}/restore`);
              navigate(`#/projects?id=${encodeURIComponent(p.id)}`);
            } catch (err) {
              toast(`Wiederherstellen hat nicht geklappt: ${errorText(err)}`, 'error');
            }
          },
        },
        timeout: 9000,
      });
      navigate('#/projects');
    }

    /* ---------------- Live und Aufraeumen ---------------- */

    const WATCHED = new Set(['project', 'task', 'event', 'note', 'chat', 'edge']);
    for (const name of ['record.created', 'record.updated', 'record.deleted']) {
      cleanups.push(bus.on(name, (payload) => {
        const type = payload && (payload.type || (payload.record && payload.record.type));
        if (WATCHED.has(type)) reloadSoon();
      }));
    }
    cleanups.push(() => clearTimeout(reloadTimer));

    this._cleanup = () => {
      st.alive = false;
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* weiter aufraeumen */ }
      }
    };

    await load();
  },

  async unmount() {
    if (typeof this._cleanup === 'function') this._cleanup();
    this._cleanup = null;
  },
};
