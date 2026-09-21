'use strict';

/**
 * Tests for the agent subsystem.
 *
 * Two rules hold everywhere in this file:
 *   - no real model is ever contacted. The registry is a fake that replays a
 *     scripted list of answers, so every assertion about the loop is about the
 *     loop and not about whatever a local model happened to say today.
 *   - no test touches the real home directory or the network. Vaults live in
 *     tempHome(), and the one network test talks to a loopback fakeServer.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome, fakeServer } = require('./harness');

const { openStore } = require('../src/store/engine');
const { layout, ensureLayout } = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const { createGate } = require('../src/net/gate');
const { ModelError } = require('../src/kernel/errors');

const permissions = require('../src/agents/permissions');
const { createApprovals } = require('../src/agents/approvals');
const toolsMod = require('../src/agents/tools');
const { createToolbox } = toolsMod;
const { createAgentRuntime, parseTextToolCalls } = require('../src/agents/runtime');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A registry that answers from a script instead of from a model. Every entry
 * is either a string (the assistant's content) or an object with
 * `{content, toolCalls}` for native tool calling.
 */
function fakeRegistry(script, opts = {}) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(ref, options) {
      calls.push({ ref, options });
      if (opts.throwOnTools && options.tools) {
        throw new ModelError('this model does not support tools', { status: 400 });
      }
      if (index >= script.length) {
        // Running past the script is a bug in the test, not a model quirk.
        throw new Error(`fakeRegistry: Skript erschöpft nach ${index} Aufrufen`);
      }
      const entry = script[index++];
      const answer = typeof entry === 'string' ? { content: entry } : entry;
      if (typeof answer.delayMs === 'number') await sleep(answer.delayMs);
      if (options.signal && options.signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        content: answer.content || '',
        toolCalls: answer.toolCalls || [],
        stats: { promptTokens: 1, completionTokens: 1, ms: 1 },
        provider: 'fake',
        model: 'fake-model',
      };
    },
    list() { return { providers: [], at: new Date().toISOString() }; },
    resolve() { return { providerId: 'fake', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'fake-model' }; },
    isOffline() { return true; },
    async refresh() { return { providers: [], at: new Date().toISOString() }; },
  };
}

/** Build a complete, isolated agent environment in a temp home. */
async function makeEnv(overrides = {}) {
  const { home, cleanup } = tempHome('agents');
  const paths = ensureLayout(layout(home));
  const config = configMod.defaults();
  if (overrides.config) {
    for (const [section, patch] of Object.entries(overrides.config)) {
      Object.assign(config[section], patch);
    }
  }
  const bus = new Bus();
  const audit = new Audit(paths.audit).open();
  const store = await openStore({ paths, bus });
  const gate = createGate({ config, audit, bus, store });
  const approvals = createApprovals({ store, bus, config, audit });
  const registry = fakeRegistry(overrides.script || [], overrides.registryOpts);
  const toolbox = createToolbox({ store, registry, gate, paths, approvals, config, audit });
  const runtime = createAgentRuntime({ store, registry, toolbox, approvals, gate, bus, config, paths });

  return {
    home, paths, config, bus, audit, store, gate, approvals, registry, toolbox, runtime,
    createAgent(data = {}) {
      return store.create('agent', {
        name: data.name || 'Testagent',
        description: data.description || '',
        systemPrompt: data.systemPrompt || 'Du bist ein Testagent.',
        permissions: permissions.basePermissions(data.permissions || {}),
        tools: data.tools || [],
      });
    },
    async close() {
      runtime.abortAll();
      approvals.close();
      await store.close();
      audit.close();
      cleanup();
    },
  };
}

/* ------------------------------------------------------------- permissions */

test('eine fehlende Fähigkeit gilt als verweigert', () => {
  const config = configMod.defaults();
  const agent = { id: 'agent_aaaaaaaaaaaaaaaaaaaaaa', type: 'agent', data: { name: 'A', permissions: {} } };
  for (const cap of ['writeNotes', 'writeFiles', 'createEdges', 'runTasks', 'spawnAgents']) {
    assert.equal(permissions.check(agent, cap, { config }).allowed, false, `${cap} darf nicht erlaubt sein`);
  }
  // Truthy-but-not-true values are configuration mistakes, not grants.
  const sloppy = { id: 'agent_bbbbbbbbbbbbbbbbbbbbbb', type: 'agent', data: { name: 'B', permissions: { writeNotes: 1, spawnAgents: 'ja' } } };
  assert.equal(permissions.check(sloppy, 'writeNotes', { config }).allowed, false);
  assert.equal(permissions.check(sloppy, 'spawnAgents', { config }).allowed, false);
  // An unknown capability fails closed instead of falling through.
  assert.equal(permissions.check(agent, 'deleteEverything', { config }).allowed, false);
});

test('globalApprovalOverride erzwingt Bestätigung gegen den Agentenwunsch', () => {
  const agent = { id: 'agent_cccccccccccccccccccccc', type: 'agent', data: { name: 'C', permissions: { writeNotes: true, requireApproval: false } } };
  const relaxed = configMod.defaults();
  assert.equal(permissions.effective(agent, relaxed).requireApproval, false);

  const strict = configMod.defaults();
  strict.security.globalApprovalOverride = true;
  const perms = permissions.effective(agent, strict);
  assert.equal(perms.requireApproval, true);
  assert.equal(permissions.check(agent, 'writeNotes', { config: strict }).requiresApproval, true);
  assert.ok(permissions.describe(agent, strict).includes('global erzwungen'));
});

test('der globale Netzmodus deckelt die Netzstufe des Agenten', () => {
  const agent = { id: 'agent_dddddddddddddddddddddd', type: 'agent', data: { name: 'D', permissions: { network: 'online' } } };
  const offline = configMod.defaults(); // mode: 'offline'
  const perms = permissions.effective(agent, offline);
  assert.equal(perms.network, 'offline');
  assert.equal(perms.requestedNetwork, 'online');
  assert.equal(permissions.check(agent, 'network', { config: offline }).allowed, false);

  const online = configMod.defaults();
  online.network.mode = 'online';
  assert.equal(permissions.effective(agent, online).network, 'online');
  assert.equal(permissions.check(agent, 'network', { config: online, host: 'example.com' }).allowed, true);
});

test('allowedHosts begrenzt den Netzzugang auf gelistete Hosts', () => {
  const agent = {
    id: 'agent_eeeeeeeeeeeeeeeeeeeeee', type: 'agent',
    data: { name: 'E', permissions: { network: 'online', allowedHosts: ['*.wikipedia.org'] } },
  };
  const config = configMod.defaults();
  config.network.mode = 'online';
  assert.equal(permissions.check(agent, 'network', { config, host: 'de.wikipedia.org' }).allowed, true);
  assert.equal(permissions.check(agent, 'network', { config, host: 'evil.example' }).allowed, false);
});

test('canAccessPath verhindert Pfadausbruch, auch über Symlinks', () => {
  const { home, cleanup } = tempHome('paths');
  try {
    const root = path.join(home, 'erlaubt');
    const secret = path.join(home, 'geheim');
    fs.mkdirSync(root);
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
    fs.writeFileSync(path.join(secret, 'passwoerter.txt'), 'geheim');
    fs.symlinkSync(secret, path.join(root, 'abkuerzung'));

    const agent = { id: 'agent_ffffffffffffffffffffff', type: 'agent', data: { name: 'F', permissions: { readFiles: true, fileRoots: [root] } } };
    const config = configMod.defaults();

    assert.equal(permissions.canAccessPath(agent, path.join(root, 'ok.txt'), { config }), true);
    assert.equal(permissions.canAccessPath(agent, path.join(root, 'neu', 'datei.md'), { config }), true, 'noch nicht existierende Pfade im Root sind erlaubt');
    assert.equal(permissions.canAccessPath(agent, path.join(root, '..', 'geheim', 'passwoerter.txt'), { config }), false);
    assert.equal(permissions.canAccessPath(agent, '/etc/passwd', { config }), false);
    // The symlink is the interesting case: a string comparison would allow it.
    assert.equal(permissions.canAccessPath(agent, path.join(root, 'abkuerzung', 'passwoerter.txt'), { config }), false);
    // A sibling directory sharing the root's prefix must not be reachable.
    fs.mkdirSync(`${root}-boese`);
    assert.equal(permissions.canAccessPath(agent, path.join(`${root}-boese`, 'x'), { config }), false);

    const noRoots = { id: 'agent_gggggggggggggggggggggg', type: 'agent', data: { name: 'G', permissions: { readFiles: true } } };
    assert.equal(permissions.canAccessPath(noRoots, path.join(root, 'ok.txt'), { config }), false);
  } finally {
    cleanup();
  }
});

test('describe liefert eine verständliche deutsche Zusammenfassung', () => {
  const config = configMod.defaults();
  const agent = { id: 'agent_hhhhhhhhhhhhhhhhhhhhhh', type: 'agent', data: { name: 'H', permissions: permissions.basePermissions() } };
  const text = permissions.describe(agent, config);
  assert.ok(text.includes('Darf Notizen lesen'), text);
  assert.ok(text.includes('Darf NICHT ins Internet.'), text);
  assert.ok(text.includes('Fragt vor jeder Änderung.'), text);
  assert.ok(text.includes('KEINE anderen Agenten'), text);
});

test('builtinAgents liefert sechs restriktive, gültige Vorlagen', () => {
  const schema = require('../src/store/schema');
  const templates = permissions.builtinAgents();
  assert.equal(templates.length, 6);
  const names = templates.map((t) => t.name);
  assert.equal(new Set(names).size, 6, 'Namen müssen eindeutig sein');
  for (const tpl of templates) {
    const validated = schema.validate('agent', { ...tpl, builtin: true });
    assert.ok(validated.systemPrompt.length > 100, `${tpl.name}: Systemprompt zu dürftig`);
    assert.ok(validated.description.length > 20, `${tpl.name}: Beschreibung zu dürftig`);
    assert.equal(tpl.permissions.network, 'offline', `${tpl.name} darf nicht vorkonfiguriert ins Netz`);
    assert.equal(tpl.permissions.requireApproval, true, `${tpl.name} muss nachfragen`);
    assert.equal(tpl.permissions.spawnAgents, false, `${tpl.name} darf keine Agenten starten`);
    assert.deepEqual(tpl.permissions.fileRoots, [], `${tpl.name} darf keine Ordner vorbelegen`);
  }
});

test('subsetOf verhindert Rechteausweitung durch Unteragenten', () => {
  const config = configMod.defaults();
  const parent = { id: 'agent_iiiiiiiiiiiiiiiiiiiiii', type: 'agent', data: { name: 'P', permissions: { readNotes: true, spawnAgents: true } } };
  const harmless = { id: 'agent_jjjjjjjjjjjjjjjjjjjjjj', type: 'agent', data: { name: 'K1', permissions: { readNotes: true } } };
  const greedy = { id: 'agent_kkkkkkkkkkkkkkkkkkkkkk', type: 'agent', data: { name: 'K2', permissions: { readNotes: true, writeNotes: true } } };
  assert.equal(permissions.subsetOf(harmless, parent, config).ok, true);
  const verdict = permissions.subsetOf(greedy, parent, config);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['writeNotes']);
});

/* --------------------------------------------------------------- approvals */

test('eine bestätigte Anfrage läuft weiter, eine abgelehnte wirft', async () => {
  const env = await makeEnv();
  try {
    const events = [];
    env.bus.subscribe((e) => { if (e.name.startsWith('approval.')) events.push(e); });

    const okPromise = env.approvals.request({ kind: 'tool', summary: 'Notiz anlegen', runId: 'run_x' });
    await sleep(5);
    const [pending] = env.approvals.listPending();
    assert.ok(pending, 'Anfrage muss als Datensatz existieren, bevor gewartet wird');
    env.approvals.resolve(pending.id, 'approved');
    assert.equal(await okPromise, true);
    assert.equal(env.store.get(pending.id).data.status, 'approved');

    const denied = env.approvals.request({ kind: 'tool', summary: 'Datei schreiben' });
    await sleep(5);
    const next = env.approvals.listPending()[0];
    env.approvals.resolve(next.id, 'denied');
    await assert.rejects(denied, (err) => {
      assert.equal(err.code, 'APPROVAL_DENIED');
      return true;
    });
    assert.equal(env.store.get(next.id).data.status, 'denied');
    assert.ok(events.some((e) => e.name === 'approval.requested'));
    assert.ok(events.some((e) => e.name === 'approval.resolved'));
  } finally {
    await env.close();
  }
});

test('eine unbeantwortete Anfrage läuft ab und gilt als abgelehnt', async () => {
  const env = await makeEnv();
  try {
    const promise = env.approvals.request({ kind: 'tool', summary: 'Zu spät', timeoutMs: 40 });
    await assert.rejects(promise, (err) => {
      assert.equal(err.code, 'APPROVAL_DENIED');
      assert.equal(err.details.status, 'expired');
      return true;
    });
    const record = env.store.get(err0(env));
    assert.equal(record.data.status, 'expired');
    assert.ok(record.data.decidedAt);
  } finally {
    await env.close();
  }
  function err0(env) {
    return env.store.all('approval')[0].id;
  }
});

test('nach einem Neustart bleibt keine Bestätigung ewig "pending"', async () => {
  const { home, cleanup } = tempHome('restart');
  try {
    const paths = ensureLayout(layout(home));
    const config = configMod.defaults();

    // First process: a request is written and then the process "dies".
    let store = await openStore({ paths, bus: new Bus() });
    const first = createApprovals({ store, bus: new Bus(), config });
    first.request({ kind: 'tool', summary: 'Überlebt den Neustart nicht', timeoutMs: 600000 }).catch(() => {});
    await sleep(5);
    assert.equal(first.listPending().length, 1);
    const id = first.listPending()[0].id;
    await store.close();

    // Second process: the same vault, a fresh approvals instance.
    store = await openStore({ paths, bus: new Bus() });
    const second = createApprovals({ store, bus: new Bus(), config });
    assert.deepEqual(second.listPending(), [], 'verwaiste Anfragen müssen abgeräumt sein');
    assert.equal(store.get(id).data.status, 'expired');
    await store.close();
  } finally {
    cleanup();
  }
});

test('abortAll bricht wartende Bestätigungen eines Laufs ab', async () => {
  const env = await makeEnv();
  try {
    const promise = env.approvals.request({ kind: 'tool', summary: 'Wird abgebrochen', runId: 'run_abc', timeoutMs: 60000 });
    await sleep(5);
    assert.equal(env.approvals.abortAll('run_abc'), 1);
    await assert.rejects(promise, (err) => {
      assert.equal(err.code, 'ABORTED');
      return true;
    });
  } finally {
    await env.close();
  }
});

/* ------------------------------------------------------------------- tools */

test('list(agent) zeigt nur Werkzeuge, die die Berechtigungen decken', async () => {
  const env = await makeEnv();
  try {
    const readOnly = env.createAgent({ permissions: { readNotes: true } });
    const names = env.toolbox.list(readOnly).map((t) => t.name);
    assert.ok(names.includes('notes.search'));
    assert.ok(names.includes('notes.read'));
    assert.ok(names.includes('math.eval'), 'Werkzeuge ohne Fähigkeit stehen immer bereit');
    assert.ok(names.includes('time.now'));
    for (const forbidden of ['notes.create', 'notes.update', 'files.read', 'files.write', 'web.fetch', 'agents.spawn', 'graph.link', 'tasks.create']) {
      assert.ok(!names.includes(forbidden), `${forbidden} darf nicht angeboten werden`);
    }
    // Every advertised tool carries a usable JSON schema.
    for (const tool of env.toolbox.list(readOnly)) {
      assert.equal(tool.parameters.type, 'object');
      assert.ok(tool.description.length > 10, `${tool.name} ohne Beschreibung`);
    }

    // An explicit tools allowlist narrows further, never widens.
    const narrowed = env.createAgent({ permissions: { readNotes: true }, tools: ['notes.read'] });
    assert.deepEqual(env.toolbox.list(narrowed).map((t) => t.name), ['notes.read']);
  } finally {
    await env.close();
  }
});

test('ein Werkzeugaufruf ohne Berechtigung wirft PermissionError', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    await assert.rejects(
      env.toolbox.call('notes.create', { title: 'Heimlich' }, { agent }),
      (err) => {
        assert.equal(err.code, 'PERMISSION_DENIED');
        assert.match(err.message, /writeNotes|nicht erlaubt/);
        return true;
      },
    );
    assert.equal(env.store.count('note'), 0, 'es darf nichts geschrieben worden sein');
    // Even a tool the agent is not allowed to see is refused when called directly.
    await assert.rejects(env.toolbox.call('files.read', { path: '/etc/passwd' }, { agent }), /PERMISSION|Pfad|erlaubt/);
  } finally {
    await env.close();
  }
});

test('requireApproval wartet und bricht bei Ablehnung ab', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, writeNotes: true, requireApproval: true } });

    // denied
    const denied = env.toolbox.call('notes.create', { title: 'Nicht erwünscht' }, { agent });
    await sleep(10);
    const pending = env.approvals.listPending();
    assert.equal(pending.length, 1);
    assert.match(pending[0].data.summary, /Neue Notiz anlegen/);
    assert.equal(pending[0].data.payload.tool, 'notes.create');
    env.approvals.resolve(pending[0].id, 'denied');
    await assert.rejects(denied, (err) => {
      assert.equal(err.code, 'APPROVAL_DENIED');
      return true;
    });
    assert.equal(env.store.count('note'), 0, 'die Ablehnung muss die Ausführung verhindern');

    // approved
    const approved = env.toolbox.call('notes.create', { title: 'Erwünscht', body: 'Text' }, { agent });
    await sleep(10);
    env.approvals.resolve(env.approvals.listPending()[0].id, 'approved');
    const result = await approved;
    assert.equal(result.ok, true);
    assert.equal(env.store.get(result.result.id).data.title, 'Erwünscht');
    assert.equal(env.store.get(result.result.id).data.source, 'agent');
  } finally {
    await env.close();
  }
});

test('globalApprovalOverride erzwingt die Rückfrage auch ohne Agentenwunsch', async () => {
  const env = await makeEnv({ config: { security: { globalApprovalOverride: true } } });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, writeNotes: true, requireApproval: false } });
    const promise = env.toolbox.call('notes.create', { title: 'Trotzdem fragen' }, { agent });
    await sleep(10);
    assert.equal(env.approvals.listPending().length, 1, 'die globale Einstellung muss greifen');
    env.approvals.resolve(env.approvals.listPending()[0].id, 'approved');
    await promise;
  } finally {
    await env.close();
  }
});

test('ohne Bestätigungspflicht läuft ein Werkzeug sofort durch', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, writeNotes: true, requireApproval: false } });
    const { result } = await env.toolbox.call('notes.create', { title: 'Direkt', tags: ['a'] }, { agent });
    assert.ok(result.id.startsWith('note_'));
    assert.equal(env.approvals.listPending().length, 0);
  } finally {
    await env.close();
  }
});

test('files.* bleibt in den freigegebenen Ordnern', async () => {
  const env = await makeEnv();
  try {
    const root = path.join(env.home, 'projekt');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'liesmich.txt'), 'Hallo Welt');
    fs.writeFileSync(path.join(env.home, 'privat.txt'), 'geheim');

    const agent = env.createAgent({
      permissions: { readFiles: true, writeFiles: true, requireApproval: false, fileRoots: [root] },
    });

    const listed = await env.toolbox.call('files.list', { path: '.' }, { agent });
    assert.deepEqual(listed.result.entries.map((e) => e.name), ['liesmich.txt']);

    const read = await env.toolbox.call('files.read', { path: 'liesmich.txt' }, { agent });
    assert.equal(read.result.text, 'Hallo Welt');

    for (const escape of ['../privat.txt', path.join(env.home, 'privat.txt'), '/etc/passwd']) {
      await assert.rejects(
        env.toolbox.call('files.read', { path: escape }, { agent }),
        (err) => {
          assert.equal(err.code, 'PERMISSION_DENIED');
          return true;
        },
        `Pfadausbruch über ${escape} muss scheitern`,
      );
    }

    await env.toolbox.call('files.write', { path: 'neu/notiz.md', content: '# Titel' }, { agent });
    assert.equal(fs.readFileSync(path.join(root, 'neu', 'notiz.md'), 'utf8'), '# Titel');
    await assert.rejects(env.toolbox.call('files.write', { path: 'neu/notiz.md', content: 'x' }, { agent }), /existiert bereits/);
    await assert.rejects(
      env.toolbox.call('files.write', { path: '../ausbruch.txt', content: 'x' }, { agent }),
      (err) => { assert.equal(err.code, 'PERMISSION_DENIED'); return true; },
    );
    assert.equal(fs.existsSync(path.join(env.home, 'ausbruch.txt')), false);
  } finally {
    await env.close();
  }
});

test('math.eval rechnet richtig und lehnt Unsinn ab', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent();
    const cases = [
      ['1 + 2 * 3', 7],
      ['(12 + 8) * 3 / 4', 15],
      ['2 ^ 3 ^ 2', 512],
      ['-2 ^ 2', -4],
      ['10 % 3', 1],
      ['sqrt(144)', 12],
      ['max(3, 17, 9)', 17],
      ['round(2.5) + floor(2.9) + ceil(2.1)', 8],
      ['pow(2, 10)', 1024],
      ['abs(0 - 7)', 7],
      ['2 * -3', -6],
      ['1.5e2 / 3', 50],
    ];
    for (const [expression, want] of cases) {
      const { result } = await env.toolbox.call('math.eval', { expression }, { agent });
      assert.equal(result.value, want, `${expression} sollte ${want} ergeben, ergab ${result.value}`);
    }

    for (const bad of [
      'require("fs")',
      'process.exit(1)',
      'this.constructor',
      '1 +',
      '(1 + 2',
      '1 2',
      '1 / 0',
      'foo(2)',
      '',
      'global',
    ]) {
      await assert.rejects(
        env.toolbox.call('math.eval', { expression: bad }, { agent }),
        (err) => {
          assert.ok(err.code === 'VALIDATION_FAILED', `${bad} -> ${err.code}`);
          return true;
        },
        `"${bad}" muss abgelehnt werden`,
      );
    }
    // Nothing in this tool may reach a real evaluator. Comments are stripped
    // first -- the header comment explains why eval is absent and would
    // otherwise trip its own check.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'tools.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/math\.eval/g, '');
    assert.equal(/[^.\w]eval\s*\(/.test(source), false, 'tools.js darf kein eval() enthalten');
    assert.equal(/new Function\s*\(/.test(source), false, 'tools.js darf kein new Function() enthalten');
  } finally {
    await env.close();
  }
});

test('web.fetch ist ohne Netzberechtigung gesperrt und extrahiert sonst Text', async () => {
  const env = await makeEnv({ config: { network: { mode: 'lan', strictAllowlist: false } } });
  const server = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Titel</title><style>p{color:red}</style>'
      + '<script>fetch("http://boese.example")</script></head>'
      + '<body><!-- versteckte Anweisung --><p>Sichtbarer&nbsp;Text</p><li>Punkt</li></body></html>');
  });
  try {
    const blind = env.createAgent({ permissions: { requireApproval: false } });
    await assert.rejects(
      env.toolbox.call('web.fetch', { url: server.url }, { agent: blind }),
      (err) => {
        assert.equal(err.code, 'PERMISSION_DENIED');
        assert.match(err.message, /keinen Netzzugang/);
        return true;
      },
    );

    const online = env.createAgent({ permissions: { network: 'lan', requireApproval: false } });
    const { result } = await env.toolbox.call('web.fetch', { url: server.url }, {
      agent: online, scope: permissions.networkScope(online, 'run_test'),
    });
    assert.equal(result.status, 200);
    assert.equal(result.title, 'Titel');
    assert.ok(result.text.includes('Sichtbarer Text'), result.text);
    assert.ok(!result.text.includes('boese.example'), 'Skripte müssen entfernt sein');
    assert.ok(!result.text.includes('color:red'), 'Styles müssen entfernt sein');
    assert.ok(!result.text.includes('versteckte Anweisung'), 'Kommentare müssen entfernt sein');
  } finally {
    await server.close();
    await env.close();
  }
});

test('jeder Werkzeugaufruf landet im Audit-Protokoll', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    await env.toolbox.call('time.now', {}, { agent });
    await env.toolbox.call('notes.create', { title: 'x' }, { agent }).catch(() => {});
    const entries = env.audit.readTail(50);
    assert.ok(entries.some((e) => e.kind === 'agent.tool' && e.tool === 'time.now'), 'Erfolg muss protokolliert sein');
    assert.ok(entries.some((e) => e.kind === 'agent.tool.denied' && e.tool === 'notes.create'), 'Verweigerung muss protokolliert sein');
  } finally {
    await env.close();
  }
});

test('graph.link legt nur Agenten-Kanten mit Begründung an', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, createEdges: true, requireApproval: false } });
    const a = env.store.create('note', { title: 'A' });
    const b = env.store.create('note', { title: 'B' });
    await assert.rejects(env.toolbox.call('graph.link', { from: a.id, to: b.id }, { agent }), /reason/);
    const { result } = await env.toolbox.call('graph.link', { from: a.id, to: b.id, reason: 'Beide über Kaffee' }, { agent });
    const edge = env.store.get(result.id);
    assert.equal(edge.data.source, 'agent');
    assert.equal(edge.data.reason, 'Beide über Kaffee');
    await assert.rejects(env.toolbox.call('graph.link', { from: a.id, to: 'note_zzzzzzzzzzzzzzzzzzzzzz', reason: 'x' }, { agent }), /NOT_FOUND|not found/);
  } finally {
    await env.close();
  }
});

/* ----------------------------------------------------------------- runtime */

test('der Systemprompt sagt dem Modell die Wahrheit über sein Netz', async () => {
  const env = await makeEnv({ script: ['Fertig.'] });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Sag Hallo' });
    await env.runtime.wait(run.id);
    const system = env.registry.calls[0].options.messages[0];
    assert.equal(system.role, 'system');
    assert.ok(system.content.includes('KEINEN Internetzugang'), system.content.slice(0, 400));
    assert.ok(system.content.includes('Erfinde'), 'der Prompt muss das Erfinden ausdrücklich verbieten');
    assert.ok(system.content.includes('<tool name='), 'das Textprotokoll muss dokumentiert sein');
    assert.ok(system.content.includes('Du bist ein Testagent.'), 'der eigene Prompt des Agenten muss enthalten sein');
  } finally {
    await env.close();
  }
});

test('ein Lauf führt Werkzeuge über das Textprotokoll aus und endet mit einer Antwort', async () => {
  const env = await makeEnv({
    script: [
      'Ich sehe nach.\n<tool name="notes.search">{"query": "Kaffee"}</tool>',
      'In deinen Notizen steht genau eine Sache zu Kaffee.',
    ],
  });
  try {
    env.store.create('note', { title: 'Kaffee', body: 'Immer mit Wasser.' });
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Was weiß ich über Kaffee?' });
    const finished = await env.runtime.wait(run.id);

    assert.equal(finished.data.status, 'done');
    assert.equal(finished.data.stopReason, 'final');
    assert.equal(finished.data.result, 'In deinen Notizen steht genau eine Sache zu Kaffee.');
    assert.equal(finished.data.usedNetwork, false, 'ein lokales Modell ist kein Netzzugriff');

    const kinds = finished.data.steps.map((s) => s.kind);
    assert.deepEqual(kinds, ['model', 'tool', 'model']);
    const toolStep = finished.data.steps[1];
    assert.equal(toolStep.tool, 'notes.search');
    assert.equal(toolStep.ok, true);

    // The tool result must have been fed back before the second model call.
    const secondCall = env.registry.calls[1].options.messages;
    assert.ok(secondCall.some((m) => typeof m.content === 'string' && m.content.includes('[Ergebnis von notes.search]')));
    assert.ok(secondCall.some((m) => typeof m.content === 'string' && m.content.includes('Immer mit Wasser')));
  } finally {
    await env.close();
  }
});

test('natives Tool-Calling wird genutzt und bei Ablehnung auf Text umgestellt', async () => {
  // Native path.
  const native = await makeEnv({
    script: [
      { content: '', toolCalls: [{ id: 'call_1', name: 'math.eval', arguments: { expression: '6*7' } }] },
      'Das Ergebnis ist 42.',
    ],
  });
  try {
    const agent = native.createAgent({ permissions: { readNotes: true } });
    const run = await native.runtime.start({ agentId: agent.id, goal: 'Rechne 6*7' });
    const finished = await native.runtime.wait(run.id);
    assert.equal(finished.data.result, 'Das Ergebnis ist 42.');
    const toolMessage = native.registry.calls[1].options.messages.find((m) => m.role === 'tool');
    assert.ok(toolMessage, 'im nativen Modus muss die Rolle "tool" benutzt werden');
    assert.ok(toolMessage.content.includes('42'));
    assert.ok(Array.isArray(native.registry.calls[0].options.tools), 'Werkzeuge müssen nativ angeboten werden');
  } finally {
    await native.close();
  }

  // The backend refuses tool schemas: the run must continue, not fail.
  const fallback = await makeEnv({
    script: ['Ich rechne.\n<tool name="math.eval">{"expression": "2+2"}</tool>', 'Vier.'],
    registryOpts: { throwOnTools: true },
  });
  try {
    const agent = fallback.createAgent({ permissions: { readNotes: true } });
    const run = await fallback.runtime.start({ agentId: agent.id, goal: 'Rechne 2+2' });
    const finished = await fallback.runtime.wait(run.id);
    assert.equal(finished.data.status, 'done');
    assert.equal(finished.data.result, 'Vier.');
    assert.ok(finished.data.steps.some((s) => s.kind === 'note' && /Textprotokoll/.test(s.note)));
    assert.equal(fallback.registry.calls[1].options.tools, undefined, 'nach der Umstellung ohne Werkzeuge');
  } finally {
    await fallback.close();
  }
});

test('maxSteps wird eingehalten', async () => {
  const script = [];
  for (let i = 0; i < 20; i++) script.push(`Weiter.\n<tool name="time.now">{}</tool>`);
  const env = await makeEnv({ script });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, maxSteps: 3 } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Laufe ewig' });
    const finished = await env.runtime.wait(run.id);
    assert.equal(finished.data.stopReason, 'max-steps');
    assert.equal(env.registry.calls.length, 3, 'das Modell darf genau dreimal gefragt werden');
    assert.equal(finished.data.steps.filter((s) => s.kind === 'model').length, 3);
    assert.match(finished.data.result, /Schrittlimit/);
  } finally {
    await env.close();
  }
});

test('eine Endlosschleife derselben Aufrufe wird erkannt', async () => {
  const script = [];
  for (let i = 0; i < 12; i++) script.push('<tool name="math.eval">{"expression": "1+1"}</tool>');
  const env = await makeEnv({ script });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, maxSteps: 12 } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Wiederhole dich' });
    const finished = await env.runtime.wait(run.id);
    assert.equal(finished.data.stopReason, 'loop');
    assert.ok(env.registry.calls.length < 12, 'die Schleife muss vor dem Schrittlimit enden');
  } finally {
    await env.close();
  }
});

test('ein Lauf lässt sich abbrechen', async () => {
  const env = await makeEnv({
    script: [
      { content: 'Moment.\n<tool name="time.now">{}</tool>', delayMs: 5 },
      { content: 'Noch ein Moment.', delayMs: 300 },
      'Zu spät.',
    ],
  });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Dauert lange' });
    await sleep(40);
    assert.equal(env.runtime.listActive().length, 1);
    assert.equal(env.runtime.abort(run.id), true);
    const finished = await env.runtime.wait(run.id);
    assert.equal(finished.data.status, 'aborted');
    assert.equal(env.runtime.listActive().length, 0);
    assert.equal(env.runtime.abort(run.id), false, 'ein beendeter Lauf lässt sich nicht erneut abbrechen');
  } finally {
    await env.close();
  }
});

test('ein abgebrochener Lauf beendet auch die wartende Bestätigung', async () => {
  const env = await makeEnv({
    script: ['<tool name="notes.create">{"title": "Braucht Bestätigung"}</tool>', 'Ohne die Notiz weiter.'],
  });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, writeNotes: true, requireApproval: true } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Lege etwas an' });
    await sleep(40);
    assert.equal(env.approvals.listPending().length, 1);
    env.runtime.abort(run.id);
    const finished = await env.runtime.wait(run.id);
    assert.equal(finished.data.status, 'aborted');
    assert.equal(env.approvals.listPending().length, 0, 'keine verwaiste Bestätigung');
    assert.equal(env.store.count('note'), 0);
  } finally {
    await env.close();
  }
});

test('eine abgelehnte Bestätigung beendet nicht den Lauf, sondern den Werkzeugaufruf', async () => {
  const env = await makeEnv({
    script: ['<tool name="notes.create">{"title": "Bitte nicht"}</tool>', 'Verstanden, ich lasse es.'],
  });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, writeNotes: true, requireApproval: true } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Lege etwas an' });
    await sleep(40);
    const pending = env.approvals.listPending();
    assert.equal(pending.length, 1);
    env.approvals.resolve(pending[0].id, 'denied');
    const finished = await env.runtime.wait(run.id);
    assert.equal(finished.data.status, 'done');
    assert.equal(finished.data.result, 'Verstanden, ich lasse es.');
    assert.equal(env.store.count('note'), 0);
    const toolStep = finished.data.steps.find((s) => s.kind === 'tool');
    assert.equal(toolStep.ok, false);
    assert.equal(toolStep.error.fehler, 'APPROVAL_DENIED');
  } finally {
    await env.close();
  }
});

test('jeder Schritt steht im Lauf-Datensatz und in runs/<id>.jsonl', async () => {
  const env = await makeEnv({
    script: ['<tool name="math.eval">{"expression": "8/2"}</tool>', 'Vier.'],
  });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Rechne' });
    const finished = await env.runtime.wait(run.id);

    const file = path.join(env.paths.runs, `${run.id}.jsonl`);
    assert.ok(fs.existsSync(file), 'das Protokoll muss auf der Platte liegen');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const kinds = lines.map((l) => l.kind);
    assert.ok(kinds.includes('run.started'));
    assert.ok(kinds.includes('step.model'));
    assert.ok(kinds.includes('step.tool'));
    assert.ok(kinds.includes('run.finished'));
    assert.equal(lines.every((l) => typeof l.at === 'string'), true);

    assert.equal(finished.data.steps.length, 3);
    assert.deepEqual(env.runtime.transcript(run.id).map((l) => l.kind), kinds);
  } finally {
    await env.close();
  }
});

test('usedNetwork berichtet, was die Schleuse wirklich zugelassen hat', async () => {
  const server = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><p>Inhalt aus dem Netz</p></body></html>');
  });
  // 'lan' plus a loopback server: the gate classifies 127.0.0.1 as loopback,
  // so a run that only talks to it must still report usedNetwork = false.
  const local = await makeEnv({
    config: { network: { mode: 'lan', strictAllowlist: false } },
    script: [`<tool name="web.fetch">{"url": "${server.url}"}</tool>`, 'Gelesen.'],
  });
  try {
    const agent = local.createAgent({ permissions: { readNotes: true, network: 'lan', requireApproval: false } });
    const run = await local.runtime.start({ agentId: agent.id, goal: 'Hol die Seite' });
    const finished = await local.runtime.wait(run.id);
    assert.equal(finished.data.status, 'done');
    const toolStep = finished.data.steps.find((s) => s.kind === 'tool');
    assert.equal(toolStep.ok, true, JSON.stringify(toolStep.error));
    assert.equal(finished.data.usedNetwork, false, 'Loopback ist kein Netzzugriff');
    assert.deepEqual(finished.data.networkTargets, []);
    assert.equal(finished.data.usedNetworkSource, 'gate.events');
  } finally {
    await server.close();
    await local.close();
  }
});

test('usedNetwork wird wahr, sobald die Schleuse einen echten Host freigibt', async () => {
  const env = await makeEnv({ config: { network: { mode: 'lan', strictAllowlist: false } }, script: ['Fertig.'] });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, network: 'lan' } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Irgendwas' });
    // Simulate what the gate publishes when it really permits a LAN host
    // during this run. No connection is attempted; the event IS the decision.
    env.bus.publish('network.attempt', {
      host: '192.168.1.50', ip: '192.168.1.50', port: 8080,
      scope: permissions.networkScope(agent, run.id),
      classification: 'private', allowed: true, level: 'lan', reason: 'Testfall',
    });
    const finished = await env.runtime.wait(run.id);
    assert.equal(finished.data.usedNetwork, true);
    assert.deepEqual(finished.data.networkTargets, ['192.168.1.50']);
  } finally {
    await env.close();
  }
});

test('ein Lauf ohne Modell erfindet nichts, sondern schlägt fehl', async () => {
  const env = await makeEnv();
  try {
    const { createAgentRuntime: make } = require('../src/agents/runtime');
    const runtime = make({
      store: env.store, registry: null, toolbox: env.toolbox,
      approvals: env.approvals, gate: env.gate, bus: env.bus, config: env.config, paths: env.paths,
    });
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const run = await runtime.start({ agentId: agent.id, goal: 'Antworte' });
    const finished = await runtime.wait(run.id);
    assert.equal(finished.data.status, 'failed');
    assert.equal(finished.data.error.code, 'NO_MODEL_AVAILABLE');
    assert.equal(finished.data.result, '', 'es darf kein erfundener Text im Ergebnis stehen');
  } finally {
    await env.close();
  }
});

test('produzierte Datensätze landen in producedIds', async () => {
  const env = await makeEnv({
    script: ['<tool name="notes.create">{"title": "Vom Agenten", "body": "Inhalt"}</tool>', 'Angelegt.'],
  });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, writeNotes: true, requireApproval: false } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Lege eine Notiz an' });
    const finished = await env.runtime.wait(run.id);
    assert.equal(finished.data.producedIds.length, 1);
    assert.equal(env.store.get(finished.data.producedIds[0]).data.title, 'Vom Agenten');
  } finally {
    await env.close();
  }
});

test('gleichzeitige Läufe sind begrenzt', async () => {
  const env = await makeEnv({
    config: { agents: { maxConcurrentRuns: 1 } },
    script: [{ content: 'Fertig.', delayMs: 120 }],
  });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const first = await env.runtime.start({ agentId: agent.id, goal: 'Eins' });
    await assert.rejects(env.runtime.start({ agentId: agent.id, goal: 'Zwei' }), (err) => {
      assert.equal(err.code, 'RUN_LIMIT_REACHED');
      assert.equal(err.status, 429);
      return true;
    });
    env.runtime.abort(first.id);
    await env.runtime.wait(first.id);
  } finally {
    await env.close();
  }
});

test('das Textprotokoll wird robust geparst', () => {
  const multi = parseTextToolCalls('Erst denke ich.\n<tool name="notes.read">{"id":"note_1"}</tool>\n'
    + 'Dann noch eins.\n<tool name=\'math.eval\'>{"expression":"1+1"}</tool>\nEnde.');
  assert.equal(multi.calls.length, 2);
  assert.deepEqual(multi.calls.map((c) => c.name), ['notes.read', 'math.eval']);
  assert.ok(multi.prose.includes('Erst denke ich.'));
  assert.ok(!multi.prose.includes('<tool'));

  const empty = parseTextToolCalls('<tool name="time.now"></tool>');
  assert.deepEqual(empty.calls[0].arguments, {});

  const broken = parseTextToolCalls('<tool name="notes.read">{kaputt}</tool>');
  assert.ok(broken.calls[0].argumentsError, 'kaputtes JSON muss als Fehler markiert werden');

  assert.deepEqual(parseTextToolCalls('Reiner Text').calls, []);
  assert.deepEqual(parseTextToolCalls(null).calls, []);
});

test('ein unvollständiger Werkzeugaufruf bekommt einen Syntaxhinweis', async () => {
  const env = await makeEnv({
    script: ['<tool name="time.now">{}', 'Ich lasse es und antworte direkt.'],
  });
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const run = await env.runtime.start({ agentId: agent.id, goal: 'Wie spät?' });
    const finished = await env.runtime.wait(run.id);
    assert.equal(finished.data.result, 'Ich lasse es und antworte direkt.');
    assert.ok(finished.data.steps.some((s) => s.kind === 'note' && /Syntaxhinweis/.test(s.note)));
  } finally {
    await env.close();
  }
});

test('agents.spawn verweigert einen Unteragenten mit mehr Rechten', async () => {
  const env = await makeEnv();
  try {
    const parent = env.createAgent({ name: 'Eltern', permissions: { readNotes: true, spawnAgents: true, requireApproval: false } });
    const greedy = env.createAgent({ name: 'Gierig', permissions: { readNotes: true, writeNotes: true } });
    await assert.rejects(
      env.toolbox.call('agents.spawn', { agentId: greedy.id, goal: 'Schreib was' }, { agent: parent, depth: 0 }),
      (err) => {
        assert.equal(err.code, 'PERMISSION_DENIED');
        assert.match(err.message, /mehr Rechte/);
        return true;
      },
    );
    assert.equal(env.store.count('run'), 0);
  } finally {
    await env.close();
  }
});

test('agents.spawn startet einen zulässigen Unteragenten', async () => {
  const env = await makeEnv({ script: ['Unteragent fertig.'] });
  try {
    const parent = env.createAgent({ name: 'Eltern', permissions: { readNotes: true, spawnAgents: true, requireApproval: false } });
    const child = env.createAgent({ name: 'Kind', permissions: { readNotes: true } });
    const { result } = await env.toolbox.call('agents.spawn', { agentId: child.id, goal: 'Schau nach' }, { agent: parent, depth: 0 });
    assert.ok(result.runId.startsWith('run_'));
    const finished = await env.runtime.wait(result.runId);
    assert.equal(finished.data.agentId, child.id);
    assert.equal(finished.data.depth, 1);
    assert.equal(finished.data.status, 'done');

    // A sub-agent may not spawn further sub-agents.
    await assert.rejects(
      env.toolbox.call('agents.spawn', { agentId: child.id, goal: 'noch tiefer' }, { agent: parent, depth: 2 }),
      /Verschachtelungstiefe/,
    );
    await assert.rejects(
      env.toolbox.call('agents.spawn', { agentId: parent.id, goal: 'ich selbst' }, { agent: parent, depth: 0 }),
      /selbst starten/,
    );
  } finally {
    await env.close();
  }
});

test('notes, tasks und memory arbeiten auf echten Datensätzen', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({
      permissions: { readNotes: true, writeNotes: true, runTasks: true, requireApproval: false },
    });
    const ctx = { agent };

    const created = await env.toolbox.call('notes.create', { title: 'Espresso', body: 'Neun bar.', tags: ['kaffee'] }, ctx);
    const read = await env.toolbox.call('notes.read', { id: created.result.id }, ctx);
    assert.equal(read.result.body, 'Neun bar.');
    assert.deepEqual(read.result.tags, ['kaffee']);

    await env.toolbox.call('notes.update', { id: created.result.id, body: 'Und 93 Grad.', append: true }, ctx);
    assert.match(env.store.get(created.result.id).data.body, /Neun bar\.\n\nUnd 93 Grad\./);
    await assert.rejects(env.toolbox.call('notes.update', { id: created.result.id }, ctx), /mindestens ein/);
    await assert.rejects(env.toolbox.call('notes.read', { id: 'note_qqqqqqqqqqqqqqqqqqqqqq' }, ctx), /NOT_FOUND|not found/);

    const found = await env.toolbox.call('notes.search', { query: 'Espresso' }, ctx);
    assert.ok(found.result.hits.some((h) => h.id === created.result.id), JSON.stringify(found.result));

    const project = env.store.create('project', { name: 'Küche' });
    const task = await env.toolbox.call('tasks.create', { title: 'Mühle entkalken', projectId: project.id, priority: 1 }, ctx);
    assert.equal(env.store.get(task.result.id).data.projectId, project.id);
    await env.toolbox.call('tasks.update', { id: task.result.id, status: 'done' }, ctx);
    assert.equal(env.store.get(task.result.id).data.status, 'done');
    await assert.rejects(env.toolbox.call('tasks.update', { id: task.result.id, status: 'erfunden' }, ctx), /muss einer von/);

    await env.toolbox.call('memory.remember', { text: 'Der Nutzer mag hellere Röstung.', importance: 2 }, ctx);
    const recalled = await env.toolbox.call('memory.recall', { query: 'Röstung' }, ctx);
    assert.equal(recalled.result.count, 1);
    assert.match(recalled.result.items[0].text, /hellere/);
    // Another agent's private memory stays private.
    const other = env.createAgent({ name: 'Anderer', permissions: { readNotes: true } });
    const foreign = await env.toolbox.call('memory.recall', { query: 'Röstung' }, { agent: other });
    assert.equal(foreign.result.count, 0);
  } finally {
    await env.close();
  }
});

/**
 * The read side of the vault.
 *
 * These seven tools exist because an agent that can create a task but not list
 * one cannot answer "Was ist noch offen?" -- the single most useful question a
 * personal assistant gets. What is asserted here is that they read the REAL
 * store and return real counts, and that the filters actually filter: an
 * assistant that quietly drops a due task is worse than one that has no list.
 */
test('tasks.list, projects.list und tags.list lesen echte Daten', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, runTasks: true, requireApproval: false } });
    const ctx = { agent };

    const kueche = env.store.create('project', { name: 'Küche', tags: ['haushalt'] });
    const buero = env.store.create('project', { name: 'Büro', status: 'paused' });
    const gestern = new Date(Date.now() - 86400000).toISOString();
    const naechsteWoche = new Date(Date.now() + 7 * 86400000).toISOString();

    env.store.create('task', { title: 'Mühle entkalken', projectId: kueche.id, due: gestern, priority: 1 });
    env.store.create('task', { title: 'Regal bauen', projectId: kueche.id, due: naechsteWoche, priority: 3 });
    env.store.create('task', { title: 'Abgehakt', projectId: kueche.id, status: 'done' });
    env.store.create('task', { title: 'Ohne Projekt', status: 'blocked' });
    env.store.create('note', { title: 'Espresso', tags: ['kaffee', 'haushalt'] });
    env.store.create('note', { title: 'Mahlgrad', tags: ['kaffee'] });

    const alle = await env.toolbox.call('tasks.list', {}, ctx);
    assert.equal(alle.result.total, 4);
    assert.equal(alle.result.tasks[0].title, 'Mühle entkalken', 'das Fälligste steht oben');

    const offen = await env.toolbox.call('tasks.list', { status: 'offen' }, ctx);
    assert.equal(offen.result.total, 3, '"offen" fasst todo, doing und blocked zusammen');
    assert.ok(!offen.result.tasks.some((t) => t.status === 'done'));

    const imProjekt = await env.toolbox.call('tasks.list', { projectId: kueche.id }, ctx);
    assert.equal(imProjekt.result.total, 3);

    const faellig = await env.toolbox.call('tasks.list', { dueBefore: new Date().toISOString() }, ctx);
    assert.equal(faellig.result.total, 1, 'nur die überfällige');
    assert.equal(faellig.result.tasks[0].title, 'Mühle entkalken');
    await assert.rejects(env.toolbox.call('tasks.list', { dueBefore: 'irgendwann' }, ctx), /kein Datum/);

    const projekte = await env.toolbox.call('projects.list', {}, ctx);
    assert.equal(projekte.result.total, 2);
    const kuecheOut = projekte.result.projects.find((p) => p.id === kueche.id);
    assert.equal(kuecheOut.openTasks, 2, 'erledigte Aufgaben zählen nicht als offen');
    const nurAktiv = await env.toolbox.call('projects.list', { status: 'paused' }, ctx);
    assert.equal(nurAktiv.result.total, 1);
    assert.equal(nurAktiv.result.projects[0].id, buero.id);

    // "haushalt" steht an einem Projekt und an einer Notiz, "kaffee" an zwei
    // Notizen: beide kommen zweimal vor, der Gleichstand wird alphabetisch
    // aufgeloest -- damit dieselben Daten immer dieselbe Reihenfolge ergeben.
    const tags = await env.toolbox.call('tags.list', {}, ctx);
    assert.deepEqual(tags.result.tags.slice(0, 2), [
      { name: 'haushalt', count: 2 },
      { name: 'kaffee', count: 2 },
    ]);
    env.store.create('note', { title: 'Noch mehr Kaffee', tags: ['kaffee'] });
    const danach = await env.toolbox.call('tags.list', {}, ctx);
    assert.deepEqual(danach.result.tags[0], { name: 'kaffee', count: 3 }, 'Haeufigkeit schlaegt Alphabet');

    const neu = await env.toolbox.call('projects.create', { name: 'Balkon' }, ctx);
    assert.equal(env.store.get(neu.result.id).data.name, 'Balkon');
    assert.ok(neu.result.id, 'die ID kommt zurück, damit der Agent Aufgaben einhängen kann');
  } finally {
    await env.close();
  }
});

test('activity.recent und chats.read geben wieder, was wirklich passiert ist', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const ctx = { agent };

    const frisch = env.store.create('note', { title: 'Heute geschrieben' });
    const chat = env.store.create('chat', { title: 'Über Kaffee' });
    // ordinal, wie der Chat-Dienst es selbst setzt: drei Nachrichten in
    // derselben Millisekunde sind normal, und IDs sind zufaellig, nicht
    // monoton -- ohne ordinal waere die Reihenfolge schlicht offen.
    env.store.create('message', { chatId: chat.id, role: 'system', content: 'Du bist hilfreich.', ordinal: 0 });
    env.store.create('message', { chatId: chat.id, role: 'user', content: 'Wie mahle ich?', ordinal: 1 });
    env.store.create('message', { chatId: chat.id, role: 'assistant', content: 'Fein.', usedNetwork: true, ordinal: 2 });

    const recent = await env.toolbox.call('activity.recent', { days: 7 }, ctx);
    assert.ok(recent.result.total >= 2, JSON.stringify(recent.result.byType));
    assert.ok(recent.result.items.some((i) => i.id === frisch.id && i.isNew === true));
    assert.equal(recent.result.byType.message, undefined, 'einzelne Nachrichten sind kein Tagesereignis');

    const gefiltert = await env.toolbox.call('activity.recent', { days: 7, types: 'note' }, ctx);
    assert.ok(gefiltert.result.items.every((i) => i.type === 'note'));
    await assert.rejects(env.toolbox.call('activity.recent', { types: 'grant' }, ctx), /keine gültige Art/);

    const liste = await env.toolbox.call('chats.list', {}, ctx);
    assert.equal(liste.result.chats[0].id, chat.id);
    assert.equal(liste.result.chats[0].messages, 3, 'gezählt wird, was wirklich im Tresor liegt');

    const verlauf = await env.toolbox.call('chats.read', { id: chat.id }, ctx);
    assert.equal(verlauf.result.total, 2, 'der System-Prompt gehört nicht zum Gespräch');
    assert.equal(verlauf.result.messages[0].role, 'user');
    assert.equal(verlauf.result.messages[1].usedNetwork, true,
      'die Herkunft reist mit: eine Zusammenfassung soll sagen können, dass die Antwort online entstand');
    await assert.rejects(env.toolbox.call('chats.read', { id: 'chat_qqqqqqqqqqqqqqqqqqqqqq' }, ctx), /NOT_FOUND|not found/);
  } finally {
    await env.close();
  }
});

/**
 * Provenance.
 *
 * Three different subsystems need to know "hat das ein Agent geschrieben?":
 * the trigger subsystem (or an agent that writes in reaction to a write
 * becomes a loop), the timeline, and a user who has stopped trusting one
 * agent and wants to find what it left behind. Guessing that from heuristics
 * is how a loop brake ends up either leaky or over-eager, so it is stamped
 * once, at the moment of writing.
 */
test('jeder Satz aus einem Lauf trägt, welcher Lauf ihn geschrieben hat', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({
      permissions: { readNotes: true, writeNotes: true, runTasks: true, createEdges: true, requireApproval: false },
    });
    const run = env.store.create('run', { agentId: agent.id, goal: 'Aufräumen', status: 'running' });
    const ctx = { agent, run };

    const note = await env.toolbox.call('notes.create', { title: 'Vom Agenten' }, ctx);
    const task = await env.toolbox.call('tasks.create', { title: 'Auch vom Agenten' }, ctx);
    const project = await env.toolbox.call('projects.create', { name: 'Ebenso' }, ctx);
    const memory = await env.toolbox.call('memory.remember', { text: 'Gemerkt.' }, ctx);
    const edge = await env.toolbox.call('graph.link', { from: note.result.id, to: task.result.id, reason: 'gehört zusammen' }, ctx);

    for (const id of [note.result.id, task.result.id, project.result.id, memory.result.id, edge.result.id]) {
      const record = env.store.get(id);
      assert.equal(record.data.runId, run.id, `${record.type} ohne Lauf-Stempel`);
      assert.equal(record.data.agentId, agent.id, `${record.type} ohne Agenten-Stempel`);
      assert.equal(record.data.source, 'agent', `${record.type} gibt sich nicht als Agentenwerk zu erkennen`);
    }

    // Ein Aufruf ohne Lauf -- eine Erweiterung, ein Test -- wird nicht
    // faelschlich als Agentenwerk markiert.
    const ohneLauf = await env.toolbox.call('notes.create', { title: 'Direkt' }, { agent });
    assert.equal(env.store.get(ohneLauf.result.id).data.runId, undefined);

    // Eine Aenderung an einer fremden Notiz macht sie nicht zum Agentenwerk:
    // sie bleibt die Notiz des Nutzers, auch wenn ein Agent sie angefasst hat.
    const eigene = env.store.create('note', { title: 'Vom Nutzer' });
    await env.toolbox.call('notes.update', { id: eigene.id, body: 'ergänzt' }, ctx);
    const danach = env.store.get(eigene.id);
    assert.equal(danach.data.runId, undefined, 'eine Änderung darf die Herkunft nicht umschreiben');
    assert.match(danach.data.body, /ergänzt/);
  } finally {
    await env.close();
  }
});

/**
 * Der Urheber-Kontext ueber einen ECHTEN Lauf, nicht nur ueber withActor().
 *
 * Der Stempel am Satz sagt nur, wer ihn angelegt hat. Was ein Lauf an
 * BESTEHENDEN Saetzen aendert, traegt keinen Stempel -- und genau das ist der
 * Fall, in dem jemand wissen will, was ueber Nacht passiert ist. Der Kontext
 * wird beim Start des Laufs gesetzt und traegt durch die ganze Kette.
 */
test('was ein echter Lauf aendert, wird dem Lauf zugeschrieben', async () => {
  const env = await makeEnv();
  try {
    const { currentActor } = require('../src/kernel/actor');
    const agent = env.createAgent({
      permissions: { readNotes: true, writeNotes: true, requireApproval: false },
    });
    // Eine Notiz, die dem Nutzer gehoert: kein Stempel, keine Herkunft.
    const eigene = env.store.create('note', { title: 'Vom Nutzer' });
    assert.equal(eigene.data.runId, undefined);

    const gesehen = [];
    env.bus.on('record.updated', (evt) => {
      gesehen.push({ id: evt.payload.id, actor: evt.payload.actor });
    });

    // Ein Werkzeugaufruf im Kontext eines Laufs, wie die Laufschleife ihn macht.
    const run = env.store.create('run', { agentId: agent.id, goal: 'Aufraeumen', status: 'running' });
    const { withActor } = require('../src/kernel/actor');
    let drinnen = null;
    await withActor({ kind: 'agent', runId: run.id, agentId: agent.id }, async () => {
      drinnen = currentActor();
      await env.toolbox.call('notes.update', { id: eigene.id, body: 'ergänzt' }, { agent, run });
    });

    assert.equal(drinnen.kind, 'agent');
    const treffer = gesehen.find((g) => g.id === eigene.id);
    assert.ok(treffer, 'kein record.updated gesehen');
    assert.equal(treffer.actor.kind, 'agent', 'die Aenderung wurde nicht dem Lauf zugeschrieben');
    assert.equal(treffer.actor.runId, run.id);

    // Und die Notiz selbst bleibt die des Nutzers -- der Kontext beantwortet
    // "wer hat geaendert", er schreibt die Herkunft nicht um.
    assert.equal(env.store.get(eigene.id).data.runId, undefined);

    // Ausserhalb eines Laufs ist der Urheber unbekannt, nicht "Agent".
    gesehen.length = 0;
    env.store.update(eigene.id, { body: 'vom Nutzer nachgetragen' });
    assert.equal(gesehen[0].actor, null, 'ohne Lauf darf kein Urheber behauptet werden');
  } finally {
    await env.close();
  }
});

test('die Lese-Werkzeuge bleiben ohne readNotes verschlossen', async () => {
  const env = await makeEnv();
  try {
    const blind = env.createAgent({ name: 'Blind', permissions: { readNotes: false } });
    const ctx = { agent: blind };
    for (const tool of ['tasks.list', 'projects.list', 'tags.list', 'activity.recent', 'chats.list']) {
      await assert.rejects(
        env.toolbox.call(tool, {}, ctx),
        /PERMISSION|nicht erlaubt|darf/i,
        `${tool} war ohne readNotes erreichbar`,
      );
    }
  } finally {
    await env.close();
  }
});

test('graph.neighbours zeigt Nachbarn mit lesbaren Beschriftungen', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true } });
    const a = env.store.create('note', { title: 'Mahlgrad' });
    const b = env.store.create('note', { title: 'Brühzeit' });
    env.store.edges.add({ from: a.id, to: b.id, kind: 'related', source: 'manual', reason: 'hängt zusammen' });
    const { result } = await env.toolbox.call('graph.neighbours', { id: a.id }, { agent });
    assert.deepEqual(result.nodes.map((n) => n.label).sort(), ['Brühzeit', 'Mahlgrad']);
    assert.equal(result.edges[0].reason, 'hängt zusammen');
  } finally {
    await env.close();
  }
});

test('unbekannte Werkzeuge und kaputte Parameter werden abgewiesen', async () => {
  const env = await makeEnv();
  try {
    const agent = env.createAgent({ permissions: { readNotes: true, writeNotes: true, requireApproval: false } });
    await assert.rejects(env.toolbox.call('shell.exec', { cmd: 'rm -rf /' }, { agent }), /NOT_FOUND|not found/);
    await assert.rejects(env.toolbox.call('notes.create', {}, { agent }), /"title" fehlt/);
    await assert.rejects(env.toolbox.call('notes.create', 'kein Objekt', { agent }), /Objekt/);
    await assert.rejects(env.toolbox.call('notes.read', { id: 'x' }, { agent: undefined }), /Agent-Kontext/);
    // Out-of-range numbers are clamped rather than rejected: a model guessing
    // limit=9999 should still get an answer.
    const { result } = await env.toolbox.call('notes.search', { query: 'x', limit: 9999 }, { agent });
    assert.equal(result.count, 0);
  } finally {
    await env.close();
  }
});

module.exports = { name: 'agents', tests: drain() };
