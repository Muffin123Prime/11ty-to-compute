'use strict';

/**
 * Chat-Routen. Der einzige schreibende Ereignisstrom im System.
 *
 * `POST /api/chats/:id/messages` antwortet mit einem Ereignisstrom (SSE)
 * statt mit einem JSON-Körper, weil Claude denkt, sucht und schreibt, und
 * das der Nutzer sehen soll, während es passiert. Die Ereignisse (Vertrag 6)
 * spiegeln, was der Chat-Dienst wirklich getan hat:
 *
 *   nutzer      der gespeicherte Satz des Nutzers
 *   antwort     der Antwort-Satz, angelegt BEVOR Claude gefragt wird
 *   denken      {delta}  Zusammenfassung des Gedankengangs
 *   text        {delta}  sichtbarer Antworttext
 *   quelle      {titel, url, art}  zitierte oder gelesene Quelle
 *   agent       {id, rolle, titel, zustand, schritt, dauerMs, ergebnis}
 *   rueckfrage  {id, frage, optionen:[{label}], mehrfach}
 *   hinweis     {satz}  z. B. "abgeschnitten, schreib weiter"
 *   fehler      {code, satz}
 *   fertig      {stopReason, record}  immer zuletzt
 *
 * Geprüft wird VOR dem Öffnen des Stroms (leere Nachricht, unbekannter Chat,
 * Claude nicht verbunden), damit das als gewöhnlicher Statuscode mit Satz
 * zurückkommt. Danach ist `fertig` garantiert: ein Browser, der es nie
 * sieht, weiß, dass die Verbindung brach, statt ein Ende anzunehmen.
 *
 * Wer die Verbindung schließt, bricht den Zug ab -- eine Antwort, der niemand
 * zuhört, kostet trotzdem Geld.
 */

const {
  NeuralError, ValidationError, NotFoundError, asNeuralError,
} = require('../../kernel/errors');
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

  /**
   * Einen Zug als Ereignisstrom liefern -- für das Senden und für die
   * Antwort auf eine Rückfrage. Alles, was VOR dem Öffnen des Stroms
   * scheitert (leere Nachricht, unbekannter Chat, Claude nicht verbunden,
   * Rückfrage schon erledigt), kommt als gewöhnliche JSON-Antwort mit
   * Statuscode. Danach gibt es keinen Statuscode mehr -- deshalb ist
   * `fertig` garantiert das letzte Ereignis.
   */
  async function strom(rc, record, starten, vorab) {
    const chat = chatService(rc);
    vorab(chat);
    const stream = rc.openStream({ retryMs: 2000 });
    const controller = new AbortController();
    // Ein geschlossener Tab soll keinen bezahlten Zug weiterlaufen lassen.
    stream.onClose(() => controller.abort());
    let sawFertig = false;
    let sawFehler = false;
    const forward = (event) => {
      if (!event || typeof event.type !== 'string' || stream.closed) return;
      if (event.type === 'fertig') sawFertig = true;
      if (event.type === 'fehler') sawFehler = true;
      stream.send(event.type, event);
    };
    try {
      await starten(chat, controller.signal, forward);
    } catch (err) {
      const neural = asNeuralError(err);
      if (!sawFehler && !stream.closed && neural.code !== 'ABORTED') {
        stream.send('fehler', { type: 'fehler', code: neural.code, satz: neural.message });
      }
      if (neural.status >= 500 && neural.code === 'INTERNAL_ERROR') rc.log.error(`Chat ${record.id}: ${neural.stack || neural.message}`);
    } finally {
      if (!sawFertig && !stream.closed) stream.send('fertig', { type: 'fertig', stopReason: 'fehler' });
      stream.close();
    }
    return undefined; // der Strom gehört der Antwort
  }

  /**
   * Nachricht senden (Vertrag 6). Körper: { inhalt | content, effort? }.
   * Ereignisse: nutzer, antwort, denken, text, quelle, agent, rueckfrage,
   * hinweis, fehler, fertig -- siehe src/models/chat.js.
   */
  async function senden(rc) {
    rc.requireCapability('chat');
    need(chatService(rc), 'Der Chat-Dienst', 'Ohne ihn kann Claude nicht antworten.');
    const body = asObject(await rc.body());
    const roh = body.inhalt !== undefined ? body.inhalt : body.content;
    const content = requireString(roh, 'inhalt', { max: MAX_CONTENT_CHARS });
    const record = getChatRecord(rc, rc.params.id);
    const effort = typeof body.effort === 'string' ? body.effort : undefined;
    return strom(rc, record, (chat, signal, onEvent) => chat.send({
      chatId: record.id, content, effort, signal, onEvent,
    }), (chat) => {
      if (typeof chat.send !== 'function') need(null, 'Das Senden von Nachrichten');
      // Nicht verbunden, gerade beschäftigt: als Statuscode, bevor der Strom öffnet.
      if (rc.ctx.claude && typeof rc.ctx.claude.zugang === 'function') rc.ctx.claude.zugang();
      if (typeof chat.isStreaming === 'function' && chat.isStreaming(record.id)) {
        throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du erneut sendest.');
      }
    });
  }

  router.post('/api/chats/:id/messages', senden);
  /** Früherer Name. Bleibt, bis keine Ansicht ihn mehr benutzt; gleiche Ereignisse. */
  router.post('/api/chats/:id/send', senden);

  /**
   * Eine Rückfrage beantworten: { id, antwort } -- antwort ist der Text der
   * gewählten Option (oder eigener Text), bei Mehrfachwahl eine Liste. Die
   * Antwort ist wieder ein Ereignisstrom: der Zug läuft in derselben
   * Antwort weiter.
   */
  router.post('/api/chats/:id/rueckfrage', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    if (typeof chat.antworten !== 'function') need(null, 'Das Beantworten von Rückfragen');
    const body = asObject(await rc.body());
    const id = requireString(body.id, 'id', { max: 200 });
    const antwort = Array.isArray(body.antwort) ? body.antwort : requireString(body.antwort, 'antwort', { max: 500 });
    const record = getChatRecord(rc, rc.params.id);
    // Unbekannte oder erledigte Rückfrage: Statuscode statt Strom.
    const offen = chat.messages(record.id).items.some((m) => m.data.role === 'assistant' && m.data.rueckfrageOffen
      && Array.isArray(m.data.rueckfragen) && m.data.rueckfragen.some((f) => f.id === id && f.zustand === 'offen'));
    if (!offen) {
      const gibt = chat.messages(record.id).items.some((m) => Array.isArray(m.data.rueckfragen) && m.data.rueckfragen.some((f) => f.id === id));
      if (!gibt) throw new NotFoundError(`Rückfrage ${id}`);
      throw new NeuralError('RUECKFRAGE_ERLEDIGT', 'Diese Rückfrage ist schon erledigt.', { status: 409 });
    }
    return strom(rc, record, (svc, signal, onEvent) => svc.antworten({
      chatId: record.id, id, antwort, signal, onEvent,
      effort: typeof body.effort === 'string' ? body.effort : undefined,
    }), () => {
      if (rc.ctx.claude && typeof rc.ctx.claude.zugang === 'function') rc.ctx.claude.zugang();
      if (typeof chat.isStreaming === 'function' && chat.isStreaming(record.id)) {
        throw new ValidationError('Für diesen Chat läuft bereits eine Antwort.');
      }
    });
  });
}

module.exports = { register, MAX_CONTENT_CHARS };
