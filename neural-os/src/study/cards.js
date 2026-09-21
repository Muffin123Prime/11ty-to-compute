'use strict';

/**
 * Spaced repetition: the schedule, the deck, and where cards come from.
 *
 * Decisions that are not obvious from the code
 * --------------------------------------------
 *
 * 1. **`schedule()` is a pure function and stays one.** It takes a card's
 *    data, a grade and a point in time, and returns the next schedule. It
 *    reads nothing, writes nothing and asks no clock of its own. That is what
 *    makes it testable without waiting six days, and it is also what lets the
 *    interface show what a button will do BEFORE it is pressed -- the preview
 *    on the four buttons is computed by this very function, so it cannot drift
 *    away from what actually happens.
 *
 * 2. **Four grades, not six.** SM-2 was written for a 0-5 scale, which means
 *    picking between "4" and "5" after every single card. With four German
 *    words one decides instead of guessing. The grades map onto SM-2's scale
 *    as 0->q2 (failed), 1->q3, 2->q4, 3->q5, and `EASE_DELTA` below is that
 *    polynomial evaluated at those four points -- written out, because a
 *    constant one can read beats a formula one has to trust.
 *
 * 3. **`due` is a calendar day, never a timestamp.** Somebody who studies at
 *    08:00 must not get the same card back at 20:00 because "one day" was
 *    measured in hours, and the hour of the first review must not decide the
 *    rhythm of every later one. So a day is a local calendar day, the interval
 *    is added in days, and the comparison is a string comparison over
 *    `YYYY-MM-DD` -- which is chronological for that format and immune to
 *    timezone arithmetic.
 *
 * 4. **A deleted source note does not delete its cards -- it suspends them.**
 *    A card holds its own front and back; it is not a view onto the note. What
 *    it would lose by being deleted is the part that cannot be restored: how
 *    well you know it (`ease`, `reps`, `lapses`). Deleting a note is reversible
 *    here (a tombstone), so destroying that history in response would turn a
 *    reversible act into an irreversible one. The cards are therefore taken out
 *    of the rotation and marked (`orphanedAt`), so the deck does not quietly
 *    keep asking about something the user threw away and so the interface can
 *    say why. Restoring the note lifts exactly that suspension again, and only
 *    that one: a card the user suspended by hand stays suspended.
 *
 * 5. **`proposeFromNote` proposes and nothing else.** It recognises three
 *    EXPLICIT structures and refuses to guess from prose. `::` is unambiguous;
 *    a bare em dash is not -- this vault is full of German sentences with " — "
 *    in the middle, so the dash counts only when a bold term marks the left
 *    side as a term. Everything else stays prose. When nothing is found, the
 *    result says which forms exist rather than returning an empty list, because
 *    "I found nothing" and "you wrote nothing I understand" are different
 *    answers.
 *
 * 6. **The schedule is not editable by hand.** `update()` takes front, back,
 *    deck and suspended. `ease`/`due`/`reps`/`lapses` are the algorithm's, and
 *    a UI that let you set them would be offering a lever that quietly breaks
 *    the only thing this feature does.
 *
 * Honest limitation, already written down in `src/sync/merge.js`: cards are not
 * synchronised between devices, because merging two review schedules means
 * deciding how well somebody knows something by comparing timestamps. The deck
 * lives on one machine.
 */

const crypto = require('node:crypto');
const { ValidationError, NotFoundError } = require('../kernel/errors');

/** The four grades. The index IS the grade. */
const GRADE_LABELS = ['Nochmal', 'Schwer', 'Gut', 'Leicht'];
const GRADES = [0, 1, 2, 3];

/**
 * SM-2's ease adjustment `0.1 - (5-q)*(0.08 + (5-q)*0.02)` evaluated at
 * q = 2, 3, 4, 5 -- the four grades above.
 */
const EASE_DELTA = [-0.32, -0.14, 0, 0.1];

/**
 * Below 1.3 a card enters a trap: every interval is short, every review is a
 * failure, and the failure pushes the ease further down. SM-2's original floor
 * exists for that reason and is kept.
 */
const MIN_EASE = 1.3;
/**
 * The upper bound is ours, not SM-2's. It keeps `ease` inside the range the
 * schema documents and stops a deck answered "Leicht" from turning a two-month
 * interval into half a year in a single step.
 */
const MAX_EASE = 3.0;
const DEFAULT_EASE = 2.5;

const FIRST_INTERVAL_DAYS = 1;
const SECOND_INTERVAL_DAYS = 6;
/**
 * Nine years is not a repetition, it is forgetting with extra steps. A year is
 * the point where "I still know this" stops being a claim about memory.
 */
const MAX_INTERVAL_DAYS = 365;

const DEFAULT_DUE_LIMIT = 20;
const MAX_DUE_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

const DEFAULT_DECK = 'Standard';
const MAX_FRONT = 2000;
const MAX_BACK = 8000;
const MAX_DECK = 120;

/** A paragraph longer than this is an essay, not the back of a card. */
const MAX_PROPOSAL_BACK = 1200;
/** Heading levels that may become a front side. `#` is usually the title again. */
const HEADING_RE = /^ {0,3}(#{2,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;
const SEPARATOR_RE = /^[ \t]*(?:[-*+][ \t]+)?(.{1,200}?)[ \t]*::[ \t]*(.+?)[ \t]*$/;
const DEFINITION_RE = /^[ \t]*(?:[-*+][ \t]+)?\*\*(.{1,200}?)\*\*[ \t]*[—–][ \t]*(.+?)[ \t]*$/;
const LIST_OR_QUOTE_RE = /^[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|>|\||#)/;

/** The forms `proposeFromNote` understands, named so a human can copy them. */
const FORMEN = [
  {
    form: 'ueberschrift',
    text: 'Eine Überschrift (## bis ######) mit einem Absatz darunter: die Überschrift wird zur Frage, der Absatz zur Antwort.',
    beispiel: '## Kondensator\nSpeichert Ladung in einem elektrischen Feld.',
  },
  {
    form: 'trenner',
    text: 'Eine einzelne Zeile mit :: als Trenner.',
    beispiel: 'Kondensator :: Speichert Ladung in einem elektrischen Feld.',
  },
  {
    form: 'definition',
    text: 'Eine Zeile, die mit einem fett gesetzten Begriff beginnt, dahinter — oder – und die Erklärung.',
    beispiel: '**Kondensator** — Speichert Ladung in einem elektrischen Feld.',
  },
];

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Time, in calendar days                                              */
/* ------------------------------------------------------------------ */

/** Accepts a Date, a timestamp, an ISO string or nothing. Never throws. */
function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** `YYYY-MM-DD` in LOCAL time -- the day the person actually lives in. */
function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Calendar arithmetic, not milliseconds: adding 86 400 000 ms across a
 * daylight-saving boundary lands an hour off and eventually on the wrong day.
 */
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Whatever is stored in `due`, reduced to the day it names. */
function dayOf(value) {
  if (typeof value !== 'string' || value.length < 10) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function whenText(intervalDays) {
  if (intervalDays <= 0) return 'heute';
  if (intervalDays === 1) return 'morgen';
  return `in ${intervalDays} Tagen`;
}

/* ------------------------------------------------------------------ */
/* The algorithm                                                       */
/* ------------------------------------------------------------------ */

function assertGrade(grade) {
  if (!Number.isInteger(grade) || grade < 0 || grade > 3) {
    throw new ValidationError(
      `"grade" muss 0, 1, 2 oder 3 sein: ${GRADE_LABELS.map((label, i) => `${i} ${label}`).join(' · ')}.`,
      { grade },
    );
  }
  return grade;
}

function clampEase(value) {
  const ease = Number.isFinite(value) ? value : DEFAULT_EASE;
  return Math.min(MAX_EASE, Math.max(MIN_EASE, Math.round(ease * 1000) / 1000));
}

/**
 * SM-2, with four grades and a calendar day as the unit.
 *
 * @param {object} cardData   a card's `data` (front/back are irrelevant here)
 * @param {number} grade      0 Nochmal · 1 Schwer · 2 Gut · 3 Leicht
 * @param {Date|number|string} [now]
 * @returns {{ease:number, intervalDays:number, due:string, reps:number, lapses:number}}
 */
function schedule(cardData, grade, now) {
  assertGrade(grade);
  const data = isPlainObject(cardData) ? cardData : {};
  const today = toDate(now);

  const previousEase = Number.isFinite(data.ease) ? data.ease : DEFAULT_EASE;
  const previousInterval = Number.isFinite(data.intervalDays) && data.intervalDays > 0
    ? Math.trunc(data.intervalDays) : 0;
  // `reps` counts SUCCESSFUL repetitions in a row, which is what the "1 day,
  // then 6 days" rule needs. How often a card was ever seen is not kept; that
  // is a statistic, and this is a schedule. Whether a card is new is read from
  // `lastReviewedAt`, so a relapse never makes a card look untouched.
  const previousReps = Number.isFinite(data.reps) && data.reps > 0 ? Math.trunc(data.reps) : 0;
  const previousLapses = Number.isFinite(data.lapses) && data.lapses > 0 ? Math.trunc(data.lapses) : 0;

  const ease = clampEase(previousEase + EASE_DELTA[grade]);

  // "Nochmal": back today, the streak starts over, and the lapse is counted --
  // a card that keeps coming back should be visible as such, not silently
  // averaged away.
  if (grade === 0) {
    return { ease, intervalDays: 0, due: dayKey(today), reps: 0, lapses: previousLapses + 1 };
  }

  const reps = previousReps + 1;
  let intervalDays;
  if (reps === 1) intervalDays = FIRST_INTERVAL_DAYS;
  else if (reps === 2) intervalDays = SECOND_INTERVAL_DAYS;
  // `previousInterval + 1` as a floor: rounding must never let an interval
  // stand still or shrink after a correct answer.
  else intervalDays = Math.max(previousInterval + 1, Math.round(previousInterval * ease));
  intervalDays = Math.min(MAX_INTERVAL_DAYS, intervalDays);

  return { ease, intervalDays, due: dayKey(addDays(today, intervalDays)), reps, lapses: previousLapses };
}

/**
 * What each of the four buttons would do, for exactly this card, right now.
 *
 * The interface shows this on the buttons. It is computed by `schedule()`
 * itself so that "Gut · in 6 Tagen" is a statement about what will happen,
 * not a second implementation that agrees with the first until it does not.
 *
 * Note that "Gut" and "Leicht" name the same day on a card's first review --
 * plain SM-2 gives both one day. The difference is real but lives in `ease`,
 * so it is said in words (`hinweis`) instead of being faked as a different
 * date.
 */
function preview(cardData, now) {
  const at = toDate(now);
  return GRADES.map((grade) => {
    const next = schedule(cardData, grade, at);
    return {
      grade,
      label: GRADE_LABELS[grade],
      intervalDays: next.intervalDays,
      due: next.due,
      wann: whenText(next.intervalDays),
      hinweis: HINWEIS[grade],
    };
  });
}

const HINWEIS = [
  'Nicht gewusst — die Karte kommt heute noch einmal.',
  'Gewusst, aber mühsam — der Abstand wächst langsamer.',
  'Gewusst.',
  'Mühelos — der Abstand wächst danach schneller.',
];

/* ------------------------------------------------------------------ */
/* Reading a note                                                      */
/* ------------------------------------------------------------------ */

function keyOf(front, back) {
  return crypto.createHash('sha1').update(`${front}\u0000${back}`).digest('hex').slice(0, 12);
}

/** Same text, ignoring case and spacing -- used to spot cards that exist. */
function foldFront(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function clip(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Find the explicit question/answer structures in a note body.
 *
 * Returns proposals, never cards. Code fences are skipped entirely: a `##` in
 * a shell example is a comment, not a heading, and a card made from it would
 * be noise nobody asked for.
 */
function readNote(body) {
  const lines = String(body || '').split(/\r?\n/);
  const found = [];
  const uebersprungen = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const title = heading[2].trim();
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || HEADING_RE.test(lines[j]) || FENCE_RE.test(lines[j])) {
        uebersprungen.push({ grund: `Unter der Überschrift „${clip(title, 60)}“ steht kein Absatz.` });
        continue;
      }
      if (LIST_OR_QUOTE_RE.test(lines[j])) {
        uebersprungen.push({
          grund: `Unter „${clip(title, 60)}“ steht eine Liste oder ein Zitat, kein Absatz — daraus wird hier nichts gemacht.`,
        });
        continue;
      }
      const paragraph = [];
      while (j < lines.length && lines[j].trim() && !HEADING_RE.test(lines[j]) && !FENCE_RE.test(lines[j])) {
        paragraph.push(lines[j].trim());
        j++;
      }
      const back = paragraph.join(' ').trim();
      if (back.length > MAX_PROPOSAL_BACK) {
        uebersprungen.push({
          grund: `Der Absatz unter „${clip(title, 60)}“ ist mit ${back.length} Zeichen zu lang für eine Karte.`,
        });
        i = j - 1;
        continue;
      }
      found.push({ front: title, back, form: 'ueberschrift', zeile: i + 1 });
      i = j - 1;
      continue;
    }

    // `::` is unambiguous -- nothing in ordinary German prose uses it.
    const separator = SEPARATOR_RE.exec(line);
    if (separator && separator[1].trim() && separator[2].trim()) {
      found.push({
        front: separator[1].trim(),
        back: separator[2].trim(),
        form: 'trenner',
        zeile: i + 1,
      });
      continue;
    }

    // A bold term in front of the dash. The dash ALONE is deliberately not
    // enough: German prose in this vault is full of " — " inside sentences,
    // and a rule that fired on those would be guessing from Fliesstext.
    const definition = DEFINITION_RE.exec(line);
    if (definition && definition[1].trim() && definition[2].trim()) {
      found.push({
        front: definition[1].trim(),
        back: definition[2].trim(),
        form: 'definition',
        zeile: i + 1,
      });
    }
  }

  // Two proposals with the same question are one proposal; the first wins.
  const seen = new Set();
  const items = [];
  for (const entry of found) {
    const front = clip(entry.front, MAX_FRONT);
    const back = clip(entry.back, MAX_BACK);
    if (!front || !back) continue;
    const fold = foldFront(front);
    if (seen.has(fold)) continue;
    seen.add(fold);
    items.push({ ...entry, front, back, key: keyOf(front, back) });
  }
  return { items, uebersprungen };
}

/* ------------------------------------------------------------------ */
/* The subsystem                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {{store:object, bus?:object|null, config?:object, logger?:function,
 *          now?:function}} deps
 *        `now` returns the current Date and is injectable so tests can move
 *        through weeks without sleeping through them.
 */
function createStudy({ store, bus, config, logger, now } = {}) {
  if (!store || typeof store.create !== 'function' || typeof store.list !== 'function') {
    throw new ValidationError('createStudy benötigt einen Store.');
  }
  const log = typeof logger === 'function' ? logger('study') : nullLogger();
  const cfg = isPlainObject(config) ? (isPlainObject(config.study) ? config.study : config) : {};
  const clock = typeof now === 'function' ? now : () => new Date();

  function today() {
    return toDate(clock());
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`);
    }
  }

  /* ------------------------------------------------------------ reading */

  function allCards() {
    return store.all('card');
  }

  function mustCard(id) {
    const record = store.get(id);
    if (!record || record.type !== 'card') throw new NotFoundError(`Karte ${id}`);
    return record;
  }

  /** Never answered. Used for "gelernt", not for the queue. */
  function isNew(card) {
    return !card.data.lastReviewedAt;
  }

  /**
   * No schedule yet. That covers a fresh card and -- deliberately -- a card
   * whose `due` is not a day this code can read (an import, an older version).
   * Such a card would otherwise fall between the buckets and never be shown
   * again, which is the worst outcome a deck can produce.
   */
  function needsSchedule(card) {
    return dayOf(card.data.due) === null;
  }

  function isDue(card, todayKey) {
    const day = dayOf(card.data.due);
    return day !== null && day <= todayKey;
  }

  function deckOf(card) {
    const deck = typeof card.data.deck === 'string' && card.data.deck.trim() ? card.data.deck.trim() : DEFAULT_DECK;
    return deck;
  }

  /**
   * The queue: overdue first (the longest overdue at the front), then cards
   * never seen. Suspended cards are not in it at all -- that is what suspended
   * means, and a deck that quietly showed them anyway would make the switch a
   * decoration.
   */
  function due(opts = {}) {
    const at = opts.now === undefined ? today() : toDate(opts.now);
    const todayKey = dayKey(at);
    const limit = Number.isInteger(opts.limit) && opts.limit > 0
      ? Math.min(opts.limit, MAX_DUE_LIMIT)
      : (Number.isInteger(cfg.limit) && cfg.limit > 0 ? Math.min(cfg.limit, MAX_DUE_LIMIT) : DEFAULT_DUE_LIMIT);
    const deck = typeof opts.deck === 'string' && opts.deck.trim() ? opts.deck.trim() : null;

    const overdue = [];
    const fresh = [];
    let suspended = 0;
    let naechste = null;

    for (const card of allCards()) {
      if (card.data.suspended) { suspended++; continue; }
      if (deck && deckOf(card) !== deck) continue;
      if (isDue(card, todayKey)) {
        overdue.push(card);
        continue;
      }
      if (needsSchedule(card)) {
        fresh.push(card);
        continue;
      }
      const day = dayOf(card.data.due);
      if (day && (naechste === null || day < naechste)) naechste = day;
    }

    overdue.sort((a, b) => {
      const da = dayOf(a.data.due) || '';
      const db = dayOf(b.data.due) || '';
      if (da !== db) return da < db ? -1 : 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    fresh.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    const queue = [...overdue, ...fresh].slice(0, limit);
    return {
      items: queue.map((card) => ({ record: card, vorschau: preview(card.data, at) })),
      faellig: overdue.length,
      neu: fresh.length,
      ausgesetzt: suspended,
      naechste,
      deck,
      heute: todayKey,
      grenze: limit,
    };
  }

  function list(opts = {}) {
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, MAX_LIST_LIMIT) : 100;
    const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
    const deck = typeof opts.deck === 'string' && opts.deck.trim() ? opts.deck.trim() : null;
    const withSuspended = opts.includeSuspended !== false;

    const matched = allCards().filter((card) => {
      if (!withSuspended && card.data.suspended) return false;
      if (deck && deckOf(card) !== deck) return false;
      if (opts.noteId && card.data.noteId !== opts.noteId) return false;
      return true;
    });
    matched.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    return { items: matched.slice(offset, offset + limit), total: matched.length };
  }

  function decks() {
    const at = today();
    const todayKey = dayKey(at);
    const byName = new Map();
    for (const card of allCards()) {
      const name = deckOf(card);
      if (!byName.has(name)) byName.set(name, { name, gesamt: 0, faellig: 0, neu: 0, ausgesetzt: 0 });
      const entry = byName.get(name);
      entry.gesamt++;
      if (card.data.suspended) { entry.ausgesetzt++; continue; }
      if (isDue(card, todayKey)) entry.faellig++;
      else if (needsSchedule(card)) entry.neu++;
    }
    return Array.from(byName.values()).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /**
   * The numbers behind the deck. `gelernt` counts cards that were answered at
   * least once -- not cards somebody "mastered", because nothing here knows
   * that.
   */
  function stats() {
    const at = today();
    const todayKey = dayKey(at);
    const morgenKey = dayKey(addDays(at, 1));
    const out = {
      gesamt: 0, faellig: 0, neu: 0, gelernt: 0, morgen: 0, ausgesetzt: 0, nachStapel: [],
    };
    for (const card of allCards()) {
      out.gesamt++;
      if (card.data.suspended) { out.ausgesetzt++; continue; }
      if (!isNew(card)) out.gelernt++;
      if (isDue(card, todayKey)) out.faellig++;
      else if (needsSchedule(card)) out.neu++;
      if (dayOf(card.data.due) === morgenKey) out.morgen++;
    }
    out.nachStapel = decks();
    return out;
  }

  /* ----------------------------------------------------------- writing */

  function assertFront(value) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ValidationError('Eine Karte braucht eine Vorderseite.');
    }
    const front = value.trim();
    if (front.length > MAX_FRONT) {
      throw new ValidationError(`Die Vorderseite ist zu lang (${front.length} Zeichen, erlaubt sind ${MAX_FRONT}).`);
    }
    return front;
  }

  function assertBack(value) {
    const back = typeof value === 'string' ? value.trim() : '';
    if (back.length > MAX_BACK) {
      throw new ValidationError(`Die Rückseite ist zu lang (${back.length} Zeichen, erlaubt sind ${MAX_BACK}).`);
    }
    return back;
  }

  function assertDeck(value) {
    const deck = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_DECK;
    if (deck.length > MAX_DECK) {
      throw new ValidationError(`Der Stapelname ist zu lang (${deck.length} Zeichen, erlaubt sind ${MAX_DECK}).`);
    }
    return deck;
  }

  function create(data = {}, opts = {}) {
    const input = isPlainObject(data) ? data : {};
    const front = assertFront(input.front);
    const back = assertBack(input.back);
    const deck = assertDeck(input.deck);

    let noteId = null;
    if (input.noteId !== undefined && input.noteId !== null && input.noteId !== '') {
      if (typeof input.noteId !== 'string') throw new ValidationError('"noteId" muss ein Text sein.');
      const note = store.get(input.noteId);
      if (!note || note.type !== 'note') throw new NotFoundError(`Notiz ${input.noteId}`);
      noteId = note.id;
    }

    const record = store.create('card', {
      front,
      back,
      deck,
      noteId,
      source: opts.source || 'manual',
    });
    publish('study.card.created', { id: record.id, deck, noteId });
    return record;
  }

  /** Only what a person authored. The schedule belongs to the algorithm. */
  function update(id, patch = {}) {
    const card = mustCard(id);
    const input = isPlainObject(patch) ? patch : {};
    const forbidden = ['ease', 'intervalDays', 'due', 'reps', 'lapses', 'lastReviewedAt', 'lastGrade'];
    const touched = forbidden.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
    if (touched.length) {
      throw new ValidationError(
        `Der Lernstand (${touched.join(', ')}) wird vom Verfahren gesetzt und lässt sich nicht von Hand ändern.`,
        { fields: touched },
      );
    }
    const next = {};
    if (input.front !== undefined) next.front = assertFront(input.front);
    if (input.back !== undefined) next.back = assertBack(input.back);
    if (input.deck !== undefined) next.deck = assertDeck(input.deck);
    if (input.suspended !== undefined) {
      if (typeof input.suspended !== 'boolean') throw new ValidationError('"suspended" muss true oder false sein.');
      next.suspended = input.suspended;
      // Switching a card back on by hand ends the "source is gone" marking as
      // well; otherwise a restored note would suspend it a second time.
      if (input.suspended === false) next.orphanedAt = null;
    }
    if (!Object.keys(next).length) return card;
    return store.update(card.id, next);
  }

  function remove(id) {
    const card = mustCard(id);
    return store.remove(card.id);
  }

  function suspend(id, value = true) {
    if (typeof value !== 'boolean') throw new ValidationError('"suspended" muss true oder false sein.');
    return update(id, { suspended: value });
  }

  /**
   * Answer a card.
   *
   * A suspended card is refused rather than silently rescheduled: the user
   * took it out of the rotation, and a review would put it back without
   * anybody saying so.
   */
  function review(id, grade) {
    assertGrade(grade);
    const card = mustCard(id);
    if (card.data.suspended) {
      throw new ValidationError('Diese Karte ist ausgesetzt und wird nicht abgefragt. Nimm sie erst wieder auf.');
    }
    const at = today();
    const next = schedule(card.data, grade, at);
    const record = store.update(card.id, {
      ease: next.ease,
      intervalDays: next.intervalDays,
      due: next.due,
      reps: next.reps,
      lapses: next.lapses,
      lastReviewedAt: at.toISOString(),
      lastGrade: grade,
    });
    publish('study.reviewed', {
      id: record.id, grade, due: next.due, intervalDays: next.intervalDays,
    });
    return { record, vorschau: preview(record.data, at), wann: whenText(next.intervalDays) };
  }

  /* ------------------------------------------------------ from a note */

  function mustNote(noteId) {
    if (typeof noteId !== 'string' || !noteId) throw new ValidationError('"noteId" muss ein Text sein.');
    const note = store.get(noteId);
    if (!note || note.type !== 'note') throw new NotFoundError(`Notiz ${noteId}`);
    return note;
  }

  /**
   * The question sides this note already has cards for, folded.
   *
   * One function for the one question "gibt es die schon?", because the
   * proposal and the creation used to answer it separately -- and two answers
   * to the same question are exactly how a promise like "nichts doppelt"
   * quietly stops holding.
   */
  function frontsOfNote(noteId) {
    const fronts = new Set();
    for (const card of allCards()) {
      if (card.data.noteId === noteId) fronts.add(foldFront(card.data.front));
    }
    return fronts;
  }

  /**
   * What could become a card in this note -- proposals only, nothing written.
   *
   * Proposals that already exist as a card for this note are marked instead of
   * hidden: "I already made this one" is an answer, an item silently missing
   * from the list is not.
   */
  function proposeFromNote(noteId) {
    const note = mustNote(noteId);
    const { items, uebersprungen } = readNote(note.data.body);

    const existing = frontsOfNote(note.id);
    const vorschlaege = items.map((item) => ({
      ...item,
      schonVorhanden: existing.has(foldFront(item.front)),
    }));

    const offen = vorschlaege.filter((item) => !item.schonVorhanden).length;
    let hinweis = null;
    if (!vorschlaege.length) {
      hinweis = `In „${clip(note.data.title, 80)}“ steht keine der Formen, die hier erkannt werden. `
        + 'Aus Fließtext wird bewusst nichts geraten — eine Frage, die niemand so gestellt hat, ist keine Frage.';
    } else if (!offen) {
      hinweis = 'Für jeden gefundenen Abschnitt gibt es bereits eine Karte.';
    }

    return {
      note: { id: note.id, title: note.data.title },
      items: vorschlaege,
      offen,
      uebersprungen,
      formen: FORMEN,
      hinweis,
    };
  }

  /**
   * Create exactly the proposals the user ticked.
   *
   * `auswahl` holds the `key` of each proposal, not its position: the note may
   * have been edited since the list was shown, and an index would then silently
   * create a different card than the one that was ticked. A key that is no
   * longer there is named and refused.
   */
  function createFromNote(noteId, auswahl, opts = {}) {
    const note = mustNote(noteId);
    if (!Array.isArray(auswahl) || !auswahl.length) {
      throw new ValidationError('"auswahl" muss eine nicht leere Liste von Schlüsseln aus den Vorschlägen sein.');
    }
    const proposal = proposeFromNote(note.id);
    const byKey = new Map(proposal.items.map((item) => [item.key, item]));
    const deck = assertDeck(opts.deck);

    const wanted = [];
    const seen = new Set();
    for (const raw of auswahl) {
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new ValidationError('"auswahl" darf nur Schlüssel aus den Vorschlägen enthalten.');
      }
      const key = raw.trim();
      const item = byKey.get(key);
      if (!item) {
        throw new ValidationError(
          `Der Vorschlag ${clip(raw, 40)} steht nicht mehr in dieser Notiz. Sieh dir die Vorschläge noch einmal an.`,
          { key: raw },
        );
      }
      // Naming the same proposal twice is one wish, not two.
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push(item);
    }

    // Carried along instead of read from the snapshot: the moment a card is
    // made here it exists -- including for the next turn of this very loop.
    // Otherwise "nichts doppelt" would only hold BETWEEN requests.
    const vorhanden = frontsOfNote(note.id);
    const created = [];
    const uebersprungen = [];
    for (const item of wanted) {
      const fold = foldFront(item.front);
      if (vorhanden.has(fold)) {
        uebersprungen.push({ key: item.key, grund: `Für „${clip(item.front, 60)}“ gibt es bereits eine Karte.` });
        continue;
      }
      const card = create({ front: item.front, back: item.back, deck, noteId: note.id }, { source: 'note' });
      vorhanden.add(fold);
      created.push(card);
      linkToNote(card, note, item.form);
    }

    return { note: { id: note.id, title: note.data.title }, created, uebersprungen, deck };
  }

  /**
   * The card keeps a link to the note it came from.
   *
   * `source:'derived'` and not `'manual'`: the person chose WHICH cards to
   * make, but the link itself is the system's statement of provenance ("diese
   * Karte stammt aus dieser Notiz"), not a connection somebody drew between
   * two ideas. Keeping the two apart is the whole reason edges carry a source,
   * and `derived-from` is outside the kinds `graph/derive.js` reconciles, so
   * the link survives a rescan.
   */
  function linkToNote(card, note, form) {
    if (!store.edges || typeof store.edges.add !== 'function') return null;
    try {
      return store.edges.add({
        from: card.id,
        to: note.id,
        kind: 'derived-from',
        source: 'derived',
        reason: `Lernkarte aus dieser Notiz (${form === 'ueberschrift' ? 'Überschrift und Absatz' : 'Definitionszeile'}).`,
      });
    } catch (err) {
      // A card without its link is still a usable card; losing the card
      // because the link failed would not be.
      log.warn(`Verknüpfung Karte→Notiz fehlgeschlagen: ${err && err.message}`);
      return null;
    }
  }

  /* --------------------------------------------------- source deleted */

  function cardsOfNote(noteId) {
    return allCards().filter((card) => card.data.noteId === noteId);
  }

  /** See decision 4 at the top of this file. */
  function onNoteDeleted(noteId) {
    const affected = [];
    for (const card of cardsOfNote(noteId)) {
      if (card.data.suspended) continue;
      try {
        affected.push(store.update(card.id, { suspended: true, orphanedAt: new Date().toISOString() }));
      } catch (err) {
        log.warn(`Karte ${card.id} konnte nicht ausgesetzt werden: ${err && err.message}`);
      }
    }
    if (affected.length) {
      publish('study.orphaned', { noteId, cards: affected.map((card) => card.id) });
    }
    return affected;
  }

  /** Only cards this module suspended come back -- see decision 4. */
  function onNoteRestored(noteId) {
    const affected = [];
    for (const card of cardsOfNote(noteId)) {
      if (!card.data.orphanedAt) continue;
      try {
        affected.push(store.update(card.id, { suspended: false, orphanedAt: null }));
      } catch (err) {
        log.warn(`Karte ${card.id} konnte nicht wieder aufgenommen werden: ${err && err.message}`);
      }
    }
    return affected;
  }

  const listeners = [];

  function subscribe() {
    if (!bus || typeof bus.on !== 'function') return;
    const onDeleted = (event) => {
      const payload = (event && event.payload) || {};
      if (payload.type !== 'note' || !payload.id) return;
      try { onNoteDeleted(payload.id); } catch (err) { log.warn(`study/record.deleted: ${err && err.message}`); }
    };
    const onUpdated = (event) => {
      const payload = (event && event.payload) || {};
      if (payload.type !== 'note' || !payload.id || !payload.restored) return;
      try { onNoteRestored(payload.id); } catch (err) { log.warn(`study/record.updated: ${err && err.message}`); }
    };
    bus.on('record.deleted', onDeleted);
    bus.on('record.updated', onUpdated);
    listeners.push(() => bus.off('record.deleted', onDeleted));
    listeners.push(() => bus.off('record.updated', onUpdated));
  }

  /** Stop listening. Used by tests and by an orderly shutdown. */
  function stop() {
    while (listeners.length) {
      const off = listeners.pop();
      try { off(); } catch { /* already gone */ }
    }
  }

  subscribe();

  return {
    // pure, exported for the interface and for tests
    schedule,
    preview,
    GRADES,
    GRADE_LABELS,
    MIN_EASE,
    MAX_INTERVAL_DAYS,

    // deck
    due,
    list,
    decks,
    stats,

    // cards
    create,
    update,
    remove,
    suspend,
    review,

    // notes
    proposeFromNote,
    createFromNote,
    formen: () => FORMEN.slice(),

    // lifecycle
    stop,
  };
}

module.exports = {
  createStudy,
  schedule,
  preview,
  readNote,
  GRADES,
  GRADE_LABELS,
  EASE_DELTA,
  MIN_EASE,
  MAX_EASE,
  DEFAULT_EASE,
  MAX_INTERVAL_DAYS,
  FIRST_INTERVAL_DAYS,
  SECOND_INTERVAL_DAYS,
  FORMEN,
  dayKey,
  addDays,
};
