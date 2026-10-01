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
 * - **Die Antwort baut ihre eigene Oberflaeche** (docs/ANTWORT-BAUSTEINE.md):
 *   ```ui-Bloecke werden Bausteine (web/lib/bausteine), Tabellen sortier-
 *   und filterbar (web/lib/tabelle.js), Codebloecke bekommen Bearbeiten,
 *   Ausfuehren (Sandkasten), Erklaeren und Fehler suchen. Eine Antwort hat
 *   Fassungen (‹ 2/3 ›, Vergleichen, Wiederherstellen); Neu erstellen und
 *   Umwandeln legen neue an, statt etwas zu verwerfen. Markierter Text
 *   bekommt ein kleines Menue (web/lib/auswahl-menue.js).
 * - **Bausteine sind Inseln.** Eine Nachricht wird bei jeder Aenderung ihrer
 *   Signatur neu gebaut, beim Streaming in jedem Bild. Ein Baustein darf
 *   dabei nicht neu entstehen (er flackerte, verloere Fokus und Ziehen, und
 *   eine Vorschau im Sandkasten luede jedes Mal neu). Er wird einmal gebaut
 *   und in jeden Neubau hinuebergetragen (`moveBefore`, wo der Browser es
 *   kann: dann bleibt sogar ein Rahmen samt Inhalt stehen).
 */

import { h, text, clear, on, icon, cx, debounce } from '../lib/dom.js';
import { api as defaultApi, ApiError } from '../lib/api.js';
import * as lokal from '../lib/lokal.js';
import { renderMarkdown, extractPlain, kopieren } from '../lib/markdown.js';
import { rolle, wirkungZeilen, uhrzeit, dauerText } from '../lib/agenten.js';
import {
  renderCodeBlock, auswahlKarte, nachrichtenZustand, markdownOhneUi, tasteBehandeln, letzteNachricht, istUi,
} from '../lib/bausteine/index.js';
import { ensureStyle as bausteinStil, CSS as BAUSTEIN_CSS } from '../lib/bausteine/gemeinsam.js';
import { bearbeitenFeld, BEARBEITEN_CSS } from '../lib/bausteine/bearbeiten.js';
import { tabellenVerbessern } from '../lib/tabelle.js';
import { laufAnzeige } from '../lib/sandkasten.js';
import { menue, menueSchliessen, auswahlMenue } from '../lib/auswahl-menue.js';
import {
  schnittSicher, codebloecke, spracheErkennen, ausfuehrbar, wortUnterschied, geaenderteStelle, lesbar, zitat,
  codeFrage, stellenFrage, stellenAuftrag, abschnittFrage, NEU_VARIANTEN, UMWANDELN, STELLEN_AKTIONEN, SPRACHEN, fassungsName,
} from '../lib/antwort-hilfen.js';
import {
  dateiArt, schnellAktionen, anhangUrl, alsBase64, bildVorbereiten, leuchtkasten, leuchtkastenZu, mb,
  MAX_PDF_BYTES, MAX_JE_NACHRICHT, MOEGLICH,
} from '../lib/anhaenge.js';
import {
  seitenVorleser, vorlesenMoeglich, sprechText, stelleImText, hervorheben, hervorhebenMoeglich, MARKE as VORLESE_MARKE,
} from '../lib/vorlesen.js';
import {
  sprechWeg, erkennungStarten, aufnahmeStarten, erkennungFehlerSatz, erkennungUntauglich, bytesAlsBase64, MAX_SEKUNDEN,
} from '../lib/sprechen.js';

/* ------------------------------------------------------------------ */
/* Konstanten                                                          */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-chat-view';
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

/** Was die Dateiauswahl anbietet: Text, Bilder und PDF (lib/anhaenge.js prueft genauer). */
const DATEI_ARTEN = 'text/*,.md,.markdown,.csv,.tsv,.json,.log,.js,.mjs,.ts,.py,.html,.css,.xml,.yml,.yaml,.ini,.toml,.sh,.bat,.ics,.sql,image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif,application/pdf,.pdf';

const SYMBOL_STOPP = '<rect x="5.6" y="5.6" width="8.8" height="8.8" rx="1.8" fill="currentColor" stroke="none"/>';
const SYMBOL_UNTEN = '<path d="M10 4.4v11M5.4 10.8 10 15.4l4.6-4.6"/>';
const SYMBOL_KOPIEREN = '<rect x="7" y="7" width="9.6" height="9.6" rx="2.2"/><path d="M13 7V5.2A1.8 1.8 0 0 0 11.2 3.4H5.2a1.8 1.8 0 0 0-1.8 1.8v6a1.8 1.8 0 0 0 1.8 1.8H7"/>';
const SYMBOL_LAUT = '<path d="M3.6 7.8h2.8L10 4.6v10.8l-3.6-3.2H3.6z"/><path d="M13 7.4a3.6 3.6 0 0 1 0 5.2M15.2 5.2a6.8 6.8 0 0 1 0 9.6"/>';
const SYMBOL_PFEIL = '<path d="m7.6 5.4 4.6 4.6-4.6 4.6"/>';
const SYMBOL_SCHLIESSEN = '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>';
const SYMBOL_ZURUECK = '<path d="m12.2 5.4-4.6 4.6 4.6 4.6"/>';
const SYMBOL_RUNTER = '<path d="m6.2 8.4 3.8 3.8 3.8-3.8"/>';
const SYMBOL_NEU = '<path d="M15.6 9.2A5.8 5.8 0 0 0 5 6.4M4.4 10.8A5.8 5.8 0 0 0 15 13.6"/><path d="M4.8 3.6v3.2H8M15.2 16.4v-3.2H12"/>';
const SYMBOL_ZAUBER = '<path d="M9 3.6 10.3 7l3.4 1.3-3.4 1.3L9 13l-1.3-3.4-3.4-1.3L7.7 7z"/><path d="M14.6 11.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"/>';
const SYMBOL_VERGLEICH = '<path d="M7 3.6v12.8M13 3.6v12.8"/><path d="M3.6 7h3.4M3.6 10h3.4M13 7h3.4M13 13h3.4"/>';
const SYMBOL_START = '<path d="M6.8 4.6v10.8l8.4-5.4z"/>';
const SYMBOL_STIFT = '<path d="M12.8 4.2 15.8 7.2 7.4 15.6H4.4v-3z"/><path d="m11.2 5.8 3 3"/>';
const SYMBOL_ERKLAEREN = '<circle cx="10" cy="10" r="7.2"/><path d="M8 8a2.1 2.1 0 1 1 3 1.9c-.6.3-1 .8-1 1.5v.4M10 14.1h.01"/>';
const SYMBOL_FEHLER = '<path d="M7.4 6.6a2.6 2.6 0 0 1 5.2 0M6.6 8.4h6.8v3.4a3.4 3.4 0 0 1-6.8 0z"/><path d="M10 8.4v6.6M6.6 10.6H4M16 10.6h-2.6M6.8 13.8l-2.2 1.6M13.2 13.8l2.2 1.6M6.8 7.4 5 5.8M13.2 7.4 15 5.8"/>';
const SYMBOL_FRAGE_DAZU = '<path d="M4 5.6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.4 2.8v-2.8H6a2 2 0 0 1-2-2z"/>';
const SYMBOL_MIKRO = '<rect x="7.4" y="2.8" width="5.2" height="9.2" rx="2.6"/><path d="M4.8 9.6a5.2 5.2 0 0 0 10.4 0M10 14.8v2.6"/>';
const SYMBOL_PAUSE = '<rect x="5.6" y="4.6" width="2.9" height="10.8" rx="1" fill="currentColor" stroke="none"/><rect x="11.5" y="4.6" width="2.9" height="10.8" rx="1" fill="currentColor" stroke="none"/>';
const SYMBOL_ABSPIELEN = '<path d="M6.6 4.4v11.2l8.8-5.6z" fill="currentColor" stroke="none"/>';
const SYMBOL_PDF = '<path d="M5.4 2.7h5.9l3.9 3.9v9.1a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6V4.3a1.6 1.6 0 0 1 1.6-1.6z"/><path d="M11.1 2.9v3.9h3.9"/><path d="M6.6 13.6h1.1a1 1 0 0 0 0-2H6.6v3.2M10.2 11.6v3.2h.7a1.6 1.6 0 0 0 0-3.2zM13.6 14.8v-3.2h1.4M13.6 13.2h1.1" stroke-width="1.1"/>';
const SYMBOL_ERLEDIGT = '<path d="m5 10.4 3.2 3.2 6.8-7.4"/>';

/** Schnelle, kurze Pruefsumme eines Texts (Schluessel fuer Inseln und Tabellen). */
function pruefsumme(wert) {
  const s = String(wert || '');
  let x = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return `${(x >>> 0).toString(36)}${s.length.toString(36)}`;
}

/**
 * Was von einer Antwort zu sehen ist: die aktive Fassung (`content`) oder,
 * wenn der Nutzer mit ‹ › blaettert, eine andere aus `versionen` (dort
 * traegt jede ihren Text als `inhalt`). Blaettern ist nur Ansehen; erst
 * [Wiederherstellen] macht die Fassung auf dem Server wieder aktiv.
 * @returns {{inhalt:string, version:number, aktiv:boolean, anzahl:number}}
 */
export function fassungInhalt(m, ansicht = null) {
  const d = (m && m.data) || {};
  const liste = Array.isArray(d.versionen) ? d.versionen : [];
  const aktiv = Number.isInteger(d.version) && d.version >= 0 && d.version < liste.length ? d.version : Math.max(0, liste.length - 1);
  if (Number.isInteger(ansicht) && ansicht !== aktiv && liste[ansicht] && typeof liste[ansicht] === 'object') {
    return { inhalt: String(liste[ansicht].inhalt || ''), version: ansicht, aktiv: false, anzahl: liste.length };
  }
  return { inhalt: String(d.content || ''), version: aktiv, aktiv: true, anzahl: Math.max(1, liste.length) };
}

/**
 * Die Quellen der angesehenen Fassung. Die aktive traegt sie oben am Satz,
 * jede andere in ihrem Kopf (src/models/fassungen.js fuerOberflaeche) -- so
 * zeigt "[1]" in einer aelteren Fassung auf deren Quelle 1, nicht auf die der
 * aktiven.
 */
export function fassungQuellen(m, angesehen) {
  const d = (m && m.data) || {};
  if (!angesehen || angesehen.aktiv) return Array.isArray(d.quellen) ? d.quellen : [];
  const v = Array.isArray(d.versionen) ? d.versionen[angesehen.version] : null;
  return v && Array.isArray(v.quellen) ? v.quellen : [];
}

/**
 * Der Schluessel einer Insel (Baustein, Ausgabe eines Codeblocks): dieselbe
 * Fassung, dieselbe Blocknummer, derselbe Code -- dann ist es derselbe
 * Knoten, und er wird in den Neubau hinuebergetragen statt neu gebaut.
 */
export function inselSchluessel(version, nr, code) {
  return `${version}|${nr}|${pruefsumme(code)}`;
}

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
      /** 'normal' | 'wissen' („Mein Wissen“), sobald der Chat geladen ist. */
      modus: null,
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
    case 'fassung':
      // Die neue Fassung selbst kommt gleich danach als `antwort` (derselbe
      // Satz, andere Felder). Hier nur merken, dass der Strom eine Fassung ist.
      if (s.lauf) s.lauf.fassung = { messageId: p.messageId, version: p.version, anzahl: p.anzahl, art: p.art };
      break;
    case 'text':
      if (aktiv && typeof p.delta === 'string') aktiv.data.content = `${aktiv.data.content || ''}${p.delta}`;
      break;
    case 'inhalt':
      // Umwandeln einer markierten Stelle: der ganze Text mit der neuen Stelle.
      if (aktiv && typeof p.content === 'string') aktiv.data.content = p.content;
      break;
    case 'denken':
      if (aktiv && typeof p.delta === 'string') aktiv.data.denken = `${aktiv.data.denken || ''}${p.delta}`;
      break;
    case 'quelle':
      if (aktiv && p.url) {
        const q = Array.isArray(aktiv.data.quellen) ? aktiv.data.quellen : [];
        // Wie der Server: dieselbe Adresse mit anderer Kennung ist eine andere
        // Quelle (zwei Aufgaben desselben Projekts fuehren zum selben Projekt).
        if (!q.some((x) => x.url === p.url && (x.id || null) === (p.id || null))) {
          q.push({ titel: p.titel || p.url, url: p.url, art: p.art || 'zitat', ...(p.id ? { id: p.id, typ: p.typ || null } : {}) });
        }
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
        melden(s, ev.type === 'text' || ev.type === 'denken' || ev.type === 'inhalt' ? 'text' : 'daten');
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

/**
 * Der Entwurf im Eingabefeld: nur fuer diesen Tab (siehe
 * lib/lokal.js) -- auf dem Laptop bleibt kein Text zurueck, wenn er zu ist.
 */
function speicher(art, key, value) {
  if (art === 'lesen') return lokal.entwurf.lesen(key);
  if (art === 'loeschen') lokal.entwurf.loeschen(key);
  else lokal.entwurf.schreiben(key, value);
  return null;
}

function istEingabe(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Wie ein Eintrag aus dem eigenen Wissen in der Quellenliste heisst. */
const EINTRAG_ART = { note: 'Notiz', event: 'Termin', task: 'Aufgabe', project: 'Projekt', memory: 'Gemerkt', file: 'Datei', entity: 'Begriff' };
function eintragArt(typ) {
  return EINTRAG_ART[typ] || 'Eintrag';
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

/* ------------------------------------------------------------------ */
/* Zustand der Bausteine                                               */
/* ------------------------------------------------------------------ */

/**
 * Je Antwort und Fassung ein Speicher fuer den Zustand ihrer Bausteine
 * (abgehakt, gewaehlt, Reihenfolge, Timer …). Er lebt auf Modulebene wie die
 * Sitzungen: Wer kurz in den Kalender schaut, findet beim Zurueckkommen die
 * Checkliste so, wie er sie verlassen hat -- auch wenn das Speichern auf dem
 * Server (PUT …/ui, entprellt) noch unterwegs war.
 * Schluessel: `${chatId}|${messageId}|${version}`.
 */
const zustaende = new Map();

/**
 * Den Speicher einer Fassung holen oder anlegen. `start` ist, was der Server
 * mitgeschickt hat (`data.ui[version]`).
 */
function zustandsSpeicher(api, chatId, m, version, beiFehler) {
  const key = `${chatId}|${m.id}|${version}`;
  let z = zustaende.get(key);
  if (!z) {
    const ui = m.data && m.data.ui && typeof m.data.ui === 'object' ? m.data.ui : {};
    z = nachrichtenZustand({
      start: ui[String(version)] || {},
      speichern: async (schluessel, zustand) => {
        const r = await api.put(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(m.id)}/ui`, { version, schluessel, zustand });
        // Was der Server jetzt hat, steht auch am Satz -- ein spaeterer
        // Neubau des Speichers (anderes Geraet, Fassung zurueck) faengt dort an.
        const satz = m.data || {};
        satz.ui = { ...(satz.ui || {}), [String(version)]: (r && r.ui) || {} };
        return r;
      },
      beiFehler,
    });
    zustaende.set(key, z);
    if (zustaende.size > 400) zustaende.delete(zustaende.keys().next().value);
  }
  return z;
}

/* ------------------------------------------------------------------ */
/* Vorlesen                                                            */
/* ------------------------------------------------------------------ */

/**
 * Der eine Vorleser der Seite (web/lib/vorlesen.js): Es liest immer nur eine
 * Antwort, Satz fuer Satz, und das Tempo gilt fuer die ganze Sitzung. Er
 * lebt auf Modulebene wie die Sitzungen; die Ansicht haengt sich an.
 */
let vorleserDerSeite = null;

function vl() {
  if (!vorleserDerSeite && vorlesenMoeglich()) vorleserDerSeite = seitenVorleser();
  return vorleserDerSeite;
}

function sprechenMoeglich() {
  return vorlesenMoeglich();
}

/** Welche Antwort gerade vorgelesen wird (oder null). */
function liestGerade() {
  return vorleserDerSeite ? vorleserDerSeite.zustand().id : null;
}

/**
 * Sprechen: gibt es die Erkennung des Browsers hier nur dem Namen nach
 * (Opera, Chromium ohne Google-Dienst), bleibt es fuer den Rest der Sitzung
 * bei der Aufnahme, die Gemini umschreibt (web/lib/sprechen.js).
 */
let nurAufnahme = false;

/** "0,75×", "1×", "1,5×" */
function tempoText(t) {
  return `${String(t).replace('.', ',')}×`;
}

/**
 * Was vorgelesen wird: die Text-Fassung der Bausteine (nie JSON), ohne
 * Codebloecke -- Code Zeichen fuer Zeichen hoert niemand gern --, ohne
 * Aufzaehlungszeichen und Tabellenstriche.
 */
export function vorleseText(inhalt) {
  const md = markdownOhneUi(String(inhalt || ''));
  let ohneCode = '';
  let pos = 0;
  for (const b of codebloecke(md)) {
    ohneCode += `${md.slice(pos, b.start)}\n`;
    pos = b.ende;
  }
  ohneCode += md.slice(pos);
  // Die Nummern der Quellen ("[1]") liest niemand vor.
  return sprechText(extractPlain(ohneCode).replace(/\[\d{1,2}\]/g, ''));
}

/** Was im Text als Verweis auf eine Quelle gilt: "[1]" bis "[99]". */
const VERWEIS = /\[(\d{1,2})\]/g;

/**
 * "[1]" im Text einer Antwort wird ein kleiner Verweis auf Quelle 1 (neuer
 * Tab) -- dieselbe Zaehlung wie die Liste unter der Antwort. Nur im Fliesstext:
 * nicht in Code, nicht in Links, nicht in Bausteinen; eine Nummer ohne
 * Quelle bleibt, was sie ist (Text).
 */
export function verweiseVerlinken(wurzel, quellen) {
  const liste = Array.isArray(quellen) ? quellen : [];
  if (!wurzel || !liste.length || typeof document === 'undefined') return 0;
  const laeufer = document.createTreeWalker(wurzel, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.parentElement;
      if (!el || el.closest('code, pre, a, button, .bs, .md-code, .cv-code, .md-copycard')) return NodeFilter.FILTER_REJECT;
      return /\[\d{1,2}\]/.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const knoten = [];
  for (let n = laeufer.nextNode(); n; n = laeufer.nextNode()) knoten.push(n);
  let gesetzt = 0;
  for (const n of knoten) {
    const s = n.nodeValue || '';
    const teile = [];
    let pos = 0;
    for (const m of s.matchAll(VERWEIS)) {
      const nr = Number(m[1]);
      const q = liste[nr - 1];
      if (!q || !q.url) continue;
      if (m.index > pos) teile.push(document.createTextNode(s.slice(pos, m.index)));
      const titel = q.titel || q.url;
      const inApp = q.art === 'eintrag';
      teile.push(h('a.cv-verweis', {
        href: q.url,
        target: inApp ? null : '_blank',
        rel: inApp ? null : 'noopener noreferrer',
        title: `${nr} · ${titel}`,
        'aria-label': `Quelle ${nr}: ${titel}`,
        onClick: (e) => e.stopPropagation(),
        // Mit Klammern: markiert und kopiert bleibt es "[1]" -- keine Ziffer
        // klebt an einer Zahl davor ("42" und "1" waeren sonst "421").
      }, text(`[${nr}]`)));
      pos = m.index + m[0].length;
      gesetzt += 1;
    }
    if (!teile.length) continue;
    if (pos < s.length) teile.push(document.createTextNode(s.slice(pos)));
    n.replaceWith(...teile);
  }
  return gesetzt;
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
  let claude = null; // Zustand der KI aus GET /api/ki: {aktiv, name, verbunden, grundCode, grund, netz, …} oder null (unbekannt)
  let claudeGeprueft = false;
  let wartet = null; // Text, der nach dem Verbinden gesendet wird (oder AUS_DEM_FELD)
  /** Merkzeichen fuer `wartet`: nach dem Verbinden das Eingabefeld samt Anhaengen senden. */
  const AUS_DEM_FELD = {};
  // Die Verbinden-Karte wird neu gebaut, sobald sich der Claude-Zustand
  // aendert (Netzmodus, Tresor ...). Schluessel und Fehlersatz ueberleben das
  // hier -- nur im Speicher dieses Tabs, nie im Browser-Speicher.
  const schluesselEntwurf = { gemini: '', auto: '', claude: '' };
  let verbindenFehler = null; // {anbieter, satz}
  let verbindet = false;
  /** Claude hat kein Guthaben mehr: die Karte bietet Gemini an, obwohl Claude "verbunden" ist. */
  let geminiAngebot = false;
  let folgen = true;
  /**
   * Was im Eingabefeld angehaengt ist: Textdateien (ihr Inhalt geht als Text
   * mit) und Bilder/PDF (sie werden beim Senden abgelegt, POST …/anhaenge,
   * und gehen mit ihrer Kennung). Bilder tragen eine Vorschau (blob:).
   * Textdatei: {art:'text', name, text, groesse}
   * Bild/PDF:  {art:'bild'|'pdf', name, mime, groesse, datei, url, id, chatId, laedt}
   */
  let anhaenge = [];
  /** Vorschau-Adressen (blob:), die beim Verlassen freigegeben werden. */
  const vorschauen = new Set();
  /** Solange Dateien hochgeladen werden, geht nichts Zweites los. */
  let legtAb = false;
  /** Eine Nachricht ist unterwegs (vom Tippen, bis die Antwort steht): kein zweites Senden. */
  let sendetGerade = false;
  /**
   * Sprechen (web/lib/sprechen.js): null, oder {weg:'erkennung'|'aufnahme',
   * zustand:'startet'|'hoert'|'schreibt', …}. `gesprochen` merkt sich, dass
   * der Text im Feld gesprochen wurde -- dann wird die Antwort vorgelesen.
   */
  let sprechen = null;
  let gesprochen = false;
  /** „Mein Wissen“ fuer einen Chat, den es noch nicht gibt (er entsteht mit der ersten Nachricht). */
  let modusVorgemerkt = 'normal';
  /** Vorlesen: welche Antwort zuletzt las, und ob die Marke im Text sitzt (sonst zeigt der Spieler den Satz). */
  let vorleseVorher = null;
  let markeSitzt = false;
  /** Zustand der Oberflaeche je Nachricht: auf-/zugeklappt, Auswahl … */
  const ui = new Map();
  const knoten = new Map(); // id -> {node, sig}
  let zeichnenGeplant = false;
  let ersteZeichnung = true;
  let neuAngelegt = false;

  const uiVon = (id) => {
    if (!ui.has(id)) {
      ui.set(id, {
        v: 0,
        fragen: new Map(),
        /** Inseln: einmal gebaute Bausteine und Ausgaben, Schluessel -> Knoten. */
        inseln: new Map(),
        /** Je Codeblock: Bearbeiten offen, Entwurf, laufende Ausgabe. */
        code: new Map(),
        /** Welche Fassung gerade zu sehen ist (null = die aktive). */
        fassung: null,
        /** Vergleich offen: {von} = die Fassung, mit der verglichen wird. */
        vergleich: null,
        /** "Frage dazu" unter einer Ueberschrift: {key, text}. */
        abschnitt: null,
        /** Nach dem Umwandeln einer Stelle: {suche, bis} -- kurz hervorheben. */
        hervorheben: null,
      });
    }
    return ui.get(id);
  };
  const frageUi = (m, f) => {
    const u = uiVon(m.id);
    // `auswahl` ist der Entwurf der Auswahl-Komponente (web/lib/bausteine/auswahl.js).
    if (!u.fragen.has(f.id)) u.fragen.set(f.id, { auswahl: [], eigenOffen: false, eigenText: '', sendet: null, fehler: null });
    return u.fragen.get(f.id);
  };
  const codeUi = (u, key) => {
    if (!u.code.has(key)) u.code.set(key, { bearbeiten: false, entwurf: null, lauf: null });
    return u.code.get(key);
  };
  /** Der Chat dieser Ansicht (auch bevor `s` steht). */
  const cid = () => (s ? s.chatId : chatId);
  /** Der letzte Grund, warum Senden scheiterte -- fuer Bausteine, die ihn zeigen. */
  let letzterSendeFehler = null;
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
    'aria-label': 'Nachricht an die KI. Enter sendet, Umschalt+Enter macht eine neue Zeile.',
    enterkeyhint: 'send',
    autocomplete: 'off',
    spellcheck: 'true',
  });
  const dateiWahl = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    accept: DATEI_ARTEN,
  });
  const clip = h('button.cv-composer__clip', {
    type: 'button',
    title: 'Datei anhängen (Text, Bild oder PDF)',
    'aria-label': 'Datei anhängen (Text, Bild oder PDF)',
    onClick: () => dateiWahl.click(),
  }, icon(I.clip));
  // „Mein Wissen“: die KI antwortet nur aus den eigenen Eintraegen, ohne
  // Internet (src/models/chat.js, Modus 'wissen'). Gilt je Chat.
  const modusKnopf = h('button.cv-composer__modus', {
    type: 'button',
    title: 'Mein Wissen: nur aus deinen eigenen Einträgen antworten, ohne Internet',
    'aria-pressed': 'false',
    onClick: () => modusUmschalten(),
  }, icon(I.graph), h('span.cv-composer__modus-text', null, text('Mein Wissen')));
  // Das Mikrofon gibt es nur, wenn einer der beiden Wege hier geht
  // (aktualisiereEingabe); sonst ist es gar nicht da.
  const mikro = h('button.cv-composer__mikro', {
    type: 'button',
    hidden: true,
    title: 'Sprechen',
    'aria-label': 'Sprechen',
    'aria-pressed': 'false',
    onClick: () => sprechenUmschalten(),
  }, icon(SYMBOL_MIKRO));
  const sendKnopf = h('button.cv-composer__senden', { type: 'submit', 'aria-label': 'Senden', title: 'Senden (Enter)' }, icon(I.send));
  const anhangZeile = h('div.cv-anhaenge', { hidden: true });
  const schnellZeile = h('div.cv-schnell', { hidden: true, role: 'group', 'aria-label': 'Was soll die KI mit den Anhängen tun?' });
  const sprechZeile = h('div.cv-sprechen', { hidden: true, role: 'status', 'aria-live': 'polite' });
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
    clip, modusKnopf, feld, mikro, sendKnopf);
  const eingabe = h('div.cv-eingabe', null,
    h('div.cv-eingabe__innen', null, nachUnten, verbindenUnten, sprechZeile, anhangZeile, schnellZeile, formular, dateiWahl));

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
          // Erst der neue Knoten ins Dokument, dann die Inseln hinueber
          // (beide haengen dann im selben Dokument: `moveBefore` behaelt
          // einen Rahmen samt Inhalt), erst danach der alte weg.
          verlauf.insertBefore(node, eintrag.node);
          inselnEinsetzen(node);
          eintrag.node.remove();
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
      inselnEinsetzen(eintrag.node);
      vorher = eintrag.node;
    }
    for (const [id, eintrag] of [...knoten]) {
      if (bleiben.has(id)) continue;
      eintrag.node.remove();
      knoten.delete(id);
      const u = ui.get(id);
      if (u) u.inseln.clear();
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
    // Eine neu gebaute Antwort hat neue Textknoten: die Marke des Vorlesens neu setzen.
    if (liestGerade()) vorleseMarke(vl().zustand());
  }

  function signatur(m, u, letzte, laeuft, aktiv) {
    const d = m.data;
    return JSON.stringify([
      m.updatedAt, d.status, (d.content || '').length, (d.denken || '').length, d.agenten, d.rueckfragen,
      d.rueckfrageOffen, (d.quellen || []).length, d.error, d.abgeschnitten, m._hinweise, m._stop, m._lokal,
      letzte, laeuft, aktiv, u.v, liestGerade() === m.id, !!claude && claude.verbunden,
      d.version, Array.isArray(d.versionen) ? d.versionen.length : 0, u.fassung, u.vergleich, u.abschnitt,
      Array.isArray(d.anhaenge) ? d.anhaenge.length : 0,
    ]);
  }

  /**
   * Inseln an ihre Plaetze: Der Aufbau einer Nachricht setzt fuer jeden
   * Baustein und jede laufende Ausgabe nur einen Platzhalter; hier kommt der
   * einmal gebaute Knoten hinein. Haengt er noch im alten Knoten (und kann
   * der Browser `moveBefore`), wandert er samt Zustand und Rahmen -- sonst
   * wird er umgehaengt, was einen Rahmen neu laedt, aber nichts verliert,
   * was ausserhalb des DOM liegt.
   */
  function inselnEinsetzen(node) {
    const liste = node._inseln;
    if (!liste || !liste.length) return;
    node._inseln = [];
    for (const [platz, insel] of liste) {
      const eltern = platz.parentNode;
      if (!eltern) continue;
      if (insel === platz) continue;
      let bewegt = false;
      if (insel.isConnected && typeof eltern.moveBefore === 'function') {
        try {
          eltern.moveBefore(insel, platz);
          platz.remove();
          bewegt = true;
        } catch {
          bewegt = false;
        }
      }
      if (!bewegt) platz.replaceWith(insel);
    }
  }

  /** Ein Platzhalter fuer eine Insel; `zeile` merkt sich das Paar fuer `inselnEinsetzen`. */
  function inselPlatz(zeile, insel) {
    const platz = h('div.cv-insel-platz', { hidden: true });
    if (!zeile._inseln) zeile._inseln = [];
    zeile._inseln.push([platz, insel]);
    return platz;
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
    if (geminiAngebot && claude && claude.aktiv === 'gemini' && claude.verbunden) geminiAngebot = false;
    const fehlt = (!!claude && claude.verbunden === false) || geminiAngebot;
    const art = leer ? (fehlt ? 'verbinden' : (claudeGeprueft ? 'leer' : 'laedt')) : (fehlt ? 'unten' : 'nichts');
    const key = `${art}|${geminiAngebot}|${fehlt && claude ? JSON.stringify([claude.grundCode, claude.grund, mussOnline()]) : ''}`;
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
   * Die ruhige Karte, wenn die KI nicht antworten kann. Ohne Schluessel:
   * "Verbinde eine KI" -- oben gross Google (kostenlos); darunter klein
   * aufklappbar ein Feld fuer jede andere KI (der Anbieter ergibt sich aus
   * dem Schluessel: Mistral, Groq, OpenRouter, OpenAI), OVHcloud ganz ohne
   * Schluessel mit einem Knopf und Claude (kostet). Ein Satz, wo es den
   * Schluessel gibt -- und danach geht es sofort weiter. Ist Neural OS
   * offline, ist das derselbe eine Schritt: der Knopf sagt "Online gehen und
   * verbinden", und genau das tut der Klick.
   */
  const ANBIETER = {
    gemini: {
      name: 'Gemini', titel: 'Kostenlos mit Google', platzhalter: 'AQ.… oder AIza…', label: 'Google-Schlüssel',
      links: [{ href: 'https://aistudio.google.com/apikey', text: 'aistudio.google.com/apikey' }],
      satz: ' → Create API key. Kostenlos; Google darf Inhalte zur Verbesserung nutzen.',
    },
    auto: {
      name: 'Die KI', titel: 'Oder eine andere kostenlose KI (Mistral, Groq, OpenRouter)', platzhalter: 'Schlüssel von Mistral, Groq oder OpenRouter', label: 'Schlüssel einer anderen KI',
      vor: 'Kostenlos ohne Karte: ',
      links: [
        { href: 'https://console.mistral.ai/api-keys', text: 'console.mistral.ai' },
        { href: 'https://console.groq.com/keys', text: 'console.groq.com/keys' },
        { href: 'https://openrouter.ai/settings/keys', text: 'openrouter.ai/settings/keys' },
      ],
      satz: '. Neural OS erkennt am Schlüssel, von wem er ist.',
    },
    claude: {
      name: 'Claude', titel: 'Oder Claude (kostet pro Nutzung)', platzhalter: 'sk-ant-…', label: 'Claude-Schlüssel',
      links: [{ href: 'https://console.anthropic.com/settings/keys', text: 'console.anthropic.com' }],
      satz: ' → API Keys. Kostet pro Nutzung; die Rechnung stellt Anthropic.',
    },
  };

  /** Der Name, den der Server fuer einen Anbieter nennt (Mistral, Groq, …) -- sonst der eigene. */
  function anbieterName(z, id) {
    const s = z && z.anbieter && z.anbieter[id] && z.anbieter[id].name;
    return s || (ANBIETER[id] && ANBIETER[id].name) || 'Die KI';
  }

  function baueVerbinden(kompakt) {
    const code = claude && claude.grundCode;
    const name = (claude && claude.name) || 'Die KI';
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
        h('p.cv-verbinden__text', null, text(`Neural OS ist gerade offline. ${name} antwortet nur, wenn Neural OS ins Internet darf.`)),
        h('div.cv-verbinden__form', null, schalter),
        fehler);
      return karte;
    }
    if (code === 'gesperrt') {
      const ziel = claude && typeof claude.ziel === 'string' && claude.ziel.startsWith('#/') ? claude.ziel : '#/settings';
      karte.append(kopf('Erst die PIN'),
        h('p.cv-verbinden__text', null, text((claude && claude.grund) || 'Der Tresor ist gesperrt. Entsperre ihn mit deiner PIN, dann kann die KI antworten.')),
        h('div.cv-verbinden__form', null, h('a.btn.btn--primary', { href: ziel }, icon(I.unlock), h('span', null, text('PIN eingeben')))));
      return karte;
    }
    if (code === 'schleuse') {
      karte.append(kopf(`${name} ist gesperrt`),
        h('p.cv-verbinden__text', null, text(claude.grund || 'Die Netzschleuse lässt den Anbieter gerade nicht durch.')),
        h('div.cv-verbinden__form', null, h('a.btn', { href: '#/network' }, icon(I.network), h('span', null, text('Netzwerk öffnen')))));
      return karte;
    }
    if (code !== 'kein-schluessel' && code !== 'schluessel-falsch' && claude && claude.grund && !code) {
      karte.append(kopf(`${name} ist nicht erreichbar`), h('p.cv-verbinden__text', null, text(claude.grund)));
      return karte;
    }

    // Kein oder ein falscher Schluessel: Google zuerst, darunter die anderen.
    const online = mussOnline();
    const knopfText = online ? 'Online gehen und verbinden' : 'Verbinden';

    /**
     * Verbinden -- fuer ein Feld (mit Schluessel) und fuer OVHcloud (ohne).
     * `ui`: {knopf, feld?, zeige, ruhe} -- der Knopf zeigt, was gerade
     * passiert; `ruhe` stellt ihn danach wieder her.
     */
    const verbindenLos = async (anbieter, schluessel, ui) => {
      verbindenFehler = null;
      verbindet = true;
      ui.knopf.disabled = true;
      if (ui.feld) ui.feld.disabled = true;
      clear(ui.knopf);
      ui.knopf.append(h('span.spinner.cv-spinner', { 'aria-hidden': 'true' }), h('span', null, text(online ? 'Gehe online …' : 'Prüfe …')));
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
        // Wer hier verbindet, will mit dieser KI weiterschreiben -- auch wenn vorher eine andere eingestellt war.
        const z = await api.post(`/ki/${anbieter}/schluessel`, { ...(schluessel ? { schluessel } : {}), aktivieren: true }, { timeoutMs: 45000 });
        claude = { ...z };
        geminiAngebot = false;
        // GET /api/ki sagt zusaetzlich, ob das Mikrofon ueber Gemini umschreiben kann.
        claudeBald();
        schluesselEntwurf[anbieter] = '';
        if (ui.feld) ui.feld.value = '';
        // Stand ein Schluessel im falschen Feld, hat der Server ihn richtig zugeordnet.
        const ziel = (z && z.umgeleitet) || anbieter;
        const wer = anbieterName(z, ziel);
        ctx.toast(z && z.umgeleitet && anbieter !== 'auto' ? `Das war ein Schlüssel für ${wer} – ${wer} ist verbunden.` : `${wer} ist verbunden.`, 'success');
        verbindet = false;
        obenKey = null;
        plane();
        if (wartet) {
          const t = wartet;
          wartet = null;
          // Was im Feld stand (samt Anhaengen), geht jetzt so ab, wie es dort steht.
          if (t === AUS_DEM_FELD) absenden();
          else senden(t);
        } else {
          feld.focus();
        }
      } catch (err) {
        if (umgeschaltet && vorher) {
          try { await api.put('/network', { mode: vorher }); } catch { /* der Status unten links zeigt, was gilt */ }
        }
        if (online && !umgeschaltet) {
          verbindenFehler = { anbieter, satz: err && err.status === 403
            ? 'Online schalten geht nur am Gerät selbst, auf dem Neural OS läuft.'
            : `Nicht umgeschaltet: ${(err && err.message) || 'unbekannter Fehler'}` };
        } else if (!/_OFFLINE$/.test(String(err && err.code))) {
          // *_OFFLINE ohne Umschalten: der Zustand war veraltet; die neu
          // gebaute Karte bietet "Online gehen und verbinden" an.
          verbindenFehler = { anbieter, satz: (err && err.message) || 'Der Schlüssel ließ sich nicht prüfen.' };
          if (err && err.code === 'CLAUDE_GUTHABEN') verbindenFehler.satz += ' Kostenlos geht es oben mit Google (Gemini).';
        }
        verbindet = false;
        await claudeLaden();
        if (!lebt) return;
        obenKey = null;
        plane();
      } finally {
        verbindet = false;
        if (ui.knopf.isConnected) ui.ruhe();
      }
    };

    const hinweisFuer = (A) => {
      const p = h('p.cv-verbinden__hinweis', null, text(A.vor || 'Schlüssel: '));
      A.links.forEach((l, i) => {
        if (i) p.appendChild(text(' · '));
        p.appendChild(h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer' }, text(l.text)));
      });
      p.appendChild(text(A.satz));
      return p;
    };

    const formFuer = (anbieter) => {
      const A = ANBIETER[anbieter];
      const eingabeFeld = h('input.input', {
        type: 'password',
        name: `${anbieter}-schluessel`,
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: A.platzhalter,
        'aria-label': A.label,
        onInput: (e) => { schluesselEntwurf[anbieter] = e.target.value; },
      });
      eingabeFeld.value = schluesselEntwurf[anbieter] || '';
      const eigenerFehler = h('p.cv-verbinden__fehler', { role: 'alert', hidden: true });
      if (verbindenFehler && verbindenFehler.anbieter === anbieter) {
        eigenerFehler.appendChild(text(verbindenFehler.satz));
        eigenerFehler.hidden = false;
      }
      const knopf = h('button.btn.btn--primary', { type: 'submit' }, h('span', null, text(knopfText)));
      const form = h('form.cv-verbinden__form', {
        onSubmit: async (e) => {
          e.preventDefault();
          const wert = eingabeFeld.value.trim();
          if (!wert) {
            eingabeFeld.focus();
            return;
          }
          schluesselEntwurf[anbieter] = eingabeFeld.value;
          eigenerFehler.hidden = true;
          await verbindenLos(anbieter, wert, {
            knopf,
            feld: eingabeFeld,
            ruhe: () => {
              knopf.disabled = false;
              eingabeFeld.disabled = false;
              clear(knopf);
              knopf.appendChild(h('span', null, text(knopfText)));
            },
          });
        },
      }, eingabeFeld, knopf);
      return { form, fehler: eigenerFehler, hinweis: hinweisFuer(A) };
    };

    const g = formFuer('gemini');
    const andere = formFuer('auto');
    const c = formFuer('claude');
    // OVHcloud: kein Konto, kein Schluessel -- ein Knopf.
    const ovhText = online ? 'Online gehen und einschalten' : 'OVHcloud einschalten';
    const ovhKnopf = h('button.btn', {
      type: 'button',
      onClick: () => verbindenLos('ovh', null, {
        knopf: ovhKnopf,
        ruhe: () => {
          ovhKnopf.disabled = false;
          clear(ovhKnopf);
          ovhKnopf.appendChild(h('span', null, text(ovhText)));
        },
      }),
    }, h('span', null, text(ovhText)));
    const ovhFehler = h('p.cv-verbinden__fehler', { role: 'alert', hidden: !(verbindenFehler && verbindenFehler.anbieter === 'ovh') },
      text(verbindenFehler && verbindenFehler.anbieter === 'ovh' ? verbindenFehler.satz : ''));
    // Ein abgelehnter Schluessel: das Feld des betroffenen Anbieters ist offen.
    const falschBei = code === 'schluessel-falsch' && claude ? claude.aktiv : null;
    const andereOffen = (falschBei && falschBei !== 'gemini' && falschBei !== 'claude' && falschBei !== 'ovh')
      || (verbindenFehler && verbindenFehler.anbieter === 'auto');
    karte.append(kopf('Verbinde eine KI'));
    if (geminiAngebot) {
      karte.append(h('p.cv-verbinden__text', null, text('Bei Anthropic ist kein Guthaben mehr. Kostenlos geht es mit Gemini von Google weiter – Schlüssel einfügen, dann antwortet Gemini.')));
    } else if (falschBei) {
      karte.append(h('p.cv-verbinden__text', null, text(`Der gespeicherte ${anbieterName(claude, falschBei)}-Schlüssel wird nicht mehr angenommen. Füge einen neuen ein – danach geht es sofort weiter.`)));
    }
    karte.append(
      h('h3.cv-verbinden__unter', null, text(ANBIETER.gemini.titel)),
      g.form, g.fehler, g.hinweis,
      h('details.cv-verbinden__andere', { open: andereOffen ? '' : null },
        h('summary', null, text(ANBIETER.auto.titel)),
        andere.form, andere.fehler, andere.hinweis),
      h('div.cv-verbinden__ohne', null,
        h('p.cv-verbinden__hinweis', null, text('Ganz ohne Schlüssel und ohne Konto: OVHcloud (aus Frankreich) – dafür langsam, 2 Anfragen je Minute.')),
        ovhKnopf),
      ovhFehler,
      h('details.cv-verbinden__mehr', { open: falschBei === 'claude' || (verbindenFehler && verbindenFehler.anbieter === 'claude') ? '' : null },
        h('summary', null, text(ANBIETER.claude.titel)),
        c.form, c.fehler, c.hinweis));
    return karte;
  }

  /* ---------------------------------------------- eigene Nachricht */

  function baueEigene(m, u) {
    const inhalt = String(m.data.content || '');
    const dateien = Array.isArray(m.data.anhaenge) ? m.data.anhaenge : [];
    const zeile = h('div.cv-msg.cv-msg--user', { 'data-id': m.id, onClick: (e) => antippen(e, m.id) });
    const spalteN = h('div.cv-msg__spalte');
    if (u.bearbeiten) {
      spalteN.appendChild(baueBearbeiten(m, u));
      zeile.appendChild(spalteN);
      return zeile;
    }
    // Bilder und PDF stehen ueber dem Text, wie sie mitgeschickt wurden.
    if (dateien.length) spalteN.appendChild(anhangGalerie(dateien));
    const zeit = h('span.cv-zeit', null,
      m.data.bearbeitetAm ? h('span.cv-zeit__zusatz', null, text('bearbeitet · ')) : null,
      text(m._lokal ? 'sendet …' : uhrzeit(m.createdAt)));
    if (inhalt.trim()) {
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
      blase.appendChild(zeit);
      spalteN.appendChild(blase);
    } else {
      spalteN.appendChild(zeit);
    }
    if (!m._lokal) {
      spalteN.appendChild(h('div.cv-aktionen', { role: 'toolbar', 'aria-label': 'Nachricht' },
        inhalt.trim() ? kopierAktion(() => inhalt, 'Nachricht kopieren') : null,
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
        h('span.cv-bearbeiten__hinweis', null, text('Alles danach fällt weg, und die KI antwortet neu.')),
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
      if (nichtVerbunden(err)) claudeAus(err);
      neuZeichnen(m.id);
    }
  }

  /**
   * Die Anhaenge einer eigenen Nachricht: ein Bild gross, mehrere als
   * Reihe zum Wischen (Karussell); Antippen oeffnet den Leuchtkasten mit
   * allen Bildern der Nachricht. Ein PDF ist eine Karte mit [Anzeigen]
   * (neuer Tab, der Betrachter des Browsers). Vor dem Ablegen zeigt die
   * vorlaeufige Nachricht die Vorschau aus dem Speicher des Browsers.
   */
  function anhangGalerie(dateien) {
    const chat = cid();
    const quelle = (a) => a.vorschau || (a.id && chat ? anhangUrl(chat, a.id) : null);
    const bilder = dateien.filter((a) => a && /^image\//.test(String(a.mime || '')));
    const pdfs = dateien.filter((a) => a && a.mime === 'application/pdf');
    const box = h('div.cv-dateien');
    if (bilder.length) {
      const liste = bilder.map((a) => ({ src: quelle(a), name: a.name || 'Bild' }));
      box.appendChild(h('div.cv-galerie', { class: bilder.length === 1 ? 'cv-galerie--eins' : 'cv-galerie--viele' },
        bilder.map((a, i) => (liste[i].src
          ? h('button.cv-galerie__bild', {
            type: 'button',
            title: `${liste[i].name} – vergrößern`,
            'aria-label': `Bild vergrößern: ${liste[i].name}`,
            onClick: (e) => {
              e.stopPropagation();
              leuchtkasten({ bilder: liste, start: i });
            },
          }, h('img', { src: liste[i].src, alt: liste[i].name, loading: 'lazy', decoding: 'async', draggable: 'false' }))
          : h('span.cv-galerie__fehlt', null, text(liste[i].name))))));
    }
    for (const a of pdfs) {
      const url = a.id && chat ? anhangUrl(chat, a.id) : null;
      box.appendChild(h('div.cv-pdf', null,
        h('span.cv-pdf__symbol', { 'aria-hidden': 'true' }, icon(SYMBOL_PDF)),
        h('span.cv-pdf__text', null,
          h('span.cv-pdf__name', null, text(a.name || 'Dokument.pdf')),
          h('span.cv-pdf__groesse', null, text(`PDF · ${groesse(Number(a.size) || 0)}`))),
        url
          ? h('a.btn.btn--small.cv-pdf__anzeigen', { href: url, target: '_blank', rel: 'noopener noreferrer', onClick: (e) => e.stopPropagation() }, text('Anzeigen'))
          : h('span.cv-pdf__laedt', null, text('wird abgelegt …'))));
    }
    return box;
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

    // 2. Was gerade passiert (Live-Fortschritt, docs/ANTWORT-BAUSTEINE.md 6),
    // aus den echten Ereignissen dieses Zuges: erledigte Schritte mit Haken
    // ("Termin eingetragen …"), laufende mit Punkt ("Sucht im Internet …"),
    // und solange Text kommt "Schreibt die Antwort …". Danach klappt alles
    // zu "3 Arbeitsschritte" (3.).
    if (laeuft) {
      const live = fortschritt(d, agenten, fragen, inhalt);
      if (live) blase.appendChild(live);
    }

    // 3. Die Arbeitsschritte, zugeklappt: wer war beteiligt, mit welchem Ergebnis.
    const fertige = agenten.filter((a) => a.zustand !== 'laeuft');
    if (fertige.length && !laeuft) blase.appendChild(schritte(m, u, agenten));

    // 4.–6. Der Text, und an der Stelle, an der es geschah, was die KI
    // angelegt hat (Karten) und was sie gefragt hat (Rueckfragen). Ein Zug
    // mit drei Rueckfragen liest sich so wie ein Gespraech: Satz, Frage,
    // Antwort, Satz -- nicht drei Absaetze Text und darunter drei Fragen.
    // Wird eine andere Fassung angesehen, steht nur ihr Text da: Karten und
    // Fragen gehoeren zur aktiven.
    const fs = fassungInhalt(m, u.fassung);
    const angesehen = laeuft ? fassungInhalt(m) : fs;
    const textInhalt = angesehen.aktiv ? inhalt : angesehen.inhalt;
    const quellenHier = fassungQuellen(m, angesehen);
    const bloecke = codebloecke(textInhalt);
    const marken = [];
    if (angesehen.aktiv) {
      for (const a of agenten) {
        if (Array.isArray(a.wirkung) && a.wirkung.length && a.zustand === 'fertig') marken.push({ pos: stelle(a.beiZeichen), art: 0, a });
      }
      for (const f of fragen) marken.push({ pos: stelle(f.beiZeichen), art: 1, f });
      marken.sort((x, y) => (x.pos - y.pos) || (x.art - y.art));
    }
    let cursor = 0;
    let teil = 0;
    // Blocknummern zaehlen ueber ALLE Textstuecke der Antwort (der Server
    // zaehlt so: PATCH …/block, src/models/fassungen.js codebloecke).
    let blockNr = 0;
    const benutzt = new Set();
    const hook = (block, standard) => {
      const nr = blockNr;
      blockNr += 1;
      return codeBlock(zeile, m, u, angesehen.version, nr, block, standard, laeuft, letzte, benutzt);
    };
    const textTeil = (bis) => {
      const stueck = textInhalt.slice(cursor, bis);
      cursor = bis;
      if (!stueck.trim()) return;
      const md = h('div.cv-md');
      md.appendChild(renderMarkdown(stueck, { kopierKarten: true, hakenKreise: true, codeBlock: hook }));
      // Jede Tabelle sortierbar, ab 7 Zeilen filterbar, mit fester Kopfzeile;
      // ihr Zustand (Sortierung, Filter) liegt ausserhalb des DOM.
      tabellenVerbessern(md, { schluessel: `${m.id}|${angesehen.version}|${teil}` });
      // "[1]" wird ein Verweis auf die Quelle darunter -- die dieser Fassung.
      verweiseVerlinken(md, quellenHier);
      if (!laeuft) ueberschriftenFragen(md, m, u, teil);
      teil += 1;
      blase.appendChild(md);
    };
    for (const mk of marken) {
      // Nie mitten in einem Codezaun schneiden (ein ```ui-Baustein zerbraeche).
      textTeil(schnittSicher(textInhalt, Math.min(mk.pos, textInhalt.length), bloecke));
      blase.appendChild(mk.art === 0 ? wirkungKarten(m, [mk.a]) : frageKarte(m, mk.f, letzte));
    }
    textTeil(textInhalt.length);
    if (!laeuft) stelleMarkieren(blase, u);
    // Inseln, die diese Fassung nicht mehr braucht, loslassen.
    for (const key of [...u.inseln.keys()]) if (!benutzt.has(key)) u.inseln.delete(key);

    // 7. Quellen (Websuche, eigene Einträge) -- die der angesehenen Fassung.
    if (quellenHier.length) blase.appendChild(quellenListe(u, quellenHier));

    // 8. Wie es endete, ehrlich.
    for (const n of statusZeilen(m, letzte, laeuft)) blase.appendChild(n);

    if (!angesehen.aktiv) {
      blase.appendChild(h('p.cv-fassung__hinweis', null,
        icon(I.info),
        h('span', null, text(`Fassung ${angesehen.version + 1} von ${angesehen.anzahl} · ${fassungsName((d.versionen || [])[angesehen.version])} – nur angesehen`))));
    }
    if (!laeuft && !m._lokal) blase.appendChild(h('span.cv-zeit', null, text(uhrzeit(m.createdAt))));

    const spalteN = h('div.cv-msg__spalte', null, blase);
    if (!laeuft && (textInhalt.trim() || angesehen.anzahl > 1)) spalteN.appendChild(antwortAktionen(m, letzte, angesehen));
    if (liestGerade() === m.id && vl()) spalteN.appendChild(spielerZeile());
    if (!laeuft && u.vergleich) spalteN.appendChild(vergleichKarte(m, u, angesehen));
    // Geratene Vorschlags-Chips gibt es nicht mehr: Naechste Schritte bietet die
    // KI selbst ueber den Baustein "aktionen" an (docs/ANTWORT-BAUSTEINE.md, 6.).
    zeile.append(h('span.avatar.cv-avatar', { 'aria-hidden': 'true' }, icon(I.brand)), spalteN);
    if (!angesehen.aktiv || u.vergleich) zeile.classList.add('is-fassung');
    return zeile;
  }

  /* -------------------------------------------- Codebloecke, Bausteine */

  /**
   * Die `api` fuer Bausteine und Codebloecke: dieselbe wie die der Ansicht,
   * nur dass ein PATCH (Block bearbeiten -> neue Fassung) seinen Satz gleich
   * in die Sitzung uebernimmt. Sonst saehe man die neue Fassung erst, wenn
   * der Bus sie meldet.
   */
  function bausteinApi() {
    return {
      ...api,
      patch: async (pfad, body, opts) => {
        const r = await api.patch(pfad, body, opts);
        if (r && r.record && s) {
          einsetzen(s, r.record);
          const u = uiVon(r.record.id);
          u.fassung = null;
          u.vergleich = null;
          plane();
        }
        return r;
      },
    };
  }

  /** Der ctx-Vertrag der Bausteine (web/lib/bausteine/index.js, Kopfkommentar). */
  function bausteinCtx(m, version, nr, laeuft, letzte) {
    const chat = cid();
    return {
      senden: (t) => sendenAusBaustein(t),
      zustand: (schluessel) => zustandsSpeicher(api, chat, m, version, (err) => {
        ctx.toast(`Nicht gespeichert: ${fehlerSatz(err)}`, 'error');
      }).fuer(schluessel),
      // Den Antwortstil neu anwenden geht nur bei der letzten Antwort
      // (Server: 409 NUR_LETZTE_ANTWORT). Sonst bietet der Regler ehrlich
      // "Senden" an statt eines Knopfs, der scheitert.
      stilSetzen: letzte ? (stil) => stilSetzen(m, stil) : undefined,
      api: bausteinApi(),
      oeffnen: (route) => ctx.navigate(route),
      renderMarkdown: (t) => markdownKnoten(t),
      kiName: (claude && claude.name) || 'KI',
      chatId: chat,
      messageId: m.id,
      blockNr: nr,
      version,
      laeuft,
    };
  }

  /** Markdown in einem Baustein (`inhalt`-Felder): wie im Chat, ohne Codeblock-Leiste. */
  function markdownKnoten(t) {
    const box = h('div.cv-md');
    box.appendChild(renderMarkdown(String(t || ''), { kopierKarten: true, hakenKreise: true }));
    tabellenVerbessern(box);
    return box;
  }

  /**
   * Der Haken fuer jeden Codeblock einer Antwort (web/lib/markdown.js,
   * `codeBlock`): ```ui wird Baustein (als Insel), alles andere ein Codeblock
   * mit erkannter Sprache und der Leiste Bearbeiten · Ausfuehren · Erklaeren ·
   * Fehler suchen.
   */
  function codeBlock(zeile, m, u, version, nr, block, standard, laeuft, letzte, benutzt) {
    const offen = block.closed === false && laeuft;
    const lang = String(block.lang || '').trim().toLowerCase();
    if (istUi(lang) || (offen && lang === 'u')) {
      // Noch nicht fertig: der ruhige Platzhalter (kein Zustand, keine Insel).
      if (offen) return renderCodeBlock(block, { laeuft: true });
      // Der Regler "Antwortstil" bietet "Übernehmen" nur an, solange die
      // Antwort die letzte ist (ctx.stilSetzen; der Server erstellt nur die
      // letzte neu). Kommt eine weitere Antwort, wird allein er neu gebaut
      // und bietet ehrlich [Übernehmen] als Nachricht an -- die anderen
      // Inseln bleiben stehen (ein Rahmen luede sonst neu).
      const stilRegler = /"typ"\s*:\s*"regler"/.test(block.code);
      const key = inselSchluessel(version, nr, block.code) + (stilRegler && letzte ? '|letzte' : '');
      benutzt.add(key);
      let insel = u.inseln.get(key);
      if (!insel) {
        insel = renderCodeBlock({ ...block, closed: true }, bausteinCtx(m, version, nr, laeuft, letzte));
        if (!insel) return null;
        u.inseln.set(key, insel);
      }
      return inselPlatz(zeile, insel);
    }
    // Ohne Sprache: erkennen, wenn der Inhalt sie eindeutig verraet.
    const erkannt = block.lang ? '' : spracheErkennen(block.code);
    const b = erkannt ? { ...block, lang: erkannt, info: erkannt } : block;
    const node = standard(b);
    // Prompt- und Textkarten haben ihr eigenes Kopieren; waehrend die
    // Antwort noch kommt, gibt es keine Leiste.
    if (!node || node.classList.contains('md-copycard') || laeuft || block.closed === false) return node;
    const sprache = String(b.lang || '').trim();
    const key = inselSchluessel(version, nr, block.code);
    benutzt.add(key);
    const a = codeUi(u, key);
    const laufArt = ausfuehrbar(sprache);
    const knopf = (markup, label, fn) => h('button.cv-code__knopf', {
      type: 'button',
      title: label,
      onClick: (e) => { e.stopPropagation(); fn(); },
    }, icon(markup), h('span', null, text(label)));
    const leiste = h('div.cv-code__leiste', { role: 'toolbar', 'aria-label': 'Codeblock' },
      knopf(SYMBOL_STIFT, a.bearbeiten ? 'Bearbeiten beenden' : 'Bearbeiten', () => {
        a.bearbeiten = !a.bearbeiten;
        neuZeichnen(m.id);
      }),
      laufArt ? knopf(SYMBOL_START, 'Ausführen', () => {
        // Ein Lauf je Block: der vorige geht (samt Rahmen oder Worker).
        if (a.lauf) a.lauf.remove();
        a.lauf = laufAnzeige({ sprache: laufArt, code: block.code, onSchliessen: () => { a.lauf = null; } });
        neuZeichnen(m.id);
      }) : null,
      knopf(SYMBOL_ERKLAEREN, 'Erklären', () => senden(codeFrage('erklaeren', sprache, block.code))),
      knopf(SYMBOL_FEHLER, 'Fehler suchen', () => senden(codeFrage('fehler', sprache, block.code))));
    const box = h('div.cv-code', { dataset: { nr: String(nr) } }, node, leiste);
    if (a.bearbeiten) {
      // Dasselbe Feld wie bei Datei und Vorschau: Speichern ist PATCH …/block
      // und legt eine neue Fassung an.
      box.appendChild(bearbeitenFeld({
        api: bausteinApi(),
        chatId: cid(),
        messageId: m.id,
        blockNr: nr,
        tiefe: 0,
        quelle: null,
        key: (t) => `code:${m.id}:${nr}:${t}`,
        neuZeichnen: () => neuZeichnen(m.id),
      }, a, block.code, { sprache: sprache || 'Text' }));
    }
    if (a.lauf) box.appendChild(inselPlatz(zeile, a.lauf));
    return box;
  }

  /**
   * "Frage dazu" an jeder Ueberschrift (h2/h3 der Antwort): beim Ueberfahren
   * ein kleiner Knopf, mit dem Finger immer sichtbar; er oeffnet ein Feld
   * direkt darunter, Enter fragt die KI zu genau diesem Abschnitt.
   */
  function ueberschriftenFragen(md, m, u, teil) {
    const koepfe = md.querySelectorAll('.md-heading--2, .md-heading--3');
    koepfe.forEach((kopf, i) => {
      const key = `${teil}:${i}`;
      const titel = kopf.textContent.trim();
      kopf.classList.add('cv-abschnitt');
      kopf.appendChild(h('button.cv-frage-dazu', {
        type: 'button',
        title: 'Frage zu diesem Abschnitt',
        'aria-label': `Frage zum Abschnitt „${titel}“`,
        'aria-expanded': String(!!(u.abschnitt && u.abschnitt.key === key)),
        onClick: (e) => {
          e.stopPropagation();
          u.abschnitt = u.abschnitt && u.abschnitt.key === key ? null : { key, text: '' };
          neuZeichnen(m.id);
          if (u.abschnitt) {
            setTimeout(() => {
              const f = verlauf.querySelector(`[data-key="${CSS.escape(`abschnitt:${m.id}:${key}`)}"]`);
              if (f) f.focus();
            }, 30);
          }
        },
      }, icon(SYMBOL_FRAGE_DAZU), h('span', null, text('Frage dazu'))));
      if (u.abschnitt && u.abschnitt.key === key) {
        const inp = h('input.input.cv-abschnitt__feld', {
          type: 'text',
          placeholder: `Frage zu „${titel.slice(0, 40)}“ …`,
          maxlength: 2000,
          'aria-label': `Frage zum Abschnitt „${titel}“`,
          'data-key': `abschnitt:${m.id}:${key}`,
          enterkeyhint: 'send',
          onInput: (e) => { u.abschnitt.text = e.target.value; },
          onKeydown: (e) => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              abschnittSenden(m, u, titel);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              u.abschnitt = null;
              neuZeichnen(m.id);
            }
          },
        });
        inp.value = u.abschnitt.text || '';
        kopf.after(h('div.cv-abschnitt__frage', null, inp,
          h('button.btn.btn--primary', {
            type: 'button',
            onClick: (e) => { e.stopPropagation(); abschnittSenden(m, u, titel); },
          }, text('Fragen'))));
      }
    });
  }

  async function abschnittSenden(m, u, titel) {
    const frage = u.abschnitt ? String(u.abschnitt.text || '').trim() : '';
    if (!frage) return;
    const ok = await senden(abschnittFrage(titel, frage));
    if (ok) {
      u.abschnitt = null;
      neuZeichnen(m.id);
    }
  }

  /** Senden aus einem Baustein: wirft mit einem lesbaren Satz, statt still zu scheitern. */
  async function sendenAusBaustein(t) {
    if (s && s.lauf) throw new Error('Gerade läuft schon eine Antwort. Warte, bis sie fertig ist.');
    if (claude && claude.verbunden === false) throw new Error('Erst eine KI verbinden – oben im Chat.');
    letzterSendeFehler = null;
    const ok = await senden(t);
    if (!ok) throw new Error(letzterSendeFehler || 'Nicht gesendet.');
    return true;
  }

  /**
   * Der Regler "Antwortstil": den Stil des Chats setzen und die letzte
   * Antwort damit neu erstellen (eine neue Fassung, Server: variante `stil`).
   */
  async function stilSetzen(m, stil) {
    if (!s) throw new Error('Kein Chat.');
    if (s.lauf) throw new Error('Gerade läuft schon eine Antwort. Warte, bis sie fertig ist.');
    const u = uiVon(m.id);
    u.fassung = null;
    u.vergleich = null;
    folgen = true;
    try {
      await strom(s, api, `/chats/${encodeURIComponent(s.chatId)}/neu-antworten`, { variante: 'stil', stil, messageId: m.id });
    } catch (err) {
      if (nichtVerbunden(err)) claudeAus(err);
      throw new Error(fehlerSatz(err));
    }
  }

  /* ------------------------------------------------- Fassungen */

  /** ‹ 2/3 › mit Namen der Fassung, Vergleichen, Wiederherstellen. */
  function fassungsLeiste(m, u, fs) {
    const versionen = Array.isArray(m.data.versionen) ? m.data.versionen : [];
    const n = versionen.length;
    const zeige = (i) => {
      u.fassung = i === fassungInhalt(m).version ? null : i;
      u.vergleich = null;
      neuZeichnen(m.id);
    };
    const name = fassungsName(versionen[fs.version]);
    return h('div.cv-fassungen', { role: 'group', 'aria-label': 'Fassungen dieser Antwort' },
      h('button.cv-aktion', {
        type: 'button', title: 'Vorige Fassung', 'aria-label': 'Vorige Fassung', disabled: fs.version <= 0,
        onClick: (e) => { e.stopPropagation(); zeige(fs.version - 1); },
      }, icon(SYMBOL_ZURUECK)),
      h('span.cv-fassungen__stand', { title: name }, text(`${fs.version + 1}/${n}`), h('span.cv-fassungen__name', null, text(` · ${name}`))),
      h('button.cv-aktion', {
        type: 'button', title: 'Nächste Fassung', 'aria-label': 'Nächste Fassung', disabled: fs.version >= n - 1,
        onClick: (e) => { e.stopPropagation(); zeige(fs.version + 1); },
      }, icon(SYMBOL_PFEIL)),
      aktion(SYMBOL_VERGLEICH, u.vergleich ? 'Vergleich schließen' : 'Vergleichen', () => {
        u.vergleich = u.vergleich ? null : { von: fs.version > 0 ? fs.version - 1 : (n > 1 ? 1 : 0) };
        neuZeichnen(m.id);
      }, { gedrueckt: !!u.vergleich, klasse: cx({ 'is-an': !!u.vergleich }) }),
      !fs.aktiv && !(s && s.lauf) ? h('button.btn.btn--small.btn--accent', {
        type: 'button',
        onClick: (e) => { e.stopPropagation(); fassungWaehlen(m, fs.version); },
      }, text('Wiederherstellen')) : null);
  }

  /** Eine Fassung wieder aktiv machen (PATCH …/version). */
  async function fassungWaehlen(m, version) {
    if (!s) return;
    try {
      const r = await api.patch(`/chats/${encodeURIComponent(s.chatId)}/messages/${encodeURIComponent(m.id)}/version`, { version });
      if (r && r.record) einsetzen(s, r.record);
      const u = uiVon(m.id);
      u.fassung = null;
      u.vergleich = null;
      neuZeichnen(m.id);
    } catch (err) {
      ctx.toast(`Fassung nicht gewechselt: ${fehlerSatz(err)}`, 'error');
    }
  }

  /** Wortweiser Unterschied zweier Fassungen (web/lib/antwort-hilfen.js, LCS). */
  function vergleichKarte(m, u, fs) {
    const versionen = Array.isArray(m.data.versionen) ? m.data.versionen : [];
    const von = Math.max(0, Math.min(versionen.length - 1, u.vergleich.von));
    // Verglichen wird, was man liest: Bausteine als ihre Text-Fassung, nicht als JSON.
    const alt = von === fs.version ? '' : markdownOhneUi(String((versionen[von] || {}).inhalt || ''));
    const neu = markdownOhneUi(fs.inhalt);
    const diff = wortUnterschied(alt, neu);
    const box = h('div.cv-vergleich', { role: 'region', 'aria-label': 'Vergleich zweier Fassungen' });
    const kopf = h('div.cv-vergleich__kopf', null,
      h('span.cv-vergleich__titel', null, text(`Fassung ${fs.version + 1} gegenüber`)),
      h('span.cv-vergleich__wahl', null, versionen.map((v, i) => (i === fs.version ? null : h('button.cv-vergleich__chip', {
        type: 'button',
        class: cx({ 'is-an': i === von }),
        'aria-pressed': String(i === von),
        onClick: (e) => { e.stopPropagation(); u.vergleich = { von: i }; neuZeichnen(m.id); },
      }, text(`${i + 1} · ${fassungsName(v)}`))))),
      h('span.cv-vergleich__zahlen', null, text(diff.gleich ? 'kein Unterschied' : `${diff.weg} ${diff.weg === 1 ? 'Wort' : 'Wörter'} weg · ${diff.neu} neu`)),
      h('button.cv-aktion', {
        type: 'button', title: 'Vergleich schließen', 'aria-label': 'Vergleich schließen',
        onClick: (e) => { e.stopPropagation(); u.vergleich = null; neuZeichnen(m.id); },
      }, icon(SYMBOL_SCHLIESSEN)));
    const textBox = h('div.cv-vergleich__text', null, diff.teile.map((t) => {
      if (t.art === 'weg') return h('del.cv-vergleich__weg', null, text(t.text));
      if (t.art === 'neu') return h('ins.cv-vergleich__neu', null, text(t.text));
      return text(t.text);
    }));
    box.append(kopf, textBox);
    return box;
  }

  /* ---------------------------------------- Neu erstellen, Umwandeln */

  function neuMenue(anker, m) {
    menue({
      anker,
      titel: 'Neu erstellen',
      eintraege: NEU_VARIANTEN.map((v) => ({ label: v.label, id: v.variante || 'neu', aktion: () => neuAntworten(v.variante, m) })),
    });
  }

  function umwandelnMenue(anker, m) {
    const eintrag = (u) => (u.sprache
      ? {
        label: u.label,
        id: u.anweisung,
        untermenue: SPRACHEN.map((sp) => ({ label: sp.name, aktion: () => umwandeln(m, { anweisung: u.anweisung, sprache: sp.ziel }) })),
      }
      : { label: u.label, id: u.anweisung, aktion: () => umwandeln(m, { anweisung: u.anweisung }) });
    menue({
      anker,
      titel: 'Umwandeln',
      eintraege: [
        { gruppe: 'Text' },
        ...UMWANDELN.filter((u) => u.gruppe === 'text').map(eintrag),
        { gruppe: 'Darstellung' },
        ...UMWANDELN.filter((u) => u.gruppe === 'form').map(eintrag),
      ],
    });
  }

  /**
   * Eine Antwort umwandeln (neue Fassung, ohne Werkzeuge). Mit `auswahl`
   * nur die markierte Stelle; findet der Server sie nicht eindeutig, wird
   * die KI stattdessen mit dem Zitat gefragt -- der Nutzer bekommt so in
   * jedem Fall, was er wollte.
   */
  async function umwandeln(m, body) {
    if (!s || s.lauf) return false;
    const u = uiVon(m.id);
    u.fassung = null;
    u.vergleich = null;
    const alt = String(m.data.content || '');
    try {
      await strom(s, api, `/chats/${encodeURIComponent(s.chatId)}/messages/${encodeURIComponent(m.id)}/umwandeln`, body);
      // `fertig` hat den Satz in der Sitzung ersetzt -- `m` ist der alte.
      if (body.auswahl) stelleHervorheben(nachricht(s, m.id) || m, alt);
      return true;
    } catch (err) {
      if (err && err.code === 'AUSWAHL_NICHT_GEFUNDEN' && body.auswahl) {
        return senden(stellenAuftrag(body.anweisung, body.auswahl, body.sprache));
      }
      if (nichtVerbunden(err)) claudeAus(err);
      else ctx.toast(`Nicht umgewandelt: ${fehlerSatz(err)}`, 'error');
      return false;
    }
  }

  /**
   * Die geaenderte Stelle kurz hervorheben, damit man sieht, was neu ist.
   * Der Wunsch liegt im Zustand der Nachricht (nicht im DOM): Die Nachricht
   * wird nach dem Strom noch ein paarmal neu gebaut, und jeder Neubau setzt
   * die Klasse wieder (`stelleMarkieren`), bis die Zeit um ist.
   */
  function stelleHervorheben(m, alt) {
    const st = geaenderteStelle(alt, String(m.data.content || ''));
    const suche = lesbar(st.text).toLowerCase();
    if (!suche) return;
    const u = uiVon(m.id);
    u.hervorheben = { suche, bis: Date.now() + 2600 };
    neuZeichnen(m.id);
    setTimeout(() => {
      if (u.hervorheben && u.hervorheben.suche === suche) {
        u.hervorheben = null;
        neuZeichnen(m.id);
      }
    }, 2700);
  }

  /** Beim Aufbau: den Absatz mit der geaenderten Stelle markieren. */
  function stelleMarkieren(blase, u) {
    const hv = u.hervorheben;
    if (!hv || hv.bis < Date.now()) return;
    const kandidaten = [...blase.querySelectorAll('.cv-md p, .cv-md li, .cv-md td, .cv-md th, .cv-md h2, .cv-md h3, .cv-md h4, .cv-md blockquote')];
    const passt = (el, n) => el.textContent.replace(/\s+/g, ' ').toLowerCase().includes(hv.suche.slice(0, n));
    const treffer = kandidaten.find((el) => passt(el, 80)) || kandidaten.find((el) => passt(el, 24));
    if (treffer) treffer.classList.add('is-geaendert');
  }

  /* ------------------------------------------- Markierter Text */

  /**
   * Was mit markiertem Text in einer Antwort passiert: Kuerzen, Umschreiben,
   * Uebersetzen und Verbessern aendern nur die Stelle (Umwandeln mit
   * `auswahl`); Erklaeren und Zusammenfassen stellen eine neue Frage mit dem
   * Zitat; "Frage dazu" legt das Zitat ins Eingabefeld.
   */
  function stellenAktion(id, info, wert) {
    const m = s ? nachricht(s, info.messageId) : null;
    const a = STELLEN_AKTIONEN.find((x) => x.id === id);
    if (!m || !a) return;
    try { window.getSelection().removeAllRanges(); } catch { /* egal */ }
    if (a.art === 'stelle') {
      umwandeln(m, { anweisung: id, sprache: wert, auswahl: info.text });
    } else if (a.art === 'frage') {
      senden(stellenFrage(id, info.text));
    } else {
      feld.value = `${zitat(info.text)}\n\n`;
      groesseAnpassen();
      aktualisiereEingabe();
      feld.focus();
      feld.setSelectionRange(feld.value.length, feld.value.length);
    }
  }

  const markierung = auswahlMenue({
    wurzel: verlauf,
    pruefen: (range) => {
      const c = range.commonAncestorContainer;
      const el = c.nodeType === 1 ? c : c.parentElement;
      if (!el) return null;
      const msg = el.closest('.cv-msg--bot');
      // Nur Text einer Antwort -- nicht Bausteine, Code, Fragen oder die Leiste.
      if (!msg || !el.closest('.cv-md') || el.closest('.bs, .md-code, .cv-code, .sk-lauf, .cv-frage, .cv-abschnitt__frage')) return null;
      const m = s ? nachricht(s, msg.dataset.id) : null;
      if (!m || (s && s.lauf)) return null;
      const t = String(window.getSelection() || '').trim();
      if (t.length < 2 || t.length > 4000) return null;
      return { messageId: m.id, text: t };
    },
    eintraege: () => STELLEN_AKTIONEN.map((a) => (a.sprache
      ? { id: a.id, label: a.label, untermenue: SPRACHEN.map((sp) => ({ label: sp.name, wert: sp.ziel })) }
      : { id: a.id, label: a.label })),
    beiAktion: stellenAktion,
  });

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

  /** Ein erledigter Schritt, in der Vergangenheit erzaehlt ("Gesucht: …", "Termin eingetragen · …"). */
  function erledigtZeile(a) {
    const r = rolle(a.rolle);
    const fehler = a.zustand === 'fehler';
    const w = Array.isArray(a.wirkung) && a.wirkung.length ? wirkungZeilen(a.wirkung)[0] : null;
    let satz;
    if (w) {
      satz = w.detail ? `${w.label} · ${w.detail}` : w.label;
    } else if (a.rolle === 'recherche') {
      const q = /^Sucht:\s*(.*)$/.exec(a.titel || '');
      const l = /^Liest:\s*(.*)$/.exec(a.titel || '');
      if (q) satz = `Gesucht: „${q[1]}“${a.ergebnis && !fehler ? ` · ${a.ergebnis}` : ''}`;
      else if (l) satz = a.ergebnis && /^Gelesen:/.test(a.ergebnis) ? a.ergebnis : `Gelesen: ${l[1]}`;
      else satz = 'Im Internet gesucht';
    } else if (a.rolle === 'wissen') {
      const q = /^Sucht in deinem Wissen:\s*(.*)$/.exec(a.titel || '');
      const l = /^Liest:\s*(.*)$/.exec(a.titel || '');
      if (q) satz = `In deinem Wissen gesucht: ${q[1]}${a.ergebnis && !fehler ? ` · ${a.ergebnis}` : ''}`;
      // Ging das Lesen nicht, war es auch nicht „gelesen“.
      else if (l) satz = fehler ? `Nicht gelesen: ${l[1]}` : `Gelesen: ${l[1]}`;
      else satz = a.titel || r.name;
    } else {
      satz = `${a.titel || r.name}${a.ergebnis && !fehler ? ` · ${a.ergebnis}` : ''}`;
    }
    if (fehler && a.ergebnis) satz += ` · ${a.ergebnis}`;
    return h('p.cv-live.is-fertig', { class: cx({ 'is-fehler': fehler }), 'data-rolle': a.rolle || '' },
      h('span.cv-live__symbol', { 'aria-hidden': 'true' }, icon(fehler ? I.alert : SYMBOL_ERLEDIGT)),
      h('span.cv-live__text', null, text(satz)));
  }

  /**
   * Die Liste waehrend der Antwort: jeder Agent dieses Zuges in der
   * Reihenfolge, in der er ansprang. Die Planung, die auf eine Rueckfrage
   * wartet, zeigt ihre eigene Karte und steht hier nicht.
   */
  function fortschritt(d, agenten, fragen, inhalt) {
    const denkt = !!(d.denken && String(d.denken).trim());
    const frageOffen = fragen.some((f) => f.zustand === 'offen');
    const aufFrage = (a) => a.rolle === 'planung' && frageOffen && a.zustand === 'laeuft';
    const zeilen = [];
    for (const a of agenten) {
      if (aufFrage(a)) continue;
      zeilen.push(a.zustand === 'laeuft' ? liveZeile(a) : erledigtZeile(a));
    }
    const arbeitet = agenten.some((a) => a.zustand === 'laeuft' && !aufFrage(a));
    if (!arbeitet && !frageOffen) {
      if (inhalt.trim()) {
        zeilen.push(h('p.cv-live.cv-live--schreibt', null,
          h('span.cv-live__symbol', { 'aria-hidden': 'true' }, icon(SYMBOL_STIFT)),
          h('span.cv-live__text', null, text('Schreibt die Antwort …')),
          h('span.dot.dot--accent.dot--live', { 'aria-hidden': 'true' })));
      } else if (!denkt) {
        // Mit Gedankengang sagt es dessen Zeile ("Denkt nach …", 1.).
        zeilen.push(h('p.cv-live', null, h('span.dot.dot--accent.dot--live'), h('span.cv-live__text', null, text('Denkt nach …'))));
      }
    }
    return zeilen.length ? h('div.cv-fortschritt', null, zeilen) : null;
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
          if (z.href) aktionen.appendChild(h('a.btn.btn--small', { href: z.href, onClick: (e) => e.stopPropagation() }, text(z.typ === 'run' ? 'Ansehen' : 'Öffnen')));
          // Ein Hintergrund-Agent aendert nichts, es gibt also nichts zurueckzunehmen.
          if (a.runId && z.typ !== 'run') {
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

  /**
   * Die Rueckfrage mitten im Zug -- gezeichnet von DERSELBEN
   * Auswahl-Komponente wie der Baustein `auswahl` (web/lib/bausteine/auswahl.js).
   * Der Unterschied liegt nur darin, wohin die Wahl geht: an /rueckfrage.
   */
  function frageKarte(m, f, aktivMoeglich) {
    const fu = frageUi(m, f);
    // Offen ist sie, solange sie die letzte Antwort ist und niemand geantwortet
    // hat; bedienbar nur, wenn gerade nichts gesendet wird.
    const offen = f.zustand === 'offen' && m.data.rueckfrageOffen && aktivMoeglich;
    const bedienbar = offen && !fu.sendet && !(s && s.lauf);
    const beantwortet = f.zustand === 'beantwortet';
    const optionen = Array.isArray(f.optionen) ? f.optionen : [];
    const teile = beantwortet ? String(f.antwort || '').split(/,\s*/).filter(Boolean) : [];
    const gewaehlt = teile.filter((t) => optionen.includes(t));
    const eigeneAntwort = beantwortet && f.antwort && !gewaehlt.length ? f.antwort : null;
    let hinweis = null;
    if (f.zustand === 'uebergangen') hinweis = 'Übergangen – du hast weitergeschrieben.';
    else if (f.zustand === 'offen' && !offen && !(s && s.lauf) && !m.data.rueckfrageOffen) hinweis = 'Nicht mehr offen.';
    const status = offen ? 'offen' : (beantwortet ? 'gesendet' : (f.zustand === 'uebergangen' ? 'uebergangen' : 'geschlossen'));
    const karte = auswahlKarte({
      frage: f.frage,
      optionen: optionen.map((t) => ({ text: t })),
      mehrfach: !!f.mehrfach,
      eigene: true,
      stil: 'knoepfe',
      // Bei einer Rueckfrage heisst der Knopf der Mehrfachwahl "Senden": die
      // Antwort geht an die KI, sie ist kein "Weiter" innerhalb der Antwort.
      knopf: 'Senden',
      status,
      gewaehlt,
      eigeneAntwort,
      sendet: fu.sendet,
      fehler: fu.fehler,
      bedienbar,
      hinweis,
      entwurf: fu,
      neuZeichnen: () => neuZeichnen(m.id),
      onWaehlen: (antwort) => frageSenden(m, f, antwort),
      key: (teil) => `frage:${f.id}:${teil}`,
      tipp: true,
      klasse: 'cv-frage__karte',
    });
    return h('div.cv-frage', { 'data-zustand': offen ? 'offen' : f.zustand, 'data-frage': f.id }, karte);
  }

  /** Tasten 1–9 auf Dokumentebene (der Fokus liegt nicht in der Karte). */
  function waehlen(m, f, label) {
    const fu = frageUi(m, f);
    if (fu.sendet) return;
    if (!f.mehrfach) {
      frageSenden(m, f, label);
      return;
    }
    const set = new Set(fu.auswahl);
    if (set.has(label)) set.delete(label);
    else set.add(label);
    fu.auswahl = (f.optionen || []).filter((o) => set.has(o));
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
      fu.auswahl = [];
    } catch (err) {
      fu.sendet = null;
      fu.fehler = fehlerSatz(err);
      if (err && err.code === 'RUECKFRAGE_ERLEDIGT') nachladen(s, api).catch(() => {});
      if (nichtVerbunden(err)) claudeAus(err);
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
        // Ein Eintrag aus dem eigenen Wissen oeffnet sich in der App, eine Webseite im neuen Tab.
        h('a.cv-quelle', q.art === 'eintrag'
          ? { href: q.url, title: q.titel || '', dataset: { art: 'eintrag' }, onClick: (e) => e.stopPropagation() }
          : { href: q.url, target: '_blank', rel: 'noopener noreferrer', title: q.url, onClick: (e) => e.stopPropagation() },
        h('span.cv-quelle__nr', null, text(`${i + 1}`)),
        h('span.cv-quelle__titel', null, text(q.titel || q.url)),
        h('span.cv-quelle__host', null, text(q.art === 'eintrag' ? eintragArt(q.typ) : hostVon(q.url))))))));
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
      // Kein Guthaben bei Anthropic: der Weg zu Gemini (kostenlos) steht gleich daneben.
      const zuGemini = d.error.code === 'CLAUDE_GUTHABEN' && letzte
        ? h('button.btn.btn--accent.btn--small', {
          type: 'button',
          onClick: (e) => {
            e.stopPropagation();
            geminiAngebot = true;
            obenKey = null;
            plane();
          },
        }, h('span', null, text('Kostenlos mit Gemini weiter')))
        : null;
      out.push(h('div.cv-status.cv-status--fehler', { role: 'alert' },
        icon(I.alert), h('span', null, text(d.error.message || 'Die Antwort ist gescheitert.')), zuGemini, nochmal));
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
      'aria-haspopup': extra.menue ? 'menu' : null,
      'aria-expanded': extra.menue ? 'false' : null,
      onClick: (e) => {
        e.stopPropagation();
        fn(e.currentTarget);
      },
    }, icon(markup), extra.menue ? h('span.cv-aktion__pfeil', { 'aria-hidden': 'true' }, icon(SYMBOL_RUNTER)) : null);
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

  /**
   * Die Leiste unter einer Antwort (docs/ANTWORT-BAUSTEINE.md 6): Kopieren ·
   * Neu erstellen ▾ · Umwandeln ▾ · Vorlesen · Fassungen. Kopiert und
   * vorgelesen wird die Text-Fassung der Bausteine, nie ihr JSON.
   */
  function antwortAktionen(m, letzte, fs) {
    const u = uiVon(m.id);
    const inhalt = () => markdownOhneUi(fs.inhalt);
    const ruhig = !(s && s.lauf);
    const liest = liestGerade() === m.id;
    return h('div.cv-aktionen', { role: 'toolbar', 'aria-label': 'Antwort' },
      kopierAktion(inhalt, 'Antwort kopieren'),
      letzte && ruhig ? aktion(SYMBOL_NEU, 'Neu erstellen', (k) => neuMenue(k, m), { menue: true }) : null,
      ruhig && fs.inhalt.trim() ? aktion(SYMBOL_ZAUBER, 'Umwandeln', (k) => umwandelnMenue(k, m), { menue: true }) : null,
      sprechenMoeglich() && fs.inhalt.trim()
        ? aktion(SYMBOL_LAUT, liest ? 'Vorlesen beenden' : 'Vorlesen', () => {
          if (liest) vl().stopp();
          else vorlesenStarten(m, fs.inhalt);
        }, { klasse: liest ? 'is-an' : '', gedrueckt: liest })
        : null,
      fs.anzahl > 1 ? fassungsLeiste(m, u, fs) : null);
  }

  /* ------------------------------------------------------ Vorlesen */

  function vorlesenStarten(m, inhalt) {
    const v = vl();
    if (!v) return;
    if (!v.start(m.id, vorleseText(inhalt))) ctx.toast('Hier gibt es nichts vorzulesen.', 'info');
  }

  /**
   * Der kleine Spieler unter der Antwort, die gerade vorgelesen wird:
   * ▶/⏸, Tempo, "Satz 3 von 12", Beenden. Er zeichnet sich selbst neu,
   * wenn der Vorleser weiterliest -- die Antwort bleibt dabei stehen (ein
   * Neubau je Satz verloere eine Markierung, einen offenen Reiter …).
   */
  function spielerZeile() {
    const v = vl();
    const knopf = h('button.cv-spieler__knopf', {
      type: 'button',
      onClick: (e) => {
        e.stopPropagation();
        if (v.zustand().spielt) v.pause();
        else v.weiter();
      },
    });
    const tempo = h('button.cv-spieler__tempo', {
      type: 'button',
      title: 'Tempo ändern',
      onClick: (e) => {
        e.stopPropagation();
        v.naechstesTempo();
      },
    });
    const stand = h('span.cv-spieler__stand');
    const satz = h('span.cv-spieler__satz', { hidden: true });
    const zu = h('button.cv-spieler__zu', {
      type: 'button',
      title: 'Vorlesen beenden',
      'aria-label': 'Vorlesen beenden',
      onClick: (e) => {
        e.stopPropagation();
        v.stopp();
      },
    }, icon(SYMBOL_SCHLIESSEN));
    const zeile = h('div.cv-spieler', { role: 'group', 'aria-label': 'Vorlesen' }, knopf, tempo, stand, satz, zu);
    let artVorher = null;
    zeile._aktualisieren = (z) => {
      const art = z.spielt ? 'pause' : 'weiter';
      if (art !== artVorher) {
        artVorher = art;
        knopf.replaceChildren(icon(z.spielt ? SYMBOL_PAUSE : SYMBOL_ABSPIELEN));
        knopf.setAttribute('aria-label', z.spielt ? 'Pause' : 'Weiterlesen');
        knopf.title = z.spielt ? 'Pause' : 'Weiterlesen';
      }
      tempo.textContent = tempoText(z.tempo);
      tempo.setAttribute('aria-label', `Tempo ${tempoText(z.tempo)} – ändern`);
      stand.textContent = z.anzahl ? `Satz ${z.index + 1} von ${z.anzahl}` : '';
      // Kann der Browser den Satz im Text nicht hervorheben, steht er hier.
      satz.textContent = z.satz || '';
      satz.hidden = markeSitzt || !z.satz;
    };
    zeile._aktualisieren(v.zustand());
    return zeile;
  }

  /** Den gerade gelesenen Satz im Text der Antwort hervorheben. */
  function vorleseMarke(z) {
    if (!hervorhebenMoeglich()) {
      markeSitzt = false;
      return;
    }
    if (!z || !z.id || !z.satz) {
      hervorheben(null);
      markeSitzt = false;
      return;
    }
    const blase = verlauf.querySelector(`.cv-msg[data-id="${CSS.escape(z.id)}"] .cv-bubble`);
    // Nur im Text der Antwort -- nicht im zugeklappten Gedankengang, der oft
    // dieselben Saetze vorformuliert.
    const range = blase ? stelleImText(blase, z.satz, { nur: '.cv-md' }) : null;
    hervorheben(range);
    markeSitzt = !!range;
  }

  /** Was der Vorleser meldet: anderer Satz, Pause, Tempo, Ende. */
  function vorleseAbo(z) {
    if (!lebt) return;
    if (z.id !== vorleseVorher) {
      // Eine Antwort bekommt ihren Spieler, die vorige verliert ihn.
      if (vorleseVorher) neuZeichnen(vorleseVorher);
      if (z.id) neuZeichnen(z.id);
      vorleseVorher = z.id;
    }
    vorleseMarke(z);
    for (const zeile of verlauf.querySelectorAll('.cv-spieler')) if (zeile._aktualisieren) zeile._aktualisieren(z);
  }

  /** Nach einer gesprochenen Frage: die fertige Antwort vorlesen. */
  function antwortVorlesen() {
    const id = letzteAntwortId();
    const m = id && s ? nachricht(s, id) : null;
    if (!m || m.data.status === 'failed' || !String(m.data.content || '').trim()) return;
    vorlesenStarten(m, m.data.content);
  }

  /**
   * Safari spricht nur, wenn das erste Sprechen aus einem Tippen kam. Die
   * Antwort auf eine gesprochene Frage kommt Sekunden spaeter -- deshalb
   * beim Tippen aufs Mikrofon einmal still "sprechen".
   */
  function vorlesenFreischalten() {
    if (!sprechenMoeglich() || liestGerade()) return;
    try {
      const u = new window.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch { /* dann eben nicht */ }
  }

  /**
   * Auf dem iPad gibt es kein Ueberfahren: Antippen zeigt die Leiste. Nur
   * die Klasse wechselt -- ein Neuaufbau wuerde eine Markierung im Text
   * zerstoeren, und mit der Maus ist ein Klick meist genau das: markieren.
   * Bausteine, Tabellen, Diagramme und Ausgaben sind ausgenommen: ein Tippen
   * dort bedient sie.
   */
  function antippen(e, id) {
    if (e.target.closest('button, a, input, textarea, select, summary, details, .bs, .tb, .dg, .cv-code, .sk-lauf, .cv-vergleich, .cv-abschnitt__frage')) return;
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

  /** CLAUDE_, GEMINI_ oder KI_NICHT_VERBUNDEN: die Verbinden-Karte uebernimmt. */
  function nichtVerbunden(err) {
    return !!(err && /_NICHT_VERBUNDEN$/.test(String(err.code || '')));
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

  /** Textdateien gehen als Text mit (in einem Zaun, der laenger ist als jeder darin). */
  function inhaltMitAnhaengen(textInhalt, texte) {
    let out = textInhalt;
    for (const a of texte) {
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
    if (legtAb || sendetGerade) return;
    // Laeuft das Mikrofon noch: erst fertig sprechen lassen, dann geht es von selbst.
    if (sprechen) {
      nachDemSprechenSenden();
      return;
    }
    const roh = feld.value.trim();
    const mitgeschickt = [...anhaenge];
    const dateien = mitgeschickt.filter((a) => a.art === 'bild' || a.art === 'pdf');
    const texte = mitgeschickt.filter((a) => a.art === 'text');
    if (!roh && !mitgeschickt.length) return;
    const inhalt = inhaltMitAnhaengen(roh, texte);
    if (inhalt.length > MAX_ZEICHEN) {
      ctx.toast(`Die Nachricht ist zu lang (${inhalt.length.toLocaleString('de-DE')} Zeichen, erlaubt sind ${MAX_ZEICHEN.toLocaleString('de-DE')}).`, 'error');
      return;
    }
    await senden(inhalt, { ausFeld: true, dateien, mitgeschickt });
  }

  /**
   * Bilder und PDF ablegen (POST …/anhaenge), bevor die Nachricht geht: sie
   * nimmt nur ihre Kennungen mit. Was schon in DIESEM Chat abgelegt wurde
   * (ein frueherer, gescheiterter Versuch), wird nicht noch einmal geschickt.
   * @returns {Promise<string[]>} die Kennungen, in der Reihenfolge der Dateien
   */
  async function dateienAblegen(dateien) {
    const ids = [];
    for (const a of dateien) {
      if (a.id && a.chatId === s.chatId) {
        ids.push(a.id);
        continue;
      }
      a.laedt = true;
      zeichneAnhaenge();
      try {
        const daten = await alsBase64(a.datei);
        const r = await api.post(`/chats/${encodeURIComponent(s.chatId)}/anhaenge`, { name: a.name, mime: a.mime, daten }, { timeoutMs: 180000 });
        const neu = r && r.anhang;
        if (!neu || !neu.id) throw new Error('Der Server hat die Datei nicht angenommen.');
        a.id = neu.id;
        a.chatId = s.chatId;
        ids.push(neu.id);
      } catch (err) {
        throw new Error(`„${a.name}“: ${fehlerSatz(err)}`);
      } finally {
        a.laedt = false;
      }
    }
    zeichneAnhaenge();
    return ids;
  }

  /**
   * Eine Nachricht senden. Der neue Chat entsteht erst hier, mit der ersten
   * Nachricht -- nie auf Vorrat. Ist Claude nicht verbunden, bleibt der Text
   * im Feld, und die Verbinden-Karte uebernimmt. `dateien` sind Bilder und
   * PDF aus dem Eingabefeld; mit ihnen darf der Text leer sein.
   * `mitgeschickt`: alles, was dafuer im Eingabefeld angehaengt war -- es
   * verlaesst das Feld, sobald die Nachricht zu sehen ist, und kommt zurueck,
   * wenn sie nicht ankam.
   */
  async function senden(inhalt, { ausFeld = false, dateien = [], mitgeschickt = [] } = {}) {
    const t = String(inhalt || '').trim();
    if ((!t && !dateien.length) || (s && s.lauf) || legtAb || sendetGerade) return false;
    if (claude && claude.verbunden === false) {
      wartet = ausFeld ? AUS_DEM_FELD : t;
      obenKey = null;
      plane();
      const f = container.querySelector('.cv-verbinden input');
      if (f) f.focus();
      return false;
    }
    // Ab hier ist sie unterwegs -- schon bevor der neue Chat steht. Ein
    // zweites Enter legte sonst einen zweiten Chat mit denselben Dateien an.
    sendetGerade = true;
    try {
      return await sendenJetzt(t, { ausFeld, dateien, mitgeschickt });
    } finally {
      sendetGerade = false;
      if (lebt) aktualisiereEingabe();
    }
  }

  async function sendenJetzt(t, { ausFeld, dateien, mitgeschickt }) {
    // Wurde die Frage gesprochen, wird die Antwort vorgelesen.
    const warGesprochen = ausFeld && gesprochen;
    const vorlesenDanach = warGesprochen && sprechenMoeglich();
    const feldVorher = feld.value;
    const zurueckInsFeld = () => {
      if (!ausFeld) return;
      feld.value = feldVorher;
      gesprochen = warGesprochen;
      groesseAnpassen();
      aktualisiereEingabe();
    };
    if (ausFeld) {
      feld.value = '';
      gesprochen = false;
      groesseAnpassen();
      speicher('loeschen', chatId || 'neu');
    }
    if (!chatId) {
      try {
        const res = await api.post('/chats', modusVorgemerkt === 'wissen' ? { modus: 'wissen' } : {});
        chatId = res && res.record ? res.record.id : null;
        if (!chatId) throw new Error('Der Server hat keinen Chat angelegt.');
        neuAngelegt = true;
        verbinden(sitzungFuer(chatId));
        s.geladen = true;
        s.modus = (res.record.data && res.record.data.modus) || 'normal';
        ctx.replaceRoute(`#/chat?id=${encodeURIComponent(chatId)}`);
      } catch (err) {
        zurueckInsFeld();
        ctx.toast(`Der Chat ließ sich nicht anlegen: ${fehlerSatz(err)}`, 'error');
        return false;
      }
    }
    let ids = [];
    if (dateien.length) {
      legtAb = true;
      aktualisiereEingabe();
      try {
        ids = await dateienAblegen(dateien);
      } catch (err) {
        zurueckInsFeld();
        ctx.toast(`Nicht gesendet: ${err.message}`, 'error');
        return false;
      } finally {
        legtAb = false;
        // Auch nach einem Fehler: "wird abgelegt …" weg, Entfernen geht wieder.
        zeichneAnhaenge();
      }
    }
    // Sofort zu sehen, bevor der Server antwortet; `nutzer` ersetzt sie.
    s.nachrichten.push({
      id: `lokal_${Date.now()}`,
      _lokal: true,
      createdAt: new Date().toISOString(),
      data: {
        role: 'user',
        content: t,
        ...(dateien.length ? { anhaenge: dateien.map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.groesse, vorschau: a.url })) } : {}),
      },
    });
    // Was mitging, verlaesst jetzt das Eingabefeld. Was waehrend der Antwort
    // dazukommt, bleibt dort fuer die naechste Nachricht.
    if (mitgeschickt.length) {
      anhaenge = anhaenge.filter((a) => !mitgeschickt.includes(a));
      zeichneAnhaenge();
    }
    folgen = true;
    plane();
    let fertig = false;
    try {
      const body = { inhalt: t };
      if (ids.length) body.anhaenge = ids;
      fertig = await strom(s, api, `/chats/${encodeURIComponent(s.chatId)}/messages`, body);
    } catch (err) {
      s.nachrichten = s.nachrichten.filter((m) => !m._lokal);
      zurueckInsFeld();
      if (mitgeschickt.length) {
        // Nicht angekommen: die Anhaenge zurueck ins Feld (schon abgelegte
        // gehen beim naechsten Versuch nicht noch einmal hoch).
        anhaenge = [...mitgeschickt.filter((a) => !anhaenge.includes(a)), ...anhaenge];
        zeichneAnhaenge();
      }
      if (err && (nichtVerbunden(err) || err.code === 'PIN_NOETIG')) {
        wartet = ausFeld ? AUS_DEM_FELD : t;
        claudeAus(err);
        if (neuAngelegt && !s.nachrichten.length && !ids.length) {
          // Ein leerer Chat, den niemand wollte, soll nicht in "Zuletzt" stehen.
          // (Mit abgelegten Dateien bleibt er: sie gehoeren zu ihm, und der
          // naechste Versuch nimmt sie von dort.)
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
        letzterSendeFehler = fehlerSatz(err);
        ctx.toast(`Nicht gesendet: ${letzterSendeFehler}`, 'error');
      }
      plane();
      return false;
    }
    if (neuAngelegt) {
      neuAngelegt = false;
      titelHolen();
    }
    if (fertig) {
      // Die Nachricht steht jetzt mit den Dateien vom Server da; die
      // Vorschauen aus dem Eingabefeld braucht niemand mehr.
      for (const a of mitgeschickt) {
        if (!a.url) continue;
        URL.revokeObjectURL(a.url);
        vorschauen.delete(a.url);
      }
    }
    fokusNachAntwort();
    // Wer inzwischen woanders ist, bekommt nichts vorgelesen (dort gibt es keinen Spieler).
    if (vorlesenDanach && lebt) antwortVorlesen();
    return true;
  }

  /**
   * Die letzte Antwort neu erstellen -- als neue Fassung, die alte bleibt
   * waehlbar. `variante`: kuerzer, einfacher, detaillierter, kreativer,
   * anders oder null (einfach noch einmal).
   */
  async function neuAntworten(variante = null, m = null) {
    if (!s || s.lauf) return;
    if (m) {
      const u = uiVon(m.id);
      u.fassung = null;
      u.vergleich = null;
    }
    folgen = true;
    try {
      const body = {};
      if (variante) body.variante = variante;
      if (m) body.messageId = m.id;
      await strom(s, api, `/chats/${encodeURIComponent(s.chatId)}/neu-antworten`, body);
      fokusNachAntwort();
    } catch (err) {
      if (nichtVerbunden(err)) claudeAus(err);
      else ctx.toast(`Nicht neu erstellt: ${fehlerSatz(err)}`, 'error');
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
      const erste = verlauf.querySelector(`[data-frage="${CSS.escape(offen.f.id)}"] .bs-option, [data-frage="${CSS.escape(offen.f.id)}"] button`);
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
    // Waehrend der Aufnahme heisst [Senden]: umschreiben und gleich senden.
    const bereit = !!(feld.value.trim() || anhaenge.length || (sprechen && sprechen.weg === 'aufnahme' && sprechen.zustand === 'hoert'));
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
    sendKnopf.disabled = laeuft ? !!s.lauf.stoppt : (!bereit || legtAb);
    // Das Mikrofon: nur, wenn einer der beiden Wege hier geht (oder gerade laeuft).
    mikro.hidden = !sprechen && !sprechWeg({ transkribieren: !!(claude && claude.transkribieren), nurAufnahme });
    zeichneSchnell();
  }

  offs.push(on(feld, 'input', () => {
    // Wer das Feld leert, faengt neu an: dann ist nichts mehr gesprochen.
    if (!feld.value.trim()) gesprochen = false;
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
    // Waehrend das Mikrofon zuhoert, heisst Enter "fertig gesprochen".
    if (sprechen) {
      sprechenBeenden();
      return;
    }
    absenden();
  }));
  // Ein Bild aus der Zwischenablage (Bildschirmfoto) wird ein Anhang.
  offs.push(on(feld, 'paste', (e) => {
    const cd = e.clipboardData;
    const dateien = cd ? [...(cd.files || [])] : [];
    if (!dateien.length) return;
    // Zellen aus Excel oder Numbers kommen als Text UND als Bild davon: dann
    // gilt der Text. Nur eine kopierte Datei (Text = ihr Name) wird Anhang.
    let roh = '';
    try { roh = String(cd.getData('text/plain') || '').trim(); } catch { roh = ''; }
    if (roh && !dateien.every((d) => d.name && roh.includes(d.name))) return;
    e.preventDefault();
    dateienAufnehmen(dateien);
  }));

  const entwurfMerken = debounce(() => {
    const key = chatId || 'neu';
    if (feld.value.trim()) speicher('schreiben', key, feld.value);
    else speicher('loeschen', key);
  }, 300);

  /* ------------------------------------------------- Anhaenge */

  function zeichneAnhaenge() {
    clear(anhangZeile);
    anhangZeile.hidden = !anhaenge.length;
    anhaenge.forEach((a, i) => {
      const weg = h('button.cv-anhang__weg', {
        type: 'button',
        'aria-label': `${a.name} entfernen`,
        title: 'Entfernen',
        disabled: legtAb,
        onClick: () => {
          const [raus] = anhaenge.splice(i, 1);
          if (raus && raus.url) {
            URL.revokeObjectURL(raus.url);
            vorschauen.delete(raus.url);
          }
          zeichneAnhaenge();
        },
      }, icon(SYMBOL_SCHLIESSEN));
      const unter = a.laedt ? 'wird abgelegt …' : groesse(a.groesse);
      if (a.art === 'bild') {
        anhangZeile.appendChild(h('span.cv-anhang.cv-anhang--bild', { class: cx({ 'is-laedt': a.laedt }), 'data-art': 'bild' },
          h('img.cv-anhang__bild', { src: a.url, alt: '' }),
          h('span.cv-anhang__name', null, text(a.name)),
          h('span.cv-anhang__groesse', null, text(unter)),
          weg));
      } else if (a.art === 'pdf') {
        anhangZeile.appendChild(h('span.cv-anhang.cv-anhang--pdf', { class: cx({ 'is-laedt': a.laedt }), 'data-art': 'pdf' },
          icon(SYMBOL_PDF),
          h('span.cv-anhang__name', null, text(a.name)),
          h('span.cv-anhang__groesse', null, text(unter)),
          weg));
      } else {
        anhangZeile.appendChild(h('span.cv-anhang', { 'data-art': 'text' },
          icon(I.notes),
          h('span.cv-anhang__name', null, text(a.name)),
          h('span.cv-anhang__groesse', null, text(groesse(a.groesse))),
          weg));
      }
    });
    aktualisiereEingabe();
  }

  /**
   * Nach dem Anhaengen von Bildern oder PDF: was die KI damit tun soll, als
   * Knoepfe (lib/anhaenge.js schnellAktionen). Ein Tippen sendet genau
   * diesen Auftrag mit den Dateien. Sobald im Feld etwas steht, gehen sie
   * weg -- dann gilt, was dort steht.
   */
  let schnellKey = '';
  function zeichneSchnell() {
    const dateien = anhaenge.filter((a) => a.art === 'bild' || a.art === 'pdf');
    const zeigen = dateien.length > 0 && !feld.value.trim() && !(s && s.lauf) && !legtAb && !sprechen;
    const aktionen = zeigen ? schnellAktionen(dateien) : [];
    const key = aktionen.map((a) => a.id).join('|');
    if (key === schnellKey) return;
    schnellKey = key;
    clear(schnellZeile);
    schnellZeile.hidden = !aktionen.length;
    for (const sa of aktionen) {
      schnellZeile.appendChild(h('button.cv-schnell__knopf', {
        type: 'button',
        dataset: { id: sa.id },
        onClick: () => {
          if (legtAb || (s && s.lauf)) return;
          feld.value = sa.text;
          groesseAnpassen();
          absenden();
        },
      }, text(sa.label)));
    }
  }

  /**
   * Dateien ins Eingabefeld: Text wird gelesen (geht als Text mit), Bilder
   * und PDF bleiben Dateien, bis gesendet wird. Ein zu grosses Foto wird
   * verkleinert (lib/anhaenge.js bildVorbereiten).
   */
  async function dateienAufnehmen(dateien) {
    const abgelehnt = [];
    for (const datei of dateien) {
      const art = dateiArt(datei);
      if (!art.art) {
        abgelehnt.push(datei.name || 'Datei');
        continue;
      }
      if (art.art === 'text') {
        try {
          let inhalt = await datei.text();
          let gekuerzt = false;
          if (inhalt.length > MAX_ANHANG) {
            inhalt = inhalt.slice(0, MAX_ANHANG);
            gekuerzt = true;
          }
          anhaenge.push({ art: 'text', name: datei.name, text: inhalt, groesse: datei.size });
          if (gekuerzt) ctx.toast(`„${datei.name}“ ist sehr lang; mitgeschickt werden die ersten ${MAX_ANHANG.toLocaleString('de-DE')} Zeichen.`, 'info');
        } catch (err) {
          ctx.toast(`„${datei.name}“ ließ sich nicht lesen: ${err && err.message}`, 'error');
        }
        continue;
      }
      if (anhaenge.filter((a) => a.art !== 'text').length >= MAX_JE_NACHRICHT) {
        ctx.toast(`Höchstens ${MAX_JE_NACHRICHT} Bilder und PDFs je Nachricht.`, 'info');
        break;
      }
      const name = datei.name || (art.art === 'pdf' ? 'dokument.pdf' : 'bild');
      try {
        let fertig;
        if (art.art === 'bild') {
          fertig = await bildVorbereiten(datei, { name, mime: art.mime });
        } else {
          if (datei.size > MAX_PDF_BYTES) throw new Error(`„${name}“ ist zu groß (${mb(datei.size)} MB, erlaubt sind ${mb(MAX_PDF_BYTES)} MB).`);
          fertig = { datei, name, mime: art.mime };
        }
        if (!fertig.datei.size) throw new Error(`„${name}“ ist leer.`);
        const url = art.art === 'bild' ? URL.createObjectURL(fertig.datei) : null;
        if (url) vorschauen.add(url);
        anhaenge.push({
          art: art.art, name: fertig.name, mime: fertig.mime, groesse: fertig.datei.size, datei: fertig.datei, url, id: null, chatId: null, laedt: false,
        });
        if (fertig.mime === 'image/gif' && claude && claude.aktiv === 'gemini') ctx.toast('Gemini kann GIF-Bilder nicht lesen.', 'info');
      } catch (err) {
        ctx.toast((err && err.message) || `„${name}“ ließ sich nicht anhängen.`, 'error');
      }
    }
    if (abgelehnt.length) {
      ctx.toast(`Nicht angehängt: ${abgelehnt.join(', ')}. ${MOEGLICH}`, 'info', { timeout: 8000 });
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

  /* ---------------------------------------------- Mein Wissen */

  function modusAktiv() {
    return (s ? (s.modus || 'normal') : modusVorgemerkt) === 'wissen';
  }

  function zeichneModus() {
    const an = modusAktiv();
    modusKnopf.setAttribute('aria-pressed', String(an));
    modusKnopf.classList.toggle('is-an', an);
    formular.classList.toggle('is-wissen', an);
    feld.placeholder = an ? 'Frag dein Wissen …' : 'Nachricht eingeben …';
  }

  /** An oder aus -- fuer diesen Chat (PATCH), oder vorgemerkt fuer den neuen. */
  async function modusUmschalten() {
    const neu = modusAktiv() ? 'normal' : 'wissen';
    if (!s) {
      modusVorgemerkt = neu;
      zeichneModus();
      feld.focus();
      return;
    }
    const vorher = s.modus || 'normal';
    s.modus = neu;
    zeichneModus();
    try {
      await api.patch(`/chats/${encodeURIComponent(s.chatId)}`, { modus: neu });
    } catch (err) {
      s.modus = vorher;
      zeichneModus();
      ctx.toast(`Nicht umgeschaltet: ${fehlerSatz(err)}`, 'error');
      return;
    }
    feld.focus();
  }

  /* -------------------------------------------------- Sprechen */

  /** "0:07" */
  function minuten(sekunden) {
    const n = Math.max(0, Math.floor(sekunden));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  }

  /** Die Zeile ueber dem Eingabefeld, solange das Mikrofon an ist, und der Knopf selbst. */
  let sprechZeit = null;
  function zeichneSprechen() {
    const an = !!sprechen;
    mikro.classList.toggle('is-an', an && sprechen.zustand !== 'schreibt');
    mikro.setAttribute('aria-pressed', String(an));
    mikro.setAttribute('aria-label', an ? 'Sprechen beenden' : 'Sprechen');
    mikro.title = an ? 'Sprechen beenden' : 'Sprechen';
    mikro.disabled = !!(sprechen && sprechen.zustand === 'schreibt');
    clear(sprechZeile);
    sprechZeit = null;
    sprechZeile.hidden = !an;
    if (an) {
      if (sprechen.zustand === 'schreibt') {
        sprechZeile.append(h('span.spinner.cv-spinner', { 'aria-hidden': 'true' }), h('span.cv-sprechen__text', null, text('Schreibt um …')));
      } else {
        // Die Uhr zaehlt viermal je Sekunde: nicht vorlesen lassen (und nicht mit aufnehmen).
        sprechZeit = sprechen.weg === 'aufnahme' ? h('span.cv-sprechen__zeit', { 'aria-hidden': 'true' }, text(`${minuten(sprechen.sekunden || 0)} / ${minuten(MAX_SEKUNDEN)}`)) : null;
        // append() schriebe ein fehlendes Stueck als Wort "null" hin.
        sprechZeile.append(...[
          h('span.cv-sprechen__punkt', { 'aria-hidden': 'true' }),
          h('span.cv-sprechen__text', null, text(sprechen.zustand === 'startet' ? 'Mikrofon wird geöffnet …' : 'Ich höre zu …')),
          sprechZeit,
          h('button.btn.btn--small.cv-sprechen__fertig', { type: 'button', onClick: () => sprechenBeenden() }, text('Fertig')),
        ].filter(Boolean));
      }
    }
    aktualisiereEingabe();
  }

  /** Das Mikrofon an oder aus. */
  function sprechenUmschalten() {
    if (sprechen) {
      sprechenBeenden();
      return;
    }
    const weg = sprechWeg({ transkribieren: !!(claude && claude.transkribieren), nurAufnahme });
    if (!weg) return;
    // Wer spricht, will nicht gleichzeitig vorgelesen bekommen (das Mikrofon hoerte es mit).
    if (liestGerade()) vl().stopp();
    vorlesenFreischalten();
    if (weg === 'erkennung') erkennungLos();
    else aufnahmeLos();
  }

  /** Kann die Aufnahme (Gemini) einspringen? */
  function aufnahmeGeht() {
    return sprechWeg({ transkribieren: !!(claude && claude.transkribieren), nurAufnahme: true }) === 'aufnahme';
  }

  /** Weg 1: die Erkennung des Browsers; der Text steht schon waehrend des Sprechens im Feld. */
  function erkennungLos() {
    const vorher = feld.value;
    const sitzung = { weg: 'erkennung', zustand: 'hoert', vorher: vorher && !/\s$/.test(vorher) ? `${vorher} ` : vorher, erkannt: false, fehler: null };
    sprechen = sitzung;
    try {
      sitzung.erkennung = erkennungStarten({
        onText: (fertig, vorlaeufig) => {
          if (sprechen !== sitzung) return;
          const t = [fertig, vorlaeufig].filter(Boolean).join(' ');
          if (!t) return;
          sitzung.erkannt = true;
          feld.value = sitzung.vorher + t;
          gesprochen = true;
          groesseAnpassen();
          aktualisiereEingabe();
          entwurfMerken();
        },
        onFehler: (code) => {
          if (sprechen === sitzung) sitzung.fehler = code;
        },
        onEnde: () => {
          if (sprechen !== sitzung) return;
          sprechen = null;
          zeichneSprechen();
          const code = sitzung.fehler;
          if (code && !sitzung.erkannt && erkennungUntauglich(code)) {
            // Die Erkennung gibt es hier nur dem Namen nach: fuer diese
            // Sitzung nicht mehr anbieten. Mit Google-Schluessel wird
            // stattdessen aufgenommen; sonst verschwindet der Knopf, statt
            // bei jedem Tippen nur zu scheitern.
            nurAufnahme = true;
            if (!sitzung.danachSenden && aufnahmeGeht()) {
              aufnahmeLos();
              return;
            }
            aktualisiereEingabe();
          }
          const satz = code ? erkennungFehlerSatz(code) : null;
          if (satz) ctx.toast(satz, 'info');
          if (sitzung.danachSenden) {
            if (lebt) absenden();
            return;
          }
          if (lebt) {
            feld.focus();
            feld.setSelectionRange(feld.value.length, feld.value.length);
          }
        },
      });
    } catch {
      sprechen = null;
      nurAufnahme = true;
      if (aufnahmeGeht()) {
        aufnahmeLos();
        return;
      }
      ctx.toast('Die Spracherkennung ließ sich nicht starten.', 'error');
    }
    zeichneSprechen();
  }

  /** Weg 2: aufnehmen (WAV), Gemini schreibt um (POST /api/ki/transkribieren). */
  async function aufnahmeLos() {
    const sitzung = { weg: 'aufnahme', zustand: 'startet', sekunden: 0 };
    sprechen = sitzung;
    zeichneSprechen();
    let a;
    try {
      a = await aufnahmeStarten({
        onZeit: (sek) => {
          if (sprechen !== sitzung) return;
          sitzung.sekunden = sek;
          if (sprechZeit) sprechZeit.textContent = `${minuten(sek)} / ${minuten(MAX_SEKUNDEN)}`;
        },
        onGrenze: () => { if (sprechen === sitzung) aufnahmeFertig(sitzung); },
      });
    } catch (err) {
      if (sprechen === sitzung) sprechen = null;
      zeichneSprechen();
      const name = err && err.name;
      ctx.toast(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Das Mikrofon ist nicht erlaubt. Erlaube es oben in der Adressleiste.'
        : (name === 'NotFoundError' ? 'Kein Mikrofon gefunden.' : 'Das Mikrofon ließ sich nicht öffnen.'), 'error');
      return;
    }
    if (sprechen !== sitzung) {
      // Waehrend das Mikrofon aufging, wurde abgebrochen.
      a.abbrechen();
      return;
    }
    sitzung.aufnahme = a;
    sitzung.zustand = 'hoert';
    zeichneSprechen();
  }

  async function aufnahmeFertig(sitzung) {
    if (!sitzung || sprechen !== sitzung || sitzung.zustand !== 'hoert') return;
    sitzung.zustand = 'schreibt';
    zeichneSprechen();
    let text = '';
    try {
      const { wav, sekunden, abgebrochen } = await sitzung.aufnahme.stopp();
      // Waehrenddessen abgebrochen (Ansicht verlassen): nichts hochladen.
      if (abgebrochen || sprechen !== sitzung) return;
      if (sekunden < 0.3) throw new Error('Die Aufnahme ist zu kurz. Halte das Mikrofon an und sprich.');
      const r = await api.post('/ki/transkribieren', { audio: bytesAlsBase64(wav), ...(cid() ? { chatId: cid() } : {}) }, { timeoutMs: 90000 });
      text = String((r && r.text) || '').trim();
    } catch (err) {
      if (sprechen === sitzung) sprechen = null;
      zeichneSprechen();
      if (lebt) ctx.toast(`Nicht umgeschrieben: ${fehlerSatz(err)}`, 'error');
      return;
    }
    if (sprechen === sitzung) sprechen = null;
    zeichneSprechen();
    if (!lebt) return;
    if (!text) {
      ctx.toast('Nichts verstanden. Tippe noch einmal aufs Mikrofon und sprich.', 'info');
      return;
    }
    const vorher = feld.value;
    feld.value = `${vorher}${vorher && !/\s$/.test(vorher) ? ' ' : ''}${text}`;
    gesprochen = true;
    groesseAnpassen();
    aktualisiereEingabe();
    entwurfMerken();
    if (sitzung.danachSenden) {
      absenden();
      return;
    }
    feld.focus();
    feld.setSelectionRange(feld.value.length, feld.value.length);
  }

  /**
   * [Senden], waehrend das Mikrofon noch an ist: erst fertig sprechen lassen
   * -- die Erkennung liefert ihr letztes Wort, die Aufnahme wird
   * umgeschrieben --, dann senden. Sonst schriebe ein spaetes Ergebnis den
   * schon gesendeten Text zurueck ins leere Feld.
   */
  function nachDemSprechenSenden() {
    const sitzung = sprechen;
    if (!sitzung) return;
    sitzung.danachSenden = true;
    if (sitzung.weg === 'erkennung') {
      if (!sitzung.erkennung) {
        sprechen = null;
        zeichneSprechen();
        absenden();
        return;
      }
      sitzung.erkennung.stopp();
      // Meldet ein Browser das Ende nie, geht es trotzdem.
      setTimeout(() => {
        if (sprechen !== sitzung) return;
        sprechenAbbrechen();
        zeichneSprechen();
        if (lebt) absenden();
      }, 2500);
    } else if (sitzung.zustand === 'hoert') {
      aufnahmeFertig(sitzung);
    } else if (sitzung.zustand === 'startet') {
      sprechenAbbrechen();
      zeichneSprechen();
      absenden();
    }
    // 'schreibt': aufnahmeFertig sendet, sobald der Text da ist.
  }

  /** "Fertig": Erkennung anhalten (der Text steht schon da) bzw. Aufnahme umschreiben lassen. */
  function sprechenBeenden() {
    const sitzung = sprechen;
    if (!sitzung) return;
    if (sitzung.weg === 'erkennung') {
      if (sitzung.erkennung) sitzung.erkennung.stopp();
      else {
        sprechen = null;
        zeichneSprechen();
      }
    } else if (sitzung.zustand === 'hoert') {
      aufnahmeFertig(sitzung);
    } else if (sitzung.zustand === 'startet') {
      sprechen = null;
      zeichneSprechen();
    }
  }

  /** Beim Verlassen: alles aus, nichts wird mehr umgeschrieben. */
  function sprechenAbbrechen() {
    const sitzung = sprechen;
    sprechen = null;
    if (!sitzung) return;
    try {
      if (sitzung.erkennung) sitzung.erkennung.abbrechen();
      if (sitzung.aufnahme) sitzung.aufnahme.abbrechen();
    } catch { /* schon aus */ }
  }

  /* -------------------------------------------------- Tastatur */

  offs.push(on(document, 'keydown', (e) => {
    if (!lebt || !s || e.defaultPrevented) return;
    // Strg+Z / Strg+Umschalt+Z ausserhalb eines Bausteins: die Nachricht, in
    // der zuletzt etwas geaendert wurde (im Baustein selbst faengt er es ab).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(String(e.key || ''))) {
      if (!document.querySelector('.overlay') && root.contains(e.target instanceof Node ? e.target : null) !== false) tasteBehandeln(e, letzteNachricht());
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!/^[1-9]$/.test(e.key) && e.key !== 'Enter') return;
    if (istEingabe(e.target)) return;
    if (document.querySelector('.overlay')) return;
    const offen = offeneFrage();
    if (!offen) return;
    const { m, f } = offen;
    if (e.key === 'Enter') {
      const fu = frageUi(m, f);
      if (f.mehrfach && fu.auswahl.length && !e.target.closest('button')) {
        e.preventDefault();
        frageSenden(m, f, fu.auswahl.slice());
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
      const z = await api.get('/ki', { timeoutMs: 8000 });
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
    if (/^(claude|gemini|mistral|groq|openrouter|ovh|openai)\b/.test(typ) || typ === 'ki.anbieter' || typ === 'network.mode' || typ.startsWith('vault.')) claudeBald();
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

  // Der Vorleser meldet jeden Satz, Pause, Tempo und das Ende (vorleseAbo).
  const vorleseAbmelden = vl() ? vl().abonnieren(vorleseAbo) : null;
  if (liestGerade()) vorleseVorher = liestGerade();

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
    const entwurf = speicher('lesen', chatId || 'neu');
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
    // Der Modus ist schon bekannt, wenn der Chat in dieser Sitzung offen war.
    zeichneModus();
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
      s.modus = (info && info.record && info.record.data && info.record.data.modus) || 'normal';
      zeichneModus();
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
    markierung.weg();
    menueSchliessen();
    // Was Bausteine noch nicht gespeichert haben, jetzt -- die Ansicht geht.
    for (const z of zustaende.values()) {
      try { z.jetzt(); } catch { /* weiter */ }
    }
    // Vorlesen und Mikrofon gehoeren zu dieser Ansicht: ohne sie keine Knoepfe, also aus.
    if (vorleseAbmelden) vorleseAbmelden();
    if (vl()) vl().stopp();
    hervorheben(null);
    sprechenAbbrechen();
    leuchtkastenZu();
    for (const url of vorschauen) URL.revokeObjectURL(url);
    vorschauen.clear();
    entwurfMerken.cancel();
    claudeBald.cancel();
    for (const off of offs) {
      try { off(); } catch { /* weiter */ }
    }
    // Was im Feld stand, bleibt fuer das naechste Mal.
    const key = chatId || 'neu';
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
  // Das Bearbeiten-Feld unter Codebloecken ist das der Bausteine; seine
  // Gestaltung muss da sein, auch wenn noch kein Baustein gezeichnet wurde.
  bausteinStil('nos-bausteine', BAUSTEIN_CSS);
  bausteinStil('nos-bs-bearbeiten', BEARBEITEN_CSS);
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
.cv-verbinden__unter { margin: 0 0 10px; font-size: var(--fs-lg); font-weight: 500; letter-spacing: -0.01em; }
.cv-verbinden--kompakt .cv-verbinden__unter { font-size: var(--fs-md); }
.cv-verbinden__mehr, .cv-verbinden__andere { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--border); }
.cv-verbinden__mehr > summary, .cv-verbinden__andere > summary { cursor: pointer; list-style: none; font-size: var(--fs-sm); color: var(--fg-muted); user-select: none; }
.cv-verbinden__mehr > summary::-webkit-details-marker, .cv-verbinden__andere > summary::-webkit-details-marker { display: none; }
.cv-verbinden__mehr > summary::before, .cv-verbinden__andere > summary::before { content: '›'; display: inline-block; width: 1em; transition: transform 0.15s; }
.cv-verbinden__mehr[open] > summary::before, .cv-verbinden__andere[open] > summary::before { transform: rotate(90deg); }
.cv-verbinden__mehr[open] > summary, .cv-verbinden__andere[open] > summary { margin-bottom: 10px; }
.cv-verbinden__ohne { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.cv-verbinden__ohne > .cv-verbinden__hinweis { flex: 1 1 240px; margin: 0; }
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

/* -- Rueckfrage: die Auswahl-Komponente der Bausteine, hier mit Rahmen -- */
.cv-frage { margin: 14px 0 2px; }
.cv-frage .cv-frage__karte { padding: 16px 16px 14px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-3); }
.cv-frage[data-zustand="offen"] .cv-frage__karte { border-color: color-mix(in srgb, var(--accent) 45%, var(--border-strong)); }

/* -- Bausteine und Inseln in der Antwort -- */
.cv-insel-platz { display: none; }
.cv-md .bs { margin: 4px 0 14px; }
.cv-md .bs:last-child { margin-bottom: 0; }
.cv-md .bs--wird, .cv-md .bs-kaputt { margin: 4px 0 14px; }

/* -- Codebloecke: Leiste darunter, Bearbeiten, Ausgabe -- */
.cv-code { margin: 4px 0 14px; }
.cv-code:last-child { margin-bottom: 0; }
.cv-code .md-code { margin: 0; }
.cv-code__leiste { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin-top: 4px; }
.cv-code__knopf { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 8px; font: inherit; font-size: var(--fs-xs); color: var(--fg-subtle); background: none; border: 0; border-radius: var(--r-1); cursor: pointer; }
.cv-code__knopf svg { width: 14px; height: 14px; }
.cv-code__knopf:hover { color: var(--fg); background: var(--surface-3); }
.cv-code__knopf:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.cv-code .bs-bearbeiten { margin-top: 8px; }
.cv-code .sk-lauf { margin-top: 8px; }

/* -- "Frage dazu" an Ueberschriften -- */
.cv-md .cv-abschnitt { position: relative; display: flex; align-items: baseline; gap: 10px; }
.cv-frage-dazu { display: inline-flex; align-items: center; gap: 4px; flex: none; min-height: 24px; padding: 0 7px; font: inherit; font-size: var(--fs-xs); font-weight: 500; color: var(--fg-subtle); background: none; border: 1px solid transparent; border-radius: var(--r-full); cursor: pointer; opacity: 0; transition: opacity var(--dur-1) var(--ease); }
.cv-frage-dazu svg { width: 13px; height: 13px; }
.cv-abschnitt:hover .cv-frage-dazu, .cv-frage-dazu:focus-visible, .cv-frage-dazu[aria-expanded="true"] { opacity: 1; }
.cv-frage-dazu:hover, .cv-frage-dazu[aria-expanded="true"] { color: var(--accent-text); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); }
.cv-frage-dazu:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.cv-abschnitt__frage { display: flex; gap: 8px; margin: 4px 0 14px; }
.cv-abschnitt__frage .input { flex: 1 1 auto; min-width: 0; }

/* -- Fassungen und Vergleich -- */
.cv-fassungen { display: inline-flex; align-items: center; gap: 2px; margin-left: 6px; padding-left: 8px; border-left: 1px solid var(--border); }
.cv-fassungen__stand { padding: 0 4px; font-size: var(--fs-xs); color: var(--fg-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cv-fassungen__name { color: var(--fg-subtle); }
.cv-fassungen .btn--small { margin-left: 4px; }
.cv-fassung__hinweis { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.cv-fassung__hinweis svg { width: 16px; height: 16px; flex: none; }
.cv-msg.is-fassung .cv-aktionen { opacity: 1; }
.cv-aktion__pfeil { display: inline-grid; margin-left: -4px; }
.cv-aktion__pfeil svg { width: 12px; height: 12px; }
.cv-vergleich { width: 100%; max-width: 100%; margin-top: 8px; padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-3); }
.cv-vergleich__kopf { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 10px; font-size: var(--fs-sm); color: var(--fg-muted); }
.cv-vergleich__titel { font-weight: 500; color: var(--fg); }
.cv-vergleich__wahl { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.cv-vergleich__chip { min-height: 26px; padding: 0 9px; font: inherit; font-size: var(--fs-xs); color: var(--fg-muted); background: var(--surface-3); border: 1px solid var(--border); border-radius: var(--r-full); cursor: pointer; }
.cv-vergleich__chip.is-an { color: var(--accent-text); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: var(--accent-soft); }
.cv-vergleich__zahlen { margin-left: auto; font-size: var(--fs-xs); color: var(--fg-subtle); white-space: nowrap; }
.cv-vergleich__text { max-height: 420px; overflow: auto; font-size: var(--fs-sm); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg-muted); }
.cv-vergleich__weg { color: var(--danger); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--danger) 60%, transparent); background: var(--danger-soft); border-radius: 3px; }
.cv-vergleich__neu { color: var(--fg); text-decoration: none; background: var(--accent-soft); border-radius: 3px; }
.cv-md .is-geaendert { animation: cv-geaendert 2.6s var(--ease); border-radius: var(--r-1); }
@keyframes cv-geaendert { 0%, 60% { background: var(--accent-soft); box-shadow: 0 0 0 4px var(--accent-soft); } 100% { background: transparent; box-shadow: none; } }
@media (pointer: coarse) {
  /* Mit dem Finger: alles, was sich antippen laesst, mindestens 44 px --
     auch die Knoepfe der Tabellen und Bausteine, die im Chat stehen. */
  .cv-frage-dazu { opacity: 0.85; min-height: var(--tap-min); }
  .cv-code__knopf, .cv-vergleich__chip, .cv-fassungen .btn--small,
  .cv-msg--bot .cv-md .tb-sort, .cv-msg--bot .cv-md .bs-knopf, .cv-msg--bot .cv-md .bs-aktion,
  .cv-msg--bot .cv-md .dg .dg-umschalter, .cv-msg--bot .cv-md .dg-leg { min-height: var(--tap-min); }
  .cv-code__knopf { padding: 0 10px; }
}
@media (prefers-reduced-motion: reduce) {
  .cv-md .is-geaendert { animation: none; background: var(--accent-soft); }
  .cv-composer__mikro.is-an, .cv-sprechen__punkt { animation: none; }
}

/* -- Quellen: Verweise im Text und die Liste darunter -- */
.cv-verweis { margin: 0 1px; padding: 0 2px; font-size: 0.72em; font-weight: 600; line-height: 0; font-variant-numeric: tabular-nums; color: var(--accent-text); text-decoration: none; vertical-align: super; border-radius: 4px; }
.cv-verweis:hover { color: var(--accent-fg); background: var(--accent); }
.cv-verweis:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.cv-quellen { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.cv-quellen__titel { margin: 0 0 8px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-subtle); }
.cv-quellen__liste { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.cv-quelle { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 2px 0; font-size: var(--fs-sm); color: var(--fg-muted); text-decoration: none; border-radius: var(--r-1); }
.cv-quelle:hover .cv-quelle__titel { color: var(--fg); text-decoration: underline; text-underline-offset: 2px; }
.cv-quelle__nr { flex: none; min-width: 16px; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.cv-quelle__titel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-quelle__host { flex: none; font-size: var(--fs-xs); color: var(--fg-subtle); }

/* -- Anhaenge in der eigenen Nachricht: Bilder, PDF -- */
.cv-dateien { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: 100%; margin-bottom: 8px; }
.cv-galerie { display: flex; gap: 8px; max-width: 100%; }
.cv-galerie--viele { overflow-x: auto; scroll-snap-type: x mandatory; overscroll-behavior-x: contain; padding-bottom: 4px; }
.cv-galerie__bild { position: relative; flex: none; padding: 0; overflow: hidden; background: var(--surface-3); border: 1px solid var(--border); border-radius: var(--r-3); cursor: zoom-in; scroll-snap-align: start; }
.cv-galerie__bild img { display: block; }
/* Feste Grenzen in px (nicht %): nur so richtet sich der Knopf nach dem Bild und nicht umgekehrt. */
.cv-galerie--eins .cv-galerie__bild { max-width: 100%; }
.cv-galerie--eins .cv-galerie__bild img { width: auto; height: auto; max-width: 360px; max-height: 320px; }
.cv-galerie--viele .cv-galerie__bild img { width: 132px; height: 132px; object-fit: cover; }
.cv-galerie__bild:hover { border-color: var(--border-strong); }
.cv-galerie__bild:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.cv-galerie__fehlt { display: grid; place-items: center; width: 132px; height: 96px; padding: 8px; font-size: var(--fs-xs); color: var(--fg-subtle); text-align: center; background: var(--surface-3); border: 1px dashed var(--border-strong); border-radius: var(--r-3); overflow-wrap: anywhere; }
.cv-pdf { display: flex; align-items: center; gap: 12px; width: min(340px, 100%); padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-3); }
.cv-pdf__symbol { display: grid; place-items: center; flex: none; width: 38px; height: 38px; color: var(--accent-text); background: var(--accent-soft); border-radius: var(--r-2); }
.cv-pdf__symbol svg { width: 20px; height: 20px; }
.cv-pdf__text { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
.cv-pdf__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); color: var(--fg); }
.cv-pdf__groesse, .cv-pdf__laedt { font-size: var(--fs-xs); color: var(--fg-subtle); }

/* -- Anhaenge und Schnellaktionen am Eingabefeld -- */
.cv-anhang--bild { padding-left: 4px; }
.cv-anhang__bild { flex: none; width: 30px; height: 30px; object-fit: cover; border-radius: 8px; }
.cv-anhang--pdf svg:first-child { color: var(--accent-text); }
.cv-anhang.is-laedt { opacity: 0.72; }
.cv-schnell { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.cv-schnell__knopf { min-height: 34px; padding: 0 14px; font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-full); cursor: pointer; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }
.cv-schnell__knopf:hover { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong)); }
.cv-schnell__knopf:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }

/* -- Mein Wissen: der Schalter im Eingabefeld -- */
.cv-composer__modus { display: inline-flex; align-items: center; gap: 6px; flex: none; height: 40px; padding: 0 12px 0 10px; font: inherit; font-size: var(--fs-sm); color: var(--fg-muted); background: none; border: 1px solid transparent; border-radius: var(--r-full); cursor: pointer; white-space: nowrap; }
.cv-composer__modus svg { width: 19px; height: 19px; }
.cv-composer__modus:hover { color: var(--fg); background: var(--surface-3); }
.cv-composer__modus.is-an { color: var(--accent-text); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.cv-composer__modus:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.cv-composer.is-wissen { border-color: color-mix(in srgb, var(--accent) 40%, var(--border-strong)); }

/* -- Mikrofon -- */
.cv-composer__mikro { display: grid; place-items: center; flex: none; width: 40px; height: 40px; padding: 0; color: var(--fg-muted); background: none; border: 0; border-radius: 50%; cursor: pointer; }
.cv-composer__mikro:hover { color: var(--fg); background: var(--surface-3); }
.cv-composer__mikro svg { width: 21px; height: 21px; }
.cv-composer__mikro.is-an { color: var(--accent-fg); background: var(--accent); animation: cv-hoert 1.6s ease-in-out infinite; }
.cv-composer__mikro:disabled { cursor: default; opacity: 0.6; }
.cv-composer__mikro:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
@keyframes cv-hoert { 0%, 100% { box-shadow: 0 0 0 0 var(--accent-ring); } 50% { box-shadow: 0 0 0 7px transparent; } }
.cv-sprechen { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 6px 6px 6px 14px; font-size: var(--fs-sm); color: var(--fg); background: var(--surface-2); border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); border-radius: var(--r-full); }
.cv-sprechen__punkt { flex: none; width: 9px; height: 9px; background: var(--danger); border-radius: 50%; animation: cv-punkt 1.2s ease-in-out infinite; }
@keyframes cv-punkt { 50% { opacity: 0.3; } }
.cv-sprechen__text { flex: 1 1 auto; min-width: 0; }
.cv-sprechen__zeit { font-size: var(--fs-xs); color: var(--fg-subtle); font-variant-numeric: tabular-nums; }

/* -- Vorlese-Spieler -- */
.cv-spieler { display: flex; align-items: center; gap: 8px; max-width: 100%; margin-top: 6px; padding: 4px 4px 4px 4px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-full); }
.cv-spieler__knopf, .cv-spieler__zu { display: grid; place-items: center; flex: none; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; }
.cv-spieler__knopf { color: var(--accent-fg); background: var(--accent); }
.cv-spieler__knopf:hover { background: var(--accent-hover); }
.cv-spieler__zu { color: var(--fg-subtle); background: none; }
.cv-spieler__zu:hover { color: var(--fg); background: var(--surface-3); }
.cv-spieler__knopf svg, .cv-spieler__zu svg { width: 15px; height: 15px; }
.cv-spieler__tempo { flex: none; min-width: 52px; height: 28px; padding: 0 9px; font: inherit; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--fg); background: none; border: 1px solid var(--border-strong); border-radius: var(--r-full); cursor: pointer; }
.cv-spieler__tempo:hover { background: var(--surface-3); }
.cv-spieler__stand { flex: none; font-size: var(--fs-xs); color: var(--fg-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.cv-spieler__satz { flex: 1 1 auto; min-width: 0; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--fg-subtle); }
.cv-spieler button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
::highlight(${VORLESE_MARKE}) { background-color: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--fg); }

/* -- Live-Fortschritt waehrend der Antwort -- */
.cv-fortschritt { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; }
.cv-fortschritt .cv-live { margin: 0; }
.cv-live.is-fertig, .cv-live.is-fertig .cv-live__symbol { color: var(--fg-subtle); }
.cv-live.is-fehler, .cv-live.is-fehler .cv-live__symbol { color: var(--danger); }

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
  .cv-composer__modus-text { display: none; }
  .cv-composer__modus { width: 40px; padding: 0; justify-content: center; }
  .cv-galerie--eins .cv-galerie__bild img { max-width: 240px; max-height: 240px; }
  .cv-galerie--viele .cv-galerie__bild img { width: 104px; height: 104px; }
  .cv__spalte { padding: var(--sp-3) var(--sp-2) var(--sp-2); }
  .cv-eingabe { padding: 0 var(--sp-2) var(--sp-2); }
  .cv-msg { gap: 10px; }
  .cv-msg--user .cv-msg__spalte { max-width: 88%; }
  .cv-avatar { display: none; }
  .cv-leer__titel { font-size: var(--fs-2xl); }
}
@media (pointer: coarse) {
  .cv-composer__modus { height: var(--tap-min); }
  .cv-composer__clip, .cv-composer__senden, .cv-composer__mikro, .cv-nachunten, .cv-anhang__weg,
  .cv-spieler__knopf, .cv-spieler__zu { width: var(--tap-min); height: var(--tap-min); }
  .cv-spieler__tempo, .cv-schnell__knopf, .cv-sprechen__fertig { min-height: var(--tap-min); }
  .cv-aktion { min-width: var(--tap-min); height: var(--tap-min); }
  .cv-mehr, .cv-quelle { min-height: var(--tap-min); }
  .cv-quelle { align-items: center; }
  .cv-knopf { min-height: var(--tap-min); }
}
`;

export default { mount, unmount };
