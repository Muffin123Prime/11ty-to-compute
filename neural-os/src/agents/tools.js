'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  NeuralError,
  ValidationError,
  NotFoundError,
  PermissionError,
  AbortedError,
} = require('../kernel/errors');
const permissionsMod = require('./permissions');

/**
 * The agent tool layer -- where a capability grant becomes an enforced fact.
 *
 * Why the order inside `call()` is fixed and never varies
 * -------------------------------------------------------
 *   permission -> approval -> execute -> audit
 *
 * Checking the permission first means a forbidden action never even reaches
 * the user as an approval prompt; otherwise the prompt itself becomes a way to
 * talk a user into granting something the policy already refused. Auditing
 * last -- but also on every failure path -- means the trail records attempts,
 * not just successes. A log that only contains what worked cannot answer "what
 * did this agent try to do?", which is the question one actually asks.
 *
 * Three further decisions worth explaining:
 *
 * - `math.eval` contains a real shunting-yard parser. `eval()` and
 *   `new Function()` would hand a language model arbitrary code execution
 *   inside the process that holds the user's entire vault. There is no
 *   "sandboxed eval" in Node worth the name, so the expression language is
 *   small, explicit and interpreted.
 *
 * - `web.fetch` checks the AGENT's permission before it asks the gate. They are
 *   different questions: the gate answers "may this machine reach that host",
 *   the permission answers "may this agent use the network at all". An agent
 *   without `network` must be refused even when the machine is fully online.
 *
 * - Every filesystem tool resolves its argument and hands it to
 *   `permissions.canAccessPath`, which realpath()s before comparing. Tools
 *   never compare path strings themselves.
 */

/* ------------------------------------------------------- argument schemas */

const MAX_TEXT_BYTES = 1024 * 1024; // files.read: a text file, not a disk image
const MAX_LIST_ENTRIES = 500;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const DEFAULT_FETCH_CHARS = 20000;
const MAX_FETCH_CHARS = 100000;
const MAX_EXPRESSION_LENGTH = 500;

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A deliberately small JSON-Schema subset validator: enough to describe every
 * tool's parameters to a model and to reject what a model sends back. Pulling
 * in a full validator would mean a dependency, and the schemas here are ours.
 */
function validateArgs(toolName, schema, input) {
  const args = isPlainObject(input) ? { ...input } : {};
  if (!isPlainObject(input) && input !== undefined && input !== null) {
    throw new ValidationError(`Werkzeug "${toolName}": Parameter müssen ein Objekt sein.`);
  }
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      throw new ValidationError(`Werkzeug "${toolName}": Parameter "${name}" fehlt.`);
    }
  }

  const out = {};
  for (const [name, def] of Object.entries(props)) {
    let value = args[name];
    if (value === undefined || value === null) {
      if (def.default !== undefined) out[name] = JSON.parse(JSON.stringify(def.default));
      continue;
    }
    switch (def.type) {
      case 'string':
        if (typeof value !== 'string') value = String(value);
        if (def.maxLength && value.length > def.maxLength) {
          throw new ValidationError(`Werkzeug "${toolName}": "${name}" ist länger als ${def.maxLength} Zeichen.`);
        }
        if (Array.isArray(def.enum) && !def.enum.includes(value)) {
          throw new ValidationError(`Werkzeug "${toolName}": "${name}" muss einer von ${def.enum.join(', ')} sein.`);
        }
        break;
      case 'integer':
      case 'number': {
        // Models frequently send numbers as strings; accepting a clean numeric
        // string is pragmatism, accepting "ungefähr fünf" is not.
        const n = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(n)) {
          throw new ValidationError(`Werkzeug "${toolName}": "${name}" muss eine Zahl sein.`);
        }
        value = def.type === 'integer' ? Math.trunc(n) : n;
        if (def.minimum !== undefined && value < def.minimum) value = def.minimum;
        if (def.maximum !== undefined && value > def.maximum) value = def.maximum;
        break;
      }
      case 'boolean':
        if (typeof value === 'string') value = value.trim().toLowerCase() === 'true';
        else value = !!value;
        break;
      case 'array': {
        if (typeof value === 'string') {
          // Tolerate "a, b" for a string array: it is unambiguous and common.
          value = value.split(',').map((s) => s.trim()).filter(Boolean);
        }
        if (!Array.isArray(value)) {
          throw new ValidationError(`Werkzeug "${toolName}": "${name}" muss eine Liste sein.`);
        }
        if (def.items && def.items.type === 'string') value = value.map((v) => String(v));
        if (def.maxItems && value.length > def.maxItems) value = value.slice(0, def.maxItems);
        break;
      }
      case 'object':
        if (!isPlainObject(value)) {
          throw new ValidationError(`Werkzeug "${toolName}": "${name}" muss ein Objekt sein.`);
        }
        break;
      default:
        break;
    }
    out[name] = value;
  }
  return out;
}

/* ------------------------------------------------------ math.eval (no eval) */

const MATH_CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const MATH_FUNCTIONS = {
  sqrt: { arity: 1, fn: (a) => Math.sqrt(a) },
  abs: { arity: 1, fn: (a) => Math.abs(a) },
  round: { arity: 1, fn: (a) => Math.round(a) },
  floor: { arity: 1, fn: (a) => Math.floor(a) },
  ceil: { arity: 1, fn: (a) => Math.ceil(a) },
  trunc: { arity: 1, fn: (a) => Math.trunc(a) },
  sign: { arity: 1, fn: (a) => Math.sign(a) },
  ln: { arity: 1, fn: (a) => Math.log(a) },
  log: { arity: 1, fn: (a) => Math.log10(a) },
  log2: { arity: 1, fn: (a) => Math.log2(a) },
  exp: { arity: 1, fn: (a) => Math.exp(a) },
  sin: { arity: 1, fn: (a) => Math.sin(a) },
  cos: { arity: 1, fn: (a) => Math.cos(a) },
  tan: { arity: 1, fn: (a) => Math.tan(a) },
  asin: { arity: 1, fn: (a) => Math.asin(a) },
  acos: { arity: 1, fn: (a) => Math.acos(a) },
  atan: { arity: 1, fn: (a) => Math.atan(a) },
  pow: { arity: 2, fn: (a, b) => Math.pow(a, b) },
  mod: { arity: 2, fn: (a, b) => a % b },
  min: { arity: -1, fn: (...a) => Math.min(...a) },
  max: { arity: -1, fn: (...a) => Math.max(...a) },
  hypot: { arity: -1, fn: (...a) => Math.hypot(...a) },
};

const OPERATORS = {
  '+': { precedence: 2, right: false, arity: 2, fn: (a, b) => a + b },
  '-': { precedence: 2, right: false, arity: 2, fn: (a, b) => a - b },
  '*': { precedence: 3, right: false, arity: 2, fn: (a, b) => a * b },
  '/': { precedence: 3, right: false, arity: 2, fn: (a, b) => a / b },
  '%': { precedence: 3, right: false, arity: 2, fn: (a, b) => a % b },
  // Unary binds tighter than the binary operators but looser than '^', so
  // -2^2 is -(2^2) = -4, which is what every calculator and every reader means.
  'u-': { precedence: 4, right: true, arity: 1, fn: (a) => -a },
  'u+': { precedence: 4, right: true, arity: 1, fn: (a) => a },
  '^': { precedence: 5, right: true, arity: 2, fn: (a, b) => Math.pow(a, b) },
};

function tokenizeExpression(text) {
  const tokens = [];
  let i = 0;
  const s = text;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      const m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      tokens.push({ kind: 'number', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '.') {
      const m = /^\.\d+(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new ValidationError(`Unerwartetes Zeichen "." an Position ${i + 1}.`);
      tokens.push({ kind: 'number', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      const m = /^[a-zA-Z][a-zA-Z0-9]*/.exec(s.slice(i));
      const name = m[0].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(MATH_CONSTANTS, name)) {
        tokens.push({ kind: 'number', value: MATH_CONSTANTS[name] });
      } else if (Object.prototype.hasOwnProperty.call(MATH_FUNCTIONS, name)) {
        tokens.push({ kind: 'function', value: name });
      } else {
        throw new ValidationError(`Unbekannter Name "${m[0]}". Erlaubt sind: ${Object.keys(MATH_FUNCTIONS).concat(Object.keys(MATH_CONSTANTS)).join(', ')}.`);
      }
      i += m[0].length;
      continue;
    }
    if (ch === '(' || ch === ')') { tokens.push({ kind: ch }); i++; continue; }
    if (ch === ',' || ch === ';') { tokens.push({ kind: ',' }); i++; continue; }
    if (ch === '*' && s[i + 1] === '*') { tokens.push({ kind: 'operator', value: '^' }); i += 2; continue; }
    if (Object.prototype.hasOwnProperty.call(OPERATORS, ch)) { tokens.push({ kind: 'operator', value: ch }); i++; continue; }
    throw new ValidationError(`Unerlaubtes Zeichen "${ch}" an Position ${i + 1}.`);
  }
  return tokens;
}

/** Infix tokens -> reverse Polish notation (shunting yard). */
function toRPN(tokens) {
  const output = [];
  const stack = [];
  const argCounts = [];
  let previous = null;

  const expectsValue = () => previous === null
    || previous.kind === 'operator'
    || previous.kind === '('
    || previous.kind === ',';

  for (const token of tokens) {
    if (token.kind === 'number') {
      if (previous && (previous.kind === 'number' || previous.kind === ')')) {
        throw new ValidationError('Zwei Werte ohne Rechenzeichen dazwischen.');
      }
      output.push(token);
    } else if (token.kind === 'function') {
      stack.push(token);
    } else if (token.kind === 'operator') {
      let op = token.value;
      if (expectsValue()) {
        if (op === '-') op = 'u-';
        else if (op === '+') op = 'u+';
        else throw new ValidationError(`Rechenzeichen "${op}" steht an einer Stelle, an der ein Wert erwartet wird.`);
      }
      const def = OPERATORS[op];
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.kind !== 'operator') break;
        const topDef = OPERATORS[top.value];
        if (topDef.precedence > def.precedence || (topDef.precedence === def.precedence && !def.right)) {
          output.push(stack.pop());
        } else break;
      }
      stack.push({ kind: 'operator', value: op });
    } else if (token.kind === '(') {
      if (previous && previous.kind === 'function') argCounts.push(1);
      stack.push(token);
    } else if (token.kind === ',') {
      if (!argCounts.length) throw new ValidationError('Komma außerhalb eines Funktionsaufrufs.');
      while (stack.length && stack[stack.length - 1].kind !== '(') output.push(stack.pop());
      if (!stack.length) throw new ValidationError('Komma ohne öffnende Klammer.');
      argCounts[argCounts.length - 1]++;
    } else if (token.kind === ')') {
      while (stack.length && stack[stack.length - 1].kind !== '(') output.push(stack.pop());
      if (!stack.length) throw new ValidationError('Schließende Klammer ohne öffnende.');
      stack.pop();
      if (stack.length && stack[stack.length - 1].kind === 'function') {
        const fn = stack.pop();
        const count = argCounts.pop();
        output.push({ kind: 'call', value: fn.value, argCount: count });
      }
    }
    previous = token;
  }

  while (stack.length) {
    const top = stack.pop();
    if (top.kind === '(') throw new ValidationError('Es fehlt eine schließende Klammer.');
    if (top.kind === 'function') throw new ValidationError(`Funktion "${top.value}" ohne Klammern.`);
    output.push(top);
  }
  return output;
}

function evaluateRPN(rpn) {
  const stack = [];
  for (const token of rpn) {
    if (token.kind === 'number') {
      stack.push(token.value);
      continue;
    }
    if (token.kind === 'operator') {
      const def = OPERATORS[token.value];
      if (stack.length < def.arity) throw new ValidationError(`Dem Rechenzeichen "${token.value.replace('u', '')}" fehlt ein Wert.`);
      const args = stack.splice(stack.length - def.arity, def.arity);
      stack.push(def.fn(...args));
      continue;
    }
    if (token.kind === 'call') {
      const def = MATH_FUNCTIONS[token.value];
      if (def.arity !== -1 && def.arity !== token.argCount) {
        throw new ValidationError(`Funktion "${token.value}" erwartet ${def.arity} Argument(e), bekam ${token.argCount}.`);
      }
      if (stack.length < token.argCount) throw new ValidationError(`Funktion "${token.value}" fehlen Argumente.`);
      const args = stack.splice(stack.length - token.argCount, token.argCount);
      stack.push(def.fn(...args));
      continue;
    }
    throw new ValidationError('Unverständlicher Ausdruck.');
  }
  if (stack.length !== 1) throw new ValidationError('Der Ausdruck ergibt keinen einzelnen Wert.');
  return stack[0];
}

/**
 * Evaluate an arithmetic expression without `eval` or `new Function`.
 * @param {string} expression decimal point is '.', ',' separates arguments
 * @returns {number}
 */
function evaluateExpression(expression) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new ValidationError('math.eval braucht einen Ausdruck.');
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ValidationError(`Der Ausdruck ist länger als ${MAX_EXPRESSION_LENGTH} Zeichen.`);
  }
  const tokens = tokenizeExpression(expression);
  if (!tokens.length) throw new ValidationError('Der Ausdruck ist leer.');
  const result = evaluateRPN(toRPN(tokens));
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new ValidationError(`Das Ergebnis ist keine endliche Zahl (${String(result)}). Division durch null?`);
  }
  return result;
}

/* ------------------------------------------------------------ HTML -> text */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  bdquo: '„', ldquo: '“', rdquo: '”', sbquo: '‚', lsquo: '‘', rsquo: '’', euro: '€', copy: '©',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

/**
 * Extract readable text from an HTML document.
 *
 * Scripts, styles and comments go first and unconditionally. A model that is
 * handed minified JavaScript as "page content" will quote it back as fact, and
 * an HTML comment is exactly the place where a page can put instructions aimed
 * at whatever is reading it.
 */
function htmlToText(html) {
  let s = String(html);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'head']) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    // A truncated document can leave an unterminated opener; everything after
    // it is unreadable anyway, so drop it rather than leak code into the text.
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ');
  }
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table)\s*>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t\f\v ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return { title, text: s.trim() };
}

/* ----------------------------------------------------------------- toolbox */

const extract = (() => {
  // Optional: a device without the extraction module keeps every other tool.
  try {
    return require('../store/extract');
  } catch {
    return null;
  }
})();


/**
 * Which agent capability a module capability corresponds to.
 *
 * A module tool must never give an agent more reach than the agent already
 * has. The module's own capabilities bound what its code can do; this table
 * bounds who may trigger it. Without it, a read-only agent could call a tool
 * from a module holding write access and perform, by proxy, exactly what its
 * own permissions forbid -- the same privilege ladder that `subsetOf` closes
 * for spawned agents.
 */
const MODULE_TO_AGENT_CAPABILITY = {
  'records.read': 'readNotes',
  'records.write': 'writeNotes',
  'files.read': 'readFiles',
  'files.write': 'writeFiles',
};

/** Network level a module holds, in the agent's own vocabulary. */
function moduleNetworkLevel(caps) {
  const set = new Set(caps || []);
  if (set.has('net.online')) return 'online';
  if (set.has('net.lan')) return 'lan';
  return 'offline';
}

function createToolbox({ store, registry, gate, graph, paths, approvals, config, logger, audit } = {}) {
  if (!store || typeof store.create !== 'function') {
    throw new ValidationError('createToolbox benötigt einen Store.');
  }
  const log = typeof logger === 'function' ? logger('tools') : nullLogger();
  const cfg = isPlainObject(config) ? config : {};
  /** Set by the runtime after construction; breaks the tools <-> runtime cycle. */
  let runtime = null;

  function writeAudit(kind, data) {
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write(kind, data);
    } catch (err) {
      log.warn(`Audit-Eintrag ${kind} fehlgeschlagen: ${err && err.message}`);
    }
  }

  function agentOf(ctx) {
    if (!ctx || !ctx.agent) throw new ValidationError('Werkzeugaufruf ohne Agent-Kontext.');
    return ctx.agent;
  }

  function permsOf(ctx) {
    if (ctx && ctx._perms) return ctx._perms;
    const perms = permissionsMod.effective(agentOf(ctx), cfg);
    if (ctx) ctx._perms = perms;
    return perms;
  }

  function assertNotAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
      throw new AbortedError('Der Lauf wurde abgebrochen.');
    }
  }

  /** Record ids an agent produced, so the run can link to them afterwards. */
  function noteProduced(ctx, id) {
    if (ctx && Array.isArray(ctx.produced) && id && !ctx.produced.includes(id)) ctx.produced.push(id);
    return id;
  }

  function resolveAgentPath(ctx, raw) {
    const perms = permsOf(ctx);
    if (typeof raw !== 'string' || !raw.trim()) throw new ValidationError('Es fehlt ein Pfad.');
    const trimmed = raw.trim();
    if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
    if (!perms.fileRoots.length) {
      throw new PermissionError('Für diesen Agenten ist kein Ordner freigegeben.');
    }
    // A relative path is relative to the first granted root -- the only
    // interpretation that cannot silently mean "the server's cwd".
    return path.resolve(perms.fileRoots[0], trimmed);
  }

  function requireRecord(id, type) {
    if (typeof id !== 'string' || !id) throw new ValidationError('Es fehlt eine Datensatz-ID.');
    const record = store.get(id);
    if (!record || (type && record.type !== type)) {
      throw new NotFoundError(type ? `${type} ${id}` : `Datensatz ${id}`);
    }
    return record;
  }

  function shorten(text, max = 400) {
    const s = String(text === undefined || text === null ? '' : text);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  function noteSummary(record) {
    return {
      id: record.id,
      title: record.data.title,
      tags: record.data.tags || [],
      updatedAt: record.updatedAt,
      excerpt: shorten(record.data.body, 300),
    };
  }

  function labelOf(record) {
    if (graph && typeof graph.label === 'function') {
      try { return graph.label(record); } catch { /* fall through to the local label */ }
    }
    const d = record.data || {};
    return d.title || d.name || d.text || d.goal || record.id;
  }

  /* ------------------------------------------------------------ definitions */

  const definitions = [
    {
      name: 'notes.search',
      capability: 'readNotes',
      mutating: false,
      description: 'Durchsucht Notizen im Wissensspeicher nach Stichworten. Unterstützt tag:foo und "genaue Phrase".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Suchbegriff', maxLength: 500 },
          limit: { type: 'integer', description: 'Höchstzahl Treffer (1-25)', default: 8, minimum: 1, maximum: 25 },
        },
        required: ['query'],
      },
      run(args) {
        let hits = [];
        try {
          const result = store.search(args.query, { types: ['note'], limit: args.limit });
          hits = result.items.map((hit) => ({ ...noteSummary(hit.record), score: hit.score, snippet: hit.snippet }));
        } catch (err) {
          // The search index is a separate subsystem. If it is unavailable the
          // honest fallback is a slower literal scan, not an empty result that
          // the model would read as "nothing exists".
          log.warn(`Suchindex nicht verfügbar, fallback auf Linearsuche: ${err && err.message}`);
          const needle = args.query.toLowerCase();
          hits = store.all('note')
            .filter((r) => `${r.data.title} ${r.data.body}`.toLowerCase().includes(needle))
            .slice(0, args.limit)
            .map((r) => ({ ...noteSummary(r), score: null, snippet: null }));
        }
        return { query: args.query, count: hits.length, hits };
      },
    },
    {
      name: 'notes.read',
      capability: 'readNotes',
      mutating: false,
      description: 'Liest eine Notiz vollständig, anhand ihrer ID.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'ID der Notiz, z. B. note_ab12…' } },
        required: ['id'],
      },
      run(args) {
        const record = requireRecord(args.id, 'note');
        return {
          id: record.id,
          title: record.data.title,
          body: record.data.body,
          tags: record.data.tags || [],
          pinned: record.data.pinned === true,
          updatedAt: record.updatedAt,
        };
      },
    },
    {
      name: 'notes.create',
      capability: 'writeNotes',
      mutating: true,
      description: 'Legt eine neue Notiz an.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 500, description: 'Titel der Notiz' },
          body: { type: 'string', default: '', description: 'Inhalt in Markdown' },
          tags: { type: 'array', items: { type: 'string' }, default: [], maxItems: 20, description: 'Schlagworte ohne #' },
        },
        required: ['title'],
      },
      summary: (args) => `Neue Notiz anlegen: "${shorten(args.title, 80)}"`,
      run(args, ctx) {
        const record = store.create('note', {
          title: args.title,
          body: args.body || '',
          tags: args.tags || [],
          source: 'agent',
        });
        noteProduced(ctx, record.id);
        return { id: record.id, title: record.data.title, createdAt: record.createdAt };
      },
    },
    {
      name: 'notes.update',
      capability: 'writeNotes',
      mutating: true,
      description: 'Ändert Titel, Inhalt oder Schlagworte einer vorhandenen Notiz.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID der Notiz' },
          title: { type: 'string', maxLength: 500 },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          append: { type: 'boolean', default: false, description: 'body anhängen statt ersetzen' },
        },
        required: ['id'],
      },
      summary: (args) => `Notiz ${args.id} ändern`,
      run(args, ctx) {
        const record = requireRecord(args.id, 'note');
        const patch = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.tags !== undefined) patch.tags = args.tags;
        if (args.body !== undefined) {
          patch.body = args.append ? `${record.data.body || ''}\n\n${args.body}`.trim() : args.body;
        }
        if (!Object.keys(patch).length) {
          throw new ValidationError('notes.update braucht mindestens ein zu änderndes Feld.');
        }
        const updated = store.update(record.id, patch);
        noteProduced(ctx, updated.id);
        return { id: updated.id, rev: updated.rev, updatedAt: updated.updatedAt };
      },
    },
    {
      name: 'graph.neighbours',
      capability: 'readNotes',
      mutating: false,
      description: 'Zeigt die im Wissensgraphen direkt oder indirekt verbundenen Datensätze.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID des Ausgangsknotens' },
          depth: { type: 'integer', default: 1, minimum: 1, maximum: 3 },
          limit: { type: 'integer', default: 25, minimum: 1, maximum: 100 },
        },
        required: ['id'],
      },
      run(args) {
        requireRecord(args.id);
        const result = store.edges.neighbours(args.id, { depth: args.depth, limit: args.limit });
        return {
          focus: args.id,
          truncated: result.truncated,
          nodes: result.nodes.map((n) => ({ id: n.id, type: n.type, label: labelOf(n) })),
          edges: result.edges.map((e) => ({
            from: e.data.from, to: e.data.to, kind: e.data.kind,
            source: e.data.source, reason: e.data.reason,
          })),
        };
      },
    },
    {
      name: 'graph.link',
      capability: 'createEdges',
      mutating: true,
      description: 'Verknüpft zwei Datensätze im Wissensgraphen. Die Begründung ist Pflicht und wird dem Nutzer angezeigt.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'ID des Ausgangsknotens' },
          to: { type: 'string', description: 'ID des Zielknotens' },
          kind: {
            type: 'string', default: 'related',
            enum: ['links-to', 'mentions', 'tagged', 'belongs-to', 'derived-from', 'produced', 'uses', 'related'],
          },
          reason: { type: 'string', maxLength: 500, description: 'Warum gehören die beiden zusammen?' },
        },
        required: ['from', 'to', 'reason'],
      },
      summary: (args) => `Verknüpfung ${args.from} → ${args.to} (${args.kind || 'related'}): ${shorten(args.reason, 120)}`,
      run(args, ctx) {
        requireRecord(args.from);
        requireRecord(args.to);
        // Always source 'agent': the user must be able to review and bulk-undo
        // machine links, and an agent link must never masquerade as a manual one.
        const edge = store.edges.add({
          from: args.from, to: args.to, kind: args.kind || 'related',
          source: 'agent', reason: args.reason,
        });
        noteProduced(ctx, edge.id);
        return { id: edge.id, from: edge.data.from, to: edge.data.to, kind: edge.data.kind };
      },
    },
    {
      name: 'tasks.create',
      capability: 'runTasks',
      mutating: true,
      description: 'Legt eine Aufgabe an, optional in einem Projekt.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 500 },
          projectId: { type: 'string', description: 'ID des Projekts, optional' },
          body: { type: 'string', default: '' },
          due: { type: 'string', description: 'Fälligkeit als ISO-Datum, optional' },
          priority: { type: 'integer', default: 2, minimum: 1, maximum: 3, description: '1 hoch, 3 niedrig' },
        },
        required: ['title'],
      },
      summary: (args) => `Aufgabe anlegen: "${shorten(args.title, 80)}"`,
      run(args, ctx) {
        if (args.projectId) requireRecord(args.projectId, 'project');
        const record = store.create('task', {
          title: args.title,
          body: args.body || '',
          projectId: args.projectId || null,
          due: args.due || null,
          priority: args.priority,
        });
        noteProduced(ctx, record.id);
        return { id: record.id, title: record.data.title, status: record.data.status };
      },
    },
    {
      name: 'tasks.update',
      capability: 'runTasks',
      mutating: true,
      description: 'Ändert eine Aufgabe, etwa ihren Status.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] },
          title: { type: 'string', maxLength: 500 },
          body: { type: 'string' },
          due: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 3 },
        },
        required: ['id'],
      },
      summary: (args) => `Aufgabe ${args.id} ändern${args.status ? ` (Status: ${args.status})` : ''}`,
      run(args, ctx) {
        const record = requireRecord(args.id, 'task');
        const patch = {};
        for (const key of ['status', 'title', 'body', 'due', 'priority']) {
          if (args[key] !== undefined) patch[key] = args[key];
        }
        if (!Object.keys(patch).length) throw new ValidationError('tasks.update braucht mindestens ein Feld.');
        const updated = store.update(record.id, patch);
        noteProduced(ctx, updated.id);
        return { id: updated.id, status: updated.data.status, rev: updated.rev };
      },
    },
    {
      name: 'files.list',
      capability: 'readFiles',
      mutating: false,
      description: 'Listet Dateien und Ordner in einem freigegebenen Verzeichnis.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absoluter Pfad oder relativ zum ersten freigegebenen Ordner', default: '.' },
        },
        required: [],
      },
      run(args, ctx) {
        const target = resolveAgentPath(ctx, args.path || '.');
        assertPathAllowed(ctx, target, 'readFiles');
        let entries;
        try {
          entries = fs.readdirSync(target, { withFileTypes: true });
        } catch (err) {
          if (err.code === 'ENOENT') throw new NotFoundError(`Ordner ${target}`);
          if (err.code === 'ENOTDIR') throw new ValidationError(`${target} ist kein Ordner.`);
          if (err.code === 'EACCES') throw new PermissionError(`Kein Lesezugriff auf ${target}.`);
          throw new NeuralError('FS_ERROR', `Ordner ${target} nicht lesbar: ${err.message}`, { status: 500 });
        }
        const out = [];
        for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
          const full = path.join(target, entry.name);
          // A symlink inside a granted root can point anywhere; it is listed
          // only when its real destination is also inside a granted root.
          if (!permissionsMod.canAccessPath(agentOf(ctx), full, { permissions: permsOf(ctx) })) continue;
          let size = null;
          try { size = entry.isFile() ? fs.statSync(full).size : null; } catch { size = null; }
          out.push({ name: entry.name, path: full, type: entry.isDirectory() ? 'dir' : 'file', size });
        }
        return { path: target, count: out.length, truncated: entries.length > MAX_LIST_ENTRIES, entries: out };
      },
    },
    {
      name: 'files.read',
      capability: 'readFiles',
      mutating: false,
      description: 'Liest eine Textdatei aus einem freigegebenen Ordner.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absoluter Pfad oder relativ zum ersten freigegebenen Ordner' },
          maxBytes: { type: 'integer', default: 200000, minimum: 1, maximum: MAX_TEXT_BYTES },
        },
        required: ['path'],
      },
      run(args, ctx) {
        const target = resolveAgentPath(ctx, args.path);
        assertPathAllowed(ctx, target, 'readFiles');
        let stat;
        try {
          stat = fs.statSync(target);
        } catch (err) {
          if (err.code === 'ENOENT') throw new NotFoundError(`Datei ${target}`);
          throw new NeuralError('FS_ERROR', `Datei ${target} nicht lesbar: ${err.message}`, { status: 500 });
        }
        if (stat.isDirectory()) throw new ValidationError(`${target} ist ein Ordner, keine Datei.`);
        const limit = Math.min(args.maxBytes, MAX_TEXT_BYTES);
        let buffer;
        try {
          const fd = fs.openSync(target, 'r');
          try {
            buffer = Buffer.alloc(Math.min(stat.size, limit));
            fs.readSync(fd, buffer, 0, buffer.length, 0);
          } finally {
            fs.closeSync(fd);
          }
        } catch (err) {
          if (err.code === 'EACCES') throw new PermissionError(`Kein Lesezugriff auf ${target}.`);
          throw new NeuralError('FS_ERROR', `Datei ${target} nicht lesbar: ${err.message}`, { status: 500 });
        }
        // A PDF, a Word document or a spreadsheet is not "not a text file" --
        // it is a text file the agent cannot read by itself. Refusing it used
        // to leave the model to guess what was inside, which is exactly the
        // kind of gap an agent fills with invention.
        if (buffer.includes(0)) {
          if (!extract || typeof extract.extractText !== 'function') {
            throw new ValidationError(
              `${target} ist keine Textdatei, und die Textextraktion ist auf diesem Gerät nicht verfügbar.`,
            );
          }
          let extracted;
          try {
            extracted = extract.extractText(buffer, { name: target, maxBytes: limit });
          } catch (err) {
            throw new ValidationError(
              `Aus ${target} liess sich kein Text gewinnen: ${err && err.message}`,
            );
          }
          // Warnings travel to the model verbatim. A scanned PDF has no text
          // layer, and the model must be told that rather than handed an empty
          // string it will happily paper over.
          return {
            path: target,
            size: stat.size,
            kind: extracted.kind,
            pages: extracted.pages,
            truncated: extracted.truncated || stat.size > buffer.length,
            warnings: extracted.warnings || [],
            text: extracted.text,
          };
        }
        return {
          path: target,
          size: stat.size,
          kind: 'text',
          truncated: stat.size > buffer.length,
          warnings: [],
          text: buffer.toString('utf8'),
        };
      },
    },
    {
      name: 'files.write',
      capability: 'writeFiles',
      mutating: true,
      description: 'Schreibt eine Textdatei in einen freigegebenen Ordner.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          mode: { type: 'string', enum: ['overwrite', 'append', 'create'], default: 'create', description: 'create scheitert, wenn die Datei existiert' },
        },
        required: ['path', 'content'],
      },
      summary: (args) => `Datei schreiben (${args.mode || 'create'}): ${args.path}`,
      run(args, ctx) {
        const target = resolveAgentPath(ctx, args.path);
        assertPathAllowed(ctx, target, 'writeFiles');
        const mode = args.mode || 'create';
        const exists = fs.existsSync(target);
        if (mode === 'create' && exists) {
          throw new ValidationError(`${target} existiert bereits. Nutze mode "overwrite" oder "append".`);
        }
        const dir = path.dirname(target);
        // The parent directory is checked separately: creating it is itself a
        // write, and mkdir -p could otherwise materialise a path outside a root.
        assertPathAllowed(ctx, dir, 'writeFiles');
        try {
          fs.mkdirSync(dir, { recursive: true });
          if (mode === 'append') {
            fs.appendFileSync(target, args.content, 'utf8');
          } else {
            // Temp file in the same directory + rename: a crash mid-write must
            // not leave a half-written file where a whole one used to be.
            const tmp = `${target}.nos-tmp-${process.pid}`;
            fs.writeFileSync(tmp, args.content, 'utf8');
            fs.renameSync(tmp, target);
          }
        } catch (err) {
          if (err.code === 'EACCES' || err.code === 'EPERM') throw new PermissionError(`Kein Schreibzugriff auf ${target}.`);
          throw new NeuralError('FS_ERROR', `Datei ${target} nicht schreibbar: ${err.message}`, { status: 500 });
        }
        const size = Buffer.byteLength(args.content, 'utf8');
        return { path: target, bytes: size, mode };
      },
    },
    {
      name: 'memory.remember',
      capability: 'writeNotes',
      mutating: true,
      description: 'Merkt sich eine kurze Tatsache dauerhaft, damit sie in späteren Läufen wieder zur Verfügung steht.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 2000, description: 'Ein Satz, nicht ein Aufsatz' },
          importance: { type: 'integer', default: 1, minimum: 1, maximum: 3 },
          scope: { type: 'string', default: 'agent', enum: ['agent', 'global'], description: 'agent = nur dieser Agent' },
        },
        required: ['text'],
      },
      summary: (args) => `Merken: "${shorten(args.text, 100)}"`,
      run(args, ctx) {
        const id = permissionsMod.agentId(agentOf(ctx));
        const record = store.create('memory', {
          text: args.text,
          scope: args.scope === 'global' || !id ? 'global' : `agent:${id}`,
          importance: args.importance,
          sourceId: ctx && ctx.run ? ctx.run.id : null,
        });
        noteProduced(ctx, record.id);
        return { id: record.id, scope: record.data.scope };
      },
    },
    {
      name: 'memory.recall',
      capability: 'readNotes',
      mutating: false,
      description: 'Holt früher gemerkte Tatsachen zu einem Stichwort.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 300, default: '' },
          limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
        },
        required: [],
      },
      run(args, ctx) {
        const id = permissionsMod.agentId(agentOf(ctx));
        const mine = new Set(['global', id ? `agent:${id}` : null].filter(Boolean));
        const all = store.all('memory').filter((r) => mine.has(r.data.scope));
        const terms = String(args.query || '').toLowerCase().split(/[^0-9a-zäöüß]+/).filter((t) => t.length >= 2);
        const scored = all.map((r) => {
          const text = String(r.data.text || '').toLowerCase();
          const score = terms.length ? terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0) : 0;
          return { record: r, score };
        });
        const matching = terms.length ? scored.filter((s) => s.score > 0) : scored;
        matching.sort((a, b) => (b.score - a.score) || (Number(b.record.data.importance || 1) - Number(a.record.data.importance || 1))
          || (a.record.createdAt < b.record.createdAt ? 1 : -1));
        return {
          count: matching.length,
          items: matching.slice(0, args.limit).map((s) => ({
            id: s.record.id, text: s.record.data.text,
            importance: s.record.data.importance, at: s.record.createdAt,
          })),
        };
      },
    },
    {
      name: 'web.fetch',
      capability: 'network',
      mutating: true,
      description: 'Ruft eine Webseite ab und liefert ihren Text (ohne Skripte und Formatierung). Nur erlaubt, wenn dieser Agent Netzzugang hat.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', maxLength: 2000, description: 'Vollständige http(s)-Adresse' },
          maxChars: { type: 'integer', default: DEFAULT_FETCH_CHARS, minimum: 500, maximum: MAX_FETCH_CHARS },
        },
        required: ['url'],
      },
      summary: (args) => `Webseite abrufen: ${shorten(args.url, 160)}`,
      capabilityContext(args) {
        try {
          const parsed = new URL(args.url);
          return {
            host: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
            level: requiredLevelFor(parsed.hostname),
          };
        } catch {
          return {};
        }
      },
      async run(args, ctx) {
        if (!gate || typeof gate.fetch !== 'function') {
          throw new NeuralError('NETWORK_UNAVAILABLE', 'Die Netz-Schleuse ist nicht verfügbar; es wird nichts abgerufen.', { status: 503 });
        }
        let parsed;
        try {
          parsed = new URL(args.url);
        } catch {
          throw new ValidationError(`Ungültige Adresse: ${shorten(args.url, 120)}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new ValidationError('Nur http und https sind erlaubt.');
        }
        const perms = permsOf(ctx);
        const response = await gate.fetch(parsed.toString(), {
          scope: ctx.scope,
          // The agent's own ceiling, enforced per hop: a redirect cannot walk
          // it onto a host or a class its permissions never allowed.
          maxLevel: perms && perms.network ? perms.network : 'offline',
          allowedHosts: Array.isArray(perms && perms.allowedHosts) && perms.allowedHosts.length
            ? perms.allowedHosts
            : null,
          purpose: `Agent "${permissionsMod.agentName(agentOf(ctx))}" ruft ${parsed.hostname} ab`,
          signal: ctx.signal,
          timeoutMs: 20000,
          maxBytes: MAX_FETCH_BYTES,
          headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.1' },
        });
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        const raw = await response.text();
        const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(raw);
        const extracted = isHtml ? htmlToText(raw) : { title: '', text: raw };
        const limit = Math.min(args.maxChars, MAX_FETCH_CHARS);
        const text = extracted.text.slice(0, limit);
        return {
          url: response.url,
          status: response.status,
          contentType: contentType || null,
          title: extracted.title || null,
          truncated: extracted.text.length > text.length,
          text,
        };
      },
    },
    {
      name: 'agents.spawn',
      capability: 'spawnAgents',
      mutating: true,
      description: 'Startet einen anderen Agenten mit einem eigenen Auftrag. Der Unteragent darf nichts, was dieser Agent nicht auch darf.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'ID des zu startenden Agenten' },
          goal: { type: 'string', maxLength: 2000, description: 'Auftrag für den Unteragenten' },
        },
        required: ['agentId', 'goal'],
      },
      summary: (args) => `Unteragent ${args.agentId} starten: "${shorten(args.goal, 100)}"`,
      async run(args, ctx) {
        if (!runtime || typeof runtime.start !== 'function') {
          throw new NeuralError('RUNTIME_UNAVAILABLE', 'Die Agenten-Laufzeit ist nicht verfügbar; es wird kein Unteragent gestartet.', { status: 503 });
        }
        const depth = Number(ctx && ctx.depth) || 0;
        if (depth >= 2) {
          throw new PermissionError('Verschachtelungstiefe erreicht: ein Unteragent darf keine weiteren Unteragenten starten.');
        }
        const child = requireRecord(args.agentId, 'agent');
        const parent = agentOf(ctx);
        if (permissionsMod.agentId(parent) === child.id) {
          throw new ValidationError('Ein Agent darf sich nicht selbst starten.');
        }
        const subset = permissionsMod.subsetOf(child, parent, cfg);
        if (!subset.ok) {
          throw new PermissionError(
            `Unteragent "${child.data.name}" verlangt mehr Rechte als der startende Agent hat: ${subset.missing.join(', ')}.`,
            { missing: subset.missing },
          );
        }
        const run = await runtime.start({
          agentId: child.id,
          goal: args.goal,
          parentRunId: ctx && ctx.run ? ctx.run.id : null,
          depth: depth + 1,
        });
        noteProduced(ctx, run.id);
        // Deliberately does NOT wait for the child: a nested synchronous wait
        // multiplies the parent's time budget by the child's. The parent gets
        // the run id and can report it; the user sees the run in the UI.
        return { runId: run.id, agentId: child.id, status: run.data.status };
      },
    },
    {
      name: 'time.now',
      capability: null,
      mutating: false,
      description: 'Liefert das aktuelle Datum und die Uhrzeit dieses Geräts.',
      parameters: { type: 'object', properties: {}, required: [] },
      run() {
        const now = new Date();
        let local = now.toISOString();
        let weekday = '';
        try {
          local = now.toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });
          weekday = now.toLocaleDateString('de-DE', { weekday: 'long' });
        } catch {
          /* a Node build without full ICU still gets the ISO value */
        }
        return {
          iso: now.toISOString(),
          unix: Math.floor(now.getTime() / 1000),
          local,
          weekday,
          timezoneOffsetMinutes: -now.getTimezoneOffset(),
        };
      },
    },
    {
      name: 'math.eval',
      capability: null,
      mutating: false,
      description: 'Rechnet einen arithmetischen Ausdruck aus. Dezimaltrennzeichen ist der Punkt. '
        + 'Erlaubt: + - * / % ^, Klammern und die Funktionen '
        + `${Object.keys(MATH_FUNCTIONS).join(', ')} sowie die Konstanten ${Object.keys(MATH_CONSTANTS).join(', ')}.`,
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', maxLength: MAX_EXPRESSION_LENGTH, description: 'z. B. (12 + 8) * 3 / 4' } },
        required: ['expression'],
      },
      run(args) {
        const value = evaluateExpression(args.expression);
        return { expression: args.expression, value };
      },
    },
  ];

  const byName = new Map(definitions.map((d) => [d.name, d]));
  let moduleRegistry = null;

  /**
   * Tools contributed by installed modules, read live -- a module can be
   * switched on while an agent run is in flight.
   */
  function moduleTools() {
    if (!moduleRegistry || typeof moduleRegistry.tools !== 'function') return [];
    try {
      return (moduleRegistry.tools() || []).filter((t) => t && typeof t.name === 'string');
    } catch {
      // A broken registry must not take the built-in tools with it.
      return [];
    }
  }

  function moduleToolByName(name) {
    return moduleTools().find((t) => t.name === name) || null;
  }

  /**
   * The capabilities of the module a tool came from.
   *
   * The tool object itself carries only `moduleId`: the registry hands out
   * callable tools, not a copy of the permission state, and a copy would go
   * stale the moment the module is updated. Reading it live through the
   * registry keeps one source of truth -- and getting this wrong is not a
   * cosmetic bug: an empty list here silently disables the rule that a module
   * tool may never exceed the agent calling it.
   */
  function capabilitiesOfModule(tool) {
    if (Array.isArray(tool && tool.moduleCapabilities)) return tool.moduleCapabilities;
    const id = tool && tool.moduleId;
    if (!id || !moduleRegistry || typeof moduleRegistry.list !== 'function') return null;
    try {
      const entry = (moduleRegistry.list() || []).find((m) => m && m.id === id);
      const caps = entry && (entry.capabilities || (entry.data && entry.data.capabilities));
      return Array.isArray(caps) ? caps : null;
    } catch {
      return null;
    }
  }

  /**
   * May this agent use a tool that a module with `caps` provides?
   * Every capability the module holds must also be one the agent holds.
   */
  function agentMayUseModuleTool(agent, perms, caps) {
    // A tool whose module capabilities cannot be determined is refused. The
    // safe default for an unknown grant is no grant; the alternative would be
    // to hand out whatever the module happens to hold.
    if (!Array.isArray(caps)) return { allowed: false, missing: 'unbekannte Modulrechte' };
    const needed = [];
    for (const cap of caps || []) {
      const mapped = MODULE_TO_AGENT_CAPABILITY[cap];
      if (mapped) needed.push(mapped);
    }
    for (const capability of needed) {
      const verdict = permissionsMod.check(agent, capability, { permissions: perms });
      if (!verdict.allowed) return { allowed: false, missing: capability };
    }
    const level = moduleNetworkLevel(caps);
    if (level !== 'offline') {
      const verdict = permissionsMod.check(agent, 'network', { permissions: perms, level });
      if (!verdict.allowed) return { allowed: false, missing: `network:${level}` };
    }
    return { allowed: true };
  }

  /**
   * Which network level an agent needs for this destination.
   *
   * Derived from the gate's own classifier rather than assumed: demanding
   * 'online' for every URL would forbid a LAN-permitted agent from reaching a
   * machine on its own network, which is precisely the level it was given.
   *
   * An unresolved NAME, however, counts as 'online'. The earlier reasoning --
   * "the gate checks the real address after DNS anyway" -- was wrong in a way
   * that mattered: the gate checks against the DEVICE's mode, not against this
   * agent's level. On a device in 'online' mode an agent restricted to the
   * local network therefore reached public hosts, while its own description
   * and its system prompt both told it (and the user) the opposite. A name can
   * resolve to anything, so it is treated as the most permissive class it
   * might turn out to be, and the agent's ceiling is additionally handed to
   * gate.fetch so the resolved address is judged against it on every hop.
   */
  function requiredLevelFor(host) {
    if (!gate || typeof gate.classify !== 'function') return 'online';
    let classification;
    try {
      classification = gate.classify(host);
    } catch {
      return 'online';
    }
    if (classification === 'loopback') return 'offline';
    if (classification === 'private') return 'lan';
    return 'online'; // public AND unknown: a name may resolve anywhere
  }

  function assertPathAllowed(ctx, target, capability) {
    if (!permissionsMod.canAccessPath(agentOf(ctx), target, { permissions: permsOf(ctx) })) {
      const perms = permsOf(ctx);
      throw new PermissionError(
        `Pfad "${target}" liegt außerhalb der freigegebenen Ordner${perms.fileRoots.length ? ` (${perms.fileRoots.join(', ')})` : ''}.`,
        { path: target, capability },
      );
    }
  }

  /* ------------------------------------------------------------- public API */

  const toolbox = {
    /** Injected by the runtime so `agents.spawn` works without a require cycle. */
    attachRuntime(value) {
      runtime = value;
      return toolbox;
    },

    /**
     * Injected by the composition root once the module registry exists.
     * Late-bound on purpose: modules load last, after everything they could
     * touch is already in a known-good state.
     */
    attachModules(value) {
      moduleRegistry = value;
      return toolbox;
    },

    /**
     * @param {object} agent
     * @returns {Array<{name:string, description:string, parameters:object}>}
     */
    list(agent) {
      const perms = permissionsMod.effective(agent, cfg);
      const allowlist = (() => {
        const data = permissionsMod.agentData(agent);
        return Array.isArray(data.tools) && data.tools.length ? new Set(data.tools) : null;
      })();

      const out = [];
      for (const def of definitions) {
        if (allowlist && !allowlist.has(def.name)) continue;
        if (def.capability) {
          const verdict = permissionsMod.check(agent, def.capability, { permissions: perms });
          if (!verdict.allowed) continue;
        }
        out.push({ name: def.name, description: def.description, parameters: def.parameters });
      }

      for (const tool of moduleTools()) {
        if (allowlist && !allowlist.has(tool.name)) continue;
        if (byName.has(tool.name)) continue; // a built-in always wins
        const verdict = agentMayUseModuleTool(agent, perms, capabilitiesOfModule(tool));
        if (!verdict.allowed) continue;
        out.push({
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
          fromModule: tool.moduleName || tool.module || true,
        });
      }
      return out;
    },

    /** Definition of one tool, or null. Used by the HTTP layer and the UI. */
    definition(name) {
      const def = byName.get(name);
      if (def) {
        return { name: def.name, description: def.description, parameters: def.parameters, capability: def.capability, mutating: def.mutating };
      }
      const tool = moduleToolByName(name);
      if (!tool) return null;
      return {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
        capability: null,
        // Conservative: a module tool whose module may write is treated as
        // mutating, so the approval requirement applies to it as well.
        mutating: (capabilitiesOfModule(tool) || []).some((c) => String(c).endsWith('.write')),
        fromModule: tool.moduleName || tool.module || true,
      };
    },

    has(name) {
      return byName.has(name) || !!moduleToolByName(name);
    },

    /**
     * Run one tool.
     *
     * @param {string} name
     * @param {object} args
     * @param {{agent:object, run?:object, signal?:AbortSignal, scope?:string,
     *          produced?:string[], depth?:number}} ctx
     * @returns {Promise<{ok:true, result:any}>}
     */
    async call(name, args, ctx = {}) {
      const started = Date.now();
      const agent = agentOf(ctx);
      const agentIdent = permissionsMod.agentId(agent);
      const runId = ctx.run ? ctx.run.id : null;

      const fail = (err) => {
        writeAudit('agent.tool.denied', {
          tool: name, agentId: agentIdent, runId,
          code: err && err.code, reason: err && err.message,
        });
        throw err;
      };

      let def = byName.get(name);
      if (!def) {
        // A tool contributed by an installed module. It is adapted into the
        // same definition shape so it travels the identical path: permission,
        // approval, execute, audit. Giving module tools their own shortcut
        // would be a second code path around the checks that matter.
        const tool = moduleToolByName(name);
        if (!tool) {
          return fail(new NotFoundError(`Werkzeug ${name}`));
        }
        const moduleCaps = capabilitiesOfModule(tool);
        const permsNow = permsOf(ctx);
        const verdict = agentMayUseModuleTool(agent, permsNow, moduleCaps);
        if (!verdict.allowed) {
          return fail(new PermissionError(
            `Das Werkzeug "${name}" stammt aus einer Erweiterung, die mehr darf als dieser Agent `
            + `(fehlend: ${verdict.missing}). Ein Werkzeug darf einem Agenten nicht mehr Reichweite `
            + 'geben, als er selbst hat.',
          ));
        }
        def = {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
          capability: null,
          mutating: (moduleCaps || []).some((c) => String(c).endsWith('.write')),
          fromModule: tool.moduleName || tool.module || true,
          run: (parsedArgs, runCtx) => tool.run(parsedArgs, runCtx),
        };
      }

      const data = permissionsMod.agentData(agent);
      if (Array.isArray(data.tools) && data.tools.length && !data.tools.includes(name)) {
        return fail(new PermissionError(`Werkzeug "${name}" gehört nicht zur Ausstattung dieses Agenten.`));
      }

      let parsed;
      try {
        parsed = validateArgs(name, def.parameters, args);
      } catch (err) {
        return fail(err);
      }

      const perms = permsOf(ctx);
      if (!ctx.scope) ctx.scope = permissionsMod.networkScope(agent, runId);

      // 1. permission -- before anything else, and before the user is asked.
      if (def.capability) {
        const extra = typeof def.capabilityContext === 'function' ? def.capabilityContext(parsed) : {};
        const verdict = permissionsMod.check(agent, def.capability, { permissions: perms, ...extra });
        if (!verdict.allowed) {
          return fail(new PermissionError(`Werkzeug "${name}" nicht erlaubt: ${verdict.reason}`, {
            tool: name, capability: def.capability,
          }));
        }
      }

      try {
        assertNotAborted(ctx);
      } catch (err) {
        return fail(err);
      }

      // 2. approval -- for every mutating tool, when the effective policy asks
      //    for it. `effective()` has already folded in globalApprovalOverride.
      if (def.mutating && perms.requireApproval) {
        if (!approvals || typeof approvals.request !== 'function') {
          return fail(new NeuralError(
            'APPROVAL_UNAVAILABLE',
            `Für "${name}" ist eine Bestätigung nötig, aber das Bestätigungssystem fehlt. Die Aktion wird nicht ausgeführt.`,
            { status: 503 },
          ));
        }
        try {
          await approvals.request({
            runId,
            agentId: agentIdent,
            kind: def.capability === 'network' ? 'network' : (def.capability === 'spawnAgents' ? 'spawn' : 'tool'),
            summary: typeof def.summary === 'function' ? def.summary(parsed) : `Werkzeug "${name}" ausführen`,
            payload: { tool: name, args: parsed },
            signal: ctx.signal,
          });
        } catch (err) {
          return fail(err);
        }
      }

      // 3. execute
      let result;
      try {
        result = await def.run(parsed, ctx, toolbox);
        assertNotAborted(ctx);
      } catch (err) {
        return fail(err);
      }

      // 4. audit -- successes too, or the trail proves nothing.
      writeAudit('agent.tool', {
        tool: name, agentId: agentIdent, runId,
        mutating: !!def.mutating, capability: def.capability, ms: Date.now() - started,
      });
      return { ok: true, result };
    },
  };

  return toolbox;
}

/** Compact catalogue text for a system prompt. Shared so it cannot drift. */
function describeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return 'Dir stehen keine Werkzeuge zur Verfügung.';
  return tools.map((tool) => {
    const props = isPlainObject(tool.parameters) && isPlainObject(tool.parameters.properties)
      ? tool.parameters.properties : {};
    const required = Array.isArray(tool.parameters && tool.parameters.required) ? tool.parameters.required : [];
    const params = Object.entries(props).map(([key, def]) => {
      const mark = required.includes(key) ? '' : '?';
      const hint = def.description ? ` – ${def.description}` : '';
      return `    ${key}${mark}: ${def.type || 'any'}${hint}`;
    });
    return `- ${tool.name}: ${tool.description}${params.length ? `\n${params.join('\n')}` : ''}`;
  }).join('\n');
}

module.exports = {
  createToolbox,
  describeTools,
  evaluateExpression,
  htmlToText,
  decodeEntities,
  validateArgs,
  MATH_FUNCTIONS,
  MATH_CONSTANTS,
};
