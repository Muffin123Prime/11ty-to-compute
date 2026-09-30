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
 * 7. **Bearbeiten verwirft, statt umzuschreiben.** Was überholt ist, wandert
 *    in den Papierkorb (Ereignis `verworfen {ids}`), und ein ganz normaler
 *    neuer Zug beginnt. Was die KI im verworfenen Zug angelegt hat, bleibt
 *    stehen: es ist eine eigene Handlung mit eigenem "Rückgängig" (`wirkung`
 *    am Agenten-Ereignis), kein Teil des Textes.
 *
 * 8. **Neu erstellen, Umwandeln und Block bearbeiten legen Fassungen an**
 *    (docs/ANTWORT-BAUSTEINE.md 4, src/models/fassungen.js). Die Antwort
 *    bleibt derselbe Satz; die Felder oben sind die aktive Fassung, die
 *    übrigen stehen als Abbild in `versionen`. Nichts geht verloren, und
 *    "‹ 2/3 ›" schaltet zurück. Umwandeln läuft ohne Werkzeuge und ohne
 *    Suche; scheitert es, bleibt die vorige Fassung aktiv.
 *
 * 9. **Anhänge (Bilder, PDF) stehen nur als Kennung in der Nachricht**
 *    (`{type:'anhang', id}` im Verlauf) und werden erst beim Bauen jeder
 *    Anfrage aufgelöst (src/models/anhaenge.js).
 */

// Die Blockform des Verlaufs ist die von Claude; Gemini übersetzt sie in
// beide Richtungen (src/models/providers/gemini.js). Welcher Anbieter gerade
// baut und liest, sagt der Verbund (`ki.anbieterModul()`); ohne Verbund
// (Tests mit einem handgeschriebenen Gegenüber) ist es Claude.
const anthropic = require('./providers/anthropic');
const { createWerkzeuge, DEFINITIONEN, istEigenesWerkzeug, ungueltigErgebnis } = require('./werkzeuge');
const wdh = require('../kalender/wiederholung');
const fassungen = require('./fassungen');
const anhaengeMod = require('./anhaenge');
const zusammenfassenMod = require('./zusammenfassen');
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
 * Absatz "Darstellung" (docs/ANTWORT-BAUSTEINE.md 3): wann welche Form, und
 * der Katalog der Bausteine mit einer Zeile je typ. Er steht im festen Teil
 * (gecacht) und wird beim Umwandeln wiederverwendet, damit "Als Checkliste"
 * dieselbe Form erzeugt wie eine Antwort, die gleich so geschrieben wurde.
 * Byte-stabil: kein Datum, keine Zahl, die sich ändert.
 */
const DARSTELLUNG = [
  'Darstellung:',
  '- Wähle für jede Antwort die einfachste Form, die der Aufgabe dient. Eine einfache Frage bekommt einen kurzen Absatz ohne Überschriften und ohne Bausteine.',
  '- Bausteine nur, wenn sie wirklich helfen: höchstens zwei pro Antwort, dazu höchstens ein aktionen am Ende. Nie zur Dekoration.',
  '- Vergleich → Markdown-Tabelle · Zahlenreihen → diagramm · Auswahl → auswahl · mehrere Angaben nötig → formular · Aufgabe/To-do → checkliste · Anleitung → schritte · langer Stoff → abschnitte oder mehr · Lernen/Üben → quiz, lernkarten, lueckentext, zuordnung · Zeit → timer oder countdown · Terminvorschlag → termin · erzeugte Datei → datei · Webseite, Design, Präsentation → vorschau. Hinweise stehen als > [!info], > [!tipp], > [!achtung], > [!fehler] oder > [!fertig].',
  '- Brauchst du eine Entscheidung, um weiterzuarbeiten (etwa die Uhrzeit für einen Termin oder die erste Frage einer Planung), nimm das Werkzeug rueckfrage, nicht auswahl. auswahl und aktionen sind für das, was in und nach deiner fertigen Antwort bleibt; die Wahl kommt als neue Nachricht. Angebote für nächste Schritte: aktionen (höchstens 4, passend zum Inhalt).',
  '- Ein Text zum Kopieren (Prompt, Nachricht, E-Mail) steht in ```prompt bzw. ```text; eine Datei zum Herunterladen, mit Dateinamen, ist ein Baustein datei.',
  '- Ein Baustein ist ein eigener Codeblock ```ui mit genau einem JSON-Objekt mit "typ", z. B. {"typ":"auswahl","frage":"Wie genau?","optionen":["Kurz","Ausführlich"]}. Gültiges JSON: doppelte Anführungszeichen, keine Kommentare, kein abschließendes Komma; die Texte darin kurz. Kurze Textfelder erlauben Inline-Markdown; Felder "inhalt" sind Markdown und dürfen in tabs, abschnitte, schritte und mehr noch eine Ebene ```ui enthalten. "id" (optional) ist ein fester Schlüssel für den gespeicherten Zustand.',
  '- Bausteine (? = optional):',
  '  auswahl: frage?, optionen [text | {text, beschreibung?, senden?}], mehrfach?, eigene?, stil? knoepfe|liste|umfrage|bestaetigung, knopf?, senden? (Vorlage mit {auswahl})',
  '  aktionen: frage?, aktionen [text | {text, symbol?, senden?}] (höchstens 4)',
  '  formular: titel?, felder [{name, label, art text|textfeld|zahl|datum|uhrzeit|auswahl|mehrfach|schalter|regler, optionen?, wert?, min?, max?, schritt?, pflicht?, platzhalter?}], knopf?',
  '  regler: titel?, regler [{name, label, links, rechts, wert 0–100}], anwenden? stil|senden (stil mit den Namen laenge, fachlich, kreativ setzt den Antwortstil)',
  '  karten: layout? raster|karussell, karten [{titel, symbol?, text?, zeilen? [text], aktion? {text, senden? | link?}}]; symbol: buch, uhr, stern, ziel, idee, datei, kalender, ort, person, haken, blitz, herz, lernen, code, bild, musik, geld, frage oder ein Emoji',
  '  diagramm: art balken|saeulen|linie|flaeche|kreis|ring|vergleich|fortschritt, titel?, einheit?, x? [text], reihen? [{name, werte [zahl]}], teile? [{name, wert}], wert?, ziel?, quelle?; Zeitverläufe sind linie mit Datumsbeschriftungen',
  '  checkliste: titel?, punkte [text | {text, erledigt?}], sortierbar?',
  '  schritte: titel?, schritte [{titel, inhalt}]',
  '  abschnitte: abschnitte [{titel, inhalt, offen?}]',
  '  mehr: inhalt, knopf?',
  '  tabs: tabs [{titel, inhalt}]',
  '  liste: titel?, punkte [text], sortierbar, knopf?',
  '  quiz: titel?, fragen [{frage, optionen [text], richtig zahl | [zahl], erklaerung?}], einzeln?',
  '  lernkarten: titel?, karten [{vorne, hinten}]',
  '  lueckentext: titel?, text mit {{Lösung}} oder {{Lösung|Alternative}}',
  '  zuordnung: titel?, paare [{links, rechts}]',
  '  timer: titel?, dauer "mm:ss" | "hh:mm:ss" | Sekunden',
  '  countdown: titel?, ziel "YYYY-MM-DDTHH:MM"',
  '  termin: titel, start, ende?, ort?, notiz? (Wandzeit ohne Zone) – nur ein Vorschlag; soll er eingetragen werden, benutze termin_anlegen',
  '  datei: name (mit Endung), inhalt (Text), art?',
  '  vorschau: art html|svg|dokument|folien, titel?, inhalt – HTML ist eigenständig: kein CDN, keine externen Dateien, alles inline; folien trennt mit ---',
  '  fortschritt: titel?, wert, ziel?, einheit?',
  '- Bittet er um eine andere Form („Als Tabelle“, „Mach ein Diagramm“, „Nur die wichtigsten Punkte“, „Als Checkliste“, „Schritt für Schritt“, „Nur Text“): derselbe Inhalt in der neuen Form, nichts dazuerfinden.',
  '- Steht in seiner Nachricht [Antwortstil: …], richte Länge, Fachsprache und Kreativität danach.',
].join('\n');

/**
 * Der Modus „Mein Wissen“ (docs/UEBERGABE.md 4.3): Die KI antwortet nur aus
 * dem, was der Nutzer selbst festgehalten hat -- ohne Websuche. Der Satz
 * steht in der Nutzernachricht des Zuges (wie der Antwortstil), nicht im
 * Systemtext: so bleibt der gecachte Anfang fuer beide Modi gleich, und im
 * Verlauf steht, in welchem Modus eine Frage gestellt wurde.
 */
const MODUS_WISSEN = '[Modus „Mein Wissen“: Antworte nur aus dem Wissen des Nutzers. Such mit wissen_suchen, lies mit eintrag_lesen, bevor du etwas daraus sagst. Kein Internet, kein Allgemeinwissen als Quelle. Steht in seinem Wissen nichts dazu, sag genau das in einem Satz.]';

/** Die Modi eines Chats. */
const MODI = Object.freeze(['normal', 'wissen']);

function wissenModus(chat) {
  return !!(chat && chat.data && chat.data.modus === 'wissen');
}

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
  'Fragt er nach etwas, das er selbst festgehalten haben könnte (Notizen, Termine, Aufgaben, Projekte, Gemerktes), such mit wissen_suchen und lies mit eintrag_lesen nach, statt zu raten.',
  '',
  'Für aktuelle Fakten, Nachrichten, Preise, Öffnungszeiten und alles nach deinem Wissensstand benutze die Websuche. Erfinde nichts; wenn du etwas nicht weißt oder nicht finden kannst, sag es.',
  '',
  // Die Oberflaeche macht aus ```prompt / ```text eine Karte mit eigenem
  // "Kopieren" (web/lib/markdown.js, kopierKarten). Ohne diesen Satz landet
  // die Einleitung ("Hier ist dein Prompt:") mit in der Zwischenablage.
  'Will der Nutzer einen Prompt, eine Nachricht, eine E-Mail oder einen anderen Text zum Weiterverwenden, steht genau dieser Text allein in einem Block ```prompt (bzw. ```text) – ohne Einleitung im Block –, damit er ihn mit einem Tipp kopieren kann. Rückfragen stellst du über das Werkzeug rueckfrage mit 2–5 kurzen Optionen.',
  '',
  DARSTELLUNG,
].join('\n');

/**
 * Der Systemtext fürs Umwandeln (docs 4): keine Werkzeuge, keine Suche --
 * nur eine vorhandene Antwort in eine andere Form bringen.
 */
const SYSTEM_UMWANDELN = [
  'Du bist die persönliche KI von Neural OS. Du formst eine Antwort, die du dem Nutzer schon gegeben hast, auf seinen Wunsch um.',
  'Gib nur das Ergebnis aus – ohne Einleitung, ohne Nachsatz, ohne Anführungszeichen oder <<< >>> drumherum. Erfinde nichts dazu, außer die Aufgabe verlangt ausdrücklich mehr. Sprache wie in der Vorlage, außer die Aufgabe nennt eine andere.',
  '',
  DARSTELLUNG,
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
function verlaufHerrichten(nachrichten, modul = anthropic) {
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
    n.content = modul.bloeckeZurueck(n.content, { offeneSuche: i === roh.length - 1 });
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
 * @param {object} deps.claude      der KI-Verbund (src/models/ki.js) oder ein einzelner Anbieter-Dienst
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
  /** Das Anbieter-Modul, das gerade Anfragen baut und Blöcke liest. */
  const modulVon = () => (typeof claude.anbieterModul === 'function' ? claude.anbieterModul() : anthropic);
  const anbieterId = () => modulVon().anbieterId || 'claude';
  const tools = werkzeuge || createWerkzeuge({ store, bus, logger });

  /** chatId -> {controller, messageId, startedAt} */
  const inflight = new Map();
  /** Zusammenfassungen fürs Gehirn, nur im Speicher (src/models/zusammenfassen.js). */
  const zusammenfassungen = zusammenfassenMod.createGedaechtnis();

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
      // Die rohen Blöcke gehören zur Fassung 0 (src/models/fassungen.js).
      // Ist eine spätere aktiv, geht nur ihr Text mit -- das, was der Nutzer liest.
      const spaetere = Number.isInteger(d.version) && d.version > 0;
      const verlauf = !spaetere && c && Array.isArray(c.verlauf) ? c.verlauf : null;
      if (verlauf) {
        for (const n of verlauf) out.push(klon(n));
        // Was nach dem letzten vollständigen Schritt noch ankam (Abbruch,
        // Fehler), steht nur im sichtbaren Text. Claude soll es kennen.
        const rest = fassungen.ohneVerweise(String(d.content || '').slice(Number(c.textImVerlauf) || 0)).trim();
        if (rest && (d.status === 'aborted' || d.status === 'failed')) {
          out.push({ role: 'assistant', content: [{ type: 'text', text: `${rest}\n\n[Diese Antwort wurde unterbrochen.]` }] });
        }
        continue;
      }
      // Nur Text (eine spätere Fassung): ohne die Nummern der Quellen -- die
      // Quellen selbst kennt die KI hier nicht, sie soll keine erfinden.
      const text = fassungen.ohneVerweise(String(d.content || '')).trim();
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
    // Ein Modell des anderen Anbieters zählt nicht: es antwortet der aktive.
    return modulVon().istModell(id) ? id : claude.modell();
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
    const anbieter = modulVon();
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

    // Hat die Antwort Fassungen, zieht der Kopf der aktiven mit (Text, Zustand, Modell).
    const mitKopf = (patch) => {
      const jetzt = store.get(assistant.id) || final;
      return jetzt ? fassungen.kopfAngleichen(jetzt, patch) : patch;
    };

    const claudeDaten = (extra = {}) => ({
      anbieter: anbieter.anbieterId,
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

    /**
     * Ein Eintrag aus dem eigenen Wissen als Quelle (eintrag_lesen): mit der
     * Adresse in der App statt einer Webadresse. Dieselbe Liste und Zaehlung
     * wie die Websuche.
     */
    const eintragQuelle = (q) => {
      if (!q || typeof q.url !== 'string' || !q.url.startsWith('#/')) return;
      if (t.quellen.some((x) => x.url === q.url && x.id === q.id)) return;
      const neu = { titel: String(q.titel || q.id || 'Eintrag').slice(0, 300), url: q.url, art: 'eintrag', id: q.id || null, typ: q.typ || null };
      t.quellen.push(neu);
      emit(onEvent, { type: 'quelle', titel: neu.titel, url: neu.url, art: 'eintrag', id: neu.id, typ: neu.typ });
    };

    /*
     * Quellen im Text (docs/ANTWORT-BAUSTEINE.md 6): hinter dem Satz, der
     * sich auf eine Quelle stuetzt, steht ihre Nummer -- "[1]", dieselbe
     * Zaehlung wie die Liste unter der Antwort. Die Oberflaeche macht daraus
     * einen antippbaren Verweis; als Text bleibt es lesbar (Kopieren,
     * Suche). An Claude geht weiter der rohe Block (t.verlauf), nie die Marke.
     */
    const nummernVon = (urls) => {
      const out = [];
      for (const u of urls) {
        const i = typeof u === 'string' ? t.quellen.findIndex((q) => q.url === u) : -1;
        if (i >= 0 && !out.includes(i + 1)) out.push(i + 1);
      }
      return out;
    };
    const marke = (nummern) => nummern.map((n) => `[${n}]`).join('');
    /**
     * Gemini nennt seine Belege erst am Ende (groundingSupports: welcher
     * Textteil sich auf welche Fundstelle stuetzt). Die Marken kommen dann
     * hinter genau diese Textteile -- nur in dem, was diese Runde schrieb,
     * nie in einen Codeblock -- und der ganze Text geht als `inhalt` neu an
     * die Oberflaeche.
     */
    const belegeEinsetzen = (belege, ab) => {
      let text = t.text;
      let suchAb = ab;
      let geaendert = false;
      for (const b of belege) {
        const n = nummernVon(Array.isArray(b.urls) ? b.urls : []);
        const stueck = String(b.text || '');
        if (!n.length || !stueck.trim()) continue;
        let i = text.indexOf(stueck, suchAb);
        if (i < 0) i = text.indexOf(stueck, ab);
        if (i < 0) continue;
        // Hinter das letzte Zeichen, nicht hinter einen Zeilenumbruch am Ende.
        const ende = i + stueck.trimEnd().length;
        if (fassungen.codebloecke(text).some((c) => ende > c.start && ende <= c.ende)) continue;
        const m = marke(n);
        if (text.slice(ende, ende + m.length) === m) {
          suchAb = ende + m.length;
          continue;
        }
        text = `${text.slice(0, ende)}${m}${text.slice(ende)}`;
        suchAb = ende + m.length;
        geaendert = true;
      }
      if (!geaendert) return;
      t.text = text;
      emit(onEvent, { type: 'inhalt', content: t.text });
      flush(true);
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

    // Welcher Block zuletzt begann: folgt Text auf Text, ist es derselbe Absatz.
    let letzterBlock = null;
    const beiEreignis = (e) => {
      if (e.art === 'start' && e.block) {
        // Ein Textblock nach einem Werkzeug, einer Suche oder einem Gedanken
        // beginnt einen neuen Absatz. Folgt Text direkt auf Text -- Claude
        // teilt einen Absatz an jedem Zitat in Bloecke --, geht der Satz weiter.
        if (e.block.type === 'text' && t.text && !/\s$/.test(t.text) && letzterBlock !== 'text') textDazu('\n\n');
        if (e.block.type === 'thinking' && t.denken && !/\s$/.test(t.denken)) {
          t.denken += '\n\n';
          emit(onEvent, { type: 'denken', delta: '\n\n' });
        }
        if (e.block.type === 'fallback') {
          emit(onEvent, { type: 'hinweis', satz: 'Ein Ersatzmodell von Anthropic hat diese Antwort übernommen.' });
        }
        if (/_tool_result$/.test(e.block.type || '') && e.block.tool_use_id) sucheBeenden(e.block);
        if (e.index !== -1) letzterBlock = e.block.type;
        return;
      }
      if (e.art === 'text') {
        textDazu(e.delta);
      } else if (e.art === 'hinweis' && e.satz) {
        emit(onEvent, { type: 'hinweis', satz: e.satz });
      } else if (e.art === 'denken') {
        t.denken += e.delta;
        emit(onEvent, { type: 'denken', delta: e.delta });
        flush(false);
      } else if (e.art === 'zitat' && e.zitat) {
        quelleDazu(e.zitat.title || e.zitat.document_title, e.zitat.url, 'zitat');
      } else if (e.art === 'ende' && e.block && e.block.type === 'server_tool_use') {
        sucheBeginnen(e.block);
      } else if (e.art === 'ende' && e.block && e.block.type === 'text' && Array.isArray(e.block.citations) && e.block.citations.length
        && String(e.block.text || '').trim()) {
        // Claude: ein Textblock mit Zitaten ist der Satz, der sich auf sie stuetzt.
        const n = nummernVon(e.block.citations.map((z) => z && z.url));
        if (n.length) markeSetzen(marke(n));
      }
    };

    /**
     * Die Marke hinter das Ende des Textes -- vor Leerraum am Schluss (sonst
     * stuende sie am Anfang der naechsten Zeile, vor einem Zaun oder einer
     * Liste), nie in einen Codeblock oder Baustein.
     */
    function markeSetzen(m) {
      const bis = t.text.trimEnd().length;
      if (!bis) return;
      if (fassungen.codebloecke(t.text).some((c) => bis > c.start && (!c.closed || bis <= c.ende))) return;
      if (bis === t.text.length) {
        textDazu(m);
        return;
      }
      t.text = `${t.text.slice(0, bis)}${m}${t.text.slice(bis)}`;
      emit(onEvent, { type: 'inhalt', content: t.text });
      flush(false);
    }

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
    // Base64 der Anhänge einmal je Zug lesen, nicht in jeder Werkzeugrunde.
    const anhangCache = new Map();

    try {
      const system = systemBloecke(chat);
      for (;;) {
        if (controller.signal.aborted) throw new AbortedError('Die Antwort wurde abgebrochen.');
        if (++t.runden > MAX_RUNDEN) {
          stopReason = 'zu_viele_schritte';
          hinweis = 'Diese Antwort brauchte zu viele Schritte; ich habe hier angehalten. Schreib „weiter“, dann mache ich weiter.';
          break;
        }
        const { nachrichten, weg } = kuerzen(verlaufHerrichten([...basis, ...t.verlauf], anbieter));
        if (weg && t.runden === 1) {
          emit(onEvent, { type: 'hinweis', satz: `${weg} ältere Nachricht(en) passen nicht mehr in den Kontext und wurden diesmal weggelassen (nicht zusammengefasst).` });
        }
        const mitAnhaengen = anhaengeMod.aufloesen(nachrichten, {
          anbieter: anbieter.anbieterId || 'claude',
          lesen: anhangLesen,
          cache: anhangCache,
          // Der Rest der Anfrage (Verlauf, Systemtext, Werkzeuge) zählt zur Größengrenze.
          reserve: JSON.stringify(nachrichten).length + JSON.stringify(system).length + 60000,
        });
        const gebaut = anbieter.anfrageBauen({
          modell,
          system,
          werkzeuge: DEFINITIONEN,
          nachrichten: mitCachePunkt(mitAnhaengen.nachrichten),
          effort,
          // „Mein Wissen“: nur eigene Quellen, also keine Websuche.
          websuche: !wissenModus(chat),
        });
        const rundeAb = t.text.length;
        const r = await claude.senden({
          ...gebaut,
          gate,
          scope,
          purpose: `Antwort im Chat „${(chat.data && chat.data.title) || chat.id}“`,
          signal: controller.signal,
          beiEreignis,
        });
        if (Array.isArray(r.belege) && r.belege.length) belegeEinsetzen(r.belege, rundeAb);
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
              for (const q of res.quellen || []) eintragQuelle(q);
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
      final = speichern(mitKopf({
        content: t.text,
        denken: t.denken,
        quellen: t.quellen,
        agenten: t.agenten,
        rueckfragen: t.rueckfragen,
        rueckfrageOffen: wartet,
        status: abgelehnt ? 'failed' : 'complete',
        stats: t.stats,
        model: { provider: anbieter.anbieterId, model: t.modellAntwort || modell },
        usedNetwork: egress.state.usedNetwork || !!(final.data && final.data.usedNetwork),
        networkTargets: [...new Set([...(final.data && final.data.networkTargets) || [], ...egress.state.targets.keys()])],
        abgeschnitten: stopReason === 'max_tokens',
        error: abgelehnt ? { code: anbieter.ABLEHNUNG.code, message: anbieter.ABLEHNUNG.satz } : null,
        claude: claudeDaten({
          stopReason,
          abgelehnt,
          offen: wartet ? t.offen : null,
          stopDetails: null,
        }),
      }));
      if (abgelehnt) emit(onEvent, { type: 'fehler', code: anbieter.ABLEHNUNG.code, satz: anbieter.ABLEHNUNG.satz });
      emit(onEvent, { type: 'fertig', stopReason, record: final });
      publish('chat.message', { chatId: chat.id, record: fuerAussen(final) });
      ableiten(final, chat);
      return { chat, message: final, stopReason };
    } catch (err) {
      for (const lauf of suchen.values()) agentMelden(lauf.fehler('Abgebrochen'));
      suchen.clear();
      egress.stop();
      settled = true;
      const aborted = controller.signal.aborted || (err && err.code === 'ABORTED');
      const e = aborted ? new AbortedError('Die Antwort wurde abgebrochen.') : asNeuralError(err);
      final = speichern(mitKopf({
        content: t.text,
        denken: t.denken,
        quellen: t.quellen,
        agenten: t.agenten,
        rueckfragen: t.rueckfragen,
        rueckfrageOffen: false,
        status: aborted ? 'aborted' : 'failed',
        stats: t.stats,
        model: { provider: anbieter.anbieterId, model: t.modellAntwort || modell },
        usedNetwork: egress.state.usedNetwork,
        networkTargets: [...egress.state.targets.keys()],
        error: { code: e.code, message: e.message },
        claude: claudeDaten({ stopReason: aborted ? 'abgebrochen' : 'fehler', offen: null }),
      }));
      if (!aborted) emit(onEvent, { type: 'fehler', code: e.code, satz: e.message });
      emit(onEvent, { type: 'fertig', stopReason: aborted ? 'abgebrochen' : 'fehler', record: final });
      publish('chat.message', { chatId: chat.id, record: fuerAussen(final) });
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
  function rueckfrageUebergehen(antwort, { ergebnis = 'Übergangen – du hast weitergeschrieben', onEvent = null } = {}) {
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
      const e = tools.laufAbschliessen(f.runId, { zustand: 'fertig', ergebnis });
      if (e) {
        const i = (d.agenten || []).findIndex((a) => a.id === e.id);
        if (i >= 0) d.agenten[i] = { ...d.agenten[i], zustand: 'fertig', ergebnis: e.ergebnis };
        emit(onEvent, { type: 'agent', ...e });
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
   * `anhaenge` sind Kennungen von Dateien, die vorher über
   * `anhangAblegen` für DIESEN Chat hochgeladen wurden (Bilder, PDF). Mit
   * Anhang darf der Text leer sein.
   *
   * @param {{chatId:string, content:string, anhaenge?:string[], signal?:AbortSignal, onEvent?:Function, effort?:string}} opts
   */
  async function send(opts = {}) {
    const { chatId, signal, onEvent } = opts;
    const content = typeof opts.content === 'string' ? opts.content : '';
    const ids = opts.anhaenge === undefined || opts.anhaenge === null ? [] : opts.anhaenge;
    if (!Array.isArray(ids)) throw new ValidationError('"anhaenge" muss eine Liste von Kennungen sein.');
    if (!content.trim() && !ids.length) throw new ValidationError('Die Nachricht ist leer.');
    if (content.length > MAX_CONTENT_CHARS) {
      throw new ValidationError(`Die Nachricht ist zu lang (${content.length} Zeichen, erlaubt sind ${MAX_CONTENT_CHARS}).`);
    }
    let chat = getChat(chatId);
    if (inflight.has(chat.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du erneut sendest.');
    }
    const anhaenge = anhaengeFuer(chat, ids);
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
      ...(anhaenge.length ? { anhaenge } : {}),
      claude: { inhalt: nutzerInhalt(content, chat, anhaenge) },
    });
    emit(onEvent, { type: 'nutzer', record: userMessage });
    publish('chat.message', { chatId: chat.id, record: fuerAussen(userMessage) });

    const titel = String((chat.data && chat.data.title) || '').trim();
    if (!history.some((m) => m.data.role === 'user') && (!titel || titel === 'Neuer Chat')) {
      const neu = firstLine(content, 60) || (anhaenge[0] && firstLine(anhaenge[0].name, 60));
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
      model: { provider: anbieterId(), model: modell },
      ordinal,
      denken: '',
      quellen: [],
      agenten: [],
      rueckfragen: [],
      rueckfrageOffen: false,
      claude: { anbieter: anbieterId(), modell, effort, verlauf: [], textImVerlauf: 0 },
    });
    emit(onEvent, { type: 'antwort', record: assistant });
    publish('chat.message', { chatId: chat.id, record: fuerAussen(assistant) });
    return assistant;
  }

  /**
   * Die Blöcke der Nutzernachricht, wie sie gespeichert und gesendet werden:
   * Datumssatz, Antwortstil (wenn gesetzt), Anhänge als Kennung, Text. Einmal
   * gebaut und dann unverändert wiederverwendet -- der Anfang jeder späteren
   * Anfrage bleibt so byte-gleich (Caching).
   */
  function nutzerInhalt(content, chat, anhaenge, heute = heuteSatz()) {
    const bloecke = [{ type: 'text', text: heute }];
    const stil = fassungen.stilSatz(chat && chat.data && chat.data.stil);
    if (stil) bloecke.push({ type: 'text', text: stil });
    if (wissenModus(chat)) bloecke.push({ type: 'text', text: MODUS_WISSEN });
    for (const a of anhaenge || []) bloecke.push({ type: 'anhang', id: a.id, name: a.name, mime: a.mime });
    if (String(content || '').trim()) bloecke.push({ type: 'text', text: content });
    return bloecke;
  }

  /* ------------------------------------------------------------ Anhänge */

  /** Die Kennungen einer Nachricht prüfen: Dateien dieses Chats, Bild oder PDF. */
  function anhaengeFuer(chat, ids) {
    if (!ids.length) return [];
    if (ids.length > anhaengeMod.MAX_ANHAENGE_JE_NACHRICHT) {
      throw new ValidationError(`Höchstens ${anhaengeMod.MAX_ANHAENGE_JE_NACHRICHT} Anhänge je Nachricht.`);
    }
    const out = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !id) throw new ValidationError('"anhaenge" enthält eine ungültige Kennung.');
      if (out.some((a) => a.id === id)) continue;
      const rec = store.get(id);
      const d = (rec && rec.data) || {};
      const passt = rec && rec.type === 'file' && d.chatId === chat.id
        && (anhaengeMod.BILD_MIME.has(d.mime) || d.mime === anhaengeMod.PDF_MIME);
      if (!passt) throw new NotFoundError(`Anhang ${id}`);
      out.push({ id: rec.id, name: String(d.name || 'anhang'), mime: d.mime, size: Number(d.size) || 0 });
    }
    return out;
  }

  /** Die Bytes eines Anhangs (für die Anfrage an die KI) -- oder null. */
  function anhangLesen(id) {
    const rec = store.get(id);
    if (!rec || rec.type !== 'file' || !rec.data || !rec.data.hash) return null;
    if (!store.files || typeof store.files.read !== 'function') return null;
    return { buf: store.files.read(rec.data.hash), mime: rec.data.mime, name: rec.data.name };
  }

  /**
   * Eine Datei für den Chat ablegen (Bild oder PDF, Base64). Die Art wird
   * am Inhalt geprüft; der Blob liegt in der Ablage, verschlüsselt, wenn
   * der Tresor es ist. Gibt zurück, was die Oberfläche braucht.
   */
  function anhangAblegen({ chatId, name, mime, daten } = {}) {
    const chat = getChat(chatId);
    if (!store.files || typeof store.files.put !== 'function') {
      throw new NeuralError('SUBSYSTEM_UNAVAILABLE', 'Dieser Speicher hat kein Ablagefach für Dateien.', { status: 503 });
    }
    let p;
    try {
      p = anhaengeMod.anhangPruefen({ name, mime, daten });
    } catch (err) {
      throw new NeuralError(err.code || 'VALIDATION_ERROR', err.satz || err.message, { status: err.status || 400 });
    }
    const abgelegt = store.files.put(p.buf, { name: p.name, mime: p.mime });
    const record = store.create('file', {
      name: p.name, hash: abgelegt.hash, mime: p.mime, size: p.buf.length, chatId: chat.id, quelle: 'chat',
    });
    return {
      anhang: {
        id: record.id, name: p.name, mime: p.mime, size: p.buf.length, art: p.art,
        url: `/api/chats/${chat.id}/anhaenge/${record.id}`,
      },
    };
  }

  /** Eine abgelegte Datei dieses Chats lesen (für GET …/anhaenge/:id). */
  function anhangDatei(chatId, id) {
    const chat = getChat(chatId);
    const rec = typeof id === 'string' ? store.get(id) : null;
    if (!rec || rec.type !== 'file' || !rec.data || rec.data.chatId !== chat.id || !rec.data.hash) {
      throw new NotFoundError(`Anhang ${id}`);
    }
    return { buf: store.files.read(rec.data.hash), mime: rec.data.mime, name: rec.data.name, size: rec.data.size };
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
   * Die letzte Antwort neu erstellen -- als NEUE FASSUNG derselben Antwort
   * (docs/ANTWORT-BAUSTEINE.md 4). Die bisherige bleibt als Fassung
   * erhalten und lässt sich wieder wählen. Claude antwortet noch einmal auf
   * genau dieselbe Nachricht (mit ihrem damaligen Datumssatz -- der Anfang
   * bleibt gleich, der Cache greift); eine `variante` hängt für diesen einen
   * Aufruf einen Satz an (kürzer, einfacher, …, mit der bisherigen Antwort).
   *
   * Nur die letzte Antwort: ein Zug mit Werkzeugen mitten im Verlauf hätte
   * einen Verlauf danach, der nicht mehr zu ihm passt. Ältere Antworten
   * lassen sich umwandeln (ohne Werkzeuge).
   *
   * @param {{chatId:string, messageId?:string, variante?:string, stil?:object, signal?:AbortSignal, onEvent?:Function, effort?:string}} opts
   */
  async function neuAntworten(opts = {}) {
    const { chatId, signal, onEvent } = opts;
    let chat = getChat(chatId);
    if (inflight.has(chat.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du neu antworten lässt.');
    }
    const variante = opts.variante === undefined || opts.variante === null || opts.variante === '' ? null : opts.variante;
    if (variante !== null && (typeof variante !== 'string' || !Object.prototype.hasOwnProperty.call(fassungen.VARIANTEN, variante))) {
      throw new ValidationError(`Unbekannte Variante „${String(variante).slice(0, 40)}“. Möglich: ${Object.keys(fassungen.VARIANTEN).join(', ')}.`);
    }
    const stilNeu = opts.stil === undefined ? undefined : stilLesen(opts.stil);
    claude.zugang();
    if (stilNeu !== undefined) chat = store.update(chat.id, { stil: stilNeu });
    const history = historyOf(chat.id);
    let letzte = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].data && history[i].data.role === 'user') { letzte = i; break; }
    }
    if (letzte < 0) throw new ValidationError('Hier gibt es noch keine Frage, auf die ich neu antworten könnte.');
    const danach = history.slice(letzte + 1);
    const antwortSatz = danach.find((m) => m.data && m.data.role === 'assistant') || null;
    if (opts.messageId && (!antwortSatz || antwortSatz.id !== opts.messageId)) {
      throw new NeuralError('NUR_LETZTE_ANTWORT', 'Neu erstellen geht bei der letzten Antwort. Eine ältere lässt sich umwandeln.', { status: 409 });
    }
    const effort = effortDer(danach, opts.effort);
    // Was sonst noch nach der Frage steht (eine zweite, abgebrochene Antwort), ist überholt.
    verwerfen(danach.filter((m) => !antwortSatz || m.id !== antwortSatz.id), onEvent, chat.id);
    const frage = stilAngleichen(history[letzte], chat);
    const bisher = antwortSatz ? String(antwortSatz.data.content || '') : '';
    const assistant = antwortSatz
      ? fassungFuerNeu(chat, antwortSatz, effort, variante, onEvent)
      : antwortAnlegen(chat, nextOrdinal(history), effort, onEvent);
    const basis = verlaufAus([...history.slice(0, letzte), frage]);
    const zusatz = variantenSatz(variante, bisher);
    const letzteNachricht = basis[basis.length - 1];
    if (zusatz && letzteNachricht && letzteNachricht.role === 'user') {
      letzteNachricht.content = [...letzteNachricht.content, { type: 'text', text: zusatz }];
    }
    const r = await zug({ chat, assistant, basis, onEvent, signal, effort });
    return { chat, message: r.message, stopReason: r.stopReason };
  }

  /** Den Antwortstil prüfen (für PATCH /api/chats/:id und neu-antworten). */
  function stilLesen(roh) {
    try {
      return fassungen.stilPruefen(roh);
    } catch (err) {
      throw new ValidationError(err.satz || err.message);
    }
  }

  /** Der Modus eines Chats: 'normal' oder 'wissen' („Mein Wissen“). */
  function modusLesen(roh) {
    const m = roh === null ? 'normal' : roh;
    if (!MODI.includes(m)) throw new ValidationError(`Unbekannter Modus „${String(roh).slice(0, 40)}“. Möglich: ${MODI.join(', ')}.`);
    return m;
  }

  /**
   * Der Stil-Satz in der Frage folgt dem jetzigen Stil des Chats, wenn neu
   * erstellt wird (Regler "stil": dieselbe Frage, neuer Stil). Gespeichert,
   * damit der Verlauf danach genau das zeigt, was gesendet wurde.
   */
  function stilAngleichen(frage, chat) {
    const c = frage.data && frage.data.claude;
    if (!c || !Array.isArray(c.inhalt) || !c.inhalt.length) return frage;
    const ohne = c.inhalt.filter((b) => !(b && b.type === 'text' && String(b.text || '').startsWith(fassungen.STIL_PRAEFIX)));
    const soll = fassungen.stilSatz(chat.data && chat.data.stil);
    const neu = soll ? [ohne[0], { type: 'text', text: soll }, ...ohne.slice(1)] : ohne;
    if (JSON.stringify(neu) === JSON.stringify(c.inhalt)) return frage;
    return store.update(frage.id, { claude: { ...c, inhalt: neu } });
  }

  /** Der Satz für eine Variante, samt der bisherigen Antwort ("kürzer als was?"). */
  function variantenSatz(variante, bisher) {
    const satz = variante ? fassungen.VARIANTEN[variante] : null;
    if (!satz) return null;
    const alt = fassungen.ohneVerweise(String(bisher || '')).trim();
    if (!alt) return `[Neu erstellen: ${satz}]`;
    const gekuerzt = alt.length > 12000 ? `${alt.slice(0, 12000)} …` : alt;
    return `[Neu erstellen: ${satz}]\n\nDie bisherige Antwort:\n<<<\n${gekuerzt}\n>>>`;
  }

  /**
   * Die bisherige Fassung sichern und eine leere, laufende neue Fassung
   * derselben Antwort anlegen. Eine offene Rückfrage der bisherigen ist damit
   * erledigt (sonst stünde ihr Planungs-Agent ewig auf "läuft").
   */
  function fassungFuerNeu(chat, antwortSatz, effort, variante, onEvent) {
    const satz = rueckfrageUebergehen(antwortSatz, { ergebnis: 'Verworfen – die Antwort wurde neu erstellt', onEvent });
    const modell = modellFuer(chat);
    const { patch } = fassungen.neueFassung(satz, { art: 'neu', anweisung: variante, modell }, {
      content: '',
      status: 'streaming',
      denken: '',
      quellen: [],
      agenten: [],
      rueckfragen: [],
      rueckfrageOffen: false,
      error: null,
      abgeschnitten: false,
      stats: {},
      usedNetwork: false,
      networkTargets: [],
      model: { provider: anbieterId(), model: modell },
      claude: { anbieter: anbieterId(), modell, effort, verlauf: [], textImVerlauf: 0 },
    });
    const neu = store.update(satz.id, patch);
    fassungMelden(chat, neu, onEvent);
    return neu;
  }

  /** Eine neue (oder gewählte) Fassung melden: `fassung` plus der Satz als `antwort`. */
  function fassungMelden(chat, rec, onEvent) {
    const f = fassungen.fuerOberflaeche(rec);
    emit(onEvent, {
      type: 'fassung', messageId: rec.id, version: f.version, anzahl: f.versionen.length, art: f.versionen[f.version].art,
    });
    emit(onEvent, { type: 'antwort', record: rec });
    publish('chat.message', { chatId: chat.id, record: fuerAussen(rec) });
  }

  /**
   * Eine eigene Nachricht ändern: alles danach fällt weg, die Nachricht
   * bekommt den neuen Text (und einen neuen Datumssatz -- sie wird ja jetzt
   * gestellt), und Claude antwortet neu.
   *
   * @param {{chatId:string, messageId:string, content:string, signal?:AbortSignal, onEvent?:Function, effort?:string}} opts
   */
  async function bearbeiten(opts = {}) {
    const { chatId, messageId, signal, onEvent } = opts;
    const content = typeof opts.content === 'string' ? opts.content : '';
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
    const alt = history[index];
    // Die Anhänge bleiben an der Nachricht; mit ihnen darf der Text leer sein.
    const anhaenge = Array.isArray(alt.data.anhaenge) ? alt.data.anhaenge : [];
    if (!content.trim() && !anhaenge.length) throw new ValidationError('Die Nachricht ist leer.');
    claude.zugang();
    const weg = history.slice(index + 1);
    const effort = effortDer(weg, opts.effort);
    verwerfen(weg, onEvent, chat.id);

    const userMessage = store.update(alt.id, {
      content,
      bearbeitetAm: new Date().toISOString(),
      claude: { inhalt: nutzerInhalt(content, chat, anhaenge) },
    });
    emit(onEvent, { type: 'nutzer', record: userMessage });
    publish('chat.message', { chatId: chat.id, record: fuerAussen(userMessage) });

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

  /* --------------------------------------------- Fassungen einer Antwort */

  /** Eine Antwort (role assistant) dieses Chats -- oder 404. */
  function antwortVon(chat, messageId) {
    const rec = typeof messageId === 'string' && messageId ? store.get(messageId) : null;
    if (!rec || rec.type !== 'message' || !rec.data || rec.data.chatId !== chat.id || rec.data.role !== 'assistant') {
      throw new NotFoundError(`Antwort ${messageId}`);
    }
    return rec;
  }

  function nichtBeschaeftigt(chat) {
    if (inflight.has(chat.id)) {
      throw new ValidationError('Für diesen Chat läuft gerade eine Antwort. Warte, bis sie fertig ist, oder brich sie ab.');
    }
  }

  /** Der Text der Frage, auf die eine Antwort antwortet (für Umwandeln). */
  function frageVor(chat, satz) {
    const history = historyOf(chat.id);
    const i = history.findIndex((m) => m.id === satz.id);
    for (let j = i - 1; j >= 0; j--) {
      if (history[j].data && history[j].data.role === 'user') return String(history[j].data.content || '');
    }
    return '';
  }

  /**
   * Eine einfache Anfrage an die aktive KI: ohne Werkzeuge, ohne Websuche,
   * mit wenig Aufwand (effort low). Für Umwandeln und Zusammenfassen.
   * Liefert den sichtbaren Text; eine Ablehnung oder ein abgeschnittenes
   * Ergebnis ist ein Fehler, keine halbe Fassung.
   */
  async function einfacherAufruf({ chat, system, nachrichten, signal, beiText, purpose, maxTokens = 32000 }) {
    const anbieter = modulVon();
    const modell = chat ? modellFuer(chat) : claude.modell();
    const gebaut = anbieter.anfrageBauen({
      modell,
      system: [{ type: 'text', text: system }],
      werkzeuge: [],
      nachrichten,
      effort: 'low',
      websuche: false,
      maxTokens,
    });
    const r = await claude.senden({
      ...gebaut,
      gate,
      scope: chat ? `chat:${chat.id}` : 'global',
      purpose,
      signal,
      beiEreignis: (e) => {
        if (e && e.art === 'text' && e.delta && typeof beiText === 'function') beiText(e.delta);
      },
    });
    if (r.stopReason === 'refusal') {
      throw new NeuralError(anbieter.ABLEHNUNG.code, anbieter.ABLEHNUNG.satz, { status: 422 });
    }
    if (r.stopReason === 'max_tokens') {
      throw new NeuralError('ZU_LANG', 'Das Ergebnis wurde zu lang und wäre abgeschnitten. Die bisherige Fassung bleibt.', { status: 422 });
    }
    const text = (r.inhalt || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    return { text, modell: r.modell || modell, usage: r.usage };
  }

  /**
   * Umwandeln vorbereiten und prüfen -- ALLES, was abgelehnt werden kann,
   * bevor ein Strom öffnet (die Route antwortet dann mit Statuscode):
   * unbekannte Antwort, leere Antwort, offene Rückfrage, ungültige
   * Anweisung, eine markierte Stelle, die sich nicht eindeutig finden lässt
   * (409 AUSWAHL_NICHT_GEFUNDEN).
   */
  function umwandelnPruefen(opts = {}) {
    const chat = getChat(opts.chatId);
    const satz = antwortVon(chat, opts.messageId);
    nichtBeschaeftigt(chat);
    const text = String(satz.data.content || '');
    if (!text.trim()) {
      throw new NeuralError('NICHTS_ZUM_UMWANDELN', 'Diese Antwort hat noch keinen Text, den ich umwandeln könnte.', { status: 409 });
    }
    if (satz.data.rueckfrageOffen) {
      throw new NeuralError('RUECKFRAGE_OFFEN', 'Diese Antwort wartet noch auf deine Antwort auf die Rückfrage. Beantworte sie zuerst.', { status: 409 });
    }
    const roh = opts.auswahl;
    const mitAuswahl = roh !== undefined && roh !== null && roh !== '';
    if (mitAuswahl && (typeof roh !== 'string' || roh.length > 20000)) {
      throw new ValidationError('"auswahl" muss der markierte Text sein (höchstens 20 000 Zeichen).');
    }
    let anweisung;
    try {
      anweisung = fassungen.anweisungSatz(opts.anweisung, { sprache: opts.sprache, stelle: mitAuswahl });
    } catch (err) {
      throw new ValidationError(err.satz || err.message);
    }
    let stelle = null;
    if (mitAuswahl) {
      const vorkommen = Number.isInteger(opts.vorkommen) ? opts.vorkommen : undefined;
      try {
        stelle = fassungen.stelleFinden(text, roh, vorkommen);
      } catch (err) {
        throw new NeuralError('AUSWAHL_NICHT_GEFUNDEN', err.satz || err.message, { status: 409, details: err.details || null });
      }
    }
    return { chat, satz, anweisung, stelle };
  }

  /**
   * Eine Antwort umwandeln (docs 4): die aktive Fassung in eine neue Form
   * bringen -- ganz oder nur die markierte Stelle. Ergebnis ist eine neue
   * Fassung `umgewandelt`. Ereignisse: fassung, antwort (der Satz mit der
   * neuen, laufenden Fassung), text {delta} (ganze Antwort) bzw. inhalt
   * {content} (markierte Stelle, der ganze Text mit der neuen Stelle),
   * fehler, fertig. Scheitert es oder wird abgebrochen, ist wieder die
   * vorige Fassung aktiv -- eine halbe Umwandlung wird keine Fassung.
   *
   * @param {{chatId, messageId, anweisung, sprache?, auswahl?, vorkommen?, signal?, onEvent?}} opts
   */
  async function umwandeln(opts = {}) {
    const { signal, onEvent } = opts;
    const plan = umwandelnPruefen(opts);
    const { chat, anweisung, stelle } = plan;
    let satz = plan.satz;
    claude.zugang();
    const quelle = String(satz.data.content || '');
    const frage = frageVor(chat, satz);
    const anbieter = modulVon();
    const modell = modellFuer(chat);
    // Was die KI im Tresor angelegt hat, bleibt sichtbar (mit Rückgängig) -- am Ende der neuen Fassung.
    const wirkungen = (Array.isArray(satz.data.agenten) ? satz.data.agenten : [])
      .filter((a) => a && a.zustand === 'fertig' && Array.isArray(a.wirkung) && a.wirkung.length);
    const { patch, vorige } = fassungen.neueFassung(satz, {
      art: 'umgewandelt',
      anweisung: anweisung.schluessel || String(opts.anweisung).trim().slice(0, 200),
      sprache: anweisung.schluessel === 'uebersetzen' ? String(opts.sprache).trim() : undefined,
      auswahl: stelle ? true : undefined,
      modell,
    }, {
      content: stelle ? quelle : '',
      status: 'streaming',
      denken: '',
      quellen: klon(satz.data.quellen || []),
      agenten: [],
      rueckfragen: [],
      rueckfrageOffen: false,
      error: null,
      abgeschnitten: false,
      stats: {},
      usedNetwork: false,
      networkTargets: [],
      model: { provider: anbieter.anbieterId || anbieterId(), model: modell },
      claude: null,
    });
    satz = store.update(satz.id, patch);
    fassungMelden(chat, satz, onEvent);

    const controller = new AbortController();
    const beiAussen = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', beiAussen, { once: true });
    }
    inflight.set(chat.id, { controller, messageId: satz.id, startedAt: Date.now() });
    const egress = watchEgress(`chat:${chat.id}`);

    let text = '';
    let zuletzt = 0;
    const mitStelle = (t) => `${quelle.slice(0, stelle.start)}${t}${quelle.slice(stelle.ende)}`;
    const beiText = (delta) => {
      text += delta;
      if (!stelle) emit(onEvent, { type: 'text', delta });
      const jetzt = Date.now();
      if (jetzt - zuletzt < (stelle ? 150 : FLUSH_INTERVAL_MS)) return;
      zuletzt = jetzt;
      if (stelle) emit(onEvent, { type: 'inhalt', content: mitStelle(fassungen.antwortSaeubern(text)) });
      try { store.update(satz.id, { content: stelle ? mitStelle(text) : text }); } catch { /* der Endstand zählt */ }
    };

    const bloecke = [];
    if (frage.trim()) bloecke.push({ type: 'text', text: `Die Frage des Nutzers war:\n<<<\n${frage.slice(0, 8000)}\n>>>` });
    if (stelle) {
      bloecke.push({ type: 'text', text: `Deine Antwort (nur zum Zusammenhang):\n<<<\n${quelle}\n>>>` });
      bloecke.push({ type: 'text', text: `Die markierte Stelle (Markdown):\n<<<\n${stelle.stelle}\n>>>` });
      bloecke.push({ type: 'text', text: `Aufgabe: ${anweisung.satz}\nGib nur den neuen Text für die markierte Stelle aus – nicht den Rest der Antwort. Behalte die Markdown-Auszeichnung der Stelle bei, soweit sie passt.` });
    } else {
      bloecke.push({ type: 'text', text: `Deine bisherige Antwort:\n<<<\n${quelle}\n>>>` });
      bloecke.push({ type: 'text', text: `Aufgabe: ${anweisung.satz}\nGib nur die neue Fassung der ganzen Antwort aus.` });
    }

    try {
      const r = await einfacherAufruf({
        chat,
        system: SYSTEM_UMWANDELN,
        nachrichten: [{ role: 'user', content: bloecke }],
        signal: controller.signal,
        beiText,
        purpose: `Antwort umwandeln im Chat „${(chat.data && chat.data.title) || chat.id}“`,
      });
      if (controller.signal.aborted) throw new AbortedError('Das Umwandeln wurde abgebrochen.');
      const ergebnis = fassungen.antwortSaeubern(r.text);
      if (!ergebnis) {
        throw new NeuralError('KEINE_ANTWORT', 'Die KI hat keine neue Fassung geliefert. Die bisherige bleibt.', { status: 502 });
      }
      const neuerText = stelle ? mitStelle(ergebnis) : ergebnis;
      const agenten = wirkungen.map((a) => ({ ...klon(a), beiZeichen: neuerText.length }));
      egress.stop();
      const jetzt = store.get(satz.id) || satz;
      const final = store.update(satz.id, fassungen.kopfAngleichen(jetzt, {
        content: neuerText,
        status: 'complete',
        agenten,
        stats: statsAddieren({}, r.usage),
        model: { provider: anbieter.anbieterId || anbieterId(), model: r.modell || modell },
        usedNetwork: egress.state.usedNetwork,
        networkTargets: [...egress.state.targets.keys()],
      }));
      if (stelle) emit(onEvent, { type: 'inhalt', content: neuerText });
      emit(onEvent, { type: 'fertig', stopReason: 'end_turn', record: final });
      publish('chat.message', { chatId: chat.id, record: fuerAussen(final) });
      ableiten(final, chat);
      return { chat, message: final, stopReason: 'end_turn' };
    } catch (err) {
      egress.stop();
      const abgebrochen = controller.signal.aborted || (err && err.code === 'ABORTED');
      const e = abgebrochen ? new AbortedError('Das Umwandeln wurde abgebrochen. Die bisherige Fassung bleibt.') : asNeuralError(err);
      let final = store.get(satz.id) || satz;
      try {
        const zurueck = fassungen.fassungZuruecknehmen(final, vorige);
        if (zurueck) final = store.update(satz.id, zurueck);
      } catch (inner) {
        log.warn(`Fassung von ${satz.id} nicht zurückgenommen: ${inner && inner.message}`);
      }
      if (!abgebrochen) emit(onEvent, { type: 'fehler', code: e.code, satz: e.message });
      emit(onEvent, { type: 'fertig', stopReason: abgebrochen ? 'abgebrochen' : 'fehler', record: final });
      publish('chat.message', { chatId: chat.id, record: fuerAussen(final) });
      throw e;
    } finally {
      inflight.delete(chat.id);
      if (signal) {
        try { signal.removeEventListener('abort', beiAussen); } catch { /* egal */ }
      }
    }
  }

  /**
   * Eine andere Fassung aktiv machen (PATCH …/version). Eine offene
   * Rückfrage der bisherigen gilt dann als übergangen.
   */
  function fassungWaehlen({ chatId, messageId, version } = {}) {
    const chat = getChat(chatId);
    let satz = antwortVon(chat, messageId);
    nichtBeschaeftigt(chat);
    if (!Number.isInteger(version)) throw new ValidationError('"version" muss eine ganze Zahl sein (0 = das Original).');
    const { versionen } = fassungen.fassungenLesen(satz);
    if (version < 0 || version >= versionen.length) throw new NotFoundError(`Fassung ${version}`);
    if (satz.data.rueckfrageOffen) {
      satz = rueckfrageUebergehen(satz, { ergebnis: 'Übergangen – du hast eine andere Fassung gewählt' });
    }
    const patch = fassungen.fassungWaehlen(satz, version);
    if (!patch) return satz;
    const neu = store.update(satz.id, patch);
    publish('chat.message', { chatId: chat.id, record: fuerAussen(neu) });
    // Suche und Gehirn sehen nur die aktive Fassung: die Verknüpfungen folgen ihr.
    ableiten(neu, chat);
    return neu;
  }

  /**
   * Einen Codeblock der aktiven Fassung bearbeiten (PATCH …/block): Code,
   * Prompt, Text -- oder `inhalt` eines Bausteins datei/vorschau. Ergebnis
   * ist eine neue Fassung `bearbeitet`.
   */
  function blockBearbeiten({ chatId, messageId, nr, inhalt, alt } = {}) {
    const chat = getChat(chatId);
    const satz = antwortVon(chat, messageId);
    nichtBeschaeftigt(chat);
    if (!Number.isInteger(nr) || nr < 0) throw new ValidationError('"nr" muss die Nummer des Blocks sein (0 = der erste).');
    if (typeof inhalt !== 'string') throw new ValidationError('"inhalt" fehlt.');
    if (inhalt.length > MAX_CONTENT_CHARS) throw new ValidationError(`Der Block ist zu lang (höchstens ${MAX_CONTENT_CHARS} Zeichen).`);
    if (alt !== undefined && alt !== null && typeof alt !== 'string') throw new ValidationError('"alt" muss der bisherige Inhalt des Blocks sein.');
    if (satz.data.rueckfrageOffen) {
      throw new NeuralError('RUECKFRAGE_OFFEN', 'Diese Antwort wartet noch auf deine Antwort auf die Rückfrage. Beantworte sie zuerst.', { status: 409 });
    }
    const text = String(satz.data.content || '');
    let r;
    try {
      r = fassungen.blockErsetzen(text, nr, inhalt, alt === null ? undefined : alt);
    } catch (err) {
      throw new NeuralError(err.code || 'BLOCK_NICHT_GEFUNDEN', err.satz || err.message, { status: 409 });
    }
    if (r.text === text) return satz;
    const d = satz.data;
    const agenten = (Array.isArray(d.agenten) ? klon(d.agenten) : [])
      .map((a) => ({ ...a, beiZeichen: Math.min(Number(a.beiZeichen) || 0, r.text.length) }));
    const { patch } = fassungen.neueFassung(satz, { art: 'bearbeitet', anweisung: 'block', nr: r.block.nr, modell: d.model && d.model.model }, {
      content: r.text,
      status: 'complete',
      denken: String(d.denken || ''),
      quellen: klon(d.quellen || []),
      agenten,
      rueckfragen: [],
      rueckfrageOffen: false,
      error: null,
      abgeschnitten: false,
      stats: {},
      usedNetwork: d.usedNetwork === true,
      networkTargets: klon(d.networkTargets || []),
      model: klon(d.model || null),
      claude: null,
    });
    const neu = store.update(satz.id, patch);
    publish('chat.message', { chatId: chat.id, record: fuerAussen(neu) });
    ableiten(neu, chat);
    return neu;
  }

  /* ------------------------------------------------ Zustand der Bausteine */

  const UI_JE_BAUSTEIN = 16 * 1024;
  const UI_JE_NACHRICHT = 64 * 1024;

  /**
   * Den Zustand eines Bausteins speichern (PUT …/ui, docs 5): je Fassung und
   * Schlüssel ein kleines Objekt. `zustand: null` löscht ihn. Inhaltliche
   * Änderungen sind Fassungen, keine Zustände.
   */
  function uiSetzen({ chatId, messageId, version, schluessel, zustand } = {}) {
    const chat = getChat(chatId);
    const satz = antwortVon(chat, messageId);
    const { versionen, version: aktiv } = fassungen.fassungenLesen(satz);
    const v = version === undefined || version === null ? aktiv : version;
    if (!Number.isInteger(v) || v < 0 || v >= versionen.length) throw new NotFoundError(`Fassung ${version}`);
    if (typeof schluessel !== 'string' || !/^[\p{L}\p{N}_.:-]{1,100}$/u.test(schluessel)) {
      throw new ValidationError('"schluessel" muss ein kurzer Name sein (Buchstaben, Ziffern, _ . : -; höchstens 100 Zeichen).');
    }
    if (zustand === undefined) throw new ValidationError('"zustand" fehlt (null löscht ihn).');
    if (zustand !== null) {
      const groesse = Buffer.byteLength(JSON.stringify(zustand), 'utf8');
      if (groesse > UI_JE_BAUSTEIN) {
        throw new NeuralError('UI_ZUSTAND_ZU_GROSS', `Der Zustand ist zu groß (${Math.ceil(groesse / 1024)} KB, höchstens 16 KB je Baustein).`, { status: 413 });
      }
    }
    const ui = satz.data.ui && typeof satz.data.ui === 'object' ? klon(satz.data.ui) : {};
    const fach = { ...(ui[String(v)] || {}) };
    if (zustand === null) delete fach[schluessel];
    else fach[schluessel] = klon(zustand);
    if (Object.keys(fach).length) ui[String(v)] = fach;
    else delete ui[String(v)];
    const gesamt = Buffer.byteLength(JSON.stringify(ui), 'utf8');
    if (gesamt > UI_JE_NACHRICHT) {
      throw new NeuralError('UI_ZUSTAND_ZU_GROSS', 'Für diese Antwort ist zu viel Zustand gespeichert (höchstens 64 KB je Nachricht).', { status: 413 });
    }
    store.update(satz.id, { ui });
    publish('chat.ui', { chatId: chat.id, messageId: satz.id, version: v, schluessel, zustand });
    return { messageId: satz.id, version: v, schluessel, zustand, ui: ui[String(v)] || {} };
  }

  /* ------------------------------------------ Zusammenfassung fürs Gehirn */

  /**
   * Eine kurze Zusammenfassung eines Knotens für die Detailkarte im Gehirn
   * (POST /api/graph/zusammenfassung, src/models/zusammenfassen.js). Einmal
   * gefragt, gilt sie, bis sich der Eintrag oder sein Verknüpftes ändert.
   * `nurGespeichert`: nur nachsehen, nie die KI fragen (die Karte zeigt so
   * beim Öffnen, was es schon gibt). `neu`: auch dann fragen, wenn eine
   * gemerkt ist. Ohne verbundene KI: `{text:null}`.
   * @returns {Promise<{text:string|null, modell?:string, am?:string, gespeichert?:boolean, kiVerbunden:boolean}>}
   */
  async function zusammenfassen({ record, verknuepft, nurGespeichert = false, neu = false } = {}) {
    let z = null;
    try { z = claude.zustand(); } catch { z = null; }
    const kiVerbunden = !!(z && z.verbunden);
    if (!record) return { text: null, kiVerbunden };
    const schluessel = zusammenfassenMod.schluesselVon(record, verknuepft);
    const gemerkt = neu && !nurGespeichert ? null : zusammenfassungen.holen(schluessel);
    if (gemerkt) return { ...gemerkt, gespeichert: true, kiVerbunden };
    if (nurGespeichert || !kiVerbunden) return { text: null, kiVerbunden };
    const a = zusammenfassenMod.anfrageFuer({ record, verknuepft });
    const r = await einfacherAufruf({
      chat: null,
      system: a.system,
      nachrichten: a.nachrichten,
      purpose: a.purpose,
      maxTokens: 2000,
    });
    const text = fassungen.antwortSaeubern(r.text);
    if (!text.trim()) return { text: null, kiVerbunden };
    const ergebnis = { text, modell: r.modell, am: new Date().toISOString() };
    zusammenfassungen.ablegen(schluessel, ergebnis);
    return { ...ergebnis, gespeichert: false, kiVerbunden };
  }

  /* ----------------------------------------------------------- Dienst */

  return {
    create(data = {}) {
      const payload = {};
      for (const key of ['title', 'agentId', 'model', 'systemPrompt', 'network', 'contextNodeIds', 'pinned']) {
        if (data[key] !== undefined) payload[key] = data[key];
      }
      if (data.stil !== undefined) payload.stil = stilLesen(data.stil);
      if (data.modus !== undefined) payload.modus = modusLesen(data.modus);
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
      // Antwortstil (docs 3): {laenge, fachlich, kreativ} 0-100, null = keiner.
      if (patch.stil !== undefined) allowed.stil = stilLesen(patch.stil);
      if (patch.modus !== undefined) allowed.modus = modusLesen(patch.modus);
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

    // Antwort-Bausteine (docs/ANTWORT-BAUSTEINE.md 4-6)
    umwandelnPruefen: (opts) => { umwandelnPruefen(opts); },
    umwandeln,
    fassungWaehlen,
    blockBearbeiten,
    uiSetzen,
    anhangAblegen,
    anhangDatei,
    /** Vorab (vor dem Strom): gehören die Kennungen zu Dateien dieses Chats? */
    anhaengePruefen: (chatId, ids) => { anhaengeFuer(getChat(chatId), Array.isArray(ids) ? ids : []); },
    zusammenfassen,

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
        anbieter: z.aktiv || anbieterId(),
        claude: { verbunden: z.verbunden, modell: modellFuer(chat), grund: z.grund, grundCode: z.grundCode, anbieter: z.aktiv || anbieterId() },
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
      const { nachrichten, weg } = kuerzen(verlaufHerrichten(verlaufAus(history), modulVon()));
      return {
        system: systemBloecke(chat),
        nachrichten,
        weggelassen: weg,
        werkzeuge: DEFINITIONEN.map((w) => w.name),
        anbieter: anbieterId(),
        modell: modellFuer(chat),
      };
    },

    estimateTokens,
  };
}

/**
 * Ein Nachrichtensatz so, wie er den Tresor verlässt (Routen, Bus): ohne
 * `data.claude` -- den Mitschnitt für die NÄCHSTE Anfrage an die KI
 * (Denkblöcke mit Signatur, verschlüsselte Suchergebnisse), den keine
 * Oberfläche braucht --, und bei Antworten mit den Fassungen als Kopfdaten
 * (auch für Nachrichten von vor den Fassungen: dann genau eine).
 */
function fuerAussen(record) {
  if (!record || !record.data || typeof record.data !== 'object') return record;
  const { claude, ...data } = record.data;
  void claude;
  const f = fassungen.fuerOberflaeche(record);
  if (f) {
    data.versionen = f.versionen;
    data.version = f.version;
  }
  return { ...record, data };
}

module.exports = {
  createChatService,
  estimateTokens,
  sortMessages,
  fuerAussen,
  SYSTEM_FEST,
  SYSTEM_UMWANDELN,
  DARSTELLUNG,
  MAX_CONTENT_CHARS,
  __internals: { verlaufHerrichten, mitCachePunkt, heuteSatz, firstLine, sortMessages },
};
