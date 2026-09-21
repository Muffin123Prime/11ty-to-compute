'use strict';

/**
 * Zwei Modelle, eine Antwort -- the routes for the side-by-side comparison.
 *
 * There are two requests here on purpose, and the split is the whole point of
 * the feature:
 *
 *   POST /api/compare/plan   says what WOULD happen. It resolves nothing over
 *                            the network, asks no resolver and writes no audit
 *                            entry -- it reads the registry's last snapshot
 *                            and the gate's pure policy decision. The
 *                            interface shows its sentences BEFORE anybody
 *                            presses send, because a comparison against an
 *                            online provider hands the user's question to a
 *                            stranger and that has to be a decision, not a
 *                            surprise.
 *
 *   POST /api/compare        actually asks both models. It answers with an
 *                            event stream for the same reason `/api/chats/:id/
 *                            send` does: buffering two answers until both are
 *                            finished would make the fast local side wait for
 *                            the slow remote one, which is precisely the
 *                            difference the user opened this view to see.
 *
 * The stream carries both sides in one connection, separated by a `seite`
 * field ('a' or 'b') on every event:
 *
 *   plan   the same plan `/api/compare/plan` returns -- the server's last
 *          word on where each side goes, so the client cannot render a
 *          provenance it merely assumed
 *   start  one per side: which model was resolved, and where it lives
 *   delta  a chunk that genuinely arrived from that side's model
 *   side   one per side: the finished result, including a typed `fehler`
 *          when that side failed. Both always arrive -- one side failing
 *          must never make the other one's answer stand in for both.
 *   error  the whole run failed (no model at all, bad request after the
 *          stream opened)
 *   done   always last, whatever happened
 *
 * `POST /api/compare/save` is separate and is a write: a comparison is kept
 * only because somebody pressed the button, never as a side effect of having
 * run one.
 */

const { ValidationError, asNeuralError } = require('../../kernel/errors');
const {
  need,
  needMethod,
  asObject,
  requireString,
  optionalString,
} = require('./support');

/** Mirrors src/models/compare.js, so a too-long question fails as a 400. */
const MAX_PROMPT_CHARS = 200000;

/**
 * A model reference as the client may send it: `null` (use the default),
 * a string ("ollama/llama3.2"), or `{provider, model}`. Anything else is a
 * mistake worth naming rather than silently turning into "the default".
 */
function modelRef(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return requireString(value, field, { max: 300 });
  if (typeof value === 'object' && !Array.isArray(value)) {
    const provider = optionalString(value.provider, `${field}.provider`, { max: 80 });
    const model = optionalString(value.model, `${field}.model`, { max: 300 });
    if (!provider && !model) return null;
    return { provider: provider || null, model: model || null };
  }
  throw new ValidationError(`"${field}" muss ein Text oder ein Objekt {provider, model} sein.`);
}

function service(rc) {
  return rc.ctx.compare || null;
}

function register(router) {
  /**
   * The plan. Explicitly a POST although it changes nothing: the two model
   * references are structured input, and a GET would push them into a query
   * string where they would end up in every proxy log on the way. There is no
   * proxy here, but the habit is the point.
   */
  router.post('/api/compare/plan', async (rc) => {
    rc.requireCapability('chat');
    const compare = needMethod(
      service(rc),
      'plan',
      'Der Modellvergleich',
      'Ohne ihn lässt sich nicht sagen, wohin eine Frage ginge.',
    );
    const body = asObject(await rc.body());
    const plan = await compare.plan({
      chatId: optionalString(body.chatId, 'chatId', { max: 80 }) || null,
      a: modelRef(body.a, 'a'),
      b: modelRef(body.b, 'b'),
    });
    return { plan };
  });

  router.post('/api/compare', async (rc) => {
    rc.requireCapability('chat');
    const compare = needMethod(
      service(rc),
      'run',
      'Der Modellvergleich',
      'Ohne ihn kann dieselbe Frage nicht an zwei Modelle gehen.',
    );
    const body = asObject(await rc.body());
    // Everything that can fail as a status code must fail before the stream
    // opens; afterwards there is no way back to a response code.
    const prompt = requireString(body.prompt, 'prompt', { max: MAX_PROMPT_CHARS });
    const chatId = optionalString(body.chatId, 'chatId', { max: 80 }) || null;
    const a = modelRef(body.a, 'a');
    const b = modelRef(body.b, 'b');
    const systemPrompt = optionalString(body.systemPrompt, 'systemPrompt', { max: 20000 }) || null;
    // The plan is computed here, before the stream, so a chat id that does not
    // exist is a 404 rather than an error event nobody expected.
    const planned = await compare.plan({ chatId, a, b });

    const stream = rc.openStream({ retryMs: 2000 });
    const controller = new AbortController();
    // A closed tab must not leave two models generating into nothing.
    stream.onClose(() => controller.abort());

    let sawError = false;
    stream.send('plan', { type: 'plan', plan: planned });

    try {
      const result = await compare.run({
        chatId,
        prompt,
        a,
        b,
        systemPrompt,
        options: body.options && typeof body.options === 'object' ? body.options : undefined,
        signal: controller.signal,
        onEvent: (event) => {
          if (!event || typeof event.type !== 'string' || stream.closed) return;
          stream.send(event.type, event);
        },
      });
      if (!stream.closed) stream.send('result', { type: 'result', ...result });
    } catch (err) {
      const neural = asNeuralError(err);
      sawError = true;
      if (!stream.closed) {
        stream.send('error', {
          type: 'error',
          error: { code: neural.code, message: neural.message, details: neural.details || null },
        });
      }
      if (neural.status >= 500 && neural.code === 'INTERNAL_ERROR') {
        rc.log.error(`Vergleich fehlgeschlagen: ${neural.stack || neural.message}`);
      }
    } finally {
      if (!stream.closed) stream.send('done', { type: 'done', fehlgeschlagen: sawError });
      stream.close();
    }
    return undefined; // the stream owned the response
  });

  /**
   * Keep a comparison. A write, and only ever on request -- running a
   * comparison leaves nothing behind in the vault by itself.
   */
  router.post('/api/compare/save', async (rc) => {
    rc.requireCapability('write');
    const compare = needMethod(service(rc), 'save', 'Der Modellvergleich');
    need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const saved = compare.save({
      chatId: optionalString(body.chatId, 'chatId', { max: 80 }) || null,
      prompt: requireString(body.prompt, 'prompt', { max: MAX_PROMPT_CHARS }),
      title: optionalString(body.title, 'title', { max: 200 }) || undefined,
      a: asObject(body.a, 'Die Seite A'),
      b: asObject(body.b, 'Die Seite B'),
    });
    return saved;
  });
}

module.exports = { register, MAX_PROMPT_CHARS };
