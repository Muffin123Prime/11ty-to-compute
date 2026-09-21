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
 * Why a missing subsystem lands in `fehlend`
 * ------------------------------------------
 * "Nichts steht an" and "ich konnte nicht nachsehen" are different statements,
 * and an empty block cannot tell them apart. Every subsystem here is optional
 * (src/app.js builds each one with `optional()`), so each block is fetched
 * behind its own guard: what is missing or throws is named in `fehlend` with
 * the reason, and the rest of the morning still arrives. Only the store is
 * non-negotiable -- without it there is no vault to report on at all.
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

/** Upper bounds for the lists; the true counts travel alongside them. */
const REVISIT_MAX = 3;
const RUN_MAX = 20;
const SUGGESTION_MAX = 5;

/**
 * How many journal entries to read before filtering. The journal itself caps
 * reads at 500, and a day's worth of agent writes is far below that -- but
 * when it is not, `ohneDich.gekuerzt` says so rather than quietly reporting a
 * smaller night than really happened.
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

/**
 * Run one block. Whatever it throws is turned into an entry in `fehlend` and
 * the agreed fallback value -- one absent subsystem must never cost the other
 * four blocks.
 *
 * @param {Array<{teil:string, grund:string}>} fehlend
 * @param {string} teil  the block in the answer this reason belongs to
 * @param {*} fallback   what that block looks like when we could not look
 * @param {() => *} run
 */
function block(fehlend, teil, fallback, run) {
  try {
    return run();
  } catch (err) {
    fehlend.push({ teil, grund: (err && err.message) || String(err) });
    return fallback;
  }
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

  return {
    ueberfaellig: ueberfaellig.slice(0, limit).map(taskOut),
    heute: heute.slice(0, limit).map(taskOut),
    demnaechst: demnaechst.slice(0, limit).map(taskOut),
    // The true numbers, which the lists above may be shorter than.
    anzahl: {
      ueberfaellig: ueberfaellig.length,
      heute: heute.length,
      demnaechst: demnaechst.length,
      ohneDatum,
      spaeter,
    },
  };
}

/** What changed since the cut-off -- the same idea as `activity.recent`. */
function seitGesternBlock(store, sinceMs, limit, labelOf) {
  const items = store.list(ACTIVITY_TYPES, { limit: undefined }).items
    .filter((r) => Date.parse(r.updatedAt) >= sinceMs)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const nachArt = {};
  for (const r of items) nachArt[r.type] = (nachArt[r.type] || 0) + 1;

  return {
    gesamt: items.length,
    nachArt,
    eintraege: items.slice(0, limit).map((r) => ({
      id: r.id,
      type: r.type,
      label: labelOf(r),
      updatedAt: r.updatedAt,
      neu: Date.parse(r.createdAt) >= sinceMs,
    })),
  };
}

/** What the system proposed and nobody has decided yet. */
function vorschlaegeBlock(value) {
  // Both methods are checked, so a half-built assist answers with the German
  // 503 sentence rather than with a TypeError wearing its costume.
  const assist = subsystem(subsystem(value, 'list', 'Die Assistenz'), 'stats', 'Die Assistenz');
  const stats = assist.stats();
  const listed = assist.list({ status: 'open', limit: SUGGESTION_MAX });
  return {
    offen: Number.isFinite(stats.open) ? stats.open : listed.total,
    nachArt: stats.byKind || {},
    // Sorted by confidence by the engine itself; the top few are enough here.
    oben: listed.items.map((rec) => ({
      id: rec.id,
      kind: rec.data.kind,
      title: rec.data.title,
      reason: rec.data.reason,
      confidence: rec.data.confidence,
      recordIds: rec.data.recordIds || [],
    })),
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
function ohneDichBlock(ctx, sinceMs, sinceIso, limit, fehlend) {
  const out = {
    laeufe: [], laeufeGesamt: 0, aenderungen: [], gesamt: 0, unsicher: 0, gekuerzt: false,
  };

  // The runs come straight from the store; the journal below is its own
  // subsystem and may be absent on its own, so the two are guarded apart.
  block(fehlend, 'ohneDich', null, () => {
    const store = ctx.store;
    const names = new Map();
    for (const agent of store.all('agent')) names.set(agent.id, agent.data.name || null);

    const runs = store.all('run')
      .filter((r) => Date.parse(r.data.startedAt || r.createdAt) >= sinceMs)
      .sort((a, b) => Date.parse(b.data.startedAt || b.createdAt) - Date.parse(a.data.startedAt || a.createdAt));

    out.laeufe = runs.slice(0, Math.min(limit, RUN_MAX)).map((r) => ({
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
    out.laeufeGesamt = runs.length;
    return true;
  });

  const history = block(fehlend, 'ohneDich', null, () => subsystem(
    ctx.history,
    'list',
    'Der Änderungsverlauf',
    'Er wird beim Start zusammen mit dem Speicher aufgebaut.',
  ).list({ actor: 'agent', since: sinceIso, limit: HISTORY_READ }));

  if (!history) return out;

  const entries = (history.items || []).filter(reallyAgent);
  out.gesamt = entries.length;
  out.unsicher = (history.items || []).length - entries.length;
  out.gekuerzt = Number.isFinite(history.total) && history.total > (history.items || []).length;
  out.aenderungen = entries.slice(0, limit).map((entry) => ({
    seq: entry.seq,
    at: entry.at,
    op: entry.op,
    id: entry.id,
    type: entry.type,
    label: entry.label,
    agentId: (entry.actor && entry.actor.agentId) || null,
    runId: (entry.actor && entry.actor.runId) || null,
  }));
  return out;
}

/**
 * The two clocks.
 *
 * `eingeschaltet: null` means "konnte nicht nachsehen" and is deliberately not
 * `false`: a screen that reported a stopped clock when it simply could not ask
 * would be the most misleading thing on this page.
 */
function automatikBlock(ctx, fehlend) {
  const out = { eingeschaltet: null, naechster: null, zeitplaene: null, ausloeser: null };
  let asked = 0;

  // Kein `hint` hier: die Gründe stehen auf diesem Bildschirm in einer Zeile
  // nebeneinander, und zwei Aufbauhinweise machen daraus einen Absatz.
  const zeitplaene = block(fehlend, 'automatik', null, () => subsystemSaying(
    ctx.scheduler,
    'status',
    'Die Zeitplanung ist in dieser Instanz nicht verfügbar.',
  ).status());

  if (zeitplaene) {
    asked += 1;
    out.zeitplaene = {
      laeuft: zeitplaene.running === true,
      eingeschaltet: zeitplaene.enabled || 0,
      gesamt: zeitplaene.total || 0,
    };
    out.naechster = zeitplaene.nextDue || null;
  }

  const ausloeser = block(fehlend, 'automatik', null, () => subsystemSaying(
    ctx.triggers,
    'status',
    'Die Auslöser sind in dieser Instanz nicht verfügbar.',
  ).status());

  if (ausloeser) {
    asked += 1;
    out.ausloeser = {
      laeuft: ausloeser.running === true,
      eingeschaltet: ausloeser.enabled || 0,
      gesamt: ausloeser.total || 0,
      letzteStunde: ausloeser.firedLastHour || 0,
    };
  }

  if (asked) {
    out.eingeschaltet = (out.zeitplaene ? out.zeitplaene.laeuft && out.zeitplaene.eingeschaltet > 0 : false)
      || (out.ausloeser ? out.ausloeser.laeuft && out.ausloeser.eingeschaltet > 0 : false);
  }
  return out;
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

  return candidates.slice(0, REVISIT_MAX).map((note) => {
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

    const fehlend = [];
    const labelOf = labelerFor(rc.ctx);

    const faellig = block(fehlend, 'faellig',
      { ueberfaellig: [], heute: [], demnaechst: [], anzahl: { ueberfaellig: 0, heute: 0, demnaechst: 0, ohneDatum: 0, spaeter: 0 } },
      () => faelligBlock(store, now, limit));

    const seitGestern = block(fehlend, 'seitGestern',
      { gesamt: 0, nachArt: {}, eintraege: [] },
      () => seitGesternBlock(store, sinceMs, limit, labelOf));

    const vorschlaege = block(fehlend, 'vorschlaege',
      { offen: 0, nachArt: {}, oben: [] },
      () => vorschlaegeBlock(rc.ctx.assist));

    const ohneDich = ohneDichBlock(rc.ctx, sinceMs, sinceIso, limit, fehlend);

    const automatik = automatikBlock(rc.ctx, fehlend);

    const wiedervorlage = block(fehlend, 'wiedervorlage', [],
      () => wiedervorlageBlock(store, now, labelOf));

    return {
      at: new Date(now).toISOString(),
      seit: sinceIso,
      stunden,
      faellig,
      seitGestern,
      vorschlaege,
      ohneDich,
      automatik,
      wiedervorlage,
      fehlend,
    };
  });
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
