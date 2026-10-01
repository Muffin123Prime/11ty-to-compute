/**
 * lib/insel-logik.js -- das Rechnen hinter der Insel (lib/insel.js), ohne
 * Browser: Zeiten, kleine Befehle, die Rangfolge der Live-Anzeigen,
 * Bildmasse, die Saetze zu Fehlern -- und seit der Insel als kleines Wesen
 * am Rand: in welchem Zustand das Wesen ist (ruht, hoert zu, denkt,
 * spricht, frisst, freut sich, verwirrt, schlaeft), wann jemand fertig
 * gesprochen hat (Stille nach Sprache), welche Datei es essen kann, wo es
 * am Rand sitzt, ohne einen Knopf zu verdecken, und wie gross es aufgeht.
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
  'Ich frage dich über die Insel: das kleine Wesen am Rand von Neural OS, das auch über anderen Programmen schweben kann.',
  'Antworte deshalb kurz: meist ein bis vier Sätze, Listen höchstens fünf Punkte – außer ich will ausdrücklich mehr. Oft spreche ich mit dir und du liest vor: Schreib so, dass es sich gut vorlesen lässt.',
  'Ein Bild in meiner Nachricht ist ein Bildschirmfoto von dem, was ich gerade sehe (ein anderes Programm, eine Webseite, ein Dokument) – oder eine Datei, die ich dir gegeben habe. Sage ich „das“, „hier“ oder „dieses“, meine ich das Bild, die Datei oder den mitgeschickten Text.',
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

/** So viel geht hoechstens in EINE Nachricht (der Server nimmt 200.000 Zeichen; Luft fuer Kopf und Zaeune). */
export const MAX_NACHRICHT_ZEICHEN = 190000;
/** So viel einer gegessenen Textdatei geht mit (wie im Chat). */
export const MAX_DATEI_ZEICHEN = 150000;

/**
 * Die Frage mit dem, worauf sie sich bezieht -- Text aus der
 * Zwischenablage, eine Markierung, eine gegessene Textdatei -- und ehrlich,
 * was davon gekuerzt oder weggelassen werden musste. Jeder Text darf seine
 * eigene Grenze tragen (`max`, sonst MAX_KONTEXT_ZEICHEN); zusammen bleibt
 * alles unter `gesamt` Zeichen.
 * @param {string} frage
 * @param {{name:string, text:string, max?:number}[]} texte
 * @returns {{inhalt:string, gekuerzt:string[], weggelassen:string[]}}
 */
export function textePlanen(frage, texte = [], gesamt = MAX_NACHRICHT_ZEICHEN) {
  let out = String(frage || '').trim();
  const gekuerzt = [];
  const weggelassen = [];
  for (const t of Array.isArray(texte) ? texte : []) {
    if (!t || !String(t.text || '').trim()) continue;
    const name = t.name || 'Text';
    const kopf = `**${name}:**`;
    let inhalt = String(t.text).replace(/\r\n?/g, '\n');
    const eigene = Number(t.max) > 0 ? Number(t.max) : MAX_KONTEXT_ZEICHEN;
    // Platz fuer Trenner, Kopf, zwei Zaeune und "[… gekuerzt]".
    const platz = gesamt - out.length - kopf.length - 40;
    const max = Math.min(eigene, platz);
    if (max < 200) {
      weggelassen.push(name);
      continue;
    }
    if (inhalt.length > max) {
      inhalt = `${inhalt.slice(0, max)}\n[… gekürzt]`;
      gekuerzt.push(name);
    }
    const z = zaunFuer(inhalt);
    out += `${out ? '\n\n' : ''}${kopf}\n${z}\n${inhalt}\n${z}`;
  }
  return { inhalt: out, gekuerzt, weggelassen };
}

/** Wie textePlanen, nur der Text. */
export function frageMitTexten(frage, texte = [], gesamt = MAX_NACHRICHT_ZEICHEN) {
  return textePlanen(frage, texte, gesamt).inhalt;
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

/* ------------------------------------------------------------------ */
/* Das Wesen: in welchem Zustand es ist                                 */
/* ------------------------------------------------------------------ */

/** Die Zustaende des Wesens (lib/insel-wesen.js zeichnet jeden). */
export const WESEN_ZUSTAENDE = Object.freeze(['ruht', 'hoert', 'denkt', 'spricht', 'frisst', 'freut', 'verwirrt', 'schlaeft']);
/** So lange freut es sich, wenn eine Antwort fertig ist. */
export const FREUT_MS = 1800;
/** So lange schaut es verwirrt, wenn etwas schiefging. */
export const VERWIRRT_MS = 3200;

/**
 * Der Zustand des Wesens -- aus dem, was gerade WIRKLICH passiert, nie
 * geraten. Der Reihe nach: Ist Neural OS aus, schlaeft es. Dann kurze
 * Reaktionen (es isst eine Datei, es ist verwirrt), dann was laeuft (das
 * Mikrofon hoert, es liest vor oder die Antwort kommt Wort fuer Wort, es
 * wartet auf das erste Wort), dann die kurze Freude ueber eine fertige
 * Antwort. Ist keine KI verbunden, schlaeft es auch -- erst danach ruht es.
 * @param {{aus?:boolean, verbunden?:boolean|null, frisst?:boolean, verwirrtBis?:number,
 *   hoert?:boolean, spricht?:boolean, schreibt?:boolean, denkt?:boolean, freutBis?:number, jetzt?:number}} e
 * @returns {'ruht'|'hoert'|'denkt'|'spricht'|'frisst'|'freut'|'verwirrt'|'schlaeft'}
 */
export function wesenZustand(e = {}) {
  const jetzt = Number.isFinite(e.jetzt) ? e.jetzt : 0;
  if (e.aus) return 'schlaeft';
  if (e.frisst) return 'frisst';
  if (Number(e.verwirrtBis) > jetzt) return 'verwirrt';
  if (e.hoert) return 'hoert';
  if (e.spricht || e.schreibt) return 'spricht';
  if (e.denkt) return 'denkt';
  if (Number(e.freutBis) > jetzt) return 'freut';
  if (e.verbunden === false) return 'schlaeft';
  return 'ruht';
}

/**
 * Die eine Zeile unter dem grossen Wesen: kurz, was es gerade tut.
 * @param {string} zustand  aus wesenZustand
 * @param {{aus?:boolean, liest?:boolean, schritt?:string, satz?:string, datei?:string, live?:boolean}} [x]
 */
export function wesenSatz(zustand, x = {}) {
  switch (zustand) {
    case 'schlaeft':
      return x.aus ? 'Neural OS ist aus – ich schlafe.' : 'Ich schlafe – deine KI ist noch nicht verbunden.';
    case 'frisst':
      return x.datei ? `Mmh – ich lese „${kurzText(x.datei, 40)}“ …` : 'Mmh – ich lese …';
    case 'verwirrt':
      return kurzText(x.satz || 'Das ging nicht.', 90);
    case 'hoert':
      return 'Ich höre zu …';
    case 'spricht':
      return x.liest ? 'Ich spreche … – zum Unterbrechen tippen' : 'Ich schreibe …';
    case 'denkt':
      return x.schritt ? kurzText(x.schritt, 70) : 'Ich denke …';
    case 'freut':
      return 'Fertig.';
    default:
      return x.live ? 'Ich höre gleich wieder zu …' : 'Was kann ich für dich tun?';
  }
}

/* ------------------------------------------------------------------ */
/* Live: ein echtes Hin und Her                                         */
/* ------------------------------------------------------------------ */

/**
 * Die Phasen des Gespraechs mit Live: zuhoeren -> (Stille) verstehen ->
 * denken -> antworten (schreiben, dann vorlesen) -> wieder zuhoeren.
 * `liveSchritt` sagt, was nach einem Ereignis kommt -- null heisst: Live
 * ist aus. Ein Ereignis, das in einer Phase nichts bedeutet, aendert nichts.
 */
export const LIVE_PHASEN = Object.freeze(['hoert', 'versteht', 'denkt', 'schreibt', 'spricht']);

export function liveSchritt(phase, ereignis) {
  if (ereignis === 'aus' || ereignis === 'mikrofonFehler' || ereignis === 'nichtsGehoert' || ereignis === 'nichtVerbunden') return null;
  if (!phase) return ereignis === 'an' ? 'hoert' : null;
  switch (ereignis) {
    case 'stille': return phase === 'hoert' ? 'versteht' : phase;
    case 'text': return phase === 'versteht' || phase === 'hoert' ? 'denkt' : phase;
    case 'nichtVerstanden': return phase === 'versteht' ? 'hoert' : phase;
    case 'erstesWort': return phase === 'denkt' ? 'schreibt' : phase;
    case 'antwortFertig': return phase === 'denkt' || phase === 'schreibt' ? 'spricht' : phase;
    case 'ohneVorlesen': return phase === 'denkt' || phase === 'schreibt' ? 'hoert' : phase;
    case 'vorgelesen': return phase === 'spricht' ? 'hoert' : phase;
    case 'unterbrechen': return phase === 'spricht' ? 'hoert' : phase;
    case 'antwortFehler': return phase === 'denkt' || phase === 'schreibt' || phase === 'spricht' ? 'hoert' : phase;
    default: return phase;
  }
}

/** Die eine Zeile, die sagt, wo das Gespraech steht. */
export function liveSatz(phase) {
  return {
    hoert: 'Ich höre zu …',
    versteht: 'Ich denke …',
    denkt: 'Ich denke …',
    schreibt: 'Ich antworte …',
    spricht: 'Ich spreche … – zum Unterbrechen tippen',
  }[phase] || '';
}

/**
 * Geht Live hier? Es braucht ein Mikrofon und einen Weg von Sprache zu
 * Text: die Erkennung des Browsers, oder eine Aufnahme, die Gemini
 * umschreibt. Sonst ein ehrlicher Satz -- und es bleibt beim Tippen.
 * @param {{sicher?:boolean, mikrofon?:boolean, weg?:'erkennung'|'aufnahme'|null}} b
 * @returns {{ok:boolean, satz:string|null}}
 */
export function liveMoeglich({ sicher = true, mikrofon = true, weg = null } = {}) {
  if (!sicher) return { ok: false, satz: 'Live geht nur, wenn Neural OS auf diesem Gerät läuft (127.0.0.1) – über das WLAN erlaubt der Browser kein Mikrofon.' };
  if (!mikrofon) return { ok: false, satz: 'Dieser Browser gibt kein Mikrofon her – hier geht nur Tippen.' };
  if (!weg) return { ok: false, satz: 'Für Live braucht es Sprache zu Text: Dieser Browser kann das nicht selbst, und ohne Google-Schlüssel (Gemini, kostenlos) kann ich es nicht umschreiben. Unter Einstellungen → KI verbinden.' };
  return { ok: true, satz: null };
}

/* ------------------------------------------------------------------ */
/* Stille erkennen: wann jemand fertig gesprochen hat                   */
/* ------------------------------------------------------------------ */

/**
 * Die Grenzen der Stille-Erkennung. RMS ist die mittlere Lautstaerke eines
 * Stuecks (0 = still, 1 = voll ausgesteuert). Der Grund-Pegel des Raums
 * wird in den ersten KALIBRIER_MS gemessen; Sprache ist deutlich lauter
 * als er (FAKTOR_SPRACHE), Stille kaum (FAKTOR_STILLE). Untergrenzen,
 * damit ein sehr stilles Mikrofon nicht jedes Rauschen fuer Sprache haelt.
 */
export const STILLE = Object.freeze({
  STILLE_MS: 1200,
  MAX_MS: 60000,
  MIN_SPRACHE_MS: 220,
  KALIBRIER_MS: 400,
  SPRACHE_MIN: 0.02,
  STILLE_MIN: 0.012,
  BODEN_MAX: 0.02,
  FAKTOR_SPRACHE: 3,
  FAKTOR_STILLE: 1.8,
});

/** Ein neuer Zustand fuer eine Aufnahme, die jetzt beginnt. */
export function stilleNeu(jetzt, grenzen = {}) {
  return {
    g: { ...STILLE, ...grenzen },
    beginn: jetzt,
    proben: [],
    boden: null,
    lautSeit: null,
    gesprochen: false,
    spracheBeginn: null,
    stilleSeit: null,
    ende: null,
  };
}

/** Die Schwellen aus dem gemessenen Grund-Pegel. */
export function stilleSchwellen(boden, grenzen = STILLE) {
  const b = Math.min(Number(boden) || 0, grenzen.BODEN_MAX);
  return {
    sprache: Math.max(grenzen.SPRACHE_MIN, b * grenzen.FAKTOR_SPRACHE),
    stille: Math.max(grenzen.STILLE_MIN, b * grenzen.FAKTOR_STILLE),
  };
}

/**
 * Ein Messwert mehr. Liefert den neuen Zustand und hoechstens ein
 * Ereignis: 'sprache' (sie hat begonnen), 'stille' (nach Sprache lange
 * genug still: fertig), 'grenze' (MAX_MS erreicht, es wurde gesprochen),
 * 'nichts' (MAX_MS erreicht, und nie gesprochen). Nach 'stille', 'grenze'
 * oder 'nichts' kommt nichts mehr.
 * @returns {{z:object, ereignis:null|'sprache'|'stille'|'grenze'|'nichts'}}
 */
export function stilleSchritt(z, rms, jetzt) {
  if (!z || z.ende) return { z, ereignis: null };
  const g = z.g;
  const wert = Math.max(0, Number(rms) || 0);
  const n = { ...z };
  const seit = jetzt - z.beginn;
  if (n.boden === null) {
    n.proben = [...z.proben, wert];
    if (seit >= g.KALIBRIER_MS) {
      // Der leiseste Teil der ersten Stuecke: wer sofort losredet, macht Pausen zwischen den Silben.
      const sortiert = [...n.proben].sort((a, b) => a - b);
      n.boden = sortiert[Math.floor(sortiert.length * 0.2)] || 0;
    }
  }
  const s = stilleSchwellen(n.boden === null ? 0 : n.boden, g);
  let ereignis = null;
  if (wert >= s.sprache) {
    if (n.lautSeit === null) n.lautSeit = jetzt;
    n.stilleSeit = null;
    if (!n.gesprochen && jetzt - n.lautSeit >= g.MIN_SPRACHE_MS) {
      n.gesprochen = true;
      n.spracheBeginn = n.lautSeit;
      ereignis = 'sprache';
    }
  } else {
    if (wert < s.stille) n.lautSeit = null;
    if (n.gesprochen) {
      if (wert < s.stille) {
        if (n.stilleSeit === null) n.stilleSeit = jetzt;
        if (jetzt - n.stilleSeit >= g.STILLE_MS) {
          n.ende = 'stille';
          return { z: n, ereignis: 'stille' };
        }
      } else {
        n.stilleSeit = null;
      }
    }
  }
  if (seit >= g.MAX_MS) {
    n.ende = n.gesprochen ? 'grenze' : 'nichts';
    return { z: n, ereignis: n.ende };
  }
  return { z: n, ereignis };
}

/** Lautstaerke eines Stuecks Samples (Float32, -1..1) als RMS. */
export function rmsVon(samples) {
  const n = samples ? samples.length : 0;
  if (!n) return 0;
  let summe = 0;
  for (let i = 0; i < n; i += 1) summe += samples[i] * samples[i];
  return Math.sqrt(summe / n);
}

/** RMS als Pegel 0..1 fuer den Ring ums Wesen (Sprache liegt grob bei 0,02-0,3). */
export function pegelAusRms(rms) {
  const r = Math.max(0, Number(rms) || 0);
  if (r <= 0.004) return 0;
  // Logarithmisch: leises Sprechen soll man schon sehen.
  return Math.max(0, Math.min(1, (Math.log10(r) + 2.4) / 1.9));
}

/* ------------------------------------------------------------------ */
/* Dateien: was das Wesen essen kann                                    */
/* ------------------------------------------------------------------ */

/** Grenzen wie der Server (src/models/anhaenge.js) -- und fuer Textdateien 200 KB. */
export const DATEI = Object.freeze({
  BILD_ARTEN: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  PDF_ART: 'application/pdf',
  MAX_PDF_BYTES: 20 * 1024 * 1024,
  /** Groessere Fotos werden verkleinert (lib/anhaenge.js); ueber dieser Grenze nimmt der Browser sie nicht sicher auf. */
  MAX_BILD_ROH_BYTES: 40 * 1024 * 1024,
  MAX_TEXT_BYTES: 200 * 1024,
});

const DATEI_ENDUNG = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
};
const DATEI_ALIAS = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'application/x-pdf': 'application/pdf' };
const TEXT_ENDUNG = /\.(txt|text|md|markdown|csv|tsv|json|log|xml|ya?ml|ini|toml|ics|vcf|srt|html?|css|js|mjs|ts|py|sh|bat|sql|tex)$/i;

/** Der Satz, was das Wesen isst. */
export const ESSBAR = 'Ich nehme Bilder (PNG, JPG, WEBP, GIF), PDF und Textdateien (.txt, .md, .csv, .json).';

function kb(bytes) {
  return Math.max(1, Math.round(Number(bytes) / 1024)).toLocaleString('de-DE');
}
function mbText(bytes) {
  return (Number(bytes) / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

/**
 * Kann das Wesen diese Datei essen? Nach der Angabe des Browsers, und nur
 * wenn er nichts sagt nach der Endung -- wie der Chat (lib/anhaenge.js).
 * Ob der Inhalt stimmt, prueft der Server an den ersten Bytes.
 * @param {{name?:string, type?:string, size?:number}} datei
 * @returns {{art:'bild'|'pdf'|'text', mime:string, satz:null} | {art:null, grund:'art'|'gross'|'leer', satz:string}}
 */
export function dateiPruefen(datei = {}) {
  const name = String((datei && datei.name) || 'Datei');
  const roh = String((datei && datei.type) || '').toLowerCase().trim();
  const typ = DATEI_ALIAS[roh] || roh;
  const groesse = Number(datei && datei.size);
  const g = Number.isFinite(groesse) ? groesse : 0;
  let art = null;
  let mime = typ;
  if (DATEI.BILD_ARTEN.includes(typ)) art = 'bild';
  else if (typ === DATEI.PDF_ART) art = 'pdf';
  else if (!typ || typ === 'application/octet-stream') {
    const endung = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
    const aus = endung ? DATEI_ENDUNG[endung.toLowerCase()] : null;
    if (aus) {
      art = aus === DATEI.PDF_ART ? 'pdf' : 'bild';
      mime = aus;
    }
  }
  if (!art && (typ.startsWith('text/') || /json|csv|xml/.test(typ) || TEXT_ENDUNG.test(name))) {
    art = 'text';
    mime = typ || 'text/plain';
  }
  const kurz = kurzText(name, 48);
  if (!art) return { art: null, grund: 'art', satz: `„${kurz}“ kann ich nicht lesen. ${ESSBAR}` };
  if (Number.isFinite(groesse) && g <= 0) return { art: null, grund: 'leer', satz: `„${kurz}“ ist leer.` };
  if (art === 'text' && g > DATEI.MAX_TEXT_BYTES) {
    return { art: null, grund: 'gross', satz: `„${kurz}“ ist zu groß für mich (${kb(g)} KB) – Textdateien bis ${kb(DATEI.MAX_TEXT_BYTES)} KB.` };
  }
  if (art === 'pdf' && g > DATEI.MAX_PDF_BYTES) {
    return { art: null, grund: 'gross', satz: `„${kurz}“ ist zu groß (${mbText(g)} MB, erlaubt sind ${mbText(DATEI.MAX_PDF_BYTES)} MB).` };
  }
  if (art === 'bild' && g > DATEI.MAX_BILD_ROH_BYTES) {
    return { art: null, grund: 'gross', satz: `„${kurz}“ ist zu groß (${mbText(g)} MB). Bilder bis ${mbText(DATEI.MAX_BILD_ROH_BYTES)} MB.` };
  }
  return { art, mime, satz: null };
}

/** Was mitgeht, wenn jemand nur Dateien gibt und nichts dazu schreibt. */
export function dateienAuftrag(anzahl) {
  return Number(anzahl) > 1 ? 'Werte diese Dateien aus.' : 'Werte diese Datei aus.';
}

/** Das kleine Schild auf der Datei, die ins Maul fliegt: "PDF", "TXT", "BILD". */
export function dateiKuerzel(name, art) {
  if (art === 'bild') return 'BILD';
  if (art === 'pdf') return 'PDF';
  const endung = (/\.([a-z0-9]{1,5})$/i.exec(String(name || '')) || [])[1];
  return endung ? endung.toUpperCase().slice(0, 4) : 'TEXT';
}

/* ------------------------------------------------------------------ */
/* Wo das Wesen sitzt, und wie gross es aufgeht                         */
/* ------------------------------------------------------------------ */

/** Masse am Rand. */
export const LAGE = Object.freeze({
  RAND: 16,
  GROESSE: 60,
  GROESSE_FINGER: 56,
  /** So breit ist die Spur am rechten Rand, wenn die Spalte zu ist (Groesse + Rand). */
  SPUR: 76,
  ABSTAND: 8,
  PANEL_BREITE: 400,
  PANEL_HOEHE_MAX: 760,
  TELEFON_BIS: 600,
});

/**
 * Bekommt das Wesen eine eigene Spur am rechten Rand? Ab 1000 px stehen
 * die Spalten nebeneinander (web/app.css). Ist die rechte Spalte zu, reicht
 * der Inhalt sonst bis an den Rand -- dort lagen Knoepfe (der Sonntag im
 * Kalender, Schalter in den Einstellungen). Mit der Spur verdeckt es nichts.
 * Ist die Spalte offen, sitzt es ueber ihr; darunter (Telefon, iPad hoch)
 * schwebt es unten rechts.
 */
export function randSpur({ breite, rechtsOffen }) {
  return Number(breite) >= 1000 && !rechtsOffen;
}

/**
 * Wo am rechten Rand das Wesen sitzt: moeglichst im unteren Drittel der
 * Mitte (am Telefon unten), aber nie auf einem Knopf. `hindernisse` sind
 * die Bedienelemente, die waagrecht in seinem Streifen liegen ({top,
 * bottom} in Pixeln). Sitzt es schon frei (`aktuell`), bleibt es dort --
 * ein Wesen, das bei jeder Kleinigkeit huepft, stoert. Nur wenn es weit
 * weg von seiner Wunschstelle sitzt (mehr als `heimweh`) und die frei ist,
 * geht es heim.
 * @returns {{y:number, frei:boolean}}  y = obere Kante
 */
export function dockLage({
  hoehe, telefon = false, groesse = LAGE.GROESSE, oben = 72, unten = LAGE.RAND, hindernisse = [], aktuell = null, abstand = LAGE.ABSTAND, heimweh = 160,
} = {}) {
  const h = Math.max(0, Number(hoehe) || 0);
  const minY = Math.max(0, Math.round(oben));
  const maxY = Math.max(minY, Math.round(h - unten - groesse));
  const bevorzugt = Math.min(maxY, Math.max(minY, telefon ? maxY : Math.round(h * 0.6 - groesse / 2)));
  // Belegte Bereiche, mit Abstand, sortiert und zusammengefasst.
  const belegt = (Array.isArray(hindernisse) ? hindernisse : [])
    .filter((r) => r && Number.isFinite(r.top) && Number.isFinite(r.bottom) && r.bottom > r.top)
    .map((r) => [r.top - abstand, r.bottom + abstand])
    .sort((a, b) => a[0] - b[0]);
  const zusammen = [];
  for (const [a, b] of belegt) {
    const letzte = zusammen[zusammen.length - 1];
    if (letzte && a <= letzte[1]) letzte[1] = Math.max(letzte[1], b);
    else zusammen.push([a, b]);
  }
  const frei = (y) => y >= minY && y <= maxY && !zusammen.some(([a, b]) => y < b && y + groesse > a);
  if (Number.isFinite(aktuell) && frei(Math.round(aktuell))) {
    const nah = Math.abs(Math.round(aktuell) - bevorzugt) <= heimweh;
    if (nah || !frei(bevorzugt)) return { y: Math.round(aktuell), frei: true };
  }
  // Kandidaten: die Wunschstelle und jede Kante eines belegten Bereichs -- vom Hindernis WEG
  // gerundet (Bildschirmpunkte sind krumm: 1014,375); sonst laege es um einen Bruchteil darauf.
  const kandidaten = [bevorzugt];
  for (const [a, b] of zusammen) kandidaten.push(Math.ceil(b), Math.floor(a - groesse));
  let best = null;
  for (const y of kandidaten) {
    const c = Math.min(maxY, Math.max(minY, y));
    if (!frei(c)) continue;
    const d = Math.abs(c - bevorzugt);
    if (best === null || d < best.d || (d === best.d && c > best.y)) best = { y: c, d };
  }
  if (best) return { y: best.y, frei: true };
  return { y: bevorzugt, frei: false };
}

/**
 * Wie gross die Insel aufgeht: am Rechner und iPad ein Feld am rechten Rand
 * (400 px breit, hoechstens 80 % der Hoehe) -- nie der ganze Bildschirm.
 * Am Telefon ein Blatt von unten (85 % der Hoehe).
 * @returns {{art:'feld'|'blatt', breite:number, hoehe:number, rechts:number, unten:number}}
 */
export function panelLage({ breite, hoehe }) {
  const b = Math.max(0, Number(breite) || 0);
  const h = Math.max(0, Number(hoehe) || 0);
  if (b < LAGE.TELEFON_BIS) {
    return { art: 'blatt', breite: b, hoehe: Math.round(h * 0.85), rechts: 0, unten: 0 };
  }
  const rand = LAGE.RAND;
  return {
    art: 'feld',
    breite: Math.min(LAGE.PANEL_BREITE, b - 2 * rand),
    hoehe: Math.round(Math.max(280, Math.min(h * 0.8, LAGE.PANEL_HOEHE_MAX, h - 2 * rand))),
    rechts: rand,
    unten: rand,
  };
}

/* ------------------------------------------------------------------ */
/* Was die KI unterwegs tut: suchen, lesen, nachsehen                   */
/* ------------------------------------------------------------------ */

/**
 * Eine Zeile zu einem Arbeitsschritt aus dem Strom (Ereignis `agent`):
 * "Sucht im Internet: „Wetter Berlin“", danach "Gesucht: „Wetter Berlin“ ·
 * 5 Treffer". Jedes andere Werkzeug der Recherche (etwa das Nachschlagen in
 * Wikipedia: "Wikipedia: „Brandenburger Tor“" · "2 Artikel gefunden") steht
 * mit seinem eigenen Titel da -- die Insel muss das Werkzeug nicht kennen.
 * Was etwas anlegt (Termin, Notiz), zeigt die Insel als Karte; dafuer gibt
 * es hier null.
 * @param {{rolle?:string, titel?:string, schritt?:string, zustand?:string, ergebnis?:string, wirkung?:Array, werkzeug?:string}} a
 * @returns {{text:string, laeuft:boolean, fehler:boolean, art:'suche'|'lesen'|'nachschlagen'|'wissen'|'werkzeug'}|null}
 */
export function schrittSatz(a) {
  if (!a || typeof a !== 'object') return null;
  if (Array.isArray(a.wirkung) && a.wirkung.length && a.zustand !== 'laeuft') return null;
  const laeuft = a.zustand === 'laeuft';
  const fehler = a.zustand === 'fehler';
  const titel = String(a.titel || '');
  const erg = a.ergebnis ? String(a.ergebnis) : '';
  // Danach steht, was herauskam; ging es schief und sagt niemand warum, steht das da.
  const dazu = (satz) => {
    if (laeuft) return satz;
    if (erg) return `${satz} · ${kurzText(erg, 60)}`;
    return fehler ? `${satz} · ging nicht` : satz;
  };
  if (a.rolle === 'recherche') {
    const q = /^Sucht:\s*(.*)$/.exec(titel);
    const l = /^Liest:\s*(.*)$/.exec(titel);
    if (q) return { text: laeuft ? `Sucht im Internet: „${kurzText(q[1], 60)}“` : dazu(`Gesucht: „${kurzText(q[1], 60)}“`), laeuft, fehler, art: 'suche' };
    if (l) {
      if (laeuft) return { text: `Liest: ${kurzText(l[1], 60)}`, laeuft, fehler, art: 'lesen' };
      if (!fehler && /^Gelesen:/.test(erg)) return { text: kurzText(erg, 90), laeuft, fehler, art: 'lesen' };
      return { text: fehler ? dazu(`Nicht gelesen: ${kurzText(l[1], 60)}`) : `Gelesen: ${kurzText(l[1], 60)}`, laeuft, fehler, art: 'lesen' };
    }
    if (titel && titel !== 'Recherche') {
      const nachschlagen = /wikipedia|lexikon|nachschlag/i.test(`${a.werkzeug || ''} ${titel} ${a.schritt || ''}`);
      return { text: dazu(kurzText(titel, 70)), laeuft, fehler, art: nachschlagen ? 'nachschlagen' : 'suche' };
    }
    return { text: laeuft ? 'Sucht im Internet' : dazu('Im Internet gesucht'), laeuft, fehler, art: 'suche' };
  }
  if (a.rolle === 'wissen') {
    const q = /^Sucht in deinem Wissen:\s*(.*)$/.exec(titel);
    if (q) return { text: laeuft ? `Sucht in deinem Wissen: ${kurzText(q[1], 60)}` : dazu(`In deinem Wissen gesucht: ${kurzText(q[1], 60)}`), laeuft, fehler, art: 'wissen' };
    return { text: laeuft ? kurzText(titel || 'Sieht in deinem Wissen nach', 70) : dazu(kurzText(titel || 'In deinem Wissen nachgesehen', 70)), laeuft, fehler, art: 'wissen' };
  }
  const satz = kurzText(titel || a.schritt || 'Arbeitsschritt', 70);
  return { text: laeuft ? satz : dazu(satz), laeuft, fehler, art: 'werkzeug' };
}

/** Der Rechnername einer Quelle, ohne "www." ("wetter.de"); ein Eintrag aus dem eigenen Wissen hat keinen. */
export function quelleHost(url) {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

/* ------------------------------------------------------------------ */
/* Die kleinen Schilder neben dem Wesen                                 */
/* ------------------------------------------------------------------ */

/**
 * Ein Schild neben dem Wesen (zu): kurz, was lebt -- "4:59 Tee", "In 12
 * Min · Zahnarzt", "Hört zu". `ton`: 'ki' (der Akzent), 'aufnahme' (ein
 * roter Punkt: Mikrofon oder Bildschirm sind offen), 'leise'.
 * @returns {{text:string, ton:'ki'|'aufnahme'|'leise', symbol:string}|null}
 */
export function chipFuer(a, jetzt) {
  if (!a) return null;
  switch (a.art) {
    case 'timer': {
      const rest = uhrText(Math.max(0, (a.endeMs || 0) - jetzt));
      return { text: a.titel && a.titel !== 'Timer' ? `${rest} ${kurzText(a.titel, 18)}` : rest, ton: 'leise', symbol: 'timer' };
    }
    case 'termin':
      return { text: `${terminWann(a.startMs, jetzt)} · ${kurzText(a.titel || 'Termin', 22)}`, ton: 'ki', symbol: 'termin' };
    case 'freigabe': {
      const n = Number(a.anzahl) || 0;
      return { text: n === 1 ? '1 Freigabe' : `${n} Freigaben`, ton: 'leise', symbol: 'freigabe' };
    }
    case 'agent':
      return { text: kurzText(`Agent: ${a.titel || 'arbeitet'}`, 30), ton: 'leise', symbol: 'agent' };
    case 'hoeren':
      return { text: 'Hört zu', ton: 'aufnahme', symbol: 'mikro' };
    case 'teilen':
      return { text: 'Sieht deinen Bildschirm', ton: 'aufnahme', symbol: 'bildschirm' };
    case 'vorlesen':
      return { text: 'Liest vor', ton: 'ki', symbol: 'vorlesen' };
    case 'antwort':
      return { text: a.phase === 'schreibt' ? 'Schreibt …' : (a.phase === 'werkzeug' && a.schritt ? kurzText(a.schritt, 30) : 'Denkt …'), ton: 'ki', symbol: 'welle' };
    case 'neu':
      return { text: kurzText(a.vorschau || 'Antwort ist da', 34), ton: 'ki', symbol: 'neu' };
    case 'rueckfrage':
      return { text: 'Eine Rückfrage', ton: 'ki', symbol: 'hinweis' };
    case 'fehler':
      return { text: kurzText(a.satz || 'Das ging nicht.', 34), ton: 'leise', symbol: 'hinweis' };
    default:
      return null;
  }
}

/** Neben dem Wesen stehen hoechstens so viele Schilder -- der Rest steht drin. */
export const MAX_CHIPS = 2;

export default {
  uhrText, dauerWorte, wandzeitMs, dauerFinden, befehl, timerNeu, timerPruefen, naechsterTermin, terminWann,
  RANG, ordnen, kompakt, aktivitaetText, kurzText, ohneOffenenBaustein, zaunFuer, frageMitTexten, textePlanen, kontextWahl,
  offenHinweis, chatTitel, gespraechAbgelaufen, bildName, bildMasse, schwebenMoeglich, teilenMoeglich,
  teilenFehlerSatz, schwebenFehlerSatz, fensterMasse, kuerzelText, istKuerzel,
  wesenZustand, wesenSatz, liveSchritt, liveSatz, liveMoeglich, stilleNeu, stilleSchwellen, stilleSchritt, rmsVon, pegelAusRms,
  dateiPruefen, dateienAuftrag, dateiKuerzel, randSpur, dockLage, panelLage, schrittSatz, quelleHost, chipFuer,
};
