'use strict';

/**
 * Chat orchestration.
 *
 * This module is the only place that turns a user's sentence into a model
 * request, and it is therefore the place where the system's central promise --
 * "never fabricate" -- is either kept or broken. The decisions below exist to
 * keep it.
 *
 * 1. **The assistant record is created BEFORE the model is called** and lives
 *    through the whole request in `status:'streaming'`. Every other design
 *    (buffer in memory, write at the end) loses the partial answer on a crash
 *    or an abort, and a lost partial answer tempts a retry that silently
 *    replaces what the model really said. Partial text is written back to the
 *    store while it streams, throttled, so a kill -9 costs at most a few
 *    hundred milliseconds of tokens.
 *
 * 2. **Abort preserves, failure preserves, neither invents.** An aborted answer
 *    keeps its partial content and gets `status:'aborted'`; a failed one keeps
 *    whatever really arrived and gets `status:'failed'` plus a typed `error`.
 *    No code path writes assistant content that did not come from the model.
 *
 * 3. **Trimming is visible.** The history is cut to a token budget by dropping
 *    whole OLD messages -- never by summarising them, because a summary the
 *    user did not ask for is the model's words masquerading as the user's
 *    history. Every cut is reported on the bus and through `onEvent`, so the
 *    UI can say "42 ältere Nachrichten ausgelassen" instead of quietly
 *    forgetting them.
 *
 * 4. **The system prompt states the real network situation**, taken from the
 *    gate's own policy decision for this chat's scope, not from what the chat
 *    record wishes were true. If the chat asks for 'online' and no grant
 *    exists, the prompt says so. This module never creates a grant: widening
 *    egress is a decision for the user in the network panel, and a chat that
 *    could grant itself internet access would make the whole gate decorative.
 *
 * 5. **Provenance comes from the gate, not from a guess.** `usedNetwork` and
 *    `networkTargets` are collected from the `network.attempt` events the gate
 *    publishes while this request runs, filtered to this chat's scope. A model
 *    on 127.0.0.1 is recorded as a target but does NOT set `usedNetwork`:
 *    loopback is this machine talking to itself, which is exactly what the
 *    offline promise permits.
 *
 * Token budget
 * ------------
 * We estimate 4 characters per token (`CHARS_PER_TOKEN`), the usual rough rule
 * for byte-pair vocabularies. It is genuinely rough, and for German it errs in
 * the dangerous direction: umlauts cost two bytes and compounds split into
 * several pieces, so real German text is closer to 3 characters per token.
 * We therefore multiply every estimate by `ESTIMATE_SAFETY` and spend only
 * `HISTORY_SHARE` of the window on the prompt, leaving the rest for the answer.
 * Overshooting the context of a local model does not fail cleanly -- llama.cpp
 * silently drops the front of the prompt, which is the invisible forgetting
 * this module exists to avoid -- so the estimate is deliberately pessimistic.
 * Exact counting would need the model's own tokeniser, which is not available
 * offline for every backend and is not worth an npm dependency.
 */

const {
  ValidationError,
  NotFoundError,
  AbortedError,
  asNeuralError,
} = require('../kernel/errors');

/* ------------------------------------------------------------- constants */

/** Rough characters-per-token ratio; see the header for why it is crude. */
const CHARS_PER_TOKEN = 4;
/** Multiplier applied to every estimate because German tokenises worse. */
const ESTIMATE_SAFETY = 1.25;
/** Per-message framing overhead (role markers, separators) in tokens. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Used when the backend does not report a context length. Conservative. */
const DEFAULT_CONTEXT_TOKENS = 8192;
/** Share of the context window the prompt may occupy. Rest is for the answer. */
const HISTORY_SHARE = 0.6;
/** Never plan a prompt smaller than this, or a long question could not be asked. */
const MIN_PROMPT_TOKENS = 512;
/** Hard ceiling on one user message, so a paste cannot exhaust memory. */
const MAX_CONTENT_CHARS = 200000;
/** Pinned graph nodes may take at most this share of the prompt budget. */
const PINNED_SHARE = 0.3;
/** One pinned node contributes at most this many characters. */
const PINNED_MAX_CHARS = 4000;

/** Partial answers are written back at most this often while streaming. */
const FLUSH_INTERVAL_MS = 500;
/** ... or whenever this many new characters have accumulated, whichever first. */
const FLUSH_CHARS = 400;

/**
 * Addresses used to ask the gate what this chat may reach, WITHOUT connecting
 * and without DNS. 10.255.255.254 is RFC 1918 (classified 'private') and
 * 203.0.113.1 is RFC 5737 TEST-NET-3, reserved for documentation and never
 * routed on the public internet (classified 'public'). Using reserved
 * addresses means this policy preview cannot become a real request by
 * accident, and `record:false` keeps it out of the audit trail -- a question
 * about policy is not an egress attempt.
 */
const PROBE_PRIVATE = '10.255.255.254';
const PROBE_PUBLIC = '203.0.113.1';

/** Roles that belong in a chat transcript sent to the model. */
const CONTEXT_ROLES = new Set(['user', 'assistant']);

/* --------------------------------------------------------------- helpers */

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

/** Crude token estimate, deliberately pessimistic. See the header. */
function estimateTokens(text) {
  if (typeof text !== 'string' || !text.length) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * ESTIMATE_SAFETY);
}

function estimateMessageTokens(message) {
  return estimateTokens(message && message.content) + MESSAGE_OVERHEAD_TOKENS;
}

function clip(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  if (s.length <= max) return { text: s, clipped: false };
  return { text: s.slice(0, max).trimEnd(), clipped: true };
}

/** First non-empty line, for deriving a chat title from what the user wrote. */
function firstLine(text, max) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).host;
  } catch {
    return '';
  }
}

function hostnameOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).hostname;
  } catch {
    return '';
  }
}

/**
 * Messages are ordered by creation time; `ordinal` breaks ties, because two
 * messages written in the same millisecond are common and record ids are
 * random rather than monotonic.
 */
function sortMessages(items) {
  return items.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    const ao = Number(a.data && a.data.ordinal);
    const bo = Number(b.data && b.data.ordinal);
    if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
    return a.id < b.id ? -1 : 1;
  });
}

/* ------------------------------------------------------------- factory */

/**
 * @param {object} deps
 * @param {object} deps.store     the record store (required)
 * @param {object} deps.registry  model registry (required)
 * @param {object} [deps.gate]    egress gate -- without it the network stance is reported as unknown
 * @param {object} [deps.bus]     event bus; also the source of egress provenance
 * @param {object} [deps.graph]   graph module (`deriveFor`, `label`, `snippetOf`)
 * @param {object} [deps.config]
 * @param {Function} [deps.logger]
 */
function createChatService({ store, registry, gate, bus, graph, config, logger } = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new ValidationError('createChatService benötigt einen Store.');
  }
  if (!registry || typeof registry.chat !== 'function') {
    throw new ValidationError('createChatService benötigt eine Modell-Registry.');
  }
  const log = typeof logger === 'function' ? logger('chat') : (logger || nullLogger());
  const cfg = config || {};

  /** chatId -> {controller, messageId, startedAt} for the answer in flight. */
  const inflight = new Map();

  /* ------------------------------------------------------------ records */

  function getChat(chatId) {
    if (typeof chatId !== 'string' || !chatId.trim()) {
      throw new ValidationError('Es wurde keine Chat-Kennung übergeben.');
    }
    const record = store.get(chatId);
    if (!record || record.type !== 'chat') throw new NotFoundError(`Chat ${chatId}`);
    return record;
  }

  function historyOf(chatId) {
    const res = store.list('message', { filter: { chatId } });
    return sortMessages(res.items);
  }

  function nextOrdinal(history) {
    let max = -1;
    for (const m of history) {
      const o = Number(m.data && m.data.ordinal);
      if (Number.isFinite(o) && o > max) max = o;
    }
    return max + 1;
  }

  /* ------------------------------------------------- network truth-telling */

  /**
   * What this chat may actually reach, asked of the gate for this chat's own
   * scope. Pure policy: no DNS, no connection, nothing audited.
   */
  function networkStance(chat) {
    const scope = `chat:${chat.id}`;
    const declared = (chat.data && chat.data.network) || 'offline';
    const globalMode = (cfg.network && cfg.network.mode) || 'offline';
    const wanted = declared === 'inherit' ? globalMode : declared;

    if (!gate || typeof gate.check !== 'function') {
      return {
        scope,
        declared,
        wanted,
        globalMode,
        known: false,
        lan: false,
        internet: false,
        hosts: [],
        grants: [],
      };
    }

    const ask = (host) => {
      try {
        return gate.check({ host, port: 443, scope, purpose: 'chat.policy-preview', record: false }).allowed === true;
      } catch (err) {
        log.warn(`Netzrichtlinie konnte nicht abgefragt werden: ${err && err.message}`);
        return false;
      }
    };

    let effective = { mode: globalMode, hosts: [], grants: [], strictAllowlist: false };
    if (typeof gate.effectiveFor === 'function') {
      try {
        effective = gate.effectiveFor(scope) || effective;
      } catch (err) {
        log.warn(`Freigaben für ${scope} konnten nicht gelesen werden: ${err && err.message}`);
      }
    }

    // The two probes answer "may this chat reach ANY private / ANY public
    // address?". A grant limited to named hosts answers 'no' to both while
    // still permitting something, so the host lists are collected separately
    // -- otherwise the prompt would tell the model it is offline while
    // de.wikipedia.org is in fact reachable.
    const mode = effective.mode || globalMode;
    const strictAllowlist = effective.strictAllowlist === true;
    const configHosts = Array.isArray(cfg.network && cfg.network.allowHosts) ? cfg.network.allowHosts : [];
    const grants = Array.isArray(effective.grants) ? effective.grants : [];

    const collect = (levels, extra) => {
      const out = [];
      const push = (h) => {
        const v = String(h || '').trim();
        if (v && v !== '*' && !out.includes(v)) out.push(v);
      };
      for (const g of grants) {
        if (!levels.includes(g.level)) continue;
        (Array.isArray(g.hosts) ? g.hosts : []).forEach(push);
      }
      extra.forEach(push);
      return out;
    };

    const internetAny = ask(PROBE_PUBLIC);
    const lanAny = ask(PROBE_PRIVATE);
    const internetHosts = collect(['online'], mode === 'online' && strictAllowlist ? configHosts : []);
    const lanHosts = collect(['lan', 'online'], (mode === 'lan' || mode === 'online') && strictAllowlist ? configHosts : []);

    return {
      scope,
      declared,
      wanted,
      globalMode,
      mode,
      known: true,
      lanAny,
      internetAny,
      lan: lanAny || lanHosts.length > 0,
      internet: internetAny || internetHosts.length > 0,
      lanHosts,
      internetHosts,
      strictAllowlist,
      hosts: Array.isArray(effective.hosts) ? effective.hosts.slice(0, 20) : [],
      grants,
    };
  }

  /** Where the model itself lives, and whether that counts as leaving the machine. */
  function modelStance(chat) {
    let target = null;
    let error = null;
    try {
      target = registry.resolve((chat.data && chat.data.model) || null);
    } catch (err) {
      error = asNeuralError(err);
    }
    if (!target) return { target: null, error, local: false, host: '' };
    const host = hostnameOf(target.baseUrl);
    let local = false;
    if (gate && typeof gate.classify === 'function') {
      try {
        local = gate.classify(host) === 'loopback';
      } catch {
        local = false;
      }
    }
    return { target, error: null, local, host: hostOf(target.baseUrl) };
  }

  /* --------------------------------------------------------- system prompt */

  function describeNetwork(stance, model) {
    const lines = [];

    if (model.target) {
      const where = model.local
        ? `läuft lokal auf diesem Gerät (${model.host})`
        : `läuft auf ${model.host} — das ist NICHT dieses Gerät`;
      lines.push(`- Modell: ${model.target.model} über ${model.target.providerId}, ${where}.`);
    } else {
      lines.push('- Modell: derzeit keines erreichbar.');
    }

    if (!stance.known) {
      lines.push('- Netz-Situation: unbekannt, weil die Egress-Kontrolle nicht verfügbar ist. Gehe davon aus, dass du nichts abrufen kannst.');
      return lines;
    }

    if (!stance.lan && !stance.internet) {
      lines.push('- Netzzugang: keiner. Weder lokales Netz noch Internet sind für diesen Chat freigegeben.');
    } else if (stance.internetAny) {
      lines.push('- Netzzugang: öffentliches Internet ist für diesen Chat freigegeben.');
    } else if (stance.internet) {
      lines.push(`- Netzzugang: Internet, aber ausschließlich für diese Hosts: ${stance.internetHosts.join(', ')}.`);
    } else if (stance.lanAny) {
      lines.push('- Netzzugang: nur das lokale Netz (LAN), kein öffentliches Internet.');
    } else {
      lines.push(`- Netzzugang: nur diese Hosts im lokalen Netz: ${stance.lanHosts.join(', ')}. Kein öffentliches Internet.`);
    }

    // Name the gap between wish and reality instead of letting the model
    // believe the chat's label.
    if (stance.wanted === 'online' && !stance.internet) {
      lines.push('- Hinweis: Für diesen Chat ist "online" eingestellt, aber es liegt keine gültige Freigabe vor. Es besteht tatsächlich kein Internetzugang.');
    } else if (stance.wanted === 'lan' && !stance.lan) {
      lines.push('- Hinweis: Für diesen Chat ist "lokales Netz" eingestellt, aber es liegt keine gültige Freigabe vor.');
    }

    lines.push(
      stance.lan || stance.internet
        ? '- Du selbst rufst nichts ab. Wenn eine Quelle nötig ist, sage welche und warum.'
        : '- Du kannst nichts nachschlagen und keine Seite abrufen. Sage klar, wenn dir dafür Informationen fehlen.',
    );
    return lines;
  }

  /**
   * Render the pinned graph nodes. Returns the text plus an honest account of
   * what was left out, because a context that quietly drops a pinned note is
   * indistinguishable from one that never had it.
   */
  function renderPinned(chat, budgetChars) {
    const ids = Array.isArray(chat.data && chat.data.contextNodeIds) ? chat.data.contextNodeIds : [];
    const result = { text: '', included: [], missing: [], truncated: [], dropped: [] };
    if (!ids.length || budgetChars <= 0) return result;

    const labelOf = graph && typeof graph.label === 'function' ? graph.label : (r) => (r.data && (r.data.title || r.data.name)) || r.id;
    const parts = [];
    let used = 0;

    for (const id of ids) {
      let record = null;
      try {
        record = store.get(id);
      } catch (err) {
        log.warn(`Angehefteter Knoten ${id} konnte nicht gelesen werden: ${err && err.message}`);
      }
      if (!record) {
        result.missing.push(id);
        continue;
      }
      if (used >= budgetChars) {
        result.dropped.push(id);
        continue;
      }

      const body = bodyTextOf(record);
      const room = Math.min(PINNED_MAX_CHARS, budgetChars - used);
      const clipped = clip(body, room);
      const head = `### ${labelOf(record)} (${record.type})`;
      const tail = clipped.clipped ? '\n[…gekürzt]' : '';
      const block = clipped.text ? `${head}\n${clipped.text}${tail}` : head;
      parts.push(block);
      used += block.length;
      result.included.push(id);
      if (clipped.clipped) result.truncated.push(id);
    }

    if (result.missing.length) {
      parts.push(`(${result.missing.length} angeheftete(r) Eintrag/Einträge existiert nicht mehr: ${result.missing.join(', ')})`);
    }
    if (result.dropped.length) {
      parts.push(`(${result.dropped.length} weitere(r) angeheftete(r) Eintrag/Einträge passte(n) nicht mehr in den Kontext)`);
    }
    result.text = parts.join('\n\n');
    return result;
  }

  /** The readable body of any record type, for the pinned-context block. */
  function bodyTextOf(record) {
    const d = (record && record.data) || {};
    for (const field of ['body', 'description', 'text', 'content', 'goal', 'result']) {
      if (typeof d[field] === 'string' && d[field].trim()) return d[field];
    }
    if (graph && typeof graph.snippetOf === 'function') {
      try {
        return graph.snippetOf(record) || '';
      } catch {
        return '';
      }
    }
    return '';
  }

  /**
   * Build the system prompt. Order matters: identity, then the network facts,
   * then the rules, then the user's own instruction, then pinned material.
   * The user's instruction sits after the facts so it cannot quietly rewrite
   * them, and before the pinned material so it can say how to use it.
   */
  function buildSystemPrompt(chat, { stance, model, pinnedBudgetChars }) {
    const sections = [];
    sections.push(
      'Du bist der Assistent von Neural OS, einem persönlichen KI-System, das auf dem Gerät des Nutzers läuft.',
    );

    sections.push(['Tatsächliche Situation dieses Chats:', ...describeNetwork(stance, model)].join('\n'));

    sections.push([
      'Regeln:',
      '- Antworte auf Deutsch, es sei denn, der Nutzer schreibt in einer anderen Sprache.',
      '- Erfinde nichts. Wenn du etwas nicht weißt, sage das, statt zu raten.',
      '- Gib keine Quelle an, die du nicht tatsächlich gelesen hast.',
      '- Fasse dich so kurz, wie die Frage es zulässt.',
    ].join('\n'));

    const own = typeof (chat.data && chat.data.systemPrompt) === 'string' ? chat.data.systemPrompt.trim() : '';
    if (own) sections.push(`Zusätzliche Anweisung des Nutzers:\n${own}`);

    const pinned = renderPinned(chat, pinnedBudgetChars);
    if (pinned.text) {
      sections.push(`Angeheftete Einträge aus dem Wissensgraphen (vom Nutzer ausgewählt):\n\n${pinned.text}`);
    }

    return { text: sections.join('\n\n'), pinned };
  }

  /* ------------------------------------------------------ context assembly */

  /** Context length of the resolved model, when the backend reported one. */
  function contextTokensFor(target) {
    if (!target || typeof registry.list !== 'function') return DEFAULT_CONTEXT_TOKENS;
    let snapshot = null;
    try {
      snapshot = registry.list();
    } catch {
      return DEFAULT_CONTEXT_TOKENS;
    }
    const providers = (snapshot && snapshot.providers) || [];
    for (const p of providers) {
      if (p.id !== target.providerId) continue;
      for (const m of p.models || []) {
        if (m.id !== target.model) continue;
        if (Number.isFinite(m.contextLength) && m.contextLength > 0) return m.contextLength;
      }
    }
    return DEFAULT_CONTEXT_TOKENS;
  }

  /**
   * Assemble the message array for the model.
   *
   * Walks the history from newest to oldest and keeps what fits. Old messages
   * are OMITTED, never condensed. The newest user turn is always kept even if
   * it alone blows the budget -- refusing to send the question the user just
   * typed would be a worse failure than a tight context -- and that case is
   * reported like any other trim.
   *
   * @returns {{messages:Array, omitted:number, omittedTokens:number,
   *            keptMessages:number, budgetTokens:number, usedTokens:number,
   *            systemPrompt:string, pinned:object, overflow:boolean}}
   */
  function buildContext(chat, history, { target } = {}) {
    const contextTokens = contextTokensFor(target);
    const budgetTokens = Math.max(MIN_PROMPT_TOKENS, Math.floor(contextTokens * HISTORY_SHARE));
    const pinnedBudgetChars = Math.floor(budgetTokens * PINNED_SHARE * CHARS_PER_TOKEN);

    const { text: systemPrompt, pinned } = buildSystemPrompt(chat, {
      stance: networkStance(chat),
      model: modelStance(chat),
      pinnedBudgetChars,
    });

    const systemTokens = estimateTokens(systemPrompt) + MESSAGE_OVERHEAD_TOKENS;
    let remaining = budgetTokens - systemTokens;

    const usable = history.filter((m) => {
      const d = m.data || {};
      if (!CONTEXT_ROLES.has(d.role)) return false;
      // A failed turn produced no answer; replaying its emptiness as if it were
      // one would teach the model to answer with nothing.
      if (d.status === 'failed' && !String(d.content || '').trim()) return false;
      return String(d.content || '').trim().length > 0;
    });

    const kept = [];
    let omittedTokens = 0;
    let overflow = false;

    for (let i = usable.length - 1; i >= 0; i--) {
      const record = usable[i];
      const d = record.data || {};
      // An aborted answer is real, but the model must know it stops mid-thought
      // rather than treating a cut-off sentence as a complete one.
      const content = d.status === 'aborted'
        ? `${d.content}\n[Diese Antwort wurde vom Nutzer abgebrochen.]`
        : d.content;
      const message = { role: d.role, content };
      const cost = estimateMessageTokens(message);

      if (cost > remaining) {
        if (!kept.length) {
          // The newest turn does not fit on its own. Send it anyway and say so.
          kept.unshift(message);
          remaining -= cost;
          overflow = true;
          continue;
        }
        for (let j = i; j >= 0; j--) omittedTokens += estimateMessageTokens({ content: usable[j].data.content });
        return {
          messages: [{ role: 'system', content: systemPrompt }, ...kept],
          omitted: i + 1,
          omittedTokens,
          keptMessages: kept.length,
          budgetTokens,
          usedTokens: budgetTokens - remaining,
          systemPrompt,
          pinned,
          overflow,
        };
      }
      kept.unshift(message);
      remaining -= cost;
    }

    return {
      messages: [{ role: 'system', content: systemPrompt }, ...kept],
      omitted: 0,
      omittedTokens: 0,
      keptMessages: kept.length,
      budgetTokens,
      usedTokens: budgetTokens - remaining,
      systemPrompt,
      pinned,
      overflow,
    };
  }

  /* ------------------------------------------------------------- emitting */

  function emit(onEvent, event) {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch (err) {
      // A broken consumer (a disconnected SSE stream, a throwing UI handler)
      // must not abort a model call that is already running and already costing
      // the user's CPU.
      log.warn(`chat onEvent-Handler hat geworfen: ${err && err.message}`);
    }
  }

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`);
    }
  }

  /* --------------------------------------------------------- provenance */

  /**
   * Collect what the gate actually permitted for this chat while the request
   * runs. This is observation, not inference: every entry corresponds to a
   * decision the gate made and audited.
   */
  function watchEgress(scope) {
    const targets = new Map();
    let offGate = false;
    const state = {
      usedNetwork: false,
      targets,
      /** True when there is no bus, i.e. nothing could be observed at all. */
      blind: !bus || typeof bus.on !== 'function',
    };
    if (state.blind) {
      log.warn('Ohne Event-Bus kann die Netz-Herkunft einer Antwort nicht beobachtet werden.');
      return { state, stop: () => {} };
    }
    const handler = (evt) => {
      const p = evt && evt.payload;
      if (!p || p.allowed !== true || p.scope !== scope) return;
      const host = p.host || p.ip;
      if (!host) return;
      const key = p.port ? `${host}:${p.port}` : String(host);
      targets.set(key, p.classification || 'unknown');
      // Loopback is this machine talking to itself. Counting it as network use
      // would make the offline badge lie in the other direction.
      if (p.classification && p.classification !== 'loopback') state.usedNetwork = true;
    };
    bus.on('network.attempt', handler);
    return {
      state,
      stop() {
        if (offGate) return;
        offGate = true;
        try {
          bus.off('network.attempt', handler);
        } catch { /* already detached */ }
      },
    };
  }

  /* -------------------------------------------------------------- sending */

  /**
   * Send one user message and stream the model's answer into the store.
   *
   * @param {object} opts
   * @param {string} opts.chatId
   * @param {string} opts.content        the user's text
   * @param {AbortSignal} [opts.signal]  caller-side cancellation
   * @param {Function} [opts.onEvent]    receives {type:'user'|'context'|'start'|'delta'|'message'|'error'|'done', ...}
   * @param {string} [opts.network]      persist a new network stance on the chat first
   * @param {object} [opts.options]      model options {temperature, maxTokens, ...}
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.idleTimeoutMs]
   * @returns {Promise<{chat:object, userMessage:object, message:object}>}
   */
  async function send(opts = {}) {
    const { chatId, content, signal, onEvent } = opts;

    if (typeof content !== 'string' || !content.trim()) {
      throw new ValidationError('Die Nachricht ist leer.');
    }
    if (content.length > MAX_CONTENT_CHARS) {
      throw new ValidationError(`Die Nachricht ist zu lang (${content.length} Zeichen, erlaubt sind ${MAX_CONTENT_CHARS}).`);
    }

    let chat = getChat(chatId);

    if (inflight.has(chat.id)) {
      throw new ValidationError('Für diesen Chat läuft bereits eine Antwort. Brich sie ab, bevor du erneut sendest.');
    }

    if (opts.network !== undefined) {
      // A per-request stance is a visible property of the chat, not a hidden
      // flag on one message: the user must be able to see later what this
      // conversation was allowed to do.
      chat = store.update(chat.id, { network: opts.network });
    }

    const history = historyOf(chat.id);
    let ordinal = nextOrdinal(history);

    const userMessage = store.create('message', {
      chatId: chat.id,
      role: 'user',
      content,
      status: 'complete',
      ordinal: ordinal++,
    });
    emit(onEvent, { type: 'user', record: userMessage });
    publish('chat.message', { chatId: chat.id, record: userMessage });

    // Name the conversation after what the user actually wrote -- derived text,
    // never invented, and only while the chat is still called "Neuer Chat".
    const currentTitle = String((chat.data && chat.data.title) || '').trim();
    if (!history.some((m) => m.data.role === 'user') && (!currentTitle || currentTitle === 'Neuer Chat')) {
      const derived = firstLine(content, 60);
      if (derived) {
        try {
          chat = store.update(chat.id, { title: derived });
        } catch (err) {
          log.warn(`Chat-Titel konnte nicht gesetzt werden: ${err && err.message}`);
        }
      }
    }

    const model = modelStance(chat);
    const context = buildContext(chat, [...history, userMessage], { target: model.target });

    if (context.omitted > 0 || context.overflow || context.pinned.missing.length || context.pinned.dropped.length) {
      const notice = {
        type: 'context',
        chatId: chat.id,
        omitted: context.omitted,
        omittedTokens: context.omittedTokens,
        keptMessages: context.keptMessages,
        budgetTokens: context.budgetTokens,
        overflow: context.overflow,
        pinnedMissing: context.pinned.missing,
        pinnedDropped: context.pinned.dropped,
        pinnedTruncated: context.pinned.truncated,
        message: contextNotice(context),
      };
      emit(onEvent, notice);
      publish('chat.context', notice);
    }

    const scope = `chat:${chat.id}`;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    const assistant = store.create('message', {
      chatId: chat.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: model.target ? { provider: model.target.providerId, model: model.target.model } : null,
      ordinal: ordinal++,
    });
    inflight.set(chat.id, { controller, messageId: assistant.id, startedAt: Date.now() });
    emit(onEvent, { type: 'start', record: assistant });
    publish('chat.message', { chatId: chat.id, record: assistant });

    const egress = watchEgress(scope);
    let text = '';
    let flushedLength = 0;
    let lastFlush = Date.now();
    let finalRecord = assistant;
    /** Set once the record has its terminal status; stops further partial writes. */
    let settled = false;

    /** Persist the partial answer. Never throws: a failed flush is logged. */
    const flush = (force) => {
      if (settled) return;
      if (text.length === flushedLength && !force) return;
      const now = Date.now();
      if (!force && now - lastFlush < FLUSH_INTERVAL_MS && text.length - flushedLength < FLUSH_CHARS) return;
      try {
        finalRecord = store.update(assistant.id, { content: text });
        flushedLength = text.length;
        lastFlush = now;
      } catch (err) {
        log.warn(`Teilantwort konnte nicht gespeichert werden: ${err && err.message}`);
      }
    };

    const onDelta = (chunk) => {
      if (typeof chunk !== 'string' || !chunk.length) return;
      text += chunk;
      emit(onEvent, { type: 'delta', chatId: chat.id, messageId: assistant.id, text: chunk });
      publish('chat.delta', { chatId: chat.id, messageId: assistant.id, text: chunk });
      flush(false);
    };

    try {
      const result = await registry.chat((chat.data && chat.data.model) || null, {
        messages: context.messages,
        options: opts.options || {},
        scope,
        purpose: `Antwort im Chat "${(chat.data && chat.data.title) || chat.id}"`,
        signal: controller.signal,
        onDelta,
        timeoutMs: opts.timeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs,
      });

      // Non-streaming backends deliver everything at the end; streaming ones
      // have already delivered it. Trust the final content only when nothing
      // was streamed, so a provider that repeats itself cannot double the text.
      if (!text && typeof result.content === 'string') {
        text = result.content;
        if (text) {
          emit(onEvent, { type: 'delta', chatId: chat.id, messageId: assistant.id, text });
          publish('chat.delta', { chatId: chat.id, messageId: assistant.id, text });
        }
      }

      egress.stop();
      settled = true;
      finalRecord = store.update(assistant.id, {
        content: text,
        status: 'complete',
        stats: result.stats || {},
        toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
        model: { provider: result.provider || (model.target && model.target.providerId) || null, model: result.model || (model.target && model.target.model) || null },
        usedNetwork: egress.state.usedNetwork,
        networkTargets: [...egress.state.targets.keys()],
        error: null,
      });
      emit(onEvent, { type: 'message', record: finalRecord });
      publish('chat.message', { chatId: chat.id, record: finalRecord });

      derive(finalRecord, userMessage, chat);
      return { chat, userMessage, message: finalRecord };
    } catch (err) {
      egress.stop();
      const aborted = controller.signal.aborted || err instanceof AbortedError || (err && err.name === 'AbortError');
      const neural = aborted ? new AbortedError('Die Antwort wurde abgebrochen.') : asNeuralError(err);

      // A provider that dies mid-stream may carry what it managed to read.
      if (!text && neural.details && typeof neural.details.partialContent === 'string') {
        text = neural.details.partialContent;
      }

      const patch = {
        content: text,
        status: aborted ? 'aborted' : 'failed',
        usedNetwork: egress.state.usedNetwork,
        networkTargets: [...egress.state.targets.keys()],
        error: aborted
          ? { code: neural.code, message: neural.message }
          : { code: neural.code, message: neural.message, details: sanitiseDetails(neural.details) },
      };
      settled = true;
      try {
        finalRecord = store.update(assistant.id, patch);
      } catch (storeErr) {
        log.error(`Fehlerzustand der Nachricht konnte nicht gespeichert werden: ${storeErr && storeErr.message}`);
      }

      emit(onEvent, { type: 'error', chatId: chat.id, record: finalRecord, error: { code: neural.code, message: neural.message }, aborted });
      publish('chat.error', { chatId: chat.id, messageId: assistant.id, code: neural.code, message: neural.message, aborted });

      // An aborted answer is still part of the conversation, so it still
      // belongs in the graph. A failed one with no text is not.
      if (text) derive(finalRecord, userMessage, chat);
      throw neural;
    } finally {
      flush(true);
      inflight.delete(chat.id);
      if (signal) {
        try { signal.removeEventListener('abort', onOuterAbort); } catch { /* older signal shim */ }
      }
      emit(onEvent, {
        type: 'done',
        chatId: chat.id,
        messageId: assistant.id,
        status: (finalRecord.data && finalRecord.data.status) || 'complete',
      });
    }
  }

  function contextNotice(context) {
    const parts = [];
    if (context.omitted > 0) {
      parts.push(`${context.omitted} ältere Nachricht(en) wurden ausgelassen, damit der Verlauf in das Kontextfenster passt (rund ${context.omittedTokens} Token). Sie sind nicht zusammengefasst, sondern in diesem Aufruf nicht enthalten.`);
    }
    if (context.overflow) {
      parts.push('Die letzte Nachricht allein überschreitet das geplante Kontextbudget. Sie wurde trotzdem gesendet; das Modell kann sie abschneiden.');
    }
    if (context.pinned.missing.length) {
      parts.push(`${context.pinned.missing.length} angeheftete(r) Eintrag/Einträge existiert nicht mehr.`);
    }
    if (context.pinned.dropped.length) {
      parts.push(`${context.pinned.dropped.length} angeheftete(r) Eintrag/Einträge passte(n) nicht in den Kontext.`);
    }
    if (context.pinned.truncated.length) {
      parts.push(`${context.pinned.truncated.length} angeheftete(r) Eintrag/Einträge wurde(n) gekürzt.`);
    }
    return parts.join(' ');
  }

  /** Keep error details small and free of anything that looks like a secret. */
  function sanitiseDetails(details) {
    if (!details || typeof details !== 'object') return null;
    const out = {};
    for (const key of ['status', 'url', 'host', 'model', 'provider', 'classification', 'reason', 'scope']) {
      if (details[key] !== undefined && details[key] !== null) out[key] = details[key];
    }
    if (typeof details.body === 'string') out.body = details.body.slice(0, 400);
    return Object.keys(out).length ? out : null;
  }

  /**
   * Make the chat visible in the knowledge graph. `deriveFor` turns
   * `message.chatId` into a `belongs-to` edge, so a chat only appears once its
   * messages exist -- which is why this runs after the answer, not before it.
   */
  function derive(assistantRecord, userRecord, chat) {
    if (!graph || typeof graph.deriveFor !== 'function') return;
    for (const record of [userRecord, assistantRecord, store.get(chat.id) || chat]) {
      if (!record) continue;
      try {
        graph.deriveFor(store, record);
      } catch (err) {
        log.warn(`Graph-Ableitung für ${record.id} fehlgeschlagen: ${err && err.message}`);
      }
    }
  }

  /* -------------------------------------------------------------- service */

  const service = {
    /** Create a chat. Defaults are the schema's: offline, no model pinned. */
    create(data = {}) {
      const payload = {};
      for (const key of ['title', 'agentId', 'model', 'systemPrompt', 'network', 'contextNodeIds', 'pinned']) {
        if (data[key] !== undefined) payload[key] = data[key];
      }
      const chat = store.create('chat', payload);
      publish('chat.created', { chatId: chat.id, record: chat });
      return chat;
    },

    /** Patch a chat's settings. Only the fields the UI may change. */
    update(chatId, patch = {}) {
      const chat = getChat(chatId);
      const allowed = {};
      for (const key of ['title', 'model', 'network', 'systemPrompt', 'contextNodeIds', 'agentId', 'pinned']) {
        if (patch[key] !== undefined) allowed[key] = patch[key];
      }
      if (!Object.keys(allowed).length) return chat;
      return store.update(chat.id, allowed);
    },

    get: getChat,

    /**
     * The chat's messages in reading order.
     * @param {string} chatId
     * @param {{limit?:number, offset?:number}} [opts]
     */
    messages(chatId, opts = {}) {
      getChat(chatId);
      const all = historyOf(chatId);
      const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
      const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : all.length;
      return { items: all.slice(offset, offset + limit), total: all.length };
    },

    send,

    /**
     * Stop the answer currently streaming in this chat. The partial text is
     * kept; see the header for why.
     * @returns {boolean} whether something was actually running
     */
    abort(chatId) {
      const entry = inflight.get(chatId);
      if (!entry) return false;
      entry.controller.abort();
      return true;
    },

    /** Abort every running answer (shutdown path). */
    abortAll() {
      let n = 0;
      for (const entry of inflight.values()) {
        entry.controller.abort();
        n++;
      }
      return n;
    },

    isStreaming(chatId) {
      return inflight.has(chatId);
    },

    /** What the UI shows as the chat's network badge -- the gate's own answer. */
    stance(chatId) {
      const chat = getChat(chatId);
      return { ...networkStance(chat), model: modelStance(chat) };
    },

    /**
     * Preview the exact context that would be sent. Used by the UI's "was
     * sieht das Modell?" panel and by the tests; performs no network access.
     */
    preview(chatId) {
      const chat = getChat(chatId);
      const model = modelStance(chat);
      const context = buildContext(chat, historyOf(chat.id), { target: model.target });
      return { ...context, notice: contextNotice(context) };
    },

    estimateTokens,
  };

  return service;
}

module.exports = {
  createChatService,
  estimateTokens,
  CHARS_PER_TOKEN,
  ESTIMATE_SAFETY,
  DEFAULT_CONTEXT_TOKENS,
  HISTORY_SHARE,
  /** Exposed for tests only. */
  // Exported, not internal: the agent toolbox reads chat histories too, and
  // two places ordering the same messages by two comparators is exactly how a
  // summary ends up quoting a conversation backwards.
  sortMessages,
  __internals: { sortMessages, firstLine, clip, PROBE_PRIVATE, PROBE_PUBLIC },
};
