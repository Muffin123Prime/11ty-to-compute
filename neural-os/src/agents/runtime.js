'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  NeuralError,
  ValidationError,
  NotFoundError,
  NoModelError,
  asNeuralError,
} = require('../kernel/errors');
const permissionsMod = require('./permissions');
const { describeTools } = require('./tools');

/**
 * The agent run loop.
 *
 * Four decisions that are not obvious from the code
 * -------------------------------------------------
 *
 * 1. THE SYSTEM PROMPT STATES THE NETWORK STANCE IN PLAIN GERMAN. Small local
 *    models, asked to "research" something, will confidently describe a web
 *    search they never performed and cite pages that do not exist. They do it
 *    because nothing in their context said otherwise. One explicit sentence --
 *    "Du hast KEINEN Internetzugang" -- removes most of that failure class, so
 *    it is not decoration: it is the cheapest correctness measure in the file.
 *
 * 2. THERE ARE TWO TOOL PROTOCOLS AND WE PARSE BOTH. Native tool calling
 *    exists in Ollama and the OpenAI-compatible servers, but plenty of local
 *    models either lack it or produce it badly. The documented text protocol
 *    (`<tool name="x">{json}</tool>`) works with any model that can follow an
 *    instruction, and is parsed on every turn regardless of which protocol we
 *    asked for -- a model that ignores the native channel and writes the tag
 *    anyway still gets its tool executed.
 *
 * 3. `usedNetwork` IS MEASURED, NOT ASSUMED. Every egress decision the gate
 *    makes is published as `network.attempt` carrying its scope. The runtime
 *    tags everything a run does -- including the model call itself -- with
 *    `run:<id>`, subscribes to those events, and reports what the gate
 *    actually decided. A loopback model does not count as network use, which
 *    is the whole point of the offline-first design. When there is no bus, the
 *    gate's own per-host counters are diffed instead, and that is stated in
 *    the record via `usedNetworkSource`.
 *
 * 4. THE TRANSCRIPT IS WRITTEN TWICE, ON PURPOSE. The run record carries
 *    shortened steps so the vault does not fill with megabytes of model
 *    output per run and so the UI can render a run instantly. The complete,
 *    unabridged exchange goes to `paths.runs/<runId>.jsonl`, line by line, as
 *    it happens -- so a run that crashes the process still leaves everything
 *    that happened up to that moment on disk.
 */

/** Tool-call tags in the text protocol. Documented to the model verbatim. */
const TOOL_TAG_RE = /<tool\s+name\s*=\s*["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*>([\s\S]*?)<\/tool\s*>/gi;
const UNCLOSED_TOOL_RE = /<tool\s+name\s*=\s*["']?[A-Za-z][A-Za-z0-9_.-]*["']?\s*>(?![\s\S]*<\/tool\s*>)/i;

/** Hard ceilings independent of any configuration. */
const MAX_TOOL_CALLS_PER_STEP = 6;
const MAX_STEP_CONTENT_IN_RECORD = 4000;
const MAX_TOOL_RESULT_IN_RECORD = 1500;
const MAX_TOOL_RESULT_TO_MODEL = 12000;
/** Same call, same arguments, this often in a row: the model is stuck. */
const LOOP_LIMIT = 3;

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function shorten(value, max) {
  const s = typeof value === 'string' ? value : safeStringify(value);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} Zeichen gekürzt)`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Extract tool calls written in the text protocol and return the prose that
 * remains. Both halves matter: the prose is the model's reasoning and belongs
 * in the transcript, the calls are what gets executed.
 */
function parseTextToolCalls(content) {
  const calls = [];
  const text = String(content === undefined || content === null ? '' : content);
  let index = 0;
  let prose = '';
  TOOL_TAG_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_TAG_RE.exec(text)) !== null) {
    prose += text.slice(index, match.index);
    index = match.index + match[0].length;
    const body = match[2].trim();
    const call = { id: `text_${calls.length + 1}`, name: match[1], arguments: {}, protocol: 'text' };
    if (body) {
      try {
        const parsed = JSON.parse(body);
        if (isPlainObject(parsed)) call.arguments = parsed;
        else call.argumentsError = 'Die Parameter müssen ein JSON-Objekt sein.';
      } catch (err) {
        call.argumentsError = `Ungültiges JSON: ${err.message}`;
        call.argumentsRaw = body.slice(0, 500);
      }
    }
    calls.push(call);
  }
  prose += text.slice(index);
  return { calls, prose: prose.trim() };
}

function createAgentRuntime({ store, registry, toolbox, approvals, gate, bus, config, logger, paths } = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new ValidationError('createAgentRuntime benötigt einen Store.');
  }
  if (!toolbox || typeof toolbox.call !== 'function') {
    throw new ValidationError('createAgentRuntime benötigt eine Werkzeugsammlung.');
  }
  const log = typeof logger === 'function' ? logger('agents') : nullLogger();
  const cfg = isPlainObject(config) ? config : {};
  const runsDir = paths && typeof paths.runs === 'string' ? paths.runs : null;

  /** @type {Map<string, {controller:AbortController, task:Promise<any>, timer:any, stopReason:string|null}>} */
  const active = new Map();
  let runtime = null;

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload);
    } catch (err) {
      log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`);
    }
  }

  /* ------------------------------------------------------------ transcript */

  function transcriptPath(runId) {
    return runsDir ? path.join(runsDir, `${runId}.jsonl`) : null;
  }

  /** Append one line to the run's transcript. Never fatal: a run is worth more
   *  than its log file, but a silent failure would be a lie, so it is warned. */
  function appendTranscript(runId, entry) {
    const file = transcriptPath(runId);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch (err) {
      log.warn(`Protokoll für Lauf ${runId} nicht schreibbar: ${err && err.message}`);
    }
  }

  /* -------------------------------------------------------- network truth */

  /**
   * Watch what the gate decides for this run. Returns a probe that answers,
   * at the end, whether anything actually left this machine.
   */
  function watchNetwork(runId) {
    const runToken = `run:${runId}`;
    const hosts = new Set();
    let sawEgress = false;
    let source = 'gate.events';
    let unsubscribe = null;

    if (bus && typeof bus.on === 'function') {
      const handler = (event) => {
        const p = (event && event.payload) || {};
        if (p.allowed !== true) return;
        // Loopback is explicitly not "the internet": a local model must not
        // make a run look like it phoned home.
        if (p.classification === 'loopback') return;
        const tokens = String(p.scope || '').split(/[\s,|]+/).filter(Boolean);
        if (!tokens.includes(runToken)) return;
        sawEgress = true;
        if (p.host) hosts.add(String(p.host));
      };
      bus.on('network.attempt', handler);
      unsubscribe = () => {
        if (typeof bus.off === 'function') bus.off('network.attempt', handler);
      };
    }

    // Fallback for a runtime wired without a bus: diff the gate's own counters.
    // Honest but coarser -- it cannot separate concurrent runs, and the record
    // says so through `usedNetworkSource`.
    let before = null;
    if (!unsubscribe && gate && typeof gate.stats === 'function') {
      source = 'gate.stats';
      try {
        before = gate.stats().byHost || {};
      } catch {
        before = null;
      }
    }

    return {
      source,
      finish() {
        if (unsubscribe) unsubscribe();
        if (!unsubscribe && before && gate && typeof gate.stats === 'function') {
          try {
            const after = gate.stats().byHost || {};
            for (const [host, entry] of Object.entries(after)) {
              const previous = before[host] ? Number(before[host].allowed || 0) : 0;
              if (Number(entry.allowed || 0) > previous && !isLoopbackName(host)) {
                sawEgress = true;
                hosts.add(host);
              }
            }
          } catch (err) {
            log.warn(`Netz-Statistik nicht lesbar: ${err && err.message}`);
          }
        }
        return { usedNetwork: sawEgress, targets: Array.from(hosts), source };
      },
    };
  }

  function isLoopbackName(host) {
    if (gate && typeof gate.classify === 'function') {
      try { return gate.classify(host) === 'loopback'; } catch { /* fall through */ }
    }
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  /* --------------------------------------------------------- system prompt */

  function networkStatement(perms) {
    if (perms.network === 'offline') {
      const capped = perms._capped && perms._capped.network;
      return [
        'DEINE NETZ-LAGE: Du hast KEINEN Internetzugang.',
        capped
          ? `Für diesen Agenten war "${capped.requested}" eingestellt, aber der globale Netzmodus dieses Geräts lässt es nicht zu.`
          : 'Für diesen Agenten ist kein Netzzugang freigegeben.',
        'Du kannst keine Webseite abrufen, keine Suchmaschine benutzen und nichts nachschlagen.',
        'Erfinde deshalb niemals Suchergebnisse, Webseiten, Quellenangaben oder aktuelle Zahlen.',
        'Arbeite ausschließlich mit dem, was in den Werkzeugen und in dieser Unterhaltung steht.',
        'Wenn etwas nur im Internet zu finden wäre, sage genau das.',
      ].join(' ');
    }
    if (perms.network === 'lan') {
      return [
        'DEINE NETZ-LAGE: Du erreichst nur Geräte im lokalen Netz, NICHT das öffentliche Internet.',
        'Keine Suchmaschine, keine öffentlichen Webseiten.',
        'Erfinde keine Suchergebnisse und keine Quellen.',
      ].join(' ');
    }
    const hosts = perms.allowedHosts.length
      ? `Erlaubt sind ausschließlich: ${perms.allowedHosts.join(', ')}.`
      : 'Welche Adressen erlaubt sind, entscheidet die Netz-Schleuse dieses Geräts; ein Abruf kann abgelehnt werden.';
    return [
      'DEINE NETZ-LAGE: Du kannst mit dem Werkzeug web.fetch einzelne Webseiten abrufen.',
      hosts,
      'Es gibt KEINE Suchmaschine: du kannst nur eine konkrete Adresse abrufen, die du kennst oder die dir genannt wurde.',
      'Was du nicht abgerufen hast, zitierst du nicht.',
    ].join(' ');
  }

  function buildSystemPrompt({ agent, perms, tools, maxSteps, maxSeconds }) {
    const data = permissionsMod.agentData(agent);
    const parts = [];

    parts.push(`Du bist "${permissionsMod.agentName(agent)}", ein Agent in Neural OS, dem persönlichen Wissenssystem dieses Nutzers.`);
    if (data.systemPrompt && String(data.systemPrompt).trim()) parts.push(String(data.systemPrompt).trim());

    parts.push(networkStatement(perms));
    parts.push(`DEINE RECHTE: ${permissionsMod.describe(agent, cfg)}`);
    if (perms.requireApproval) {
      parts.push('Jede Änderung muss der Nutzer bestätigen. Ein Werkzeug kann deshalb mit einer Ablehnung antworten – das ist kein Fehler, sondern eine Entscheidung. Akzeptiere sie und mache ohne diese Änderung weiter.');
    }

    parts.push([
      'WERKZEUGE',
      describeTools(tools),
    ].join('\n'));

    parts.push([
      'SO RUFST DU EIN WERKZEUG AUF',
      'Schreibe den Aufruf genau in dieser Form, allein in einer Zeile:',
      '<tool name="notes.search">{"query": "Beispiel", "limit": 5}</tool>',
      'Zwischen den Tags steht ausschließlich ein JSON-Objekt mit den Parametern; für keine Parameter schreibe {}.',
      'Du darfst pro Antwort mehrere Aufrufe schreiben, höchstens jedoch ' + MAX_TOOL_CALLS_PER_STEP + '.',
      'Das Ergebnis bekommst du in der nächsten Nachricht. Erfinde niemals ein Ergebnis selbst und schreibe niemals ein Werkzeug-Ergebnis in deine eigene Antwort.',
      'Wenn du kein Werkzeug mehr brauchst, antworte einfach ohne <tool>-Tag – das ist dann deine Endantwort.',
    ].join('\n'));

    parts.push([
      'GRENZEN',
      `Du hast höchstens ${maxSteps} Schritte und ${maxSeconds} Sekunden. Ein Schritt ist eine Antwort von dir.`,
      'Plane danach: lieber wenige gezielte Werkzeugaufrufe als viele tastende.',
      'Kommst du nicht weiter, sage ehrlich, woran es liegt, statt zu raten.',
    ].join('\n'));

    parts.push('Antworte auf Deutsch.');
    return parts.join('\n\n');
  }

  function buildContextBlock(context) {
    if (!context) return '';
    if (typeof context === 'string') return context.trim();
    const ids = Array.isArray(context) ? context : (Array.isArray(context.nodeIds) ? context.nodeIds : []);
    const lines = [];
    for (const id of ids.slice(0, 20)) {
      let record = null;
      try { record = store.get(id); } catch { record = null; }
      if (!record) continue;
      const d = record.data || {};
      const label = d.title || d.name || d.text || record.id;
      const body = typeof d.body === 'string' ? d.body : (typeof d.description === 'string' ? d.description : '');
      lines.push(`### ${label} (${record.id})\n${shorten(body, 1500)}`);
    }
    if (isPlainObject(context) && typeof context.text === 'string' && context.text.trim()) {
      lines.unshift(context.text.trim());
    }
    return lines.join('\n\n');
  }

  /* ----------------------------------------------------------- the run loop */

  async function execute(state) {
    const { run, agent, perms, controller } = state;
    const runId = run.id;
    const maxSteps = perms.maxSteps;
    const maxSeconds = perms.maxSeconds;
    const deadline = Date.now() + maxSeconds * 1000;
    const scope = permissionsMod.networkScope(agent, runId);
    const tools = toolbox.list(agent);
    const produced = [];
    const steps = [];
    const netProbe = watchNetwork(runId);

    const systemPrompt = buildSystemPrompt({ agent, perms, tools, maxSteps, maxSeconds });
    const contextBlock = buildContextBlock(state.context);
    const userContent = contextBlock
      ? `${run.data.goal}\n\n--- Mitgegebener Kontext ---\n${contextBlock}`
      : run.data.goal;

    /** @type {Array<{role:string, content:string, toolCalls?:Array, toolCallId?:string, name?:string}>} */
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    appendTranscript(runId, { kind: 'run.started', agentId: run.data.agentId, goal: run.data.goal, scope, tools: tools.map((t) => t.name), systemPrompt });

    let useNativeTools = tools.length > 0;
    let stopReason = null;
    let finalText = '';
    let modelRef = null;
    let lastSignature = null;
    let repeats = 0;
    let protocolHints = 0;
    let stepNo = 0;

    const pushStep = (entry) => {
      const step = { n: entry.n, at: new Date().toISOString(), ...entry };
      steps.push(step);
      appendTranscript(runId, { ...entry, kind: `step.${entry.kind}` });
      // The record is updated per step so a UI polling /api/runs/:id sees
      // progress, and so a crash leaves the partial run in the vault.
      try {
        store.update(runId, { steps: steps.slice() });
      } catch (err) {
        log.warn(`Lauf ${runId} konnte nicht fortgeschrieben werden: ${err && err.message}`);
      }
      publish('run.step', { runId, agentId: run.data.agentId, step });
    };

    const timeLeft = () => deadline - Date.now();

    while (true) {
      if (controller.signal.aborted) { stopReason = state.stopReason || 'aborted'; break; }
      if (stepNo >= maxSteps) { stopReason = 'max-steps'; break; }
      if (timeLeft() <= 0) { stopReason = 'max-seconds'; break; }

      stepNo++;
      const t0 = Date.now();
      let response;
      try {
        response = await callModel({
          agent, messages, tools, scope, controller, useNativeTools,
          timeoutMs: Math.max(1000, timeLeft()),
        });
      } catch (err) {
        const e = asNeuralError(err);
        if (e.code === 'ABORTED') { stopReason = state.stopReason || 'aborted'; break; }
        if (useNativeTools && looksLikeToolsUnsupported(e)) {
          // The backend rejected the tool schema. Fall back to the text
          // protocol, which the system prompt already documented, and retry
          // the same step rather than failing the run.
          log.info(`Modell unterstützt kein natives Tool-Calling, wechsle auf Textprotokoll: ${e.message}`);
          useNativeTools = false;
          pushStep({ n: stepNo, kind: 'note', note: 'Natives Tool-Calling nicht unterstützt – Umstellung auf Textprotokoll.', detail: e.message });
          stepNo--;
          continue;
        }
        throw e;
      }

      modelRef = response.modelRef || modelRef;
      const textParsed = parseTextToolCalls(response.content);
      const nativeCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      const calls = nativeCalls.length ? nativeCalls.map((c) => ({ ...c, protocol: 'native' })) : textParsed.calls;
      const prose = nativeCalls.length ? String(response.content || '').trim() : textParsed.prose;

      pushStep({
        n: stepNo,
        kind: 'model',
        ms: Date.now() - t0,
        protocol: useNativeTools ? 'native' : 'text',
        model: response.modelRef || null,
        content: shorten(prose, MAX_STEP_CONTENT_IN_RECORD),
        toolCalls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
        stats: response.stats || {},
      });
      appendTranscript(runId, { kind: 'model.raw', n: stepNo, content: response.content, toolCalls: calls });

      if (!calls.length) {
        // No tool call: either the final answer, or a model that mangled the
        // syntax. Distinguishing the two is worth one corrective turn.
        const unclosed = UNCLOSED_TOOL_RE.test(String(response.content || ''));
        if (unclosed && protocolHints < 2) {
          protocolHints++;
          messages.push({ role: 'assistant', content: String(response.content || '') });
          messages.push({
            role: 'user',
            content: 'Dein Werkzeugaufruf war unvollständig. Schreibe ihn genau so, mit schließendem Tag:\n'
              + '<tool name="werkzeug.name">{"parameter": "wert"}</tool>\n'
              + 'Oder antworte ohne <tool>-Tag, wenn du fertig bist.',
          });
          pushStep({ n: stepNo, kind: 'note', note: 'Unvollständiger Werkzeugaufruf – Syntaxhinweis an das Modell gesendet.' });
          continue;
        }
        finalText = prose || String(response.content || '').trim();
        stopReason = 'final';
        break;
      }

      // Loop detection: a model that asks the same question a fourth time is
      // not going to get a different answer, and the step budget is finite.
      const signature = JSON.stringify(calls.map((c) => [c.name, c.arguments]));
      if (signature === lastSignature) {
        repeats++;
        if (repeats >= LOOP_LIMIT) {
          stopReason = 'loop';
          finalText = prose;
          break;
        }
      } else {
        repeats = 0;
        lastSignature = signature;
      }

      messages.push({
        role: 'assistant',
        content: response.content || '',
        toolCalls: nativeCalls.length ? nativeCalls : undefined,
      });

      const accepted = calls.slice(0, MAX_TOOL_CALLS_PER_STEP);
      for (const call of accepted) {
        if (controller.signal.aborted) break;
        const tt = Date.now();
        let payload;
        let ok = false;

        if (call.argumentsError) {
          payload = { fehler: 'PARAMETER_UNGUELTIG', nachricht: call.argumentsError };
        } else {
          try {
            const result = await toolbox.call(call.name, call.arguments, {
              agent, run, signal: controller.signal, scope, produced, depth: state.depth,
            });
            payload = result.result;
            ok = true;
          } catch (err) {
            const e = asNeuralError(err);
            if (e.code === 'ABORTED') { stopReason = state.stopReason || 'aborted'; break; }
            // A tool failure is information for the model, not the end of the
            // run: a denied permission or a missing note is something it can
            // reason about and work around. Only an abort ends the loop.
            payload = { fehler: e.code, nachricht: e.message };
          }
        }

        // Only one of result/error is set: an `undefined` value survives in
        // memory but is dropped by JSON, so a record replayed from the log
        // after a restart would not match the one the UI just showed.
        const step = {
          n: stepNo,
          kind: 'tool',
          tool: call.name,
          protocol: call.protocol || 'native',
          ok,
          ms: Date.now() - tt,
          args: call.arguments,
        };
        if (ok) step.result = shorten(payload, MAX_TOOL_RESULT_IN_RECORD);
        else step.error = payload;
        pushStep(step);
        appendTranscript(runId, { kind: 'tool.raw', n: stepNo, tool: call.name, ok, args: call.arguments, result: payload });

        const rendered = shorten(payload, MAX_TOOL_RESULT_TO_MODEL);
        if (call.protocol === 'native') {
          messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: rendered });
        } else {
          // Models without native tool calling often ignore the 'tool' role
          // entirely, so the result comes back as a clearly marked user turn.
          messages.push({ role: 'user', content: `[Ergebnis von ${call.name}]\n${rendered}` });
        }
      }

      if (calls.length > accepted.length) {
        messages.push({
          role: 'user',
          content: `Es werden höchstens ${MAX_TOOL_CALLS_PER_STEP} Werkzeugaufrufe pro Antwort ausgeführt; die übrigen wurden verworfen.`,
        });
      }
      if (stopReason) break;
    }

    const net = netProbe.finish();
    if (!stopReason) stopReason = 'final';

    const notice = {
      'max-steps': `Der Lauf wurde nach ${stepNo} Schritten beendet: das Schrittlimit (${maxSteps}) ist erreicht.`,
      'max-seconds': `Der Lauf wurde nach ${maxSeconds} Sekunden beendet: das Zeitlimit ist erreicht.`,
      loop: 'Der Lauf wurde beendet, weil das Modell denselben Werkzeugaufruf mehrfach unverändert wiederholt hat.',
      aborted: 'Der Lauf wurde abgebrochen.',
    }[stopReason];

    const result = notice ? [notice, finalText].filter(Boolean).join('\n\n') : finalText;

    return {
      status: stopReason === 'aborted' ? 'aborted' : 'done',
      stopReason,
      result,
      steps,
      produced,
      usedNetwork: net.usedNetwork,
      networkTargets: net.targets,
      usedNetworkSource: net.source,
      model: modelRef,
      stepsUsed: stepNo,
    };
  }

  /** Does this error mean "this backend cannot do native tool calls"? */
  function looksLikeToolsUnsupported(err) {
    if (!err) return false;
    if (err.code !== 'MODEL_ERROR' && err.code !== 'VALIDATION_FAILED') return false;
    const text = `${err.message} ${safeStringify(err.details || '')}`.toLowerCase();
    return /tool|function[_ ]call/.test(text);
  }

  async function callModel({ agent, messages, tools, scope, controller, useNativeTools, timeoutMs }) {
    if (!registry || typeof registry.chat !== 'function') {
      throw new NoModelError('Es ist keine Modell-Registry verfügbar. Ohne Modell wird kein Lauf gestartet – es wird nichts erfunden.');
    }
    const data = permissionsMod.agentData(agent);
    const ref = isPlainObject(data.model) ? data.model : null;
    const response = await registry.chat(ref, {
      messages,
      tools: useNativeTools && tools.length ? tools : undefined,
      // Scope everything this run does, the model call included, so the gate's
      // audit and `usedNetwork` cover a remote backend too.
      scope,
      purpose: `Agentenlauf "${permissionsMod.agentName(agent)}"`,
      signal: controller.signal,
      timeoutMs,
      options: isPlainObject(data.modelOptions) ? data.modelOptions : {},
    });
    return {
      content: typeof response.content === 'string' ? response.content : '',
      toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls : [],
      stats: response.stats || {},
      modelRef: response.provider && response.model ? { provider: response.provider, model: response.model } : null,
    };
  }

  /* -------------------------------------------------------------- lifecycle */

  function finish(runId, patch) {
    try {
      return store.update(runId, { ...patch, finishedAt: new Date().toISOString() });
    } catch (err) {
      log.error(`Lauf ${runId} konnte nicht abgeschlossen werden: ${err && err.message}`);
      return null;
    }
  }

  runtime = {
    /**
     * @param {{agentId:string, goal:string, chatId?:string, context?:any,
     *          parentRunId?:string, depth?:number}} opts
     * @returns {Promise<object>} the run record; execution continues async
     */
    async start(opts = {}) {
      const agentId = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
      if (!agentId) throw new ValidationError('Ein Lauf braucht eine Agenten-ID.');
      const goal = typeof opts.goal === 'string' ? opts.goal.trim() : '';
      if (!goal) throw new ValidationError('Ein Lauf braucht ein Ziel (goal).');

      const agent = store.get(agentId);
      if (!agent || agent.type !== 'agent') throw new NotFoundError(`Agent ${agentId}`);

      const maxConcurrent = Number.isInteger(cfg.agents && cfg.agents.maxConcurrentRuns)
        ? cfg.agents.maxConcurrentRuns : 2;
      if (active.size >= Math.max(1, maxConcurrent)) {
        throw new NeuralError(
          'RUN_LIMIT_REACHED',
          `Es laufen bereits ${active.size} Agenten (Grenze: ${maxConcurrent}). Warte, bis einer fertig ist, oder brich einen ab.`,
          { status: 429, details: { active: Array.from(active.keys()) } },
        );
      }

      const perms = permissionsMod.effective(agent, cfg);
      const run = store.create('run', {
        agentId,
        goal,
        status: 'queued',
        steps: [],
        result: '',
        error: null,
        startedAt: null,
        finishedAt: null,
        usedNetwork: false,
        producedIds: [],
        // Extra fields; schema.validate preserves unknown keys by design.
        chatId: typeof opts.chatId === 'string' ? opts.chatId : null,
        parentRunId: typeof opts.parentRunId === 'string' ? opts.parentRunId : null,
        depth: Number(opts.depth) || 0,
        maxSteps: perms.maxSteps,
        maxSeconds: perms.maxSeconds,
        stopReason: null,
        networkTargets: [],
      });

      const controller = new AbortController();
      const state = {
        run, agent, perms, controller,
        context: opts.context,
        depth: Number(opts.depth) || 0,
        stopReason: null,
      };

      // Not unref'd: the time limit is a promise to the user, and an unref'd
      // timer silently stops being one when the loop is otherwise idle. It is
      // cleared in the run's `finally`, so it never outlives the run.
      const timer = setTimeout(() => {
        state.stopReason = 'max-seconds';
        controller.abort();
      }, perms.maxSeconds * 1000);
      state.timer = timer;
      active.set(run.id, state);

      const started = store.update(run.id, { status: 'running', startedAt: new Date().toISOString() });
      publish('run.started', { runId: run.id, agentId, goal, maxSteps: perms.maxSteps, maxSeconds: perms.maxSeconds });

      // Fire and forget: `start` returns the record so the HTTP layer can
      // answer immediately with a run id the UI can subscribe to.
      const task = execute(state)
        .then((outcome) => {
          const record = finish(run.id, {
            status: outcome.status,
            result: outcome.result,
            steps: outcome.steps,
            usedNetwork: outcome.usedNetwork,
            networkTargets: outcome.networkTargets,
            usedNetworkSource: outcome.usedNetworkSource,
            producedIds: outcome.produced,
            stopReason: outcome.stopReason,
            model: outcome.model,
          });
          appendTranscript(run.id, {
            kind: 'run.finished',
            status: outcome.status,
            stopReason: outcome.stopReason,
            usedNetwork: outcome.usedNetwork,
            networkTargets: outcome.networkTargets,
            steps: outcome.stepsUsed,
            result: outcome.result,
          });
          publish('run.finished', {
            runId: run.id, agentId, status: outcome.status, stopReason: outcome.stopReason,
            usedNetwork: outcome.usedNetwork, result: outcome.result,
          });
          return record;
        })
        .catch((err) => {
          const e = asNeuralError(err);
          const aborted = e.code === 'ABORTED';
          const record = finish(run.id, {
            status: aborted ? 'aborted' : 'failed',
            error: { code: e.code, message: e.message },
            stopReason: aborted ? (state.stopReason || 'aborted') : 'error',
          });
          appendTranscript(run.id, { kind: aborted ? 'run.aborted' : 'run.failed', code: e.code, message: e.message });
          log[aborted ? 'info' : 'error'](`Lauf ${run.id} ${aborted ? 'abgebrochen' : 'fehlgeschlagen'}: ${e.message}`);
          publish(aborted ? 'run.finished' : 'run.failed', {
            runId: run.id, agentId, status: aborted ? 'aborted' : 'failed',
            error: { code: e.code, message: e.message },
          });
          return record;
        })
        .finally(() => {
          clearTimeout(timer);
          active.delete(run.id);
          if (approvals && typeof approvals.abortAll === 'function') {
            try { approvals.abortAll(run.id); } catch { /* nothing left to cancel */ }
          }
        });

      state.task = task;
      return started;
    },

    /**
     * Stop a running agent. Returns true when something was actually running.
     * @param {string} runId
     */
    abort(runId) {
      const state = active.get(runId);
      if (!state) return false;
      state.stopReason = 'aborted';
      state.controller.abort();
      if (approvals && typeof approvals.abortAll === 'function') {
        try { approvals.abortAll(runId); } catch { /* best effort */ }
      }
      return true;
    },

    /** Abort every active run (shutdown). @returns {number} */
    abortAll() {
      const ids = Array.from(active.keys());
      for (const id of ids) runtime.abort(id);
      return ids.length;
    },

    /** Resolve when a run has finished. Used by tests and by `agents.spawn`
     *  callers that do want to wait. Returns the final record. */
    async wait(runId) {
      const state = active.get(runId);
      if (state && state.task) await state.task;
      return runtime.get(runId);
    },

    /** @param {string} runId @returns {object} run record */
    get(runId) {
      const record = store.get(runId);
      if (!record || record.type !== 'run') throw new NotFoundError(`Lauf ${runId}`);
      return record;
    },

    /** @returns {object[]} currently executing runs, freshest state from the store */
    listActive() {
      const out = [];
      for (const id of active.keys()) {
        const record = store.get(id);
        if (record) out.push(record);
      }
      return out;
    },

    /** Read the full, unabridged transcript of a run. */
    transcript(runId) {
      const file = transcriptPath(runId);
      if (!file) return [];
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw new NeuralError('FS_ERROR', `Protokoll von ${runId} nicht lesbar: ${err.message}`, { status: 500 });
      }
      return text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return { kind: 'unparseable', raw: line }; }
      });
    },

    /** Re-exported so the composition root can seed templates from one place. */
    builtinAgents: permissionsMod.builtinAgents,
  };

  // Breaks the tools <-> runtime require cycle: `agents.spawn` needs to start a
  // run, and the runtime needs the toolbox to exist first. Wiring it here, at
  // the end of construction, keeps the dependency one-directional in the code.
  if (typeof toolbox.attachRuntime === 'function') toolbox.attachRuntime(runtime);

  return runtime;
}

module.exports = {
  createAgentRuntime,
  builtinAgents: permissionsMod.builtinAgents,
  parseTextToolCalls,
  TOOL_TAG_RE,
};
