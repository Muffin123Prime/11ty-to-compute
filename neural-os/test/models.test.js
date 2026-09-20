'use strict';

const assert = require('node:assert/strict');
const { test, drain, fakeServer, waitForEvent } = require('./harness');

const ollama = require('../src/models/providers/ollama');
const openai = require('../src/models/providers/openai');
const { createRegistry } = require('../src/models/registry');
const { Bus } = require('../src/kernel/bus');
const configMod = require('../src/kernel/config');
const { NetworkBlockedError } = require('../src/kernel/errors');

/**
 * Model layer tests.
 *
 * Two rules this file obeys without exception:
 *  - no request ever leaves 127.0.0.1 (the stand-in gate refuses anything else,
 *    so even a bug in a provider cannot turn into real egress), and
 *  - the network is always a `fakeServer`, never a real backend.
 *
 * The centre of gravity is stream framing. Every streaming test deliberately
 * cuts the response into tiny, badly placed pieces -- mid JSON token, mid
 * `data:` line, and mid UTF-8 sequence of a German umlaut -- because that is
 * where this kind of code actually breaks, and a test that sends one tidy
 * chunk proves nothing.
 */

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || LOOPBACK_V4.test(h);
}

/**
 * Stand-in for src/net/gate.js (which another agent owns and which may not
 * exist yet). It enforces the two properties the providers rely on: a scope is
 * mandatory, and nothing but loopback is ever dialled.
 */
function testGate(opts = {}) {
  const calls = [];
  return {
    calls,
    classify(host) {
      return isLoopback(host) ? 'loopback' : 'public';
    },
    async fetch(url, init = {}) {
      if (typeof init.scope !== 'string' || !init.scope) {
        throw new Error('gate.fetch wurde ohne scope aufgerufen');
      }
      const target = new URL(url);
      calls.push({ url, scope: init.scope, purpose: init.purpose, method: init.method || 'GET' });
      if (!isLoopback(target.hostname)) {
        throw new NetworkBlockedError(`Blockiert: ${target.hostname} ist nicht loopback`);
      }
      if (opts.block) throw new NetworkBlockedError('Durch Test-Policy blockiert');
      return fetch(url, {
        method: init.method || 'GET',
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write `text` in deliberately unhelpful slices, with a pause between them. */
async function writeSliced(res, text, size = 5, delayMs = 1) {
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i += size) {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(buf.subarray(i, i + size));
    } catch {
      return; // client went away mid-stream
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  if (!res.destroyed && !res.writableEnded) {
    try { res.end(); } catch { /* client gone */ }
  }
}

function quiet(req, res) {
  req.on('error', () => {});
  res.on('error', () => {});
}

function ndjson(frames) {
  return frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
}

function readRequest(req) {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

/** A port that is guaranteed to have nothing listening on it. */
async function closedUrl() {
  const server = await fakeServer(() => {});
  const url = server.url;
  await server.close();
  return url;
}

async function withServer(handler, fn) {
  const held = [];
  const server = await fakeServer((req, res) => {
    quiet(req, res);
    held.push(res);
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent && !res.destroyed) {
        try { res.writeHead(500); res.end('{}'); } catch { /* gone */ }
      }
    });
  });
  try {
    return await fn(server);
  } finally {
    for (const res of held) {
      try { if (!res.writableEnded) res.destroy(); } catch { /* already gone */ }
    }
    await server.close();
  }
}

/**
 * A default config with the model section emptied out. Fields are assigned
 * directly rather than through `config.deepMerge`, because merging an object
 * onto the `models.default: null` of the defaults throws in that helper.
 */
function baseConfig(patch = {}) {
  const c = configMod.defaults();
  const m = patch.models || {};
  c.models.providers = m.providers || [];
  c.models.remote = m.remote || [];
  c.models.default = m.default === undefined ? null : m.default;
  return c;
}

// ---------------------------------------------------------------------------
// Framing: the pure parsers, sliced byte by byte
// ---------------------------------------------------------------------------

test('LineSplitter setzt Zeilen und UTF-8-Zeichen über Chunk-Grenzen zusammen', () => {
  const { LineSplitter } = ollama.__internals;
  const source = 'Grüße aus München\nZweite Zeile mit ß und €\nDritte\n';
  const bytes = Buffer.from(source, 'utf8');
  const splitter = new LineSplitter();
  const lines = [];
  // One byte at a time is the worst case: every multi-byte character and every
  // newline arrives split.
  for (let i = 0; i < bytes.length; i++) lines.push(...splitter.push(bytes.subarray(i, i + 1)));
  lines.push(...splitter.flush());
  assert.deepEqual(lines, ['Grüße aus München', 'Zweite Zeile mit ß und €', 'Dritte']);
  assert.ok(!lines.join('').includes('�'), 'kein Ersatzzeichen durch zerrissenes UTF-8');
});

test('LineSplitter behandelt CRLF und eine Restzeile ohne Zeilenumbruch', () => {
  const { LineSplitter } = ollama.__internals;
  const s = new LineSplitter();
  assert.deepEqual(s.push('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(s.push('unvollstä'), []);
  assert.deepEqual(s.flush(), ['unvollstä']);
  assert.deepEqual(s.flush(), []);
});

test('LineSplitter verweigert eine unplausibel lange Zeile', () => {
  const { LineSplitter } = ollama.__internals;
  const s = new LineSplitter(64);
  assert.throws(() => s.push('x'.repeat(100)), (err) => err.code === 'MODEL_ERROR');
});

test('SseParser versteht zerhackte data:-Zeilen, Kommentare, CRLF und Mehrzeilen-Daten', () => {
  const { SseParser } = openai.__internals;
  const raw = ': keep-alive\r\n\r\ndata: {"a":1}\r\n\r\nevent: ping\r\ndata: zeile1\r\ndata: zeile2\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = Buffer.from(raw, 'utf8');
  const parser = new SseParser();
  const events = [];
  for (let i = 0; i < bytes.length; i += 3) events.push(...parser.push(bytes.subarray(i, i + 3)));
  events.push(...parser.flush());
  assert.deepEqual(events, [
    { event: 'message', data: '{"a":1}' },
    { event: 'ping', data: 'zeile1\nzeile2' },
    { event: 'message', data: '[DONE]' },
  ]);
});

test('ToolCallAccumulator fügt Argument-Fragmente zusammen und parst erst am Ende', () => {
  const { ToolCallAccumulator } = openai.__internals;
  const acc = new ToolCallAccumulator();
  acc.mergeDeltas([{ index: 0, id: 'call_1', function: { name: 'notes.search', arguments: '{"q":"Mün' } }]);
  acc.mergeDeltas([{ index: 0, function: { arguments: 'chen"}' } }]);
  acc.mergeDeltas([{ index: 1, id: 'call_2', function: { name: 'time.now', arguments: '{}' } }]);
  const calls = acc.finish();
  assert.deepEqual(calls, [
    { id: 'call_1', name: 'notes.search', arguments: { q: 'München' } },
    { id: 'call_2', name: 'time.now', arguments: {} },
  ]);
});

test('ToolCallAccumulator verdoppelt einen wiederholt gesendeten Namen nicht', () => {
  const { ToolCallAccumulator } = openai.__internals;
  const acc = new ToolCallAccumulator();
  acc.mergeDeltas([{ index: 0, id: 'c', function: { name: 'zeit', arguments: '{' } }]);
  acc.mergeDeltas([{ index: 0, function: { name: 'zeit', arguments: '}' } }]);
  assert.equal(acc.finish()[0].name, 'zeit');
});

test('Kaputte Werkzeug-Argumente werden gemeldet, nicht stillschweigend geleert', () => {
  const { ToolCallAccumulator } = openai.__internals;
  const acc = new ToolCallAccumulator();
  acc.mergeDeltas([{ index: 0, id: 'c', function: { name: 'x', arguments: '{kaputt' } }]);
  const call = acc.finish()[0];
  assert.deepEqual(call.arguments, {});
  assert.match(call.argumentsError, /kein gültiges JSON/);
  assert.equal(call.argumentsRaw, '{kaputt');
});

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

const TAGS_RESPONSE = {
  models: [
    {
      name: 'llama3.2:latest',
      model: 'llama3.2:latest',
      size: 2019393189,
      modified_at: '2025-01-01T00:00:00Z',
      details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
    },
    {
      name: 'qwen2.5:7b',
      model: 'qwen2.5:7b',
      size: 4683087519,
      details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
    },
  ],
};

test('Ollama-Probe liest /api/tags und normalisiert die Modell-Liste', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/api/tags');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TAGS_RESPONSE));
  }, async (server) => {
    const gate = testGate();
    const result = await ollama.probe({ baseUrl: server.url, gate, scope: 'global' });
    assert.equal(result.available, true);
    assert.equal(result.models.length, 2);
    assert.deepEqual(result.models[0], {
      id: 'llama3.2:latest',
      name: 'llama3.2:latest',
      family: 'llama',
      parameterSize: '3.2B',
      quantization: 'Q4_K_M',
      contextLength: null,
      sizeBytes: 2019393189,
      modifiedAt: '2025-01-01T00:00:00Z',
    });
    assert.ok(result.latencyMs >= 0);
    assert.equal(gate.calls.length, 1);
    assert.equal(gate.calls[0].scope, 'global');
  });
});

test('Ollama-Probe meldet einen laufenden Server ohne Modelle als erreichbar', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
  }, async (server) => {
    const result = await ollama.probe({ baseUrl: server.url, gate: testGate() });
    assert.equal(result.available, true);
    assert.deepEqual(result.models, []);
  });
});

test('Ollama-Probe wirft nicht, wenn gar nichts lauscht', async () => {
  const url = await closedUrl();
  const result = await ollama.probe({ baseUrl: url, gate: testGate(), timeoutMs: 800 });
  assert.equal(result.available, false);
  assert.deepEqual(result.models, []);
  assert.ok(result.error && result.error.length > 0);
  assert.ok(Number.isFinite(result.latencyMs));
});

test('Ollama-Probe erkennt einen fremden Server unter der Adresse', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>nginx</html>');
  }, async (server) => {
    const result = await ollama.probe({ baseUrl: server.url, gate: testGate() });
    assert.equal(result.available, false);
    assert.match(result.error, /kein Ollama|unlesbares JSON/);
  });
});

test('Ollama-Probe läuft in eine kurze Zeitüberschreitung statt zu hängen', async () => {
  await withServer(() => { /* never answers */ }, async (server) => {
    const started = Date.now();
    const result = await ollama.probe({ baseUrl: server.url, gate: testGate(), timeoutMs: 150 });
    assert.equal(result.available, false);
    assert.match(result.error, /nicht innerhalb von 150 ms/);
    assert.ok(Date.now() - started < 3000, 'die Probe muss schnell aufgeben');
  });
});

test('Ollama-Chat streamt NDJSON über ungünstig geschnittene Chunks', async () => {
  const frames = [
    { model: 'llama3.2', message: { role: 'assistant', content: 'Grüße' }, done: false },
    { model: 'llama3.2', message: { role: 'assistant', content: ' aus München' }, done: false },
    { model: 'llama3.2', message: { role: 'assistant', content: ' – ein ß, ein € und ein 😀' }, done: false },
    { model: 'llama3.2', message: { role: 'assistant', content: '.' }, done: false },
    {
      model: 'llama3.2',
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 11,
      eval_count: 7,
    },
  ];
  let seenBody = null;
  await withServer(async (req, res) => {
    seenBody = JSON.parse(await readRequest(req));
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Five bytes at a time: this cuts JSON tokens in half and lands inside the
    // multi-byte sequences of "ü", "ß", "€" and the emoji.
    await writeSliced(res, ndjson(frames), 5, 1);
  }, async (server) => {
    const deltas = [];
    const result = await ollama.chat({
      baseUrl: server.url,
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Hallo' }],
      options: { temperature: 0.2, maxTokens: 64, stop: ['\n\n'] },
      gate: testGate(),
      scope: 'chat:test',
      onDelta: (t) => deltas.push(t),
    });
    assert.equal(result.content, 'Grüße aus München – ein ß, ein € und ein 😀.');
    assert.ok(deltas.length >= 4, `erwartete mehrere Deltas, bekam ${deltas.length}`);
    assert.equal(deltas.join(''), result.content);
    assert.ok(!result.content.includes('�'));
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.stats.promptTokens, 11);
    assert.equal(result.stats.completionTokens, 7);
    assert.ok(result.stats.ms >= 0);
    assert.equal(result.finishReason, 'stop');
    // The request really carried what the caller asked for.
    assert.equal(seenBody.stream, true);
    assert.equal(seenBody.model, 'llama3.2');
    assert.equal(seenBody.options.temperature, 0.2);
    assert.equal(seenBody.options.num_predict, 64);
    assert.deepEqual(seenBody.options.stop, ['\n\n']);
  });
});

test('Ollama-Chat normalisiert native Werkzeugaufrufe auf {id,name,arguments}', async () => {
  const frames = [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'notes.search', arguments: { query: 'München', limit: 5 } } },
          { function: { name: 'time.now', arguments: {} } },
        ],
      },
      done: false,
    },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
  ];
  let seenBody = null;
  await withServer(async (req, res) => {
    seenBody = JSON.parse(await readRequest(req));
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    await writeSliced(res, ndjson(frames), 7, 1);
  }, async (server) => {
    const result = await ollama.chat({
      baseUrl: server.url,
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Wie spät ist es?' }],
      tools: [
        { name: 'notes.search', description: 'Notizen durchsuchen', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'time.now', description: 'Aktuelle Zeit' },
      ],
      gate: testGate(),
      scope: 'agent:a1',
    });
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, 'notes.search');
    assert.deepEqual(result.toolCalls[0].arguments, { query: 'München', limit: 5 });
    assert.ok(result.toolCalls[0].id, 'jeder Aufruf braucht eine ID für die Zuordnung');
    assert.notEqual(result.toolCalls[0].id, result.toolCalls[1].id);
    // Tools reach Ollama in its native (OpenAI-shaped) form.
    assert.equal(seenBody.tools[0].type, 'function');
    assert.equal(seenBody.tools[0].function.name, 'notes.search');
    assert.deepEqual(seenBody.tools[1].function.parameters, { type: 'object', properties: {} });
  });
});

test('Ollama-Chat spielt Werkzeug-Ergebnisse zurück in den Verlauf', async () => {
  let seenBody = null;
  await withServer(async (req, res) => {
    seenBody = JSON.parse(await readRequest(req));
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(ndjson([{ message: { role: 'assistant', content: 'fertig' }, done: true, done_reason: 'stop' }]));
  }, async (server) => {
    await ollama.chat({
      baseUrl: server.url,
      model: 'llama3.2',
      messages: [
        { role: 'user', content: 'Zeit?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'time.now', arguments: {} }] },
        { role: 'tool', name: 'time.now', toolCallId: 'c1', content: '12:00' },
      ],
      gate: testGate(),
    });
    assert.equal(seenBody.messages[1].tool_calls[0].function.name, 'time.now');
    assert.equal(seenBody.messages[2].role, 'tool');
    assert.equal(seenBody.messages[2].tool_name, 'time.now');
  });
});

test('Ollama-Chat macht aus HTTP 500 einen ModelError mit Status und Body-Auszug', async () => {
  await withServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'model runner has crashed' }));
  }, async (server) => {
    await assert.rejects(
      ollama.chat({ baseUrl: server.url, model: 'x', messages: [{ role: 'user', content: 'hi' }], gate: testGate() }),
      (err) => {
        assert.equal(err.code, 'MODEL_ERROR');
        assert.equal(err.status, 502);
        assert.equal(err.details.status, 500);
        assert.match(err.message, /HTTP 500/);
        assert.match(err.message, /model runner has crashed/);
        return true;
      },
    );
  });
});

test('Ollama-Chat macht aus einer Fehlerzeile im Stream einen ModelError', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ error: 'model "nixda" not found, try pulling it first' }) + '\n');
  }, async (server) => {
    await assert.rejects(
      ollama.chat({ baseUrl: server.url, model: 'nixda', messages: [{ role: 'user', content: 'hi' }], gate: testGate() }),
      (err) => {
        assert.equal(err.code, 'MODEL_ERROR');
        assert.match(err.message, /not found/);
        return true;
      },
    );
  });
});

test('Ollama-Chat meldet einen abgebrochenen Stream statt eine halbe Antwort auszugeben', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // No frame with done:true -- the backend died mid-sentence.
    res.end(ndjson([{ message: { role: 'assistant', content: 'Halber Sat' }, done: false }]));
  }, async (server) => {
    await assert.rejects(
      ollama.chat({ baseUrl: server.url, model: 'x', messages: [{ role: 'user', content: 'hi' }], gate: testGate() }),
      (err) => {
        assert.equal(err.code, 'MODEL_ERROR');
        assert.match(err.message, /brach ab/);
        assert.equal(err.details.partialContent, 'Halber Sat');
        return true;
      },
    );
  });
});

test('Ollama-Chat wirft NoModelError, wenn unter der Adresse nichts lauscht', async () => {
  const url = await closedUrl();
  await assert.rejects(
    ollama.chat({ baseUrl: url, model: 'x', messages: [{ role: 'user', content: 'hi' }], gate: testGate(), timeoutMs: 800 }),
    (err) => {
      assert.equal(err.code, 'NO_MODEL_AVAILABLE');
      assert.equal(err.status, 503);
      return true;
    },
  );
});

test('Ollama-Chat gibt beim Verbindungs-Timeout NoModelError zurück', async () => {
  await withServer(() => { /* never answers */ }, async (server) => {
    await assert.rejects(
      ollama.chat({
        baseUrl: server.url, model: 'x', messages: [{ role: 'user', content: 'hi' }],
        gate: testGate(), timeoutMs: 150,
      }),
      (err) => {
        assert.equal(err.code, 'NO_MODEL_AVAILABLE');
        assert.match(err.message, /nicht innerhalb von 150 ms/);
        return true;
      },
    );
  });
});

test('Ollama-Chat bricht per AbortSignal mitten im Stream ab', async () => {
  await withServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'erstes' }, done: false }) + '\n');
    // Long pause: the abort must land while we are waiting for more data, which
    // makes this deterministic instead of a race.
    await sleep(400);
    if (!res.destroyed) {
      try {
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'zweites' }, done: false }) + '\n');
        res.end(ndjson([{ message: { role: 'assistant', content: '' }, done: true }]));
      } catch { /* client gone */ }
    }
  }, async (server) => {
    const controller = new AbortController();
    const deltas = [];
    await assert.rejects(
      ollama.chat({
        baseUrl: server.url,
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        gate: testGate(),
        signal: controller.signal,
        onDelta: (t) => {
          deltas.push(t);
          controller.abort();
        },
      }),
      (err) => {
        assert.equal(err.code, 'ABORTED');
        return true;
      },
    );
    assert.deepEqual(deltas, ['erstes']);
  });
});

test('Ollama-Chat lehnt ein bereits abgebrochenes Signal sofort ab', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ollama.chat({
      baseUrl: 'http://127.0.0.1:1', model: 'x',
      messages: [{ role: 'user', content: 'hi' }], gate: testGate(), signal: controller.signal,
    }),
    (err) => err.code === 'ABORTED',
  );
});

test('Ollama-Chat prüft Eingaben, bevor irgendetwas das Gerät verlässt', async () => {
  const gate = testGate();
  await assert.rejects(
    ollama.chat({ baseUrl: 'http://127.0.0.1:11434', model: 'x', messages: [], gate }),
    (err) => err.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    ollama.chat({ baseUrl: 'http://127.0.0.1:11434', model: '', messages: [{ role: 'user', content: 'x' }], gate }),
    (err) => err.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    ollama.chat({ baseUrl: 'http://127.0.0.1:11434', model: 'x', messages: [{ role: 'roboter', content: 'x' }], gate }),
    (err) => err.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    ollama.chat({ baseUrl: 'ftp://127.0.0.1', model: 'x', messages: [{ role: 'user', content: 'x' }], gate }),
    (err) => err.code === 'VALIDATION_FAILED',
  );
  assert.equal(gate.calls.length, 0, 'bei ungültiger Eingabe darf nichts gesendet werden');
});

test('Ollama-Chat ohne Schleuse verweigert den Dienst', async () => {
  await assert.rejects(
    ollama.chat({ baseUrl: 'http://127.0.0.1:11434', model: 'x', messages: [{ role: 'user', content: 'x' }], gate: null }),
    (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /Netzwerkschleuse/);
      return true;
    },
  );
});

test('Eine Blockade der Schleuse bleibt eine Blockade, kein Modellfehler', async () => {
  await assert.rejects(
    ollama.chat({
      baseUrl: 'http://127.0.0.1:11434', model: 'x',
      messages: [{ role: 'user', content: 'x' }], gate: testGate({ block: true }),
    }),
    (err) => {
      assert.equal(err.code, 'NETWORK_BLOCKED');
      return true;
    },
  );
});

test('Ollama-Einbettungen nutzen /api/embed und fallen auf /api/embeddings zurück', async () => {
  const seen = [];
  await withServer(async (req, res) => {
    seen.push(req.url);
    const body = JSON.parse(await readRequest(req));
    if (req.url === '/api/embed') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embedding: [body.prompt.length, 0.5] }));
  }, async (server) => {
    const result = await ollama.embed({
      baseUrl: server.url, model: 'nomic', input: ['abc', 'de'], gate: testGate(),
    });
    assert.deepEqual(result.vectors, [[3, 0.5], [2, 0.5]]);
    assert.deepEqual(seen, ['/api/embed', '/api/embeddings', '/api/embeddings']);
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

function sseFrames(frames) {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
}

test('OpenAI-Probe liest /models und sendet den API-Schlüssel mit', async () => {
  let auth = null;
  await withServer((req, res) => {
    auth = req.headers.authorization || null;
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'Meta-Llama-3.1-8B-Instruct', object: 'model', owned_by: 'llamacpp', meta: { n_ctx: 8192 } },
        { id: 'zweites-modell', object: 'model' },
      ],
    }));
  }, async (server) => {
    const result = await openai.probe({ baseUrl: `${server.url}/v1`, gate: testGate(), apiKey: 'geheim-123' });
    assert.equal(result.available, true);
    assert.equal(result.models.length, 2);
    assert.equal(result.models[0].id, 'Meta-Llama-3.1-8B-Instruct');
    assert.equal(result.models[0].contextLength, 8192);
    assert.equal(result.models[1].contextLength, null, 'ohne Angabe wird keine Zahl erfunden');
    assert.equal(auth, 'Bearer geheim-123');
  });
});

test('OpenAI-Probe erklärt einen abgelehnten Schlüssel verständlich', async () => {
  await withServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  }, async (server) => {
    const result = await openai.probe({ baseUrl: `${server.url}/v1`, gate: testGate() });
    assert.equal(result.available, false);
    assert.match(result.error, /API-Schlüssel/);
  });
});

test('OpenAI-Chat streamt SSE über zerhackte Chunks', async () => {
  const frames = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Grüße' } }] },
    { choices: [{ index: 0, delta: { content: ' aus München' } }] },
    { choices: [{ index: 0, delta: { content: ' – ß, € und 😀' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 9 } },
  ];
  let seenBody = null;
  await withServer(async (req, res) => {
    seenBody = JSON.parse(await readRequest(req));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // Four bytes at a time cuts "data:" itself in half and lands inside the
    // multi-byte characters.
    await writeSliced(res, sseFrames(frames), 4, 1);
  }, async (server) => {
    const deltas = [];
    const result = await openai.chat({
      baseUrl: `${server.url}/v1`,
      model: 'llama-3.1-8b',
      messages: [{ role: 'system', content: 'Sei knapp.' }, { role: 'user', content: 'Hallo' }],
      options: { temperature: 0.1, maxTokens: 128, topP: 0.9, seed: 7 },
      gate: testGate(),
      scope: 'chat:c1',
      onDelta: (t) => deltas.push(t),
    });
    assert.equal(result.content, 'Grüße aus München – ß, € und 😀');
    assert.ok(deltas.length >= 3, `erwartete mehrere Deltas, bekam ${deltas.length}`);
    assert.equal(deltas.join(''), result.content);
    assert.ok(!result.content.includes('�'));
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.stats.promptTokens, 12);
    assert.equal(result.stats.completionTokens, 9);
    assert.equal(seenBody.stream, true);
    assert.equal(seenBody.max_tokens, 128);
    assert.equal(seenBody.top_p, 0.9);
    assert.equal(seenBody.seed, 7);
  });
});

test('OpenAI-Chat setzt Werkzeugaufrufe aus Fragmenten zusammen', async () => {
  const frames = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'notes.search', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query"' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ': "Mün' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'chen"}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_def', function: { name: 'time.now', arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await writeSliced(res, sseFrames(frames), 3, 1);
  }, async (server) => {
    const result = await openai.chat({
      baseUrl: `${server.url}/v1`,
      model: 'm',
      messages: [{ role: 'user', content: 'Suche' }],
      tools: [{ name: 'notes.search', parameters: { type: 'object', properties: {} } }, { name: 'time.now' }],
      gate: testGate(),
    });
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.toolCalls, [
      { id: 'call_abc', name: 'notes.search', arguments: { query: 'München' } },
      { id: 'call_def', name: 'time.now', arguments: {} },
    ]);
  });
});

test('OpenAI-Chat verkraftet einen Server, der stream:true ignoriert', async () => {
  await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'Ganz am Stück, mit Größe.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 6 },
    }));
  }, async (server) => {
    const deltas = [];
    const result = await openai.chat({
      baseUrl: `${server.url}/v1`, model: 'm',
      messages: [{ role: 'user', content: 'hi' }], gate: testGate(), onDelta: (t) => deltas.push(t),
    });
    assert.equal(result.content, 'Ganz am Stück, mit Größe.');
    assert.deepEqual(deltas, ['Ganz am Stück, mit Größe.']);
    assert.equal(result.stats.completionTokens, 6);
    assert.equal(result.finishReason, 'stop');
  });
});

test('OpenAI-Chat verkraftet Keep-alive-Kommentare und fehlendes [DONE]', async () => {
  await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const body = ': keep-alive\n\n'
      + `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`
      + ': noch am Leben\n\n'
      + `data: ${JSON.stringify({ choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] })}\n\n`;
    await writeSliced(res, body, 6, 1);
  }, async (server) => {
    const result = await openai.chat({
      baseUrl: `${server.url}/v1`, model: 'm', messages: [{ role: 'user', content: 'hi' }], gate: testGate(),
    });
    assert.equal(result.content, 'ab');
    assert.equal(result.finishReason, 'stop');
  });
});

test('OpenAI-Chat verkraftet einen als JSON deklarierten Ereignisstrom', async () => {
  // llama.cpp builds have shipped SSE under content-type: application/json.
  await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    await writeSliced(res, sseFrames([
      { choices: [{ delta: { content: 'trotzdem ' } }] },
      { choices: [{ delta: { content: 'richtig' }, finish_reason: 'stop' }] },
    ]), 5, 1);
  }, async (server) => {
    const result = await openai.chat({
      baseUrl: `${server.url}/v1`, model: 'm', messages: [{ role: 'user', content: 'hi' }], gate: testGate(),
    });
    assert.equal(result.content, 'trotzdem richtig');
    assert.equal(result.finishReason, 'stop');
  });
});

test('Ein verstummter Stream ist ein ModelError, kein "kein Modell da"', async () => {
  // The distinction matters: the backend WAS reachable and did answer, so
  // telling the user to install Ollama would send them down the wrong path.
  await withServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Anfang' }, done: false }) + '\n');
    await sleep(2000); // longer than the idle deadline below
  }, async (server) => {
    const deltas = [];
    await assert.rejects(
      ollama.chat({
        baseUrl: server.url, model: 'x', messages: [{ role: 'user', content: 'hi' }],
        gate: testGate(), idleTimeoutMs: 200, onDelta: (t) => deltas.push(t),
      }),
      (err) => {
        assert.equal(err.code, 'MODEL_ERROR');
        assert.match(err.message, /200 ms lang keine weiteren Daten/);
        return true;
      },
    );
    assert.deepEqual(deltas, ['Anfang']);
  });
});

test('OpenAI-Chat macht aus HTTP 500 einen ModelError mit Status und Body-Auszug', async () => {
  await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'context window exceeded', type: 'server_error' } }));
  }, async (server) => {
    await assert.rejects(
      openai.chat({ baseUrl: `${server.url}/v1`, model: 'm', messages: [{ role: 'user', content: 'hi' }], gate: testGate() }),
      (err) => {
        assert.equal(err.code, 'MODEL_ERROR');
        assert.equal(err.details.status, 500);
        assert.match(err.message, /HTTP 500/);
        assert.match(err.message, /context window exceeded/);
        return true;
      },
    );
  });
});

test('OpenAI-Chat macht aus einem Fehler-Frame im Stream einen ModelError', async () => {
  await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ error: { message: 'slot unavailable' } })}\n\n`);
  }, async (server) => {
    await assert.rejects(
      openai.chat({ baseUrl: `${server.url}/v1`, model: 'm', messages: [{ role: 'user', content: 'hi' }], gate: testGate() }),
      (err) => {
        assert.equal(err.code, 'MODEL_ERROR');
        assert.match(err.message, /slot unavailable/);
        return true;
      },
    );
  });
});

test('OpenAI-Chat bricht per AbortSignal mitten im Stream ab', async () => {
  await withServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'erstes' } }] })}\n\n`);
    await sleep(400);
    if (!res.destroyed) {
      try {
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'zweites' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } catch { /* client gone */ }
    }
  }, async (server) => {
    const controller = new AbortController();
    const deltas = [];
    await assert.rejects(
      openai.chat({
        baseUrl: `${server.url}/v1`, model: 'm', messages: [{ role: 'user', content: 'hi' }],
        gate: testGate(), signal: controller.signal,
        onDelta: (t) => { deltas.push(t); controller.abort(); },
      }),
      (err) => err.code === 'ABORTED',
    );
    assert.deepEqual(deltas, ['erstes']);
  });
});

test('OpenAI-Chat wirft NoModelError, wenn nichts lauscht', async () => {
  const url = await closedUrl();
  await assert.rejects(
    openai.chat({ baseUrl: `${url}/v1`, model: 'm', messages: [{ role: 'user', content: 'hi' }], gate: testGate(), timeoutMs: 800 }),
    (err) => err.code === 'NO_MODEL_AVAILABLE',
  );
});

test('OpenAI verlangt eine toolCallId für Werkzeug-Antworten', async () => {
  const gate = testGate();
  await assert.rejects(
    openai.chat({
      baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', gate,
      messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'ergebnis' }],
    }),
    (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.match(err.message, /toolCallId/);
      return true;
    },
  );
  assert.equal(gate.calls.length, 0);
});

test('OpenAI baut einen Werkzeug-Umlauf korrekt in den Verlauf ein', () => {
  const { toOpenAiMessages } = openai.__internals;
  const out = toOpenAiMessages([
    { role: 'user', content: 'Zeit?' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'time.now', arguments: { tz: 'Europe/Berlin' } }] },
    { role: 'tool', toolCallId: 'c1', content: '12:00' },
  ]);
  assert.equal(out[1].content, null, 'neben tool_calls erwartet die API null, nicht ""');
  assert.equal(out[1].tool_calls[0].function.arguments, '{"tz":"Europe/Berlin"}');
  assert.equal(out[2].tool_call_id, 'c1');
});

test('OpenAI-Einbettungen liefern Vektoren in der Reihenfolge der Eingabe', async () => {
  await withServer(async (req, res) => {
    const body = JSON.parse(await readRequest(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      // Deliberately out of order: the provider must sort by `index`.
      data: body.input.map((t, i) => ({ index: i, embedding: [t.length] })).reverse(),
    }));
  }, async (server) => {
    const result = await openai.embed({ baseUrl: `${server.url}/v1`, model: 'e', input: ['abc', 'de'], gate: testGate() });
    assert.deepEqual(result.vectors, [[3], [2]]);
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('Registry: refresh probt parallel, veröffentlicht models.changed und merkt sich den Stand', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TAGS_RESPONSE));
  }, async (server) => {
    const dead = await closedUrl();
    const bus = new Bus();
    const config = baseConfig({
      models: {
        providers: [
          { id: 'ollama', kind: 'ollama', baseUrl: server.url, enabled: true },
          { id: 'llamacpp', kind: 'openai', baseUrl: `${dead}/v1`, enabled: true },
          { id: 'aus', kind: 'ollama', baseUrl: server.url, enabled: false },
        ],
      },
    });
    const registry = createRegistry({ config, gate: testGate(), bus });

    assert.equal(registry.list().at, null);
    assert.equal(registry.list().providers.length, 2, 'abgeschaltete Anbieter werden nicht geprüft');

    const changed = waitForEvent(bus, 'models.changed', 4000);
    const snap = await registry.refresh({ timeoutMs: 800 });
    const evt = await changed;

    assert.equal(snap.providers.length, 2);
    assert.equal(evt.payload.providers.length, 2);
    const byId = Object.fromEntries(snap.providers.map((p) => [p.id, p]));
    assert.equal(byId.ollama.available, true);
    assert.equal(byId.ollama.models.length, 2);
    assert.equal(byId.llamacpp.available, false);
    assert.ok(byId.llamacpp.error);
    assert.ok(snap.at);
    // list() must never probe again.
    assert.equal(registry.list(), snap);
  });
});

test('Registry: gleichzeitige refresh-Aufrufe teilen sich eine Proberunde', async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TAGS_RESPONSE));
  }, async (server) => {
    const config = baseConfig({
      models: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: server.url, enabled: true }] },
    });
    const registry = createRegistry({ config, gate: testGate() });
    const [a, b, c] = await Promise.all([registry.refresh(), registry.refresh(), registry.refresh()]);
    assert.equal(hits, 1, 'drei parallele Aufrufe dürfen nur einmal proben');
    assert.equal(a, b);
    assert.equal(b, c);
  });
});

test('Registry: resolve versteht "anbieter/modell", Objekte und blanke Modellnamen', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TAGS_RESPONSE));
  }, async (server) => {
    const config = baseConfig({
      models: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: server.url, enabled: true }] },
    });
    const registry = createRegistry({ config, gate: testGate() });
    await registry.refresh({ timeoutMs: 800 });

    assert.equal(registry.resolve('ollama/qwen2.5:7b').model, 'qwen2.5:7b');
    assert.equal(registry.resolve({ provider: 'ollama', model: 'qwen2.5:7b' }).model, 'qwen2.5:7b');
    assert.equal(registry.resolve('qwen2.5:7b').providerId, 'ollama');
    // "llama3.2" and "llama3.2:latest" are the same model to Ollama.
    assert.equal(registry.resolve('llama3.2').model, 'llama3.2:latest');
    assert.equal(registry.resolve(null).model, 'llama3.2:latest', 'ohne Angabe das erste verfügbare Modell');
    assert.equal(registry.resolve(null).baseUrl, server.url);
    assert.equal(registry.isOffline(null), true);
  });
});

test('Registry: der konfigurierte Standard gewinnt, ein ausdrücklicher Wunsch wird nie ersetzt', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TAGS_RESPONSE));
  }, async (server) => {
    const config = baseConfig({
      models: {
        providers: [{ id: 'ollama', kind: 'ollama', baseUrl: server.url, enabled: true }],
        default: { provider: 'ollama', model: 'qwen2.5:7b' },
      },
    });
    const registry = createRegistry({ config, gate: testGate() });
    await registry.refresh({ timeoutMs: 800 });
    assert.equal(registry.resolve(null).model, 'qwen2.5:7b');

    // A model that is not there must fail loudly instead of being swapped.
    assert.throws(() => registry.resolve('gibtsnicht:70b'), (err) => {
      assert.equal(err.code, 'NO_MODEL_AVAILABLE');
      assert.match(err.message, /gibtsnicht:70b/);
      return true;
    });

    // A default that vanished falls back rather than bricking the chat.
    config.models.default = { provider: 'ollama', model: 'weg:3b' };
    assert.equal(registry.resolve(null).model, 'llama3.2:latest');
  });
});

test('Registry: resolve nennt einen unbekannten Anbieter beim Namen', async () => {
  const config = baseConfig({
    models: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true }] },
  });
  const registry = createRegistry({ config, gate: testGate() });
  assert.throws(() => registry.resolve({ provider: 'openai-cloud', model: 'gpt-4' }), (err) => {
    assert.equal(err.code, 'NO_MODEL_AVAILABLE');
    assert.match(err.message, /openai-cloud/);
    assert.match(err.message, /Konfiguriert sind: ollama/);
    return true;
  });
});

test('Registry: NoModelError erklärt, was geprüft wurde und wie man Ollama installiert', async () => {
  const dead1 = await closedUrl();
  const dead2 = await closedUrl();
  const config = baseConfig({
    models: {
      providers: [
        { id: 'ollama', kind: 'ollama', baseUrl: dead1, enabled: true },
        { id: 'lmstudio', kind: 'openai', baseUrl: `${dead2}/v1`, enabled: true },
      ],
    },
  });
  const registry = createRegistry({ config, gate: testGate() });
  await registry.refresh({ timeoutMs: 800 });

  try {
    registry.resolve(null);
    assert.fail('resolve() hätte NoModelError werfen müssen');
  } catch (err) {
    assert.equal(err.code, 'NO_MODEL_AVAILABLE');
    assert.equal(err.status, 503);
    const m = err.message;
    // What was probed, at which address, and what came back.
    assert.match(m, /ollama/);
    assert.ok(m.includes(dead1), 'die geprüfte Adresse muss in der Meldung stehen');
    assert.ok(m.includes(`${dead2}/v1`), 'auch die zweite Adresse muss dastehen');
    // How to fix it.
    assert.match(m, /ollama\.com\/download/);
    assert.match(m, /ollama pull llama3\.2/);
    assert.match(m, /ollama pull qwen2\.5:7b/);
    assert.match(m, /llama\.cpp/);
    assert.match(m, /LM Studio/);
    assert.match(m, /erfindet keine Antworten/);
    // Machine-readable detail for the UI.
    assert.equal(err.details.probed.length, 2);
    assert.equal(err.details.probed[0].available, false);
  }
});

test('Registry: ein laufender Ollama ohne Modelle bekommt eine andere Anweisung', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
  }, async (server) => {
    const config = baseConfig({
      models: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: server.url, enabled: true }] },
    });
    const registry = createRegistry({ config, gate: testGate() });
    await registry.refresh({ timeoutMs: 800 });
    assert.throws(() => registry.resolve(null), (err) => {
      assert.match(err.message, /läuft unter/);
      assert.match(err.message, /kein Modell geladen/);
      assert.match(err.message, /ollama pull llama3\.2/);
      return true;
    });
  });
});

test('Registry: ohne Proberunde sagt die Meldung genau das', () => {
  const config = baseConfig({
    models: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true }] },
  });
  const registry = createRegistry({ config, gate: testGate() });
  assert.throws(() => registry.resolve(null), (err) => {
    assert.equal(err.code, 'NO_MODEL_AVAILABLE');
    assert.match(err.message, /noch nicht geprüft/);
    assert.match(err.message, /127\.0\.0\.1:11434/);
    return true;
  });
});

test('Registry: chat geht über die Schleuse, trägt den Scope und meldet die Herkunft', async () => {
  await withServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(TAGS_RESPONSE));
      return;
    }
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    await writeSliced(res, ndjson([
      { message: { role: 'assistant', content: 'Servus' }, done: false },
      { message: { role: 'assistant', content: '!' }, done: true, done_reason: 'stop', prompt_eval_count: 4, eval_count: 2 },
    ]), 6, 1);
  }, async (server) => {
    const gate = testGate();
    const config = baseConfig({
      models: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: server.url, enabled: true }] },
    });
    const registry = createRegistry({ config, gate });
    await registry.refresh({ timeoutMs: 800 });

    const deltas = [];
    const result = await registry.chat('ollama/llama3.2:latest', {
      messages: [{ role: 'user', content: 'Hallo' }],
      scope: 'chat:chat_1',
      onDelta: (t) => deltas.push(t),
    });
    assert.equal(result.content, 'Servus!');
    assert.equal(result.provider, 'ollama');
    assert.equal(result.model, 'llama3.2:latest');
    assert.equal(result.kind, 'ollama');
    assert.equal(deltas.join(''), 'Servus!');

    assert.ok(gate.calls.length >= 2, 'Probe und Chat müssen beide durch die Schleuse');
    assert.ok(gate.calls.every((c) => typeof c.scope === 'string' && c.scope.length > 0));
    assert.ok(gate.calls.every((c) => typeof c.purpose === 'string' && c.purpose.length > 0));
    assert.equal(gate.calls[gate.calls.length - 1].scope, 'chat:chat_1');
  });
});

test('Registry: ein API-Schlüssel landet nie im Schnappschuss', async () => {
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer streng-geheim');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fernmodell' }] }));
  }, async (server) => {
    process.env.NOS_TEST_MODEL_KEY = 'streng-geheim';
    try {
      const config = baseConfig({
        models: {
          providers: [],
          remote: [{ id: 'fern', kind: 'openai', baseUrl: `${server.url}/v1`, apiKeyEnv: 'NOS_TEST_MODEL_KEY', enabled: true }],
        },
      });
      const registry = createRegistry({ config, gate: testGate() });
      const snap = await registry.refresh({ timeoutMs: 800 });
      assert.equal(snap.providers[0].available, true);
      assert.equal(snap.providers[0].hasApiKey, true);
      assert.ok(!JSON.stringify(snap).includes('streng-geheim'), 'der Schlüssel darf nicht im Snapshot stehen');
      // resolve() hands the key to the provider, and only there.
      assert.equal(registry.resolve('fern/fernmodell').apiKey, 'streng-geheim');
      assert.equal(registry.isOffline('fern/fernmodell'), true, 'dieser Testserver läuft auf loopback');
    } finally {
      delete process.env.NOS_TEST_MODEL_KEY;
    }
  });
});

test('Registry: isOffline erkennt einen Modellserver ausserhalb des Geräts', async () => {
  const { isLoopbackHost } = require('../src/models/registry').__internals;
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.1.2.3'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackHost('192.168.1.5'), false);
  assert.equal(isLoopbackHost('api.example.com'), false);

  // A LAN model server is reachable but explicitly NOT offline.
  const config = baseConfig({
    models: { providers: [{ id: 'nas', kind: 'ollama', baseUrl: 'http://192.168.1.5:11434', enabled: true }] },
  });
  const registry = createRegistry({ config, gate: testGate() });
  // Feed a snapshot without touching the network: the probe fails (the gate
  // refuses anything but loopback), which is itself the assertion.
  const snap = await registry.refresh({ timeoutMs: 400 });
  assert.equal(snap.providers[0].available, false);
  assert.match(snap.providers[0].error, /loopback|Blockiert/);
});

test('Registry: unbekannter Anbietertyp wird gemeldet, nicht ignoriert', async () => {
  const config = baseConfig({
    models: { providers: [{ id: 'exotisch', kind: 'telepathie', baseUrl: 'http://127.0.0.1:9', enabled: true }] },
  });
  const registry = createRegistry({ config, gate: testGate() });
  const snap = await registry.refresh({ timeoutMs: 400 });
  assert.equal(snap.providers[0].available, false);
  assert.match(snap.providers[0].error, /Unbekannter Anbietertyp/);
});

test('Registry: leere Anbieterliste führt zu einer klaren Meldung', async () => {
  const registry = createRegistry({ config: baseConfig(), gate: testGate() });
  await registry.refresh({ timeoutMs: 200 });
  assert.throws(() => registry.resolve(null), (err) => {
    assert.match(err.message, /kein Modellanbieter konfiguriert/);
    assert.match(err.message, /ollama\.com\/download/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Integration with the real egress gate
// ---------------------------------------------------------------------------

/** The gate is another subsystem and may not exist yet in a partial checkout. */
function loadGate() {
  try {
    return require('../src/net/gate');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

test('Zusammenspiel mit der echten Schleuse: Probe, echtes Streaming, Abbruch', async () => {
  const gateMod = loadGate();
  if (!gateMod || typeof gateMod.createGate !== 'function') {
    // Reported, not silently swallowed: this check simply cannot run yet.
    console.log('    (übersprungen: src/net/gate.js ist noch nicht vorhanden)');
    return;
  }
  const { tempHome } = require('./harness');
  const { Audit } = require('../src/kernel/log');
  const home = tempHome('models-gate');

  await withServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(TAGS_RESPONSE));
      return;
    }
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    await writeSliced(res, ndjson([
      { message: { role: 'assistant', content: 'Grüße' }, done: false },
      { message: { role: 'assistant', content: ' durch die Schleuse' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 },
    ]), 4, 2);
  }, async (server) => {
    const bus = new Bus();
    const config = baseConfig({
      models: { providers: [{ id: 'ollama', kind: 'ollama', baseUrl: server.url, enabled: true }] },
    });
    // Default config means mode 'offline' -- loopback must still be allowed,
    // which is the whole point of "local AI is not network access".
    const audit = new Audit(`${home.home}/audit.jsonl`, { enabled: false });
    let gate;
    try {
      gate = gateMod.createGate({ config, audit, bus, store: null, logger: require('../src/kernel/log').logger });
    } catch (err) {
      console.log(`    (übersprungen: createGate ließ sich nicht bauen: ${err.message})`);
      return;
    }
    const registry = createRegistry({ config, gate, bus });

    const snap = await registry.refresh({ timeoutMs: 1500 });
    assert.equal(snap.providers[0].available, true, snap.providers[0].error || '');
    assert.equal(snap.providers[0].models.length, 2);

    const stamps = [];
    const started = Date.now();
    const result = await registry.chat(null, {
      messages: [{ role: 'user', content: 'Hallo' }],
      scope: 'chat:integration',
      onDelta: () => stamps.push(Date.now() - started),
    });
    assert.equal(result.content, 'Grüße durch die Schleuse');
    assert.equal(result.stats.completionTokens, 4);
    // Deltas must arrive while the server is still writing, not in one lump at
    // the end -- otherwise the gate buffered the body and nothing streams.
    assert.ok(stamps.length >= 2, `erwartete mehrere Deltas, bekam ${stamps.length}`);
    assert.ok(stamps[stamps.length - 1] > stamps[0], 'die Deltas kamen alle zur selben Zeit an');
    assert.equal(registry.isOffline(null), true);

    const controller = new AbortController();
    await assert.rejects(
      registry.chat(null, {
        messages: [{ role: 'user', content: 'Hallo' }],
        scope: 'chat:integration',
        signal: controller.signal,
        onDelta: () => controller.abort(),
      }),
      (err) => err.code === 'ABORTED',
    );
  }).finally(() => home.cleanup());
});

module.exports = { name: 'models', tests: drain() };
