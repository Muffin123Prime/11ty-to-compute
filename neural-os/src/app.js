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
const identitaetMod = require('./kernel/identitaet');
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
 * @param {string} [opts.appDir]      nur für Tests: wo das Programm läge; von dort
 *   sucht `detectPortable` den Marker (Vorgabe: dieser Programmordner)
 */
async function createApp(opts = {}) {
  if (opts.logLevel) setLevel(opts.logLevel);

  const failures = [];
  const paths = pathsMod.ensureLayout(pathsMod.layout(opts.home, { von: opts.appDir }));

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

  // --- welche KI ist das? (Bauplan 2.6) --------------------------------------
  //
  // Vor allem anderen, was die Konfiguration liest: Die Identität kann den
  // Port ändern (ein Stick zieht von 7777 auf seinen eigenen) und, wenn
  // `data/` von einem anderen Stick kopiert wurde, die Kennung samt allem,
  // was die alte KI über Partner wusste. Der Tresor, die Schleuse und der
  // Abgleich sollen schon die richtige KI sehen.
  //
  // Einmal ermittelt und an drei Stellen gebraucht: der Startbanner sagt es,
  // `doctor()`/`/api/status` müssen es sagen können -- sonst kann der Browser
  // nicht einmal erfahren, DASS er von einem Stick läuft --, und die
  // Identität schreibt ihre Kennung in den Marker.
  const portable = pathsMod.portableInfo(paths.home, { von: opts.appDir });
  const herkunft = pathsMod.homeHerkunft(opts.home, { von: opts.appDir });
  const homeHinweis = herkunft.uebergangen && portable
    ? `NEURAL_OS_HOME zeigt auf ${herkunft.uebergangen}, der Stick gewinnt.`
    : null;
  if (homeHinweis) log.warn(homeHinweis);
  const identitaet = identitaetMod.createIdentitaet({
    config, paths, portable, bus,
    speichern: (c) => configMod.save(paths.config, c),
  });
  try {
    identitaet.sicherstellen();
    const marker = identitaet.pruefeMarker();
    if (marker.aktion === 'erneuert') {
      audit.write('ki.erneuert', { grund: 'daten-kopiert' });
      log.warn('Dieser Datenordner kam von einem anderen Stick und ist jetzt eine eigene KI.');
    }
  } catch (err) {
    // Ein Abbruch mitten im Erneuern holt der nächste Start nach (siehe
    // identitaet.erneuern); bis dahin läuft die KI, sagt aber, was fehlt.
    const e = asNeuralError(err);
    failures.push({ subsystem: 'identitaet', reason: e.message, code: e.code });
    log.error(`Identität dieser KI unvollständig: ${e.message}`);
  }

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

  // --- Claude ---------------------------------------------------------------
  //
  // Die KI von Neural OS ist Claude (Anthropic); ein lokales Modell gibt es
  // nicht mehr. Claude sitzt NACH der Schleuse, weil jeder Aufruf durch sie
  // geht, und nach dem Tresor, weil der Schlüssel darin liegt.
  // `konfigSpeichern` wird erst beim Aufruf aufgelöst: `app` gibt es hier
  // noch nicht, gebraucht wird es erst, wenn jemand Claude verbindet.
  // `opts.claudeBasis` ist allein für Tests (ein Statist auf 127.0.0.1).
  const claudeMod = tryRequire('./models/claude');
  const claude = claudeMod
    ? optional(failures, 'claude', () => claudeMod.createClaude({
      paths, config, gate, bus, vaultCrypto, logger,
      basis: opts.claudeBasis,
      konfigSpeichern: (patch) => app.saveConfig(patch),
    }))
    : null;

  // Der kleine gemeinsame Vertrag für alle, die "ein Modell" brauchen
  // (Agenten, zweiter Blick, Vergleich, Erweiterungen) -- jetzt um Claude.
  const registryMod = tryRequire('./models/registry');
  const registry = registryMod
    ? optional(failures, 'registry', () => registryMod.createRegistry({ config, gate, bus, logger, claude }))
    : null;

  const chatMod = tryRequire('./models/chat');
  const chat = chatMod && claude
    ? optional(failures, 'chat', () => chatMod.createChatService({ store, claude, gate, bus, graph, config, logger }))
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

  // --- semantische Suche: entfallen ------------------------------------------
  //
  // Sie brauchte ein lokales Einbettungsmodell (Ollama). Claude berechnet
  // keine Einbettungen, und ein zweiter Online-Dienst nur dafür wäre genau
  // der Schnickschnack, den es nicht geben soll. Die Suche ist Volltext;
  // `ctx.embeddings` bleibt null, und /api/search sagt das ehrlich.
  const vectors = null;
  const embeddings = null;

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
    ? optional(failures, 'sync', () => syncMod.createSync({ store, gate, config, bus, logger, auth: null, paths, identitaet }))
    : null;

  // Koppeln über die sync/-Ordner der Sticks (Bauplan 2.8). Während Sätze
  // eines Partners ankommen, ruht die Ableitung der Verknüpfungen: Sie legte
  // sonst zu jeder Notiz eigene Kanten mit zufälliger ID an, zusätzlich zu
  // denen im Postfach. Danach wird sie EINMAL nachgeholt (wie bulkWrite).
  // `opts.kopplung` nur für Tests: Einhängepunkte, Zeitgeber aus.
  const kopplungMod = tryRequire('./sync/kopplung');
  const kopplung = kopplungMod
    ? optional(failures, 'kopplung', () => kopplungMod.createKopplung({
      store, bus, config, paths, portable, identitaet, vaultCrypto, history, logger, version: VERSION,
      ableitung: {
        async aussetzen(fn) {
          derivationSuspended++;
          try {
            return await fn();
          } finally {
            derivationSuspended = Math.max(0, derivationSuspended - 1);
          }
        },
        nachholen: () => (graph && typeof graph.scanAll === 'function' && derivationSuspended === 0 ? graph.scanAll(store) : null),
      },
      ...(opts.kopplung && typeof opts.kopplung === 'object' ? opts.kopplung : {}),
    }))
    : null;
  if (kopplung && kopplung.automatisch) kopplung.starten();

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

  const app = {
    version: VERSION,
    paths,
    portable,
    /** Eine Zeile für den Startbanner, wenn NEURAL_OS_HOME übergangen wurde; sonst null. */
    homeHinweis,
    identitaet,
    /** Kennung und Name dieser KI, bei jedem Zugriff frisch (nach Umbenennen oder Erneuern). */
    get ki() {
      return { id: identitaet.id, name: identitaet.name };
    },
    config,
    bus,
    audit,
    logger,
    store,
    gate,
    hardening,
    vaultCrypto,
    graph,
    claude,
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
    kopplung,
    failures,
    server: null,

    /**
     * Einen Massenschreibvorgang ausführen: Import, Wiederherstellung.
     *
     * Zwei Dinge werden dabei ausgesetzt, aus zwei verschiedenen Gründen
     * (die Einbettungen, früher ein drittes, gibt es nicht mehr):
     *
     * - **Das Änderungsjournal.** Es ist begrenzt (2000 Einträge). Ein Import
     *   würde es vollständig füllen und damit genau das verdrängen, wofür es
     *   da ist: deine letzten echten Änderungen. Und „einen einzelnen Satz aus
     *   einem Import zurücknehmen" bedeutet ohnehin nichts -- wer einen Import
     *   rückgängig machen will, spielt die vorige Sicherung ein.
     * - **Die Ableitung der Verknüpfungen.** Anders als das Journal ist
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
      if (willAbleiten) derivationSuspended++;
      let ergebnis;
      try {
        ergebnis = history && typeof history.suspend === 'function'
          ? await history.suspend(fn)
          : await fn();
      } finally {
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
        claude: !!claude,
        extraction: !!extract,
        sync: !!sync,
        modules: !!modules,
      };
      // Der Zustand von Claude, wie GET /api/claude ihn zeigt -- ohne Netz.
      let claudeZustand = null;
      if (claude) {
        try {
          const z = claude.zustand();
          claudeZustand = {
            verbunden: z.verbunden, modell: z.modell, schluesselVorhanden: z.schluesselVorhanden,
            gesperrt: z.gesperrt, grund: z.grund, grundCode: z.grundCode, netz: z.netz,
          };
        } catch (err) {
          claudeZustand = { verbunden: false, grund: asNeuralError(err).message };
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
              quelle: p.quelle || 'fern', vomStick: false,
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
        ki: app.ki,
        claude: claudeZustand,
        network: { mode: config.network.mode, hardened: !!hardening, strictAllowlist: config.network.strictAllowlist },
        vault: { ...(store.stats ? store.stats() : {}), encryption: vaultCrypto ? vaultCrypto.state : 'unavailable' },
        subsystems,
        models,
        // Die semantische Suche ist entfallen (siehe oben); der Schlüssel
        // bleibt, damit ältere Leser dieses Berichts eine Antwort bekommen.
        semantic: { available: false, reason: 'Entfallen: die Suche arbeitet mit Volltext.' },
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
      return created;
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
        // Laufende Claude-Antworten abbrechen, bevor der Speicher schließt:
        // der Teiltext wird dann noch als "abgebrochen" gespeichert.
        ['chat', () => chat && chat.abortAll && chat.abortAll()],
        ['kopplung', () => kopplung && kopplung.beenden()],
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

/**
 * Feste Kennung eines Startsatzes: `<typ>_start` + Wort, auf 24 Zeichen
 * aufgefüllt (dasselbe Format wie jede ID, `ID_RE` in schema.js). Kopien aus
 * Konflikten haben 32 Zeichen (Bauplan 2.8), Startsätze fallen also nie
 * darunter.
 */
function startId(typ, wort) {
  return `${typ}_start${wort.padStart(19, '0')}`;
}

/**
 * Die Startinhalte, auf jedem frischen Stick dieselben: gleiche IDs, gleiche
 * Texte, gleiche Kanten. Koppelt man zwei frische Sticks, sind die
 * Einführungen im Abgleich "identisch" statt doppelt vorhanden. Deshalb steht
 * auch kein Pfad im Text: der wäre auf jedem Stick ein anderer.
 */
const START = {
  willkommen: startId('note', 'willk'),
  claude: startId('note', 'claud'),
  projekt: startId('project', 'projekt'),
  aufgabeClaude: startId('task', 'claude'),
  aufgabeGehirn: startId('task', 'gehirn'),
  kanteLink: startId('edge', 'willkclaud'),
  kanteClaude: startId('edge', 'claudeprojekt'),
  kanteGehirn: startId('edge', 'gehirnprojekt'),
};

/**
 * Wartet auf diesem Stick schon Wissen von einem Partner? Dann kommt die
 * Einführung beim ersten Abgleich von dort, mit denselben IDs. Eine eigene
 * wäre bestenfalls überflüssig und, wenn der Partner seine geändert hat,
 * eine zweite Fassung neben seiner.
 *  - `<home>/kopplungen.json`: diese KI ist schon gekoppelt (Paket K1).
 *  - `<Stick>/sync/koppeln/*.angebot`: ein Kopplungsangebot wartet.
 */
async function gekoppeltOderAngeboten(app) {
  try {
    await fsp.access(path.join(app.paths.home, 'kopplungen.json'));
    return true;
  } catch { /* nicht gekoppelt */ }
  if (!app.portable || !app.portable.root) return false;
  try {
    const eintraege = await fsp.readdir(path.join(app.portable.root, 'sync', 'koppeln'));
    return eintraege.some((name) => name.endsWith('.angebot'));
  } catch {
    return false;
  }
}

/** Seed a brand-new vault so the first run is not an empty void. */
async function seedIfEmpty(app) {
  if (app.store.count('note') > 0 || app.store.count('agent') > 0) return false;
  if (await gekoppeltOderAngeboten(app)) return false;

  // Die Reihenfolge ist Absicht. Die Ableitung der Verknüpfungen läuft bei
  // jedem Anlegen mit und vergäbe ihren Kanten zufällige IDs. Deshalb wird
  // jeder Satz angelegt, bevor sein Ziel existiert (die Einführung vor der
  // Notiz, auf die sie verweist; die Aufgaben vor ihrem Projekt), und die
  // Kanten kommen danach mit festen IDs. Sie sind genau die, die die
  // Ableitung selbst zöge; ein späteres "neu ableiten" behält sie.
  app.store.create('note', {
    title: 'Willkommen in Neural OS',
    body: [
      'Dies ist deine eigene KI. Alles, was du hier schreibst, bleibt auf diesem Stick.',
      '',
      '## Wie es funktioniert',
      '',
      '- **Chatten**: Die KI ist Claude. Sie antwortet, sucht im Internet und legt',
      '  Termine, Notizen und Projekte selbst an, wenn du sie im Gespräch nennst.',
      '- **Gedächtnis**: Was du über dich erzählst, merkt sie sich – und weiß es beim',
      '  nächsten Mal noch.',
      '- **Rückgängig**: Alles, was die KI anlegt, lässt sich zurücknehmen.',
      '',
      '## Erste Schritte',
      '',
      '1. Claude verbinden: im Chat oder unter Einstellungen → Claude ([[Claude verbinden]]).',
      '2. Einfach losschreiben.',
      '',
      'Ob Neural OS gerade online ist, steht unten links.',
      '',
      '## Und ohne Internet?',
      '',
      'Notizen, Kalender, Projekte und die Suche funktionieren weiter. Nur die KI',
      'antwortet dann nicht – und sagt das auch, statt etwas zu erfinden.',
      '',
      '#willkommen #anleitung',
    ].join('\n'),
    tags: ['willkommen', 'anleitung'],
    pinned: true,
  }, { id: START.willkommen });

  app.store.create('note', {
    title: 'Claude verbinden',
    body: [
      'Neural OS benutzt Claude von Anthropic. Dafür braucht es einmal einen Schlüssel.',
      '',
      '1. Auf **console.anthropic.com** anmelden und unter „API Keys“ einen Schlüssel erzeugen.',
      '2. Im Chat oder unter **Einstellungen → Claude** den Schlüssel einfügen.',
      '   Er wird sofort mit einer kleinen Anfrage geprüft.',
      '3. Der Schlüssel liegt danach im Tresor auf dem Stick, nicht in einer offenen',
      '   Datei. Ist eine PIN eingerichtet, ist er damit geschützt.',
      '',
      'Jede Antwort kostet bei Anthropic ein wenig Geld. Unter Einstellungen → Claude',
      'steht eine Schätzung, wie viel bisher verbraucht wurde.',
      '',
      '#anleitung',
    ].join('\n'),
    tags: ['anleitung'],
  }, { id: START.claude });

  // Built-in agent templates, deliberately with restrictive defaults. Agenten
  // reisen beim Koppeln nicht mit, ihre IDs dürfen also je Stick verschieden sein.
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

  app.store.create('task', { title: 'Claude verbinden', projectId: START.projekt, priority: 1 }, { id: START.aufgabeClaude });
  app.store.create('task', { title: 'Gehirn ansehen', projectId: START.projekt }, { id: START.aufgabeGehirn });
  app.store.create('project', {
    name: 'Mein erstes Projekt',
    description: 'Ein Platz, um Notizen, Aufgaben und Chats zu einem Vorhaben zu bündeln.',
  }, { id: START.projekt });

  // Wortgleich mit src/graph/derive.js (desiredEdges): weicht der Grund ab,
  // schreibt die nächste Ableitung ihn um, und die Sticks wären verschieden.
  const kante = (id, from, to, kind, reason) => app.store.create('edge', {
    from, to, kind, source: 'derived', reason, weight: 1,
  }, { id });
  kante(START.kanteLink, START.willkommen, START.claude, 'links-to', 'Wiki-Link [[Claude verbinden]] im Text');
  kante(START.kanteClaude, START.aufgabeClaude, START.projekt, 'belongs-to', 'Aufgabe gehoert zu diesem Projekt');
  kante(START.kanteGehirn, START.aufgabeGehirn, START.projekt, 'belongs-to', 'Aufgabe gehoert zu diesem Projekt');

  await app.store.flush();
  return true;
}

/**
 * Zwei Instanzen dürfen nie denselben Tresor öffnen. Dünner Wrapper um den
 * Laufzettel (src/kernel/laufzettel.js, Stick-Bauplan 2.4): Eine Sperre von
 * einem anderen Rechner, einem früheren Start oder einem toten Prozess
 * blockiert nicht mehr; ein laufendes Neural OS schon, mit einem deutschen
 * Satz (LAEUFT_SCHON mit `details.url`, STARTET_SCHON, AELTERE_VERSION).
 * @returns {Promise<() => Promise<void>>} gibt den eigenen Zettel wieder frei
 */
async function acquireLock(paths, felder = {}) {
  const griff = await require('./kernel/laufzettel').anlegen(paths, felder);
  return async () => { griff.freigeben(); };
}

module.exports = { createApp, seedIfEmpty, acquireLock, sanitiseConfig, VERSION };
