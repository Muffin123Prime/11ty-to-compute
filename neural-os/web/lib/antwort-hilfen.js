/**
 * antwort-hilfen.js -- die reinen Rechnungen rund um eine KI-Antwort im Chat
 * (web/views/chat.js). Kein DOM, kein Netz: test/antwort-hilfen.test.js
 * prueft alles in Node.
 *
 * - `codebloecke` / `schnittSicher`: Der Chat zerlegt eine Antwort an den
 *   Stellen, an denen die KI etwas angelegt oder gefragt hat (Karten). Faellt
 *   so eine Stelle in einen offenen Codezaun -- etwa mitten in einen
 *   ```ui-Baustein --, zerbraeche der Block in zwei kaputte Haelften. Die
 *   Stelle rueckt deshalb hinter den Zaun. Die Zaunregeln sind dieselben wie
 *   im Server (src/models/fassungen.js, codebloecke), damit "Block Nr. 3"
 *   hier und dort derselbe ist.
 * - `spracheErkennen`: Ein Codeblock ohne Sprache ("```" allein) bekommt
 *   eine, wenn der Inhalt sie eindeutig verraet -- sonst bleibt er "Text".
 *   Lieber keine Sprache als eine falsche: eine falsche faerbt Code falsch
 *   ein und bietet [Ausfuehren] an, wo nichts laeuft.
 * - `wortUnterschied`: [Vergleichen] zweier Fassungen, wortweise, mit einer
 *   kleinen LCS (laengste gemeinsame Teilfolge). Keine Bibliothek: die App
 *   hat keine Abhaengigkeiten, und fuer Chat-Antworten reicht das.
 * - Die Saetze, die an die KI gehen (Erklaeren, Fehler suchen, Frage zu
 *   einer Stelle): an EINER Stelle, damit sie ueberall gleich lauten.
 */

/* ------------------------------------------------------------------ */
/* Codebloecke                                                          */
/* ------------------------------------------------------------------ */

// Wie der Server: Einrueckung, Zitatzeichen und ein Listenzeichen vor dem
// Zaun gehoeren zum Praefix, das fuer jede Zeile des Blocks gilt.
const ZAUN_AUF = /^([ \t>]*?(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)( {0,3})(`{3,}|~{3,})[ \t]*([^`\n]*)$/;
const ZAUN_ZU = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Die Codebloecke (``` und ~~~) eines Markdown-Texts in Textreihenfolge.
 * @returns {Array<{nr:number, lang:string, info:string, start:number, ende:number, inhaltStart:number, inhaltEnde:number, code:string, closed:boolean}>}
 */
export function codebloecke(markdown) {
  const s = String(markdown || '');
  const zeilen = [];
  let pos = 0;
  for (const z of s.split('\n')) {
    zeilen.push({ z, start: pos, ende: pos + z.length });
    pos += z.length + 1;
  }
  const out = [];
  for (let i = 0; i < zeilen.length; i += 1) {
    const m = ZAUN_AUF.exec(zeilen[i].z);
    if (!m) continue;
    const praefix = m[1] + m[2];
    const marke = m[3];
    const info = m[4].trim();
    const leer = praefix.replace(/[-*+]|\d{1,9}[.)]/g, (x) => ' '.repeat(x.length));
    const ohne = (zeile) => {
      if (zeile.startsWith(praefix)) return zeile.slice(praefix.length);
      if (zeile.startsWith(leer)) return zeile.slice(leer.length);
      return zeile.replace(/^[ \t>]*/, '');
    };
    let j = i + 1;
    let closed = false;
    for (; j < zeilen.length; j += 1) {
      const e = ZAUN_ZU.exec(ohne(zeilen[j].z));
      if (e && e[1][0] === marke[0] && e[1].length >= marke.length) {
        closed = true;
        break;
      }
    }
    const inhalt = zeilen.slice(i + 1, j);
    const inhaltStart = inhalt.length ? inhalt[0].start : Math.min(zeilen[i].ende + 1, s.length);
    const inhaltEnde = inhalt.length ? inhalt[inhalt.length - 1].ende : inhaltStart;
    out.push({
      nr: out.length,
      lang: (info.split(/\s+/)[0] || '').toLowerCase(),
      info,
      start: zeilen[i].start,
      ende: closed ? zeilen[j].ende : s.length,
      inhaltStart: Math.min(inhaltStart, s.length),
      inhaltEnde: Math.min(inhaltEnde, s.length),
      code: inhalt.map((x) => ohne(x.z)).join('\n'),
      closed,
    });
    i = closed ? j : zeilen.length;
  }
  return out;
}

/**
 * Eine Schnittstelle im Text, die keinen Codezaun zerschneidet: Liegt `pos`
 * in einem Block, rueckt sie an sein Ende (bei einem offenen Block: ans
 * Textende).
 */
export function schnittSicher(markdown, pos, bloecke = null) {
  const s = String(markdown || '');
  const p = Math.max(0, Math.min(s.length, Number(pos) || 0));
  for (const b of bloecke || codebloecke(s)) {
    if (p > b.start && p < b.ende) return b.ende;
    if (b.start >= p) break;
  }
  return p;
}

/** Ein Codezaun, der laenger ist als jede Backtick-Folge im Inhalt. */
export function zaun(code, sprache = '') {
  const laengste = Math.max(2, ...(String(code).match(/`+/g) || []).map((x) => x.length));
  const f = '`'.repeat(laengste + 1);
  return `${f}${sprache}\n${code}\n${f}`;
}

/* ------------------------------------------------------------------ */
/* Sprache erkennen                                                     */
/* ------------------------------------------------------------------ */

/*
 * Je Sprache Muster mit Gewicht; gezaehlt wird jeder Treffer, gedeckelt je
 * Muster, damit eine lange Datei nicht allein durch Masse gewinnt. Der
 * Sieger braucht mindestens 4 Punkte und einen klaren Abstand zum Zweiten.
 */
const MUSTER = {
  javascript: [
    [/\b(?:const|let|var)\s+[\w$]+\s*=/g, 2],
    [/\bfunction\s*[\w$]*\s*\(/g, 2],
    [/\)\s*=>|\b[\w$]+\s*=>/g, 2],
    [/\bconsole\.(?:log|error|warn|info)\(/g, 3],
    [/\b(?:document|window)\.[\w$]+/g, 2],
    [/\brequire\(\s*['"]/g, 3],
    [/^\s*import\s+[\w${},*\s]+\s+from\s+['"]/gm, 3],
    [/^\s*export\s+(?:default|const|function|class|async)\b/gm, 3],
    [/===|!==/g, 2],
    [/\basync\s+function\b|\bawait\s+[\w$.]+\(/g, 2],
  ],
  python: [
    [/^\s*def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*$/gm, 4],
    [/^\s*class\s+\w+(?:\([^)]*\))?\s*:\s*$/gm, 4],
    [/^\s*(?:import\s+[\w.]+(?:\s+as\s+\w+)?|from\s+[\w.]+\s+import\s+[\w*, ]+)\s*$/gm, 3],
    [/\bprint\(/g, 2],
    [/^\s*(?:elif\b.*|else|try|except\b.*|finally)\s*:\s*$/gm, 3],
    [/\bself\.\w+/g, 2],
    [/^\s*(?:if|for|while|with)\b[^{};]*:\s*$/gm, 2],
    [/\b(?:None|True|False)\b/g, 1],
    [/if\s+__name__\s*==/g, 4],
  ],
  bash: [
    [/^#!\/(?:usr\/)?bin\/(?:env\s+)?(?:ba|z)?sh\b/m, 8],
    [/^\s*\$\s+\S/gm, 3],
    [/^\s*(?:sudo|apt(?:-get)?|brew|npm|npx|yarn|pnpm|pip3?|git|cd|ls|mkdir|rm|cp|mv|curl|wget|chmod|chown|export|echo|docker|systemctl|ssh|scp|tar|cat|grep|node|python3?|ollama)\s/gm, 2],
    [/\|\s*(?:grep|sed|awk|xargs|sort|head|tail|wc|tee)\b/g, 2],
    [/\s--?[a-z][\w-]*/g, 0.5],
  ],
  html: [
    [/<!doctype\s+html/gi, 6],
    [/<\/(?:html|head|body|div|span|p|a|ul|ol|li|table|tr|td|th|section|header|footer|main|nav|button|form|label|script|style|h[1-6]|title|svg|canvas)>/gi, 2],
    [/<(?:meta|link|img|input|br)\b[^>]*>/gi, 1],
  ],
  CSS: [
    [/^\s*[.#:@]?[\w-][^{};\n]*\{\s*$/gm, 2],
    [/^\s*[\w-]+\s*:\s*[^;{}\n]+;\s*$/gm, 1.5],
    [/@media\b|@keyframes\b|@import\b|@font-face\b/g, 3],
    [/\d(?:px|rem|em|vh|vw|%)\b/g, 0.5],
  ],
  SQL: [
    [/^\s*(?:select\b[\s\S]*?\bfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(?:table|index|view)|alter\s+table|drop\s+table)\b/gim, 5],
    [/\b(?:where|join|group\s+by|order\s+by|values|limit|having)\b/gi, 1],
  ],
};
const DECKEL = 12;

/** Wie viele Punkte hat `code` fuer eine Sprache? */
function punkte(code, muster) {
  let summe = 0;
  for (const [re, gewicht] of muster) {
    re.lastIndex = 0;
    const treffer = (code.match(re) || []).length;
    summe += Math.min(DECKEL, treffer * gewicht);
  }
  return summe;
}

/**
 * Die Sprache eines Codeblocks aus seinem Inhalt, oder '' wenn es nicht
 * eindeutig ist. Die Namen sind die, die der Renderer versteht
 * (web/lib/markdown.js, languageLabel): javascript, python, json, bash,
 * html -- und fuer Sprachen ohne Faerbung der Anzeigename (CSS, SQL, YAML).
 * @param {string} code
 * @returns {string}
 */
export function spracheErkennen(code) {
  const s = String(code || '').trim();
  if (s.length < 2) return '';
  const probe = s.length > 20000 ? s.slice(0, 20000) : s;
  if (/^[[{]/.test(probe) && /[\]}]$/.test(probe)) {
    try {
      JSON.parse(probe);
      return 'json';
    } catch { /* kein JSON, weiter */ }
  }
  const wertung = Object.entries(MUSTER).map(([name, muster]) => [name, punkte(probe, muster)]);
  // YAML ist kaum an einzelnen Mustern zu erkennen ("Hinweis: …" sieht aus
  // wie ein Schluessel). Erst wenn fast jede Zeile "schluessel: wert" oder
  // "- eintrag" ist und keine Klammern und Semikola vorkommen.
  const zeilen = probe.split('\n').filter((z) => z.trim() && !/^\s*#/.test(z));
  const yamlZeilen = zeilen.filter((z) => /^\s*(?:-\s+)?[\w"'.-]+:(?:\s+\S.*)?$/.test(z) || /^\s*-\s+\S/.test(z)).length;
  if (zeilen.length >= 3 && yamlZeilen / zeilen.length >= 0.8 && !/[{};]/.test(probe) && zeilen.some((z) => /:\s*$|^\s+\S/.test(z))) {
    wertung.push(['YAML', 5 + yamlZeilen]);
  }
  wertung.sort((a, b) => b[1] - a[1]);
  const [erster, zweiter] = wertung;
  if (!erster || erster[1] < 4) return '';
  if (zweiter && erster[1] - zweiter[1] < 2) return '';
  return erster[0];
}

const JS_SPRACHEN = new Set(['js', 'javascript', 'mjs', 'cjs', 'node']);
const HTML_SPRACHEN = new Set(['html', 'htm', 'xhtml']);

/**
 * Laesst sich dieser Block im Sandkasten ausfuehren? Nur JavaScript und HTML
 * (docs/ANTWORT-BAUSTEINE.md 6) -- TypeScript oder JSX liefen dort nicht,
 * also gibt es fuer sie keinen Knopf.
 * @returns {'js'|'html'|null}
 */
export function ausfuehrbar(lang) {
  const l = String(lang || '').trim().toLowerCase();
  if (JS_SPRACHEN.has(l)) return 'js';
  if (HTML_SPRACHEN.has(l)) return 'html';
  return null;
}

/* ------------------------------------------------------------------ */
/* Fassungen vergleichen                                                */
/* ------------------------------------------------------------------ */

/** Text in Woerter, Leerraum und Satzzeichen (je ein Stueck). */
export function woerter(textWert) {
  return String(textWert || '').match(/\s+|[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu) || [];
}

/** Hoechstens so viele Zellen fuer die LCS-Tabelle (sonst zeilenweise). */
export const MAX_ZELLEN = 9000000;

/**
 * Die Schritte von `a` nach `b` ueber die laengste gemeinsame Teilfolge:
 * [{art:'gleich'|'weg'|'neu', stueck}]. Gemeinsamer Anfang und gemeinsames
 * Ende werden vorher abgeschnitten -- zwei Fassungen unterscheiden sich
 * meist nur in der Mitte, und die Tabelle bleibt klein.
 * @returns {Array<{art:string, stueck:string}>|null} null, wenn die Tabelle zu gross wuerde
 */
export function lcsSchritte(a, b, maxZellen = MAX_ZELLEN) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q += 1;
  const am = a.slice(p, a.length - q);
  const bm = b.slice(p, b.length - q);
  const n = am.length;
  const m = bm.length;
  if (n * m > maxZellen) return null;
  const out = [];
  for (let i = 0; i < p; i += 1) out.push({ art: 'gleich', stueck: a[i] });
  if (n && m) {
    const breite = m + 1;
    const T = (n + 1) * breite;
    const dp = n < 65535 && m < 65535 ? new Uint16Array(T) : new Uint32Array(T);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * breite + j] = am[i] === bm[j]
          ? dp[(i + 1) * breite + j + 1] + 1
          : Math.max(dp[(i + 1) * breite + j], dp[i * breite + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        out.push({ art: 'gleich', stueck: am[i] });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * breite + j] >= dp[i * breite + j + 1]) {
        out.push({ art: 'weg', stueck: am[i] });
        i += 1;
      } else {
        out.push({ art: 'neu', stueck: bm[j] });
        j += 1;
      }
    }
    for (; i < n; i += 1) out.push({ art: 'weg', stueck: am[i] });
    for (; j < m; j += 1) out.push({ art: 'neu', stueck: bm[j] });
  } else {
    for (const x of am) out.push({ art: 'weg', stueck: x });
    for (const x of bm) out.push({ art: 'neu', stueck: x });
  }
  for (let i = a.length - q; i < a.length; i += 1) out.push({ art: 'gleich', stueck: a[i] });
  return out;
}

/**
 * Zwei Fassungen wortweise vergleichen.
 * @param {string} alt  die fruehere Fassung
 * @param {string} neu  die spaetere Fassung
 * @returns {{teile:Array<{art:'gleich'|'weg'|'neu', text:string}>, weg:number, neu:number, gleich:boolean}}
 *   `weg`/`neu`: wie viele Woerter entfielen oder dazukamen
 */
export function wortUnterschied(alt, neu, { maxZellen = MAX_ZELLEN } = {}) {
  const a0 = String(alt || '');
  const b0 = String(neu || '');
  if (a0 === b0) return { teile: a0 ? [{ art: 'gleich', text: a0 }] : [], weg: 0, neu: 0, gleich: true };
  let schritte = lcsSchritte(woerter(a0), woerter(b0), maxZellen);
  // Sehr lange Fassungen: erst zeilenweise, und wenn auch das zu gross ist,
  // ehrlich "alles anders" statt eines eingefrorenen Tabs.
  if (!schritte) schritte = lcsSchritte(a0.split(/(?<=\n)/), b0.split(/(?<=\n)/), maxZellen);
  if (!schritte) schritte = [{ art: 'weg', stueck: a0 }, { art: 'neu', stueck: b0 }];

  // Leerraum zwischen zwei Aenderungen gehoert zu beiden: "alte Worte" und
  // "neue Worte" stehen dann je am Stueck, statt Wort fuer Wort zu wechseln.
  const roh = [];
  for (const s of schritte) {
    const letzte = roh[roh.length - 1];
    if (letzte && letzte.art === s.art) letzte.text += s.stueck;
    else roh.push({ art: s.art, text: s.stueck });
  }
  const teile = [];
  let weg = '';
  let dazu = '';
  const leeren = () => {
    if (weg) teile.push({ art: 'weg', text: weg });
    if (dazu) teile.push({ art: 'neu', text: dazu });
    weg = '';
    dazu = '';
  };
  roh.forEach((t, i) => {
    if (t.art === 'weg') weg += t.text;
    else if (t.art === 'neu') dazu += t.text;
    else if (/^\s+$/.test(t.text) && (weg || dazu) && roh[i + 1] && roh[i + 1].art !== 'gleich') {
      weg += t.text;
      dazu += t.text;
    } else {
      leeren();
      teile.push({ art: 'gleich', text: t.text });
    }
  });
  leeren();
  const zaehle = (art) => teile.filter((t) => t.art === art)
    .reduce((n, t) => n + woerter(t.text).filter((w) => /[\p{L}\p{N}]/u.test(w)).length, 0);
  return { teile, weg: zaehle('weg'), neu: zaehle('neu'), gleich: false };
}

/**
 * Wo sich eine Antwort geaendert hat (fuer das kurze Hervorheben nach dem
 * Umwandeln einer markierten Stelle): gemeinsamer Anfang und gemeinsames
 * Ende abgeschnitten, auf Wortgrenzen erweitert.
 * @returns {{start:number, ende:number, text:string}} Positionen in `neu`
 */
export function geaenderteStelle(alt, neu) {
  const a = String(alt || '');
  const b = String(neu || '');
  if (a === b) return { start: b.length, ende: b.length, text: '' };
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q += 1;
  let start = p;
  let ende = b.length - q;
  while (start > 0 && /[\p{L}\p{N}]/u.test(b[start - 1])) start -= 1;
  while (ende < b.length && /[\p{L}\p{N}]/u.test(b[ende])) ende += 1;
  return { start, ende, text: b.slice(start, ende) };
}

/**
 * Markdown grob zu dem Text, den man auf dem Bildschirm liest -- genug, um
 * eine Stelle im gezeichneten Text wiederzufinden.
 */
export function lesbar(markdown) {
  return String(markdown || '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)?/gm, '')
    .replace(/[*_`~|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Was an die KI geht                                                   */
/* ------------------------------------------------------------------ */

/** Ein Zitat als Markdown-Zitatblock, gekuerzt. */
export function zitat(textWert, max = 1500) {
  let t = String(textWert || '').replace(/\r\n?/g, '\n').trim();
  if (t.length > max) t = `${t.slice(0, max).trimEnd()} …`;
  return t.split('\n').map((z) => (z.trim() ? `> ${z}` : '>')).join('\n');
}

/** Die Frage, die [Erklären] bzw. [Fehler suchen] unter einem Codeblock stellt. */
export function codeFrage(art, lang, code) {
  const block = zaun(String(code || ''), String(lang || '').trim());
  if (art === 'fehler') return `Such in diesem Code nach Fehlern. Nenne jeden Fehler kurz und zeig danach die korrigierte Fassung:\n\n${block}`;
  return `Erkläre mir diesen Code Schritt für Schritt:\n\n${block}`;
}

/** Eine neue Frage zu einer markierten Stelle (Erklären, Zusammenfassen). */
export function stellenFrage(art, stelle) {
  const z = zitat(stelle);
  if (art === 'zusammenfassen') return `Fasse diese Stelle aus deiner Antwort kurz zusammen:\n\n${z}`;
  return `Erkläre mir diese Stelle aus deiner Antwort genauer:\n\n${z}`;
}

/**
 * Findet der Server eine markierte Stelle nicht eindeutig (409
 * AUSWAHL_NICHT_GEFUNDEN), fragt der Chat die KI stattdessen ganz normal --
 * mit dem Zitat. Derselbe Auftrag wie beim Umwandeln, nur als Nachricht.
 */
export function stellenAuftrag(id, stelle, sprache) {
  const saetze = {
    kuerzen: 'Kürze diese Stelle deiner Antwort auf das Wesentliche',
    umschreiben: 'Formuliere diese Stelle deiner Antwort neu, mit gleichem Inhalt',
    verbessern: 'Verbessere diese Stelle deiner Antwort: klarer und genauer, gleicher Inhalt',
    uebersetzen: `Übersetze diese Stelle deiner Antwort ins ${sprache || 'Englische'}`,
  };
  return `${saetze[id] || 'Überarbeite diese Stelle deiner Antwort'}:\n\n${zitat(stelle)}`;
}

/** "Frage dazu" unter einer Ueberschrift. */
export function abschnittFrage(titel, frage) {
  const t = String(titel || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `Zum Abschnitt „${t}“ deiner Antwort: ${String(frage || '').trim()}`;
}

/* ------------------------------------------------------------------ */
/* Die Menues der Aktionsleiste                                         */
/* ------------------------------------------------------------------ */

/** "Neu erstellen ▾" (POST …/neu-antworten {variante}); null = wie gehabt, nur neu. */
export const NEU_VARIANTEN = [
  { variante: null, label: 'Neu erstellen' },
  { variante: 'kuerzer', label: 'Kürzer' },
  { variante: 'einfacher', label: 'Einfacher' },
  { variante: 'detaillierter', label: 'Detaillierter' },
  { variante: 'kreativer', label: 'Kreativer' },
  { variante: 'anders', label: 'Anders formuliert' },
];

/** "Umwandeln ▾" (POST …/umwandeln {anweisung}); `gruppe` ordnet das Menue. */
export const UMWANDELN = [
  { anweisung: 'verbessern', label: 'Verbessern', gruppe: 'text' },
  { anweisung: 'zusammenfassen', label: 'Zusammenfassen', gruppe: 'text' },
  { anweisung: 'uebersetzen', label: 'Übersetzen', gruppe: 'text', sprache: true },
  { anweisung: 'tabelle', label: 'Als Tabelle', gruppe: 'form' },
  { anweisung: 'diagramm', label: 'Als Diagramm', gruppe: 'form' },
  { anweisung: 'checkliste', label: 'Als Checkliste', gruppe: 'form' },
  { anweisung: 'schritte', label: 'Schritt für Schritt', gruppe: 'form' },
  { anweisung: 'wichtigste', label: 'Wichtigste Punkte', gruppe: 'form' },
  { anweisung: 'nurtext', label: 'Nur Text', gruppe: 'form' },
];

/** Markierter Text: was die Stelle aendert (umwandeln mit auswahl) und was eine neue Frage stellt. */
export const STELLEN_AKTIONEN = [
  { id: 'erklaeren', label: 'Erklären', art: 'frage' },
  { id: 'kuerzen', label: 'Kürzen', art: 'stelle' },
  { id: 'umschreiben', label: 'Umschreiben', art: 'stelle' },
  { id: 'uebersetzen', label: 'Übersetzen', art: 'stelle', sprache: true },
  { id: 'verbessern', label: 'Verbessern', art: 'stelle' },
  { id: 'zusammenfassen', label: 'Zusammenfassen', art: 'frage' },
  { id: 'frage', label: 'Frage dazu', art: 'feld' },
];

/**
 * Zielsprachen fuer "Übersetzen". `ziel` ist die Form, die der Server in
 * seinen Satz einsetzt ("Übersetze die Antwort ins Englische").
 */
export const SPRACHEN = [
  { name: 'Englisch', ziel: 'Englische' },
  { name: 'Französisch', ziel: 'Französische' },
  { name: 'Spanisch', ziel: 'Spanische' },
  { name: 'Italienisch', ziel: 'Italienische' },
  { name: 'Niederländisch', ziel: 'Niederländische' },
  { name: 'Polnisch', ziel: 'Polnische' },
  { name: 'Türkisch', ziel: 'Türkische' },
  { name: 'Ukrainisch', ziel: 'Ukrainische' },
  { name: 'Russisch', ziel: 'Russische' },
  { name: 'Arabisch', ziel: 'Arabische' },
  { name: 'Deutsch', ziel: 'Deutsche' },
];

const ART_NAMEN = { original: 'Original', neu: 'Neu erstellt', umgewandelt: 'Umgewandelt', bearbeitet: 'Bearbeitet' };

/**
 * Wie eine Fassung heisst ("Original", "Kürzer", "Als Tabelle",
 * "Übersetzt ins Englische", "Stelle verbessert", "Code bearbeitet").
 * @param {{art?:string, anweisung?:string, sprache?:string, auswahl?:boolean}} v Kopfdaten vom Server
 */
export function fassungsName(v) {
  const f = v || {};
  if (f.art === 'neu') {
    const n = NEU_VARIANTEN.find((x) => x.variante && x.variante === f.anweisung);
    if (f.anweisung === 'stil') return 'Neuer Stil';
    return n ? n.label : ART_NAMEN.neu;
  }
  if (f.art === 'umgewandelt') {
    if (f.anweisung === 'uebersetzen') return f.sprache ? `Übersetzt ins ${f.sprache}` : 'Übersetzt';
    const u = UMWANDELN.find((x) => x.anweisung === f.anweisung);
    const s = STELLEN_AKTIONEN.find((x) => x.id === f.anweisung);
    if (f.auswahl) return `Stelle: ${(s || u || { label: 'geändert' }).label.toLowerCase()}`;
    if (u) return u.label;
    if (f.anweisung) return 'Umgewandelt';
  }
  if (f.art === 'bearbeitet') return f.anweisung === 'block' ? 'Block bearbeitet' : ART_NAMEN.bearbeitet;
  return ART_NAMEN[f.art] || ART_NAMEN.original;
}
