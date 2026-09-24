/**
 * widgets/kalender.js -- Kachel "Kalender · Heute, <Datum>" in der rechten Spalte.
 *
 * Wie in der Vorlage: links die Uhrzeit (Beginn ueber Ende), der blaue Balken,
 * daneben Titel und Ort in einer leisen Karte. Gezeigt wird nur HEUTE -- das
 * ist die Frage, die man beim Seitenblick stellt. Ist heute nichts, sagt die
 * Kachel das ehrlich und nennt den naechsten Termin, statt leer zu wirken.
 *
 * Serien kommen je Vorkommen (Vertrag B: gleiche id, `occurrence`); ein
 * Antippen oeffnet genau dieses Vorkommen (`&am=JJJJ-MM-TT`).
 *
 * Live ueber den Bus (record.* mit Satzart `event`): legt die KI im Chat einen
 * Termin fuer heute an, steht er hier, waehrend die Antwort noch laeuft. Um
 * Mitternacht rueckt die Kachel von selbst auf den neuen Tag.
 *
 * Schnittstelle (Vertrag 2): export function mount(el, ctx) -> { unmount() }
 */

const STYLE_ID = 'nos-kachel-kalender';
const MAX_ROWS = 3;

const CSS = `
.kwk__list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.kwk__row {
  display: grid;
  grid-template-columns: 44px 3px minmax(0, 1fr);
  gap: 12px;
  align-items: stretch;
  color: inherit;
  text-decoration: none;
  border-radius: var(--r-3);
}
.kwk__row:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.kwk__time { display: flex; flex-direction: column; justify-content: center; gap: 5px; font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.kwk__bar { border-radius: var(--r-full); background: var(--accent); }
.kwk__card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  min-height: 52px;
  padding: 9px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.kwk__row:hover .kwk__card { background: var(--surface-2); border-color: var(--border-strong); }
.kwk__title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13.5px; color: var(--fg); }
.kwk__sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg-subtle); }
.kwk__row.is-past { opacity: 0.5; }
.kwk__more { display: inline-block; margin-top: 10px; font-size: var(--fs-sm); color: var(--fg-subtle); text-decoration: none; }
.kwk__more:hover { color: var(--fg); }
.kwk__next { display: flex; flex-direction: column; gap: 3px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); color: inherit; text-decoration: none; }
.kwk__next-label { font-size: var(--fs-xs); color: var(--fg-subtle); }
.kwk__next-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg-muted); }
.kwk__next:hover .kwk__next-title { color: var(--fg); }
@media (pointer: coarse) {
  .kwk__next, .kwk__more { min-height: var(--tap-min); justify-content: center; }
  .kwk__more { display: inline-flex; align-items: center; }
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
const toDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return toDay(new Date(y, m - 1, d + n));
}

/**
 * Beginn und Ende eines Termins in Ortszeit -- dieselben drei Formen wie im
 * Kalender (Tag, Uhrzeit vor Ort, Zeitpunkt mit Zone).
 */
function when(value) {
  const s = String(value || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { day: s, hm: null, ms: new Date(+m[1], +m[2] - 1, +m[3]).getTime() };
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  let d;
  if (m) d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  else if (/T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) d = new Date(Date.parse(s));
  if (!d || !Number.isFinite(d.getTime())) return null;
  return { day: toDay(d), hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, ms: d.getTime() };
}

/** Wohin ein Antippen fuehrt: der Termin, bei Serien genau dieses Vorkommen. */
function ziel(r) {
  const occ = r.occurrence || (r.data && r.data.occurrence) || null;
  return `#/kalender?id=${encodeURIComponent(r.id)}${occ ? `&am=${occ}` : ''}`;
}

function span(data) {
  const start = when(data.start);
  if (!start) return null;
  let end = when(data.end);
  if (end && end.ms < start.ms) end = null;
  const allDay = data.allDay === true || !start.hm;
  let lastDay = end ? end.day : start.day;
  if (end && !allDay && end.hm === '00:00' && end.day > start.day) lastDay = addDays(end.day, -1);
  return { allDay, start, end, firstDay: start.day, lastDay };
}

export function mount(el, ctx) {
  ensureStyle();
  const { h, text, clear, icons, tileHead, api, bus, formatDate } = ctx;
  let alive = true;
  let token = 0;
  let head = null;
  const body = h('div.tile__body');
  const offs = [];

  function setHead(day) {
    const meta = `Heute, ${formatDate(new Date(`${day}T12:00:00`), { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const next = tileHead({ icon: icons.calendar, title: 'Kalender', meta, href: '#/kalender' });
    if (head) head.replaceWith(next);
    else el.prepend(next);
    head = next;
  }

  function label(s, day) {
    if (s.allDay || (s.firstDay < day && s.lastDay > day)) return ['ganzt.', ''];
    const von = s.firstDay === day ? s.start.hm : '00:00';
    const bis = s.end && s.lastDay === day ? s.end.hm : (s.lastDay > day ? '24:00' : '');
    return [von, bis];
  }

  function past(s, day) {
    if (s.allDay) return false;
    const end = s.end && s.lastDay === day ? s.end.ms : (s.lastDay > day ? Infinity : s.start.ms + 3600000);
    return end < Date.now();
  }

  function render(day, items, error) {
    clear(body);
    if (error) {
      body.appendChild(h('p.tile__empty', null, text(`Termine nicht abrufbar: ${error}`)));
      return;
    }
    const heute = [];
    let next = null;
    for (const r of items) {
      const s = span(r.data || {});
      if (!s) continue;
      if (s.firstDay <= day && s.lastDay >= day) heute.push({ r, s });
      else if (s.firstDay > day && !next) next = { r, s };
    }
    heute.sort((a, b) => {
      const aa = a.s.allDay || a.s.firstDay < day;
      const bb = b.s.allDay || b.s.firstDay < day;
      if (aa !== bb) return aa ? -1 : 1;
      return a.s.start.ms - b.s.start.ms;
    });

    if (!heute.length) {
      body.appendChild(h('p.tile__empty', null, text('Heute nichts.')));
    } else {
      const ul = h('ul.kwk__list');
      for (const { r, s } of heute.slice(0, MAX_ROWS)) {
        const [von, bis] = label(s, day);
        const sub = r.data.location || (r.data.source === 'auto' ? 'von der KI' : '');
        ul.appendChild(h('li', null, h('a.kwk__row', {
          href: ziel(r),
          class: past(s, day) ? 'is-past' : '',
          'aria-label': `${bis ? `${von} bis ${bis}` : von}, ${r.data.title}${r.data.location ? `, ${r.data.location}` : ''}`,
        },
        h('span.kwk__time', null, h('span', null, text(von)), bis ? h('span', null, text(bis)) : null),
        h('span.kwk__bar', { 'aria-hidden': 'true' }),
        h('span.kwk__card', null,
          h('span.kwk__title', null, text(r.data.title)),
          sub ? h('span.kwk__sub', null, text(sub)) : null))));
      }
      body.appendChild(ul);
      if (heute.length > MAX_ROWS) {
        const rest = heute.length - MAX_ROWS;
        body.appendChild(h('a.kwk__more', { href: '#/kalender' }, text(`+ ${rest} ${rest === 1 ? 'weiterer' : 'weitere'} heute`)));
      }
    }
    if (!heute.length && next) {
      const tag = next.s.firstDay === addDays(day, 1)
        ? 'Morgen'
        : formatDate(new Date(`${next.s.firstDay}T12:00:00`), { weekday: 'short', day: 'numeric', month: 'short' });
      const zeit = next.s.allDay ? '' : ` · ${next.s.start.hm}`;
      body.appendChild(h('a.kwk__next', { href: ziel(next.r) },
        h('span.kwk__next-label', null, text(`Als Nächstes · ${tag}${zeit}`)),
        h('span.kwk__next-title', null, text(next.r.data.title))));
    }
  }

  let shownDay = null;
  let last = { items: [], error: null };
  async function load() {
    const mine = ++token;
    const day = toDay(new Date());
    if (day !== shownDay) {
      shownDay = day;
      setHead(day);
    }
    try {
      // Heute und die naechsten zwei Wochen: genug fuer "Als Naechstes".
      const res = await api.get('/events/zeitraum', { query: { from: day, to: addDays(day, 14) } });
      if (!alive || mine !== token) return;
      last = { items: Array.isArray(res && res.items) ? res.items : [], error: null };
    } catch (err) {
      if (!alive || mine !== token) return;
      last = { items: [], error: (err && err.message) || 'unbekannter Fehler' };
    }
    render(day, last.items, last.error);
  }

  let timer = null;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  };
  const isEvent = (p) => p && (p.type === 'event' || (p.record && p.record.type === 'event'));
  for (const name of ['record.created', 'record.updated', 'record.deleted']) {
    offs.push(bus.on(name, (payload) => { if (isEvent(payload)) soon(); }));
  }
  // Einmal die Minute: vergangene Termine werden blass, um Mitternacht kommt der neue Tag.
  const tick = setInterval(() => {
    if (toDay(new Date()) !== shownDay) load();
    else render(shownDay, last.items, last.error);
  }, 60000);
  // Nach einer abgerissenen Verbindung koennte ein Ereignis fehlen.
  offs.push(bus.on('hello', () => soon()));

  el.appendChild(body);
  setHead(toDay(new Date()));
  shownDay = toDay(new Date());
  load();

  return {
    unmount() {
      alive = false;
      clearTimeout(timer);
      clearInterval(tick);
      for (const off of offs) {
        try { off(); } catch { /* weiter */ }
      }
      clear(el);
    },
  };
}

export default { mount };
