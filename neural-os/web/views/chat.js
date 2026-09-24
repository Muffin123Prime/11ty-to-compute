/**
 * views/chat.js -- der Chat mit Claude, der Mittelpunkt der Vorlage
 * (docs/vorlage/app.png): eine grosse Karte, oben "Neuer Chat" oder der
 * Titel, die Frage "Womit kann ich dir helfen?", Nachrichten als Blasen,
 * unten das Eingabefeld als grosse gerundete Karte.
 *
 * Die Entscheidungen, die diese Datei formen:
 *
 * - **Eine laufende Antwort ueberlebt die Ansicht.** Der Strom haengt an
 *   einer Sitzung auf Modulebene, nicht an der eingehaengten Ansicht. Wer
 *   waehrend einer Antwort kurz in die Notizen schaut, kommt zurueck und
 *   sieht sie weiterlaufen -- das Schliessen der Verbindung wuerde den
 *   (bezahlten) Zug auf dem Server abbrechen.
 * - **Was zu sehen ist, kommt vom Server** (Vertrag 6): Text, Gedankengang,
 *   Quellen, Agenten, Rueckfragen, und am Ende `fertig` mit dem gespeicherten
 *   Satz, der alles Vorlaeufige ersetzt. Nichts wird hier erfunden: keine
 *   Beispielantwort, keine geschaetzte Uhrzeit, kein "Kopiert", wenn nicht
 *   kopiert wurde.
 * - **Rueckfragen wie bei ChatGPT.** Die Optionen sind grosse Chips (44 px
 *   fuer den Finger), Einfachauswahl schickt sofort, Mehrfachauswahl hat
 *   "Senden", "Eigene Antwort …" oeffnet ein Feld an Ort und Stelle, Tasten
 *   1–9 waehlen am Laptop. Danach bleibt die Karte im Verlauf und zeigt die
 *   Wahl -- eine Frage, die nach dem Antworten verschwindet, macht den
 *   Verlauf unlesbar.
 * - **Kopieren kopiert genau das Gemeinte.** Ein ```prompt-Block ist eine
 *   eigene Karte mit eigenem Knopf (web/lib/markdown.js); die Leiste unter
 *   einer Antwort kopiert die ganze Antwort. Ohne `navigator.clipboard`
 *   (iPad ueber http://<LAN-IP>) geht es ueber den alten Weg.
 * - **Was die KI anlegt, steht als Karte in der Antwort** ("Termin
 *   eingetragen · Do, 25. Sep · 15:00 · Zahnarzt") mit "Oeffnen" und
 *   "Rueckgaengig" -- zurueckgenommen wird ueber den Aenderungsverlauf, also
 *   nie ueber eine spaetere Aenderung des Nutzers hinweg.
 * - **Ohne Claude kein leerer Chat.** Fehlt der Schluessel, steht dort, wo
 *   sonst die Frage steht, "Verbinde Claude" mit genau einem Feld. Ist
 *   Neural OS offline, steht dort ein Satz und der Schalter.
 * - **Keine zweite Chatliste.** Die Chats stehen in der Seitenleiste der
 *   Schale ("Zuletzt"); hier gibt es nur diesen einen.
 */

import { h, text, clear, on, icon, cx, debounce } from '../lib/dom.js';
import { api as defaultApi, ApiError } from '../lib/api.js';
import { renderMarkdown, extractPlain, kopieren } from '../lib/markdown.js';
import { rolle, wirkungZeilen, uhrzeit, dauerText } from '../lib/agenten.js';

/* ------------------------------------------------------------------ */
/* Konstanten                                                          */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-chat-view';
const ENTWURF = 'neural-os:chat-entwurf:';
/** Serverseitige Obergrenze (src/http/api/chat.js), hier gespiegelt, um frueh zu warnen. */
const MAX_ZEICHEN = 200000;
/** Eine angehaengte Datei darf hoechstens so viel Text mitbringen. */
const MAX_ANHANG = 150000;
/** Solange der Nutzer so nah am Ende ist, rollt die Ansicht mit. */
const FOLGEN_PX = 90;
/** So lange wartet "Stopp" auf das Ende vom Server, bevor die Leitung gekappt wird. */
const STOPP_WACHHUND_MS = 4000;
/** Lange eigene Nachrichten (eingefuegte Texte) werden zugeklappt gezeigt. */
const LANG_ZEICHEN = 1400;
const LANG_ZEILEN = 18;

/** Der Einstieg im leeren Chat: fuellt das Feld vor, schickt nichts ab. */
const STARTER = [
  { label: 'Termin eintragen', symbol: 'calendar', text: 'Trag mir einen Termin ein: ' },
  { label: 'Notiz festhalten', symbol: 'notes', text: 'Halte als Notiz fest: ' },
  { label: 'Im Internet suchen', symbol: 'globe', text: 'Such im Internet: ' },
  { label: 'Prompt schreiben', symbol: 'pen', text: 'Schreib mir einen Prompt für ' },
];

const TEXTDATEI = /\.(txt|md|markdown|csv|tsv|json|log|js|mjs|cjs|ts|py|html?|css|xml|ya?ml|ini|toml|sh|bat|ics|vcf|srt|tex|sql)$/i;

const SYMBOL_STOPP = '<rect x="5.6" y="5.6" width="8.8" height="8.8" rx="1.8" fill="currentColor" stroke="none"/>';
const SYMBOL_UNTEN = '<path d="M10 4.4v11M5.4 10.8 10 15.4l4.6-4.6"/>';
const SYMBOL_KOPIEREN = '<rect x="7" y="7" width="9.6" height="9.6" rx="2.2"/><path d="M13 7V5.2A1.8 1.8 0 0 0 11.2 3.4H5.2a1.8 1.8 0 0 0-1.8 1.8v6a1.8 1.8 0 0 0 1.8 1.8H7"/>';
const SYMBOL_LAUT = '<path d="M3.6 7.8h2.8L10 4.6v10.8l-3.6-3.2H3.6z"/><path d="M13 7.4a3.6 3.6 0 0 1 0 5.2M15.2 5.2a6.8 6.8 0 0 1 0 9.6"/>';
const SYMBOL_PFEIL = '<path d="m7.6 5.4 4.6 4.6-4.6 4.6"/>';
const SYMBOL_SCHLIESSEN = '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>';

/* ------------------------------------------------------------------ */
/* Sitzungen: der Zustand eines Chats, unabhaengig von der Ansicht     */
/* ------------------------------------------------------------------ */

/** chatId -> Sitzung. Lebt, solange die Seite offen ist. */
const sitzungen = new Map();

function sitzungFuer(chatId) {
  let s = sitzungen.get(chatId);
  if (!s) {
    s = {
      chatId,
      titel: null,
      nachrichten: [],
      geladen: false,
      /** {controller, antwortId, stoppt} solange ein Strom laeuft */
      lauf: null,
      /** Wer zuhoert (die eingehaengte Ansicht). */
      abos: new Set(),
    };
    sitzungen.set(chatId, s);
  }
  return s;
}

function melden(s, art) {
  for (const fn of [...s.abos]) {
    try {
      fn(art);
    } catch (err) {
      console.error('[neural-os] Chat-Ansicht:', err);
    }
  }
}

function nachricht(s, id) {
  return s.nachrichten.find((m) => m.id === id) || null;
}

/** Einen Satz vom Server einsetzen -- ersetzt die vorlaeufige Fassung. */
function einsetzen(s, record) {
  if (!record || !record.id || !record.data) return null;
  const i = s.nachrichten.findIndex((m) => m.id === record.id);
  const neu = { ...record, data: { ...record.data } };
  if (i >= 0) {
    // Was nur der Strom kannte (Hinweise, der Grund des Endes), bleibt stehen.
    const alt = s.nachrichten[i];
    if (alt._hinweise) neu._hinweise = alt._hinweise;
    if (alt._stop) neu._stop = alt._stop;
    s.nachrichten[i] = neu;
  } else {
    // Die vorlaeufige eigene Nachricht weicht der echten.
    if (record.data.role === 'user') {
      const lokal = s.nachrichten.findIndex((m) => m._lokal);
      if (lokal >= 0) s.nachrichten.splice(lokal, 1);
    }
    s.nachrichten.push(neu);
    s.nachrichten.sort(ordnung);
  }
  return neu;
}

function ordnung(a, b) {
  if (a._lokal !== b._lokal) return a._lokal ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  const ao = Number(a.data && a.data.ordinal);
  const bo = Number(b.data && b.data.ordinal);
  if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
  return a.id < b.id ? -1 : 1;
}

/** Die Antwort, in die der laufende Strom schreibt. */
function aktiveAntwort(s) {
  if (s.lauf && s.lauf.antwortId) return nachricht(s, s.lauf.antwortId);
  return null;
}

/** Die Antwort, die einen Agenten mit dieser Kennung traegt (auch vor `antwort`). */
function antwortMitAgent(s, agentId) {
  for (let i = s.nachrichten.length - 1; i >= 0; i--) {
    const m = s.nachrichten[i];
    if (Array.isArray(m.data.agenten) && m.data.agenten.some((a) => a.id === agentId)) return m;
  }
  return null;
}

/**
 * Ein Ereignis aus dem Strom (Vertrag 6) in die Sitzung uebernehmen.
 * Reine Datenarbeit; gezeichnet wird danach gebuendelt.
 */
function ereignis(s, typ, p) {
  const aktiv = aktiveAntwort(s);
  switch (typ) {
    case 'verworfen': {
      const weg = new Set(Array.isArray(p.ids) ? p.ids : []);
      s.nachrichten = s.nachrichten.filter((m) => !weg.has(m.id));
      break;
    }
    case 'nutzer':
      einsetzen(s, p.record);
      break;
    case 'antwort': {
      const m = einsetzen(s, p.record);
      if (m && s.lauf) s.lauf.antwortId = m.id;
      break;
    }
    case 'text':
      if (aktiv && typeof p.delta === 'string') aktiv.data.content = `${aktiv.data.content || ''}${p.delta}`;
      break;
    case 'denken':
      if (aktiv && typeof p.delta === 'string') aktiv.data.denken = `${aktiv.data.denken || ''}${p.delta}`;
      break;
    case 'quelle':
      if (aktiv && p.url) {
        const q = Array.isArray(aktiv.data.quellen) ? aktiv.data.quellen : [];
        if (!q.some((x) => x.url === p.url)) q.push({ titel: p.titel || p.url, url: p.url, art: p.art || 'zitat' });
        aktiv.data.quellen = q;
      }
      break;
    case 'agent': {
      const ziel = aktiv || antwortMitAgent(s, p.id);
      if (!ziel) break;
      const liste = Array.isArray(ziel.data.agenten) ? ziel.data.agenten.slice() : [];
      const i = liste.findIndex((a) => a.id === p.id);
      const vorher = i >= 0 ? liste[i] : {};
      const neu = {
        ...vorher,
        id: p.id,
        runId: p.runId || vorher.runId || null,
        rolle: p.rolle || vorher.rolle,
        titel: p.titel || vorher.titel,
        zustand: p.zustand,
        ergebnis: p.ergebnis || null,
        schritt: p.schritt || '',
        dauerMs: p.dauerMs,
      };
      if (p.werkzeug) neu.werkzeug = p.werkzeug;
      if (p.wirkung) neu.wirkung = p.wirkung;
      // Die Stelle im Text, bis der gespeicherte Satz sie genau nennt.
      if (!Number.isFinite(neu.beiZeichen)) neu.beiZeichen = String(ziel.data.content || '').length;
      if (i >= 0) liste[i] = neu;
      else liste.push(neu);
      ziel.data.agenten = liste;
      break;
    }
    case 'rueckfrage':
      if (aktiv) {
        const fragen = Array.isArray(aktiv.data.rueckfragen) ? aktiv.data.rueckfragen.slice() : [];
        if (!fragen.some((f) => f.id === p.id)) {
          fragen.push({
            id: p.id,
            frage: p.frage,
            optionen: (p.optionen || []).map((o) => (typeof o === 'string' ? o : o.label)),
            mehrfach: p.mehrfach === true,
            zustand: 'offen',
            antwort: null,
            beiZeichen: String(aktiv.data.content || '').length,
          });
        }
        aktiv.data.rueckfragen = fragen;
        aktiv.data.rueckfrageOffen = true;
      }
      break;
    case 'hinweis':
      if (aktiv && p.satz) aktiv._hinweise = [...(aktiv._hinweise || []), p.satz];
      break;
    case 'fehler':
      if (aktiv) aktiv.data.error = { code: p.code, message: p.satz };
      else s.fehler = { code: p.code, message: p.satz };
      break;
    case 'fertig': {
      const m = p.record ? einsetzen(s, p.record) : aktiv;
      if (m) m._stop = p.stopReason || null;
      break;
    }
    default:
      break;
  }
}

/**
 * Einen Strom fahren (Senden, Rueckfrage beantworten, neu antworten,
 * bearbeiten). Fehler VOR dem Strom (HTTP-Status: nicht verbunden, leer,
 * schon beschaeftigt) werden geworfen -- der Aufrufer zeigt sie und gibt dem
 * Nutzer seinen Text zurueck. Bricht der Strom mittendrin ab, wird die
 * Antwort ehrlich als unterbrochen markiert und der Stand vom Server geholt.
 */
async function strom(s, api, pfad, body) {
  if (s.lauf) throw new ApiError('BUSY', 'Für diesen Chat läuft bereits eine Antwort.', { status: 409 });
  const controller = new AbortController();
  s.lauf = { controller, antwortId: null, stoppt: false, beginn: Date.now() };
  s.fehler = null;
  melden(s, 'lauf');
  let fertig = false;
  try {
    await api.stream(pfad, {
      body,
      signal: controller.signal,
      onEvent: (ev) => {
        if (ev.type === 'fertig') fertig = true;
        ereignis(s, ev.type, ev.payload || {});
        melden(s, ev.type === 'text' || ev.type === 'denken' ? 'text' : 'daten');
      },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status > 0) {
      // Vor dem Strom abgelehnt: nichts ist entstanden.
      s.lauf = null;
      melden(s, 'lauf');
      throw err;
    }
    const aktiv = aktiveAntwort(s);
    if (aktiv && !fertig) {
      const abgebrochen = err instanceof ApiError && err.isAborted;
      aktiv.data.status = abgebrochen ? 'aborted' : 'failed';
      if (!abgebrochen) aktiv.data.error = { code: err.code || 'STREAM_INTERRUPTED', message: err.message || 'Die Verbindung ist während der Antwort abgebrochen.' };
    }
  } finally {
    if (s.lauf && s.lauf.controller === controller) {
      s.lauf = null;
      melden(s, 'lauf');
    }
  }
  if (!fertig) {
    // Was wirklich gespeichert ist, weiss nur der Server.
    setTimeout(() => nachladen(s, api).catch(() => {}), 700);
  }
  return fertig;
}

async function nachladen(s, api) {
  const res = await api.get(`/chats/${encodeURIComponent(s.chatId)}/messages`, { query: { limit: 2000 } });
  if (s.lauf) return; // ein neuer Strom ist schneller als diese Antwort
  const items = Array.isArray(res && res.items) ? res.items : [];
  const alt = new Map(s.nachrichten.map((m) => [m.id, m]));
  s.nachrichten = items.map((r) => {
    const vorher = alt.get(r.id);
    const neu = { ...r, data: { ...r.data } };
    if (vorher && vorher._hinweise) neu._hinweise = vorher._hinweise;
    if (vorher && vorher._stop) neu._stop = vorher._stop;
    return neu;
  }).sort(ordnung);
  s.geladen = true;
  melden(s, 'alles');
}

async function stoppen(s, api) {
  if (!s.lauf || s.lauf.stoppt) return;
  const lauf = s.lauf;
  lauf.stoppt = true;
  melden(s, 'lauf');
  let angenommen = false;
  try {
    const r = await api.post(`/chats/${encodeURIComponent(s.chatId)}/abort`, {}, { timeoutMs: 5000 });
    angenommen = !!(r && r.aborted);
  } catch {
    angenommen = false;
  }
  // Der Server beendet den Strom selbst mit `fertig {abgebrochen}` und dem
  // gespeicherten Teiltext. Tut er es nicht (oder hatte er noch gar nicht
  // angefangen), wird die Leitung gekappt -- auch das bricht ab.
  if (!angenommen) lauf.controller.abort();
  else setTimeout(() => { if (s.lauf === lauf) lauf.controller.abort(); }, STOPP_WACHHUND_MS);
}

/* ------------------------------------------------------------------ */
/* Kleinigkeiten                                                       */
/* ------------------------------------------------------------------ */

function speicher(art, key, value) {
  try {
    if (art === 'lesen') return window.localStorage.getItem(key);
    if (art === 'loeschen') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* privates Fenster, voller Speicher: der Entwurf ist eine Bequemlichkeit */
  }
  return null;
}

function istEingabe(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function hostVon(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Ein Zaun, der sicher laenger ist als jede Backtick-Folge im Text. */
function zaun(inhalt) {
  let n = 3;
  for (const m of String(inhalt).matchAll(/`{3,}/g)) n = Math.max(n, m[0].length + 1);
  return '`'.repeat(n);
}

function groesse(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/**
 * Bis zu drei Vorschlaege fuer den naechsten Schritt, aus der Antwort
 * abgeleitet -- ohne weiteren (bezahlten) Aufruf. Bewusst schlicht: eine
 * lange Antwort bekommt "Kürzer", eine Aufzaehlung "Als Tabelle", ein Plan
 * "Nächste Schritte". Lieber drei treffende als fuenf beliebige.
 */
export function vorschlaegeFuer(m) {
  const t = String((m && m.data && m.data.content) || '');
  if (!t.trim()) return [];
  const out = [];
  const dazu = (label, sende, symbol) => {
    if (out.length < 3 && !out.some((v) => v.label === label)) out.push({ label, sende, symbol });
  };
  const karte = /```(?:prompt|text|e-?mail|nachricht)\b/i.test(t);
  const code = !karte && /```/.test(t);
  const punkte = (t.match(/^\s*(?:[-*+]|\d{1,2}[.)])\s+\S/gm) || []).length;
  const tabelle = /^\s*\|.*\|\s*$/m.test(t);
  const agenten = Array.isArray(m.data.agenten) ? m.data.agenten : [];
  const termin = agenten.some((a) => !a.zurueckgenommen && Array.isArray(a.wirkung) && a.wirkung.some((w) => w.typ === 'event' && w.aktion === 'angelegt'));

  if (karte) {
    dazu('Noch besser', 'Mach den Text noch besser: genauer, klarer, mit allem, was fehlt.', 'pen');
    dazu('Kürzere Fassung', 'Schreib eine kürzere Fassung davon.', 'list');
  }
  if (code) dazu('Erklär den Code', 'Erklär mir den Code Schritt für Schritt.', 'info');
  if (termin) dazu('Erinnere mich', 'Erinnere mich an den Termin eine Stunde vorher.', 'clock');
  if (/\b(plan|planung|schritte?|vorgehen|ablauf|fahrplan)\b/i.test(t)) dazu('Nächste Schritte', 'Was sind die nächsten konkreten Schritte?', 'list');
  if (punkte >= 3 && !tabelle) dazu('Als Tabelle', 'Stell das bitte als Tabelle dar.', 'clipboard');
  if (t.length > 1400) dazu('Kürzer', 'Fass das bitte kürzer zusammen.', 'clipboard');
  else if (t.length < 450 && !termin) dazu('Mehr Details', 'Erklär das bitte ausführlicher.', 'info');
  dazu('Ein Beispiel', 'Gib mir ein konkretes Beispiel dazu.', 'question');
  return out;
}

/* ------------------------------------------------------------------ */
/* Vorlesen                                                            */
/* ------------------------------------------------------------------ */

let sprichtId = null;
const sprechAbos = new Set();

function sprechenMoeglich() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
}

function sprechZustand(id) {
  sprichtId = id;
  for (const fn of [...sprechAbos]) fn();
}

/**
 * Vorlesen mit deutscher Stimme. In Saetzen, nicht am Stueck: Chromium
 * bricht eine einzelne lange Aeusserung nach etwa 15 Sekunden still ab.
 */
function vorlesen(id, inhalt) {
  const synth = window.speechSynthesis;
  if (sprichtId === id) {
    synth.cancel();
    sprechZustand(null);
    return;
  }
  synth.cancel();
  const klar = extractPlain(inhalt).replace(/\s+/g, ' ').trim();
  if (!klar) return;
  const saetze = klar.match(/[^.!?…]+[.!?…]*\s*/g) || [klar];
  const stuecke = [];
  let puffer = '';
  for (const satz of saetze) {
    if ((puffer + satz).length > 220 && puffer) {
      stuecke.push(puffer);
      puffer = '';
    }
    puffer += satz;
  }
  if (puffer.trim()) stuecke.push(puffer);
  const stimme = (synth.getVoices() || []).find((v) => /^de([-_]|$)/i.test(v.lang)) || null;
  stuecke.forEach((stueck, i) => {
    const u = new window.SpeechSynthesisUtterance(stueck.trim());
    u.lang = 'de-DE';
    if (stimme) u.voice = stimme;
    if (i === stuecke.length - 1) {
      u.onend = () => { if (sprichtId === id) sprechZustand(null); };
    }
    u.onerror = () => { if (sprichtId === id) sprechZustand(null); };
    synth.speak(u);
  });
  sprechZustand(id);
}

/* ------------------------------------------------------------------ */
/* Die Ansicht                                                         */
/* ------------------------------------------------------------------ */

let eingehaengt = null;

function mount(container, ctx) {
  ensureStyle();
  eingehaengt = baueAnsicht(container, ctx);
  return eingehaengt.start();
}

function unmount() {
  if (eingehaengt) eingehaengt.weg();
  eingehaengt = null;
}

function baueAnsicht(container, ctx) {
  const api = ctx.api || defaultApi;
  const I = ctx.icons || {};
  const offs = [];
  const route = ctx.route || { params: {} };
  let chatId = route.params && route.params.id ? String(route.params.id) : null;
  let s = chatId ? sitzungFuer(chatId) : null;
  let lebt = true;
  let claude = null; // {verbunden, grundCode, grund, …} oder null (unbekannt)
  let claudeGeprueft = false;
  let wartet = null; // Text, der nach dem Verbinden gesendet wird
  // Die Verbinden-Karte wird neu gebaut, sobald sich der Claude-Zustand
  // aendert (Netzmodus, Tresor ...). Schluessel und Fehlersatz ueberleben das
  // hier -- nur im Speicher dieses Tabs, nie im Browser-Speicher.
  let schluesselEntwurf = '';
  let verbindenFehler = '';
  let verbindet = false;
  let folgen = true;
  let anhaenge = [];
  /** Zustand der Oberflaeche je Nachricht: auf-/zugeklappt, Auswahl … */
  const ui = new Map();
  const knoten = new Map(); // id -> {node, sig}
  let zeichnenGeplant = false;
  let ersteZeichnung = true;
  let neuAngelegt = false;

  const uiVon = (id) => {
    if (!ui.has(id)) ui.set(id, { v: 0, fragen: new Map() });
    return ui.get(id);
  };
  const frageUi = (m, f) => {
    const u = uiVon(m.id);
    if (!u.fragen.has(f.id)) u.fragen.set(f.id, { auswahl: new Set(), eigenOffen: false, eigenText: '', sendet: null, fehler: null });
    return u.fragen.get(f.id);
  };
  const neuZeichnen = (id) => {
    const u = uiVon(id);
    u.v += 1;
    plane();
  };

  /* -------------------------------------------------------- Geruest */

  clear(container);
  const root = h('div.cv');
  const scroller = h('div.cv__scroll');
  const spalte = h('div.cv__spalte');
  const oben = h('div.cv__oben'); // leerer Zustand / Verbinden-Karte
  const verlauf = h('div.cv__verlauf', { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const fehlerZeile = h('p.cv-status.cv-status--fehler', { role: 'alert', hidden: true });
  spalte.append(oben, verlauf, fehlerZeile);
  scroller.appendChild(spalte);

  const feld = h('textarea.cv-composer__feld', {
    rows: 1,
    placeholder: 'Nachricht eingeben …',
    'aria-label': 'Nachricht an Claude. Enter sendet, Umschalt+Enter macht eine neue Zeile.',
    enterkeyhint: 'send',
    autocomplete: 'off',
    spellcheck: 'true',
  });
  const dateiWahl = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    accept: 'text/*,.md,.markdown,.csv,.tsv,.json,.log,.js,.mjs,.ts,.py,.html,.css,.xml,.yml,.yaml,.ini,.toml,.sh,.bat,.ics,.sql',
  });
  const clip = h('button.cv-composer__clip', {
    type: 'button',
    title: 'Textdatei anhängen',
    'aria-label': 'Textdatei anhängen',
    onClick: () => dateiWahl.click(),
  }, icon(I.clip));
  const sendKnopf = h('button.cv-composer__senden', { type: 'submit', 'aria-label': 'Senden', title: 'Senden (Enter)' }, icon(I.send));
  const anhangZeile = h('div.cv-anhaenge', { hidden: true });
  const verbindenUnten = h('div.cv-eingabe__verbinden', { hidden: true });
  const nachUnten = h('button.cv-nachunten', {
    type: 'button',
    hidden: true,
    'aria-label': 'Nach unten',
    title: 'Nach unten',
    onClick: () => {
      folgen = true;
      ansEnde(true);
      nachUnten.hidden = true;
    },
  }, icon(SYMBOL_UNTEN));
  const formular = h('form.cv-composer', { onSubmit: (e) => { e.preventDefault(); absenden(); } },
    clip, feld, sendKnopf);
  const eingabe = h('div.cv-eingabe', null,
    h('div.cv-eingabe__innen', null, nachUnten, verbindenUnten, anhangZeile, formular, dateiWahl));

  root.append(scroller, eingabe);
  container.appendChild(root);

  /* ------------------------------------------------------- Rollen */

  function ansEnde(sanft) {
    const ziel = scroller.scrollHeight - scroller.clientHeight;
    if (sanft && typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: ziel, behavior: 'smooth' });
    else scroller.scrollTop = ziel;
  }

  offs.push(on(scroller, 'scroll', () => {
    const rest = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    folgen = rest < FOLGEN_PX;
    nachUnten.hidden = folgen || !s || !s.nachrichten.length;
  }, { passive: true }));

  /* ------------------------------------------------------- Zeichnen */

  function plane() {
    if (zeichnenGeplant || !lebt) return;
    zeichnenGeplant = true;
    const los = () => {
      zeichnenGeplant = false;
      if (lebt) zeichne();
    };
    if (typeof window.requestAnimationFrame === 'function' && !document.hidden) window.requestAnimationFrame(los);
    else setTimeout(los, 60);
  }

  function letzteAntwortId() {
    if (!s) return null;
    const liste = s.nachrichten;
    const m = liste[liste.length - 1];
    return m && m.data.role === 'assistant' ? m.id : null;
  }

  function zeichne() {
    const liste = s ? s.nachrichten : [];
    zeichneOben(liste.length === 0);
    const letzte = letzteAntwortId();
    const laeuft = !!(s && s.lauf);
    const aktivId = s && s.lauf ? s.lauf.antwortId : null;
    const bleiben = new Set();
    let vorher = null;
    for (const m of liste) {
      bleiben.add(m.id);
      const u = uiVon(m.id);
      const sig = signatur(m, u, m.id === letzte, laeuft, m.id === aktivId);
      let eintrag = knoten.get(m.id);
      if (!eintrag || eintrag.sig !== sig) {
        const node = m.data.role === 'user' ? baueEigene(m, u) : baueAntwort(m, u, m.id === letzte, m.id === aktivId);
        if (eintrag && eintrag.node.parentNode === verlauf) {
          // Fokus in einem Feld darin (eigene Antwort) nicht verlieren.
          const fokus = eintrag.node.contains(document.activeElement) ? document.activeElement : null;
          const fokusKey = fokus && fokus.dataset ? fokus.dataset.key : null;
          verlauf.replaceChild(node, eintrag.node);
          if (fokusKey) {
            const wieder = node.querySelector(`[data-key="${CSS.escape(fokusKey)}"]`);
            if (wieder) wieder.focus({ preventScroll: true });
          }
        }
        eintrag = { node, sig };
        knoten.set(m.id, eintrag);
      }
      const soll = vorher ? vorher.nextSibling : verlauf.firstChild;
      if (eintrag.node !== soll) verlauf.insertBefore(eintrag.node, soll);
      vorher = eintrag.node;
    }
    for (const [id, eintrag] of [...knoten]) {
      if (bleiben.has(id)) continue;
      eintrag.node.remove();
      knoten.delete(id);
    }
    // Ein Fehler ohne Antwort (vor `antwort`): sichtbar, nicht verschluckt.
    fehlerZeile.hidden = !(s && s.fehler);
    if (s && s.fehler && fehlerZeile.dataset.satz !== s.fehler.message) {
      fehlerZeile.dataset.satz = s.fehler.message;
      fehlerZeile.replaceChildren(icon(I.alert), h('span', null, text(s.fehler.message)));
    }
    aktualisiereEingabe();
    if (folgen || ersteZeichnung) ansEnde(false);
    ersteZeichnung = false;
    nachUnten.hidden = folgen || !liste.length;
  }

  function signatur(m, u, letzte, laeuft, aktiv) {
    const d = m.data;
    return JSON.stringify([
      m.updatedAt, d.status, (d.content || '').length, (d.denken || '').length, d.agenten, d.rueckfragen,
      d.rueckfrageOffen, (d.quellen || []).length, d.error, d.abgeschnitten, m._hinweise, m._stop, m._lokal,
      letzte, laeuft, aktiv, u.v, sprichtId === m.id, !!claude && claude.verbunden,
    ]);
  }

  /* ------------------------------------------ oben: leer / verbinden */

  /**
   * Was ueber dem Verlauf steht: die grosse Frage (leer), die
   * Verbinden-Karte (leer, ohne Claude) oder -- wenn schon Nachrichten da
   * sind -- die Karte klein ueber dem Eingabefeld. Neu gebaut wird nur,
   * wenn sich daran etwas aendert; sonst verloere das Schluesselfeld beim
   * Tippen seinen Inhalt.
   */
  let obenKey = null;
  let ladeFehler = false;

  function zeichneOben(leer) {
    if (ladeFehler) return;
    // Waehrend "Verbinden" laeuft, bleibt die Karte stehen (Knopf, Spinner).
    if (verbindet) return;
    const fehlt = !!claude && claude.verbunden === false;
    const art = leer ? (fehlt ? 'verbinden' : (claudeGeprueft ? 'leer' : 'laedt')) : (fehlt ? 'unten' : 'nichts');
    const key = `${art}|${fehlt ? JSON.stringify([claude.grundCode, claude.grund, mussOnline()]) : ''}`;
    if (key === obenKey) return;
    obenKey = key;
    clear(oben);
    clear(verbindenUnten);
    verbindenUnten.hidden = true;
    if (art === 'leer') oben.appendChild(baueLeer());
    else if (art === 'verbinden') oben.appendChild(baueVerbinden(false));
    else if (art === 'unten') {
      verbindenUnten.appendChild(baueVerbinden(true));
      verbindenUnten.hidden = false;
    }
  }

  function baueLeer() {
    return h('section.cv-leer', { 'aria-labelledby': 'cv-leer-titel' },
      h('h2.cv-leer__titel#cv-leer-titel', null, text('Womit kann ich dir helfen?')),
      h('p.cv-leer__unter', null, text('Ich denke mit, plane voraus und setze um – gemeinsam mit meinen Agenten.')),
      h('div.cv-leer__start', null, STARTER.map((st) => h('button.btn.btn--accent.cv-knopf', {
        type: 'button',
        onClick: () => {
          feld.value = st.text;
          groesseAnpassen();
          aktualisiereEingabe();
          feld.focus();
          feld.setSelectionRange(feld.value.length, feld.value.length);
        },
      }, icon(I[st.symbol]), h('span', null, text(st.label))))));
  }

  /**
   * Offline (ab Werk) oder nur lokales Netz: der Schluessel laesst sich erst
   * pruefen, wenn Neural OS ins Internet darf (src/models/claude.js,
   * 409 CLAUDE_OFFLINE). Dieselbe Bedingung wie dort.
   */
  function mussOnline() {
    const n = claude && claude.netz;
    return !!n && n.erlaubt === false && !!n.modus && n.modus !== 'online';
  }

  /**
   * Die ruhige Karte, wenn Claude nicht antworten kann. Genau ein Feld, ein
   * Satz, wo es den Schluessel gibt -- und danach geht es sofort weiter.
   * Ist Neural OS offline, ist das derselbe eine Schritt: der Knopf sagt
   * "Online gehen und verbinden", und genau das tut der Klick.
   */
  function baueVerbinden(kompakt) {
    const code = claude && claude.grundCode;
    const karte = h('section.cv-verbinden', { class: kompakt ? 'cv-verbinden--kompakt' : '', 'data-grund': code || 'unbekannt' });
    const kopf = (titel) => h('div.cv-verbinden__kopf', null,
      h('span.avatar', { 'aria-hidden': 'true' }, icon(I.brand)),
      h('h2.cv-verbinden__titel', null, text(titel)));
    const fehler = h('p.cv-verbinden__fehler', { role: 'alert', hidden: true });
    const zeigeFehler = (satz) => {
      clear(fehler);
      fehler.appendChild(text(satz));
      fehler.hidden = false;
    };

    if (code === 'offline') {
      const schalter = h('button.btn.btn--primary', {
        type: 'button',
        onClick: async () => {
          schalter.disabled = true;
          try {
            await api.put('/network', { mode: 'online' });
            await claudeLaden();
          } catch (err) {
            zeigeFehler(err && err.status === 403
              ? 'Online schalten geht nur am Gerät selbst, auf dem Neural OS läuft.'
              : `Nicht umgeschaltet: ${(err && err.message) || 'unbekannter Fehler'}`);
          } finally {
            schalter.disabled = false;
          }
        },
      }, icon(I.cloud), h('span', null, text('Online schalten')));
      karte.append(kopf('Die KI braucht Internet'),
        h('p.cv-verbinden__text', null, text('Neural OS ist gerade offline. Claude antwortet nur, wenn Neural OS ins Internet darf.')),
        h('div.cv-verbinden__form', null, schalter),
        fehler);
      return karte;
    }
    if (code === 'gesperrt') {
      const ziel = claude && typeof claude.ziel === 'string' && claude.ziel.startsWith('#/') ? claude.ziel : '#/settings';
      karte.append(kopf('Erst die PIN'),
        h('p.cv-verbinden__text', null, text((claude && claude.grund) || 'Der Tresor ist gesperrt. Entsperre ihn mit deiner PIN, dann kann Claude antworten.')),
        h('div.cv-verbinden__form', null, h('a.btn.btn--primary', { href: ziel }, icon(I.unlock), h('span', null, text('PIN eingeben')))));
      return karte;
    }
    if (code === 'schleuse') {
      karte.append(kopf('Claude ist gesperrt'),
        h('p.cv-verbinden__text', null, text(claude.grund || 'Die Netzschleuse lässt api.anthropic.com gerade nicht durch.')),
        h('div.cv-verbinden__form', null, h('a.btn', { href: '#/network' }, icon(I.network), h('span', null, text('Netzwerk öffnen')))));
      return karte;
    }
    if (code !== 'kein-schluessel' && code !== 'schluessel-falsch' && claude && claude.grund && !code) {
      karte.append(kopf('Claude ist nicht erreichbar'), h('p.cv-verbinden__text', null, text(claude.grund)));
      return karte;
    }

    // Kein oder ein falscher Schluessel: das eine Feld.
    const online = mussOnline();
    const knopfText = online ? 'Online gehen und verbinden' : 'Verbinden';
    const eingabeFeld = h('input.input', {
      type: 'password',
      name: 'claude-schluessel',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'sk-ant-…',
      'aria-label': 'Claude-Schlüssel',
      onInput: (e) => { schluesselEntwurf = e.target.value; },
    });
    eingabeFeld.value = schluesselEntwurf;
    if (verbindenFehler) zeigeFehler(verbindenFehler);
    const knopf = h('button.btn.btn--primary', { type: 'submit' }, h('span', null, text(knopfText)));
    const form = h('form.cv-verbinden__form', {
      onSubmit: async (e) => {
        e.preventDefault();
        const wert = eingabeFeld.value.trim();
        if (!wert) {
          eingabeFeld.focus();
          return;
        }
        schluesselEntwurf = eingabeFeld.value;
        verbindenFehler = '';
        verbindet = true;
        knopf.disabled = true;
        eingabeFeld.disabled = true;
        clear(knopf);
        knopf.append(h('span.spinner.cv-spinner', { 'aria-hidden': 'true' }), h('span', null, text(online ? 'Gehe online …' : 'Prüfe …')));
        fehler.hidden = true;
        // Die Zustimmung ist der Klick auf "Online gehen und verbinden".
        // Scheitert danach die Pruefung, geht der Netzmodus zurueck -- der
        // Klick galt beidem zusammen.
        const vorher = online ? claude.netz.modus : null;
        let umgeschaltet = false;
        try {
          if (online) {
            await api.put('/network', { mode: 'online' });
            umgeschaltet = true;
          }
          const z = await api.post('/claude/schluessel', { schluessel: wert }, { timeoutMs: 45000 });
          claude = { ...z };
          schluesselEntwurf = '';
          eingabeFeld.value = '';
          ctx.toast('Claude ist verbunden.', 'success');
          verbindet = false;
          obenKey = null;
          plane();
          if (wartet) {
            const t = wartet;
            wartet = null;
            senden(t);
          } else {
            feld.focus();
          }
        } catch (err) {
          if (umgeschaltet && vorher) {
            try { await api.put('/network', { mode: vorher }); } catch { /* der Status unten links zeigt, was gilt */ }
          }
          if (online && !umgeschaltet) {
            verbindenFehler = err && err.status === 403
              ? 'Online schalten geht nur am Gerät selbst, auf dem Neural OS läuft.'
              : `Nicht umgeschaltet: ${(err && err.message) || 'unbekannter Fehler'}`;
          } else if (!(err && err.code === 'CLAUDE_OFFLINE')) {
            // CLAUDE_OFFLINE ohne Umschalten: der Zustand war veraltet; die
            // neu gebaute Karte bietet "Online gehen und verbinden" an.
            verbindenFehler = (err && err.message) || 'Der Schlüssel ließ sich nicht prüfen.';
          }
          verbindet = false;
          await claudeLaden();
          if (!lebt) return;
          obenKey = null;
          plane();
        } finally {
          verbindet = false;
          if (knopf.isConnected) {
            knopf.disabled = false;
            eingabeFeld.disabled = false;
            clear(knopf);
            knopf.appendChild(h('span', null, text(knopfText)));
          }
        }
      },
    }, eingabeFeld, knopf);
    karte.append(kopf('Verbinde Claude'),
      h('p.cv-verbinden__text', null, text(code === 'schluessel-falsch'
        ? 'Der gespeicherte Schlüssel wird nicht mehr angenommen. Füge einen neuen ein – danach geht es sofort weiter.'
        : 'Neural OS denkt mit Claude von Anthropic. Füge einmal deinen Schlüssel ein – danach geht es sofort los.')),
      form,
      fehler,
      h('p.cv-verbinden__hinweis', null,
        text('Den Schlüssel bekommst du auf '),
        h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener noreferrer' }, text('console.anthropic.com')),
        text(' unter „API Keys“. Er bleibt im Tresor auf deinem Stick.')));
    return karte;
  }

  /* ---------------------------------------------- eigene Nachricht */

  function baueEigene(m, u) {
    const inhalt = String(m.data.content || '');
    const zeile = h('div.cv-msg.cv-msg--user', { 'data-id': m.id, onClick: (e) => antippen(e, m.id) });
    const spalteN = h('div.cv-msg__spalte');
    if (u.bearbeiten) {
      spalteN.appendChild(baueBearbeiten(m, u));
      zeile.appendChild(spalteN);
      return zeile;
    }
    const lang = inhalt.length > LANG_ZEICHEN || inhalt.split('\n').length > LANG_ZEILEN;
    const blase = h('div.cv-bubble.cv-bubble--user', { class: lang && !u.voll ? 'is-lang' : '' },
      h('div.cv-bubble__text', null, text(inhalt)));
    if (lang) {
      blase.appendChild(h('button.cv-mehr', {
        type: 'button',
        onClick: (e) => {
          e.stopPropagation();
          u.voll = !u.voll;
          neuZeichnen(m.id);
        },
      }, text(u.voll ? 'Weniger zeigen' : 'Ganz anzeigen')));
    }
    blase.appendChild(h('span.cv-zeit', null,
      m.data.bearbeitetAm ? h('span.cv-zeit__zusatz', null, text('bearbeitet · ')) : null,
      text(m._lokal ? 'sendet …' : uhrzeit(m.createdAt))));
    spalteN.appendChild(blase);
    if (!m._lokal) {
      spalteN.appendChild(h('div.cv-aktionen', { role: 'toolbar', 'aria-label': 'Nachricht' },
        kopierAktion(() => inhalt, 'Nachricht kopieren'),
        s && s.lauf ? null : aktion(I.pen, 'Bearbeiten', () => {
          u.bearbeiten = true;
          u.entwurf = inhalt;
          neuZeichnen(m.id);
          setTimeout(() => {
            const t = verlauf.querySelector(`[data-key="${CSS.escape(`bearbeiten:${m.id}`)}"]`);
            if (t) {
              t.focus();
              t.setSelectionRange(t.value.length, t.value.length);
            }
          }, 30);
        })));
    }
    zeile.appendChild(spalteN);
    return zeile;
  }

  function baueBearbeiten(m, u) {
    const t = h('textarea.textarea.cv-bearbeiten__feld', {
      'aria-label': 'Nachricht bearbeiten',
      'data-key': `bearbeiten:${m.id}`,
      rows: Math.min(10, Math.max(3, String(u.entwurf || '').split('\n').length + 1)),
      onInput: (e) => { u.entwurf = e.target.value; },
      onKeydown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          u.bearbeiten = false;
          neuZeichnen(m.id);
        } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          bearbeitenSenden(m, u);
        }
      },
    });
    t.value = u.entwurf || '';
    const fehler = u.fehler ? h('p.cv-status.cv-status--fehler', { role: 'alert' }, text(u.fehler)) : null;
    return h('div.cv-bearbeiten', null, t, fehler,
      h('div.cv-bearbeiten__fuss', null,
        h('span.cv-bearbeiten__hinweis', null, text('Alles danach fällt weg, und Claude antwortet neu.')),
        h('button.btn.btn--ghost', {
          type: 'button',
          onClick: (e) => {
            e.stopPropagation();
            u.bearbeiten = false;
            u.fehler = null;
            neuZeichnen(m.id);
          },
        }, text('Abbrechen')),
        h('button.btn.btn--primary', {
          type: 'button',
          disabled: !!(s && s.lauf),
          onClick: (e) => {
            e.stopPropagation();
            bearbeitenSenden(m, u);
          },
        }, text('Senden'))));
  }

  async function bearbeitenSenden(m, u) {
    const neu = String(u.entwurf || '').trim();
    if (!neu || !s || s.lauf) return;
    if (neu === String(m.data.content || '').trim()) {
      u.bearbeiten = false;
      neuZeichnen(m.id);
      return;
    }
    u.bearbeiten = false;
    u.fehler = null;
    folgen = true;
    neuZeichnen(m.id);
    try {
      await strom(s, api, `/chats/${encodeURIComponent(s.chatId)}/messages/${encodeURIComponent(m.id)}/bearbeiten`, { inhalt: neu });
    } catch (err) {
      u.bearbeiten = true;
      u.fehler = fehlerSatz(err);
      if (err && err.code === 'CLAUDE_NICHT_VERBUNDEN') claudeAus(err);
      neuZeichnen(m.id);
    }
  }

  /* ---------------------------------------------------- Antwort */

  function baueAntwort(m, u, letzte, aktiv) {
    const d = m.data;
    const laeuft = aktiv && !!(s && s.lauf);
    const zeile = h('div.cv-msg.cv-msg--bot', {
      'data-id': m.id,
      class: cx({ 'is-letzte': letzte, 'is-zeige': u.zeige }),
      onClick: (e) => antippen(e, m.id),
    });
    const blase = h('div.cv-bubble.cv-bubble--bot', { class: cx({ 'is-streaming': laeuft }) });
    const agenten = Array.isArray(d.agenten) ? d.agenten : [];
    const fragen = Array.isArray(d.rueckfragen) ? d.rueckfragen : [];
    const inhalt = String(d.content || '');

    // 1. Gedankengang, einklappbar wie bei Claude.
    if (d.denken && String(d.denken).trim()) {
      const denktNoch = laeuft && !inhalt.trim() && !agenten.some((a) => a.zustand === 'laeuft');
      const det = h('details.cv-denken', {
        open: !!u.denkenOffen,
        onToggle: (e) => { u.denkenOffen = e.target.open; },
      },
      h('summary', null, h('span.cv-pfeil', { 'aria-hidden': 'true' }, icon(SYMBOL_PFEIL)),
        denktNoch ? h('span.cv-denken__live', null, h('span.dot.dot--accent.dot--live'), text('Denkt nach …')) : h('span', null, text('Gedankengang'))),
      h('div.cv-denken__text', null, text(String(d.denken).trim())));
      blase.appendChild(det);
    }

    // 2. Was gerade passiert: eine ruhige Zeile je laufendem Agenten.
    const laufend = laeuft ? agenten.filter((a) => a.zustand === 'laeuft' && !(a.rolle === 'planung' && fragen.some((f) => f.zustand === 'offen'))) : [];
    for (const a of laufend) blase.appendChild(liveZeile(a));
    if (laeuft && !inhalt.trim() && !laufend.length && !(d.denken && String(d.denken).trim())) {
      blase.appendChild(h('p.cv-live', null, h('span.dot.dot--accent.dot--live'), h('span.cv-live__text', null, text('Denkt nach …'))));
    }

    // 3. Die Arbeitsschritte, zugeklappt: wer war beteiligt, mit welchem Ergebnis.
    const fertige = agenten.filter((a) => a.zustand !== 'laeuft');
    if (fertige.length && !laeuft) blase.appendChild(schritte(m, u, agenten));

    // 4.–6. Der Text, und an der Stelle, an der es geschah, was die KI
    // angelegt hat (Karten) und was sie gefragt hat (Rueckfragen). Ein Zug
    // mit drei Rueckfragen liest sich so wie ein Gespraech: Satz, Frage,
    // Antwort, Satz -- nicht drei Absaetze Text und darunter drei Fragen.
    const marken = [];
    for (const a of agenten) {
      if (Array.isArray(a.wirkung) && a.wirkung.length && a.zustand === 'fertig') marken.push({ pos: stelle(a.beiZeichen), art: 0, a });
    }
    for (const f of fragen) marken.push({ pos: stelle(f.beiZeichen), art: 1, f });
    marken.sort((x, y) => (x.pos - y.pos) || (x.art - y.art));
    let cursor = 0;
    const textTeil = (bis) => {
      const stueck = inhalt.slice(cursor, bis);
      cursor = bis;
      if (!stueck.trim()) return;
      const md = h('div.cv-md');
      md.appendChild(renderMarkdown(stueck, { kopierKarten: true, hakenKreise: true }));
      blase.appendChild(md);
    };
    for (const mk of marken) {
      textTeil(Math.min(mk.pos, inhalt.length));
      blase.appendChild(mk.art === 0 ? wirkungKarten(m, [mk.a]) : frageKarte(m, mk.f, letzte));
    }
    textTeil(inhalt.length);

    // 7. Quellen der Websuche.
    const quellen = Array.isArray(d.quellen) ? d.quellen : [];
    if (quellen.length) blase.appendChild(quellenListe(u, quellen));

    // 8. Wie es endete, ehrlich.
    for (const n of statusZeilen(m, letzte, laeuft)) blase.appendChild(n);

    if (!laeuft && !m._lokal) blase.appendChild(h('span.cv-zeit', null, text(uhrzeit(m.createdAt))));

    const spalteN = h('div.cv-msg__spalte', null, blase);
    if (!laeuft && inhalt.trim()) spalteN.appendChild(antwortAktionen(m, letzte));
    if (letzte && !laeuft && d.status === 'complete' && !d.rueckfrageOffen && !d.abgeschnitten && !(s && s.lauf)) {
      const vs = vorschlaegeFuer(m);
      if (vs.length) {
        spalteN.appendChild(h('div.cv-vorschlaege', { role: 'group', 'aria-label': 'Vorschläge für den nächsten Schritt' },
          vs.map((v) => h('button.btn.btn--accent.cv-knopf', {
            type: 'button',
            title: v.sende,
            onClick: (e) => {
              e.stopPropagation();
              senden(v.sende);
            },
          }, icon(I[v.symbol] || I.arrow), h('span', null, text(v.label))))));
      }
    }
    zeile.append(h('span.avatar.cv-avatar', { 'aria-hidden': 'true' }, icon(I.brand)), spalteN);
    return zeile;
  }

  /** Die Textstelle einer Karte; ohne Angabe (aeltere Saetze) ans Ende. */
  function stelle(wert) {
    return Number.isFinite(wert) && wert >= 0 ? wert : Number.MAX_SAFE_INTEGER;
  }

  function liveZeile(a) {
    const r = rolle(a.rolle);
    let satz = a.titel || a.schritt || r.kurz;
    if (a.rolle === 'recherche') {
      const q = /^Sucht:\s*(.*)$/.exec(a.titel || '');
      const l = /^Liest:\s*(.*)$/.exec(a.titel || '');
      if (q) satz = `Sucht im Internet: „${q[1]}“`;
      else if (l) satz = `Liest: ${l[1]}`;
      else satz = 'Sucht im Internet';
    } else if (a.schritt) {
      satz = `${a.schritt}: ${String(a.titel || '').replace(/^[^:]+:\s*/, '')}`;
    }
    return h('p.cv-live', { 'data-rolle': a.rolle || '' },
      h('span.cv-live__symbol', { 'aria-hidden': 'true' }, icon(I[r.symbol] || I.agents)),
      h('span.cv-live__text', null, text(`${satz} …`)),
      h('span.dot.dot--accent.dot--live', { 'aria-hidden': 'true' }));
  }

  function schritte(m, u, agenten) {
    const fehler = agenten.filter((a) => a.zustand === 'fehler').length;
    const namen = [...new Set(agenten.map((a) => rolle(a.rolle).kurz))];
    const det = h('details.cv-schritte', {
      open: !!u.schritteOffen,
      onToggle: (e) => { u.schritteOffen = e.target.open; },
    },
    h('summary', null,
      h('span.cv-pfeil', { 'aria-hidden': 'true' }, icon(SYMBOL_PFEIL)),
      h('span', null, text(`${agenten.length} ${agenten.length === 1 ? 'Arbeitsschritt' : 'Arbeitsschritte'} · ${namen.join(', ')}`)),
      fehler ? h('span.cv-schritte__fehler', null, text(` · ${fehler} ${fehler === 1 ? 'Fehler' : 'Fehler'}`)) : null),
    h('ul.cv-schritte__liste', null, agenten.map((a) => {
      const r = rolle(a.rolle);
      const zustand = a.zustand === 'fehler' ? 'fehler' : (a.zustand === 'laeuft' ? 'laeuft' : 'fertig');
      return h('li.cv-schritt', { class: `is-${zustand}` },
        h('span.cv-schritt__symbol', { 'aria-hidden': 'true' }, icon(I[r.symbol] || I.agents)),
        h('span.cv-schritt__main', null,
          h('span.cv-schritt__titel', null, text(a.titel || r.name)),
          a.ergebnis ? h('span.cv-schritt__erg', null, text(a.ergebnis)) : null),
        h('span.cv-schritt__zustand', { title: zustand === 'fehler' ? 'Fehler' : (zustand === 'laeuft' ? 'läuft' : 'erledigt') },
          icon(zustand === 'fehler' ? I.alert : (zustand === 'laeuft' ? I.clock : I.check)),
          Number.isFinite(a.dauerMs) && a.dauerMs > 0 ? h('span', null, text(dauerText(a.dauerMs))) : null));
    })));
    return det;
  }

  /* -------------------------------------------- Karten: angelegt */

  function wirkungKarten(m, agenten) {
    const mit = agenten.filter((a) => Array.isArray(a.wirkung) && a.wirkung.length && a.zustand === 'fertig');
    const u = uiVon(m.id);
    if (!u.wirkung) u.wirkung = new Map();
    const box = h('div.cv-wirkung');
    for (const a of mit) {
      const zustand = u.wirkung.get(a.runId || a.id) || {};
      const zurueck = !!a.zurueckgenommen;
      for (const z of wirkungZeilen(a.wirkung)) {
        const aktionen = h('div.cv-karte__aktionen');
        if (zurueck) {
          aktionen.appendChild(h('span.cv-karte__zurueck', null, icon(I.check), h('span', null, text('Zurückgenommen'))));
        } else {
          if (z.href) aktionen.appendChild(h('a.btn.btn--small', { href: z.href, onClick: (e) => e.stopPropagation() }, text('Öffnen')));
          if (a.runId) {
            aktionen.appendChild(h('button.btn.btn--small.btn--ghost', {
              type: 'button',
              disabled: !!zustand.busy,
              onClick: (e) => {
                e.stopPropagation();
                zuruecknehmen(m, a);
              },
            }, text(zustand.busy ? 'Nimmt zurück …' : 'Rückgängig')));
          }
        }
        box.appendChild(h('div.cv-karte', { class: cx({ 'is-zurueck': zurueck }), 'data-typ': z.typ, 'data-aktion': z.aktion },
          h('span.cv-karte__symbol', { 'aria-hidden': 'true' }, icon(I[z.symbol] || I.check)),
          h('span.cv-karte__text', null,
            h('span.cv-karte__label', null, text(z.label)),
            z.detail ? h('span.cv-karte__detail', null, text(` · ${z.detail}`)) : null),
          aktionen));
      }
      if (zustand.fehler) box.appendChild(h('p.cv-karte__hinweis', { role: 'alert' }, text(zustand.fehler)));
    }
    return box;
  }

  async function zuruecknehmen(m, a) {
    const u = uiVon(m.id);
    const key = a.runId || a.id;
    u.wirkung.set(key, { busy: true });
    neuZeichnen(m.id);
    try {
      const r = await api.post(`/chats/${encodeURIComponent(s.chatId)}/rueckgaengig`, { runId: a.runId });
      const liste = (m.data.agenten || []).map((x) => (x.runId === a.runId ? { ...x, zurueckgenommen: r.am || new Date().toISOString() } : x));
      m.data.agenten = liste;
      u.wirkung.set(key, {});
    } catch (err) {
      u.wirkung.set(key, { fehler: fehlerSatz(err) });
    }
    neuZeichnen(m.id);
  }

  /* ------------------------------------------------- Rueckfrage */

  function frageKarte(m, f, aktivMoeglich) {
    const fu = frageUi(m, f);
    // Offen ist sie, solange sie die letzte Antwort ist und niemand geantwortet
    // hat; bedienbar nur, wenn gerade nichts gesendet wird.
    const offen = f.zustand === 'offen' && m.data.rueckfrageOffen && aktivMoeglich;
    const bedienbar = offen && !fu.sendet && !(s && s.lauf);
    const sendet = new Set(fu.sendet || []);
    const beantwortet = f.zustand === 'beantwortet';
    const gewaehlt = new Set(beantwortet ? String(f.antwort || '').split(/,\s*/) : []);
    const optionen = Array.isArray(f.optionen) ? f.optionen : [];
    const eigeneAntwort = beantwortet && f.antwort && !optionen.some((o) => o === f.antwort) && ![...gewaehlt].every((g) => optionen.includes(g));
    const karte = h('div.cv-frage', {
      'data-zustand': offen ? 'offen' : f.zustand,
      'data-frage': f.id,
      role: 'group',
      'aria-label': f.frage,
    });
    karte.appendChild(h('p.cv-frage__text', null, text(f.frage)));
    const reihe = h('div.cv-frage__optionen');
    optionen.forEach((label, i) => {
      const an = offen ? fu.auswahl.has(label) || sendet.has(label) : gewaehlt.has(label);
      const knopf = h('button.cv-option', {
        type: 'button',
        class: cx({ 'is-gewaehlt': an, 'is-aus': (!offen || sendet.size) && !an }),
        disabled: !bedienbar,
        'aria-pressed': f.mehrfach ? String(an) : null,
        'data-key': `option:${f.id}:${i}`,
        onClick: (e) => {
          e.stopPropagation();
          waehlen(m, f, label);
        },
      },
      i < 9 ? h('span.cv-option__nr', { 'aria-hidden': 'true' }, text(String(i + 1))) : null,
      h('span.cv-option__label', null, text(label)),
      an ? h('span.cv-option__haken', { 'aria-hidden': 'true' }, icon(I.check)) : null,
      sendet.has(label) ? h('span.spinner.cv-spinner', { 'aria-hidden': 'true' }) : null);
      reihe.appendChild(knopf);
    });
    if (offen) {
      reihe.appendChild(h('button.cv-option.cv-option--eigen', {
        type: 'button',
        class: cx({ 'is-offen': fu.eigenOffen }),
        disabled: !bedienbar,
        'data-key': `eigen:${f.id}`,
        onClick: (e) => {
          e.stopPropagation();
          fu.eigenOffen = !fu.eigenOffen;
          neuZeichnen(m.id);
          if (fu.eigenOffen) {
            setTimeout(() => {
              const inp = verlauf.querySelector(`[data-key="eigenfeld:${CSS.escape(f.id)}"]`);
              if (inp) inp.focus();
            }, 30);
          }
        },
      }, h('span.cv-option__symbol', { 'aria-hidden': 'true' }, icon(I.pen)), h('span.cv-option__label', null, text('Eigene Antwort …'))));
    }
    karte.appendChild(reihe);

    if (offen && fu.eigenOffen) {
      const inp = h('input.input', {
        type: 'text',
        placeholder: 'Deine Antwort …',
        maxlength: 500,
        'aria-label': 'Eigene Antwort',
        'data-key': `eigenfeld:${f.id}`,
        enterkeyhint: 'send',
        onInput: (e) => { fu.eigenText = e.target.value; },
        onKeydown: (e) => {
          if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            if (fu.eigenText.trim()) frageSenden(m, f, fu.eigenText.trim());
          } else if (e.key === 'Escape') {
            e.preventDefault();
            fu.eigenOffen = false;
            neuZeichnen(m.id);
          }
        },
      });
      inp.value = fu.eigenText || '';
      karte.appendChild(h('div.cv-frage__eigen', null, inp,
        h('button.btn.btn--primary', {
          type: 'button',
          disabled: !bedienbar,
          onClick: (e) => {
            e.stopPropagation();
            if (fu.eigenText.trim()) frageSenden(m, f, fu.eigenText.trim());
            else inp.focus();
          },
        }, fu.sendet && !optionen.some((o) => sendet.has(o)) ? h('span.spinner.cv-spinner', { 'aria-hidden': 'true' }) : null, text('Senden'))));
    }
    if (offen && f.mehrfach) {
      karte.appendChild(h('div.cv-frage__fuss', null,
        h('span', null, text(fu.auswahl.size ? `${fu.auswahl.size} gewählt` : 'Mehreres möglich')),
        h('button.btn.btn--primary', {
          type: 'button',
          disabled: !fu.auswahl.size || !bedienbar,
          'data-key': `senden:${f.id}`,
          onClick: (e) => {
            e.stopPropagation();
            frageSenden(m, f, [...fu.auswahl]);
          },
        }, text('Senden'))));
    }
    if (bedienbar && !f.mehrfach && !fu.eigenOffen) {
      karte.appendChild(h('p.cv-frage__tipp', null, text('Antippen schickt die Antwort ab.')));
    }
    if (fu.fehler) karte.appendChild(h('p.cv-frage__fehler', { role: 'alert' }, text(fu.fehler)));
    if (eigeneAntwort) karte.appendChild(h('p.cv-frage__antwort', null, text(`Deine Antwort: ${f.antwort}`)));
    if (f.zustand === 'uebergangen') karte.appendChild(h('p.cv-frage__antwort', null, text('Übergangen – du hast weitergeschrieben.')));
    if (f.zustand === 'offen' && !offen && !(s && s.lauf) && !m.data.rueckfrageOffen) {
      karte.appendChild(h('p.cv-frage__antwort', null, text('Nicht mehr offen.')));
    }
    return karte;
  }

  function waehlen(m, f, label) {
    const fu = frageUi(m, f);
    if (fu.sendet) return;
    if (!f.mehrfach) {
      frageSenden(m, f, label);
      return;
    }
    if (fu.auswahl.has(label)) fu.auswahl.delete(label);
    else fu.auswahl.add(label);
    neuZeichnen(m.id);
  }

  async function frageSenden(m, f, antwort) {
    const fu = frageUi(m, f);
    if (fu.sendet || !s || s.lauf) return;
    fu.sendet = Array.isArray(antwort) ? antwort.slice() : [antwort];
    fu.fehler = null;
    folgen = true;
    neuZeichnen(m.id);
    try {
      await strom(s, api, `/chats/${encodeURIComponent(s.chatId)}/rueckfrage`, { id: f.id, antwort });
      fu.sendet = null;
      fu.eigenOffen = false;
      fu.auswahl.clear();
    } catch (err) {
      fu.sendet = null;
      fu.fehler = fehlerSatz(err);
      if (err && err.code === 'RUECKFRAGE_ERLEDIGT') nachladen(s, api).catch(() => {});
      if (err && err.code === 'CLAUDE_NICHT_VERBUNDEN') claudeAus(err);
    }
    neuZeichnen(m.id);
  }

  /** Die offene Rueckfrage der letzten Antwort, falls es eine gibt. */
  function offeneFrage() {
    const id = letzteAntwortId();
    const m = id ? nachricht(s, id) : null;
    if (!m || !m.data.rueckfrageOffen || (s && s.lauf)) return null;
    const f = (m.data.rueckfragen || []).find((x) => x.zustand === 'offen');
    return f ? { m, f } : null;
  }

  /* ------------------------------------------------ Quellen, Status */

  function quellenListe(u, quellen) {
    const zeige = u.quellenAlle ? quellen : quellen.slice(0, 6);
    const box = h('div.cv-quellen', null,
      h('p.cv-quellen__titel', null, text('Quellen')),
      h('ol.cv-quellen__liste', null, zeige.map((q, i) => h('li', null,
        h('a.cv-quelle', { href: q.url, target: '_blank', rel: 'noopener noreferrer', title: q.url, onClick: (e) => e.stopPropagation() },
          h('span.cv-quelle__nr', null, text(`${i + 1}`)),
          h('span.cv-quelle__titel', null, text(q.titel || q.url)),
          h('span.cv-quelle__host', null, text(hostVon(q.url))))))));
    if (quellen.length > 6) {
      box.appendChild(h('button.cv-mehr', {
        type: 'button',
        onClick: (e) => {
          e.stopPropagation();
          u.quellenAlle = !u.quellenAlle;
          u.v += 1;
          plane();
        },
      }, text(u.quellenAlle ? 'Weniger' : `+ ${quellen.length - 6} weitere`)));
    }
    return box;
  }

  function statusZeilen(m, letzte, laeuft) {
    const d = m.data;
    const out = [];
    if (laeuft) return out;
    const nochmal = letzte && !(s && s.lauf)
      ? h('button.btn.btn--small', { type: 'button', onClick: (e) => { e.stopPropagation(); neuAntworten(); } }, icon(I.refresh), h('span', null, text('Nochmal versuchen')))
      : null;
    if (d.status === 'failed' && d.error) {
      out.push(h('div.cv-status.cv-status--fehler', { role: 'alert' },
        icon(I.alert), h('span', null, text(d.error.message || 'Die Antwort ist gescheitert.')), nochmal));
    } else if (d.status === 'aborted') {
      out.push(h('p.cv-status', null, icon(I.info),
        h('span', null, text(String(d.content || '').trim() ? 'Abgebrochen – die Antwort ist unvollständig.' : 'Abgebrochen, bevor etwas kam.')),
        letzte && !(s && s.lauf) ? h('button.btn.btn--small', { type: 'button', onClick: (e) => { e.stopPropagation(); neuAntworten(); } }, text('Neu antworten')) : null));
    }
    const weiter = letzte && !(s && s.lauf)
      ? h('button.btn.btn--accent.btn--small', { type: 'button', onClick: (e) => { e.stopPropagation(); senden('Weiter'); } }, icon(I.arrow), h('span', null, text('Weiter')))
      : null;
    if (d.abgeschnitten) {
      out.push(h('p.cv-status.cv-status--warn', null, icon(I.info), h('span', null, text('Die Antwort war zu lang und ist hier abgeschnitten.')), weiter));
    }
    for (const satz of m._hinweise || []) {
      if (d.abgeschnitten && /abgeschnitten/.test(satz)) continue;
      const weiterHier = (m._stop === 'pause_turn' || m._stop === 'zu_viele_schritte') && /weiter/i.test(satz) ? weiter : null;
      out.push(h('p.cv-status', null, icon(I.info), h('span', null, text(satz)), weiterHier));
    }
    return out;
  }

  /* ---------------------------------------------- Leiste darunter */

  function aktion(markup, label, fn, extra = {}) {
    return h('button.cv-aktion', {
      type: 'button',
      title: label,
      'aria-label': label,
      class: extra.klasse || '',
      'aria-pressed': extra.gedrueckt === undefined ? null : String(extra.gedrueckt),
      onClick: (e) => {
        e.stopPropagation();
        fn(e.currentTarget);
      },
    }, icon(markup));
  }

  function kopierAktion(wert, label) {
    return aktion(SYMBOL_KOPIEREN, label, async (knopf) => {
      const ok = await kopieren(wert());
      knopf.classList.toggle('is-ok', ok);
      knopf.replaceChildren(icon(ok ? I.check : I.alert), h('span.cv-aktion__wort', null, text(ok ? 'Kopiert' : 'Nicht möglich')));
      setTimeout(() => {
        if (!knopf.isConnected) return;
        knopf.classList.remove('is-ok');
        knopf.replaceChildren(icon(SYMBOL_KOPIEREN));
      }, 2000);
    });
  }

  function antwortAktionen(m, letzte) {
    const inhalt = () => String(m.data.content || '');
    return h('div.cv-aktionen', { role: 'toolbar', 'aria-label': 'Antwort' },
      kopierAktion(inhalt, 'Antwort kopieren'),
      letzte && !(s && s.lauf) ? aktion(I.refresh, 'Neu antworten', () => neuAntworten()) : null,
      sprechenMoeglich()
        ? aktion(SYMBOL_LAUT, sprichtId === m.id ? 'Vorlesen beenden' : 'Vorlesen', () => vorlesen(m.id, inhalt()), {
          klasse: sprichtId === m.id ? 'is-an' : '',
          gedrueckt: sprichtId === m.id,
        })
        : null);
  }

  /**
   * Auf dem iPad gibt es kein Ueberfahren: Antippen zeigt die Leiste. Nur
   * die Klasse wechselt -- ein Neuaufbau wuerde eine Markierung im Text
   * zerstoeren, und mit der Maus ist ein Klick meist genau das: markieren.
   */
  function antippen(e, id) {
    if (e.target.closest('button, a, input, textarea, summary, details')) return;
    const markiert = typeof window.getSelection === 'function' ? String(window.getSelection() || '') : '';
    if (markiert) return;
    const u = uiVon(id);
    u.zeige = !u.zeige;
    for (const [andere, au] of ui) if (andere !== id) au.zeige = false;
    for (const node of verlauf.querySelectorAll('.cv-msg.is-zeige')) node.classList.remove('is-zeige');
    if (u.zeige) e.currentTarget.classList.add('is-zeige');
  }

  /* ------------------------------------------------------ Senden */

  function fehlerSatz(err) {
    if (!err) return 'Unbekannter Fehler.';
    if (err.code === 'VALIDATION_FAILED' || err.code === 'BUSY') return err.message;
    return err.message || 'Unbekannter Fehler.';
  }

  function claudeAus(err) {
    // PIN_NOETIG: der Tresor ist offen, aber dieser Browser hat keine
    // PIN-Sitzung (src/http/auth.js) -- fuer den Nutzer dasselbe wie gesperrt.
    const pin = err && err.code === 'PIN_NOETIG';
    const grund = pin ? 'gesperrt' : (err && err.details && err.details.grund);
    claude = { verbunden: false, grundCode: grund || 'kein-schluessel', grund: err.message, ziel: (err.details && err.details.ziel) || null };
    obenKey = null;
    plane();
  }

  function inhaltMitAnhaengen(textInhalt) {
    let out = textInhalt;
    for (const a of anhaenge) {
      const z = zaun(a.text);
      out += `${out ? '\n\n' : ''}**Anhang: ${a.name}**\n${z}\n${a.text}\n${z}`;
    }
    return out;
  }

  async function absenden() {
    if (s && s.lauf) {
      stoppen(s, api);
      return;
    }
    const roh = feld.value.trim();
    if (!roh && !anhaenge.length) return;
    const inhalt = inhaltMitAnhaengen(roh);
    if (inhalt.length > MAX_ZEICHEN) {
      ctx.toast(`Die Nachricht ist zu lang (${inhalt.length.toLocaleString('de-DE')} Zeichen, erlaubt sind ${MAX_ZEICHEN.toLocaleString('de-DE')}).`, 'error');
      return;
    }
    const gesendet = await senden(inhalt, { ausFeld: true });
    if (gesendet) {
      anhaenge = [];
      zeichneAnhaenge();
    }
  }

  /**
   * Eine Nachricht senden. Der neue Chat entsteht erst hier, mit der ersten
   * Nachricht -- nie auf Vorrat. Ist Claude nicht verbunden, bleibt der Text
   * im Feld, und die Verbinden-Karte uebernimmt.
   */
  async function senden(inhalt, { ausFeld = false } = {}) {
    const t = String(inhalt || '').trim();
    if (!t || (s && s.lauf)) return false;
    if (claude && claude.verbunden === false) {
      wartet = t;
      obenKey = null;
      plane();
      const f = container.querySelector('.cv-verbinden input');
      if (f) f.focus();
      return false;
    }
    const feldVorher = feld.value;
    if (ausFeld) {
      feld.value = '';
      groesseAnpassen();
      speicher('loeschen', ENTWURF + (chatId || 'neu'));
    }
    if (!chatId) {
      try {
        const res = await api.post('/chats', {});
        chatId = res && res.record ? res.record.id : null;
        if (!chatId) throw new Error('Der Server hat keinen Chat angelegt.');
        neuAngelegt = true;
        verbinden(sitzungFuer(chatId));
        s.geladen = true;
        ctx.replaceRoute(`#/chat?id=${encodeURIComponent(chatId)}`);
      } catch (err) {
        if (ausFeld) feld.value = feldVorher;
        groesseAnpassen();
        ctx.toast(`Der Chat ließ sich nicht anlegen: ${fehlerSatz(err)}`, 'error');
        return false;
      }
    }
    // Sofort zu sehen, bevor der Server antwortet; `nutzer` ersetzt sie.
    s.nachrichten.push({ id: `lokal_${Date.now()}`, _lokal: true, createdAt: new Date().toISOString(), data: { role: 'user', content: t } });
    folgen = true;
    plane();
    try {
      await strom(s, api, `/chats/${encodeURIComponent(s.chatId)}/messages`, { inhalt: t });
    } catch (err) {
      s.nachrichten = s.nachrichten.filter((m) => !m._lokal);
      if (ausFeld) {
        feld.value = feldVorher;
        groesseAnpassen();
      }
      if (err && (err.code === 'CLAUDE_NICHT_VERBUNDEN' || err.code === 'PIN_NOETIG')) {
        wartet = t;
        claudeAus(err);
        if (neuAngelegt && !s.nachrichten.length) {
          // Ein leerer Chat, den niemand wollte, soll nicht in "Zuletzt" stehen.
          api.del(`/records/${encodeURIComponent(s.chatId)}`).catch(() => {});
          const alt = s;
          trennen();
          sitzungen.delete(alt.chatId);
          chatId = null;
          s = null;
          neuAngelegt = false;
          ctx.replaceRoute('#/chat');
        }
      } else {
        ctx.toast(`Nicht gesendet: ${fehlerSatz(err)}`, 'error');
      }
      plane();
      return false;
    }
    if (neuAngelegt) {
      neuAngelegt = false;
      titelHolen();
    }
    fokusNachAntwort();
    return true;
  }

  async function neuAntworten() {
    if (!s || s.lauf) return;
    folgen = true;
    try {
      await strom(s, api, `/chats/${encodeURIComponent(s.chatId)}/neu-antworten`, {});
      fokusNachAntwort();
    } catch (err) {
      if (err && err.code === 'CLAUDE_NICHT_VERBUNDEN') claudeAus(err);
      else ctx.toast(`Nicht neu geantwortet: ${fehlerSatz(err)}`, 'error');
    }
  }

  /** Nach einer Rueckfrage liegt der Fokus auf der ersten Option -- so gehen 1–9 und Enter sofort. */
  function fokusNachAntwort() {
    if (!lebt) return;
    setTimeout(() => {
      const offen = s ? offeneFrage() : null;
      if (!offen || feld.value.trim()) return;
      const aktiv = document.activeElement;
      if (aktiv && aktiv !== document.body && aktiv !== feld && root.contains(aktiv) === false) return;
      const erste = verlauf.querySelector(`[data-frage="${CSS.escape(offen.f.id)}"] .cv-option`);
      if (erste) erste.focus({ preventScroll: true });
    }, 80);
  }

  async function titelHolen() {
    if (!chatId) return;
    try {
      const r = await api.get(`/chats/${encodeURIComponent(chatId)}`);
      const titel = r && r.record && r.record.data ? r.record.data.title : null;
      if (titel && lebt) {
        if (s) s.titel = titel;
        ctx.setTitle(titel);
      }
    } catch {
      /* der Kopf bleibt, wie er ist */
    }
  }

  /* ------------------------------------------------ Eingabefeld */

  function groesseAnpassen() {
    feld.style.height = 'auto';
    feld.style.height = `${Math.min(feld.scrollHeight, 220)}px`;
  }

  function aktualisiereEingabe() {
    const laeuft = !!(s && s.lauf);
    const bereit = !!(feld.value.trim() || anhaenge.length);
    sendKnopf.classList.toggle('is-stopp', laeuft);
    sendKnopf.classList.toggle('is-bereit', !laeuft && bereit);
    const neu = laeuft ? (s.lauf.stoppt ? 'stoppt' : 'stopp') : 'senden';
    if (sendKnopf.dataset.art !== neu) {
      sendKnopf.dataset.art = neu;
      clear(sendKnopf);
      sendKnopf.appendChild(icon(laeuft ? SYMBOL_STOPP : I.send));
      const label = laeuft ? (s.lauf.stoppt ? 'Wird angehalten …' : 'Stopp') : 'Senden';
      sendKnopf.setAttribute('aria-label', label);
      sendKnopf.title = laeuft ? 'Antwort anhalten' : 'Senden (Enter)';
    }
    sendKnopf.disabled = laeuft ? !!s.lauf.stoppt : !bereit;
  }

  offs.push(on(feld, 'input', () => {
    groesseAnpassen();
    aktualisiereEingabe();
    entwurfMerken();
  }));
  offs.push(on(feld, 'keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    // Enter sendet -- auch auf dem iPad mit Bildschirmtastatur. Waehrend
    // eine Antwort laeuft, macht Enter nichts (Stopp ist ein eigener Knopf).
    e.preventDefault();
    if (s && s.lauf) return;
    absenden();
  }));

  const entwurfMerken = debounce(() => {
    const key = ENTWURF + (chatId || 'neu');
    if (feld.value.trim()) speicher('schreiben', key, feld.value);
    else speicher('loeschen', key);
  }, 300);

  /* ------------------------------------------------- Anhaenge */

  function zeichneAnhaenge() {
    clear(anhangZeile);
    anhangZeile.hidden = !anhaenge.length;
    anhaenge.forEach((a, i) => {
      anhangZeile.appendChild(h('span.cv-anhang', null,
        icon(I.notes),
        h('span.cv-anhang__name', null, text(a.name)),
        h('span.cv-anhang__groesse', null, text(groesse(a.groesse))),
        h('button.cv-anhang__weg', {
          type: 'button',
          'aria-label': `${a.name} entfernen`,
          title: 'Entfernen',
          onClick: () => {
            anhaenge.splice(i, 1);
            zeichneAnhaenge();
            aktualisiereEingabe();
          },
        }, icon(SYMBOL_SCHLIESSEN))));
    });
    aktualisiereEingabe();
  }

  async function dateienAufnehmen(dateien) {
    const abgelehnt = [];
    for (const datei of dateien) {
      const textArtig = (datei.type && datei.type.startsWith('text/')) || /json|xml|javascript|csv/.test(datei.type || '') || TEXTDATEI.test(datei.name);
      if (!textArtig) {
        abgelehnt.push(datei.name);
        continue;
      }
      try {
        let inhalt = await datei.text();
        let gekuerzt = false;
        if (inhalt.length > MAX_ANHANG) {
          inhalt = inhalt.slice(0, MAX_ANHANG);
          gekuerzt = true;
        }
        anhaenge.push({ name: datei.name, text: inhalt, groesse: datei.size });
        if (gekuerzt) ctx.toast(`„${datei.name}“ ist sehr lang; mitgeschickt werden die ersten ${MAX_ANHANG.toLocaleString('de-DE')} Zeichen.`, 'info');
      } catch (err) {
        ctx.toast(`„${datei.name}“ ließ sich nicht lesen: ${err && err.message}`, 'error');
      }
    }
    if (abgelehnt.length) {
      ctx.toast(`Nur Textdateien lassen sich anhängen. Bilder und PDFs schickt Neural OS noch nicht an Claude (${abgelehnt.join(', ')}).`, 'info', { timeout: 8000 });
    }
    zeichneAnhaenge();
    feld.focus();
  }

  offs.push(on(dateiWahl, 'change', () => {
    const dateien = [...(dateiWahl.files || [])];
    dateiWahl.value = '';
    if (dateien.length) dateienAufnehmen(dateien);
  }));
  offs.push(on(formular, 'dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      formular.classList.add('is-ziel');
    }
  }));
  offs.push(on(formular, 'dragleave', () => formular.classList.remove('is-ziel')));
  offs.push(on(formular, 'drop', (e) => {
    formular.classList.remove('is-ziel');
    const dateien = e.dataTransfer ? [...e.dataTransfer.files] : [];
    if (!dateien.length) return;
    e.preventDefault();
    dateienAufnehmen(dateien);
  }));

  /* -------------------------------------------------- Tastatur */

  offs.push(on(document, 'keydown', (e) => {
    if (!lebt || !s || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!/^[1-9]$/.test(e.key) && e.key !== 'Enter') return;
    if (istEingabe(e.target)) return;
    if (document.querySelector('.overlay')) return;
    const offen = offeneFrage();
    if (!offen) return;
    const { m, f } = offen;
    if (e.key === 'Enter') {
      const fu = frageUi(m, f);
      if (f.mehrfach && fu.auswahl.size && !e.target.closest('button')) {
        e.preventDefault();
        frageSenden(m, f, [...fu.auswahl]);
      }
      return;
    }
    const label = (f.optionen || [])[Number(e.key) - 1];
    if (!label) return;
    e.preventDefault();
    waehlen(m, f, label);
  }));

  /* ---------------------------------------------- Server, Bus */

  function abo(art) {
    if (!lebt) return;
    if (art === 'lauf') aktualisiereEingabe();
    plane();
  }

  function verbinden(neu) {
    trennen();
    s = neu;
    s.abos.add(abo);
  }

  function trennen() {
    if (s) s.abos.delete(abo);
  }

  async function claudeLaden() {
    try {
      const z = await api.get('/claude', { timeoutMs: 8000 });
      claude = z && typeof z === 'object' ? { ...z } : null;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_NOETIG') {
        claude = { verbunden: false, grundCode: 'gesperrt', grund: err.message, ziel: (err.details && err.details.ziel) || null };
      } else {
        claude = err instanceof ApiError && err.status === 503
          ? { verbunden: false, grundCode: null, grund: err.message }
          : null;
      }
    }
    claudeGeprueft = true;
    // Kein obenKey = null: neu gebaut wird die Karte nur, wenn sich ihr
    // Zustand aendert (zeichneOben vergleicht). Sonst verloere ein
    // Schluesselfeld bei jedem Ereignis seinen Inhalt.
    if (lebt) plane();
  }
  const claudeBald = debounce(claudeLaden, 400);

  offs.push(ctx.bus.on('*', (payload, event) => {
    const typ = (event && event.type) || '';
    if (typ.startsWith('claude') || typ === 'network.mode' || typ.startsWith('vault.')) claudeBald();
    if (!s || s.lauf || !payload || payload.chatId !== s.chatId) return;
    // Ein anderes Geraet (oder ein anderer Tab) schreibt in diesen Chat.
    if (typ === 'chat.message' && payload.record) {
      const alt = nachricht(s, payload.record.id);
      if (!alt || alt.updatedAt !== payload.record.updatedAt) {
        einsetzen(s, payload.record);
        plane();
        beobachten();
      }
    } else if (typ === 'chat.verworfen' && Array.isArray(payload.ids)) {
      ereignis(s, 'verworfen', payload);
      plane();
    }
  }));
  offs.push(ctx.bus.on('hello', () => {
    // Nach einer abgerissenen Live-Verbindung kann etwas fehlen.
    if (s && !s.lauf && s.geladen) nachladen(s, api).catch(() => {});
    claudeBald();
  }));

  sprechAbos.add(sprechAbo);
  function sprechAbo() {
    if (!lebt) return;
    for (const m of (s ? s.nachrichten : [])) if (m.data.role === 'assistant') uiVon(m.id).v += 1;
    plane();
  }

  /** Laeuft auf einem anderen Geraet eine Antwort, wird nachgesehen, bis sie fertig ist. */
  let beobachter = null;
  function beobachten() {
    clearTimeout(beobachter);
    if (!lebt || !s || s.lauf) return;
    const letzte = s.nachrichten[s.nachrichten.length - 1];
    if (!letzte || letzte.data.status !== 'streaming') return;
    beobachter = setTimeout(async () => {
      try { await nachladen(s, api); } catch { /* naechster Versuch */ }
      beobachten();
    }, 1500);
  }

  /* --------------------------------------------------- Start */

  async function start() {
    aktualisiereEingabe();
    const entwurf = speicher('lesen', ENTWURF + (chatId || 'neu'));
    if (entwurf) {
      feld.value = entwurf;
      groesseAnpassen();
      aktualisiereEingabe();
    }
    claudeLaden();
    if (!chatId) {
      plane();
      setTimeout(() => { if (lebt && !istEingabe(document.activeElement)) feld.focus({ preventScroll: true }); }, 60);
      return;
    }
    verbinden(s);
    if (s.titel) ctx.setTitle(s.titel);
    if (s.lauf || s.geladen) plane();
    try {
      const [info] = await Promise.all([
        api.get(`/chats/${encodeURIComponent(chatId)}`),
        s.lauf ? Promise.resolve() : nachladen(s, api),
      ]);
      if (!lebt) return;
      const titel = info && info.record && info.record.data ? info.record.data.title : null;
      if (titel) {
        s.titel = titel;
        ctx.setTitle(titel);
      }
      beobachten();
      fokusNachAntwort();
    } catch (err) {
      if (!lebt) return;
      clear(oben);
      verlauf.replaceChildren();
      oben.appendChild(h('div.view-state', { role: 'alert' },
        h('div.view-state__icon', { 'aria-hidden': 'true' }, icon(I.alert)),
        h('h2.view-state__title', null, text(err && err.status === 404 ? 'Diesen Chat gibt es nicht (mehr)' : 'Der Chat ließ sich nicht laden')),
        h('p.view-state__text', null, text(err && err.status === 404 ? 'Vielleicht wurde er gelöscht.' : fehlerSatz(err))),
        h('div.view-state__actions', null,
          h('button.btn.btn--primary', { type: 'button', onClick: () => ctx.shell.newChat() }, text('Neuer Chat')))));
      ladeFehler = true;
    }
  }

  function weg() {
    lebt = false;
    clearTimeout(beobachter);
    trennen();
    sprechAbos.delete(sprechAbo);
    entwurfMerken.cancel();
    claudeBald.cancel();
    for (const off of offs) {
      try { off(); } catch { /* weiter */ }
    }
    // Was im Feld stand, bleibt fuer das naechste Mal.
    const key = ENTWURF + (chatId || 'neu');
    if (feld.value.trim()) speicher('schreiben', key, feld.value);
  }

  return { start, weg };
}

/* ------------------------------------------------------------------ */
/* Gestaltung                                                          */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = STIL;
  document.head.appendChild(node);
}

const STIL = `
.cv { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.cv__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scroll-behavior: auto; }
.cv__spalte { max-width: calc(var(--content-max) + 2 * var(--sp-4)); margin: 0 auto; padding: var(--sp-4) var(--sp-4) var(--sp-3); }
.cv__verlauf { display: flex; flex-direction: column; gap: 22px; }
.cv__oben:empty { display: none; }

/* -- leer: die grosse, ruhige Frage -- */
.cv-leer { display: flex; flex-direction: column; align-items: center; text-align: center; padding: clamp(40px, 13vh, 150px) 0 var(--sp-4); }
.cv-leer__titel { margin: 0; font-size: var(--fs-display); font-weight: 500; letter-spacing: -0.02em; line-height: var(--lh-tight); color: var(--fg); }
.cv-leer__unter { margin: 14px 0 0; font-size: var(--fs-md); color: var(--fg-muted); }
.cv-leer__start { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: var(--sp-4); }
.cv-leer__start .cv-knopf { padding: 0 14px; }
.cv-knopf { min-height: 40px; padding: 0 16px; font-size: var(--fs-base); }

/* -- Verbinden -- */
.cv-verbinden { max-width: 520px; margin: clamp(28px, 11vh, 120px) auto 0; padding: 26px 28px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-4); box-shadow: var(--shadow-card); }
.cv-verbinden--kompakt { max-width: none; margin: 0 0 12px; padding: 16px 18px; }
.cv-verbinden__kopf { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.cv-verbinden__titel { margin: 0; font-size: var(--fs-xl); font-weight: 500; letter-spacing: -0.01em; }
.cv-verbinden--kompakt .cv-verbinden__titel { font-size: var(--fs-lg); }
.cv-verbinden__text { margin: 0 0 16px; font-size: var(--fs-base); line-height: var(--lh); color: var(--fg-muted); }
.cv-verbinden__form { display: flex; flex-wrap: wrap; gap: 8px; }
.cv-verbinden__form .input { flex: 1 1 220px; min-width: 0; }
.cv-verbinden__hinweis { margin: 14px 0 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--fg-subtle); }
.cv-verbinden__hinweis a { color: var(--accent-text); }
.cv-verbinden__fehler { margin: 10px 0 0; font-size: var(--fs-sm); color: var(--danger); }
.cv-spinner { width: 14px; height: 14px; border-width: 2px; }

/* -- Nachrichten -- */
.cv-msg { display: flex; gap: 14px; min-width: 0; }
.cv-msg--user { justify-content: flex-end; }
.cv-msg__spalte { display: flex; flex-direction: column; min-width: 0; }
.cv-msg--user .cv-msg__spalte { align-items: flex-end; max-width: min(80%, 580px); }
.cv-msg--bot .cv-msg__spalte { flex: 1 1 auto; align-items: flex-start; }
.cv-avatar { margin-top: 4px; }
.cv-bubble { position: relative; min-width: 0; max-width: 100%; padding: 16px 20px 12px; font-size: var(--fs-md); line-height: var(--lh); color: var(--fg); border-radius: var(--r-3); overflow-wrap: anywhere; }
.cv-bubble--user { background: var(--surface-3); border: 1px solid var(--border); }
.cv-bubble__text { white-space: pre-wrap; }
.cv-bubble--user.is-lang .cv-bubble__text { max-height: 16em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.cv-bubble--bot { width: fit-content; background: var(--surface-2); border: 1px solid var(--border); }
.cv-zeit { display: block; margin-top: 6px; text-align: right; font-size: var(--fs-xs); color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.cv-zeit__zusatz { font-style: italic; }
.cv-mehr { display: inline-flex; align-items: center; margin-top: 6px; padding: 0; font: inherit; font-size: var(--fs-sm); color: var(--accent-text); background: none; border: 0; cursor: pointer; }

/* -- Markdown in der Antwort: Luft zwischen Abschnitten -- */
.cv-md { min-width: 0; }
.cv-wirkung + .cv-md, .cv-frage + .cv-md, .cv-md + .cv-md { margin-top: 14px; }
.cv-wirkung + .cv-wirkung { margin-top: 8px; }
.cv-md .md-p { margin: 0 0 12px; }
.cv-md > :last-child, .cv-md .md-p:last-child { margin-bottom: 0; }
.cv-md .md-heading { margin: 22px 0 8px; font-weight: 600; letter-spacing: -0.005em; }
.cv-md .md-heading:first-child { margin-top: 0; }
.cv-md .md-heading--1 { font-size: var(--fs-lg); }
.cv-md .md-heading--2 { font-size: var(--fs-md); }
.cv-md .md-list { margin: 0 0 12px; }
.cv-md .md-item { margin: 4px 0; }
.cv-md .md-p + .md-list--haken, .cv-md .md-heading + .md-list--haken { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.cv-md .md-list--haken { font-size: var(--fs-base); color: var(--fg-muted); }
.cv-md .md-quote { margin: 0 0 12px; }
.cv-md .md-code, .cv-md .md-copycard, .cv-md .md-table-wrap { margin: 4px 0 14px; }
.cv-md .md-table th, .cv-md .md-table td { padding: 7px 10px; }
.cv-bubble.is-streaming .md-code__warn { display: none; }
.cv-bubble:not(.is-streaming) .md-copycard__warn { display: none; }

/* -- Gedankengang und Arbeitsschritte -- */
.cv-denken, .cv-schritte { margin: 0 0 12px; font-size: var(--fs-sm); color: var(--fg-muted); }
.cv-denken > summary, .cv-schritte > summary { display: inline-flex; align-items: center; gap: 6px; list-style: none; cursor: pointer; color: var(--fg-muted); border-radius: var(--r-1); }
.cv-denken > summary::-webkit-details-marker, .cv-schritte > summary::-webkit-details-marker { display: none; }
.cv-denken > summary:hover, .cv-schritte > summary:hover { color: var(--fg); }
.cv-pfeil { display: inline-grid; place-items: center; transition: transform var(--dur-2) var(--ease); }
.cv-pfeil svg { width: 14px; height: 14px; }
details[open] > summary > .cv-pfeil { transform: rotate(90deg); }
.cv-denken__live { display: inline-flex; align-items: center; gap: 8px; }
.cv-denken__text { margin: 8px 0 4px; padding-left: 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; line-height: 1.55; color: var(--fg-muted); border-left: 2px solid var(--border-strong); }
.cv-schritte__fehler { color: var(--danger); }
.cv-schritte__liste { display: flex; flex-direction: column; gap: 8px; margin: 10px 0 2px; padding: 0; list-style: none; }
.cv-schritt { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 10px; align-items: start; }
.cv-schritt svg { width: 16px; height: 16px; }
.cv-schritt__symbol { display: grid; place-items: center; margin-top: 1px; color: var(--fg-subtle); }
.cv-schritt__main { display: flex; flex-direction: column; min-width: 0; }
.cv-schritt__titel { color: var(--fg); overflow-wrap: anywhere; }
.cv-schritt__erg { color: var(--fg-subtle); overflow-wrap: anywhere; }
.cv-schritt__zustand { display: inline-flex; align-items: center; gap: 5px; color: var(--fg-subtle); font-size: var(--fs-xs); white-space: nowrap; }
.cv-schritt.is-fehler .cv-schritt__zustand, .cv-schritt.is-fehler .cv-schritt__erg { color: var(--danger); }
.cv-live { display: flex; align-items: center; gap: 9px; margin: 0 0 10px; font-size: var(--fs-sm); color: var(--fg-muted); }
.cv-live__symbol { display: grid; place-items: center; color: var(--accent-text); }
.cv-live__symbol svg { width: 16px; height: 16px; }
.cv-live__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* -- Karten: was die KI angelegt hat -- */
.cv-wirkung { display: flex; flex-direction: column; gap: 8px; margin: 14px 0 2px; }
.cv-karte { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 9px 10px 9px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); }
.cv-karte__symbol { display: grid; place-items: center; flex: none; width: 32px; height: 32px; color: var(--accent-text); background: var(--accent-soft); border-radius: 50%; }
.cv-karte__symbol svg { width: 17px; height: 17px; }
.cv-karte__text { flex: 1 1 200px; min-width: 0; font-size: var(--fs-sm); line-height: 1.45; color: var(--fg-muted); }
.cv-karte__label { font-weight: 500; color: var(--fg); }
.cv-karte__aktionen { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
.cv-karte.is-zurueck { opacity: 0.72; }
.cv-karte.is-zurueck .cv-karte__detail, .cv-karte.is-zurueck .cv-karte__label { text-decoration: line-through; text-decoration-color: var(--fg-subtle); }
.cv-karte.is-zurueck .cv-karte__symbol { color: var(--fg-subtle); background: var(--surface-3); }
.cv-karte__zurueck { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--fg-muted); }
.cv-karte__zurueck svg { width: 15px; height: 15px; }
.cv-karte__hinweis { margin: 0; font-size: var(--fs-sm); color: var(--warn); }

/* -- Rueckfrage: grosse, antippbare Chips -- */
.cv-frage { margin: 14px 0 2px; padding: 16px 16px 14px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-3); }
.cv-frage[data-zustand="offen"] { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-strong)); }
.cv-frage__text { margin: 0 0 12px; font-size: var(--fs-md); font-weight: 500; line-height: 1.45; color: var(--fg); }
.cv-frage__optionen { display: flex; flex-wrap: wrap; gap: 10px; }
.cv-option { display: inline-flex; align-items: center; gap: 10px; min-height: var(--tap-min); max-width: 100%; padding: 0 18px 0 11px; font: inherit; font-size: var(--fs-md); line-height: 1.3; text-align: left; color: var(--accent-text); background: color-mix(in srgb, var(--accent) 7%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 62%, transparent); border-radius: var(--r-full); cursor: pointer; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), opacity var(--dur-2) var(--ease); }
.cv-option:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); }
.cv-option:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.cv-option:disabled { cursor: default; }
.cv-option__nr { display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; font-size: var(--fs-xs); font-weight: 600; color: var(--accent-text); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 6px; }
.cv-option__label { min-width: 0; overflow-wrap: anywhere; padding: 6px 0; }
.cv-option__haken, .cv-option__symbol { display: inline-grid; place-items: center; flex: none; }
.cv-option__haken svg, .cv-option__symbol svg { width: 16px; height: 16px; }
.cv-option.is-gewaehlt { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
.cv-option.is-gewaehlt .cv-option__nr { color: var(--accent-fg); border-color: color-mix(in srgb, var(--accent-fg) 45%, transparent); }
.cv-option.is-aus { opacity: 0.42; }
.cv-option--eigen { padding-left: 14px; color: var(--fg-muted); background: none; border-style: dashed; border-color: var(--border-strong); }
.cv-option--eigen:hover:not(:disabled), .cv-option--eigen.is-offen { color: var(--fg); background: var(--surface-3); border-color: var(--fg-subtle); }
.cv-frage__eigen { display: flex; gap: 8px; margin-top: 12px; }
.cv-frage__eigen .input { flex: 1 1 auto; min-width: 0; }
.cv-frage__fuss { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; font-size: var(--fs-sm); color: var(--fg-subtle); }
.cv-frage__tipp { margin: 10px 0 0; font-size: var(--fs-xs); color: var(--fg-subtle); }
.cv-frage__antwort { margin: 12px 0 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.cv-frage__fehler { margin: 10px 0 0; font-size: var(--fs-sm); color: var(--danger); }
@media (pointer: coarse) {
  .cv-option__nr { display: none; }
  .cv-option { padding: 0 20px; }
}

/* -- Quellen -- */
.cv-quellen { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.cv-quellen__titel { margin: 0 0 8px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-subtle); }
.cv-quellen__liste { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.cv-quelle { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 2px 0; font-size: var(--fs-sm); color: var(--fg-muted); text-decoration: none; border-radius: var(--r-1); }
.cv-quelle:hover .cv-quelle__titel { color: var(--fg); text-decoration: underline; text-underline-offset: 2px; }
.cv-quelle__nr { flex: none; min-width: 16px; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.cv-quelle__titel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-quelle__host { flex: none; font-size: var(--fs-xs); color: var(--fg-subtle); }

/* -- Wie es endete -- */
.cv-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0 0; font-size: var(--fs-sm); color: var(--fg-subtle); }
.cv-status > svg { width: 16px; height: 16px; flex: none; }
.cv-status--fehler { padding: 10px 12px; color: var(--fg); background: var(--danger-soft); border-radius: var(--r-2); }
.cv-status--fehler > svg { color: var(--danger); }
.cv-status--warn { color: var(--warn); }

/* -- Leiste unter einer Nachricht -- */
.cv-aktionen { display: flex; align-items: center; gap: 2px; margin-top: 4px; min-height: 32px; opacity: 0; transition: opacity var(--dur-2) var(--ease); }
.cv-msg:hover .cv-aktionen, .cv-msg:focus-within .cv-aktionen, .cv-msg.is-zeige .cv-aktionen, .cv-msg--bot.is-letzte .cv-aktionen { opacity: 1; }
.cv-aktion { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 32px; height: 32px; padding: 0 7px; font: inherit; font-size: var(--fs-xs); color: var(--fg-subtle); background: none; border: 0; border-radius: var(--r-2); cursor: pointer; }
.cv-aktion svg { width: 16px; height: 16px; }
.cv-aktion:hover { color: var(--fg); background: var(--surface-3); }
.cv-aktion:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.cv-aktion.is-an { color: var(--accent-text); }
.cv-aktion.is-ok { color: var(--ok); }
@media (hover: none) {
  .cv-aktionen { display: none; opacity: 1; }
  .cv-msg.is-zeige .cv-aktionen, .cv-msg--bot.is-letzte .cv-aktionen { display: flex; }
}
.cv-vorschlaege { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }

/* -- Bearbeiten -- */
.cv-bearbeiten { display: flex; flex-direction: column; gap: 8px; width: min(580px, 100%); }
.cv-bearbeiten__feld { min-height: 84px; font-size: var(--fs-md); }
.cv-bearbeiten__fuss { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.cv-bearbeiten__hinweis { margin-right: auto; font-size: var(--fs-xs); color: var(--fg-subtle); }

/* -- Eingabe: die grosse Karte unten -- */
.cv-eingabe { flex: none; padding: 0 var(--sp-4) var(--sp-3); }
.cv-eingabe__innen { position: relative; max-width: var(--content-max); margin: 0 auto; }
.cv-composer { display: flex; align-items: flex-end; gap: 10px; min-height: 68px; padding: 13px 13px 13px 14px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-4); transition: border-color var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease); }
.cv-composer:focus-within { border-color: color-mix(in srgb, var(--accent) 50%, var(--border-strong)); box-shadow: 0 0 0 3px var(--accent-soft); }
.cv-composer.is-ziel { border-color: var(--accent); border-style: dashed; }
.cv-composer__clip { display: grid; place-items: center; flex: none; width: 40px; height: 40px; padding: 0; color: var(--fg-muted); background: none; border: 0; border-radius: 50%; cursor: pointer; }
.cv-composer__clip:hover { color: var(--fg); background: var(--surface-3); }
.cv-composer__clip svg { width: 22px; height: 22px; }
.cv-composer__feld { flex: 1 1 auto; align-self: center; min-width: 0; max-height: 220px; margin: 0; padding: 8px 0; font: inherit; font-size: var(--fs-md); line-height: 1.5; color: var(--fg); background: transparent; border: 0; outline: 0; resize: none; overflow-y: auto; }
.cv-composer__feld::placeholder { color: var(--fg-subtle); }
.cv-composer__senden { display: grid; place-items: center; flex: none; width: 40px; height: 40px; padding: 0; color: var(--fg-muted); background: var(--surface-4); border: 0; border-radius: 50%; cursor: pointer; transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease); }
.cv-composer__senden svg { width: 20px; height: 20px; }
.cv-composer__senden.is-bereit { color: var(--accent-fg); background: var(--accent); }
.cv-composer__senden.is-bereit:hover { background: var(--accent-hover); }
.cv-composer__senden.is-stopp { color: var(--bg); background: var(--fg); }
.cv-composer__senden:disabled { cursor: default; }
.cv-composer__senden:focus-visible, .cv-composer__clip:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.cv-anhaenge { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.cv-anhang { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 4px 4px 4px 10px; font-size: var(--fs-sm); color: var(--fg-muted); background: var(--surface-3); border: 1px solid var(--border); border-radius: var(--r-full); }
.cv-anhang svg { width: 15px; height: 15px; flex: none; }
.cv-anhang__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
.cv-anhang__groesse { flex: none; font-size: var(--fs-xs); color: var(--fg-subtle); }
.cv-anhang__weg { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; color: var(--fg-subtle); background: none; border: 0; border-radius: 50%; cursor: pointer; }
.cv-anhang__weg:hover { color: var(--fg); background: var(--surface-4); }
.cv-nachunten { position: absolute; left: 50%; bottom: calc(100% + 12px); z-index: 2; display: grid; place-items: center; width: 36px; height: 36px; padding: 0; color: var(--fg); background: var(--surface-3); border: 1px solid var(--border-strong); border-radius: 50%; box-shadow: var(--shadow-2); transform: translateX(-50%); cursor: pointer; }
.cv-nachunten svg { width: 18px; height: 18px; }
.cv-nachunten:hover { background: var(--surface-4); }

@media (max-width: 760px) {
  .cv__spalte { padding: var(--sp-3) var(--sp-2) var(--sp-2); }
  .cv-eingabe { padding: 0 var(--sp-2) var(--sp-2); }
  .cv-msg { gap: 10px; }
  .cv-msg--user .cv-msg__spalte { max-width: 88%; }
  .cv-avatar { display: none; }
  .cv-leer__titel { font-size: var(--fs-2xl); }
}
@media (pointer: coarse) {
  .cv-composer__clip, .cv-composer__senden, .cv-nachunten, .cv-anhang__weg { width: var(--tap-min); height: var(--tap-min); }
  .cv-aktion { min-width: var(--tap-min); height: var(--tap-min); }
  .cv-mehr, .cv-quelle { min-height: var(--tap-min); }
  .cv-quelle { align-items: center; }
  .cv-knopf { min-height: var(--tap-min); }
}
`;

export default { mount, unmount };
