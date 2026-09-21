/**
 * views/chat.js -- the conversation view.
 *
 * The decisions that shape this file:
 *
 * - **A running answer outlives the view.** The stream lives in a module-level
 *   registry, not in the mounted instance. The server aborts generation when
 *   the SSE connection closes, so tearing the request down on every view
 *   change would throw away a local model's work for the price of a click on
 *   "Notizen". Views subscribe to the registry and re-attach on mount.
 * - **Stop goes through the server, not through the socket.** `POST
 *   /api/chats/:id/abort` lets the chat service settle the message record
 *   (status `aborted`, partial text kept) and send the closing events, which
 *   is how the UI learns what was actually stored. Dropping the connection
 *   would also stop generation, but the client would then be guessing about
 *   the outcome -- so the socket is only dropped as a watchdog if the server
 *   does not answer the abort.
 * - **Every badge under an answer is read from the stored record.** Model,
 *   duration, tokens and network use come from `message.data`, which the chat
 *   service fills from what really happened (the gate's own egress events).
 *   Where a backend reported nothing, the badge says "nicht gemeldet" instead
 *   of showing a plausible number. That is the whole point of the row.
 * - **An error is an error.** A failed turn renders as a failure with its code
 *   and message, never as an assistant bubble -- an empty answer bubble after
 *   a crash is indistinguishable from a model that had nothing to say.
 * - **Switching a chat to LAN/online asks first**, and the dialog names what
 *   would be transmitted (history, system text, pinned notes) and to which
 *   host, plus whether a grant actually exists. Consent without those facts is
 *   not consent.
 * - **The draft survives everything.** It lives in a module map and in
 *   localStorage per chat, so switching views or reloading the tab does not
 *   eat a half-written question.
 *
 * Zwei Modelle, eine Antwort
 * --------------------------
 * The comparison (IDEEN.md #6) is an ADDITION, never a new default. The normal
 * composer, the normal Senden button and the normal thread behave exactly as
 * before; the comparison lives in a panel that is closed until somebody opens
 * it, and it writes nothing into the conversation.
 *
 * The part that matters is the consent, and it is built so it cannot be
 * skipped:
 *
 * - The plan comes from the server BEFORE anything is sent, and the sentence
 *   that names the foreign host is the server's own -- the interface does not
 *   compose its own reassuring version of it.
 * - Confirming is a separate click on a separate button. The send button stays
 *   disabled until it happens.
 * - The consent belongs to one exact plan. Changing either side's model throws
 *   it away, because "yes, send it to api.openai.com" is not consent to send
 *   it somewhere else.
 * - Every provenance badge under an answer is read from what the server
 *   observed (`usedNetwork`, `networkTargets`), never from what was selected.
 */

import {
  h, text, clear, on, list, timeAgo, formatDateTime, formatNumber, debounce,
} from '../lib/dom.js';
import { api as defaultApi, ApiError } from '../lib/api.js';
import { renderMarkdown, extractPlain } from '../lib/markdown.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-chat-styles';
const DRAFT_PREFIX = 'neural-os:chat-draft:';
/** Server-side ceiling (src/http/api/chat.js). Mirrored to warn early. */
const MAX_CONTENT_CHARS = 200000;
/** Re-render the streaming bubble at most this often; deltas arrive per token. */
const STREAM_PAINT_MS = 70;
/** How long we wait for the server to close a stream after "Abbrechen". */
const ABORT_WATCHDOG_MS = 4000;
/** Auto-scroll only while the user is this close to the bottom. */
const STICK_PX = 120;

const NETWORK_OPTIONS = [
  { id: 'offline', label: 'Offline', hint: 'Nur dieses Gerät. Ein lokales Modell auf 127.0.0.1 bleibt erreichbar.' },
  { id: 'inherit', label: 'Global', hint: 'Folgt dem globalen Netzmodus aus dem Bereich „Netzwerk“.' },
  { id: 'lan', label: 'LAN', hint: 'Zusätzlich Geräte im lokalen Netz. Kein öffentliches Internet.' },
  { id: 'online', label: 'Online', hint: 'Öffentliches Internet – nur mit passender Freigabe im Bereich „Netzwerk“.' },
];

const ROLE_LABEL = { user: 'Du', assistant: 'Assistent', system: 'System', tool: 'Werkzeug' };

/* --- Zwei Modelle, eine Antwort ------------------------------------- */

/** How the server names a place, and how that reads in a sentence. */
const PLACE_LABEL = {
  lokal: 'auf diesem Gerät',
  lan: 'im lokalen Netz',
  online: 'im öffentlichen Internet',
  unbekannt: 'auf einem noch nicht bestimmten Rechner',
};

/** Which colour the shared `--net-*` variables give a place. */
const PLACE_NET = { lokal: 'offline', lan: 'lan', online: 'online', unbekannt: 'unknown' };

/** Repaint the two streaming columns at most this often. */
const COMPARE_PAINT_MS = 90;

/** Set when a freshly created chat should receive the caret after remounting. */
let focusOnMount = false;

const VIEW_ICON = '<rect x="2.5" y="3.5" width="15" height="10.5" rx="3.2"/><path d="M6.6 14v3.2L10.3 14"/>';

/* ------------------------------------------------------------------ */
/* Drafts                                                              */
/* ------------------------------------------------------------------ */

const drafts = new Map();

function readDraft(chatId) {
  if (drafts.has(chatId)) return drafts.get(chatId);
  try {
    const stored = window.localStorage.getItem(DRAFT_PREFIX + chatId);
    if (stored !== null) {
      drafts.set(chatId, stored);
      return stored;
    }
  } catch {
    /* storage blocked: the draft then only survives within this session */
  }
  return '';
}

function writeDraft(chatId, value) {
  drafts.set(chatId, value);
  try {
    if (value) window.localStorage.setItem(DRAFT_PREFIX + chatId, value);
    else window.localStorage.removeItem(DRAFT_PREFIX + chatId);
  } catch {
    /* ignore: the in-memory copy still survives a view change */
  }
}

/* ------------------------------------------------------------------ */
/* Stream registry -- one running answer per chat, above the view      */
/* ------------------------------------------------------------------ */

/** @type {Map<string, {chatId:string, controller:AbortController, text:string,
 *  messageId:string|null, status:string, listeners:Set<Function>,
 *  startedAt:number, aborting:boolean, error:ApiError|null}>} */
const streams = new Map();

function streamFor(chatId) {
  return chatId ? streams.get(chatId) || null : null;
}

function emit(entry, event) {
  // The entry is handed to the listener rather than captured by it: a
  // subscriber registered at creation time would otherwise have to reference a
  // binding that does not exist yet if the first event arrives synchronously.
  for (const listener of [...entry.listeners]) {
    try {
      listener(event, entry);
    } catch (err) {
      console.error('[neural-os] Chat-Stream-Handler ist gescheitert:', err);
    }
  }
}

/**
 * Send a message and drive its answer stream.
 *
 * Resolves when the stream ends, however it ended. Callers subscribe through
 * `entry.listeners` -- including views that mount later, which is why the
 * accumulated text lives on the entry rather than in a closure.
 */
function startStream(api, chatId, content, listener) {
  if (streams.has(chatId)) return streams.get(chatId);

  const controller = new AbortController();
  const entry = {
    chatId,
    controller,
    text: '',
    messageId: null,
    status: 'running',
    listeners: new Set(),
    startedAt: Date.now(),
    aborting: false,
    error: null,
  };
  // Subscribe before the first byte can arrive, not after.
  if (typeof listener === 'function') entry.listeners.add(listener);
  streams.set(chatId, entry);

  entry.done = (async () => {
    try {
      await api.stream(`/chats/${encodeURIComponent(chatId)}/send`, {
        body: { content },
        signal: controller.signal,
        onEvent: (event) => {
          const payload = (event && event.payload) || {};
          const type = (event && event.type) || payload.type || 'message';
          if (type === 'start' && payload.record) entry.messageId = payload.record.id;
          if (type === 'delta' && typeof payload.text === 'string') entry.text += payload.text;
          if (type === 'message' && payload.record) entry.text = (payload.record.data && payload.record.data.content) || entry.text;
          if (type === 'error') entry.status = payload.aborted ? 'aborted' : 'failed';
          emit(entry, { type, payload });
        },
      });
      if (entry.status === 'running') entry.status = 'complete';
    } catch (err) {
      // A transport failure is not a model answer: it is reported as itself.
      const apiError = err instanceof ApiError
        ? err
        : new ApiError('STREAM_INTERRUPTED', 'Die Verbindung zum lokalen Server ist während der Antwort abgerissen.', { status: 0, cause: err });
      entry.error = apiError;
      entry.status = apiError.isAborted ? 'aborted' : 'failed';
      emit(entry, { type: 'transport-error', payload: { error: apiError } });
    } finally {
      streams.delete(chatId);
      emit(entry, { type: 'closed', payload: { status: entry.status, error: entry.error } });
      entry.listeners.clear();
    }
    return entry;
  })();

  return entry;
}

/**
 * Ask the server to stop generating. The stream stays open so the final,
 * stored record still arrives; only if the server stays silent do we drop the
 * connection ourselves (which aborts it server-side too, via `stream.onClose`).
 */
async function requestAbort(api, chatId) {
  const entry = streamFor(chatId);
  if (!entry || entry.aborting) return;
  entry.aborting = true;
  emit(entry, { type: 'aborting', payload: {} });

  const watchdog = setTimeout(() => {
    if (streams.get(chatId) === entry) entry.controller.abort();
  }, ABORT_WATCHDOG_MS);

  try {
    await api.post(`/chats/${encodeURIComponent(chatId)}/abort`, {}, { timeoutMs: 8000 });
  } catch (err) {
    clearTimeout(watchdog);
    // The server could not be asked -- then the socket is the only lever left.
    entry.controller.abort();
    throw err;
  }
  // The watchdog stays armed on purpose: a successful POST means "abort
  // delivered", not "stream finished".
  if (entry.done && typeof entry.done.finally === 'function') {
    entry.done.finally(() => clearTimeout(watchdog));
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function recordOf(response) {
  if (!response) return null;
  if (response.record) return response.record;
  if (response.id) return response;
  return null;
}

/** `list()` refuses duplicate keys; a doubled record must not blank the view. */
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

function chatTitle(record) {
  const title = String(dataOf(record).title || '').trim();
  return title || 'Ohne Titel';
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes} min ${seconds} s`;
}

function errorMessage(err) {
  if (err instanceof ApiError) return err.message;
  if (err && err.message) return err.message;
  return String(err);
}

function modelRefOf(record) {
  const model = dataOf(record).model;
  if (!model || typeof model !== 'object') return null;
  const name = model.model || model.id || null;
  const provider = model.provider || model.providerId || null;
  if (!name && !provider) return null;
  return { provider, model: name };
}

/**
 * Which exact plan a consent belongs to.
 *
 * The key names every side that would leave the device, with its host and its
 * model. Change either one and the key changes, which throws the consent away
 * -- "ja, an api.openai.com" is not consent to send the same text to
 * openrouter.ai, and it is not consent to send a different model's context
 * either.
 */
function consentKey(plan) {
  if (!plan) return '';
  return ['a', 'b'].map((side) => {
    const entry = plan[side];
    if (!entry || !entry.modell) return `${side}:-`;
    if (!entry.verlaesstGeraet) return `${side}:lokal`;
    return `${side}:${entry.modell.host}/${entry.modell.model}`;
  }).join('|');
}

/** The hosts a plan would send to. Used for the confirmation button's label. */
function leavingHosts(plan) {
  if (!plan) return [];
  return ['a', 'b']
    .map((side) => plan[side])
    .filter((entry) => entry && entry.modell && entry.verlaesstGeraet)
    .map((entry) => entry.modell.host);
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let current = null;

export default {
  id: 'chat',
  title: 'Chat',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyles();
    const instance = createChatView(container, ctx);
    current = instance;
    await instance.start();
  },

  async unmount() {
    const instance = current;
    current = null;
    if (instance) instance.destroy();
  },
};

function createChatView(container, ctx) {
  const api = ctx.api || defaultApi;
  const cleanups = [];
  let disposed = false;

  const state = {
    chats: [],
    filter: '',
    hits: new Map(), // chatId -> snippet text from the full-text search
    chatId: null,
    chat: null,
    chatError: null,
    messages: [],
    notices: [],
    models: null,
    agents: null,
    stance: null,
    contextLabels: new Map(),
    renaming: null,
    pickerOpen: false,
    mobileList: false,
    stick: true,
    /**
     * Everything the comparison needs. `consentFor` holds the plan key the
     * user agreed to, so a changed selection silently invalidates it.
     */
    compare: {
      open: false,
      a: '',
      b: '',
      plan: null,
      planError: null,
      planLoading: false,
      consentFor: '',
      running: false,
      aborting: false,
      sides: null,
      prompt: '',
      saved: null,
    },
  };

  const dom = {};
  /** id -> {node, body, signature} for the rendered messages. */
  const messageNodes = new Map();
  let streamUnsubscribe = null;
  let paintTimer = null;
  let pendingPaint = false;
  /** The running comparison, if any. Bound to this mounted view. */
  let compareController = null;
  let comparePaintTimer = null;

  /* ---------------------------------------------------------------- */
  /* Skeleton                                                          */
  /* ---------------------------------------------------------------- */

  function build() {
    dom.newButton = h('button.btn.btn--primary.btn--small', {
      type: 'button',
      onClick: () => createChat(),
    }, text('Neuer Chat'));

    dom.filterInput = h('input.input.chatv__filter', {
      type: 'search',
      placeholder: 'Chats durchsuchen …',
      'aria-label': 'Chats durchsuchen',
      autocomplete: 'off',
      spellcheck: 'false',
      onInput: (event) => {
        state.filter = event.target.value;
        renderSidebar();
        searchMessages(state.filter);
      },
    });

    dom.chatList = h('ul.chatv__list', { role: 'list' });
    dom.sideFoot = h('p.chatv__side-foot.meta');

    dom.side = h('aside.chatv__side', { 'aria-label': 'Unterhaltungen' },
      h('div.chatv__side-head', null, dom.newButton, dom.filterInput),
      dom.chatList,
      dom.sideFoot);

    dom.headTitle = h('h2.chatv__title');
    dom.headMeta = h('div.chatv__head-meta.meta');
    dom.controls = h('div.chatv__controls');
    // On a narrow screen the two columns do not fit side by side, so the list
    // becomes a panel this button opens. Without it the list would simply be
    // unreachable on a phone.
    dom.listToggle = h('button.btn.btn--small.chatv__list-toggle', {
      type: 'button',
      'aria-expanded': 'false',
      onClick: () => {
        state.mobileList = !state.mobileList;
        dom.root.classList.toggle('chatv--list', state.mobileList);
        dom.listToggle.setAttribute('aria-expanded', state.mobileList ? 'true' : 'false');
      },
    }, text('Chats'));
    dom.head = h('header.chatv__head', null,
      dom.listToggle,
      h('div.chatv__head-main', null, dom.headTitle, dom.headMeta),
      dom.controls);

    dom.contextBar = h('div.chatv__context');
    dom.picker = h('div.chatv__picker', { hidden: true });

    dom.thread = h('div.chatv__thread', {
      role: 'log',
      // Additions only: announcing every repaint of a streaming answer would
      // make a screen reader read the same sentence a hundred times.
      'aria-relevant': 'additions',
      'aria-label': 'Verlauf',
    });
    dom.threadInner = h('div.chatv__thread-inner');
    dom.thread.appendChild(dom.threadInner);

    dom.jump = h('button.chatv__jump.btn.btn--small', {
      type: 'button',
      hidden: true,
      onClick: () => {
        state.stick = true;
        scrollToEnd(true);
        dom.jump.hidden = true;
      },
    }, text('Zum Ende springen'));

    dom.composerInput = h('textarea.chatv__input', {
      rows: '1',
      placeholder: 'Nachricht schreiben … (Enter sendet, Umschalt+Enter macht eine neue Zeile)',
      'aria-label': 'Nachricht',
      spellcheck: 'true',
      onInput: () => {
        autosize(dom.composerInput);
        if (state.chatId) saveDraft(state.chatId, dom.composerInput.value);
        renderComposer();
      },
      onKeyDown: onComposerKey,
    });

    dom.sendButton = h('button.btn.btn--primary.chatv__send', {
      type: 'button',
      onClick: () => send(),
    }, text('Senden'));

    dom.abortButton = h('button.btn.btn--danger.chatv__send', {
      type: 'button',
      hidden: true,
      onClick: () => abort(),
    }, text('Abbrechen'));

    dom.composerHint = h('span.chatv__composer-hint.meta');

    // The second send button. It appears only while the comparison panel is
    // open, so the normal composer is exactly what it always was.
    dom.compareSend = h('button.btn.chatv__send', {
      type: 'button',
      hidden: true,
      onClick: () => runCompare(),
    }, text('An beide senden'));

    dom.banner = h('div.chatv__banner', { hidden: true });
    dom.compare = h('section.cmp', { hidden: true, 'aria-label': 'Zwei Modelle, eine Antwort' });

    dom.composer = h('footer.chatv__composer', null,
      dom.composerInput,
      h('div.chatv__composer-row', null,
        dom.composerHint, h('span.spacer'), dom.compareSend, dom.abortButton, dom.sendButton));

    dom.main = h('section.chatv__main', null,
      dom.head,
      dom.contextBar,
      dom.picker,
      h('div.chatv__thread-wrap', null, dom.thread, dom.jump),
      dom.compare,
      dom.banner,
      dom.composer);

    dom.root = h('div.chatv', null, dom.side, dom.main);
    container.appendChild(dom.root);

    cleanups.push(on(dom.thread, 'scroll', () => {
      const distance = dom.thread.scrollHeight - dom.thread.scrollTop - dom.thread.clientHeight;
      state.stick = distance < STICK_PX;
      dom.jump.hidden = state.stick;
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Loading                                                           */
  /* ---------------------------------------------------------------- */

  async function start() {
    build();
    renderComposer();

    await loadChats();
    if (disposed) return;

    const wanted = (ctx.route && ctx.route.params && ctx.route.params.id)
      || ctx.state.get('activeChatId')
      || (state.chats[0] ? state.chats[0].id : null);

    if (wanted) await selectChat(wanted);
    else renderAll();

    if (focusOnMount && !disposed) {
      focusOnMount = false;
      dom.composerInput.focus();
    }

    // Model availability decides whether the empty state is a welcome or a
    // setup guide, so it is loaded even when no chat is open.
    loadModels();
    loadAgents();
    subscribeBus();
  }

  async function loadChats() {
    try {
      const response = await api.get('/chats', { query: { limit: 200, sort: 'updatedAt', order: 'desc' } });
      if (disposed) return;
      state.chats = itemsOf(response);
      renderSidebar();
    } catch (err) {
      if (disposed) return;
      state.chats = [];
      renderSidebar();
      ctx.toast(`Chats konnten nicht geladen werden: ${errorMessage(err)}`, 'error');
    }
  }

  async function loadModels() {
    try {
      const response = await api.get('/models', { timeoutMs: 10000 });
      if (disposed) return;
      state.models = response;
    } catch (err) {
      if (disposed) return;
      // Unknown is a state of its own: never claim "no model" on a failed read.
      state.models = { unavailable: true, error: errorMessage(err) };
    }
    renderControls();
    renderThread();
    renderCompare();
    renderBanner();
  }

  async function loadAgents() {
    try {
      const response = await api.get('/agents', { query: { limit: 100 } });
      if (disposed) return;
      state.agents = itemsOf(response);
    } catch (err) {
      if (disposed) return;
      state.agents = null; // the agent subsystem may simply not be installed
    }
    renderControls();
  }

  /**
   * Open a chat by address. The shell re-mounts the view on a hash change, so
   * this is deliberately a navigation and not a local state switch: one code
   * path, and the URL always names what is on screen. A running answer is not
   * affected -- it lives in the module-level registry, not in this instance.
   */
  function openChat(chatId) {
    const hash = `#/chat?id=${encodeURIComponent(chatId)}`;
    ctx.state.set('activeChatId', chatId);
    if (window.location.hash === hash) {
      selectChat(chatId);
      return;
    }
    ctx.navigate(hash);
  }

  async function selectChat(chatId) {
    state.chatId = chatId;
    state.chatError = null;
    state.messages = [];
    state.notices = [];
    state.mobileList = false;
    if (dom.root) dom.root.classList.remove('chatv--list');
    if (dom.listToggle) dom.listToggle.setAttribute('aria-expanded', 'false');
    messageNodes.clear();
    detachStream();
    // A comparison belongs to the conversation it was started in. Carrying it
    // into another chat would attach a result to a question nobody asked there.
    resetCompare();
    ctx.state.set('activeChatId', chatId);

    renderSidebar();
    renderHeader();
    renderThread();
    restoreDraft();

    try {
      const detail = await api.get(`/chats/${encodeURIComponent(chatId)}`);
      if (disposed || state.chatId !== chatId) return;
      state.chat = recordOf(detail);
      state.stance = detail && detail.stance ? detail.stance : null;
    } catch (err) {
      if (disposed || state.chatId !== chatId) return;
      state.chat = null;
      state.chatError = err;
      renderAll();
      return;
    }

    await loadMessages(chatId);
    if (disposed || state.chatId !== chatId) return;

    attachStream();
    renderAll();
    scrollToEnd(false);
    loadContextLabels();
  }

  async function loadMessages(chatId) {
    try {
      const response = await api.get(`/chats/${encodeURIComponent(chatId)}/messages`, { query: { limit: 1000 } });
      if (disposed || state.chatId !== chatId) return;
      state.messages = itemsOf(response);
    } catch (err) {
      if (disposed || state.chatId !== chatId) return;
      state.messages = [];
      ctx.toast(`Nachrichten konnten nicht geladen werden: ${errorMessage(err)}`, 'error');
    }
  }

  const reloadMessagesSoon = debounce(() => {
    if (!disposed && state.chatId && !streamFor(state.chatId)) {
      loadMessages(state.chatId).then(() => {
        if (!disposed) {
          renderThread();
          if (state.stick) scrollToEnd(false);
        }
      });
    }
  }, 350);

  const reloadChatsSoon = debounce(() => {
    if (!disposed) loadChats();
  }, 500);

  async function loadContextLabels() {
    const ids = Array.isArray(dataOf(state.chat).contextNodeIds) ? dataOf(state.chat).contextNodeIds : [];
    const missing = ids.filter((id) => !state.contextLabels.has(id));
    if (!missing.length) {
      renderContext();
      return;
    }
    // Sequential on purpose: a handful of pinned nodes is not worth a burst of
    // parallel requests at a local server that is also running a model.
    for (const id of missing) {
      try {
        const response = await api.get(`/records/${encodeURIComponent(id)}`);
        if (disposed) return;
        const record = recordOf(response);
        const data = dataOf(record);
        state.contextLabels.set(id, {
          label: data.title || data.name || data.text || record.id,
          type: record.type,
          missing: false,
        });
      } catch (err) {
        if (disposed) return;
        const gone = err instanceof ApiError && err.status === 404;
        state.contextLabels.set(id, {
          label: gone ? 'Eintrag existiert nicht mehr' : `Nicht lesbar (${errorMessage(err)})`,
          type: null,
          missing: true,
        });
      }
      renderContext();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Live events                                                       */
  /* ---------------------------------------------------------------- */

  function subscribeBus() {
    const forward = (payload, event) => {
      if (disposed) return;
      const type = (event && event.type) || '';
      const record = payload && payload.record;

      if (type === 'record.created' || type === 'record.updated' || type === 'record.deleted') {
        if (record && record.type === 'chat') {
          reloadChatsSoon();
          if (record.id === state.chatId && type !== 'record.deleted') {
            state.chat = record;
            renderHeader();
            renderContext();
          }
        }
        if (record && record.type === 'message' && dataOf(record).chatId === state.chatId) {
          reloadMessagesSoon();
        }
        return;
      }
      if (type === 'chat.message' || type === 'chat.delta' || type === 'chat.error') {
        // Only relevant when the answer was started somewhere else (another
        // tab, an agent). Our own stream feeds the view directly.
        if (payload && payload.chatId === state.chatId && !streamFor(state.chatId)) reloadMessagesSoon();
        return;
      }
      if (type === 'models.changed') loadModels();
    };

    for (const name of ['record.created', 'record.updated', 'record.deleted', 'chat.message', 'chat.delta', 'chat.error', 'models.changed']) {
      cleanups.push(ctx.bus.on(name, forward));
    }
  }

  /** One handler shape for both paths: freshly started and re-attached. */
  function streamHandler(event, entry) {
    if (disposed) return;
    handleStreamEvent(entry, event);
  }

  function attachStream() {
    detachStream();
    const entry = streamFor(state.chatId);
    if (!entry) return;
    entry.listeners.add(streamHandler);
    streamUnsubscribe = () => entry.listeners.delete(streamHandler);
    renderComposer();
  }

  function detachStream() {
    if (streamUnsubscribe) {
      streamUnsubscribe();
      streamUnsubscribe = null;
    }
  }

  function handleStreamEvent(entry, event) {
    const payload = event.payload || {};
    switch (event.type) {
      case 'user':
        if (payload.record) upsertMessage(payload.record);
        renderThread();
        scrollToEnd(false);
        break;
      case 'context':
        state.notices.push({
          id: `notice-${entry.chatId}-${state.notices.length}`,
          message: payload.message || 'Der Verlauf wurde für das Kontextfenster gekürzt.',
        });
        renderThread();
        break;
      case 'start':
        if (payload.record) upsertMessage(payload.record);
        renderThread();
        scrollToEnd(false);
        break;
      case 'delta':
        applyStreamingText(entry);
        break;
      case 'message':
        if (payload.record) upsertMessage(payload.record);
        renderThread();
        scrollToEnd(false);
        reloadChatsSoon(); // the first message may have named the chat
        break;
      case 'error':
        if (payload.record) upsertMessage(payload.record);
        else if (payload.error) {
          state.notices.push({
            id: `error-${Date.now()}`,
            error: payload.error,
            message: payload.error.message,
          });
        }
        renderThread();
        break;
      case 'transport-error':
        state.notices.push({
          id: `transport-${Date.now()}`,
          error: { code: payload.error.code, message: payload.error.message },
          message: payload.error.message,
        });
        renderThread();
        break;
      case 'aborting':
        renderComposer();
        break;
      case 'closed':
        renderComposer();
        renderBanner();
        renderSidebar();
        // The record the server stored is the truth; our streamed copy is not.
        reloadMessagesSoon();
        break;
      default:
        break;
    }
  }

  /** Paint the partially received answer, throttled so tokens do not thrash. */
  function applyStreamingText(entry) {
    if (!entry.messageId) return;
    const record = state.messages.find((m) => m.id === entry.messageId);
    if (record) {
      record.data = { ...record.data, content: entry.text, status: 'streaming' };
    }
    if (pendingPaint) return;
    pendingPaint = true;
    paintTimer = setTimeout(() => {
      pendingPaint = false;
      paintTimer = null;
      if (disposed) return;
      renderThread();
      if (state.stick) scrollToEnd(false);
    }, STREAM_PAINT_MS);
  }

  function upsertMessage(record) {
    const index = state.messages.findIndex((m) => m.id === record.id);
    if (index === -1) state.messages.push(record);
    else state.messages[index] = record;
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  async function createChat() {
    try {
      const response = await api.post('/chats', {});
      const record = recordOf(response);
      if (!record) throw new ApiError('BAD_RESPONSE', 'Der Server hat keinen Chat zurückgegeben.');
      state.chats.unshift(record);
      focusOnMount = true;
      openChat(record.id);
    } catch (err) {
      ctx.toast(`Chat konnte nicht angelegt werden: ${errorMessage(err)}`, 'error');
    }
  }

  function saveDraft(chatId, value) {
    writeDraft(chatId, value);
  }

  function restoreDraft() {
    const draft = state.chatId ? readDraft(state.chatId) : '';
    dom.composerInput.value = draft;
    autosize(dom.composerInput);
    renderComposer();
  }

  function onComposerKey(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === 'Escape' && streamFor(state.chatId)) {
      event.preventDefault();
      abort();
    }
  }

  async function send() {
    const content = dom.composerInput.value.trim();
    if (!content || !state.chatId) return;
    if (streamFor(state.chatId)) {
      ctx.toast('In diesem Chat läuft bereits eine Antwort.', 'info');
      return;
    }
    if (content.length > MAX_CONTENT_CHARS) {
      ctx.toast(`Die Nachricht ist zu lang (${formatNumber(content.length)} Zeichen, erlaubt sind ${formatNumber(MAX_CONTENT_CHARS)}).`, 'error');
      return;
    }

    dom.composerInput.value = '';
    saveDraft(state.chatId, '');
    autosize(dom.composerInput);
    state.stick = true;

    detachStream();
    const entry = startStream(api, state.chatId, content, streamHandler);
    streamUnsubscribe = () => entry.listeners.delete(streamHandler);
    renderComposer();
    renderSidebar(); // the row for this chat now says "antwortet …"
    // The failure is reported through the stream's own events; this catch only
    // keeps an unhandled rejection out of the console.
    if (entry.done) entry.done.catch(() => {});
  }

  async function abort() {
    if (!state.chatId || !streamFor(state.chatId)) return;
    try {
      await requestAbort(api, state.chatId);
    } catch (err) {
      ctx.toast(`Abbruch konnte nicht gemeldet werden: ${errorMessage(err)} – die Verbindung wurde getrennt.`, 'error');
    }
  }

  async function patchChat(patch) {
    if (!state.chatId) return null;
    const response = await api.patch(`/chats/${encodeURIComponent(state.chatId)}`, patch);
    const record = recordOf(response);
    if (record) {
      state.chat = record;
      const index = state.chats.findIndex((c) => c.id === record.id);
      if (index !== -1) state.chats[index] = record;
    }
    return record;
  }

  async function setNetwork(mode) {
    const currentMode = dataOf(state.chat).network || 'offline';
    if (mode === currentMode) return;
    if ((mode === 'online' || mode === 'lan') && !(await confirmNetwork(mode))) {
      renderControls();
      return;
    }
    try {
      await patchChat({ network: mode });
      await refreshStance();
      renderHeader();
      renderControls();
      ctx.toast(`Netzmodus dieses Chats: ${NETWORK_OPTIONS.find((o) => o.id === mode).label}.`, mode === 'offline' ? 'success' : 'info');
    } catch (err) {
      ctx.toast(`Netzmodus konnte nicht geändert werden: ${errorMessage(err)}`, 'error');
      renderControls();
    }
  }

  /**
   * The consent dialog. It names what leaves the machine, where it goes, and
   * whether the gate would actually let it through -- a chat setting alone
   * grants nothing.
   */
  async function confirmNetwork(mode) {
    const stance = state.stance || {};
    const model = stance.model || {};
    const host = model.host || 'das eingestellte Modell-Backend';
    const pinned = (dataOf(state.chat).contextNodeIds || []).length;
    const turns = state.messages.filter((m) => ['user', 'assistant'].includes(dataOf(m).role)).length;

    const parts = [];
    parts.push(mode === 'online'
      ? 'Dieser Chat darf danach das öffentliche Internet erreichen.'
      : 'Dieser Chat darf danach Geräte im lokalen Netz (LAN) erreichen.');
    parts.push(
      `Bei jeder Frage übertragen wird: der bisherige Verlauf dieses Chats (${turns} Nachricht(en)), `
      + `der Systemtext und ${pinned} angeheftete(r) Eintrag/Einträge – an ${host}.`,
    );
    parts.push(model.local === true
      ? `Das Modell selbst läuft auf diesem Gerät (${host}). Dorthin gehen diese Daten schon heute; das zählt nicht als Netzverkehr.`
      : `Achtung: Das Modell läuft nicht auf diesem Gerät. Alles Übertragene verlässt damit deinen Rechner.`);
    if (stance.known && ((mode === 'online' && !stance.internet) || (mode === 'lan' && !stance.lan))) {
      parts.push('Hinweis: Im Bereich „Netzwerk“ liegt dafür derzeit keine Freigabe vor. Ohne Freigabe bleibt der Zugriff trotz dieser Einstellung blockiert – die Einstellung allein öffnet nichts.');
    }
    parts.push('Du kannst das jederzeit wieder auf „Offline“ zurückstellen.');

    return ctx.confirm({
      title: mode === 'online' ? 'Internetzugang für diesen Chat?' : 'LAN-Zugang für diesen Chat?',
      message: parts.join('\n\n'),
      confirmLabel: 'Verstanden, erlauben',
      cancelLabel: 'Abbrechen',
      danger: true,
    });
  }

  async function refreshStance() {
    if (!state.chatId) return;
    try {
      const detail = await api.get(`/chats/${encodeURIComponent(state.chatId)}`);
      if (disposed) return;
      state.stance = detail && detail.stance ? detail.stance : null;
      const record = recordOf(detail);
      if (record) state.chat = record;
    } catch {
      state.stance = null; // unknown, and shown as unknown
    }
  }

  async function setModel(value) {
    let model = null;
    if (value) {
      const [provider, ...rest] = value.split('/');
      model = { provider, model: rest.join('/') };
    }
    try {
      await patchChat({ model });
      await refreshStance();
      renderHeader();
    } catch (err) {
      ctx.toast(`Modell konnte nicht gesetzt werden: ${errorMessage(err)}`, 'error');
      renderControls();
    }
  }

  async function setAgent(value) {
    try {
      await patchChat({ agentId: value || null });
      renderHeader();
    } catch (err) {
      ctx.toast(`Agent konnte nicht gesetzt werden: ${errorMessage(err)}`, 'error');
      renderControls();
    }
  }

  async function togglePin(record) {
    try {
      const response = await api.patch(`/chats/${encodeURIComponent(record.id)}`, { pinned: !dataOf(record).pinned });
      const updated = recordOf(response);
      if (updated) {
        const index = state.chats.findIndex((c) => c.id === updated.id);
        if (index !== -1) state.chats[index] = updated;
        if (updated.id === state.chatId) state.chat = updated;
      }
      renderSidebar();
    } catch (err) {
      ctx.toast(`Anheften fehlgeschlagen: ${errorMessage(err)}`, 'error');
    }
  }

  async function renameChat(record, nextTitle) {
    const title = String(nextTitle || '').trim();
    state.renaming = null;
    if (!title || title === chatTitle(record)) {
      renderSidebar();
      return;
    }
    try {
      const response = await api.patch(`/chats/${encodeURIComponent(record.id)}`, { title });
      const updated = recordOf(response);
      if (updated) {
        const index = state.chats.findIndex((c) => c.id === updated.id);
        if (index !== -1) state.chats[index] = updated;
        if (updated.id === state.chatId) {
          state.chat = updated;
          renderHeader();
        }
      }
    } catch (err) {
      ctx.toast(`Umbenennen fehlgeschlagen: ${errorMessage(err)}`, 'error');
    }
    renderSidebar();
  }

  async function deleteChat(record) {
    const ok = await ctx.confirm({
      title: 'Chat löschen?',
      message: `„${chatTitle(record)}“ wird in den Papierkorb gelegt. Die Nachrichten bleiben im Tresor erhalten und lassen sich wiederherstellen.`,
      confirmLabel: 'Löschen',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/records/${encodeURIComponent(record.id)}`);
      state.chats = state.chats.filter((c) => c.id !== record.id);
      if (record.id === state.chatId) {
        state.chat = null;
        state.chatId = null;
        state.messages = [];
        messageNodes.clear();
        if (state.chats[0]) openChat(state.chats[0].id);
        else renderAll();
      } else {
        renderSidebar();
      }
      ctx.toast('Chat gelöscht.', 'success');
    } catch (err) {
      ctx.toast(`Löschen fehlgeschlagen: ${errorMessage(err)}`, 'error');
    }
  }

  const searchMessages = debounce(async (query) => {
    const term = String(query || '').trim();
    if (term.length < 2) {
      if (state.hits.size) {
        state.hits.clear();
        renderSidebar();
      }
      return;
    }
    try {
      const response = await api.get('/search', { query: { q: term, types: 'message', limit: 30 } });
      if (disposed) return;
      const hits = new Map();
      for (const row of itemsOf(response)) {
        const record = row && row.record ? row.record : row;
        const chatId = dataOf(record).chatId;
        if (chatId && !hits.has(chatId)) hits.set(chatId, row.snippet || '');
      }
      state.hits = hits;
      renderSidebar();
    } catch {
      // A failing search must not empty the list the user is looking at.
    }
  }, 260);

  async function saveAsNote(record) {
    const content = String(dataOf(record).content || '').trim();
    if (!content) {
      ctx.toast('Diese Nachricht hat keinen Inhalt zum Speichern.', 'info');
      return;
    }
    const plain = extractPlain(content, { maxLength: 70 });
    const title = plain.split('\n')[0] || 'Notiz aus einem Chat';
    const model = modelRefOf(record);
    const provenance = [
      '',
      '---',
      `Quelle: Chat „${chatTitle(state.chat)}“ vom ${formatDateTime(record.createdAt)}`
      + (model ? ` · Modell: ${model.model || 'unbekannt'}${model.provider ? ` (${model.provider})` : ''}` : ''),
    ].join('\n');

    try {
      const response = await api.post('/records', {
        type: 'note',
        data: {
          title,
          // The message text is copied verbatim; the provenance block below the
          // rule is clearly the interface speaking, not the model.
          body: `${content}\n${provenance}\n`,
          tags: ['chat'],
          source: dataOf(record).role === 'assistant' ? 'agent' : 'user',
        },
      });
      const note = recordOf(response);
      if (!note) throw new ApiError('BAD_RESPONSE', 'Der Server hat keine Notiz zurückgegeben.');

      let linked = true;
      try {
        await api.post('/edges', {
          from: note.id,
          to: state.chatId,
          kind: 'derived-from',
          reason: 'Aus einer Nachricht dieses Chats gespeichert',
        });
      } catch {
        linked = false;
      }

      ctx.toast(linked
        ? 'Als Notiz gespeichert und mit diesem Chat verknüpft.'
        : 'Als Notiz gespeichert. Die Verknüpfung zum Chat konnte nicht angelegt werden.',
      linked ? 'success' : 'info', {
        action: { label: 'Notiz öffnen', run: () => ctx.navigate(`#/notes?id=${encodeURIComponent(note.id)}`) },
        timeout: 9000,
      });
    } catch (err) {
      ctx.toast(`Notiz konnte nicht gespeichert werden: ${errorMessage(err)}`, 'error');
    }
  }

  async function copyMessage(record) {
    const content = String(dataOf(record).content || '');
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('Die Zwischenablage ist in diesem Browser nicht verfügbar.');
      }
      await navigator.clipboard.writeText(content);
      ctx.toast('Nachricht kopiert.', 'success', { timeout: 2500 });
    } catch (err) {
      ctx.toast(`Kopieren nicht möglich: ${errorMessage(err)}`, 'error');
    }
  }

  async function retry(record) {
    // Find the user message this failed answer belongs to and send it again.
    const index = state.messages.findIndex((m) => m.id === record.id);
    let source = null;
    for (let i = index - 1; i >= 0; i--) {
      if (dataOf(state.messages[i]).role === 'user') {
        source = state.messages[i];
        break;
      }
    }
    if (!source) {
      ctx.toast('Zu dieser Antwort ist keine Frage mehr auffindbar.', 'error');
      return;
    }
    dom.composerInput.value = String(dataOf(source).content || '');
    autosize(dom.composerInput);
    renderComposer();
    await send();
  }

  async function removeContextNode(id) {
    const ids = (dataOf(state.chat).contextNodeIds || []).filter((entry) => entry !== id);
    try {
      await patchChat({ contextNodeIds: ids });
      renderContext();
    } catch (err) {
      ctx.toast(`Kontext konnte nicht geändert werden: ${errorMessage(err)}`, 'error');
    }
  }

  async function addContextNode(record) {
    const ids = [...(dataOf(state.chat).contextNodeIds || [])];
    if (ids.includes(record.id)) return;
    ids.push(record.id);
    try {
      await patchChat({ contextNodeIds: ids });
      state.contextLabels.set(record.id, {
        label: dataOf(record).title || dataOf(record).name || dataOf(record).text || record.id,
        type: record.type,
        missing: false,
      });
      closePicker();
      renderContext();
    } catch (err) {
      ctx.toast(`Eintrag konnte nicht angeheftet werden: ${errorMessage(err)}`, 'error');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function renderAll() {
    renderSidebar();
    renderHeader();
    renderControls();
    renderContext();
    renderThread();
    renderCompare();
    renderBanner();
    renderComposer();
  }

  /**
   * A conversation that already has messages still needs to say that no model
   * is reachable -- otherwise the next question would just fail with nothing
   * on screen explaining why.
   */
  function renderBanner() {
    const models = state.models;
    const noModel = !!(models && !models.unavailable && models.available === false);
    const show = noModel && state.messages.length > 0;
    dom.banner.hidden = !show;
    if (!show) return;
    clear(dom.banner);
    let expanded = false;
    const details = h('div', { hidden: true });
    const toggle = h('button.btn.btn--small', {
      type: 'button',
      onClick: () => {
        expanded = !expanded;
        details.hidden = !expanded;
        clear(toggle);
        toggle.appendChild(text(expanded ? 'Einrichtung ausblenden' : 'Einrichtung anzeigen'));
      },
    }, text('Einrichtung anzeigen'));
    details.appendChild(renderNoModelPanel(models));
    dom.banner.append(
      h('div.row', null,
        h('span.is-danger', null, text('Kein lokales Modell erreichbar – Fragen können gerade nicht beantwortet werden.')),
        h('span.spacer'),
        toggle,
        h('button.btn.btn--small', { type: 'button', onClick: () => refreshModels() }, text('Erneut suchen'))),
      details,
    );
  }

  function visibleChats() {
    const term = state.filter.trim().toLowerCase();
    const matching = uniqueById(term
      ? state.chats.filter((chat) => chatTitle(chat).toLowerCase().includes(term) || state.hits.has(chat.id))
      : state.chats.slice(), (chat) => chat.id);
    return matching.sort((a, b) => {
      const pa = dataOf(a).pinned === true;
      const pb = dataOf(b).pinned === true;
      if (pa !== pb) return pa ? -1 : 1;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
  }

  function renderSidebar() {
    const chats = visibleChats();
    list(dom.chatList, chats, (chat) => chat.id, (chat, existing) => renderChatRow(chat, existing));

    clear(dom.sideFoot);
    if (!state.chats.length) {
      dom.sideFoot.appendChild(text('Noch keine Unterhaltung.'));
    } else if (chats.length !== state.chats.length) {
      dom.sideFoot.appendChild(text(`${formatNumber(chats.length)} von ${formatNumber(state.chats.length)} Chats`));
    } else {
      dom.sideFoot.appendChild(text(`${formatNumber(state.chats.length)} Chat${state.chats.length === 1 ? '' : 's'} · alles auf diesem Gerät`));
    }
  }

  function renderChatRow(chat, existing) {
    const node = existing || h('li.chatv__row', { 'data-id': chat.id });
    clear(node);
    node.classList.toggle('is-active', chat.id === state.chatId);
    node.classList.toggle('is-streaming', !!streamFor(chat.id));

    if (state.renaming === chat.id) {
      const input = h('input.input.chatv__rename', {
        type: 'text',
        value: chatTitle(chat),
        'aria-label': 'Neuer Titel',
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            renameChat(chat, event.target.value);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            state.renaming = null;
            renderSidebar();
          }
        },
        onBlur: (event) => renameChat(chat, event.target.value),
      });
      node.appendChild(input);
      // Focus after insertion, otherwise the node is not in the document yet.
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      return node;
    }

    const hit = state.hits.get(chat.id);
    const button = h('button.chatv__row-main', {
      type: 'button',
      onClick: () => openChat(chat.id),
    },
    h('span.chatv__row-title', null,
      dataOf(chat).pinned ? h('span.chatv__pin', { 'aria-label': 'Angeheftet', title: 'Angeheftet' }, text('★')) : null,
      text(chatTitle(chat))),
    h('span.chatv__row-meta.meta', null,
      text(timeAgo(chat.updatedAt || chat.createdAt)),
      streamFor(chat.id) ? text(' · antwortet …') : null),
    hit ? h('span.chatv__row-hit.meta', null, ctx.snippet ? ctx.snippet(hit) : text(String(hit).replace(/[\u0001\u0002]/g, ''))) : null);

    const actions = h('span.chatv__row-actions', null,
      h('button.icon-button.btn--small', {
        type: 'button',
        title: dataOf(chat).pinned ? 'Anheften aufheben' : 'Anheften',
        'aria-label': dataOf(chat).pinned ? 'Anheften aufheben' : 'Anheften',
        onClick: (event) => {
          event.stopPropagation();
          togglePin(chat);
        },
      }, text(dataOf(chat).pinned ? '★' : '☆')),
      h('button.icon-button.btn--small', {
        type: 'button',
        title: 'Umbenennen',
        'aria-label': 'Umbenennen',
        onClick: (event) => {
          event.stopPropagation();
          state.renaming = chat.id;
          renderSidebar();
        },
      }, text('✎')),
      h('button.icon-button.btn--small', {
        type: 'button',
        title: 'Löschen',
        'aria-label': 'Löschen',
        onClick: (event) => {
          event.stopPropagation();
          deleteChat(chat);
        },
      }, text('🗑')));

    node.append(button, actions);
    return node;
  }

  function renderHeader() {
    clear(dom.headTitle);
    clear(dom.headMeta);
    if (!state.chat) {
      dom.headTitle.appendChild(text(state.chatError ? 'Chat nicht verfügbar' : 'Kein Chat ausgewählt'));
      renderControls();
      return;
    }
    dom.headTitle.appendChild(text(chatTitle(state.chat)));

    const model = modelRefOf(state.chat);
    const stance = state.stance || {};
    const parts = [];
    parts.push(model ? `Modell: ${model.model}${model.provider ? ` (${model.provider})` : ''}` : 'Modell: Standard');
    if (stance.known) {
      if (stance.internet) parts.push(stance.internetAny ? 'Internet freigegeben' : `Internet nur für ${stance.internetHosts.join(', ')}`);
      else if (stance.lan) parts.push(stance.lanAny ? 'LAN freigegeben' : `LAN nur für ${stance.lanHosts.join(', ')}`);
      else parts.push('kein Netzzugang');
    } else {
      parts.push('Netzlage unbekannt');
    }
    parts.push(`${formatNumber(state.messages.length)} Nachricht${state.messages.length === 1 ? '' : 'en'}`);
    dom.headMeta.appendChild(text(parts.join(' · ')));
    renderControls();
  }

  function renderControls() {
    clear(dom.controls);
    if (!state.chat) return;

    /* Model ------------------------------------------------------- */
    const modelSelect = h('select.select.chatv__select', {
      'aria-label': 'Modell für diesen Chat',
      onChange: (event) => setModel(event.target.value),
    });
    const currentModel = modelRefOf(state.chat);
    const currentValue = currentModel && currentModel.provider ? `${currentModel.provider}/${currentModel.model}` : '';
    modelSelect.appendChild(h('option', { value: '' }, text('Modell: Standard')));

    const providers = (state.models && Array.isArray(state.models.providers)) ? state.models.providers : [];
    let known = false;
    for (const provider of providers) {
      const models = Array.isArray(provider.models) ? provider.models : [];
      if (!provider.available || !models.length) continue;
      const group = h('optgroup', { label: `${provider.id || provider.kind}` });
      for (const model of models) {
        const value = `${provider.id}/${model.id}`;
        if (value === currentValue) known = true;
        group.appendChild(h('option', { value }, text(model.name || model.id)));
      }
      modelSelect.appendChild(group);
    }
    if (currentValue && !known) {
      // A chat may point at a model that is not loaded right now. Saying so is
      // better than silently resetting the selection to "Standard".
      modelSelect.appendChild(h('option', { value: currentValue }, text(`${currentModel.model} (zurzeit nicht erreichbar)`)));
    }
    modelSelect.value = currentValue;
    dom.controls.appendChild(modelSelect);

    /* Network ----------------------------------------------------- */
    const mode = dataOf(state.chat).network || 'offline';
    const segmented = h('div.segmented.chatv__net', { role: 'group', 'aria-label': 'Netzzugang dieses Chats' });
    for (const option of NETWORK_OPTIONS) {
      const button = h('button.segmented__option', {
        type: 'button',
        title: option.hint,
        'aria-pressed': option.id === mode ? 'true' : 'false',
        onClick: () => setNetwork(option.id),
      }, text(option.label));
      if (option.id === mode) button.classList.add('is-active');
      button.dataset.net = option.id;
      segmented.appendChild(button);
    }
    dom.controls.appendChild(segmented);

    /* Agent ------------------------------------------------------- */
    if (Array.isArray(state.agents) && state.agents.length) {
      const agentSelect = h('select.select.chatv__select', {
        'aria-label': 'Agent für diesen Chat',
        onChange: (event) => setAgent(event.target.value),
      });
      agentSelect.appendChild(h('option', { value: '' }, text('Ohne Agent')));
      for (const agent of state.agents) {
        agentSelect.appendChild(h('option', { value: agent.id }, text(dataOf(agent).name || agent.id)));
      }
      agentSelect.value = dataOf(state.chat).agentId || '';
      dom.controls.appendChild(agentSelect);
    }

    dom.controls.appendChild(h('button.btn.btn--small', {
      type: 'button',
      title: 'Einträge aus dem Wissensgraphen an diesen Chat anheften',
      onClick: () => togglePicker(),
    }, text('Kontext anheften')));

    const compareOpen = state.compare.open;
    dom.controls.appendChild(h('button.btn.btn--small', {
      type: 'button',
      'aria-pressed': compareOpen ? 'true' : 'false',
      class: compareOpen ? 'is-active' : '',
      title: 'Dieselbe Frage einmal an zwei Modelle schicken und beide Antworten nebeneinander sehen',
      onClick: () => toggleCompare(),
    }, text('Zwei Modelle')));
  }

  function renderContext() {
    clear(dom.contextBar);
    if (!state.chat) return;
    const ids = dataOf(state.chat).contextNodeIds || [];
    if (!ids.length) {
      dom.contextBar.hidden = true;
      return;
    }
    dom.contextBar.hidden = false;
    dom.contextBar.appendChild(h('span.chatv__context-label.meta', null, text('Kontext:')));
    for (const id of ids) {
      const info = state.contextLabels.get(id) || { label: 'wird geladen …', type: null, missing: false };
      const chip = h('span.chatv__chip', { class: info.missing ? 'is-danger' : '' },
        h('span.chatv__chip-label', { title: `${info.type || 'Eintrag'} · ${id}` }, text(info.label)),
        h('button.chatv__chip-remove', {
          type: 'button',
          'aria-label': `„${info.label}“ aus dem Kontext entfernen`,
          title: 'Entfernen',
          onClick: () => removeContextNode(id),
        }, text('×')));
      dom.contextBar.appendChild(chip);
    }
    dom.contextBar.appendChild(h('span.chatv__context-hint.meta', null,
      text('Diese Einträge werden bei jeder Frage mitgeschickt.')));
  }

  function togglePicker() {
    if (state.pickerOpen) {
      closePicker();
      return;
    }
    state.pickerOpen = true;
    dom.picker.hidden = false;
    clear(dom.picker);

    const results = h('ul.chatv__picker-list', { role: 'listbox', 'aria-label': 'Treffer' });
    const input = h('input.input', {
      type: 'search',
      placeholder: 'Notiz, Projekt oder Begriff suchen …',
      'aria-label': 'Eintrag suchen',
      autocomplete: 'off',
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closePicker();
        }
      },
      onInput: (event) => runPickerSearch(event.target.value, results),
    });

    dom.picker.append(
      h('div.chatv__picker-head', null, input, h('button.btn.btn--small', {
        type: 'button',
        onClick: () => closePicker(),
      }, text('Schließen'))),
      results,
    );
    input.focus();
    runPickerSearch('', results);
  }

  function closePicker() {
    state.pickerOpen = false;
    dom.picker.hidden = true;
    clear(dom.picker);
  }

  const runPickerSearch = debounce(async (query, results) => {
    clear(results);
    const term = String(query || '').trim();
    try {
      const response = term.length >= 2
        ? await api.get('/search', { query: { q: term, types: 'note,project,task,entity,file', limit: 12 } })
        : await api.get('/records', { query: { type: 'note', limit: 12, sort: 'updatedAt', order: 'desc' } });
      if (disposed || !state.pickerOpen) return;
      const rows = itemsOf(response).map((row) => (row && row.record ? row.record : row));
      if (!rows.length) {
        results.appendChild(h('li.chatv__picker-empty.meta', null, text('Nichts gefunden.')));
        return;
      }
      for (const record of rows) {
        const data = dataOf(record);
        results.appendChild(h('li', null, h('button.chatv__picker-item', {
          type: 'button',
          onClick: () => addContextNode(record),
        },
        h('span', null, text(data.title || data.name || data.text || record.id)),
        h('span.meta', null, text(record.type)))));
      }
    } catch (err) {
      if (disposed) return;
      clear(results);
      results.appendChild(h('li.chatv__picker-empty.is-danger', null, text(`Suche nicht möglich: ${errorMessage(err)}`)));
    }
  }, 200);

  /* ------------------------------ thread ---------------------------- */

  function renderThread() {
    if (!state.chatId || !state.chat) {
      clear(dom.threadInner);
      dom.threadInner.appendChild(renderEmptyState());
      return;
    }

    const rows = [
      ...state.messages.map((record) => ({ kind: 'message', id: record.id, record })),
      ...state.notices.map((notice) => ({ kind: 'notice', id: notice.id, notice })),
    ];

    if (!rows.length) {
      clear(dom.threadInner);
      dom.threadInner.appendChild(renderEmptyState());
      return;
    }

    list(dom.threadInner, uniqueById(rows, (row) => row.id), (row) => row.id, (row, existing) => (
      row.kind === 'notice' ? renderNotice(row.notice, existing) : renderMessage(row.record, existing)
    ));
  }

  function messageSignature(record) {
    const data = dataOf(record);
    return [
      record.rev,
      data.status,
      String(data.content || '').length,
      data.usedNetwork ? '1' : '0',
      (data.networkTargets || []).join(','),
      data.error ? data.error.code : '',
      data.stats ? `${data.stats.ms || ''}/${data.stats.promptTokens || ''}/${data.stats.completionTokens || ''}` : '',
    ].join('|');
  }

  function renderMessage(record, existing) {
    const signature = messageSignature(record);
    const cached = messageNodes.get(record.id);
    if (existing && cached && cached.signature === signature) return existing;

    const data = dataOf(record);
    const role = data.role || 'assistant';
    const failed = data.status === 'failed';
    const aborted = data.status === 'aborted';
    const streaming = data.status === 'streaming';

    const node = existing || h('article.msg', { 'data-id': record.id });
    clear(node);
    node.className = `msg msg--${role}`;
    if (failed) node.classList.add('msg--failed');
    if (streaming) node.classList.add('msg--streaming');

    const header = h('div.msg__head', null,
      h('span.msg__role', null, text(ROLE_LABEL[role] || role)),
      h('span.msg__time.meta', { title: formatDateTime(record.createdAt) }, text(timeAgo(record.createdAt))));
    node.appendChild(header);

    const content = String(data.content || '');
    if (content) {
      const body = h('div.msg__body');
      if (role === 'user') {
        // The user's own text is shown as typed -- rendering it as Markdown
        // would silently change what they see they wrote.
        body.classList.add('msg__body--plain');
        body.appendChild(text(content));
      } else {
        // No wiki resolver here on purpose: the chat view does not hold a
        // title index, so it must not claim a link is broken. The default
        // target is a search for the name, which is true in either case.
        body.appendChild(renderMarkdown(content));
      }
      node.appendChild(body);
    }

    if (streaming) {
      node.appendChild(h('div.msg__streaming.meta', null,
        h('span.chatv__dot', { 'aria-hidden': 'true' }),
        text(content ? 'schreibt …' : 'denkt nach …')));
    }

    if (failed) {
      node.appendChild(renderMessageError(record, data));
    } else if (aborted) {
      // An abort is not a failure: the partial text is real and stays, and the
      // row says so instead of dressing it up as a complete answer.
      node.appendChild(h('p.msg__notice.meta', null,
        text('Diese Antwort wurde abgebrochen. Der bis dahin erzeugte Text bleibt erhalten.')));
    }

    if (role === 'assistant' && !streaming) node.appendChild(renderMeta(record, data));
    if (!streaming && content) node.appendChild(renderMessageActions(record));

    messageNodes.set(record.id, { node, signature });
    return node;
  }

  function renderMessageError(record, data) {
    const error = data.error || {};
    return h('div.msg__error', { role: 'alert' },
      h('p.msg__error-title', null, text('Diese Antwort ist fehlgeschlagen.')),
      h('p.msg__error-text', null, text(error.message || 'Kein Grund übermittelt.')),
      h('p.msg__error-code.meta', null, text(`Fehlercode: ${error.code || 'unbekannt'}`)),
      error.code === 'NO_MODEL_AVAILABLE'
        ? h('div.msg__error-actions', null,
          h('button.btn.btn--small', { type: 'button', onClick: () => refreshModels() }, text('Modelle neu suchen')),
          h('button.btn.btn--small', { type: 'button', onClick: () => ctx.navigate('#/settings') }, text('Zu den Einstellungen')))
        : h('div.msg__error-actions', null,
          h('button.btn.btn--small', { type: 'button', onClick: () => retry(record) }, text('Frage erneut senden'))));
  }

  /**
   * The honesty row. Everything here is read from the stored record; a value
   * the backend did not report is labelled as not reported, never estimated.
   */
  function renderMeta(record, data) {
    const row = h('div.msg__meta');
    const model = modelRefOf(record);

    row.appendChild(h('span.badge', { title: 'Das Modell, das diese Antwort erzeugt hat' },
      text(model ? `${model.model || 'unbekannt'}${model.provider ? ` · ${model.provider}` : ''}` : 'Modell nicht vermerkt')));

    const stats = data.stats || {};
    const duration = formatDuration(stats.ms);
    row.appendChild(h('span.badge', { title: 'Dauer laut Modell-Backend' },
      text(duration ? `Dauer ${duration}` : 'Dauer nicht gemeldet')));

    const prompt = Number(stats.promptTokens);
    const completion = Number(stats.completionTokens);
    if (Number.isFinite(prompt) || Number.isFinite(completion)) {
      const total = (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0);
      row.appendChild(h('span.badge', {
        title: `Eingabe: ${Number.isFinite(prompt) ? formatNumber(prompt) : '?'} · Ausgabe: ${Number.isFinite(completion) ? formatNumber(completion) : '?'}`,
      }, text(`${formatNumber(total)} Token`)));
    } else {
      row.appendChild(h('span.badge.is-muted', { title: 'Dieses Backend meldet keine Tokenzahlen.' }, text('Token nicht gemeldet')));
    }

    row.appendChild(renderNetworkBadge(data));
    return row;
  }

  /**
   * The badge that must never be wrong: did this answer cause traffic that
   * left the machine? `usedNetwork` is set by the chat service from the gate's
   * own decisions, and loopback deliberately does not count as network use.
   */
  function renderNetworkBadge(data) {
    const targets = Array.isArray(data.networkTargets) ? data.networkTargets : [];
    if (data.usedNetwork === true) {
      return h('span.badge.msg__net', {
        'data-net': 'online',
        title: `Diese Antwort hat das Gerät verlassen. Ziele: ${targets.join(', ') || 'unbekannt'}`,
      }, text(`Netz genutzt${targets.length ? `: ${targets.join(', ')}` : ''}`));
    }
    const local = targets.length ? ` · Modell auf ${targets.join(', ')}` : '';
    return h('span.badge.msg__net', {
      'data-net': 'offline',
      title: 'Es ging nichts an einen anderen Rechner. Verbindungen zu 127.0.0.1 sind dieses Gerät selbst.',
    }, text(`Kein Netzverkehr${local}`));
  }

  function renderMessageActions(record) {
    return h('div.msg__actions', null,
      h('button.btn.btn--ghost.btn--small', {
        type: 'button',
        onClick: () => saveAsNote(record),
        title: 'Legt eine Notiz mit diesem Text an und verknüpft sie mit dem Chat',
      }, text('Als Notiz speichern')),
      h('button.btn.btn--ghost.btn--small', {
        type: 'button',
        onClick: () => copyMessage(record),
      }, text('Kopieren')));
  }

  function renderNotice(notice, existing) {
    const node = existing || h('div.msg.msg--notice');
    clear(node);
    node.classList.toggle('msg--notice-error', !!notice.error);
    node.appendChild(h('span.msg__role', null, text(notice.error ? 'Fehler' : 'Hinweis')));
    node.appendChild(h('p.msg__notice-text', null, text(notice.message)));
    if (notice.error && notice.error.code) {
      node.appendChild(h('p.meta', null, text(`Fehlercode: ${notice.error.code}`)));
    }
    return node;
  }

  function renderEmptyState() {
    const models = state.models;
    const noModel = models && !models.unavailable && models.available === false;

    if (state.chatError) {
      return h('div.empty', null,
        h('h3', null, text('Dieser Chat konnte nicht geladen werden')),
        h('p', null, text(errorMessage(state.chatError))),
        h('button.btn', { type: 'button', onClick: () => selectChat(state.chatId) }, text('Erneut versuchen')));
    }

    if (noModel) return renderNoModelPanel(models);

    if (!state.chatId) {
      return h('div.empty', null,
        h('h3', null, text('Noch keine Unterhaltung')),
        h('p', null, text('Alles, was du hier schreibst, bleibt auf diesem Gerät.')),
        h('button.btn.btn--primary', { type: 'button', onClick: () => createChat() }, text('Neuen Chat beginnen')));
    }

    return h('div.empty', null,
      h('h3', null, text('Stell deine erste Frage')),
      h('p', null, text('Der Verlauf dieses Chats wird lokal gespeichert und in den Wissensgraphen aufgenommen.')),
      models && models.unavailable
        ? h('p.meta', null, text(`Modellstatus zurzeit unbekannt: ${models.error}`))
        : null);
  }

  /**
   * What to do when there is no model. Concrete commands beat "kein Modell
   * gefunden", and the list of probed endpoints turns a dead end into a
   * diagnosis the user can act on.
   */
  function renderNoModelPanel(models) {
    const probed = Array.isArray(models.providers) ? models.providers : [];
    const panel = h('div.chatv__setup.card', null,
      h('div.card__body', null,
        h('h3', null, text('Es ist kein lokales Modell erreichbar')),
        h('p', null, text(
          'Neural OS erfindet keine Antworten. Ohne ein Modell auf diesem Gerät bleibt der Chat leer – '
          + 'das ist kein Fehler der Anwendung, sondern der ehrliche Zustand.',
        )),
        h('h4', null, text('Ollama einrichten (einmalig)')),
        h('ol.chatv__steps', null,
          h('li', null,
            text('Installieren – unter Linux: '),
            h('code.md-inline-code', null, text('curl -fsSL https://ollama.com/install.sh | sh')),
            text(' · unter macOS oder Windows das Installationsprogramm von ollama.com. Dieser Schritt braucht einmalig Internet.')),
          h('li', null,
            text('Ein Modell laden: '),
            h('code.md-inline-code', null, text('ollama pull llama3.2')),
            text(' (rund 2 GB).')),
          h('li', null,
            text('Fertig: Ollama lauscht auf '),
            h('code.md-inline-code', null, text('127.0.0.1:11434')),
            text(' und wird hier automatisch gefunden. Ab dann läuft der Chat vollständig ohne Internet.'))),
        probed.length
          ? h('div.chatv__probed', null,
            h('h4', null, text('Geprüft wurde')),
            h('ul.chatv__probed-list', null, ...probed.map((provider) => h('li', null,
              h('code.md-inline-code', null, text(provider.baseUrl || provider.id || '?')),
              text(' – '),
              text(provider.available ? 'erreichbar, aber ohne Modelle' : (provider.error || 'nicht erreichbar'))))))
          : null,
        h('div.row', null,
          h('button.btn.btn--primary', { type: 'button', onClick: () => refreshModels() }, text('Erneut suchen')),
          h('button.btn', { type: 'button', onClick: () => ctx.navigate('#/settings') }, text('Zu den Einstellungen')))));
    return panel;
  }

  async function refreshModels() {
    ctx.toast('Modelle werden gesucht …', 'info', { timeout: 2500 });
    try {
      const response = await api.post('/models/refresh', {}, { timeoutMs: 25000 });
      if (disposed) return;
      state.models = response;
      const count = (Array.isArray(response.providers) ? response.providers : [])
        .reduce((sum, provider) => sum + (Array.isArray(provider.models) ? provider.models.length : 0), 0);
      ctx.toast(count ? `${formatNumber(count)} Modell(e) gefunden.` : 'Weiterhin kein Modell erreichbar.', count ? 'success' : 'error');
      renderControls();
      renderThread();
      renderBanner();
    } catch (err) {
      ctx.toast(`Suche fehlgeschlagen: ${errorMessage(err)}`, 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Zwei Modelle, eine Antwort                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Forget the current comparison, stopping it first if it runs. Called when
   * the conversation changes and when the view goes away -- two models
   * generating for a screen nobody is looking at is wasted local CPU.
   */
  function resetCompare(keepOpen = true) {
    if (compareController) {
      try { compareController.abort(); } catch { /* already done */ }
      compareController = null;
    }
    if (comparePaintTimer) {
      clearTimeout(comparePaintTimer);
      comparePaintTimer = null;
    }
    const cmp = state.compare;
    cmp.open = keepOpen ? cmp.open : false;
    cmp.plan = null;
    cmp.planError = null;
    cmp.consentFor = '';
    cmp.running = false;
    cmp.aborting = false;
    cmp.sides = null;
    cmp.saved = null;
    cmp.prompt = '';
    if (cmp.open) loadComparePlan();
  }

  function toggleCompare() {
    const cmp = state.compare;
    if (cmp.open && cmp.running) {
      ctx.toast('Der Vergleich läuft noch. Brich ihn ab, bevor du das Feld schließt.', 'info');
      return;
    }
    cmp.open = !cmp.open;
    if (cmp.open && !cmp.plan && !cmp.planLoading) {
      // Preselect the chat's own model for the left side; the right side stays
      // on "Standard" until the user picks, because guessing a second model
      // would be the interface choosing where the text goes.
      const own = modelRefOf(state.chat);
      if (own && own.provider) cmp.a = `${own.provider}/${own.model}`;
      loadComparePlan();
    }
    renderControls();
    renderCompare();
    renderComposer();
  }

  /** Model options, shared by both side selects. Built from the last probe. */
  function compareOptions(selectEl, value) {
    selectEl.appendChild(h('option', { value: '' }, text('Standard (erstes erreichbares)')));
    const providers = (state.models && Array.isArray(state.models.providers)) ? state.models.providers : [];
    let known = !value;
    for (const provider of providers) {
      const models = Array.isArray(provider.models) ? provider.models : [];
      if (!provider.available || !models.length) continue;
      const group = h('optgroup', { label: provider.id || provider.kind });
      for (const model of models) {
        const optionValue = `${provider.id}/${model.id}`;
        if (optionValue === value) known = true;
        group.appendChild(h('option', { value: optionValue }, text(model.name || model.id)));
      }
      selectEl.appendChild(group);
    }
    if (value && !known) {
      selectEl.appendChild(h('option', { value }, text(`${value} (zurzeit nicht erreichbar)`)));
    }
    selectEl.value = value;
  }

  const loadComparePlan = debounce(async () => {
    const cmp = state.compare;
    if (!cmp.open) return;
    cmp.planLoading = true;
    cmp.planError = null;
    renderCompare();
    try {
      const response = await api.post('/compare/plan', {
        chatId: state.chatId || null,
        a: cmp.a || null,
        b: cmp.b || null,
      });
      if (disposed) return;
      cmp.plan = (response && response.plan) || null;
      // A consent always belongs to exactly one plan. If the new plan sends to
      // a different place, the old "yes" is worthless and is dropped here.
      if (cmp.consentFor && cmp.consentFor !== consentKey(cmp.plan)) cmp.consentFor = '';
    } catch (err) {
      if (disposed) return;
      cmp.plan = null;
      cmp.consentFor = '';
      cmp.planError = err;
    } finally {
      if (!disposed) {
        cmp.planLoading = false;
        renderCompare();
        renderComposer();
      }
    }
  }, 250);

  function setCompareSide(side, value) {
    state.compare[side] = value;
    state.compare.consentFor = '';
    state.compare.plan = null;
    loadComparePlan();
    renderCompare();
    renderComposer();
  }

  /** True when the plan is known, needs no consent, or has it for this plan. */
  function compareReady() {
    const cmp = state.compare;
    if (!cmp.plan || cmp.planLoading) return false;
    if (!cmp.plan.a.modell && !cmp.plan.b.modell) return false;
    if (!cmp.plan.zustimmungNoetig) return true;
    return cmp.consentFor === consentKey(cmp.plan);
  }

  async function runCompare() {
    const cmp = state.compare;
    if (cmp.running) return;
    const prompt = dom.composerInput.value.trim();
    if (!prompt) {
      ctx.toast('Schreibe zuerst eine Frage in das Feld unten.', 'info');
      dom.composerInput.focus();
      return;
    }
    if (!compareReady()) {
      ctx.toast(cmp.plan && cmp.plan.zustimmungNoetig
        ? 'Bestätige zuerst, dass die Frage dieses Gerät verlassen darf.'
        : 'Der Plan liegt noch nicht vor.', 'info');
      return;
    }

    cmp.prompt = prompt;
    cmp.running = true;
    cmp.aborting = false;
    cmp.saved = null;
    cmp.sides = {
      a: { seite: 'a', text: '', status: 'running', modell: cmp.plan.a.modell, ort: cmp.plan.a.ort, ergebnis: null },
      b: { seite: 'b', text: '', status: 'running', modell: cmp.plan.b.modell, ort: cmp.plan.b.ort, ergebnis: null },
    };
    compareController = new AbortController();
    renderCompare();
    renderComposer();

    let paintQueued = false;
    const paint = () => {
      if (paintQueued) return;
      paintQueued = true;
      comparePaintTimer = setTimeout(() => {
        paintQueued = false;
        comparePaintTimer = null;
        if (disposed) return;
        // Only the two text bodies are touched while tokens arrive. Rebuilding
        // the whole panel ten times a second would throw away its scroll
        // position, and a panel that jumps back to the top while you read it
        // is a panel you cannot read.
        if (!paintCompareText()) renderCompare();
      }, COMPARE_PAINT_MS);
    };

    try {
      await api.stream('/compare', {
        body: { chatId: state.chatId || null, prompt, a: cmp.a || null, b: cmp.b || null },
        signal: compareController.signal,
        onEvent: (event) => {
          const payload = (event && event.payload) || {};
          const type = (event && event.type) || payload.type;
          if (type === 'plan' && payload.plan) {
            // The server has the last word on where this went.
            cmp.plan = payload.plan;
            renderCompare();
          } else if (type === 'delta' && payload.seite && typeof payload.text === 'string') {
            const side = cmp.sides[payload.seite];
            if (side) side.text += payload.text;
            paint();
          } else if (type === 'side' && payload.seite && payload.ergebnis) {
            const side = cmp.sides[payload.seite];
            if (side) {
              side.ergebnis = payload.ergebnis;
              side.text = payload.ergebnis.text || side.text;
              side.ort = payload.ergebnis.ort || side.ort;
              side.status = payload.ergebnis.fehler ? 'failed' : 'complete';
            }
            renderCompare();
          } else if (type === 'error' && payload.error) {
            cmp.planError = new ApiError(payload.error.code, payload.error.message, { status: 0 });
          }
        },
      });
    } catch (err) {
      if (!disposed) {
        const apiError = err instanceof ApiError
          ? err
          : new ApiError('STREAM_INTERRUPTED', 'Die Verbindung zum lokalen Server ist während des Vergleichs abgerissen.', { status: 0, cause: err });
        if (!apiError.isAborted) cmp.planError = apiError;
      }
    } finally {
      if (comparePaintTimer) {
        clearTimeout(comparePaintTimer);
        comparePaintTimer = null;
      }
      compareController = null;
      if (!disposed) {
        cmp.running = false;
        cmp.aborting = false;
        for (const side of ['a', 'b']) {
          const entry = cmp.sides && cmp.sides[side];
          if (entry && entry.status === 'running') entry.status = 'unterbrochen';
        }
        renderCompare();
        renderComposer();
      }
    }
  }

  function abortCompare() {
    if (!compareController || state.compare.aborting) return;
    state.compare.aborting = true;
    // Dropping the connection is what stops both sides: the server aborts the
    // run when the stream closes (`stream.onClose`).
    compareController.abort();
    renderCompare();
    renderComposer();
  }

  async function saveCompare() {
    const cmp = state.compare;
    if (!cmp.sides || !cmp.sides.a.ergebnis || !cmp.sides.b.ergebnis) {
      ctx.toast('Es gibt noch keinen vollständigen Vergleich zum Speichern.', 'info');
      return;
    }
    try {
      const response = await api.post('/compare/save', {
        chatId: state.chatId || null,
        prompt: cmp.prompt,
        a: cmp.sides.a.ergebnis,
        b: cmp.sides.b.ergebnis,
      });
      const note = recordOf(response);
      cmp.saved = note ? note.id : null;
      renderCompare();
      ctx.toast(response && response.verknuepft
        ? 'Vergleich als Notiz gespeichert und mit diesem Chat verknüpft.'
        : 'Vergleich als Notiz gespeichert.', 'success', {
        action: note ? { label: 'Notiz öffnen', run: () => ctx.navigate(`#/notes?id=${encodeURIComponent(note.id)}`) } : undefined,
        timeout: 9000,
      });
    } catch (err) {
      ctx.toast(`Vergleich konnte nicht gespeichert werden: ${errorMessage(err)}`, 'error');
    }
  }

  /* ------------------------------ rendering ------------------------- */

  /**
   * Repaint only the streaming text of the two columns.
   *
   * @returns {boolean} false when there is nothing to paint into yet, which
   *          means the caller has to build the panel properly first.
   */
  function paintCompareText() {
    const cmp = state.compare;
    if (!cmp.sides || !dom.cmpBody || !dom.cmpBody.a || !dom.cmpBody.b) return false;
    for (const side of ['a', 'b']) {
      const entry = cmp.sides[side];
      const node = dom.cmpBody[side];
      if (!entry || !node || entry.status !== 'running') continue;
      clear(node);
      node.classList.add('cmp__body--plain');
      node.appendChild(entry.text ? text(entry.text) : h('p.meta', null, text('denkt nach …')));
    }
    return true;
  }

  function renderCompare() {
    const cmp = state.compare;
    dom.compare.hidden = !cmp.open;
    if (!cmp.open) {
      dom.cmpBody = null;
      return;
    }
    // Rebuilding drops the scroll position; while two answers stream that
    // would yank the panel back to the top under the reader's eyes.
    const scrollTop = dom.compare.scrollTop;
    dom.cmpBody = null;
    clear(dom.compare);

    const head = h('div.cmp__head', null,
      h('h3.cmp__title', null, text('Zwei Modelle, eine Antwort')),
      h('span.spacer'),
      h('button.btn.btn--ghost.btn--small', {
        type: 'button',
        onClick: () => toggleCompare(),
        disabled: cmp.running,
      }, text('Schließen')));
    dom.compare.appendChild(head);

    dom.compare.appendChild(h('p.cmp__lead.meta', null, text(
      'Dieselbe Frage geht an beide Seiten. Was du unten in das Feld schreibst, wird gesendet – '
      + 'der Vergleich landet nicht im Verlauf dieses Chats, bis du ihn speicherst.',
    )));

    /* --- Auswahl ---------------------------------------------------- */
    const selectFor = (side, label) => {
      const select = h('select.select.cmp__select', {
        'aria-label': label,
        disabled: cmp.running,
        onChange: (event) => setCompareSide(side, event.target.value),
      });
      compareOptions(select, cmp[side]);
      return h('label.cmp__field', null, h('span.meta', null, text(label)), select);
    };
    dom.compare.appendChild(h('div.cmp__picks', null, selectFor('a', 'Seite A'), selectFor('b', 'Seite B')));

    /* --- Plan ------------------------------------------------------- */
    dom.compare.appendChild(renderComparePlan());

    /* --- Antworten -------------------------------------------------- */
    if (cmp.sides) {
      dom.cmpBody = {};
      dom.compare.appendChild(h('div.cmp__grid', null,
        renderCompareSide('a', cmp.sides.a),
        renderCompareSide('b', cmp.sides.b)));

      const actions = h('div.cmp__actions');
      if (cmp.running) {
        actions.appendChild(h('button.btn.btn--danger.btn--small', {
          type: 'button',
          disabled: cmp.aborting,
          onClick: () => abortCompare(),
        }, text(cmp.aborting ? 'Wird abgebrochen …' : 'Beide abbrechen')));
      } else {
        actions.appendChild(h('button.btn.btn--small', {
          type: 'button',
          disabled: !!cmp.saved,
          title: 'Legt eine Notiz mit beiden Antworten, beiden Modellnamen und der Herkunft an',
          onClick: () => saveCompare(),
        }, text(cmp.saved ? 'Gespeichert' : 'Als Notiz speichern')));
        if (cmp.saved) {
          actions.appendChild(h('button.btn.btn--ghost.btn--small', {
            type: 'button',
            onClick: () => ctx.navigate(`#/notes?id=${encodeURIComponent(cmp.saved)}`),
          }, text('Notiz öffnen')));
        }
      }
      dom.compare.appendChild(actions);
    }

    dom.compare.scrollTop = scrollTop;
  }

  /**
   * The plan block: what would happen, in the server's own words, plus the
   * separate act of agreeing to it.
   */
  function renderComparePlan() {
    const cmp = state.compare;
    const box = h('div.cmp__plan');

    if (cmp.planError) {
      const unavailable = cmp.planError instanceof ApiError && cmp.planError.code === 'SUBSYSTEM_UNAVAILABLE';
      box.classList.add('cmp__plan--bad');
      box.appendChild(h('p.cmp__plan-line', null, text(unavailable
        ? 'Der Modellvergleich ist in dieser Installation nicht eingerichtet. Hier lässt sich zurzeit nichts vergleichen.'
        : `Der Plan konnte nicht geholt werden: ${errorMessage(cmp.planError)}`)));
      if (!unavailable) {
        box.appendChild(h('button.btn.btn--small', {
          type: 'button',
          onClick: () => loadComparePlan(),
        }, text('Erneut versuchen')));
      }
      return box;
    }

    if (cmp.planLoading && !cmp.plan) {
      box.appendChild(h('p.cmp__plan-line.meta', null, text('Der Plan wird geholt …')));
      return box;
    }
    if (!cmp.plan) {
      box.appendChild(h('p.cmp__plan-line.meta', null, text('Noch kein Plan. Wähle zwei Seiten.')));
      return box;
    }

    for (const side of ['a', 'b']) {
      const entry = cmp.plan[side];
      const line = h('p.cmp__plan-line');
      line.appendChild(h('span.badge.cmp__place', {
        'data-net': PLACE_NET[entry.ort] || 'unknown',
        title: `Seite ${side.toUpperCase()} läuft ${PLACE_LABEL[entry.ort] || entry.ort}`,
      }, text(`Seite ${side.toUpperCase()}`)));
      // The sentence is the server's, verbatim: it knows what the gate decided.
      line.appendChild(text(` ${entry.hinweis}`));
      box.appendChild(line);
    }

    if (cmp.plan.hinweis) {
      box.appendChild(h('p.cmp__plan-sum', {
        class: cmp.plan.verlaesstGeraet ? 'is-leaving' : '',
      }, text(cmp.plan.hinweis)));
    }

    if (cmp.plan.zustimmungNoetig) {
      const agreed = cmp.consentFor === consentKey(cmp.plan);
      const hosts = leavingHosts(cmp.plan);
      box.appendChild(h('div.cmp__consent', null,
        h('button.btn.btn--small.cmp__consent-btn', {
          type: 'button',
          'aria-pressed': agreed ? 'true' : 'false',
          class: agreed ? 'is-active' : '',
          disabled: cmp.running,
          onClick: () => {
            cmp.consentFor = agreed ? '' : consentKey(cmp.plan);
            renderCompare();
            renderComposer();
          },
        }, text(agreed
          ? `Erlaubt: an ${hosts.join(' und ')}`
          : `Ja, an ${hosts.join(' und ')} senden`)),
        h('span.meta', null, text(agreed
          ? 'Gilt nur für genau diese Auswahl. Änderst du ein Modell, wird erneut gefragt.'
          : 'Ohne diese Bestätigung wird nichts gesendet.'))));
    }

    return box;
  }

  /** One column. Every badge under it comes from the server's own record. */
  function renderCompareSide(side, entry) {
    const column = h('article.cmp__side', { 'data-seite': side });
    const result = entry.ergebnis;
    const model = entry.modell;

    column.appendChild(h('header.cmp__side-head', null,
      h('span.cmp__side-name', null, text(model ? model.model : `Seite ${side.toUpperCase()}`)),
      h('span.badge.cmp__place', {
        'data-net': PLACE_NET[entry.ort] || 'unknown',
      }, text(PLACE_LABEL[entry.ort] || 'Herkunft unbekannt'))));

    if (model) {
      column.appendChild(h('p.cmp__side-sub.meta', null,
        text(`${model.provider} · ${model.host}`)));
    }

    const body = h('div.cmp__body');
    if (entry.status === 'running' && !entry.text) {
      body.appendChild(h('p.meta', null, text('denkt nach …')));
    } else if (entry.status === 'running') {
      // While it streams the text stays plain: re-parsing Markdown per token
      // would fight the throttle for no gain, and half-written syntax renders
      // as nonsense anyway.
      body.classList.add('cmp__body--plain');
      body.appendChild(text(entry.text));
    } else if (entry.text) {
      body.appendChild(renderMarkdown(entry.text));
    } else if (!result || !result.fehler) {
      body.appendChild(h('p.meta', null, text('Diese Seite hat keinen Text geliefert.')));
    }
    if (dom.cmpBody) dom.cmpBody[side] = body;
    column.appendChild(body);

    if (result && result.fehler) {
      column.appendChild(h('div.cmp__error', { role: 'alert' },
        h('p.cmp__error-title', null, text(result.abgebrochen
          ? 'Diese Seite wurde abgebrochen.'
          : 'Diese Seite ist fehlgeschlagen.')),
        h('p.cmp__error-text', null, text(result.fehler.message)),
        h('p.meta', null, text(`Fehlercode: ${result.fehler.code}`))));
    } else if (entry.status === 'unterbrochen') {
      column.appendChild(h('p.cmp__error-text.is-danger', null,
        text('Die Verbindung endete, bevor diese Seite fertig war. Was oben steht, ist alles, was ankam.')));
    }

    if (result) column.appendChild(renderCompareMeta(result));
    return column;
  }

  /**
   * The honesty row of one column. Duration and tokens are whatever the
   * backend reported; where it reported nothing, that is what is written.
   * `usedNetwork` is the server's observation of the gate, not our guess.
   */
  function renderCompareMeta(result) {
    const row = h('div.cmp__meta');
    const duration = formatDuration(result.ms);
    row.appendChild(h('span.badge', { title: 'Gemessen von der Frage bis zur letzten Zeile' },
      text(duration ? `Dauer ${duration}` : 'Dauer nicht gemeldet')));

    const tokens = result.tokens || {};
    const prompt = Number(tokens.prompt);
    const completion = Number(tokens.completion);
    if (Number.isFinite(prompt) || Number.isFinite(completion)) {
      const total = (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0);
      row.appendChild(h('span.badge', {
        title: `Eingabe: ${Number.isFinite(prompt) ? formatNumber(prompt) : '?'} · Ausgabe: ${Number.isFinite(completion) ? formatNumber(completion) : '?'}`,
      }, text(`${formatNumber(total)} Token`)));
    } else {
      row.appendChild(h('span.badge.is-muted', { title: 'Dieses Backend meldet keine Tokenzahlen.' },
        text('Token nicht gemeldet')));
    }

    const targets = Array.isArray(result.networkTargets) ? result.networkTargets : [];
    if (result.netzBeobachtet === false) {
      row.appendChild(h('span.badge.cmp__net', {
        'data-net': 'unknown',
        title: 'Auf diesem Server konnte der Netzverkehr nicht beobachtet werden.',
      }, text('Netznutzung nicht beobachtbar')));
    } else if (result.usedNetwork === true) {
      row.appendChild(h('span.badge.cmp__net', {
        'data-net': 'online',
        title: `Diese Antwort hat das Gerät verlassen. Ziele: ${targets.join(', ') || 'unbekannt'}`,
      }, text(`Netz genutzt${targets.length ? `: ${targets.join(', ')}` : ''}`)));
    } else {
      row.appendChild(h('span.badge.cmp__net', {
        'data-net': 'offline',
        title: 'Es ging nichts an einen anderen Rechner. Verbindungen zu 127.0.0.1 sind dieses Gerät selbst.',
      }, text(`Kein Netzverkehr${targets.length ? ` · Modell auf ${targets.join(', ')}` : ''}`)));
    }
    return row;
  }

  /* ----------------------------- composer --------------------------- */

  function renderComposer() {
    const streaming = !!streamFor(state.chatId);
    const entry = streamFor(state.chatId);
    const empty = !dom.composerInput.value.trim();

    dom.composerInput.disabled = !state.chatId;
    dom.sendButton.hidden = streaming;
    dom.sendButton.disabled = empty || !state.chatId;
    dom.abortButton.hidden = !streaming;
    dom.abortButton.disabled = !!(entry && entry.aborting);
    clear(dom.abortButton);
    dom.abortButton.appendChild(text(entry && entry.aborting ? 'Wird abgebrochen …' : 'Abbrechen'));

    const cmp = state.compare;
    dom.compareSend.hidden = !cmp.open || streaming;
    dom.compareSend.disabled = empty || !state.chatId || cmp.running || !compareReady();
    clear(dom.compareSend);
    dom.compareSend.appendChild(text(cmp.running ? 'Beide antworten …' : 'An beide senden'));
    dom.compareSend.title = cmp.running
      ? 'Der Vergleich läuft.'
      : (compareReady()
        ? 'Schickt genau diesen Text an beide Seiten'
        : 'Erst muss der Plan da sein – und, wenn etwas das Gerät verlässt, deine Bestätigung.');

    clear(dom.composerHint);
    const length = dom.composerInput.value.length;
    if (!state.chatId) {
      dom.composerHint.appendChild(text('Wähle links einen Chat oder beginne einen neuen.'));
    } else if (cmp.running) {
      dom.composerHint.appendChild(text('Beide Seiten antworten. „Beide abbrechen“ stoppt sie; der Text bis dahin bleibt stehen.'));
    } else if (streaming) {
      dom.composerHint.appendChild(text('Das Modell antwortet. Esc oder „Abbrechen“ stoppt es; der Text bis dahin bleibt erhalten.'));
    } else if (length > MAX_CONTENT_CHARS * 0.9) {
      dom.composerHint.appendChild(text(`${formatNumber(length)} von ${formatNumber(MAX_CONTENT_CHARS)} Zeichen.`));
    } else if (length) {
      dom.composerHint.appendChild(text('Enter sendet · Umschalt+Enter neue Zeile · Entwurf wird gesichert'));
    } else {
      dom.composerHint.appendChild(text('Enter sendet · Umschalt+Enter neue Zeile'));
    }
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 320)}px`;
  }

  function scrollToEnd(force) {
    if (!force && !state.stick) return;
    // rAF: the nodes were just inserted, their height is not settled yet.
    window.requestAnimationFrame(() => {
      if (disposed) return;
      dom.thread.scrollTop = dom.thread.scrollHeight;
    });
  }

  /* ---------------------------------------------------------------- */

  function destroy() {
    disposed = true;
    detachStream();
    if (paintTimer) clearTimeout(paintTimer);
    // Unlike a chat answer, a comparison does NOT outlive the view: nothing
    // stores it, so a result nobody can see is only two models burning CPU.
    resetCompare(false);
    loadComparePlan.cancel();
    reloadMessagesSoon.cancel();
    reloadChatsSoon.cancel();
    searchMessages.cancel();
    runPickerSearch.cancel();
    for (const off of cleanups) {
      try {
        off();
      } catch (err) {
        console.error('[neural-os] Chat-Aufräumen fehlgeschlagen:', err);
      }
    }
    cleanups.length = 0;
    // The running stream is deliberately NOT aborted here: see the header.
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
  style.textContent = CHAT_CSS;
  document.head.appendChild(style);
}

const CHAT_CSS = `
.chatv {
  display: grid;
  grid-template-columns: minmax(200px, 300px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.chatv__side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}
.chatv__side-head { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2); }
.chatv__list { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 0 var(--sp-1); list-style: none; }
.chatv__side-foot { padding: var(--sp-1) var(--sp-2); border-top: 1px solid var(--border); }
.chatv__row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: var(--r-2);
}
.chatv__row:hover { background: var(--surface-3); }
.chatv__row.is-active { background: var(--accent-soft); }
.chatv__row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--sp-1);
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;
}
.chatv__row-title { display: flex; align-items: center; gap: 4px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chatv__pin { color: var(--accent); }
.chatv__row-meta, .chatv__row-hit { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chatv__row-actions { display: none; gap: 0; padding-right: 2px; }
.chatv__row:hover .chatv__row-actions, .chatv__row.is-active .chatv__row-actions { display: flex; }
.chatv__row-actions .icon-button { width: 26px; height: 26px; min-height: 0; }
.chatv__rename { margin: var(--sp-05); }
.chatv__main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.chatv__head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.chatv__head-main { min-width: 0; }
.chatv__title { font-size: var(--fs-md); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chatv__controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); margin-left: auto; }
.chatv__select { width: auto; max-width: 220px; padding: 4px var(--sp-1); font-size: var(--fs-sm); }
.chatv__net .segmented__option[data-net="online"].is-active { color: var(--net-online); }
.chatv__net .segmented__option[data-net="lan"].is-active { color: var(--net-lan); }
.chatv__net .segmented__option[data-net="offline"].is-active { color: var(--net-offline); }
.chatv__context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.chatv__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 260px;
  padding: 2px 4px 2px 10px;
  font-size: var(--fs-sm);
  background: var(--surface-3);
  border-radius: var(--r-full);
}
.chatv__chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chatv__chip-remove { background: none; border: 0; cursor: pointer; color: var(--fg-muted); padding: 0 4px; }
.chatv__chip-remove:hover { color: var(--danger); }
.chatv__picker { padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border); background: var(--surface); }
.chatv__picker-head { display: flex; gap: var(--sp-1); }
.chatv__picker-list { max-height: 240px; overflow-y: auto; margin: var(--sp-1) 0 0; padding: 0; list-style: none; }
.chatv__picker-item {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-1);
  width: 100%;
  padding: 6px var(--sp-1);
  text-align: left;
  background: none;
  border: 0;
  border-radius: var(--r-1);
  cursor: pointer;
}
.chatv__picker-item:hover { background: var(--surface-3); }
.chatv__picker-empty { padding: var(--sp-1); }
.chatv__thread-wrap { position: relative; flex: 1; min-height: 0; }
.chatv__thread { height: 100%; overflow-y: auto; scroll-behavior: auto; }
.chatv__thread-inner { display: flex; flex-direction: column; gap: var(--sp-2); max-width: var(--content-max); margin: 0 auto; padding: var(--sp-3) var(--sp-2); }
.chatv__jump { position: absolute; right: var(--sp-2); bottom: var(--sp-2); box-shadow: var(--shadow-2); }
.msg { display: flex; flex-direction: column; gap: var(--sp-05); }
.msg__head { display: flex; align-items: baseline; gap: var(--sp-1); }
.msg__role { font-size: var(--fs-sm); font-weight: 600; color: var(--fg-muted); }
.msg--user .msg__role { color: var(--accent); }
.msg__body {
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  overflow-wrap: anywhere;
}
.msg__body--plain { white-space: pre-wrap; background: var(--accent-soft); border-color: transparent; }
.msg--failed .msg__body { border-color: var(--danger); }
.msg__meta { display: flex; flex-wrap: wrap; gap: var(--sp-05); }
.msg__net[data-net="offline"] { color: var(--net-offline); background: transparent; border: 1px solid var(--net-offline); }
.msg__net[data-net="online"] { color: var(--net-online); background: transparent; border: 1px solid var(--net-online); font-weight: 600; }
.msg__actions { display: flex; gap: var(--sp-05); }
.msg__error {
  padding: var(--sp-1) var(--sp-2);
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--r-2);
}
.msg__error-title { margin: 0; font-weight: 600; }
.msg__error-text { margin: var(--sp-05) 0; color: var(--fg); }
.msg__error-code { margin: 0; }
.msg__error-actions { display: flex; gap: var(--sp-05); margin-top: var(--sp-1); }
.msg__notice, .msg__notice-text { margin: 0; }
.msg--notice {
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-2);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-2);
}
.msg--notice-error { border-color: var(--danger); color: var(--danger); }
.msg__streaming { display: flex; align-items: center; gap: 6px; }
.chatv__dot { width: 7px; height: 7px; border-radius: var(--r-full); background: var(--accent); animation: nos-chat-pulse 1.1s ease-in-out infinite; }
@keyframes nos-chat-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.chatv__composer { padding: var(--sp-1) var(--sp-2) var(--sp-2); border-top: 1px solid var(--border); background: var(--surface); }
.chatv__input {
  width: 100%;
  max-height: 320px;
  min-height: 40px;
  padding: var(--sp-1);
  font-family: inherit;
  line-height: var(--lh);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  resize: none;
  overflow-y: auto;
}
.chatv__input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.chatv__composer-row { display: flex; align-items: center; gap: var(--sp-1); margin-top: var(--sp-1); }
.chatv__list-toggle { display: none; }
.chatv__banner {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  background: var(--danger-soft);
  border-top: 1px solid var(--danger);
}
.chatv__setup { max-width: 640px; margin: 0 auto; }
.chatv__steps { margin: 0 0 var(--sp-2); padding-left: var(--sp-3); }
.chatv__steps li { margin-bottom: var(--sp-1); }
.chatv__probed-list { margin: 0 0 var(--sp-2); padding-left: var(--sp-3); font-size: var(--fs-sm); color: var(--fg-muted); }
/* The confirmation dialog for network changes is written in paragraphs; the
   shell renders it as one text node, so the line breaks need to survive. */
.dialog__text { white-space: pre-line; }

/* --- Zwei Modelle, eine Antwort ------------------------------------- */
.chatv__controls .btn.is-active { color: var(--accent); border-color: var(--accent); }
.cmp {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  /* Der Verlauf darüber bleibt sichtbar und scrollt weiter; dieses Feld hat
     seinen eigenen Rollbalken, damit zwei lange Antworten den Chat nicht
     verdrängen. */
  max-height: 62vh;
  overflow-y: auto;
  padding: var(--sp-1) var(--sp-2);
  border-top: 1px solid var(--border-strong);
  background: var(--surface-2);
}
.cmp__head { display: flex; align-items: center; gap: var(--sp-1); }
.cmp__title { margin: 0; font-size: var(--fs-md); }
.cmp__lead { margin: 0; }
.cmp__picks { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.cmp__field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cmp__select { max-width: 260px; padding: 4px var(--sp-1); font-size: var(--fs-sm); }
.cmp__plan {
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  padding: var(--sp-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.cmp__plan--bad { border-color: var(--danger); }
.cmp__plan-line { margin: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.cmp__plan-sum { margin: 0; font-size: var(--fs-sm); font-weight: 500; overflow-wrap: anywhere; }
.cmp__plan-sum.is-leaving {
  padding: var(--sp-05) var(--sp-1);
  color: var(--warn);
  border-left: 3px solid var(--warn);
  background: var(--surface-2);
  border-radius: var(--r-1);
}
.cmp__consent { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); margin-top: var(--sp-05); }
.cmp__consent-btn.is-active { color: var(--ok); border-color: var(--ok); }
/* auto-fit, not a media query: the columns stack when this panel is narrow,
   whatever the window is doing around it. */
.cmp__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--sp-1); }
.cmp__side {
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  min-width: 0;
  padding: var(--sp-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.cmp__side-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-05); }
.cmp__side-name { font-weight: 600; overflow-wrap: anywhere; }
.cmp__side-sub { margin: 0; overflow-wrap: anywhere; }
.cmp__body { min-width: 0; overflow-wrap: anywhere; }
.cmp__body--plain { white-space: pre-wrap; }
.cmp__meta { display: flex; flex-wrap: wrap; gap: var(--sp-05); margin-top: auto; padding-top: var(--sp-05); }
.cmp__error {
  padding: var(--sp-05) var(--sp-1);
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--r-1);
}
.cmp__error-title { margin: 0; font-weight: 600; font-size: var(--fs-sm); }
.cmp__error-text { margin: 2px 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.cmp__actions { display: flex; flex-wrap: wrap; gap: var(--sp-05); }
.cmp__place[data-net="offline"], .cmp__net[data-net="offline"] {
  color: var(--net-offline); background: transparent; border: 1px solid var(--net-offline);
}
.cmp__place[data-net="lan"], .cmp__net[data-net="lan"] {
  color: var(--net-lan); background: transparent; border: 1px solid var(--net-lan);
}
.cmp__place[data-net="online"], .cmp__net[data-net="online"] {
  color: var(--net-online); background: transparent; border: 1px solid var(--net-online); font-weight: 600;
}
.cmp__place[data-net="unknown"], .cmp__net[data-net="unknown"] {
  color: var(--net-unknown); background: transparent; border: 1px solid var(--net-unknown);
}
@media (max-width: 820px) {
  .chatv { grid-template-columns: minmax(0, 1fr); position: relative; }
  .chatv__side { display: none; }
  .chatv--list .chatv__side {
    display: flex;
    position: absolute;
    inset: 0;
    z-index: 2;
    border-right: 0;
    background: var(--surface);
  }
  .chatv__list-toggle { display: inline-flex; }
  .chatv__head { flex-wrap: wrap; }
  .chatv__controls { width: 100%; margin-left: 0; }
  .chatv__select { max-width: 150px; }
}
`;
