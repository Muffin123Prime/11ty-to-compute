'use strict';

/**
 * Chat routes. The only streaming write in the system.
 *
 * `POST /api/chats/:id/send` answers with an event stream rather than one JSON
 * body because the alternative -- buffer the answer, reply at the end -- makes
 * a slow local model look broken and loses every token if the connection dies.
 * The events mirror what the chat service really did:
 *
 *   user     the stored user message
 *   context  what had to be left out to fit the model's window (never a summary)
 *   start    the assistant record, created before the model was asked
 *   delta    a chunk that genuinely arrived from the model
 *   message  the final, stored assistant record
 *   error    a typed failure -- this is what "no model" looks like, and the
 *            client must show it instead of anything resembling an answer
 *   done     always last, whatever happened
 *
 * The request is validated and the chat is fetched *before* the stream opens,
 * so a bad request still gets a normal JSON error with a status code. Once the
 * stream is open there is no going back to a status code, which is exactly why
 * `done` is guaranteed: a client that never sees it knows the connection broke
 * rather than assuming the answer ended.
 *
 * Disconnecting aborts the run. An answer nobody is listening to still costs a
 * local model its entire GPU, and a chat that keeps generating after its tab
 * closed would be invisible work on the user's own machine.
 */

const { asNeuralError } = require('../../kernel/errors');
const {
  need,
  asObject,
  requireString,
  intParam,
  strParam,
  pick,
  mustGet,
} = require('./support');

const MAX_CONTENT_CHARS = 200000;

/** Fields of a chat the interface may set. */
const CHAT_FIELDS = ['title', 'model', 'network', 'systemPrompt', 'contextNodeIds', 'agentId', 'pinned'];

function chatService(rc) {
  return rc.ctx.chat || null;
}

function getChatRecord(rc, id) {
  const chat = chatService(rc);
  if (chat && typeof chat.get === 'function') return chat.get(id);
  return mustGet(need(rc.ctx.store, 'Der Speicher'), id, 'chat');
}

function register(router) {
  router.get('/api/chats', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    return store.list('chat', {
      limit: intParam(rc.query, 'limit', 100, 1, 1000),
      offset: intParam(rc.query, 'offset', 0, 0, 100000),
      sort: strParam(rc.query, 'sort', 60) || 'updatedAt',
      order: strParam(rc.query, 'order', 10) === 'asc' ? 'asc' : 'desc',
    });
  });

  router.post('/api/chats', async (rc) => {
    rc.requireCapability('chat');
    const body = asObject(await rc.body());
    const data = pick(body, CHAT_FIELDS);
    const chat = chatService(rc);
    if (chat && typeof chat.create === 'function') return { record: chat.create(data) };
    // Without the chat service a conversation cannot be answered, but it can
    // still be created and read -- the UI stays usable and says why.
    const store = need(rc.ctx.store, 'Der Speicher');
    return { record: store.create('chat', data), sendable: false };
  });

  router.get('/api/chats/:id', (rc) => {
    rc.requireCapability('read');
    const record = getChatRecord(rc, rc.params.id);
    const out = { record };
    const chat = chatService(rc);
    if (chat && typeof chat.stance === 'function') {
      try {
        out.stance = chat.stance(record.id);
      } catch (err) {
        out.stance = { problem: asNeuralError(err).message };
      }
    }
    if (chat && typeof chat.isStreaming === 'function') out.streaming = chat.isStreaming(record.id);
    return out;
  });

  router.patch('/api/chats/:id', async (rc) => {
    rc.requireCapability('chat');
    const record = getChatRecord(rc, rc.params.id);
    const patch = pick(asObject(await rc.body()), CHAT_FIELDS);
    const chat = chatService(rc);
    if (chat && typeof chat.update === 'function') return { record: chat.update(record.id, patch) };
    const store = need(rc.ctx.store, 'Der Speicher');
    return { record: store.update(record.id, patch) };
  });

  router.get('/api/chats/:id/messages', (rc) => {
    rc.requireCapability('read');
    const record = getChatRecord(rc, rc.params.id);
    const limit = intParam(rc.query, 'limit', 500, 1, 5000);
    const offset = intParam(rc.query, 'offset', 0, 0, 100000);
    const chat = chatService(rc);
    if (chat && typeof chat.messages === 'function') return chat.messages(record.id, { limit, offset });
    const store = need(rc.ctx.store, 'Der Speicher');
    return store.list('message', {
      filter: { chatId: record.id },
      sort: 'createdAt',
      order: 'asc',
      limit,
      offset,
    });
  });

  router.post('/api/chats/:id/abort', (rc) => {
    rc.requireCapability('chat');
    const record = getChatRecord(rc, rc.params.id);
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    const aborted = typeof chat.abort === 'function' ? chat.abort(record.id) : false;
    return { aborted, chatId: record.id };
  });

  router.post('/api/chats/:id/send', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(
      chatService(rc),
      'Der Chat-Dienst',
      'Ohne ihn kann keine Antwort erzeugt werden; die Einrichtung eines lokalen Modells steht in der Notiz "Lokales Modell einrichten".',
    );
    const body = asObject(await rc.body());
    const content = requireString(body.content, 'content', { max: MAX_CONTENT_CHARS });
    // Both of these must fail as a status code, before the stream opens.
    const record = getChatRecord(rc, rc.params.id);
    if (typeof chat.send !== 'function') {
      need(null, 'Das Senden von Nachrichten');
    }

    const stream = rc.openStream({ retryMs: 2000 });
    const controller = new AbortController();
    // A closed tab must not leave a model generating into nothing.
    stream.onClose(() => controller.abort());

    let sawError = false;
    let sawDone = false;

    const forward = (event) => {
      if (!event || typeof event.type !== 'string' || stream.closed) return;
      if (event.type === 'error') sawError = true;
      if (event.type === 'done') sawDone = true;
      stream.send(event.type, event);
    };

    try {
      await chat.send({
        chatId: record.id,
        content,
        network: typeof body.network === 'string' ? body.network : undefined,
        options: body.options && typeof body.options === 'object' ? body.options : undefined,
        signal: controller.signal,
        onEvent: forward,
      });
    } catch (err) {
      const neural = asNeuralError(err);
      // The service already reported it through `onEvent` in the normal case;
      // this covers failures that happened outside that loop.
      if (!sawError && !stream.closed) {
        stream.send('error', {
          type: 'error',
          chatId: record.id,
          error: { code: neural.code, message: neural.message, details: neural.details || null },
        });
      }
      if (neural.status >= 500 && neural.code === 'INTERNAL_ERROR') rc.log.error(`Chat ${record.id}: ${neural.stack || neural.message}`);
    } finally {
      if (!sawDone && !stream.closed) stream.send('done', { type: 'done', chatId: record.id });
      stream.close();
    }
    return undefined; // the stream owned the response
  });
}

module.exports = { register, MAX_CONTENT_CHARS };
