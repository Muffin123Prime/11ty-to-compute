'use strict';

/**
 * Der Chat mit Claude.
 *
 * Dieses Modul ist die einzige Stelle, an der aus einem Satz des Nutzers eine
 * Anfrage an Claude wird -- und damit die Stelle, an der das Versprechen
 * "nichts erfinden" gehalten oder gebrochen wird. Die Entscheidungen unten
 * existieren, um es zu halten.
 *
 * 1. **Die Antwort wird angelegt, BEVOR Claude gefragt wird**, und lebt die
 *    ganze Zeit mit `status:'streaming'`. Der Teiltext wird gedrosselt
 *    zurückgeschrieben; ein Absturz kostet höchstens ein paar hundert
 *    Millisekunden Text. Abbruch und Fehler behalten, was wirklich ankam,
 *    und schreiben nie etwas hinein, das nicht von Claude kam.
 *
 * 2. **Ein Zug ist mehr als ein Aufruf.** Ruft Claude ein Werkzeug auf
 *    (Termin, Notiz, …), führt Neural OS es aus und schickt ALLE Ergebnisse
 *    dieses Zuges in EINER Nutzernachricht zurück; Claude antwortet weiter.
 *    Pausiert die Websuche (`pause_turn`), geht dieselbe Antwort ohne neue
 *    Nutzernachricht noch einmal hin (höchstens fünfmal). Was bei jedem
 *    Schritt hin- und zurückging, steht als `claude.verlauf` an der Antwort --
 *    Denkblöcke unverändert, so wie die API es verlangt, und so, dass der
 *    nächste Zug byte-gleich denselben Anfang schickt (Caching).
 *
 * 3. **`stop_reason` wird vor dem Inhalt gelesen.** Bei `max_tokens` und
 *    `refusal` wird KEIN Werkzeug ausgeführt -- ein halb gestreamter
 *    Werkzeugaufruf wäre sonst ein halb angelegter Termin.
 *
 * 4. **Eine Rückfrage hält den Zug an.** Claude ruft `rueckfrage` auf; die
 *    Oberfläche zeigt Frage und Knöpfe; der Strom endet mit
 *    `fertig {stopReason:'rueckfrage'}`. Der Zustand steht in der Antwort
 *    (nicht nur im Speicher), also übersteht die offene Frage auch einen
 *    Neustart. Die Antwort kommt über `antworten()` und der Zug läuft in
 *    DERSELBEN Antwort weiter. Schreibt der Nutzer stattdessen etwas Neues,
 *    wird die Frage als übergangen abgeschlossen -- eine offene
 *    Werkzeuganfrage ohne Ergebnis würde jede weitere Anfrage ablehnen lassen.
 *
 * 5. **Der Systemtext ist fest, das Gedächtnis kommt danach.** Erst der
 *    unveränderliche Teil (wer die KI ist, was sie selbst anlegt), dann die
 *    gemerkten Fakten mit `cache_control`. Datum und Uhrzeit stehen in der
 *    Nutzernachricht des Zuges und werden mit ihr gespeichert -- eine Uhrzeit
 *    im Systemtext machte jeden Cache nach einer Minute wertlos.
 *
 * 6. **Herkunft kommt von der Schleuse.** `usedNetwork`/`networkTargets`
 *    werden aus den `network.attempt`-Ereignissen gesammelt, die die Schleuse
 *    während dieses Zuges für diesen Chat veröffentlicht.
 *
 * 7. **Neu antworten und Bearbeiten verwerfen, statt umzuschreiben.** Was
 *    überholt ist, wandert in den Papierkorb (Ereignis `verworfen {ids}`),
 *    und ein ganz normaler neuer Zug beginnt. Was die KI im verworfenen Zug
 *    angelegt hat, bleibt stehen: es ist eine eigene Handlung mit eigenem
 *    "Rückgängig" (`wirkung` am Agenten-Ereignis), kein Teil des Textes.
 */

const anbieter = require('./providers/anthropic');
const { createWerkzeuge, DEFINITIONEN, istEigenesWerkzeug, ungueltigErgebnis } = require('./werkzeuge');
const wdh = require('../kalender/wiederholung');
const {
  NeuralError,
  ValidationError,
  NotFoundError,
  AbortedError,
  asNeuralError,
} = require('../kernel/errors');

/* ------------------------------------------------------------ Konstanten */

/** Obergrenze für eine einzelne Nachricht, damit ein Einfügen den Speicher nicht sprengt. */
const MAX_CONTENT_CHARS = 200000;
/** Grobe Schätzung, nur für die Kontextgrenze. */
const CHARS_PER_TOKEN = 4;
/** Aufrufe je Zug (Werkzeugschleife), danach wird ehrlich angehalten. */
const MAX_RUNDEN = 24;
/** `pause_turn`-Fortsetzungen je Zug (Vorlage: höchstens 5). */
const MAX_PAUSEN = 5;
/**
 * Wie viel Verlauf höchstens mitgeht (Zeichen des JSON). Claude fasst eine
 * Million Token; 2,4 Mio. Zeichen sind grob 600 000 -- genug Luft für
 * Denken und Antwort. Was darüber liegt, wird weggelassen (nicht
 * zusammengefasst) und gemeldet.
 */
const MAX_VERLAUF_ZEICHEN = 2400000;
/** Gemerkte Fakten im Systemtext. */
const GEDAECHTNIS_MAX = 200;
const GEDAECHTNIS_ZEICHEN = 30000;

const FLUSH_INTERVAL_MS = 500;
const FLUSH_CHARS = 400;

const EFFORTS = new Set(['low', 'medium', 'high']);
const CACHEBAR = new Set(['text', 'tool_result', 'image', 'document']);

/**
 * Der feste Systemtext. Knapp und für ein starkes Modell geschrieben: WAS
 * zu tun ist und WANN, keine Überbelehrung. Kein Datum, keine Uhrzeit, keine
 * Zufallszahl -- sonst ist der Cache bei jeder Anfrage ungültig.
 */
const SYSTEM_FEST = [
  'Du bist die persönliche KI von Neural OS. Neural OS läuft vom USB-Stick des Nutzers; seine Notizen, Termine, Projekte und das, was du über ihn weißt, liegen dort in seinem eigenen Tresor.',
  'Sprich Deutsch, außer er schreibt in einer anderen Sprache. Antworte knapp und direkt wie in einem guten Chat; Markdown ist erlaubt.',
  '',
  'Was du selbst erledigst, ohne dass er darum bitten muss:',
  '- Nennt er einen Termin, eine Verabredung oder eine Frist mit Datum, trag sie mit termin_anlegen ein.',
  '- Will er etwas festhalten, oder entsteht ein Ergebnis, das er behalten will, leg mit notiz_anlegen eine Notiz an.',
  '- Erzählt er etwas Dauerhaftes über sich, merk es dir mit merken.',
  '- Arbeitet er an einem Vorhaben über mehrere Schritte, pflege es mit projekt_anpassen.',
  'Sag danach in einem kurzen Satz, was du angelegt hast. Leg nichts doppelt an.',
  '',
  // Kalender-Absatz (Termin-Agent). Ohne Datum und Uhrzeit: die stehen in
  // der Nutzernachricht, sonst waere der Cache nach einer Minute wertlos.
  'Kalender:',
  '- Bevor du einen Termin änderst oder löschst, hol dir mit termine_lesen die id. Fragt er, was ansteht, lies ebenfalls mit termine_lesen nach, statt zu raten.',
  '- Wiederkehrendes („jeden Dienstag“) ist eine Serie mit wiederholung, nicht viele Einzeltermine.',
  '- Fehlt die Uhrzeit und ist sie wichtig, frag mit rueckfrage und 2–4 Antworten (z. B. „10:00“, „15:00“, „Ganztägig“).',
  '- Meldet das Werkzeug eine Überschneidung, sag sie in einem Satz.',
  '- Bestätige danach kurz mit Wochentag, Datum und Uhrzeit (z. B. „Eingetragen: Di., 29.09., 10:00 Uhr.“) statt langer Texte. Nimm den Wochentag aus der Antwort des Werkzeugs (wann).',
  '',
  'Bei Planungen (Reise, Lernplan, Fest, Projekt …) stell zuerst mit rueckfrage die eine Frage, die den Plan am meisten verändert, mit kurzen Antworten zum Antippen. Frag nicht, was schon im Gespräch steht.',
  '',
  'Für aktuelle Fakten, Nachrichten, Preise, Öffnungszeiten und alles nach deinem Wissensstand benutze die Websuche. Erfinde nichts; wenn du etwas nicht weißt oder nicht finden kannst, sag es.',
  '',
  // Die Oberflaeche macht aus ```prompt / ```text eine Karte mit eigenem
  // "Kopieren" (web/lib/markdown.js, kopierKarten). Ohne diesen Satz landet
  // die Einleitung ("Hier ist dein Prompt:") mit in der Zwischenablage.
  'Will der Nutzer einen Prompt, eine Nachricht, eine E-Mail oder einen anderen Text zum Weiterverwenden, steht genau dieser Text allein in einem Block ```prompt (bzw. ```text) – ohne Einleitung im Block –, damit er ihn mit einem Tipp kopieren kann. Rückfragen stellst du über das Werkzeug rueckfrage mit 2–5 kurzen Optionen.',
].join('\n');

/* --------------------------------------------------------------- Helfer */

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

/** Grobe Token-Schätzung (4 Zeichen je Token, 25 % Aufschlag für Deutsch). */
function estimateTokens(text) {
  if (typeof text !== 'string' || !text.length) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * 1.25);
}

function klon(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Erste nicht-leere Zeile, für den Titel eines neuen Chats. */
function firstLine(text, max) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Nachrichten nach Anlegezeit; `ordinal` entscheidet bei Gleichstand, weil
 * zwei Nachrichten in derselben Millisekunde häufig sind und Satz-IDs zufällig.
 * Exportiert: der Werkzeugkasten der Agenten liest Chats auch, und zwei
 * Sortierungen derselben Nachrichten sind, wie eine Zusammenfassung ein
 * Gespräch rückwärts zitiert.
 */
function sortMessages(items) {
  return items.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    const ao = Number(a.data && a.data.ordinal);
    const bo = Number(b.data && b.data.ordinal);
    if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
    return a.id < b.id ? -1 : 1;
  });
}

/** Der Datumssatz für die Nutzernachricht. Ortszeit dieses Rechners. */
function heuteSatz(jetzt = new Date()) {
  let tz = 'Ortszeit';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* egal */ }
  let lang;
  let zeit;
  try {
    lang = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(jetzt);
    zeit = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }).format(jetzt);
  } catch {
    lang = jetzt.toDateString();
    zeit = `${jetzt.getHours()}:${String(jetzt.getMinutes()).padStart(2, '0')}`;
  }
  const iso = `${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, '0')}-${String(jetzt.getDate()).padStart(2, '0')}`;
  return `[Neural OS: Heute ist ${lang} (${iso}), ${zeit} Uhr, Zeitzone ${tz}.]`;
}

/* ------------------------------------------------ Verlauf für Claude */

const DENKEN = new Set(['thinking', 'redacted_thinking']);

function toolUseIds(nachricht) {
  return (nachricht.content || []).filter((b) => b && b.type === 'tool_use').map((b) => b.id);
}

function ersatzErgebnis(id) {
  return {
    type: 'tool_result',
    tool_use_id: id,
    is_error: true,
    content: 'Nicht ausgeführt – die Antwort wurde vorher unterbrochen.',
  };
}

/**
 * Einen Verlauf so herrichten, dass die API ihn annimmt -- ohne Inhalte zu
 * erfinden:
 * - gleiche Rollen hintereinander werden zu einer Nachricht (so fasst die
 *   API sie ohnehin zusammen, und nur so lässt sich die Paarung prüfen);
 * - jeder eigene Werkzeugaufruf bekommt in der folgenden Nutzernachricht ein
 *   Ergebnis; fehlt es (Abbruch), steht dort ehrlich "nicht ausgeführt";
 * - Werkzeugergebnisse ohne Aufruf fallen weg und stehen immer zuerst;
 * - Antworten, die nur aus Denkblöcken bestehen, fallen weg;
 * - die erste Nachricht ist vom Nutzer.
 */
function verlaufHerrichten(nachrichten) {
  const roh = [];
  for (const n of nachrichten) {
    if (!n || (n.role !== 'user' && n.role !== 'assistant')) continue;
    const content = Array.isArray(n.content) ? n.content.filter(Boolean) : [];
    if (!content.length) continue;
    const letzte = roh[roh.length - 1];
    if (letzte && letzte.role === n.role) letzte.content.push(...klon(content));
    else roh.push({ role: n.role, content: klon(content) });
  }
  roh.forEach((n, i) => {
    if (n.role !== 'assistant') return;
    // Eine Antwort am ENDE gibt es nur nach pause_turn: dort muss der offene
    // Suchaufruf stehen bleiben, damit der Server weiß, wo er weitermacht.
    n.content = anbieter.bloeckeZurueck(n.content, { offeneSuche: i === roh.length - 1 });
  });
  const ohneLeere = roh.filter((n) => n.role !== 'assistant' || n.content.some((b) => !DENKEN.has(b.type)));
  // Nach dem Entfernen können wieder gleiche Rollen nebeneinander stehen.
  const out = [];
  for (const n of ohneLeere) {
    const letzte = out[out.length - 1];
    if (letzte && letzte.role === n.role) letzte.content.push(...n.content);
    else out.push(n);
  }
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    if (n.role === 'assistant') {
      const ids = toolUseIds(n);
      if (!ids.length) continue;
      let folge = out[i + 1];
      if (!folge || folge.role !== 'user') {
        folge = { role: 'user', content: [] };
        out.splice(i + 1, 0, folge);
      }
      const da = new Set(folge.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id));
      const fehlend = ids.filter((id) => !da.has(id)).map(ersatzErgebnis);
      const ergebnisse = folge.content.filter((b) => b.type === 'tool_result' && ids.includes(b.tool_use_id));
      const rest = folge.content.filter((b) => b.type !== 'tool_result');
      folge.content = [...ergebnisse, ...fehlend, ...rest];
    }
  }
  // Werkzeugergebnisse, deren Aufruf nicht direkt davor steht, fallen weg.
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    if (n.role !== 'user') continue;
    const davor = i > 0 && out[i - 1].role === 'assistant' ? new Set(toolUseIds(out[i - 1])) : new Set();
    n.content = n.content.filter((b) => b.type !== 'tool_result' || davor.has(b.tool_use_id));
  }
  const final = out.filter((n) => n.content.length);
  while (final.length && final[0].role !== 'user') final.shift();
  return final;
}

/** Den Cache-Punkt an den letzten passenden Block der letzten Nutzernachricht setzen (auf einer Kopie). */
function mitCachePunkt(nachrichten) {
  const kopie = klon(nachrichten);
  for (let i = kopie.length - 1; i >= 0; i--) {
    if (kopie[i].role !== 'user') continue;
    const bloecke = kopie[i].content;
    for (let j = bloecke.length - 1; j >= 0; j--) {
      const b = bloecke[j];
      if (!CACHEBAR.has(b.type)) continue;
      if (b.type === 'text' && !String(b.text || '').trim()) continue;
      b.cache_control = { type: 'ephemeral' };
      return kopie;
    }
    return kopie;
  }
  return kopie;
}

/* ---------------------------------------------------------- Fabrik */

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.claude      src/models/claude.js
 * @param {object} [deps.gate]
 * @param {object} [deps.bus]
 * @param {object} [deps.graph]
 * @param {object} [deps.config]
 * @param {Function} [deps.logger]
 * @param {object} [deps.werkzeuge] nur für Tests
 */
function createChatService({ store, claude, gate, bus, graph, config, logger, werkzeuge } = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new ValidationError('createChatService benötigt einen Store.');
  }
  if (!claude || typeof claude.senden !== 'function') {
    throw new ValidationError('createChatService benötigt Claude.');
  }
  const log = typeof logger === 'function' ? logger('chat') : (logger || nullLogger());
  const cfg = config || {};
  const tools = werkzeuge || createWerkzeuge({ store, bus, logger });

  /** chatId -> {controller, messageId, startedAt} */
  const inflight = new Map();

  /* ------------------------------------------------------------ Sätze */

  function getChat(chatId) {
    if (typeof chatId !== 'string' || !chatId.trim()) {
      throw new ValidationError('Es wurde keine Chat-Kennung übergeben.');
    }
    const record = store.get(chatId);
    if (!record || record.type !== 'chat') throw new NotFoundError(`Chat ${chatId}`);
    return record;
  }

  function historyOf(chatId) {
    return sortMessages(store.list('message', { filter: { chatId } }).items);
  }

  function nextOrdinal(history) {
    let max = -1;
    for (const m of history) {
      const o = Number(m.data && m.data.ordinal);
      if (Number.isFinite(o) && o > max) max = o;
    }
    return max + 1;
  }

  function emit(onEvent, event) {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch (err) {
      // Ein geschlossener Tab darf einen laufenden, bezahlten Zug nicht abbrechen.
      log.warn(`chat onEvent hat geworfen: ${err && err.message}`);
    }
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try { bus.publish(name, payload); } catch (err) { log.warn(`bus.publish(${name}): ${err && err.message}`); }
  }

  /* ------------------------------------------------------ Gedächtnis */

  function gedaechtnis() {
    let fakten = [];
    try {
      fakten = store.list('memory', { sort: 'createdAt', order: 'asc' }).items
        .filter((m) => !m.data.scope || m.data.scope === 'global')
        .map((m) => String(m.data.text || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    } catch (err) {
      log.warn(`Gedächtnis nicht lesbar: ${err && err.message}`);
    }
    // Die neuesten zählen, wenn es zu viele werden; die Reihenfolge bleibt fest.
    if (fakten.length > GEDAECHTNIS_MAX) fakten = fakten.slice(-GEDAECHTNIS_MAX);
    let summe = 0;
    const aus = [];
    for (let i = fakten.length - 1; i >= 0; i--) {
      summe += fakten[i].length + 3;
      if (summe > GEDAECHTNIS_ZEICHEN) break;
      aus.unshift(fakten[i]);
    }
    return aus;
  }

  function systemBloecke(chat) {
    const fakten = gedaechtnis();
    const teile = [
      fakten.length
        ? `Was du über den Nutzer weißt:\n${fakten.map((f) => `- ${f}`).join('\n')}`
        : 'Was du über den Nutzer weißt: noch nichts.',
    ];
    const eigene = typeof (chat.data && chat.data.systemPrompt) === 'string' ? chat.data.systemPrompt.trim() : '';
    if (eigene) teile.push(`Zusätzliche Anweisung des Nutzers für diesen Chat:\n${eigene}`);
    return [
      { type: 'text', text: SYSTEM_FEST },
      { type: 'text', text: teile.join('\n\n'), cache_control: { type: 'ephemeral' } },
    ];
  }

  /* ------------------------------------------- Verlauf aus den Sätzen */

  /**
   * Die Nachrichten für Claude aus den gespeicherten Sätzen -- genau so, wie
   * sie damals gesendet und empfangen wurden, damit der Anfang jeder
   * Anfrage gleich bleibt.
   */
  function verlaufAus(records) {
    const out = [];
    for (const rec of records) {
      const d = rec.data || {};
      if (d.role === 'user') {
        const inhalt = d.claude && Array.isArray(d.claude.inhalt) && d.claude.inhalt.length
          ? d.claude.inhalt
          : (String(d.content || '').trim() ? [{ type: 'text', text: String(d.content) }] : []);
        if (inhalt.length) out.push({ role: 'user', content: klon(inhalt) });
        continue;
      }
      if (d.role !== 'assistant') continue;
      const c = d.claude || null;
      if (c && c.abgelehnt) continue;
      const verlauf = c && Array.isArray(c.verlauf) ? c.verlauf : null;
      if (verlauf) {
        for (const n of verlauf) out.push(klon(n));
        // Was nach dem letzten vollständigen Schritt noch ankam (Abbruch,
        // Fehler), steht nur im sichtbaren Text. Claude soll es kennen.
        const rest = String(d.content || '').slice(Number(c.textImVerlauf) || 0).trim();
        if (rest && (d.status === 'aborted' || d.status === 'failed')) {
          out.push({ role: 'assistant', content: [{ type: 'text', text: `${rest}\n\n[Diese Antwort wurde unterbrochen.]` }] });
        }
        continue;
      }
      const text = String(d.content || '').trim();
      if (!text) continue;
      const zusatz = d.status === 'aborted' || d.status === 'failed' ? '\n\n[Diese Antwort wurde unterbrochen.]' : '';
      out.push({ role: 'assistant', content: [{ type: 'text', text: `${text}${zusatz}` }] });
    }
    return out;
  }

  /**
   * Den Verlauf auf die Kontextgrenze bringen, indem die ÄLTESTEN Züge
   * weggelassen werden -- nie zusammengefasst. Gibt zurück, wie viele es waren.
   */
  function kuerzen(nachrichten) {
    let weg = 0;
    let liste = nachrichten;
    while (liste.length > 1 && JSON.stringify(liste).length > MAX_VERLAUF_ZEICHEN) {
      // Bis zur nächsten Nutzernachricht mit Text (Beginn eines Zuges) weglassen.
      let i = 1;
      while (i < liste.length && !(liste[i].role === 'user' && liste[i].content.some((b) => b.type === 'text'))) i++;
      if (i >= liste.length) break;
      weg += i;
      liste = liste.slice(i);
    }
    return { nachrichten: liste, weg };
  }

  /* ------------------------------------------------------ Herkunft */

  function watchEgress(scope) {
    const targets = new Map();
    const state = { usedNetwork: false, targets };
    if (!bus || typeof bus.on !== 'function') return { state, stop() {} };
    const handler = (evt) => {
      const p = evt && evt.payload;
      if (!p || p.allowed !== true || p.scope !== scope) return;
      const host = p.host || p.ip;
      if (!host) return;
      targets.set(p.port ? `${host}:${p.port}` : String(host), p.classification || 'unknown');
      if (p.classification && p.classification !== 'loopback') state.usedNetwork = true;
    };
    bus.on('network.attempt', handler);
    let aus = false;
    return {
      state,
      stop() {
        if (aus) return;
        aus = true;
        try { bus.off('network.attempt', handler); } catch { /* schon weg */ }
      },
    };
  }

  /* -------------------------------------------------------- der Zug */

  function modellFuer(chat) {
    const m = chat.data && chat.data.model;
    const id = m && typeof m === 'object' ? m.model : m;
    return anbieter.istModell(id) ? id : claude.modell();
  }

  function effortVon(wert, rueckfall) {
    return EFFORTS.has(wert) ? wert : (EFFORTS.has(rueckfall) ? rueckfall : 'medium');
  }

  function statsAddieren(stats, usage) {
    const n = (v) => (Number.isFinite(v) ? v : 0);
    const u = usage || {};
    stats.promptTokens = n(stats.promptTokens) + n(u.input_tokens);
    stats.completionTokens = n(stats.completionTokens) + n(u.output_tokens);
    stats.cacheRead = n(stats.cacheRead) + n(u.cache_read_input_tokens);
    stats.cacheWrite = n(stats.cacheWrite) + n(u.cache_creation_input_tokens);
    stats.suchen = n(stats.suchen) + n(u.server_tool_use && u.server_tool_use.web_search_requests);
    stats.aufrufe = n(stats.aufrufe) + 1;
    return stats;
  }

  /**
   * Einen Zug laufen lassen (oder fortsetzen) -- bis Claude fertig ist, eine
   * Rückfrage stellt, abgebrochen wird oder scheitert.
   *
   * @param {object} p
   * @param {object} p.chat
   * @param {object} p.assistant      der Antwort-Satz (status streaming)
   * @param {Array}  p.basis          Nachrichten VOR diesem Zug, inkl. der Nutzernachricht
   * @param {Function} [p.onEvent]
   * @param {AbortSignal} [p.signal]
   * @param {string} p.effort
   */
  async function zug({ chat, assistant, basis, onEvent, signal, effort }) {
    const scope = `chat:${chat.id}`;
    const controller = new AbortController();
    const beiAussen = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', beiAussen, { once: true });
    }
    inflight.set(chat.id, { controller, messageId: assistant.id, startedAt: Date.now() });

    const d0 = assistant.data || {};
    const c0 = d0.claude || {};
    const modell = c0.modell && anbieter.istModell(c0.modell) ? c0.modell : modellFuer(chat);
    const t = {
      verlauf: Array.isArray(c0.verlauf) ? klon(c0.verlauf) : [],
      text: String(d0.content || ''),
      textImVerlauf: Number(c0.textImVerlauf) || 0,
      denken: String(d0.denken || ''),
      quellen: Array.isArray(d0.quellen) ? klon(d0.quellen) : [],
      agenten: Array.isArray(d0.agenten) ? klon(d0.agenten) : [],
      rueckfragen: Array.isArray(d0.rueckfragen) ? klon(d0.rueckfragen) : [],
      pausen: 0,
      runden: 0,
      stats: d0.stats && typeof d0.stats === 'object' ? klon(d0.stats) : {},
      modellAntwort: null,
    };
    const suchen = new Map(); // tool_use_id -> Aktivität

    let flushedText = t.text.length;
    let flushedDenken = t.denken.length;
    let lastFlush = Date.now();
    let settled = false;
    let final = assistant;

    const speichern = (patch) => {
      try {
        final = store.update(assistant.id, patch);
      } catch (err) {
        log.warn(`Antwort ${assistant.id} nicht gespeichert: ${err && err.message}`);
      }
      return final;
    };

    const claudeDaten = (extra = {}) => ({
      modell,
      effort,
      verlauf: t.verlauf,
      textImVerlauf: t.textImVerlauf,
      ...extra,
    });

    const flush = (force) => {
      if (settled) return;
      const neu = t.text.length !== flushedText || t.denken.length !== flushedDenken;
      if (!neu && !force) return;
      const now = Date.now();
      if (!force && now - lastFlush < FLUSH_INTERVAL_MS
        && t.text.length - flushedText < FLUSH_CHARS && t.denken.length - flushedDenken < FLUSH_CHARS) return;
      speichern({ content: t.text, denken: t.denken });
      flushedText = t.text.length;
      flushedDenken = t.denken.length;
      lastFlush = now;
    };

    const textDazu = (delta) => {
      if (!delta) return;
      t.text += delta;
      emit(onEvent, { type: 'text', delta });
      flush(false);
    };

    const quelleDazu = (titel, url, art) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      if (t.quellen.some((q) => q.url === url)) return;
      const q = { titel: String(titel || url).slice(0, 300), url, art };
      t.quellen.push(q);
      emit(onEvent, { type: 'quelle', titel: q.titel, url: q.url, art });
    };

    const agentMelden = (e) => {
      if (!e) return;
      const i = t.agenten.findIndex((a) => a.id === e.id);
      const vorher = i >= 0 ? t.agenten[i] : null;
      const kurz = { id: e.id, runId: e.runId || null, rolle: e.rolle, titel: e.titel, zustand: e.zustand, ergebnis: e.ergebnis || null };
      if (Number.isFinite(e.dauerMs)) kurz.dauerMs = e.dauerMs;
      // Zusatz (additiv): welches Werkzeug, und was es im Tresor hinterliess.
      // Ein spaeteres Ereignis desselben Laufs traegt beides nicht immer mit.
      const werkzeug = e.werkzeug || (vorher && vorher.werkzeug) || null;
      const wirkung = e.wirkung || (vorher && vorher.wirkung) || null;
      if (werkzeug) kurz.werkzeug = werkzeug;
      if (wirkung && wirkung.length) kurz.wirkung = wirkung;
      // Wo im Text der Agent ansprang -- damit die Oberflaeche seine Karte
      // an dieser Stelle zeigt und nicht irgendwo am Ende.
      kurz.beiZeichen = vorher && Number.isFinite(vorher.beiZeichen) ? vorher.beiZeichen : t.text.length;
      if (i >= 0) t.agenten[i] = kurz;
      else t.agenten.push(kurz);
      emit(onEvent, { type: 'agent', ...e });
    };

    const beiEreignis = (e) => {
      if (e.art === 'start' && e.block) {
        if (e.block.type === 'text' && t.text && !/\s$/.test(t.text)) textDazu('\n\n');
        if (e.block.type === 'thinking' && t.denken && !/\s$/.test(t.denken)) {
          t.denken += '\n\n';
          emit(onEvent, { type: 'denken', delta: '\n\n' });
        }
        if (e.block.type === 'fallback') {
          emit(onEvent, { type: 'hinweis', satz: 'Ein Ersatzmodell von Anthropic hat diese Antwort übernommen.' });
        }
        if (/_tool_result$/.test(e.block.type || '') && e.block.tool_use_id) sucheBeenden(e.block);
        return;
      }
      if (e.art === 'text') {
        textDazu(e.delta);
      } else if (e.art === 'denken') {
        t.denken += e.delta;
        emit(onEvent, { type: 'denken', delta: e.delta });
        flush(false);
      } else if (e.art === 'zitat' && e.zitat) {
        quelleDazu(e.zitat.title || e.zitat.document_title, e.zitat.url, 'zitat');
      } else if (e.art === 'ende' && e.block && e.block.type === 'server_tool_use') {
        sucheBeginnen(e.block);
      }
    };

    function sucheBeginnen(block) {
      if (suchen.has(block.id)) return;
      const input = block.input || {};
      const titel = block.name === 'web_fetch'
        ? `Liest: ${String(input.url || 'eine Seite').slice(0, 80)}`
        : `Sucht: ${String(input.query || '…').slice(0, 80)}`;
      const lauf = tools.aktivitaet({
        chatId: chat.id, messageId: assistant.id, rolle: 'recherche', titel,
        schritt: block.name === 'web_fetch' ? 'Liest die Seite' : 'Sucht im Internet',
      });
      suchen.set(block.id, lauf);
      agentMelden(lauf.ereignis());
    }

    function sucheBeenden(block) {
      let lauf = suchen.get(block.tool_use_id);
      if (!lauf) {
        lauf = tools.aktivitaet({ chatId: chat.id, messageId: assistant.id, rolle: 'recherche', titel: 'Recherche', schritt: '' });
      }
      suchen.delete(block.tool_use_id);
      const inhalt = block.content;
      if (block.type === 'web_search_tool_result') {
        if (Array.isArray(inhalt)) {
          agentMelden(lauf.fertig(`${inhalt.length} Treffer`));
        } else {
          agentMelden(lauf.fehler(sucheFehlerSatz(inhalt && inhalt.error_code)));
        }
        return;
      }
      if (block.type === 'web_fetch_tool_result') {
        if (inhalt && inhalt.type === 'web_fetch_result') {
          const dok = inhalt.content || {};
          quelleDazu(dok.title || inhalt.url, inhalt.url, 'gelesen');
          agentMelden(lauf.fertig(`Gelesen: ${String(dok.title || inhalt.url || '').slice(0, 80)}`));
        } else {
          agentMelden(lauf.fehler(sucheFehlerSatz(inhalt && inhalt.error_code)));
        }
        return;
      }
      agentMelden(lauf.fertig('Erledigt'));
    }

    const anhaengen = (inhalt, { offeneSuche = false } = {}) => {
      const bloecke = anbieter.bloeckeZurueck(inhalt, { offeneSuche });
      if (!bloecke.length) return;
      const letzte = t.verlauf[t.verlauf.length - 1];
      // Nach pause_turn setzt die nächste Antwort DIESELBE Nachricht fort.
      if (letzte && letzte.role === 'assistant') letzte.content.push(...bloecke);
      else t.verlauf.push({ role: 'assistant', content: bloecke });
      t.textImVerlauf = t.text.length;
    };

    const egress = watchEgress(scope);
    let stopReason = null;
    let hinweis = null;

    try {
      const system = systemBloecke(chat);
      for (;;) {
        if (controller.signal.aborted) throw new AbortedError('Die Antwort wurde abgebrochen.');
        if (++t.runden > MAX_RUNDEN) {
          stopReason = 'zu_viele_schritte';
          hinweis = 'Diese Antwort brauchte zu viele Schritte; ich habe hier angehalten. Schreib „weiter“, dann mache ich weiter.';
          break;
        }
        const { nachrichten, weg } = kuerzen(verlaufHerrichten([...basis, ...t.verlauf]));
        if (weg && t.runden === 1) {
          emit(onEvent, { type: 'hinweis', satz: `${weg} ältere Nachricht(en) passen nicht mehr in den Kontext und wurden diesmal weggelassen (nicht zusammengefasst).` });
        }
        const { body, betas } = anbieter.anfrageBauen({
          modell,
          system,
          werkzeuge: DEFINITIONEN,
          nachrichten: mitCachePunkt(nachrichten),
          effort,
        });
        const r = await claude.senden({
          body,
          betas,
          gate,
          scope,
          purpose: `Antwort im Chat „${(chat.data && chat.data.title) || chat.id}“`,
          signal: controller.signal,
          beiEreignis,
        });
        statsAddieren(t.stats, r.usage);
        t.modellAntwort = r.modell || t.modellAntwort;

        // ZUERST der Grund, dann der Inhalt.
        if (r.stopReason === 'pause_turn') {
          anhaengen(r.inhalt, { offeneSuche: true });
          speichern({ claude: claudeDaten() });
          if (++t.pausen > MAX_PAUSEN) {
            stopReason = 'pause_turn';
            hinweis = 'Die Websuche hat mehrmals pausiert; ich habe hier angehalten. Schreib „weiter“, dann suche ich weiter.';
            break;
          }
          continue;
        }

        if (r.stopReason === 'refusal') {
          stopReason = 'refusal';
          break;
        }

        if (r.stopReason === 'max_tokens') {
          anhaengen(r.inhalt);
          stopReason = 'max_tokens';
          hinweis = 'Die Antwort wurde zu lang und ist hier abgeschnitten. Schreib „weiter“, dann schreibe ich weiter.';
          break;
        }

        if (r.stopReason === 'tool_use') {
          anhaengen(r.inhalt);
          const aufrufe = anbieter.werkzeugAufrufe(r.inhalt);
          const ergebnisse = [];
          const fragen = [];
          for (const b of aufrufe) {
            if (b.name === 'rueckfrage') {
              const p = tools.pruefen('rueckfrage', b.input, r.eingabeFehler[b.id]);
              if (!p.ok) {
                const lauf = tools.aktivitaet({ chatId: chat.id, messageId: assistant.id, rolle: 'planung', titel: 'Planung: Rückfrage ungültig', schritt: '' });
                agentMelden(lauf.fehler(`Nicht gestellt – die Eingabe war ungültig: ${p.fehler.slice(0, 160)}`));
                ergebnisse.push(ungueltigErgebnis(b.id, p));
                continue;
              }
              const lauf = tools.aktivitaet({
                chatId: chat.id, messageId: assistant.id, rolle: 'planung',
                titel: tools.titel('rueckfrage', p.wert), schritt: 'Wartet auf deine Antwort',
              });
              agentMelden(lauf.ereignis());
              fragen.push({
                id: b.id,
                frage: p.wert.frage,
                optionen: p.wert.optionen,
                mehrfach: p.wert.mehrfach,
                zustand: 'offen',
                antwort: null,
                runId: lauf.runId,
                agentId: lauf.id,
                // Die Frage steht im Verlauf dort, wo sie gestellt wurde.
                beiZeichen: t.text.length,
              });
              continue;
            }
            if (istEigenesWerkzeug(b.name)) {
              const res = tools.ausfuehren(b, r.eingabeFehler[b.id], { chatId: chat.id, messageId: assistant.id });
              const wirkung = wirkungVon(b, res);
              for (const e of res.ereignisse) {
                agentMelden({ ...e, werkzeug: b.name, ...(e.zustand === 'fertig' && wirkung.length ? { wirkung } : {}) });
              }
              ergebnisse.push(res.toolResult);
              continue;
            }
            ergebnisse.push({
              type: 'tool_result', tool_use_id: b.id, is_error: true,
              content: JSON.stringify({ fehler: `Das Werkzeug „${b.name}“ gibt es in Neural OS nicht.` }),
            });
          }

          if (fragen.length) {
            t.rueckfragen.push(...fragen);
            for (const f of fragen) {
              emit(onEvent, { type: 'rueckfrage', id: f.id, frage: f.frage, optionen: f.optionen.map((label) => ({ label })), mehrfach: f.mehrfach });
            }
            stopReason = 'rueckfrage';
            // Die übrigen Ergebnisse warten mit, bis die Frage beantwortet
            // ist: alle Ergebnisse eines Zuges gehen in EINER Nachricht zurück.
            t.offen = { toolResults: ergebnisse };
            break;
          }
          if (!ergebnisse.length) {
            stopReason = 'end_turn';
            break;
          }
          t.verlauf.push({ role: 'user', content: ergebnisse });
          speichern({ claude: claudeDaten(), agenten: t.agenten, quellen: t.quellen });
          continue;
        }

        // end_turn, stop_sequence und alles Unbekannte: fertig.
        anhaengen(r.inhalt);
        stopReason = r.stopReason || 'end_turn';
        break;
      }

      // Suchen, deren Ergebnis nie kam, sind nicht "fertig".
      for (const lauf of suchen.values()) agentMelden(lauf.fehler('Nicht beendet'));
      suchen.clear();
      egress.stop();
      settled = true;

      const abgelehnt = stopReason === 'refusal';
      const wartet = stopReason === 'rueckfrage';
      if (hinweis) emit(onEvent, { type: 'hinweis', satz: hinweis });
      final = speichern({
        content: t.text,
        denken: t.denken,
        quellen: t.quellen,
        agenten: t.agenten,
        rueckfragen: t.rueckfragen,
        rueckfrageOffen: wartet,
        status: abgelehnt ? 'failed' : 'complete',
        stats: t.stats,
        model: { provider: 'claude', model: t.modellAntwort || modell },
        usedNetwork: egress.state.usedNetwork || !!(final.data && final.data.usedNetwork),
        networkTargets: [...new Set([...(final.data && final.data.networkTargets) || [], ...egress.state.targets.keys()])],
        abgeschnitten: stopReason === 'max_tokens',
        error: abgelehnt
          ? { code: 'CLAUDE_ABGELEHNT', message: 'Claude hat diese Anfrage abgelehnt. Formuliere sie anders oder frag etwas anderes.' }
          : null,
        claude: claudeDaten({
          stopReason,
          abgelehnt,
          offen: wartet ? t.offen : null,
          stopDetails: null,
        }),
      });
      if (abgelehnt) {
        emit(onEvent, { type: 'fehler', code: 'CLAUDE_ABGELEHNT', satz: 'Claude hat diese Anfrage abgelehnt. Formuliere sie anders oder frag etwas anderes.' });
      }
      emit(onEvent, { type: 'fertig', stopReason, record: final });
      publish('chat.message', { chatId: chat.id, record: final });
      ableiten(final, chat);
      return { chat, message: final, stopReason };
    } catch (err) {
      for (const lauf of suchen.values()) agentMelden(lauf.fehler('Abgebrochen'));
      suchen.clear();
      egress.stop();
      settled = true;
      const aborted = controller.signal.aborted || (err && err.code === 'ABORTED');
      const e = aborted ? new AbortedError('Die Antwort wurde abgebrochen.') : asNeuralError(err);
      final = speichern({
        content: t.text,
        denken: t.denken,
        quellen: t.quellen,
        agenten: t.agenten,
        rueckfragen: t.rueckfragen,
        rueckfrageOffen: false,
        status: aborted ? 'aborted' : 'failed',
        stats: t.stats,
        model: { provider: 'claude', model: t.modellAntwort || modell },
        usedNetwork: egress.state.usedNetwork,
        networkTargets: [...egress.state.targets.keys()],
        error: { code: e.code, message: e.message },
        claude: claudeDaten({ stopReason: aborted ? 'abgebrochen' : 'fehler', offen: null }),
      });
      if (!aborted) emit(onEvent, { type: 'fehler', code: e.code, satz: e.message });
      emit(onEvent, { type: 'fertig', stopReason: aborted ? 'abgebrochen' : 'fehler', record: final });
      publish('chat.message', { chatId: chat.id, record: final });
      if (t.text) ableiten(final, chat);
      throw e;
    } finally {
      flush(true);
      inflight.delete(chat.id);
      if (signal) {
        try { signal.removeEventListener('abort', beiAussen); } catch { /* egal */ }
      }
    }
  }

  /* ------------------------------------------------- Wirkung im Tresor */

  /** Welche Werkzeuge was im Tresor hinterlassen -- für die Karte in der Antwort. */
  const AKTION = {
    termin_anlegen: 'angelegt',
    termin_aendern: 'geaendert',
    notiz_anlegen: 'angelegt',
    merken: 'angelegt',
    projekt_anpassen: null, // je Satz: neu oder vorhanden
  };

  /**
   * Ein Abbild des Satzes, so wie die KI ihn hinterlassen hat. Absichtlich
   * ein Schnappschuss und keine Verknüpfung: die Karte sagt, was damals
   * geschah ("Termin eingetragen · Do, 25. Sep · 15:00"), auch wenn der
   * Termin später verschoben wird. "Öffnen" führt zum heutigen Stand.
   */
  function schnappschuss(rec, aktion, am = null) {
    const d = rec.data || {};
    const s = { id: rec.id, typ: rec.type, aktion, titel: '' };
    if (rec.type === 'event') {
      s.titel = d.title;
      s.start = d.start || null;
      s.end = d.end || null;
      // Ein einzelnes Vorkommen einer Serie ("das Training am 6.10. faellt
      // aus"): die Karte nennt DIESEN Tag, und "Oeffnen" fuehrt dorthin --
      // nicht zum Beginn der Serie Wochen vorher.
      if (am && wdh.istSerie(d) && wdh.gueltigerTag(am)) {
        const lage = wdh.aufTagLegen(d, am);
        s.start = lage.start;
        s.end = lage.end;
        s.am = am;
      }
      s.ganztaegig = d.allDay === true;
      if (d.location) s.ort = String(d.location).slice(0, 200);
      if (d.recurrence && d.recurrence.freq) s.serie = true;
    } else if (rec.type === 'note' || rec.type === 'task') {
      s.titel = d.title;
      if (rec.type === 'task' && d.projectId) s.projectId = d.projectId;
    } else if (rec.type === 'memory') {
      s.titel = d.text;
    } else if (rec.type === 'project') {
      s.titel = d.name;
    }
    s.titel = String(s.titel || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return s;
  }

  /**
   * Was ein ausgeführtes Werkzeug angelegt, geändert oder gelöscht hat. Nur
   * wenn es gelang -- ein gescheiterter Aufruf hat keine Wirkung, und eine
   * Karte "Termin eingetragen" dazu wäre eine erfundene.
   */
  function wirkungVon(block, res) {
    if (!res || res.ungueltig || !res.toolResult || res.toolResult.is_error) return [];
    const aus = [];
    try {
      const erstes = (res.ereignisse || [])[0] || {};
      const run = erstes.runId ? store.get(erstes.runId) : null;
      const beginn = Date.parse((run && run.data && run.data.startedAt) || '') || (Date.now() - (Number(erstes.dauerMs) || 0));
      for (const id of res.produced || []) {
        const rec = store.get(id, { includeDeleted: true });
        if (!rec) continue;
        const aktion = AKTION[block.name] || (Date.parse(rec.createdAt) >= beginn - 5 ? 'angelegt' : 'geaendert');
        aus.push(schnappschuss(rec, aktion));
      }
      if (block.name === 'termin_loeschen' && block.input && typeof block.input.id === 'string') {
        const rec = store.get(block.input.id, { includeDeleted: true });
        const am = typeof block.input.nur_am === 'string' ? block.input.nur_am : null;
        if (rec && rec.type === 'event') aus.push(schnappschuss(rec, rec.deletedAt ? 'geloescht' : 'ausgelassen', rec.deletedAt ? null : am));
      }
    } catch (err) {
      log.warn(`Wirkung von ${block.name} nicht lesbar: ${err && err.message}`);
    }
    return aus.slice(0, 21);
  }

  function sucheFehlerSatz(code) {
    switch (code) {
      case 'max_uses_exceeded': return 'Zu viele Suchen in einer Antwort';
      case 'too_many_requests': return 'Die Suche ist gerade überlastet';
      case 'query_too_long': return 'Die Suchanfrage war zu lang';
      case 'invalid_input': return 'Ungültige Suchanfrage';
      case 'url_not_accessible': return 'Die Seite ließ sich nicht öffnen';
      case 'url_not_allowed': return 'Diese Seite darf nicht geöffnet werden';
      case 'unsupported_content_type': return 'Dieses Format kann nicht gelesen werden';
      default: return 'Die Suche ist fehlgeschlagen';
    }
  }

  function ableiten(antwort, chat) {
    if (!graph || typeof graph.deriveFor !== 'function') return;
    for (const record of [antwort, store.get(chat.id) || chat]) {
      if (!record) continue;
      try {
        graph.deriveFor(store, record);
      } catch (err) {
        log.warn(`Graph-Ableitung für ${record.id} fehlgeschlagen: ${err && err.message}`);
      }
    }
  }

  /* ------------------------------------------------ offene Rückfragen */

  function letzteAntwort(history) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].data && history[i].data.role === 'assistant') return history[i];
    }
    return null;
  }

  /**
   * Eine offene Rückfrage als übergangen abschließen, weil der Nutzer
   * stattdessen etwas Neues geschrieben hat.
   */
  function rueckfrageUebergehen(antwort) {
    const d = antwort.data || {};
    if (!d.rueckfrageOffen) return antwort;
    const c = d.claude || {};
    const offen = (c.offen && Array.isArray(c.offen.toolResults)) ? c.offen.toolResults : [];
    const fragen = Array.isArray(d.rueckfragen) ? klon(d.rueckfragen) : [];
    const ergebnisse = [...klon(offen)];
    for (const f of fragen) {
      if (f.zustand !== 'offen') continue;
      f.zustand = 'uebergangen';
      ergebnisse.push({
        type: 'tool_result',
        tool_use_id: f.id,
        content: 'Keine Auswahl – der Nutzer hat nicht auf die Rückfrage geantwortet, sondern weitergeschrieben.',
      });
      const e = tools.laufAbschliessen(f.runId, { zustand: 'fertig', ergebnis: 'Übergangen – du hast weitergeschrieben' });
      if (e) {
        const i = (d.agenten || []).findIndex((a) => a.id === e.id);
        if (i >= 0) d.agenten[i] = { ...d.agenten[i], zustand: 'fertig', ergebnis: e.ergebnis };
      }
    }
    const verlauf = Array.isArray(c.verlauf) ? klon(c.verlauf) : [];
    if (ergebnisse.length) verlauf.push({ role: 'user', content: ergebnisse });
    return store.update(antwort.id, {
      rueckfragen: fragen,
      rueckfrageOffen: false,
      agenten: d.agenten || [],
      claude: { ...c, verlauf, offen: null },
    });
  }

  /* ----------------------------------------------------------- senden */

  /**
   * Eine Nachricht senden und Claudes Antwort als Ereignisse liefern.
   *
   * Ist Claude nicht verbunden, wird VOR dem Anlegen irgendeines Satzes
   * geworfen (code CLAUDE_NICHT_VERBUNDEN) -- der Nutzer behält seinen Text
   * im Eingabefeld, und es entsteht kein Scheinchat mit einer leeren Antwort.
   *
   * @param {{chatId:string, content:string, signal?:AbortSignal, onEvent?:Function, effort?:string}} opts
   */
  async function send(opts = {}) {
    const { chatId, content, signal, onEvent } = opts;
    if (typeof content !== 'string' || !content.trim()) throw new ValidationError('Die Nachricht ist leer.');
    if (content.length > MAX_CONTENT_CHARS) {
      throw new ValidationError(`Die Nachricht ist zu lang (${content.length} Zeichen, erlaubt sind ${MAX_CONTENT_CHARS}).`);
    }
    let chat = getChat(chatId);
    if (inflight.has(chat.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du erneut sendest.');
    }
    claude.zugang(); // wirft CLAUDE_NICHT_VERBUNDEN mit dem Satz für die Oberfläche

    let history = historyOf(chat.id);
    const vorige = letzteAntwort(history);
    if (vorige && vorige.data && vorige.data.rueckfrageOffen) {
      rueckfrageUebergehen(vorige);
      history = historyOf(chat.id);
    }
    let ordinal = nextOrdinal(history);

    const userMessage = store.create('message', {
      chatId: chat.id,
      role: 'user',
      content,
      status: 'complete',
      ordinal: ordinal++,
      claude: { inhalt: [{ type: 'text', text: heuteSatz() }, { type: 'text', text: content }] },
    });
    emit(onEvent, { type: 'nutzer', record: userMessage });
    publish('chat.message', { chatId: chat.id, record: userMessage });

    const titel = String((chat.data && chat.data.title) || '').trim();
    if (!history.some((m) => m.data.role === 'user') && (!titel || titel === 'Neuer Chat')) {
      const neu = firstLine(content, 60);
      if (neu) {
        try { chat = store.update(chat.id, { title: neu }); } catch (err) { log.warn(`Chat-Titel: ${err && err.message}`); }
      }
    }

    const effort = effortVon(opts.effort, 'medium');
    const assistant = antwortAnlegen(chat, ordinal++, effort, onEvent);
    const basis = verlaufAus([...history, userMessage]);
    const r = await zug({ chat, assistant, basis, onEvent, signal, effort });
    return { chat, userMessage, message: r.message, stopReason: r.stopReason };
  }

  /** Den leeren Antwort-Satz anlegen und melden -- VOR der Anfrage an Claude. */
  function antwortAnlegen(chat, ordinal, effort, onEvent) {
    const modell = modellFuer(chat);
    const assistant = store.create('message', {
      chatId: chat.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: { provider: 'claude', model: modell },
      ordinal,
      denken: '',
      quellen: [],
      agenten: [],
      rueckfragen: [],
      rueckfrageOffen: false,
      claude: { modell, effort, verlauf: [], textImVerlauf: 0 },
    });
    emit(onEvent, { type: 'antwort', record: assistant });
    publish('chat.message', { chatId: chat.id, record: assistant });
    return assistant;
  }

  /* ------------------------------------- neu antworten und bearbeiten */

  /**
   * Nachrichten verwerfen, die durch "Neu antworten" oder "Bearbeiten"
   * überholt sind. In den Papierkorb (soft delete), nicht spurlos: was die KI
   * dabei angelegt hat (ein Termin), bleibt, wo es ist, und bleibt über
   * seinen eigenen Knopf rücknehmbar. Eine offene Rückfrage darin wird als
   * verworfen abgeschlossen, sonst stünde ihr Planungs-Agent ewig auf "läuft".
   */
  function verwerfen(nachrichten, onEvent, chatId) {
    const ids = [];
    for (const m of nachrichten) {
      const d = m.data || {};
      if (d.role === 'assistant' && Array.isArray(d.rueckfragen)) {
        for (const f of d.rueckfragen) {
          if (f.zustand !== 'offen' || !f.runId) continue;
          const e = tools.laufAbschliessen(f.runId, { zustand: 'fertig', ergebnis: 'Verworfen – die Frage wurde neu gestellt' });
          if (e) emit(onEvent, { type: 'agent', ...e });
        }
      }
      try {
        store.remove(m.id);
        ids.push(m.id);
      } catch (err) {
        log.warn(`Nachricht ${m.id} nicht verworfen: ${err && err.message}`);
      }
    }
    if (ids.length) {
      emit(onEvent, { type: 'verworfen', ids });
      publish('chat.verworfen', { chatId, ids });
    }
    return ids;
  }

  function effortDer(nachrichten, wunsch) {
    for (let i = nachrichten.length - 1; i >= 0; i--) {
      const c = nachrichten[i].data && nachrichten[i].data.claude;
      if (c && EFFORTS.has(c.effort)) return effortVon(wunsch, c.effort);
    }
    return effortVon(wunsch, 'medium');
  }

  /**
   * Die letzte Antwort neu erzeugen: alles nach der letzten Frage des
   * Nutzers wird verworfen, und Claude antwortet noch einmal auf genau
   * dieselbe Nachricht (mit ihrem damaligen Datumssatz -- der Anfang bleibt
   * gleich, der Cache greift).
   *
   * @param {{chatId:string, signal?:AbortSignal, onEvent?:Function, effort?:string}} opts
   */
  async function neuAntworten(opts = {}) {
    const { chatId, signal, onEvent } = opts;
    const chat = getChat(chatId);
    if (inflight.has(chat.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du neu antworten lässt.');
    }
    claude.zugang();
    const history = historyOf(chat.id);
    let letzte = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].data && history[i].data.role === 'user') { letzte = i; break; }
    }
    if (letzte < 0) throw new ValidationError('Hier gibt es noch keine Frage, auf die ich neu antworten könnte.');
    const weg = history.slice(letzte + 1);
    const effort = effortDer(weg, opts.effort);
    verwerfen(weg, onEvent, chat.id);
    const behalten = history.slice(0, letzte + 1);
    const assistant = antwortAnlegen(chat, nextOrdinal(history), effort, onEvent);
    const r = await zug({ chat, assistant, basis: verlaufAus(behalten), onEvent, signal, effort });
    return { chat, message: r.message, stopReason: r.stopReason };
  }

  /**
   * Eine eigene Nachricht ändern: alles danach fällt weg, die Nachricht
   * bekommt den neuen Text (und einen neuen Datumssatz -- sie wird ja jetzt
   * gestellt), und Claude antwortet neu.
   *
   * @param {{chatId:string, messageId:string, content:string, signal?:AbortSignal, onEvent?:Function, effort?:string}} opts
   */
  async function bearbeiten(opts = {}) {
    const { chatId, messageId, content, signal, onEvent } = opts;
    if (typeof content !== 'string' || !content.trim()) throw new ValidationError('Die Nachricht ist leer.');
    if (content.length > MAX_CONTENT_CHARS) {
      throw new ValidationError(`Die Nachricht ist zu lang (${content.length} Zeichen, erlaubt sind ${MAX_CONTENT_CHARS}).`);
    }
    let chat = getChat(chatId);
    if (inflight.has(chat.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du etwas änderst.');
    }
    const history = historyOf(chat.id);
    const index = history.findIndex((m) => m.id === messageId);
    if (index < 0 || !history[index].data || history[index].data.role !== 'user') {
      throw new NotFoundError(`Nachricht ${messageId}`);
    }
    claude.zugang();
    const alt = history[index];
    const weg = history.slice(index + 1);
    const effort = effortDer(weg, opts.effort);
    verwerfen(weg, onEvent, chat.id);

    const userMessage = store.update(alt.id, {
      content,
      bearbeitetAm: new Date().toISOString(),
      claude: { inhalt: [{ type: 'text', text: heuteSatz() }, { type: 'text', text: content }] },
    });
    emit(onEvent, { type: 'nutzer', record: userMessage });
    publish('chat.message', { chatId: chat.id, record: userMessage });

    // Hiess der Chat nach der ersten Nachricht, heisst er jetzt nach der neuen.
    const ersteFrage = !history.slice(0, index).some((m) => m.data.role === 'user');
    const titel = String((chat.data && chat.data.title) || '').trim();
    if (ersteFrage && titel && titel === firstLine(alt.data.content, 60)) {
      const neu = firstLine(content, 60);
      if (neu && neu !== titel) {
        try { chat = store.update(chat.id, { title: neu }); } catch (err) { log.warn(`Chat-Titel: ${err && err.message}`); }
      }
    }

    const assistant = antwortAnlegen(chat, nextOrdinal(history), effort, onEvent);
    const basis = verlaufAus([...history.slice(0, index), userMessage]);
    const r = await zug({ chat, assistant, basis, onEvent, signal, effort });
    return { chat, userMessage, message: r.message, stopReason: r.stopReason };
  }

  /**
   * Eine Rückfrage beantworten. Sind damit alle offenen Fragen der Antwort
   * beantwortet, läuft der Zug in derselben Antwort weiter.
   *
   * @param {{chatId:string, id:string, antwort:string|string[], signal?:AbortSignal, onEvent?:Function}} opts
   */
  async function antworten(opts = {}) {
    const { chatId, id, signal, onEvent } = opts;
    const chat = getChat(chatId);
    if (typeof id !== 'string' || !id) throw new ValidationError('Welche Rückfrage? Es fehlt die id.');
    if (inflight.has(chat.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort.');
    }
    const history = historyOf(chat.id);
    const antwortSatz = history.find((m) => m.data.role === 'assistant'
      && Array.isArray(m.data.rueckfragen) && m.data.rueckfragen.some((f) => f.id === id));
    if (!antwortSatz) throw new NotFoundError(`Rückfrage ${id}`);
    const d = antwortSatz.data;
    const fragen = klon(d.rueckfragen);
    const frage = fragen.find((f) => f.id === id);
    if (frage.zustand !== 'offen' || !d.rueckfrageOffen || letzteAntwort(history).id !== antwortSatz.id) {
      throw new NeuralError('RUECKFRAGE_ERLEDIGT', 'Diese Rückfrage ist schon erledigt.', { status: 409 });
    }
    const text = antwortText(opts.antwort, frage);
    claude.zugang();

    frage.zustand = 'beantwortet';
    frage.antwort = text;
    const agenten = Array.isArray(d.agenten) ? klon(d.agenten) : [];
    const e = tools.laufAbschliessen(frage.runId, { zustand: 'fertig', ergebnis: `Deine Antwort: ${text}` });
    if (e) {
      const i = agenten.findIndex((a) => a.id === e.id);
      if (i >= 0) agenten[i] = { ...agenten[i], zustand: 'fertig', ergebnis: e.ergebnis };
      emit(onEvent, { type: 'agent', ...e });
    }

    const c = d.claude || {};
    if (fragen.some((f) => f.zustand === 'offen')) {
      const rec = store.update(antwortSatz.id, { rueckfragen: fragen, agenten });
      emit(onEvent, { type: 'fertig', stopReason: 'rueckfrage', record: rec });
      return { chat, message: rec, stopReason: 'rueckfrage' };
    }

    const offen = c.offen && Array.isArray(c.offen.toolResults) ? c.offen.toolResults : [];
    const ergebnisse = [
      ...klon(offen),
      ...fragen.filter((f) => f.zustand === 'beantwortet' && !offen.some((o) => o.tool_use_id === f.id)).map((f) => ({
        type: 'tool_result',
        tool_use_id: f.id,
        content: `Der Nutzer hat gewählt: ${f.antwort}`,
      })),
    ];
    const verlauf = Array.isArray(c.verlauf) ? klon(c.verlauf) : [];
    verlauf.push({ role: 'user', content: ergebnisse });
    const assistant = store.update(antwortSatz.id, {
      rueckfragen: fragen,
      rueckfrageOffen: false,
      agenten,
      status: 'streaming',
      claude: { ...c, verlauf, offen: null },
    });
    emit(onEvent, { type: 'antwort', record: assistant });

    const index = history.findIndex((m) => m.id === antwortSatz.id);
    const basis = verlaufAus(history.slice(0, index));
    const r = await zug({ chat, assistant, basis, onEvent, signal, effort: effortVon(opts.effort, c.effort) });
    return { chat, message: r.message, stopReason: r.stopReason };
  }

  function antwortText(antwort, frage) {
    if (Array.isArray(antwort)) {
      const liste = antwort.map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean);
      if (!liste.length) throw new ValidationError('Bitte mindestens eine Antwort wählen.');
      if (!frage.mehrfach && liste.length > 1) throw new ValidationError('Bei dieser Frage passt nur eine Antwort.');
      if (liste.length > 6 || liste.some((a) => a.length > 500)) throw new ValidationError('Die Antwort ist zu lang.');
      return liste.join(', ');
    }
    if (typeof antwort !== 'string' || !antwort.trim()) throw new ValidationError('Bitte eine Antwort wählen oder schreiben.');
    if (antwort.length > 500) throw new ValidationError('Die Antwort ist zu lang (höchstens 500 Zeichen).');
    return antwort.trim();
  }

  /* ----------------------------------------------------------- Dienst */

  return {
    create(data = {}) {
      const payload = {};
      for (const key of ['title', 'agentId', 'model', 'systemPrompt', 'network', 'contextNodeIds', 'pinned']) {
        if (data[key] !== undefined) payload[key] = data[key];
      }
      const chat = store.create('chat', payload);
      publish('chat.created', { chatId: chat.id, record: chat });
      return chat;
    },

    update(chatId, patch = {}) {
      const chat = getChat(chatId);
      const allowed = {};
      for (const key of ['title', 'model', 'network', 'systemPrompt', 'contextNodeIds', 'agentId', 'pinned']) {
        if (patch[key] !== undefined) allowed[key] = patch[key];
      }
      if (!Object.keys(allowed).length) return chat;
      return store.update(chat.id, allowed);
    },

    get: getChat,

    messages(chatId, opts = {}) {
      getChat(chatId);
      const all = historyOf(chatId);
      const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
      const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : all.length;
      return { items: all.slice(offset, offset + limit), total: all.length };
    },

    send,
    antworten,
    neuAntworten,
    bearbeiten,

    abort(chatId) {
      const entry = inflight.get(chatId);
      if (!entry) return false;
      entry.controller.abort();
      return true;
    },

    abortAll() {
      let n = 0;
      for (const entry of inflight.values()) {
        entry.controller.abort();
        n++;
      }
      return n;
    },

    isStreaming(chatId) {
      return inflight.has(chatId);
    },

    /** Was die Oberfläche als Zustand eines Chats zeigt: Claude und das Netz. */
    stance(chatId) {
      const chat = getChat(chatId);
      const z = claude.zustand();
      return {
        scope: `chat:${chat.id}`,
        claude: { verbunden: z.verbunden, modell: modellFuer(chat), grund: z.grund, grundCode: z.grundCode },
        netz: z.netz,
        internet: z.netz.erlaubt,
      };
    },

    /**
     * Was beim nächsten Senden an Claude ginge -- ohne zu senden. Für die
     * Frage "was sieht die KI?" und für die Tests.
     */
    preview(chatId) {
      const chat = getChat(chatId);
      const history = historyOf(chat.id);
      const { nachrichten, weg } = kuerzen(verlaufHerrichten(verlaufAus(history)));
      return {
        system: systemBloecke(chat),
        nachrichten,
        weggelassen: weg,
        werkzeuge: DEFINITIONEN.map((w) => w.name),
        modell: modellFuer(chat),
      };
    },

    estimateTokens,
  };
}

module.exports = {
  createChatService,
  estimateTokens,
  sortMessages,
  SYSTEM_FEST,
  MAX_CONTENT_CHARS,
  __internals: { verlaufHerrichten, mitCachePunkt, heuteSatz, firstLine, sortMessages },
};
