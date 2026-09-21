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
  // Port 0 heisst "such dir einen freien aus". Das ist ein gueltiger Wunsch,
  // aber kein gueltiger Eintrag in der gespeicherten Konfiguration: eine
  // config.json, in der "port: 0" steht, sagt dem Menschen, der sie liest,
  // nichts. `validateConfig` weist ihn deshalb zu Recht ab.
  //
  // Frueher fiel der Wunsch durch `if (opts.port)` stillschweigend unter den
  // Tisch und wurde 7777 -- ein Werkzeug, das absichtlich neben einer
  // laufenden Instanz starten wollte, scheiterte dann mit EADDRINUSE an einem
  // Port, den es nie angefordert hatte. Jetzt wird er beiseitegelegt und an
  // `listen()` weitergereicht, wo er hingehoert.
  const ephemeralPort = opts.port === 0;
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
  //
  // `derivationSuspended` ist der Grund, warum eine Wiederherstellung fruueher
  // mehr Kanten zurueckbrachte, als gesichert worden waren: jeder eingespielte
  // Satz feuert `record.created`, die Ableitung sieht darin `[[Links]]` und
  // Schlagworte und legt daraus EIGENE Kanten an -- zusaetzlich zu den Kanten,
  // die im selben Import gerade aus der Sicherung kommen. Sie tragen neue ids,
  // also greift auch die Dublettenpruefung in `store.edges.add` nicht. Gemessen
  // wurden aus 24 gesicherten Kanten 43. Waehrend eines Massenschreibvorgangs
  // ruht die Ableitung deshalb; `bulkWrite` leitet danach EINMAL sauber ab.
  let derivationSuspended = 0;
  if (graph && typeof graph.deriveFor === 'function') {
    const rederive = (evt) => {
      if (derivationSuspended > 0) return;
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

  // --- Altlast: Lernkarten aus einer frueheren Fassung ----------------------
  //
  // Der Bereich "Lernen" ist entfallen. Vorhandene 'card'-Saetze werden hier
  // EINMAL in Notizen umgewandelt, statt liegenzubleiben: der Typ steht nicht
  // mehr in schema.TYPES, also fielen sie still aus jeder neuen Sicherung
  // heraus -- weg waeren sie genau dann, wenn man sie braucht.
  //
  // Erst hier und nicht direkt nach openStore(): ab dieser Zeile haengt die
  // Ableitung der Verknuepfungen am Bus, also bekommen die neuen Notizen ihre
  // [[Links]] wie jede andere Notiz auch. Und noch immer, bevor irgendein
  // Teilsystem den Tresor gelesen hat.
  const migrationsMod = tryRequire('./store/migrations');
  if (migrationsMod && typeof migrationsMod.lernkartenZuNotizen === 'function') {
    try {
      const bericht = migrationsMod.lernkartenZuNotizen(store, { logger });
      if (bericht.gefunden) {
        log.info(`Lernkarten: ${bericht.umgewandelt} in Notizen umgewandelt, ${bericht.verworfen} geloeschte entfernt.`);
        audit.write('vault.migration.cards', bericht);
        if (bericht.fehler.length) {
          failures.push({ subsystem: 'migration/lernkarten', reason: `${bericht.fehler.length} Karte(n) nicht umgewandelt` });
        }
      }
    } catch (err) {
      // Eine gescheiterte Umwandlung darf den Start nicht verhindern -- die
      // Karten liegen dann noch da und koennen es beim naechsten Mal wieder
      // versuchen. Verschwiegen wird sie trotzdem nicht.
      const e = asNeuralError(err);
      failures.push({ subsystem: 'migration/lernkarten', reason: e.message, code: e.code });
      log.error(`Lernkarten-Umwandlung fehlgeschlagen: ${e.message}`);
    }
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

  // --- Modellvergleich -------------------------------------------------------
  //
  // Dieselbe Frage an zwei Modelle. Braucht die Registry und die Schleuse:
  // die zweite Seite ist haeufig ein Online-Anbieter, und dass eine Frage das
  // Geraet verlaesst, darf keine Nebenwirkung sein, sondern eine Entscheidung.
  const compareMod = tryRequire('./models/compare');
  const compare = compareMod && registry
    ? optional(failures, 'compare', () => compareMod.createCompare({ registry, gate, store, bus, config, logger }))
    : null;

  // --- zweiter Blick ---------------------------------------------------------
  //
  // Zwei der drei Teile brauchen ein Modell, der dritte nicht: "welche
  // Begriffe aus dieser Notiz kommen schon anderswo vor" ist reine Textarbeit
  // und der Volltextindex. Deshalb wird das Teilsystem AUCH ohne Registry
  // gebaut -- es liefert dann den dritten Teil und sagt ehrlich, was fehlt,
  // statt gar nicht zu erscheinen.
  const secondLookMod = tryRequire('./agents/secondlook');
  const secondLook = secondLookMod
    ? optional(failures, 'secondLook', () => secondLookMod.createSecondLook({
      store, registry, graph, gate, bus, config, logger,
    }))
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

  // --- model-free assistance ------------------------------------------------
  //
  // Deliberately independent of `registry`: everything it does is text and
  // graph analysis, so it keeps working on a machine that has no model at all.
  // That is the point -- the most useful help this system gives should not be
  // the part that needs a 5 GB download.
  const assistMod = tryRequire('./assist/engine');
  const assist = assistMod
    ? optional(failures, 'assist', () => assistMod.createAssist({ store, graph, bus, config, logger }))
    : null;

  // --- undo -----------------------------------------------------------------
  //
  // Its own journal, not the write log: `maybeSnapshot()` compacts every 2000
  // operations and deletes every log segment, so a log-based history would
  // vanish silently. An undo that works sometimes is worse than none.
  //
  // Built before the automation so that a scheduled run's writes are already
  // being journalled the first time one fires.
  const historyMod = tryRequire('./store/history');
  const history = historyMod
    ? optional(failures, 'history', () => historyMod.createHistory({
      store, bus, paths, config, logger, vaultCrypto,
    }))
    : null;
  if (history && typeof history.start === 'function') {
    try {
      history.start();
    } catch (err) {
      failures.push({ subsystem: 'history', reason: asNeuralError(err).message });
      log.error(`Änderungsverlauf konnte nicht gestartet werden: ${err && err.message}`);
    }
  }

  // --- automation -----------------------------------------------------------
  //
  // Both are built even when `runtime` is absent, and both are inert until
  // `start()` is called (which happens in `listen()`, not here -- a `doctor`
  // run must not start a timer). Without a runtime they record the real
  // reason in `lastError` instead of failing silently: a schedule that cannot
  // run and says nothing is exactly the kind of quiet lie this system avoids.
  const scheduleMod = tryRequire('./agents/schedule');
  const scheduler = scheduleMod
    ? optional(failures, 'scheduler', () => scheduleMod.createScheduler({
      store, runtime, bus, config, logger, audit,
    }))
    : null;

  const triggersMod = tryRequire('./agents/triggers');
  const triggers = triggersMod
    ? optional(failures, 'triggers', () => triggersMod.createTriggers({
      store, runtime, bus, config, logger, audit,
    }))
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

  // --- beobachtete Ordner ----------------------------------------------------
  //
  // Nach `extract`, weil der Beobachter den Text aus den Dateien braucht.
  // `bulkWrite` wird erst nach dem Bau des app-Objekts nachgereicht (es haengt
  // daran) -- bis dahin laeuft ein Durchlauf ohne den Schutzraum, und genau
  // deshalb wird der Beobachter auch erst in `listen()` gestartet.
  const watchMod = tryRequire('./store/watch');
  const watcher = watchMod
    ? optional(failures, 'watcher', () => watchMod.createWatcher({
      store, bus, paths, config, logger, extract,
      // Ein grosser Durchlauf nimmt viele Saetze auf einmal auf und wuerde
      // sonst den Rueckgaengig-Verlauf leerfegen. `app` gibt es an dieser
      // Stelle noch nicht -- der Abschluss greift erst beim Durchlauf darauf
      // zu, und der findet lange nach dem Bau statt.
      bulkWrite: (fn) => app.bulkWrite(fn),
    }))
    : null;

  // --- device synchronisation -----------------------------------------------
  const syncMod = tryRequire('./sync/peer');
  const sync = syncMod
    ? optional(failures, 'sync', () => syncMod.createSync({ store, gate, config, bus, logger, auth: null, paths }))
    : null;

  // --- user-installed extensions -------------------------------------------
  //
  // Loaded LAST on purpose. Everything a module can touch must already exist
  // and be in a known-good state before third-party code runs against it, and
  // a module that fails must not be able to prevent the rest of the system
  // from having come up.
  const sandboxMod = tryRequire('./modules/sandbox');
  const registryModulesMod = tryRequire('./modules/registry');
  let modules = null;
  if (sandboxMod && registryModulesMod) {
    const sandbox = optional(failures, 'module-sandbox', () => sandboxMod.createSandbox({
      store, gate, bus, config, logger, paths, audit,
    }));
    // The model registry is handed over after construction: without it the
    // `model.use` capability would exist and then throw NoModelError, which
    // looks to the user like a missing model rather than a missing wire.
    if (sandbox && registry && typeof sandbox.attachModels === 'function') {
      sandbox.attachModels(registry);
    }
    if (sandbox) {
      modules = optional(failures, 'modules', () => registryModulesMod.createModuleRegistry({
        store, sandbox, bus, logger, config, audit, paths,
      }));
    }
  }

  // --- support services ----------------------------------------------------
  const backupMod = tryRequire('./store/backup');
  // `vaultCrypto` gehoert hier hinein, obwohl die Sicherung selbst nie
  // verschluesselt: der Aenderungsverlauf (vault/history.jsonl) liegt in einem
  // verschluesselten Tresor zeilenweise versiegelt da. Ohne den Schluessel
  // zaehlt die Sicherung diese Zeilen als "versiegelt" und laesst sie weg --
  // ausgerechnet bei dem, der seinen Tresor geschuetzt hat, waere der Verlauf
  // nach einem Umzug also leer, und niemand haette es gesagt.
  const backup = backupMod
    ? optional(failures, 'backup', () => backupMod.createBackup({ store, paths, config, logger, vaultCrypto }))
    : null;

  const authMod = tryRequire('./http/auth');
  const auth = authMod
    ? optional(failures, 'auth', () => authMod.createAuth({ store, config, logger, audit }))
    : null;

  // --- der USB-Stick ---------------------------------------------------------
  //
  // EINMAL hier und nicht je Anfrage: die Sperre, die zwei gleichzeitige
  // Vorgaenge auf derselben Stick-Wurzel verhindert, haengt zwar am Pfad und
  // nicht am Objekt -- aber `gate`, `paths` und `config` gehoeren ohnehin
  // dieser Instanz, und eine Route soll sich kein eigenes Werkzeug bauen
  // muessen. `rc.ctx.stick` ist damit in jeder Route da.
  //
  // Nach `gate`, weil eine zusaetzliche Laufzeit durch die Netzschleuse geholt
  // wird; ohne sie bliebe nur die Laufzeit dieses Rechners -- was der
  // Normalfall ist und kein Fehler.
  const stickMod = tryRequire('./portable/stick');
  const stick = stickMod
    ? optional(failures, 'stick', () => stickMod.createStick({ gate, logger, paths, config }))
    : null;

  if (sync && typeof sync.setAuth === 'function' && auth) sync.setAuth(auth);

  // The toolbox is built before the module registry exists (modules load last
  // on purpose), so the link is made here rather than at construction.
  if (toolbox && typeof toolbox.attachModules === 'function' && modules) {
    toolbox.attachModules(modules);
  }

  // Einmal ermittelt und an zwei Stellen gebraucht: der Startbanner sagt es,
  // und `doctor()`/`/api/status` muessen es sagen koennen -- sonst kann der
  // Browser nicht einmal erfahren, DASS er von einem Stick laeuft.
  const portable = pathsMod.portableInfo(paths.home);

  // --- Laufzeitkern vom Datentraeger -----------------------------------------
  //
  // NUR im portablen Betrieb. Auf einer gewoehnlichen Installation entsteht
  // dieses Objekt gar nicht erst: dort gibt es keinen Stick, auf dem ein Kern
  // liegen koennte, und ein Aufseher ueber nichts waere eine Zeile im
  // Selbstbericht, die jeden Leser in die Irre fuehrt.
  //
  // Hier wird NICHTS gestartet -- der Bau eines app-Objekts darf keinen
  // fremden Prozess erzeugen, sonst startet `doctor` ein 4-GB-Modell, nur weil
  // jemand nach dem Zustand gefragt hat. Das Starten steht in `listen()`,
  // genau wie bei watcher/scheduler/triggers.
  const runnerMod = tryRequire('./models/local-runner');
  const localRunner = runnerMod && portable
    ? optional(failures, 'stick-modell', () => runnerMod.createLocalRunner({
      stickRoot: portable.root, gate, logger, audit,
    }))
    : null;

  const app = {
    version: VERSION,
    paths,
    portable,
    localRunner,
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
    assist,
    compare,
    secondLook,
    watcher,
    history,
    scheduler,
    triggers,
    backup,
    auth,
    stick,
    modules,
    vectors,
    embeddings,
    extract,
    sync,
    failures,
    server: null,

    /**
     * Einen Massenschreibvorgang ausführen: Import, Wiederherstellung.
     *
     * Drei Dinge werden dabei ausgesetzt, aus drei verschiedenen Gründen:
     *
     * - **Die Einbettungen.** 50 000 Sätze wären 50 000 Modellaufrufe und
     *   50 000 Indexschreibvorgänge -- langsamer als der Import selbst und
     *   sinnlos, weil ein `reindexAll()` danach dasselbe Ergebnis liefert.
     * - **Das Änderungsjournal.** Es ist begrenzt (2000 Einträge). Ein Import
     *   würde es vollständig füllen und damit genau das verdrängen, wofür es
     *   da ist: deine letzten echten Änderungen. Und „einen einzelnen Satz aus
     *   einem Import zurücknehmen" bedeutet ohnehin nichts -- wer einen Import
     *   rückgängig machen will, spielt die vorige Sicherung ein.
     * - **Die Ableitung der Verknüpfungen.** Anders als die beiden oberen ist
     *   das keine Frage der Kosten, sondern der Richtigkeit: die Ableitung
     *   hört am Bus mit und legt zu jedem eingespielten Satz eigene Kanten an
     *   -- zusätzlich zu den Kanten, die derselbe Import gerade aus der
     *   Sicherung zurückholt. Gemessen wurden aus 24 gesicherten Kanten 43,
     *   davon 19 Dubletten. Deshalb ruht sie hier und wird danach EINMAL
     *   vollständig nachgeholt.
     *
     * Das Nachholen ist Teil der Zusage, nicht Beiwerk: wer die Ableitung
     * aussetzt und nicht nachholt, verliert die Verknüpfungen frisch
     * aufgenommener Sätze (der Ordnerbeobachter schreibt auch über diesen
     * Weg). Gelingt es nicht, wird das über `opts.onRederive` gemeldet --
     * still fehlen darf es nicht.
     *
     * @param {Function} fn
     * @param {{rederive?:boolean, onRederive?:(bericht:object)=>void}} [opts]
     */
    async bulkWrite(fn, opts = {}) {
      const kannAbleiten = !!(graph && typeof graph.scanAll === 'function');
      const willAbleiten = opts.rederive !== false;
      indexingSuspended++;
      if (willAbleiten) derivationSuspended++;
      let ergebnis;
      try {
        ergebnis = history && typeof history.suspend === 'function'
          ? await history.suspend(fn)
          : await fn();
      } finally {
        indexingSuspended = Math.max(0, indexingSuspended - 1);
        if (willAbleiten) derivationSuspended = Math.max(0, derivationSuspended - 1);
      }
      // Erst wenn der äußerste Massenschreibvorgang fertig ist: ein
      // verschachtelter Aufruf würde sonst mitten im Import ableiten, wo die
      // Endpunkte der Kanten noch gar nicht alle da sind.
      if (willAbleiten && derivationSuspended === 0) {
        let bericht;
        if (!kannAbleiten) {
          bericht = { ok: false, grund: 'Die Ableitung der Verknüpfungen ist nicht geladen; sie wurde nach dem Import nicht nachgeholt.' };
        } else {
          try {
            const r = graph.scanAll(store);
            bericht = { ok: true, geprueft: r.scanned, angelegt: r.created, entfernt: r.removed, ms: r.ms };
          } catch (err) {
            bericht = { ok: false, grund: `Die Verknüpfungen konnten nicht neu abgeleitet werden: ${err && err.message}` };
            log.warn(bericht.grund);
          }
        }
        if (typeof opts.onRederive === 'function') {
          try { opts.onRederive(bericht); } catch { /* der Aufrufer meldet selbst */ }
        }
      }
      return ergebnis;
    },

    /** Früherer Name von `bulkWrite`. Bleibt, damit nichts still bricht. */
    async withoutIndexing(fn) {
      return app.bulkWrite(fn);
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
        assist: !!assist,
        compare: !!compare,
        secondLook: !!secondLook,
        watcher: !!watcher,
        history: !!history,
        scheduler: !!scheduler,
        triggers: !!triggers,
        backup: !!backup,
        auth: !!auth,
        stick: !!stick,
        // Bewusst NICHT in dieser Liste: sie zaehlt Teilsysteme auf, die auf
        // jeder Installation geladen sein sollten, und ein `false` darin ist
        // ein Fehlstart. Der Aufseher ueber den Laufzeitkern fehlt auf einer
        // gewoehnlichen Installation aber voellig zu Recht -- dort gibt es
        // keinen Datentraeger, auf dem ein Kern liegen koennte. Seine
        // Auskunft steht darum weiter unten unter `stickModell`, mit allen
        // vier Zustaenden statt einem irrefuehrenden Ja/Nein.
        extraction: !!extract,
        sync: !!sync,
        modules: !!modules,
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
              // Ohne diese beiden Felder steht hier dreimal "127.0.0.1" und
              // die einzige Frage, die ein Stick-Besitzer wirklich hat --
              // laeuft die KI aus meiner Tasche oder aus diesem fremden
              // Rechner? -- bleibt unbeantwortet.
              quelle: p.quelle || 'geraet', vomStick: !!p.vomStick,
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
        portable: pathsMod.describePortable(portable),
        // null heisst: dieser Lauf bringt keinen eigenen Laufzeitkern mit
        // (gewoehnliche Installation). Sonst steht hier einer der vier
        // Zustaende aus models/local-runner.js -- mit Grund, wenn er
        // gescheitert ist, samt der letzten Zeilen seiner Fehlerausgabe.
        stickModell: localRunner && typeof localRunner.zustand === 'function' ? localRunner.zustand() : null,
        network: { mode: config.network.mode, hardened: !!hardening, strictAllowlist: config.network.strictAllowlist },
        vault: { ...(store.stats ? store.stats() : {}), encryption: vaultCrypto ? vaultCrypto.state : 'unavailable' },
        subsystems,
        models,
        semantic,
        automation: {
          scheduler: scheduler && typeof scheduler.status === 'function' ? scheduler.status() : null,
          triggers: triggers && typeof triggers.status === 'function' ? triggers.status() : null,
        },
        assistance: assist && typeof assist.stats === 'function' ? assist.stats() : null,
        undo: history && typeof history.stats === 'function' ? history.stats() : null,
        ordner: watcher && typeof watcher.status === 'function' ? watcher.status() : null,
        extensions: modules && typeof modules.status === 'function' ? modules.status() : null,
        peers: sync && typeof sync.summary === 'function' ? sync.summary() : null,
        failures,
      };
    },

    /**
     * Start user-installed extensions.
     *
     * Separate from createApp() so a caller can boot the system, decide the
     * app is healthy, and only then hand control to code the user pasted in.
     * `safeMode` skips all of them -- the escape hatch for a module that
     * breaks the app, reachable with `neural-os start --safe`.
     */
    async loadModules({ safeMode = false } = {}) {
      if (!modules || typeof modules.loadAll !== 'function') return { loaded: 0, failed: 0, disabled: 0, safeMode };
      try {
        const result = await modules.loadAll({ safeMode });
        if (result && result.failed) {
          log.warn(`${result.failed} Erweiterung(en) konnten nicht geladen werden und wurden deaktiviert.`);
        }
        audit.write('modules.load', result || {});
        return result;
      } catch (err) {
        // A registry that cannot even start must not take the app with it.
        const e = asNeuralError(err);
        failures.push({ subsystem: 'modules', reason: e.message, code: e.code });
        log.error(`Erweiterungen konnten nicht geladen werden: ${e.message}`);
        return { loaded: 0, failed: 0, disabled: 0, safeMode, error: e.message };
      }
    },

    async listen(opts = {}) {
      const serverMod = require('./http/server');
      const created = await serverMod.createServer(app);
      app.server = created;
      await created.listen(ephemeralPort && opts.port === undefined ? { ...opts, port: 0 } : opts);
      audit.write('server.listen', { host: config.server.host, port: config.server.port });

      // Automation starts here rather than in createApp(), so a command that
      // only inspects the vault (`doctor`, `export`) never starts a clock and
      // never fires an agent as a side effect of being asked a question.
      // Individual schedules and triggers are still off until switched on.
      if (scheduler && typeof scheduler.start === 'function') {
        try {
          const every = Number(config.agents && config.agents.scheduleIntervalMs);
          scheduler.start(Number.isFinite(every) && every >= 1000 ? { intervalMs: every } : {});
        } catch (err) {
          failures.push({ subsystem: 'scheduler', reason: asNeuralError(err).message });
          log.error(`Zeitplan konnte nicht gestartet werden: ${err && err.message}`);
        }
      }
      if (triggers && typeof triggers.start === 'function') {
        try {
          triggers.start();
        } catch (err) {
          failures.push({ subsystem: 'triggers', reason: asNeuralError(err).message });
          log.error(`Auslöser konnten nicht gestartet werden: ${err && err.message}`);
        }
      }
      if (watcher && typeof watcher.start === 'function') {
        try {
          watcher.start();
        } catch (err) {
          failures.push({ subsystem: 'watcher', reason: asNeuralError(err).message });
          log.error(`Ordnerbeobachtung konnte nicht gestartet werden: ${err && err.message}`);
        }
      }
      // Zuletzt: der mitgelieferte Laufzeitkern. Er darf nichts aufhalten,
      // also wird hier weder auf seine Bereitschaft gewartet noch geworfen.
      await app.startLocalRunner(opts.modellTimeoutMs ? { timeoutMs: opts.modellTimeoutMs } : {});
      return created;
    },

    /**
     * Startet den Laufzeitkern vom Stick und meldet ihn als ganz gewoehnlichen
     * lokalen Anbieter an.
     *
     * Getrennt von `listen()`, damit ein Test den Vorgang einzeln messen kann,
     * ohne einen HTTP-Server zu brauchen.
     *
     * Was hier NICHT passiert: warten. Ein Modell von einem USB-2-Stick laedt
     * auch mal eine Minute; solange darf der Browser nicht vor einer leeren
     * Seite sitzen. Der Anbieter ist trotzdem sofort angemeldet -- als
     * "noch nicht geprueft", nicht als "erreichbar" -- und der Chat sagt bis
     * dahin ehrlich, dass der Kern noch startet.
     *
     * @param {{timeoutMs?:number, warten?:boolean}} [opts]
     */
    async startLocalRunner(opts = {}) {
      if (!localRunner || typeof localRunner.starten !== 'function') return null;
      let zustand;
      try {
        zustand = await localRunner.starten(opts);
      } catch (err) {
        // starten() ist darauf ausgelegt, nicht zu werfen. Falls es doch
        // einmal tut, faehrt die Anwendung trotzdem hoch -- und sagt es.
        const e = asNeuralError(err);
        failures.push({ subsystem: 'stick-modell', reason: e.message, code: e.code });
        log.error(`Laufzeitkern vom Stick: ${e.message}`);
        return null;
      }

      if (zustand.zustand === 'nicht-vorhanden') {
        // Ein Stick ohne Modell ist der Normalfall, kein Fehler.
        log.debug(zustand.grund || 'Kein Laufzeitkern auf dem Datenträger.');
        return zustand;
      }

      if (zustand.zustand === 'gescheitert') {
        failures.push({ subsystem: 'stick-modell', reason: zustand.grund });
        audit.write('stick.modell.fehler', { grund: String(zustand.grund || '').slice(0, 500) });
        return zustand;
      }

      if (registry && typeof registry.anbieterAnmelden === 'function' && zustand.baseUrl) {
        try {
          registry.anbieterAnmelden({
            id: 'stick',
            kind: zustand.art,
            baseUrl: zustand.baseUrl,
            quelle: 'stick',
            label: `${zustand.modellName || zustand.name} (vom Stick)`,
            hinweis: 'Dieses Modell liegt auf dem Datenträger, von dem Neural OS gerade läuft, '
              + 'und wurde beim Start von dort hochgefahren. Beim ersten Mal dauert das, bis das Modell im Arbeitsspeicher ist.',
          });
        } catch (err) {
          failures.push({ subsystem: 'stick-modell', reason: asNeuralError(err).message });
          log.error(`Der Kern vom Stick läuft, ließ sich aber nicht als Anbieter anmelden: ${err && err.message}`);
          return zustand;
        }
        // Sobald gemessen ist, dass er antwortet, einmal richtig suchen --
        // dann steht im Schnappschuss, welches Modell er wirklich anbietet,
        // statt einer Vermutung aus dem Dateinamen.
        Promise.resolve(localRunner.bereit()).then((fertig) => {
          if (fertig && fertig.zustand === 'laeuft' && registry && typeof registry.refresh === 'function') {
            return registry.refresh({ timeoutMs: 4000 });
          }
          if (fertig && fertig.zustand === 'gescheitert') {
            failures.push({ subsystem: 'stick-modell', reason: fertig.grund });
            log.error(`Laufzeitkern vom Stick: ${String(fertig.grund || '').split('\n')[0]}`);
          }
          return null;
        }).catch((err) => log.warn(`Nachlauf des Stick-Modells: ${err && err.message}`));
      }
      return zustand;
    },

    async close() {
      const problems = [];
      for (const [name, fn] of [
        ['watcher', () => watcher && watcher.stop && watcher.stop()],
        // Auch die, die nur am Bus haengen: ein Abonnement, das ein
        // heruntergefahrenes Teilsystem ueberlebt, arbeitet auf einem Speicher
        // weiter, den gerade jemand schliesst.
        ['history', () => history && history.stop && history.stop()],
        ['scheduler', () => scheduler && scheduler.stop && scheduler.stop()],
        ['triggers', () => triggers && triggers.stop && triggers.stop()],
        ['server', () => app.server && app.server.close()],
        ['modules', () => modules && modules.disposeAll && modules.disposeAll()],
        ['runtime', () => runtime && runtime.abortAll && runtime.abortAll()],
        // Nach `runtime`, damit ein laufender Modellaufruf erst abgebrochen
        // wird und der Kern nicht mitten im Satz wegstirbt -- und vor
        // `store`, weil das Abraeumen selbst noch ins Pruefprotokoll gehoert.
        // Ein verwaister llama-server haelt mehrere Gigabyte fest, bis der
        // fremde Rechner neu startet; das ist der Schaden, den diese Zeile
        // verhindert. Die zweite Sicherung dagegen haengt im Aufseher selbst
        // an process.on('exit') -- fuer den Fall, dass close() nie laeuft.
        ['stick-modell', async () => {
          if (!localRunner || typeof localRunner.stoppen !== 'function') return;
          if (registry && typeof registry.anbieterAbmelden === 'function') registry.anbieterAbmelden('stick');
          await localRunner.stoppen();
        }],
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

  // Jeder Import laeuft durch `bulkWrite`, egal wer ihn aufruft.
  //
  // Der Schutzraum (Einbettungen, Journal und vor allem die Ableitung der
  // Verknuepfungen ruhen, danach EINMAL neu ableiten) sass bisher an den
  // Aufrufstellen: in der Route und im Kommandozeilenbefehl. Gemessen kostete
  // ein Aufruf daneben 19 Kantendubletten -- und eine Zusage, an die sich
  // jeder Aufrufer erinnern muss, ist keine. Deshalb sitzt sie jetzt am
  // Teilsystem selbst. Verschachtelt ist das harmlos: die Zaehler sind
  // Zaehler, `history.suspend` merkt sich seinen vorigen Stand, und die
  // Neuableitung laeuft erst, wenn der aeusserste Vorgang fertig ist -- also
  // genau einmal, und mit dem `onRederive` des aeussersten Aufrufers.
  if (backup && typeof backup.importAll === 'function') {
    const roh = backup.importAll.bind(backup);
    backup.importAll = (opts) => app.bulkWrite(() => roh(opts));
  }

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
      '## Was dir Arbeit abnimmt — auch ganz ohne Modell',
      '',
      'Unter **Vorschläge** drückst du auf „Prüfen". Das System sieht sich deine',
      'Einträge an und findet Dubletten, verwaiste Notizen, Merker wie `- [ ]` im',
      'Text und Verweise, zu denen es noch keine Notiz gibt. **Geschehen tut davon',
      'nichts, bis du auf „Übernehmen" drückst** — und davor steht in klarem Deutsch,',
      'was genau passieren wird. Ein verworfener Vorschlag kommt nie wieder.',
      '',
      'Unter **Automatik** kannst du einen Agenten nach der Uhr laufen lassen oder',
      'auf ein Ereignis reagieren. Beides ist ab Werk aus und bleibt aus, bis du es',
      'einschaltest. Ganz oben steht dort immer, was gerade gilt.',
      '',
      'Beides braucht kein KI-Modell und keine Internetverbindung.',
      '',
      '## Und wenn etwas schiefgeht',
      '',
      'Unter **Zeitachse → Letzte Änderungen** steht jede Änderung mit dem Zustand',
      'davor — und mit der Antwort auf die Frage, die man zuerst stellt: *war ich',
      'das oder ein Agent?* Ein Filter zeigt dir nur das, was **ohne dich** passiert',
      'ist. Zurücknehmen geht von dort aus; wurde der Eintrag seitdem wieder',
      'geändert, wird abgelehnt statt still überschrieben.',
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
