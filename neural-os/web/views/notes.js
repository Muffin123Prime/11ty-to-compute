/**
 * views/notes.js -- writing, reading and linking notes.
 *
 * The decisions that shape this file:
 *
 * - **Saving is visible and never silent.** Every change is written back after
 *   a short pause, and the status line says which state the text is in:
 *   ungespeichert, speichert, "Gespeichert vor 3 s", or a named error with a
 *   retry. A note editor that shows nothing is a note editor you cannot trust
 *   with your only copy of a thought.
 * - **Unsaved text survives the view.** If a save fails (or the user leaves
 *   mid-edit), the pending text stays in a module-level map and is restored on
 *   the next mount, together with the warning that it is not on disk yet.
 * - **Wiki links are resolved by the server, not guessed.** `[[Title]]` links
 *   become real `links-to` edges in `graph/derive.js` on every write, so the
 *   outgoing edges of a note are the authoritative answer to "did this link
 *   resolve?". The local title index only exists to give the same answer
 *   immediately while typing, and it folds titles exactly like the server's
 *   search tokeniser (ä -> ae, accents stripped) so both agree.
 * - **A dead link is an offer, not an error.** An unresolved `[[Title]]` is
 *   rendered as such and creating that note is one click away -- but the note
 *   is never created behind the user's back, because a vault that invents
 *   records while you type is not a vault you can reason about.
 * - **Search hits are highlighted without HTML.** The search index marks hits
 *   with \u0001/\u0002 control characters precisely so the UI can turn them
 *   into real `<mark>` nodes; `snippet()` from dom.js does that, and no path
 *   in this view ever assigns a string to `innerHTML`.
 */

import {
  h, text, clear, on, list, snippet, timeAgo, formatNumber, debounce,
} from '../lib/dom.js';
import { api as defaultApi, ApiError } from '../lib/api.js';
import { renderMarkdown, extractPlain } from '../lib/markdown.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-notes-styles';
const MODE_KEY = 'neural-os:notes-mode';
/** Pause after the last keystroke before the note is written back. */
const SAVE_DEBOUNCE_MS = 700;
/** Preview repaint delay -- long enough not to re-parse on every character. */
const PREVIEW_MS = 160;
/** How often the "Gespeichert vor …" label refreshes itself. */
const STATUS_TICK_MS = 3000;
/** Types whose titles a `[[wiki link]]` may point at (mirrors derive.js). */
const TITLE_TYPES = ['note', 'project', 'entity', 'task'];

/**
 * Ab dieser Länge (Titel + Text) erscheint „Zweiter Blick".
 *
 * Derselbe Wert wie `MIN_TEXT_CHARS` in src/agents/secondlook.js, und er muss
 * derselbe bleiben: darunter weist der Server den Aufruf ab, und ein Knopf,
 * der verlässlich in eine Fehlermeldung führt, ist schlimmer als keiner.
 * Warum gerade hier: unter ~500 Zeichen überblickt man eine Notiz beim Lesen
 * vollständig. Eine Kernaussage in zwei Sätzen wäre dann halb so lang wie der
 * Text selbst, und die offenen Stellen stehen ohnehin vor Augen.
 */
const SECOND_LOOK_MIN_CHARS = 500;

/**
 * Ein kleines Modell auf einem Laptop braucht für diese Aufgabe eher Minuten
 * als Sekunden; die 30 Sekunden Voreinstellung von lib/api.js würden den Lauf
 * abschneiden, während er noch rechnet.
 */
const SECOND_LOOK_TIMEOUT_MS = 180000;

const MODES = [
  { id: 'split', label: 'Geteilt' },
  { id: 'edit', label: 'Text' },
  { id: 'preview', label: 'Vorschau' },
];

const TYPE_LABEL = {
  note: 'Notiz', project: 'Projekt', task: 'Aufgabe', entity: 'Begriff',
  chat: 'Chat', message: 'Nachricht', file: 'Datei', agent: 'Agent', run: 'Lauf',
  memory: 'Erinnerung',
};

const KIND_LABEL = {
  'links-to': 'verlinkt', mentions: 'erwähnt', tagged: 'Schlagwort',
  'belongs-to': 'gehört zu', 'derived-from': 'abgeleitet aus',
  produced: 'erzeugt', uses: 'nutzt', related: 'verwandt',
};

const VIEW_ICON = '<rect x="4" y="2.5" width="12" height="15" rx="2.6"/><path d="M7 6.6h6M7 10h6M7 13.4h3.6"/>';

/**
 * Edits that have not reached the server yet, kept per note id so a failed
 * save or a view change cannot swallow text the user typed.
 * @type {Map<string, {title:string, body:string, tags:string[], at:number}>}
 */
const pendingEdits = new Map();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', æ: 'ae', ø: 'oe', å: 'aa', œ: 'oe' };

/**
 * Title folding, identical to `fold()` in src/store/search.js. Two different
 * normalisations would mean a link that resolves in the graph but shows as
 * broken here (or the other way round), which is worse than none.
 */
function foldTitle(value) {
  if (!value) return '';
  const lowered = String(value).normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
  const expanded = lowered.replace(/[äöüßæøåœ]/g, (ch) => UMLAUTS[ch] || ch);
  return expanded.normalize('NFD').replace(/\p{M}/gu, '');
}

function recordOf(response) {
  if (!response) return null;
  if (response.record) return response.record;
  if (response.id) return response;
  return null;
}

/** `list()` refuses duplicate keys; a doubled record must not blank the panel. */
function uniqueById(rows, pick) {
  const seen = new Set();
  return rows.filter((row) => {
    const id = pick(row);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function itemsOf(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.items)) return response.items;
  return [];
}

function dataOf(record) {
  return (record && record.data) || {};
}

function noteTitle(record) {
  const title = String(dataOf(record).title || '').trim();
  return title || 'Ohne Titel';
}

function labelOf(record) {
  const data = dataOf(record);
  return String(data.title || data.name || data.text || record.id).trim() || record.id;
}

function errorMessage(err) {
  if (err instanceof ApiError) return err.message;
  if (err && err.message) return err.message;
  return String(err);
}

function targetFor(record) {
  const id = encodeURIComponent(record.id);
  switch (record.type) {
    case 'note': return `#/notes?id=${id}`;
    case 'chat': return `#/chat?id=${id}`;
    case 'project':
    case 'task': return `#/projects?id=${id}`;
    case 'agent':
    case 'run': return `#/agents?id=${id}`;
    default: return `#/graph?focus=${id}`;
  }
}

function parseTags(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 40);
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let current = null;

export default {
  id: 'notes',
  title: 'Notizen',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyles();
    const instance = createNotesView(container, ctx);
    current = instance;
    await instance.start();
  },

  async unmount() {
    const instance = current;
    current = null;
    // Awaited by the shell: a pending edit is written back before the view
    // disappears, rather than being hoped about.
    if (instance) await instance.destroy();
  },
};

function createNotesView(container, ctx) {
  const api = ctx.api || defaultApi;
  const cleanups = [];
  let disposed = false;

  const state = {
    notes: [],
    tags: [],
    query: '',
    hits: null, // null = plain list, [] = search with no result
    noteId: null,
    note: null,
    loadError: null,
    mode: readMode(),
    /** 'clean' | 'dirty' | 'saving' | 'error' */
    saveState: 'clean',
    saveError: null,
    savedAt: null,
    titleIndex: new Map(), // folded title -> {id, type, label}
    extraTitlesLoaded: false,
    announcedPendingFor: null,
    edgesIn: [],
    edgesOut: [],
    labels: new Map(), // record id -> {label, type, missing}
    suggest: null, // {query, range:{start,end}, items:[], index:number}
    /** Der zweite Blick auf die gerade offene Notiz. */
    second: { open: false, loading: false, error: null, result: null, noteId: null },
  };

  const dom = {};
  let statusTimer = null;
  let saveSeq = 0;
  /** Läuft gerade ein zweiter Blick, gehört ihm dieser Abbrecher. */
  let secondController = null;

  /* ---------------------------------------------------------------- */
  /* Skeleton                                                          */
  /* ---------------------------------------------------------------- */

  function build() {
    dom.newButton = h('button.btn.btn--primary.btn--small', {
      type: 'button',
      onClick: () => createNote(),
    }, text('Neue Notiz'));

    dom.search = h('input.input', {
      type: 'search',
      placeholder: 'Volltext durchsuchen …',
      'aria-label': 'Notizen durchsuchen',
      autocomplete: 'off',
      spellcheck: 'false',
      onInput: (event) => {
        state.query = event.target.value;
        if (!state.query.trim()) {
          state.hits = null;
          renderList();
        }
        runSearch(state.query);
      },
    });

    dom.list = h('ul.notesv__list', { role: 'list' });
    dom.listFoot = h('p.notesv__list-foot.meta');

    dom.side = h('aside.notesv__side', { 'aria-label': 'Notizen' },
      h('div.notesv__side-head', null, dom.newButton, dom.search),
      dom.list,
      dom.listFoot);

    dom.titleInput = h('input.notesv__title', {
      type: 'text',
      placeholder: 'Titel',
      'aria-label': 'Titel der Notiz',
      onInput: () => markDirty(),
      onBlur: () => flush(),
    });

    dom.status = h('span.notesv__status.meta', { role: 'status' });

    dom.modeSwitch = h('div.segmented', { role: 'group', 'aria-label': 'Ansicht' });
    for (const mode of MODES) {
      const button = h('button.segmented__option', {
        type: 'button',
        onClick: () => setMode(mode.id),
      }, text(mode.label));
      button.dataset.mode = mode.id;
      dom.modeSwitch.appendChild(button);
    }

    dom.graphButton = h('button.btn.btn--small', {
      type: 'button',
      title: 'Diese Notiz im Wissensgraphen anzeigen',
      onClick: () => state.noteId && ctx.navigate(`#/graph?focus=${encodeURIComponent(state.noteId)}`),
    }, text('Im Gehirn zeigen'));

    dom.secondButton = h('button.btn.btn--small', {
      type: 'button',
      title: 'Kernaussage, offene Stellen und Begriffe, die schon anderswo im Tresor vorkommen',
      onClick: () => toggleSecondLook(),
    }, text('Zweiter Blick'));

    dom.deleteButton = h('button.btn.btn--small', {
      type: 'button',
      onClick: () => deleteNote(),
    }, text('Löschen'));

    dom.head = h('header.notesv__head', null,
      h('div.notesv__head-main', null, dom.titleInput, dom.status),
      h('div.notesv__head-actions', null, dom.modeSwitch, dom.secondButton, dom.graphButton, dom.deleteButton));

    dom.tagBar = h('div.notesv__tags');

    dom.body = h('textarea.notesv__body', {
      placeholder: 'Schreib los. [[Doppelte Klammern]] verlinken, #Schlagworte ordnen.',
      'aria-label': 'Text der Notiz',
      spellcheck: 'true',
      onInput: () => {
        markDirty();
        schedulePreview();
        updateSuggestions();
      },
      onKeyDown: onBodyKey,
      onBlur: () => {
        // A blur into the suggestion list must not close it before the click
        // lands; everything else saves immediately.
        setTimeout(() => {
          if (!disposed) closeSuggest();
        }, 120);
        flush();
      },
      onClick: () => updateSuggestions(),
    });

    dom.suggest = h('ul.notesv__suggest', { role: 'listbox', hidden: true, 'aria-label': 'Vorschläge für Verknüpfungen' });
    dom.editor = h('div.notesv__editor', null, dom.body, dom.suggest);

    dom.preview = h('div.notesv__preview.prose', { 'aria-label': 'Vorschau' });

    dom.split = h('div.notesv__split', null, dom.editor, dom.preview);

    dom.links = h('section.notesv__links', { 'aria-label': 'Verknüpfungen' });

    // Unter dem Text, nicht als Dialog: man liest die Notiz und das, was über
    // sie gesagt wird, nebeneinander -- ein Fenster davor würde genau das
    // verdecken, worum es geht.
    dom.second = h('section.notesv__second', { 'aria-label': 'Zweiter Blick', hidden: true });

    dom.main = h('section.notesv__main', null, dom.head, dom.tagBar, dom.split, dom.second, dom.links);
    dom.root = h('div.notesv', null, dom.side, dom.main);
    dom.root.dataset.mode = state.mode;
    container.appendChild(dom.root);
  }

  /* ---------------------------------------------------------------- */
  /* Loading                                                           */
  /* ---------------------------------------------------------------- */

  async function start() {
    build();
    renderMode();

    const params = (ctx.route && ctx.route.params) || {};
    if (params.q) {
      state.query = params.q;
      dom.search.value = params.q;
    }

    await loadNotes();
    if (disposed) return;

    if (params.create) {
      await createNote(String(params.create));
    } else {
      const wanted = params.id || (state.notes[0] ? state.notes[0].id : null);
      if (wanted) await openNote(wanted);
      else renderAll();
    }

    if (state.query) runSearch(state.query);
    subscribeBus();

    statusTimer = setInterval(() => {
      if (!disposed) renderStatus();
    }, STATUS_TICK_MS);

    cleanups.push(on(document, 'keydown', onGlobalKey));
  }

  async function loadNotes() {
    try {
      const response = await api.get('/records', {
        query: { type: 'note', limit: 500, sort: 'updatedAt', order: 'desc' },
      });
      if (disposed) return;
      state.notes = itemsOf(response);
      indexTitles(state.notes);
      renderList();
    } catch (err) {
      if (disposed) return;
      state.notes = [];
      renderList();
      ctx.toast(`Notizen konnten nicht geladen werden: ${errorMessage(err)}`, 'error');
    }
  }

  function indexTitles(records) {
    for (const record of records) {
      const key = foldTitle(labelOf(record));
      if (key && !state.titleIndex.has(key)) {
        state.titleIndex.set(key, { id: record.id, type: record.type, label: labelOf(record) });
      }
    }
  }

  /**
   * Titles of the other linkable types. Loaded lazily: most links point at
   * notes, and three extra requests at mount would slow the common case down
   * for a rarer one.
   */
  async function ensureExtraTitles() {
    if (state.extraTitlesLoaded) return;
    state.extraTitlesLoaded = true;
    for (const type of TITLE_TYPES.filter((t) => t !== 'note')) {
      try {
        const response = await api.get('/records', { query: { type, limit: 300, sort: 'updatedAt', order: 'desc' } });
        if (disposed) return;
        indexTitles(itemsOf(response));
      } catch {
        // A missing type is not an error worth a toast; links to it simply
        // stay unresolved until the next save, when the server decides.
      }
    }
    renderPreview();
  }

  async function openNote(noteId) {
    await flush();
    if (disposed) return;
    if (state.saveState === 'error' && state.noteId && state.noteId !== noteId) {
      // Leaving with unsaved text is allowed -- silently leaving is not.
      ctx.toast(
        `„${noteTitle(state.note)}“ konnte nicht gespeichert werden: ${errorMessage(state.saveError)} `
        + 'Der Text bleibt erhalten und wird beim nächsten Öffnen wiederhergestellt.',
        'error',
      );
    }
    state.noteId = noteId;
    state.note = null;
    state.loadError = null;
    state.edgesIn = [];
    state.edgesOut = [];
    state.saveState = 'clean';
    state.saveError = null;
    state.savedAt = null;
    closeSuggest();
    // Ein zweiter Blick gehört zu genau einer Notiz; beim Wechsel ist er weg,
    // nicht etwa an der nächsten weiter sichtbar.
    closeSecondLook();
    renderList();

    try {
      const response = await api.get(`/records/${encodeURIComponent(noteId)}`);
      if (disposed || state.noteId !== noteId) return;
      const record = recordOf(response);
      if (!record || record.type !== 'note') {
        throw new ApiError('WRONG_TYPE', `Dieser Eintrag ist keine Notiz (${record ? record.type : 'unbekannt'}).`, { status: 400 });
      }
      state.note = record;
    } catch (err) {
      if (disposed || state.noteId !== noteId) return;
      state.loadError = err;
      renderAll();
      return;
    }

    fillEditor();
    renderAll();
    loadLinks(noteId);
  }

  /** Put the record (or a newer unsaved edit) into the form fields. */
  function fillEditor() {
    const data = dataOf(state.note);
    const pending = pendingEdits.get(state.noteId);
    dom.titleInput.value = pending ? pending.title : (data.title || '');
    dom.body.value = pending ? pending.body : (data.body || '');
    state.tags = pending ? [...pending.tags] : [...(Array.isArray(data.tags) ? data.tags : [])];
    if (pending) {
      state.saveState = 'dirty';
      if (state.announcedPendingFor !== state.noteId) {
        state.announcedPendingFor = state.noteId;
        ctx.toast('Ungespeicherte Änderungen an dieser Notiz wurden wiederhergestellt.', 'info');
      }
      scheduleSave();
    }
    resetScroll();
  }

  async function loadLinks(noteId) {
    try {
      const [inbound, outbound] = await Promise.all([
        api.get('/edges', { query: { node: noteId, direction: 'in', limit: 200 } }),
        api.get('/edges', { query: { node: noteId, direction: 'out', limit: 200 } }),
      ]);
      if (disposed || state.noteId !== noteId) return;
      state.edgesIn = itemsOf(inbound).filter((edge) => dataOf(edge).to === noteId);
      state.edgesOut = itemsOf(outbound).filter((edge) => dataOf(edge).from === noteId);
      renderLinks();
      resolveLabels([
        ...state.edgesIn.map((edge) => dataOf(edge).from),
        ...state.edgesOut.map((edge) => dataOf(edge).to),
      ]);
    } catch (err) {
      if (disposed || state.noteId !== noteId) return;
      state.edgesIn = [];
      state.edgesOut = [];
      renderLinks(err);
    }
  }

  /** Resolve record labels one by one, with a cache; used by the link panel. */
  async function resolveLabels(ids) {
    const unique = [...new Set(ids)].filter((id) => id && !state.labels.has(id)).slice(0, 60);
    let learnedTitle = false;
    for (const id of unique) {
      try {
        const response = await api.get(`/records/${encodeURIComponent(id)}`);
        if (disposed) return;
        const record = recordOf(response);
        state.labels.set(id, { label: labelOf(record), type: record.type, missing: false });
        const key = foldTitle(labelOf(record));
        if (key && !state.titleIndex.has(key)) {
          state.titleIndex.set(key, { id: record.id, type: record.type, label: labelOf(record) });
          learnedTitle = true;
        }
      } catch (err) {
        if (disposed) return;
        const gone = err instanceof ApiError && err.status === 404;
        state.labels.set(id, {
          label: gone ? 'Eintrag existiert nicht mehr' : `Nicht lesbar: ${errorMessage(err)}`,
          type: null,
          missing: true,
        });
      }
      renderLinks();
    }
    // The preview is repainted once, not per label: re-parsing the document
    // sixty times to learn sixty titles would be visible as a stutter.
    if (learnedTitle) renderPreview();
  }

  function subscribeBus() {
    const onRecord = (payload, event) => {
      if (disposed) return;
      const record = payload && payload.record;
      if (!record || record.type !== 'note') return;
      // Our own save already updated the screen; this is for changes made
      // elsewhere (another tab, an agent).
      if (record.id === state.noteId && state.saveState === 'clean') {
        state.note = record;
        // Only adopt the remote version while nothing here is being typed in:
        // overwriting a field under the caret would eat the keystroke.
        const editing = document.activeElement === dom.body
          || document.activeElement === dom.titleInput
          || document.activeElement === dom.tagInput;
        if (!editing) {
          fillEditor();
          renderTags();
          renderPreview();
          updateSecondButton();
        }
      }
      reloadNotesSoon();
      if ((event && event.type) === 'record.created') indexTitles([record]);
    };
    for (const name of ['record.created', 'record.updated', 'record.deleted']) {
      cleanups.push(ctx.bus.on(name, onRecord));
    }
    cleanups.push(ctx.bus.on('edge.created', () => {
      if (!disposed && state.noteId) loadLinksSoon();
    }));
    cleanups.push(ctx.bus.on('edge.deleted', () => {
      if (!disposed && state.noteId) loadLinksSoon();
    }));
  }

  const reloadNotesSoon = debounce(() => {
    if (!disposed) loadNotes();
  }, 800);

  const loadLinksSoon = debounce(() => {
    if (!disposed && state.noteId) loadLinks(state.noteId);
  }, 600);

  /* ---------------------------------------------------------------- */
  /* Saving                                                            */
  /* ---------------------------------------------------------------- */

  function currentEdit() {
    return {
      title: dom.titleInput.value,
      body: dom.body.value,
      tags: [...(state.tags || [])],
      at: Date.now(),
    };
  }

  function markDirty() {
    if (!state.noteId) return;
    state.saveState = 'dirty';
    state.saveError = null;
    pendingEdits.set(state.noteId, currentEdit());
    renderStatus();
    updateSecondButton();
    // Ein zweiter Blick gilt für den Text, über den er gemacht wurde. Wird
    // weitergeschrieben, wird er nicht falsch, aber alt -- und das steht dann
    // dabei, statt dass er stillschweigend weiter danebensteht.
    if (state.second.result && !state.second.stale && state.second.noteId === state.noteId) {
      state.second.stale = true;
      renderSecond();
    }
    scheduleSave();
  }

  const scheduleSave = debounce(() => {
    save();
  }, SAVE_DEBOUNCE_MS);

  /** Write the note back. Never throws: the error becomes a visible state. */
  async function save() {
    if (!state.noteId || !state.note) return;
    const edit = currentEdit();
    const data = dataOf(state.note);
    const unchanged = edit.title === (data.title || '')
      && edit.body === (data.body || '')
      && edit.tags.join('\u0000') === (Array.isArray(data.tags) ? data.tags : []).join('\u0000');
    if (unchanged) {
      pendingEdits.delete(state.noteId);
      state.saveState = 'clean';
      renderStatus();
      return;
    }

    const seq = ++saveSeq;
    const noteId = state.noteId;
    state.saveState = 'saving';
    renderStatus();

    try {
      const response = await api.patch(`/records/${encodeURIComponent(noteId)}`, {
        data: {
          // An untitled note would fail schema validation (title is required),
          // so the fallback is explicit and visible rather than a silent empty.
          title: edit.title.trim() || 'Ohne Titel',
          body: edit.body,
          tags: edit.tags,
        },
      });
      if (disposed || seq !== saveSeq) return;
      const record = recordOf(response);
      if (record) {
        if (state.noteId === noteId) state.note = record;
        const index = state.notes.findIndex((note) => note.id === record.id);
        if (index !== -1) state.notes[index] = record;
        else state.notes.unshift(record);
        indexTitles([record]);
      }
      pendingEdits.delete(noteId);
      state.saveState = 'clean';
      state.saveError = null;
      state.savedAt = Date.now();
      renderStatus();
      renderList();
    } catch (err) {
      if (disposed || seq !== saveSeq) return;
      state.saveState = 'error';
      state.saveError = err;
      renderStatus();
    }
  }

  /** Save right now (blur, note switch, unmount, Strg+S). */
  async function flush() {
    scheduleSave.cancel();
    if (state.saveState === 'dirty' || state.saveState === 'error') await save();
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  async function createNote(title) {
    try {
      const response = await api.post('/records', {
        type: 'note',
        data: { title: String(title || '').trim() || 'Neue Notiz', body: '', tags: [] },
      });
      const record = recordOf(response);
      if (!record) throw new ApiError('BAD_RESPONSE', 'Der Server hat keine Notiz zurückgegeben.');
      state.notes.unshift(record);
      indexTitles([record]);
      await openNote(record.id);
      if (!disposed) {
        dom.titleInput.focus();
        dom.titleInput.select();
      }
      return record;
    } catch (err) {
      ctx.toast(`Notiz konnte nicht angelegt werden: ${errorMessage(err)}`, 'error');
      return null;
    }
  }

  async function deleteNote() {
    if (!state.note) return;
    const ok = await ctx.confirm({
      title: 'Notiz löschen?',
      message: `„${noteTitle(state.note)}“ wandert in den Papierkorb und bleibt wiederherstellbar.`,
      confirmLabel: 'Löschen',
      danger: true,
    });
    if (!ok) return;
    const id = state.noteId;
    try {
      scheduleSave.cancel();
      pendingEdits.delete(id);
      await api.del(`/records/${encodeURIComponent(id)}`);
      state.notes = state.notes.filter((note) => note.id !== id);
      state.note = null;
      state.noteId = null;
      ctx.toast('Notiz gelöscht.', 'success');
      if (state.notes[0]) await openNote(state.notes[0].id);
      else renderAll();
    } catch (err) {
      ctx.toast(`Löschen fehlgeschlagen: ${errorMessage(err)}`, 'error');
    }
  }

  function setMode(mode) {
    state.mode = mode;
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* the preference simply does not survive a reload */
    }
    renderMode();
    renderPreview();
  }

  function addTag(value) {
    const tags = parseTags(value);
    if (!tags.length) return;
    state.tags = [...new Set([...(state.tags || []), ...tags])].slice(0, 40);
    dom.tagInput.value = '';
    markDirty();
    renderTags();
  }

  function removeTag(tag) {
    state.tags = (state.tags || []).filter((entry) => entry !== tag);
    markDirty();
    renderTags();
  }

  const runSearch = debounce(async (query) => {
    const term = String(query || '').trim();
    if (term.length < 2) {
      state.hits = null;
      renderList();
      return;
    }
    try {
      const response = await api.get('/search', { query: { q: term, types: 'note', limit: 40 } });
      if (disposed) return;
      state.searchError = null;
      state.hits = itemsOf(response).map((row) => ({
        record: row && row.record ? row.record : row,
        score: row && row.score,
        snippet: (row && row.snippet) || '',
      })).filter((row) => row.record && row.record.type === 'note');
      renderList();
    } catch (err) {
      if (disposed) return;
      state.hits = [];
      state.searchError = errorMessage(err);
      renderList();
    }
  }, 220);

  /* ---------------------------------------------------------------- */
  /* Zweiter Blick                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Titel + Text, genauso gezählt wie in src/agents/secondlook.js. Gezählt
   * wird, was im Feld steht, nicht was gespeichert ist -- sonst verschwindet
   * der Knopf erst, nachdem gespeichert wurde, und erscheint beim Tippen zu
   * spät.
   */
  function noteLength() {
    if (!state.note) return 0;
    const title = String(dom.titleInput.value || '').trim();
    const body = String(dom.body.value || '').trim();
    return (title ? `${title}\n\n${body}` : body).trimEnd().length;
  }

  function updateSecondButton() {
    if (!dom.secondButton) return;
    const longEnough = !!state.note && noteLength() >= SECOND_LOOK_MIN_CHARS;
    // Kein ausgegrauter Knopf mit Erklärung: bei einer kurzen Notiz gibt es
    // nichts zu holen, also steht da auch nichts.
    dom.secondButton.hidden = !longEnough;
  }

  function cancelSecondLook() {
    if (!secondController) return;
    try {
      secondController.abort();
    } catch {
      /* war schon beendet */
    }
    secondController = null;
  }

  function closeSecondLook() {
    cancelSecondLook();
    state.second = { open: false, loading: false, error: null, result: null, noteId: null };
    renderSecond();
  }

  function toggleSecondLook() {
    if (state.second.open && state.second.noteId === state.noteId && !state.second.loading) {
      closeSecondLook();
      return;
    }
    runSecondLook();
  }

  /**
   * Den zweiten Blick holen.
   *
   * Vorher wird gespeichert. Der Server liest die Notiz aus dem Tresor, also
   * würde er sonst einen Text beurteilen, den der Mensch vor sich gerade
   * geändert hat -- und das Ergebnis wäre über etwas, das so nirgends steht.
   */
  async function runSecondLook() {
    if (!state.note) return;
    const noteId = state.noteId;
    cancelSecondLook();
    state.second = { open: true, loading: true, error: null, result: null, noteId };
    renderSecond();

    await flush();
    if (disposed || state.noteId !== noteId || state.second.noteId !== noteId) return;

    const controller = new AbortController();
    secondController = controller;
    try {
      const result = await api.post(
        `/notes/${encodeURIComponent(noteId)}/second-look`,
        {},
        { signal: controller.signal, timeoutMs: SECOND_LOOK_TIMEOUT_MS },
      );
      if (disposed || secondController !== controller) return;
      state.second.result = result;
      state.second.error = null;
    } catch (err) {
      if (disposed || secondController !== controller) return;
      if (err && err.isAborted) {
        // Abgebrochen heißt: nichts sagen. Kein halbes Ergebnis, kein Fehler.
        state.second.open = false;
        return;
      }
      state.second.error = err;
    } finally {
      if (!disposed && secondController === controller) {
        secondController = null;
        state.second.loading = false;
        renderSecond();
      }
    }
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  }

  /** Dorthin, wo der Begriff steht. */
  function openHit(hit) {
    if (!hit || !hit.id) return;
    if (hit.type === 'note') open(hit.id);
    else ctx.navigate(targetFor({ id: hit.id, type: hit.type }));
  }

  function renderSecond() {
    const box = dom.second;
    if (!box) return;
    clear(box);
    const second = state.second;
    const visible = second.open && !!state.note && second.noteId === state.noteId;
    box.hidden = !visible;
    if (!visible) return;

    const result = second.result;
    const head = h('div.notesv__second-head', null,
      h('h3.notesv__second-heading', null, text('Zweiter Blick')),
      h('span.meta', null, text(`auf „${noteTitle(state.note)}“${result && Number.isFinite(result.ms) ? ` · ${formatDuration(result.ms)}` : ''}`)),
      h('div.notesv__second-actions', null,
        second.loading
          ? h('button.btn.btn--small', { type: 'button', onClick: () => closeSecondLook() }, text('Abbrechen'))
          : h('button.btn.btn--small', { type: 'button', onClick: () => runSecondLook() }, text('Neu lesen')),
        h('button.btn.btn--small', {
          type: 'button',
          'aria-label': 'Zweiten Blick schließen',
          onClick: () => closeSecondLook(),
        }, text('Schließen'))));
    box.appendChild(head);

    if (second.loading) {
      box.appendChild(h('div.notesv__second-state', { role: 'status' },
        h('span.spinner', { 'aria-hidden': 'true' }),
        h('p', null, text('Die Notiz wird gelesen. Die Begriffe kommen aus dem Index, die ersten beiden Teile von einem Modell – das kann dauern.'))));
      return;
    }

    if (second.error) {
      box.appendChild(h('div.notesv__second-state.is-danger', { role: 'alert' },
        h('p', null, text(`Der zweite Blick ist fehlgeschlagen: ${errorMessage(second.error)}`)),
        h('p.hint', null, text('Es wurde nichts zusammengefasst. Eine Antwort, die nicht gelesen werden konnte, wird hier nicht zu einem Satz gemacht.')),
        h('button.btn.btn--small', { type: 'button', onClick: () => runSecondLook() }, text('Erneut versuchen'))));
      return;
    }

    if (!result) return;

    if (second.stale) {
      box.appendChild(h('p.notesv__second-stale.hint', null,
        text('Der Text hat sich seit diesem zweiten Blick geändert – was hier steht, gilt für die vorige Fassung.')));
    }

    box.appendChild(h('div.notesv__second-grid', null,
      renderSecondModel(result),
      renderSecondTerms(result)));
  }

  /**
   * Hat diese Notiz das Gerät verlassen?
   *
   * Der Server beobachtet das an der Schleuse und schickt es mit; hier stand
   * es bisher nirgends, obwohl dieser Aufruf mehr Text weggibt als der Chat.
   * Drei Zustände, nicht zwei -- "niemand hat hingesehen" ist kein "nein",
   * und deshalb steht `netzBeobachtet` vor den anderen beiden Fällen. Wortlaut
   * und Farben wie im Chat und im Modellvergleich: eine Marke, die je Ansicht
   * anders klingt, ist eine, der man nicht glaubt.
   *
   * Wurde gar kein Modell gefragt, gibt es nichts zu berichten: dann hat
   * dieser Aufruf nur den Volltextindex gelesen, und der liegt auf dieser
   * Platte. Eine Marke wäre dort keine Auskunft, sondern Beruhigung.
   */
  function renderSecondNet(result) {
    if (!result || !result.model) return null;
    const ziele = Array.isArray(result.netzZiele) ? result.netzZiele : [];
    if (result.netzBeobachtet === false) {
      return h('span.badge.notesv__second-net', {
        'data-net': 'unknown',
        title: 'Auf diesem Server konnte nicht beobachtet werden, ob etwas hinausgegangen ist.',
      }, text('Netznutzung nicht beobachtbar'));
    }
    if (result.usedNetwork === true) {
      return h('span.badge.notesv__second-net', {
        'data-net': 'online',
        title: `Der Text dieser Notiz ist an einen anderen Rechner gegangen. Ziele: ${ziele.join(', ') || 'unbekannt'}`,
      }, text(`Netz genutzt${ziele.length ? `: ${ziele.join(', ')}` : ''}`));
    }
    return h('span.badge.notesv__second-net', {
      'data-net': 'offline',
      title: 'Es ging nichts an einen anderen Rechner. Verbindungen zu 127.0.0.1 sind dieses Gerät selbst.',
    }, text(`Kein Netzverkehr${ziele.length ? ` · Modell auf ${ziele.join(', ')}` : ''}`));
  }

  /**
   * Der Satz zur Marke, wenn wirklich etwas hinausgegangen ist: wie viel von
   * dieser Notiz, und wohin. Eine Farbe allein beantwortet die Frage nicht,
   * die ein Mensch hier hat.
   */
  function renderSecondNetSentence(result) {
    if (!result || result.usedNetwork !== true) return null;
    const ziele = Array.isArray(result.netzZiele) ? result.netzZiele : [];
    const wohin = ziele.length ? ziele.join(', ') : 'einen anderen Rechner';
    const menge = Number.isFinite(result.gesendeteZeichen)
      ? `${formatNumber(result.gesendeteZeichen)} Zeichen dieser Notiz`
      : 'der Text dieser Notiz';
    return h('p.hint.notesv__second-net-line', null,
      text(`Dafür sind ${menge} an ${wohin} gegangen.`));
  }

  /**
   * Die ersten beiden Teile. Sie tragen ein anderes Zeichen als der dritte,
   * und das ist der eigentliche Punkt dieser Ansicht: was ein Modell gesagt
   * hat, ist nicht belegt, und das steht dabei -- nicht im Kleingedruckten,
   * sondern an der Überschrift.
   */
  function renderSecondModel(result) {
    const block = h('div.notesv__second-block.notesv__second-block--modell');
    const modell = (result && result.modell) || {};

    if (!modell.verfuegbar) {
      block.appendChild(h('h4.notesv__second-title', null,
        text('Kernaussage und offene Stellen'),
        h('span.badge.notesv__second-mark--fehlt', null, text('braucht ein Modell'))));
      block.appendChild(h('p', null, text(result.hinweis
        || 'Für diese beiden Teile wird ein Sprachmodell gebraucht; hier ist gerade keines erreichbar.')));
      if (modell.grund) {
        // Die Registry schreibt eine vollständige Diagnose: erste Zeile als
        // Satz, der Rest zum Aufklappen. Alles auf einmal würde den zweiten
        // Blick zu einer Fehlermeldung mit Anhang machen -- weglassen wäre
        // aber auch falsch, denn genau dort steht, was zu tun ist.
        const [erste, ...rest] = String(modell.grund).split('\n');
        block.appendChild(h('p.meta', null, text(erste)));
        const detail = rest.join('\n').trim();
        if (detail) {
          block.appendChild(h('details.notesv__second-details', null,
            h('summary', null, text('Was genau geprüft wurde')),
            h('p.notesv__second-grund.meta', null, text(detail))));
        }
      }
      block.appendChild(h('button.btn.btn--small', {
        type: 'button',
        onClick: () => ctx.navigate('#/settings'),
      }, text('Zu den Einstellungen')));
      // Kein „rechts": unter 900 px steht der dritte Teil darunter, nicht daneben.
      block.appendChild(h('p.hint', null,
        text('Der dritte Teil braucht kein Modell und steht deshalb trotzdem da.')));
      // Es gibt einen Weg hierher, auf dem das Modell erst beim Aufruf
      // verschwunden ist -- dann kann davor sehr wohl etwas hinausgegangen
      // sein. Die Marke gehört deshalb auch in diesen Zweig.
      const weg = renderSecondNet(result);
      if (weg) {
        block.appendChild(h('div.notesv__second-foot', null, weg));
        const satz = renderSecondNetSentence(result);
        if (satz) block.appendChild(satz);
      }
      return block;
    }

    const marke = () => h('span.badge.notesv__second-mark--modell', null, text('vom Modell'));

    block.appendChild(h('h4.notesv__second-title', null, text('Kernaussage'), marke()));
    block.appendChild(h('p.notesv__second-kern', null, text(result.kern || '')));

    block.appendChild(h('h4.notesv__second-title', null, text('Offene Stellen'), marke()));
    const offen = Array.isArray(result.offeneStellen) ? result.offeneStellen : [];
    if (offen.length) {
      const rows = h('ul.notesv__second-list', { role: 'list' });
      for (const stelle of offen) rows.appendChild(h('li', null, text(String(stelle))));
      block.appendChild(rows);
    } else {
      block.appendChild(h('p.meta', null, text('Das Modell hat im Text keine offene Stelle gefunden.')));
    }

    if (result.gekuerzt) {
      block.appendChild(h('p.hint', null,
        text('Die Notiz war länger, als ins Fenster des Modells passt; beurteilt wurde nur ihr Anfang.')));
    }
    const wer = result.model && result.model.model
      ? `${result.model.provider ? `${result.model.provider} · ` : ''}${result.model.model}`
      : 'einem Sprachmodell';
    block.appendChild(h('div.notesv__second-foot', null,
      renderSecondNet(result),
      h('p.hint', null,
        text(`Diese beiden Teile stammen von ${wer}. Sie sind nicht belegt – lies sie gegen den Text.`))));
    const satz = renderSecondNetSentence(result);
    if (satz) block.appendChild(satz);
    return block;
  }

  /**
   * Der dritte Teil. Er kommt aus dem Volltextindex, jeder Treffer wurde im
   * Zieltext nachgesehen, und deshalb darf er als belegt gekennzeichnet sein.
   */
  function renderSecondTerms(result) {
    const block = h('div.notesv__second-block.notesv__second-block--index');
    const begriffe = Array.isArray(result.bekannteBegriffe) ? result.bekannteBegriffe : [];
    // Begriffe, an denen sich der Index verschluckt hat. Ohne diese Zahl wäre
    // eine leere Liste nicht von "niemand hat nachgesehen" zu unterscheiden --
    // ausgerechnet in dem Teil, der sich belegbar nennt.
    const stumm = Number.isFinite(result.nichtNachschlagbar) ? result.nichtNachschlagbar : 0;

    block.appendChild(h('h4.notesv__second-title', null,
      text('Bekannte Begriffe'),
      h('span.badge.notesv__second-mark--index', null, text('aus dem Volltextindex'))));

    if (!begriffe.length) {
      block.appendChild(h('p.meta', null, text(stumm
        ? `Ob Begriffe aus dieser Notiz anderswo im Tresor stehen, wurde nicht beantwortet: bei ${formatNumber(stumm)} Begriffen hat der Volltextindex einen Fehler gemeldet.`
        : 'Kein Begriff aus dieser Notiz kommt bisher anderswo im Tresor vor.')));
      return block;
    }

    const rows = h('ul.notesv__second-terms', { role: 'list' });
    for (const eintrag of begriffe) {
      const treffer = Array.isArray(eintrag.treffer) ? eintrag.treffer : [];
      // Die Zahl ist gezählt, die Liste darunter ist gekürzt. Hier stand
      // früher die Länge der Liste -- „in 4 Einträgen" für einen Begriff, der
      // in 25 steht. Sagt der Server nicht, wie weit er gekommen ist, wird
      // daraus ein „mindestens", nie wieder eine Behauptung.
      const gezaehlt = Number.isFinite(eintrag.anzahl) ? eintrag.anzahl : treffer.length;
      const genau = eintrag.genau === true && Number.isFinite(eintrag.anzahl);
      const zahlwort = gezaehlt === 1 ? '1 Eintrag' : `${formatNumber(gezaehlt)} Einträgen`;
      const row = h('li.notesv__second-term');
      row.appendChild(h('div.notesv__second-term-head', null,
        h('button.notesv__second-word', {
          type: 'button',
          title: treffer.length ? `Zu „${treffer[0].titel}“ springen` : '',
          onClick: () => openHit(treffer[0]),
        }, text(eintrag.begriff)),
        h('span.meta', {
          title: genau
            ? 'Jeder dieser Einträge wurde im Text nachgeprüft.'
            : 'So weit wurde nachgezählt; es können mehr sein.',
        }, text(`${genau ? 'in' : 'in mindestens'} ${zahlwort}`))));

      const hits = h('ul.notesv__second-hits', { role: 'list' });
      for (const hit of treffer) {
        hits.appendChild(h('li', null, h('button.notesv__second-hit', {
          type: 'button',
          onClick: () => openHit(hit),
        },
        h('span.notesv__second-hit-title', null, text(hit.titel)),
        h('span.badge', null, text(TYPE_LABEL[hit.type] || hit.type)),
        hit.wortform && hit.wortform !== eintrag.begriff
          ? h('span.meta', null, text(`als „${hit.wortform}“`))
          : null,
        hit.stelle ? h('span.notesv__second-hit-snippet.meta', null, snippet(hit.stelle)) : null)));
      }
      row.appendChild(hits);
      if (gezaehlt > treffer.length) {
        row.appendChild(h('p.meta.notesv__second-term-more', null,
          text(`Aufgeführt sind die ersten ${formatNumber(treffer.length)}.`)));
      }
      rows.appendChild(row);
    }
    block.appendChild(rows);
    if (stumm) {
      block.appendChild(h('p.hint', null,
        text(`Bei ${formatNumber(stumm)} weiteren Begriffen hat der Volltextindex einen Fehler gemeldet; die fehlen in dieser Liste.`)));
    }
    block.appendChild(h('p.hint', null,
      text('Jeder Begriff hier steht wirklich in dem Eintrag, auf den er zeigt – nachgeschlagen, nicht geraten. Umlaute und ihre Umschrift zählen dabei als dasselbe Wort.')));
    return block;
  }

  /* ---------------------------------------------------------------- */
  /* Wiki links                                                        */
  /* ---------------------------------------------------------------- */

  function resolveWiki(title) {
    const entry = state.titleIndex.get(foldTitle(title));
    return entry || null;
  }

  function wikiHref(title) {
    const entry = resolveWiki(title);
    if (!entry) return null;
    return targetFor({ id: entry.id, type: entry.type });
  }

  /**
   * Click on a `[[link]]` in the preview. A resolved link navigates; an
   * unresolved one offers to create the note -- after asking.
   */
  function onWikiLink(title) {
    const entry = resolveWiki(title);
    if (entry) return false; // the href already points at the right place
    (async () => {
      const ok = await ctx.confirm({
        title: 'Notiz anlegen?',
        message: `Es gibt bisher keinen Eintrag mit dem Titel „${title}“. Soll eine neue Notiz mit diesem Titel angelegt und geöffnet werden? Die Verknüpfung aus dieser Notiz entsteht dann beim nächsten Speichern von selbst.`,
        confirmLabel: 'Notiz anlegen',
      });
      if (!ok || disposed) return;
      await flush();
      await createNote(title);
    })();
    return true; // we handled it: do not follow the fallback search link
  }

  /* ------------------------- autocompletion ------------------------- */

  function updateSuggestions() {
    const value = dom.body.value;
    const caret = dom.body.selectionStart;
    if (typeof caret !== 'number') {
      closeSuggest();
      return;
    }
    const before = value.slice(0, caret);
    const match = /\[\[([^[\]\n]*)$/.exec(before);
    if (!match) {
      closeSuggest();
      return;
    }
    const query = match[1];
    const folded = foldTitle(query);
    const items = [];
    for (const entry of state.titleIndex.values()) {
      if (items.length >= 8) break;
      if (!folded || foldTitle(entry.label).includes(folded)) items.push(entry);
    }
    const exact = items.some((entry) => foldTitle(entry.label) === folded);
    if (query.trim() && !exact) {
      items.push({ id: null, type: 'new', label: query.trim() });
    }
    if (!items.length) {
      closeSuggest();
      return;
    }
    state.suggest = {
      query,
      range: { start: caret - match[0].length, end: caret },
      items,
      index: 0,
    };
    if (!state.extraTitlesLoaded) ensureExtraTitles();
    renderSuggest();
  }

  function closeSuggest() {
    if (!state.suggest) return;
    state.suggest = null;
    dom.suggest.hidden = true;
    clear(dom.suggest);
  }

  function acceptSuggestion(entry) {
    if (!state.suggest) return;
    const { range } = state.suggest;
    const value = dom.body.value;
    const insert = `[[${entry.label}]]`;
    dom.body.value = value.slice(0, range.start) + insert + value.slice(range.end);
    const caret = range.start + insert.length;
    try {
      dom.body.setSelectionRange(caret, caret);
    } catch {
      /* not focusable right now: the text is inserted either way */
    }
    closeSuggest();
    dom.body.focus();
    markDirty();
    schedulePreview();
  }

  function onBodyKey(event) {
    if (state.suggest) {
      const { items } = state.suggest;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.suggest.index = (state.suggest.index + 1) % items.length;
        renderSuggest();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.suggest.index = (state.suggest.index - 1 + items.length) % items.length;
        renderSuggest();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        acceptSuggestion(items[state.suggest.index]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSuggest();
        return;
      }
    }
    if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      flush();
    }
  }

  function onGlobalKey(event) {
    if (event.key === 's' && (event.metaKey || event.ctrlKey) && dom.root.contains(event.target)) {
      event.preventDefault();
      flush();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function renderAll() {
    renderList();
    renderHead();
    renderTags();
    renderPreview();
    renderLinks();
    renderSecond();
    renderStatus();
  }

  function renderMode() {
    dom.root.dataset.mode = state.mode;
    for (const button of dom.modeSwitch.childNodes) {
      const active = button.dataset && button.dataset.mode === state.mode;
      button.classList.toggle('is-active', !!active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function renderList() {
    const searching = Array.isArray(state.hits);
    const rows = searching
      ? state.hits
      : state.notes.slice().sort((a, b) => {
        const pa = dataOf(a).pinned === true;
        const pb = dataOf(b).pinned === true;
        if (pa !== pb) return pa ? -1 : 1;
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      }).map((record) => ({ record, snippet: '' }));

    list(dom.list, uniqueById(rows, (row) => row.record && row.record.id), (row) => row.record.id,
      (row, existing) => renderListRow(row, existing));

    clear(dom.listFoot);
    if (searching && state.searchError) {
      dom.listFoot.appendChild(text(`Suche nicht möglich: ${state.searchError}`));
    } else if (searching) {
      dom.listFoot.appendChild(text(`${formatNumber(rows.length)} Treffer für „${state.query.trim()}“`));
    } else {
      dom.listFoot.appendChild(text(`${formatNumber(state.notes.length)} Notiz${state.notes.length === 1 ? '' : 'en'}`));
    }
  }

  function renderListRow(row, existing) {
    const record = row.record;
    const node = existing || h('li.notesv__row');
    clear(node);
    node.classList.toggle('is-active', record.id === state.noteId);

    const preview = row.snippet
      ? h('span.notesv__row-snippet.meta', null, snippet(row.snippet))
      : h('span.notesv__row-snippet.meta', null, text(extractPlain(dataOf(record).body || '', { maxLength: 90 }) || 'Leer'));

    const tags = Array.isArray(dataOf(record).tags) ? dataOf(record).tags.slice(0, 3) : [];

    node.appendChild(h('button.notesv__row-main', {
      type: 'button',
      onClick: () => open(record.id),
    },
    h('span.notesv__row-title', null,
      dataOf(record).pinned ? h('span.notesv__pin', { title: 'Angeheftet' }, text('★')) : null,
      text(noteTitle(record))),
    preview,
    h('span.notesv__row-meta.meta', null,
      text(timeAgo(record.updatedAt || record.createdAt)),
      ...tags.map((tag) => h('span.tag', null, text(`#${tag}`))))));
    return node;
  }

  /** Open a note by address so the URL always names what is on screen. */
  function open(noteId) {
    const hash = `#/notes?id=${encodeURIComponent(noteId)}`;
    if (window.location.hash === hash) {
      openNote(noteId);
      return;
    }
    ctx.navigate(hash);
  }

  function renderHead() {
    const hasNote = !!state.note;
    dom.titleInput.disabled = !hasNote;
    dom.body.disabled = !hasNote;
    dom.deleteButton.disabled = !hasNote;
    dom.graphButton.disabled = !hasNote;
    updateSecondButton();
  }

  function renderTags() {
    clear(dom.tagBar);
    if (!state.note) return;
    for (const tag of state.tags || []) {
      dom.tagBar.appendChild(h('span.tag.notesv__tag', null,
        text(`#${tag}`),
        h('button.notesv__tag-remove', {
          type: 'button',
          'aria-label': `Schlagwort ${tag} entfernen`,
          title: 'Entfernen',
          onClick: () => removeTag(tag),
        }, text('×'))));
    }
    dom.tagInput = h('input.notesv__tag-input', {
      type: 'text',
      placeholder: (state.tags || []).length ? 'Schlagwort …' : 'Schlagworte, durch Komma getrennt',
      'aria-label': 'Schlagwort hinzufügen',
      autocomplete: 'off',
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ',') {
          event.preventDefault();
          addTag(event.target.value);
        } else if (event.key === 'Backspace' && !event.target.value && (state.tags || []).length) {
          removeTag(state.tags[state.tags.length - 1]);
        }
      },
      onBlur: (event) => addTag(event.target.value),
    });
    dom.tagBar.appendChild(dom.tagInput);
  }

  const schedulePreview = debounce(() => {
    if (!disposed) renderPreview();
  }, PREVIEW_MS);

  function renderPreview() {
    if (state.mode === 'edit') return;
    clear(dom.preview);
    if (!state.note) {
      dom.preview.appendChild(renderEmpty());
      return;
    }
    const body = dom.body.value;
    if (!body.trim()) {
      dom.preview.appendChild(h('p.meta', null, text('Noch kein Text. Die Vorschau zeigt, was andere (und das Modell) sehen.')));
      return;
    }
    dom.preview.appendChild(renderMarkdown(body, {
      wikiHref,
      onWikiLink,
      tagHref: (tag) => `#/search?q=${encodeURIComponent(`#${tag}`)}`,
    }));
    // A link that cannot be resolved yet may simply belong to a type we have
    // not indexed; fetch those titles once, then repaint.
    if (!state.extraTitlesLoaded && dom.preview.querySelector('.md-wiki--missing')) ensureExtraTitles();
  }

  function renderEmpty() {
    if (state.loadError) {
      return h('div.empty', null,
        h('h3', null, text('Diese Notiz konnte nicht geladen werden')),
        h('p', null, text(errorMessage(state.loadError))),
        h('button.btn', { type: 'button', onClick: () => openNote(state.noteId) }, text('Erneut versuchen')));
    }
    return h('div.empty', null,
      h('h3', null, text(state.notes.length ? 'Keine Notiz ausgewählt' : 'Noch keine Notizen')),
      h('p', null, text(state.notes.length
        ? 'Wähle links eine Notiz oder lege eine neue an.'
        : 'Notizen liegen als Einträge in deinem Tresor – auf diesem Gerät, in einem Ordner, den du kennst.')),
      h('button.btn.btn--primary', { type: 'button', onClick: () => createNote() }, text('Neue Notiz')));
  }

  function renderStatus() {
    clear(dom.status);
    dom.status.className = state.saveState === 'error' ? 'notesv__status meta is-danger' : 'notesv__status meta';
    if (!state.note) return;

    if (state.saveState === 'saving') {
      dom.status.appendChild(text('Speichert …'));
      return;
    }
    if (state.saveState === 'dirty') {
      dom.status.appendChild(text('Nicht gespeichert – wird gleich gesichert'));
      return;
    }
    if (state.saveState === 'error') {
      dom.status.append(
        text(`Nicht gespeichert: ${errorMessage(state.saveError)} `),
        h('button.btn.btn--small', { type: 'button', onClick: () => save() }, text('Erneut versuchen')),
      );
      return;
    }
    if (state.savedAt) {
      const seconds = Math.round((Date.now() - state.savedAt) / 1000);
      dom.status.appendChild(text(seconds < 3
        ? 'Gespeichert'
        : `Gespeichert vor ${formatAgo(seconds)}`));
      return;
    }
    dom.status.appendChild(text(`Zuletzt geändert ${timeAgo(state.note.updatedAt)}`));
  }

  function formatAgo(seconds) {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} Min.`;
    return `${Math.round(minutes / 60)} Std.`;
  }

  function renderLinks(error) {
    clear(dom.links);
    if (!state.note) return;

    const head = h('div.notesv__links-head', null,
      h('h3.notesv__links-title', null, text('Verknüpfungen')),
      h('span.meta', null, text('Wer zeigt hierher – und wohin diese Notiz zeigt.')));
    dom.links.appendChild(head);

    if (error) {
      dom.links.appendChild(h('p.is-danger', null, text(`Verknüpfungen nicht lesbar: ${errorMessage(error)}`)));
      return;
    }

    dom.links.appendChild(renderLinkGroup(
      `Verweist hierher (${formatNumber(state.edgesIn.length)})`,
      state.edgesIn,
      (edge) => dataOf(edge).from,
      'Noch zeigt nichts auf diese Notiz.',
    ));
    dom.links.appendChild(renderLinkGroup(
      `Verweist auf (${formatNumber(state.edgesOut.length)})`,
      state.edgesOut,
      (edge) => dataOf(edge).to,
      'Diese Notiz verlinkt noch nichts. Schreib [[Titel]], um zu verknüpfen.',
    ));
  }

  function renderLinkGroup(title, edges, pick, emptyText) {
    const group = h('div.notesv__links-group', null, h('h4', null, text(title)));
    if (!edges.length) {
      group.appendChild(h('p.meta', null, text(emptyText)));
      return group;
    }
    const rows = h('ul.notesv__links-list', { role: 'list' });
    for (const edge of edges) {
      const id = pick(edge);
      const info = state.labels.get(id) || { label: 'wird geladen …', type: null, missing: false };
      const data = dataOf(edge);
      rows.appendChild(h('li', null, h('button.notesv__link', {
        type: 'button',
        title: data.reason ? `${KIND_LABEL[data.kind] || data.kind} · ${data.reason}` : (KIND_LABEL[data.kind] || data.kind),
        onClick: () => {
          if (info.missing) {
            ctx.toast('Dieser Eintrag existiert nicht mehr.', 'info');
            return;
          }
          ctx.navigate(targetFor({ id, type: info.type || 'note' }));
        },
      },
      h('span.notesv__link-label', { class: info.missing ? 'is-danger' : '' }, text(info.label)),
      h('span.meta', null, text(`${TYPE_LABEL[info.type] || info.type || '—'} · ${KIND_LABEL[data.kind] || data.kind}`)),
      data.source === 'agent' ? h('span.badge', null, text('Agent')) : null)));
    }
    group.appendChild(rows);
    return group;
  }

  function renderSuggest() {
    if (!state.suggest) return;
    clear(dom.suggest);
    dom.suggest.hidden = false;
    state.suggest.items.forEach((entry, index) => {
      const item = h('li.notesv__suggest-item', {
        role: 'option',
        'aria-selected': index === state.suggest.index ? 'true' : 'false',
        // mousedown, not click: the textarea's blur would otherwise close the
        // list before the click could land on it.
        onMouseDown: (event) => {
          event.preventDefault();
          acceptSuggestion(entry);
        },
        onMouseEnter: () => {
          state.suggest.index = index;
          renderSuggest();
        },
      },
      h('span', null, text(entry.type === 'new' ? `„${entry.label}“ als neue Notiz verlinken` : entry.label)),
      h('span.meta', null, text(entry.type === 'new' ? 'neu' : (TYPE_LABEL[entry.type] || entry.type))));
      if (index === state.suggest.index) item.classList.add('is-active');
      dom.suggest.appendChild(item);
    });
    positionSuggest();
  }

  /**
   * Put the suggestion list under the caret.
   *
   * A hidden mirror element reproduces the textarea's text up to the caret and
   * reports where it ends. If any of that is unavailable, the list falls back
   * to the top-left of the editor -- a list in a slightly wrong place is a
   * nuisance, a list that throws would take the editor down with it.
   */
  function positionSuggest() {
    let top = 8;
    let left = 8;
    try {
      const style = window.getComputedStyle(dom.body);
      const mirror = document.createElement('div');
      mirror.className = 'notesv__mirror';
      for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth']) {
        mirror.style[prop] = style[prop];
      }
      mirror.style.width = `${dom.body.clientWidth}px`;
      mirror.textContent = dom.body.value.slice(0, state.suggest.range.start);
      const marker = document.createElement('span');
      marker.textContent = '​';
      mirror.appendChild(marker);
      dom.editor.appendChild(mirror);
      const markerBox = marker.getBoundingClientRect();
      const mirrorBox = mirror.getBoundingClientRect();
      const lineHeight = parseFloat(style.lineHeight) || 20;
      top = (markerBox.top - mirrorBox.top) + lineHeight + 4 - dom.body.scrollTop;
      left = markerBox.left - mirrorBox.left;
      mirror.remove();
    } catch {
      top = 8;
      left = 8;
    }
    dom.suggest.style.top = `${Math.max(4, top)}px`;
    dom.suggest.style.left = `${Math.max(4, Math.min(left, Math.max(4, dom.body.clientWidth - 240)))}px`;
  }

  /** The textarea fills its pane, so only the scroll position needs resetting
   *  when a different note is loaded. */
  function resetScroll() {
    dom.body.scrollTop = 0;
    dom.preview.scrollTop = 0;
  }

  /* ---------------------------------------------------------------- */

  async function destroy() {
    try {
      await flush();
    } catch {
      /* flush() already turns failures into state; nothing to add here */
    }
    disposed = true;
    // Ein laufender zweiter Blick, den niemand mehr sieht, soll kein Modell
    // weiterrechnen lassen.
    cancelSecondLook();
    if (statusTimer) clearInterval(statusTimer);
    scheduleSave.cancel();
    schedulePreview.cancel();
    runSearch.cancel();
    reloadNotesSoon.cancel();
    loadLinksSoon.cancel();
    for (const off of cleanups) {
      try {
        off();
      } catch (err) {
        console.error('[neural-os] Notiz-Aufräumen fehlgeschlagen:', err);
      }
    }
    cleanups.length = 0;
  }

  return { start, destroy };
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = NOTES_CSS;
  document.head.appendChild(style);
}

function readMode() {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (MODES.some((mode) => mode.id === stored)) return stored;
  } catch {
    /* storage unavailable */
  }
  return 'split';
}

const NOTES_CSS = `
.notesv {
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.notesv__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}
.notesv__side-head { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2); }
.notesv__list { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 0 var(--sp-1); list-style: none; }
.notesv__list-foot { padding: var(--sp-1) var(--sp-2); border-top: 1px solid var(--border); }
.notesv__row { border-radius: var(--r-2); }
.notesv__row:hover { background: var(--surface-3); }
.notesv__row.is-active { background: var(--accent-soft); }
.notesv__row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--sp-1);
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;
}
.notesv__row-title { display: flex; gap: 4px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notesv__pin { color: var(--accent); }
.notesv__row-snippet {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.notesv__row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.notesv__main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.notesv__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
/* Lieber eine zweite Zeile für die Knöpfe als ein Titelfeld, in das nur noch
   drei Buchstaben passen: der Titel ist das, was man liest und tippt. */
.notesv__head-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 260px; }
.notesv__head-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
.notesv__title {
  width: 100%;
  padding: 2px 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  background: none;
  border: 0;
  border-bottom: 1px solid transparent;
}
.notesv__title:focus { outline: none; border-bottom-color: var(--accent); }
.notesv__title:disabled { color: var(--fg-subtle); }
.notesv__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-05);
  padding: var(--sp-05) var(--sp-2);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.notesv__tag { padding-right: 2px; }
.notesv__tag-remove { padding: 0 4px; background: none; border: 0; color: var(--fg-muted); cursor: pointer; }
.notesv__tag-remove:hover { color: var(--danger); }
.notesv__tag-input { min-width: 180px; flex: 1; padding: 2px 4px; background: none; border: 0; font-size: var(--fs-sm); }
.notesv__tag-input:focus { outline: none; }
.notesv__split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-height: 0; }
.notesv[data-mode="edit"] .notesv__split { grid-template-columns: minmax(0, 1fr); }
.notesv[data-mode="edit"] .notesv__preview { display: none; }
.notesv[data-mode="preview"] .notesv__split { grid-template-columns: minmax(0, 1fr); }
.notesv[data-mode="preview"] .notesv__editor { display: none; }
.notesv__editor { position: relative; min-width: 0; border-right: 1px solid var(--border); }
.notesv[data-mode="edit"] .notesv__editor { border-right: 0; }
.notesv__body {
  width: 100%;
  height: 100%;
  padding: var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--fg);
  background: var(--surface);
  border: 0;
  resize: none;
}
.notesv__body:focus { outline: none; background: var(--surface); }
.notesv__preview { min-width: 0; max-width: none; padding: var(--sp-2); overflow-y: auto; background: var(--surface-2); }
.notesv__mirror {
  position: absolute;
  top: 0;
  left: 0;
  visibility: hidden;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  pointer-events: none;
}
.notesv__suggest {
  position: absolute;
  z-index: 5;
  min-width: 240px;
  max-width: 340px;
  max-height: 220px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  box-shadow: var(--shadow-2);
}
.notesv__suggest-item {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-1);
  padding: 4px 8px;
  border-radius: var(--r-1);
  cursor: pointer;
}
.notesv__suggest-item.is-active { background: var(--accent-soft); }
.notesv__links {
  max-height: 34vh;
  overflow-y: auto;
  padding: var(--sp-1) var(--sp-2) var(--sp-2);
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.notesv__links-head { display: flex; align-items: baseline; gap: var(--sp-1); margin-bottom: var(--sp-1); }
.notesv__links-title { font-size: var(--fs-md); }
.notesv__links-group { margin-bottom: var(--sp-1); }
.notesv__links-group h4 { margin: var(--sp-05) 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.notesv__links-list { margin: 0; padding: 0; list-style: none; }
.notesv__link {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
  padding: 4px var(--sp-05);
  text-align: left;
  background: none;
  border: 0;
  border-radius: var(--r-1);
  cursor: pointer;
}
.notesv__link:hover { background: var(--surface-3); }
.notesv__link-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Zweiter Blick -- unter dem Text, mit eigenem Rollbereich, damit er den
   Editor nicht verdrängt, sondern neben ihm steht. */
.notesv__second {
  flex: 0 0 auto;
  max-height: 42vh;
  overflow-y: auto;
  padding: var(--sp-1) var(--sp-2) var(--sp-2);
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.notesv__second-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1); margin-bottom: var(--sp-1); }
.notesv__second-heading { margin: 0; font-size: var(--fs-md); }
.notesv__second-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
.notesv__second-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
  padding: var(--sp-2);
}
.notesv__second-state p { margin: 0; }
.notesv__second-stale { margin: 0 0 var(--sp-1); }
.notesv__second-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sp-2); }
.notesv__second-block {
  min-width: 0;
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-2);
  border-left: 3px solid var(--border-strong);
  border-radius: var(--r-2);
}
/* Die Farbe ist die Kennzeichnung: was vom Modell kommt, ist nicht belegt. */
.notesv__second-block--modell { border-left-color: var(--warn); }
.notesv__second-block--index { border-left-color: var(--ok); }
.notesv__second-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  margin: var(--sp-1) 0 var(--sp-05);
  font-size: var(--fs-sm);
  color: var(--fg-muted);
}
.notesv__second-mark--modell { color: var(--warn); }
.notesv__second-mark--index { color: var(--ok); }
.notesv__second-kern { margin: 0; }
.notesv__second-details > summary { cursor: pointer; font-size: var(--fs-sm); color: var(--fg-muted); }
.notesv__second-grund {
  margin: var(--sp-05) 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
.notesv__second-list { margin: 0; padding-left: var(--sp-3); }
.notesv__second-block p.hint { margin-top: var(--sp-1); }
/* Die Marke steht vor dem Satz, nicht darunter: sie ist die Antwort auf die
   Frage, mit der ein Mensch hierher kommt. Farbe UND Wort tragen sie. */
.notesv__second-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-1);
  margin-top: var(--sp-1);
}
.notesv__second-foot p.hint { flex: 1 1 12rem; margin-top: 0; }
.notesv__second-net { font-weight: 600; background: transparent; }
.notesv__second-net[data-net="offline"] { color: var(--net-offline); border: 1px solid var(--net-offline); }
.notesv__second-net[data-net="online"] { color: var(--net-online); border: 1px solid var(--net-online); }
.notesv__second-net[data-net="unknown"] {
  color: var(--net-unknown);
  border: 1px dashed var(--net-unknown);
}
.notesv__second-net-line { margin-top: var(--sp-05); }
.notesv__second-term-more { margin: 2px 0 0 var(--sp-1); }
.notesv__second-terms { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; padding: 0; list-style: none; }
.notesv__second-term-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1); }
.notesv__second-word {
  padding: 0;
  text-align: left;
  background: none;
  border: 0;
  color: var(--accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.notesv__second-word:hover { text-decoration: underline; }
.notesv__second-word:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-1); }
.notesv__second-hits { margin: 2px 0 0; padding-left: var(--sp-1); list-style: none; border-left: 1px solid var(--border); }
.notesv__second-hit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 2px var(--sp-05);
  text-align: left;
  background: none;
  border: 0;
  border-radius: var(--r-1);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.notesv__second-hit:hover { background: var(--surface-3); }
.notesv__second-hit:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.notesv__second-hit-title { font-size: var(--fs-sm); font-weight: 500; }
.notesv__second-hit-snippet {
  display: -webkit-box;
  flex-basis: 100%;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
}
.notesv__second-hit-snippet mark { padding: 0 1px; color: inherit; background: var(--accent-soft); border-radius: 2px; }

@media (max-width: 900px) {
  .notesv { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(120px, 30vh) minmax(0, 1fr); }
  .notesv__side { border-right: 0; border-bottom: 1px solid var(--border); }
  .notesv__split { grid-template-columns: minmax(0, 1fr); }
  .notesv[data-mode="split"] .notesv__preview { display: none; }
  .notesv__second-grid { grid-template-columns: minmax(0, 1fr); }
}
`;
