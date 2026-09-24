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

/** Was die Werkzeuge der KI im Tresor schreiben -- nur das nimmt "Rückgängig" zurück. */
const WIRKUNG_TYPEN = new Set(['event', 'note', 'memory', 'project', 'task']);

/** Fields of a chat the interface may set. */
const CHAT_FIELDS = ['title', 'model', 'network', 'systemPrompt', 'contextNodeIds', 'agentId', 'pinned'];

/**
 * `data.claude` ist der Mitschnitt für die NÄCHSTE Anfrage an Claude
 * (Denkblöcke mit Signatur, verschlüsselte Suchergebnisse). Die Oberfläche
 * braucht ihn nicht, und im Strom wäre er nur Gewicht: jedes `fertig` trüge
 * sonst den ganzen Verlauf des Zuges mit.
 */
function ohneInterna(event) {
  const r = event && event.record;
  if (!r || !r.data || r.data.claude === undefined) return event;
  const { claude, ...rest } = r.data;
  void claude;
  return { ...event, record: { ...r, data: rest } };
}

/** Die Zeile, an der ein Mensch einen Satz erkennt -- für Sätze in Meldungen. */
function titelVon(store, id) {
  const rec = store.get(id, { includeDeleted: true });
  const d = (rec && rec.data) || {};
  const t = String(d.title || d.name || d.text || id).replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

function chatService(rc) {
  return rc.ctx.chat || null;
}

function getChatRecord(rc, id) {
  const chat = chatService(rc);
  if (chat && typeof chat.get === 'function') return chat.get(id);
  return mustGet(need(rc.ctx.store, 'Der Speicher'), id, 'chat');
}

/**
 * Warum ein Rückgängig abgelehnt wird, weil ein Satz danach noch einmal
 * geändert wurde -- und von WEM. War es die KI selbst in einem späteren
 * Lauf ("verschieb den Zahnarzt auf Freitag"), ist nichts vom Nutzer in
 * Gefahr; dann soll die Meldung den Weg nennen: erst die spätere Karte
 * zurücknehmen. `details.runId` sagt der Oberfläche, welche Karte das ist.
 */
function spaeterGeaendert(store, id, fremd) {
  const titel = titelVon(store, id);
  const actor = fremd.actor || {};
  // Nur ein Urheber am EREIGNIS ist sicher die KI. Ein Eintrag, der die
  // runId bloss über den Stempel am Satz trägt (`via: 'stempel'`), ist
  // meist deine eigene Änderung am KI-Termin (src/store/history.js, actorOf).
  if (actor.kind === 'agent' && actor.via !== 'stempel') {
    const lauf = actor.runId ? store.get(actor.runId) : null;
    const was = lauf && lauf.type === 'run' && lauf.data ? String(lauf.data.result || lauf.data.titel || '').trim() : '';
    return new NeuralError('RUECKGAENGIG_NICHT_MOEGLICH',
      `„${titel}“ wurde danach noch einmal von der KI geändert${was ? ` („${was.slice(0, 120)}“)` : ''}. `
        + 'Nimm zuerst diese spätere Änderung zurück, dann geht auch diese.',
      { status: 409, details: { id, seq: fremd.seq, von: 'agent', runId: actor.runId || null } });
  }
  return new NeuralError('RUECKGAENGIG_NICHT_MOEGLICH',
    `„${titel}“ wurde seitdem geändert. Ich nehme es nicht zurück, damit deine Änderung nicht verloren geht.`,
    { status: 409, details: { id, seq: fremd.seq, von: actor.kind || null } });
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
      stream.send(event.type, ohneInterna(event));
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

  /** Vorab für neu antworten und bearbeiten: verbunden, nicht beschäftigt. */
  function bereit(rc, chat, record) {
    if (rc.ctx.claude && typeof rc.ctx.claude.zugang === 'function') rc.ctx.claude.zugang();
    if (typeof chat.isStreaming === 'function' && chat.isStreaming(record.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du etwas änderst.');
    }
  }

  /**
   * Die letzte Antwort neu erzeugen. Körper: { effort? }. Antwortet mit
   * demselben Ereignisstrom wie das Senden, davor `verworfen {ids}` für die
   * überholten Nachrichten.
   */
  router.post('/api/chats/:id/neu-antworten', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    if (typeof chat.neuAntworten !== 'function') need(null, 'Das Neu-Antworten');
    const body = await rc.body();
    const effort = body && typeof body.effort === 'string' ? body.effort : undefined;
    const record = getChatRecord(rc, rc.params.id);
    return strom(rc, record, (svc, signal, onEvent) => svc.neuAntworten({
      chatId: record.id, signal, onEvent, effort,
    }), () => {
      bereit(rc, chat, record);
      if (!chat.messages(record.id).items.some((m) => m.data.role === 'user')) {
        throw new ValidationError('Hier gibt es noch keine Frage, auf die ich neu antworten könnte.');
      }
    });
  });

  /**
   * Eine eigene Nachricht ändern: { inhalt } -- alles danach fällt weg, und
   * Claude antwortet neu. Ereignisse: verworfen, nutzer (die geänderte
   * Nachricht), antwort, … , fertig.
   */
  router.post('/api/chats/:id/messages/:messageId/bearbeiten', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    if (typeof chat.bearbeiten !== 'function') need(null, 'Das Bearbeiten');
    const body = asObject(await rc.body());
    const roh = body.inhalt !== undefined ? body.inhalt : body.content;
    const content = requireString(roh, 'inhalt', { max: MAX_CONTENT_CHARS });
    const record = getChatRecord(rc, rc.params.id);
    const messageId = rc.params.messageId;
    return strom(rc, record, (svc, signal, onEvent) => svc.bearbeiten({
      chatId: record.id, messageId, content, signal, onEvent,
      effort: typeof body.effort === 'string' ? body.effort : undefined,
    }), () => {
      const m = chat.messages(record.id).items.find((x) => x.id === messageId);
      if (!m || m.data.role !== 'user') throw new NotFoundError(`Nachricht ${messageId}`);
      bereit(rc, chat, record);
    });
  });

  /**
   * Zurücknehmen, was ein Agent in diesem Chat angelegt, geändert oder
   * gelöscht hat: { runId }. Über den Änderungsverlauf, also mit genau
   * dessen Regeln -- hat der Nutzer den Termin seitdem selbst geändert,
   * wird nichts überschrieben, sondern mit 409 und dem Grund abgelehnt.
   * Erst werden ALLE Einträge geprüft, dann geschrieben.
   */
  router.post('/api/chats/:id/rueckgaengig', async (rc) => {
    rc.requireCapability('write');
    const record = getChatRecord(rc, rc.params.id);
    const body = asObject(await rc.body());
    const runId = requireString(body.runId, 'runId', { max: 120 });
    const store = need(rc.ctx.store, 'Der Speicher');
    const run = store.get(runId);
    if (!run || run.type !== 'run' || (run.data && run.data.chatId) !== record.id) {
      throw new NotFoundError(`Lauf ${runId}`);
    }
    const verlauf = rc.ctx.history;
    if (!verlauf || typeof verlauf.undo !== 'function' || typeof verlauf.list !== 'function') {
      need(null, 'Der Änderungsverlauf', 'Ohne ihn lässt sich nichts zurücknehmen.');
    }
    // Neueste zuerst, so liefert list() sie -- abgebaut wird rückwärts.
    const alle = verlauf.list({ limit: 500 }).items;
    // Nur, was der Lauf SELBST geschrieben hat (Urheber am Ereignis). Ein
    // Eintrag, der die runId bloss über den Stempel am Satz trägt
    // (`via: 'stempel'`), ist eine spätere Änderung von jemand anderem --
    // meist vom Nutzer, dessen Änderung am KI-Termin sonst als
    // Agentenänderung durchginge (src/store/history.js, actorOf).
    const vomLauf = (e) => !!(e.actor && e.actor.runId === runId && e.actor.via !== 'stempel');
    const eintraege = alle.filter((e) => vomLauf(e) && !e.undone && WIRKUNG_TYPEN.has(e.type));
    if (!eintraege.length) {
      if (run.data.zurueckgenommenAm) return { ok: true, runId, schonZurueck: true, am: run.data.zurueckgenommenAm, zurueckgenommen: [] };
      throw new NeuralError('NICHTS_ZURUECKZUNEHMEN', 'Dieser Agent hat nichts hinterlassen, das sich zurücknehmen ließe.', { status: 409 });
    }
    // Erst ALLES prüfen. Je Satz: hat seitdem jemand anderes (meist der
    // Nutzer) daran etwas geändert, wird nichts überschrieben. Spätere
    // Schritte DESSELBEN Laufs sind kein Hindernis -- sie werden mit
    // zurückgenommen, und nur dafür wird `force` benutzt.
    const saetze = new Map();
    for (const e of eintraege) {
      if (!saetze.has(e.id)) saetze.set(e.id, []);
      saetze.get(e.id).push(e);
    }
    for (const [id, liste] of saetze) {
      const aeltester = Math.min(...liste.map((e) => e.seq));
      const fremd = alle.find((e) => e.id === id && e.seq > aeltester && !e.undone && !vomLauf(e));
      if (fremd) throw spaeterGeaendert(store, id, fremd);
      const juengster = liste[0];
      if (!juengster.canUndo) {
        throw new NeuralError('RUECKGAENGIG_NICHT_MOEGLICH', juengster.reason || 'Das lässt sich nicht mehr zurücknehmen.', {
          status: 409,
          details: { id, seq: juengster.seq },
        });
      }
    }
    const erledigt = [];
    const erledigtSeq = new Set();
    for (const e of eintraege) {
      if (erledigtSeq.has(e.seq)) continue;
      const force = eintraege.some((x) => x.id === e.id && x.seq > e.seq);
      const r = await verlauf.undo(e.seq, { force });
      erledigtSeq.add(e.seq);
      erledigt.push({ id: e.id, typ: e.type, op: e.op, label: e.label });
      for (const m of (r && r.mitgenommen) || []) if (m.entry) erledigtSeq.add(m.entry.seq);
    }
    const am = new Date().toISOString();
    try { store.update(runId, { zurueckgenommenAm: am }); } catch (err) { rc.log.warn(`Lauf ${runId}: ${err && err.message}`); }
    // Die Antwort merkt es sich, damit die Karte nach dem Neuladen
    // "Zurückgenommen" zeigt und nicht wieder einen Knopf anbietet.
    const messageId = run.data.messageId;
    const msg = messageId ? store.get(messageId) : null;
    if (msg && msg.type === 'message' && Array.isArray(msg.data.agenten)) {
      try {
        const agenten = msg.data.agenten.map((a) => (a.runId === runId ? { ...a, zurueckgenommen: am } : a));
        const neu = store.update(msg.id, { agenten });
        if (rc.ctx.bus && typeof rc.ctx.bus.publish === 'function') {
          rc.ctx.bus.publish('chat.message', { chatId: record.id, record: ohneInterna({ record: neu }).record });
        }
      } catch (err) {
        rc.log.warn(`Antwort ${messageId}: ${err && err.message}`);
      }
    }
    return { ok: true, runId, am, zurueckgenommen: erledigt };
  });

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
