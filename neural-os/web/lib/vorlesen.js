/**
 * lib/vorlesen.js -- der kleine Vorlese-Spieler (docs/ANTWORT-BAUSTEINE.md 6):
 * ▶/⏸, Tempo 0,75–2×, der gerade gelesene Satz ist hervorgehoben.
 *
 * Die Entscheidungen, die diese Datei formen:
 *
 * - **Eine Aeusserung je Satz.** Chromium bricht eine lange Aeusserung nach
 *   etwa 15 Sekunden still ab. Und nur so weiss der Spieler jederzeit, welcher
 *   Satz gerade laeuft -- Pause, Tempo und Hervorheben setzen genau dort an.
 * - **Pause heisst: anhalten und an diesem Satz neu beginnen**, nicht
 *   `speechSynthesis.pause()`. Das haelt in Chromium mit den Netz-Stimmen
 *   nicht verlaesslich an, und ein neues Tempo gilt ohnehin erst fuer eine
 *   neue Aeusserung.
 * - **Hervorheben, ohne den Text anzufassen**: die CSS Custom Highlight API
 *   markiert einen Bereich, ohne ein Element einzufuegen. Der Chat baut eine
 *   Antwort oft neu (Bausteine, Tabellen); ein eingefuegtes <mark> zerbraeche
 *   dabei. Kann der Browser das nicht, zeigt der Spieler den Satz selbst.
 * - **Gelesen wird, was man sieht**: Bausteine als ihre Text-Fassung, Code
 *   nicht Zeichen fuer Zeichen (das hoert niemandem zu), Aufzaehlungszeichen
 *   und Tabellenstriche nicht als Wort.
 */

/** Die Tempi des Spielers, der Reihe nach. */
export const TEMPI = Object.freeze([0.75, 1, 1.25, 1.5, 2]);

/** Name des Bereichs fuer ::highlight() (web/views/chat.js gestaltet ihn). */
export const MARKE = 'nos-vorlesen';

/** Laenger als das wird ein Satz an Komma oder Strich geteilt (Chromium, ~15 s). */
const MAX_SATZ = 240;

/**
 * Abkuerzungen, nach denen kein Satz endet: einzelne Buchstaben ("z. B.",
 * "d. h."), kleine Zahlen ("am 3. Oktober") und die ueblichen Kuerzel.
 */
const ABKUERZUNG = /(?:^|[\s(„"'«»])(?:[A-Za-zÄÖÜäöüß]|\d{1,2}|bzw|ca|usw|etc|dr|nr|st|str|vgl|ggf|evtl|inkl|mio|mrd|jh|abs|bspw|zzgl|prof|hr|fr|mind|max|min|std|tel|allg|bzgl|ehem|sog|jan|feb|mär|apr|jun|jul|aug|sep|sept|okt|nov|dez)\.$/i;

/**
 * Markdown-Klartext (lib/markdown.js extractPlain) so aufbereiten, dass er
 * sich vorlesen laesst: Aufzaehlungszeichen und Haken weg, Tabellenstriche
 * werden Kommas, Zeilen bleiben Zeilen (eine Zeile ohne Punkt ist ein Satz).
 */
export function sprechText(klar) {
  return String(klar || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((z) => z
      .replace(/^\s*(?:[•·*-]|\[[ xX]\])\s+/, '')
      .replace(/\s+\|\s+/g, ', ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

/** Stellen, an denen ein Satz endet: Satzzeichen (auch mit Anfuehrungszeichen dahinter) vor Leerraum. */
function kandidaten(zeile) {
  const out = [];
  const re = /[.!?…]+["“”»«'’)\]]*(?=\s|$)/g;
  let start = 0;
  let m;
  while ((m = re.exec(zeile))) {
    const ende = m.index + m[0].length;
    out.push(zeile.slice(start, ende));
    start = ende;
  }
  if (start < zeile.length) out.push(zeile.slice(start));
  return out;
}

/** Einen zu langen Satz an Komma, Semikolon, Doppelpunkt oder Strich teilen. */
function kuerzen(satz) {
  if (satz.length <= MAX_SATZ) return [satz];
  const out = [];
  let rest = satz;
  while (rest.length > MAX_SATZ) {
    const fenster = rest.slice(0, MAX_SATZ);
    const stelle = Math.max(fenster.lastIndexOf(', '), fenster.lastIndexOf('; '), fenster.lastIndexOf(': '), fenster.lastIndexOf(' – '));
    const schnitt = stelle > MAX_SATZ / 3 ? stelle + 1 : (fenster.lastIndexOf(' ') > MAX_SATZ / 3 ? fenster.lastIndexOf(' ') : MAX_SATZ);
    out.push(rest.slice(0, schnitt).trim());
    rest = rest.slice(schnitt).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Text in Saetze teilen. Eine Zeile ist mindestens ein Satz; innerhalb einer
 * Zeile endet ein Satz an . ! ? … vor Leerraum -- nicht nach einer
 * Abkuerzung, nicht mitten in 3.5 oder example.org.
 * @returns {string[]}
 */
export function saetzeTeilen(roh) {
  const out = [];
  for (const zeile of String(roh || '').replace(/\r/g, '').split(/\n+/)) {
    const z = zeile.replace(/\s+/g, ' ').trim();
    if (!z) continue;
    let puffer = '';
    const teile = kandidaten(z);
    teile.forEach((t, i) => {
      puffer += t;
      const bisher = puffer.trim();
      if (i < teile.length - 1 && ABKUERZUNG.test(bisher)) return;
      if (bisher) out.push(...kuerzen(bisher));
      puffer = '';
    });
    if (puffer.trim()) out.push(...kuerzen(puffer.trim()));
  }
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Kann dieser Browser vorlesen? */
export function vorlesenMoeglich(w = globalThis) {
  return !!(w && w.speechSynthesis && typeof w.SpeechSynthesisUtterance === 'function');
}

/**
 * Der Spieler. Eine Instanz fuer die ganze Seite: es liest immer nur eine
 * Antwort zur Zeit.
 *
 *   const vl = vorleser();
 *   vl.start('message_1', text);  vl.pause();  vl.weiter();  vl.tempo(1.5);  vl.stopp();
 *   vl.abonnieren((zustand) => …)  // {id, index, anzahl, satz, spielt, tempo}
 *
 * @param {{synth?:SpeechSynthesis, Aeusserung?:Function, sprache?:string}} [deps]
 */
export function vorleser(deps = {}) {
  const synth = deps.synth || globalThis.speechSynthesis;
  const Aeusserung = deps.Aeusserung || globalThis.SpeechSynthesisUtterance;
  const sprache = deps.sprache || 'de-DE';
  const abos = new Set();
  let tempo = 1;
  let lauf = null; // {id, saetze, index, spielt, gen, aktuell}

  function zustand() {
    if (!lauf) return { id: null, index: 0, anzahl: 0, satz: '', spielt: false, tempo };
    return { id: lauf.id, index: lauf.index, anzahl: lauf.saetze.length, satz: lauf.saetze[lauf.index] || '', spielt: lauf.spielt, tempo };
  }

  function melden() {
    const z = zustand();
    for (const fn of [...abos]) {
      try { fn(z); } catch { /* ein Abonnent darf die anderen nicht stoeren */ }
    }
  }

  function stimme() {
    const alle = typeof synth.getVoices === 'function' ? (synth.getVoices() || []) : [];
    const de = alle.filter((v) => /^de([-_]|$)/i.test(v.lang || ''));
    return de.find((v) => v.localService) || de[0] || null;
  }

  function sprechen() {
    if (!lauf || !lauf.spielt) return;
    lauf.gen += 1;
    const gen = lauf.gen;
    if (lauf.index >= lauf.saetze.length) {
      beenden();
      return;
    }
    const u = new Aeusserung(lauf.saetze[lauf.index]);
    u.lang = sprache;
    u.rate = tempo;
    const v = stimme();
    if (v) u.voice = v;
    u.onend = () => {
      if (!lauf || lauf.gen !== gen) return;
      lauf.index += 1;
      if (lauf.index >= lauf.saetze.length) {
        beenden();
        return;
      }
      melden();
      sprechen();
    };
    u.onerror = (e) => {
      if (!lauf || lauf.gen !== gen) return;
      // Abgebrochen hat der Spieler selbst (Pause, Tempo, anderer Satz).
      if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
      beenden();
    };
    // Die Aeusserung festhalten: Chromium verliert sonst manchmal ihr onend.
    lauf.aktuell = u;
    synth.speak(u);
    melden();
  }

  function beenden() {
    if (lauf) lauf.gen += 1;
    lauf = null;
    try { synth.cancel(); } catch { /* nichts lief */ }
    melden();
  }

  return {
    /** Eine Antwort von vorn (oder ab Satz `ab`) vorlesen. @returns {boolean} ob es etwas zu lesen gab */
    start(id, text, { ab = 0 } = {}) {
      const saetze = saetzeTeilen(text);
      try { synth.cancel(); } catch { /* nichts lief */ }
      if (!saetze.length) {
        lauf = null;
        melden();
        return false;
      }
      lauf = { id, saetze, index: Math.max(0, Math.min(saetze.length - 1, ab)), spielt: true, gen: 0, aktuell: null };
      sprechen();
      return true;
    },
    pause() {
      if (!lauf || !lauf.spielt) return;
      lauf.spielt = false;
      lauf.gen += 1;
      try { synth.cancel(); } catch { /* egal */ }
      melden();
    },
    weiter() {
      if (!lauf || lauf.spielt) return;
      lauf.spielt = true;
      sprechen();
    },
    /** Ein neues Tempo gilt ab dem Satz, der gerade laeuft (er beginnt neu). */
    tempo(neu) {
      const t = Number(neu);
      if (!TEMPI.includes(t)) return;
      tempo = t;
      if (lauf && lauf.spielt) {
        lauf.gen += 1;
        try { synth.cancel(); } catch { /* egal */ }
        sprechen();
      } else {
        melden();
      }
    },
    /** Das naechste Tempo der Reihe (nach 2× wieder 0,75×). */
    naechstesTempo() {
      const i = TEMPI.indexOf(tempo);
      this.tempo(TEMPI[(i + 1) % TEMPI.length]);
    },
    stopp() {
      if (lauf) beenden();
    },
    zustand,
    abonnieren(fn) {
      abos.add(fn);
      return () => abos.delete(fn);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Den Satz im Text finden                                              */
/* ------------------------------------------------------------------ */

/**
 * Was beim Suchen im Text nicht zaehlt: Knoepfe, Leisten, Uhrzeit, der
 * Gedankengang und die Nummern der Quellen (vorgelesen werden sie nicht).
 */
const NICHT_TEXT = 'button, summary, .cv-aktionen, .cv-spieler, .cv-zeit, .cv-denken, .cv-verweis, .bs-verlauf, .md-code__head, .md-copycard__head, style, script, svg';

/**
 * Die Stelle eines Satzes im Text einer Antwort, als Range -- oder null.
 * Verglichen wird ohne Gross/Klein und mit zusammengefasstem Leerraum; wer
 * den Anfang nicht findet (Bausteine lesen sich anders, als sie aussehen),
 * bekommt null, und der Spieler zeigt den Satz selbst.
 */
export function stelleImText(wurzel, satz, { nur = null } = {}) {
  if (!wurzel || typeof document === 'undefined' || !satz) return null;
  const knoten = [];
  let flach = '';
  const laeufer = document.createTreeWalker(wurzel, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.parentElement;
      if (!el || el.closest(NICHT_TEXT)) return NodeFilter.FILTER_REJECT;
      // `nur`: nur Text in diesen Teilen (etwa '.cv-md', der Text einer Antwort).
      if (nur && !el.closest(nur)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  // flach[i] stammt aus knoten[wo[i]] an Stelle ab[i].
  const wo = [];
  const ab = [];
  let leer = true;
  for (let n = laeufer.nextNode(); n; n = laeufer.nextNode()) {
    const t = n.nodeValue || '';
    const k = knoten.push(n) - 1;
    for (let i = 0; i < t.length; i += 1) {
      const c = t[i];
      if (/\s/.test(c)) {
        if (leer) continue;
        flach += ' ';
        leer = true;
      } else {
        flach += c.toLowerCase();
        leer = false;
      }
      wo.push(k);
      ab.push(i);
    }
  }
  const ziel = String(satz).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!ziel) return null;
  let start = flach.indexOf(ziel);
  let laenge = ziel.length;
  if (start < 0) {
    // Nur den Anfang: Satzzeichen am Ende, Anfuehrungszeichen, Bausteine.
    const kopf = ziel.slice(0, Math.min(ziel.length, 40));
    start = kopf.length >= 12 ? flach.indexOf(kopf) : -1;
    laenge = kopf.length;
  }
  if (start < 0) return null;
  const ende = Math.min(flach.length - 1, start + laenge - 1);
  const r = document.createRange();
  r.setStart(knoten[wo[start]], ab[start]);
  r.setEnd(knoten[wo[ende]], ab[ende] + 1);
  return r;
}

/** Den Satz hervorheben (oder die Marke loeschen). @returns {boolean} ob hervorgehoben wird */
export function hervorheben(range) {
  const reg = typeof CSS !== 'undefined' && CSS.highlights;
  if (!reg || typeof globalThis.Highlight !== 'function') return false;
  if (!range) {
    reg.delete(MARKE);
    return true;
  }
  reg.set(MARKE, new globalThis.Highlight(range));
  return true;
}

/** Kann der Browser einen Bereich hervorheben, ohne den Text anzufassen? */
export function hervorhebenMoeglich() {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof globalThis.Highlight === 'function';
}
