/**
 * lib/insel-logik.js -- das Rechnen hinter der Insel (lib/insel.js), ohne
 * Browser: Zeiten, kleine Befehle, die Rangfolge der Live-Anzeigen,
 * Bildmasse, die Saetze zu Fehlern.
 *
 * Rein und ohne Importe: test/insel.test.js laedt genau diese Datei, als
 * .mjs kopiert -- wie die anderen Tests der Oberflaeche.
 */

/** So lange darf ein Timer laufen. */
export const MAX_TIMER_MS = 24 * 3600 * 1000;
/** Ab so viel vor Beginn steht ein Termin in der Insel. */
export const TERMIN_VORLAUF_MS = 60 * 60000;
/** So lange nach Beginn noch ("Jetzt · …", "Seit 5 Min · …"). */
export const TERMIN_NACHLAUF_MS = 15 * 60000;
/** Nach so langer Ruhe beginnt die Insel ein neues Gespraech (das alte bleibt unter "Zuletzt"). */
export const GESPRAECH_PAUSE_MS = 2 * 3600 * 1000;
/** Laengste Kante eines Bildschirmfotos: genug zum Lesen, klein genug fuer jede Anfrage. */
export const BILD_KANTE = 1600;
/** So viel Text aus der Zwischenablage geht hoechstens mit. */
export const MAX_KONTEXT_ZEICHEN = 12000;
/** Ein fertiger Timer klingelt so lange, wenn niemand ihn ausschaltet. */
export const KLINGELN_MS = 60000;

/**
 * Was die Insel der KI ueber sich sagt: steht als Anweisung am Insel-Chat
 * (POST /api/chats, systemPrompt) und ist dort fuer jeden lesbar.
 */
export const SYSTEM_ANWEISUNG = [
  'Ich frage dich über die Insel: das kleine Fenster oben in Neural OS, das auch über anderen Programmen schweben kann.',
  'Antworte deshalb kurz: meist ein bis vier Sätze, Listen höchstens fünf Punkte – außer ich will ausdrücklich mehr.',
  'Ein Bild in meiner Nachricht ist ein Bildschirmfoto von dem, was ich gerade sehe (ein anderes Programm, eine Webseite, ein Dokument). Sage ich „das“, „hier“ oder „dieses“, meine ich das Bild oder den mitgeschickten Text.',
  'Steht in meiner Nachricht, was gerade in Neural OS offen ist, lies es mit eintrag_lesen nach, bevor du darüber sprichst.',
  'Kannst du etwas für mich erledigen (Termin, Notiz, merken), tu es mit deinen Werkzeugen und sag es in einem Satz.',
].join('\n');

/** Die Schnellknoepfe unter dem Feld. `braucht: 'inhalt'` heisst: es muss etwas da sein, worauf sich "das" bezieht. */
export const VORLAGEN = Object.freeze([
  { id: 'sehen', label: 'Was siehst du?', frage: 'Was siehst du auf meinem Bildschirm? Sag kurz das Wichtigste.', braucht: 'bild' },
  { id: 'erklaeren', label: 'Erklär mir das', frage: 'Erklär mir das kurz und einfach.', braucht: 'inhalt' },
  { id: 'zusammenfassen', label: 'Fass zusammen', frage: 'Fass das in höchstens drei Punkten zusammen.', braucht: 'inhalt' },
  { id: 'uebersetzen', label: 'Übersetz ins Deutsche', frage: 'Übersetz das ins Deutsche.', braucht: 'inhalt' },
  { id: 'antworten', label: 'Hilf mir antworten', frage: 'Schreib mir eine kurze, freundliche Antwort darauf.', braucht: 'inhalt' },
  { id: 'heute', label: 'Was steht heute an?', frage: 'Was steht heute bei mir an? Termine und offene Aufgaben, kurz.', braucht: null },
]);

/** Die Timer, die die Insel zum Antippen anbietet (Minuten). */
export const TIMER_VORGABEN = Object.freeze([1, 3, 5, 10, 15, 25]);

const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------------ */
/* Zeiten                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ein Countdown: "4:05", "1:02:03". Aufgerundet auf volle Sekunden, damit
 * "0:00" genau dann steht, wenn der Timer fertig ist.
 */
export function uhrText(ms) {
  const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const std = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sek = s % 60;
  return std ? `${std}:${pad(min)}:${pad(sek)}` : `${min}:${pad(sek)}`;
}

/** "5 Min", "1 Std 30 Min", "45 Sek" -- fuer Saetze ueber einen Timer. */
export function dauerWorte(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} Sek`;
  const std = Math.floor(s / 3600);
  const min = Math.round((s % 3600) / 60);
  if (!std) return `${min} Min`;
  return min ? `${std} Std ${min} Min` : `${std} Std`;
}

/** 'YYYY-MM-DD' oder 'YYYY-MM-DDTHH:MM' als Zeitpunkt in Ortszeit; ganztaegig -> null. */
export function wandzeitMs(wert) {
  const s = String(wert || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/* ------------------------------------------------------------------ */
/* Kleine Befehle: Timer und Notiz gehen ohne KI                        */
/* ------------------------------------------------------------------ */

const ZAHLWORT = {
  ein: 1, eine: 1, einen: 1, einer: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, fünf: 5, sechs: 6, sieben: 7,
  acht: 8, neun: 9, zehn: 10, elf: 11, zwoelf: 12, zwölf: 12, fuenfzehn: 15, fünfzehn: 15, zwanzig: 20,
  dreissig: 30, dreißig: 30, vierzig: 40, fuenfundvierzig: 45, fünfundvierzig: 45, fuenfzig: 50, fünfzig: 50, sechzig: 60,
};

const EINHEIT = [
  [/^(?:s|sek|sekunde|sekunden|sec)$/, 1000],
  [/^(?:m|min|mins|minute|minuten|minütig)$/, 60000],
  [/^(?:h|std|stunde|stunden)$/, 3600000],
];

function einheitMs(wort) {
  const w = String(wort || '').toLowerCase().replace(/\.$/, '');
  for (const [re, ms] of EINHEIT) if (re.test(w)) return ms;
  return null;
}

function zahl(wort) {
  const w = String(wort || '').toLowerCase();
  if (/^\d+(?:[.,]\d+)?$/.test(w)) return Number(w.replace(',', '.'));
  if (Object.prototype.hasOwnProperty.call(ZAHLWORT, w)) return ZAHLWORT[w];
  return null;
}

/**
 * Eine Dauer in einem Satz finden: "5 min", "1,5 Stunden", "90 Sek",
 * "1:30" (Minuten:Sekunden), "1:00:00", "zehn Minuten", "1 h 30 min",
 * "eine halbe Stunde", "Viertelstunde". Eine nackte Zahl gilt als Minuten.
 * @returns {{ms:number, rest:string}|null} rest = der Satz ohne die Dauer
 */
export function dauerFinden(satz) {
  const roh = String(satz || '');
  const s = roh.toLowerCase();
  // Feste Worte zuerst.
  const feste = [
    [/\b(?:eine\s+)?halbe\s+stunde\b/, 30 * 60000],
    [/\b(?:eine\s+)?dreiviertelstunde\b/, 45 * 60000],
    [/\b(?:eine\s+)?viertelstunde\b/, 15 * 60000],
    [/\banderthalb\s+stunden\b/, 90 * 60000],
  ];
  for (const [re, ms] of feste) {
    const m = re.exec(s);
    if (m) return { ms, rest: `${roh.slice(0, m.index)} ${roh.slice(m.index + m[0].length)}` };
  }
  // 1:30 oder 1:02:03
  let m = /(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?(?=\s|$)/.exec(s);
  if (m) {
    const ms = m[3] !== undefined
      ? ((+m[1] * 3600) + (+m[2] * 60) + +m[3]) * 1000
      : ((+m[1] * 60) + +m[2]) * 1000;
    return { ms, rest: `${roh.slice(0, m.index)} ${roh.slice(m.index + m[0].length)}` };
  }
  // Zahl + Einheit, auch mehrere hintereinander ("1 h 30 min").
  const re = /(\d+(?:[.,]\d+)?|[a-zäöüß]+)\s*(sekunden|sekunde|sek|sec|s|minuten|minute|mins|min|m|stunden|stunde|std|h)\b\.?/g;
  let summe = 0;
  const stellen = [];
  while ((m = re.exec(s))) {
    const n = zahl(m[1]);
    const e = einheitMs(m[2]);
    if (n === null || e === null) continue;
    summe += n * e;
    stellen.push([m.index, m.index + m[0].length]);
  }
  // "1 h 30" -- die Minuten ohne Einheit nach einer Stunde.
  if (stellen.length === 1) {
    const nach = /^\s*(\d{1,2})\b(?!\s*[:.,]?\d)/.exec(s.slice(stellen[0][1]));
    const vorher = s.slice(stellen[0][0], stellen[0][1]);
    if (nach && /(?:h|std|stunde|stunden)\.?$/.test(vorher)) {
      summe += Number(nach[1]) * 60000;
      stellen[0][1] += nach[0].length;
    }
  }
  if (stellen.length) {
    let rest = '';
    let pos = 0;
    for (const [a, b] of stellen) {
      rest += `${roh.slice(pos, a)} `;
      pos = b;
    }
    rest += roh.slice(pos);
    return { ms: Math.round(summe), rest };
  }
  // Nackte Zahl: Minuten.
  m = /(?:^|\s)(\d{1,3})(?=\s|$)/.exec(s);
  if (m) return { ms: Number(m[1]) * 60000, rest: `${roh.slice(0, m.index)} ${roh.slice(m.index + m[0].length)}` };
  return null;
}

const FUELL = /^(?:(?:für|fuer|auf|von|mit|namens|zum|zur|um|bis|die|der|das|den|dem|ein|eine|einen|timer|wecker)\b\s*|[:\-–—,.]\s*)+/i;

function titelAus(rest) {
  let t = String(rest || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i += 1) t = t.replace(FUELL, '').trim();
  t = t.replace(/[\s:,.!?\-–—]+$/, '').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1, 60);
}

/**
 * Was die Insel selbst erledigt, statt die KI zu fragen:
 *   "Timer 5 min", "stell einen Timer auf 10 Minuten", "Nudeln 8 min Timer",
 *   "Timer" (ohne Dauer: die Auswahl), "Timer aus"
 *   "Notiz: Milch kaufen"
 * Alles andere ist eine Frage an die KI (null).
 * @returns {{art:'timer', ms:number|null, titel:string}|{art:'timerAus'}|{art:'notiz', titel:string, text:string}|null}
 */
export function befehl(satz) {
  const roh = String(satz || '').trim();
  if (!roh || roh.length > 200) {
    return notizBefehl(roh);
  }
  const notiz = notizBefehl(roh);
  if (notiz) return notiz;
  const s = roh.toLowerCase();
  if (!/\b(?:timer|wecker|eieruhr|kurzzeitwecker)\b/.test(s)) return null;
  if (/^(?:timer|wecker|eieruhr)\s+(?:aus|stopp|stop|beenden|abbrechen)\b/.test(s) || /^(?:stopp|stop|beende|beenden)\s+(?:den\s+)?(?:timer|wecker)\b/.test(s)) {
    return { art: 'timerAus' };
  }
  // Nur, was wirklich nach einem Timer klingt: das Wort steht vorn ("Timer
  // 5 min", "Stell einen Timer …") oder hinten ("Nudeln 8 min Timer").
  // "Wie funktioniert ein Timer in Excel?" ist eine Frage.
  const vorn = /^(?:(?:bitte\s+)?(?:stell|stelle|starte?|mach|mache|setz|setze)\s+(?:mir\s+)?(?:bitte\s+)?(?:einen|ein|den)?\s*)?(?:timer|wecker|eieruhr|kurzzeitwecker)\b/.exec(s);
  const hinten = /\b(?:timer|wecker|eieruhr)\s*[.!]?$/.exec(s);
  if (!vorn && !hinten) return null;
  if (/[?]\s*$/.test(s)) return null;
  const ohneWort = vorn ? roh.slice(vorn[0].length) : roh.slice(0, hinten.index);
  const d = dauerFinden(ohneWort);
  if (!d) {
    // "Timer" allein: die Auswahl; "Timer für die Pizza" ohne Dauer auch.
    return { art: 'timer', ms: null, titel: titelAus(ohneWort) };
  }
  if (!(d.ms >= 1000) || d.ms > MAX_TIMER_MS) return null;
  return { art: 'timer', ms: d.ms, titel: titelAus(d.rest) };
}

function notizBefehl(roh) {
  const m = /^(?:notiz|notiere|notier)\s*[:\-–]\s*([\s\S]+)$/i.exec(roh);
  if (!m) return null;
  const text = m[1].trim();
  if (!text) return null;
  const erste = text.split('\n')[0].trim();
  const titel = erste.length > 60 ? `${erste.slice(0, 59).trim()}…` : erste;
  return { art: 'notiz', titel, text };
}

/* ------------------------------------------------------------------ */
/* Timer                                                                */
/* ------------------------------------------------------------------ */

/** Einen Timer anlegen. */
export function timerNeu(ms, titel, jetzt, id = null) {
  const dauer = Math.max(1000, Math.min(MAX_TIMER_MS, Math.round(Number(ms) || 0)));
  return {
    id: id || `t${jetzt.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    titel: String(titel || '').trim().slice(0, 60) || 'Timer',
    dauerMs: dauer,
    endeMs: jetzt + dauer,
    aus: false,
  };
}

/**
 * Gemerkte Timer pruefen (nur fuer diesen Tab, lib/lokal.js entwurf): kaputtes
 * faellt weg, ausgeschaltete auch, und ein Timer, der laenger als
 * KLINGELN_MS fertig ist, klingelt nicht noch einmal los.
 */
export function timerPruefen(liste, jetzt) {
  const out = [];
  for (const t of Array.isArray(liste) ? liste : []) {
    if (!t || typeof t.id !== 'string' || !Number.isFinite(t.endeMs) || !Number.isFinite(t.dauerMs)) continue;
    if (t.aus === true) continue;
    if (jetzt - t.endeMs > KLINGELN_MS) continue;
    out.push({ id: t.id.slice(0, 40), titel: String(t.titel || 'Timer').slice(0, 60), dauerMs: t.dauerMs, endeMs: t.endeMs, aus: false });
  }
  return out.slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* Termine                                                              */
/* ------------------------------------------------------------------ */

function terminFelder(item) {
  const data = item && item.data && typeof item.data === 'object' ? item.data : (item || {});
  return {
    id: item && item.id,
    occurrence: (item && item.occurrence) || data.occurrence || null,
    titel: String(data.title || 'Termin'),
    ort: String(data.location || ''),
    start: data.start,
    ende: data.end,
    ganztaegig: data.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(String(data.start || '')),
  };
}

/**
 * Der Termin, der jetzt in die Insel gehoert: der naechste, der in
 * hoechstens einer Stunde beginnt, oder einer, der gerade laeuft (bis 15 Min
 * nach Beginn, laenger nicht -- dann ist er Alltag, keine Neuigkeit).
 * Ganztaegiges bleibt draussen, und was in `ohne` steht (Termine, deren
 * Erinnerung als Kapsel an der Insel haengt oder weggeklickt ist).
 * @returns {{id:string, occurrence:string|null, titel:string, ort:string, startMs:number, endeMs:number|null}|null}
 */
export function naechsterTermin(items, jetzt, ohne = null) {
  let best = null;
  for (const item of Array.isArray(items) ? items : []) {
    const f = terminFelder(item);
    if (!f.id || f.ganztaegig) continue;
    if (ohne && typeof ohne.has === 'function' && ohne.has(String(f.id))) continue;
    const startMs = wandzeitMs(f.start);
    if (startMs === null) continue;
    if (startMs - jetzt > TERMIN_VORLAUF_MS || jetzt - startMs > TERMIN_NACHLAUF_MS) continue;
    const endeMs = wandzeitMs(f.ende);
    if (endeMs !== null && endeMs <= jetzt) continue;
    if (!best || startMs < best.startMs) best = { id: f.id, occurrence: f.occurrence, titel: f.titel, ort: f.ort, startMs, endeMs };
  }
  return best;
}

/** "In 12 Min", "Jetzt", "Seit 4 Min" */
export function terminWann(startMs, jetzt) {
  const diff = Math.ceil((startMs - jetzt) / 60000);
  if (diff > 0) return `In ${diff} Min`;
  const seit = Math.floor((jetzt - startMs) / 60000);
  return seit <= 0 ? 'Jetzt' : `Seit ${seit} Min`;
}

/* ------------------------------------------------------------------ */
/* Live-Aktivitaeten: was in der Insel steht                            */
/* ------------------------------------------------------------------ */

/**
 * Die Rangfolge. Oben steht, was jetzt eine Handlung braucht (ein Timer
 * klingelt, das Mikrofon hoert), dann was gerade passiert (die KI
 * schreibt), dann was ruhig weiterlaeuft.
 */
export const RANG = Object.freeze({
  wecker: 100,
  hoeren: 90,
  antwort: 80,
  rueckfrage: 78,
  neu: 70,
  fehler: 65,
  teilen: 60,
  vorlesen: 55,
  timer: 50,
  termin: 40,
  freigabe: 30,
  agent: 20,
});

/** Die Aktivitaeten nach Rang, bei gleichem Rang die juengste zuerst. */
export function ordnen(liste) {
  return [...(Array.isArray(liste) ? liste : [])]
    .filter((a) => a && Object.prototype.hasOwnProperty.call(RANG, a.art))
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (RANG[y.a.art] - RANG[x.a.art]) || ((y.a.zeit || 0) - (x.a.zeit || 0)) || (x.i - y.i))
    .map((x) => x.a);
}

/**
 * Was die kleine Insel zeigt: die wichtigste Aktivitaet gross, eine zweite
 * als Blase daneben (wie zwei Live-Aktivitaeten auf dem iPhone) -- aber nur
 * eine, die in wenigen Zeichen etwas sagt (Countdown, Minuten, Punkt).
 */
export function kompakt(liste) {
  const sortiert = ordnen(liste);
  const haupt = sortiert[0] || null;
  const neben = sortiert.slice(1).find((a) => ['timer', 'termin', 'teilen', 'hoeren', 'vorlesen', 'freigabe', 'agent', 'wecker'].includes(a.art)) || null;
  return { haupt, neben, alle: sortiert };
}

/**
 * Text einer Aktivitaet: `text` fuer die grosse Zeile, `kurz` fuer die Blase,
 * `ton` fuer die Farbe (ki, rot, orange, gruen, grau).
 */
export function aktivitaetText(a, jetzt) {
  if (!a) return { text: '', kurz: '', ton: 'grau' };
  switch (a.art) {
    case 'wecker':
      return { text: `${a.titel || 'Timer'} ist fertig`, kurz: 'Fertig', ton: 'orange' };
    case 'hoeren':
      return { text: a.zwischen ? kurzText(a.zwischen, 48) : 'Ich höre zu …', kurz: '', ton: 'rot' };
    case 'antwort': {
      const satz = {
        chat: 'Bereite vor …',
        bild: 'Schaue auf den Bildschirm …',
        ablegen: 'Schicke das Bild …',
        denkt: 'Denkt nach …',
        werkzeug: a.schritt || 'Arbeitet …',
        schreibt: a.vorschau ? kurzText(a.vorschau, 60, { ende: true }) : 'Schreibt …',
      }[a.phase] || 'Denkt nach …';
      return { text: satz, kurz: '', ton: 'ki' };
    }
    case 'rueckfrage':
      return { text: kurzText(a.frage || 'Eine Rückfrage', 60), kurz: '?', ton: 'ki' };
    case 'neu':
      return { text: kurzText(a.vorschau || 'Antwort ist da', 60), kurz: '', ton: 'gruen' };
    case 'fehler':
      return { text: kurzText(a.satz || 'Das ging nicht.', 60), kurz: '!', ton: 'rot' };
    case 'teilen':
      return { text: 'Ich schaue mit', kurz: '', ton: 'rot' };
    case 'vorlesen':
      return { text: 'Liest vor …', kurz: '', ton: 'ki' };
    case 'timer': {
      const rest = Math.max(0, (a.endeMs || 0) - jetzt);
      return { text: `${a.titel || 'Timer'} · ${uhrText(rest)}`, kurz: uhrText(rest), ton: 'orange' };
    }
    case 'termin': {
      const wann = terminWann(a.startMs, jetzt);
      const diff = Math.ceil((a.startMs - jetzt) / 60000);
      return { text: `${wann} · ${a.titel}`, kurz: diff > 0 ? `${diff} Min` : 'Jetzt', ton: 'ki' };
    }
    case 'freigabe': {
      const n = Number(a.anzahl) || 0;
      return { text: n === 1 ? 'Eine Freigabe wartet' : `${n} Freigaben warten`, kurz: String(n), ton: 'orange' };
    }
    case 'agent':
      return { text: kurzText(`Agent: ${a.titel || 'arbeitet'}`, 60), kurz: '', ton: 'gruen' };
    default:
      return { text: '', kurz: '', ton: 'grau' };
  }
}

/* ------------------------------------------------------------------ */
/* Texte                                                                */
/* ------------------------------------------------------------------ */

/**
 * Ein Stueck Markdown als eine ruhige Zeile: ohne Codebloecke, Zeichen und
 * Verweise; gekuerzt mit "…". `ende`: das ENDE zeigen (waehrend die KI
 * schreibt, ist das Neue hinten).
 */
export function kurzText(markdown, max = 60, { ende = false } = {}) {
  let t = String(markdown || '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\d{1,2}\]/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  if (ende) {
    t = t.slice(t.length - (max - 1));
    const leer = t.indexOf(' ');
    return `…${leer > 0 && leer < 14 ? t.slice(leer + 1) : t}`;
  }
  t = t.slice(0, max - 1);
  const leer = t.lastIndexOf(' ');
  return `${leer > max * 0.6 ? t.slice(0, leer) : t}…`;
}

/**
 * Waehrend die KI schreibt: ein angefangener ```ui-Baustein (sein JSON ist
 * noch nicht fertig) wird nicht als Code gezeigt, sondern weggelassen.
 * @returns {{text:string, baustein:boolean}}
 */
export function ohneOffenenBaustein(markdown) {
  const md = String(markdown || '');
  const re = /^(\s{0,3})(`{3,}|~{3,})([^\n]*)$/gm;
  let offen = null;
  let m;
  while ((m = re.exec(md))) {
    if (!offen) {
      offen = { zaun: m[2], info: m[3].trim().toLowerCase(), index: m.index };
    } else if (m[2][0] === offen.zaun[0] && m[2].length >= offen.zaun.length && !m[3].trim()) {
      offen = null;
    }
  }
  if (offen && /^ui\b/.test(offen.info)) return { text: md.slice(0, offen.index).replace(/\s+$/, ''), baustein: true };
  return { text: md, baustein: false };
}

/** Ein Codezaun, der laenger ist als jede Folge von ` im Text. */
export function zaunFuer(textWert) {
  let laengste = 0;
  for (const m of String(textWert || '').matchAll(/`+/g)) laengste = Math.max(laengste, m[0].length);
  return '`'.repeat(Math.max(3, laengste + 1));
}

/**
 * Die Frage mit dem, worauf sie sich bezieht -- Text aus der
 * Zwischenablage, eine Markierung, eine abgelegte Textdatei.
 * @param {string} frage
 * @param {{name:string, text:string}[]} texte
 */
export function frageMitTexten(frage, texte = []) {
  let out = String(frage || '').trim();
  for (const t of Array.isArray(texte) ? texte : []) {
    if (!t || !String(t.text || '').trim()) continue;
    let inhalt = String(t.text).replace(/\r\n?/g, '\n');
    if (inhalt.length > MAX_KONTEXT_ZEICHEN) inhalt = `${inhalt.slice(0, MAX_KONTEXT_ZEICHEN)}\n[… gekürzt]`;
    const z = zaunFuer(inhalt);
    out += `${out ? '\n\n' : ''}**${t.name || 'Text'}:**\n${z}\n${inhalt}\n${z}`;
  }
  return out;
}

/**
 * Worauf sich "das" bezieht -- der Reihe nach: ein Bild vom geteilten
 * Bildschirm, Angehaengtes, dann die Zwischenablage (wird erst dann
 * gelesen), dann das, was in Neural OS offen ist.
 * @returns {'bild'|'anhang'|'zwischenablage'|'offen'|null}
 */
export function kontextWahl({ teilen = false, bildMit = true, anhaenge = 0, zwischenablage = false, offen = false } = {}) {
  if (teilen && bildMit) return 'bild';
  if (anhaenge > 0) return 'anhang';
  if (zwischenablage) return 'zwischenablage';
  if (offen) return 'offen';
  return null;
}

/** Welcher Bereich von Neural OS gerade offen ist, als Hinweis an die KI -- oder null. */
export function offenHinweis(route) {
  if (!route || typeof route !== 'object') return null;
  const params = route.params || {};
  const id = typeof params.id === 'string' ? params.id : '';
  if (!/^[a-z]+_[A-Za-z0-9_-]{4,80}$/.test(id)) return null;
  const was = { notes: 'die Notiz', kalender: 'der Termin', projects: 'das Projekt', agents: 'der Agentenlauf', graph: 'der Eintrag' }[route.view];
  if (!was) return null;
  return `[Gerade offen in Neural OS: ${was} ${id}]`;
}

/** Der Name eines Insel-Chats: "Insel · 01.10., 14:32". */
export function chatTitel(jetzt) {
  const d = new Date(jetzt);
  return `Insel · ${pad(d.getDate())}.${pad(d.getMonth() + 1)}., ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Ist das letzte Insel-Gespraech zu alt fuer eine neue Frage? */
export function gespraechAbgelaufen(zuletztMs, jetzt, pause = GESPRAECH_PAUSE_MS) {
  if (!Number.isFinite(zuletztMs)) return true;
  return jetzt - zuletztMs > pause;
}

/** Der Name eines Bildschirmfotos: "Bildschirm 14-32-05.jpg". */
export function bildName(jetzt) {
  const d = new Date(jetzt);
  return `Bildschirm ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.jpg`;
}

/** Masse eines Bildes, so verkleinert, dass die laengste Kante hoechstens `kante` ist (nie vergroessert). */
export function bildMasse(breite, hoehe, kante = BILD_KANTE) {
  const b = Math.max(1, Math.round(Number(breite) || 0));
  const h = Math.max(1, Math.round(Number(hoehe) || 0));
  const f = Math.min(1, kante / Math.max(b, h));
  return { breite: Math.max(1, Math.round(b * f)), hoehe: Math.max(1, Math.round(h * f)) };
}

/* ------------------------------------------------------------------ */
/* Was der Browser kann -- und die Saetze, wenn nicht                   */
/* ------------------------------------------------------------------ */

/** Kann dieser Browser die Insel ueber andere Programme legen (Document Picture-in-Picture)? */
export function schwebenMoeglich(w = globalThis) {
  return !!(w && w.isSecureContext !== false && w.documentPictureInPicture
    && typeof w.documentPictureInPicture.requestWindow === 'function');
}

/** Kann dieser Browser den Bildschirm teilen? (iPad und iPhone: nein) */
export function teilenMoeglich(w = globalThis) {
  const md = w && w.navigator && w.navigator.mediaDevices;
  return !!(w && w.isSecureContext !== false && md && typeof md.getDisplayMedia === 'function');
}

export const SCHWEBEN_NICHT = 'Über anderen Programmen schweben kann die Insel in Chrome, Edge, Opera oder Firefox am Computer – nicht in Safari und nicht auf dem iPad.';

/**
 * Der Satz zu einem gescheiterten getDisplayMedia -- null heisst: still
 * (der Mensch hat in der Auswahl selbst auf "Abbrechen" gedrueckt).
 */
export function teilenFehlerSatz(err) {
  const name = err && err.name;
  const nachricht = String((err && err.message) || '');
  if (name === 'NotAllowedError') {
    if (/system/i.test(nachricht)) {
      return 'Dein Computer erlaubt dem Browser keine Bildschirmaufnahme. Am Mac: Systemeinstellungen → Datenschutz & Sicherheit → Bildschirm- & Systemaudioaufnahme, dort den Browser einschalten und ihn neu starten.';
    }
    return null;
  }
  if (name === 'AbortError') return null;
  if (name === 'NotFoundError') return 'Es gibt nichts, was sich teilen ließe.';
  if (name === 'NotReadableError') return 'Der Bildschirm ließ sich nicht aufnehmen – vielleicht verhindert das ein anderes Programm.';
  if (name === 'InvalidStateError') return 'Zum Teilen bitte direkt in die Insel klicken.';
  if (name === 'TypeError' || name === 'NotSupportedError') return 'Dieser Browser kann den Bildschirm nicht teilen.';
  return `Teilen ging nicht${nachricht ? `: ${nachricht}` : '.'}`;
}

/** Der Satz zu einem gescheiterten Schweben (requestWindow). */
export function schwebenFehlerSatz(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError') return 'Das schwebende Fenster geht nur direkt nach einem Klick – bitte noch einmal.';
  if (name === 'NotSupportedError' || name === 'TypeError') return SCHWEBEN_NICHT;
  return `Das schwebende Fenster ging nicht auf${err && err.message ? `: ${err.message}` : '.'}`;
}

/** Groesse des schwebenden Fensters: klein (nur die Zeile) oder gross. */
export function fensterMasse(gross) {
  return gross ? { width: 440, height: 620 } : { width: 400, height: 96 };
}

/** "Strg Umschalt Leertaste" bzw. "⌘ Umschalt Leertaste" */
export function kuerzelText(mac) {
  return `${mac ? '⌘' : 'Strg'} Umschalt Leertaste`;
}

/** Passt ein Tastendruck zum Kuerzel der Insel? */
export function istKuerzel(event) {
  if (!event) return false;
  const leer = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
  return leer && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey;
}

export default {
  uhrText, dauerWorte, wandzeitMs, dauerFinden, befehl, timerNeu, timerPruefen, naechsterTermin, terminWann,
  RANG, ordnen, kompakt, aktivitaetText, kurzText, ohneOffenenBaustein, zaunFuer, frageMitTexten, kontextWahl,
  offenHinweis, chatTitel, gespraechAbgelaufen, bildName, bildMasse, schwebenMoeglich, teilenMoeglich,
  teilenFehlerSatz, schwebenFehlerSatz, fensterMasse, kuerzelText, istKuerzel,
};
