'use strict';

const { ValidationError } = require('../kernel/errors');

/**
 * The Neural OS data model.
 *
 * Design notes
 * ------------
 * - EVERYTHING the user creates is a "record" with the same envelope
 *   (id/type/createdAt/updatedAt/deletedAt). That uniformity is what makes the
 *   knowledge graph possible: any record can be a node, any two records can be
 *   connected by an edge, and one storage engine serves all of them.
 * - Edges are records too, so links are first-class, inspectable and revocable.
 *   The user can always ask "why are these two things connected?" and get an
 *   answer (`source`, `reason`), which is the difference between a knowledge
 *   graph and decoration.
 * - Deletes are soft by default (tombstone via `deletedAt`) so an accidental
 *   delete is recoverable. Hard purge is a separate, explicit operation.
 * - Validation is intentionally permissive about extra fields inside `data`
 *   but strict about the envelope and about types it knows. The system should
 *   survive schema evolution without losing user data.
 */

/** Node-ish record types that may appear in the knowledge graph. */
const GRAPH_TYPES = ['note', 'chat', 'project', 'task', 'agent', 'file', 'entity', 'run'];

/** All record types, including non-graph bookkeeping types. */
const TYPES = [...GRAPH_TYPES, 'message', 'edge', 'memory', 'approval', 'grant', 'token', 'peer', 'conflict', 'module', 'suggestion', 'schedule', 'trigger', 'card', 'watch'];

/**
 * Edge kinds. `source` distinguishes user intent from machine inference:
 *   'manual'  - the user drew this link
 *   'derived' - the system inferred it (wiki links, tags, containment)
 *   'agent'   - an agent proposed it; agent links are visually distinct and
 *               can be bulk-reviewed, because unreviewed machine links are how
 *               a knowledge graph turns into noise.
 */
const EDGE_KINDS = [
  'links-to', // explicit [[wiki link]] or manual connection
  'mentions', // text mention of an entity
  'tagged', // shares a tag
  'belongs-to', // containment: task -> project, message -> chat
  'derived-from', // note distilled from a chat, summary of a file
  'produced', // agent run -> artefacts it created
  'uses', // agent -> tool/file it is allowed to touch
  'related', // weak semantic relation
];

const ID_RE = /^[a-z]+_[0-9a-z]{20,32}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(message, details) {
  throw new ValidationError(message, details);
}

/** Field definitions per type: [name, kind, required, default] */
const FIELDS = {
  note: {
    title: { type: 'string', required: true, max: 500 },
    body: { type: 'string', default: '' },
    tags: { type: 'string[]', default: [] },
    pinned: { type: 'boolean', default: false },
    source: { type: 'string', default: 'user' }, // user | agent | import
  },
  chat: {
    title: { type: 'string', default: 'Neuer Chat', max: 500 },
    agentId: { type: 'string', nullable: true, default: null },
    model: { type: 'object', nullable: true, default: null }, // {provider, model}
    systemPrompt: { type: 'string', default: '' },
    // Per-chat network stance. 'inherit' follows the global mode; anything
    // else is a deliberate, visible override for this conversation only.
    network: { type: 'string', default: 'offline', enum: ['offline', 'inherit', 'lan', 'online'] },
    pinned: { type: 'boolean', default: false },
    contextNodeIds: { type: 'string[]', default: [] }, // graph nodes pinned into context
  },
  message: {
    chatId: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['user', 'assistant', 'system', 'tool'] },
    content: { type: 'string', default: '' },
    model: { type: 'object', nullable: true, default: null },
    // Truthful provenance. The UI shows these badges; they are set by the
    // runtime from what actually happened, never optimistically.
    usedNetwork: { type: 'boolean', default: false },
    networkTargets: { type: 'string[]', default: [] },
    toolCalls: { type: 'object[]', default: [] },
    error: { type: 'object', nullable: true, default: null },
    stats: { type: 'object', default: {} }, // {promptTokens, completionTokens, ms}
    status: { type: 'string', default: 'complete', enum: ['streaming', 'complete', 'failed', 'aborted'] },
  },
  project: {
    name: { type: 'string', required: true, max: 500 },
    description: { type: 'string', default: '' },
    status: { type: 'string', default: 'active', enum: ['active', 'paused', 'done', 'archived'] },
    tags: { type: 'string[]', default: [] },
  },
  task: {
    title: { type: 'string', required: true, max: 500 },
    status: { type: 'string', default: 'todo', enum: ['todo', 'doing', 'blocked', 'done'] },
    projectId: { type: 'string', nullable: true, default: null },
    due: { type: 'string', nullable: true, default: null }, // ISO date
    priority: { type: 'number', default: 2 }, // 1 high .. 3 low
    body: { type: 'string', default: '' },
  },
  agent: {
    name: { type: 'string', required: true, max: 200 },
    description: { type: 'string', default: '' },
    systemPrompt: { type: 'string', default: '' },
    model: { type: 'object', nullable: true, default: null },
    /**
     * The capability grant for this agent. Absent capability = denied.
     * Enforced server-side in the tool layer, not merely in the UI.
     */
    permissions: {
      type: 'object',
      default: {
        readNotes: true,
        writeNotes: false,
        readFiles: false,
        writeFiles: false,
        createEdges: false,
        runTasks: false,
        spawnAgents: false,
        network: 'offline', // offline | lan | online
        allowedHosts: [],
        fileRoots: [], // absolute paths the agent may read/write under
        requireApproval: true, // ask before every side effect
        maxSteps: 12,
        maxSeconds: 300,
      },
    },
    tools: { type: 'string[]', default: [] }, // empty = all tools its permissions allow
    builtin: { type: 'boolean', default: false },
  },
  run: {
    agentId: { type: 'string', required: true },
    goal: { type: 'string', default: '' },
    status: { type: 'string', default: 'queued', enum: ['queued', 'running', 'waiting-approval', 'done', 'failed', 'aborted'] },
    steps: { type: 'object[]', default: [] },
    result: { type: 'string', default: '' },
    error: { type: 'object', nullable: true, default: null },
    startedAt: { type: 'string', nullable: true, default: null },
    finishedAt: { type: 'string', nullable: true, default: null },
    usedNetwork: { type: 'boolean', default: false },
    producedIds: { type: 'string[]', default: [] },
  },
  file: {
    name: { type: 'string', required: true },
    hash: { type: 'string', nullable: true, default: null }, // sha256 of content in vault/files
    mime: { type: 'string', default: 'application/octet-stream' },
    size: { type: 'number', default: 0 },
    text: { type: 'string', nullable: true, default: null }, // extracted text, if any
    externalPath: { type: 'string', nullable: true, default: null }, // linked, not copied
    tags: { type: 'string[]', default: [] },
  },
  entity: {
    name: { type: 'string', required: true, max: 300 },
    kind: { type: 'string', default: 'topic', enum: ['topic', 'person', 'place', 'org', 'term', 'other'] },
    description: { type: 'string', default: '' },
    aliases: { type: 'string[]', default: [] },
  },
  edge: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    kind: { type: 'string', default: 'related', enum: EDGE_KINDS },
    weight: { type: 'number', default: 1 },
    source: { type: 'string', default: 'manual', enum: ['manual', 'derived', 'agent'] },
    reason: { type: 'string', default: '' }, // why this link exists, shown in UI
    reviewed: { type: 'boolean', default: false },
  },
  memory: {
    text: { type: 'string', required: true },
    scope: { type: 'string', default: 'global' }, // global | agent:<id> | project:<id>
    importance: { type: 'number', default: 1 },
    sourceId: { type: 'string', nullable: true, default: null },
  },
  approval: {
    runId: { type: 'string', nullable: true, default: null },
    agentId: { type: 'string', nullable: true, default: null },
    kind: { type: 'string', required: true }, // tool | network | spawn
    summary: { type: 'string', default: '' },
    payload: { type: 'object', default: {} },
    status: { type: 'string', default: 'pending', enum: ['pending', 'approved', 'denied', 'expired'] },
    decidedAt: { type: 'string', nullable: true, default: null },
  },
  grant: {
    scope: { type: 'string', required: true }, // global | chat:<id> | agent:<id> | run:<id> | once:<nonce>
    level: { type: 'string', default: 'online', enum: ['lan', 'online'] },
    hosts: { type: 'string[]', default: [] }, // [] means "none"; ['*'] means any
    reason: { type: 'string', default: '' },
    expiresAt: { type: 'string', nullable: true, default: null },
    maxUses: { type: 'number', nullable: true, default: null },
    uses: { type: 'number', default: 0 },
    revoked: { type: 'boolean', default: false },
  },
  /**
   * Another device running Neural OS that this one may synchronise with.
   *
   * The access token is stored here rather than hashed, because unlike an
   * incoming token this one has to be REPLAYED to the peer. It therefore lives
   * in the vault and is covered by vault encryption; config.json, which is
   * never encrypted, must not hold it.
   */
  peer: {
    name: { type: 'string', required: true, max: 200 },
    url: { type: 'string', required: true }, // http://192.168.1.20:7777
    token: { type: 'string', default: '' },
    direction: { type: 'string', default: 'both', enum: ['pull', 'push', 'both'] },
    lastSyncAt: { type: 'string', nullable: true, default: null },
    lastError: { type: 'string', nullable: true, default: null },
    // Highest peer sequence already merged. Sync resumes from here.
    watermark: { type: 'number', default: 0 },
    enabled: { type: 'boolean', default: true },
    autoSync: { type: 'boolean', default: false },
  },
  /**
   * Two devices changed the same record while apart.
   *
   * Both versions are kept verbatim and the user decides. Nothing is merged
   * automatically and nothing is overwritten: a synchronisation that silently
   * picks a winner is how people lose work without ever being told.
   */
  conflict: {
    recordId: { type: 'string', required: true },
    recordType: { type: 'string', required: true },
    peerId: { type: 'string', nullable: true, default: null },
    local: { type: 'object', required: true },
    remote: { type: 'object', required: true },
    status: { type: 'string', default: 'open', enum: ['open', 'resolved'] },
    resolution: { type: 'string', nullable: true, default: null }, // local | remote | merged
    resolvedAt: { type: 'string', nullable: true, default: null },
  },
  /**
   * An extension the user installed by pasting code into the workshop.
   *
   * The full source of every version is kept here on purpose. A change the
   * user cannot undo is a change they cannot safely try, and the entire point
   * of this feature is that experimenting must not cost them their system.
   * `versions` is append-only; `source` is whichever version is active.
   *
   * Capabilities work exactly like an agent's permissions: absent means
   * denied, the user approves them explicitly, and the network ones are
   * enforced by the same gate under the scope `module:<id>`.
   */
  module: {
    name: { type: 'string', required: true, max: 200 },
    description: { type: 'string', default: '' },
    kind: { type: 'string', default: 'ui', enum: ['ui', 'server'] },
    source: { type: 'string', required: true },
    version: { type: 'number', default: 1 },
    /** [{version, source, at, note}] -- every past version, for rollback. */
    versions: { type: 'object[]', default: [] },
    capabilities: { type: 'string[]', default: [] },
    enabled: { type: 'boolean', default: false },
    /**
     * Set when loading or running the module threw. A module that fails is
     * disabled rather than retried into a boot loop, and this is what the
     * workshop shows instead of a blank screen.
     */
    lastError: { type: 'object', nullable: true, default: null },
    /** Counts how often it failed; a repeat offender stays off until reviewed. */
    failures: { type: 'number', default: 0 },
    author: { type: 'string', default: '' },
    builtin: { type: 'boolean', default: false },
  },
  /**
   * Something the system noticed and thinks you might want to do.
   *
   * Suggestions are never applied on their own. That is the whole point: an
   * assistant that quietly edits your notes is one you have to audit, and
   * auditing is more work than doing it yourself. Every suggestion carries
   * what it would change and why, and waits.
   */
  suggestion: {
    kind: { type: 'string', required: true }, // duplicate | orphan | tag | task | revisit | link | distill
    title: { type: 'string', required: true },
    detail: { type: 'string', default: '' },
    /** Why the system thinks so, in the user's language. */
    reason: { type: 'string', default: '' },
    /** Records this is about. First one is the subject. */
    recordIds: { type: 'string[]', default: [] },
    /** What pressing "übernehmen" would do. Inspectable before accepting. */
    action: { type: 'object', nullable: true, default: null },
    confidence: { type: 'number', default: 0.5 },
    status: { type: 'string', default: 'open', enum: ['open', 'accepted', 'dismissed', 'stale'] },
    source: { type: 'string', default: 'assist' }, // assist | agent | module
    decidedAt: { type: 'string', nullable: true, default: null },
  },
  /**
   * An agent that runs on a clock.
   *
   * Deliberately coarse (daily/weekly/hourly rather than cron): a personal
   * system does not need minute-level scheduling, and a cron field is a
   * reliable way to make people run something 1 440 times a day by accident.
   */
  schedule: {
    agentId: { type: 'string', required: true },
    goal: { type: 'string', default: '' },
    every: { type: 'string', default: 'daily', enum: ['hourly', 'daily', 'weekly'] },
    /** Hour of day 0-23 for daily/weekly; weekday 0-6 for weekly. */
    atHour: { type: 'number', default: 8 },
    onWeekday: { type: 'number', default: 1 },
    enabled: { type: 'boolean', default: false },
    lastRunAt: { type: 'string', nullable: true, default: null },
    lastRunId: { type: 'string', nullable: true, default: null },
    nextRunAt: { type: 'string', nullable: true, default: null },
    lastError: { type: 'string', nullable: true, default: null },
    runs: { type: 'number', default: 0 },
  },
  /**
   * An agent that runs when something happens.
   *
   * `debounceMs` is not a nicety: without it, an agent that writes a note in
   * response to a note being written invites an infinite loop, and the user
   * discovers it as a full disk.
   */
  trigger: {
    agentId: { type: 'string', required: true },
    goal: { type: 'string', default: '' },
    on: { type: 'string', default: 'record.created', enum: ['record.created', 'record.updated', 'record.deleted'] },
    recordType: { type: 'string', nullable: true, default: null },
    tag: { type: 'string', nullable: true, default: null },
    titleContains: { type: 'string', nullable: true, default: null },
    enabled: { type: 'boolean', default: false },
    debounceMs: { type: 'number', default: 5000 },
    maxPerHour: { type: 'number', default: 12 },
    firedAt: { type: 'string', nullable: true, default: null },
    fires: { type: 'number', default: 0 },
    lastError: { type: 'string', nullable: true, default: null },
  },
  /**
   * Eine Lernkarte.
   *
   * Das Verfahren ist SM-2 und dreissig Jahre alt: `ease` (wie leicht faellt
   * dir die Karte), `intervalDays` (wann kommt sie wieder) und `due`. Bewusst
   * kein Modell -- Abstandswiederholung braucht keines, und das Nuetzlichste
   * soll nicht der Teil sein, fuer den man 5 GB herunterladen muss.
   *
   * `noteId` haelt die Verbindung zur Quelle, damit man beim Wiederholen
   * nachlesen kann, woher die Frage kommt -- und damit eine geloeschte Notiz
   * ihre Karten nicht zu Waisen macht.
   */
  card: {
    front: { type: 'string', required: true, max: 2000 },
    back: { type: 'string', default: '', max: 8000 },
    noteId: { type: 'string', nullable: true, default: null },
    deck: { type: 'string', default: 'Standard', max: 120 },
    /** SM-2: 1.3 (sehr schwer) bis ~3.0. Startet bei 2.5. */
    ease: { type: 'number', default: 2.5 },
    intervalDays: { type: 'number', default: 0 },
    due: { type: 'string', nullable: true, default: null },
    reps: { type: 'number', default: 0 },
    lapses: { type: 'number', default: 0 },
    lastReviewedAt: { type: 'string', nullable: true, default: null },
    lastGrade: { type: 'number', nullable: true, default: null },
    suspended: { type: 'boolean', default: false },
    source: { type: 'string', default: 'manual' }, // manual | note | agent
  },
  /**
   * Ein beobachteter Ordner.
   *
   * `enabled` ist absichtlich false: ein Ordner, der ab dem Anlegen still
   * Dinge in den Tresor schiebt, ist genau die unsichtbare Automatik, die
   * dieses System sonst vermeidet. Und `imported` zaehlt nicht zur Statistik,
   * sondern damit man sehen kann, was passiert ist.
   *
   * Wird NIE zwischen Geraeten abgeglichen: ein Pfad auf dem einen Rechner
   * existiert auf dem anderen nicht, und eine Freigabe von aussen einzuschalten
   * waere ein Einfallstor.
   */
  watch: {
    path: { type: 'string', required: true, max: 1000 },
    label: { type: 'string', default: '', max: 200 },
    enabled: { type: 'boolean', default: false },
    recursive: { type: 'boolean', default: true },
    /** Leer = alle Endungen, aus denen dieses System Text lesen kann. */
    extensions: { type: 'string[]', default: [] },
    /** Was aufgenommene Dateien an Schlagwoertern bekommen. */
    tags: { type: 'string[]', default: [] },
    maxFileBytes: { type: 'number', default: 25 * 1024 * 1024 },
    lastScanAt: { type: 'string', nullable: true, default: null },
    lastError: { type: 'string', nullable: true, default: null },
    imported: { type: 'number', default: 0 },
    skipped: { type: 'number', default: 0 },
  },
  token: {
    label: { type: 'string', required: true },
    hash: { type: 'string', required: true }, // scrypt hash; raw token never stored
    salt: { type: 'string', required: true },
    permissions: { type: 'object', default: { read: true, write: false, chat: false, agents: false } },
    expiresAt: { type: 'string', nullable: true, default: null },
    lastUsedAt: { type: 'string', nullable: true, default: null },
    revoked: { type: 'boolean', default: false },
  },
};

function checkField(name, def, value, errors) {
  if (value === undefined || value === null) {
    if (def.required) errors.push(`${name} is required`);
    return;
  }
  switch (def.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${name} must be a string`);
      else if (def.max && value.length > def.max) errors.push(`${name} exceeds ${def.max} characters`);
      else if (def.enum && !def.enum.includes(value)) errors.push(`${name} must be one of ${def.enum.join(', ')}`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`${name} must be a number`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${name} must be a boolean`);
      break;
    case 'object':
      if (!isPlainObject(value)) errors.push(`${name} must be an object`);
      break;
    case 'string[]':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) errors.push(`${name} must be an array of strings`);
      break;
    case 'object[]':
      if (!Array.isArray(value) || value.some((v) => !isPlainObject(v))) errors.push(`${name} must be an array of objects`);
      break;
    default:
      break;
  }
}

/**
 * Validate and normalise the `data` payload for a record type.
 * Unknown keys are preserved (forward compatibility), known keys are checked,
 * missing keys are filled from defaults.
 *
 * @param {string} type
 * @param {object} data
 * @param {{partial?:boolean}} [opts] partial=true skips required checks (PATCH)
 * @returns {object} normalised data
 */
function validate(type, data, opts = {}) {
  if (!TYPES.includes(type)) fail(`Unknown record type: ${type}`, { type });
  if (!isPlainObject(data)) fail('Record data must be an object');
  const fields = FIELDS[type] || {};
  const errors = [];
  const out = { ...data };

  for (const [name, def] of Object.entries(fields)) {
    const present = Object.prototype.hasOwnProperty.call(data, name);
    if (!present) {
      if (opts.partial) continue;
      if (def.default !== undefined) {
        out[name] = typeof def.default === 'object' && def.default !== null
          ? JSON.parse(JSON.stringify(def.default))
          : def.default;
        continue;
      }
      if (def.required) errors.push(`${name} is required`);
      continue;
    }
    checkField(name, def, data[name], errors);
  }

  if (errors.length) fail(`Invalid ${type}: ${errors.join('; ')}`, { type, errors });
  return out;
}

/** Deep-merge defaults for agent permissions so old records gain new keys. */
function normalisePermissions(perms) {
  const base = JSON.parse(JSON.stringify(FIELDS.agent.permissions.default));
  return { ...base, ...(isPlainObject(perms) ? perms : {}) };
}

function isGraphType(type) {
  return GRAPH_TYPES.includes(type);
}

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

module.exports = {
  TYPES,
  GRAPH_TYPES,
  EDGE_KINDS,
  FIELDS,
  validate,
  normalisePermissions,
  isGraphType,
  isValidId,
  isPlainObject,
  ID_RE,
};
