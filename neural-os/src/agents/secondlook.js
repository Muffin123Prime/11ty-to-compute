'use strict';

/**
 * Ein zweiter Blick auf eine lange Notiz (IDEEN.md #7).
 *
 * Kein "Zusammenfassen"-Knopf. Drei Antworten auf drei verschiedene Fragen,
 * und -- das ist der Kern dieses Moduls -- sie sind nicht gleich viel wert:
 *
 *   kern              zwei Sätze, was hier eigentlich steht      -- vom Modell
 *   offeneStellen     wo der Text etwas offen lässt              -- vom Modell
 *   bekannteBegriffe  welche Wörter schon anderswo im Tresor
 *                     vorkommen, mit den Einträgen dazu          -- aus dem Index
 *
 * Die Entscheidungen dahinter:
 *
 * 1. **Der dritte Teil braucht kein Modell und hängt auch nicht an einem.**
 *    "Welches Wort aus dieser Notiz kommt anderswo vor" ist Textarbeit und ein
 *    invertierter Index, sonst nichts. Er wird deshalb ZUERST berechnet und
 *    immer geliefert -- auch auf einem Rechner, auf dem nie ein Modell
 *    installiert wurde. Die Antwort sagt dann ehrlich, dass die ersten beiden
 *    Teile fehlen und warum, statt gar nichts zu liefern.
 *
 * 2. **Belegbar heißt nachgeprüft.** Ein Treffer aus dem Volltextindex wird
 *    nicht geglaubt, sondern im Zieltext nachgesehen: der Index expandiert
 *    Wortanfänge (deutsche Komposita), also kann "kaffee" auch über
 *    "kaffeemaschine" treffen. Was in der Liste landet, trägt die Wortform,
 *    die im anderen Eintrag wirklich steht. Nur so darf die Oberfläche diesen
 *    Teil als belegt kennzeichnen und die anderen beiden nicht.
 *
 * 3. **Dieselbe deutsche Faltung wie die Suche** (`fold` aus store/search.js).
 *    "Brühtemperatur" und "Bruehtemperatur" sind ein Begriff, sonst findet
 *    dieser Teil genau bei den Wörtern nichts, bei denen er gebraucht wird.
 *
 * 4. **Eine unlesbare Modellantwort ist ein Fehler, keine Zusammenfassung.**
 *    Kleine Modelle schreiben Prosa um ihr JSON herum; das wird geduldig
 *    ausgepackt (Zaunblöcke, führender Text, balancierte Klammern). Was danach
 *    immer noch kein Objekt mit "kern" ist, wird als ModelError gemeldet. Ein
 *    erfundener Kernsatz wäre genau der Vertrauensbruch, gegen den dieses
 *    System sonst überall anschreibt.
 *
 *    Der Unterschied zu "kein Modell da" ist Absicht: ein fehlendes Modell ist
 *    ein bekannter Zustand des Geräts, ein Modell, das geantwortet hat und
 *    nicht verstanden wurde, ist ein gescheiterter Versuch. Das eine gibt ein
 *    Teilergebnis, das andere wirft.
 *
 * 5. **Dieser Aufruf geht von sich aus nicht ins Netz.** Er bekommt seinen
 *    eigenen Geltungsbereich (`secondlook:<id>`), für den keine Freigabe
 *    existiert, und legt selbst keine an -- genau wie chat.js. Im
 *    Voreinstellungsmodus 'offline' antwortet damit nur ein Modell auf dieser
 *    Maschine. Ob wirklich etwas das Gerät verlassen hat, wird nicht geraten,
 *    sondern an den `network.attempt`-Ereignissen der Schleuse abgelesen.
 *
 * 6. **Geschrieben wird nichts.** Ein zweiter Blick hinterlässt keinen Satz im
 *    Tresor. Wer ihn behalten will, kopiert ihn in die Notiz -- von Hand.
 */

const {
  ValidationError,
  NotFoundError,
  ModelError,
  AbortedError,
  asNeuralError,
} = require('../kernel/errors');
const { fold, tokenSpans } = require('../store/search');

/* ------------------------------------------------------------- Konstanten */

/**
 * Ab hier lohnt sich ein zweiter Blick.
 *
 * Unterhalb von ~500 Zeichen (gut 80 Wörter) sieht man eine Notiz beim Lesen
 * ganz; eine Kernaussage in zwei Sätzen wäre dann länger als die Hälfte des
 * Textes und die offenen Stellen stünden ohnehin vor Augen. Die Schwelle ist
 * eine Ermessensfrage, keine Messung -- sie steht hier, damit die Oberfläche
 * denselben Wert benutzt und der Knopf nie erscheint, wo der Aufruf abgelehnt
 * würde.
 */
const MIN_TEXT_CHARS = 500;

/**
 * So viel Notiz geht ans Modell. Mehr als das sprengt bei einem kleinen
 * lokalen Modell das Fenster, und llama.cpp schneidet dann vorne still ab --
 * also wird hier sichtbar gekürzt und im Ergebnis gesagt, dass gekürzt wurde.
 */
const MAX_MODEL_CHARS = 12000;

/** Kürzer als das ist im Deutschen fast immer Füllwort, nicht Begriff. */
const MIN_TERM_LENGTH = 4;
/** So viele Wörter der Notiz werden überhaupt im Index nachgeschlagen. */
const MAX_CANDIDATES = 60;
/** So viele Begriffe stehen am Ende in der Antwort. */
const MAX_TERMS = 12;
/** So viele Fundstellen je Begriff. */
const MAX_HITS_PER_TERM = 4;
/** So viele offene Stellen werden übernommen, egal wie viele das Modell nennt. */
const MAX_OFFENE = 6;
/** Längenbegrenzungen für das, was aus einer Modellantwort übernommen wird. */
const MAX_KERN_CHARS = 700;
const MAX_STELLE_CHARS = 300;
/** Ohne eigene Angabe: ein kleines Modell darf für diese Aufgabe so lange denken. */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Wo nach einem Begriff gesucht wird.
 *
 * Nachrichten und Läufe stehen mit Absicht NICHT hier: ein Chatverlauf
 * wiederholt jedes Wort, das der Mensch je getippt hat, und dann wäre jeder
 * Begriff "schon anderswo bekannt". Eine Liste, in der alles vorkommt, sagt
 * dasselbe wie eine leere.
 */
const SEARCH_TYPES = ['note', 'project', 'task', 'entity', 'file', 'memory'];

/**
 * Wörter ohne eigenen Inhalt. Bewusst klein gehalten -- dieselbe Begründung
 * wie in graph/view.js: eine 500-Wörter-Liste ist ein verstecktes Sprachmodell
 * und wirft still Begriffe weg, die in einem persönlichen Tresor zählen.
 * Ist die Graph-Einheit da, wird ihre Liste benutzt, damit es eine bleibt.
 */
const FALLBACK_STOPWORDS = new Set([
  'aber', 'auch', 'dann', 'dass', 'doch', 'durch', 'eine', 'einem', 'einen', 'einer', 'eines',
  'etwa', 'gegen', 'haben', 'hatte', 'hier', 'jede', 'jeden', 'jetzt', 'kann', 'kein', 'keine',
  'mehr', 'muss', 'nach', 'nicht', 'noch', 'nur', 'oder', 'ohne', 'schon', 'sehr', 'sein',
  'seine', 'sich', 'sind', 'soll', 'über', 'ueber', 'und', 'unter', 'viel', 'vom', 'von',
  'wenn', 'werden', 'wird', 'wurde', 'zum', 'zur', 'zwischen',
  'that', 'this', 'with', 'from', 'have', 'been', 'will', 'would', 'about', 'there', 'their',
]);

/**
 * Der System-Prompt. Knapp, deutsch, und er verlangt ausdrücklich zweierlei:
 * nichts erfinden, und eine offene Stelle nur nennen, wenn sie im Text
 * wirklich offen ist. Beides steht hier und nicht in einer Konfiguration, weil
 * es die Bedingung dafür ist, dass man dem Ergebnis überhaupt glauben darf.
 */
const SYSTEM_PROMPT = [
  'Du liest eine einzelne Notiz aus dem persönlichen Wissensspeicher eines Menschen.',
  'Antworte ausschließlich mit einem JSON-Objekt, ohne Text davor oder danach:',
  '{"kern": "…", "offeneStellen": ["…"]}',
  '',
  '"kern": die Kernaussage der Notiz in höchstens zwei deutschen Sätzen.',
  '"offeneStellen": Stellen, an denen die Notiz etwas offen lässt — eine Frage ohne Antwort,',
  'eine Entscheidung ohne Ergebnis, eine Zahl ohne Quelle, ein Vorhaben ohne nächsten Schritt.',
  'Je Eintrag höchstens ein Satz, höchstens sechs Einträge.',
  '',
  'Erfinde nichts. Schreibe nur, was im Text steht.',
  'Nenne eine offene Stelle nur, wenn sie im Text wirklich offen bleibt.',
  'Bleibt nichts offen, gib eine leere Liste zurück — das ist eine gültige Antwort.',
  'Keine Einleitung, keine Bewertung, keine Empfehlung, keine Anrede.',
].join('\n');

/* ---------------------------------------------------------------- Helfer */

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clip(value, max) {
  const s = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function dataOf(record) {
  return (record && record.data) || {};
}

/** Titel eines Eintrags, nie leer -- "note_ab12" auf dem Schirm hilft niemandem. */
function labelOf(record) {
  const d = dataOf(record);
  const candidate = d.title || d.name || d.goal
    || (typeof d.text === 'string' ? d.text.slice(0, 80) : '');
  const value = String(candidate || '').trim();
  return value || `${record && record.type ? record.type : 'Eintrag'} ${record && record.id ? record.id : ''}`.trim();
}

/** Der lesbare Text eines Eintrags, in Lesereihenfolge. */
function textOf(record) {
  const d = dataOf(record);
  const parts = [labelOf(record)];
  for (const field of ['body', 'description', 'text', 'content', 'summary']) {
    if (typeof d[field] === 'string' && d[field]) parts.push(d[field]);
  }
  if (Array.isArray(d.tags)) parts.push(d.tags.filter((t) => typeof t === 'string').join(' '));
  if (Array.isArray(d.aliases)) parts.push(d.aliases.filter((t) => typeof t === 'string').join(' '));
  return parts.join('\n');
}

/**
 * Das JSON aus einer Antwort schälen, die auch Prosa enthalten darf.
 *
 * Reihenfolge: Zaunblock (```json … ```), sonst das erste balancierte
 * {…}-Objekt im Text. Balanciert wird wirklich gezählt, mit Rücksicht auf
 * Zeichenketten und Escapes -- ein `lastIndexOf('}')` verschluckt sich an
 * jedem Modell, das nach dem Objekt noch einen Satz anhängt, in dem eine
 * Klammer vorkommt.
 *
 * @returns {string|null} der Textausschnitt, der geparst werden soll
 */
function carveJson(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw);
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  const haystack = fenced ? fenced[1] : text;

  const start = haystack.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = inString; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Die Modellantwort in die beiden Felder übersetzen, die wir versprochen
 * haben. Wirft, sobald etwas fehlt: eine halbe Antwort mit erfundener Hälfte
 * ist schlimmer als eine gemeldete Fehlantwort.
 */
function parseAnswer(raw) {
  const carved = carveJson(raw);
  if (!carved) {
    throw new ModelError(
      'Das Modell hat kein JSON geliefert, sondern freien Text. Ein zweiter Blick wird daraus nicht erfunden.',
      { antwort: clip(raw, 400) },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(carved);
  } catch (err) {
    throw new ModelError(
      `Die Antwort des Modells ist kein gültiges JSON: ${err.message}`,
      { antwort: clip(carved, 400) },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ModelError('Die Antwort des Modells ist kein JSON-Objekt.', { antwort: clip(carved, 400) });
  }

  const kern = typeof parsed.kern === 'string' ? clip(parsed.kern, MAX_KERN_CHARS) : '';
  if (!kern) {
    throw new ModelError(
      'Das Modell hat keine Kernaussage geliefert ("kern" fehlt oder ist leer).',
      { antwort: clip(carved, 400) },
    );
  }

  // Ein fehlendes Feld ist NICHT dasselbe wie eine leere Liste: "nichts bleibt
  // offen" wäre eine Aussage über den Text, "nicht geantwortet" eine über das
  // Modell. Die beiden zu verwechseln wäre die stillste Art zu lügen.
  if (!Array.isArray(parsed.offeneStellen)) {
    throw new ModelError(
      'Das Modell hat die offenen Stellen nicht als Liste geliefert. Eine leere Liste wird daraus nicht gemacht:'
      + ' „nichts bleibt offen" und „keine Antwort" sind nicht dasselbe.',
      { antwort: clip(carved, 400) },
    );
  }

  const offeneStellen = [];
  for (const entry of parsed.offeneStellen) {
    if (offeneStellen.length >= MAX_OFFENE) break;
    let value = '';
    if (typeof entry === 'string') value = entry;
    else if (isPlainObject(entry)) value = entry.text || entry.stelle || entry.frage || '';
    const cleaned = clip(value, MAX_STELLE_CHARS);
    if (cleaned) offeneStellen.push(cleaned);
  }
  return { kern, offeneStellen };
}

/* -------------------------------------------------------------- Fabrik */

/**
 * @param {object} deps
 * @param {object} deps.store      Speicher (nötig)
 * @param {object} [deps.registry] Modell-Registry -- fehlt sie, liefert `look`
 *                                 den Begriffsteil und sagt, was fehlt
 * @param {object} [deps.graph]    Graph-Einheit; nur wegen ihrer Stoppwortliste
 * @param {object} [deps.gate]     Schleuse -- nur zum Einordnen von Adressen
 * @param {object} [deps.bus]      Ereignisbus; Quelle der Netz-Herkunft
 * @param {object} [deps.config]
 * @param {Function|object} [deps.logger]
 */
function createSecondLook({ store, registry, graph, gate, bus, config, logger } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.search !== 'function') {
    throw new ValidationError('createSecondLook benötigt einen Store.');
  }
  const log = typeof logger === 'function' ? logger('secondlook') : (logger || nullLogger());
  const cfg = isPlainObject(config) ? config : {};
  const stopwords = graph && graph.STOPWORDS instanceof Set ? graph.STOPWORDS : FALLBACK_STOPWORDS;

  /* ------------------------------------------------------------ Notiz */

  function getNote(noteId) {
    if (typeof noteId !== 'string' || !noteId.trim()) {
      throw new ValidationError('Es wurde keine Notiz-Kennung übergeben.');
    }
    const record = store.get(noteId);
    if (!record) throw new NotFoundError(`Notiz ${noteId}`);
    if (record.type !== 'note') {
      throw new ValidationError(`Ein zweiter Blick geht nur auf Notizen (${noteId} ist: ${record.type}).`);
    }
    return record;
  }

  /**
   * Titel und Text, so wie ein Mensch die Notiz liest. `titleEnd` ist der
   * Offset, bis zu dem der Titel reicht -- die Wortartenregel weiter unten
   * behandelt ihn anders als den Fließtext.
   */
  function noteText(record) {
    const d = dataOf(record);
    const title = String(d.title || '').trim();
    const body = String(d.body || '').trim();
    const text = title ? `${title}\n\n${body}` : body;
    return { text: text.trimEnd(), titleEnd: title.length };
  }

  /* -------------------------------------------------- bekannte Begriffe */

  /**
   * Steht dieses Wort am Anfang eines Satzes (oder eines Aufzählungspunktes)?
   * Gebraucht für die Regel eine Ebene tiefer.
   */
  function startsSentence(text, start) {
    for (let i = start - 1; i >= 0; i--) {
      const ch = text[i];
      if (/\s/.test(ch)) continue;
      return '.!?:;…•*->#|'.includes(ch);
    }
    return true;
  }

  /**
   * Ist dieses Vorkommen ein Substantiv?
   *
   * Im Deutschen werden Substantive großgeschrieben, und ein Begriff, der zwei
   * Notizen verbindet, ist fast immer ein Substantiv. Das ist die billigste
   * verlässliche Wortartenprüfung, die es für diese Sprache gibt -- und sie
   * ist der Unterschied zwischen einer Liste aus "Brühtemperatur, Mahlgrad"
   * und einer aus "offen, gemessen, bleibt", die zwei Notizen über Kaffee und
   * über Bienenvölker fürs selbe Thema erklärt.
   *
   * Groß am Satzanfang zählt nicht, denn dort ist alles groß. Im TITEL zählt
   * es doch: ein Titel ist kein Satz, sondern der Name, den der Mensch der
   * Sache selbst gegeben hat -- wie ein Schlagwort.
   *
   * Was diese Regel kostet, ehrlich: ein Substantiv, das in dieser Notiz
   * ausschließlich am Satzanfang steht, fällt heraus, und kleingeschriebene
   * englische Fachwörter fallen ebenfalls heraus. Beides ist seltener als der
   * Lärm, den die Regel fernhält.
   */
  function isNoun(text, span, titleEnd) {
    const first = text[span.start];
    if (!first) return false;
    const upper = first.toLocaleUpperCase('de-DE');
    const lower = first.toLocaleLowerCase('de-DE');
    if (first !== upper || upper === lower) return false;
    if (span.start < titleEnd) return true;
    return !startsSentence(text, span.start);
  }

  /**
   * Kandidaten: gefaltete Wörter der Notiz, ohne Stoppwörter, ohne die ganz
   * kurzen und ohne alles, was nirgends als Substantiv auftritt -- in der
   * Reihenfolge ihrer Häufigkeit im Text. Zu jedem wird die Schreibweise
   * gemerkt, die im Text wirklich steht: der Mensch soll sein eigenes Wort
   * wiedererkennen, nicht dessen Umschrift.
   */
  function candidates(text, record, titleEnd) {
    const counts = new Map();
    for (const span of tokenSpans(text, MIN_TERM_LENGTH)) {
      const term = span.term;
      if (term.length < MIN_TERM_LENGTH) continue;
      if (stopwords.has(term)) continue;
      // Reine Zahlen sind keine Begriffe ("2026" verbindet nichts).
      if (!/[a-z]/.test(term)) continue;
      const noun = isNoun(text, span, titleEnd);
      const seen = counts.get(term);
      if (seen) {
        seen.count++;
        if (noun && !seen.noun) {
          seen.noun = true;
          seen.form = text.slice(span.start, span.end);
        }
      } else {
        counts.set(term, { term, form: text.slice(span.start, span.end), count: 1, noun });
      }
    }
    for (const entry of [...counts.keys()]) {
      if (!counts.get(entry).noun) counts.delete(entry);
    }

    // Schlagworte zählen als Begriff, auch wenn sie im Fließtext nicht stehen:
    // sie sind das, was der Mensch selbst als Begriff markiert hat.
    for (const tag of (Array.isArray(dataOf(record).tags) ? dataOf(record).tags : [])) {
      if (typeof tag !== 'string') continue;
      const clean = tag.replace(/^#/, '').trim();
      const folded = fold(clean);
      if (!folded || folded.length < MIN_TERM_LENGTH || stopwords.has(folded)) continue;
      const seen = counts.get(folded);
      if (seen) seen.count += 2;
      else counts.set(folded, { term: folded, form: clean, count: 2, noun: true });
    }

    return [...counts.values()]
      .sort((a, b) => (b.count === a.count ? (a.term < b.term ? -1 : 1) : b.count - a.count))
      .slice(0, MAX_CANDIDATES);
  }

  /**
   * Steht dieser Begriff wirklich in diesem Eintrag?
   *
   * Der Index expandiert Wortanfänge, also kann ein Treffer auch ein Kompositum
   * sein. Beides ist ein ehrlicher Fund, aber nur, wenn wir sagen können,
   * welches Wort es war -- deshalb wird der Zieltext noch einmal zerlegt.
   * @returns {string|null} die gefundene Wortform, oder null
   */
  function wordFormIn(record, term) {
    const text = textOf(record);
    let compound = null;
    for (const span of tokenSpans(text, MIN_TERM_LENGTH)) {
      if (span.term === term) return text.slice(span.start, span.end);
      if (!compound && span.term.startsWith(term)) compound = text.slice(span.start, span.end);
    }
    return compound;
  }

  /**
   * Der dritte Teil: welche Begriffe dieser Notiz anderswo im Tresor stehen.
   * Braucht kein Modell, kein Netz und keine Einbettungen -- nur den Index.
   */
  function knownTerms(record, parts, opts = {}) {
    const types = Array.isArray(opts.types) && opts.types.length ? opts.types : SEARCH_TYPES;
    const found = [];

    for (const candidate of candidates(parts.text, record, parts.titleEnd)) {
      if (found.length >= MAX_TERMS * 2) break;
      let result;
      try {
        result = store.search(candidate.term, { types, limit: MAX_HITS_PER_TERM + 2 });
      } catch (err) {
        // Ein einzelner Begriff, an dem sich der Index verschluckt, darf die
        // übrigen nicht mitnehmen.
        log.warn(`Begriff "${candidate.term}" konnte nicht nachgeschlagen werden: ${err && err.message}`);
        continue;
      }
      const treffer = [];
      for (const hit of result.items) {
        if (treffer.length >= MAX_HITS_PER_TERM) break;
        if (!hit.record || hit.record.id === record.id) continue;
        const wortform = wordFormIn(hit.record, candidate.term);
        if (!wortform) continue; // Der Index hat weiter gegriffen, als der Text hergibt.
        treffer.push({
          id: hit.record.id,
          type: hit.record.type,
          titel: clip(labelOf(hit.record), 120),
          wortform,
          stelle: hit.snippet || '',
        });
      }
      if (!treffer.length) continue;
      found.push({
        begriff: candidate.form,
        form: candidate.term,
        imText: candidate.count,
        anzahl: treffer.length,
        treffer,
      });
    }

    found.sort((a, b) => {
      if (b.anzahl !== a.anzahl) return b.anzahl - a.anzahl;
      if (b.imText !== a.imText) return b.imText - a.imText;
      return a.form < b.form ? -1 : 1;
    });
    return found.slice(0, MAX_TERMS);
  }

  /* --------------------------------------------------------- Netzherkunft */

  /**
   * Was die Schleuse während dieses Aufrufs für genau diesen Geltungsbereich
   * erlaubt hat. Beobachtung, keine Annahme -- wortgleich zu chat.js, und aus
   * demselben Grund: `usedNetwork` ist die Antwort auf "hat das mein Gerät
   * verlassen", und die darf nicht aus der Konfiguration abgelesen werden.
   * Loopback ist diese Maschine, die mit sich selbst spricht: ein Ziel, aber
   * keine Netznutzung.
   */
  function watchEgress(scope) {
    const targets = new Map();
    const state = { usedNetwork: false, targets, blind: !bus || typeof bus.on !== 'function' };
    if (state.blind) return { state, stop() {} };
    const handler = (evt) => {
      const p = evt && evt.payload;
      if (!p || p.allowed !== true || p.scope !== scope) return;
      const host = p.host || p.ip;
      if (!host) return;
      targets.set(p.port ? `${host}:${p.port}` : String(host), p.classification || 'unknown');
      if (p.classification && p.classification !== 'loopback') state.usedNetwork = true;
    };
    bus.on('network.attempt', handler);
    let stopped = false;
    return {
      state,
      stop() {
        if (stopped) return;
        stopped = true;
        try { bus.off('network.attempt', handler); } catch { /* schon abgehängt */ }
      },
    };
  }

  /* ------------------------------------------------------------- Modell */

  /**
   * Gibt es überhaupt ein Modell? Fragt die Registry, ohne zu verbinden.
   * @returns {{target:object|null, grund:string|null, anleitung:string|null}}
   */
  function modelStance(ref) {
    if (!registry || typeof registry.chat !== 'function') {
      return {
        target: null,
        grund: 'In dieser Installation ist keine Modell-Registry eingerichtet.',
        anleitung: null,
      };
    }
    if (typeof registry.resolve !== 'function') return { target: null, grund: null, anleitung: null };
    try {
      return { target: registry.resolve(ref || null), grund: null, anleitung: null };
    } catch (err) {
      const neural = asNeuralError(err);
      if (neural.code !== 'NO_MODEL_AVAILABLE') throw neural;
      let anleitung = null;
      try {
        if (typeof registry.installHint === 'function') anleitung = registry.installHint();
      } catch { /* eine fehlende Anleitung ist kein Grund zu scheitern */ }
      return { target: null, grund: neural.message, anleitung };
    }
  }

  /* --------------------------------------------------------------- look */

  /**
   * Ein zweiter Blick auf eine Notiz.
   *
   * @param {string} noteId
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @param {string} [opts.scope]  Geltungsbereich für die Schleuse; ohne
   *                               Angabe ein eigener, für den keine Freigabe
   *                               existiert
   * @param {*} [opts.model]       Modellwunsch wie bei registry.chat
   * @param {number} [opts.timeoutMs]
   * @param {string[]} [opts.types] Arten, in denen nach Begriffen gesucht wird
   * @returns {Promise<object>}
   */
  async function look(noteId, opts = {}) {
    const started = Date.now();
    const record = getNote(noteId);
    const parts = noteText(record);
    const text = parts.text;

    if (text.length < MIN_TEXT_CHARS) {
      throw new ValidationError(
        `Diese Notiz ist zu kurz für einen zweiten Blick (${text.length} Zeichen, nötig sind ${MIN_TEXT_CHARS}). `
        + 'Bei so wenig Text siehst du beim Lesen schon alles, was ein zweiter Blick sagen könnte.',
        { zeichen: text.length, noetig: MIN_TEXT_CHARS },
      );
    }

    // Zuerst der Teil, der immer geht. Auch wenn gleich alles andere
    // fehlschlägt, ist dieser hier schon berechnet und wird geliefert.
    const bekannteBegriffe = knownTerms(record, parts, { types: opts.types });

    const basis = {
      noteId: record.id,
      titel: labelOf(record),
      zeichen: text.length,
      kern: null,
      offeneStellen: [],
      bekannteBegriffe,
      model: null,
      usedNetwork: false,
      netzZiele: [],
      gekuerzt: false,
      modell: { verfuegbar: false, grund: null, anleitung: null },
      hinweis: null,
      ms: 0,
    };

    const stance = modelStance(opts.model);
    if (!stance.target) {
      basis.modell = { verfuegbar: false, grund: stance.grund, anleitung: stance.anleitung };
      basis.hinweis = bekannteBegriffe.length
        ? 'Kernaussage und offene Stellen brauchen ein Sprachmodell; hier ist gerade keines erreichbar. '
          + 'Die bekannten Begriffe unten stammen aus dem Volltextindex und sind davon unabhängig.'
        : 'Kernaussage und offene Stellen brauchen ein Sprachmodell; hier ist gerade keines erreichbar. '
          + 'Bekannte Begriffe wurden im Volltextindex gesucht, aber keiner aus dieser Notiz kommt bisher '
          + 'anderswo im Tresor vor.';
      basis.ms = Date.now() - started;
      return basis;
    }

    basis.modell = { verfuegbar: true, grund: null, anleitung: null };
    basis.model = { provider: stance.target.providerId || null, model: stance.target.model || null };

    const scope = typeof opts.scope === 'string' && opts.scope.trim()
      ? opts.scope.trim()
      : `secondlook:${record.id}`;
    const egress = watchEgress(scope);

    const payload = text.length > MAX_MODEL_CHARS ? text.slice(0, MAX_MODEL_CHARS) : text;
    basis.gekuerzt = payload.length < text.length;

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: basis.gekuerzt
          ? `${payload}\n\n[Die Notiz ist hier gekürzt; beurteile nur, was du gelesen hast.]`
          : payload,
      },
    ];

    let answer;
    try {
      const result = await registry.chat(opts.model || null, {
        messages,
        // Für diese Aufgabe ist Fantasie kein Vorteil.
        options: { temperature: 0, ...(isPlainObject(opts.options) ? opts.options : {}) },
        scope,
        purpose: `Zweiter Blick auf die Notiz "${labelOf(record)}"`,
        signal: opts.signal,
        timeoutMs: Number.isFinite(opts.timeoutMs)
          ? opts.timeoutMs
          : Number(cfg.secondLookTimeoutMs) || DEFAULT_TIMEOUT_MS,
      });
      answer = result && typeof result.content === 'string' ? result.content : '';
      if (result && result.model) basis.model = { provider: result.provider || basis.model.provider, model: result.model };
    } catch (err) {
      egress.stop();
      const aborted = err instanceof AbortedError || (err && err.name === 'AbortError')
        || (opts.signal && opts.signal.aborted);
      if (aborted) throw new AbortedError('Der zweite Blick wurde abgebrochen.');
      const neural = asNeuralError(err);
      if (neural.code === 'NO_MODEL_AVAILABLE') {
        // Zwischen dem Auflösen und dem Aufruf ist das Modell verschwunden.
        // Das ist kein Fehlschlag des Versuchs, sondern derselbe bekannte
        // Zustand wie oben -- also dasselbe ehrliche Teilergebnis.
        basis.modell = { verfuegbar: false, grund: neural.message, anleitung: null };
        basis.hinweis = 'Das Modell war beim Aufruf nicht mehr erreichbar. Die bekannten Begriffe unten '
          + 'stammen aus dem Volltextindex und sind davon unabhängig.';
        basis.usedNetwork = egress.state.usedNetwork;
        basis.netzZiele = [...egress.state.targets.keys()];
        basis.ms = Date.now() - started;
        return basis;
      }
      throw neural;
    }

    egress.stop();
    basis.usedNetwork = egress.state.usedNetwork;
    basis.netzZiele = [...egress.state.targets.keys()];

    // Wirft, wenn die Antwort nicht lesbar ist. Das ist Absicht: hier wird
    // nichts zusammengereimt.
    const parsed = parseAnswer(answer);
    basis.kern = parsed.kern;
    basis.offeneStellen = parsed.offeneStellen;
    basis.ms = Date.now() - started;
    return basis;
  }

  /**
   * Nur der Teil ohne Modell. Für Aufrufer, die ausdrücklich nichts anderes
   * wollen (und für die Prüfung, dass dieser Teil wirklich allein steht).
   */
  function terms(noteId, opts = {}) {
    const record = getNote(noteId);
    return knownTerms(record, noteText(record), opts);
  }

  /**
   * Was die Oberfläche wissen muss, bevor sie einen Knopf anbietet.
   * Fragt die Schleuse nach der Einordnung der Adresse -- reine Auskunft,
   * keine Auflösung, keine Verbindung.
   */
  function status() {
    const stance = (() => {
      try {
        return modelStance(null);
      } catch (err) {
        return { target: null, grund: asNeuralError(err).message, anleitung: null };
      }
    })();
    let ort = null;
    if (stance.target && gate && typeof gate.classify === 'function') {
      try {
        const host = new URL(String(stance.target.baseUrl)).hostname;
        ort = gate.classify(host) === 'loopback' ? 'lokal' : 'fern';
      } catch {
        ort = null; // Eine Adresse, die sich nicht lesen lässt, wird nicht geraten.
      }
    }
    return {
      minZeichen: MIN_TEXT_CHARS,
      modell: {
        verfuegbar: !!stance.target,
        grund: stance.grund,
        ort,
        model: stance.target ? { provider: stance.target.providerId, model: stance.target.model } : null,
      },
    };
  }

  return { look, terms, status, MIN_TEXT_CHARS };
}

module.exports = {
  createSecondLook,
  MIN_TEXT_CHARS,
  MAX_MODEL_CHARS,
  SYSTEM_PROMPT,
  SEARCH_TYPES,
  /** Nur für Tests. */
  __internals: { carveJson, parseAnswer },
};
