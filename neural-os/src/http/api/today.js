'use strict';

/**
 * Der Tagesbeginn: the one screen a person looks at in the morning.
 *
 * Why one gathering route instead of five calls from the view
 * ----------------------------------------------------------
 * The five answers this screen needs already exist, spread over tasks,
 * activity, suggestions, the change journal and the two clocks. A view that
 * fetched them separately would have to decide, five times over and in the
 * browser, what a 503 means -- and would end up showing four blocks and a gap
 * where the fifth should be. Gathering them here means the *server* decides
 * once, and the view is handed one object that is either complete or says
 * where it is not.
 *
 * Why it writes nothing
 * ---------------------
 * A screen you only look at must not change what it reports on. Not one call
 * below creates, updates or deletes a record -- no scan is started, no
 * suggestion is refreshed, no schedule is ticked. That is also what makes it
 * safe to open it again and again: the second look shows the same morning as
 * the first.
 *
 * Why every block says `stand` before it says anything else
 * ----------------------------------------------------------
 * "Nichts steht an" and "ich konnte nicht nachsehen" are different statements,
 * and an empty block cannot tell them apart. Every subsystem here is optional
 * (src/app.js builds each one with `optional()`), so each block is fetched
 * behind its own guard -- and hands back `{ stand, wert, grund }` rather than
 * a bare value with the reason filed away somewhere else.
 *
 * That shape is not decoration. While the reasons lived in a separate
 * `fehlend` list, every block had to remember, on its own, to go and read it;
 * two of six forgot. One then announced "Die Automatik ist aus" although one
 * of the two clocks had never answered, and another threw away runs it had
 * already read because a *different* source under the same name was missing.
 * With `stand` travelling inside the block, neither is expressible: a reader
 * has to walk past it to reach the value.
 *
 * Only the store is non-negotiable -- without it there is no vault to report
 * on at all.
 */

const { NeuralError } = require('../../kernel/errors');
const {
  need,
  unavailable,
  intParam,
} = require('./support');

/** The open states, as everywhere else in this system. */
const OPEN_STATES = new Set(['todo', 'doing', 'blocked']);

/** The record types "seit gestern" looks at -- same list as `activity.recent`. */
const ACTIVITY_TYPES = ['note', 'task', 'project', 'chat', 'file', 'entity', 'run'];

/** How far ahead "demnächst" reaches, in days. */
const SOON_DAYS = 7;

const DAY_MS = 86400000;

/**
 * Upper bounds for the lists; the true counts travel alongside them, and so
 * does `gekuerzt` -- see `gekuerztAb()`.
 *
 * `ACTIVITY_MAX` is here rather than in the view for the same reason as the
 * others: whoever cuts a list is the one who can say how much was cut. As long
 * as the view trimmed "Seit gestern" a second time, on its own, no number the
 * route sent about that list described what was on the screen.
 */
const REVISIT_MAX = 3;
const RUN_MAX = 20;
const SUGGESTION_MAX = 5;
const ACTIVITY_MAX = 6;

/**
 * How many journal entries to read before filtering. The journal itself caps
 * reads at 500, and a day's worth of agent writes is far below that -- but
 * when it is not, `ohneDich.verlaufGekuerzt` says so rather than quietly
 * reporting a smaller night than really happened.
 */
const HISTORY_READ = 500;

/**
 * How long a note lies untouched before it is a Wiedervorlage.
 *
 * Read from the revisit detector so the number cannot drift apart from the
 * one the Vorschläge use for the same judgement. Guarded, because src/assist
 * is an optional part: a trimmed installation must not make this route fail
 * at require time, which would take the whole server with it.
 */
const REVISIT_MIN_AGE_DAYS = (() => {
  try {
    const value = require('../../assist/detectors').REVISIT_MIN_AGE_DAYS;
    return Number.isFinite(value) ? value : 90;
  } catch {
    return 90;
  }
})();

/* ---------------------------------------------------------------- helpers */

/** Local midnight of the day `ms` falls into. */
function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * When a task is due, in milliseconds, or null.
 *
 * A bare `2026-09-21` is read as that day in LOCAL time, not as UTC midnight.
 * `Date.parse` would do the latter, and then a task due today would show up as
 * overdue for everyone west of Greenwich -- on a screen whose whole job is to
 * say what is due *today*, that is the one thing it must get right.
 */
function dueAt(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (DATE_ONLY.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Soonest and most important first -- the same order `tasks.list` in
 * src/agents/tools.js produces, so the agent and this screen never disagree
 * about which task is the next one. The one deliberate difference is `dueAt`
 * above; it changes nothing about the order of comparable dates.
 */
function bySoonest(a, b) {
  const ad = dueAt(a.data.due);
  const bd = dueAt(b.data.due);
  const av = ad === null ? Infinity : ad;
  const bv = bd === null ? Infinity : bd;
  if (av !== bv) return av - bv;
  return (a.data.priority || 2) - (b.data.priority || 2);
}

function taskOut(record) {
  return {
    id: record.id,
    title: record.data.title,
    status: record.data.status,
    due: record.data.due,
    priority: record.data.priority,
    projectId: record.data.projectId,
  };
}

/** A label for any record; uses the graph's own if this instance has one. */
function labelerFor(ctx) {
  const graph = ctx && ctx.graph;
  return function labelOf(record) {
    if (graph && typeof graph.label === 'function') {
      try {
        return graph.label(record);
      } catch {
        /* a broken labeller must not cost us the whole block */
      }
    }
    const data = record.data || {};
    return data.title || data.name || data.text || data.goal || record.id;
  };
}

/* ------------------------------------------------- what was actually asked */

/**
 * The three things a block can be, and there is no fourth.
 *
 *   gemessen   asked and answered in full; `grund` is null.
 *   teilweise  one source answered, another did not. `wert` holds what WAS
 *              found and is shown; `grund` says what is missing from it.
 *   unbekannt  nothing to be had; `wert` is only the agreed stand-in and
 *              means nothing.
 *
 * The distinction that matters most is the middle one. It is the state the
 * old shape could not express, and both places where this route claimed
 * something it had not measured were sitting in it.
 */
function gemessen(wert) {
  return { stand: 'gemessen', wert, grund: null };
}

function teilweise(wert, grund) {
  return { stand: 'teilweise', wert, grund };
}

function unbekannt(wert, grund) {
  return { stand: 'unbekannt', wert, grund };
}

/** The reason a source failed, as the German sentence it threw. */
function grundVon(err) {
  return (err && err.message) || String(err);
}

/**
 * Run one block that has a single source. Whatever it throws becomes the
 * reason -- one absent subsystem must never cost the other five blocks.
 *
 * @param {*} fallback   what that block looks like when we could not look
 * @param {() => *} run
 */
function messen(fallback, run) {
  try {
    return gemessen(run());
  } catch (err) {
    return unbekannt(fallback, grundVon(err));
  }
}

/**
 * A block with two sources: measured when both answered, `teilweise` when one
 * did, `unbekannt` when neither did.
 *
 * @param {*} wert       what the sources that answered produced
 * @param {number} gefragt  how many sources answered
 * @param {string[]} gruende  one sentence per source that did not
 */
function ausTeilen(wert, gefragt, gruende) {
  if (!gruende.length) return gemessen(wert);
  const grund = gruende.join(' ');
  return gefragt ? teilweise(wert, grund) : unbekannt(wert, grund);
}

/**
 * How much of a list actually made it into the answer, or null when nothing
 * was left out.
 *
 * The subtraction belongs here and not in the view. While it was the view's,
 * it was written four times over, and two of the four had simply been
 * forgotten -- with the badge next to them still naming the true count. A
 * number that belongs to no visible set is, on a screen whose only job is
 * counting, a plain falsehood.
 */
function gekuerztAb(gezeigt, gesamt) {
  return gesamt > gezeigt ? { gezeigt, gesamt, weitere: gesamt - gezeigt } : null;
}

/** The subsystem, or a throw carrying the same German sentence a 503 would. */
function subsystem(value, method, label, hint) {
  if (!value || typeof value[method] !== 'function') throw unavailable(label, hint);
  return value;
}

/**
 * Same, but with the sentence written out.
 *
 * `unavailable()` builds "<Label> ist in dieser Instanz nicht verfügbar", which
 * is wrong for a plural subject -- and "Die Auslöser ist nicht verfügbar" on a
 * screen whose whole point is calm, plain German is exactly the kind of detail
 * that makes a system feel machine-written.
 */
function subsystemSaying(value, method, satz) {
  if (!value || typeof value[method] !== 'function') {
    throw new NeuralError('SUBSYSTEM_UNAVAILABLE', satz, { status: 503 });
  }
  return value;
}

/* ----------------------------------------------------------------- blocks */

/**
 * What is due.
 *
 * Only open tasks with a date can be "fällig" -- a task without one is not due
 * today, it is simply undated, and counting it as due would turn a to-do list
 * into a permanent alarm. It is counted separately so the view can say it out
 * loud instead of pretending those tasks do not exist.
 */
function faelligBlock(store, now, limit) {
  const todayStart = startOfDay(now);
  const todayEnd = todayStart + DAY_MS;
  const soonEnd = todayEnd + SOON_DAYS * DAY_MS;

  const ueberfaellig = [];
  const heute = [];
  const demnaechst = [];
  let ohneDatum = 0;
  let spaeter = 0;

  const open = store.all('task').filter((r) => OPEN_STATES.has(r.data.status));
  open.sort(bySoonest);

  for (const record of open) {
    const due = dueAt(record.data.due);
    if (due === null) { ohneDatum += 1; continue; }
    if (due < todayStart) ueberfaellig.push(record);
    else if (due < todayEnd) heute.push(record);
    else if (due < soonEnd) demnaechst.push(record);
    else spaeter += 1;
  }

  const gezeigt = {
    ueberfaellig: ueberfaellig.slice(0, limit),
    heute: heute.slice(0, limit),
    demnaechst: demnaechst.slice(0, limit),
  };

  return {
    ueberfaellig: gezeigt.ueberfaellig.map(taskOut),
    heute: gezeigt.heute.map(taskOut),
    demnaechst: gezeigt.demnaechst.map(taskOut),
    // The true numbers, which the lists above may be shorter than.
    anzahl: {
      ueberfaellig: ueberfaellig.length,
      heute: heute.length,
      demnaechst: demnaechst.length,
      ohneDatum,
      spaeter,
    },
    // ... and by exactly how much, counted over the three lists together,
    // because that is what the block puts on the screen.
    gekuerzt: gekuerztAb(
      gezeigt.ueberfaellig.length + gezeigt.heute.length + gezeigt.demnaechst.length,
      ueberfaellig.length + heute.length + demnaechst.length,
    ),
  };
}

/** What changed since the cut-off -- the same idea as `activity.recent`. */
function seitGesternBlock(store, sinceMs, limit, labelOf) {
  const items = store.list(ACTIVITY_TYPES, { limit: undefined }).items
    .filter((r) => Date.parse(r.updatedAt) >= sinceMs)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const nachArt = {};
  for (const r of items) nachArt[r.type] = (nachArt[r.type] || 0) + 1;

  const gezeigt = items.slice(0, Math.min(limit, ACTIVITY_MAX));

  return {
    gesamt: items.length,
    nachArt,
    eintraege: gezeigt.map((r) => ({
      id: r.id,
      type: r.type,
      label: labelOf(r),
      updatedAt: r.updatedAt,
      neu: Date.parse(r.createdAt) >= sinceMs,
    })),
    gekuerzt: gekuerztAb(gezeigt.length, items.length),
  };
}

/** What the system proposed and nobody has decided yet. */
function vorschlaegeBlock(value) {
  // Both methods are checked, so a half-built assist answers with the German
  // 503 sentence rather than with a TypeError wearing its costume.
  const assist = subsystem(subsystem(value, 'list', 'Die Assistenz'), 'stats', 'Die Assistenz');
  const stats = assist.stats();
  const listed = assist.list({ status: 'open', limit: SUGGESTION_MAX });
  const offen = Number.isFinite(stats.open) ? stats.open : listed.total;
  // Sorted by confidence by the engine itself; the top few are enough here.
  const oben = listed.items.map((rec) => ({
    id: rec.id,
    kind: rec.data.kind,
    title: rec.data.title,
    reason: rec.data.reason,
    confidence: rec.data.confidence,
    recordIds: rec.data.recordIds || [],
  }));
  return {
    offen,
    nachArt: stats.byKind || {},
    oben,
    gekuerzt: gekuerztAb(oben.length, offen),
  };
}

/**
 * Attribution that really covers THIS change.
 *
 * `actorOf()` in src/store/history.js has two sources. `via: 'kontext'` is the
 * actor carried through the call chain and says who made this very change.
 * `via: 'stempel'` is the provenance stamp, which is written when a record is
 * *created* -- so on a later update it only says who wrote the record
 * originally, and a note an agent wrote and the user then edited would look
 * like the agent edited it. A morning screen that answered "lief da etwas ohne
 * mich?" with the user's own edits would be worse than useless, so those are
 * not listed; they are counted as `unsicher` instead.
 */
function reallyAgent(entry) {
  const actor = entry.actor || {};
  if (actor.kind !== 'agent') return false;
  if (actor.via === 'kontext') return true;
  return entry.op === 'create';
}

/**
 * What ran while nobody was watching.
 *
 * Stated plainly: a `run` record does not say who started it, so this list is
 * "Agentenläufe seit dem Schnitt", not "Läufe, die du nicht selbst angestoßen
 * hast". Inferring the second from the first would be a guess, and the block
 * exists precisely because guesses about who did what are not good enough.
 */
function ohneDichBlock(ctx, sinceMs, sinceIso, limit) {
  const wert = {
    laeufe: [],
    laeufeGesamt: 0,
    aenderungen: [],
    gesamt: 0,
    unsicher: 0,
    verlaufGekuerzt: false,
    gekuerzt: null,
  };
  const gruende = [];
  let gefragt = 0;

  // The runs come straight from the store; the journal below is its own
  // subsystem and may be absent on its own, so the two are guarded apart --
  // and a failure of one leaves the other's rows standing. They used to share
  // one name in `fehlend`, and the view then wiped both for one reason.
  try {
    const store = ctx.store;
    const names = new Map();
    for (const agent of store.all('agent')) names.set(agent.id, agent.data.name || null);

    const runs = store.all('run')
      .filter((r) => Date.parse(r.data.startedAt || r.createdAt) >= sinceMs)
      .sort((a, b) => Date.parse(b.data.startedAt || b.createdAt) - Date.parse(a.data.startedAt || a.createdAt));

    wert.laeufe = runs.slice(0, Math.min(limit, RUN_MAX)).map((r) => ({
      id: r.id,
      agentId: r.data.agentId,
      agent: names.has(r.data.agentId) ? names.get(r.data.agentId) : null,
      goal: r.data.goal,
      status: r.data.status,
      startedAt: r.data.startedAt,
      finishedAt: r.data.finishedAt,
      schritte: Array.isArray(r.data.steps) ? r.data.steps.length : 0,
      produziert: Array.isArray(r.data.producedIds) ? r.data.producedIds.length : 0,
      netz: r.data.usedNetwork === true,
    }));
    wert.laeufeGesamt = runs.length;
    gefragt += 1;
  } catch (err) {
    gruende.push(grundVon(err));
  }

  try {
    const history = subsystem(
      ctx.history,
      'list',
      'Der Änderungsverlauf',
      'Er wird beim Start zusammen mit dem Speicher aufgebaut.',
    ).list({ actor: 'agent', since: sinceIso, limit: HISTORY_READ });

    const entries = (history.items || []).filter(reallyAgent);
    wert.gesamt = entries.length;
    wert.unsicher = (history.items || []).length - entries.length;
    // A different cut from `gekuerzt`: not "more than fits on the screen" but
    // "more than we even read". Two axes, and folding them into one would lose
    // the difference between a long morning and a full journal.
    wert.verlaufGekuerzt = Number.isFinite(history.total) && history.total > (history.items || []).length;
    wert.aenderungen = entries.slice(0, limit).map((entry) => ({
      seq: entry.seq,
      at: entry.at,
      op: entry.op,
      id: entry.id,
      type: entry.type,
      label: entry.label,
      agentId: (entry.actor && entry.actor.agentId) || null,
      runId: (entry.actor && entry.actor.runId) || null,
    }));
    gefragt += 1;
  } catch (err) {
    gruende.push(grundVon(err));
  }

  wert.gekuerzt = gekuerztAb(
    wert.laeufe.length + wert.aenderungen.length,
    wert.laeufeGesamt + wert.gesamt,
  );

  return ausTeilen(wert, gefragt, gruende);
}

/**
 * The two clocks.
 *
 * `eingeschaltet: null` means "konnte nicht nachsehen" and is deliberately not
 * `false`: a screen that reported a stopped clock when it simply could not ask
 * would be the most misleading thing on this page.
 *
 * The two answers are not symmetric, and that is the whole point:
 *
 * - `true` needs ONE clock that answered and is running. Having seen a running
 *   schedule is a measurement; the other clock cannot take it back.
 * - `false` needs BOTH. "Nichts läuft von allein" is a statement about the
 *   whole machine, and a clock that never answered may well be ticking. This
 *   is exactly where a missing scheduler used to be counted as a stopped one.
 */
function automatikBlock(ctx) {
  const wert = { eingeschaltet: null, naechster: null, zeitplaene: null, ausloeser: null };
  const gruende = [];
  let gefragt = 0;
  let laeuftEtwas = false;

  // Kein `hint` hier: die Gründe stehen auf diesem Bildschirm in einer Zeile
  // nebeneinander, und zwei Aufbauhinweise machen daraus einen Absatz.
  try {
    const zeitplaene = subsystemSaying(
      ctx.scheduler,
      'status',
      'Die Zeitplanung ist in dieser Instanz nicht verfügbar.',
    ).status();
    gefragt += 1;
    wert.zeitplaene = {
      laeuft: zeitplaene.running === true,
      eingeschaltet: zeitplaene.enabled || 0,
      gesamt: zeitplaene.total || 0,
    };
    // Only the scheduler knows about a next run. If it did not answer,
    // `naechster` stays null and the view says nothing about it at all --
    // "steht nicht fest" would be an answer nobody gave.
    wert.naechster = zeitplaene.nextDue || null;
    laeuftEtwas = laeuftEtwas || (wert.zeitplaene.laeuft && wert.zeitplaene.eingeschaltet > 0);
  } catch (err) {
    gruende.push(grundVon(err));
  }

  try {
    const ausloeser = subsystemSaying(
      ctx.triggers,
      'status',
      'Die Auslöser sind in dieser Instanz nicht verfügbar.',
    ).status();
    gefragt += 1;
    wert.ausloeser = {
      laeuft: ausloeser.running === true,
      eingeschaltet: ausloeser.enabled || 0,
      gesamt: ausloeser.total || 0,
      letzteStunde: ausloeser.firedLastHour || 0,
    };
    laeuftEtwas = laeuftEtwas || (wert.ausloeser.laeuft && wert.ausloeser.eingeschaltet > 0);
  } catch (err) {
    gruende.push(grundVon(err));
  }

  if (laeuftEtwas) wert.eingeschaltet = true;
  else if (gefragt === 2) wert.eingeschaltet = false;

  return ausTeilen(wert, gefragt, gruende);
}

/**
 * The note that has been lying there.
 *
 * Computed from the store rather than read out of the open suggestions, for
 * one reason: this screen has to work on the first morning, before anybody has
 * ever pressed "Prüfen". The threshold is the revisit detector's own, so the
 * two never contradict each other about what counts as "lange her".
 */
function wiedervorlageBlock(store, now, labelOf) {
  const cutoff = now - REVISIT_MIN_AGE_DAYS * DAY_MS;
  const candidates = store.all('note')
    .filter((note) => Date.parse(note.updatedAt) <= cutoff)
    .sort((a, b) => {
      // Pinned first: pinning is the strongest signal a person ever gives
      // about a note, and the revisit detector weighs it the same way.
      const ap = a.data.pinned === true ? 0 : 1;
      const bp = b.data.pinned === true ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const at = Date.parse(a.updatedAt);
      const bt = Date.parse(b.updatedAt);
      if (at !== bt) return at - bt;
      // Two notes written in the same millisecond still have to come out in
      // the same order every morning, or the block would quietly reshuffle.
      return a.id < b.id ? -1 : 1;
    });

  const notizen = candidates.slice(0, REVISIT_MAX).map((note) => {
    const tage = Math.floor((now - Date.parse(note.updatedAt)) / DAY_MS);
    return {
      id: note.id,
      label: labelOf(note),
      updatedAt: note.updatedAt,
      tage,
      angeheftet: note.data.pinned === true,
      grund: note.data.pinned === true
        ? `Angeheftet und seit ${tage} Tagen nicht mehr geändert.`
        : `Seit ${tage} Tagen nicht mehr geändert.`,
    };
  });

  // Three is a reminder; thirty is a filing cabinet. But a list cut at three
  // without a word is the same silent trimming as everywhere else, so the
  // remainder is named too.
  return { notizen, gekuerzt: gekuerztAb(notizen.length, candidates.length) };
}

/* ------------------------------------------------------------------ route */

function register(router) {
  router.get('/api/today', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');

    const now = Date.now();
    // "Seit gestern" is a window, not a calendar day: somebody who looks at
    // this at nine in the morning wants what happened since yesterday morning,
    // not since midnight. The cut-off travels in the answer so the view can
    // name it instead of guessing what the server meant.
    const stunden = intParam(rc.query, 'stunden', 24, 1, 24 * 7);
    const limit = intParam(rc.query, 'limit', 20, 1, 100);
    const sinceMs = now - stunden * 3600000;
    const sinceIso = new Date(sinceMs).toISOString();

    const labelOf = labelerFor(rc.ctx);

    const bloecke = {
      faellig: messen(
        {
          ueberfaellig: [],
          heute: [],
          demnaechst: [],
          anzahl: { ueberfaellig: 0, heute: 0, demnaechst: 0, ohneDatum: 0, spaeter: 0 },
          gekuerzt: null,
        },
        () => faelligBlock(store, now, limit),
      ),

      seitGestern: messen(
        { gesamt: 0, nachArt: {}, eintraege: [], gekuerzt: null },
        () => seitGesternBlock(store, sinceMs, limit, labelOf),
      ),

      vorschlaege: messen(
        { offen: 0, nachArt: {}, oben: [], gekuerzt: null },
        () => vorschlaegeBlock(rc.ctx.assist),
      ),

      ohneDich: ohneDichBlock(rc.ctx, sinceMs, sinceIso, limit),

      automatik: automatikBlock(rc.ctx),

      wiedervorlage: messen(
        { notizen: [], gekuerzt: null },
        () => wiedervorlageBlock(store, now, labelOf),
      ),
    };

    return {
      at: new Date(now).toISOString(),
      seit: sinceIso,
      stunden,
      ...bloecke,
      fehlend: fehlendAus(bloecke),
    };
  });
}

/**
 * Dieselbe Auskunft flach: was nicht (ganz) zu erfahren war, auf einen Blick.
 *
 * Abgeleitet und nicht gepflegt. Eine zweite, von Hand geführte Liste kann dem
 * `stand` der Blöcke widersprechen, und genau das ist hier passiert: der Grund
 * stand in `fehlend`, der Wert log daneben weiter. `stand` steht mit dabei,
 * damit „teilweise" hier nicht als „nichts gesehen" gelesen werden kann.
 */
function fehlendAus(bloecke) {
  const out = [];
  for (const teil of Object.keys(bloecke)) {
    const b = bloecke[teil];
    if (b.grund) out.push({ teil, stand: b.stand, grund: b.grund });
  }
  return out;
}

module.exports = {
  register,
  /**
   * Exported for the tests.
   *
   * `wiedervorlageBlock` is here because it is the one judgement that cannot
   * be reached through HTTP: the store stamps `updatedAt` with the current
   * time and offers no way to backdate it, so a note ninety days old cannot be
   * created in a test. The function already takes `now` as an argument, so it
   * is checked directly with a `now` far enough ahead -- which is the same
   * seam `assist.scan({ now })` uses for the same reason.
   */
  dueAt,
  reallyAgent,
  wiedervorlageBlock,
  labelerFor,
  REVISIT_MIN_AGE_DAYS,
  SOON_DAYS,
};
