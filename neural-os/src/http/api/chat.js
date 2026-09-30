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
 * Fassungen (docs/ANTWORT-BAUSTEINE.md 4) kommen dazu:
 *   fassung     {messageId, version, anzahl, art}  eine neue Fassung läuft
 *               (danach `antwort` mit dem Satz, dessen Felder sie zeigen)
 *   inhalt      {content}  beim Umwandeln einer markierten Stelle: der
 *               ganze Text mit der neuen Stelle (statt `text`-Stücken)
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
const { fuerAussen } = require('../../models/chat');
const fassungen = require('../../models/fassungen');
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

/**
 * Kopfzeile für ausgelieferte Anhänge (siehe GET …/anhaenge/:fileId): nichts
 * laden, nichts ausführen; nur das eingebettete PDF-Objekt aus derselben
 * Quelle und die Anzeige in einem Rahmen der App.
 */
const ANHANG_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/** Fields of a chat the interface may set. */
const CHAT_FIELDS = ['title', 'model', 'network', 'systemPrompt', 'contextNodeIds', 'agentId', 'pinned', 'stil', 'modus'];

/**
 * `data.claude` ist der Mitschnitt für die NÄCHSTE Anfrage an Claude
 * (Denkblöcke mit Signatur, verschlüsselte Suchergebnisse). Die Oberfläche
 * braucht ihn nicht, und im Strom wäre er nur Gewicht: jedes `fertig` trüge
 * sonst den ganzen Verlauf des Zuges mit. Dieselbe Form liefert GET
 * …/messages (src/models/chat.js, fuerAussen) -- samt den Fassungen.
 */
function ohneInterna(event) {
  const r = event && event.record;
  if (!r || !r.data) return event;
  return { ...event, record: fuerAussen(r) };
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

/** Der Verbund (kiDienst) entscheidet, wer antwortet; ohne ihn der Claude-Dienst allein. */
function zugangPruefen(rc) {
  const k = rc.ctx.kiDienst || rc.ctx.claude;
  if (k && typeof k.zugang === 'function') k.zugang();
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
    if (chat && typeof chat.messages === 'function') {
      const r = chat.messages(record.id, { limit, offset });
      return { ...r, items: r.items.map(fuerAussen) };
    }
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
   * Nachricht senden (Vertrag 6). Körper: { inhalt | content, effort?,
   * anhaenge?: [id] } -- `anhaenge` sind Kennungen aus POST …/anhaenge; mit
   * ihnen darf der Text leer sein.
   * Ereignisse: nutzer, antwort, denken, text, quelle, agent, rueckfrage,
   * hinweis, fehler, fertig -- siehe src/models/chat.js.
   */
  async function senden(rc) {
    rc.requireCapability('chat');
    need(chatService(rc), 'Der Chat-Dienst', 'Ohne ihn kann Claude nicht antworten.');
    const body = asObject(await rc.body());
    const roh = body.inhalt !== undefined ? body.inhalt : body.content;
    const anhaenge = body.anhaenge === undefined || body.anhaenge === null ? [] : body.anhaenge;
    if (!Array.isArray(anhaenge) || anhaenge.some((a) => typeof a !== 'string' || a.length > 120)) {
      throw new ValidationError('"anhaenge" muss eine Liste von Kennungen sein.');
    }
    const content = anhaenge.length && (roh === undefined || roh === null || roh === '')
      ? ''
      : requireString(roh, 'inhalt', { max: MAX_CONTENT_CHARS });
    const record = getChatRecord(rc, rc.params.id);
    const effort = typeof body.effort === 'string' ? body.effort : undefined;
    return strom(rc, record, (chat, signal, onEvent) => chat.send({
      chatId: record.id, content, anhaenge, effort, signal, onEvent,
    }), (chat) => {
      if (typeof chat.send !== 'function') need(null, 'Das Senden von Nachrichten');
      if (anhaenge.length && typeof chat.anhaengePruefen === 'function') chat.anhaengePruefen(record.id, anhaenge);
      // Nicht verbunden, gerade beschäftigt: als Statuscode, bevor der Strom öffnet.
      zugangPruefen(rc);
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
    zugangPruefen(rc);
    if (typeof chat.isStreaming === 'function' && chat.isStreaming(record.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du etwas änderst.');
    }
  }

  /**
   * Die letzte Antwort neu erstellen -- als neue FASSUNG derselben Antwort.
   * Körper: { effort?, variante?: kuerzer|einfacher|detaillierter|kreativer|
   * anders|stil, stil?: {laenge, fachlich, kreativ}, messageId? }. Ereignisse
   * wie beim Senden, davor `fassung` und `antwort` (derselbe Satz, neue
   * Fassung aktiv). Gibt es nach der Frage noch keine Antwort, entsteht eine.
   */
  router.post('/api/chats/:id/neu-antworten', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    if (typeof chat.neuAntworten !== 'function') need(null, 'Das Neu-Antworten');
    const body = (await rc.body()) || {};
    if (typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Der Anfragekörper muss ein JSON-Objekt sein.');
    const effort = typeof body.effort === 'string' ? body.effort : undefined;
    const variante = body.variante === undefined || body.variante === null || body.variante === '' ? undefined : body.variante;
    const messageId = typeof body.messageId === 'string' && body.messageId ? body.messageId : undefined;
    const record = getChatRecord(rc, rc.params.id);
    return strom(rc, record, (svc, signal, onEvent) => svc.neuAntworten({
      chatId: record.id, signal, onEvent, effort, variante, stil: body.stil, messageId,
    }), () => {
      if (variante !== undefined && (typeof variante !== 'string' || !Object.prototype.hasOwnProperty.call(fassungen.VARIANTEN, variante))) {
        throw new ValidationError(`Unbekannte Variante „${String(variante).slice(0, 40)}“. Möglich: ${Object.keys(fassungen.VARIANTEN).join(', ')}.`);
      }
      if (body.stil !== undefined) {
        try { fassungen.stilPruefen(body.stil); } catch (err) { throw new ValidationError(err.satz || err.message); }
      }
      bereit(rc, chat, record);
      const items = chat.messages(record.id).items;
      let letzte = -1;
      items.forEach((m, i) => { if (m.data.role === 'user') letzte = i; });
      if (letzte < 0) throw new ValidationError('Hier gibt es noch keine Frage, auf die ich neu antworten könnte.');
      if (messageId) {
        const antwort = items.slice(letzte + 1).find((m) => m.data.role === 'assistant');
        if (!antwort || antwort.id !== messageId) {
          if (!items.some((m) => m.id === messageId && m.data.role === 'assistant')) throw new NotFoundError(`Antwort ${messageId}`);
          throw new NeuralError('NUR_LETZTE_ANTWORT', 'Neu erstellen geht bei der letzten Antwort. Eine ältere lässt sich umwandeln.', { status: 409 });
        }
      }
    });
  });

  /**
   * Eine Antwort umwandeln (SSE): { anweisung, sprache?, auswahl?,
   * vorkommen? } -- ohne Werkzeuge, ohne Websuche; Ergebnis ist eine neue
   * Fassung. Mit `auswahl` (markierter Text) wird nur diese Stelle neu
   * geschrieben; ist sie nicht eindeutig zu finden: 409 AUSWAHL_NICHT_GEFUNDEN
   * (vor dem Strom). Ereignisse: fassung, antwort, text | inhalt, fehler,
   * fertig. Scheitert es, ist wieder die vorige Fassung aktiv (im `fertig`).
   */
  router.post('/api/chats/:id/messages/:messageId/umwandeln', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    if (typeof chat.umwandeln !== 'function') need(null, 'Das Umwandeln');
    const body = asObject(await rc.body());
    const record = getChatRecord(rc, rc.params.id);
    const opts = {
      chatId: record.id,
      messageId: rc.params.messageId,
      anweisung: body.anweisung,
      sprache: body.sprache,
      auswahl: body.auswahl,
      vorkommen: Number.isInteger(body.vorkommen) ? body.vorkommen : undefined,
    };
    return strom(rc, record, (svc, signal, onEvent) => svc.umwandeln({ ...opts, signal, onEvent }), () => {
      chat.umwandelnPruefen(opts);
      zugangPruefen(rc);
    });
  });

  /** Eine andere Fassung aktiv machen: { version } -> { record }. */
  router.patch('/api/chats/:id/messages/:messageId/version', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    const body = asObject(await rc.body());
    const record = getChatRecord(rc, rc.params.id);
    const neu = chat.fassungWaehlen({ chatId: record.id, messageId: rc.params.messageId, version: body.version });
    return { record: fuerAussen(neu) };
  });

  /**
   * Einen Codeblock der aktiven Fassung ersetzen: { nr, inhalt, alt? } ->
   * { record } mit einer neuen Fassung `bearbeitet`. `nr` zählt alle
   * Codeblöcke (``` und ~~~, auch ```ui) der aktiven Fassung von 0 an; `alt`
   * (der bisherige Inhalt, wie die Oberfläche ihn sah) macht den Treffer
   * eindeutig, falls die Zählung einmal abweicht.
   */
  router.patch('/api/chats/:id/messages/:messageId/block', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    const body = asObject(await rc.body());
    const record = getChatRecord(rc, rc.params.id);
    const neu = chat.blockBearbeiten({
      chatId: record.id, messageId: rc.params.messageId, nr: body.nr, inhalt: body.inhalt, alt: body.alt,
    });
    return { record: fuerAussen(neu) };
  });

  /**
   * Zustand eines Bausteins: { version?, schluessel, zustand } (zustand null
   * löscht) -> { messageId, version, schluessel, zustand, ui }. Höchstens
   * 16 KB je Baustein und 64 KB je Nachricht (sonst 413).
   */
  router.put('/api/chats/:id/messages/:messageId/ui', async (rc) => {
    rc.requireCapability('chat');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    const body = asObject(await rc.body());
    const record = getChatRecord(rc, rc.params.id);
    return chat.uiSetzen({
      chatId: record.id,
      messageId: rc.params.messageId,
      version: body.version,
      schluessel: body.schluessel,
      zustand: body.zustand,
    });
  });

  /**
   * Einen Anhang ablegen: { name, mime, daten (Base64 oder data:-Adresse) }.
   * Bilder (PNG, JPG, WEBP, GIF, je höchstens 5 MB) und PDF (höchstens
   * 20 MB); die Art wird am Inhalt geprüft. -> { anhang: {id, name, mime,
   * size, art, url} }. Die Kennung geht beim Senden in `anhaenge`.
   */
  router.post('/api/chats/:id/anhaenge', async (rc) => {
    rc.requireCapability('write');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    const body = asObject(await rc.body());
    const record = getChatRecord(rc, rc.params.id);
    return chat.anhangAblegen({ chatId: record.id, name: body.name, mime: body.mime, daten: body.daten });
  });

  /**
   * Einen Anhang ausliefern (Vorschaubild, PDF anzeigen). Nur Dateien dieses
   * Chats, nur mit Lesezugang. Eigene Kopfzeilen: ein PDF zeigt der Browser
   * mit seinem eingebauten Betrachter, und der ist ein eingebettetes Objekt --
   * `object-src 'none'` der App würde ihn sperren. `frame-ancestors 'self'`
   * erlaubt die Anzeige in einem Rahmen der App, sonst nirgends.
   */
  router.get('/api/chats/:id/anhaenge/:fileId', (rc) => {
    rc.requireCapability('read');
    const chat = need(chatService(rc), 'Der Chat-Dienst');
    const record = getChatRecord(rc, rc.params.id);
    const datei = chat.anhangDatei(record.id, rc.params.fileId);
    const name = String(datei.name || 'anhang').replace(/["\\\r\n]/g, '_');
    const { res } = rc;
    res.setHeader('Content-Security-Policy', ANHANG_CSP);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.writeHead(200, {
      'Content-Type': datei.mime || 'application/octet-stream',
      'Content-Length': datei.buf.length,
      'Content-Disposition': `inline; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(datei.name || 'anhang').replace(/'/g, '%27')}`,
      // Die Kennung zeigt immer auf denselben Inhalt: der Browser darf ihn behalten, aber nur für sich.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    if (rc.method === 'HEAD') res.end();
    else res.end(datei.buf);
    rc.handled = true;
    return undefined;
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
      zugangPruefen(rc);
      if (typeof chat.isStreaming === 'function' && chat.isStreaming(record.id)) {
        throw new ValidationError('Für diesen Chat läuft bereits eine Antwort.');
      }
    });
  });
}

module.exports = { register, MAX_CONTENT_CHARS, ANHANG_CSP };
