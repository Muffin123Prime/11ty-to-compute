'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { safeJoin } = require('../kernel/paths');
const schema = require('../store/schema');
// Host patterns are matched with the gate's own matcher on purpose. A second,
// independent implementation of "*.example.com" is a second place to get it
// subtly wrong, and the two would drift apart the first time either changed.
const { hostMatches, normaliseHost } = require('../net/gate');

/**
 * Agent capability policy.
 *
 * Three rules shape everything in this file:
 *
 * 1. ABSENCE IS DENIAL. A capability that is not explicitly granted is denied.
 *    `check()` never returns `{allowed:true}` because a key was missing,
 *    undefined or of an unexpected type -- only because it was literally
 *    `true`. An unknown capability name is denied too: a typo in a caller must
 *    fail closed, not open.
 *
 * 2. GLOBAL SECURITY BEATS PER-AGENT CONVENIENCE. Two settings in
 *    `config.security` / `config.network` override what an agent record says,
 *    and they only ever tighten:
 *      - `security.globalApprovalOverride` forces `requireApproval` on, even
 *        for an agent whose own record says it may act unattended.
 *      - `network.mode` caps the agent's network level. An agent configured
 *        for 'online' while the machine is 'offline' is offline. This matters
 *        beyond enforcement (the gate would refuse anyway): the runtime tells
 *        the model its network stance in the system prompt, and a prompt that
 *        promised internet the gate then denies is how a small model starts
 *        inventing search results.
 *
 * 3. PATHS ARE CHECKED AGAINST THE FILESYSTEM, NOT AGAINST STRINGS. A prefix
 *    comparison says `/home/u/notes-evil` starts with `/home/u/notes`, and a
 *    symlink inside an allowed root can point anywhere at all. `canAccessPath`
 *    therefore resolves symlinks (including for a file that does not exist yet,
 *    by resolving its nearest existing ancestor) and runs `safeJoin` against
 *    every configured root.
 */

/** Every capability the tool layer can ask about. Anything else is denied. */
const CAPABILITIES = [
  'readNotes',
  'writeNotes',
  'readFiles',
  'writeFiles',
  'createEdges',
  'runTasks',
  'spawnAgents',
  'network',
];

/** Capabilities whose exercise changes state or leaves the machine. */
const MUTATING_CAPABILITIES = new Set(['writeNotes', 'writeFiles', 'createEdges', 'runTasks', 'spawnAgents', 'network']);

const NETWORK_LEVELS = ['offline', 'lan', 'online'];

/**
 * Upper bounds no configuration can exceed. These are not a budget, they are a
 * stop for a runaway loop: a run with maxSteps = 10^9 is not "ambitious", it is
 * a record that never finishes and a transcript file that fills the disk.
 */
const HARD_MAX_STEPS = 100;
const HARD_MAX_SECONDS = 3600;

function networkRank(level) {
  const i = NETWORK_LEVELS.indexOf(level);
  return i === -1 ? 0 : i;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Accept either a store record (`{id, type, data}`) or a bare agent object. */
function agentData(agent) {
  if (!isPlainObject(agent)) return {};
  if (isPlainObject(agent.data) && (agent.type === 'agent' || typeof agent.id === 'string')) return agent.data;
  return agent;
}

function agentId(agent) {
  if (!isPlainObject(agent)) return null;
  if (typeof agent.id === 'string' && agent.id) return agent.id;
  const data = agentData(agent);
  return typeof data.id === 'string' && data.id ? data.id : null;
}

function agentName(agent) {
  const data = agentData(agent);
  return typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Unbenannter Agent';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Merge an agent's stored permissions with the schema defaults and apply the
 * global overrides.
 *
 * @param {object} agent  agent record or bare agent object
 * @param {object} [config]
 * @returns {object} effective permissions, plus `_capped` explaining what the
 *   global policy tightened (the UI and the system prompt both need to say so).
 */
function effective(agent, config) {
  const data = agentData(agent);
  const perms = schema.normalisePermissions(isPlainObject(data.permissions) ? data.permissions : {});
  const cfg = isPlainObject(config) ? config : {};
  const security = isPlainObject(cfg.security) ? cfg.security : {};
  const network = isPlainObject(cfg.network) ? cfg.network : {};
  const agentCfg = isPlainObject(cfg.agents) ? cfg.agents : {};

  const out = {};
  for (const cap of CAPABILITIES) {
    if (cap === 'network') continue;
    // Strictly `=== true`: a truthy 1, 'yes' or {} is a configuration mistake,
    // and reading it as a grant is exactly the silent permission we forbid.
    out[cap] = perms[cap] === true;
  }

  const wanted = NETWORK_LEVELS.includes(perms.network) ? perms.network : 'offline';
  const globalMode = NETWORK_LEVELS.includes(network.mode) ? network.mode : 'offline';
  const granted = networkRank(wanted) <= networkRank(globalMode) ? wanted : globalMode;

  out.network = granted;
  out.requestedNetwork = wanted;
  out.allowedHosts = stringList(perms.allowedHosts);
  out.fileRoots = normaliseRoots(perms.fileRoots);

  const forcedApproval = security.globalApprovalOverride === true;
  out.requireApproval = forcedApproval || perms.requireApproval !== false;

  out.maxSteps = clampInt(
    perms.maxSteps,
    clampInt(agentCfg.defaultMaxSteps, 12, 1, HARD_MAX_STEPS),
    1,
    HARD_MAX_STEPS,
  );
  out.maxSeconds = clampInt(
    perms.maxSeconds,
    clampInt(agentCfg.defaultMaxSeconds, 300, 1, HARD_MAX_SECONDS),
    1,
    HARD_MAX_SECONDS,
  );

  out._capped = {
    network: granted !== wanted ? { requested: wanted, granted, by: 'network.mode' } : null,
    approval: forcedApproval && perms.requireApproval === false ? { by: 'security.globalApprovalOverride' } : null,
  };

  return out;
}

/** Absolute, duplicate-free file roots. A relative root is meaningless here. */
function normaliseRoots(value) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const resolved = path.resolve(trimmed);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * Resolve symlinks for a path that may not exist yet: walk up to the nearest
 * existing ancestor, resolve that, and re-append what was left. Without this a
 * write to `<root>/link/../../etc/x` would be checked as a string while the
 * kernel followed the link somewhere else entirely.
 */
function realpathish(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        // EACCES on an ancestor means we cannot prove where the path leads,
        // so we must not claim it is inside the root.
        return null;
      }
      const parent = path.dirname(current);
      if (parent === current) return null; // reached the filesystem root
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * @param {object} agent
 * @param {string} absPath
 * @param {{config?:object}} [opts]
 * @returns {boolean}
 */
function canAccessPath(agent, absPath, opts = {}) {
  if (typeof absPath !== 'string' || !absPath.trim()) return false;
  const perms = opts.permissions || effective(agent, opts.config);
  const roots = perms.fileRoots;
  if (!roots.length) return false; // no root configured = no filesystem access

  const target = realpathish(absPath);
  if (target === null) return false;

  for (const root of roots) {
    const realRoot = realpathish(root);
    if (realRoot === null) continue; // a root that does not exist grants nothing
    if (target === realRoot) return true;
    const relative = path.relative(realRoot, target);
    // `path.relative` yields '..' segments for anything outside; handing those
    // to safeJoin is the point -- it is the single audited traversal guard.
    try {
      if (safeJoin(realRoot, relative) === target) return true;
    } catch (err) {
      if (err && err.code === 'EPATHESCAPE') continue;
      throw err;
    }
  }
  return false;
}

/**
 * @param {object} agent
 * @param {string} capability one of CAPABILITIES
 * @param {{config?:object, host?:string, port?:number, path?:string, level?:string}} [ctx]
 * @returns {{allowed:boolean, reason:string, requiresApproval:boolean, capability:string}}
 */
function check(agent, capability, ctx = {}) {
  const perms = ctx.permissions || effective(agent, ctx.config);
  const name = agentName(agent);
  const deny = (reason) => ({ allowed: false, reason, requiresApproval: false, capability });

  if (!CAPABILITIES.includes(capability)) {
    return deny(`Unbekannte Fähigkeit "${capability}" – im Zweifel verweigert.`);
  }

  const requiresApproval = perms.requireApproval === true && MUTATING_CAPABILITIES.has(capability);

  if (capability === 'network') {
    const wantedLevel = NETWORK_LEVELS.includes(ctx.level) ? ctx.level : 'online';
    if (perms.network === 'offline') {
      const hint = perms._capped && perms._capped.network
        ? ' Der globale Netzmodus steht auf "' + perms._capped.network.granted + '".'
        : '';
      return deny(`Agent "${name}" hat keinen Netzzugang.${hint}`);
    }
    if (networkRank(wantedLevel) > networkRank(perms.network)) {
      return deny(`Agent "${name}" darf nur bis Stufe "${perms.network}" ins Netz, nicht "${wantedLevel}".`);
    }
    if (ctx.host !== undefined && ctx.host !== null) {
      const host = normaliseHost(ctx.host);
      if (!host) return deny('Ohne Zielhost kann kein Netzzugriff geprüft werden.');
      // An empty host list is not "everything": it is "nothing named yet", so
      // the agent may only go where the gate's own policy already permits.
      if (perms.allowedHosts.length) {
        const port = ctx.port === undefined ? null : ctx.port;
        const ok = perms.allowedHosts.some((pattern) => hostMatches(pattern, host, port));
        if (!ok) {
          return deny(`Host "${host}" steht nicht auf der Liste von Agent "${name}" (${perms.allowedHosts.join(', ')}).`);
        }
      }
    }
    return { allowed: true, reason: `Netzstufe "${perms.network}" erlaubt.`, requiresApproval, capability };
  }

  if (perms[capability] !== true) {
    return deny(`Agent "${name}" hat die Berechtigung "${capability}" nicht.`);
  }

  if ((capability === 'readFiles' || capability === 'writeFiles')) {
    if (!perms.fileRoots.length) {
      return deny(`Agent "${name}" hat keine freigegebenen Ordner (fileRoots ist leer).`);
    }
    if (typeof ctx.path === 'string' && ctx.path) {
      if (!canAccessPath(agent, ctx.path, { permissions: perms })) {
        return deny(`Pfad liegt außerhalb der freigegebenen Ordner von Agent "${name}".`);
      }
    }
  }

  return { allowed: true, reason: `Berechtigung "${capability}" erteilt.`, requiresApproval, capability };
}

/**
 * The gate scope string for everything this agent does during `runId`.
 *
 * Two tokens, not one: the gate sorts a multi-token scope into its chain
 * (`once` → `run` → `agent` → `chat` → `global`), so a grant the user gave to
 * the agent as a whole and a grant they gave to this single run both apply,
 * and both are visible in `gate.effectiveFor()`.
 */
function networkScope(agent, runId) {
  const tokens = [];
  if (typeof runId === 'string' && runId.trim()) tokens.push(`run:${runId.trim()}`);
  const id = agentId(agent);
  tokens.push(`agent:${id || 'anonymous'}`);
  return tokens.join(' ');
}

/**
 * May `parent` start `child`? Only when the child asks for nothing the parent
 * does not already have. Otherwise spawning would be a privilege-escalation
 * primitive: a read-only agent could start a write-everything agent and have
 * it do the work.
 */
function subsetOf(child, parent, config) {
  const c = effective(child, config);
  const p = effective(parent, config);
  const missing = [];
  for (const cap of CAPABILITIES) {
    if (cap === 'network') continue;
    if (c[cap] === true && p[cap] !== true) missing.push(cap);
  }
  if (networkRank(c.network) > networkRank(p.network)) missing.push(`network:${c.network}`);
  for (const root of c.fileRoots) {
    if (!canAccessPath(parent, root, { permissions: p })) missing.push(`fileRoot:${root}`);
  }
  return { ok: missing.length === 0, missing };
}

/* ---------------------------------------------------------------- describe */

function joinDe(items) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

/**
 * Plain-German summary of what an agent may do. This is the sentence the user
 * reads before pressing "start", so it says what is FORBIDDEN as clearly as
 * what is allowed -- a list of granted permissions alone reads like a feature
 * list and tells nobody what the agent cannot touch.
 *
 * @returns {string}
 */
function describe(agent, config) {
  const perms = effective(agent, config);
  const lines = [];

  if (perms.readNotes && perms.writeNotes) lines.push('Darf Notizen lesen und schreiben.');
  else if (perms.readNotes) lines.push('Darf Notizen lesen, aber nicht ändern.');
  else if (perms.writeNotes) lines.push('Darf Notizen schreiben, aber nicht lesen.');
  else lines.push('Darf NICHT auf Notizen zugreifen.');

  if (perms.readFiles || perms.writeFiles) {
    const what = perms.readFiles && perms.writeFiles ? 'lesen und schreiben' : perms.readFiles ? 'lesen' : 'schreiben';
    lines.push(perms.fileRoots.length
      ? `Darf Dateien ${what}, ausschließlich in ${joinDe(perms.fileRoots)}.`
      : `Darf Dateien ${what} – es ist aber kein Ordner freigegeben, also erreicht er keine einzige Datei.`);
  } else {
    lines.push('Darf NICHT auf Dateien zugreifen.');
  }

  if (perms.network === 'offline') {
    const capped = perms._capped.network;
    lines.push(capped
      ? `Darf NICHT ins Internet (angefragt war "${capped.requested}", der globale Netzmodus erlaubt es nicht).`
      : 'Darf NICHT ins Internet.');
  } else if (perms.network === 'lan') {
    lines.push('Darf nur ins lokale Netz, nicht ins öffentliche Internet.');
  } else {
    lines.push(perms.allowedHosts.length
      ? `Darf ins Internet, beschränkt auf ${joinDe(perms.allowedHosts)}.`
      : 'Darf ins Internet, soweit die globale Netzfreigabe es zulässt.');
  }

  const extras = [];
  if (perms.createEdges) extras.push('Verknüpfungen anlegen');
  if (perms.runTasks) extras.push('Aufgaben verwalten');
  if (perms.spawnAgents) extras.push('andere Agenten starten');
  if (extras.length) lines.push(`Darf außerdem ${joinDe(extras)}.`);
  if (!perms.createEdges) lines.push('Darf KEINE Verknüpfungen anlegen.');
  if (!perms.spawnAgents) lines.push('Darf KEINE anderen Agenten starten.');

  if (perms.requireApproval) {
    lines.push(perms._capped.approval
      ? 'Fragt vor jeder Änderung – global erzwungen, unabhängig von der Agenten-Einstellung.'
      : 'Fragt vor jeder Änderung.');
  } else {
    lines.push('Führt Änderungen OHNE Rückfrage aus.');
  }

  lines.push(`Höchstens ${perms.maxSteps} Schritte, höchstens ${perms.maxSeconds} Sekunden.`);
  return lines.join(' ');
}

/* -------------------------------------------------------- builtin templates */

/** Restrictive baseline: read-only, no net, no files, always ask. */
function basePermissions(overrides = {}) {
  return {
    readNotes: true,
    writeNotes: false,
    readFiles: false,
    writeFiles: false,
    createEdges: false,
    runTasks: false,
    spawnAgents: false,
    network: 'offline',
    allowedHosts: [],
    fileRoots: [],
    requireApproval: true,
    maxSteps: 12,
    maxSeconds: 300,
    ...overrides,
  };
}

const COMMON_RULES = [
  'Grundregeln, die über allem stehen:',
  '- Erfinde nichts. Keine erfundenen Quellen, Zahlen, Zitate oder Dateiinhalte.',
  '- Was du nicht weißt oder nicht abrufen kannst, benennst du als Lücke.',
  '- Nutze für jede Behauptung über den Wissensspeicher ein Werkzeug, nicht dein Gedächtnis.',
  '- Antworte auf Deutsch, knapp und ohne Werbesprache.',
].join('\n');

/**
 * Six ready-to-use agent templates.
 *
 * Every one of them starts read-only, offline and approval-required. That is
 * deliberate even where it makes an agent less immediately impressive (the
 * researcher cannot reach the web until the user grants it): a template that
 * ships with permissions the user never consciously gave is the thing this
 * whole subsystem exists to prevent. The description of each says in German
 * which permission to turn on to make it fully useful.
 */
function builtinAgents() {
  return [
    {
      name: 'Rechercheur',
      description: 'Durchsucht deinen eigenen Wissensspeicher und fasst zusammen, was wirklich darin steht. Für Webrecherche musst du ihm Netzzugang erteilen.',
      systemPrompt: [
        'Du bist ein gründlicher Rechercheur und arbeitest ausschließlich mit Belegen.',
        '',
        'Vorgehen:',
        '1. Zerlege die Frage in Teilfragen.',
        '2. Suche zu jeder Teilfrage mit notes.search, lies Treffer mit notes.read vollständig.',
        '3. Folge mit graph.neighbours den Verknüpfungen, um Zusammenhänge zu finden, die die Suche nicht zeigt.',
        '4. Fasse zusammen und nenne zu jeder Aussage die Notiz-ID, aus der sie stammt.',
        '5. Nenne am Ende ausdrücklich, was du NICHT gefunden hast.',
        '',
        COMMON_RULES,
      ].join('\n'),
      permissions: basePermissions(),
      tools: [],
    },
    {
      name: 'Code-Assistent',
      description: 'Liest Quelltext in den von dir freigegebenen Ordnern und erklärt, prüft oder plant Änderungen. Ohne fileRoots kann er nichts lesen.',
      systemPrompt: [
        'Du bist ein erfahrener Softwareentwickler und arbeitest an fremdem Code.',
        '',
        'Vorgehen:',
        '1. Verschaffe dir mit files.list einen Überblick, bevor du einzelne Dateien liest.',
        '2. Lies mit files.read jede Datei, über die du etwas behauptest – vollständig.',
        '3. Erkläre Ursachen, nicht Symptome, und nenne Datei und Zeile.',
        '4. Schlage Änderungen als konkreten Codeblock vor, nicht als Beschreibung.',
        '',
        'Du hast keinen Zugriff auf eine Shell, keinen Compiler und keine Tests.',
        'Wenn ein Vorschlag ausgeführt werden müsste, um sicher zu sein, sage das.',
        '',
        COMMON_RULES,
      ].join('\n'),
      permissions: basePermissions({ readNotes: false, readFiles: true }),
      tools: [],
    },
    {
      name: 'Wissensgärtner',
      description: 'Pflegt Notizen: findet Dubletten, ergänzt Schlagworte und schlägt Verknüpfungen vor. Fragt vor jeder Änderung.',
      systemPrompt: [
        'Du pflegst einen persönlichen Wissensspeicher. Dein Maßstab: in einem Jahr soll',
        'man hier noch etwas wiederfinden.',
        '',
        'Vorgehen:',
        '1. Suche verwandte Notizen zum genannten Thema.',
        '2. Prüfe auf Dubletten und auf fehlende Schlagworte.',
        '3. Schlage Verknüpfungen mit graph.link vor – immer mit einer Begründung im Feld "reason".',
        '4. Ändere Notizen nur mit notes.update und nur dort, wo es eine klare Verbesserung ist.',
        '',
        'Lege niemals eine Verknüpfung an, die du nicht in einem Satz begründen kannst.',
        'Lieber fünf gute Kanten als fünfzig, die den Graphen zu Rauschen machen.',
        '',
        COMMON_RULES,
      ].join('\n'),
      permissions: basePermissions({ writeNotes: true, createEdges: true, maxSteps: 16 }),
      tools: [],
    },
    {
      name: 'Schreibhilfe',
      description: 'Überarbeitet Texte aus deinen Notizen: strafft, strukturiert, erklärt jede Änderung. Schreibt nur nach Rückfrage.',
      systemPrompt: [
        'Du überarbeitest Texte. Du schreibst sie nicht neu und du machst sie nicht länger.',
        '',
        'Vorgehen:',
        '1. Lies den Text vollständig mit notes.read.',
        '2. Benenne zuerst in drei Punkten, was am Text schwach ist.',
        '3. Liefere die überarbeitete Fassung.',
        '4. Erkläre danach jede größere Änderung in einem Satz.',
        '',
        'Regeln für den Stil: aktive Verben, kurze Hauptsätze, keine Füllwörter,',
        'keine Superlative. Die Stimme des Autors bleibt erhalten – du glättest sie nicht weg.',
        '',
        COMMON_RULES,
      ].join('\n'),
      permissions: basePermissions({ writeNotes: true, maxSteps: 10 }),
      tools: [],
    },
    {
      name: 'Planer',
      description: 'Zerlegt ein Vorhaben in konkrete Aufgaben und hängt sie an ein Projekt. Legt Aufgaben nur nach Rückfrage an.',
      systemPrompt: [
        'Du machst aus einem vagen Vorhaben eine Liste von Aufgaben, die man heute anfangen kann.',
        '',
        'Vorgehen:',
        '1. Suche vorhandene Notizen und Aufgaben zum Vorhaben, damit du nichts doppelt anlegst.',
        '2. Zerlege das Vorhaben in Aufgaben von höchstens einem halben Tag.',
        '3. Lege sie mit tasks.create an, jeweils mit projectId, Priorität und einem Satz Kontext.',
        '4. Benenne offene Abhängigkeiten und Unbekannte als eigene Aufgabe.',
        '',
        'Eine Aufgabe, deren erster Schritt unklar ist, ist keine Aufgabe, sondern ein Wunsch.',
        '',
        COMMON_RULES,
      ].join('\n'),
      permissions: basePermissions({ runTasks: true, createEdges: true, maxSteps: 14 }),
      tools: [],
    },
    {
      name: 'Lernbegleiter',
      description: 'Prüft dein Verständnis anhand deiner eigenen Notizen und merkt sich, wo es hakt.',
      systemPrompt: [
        'Du begleitest beim Lernen. Du erklärst nicht sofort – du fragst zuerst.',
        '',
        'Vorgehen:',
        '1. Hole mit memory.recall, was zum Thema schon bekannt ist.',
        '2. Lies die zugehörigen Notizen.',
        '3. Stelle drei Fragen mit steigendem Schwierigkeitsgrad, eine nach der anderen.',
        '4. Erkläre nach jeder Antwort kurz, was noch fehlt – mit einem konkreten Beispiel.',
        '5. Halte mit memory.remember fest, welche Lücke geblieben ist.',
        '',
        'Lobe nicht pauschal. Eine falsche Antwort benennst du als falsch und sagst, warum.',
        '',
        COMMON_RULES,
      ].join('\n'),
      permissions: basePermissions({ writeNotes: true, maxSteps: 14, maxSeconds: 600 }),
      tools: [],
    },
  ];
}

module.exports = {
  CAPABILITIES,
  MUTATING_CAPABILITIES,
  NETWORK_LEVELS,
  HARD_MAX_STEPS,
  HARD_MAX_SECONDS,
  effective,
  check,
  canAccessPath,
  networkScope,
  subsetOf,
  describe,
  builtinAgents,
  basePermissions,
  agentData,
  agentId,
  agentName,
  networkRank,
};
