/**
 * datum-parser.js -- aus einem deutschen Satz ein Termin.
 *
 *   parse('Morgen 15 Uhr Zahnarzt', jetzt)
 *   -> { titel: 'Zahnarzt', start: '2026-09-24T15:00', end: '2026-09-24T16:00',
 *        allDay: false, recurrence: null, ort: '', hinweis: null }
 *
 * Wofuer: das eine Feld "Neuer Termin …" oben im Kalender. Man tippt, wie man
 * spricht, sieht sofort, was daraus wird, und Enter traegt ein. Deshalb ist
 * das hier eine REINE Funktion -- ohne DOM, ohne eigene Uhr (`jetzt` kommt
 * herein) -- und damit ohne Browser pruefbar (test/datum-parser.test.js).
 *
 * Zeiten sind Wandzeit vor Ort, ohne Versatz ("YYYY-MM-DDTHH:MM", ganztaegig
 * "YYYY-MM-DD"), so wie der Server sie speichert: "um zehn" bleibt um zehn,
 * auch ueber die Zeitumstellung hinweg. Gerechnet wird deshalb in UTC-Zahlen,
 * die nur als Wanduhr gelesen werden -- nie mit Date-Objekten in Ortszeit,
 * deren Tage 23 oder 25 Stunden lang sein koennen.
 *
 * Entscheidungen, die man kennen muss (alle in den Tests festgehalten):
 * - **Kleine Stunden sind nachmittags.** "halb 3", "um 3", "3 Uhr" heissen
 *   14:30 bzw. 15:00: wer einen Termin eintraegt, meint fast nie drei Uhr
 *   nachts. Ab 7 bleibt es beim Vormittag ("um 9" ist 09:00). Wer es anders
 *   meint, sagt "nachts", "frueh" oder "morgens" -- oder schreibt "03:00".
 * - **Uhrzeit ohne Tag:** heute, wenn sie noch kommt, sonst morgen.
 * - **Tag ohne Uhrzeit:** ganztaegig. Ohne Endzeit dauert ein Termin 1 Stunde.
 * - **"Montag"** ist der naechste Montag, heute eingeschlossen; **"naechsten
 *   Montag"** ist nie heute. Ein Datum ohne Jahr ist das naechste, das kommt.
 * - **Wochentags-Kuerzel** ("Mo", "Di", "So") zaehlen nur, wo sie eindeutig
 *   sind -- am Anfang, nach "am"/"jeden", oder vor einer Zahl --, damit "so"
 *   im Satz nicht zum Sonntag wird.
 * - Ein Datum, das es nicht gibt (31.2.), ergibt null statt eines Rateversuchs.
 */

/* ------------------------------------------------------------------ */
/* Wandzeit                                                             */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" aus Jahr, Monat (1-12), Tag -- ueberlaufende Tage rollen weiter. */
export function tagAus(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Der Tag eines Date-Objekts in Ortszeit. */
export function tagVon(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Gibt es diesen Tag? Der 31. Februar nicht. */
export function gibtEs(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Tage weiterzaehlen, Tag fuer Tag -- nie "+ n * 24 h". */
export function plusTage(day, n) {
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  return tagAus(y, m, d + n);
}

/** Wochentag eines Tages, 0 = Montag ... 6 = Sonntag. */
export function wochentag(day) {
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Wie viele Tage von a bis b (b - a). */
export function tageZwischen(a, b) {
  const [ay, am, ad] = String(a).slice(0, 10).split('-').map(Number);
  const [by, bm, bd] = String(b).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/**
 * Eine Wandzeit ("YYYY-MM-DDTHH:MM") um Minuten verschieben. Gerechnet auf der
 * Wanduhr: 10:00 plus sieben Tage ist 10:00, auch wenn dazwischen die Uhr
 * umgestellt wird.
 */
export function plusMinuten(wand, minuten) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(wand));
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) + minuten * 60000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/** Minuten zwischen zwei Wandzeiten (b - a). */
export function minutenZwischen(a, b) {
  const ms = (w) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(w));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : NaN;
  };
  return Math.round((ms(b) - ms(a)) / 60000);
}

/* ------------------------------------------------------------------ */
/* Woerter                                                              */
/* ------------------------------------------------------------------ */

export const WOCHENTAGE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const WT_KURZ = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const WT_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
/** Kurz fuer die Vorschau ("24. Sep") -- ohne Punkt, wie auf einem Kalenderblatt. */
export const MON3 = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
/**
 * Kurz, mit Punkt, wo abgekuerzt wird ("bis 20. Dez.", "Do., 24. Sept.") --
 * die deutsche Form, dieselbe, die Intl.DateTimeFormat('de-DE') fuer
 * `month: 'short'` liefert. Der ganze Kalender (Vorschau, Kopfzeile, Kachel,
 * Serien) benutzt sie, damit nicht "Sep" neben "Sept." steht.
 */
export const MON_SATZ = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
/** Wochentag kurz, mit Punkt ("Do."), wie Intl 'de-DE' `weekday: 'short'`. */
export const WT_PUNKT = WT_KURZ.map((w) => `${w}.`);

const ZAHLWORT = {
  ein: 1, eins: 1, eine: 1, einer: 1, einem: 1, einen: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, fuenf: 5,
  sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, 'zwölf': 12, zwoelf: 12,
};
const ORDNUNG = { zweit: 2, dritt: 3, viert: 4 };

const L = '\\p{L}\\d';
const B0 = `(?<![${L}])`;
const B1 = `(?![${L}])`;
/** Vor einer Zahl im Datum: auch kein Punkt, sonst begaenne "30.9." mitten in sich bei "9.". */
const B0D = `(?<![${L}.])`;
const ZAHL = `(\\d{1,3}|${Object.keys(ZAHLWORT).sort((a, b) => b.length - a.length).join('|')})`;
const ORD = '((?:zweit|dritt|viert)(?:e|en|er|es))';
const WT_VOLL = 'montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag';
const WT_ALLE = `(?:${WT_VOLL}|mo|di|mi|do|fr|sa|so)\\.?`;
const WT_PLURAL = 'montags|dienstags|mittwochs|donnerstags|freitags|samstags|sonntags';
const MONAT_RE = '(januar|jan|februar|feb|märz|maerz|mär|mrz|april|apr|mai|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|dezember|dez)\\.?';
const TEIL_RE = '(früh|frueh|morgens|vormittags?|mittags?|nachmittags?|abends?|nachts?)';

const rx = (src) => new RegExp(src, 'giu');

function zahl(w) {
  if (/^\d+$/.test(w)) return Number(w);
  return ZAHLWORT[w] ?? null;
}

function ordnung(w) {
  for (const [stamm, n] of Object.entries(ORDNUNG)) if (w.startsWith(stamm)) return n;
  return null;
}

/** "Mo", "montags", "Dienstag" -> 0..6; an den ersten zwei Buchstaben eindeutig. */
function wtIndex(w) {
  return ['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so'].indexOf(String(w).slice(0, 2).toLowerCase());
}

function monatIndex(w) {
  const x = w.replace(/\.$/, '');
  if (x.startsWith('ja')) return 0;
  if (x.startsWith('f')) return 1;
  if (x.startsWith('mä') || x.startsWith('mae') || x.startsWith('mr')) return 2;
  if (x.startsWith('ap')) return 3;
  if (x === 'mai') return 4;
  if (x.startsWith('jun')) return 5;
  if (x.startsWith('jul')) return 6;
  if (x.startsWith('au')) return 7;
  if (x.startsWith('se')) return 8;
  if (x.startsWith('o')) return 9;
  if (x.startsWith('n')) return 10;
  return 11;
}

/** Kleinschreibung, die jede Stelle an ihrem Platz laesst (Indizes bleiben gueltig). */
function klein(s) {
  let out = '';
  for (const c of s) {
    const k = c.toLowerCase();
    out += k.length === c.length ? k : c;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Lesen                                                                */
/* ------------------------------------------------------------------ */

/** Worte, die an einer Schnittkante nichts mehr bedeuten ("Zahnarzt um" -> "Zahnarzt"). */
const RESTWORTE = new Set(['am', 'um', 'ab', 'von', 'vom', 'bis', 'zum', 'den', 'dem', 'im', 'in', 'für', 'fuer', 'gegen', 'zwischen', 'und', 'ca.', 'ca', 'jeweils']);

/**
 * @param {string} text  was der Nutzer tippt
 * @param {Date} [jetzt] die Uhr, gegen die "morgen" gerechnet wird
 * @returns {{titel:string, start:string, end:string|null, allDay:boolean,
 *   recurrence:object|null, ort:string, hinweis:string|null}|null}
 *   null, wenn weder Tag noch Uhrzeit noch Wiederholung zu erkennen ist --
 *   oder das Datum es nicht gibt.
 */
export function parse(text, jetzt = new Date()) {
  if (typeof text !== 'string') return null;
  const s = klein(text);
  if (!s.trim()) return null;
  const heute = tagVon(jetzt);
  const jetztMin = jetzt.getHours() * 60 + jetzt.getMinutes();
  const used = new Uint8Array(s.length);

  const f = {
    daten: [], // {a, day|null, d, m, y|null, bis}
    relTag: null,
    wt: null, // {index, mod}
    zeiten: [], // {a, h, min, literal}
    spanne: null, // {h, min, literal, h2, min2, literal2}
    teil: null,
    dauer: null,
    ganztags: false,
    rec: null, // {freq, interval, byDay:Set}
    anzahl: null,
    fest: null, // {day, min} aus "in 30 Minuten"
    relWoche: false, // relTag stammt aus "in N Wochen": ein Wochentag gilt dann in DIESER Woche
    wtSpanne: null, // {von, bis} aus "Montag bis Freitag" (ohne "jeden")
    kaputt: false,
  };

  /**
   * Steht ausserhalb von [a, b) noch eine Uhrzeit? Dann ist "6.10" daneben
   * ein Datum ("Elternabend 6.10 um 19:30") und keine zweite Uhrzeit.
   */
  function andereUhrzeit(a, b) {
    const rest = `${s.slice(0, a)} ${s.slice(b)}`;
    return /\d{1,2}:\d{2}|\d\s*uhr|\d{1,2}h(?![\p{L}])|(?:^|\s)(?:um|gegen|ab)\s+(?:\d|halb|viertel|dreiviertel|ein|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf)|\d{1,2}\.(?:1[3-9]|[2-5]\d)(?![\d.])/u.test(rest);
  }

  /** Jeden Treffer, der noch frei ist, nehmen und als verbraucht markieren. */
  function nimm(re, fn) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const a = m.index;
      const b = a + m[0].length;
      if (b === a) { re.lastIndex = a + 1; continue; }
      let frei = true;
      for (let i = a; i < b; i++) if (used[i]) { frei = false; break; }
      if (!frei || fn(m, a, b) === false) { re.lastIndex = a + 1; continue; }
      used.fill(1, a, b);
    }
  }

  function setzeRec(freq, interval = 1, tage = []) {
    if (!f.rec) f.rec = { freq, interval, byDay: new Set() };
    else if (f.rec.freq !== freq) {
      // "alle 2 Wochen" + "dienstags": dieselbe Woche. Sonst gilt das Erste.
      if (!(f.rec.freq === 'weekly' && freq === 'weekly')) return;
    }
    if (interval > 1) f.rec.interval = interval;
    for (const t of tage) f.rec.byDay.add(t);
  }

  /* ---- 1. Wiederholung ---- */
  // "Montag bis Freitag" OHNE "jeden" und ohne Plural ist eine Spanne ("Praktikum
  // Montag bis Freitag" = die eine Woche), keine endlose Werktags-Serie.
  nimm(rx(`${B0}(?:jede[nrs]?\\s+werktag|werktags|an\\s+werktagen|(jede[nrs]?\\s+)?(montags?)\\s+bis\\s+(freitags?)|mo\\s*[-–]\\s*fr)${B1}`),
    (m) => {
      if (m[2] && !m[1] && m[2] === 'montag' && m[3] === 'freitag') return false;
      setzeRec('weekly', 1, [0, 1, 2, 3, 4]);
      return undefined;
    });
  // "jeden Morgen um 7", "jeden Abend": taeglich zu dieser Tageszeit. Muss vor
  // Schritt 4 stehen, sonst wird "morgen" zu "morgen" (der Tag) und "jeden" bleibt im Titel.
  nimm(rx(`${B0}jede[nrs]?\\s+(morgen|früh|frueh|vormittag|mittag|nachmittag|abend|nacht)${B1}`), (m) => {
    setzeRec('daily');
    const w = m[1];
    f.teil = w === 'morgen' || w.startsWith('fr') ? 'morgens'
      : w === 'vormittag' ? 'vormittags' : w === 'mittag' ? 'mittags'
        : w === 'nachmittag' ? 'nachmittags' : w === 'abend' ? 'abends' : 'nachts';
  });
  // "jeden 2. Donnerstag" wie "jeden zweiten Donnerstag": alle 2 Wochen -- nicht monatlich am 2.
  nimm(rx(`${B0}jede[nrs]?\\s+([2-4])\\.\\s*(${WT_VOLL})${B1}`), (m) => {
    setzeRec('weekly', Number(m[1]), [wtIndex(m[2])]);
  });
  nimm(rx(`${B0}jede[nrs]?\\s+${ORD}\\s+(${WT_VOLL})${B1}`), (m) => {
    setzeRec('weekly', ordnung(m[1]) || 1, [wtIndex(m[2])]);
  });
  nimm(rx(`${B0}(?:alle|jede[nrs]?)\\s+(?:${ZAHL}|${ORD})\\s+(tag(?:e|en)?|woche(?:n)?|monat(?:e|en)?|jahr(?:e|en)?)${B1}`), (m) => {
    const n = m[1] ? zahl(m[1]) : ordnung(m[2]);
    if (!n || n > 99) return false;
    setzeRec({ t: 'daily', w: 'weekly', m: 'monthly', j: 'yearly' }[m[3][0]], n);
    return undefined;
  });
  nimm(rx(`${B0}jede[nrs]?\\s+(tag|woche|monat|jahr)${B1}`), (m) => {
    setzeRec({ t: 'daily', w: 'weekly', m: 'monthly', j: 'yearly' }[m[1][0]]);
  });
  nimm(rx(`${B0}(täglich|taeglich|wöchentlich|woechentlich|monatlich|jährlich|jaehrlich|(?:14|vierzehn)\\s*-?\\s*(?:tägig|taegig|tägl\\.?)|zweiwöchentlich|zweiwoechentlich)${B1}`), (m) => {
    const w = m[1];
    if (/^(14|vierzehn|zwei)/.test(w)) setzeRec('weekly', 2);
    else if (w.startsWith('t')) setzeRec('daily');
    else if (w.startsWith('w')) setzeRec('weekly');
    else if (w.startsWith('m')) setzeRec('monthly');
    else setzeRec('yearly');
  });
  nimm(rx(`${B0}jede[nrs]?\\s+(${WT_ALLE})((?:\\s*(?:,|und|&|\\+)\\s*(?:${WT_ALLE}))*)${B1}`), (m) => {
    const tage = [m[1], ...(m[2] || '').split(/\s*(?:,|und|&|\+)\s*/)].filter(Boolean).map(wtIndex);
    setzeRec('weekly', 1, tage);
  });
  nimm(rx(`${B0}(${WT_PLURAL})((?:\\s*(?:,|und|&|\\+)\\s*(?:${WT_PLURAL}))*)${B1}`), (m) => {
    const tage = [m[1], ...(m[2] || '').split(/\s*(?:,|und|&|\+)\s*/)].filter(Boolean).map(wtIndex);
    setzeRec('weekly', 1, tage);
  });
  // "jeden 15." -- monatlich an diesem Tag.
  nimm(rx(`${B0}jede[nrs]?\\s+(\\d{1,2})\\.(?:\\s+(?:des|im)\\s+monats?)?(?!\\d)(?!\\s*(?:${WT_VOLL}))`), (m, a) => {
    const d = Number(m[1]);
    if (d < 1 || d > 31) return false;
    setzeRec('monthly');
    f.daten.push({ a, d, m: null, y: null, bis: false, nurTag: true });
    return undefined;
  });

  /* ---- 2. "in 30 Minuten", "in 2 Stunden": ein fester Zeitpunkt ---- */
  nimm(rx(`${B0}in\\s+(?:${ZAHL}\\s+(minuten|minute|min\\.?|stunden|stunde|std\\.?)|einer\\s+(halben\\s+stunde|viertelstunde))${B1}`), (m) => {
    let min;
    if (m[3]) min = m[3].startsWith('h') ? 30 : 15;
    else {
      const n = zahl(m[1]);
      if (!n) return false;
      min = m[2].startsWith('m') ? n : n * 60;
    }
    // Auf die naechsten fuenf Minuten: "in 30 Minuten" um 10:02 ist 10:35, nicht 10:32.
    const ziel = Math.ceil((jetztMin + min) / 5) * 5;
    f.fest = { day: plusTage(heute, Math.floor(ziel / 1440)), min: ziel % 1440 };
    return undefined;
  });

  /* ---- 3. Daten ---- */
  const praep = '(?:(am|vom|von|ab\\s+dem|ab|bis(?:\\s+zum|\\s+einschließlich)?|zum|den|dem|bis)\\s+)?';
  // 3.-5.10. / vom 3. bis 5.10.2026
  nimm(rx(`${B0D}(?:vom\\s+|von\\s+)?(\\d{1,2})\\.\\s*(?:-|–|—|bis)\\s*(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}|\\d{2})?(?!\\d)`), (m, a) => {
    const mo = Number(m[3]);
    if (mo < 1 || mo > 12) return false;
    const y = m[4] ? jahr(m[4]) : null;
    f.daten.push({ a, d: Number(m[1]), m: mo, y, bis: false });
    f.daten.push({ a: a + 1, d: Number(m[2]), m: mo, y, bis: true });
    return undefined;
  });
  // 3.–5. Oktober
  nimm(rx(`${B0D}(?:vom\\s+|von\\s+)?(\\d{1,2})\\.?\\s*(?:-|–|—|bis)\\s*(\\d{1,2})\\.?\\s*${MONAT_RE}(?:\\s+(\\d{4}))?${B1}`), (m, a) => {
    const mo = monatIndex(m[3]) + 1;
    const y = m[4] ? Number(m[4]) : null;
    f.daten.push({ a, d: Number(m[1]), m: mo, y, bis: false });
    f.daten.push({ a: a + 1, d: Number(m[2]), m: mo, y, bis: true });
  });
  // 2026-10-03
  nimm(rx(`${B0}${praep}(\\d{4})-(\\d{1,2})-(\\d{1,2})${B1}`), (m, a, b) => {
    f.daten.push({ a, e: b, d: Number(m[4]), m: Number(m[3]), y: Number(m[2]), bis: istBis(m[1]) });
  });
  // 3.10. / 3.10.2026 / 03.10.26
  nimm(rx(`${B0D}${praep}(\\d{1,2})\\.(\\d{1,2})\\.(?:(\\d{4}|\\d{2})(?!\\d))?`), (m, a, b) => {
    const mo = Number(m[3]);
    if (mo < 1 || mo > 12) return false;
    f.daten.push({ a, e: b, d: Number(m[2]), m: mo, y: m[4] ? jahr(m[4]) : null, bis: istBis(m[1]) });
    return undefined;
  });
  // "am 3.10" ohne Schlusspunkt -- nach "am"/"vom" immer ein Datum.
  nimm(rx(`${B0}(am|vom|ab\\s+dem|den)\\s+(\\d{1,2})\\.(\\d{1,2})(?![\\d.:]|\\s*uhr)`), (m, a) => {
    const mo = Number(m[3]);
    if (mo < 1 || mo > 12) return false;
    f.daten.push({ a, d: Number(m[2]), m: mo, y: null, bis: false });
    return undefined;
  });
  // "Elternabend 6.10 um 19:30", "6.10 Elternabend": ohne "am" und ohne
  // Schlusspunkt ein Datum, wenn daneben schon eine Uhrzeit steht oder es den
  // Satz anfaengt (oder einem Wochentag folgt) -- sonst koennte "9.10" auch
  // 9:10 Uhr heissen, und dann lieber nichts raten.
  nimm(rx(`${B0D}(\\d{1,2})\\.(\\d{1,2})(?![\\d.:]|\\s*(?:uhr|h|std|stunden?|minuten?|min)(?![\\p{L}]))`), (m, a, b) => {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const vorher = s.slice(0, a);
    // "um 9.10", "von 8.30 bis 9.10": dort ist es eine Uhrzeit.
    if (/(?:um|gegen|ab|bis|von|zwischen|und)\s*$/u.test(vorher)) return false;
    // Minuten haben zwei Stellen, Stunden gehen bis 24: "12.3" und "29.10"
    // koennen keine Uhrzeit sein.
    const eindeutig = m[2].length === 1 || d > 24;
    if (!eindeutig && /^\s*(?:-|–|—|bis)\s*\d/u.test(s.slice(b))) return false; // "12.10-13.00": eine Zeitspanne
    const amAnfang = !vorher.trim();
    const nachWochentag = new RegExp(`(?:${WT_VOLL}|mo|di|mi|do|fr|sa|so)\\.?,?\\s*$`, 'u').test(vorher);
    if (!eindeutig && !amAnfang && !nachWochentag && !andereUhrzeit(a, b)) return false;
    f.daten.push({ a, e: b, d, m: mo, y: null, bis: false });
    return undefined;
  });
  // 3. Oktober / 3 Okt 2027
  nimm(rx(`${B0D}${praep}(\\d{1,2})\\.?\\s*${MONAT_RE}(?:\\s+(\\d{4}))?${B1}`), (m, a, b) => {
    f.daten.push({ a, e: b, d: Number(m[2]), m: monatIndex(m[3]) + 1, y: m[4] ? Number(m[4]) : null, bis: istBis(m[1]) });
  });
  // "am 15." -- nur der Tag im Monat
  nimm(rx(`${B0}(am|zum|den|bis\\s+zum)\\s+(\\d{1,2})\\.(?![\\d])`), (m, a) => {
    const d = Number(m[2]);
    if (d < 1 || d > 31) return false;
    f.daten.push({ a, d, m: null, y: null, bis: istBis(m[1]), nurTag: true });
    return undefined;
  });

  /* ---- 4a. "naechste Woche Mittwoch", "Mittwoch naechste Woche" ---- */
  // Der Wochentag in der FOLGENDEN Kalenderwoche (Montag bis Sonntag) -- nicht
  // der naechste Mittwoch, der am Montag noch in dieser Woche laege.
  const wocheMod = '(nächste[nr]?|naechste[nr]?|kommende[nr]?|übernächste[nr]?|uebernaechste[nr]?)\\s+woche';
  const inWoche = (idx, mod) => {
    if (f.relTag) return false;
    const wochen = /^(ü|ue)ber/.test(mod) ? 2 : 1;
    f.relTag = plusTage(heute, 7 * wochen - wochentag(heute) + idx);
    return undefined;
  };
  nimm(rx(`${B0}(?:am\\s+)?(${WT_VOLL})\\s*,?\\s+(?:in\\s+der\\s+)?${wocheMod}${B1}`), (m) => inWoche(wtIndex(m[1]), m[2]));
  nimm(rx(`${B0}(?:in\\s+der\\s+)?${wocheMod}\\s*,?\\s+(?:am\\s+)?(${WT_VOLL}|mo|di|mi|do|fr|sa|so)\\.?${B1}`), (m) => inWoche(wtIndex(m[2]), m[1]));

  /* ---- 4. heute, morgen, uebermorgen, in 3 Tagen ---- */
  nimm(rx(`${B0}heute\\s+(?:morgen|früh|frueh)${B1}`), () => {
    f.relTag = heute;
    f.teil = 'morgens';
  });
  nimm(rx(`${B0}(?:ab\\s+)?(übermorgen|uebermorgen|morgen|heute)${B1}`), (m) => {
    if (f.relTag) return false;
    f.relTag = plusTage(heute, m[1] === 'heute' ? 0 : m[1] === 'morgen' ? 1 : 2);
    return undefined;
  });
  nimm(rx(`${B0}in\\s+${ZAHL}\\s+(tag(?:en)?|woche(?:n)?|monat(?:en)?)${B1}`), (m) => {
    const n = zahl(m[1]);
    if (!n || f.relTag) return false;
    if (m[2].startsWith('t')) f.relTag = plusTage(heute, n);
    else if (m[2].startsWith('w')) {
      f.relTag = plusTage(heute, 7 * n);
      f.relWoche = true;
    } else f.relTag = plusMonate(heute, n);
    return undefined;
  });

  /* ---- 5. Wochentage ---- */
  // "Montag bis Freitag" (ohne "jeden", siehe Schritt 1): eine Spanne ganzer Tage.
  nimm(rx(`${B0}(?:(?:von|vom)\\s+)?(${WT_VOLL})\\s*(?:-|–|bis)\\s*(${WT_VOLL})${B1}`), (m) => {
    if (f.wt || f.wtSpanne) return false;
    f.wtSpanne = { von: wtIndex(m[1]), bis: wtIndex(m[2]) };
    return undefined;
  });
  const modRe = '(nächste[nrs]?|naechste[nrs]?|kommende[nrs]?|übernächste[nrs]?|uebernaechste[nrs]?|diese[nrs]?)';
  nimm(rx(`${B0}(?:(am|ab)\\s+)?(?:${modRe}\\s+)?(${WT_VOLL}|mo|di|mi|do|fr|sa|so)(\\.)?,?${B1}`), (m, a, b) => {
    if (f.wt) return false;
    const wort = m[3];
    if (wort.length === 2 && !m[1] && !m[2]) {
      // Ein Kuerzel nur, wo es nicht "so" im Satz sein kann.
      const amAnfang = !s.slice(0, a).trim();
      const vorZahl = /^\s*\d/.test(s.slice(b));
      if (!amAnfang && !vorZahl) return false;
    }
    let mod = 0;
    if (m[2]) mod = /^(ü|ue)ber/.test(m[2]) ? 2 : /^diese/.test(m[2]) ? 0 : 1;
    f.wt = { index: wtIndex(wort), mod };
    return undefined;
  });

  /* ---- 6. Uhrzeiten ---- */
  const T = '(\\d{1,2})(?:[:.](\\d{2}))?';
  nimm(rx(`${B0}(?:(von|zwischen|ab)\\s+)?${T}\\s*(?:uhr\\s*)?(-|–|—|bis|und)\\s*${T}(?:\\s*uhr)?${B1}`), (m) => {
    if (m[4] === 'und' && m[1] !== 'zwischen') return false;
    const [h, mi, h2, mi2] = [Number(m[2]), Number(m[3] || 0), Number(m[5]), Number(m[6] || 0)];
    if (h > 24 || h2 > 24 || mi > 59 || mi2 > 59) return false;
    f.spanne = { h: h % 24, min: mi, literal: literal(m[2]), h2: h2 % 24, min2: mi2, literal2: literal(m[5]) };
    return undefined;
  });
  const STUNDE = `(\\d{1,2}|${Object.keys(ZAHLWORT).sort((x, y) => y.length - x.length).join('|')})`;
  nimm(rx(`${B0}(?:(?:um|gegen|ab)\\s+)?halb\\s+${STUNDE}(?:\\s*uhr)?${B1}`), (m, a) => {
    const n = zahl(m[1]);
    if (!n || n > 24) return false;
    f.zeiten.push({ a, h: n - 1 === 0 ? 12 : (n - 1) % 24, min: 30, literal: false });
    return undefined;
  });
  nimm(rx(`${B0}(?:(?:um|gegen|ab)\\s+)?(viertel\\s+nach|viertel\\s+vor|dreiviertel|drei\\s+viertel)\\s+${STUNDE}(?:\\s*uhr)?${B1}`), (m, a) => {
    const n = zahl(m[2]);
    if (!n || n > 24) return false;
    if (m[1].endsWith('nach')) f.zeiten.push({ a, h: n % 24, min: 15, literal: false });
    else f.zeiten.push({ a, h: n - 1 === 0 ? 12 : (n - 1) % 24, min: 45, literal: false });
    return undefined;
  });
  nimm(rx(`${B0}(?:(?:um|ab|gegen|von|bis)\\s+)?${T}\\s*uhr${B1}`), (m, a) => zeit(a, m[1], m[2]));
  nimm(rx(`${B0}(?:um|ab|gegen)\\s+${T}(?![\\p{L}\\d]|[.:]\\d)`), (m, a) => zeit(a, m[1], m[2]));
  nimm(rx(`${B0}(?:um|gegen|ab)\\s+(${Object.keys(ZAHLWORT).join('|')})(?:\\s+uhr)?${B1}`), (m, a) => {
    f.zeiten.push({ a, h: zahl(m[1]), min: 0, literal: false });
  });
  nimm(rx(`${B0}(\\d{1,2}):(\\d{2})${B1}`), (m, a) => zeit(a, m[1], m[2]));
  // "16h", "16h30", "um 16h": eine Uhrzeit. Als Dauer nur mit "für" ("für 2h",
  // Schritt 8) oder wenn schon eine andere Uhrzeit dasteht ("10 Uhr 2h").
  nimm(rx(`(?<![\\p{L}\\d.,]|für\\s|fuer\\s)(?:(um|ab|gegen)\\s+)?(\\d{1,2})h(\\d{2})?${B1}`), (m, a, b) => {
    if (!m[1] && !m[3] && andereUhrzeit(a, b)) return false;
    return zeit(a, m[2], m[3]);
  });
  // "Heute Abend 7 Kino": eine nackte Zahl direkt nach der Tageszeit ist die Uhrzeit.
  nimm(rx(`${B0}(früh|frueh|morgens|vormittags?|mittags?|nachmittags?|abends?|nachts?)\\s+(\\d{1,2})(?:[:.](\\d{2}))?(?![\\d.:,]|\\s*(?:h|std|stunden?|minuten?|min|mal|x|tage?n?|wochen?)(?![\\p{L}]))`), (m, a) => {
    const w = m[1];
    f.teil = w.startsWith('fr') || w.startsWith('morgen') ? 'morgens'
      : w.startsWith('vor') ? 'vormittags'
        : w.startsWith('nach') && w !== 'nacht' && w !== 'nachts' ? 'nachmittags'
          : w.startsWith('mittag') ? 'mittags'
            : w.startsWith('abend') ? 'abends' : 'nachts';
    return zeit(a, m[2], m[3]);
  });
  // "Arzt 14.10. 9.30": neben einem Tag ist "9.30" die Uhrzeit.
  nimm(rx(`${B0D}(\\d{1,2})\\.(\\d{2})(?![\\d.]|\\s*(?:uhr))`), (m, a) => {
    if (!f.daten.length && !f.relTag && !f.wt) return false;
    return zeit(a, m[1], m[2]);
  });

  function zeit(a, hs, ms) {
    const h = Number(hs);
    const mi = Number(ms || 0);
    if (h > 24 || mi > 59) return false;
    f.zeiten.push({ a, h: h % 24, min: mi, literal: literal(hs) });
    return undefined;
  }

  /* ---- 7. Tageszeit -- nur neben einem Tag oder einer Uhrzeit ---- */
  nimm(rx(`${B0}${TEIL_RE}${B1}`), (m, a, b) => {
    let i = a - 1;
    while (i >= 0 && /\s/.test(s[i])) i--;
    let j = b;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (!((i >= 0 && used[i]) || (j < s.length && used[j]))) return false;
    const w = m[1];
    f.teil = w.startsWith('fr') || w.startsWith('morgen') ? 'morgens'
      : w.startsWith('vor') ? 'vormittags'
        : w.startsWith('nach') && w !== 'nacht' && w !== 'nachts' ? 'nachmittags'
          : w.startsWith('mittag') ? 'mittags'
            : w.startsWith('abend') ? 'abends' : 'nachts';
    return undefined;
  });

  /* ---- 8. Dauer ---- */
  nimm(rx(`${B0}(?:für|fuer|dauer)?\\s*(?:eine\\s+)?halbe\\s+stunde${B1}`), () => { f.dauer = 30; });
  nimm(rx(`${B0}(?:(?:für|fuer)\\s+)?(\\d{1,3}(?:[,.]\\d)?|anderthalb|eineinhalb|${Object.keys(ZAHLWORT).join('|')})\\s*(stunden|stunde|std\\.?|minuten|min\\.?)${B1}`), (m) => {
    const n = /^(anderthalb|eineinhalb)$/.test(m[1]) ? 1.5 : /^\d/.test(m[1]) ? Number(m[1].replace(',', '.')) : zahl(m[1]);
    if (!n) return false;
    f.dauer = Math.round(m[2].startsWith('m') ? n : n * 60);
    return f.dauer > 0 && f.dauer <= 14 * 1440 ? undefined : false;
  });
  nimm(rx(`${B0}(?:(?:für|fuer)\\s+)?(\\d{1,2}(?:[,.]\\d)?)h${B1}`), (m) => {
    f.dauer = Math.round(Number(m[1].replace(',', '.')) * 60);
    return f.dauer > 0 ? undefined : false;
  });

  /* ---- 9. ganztaegig ---- */
  nimm(rx(`${B0}(?:ganztägig|ganztaegig|ganztags|den\\s+ganzen\\s+tag|ganzer\\s+tag|ganzen\\s+tag)${B1}`), () => { f.ganztags = true; });

  /* ---- 10. "5 mal" ---- */
  if (f.rec) {
    nimm(rx(`${B0}(\\d{1,3})\\s*(?:-\\s*)?(?:mal|x)${B1}`), (m) => {
      const n = Number(m[1]);
      if (n < 1 || n > 999) return false;
      f.anzahl = n;
      return undefined;
    });
  }

  /* ================= Zusammensetzen ================= */

  const erkannt = f.daten.length || f.relTag || f.wt || f.wtSpanne || f.zeiten.length || f.spanne || f.rec || f.ganztags || f.fest || (f.teil && f.relTag);
  if (!erkannt) return null;

  // Daten in Textreihenfolge: das erste ist der Beginn, eines nach "bis" oder
  // einem Strich das Ende -- oder, bei einer Wiederholung, ihr letzter Tag.
  f.daten.sort((x, y) => x.a - y.a);
  let startDaten = null;
  let endeDaten = null;
  for (let i = 0; i < f.daten.length; i++) {
    const t = f.daten[i];
    const zwischen = i > 0 ? s.slice(f.daten[i - 1].e ?? f.daten[i - 1].a, t.a) : '';
    if (t.bis || (startDaten && /^[^\p{L}\d]*[-–—]\s*$/u.test(zwischen))) {
      if (!endeDaten) endeDaten = t;
    } else if (!startDaten) {
      startDaten = t;
    }
  }

  let tag = null;
  let hinweis = null;
  if (startDaten) {
    tag = aufloesen(startDaten, heute);
    if (!tag) return null;
  }
  let bisTag = null;
  if (endeDaten) {
    bisTag = aufloesen(endeDaten, tag || heute);
    if (!bisTag) return null;
  }
  if (!tag && f.relTag) tag = f.relTag;
  if (f.wtSpanne && !tag) {
    // "Montag bis Freitag": ab dem naechsten Montag (heute eingeschlossen) bis zum Freitag danach.
    tag = plusTage(heute, (f.wtSpanne.von - wochentag(heute) + 7) % 7);
    if (!bisTag) bisTag = plusTage(tag, (f.wtSpanne.bis - f.wtSpanne.von + 7) % 7);
  }
  if (f.wt) {
    if (tag) {
      if (f.relWoche && !startDaten) {
        // "Freitag in 2 Wochen": der Freitag in der Woche, die in 2 Wochen ist.
        tag = plusTage(tag, f.wt.index - wochentag(tag));
      } else if (wochentag(tag) !== f.wt.index) {
        const [, mm, dd] = tag.split('-').map(Number);
        hinweis = `Der ${dd}.${mm}. ist ein ${WOCHENTAGE[wochentag(tag)]}.`;
      }
    } else {
      let d = (f.wt.index - wochentag(heute) + 7) % 7;
      if (f.wt.mod >= 1 && d === 0) d = 7;
      if (f.wt.mod === 2) d += 7;
      tag = plusTage(heute, d);
    }
  }

  // Eine Serie "jeden Dienstag" beginnt am ersten Dienstag ab dem Tag.
  let rec = null;
  if (f.rec) {
    const byDay = [...f.rec.byDay].sort((x, y) => x - y);
    if (f.rec.freq === 'weekly' && byDay.length) {
      let d = tag || heute;
      for (let i = 0; i < 7 && !byDay.includes(wochentag(d)); i++) d = plusTage(d, 1);
      tag = d;
    }
    rec = { freq: f.rec.freq, interval: Math.min(99, f.rec.interval) };
    if (f.rec.freq === 'weekly') rec.byDay = byDay.map((i) => WT_CODES[i]);
    rec.until = bisTag && bisTag >= (tag || heute) ? bisTag : null;
    rec.count = f.anzahl;
    bisTag = null;
  }

  // Die Uhrzeit.
  let startMin = null;
  let endeMin = null;
  const teil = f.teil;
  if (f.fest) {
    tag = f.fest.day;
    startMin = f.fest.min;
  } else if (f.spanne) {
    startMin = umrechnen(f.spanne.h, f.spanne.min, f.spanne.literal, teil);
    endeMin = endeNach(startMin, f.spanne.h2, f.spanne.min2, f.spanne.literal2, teil);
  } else if (f.zeiten.length) {
    f.zeiten.sort((x, y) => x.a - y.a);
    const z = f.zeiten[0];
    startMin = umrechnen(z.h, z.min, z.literal, teil);
    if (f.zeiten[1]) {
      const z2 = f.zeiten[1];
      endeMin = bisTag && bisTag > (tag || heute)
        ? umrechnen(z2.h, z2.min, z2.literal, null)
        : endeNach(startMin, z2.h, z2.min, z2.literal, teil);
    }
  } else if (teil) {
    startMin = { morgens: 480, vormittags: 600, mittags: 720, nachmittags: 900, abends: 1140, nachts: 1320 }[teil];
  }

  if (!tag) {
    tag = heute;
    // Eine Uhrzeit ohne Tag, die heute schon vorbei ist, meint morgen.
    if (startMin !== null && !rec && !f.ganztags && startMin < jetztMin) tag = plusTage(heute, 1);
  }

  const ganz = f.ganztags || startMin === null;
  let start;
  let end;
  if (ganz) {
    start = tag;
    end = bisTag && bisTag > tag ? bisTag : null;
  } else {
    start = `${tag}T${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`;
    if (endeMin !== null) {
      const endTag = bisTag && bisTag > tag ? bisTag : tag;
      end = `${endTag}T${pad(Math.floor((endeMin % 1440) / 60))}:${pad(endeMin % 60)}`;
      if (endeMin >= 1440 && endTag === tag) end = plusMinuten(`${tag}T00:00`, endeMin);
      if (minutenZwischen(start, end) <= 0) end = plusMinuten(start, 60);
    } else {
      end = plusMinuten(start, f.dauer || 60);
    }
  }

  if (!hinweis && start.slice(0, 10) < heute && !rec) hinweis = 'Das liegt in der Vergangenheit.';

  const { titel, ort } = restText(text, used);
  return { titel, start, end, allDay: ganz, recurrence: rec, ort, hinweis };

  /* ---- Helfer, die f und heute sehen ---- */

  function istBis(p) {
    return !!p && p.startsWith('bis');
  }

  function aufloesen(t, ab) {
    if (t.nurTag) {
      // "am 15.": dieser Monat, wenn der Tag noch kommt, sonst der naechste.
      const [y, m] = ab.split('-').map(Number);
      for (let k = 0; k < 13; k++) {
        const yy = y + Math.floor((m - 1 + k) / 12);
        const mm = ((m - 1 + k) % 12) + 1;
        if (!gibtEs(yy, mm, t.d)) continue;
        const kandidat = tagAus(yy, mm, t.d);
        if (kandidat >= ab) return kandidat;
      }
      return null;
    }
    if (t.y) return gibtEs(t.y, t.m, t.d) ? tagAus(t.y, t.m, t.d) : null;
    const y0 = Number(ab.slice(0, 4));
    for (let y = y0; y < y0 + 9; y++) {
      if (!gibtEs(y, t.m, t.d)) {
        if (t.m === 2 && t.d === 29) continue; // Schalttag: das naechste Schaltjahr
        return null;
      }
      const kandidat = tagAus(y, t.m, t.d);
      if (kandidat >= ab) return kandidat;
    }
    return null;
  }
}

function jahr(y) {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

/** "15", "09" -- zweistellig geschrieben heisst: genau so gemeint. */
function literal(hs) {
  return hs.length === 2 || Number(hs) >= 13 || Number(hs) === 0;
}

/**
 * Stunde + Tageszeit -> Minuten des Tages. Siehe oben: kleine Stunden ohne
 * Tageszeit sind nachmittags.
 */
function umrechnen(h, min, istLiteral, teil) {
  let hh = h;
  if (teil === 'nachmittags' || teil === 'abends') {
    if (hh < 12) hh += 12;
  } else if (teil === 'mittags') {
    if (hh <= 5) hh += 12;
  } else if (teil === 'nachts') {
    if (hh >= 7 && hh < 12) hh += 12;
    if (hh === 12) hh = 0;
  } else if (teil === 'morgens' || teil === 'vormittags') {
    if (hh === 12) hh = 12;
  } else if (!istLiteral && hh >= 1 && hh <= 6) {
    hh += 12;
  }
  return hh * 60 + min;
}

/**
 * Das Ende einer Spanne: das kleinste, das nach dem Beginn liegt ("3-5" ist
 * 15-17 Uhr, "9-5" ist 9-17 Uhr), sonst am Folgetag ("22-2" endet um 2 Uhr).
 */
function endeNach(startMin, h, min, istLiteral, teil) {
  const kandidaten = [h * 60 + min];
  if (!istLiteral && h < 12) kandidaten.push((h + 12) * 60 + min);
  if (teil === 'nachmittags' || teil === 'abends') kandidaten.reverse();
  const passt = kandidaten.filter((k) => k > startMin).sort((x, y) => x - y);
  if (passt.length) return passt[0];
  return h * 60 + min + 1440;
}

function plusMonate(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const ziel = new Date(Date.UTC(y, m - 1 + n, 1));
  const letzter = new Date(Date.UTC(ziel.getUTCFullYear(), ziel.getUTCMonth() + 1, 0)).getUTCDate();
  return tagAus(ziel.getUTCFullYear(), ziel.getUTCMonth() + 1, Math.min(d, letzter));
}

/**
 * Was uebrig bleibt, ist der Titel -- und, hinter einem "@", der Ort.
 * Verbrauchte Stellen werden zu Schnittkanten; an einer Kante verlieren
 * Fuellworte ("um", "am", ein Komma) ihren Sinn und fallen weg.
 */
function restText(original, used) {
  let roh = '';
  let i = 0;
  for (const c of original) {
    roh += used[i] ? '\u0000' : c;
    i += c.length;
  }
  const at = roh.indexOf('@');
  const titelTeil = at === -1 ? roh : roh.slice(0, at);
  const ortTeil = at === -1 ? '' : roh.slice(at + 1);
  const titel = saeubern(titelTeil);
  return { titel: titel ? titel[0].toLocaleUpperCase('de-DE') + titel.slice(1) : '', ort: saeubern(ortTeil) };
}

function saeubern(teil) {
  const stuecke = teil.split(/\u0000+/);
  const out = [];
  stuecke.forEach((stueck, k) => {
    let w = stueck.trim().split(/\s+/).filter(Boolean);
    const kanteVorn = k > 0;
    const kanteHinten = k < stuecke.length - 1;
    const weg = (x) => RESTWORTE.has(x.toLowerCase()) || /^[,;:·–—\-|/]+$/.test(x);
    if (kanteHinten) while (w.length && weg(w[w.length - 1])) w.pop();
    if (kanteVorn) while (w.length && weg(w[0])) w.shift();
    // Ein Komma oder Strich direkt an der Kante gehoert zum Weggeschnittenen.
    if (w.length && kanteHinten) w[w.length - 1] = w[w.length - 1].replace(/[,;:·–—-]+$/, '');
    if (w.length && kanteVorn) w[0] = w[0].replace(/^[,;:·–—-]+/, '');
    w = w.filter(Boolean);
    if (w.length) out.push(w.join(' '));
  });
  return out.join(' ').replace(/\s+/g, ' ').replace(/^[\s,;:·–—-]+|[\s,;:·–—-]+$/g, '').trim();
}

/* ------------------------------------------------------------------ */
/* Beschreiben                                                          */
/* ------------------------------------------------------------------ */

/** "Do., 24. Sept." -- mit Jahr, wenn es nicht das von `jetzt` ist. */
export function tagKurz(day, jetzt = new Date()) {
  const [y, m, d] = day.split('-').map(Number);
  const jahrText = y !== jetzt.getFullYear() ? ` ${y}` : '';
  return `${WT_PUNKT[wochentag(day)]}, ${d}. ${MON_SATZ[m - 1]}${jahrText}`;
}

/**
 * Nur Tag und Uhrzeit: "Do., 24. Sept. · 15:00–16:00", "Sa., 3. – Mo., 5. Okt. · ganztägig".
 */
export function zeitTeil(t, jetzt = new Date()) {
  if (!t || !t.start) return '';
  const teile = [];
  const tag = t.start.slice(0, 10);
  if (t.allDay) {
    if (t.end && t.end > tag) {
      const [, m1, d1] = tag.split('-').map(Number);
      const [, m2] = t.end.split('-').map(Number);
      teile.push(m1 === m2 && tag.slice(0, 4) === t.end.slice(0, 4)
        ? `${WT_PUNKT[wochentag(tag)]}, ${d1}. – ${tagKurz(t.end, jetzt)}`
        : `${tagKurz(tag, jetzt)} – ${tagKurz(t.end, jetzt)}`);
    } else {
      teile.push(tagKurz(tag, jetzt));
    }
    teile.push('ganztägig');
  } else {
    teile.push(tagKurz(tag, jetzt));
    const von = t.start.slice(11, 16);
    const bis = t.end ? t.end.slice(11, 16) : '';
    if (!t.end) teile.push(von);
    else if (t.end.slice(0, 10) === tag) teile.push(`${von}–${bis}`);
    else teile.push(`${von} – ${WT_PUNKT[wochentag(t.end)]} ${bis}`);
  }
  return teile.join(' · ');
}

/**
 * Die Vorschau unter dem Eingabefeld:
 * "Do., 24. Sept. · 15:00–16:00 · Zahnarzt".
 */
export function beschreibe(t, jetzt = new Date()) {
  if (!t) return '';
  const teile = [zeitTeil(t, jetzt), t.titel || 'Ohne Titel'];
  if (t.ort) teile.push(t.ort);
  if (t.recurrence) {
    const w = wiederholungInWorten(t.recurrence, t.start);
    teile.push(w[0].toLowerCase() + w.slice(1));
  }
  return teile.join(' · ');
}

function liste(namen) {
  if (namen.length <= 1) return namen.join('');
  return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/**
 * Eine Wiederholung in Worten: "Jeden Dienstag bis 20. Dez.", "Täglich",
 * "Alle 2 Wochen am Freitag", "Jeden Monat am 15.", "Werktags".
 *
 * @param {{freq:string, interval?:number, byDay?:string[], until?:string|null, count?:number|null}} rec
 * @param {string} start  Beginn der Serie (Tag oder Wandzeit)
 */
export function wiederholungInWorten(rec, start) {
  if (!rec || typeof rec !== 'object') return '';
  const n = Number(rec.interval) > 1 ? Number(rec.interval) : 1;
  const tag = String(start || '').slice(0, 10);
  const [, sm, sd] = tag.split('-').map(Number);
  let text;
  if (rec.freq === 'daily') {
    text = n === 1 ? 'Täglich' : `Alle ${n} Tage`;
  } else if (rec.freq === 'weekly') {
    const idx = (Array.isArray(rec.byDay) && rec.byDay.length ? rec.byDay.map((c) => WT_CODES.indexOf(c)) : [wochentag(tag)])
      .filter((i) => i >= 0).sort((a, b) => a - b);
    const werktags = idx.length === 5 && idx.every((v, i) => v === i);
    const namen = liste(idx.map((i) => WOCHENTAGE[i]));
    if (n === 1) text = werktags ? 'Werktags' : idx.length === 7 ? 'Täglich' : `Jeden ${namen}`;
    else text = `Alle ${n} Wochen ${werktags ? 'werktags' : `am ${namen}`}`;
  } else if (rec.freq === 'monthly') {
    text = n === 1 ? `Jeden Monat am ${sd}.` : `Alle ${n} Monate am ${sd}.`;
  } else if (rec.freq === 'yearly') {
    const wann = sm ? `${sd}. ${MONATE[sm - 1]}` : '';
    text = n === 1 ? `Jedes Jahr am ${wann}` : `Alle ${n} Jahre am ${wann}`;
  } else {
    return '';
  }
  if (rec.until) {
    const [uy, um, ud] = String(rec.until).split('-').map(Number);
    const jahrText = uy && tag && uy !== Number(tag.slice(0, 4)) ? ` ${uy}` : '';
    text += ` bis ${ud}. ${MON_SATZ[um - 1]}${jahrText}`;
  } else if (rec.count) {
    text += `, ${rec.count}-mal`;
  }
  return text;
}
