'use strict';

/**
 * Kalender, Notizen, Projekte -- die Routen dieses Bereichs.
 *
 * Termine (Vertrag 3, erweitert um Serien: Vertrag A-E vom 23.09.2026)
 * -------------------
 *   GET    /api/events/zeitraum?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET    /api/events/ueberschneidungen?start=…&end=…[&ohne=<id>]
 *   GET    /api/events/export.ics?from=…&to=…
 *   POST   /api/events
 *   GET    /api/events/:id
 *   GET    /api/events/:id/ics
 *   PATCH  /api/events/:id[?nur=YYYY-MM-DD]
 *   DELETE /api/events/:id[?nur=YYYY-MM-DD]
 *
 * Serien. Ein Termin mit `recurrence` ist eine Serie; gespeichert ist die
 * Regel, nicht jedes Vorkommen. Der Zeitraum liefert JEDES Vorkommen als
 * eigenes Element: dieselbe `id` (die der Serie), `start`/`end` auf den Tag
 * des Vorkommens gelegt, dazu `occurrence: 'YYYY-MM-DD'` und
 * `recurring: true` -- am Element UND in `data`, damit keine Oberflaeche an
 * der falschen Stelle sucht. `serie: {start, end}` nennt Beginn und Ende der
 * Serie selbst: wer die GANZE Serie aendert, schickt diese, nicht die
 * verschobenen (sonst wandert der Anfang der Serie auf das angetippte
 * Vorkommen und alle frueheren verschwinden). Einzeltermine tragen
 * `occurrence: null`, `recurring: false`.
 *
 * `?nur=YYYY-MM-DD` aendert oder loescht genau ein Vorkommen: der Tag
 * wandert in `exdates` der Serie, beim Aendern entsteht ein Einzeltermin mit
 * den neuen Werten (`ausSerie: {id, tag}` sagt, woher er kommt). Beide
 * Schreibvorgaenge sind EINE Gruppe im Aenderungsverlauf -- ein
 * "rueckgaengig" nimmt beide zurueck. Jede schreibende Antwort nennt unter
 * `rueckgaengig` den Verlaufseintrag dafuer (POST /api/history/:seq/undo).
 *
 * Wiederholungen werden in src/kalender/wiederholung.js ausgerechnet -- dort
 * und nur dort, auch fuer die Werkzeuge der KI.
 *
 * Die Liste steht NICHT unter `GET /api/events?from=…&to=…`, wie der Vertrag
 * sie zuerst vorsah: unter genau dieser Adresse laeuft seit jeher der
 * Ereignisstrom der ganzen Oberflaeche (src/http/api/system.js, SSE mit
 * `?since=`). Der Router nimmt die erste passende Route; eine zweite
 * `GET /api/events` wuerde entweder nie erreicht oder den Strom abschneiden,
 * je nach Ladereihenfolge. Deshalb `/zeitraum`: dieselbe Familie, keine
 * Kollision. Eine Termin-Kennung hat immer die Form `event_…`, kann also nie
 * "zeitraum" heissen.
 *
 * Warum Termine eine eigene Route haben und nicht ueber /api/records laufen:
 * `event` ist dort absichtlich nicht anlegbar, und ein Termin braucht Pruefungen,
 * die die allgemeine Route nicht kennt -- ein 31. Februar, ein Ende vor dem
 * Beginn, ein ganztaegiger Termin mit Uhrzeit. Ein Kalender, der so etwas
 * annimmt, zeigt es spaeter an einer Stelle, an der niemand es sucht.
 *
 * Zeitangaben. Drei Formen sind erlaubt und bleiben, wie sie kamen:
 *   "2026-09-24"               ganztaegig (dann allDay: true)
 *   "2026-09-24T10:00"         Uhrzeit vor Ort, ohne Zone -- so sagt man es:
 *                              "um zehn", egal wo der Stick gerade steckt
 *   "2026-09-24T08:00:00Z"     ein fester Zeitpunkt (mit Zone)
 * Fuer den Zeitraum und die Sortierung wird alles in die Ortszeit DIESES
 * Rechners gelegt; der Browser tut dasselbe mit seiner. Bei einem ganztaegigen
 * Termin ist `end` der letzte Tag (einschliesslich) -- "vom 3. bis 5." heisst
 * drei Tage, nicht zwei.
 *
 * Notizen und Projekte
 * --------------------
 *   GET /api/notizen[?quelle=auto|hand&limit=&sort=wand|neu]
 *   GET /api/projekte
 *   GET /api/projekte/:id
 *
 * Beide lesen nur. Geaendert wird ueber /api/records (anheften, loeschen,
 * bearbeiten). Es gibt sie, weil die Herkunft ("aus dem Chat „…“") und das,
 * was zu einem Projekt gehoert, an einer Stelle berechnet werden sollen und
 * nicht in jeder Ansicht und jeder Kachel ein bisschen anders.
 */

const { NeuralError, ValidationError } = require('../../kernel/errors');
const {
  need,
  asObject,
  intParam,
  strParam,
} = require('./support');
const w = require('../../kalender/wiederholung');
const ics = require('../../kalender/ics');
const { gemeinsam } = require('../../store/history');

/* ------------------------------------------------------------------ */
/* Zeit                                                                */
/* ------------------------------------------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const ZONED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Der laengste Zeitraum, den eine Anfrage abdeckt: gut ein Jahr. */
const MAX_RANGE_DAYS = 400;
/**
 * Hoechstens so viele Termine (Vorkommen mitgezaehlt) je Anfrage. Eine
 * taegliche Serie ueber 400 Tage sind schon 400; fuenf davon sind eine Liste,
 * die keine Ansicht mehr sinnvoll zeigt. Lieber ein Satz als eine Antwort, an
 * der der Browser erstickt.
 */
const MAX_VORKOMMEN = 2000;
/**
 * Ein Termin ohne Ende zaehlt fuer Ueberschneidungen wie eine Stunde -- so
 * zeichnet ihn auch die Wochenansicht. Als Punkt ohne Dauer ueberschnitte
 * "10 Uhr Zahnarzt" nie etwas, auch nicht "10 bis 11 Uhr Training".
 */
const OHNE_ENDE_MS = 60 * 60000;

const pad = (n) => String(n).padStart(2, '0');

function dayString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Gibt es diesen Tag wirklich? Der 31. Februar wird hier zum Fehler. */
function validDay(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * Eine Zeitangabe lesen.
 *
 * @returns {{kind:'date'|'local'|'zoned', day:string, ms:number, midnight:boolean}|null}
 *   `ms` ist der Zeitpunkt in der Ortszeit dieses Rechners, `day` sein Tag,
 *   `midnight` sagt, ob die Uhrzeit genau 00:00 ist (fuer das Ende eines
 *   Termins, der um Mitternacht endet und damit den Folgetag nicht belegt).
 */
function parseWhen(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = DATE_RE.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDay(y, mo, d)) return null;
    return { kind: 'date', day: s, ms: new Date(y, mo - 1, d).getTime(), midnight: true, wand: `${s}T00:00:00` };
  }
  m = LOCAL_RE.exec(s);
  if (m) {
    const [y, mo, d, hh, mi, ss] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)];
    if (!validDay(y, mo, d) || hh > 23 || mi > 59 || ss > 59) return null;
    return {
      kind: 'local',
      day: `${m[1]}-${m[2]}-${m[3]}`,
      ms: new Date(y, mo - 1, d, hh, mi, ss).getTime(),
      midnight: hh === 0 && mi === 0 && ss === 0,
      // Die Wandzeit als vergleichbarer Text. `ms` taugt dafuer nicht: am
      // 29.03. gibt es 02:00-02:59 in Berlin nicht, `new Date` macht daraus
      // 03:xx -- und 02:45 laege dann NACH 03:00.
      wand: `${m[1]}-${m[2]}-${m[3]}T${pad(hh)}:${pad(mi)}:${pad(ss)}`,
    };
  }
  m = ZONED_RE.exec(s);
  if (m) {
    const [y, mo, d, hh, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    if (!validDay(y, mo, d) || hh > 23 || mi > 59) return null;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    const local = new Date(ms);
    return {
      kind: 'zoned',
      day: dayString(local),
      ms,
      midnight: local.getHours() === 0 && local.getMinutes() === 0 && local.getSeconds() === 0,
    };
  }
  return null;
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayString(new Date(y, m - 1, d + n));
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/**
 * Liegt `b` vor `a`? Zwei Wandzeiten werden als Wandzeit verglichen (siehe
 * `wand` oben), sonst als Zeitpunkt.
 */
function liegtVor(b, a) {
  if (a.wand && b.wand) return b.wand < a.wand;
  return b.ms < a.ms;
}

/**
 * Welche Tage ein Termin belegt, beide Grenzen eingeschlossen. Ein Termin,
 * der um Mitternacht endet, belegt den Folgetag nicht.
 */
function spanOf(data) {
  const start = parseWhen(data && data.start);
  if (!start) return null;
  const end = parseWhen(data && data.end);
  let lastDay = start.day;
  if (end && end.ms >= start.ms) {
    lastDay = end.day;
    if (end.kind !== 'date' && end.midnight && end.day > start.day) lastDay = addDays(end.day, -1);
  }
  return { firstDay: start.day, lastDay, startMs: start.ms, endMs: end ? end.ms : null };
}

/* ------------------------------------------------------------------ */
/* Termine pruefen und anlegen                                         */
/* ------------------------------------------------------------------ */

const EVENT_FIELDS = ['title', 'start', 'end', 'allDay', 'location', 'body', 'projectId', 'chatId', 'source', 'recurrence', 'exdates', 'reminder'];

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function notFound(message) {
  return new NeuralError('NOT_FOUND', message, { status: 404 });
}

function liveOfType(store, id, type) {
  if (typeof id !== 'string' || !id) return null;
  const record = store.get(id);
  return record && record.type === type ? record : null;
}

/** Aus `{data:{…}}` oder einem flachen Objekt nur die bekannten Felder. */
function eventInput(body) {
  const source = body && Object.prototype.hasOwnProperty.call(body, 'data') ? asObject(body.data, 'Das Feld "data"') : body;
  const out = {};
  for (const key of EVENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Prueft einen Termin als Ganzes (nach dem Zusammenfuehren mit dem Bestand
 * bei einer Aenderung) und gibt die bereinigten Felder zurueck.
 *
 * Streng, mit einem Satz pro Fehler: Die KI legt Termine an, und wenn sie
 * "2026-02-30" schickt, soll sie das zurueckbekommen, statt dass im Kalender
 * am 2. Maerz ein Termin steht, den niemand erklaeren kann.
 *
 * @param {object} store
 * @param {object} merged   alle Felder, wie sie danach gelten sollen
 * @param {{bestand?:object|null}} [opts]  die Felder, die schon gespeichert
 *   sind (beim Aendern der Termin selbst, beim Loesen eines Vorkommens die
 *   Serie). Chat und Projekt, die sich dabei NICHT aendern, werden nicht noch
 *   einmal gesucht: die Herkunft bleibt wahr, auch wenn das Gespraech oder
 *   das Projekt inzwischen geloescht ist -- und ein Termin aus einem
 *   aufgeraeumten Chat muss sich trotzdem verschieben lassen.
 * @returns {object}        die zu speichernden Felder
 */
function checkEvent(store, merged, opts = {}) {
  const out = {};

  if (typeof merged.title !== 'string' || !merged.title.trim()) {
    throw new ValidationError('Ein Termin braucht einen Titel.');
  }
  out.title = merged.title.trim().replace(/\s+/g, ' ');
  if (out.title.length > 500) throw new ValidationError('Der Titel ist zu lang (höchstens 500 Zeichen).');

  if (merged.allDay !== undefined && typeof merged.allDay !== 'boolean') {
    throw new ValidationError('"allDay" muss true oder false sein.');
  }

  const start = parseWhen(merged.start);
  if (!start) {
    throw new ValidationError(
      `Der Beginn "${String(merged.start ?? '')}" ist kein gültiger Zeitpunkt. `
      + 'Erwartet: "JJJJ-MM-TT" (ganztägig), "JJJJ-MM-TTTHH:MM" (Uhrzeit vor Ort) oder ein ISO-Zeitpunkt mit Zone.',
    );
  }
  // Ohne Uhrzeit ist ein Termin ganztaegig, auch wenn es niemand dazuschrieb;
  // mit `allDay: true` zaehlt nur noch der Tag.
  const allDay = merged.allDay === true || start.kind === 'date';
  out.allDay = allDay;
  out.start = allDay ? start.day : String(merged.start).trim();

  if (merged.end === null || merged.end === undefined || merged.end === '') {
    out.end = null;
  } else {
    const end = parseWhen(merged.end);
    if (!end) throw new ValidationError(`Das Ende "${String(merged.end)}" ist kein gültiger Zeitpunkt.`);
    if (allDay) {
      if (end.day < start.day) throw new ValidationError('Das Ende liegt vor dem Beginn.');
      out.end = end.day === start.day ? null : end.day;
    } else {
      if (end.kind === 'date') throw new ValidationError('Ein Termin mit Uhrzeit braucht auch beim Ende eine Uhrzeit.');
      if (liegtVor(end, start)) throw new ValidationError('Das Ende liegt vor dem Beginn.');
      out.end = String(merged.end).trim();
    }
  }

  for (const [key, max] of [['location', 500], ['body', 20000]]) {
    const value = merged[key];
    if (value === undefined || value === null) {
      out[key] = '';
      continue;
    }
    if (typeof value !== 'string') throw new ValidationError(`"${key}" muss ein Text sein.`);
    if (value.length > max) throw new ValidationError(`"${key}" ist zu lang (höchstens ${max} Zeichen).`);
    out[key] = key === 'location' ? value.trim() : value;
  }

  const bestand = opts.bestand || {};
  for (const [key, type, label] of [['projectId', 'project', 'Das Projekt'], ['chatId', 'chat', 'Den Chat']]) {
    const value = merged[key];
    if (value === undefined || value === null || value === '') {
      out[key] = null;
      continue;
    }
    const unveraendert = value === bestand[key];
    if (!unveraendert && !liveOfType(store, value, type)) throw new ValidationError(`${label} "${String(value)}" gibt es nicht.`);
    out[key] = value;
  }

  const source = merged.source === undefined ? 'user' : merged.source;
  if (source !== 'user' && source !== 'auto') {
    throw new ValidationError('"source" muss "user" oder "auto" sein.');
  }
  // Ein automatischer Termin ohne Gespraech waere einer, dessen Herkunft
  // niemand mehr nachsehen kann -- und genau die soll der Kalender zeigen.
  if (source === 'auto' && !out.chatId) {
    throw new ValidationError('Ein automatisch erkannter Termin braucht den Chat, aus dem er stammt ("chatId").');
  }
  out.source = source;

  // Wiederholung. Die Regel haengt am Tag des Beginns ("monatlich" heisst:
  // am selben Tag des Monats wie der erste Termin).
  // Das Ende zaehlt mit: ein Vorkommen erbt Beginn UND Ende der Serie, und
  // ein Ende mit Zone laesst sich nicht auf einen anderen Tag legen -- jedes
  // Vorkommen stuende sonst ohne Ende da.
  if (merged.recurrence !== undefined && merged.recurrence !== null && (w.hatZone(out.start) || w.hatZone(out.end))) {
    throw new ValidationError('Eine Serie braucht die Uhrzeit vor Ort ("JJJJ-MM-TTTHH:MM") – '
      + 'ein Zeitpunkt mit Zone würde bei jeder Zeitumstellung um eine Stunde wandern.');
  }
  out.recurrence = w.regelPruefen(merged.recurrence, out.start.slice(0, 10));
  if (out.recurrence) {
    // Beginn auf das erste echte Vorkommen legen (siehe beginnAufVorkommen):
    // sonst zeigen iPad und Neural OS verschiedene Tage.
    if (!w.ersterTag(out.start.slice(0, 10), out.recurrence)) {
      throw new ValidationError('Mit diesen Wochentagen findet die Serie bis zu ihrem Ende nie statt.');
    }
    const lage = w.beginnAufVorkommen(out);
    if (lage) {
      out.start = lage.start;
      out.end = lage.end;
    }
  }
  // Ausnahmen gibt es nur an Serien; wird aus einer Serie ein einzelner
  // Termin, verlieren sie ihren Sinn.
  out.exdates = out.recurrence ? w.ausnahmenPruefen(merged.exdates) : [];
  out.reminder = w.erinnerungPruefen(merged.reminder);
  return out;
}

/**
 * Einen Termin anlegen. Auch fuer Aufrufer im selben Prozess (die KI-Werkzeuge),
 * damit dieselben Pruefungen gelten wie ueber HTTP.
 *
 * @param {object} store
 * @param {object} input  title, start, end?, allDay?, location?, body?, projectId?, chatId?, source?,
 *                        recurrence?, exdates?, reminder?
 * @param {{stempel?:object}} [opts]  Herkunftsstempel eines Agentenlaufs (runId, agentId),
 *   den der Aenderungsverlauf als Rueckfall liest
 */
function createEvent(store, input, opts = {}) {
  const raw = asObject(input, 'Der Termin');
  refuseDayAsTime(raw, raw.start);
  const data = checkEvent(store, raw);
  return store.create('event', { ...data, ...stempelVon(opts) });
}

function stempelVon(opts) {
  const out = {};
  const st = opts && opts.stempel;
  if (st && typeof st.runId === 'string' && st.runId) out.runId = st.runId;
  if (st && typeof st.agentId === 'string' && st.agentId) out.agentId = st.agentId;
  return out;
}

/**
 * Wer ausdruecklich "mit Uhrzeit" sagt (`allDay: false`) und dann nur einen
 * Tag schickt, hat etwas vergessen. Stillschweigend ganztaegig daraus zu
 * machen, hiesse zu raten; ohne diese Angabe ist ein Tag dagegen eindeutig
 * ganztaegig.
 */
function refuseDayAsTime(input, start) {
  if (input.allDay === false && DATE_RE.test(String(start || '').trim())) {
    throw new ValidationError('Für einen Termin mit Uhrzeit bitte den Beginn mit Uhrzeit angeben ("JJJJ-MM-TTTHH:MM").');
  }
}

/**
 * Einen Termin aendern. Herkunft (`source`, `chatId`) ist nicht aenderbar:
 * wer einen automatisch angelegten Termin verschiebt, macht ihn dadurch nicht
 * zu seinem eigenen, und "angelegt aus dem Chat …" soll stimmen bleiben.
 */
function updateEvent(store, id, patch, opts = {}) {
  const existing = liveOfType(store, id, 'event');
  if (!existing) throw notFound('Diesen Termin gibt es nicht (mehr).');
  const input = asObject(patch, 'Die Änderung');
  for (const key of ['source', 'chatId']) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== existing.data[key]) {
      throw new ValidationError(`"${key}" beschreibt, woher der Termin stammt, und lässt sich nicht ändern.`);
    }
  }
  const keys = Object.keys(input).filter((k) => EVENT_FIELDS.includes(k));
  if (!keys.length) throw new ValidationError('Es wurden keine Felder zum Ändern übergeben.');
  // `nur` ist gesetzt, sobald es angegeben wurde -- auch leer. Ein leeres
  // "nur" still als "die ganze Serie" zu lesen hiesse, aus "nur diesen
  // Dienstag" eine Aenderung an jedem Dienstag zu machen.
  if (opts.nur !== undefined && opts.nur !== null) {
    return aendernAm(store, existing, opts.nur, input, opts).record;
  }
  const merged = { ...lesbar(existing).data, ...input };
  // Ein Wechsel auf "mit Uhrzeit" ohne neuen Beginn hiesse, den Tag als
  // Zeitpunkt zu nehmen -- das ist keine Uhrzeit, sondern ein Missverstaendnis.
  refuseDayAsTime(input, merged.start);
  // Wird ein Termin ganztaegig, verliert sein altes Ende mit Uhrzeit den Sinn.
  if (input.allDay === true && !Object.prototype.hasOwnProperty.call(input, 'end')) merged.end = null;
  const data = checkEvent(store, merged, { bestand: existing.data });
  const changed = {};
  for (const [key, value] of Object.entries(data)) {
    if (JSON.stringify(existing.data[key]) !== JSON.stringify(value)) changed[key] = value;
  }
  if (!Object.keys(changed).length) return existing;
  return store.update(existing.id, changed);
}

/**
 * Prueft, dass `tag` ein Vorkommen der Serie ist. Ein Tag, an dem die Serie
 * gar nicht stattfindet, ist ein Fehler, keine stille Ausnahme: sonst stuende
 * in `exdates` ein Tag, den niemand je sehen konnte.
 */
function vorkommenPruefen(serie, tag) {
  if (typeof tag !== 'string' || !w.gueltigerTag(tag)) {
    throw new ValidationError(`"nur" muss ein Tag der Form JJJJ-MM-TT sein (empfangen: ${String(tag)}).`);
  }
  if (!w.istSerie(serie.data)) {
    throw new ValidationError(`„${serie.data.title}“ wiederholt sich nicht – ein einzelnes Vorkommen gibt es nur bei Serien.`);
  }
  if (!w.istVorkommen(serie.data, tag)) {
    throw notFound(`Am ${w.datumDeutsch(tag)} findet „${serie.data.title}“ nicht statt.`);
  }
}

/**
 * Genau EIN Vorkommen einer Serie aendern (Vertrag C).
 *
 * Der Tag wandert in `exdates` der Serie, und ein Einzeltermin mit den neuen
 * Werten entsteht. Beides in einer Transaktion (scheitert das Schreiben,
 * bleibt beides aus) und in einer Verlaufsgruppe (rueckgaengig nimmt beides
 * zurueck).
 *
 * @returns {{record:object, serie:object}}  der neue Einzeltermin und die Serie danach
 */
function aendernAm(store, serie, tag, input, opts = {}) {
  vorkommenPruefen(serie, tag);
  if (has(input, 'recurrence') && input.recurrence !== null) {
    throw new ValidationError('Ein einzelnes Vorkommen hat keine eigene Wiederholung. Ohne „nur“ ändert sich die ganze Serie.');
  }
  const lage = w.aufTagLegen(serie.data, tag);
  const merged = { ...serie.data, start: lage.start, end: lage.end, ...input, recurrence: null, exdates: [] };
  refuseDayAsTime(input, merged.start);
  if (input.allDay === true && !has(input, 'end')) merged.end = null;
  const data = checkEvent(store, merged, { bestand: serie.data });
  const exdates = w.ausnahmenPruefen([...(Array.isArray(serie.data.exdates) ? serie.data.exdates : []), tag]);
  return store.transaction(() => gemeinsam(() => {
    const neueSerie = store.update(serie.id, { exdates });
    const record = store.create('event', { ...data, ausSerie: { id: serie.id, tag }, ...stempelVon(opts) });
    return { record, serie: neueSerie };
  }));
}

/**
 * Eine Serie ab einem Vorkommen aendern (Werkzeug termin_aendern mit
 * `ab_am`, "ab jetzt um 19 Uhr"): die alte Serie endet am Vortag, eine neue
 * mit den Aenderungen beginnt an `tag`. Beide Schreibvorgaenge in einer
 * Transaktion und einer Verlaufsgruppe -- ein "rueckgaengig" stellt die
 * alte Serie wieder her und nimmt die neue weg.
 *
 * `input` bezieht sich auf die NEUE Serie, deren erstes Vorkommen `tag` ist
 * (der Aufrufer rechnet Verschiebungen mit w.serieVerschieben vorher aus).
 * Ist `tag` schon der Beginn der Serie, gibt es nichts zu teilen: dann
 * aendert sich die ganze Serie.
 *
 * @returns {{record:object, alt:object|null}}  die neue Serie und die alte danach
 */
function aendernAb(store, serie, tag, input, opts = {}) {
  vorkommenPruefen(serie, tag);
  if (has(input, 'recurrence') && input.recurrence === null) {
    throw new ValidationError('„Ab einem Tag“ gibt es nur mit Wiederholung – ohne Wiederholung wäre es ein einzelner Termin.');
  }
  const s0 = w.wandzeitLesen(serie.data.start).tag;
  if (tag === s0) return { record: updateEvent(store, serie.id, input, opts), alt: null };
  const teil = w.abTagTeilen(serie.data, tag);
  const merged = { ...serie.data, ...teil.neu, ...input };
  refuseDayAsTime(input, merged.start);
  if (input.allDay === true && !has(input, 'end')) merged.end = null;
  const data = checkEvent(store, merged, { bestand: serie.data });
  const altRegel = w.regelPruefen(teil.alt.recurrence, s0);
  return store.transaction(() => gemeinsam(() => {
    const alt = store.update(serie.id, { recurrence: altRegel, exdates: teil.alt.exdates });
    const record = store.create('event', { ...data, fortsetzungVon: { id: serie.id, ab: tag }, ...stempelVon(opts) });
    return { record, alt };
  }));
}

/**
 * Einen Termin loeschen (weich; POST /api/records/:id/restore holt ihn
 * zurueck) -- oder mit `nur` genau ein Vorkommen einer Serie auslassen.
 *
 * Eine GANZE Serie nimmt ihre verschobenen Vorkommen mit (die per `?nur`
 * geloesten Einzeltermine mit `ausSerie.id`), so wie der Kalender auf dem
 * iPad eine Serie samt ihren Ausnahmen loescht. Sonst stuende nach "Training
 * loeschen" noch das eine verlegte Training im Kalender, und niemand wuesste,
 * warum. Alles in einer Verlaufsgruppe: "rueckgaengig" holt alles zurueck.
 *
 * @returns {{record:object, ausgelassen:string|null, mitgeloescht:object[]}}
 */
function deleteEvent(store, id, opts = {}) {
  const existing = liveOfType(store, id, 'event');
  if (!existing) throw notFound('Diesen Termin gibt es nicht (mehr).');
  if (opts.nur !== undefined && opts.nur !== null) {
    vorkommenPruefen(existing, opts.nur);
    const exdates = w.ausnahmenPruefen([...(Array.isArray(existing.data.exdates) ? existing.data.exdates : []), opts.nur]);
    return { record: store.update(existing.id, { exdates }), ausgelassen: opts.nur, mitgeloescht: [] };
  }
  const ausnahmen = store.all('event').filter((r) => r.id !== existing.id
    && r.data && r.data.ausSerie && r.data.ausSerie.id === existing.id);
  if (!ausnahmen.length) return { record: store.remove(existing.id), ausgelassen: null, mitgeloescht: [] };
  return store.transaction(() => gemeinsam(() => {
    const mitgeloescht = ausnahmen.map((r) => store.remove(r.id));
    return { record: store.remove(existing.id), ausgelassen: null, mitgeloescht };
  }));
}

/* ------------------------------------------------------------------ */
/* Zeitraum                                                            */
/* ------------------------------------------------------------------ */

function monthBounds(now = new Date()) {
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: dayString(first), to: dayString(last) };
}

function readRange(query) {
  const fallback = monthBounds();
  const from = strParam(query, 'from', 40) || fallback.from;
  const to = strParam(query, 'to', 40) || (strParam(query, 'from', 40) ? from : fallback.to);
  for (const [name, value] of [['from', from], ['to', to]]) {
    const m = DATE_RE.exec(value);
    if (!m || !validDay(Number(m[1]), Number(m[2]), Number(m[3]))) {
      throw new ValidationError(`"${name}" muss ein Datum der Form JJJJ-MM-TT sein (empfangen: ${value}).`);
    }
  }
  if (to < from) throw new ValidationError('"to" liegt vor "from".');
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    throw new ValidationError(`Der Zeitraum ist zu lang (höchstens ${MAX_RANGE_DAYS} Tage).`);
  }
  return { from, to };
}

/**
 * Ein Termin, dessen Regel nicht gilt (an checkEvent vorbei geschrieben:
 * Abgleich, Module, alter Stand), wird als das gezeigt, als das er
 * behandelt wird: ein Einzeltermin ohne Wiederholung. Sonst stuende im Blatt
 * "Serie" und die Oberflaeche rechnete mit einer Regel, die es nicht gibt.
 */
function lesbar(record) {
  const d = record && record.data;
  if (!d || d.recurrence === null || d.recurrence === undefined || w.istSerie(d)) return record;
  return { ...record, data: { ...d, recurrence: null, exdates: [] } };
}

/** Ein Einzeltermin, wie der Zeitraum ihn liefert (Vertrag B). */
function einzelEintrag(record) {
  const r = lesbar(record);
  return {
    ...r,
    data: { ...r.data, occurrence: null, recurring: false },
    occurrence: null,
    recurring: false,
  };
}

/**
 * Ein Vorkommen einer Serie: die Felder der Serie, Beginn und Ende auf den
 * Tag gelegt, dieselbe id. `serie` nennt Beginn und Ende der Serie selbst.
 */
function vorkommenEintrag(record, tag) {
  const lage = w.aufTagLegen(record.data, tag);
  return {
    ...record,
    data: { ...record.data, start: lage.start, end: lage.end, occurrence: tag, recurring: true },
    occurrence: tag,
    recurring: true,
    serie: { start: record.data.start, end: record.data.end || null },
  };
}

function zuViele() {
  return new ValidationError(`In diesem Zeitraum liegen mehr als ${MAX_VORKOMMEN} Termine. Bitte einen kürzeren Zeitraum wählen.`);
}

/**
 * Alle Termine, die den Zeitraum beruehren, nach Beginn sortiert -- Serien
 * je Vorkommen. Ein Termin vom 30. bis 2. gehoert in beide Monate.
 *
 * @returns {object[]}  Eintraege nach Vertrag B (einzelEintrag / vorkommenEintrag)
 */
function eventsInRange(store, from, to, { max = MAX_VORKOMMEN } = {}) {
  const out = [];
  for (const record of store.all('event')) {
    if (w.istSerie(record.data)) {
      for (const tag of w.vorkommenImZeitraum(record.data, from, to, { max })) {
        const eintrag = vorkommenEintrag(record, tag);
        out.push({ eintrag, ms: spanOf(eintrag.data).startMs });
      }
    } else {
      const span = spanOf(record.data);
      if (!span) continue; // ein unlesbarer Altbestand: nicht erfinden, wohin er gehoert
      if (span.firstDay > to || span.lastDay < from) continue;
      out.push({ eintrag: einzelEintrag(record), ms: span.startMs });
    }
    if (out.length > max) throw zuViele();
  }
  out.sort((a, b) => (a.ms - b.ms)
    || String(a.eintrag.data.title).localeCompare(String(b.eintrag.data.title), 'de')
    || (a.eintrag.id < b.eintrag.id ? -1 : a.eintrag.id > b.eintrag.id ? 1 : 0));
  return out.map((x) => x.eintrag);
}

/**
 * Die gespeicherten Termine (Serien EINMAL, als Regel), die den Zeitraum
 * beruehren -- fuer die Kalenderdatei, in der eine Serie eine RRULE ist und
 * nicht 52 Einzeltermine.
 */
function recordsInRange(store, from, to) {
  const out = [];
  for (const record of store.all('event')) {
    if (w.istSerie(record.data)) {
      if (w.vorkommenImZeitraum(record.data, from, to, { max: 0 }).length) out.push(record);
      continue;
    }
    const span = spanOf(record.data);
    if (span && span.firstDay <= to && span.lastDay >= from) out.push(record);
  }
  if (out.length > MAX_VORKOMMEN) throw zuViele();
  return out;
}

/* ------------------------------------------------------------------ */
/* Ueberschneidungen                                                   */
/* ------------------------------------------------------------------ */

/** [Beginn, Ende) eines Eintrags mit Uhrzeit in ms; null fuer ganztaegige. */
function fenster(data) {
  if (data.allDay) return null;
  const start = parseWhen(data.start);
  if (!start || start.kind === 'date') return null;
  const end = parseWhen(data.end);
  let e = end && end.kind !== 'date' ? end.ms : start.ms + OHNE_ENDE_MS;
  if (e <= start.ms) e = start.ms + OHNE_ENDE_MS;
  return { s: start.ms, e };
}

/**
 * Termine (und Vorkommen), die sich mit dem Zeitraum ueberschneiden
 * (Vertrag E).
 *
 * - Mit Uhrzeit: [start, end) ueberschneidet [s, e), wenn s < end und
 *   start < e. Wer um 11 Uhr endet, stoesst an 11 Uhr, ueberschneidet es
 *   aber nicht.
 * - Ganztaegig ueberschneidet nichts mit Uhrzeit (und umgekehrt): ein
 *   Geburtstag steht dem Zahnarzt nicht im Weg. Ganztaegiges ueberschneidet
 *   Ganztaegiges, wenn sich die Tage beruehren.
 *
 * @param {{start:string, end?:string|null, ohne?:string|null}} q
 */
function ueberschneidungen(store, { start, end = null, ohne = null } = {}) {
  const qs = parseWhen(start);
  if (!qs) throw new ValidationError(`"start" ist kein gültiger Zeitpunkt (empfangen: ${String(start ?? '')}).`);
  const qe = end === null || end === undefined || end === '' ? null : parseWhen(end);
  if (end && !qe) throw new ValidationError(`"end" ist kein gültiger Zeitpunkt (empfangen: ${String(end)}).`);

  if (qs.kind === 'date') {
    const firstDay = qs.day;
    const lastDay = qe ? qe.day : qs.day;
    if (lastDay < firstDay) throw new ValidationError('Das Ende liegt vor dem Beginn.');
    if (daysBetween(firstDay, lastDay) > MAX_RANGE_DAYS) throw new ValidationError(`Der Zeitraum ist zu lang (höchstens ${MAX_RANGE_DAYS} Tage).`);
    return eventsInRange(store, firstDay, lastDay).filter((x) => x.id !== ohne && x.data.allDay === true);
  }

  if (qe && qe.kind === 'date') throw new ValidationError('Ein Zeitraum mit Uhrzeit braucht auch beim Ende eine Uhrzeit.');
  const s = qs.ms;
  let e = qe ? qe.ms : s + OHNE_ENDE_MS;
  if (e < s) throw new ValidationError('Das Ende liegt vor dem Beginn.');
  if (e === s) e = s + OHNE_ENDE_MS;
  const firstDay = qs.day;
  const lastDay = dayString(new Date(e - 1));
  if (daysBetween(firstDay, lastDay) > MAX_RANGE_DAYS) throw new ValidationError(`Der Zeitraum ist zu lang (höchstens ${MAX_RANGE_DAYS} Tage).`);
  // Einen Tag frueher anfangen: ein Termin, der gestern Abend begann und
  // heute frueh endet, liegt nur mit seinem Ende im gefragten Tag.
  return eventsInRange(store, addDays(firstDay, -1), lastDay).filter((x) => {
    if (x.id === ohne) return false;
    const f = fenster(x.data);
    return !!f && f.s < e && s < f.e;
  });
}

/* ------------------------------------------------------------------ */
/* Herkunft                                                            */
/* ------------------------------------------------------------------ */

/** Titel der genannten Chats, auch geloeschter -- sonst stuende da nur eine Kennung. */
function chatTitles(store, ids) {
  const out = {};
  for (const id of ids) {
    if (!id || out[id]) continue;
    const record = store.get(id, { includeDeleted: true });
    if (!record || record.type !== 'chat') continue;
    out[id] = { id, title: record.data.title || 'Chat', deleted: !!record.deletedAt };
  }
  return out;
}

function projectNames(store, ids) {
  const out = {};
  for (const id of ids) {
    if (!id || out[id]) continue;
    const record = store.get(id);
    if (!record || record.type !== 'project') continue;
    out[id] = { id, name: record.data.name || 'Projekt', status: record.data.status || 'active' };
  }
  return out;
}

/**
 * Woher eine Notiz stammt, in Worten, die die Oberflaeche nur noch anzeigt.
 * 'chat' = die KI hat sie aus einem Gespraech gemacht (Vertrag 4:
 * source 'auto' + chatId); 'hand' = von dir; 'agent' und 'import' wie gehabt.
 */
function noteOrigin(note, chats) {
  const data = note.data || {};
  const chat = data.chatId ? chats[data.chatId] || null : null;
  let art = 'hand';
  if (data.source === 'auto') art = chat ? 'chat' : 'automatisch';
  else if (data.source === 'agent') art = 'agent';
  else if (data.source === 'import') art = 'import';
  return {
    art,
    chatId: chat ? chat.id : null,
    chatTitel: chat ? chat.title : null,
    chatGeloescht: chat ? chat.deleted : false,
  };
}

/* ------------------------------------------------------------------ */
/* Projekte                                                            */
/* ------------------------------------------------------------------ */

const BELONGING_TYPES = new Set(['chat', 'note', 'event', 'task']);
const OPEN_TASK = new Set(['todo', 'doing', 'blocked']);

/**
 * Was zu welchem Projekt gehoert -- in einem Durchgang fuer alle.
 *
 * Drei Wege, und alle zaehlen, weil die KI (Bereich Claude-Unterbau) und der
 * Nutzer Zusammenhaenge auf verschiedene Weise herstellen:
 *   1. `data.projectId` an Aufgabe, Termin, Notiz oder Chat,
 *   2. eine Kante zwischen Projekt und Eintrag (gleich welcher Art: eine
 *      Notiz mit [[Projektname]] gehoert genauso dazu wie eine belongs-to),
 *   3. der Chat, aus dem eine dazugehoerige Notiz, ein Termin oder eine
 *      Aufgabe stammt (`data.chatId`) -- dort wurde das Projekt besprochen.
 */
function collectProjects(store) {
  const projects = store.all('project');
  const buckets = new Map();
  for (const project of projects) {
    buckets.set(project.id, { project, chats: new Map(), note: new Map(), event: new Map(), task: new Map() });
  }
  const put = (bucket, record) => {
    if (!bucket || !record || !BELONGING_TYPES.has(record.type)) return;
    (record.type === 'chat' ? bucket.chats : bucket[record.type]).set(record.id, record);
  };

  for (const type of BELONGING_TYPES) {
    for (const record of store.all(type)) {
      const pid = record.data && record.data.projectId;
      if (pid && buckets.has(pid)) put(buckets.get(pid), record);
    }
  }

  for (const [pid, bucket] of buckets) {
    let edges = [];
    try {
      edges = store.edges.for(pid, { direction: 'both' });
    } catch { /* ein Speicher ohne Kanten: dann eben nur Weg 1 */ }
    for (const edge of edges) {
      const other = edge.data.from === pid ? edge.data.to : edge.data.from;
      const record = store.get(other);
      if (record) put(bucket, record);
    }
    for (const type of ['note', 'event', 'task']) {
      for (const record of bucket[type].values()) {
        const chat = liveOfType(store, record.data && record.data.chatId, 'chat');
        if (chat) bucket.chats.set(chat.id, chat);
      }
    }
  }
  return buckets;
}

const byUpdatedDesc = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

function lightChat(record) {
  return { id: record.id, title: record.data.title || 'Chat', updatedAt: record.updatedAt };
}

function lightNote(record) {
  const data = record.data || {};
  return {
    id: record.id,
    title: data.title || 'Notiz',
    body: String(data.body || '').slice(0, 400),
    source: data.source || 'user',
    pinned: !!data.pinned,
    updatedAt: record.updatedAt,
  };
}

/**
 * Ein Termin fuer die Projektansicht. Eine Serie erscheint mit ihrem
 * NAECHSTEN Vorkommen -- "naechster Termin: Training, 7. Januar 2025" waere
 * fuer eine Serie, die jede Woche stattfindet, eine falsche Auskunft.
 */
function lightEvent(record, heute = dayString(new Date())) {
  const data = record.data || {};
  let { start, end } = data;
  let occurrence = null;
  const serie = w.istSerie(data);
  if (serie) {
    const tag = w.naechstesVorkommen(data, heute);
    if (tag) {
      ({ start, end } = w.aufTagLegen(data, tag));
      occurrence = tag;
    }
  }
  return {
    id: record.id,
    title: data.title,
    start,
    end: end || null,
    allDay: !!data.allDay,
    location: data.location || '',
    source: data.source || 'user',
    recurring: serie,
    occurrence,
    updatedAt: record.updatedAt,
  };
}

function lightTask(record) {
  const data = record.data || {};
  return {
    id: record.id,
    title: data.title,
    status: data.status || 'todo',
    due: data.due || null,
    priority: Number.isFinite(data.priority) ? data.priority : 2,
    updatedAt: record.updatedAt,
  };
}

function taskOrder(a, b) {
  const ao = OPEN_TASK.has(a.status) ? 0 : 1;
  const bo = OPEN_TASK.has(b.status) ? 0 : 1;
  if (ao !== bo) return ao - bo;
  if ((a.due || '9999') !== (b.due || '9999')) return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return String(a.title).localeCompare(String(b.title), 'de');
}

function eventOrder(a, b) {
  const sa = parseWhen(a.start);
  const sb = parseWhen(b.start);
  return (sa ? sa.ms : 0) - (sb ? sb.ms : 0);
}

/** Uebersicht und Einzelansicht teilen sich diese Zusammenfassung. */
function describeProject(bucket, now = Date.now(), full = false) {
  const { project } = bucket;
  const chats = [...bucket.chats.values()].sort(byUpdatedDesc);
  const notes = [...bucket.note.values()].sort(byUpdatedDesc);
  const heute = dayString(new Date(now));
  const events = [...bucket.event.values()].map((r) => lightEvent(r, heute)).sort(eventOrder);
  const tasks = [...bucket.task.values()].map(lightTask).sort(taskOrder);

  let zuletzt = project.updatedAt;
  for (const record of [...bucket.chats.values(), ...bucket.note.values(), ...bucket.event.values(), ...bucket.task.values()]) {
    if (record.updatedAt > zuletzt) zuletzt = record.updatedAt;
  }

  const upcoming = events.filter((e) => {
    const span = spanOf(e);
    if (!span) return false;
    const endMs = span.endMs !== null ? span.endMs : (e.allDay ? parseWhen(addDays(span.lastDay, 1)).ms : span.startMs);
    return endMs >= now;
  });

  const out = {
    id: project.id,
    name: project.data.name || 'Projekt',
    description: project.data.description || '',
    status: project.data.status || 'active',
    tags: project.data.tags || [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    zuletzt,
    zaehler: {
      chats: chats.length,
      termine: events.length,
      termineAnstehend: upcoming.length,
      notizen: notes.length,
      aufgaben: tasks.length,
      aufgabenOffen: tasks.filter((t) => OPEN_TASK.has(t.status)).length,
      aufgabenErledigt: tasks.filter((t) => t.status === 'done').length,
    },
    naechsterTermin: upcoming.length ? upcoming[0] : null,
  };
  if (full) {
    out.chats = chats.map(lightChat);
    out.notizen = notes.map(lightNote);
    out.termine = events;
    out.aufgaben = tasks;
  } else {
    // Die Uebersicht zeigt nur die juengsten Chats beim Namen.
    out.chats = chats.slice(0, 3).map(lightChat);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Antworten                                                           */
/* ------------------------------------------------------------------ */

/**
 * Welcher Verlaufseintrag die gerade geschehene Aenderung zuruecknimmt.
 * Die Oberflaeche braucht die Nummer fuer "Rückgängig"
 * (POST /api/history/:seq/undo); bei einer Gruppe nimmt jeder ihrer
 * Eintraege die ganze Gruppe zurueck. Ohne Verlauf (etwa in einem Test ohne
 * das Teilsystem) ehrlich null.
 */
function verlaufStand(rc) {
  const history = rc.ctx && rc.ctx.history;
  if (!history || typeof history.list !== 'function') return null;
  try {
    const [neuester] = history.list({ limit: 1 }).items;
    return neuester ? neuester.seq : 0;
  } catch {
    return null;
  }
}

/**
 * @param {number|null} stand  die hoechste Verlaufsnummer VOR dem Schreiben.
 *   Nur was danach entstand, gehoert zu dieser Anfrage: aendert ein PATCH
 *   nichts (dieselben Werte), gibt es auch nichts zurueckzunehmen -- und die
 *   Nummer einer AELTEREN Aenderung anzubieten hiesse, dass "Rückgängig" etwa
 *   das Anlegen zuruecknimmt und der Termin verschwindet.
 */
function rueckgaengigFuer(rc, id, stand) {
  const history = rc.ctx && rc.ctx.history;
  if (!history || typeof history.list !== 'function' || stand === null || stand === undefined) return null;
  try {
    const { items } = history.list({ type: 'event', limit: 20 });
    const eintrag = items.find((e) => e.id === id && e.seq > stand && e.canUndo);
    if (!eintrag) return null;
    return { eintrag: eintrag.seq, pfad: `/api/history/${eintrag.seq}/undo`, gruppe: eintrag.gruppe || null };
  } catch {
    return null;
  }
}

/**
 * Eine Kalenderdatei senden. `attachment`, damit Safari auf dem iPad sie als
 * Datei behandelt und "Zum Kalender hinzufügen" anbietet, statt Text zu zeigen.
 */
function kalenderSenden(rc, text, name) {
  const body = Buffer.from(text, 'utf8');
  const { res } = rc;
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  if (rc.method === 'HEAD') res.end();
  else res.end(body);
  rc.handled = true;
  return undefined;
}

/**
 * `?nur=` lesen: null nur, wenn es GAR NICHT dasteht. Ein leeres oder
 * falsches "nur" ist ein Fehler (vorkommenPruefen sagt, welcher) -- nie die
 * ganze Serie. Sonst loeschte `DELETE …?nur=` die ganze Serie, weil eine
 * Oberflaeche das Vorkommen nicht mitgeschickt hat.
 */
function nurParam(query) {
  if (!query || typeof query.has !== 'function' || !query.has('nur')) return null;
  const raw = String(query.get('nur') || '').trim();
  if (raw.length > 20) throw new ValidationError('"nur" ist zu lang (erwartet: JJJJ-MM-TT).');
  return raw;
}

/* ------------------------------------------------------------------ */
/* Routen                                                              */
/* ------------------------------------------------------------------ */

function register(router) {
  /* --------------------------------------------------------- Termine */

  router.get('/api/events/zeitraum', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const { from, to } = readRange(rc.query);
    const items = eventsInRange(store, from, to);
    return {
      from,
      to,
      items,
      total: items.length,
      chats: chatTitles(store, items.map((r) => r.data.chatId)),
      projekte: projectNames(store, items.map((r) => r.data.projectId)),
    };
  });

  // Vor `/api/events/:id` registriert: der Router nimmt die erste passende
  // Route, und ":id" passte sonst auch auf "ueberschneidungen".
  router.get('/api/events/ueberschneidungen', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const start = strParam(rc.query, 'start', 40);
    if (!start) throw new ValidationError('"start" fehlt (JJJJ-MM-TT oder JJJJ-MM-TTTHH:MM).');
    const items = ueberschneidungen(store, {
      start,
      end: strParam(rc.query, 'end', 40) || null,
      ohne: strParam(rc.query, 'ohne', 80) || null,
    });
    return { items, total: items.length };
  });

  router.get('/api/events/export.ics', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const { from, to } = readRange(rc.query);
    const text = ics.kalenderDatei(recordsInRange(store, from, to), { name: 'Neural OS' });
    return kalenderSenden(rc, text, `neural-os-${from}-bis-${to}.ics`);
  });

  router.post('/api/events', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const input = eventInput(asObject(await rc.body()));
    const stand = verlaufStand(rc);
    const record = createEvent(store, input);
    return { record, rueckgaengig: rueckgaengigFuer(rc, record.id, stand) };
  });

  router.get('/api/events/:id', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = lesbar(liveOfType(store, rc.params.id, 'event'));
    if (!record) throw notFound('Diesen Termin gibt es nicht (mehr).');
    const chats = chatTitles(store, [record.data.chatId]);
    const projekte = projectNames(store, [record.data.projectId]);
    return {
      record,
      chat: chats[record.data.chatId] || null,
      projekt: projekte[record.data.projectId] || null,
      // In Worten, wie die Serie gespeichert ist ("jeden Dienstag bis 24.12.2026").
      wiederholung: w.istSerie(record.data) ? w.inWorten(record.data.recurrence, record.data.start.slice(0, 10)) : null,
      // Welches Vorkommen zeigt, wer nur die Serie oeffnet (#/kalender?id=… ohne
      // &am=): das naechste ab heute, sonst das erste. Ohne diese Angabe stuende
      // im Blatt der Beginn der Serie, als waere er ein Einzeltermin.
      naechstes: w.istSerie(record.data)
        ? (w.naechstesVorkommen(record.data, dayString(new Date())) || w.naechstesVorkommen(record.data, record.data.start.slice(0, 10)))
        : null,
    };
  });

  router.get('/api/events/:id/ics', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = liveOfType(store, rc.params.id, 'event');
    if (!record) throw notFound('Diesen Termin gibt es nicht (mehr).');
    return kalenderSenden(rc, ics.kalenderDatei([record], { name: 'Neural OS' }), ics.dateiname(record.data.title));
  });

  router.patch('/api/events/:id', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const nur = nurParam(rc.query);
    const input = eventInput(asObject(await rc.body()));
    const stand = verlaufStand(rc);
    const record = updateEvent(store, rc.params.id, input, { nur });
    const out = { record, rueckgaengig: rueckgaengigFuer(rc, record.id, stand) };
    // Nur ein Vorkommen: die Antwort ist der NEUE Einzeltermin (Vertrag C);
    // die Serie danach steht daneben, damit niemand sie neu laden muss.
    if (nur) out.serie = store.get(rc.params.id);
    return out;
  });

  router.delete('/api/events/:id', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    // Ohne `nur` weich geloescht: POST /api/records/:id/restore holt ihn zurueck.
    // Mit `nur` bleibt die Serie und laesst nur diesen Tag aus.
    const stand = verlaufStand(rc);
    const { record, ausgelassen, mitgeloescht } = deleteEvent(store, rc.params.id, { nur: nurParam(rc.query) });
    return {
      record,
      ausgelassen,
      mitgeloescht: mitgeloescht.map((r) => ({ id: r.id, title: r.data.title, start: r.data.start })),
      rueckgaengig: rueckgaengigFuer(rc, record.id, stand),
    };
  });

  /* --------------------------------------------------------- Notizen */

  router.get('/api/notizen', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const quelle = strParam(rc.query, 'quelle', 20) || 'alle';
    if (!['alle', 'auto', 'hand'].includes(quelle)) {
      throw new ValidationError('"quelle" muss alle, auto oder hand sein.');
    }
    const sort = strParam(rc.query, 'sort', 20) || 'wand';
    if (!['wand', 'neu'].includes(sort)) throw new ValidationError('"sort" muss wand oder neu sein.');
    const limit = intParam(rc.query, 'limit', 300, 1, 2000);

    const all = store.all('note');
    const isAuto = (n) => n.data && n.data.source === 'auto';
    const selected = all.filter((n) => (quelle === 'alle' ? true : quelle === 'auto' ? isAuto(n) : !isAuto(n)));
    // Angeheftetes oben, sonst das zuletzt Beruehrte zuerst: eine Notiz, die
    // die KI heute ergaenzt hat, ist die neueste, auch wenn sie alt ist.
    selected.sort((a, b) => {
      if (sort === 'wand' && !!a.data.pinned !== !!b.data.pinned) return a.data.pinned ? -1 : 1;
      return byUpdatedDesc(a, b) || (a.id < b.id ? -1 : 1);
    });
    const page = selected.slice(0, limit);
    const chats = chatTitles(store, page.map((n) => n.data.chatId));
    const projekte = projectNames(store, page.map((n) => n.data.projectId));
    return {
      items: page.map((note) => ({
        ...note,
        herkunft: noteOrigin(note, chats),
        projekt: projekte[note.data.projectId] || null,
      })),
      total: selected.length,
      zaehler: {
        alle: all.length,
        automatisch: all.filter(isAuto).length,
        angeheftet: all.filter((n) => n.data.pinned).length,
      },
    };
  });

  /* -------------------------------------------------------- Projekte */

  router.get('/api/projekte', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const now = Date.now();
    const items = [...collectProjects(store).values()]
      .map((bucket) => describeProject(bucket, now, false))
      .sort((a, b) => (a.zuletzt < b.zuletzt ? 1 : a.zuletzt > b.zuletzt ? -1 : 0));
    return { items, total: items.length };
  });

  router.get('/api/projekte/:id', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    if (!liveOfType(store, rc.params.id, 'project')) throw notFound('Dieses Projekt gibt es nicht (mehr).');
    const bucket = collectProjects(store).get(rc.params.id);
    return { projekt: describeProject(bucket, Date.now(), true) };
  });
}

module.exports = {
  register,
  createEvent,
  updateEvent,
  deleteEvent,
  aendernAm,
  aendernAb,
  parseWhen,
  spanOf,
  eventsInRange,
  recordsInRange,
  ueberschneidungen,
  MAX_VORKOMMEN,
};
