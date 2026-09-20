'use strict';

/**
 * Tests for src/models/chat.js.
 *
 * Two rules hold everywhere in this file:
 *   - no test touches the real home directory (always `tempHome`);
 *   - no test reaches the internet. Most tests use a hand-written registry
 *     stand-in so the assertions are about orchestration rather than about a
 *     provider's wire format; the one end-to-end test binds an Ollama-shaped
 *     `fakeServer` on 127.0.0.1 and drives the REAL gate, registry and
 *     provider through it, which is what makes the loopback-is-not-network
 *     claim a proven one rather than a stated one.
 */

const assert = require('node:assert/strict');
const { test, drain, tempHome, fakeServer } = require('./harness');

const { openStore } = require('../src/store/engine');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const { createGate } = require('../src/net/gate');
const { createRegistry } = require('../src/models/registry');
const derive = require('../src/graph/derive');
const view = require('../src/graph/view');
const { createChatService, estimateTokens } = require('../src/models/chat');
const { NoModelError, ModelError } = require('../src/kernel/errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET = Object.freeze({
  providerId: 'ollama',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'testmodell',
});

/**
 * A registry stand-in. `chatImpl` gets the same options the real registry
 * passes on to a provider, so a test can stream, stall, abort or throw exactly
 * where a real backend would.
 */
function fakeRegistry(chatImpl, opts = {}) {
  const target = { ...TARGET, ...(opts.target || {}) };
  return {
    calls: [],
    resolve() {
      if (opts.resolveError) throw opts.resolveError;
      return target;
    },
    isOffline() {
      return true;
    },
    list() {
      return {
        at: new Date().toISOString(),
        providers: [{
          id: target.providerId,
          kind: target.kind,
          baseUrl: target.baseUrl,
          available: true,
          models: [{ id: target.model, name: target.model, contextLength: opts.contextLength ?? null }],
        }],
      };
    },
    async chat(ref, options) {
      // The real registry resolves first, so a resolution failure surfaces as
      // NoModelError from chat() rather than from somewhere else entirely.
      const resolved = this.resolve(ref);
      this.calls.push({ ref, options, resolved });
      return chatImpl.call(this, options);
    },
  };
}

/** Stream text through `onDelta` the way a real backend does, chunk by chunk. */
function streamer(chunks, extra = {}) {
  return async function chatImpl(options) {
    for (const chunk of chunks) {
      if (options.signal && options.signal.aborted) {
        const { AbortedError } = require('../src/kernel/errors');
        throw new AbortedError('Die Modellanfrage wurde abgebrochen.');
      }
      options.onDelta(chunk);
      await sleep(extra.delayMs || 0);
    }
    return {
      content: chunks.join(''),
      toolCalls: [],
      stats: { promptTokens: 11, completionTokens: 22, ms: 3 },
      provider: TARGET.providerId,
      model: TARGET.model,
      ...(extra.result || {}),
    };
  };
}

/**
 * Temporary vault + wiring. `deps` overrides anything (registry, gate, graph);
 * the store, bus and config are always real. `deps.realRegistry` builds the
 * actual registry on top of the actual gate, for the end-to-end test.
 */
async function withChat(label, fn, deps = {}) {
  const { home, cleanup } = tempHome(label);
  const bus = new Bus();
  const store = await openStore({ paths: home, bus });
  const config = configMod.defaults();
  if (typeof deps.mutateConfig === 'function') deps.mutateConfig(config);
  const audit = new Audit(`${home}/audit.jsonl`).open();
  const gate = deps.gate === null ? null : (deps.gate || createGate({ config, bus, audit, store }));
  const graph = deps.graph === null ? null : (deps.graph || { ...derive, ...view });
  let registry;
  if (deps.realRegistry) {
    registry = createRegistry({ config, gate, bus });
    await registry.refresh({ timeoutMs: 2000 });
  } else {
    registry = deps.registry || fakeRegistry(streamer(['Hallo']));
  }
  const chat = createChatService({ store, registry, gate, bus, graph, config });
  const events = [];
  bus.subscribe((e) => events.push(e));
  try {
    return await fn({ chat, store, bus, config, gate, registry, graph, events, home, audit });
  } finally {
    audit.close();
    try { await store.close(); } catch { /* already closed */ }
    cleanup();
  }
}

/** Collect everything `send` reports, in order. */
function collector() {
  const seen = [];
  const fn = (evt) => seen.push(evt);
  fn.seen = seen;
  fn.types = () => seen.map((e) => e.type);
  fn.of = (type) => seen.filter((e) => e.type === type);
  fn.text = () => seen.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  return fn;
}

/* --------------------------------------------------------- happy path */

test('send streams the answer into the message record', async () => {
  await withChat('chat-send', async ({ chat, store }) => {
    const record = chat.create({ title: 'Neuer Chat' });
    const onEvent = collector();

    const { userMessage, message } = await chat.send({ chatId: record.id, content: 'Wie spät ist es?', onEvent });

    assert.equal(userMessage.data.role, 'user');
    assert.equal(userMessage.data.content, 'Wie spät ist es?');
    assert.equal(message.data.role, 'assistant');
    assert.equal(message.data.content, 'Hallo');
    assert.equal(message.data.status, 'complete');
    assert.deepEqual(message.data.stats, { promptTokens: 11, completionTokens: 22, ms: 3 });
    assert.deepEqual(message.data.model, { provider: 'ollama', model: 'testmodell' });

    // Persisted, not just returned.
    assert.equal(store.get(message.id).data.content, 'Hallo');

    const types = onEvent.types();
    assert.deepEqual(types.slice(0, 3), ['user', 'start', 'delta']);
    assert.equal(types[types.length - 1], 'done');
    assert.equal(onEvent.text(), 'Hallo');
    assert.equal(onEvent.of('message').length, 1);
  });
});

test('the chat is named after the first thing the user actually wrote', async () => {
  await withChat('chat-title', async ({ chat, store }) => {
    const record = chat.create({});
    assert.equal(record.data.title, 'Neuer Chat');

    await chat.send({ chatId: record.id, content: '  Wie richte ich Ollama ein?\nZweite Zeile' });
    assert.equal(store.get(record.id).data.title, 'Wie richte ich Ollama ein?');

    // A second message must not rewrite a title that now exists.
    await chat.send({ chatId: record.id, content: 'Und weiter?' });
    assert.equal(store.get(record.id).data.title, 'Wie richte ich Ollama ein?');
  });
});

test('messages come back in the order they were written', async () => {
  await withChat('chat-order', async ({ chat }) => {
    const record = chat.create({});
    await chat.send({ chatId: record.id, content: 'eins' });
    await chat.send({ chatId: record.id, content: 'zwei' });
    const { items, total } = chat.messages(record.id);
    assert.equal(total, 4);
    assert.deepEqual(items.map((m) => m.data.role), ['user', 'assistant', 'user', 'assistant']);
    assert.deepEqual(items.map((m) => m.data.content), ['eins', 'Hallo', 'zwei', 'Hallo']);
  });
});

/* ------------------------------------------------------------- honesty */

test('a model failure is recorded as failed, never as an answer', async () => {
  const registry = fakeRegistry(async () => {
    throw new ModelError('Ollama hat die Anfrage mit HTTP 500 abgelehnt: kaputt', { status: 500, body: 'kaputt' });
  });
  await withChat('chat-fail', async ({ chat, store, events }) => {
    const record = chat.create({});
    const onEvent = collector();

    await assert.rejects(
      () => chat.send({ chatId: record.id, content: 'Hallo?', onEvent }),
      (err) => { assert.equal(err.code, 'MODEL_ERROR'); return true; },
    );

    const assistant = chat.messages(record.id).items.find((m) => m.data.role === 'assistant');
    assert.ok(assistant, 'the attempt must leave a record behind');
    assert.equal(assistant.data.status, 'failed');
    assert.equal(assistant.data.content, '', 'nothing arrived, so nothing may be stored');
    assert.equal(assistant.data.error.code, 'MODEL_ERROR');
    assert.equal(assistant.data.error.details.status, 500);
    assert.equal(store.get(assistant.id).data.status, 'failed');

    assert.equal(onEvent.of('error').length, 1);
    assert.ok(events.some((e) => e.name === 'chat.error'));
  }, { registry });
});

test('without a reachable model the chat errors instead of inventing one', async () => {
  const registry = fakeRegistry(async () => { throw new Error('unreachable'); }, {
    resolveError: new NoModelError('Es ist kein lokales Modell erreichbar.'),
  });
  await withChat('chat-nomodel', async ({ chat }) => {
    const record = chat.create({});
    await assert.rejects(
      () => chat.send({ chatId: record.id, content: 'Hallo?' }),
      (err) => { assert.equal(err.code, 'NO_MODEL_AVAILABLE'); return true; },
    );
    const assistant = chat.messages(record.id).items.find((m) => m.data.role === 'assistant');
    assert.equal(assistant.data.status, 'failed');
    assert.equal(assistant.data.content, '');
  }, { registry });
});

test('abort keeps the partial answer and marks it aborted', async () => {
  const registry = fakeRegistry(streamer(['Der ', 'Anfang ', 'der ', 'Antwort ', 'und ', 'noch ', 'mehr'], { delayMs: 15 }));
  await withChat('chat-abort', async ({ chat, store }) => {
    const record = chat.create({});
    const onEvent = collector();

    const pending = chat.send({ chatId: record.id, content: 'Erzähl etwas Langes', onEvent });
    // Let a few chunks through, then stop it the way the UI's stop button does.
    await sleep(40);
    assert.equal(chat.isStreaming(record.id), true);
    assert.equal(chat.abort(record.id), true);

    await assert.rejects(pending, (err) => { assert.equal(err.code, 'ABORTED'); return true; });

    const assistant = chat.messages(record.id).items.find((m) => m.data.role === 'assistant');
    assert.equal(assistant.data.status, 'aborted');
    assert.ok(assistant.data.content.length > 0, 'the partial answer must survive');
    assert.ok(onEvent.text().startsWith(assistant.data.content.slice(0, 4)));
    assert.equal(store.get(assistant.id).data.content, assistant.data.content);
    assert.equal(chat.isStreaming(record.id), false);

    // What was kept is exactly what the model sent -- no completion, no filler.
    assert.ok('Der Anfang der Antwort und noch mehr'.startsWith(assistant.data.content));
  }, { registry });
});

test('an external AbortSignal stops the send too', async () => {
  const registry = fakeRegistry(streamer(['a', 'b', 'c', 'd', 'e'], { delayMs: 15 }));
  await withChat('chat-abort-signal', async ({ chat }) => {
    const record = chat.create({});
    const controller = new AbortController();
    const pending = chat.send({ chatId: record.id, content: 'los', signal: controller.signal });
    await sleep(25);
    controller.abort();
    await assert.rejects(pending, (err) => { assert.equal(err.code, 'ABORTED'); return true; });
    const assistant = chat.messages(record.id).items.find((m) => m.data.role === 'assistant');
    assert.equal(assistant.data.status, 'aborted');
  }, { registry });
});

test('a second send while one is running is refused, not queued silently', async () => {
  const registry = fakeRegistry(streamer(['x', 'y', 'z'], { delayMs: 20 }));
  await withChat('chat-concurrent', async ({ chat }) => {
    const record = chat.create({});
    const first = chat.send({ chatId: record.id, content: 'eins' });
    await sleep(10);
    await assert.rejects(
      () => chat.send({ chatId: record.id, content: 'zwei' }),
      /läuft bereits eine Antwort/,
    );
    await first;
    // The refusal must not have written a stray user message.
    assert.equal(chat.messages(record.id).total, 2);
  }, { registry });
});

test('empty input and unknown chats are rejected at the boundary', async () => {
  await withChat('chat-guards', async ({ chat }) => {
    const record = chat.create({});
    await assert.rejects(() => chat.send({ chatId: record.id, content: '   ' }), /leer/);
    await assert.rejects(() => chat.send({ chatId: record.id }), /leer/);
    await assert.rejects(() => chat.send({ chatId: 'chat_doesnotexist00000000', content: 'x' }), /not found/);
    await assert.rejects(() => chat.send({ content: 'x' }), /Chat-Kennung/);
    await assert.rejects(
      () => chat.send({ chatId: record.id, content: 'x'.repeat(200001) }),
      /zu lang/,
    );
    assert.equal(chat.messages(record.id).total, 0);
  });
});

/* -------------------------------------------------------- system prompt */

test('the system prompt names the real network situation, not the wish', async () => {
  const captured = [];
  const registry = fakeRegistry(async function chatImpl(options) {
    captured.push(options.messages);
    options.onDelta('ok');
    return { content: 'ok', toolCalls: [], stats: {} };
  });
  await withChat('chat-prompt', async ({ chat, gate }) => {
    const offline = chat.create({ network: 'offline' });
    await chat.send({ chatId: offline.id, content: 'Frage' });
    const first = captured[0][0];
    assert.equal(first.role, 'system');
    assert.match(first.content, /Netzzugang: keiner/);
    assert.match(first.content, /läuft lokal auf diesem Gerät/);
    assert.match(first.content, /kannst nichts nachschlagen/);

    // A chat that CLAIMS online without a grant must be told it has none.
    const wishful = chat.create({ network: 'online' });
    await chat.send({ chatId: wishful.id, content: 'Frage' });
    assert.match(captured[1][0].content, /keine gültige Freigabe/);

    // With a real grant for this chat's scope, the prompt says so and names the host.
    const granted = chat.create({ network: 'online' });
    gate.addGrant({ scope: `chat:${granted.id}`, level: 'online', hosts: ['de.wikipedia.org'], reason: 'Test' });
    await chat.send({ chatId: granted.id, content: 'Frage' });
    assert.match(captured[2][0].content, /de\.wikipedia\.org/);
    assert.doesNotMatch(captured[2][0].content, /Netzzugang: keiner/);
  }, { registry });
});

test('the user system prompt is added without overwriting the facts', async () => {
  const captured = [];
  const registry = fakeRegistry(async function chatImpl(options) {
    captured.push(options.messages[0].content);
    options.onDelta('ok');
    return { content: 'ok', toolCalls: [], stats: {} };
  });
  await withChat('chat-userprompt', async ({ chat }) => {
    const record = chat.create({ systemPrompt: 'Antworte immer als Pirat.' });
    await chat.send({ chatId: record.id, content: 'Moin' });
    assert.match(captured[0], /Antworte immer als Pirat\./);
    assert.ok(
      captured[0].indexOf('Netzzugang') < captured[0].indexOf('Pirat'),
      'the facts must come before the user instruction so it cannot rewrite them',
    );
  }, { registry });
});

/* ------------------------------------------------------ pinned context */

test('pinned graph nodes are included and missing ones are reported honestly', async () => {
  const captured = [];
  const registry = fakeRegistry(async function chatImpl(options) {
    captured.push(options.messages[0].content);
    options.onDelta('ok');
    return { content: 'ok', toolCalls: [], stats: {} };
  });
  await withChat('chat-pinned', async ({ chat, store }) => {
    const note = store.create('note', { title: 'Reiseplan', body: 'Abfahrt um 7 Uhr ab Bahnhof.' });
    const record = chat.create({ contextNodeIds: [note.id, 'note_verschwunden00000000'] });
    const onEvent = collector();

    await chat.send({ chatId: record.id, content: 'Wann fahren wir?', onEvent });

    assert.match(captured[0], /Angeheftete Einträge/);
    assert.match(captured[0], /Reiseplan/);
    assert.match(captured[0], /Abfahrt um 7 Uhr/);
    assert.match(captured[0], /existiert nicht mehr/);

    const notice = onEvent.of('context')[0];
    assert.ok(notice, 'the UI must learn that a pinned entry is gone');
    assert.deepEqual(notice.pinnedMissing, ['note_verschwunden00000000']);
  }, { registry });
});

/* --------------------------------------------------------- token budget */

test('an over-long history is trimmed by omission, never by summarising', async () => {
  const captured = [];
  const registry = fakeRegistry(async function chatImpl(options) {
    captured.push(options.messages);
    options.onDelta('ok');
    return { content: 'ok', toolCalls: [], stats: {} };
  }, { contextLength: 1024 }); // budget = 1024 * 0.6 tokens, i.e. very tight

  await withChat('chat-budget', async ({ chat, store, events }) => {
    const record = chat.create({});
    const originals = [];
    for (let i = 0; i < 12; i++) {
      const text = `Nachricht Nummer ${i} `.padEnd(420, 'x');
      originals.push(text);
      store.create('message', { chatId: record.id, role: 'user', content: text, status: 'complete', ordinal: i * 2 });
      store.create('message', { chatId: record.id, role: 'assistant', content: `Antwort ${i}`, status: 'complete', ordinal: i * 2 + 1 });
    }

    const onEvent = collector();
    await chat.send({ chatId: record.id, content: 'Und jetzt?', onEvent });

    const sent = captured[0];
    assert.equal(sent[0].role, 'system');
    const history = sent.slice(1);
    assert.ok(history.length < 25, `expected a trimmed history, got ${history.length} messages`);
    assert.equal(history[history.length - 1].content, 'Und jetzt?', 'the newest turn is always sent');

    // Everything that WAS sent is verbatim -- no condensed stand-in anywhere.
    for (const msg of history) {
      const isOriginal = originals.includes(msg.content)
        || /^Antwort \d+$/.test(msg.content)
        || msg.content === 'Und jetzt?';
      assert.ok(isOriginal, `content was rewritten: ${msg.content.slice(0, 60)}`);
    }
    assert.ok(!sent.some((m) => /zusammengefasst|Zusammenfassung/i.test(m.content)));

    // And the UI is told, in numbers.
    const notice = onEvent.of('context')[0];
    assert.ok(notice, 'trimming must be announced');
    assert.ok(notice.omitted > 0);
    assert.equal(notice.omitted + notice.keptMessages, 25, 'every message is either kept or counted as omitted');
    assert.match(notice.message, /ausgelassen/);
    assert.ok(events.some((e) => e.name === 'chat.context'));
  }, { registry });
});

test('a single message larger than the budget is sent anyway, and said so', async () => {
  const captured = [];
  const registry = fakeRegistry(async function chatImpl(options) {
    captured.push(options.messages);
    options.onDelta('ok');
    return { content: 'ok', toolCalls: [], stats: {} };
  }, { contextLength: 600 });

  await withChat('chat-overflow', async ({ chat }) => {
    const record = chat.create({});
    const onEvent = collector();
    const huge = 'z'.repeat(20000);
    await chat.send({ chatId: record.id, content: huge, onEvent });

    assert.equal(captured[0][captured[0].length - 1].content, huge);
    const notice = onEvent.of('context')[0];
    assert.equal(notice.overflow, true);
    assert.match(notice.message, /Kontextbudget/);
  }, { registry });
});

test('preview shows the context without sending anything', async () => {
  const registry = fakeRegistry(async () => { throw new Error('preview must not call the model'); });
  await withChat('chat-preview', async ({ chat, store }) => {
    const record = chat.create({});
    store.create('message', { chatId: record.id, role: 'user', content: 'Hallo', status: 'complete', ordinal: 0 });
    const preview = chat.preview(record.id);
    assert.equal(preview.messages[0].role, 'system');
    assert.equal(preview.messages[1].content, 'Hallo');
    assert.equal(preview.omitted, 0);
    assert.ok(preview.budgetTokens > 0);
  }, { registry });
});

test('the token estimate is deliberately pessimistic', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 2); // 4 chars -> 1 token -> x1.25 -> ceil 2
  // 1000 characters of German must never be estimated at fewer than 250 tokens.
  assert.ok(estimateTokens('ä'.repeat(1000)) >= 250);
});

/* ------------------------------------------------------- failed history */

test('a failed empty answer is not replayed as part of the conversation', async () => {
  const captured = [];
  const registry = fakeRegistry(async function chatImpl(options) {
    captured.push(options.messages);
    options.onDelta('ok');
    return { content: 'ok', toolCalls: [], stats: {} };
  });
  await withChat('chat-failed-history', async ({ chat, store }) => {
    const record = chat.create({});
    store.create('message', { chatId: record.id, role: 'user', content: 'Alte Frage', status: 'complete', ordinal: 0 });
    store.create('message', { chatId: record.id, role: 'assistant', content: '', status: 'failed', ordinal: 1, error: { code: 'MODEL_ERROR', message: 'kaputt' } });
    store.create('message', { chatId: record.id, role: 'assistant', content: 'Halb fert', status: 'aborted', ordinal: 2 });

    await chat.send({ chatId: record.id, content: 'Neue Frage' });
    const sent = captured[0];
    assert.ok(!sent.some((m) => m.content === ''), 'an empty failed turn must not be sent');
    const aborted = sent.find((m) => m.content.startsWith('Halb fert'));
    assert.ok(aborted, 'a real partial answer stays part of the history');
    assert.match(aborted.content, /abgebrochen/, 'and it is marked as cut off, not passed off as complete');
  }, { registry });
});

/* ---------------------------------------------------------- provenance */

test('usedNetwork and networkTargets come from the gate, not from a guess', async () => {
  let busRef = null;
  const registry = fakeRegistry(async function chatImpl(options) {
    // Stand in for the gate: publish exactly what it would publish for a call
    // that really left the machine, in this chat's scope.
    busRef.publish('network.attempt', {
      host: 'llm.example', ip: '203.0.113.7', port: 443, scope: options.scope,
      classification: 'public', allowed: true, level: 'online', reason: 'Freigabe',
    });
    // A decision for ANOTHER chat must not bleed into this message.
    busRef.publish('network.attempt', {
      host: 'fremd.example', port: 443, scope: 'chat:jemand_anders',
      classification: 'public', allowed: true,
    });
    // A blocked attempt is not a contacted target.
    busRef.publish('network.attempt', {
      host: 'geblockt.example', port: 443, scope: options.scope,
      classification: 'public', allowed: false,
    });
    options.onDelta('ok');
    return { content: 'ok', toolCalls: [], stats: {} };
  });

  await withChat('chat-provenance', async ({ chat, bus }) => {
    busRef = bus;
    const record = chat.create({});
    const { message } = await chat.send({ chatId: record.id, content: 'Frage' });
    assert.equal(message.data.usedNetwork, true);
    assert.deepEqual(message.data.networkTargets, ['llm.example:443']);
  }, { registry });
});

test('a loopback model is recorded as a target but does not count as network use', async () => {
  let busRef = null;
  const registry = fakeRegistry(async function chatImpl(options) {
    busRef.publish('network.attempt', {
      host: '127.0.0.1', port: 11434, scope: options.scope,
      classification: 'loopback', allowed: true, level: 'local',
    });
    options.onDelta('ok');
    return { content: 'ok', toolCalls: [], stats: {} };
  });
  await withChat('chat-loopback', async ({ chat, bus }) => {
    busRef = bus;
    const record = chat.create({});
    const { message } = await chat.send({ chatId: record.id, content: 'Frage' });
    assert.equal(message.data.usedNetwork, false, 'this machine talking to itself is not network use');
    assert.deepEqual(message.data.networkTargets, ['127.0.0.1:11434']);
  }, { registry });
});

/* --------------------------------------------------------------- graph */

test('a finished answer puts the chat into the knowledge graph', async () => {
  await withChat('chat-graph', async ({ chat, store }) => {
    const record = chat.create({ title: 'Graphtest' });
    const { message, userMessage } = await chat.send({ chatId: record.id, content: 'Hallo Welt' });

    const edges = store.edges.for(record.id, { direction: 'both' });
    const kinds = edges.map((e) => `${e.data.from === userMessage.id ? 'user' : e.data.from === message.id ? 'assistant' : '?'}:${e.data.kind}`);
    assert.ok(kinds.includes('user:belongs-to'), `expected the user message to belong to the chat, got ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('assistant:belongs-to'), 'expected the answer to belong to the chat too');

    const graph = view.buildGraph(store, { focus: record.id, depth: 1 });
    assert.ok(graph.nodes.some((n) => n.id === record.id && n.type === 'chat'));
  });
});

test('an aborted answer still belongs to the chat, a failed empty one does not', async () => {
  const registry = fakeRegistry(async () => {
    throw new ModelError('Backend weg', {});
  });
  await withChat('chat-graph-failed', async ({ chat, store }) => {
    const record = chat.create({});
    await assert.rejects(() => chat.send({ chatId: record.id, content: 'Hallo' }));
    const assistant = chat.messages(record.id).items.find((m) => m.data.role === 'assistant');
    const edges = store.edges.for(assistant.id, { direction: 'both' });
    assert.equal(edges.length, 0, 'an answer that never existed must not appear in the graph');
  }, { registry });
});

/* ------------------------------------------------------------- stance */

test('stance reports what the gate really allows for this chat', async () => {
  await withChat('chat-stance', async ({ chat, gate }) => {
    const record = chat.create({ network: 'online' });
    const before = chat.stance(record.id);
    assert.equal(before.declared, 'online');
    assert.equal(before.internet, false, 'a label is not a permission');
    assert.equal(before.known, true);

    gate.addGrant({ scope: `chat:${record.id}`, level: 'online', hosts: ['*'], reason: 'Test' });
    const after = chat.stance(record.id);
    assert.equal(after.internet, true);
    assert.equal(after.model.local, true);
  });
});

test('the policy preview never touches the audit trail or the counters', async () => {
  await withChat('chat-stance-quiet', async ({ chat, gate, audit }) => {
    const record = chat.create({ network: 'online' });
    const before = gate.stats();
    chat.stance(record.id);
    chat.preview(record.id);
    const after = gate.stats();
    assert.equal(after.allowed, before.allowed);
    assert.equal(after.blocked, before.blocked);
    assert.equal(audit.tail(50).filter((e) => String(e.kind).startsWith('network.')).length, 0);
  });
});

/* ------------------------------------------------------------ end-to-end */

test('end to end against a local Ollama-shaped server: real gate, real provider', async () => {
  const requests = [];
  const server = await fakeServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'testmodell:latest', model: 'testmodell:latest', size: 12, details: { family: 'llama' } }] }));
      return;
    }
    if (req.url === '/api/chat') {
      const body = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        const sent = JSON.parse(Buffer.concat(body).toString('utf8'));
        // Prove the real system prompt and the real question travelled.
        const system = sent.messages.find((m) => m.role === 'system');
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { content: 'Servus' }, done: false })}\n`);
        res.write(`${JSON.stringify({ message: { content: ', hier ist dein lokales Modell.' }, done: false })}\n`);
        res.write(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: system ? 7 : 0, eval_count: 5 })}\n`);
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });

  try {
    await withChat('chat-e2e', async ({ chat, store }) => {
      const record = chat.create({ title: 'Lokal' });
      const onEvent = collector();
      const { message } = await chat.send({ chatId: record.id, content: 'Sag Hallo', onEvent });

      assert.equal(message.data.content, 'Servus, hier ist dein lokales Modell.');
      assert.equal(message.data.status, 'complete');
      assert.equal(message.data.stats.promptTokens, 7);
      assert.equal(message.data.stats.completionTokens, 5);
      // The model ran on 127.0.0.1, so it is a target but not network use.
      assert.equal(message.data.usedNetwork, false);
      assert.ok(
        message.data.networkTargets.some((t) => t.startsWith('127.0.0.1:')),
        `expected the loopback backend among the targets, got ${JSON.stringify(message.data.networkTargets)}`,
      );
      assert.ok(onEvent.text().length > 0, 'the answer must have streamed, not arrived in one lump');
      assert.ok(requests.includes('/api/chat'));
      assert.equal(store.get(message.id).data.content, message.data.content);
    }, {
      mutateConfig(config) {
        config.models.providers = [{ id: 'ollama', kind: 'ollama', baseUrl: server.url, enabled: true }];
        config.models.default = { provider: 'ollama', model: 'testmodell:latest' };
      },
      realRegistry: true,
    });
  } finally {
    await server.close();
  }
});

module.exports = { name: 'chat', tests: drain() };
