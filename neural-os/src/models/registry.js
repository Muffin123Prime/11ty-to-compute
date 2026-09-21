'use strict';

const { NoModelError, ValidationError, asNeuralError } = require('../kernel/errors');
const ollamaProvider = require('./providers/ollama');
const openaiProvider = require('./providers/openai');

/**
 * Model registry (contract section 7).
 *
 * Why this file is shaped the way it is
 * -------------------------------------
 * - `refresh()` is the ONLY place that touches the network; `list()` and
 *   `resolve()` are pure functions over the last snapshot. Resolving a model
 *   happens on every single message, and a resolve that probed would make
 *   every message wait on three TCP connections.
 * - `resolve()` never silently substitutes a model the user explicitly asked
 *   for. It does fall back when nothing was asked for, because "use whatever
 *   is there" is the sensible default — but an explicit wish that cannot be
 *   fulfilled is an error, not a surprise.
 * - The NoModelError message is a product feature, not a log line. It is what
 *   the user sees the first time they open the chat without Ollama installed,
 *   so it names every address that was probed, what came back from each, and
 *   the exact three commands that fix it. Anything less turns a solvable
 *   setup problem into "the app is broken".
 * - API keys never enter the snapshot. `config.models.remote` stores an
 *   `apiKeyEnv` name; the key is read from the environment at call time and
 *   handed to the provider, so `/api/models` cannot leak it.
 * - `anbieterAnmelden()` gibt es, weil ein Laufzeitkern VOM STICK kein
 *   Konfigurationseintrag sein darf: seine Adresse entsteht erst beim Start
 *   (freier Port, siehe models/local-runner.js) und gilt nur für diesen einen
 *   Lauf. Stünde er in `config.json`, zeigte er beim nächsten Start auf einen
 *   Port, hinter dem nichts mehr ist — und der Mensch säße vor einem Eintrag,
 *   den er nie angelegt hat. Angemeldete Anbieter kommen deshalb VOR den
 *   konfigurierten und werden nie gespeichert.
 * - Jeder Eintrag im Schnappschuss sagt, WO er herkommt (`quelle`,
 *   `vomStick`). "127.0.0.1" allein beantwortet die Frage nicht, die der
 *   Besitzer eines Sticks wirklich hat: läuft die KI aus meiner Tasche oder
 *   aus diesem fremden Rechner? Beides ist lokal, und nur eines gehört ihm.
 */

const PROVIDER_MODULES = {
  [ollamaProvider.kind]: ollamaProvider,
  [openaiProvider.kind]: openaiProvider,
};

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Scope used for the registry's own traffic: it belongs to the app, not a chat. */
const REGISTRY_SCOPE = 'global';

const INSTALL_HINT = [
  'So richtest du ein lokales Modell ein:',
  '',
  '  1. Ollama installieren:  https://ollama.com/download',
  '  2. Einmalig ein Modell laden (nur dafür brauchst du kurz Internet):',
  '       ollama pull llama3.2     ~2 GB   – läuft auf fast jedem Rechner',
  '       ollama pull qwen2.5:7b   ~4,7 GB – deutlich stärker, ab 16 GB RAM',
  '  3. Ollama lauscht danach auf 127.0.0.1:11434. Neural OS findet es von allein –',
  '     danach in den Einstellungen auf "Modelle neu suchen" klicken.',
  '',
  'Ebenfalls automatisch erkannt:',
  '  • llama.cpp (llama-server) auf Port 8080',
  '  • LM Studio (im Server-Tab starten) auf Port 1234',
  '',
  'Neural OS erfindet keine Antworten. Ohne Modell bleibt der Chat leer.',
].join('\n');

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

/** Pure, DNS-free loopback test; used only if the gate offers no classify(). */
function isLoopbackHost(host) {
  if (!host) return false;
  let h = String(host).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) return LOOPBACK_V4.test(mapped[1]);
  return LOOPBACK_V4.test(h);
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).hostname;
  } catch {
    return null;
  }
}

/** Ollama treats "llama3.2" and "llama3.2:latest" as the same model. */
function stripLatest(name) {
  return typeof name === 'string' && name.endsWith(':latest') ? name.slice(0, -7) : name;
}

function modelMatches(listed, wanted) {
  if (!listed || typeof wanted !== 'string') return false;
  if (listed.id === wanted || listed.name === wanted) return true;
  const w = stripLatest(wanted);
  return stripLatest(listed.id) === w || stripLatest(listed.name) === w;
}

function padRight(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * @param {{config:object, gate:object, bus?:object, logger?:Function}} deps
 */
function createRegistry({ config, gate, bus, logger } = {}) {
  if (!config || typeof config !== 'object') {
    throw new ValidationError('Die Modell-Registry braucht eine Konfiguration.');
  }
  const log = typeof logger === 'function' ? logger('models') : nullLogger();

  /**
   * Zur Laufzeit angemeldete Anbieter, nach Reihenfolge der Anmeldung.
   * Nicht in der Konfiguration, nie gespeichert — siehe Kopfkommentar.
   * @type {Map<string, object>}
   */
  const angemeldet = new Map();

  /**
   * Read the provider list from config on every access rather than caching it:
   * `app.saveConfig` mutates the same object in place, and a registry that
   * kept a stale copy would keep probing a backend the user just removed.
   */
  function definitions() {
    const out = [];
    const seen = new Set();
    const add = (def) => {
      let id = def.id;
      if (seen.has(id)) {
        log.warn(`Doppelte Anbieter-ID "${id}" in der Konfiguration – die zweite wird ignoriert.`);
        return;
      }
      seen.add(id);
      out.push(def);
    };

    // ZUERST die angemeldeten: `resolve()` ohne Wunsch nimmt den ersten
    // erreichbaren Anbieter, und ein Kern, den der Nutzer in der Tasche
    // mitgebracht hat, ist die bessere Antwort als irgendein Ollama, das auf
    // diesem fremden Rechner zufaellig auch noch laeuft. Ein ausdruecklicher
    // Wunsch (config.models.default) geht trotzdem vor -- der steht weiter
    // unten in resolveWant() und wird hier nicht angetastet.
    for (const def of angemeldet.values()) add(def);

    const local = Array.isArray(config.models && config.models.providers) ? config.models.providers : [];
    for (const p of local) {
      if (!p || typeof p !== 'object' || p.enabled === false) continue;
      if (typeof p.baseUrl !== 'string' || !p.baseUrl) {
        log.warn(`Anbieter "${p.id || p.kind}" hat keine baseUrl und wird übersprungen.`);
        continue;
      }
      add({
        id: String(p.id || p.kind || 'provider'),
        kind: String(p.kind || 'openai'),
        baseUrl: p.baseUrl,
        remote: false,
        apiKeyEnv: null,
        quelle: 'geraet',
      });
    }

    const remote = Array.isArray(config.models && config.models.remote) ? config.models.remote : [];
    for (const r of remote) {
      if (!r || typeof r !== 'object' || r.enabled === false) continue;
      if (typeof r.baseUrl !== 'string' || !r.baseUrl) {
        log.warn(`Ferner Anbieter "${r.id || 'ohne ID'}" hat keine baseUrl und wird übersprungen.`);
        continue;
      }
      add({
        id: String(r.id || 'remote'),
        kind: String(r.kind || 'openai'),
        baseUrl: r.baseUrl,
        remote: true,
        apiKeyEnv: typeof r.apiKeyEnv === 'string' && r.apiKeyEnv ? r.apiKeyEnv : null,
        quelle: 'fern',
      });
    }
    return out;
  }

  /** Resolve the key at call time; it is never stored or published. */
  function apiKeyFor(def) {
    if (!def || !def.remote) return null;
    if (def.apiKeyEnv) {
      const value = process.env[def.apiKeyEnv];
      return typeof value === 'string' && value ? value : null;
    }
    const remote = Array.isArray(config.models && config.models.remote) ? config.models.remote : [];
    const entry = remote.find((r) => r && String(r.id || 'remote') === def.id);
    return entry && typeof entry.apiKey === 'string' && entry.apiKey ? entry.apiKey : null;
  }

  /**
   * Die Herkunftsfelder, die JEDER Schnappschuss-Eintrag trägt.
   *
   * An einer Stelle, weil `unprobed()` und `probeOne()` sonst
   * auseinanderlaufen: einmal stünde "vom Stick" da und nach der ersten
   * Prüfung nicht mehr — die Anzeige würde beim Suchen umspringen.
   */
  function herkunft(def) {
    const quelle = def.quelle || (def.remote ? 'fern' : 'geraet');
    return {
      quelle,
      vomStick: quelle === 'stick',
      label: def.label || def.id,
      hinweis: def.hinweis || null,
    };
  }

  function unprobed(def) {
    return {
      id: def.id,
      kind: def.kind,
      baseUrl: def.baseUrl,
      remote: !!def.remote,
      hasApiKey: !!apiKeyFor(def),
      ...herkunft(def),
      available: false,
      models: [],
      error: 'Noch nicht geprüft.',
      latencyMs: null,
      probedAt: null,
    };
  }

  /** @type {{providers:Array, at:string|null}} */
  let snapshot = { providers: definitions().map(unprobed), at: null };
  /** Concurrent refreshes share one round of probes instead of stacking up. */
  let inFlight = null;

  /**
   * Woher der Anbieter kommt, gehört in dieselbe Zeile: "127.0.0.1:41233"
   * sagt einem Menschen nicht, ob das sein eigener Stick ist oder irgendein
   * Dienst auf dem fremden Rechner, in dem der Stick gerade steckt.
   */
  function anbieterZeile(p) {
    return `  • ${padRight(p.id, 12)} ${p.baseUrl}${p.vomStick ? ' [vom Stick]' : ''}`;
  }

  function describeProbe(p) {
    const woher = p.vomStick ? ' [vom Stick]' : '';
    const head = anbieterZeile(p);
    const nachsatz = !p.available && p.hinweis ? `\n      ${p.hinweis}` : '';
    if (p.available && (!p.models || p.models.length === 0)) return `${head} – erreichbar, aber kein Modell installiert`;
    if (p.available) return `${head} – erreichbar (${p.models.length} Modell${p.models.length === 1 ? '' : 'e'})`;
    const detail = p.error || 'nicht erreichbar';
    // The provider error already names the exact endpoint it tried; printing
    // the base address in front of it would say the same thing twice.
    if (detail.includes(p.baseUrl)) return `  • ${padRight(p.id, 12)} ${detail}${woher}${nachsatz}`;
    return `${head} – ${detail}${nachsatz}`;
  }

  /**
   * The message the user actually reads when nothing works. It must answer
   * three questions: what was tried, what came back, and what to do now.
   */
  function noModelMessage(headline) {
    const snap = snapshot;
    const providers = snap.providers || [];
    const parts = [headline || 'Es ist kein Modell verfügbar.', ''];

    if (!providers.length) {
      parts.push('Es ist überhaupt kein Modellanbieter konfiguriert (models.providers ist leer).');
    } else if (snap.at === null) {
      parts.push('Die Modellanbieter wurden in dieser Sitzung noch nicht geprüft. Konfiguriert sind:');
      for (const p of providers) parts.push(anbieterZeile(p));
    } else {
      parts.push(`Geprüft am ${snap.at}:`);
      for (const p of providers) parts.push(describeProbe(p));
    }

    const running = providers.filter((p) => p.available && (!p.models || p.models.length === 0));
    if (running.length) {
      parts.push('');
      for (const p of running) {
        const what = p.kind === 'ollama'
          ? 'Lade eines:  ollama pull llama3.2'
          : 'Lade im Server-Programm ein Modell und starte den Server neu.';
        parts.push(`Der Anbieter "${p.id}" läuft unter ${p.baseUrl}, hat aber kein Modell geladen. ${what}`);
      }
    }

    parts.push('', INSTALL_HINT);
    return parts.join('\n');
  }

  function noModelError(headline, details) {
    return new NoModelError(noModelMessage(headline), {
      probed: (snapshot.providers || []).map((p) => ({
        id: p.id, kind: p.kind, baseUrl: p.baseUrl, available: p.available, error: p.error,
        models: (p.models || []).map((m) => m.id),
      })),
      at: snapshot.at,
      ...(details || {}),
    });
  }

  async function probeOne(def, { timeoutMs, signal }) {
    const mod = PROVIDER_MODULES[def.kind];
    const base = {
      id: def.id,
      kind: def.kind,
      baseUrl: def.baseUrl,
      remote: !!def.remote,
      hasApiKey: !!apiKeyFor(def),
      ...herkunft(def),
      probedAt: new Date().toISOString(),
    };
    if (!mod) {
      return { ...base, available: false, models: [], error: `Unbekannter Anbietertyp "${def.kind}".`, latencyMs: null };
    }
    try {
      const result = await mod.probe({
        baseUrl: def.baseUrl,
        gate,
        scope: REGISTRY_SCOPE,
        purpose: `Modelle bei "${def.id}" suchen`,
        signal,
        timeoutMs,
        apiKey: apiKeyFor(def),
      });
      return {
        ...base,
        available: !!(result && result.available),
        models: Array.isArray(result && result.models) ? result.models : [],
        error: (result && result.error) || null,
        code: (result && result.code) || null,
        latencyMs: Number.isFinite(result && result.latencyMs) ? result.latencyMs : null,
      };
    } catch (err) {
      // probe() is contracted not to throw; if one ever does, one broken
      // backend must still not take down the whole refresh.
      const e = asNeuralError(err);
      log.warn(`Probe von "${def.id}" ist fehlgeschlagen: ${e.message}`);
      return { ...base, available: false, models: [], error: e.message, code: e.code || null, latencyMs: null };
    }
  }

  async function doRefresh({ timeoutMs = 1500, signal } = {}) {
    const defs = definitions();
    const providers = await Promise.all(defs.map((def) => probeOne(def, { timeoutMs, signal })));
    snapshot = { providers, at: new Date().toISOString() };
    const reachable = providers.filter((p) => p.available);
    log.info(`${reachable.length}/${providers.length} Modellanbieter erreichbar, ${reachable.reduce((n, p) => n + p.models.length, 0)} Modell(e)`);
    if (bus && typeof bus.publish === 'function') {
      bus.publish('models.changed', { providers, at: snapshot.at });
    }
    return snapshot;
  }

  function parseRef(ref) {
    if (ref === null || ref === undefined) return { provider: null, model: null };
    if (typeof ref === 'string') {
      const s = ref.trim();
      if (!s) return { provider: null, model: null };
      const slash = s.indexOf('/');
      if (slash > 0) {
        const head = s.slice(0, slash);
        const tail = s.slice(slash + 1);
        // Model ids can contain slashes themselves (e.g. hf.co/user/model), so
        // the head only counts as a provider when it actually names one.
        if (tail && (snapshot.providers || []).some((p) => p.id.toLowerCase() === head.toLowerCase())) {
          return { provider: head, model: tail };
        }
      }
      return { provider: null, model: s };
    }
    if (typeof ref === 'object') {
      const provider = typeof ref.provider === 'string' && ref.provider ? ref.provider : null;
      const model = typeof ref.model === 'string' && ref.model ? ref.model : null;
      return { provider, model };
    }
    throw new ValidationError(`Ungültige Modellangabe vom Typ ${typeof ref}.`);
  }

  function targetFor(entry, model) {
    const def = definitions().find((d) => d.id === entry.id);
    const target = {
      providerId: entry.id,
      kind: entry.kind,
      baseUrl: entry.baseUrl,
      model,
      // Wandert bis in den Chat-Satz durch: die Antwort muss sagen können,
      // aus wessen Gerät sie kam.
      quelle: entry.quelle || (entry.remote ? 'fern' : 'geraet'),
      vomStick: !!entry.vomStick,
    };
    const key = def ? apiKeyFor(def) : null;
    if (key) target.apiKey = key;
    return target;
  }

  function configuredDefault() {
    const d = config.models && config.models.default;
    if (!d) return null;
    if (typeof d === 'string') return parseRef(d);
    if (typeof d === 'object') {
      const provider = typeof d.provider === 'string' && d.provider ? d.provider : null;
      const model = typeof d.model === 'string' && d.model ? d.model : null;
      if (!provider && !model) return null;
      return { provider, model };
    }
    return null;
  }

  function resolveWant(want, allowDefault) {
    const providers = snapshot.providers || [];
    let candidates = providers;

    if (want.provider) {
      const needle = want.provider.toLowerCase();
      candidates = providers.filter((p) => p.id.toLowerCase() === needle);
      if (!candidates.length) candidates = providers.filter((p) => p.kind.toLowerCase() === needle);
      if (!candidates.length) {
        const known = providers.map((p) => p.id).join(', ') || '(keiner)';
        throw noModelError(
          `Der Modellanbieter "${want.provider}" ist nicht konfiguriert. Konfiguriert sind: ${known}.`,
          { wanted: want },
        );
      }
    }

    if (want.model) {
      for (const p of candidates) {
        if (!p.available) continue;
        const hit = (p.models || []).find((m) => modelMatches(m, want.model));
        if (hit) return targetFor(p, hit.id);
      }
      // Some llama.cpp builds serve a model without listing it. If such a
      // backend is up we pass the name through and let it answer honestly.
      const blind = candidates.find((p) => p.available && (!p.models || p.models.length === 0));
      if (blind) return targetFor(blind, want.model);
      throw noModelError(`Das Modell "${want.model}" ist derzeit nicht verfügbar.`, { wanted: want });
    }

    if (allowDefault) {
      const preferred = configuredDefault();
      if (preferred && (preferred.provider || preferred.model)) {
        try {
          return resolveWant({ provider: want.provider || preferred.provider, model: preferred.model }, false);
        } catch {
          // The configured default is gone. Falling back is better than
          // failing, and the answer records which model really ran.
          log.warn('Das voreingestellte Modell ist nicht verfügbar – es wird das erste erreichbare genutzt.');
        }
      }
    }

    for (const p of candidates) {
      if (p.available && Array.isArray(p.models) && p.models.length) return targetFor(p, p.models[0].id);
    }
    throw noModelError(null, { wanted: want });
  }

  const registry = {
    /**
     * Probe every enabled provider in parallel and publish the result.
     * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts]
     */
    async refresh(opts = {}) {
      if (inFlight) return inFlight;
      inFlight = doRefresh(opts).finally(() => { inFlight = null; });
      return inFlight;
    },

    /** The last snapshot. Never probes — callers that want fresh data refresh. */
    list() {
      return snapshot;
    },

    /**
     * Einen Anbieter für DIESEN Lauf anmelden — nicht speichern.
     *
     * Gedacht für den Laufzeitkern vom Stick (src/models/local-runner.js):
     * seine Adresse entsteht beim Start und gilt nur solange der Prozess
     * lebt. Angemeldete Anbieter stehen vor den konfigurierten, tauchen
     * sofort im Schnappschuss auf (als "noch nicht geprüft", nicht als
     * "erreichbar" — behauptet wird hier nichts) und verschwinden mit
     * `anbieterAbmelden()` wieder.
     *
     * @param {{id:string, kind:string, baseUrl:string, label?:string,
     *          quelle?:string, hinweis?:string}} def
     */
    anbieterAnmelden(def) {
      if (!def || typeof def !== 'object') throw new ValidationError('Ein Anbieter braucht eine Beschreibung.');
      const id = String(def.id || '').trim();
      if (!id) throw new ValidationError('Ein angemeldeter Anbieter braucht eine Kennung (id).');
      const kind = String(def.kind || '').trim();
      if (!PROVIDER_MODULES[kind]) {
        throw new ValidationError(`Für den Anbietertyp "${kind}" gibt es keine Anbindung. Möglich: ${Object.keys(PROVIDER_MODULES).join(', ')}.`);
      }
      if (typeof def.baseUrl !== 'string' || !def.baseUrl.trim()) {
        throw new ValidationError(`Der Anbieter "${id}" hat keine Adresse (baseUrl).`);
      }
      const eintrag = {
        id,
        kind,
        baseUrl: def.baseUrl.trim(),
        remote: false,
        apiKeyEnv: null,
        quelle: def.quelle ? String(def.quelle) : 'stick',
        label: def.label ? String(def.label) : id,
        hinweis: def.hinweis ? String(def.hinweis) : null,
      };
      angemeldet.set(id, eintrag);
      // Sofort sichtbar machen, ohne zu prüfen: ein Schnappschuss, in dem der
      // Anbieter erst nach dem nächsten refresh() auftaucht, lässt die Anzeige
      // behaupten, es gäbe ihn nicht.
      const rest = (snapshot.providers || []).filter((p) => p.id !== id);
      snapshot = { providers: [unprobed(eintrag), ...rest], at: snapshot.at };
      if (bus && typeof bus.publish === 'function') {
        bus.publish('models.changed', { providers: snapshot.providers, at: snapshot.at });
      }
      log.info(`Anbieter "${id}" für diesen Lauf angemeldet: ${eintrag.baseUrl} (${eintrag.quelle}).`);
      return eintrag;
    },

    /** Einen angemeldeten Anbieter wieder entfernen. */
    anbieterAbmelden(id) {
      const key = String(id || '');
      if (!angemeldet.delete(key)) return false;
      snapshot = { providers: (snapshot.providers || []).filter((p) => p.id !== key), at: snapshot.at };
      if (bus && typeof bus.publish === 'function') {
        bus.publish('models.changed', { providers: snapshot.providers, at: snapshot.at });
      }
      log.info(`Anbieter "${key}" abgemeldet.`);
      return true;
    },

    /**
     * @param {null|string|{provider?:string, model?:string}} ref
     * @returns {{providerId:string, kind:string, baseUrl:string, model:string, apiKey?:string}}
     */
    resolve(ref) {
      return resolveWant(parseRef(ref), true);
    },

    /** True when the resolved backend is on this machine. */
    isOffline(ref) {
      const target = registry.resolve(ref);
      const host = hostOf(target.baseUrl);
      if (!host) return false;
      if (gate && typeof gate.classify === 'function') {
        try {
          return gate.classify(host) === 'loopback';
        } catch {
          /* fall through to the local check */
        }
      }
      return isLoopbackHost(host);
    },

    /**
     * Run a chat completion on the resolved backend.
     * @param {*} ref
     * @param {{messages:Array, options?:object, tools?:Array, scope?:string,
     *          signal?:AbortSignal, onDelta?:Function, purpose?:string,
     *          timeoutMs?:number, idleTimeoutMs?:number}} opts
     */
    async chat(ref, opts = {}) {
      const target = registry.resolve(ref);
      const mod = PROVIDER_MODULES[target.kind];
      if (!mod) throw noModelError(`Für den Anbietertyp "${target.kind}" gibt es keine Anbindung.`);
      const result = await mod.chat({
        baseUrl: target.baseUrl,
        model: target.model,
        apiKey: target.apiKey,
        messages: opts.messages,
        options: opts.options || {},
        tools: opts.tools,
        gate,
        scope: opts.scope || REGISTRY_SCOPE,
        purpose: opts.purpose || `Antwort des Modells ${target.model}`,
        signal: opts.signal,
        onDelta: opts.onDelta,
        timeoutMs: opts.timeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs,
      });
      // Provenance the chat service records verbatim: which backend really answered.
      return {
        ...result,
        provider: target.providerId,
        kind: target.kind,
        model: target.model,
        quelle: target.quelle,
        vomStick: target.vomStick,
      };
    },

    /** Embeddings on the resolved backend. Not every backend offers them. */
    async embed(ref, opts = {}) {
      const target = registry.resolve(ref);
      const mod = PROVIDER_MODULES[target.kind];
      if (!mod || typeof mod.embed !== 'function') {
        throw noModelError(`Der Anbietertyp "${target.kind}" kann keine Einbettungen berechnen.`);
      }
      return mod.embed({
        baseUrl: target.baseUrl,
        model: target.model,
        apiKey: target.apiKey,
        input: opts.input,
        gate,
        scope: opts.scope || REGISTRY_SCOPE,
        purpose: opts.purpose || `Einbettungen mit ${target.model}`,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      });
    },

    /** The German setup instructions, so the UI can show them without an error. */
    installHint() {
      return INSTALL_HINT;
    },

    /** The full diagnostic text, identical to what a NoModelError would carry. */
    explain(headline) {
      return noModelMessage(headline);
    },
  };

  return registry;
}

module.exports = {
  createRegistry,
  INSTALL_HINT,
  /** Exposed for tests only. */
  __internals: { isLoopbackHost, modelMatches, stripLatest },
};
