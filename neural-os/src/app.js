'use strict';

/**
 * Composition root.
 *
 * Boot order is a security property, not a style choice:
 *
 *   paths -> config -> audit -> store -> GATE -> HARDEN -> everything else
 *
 * The network gate and the process hardening are installed before any module
 * that could plausibly make a request exists. `store` is created before the
 * gate only because the gate persists its grants as records, and the store
 * itself never touches the network -- it is pure filesystem.
 *
 * Every subsystem is optional at boot EXCEPT paths/config/store. A subsystem
 * that fails to load is recorded in `app.failures` and reported honestly by
 * `doctor()` and `/api/status`; it is never silently replaced by something that
 * pretends to work.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const pathsMod = require('./kernel/paths');
const configMod = require('./kernel/config');
const { Bus } = require('./kernel/bus');
const { logger, Audit, setLevel } = require('./kernel/log');
const { StorageError, asNeuralError } = require('./kernel/errors');

const VERSION = require('../package.json').version;
const log = logger('app');

/** Load a subsystem, recording rather than throwing on failure. */
function optional(failures, name, factory) {
  try {
    const value = factory();
    if (value === undefined || value === null) {
      failures.push({ subsystem: name, reason: 'factory returned nothing' });
      return null;
    }
    return value;
  } catch (err) {
    const e = asNeuralError(err);
    failures.push({ subsystem: name, reason: e.message, code: e.code });
    log.error(`subsystem "${name}" unavailable: ${e.message}`);
    return null;
  }
}

/** require() that yields null instead of throwing for a missing module. */
function tryRequire(id) {
  try {
    return require(id);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(id.replace('./', ''))) return null;
    throw err;
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.home]        override the home directory
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string} [opts.logLevel]
 * @param {boolean} [opts.harden=true] install process-level network enforcement
 * @param {string} [opts.passphrase]  unlock an encrypted vault at boot
 */
async function createApp(opts = {}) {
  if (opts.logLevel) setLevel(opts.logLevel);

  const failures = [];
  const paths = pathsMod.ensureLayout(pathsMod.layout(opts.home));

  // --- configuration -------------------------------------------------------
  let config;
  try {
    config = configMod.load(paths.config);
  } catch (err) {
    if (err.recovered) {
      // A corrupt config must never silently widen the network policy.
      failures.push({ subsystem: 'config', reason: err.message, code: err.code });
      log.warn(err.message);
      config = err.recovered;
    } else {
      throw err;
    }
  }
  if (opts.port) config.server.port = opts.port;
  if (opts.host) config.server.host = opts.host;
  configMod.validateConfig(config);

  const bus = new Bus();
  const audit = new Audit(paths.audit, { enabled: config.network.audit !== false }).open();
  audit.write('app.start', { version: VERSION, node: process.version, mode: config.network.mode });

  // --- vault encryption ----------------------------------------------------
  const vaultCryptoMod = tryRequire('./store/vaultcrypto');
  const vaultCrypto = vaultCryptoMod
    ? optional(failures, 'vaultcrypto', () => vaultCryptoMod.createVaultCrypto({ paths, config }))
    : null;
  if (vaultCrypto && vaultCrypto.enabled && opts.passphrase) {
    await vaultCrypto.unlock(opts.passphrase);
    audit.write('vault.unlock', { via: 'boot' });
  }

  // --- storage (mandatory) -------------------------------------------------
  const engineMod = require('./store/engine');
  let store;
  try {
    store = await engineMod.openStore({ paths, bus, logger, vaultCrypto });
  } catch (err) {
    audit.write('app.fatal', { reason: String(err && err.message) });
    throw new StorageError(`Vault could not be opened: ${err.message}`, { cause: String(err) });
  }
  if (store.recovery && (store.recovery.dropped > 0 || store.recovery.recovered > 0)) {
    log.warn(`vault recovery: ${store.recovery.recovered} entries replayed, ${store.recovery.dropped} damaged line(s) dropped`);
    audit.write('vault.recovery', store.recovery);
  }

  // --- network gate + process hardening (before anything can dial out) ------
  const gateMod = tryRequire('./net/gate');
  const gate = gateMod
    ? optional(failures, 'gate', () => gateMod.createGate({ config, audit, bus, store, logger }))
    : null;

  let hardening = null;
  if (gate && opts.harden !== false) {
    const hardenMod = tryRequire('./net/harden');
    hardening = hardenMod ? optional(failures, 'harden', () => hardenMod.harden(gate, { logger })) : null;
    if (hardening) audit.write('net.hardened', {});
  } else if (!gate) {
    // Refuse to run wide open. Without a gate there is no enforceable promise,
    // and a promise we cannot keep is worse than an error.
    audit.write('app.fatal', { reason: 'network gate unavailable' });
    throw asNeuralError(new Error('Network gate unavailable - refusing to start without egress enforcement'));
  }

  // --- knowledge graph -----------------------------------------------------
  const deriveMod = tryRequire('./graph/derive');
  const viewMod = tryRequire('./graph/view');
  const graph = (deriveMod || viewMod)
    ? optional(failures, 'graph', () => ({ ...(deriveMod || {}), ...(viewMod || {}) }))
    : null;

  // Derived links are maintained as a side effect of every write, so the graph
  // can never drift away from the data it claims to describe.
  if (graph && typeof graph.deriveFor === 'function') {
    const rederive = (evt) => {
      const record = evt && evt.payload && evt.payload.record;
      if (!record || record.type === 'edge') return;
      try {
        graph.deriveFor(store, record);
      } catch (err) {
        log.warn(`link derivation failed for ${record.id}: ${err.message}`);
      }
    };
    bus.on('record.created', rederive);
    bus.on('record.updated', rederive);
  }

  // --- models --------------------------------------------------------------
  const registryMod = tryRequire('./models/registry');
  const registry = registryMod
    ? optional(failures, 'registry', () => registryMod.createRegistry({ config, gate, bus, logger }))
    : null;

  const chatMod = tryRequire('./models/chat');
  const chat = chatMod && registry
    ? optional(failures, 'chat', () => chatMod.createChatService({ store, registry, gate, bus, graph, config, logger }))
    : null;

  // --- agents --------------------------------------------------------------
  const approvalsMod = tryRequire('./agents/approvals');
  const approvals = approvalsMod
    ? optional(failures, 'approvals', () => approvalsMod.createApprovals({ store, bus, config }))
    : null;

  const toolsMod = tryRequire('./agents/tools');
  const toolbox = toolsMod
    ? optional(failures, 'toolbox', () => toolsMod.createToolbox({ store, registry, gate, graph, paths, approvals, config, logger, audit }))
    : null;

  const runtimeMod = tryRequire('./agents/runtime');
  const runtime = runtimeMod && registry && toolbox
    ? optional(failures, 'runtime', () => runtimeMod.createAgentRuntime({ store, registry, toolbox, approvals, gate, bus, config, logger, paths }))
    : null;

  // --- semantic search ------------------------------------------------------
  // Optional in the strongest sense: it needs a second model (an embedding
  // model) that most people will not have installed. Everything else keeps
  // working without it, and the search falls back to BM25 -- but the UI is told
  // which one it got, because silently answering a different question than the
  // one asked is the kind of dishonesty this system exists to avoid.
  const vectorsMod = tryRequire('./store/vectors');
  const vectors = vectorsMod
    ? optional(failures, 'vectors', () => vectorsMod.createVectorStore({ paths, vaultCrypto, logger }))
    : null;

  const embeddingsMod = tryRequire('./models/embeddings');
  const embeddings = embeddingsMod && registry && vectors
    ? optional(failures, 'embeddings', () => embeddingsMod.createEmbeddings({
      registry, gate, config, store, bus, logger, vectors,
    }))
    : null;

  // Keep the semantic index in step with the data, the same way derived links
  // are kept in step: as a consequence of the write, never as a separate thing
  // the user has to remember to run.
  //
  // `suspendIndexing` exists for bulk writes (a restore, an import). Without
  // it a 5000-record import means 5000 model calls and 5000 full index writes,
  // which is slower than the import itself and pointless: one reindexAll()
  // afterwards produces the same result.
  let indexingSuspended = 0;
  if (embeddings && typeof embeddings.indexRecord === 'function') {
    const reindex = (evt) => {
      if (indexingSuspended > 0) return;
      const record = evt && evt.payload && evt.payload.record;
      if (!record || record.type === 'edge' || record.type === 'message') return;
      Promise.resolve(embeddings.indexRecord(record)).catch((err) => {
        // An unreachable embedding model must not turn every save into an error.
        log.debug(`Einbettung für ${record.id} nicht aktualisiert: ${err && err.message}`);
      });
    };
    bus.on('record.created', reindex);
    bus.on('record.updated', reindex);
    bus.on('record.deleted', (evt) => {
      const id = evt && evt.payload && evt.payload.id;
      if (id && typeof embeddings.removeRecord === 'function') {
        Promise.resolve(embeddings.removeRecord(id)).catch(() => {});
      }
    });
  }

  // --- file text extraction -------------------------------------------------
  const extract = tryRequire('./store/extract');

  // --- device synchronisation -----------------------------------------------
  const syncMod = tryRequire('./sync/peer');
  const sync = syncMod
    ? optional(failures, 'sync', () => syncMod.createSync({ store, gate, config, bus, logger, auth: null, paths }))
    : null;

  // --- support services ----------------------------------------------------
  const backupMod = tryRequire('./store/backup');
  const backup = backupMod
    ? optional(failures, 'backup', () => backupMod.createBackup({ store, paths, config, logger }))
    : null;

  const authMod = tryRequire('./http/auth');
  const auth = authMod
    ? optional(failures, 'auth', () => authMod.createAuth({ store, config, logger, audit }))
    : null;

  if (sync && typeof sync.setAuth === 'function' && auth) sync.setAuth(auth);

  const app = {
    version: VERSION,
    paths,
    config,
    bus,
    audit,
    logger,
    store,
    gate,
    hardening,
    vaultCrypto,
    graph,
    registry,
    chat,
    approvals,
    toolbox,
    runtime,
    backup,
    auth,
    vectors,
    embeddings,
    extract,
    sync,
    failures,
    server: null,

    /**
     * Run `fn` without feeding every write to the embedding model.
     * Bulk writers (import, restore) use this and then reindex once.
     */
    async withoutIndexing(fn) {
      indexingSuspended++;
      try {
        return await fn();
      } finally {
        indexingSuspended = Math.max(0, indexingSuspended - 1);
      }
    },

    /** Persist a changed configuration and apply what can be applied live. */
    saveConfig(patch) {
      const next = configMod.deepMerge(config, patch);
      configMod.validateConfig(next);
      configMod.save(paths.config, next);
      Object.assign(config, next);
      if (gate && patch.network && patch.network.mode) gate.setMode(patch.network.mode);
      bus.publish('config.changed', { config: sanitiseConfig(config) });
      audit.write('config.changed', { keys: Object.keys(patch) });
      return config;
    },

    /** Honest report of what is and is not working. Used by `doctor` and /api/status. */
    async doctor() {
      const subsystems = {
        store: !!store,
        gate: !!gate,
        hardening: !!hardening,
        encryption: vaultCrypto ? vaultCrypto.state : 'unavailable',
        graph: !!graph,
        models: !!registry,
        chat: !!chat,
        agents: !!runtime,
        approvals: !!approvals,
        backup: !!backup,
        auth: !!auth,
        extraction: !!extract,
        sync: !!sync,
        vectors: !!vectors,
        embeddings: !!embeddings,
      };
      let semantic = { available: false, reason: 'Semantische Suche nicht geladen' };
      if (embeddings && typeof embeddings.available === 'function') {
        try {
          const state = await embeddings.available();
          semantic = state && state.ok
            ? { available: true, model: state.model, dim: state.dim, indexed: vectors ? vectors.size() : 0 }
            : { available: false, reason: (state && state.reason) || 'Kein Einbettungsmodell erreichbar' };
        } catch (err) {
          semantic = { available: false, reason: asNeuralError(err).message };
        }
      }
      let models = { available: false, providers: [], reason: 'model registry unavailable' };
      if (registry) {
        try {
          const snap = await registry.refresh({ timeoutMs: 1200 });
          const providers = snap.providers || [];
          models = {
            available: providers.some((p) => p.available),
            providers: providers.map((p) => ({
              id: p.id, baseUrl: p.baseUrl, available: p.available,
              models: (p.models || []).map((m) => m.id), error: p.error || null,
            })),
          };
        } catch (err) {
          models = { available: false, providers: [], reason: asNeuralError(err).message };
        }
      }
      return {
        version: VERSION,
        node: process.version,
        home: paths.home,
        network: { mode: config.network.mode, hardened: !!hardening, strictAllowlist: config.network.strictAllowlist },
        vault: { ...(store.stats ? store.stats() : {}), encryption: vaultCrypto ? vaultCrypto.state : 'unavailable' },
        subsystems,
        models,
        semantic,
        peers: sync && typeof sync.summary === 'function' ? sync.summary() : null,
        failures,
      };
    },

    async listen() {
      const serverMod = require('./http/server');
      const created = await serverMod.createServer(app);
      app.server = created;
      await created.listen();
      audit.write('server.listen', { host: config.server.host, port: config.server.port });
      return created;
    },

    async close() {
      const problems = [];
      for (const [name, fn] of [
        ['server', () => app.server && app.server.close()],
        ['runtime', () => runtime && runtime.abortAll && runtime.abortAll()],
        ['vectors', () => vectors && vectors.close && vectors.close()],
        ['store', () => store.close()],
      ]) {
        try {
          await fn();
        } catch (err) {
          problems.push({ name, error: String(err && err.message) });
        }
      }
      if (hardening && hardening.restore) hardening.restore();
      if (vaultCrypto && vaultCrypto.lock) vaultCrypto.lock();
      audit.write('app.stop', { problems: problems.length });
      audit.close();
      return problems;
    },
  };

  return app;
}

/** Strip anything secret-adjacent before the config crosses the HTTP boundary. */
function sanitiseConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  if (copy.models && Array.isArray(copy.models.remote)) {
    copy.models.remote = copy.models.remote.map((r) => ({ ...r, apiKey: undefined, apiKeyEnv: r.apiKeyEnv || null }));
  }
  return copy;
}

/** Seed a brand-new vault so the first run is not an empty void. */
async function seedIfEmpty(app) {
  if (app.store.count('note') > 0 || app.store.count('agent') > 0) return false;

  const welcome = app.store.create('note', {
    title: 'Willkommen in Neural OS',
    body: [
      'Dies ist dein eigenes System. Alles, was du hier schreibst, liegt auf diesem Gerät',
      `unter \`${app.paths.home}\`. Nichts davon wird irgendwohin gesendet.`,
      '',
      '## Die drei Netzstufen',
      '',
      '- **Offline** (Standard): nur dieses Gerät. Ein lokales Modell auf `127.0.0.1` gilt',
      '  ausdrücklich nicht als Netzwerkzugriff und funktioniert weiter.',
      '- **LAN**: zusätzlich dein eigenes Netzwerk, etwa ein Modellserver auf einem',
      '  stärkeren Rechner.',
      '- **Online**: öffentliches Internet, standardmäßig zusätzlich per Allowlist begrenzt.',
      '',
      'Unter #Netzwerk siehst du jede einzelne Verbindung, die versucht wurde — auch die',
      'erlaubten. Ein Protokoll, das nur Blockaden zeigt, würde nichts beweisen.',
      '',
      '## Erste Schritte',
      '',
      '1. Ein lokales Modell installieren: [[Lokales Modell einrichten]]',
      '2. Eine Notiz anlegen und mit `[[Doppelklammern]]` auf eine andere verweisen.',
      '3. Das Ergebnis unter #Gehirn ansehen — die Verknüpfung ist dort sofort sichtbar.',
      '',
      '#willkommen #anleitung',
    ].join('\n'),
    tags: ['willkommen', 'anleitung'],
    pinned: true,
  });

  const setup = app.store.create('note', {
    title: 'Lokales Modell einrichten',
    body: [
      'Neural OS enthält bewusst kein KI-Modell. Ein Modell sind je nach Größe 2–20 GB;',
      'das gehört nicht in ein Programmverzeichnis, und du sollst selbst wählen können.',
      '',
      '## Ollama (empfohlen)',
      '',
      '```',
      '# einmalig, mit Internet:',
      'ollama pull llama3.2        # ~2 GB, läuft auf fast allem',
      'ollama pull qwen2.5:7b      # ~4,7 GB, deutlich stärker, ab 16 GB RAM',
      '```',
      '',
      'Ollama lauscht auf `127.0.0.1:11434`. Neural OS findet es von allein.',
      'Ab diesem Moment funktioniert der Chat vollständig ohne Internet.',
      '',
      '## Alternativen',
      '',
      'llama.cpp (`llama-server`, Port 8080) und LM Studio (Port 1234) werden ebenfalls',
      'automatisch erkannt. Beide sprechen das OpenAI-kompatible Protokoll.',
      '',
      '## Was realistisch zu erwarten ist',
      '',
      'Ein 7B-Modell ist stark beim Zusammenfassen, Umformulieren, Strukturieren und',
      'Verschlagworten. Es ist schwach bei langen Beweisketten und komplexem Code.',
      'Für solche Aufgaben gibt es den kontrollierten Online-Modus — bewusst,',
      'pro Chat oder pro Anfrage.',
      '',
      '#anleitung #modelle',
    ].join('\n'),
    tags: ['anleitung', 'modelle'],
  });

  app.store.edges.add({
    from: welcome.id, to: setup.id, kind: 'links-to', source: 'derived',
    reason: 'Wiki-Link in "Willkommen in Neural OS"',
  });

  // Built-in agent templates, deliberately with restrictive defaults.
  const agentsMod = tryRequire('./agents/permissions');
  const templates = agentsMod && typeof agentsMod.builtinAgents === 'function'
    ? agentsMod.builtinAgents()
    : (tryRequire('./agents/runtime') && typeof tryRequire('./agents/runtime').builtinAgents === 'function'
      ? tryRequire('./agents/runtime').builtinAgents()
      : []);
  for (const tpl of templates) {
    try {
      app.store.create('agent', { ...tpl, builtin: true });
    } catch (err) {
      log.warn(`could not seed agent "${tpl && tpl.name}": ${err.message}`);
    }
  }

  const project = app.store.create('project', {
    name: 'Mein erstes Projekt',
    description: 'Ein Platz, um Notizen, Aufgaben und Chats zu einem Vorhaben zu bündeln.',
  });
  app.store.create('task', { title: 'Lokales Modell installieren', projectId: project.id, priority: 1 });
  app.store.create('task', { title: 'Graph-Ansicht ausprobieren', projectId: project.id });

  await app.store.flush();
  return true;
}

/** Write a lock file so two instances cannot share one vault. */
async function acquireLock(paths) {
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    await fsp.writeFile(paths.lock, payload, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let holder = null;
    try {
      holder = JSON.parse(await fsp.readFile(paths.lock, 'utf8'));
    } catch { /* unreadable lock is treated as stale */ }
    if (holder && holder.pid && isProcessAlive(holder.pid)) {
      throw new StorageError(
        `Another Neural OS instance (PID ${holder.pid}) is already using ${path.dirname(paths.lock)}. ` +
        'Two instances sharing one vault would corrupt it.',
      );
    }
    await fsp.writeFile(paths.lock, payload, { mode: 0o600 });
  }
  return async () => {
    try { await fsp.unlink(paths.lock); } catch { /* already gone */ }
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by someone else
  }
}

module.exports = { createApp, seedIfEmpty, acquireLock, sanitiseConfig, VERSION };
