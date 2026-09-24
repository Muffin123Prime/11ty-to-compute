/**
 * views/kalender.js -- der Kalender: Tag, Woche, Monat, Liste.
 *
 * Massstab ist, was man beim Blick auf einen guten Kalender NICHT merkt:
 * dass er rechnet, laedt, fragt. Der Stil kommt aus der Vorlage
 * (docs/vorlage/app.png, Kachel "Kalender"): schwarz, ruhige Grautoene,
 * EIN Blau -- der senkrechte Balken, die Jetzt-Linie, heute.
 *
 * Was man hier tut, und warum es so gebaut ist
 * --------------------------------------------
 * - **Ein Feld oben: "Neuer Termin …".** Man tippt, wie man spricht
 *   ("Morgen 15 Uhr Zahnarzt", "jeden Dienstag 18-19:30 Training"), sieht
 *   sofort, was daraus wird, Enter traegt ein. Gelesen wird in
 *   web/lib/datum-parser.js -- einer reinen Funktion mit eigenen Tests.
 * - **Vier Ansichten, ein ruhiger Umschalter.** Tag und Woche als
 *   Stundenraster mit blauer Jetzt-Linie, Monat mit Tagesliste, Liste
 *   "Als Naechstes". Die Wahl wird gemerkt. Pfeile, "Heute", Wischen auf dem
 *   iPad, Tasten (T, Pfeile, N, D/W/M/L).
 * - **Ziehen statt Formular.** Im Raster verschiebt man einen Termin mit Maus
 *   oder Finger (Finger: kurz halten, dann ziehen -- sonst waere Scrollen
 *   unmoeglich), der untere Rand verlaengert, eine leere Stelle legt an. Alles
 *   im 15-Minuten-Raster, alles mit "Rueckgaengig". Bei Serien fragt eine
 *   kleine Karte: "Nur dieser Termin" oder "Alle".
 * - **Jeder Termin sagt, woher er kommt.** Einen von der KI angelegten
 *   erkennt man an einem kleinen, ruhigen Zeichen; das Seitenblatt nennt den
 *   Chat und fuehrt dorthin.
 * - **Live.** Legt die KI waehrend eines Gespraechs einen Termin an, erscheint
 *   er ohne Neuladen (record.* ueber den Bus).
 *
 * Server (Vertrag A-E): /api/events/zeitraum liefert Serien je Vorkommen
 * (gleiche id, `occurrence`, `recurring`); `?nur=YYYY-MM-DD` aendert oder
 * loescht genau eines. Schreibende Antworten nennen unter `rueckgaengig` den
 * Verlaufseintrag -- "Rueckgaengig" nimmt ihn, und nur wenn es ihn nicht
 * gibt, wird die Gegenbewegung von hier aus geschrieben.
 *
 * Zeitangaben sind Wandzeit vor Ort ohne Zone ("YYYY-MM-DDTHH:MM", ganztaegig
 * "YYYY-MM-DD"). Verschoben wird auf der Wanduhr (plusMinuten), damit 10:00
 * auch nach der Zeitumstellung 10:00 bleibt.
 *
 * Die reinen Funktionen stehen oben und werden exportiert, damit
 * test/kalender-ansicht.test.js sie ohne Browser pruefen kann.
 */

import {
  parse as leseTermin,
  zeitTeil,
  beschreibe,
  wiederholungInWorten,
  plusMinuten,
  plusTage as plusTageW,
  minutenZwischen,
  tageZwischen,
  tagKurz,
  WT_CODES,
  MON_SATZ,
} from '../lib/datum-parser.js';
import {
  ERINNERUNG_OPTIONEN,
  erinnerungInWorten,
  mitteilungAn,
  mitteilungSchalten,
  mitteilungMoeglich,
} from '../lib/erinnerung.js';

/* ------------------------------------------------------------------ */
/* Reine Datumsfunktionen (ohne DOM)                                   */
/* ------------------------------------------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const pad = (n) => String(n).padStart(2, '0');

/** Ein Datum als "JJJJ-MM-TT" in Ortszeit. */
export function toDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "JJJJ-MM-TT" als Mitternacht vor Ort. */
export function parseDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(day, n) {
  return plusTageW(day, n);
}

/** Derselbe Tag im Monat daneben -- der 31. wird zum letzten, den es gibt. */
export function addMonths(day, n) {
  const d = parseDay(day);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return toDay(new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last)));
}

/** Der Montag der Woche, in der `day` liegt. */
export function startOfWeek(day) {
  const d = parseDay(day);
  return addDays(day, -((d.getDay() + 6) % 7));
}

/** Kalenderwoche nach ISO 8601 (die Woche mit dem ersten Donnerstag ist KW 1). */
export function isoWeek(day) {
  const d = parseDay(day);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/**
 * Die Wochen, die ein Monatsblatt zeigt: von Montag vor dem Ersten bis
 * Sonntag nach dem Letzten -- vier bis sechs Zeilen, nie eine leere.
 * @returns {string[][]}
 */
export function monthGrid(cursor) {
  const d = parseDay(cursor);
  const first = toDay(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = toDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 6);
  const weeks = [];
  let week = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    week.push(day);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  return weeks;
}

/**
 * Eine Zeitangabe lesen, wie der Server sie liest.
 * @returns {{kind:'date'|'local'|'zoned', day:string, ms:number, hm:string|null, min:number}|null}
 */
export function whenOf(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = DATE_RE.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (toDay(d) !== s) return null; // der 31. Februar
    return { kind: 'date', day: s, ms: d.getTime(), hm: null, min: 0 };
  }
  let d;
  let kind;
  m = LOCAL_RE.exec(s);
  if (m) {
    const [hh, mi] = [Number(m[4]), Number(m[5])];
    if (hh > 23 || mi > 59) return null;
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mi, Number(m[6] || 0));
    if (toDay(d) !== `${m[1]}-${m[2]}-${m[3]}`) return null;
    kind = 'local';
    // Die Wanduhr gilt, auch wenn es diese Minute wegen der Zeitumstellung
    // an diesem Tag gar nicht gibt.
    return { kind, day: `${m[1]}-${m[2]}-${m[3]}`, ms: d.getTime(), hm: `${m[4]}:${m[5]}`, min: hh * 60 + mi };
  }
  if (ZONED_RE.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    d = new Date(ms);
    kind = 'zoned';
  } else {
    return null;
  }
  return {
    kind,
    day: toDay(d),
    ms: d.getTime(),
    hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    min: d.getHours() * 60 + d.getMinutes(),
  };
}

/**
 * Welche Tage ein Termin belegt (beide eingeschlossen), und ob er ganztaegig
 * ist. Ein Termin, der um Mitternacht endet, belegt den Folgetag nicht.
 */
export function spanOf(ev) {
  const start = whenOf(ev && ev.start);
  if (!start) return null;
  const allDay = (ev && ev.allDay === true) || start.kind === 'date';
  let end = whenOf(ev && ev.end);
  if (end && end.ms < start.ms) end = null;
  let lastDay = start.day;
  if (end) {
    lastDay = end.day;
    if (!allDay && end.kind !== 'date' && end.min === 0 && end.day > start.day) lastDay = addDays(end.day, -1);
  }
  return { allDay, firstDay: start.day, lastDay, start, end };
}

/** Beruehrt der Termin diesen Tag? */
export function onDay(span, day) {
  return !!span && span.firstDay <= day && span.lastDay >= day;
}

/**
 * Wie ein Termin an einem bestimmten Tag beschriftet wird: "09:00–10:00",
 * "ab 22:00", "bis 01:00", "ganztägig".
 */
export function timeLabel(span, day) {
  if (!span) return '';
  if (span.allDay) return 'ganztägig';
  const first = day === undefined || day === span.firstDay;
  const last = day === undefined || day === span.lastDay;
  if (first && last) return span.end && span.end.hm !== span.start.hm ? `${span.start.hm}–${span.end.hm}` : span.start.hm;
  if (first) return `ab ${span.start.hm}`;
  if (last && span.end) return `bis ${span.end.hm}`;
  return 'ganztägig';
}

/**
 * Nebeneinander, was sich ueberschneidet: jeder Block bekommt eine Spur und
 * erfaehrt, wie viele Spuren seine Gruppe braucht. Gierig und stabil --
 * derselbe Tag sieht bei jedem Zeichnen gleich aus.
 *
 * @param {{id:string, startMin:number, endMin:number}[]} items
 * @returns {{id:string, startMin:number, endMin:number, lane:number, lanes:number}[]}
 */
export function layoutDay(items) {
  const sorted = [...items].sort((a, b) => (a.startMin - b.startMin) || (b.endMin - a.endMin) || String(a.id).localeCompare(String(b.id)));
  const out = [];
  let group = [];
  let groupEnd = -1;
  let gruppe = 0;
  const flush = () => {
    const laneEnds = [];
    const placed = group.map((item) => {
      let lane = laneEnds.findIndex((end) => end <= item.startMin);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.endMin);
      } else {
        laneEnds[lane] = item.endMin;
      }
      return { ...item, lane };
    });
    for (const item of placed) out.push({ ...item, lanes: laneEnds.length, gruppe });
    gruppe += 1;
    group = [];
    groupEnd = -1;
  };
  for (const item of sorted) {
    if (group.length && item.startMin >= groupEnd) flush();
    group.push(item);
    groupEnd = Math.max(groupEnd, item.endMin);
  }
  if (group.length) flush();
  return out;
}

/**
 * Wo und wie hoch die Termine eines Tages im Stundenraster stehen.
 *
 * Nebeneinander wird nach der GEZEICHNETEN Hoehe entschieden, nicht nur nach
 * der Uhrzeit: ein Block ist mindestens `minPx` hoch (Maus 20 px, Finger
 * 44 px -- sonst trifft man ihn nicht). Drei halbstuendige Termine
 * hintereinander waeren auf dem iPad 44 px hoch bei 28 px Abstand und laegen
 * zu 16 px uebereinander: Text abgeschnitten, Anfasser verdeckt. Mit der
 * gezeichneten Hoehe gerechnet stehen sie nebeneinander.
 *
 * @param {{id:string, startMin:number, endMin:number}[]} items
 * @param {{hour?:number, minPx?:number}} [opts]
 * @returns {{id:string, startMin:number, endMin:number, lane:number, lanes:number, top:number, height:number}[]}
 */
export function rasterBloecke(items, { hour = 48, minPx = 20 } = {}) {
  const minMin = Math.ceil((minPx * 60) / hour);
  const gelegt = layoutDay(items.map((x) => ({ ...x, bisMin: x.endMin, endMin: Math.max(x.endMin, x.startMin + minMin) })));
  return gelegt.map(({ bisMin, ...x }) => ({
    ...x,
    endMin: bisMin,
    top: (x.startMin / 60) * hour,
    height: Math.max(minPx, ((bisMin - x.startMin) / 60) * hour - 2),
  }));
}

/**
 * Das neue Ende beim Ziehen am unteren Rand -- RELATIV zur Bewegung: wer den
 * Anfasser nicht bewegt, aendert nichts. (Vorher galt die Minute unter dem
 * Zeiger: ein Tipp in die obere Haelfte des 16-px-Anfassers kuerzte den
 * Termin um eine Viertelstunde.)
 */
export function dauerEnde(altEndeMin, dyPx, hour, startMin = 0) {
  const neu = altEndeMin + snap((dyPx / hour) * 60);
  return Math.min(24 * 60, Math.max(startMin + 15, neu));
}

/**
 * Anlegen durch Ziehen auf leerer Flaeche: gerundet auf die NAECHSTE
 * Viertelstunde, wie beim Verschieben -- knapp unter der Linie losgelassen
 * heisst diese Linie, nicht eine Viertelstunde mehr.
 */
export function anlegenSpanne(min0, min) {
  const a = Math.floor(min0 / 15) * 15;
  if (min >= min0) return { startMin: a, endMin: Math.max(a + 15, snap(min)) };
  const c = Math.min(a, snap(min));
  return { startMin: c, endMin: Math.max(a + 15, c + 15) };
}

/**
 * Wohin beim Oeffnen gescrollt wird, damit oben kein halber Termin klebt
 * ("Ieleton…", ein 8-px-Streifen vom Zahnarzt). Schneidet ein Termin die
 * Kante und begann er hoechstens `maxZurueck` Minuten davor, beginnt die
 * Ansicht mit ihm; ein langer, der frueher begann, bleibt geschnitten, damit
 * "jetzt" im Bild bleibt.
 *
 * @param {{startMin:number, endMin:number}[]} bloecke
 * @param {number} topMin  gewuenschte Oberkante in Minuten
 */
export function scrollAnfang(bloecke, topMin, maxZurueck = 120) {
  let top = topMin;
  for (let i = 0; i < 24; i++) {
    const schnitt = bloecke.filter((b) => b.startMin < top && b.endMin > top && topMin - b.startMin <= maxZurueck);
    if (!schnitt.length) break;
    top = Math.min(...schnitt.map((b) => b.startMin));
  }
  return Math.max(0, top);
}

/** Eine Zeitangabe als Wandzeit: "YYYY-MM-DD" oder "YYYY-MM-DDTHH:MM" (Zone -> Ortszeit). */
export function alsWand(value) {
  const w = whenOf(value);
  if (!w) return null;
  return w.kind === 'date' ? w.day : `${w.day}T${w.hm}`;
}

/**
 * Ein Element aus /api/events/zeitraum -- Einzeltermin oder Vorkommen einer
 * Serie (Vertrag B) -- in die Form, mit der diese Ansicht zeichnet. Die
 * Felder koennen am Element oder in `data` stehen; gelesen wird beides.
 *
 * @returns {{key:string, id:string, occurrence:string|null, recurring:boolean,
 *   data:object, span:object, serie:object|null}|null}
 */
export function eintragAus(item) {
  if (!item || typeof item !== 'object' || !item.id) return null;
  const data = item.data && typeof item.data === 'object' ? item.data : item;
  const occurrence = item.occurrence || data.occurrence || null;
  const recurring = !!occurrence && (item.recurring === true || data.recurring === true || !!data.recurrence);
  const span = spanOf(data);
  if (!span) return null;
  return {
    key: `${item.id}@${occurrence || ''}`,
    id: item.id,
    occurrence,
    recurring,
    data,
    span,
    serie: item.serie || null,
  };
}

/** Auf das 15-Minuten-Raster. */
export function snap(min, step = 15) {
  return Math.round(min / step) * step;
}

/**
 * Beginn und Ende um Minuten verschieben, auf der Wanduhr. Ganztaegiges
 * wandert in ganzen Tagen.
 */
export function verschieben(start, end, minuten, allDay = false) {
  const s = alsWand(start);
  if (!s) return null;
  const e = end ? alsWand(end) : null;
  if (allDay || s.length === 10) {
    const tage = Math.round(minuten / 1440);
    return { start: plusTageW(s.slice(0, 10), tage), end: e ? plusTageW(e.slice(0, 10), tage) : null };
  }
  return { start: plusMinuten(s, minuten), end: e ? plusMinuten(e.length === 10 ? `${e}T00:00` : e, minuten) : null };
}

/** Beginn und Ende einer Serie auf einen ihrer Tage gelegt (Dauer bleibt). */
export function aufTag(data, day) {
  const s = alsWand(data && data.start);
  if (!s) return null;
  const allDay = data.allDay === true || s.length === 10;
  return verschieben(data.start, data.end, tageZwischen(s.slice(0, 10), day) * 1440, allDay);
}

/**
 * Was an einer SERIE zu aendern ist, wenn eines ihrer Vorkommen von `alt`
 * nach `neu` gezogen wurde und die Antwort "Alle" war: dieselbe Verschiebung
 * fuer den Beginn der Serie, dieselbe neue Dauer -- und wer "jeden Dienstag"
 * auf den Mittwoch zieht, hat danach "jeden Mittwoch". Ausgelassene Tage und
 * das Ende der Serie wandern mit, sonst fielen die falschen Tage aus.
 */
export function serienPatch(serie, alt, neu) {
  const allDay = serie.allDay === true || String(serie.start || '').length === 10;
  const sAlt = alsWand(alt.start);
  const sNeu = alsWand(neu.start);
  const s0 = alsWand(serie.start);
  let start;
  let end;
  if (allDay) {
    ({ start, end } = verschieben(serie.start, serie.end, tageZwischen(sAlt.slice(0, 10), sNeu.slice(0, 10)) * 1440, true));
  } else {
    start = plusMinuten(s0, minutenZwischen(sAlt, sNeu));
    const dauer = neu.end ? minutenZwischen(sNeu, alsWand(neu.end)) : null;
    end = dauer !== null ? plusMinuten(start, dauer) : null;
  }
  const out = { start, end };
  const tage = tageZwischen(s0.slice(0, 10), start.slice(0, 10));
  const rec = serie.recurrence;
  if (rec && tage) {
    const r = { ...rec };
    if (rec.freq === 'weekly' && Array.isArray(rec.byDay) && rec.byDay.length) {
      const shift = ((tage % 7) + 7) % 7;
      r.byDay = rec.byDay.map((c) => WT_CODES[(WT_CODES.indexOf(c) + shift) % 7]);
    }
    if (rec.until) r.until = plusTageW(rec.until, tage);
    out.recurrence = r;
    if (Array.isArray(serie.exdates) && serie.exdates.length) out.exdates = serie.exdates.map((d) => plusTageW(d, tage));
  }
  return out;
}

/**
 * Balken fuer die Ganztags-Zeile: jeder bekommt die oberste freie Zeile, in
 * der er niemanden ueberdeckt. Laengere zuerst, damit ein Urlaub oben liegt.
 * @param {{key:string, von:number, bis:number}[]} bars  Spaltenindizes, beide eingeschlossen
 */
export function packeBalken(bars) {
  const sorted = [...bars].sort((a, b) => (a.von - b.von) || ((b.bis - b.von) - (a.bis - a.von)) || String(a.key).localeCompare(String(b.key)));
  const laneEnds = [];
  return sorted.map((bar) => {
    let lane = laneEnds.findIndex((end) => end < bar.von);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(bar.bis);
    } else {
      laneEnds[lane] = bar.bis;
    }
    return { ...bar, lane };
  });
}

/** Ganztaegig oder mindestens 24 Stunden: gehoert in die Balkenzeile, nicht ins Raster. */
export function istBalken(span) {
  if (!span) return false;
  if (span.allDay) return true;
  return !!span.end && span.end.ms - span.start.ms >= 24 * 3600000;
}

/**
 * "Als Naechstes": die Eintraege nach Tagen, ab `from`. Ein Termin, der vor
 * `from` begann und noch laeuft, steht bei `from`.
 * @returns {{day:string, eintraege:object[]}[]}
 */
export function gruppiereNachTag(eintraege, from, to) {
  const map = new Map();
  for (const e of eintraege) {
    if (!e || e.span.lastDay < from) continue;
    const day = e.span.firstDay < from ? from : e.span.firstDay;
    if (day > to) continue;
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(e);
  }
  return [...map.keys()].sort().map((day) => ({
    day,
    eintraege: map.get(day).sort((a, b) => {
      const aa = a.span.allDay || a.span.firstDay < day;
      const bb = b.span.allDay || b.span.firstDay < day;
      if (aa !== bb) return aa ? -1 : 1;
      return (a.span.start.ms - b.span.start.ms) || String(a.data.title).localeCompare(String(b.data.title), 'de');
    }),
  }));
}

/** Der Zeitraum, den eine Ansicht laedt. */
export function rangeFor(mode, cursor, listeTage = 60, heute = cursor) {
  if (mode === 'woche') {
    const from = startOfWeek(cursor);
    return { from, to: addDays(from, 6) };
  }
  if (mode === 'liste') return { from: heute, to: addDays(heute, listeTage - 1) };
  // Tag laedt den ganzen Monat: der kleine Monat daneben zeigt Punkte.
  const weeks = monthGrid(cursor);
  return { from: weeks[0][0], to: weeks[weeks.length - 1][6] };
}

/* ------------------------------------------------------------------ */
/* Ansicht                                                             */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-kalender-view';
const MODE_KEY = 'neural-os:kalender-ansicht';
const MODES = [['tag', 'Tag', 'D'], ['woche', 'Woche', 'W'], ['monat', 'Monat', 'M'], ['liste', 'Liste', 'L']];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const LISTE_SCHRITT = 60;

const GLYPH = {
  prev: '<path d="M12.2 5 7.2 10l5 5"/>',
  next: '<path d="m7.8 5 5 5-5 5"/>',
  pin: '<path d="M10 17.4s5.4-4.8 5.4-9.2a5.4 5.4 0 0 0-10.8 0c0 4.4 5.4 9.2 5.4 9.2z"/><circle cx="10" cy="8.2" r="1.9"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  repeat: '<path d="M4.5 9.2V8a2.6 2.6 0 0 1 2.6-2.6h8.2"/><path d="m13.1 3.2 2.2 2.2-2.2 2.2"/><path d="M15.5 10.8V12a2.6 2.6 0 0 1-2.6 2.6H4.7"/><path d="m6.9 16.8-2.2-2.2 2.2-2.2"/>',
  bell: '<path d="M6 8.4a4 4 0 0 1 8 0c0 3.6 1.5 4.9 1.5 4.9h-11S6 12 6 8.4z"/><path d="M8.6 15.8a1.5 1.5 0 0 0 2.8 0"/>',
  // Das Zeichen fuer "von der KI": klein, einfarbig, kein Aufkleber.
  ki: '<path d="M10 2.5c.7 4.1 2.4 5.8 6.5 6.5-4.1.7-5.8 2.4-6.5 6.5-.7-4.1-2.4-5.8-6.5-6.5 4.1-.7 5.8-2.4 6.5-6.5z" fill="currentColor" stroke="none"/>',
  ics: '<rect x="3.6" y="4.6" width="12.8" height="11.8" rx="2.2"/><path d="M3.6 8.2h12.8M7.2 3.2v2.8M12.8 3.2v2.8M10 10.4v4M8 12.4h4"/>',
  enter: '<path d="M15.4 5.2v4.4a2 2 0 0 1-2 2H5.2"/><path d="m8 8.6-3 3 3 3"/>',
};

const CSS = `
.kal {
  --kal-hour: 48px;
  --kal-label: 56px;
  --kal-bar: 24px;
  /* Staffel in engen Spalten: der spaetere Termin liegt um gut ein Drittel
     eingerueckt ueber dem frueheren. Mit 10 px (nur bis vor dessen Text)
     verschwand der fruehere ganz, sobald der spaetere wenige Minuten nach
     ihm begann ("Paket" 16:20, "Dichtung" 16:30) -- so bleibt links sein
     Titelanfang lesbar. */
  --kal-einzug: 38%;
  /* Leise Schrift MIT Inhalt (Ort, Stunden, "+2 weitere") braucht 4,5:1. Das
     allgemeine --fg-subtle erreicht auf den Flaechen des Kalenders nur 3,4-3,8
     (gemessen); hier eine Stufe heller bzw. dunkler, gleiche Tonlage. */
  --fg-subtle: #8a8d93;
  /* Weisse Ziffer im Heute-Kreis: auf dem dunklen Akzent #2f7cf6 nur 3,9:1,
     etwas tiefer gesetzt 5,5:1. Im hellen Thema reicht der Akzent selbst. */
  --kal-heute: color-mix(in srgb, var(--accent) 82%, #000);
  container-type: inline-size;
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ---- Kopf: Zeitraum, Pfeile, Umschalter, Schnell-Eintragen ---- */
.kal__bar { display: flex; flex-direction: column; gap: 14px; padding: 18px var(--sp-3) 14px; }
.kal__row { display: flex; align-items: center; gap: 10px var(--sp-2); min-width: 0; }
/* Die Zeile bricht nicht um: sonst sprang der Umschalter beim Wechsel auf
   "Tag" (laengerer Titel) in eine zweite Zeile und alles darunter mit. Wird
   es eng, weicht zuerst der leise Untertitel, dann kuerzt sich der Titel. */
.kal__period { display: flex; align-items: baseline; gap: 10px; flex: 1 1 auto; min-width: 0; }
.kal__title { flex: 0 1 auto; min-width: 0; margin: 0; font-size: var(--fs-xl); font-weight: 500; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Zwei Fassungen des Titels; die kurze ("Sept. 2026") nur, wo die lange
   abgeschnitten wuerde -- der Titel ist das Wichtigste in der Zeile. */
.kal__title-kurz { display: none; }
.kal__sub { flex: 0 1000 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg-subtle); white-space: nowrap; font-variant-numeric: tabular-nums; }
.kal__nav { display: flex; flex: none; align-items: center; gap: 2px; }
.kal__row > .segmented { flex: none; }
.kal__nav[hidden] { display: none; }
/* In der Liste gibt es kein Vor und Zurueck: weg damit, der Titel braucht den Platz. */
.kal[data-mode="liste"] .kal__nav { display: none; }
/* ... und die Zeile bleibt so hoch wie mit ihnen (36 px), damit das Feld darunter nicht springt. */
.kal__row { min-height: 36px; }
.kal .segmented__option { min-width: 54px; }

.kal__quick { position: relative; }
.kal__quick-field {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 4px 0 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  cursor: text;
  transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}
.kal__quick-field:hover { border-color: var(--border-strong); }
.kal__quick-field:focus-within { background: var(--surface); border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.kal__quick-icon { display: grid; place-items: center; color: var(--fg-subtle); }
.kal__quick-field:focus-within .kal__quick-icon { color: var(--accent-text); }
.kal__quick-input { flex: 1 1 auto; min-width: 0; height: 42px; padding: 0; font: inherit; font-size: var(--fs-md); color: var(--fg); background: none; border: 0; outline: none; }
.kal__quick-input::placeholder { color: var(--fg-subtle); }
.kal__quick-pop {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 8;
  display: grid;
  grid-template-columns: 3px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 12px 10px 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-3);
  box-shadow: var(--shadow-2);
}
.kal__quick-bar { align-self: stretch; border-radius: var(--r-full); background: var(--accent); }
.kal__quick-bar.is-leer { background: var(--border-strong); }
.kal__quick-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.kal__quick-was { font-size: var(--fs-md); color: var(--fg); font-variant-numeric: tabular-nums; }
.kal__quick-titel { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg-muted); }
.kal__quick-note { font-size: var(--fs-sm); color: var(--fg-subtle); line-height: var(--lh); }
.kal__quick-note.is-warn { color: var(--warn); }
.kal__quick-go { gap: 6px; }

/* ---- Rumpf ---- */
.kal__body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--sp-3);
  padding: 0 var(--sp-3) var(--sp-3);
  touch-action: pan-y;
}
.kal__body[data-mode="monat"] { grid-template-columns: minmax(0, 1fr) clamp(260px, 30%, 320px); }
.kal__body[data-mode="tag"] { grid-template-columns: minmax(0, 1fr) 264px; }
/* Mit dem Finger: jeder Tag im kleinen Monat 44 px breit (7 x 44 + Rand).
   Steht VOR den Container-Regeln unten, damit "zu schmal -> eine Spalte"
   weiterhin gewinnt. */
@media (pointer: coarse) {
  .kal__body[data-mode="tag"] { grid-template-columns: minmax(0, 1fr) 336px; }
}
.kal__body[data-mode="liste"] { overflow-y: auto; }
.kal__notice { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px var(--sp-2); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-3); font-size: var(--fs-sm); }
.kal__leise { margin: 0; font-size: var(--fs-sm); color: var(--fg-subtle); line-height: var(--lh); }

.kal__ki { display: inline-grid; place-items: center; flex: none; color: var(--fg-subtle); }
.kal__ki svg { width: 13px; height: 13px; }
.kal__wdh svg { width: 12px; height: 12px; }
.kal__wdh { display: inline-grid; place-items: center; flex: none; color: var(--fg-subtle); }

/* ---- Monat ---- */
.kal__month {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  overflow: hidden;
}
.kal__dow { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-bottom: 1px solid var(--border); }
.kal__dow span { padding: 10px 12px 9px; font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-subtle); }
.kal__weeks { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-auto-rows: minmax(92px, 1fr); min-height: 0; }
.kal__day {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  min-width: 0;
  min-height: 0;
  padding: 6px 6px 6px;
  overflow: hidden;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: none;
  border: 0;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease);
}
.kal__day:nth-child(7n) { border-right: 0; }
.kal__day.is-lastrow { border-bottom: 0; }
.kal__day.is-weekend { background: color-mix(in srgb, var(--surface-2) 50%, transparent); }
.kal__day:hover { background: var(--surface-2); }
.kal__day.is-selected { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border-strong); }
.kal__day:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent-ring); }
.kal__day.is-other { color: var(--fg-subtle); }
/* Die Tage der Nachbarmonate leiser ueber die Farbe (per Deckkraft fiel
   ihre Schrift auf 2,2:1). */
.kal__day.is-other .kal__pill::before { background: var(--border-strong); }
.kal__day.is-other .kal__pill.is-allday { background: var(--surface-2); }
.kal__num {
  display: inline-grid;
  place-items: center;
  align-self: flex-start;
  /* Nie gequetscht: in einer vollen Zelle wurde der Kreis sonst zur Pille. */
  flex: none;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  margin-bottom: 2px;
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  border-radius: var(--r-full);
}
.kal__day.is-today .kal__num { color: var(--accent-fg); background: var(--kal-heute); font-weight: 600; }
.kal__pill {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  min-height: 19px;
  padding: 1px 5px;
  font-size: var(--fs-xs);
  line-height: 1.35;
  border-radius: 5px;
}
.kal__pill::before { content: ''; flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.kal__pill.is-allday { background: var(--accent-soft); color: var(--fg); }
.kal__pill.is-allday::before { display: none; }
.kal__pill-time { flex: none; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.kal__pill-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--fg); }
.kal__day.is-other .kal__pill-title { color: var(--fg-subtle); }
.kal__pill:hover .kal__pill-title { text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 2px; }
.kal__more { padding-left: 6px; font-size: var(--fs-xs); color: var(--fg-subtle); }

/* ---- Tagesliste (Monat) und Liste "Als Naechstes" ---- */
.kal__agenda { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.kal__agenda-head, .kal__lkopf { display: flex; align-items: baseline; gap: 10px; margin: 0; padding: 4px 0 0; font-weight: 400; }
.kal__agenda-day, .kal__lkopf-rel { margin: 0; font-size: var(--fs-lg); font-weight: 500; }
.kal__agenda-date, .kal__lkopf-datum { font-size: var(--fs-sm); color: var(--fg-subtle); }
.kal__agenda-list, .kal__lliste { display: flex; flex-direction: column; gap: 10px; margin: 14px 0 0; padding: 0; list-style: none; }
.kal__agenda-list { overflow-y: auto; min-height: 0; }
.kal__entry {
  display: grid;
  grid-template-columns: 46px 3px minmax(0, 1fr);
  gap: 12px;
  width: 100%;
  padding: 0;
  font: inherit;
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}
.kal__entry-time { display: flex; flex-direction: column; justify-content: center; gap: 5px; font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.kal__entry-bar { border-radius: var(--r-full); background: var(--accent); }
.kal__entry-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  min-height: 52px;
  padding: 9px 14px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.kal__entry:hover .kal__entry-card, .kal__entry.is-open .kal__entry-card { background: var(--surface-3); border-color: var(--border-strong); }
.kal__entry:focus-visible { outline: none; }
.kal__entry:focus-visible .kal__entry-card { box-shadow: 0 0 0 3px var(--accent-ring); }
.kal__entry-title { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--fg); }
.kal__entry-title > span:first-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.kal__entry-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg-subtle); }
/* Vergangenes leiser ueber die FARBE, nicht per Deckkraft: durchscheinende
   Karten liessen Darunterliegendes durchschimmern, und leise Schrift fiel
   unter 2:1. Titel in --fg-muted, grauer Balken, Karte deckend. */
.kal__entry.is-past .kal__entry-title { color: var(--fg-muted); }
.kal__entry.is-past .kal__entry-bar { background: var(--border-strong); }
.kal__agenda-add { align-self: flex-start; margin-top: var(--sp-2); }
.kal__liste { display: flex; flex-direction: column; gap: 26px; width: 100%; padding-bottom: var(--sp-2); }
.kal__lgruppe { display: flex; flex-direction: column; }
.kal__lfuss { display: flex; flex-wrap: wrap; align-items: center; gap: 10px var(--sp-2); padding-top: 4px; }
.kal__lfuss a { font-size: var(--fs-sm); color: var(--fg-subtle); text-decoration: none; }
.kal__lfuss a:hover { color: var(--fg); text-decoration: underline; text-underline-offset: 3px; }

/* ---- Stundenraster (Tag und Woche) ---- */
.kal__raster { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); overflow: hidden; }
.kal__rkopf, .kal__rganz, .kal__rstunden { display: grid; }
.kal__rkopf { border-bottom: 1px solid var(--border); }
.kal__rtag {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 10px 10px;
  font: inherit;
  font-size: var(--fs-sm);
  text-align: left;
  color: var(--fg-subtle);
  background: none;
  border: 0;
  border-left: 1px solid var(--border);
}
button.kal__rtag { cursor: pointer; }
button.kal__rtag:hover { background: var(--surface-2); }
.kal__rtag-num { display: inline-grid; place-items: center; min-width: 30px; height: 30px; padding: 0 6px; font-size: var(--fs-md); color: var(--fg); border-radius: var(--r-full); font-variant-numeric: tabular-nums; }
.kal__rtag.is-today { color: var(--accent-text); }
.kal__rtag.is-today .kal__rtag-num { color: var(--accent-fg); background: var(--kal-heute); font-weight: 600; }
.kal__rganz { border-bottom: 1px solid var(--border); }
.kal__rganz-label { display: flex; align-items: center; justify-content: flex-end; padding: 0 8px; font-size: var(--fs-xs); color: var(--fg-subtle); }
.kal__rganz-bars { display: grid; row-gap: 3px; padding: 4px 0; min-height: 30px; }
.kal__rganz-zelle { grid-row: 1 / -1; border-left: 1px solid var(--border); margin: -4px 0; }
.kal__balken {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: var(--kal-bar);
  margin: 0 3px;
  padding: 0 8px;
  font: inherit;
  font-size: var(--fs-xs);
  text-align: left;
  color: var(--fg);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 6px;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.kal__balken.is-links { border-top-left-radius: 0; border-bottom-left-radius: 0; margin-left: 0; border-left: 0; }
.kal__balken.is-rechts { border-top-right-radius: 0; border-bottom-right-radius: 0; margin-right: 0; border-right: 0; }
.kal__balken span:first-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.kal__balken:hover { border-color: var(--accent); }
.kal__balken:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.kal__balken.is-past { color: var(--fg-muted); background: var(--surface-3); border-color: var(--border); }
.kal__rscroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; }
.kal__rstunden { position: relative; -webkit-user-select: none; user-select: none; }
.kal__rlabels { position: relative; }
.kal__rlabel { position: absolute; right: 8px; transform: translateY(-50%); font-size: var(--fs-xs); color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.kal__rjetzt { position: absolute; right: 4px; z-index: 3; transform: translateY(-50%); padding: 1px 4px; font-size: var(--fs-xs); font-weight: 600; color: var(--accent-text); background: var(--surface); border-radius: 4px; font-variant-numeric: tabular-nums; }
.kal__rcol {
  position: relative;
  min-width: 0;
  border-left: 1px solid var(--border);
  background-image: repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent var(--kal-hour));
  cursor: cell;
}
.kal__rcol.is-weekend { background-color: color-mix(in srgb, var(--surface-2) 45%, transparent); }
.kal__rcol.is-today { background-color: color-mix(in srgb, var(--accent) 4%, transparent); }
.kal__block {
  position: absolute;
  z-index: 1;
  left: calc(var(--lane) * 100% / var(--lanes) + 3px);
  width: calc(100% / var(--lanes) - 6px);
  display: flex;
  gap: 7px;
  min-height: 20px;
  padding: 4px 8px 4px 0;
  overflow: hidden;
  font: inherit;
  font-size: var(--fs-xs);
  line-height: 1.35;
  text-align: left;
  color: var(--fg);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: grab;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.kal__block::before { content: ''; flex: none; width: 3px; border-radius: var(--r-full); background: var(--accent); }
.kal__block:hover, .kal__block.is-open { background: var(--surface-4); border-color: var(--border-strong); }
.kal__block:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
/* Jeder Block ist sein eigener Container: wie viel Zeit er zeigt, haengt an
   SEINER Breite (Spalte geteilt durch Spuren), nicht an der des Fensters. */
.kal__block { container-type: inline-size; }
.kal__block-text { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
/* Der Titel darf umbrechen, so viele Zeilen, wie die Hoehe hergibt
   (--zeilen, im Zeichnen ausgerechnet) -- statt "Woch…" in einem Block, der
   Platz fuer drei Zeilen hat. */
.kal__block-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--zeilen, 1);
  overflow: hidden;
  min-width: 0;
  font-weight: 500;
  overflow-wrap: break-word;
  hyphens: auto;
}
.kal__block-time { display: flex; align-items: center; min-width: 0; overflow: hidden; white-space: nowrap; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.kal__block-time > .kal__wdh, .kal__block-time > .kal__ki { margin-left: 5px; }
.kal__block-time > span:first-child { flex: none; }
.kal__block-bis { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: clip; }
.kal__block-ort { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--fg-subtle); }
/* Schmal: nur der Beginn ("15:30"); das Ende steht im Blatt und im Tooltip. */
@container (max-width: 104px) {
  .kal__block-bis { display: none; }
}
.kal__block.is-kurz { padding-top: 1px; padding-bottom: 1px; }
.kal__block.is-kurz .kal__block-text { flex-direction: row; align-items: center; gap: 6px; }
.kal__block.is-kurz .kal__block-title { flex: 0 1 auto; -webkit-line-clamp: 1; white-space: nowrap; text-overflow: ellipsis; display: block; }
.kal__block.is-kurz .kal__block-time { flex: 1 1 0; }
.kal__block.is-kurz .kal__block-bis { display: none; }
/* Zu schmal fuer nebeneinander (weniger als ~60 px je Termin): gestaffelt
   wie Karten, der spaetere liegt oben und leicht eingerueckt. So bleibt von
   jedem der Anfang lesbar statt drei Splitter mit je einem Buchstaben. */
.kal__rcol.is-eng .kal__block.is-geteilt {
  left: calc(var(--lane) * var(--kal-einzug) + 3px);
  width: calc(100% - var(--lane) * var(--kal-einzug) - 6px);
  z-index: calc(var(--lane) + 1);
  box-shadow: 0 0 0 1px var(--surface);
}
.kal__rcol.is-eng .kal__block.is-geteilt:hover { z-index: 8; }
.kal__rcol.is-eng .kal__block.is-dritte { display: none; }
/* Eng: weniger Rand im Block, jeder Buchstabe zaehlt. */
.kal__rcol.is-eng .kal__block.is-geteilt { gap: 4px; padding-right: 3px; }
.kal__mehr {
  position: absolute;
  right: 3px;
  z-index: 7;
  display: none;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  font: inherit;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--fg);
  background: var(--surface-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-full);
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.kal__rcol.is-eng .kal__mehr { display: inline-flex; }
.kal__mehr:hover { border-color: var(--accent); }
.kal__mehr:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
/* Der Fokusring muss die Staffel-Kante schlagen (sie ist spezifischer als :focus-visible). */
.kal__rcol.is-eng .kal__block.is-geteilt:focus-visible { z-index: 8; box-shadow: 0 0 0 3px var(--accent-ring); }
/* Der Geist beim Ziehen nimmt immer die ganze Spalte -- auch in einer engen. */
.kal__rcol .kal__block.is-ghost { left: 3px; width: calc(100% - 6px); z-index: 9; }
.kal__block.is-past { color: var(--fg-muted); }
.kal__block.is-past::before { background: var(--border-strong); }
.kal__block.is-past .kal__block-time { color: var(--fg-subtle); }
.kal__block.is-dragging { opacity: 0.28; }
.kal__block.is-ghost {
  z-index: 5;
  left: 3px;
  width: calc(100% - 6px);
  background: var(--surface-4);
  border-color: var(--accent);
  box-shadow: var(--shadow-2);
  pointer-events: none;
  cursor: grabbing;
}
.kal__block.is-ghost .kal__block-time { flex: none; color: var(--accent-text); font-weight: 500; }
/* Kurz: nur der Beginn vor dem Titel ("17:30 Dichtung …") -- sonst fuellt die
   Spanne "17:30–18:00" den Geist, und man sieht nicht, WAS man zieht. */
.kal__block.is-ghost.is-kurz .kal__block-bis { display: none; }
.kal__block.is-ghost.is-kurz .kal__block-title { flex: 1 1 0; }
.kal__block.is-neu, .kal__balken.is-neu { animation: kal-neu 1.6s var(--ease) 1; }
@keyframes kal-neu { 0%, 40% { box-shadow: 0 0 0 3px var(--accent-ring); } 100% { box-shadow: 0 0 0 0 transparent; } }
.kal__grip { position: absolute; left: 0; right: 0; bottom: 0; height: 8px; cursor: ns-resize; touch-action: none; }
.kal__grip::after { content: ''; position: absolute; left: 50%; bottom: 3px; width: 18px; height: 2px; margin-left: -9px; border-radius: 2px; background: var(--border-strong); opacity: 0; transition: opacity var(--dur-1) var(--ease); }
.kal__block:hover .kal__grip::after { opacity: 1; }
/* Die Jetzt-Linie laeuft UNTER den Terminen durch: darueber strich sie die
   Uhrzeit eines laufenden Termins durch wie erledigt. Wie spaet es ist,
   sagt die blaue Zeit links. */
.kal__now { position: absolute; left: 0; right: 0; height: 0; border-top: 2px solid var(--accent); pointer-events: none; z-index: 0; }
.kal__now::before { content: ''; position: absolute; left: -5px; top: -6px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
.kal__now.is-fern { border-top-width: 1px; opacity: 0.35; }
.kal__now.is-fern::before { display: none; }
body.kal-zieht, body.kal-zieht * { cursor: grabbing !important; }

/* ---- Tag: der kleine Monat daneben ---- */
.kal__seite { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.kal__mini { padding: 12px 12px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); }
.kal__mini-kopf { display: flex; align-items: center; gap: 4px; padding: 0 0 6px 6px; }
.kal__mini-titel { margin-right: auto; font-size: var(--fs-sm); font-weight: 500; }
.kal__mini-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px 0; }
.kal__mini-wt { padding: 4px 0; font-size: 10.5px; text-align: center; color: var(--fg-subtle); }
.kal__mini-tag {
  position: relative;
  display: grid;
  place-items: center;
  height: 30px;
  padding: 0;
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--fg);
  background: none;
  border: 0;
  border-radius: var(--r-full);
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.kal__mini-tag:hover { background: var(--surface-3); }
.kal__mini-tag.is-other { color: var(--fg-subtle); }
.kal__mini-tag.is-selected { background: var(--surface-4); }
.kal__mini-tag.is-today { color: var(--accent-text); font-weight: 600; }
.kal__mini-tag.is-today.is-selected { color: var(--accent-fg); background: var(--kal-heute); }
.kal__mini-tag.has-events::after { content: ''; position: absolute; bottom: 3px; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: var(--fg-subtle); }
.kal__mini-tag.is-today.is-selected::after { background: var(--accent-fg); }
.kal__mini-tag:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-ring); }
.kal__summe { margin: 0; padding: 0 4px; font-size: var(--fs-sm); color: var(--fg-subtle); line-height: var(--lh); }

/* ---- Seitenblatt ---- */
.kal__sheet {
  position: absolute;
  top: var(--sp-2);
  right: var(--sp-2);
  z-index: 9;
  display: flex;
  flex-direction: column;
  width: min(392px, calc(100% - 2 * var(--sp-2)));
  max-height: calc(100% - 2 * var(--sp-2));
  overflow-y: auto;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-3);
  animation: kal-in var(--dur-3) var(--ease);
}
@keyframes kal-in { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
.kal__sheet-top { display: flex; align-items: center; gap: 8px; padding: 14px 14px 0 var(--sp-3); }
.kal__sheet-kicker > span { display: inline-flex; align-items: center; gap: 7px; }
.kal__sheet-kicker { display: inline-flex; align-items: center; gap: 8px; margin-right: auto; font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-subtle); }
.kal__sheet-body { display: flex; flex-direction: column; gap: 18px; padding: 6px var(--sp-3) var(--sp-3); }
.kal__sheet-title { margin: 0; font-size: 24px; font-weight: 500; line-height: var(--lh-tight); letter-spacing: -0.015em; overflow-wrap: anywhere; outline: none; }
.kal__when { display: grid; grid-template-columns: 3px minmax(0, 1fr); gap: 14px; }
.kal__when-bar { border-radius: var(--r-full); background: var(--accent); }
.kal__when-day { display: block; color: var(--fg); }
.kal__when-time { display: block; margin-top: 2px; font-size: var(--fs-base); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.kal__facts { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.kal__fact { display: flex; align-items: flex-start; gap: 12px; font-size: var(--fs-base); color: var(--fg-muted); line-height: var(--lh); }
.kal__fact > svg { flex: none; width: 17px; height: 17px; margin-top: 3px; color: var(--fg-subtle); }
.kal__fact-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.kal__fact a { color: var(--accent-text); text-decoration: none; }
.kal__fact a:hover { text-decoration: underline; }
.kal__note { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: var(--lh); color: var(--fg); }
.kal__origin { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); }
.kal__origin-text { margin: 0; font-size: var(--fs-sm); line-height: var(--lh); color: var(--fg-muted); }
.kal__origin-text strong { font-weight: 500; color: var(--fg); }
.kal__origin .btn { align-self: flex-start; }
.kal__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.kal__fact-ics { display: inline-flex; align-items: center; gap: 6px; }
.kal__actions .spacer { flex: 1 1 auto; }
.kal__danger { color: var(--danger); }
.kal__wahl { display: flex; flex-direction: column; gap: 8px; width: 100%; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); }
.kal__wahl-text { margin: 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.kal__wahl-knoepfe { display: flex; flex-wrap: wrap; gap: 8px; }
.kal__switch { display: inline-flex; align-items: center; gap: 10px; padding: 0; font: inherit; font-size: var(--fs-sm); color: var(--fg-muted); background: none; border: 0; cursor: pointer; }
.kal__switch-spur { position: relative; flex: none; width: 34px; height: 20px; border-radius: var(--r-full); background: var(--surface-4); border: 1px solid var(--border-strong); transition: background var(--dur-2) var(--ease); }
.kal__switch-spur::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--fg-muted); transition: transform var(--dur-2) var(--ease), background var(--dur-2) var(--ease); }
.kal__switch[aria-checked="true"] .kal__switch-spur { background: var(--accent); border-color: var(--accent); }
.kal__switch[aria-checked="true"] .kal__switch-spur::after { transform: translateX(14px); background: var(--accent-fg); }
.kal__switch:focus-visible { outline: none; }
.kal__switch:focus-visible .kal__switch-spur { box-shadow: 0 0 0 3px var(--accent-ring); }
.kal__ehrlich { font-size: var(--fs-xs); color: var(--fg-subtle); }
.kal__form { display: flex; flex-direction: column; gap: 14px; }
.kal__form-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.kal__form-row.is-zwei { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.kal__form .textarea { min-height: 72px; }
/* Text, Datum, Uhrzeit und Auswahl haben von Haus aus drei Hoehen (38/40/42).
   In einer Zeile nebeneinander sieht man die versetzten Unterkanten. */
.kal__form .input, .kal__form .select { height: 40px; box-sizing: border-box; }
.kal__form-error { margin: 0; padding: 10px 12px; font-size: var(--fs-sm); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-2); }

/* ---- Die Frage bei Serien: "Nur dieser Termin" / "Alle" ---- */
.kal__frage {
  position: absolute;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(300px, calc(100% - 2 * var(--sp-2)));
  padding: 14px;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-3);
  box-shadow: var(--shadow-3);
  animation: kal-auf var(--dur-2) var(--ease);
}
@keyframes kal-auf { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.kal__frage-text { margin: 0; font-size: var(--fs-sm); line-height: var(--lh); color: var(--fg-muted); }
.kal__frage-text strong { font-weight: 500; color: var(--fg); }
.kal__frage-knoepfe { display: flex; flex-wrap: wrap; gap: 8px; }
.kal__frage-knoepfe .btn { flex: 1 1 auto; }

/* Unter ~980 px ist neben dem Monat kein Platz fuer die Tagesliste, ohne dass
   die Titel in den Tagen zu zwei Buchstaben schrumpfen (gemessen am iPad quer:
   73 px je Spalte). Dann steht die Liste unter dem Monat. */
@container (max-width: 980px) {
  .kal__body[data-mode="monat"] { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
  .kal__body[data-mode="monat"] .kal__month { min-height: 470px; }
  .kal__agenda-list { overflow: visible; }
}
/* Unter ~130 px je Tag (beide Seiten offen am Laptop, iPad quer) blieben neben
   "16:00" nur drei Buchstaben Titel. Der Titel ist wichtiger; die Uhrzeit
   steht in der Tagesliste darunter und im Tooltip. */
@container (max-width: 920px) {
  .kal__pill-time { display: none; }
}
@container (max-width: 700px) {
  .kal__title-lang { display: none; }
  .kal__title-kurz { display: inline; }
  /* Der Untertitel (KW, Anzahl) weicht ganz, der Titel eine Stufe kleiner:
     so passt "Do., 24. Sept." neben Pfeile und Umschalter (iPad quer mit
     geoeffneter Uebersicht, ~580 px). */
  .kal__title { font-size: var(--fs-lg); }
  .kal__sub { display: none; }
  .kal .segmented__option { min-width: 0; padding-left: 10px; padding-right: 10px; }
  .kal__nav .btn { padding-left: 8px; padding-right: 8px; }
}
@container (max-width: 760px) {
  .kal__body[data-mode="tag"] { grid-template-columns: minmax(0, 1fr); }
  .kal__body[data-mode="tag"] .kal__seite { display: none; }
  .kal__bar { padding: 14px var(--sp-2) 12px; }
  .kal__body { padding: 0 var(--sp-2) var(--sp-2); }
}
@container (max-width: 560px) {
  .kal { --kal-label: 42px; }
  .kal__row { flex-wrap: wrap; }
  .kal__weeks { grid-auto-rows: minmax(64px, 1fr); }
  .kal__pill-time, .kal__pill-title { display: none; }
  .kal__pill { min-height: 6px; height: 6px; padding: 0; }
  .kal__pill::before { width: 100%; height: 4px; border-radius: 2px; }
  .kal__sheet { top: 0; right: 0; bottom: 0; width: 100%; max-height: none; border-radius: var(--r-4); }
  .kal__form-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .kal__rtag { flex-direction: column; gap: 2px; padding: 6px 2px; }
  .kal .segmented__option { min-width: 0; }
}
@media (pointer: coarse) {
  .kal { --kal-bar: var(--tap-min); }
  .kal__rtag { min-height: var(--tap-min); }
  .kal__mehr { height: 30px; padding: 0 10px; }
  .kal__mini-tag { height: var(--tap-min); }
  .kal__grip { height: 12px; }
  .kal__grip::after { opacity: 1; }
  .kal__switch { min-height: var(--tap-min); }
  .kal__form .input, .kal__form .select { height: var(--tap-min); }
  .kal__lfuss a { display: inline-flex; align-items: center; min-height: var(--tap-min); }
  .kal__day:active, .kal__entry:active .kal__entry-card, .kal__block:active { background: var(--surface-3); }
}
@media (prefers-reduced-motion: reduce) {
  .kal__sheet, .kal__frage { animation: none; }
  .kal__block.is-neu, .kal__balken.is-neu { animation: none; }
}
/* Hell: dieselben zwei Tokens, zweimal wie in web/app.css (ausdruecklich
   gewaehlt und "wie das System"). #62656e auf Weiss: 5,0:1. */
:root[data-theme="light"] .kal { --fg-subtle: #62656e; --kal-heute: var(--accent); }
@media (prefers-color-scheme: light) {
  :root[data-theme="system"] .kal { --fg-subtle: #62656e; --kal-heute: var(--accent); }
}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

function readMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return MODES.some(([id]) => id === m) ? m : 'monat';
  } catch {
    return 'monat';
  }
}

function writeMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch { /* privat surfen: dann eben nicht gemerkt */ }
}

function fmt(day, opts) {
  try {
    return new Intl.DateTimeFormat('de-DE', opts).format(parseDay(day));
  } catch {
    return day;
  }
}

function errorText(err) {
  return (err && err.message) || 'Unbekannter Fehler.';
}

/**
 * `?nur=` fuer "nur dieses Vorkommen". Fehlt der Tag, wird ABGEBROCHEN statt
 * ohne `nur` zu senden: api.js laesst leere Werte weg, und ohne `nur` gilt
 * die Aenderung -- oder das Loeschen -- fuer die ganze Serie.
 */
function nurDieses(e) {
  const tag = e && e.occurrence;
  if (typeof tag !== 'string' || !DATE_RE.test(tag)) {
    throw new Error('Welcher Tag der Serie gemeint ist, fehlt – es wurde nichts geändert.');
  }
  return { nur: tag };
}

/** Die naechste volle Stunde, fuer das Formular "Neuer Termin" von heute. */
function nextFullHour(now = new Date()) {
  const h = Math.min(22, now.getHours() + 1);
  return `${pad(h)}:00`;
}

function hmPlus(hm, minuten) {
  const [h, m] = hm.split(':').map(Number);
  const t = Math.min(23 * 60 + 59, h * 60 + m + minuten);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

const minZuHm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/** Wiederholen-Auswahl im Formular. `byDay: []` heisst: Wochentag des Beginns. */
const REC_PRESETS = [
  ['', 'Nie', null],
  ['daily', 'Täglich', { freq: 'daily', interval: 1 }],
  ['werktags', 'Werktags', { freq: 'weekly', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }],
  ['weekly', 'Wöchentlich', { freq: 'weekly', interval: 1, byDay: [] }],
  ['zweiwoechentlich', 'Alle 2 Wochen', { freq: 'weekly', interval: 2, byDay: [] }],
  ['monthly', 'Monatlich', { freq: 'monthly', interval: 1 }],
  ['yearly', 'Jährlich', { freq: 'yearly', interval: 1 }],
];

/** Welches Preset eine gespeicherte Regel ist -- oder 'bisher', wenn keines passt. */
function presetVon(rec, start) {
  if (!rec) return '';
  const tag = String(start || '').slice(0, 10);
  const wt = tag ? WT_CODES[(parseDay(tag).getDay() + 6) % 7] : null;
  const tage = Array.isArray(rec.byDay) ? rec.byDay : [];
  for (const [id, , p] of REC_PRESETS) {
    if (!p || p.freq !== rec.freq || (p.interval || 1) !== (rec.interval || 1)) continue;
    if (rec.count) continue;
    if (p.freq !== 'weekly') return id;
    const soll = p.byDay.length ? p.byDay : [wt];
    const ist = tage.length ? tage : [wt];
    if (soll.length === ist.length && soll.every((c) => ist.includes(c))) return id;
  }
  return 'bisher';
}

export default {
  id: 'kalender',
  title: 'Kalender',

  async mount(container, ctx) {
    ensureStyle();
    const { h, text, clear, icon, api, icons, bus, toast } = ctx;
    const I = { ...icons, ...GLYPH };
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    // Mit dem Finger braucht eine halbe Stunde mehr Hoehe, sonst trifft man sie
    // nicht: 64 px je Stunde, eine halbe Stunde ist 30 px hoch.
    const HOUR = coarse ? 64 : 48;
    // Die kleinste Blockhoehe. Frueher waren es mit dem Finger 44 px (--tap-min)
    // -- bei 56 px je Stunde lagen drei halbstuendige Termine hintereinander
    // dann 16 px uebereinander, mit verdecktem Text und Anfasser. Jetzt ist ein
    // Block so hoch wie seine Dauer (mindestens 30 px = eine halbe Stunde),
    // und was darunter nicht passt, steht daneben (rasterBloecke).
    const MIN_BLOCK = coarse ? 30 : 20;

    const today = () => toDay(new Date());
    // Die Adresse darf Ansicht und Tag vorgeben (#/kalender?ansicht=tag&tag=…),
    // etwa aus der Kachel: "+ 3 weitere heute" soll HEUTE zeigen, nicht das
    // gemerkte Monatsblatt, in dem die drei unter dem Rand liegen.
    const routeParams = ctx.route && ctx.route.params ? ctx.route.params : {};
    const ansichtAusAdresse = MODES.some(([id]) => id === routeParams.ansicht) ? routeParams.ansicht : null;
    const tagAusAdresse = DATE_RE.test(routeParams.tag || '') && toDay(parseDay(routeParams.tag)) === routeParams.tag ? routeParams.tag : null;
    const st = {
      mode: ansichtAusAdresse || readMode(),
      cursor: tagAusAdresse || today(),
      selected: tagAusAdresse || today(),
      events: [],
      byKey: new Map(),
      chats: {},
      projekte: {},
      range: null,
      loaded: false,
      error: null,
      token: 0,
      sheet: null, // { kind: 'detail'|'neu'|'bearbeiten', id?, key? }
      alive: true,
      listeTage: LISTE_SCHRITT,
      scrollZiel: 'jetzt',
      neuKey: null,
      pendingReload: false,
    };
    const cleanups = [];

    /* ---------------- Grundgeruest ---------------- */

    const root = h('div.kal', { style: { '--kal-hour': `${HOUR}px` } });
    const bar = h('header.kal__bar');
    const body = h('div.kal__body', { 'aria-live': 'polite' });
    root.append(bar, body);
    container.appendChild(root);

    const dom = {
      title: h('h2.kal__title'),
      titelLang: h('span.kal__title-lang'),
      titelKurz: h('span.kal__title-kurz'),
      sub: h('span.kal__sub'),
      prev: h('button.icon-button', { type: 'button', onClick: () => move(-1) }, icon(I.prev)),
      next: h('button.icon-button', { type: 'button', onClick: () => move(1) }, icon(I.next)),
      heute: h('button.btn.btn--ghost.btn--small', { type: 'button', title: 'Heute (T)', onClick: () => goToday() }, text('Heute')),
      modes: {},
      sheet: null,
      frage: null,
    };
    dom.title.append(dom.titelLang, dom.titelKurz);
    dom.nav = h('div.kal__nav', null, dom.prev, dom.heute, dom.next);
    const segmented = h('div.segmented', { role: 'group', 'aria-label': 'Ansicht' });
    for (const [mode, label, taste] of MODES) {
      const b = h('button.segmented__option', { type: 'button', title: `${label} (${taste})`, onClick: () => setMode(mode) }, text(label));
      dom.modes[mode] = b;
      segmented.appendChild(b);
    }

    /* ---- Schnell eintragen ---- */
    const quick = {
      input: h('input.kal__quick-input', {
        type: 'text',
        placeholder: 'Neuer Termin …   z. B. „Morgen 15 Uhr Zahnarzt“',
        'aria-label': 'Neuer Termin',
        autocomplete: 'off',
        autocapitalize: 'sentences',
        spellcheck: 'false',
        enterkeyhint: 'done',
        maxlength: '300',
      }),
      pop: h('div.kal__quick-pop', { hidden: true }),
      ergebnis: null,
      konflikte: [],
      token: 0,
      busy: false,
      fehler: null,
    };
    const quickField = h('div.kal__quick-field', { onClick: (e) => { if (e.target === e.currentTarget) quick.input.focus(); } },
      h('span.kal__quick-icon', { 'aria-hidden': 'true' }, icon(I.plus)),
      quick.input,
      h('button.icon-button', {
        type: 'button',
        'aria-label': 'Mit allen Feldern anlegen',
        title: 'Mit allen Feldern anlegen',
        onClick: () => openForm(null, vorbelegungAusFeld()),
      }, icon(I.more)));
    bar.append(
      h('div.kal__row', null, h('div.kal__period', null, dom.title, dom.sub), dom.nav, segmented),
      h('div.kal__quick', null, quickField, quick.pop));

    /* ---------------- Daten ---------------- */

    function aktuellerRange() {
      return rangeFor(st.mode, st.cursor, st.listeTage, today());
    }

    async function load() {
      const token = ++st.token;
      const range = aktuellerRange();
      try {
        const res = await api.get('/events/zeitraum', { query: range });
        if (!st.alive || token !== st.token) return;
        const items = Array.isArray(res && res.items) ? res.items : [];
        st.events = items.map(eintragAus).filter(Boolean);
        st.byKey = new Map(st.events.map((e) => [e.key, e]));
        st.chats = (res && res.chats) || {};
        st.projekte = (res && res.projekte) || {};
        st.range = range;
        st.error = null;
        st.spaeterGibtEs = undefined; // neu fragen, falls die Liste leer bleibt
      } catch (err) {
        if (!st.alive || token !== st.token) return;
        st.error = errorText(err);
        st.range = range;
      }
      st.loaded = true;
      render();
    }

    let reloadTimer = null;
    function reloadSoon() {
      // Waehrend man zieht oder gefragt wird, nicht unter den Fingern neu zeichnen.
      if (drag || dom.frage) {
        st.pendingReload = true;
        return;
      }
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => load(), 250);
    }

    /** Termine eines Tages: ganztaegige zuerst, dann nach Beginn. */
    function eventsOn(day) {
      const out = st.events.filter((e) => onDay(e.span, day));
      out.sort((a, b) => {
        const aa = a.span.allDay || a.span.firstDay < day;
        const bb = b.span.allDay || b.span.firstDay < day;
        if (aa !== bb) return aa ? -1 : 1;
        return a.span.start.ms - b.span.start.ms;
      });
      return out;
    }

    function isPast(span) {
      if (span.allDay) return span.lastDay < today();
      const end = span.end ? span.end.ms : span.start.ms + 60 * 60000;
      return end < Date.now();
    }

    const istKi = (e) => e.data.source === 'auto';

    /* ---------------- Steuerung ---------------- */

    function setMode(mode) {
      if (st.mode === mode) return;
      st.mode = mode;
      writeMode(mode);
      if (mode !== 'liste') st.cursor = st.selected;
      st.scrollZiel = 'jetzt';
      render();
      load();
    }

    function move(step) {
      if (st.mode === 'liste') return;
      if (st.mode === 'tag') {
        st.cursor = addDays(st.cursor, step);
        st.selected = st.cursor;
      } else if (st.mode === 'woche') {
        st.cursor = addDays(st.cursor, 7 * step);
        st.selected = addDays(st.selected, 7 * step);
      } else {
        st.cursor = addMonths(st.cursor, step);
        const d = parseDay(st.cursor);
        // Im neuen Monat ist heute gewaehlt, wenn heute darin liegt, sonst der Erste.
        const t = parseDay(today());
        st.selected = t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth()
          ? today()
          : toDay(new Date(d.getFullYear(), d.getMonth(), 1));
      }
      render();
      load();
    }

    function goToday() {
      st.cursor = today();
      st.selected = today();
      st.scrollZiel = 'jetzt';
      render();
      load();
    }

    function select(day, { focus = false } = {}) {
      const range = aktuellerRange();
      st.selected = day;
      if (st.mode === 'tag') st.cursor = day;
      // Ein Tag aus dem Nachbarmonat (die blassen am Rand) blaettert dorthin,
      // wie die Pfeiltasten ueber den Monatsrand hinaus.
      const otherMonth = st.mode === 'monat' && day.slice(0, 7) !== st.cursor.slice(0, 7);
      if (otherMonth) st.cursor = day;
      const draussen = day < range.from || day > range.to || otherMonth;
      render();
      if (draussen) load();
      if (focus) {
        const el = body.querySelector(`.kal__weeks [data-day="${day}"], .kal__mini-grid [data-day="${day}"]`);
        if (el) el.focus();
      }
    }

    /* ---------------- Zeichnen ---------------- */

    function setText(el, value) {
      if (el.textContent !== value) {
        clear(el);
        el.appendChild(text(value));
      }
    }

    function relativ(day) {
      const t = today();
      if (day === t) return 'Heute';
      if (day === addDays(t, 1)) return 'Morgen';
      if (day === addDays(t, -1)) return 'Gestern';
      return null;
    }

    /** Der Titel in zwei Fassungen; die kurze steht nur im engen Container (CSS). */
    function setTitel(lang, kurz = lang) {
      setText(dom.titelLang, lang);
      setText(dom.titelKurz, kurz);
      dom.title.setAttribute('aria-label', lang);
    }

    /** "Sept. 2026" -- dieselbe Kurzform wie ueberall im Kalender (MON_SATZ). */
    const monatKurz = (day) => `${MON_SATZ[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

    function renderBar() {
      const labels = {
        tag: ['Vorheriger Tag', 'Nächster Tag'],
        woche: ['Vorherige Woche', 'Nächste Woche'],
        monat: ['Vorheriger Monat', 'Nächster Monat'],
        liste: ['', ''],
      }[st.mode];
      if (st.mode === 'tag') {
        // Kurz ("Do., 24. September"): das Raster darunter nennt den Wochentag
        // ohnehin gross, und die Kopfzeile bleibt in jeder Ansicht gleich hoch.
        setTitel(fmt(st.cursor, { weekday: 'short', day: 'numeric', month: 'long' }), tagKurz(st.cursor, new Date()));
        const rel = relativ(st.cursor);
        const jahr = st.cursor.slice(0, 4) !== today().slice(0, 4) ? ` · ${st.cursor.slice(0, 4)}` : '';
        setText(dom.sub, `${rel ? `${rel} · ` : ''}KW ${isoWeek(st.cursor)}${jahr}`);
      } else if (st.mode === 'woche') {
        const from = startOfWeek(st.cursor);
        const to = addDays(from, 6);
        const sameMonth = from.slice(0, 7) === to.slice(0, 7);
        const sameYear = from.slice(0, 4) === to.slice(0, 4);
        const [m1, m2] = [MON_SATZ[Number(from.slice(5, 7)) - 1], MON_SATZ[Number(to.slice(5, 7)) - 1]];
        // Immer dieselbe Kurzform ("Sept. – Okt. 2026"): Intl schreibt den
        // Monat allein "Sep", mit Jahr "Okt." -- nebeneinander sah das falsch aus.
        if (sameMonth) setTitel(fmt(from, { month: 'long', year: 'numeric' }), monatKurz(from));
        else if (sameYear) setTitel(`${m1} – ${m2} ${to.slice(0, 4)}`, `${m1} – ${m2}`);
        else setTitel(`${m1} ${from.slice(0, 4)} – ${m2} ${to.slice(0, 4)}`, `${m1} – ${m2}`);
        setText(dom.sub, `KW ${isoWeek(from)} · ${fmt(from, { day: 'numeric', month: 'numeric' })}–${fmt(to, { day: 'numeric', month: 'numeric' })}`);
      } else if (st.mode === 'monat') {
        setTitel(fmt(st.cursor, { month: 'long', year: 'numeric' }), monatKurz(st.cursor));
        const n = st.loaded && !st.error ? countInMonth() : null;
        setText(dom.sub, n === null ? '' : n === 0 ? 'keine Termine' : n === 1 ? '1 Termin' : `${n} Termine`);
      } else {
        setTitel('Als Nächstes');
        setText(dom.sub, `ab heute · ${st.listeTage} Tage`);
      }
      // In der Liste gibt es kein Vor und Zurueck (und "Heute" ist sie schon):
      // die Leiste faellt dort weg (CSS ueber data-mode), damit der Titel Platz
      // hat. Die Hoehe bleibt, der Umschalter ist gleich hoch.
      root.dataset.mode = st.mode;
      dom.prev.setAttribute('aria-label', labels[0]);
      dom.next.setAttribute('aria-label', labels[1]);
      dom.prev.title = `${labels[0]} (←)`;
      dom.next.title = `${labels[1]} (→)`;
      for (const [mode, b] of Object.entries(dom.modes)) {
        b.classList.toggle('is-active', mode === st.mode);
        b.setAttribute('aria-pressed', mode === st.mode ? 'true' : 'false');
      }
    }

    function countInMonth() {
      const month = st.cursor.slice(0, 7);
      let n = 0;
      for (const e of st.events) {
        if (e.span.firstDay.slice(0, 7) <= month && e.span.lastDay.slice(0, 7) >= month) n += 1;
      }
      return n;
    }

    function render() {
      if (!st.alive) return;
      renderBar();
      const scroller = body.querySelector('.kal__rscroll');
      const keepScroll = scroller ? scroller.scrollTop : null;
      const keepBody = body.scrollTop;
      clear(body);
      body.dataset.mode = st.mode;
      if (st.error) {
        body.appendChild(h('div.kal__notice', { role: 'alert' },
          text(`Die Termine konnten nicht geladen werden: ${st.error}`),
          h('button.btn.btn--small', { type: 'button', onClick: () => load() }, text('Erneut versuchen'))));
      }
      if (st.mode === 'tag') {
        body.append(renderRaster([st.cursor]), renderSeite());
      } else if (st.mode === 'woche') {
        const from = startOfWeek(st.cursor);
        body.append(renderRaster(Array.from({ length: 7 }, (_, i) => addDays(from, i))));
      } else if (st.mode === 'monat') {
        body.append(renderMonth(), renderAgenda());
      } else {
        body.appendChild(renderListe());
      }
      engeSpalten();
      listeBuendig();
      const next = body.querySelector('.kal__rscroll');
      if (next) {
        if (st.scrollZiel === 'jetzt' || keepScroll === null) scrollZurStunde(next);
        else next.scrollTop = keepScroll;
      }
      if (st.mode === 'liste' || st.mode === 'monat') body.scrollTop = st.scrollZiel === 'jetzt' ? 0 : keepBody;
      if (st.loaded) st.scrollZiel = null;
      markOpen();
      markNeu();
    }

    /* ---- Monat ---- */

    function renderMonth() {
      const weeks = monthGrid(st.cursor);
      const month = st.cursor.slice(0, 7);
      const t = today();
      const grid = h('div.kal__weeks', { role: 'group', 'aria-label': fmt(st.cursor, { month: 'long', year: 'numeric' }) });
      weeks.forEach((week, wi) => {
        week.forEach((day, di) => {
          const list = eventsOn(day);
          // Drei Zeilen passen in einen Tag; sind es mehr, zwei und "+N weitere".
          const shown = list.length > 3 ? list.slice(0, 2) : list;
          const more = list.length - shown.length;
          const label = `${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}${list.length ? `, ${list.length === 1 ? '1 Termin' : `${list.length} Termine`}` : ''}${day === t ? ', heute' : ''}`;
          const cell = h('button.kal__day', {
            type: 'button',
            'data-day': day,
            'aria-label': label,
            'aria-pressed': day === st.selected ? 'true' : 'false',
            tabindex: day === st.selected ? '0' : '-1',
            class: {
              'is-other': day.slice(0, 7) !== month,
              'is-today': day === t,
              'is-selected': day === st.selected,
              'is-weekend': di >= 5,
              'is-lastrow': wi === weeks.length - 1,
            },
            onClick: (event) => {
              const pill = event.target.closest('[data-key]');
              select(day);
              // Mit der Maus oeffnet ein Klick auf eine Zeile den Termin. Mit dem
              // Finger sind die Zeilen 19 px hoch -- ein Tipp traf den Nachbarn.
              // Dort waehlt der Tipp den Tag; seine Liste hat 52-px-Zeilen.
              if (pill && !coarse) openDetail(st.byKey.get(pill.dataset.key));
              else agendaZeigen();
            },
            // Doppelt antippen: dieser Tag im Stundenraster.
            onDblclick: () => {
              st.selected = day;
              setMode('tag');
            },
          },
          h('span.kal__num', { 'aria-hidden': 'true' }, text(String(parseDay(day).getDate()))),
          ...shown.map((e) => {
            const allDayLike = e.span.allDay || (e.span.firstDay < day && e.span.lastDay > day);
            const time = allDayLike ? '' : timeLabel(e.span, day).replace(/–.*$/, '');
            return h('span.kal__pill', { 'data-key': e.key, class: allDayLike ? 'is-allday' : '', title: `${timeLabel(e.span, day)} · ${e.data.title}` },
              time ? h('span.kal__pill-time', null, text(time)) : null,
              h('span.kal__pill-title', null, text(e.data.title)));
          }),
          more > 0 ? h('span.kal__more', null, text(`+${more} weitere`)) : null);
          grid.appendChild(cell);
        });
      });
      grid.addEventListener('keydown', onGridKey);
      return h('section.kal__month', { 'aria-label': 'Monat' },
        h('div.kal__dow', { 'aria-hidden': 'true' }, ...WEEKDAYS.map((d) => h('span', null, text(d)))),
        grid);
    }

    /**
     * Steht die Tagesliste UNTER dem Monat (enger Container), liegt sie nach
     * einem Klick oft unter dem Rand -- es sah aus, als taete sich nichts.
     * Dann wird sie ins Bild geholt.
     */
    function agendaZeigen() {
      const agenda = body.querySelector('.kal__agenda');
      const monat = body.querySelector('.kal__month');
      if (!agenda || !monat) return;
      const a = agenda.getBoundingClientRect();
      const m = monat.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      if (a.top < m.bottom - 1) return; // nebeneinander: schon zu sehen
      if (a.top + 96 <= b.bottom) return; // Kopf und erste Zeile sind im Bild
      const ziel = body.scrollTop + (a.top - b.top) - 12;
      const ruhig = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      body.scrollTo({ top: ziel, behavior: ruhig ? 'auto' : 'smooth' });
    }

    function onGridKey(event) {
      const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (event.key in steps) {
        event.preventDefault();
        select(addDays(st.selected, steps[event.key]), { focus: true });
      } else if (event.key === 'Home') {
        event.preventDefault();
        select(startOfWeek(st.selected), { focus: true });
      } else if (event.key === 'End') {
        event.preventDefault();
        select(addDays(startOfWeek(st.selected), 6), { focus: true });
      }
    }

    /** Eine Zeile wie in der Kachel: Uhrzeit, blauer Balken, Karte mit Titel und Ort. */
    function zeile(e, day) {
      const label = timeLabel(e.span, day);
      const [von, bis] = label.includes('–') ? label.split('–') : [label, ''];
      const chat = istKi(e) && st.chats[e.data.chatId];
      const sub = [e.data.location, !e.data.location && chat ? `aus „${chat.title}“` : null].filter(Boolean).join(' · ');
      return h('li', null,
        h('button.kal__entry', {
          type: 'button',
          'data-key': e.key,
          class: isPast(e.span) ? 'is-past' : '',
          'aria-label': `${label}, ${e.data.title}${e.data.location ? `, ${e.data.location}` : ''}${istKi(e) ? ', von der KI' : ''}`,
          onClick: () => openDetail(e),
        },
        h('span.kal__entry-time', null,
          h('span', null, text(von === 'ganztägig' ? 'ganzt.' : von)),
          bis ? h('span', null, text(bis)) : null),
        h('span.kal__entry-bar', { 'aria-hidden': 'true' }),
        h('span.kal__entry-card', null,
          h('span.kal__entry-title', null,
            h('span', null, text(e.data.title)),
            e.recurring ? h('span.kal__wdh', { title: 'Wiederholt sich' }, icon(I.repeat)) : null,
            istKi(e) ? h('span.kal__ki', { title: 'Von der KI angelegt' }, icon(I.ki)) : null),
          sub ? h('span.kal__entry-sub', null, text(sub)) : null)));
    }

    function renderAgenda() {
      const day = st.selected;
      const list = eventsOn(day);
      const rel = relativ(day);
      const section = h('section.kal__agenda', { 'aria-label': `Termine am ${fmt(day, { day: 'numeric', month: 'long' })}` },
        h('div.kal__agenda-head', null,
          h('h3.kal__agenda-day', null, text(rel || fmt(day, { weekday: 'long' }))),
          h('span.kal__agenda-date', null, text(fmt(day, rel ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long' })))));
      if (!st.loaded) return section;
      if (!list.length) {
        section.append(
          h('p.kal__leise', { style: { marginTop: '12px' } }, text(day === today() ? 'Heute nichts.' : 'Nichts eingetragen.')),
          h('button.btn.btn--small.kal__agenda-add', { type: 'button', onClick: () => openForm(null, { day }) },
            icon(I.plus), text('Termin an diesem Tag')));
        return section;
      }
      section.appendChild(h('ul.kal__agenda-list', null, ...list.map((e) => zeile(e, day))));
      return section;
    }

    /* ---- Liste "Als Naechstes" ---- */

    function renderListe() {
      const from = today();
      const to = addDays(from, st.listeTage - 1);
      const section = h('section.kal__liste', { 'aria-label': 'Als Nächstes' });
      if (!st.loaded) {
        section.appendChild(h('p.kal__leise', null, text('Lädt …')));
        return section;
      }
      const gruppen = gruppiereNachTag(st.events, from, to);
      if (!gruppen.length) {
        // Leer: ein Satz, wie es weitergeht -- kein Export einer leeren Datei
        // und kein "Mehr zeigen", wenn auch danach nichts kommt.
        section.appendChild(h('p.kal__leise', null, text(`Nichts in den nächsten ${st.listeTage} Tagen. `
          + 'Tipp oben zum Beispiel „morgen 15 Uhr Zahnarzt“ – oder sag es im Chat.')));
        if (st.listeTage < 360 && st.spaeterGibtEs !== false) {
          if (st.spaeterGibtEs === undefined) spaeterPruefen();
          else if (st.spaeterGibtEs === true) section.appendChild(h('div.kal__lfuss', null,
            h('button.btn.btn--small', { type: 'button', onClick: () => { st.listeTage += LISTE_SCHRITT; load(); } }, text('Weiter voraus schauen'))));
        }
        return section;
      }
      for (const { day, eintraege } of gruppen) {
        const rel = relativ(day);
        section.appendChild(h('div.kal__lgruppe', null,
          h('h3.kal__lkopf', null,
            h('span.kal__lkopf-rel', null, text(rel || fmt(day, { weekday: 'long' }))),
            h('span.kal__lkopf-datum', null, text(fmt(day, rel ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: day.slice(0, 4) !== from.slice(0, 4) ? 'numeric' : undefined })))),
          h('ul.kal__lliste', null, ...eintraege.map((e) => zeile(e, day)))));
      }
      section.appendChild(h('div.kal__lfuss', null,
        st.listeTage < 360
          ? h('button.btn.btn--small', { type: 'button', onClick: () => { st.listeTage += LISTE_SCHRITT; load(); } }, text('Mehr zeigen'))
          : null,
        h('a', { href: `/api/events/export.ics?from=${from}&to=${to}`, title: 'Alle Termine dieses Zeitraums als Kalenderdatei (.ics)' },
          text('Als Kalenderdatei (.ics)'))));
      return section;
    }

    /** Steht nach der Liste ueberhaupt noch etwas an? (nur im leeren Fall gefragt) */
    async function spaeterPruefen() {
      st.spaeterGibtEs = null;
      try {
        const from = addDays(today(), st.listeTage);
        const res = await api.get('/events/zeitraum', { query: { from, to: addDays(from, 360) } });
        st.spaeterGibtEs = !!(res && Array.isArray(res.items) && res.items.length);
      } catch {
        st.spaeterGibtEs = true; // im Zweifel den Knopf anbieten
      }
      if (st.alive && st.mode === 'liste') render();
    }

    /* ---- Stundenraster: Tag und Woche ---- */

    function renderRaster(days) {
      const n = days.length;
      const t = today();
      const cols = `var(--kal-label) repeat(${n}, minmax(0, 1fr))`;

      const kopf = h('div.kal__rkopf', { style: { gridTemplateColumns: cols } }, h('span', { 'aria-hidden': 'true' }),
        ...days.map((day) => {
          const wt = WEEKDAYS[(parseDay(day).getDay() + 6) % 7];
          const inhalt = [h('span', null, text(n === 1 ? fmt(day, { weekday: 'long' }) : wt)), h('span.kal__rtag-num', null, text(String(parseDay(day).getDate())))];
          return n === 1
            ? h('div.kal__rtag', { class: day === t ? 'is-today' : '' }, ...inhalt)
            : h('button.kal__rtag', {
              type: 'button',
              class: day === t ? 'is-today' : '',
              'aria-label': `${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })} als Tag zeigen`,
              onClick: () => {
                st.selected = day;
                setMode('tag');
              },
            }, ...inhalt);
        }));

      // Ganztaegiges und alles ab 24 Stunden als Balken ueber die Tage.
      const idx = new Map(days.map((d, i) => [d, i]));
      const balken = [];
      const seen = new Set();
      for (const day of days) {
        for (const e of eventsOn(day)) {
          if (!istBalken(e.span) || seen.has(e.key)) continue;
          seen.add(e.key);
          const von = e.span.firstDay < days[0] ? 0 : idx.get(e.span.firstDay);
          const bis = e.span.lastDay > days[n - 1] ? n - 1 : idx.get(e.span.lastDay);
          balken.push({ key: e.key, von, bis, e });
        }
      }
      const gepackt = packeBalken(balken);
      const lanes = Math.max(1, ...gepackt.map((b) => b.lane + 1));
      const barsEl = h('div.kal__rganz-bars', {
        style: { gridColumn: `2 / span ${n}`, gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${lanes}, var(--kal-bar))` },
      },
      ...days.map((_, i) => h('span.kal__rganz-zelle', { style: { gridColumn: `${i + 1}` }, 'aria-hidden': 'true' })),
      ...gepackt.map((b) => h('button.kal__balken', {
        type: 'button',
        'data-key': b.key,
        style: { gridColumn: `${b.von + 1} / ${b.bis + 2}`, gridRow: `${b.lane + 1}` },
        class: { 'is-links': b.e.span.firstDay < days[0], 'is-rechts': b.e.span.lastDay > days[n - 1], 'is-past': isPast(b.e.span) },
        'aria-label': `${b.e.data.title}, ${b.e.span.firstDay === b.e.span.lastDay ? 'ganztägig' : `${fmt(b.e.span.firstDay, { day: 'numeric', month: 'short' })} bis ${fmt(b.e.span.lastDay, { day: 'numeric', month: 'short' })}`}`,
        title: b.e.data.title,
        onClick: (ev) => { if (!schlucken(ev)) openDetail(b.e); },
      },
      h('span', null, text(b.e.data.title)),
      istKi(b.e) ? h('span.kal__ki', { title: 'Von der KI angelegt' }, icon(I.ki)) : null)));
      barsEl.addEventListener('pointerdown', (ev) => onPointerDown(ev, { days, barsEl }));
      const ganz = h('div.kal__rganz', { style: { gridTemplateColumns: cols } },
        h('span.kal__rganz-label', null, text('ganzt.')), barsEl);

      // Die Stunden.
      const stunden = h('div.kal__rstunden', { style: { gridTemplateColumns: cols, height: `${24 * HOUR}px` } });
      const jetzt = new Date();
      const jetztMin = jetzt.getHours() * 60 + jetzt.getMinutes();
      const zeigtJetzt = days.includes(t);
      const labels = h('div.kal__rlabels', { 'aria-hidden': 'true' },
        ...Array.from({ length: 23 }, (_, i) => h('span.kal__rlabel', { 'data-min': String((i + 1) * 60), style: { top: `${(i + 1) * HOUR}px` } },
          text(`${pad(i + 1)}:00`))));
      stunden.appendChild(labels);
      if (zeigtJetzt) {
        labels.appendChild(h('span.kal__rjetzt', { style: { top: `${(jetztMin / 60) * HOUR}px` } }, text(minZuHm(jetztMin))));
        stundenFreiraeumen(labels, jetztMin);
      }

      for (const day of days) {
        const wd = (parseDay(day).getDay() + 6) % 7;
        const col = h('div.kal__rcol', { 'data-day': day, class: { 'is-today': day === t, 'is-weekend': wd >= 5 } });
        let spuren = 1;
        const timed = [];
        for (const e of eventsOn(day)) {
          if (istBalken(e.span)) continue;
          const startMin = e.span.firstDay === day ? e.span.start.min : 0;
          let endMin;
          if (e.span.end && e.span.lastDay === day) endMin = e.span.end.day === day ? e.span.end.min : 24 * 60;
          else if (e.span.lastDay > day) endMin = 24 * 60;
          else endMin = startMin + 60; // ohne Ende: eine Stunde, damit man ihn sieht
          timed.push({ id: e.key, startMin, endMin: Math.min(24 * 60, Math.max(endMin, startMin + 15)), e });
        }
        const byId = new Map(timed.map((x) => [x.id, x]));
        const bloecke = rasterBloecke(timed, { hour: HOUR, minPx: MIN_BLOCK });
        // Mehr als zwei Termine gleichzeitig in einer schmalen Spalte: statt
        // vier blauer Striche und "W…" die ersten zwei gestaffelt und ein
        // "+n", das den Tag zeigt (nur sichtbar, wenn die Spalte eng ist).
        const mehrJeGruppe = new Map();
        for (const item of bloecke) {
          if (item.lanes <= 2 || item.lane < 2) continue;
          const g = mehrJeGruppe.get(item.gruppe) || { n: 0, top: Infinity };
          g.n += 1;
          g.top = Math.min(g.top, item.top);
          mehrJeGruppe.set(item.gruppe, g);
        }
        for (const g of mehrJeGruppe.values()) {
          col.appendChild(h('button.kal__mehr', {
            type: 'button',
            style: { top: `${g.top}px` },
            title: `${g.n} ${g.n === 1 ? 'weiterer Termin' : 'weitere Termine'} zur selben Zeit – den Tag zeigen`,
            'aria-label': `${g.n} weitere zur selben Zeit, ${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })} als Tag zeigen`,
            onClick: () => {
              st.selected = day;
              st.cursor = day;
              setMode('tag');
            },
          }, text(`+${g.n}`)));
        }
        for (const item of bloecke) {
          const { e } = byId.get(item.id);
          spuren = Math.max(spuren, item.lanes);
          const { top, height } = item;
          const kurz = height < 36;
          // Wie viele Zeilen Titel die Hoehe hergibt: Rand 10 px, Zeitzeile
          // 16 px, Ort noch eine Zeile, wenn Platz ist.
          const innen = height - 10;
          const mitOrt = !kurz && !!e.data.location && innen >= 64;
          const zeilen = kurz ? 1 : Math.max(1, Math.floor((innen - 16 - (mitOrt ? 16 : 0)) / 16));
          const label = timeLabel(e.span, day);
          const [von, bis] = label.includes('–') ? label.split('–') : [label, ''];
          col.appendChild(h('button.kal__block', {
            type: 'button',
            'data-key': e.key,
            class: { 'is-past': isPast(e.span), 'is-kurz': kurz, 'is-geteilt': item.lanes > 1, 'is-dritte': item.lanes > 2 && item.lane >= 2 },
            style: { top: `${top}px`, height: `${height}px`, '--lane': item.lane, '--lanes': item.lanes, '--zeilen': zeilen },
            title: `${label} · ${e.data.title}${e.data.location ? ` · ${e.data.location}` : ''}`,
            'aria-label': `${label}, ${e.data.title}${e.data.location ? `, ${e.data.location}` : ''}${istKi(e) ? ', von der KI' : ''}`,
            onClick: (ev) => { if (!schlucken(ev)) openDetail(e); },
          },
          h('span.kal__block-text', null,
            h('span.kal__block-title', null, text(e.data.title)),
            // Die leisen Zeichen (Serie, KI) stehen in der Zeitzeile: in der
            // Titelzeile frassen sie in schmalen Spalten den halben Titel.
            h('span.kal__block-time', null,
              h('span', null, text(von)),
              bis ? h('span.kal__block-bis', null, text(`–${bis}`)) : null,
              e.recurring && !kurz ? h('span.kal__wdh', { title: 'Wiederholt sich' }, icon(I.repeat)) : null,
              istKi(e) && !kurz ? h('span.kal__ki', { title: 'Von der KI angelegt' }, icon(I.ki)) : null),
            mitOrt ? h('span.kal__block-ort', null, text(e.data.location)) : null),
          e.span.lastDay === day ? h('span.kal__grip', { 'aria-hidden': 'true', title: 'Ziehen, um die Dauer zu ändern' }) : null));
        }
        // Heute kraeftig; in der Woche an den anderen Tagen ein Hauch derselben
        // Linie -- so sieht man auch beim Mittwoch neben heute, wo "jetzt" ist.
        if (day === t) col.appendChild(h('span.kal__now', { style: { top: `${(jetztMin / 60) * HOUR}px` }, 'aria-hidden': 'true' }));
        else if (zeigtJetzt) col.appendChild(h('span.kal__now.is-fern', { style: { top: `${(jetztMin / 60) * HOUR}px` }, 'aria-hidden': 'true' }));
        col.dataset.spuren = String(spuren);
        stunden.appendChild(col);
      }
      stunden.addEventListener('pointerdown', (ev) => onPointerDown(ev, { days, stunden }));

      return h('section.kal__raster', { 'aria-label': n === 1 ? 'Tag' : 'Woche', 'data-tage': n },
        kopf, ganz, h('div.kal__rscroll', null, stunden));
    }

    /**
     * Die volle Stunde direkt neben der blauen Jetzt-Zeit wuerde sie
     * ueberdecken ("09:44" auf "10:00"). Gemessen in Pixeln, nicht in Minuten:
     * eine Beschriftung ist ~15 px hoch, eine Stunde mit Maus 48, mit Finger
     * 64 px. Die Uhr laeuft weiter -- deshalb auch aus dem Takt aufgerufen.
     */
    function stundenFreiraeumen(labels, jetztMin) {
      for (const el of labels.querySelectorAll('.kal__rlabel')) {
        const nah = (Math.abs(Number(el.dataset.min) - jetztMin) / 60) * HOUR < 17;
        el.style.visibility = nah ? 'hidden' : '';
      }
    }

    /** Welche Spalten fuer Nebeneinander zu schmal sind -- gemessen, nicht geraten. */
    function engeSpalten() {
      for (const col of body.querySelectorAll('.kal__rcol')) {
        const spuren = Number(col.dataset.spuren) || 1;
        col.classList.toggle('is-eng', spuren > 1 && col.clientWidth / spuren < 60);
      }
    }
    /**
     * Die Liste scrollt im Rumpf; dessen Bildlaufleiste nimmt rechts Platz
     * weg, und die Karten endeten 8 px vor Feld und Umschalter darueber. Die
     * Liste reicht deshalb um genau diese Breite in den Rand hinein.
     */
    function listeBuendig() {
      const liste = body.querySelector('.kal__liste');
      if (!liste) return;
      const leiste = body.offsetWidth - body.clientWidth;
      liste.style.marginRight = leiste > 0 ? `-${leiste}px` : '';
    }
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { engeSpalten(); listeBuendig(); });
      ro.observe(body);
      cleanups.push(() => ro.disconnect());
    }

    function scrollZurStunde(scroller) {
      const days = st.mode === 'tag' ? [st.cursor] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(st.cursor), i));
      const now = new Date();
      let stunde = 7;
      if (days.includes(today())) stunde = Math.max(0, now.getHours() + now.getMinutes() / 60 - 1.5);
      else {
        // Ohne heute: zum ersten Termin der Tage, hoechstens bis 7 Uhr herunter.
        const erste = st.events.filter((e) => !istBalken(e.span) && days.includes(e.span.firstDay)).map((e) => e.span.start.min);
        if (erste.length) stunde = Math.max(0, Math.min(7, Math.min(...erste) / 60 - 0.5));
      }
      // Auf die volle Stunde: sonst stuende oben eine halb abgeschnittene Zeit.
      // Schneidet dort ein Termin die Kante, beginnt die Ansicht mit ihm.
      const rand = (10 / HOUR) * 60;
      const bloecke = st.events
        .filter((e) => !istBalken(e.span) && days.some((d) => onDay(e.span, d)))
        .map((e) => ({ startMin: e.span.start.min, endMin: e.span.end && e.span.end.day === e.span.start.day ? e.span.end.min : e.span.start.min + 60 }));
      const topMin = scrollAnfang(bloecke, Math.floor(stunde) * 60 - rand);
      scroller.scrollTop = Math.max(0, (topMin / 60) * HOUR - (topMin === Math.floor(stunde) * 60 - rand ? 0 : 10));
    }

    /* ---- Tag: der kleine Monat daneben ---- */

    function renderSeite() {
      const weeks = monthGrid(st.cursor);
      const month = st.cursor.slice(0, 7);
      const t = today();
      const mitTerminen = new Set();
      for (const e of st.events) {
        for (let d = e.span.firstDay; d <= e.span.lastDay; d = addDays(d, 1)) {
          mitTerminen.add(d);
          if (mitTerminen.size > 400) break;
        }
      }
      const grid = h('div.kal__mini-grid', { role: 'group', 'aria-label': fmt(st.cursor, { month: 'long', year: 'numeric' }) },
        ...WEEKDAYS.map((d) => h('span.kal__mini-wt', { 'aria-hidden': 'true' }, text(d.slice(0, 2)))),
        ...weeks.flat().map((day) => h('button.kal__mini-tag', {
          type: 'button',
          'data-day': day,
          tabindex: day === st.cursor ? '0' : '-1',
          'aria-label': `${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}${mitTerminen.has(day) ? ', mit Terminen' : ''}`,
          'aria-pressed': day === st.cursor ? 'true' : 'false',
          class: { 'is-other': day.slice(0, 7) !== month, 'is-today': day === t, 'is-selected': day === st.cursor, 'has-events': mitTerminen.has(day) },
          onClick: () => select(day),
        }, text(String(parseDay(day).getDate())))));
      grid.addEventListener('keydown', (event) => {
        const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (event.key in steps) {
          event.preventDefault();
          select(addDays(st.cursor, steps[event.key]), { focus: true });
        }
      });
      const heute = eventsOn(st.cursor);
      const summe = !st.loaded ? '' : heute.length === 0
        ? (st.cursor === t ? 'Heute nichts.' : 'Nichts eingetragen.')
        : heute.length === 1 ? '1 Termin' : `${heute.length} Termine`;
      return h('aside.kal__seite', { 'aria-label': 'Monat' },
        h('section.kal__mini', null,
          h('div.kal__mini-kopf', null,
            h('span.kal__mini-titel', null, text(fmt(st.cursor, { month: 'long', year: 'numeric' }))),
            h('button.icon-button', { type: 'button', 'aria-label': 'Vorheriger Monat', title: 'Vorheriger Monat', onClick: () => select(addMonths(st.cursor, -1)) }, icon(I.prev)),
            h('button.icon-button', { type: 'button', 'aria-label': 'Nächster Monat', title: 'Nächster Monat', onClick: () => select(addMonths(st.cursor, 1)) }, icon(I.next))),
          grid),
        h('p.kal__summe', null, text(summe)));
    }

    function markOpen() {
      const openKey = st.sheet && st.sheet.kind === 'detail' ? st.sheet.key : null;
      for (const el of body.querySelectorAll('.kal__entry, .kal__block, .kal__balken')) {
        el.classList.toggle('is-open', !!openKey && el.dataset.key === openKey);
      }
    }

    function markNeu() {
      if (!st.neuKey || !st.loaded) return;
      const key = st.neuKey;
      st.neuKey = null;
      // Schluessel sind "event_…@JJJJ-MM-TT": nichts, was im Selektor maskiert werden muesste.
      const el = body.querySelector(`[data-key="${key}"]`);
      if (!el) return;
      el.classList.add('is-neu');
      if (el.closest('.kal__rscroll')) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    /* ---------------- Ziehen: verschieben, verlaengern, anlegen ---------------- */

    /**
     * Eine einzige Zeigerlogik fuer Maus und Finger (Pointer Events):
     * - Maus: ab 4 px Bewegung wird gezogen, sonst ist es ein Klick.
     * - Finger: erst kurz halten (300 ms), dann ziehen. Wer sofort wischt,
     *   scrollt -- sonst liesse sich ein voller Tag nicht mehr bewegen.
     * - Der untere Rand eines Termins (.kal__grip) zieht ohne Halten, auch mit
     *   dem Finger (dort ist ausdruecklich nichts zum Scrollen) -- aber erst ab
     *   4 px Bewegung, und das neue Ende folgt der BEWEGUNG, nicht der Minute
     *   unter dem Zeiger. Ein Tipp auf den Rand ist ein Tipp auf den Termin.
     */
    let drag = null;
    let klickSchlucken = false;

    function schlucken(ev) {
      if (!klickSchlucken) return false;
      klickSchlucken = false;
      ev.preventDefault();
      return true;
    }

    function minuteAt(stunden, clientY) {
      const r = stunden.getBoundingClientRect();
      return Math.max(0, Math.min(24 * 60, ((clientY - r.top) / HOUR) * 60));
    }

    function spalteAt(cols, clientX) {
      let best = 0;
      cols.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        if (clientX >= r.left) best = i;
      });
      return best;
    }

    function onPointerDown(ev, { days, stunden, barsEl }) {
      if (drag || dom.frage) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (ev.target.closest('.kal__mehr')) return;
      const grip = ev.target.closest('.kal__grip');
      const block = ev.target.closest('.kal__block');
      const balken = ev.target.closest('.kal__balken');
      const col = ev.target.closest('.kal__rcol');
      let kind;
      if (barsEl) {
        if (!balken) return;
        kind = 'balken';
      } else if (grip && block) kind = 'dauer';
      else if (block) kind = 'verschieben';
      else if (col) kind = 'anlegen';
      else return;
      const el = balken || block;
      const e = el ? st.byKey.get(el.dataset.key) : null;
      if (el && !e) return;
      const cols = stunden ? [...stunden.querySelectorAll('.kal__rcol')] : [...barsEl.querySelectorAll('.kal__rganz-zelle')];
      drag = {
        kind,
        e,
        el,
        days,
        stunden,
        barsEl,
        cols,
        pointerId: ev.pointerId,
        touch: ev.pointerType !== 'mouse',
        x0: ev.clientX,
        y0: ev.clientY,
        x: ev.clientX,
        y: ev.clientY,
        min0: stunden ? minuteAt(stunden, ev.clientY) : 0,
        spalte0: spalteAt(cols, ev.clientX),
        active: false,
        timer: null,
        ghost: null,
        neu: null,
      };
      if (kind === 'dauer') {
        // Kein Textmarkieren, kein Scrollen -- aktiviert wird erst beim Ziehen.
        ev.preventDefault();
      } else if (drag.touch) {
        drag.timer = setTimeout(() => aktivieren(), kind === 'anlegen' ? 450 : 300);
      }
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    }

    function aktivieren() {
      if (!drag || drag.active) return;
      drag.active = true;
      clearTimeout(drag.timer);
      document.body.classList.add('kal-zieht');
      if (drag.touch && typeof navigator !== 'undefined' && navigator.vibrate) {
        try { navigator.vibrate(8); } catch { /* egal */ }
      }
      if (drag.el) drag.el.classList.add('is-dragging');
      ziehenZeichnen();
    }

    function onPointerMove(ev) {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      if (!drag.active) {
        const weg = Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0);
        if (drag.kind === 'dauer') {
          if (weg >= 4) aktivieren();
          return;
        }
        if (drag.touch) {
          // Der Finger bewegt sich, bevor er "gehalten" hat: scrollen oder wischen.
          if (weg > 8) abbrechen();
          return;
        }
        if (weg < 4) return;
        aktivieren();
        return;
      }
      ev.preventDefault();
      ziehenZeichnen();
      autoScroll();
    }

    /** Waehrend ein Finger zieht, darf die Seite nicht mitscrollen. */
    const gegenScrollen = (ev) => { if (drag && drag.active) ev.preventDefault(); };
    document.addEventListener('touchmove', gegenScrollen, { passive: false });
    cleanups.push(() => document.removeEventListener('touchmove', gegenScrollen, { passive: false }));

    let scrollFrame = null;
    function autoScroll() {
      if (!drag || !drag.active || !drag.stunden) return;
      const scroller = drag.stunden.closest('.kal__rscroll');
      if (!scroller) return;
      const r = scroller.getBoundingClientRect();
      const rand = 36;
      const dy = drag.y < r.top + rand ? -10 : drag.y > r.bottom - rand ? 10 : 0;
      if (!dy) return;
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        if (!drag || !drag.active) return;
        scroller.scrollTop += dy;
        ziehenZeichnen();
        autoScroll();
      });
    }

    /** Wie weit ein Vorkommen jetzt liegt -- und der Geist, der es zeigt. */
    function ziehenZeichnen() {
      const d = drag;
      if (!d || !d.active) return;
      const spalte = spalteAt(d.cols, d.x);
      if (d.kind === 'balken') {
        const tage = spalte - d.spalte0;
        d.neu = verschieben(d.e.data.start, d.e.data.end, tage * 1440, d.e.span.allDay);
        const n = d.days.length;
        const von = Math.max(0, Math.min(n - 1, tageZwischen(d.days[0], d.neu.start)));
        const bisTag = d.neu.end || d.neu.start;
        const bis = Math.max(von, Math.min(n - 1, tageZwischen(d.days[0], bisTag)));
        if (!d.ghost) {
          d.ghost = d.el.cloneNode(true);
          d.ghost.classList.remove('is-dragging');
          d.ghost.classList.add('is-ghost');
          d.ghost.style.boxShadow = 'var(--shadow-2)';
          d.ghost.style.borderColor = 'var(--accent)';
          d.barsEl.appendChild(d.ghost);
        }
        d.ghost.style.gridColumn = `${von + 1} / ${bis + 2}`;
        return;
      }
      const min = minuteAt(d.stunden, d.y);
      const day = d.days[spalte];
      let startMin;
      let endMin;
      let zielTag = day;
      if (d.kind === 'anlegen') {
        ({ startMin, endMin } = anlegenSpanne(d.min0, min));
        zielTag = d.days[d.spalte0];
        d.neu = { start: `${zielTag}T${minZuHm(startMin)}`, end: endMin >= 1440 ? `${addDays(zielTag, 1)}T00:00` : `${zielTag}T${minZuHm(endMin)}` };
      } else if (d.kind === 'dauer') {
        const s = alsWand(d.e.data.start);
        const letzter = d.e.span.lastDay;
        zielTag = letzter;
        startMin = d.e.span.firstDay === zielTag ? d.e.span.start.min : 0;
        const sp = d.e.span;
        const altEnde = sp.end ? (sp.end.day === letzter ? sp.end.min : 24 * 60) : startMin + 60;
        const neuEnde = dauerEnde(altEnde, d.y - d.y0, HOUR, startMin);
        let ende = neuEnde >= 1440 ? `${addDays(letzter, 1)}T00:00` : `${letzter}T${minZuHm(neuEnde)}`;
        if (minutenZwischen(s, ende) < 15) ende = plusMinuten(s, 15);
        d.neu = { start: s, end: ende };
        endMin = neuEnde;
      } else {
        const delta = snap(min - d.min0) + (spalte - d.spalte0) * 1440;
        d.neu = verschieben(d.e.data.start, d.e.data.end, delta, false);
        const s = whenOf(d.neu.start);
        const dauer = d.neu.end ? minutenZwischen(d.neu.start, d.neu.end) : 60;
        zielTag = s.day;
        startMin = s.min;
        endMin = Math.min(1440, startMin + dauer);
      }
      const colIndex = d.days.indexOf(zielTag);
      if (!d.ghost) {
        // Beim Ziehen zaehlt die Uhrzeit: sie steht vorn, der Titel danach.
        d.ghost = h('div.kal__block.is-ghost', { 'aria-hidden': 'true', style: { '--lane': 0, '--lanes': 1 } },
          h('span.kal__block-text', null,
            h('span.kal__block-time'),
            h('span.kal__block-title', null, text(d.e ? d.e.data.title : 'Neuer Termin'))));
      }
      if (colIndex === -1) {
        d.ghost.remove();
        return;
      }
      const col = d.cols[colIndex];
      if (d.ghost.parentNode !== col) col.appendChild(d.ghost);
      const top = (startMin / 60) * HOUR;
      const height = Math.max(20, ((endMin - startMin) / 60) * HOUR - 2);
      d.ghost.style.top = `${top}px`;
      d.ghost.style.height = `${height}px`;
      d.ghost.style.setProperty('--zeilen', String(Math.max(1, Math.floor((height - 26) / 16))));
      d.ghost.classList.toggle('is-kurz', height < 36);
      const zeit = d.ghost.querySelector('.kal__block-time');
      clear(zeit);
      zeit.append(h('span', null, text(minZuHm(startMin))),
        h('span.kal__block-bis', null, text(`–${endMin >= 1440 ? '24:00' : minZuHm(endMin)}`)));
    }

    function aufraeumenZiehen() {
      if (!drag) return;
      clearTimeout(drag.timer);
      cancelAnimationFrame(scrollFrame);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      document.body.classList.remove('kal-zieht');
      const d = drag;
      drag = null;
      return d;
    }

    function abbrechen() {
      const d = aufraeumenZiehen();
      if (!d) return;
      if (d.ghost) d.ghost.remove();
      if (d.el) d.el.classList.remove('is-dragging');
      if (d.active) klickSchlucken = true;
      nachholen();
    }

    function onPointerCancel(ev) {
      if (drag && ev.pointerId === drag.pointerId) abbrechen();
    }

    async function onPointerUp(ev) {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const d = aufraeumenZiehen();
      if (!d.active) {
        // Ein Tipp auf eine leere Stelle: dort ein neuer Termin, eine Stunde.
        if (d.kind === 'anlegen' && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 8) {
          const a = Math.min(23 * 60, Math.floor(d.min0 / 30) * 30);
          openForm(null, { day: d.days[d.spalte0], von: minZuHm(a), bis: minZuHm(Math.min(a + 60, 23 * 60 + 45)) });
        }
        nachholen();
        return;
      }
      klickSchlucken = true;
      setTimeout(() => { klickSchlucken = false; }, 400);
      const neu = d.neu;
      if (d.kind === 'anlegen') {
        if (d.ghost) d.ghost.remove();
        const s = whenOf(neu.start);
        const e = whenOf(neu.end);
        openForm(null, { day: s.day, von: s.hm, bis: e.day > s.day ? '23:59' : e.hm });
        nachholen();
        return;
      }
      await zeitAendern(d.e, neu, d.ghost || d.el, d.kind);
      if (d.ghost) d.ghost.remove();
      if (d.el) d.el.classList.remove('is-dragging');
      nachholen();
    }

    function nachholen() {
      if (st.pendingReload && !drag && !dom.frage) {
        st.pendingReload = false;
        reloadSoon();
      }
    }

    /**
     * Die Frage bei Serien, als kleine Karte am gezogenen Termin: "Nur dieser
     * Termin" oder "Alle". Zwei Knoepfe, keine Erklaerung.
     * @returns {Promise<'nur'|'alle'|null>}
     */
    function frageSerie(anker, titel, verb = 'verschieben') {
      schliesseFrage(null);
      return new Promise((resolve) => {
        const rootRect = root.getBoundingClientRect();
        const r = anker && anker.getBoundingClientRect ? anker.getBoundingClientRect() : null;
        const fertig = (wahl) => schliesseFrage(wahl);
        const karte = h('div.kal__frage', { role: 'dialog', 'aria-label': 'Wiederkehrender Termin' },
          h('p.kal__frage-text', null, h('strong', null, text(`„${titel}“`)), text(` wiederholt sich. Was ${verb}?`)),
          h('div.kal__frage-knoepfe', null,
            h('button.btn.btn--primary.btn--small', { type: 'button', onClick: () => fertig('nur') }, text('Nur dieser Termin')),
            h('button.btn.btn--small', { type: 'button', onClick: () => fertig('alle') }, text('Alle')),
            h('button.btn.btn--ghost.btn--small', { type: 'button', onClick: () => fertig(null) }, text('Abbrechen'))));
        dom.frage = { karte, resolve };
        root.appendChild(karte);
        const w = karte.offsetWidth;
        const hgt = karte.offsetHeight;
        let left = r ? r.left - rootRect.left : (rootRect.width - w) / 2;
        let top = r ? r.bottom - rootRect.top + 8 : rootRect.height / 3;
        if (top + hgt > rootRect.height - 8) top = Math.max(8, (r ? r.top - rootRect.top : rootRect.height / 2) - hgt - 8);
        left = Math.max(8, Math.min(left, rootRect.width - w - 8));
        karte.style.left = `${left}px`;
        karte.style.top = `${top}px`;
        const erster = karte.querySelector('button');
        if (erster) erster.focus({ preventScroll: true });
      });
    }

    function schliesseFrage(wahl) {
      if (!dom.frage) return;
      const { karte, resolve } = dom.frage;
      dom.frage = null;
      karte.remove();
      resolve(wahl);
      nachholen();
    }

    /**
     * Beginn/Ende eines Termins aendern (nach dem Ziehen oder aus dem
     * Formular) -- bei Serien nach der Frage. Danach "Rueckgaengig".
     */
    async function zeitAendern(e, neu, anker, art = 'verschieben') {
      const alt = { start: alsWand(e.data.start), end: e.data.end ? alsWand(e.data.end) : null };
      if (!neu || (neu.start === alt.start && (neu.end || null) === (alt.end || null))) {
        render();
        return;
      }
      let wahl = null;
      if (e.recurring) {
        wahl = await frageSerie(anker, e.data.title, art === 'dauer' ? 'verlängern' : 'verschieben');
        if (!wahl) {
          render();
          return;
        }
      }
      const was = art === 'dauer'
        ? `„${e.data.title}“ endet jetzt um ${neu.end.slice(11, 16)}.`
        : `„${e.data.title}“ → ${zeitTeil({ start: neu.start, end: neu.end, allDay: neu.start.length === 10 }, new Date())}`;
      try {
        let res;
        let zurueck;
        const pfad = `/events/${encodeURIComponent(e.id)}`;
        if (wahl === 'nur') {
          const serie = (await api.get(pfad)).record;
          res = await api.patch(pfad, { start: neu.start, end: neu.end }, { query: nurDieses(e) });
          const neuId = res && res.record && res.record.id;
          const altAus = Array.isArray(serie.data.exdates) ? serie.data.exdates : [];
          zurueck = async () => {
            if (neuId) await api.del(`/events/${encodeURIComponent(neuId)}`);
            await api.patch(pfad, { exdates: altAus });
          };
          if (neuId) st.neuKey = `${neuId}@`;
        } else if (wahl === 'alle') {
          const serie = (await api.get(pfad)).record;
          const patch = serienPatch(serie.data, alt, neu);
          const vorher = { start: serie.data.start, end: serie.data.end || null };
          if (patch.recurrence) vorher.recurrence = serie.data.recurrence;
          if (patch.exdates) vorher.exdates = serie.data.exdates;
          res = await api.patch(pfad, patch);
          zurueck = () => api.patch(pfad, vorher);
        } else {
          res = await api.patch(pfad, { start: neu.start, end: neu.end });
          zurueck = () => api.patch(pfad, { start: alt.start, end: alt.end });
        }
        await load();
        toast(wahl === 'nur' ? `Nur dieser Termin: ${was}` : was, 'success', {
          action: { label: 'Rückgängig', run: () => rueckgaengig(res, zurueck) },
          timeout: 9000,
        });
      } catch (err) {
        toast(`Nicht geändert: ${errorText(err)}`, 'error');
        render();
      }
    }

    /**
     * Rueckgaengig: bevorzugt der Verlaufseintrag, den der Server nennt (er
     * nimmt eine Gruppe als Ganzes zurueck); sonst die Gegenbewegung von hier.
     */
    async function rueckgaengig(res, ersatz) {
      try {
        const r = res && res.rueckgaengig;
        if (r && r.pfad) await api.post(r.pfad, {});
        else if (typeof ersatz === 'function') await ersatz();
        else throw new Error('Dafür gibt es keinen Weg zurück.');
        if (!st.alive) return;
        await load();
        if (st.sheet && st.sheet.kind === 'detail') closeSheet();
        toast('Rückgängig gemacht.', 'info');
      } catch (err) {
        toast(`Rückgängig ging nicht: ${errorText(err)}`, 'error');
      }
    }

    /* ---------------- Schnell eintragen ---------------- */

    let konfliktTimer = null;
    function renderQuick() {
      const txt = quick.input.value;
      clear(quick.pop);
      quick.fehler = null;
      if (!txt.trim()) {
        quick.pop.hidden = true;
        quick.ergebnis = null;
        return;
      }
      const r = leseTermin(txt, new Date());
      quick.ergebnis = r;
      quick.pop.hidden = false;
      clearTimeout(konfliktTimer);
      quick.konflikte = [];
      quick.token += 1;
      zeichneVorschau();
      // Auch bei Serien (dann fuer das erste Vorkommen, das die Vorschau zeigt)
      // und bei Ganztaegigem (dann nur mit anderem Ganztaegigem, Vertrag E).
      if (r) {
        const mein = ++quick.token;
        konfliktTimer = setTimeout(async () => {
          try {
            const res = await api.get('/events/ueberschneidungen', { query: { start: r.start, end: r.end || '' } });
            if (mein !== quick.token || !st.alive) return;
            quick.konflikte = Array.isArray(res && res.items) ? res.items : [];
            zeichneVorschau();
          } catch { /* ohne diese Auskunft geht es auch */ }
        }, 250);
      }
    }

    function zeichneVorschau() {
      const r = quick.ergebnis;
      clear(quick.pop);
      if (!r) {
        quick.pop.append(
          h('span.kal__quick-bar.is-leer', { 'aria-hidden': 'true' }),
          h('div.kal__quick-text', null,
            h('span.kal__quick-was', null, text('Wann?')),
            h('span.kal__quick-note', null, text('Zum Beispiel „morgen 15 Uhr“, „Fr 3.10.“ oder „jeden Dienstag 18 Uhr“.'))),
          h('span'));
        return;
      }
      const notizen = [];
      if (quick.fehler) notizen.push(h('span.kal__quick-note.is-warn', { role: 'alert' }, text(quick.fehler)));
      else if (!r.titel) notizen.push(h('span.kal__quick-note', null, text('Wie heißt der Termin? Einfach dazuschreiben.')));
      if (r.hinweis) notizen.push(h('span.kal__quick-note.is-warn', null, text(r.hinweis)));
      if (quick.konflikte.length) {
        const k = quick.konflikte[0];
        const kd = k.data || k;
        const span = spanOf(kd);
        notizen.push(h('span.kal__quick-note', null, text(`Gleichzeitig: „${kd.title}“${span ? ` ${timeLabel(span)}` : ''}${quick.konflikte.length > 1 ? ` und ${quick.konflikte.length - 1} weitere` : ''}.`)));
      }
      const rest = [r.titel || null, r.ort || null, r.recurrence ? wiederholungInWorten(r.recurrence, r.start) : null].filter(Boolean);
      quick.pop.append(
        h('span.kal__quick-bar', { 'aria-hidden': 'true' }),
        h('div.kal__quick-text', { 'aria-label': beschreibe(r, new Date()) },
          h('span.kal__quick-was', null, text(zeitTeil(r, new Date()))),
          rest.length ? h('span.kal__quick-titel', null, text(rest.join(' · '))) : null,
          ...notizen),
        h('button.btn.btn--primary.btn--small.kal__quick-go', {
          type: 'button',
          disabled: quick.busy || !r.titel,
          title: 'Eintragen (Enter)',
          onMousedown: (ev) => ev.preventDefault(),
          onClick: () => eintragen(),
        }, text('Eintragen'), icon(I.enter)));
    }

    function vorbelegungAusFeld() {
      const r = quick.ergebnis;
      if (!r) return { titel: quick.input.value.trim() };
      const s = whenOf(r.start);
      const e = r.end ? whenOf(r.end) : null;
      return {
        titel: r.titel,
        day: s.day,
        von: r.allDay ? '' : s.hm,
        bis: r.allDay || !e ? '' : (e.day > s.day ? '23:59' : e.hm),
        allDay: r.allDay,
        endTag: r.allDay && r.end ? r.end : null,
        recurrence: r.recurrence,
        ort: r.ort,
      };
    }

    async function eintragen() {
      const r = quick.ergebnis;
      if (quick.busy) return;
      if (!r || !r.titel) {
        quick.input.focus();
        return;
      }
      const body = { title: r.titel, start: r.start, end: r.end, allDay: r.allDay, location: r.ort || '' };
      if (r.recurrence) body.recurrence = r.recurrence;
      quick.busy = true;
      zeichneVorschau();
      let res;
      try {
        res = await api.post('/events', body);
      } catch (err) {
        quick.busy = false;
        quick.fehler = `Nicht eingetragen: ${errorText(err)}`;
        zeichneVorschau();
        return;
      }
      quick.busy = false;
      if (!st.alive) return;
      quick.input.value = '';
      renderQuick();
      const rec = res.record;
      const day = r.start.slice(0, 10);
      st.neuKey = `${rec.id}@${r.recurrence ? day : ''}`;
      st.selected = day;
      if (st.mode !== 'liste') st.cursor = day;
      await load();
      toast(`„${rec.data.title}“ eingetragen · ${zeitTeil(r, new Date())}`, 'success', {
        action: { label: 'Rückgängig', run: () => rueckgaengig(res, () => api.del(`/events/${encodeURIComponent(rec.id)}`)) },
        timeout: 9000,
      });
    }

    quick.input.addEventListener('input', renderQuick);
    quick.input.addEventListener('focus', () => { if (quick.input.value.trim()) quick.pop.hidden = false; });
    quick.input.addEventListener('blur', () => {
      // Die Vorschau bleibt, solange etwas drinsteht -- aber nicht ueber dem Kalender,
      // wenn man woanders hinklickt.
      setTimeout(() => { if (document.activeElement !== quick.input && !quick.busy) quick.pop.hidden = true; }, 120);
    });
    quick.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        eintragen();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (quick.input.value) {
          quick.input.value = '';
          renderQuick();
        } else {
          quick.input.blur();
        }
      }
    });

    /* ---------------- Seitenblatt ---------------- */

    function closeSheet({ keepRoute = false } = {}) {
      const warImBlatt = !!dom.sheet && dom.sheet.contains(document.activeElement);
      if (dom.sheet) dom.sheet.remove();
      dom.sheet = null;
      const hadId = st.sheet && st.sheet.kind !== 'neu';
      const oeffner = st.sheet ? st.sheet.oeffner || st.sheet.key : null;
      st.sheet = null;
      markOpen();
      if (!keepRoute && hadId && typeof ctx.replaceRoute === 'function') ctx.replaceRoute('#/kalender');
      // Der Fokus geht dorthin zurueck, woher das Blatt kam -- sonst landet er
      // auf <body>, und wer mit der Tastatur arbeitet, tabbt wieder von oben.
      if (warImBlatt && oeffner) {
        let ziel = body.querySelector(`[data-key="${oeffner}"]`);
        if (ziel && !ziel.matches('button, a, [tabindex]')) ziel = ziel.closest('button, a, [tabindex]');
        if (ziel) ziel.focus({ preventScroll: true });
      }
    }

    function showSheet(kicker, ...content) {
      if (dom.sheet) dom.sheet.remove();
      const close = h('button.icon-button', { type: 'button', 'aria-label': 'Schließen', title: 'Schließen (Esc)', onClick: () => closeSheet() }, icon(I.close));
      dom.sheet = h('aside.kal__sheet', { role: 'region', 'aria-label': typeof kicker === 'string' ? kicker : 'Termin' },
        h('div.kal__sheet-top', null, h('span.kal__sheet-kicker', null, kicker), close),
        h('div.kal__sheet-body', null, ...content));
      root.appendChild(dom.sheet);
      markOpen();
      return dom.sheet;
    }

    /**
     * Einen Termin oeffnen -- ein Eintrag aus der Liste oder {id, occurrence}
     * aus der Adresse.
     */
    async function openDetail(ref, { fromRoute = false } = {}) {
      if (!ref) return;
      const id = ref.id;
      let occ = ref.occurrence || null;
      let res;
      try {
        res = await api.get(`/events/${encodeURIComponent(id)}`);
      } catch (err) {
        if (!st.alive) return;
        toast(err && err.status === 404 ? 'Diesen Termin gibt es nicht mehr.' : `Der Termin konnte nicht geöffnet werden: ${errorText(err)}`, 'error');
        if (fromRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute('#/kalender');
        return;
      }
      if (!st.alive) return;
      const record = res.record;
      if (!record.data.recurrence) occ = null;
      // Eine Serie ohne Tag (#/kalender?id=… aus einer Chat-Karte): ihr
      // naechstes Vorkommen zeigen, nicht den Beginn der Serie als waere er
      // ein einzelner Termin -- sonst meldete das Blatt eine Ueberschneidung
      // mit sich selbst, und "Loeschen" fragte nicht "Nur diesen / Alle".
      else if (!occ && res.naechstes) occ = res.naechstes;
      let e = st.byKey.get(`${id}@${occ || ''}`);
      if (!e) {
        const lage = occ ? aufTag(record.data, occ) : null;
        e = eintragAus({ id, data: lage ? { ...record.data, ...lage } : record.data, occurrence: occ, recurring: !!occ });
      }
      if (!e) return;
      // Liegt der Termin ausserhalb dessen, was man sieht: dorthin blaettern.
      const range = aktuellerRange();
      if (st.mode !== 'liste' && (e.span.firstDay < range.from || e.span.firstDay > range.to)) {
        st.cursor = e.span.firstDay;
        st.selected = e.span.firstDay;
        st.scrollZiel = 'jetzt';
        await load();
      } else if (st.mode === 'monat' && st.selected !== e.span.firstDay && e.span.firstDay.slice(0, 7) === st.cursor.slice(0, 7)) {
        st.selected = e.span.firstDay;
        render();
      }
      const vorher = st.sheet;
      st.sheet = { kind: 'detail', id, occurrence: occ, key: e.key, oeffner: ref.key || (vorher && vorher.oeffner) || e.key };
      renderDetail(res, e);
      if (!fromRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute(`#/kalender?id=${id}${occ ? `&am=${occ}` : ''}`);
    }

    function renderDetail(res, e) {
      const record = res.record;
      const serie = record.data;
      const data = e.data;
      const span = e.span;
      const dayLine = span.firstDay === span.lastDay
        ? fmt(span.firstDay, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
        : `${fmt(span.firstDay, { weekday: 'short', day: 'numeric', month: 'short' })} – ${fmt(span.lastDay, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`;
      const timeLine = span.allDay ? 'ganztägig' : (span.firstDay === span.lastDay ? timeLabel(span) : `${span.start.hm} – ${span.end ? span.end.hm : ''}`);

      const facts = h('ul.kal__facts');
      if (data.location) facts.appendChild(h('li.kal__fact', null, icon(I.pin), h('span', null, text(data.location))));
      if (serie.recurrence) {
        facts.appendChild(h('li.kal__fact', null, icon(I.repeat), h('span', null, text(wiederholungInWorten(serie.recurrence, serie.start)))));
      }
      if (serie.ausSerie) {
        facts.appendChild(h('li.kal__fact', null, icon(I.repeat), h('span', null, text('Einzeln verschoben – aus einer Serie.'))));
      }
      if (serie.reminder !== null && serie.reminder !== undefined) {
        const schalter = h('button.kal__switch', {
          type: 'button',
          role: 'switch',
          'aria-checked': mitteilungAn() ? 'true' : 'false',
          onClick: async () => {
            const an = schalter.getAttribute('aria-checked') !== 'true';
            const erg = await mitteilungSchalten(an);
            schalter.setAttribute('aria-checked', erg.an ? 'true' : 'false');
            if (erg.grund) toast(erg.grund, 'info');
          },
        }, h('span.kal__switch-spur', { 'aria-hidden': 'true' }), text('Auch als Mitteilung'));
        facts.appendChild(h('li.kal__fact', null, icon(I.bell),
          h('div.kal__fact-body', null,
            h('span', null, text(erinnerungInWorten(serie.reminder))),
            mitteilungMoeglich() ? schalter : null,
            h('span.kal__ehrlich', null, text('Erinnert nur, solange Neural OS offen ist.')))));
      }
      // Die Kalenderdatei als leise Zeile statt als dritter Knopf: drei Knoepfe
      // passten nicht in eine Zeile, und "Loeschen" stand allein darunter.
      facts.appendChild(h('li.kal__fact', null, icon(I.ics),
        h('a.kal__fact-ics', {
          href: `/api/events/${encodeURIComponent(record.id)}/ics`,
          title: 'Als Kalenderdatei – auf dem iPad: „Zum Kalender hinzufügen“',
        }, text('In Kalender übernehmen (.ics)'))));
      if (res.projekt) {
        facts.appendChild(h('li.kal__fact', null, icon(I.projects),
          h('span', null, text('Projekt '), h('a', { href: `#/projects?id=${encodeURIComponent(res.projekt.id)}` }, text(res.projekt.name)))));
      }
      // Gleichzeitig: aus dem, was ohnehin geladen ist -- keine eigene Anfrage.
      if (!span.allDay) {
        const ende = span.end ? span.end.ms : span.start.ms + 3600000;
        const andere = st.events.filter((x) => x.key !== e.key && x.id !== e.id && !x.span.allDay
          && x.span.start.ms < ende && (x.span.end ? x.span.end.ms : x.span.start.ms + 3600000) > span.start.ms);
        if (andere.length) {
          facts.appendChild(h('li.kal__fact', null, icon(I.clock),
            h('span', null, text(`Gleichzeitig: ${andere.slice(0, 2).map((x) => `„${x.data.title}“ ${timeLabel(x.span)}`).join(', ')}${andere.length > 2 ? ` und ${andere.length - 2} weitere` : ''}`))));
        }
      }

      let origin;
      if (serie.source === 'auto') {
        const chat = res.chat;
        origin = h('div.kal__origin', null,
          h('p.kal__origin-text', null,
            chat
              ? [text(chat.deleted ? 'Von der KI aus dem inzwischen gelöschten Chat ' : 'Von der KI aus dem Chat '), h('strong', null, text(`„${chat.title}“`)),
                text(`, ${fmtStamp(record.createdAt)}.`)]
              : text('Von der KI angelegt; der Chat dazu ist nicht mehr auffindbar.')),
          chat && !chat.deleted
            ? h('button.btn.btn--accent.btn--small', { type: 'button', onClick: () => ctx.navigate(`#/chat?id=${encodeURIComponent(chat.id)}`) },
              icon(I.chat), text('Zum Chat'))
            : null);
      } else {
        origin = h('div.kal__origin', null,
          h('p.kal__origin-text', null, text(`Von dir eingetragen, ${fmtStamp(record.createdAt)}.`)));
      }

      const aktionen = h('div.kal__actions');
      const zeigeAktionen = () => {
        clear(aktionen);
        aktionen.append(
          h('button.btn', { type: 'button', onClick: () => openForm(res, {}, e) }, icon(I.pen), text('Bearbeiten')),
          h('span.spacer'),
          h('button.btn.btn--ghost.kal__danger', {
            type: 'button',
            // Eine Serie fragt IMMER, auch wenn kein Vorkommen gewaehlt ist --
            // sonst waere mit einem Tipp die ganze Serie weg.
            onClick: () => (e.recurring || serie.recurrence ? frageLoeschen() : remove(record, e, 'einzeln')),
          }, icon(I.trash), text('Löschen')));
      };
      const frageLoeschen = () => {
        clear(aktionen);
        aktionen.appendChild(h('div.kal__wahl', { role: 'group', 'aria-label': 'Löschen' },
          h('p.kal__wahl-text', null, text(`„${data.title}“ wiederholt sich. Was löschen?`)),
          h('div.kal__wahl-knoepfe', null,
            e.occurrence ? h('button.btn.btn--small.kal__danger', { type: 'button', onClick: () => remove(record, e, 'nur') }, text('Nur diesen Termin')) : null,
            h('button.btn.btn--small.kal__danger', { type: 'button', onClick: () => remove(record, e, 'alle') }, text('Alle')),
            h('button.btn.btn--ghost.btn--small', { type: 'button', onClick: zeigeAktionen }, text('Abbrechen')))));
        const erster = aktionen.querySelector('button');
        if (erster) erster.focus();
      };
      zeigeAktionen();

      showSheet(h('span', null, text(e.recurring || serie.recurrence ? 'Termin · Serie' : 'Termin'),
        serie.source === 'auto' ? h('span.kal__ki', { title: 'Von der KI angelegt' }, icon(I.ki)) : null),
      h('h2.kal__sheet-title', { tabindex: '-1' }, text(data.title)),
      h('div.kal__when', null, h('span.kal__when-bar', { 'aria-hidden': 'true' }),
        h('div', null, h('span.kal__when-day', null, text(dayLine)), h('span.kal__when-time', null, text(timeLine)))),
      facts.childNodes.length ? facts : null,
      data.body ? h('p.kal__note', null, text(data.body)) : null,
      origin,
      aktionen);
      const title = dom.sheet.querySelector('.kal__sheet-title');
      if (title && !coarse) title.focus({ preventScroll: true });
    }

    function fmtStamp(iso) {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return '';
      const day = toDay(d);
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      if (day === today()) return `heute ${hm}`;
      if (day === addDays(today(), -1)) return `gestern ${hm}`;
      return `${fmt(day, { day: 'numeric', month: 'short', year: 'numeric' })}, ${hm}`;
    }

    /** Loeschen ohne Rueckfrage -- dafuer mit "Rueckgaengig" gleich danach. */
    async function remove(record, e, art) {
      const pfad = `/events/${encodeURIComponent(record.id)}`;
      let res;
      let zurueck;
      try {
        if (art === 'nur') {
          const altAus = Array.isArray(record.data.exdates) ? record.data.exdates : [];
          res = await api.del(pfad, { query: nurDieses(e) });
          zurueck = () => api.patch(pfad, { exdates: altAus });
        } else {
          res = await api.del(pfad);
          zurueck = () => api.post(`/records/${encodeURIComponent(record.id)}/restore`);
        }
      } catch (err) {
        toast(`Löschen hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      closeSheet();
      await load();
      const wer = `„${record.data.title}“`;
      toast(art === 'nur' ? `${wer} am ${fmt(e.occurrence, { day: 'numeric', month: 'short' })} gelöscht.` : `${wer} gelöscht.`, 'success', {
        action: { label: 'Rückgängig', run: () => rueckgaengig(res, zurueck) },
        timeout: 9000,
      });
    }

    /**
     * Anlegen und Bearbeiten. Das meiste geht schneller ueber das Feld oben
     * oder durch Ziehen; hier steht alles, was ein Termin haben kann.
     * @param {object|null} res   GET /api/events/:id (Bearbeiten) oder null (neu)
     * @param {object} vor        Vorbelegung fuer neu: day, von, bis, allDay, titel, recurrence, ort, endTag
     * @param {object|null} e     das angetippte Vorkommen (bei Serien)
     */
    function openForm(res, vor = {}, e = null) {
      const record = res ? res.record : null;
      const serie = record ? record.data : null;
      const data = e ? e.data : serie;
      const span = data ? spanOf(data) : null;
      const startDay = span ? span.firstDay : (vor.day || st.selected || today());
      let von = '';
      let bis = '';
      if (span) {
        if (!span.allDay) {
          von = span.start.hm;
          bis = span.end ? span.end.hm : '';
        }
      } else if (!vor.allDay) {
        von = vor.von || (startDay === today() ? nextFullHour() : '09:00');
        bis = vor.bis || hmPlus(von, 60);
      }
      const rec = serie ? serie.recurrence : vor.recurrence || null;
      const recStart = serie ? serie.start : startDay;
      const preset = presetVon(rec, recStart);
      const endTag = span && span.allDay && span.lastDay > span.firstDay ? span.lastDay : (vor.endTag || '');

      const f = {
        title: h('input.input', { type: 'text', name: 'titel', required: true, maxlength: '500', autocomplete: 'off', value: data ? data.title : (vor.titel || ''), placeholder: 'z. B. Zahnarzt' }),
        day: h('input.input', { type: 'date', name: 'tag', required: true, value: startDay }),
        von: h('input.input', { type: 'time', name: 'von', value: von, step: '300' }),
        bis: h('input.input', { type: 'time', name: 'bis', value: bis, step: '300' }),
        // Auswahlfelder tragen ihren Namen ausdruecklich: in ein <label>
        // geschachtelt hiesse die Auswahl sonst "Erinnerung Keine Erinnerung"
        // (der gewaehlte Wert zaehlt zum Namen) -- fuer einen Screenreader
        // doppelt, und "Erinnerung" allein faende sie nicht.
        wdh: h('select.select', { name: 'wiederholen', 'aria-label': 'Wiederholen' },
          ...REC_PRESETS.map(([id, label]) => h('option', { value: id, selected: id === preset }, text(label))),
          preset === 'bisher' ? h('option', { value: 'bisher', selected: true }, text(`Wie bisher: ${wiederholungInWorten({ ...rec, until: null }, recStart)}`)) : null),
        bisTag: h('input.input', { type: 'date', name: 'serie-bis', value: rec && rec.until ? rec.until : '' }),
        erinnerung: h('select.select', { name: 'erinnerung', 'aria-label': 'Erinnerung' },
          ...ERINNERUNG_OPTIONEN.map((min) => h('option', {
            value: min === null ? '' : String(min),
            selected: (serie ? serie.reminder ?? null : null) === min,
          }, text(min === null ? 'Keine Erinnerung' : erinnerungInWorten(min))))),
        ort: h('input.input', { type: 'text', name: 'ort', maxlength: '500', autocomplete: 'off', value: data ? data.location || '' : (vor.ort || ''), placeholder: 'optional' }),
        notiz: h('textarea.textarea', { name: 'notiz', maxlength: '20000', rows: '3', placeholder: 'optional' }),
      };
      f.notiz.value = data && data.body ? data.body : '';
      const bisFeld = h('label.field', { hidden: !f.wdh.value }, h('span.label', null, text('Serie endet am')), f.bisTag);
      f.wdh.addEventListener('change', () => { bisFeld.hidden = !f.wdh.value; });

      const error = h('p.kal__form-error', { role: 'alert', hidden: true });
      const serienEdit = !!(record && e && e.recurring);
      const knoepfe = serienEdit
        ? [
          h('button.btn.btn--primary', { type: 'submit', value: 'nur' }, text('Nur diesen Termin')),
          h('button.btn', { type: 'submit', value: 'alle' }, text('Alle Termine')),
        ]
        : [h('button.btn.btn--primary', { type: 'submit', value: 'eins' }, text(record ? 'Speichern' : 'Eintragen'))];
      const form = h('form.kal__form', {
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          const wahl = (event.submitter && event.submitter.value) || 'eins';
          const input = collect();
          if (typeof input === 'string') {
            showError(input);
            return;
          }
          for (const b of knoepfe) b.disabled = true;
          try {
            await speichern(input, wahl);
          } catch (err) {
            showError(errorText(err));
          } finally {
            for (const b of knoepfe) b.disabled = false;
          }
        },
      },
      h('label.field', null, h('span.label', null, text('Titel')), f.title),
      h('div.kal__form-row', null,
        h('label.field', null, h('span.label', null, text('Tag')), f.day),
        h('label.field', null, h('span.label', null, text('von')), f.von),
        h('label.field', null, h('span.label', null, text('bis')), f.bis)),
      h('p.hint', { style: { margin: '-6px 0 0' } }, text('Ohne Uhrzeit ist der Termin ganztägig.')),
      h('div.kal__form-row.is-zwei', null,
        h('label.field', null, h('span.label', null, text('Wiederholen')), f.wdh),
        bisFeld),
      h('label.field', null, h('span.label', null, text('Erinnerung')), f.erinnerung),
      h('label.field', null, h('span.label', null, text('Ort')), f.ort),
      h('label.field', null, h('span.label', null, text('Notiz')), f.notiz),
      error,
      h('div.kal__actions', null, ...knoepfe,
        h('button.btn.btn--ghost', { type: 'button', onClick: () => (record ? openDetail(e || { id: record.id }) : closeSheet()) }, text('Abbrechen'))));

      function showError(message) {
        clear(error);
        error.appendChild(text(message));
        error.hidden = false;
      }

      /** Aus dem Formular die Felder, die der Server erwartet -- oder ein Satz, was fehlt. */
      function collect() {
        const title = f.title.value.trim();
        const tag = f.day.value;
        const vonV = f.von.value;
        const bisV = f.bis.value;
        if (!title) {
          f.title.focus();
          return 'Bitte einen Titel eingeben.';
        }
        if (!DATE_RE.test(tag)) {
          f.day.focus();
          return 'Bitte einen Tag wählen.';
        }
        if (!vonV && bisV) {
          f.von.focus();
          return 'Ein Ende ohne Beginn geht nicht – bitte auch „von“ ausfüllen.';
        }
        // Mehrtaegiges bleibt mehrtaegig: das Ende wandert mit, wenn der Tag sich aendert.
        const shift = span ? tageZwischen(span.firstDay, tag) : 0;
        const out = { title, location: f.ort.value.trim(), body: f.notiz.value };
        if (!vonV) {
          out.allDay = true;
          out.start = tag;
          out.end = endTag && endTag > startDay ? addDays(endTag, shift) : null;
        } else {
          out.allDay = false;
          out.start = `${tag}T${vonV}`;
          if (bisV) {
            const endDay = span && !span.allDay && span.end && span.end.day > span.firstDay ? addDays(span.end.day, shift) : tag;
            if (endDay === tag && bisV < vonV) {
              f.bis.focus();
              return 'Das Ende liegt vor dem Beginn.';
            }
            out.end = `${endDay}T${bisV}`;
          } else {
            out.end = null;
          }
        }
        const wahl = f.wdh.value;
        if (!wahl) out.recurrence = null;
        else {
          const basis = wahl === 'bisher' ? { ...rec } : { ...REC_PRESETS.find(([id]) => id === wahl)[2] };
          const r = { freq: basis.freq, interval: basis.interval || 1 };
          if (basis.freq === 'weekly') r.byDay = Array.isArray(basis.byDay) ? [...basis.byDay] : [];
          r.until = f.bisTag.value && DATE_RE.test(f.bisTag.value) ? f.bisTag.value : null;
          r.count = wahl === 'bisher' ? rec.count || null : null;
          if (r.until && r.until < tag) {
            f.bisTag.focus();
            return 'Die Serie endet vor ihrem ersten Termin.';
          }
          out.recurrence = r;
        }
        out.reminder = f.erinnerung.value === '' ? null : Number(f.erinnerung.value);
        return out;
      }

      async function speichern(input, wahl) {
        let res2;
        let zurueck;
        let ziel;
        if (!record) {
          if (!input.recurrence) delete input.recurrence;
          if (input.reminder === null) delete input.reminder;
          res2 = await api.post('/events', input);
          const id = res2.record.id;
          zurueck = () => api.del(`/events/${encodeURIComponent(id)}`);
          ziel = { id, occurrence: input.recurrence ? input.start.slice(0, 10) : null };
          toast(`„${res2.record.data.title}“ eingetragen.`, 'success', { action: { label: 'Rückgängig', run: () => rueckgaengig(res2, zurueck) }, timeout: 9000 });
        } else {
          const pfad = `/events/${encodeURIComponent(record.id)}`;
          if (serienEdit && wahl === 'nur') {
            const { recurrence, ...ohne } = input;
            const altAus = Array.isArray(serie.exdates) ? serie.exdates : [];
            res2 = await api.patch(pfad, ohne, { query: nurDieses(e) });
            const neuId = res2.record && res2.record.id;
            zurueck = async () => {
              if (neuId && neuId !== record.id) await api.del(`/events/${encodeURIComponent(neuId)}`);
              await api.patch(pfad, { exdates: altAus });
            };
            ziel = { id: neuId || record.id, occurrence: null };
          } else {
            const patch = { ...input };
            if (serienEdit) {
              // Tag oder Uhrzeit am Vorkommen geaendert: dieselbe Verschiebung fuer die ganze Serie.
              const alt = { start: alsWand(data.start), end: data.end ? alsWand(data.end) : null };
              const sp = serienPatch(serie, alt, { start: input.start, end: input.end });
              patch.start = sp.start;
              patch.end = sp.end;
              if (f.wdh.value === 'bisher' && sp.recurrence) patch.recurrence = { ...sp.recurrence, until: input.recurrence ? input.recurrence.until : null };
              if (sp.exdates) patch.exdates = sp.exdates;
            }
            const vorher = {};
            for (const key of Object.keys(patch)) vorher[key] = serie[key] === undefined ? null : serie[key];
            res2 = await api.patch(pfad, patch);
            zurueck = () => api.patch(pfad, vorher);
            ziel = { id: record.id, occurrence: serienEdit && e.occurrence ? addDays(e.occurrence, versatzTage(patch)) : null };
          }
          toast(wahl === 'nur' ? 'Nur dieser Termin geändert.' : 'Termin gespeichert.', 'success', {
            action: { label: 'Rückgängig', run: () => rueckgaengig(res2, zurueck) },
            timeout: 9000,
          });
        }
        if (!st.alive) return;
        await load();
        await openDetail(ziel);
      }

      /** Um wie viele Tage die ganze Serie gewandert ist -- das Vorkommen wandert mit. */
      function versatzTage(patch) {
        return patch.start && serie.start ? tageZwischen(String(alsWand(serie.start)).slice(0, 10), String(patch.start).slice(0, 10)) : 0;
      }

      const oeffner = (st.sheet && st.sheet.oeffner) || (e ? e.key : null);
      st.sheet = { kind: record ? 'bearbeiten' : 'neu', id: record ? record.id : null, key: e ? e.key : null, oeffner };
      showSheet(record ? 'Termin bearbeiten' : 'Neuer Termin', form);
      if (!coarse) f.title.focus();
      else if (!record) f.title.focus();
    }

    /* ---------------- Wischen, Tasten ---------------- */

    // Wischen links/rechts auf dem iPad: vor/zurueck. Nur Finger, nur quer
    // genug, nur wenn gerade nichts gezogen wird.
    let wisch = null;
    body.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType !== 'touch' || st.mode === 'liste') return;
      if (ev.target.closest('.kal__sheet, .kal__frage, input, select, textarea')) return;
      wisch = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: Date.now(), gezogen: false };
    });
    const wischEnde = (ev) => {
      if (!wisch || ev.pointerId !== wisch.id) return;
      const w = wisch;
      wisch = null;
      if (w.gezogen || drag) return;
      const dx = ev.clientX - w.x;
      const dy = ev.clientY - w.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 1.6 * Math.abs(dy) && Date.now() - w.t < 800) {
        klickSchlucken = true;
        setTimeout(() => { klickSchlucken = false; }, 350);
        // Erst nach dem Ereignis blaettern: pointerup kommt VOR touchend. Wird
        // der Finger-Ort jetzt neu gezeichnet, geht touchend an ein Element,
        // das es nicht mehr gibt (gemessen in Chromium: touchend kam nie an),
        // und der Browser haelt die Beruehrung womoeglich fuer nicht beendet.
        setTimeout(() => move(dx < 0 ? 1 : -1), 0);
      }
    };
    const wischZiehen = () => { if (wisch && drag && drag.active) wisch.gezogen = true; };
    window.addEventListener('pointerup', wischEnde);
    window.addEventListener('pointermove', wischZiehen);
    cleanups.push(() => window.removeEventListener('pointerup', wischEnde));
    cleanups.push(() => window.removeEventListener('pointermove', wischZiehen));
    // Ein Wisch oder ein Ziehen, das auf einem Termin endet, ist kein Tipp auf
    // ihn. Abgefangen in der Einfangphase, bevor der Termin den Klick sieht.
    root.addEventListener('click', (ev) => {
      if (!klickSchlucken || drag) return;
      klickSchlucken = false;
      ev.preventDefault();
      ev.stopPropagation();
    }, true);

    const onKey = (event) => {
      if (event.key === 'Escape') {
        if (drag) {
          event.preventDefault();
          abbrechen();
          render();
        } else if (dom.frage) {
          event.preventDefault();
          schliesseFrage(null);
        } else if (dom.sheet && !event.defaultPrevented && !document.querySelector('.dialog')) {
          event.preventDefault();
          closeSheet();
        }
        return;
      }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || document.querySelector('.dialog, .palette')) return;
      const imMonat = event.target && event.target.closest && event.target.closest('.kal__weeks, .kal__mini-grid');
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === 't') goToday();
      else if (key === 'ArrowLeft' && !imMonat) move(-1);
      else if (key === 'ArrowRight' && !imMonat) move(1);
      else if (key === 'n') quick.input.focus();
      else if (key === 'd') setMode('tag');
      else if (key === 'w') setMode('woche');
      else if (key === 'm') setMode('monat');
      else if (key === 'l') setMode('liste');
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));

    /* ---------------- Live und Aufraeumen ---------------- */

    const isEvent = (payload) => payload && (payload.type === 'event' || (payload.record && payload.record.type === 'event'));
    for (const name of ['record.created', 'record.updated', 'record.deleted']) {
      cleanups.push(bus.on(name, (payload) => {
        if (!isEvent(payload)) return;
        reloadSoon();
        if (st.sheet && st.sheet.kind === 'detail' && st.sheet.id === payload.id) {
          if (name === 'record.deleted') closeSheet();
          else openDetail({ id: payload.id, occurrence: st.sheet.occurrence }, { fromRoute: true });
        }
      }));
    }

    // Die Jetzt-Linie wandert, und um Mitternacht wird aus "heute" "gestern".
    let lastDay = today();
    const tick = setInterval(() => {
      if (drag || dom.frage) return;
      if (lastDay !== today()) {
        lastDay = today();
        render();
        return;
      }
      const now = new Date();
      const min = now.getHours() * 60 + now.getMinutes();
      for (const line of body.querySelectorAll('.kal__now, .kal__rjetzt')) line.style.top = `${(min / 60) * HOUR}px`;
      const label = body.querySelector('.kal__rjetzt');
      if (label) {
        setText(label, minZuHm(min));
        stundenFreiraeumen(label.parentNode, min);
      }
    }, 30000);
    cleanups.push(() => clearInterval(tick));
    cleanups.push(() => clearTimeout(reloadTimer));
    cleanups.push(() => clearTimeout(konfliktTimer));
    cleanups.push(() => { if (drag) abbrechen(); });
    cleanups.push(() => document.body.classList.remove('kal-zieht'));

    this._cleanup = () => {
      st.alive = false;
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* weiter aufraeumen */ }
      }
    };

    render();
    await load();
    const params = ctx.route && ctx.route.params ? ctx.route.params : {};
    if (params.id) await openDetail({ id: params.id, occurrence: DATE_RE.test(params.am || '') ? params.am : null }, { fromRoute: true });
  },

  async unmount() {
    if (typeof this._cleanup === 'function') this._cleanup();
    this._cleanup = null;
  },
};
