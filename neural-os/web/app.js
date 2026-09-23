/**
 * app.js -- die Schale: Leiste, mittlere Karte, rechte Spalte, Router,
 * Zustand, Live-Ereignisse, Befehlspalette.
 *
 * Vorlage ist docs/vorlage/app.png. Was diese Datei besitzt, und warum sie so
 * gebaut ist:
 *
 * - **Drei Spalten, zwei davon einklappbar.** Links die Leiste mit den
 *   Bereichen und den letzten Chats, in der Mitte die Karte mit der Ansicht,
 *   rechts vier Kacheln. Der Nutzer wollte woertlich "die Seiten wegklappen
 *   und ausklappen koennen" -- eingeklappt bleibt nur der Chat. Der Zustand
 *   wird je Bildschirmklasse gemerkt (breit / mittel); unter 1000 px sind
 *   die Seiten Schubladen ueber dem Chat und starten immer zu.
 * - **Der Status unten links sagt nur, was gemessen ist.** Netzmodus aus
 *   `/api/status`, Claude aus `/api/claude`. Ist etwas davon nicht abrufbar,
 *   steht "unbekannt" da und nicht die letzte bequeme Antwort.
 * - **Ansichten und Kacheln sind unabhaengig und duerfen fehlen.** Beide
 *   werden nach Bedarf aus einer festen Liste importiert (nie direkt aus der
 *   Adresse). Ein Modul, das nicht laedt, ergibt eine Fehlerflaeche mit
 *   "Erneut versuchen" -- nie eine leere Seite.
 * - **Ein Ereignisstrom.** Alle Live-Aenderungen kommen ueber eine einzige
 *   SSE-Verbindung mit Wiederaufnahme ab `since`. Es gibt keinen zweiten
 *   Weg, der den Bildschirm ohne ein echtes Server-Ereignis veraendert.
 * - **Kein Inline-Skript.** Der Server sendet `script-src 'self'`; auch die
 *   Darstellung wird deshalb hier gesetzt und nicht in index.html.
 */

import { h, text, clear, on, list, icon, cx, frag, timeAgo, formatNumber, formatDate, debounce, snippet } from './lib/dom.js';
import { api, ApiError } from './lib/api.js';

const APP_VERSION = '2';
const STORAGE = {
  theme: 'neural-os:theme',
  chat: 'neural-os:active-chat',
  // Eingeklappt oder offen, je Bildschirmklasse: wer auf dem Laptop die
  // rechte Spalte zuklappt, will sie deshalb nicht auch auf dem iPad zu haben.
  seiten: 'neural-os:seiten',
};

/* ------------------------------------------------------------------ */
/* Symbole: 20x20, currentColor, als Text im Quelltext, keine Dateien.  */
/* ------------------------------------------------------------------ */

const ICONS = {
  // Das Zeichen der App: eine Umlaufbahn (das System) und ein Knoten in ihrer
  // Mitte, der ueber den Rand hinaus eine Verbindung haelt (das Neuron). Es
  // steht auch in tools/make-icons.js (MARK) und im Favicon in index.html --
  // ein Test in test/server.test.js wacht darueber, dass es dasselbe bleibt.
  brand: '<path d="M16.2 7.1A6.8 6.8 0 1 1 12.9 3.8"/><path d="M11.6 8.4 13.6 6.4"/><circle cx="14.8" cy="5.2" r="1.5" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none"/>',
  chat: '<path d="M4.2 4h11.6A1.7 1.7 0 0 1 17.5 5.7v7.1a1.7 1.7 0 0 1-1.7 1.7H9.4L6 17.2v-2.7H4.2a1.7 1.7 0 0 1-1.7-1.7V5.7A1.7 1.7 0 0 1 4.2 4z"/><path d="M6.4 8h7.2M6.4 10.9h4.6"/>',
  calendar: '<rect x="3" y="4.2" width="14" height="13" rx="2.4"/><path d="M3 8.4h14M6.8 2.6v3.2M13.2 2.6v3.2"/>',
  notes: '<path d="M5.4 2.7h5.9l3.9 3.9v9.1a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6V4.3a1.6 1.6 0 0 1 1.6-1.6z"/><path d="M11.1 2.9v3.9h3.9M6.8 10.4h6.4M6.8 13.4h4.2"/>',
  projects: '<path d="M2.6 6a1.8 1.8 0 0 1 1.8-1.8h3.1l1.8 2h6.3a1.8 1.8 0 0 1 1.8 1.8v6.6a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M2.6 8.6h14.8"/>',
  agents: '<circle cx="10" cy="5.6" r="2.6"/><circle cx="5.4" cy="14" r="2.6"/><circle cx="14.6" cy="14" r="2.6"/>',
  // Das Gehirn als Gehirn, nicht als Netz aus Punkten: so heisst der Bereich.
  graph: '<path d="M9.4 3.6a2.6 2.6 0 0 0-4.5 1.2 2.7 2.7 0 0 0-1.8 4 2.8 2.8 0 0 0 .6 4.5 2.7 2.7 0 0 0 3.2 2.9 2.4 2.4 0 0 0 2.5 1.1z"/><path d="M10.6 3.6a2.6 2.6 0 0 1 4.5 1.2 2.7 2.7 0 0 1 1.8 4 2.8 2.8 0 0 1-.6 4.5 2.7 2.7 0 0 1-3.2 2.9 2.4 2.4 0 0 1-2.5 1.1z"/><path d="M10 3.3v14M6.6 7.6h1.6M13.4 11.6h-1.6M6.9 12.6l1.3-1"/>',
  workshop: '<path d="M12.9 3a3.9 3.9 0 0 0-4.6 5l-5 5a1.7 1.7 0 0 0 2.4 2.4l5-5a3.9 3.9 0 0 0 5-4.6l-2.2 2.2-2.1-.5-.5-2.1z"/>',
  settings: '<circle cx="10" cy="10" r="2.5"/><path d="M8.6 2.8h2.8l.4 1.9 1.5.8 1.8-.7 1.4 2.4-1.4 1.3v1.7l1.4 1.3-1.4 2.4-1.8-.7-1.5.8-.4 1.9H8.6l-.4-1.9-1.5-.8-1.8.7-1.4-2.4 1.4-1.3V9.3L3.5 8l1.4-2.4 1.8.7 1.5-.8z"/>',
  network: '<path d="M10 2.4 16 4.7v4.8c0 3.3-2.4 6.2-6 7.4-3.6-1.2-6-4.1-6-7.4V4.7z"/><path d="m7.5 9.9 1.8 1.8 3.3-3.5"/>',
  cloud: '<path d="M6.2 15.6h8.1a3.3 3.3 0 0 0 .4-6.6 4.7 4.7 0 0 0-9-.9 3.8 3.8 0 0 0 .5 7.5z"/>',
  cloudOff: '<path d="M6.2 15.6h8.1a3.3 3.3 0 0 0 .4-6.6 4.7 4.7 0 0 0-9-.9 3.8 3.8 0 0 0 .5 7.5z"/><path d="M3.4 3.4l13.2 13.2"/>',
  collapse: '<path d="M9.6 5.6 5.2 10l4.4 4.4M14.8 5.6 10.4 10l4.4 4.4"/>',
  expand: '<path d="M5.2 5.6 9.6 10l-4.4 4.4M10.4 5.6 14.8 10l-4.4 4.4"/>',
  panelLeft: '<rect x="2.8" y="3.6" width="14.4" height="12.8" rx="2.6"/><path d="M7.8 3.6v12.8"/>',
  panelRight: '<rect x="2.8" y="3.6" width="14.4" height="12.8" rx="2.6"/><path d="M12.2 3.6v12.8"/>',
  search: '<circle cx="8.8" cy="8.8" r="5.2"/><path d="m12.7 12.7 4 4"/>',
  // Fuer den Chat und die Kacheln: dieselbe Linie, dieselbe Staerke.
  clip: '<path d="M14.6 9.2 9.4 14.4a3.3 3.3 0 0 1-4.7-4.7l5.6-5.6a2.2 2.2 0 0 1 3.1 3.1l-5.4 5.4a1.1 1.1 0 0 1-1.6-1.6l4.9-4.9"/>',
  send: '<path d="M10 15.6V4.6M5.4 9.2 10 4.6l4.6 4.6"/>',
  list: '<path d="M7.6 5.6h9M7.6 10h9M7.6 14.4h9"/><path d="M3.6 5.6h.01M3.6 10h.01M3.6 14.4h.01" stroke-width="2.2"/>',
  question: '<path d="M10 16.6a6.6 6.6 0 1 0-5.9-3.6L3.2 16.8l3.8-.9A6.6 6.6 0 0 0 10 16.6z"/>',
  checkCircle: '<circle cx="10" cy="10" r="7.4"/><path d="m6.8 10.2 2.2 2.2 4.2-4.6"/>',
  globe: '<circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c2 2 2.9 4.4 2.9 7.2s-.9 5.2-2.9 7.2c-2-2-2.9-4.4-2.9-7.2s.9-5.2 2.9-7.2z"/>',
  clipboard: '<rect x="4.2" y="3.6" width="11.6" height="13.8" rx="2"/><path d="M7.6 3.6V2.8h4.8v.8M7.2 8.6h5.6M7.2 11.4h5.6M7.2 14.2h3.4"/>',
  pen: '<path d="M12.8 3.8a1.9 1.9 0 0 1 2.7 2.7l-8.6 8.6-3.6.9.9-3.6z"/><path d="m11.4 5.2 2.7 2.7"/>',
  clock: '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.4V10l3.2 1.9"/>',
  sun: '<circle cx="10" cy="10" r="3.4"/><path d="M10 1.8v2.1M10 16.1v2.1M1.8 10h2.1M16.1 10h2.1M4.2 4.2l1.5 1.5M14.3 14.3l1.5 1.5M15.8 4.2l-1.5 1.5M5.7 14.3l-1.5 1.5"/>',
  moon: '<path d="M16.2 11.6A6.7 6.7 0 0 1 8.4 3.8a6.7 6.7 0 1 0 7.8 7.8z"/>',
  system: '<rect x="2.4" y="3.8" width="15.2" height="10.4" rx="2.2"/><path d="M7 17.2h6"/>',
  command: '<rect x="3" y="3" width="14" height="14" rx="3.6"/><path d="M7.4 8.4h5.2M7.4 11.6h3"/>',
  close: '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>',
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  info: '<circle cx="10" cy="10" r="7.4"/><path d="M10 9.2v4.4M10 6.5h.01"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  lock: '<rect x="4.4" y="8.6" width="11.2" height="8" rx="2.6"/><path d="M7 8.6V6.3a3 3 0 0 1 6 0v2.3"/>',
  unlock: '<rect x="4.4" y="8.6" width="11.2" height="8" rx="2.6"/><path d="M7 8.6V6.3a3 3 0 0 1 5.7-1.3"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  arrow: '<path d="M3.8 10h11.4M11 5.8l4.2 4.2-4.2 4.2"/>',
  more: '<circle cx="4.6" cy="10" r="1.25"/><circle cx="10" cy="10" r="1.25"/><circle cx="15.4" cy="10" r="1.25"/>',
  keyboard: '<rect x="2.4" y="5" width="15.2" height="10" rx="2.4"/><path d="M5.6 8.2h.01M8.4 8.2h.01M11.2 8.2h.01M14 8.2h.01M6.6 11.6h6.8"/>',
  // Ein USB-Stick: Gehaeuse mit Kontaktstueck -- der Bereich handelt von
  // DIESEM Gegenstand, den man in der Hand haelt.
  stick: '<rect x="6.6" y="6.2" width="6.8" height="11.2" rx="1.6"/>'
    + '<path d="M8.4 6.2V3.4a1.6 1.6 0 0 1 1.6-1.6h0a1.6 1.6 0 0 1 1.6 1.6v2.8"/>'
    + '<path d="M8.8 10.2h2.4M8.8 12.8h2.4"/>',
  // Ein Tresor mit Buegel: Verwahren an einem Ort, den man selbst in der
  // Hand hat -- nicht Hochladen, nicht Herunterladen.
  backup: '<rect x="3" y="7.6" width="14" height="9.2" rx="2.2"/>'
    + '<path d="M6.4 7.6V5.4a3.6 3.6 0 0 1 7.2 0v2.2"/>'
    + '<circle cx="10" cy="12" r="1.5"/>',
};

/**
 * Die Bereiche.
 *
 * `nav` entscheidet, was in der Leiste steht -- genau die acht Eintraege der
 * Vorlage, in ihrer Reihenfolge. Netzwerk, Stick und Sicherung bleiben als
 * Adresse, Tastenkuerzel und Paletten-Eintrag erreichbar; der Status unten
 * links fuehrt ins Netzwerk, die Einstellungen zu Stick und Sicherung.
 * `parent` markiert fuer diese drei den Eintrag, unter dem man sie findet.
 * `head` ist der Kopf der mittleren Karte, solange die Ansicht keinen eigenen
 * setzt (ctx.setTitle).
 */
const VIEWS = [
  { id: 'chat', title: 'Neuer Chat', head: 'Neuer Chat', icon: ICONS.chat, key: 'c', nav: true, keywords: 'chat unterhaltung fragen gespräch claude ki neu' },
  { id: 'kalender', title: 'Kalender', icon: ICONS.calendar, key: 'k', nav: true, keywords: 'termine datum uhrzeit woche tag heute' },
  { id: 'notes', title: 'Notizen', icon: ICONS.notes, key: 'n', nav: true, keywords: 'note texte wissen schreiben post-it' },
  { id: 'projects', title: 'Projekte', icon: ICONS.projects, key: 'p', nav: true, keywords: 'aufgaben tasks vorhaben' },
  { id: 'agents', title: 'Agenten', icon: ICONS.agents, key: 'a', nav: true, keywords: 'helfer hintergrund läufe runs arbeitet' },
  { id: 'graph', title: 'Gehirn', icon: ICONS.graph, key: 'g', nav: true, keywords: 'graph netz verknüpfungen karte gedächtnis wissen' },
  { id: 'workshop', title: 'Werkstatt', icon: ICONS.workshop, key: 'w', nav: true, keywords: 'erweiterungen module code einfügen ändern plugin anpassen' },
  { id: 'settings', title: 'Einstellungen', icon: ICONS.settings, key: 'e', nav: true, keywords: 'konfiguration tresor pin claude schlüssel darstellung' },
  { id: 'network', title: 'Netzwerk', icon: ICONS.network, key: 'i', nav: false, parent: 'settings', keywords: 'internet online offline schleuse gate freigaben protokoll' },
  { id: 'stick', title: 'Stick', icon: ICONS.stick, key: 't', nav: false, parent: 'settings', keywords: 'usb portabel mitnehmen unterwegs laufzeit fremder rechner' },
  { id: 'backup', title: 'Sicherung', icon: ICONS.backup, key: 'b', nav: false, parent: 'settings', keywords: 'export import backup wiederherstellen notfall kopie' },
];

const VIEW_IDS = new Set(VIEWS.map((v) => v.id));
const DEFAULT_VIEW = 'chat';

/**
 * Ansichten, die es nicht mehr gibt (Entscheidung des Nutzers: Heute,
 * Vorschlaege, Automatik, Zeitachse, Abgleich). Eine alte Adresse aus einem
 * Lesezeichen fuehrt in den Chat statt auf "Diesen Bereich gibt es nicht".
 * `search` ist keine Ansicht mehr, sondern die Befehlspalette (Strg+K).
 */
const ENTFALLEN = new Set(['today', 'assist', 'automation', 'timeline', 'sync']);

/**
 * Die Kacheln der rechten Spalte, von oben nach unten. Jede ist ein eigenes
 * Modul web/widgets/<kachel>.js mit
 *   export function mount(el, ctx) { ...; return { unmount() {} } }
 * Die Schale legt das leere <section class="tile"> an und haengt es ein;
 * alles darin gehoert dem Modul.
 */
const TILES = [
  { kachel: 'agenten', title: 'Agenten aktiv', icon: ICONS.agents, href: '#/agents' },
  { kachel: 'kalender', title: 'Kalender', icon: ICONS.calendar, href: '#/kalender' },
  { kachel: 'notizen', title: 'Notizen', icon: ICONS.notes, href: '#/notes' },
  { kachel: 'gehirn', title: 'Gehirn', icon: ICONS.graph, href: '#/graph', grow: true },
];

/**
 * Bildschirmklassen. Dieselben Grenzen stehen in web/app.css, Abschnitt 12.
 * breit  >= 1280: Leiste und Spalte offen
 * mittel 1000-1279 (iPad quer 1180): Leiste offen, Spalte zu
 * schmal < 1000 (iPad hoch, Telefon): beide als Schublade, zu
 */
const MEDIA_SCHMAL = '(max-width: 999px)';
const MEDIA_MITTEL = '(max-width: 1279px)';
const SEITEN_VORGABE = {
  breit: { links: true, rechts: true },
  mittel: { links: true, rechts: false },
  schmal: { links: false, rechts: false },
};

/* ------------------------------------------------------------------ */
/* Reaktiver Zustand (Vertrag, Abschnitt 13)                           */
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
      // Objekte werden als Ganzes ersetzt, also ist Identitaet ein guter Test.
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
/* Adressen                                                            */
/* ------------------------------------------------------------------ */

/**
 * `#/graph?focus=note_x` -> `{view:'graph', segments:[], params:{focus:'note_x'}}`
 * Der zweite Pfadteil wird als `params.id` angeboten: `#/chat/chat_123` und
 * `#/chat?id=chat_123` sind dieselbe Adresse.
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
    /* eine von Hand verbogene Adresse ist keinen Absturz wert */
  }
  if (segments[1] && params.id === undefined) params.id = segments[1];
  const hash = `#/${segments.length ? segments.join('/') : DEFAULT_VIEW}${queryPart ? `?${queryPart}` : ''}`;
  return { view, segments: segments.slice(1), params, hash, known: VIEW_IDS.has(view) };
}

/**
 * Der Kopf einer Kachel, fuer alle vier gleich gebaut: Symbol, Titel,
 * optional eine Zahl ("Agenten aktiv 3") und rechts eine leise Randnotiz
 * ("Automatisch erkannt", "Heute, 23. Sept."). Mit `href` wird der ganze
 * Kopf zum Link in den Bereich.
 */
export function tileHead({ icon: markup, title, count, meta, href } = {}) {
  return h(href ? 'a.tile__head' : 'header.tile__head', href ? { href } : null,
    markup ? h('span.tile__icon', { 'aria-hidden': 'true' }, icon(markup)) : null,
    h('h2.tile__title', null, text(title || '')),
    count !== undefined && count !== null ? h('span.tile__count', null, text(String(count))) : null,
    meta ? h('span.tile__meta', null, text(meta)) : null);
}

/* ------------------------------------------------------------------ */
/* Die Schale                                                          */
/* ------------------------------------------------------------------ */

function createShell() {
  const state = createState({
    status: null,
    statusStale: true,
    statusError: null,
    network: null,
    models: null,
    vault: null,
    claude: null,
    approvals: [],
    recentChats: [],
    theme: readTheme(),
    connected: false,
    activeChatId: readStored(STORAGE.chat, null),
    route: parseRoute(window.location.hash),
    seiten: null,
    ready: false,
  });

  const busListeners = new Map();
  const dom = {};
  const viewCache = new Map();
  const tiles = new Map();
  let tilesMounted = false;
  let mountToken = 0;
  let currentView = null;
  let renderedRoute = null;
  let eventStream = null;

  /* ---------------------------------------------------------------- */
  /* Live-Ereignisse vom Server                                        */
  /* ---------------------------------------------------------------- */

  const bus = {
    /** @returns {() => void} abmelden */
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
  /* Status: die einzige Quelle fuer das, was unten links steht        */
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
      await refreshClaude(status);
      return status;
    } catch (err) {
      // Ab jetzt behauptet der Status keinen Netzmodus mehr, den er nicht
      // pruefen kann.
      state.set('statusStale', true);
      state.set('statusError', err instanceof ApiError ? err.message : String(err));
      renderChrome();
      return null;
    }
  }

  /**
   * Claude ist die KI dieser Anwendung; ob sie verbunden ist, gehoert in den
   * Status. Die Route kommt aus dem Bereich Claude-Unterbau
   * (GET /api/claude -> { verbunden, modell, schluesselVorhanden }). Fehlt
   * sie, ist die Antwort "nicht bekannt" -- nicht "verbunden".
   */
  let claudeRouteFehlt = false;

  async function refreshClaude(status) {
    if (status && status.claude && typeof status.claude === 'object') {
      state.set('claude', { bekannt: true, ...status.claude });
      return;
    }
    // Offline ist Claude ohnehin nicht erreichbar; der Status sagt dann
    // "Offline", und gefragt wird gar nicht erst. Antwortet der Server mit
    // 404, kennt er die Route nicht -- dann wird bis zum Neuladen nicht
    // wieder gefragt, statt jede Minute denselben Fehler zu erzeugen.
    const mode = status && status.network ? status.network.mode : null;
    if (mode !== 'online' || claudeRouteFehlt) {
      state.set('claude', { bekannt: false });
      return;
    }
    try {
      const claude = await api.get('/claude', { timeoutMs: 6000 });
      state.set('claude', claude && typeof claude === 'object' ? { bekannt: true, ...claude } : { bekannt: false });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) claudeRouteFehlt = true;
      state.set('claude', { bekannt: false });
    }
  }

  const refreshStatusSoon = debounce(() => {
    refreshStatus();
  }, 500);

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
      // Freigaben sind optional. Eine leere Liste ist hier die ehrliche
      // Antwort: es ist nichts bekannt, das wartet.
      if (!(err instanceof ApiError) || err.status !== 503) console.warn('[neural-os] Freigaben nicht abrufbar:', err && err.message);
      state.set('approvals', []);
    }
  }

  const refreshApprovalsSoon = debounce(() => {
    refreshApprovals();
  }, 300);

  /* --------------------------- letzte Chats ------------------------- */

  async function refreshRecent() {
    try {
      const result = await api.get('/chats', { query: { limit: 12, sort: 'updatedAt', order: 'desc' }, timeoutMs: 8000 });
      const items = (Array.isArray(result) ? result : (result && Array.isArray(result.items) ? result.items : []))
        .filter((row) => row && row.id && !row.deletedAt);
      state.set('recentChats', items);
    } catch (err) {
      // Die Liste bleibt, wie sie war; sie ist eine Abkuerzung, keine Wahrheit.
      console.warn('[neural-os] Letzte Chats nicht abrufbar:', err && err.message);
    }
  }

  const refreshRecentSoon = debounce(() => {
    refreshRecent();
  }, 700);

  function handleServerEvent(event) {
    dispatchBus(event);
    const type = event.type || '';
    const payload = event.payload || {};

    // Nicht jedes network.*-Ereignis: jeder einzelne Zugriff nach draussen
    // (jede Claude-Anfrage) meldet sich als network.allow. Den Status aendert
    // nur ein Wechsel des Modus.
    if (type === 'models.changed' || type === 'config.changed' || type.startsWith('vault.')
      || type === 'network.mode' || type.startsWith('claude')) {
      refreshStatusSoon();
    }
    if (type.startsWith('record.') && (payload.type === 'chat' || (payload.record && payload.record.type === 'chat'))) {
      refreshRecentSoon();
    }
    if (type === 'chat.created') refreshRecentSoon();
    if (type.startsWith('approval.')) {
      refreshApprovalsSoon();
      if (type === 'approval.requested') {
        const summary = payload.record && payload.record.data ? payload.record.data.summary : null;
        toast(summary ? `Freigabe erbeten: ${summary}` : 'Ein Agent bittet um eine Freigabe.', 'info', {
          action: { label: 'Ansehen', run: () => navigate('#/agents') },
          timeout: 12000,
        });
      }
    } else if (type === 'run.failed') {
      const message = payload.error && payload.error.message;
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
          // Nach einer Unterbrechung kann eine Aenderung verpasst sein.
          refreshStatus();
          refreshApprovals();
          refreshRecent();
        }
        renderChrome();
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Seiten ein- und ausklappen                                        */
  /* ---------------------------------------------------------------- */

  function currentMode() {
    try {
      if (window.matchMedia(MEDIA_SCHMAL).matches) return 'schmal';
      if (window.matchMedia(MEDIA_MITTEL).matches) return 'mittel';
    } catch {
      /* ohne matchMedia gilt die breite Aufteilung */
    }
    return 'breit';
  }

  /** Gemerkter Zustand dieser Bildschirmklasse, sonst die Vorgabe. */
  function storedSides(mode) {
    const fallback = { ...SEITEN_VORGABE[mode] };
    // Schmal wird nie gemerkt: eine Schublade, die beim Laden offen ist,
    // deckt den Chat zu, bevor man ihn gesehen hat.
    if (mode === 'schmal') return fallback;
    try {
      const all = JSON.parse(readStored(STORAGE.seiten, '{}')) || {};
      const saved = all[mode] || {};
      return {
        links: typeof saved.links === 'boolean' ? saved.links : fallback.links,
        rechts: typeof saved.rechts === 'boolean' ? saved.rechts : fallback.rechts,
      };
    } catch {
      return fallback;
    }
  }

  function rememberSides(mode, sides) {
    if (mode === 'schmal') return;
    let all = {};
    try {
      all = JSON.parse(readStored(STORAGE.seiten, '{}')) || {};
    } catch {
      all = {};
    }
    all[mode] = { links: sides.links, rechts: sides.rechts };
    writeStored(STORAGE.seiten, JSON.stringify(all));
  }

  function applySides() {
    const sides = state.get('seiten');
    if (!sides || !dom.shell) return;
    dom.shell.dataset.links = sides.links ? 'offen' : 'zu';
    dom.shell.dataset.rechts = sides.rechts ? 'offen' : 'zu';
    dom.shell.dataset.modus = sides.modus;

    const leftLabel = sides.links ? 'Seitenleiste einklappen' : 'Seitenleiste ausklappen';
    for (const button of [dom.collapseLeft, dom.expandLeft]) {
      if (!button) continue;
      button.setAttribute('aria-expanded', sides.links ? 'true' : 'false');
    }
    if (dom.collapseLeft) dom.collapseLeft.title = leftLabel;
    if (dom.toggleRight) {
      const rightLabel = sides.rechts ? 'Übersicht einklappen' : 'Übersicht ausklappen';
      dom.toggleRight.setAttribute('aria-expanded', sides.rechts ? 'true' : 'false');
      dom.toggleRight.setAttribute('aria-label', rightLabel);
      dom.toggleRight.title = rightLabel;
    }
    // Die Kacheln werden erst geladen, wenn die Spalte zum ersten Mal zu
    // sehen ist -- auf dem iPad hochkant vielleicht nie.
    if (sides.rechts) mountTiles();
  }

  /**
   * @param {'links'|'rechts'} side
   * @param {boolean} open
   * @param {{fokus?:boolean}} [opts]
   */
  function setSide(side, open, opts = {}) {
    const current = state.get('seiten') || { ...storedSides(currentMode()), modus: currentMode() };
    if (current[side] === open) return;
    const next = { ...current, [side]: open };
    // In der Schublade liegt immer nur eine Seite ueber dem Chat.
    if (next.modus === 'schmal' && open) next[side === 'links' ? 'rechts' : 'links'] = false;
    state.set('seiten', next);
    rememberSides(next.modus, next);
    applySides();

    if (opts.fokus) {
      // Der Knopf, der gerade gedrueckt wurde, verschwindet mit seiner Seite.
      // Der Fokus geht zu dem Knopf, der sie wieder oeffnet -- sonst landet
      // er auf <body>, und ein Tastaturnutzer ist verloren.
      if (side === 'links' && !open && dom.expandLeft) dom.expandLeft.focus();
      else if (side === 'links' && open && dom.collapseLeft) dom.collapseLeft.focus();
    }
  }

  function toggleSide(side) {
    const sides = state.get('seiten');
    setSide(side, !(sides && sides[side]), { fokus: side === 'links' });
  }

  function closeDrawers() {
    const sides = state.get('seiten');
    if (!sides || sides.modus !== 'schmal') return false;
    if (!sides.links && !sides.rechts) return false;
    state.set('seiten', { ...sides, links: false, rechts: false });
    applySides();
    return true;
  }

  function onModeChange() {
    const mode = currentMode();
    const sides = state.get('seiten');
    if (sides && sides.modus === mode) return;
    state.set('seiten', { ...storedSides(mode), modus: mode });
    applySides();
  }

  /* ---------------------------------------------------------------- */
  /* Die Leiste                                                        */
  /* ---------------------------------------------------------------- */

  /** "Neuer Chat": kein leerer Datensatz auf Vorrat, nur eine leere Seite. */
  function startNewChat(event) {
    if (event) event.preventDefault();
    state.set('activeChatId', null);
    removeStored(STORAGE.chat);
    navigate('#/chat');
  }

  function buildRail() {
    const rail = dom.rail;
    clear(rail);

    const brand = h('a.rail__brand', {
      href: '#/chat',
      'aria-label': 'Neural OS – neuer Chat',
      onClick: startNewChat,
    },
    icon(ICONS.brand, { class: 'rail__brand-mark' }),
    h('span.rail__wordmark', { 'aria-hidden': 'true' }, text('Neural OS')));

    dom.collapseLeft = h('button.icon-button.rail__collapse', {
      type: 'button',
      'aria-label': 'Seitenleiste einklappen',
      'aria-controls': 'rail',
      onClick: () => setSide('links', false, { fokus: true }),
    }, icon(ICONS.collapse));

    const nav = h('div.rail__items', { role: 'list' });
    dom.navLinks = new Map();
    for (const view of VIEWS) {
      if (!view.nav) continue;
      const badge = h('span.rail__badge', { hidden: true });
      const link = h('a.rail__item', {
        href: `#/${view.id}`,
        role: 'listitem',
        'data-view': view.id,
        title: `${view.title} (g dann ${view.key})`,
        onClick: view.id === 'chat' ? startNewChat : null,
      },
      h('span.rail__icon', null, icon(view.icon)),
      h('span.rail__label', null, text(view.title)),
      badge);
      dom.navLinks.set(view.id, { link, badge, view });
      nav.appendChild(link);
    }

    dom.chatList = h('ul.rail__chats');
    dom.recent = h('section.rail__recent', { 'aria-label': 'Letzte Chats', hidden: true },
      h('h2.rail__recent-title', null, text('Zuletzt')),
      dom.chatList);

    dom.statusButton = h('button.rail__status', {
      type: 'button',
      onClick: () => {
        if (!state.get('connected') && state.get('ready') && eventStream) {
          eventStream.retryNow();
          refreshStatus();
          return;
        }
        navigate('#/network');
      },
    });

    rail.appendChild(h('div.rail__inner', null,
      h('div.rail__head', null, brand, dom.collapseLeft),
      nav,
      dom.recent,
      h('div.rail__foot', null, dom.statusButton)));
  }

  function renderRecent() {
    if (!dom.chatList) return;
    const items = state.get('recentChats') || [];
    const route = state.get('route');
    const activeId = route && route.view === 'chat' ? route.params.id : null;
    dom.recent.hidden = items.length === 0;
    list(dom.chatList, items, (row) => row.id, (row, existing) => {
      const title = chatTitle(row);
      const href = `#/chat?id=${encodeURIComponent(row.id)}`;
      const node = existing || h('li', null, h('a.rail__chat', { href }, h('span')));
      const link = node.firstChild;
      const label = link.firstChild;
      if (label.textContent !== title) {
        clear(label);
        label.appendChild(text(title));
      }
      link.title = title;
      link.classList.toggle('is-active', row.id === activeId);
      if (row.id === activeId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
      return node;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Kopf der mittleren Karte                                          */
  /* ---------------------------------------------------------------- */

  function buildTopbar() {
    const bar = dom.topbar;
    clear(bar);

    dom.expandLeft = h('button.icon-button.topbar__expand', {
      type: 'button',
      'aria-label': 'Seitenleiste ausklappen',
      title: 'Seitenleiste ausklappen',
      'aria-controls': 'rail',
      onClick: () => setSide('links', true, { fokus: true }),
    }, icon(ICONS.expand));

    dom.routeTitle = h('h1.topbar__title', null, text('Neural OS'));
    dom.headSlot = h('div.topbar__slot');

    dom.connChip = h('button.chip.chip--warn', {
      type: 'button',
      hidden: true,
      onClick: () => {
        if (eventStream) eventStream.retryNow();
        refreshStatus();
      },
    });

    dom.searchButton = h('button.icon-button', {
      type: 'button',
      'aria-label': 'Suchen und Befehle (Strg K)',
      title: `Suchen und Befehle (${isMac() ? '⌘K' : 'Strg K'})`,
      onClick: () => palette.open(),
    }, icon(ICONS.search));

    dom.toggleRight = h('button.icon-button.topbar__toggle', {
      type: 'button',
      'aria-controls': 'aside',
      onClick: () => toggleSide('rechts'),
    }, icon(ICONS.panelRight));

    bar.append(dom.expandLeft, dom.routeTitle, dom.headSlot,
      h('div.topbar__right', null, dom.connChip, dom.searchButton, dom.toggleRight));
  }

  function setStageTitle(value) {
    const title = String(value || '').trim() || 'Neural OS';
    if (!dom.routeTitle) return;
    if (dom.routeTitle.textContent !== title) {
      clear(dom.routeTitle);
      dom.routeTitle.appendChild(text(title));
    }
    document.title = title === 'Neural OS' ? 'Neural OS' : `${title} · Neural OS`;
  }

  function setHeadActions(nodes) {
    if (!dom.headSlot) return;
    clear(dom.headSlot);
    for (const node of nodes.flat()) {
      if (node instanceof Node) dom.headSlot.appendChild(node);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rechte Spalte                                                     */
  /* ---------------------------------------------------------------- */

  function buildAside() {
    const aside = dom.aside;
    clear(aside);
    const inner = h('div.aside__inner');
    for (const tile of TILES) {
      const el = h('section.tile', {
        'data-tile': tile.kachel,
        'aria-label': tile.title,
        class: tile.grow ? 'tile--grow' : '',
      });
      tiles.set(tile.kachel, { ...tile, el, handle: null });
      inner.appendChild(el);
    }
    aside.appendChild(inner);
  }

  function mountTiles() {
    if (tilesMounted) return;
    tilesMounted = true;
    for (const entry of tiles.values()) mountTile(entry);
  }

  async function mountTile(entry) {
    try {
      // Die Kennung kommt aus der festen Liste oben, nie aus einer Eingabe.
      const mod = await import(`./widgets/${entry.kachel}.js`);
      const mount = mod && (mod.mount || (mod.default && mod.default.mount));
      if (typeof mount !== 'function') throw new Error(`widgets/${entry.kachel}.js hat keine mount()-Funktion.`);
      clear(entry.el);
      entry.handle = (await mount(entry.el, makeTileContext(entry))) || null;
    } catch (err) {
      console.warn(`[neural-os] Kachel "${entry.kachel}" nicht verfügbar:`, err && err.message);
      clear(entry.el);
      entry.el.append(
        tileHead({ icon: entry.icon, title: entry.title, href: entry.href }),
        h('p.tile__empty', null, text('Diese Kachel konnte nicht geladen werden.')));
    }
  }

  function makeTileContext(entry) {
    return {
      ...baseContext(),
      kachel: entry.kachel,
      get route() {
        return state.get('route');
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Was die Schale anzeigt, immer aus dem Zustand neu berechnet        */
  /* ---------------------------------------------------------------- */

  function renderChrome() {
    if (!dom.statusButton) return;
    const info = describeStatus({
      status: state.get('status'),
      stale: state.get('statusStale') !== false,
      connected: state.get('connected'),
      ready: state.get('ready'),
      claude: state.get('claude'),
    });
    clear(dom.statusButton);
    dom.statusButton.dataset.status = info.key;
    dom.statusButton.append(
      h('span.rail__status-icon', { 'aria-hidden': 'true' }, icon(info.offline ? ICONS.cloudOff : ICONS.cloud)),
      h('span', { class: cx('dot', info.dot ? `dot--${info.dot}` : '') }),
      h('span.rail__status-label', null, text(info.label)));
    dom.statusButton.title = info.hint;
    dom.statusButton.setAttribute('aria-label', `${info.label}. ${info.hint}`);

    const connected = state.get('connected');
    const connInfo = state.get('connectionInfo') || {};
    const showConn = !connected && state.get('ready');
    dom.connChip.hidden = !showConn;
    if (showConn) {
      clear(dom.connChip);
      const label = connInfo.state === 'reconnecting' && connInfo.delay
        ? `Getrennt – neuer Versuch in ${Math.max(1, Math.round(connInfo.delay / 1000))} s`
        : 'Verbindung getrennt';
      dom.connChip.append(icon(ICONS.alert), h('span.chip__label', null, text(label)));
      dom.connChip.title = 'Die Live-Verbindung zum eigenen Server ist abgerissen. Antippen versucht es sofort erneut.';
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

  function markActiveRoute(route) {
    if (!dom.navLinks) return;
    const view = VIEWS.find((v) => v.id === route.view);
    const navId = view ? (view.parent || view.id) : null;
    for (const [id, entry] of dom.navLinks) {
      // "Neuer Chat" leuchtet nur, solange es wirklich ein neuer ist; ein
      // offener Chat ist in "Zuletzt" markiert, wie bei Claude.
      const active = id === navId && !(id === 'chat' && route.params.id);
      entry.link.classList.toggle('is-active', active);
      if (active) entry.link.setAttribute('aria-current', 'page');
      else entry.link.removeAttribute('aria-current');
    }
    renderRecent();
  }

  function defaultTitleFor(route) {
    const view = VIEWS.find((v) => v.id === route.view);
    if (!view) return 'Nicht gefunden';
    if (view.id === 'chat' && route.params.id) {
      const known = (state.get('recentChats') || []).find((row) => row.id === route.params.id);
      return known ? chatTitle(known) : 'Chat';
    }
    return view.head || view.title;
  }

  /* ---------------------------------------------------------------- */
  /* Ansichten laden                                                   */
  /* ---------------------------------------------------------------- */

  async function loadView(id) {
    if (!VIEW_IDS.has(id)) throw new ApiError('NOT_FOUND', `Unbekannter Bereich "${id}".`, { status: 404 });
    if (!viewCache.has(id)) {
      // Die Kennung stammt aus der Liste oben, nie direkt aus der Adresse.
      const promise = import(`./views/${id}.js`).then((mod) => {
        const view = mod && (mod.default || mod.view);
        if (!view || typeof view.mount !== 'function') {
          throw new Error(`Das Modul "views/${id}.js" hat keine mount()-Funktion.`);
        }
        return view;
      });
      viewCache.set(id, promise);
      promise.catch(() => viewCache.delete(id)); // ein Fehlschlag muss wiederholbar bleiben
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
    renderedRoute = route;
    // Auf schmalen Bildschirmen geht die Schublade nach jeder Wahl zu --
    // auch wenn die Adresse dieselbe blieb ("Neuer Chat" im Chat).
    closeDrawers();
    markActiveRoute(route);
    setStageTitle(defaultTitleFor(route));
    setHeadActions([]);
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

    // Ein Kreisel nur, wenn das Laden wirklich dauert: ein kurzes "Lädt …"
    // bei einem schon geladenen Modul sieht kaputt aus, nicht schnell.
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
    try {
      currentView = view;
      await view.mount(container, makeContext(route, token));
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
        h('button.btn.btn--primary', { type: 'button', onClick: () => startNewChat() }, text('Zum Chat'))));
  }

  function renderViewError(route, err, phase) {
    const message = err instanceof ApiError || err instanceof Error ? err.message : String(err);
    const label = labelFor(route.view);
    return h('div.view-state.view-state--error', { role: 'alert' },
      h('div.view-state__icon', { 'aria-hidden': 'true' }, icon(ICONS.alert)),
      h('h2.view-state__title', null, text(`${label} ist nicht verfügbar`)),
      h('p.view-state__text', null, text(phase === 'load'
        ? `Das Modul „views/${route.view}.js“ konnte nicht geladen werden. In dieser Installation fehlt dieser Teil der Oberfläche oder er enthält einen Fehler.`
        : 'Beim Aufbau der Ansicht ist ein Fehler aufgetreten. Die übrigen Bereiche funktionieren weiter.')),
      h('pre.view-state__detail', null, text(message)),
      h('div.view-state__actions', null,
        h('button.btn.btn--primary', {
          type: 'button',
          onClick: () => {
            viewCache.delete(route.view);
            renderRoute(state.get('route'));
          },
        }, text('Erneut versuchen')),
        h('button.btn', { type: 'button', onClick: () => startNewChat() }, text('Zum Chat'))));
  }

  function labelFor(id) {
    const view = VIEWS.find((v) => v.id === id);
    return view ? view.title : id;
  }

  /* ---------------------------------------------------------------- */
  /* Was jede Ansicht und jede Kachel bekommt (Vertrag, Abschnitt 13)  */
  /* ---------------------------------------------------------------- */

  function baseContext() {
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
      formatDate,
      formatNumber,
      snippet,
      state,
      bus,
      navigate,
      toast,
      confirm: confirmDialog,
      icons: ICONS,
      tileHead,
      shell: {
        /** @param {'links'|'rechts'} side */
        isOpen: (side) => !!(state.get('seiten') || {})[side],
        open: (side) => setSide(side, true),
        close: (side) => setSide(side, false),
        toggle: (side) => toggleSide(side),
        newChat: () => startNewChat(),
      },
      version: APP_VERSION,
    };
  }

  function makeContext(route, token) {
    // Nur die Ansicht, die gerade dran ist, darf den Kopf beschriften. Eine,
    // die nach dem Wegnavigieren noch eine Antwort bekommt, nicht mehr.
    const current = () => token === mountToken;
    return {
      ...baseContext(),
      route,
      setTitle: (value) => {
        if (current()) setStageTitle(value);
      },
      setHeadActions: (...nodes) => {
        if (current()) setHeadActions(nodes);
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Navigation                                                        */
  /* ---------------------------------------------------------------- */

  function navigate(target) {
    const raw = String(target || '');
    const next = parseRoute(raw.startsWith('#') ? raw : `#${raw.startsWith('/') ? raw : `/${raw}`}`);
    if (window.location.hash === next.hash) {
      // Dieselbe Adresse, ausdruecklich gewuenscht: neu aufbauen statt nichts tun.
      state.set('route', next);
      renderRoute(next);
      return;
    }
    window.location.hash = next.hash;
  }

  /**
   * Alte und besondere Adressen, bevor irgendetwas gezeichnet wird.
   * @returns {boolean} true, wenn die Adresse erledigt ist
   */
  function divert(route) {
    if (ENTFALLEN.has(route.view)) {
      // replaceState statt location.replace: kein zweites hashchange, also
      // genau ein Aufbau, und die alte Adresse bleibt nicht im Verlauf.
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/${DEFAULT_VIEW}`);
      const home = parseRoute(`#/${DEFAULT_VIEW}`);
      state.set('route', home);
      renderRoute(home);
      return true;
    }
    if (route.view === 'search') {
      // Suchen ist die Befehlspalette. Wer (etwa ueber ein Schlagwort in einer
      // Notiz) hierher kommt, bleibt, wo er war, und bekommt die Palette mit
      // dem Suchbegriff.
      const back = renderedRoute ? renderedRoute.hash : `#/${DEFAULT_VIEW}`;
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}${back}`);
      if (!renderedRoute) {
        const home = parseRoute(back);
        state.set('route', home);
        renderRoute(home);
      }
      palette.open(route.params.q || '');
      return true;
    }
    return false;
  }

  function onHashChange() {
    const route = parseRoute(window.location.hash);
    if (divert(route)) return;
    state.set('route', route);
    if (route.params.id && route.view === 'chat') {
      state.set('activeChatId', route.params.id);
      writeStored(STORAGE.chat, route.params.id);
    }
    renderRoute(route);
  }

  /* ---------------------------------------------------------------- */
  /* Meldungen                                                         */
  /* ---------------------------------------------------------------- */

  const toasts = [];

  /**
   * @param {string} message deutsch, fuer Menschen
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
  /* Ueberlagerungen: Dialog, Befehlspalette, Schnellerfassung         */
  /* ---------------------------------------------------------------- */

  const overlayStack = [];
  let quickCaptureOpen = false;

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

  /**
   * Was in der Schnellerfassung steht, und was daraus wird. Rein, damit sie
   * pruefbar ist, ohne ein Fenster zu oeffnen. Geraten wird nichts: ohne
   * Merker (`- [ ]`, `TODO:`, `Offen:`) entsteht eine Notiz, nie eine Aufgabe.
   */
  function parseQuickCapture(raw) {
    const value = String(raw || '').replace(/\r\n/g, '\n');
    const trimmed = value.trim();
    if (!trimmed) return null;

    const taskMarker = /^(?:[-*+]\s*\[\s*\]\s*|todo\s*:?\s+|@todo\s+|offen\s*:\s*|zu\s+tun\s*:\s*)/i;
    const isTask = taskMarker.test(trimmed);
    const body = isTask ? trimmed.replace(taskMarker, '') : trimmed;

    // Schlagwoerter werden gelesen, aber NICHT aus dem Text entfernt: wer
    // "#kaffee" schreibt, meint es meistens auch als Wort im Satz.
    const tags = [];
    for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,40})/gu)) {
      const tag = match[1].toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
    }

    const lines = body.split('\n');
    const first = lines[0].trim();
    const rest = lines.slice(1).join('\n').trim();

    if (isTask) {
      // Aufgaben tragen im Datenmodell keine Schlagwoerter
      // (src/store/schema.js); ein #wort bleibt im Text, und die Vorschau
      // sagt das.
      return { kind: 'task', title: first.slice(0, 500), body: rest, tags: [], erkannteWorte: tags };
    }
    return {
      kind: 'note',
      title: (first || 'Notiz').slice(0, 500),
      body: rest,
      tags,
    };
  }

  /**
   * Eine Zeile, von ueberall aus (Strg+Umschalt+N). Die Huerde zum
   * Aufschreiben ist der Bereichswechsel -- also gibt es keinen.
   */
  function openQuickCapture() {
    if (quickCaptureOpen) return;
    quickCaptureOpen = true;

    const titleId = 'quick-capture-title';
    const field = h('textarea.input.quick__field', {
      rows: 3,
      placeholder: 'Ein Gedanke. Mit „- [ ]“ davor wird eine Aufgabe daraus, #schlagwort wird ein Schlagwort.',
      'aria-label': 'Was willst du festhalten?',
      spellcheck: 'true',
    });
    const preview = h('p.quick__preview.meta');
    const status = h('p.quick__status.meta', { role: 'status' });
    let busy = false;

    const describe = () => {
      const parsed = parseQuickCapture(field.value);
      clear(preview);
      if (!parsed) {
        preview.appendChild(text('Noch nichts eingegeben.'));
        return;
      }
      const art = parsed.kind === 'task' ? 'Aufgabe' : 'Notiz';
      const schlag = parsed.tags.length ? ` · ${parsed.tags.map((t) => `#${t}`).join(' ')}` : '';
      preview.appendChild(text(`Wird angelegt als ${art}: „${snippetTitle(parsed.title)}“${schlag}`));
      if (parsed.kind === 'task' && parsed.erkannteWorte && parsed.erkannteWorte.length) {
        preview.appendChild(h('br'));
        preview.appendChild(text(`Aufgaben tragen keine Schlagwörter — ${parsed.erkannteWorte
          .map((t) => `#${t}`).join(' ')} bleibt im Text stehen.`));
      }
    };

    const save = async (keepOpen) => {
      if (busy) return;
      const parsed = parseQuickCapture(field.value);
      if (!parsed) return;
      busy = true;
      clear(status);
      status.appendChild(text('Wird gespeichert …'));
      try {
        const data = parsed.kind === 'task'
          ? { title: parsed.title, body: parsed.body }
          : { title: parsed.title, body: parsed.body, tags: parsed.tags };
        const created = await api.post('/records', { type: parsed.kind, data });
        const id = created && (created.id || (created.record && created.record.id));
        const art = parsed.kind === 'task' ? 'Aufgabe' : 'Notiz';
        if (keepOpen) {
          field.value = '';
          describe();
          clear(status);
          status.appendChild(text(`${art} angelegt.`));
          field.focus();
        } else {
          entry.close(null);
          toast(`${art} angelegt.`, 'success');
          if (id) navigate(parsed.kind === 'task' ? '#/projects' : `#/notes?id=${encodeURIComponent(id)}`);
        }
      } catch (err) {
        clear(status);
        status.classList.add('is-danger');
        status.appendChild(text(`Nicht gespeichert: ${(err && err.message) || 'unbekannter Fehler'}`));
      } finally {
        busy = false;
      }
    };

    on(field, 'input', describe);
    on(field, 'keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        // Strg+Enter: speichern und offen bleiben -- fuer mehrere Gedanken
        // hintereinander.
        save(event.metaKey || event.ctrlKey);
      }
    });

    const node = h('div.quick', null,
      h('h2.quick__title', { id: titleId }, text('Schnell festhalten')),
      field,
      preview,
      status,
      h('div.quick__actions', null,
        h('span.meta', null, text('Enter speichert · Strg+Enter speichert und bleibt offen · Umschalt+Enter macht einen Zeilenumbruch')),
        h('span.spacer'),
        h('button.btn', { type: 'button', onClick: () => entry.close(null) }, text('Abbrechen')),
        h('button.btn.btn--primary', { type: 'button', onClick: () => save(false) }, text('Speichern'))));

    const entry = openOverlay({ node, labelledBy: titleId, onClose: () => { quickCaptureOpen = false; } });
    describe();
    field.focus();
  }

  function snippetTitle(value) {
    const s = String(value || '');
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
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

  /* ----------------------------- Palette ---------------------------- */

  const palette = createPalette();

  /**
   * Die Befehlspalette ist zugleich die Suche (Strg+K oder /). Sie findet
   * Bereiche, Aktionen und -- ab zwei Zeichen -- Notizen, Chats, Projekte.
   */
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
      const sides = state.get('seiten') || {};
      const actions = [
        {
          id: 'act:new-chat',
          group: 'Aktionen',
          label: 'Neuer Chat',
          hint: 'Leere Seite, die erste Nachricht legt den Chat an',
          icon: ICONS.chat,
          run: () => startNewChat(),
        },
        {
          id: 'act:quick',
          group: 'Aktionen',
          label: 'Schnell festhalten',
          hint: 'Strg+Umschalt+N · eine Zeile, ohne den Bereich zu wechseln',
          icon: ICONS.plus,
          run: () => openQuickCapture(),
        },
        {
          id: 'act:new-note',
          group: 'Aktionen',
          label: 'Neue Notiz anlegen',
          icon: ICONS.notes,
          run: async () => {
            const record = await api.post('/records', { type: 'note', data: { title: 'Neue Notiz', body: '' } });
            const id = record && (record.id || (record.record && record.record.id));
            toast('Notiz angelegt.', 'success');
            navigate(id ? `#/notes?id=${encodeURIComponent(id)}` : '#/notes');
          },
        },
        {
          id: 'act:left',
          group: 'Aktionen',
          label: sides.links ? 'Seitenleiste einklappen' : 'Seitenleiste ausklappen',
          icon: ICONS.panelLeft,
          run: () => toggleSide('links'),
        },
        {
          id: 'act:right',
          group: 'Aktionen',
          label: sides.rechts ? 'Übersicht rechts einklappen' : 'Übersicht rechts ausklappen',
          icon: ICONS.panelRight,
          run: () => toggleSide('rechts'),
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
          icon: ICONS.backup,
          run: async () => {
            const result = await api.post('/backup/export', { format: 'both', includeFiles: true }, { timeoutMs: 120000 });
            toast(result && result.dir ? `Sicherung geschrieben nach ${result.dir}` : 'Sicherung geschrieben.', 'success', { timeout: 12000 });
          },
        },
        {
          id: 'act:theme',
          group: 'Aktionen',
          label: 'Darstellung wechseln (dunkel / hell / System)',
          icon: ICONS.moon,
          run: () => cycleTheme(),
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
        actions.push({
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
        label: view.id === 'chat' ? 'Chat' : view.title,
        hint: `g dann ${view.key}`,
        icon: view.icon,
        keywords: `${view.id} ${view.keywords}`,
        run: () => (view.id === 'chat' ? startNewChat() : navigate(`#/${view.id}`)),
      }));

      const chats = (state.get('recentChats') || []).slice(0, 6).map((row) => ({
        id: `chat:${row.id}`,
        group: 'Letzte Chats',
        label: chatTitle(row),
        hint: row.updatedAt ? timeAgo(row.updatedAt) : '',
        icon: ICONS.chat,
        run: () => navigate(`#/chat?id=${encodeURIComponent(row.id)}`),
      }));

      return [...navigation, ...chats, ...actions];
    }

    function score(item, query) {
      if (!query) return 1;
      const haystack = `${item.label} ${item.hint || ''} ${item.keywords || ''}`.toLowerCase();
      const needle = query.toLowerCase();
      if (haystack.includes(needle)) return 10 - haystack.indexOf(needle) / 100;
      // Lose Teilfolge, damit "eins" noch "Einstellungen" findet.
      let index = 0;
      for (const char of needle) {
        index = haystack.indexOf(char, index);
        if (index === -1) return 0;
        index += 1;
      }
      return 1;
    }

    function render(query) {
      const scored = baseItems()
        .map((item) => ({ item, s: score(item, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      // Reihenfolge: ein Bereich oder Befehl, dessen Name das Getippte
      // enthaelt ("eins" -> Einstellungen), dann die Treffer aus dem Tresor,
      // dann alles nur lose Passende. So fuehrt Strg+K, Wort, Enter dorthin,
      // wo man hinwollte, und Suchen bleibt trotzdem ein Tastendruck.
      const stark = scored.filter((x) => query && x.s >= 9).map((x) => x.item);
      const lose = scored.filter((x) => !query || x.s < 9)
        .map((x) => (query ? { ...x.item, group: 'Weitere' } : x.item));
      items = [...stark, ...(state.get('paletteResults') || []), ...lose];
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
        const result = await api.get('/search', { query: { q: query.trim(), limit: 8 }, timeoutMs: 8000 });
        if (token !== searchToken) return;
        const rows = (result && Array.isArray(result.items) ? result.items : []).map((row) => {
          const record = row && row.record ? row.record : row;
          const data = (record && record.data) || {};
          // Eine Nachricht hat keinen Titel; ihr Anfang sagt mehr als ihre Kennung.
          const inhalt = String(data.content || data.text || '').replace(/\s+/g, ' ').trim();
          const label = data.title || data.name || (inhalt ? inhalt.slice(0, 90) : '') || recordTypeLabel(record.type) || record.id;
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
        if (input) {
          if (initialQuery) {
            input.value = initialQuery;
            render(initialQuery);
            runSearch(initialQuery);
          }
          input.select();
        }
        return;
      }
      input = h('input.palette__input', {
        type: 'text',
        autofocus: true,
        value: initialQuery,
        placeholder: 'Suchen – Notizen, Chats, Bereiche, Befehle …',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': 'palette-list',
        'aria-label': 'Suchen und Befehle',
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
          h('span.palette__head-icon', { 'aria-hidden': 'true' }, icon(ICONS.search)),
          input,
          h('kbd.kbd', null, text('Esc'))),
        listNode,
        h('div.palette__foot', null,
          h('span', null, text('↑ ↓ bewegen · ↵ öffnen · Esc schließen')),
          h('span', null, text(`${isMac() ? '⌘K' : 'Strg K'} öffnet die Suche überall`))));

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

  /* --------------------------- Tastenkuerzel ------------------------ */

  function showShortcuts() {
    const mod = isMac() ? '⌘' : 'Strg';
    const rows = [
      [`${mod} K`, 'Suchen und Befehle'],
      ['/', 'Suchen'],
      ['?', 'Diese Übersicht'],
      ['Esc', 'Schließen'],
      [`${mod} Umschalt N`, 'Schnell festhalten – eine Zeile, von überall aus'],
      ...VIEWS.map((v) => [`g ${v.key}`, `Zu ${v.id === 'chat' ? 'einem neuen Chat' : v.title}`]),
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
  /* Tastatur                                                          */
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
    // Absichtlich auch waehrend man tippt: der Sinn ist, den Gedanken
    // loszuwerden, ohne vorher irgendwohin zu wechseln.
    if ((event.key === 'n' || event.key === 'N') && (event.metaKey || event.ctrlKey) && event.shiftKey) {
      event.preventDefault();
      openQuickCapture();
      return;
    }
    if (event.key === 'Escape') {
      if (pendingGo) {
        clearTimeout(pendingGo.timer);
        pendingGo = null;
      }
      if (closeTopOverlay()) event.preventDefault();
      else if (closeDrawers()) event.preventDefault();
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
        if (target.id === 'chat') startNewChat();
        else navigate(`#/${target.id}`);
      }
      return;
    }

    if (event.key === 'g') {
      // Zwei Tasten nacheinander, damit einzelne Buchstaben den Ansichten
      // gehoeren.
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
  /* Darstellung                                                       */
  /* ---------------------------------------------------------------- */

  /** Dunkel ohne Attribut, hell und "System" ueber data-theme (app.css). */
  function applyTheme(theme) {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme === 'light' || theme === 'system' ? theme : 'dark');
    let dark = theme !== 'light';
    if (theme === 'system') {
      try {
        dark = !window.matchMedia('(prefers-color-scheme: light)').matches;
      } catch {
        dark = true;
      }
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#090a0a' : '#eeeff2');
  }

  function cycleTheme() {
    const order = ['dark', 'light', 'system'];
    const next = order[(order.indexOf(state.get('theme')) + 1) % order.length];
    state.set('theme', next);
  }

  /* ---------------------------------------------------------------- */
  /* Start                                                             */
  /* ---------------------------------------------------------------- */

  async function start() {
    dom.shell = document.getElementById('shell');
    dom.topbar = document.getElementById('topbar');
    dom.rail = document.getElementById('rail');
    dom.aside = document.getElementById('aside');
    dom.view = document.getElementById('view');
    dom.scrim = document.getElementById('scrim');
    dom.toasts = document.getElementById('toasts');
    dom.overlays = document.getElementById('overlays');
    if (!dom.shell || !dom.topbar || !dom.rail || !dom.view || !dom.aside) {
      throw new Error('Das Grundgerüst der Seite fehlt (index.html wurde nicht vollständig geladen).');
    }

    applyTheme(state.get('theme'));
    state.on('theme', (theme) => {
      applyTheme(theme);
      writeStored(STORAGE.theme, theme);
    });

    try {
      const media = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => {
        if (state.get('theme') === 'system') applyTheme('system');
      };
      if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    } catch {
      /* ohne matchMedia tut die CSS-Regel das Richtige */
    }

    buildRail();
    buildTopbar();
    buildAside();

    const mode = currentMode();
    state.set('seiten', { ...storedSides(mode), modus: mode });
    applySides();
    // Erst jetzt, mit dem gemerkten Zustand an seinem Platz, darf sich
    // etwas bewegen.
    requestAnimationFrame(() => requestAnimationFrame(() => dom.shell.classList.remove('is-booting')));

    try {
      for (const query of [MEDIA_SCHMAL, MEDIA_MITTEL]) {
        const media = window.matchMedia(query);
        if (typeof media.addEventListener === 'function') media.addEventListener('change', onModeChange);
      }
    } catch {
      /* ohne matchMedia bleibt die Aufteilung, wie sie ist */
    }
    if (dom.scrim) on(dom.scrim, 'click', () => closeDrawers());

    for (const key of ['status', 'statusStale', 'connected', 'approvals', 'claude']) {
      state.on(key, () => renderChrome());
    }
    state.on('recentChats', () => {
      renderRecent();
      // Der Kopf eines offenen Chats kennt seinen Titel erst, wenn die Liste da ist.
      const route = state.get('route');
      if (route && route.view === 'chat' && route.params.id && dom.routeTitle.textContent === 'Chat') {
        setStageTitle(defaultTitleFor(route));
      }
    });

    // Ohne Adresse beginnt die Anwendung im Chat -- immer, nicht dort, wo
    // man zuletzt war: "Starten antippen, laeuft" heisst, man kann sofort
    // schreiben.
    if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/${DEFAULT_VIEW}`);
    }

    on(window, 'hashchange', onHashChange);
    on(document, 'keydown', onKeyDown);

    const route = parseRoute(window.location.hash);
    if (!divert(route)) {
      state.set('route', route);
      renderRoute(route);
    }

    renderChrome();
    startEventStream();
    refreshRecent();
    await refreshStatus();
    refreshApprovals();
    state.set('ready', true);
    renderChrome();

    // Der Claude-Zustand kann sich aendern, ohne dass hier ein Ereignis
    // ankommt (ein Schluessel laeuft ab). Einmal pro Minute nachsehen,
    // solange das Fenster sichtbar ist, kostet nichts.
    setInterval(() => {
      if (document.visibilityState === 'visible') refreshStatus();
    }, 60000);

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
    seiten: {
      isOpen: (side) => !!(state.get('seiten') || {})[side],
      open: (side) => setSide(side, true),
      close: (side) => setSide(side, false),
      toggle: (side) => toggleSide(side),
    },
    get route() {
      return state.get('route');
    },
  };
}

/* ------------------------------------------------------------------ */
/* Der Status unten links                                              */
/* ------------------------------------------------------------------ */

/**
 * Was unten links steht. Nie optimistisch: ohne frischen `/api/status` steht
 * da "Status unbekannt", und "Online verbunden" nur, wenn der Netzmodus
 * online ist UND Claude sich als verbunden meldet. Ein gruener Punkt, der
 * eine Verbindung behauptet, die niemand geprueft hat, waere genau die Art
 * bequemer Luege, die diese Anwendung nicht erzaehlen soll.
 *
 * @returns {{key:string, label:string, hint:string, dot:string|null, offline:boolean}}
 */
export function describeStatus({ status, stale, connected, ready, claude }) {
  if (ready && !connected) {
    return {
      key: 'getrennt',
      label: 'Server getrennt',
      hint: 'Die Verbindung zum eigenen Server ist abgerissen. Antippen versucht es sofort erneut.',
      dot: 'danger',
      offline: true,
    };
  }
  const mode = status && status.network ? status.network.mode : null;
  if (stale || !mode) {
    return {
      key: 'unbekannt',
      label: 'Status unbekannt',
      hint: 'Der Serverstatus ist gerade nicht abrufbar. Es wird kein Netzzustand behauptet.',
      dot: null,
      offline: false,
    };
  }
  if (mode === 'offline') {
    return {
      key: 'offline',
      label: 'Offline',
      hint: 'Nichts verlässt dieses Gerät. Claude und die Websuche brauchen Internet.',
      dot: null,
      offline: true,
    };
  }
  if (mode === 'lan') {
    return {
      key: 'lan',
      label: 'Nur lokales Netz',
      hint: 'Dieses Gerät und dein lokales Netzwerk, kein Internet. Claude ist so nicht erreichbar.',
      dot: 'warn',
      offline: true,
    };
  }
  if (mode === 'online') {
    const c = claude || { bekannt: false };
    if (c.bekannt && c.verbunden === true) {
      return {
        key: 'online',
        label: 'Online verbunden',
        hint: `Internet erlaubt, Claude ist verbunden${c.modell ? ` (${c.modell})` : ''}.`,
        dot: 'ok',
        offline: false,
      };
    }
    if (c.bekannt && c.schluesselVorhanden === false) {
      return {
        key: 'ohne-claude',
        label: 'Online · Claude fehlt',
        hint: 'Internet erlaubt, aber es ist noch kein Claude-Schlüssel hinterlegt. Das geht in den Einstellungen.',
        dot: 'warn',
        offline: false,
      };
    }
    if (c.bekannt) {
      return {
        key: 'claude-getrennt',
        label: 'Online · Claude getrennt',
        hint: 'Internet erlaubt, Claude antwortet gerade nicht.',
        dot: 'warn',
        offline: false,
      };
    }
    return {
      key: 'online-ungeprueft',
      label: 'Online',
      hint: 'Internet ist erlaubt. Ob Claude erreichbar ist, meldet dieser Server nicht.',
      dot: 'ok',
      offline: false,
    };
  }
  return { key: 'unbekannt', label: `Netz: ${mode}`, hint: 'Unbekannter Netzmodus. Prüfe die Konfiguration.', dot: null, offline: false };
}

/* ------------------------------------------------------------------ */
/* Kleinigkeiten                                                       */
/* ------------------------------------------------------------------ */

function chatTitle(record) {
  const data = (record && record.data) || {};
  const title = String(data.title || '').trim();
  return title || 'Chat ohne Titel';
}

function recordTypeLabel(type) {
  const labels = {
    note: 'Notiz', chat: 'Chat', message: 'Nachricht', project: 'Projekt', task: 'Aufgabe',
    agent: 'Agent', run: 'Lauf', file: 'Datei', entity: 'Begriff', memory: 'Erinnerung', edge: 'Verknüpfung',
    event: 'Termin',
  };
  return labels[type] || type || '';
}

function iconForType(type) {
  const map = {
    note: ICONS.notes, chat: ICONS.chat, message: ICONS.chat, project: ICONS.projects,
    task: ICONS.projects, agent: ICONS.agents, run: ICONS.agents, file: ICONS.notes,
    entity: ICONS.graph, memory: ICONS.graph, event: ICONS.calendar,
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
    case 'event': return `#/kalender?id=${id}`;
    default: return `#/graph?focus=${id}`;
  }
}

function isMac() {
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
}

/** localStorage kann werfen (privates Fenster, abgeschalteter Speicher). */
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
    /* ohne Speicher ueberlebt die Vorliebe nur den Neustart nicht */
  }
}

function removeStored(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* siehe oben */
  }
}

/** Dunkel ist die Voreinstellung; hell und "System" nur, wenn gewaehlt. */
function readTheme() {
  const value = readStored(STORAGE.theme, 'dark');
  return ['light', 'dark', 'system'].includes(value) ? value : 'dark';
}

/**
 * Der Service Worker legt nur die Schale in den Zwischenspeicher, damit sie
 * sofort aufgeht. Ein Update wird einer laufenden Sitzung nie aufgezwungen:
 * die neue Fassung wartet, und es gibt einmal das Angebot "Neu laden".
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
  // Die Schale selbst ist gescheitert. Das auf Deutsch sagen statt einer weissen Seite.
  console.error('[neural-os] Start fehlgeschlagen:', err);
  const container = document.getElementById('view') || document.body;
  clear(container);
  container.appendChild(h('div.view-state.view-state--error', { role: 'alert' },
    h('h2.view-state__title', null, text('Die Oberfläche konnte nicht starten')),
    h('p.view-state__text', null, text(err && err.message ? err.message : String(err))),
    h('div.view-state__actions', null,
      h('button.btn.btn--primary', { type: 'button', onClick: () => window.location.reload() }, text('Neu laden')))));
});

// Ein Griff zum Nachsehen aus der Browser-Konsole. Nichts in der Anwendung
// liest ihn; er ist da, damit man sehen kann, was die Oberflaeche weiss.
window.__neuralOS = shell;

export default shell;
