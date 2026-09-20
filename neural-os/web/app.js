/**
 * app.js -- the application shell: router, state, live events, chrome.
 *
 * What this file owns, and why it is built the way it is:
 *
 * - **The truth indicator.** The header shows network mode, model status and
 *   vault state, and every one of those values comes from `/api/status`.
 *   When the status cannot be read, the indicator says "unbekannt" rather
 *   than keeping the last comfortable answer on screen. An indicator that
 *   guesses is worse than none: it teaches the user to trust a guess.
 * - **Views are independent and may be missing.** Each view lives in its own
 *   module and is imported on demand from a fixed allow-list (never from the
 *   URL hash directly). A module that fails to load produces an error panel
 *   with a retry, never a blank page -- these modules are built separately and
 *   any of them can be absent in a partial installation.
 * - **One event stream.** All live updates come from the server bus over a
 *   single SSE connection with since-seq replay. There is no second code path
 *   that updates the screen without a real server event behind it, which is
 *   what keeps the UI from drifting away from what actually happened.
 * - **No inline script anywhere.** The server sends `script-src 'self'`, so
 *   even the theme bootstrap has to happen here rather than in index.html.
 *   The cost is a few milliseconds of default theme before the stored
 *   preference applies; the benefit is that the CSP needs no exception.
 */

import { h, text, clear, on, list, icon, cx, frag, timeAgo, formatNumber, debounce, snippet } from './lib/dom.js';
import { api, ApiError } from './lib/api.js';

const APP_VERSION = '1';
const STORAGE = {
  theme: 'neural-os:theme',
  onboarding: 'neural-os:onboarding',
  lastRoute: 'neural-os:last-route',
  chat: 'neural-os:active-chat',
};

/* ------------------------------------------------------------------ */
/* Iconography: inline SVG bodies, 20x20, currentColor, no asset files. */
/* ------------------------------------------------------------------ */

const ICONS = {
  brand: '<circle cx="10" cy="4.6" r="2.1"/><circle cx="4.6" cy="14.4" r="2.1"/><circle cx="15.4" cy="14.4" r="2.1"/><path d="M8.5 6.3 5.8 12.4M11.5 6.3l2.7 6.1M6.7 14.4h6.6"/>',
  chat: '<rect x="2.5" y="3.5" width="15" height="10.5" rx="3.2"/><path d="M6.6 14v3.2L10.3 14"/>',
  notes: '<rect x="4" y="2.5" width="12" height="15" rx="2.6"/><path d="M7 6.6h6M7 10h6M7 13.4h3.6"/>',
  projects: '<path d="M2.6 6.4a2 2 0 0 1 2-2h2.7l1.6 2h6.5a2 2 0 0 1 2 2v5.4a2 2 0 0 1-2 2h-10.8a2 2 0 0 1-2-2z"/>',
  graph: '<circle cx="4.6" cy="14.4" r="1.9"/><circle cx="10" cy="4.4" r="1.9"/><circle cx="15.4" cy="12.8" r="1.9"/><path d="M5.6 12.7 9 6.1M11.3 5.9l3.2 5.2M6.4 14.8l7.1-1.5"/>',
  agents: '<rect x="3.6" y="6.4" width="12.8" height="9.6" rx="3"/><path d="M10 2.8v3.6M7.6 10.8h.01M12.4 10.8h.01M7.8 13.6h4.4"/>',
  network: '<path d="M10 2.4 16 4.7v4.8c0 3.3-2.4 6.2-6 7.4-3.6-1.2-6-4.1-6-7.4V4.7z"/><path d="m7.5 9.9 1.8 1.8 3.3-3.5"/>',
  search: '<circle cx="8.8" cy="8.8" r="5.2"/><path d="m12.7 12.7 4 4"/>',
  settings: '<path d="M2.8 6.4h5.4M13.2 6.4h4M2.8 13.6h3.4M11.2 13.6h6"/><circle cx="10.6" cy="6.4" r="2.2"/><circle cx="8.6" cy="13.6" r="2.2"/>',
  sun: '<circle cx="10" cy="10" r="3.4"/><path d="M10 1.8v2.1M10 16.1v2.1M1.8 10h2.1M16.1 10h2.1M4.2 4.2l1.5 1.5M14.3 14.3l1.5 1.5M15.8 4.2l-1.5 1.5M5.7 14.3l-1.5 1.5"/>',
  moon: '<path d="M16.2 11.6A6.7 6.7 0 0 1 8.4 3.8a6.7 6.7 0 1 0 7.8 7.8z"/>',
  system: '<rect x="2.4" y="3.8" width="15.2" height="10.4" rx="2.2"/><path d="M7 17.2h6"/>',
  command: '<rect x="3" y="3" width="14" height="14" rx="3.6"/><path d="M7.4 8.4h5.2M7.4 11.6h3"/>',
  close: '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>',
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  info: '<circle cx="10" cy="10" r="7.4"/><path d="M10 9.2v4.4M10 6.5h.01"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  model: '<path d="m10 2.6 1.8 4.7 4.7 1.8-4.7 1.8L10 15.6l-1.8-4.7-4.7-1.8 4.7-1.8z"/>',
  lock: '<rect x="4.4" y="8.6" width="11.2" height="8" rx="2.6"/><path d="M7 8.6V6.3a3 3 0 0 1 6 0v2.3"/>',
  unlock: '<rect x="4.4" y="8.6" width="11.2" height="8" rx="2.6"/><path d="M7 8.6V6.3a3 3 0 0 1 5.7-1.3"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  arrow: '<path d="M3.8 10h11.4M11 5.8l4.2 4.2-4.2 4.2"/>',
  more: '<circle cx="4.6" cy="10" r="1.25"/><circle cx="10" cy="10" r="1.25"/><circle cx="15.4" cy="10" r="1.25"/>',
  keyboard: '<rect x="2.4" y="5" width="15.2" height="10" rx="2.4"/><path d="M5.6 8.2h.01M8.4 8.2h.01M11.2 8.2h.01M14 8.2h.01M6.6 11.6h6.8"/>',
  home: '<path d="M3.4 9 10 3.4 16.6 9v6.8a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6z"/>',
};

/**
 * The navigation table.
 *
 * Titles and icons are declared here rather than read from the view modules,
 * because the sidebar has to be complete and correct before any view module is
 * loaded -- and it has to stay complete when one of them cannot be loaded at
 * all. When a module does load and carries its own `title`/`icon`, those win.
 */
const VIEWS = [
  { id: 'chat', title: 'Chat', icon: ICONS.chat, key: 'c', primary: true, keywords: 'unterhaltung modell fragen gespräch' },
  { id: 'notes', title: 'Notizen', icon: ICONS.notes, key: 'n', primary: true, keywords: 'note texte wissen schreiben' },
  { id: 'projects', title: 'Projekte', icon: ICONS.projects, key: 'p', primary: false, keywords: 'aufgaben tasks vorhaben' },
  { id: 'graph', title: 'Gehirn', icon: ICONS.graph, key: 'g', primary: true, keywords: 'graph netz verknüpfungen karte' },
  { id: 'agents', title: 'Agenten', icon: ICONS.agents, key: 'a', primary: true, keywords: 'automatik werkzeuge läufe runs' },
  { id: 'network', title: 'Netzwerk', icon: ICONS.network, key: 'w', primary: false, keywords: 'internet schleuse gate freigaben audit' },
  { id: 'search', title: 'Suche', icon: ICONS.search, key: 'f', primary: false, keywords: 'finden volltext' },
  { id: 'settings', title: 'Einstellungen', icon: ICONS.settings, key: 's', primary: true, keywords: 'konfiguration tresor modelle sicherung' },
];

const VIEW_IDS = new Set(VIEWS.map((v) => v.id));
const DEFAULT_VIEW = 'chat';

/* ------------------------------------------------------------------ */
/* Reactive state container (contract section 13)                      */
/* ------------------------------------------------------------------ */

export function createState(initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();

  function emit(key, value) {
    const set = listeners.get(key);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(value, key);
        } catch (err) {
          console.error(`[neural-os] state-Listener für "${key}" ist gescheitert:`, err);
        }
      }
    }
  }

  return {
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      const previous = values.get(key);
      // Objects are replaced wholesale, so identity is a sound change test.
      if (Object.is(previous, value)) return value;
      values.set(key, value);
      emit(key, value);
      emit('*', { key, value, previous });
      return value;
    },
    update(key, fn) {
      return this.set(key, fn(values.get(key)));
    },
    on(key, fn) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => {
        const set = listeners.get(key);
        if (set) set.delete(fn);
      };
    },
    snapshot() {
      return Object.fromEntries(values);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

/**
 * `#/graph?focus=note_x` -> `{view:'graph', segments:[], params:{focus:'note_x'}}`
 * The second path segment is offered as `params.id`, so `#/chat/chat_123`
 * and `#/chat?id=chat_123` are the same route.
 */
export function parseRoute(rawHash) {
  const raw = String(rawHash || '').replace(/^#/, '').trim();
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const view = segments.length ? segments[0] : DEFAULT_VIEW;
  const params = {};
  try {
    for (const [key, value] of new URLSearchParams(queryPart)) params[key] = value;
  } catch {
    /* a hand-edited hash is not worth a crash */
  }
  if (segments[1] && params.id === undefined) params.id = segments[1];
  const hash = `#/${segments.join('/')}${queryPart ? `?${queryPart}` : ''}`;
  return { view, segments: segments.slice(1), params, hash, known: VIEW_IDS.has(view) };
}

function routeHash(route) {
  return route.hash;
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function createShell() {
  const state = createState({
    status: null,
    statusStale: true,
    statusError: null,
    network: null,
    models: null,
    vault: null,
    approvals: [],
    theme: readTheme(),
    connected: false,
    activeChatId: readStored(STORAGE.chat, null),
    route: parseRoute(window.location.hash),
    ready: false,
  });

  const busListeners = new Map();
  const dom = {};
  const viewCache = new Map();
  let mountToken = 0;
  let currentView = null;
  let eventStream = null;

  /* ---------------------------------------------------------------- */
  /* Live server events                                                */
  /* ---------------------------------------------------------------- */

  const bus = {
    /** @returns {() => void} unsubscribe */
    on(name, fn) {
      if (!busListeners.has(name)) busListeners.set(name, new Set());
      busListeners.get(name).add(fn);
      return () => {
        const set = busListeners.get(name);
        if (set) set.delete(fn);
      };
    },
  };

  function dispatchBus(event) {
    for (const name of [event.type, '*']) {
      const set = busListeners.get(name);
      if (!set) continue;
      for (const fn of [...set]) {
        try {
          fn(event.payload, event);
        } catch (err) {
          console.error(`[neural-os] Handler für Ereignis "${event.type}" ist gescheitert:`, err);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Status: the single source of the header's claims                  */
  /* ---------------------------------------------------------------- */

  async function refreshStatus() {
    try {
      const status = await api.get('/status', { timeoutMs: 8000 });
      state.set('status', status);
      state.set('statusStale', false);
      state.set('statusError', null);
      state.set('network', status && status.network ? status.network : null);
      state.set('models', status && status.models ? status.models : null);
      state.set('vault', status && status.vault ? status.vault : null);
      return status;
    } catch (err) {
      // Keep the payload for debugging but mark it stale: from this moment on
      // the header stops claiming a network mode it can no longer verify.
      state.set('statusStale', true);
      state.set('statusError', err instanceof ApiError ? err.message : String(err));
      renderChrome();
      return null;
    }
  }

  const refreshStatusSoon = debounce(() => {
    refreshStatus();
  }, 500);

  // Record events arrive in bursts (a streaming answer writes many messages).
  // The header only shows counts, so it can lag behind by a couple of seconds
  // instead of firing a status request per stored record.
  const refreshStatusLater = debounce(() => {
    refreshStatus();
  }, 2500);

  async function refreshApprovals() {
    try {
      const result = await api.get('/approvals', { timeoutMs: 8000 });
      const items = Array.isArray(result) ? result : (result && Array.isArray(result.items) ? result.items : []);
      state.set('approvals', items.filter((row) => {
        if (!row) return false;
        const status = row.data ? row.data.status : row.status;
        return !status || status === 'pending';
      }));
    } catch (err) {
      // Approvals are optional (the agent subsystem may not be loaded). An
      // empty list is the honest answer here: nothing is known to be pending.
      if (!(err instanceof ApiError) || err.status !== 503) console.warn('[neural-os] Freigaben nicht abrufbar:', err && err.message);
      state.set('approvals', []);
    }
  }

  const refreshApprovalsSoon = debounce(() => {
    refreshApprovals();
  }, 300);

  function handleServerEvent(event) {
    dispatchBus(event);
    const type = event.type || '';

    if (type === 'models.changed') {
      if (event.payload) state.set('models', event.payload);
      refreshStatusSoon();
    } else if (type === 'config.changed' || type.startsWith('vault.') || type.startsWith('network.')) {
      refreshStatusSoon();
    } else if (type.startsWith('record.') || type.startsWith('edge.')) {
      refreshStatusLater();
    } else if (type.startsWith('approval.')) {
      refreshApprovalsSoon();
      if (type === 'approval.requested') {
        const summary = event.payload && event.payload.record && event.payload.record.data
          ? event.payload.record.data.summary
          : null;
        toast(summary ? `Freigabe erbeten: ${summary}` : 'Ein Agent bittet um eine Freigabe.', 'info', {
          action: { label: 'Ansehen', run: () => navigate('#/agents') },
          timeout: 12000,
        });
      }
    } else if (type === 'run.failed') {
      const message = event.payload && event.payload.error && event.payload.error.message;
      toast(message ? `Agentenlauf fehlgeschlagen: ${message}` : 'Ein Agentenlauf ist fehlgeschlagen.', 'error');
    }

    if (type === 'vault.locked') toast('Der Tresor wurde gesperrt.', 'info');
    if (type === 'vault.unlocked') toast('Der Tresor ist entsperrt.', 'success');
  }

  function startEventStream() {
    if (eventStream) eventStream.close();
    eventStream = api.events(handleServerEvent, {
      onStatus: (connState, info) => {
        const connected = connState === 'open';
        state.set('connected', connected);
        state.set('connectionInfo', { state: connState, ...info });
        if (connected) {
          // A reconnect may have missed a config change; re-read the truth.
          refreshStatus();
          refreshApprovals();
        }
        renderChrome();
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Chrome: rail, header, indicators                                  */
  /* ---------------------------------------------------------------- */

  function buildRail() {
    const rail = dom.rail;
    clear(rail);
    rail.setAttribute('aria-label', 'Hauptbereiche');

    const brand = h('a.rail__brand', {
      href: '#/chat',
      'aria-label': 'Neural OS – Startseite',
      title: 'Neural OS',
    }, icon(ICONS.brand, { class: 'rail__brand-mark' }));
    rail.appendChild(brand);

    const nav = h('div.rail__items', { role: 'list' });
    dom.navLinks = new Map();
    for (const view of VIEWS) {
      const badge = h('span.rail__badge', { hidden: true });
      const link = h('a.rail__item', {
        href: `#/${view.id}`,
        role: 'listitem',
        'data-view': view.id,
        title: `${view.title} (g dann ${view.key})`,
      },
      h('span.rail__icon', null, icon(view.icon), badge),
      h('span.rail__label', null, text(view.title)));
      if (!view.primary) link.classList.add('rail__item--secondary');
      dom.navLinks.set(view.id, { link, badge, view });
      nav.appendChild(link);
    }
    rail.appendChild(nav);

    const more = h('button.rail__item.rail__item--more', {
      type: 'button',
      title: 'Befehlspalette öffnen (Strg/Cmd + K)',
      onClick: () => palette.open(),
    },
    h('span.rail__icon', null, icon(ICONS.more)),
    h('span.rail__label', null, text('Mehr')));
    rail.appendChild(more);
  }

  function buildTopbar() {
    const bar = dom.topbar;
    clear(bar);

    dom.routeTitle = h('h1.topbar__title', null, text('Neural OS'));
    const left = h('div.topbar__left', null, dom.routeTitle);

    dom.netChip = h('button.chip.chip--net', {
      type: 'button',
      'data-net': 'unknown',
      onClick: () => navigate('#/network'),
    });
    dom.modelChip = h('button.chip', {
      type: 'button',
      'data-model': 'unknown',
      onClick: () => navigate('#/settings'),
    });
    dom.vaultChip = h('button.chip', {
      type: 'button',
      'data-vault': 'unknown',
      onClick: () => navigate('#/settings'),
    });
    dom.connChip = h('button.chip.chip--warn', {
      type: 'button',
      hidden: true,
      onClick: () => {
        if (eventStream) eventStream.retryNow();
        refreshStatus();
      },
    });

    dom.searchButton = h('button.topbar__search', {
      type: 'button',
      onClick: () => palette.open(),
      'aria-label': 'Befehlspalette und Suche öffnen',
    },
    icon(ICONS.search),
    h('span.topbar__search-label', null, text('Suchen oder Befehl …')),
    h('kbd.kbd', null, text(isMac() ? '⌘K' : 'Strg K')));

    dom.themeButton = h('button.icon-button', {
      type: 'button',
      onClick: () => cycleTheme(),
    });

    const right = h('div.topbar__right', null,
      dom.connChip,
      dom.netChip,
      dom.modelChip,
      dom.vaultChip,
      h('span.topbar__sep', { 'aria-hidden': 'true' }),
      dom.themeButton,
      h('button.icon-button', {
        type: 'button',
        'aria-label': 'Tastenkürzel anzeigen',
        title: 'Tastenkürzel (?)',
        onClick: () => showShortcuts(),
      }, icon(ICONS.keyboard)));

    bar.append(left, dom.searchButton, right);
    renderChrome();
  }

  /** Everything the header claims, recomputed from state. Never from a wish. */
  function renderChrome() {
    if (!dom.netChip) return;
    const status = state.get('status');
    const stale = state.get('statusStale') !== false;

    const net = describeNetwork(status, stale);
    setChip(dom.netChip, net.label, net.hint, ICONS.network);
    dom.netChip.dataset.net = net.key;

    const model = describeModels(status, stale);
    setChip(dom.modelChip, model.label, model.hint, ICONS.model);
    dom.modelChip.dataset.model = model.key;

    const vault = describeVault(status, stale);
    setChip(dom.vaultChip, vault.label, vault.hint, vault.key === 'locked' ? ICONS.lock : ICONS.unlock);
    dom.vaultChip.dataset.vault = vault.key;

    const connected = state.get('connected');
    const info = state.get('connectionInfo') || {};
    const showConn = !connected && state.get('ready');
    dom.connChip.hidden = !showConn;
    if (showConn) {
      const label = info.state === 'reconnecting' && info.delay
        ? `Verbindung unterbrochen – neuer Versuch in ${Math.max(1, Math.round(info.delay / 1000))} s`
        : 'Verbindung unterbrochen';
      setChip(dom.connChip, label, 'Die Live-Verbindung zum lokalen Server ist abgerissen. Klicken, um es sofort erneut zu versuchen.', ICONS.alert);
    }

    if (dom.themeButton) {
      const theme = state.get('theme');
      clear(dom.themeButton);
      dom.themeButton.appendChild(icon(theme === 'dark' ? ICONS.moon : theme === 'light' ? ICONS.sun : ICONS.system));
      const label = theme === 'dark' ? 'Dunkel' : theme === 'light' ? 'Hell' : 'Systemvorgabe';
      dom.themeButton.title = `Darstellung: ${label} (klicken zum Wechseln)`;
      dom.themeButton.setAttribute('aria-label', `Darstellung: ${label}. Klicken zum Wechseln.`);
    }

    const approvals = state.get('approvals') || [];
    const entry = dom.navLinks && dom.navLinks.get('agents');
    if (entry) {
      entry.badge.hidden = approvals.length === 0;
      clear(entry.badge);
      if (approvals.length) {
        entry.badge.appendChild(text(String(Math.min(99, approvals.length))));
        entry.link.title = `Agenten – ${approvals.length} offene Freigabe(n)`;
      } else {
        entry.link.title = 'Agenten (g dann a)';
      }
    }
  }

  function setChip(node, label, hint, iconMarkup) {
    clear(node);
    node.appendChild(icon(iconMarkup));
    node.appendChild(h('span.chip__label', null, text(label)));
    node.title = hint;
    node.setAttribute('aria-label', `${label}. ${hint}`);
  }

  function markActiveRoute(route) {
    if (!dom.navLinks) return;
    for (const [id, entry] of dom.navLinks) {
      const active = id === route.view;
      entry.link.classList.toggle('is-active', active);
      if (active) entry.link.setAttribute('aria-current', 'page');
      else entry.link.removeAttribute('aria-current');
    }
    const view = VIEWS.find((v) => v.id === route.view);
    if (dom.routeTitle) {
      clear(dom.routeTitle);
      dom.routeTitle.appendChild(text(view ? view.title : 'Nicht gefunden'));
    }
    document.title = view ? `${view.title} · Neural OS` : 'Neural OS';
  }

  /* ---------------------------------------------------------------- */
  /* View loading                                                      */
  /* ---------------------------------------------------------------- */

  async function loadView(id) {
    if (!VIEW_IDS.has(id)) throw new ApiError('NOT_FOUND', `Unbekannter Bereich "${id}".`, { status: 404 });
    if (!viewCache.has(id)) {
      // The id comes from the allow-list above, never straight from the hash.
      const promise = import(`./views/${id}.js`).then((mod) => {
        const view = mod && (mod.default || mod.view);
        if (!view || typeof view.mount !== 'function') {
          throw new Error(`Das Modul "views/${id}.js" hat keine mount()-Funktion.`);
        }
        return view;
      });
      viewCache.set(id, promise);
      promise.catch(() => viewCache.delete(id)); // a failed load must stay retryable
    }
    return viewCache.get(id);
  }

  async function unmountCurrent() {
    if (!currentView) return;
    const view = currentView;
    currentView = null;
    if (typeof view.unmount === 'function') {
      try {
        await view.unmount();
      } catch (err) {
        console.error('[neural-os] unmount() ist gescheitert:', err);
      }
    }
  }

  async function renderRoute(route) {
    const token = ++mountToken;
    markActiveRoute(route);
    await unmountCurrent();
    if (token !== mountToken) return;

    const container = dom.view;
    clear(container);
    container.dataset.view = route.view;
    container.scrollTop = 0;

    if (!route.known) {
      container.appendChild(renderNotFound(route));
      return;
    }

    // Only show a spinner if loading actually takes a moment; a flash of
    // "Lädt …" on a cached module looks broken rather than fast.
    const spinnerTimer = setTimeout(() => {
      if (token === mountToken && !container.firstChild) container.appendChild(renderLoading(route));
    }, 140);

    let view;
    try {
      view = await loadView(route.view);
    } catch (err) {
      clearTimeout(spinnerTimer);
      if (token !== mountToken) return;
      clear(container);
      container.appendChild(renderViewError(route, err, 'load'));
      return;
    }
    clearTimeout(spinnerTimer);
    if (token !== mountToken) return;

    clear(container);
    const entry = dom.navLinks && dom.navLinks.get(route.view);
    if (entry && view.title && typeof view.title === 'string') {
      // The module's own label wins once it is actually here.
      const labelNode = entry.link.querySelector('.rail__label');
      if (labelNode && labelNode.textContent !== view.title) {
        clear(labelNode);
        labelNode.appendChild(text(view.title));
      }
    }

    try {
      currentView = view;
      await view.mount(container, makeContext(route));
    } catch (err) {
      if (token !== mountToken) return;
      currentView = null;
      clear(container);
      container.appendChild(renderViewError(route, err, 'mount'));
    }
  }

  function renderLoading(route) {
    return h('div.view-state', { role: 'status', 'aria-live': 'polite' },
      h('div.spinner', { 'aria-hidden': 'true' }),
      h('p.view-state__text', null, text(`${labelFor(route.view)} wird geladen …`)));
  }

  function renderNotFound(route) {
    return h('div.view-state', null,
      h('h2.view-state__title', null, text('Diesen Bereich gibt es nicht')),
      h('p.view-state__text', null, text(`Die Adresse „${route.hash}“ gehört zu keinem Bereich dieser Anwendung.`)),
      h('div.view-state__actions', null,
        h('button.btn.btn--primary', { type: 'button', onClick: () => navigate(`#/${DEFAULT_VIEW}`) }, text('Zum Chat'))));
  }

  function renderViewError(route, err, phase) {
    const message = err instanceof ApiError || err instanceof Error ? err.message : String(err);
    const label = labelFor(route.view);
    return h('div.view-state.view-state--error', { role: 'alert' },
      h('div.view-state__icon', { 'aria-hidden': 'true' }, icon(ICONS.alert)),
      h('h2.view-state__title', null, text(`${label} ist nicht verfügbar`)),
      h('p.view-state__text', null, text(phase === 'load'
        ? `Das Modul „views/${route.view}.js“ konnte nicht geladen werden. In dieser Installation fehlt dieser Teil der Oberfläche oder er enthält einen Fehler.`
        : `Beim Aufbau der Ansicht ist ein Fehler aufgetreten. Die übrigen Bereiche funktionieren weiter.`)),
      h('pre.view-state__detail', null, text(message)),
      h('div.view-state__actions', null,
        h('button.btn.btn--primary', {
          type: 'button',
          onClick: () => {
            viewCache.delete(route.view);
            renderRoute(state.get('route'));
          },
        }, text('Erneut versuchen')),
        h('button.btn', { type: 'button', onClick: () => navigate(`#/${DEFAULT_VIEW}`) }, text('Zum Chat'))));
  }

  function labelFor(id) {
    const view = VIEWS.find((v) => v.id === id);
    return view ? view.title : id;
  }

  /* ---------------------------------------------------------------- */
  /* Context handed to every view (contract section 13)                */
  /* ---------------------------------------------------------------- */

  function makeContext(route) {
    return {
      api,
      ApiError,
      h,
      text,
      clear,
      on,
      list,
      icon,
      cx,
      frag,
      timeAgo,
      snippet,
      state,
      bus,
      navigate,
      toast,
      confirm: confirmDialog,
      route,
      icons: ICONS,
      version: APP_VERSION,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Navigation                                                        */
  /* ---------------------------------------------------------------- */

  function navigate(target) {
    const next = parseRoute(String(target || '').startsWith('#') ? target : `#${target}`);
    const hash = routeHash(next);
    if (window.location.hash === hash) {
      // Same address, explicit request: re-render rather than doing nothing.
      state.set('route', next);
      renderRoute(next);
      return;
    }
    window.location.hash = hash;
  }

  function onHashChange() {
    const route = parseRoute(window.location.hash);
    state.set('route', route);
    if (route.params.id && route.view === 'chat') {
      state.set('activeChatId', route.params.id);
      writeStored(STORAGE.chat, route.params.id);
    }
    writeStored(STORAGE.lastRoute, route.hash);
    renderRoute(route);
  }

  /* ---------------------------------------------------------------- */
  /* Toasts                                                            */
  /* ---------------------------------------------------------------- */

  const toasts = [];

  /**
   * @param {string} message German, user-facing
   * @param {'info'|'success'|'error'} [kind]
   * @param {{timeout?:number, action?:{label:string, run:Function}}} [opts]
   */
  function toast(message, kind = 'info', opts = {}) {
    const container = dom.toasts;
    if (!container) return () => {};
    const timeout = Number.isFinite(opts.timeout) ? opts.timeout : (kind === 'error' ? 9000 : 5000);
    const iconMarkup = kind === 'error' ? ICONS.alert : kind === 'success' ? ICONS.check : ICONS.info;

    let timer = null;
    const node = h('div.toast', {
      'data-kind': kind,
      role: kind === 'error' ? 'alert' : 'status',
    },
    h('span.toast__icon', { 'aria-hidden': 'true' }, icon(iconMarkup)),
    h('span.toast__text', null, text(String(message))),
    opts.action && typeof opts.action.run === 'function'
      ? h('button.toast__action', {
        type: 'button',
        onClick: () => {
          dismiss();
          opts.action.run();
        },
      }, text(opts.action.label || 'Öffnen'))
      : null,
    h('button.toast__close', {
      type: 'button',
      'aria-label': 'Meldung schließen',
      onClick: () => dismiss(),
    }, icon(ICONS.close)));

    function dismiss() {
      if (timer) clearTimeout(timer);
      const index = toasts.indexOf(node);
      if (index !== -1) toasts.splice(index, 1);
      node.classList.add('toast--leaving');
      // Remove after the (short) transition, and unconditionally afterwards.
      setTimeout(() => node.remove(), 180);
    }

    container.appendChild(node);
    toasts.push(node);
    while (toasts.length > 4) {
      const oldest = toasts.shift();
      if (oldest) oldest.remove();
    }
    if (timeout > 0) timer = setTimeout(dismiss, timeout);
    return dismiss;
  }

  /* ---------------------------------------------------------------- */
  /* Overlays: modal dialog, command palette, onboarding               */
  /* ---------------------------------------------------------------- */

  const overlayStack = [];

  function openOverlay({ node, onClose, closeOnBackdrop = true, labelledBy }) {
    const backdrop = h('div.overlay', { 'data-closable': closeOnBackdrop ? '1' : '0' });
    const panel = h('div.overlay__panel', { role: 'dialog', 'aria-modal': 'true' }, node);
    if (labelledBy) panel.setAttribute('aria-labelledby', labelledBy);
    backdrop.appendChild(panel);

    const previousFocus = document.activeElement;
    const entry = { backdrop, panel, close };
    overlayStack.push(entry);
    dom.overlays.appendChild(backdrop);
    document.documentElement.classList.add('is-overlaid');

    const offBackdrop = on(backdrop, 'mousedown', (event) => {
      if (event.target === backdrop && closeOnBackdrop) close(null);
    });
    const offKeys = on(panel, 'keydown', (event) => {
      if (event.key === 'Tab') trapFocus(event, panel);
    });

    focusFirst(panel);

    function close(result) {
      const index = overlayStack.indexOf(entry);
      if (index === -1) return;
      overlayStack.splice(index, 1);
      offBackdrop();
      offKeys();
      backdrop.remove();
      if (!overlayStack.length) document.documentElement.classList.remove('is-overlaid');
      if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) {
        previousFocus.focus();
      }
      if (onClose) onClose(result);
    }

    return entry;
  }

  function closeTopOverlay() {
    const entry = overlayStack[overlayStack.length - 1];
    if (entry) entry.close(null);
    return !!entry;
  }

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusFirst(root) {
    const target = root.querySelector('[autofocus]') || root.querySelector(FOCUSABLE);
    if (target) target.focus();
    else {
      root.setAttribute('tabindex', '-1');
      root.focus();
    }
  }

  function trapFocus(event, root) {
    const nodes = [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * @param {{title?:string, message?:string, confirmLabel?:string,
   *          cancelLabel?:string, danger?:boolean}|string} options
   * @returns {Promise<boolean>}
   */
  function confirmDialog(options = {}) {
    const opts = typeof options === 'string' ? { message: options } : options;
    return new Promise((resolve) => {
      const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(!!value);
      };

      const body = h('div.dialog', null,
        h('h2.dialog__title', { id: titleId }, text(opts.title || 'Bist du sicher?')),
        opts.message ? h('p.dialog__text', null, text(opts.message)) : null,
        h('div.dialog__actions', null,
          h('button.btn', {
            type: 'button',
            onClick: () => entry.close(false),
          }, text(opts.cancelLabel || 'Abbrechen')),
          h('button.btn.btn--primary', {
            type: 'button',
            autofocus: true,
            class: opts.danger ? 'btn--danger' : '',
            onClick: () => entry.close(true),
          }, text(opts.confirmLabel || 'Bestätigen'))));

      const entry = openOverlay({
        node: body,
        labelledBy: titleId,
        onClose: (result) => finish(result === true),
      });
    });
  }

  /* ----------------------------- palette ---------------------------- */

  const palette = createPalette();

  function createPalette() {
    let entry = null;
    let items = [];
    let active = 0;
    let input = null;
    let listNode = null;
    let searchToken = 0;

    function baseItems() {
      const status = state.get('status');
      const vaultState = status && status.vault ? (status.vault.state || status.vault.encryption) : null;
      const actions = [
        {
          id: 'act:new-note',
          group: 'Aktionen',
          label: 'Neue Notiz anlegen',
          hint: 'Legt eine leere Notiz an und öffnet sie',
          icon: ICONS.plus,
          run: async () => {
            const record = await api.post('/records', { type: 'note', data: { title: 'Neue Notiz', body: '' } });
            const id = record && (record.id || (record.record && record.record.id));
            toast('Notiz angelegt.', 'success');
            navigate(id ? `#/notes?id=${encodeURIComponent(id)}` : '#/notes');
          },
        },
        {
          id: 'act:new-chat',
          group: 'Aktionen',
          label: 'Neuen Chat beginnen',
          hint: 'Ein neues Gespräch mit dem lokalen Modell',
          icon: ICONS.chat,
          run: async () => {
            const record = await api.post('/chats', {});
            const id = record && (record.id || (record.record && record.record.id));
            if (id) {
              state.set('activeChatId', id);
              writeStored(STORAGE.chat, id);
            }
            navigate(id ? `#/chat?id=${encodeURIComponent(id)}` : '#/chat');
          },
        },
        {
          id: 'act:models-refresh',
          group: 'Aktionen',
          label: 'Modelle neu suchen',
          hint: 'Fragt alle eingetragenen Modell-Backends erneut ab',
          icon: ICONS.refresh,
          run: async () => {
            const result = await api.post('/models/refresh', {}, { timeoutMs: 20000 });
            await refreshStatus();
            const count = countModels(result) || countModels(state.get('models'));
            toast(count ? `${formatNumber(count)} Modell(e) gefunden.` : 'Kein Modell gefunden.', count ? 'success' : 'info');
          },
        },
        {
          id: 'act:graph-rescan',
          group: 'Aktionen',
          label: 'Verknüpfungen neu berechnen',
          hint: 'Liest alle Notizen erneut auf [[Links]] und #Schlagworte',
          icon: ICONS.graph,
          run: async () => {
            const result = await api.post('/graph/rescan', {}, { timeoutMs: 60000 });
            const created = result && (result.created ?? (result.stats && result.stats.created));
            toast(Number.isFinite(created) ? `Fertig: ${formatNumber(created)} Verknüpfung(en) neu.` : 'Verknüpfungen neu berechnet.', 'success');
          },
        },
        {
          id: 'act:backup',
          group: 'Aktionen',
          label: 'Sicherung exportieren',
          hint: 'Schreibt einen vollständigen Export in den Exportordner',
          icon: ICONS.arrow,
          run: async () => {
            const result = await api.post('/backup/export', { format: 'both', includeFiles: true }, { timeoutMs: 120000 });
            toast(result && result.dir ? `Sicherung geschrieben nach ${result.dir}` : 'Sicherung geschrieben.', 'success', { timeout: 12000 });
          },
        },
        {
          id: 'act:theme',
          group: 'Aktionen',
          label: 'Darstellung wechseln (hell / dunkel / System)',
          icon: ICONS.sun,
          run: () => cycleTheme(),
        },
        {
          id: 'act:onboarding',
          group: 'Aktionen',
          label: 'Willkommenshinweise erneut anzeigen',
          icon: ICONS.info,
          run: () => showOnboarding(true),
        },
        {
          id: 'act:shortcuts',
          group: 'Aktionen',
          label: 'Tastenkürzel anzeigen',
          icon: ICONS.keyboard,
          run: () => showShortcuts(),
        },
        {
          id: 'act:reload',
          group: 'Aktionen',
          label: 'Oberfläche neu laden',
          icon: ICONS.refresh,
          run: () => window.location.reload(),
        },
      ];

      if (vaultState === 'unlocked') {
        actions.unshift({
          id: 'act:lock',
          group: 'Aktionen',
          label: 'Tresor sperren',
          hint: 'Der Schlüssel wird aus dem Speicher entfernt',
          icon: ICONS.lock,
          run: async () => {
            await api.post('/vault/lock', {});
            await refreshStatus();
          },
        });
      }

      const navigation = VIEWS.map((view) => ({
        id: `nav:${view.id}`,
        group: 'Bereiche',
        label: view.title,
        hint: `g dann ${view.key}`,
        icon: view.icon,
        keywords: `${view.id} ${view.keywords}`,
        run: () => navigate(`#/${view.id}`),
      }));

      return [...navigation, ...actions];
    }

    function score(item, query) {
      if (!query) return 1;
      const haystack = `${item.label} ${item.hint || ''} ${item.keywords || ''}`.toLowerCase();
      const needle = query.toLowerCase();
      if (haystack.includes(needle)) return 10 - haystack.indexOf(needle) / 100;
      // Loose subsequence match, so "eins" still finds "Einstellungen".
      let index = 0;
      for (const char of needle) {
        index = haystack.indexOf(char, index);
        if (index === -1) return 0;
        index += 1;
      }
      return 1;
    }

    function render(query) {
      const candidates = baseItems()
        .map((item) => ({ item, s: score(item, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.item);

      const extra = [];
      if (query.trim().length >= 2) {
        extra.push({
          id: 'search:all',
          group: 'Suche',
          label: `Alles durchsuchen nach „${query.trim()}“`,
          icon: ICONS.search,
          run: () => navigate(`#/search?q=${encodeURIComponent(query.trim())}`),
        });
      }
      items = [...extra, ...candidates, ...(state.get('paletteResults') || [])];
      active = 0;
      paint();
    }

    function paint() {
      if (!listNode) return;
      clear(listNode);
      if (!items.length) {
        listNode.appendChild(h('li.palette__empty', { role: 'presentation' }, text('Nichts gefunden.')));
        return;
      }
      let lastGroup = null;
      items.forEach((item, index) => {
        if (item.group !== lastGroup) {
          lastGroup = item.group;
          listNode.appendChild(h('li.palette__group', { role: 'presentation' }, text(item.group)));
        }
        const option = h('li.palette__item', {
          id: `palette-option-${index}`,
          role: 'option',
          'aria-selected': index === active ? 'true' : 'false',
          class: index === active ? 'is-active' : '',
          onMouseenter: () => {
            active = index;
            paint();
          },
          onClick: () => run(index),
        },
        h('span.palette__icon', { 'aria-hidden': 'true' }, icon(item.icon || ICONS.arrow)),
        h('span.palette__label', null, text(item.label)),
        item.hint ? h('span.palette__hint', null, text(item.hint)) : null);
        listNode.appendChild(option);
      });
      if (input) input.setAttribute('aria-activedescendant', `palette-option-${active}`);
      const activeNode = listNode.querySelector('.is-active');
      if (activeNode && typeof activeNode.scrollIntoView === 'function') {
        activeNode.scrollIntoView({ block: 'nearest' });
      }
    }

    async function run(index) {
      const item = items[index];
      if (!item) return;
      close();
      try {
        await item.run();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : `Aktion fehlgeschlagen: ${err && err.message}`, 'error');
      }
    }

    const runSearch = debounce(async (query) => {
      const token = ++searchToken;
      if (query.trim().length < 2) {
        state.set('paletteResults', []);
        if (entry) render(query);
        return;
      }
      try {
        const result = await api.get('/search', { query: { q: query.trim(), limit: 6 }, timeoutMs: 8000 });
        if (token !== searchToken) return;
        const rows = (result && Array.isArray(result.items) ? result.items : []).map((row) => {
          const record = row && row.record ? row.record : row;
          const data = (record && record.data) || {};
          const label = data.title || data.name || data.text || record.id;
          return {
            id: `hit:${record.id}`,
            group: 'Treffer',
            label: String(label).slice(0, 120),
            hint: recordTypeLabel(record.type),
            icon: iconForType(record.type),
            run: () => navigate(targetForRecord(record)),
          };
        });
        state.set('paletteResults', rows);
      } catch (err) {
        if (token !== searchToken) return;
        state.set('paletteResults', [{
          id: 'hit:error',
          group: 'Treffer',
          label: err instanceof ApiError ? `Suche nicht möglich: ${err.message}` : 'Suche nicht möglich.',
          icon: ICONS.alert,
          run: () => {},
        }]);
      }
      if (entry) render(query);
    }, 180);

    function close() {
      if (entry) {
        const current = entry;
        entry = null;
        current.close(null);
      }
      state.set('paletteResults', []);
      runSearch.cancel();
    }

    function open(initialQuery = '') {
      if (entry) {
        if (input) input.select();
        return;
      }
      input = h('input.palette__input', {
        type: 'text',
        autofocus: true,
        value: initialQuery,
        placeholder: 'Bereich, Aktion oder Suchbegriff …',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': 'palette-list',
        'aria-label': 'Befehlspalette',
        autocomplete: 'off',
        spellcheck: 'false',
        onInput: (event) => {
          render(event.target.value);
          runSearch(event.target.value);
        },
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            active = Math.min(items.length - 1, active + 1);
            paint();
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            active = Math.max(0, active - 1);
            paint();
          } else if (event.key === 'Home') {
            event.preventDefault();
            active = 0;
            paint();
          } else if (event.key === 'End') {
            event.preventDefault();
            active = items.length - 1;
            paint();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            run(active);
          }
        },
      });
      listNode = h('ul.palette__list', { id: 'palette-list', role: 'listbox', 'aria-label': 'Ergebnisse' });

      const node = h('div.palette', null,
        h('div.palette__head', null,
          h('span.palette__head-icon', { 'aria-hidden': 'true' }, icon(ICONS.command)),
          input,
          h('kbd.kbd', null, text('Esc'))),
        listNode,
        h('div.palette__foot', null,
          h('span', null, text('↑ ↓ bewegen · ↵ ausführen · Esc schließen')),
          h('span', null, text('Alles bleibt auf diesem Gerät'))));

      entry = openOverlay({
        node,
        onClose: () => {
          entry = null;
          state.set('paletteResults', []);
        },
      });
      entry.panel.classList.add('overlay__panel--palette');
      render(initialQuery);
      if (initialQuery) runSearch(initialQuery);
    }

    return { open, close, get isOpen() { return !!entry; } };
  }

  /* --------------------------- onboarding --------------------------- */

  function showOnboarding(force = false) {
    if (!force && readStored(STORAGE.onboarding, null) === APP_VERSION) return;
    const status = state.get('status');
    const home = (status && (status.home || (status.paths && status.paths.home) || (status.vault && status.vault.home))) || null;
    const modelInfo = describeModels(status, state.get('statusStale') !== false);
    const net = describeNetwork(status, state.get('statusStale') !== false);
    const titleId = 'onboarding-title';

    const missing = [];
    if (modelInfo.key === 'none') {
      missing.push(h('li', null,
        h('strong', null, text('Es ist kein Modell installiert.')),
        text(' Chat und Agenten brauchen ein lokales Modell. Mit Internetzugang einmalig:'),
        h('pre.code', null, text('ollama pull llama3.2')),
        text('Ollama lauscht danach auf 127.0.0.1:11434 und wird automatisch gefunden. Ab dann läuft der Chat ohne Internet.')));
    }
    if (modelInfo.key === 'unknown') {
      missing.push(h('li', null, text('Der Modellstatus ist gerade nicht abrufbar. Die Kopfzeile zeigt deshalb „unbekannt“ statt einer Vermutung.')));
    }
    if (status && status.sharing && status.sharing.enabled) {
      missing.push(h('li', null, text('Die Freigabe im lokalen Netz ist aktiv. Andere Geräte in deinem Netzwerk können diese Anwendung mit einem Token erreichen.')));
    }

    const node = h('div.onboarding', null,
      h('div.onboarding__mark', { 'aria-hidden': 'true' }, icon(ICONS.brand)),
      h('h2.onboarding__title', { id: titleId }, text('Willkommen in Neural OS')),
      h('p.onboarding__lead', null, text(
        'Dies ist dein eigenes System. Notizen, Gespräche, Aufgaben und Verknüpfungen liegen auf diesem Gerät '
        + '– nicht in einem Konto, nicht auf einem Server, der jemand anderem gehört.',
      )),
      h('dl.onboarding__facts', null,
        h('div.onboarding__fact', null,
          h('dt', null, text('Wo deine Daten liegen')),
          h('dd', null, text(home ? home : 'Im Datenverzeichnis dieser Installation, standardmäßig ~/.neural-os'))),
        h('div.onboarding__fact', null,
          h('dt', null, text('Netzzugang')),
          h('dd', null, text(`${net.label} – ${net.hint}`))),
        h('div.onboarding__fact', null,
          h('dt', null, text('Modell')),
          h('dd', null, text(modelInfo.hint)))),
      missing.length
        ? h('div.onboarding__missing', null,
          h('h3', null, text('Was jetzt noch fehlt')),
          h('ul', null, ...missing))
        : h('p.onboarding__text', null, text('Es fehlt nichts: ein Modell ist erreichbar, der Tresor ist geöffnet. Viel Spaß.')),
      h('p.onboarding__text.onboarding__text--muted', null, text(
        'Die Kopfzeile zeigt dauerhaft, ob gerade etwas dieses Gerät verlassen darf. '
        + 'Unter „Netzwerk“ steht jede einzelne Verbindung, die versucht wurde – auch die erlaubten.',
      )),
      h('div.onboarding__actions', null,
        h('button.btn.btn--primary', {
          type: 'button',
          autofocus: true,
          onClick: () => {
            writeStored(STORAGE.onboarding, APP_VERSION);
            entry.close(null);
          },
        }, text('Los geht’s')),
        h('button.btn', {
          type: 'button',
          onClick: () => {
            writeStored(STORAGE.onboarding, APP_VERSION);
            entry.close(null);
            navigate('#/settings');
          },
        }, text('Zu den Einstellungen'))));

    const entry = openOverlay({ node, labelledBy: titleId, closeOnBackdrop: false });
    entry.panel.classList.add('overlay__panel--wide');
  }

  /* --------------------------- shortcuts ---------------------------- */

  function showShortcuts() {
    const mod = isMac() ? '⌘' : 'Strg';
    const rows = [
      [`${mod} K`, 'Befehlspalette öffnen'],
      ['/', 'Suche öffnen'],
      ['?', 'Diese Übersicht'],
      ['Esc', 'Overlay schließen'],
      ...VIEWS.map((v) => [`g ${v.key}`, `Zu ${v.title}`]),
    ];
    const titleId = 'shortcuts-title';
    const node = h('div.dialog', null,
      h('h2.dialog__title', { id: titleId }, text('Tastenkürzel')),
      h('table.shortcuts', null,
        h('tbody', null, ...rows.map(([keys, label]) => h('tr', null,
          h('td.shortcuts__keys', null, ...keys.split(' ').map((k) => h('kbd.kbd', null, text(k)))),
          h('td', null, text(label)))))),
      h('div.dialog__actions', null,
        h('button.btn.btn--primary', { type: 'button', autofocus: true, onClick: () => entry.close(null) }, text('Schließen'))));
    const entry = openOverlay({ node, labelledBy: titleId });
  }

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  let pendingGo = null;

  function isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function onKeyDown(event) {
    if (event.key === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey) {
      event.preventDefault();
      if (palette.isOpen) palette.close();
      else palette.open();
      return;
    }
    if (event.key === 'Escape') {
      if (pendingGo) {
        clearTimeout(pendingGo.timer);
        pendingGo = null;
      }
      if (closeTopOverlay()) event.preventDefault();
      return;
    }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping(event.target) || overlayStack.length) return;

    if (pendingGo) {
      const target = VIEWS.find((v) => v.key === event.key.toLowerCase());
      clearTimeout(pendingGo.timer);
      pendingGo = null;
      if (target) {
        event.preventDefault();
        navigate(`#/${target.id}`);
      }
      return;
    }

    if (event.key === 'g') {
      // Two-key sequence, so single letters stay free for the views themselves.
      pendingGo = { timer: setTimeout(() => { pendingGo = null; }, 1400) };
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      palette.open();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      showShortcuts();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Theme                                                             */
  /* ---------------------------------------------------------------- */

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') {
      root.setAttribute('data-theme', theme);
      root.style.colorScheme = theme;
    } else {
      root.removeAttribute('data-theme');
      root.style.colorScheme = 'light dark';
    }
  }

  function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(state.get('theme')) + 1) % order.length];
    state.set('theme', next);
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  async function start() {
    dom.topbar = document.getElementById('topbar');
    dom.rail = document.getElementById('rail');
    dom.view = document.getElementById('view');
    dom.toasts = document.getElementById('toasts');
    dom.overlays = document.getElementById('overlays');
    if (!dom.topbar || !dom.rail || !dom.view) {
      throw new Error('Das Grundgerüst der Seite fehlt (index.html wurde nicht vollständig geladen).');
    }

    applyTheme(state.get('theme'));
    state.on('theme', (theme) => {
      applyTheme(theme);
      writeStored(STORAGE.theme, theme);
      renderChrome();
    });

    // Following the system preference means re-rendering when it changes.
    try {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (state.get('theme') === 'system') applyTheme('system');
      };
      if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
      else if (typeof media.addListener === 'function') media.addListener(onChange);
    } catch {
      /* matchMedia missing: the CSS media query still does the right thing */
    }

    buildRail();
    buildTopbar();

    for (const key of ['status', 'statusStale', 'connected', 'approvals']) {
      state.on(key, () => renderChrome());
    }

    // Set the initial address BEFORE listening, so the first render happens
    // once rather than twice (hashchange would otherwise re-enter renderRoute).
    if (!window.location.hash || window.location.hash === '#') {
      const last = readStored(STORAGE.lastRoute, null);
      window.location.replace(`${window.location.pathname}${window.location.search}${last || `#/${DEFAULT_VIEW}`}`);
    }

    on(window, 'hashchange', onHashChange);
    on(document, 'keydown', onKeyDown);

    const route = parseRoute(window.location.hash);
    state.set('route', route);
    renderRoute(route);

    startEventStream();
    await refreshStatus();
    refreshApprovals();
    state.set('ready', true);
    renderChrome();

    // Onboarding waits for the first status, so it can name what is missing.
    showOnboarding(false);

    registerServiceWorker(toast);

    on(window, 'beforeunload', () => {
      if (eventStream) eventStream.close();
    });
  }

  return {
    start,
    state,
    bus,
    navigate,
    toast,
    confirm: confirmDialog,
    palette,
    refreshStatus,
    get route() {
      return state.get('route');
    },
  };
}

/* ------------------------------------------------------------------ */
/* Status interpretation -- shared by header, onboarding and palette   */
/* ------------------------------------------------------------------ */

/**
 * The network indicator. Its whole value lies in never being optimistic:
 * without a fresh `/api/status` it reports "unbekannt", because claiming
 * "Offline" without evidence would be exactly the kind of comfortable lie
 * this application exists to avoid.
 */
export function describeNetwork(status, stale) {
  const mode = status && status.network ? status.network.mode : null;
  if (stale || !mode) {
    return {
      key: 'unknown',
      label: 'Netz unbekannt',
      hint: 'Der Serverstatus ist gerade nicht abrufbar. Es wird kein Netzzustand behauptet.',
    };
  }
  const strict = status.network.strictAllowlist !== false;
  if (mode === 'offline') {
    return { key: 'offline', label: 'Offline', hint: 'Nur dieses Gerät. Ein lokales Modell auf 127.0.0.1 gilt nicht als Netzzugriff und läuft weiter.' };
  }
  if (mode === 'lan') {
    return { key: 'lan', label: 'LAN', hint: 'Dieses Gerät und dein lokales Netzwerk. Kein öffentliches Internet.' };
  }
  if (mode === 'online') {
    return {
      key: 'online',
      label: 'Online',
      hint: strict
        ? 'Öffentliches Internet erlaubt, begrenzt auf die freigegebenen Hosts.'
        : 'Öffentliches Internet erlaubt – ohne Allowlist-Begrenzung.',
    };
  }
  return { key: 'unknown', label: `Netz: ${mode}`, hint: 'Unbekannter Netzmodus. Prüfe die Konfiguration.' };
}

export function countModels(models) {
  if (!models) return 0;
  if (Number.isFinite(models.count)) return models.count;
  const providers = Array.isArray(models.providers) ? models.providers : [];
  let total = 0;
  for (const provider of providers) {
    if (Array.isArray(provider.models)) total += provider.models.length;
  }
  return total;
}

export function describeModels(status, stale) {
  const models = status ? status.models : null;
  if (stale || !models) {
    return { key: 'unknown', label: 'Modell unbekannt', hint: 'Der Modellstatus ist gerade nicht abrufbar.' };
  }
  const count = countModels(models);
  const available = models.available === true || count > 0;
  if (!available) {
    return {
      key: 'none',
      label: 'Kein Modell',
      hint: 'Kein lokales Modell erreichbar. Mit „ollama pull llama3.2“ installierst du eines; danach funktioniert der Chat ohne Internet.',
    };
  }
  const preferred = models.default || models.active || null;
  const name = preferred && (preferred.model || preferred.id || preferred.name);
  const providers = (Array.isArray(models.providers) ? models.providers : []).filter((p) => p.available);
  const via = providers.length ? providers.map((p) => p.id || p.kind).join(', ') : null;
  return {
    key: 'ok',
    label: name ? String(name) : `${count} Modell${count === 1 ? '' : 'e'}`,
    hint: `${count} Modell${count === 1 ? '' : 'e'} verfügbar${via ? ` über ${via}` : ''}. Läuft lokal.`,
  };
}

export function describeVault(status, stale) {
  const vault = status ? status.vault : null;
  const vaultState = vault ? (vault.state || vault.encryption) : null;
  if (stale || !vaultState) {
    return { key: 'unknown', label: 'Tresor unbekannt', hint: 'Der Zustand des Tresors ist gerade nicht abrufbar.' };
  }
  const records = vault.records ?? (vault.counts ? Object.values(vault.counts).reduce((a, b) => a + (Number(b) || 0), 0) : null);
  const suffix = Number.isFinite(records) ? ` ${formatNumber(records)} Einträge.` : '';
  if (vaultState === 'locked') {
    return { key: 'locked', label: 'Tresor gesperrt', hint: `Die Daten sind verschlüsselt und nicht lesbar, bis du entsperrst.${suffix}` };
  }
  if (vaultState === 'unlocked') {
    return { key: 'unlocked', label: 'Tresor offen', hint: `Verschlüsselt auf der Festplatte, für diese Sitzung entsperrt.${suffix}` };
  }
  return { key: 'plain', label: 'Unverschlüsselt', hint: `Der Tresor ist nicht verschlüsselt. In den Einstellungen kannst du das ändern.${suffix}` };
}

function recordTypeLabel(type) {
  const labels = {
    note: 'Notiz', chat: 'Chat', message: 'Nachricht', project: 'Projekt', task: 'Aufgabe',
    agent: 'Agent', run: 'Lauf', file: 'Datei', entity: 'Begriff', memory: 'Erinnerung', edge: 'Verknüpfung',
  };
  return labels[type] || type || '';
}

function iconForType(type) {
  const map = {
    note: ICONS.notes, chat: ICONS.chat, message: ICONS.chat, project: ICONS.projects,
    task: ICONS.projects, agent: ICONS.agents, run: ICONS.agents, file: ICONS.notes,
    entity: ICONS.graph, memory: ICONS.graph,
  };
  return map[type] || ICONS.search;
}

function targetForRecord(record) {
  const id = encodeURIComponent(record.id);
  switch (record.type) {
    case 'note': return `#/notes?id=${id}`;
    case 'chat': return `#/chat?id=${id}`;
    case 'message': return `#/chat?id=${encodeURIComponent((record.data && record.data.chatId) || record.id)}`;
    case 'project':
    case 'task': return `#/projects?id=${id}`;
    case 'agent':
    case 'run': return `#/agents?id=${id}`;
    default: return `#/graph?focus=${id}`;
  }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function isMac() {
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
}

/** localStorage can throw (private mode, disabled storage): never let it break boot. */
function readStored(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference simply does not survive a reload */
  }
}

function readTheme() {
  const value = readStored(STORAGE.theme, 'system');
  return ['light', 'dark', 'system'].includes(value) ? value : 'system';
}

/**
 * The service worker only caches the shell so the interface opens instantly
 * and still opens when the server is down. It is optional: a browser without
 * it (or a page served over file://) loses nothing but that head start.
 *
 * An update is never forced on a running session -- half of one build and half
 * of another is a genuinely confusing failure mode. The new worker waits, the
 * user is offered a reload once, and takes it when it suits them.
 */
function registerServiceWorker(notify) {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(window.location.protocol)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: './' })
    .then((registration) => {
      const offerUpdate = (worker) => {
        if (!worker || !navigator.serviceWorker.controller) return;
        notify('Eine neue Version der Oberfläche ist bereit.', 'info', {
          timeout: 0,
          action: { label: 'Neu laden', run: () => worker.postMessage({ type: 'SKIP_WAITING' }) },
        });
      };
      if (registration.waiting) offerUpdate(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') offerUpdate(worker);
        });
      });
    })
    .catch((err) => console.warn('[neural-os] Service Worker nicht registriert:', err && err.message));
}

/* ------------------------------------------------------------------ */

const shell = createShell();

shell.start().catch((err) => {
  // The shell itself failed. Say so in plain German instead of a white page.
  console.error('[neural-os] Start fehlgeschlagen:', err);
  const container = document.getElementById('view') || document.body;
  clear(container);
  container.appendChild(h('div.view-state.view-state--error', { role: 'alert' },
    h('h2.view-state__title', null, text('Die Oberfläche konnte nicht starten')),
    h('p.view-state__text', null, text(err && err.message ? err.message : String(err))),
    h('div.view-state__actions', null,
      h('button.btn.btn--primary', { type: 'button', onClick: () => window.location.reload() }, text('Neu laden')))));
});

// A single read-only handle for debugging from the browser console. Nothing in
// the application reads it; it exists so a user can inspect what the UI knows.
window.__neuralOS = shell;

export default shell;
