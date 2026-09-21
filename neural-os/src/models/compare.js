'use strict';

/**
 * Zwei Modelle, eine Antwort -- the side-by-side comparison (IDEEN.md #6).
 *
 * The point of this feature is an honest argument for running locally: not the
 * claim that the local model is as good, but the chance to see for yourself.
 * That argument is only worth anything if the machinery underneath it is
 * itself honest, which is what the four decisions below are about.
 *
 * 1. **`plan()` connects to nothing.** It answers "what WOULD happen" from the
 *    registry's last snapshot and from the gate's pure policy decision
 *    (`record: false`, no DNS, no socket). It exists so the interface can say
 *    "Seite B verlässt dieses Gerät" BEFORE anyone presses send. A comparison
 *    against an online provider ships the user's question to a stranger; that
 *    must be a decision someone takes, never something that merely happens.
 *
 * 2. **One side failing does not silence the other.** Both sides run in
 *    parallel and each one catches its own failure, so the result always has
 *    both slots filled: the side that worked carries its text, the side that
 *    did not carries its real, typed error. The one thing this module must
 *    never do is present one answer as if it were two -- that would turn a
 *    comparison into a fabrication.
 *
 * 3. **Nothing is invented when nothing is available.** If neither side can
 *    even resolve a model, the caller gets the registry's own `NoModelError`
 *    -- with the setup instructions it already writes for the chat -- instead
 *    of an empty pair of boxes.
 *
 * 4. **`usedNetwork` is observed, not configured.** Each side runs under its
 *    own scope token and the `network.attempt` events the gate publishes are
 *    filtered by that token, exactly as `watchNetwork()` in agents/runtime.js
 *    does for a run. What was configured is irrelevant; what the gate actually
 *    allowed is the truth. Loopback is recorded as a target but never counts
 *    as network use: this machine talking to itself is what offline means.
 *
 * A comparison writes nothing to the vault on its own. `save()` exists so a
 * result can be kept as a note, and it is only ever called because somebody
 * pressed a button.
 */

const {
  ValidationError,
  NotFoundError,
  NoModelError,
  AbortedError,
  asNeuralError,
} = require('../kernel/errors');

/* ------------------------------------------------------------- constants */

/** Hard ceiling on one question, mirroring src/models/chat.js. */
const MAX_PROMPT_CHARS = 200000;

/**
 * Where a backend lives, derived from the gate's classification of its host.
 *
 * `unknown` deliberately does NOT become `online`. A name that has not been
 * resolved could be `api.openai.com` or `nas.fritz.box`, and guessing either
 * way would be a lie in one of the two directions. What IS certain about a
 * non-loopback host is that it is not this machine, and that is what the
 * interface needs in order to warn.
 */
const PLACE_BY_CLASS = {
  loopback: 'lokal',
  private: 'lan',
  public: 'online',
  unknown: 'unbekannt',
};

const PLACE_LABEL = {
  lokal: 'auf diesem Gerät',
  lan: 'im lokalen Netz',
  online: 'im öffentlichen Internet',
  unbekannt: 'auf einem Rechner, der noch nicht bestimmt ist',
};

const SIDES = ['a', 'b'];

/* --------------------------------------------------------------- helpers */

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).hostname;
  } catch {
    return null;
  }
}

/** Host including a non-default port, for a sentence a person has to read. */
function displayHostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).host;
  } catch {
    return String(baseUrl || '');
  }
}

function portOf(baseUrl) {
  try {
    const url = new URL(String(baseUrl));
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/** How the caller named a model, in one string, for display and for the record. */
function refLabel(ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object') {
    const provider = typeof ref.provider === 'string' ? ref.provider : '';
    const model = typeof ref.model === 'string' ? ref.model : '';
    if (provider && model) return `${provider}/${model}`;
    return model || provider || null;
  }
  return null;
}

function errorShape(err) {
  const neural = asNeuralError(err);
  return { code: neural.code, message: neural.message };
}

/** Random enough to tell two concurrent comparisons apart in the bus traffic. */
function runToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ----------------------------------------------------------------- module */

/**
 * @param {{registry:object, gate?:object, store?:object, bus?:object,
 *          config?:object, logger?:Function}} deps
 */
function createCompare(deps = {}) {
  const registry = deps.registry;
  if (!registry || typeof registry.resolve !== 'function') {
    throw new ValidationError('Der Modellvergleich braucht eine Modell-Registry.');
  }
  const gate = deps.gate || null;
  const store = deps.store || null;
  const bus = deps.bus || null;
  const cfg = deps.config || {};
  const log = typeof deps.logger === 'function' ? deps.logger('compare') : (deps.logger || nullLogger());

  /* ------------------------------------------------------------- scopes */

  /**
   * The scope a comparison belongs to: the conversation it was started in.
   * A grant the user made for THIS chat applies here too -- a comparison
   * inside a chat is part of that chat, not a way around its policy.
   */
  function chatScope(chatId) {
    return chatId ? `chat:${chatId}` : 'global';
  }

  /**
   * The scope one SIDE runs under: the chat's scope plus a token that tells
   * the two sides apart in the gate's event stream. No grant is ever written
   * for a `vergleich:` token, so the chain it produces is the chat's chain
   * plus a link nothing matches -- the verdict is identical to `chatScope()`.
   *
   * `plan()` therefore asks the gate with the plain chat scope: the gate
   * quotes the scope back in its refusal, and a sentence the user reads before
   * pressing send should not end in an internal token.
   */
  function sideScope(chatId, token, side) {
    const parts = [];
    if (chatId) parts.push(`chat:${chatId}`);
    parts.push(`vergleich:${token}:${side}`);
    return parts.join(' ');
  }

  /* ------------------------------------------------------- observation */

  /**
   * Watch what the gate really permitted for one side.
   *
   * Same shape as `watchEgress()` in models/chat.js, with the token filter of
   * `watchNetwork()` in agents/runtime.js, because here two requests share one
   * bus and the scope string is the only thing that tells them apart.
   */
  function watchSide(token) {
    const targets = new Map();
    const state = {
      usedNetwork: false,
      targets,
      /** False when there is no bus: then nothing could be observed at all. */
      beobachtet: !!(bus && typeof bus.on === 'function'),
    };
    if (!state.beobachtet) {
      log.warn('Ohne Event-Bus lässt sich die Netz-Herkunft der Antworten nicht beobachten.');
      return { state, stop() {} };
    }
    const handler = (evt) => {
      const p = evt && evt.payload;
      if (!p || p.allowed !== true) return;
      const tokens = String(p.scope || '').split(/[\s,|]+/).filter(Boolean);
      if (!tokens.includes(token)) return;
      const host = p.host || p.ip;
      if (!host) return;
      targets.set(p.port ? `${host}:${p.port}` : String(host), p.classification || 'unknown');
      if (p.classification && p.classification !== 'loopback') state.usedNetwork = true;
    };
    bus.on('network.attempt', handler);
    let stopped = false;
    return {
      state,
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          bus.off('network.attempt', handler);
        } catch { /* already detached */ }
      },
    };
  }

  /* -------------------------------------------------------------- policy */

  /** The gate's verdict for a host, as pure policy: no DNS, nothing audited. */
  function gateVerdict(host, port, scope) {
    if (!gate || typeof gate.check !== 'function') {
      return {
        erlaubt: null,
        grund: 'Die Netz-Schleuse ist in dieser Instanz nicht verfügbar; was erlaubt wäre, ist damit unbekannt.',
        klassifikation: null,
      };
    }
    try {
      const decision = gate.check({
        host,
        port,
        scope,
        purpose: 'compare.plan',
        record: false,
      });
      return {
        erlaubt: decision.allowed === true,
        grund: decision.reason || '',
        klassifikation: decision.classification || null,
      };
    } catch (err) {
      return { erlaubt: null, grund: asNeuralError(err).message, klassifikation: null };
    }
  }

  function classifyHost(host) {
    if (gate && typeof gate.classify === 'function') {
      try {
        return gate.classify(host);
      } catch { /* fall through */ }
    }
    return null;
  }

  /** Has the registry's last probe seen this provider up? Never probes. */
  function providerSnapshot(providerId) {
    if (typeof registry.list !== 'function') return null;
    let snapshot;
    try {
      snapshot = registry.list();
    } catch {
      return null;
    }
    const providers = (snapshot && snapshot.providers) || [];
    const entry = providers.find((p) => p && p.id === providerId) || null;
    return { entry, at: (snapshot && snapshot.at) || null };
  }

  /**
   * One side of the plan. Everything in here is derived or remembered --
   * nothing in this function opens a connection.
   */
  function planSide(side, ref, chatId, token) {
    const scope = sideScope(chatId, token, side);
    const base = {
      seite: side,
      ref: refLabel(ref),
      modell: null,
      erreichbar: false,
      ort: 'unbekannt',
      gate: { erlaubt: null, grund: '', klassifikation: null },
      verlaesstGeraet: false,
      hinweis: '',
      fehler: null,
      scope,
    };

    let target;
    try {
      target = registry.resolve(ref === undefined ? null : ref);
    } catch (err) {
      const neural = asNeuralError(err);
      return {
        ...base,
        fehler: errorShape(neural),
        hinweis: `Für diese Seite ist kein Modell verfügbar: ${neural.message.split('\n')[0]}`,
      };
    }

    const host = hostOf(target.baseUrl);
    const shown = displayHostOf(target.baseUrl);
    const port = portOf(target.baseUrl);
    const verdict = gateVerdict(host, port, chatScope(chatId));
    const classification = verdict.klassifikation || classifyHost(host);
    const ort = PLACE_BY_CLASS[classification] || 'unbekannt';
    const verlaesstGeraet = ort !== 'lokal';

    const snap = providerSnapshot(target.providerId);
    const probe = snap && snap.entry;
    const probed = !!(snap && snap.at);
    // A backend the gate would refuse is not reachable, whatever the last
    // probe said -- and an unprobed one is not known to be reachable either.
    const gateOk = verdict.erlaubt !== false;
    const erreichbar = !!(probe && probe.available) && gateOk;

    const hinweise = [];
    hinweise.push(
      verlaesstGeraet
        ? `${target.model} läuft auf ${shown} — das ist nicht dieses Gerät. Deine Frage und der mitgeschickte Zusammenhang verlassen damit diesen Rechner.`
        : `${target.model} läuft auf diesem Gerät (${shown}). Es geht nichts nach draußen.`,
    );
    if (verdict.erlaubt === false) {
      hinweise.push(`Die Netz-Schleuse würde das derzeit sperren: ${verdict.grund}`);
    } else if (verdict.erlaubt === null) {
      hinweise.push(verdict.grund);
    }
    if (!probed) {
      hinweise.push('Die Modellanbieter wurden in dieser Sitzung noch nicht geprüft; ob dieses Backend wirklich läuft, ist offen.');
    } else if (probe && !probe.available) {
      hinweise.push(`Beim letzten Suchlauf war dieses Backend nicht erreichbar: ${probe.error || 'kein Grund gemeldet'}.`);
    } else if (!probe) {
      hinweise.push(`Der Anbieter "${target.providerId}" kam im letzten Suchlauf nicht vor.`);
    }

    return {
      ...base,
      modell: {
        provider: target.providerId,
        model: target.model,
        kind: target.kind,
        baseUrl: target.baseUrl,
        host: shown,
      },
      erreichbar,
      ort,
      gate: verdict,
      verlaesstGeraet,
      hinweis: hinweise.join(' '),
      geprueftAm: (snap && snap.at) || null,
    };
  }

  /**
   * What a comparison WOULD do. Connects nothing, resolves no name, writes no
   * audit entry -- asking about policy is not an attempt to leave the machine.
   *
   * @param {{chatId?:string, a?:*, b?:*}} opts
   */
  async function plan(opts = {}) {
    const chatId = opts.chatId === undefined || opts.chatId === null ? null : String(opts.chatId);
    if (chatId && store && typeof store.get === 'function') {
      const record = store.get(chatId);
      if (!record || record.type !== 'chat') throw new NotFoundError(`Chat ${chatId}`);
    }
    const token = runToken();
    const a = planSide('a', opts.a, chatId, token);
    const b = planSide('b', opts.b, chatId, token);

    const verlaesst = [a, b].filter((side) => side.modell && side.verlaesstGeraet);
    const gesperrt = [a, b].filter((side) => side.gate && side.gate.erlaubt === false);

    const saetze = [];
    if (verlaesst.length) {
      for (const side of verlaesst) {
        saetze.push(`Seite ${side.seite.toUpperCase()} geht an ${side.modell.host}. Deine Frage und der mitgeschickte Zusammenhang verlassen damit dieses Gerät.`);
      }
    } else if (a.modell && b.modell) {
      saetze.push('Beide Seiten laufen auf diesem Gerät. Es verlässt nichts deinen Rechner.');
    }
    if (gesperrt.length) {
      saetze.push(`${gesperrt.length === 1 ? 'Eine Seite ist' : 'Beide Seiten sind'} derzeit von der Netz-Schleuse gesperrt und würde${gesperrt.length === 1 ? '' : 'n'} mit einem Fehler enden, nicht mit einer Antwort.`);
    }
    if (a.modell && b.modell
      && a.modell.provider === b.modell.provider && a.modell.model === b.modell.model) {
      saetze.push('Beide Seiten zeigen auf dasselbe Modell — der Vergleich zeigt dann nur, wie verschieden dasselbe Modell zweimal antwortet.');
    }
    if (!a.modell && !b.modell) {
      saetze.push('Es ist auf keiner der beiden Seiten ein Modell verfügbar. Der Vergleich würde nichts liefern.');
    }

    return {
      chatId,
      token,
      a,
      b,
      verlaesstGeraet: verlaesst.length > 0,
      zustimmungNoetig: verlaesst.length > 0,
      hinweis: saetze.join(' '),
    };
  }

  /* ----------------------------------------------------------------- run */

  /**
   * The registry's own "nothing is installed" message, so the comparison tells
   * the same story as the chat instead of inventing a second one.
   */
  function noModelError(headline, details) {
    if (typeof registry.explain === 'function') {
      try {
        return new NoModelError(registry.explain(headline), details);
      } catch { /* fall through to the plain headline */ }
    }
    return new NoModelError(headline, details);
  }

  /** Run one side. Never throws: its failure is part of its result. */
  async function runSide(side, ref, planned, ctxRun) {
    const started = Date.now();
    const token = `vergleich:${ctxRun.token}:${side}`;
    const watcher = watchSide(token);
    const base = {
      seite: side,
      ref: refLabel(ref),
      text: '',
      model: planned.modell ? { provider: planned.modell.provider, model: planned.modell.model } : null,
      ort: planned.ort,
      usedNetwork: false,
      networkTargets: [],
      netzBeobachtet: watcher.state.beobachtet,
      ms: 0,
      tokens: null,
      fehler: null,
      abgebrochen: false,
    };

    // Nothing to send to: report the resolution failure as itself.
    if (!planned.modell) {
      watcher.stop();
      return { ...base, ms: Date.now() - started, fehler: planned.fehler || { code: 'NO_MODEL_AVAILABLE', message: 'Für diese Seite ist kein Modell verfügbar.' } };
    }

    let text = '';
    const onDelta = (chunk) => {
      if (typeof chunk !== 'string' || !chunk.length) return;
      text += chunk;
      if (typeof ctxRun.onDelta === 'function') {
        try {
          ctxRun.onDelta({ seite: side, text: chunk });
        } catch (err) {
          // A caller's handler must not kill a model call that is already
          // running and already costing this machine its CPU.
          log.warn(`onDelta-Handler der Seite ${side} hat geworfen: ${err && err.message}`);
        }
      }
    };

    try {
      const result = await registry.chat(ref === undefined ? null : ref, {
        messages: ctxRun.messages,
        options: ctxRun.options,
        scope: planned.scope,
        purpose: `Modellvergleich, Seite ${side.toUpperCase()}`,
        signal: ctxRun.signal,
        onDelta,
        timeoutMs: ctxRun.timeoutMs,
        idleTimeoutMs: ctxRun.idleTimeoutMs,
      });
      watcher.stop();
      // A non-streaming backend delivers everything at the end; a streaming
      // one already did. Only trust the final content when nothing streamed,
      // so a provider that repeats itself cannot double the answer.
      if (!text && result && typeof result.content === 'string' && result.content) {
        onDelta(result.content);
      }
      const stats = (result && result.stats) || {};
      return {
        ...base,
        text,
        model: {
          provider: (result && result.provider) || planned.modell.provider,
          model: (result && result.model) || planned.modell.model,
        },
        ort: observedPlace(planned.ort, watcher.state),
        usedNetwork: watcher.state.usedNetwork,
        networkTargets: [...watcher.state.targets.keys()],
        netzBeobachtet: watcher.state.beobachtet,
        ms: Date.now() - started,
        tokens: {
          prompt: Number.isFinite(stats.promptTokens) ? stats.promptTokens : null,
          completion: Number.isFinite(stats.completionTokens) ? stats.completionTokens : null,
        },
      };
    } catch (err) {
      watcher.stop();
      const aborted = (ctxRun.signal && ctxRun.signal.aborted)
        || err instanceof AbortedError
        || (err && err.name === 'AbortError');
      const neural = aborted ? new AbortedError('Diese Seite wurde abgebrochen.') : asNeuralError(err);
      // A backend that died mid-stream may still carry what it managed to read.
      if (!text && neural.details && typeof neural.details.partialContent === 'string') {
        text = neural.details.partialContent;
      }
      return {
        ...base,
        text,
        ort: observedPlace(planned.ort, watcher.state),
        usedNetwork: watcher.state.usedNetwork,
        networkTargets: [...watcher.state.targets.keys()],
        netzBeobachtet: watcher.state.beobachtet,
        ms: Date.now() - started,
        abgebrochen: !!aborted,
        fehler: errorShape(neural),
      };
    }
  }

  /**
   * Where the request really went, corrected by what the gate saw.
   *
   * The plan's `ort` comes from the shape of a URL; this one comes from the
   * decisions the gate actually made. Where the two disagree, observation wins
   * -- a name that was still `unbekannt` before the call is `online` once the
   * gate has classified the address it resolved to.
   */
  function observedPlace(planned, state) {
    if (!state.beobachtet || !state.targets.size) return planned;
    const classes = new Set(state.targets.values());
    if (classes.has('public')) return 'online';
    if (classes.has('private')) return 'lan';
    if (classes.size === 1 && classes.has('loopback')) return 'lokal';
    return planned;
  }

  /**
   * Ask both models the same question, at the same time, and hand back both
   * answers -- including the one that is an error.
   *
   * @param {{chatId?:string, prompt:string, a?:*, b?:*, onDelta?:Function,
   *          signal?:AbortSignal, options?:object, timeoutMs?:number,
   *          idleTimeoutMs?:number, onEvent?:Function}} opts
   */
  async function run(opts = {}) {
    const prompt = opts.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new ValidationError('Die Frage ist leer.');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new ValidationError(`Die Frage ist zu lang (${prompt.length} Zeichen, erlaubt sind ${MAX_PROMPT_CHARS}).`);
    }

    const planned = await plan({ chatId: opts.chatId, a: opts.a, b: opts.b });

    if (!planned.a.modell && !planned.b.modell) {
      // Nothing to ask anywhere. The registry's own instructions are the only
      // useful thing we can return, and returning them beats two empty boxes.
      throw noModelError('Für keine der beiden Seiten ist ein Modell verfügbar.', {
        a: planned.a.fehler,
        b: planned.b.fehler,
      });
    }

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    const systemPrompt = typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim()
      ? opts.systemPrompt.trim()
      : null;
    const messages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }];

    const emit = (event) => {
      if (typeof opts.onEvent !== 'function') return;
      try {
        opts.onEvent(event);
      } catch (err) {
        log.warn(`onEvent-Handler des Vergleichs hat geworfen: ${err && err.message}`);
      }
    };

    const ctxRun = {
      token: planned.token,
      messages,
      options: opts.options && typeof opts.options === 'object' ? opts.options : {},
      signal: controller.signal,
      onDelta: (event) => {
        if (typeof opts.onDelta === 'function') opts.onDelta(event);
        emit({ type: 'delta', ...event });
      },
      timeoutMs: opts.timeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
    };

    for (const side of SIDES) {
      const p = planned[side];
      emit({ type: 'start', seite: side, modell: p.modell, ort: p.ort, hinweis: p.hinweis });
    }

    // Parallel on purpose: sequential would make the second side wait out the
    // first, and half the point of the comparison is seeing how long each one
    // really takes.
    let settled;
    try {
      settled = await Promise.all(SIDES.map(async (side) => {
        const result = await runSide(side, opts[side], planned[side], ctxRun);
        emit({ type: 'side', seite: side, ergebnis: result });
        return result;
      }));
    } finally {
      if (opts.signal) {
        try { opts.signal.removeEventListener('abort', onOuterAbort); } catch { /* older shim */ }
      }
    }

    const out = { chatId: planned.chatId, prompt, plan: planned, a: settled[0], b: settled[1] };
    if (bus && typeof bus.publish === 'function') {
      try {
        bus.publish('compare.done', {
          chatId: planned.chatId,
          a: { model: out.a.model, ort: out.a.ort, usedNetwork: out.a.usedNetwork, fehler: out.a.fehler },
          b: { model: out.b.model, ort: out.b.ort, usedNetwork: out.b.usedNetwork, fehler: out.b.fehler },
        });
      } catch (err) {
        log.warn(`bus.publish(compare.done) fehlgeschlagen: ${err && err.message}`);
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- save */

  function sideBlock(side, result) {
    const lines = [];
    const model = result && result.model;
    const name = model ? `${model.model}${model.provider ? ` (${model.provider})` : ''}` : 'kein Modell';
    lines.push(`## Seite ${side.toUpperCase()}: ${name}`);
    lines.push('');
    lines.push(`Herkunft: ${PLACE_LABEL[result.ort] || result.ort}. `
      + (result.netzBeobachtet
        ? (result.usedNetwork
          ? `Diese Antwort hat das Gerät verlassen (${result.networkTargets.join(', ') || 'Ziel nicht vermerkt'}).`
          : 'Diese Antwort hat das Gerät nicht verlassen.')
        : 'Ob dabei etwas das Gerät verlassen hat, konnte nicht beobachtet werden.'));
    lines.push('');
    if (result.fehler) {
      lines.push(`**Diese Seite ist fehlgeschlagen:** ${result.fehler.message} (${result.fehler.code})`);
      if (result.text) {
        lines.push('');
        lines.push('Der bis dahin erzeugte Text:');
        lines.push('');
        lines.push(result.text);
      }
    } else {
      lines.push(result.text || '_Diese Seite hat keinen Text geliefert._');
    }
    return lines.join('\n');
  }

  /**
   * Keep a comparison as a note -- both answers, both model names, where each
   * one came from. Called only when somebody pressed the button; a comparison
   * never writes to the vault by itself.
   *
   * @param {{chatId?:string, prompt:string, a:object, b:object, title?:string}} input
   */
  function save(input = {}) {
    if (!store || typeof store.create !== 'function') {
      throw new ValidationError('Ohne Speicher kann ein Vergleich nicht abgelegt werden.');
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw new ValidationError('Zu einem gespeicherten Vergleich gehört die Frage.');
    for (const side of SIDES) {
      if (!input[side] || typeof input[side] !== 'object') {
        throw new ValidationError(`Die Seite ${side.toUpperCase()} fehlt im zu speichernden Vergleich.`);
      }
    }

    const firstLine = prompt.split('\n').map((l) => l.trim()).find(Boolean) || 'Modellvergleich';
    const title = (typeof input.title === 'string' && input.title.trim())
      ? input.title.trim().slice(0, 200)
      : `Vergleich: ${firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine}`;

    const body = [
      '## Frage',
      '',
      prompt,
      '',
      sideBlock('a', input.a),
      '',
      sideBlock('b', input.b),
      '',
      '---',
      `Aufgezeichnet am ${new Date().toISOString()} von Neural OS. Beide Texte stehen wörtlich so da, `
      + 'wie die Modelle sie geliefert haben; alles unter den Überschriften ist die Oberfläche, nicht ein Modell.',
    ].join('\n');

    const note = store.create('note', { title, body, tags: ['vergleich'], source: 'agent' });

    let verknuepft = false;
    if (input.chatId && store.edges && typeof store.edges.add === 'function') {
      try {
        store.edges.add({
          from: note.id,
          to: String(input.chatId),
          kind: 'derived-from',
          source: 'manual',
          reason: 'Modellvergleich aus diesem Chat gespeichert',
        });
        verknuepft = true;
      } catch (err) {
        // A missing link is worth saying out loud; it is not worth losing the
        // note over.
        log.warn(`Vergleichsnotiz konnte nicht mit dem Chat verknüpft werden: ${err && err.message}`);
      }
    }
    return { record: note, verknuepft };
  }

  return {
    plan,
    run,
    save,
    /** The ceiling the HTTP layer mirrors. */
    MAX_PROMPT_CHARS,
  };
}

module.exports = {
  createCompare,
  MAX_PROMPT_CHARS,
  PLACE_BY_CLASS,
  PLACE_LABEL,
};
