'use strict';

/**
 * The deck: what is due, what a card is worth, and where cards come from.
 *
 * Two things worth saying out loud:
 *
 * 1. **A review is a write.** It changes `ease`, `due` and the counters, and
 *    those are the only state this feature has. A shared read-only link may
 *    look at the deck and at the statistics and may not answer a single card --
 *    otherwise somebody else's reading would silently decide when the owner
 *    sees a card again.
 * 2. **`GET /api/study/from-note/:id` writes nothing.** It returns proposals,
 *    and the POST on the same path creates exactly the ones named in
 *    `auswahl`. Splitting the two along the HTTP verb is what makes "sieh dir
 *    an, was daraus würde" possible before anything lands in the vault.
 *
 * Cards are deliberately not creatable through `POST /api/records`
 * (`CREATABLE` there does not list them): a client could otherwise set `due`,
 * `ease` and `reps` freely, and a schedule somebody typed in is not a schedule.
 * Everything a person may author goes through here.
 */

const { ValidationError } = require('../../kernel/errors');
const {
  need,
  needMethod,
  asObject,
  requireString,
  optionalString,
  requireStringArray,
  intParam,
  boolParam,
  strParam,
  mustGet,
} = require('./support');

const GRADE_HINT = '0 Nochmal · 1 Schwer · 2 Gut · 3 Leicht';

function readGrade(body) {
  const raw = body.grade;
  if (raw === undefined || raw === null) {
    throw new ValidationError(`"grade" fehlt. Möglich sind: ${GRADE_HINT}.`);
  }
  const grade = Number(raw);
  if (!Number.isInteger(grade) || grade < 0 || grade > 3) {
    throw new ValidationError(`"grade" muss 0, 1, 2 oder 3 sein: ${GRADE_HINT}.`);
  }
  return grade;
}

function register(router) {
  router.get('/api/study/due', (rc) => {
    rc.requireCapability('read');
    const study = needMethod(rc.ctx.study, 'due', 'Der Kartenstapel');
    return study.due({
      limit: intParam(rc.query, 'limit', 20, 1, 200),
      deck: strParam(rc.query, 'deck', 120) || undefined,
    });
  });

  router.get('/api/study/stats', (rc) => {
    rc.requireCapability('read');
    const study = needMethod(rc.ctx.study, 'stats', 'Der Kartenstapel');
    return study.stats();
  });

  router.get('/api/study/cards', (rc) => {
    rc.requireCapability('read');
    const study = needMethod(rc.ctx.study, 'list', 'Der Kartenstapel');
    return study.list({
      limit: intParam(rc.query, 'limit', 100, 1, 500),
      offset: intParam(rc.query, 'offset', 0, 0, 1000000),
      deck: strParam(rc.query, 'deck', 120) || undefined,
      noteId: strParam(rc.query, 'noteId', 80) || undefined,
      includeSuspended: boolParam(rc.query, 'includeSuspended', true),
    });
  });

  router.post('/api/study/cards', async (rc) => {
    rc.requireCapability('write');
    const study = needMethod(rc.ctx.study, 'create', 'Der Kartenstapel');
    const body = asObject(await rc.body());
    const record = study.create({
      front: requireString(body.front, 'front', { max: 2000 }),
      back: optionalString(body.back, 'back', { max: 8000 }) || '',
      deck: optionalString(body.deck, 'deck', { max: 120 }) || undefined,
      noteId: optionalString(body.noteId, 'noteId', { max: 80 }) || null,
    });
    return { record };
  });

  router.patch('/api/study/cards/:id', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const study = needMethod(rc.ctx.study, 'update', 'Der Kartenstapel');
    const card = mustGet(store, rc.params.id, 'card');
    const body = asObject(await rc.body());
    // Passed through as sent, so the subsystem is the single place that
    // decides what may be changed -- including its refusal to let anyone
    // hand-edit the schedule.
    return { record: study.update(card.id, body) };
  });

  router.delete('/api/study/cards/:id', (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const study = needMethod(rc.ctx.study, 'remove', 'Der Kartenstapel');
    const card = mustGet(store, rc.params.id, 'card');
    return { record: study.remove(card.id) };
  });

  router.post('/api/study/cards/:id/review', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const study = needMethod(rc.ctx.study, 'review', 'Der Kartenstapel');
    const card = mustGet(store, rc.params.id, 'card');
    const body = asObject(await rc.body());
    return study.review(card.id, readGrade(body));
  });

  router.get('/api/study/from-note/:noteId', (rc) => {
    rc.requireCapability('read');
    const study = needMethod(rc.ctx.study, 'proposeFromNote', 'Der Kartenstapel');
    return study.proposeFromNote(rc.params.noteId);
  });

  router.post('/api/study/from-note/:noteId', async (rc) => {
    rc.requireCapability('write');
    const study = needMethod(rc.ctx.study, 'createFromNote', 'Der Kartenstapel');
    const body = asObject(await rc.body());
    const auswahl = requireStringArray(body.auswahl, 'auswahl', { maxItems: 100, max: 64 });
    return study.createFromNote(rc.params.noteId, auswahl, {
      deck: optionalString(body.deck, 'deck', { max: 120 }) || undefined,
    });
  });
}

module.exports = { register };
