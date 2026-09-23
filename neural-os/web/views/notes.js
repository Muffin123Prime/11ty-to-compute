/**
 * views/notes.js -- die Notizen als ruhige Wand aus Post-its.
 *
 * Warum eine Wand und kein Editor
 * -------------------------------
 * Der Nutzer will selbst nichts schreiben: "das ist eine Notiz" im Chat, und
 * die KI legt sie ab (Vertrag 4: `source: 'auto'` plus `chatId`). Die Ansicht
 * ist deshalb zuerst zum Wiederfinden da, nicht zum Tippen:
 *
 * - **Neueste zuerst, Angeheftetes oben.** Die Reihenfolge kommt vom Server
 *   (GET /api/notizen), damit Wand und Kachel dieselbe Wahrheit zeigen.
 * - **Jede Notiz sagt, woher sie kommt:** "aus dem Chat „Produktlaunch“,
 *   heute 10:24" -- und der Chat ist einen Tipp entfernt. Eine Notiz, die
 *   jemand anderes (die KI) geschrieben hat, muss man zurueckverfolgen koennen.
 * - **Dunkel, nicht bunt.** Ein Post-it ist hier eine Karte mit umgeknickter
 *   Ecke, keine gelbe Flaeche: der eine Akzent bleibt fuer das Angeheftete.
 * - **Oeffnen, anheften, loeschen.** Bearbeiten gibt es, aber klein und erst
 *   im geoeffneten Blatt -- es ist die Ausnahme, nicht die Hauptsache.
 *
 * Live: legt die KI waehrend eines Gespraechs eine Notiz an, erscheint sie
 * ohne Neuladen (record.* ueber den Bus).
 */

import { renderMarkdown, extractPlain } from '../lib/markdown.js';

const STYLE_ID = 'nos-notes-wall';

const GLYPH = {
  pin: '<path d="M12.6 2.9 17.1 7.4l-2.3.8-3.1 3.1.2 3.4-1.6 1.6-3.1-3.1-3.9 3.9M7.2 9.9l3.1 3.1M10.1 7l-.4-3.3"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  user: '<circle cx="10" cy="6.8" r="3"/><path d="M4.2 16.6a5.8 5.8 0 0 1 11.6 0"/>',
};

const FILTERS = [
  ['alle', 'Alle'],
  ['auto', 'Automatisch'],
  ['angeheftet', 'Angeheftet'],
];

const CSS = `
.nw { position: relative; min-height: 100%; container-type: inline-size; }
.nw__inner { max-width: 1240px; margin: 0 auto; padding: var(--sp-3) var(--sp-4) var(--sp-8); }
.nw__bar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px var(--sp-2); margin-bottom: var(--sp-3); }
.nw__lead { margin: 0 auto 0 0; font-size: var(--fs-sm); color: var(--fg-subtle); }
.nw__lead strong { font-weight: 500; color: var(--fg-muted); }
.nw__count { margin-left: 6px; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.segmented__option.is-active .nw__count { color: var(--fg-muted); }
.nw__wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(212px, 1fr)); gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
.nw__wall > li { display: flex; min-width: 0; }
.nw__note {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
  /* Keine feste Seitenlaenge: bei schmalen Spalten wuerde sie die letzte
     Zeile mitten durchschneiden. Die Zeilen sind begrenzt (line-clamp), und
     die Zeile der Wand gleicht die Hoehen an -- das ergibt die ruhige Flaeche. */
  min-height: 200px;
  padding: 18px 18px 16px;
  overflow: hidden;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-3) var(--r-3) 6px var(--r-3);
  box-shadow: var(--shadow-1);
  cursor: pointer;
  transition: transform var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease), background var(--dur-2) var(--ease);
}
/* Die umgeknickte Ecke: das Post-it, ohne Farbe. */
.nw__note::after {
  content: '';
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 22px;
  height: 22px;
  background: linear-gradient(135deg, var(--surface-4) 0 50%, var(--surface) 50% 100%);
  border-top-left-radius: 5px;
  box-shadow: -1px -1px 2px rgba(0, 0, 0, 0.18);
}
.nw__note:hover { transform: translateY(-2px); background: var(--surface-3); border-color: var(--border-strong); }
.nw__note:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.nw__note.is-pinned { border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
.nw__note-top { display: flex; align-items: center; gap: 8px; min-height: 16px; font-size: var(--fs-xs); color: var(--fg-subtle); }
.nw__note-top svg { width: 15px; height: 15px; }
.nw__pinmark { display: inline-flex; margin-left: auto; color: var(--accent-text); }
.nw__note-title {
  flex: none;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--fs-md);
  font-weight: 500;
  line-height: var(--lh-tight);
  letter-spacing: -0.005em;
  overflow-wrap: anywhere;
}
.nw__note-body {
  flex: none;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--fs-sm);
  line-height: 1.55;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.nw__note-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: auto;
  padding-right: 18px;
  font-size: var(--fs-xs);
  color: var(--fg-subtle);
}
.nw__note-foot svg { flex: none; width: 14px; height: 14px; }
.nw__note-foot span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.nw__empty { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 460px; margin: var(--sp-8) auto; text-align: center; color: var(--fg-subtle); }
.nw__empty-icon { display: grid; place-items: center; width: 56px; height: 56px; color: var(--fg-muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 50%; }
.nw__empty-icon svg { width: 24px; height: 24px; }
.nw__empty h2 { margin: 6px 0 0; font-size: var(--fs-lg); font-weight: 500; color: var(--fg); }
.nw__empty p { margin: 0; line-height: var(--lh); }
.nw__notice { display: flex; align-items: center; gap: 12px; padding: 12px var(--sp-2); margin-bottom: var(--sp-2); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-3); font-size: var(--fs-sm); }

/* ---- Das geoeffnete Blatt ---- */
.nw__scrim {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: var(--sp-3);
  background: var(--overlay-bg);
  animation: nw-fade var(--dur-2) var(--ease);
}
@keyframes nw-fade { from { opacity: 0; } to { opacity: 1; } }
.nw__read {
  display: flex;
  flex-direction: column;
  width: min(700px, 100%);
  max-height: calc(100% - 2 * var(--sp-3));
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-3);
  overflow: hidden;
  animation: nw-rise var(--dur-3) var(--ease);
}
@keyframes nw-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.nw__read-top { display: flex; align-items: center; gap: 8px; padding: 14px 14px 0 var(--sp-4); }
.nw__kicker { margin-right: auto; font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-subtle); }
.nw__read-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px var(--sp-4) var(--sp-3); }
.nw__read-title { margin: 0 0 10px; font-size: var(--fs-2xl); font-weight: 500; line-height: var(--lh-tight); letter-spacing: -0.015em; overflow-wrap: anywhere; }
.nw__origin { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--fg-subtle); }
.nw__origin svg { width: 15px; height: 15px; }
.nw__origin a { color: var(--accent-text); text-decoration: none; }
.nw__origin a:hover { text-decoration: underline; }
.nw__origin-part { display: inline-flex; align-items: center; gap: 6px; }
.nw__prose { color: var(--fg); line-height: var(--lh); overflow-wrap: anywhere; }
.nw__prose > :first-child { margin-top: 0; }
.nw__prose .md-p { margin: 0 0 12px; }
.nw__blank { color: var(--fg-subtle); font-style: italic; }
.nw__read-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px var(--sp-4); border-top: 1px solid var(--border); }
.nw__read-foot .spacer { flex: 1 1 auto; }
.nw__danger { color: var(--danger); }
.nw__edit { display: flex; flex-direction: column; gap: 12px; }
.nw__edit .textarea { min-height: 260px; }
.nw__edit-error { margin: 0; padding: 10px 12px; font-size: var(--fs-sm); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-2); }

@container (max-width: 600px) {
  .nw__inner { padding: var(--sp-2) var(--sp-2) var(--sp-6); }
  .nw__wall { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .nw__note { min-height: 160px; padding: 14px; }
  .nw__note-body { -webkit-line-clamp: 4; }
  .nw__scrim { padding: 0; }
  .nw__read { top: 0; max-height: 100%; border-radius: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .nw__note, .nw__scrim, .nw__read { animation: none; transition: none; }
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

function dayOf(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "heute 10:24", "gestern 18:02", "12. Sept. 10:24", "3. Jan. 2025". */
export function stamp(iso, now = new Date()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = dayOf(d);
  if (day === dayOf(now)) return `heute ${hm}`;
  const gestern = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === dayOf(gestern)) return `gestern ${hm}`;
  const opts = d.getFullYear() === now.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' };
  try {
    const datum = new Intl.DateTimeFormat('de-DE', opts).format(d);
    return d.getFullYear() === now.getFullYear() ? `${datum} ${hm}` : datum;
  } catch {
    return day;
  }
}

/**
 * Die Herkunft in einem Satz, fuer Post-it und Blatt gleich.
 * @param {{art:string, chatTitel?:string|null, chatGeloescht?:boolean}} herkunft
 */
export function originLabel(herkunft) {
  const h = herkunft || {};
  switch (h.art) {
    case 'chat':
      return h.chatGeloescht ? `aus einem gelöschten Chat „${h.chatTitel}“` : `aus dem Chat „${h.chatTitel}“`;
    case 'automatisch':
      return 'automatisch erkannt';
    case 'agent':
      return 'von einem Agenten';
    case 'import':
      return 'importiert';
    default:
      return 'von dir';
  }
}

function errorText(err) {
  return (err && err.message) || 'Unbekannter Fehler.';
}

export default {
  id: 'notes',
  title: 'Notizen',

  async mount(container, ctx) {
    ensureStyle();
    const { h, text, clear, icon, api, icons, bus, toast, confirm, navigate } = ctx;
    const I = { ...icons, ...GLYPH };

    const st = {
      items: [],
      zaehler: { alle: 0, automatisch: 0, angeheftet: 0 },
      filter: 'alle',
      loaded: false,
      error: null,
      token: 0,
      open: null, // { id, editing }
      alive: true,
    };
    const cleanups = [];

    const root = h('div.nw');
    const inner = h('div.nw__inner');
    const bar = h('div.nw__bar');
    const lead = h('p.nw__lead');
    const segmented = h('div.segmented', { role: 'group', 'aria-label': 'Welche Notizen' });
    const wallHost = h('div');
    bar.append(lead, segmented);
    inner.append(bar, wallHost);
    root.appendChild(inner);
    container.appendChild(root);
    let sheet = null;

    /* ---------------- Daten ---------------- */

    async function load() {
      const token = ++st.token;
      try {
        const res = await api.get('/notizen', { query: { limit: 600 } });
        if (!st.alive || token !== st.token) return;
        st.items = Array.isArray(res && res.items) ? res.items : [];
        st.zaehler = (res && res.zaehler) || st.zaehler;
        st.error = null;
      } catch (err) {
        if (!st.alive || token !== st.token) return;
        st.error = errorText(err);
      }
      st.loaded = true;
      render();
    }

    let reloadTimer = null;
    const reloadSoon = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => load(), 250);
    };

    function visible() {
      if (st.filter === 'auto') return st.items.filter((n) => n.data.source === 'auto');
      if (st.filter === 'angeheftet') return st.items.filter((n) => n.data.pinned);
      return st.items;
    }

    /* ---------------- Wand ---------------- */

    function render() {
      if (!st.alive) return;
      clear(lead);
      if (st.loaded && !st.error) {
        const { alle, automatisch } = st.zaehler;
        lead.append(
          h('strong', null, text(alle === 1 ? '1 Notiz' : `${alle} Notizen`)),
          text(automatisch ? ` · ${automatisch} davon hat die KI aus deinen Chats gemacht` : ''));
      }
      clear(segmented);
      const counts = { alle: st.zaehler.alle, auto: st.zaehler.automatisch, angeheftet: st.zaehler.angeheftet };
      for (const [key, label] of FILTERS) {
        segmented.appendChild(h('button.segmented__option', {
          type: 'button',
          class: st.filter === key ? 'is-active' : '',
          'aria-pressed': st.filter === key ? 'true' : 'false',
          onClick: () => {
            st.filter = key;
            render();
          },
        }, text(label), st.loaded ? h('span.nw__count', null, text(String(counts[key] || 0))) : null));
      }

      clear(wallHost);
      if (st.error) {
        wallHost.appendChild(h('div.nw__notice', { role: 'alert' },
          text(`Die Notizen konnten nicht geladen werden: ${st.error}`),
          h('button.btn.btn--small', { type: 'button', onClick: () => load() }, text('Erneut versuchen'))));
        return;
      }
      if (!st.loaded) return;
      const list = visible();
      if (!list.length) {
        wallHost.appendChild(renderEmpty());
        return;
      }
      const wall = h('ul.nw__wall', { 'aria-label': 'Notizen' });
      for (const note of list) wall.appendChild(h('li', null, renderNote(note)));
      wallHost.appendChild(wall);
    }

    function renderEmpty() {
      const [title, line] = st.filter === 'auto'
        ? ['Noch keine automatische Notiz', 'Sag im Chat „das ist eine Notiz“ – die KI legt sie hier ab und schreibt dazu, aus welchem Gespräch sie stammt.']
        : st.filter === 'angeheftet'
          ? ['Nichts angeheftet', 'Öffne eine Notiz und tippe auf „Anheften“ – dann steht sie hier ganz oben.']
          : ['Noch keine Notizen', 'Sag im Chat „das ist eine Notiz“ – die KI legt sie hier ab. Selbst schreiben musst du nichts.'];
      return h('div.nw__empty', null,
        h('span.nw__empty-icon', { 'aria-hidden': 'true' }, icon(I.notes)),
        h('h2', null, text(title)),
        h('p', null, text(line)));
    }

    function renderNote(note) {
      const data = note.data || {};
      const plain = extractPlain(String(data.body || ''), { maxLength: 420 });
      const herkunft = note.herkunft || { art: 'hand' };
      const auto = herkunft.art === 'chat' || herkunft.art === 'automatisch';
      return h('button.nw__note', {
        type: 'button',
        'data-id': note.id,
        class: data.pinned ? 'is-pinned' : '',
        'aria-label': `${data.title || 'Notiz'}, ${originLabel(herkunft)}, ${stamp(note.updatedAt)}${data.pinned ? ', angeheftet' : ''}`,
        onClick: () => openNote(note.id),
      },
      h('span.nw__note-top', null,
        auto ? h('span.dot.dot--accent', { style: { width: '6px', height: '6px' } }) : null,
        auto ? text('Automatisch') : null,
        data.pinned ? h('span.nw__pinmark', { title: 'Angeheftet' }, icon(I.pin)) : null),
      h('span.nw__note-title', null, text(data.title || 'Ohne Titel')),
      plain ? h('span.nw__note-body', null, text(plain)) : null,
      h('span.nw__note-foot', null,
        icon(herkunft.art === 'chat' ? I.chat : herkunft.art === 'hand' ? GLYPH.user : I.info),
        h('span', null, text(`${originLabel(herkunft)} · ${stamp(note.updatedAt)}`))));
    }

    /* ---------------- Blatt ---------------- */

    function findNote(id) {
      return st.items.find((n) => n.id === id) || null;
    }

    function closeSheet({ keepRoute = false } = {}) {
      if (sheet) sheet.remove();
      sheet = null;
      container.style.overflowY = '';
      const was = st.open;
      st.open = null;
      if (!keepRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute('#/notes');
      if (was) {
        const tile = root.querySelector(`.nw__note[data-id="${was.id}"]`);
        if (tile) tile.focus({ preventScroll: true });
      }
    }

    async function openNote(id, { fromRoute = false, editing = false } = {}) {
      let note = findNote(id);
      if (!note) {
        // Eine Notiz ausserhalb der geladenen Seite (oder aus einem Link):
        // einzeln holen, mit derselben Herkunft wie auf der Wand.
        try {
          const res = await api.get(`/records/${encodeURIComponent(id)}`);
          if (!res || !res.record || res.record.type !== 'note') throw Object.assign(new Error('Das ist keine Notiz.'), { status: 404 });
          note = { ...res.record, herkunft: { art: res.record.data.source === 'auto' ? 'automatisch' : 'hand' } };
          if (res.record.data.chatId) {
            try {
              const chat = await api.get(`/chats/${encodeURIComponent(res.record.data.chatId)}`);
              if (chat && chat.record) note.herkunft = { art: 'chat', chatId: chat.record.id, chatTitel: chat.record.data.title, chatGeloescht: false };
            } catch { /* Chat weg: dann bleibt "automatisch erkannt" */ }
          }
        } catch (err) {
          if (!st.alive) return;
          toast(err && err.status === 404 ? 'Diese Notiz gibt es nicht mehr.' : `Die Notiz konnte nicht geöffnet werden: ${errorText(err)}`, 'error');
          if (fromRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute('#/notes');
          return;
        }
      }
      if (!st.alive) return;
      st.open = { id: note.id, editing };
      renderSheet(note);
      if (!fromRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute(`#/notes?id=${note.id}`);
    }

    function wikiHref(name) {
      const wanted = String(name || '').trim().toLowerCase();
      const hit = st.items.find((n) => String(n.data.title || '').trim().toLowerCase() === wanted);
      return hit ? `#/notes?id=${hit.id}` : `#/search?q=${encodeURIComponent(name)}`;
    }

    function renderSheet(note) {
      if (sheet) sheet.remove();
      const data = note.data || {};
      const herkunft = note.herkunft || { art: 'hand' };
      const titleId = `nw-title-${note.id}`;
      const close = h('button.icon-button', { type: 'button', 'aria-label': 'Schließen', title: 'Schließen (Esc)', onClick: () => closeSheet() }, icon(I.close));

      const origin = h('p.nw__origin', null,
        h('span.nw__origin-part', null,
          icon(herkunft.art === 'chat' ? I.chat : herkunft.art === 'hand' ? GLYPH.user : I.info),
          herkunft.art === 'chat' && !herkunft.chatGeloescht
            ? [text('aus dem Chat '), h('a', { href: `#/chat?id=${encodeURIComponent(herkunft.chatId)}` }, text(`„${herkunft.chatTitel}“`))]
            : text(originLabel(herkunft).replace(/^./, (c) => c.toUpperCase()))),
        h('span', null, text(`· ${stamp(note.createdAt)}`)),
        note.updatedAt !== note.createdAt ? h('span', null, text(`· geändert ${stamp(note.updatedAt)}`)) : null,
        note.projekt ? h('span.nw__origin-part', null, text('· Projekt '),
          h('a', { href: `#/projects?id=${encodeURIComponent(note.projekt.id)}` }, text(note.projekt.name))) : null);

      let content;
      let foot;
      if (st.open && st.open.editing) {
        const titleInput = h('input.input', { type: 'text', value: data.title || '', maxlength: '500', 'aria-label': 'Titel' });
        const bodyInput = h('textarea.textarea', { 'aria-label': 'Text' });
        bodyInput.value = data.body || '';
        const error = h('p.nw__edit-error', { role: 'alert', hidden: true });
        const save = h('button.btn.btn--primary', { type: 'submit' }, text('Speichern'));
        content = h('form.nw__edit', {
          onSubmit: async (event) => {
            event.preventDefault();
            const title = titleInput.value.trim();
            if (!title) {
              clear(error);
              error.appendChild(text('Eine Notiz braucht einen Titel.'));
              error.hidden = false;
              titleInput.focus();
              return;
            }
            save.disabled = true;
            try {
              await api.patch(`/records/${encodeURIComponent(note.id)}`, { data: { title, body: bodyInput.value } });
              if (!st.alive) return;
              toast('Notiz gespeichert.', 'success');
              await load();
              openNote(note.id, { fromRoute: true });
            } catch (err) {
              clear(error);
              error.appendChild(text(`Speichern hat nicht geklappt: ${errorText(err)}`));
              error.hidden = false;
            } finally {
              save.disabled = false;
            }
          },
        }, titleInput, bodyInput, error,
        h('div.row', null, save,
          h('button.btn.btn--ghost', { type: 'button', onClick: () => openNote(note.id, { fromRoute: true }) }, text('Abbrechen'))));
        foot = null;
        setTimeout(() => titleInput.focus(), 0);
      } else {
        const prose = h('div.nw__prose');
        if (String(data.body || '').trim()) prose.appendChild(renderMarkdown(String(data.body), { wikiHref }));
        else prose.appendChild(h('p.nw__blank', null, text('Diese Notiz hat nur einen Titel.')));
        content = prose;
        foot = h('footer.nw__read-foot', null,
          h('button.btn', { type: 'button', onClick: () => togglePin(note) },
            icon(I.pin), text(data.pinned ? 'Lösen' : 'Anheften')),
          h('button.btn.btn--ghost', { type: 'button', onClick: () => navigate(`#/graph?focus=${encodeURIComponent(note.id)}`) },
            icon(I.graph), text('Im Gehirn zeigen')),
          h('button.btn.btn--ghost', { type: 'button', onClick: () => openNote(note.id, { fromRoute: true, editing: true }) },
            icon(I.pen), text('Bearbeiten')),
          h('span.spacer'),
          h('button.btn.btn--ghost.nw__danger', { type: 'button', onClick: () => removeNote(note) }, icon(GLYPH.trash), text('Löschen')));
      }

      const card = h('article.nw__read', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('div.nw__read-top', null, h('span.nw__kicker', null, text(st.open && st.open.editing ? 'Notiz bearbeiten' : 'Notiz')), close),
        h('div.nw__read-body', null,
          h('h2.nw__read-title', { id: titleId, tabindex: '-1' }, text(data.title || 'Ohne Titel')),
          origin,
          content),
        foot);
      sheet = h('div.nw__scrim', {
        onClick: (event) => {
          if (event.target === sheet) closeSheet();
        },
      }, card);
      root.appendChild(sheet);
      // Das Blatt steht dort, wo man gerade hinsieht, nicht oben auf der Wand,
      // und die Wand darunter rollt nicht mit, solange es offen ist.
      sheet.style.top = `${container.scrollTop || 0}px`;
      sheet.style.bottom = `${-(container.scrollTop || 0)}px`;
      container.style.overflowY = 'hidden';
      if (!(st.open && st.open.editing)) {
        const heading = card.querySelector('.nw__read-title');
        if (heading) heading.focus({ preventScroll: true });
      }
    }

    async function togglePin(note) {
      const pinned = !note.data.pinned;
      try {
        await api.patch(`/records/${encodeURIComponent(note.id)}`, { data: { pinned } });
      } catch (err) {
        toast(`Das hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      if (!st.alive) return;
      toast(pinned ? 'Angeheftet – steht jetzt ganz oben.' : 'Gelöst.', 'success');
      await load();
      if (st.open && st.open.id === note.id) openNote(note.id, { fromRoute: true });
    }

    async function removeNote(note) {
      const ok = await confirm({
        title: 'Notiz löschen?',
        message: `„${note.data.title || 'Ohne Titel'}“ verschwindet von der Wand. Du kannst es gleich danach rückgängig machen.`,
        confirmLabel: 'Löschen',
        danger: true,
      });
      if (!ok || !st.alive) return;
      try {
        await api.del(`/records/${encodeURIComponent(note.id)}`);
      } catch (err) {
        toast(`Löschen hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      closeSheet();
      await load();
      toast(`„${note.data.title || 'Notiz'}“ gelöscht.`, 'success', {
        action: {
          label: 'Rückgängig',
          run: async () => {
            try {
              await api.post(`/records/${encodeURIComponent(note.id)}/restore`);
              await load();
            } catch (err) {
              toast(`Wiederherstellen hat nicht geklappt: ${errorText(err)}`, 'error');
            }
          },
        },
        timeout: 9000,
      });
    }

    /* ---------------- Live und Aufraeumen ---------------- */

    const typeOf = (payload) => payload && (payload.type || (payload.record && payload.record.type));
    for (const name of ['record.created', 'record.updated', 'record.deleted']) {
      cleanups.push(bus.on(name, (payload) => {
        const type = typeOf(payload);
        // Ein umbenannter Chat aendert die Herkunftszeile seiner Notizen.
        if (type !== 'note' && type !== 'chat') return;
        reloadSoon();
        if (type === 'note' && st.open && st.open.id === payload.id && !st.open.editing) {
          if (name === 'record.deleted') closeSheet();
          else setTimeout(() => { if (st.open && !st.open.editing) openNote(payload.id, { fromRoute: true }); }, 400);
        }
      }));
    }

    const onKey = (event) => {
      if (event.key === 'Escape' && sheet && !event.defaultPrevented && !document.querySelector('.dialog')) {
        event.preventDefault();
        closeSheet();
      }
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));
    cleanups.push(() => clearTimeout(reloadTimer));

    this._cleanup = () => {
      st.alive = false;
      container.style.overflowY = '';
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* weiter aufraeumen */ }
      }
    };

    render();
    await load();
    const wanted = ctx.route && ctx.route.params ? ctx.route.params.id : null;
    if (wanted) await openNote(wanted, { fromRoute: true });
  },

  async unmount() {
    if (typeof this._cleanup === 'function') this._cleanup();
    this._cleanup = null;
  },
};
