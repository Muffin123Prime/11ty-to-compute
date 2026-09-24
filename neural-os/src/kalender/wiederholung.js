'use strict';

/**
 * Wiederkehrende Termine -- die EINE Stelle, an der ausgerechnet wird, wann
 * eine Serie stattfindet.
 *
 * Die Route (src/http/api/events.js), die Werkzeuge der KI
 * (src/models/werkzeuge.js) und die Kalenderdatei (src/kalender/ics.js)
 * benutzen alle diese Funktionen. Zwei Rechnungen fuer dieselbe Frage
 * ("ist am 27. Oktober Training?") gehen irgendwann auseinander, und dann
 * sagt die KI etwas anderes als der Kalender.
 *
 * Warum hier nur mit TAGEN gerechnet wird, nie mit Millisekunden
 * --------------------------------------------------------------
 * Termine stehen in Wandzeit ohne Versatz ("2026-10-20T18:00" = 18 Uhr vor
 * Ort, was immer die Uhr gerade fuer eine Zone hat). Eine Woche spaeter ist
 * "sieben Kalendertage spaeter, dieselbe Uhrzeit" -- nicht "+7 x 24 Stunden".
 * Am 25.10.2026 wird die Uhr zurueckgestellt; wer +604 800 000 ms rechnet,
 * findet das Training am 27.10. um 17:00 statt um 18:00. Deshalb ist ein Tag
 * hier eine ganze Zahl (Tage seit 1970-01-01 im Kalender, ueber Date.UTC
 * gebildet, also ohne jede Ortszone), und die Uhrzeit wird als Text
 * unveraendert an das neue Datum gehaengt.
 *
 * Die Regeln folgen RFC 5545 (iCalendar), damit dieselbe Serie auf dem iPad
 * genauso aussieht wie hier:
 *   - Woechentlich ohne Wochentage = der Wochentag des Beginns; Wochen
 *     beginnen am Montag (WKST=MO, die Vorgabe der Norm).
 *   - Monatlich am 31.: in Monaten ohne 31. faellt der Termin AUS. Er wird
 *     nicht auf den 30. geschoben -- das taete die iPad-Kalender-App auch
 *     nicht, und dann stuenden beide Kalender verschieden da.
 *   - Jaehrlich am 29.02.: nur in Schaltjahren.
 *   - `count` zaehlt ALLE erzeugten Vorkommen, auch ausgelassene (EXDATE
 *     nimmt erst danach heraus). So zaehlt die Norm, und so zaehlt das iPad.
 *   - `until` ist ein Tag und gehoert dazu (einschliesslich).
 */

const { ValidationError } = require('../kernel/errors');

/** Die Rhythmen, wie sie gespeichert werden (Vertrag A). */
const RHYTHMEN = Object.freeze(['daily', 'weekly', 'monthly', 'yearly']);
/** Wochentage in Normreihenfolge, Montag zuerst (Index 0). */
const WOCHENTAGE = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
/** Erlaubte Erinnerungen in Minuten vor Beginn (Vertrag A). */
const ERINNERUNGEN = Object.freeze([0, 5, 10, 15, 30, 60, 120, 1440]);

const MAX_INTERVALL = 99;
const MAX_ANZAHL = 999;
/** Mehr ausgelassene Tage traegt keine sinnvolle Serie; eine Grenze haelt den Satz klein. */
const MAX_AUSNAHMEN = 1000;
/**
 * Wie weit `naechstesVorkommen` hoechstens sucht. Hundert Jahre reichen auch
 * fuer "alle 99 Jahre", ohne dass eine kaputte Regel eine Endlosschleife wird.
 */
const HORIZONT_TAGE = 366 * 100;

const TAG_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZEIT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const MIT_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/;

const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------------ Tage */

function istSchaltjahr(j) {
  return (j % 4 === 0 && j % 100 !== 0) || j % 400 === 0;
}

function tageImMonat(j, m) {
  return [31, istSchaltjahr(j) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Gibt es diesen Tag? 'YYYY-MM-DD' -> boolean. */
function gueltigerTag(text) {
  if (typeof text !== 'string') return false;
  const m = TAG_RE.exec(text);
  if (!m) return false;
  const [j, mo, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return j >= 1 && mo >= 1 && mo <= 12 && t >= 1 && t <= tageImMonat(j, mo);
}

/** 'YYYY-MM-DD' -> Tageszahl (Tage seit 1970-01-01, ohne Zeitzone). */
function tagZahl(text) {
  const [j, m, t] = text.split('-').map(Number);
  return Math.round(Date.UTC(j, m - 1, t) / 86400000);
}

function zahlAusTeilen(j, m, t) {
  return Math.round(Date.UTC(j, m - 1, t) / 86400000);
}

/** Tageszahl -> 'YYYY-MM-DD'. */
function tagText(zahl) {
  const d = new Date(zahl * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function plusTage(tag, n) {
  return tagText(tagZahl(tag) + n);
}

function tageZwischen(a, b) {
  return tagZahl(b) - tagZahl(a);
}

/** Index 0 = Montag ... 6 = Sonntag. */
function wochentagIndex(zahl) {
  // 1970-01-01 war ein Donnerstag (Index 3).
  return (((zahl + 3) % 7) + 7) % 7;
}

/** 'YYYY-MM-DD' -> 'MO' ... 'SU'. */
function wochentag(tag) {
  return WOCHENTAGE[wochentagIndex(tagZahl(tag))];
}

/* ------------------------------------------------------- Zeitangaben */

/**
 * Den Tag einer Zeitangabe lesen, die in einer Serie stehen darf: reiner Tag
 * oder Wandzeit OHNE Versatz. Eine Angabe mit Zone ("…Z", "+02:00") ist ein
 * fester Zeitpunkt; ihn woechentlich zu wiederholen hiesse, die Wandzeit bei
 * jeder Zeitumstellung zu verschieben. Das ist nie gemeint.
 *
 * @returns {{tag:string, zeit:string}|null}  zeit = '' oder 'THH:MM[:SS]'
 */
function wandzeitLesen(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (TAG_RE.test(s)) return gueltigerTag(s) ? { tag: s, zeit: '' } : null;
  const m = ZEIT_RE.exec(s);
  if (!m) return null;
  const tag = `${m[1]}-${m[2]}-${m[3]}`;
  if (!gueltigerTag(tag) || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] || 0) > 59) return null;
  return { tag, zeit: s.slice(10) };
}

function hatZone(text) {
  return typeof text === 'string' && MIT_ZONE_RE.test(text.trim()) && text.includes('T');
}

/**
 * Wie viele Tage ein Vorkommen nach seinem ersten Tag noch belegt.
 * Dieselbe Regel wie im Kalender: ein ganztaegiges Ende zaehlt mit ("vom 3.
 * bis 5." = drei Tage), ein Ende genau um Mitternacht belegt den Folgetag
 * nicht.
 */
function spanneTage(daten) {
  const start = wandzeitLesen(daten && daten.start);
  const ende = wandzeitLesen(daten && daten.end);
  if (!start || !ende) return 0;
  let n = tageZwischen(start.tag, ende.tag);
  if (n < 0) return 0;
  const mitternacht = /^T00:00(?::00)?$/.test(ende.zeit);
  if (ende.zeit && mitternacht && n > 0) n -= 1;
  return n;
}

/* ---------------------------------------------------------- Pruefen */

function ganzzahl(wert) {
  return typeof wert === 'number' && Number.isInteger(wert);
}

const REGEL_FELDER = new Set(['freq', 'interval', 'byDay', 'until', 'count']);

/**
 * Eine Wiederholungsregel streng pruefen und in die gespeicherte Form bringen.
 *
 * Streng heisst: unbekannte Felder, falsche Typen und unmoegliche Werte werden
 * abgelehnt -- mit einem Satz, der sagt, was falsch ist. Eine Serie, die
 * still etwas anderes tut als gemeint ("bis 31.02." wird zu "bis 03.03."),
 * faellt erst Wochen spaeter auf.
 *
 * @param {*} regel         das Feld `recurrence` (null/undefined = keine Serie)
 * @param {string} startTag der erste Tag der Serie
 * @returns {null|{freq:string, interval:number, byDay:string[], until:string|null, count:number|null}}
 */
function regelPruefen(regel, startTag) {
  if (regel === null || regel === undefined) return null;
  if (typeof regel !== 'object' || Array.isArray(regel)) {
    throw new ValidationError('"recurrence" muss ein Objekt oder null sein.');
  }
  for (const key of Object.keys(regel)) {
    if (!REGEL_FELDER.has(key)) throw new ValidationError(`"recurrence" kennt das Feld "${key}" nicht.`);
  }
  if (!RHYTHMEN.includes(regel.freq)) {
    throw new ValidationError(`"recurrence.freq" muss eines von ${RHYTHMEN.join(', ')} sein.`);
  }
  let interval = 1;
  if (regel.interval !== undefined && regel.interval !== null) {
    if (!ganzzahl(regel.interval) || regel.interval < 1 || regel.interval > MAX_INTERVALL) {
      throw new ValidationError(`"recurrence.interval" muss eine ganze Zahl von 1 bis ${MAX_INTERVALL} sein.`);
    }
    interval = regel.interval;
  }
  let byDay = [];
  if (regel.byDay !== undefined && regel.byDay !== null) {
    if (!Array.isArray(regel.byDay) || regel.byDay.some((t) => !WOCHENTAGE.includes(t))) {
      throw new ValidationError(`"recurrence.byDay" ist eine Liste aus ${WOCHENTAGE.join(', ')}.`);
    }
    if (new Set(regel.byDay).size !== regel.byDay.length) {
      throw new ValidationError('"recurrence.byDay" nennt einen Wochentag doppelt.');
    }
    if (regel.byDay.length && regel.freq !== 'weekly') {
      throw new ValidationError('Wochentage ("byDay") gibt es nur bei wöchentlichen Serien.');
    }
    byDay = WOCHENTAGE.filter((t) => regel.byDay.includes(t));
  }
  let until = null;
  if (regel.until !== undefined && regel.until !== null) {
    if (!gueltigerTag(regel.until)) {
      throw new ValidationError(`"recurrence.until" muss ein Tag der Form JJJJ-MM-TT sein (empfangen: ${String(regel.until)}).`);
    }
    if (startTag && regel.until < startTag) throw new ValidationError('Die Serie endet ("until"), bevor sie beginnt.');
    until = regel.until;
  }
  let count = null;
  if (regel.count !== undefined && regel.count !== null) {
    if (!ganzzahl(regel.count) || regel.count < 1 || regel.count > MAX_ANZAHL) {
      throw new ValidationError(`"recurrence.count" muss eine ganze Zahl von 1 bis ${MAX_ANZAHL} sein.`);
    }
    count = regel.count;
  }
  // RFC 5545: UNTIL und COUNT schliessen sich aus. Beides zu nehmen hiesse zu
  // raten, welches gewinnt -- und das iPad raete womoeglich anders.
  if (until && count) throw new ValidationError('Eine Serie endet entweder an einem Tag ("until") oder nach einer Anzahl ("count"), nicht beides.');
  return { freq: regel.freq, interval, byDay, until, count };
}

/** Ausgelassene Vorkommen: gueltige Tage, sortiert, ohne Doppelte. */
function ausnahmenPruefen(liste) {
  if (liste === undefined || liste === null) return [];
  if (!Array.isArray(liste)) throw new ValidationError('"exdates" muss eine Liste von Tagen (JJJJ-MM-TT) sein.');
  for (const tag of liste) {
    if (!gueltigerTag(tag)) throw new ValidationError(`"exdates" enthält "${String(tag)}" – das ist kein Tag der Form JJJJ-MM-TT.`);
  }
  const out = [...new Set(liste)].sort();
  if (out.length > MAX_AUSNAHMEN) throw new ValidationError(`Höchstens ${MAX_AUSNAHMEN} ausgelassene Tage je Serie.`);
  return out;
}

/** Erinnerung: null oder eine der erlaubten Minutenzahlen. */
function erinnerungPruefen(wert) {
  if (wert === undefined || wert === null) return null;
  if (!ERINNERUNGEN.includes(wert)) {
    throw new ValidationError(`"reminder" muss eine dieser Minutenzahlen sein: ${ERINNERUNGEN.join(', ')} – oder null.`);
  }
  return wert;
}

/* ------------------------------------------------------- Erzeugen */

/**
 * Die Vorkommen einer Regel als aufsteigende Tageszahlen, VOR dem Auslassen.
 *
 * `abZahl` ist nur eine Abkuerzung: ohne `count` duerfen taegliche und
 * woechentliche Serien die Zeit vor dem gefragten Zeitraum ueberspringen
 * (eine taegliche Serie seit 1990 soll nicht 13 000 Tage durchzaehlen, um den
 * heutigen zu finden). Mit `count` muss von vorn gezaehlt werden -- das ist
 * durch MAX_ANZAHL begrenzt. Der Aufrufer bricht ab, sobald er genug hat;
 * `until` und `count` beenden die Folge von selbst.
 */
function* erzeugen(startTag, rohRegel, abZahl = -Infinity) {
  // Nur mit einer geprueften Regel rechnen. Ein Satz, der an checkEvent
  // vorbei geschrieben wurde (Abgleich, Module, ein alter Stand), kann
  // interval -1 oder byDay 'MO' tragen -- mit -1 fuehrte die Schleife nie
  // ueber `bis` hinaus und legte den ganzen Server lahm, nicht nur diesen Termin.
  const regel = regelLesen(rohRegel);
  if (!regel || !gueltigerTag(startTag)) return;
  const s = tagZahl(startTag);
  const bis = regel.until ? tagZahl(regel.until) : Infinity;
  const grenze = regel.count || Infinity;
  const iv = regel.interval || 1;
  let n = 0;

  if (regel.freq === 'daily') {
    let k = 0;
    if (!regel.count && abZahl > s) k = Math.floor((abZahl - s) / iv);
    for (;; k++) {
      const d = s + k * iv;
      if (d > bis || n >= grenze) return;
      n += 1;
      yield d;
    }
  }

  if (regel.freq === 'weekly') {
    const tage = regel.byDay && regel.byDay.length
      ? regel.byDay.map((t) => WOCHENTAGE.indexOf(t)).sort((a, b) => a - b)
      : [wochentagIndex(s)];
    const wocheStart = s - wochentagIndex(s);
    let k = 0;
    if (!regel.count && abZahl > s) k = Math.max(0, Math.floor((abZahl - wocheStart) / (7 * iv)) - 1);
    for (;; k++) {
      const montag = wocheStart + k * 7 * iv;
      if (montag > bis) return;
      for (const i of tage) {
        const d = montag + i;
        if (d < s) continue; // die Tage der ersten Woche vor dem Beginn
        if (d > bis || n >= grenze) return;
        n += 1;
        yield d;
      }
    }
  }

  const [j0, m0, t0] = startTag.split('-').map(Number);

  if (regel.freq === 'monthly') {
    for (let k = 0; ; k++) {
      const monate = (m0 - 1) + k * iv;
      const j = j0 + Math.floor(monate / 12);
      const m = (monate % 12) + 1;
      if (j > 9999 || zahlAusTeilen(j, m, 1) > bis) return;
      if (t0 > tageImMonat(j, m)) continue; // kein 31. in diesem Monat: faellt aus
      const d = zahlAusTeilen(j, m, t0);
      if (d > bis || n >= grenze) return;
      n += 1;
      yield d;
    }
  }

  if (regel.freq === 'yearly') {
    for (let k = 0; ; k++) {
      const j = j0 + k * iv;
      if (j > 9999 || zahlAusTeilen(j, 1, 1) > bis) return;
      if (t0 > tageImMonat(j, m0)) continue; // 29.02. ausserhalb der Schaltjahre
      const d = zahlAusTeilen(j, m0, t0);
      if (d > bis || n >= grenze) return;
      n += 1;
      yield d;
    }
  }
}

/**
 * Eine gespeicherte Regel lesen, ohne zu werfen: die bereinigte Regel, oder
 * null, wenn sie nicht gilt. Fuer alles, was LIEST (Zeitraum, Kalenderdatei,
 * Ueberschneidungen) -- dort soll ein kaputter Satz hoechstens selbst als
 * Einzeltermin erscheinen, statt jede Anfrage mit einem 500 zu beenden.
 * Das Ende vor dem Beginn wird hier nicht geprueft (der Beginn ist nicht
 * bekannt); so eine Serie erzeugt schlicht nichts.
 */
function regelLesen(regel) {
  if (regel === null || regel === undefined) return null;
  try {
    return regelPruefen(regel, null);
  } catch {
    return null;
  }
}

/** Ist dieser Termin eine Serie (mit GUELTIGER Regel und Wandzeit)? */
function istSerie(daten) {
  return !!(daten && regelLesen(daten.recurrence) && wandzeitLesen(daten.start));
}

/**
 * Die Tage, an denen eine Serie den Zeitraum [von, bis] beruehrt -- jeweils
 * der ERSTE Tag des Vorkommens. Ein Vorkommen, das am Vortag beginnt und in
 * den Zeitraum hineinreicht, gehoert dazu (wie beim Einzeltermin).
 *
 * @param {object} daten  die Felder des Termins (start, end, recurrence, exdates)
 * @param {string} von    'YYYY-MM-DD'
 * @param {string} bis    'YYYY-MM-DD'
 * @param {{max?:number}} [opts]  hoechstens so viele (+1, damit der Aufrufer "zu viele" erkennt)
 * @returns {string[]}
 */
function vorkommenImZeitraum(daten, von, bis, { max = Infinity } = {}) {
  if (!istSerie(daten)) return [];
  const startTag = wandzeitLesen(daten.start).tag;
  const spanne = spanneTage(daten);
  const ab = tagZahl(von) - spanne;
  const ende = tagZahl(bis);
  const aus = new Set(Array.isArray(daten.exdates) ? daten.exdates : []);
  const out = [];
  for (const d of erzeugen(startTag, daten.recurrence, ab)) {
    if (d > ende) break;
    if (d < ab) continue;
    const tag = tagText(d);
    if (aus.has(tag)) continue;
    out.push(tag);
    if (out.length > max) break;
  }
  return out;
}

/** Findet die Serie an diesem Tag statt (beginnt dort ein Vorkommen)? */
function istVorkommen(daten, tag) {
  if (!gueltigerTag(tag)) return false;
  return vorkommenImZeitraum(daten, tag, tag).includes(tag);
}

/**
 * Das erste Vorkommen, das am Tag `abTag` noch nicht vorbei ist, oder null.
 * Fuer "naechster Termin" eines Projekts und fuer Rueckmeldungen an die KI.
 */
function naechstesVorkommen(daten, abTag) {
  if (!istSerie(daten)) return null;
  const startTag = wandzeitLesen(daten.start).tag;
  const spanne = spanneTage(daten);
  const ab = tagZahl(abTag) - spanne;
  const horizont = tagZahl(abTag) + HORIZONT_TAGE;
  const aus = new Set(Array.isArray(daten.exdates) ? daten.exdates : []);
  for (const d of erzeugen(startTag, daten.recurrence, ab)) {
    if (d > horizont) return null;
    if (d < ab) continue;
    const tag = tagText(d);
    if (!aus.has(tag)) return tag;
  }
  return null;
}

/**
 * Beginn und Ende einer Serie auf ein Vorkommen legen: das Datum wandert, die
 * Uhrzeit bleibt als Text, wie sie ist (Wandzeit, siehe oben). Ein Ende an
 * einem spaeteren Tag wandert um dieselbe Anzahl Tage mit.
 */
function aufTagLegen(daten, tag) {
  const start = wandzeitLesen(daten.start);
  if (!start) return { start: daten.start, end: daten.end || null };
  const delta = tageZwischen(start.tag, tag);
  const out = { start: `${tag}${start.zeit}`, end: null };
  const ende = wandzeitLesen(daten.end);
  if (ende) out.end = `${plusTage(ende.tag, delta)}${ende.zeit}`;
  return out;
}

/**
 * Der erste Tag, den die Regel ueberhaupt erzeugt (VOR dem Auslassen), oder
 * null, wenn sie nie stattfindet (etwa "Montag und Mittwoch" mit einem Ende
 * am Sonntag davor).
 */
function ersterTag(startTag, regel) {
  const r = erzeugen(startTag, regel).next();
  return r.done ? null : tagText(r.value);
}

/**
 * Liegt der Beginn einer Serie auf keinem ihrer Tage ("Werktags" an einem
 * Samstag angelegt, "Montag und Mittwoch" an einem Donnerstag), wird er auf
 * das erste echte Vorkommen gelegt.
 *
 * Warum: RFC 5545 (3.3.10) zaehlt DTSTART IMMER als erstes Vorkommen. Bliebe
 * der Beginn am Samstag stehen, zeigte das iPad nach dem Import einen
 * Samstagstermin, den Neural OS nicht zeigt, und die KI bestaetigte dem
 * Nutzer einen Tag, an dem nichts im Kalender steht. Die Menge der
 * Vorkommen aendert sich dadurch nicht (auch nicht bei `count`): der
 * falsche Beginn wurde nie erzeugt.
 *
 * @returns {{start:string, end:string|null}|null}  null = der Beginn stimmt schon
 */
function beginnAufVorkommen(daten) {
  const s = wandzeitLesen(daten && daten.start);
  if (!s || !daten.recurrence) return null;
  const erster = ersterTag(s.tag, daten.recurrence);
  if (!erster || erster === s.tag) return null;
  return aufTagLegen(daten, erster);
}

/** Wochentage um `tage` weiterdrehen, in Normreihenfolge. */
function wochentageDrehen(byDay, tage) {
  const shift = ((tage % 7) + 7) % 7;
  const gedreht = new Set(byDay.map((t) => WOCHENTAGE[(WOCHENTAGE.indexOf(t) + shift) % 7]));
  return WOCHENTAGE.filter((t) => gedreht.has(t));
}

/**
 * Die GANZE Serie so verschieben, wie ein Vorkommen verschoben wurde.
 *
 * "Das Training ist ab jetzt um 19 Uhr": die KI kennt aus termine_lesen nur
 * das Vorkommen vom 29.09. und schickt dessen neue Zeit. Wuerde diese Zeit
 * zum neuen BEGINN der Serie, verschwaenden alle frueheren Vorkommen, und
 * eine Serie mit fester Anzahl liefe laenger. Stattdessen wird die Serie um
 * denselben Abstand verschoben -- Beginn, Anzahl und Ende bleiben, nur die
 * Lage aendert sich. Dieselbe Rechnung wie "Alle" beim Ziehen in der
 * Kalenderansicht (serienPatch in web/views/kalender.js).
 *
 * Gerechnet wird mit Tagen und Uhrzeit-Text, nicht mit Millisekunden: ein
 * Vorkommen nach der Zeitumstellung verschiebt die Serie trotzdem um genau
 * eine Stunde Wandzeit.
 *
 * @param {object} daten     die Serie
 * @param {string} bezugTag  der Tag des Vorkommens, auf das sich `neu` bezieht
 * @param {{start:string, end?:string|null}} neu  neue Lage DIESES Vorkommens
 *   (`end` weggelassen = die Serie behaelt ihr Ende unveraendert)
 * @returns {{start:string, end?:string|null, recurrence?:object, exdates?:string[]}}
 */
function serieVerschieben(daten, bezugTag, neu) {
  const s0 = wandzeitLesen(daten.start);
  const offset = tageZwischen(bezugTag, s0.tag);
  const schieben = (text) => {
    if (text === null || text === undefined) return text;
    const z = wandzeitLesen(text);
    return z ? `${plusTage(z.tag, offset)}${z.zeit}` : text;
  };
  const out = { start: schieben(neu.start) };
  if (neu.end !== undefined) out.end = schieben(neu.end);
  const neuTag = wandzeitLesen(out.start);
  const tage = neuTag ? tageZwischen(s0.tag, neuTag.tag) : 0;
  const regel = daten.recurrence;
  if (tage && regel && typeof regel === 'object') {
    const r = { ...regel };
    if (r.freq === 'weekly' && Array.isArray(r.byDay) && r.byDay.length) r.byDay = wochentageDrehen(r.byDay, tage);
    if (r.until) r.until = plusTage(r.until, tage);
    out.recurrence = r;
    if (Array.isArray(daten.exdates) && daten.exdates.length) out.exdates = daten.exdates.map((d) => plusTage(d, tage));
  }
  return out;
}

/**
 * Eine Serie an einem Vorkommen teilen ("ab jetzt um 19 Uhr"): die alte
 * endet am Vortag, eine neue beginnt an `tag`. Was vorbei ist, bleibt so,
 * wie es war -- der Kalender soll nicht behaupten, das Training im September
 * sei schon um 19 Uhr gewesen.
 *
 * `count` zaehlt nach der Norm auch ausgelassene Vorkommen; die neue Serie
 * bekommt, was von der alten Anzahl noch uebrig ist, damit "zehnmal"
 * insgesamt zehnmal bleibt.
 *
 * @returns {{alt:{recurrence:object, exdates:string[]}, neu:{start:string, end:string|null, recurrence:object, exdates:string[]}}}
 */
function abTagTeilen(daten, tag) {
  const s0 = wandzeitLesen(daten.start).tag;
  const regel = daten.recurrence;
  let vorher = 0;
  if (regel.count) {
    const grenze = tagZahl(tag);
    for (const d of erzeugen(s0, regel)) {
      if (d >= grenze) break;
      vorher += 1;
    }
  }
  const ausnahmen = Array.isArray(daten.exdates) ? daten.exdates : [];
  return {
    alt: {
      recurrence: { ...regel, until: plusTage(tag, -1), count: null },
      exdates: ausnahmen.filter((d) => d < tag),
    },
    neu: {
      ...aufTagLegen(daten, tag),
      recurrence: { ...regel, count: regel.count ? Math.max(1, regel.count - vorher) : null },
      exdates: ausnahmen.filter((d) => d >= tag),
    },
  };
}

/* --------------------------------------------------------- In Worten */

const TAG_LANG = { MO: 'Montag', TU: 'Dienstag', WE: 'Mittwoch', TH: 'Donnerstag', FR: 'Freitag', SA: 'Samstag', SU: 'Sonntag' };
const TAG_KURZ = { MO: 'Mo', TU: 'Di', WE: 'Mi', TH: 'Do', FR: 'Fr', SA: 'Sa', SU: 'So' };

function datumDeutsch(tag) {
  const [j, m, t] = tag.split('-');
  return `${t}.${m}.${j}`;
}

/**
 * Eine Regel als kurzer deutscher Satzteil: "jeden Dienstag bis 24.12.2026",
 * "alle 2 Wochen am Mo, Do", "jeden Monat am 31.", "jedes Jahr am 29.02., 5-mal".
 * Fuer die Rueckmeldung an die KI (sie soll die Serie so bestaetigen, wie sie
 * wirklich gespeichert ist) und fuer die Beschreibung im Kalender.
 */
function inWorten(regel, startTag) {
  if (!regel || !RHYTHMEN.includes(regel.freq)) return '';
  const iv = regel.interval || 1;
  let text;
  if (regel.freq === 'daily') {
    text = iv === 1 ? 'jeden Tag' : `alle ${iv} Tage`;
  } else if (regel.freq === 'weekly') {
    const tage = regel.byDay && regel.byDay.length ? regel.byDay : (startTag ? [wochentag(startTag)] : []);
    if (iv === 1 && tage.length === 1) text = `jeden ${TAG_LANG[tage[0]]}`;
    else text = `${iv === 1 ? 'jede Woche' : `alle ${iv} Wochen`}${tage.length ? ` am ${tage.map((t) => TAG_KURZ[t]).join(', ')}` : ''}`;
  } else if (regel.freq === 'monthly') {
    const t = startTag ? Number(startTag.slice(8, 10)) : null;
    text = `${iv === 1 ? 'jeden Monat' : `alle ${iv} Monate`}${t ? ` am ${t}.` : ''}`;
  } else {
    const tm = startTag ? `${startTag.slice(8, 10)}.${startTag.slice(5, 7)}.` : '';
    text = `${iv === 1 ? 'jedes Jahr' : `alle ${iv} Jahre`}${tm ? ` am ${tm}` : ''}`;
  }
  if (regel.until) text += ` bis ${datumDeutsch(regel.until)}`;
  if (regel.count) text += `, ${regel.count}-mal`;
  return text;
}

module.exports = {
  RHYTHMEN,
  WOCHENTAGE,
  ERINNERUNGEN,
  MAX_INTERVALL,
  MAX_ANZAHL,
  gueltigerTag,
  istSchaltjahr,
  tagZahl,
  tagText,
  plusTage,
  tageZwischen,
  wochentag,
  wandzeitLesen,
  hatZone,
  spanneTage,
  regelPruefen,
  regelLesen,
  ausnahmenPruefen,
  erinnerungPruefen,
  erzeugen,
  istSerie,
  vorkommenImZeitraum,
  istVorkommen,
  naechstesVorkommen,
  aufTagLegen,
  ersterTag,
  beginnAufVorkommen,
  serieVerschieben,
  abTagTeilen,
  inWorten,
  datumDeutsch,
};
