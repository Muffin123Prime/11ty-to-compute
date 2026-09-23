'use strict';

/**
 * Kalender, Notizen, Projekte -- die Routen dieses Bereichs.
 *
 * Termine (Vertrag 3)
 * -------------------
 *   GET    /api/events/zeitraum?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   POST   /api/events
 *   GET    /api/events/:id
 *   PATCH  /api/events/:id
 *   DELETE /api/events/:id
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

/* ------------------------------------------------------------------ */
/* Zeit                                                                */
/* ------------------------------------------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const ZONED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Der laengste Zeitraum, den eine Anfrage abdeckt: gut ein Jahr. */
const MAX_RANGE_DAYS = 400;

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
    return { kind: 'date', day: s, ms: new Date(y, mo - 1, d).getTime(), midnight: true };
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

const EVENT_FIELDS = ['title', 'start', 'end', 'allDay', 'location', 'body', 'projectId', 'chatId', 'source'];

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
 * @returns {object}        die zu speichernden Felder
 */
function checkEvent(store, merged) {
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
      if (end.ms < start.ms) throw new ValidationError('Das Ende liegt vor dem Beginn.');
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

  for (const [key, type, label] of [['projectId', 'project', 'Projekt'], ['chatId', 'chat', 'Chat']]) {
    const value = merged[key];
    if (value === undefined || value === null || value === '') {
      out[key] = null;
      continue;
    }
    if (!liveOfType(store, value, type)) throw new ValidationError(`Das ${label} "${String(value)}" gibt es nicht.`);
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
  return out;
}

/**
 * Einen Termin anlegen. Auch fuer Aufrufer im selben Prozess (die KI-Werkzeuge),
 * damit dieselben Pruefungen gelten wie ueber HTTP.
 *
 * @param {object} store
 * @param {object} input  title, start, end?, allDay?, location?, body?, projectId?, chatId?, source?
 */
function createEvent(store, input) {
  const raw = asObject(input, 'Der Termin');
  refuseDayAsTime(raw, raw.start);
  const data = checkEvent(store, raw);
  return store.create('event', data);
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
function updateEvent(store, id, patch) {
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
  const merged = { ...existing.data, ...input };
  // Ein Wechsel auf "mit Uhrzeit" ohne neuen Beginn hiesse, den Tag als
  // Zeitpunkt zu nehmen -- das ist keine Uhrzeit, sondern ein Missverstaendnis.
  refuseDayAsTime(input, merged.start);
  // Wird ein Termin ganztaegig, verliert sein altes Ende mit Uhrzeit den Sinn.
  if (input.allDay === true && !Object.prototype.hasOwnProperty.call(input, 'end')) merged.end = null;
  const data = checkEvent(store, merged);
  const changed = {};
  for (const [key, value] of Object.entries(data)) {
    if (JSON.stringify(existing.data[key]) !== JSON.stringify(value)) changed[key] = value;
  }
  if (!Object.keys(changed).length) return existing;
  return store.update(existing.id, changed);
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
 * Alle Termine, die den Zeitraum beruehren, nach Beginn sortiert. Ein Termin
 * vom 30. bis 2. gehoert in beide Monate.
 */
function eventsInRange(store, from, to) {
  const out = [];
  for (const record of store.all('event')) {
    const span = spanOf(record.data);
    if (!span) continue; // ein unlesbarer Altbestand: nicht erfinden, wohin er gehoert
    if (span.firstDay > to || span.lastDay < from) continue;
    out.push({ record, span });
  }
  out.sort((a, b) => (a.span.startMs - b.span.startMs)
    || String(a.record.data.title).localeCompare(String(b.record.data.title), 'de'));
  return out.map((entry) => entry.record);
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

function lightEvent(record) {
  const data = record.data || {};
  return {
    id: record.id,
    title: data.title,
    start: data.start,
    end: data.end || null,
    allDay: !!data.allDay,
    location: data.location || '',
    source: data.source || 'user',
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
  const events = [...bucket.event.values()].map(lightEvent).sort(eventOrder);
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

  router.post('/api/events', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = createEvent(store, eventInput(asObject(await rc.body())));
    return { record };
  });

  router.get('/api/events/:id', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = liveOfType(store, rc.params.id, 'event');
    if (!record) throw notFound('Diesen Termin gibt es nicht (mehr).');
    const chats = chatTitles(store, [record.data.chatId]);
    const projekte = projectNames(store, [record.data.projectId]);
    return {
      record,
      chat: chats[record.data.chatId] || null,
      projekt: projekte[record.data.projectId] || null,
    };
  });

  router.patch('/api/events/:id', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = updateEvent(store, rc.params.id, eventInput(asObject(await rc.body())));
    return { record };
  });

  router.delete('/api/events/:id', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = liveOfType(store, rc.params.id, 'event');
    if (!record) throw notFound('Diesen Termin gibt es nicht (mehr).');
    // Weich geloescht: POST /api/records/:id/restore holt ihn zurueck.
    return { record: store.remove(record.id) };
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
  parseWhen,
  spanOf,
  eventsInRange,
};
