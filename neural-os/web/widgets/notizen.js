/**
 * widgets/notizen.js -- Kachel "Notizen · Automatisch erkannt".
 *
 * Zeigt die neueste Notiz, die die KI aus einem Gespraech gemacht hat
 * (Vertrag 4: `source: 'auto'` plus `chatId`) -- wie in der Vorlage: Titel,
 * rechts die Uhrzeit, darunter drei Zeilen Text. Von Hand geschriebene
 * Notizen erscheinen hier absichtlich nicht; die Kachel beantwortet "was hat
 * sie sich zuletzt gemerkt?", nicht "was steht in meinen Notizen?".
 *
 * Gibt es noch keine, sagt die Kachel das -- mit dem einen Satz, der eine
 * erzeugt.
 *
 * Schnittstelle (Vertrag 2): export function mount(el, ctx) -> { unmount() }
 */

const STYLE_ID = 'nos-kachel-notizen';

const CSS = `
.nzk__note { display: flex; flex-direction: column; gap: 6px; color: inherit; text-decoration: none; border-radius: var(--r-2); }
.nzk__note:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.nzk__top { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.nzk__title { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-md); color: var(--fg); }
.nzk__time { flex: none; font-size: var(--fs-sm); color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.nzk__body {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
  font-size: var(--fs-base);
  line-height: 1.55;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.nzk__origin { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-xs); color: var(--fg-subtle); }
.nzk__note:hover .nzk__title { text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 3px; }
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const pad = (n) => String(n).padStart(2, '0');

/** "10:24" fuer heute, sonst "gestern" oder "12. Sept." -- so knapp wie in der Vorlage. */
function kurz(iso, formatDate) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (same(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'gestern';
  return formatDate(d, d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Lesbarer Text aus Markdown, ohne die Satzzeichen der Auszeichnung. */
function plain(body) {
  return String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mount(el, ctx) {
  ensureStyle();
  const { h, text, clear, icons, tileHead, api, bus, formatDate } = ctx;
  let alive = true;
  let token = 0;
  const offs = [];
  const body = h('div.tile__body');
  el.append(tileHead({ icon: icons.notes, title: 'Notizen', meta: 'Automatisch erkannt', href: '#/notes' }), body);

  let last = null;
  function render(note, error) {
    clear(body);
    if (error) {
      body.appendChild(h('p.tile__empty', null, text(`Notizen nicht abrufbar: ${error}`)));
      return;
    }
    if (!note) {
      body.appendChild(h('p.tile__empty', null, text('Noch keine. Sag im Chat „das ist eine Notiz“ – sie erscheint dann hier.')));
      return;
    }
    const herkunft = note.herkunft || {};
    const origin = herkunft.art === 'chat' ? `aus dem Chat „${herkunft.chatTitel}“` : 'automatisch erkannt';
    const txt = plain(note.data.body);
    body.appendChild(h('a.nzk__note', {
      href: `#/notes?id=${encodeURIComponent(note.id)}`,
      'aria-label': `${note.data.title}, ${origin}`,
    },
    h('span.nzk__top', null,
      h('span.nzk__title', null, text(note.data.title || 'Ohne Titel')),
      h('span.nzk__time', null, text(kurz(note.updatedAt, formatDate)))),
    txt ? h('p.nzk__body', null, text(txt)) : null,
    h('span.nzk__origin', null, text(origin))));
  }

  async function load() {
    const mine = ++token;
    try {
      const res = await api.get('/notizen', { query: { quelle: 'auto', sort: 'neu', limit: 1 } });
      if (!alive || mine !== token) return;
      last = res && Array.isArray(res.items) && res.items.length ? res.items[0] : null;
      render(last, null);
    } catch (err) {
      if (!alive || mine !== token) return;
      render(null, (err && err.message) || 'unbekannter Fehler');
    }
  }

  let timer = null;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  };
  const typeOf = (p) => p && (p.type || (p.record && p.record.type));
  for (const name of ['record.created', 'record.updated', 'record.deleted']) {
    offs.push(bus.on(name, (payload) => {
      const type = typeOf(payload);
      // Auch ein umbenannter Chat: die Herkunftszeile nennt ihn beim Namen.
      if (type === 'note' || (type === 'chat' && last && last.herkunft && last.herkunft.chatId === payload.id)) soon();
    }));
  }
  offs.push(bus.on('hello', () => soon()));
  // "10:24" wird um Mitternacht zu "gestern".
  const tick = setInterval(() => { if (last) render(last, null); }, 60000);

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
