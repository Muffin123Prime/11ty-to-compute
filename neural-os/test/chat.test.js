'use strict';

/**
 * Der Chat-Dienst (src/models/chat.js) ohne HTTP und ohne Statisten.
 *
 * Hier steht an Claudes Stelle ein handgeschriebenes Gegenüber, das dieselbe
 * Schnittstelle bedient wie src/models/claude.js (`senden`, `zugang`,
 * `zustand`, `modell`) -- so lassen sich Abbruch, Wettläufe und Randfälle
 * genau an der Stelle auslösen, an der sie in Wirklichkeit passieren.
 * Speicher, Bus, Schleuse und Graph sind echt. Den Weg über die echte
 * Leitung (SSE, Schlüssel, Werkzeuge) beweist test/claude.test.js.
 */

const assert = require('node:assert/strict');
const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const { createGate } = require('../src/net/gate');
const derive = require('../src/graph/derive');
const view = require('../src/graph/view');
const { createChatService, estimateTokens, SYSTEM_FEST } = require('../src/models/chat');
const { NeuralError, AbortedError } = require('../src/kernel/errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ein Ergebnis, wie anbieter.senden() es liefert. */
function ergebnis(text, stopReason = 'end_turn') {
  return {
    id: 'msg_x', modell: 'claude-opus-5', inhalt: text ? [{ type: 'text', text }] : [],
    stopReason, stopDetails: null, usage: { input_tokens: 10, output_tokens: 5 }, eingabeFehler: {}, ms: 1,
  };
}

/** Schickt `text` als Strom über beiEreignis und liefert dann das Ergebnis. */
function sagt(text) {
  return async ({ beiEreignis }) => {
    beiEreignis({ art: 'start', index: 0, block: { type: 'text', text: '' } });
    for (const s of text.match(/.{1,4}/gs) || []) beiEreignis({ art: 'text', index: 0, delta: s });
    return ergebnis(text);
  };
}

/** Ein Claude-Gegenüber. `skript` ist eine Liste von (opts) => Promise<Ergebnis>. */
function gegenueber(skript = []) {
  const g = {
    aufrufe: [],
    aus: false,
    modell: () => 'claude-opus-5',
    zustand() {
      return { verbunden: !g.aus, grund: g.aus ? 'Claude ist nicht verbunden.' : null, grundCode: g.aus ? 'kein-schluessel' : null, netz: { modus: 'online', erlaubt: true } };
    },
    zugang() {
      if (g.aus) throw new NeuralError('CLAUDE_NICHT_VERBUNDEN', 'Claude ist nicht verbunden.', { status: 409 });
      return { schluessel: 'x', modell: 'claude-opus-5' };
    },
    async senden(opts) {
      g.aufrufe.push(JSON.parse(JSON.stringify({ body: opts.body, scope: opts.scope })));
      const f = skript.shift();
      if (!f) throw new Error('Gegenüber: kein Skript mehr');
      return f(opts);
    },
  };
  return g;
}

async function mitChat(fn, { skript, mutateConfig } = {}) {
  const { home, cleanup } = tempHome('nos-chat');
  const bus = new Bus();
  const store = await openStore({ paths: home, bus });
  const config = configMod.defaults();
  if (mutateConfig) mutateConfig(config);
  const audit = new Audit(`${home}/audit.jsonl`).open();
  const gate = createGate({ config, bus, audit, store });
  const graph = { ...derive, ...view };
  const claude = gegenueber(skript);
  const chat = createChatService({ store, claude, gate, bus, graph, config });
  try {
    return await fn({ chat, store, bus, gate, claude, config });
  } finally {
    audit.close();
    try { await store.close(); } catch { /* schon zu */ }
    cleanup();
  }
}

function sammler() {
  const seen = [];
  const fn = (e) => seen.push(e);
  fn.seen = seen;
  fn.arten = () => seen.map((e) => e.type);
  fn.text = () => seen.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  return fn;
}

/* ------------------------------------------------------------- Grundweg */

test('senden legt Nutzer- und Antwortsatz an und streamt den Text hinein', async () => {
  await mitChat(async ({ chat, store, claude }) => {
    const c = chat.create({});
    const ev = sammler();
    const r = await chat.send({ chatId: c.id, content: 'Hallo', onEvent: ev });
    assert.deepEqual(ev.arten().slice(0, 2), ['nutzer', 'antwort']);
    assert.equal(ev.arten().pop(), 'fertig');
    assert.equal(ev.text(), 'Hallo zurück');
    assert.equal(r.message.data.content, 'Hallo zurück');
    assert.equal(r.message.data.status, 'complete');
    assert.deepEqual(r.message.data.model, { provider: 'claude', model: 'claude-opus-5' });
    assert.equal(store.get(c.id).data.title, 'Hallo', 'der Chat heißt nach dem, was der Nutzer schrieb');
    assert.equal(claude.aufrufe[0].scope, `chat:${c.id}`);
    const nachrichten = chat.messages(c.id).items;
    assert.deepEqual(nachrichten.map((m) => m.data.role), ['user', 'assistant']);
  }, { skript: [sagt('Hallo zurück')] });
});

test('Nicht verbunden: nichts wird angelegt, der Satz kommt als Fehler', async () => {
  await mitChat(async ({ chat, store, claude }) => {
    claude.aus = true;
    const c = chat.create({});
    await assert.rejects(() => chat.send({ chatId: c.id, content: 'Hallo?' }), (err) => err.code === 'CLAUDE_NICHT_VERBUNDEN');
    assert.equal(store.count('message'), 0, 'kein Scheinchat, keine leere Antwort');
  });
});

test('Leere Nachrichten und unbekannte Chats werden an der Grenze abgewiesen', async () => {
  await mitChat(async ({ chat }) => {
    const c = chat.create({});
    await assert.rejects(() => chat.send({ chatId: c.id, content: '   ' }), (e) => e.code === 'VALIDATION_FAILED');
    await assert.rejects(() => chat.send({ chatId: 'chat_gibtsnicht000000000000', content: 'x' }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(() => chat.send({ chatId: c.id, content: 'x'.repeat(200001) }), /zu lang/);
  });
});

/* ------------------------------------------------------------- Abbruch */

function haengtBisAbbruch(anfang) {
  return ({ beiEreignis, signal }) => new Promise((resolve, reject) => {
    beiEreignis({ art: 'start', index: 0, block: { type: 'text', text: '' } });
    beiEreignis({ art: 'text', index: 0, delta: anfang });
    signal.addEventListener('abort', () => reject(new AbortedError('Die Antwort wurde abgebrochen.')), { once: true });
  });
}

test('Abbruch behält den Teiltext und markiert die Antwort als abgebrochen', async () => {
  await mitChat(async ({ chat, store }) => {
    const c = chat.create({});
    const ev = sammler();
    const laeuft = chat.send({ chatId: c.id, content: 'Erzähl', onEvent: ev });
    await sleep(20);
    assert.equal(chat.isStreaming(c.id), true);
    assert.equal(chat.abort(c.id), true);
    await assert.rejects(laeuft, (e) => e.code === 'ABORTED');
    const antwort = chat.messages(c.id).items.find((m) => m.data.role === 'assistant');
    assert.equal(antwort.data.status, 'aborted');
    assert.equal(antwort.data.content, 'Es war einmal');
    assert.equal(ev.arten().includes('fehler'), false, 'ein Abbruch ist kein Fehler');
    assert.equal(ev.seen.pop().stopReason, 'abgebrochen');
    assert.equal(chat.isStreaming(c.id), false);
    assert.ok(store.get(antwort.id));
  }, { skript: [haengtBisAbbruch('Es war einmal')] });
});

test('Auch ein AbortSignal von außen beendet den Zug', async () => {
  await mitChat(async ({ chat }) => {
    const c = chat.create({});
    const ctrl = new AbortController();
    const laeuft = chat.send({ chatId: c.id, content: 'x', signal: ctrl.signal });
    await sleep(10);
    ctrl.abort();
    await assert.rejects(laeuft, (e) => e.code === 'ABORTED');
  }, { skript: [haengtBisAbbruch('…')] });
});

test('Ein zweites Senden während der Antwort wird abgelehnt, nicht still eingereiht', async () => {
  await mitChat(async ({ chat }) => {
    const c = chat.create({});
    const erste = chat.send({ chatId: c.id, content: 'eins' });
    await sleep(10);
    await assert.rejects(() => chat.send({ chatId: c.id, content: 'zwei' }), /läuft bereits/);
    chat.abort(c.id);
    await erste.catch(() => {});
  }, { skript: [haengtBisAbbruch('…')] });
});

test('Ein Fehler von Claude wird gespeichert und gemeldet, nie als Antwort ausgegeben', async () => {
  await mitChat(async ({ chat }) => {
    const c = chat.create({});
    const ev = sammler();
    await assert.rejects(() => chat.send({ chatId: c.id, content: 'x', onEvent: ev }), (e) => e.code === 'CLAUDE_UEBERLASTET');
    const fehler = ev.seen.find((e) => e.type === 'fehler');
    assert.equal(fehler.satz, 'Claude ist gerade überlastet.');
    const antwort = chat.messages(c.id).items.find((m) => m.data.role === 'assistant');
    assert.equal(antwort.data.status, 'failed');
    assert.equal(antwort.data.content, '');
    assert.equal(antwort.data.error.code, 'CLAUDE_UEBERLASTET');
  }, { skript: [async () => { throw new NeuralError('CLAUDE_UEBERLASTET', 'Claude ist gerade überlastet.', { status: 503 }); }] });
});

/* ----------------------------------------------------------- Verlauf */

test('Eine gescheiterte leere Antwort geht nicht mit, eine abgebrochene mit Vermerk schon', async () => {
  await mitChat(async ({ chat, claude }) => {
    const c = chat.create({});
    await chat.send({ chatId: c.id, content: 'eins' }).catch(() => {});
    const zwei = chat.send({ chatId: c.id, content: 'zwei' });
    await sleep(10);
    chat.abort(c.id);
    await zwei.catch(() => {});
    await chat.send({ chatId: c.id, content: 'drei' });
    const b = claude.aufrufe[2].body;
    const rollen = b.messages.map((m) => m.role);
    // eins + zwei + (abgebrochene Antwort) + drei; die leere gescheiterte fehlt.
    assert.deepEqual(rollen, ['user', 'assistant', 'user']);
    assert.match(b.messages[1].content[0].text, /Halb gesagt[\s\S]*unterbrochen/);
    const texte = b.messages[0].content.filter((x) => x.type === 'text').map((x) => x.text);
    assert.ok(texte.includes('eins') && texte.includes('zwei'), 'zwei Nutzerzüge hintereinander werden zu einer Nachricht');
  }, {
    skript: [
      async () => { throw new NeuralError('CLAUDE_FEHLER', 'kaputt', { status: 502 }); },
      haengtBisAbbruch('Halb gesagt'),
      sagt('Ok'),
    ],
  });
});

test('Alte Antworten aus der Offline-Zeit (ohne Claude-Verlauf) gehen als Text mit', async () => {
  await mitChat(async ({ chat, store, claude }) => {
    const c = chat.create({});
    store.create('message', { chatId: c.id, role: 'user', content: 'Was ist ein Atom?', ordinal: 0 });
    store.create('message', { chatId: c.id, role: 'assistant', content: 'Ein Baustein.', model: { provider: 'ollama', model: 'llama3.2' }, ordinal: 1 });
    await chat.send({ chatId: c.id, content: 'Und ein Molekül?' });
    const b = claude.aufrufe[0].body;
    assert.deepEqual(b.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(b.messages[1].content[0].text, 'Ein Baustein.');
  }, { skript: [sagt('Mehrere Atome.')] });
});

test('Ein überlanger Verlauf wird durch Weglassen gekürzt, nie durch Zusammenfassen – und das wird gesagt', async () => {
  await mitChat(async ({ chat, store, claude }) => {
    const c = chat.create({});
    const gross = 'x'.repeat(900000);
    for (let i = 0; i < 3; i++) {
      store.create('message', { chatId: c.id, role: 'user', content: `alt ${i} ${gross}`, ordinal: i * 2 });
      store.create('message', { chatId: c.id, role: 'assistant', content: `antwort ${i}`, ordinal: i * 2 + 1 });
    }
    const ev = sammler();
    await chat.send({ chatId: c.id, content: 'neu', onEvent: ev });
    const hinweis = ev.seen.find((e) => e.type === 'hinweis');
    assert.ok(hinweis, 'der Nutzer erfährt es');
    assert.match(hinweis.satz, /weggelassen \(nicht zusammengefasst\)/);
    const b = claude.aufrufe[0].body;
    assert.ok(JSON.stringify(b.messages).length <= 2400000);
    assert.equal(b.messages[0].role, 'user');
    const letzte = b.messages[b.messages.length - 1];
    assert.equal(letzte.content[letzte.content.length - 1].text, 'neu', 'die neue Nachricht geht immer mit');
    assert.ok(!JSON.stringify(b.messages).includes('alt 0'), 'die ältesten fielen weg');
  }, { skript: [sagt('ok')] });
});

/* ----------------------------------------------------- Systemtext */

test('Die eigene Anweisung des Chats steht im zweiten Systemblock, der feste Teil bleibt fest', async () => {
  await mitChat(async ({ chat, store, claude }) => {
    store.create('memory', { text: 'Mag keine Pilze.' });
    const c = chat.create({ systemPrompt: 'Antworte immer in Reimen.' });
    await chat.send({ chatId: c.id, content: 'Was essen?' });
    const s = claude.aufrufe[0].body.system;
    assert.equal(s[0].text, SYSTEM_FEST);
    assert.match(s[1].text, /Mag keine Pilze\./);
    assert.match(s[1].text, /Antworte immer in Reimen\./);
    assert.deepEqual(s[1].cache_control, { type: 'ephemeral' });
  }, { skript: [sagt('Nudeln, die kann man essen, ohne Pilze zu vergessen.')] });
});

test('preview zeigt, was ginge, ohne zu senden', async () => {
  await mitChat(async ({ chat, claude }) => {
    const c = chat.create({});
    const p = chat.preview(c.id);
    assert.equal(claude.aufrufe.length, 0);
    assert.equal(p.system[0].text, SYSTEM_FEST);
    assert.deepEqual(p.werkzeuge, ['rueckfrage', 'termin_anlegen', 'notiz_anlegen', 'merken', 'projekt_anpassen']);
    assert.equal(p.modell, 'claude-opus-5');
  });
});

/* -------------------------------------------------- Herkunft, Graph */

test('usedNetwork kommt aus der Schleuse, nicht aus einer Vermutung', async () => {
  await mitChat(async ({ chat, bus }) => {
    const c = chat.create({});
    const r = await chat.send({ chatId: c.id, content: 'x' });
    assert.equal(r.message.data.usedNetwork, true);
    assert.deepEqual(r.message.data.networkTargets, ['api.anthropic.com:443']);
    void bus;
  }, {
    skript: [async (opts) => {
      // So meldet die echte Schleuse einen erlaubten Aufruf für diesen Chat.
      opts.gate.check({ host: 'api.anthropic.com', port: 443, scope: opts.scope, purpose: 'test' });
      return sagt('ok')(opts);
    }],
    mutateConfig: (cfg) => { cfg.network.mode = 'online'; cfg.network.strictAllowlist = false; },
  });
});

test('Eine fertige Antwort bringt den Chat in den Wissensgraphen', async () => {
  await mitChat(async ({ chat, store }) => {
    const c = chat.create({});
    const r = await chat.send({ chatId: c.id, content: 'x' });
    const kanten = store.edges.for(r.message.id);
    assert.ok(kanten.some((e) => e.data.kind === 'belongs-to' && e.data.to === c.id));
  }, { skript: [sagt('ok')] });
});

test('stance nennt Claude und das Netz', async () => {
  await mitChat(async ({ chat }) => {
    const c = chat.create({});
    const s = chat.stance(c.id);
    assert.equal(s.claude.verbunden, true);
    assert.equal(s.claude.modell, 'claude-opus-5');
    assert.equal(s.scope, `chat:${c.id}`);
  });
});

test('Die Token-Schätzung ist absichtlich pessimistisch', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('x'.repeat(400)) > 100);
});

module.exports = { name: 'chat', tests: drain() };
