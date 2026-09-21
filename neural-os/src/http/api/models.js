'use strict';

/**
 * Model backends.
 *
 * `GET /api/models` returns the last probe result and never probes: opening
 * the interface must not wait on a backend that may be down. `POST
 * /api/models/refresh` is the explicit "look again", with a timeout, because a
 * probe that hangs would otherwise hold an HTTP connection for minutes.
 *
 * When nothing is reachable the answer carries the registry's own German
 * setup instructions instead of an empty list. "Keine Modelle" without a way
 * forward is a dead end; naming what was probed and how to install Ollama is
 * the difference between a bug report and a solved afternoon.
 *
 * ---------------------------------------------------------------------------
 * Remote (online) providers: /api/models/remote/*
 * ---------------------------------------------------------------------------
 *
 * Everything under `/api/models/remote` exists for one reason: an online mode
 * that can only be reached by hand-editing `config.json` is not an online
 * mode. But adding an online model backend is the single most privacy-relevant
 * thing a person can do in this system, so these routes are built to make the
 * consequences visible rather than convenient:
 *
 * - **The key never travels back.** A response says `hasApiKey` and
 *   `keySource`, never the key. `sanitiseConfig` already strips it from
 *   `/api/config`; these routes must not reintroduce the leak.
 * - **`apiKeyEnv` is the recommended path and is stated as such.** A key in
 *   `config.json` is plain text on disk (mode 0600, but plain text). The
 *   response says so in German rather than letting the user find out later.
 * - **Adding a provider does not open the gate.** The host is reported with
 *   the gate's *current* verdict for it, so the interface can say "angelegt,
 *   aber im Offline-Modus gesperrt" instead of leaving the user with a
 *   backend that silently never works. Opening the gate is a separate,
 *   explicit act (`allowHost: true`), it is written to the audit log by the
 *   gate itself, and it requires owner rights.
 * - **`test` really connects.** It is the only honest way to answer "works
 *   this?", and its result distinguishes "the gate refused" (a policy the user
 *   chose) from "the server did not answer" (something broken) -- two very
 *   different problems that look identical in a bare error string.
 */

const configMod = require('../../kernel/config');
const { ValidationError, NotFoundError, asNeuralError } = require('../../kernel/errors');
const {
  need, needMethod, asObject, requireString, optionalString, intParam,
} = require('./support');

/** Provider kinds this build can actually speak. Not a wish list. */
const KINDS = new Set(['openai', 'ollama']);

/**
 * Well-known online backends, as constants.
 *
 * These are not fetched from anywhere -- a "provider directory" that phones
 * home to list providers would be exactly the kind of quiet online access this
 * system exists to prevent. They speak the OpenAI dialect, which is why the
 * existing `openai` provider serves all of them without a new file.
 *
 * `note` is shown to the user verbatim, so it says what actually happens.
 */
const PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    host: 'api.openai.com',
    apiKeyEnv: 'OPENAI_API_KEY',
    note: 'Schlüssel unter platform.openai.com. Jede Anfrage verlässt dieses Gerät.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'openai',
    baseUrl: 'https://api.anthropic.com/v1',
    host: 'api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    note: 'Nutzt die OpenAI-kompatible Schnittstelle von Anthropic. Jede Anfrage verlässt dieses Gerät.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    host: 'api.mistral.ai',
    apiKeyEnv: 'MISTRAL_API_KEY',
    note: 'Europäischer Anbieter. Jede Anfrage verlässt dieses Gerät.',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    host: 'api.groq.com',
    apiKeyEnv: 'GROQ_API_KEY',
    note: 'Sehr schnell, offene Modelle. Jede Anfrage verlässt dieses Gerät.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    host: 'openrouter.ai',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    note: 'Vermittelt an viele Anbieter weiter – wohin genau, entscheidet OpenRouter.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    host: 'api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    note: 'Jede Anfrage verlässt dieses Gerät.',
  },
  {
    id: 'lan',
    label: 'Eigener Server im Heimnetz',
    kind: 'openai',
    baseUrl: 'http://192.168.1.10:8080/v1',
    host: '192.168.1.10',
    apiKeyEnv: '',
    note: 'Ein stärkerer Rechner bei dir zu Hause. Braucht den Netzmodus „LAN“, nicht „Online“.',
  },
];

function installHint(registry) {
  if (typeof registry.installHint !== 'function') return null;
  try {
    return registry.installHint();
  } catch {
    return null;
  }
}

function decorate(registry, snapshot) {
  const providers = (snapshot && snapshot.providers) || [];
  const available = providers.some((p) => p.available);
  const out = {
    providers,
    at: (snapshot && snapshot.at) || null,
    available,
    probed: !!(snapshot && snapshot.at),
  };
  if (!available) out.hint = installHint(registry);
  return out;
}

/* ------------------------------------------------------ remote providers */

/** The configured remote list, always an array, never the live reference. */
function remoteList(config) {
  const raw = config && config.models && Array.isArray(config.models.remote) ? config.models.remote : [];
  return raw.filter((entry) => entry && typeof entry === 'object').map((entry) => ({ ...entry }));
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).hostname;
  } catch {
    return null;
  }
}

/**
 * Where the key for this entry comes from, without ever revealing it.
 * `env` wins over `config` because that is the order `registry.apiKeyFor` uses.
 */
function keyState(entry) {
  if (entry.apiKeyEnv && typeof process.env[entry.apiKeyEnv] === 'string' && process.env[entry.apiKeyEnv]) {
    return { hasApiKey: true, keySource: 'env' };
  }
  if (entry.apiKeyEnv) return { hasApiKey: false, keySource: 'env-missing' };
  if (typeof entry.apiKey === 'string' && entry.apiKey) return { hasApiKey: true, keySource: 'config' };
  return { hasApiKey: false, keySource: 'none' };
}

/**
 * What the gate would decide for this host right now -- derived from policy,
 * with no DNS and no connection. `record: false` keeps a page view out of the
 * network audit log: the user did not attempt anything by looking.
 */
function gateVerdict(gate, host) {
  if (!gate || typeof gate.check !== 'function' || !host) {
    return { known: false, allowed: null, classification: null, reason: 'Die Netz-Schleuse ist nicht verfügbar.' };
  }
  try {
    const decision = gate.check({ host, scope: 'global', purpose: 'Anzeige: Wäre dieser Anbieter erreichbar?', record: false });
    return {
      known: true,
      allowed: !!decision.allowed,
      classification: decision.classification || null,
      reason: decision.reason || '',
    };
  } catch (err) {
    return { known: false, allowed: null, classification: null, reason: asNeuralError(err).message };
  }
}

/** The outward-facing shape of one remote entry. Never carries the key. */
function describeRemote(entry, gate) {
  const host = hostOf(entry.baseUrl);
  return {
    id: String(entry.id || 'remote'),
    label: typeof entry.label === 'string' && entry.label ? entry.label : String(entry.id || 'remote'),
    kind: String(entry.kind || 'openai'),
    baseUrl: String(entry.baseUrl || ''),
    host,
    enabled: entry.enabled !== false,
    apiKeyEnv: entry.apiKeyEnv || null,
    ...keyState(entry),
    gate: gateVerdict(gate, host),
  };
}

/** Persist a changed remote list through the composition root when possible. */
function saveRemote(ctx, nextRemote) {
  const patch = { models: { remote: nextRemote } };
  if (typeof ctx.saveConfig === 'function') return ctx.saveConfig(patch);
  const current = need(ctx.config, 'Die Konfiguration');
  const next = configMod.deepMerge(current, patch);
  configMod.validateConfig(next);
  if (ctx.paths && ctx.paths.config) configMod.save(ctx.paths.config, next);
  Object.assign(current, next);
  if (ctx.bus && typeof ctx.bus.publish === 'function') ctx.bus.publish('config.changed', {});
  return current;
}

/** Ids are used as path segments and as config keys; keep them boring. */
function requireId(value, field = 'id') {
  const id = requireString(value, field, { max: 40 });
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new ValidationError(`"${field}" darf nur Buchstaben, Ziffern, - und _ enthalten (empfangen: ${id}).`);
  }
  return id;
}

/**
 * A base URL we are willing to hand to a provider.
 *
 * `file:` and friends are refused here rather than at the socket, because an
 * error message naming the real problem is worth more than a gate denial the
 * user has to decode.
 */
function requireBaseUrl(value, field = 'baseUrl') {
  const raw = requireString(value, field, { max: 300 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`"${field}" ist keine gültige Adresse (empfangen: ${raw}).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`"${field}" muss mit http:// oder https:// beginnen (empfangen: ${url.protocol}//…).`);
  }
  if (url.username || url.password) {
    throw new ValidationError('Zugangsdaten gehören nicht in die Adresse. Nutze apiKeyEnv oder apiKey.');
  }
  // A trailing slash doubles up when the provider appends "/models".
  return raw.replace(/\/+$/, '');
}

/** Environment variable names, so a typo does not become a silent "no key". */
function optionalEnvName(value) {
  const name = optionalString(value, 'apiKeyEnv', { max: 80 });
  if (!name) return null;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new ValidationError(`"apiKeyEnv" ist kein Name einer Umgebungsvariable (empfangen: ${name}). Üblich ist z. B. OPENAI_API_KEY.`);
  }
  return name;
}

function register(router) {
  router.get('/api/models', (rc) => {
    rc.requireCapability('read');
    const registry = needMethod(
      rc.ctx.registry,
      'list',
      'Die Modellverwaltung',
      'Ohne sie kann kein Modell gefunden oder angesprochen werden.',
    );
    return decorate(registry, registry.list());
  });

  router.post('/api/models/refresh', async (rc) => {
    rc.requireCapability('read');
    const registry = needMethod(rc.ctx.registry, 'refresh', 'Die Modellverwaltung');
    const timeoutMs = intParam(rc.query, 'timeoutMs', 1500, 100, 30000);
    const snapshot = await registry.refresh({ timeoutMs });
    return decorate(registry, snapshot);
  });

  /* --------------------------------------------------- remote providers */

  router.get('/api/models/remote', (rc) => {
    rc.requireCapability('read');
    const config = need(rc.ctx.config, 'Die Konfiguration');
    const items = remoteList(config).map((entry) => describeRemote(entry, rc.ctx.gate));
    return {
      items,
      total: items.length,
      presets: PRESETS,
      mode: (config.network && config.network.mode) || 'offline',
      advice: 'Am sichersten ist der Schlüssel in einer Umgebungsvariable (apiKeyEnv): dann steht er nirgends in einer Datei. '
        + 'Ein Schlüssel, den du hier direkt einträgst, liegt im Klartext in config.json.',
    };
  });

  router.post('/api/models/remote', async (rc) => {
    // Adding an online backend changes what can leave this device. Owner only.
    rc.requireOwner('Ein Online-Modellanbieter');
    const config = need(rc.ctx.config, 'Die Konfiguration');
    const body = asObject(await rc.body());

    const id = requireId(body.id);
    const existing = remoteList(config);
    if (existing.some((entry) => String(entry.id) === id)) {
      throw new ValidationError(`Es gibt bereits einen Anbieter mit der Kennung "${id}".`);
    }
    // The built-in local providers live in config.models.providers; a remote
    // entry with the same id would be silently dropped by the registry.
    const builtin = Array.isArray(config.models && config.models.providers) ? config.models.providers : [];
    if (builtin.some((p) => p && String(p.id) === id)) {
      throw new ValidationError(`"${id}" ist schon der Name eines lokalen Backends. Wähle eine andere Kennung.`);
    }

    const kind = optionalString(body.kind, 'kind', { max: 20 }) || 'openai';
    if (!KINDS.has(kind)) {
      throw new ValidationError(`"${kind}" ist kein bekannter Anbietertyp. Möglich: ${[...KINDS].join(', ')}.`);
    }
    const baseUrl = requireBaseUrl(body.baseUrl);
    const apiKeyEnv = optionalEnvName(body.apiKeyEnv);
    const apiKey = optionalString(body.apiKey, 'apiKey', { max: 400 }) || null;
    if (apiKeyEnv && apiKey) {
      throw new ValidationError('Gib entweder apiKeyEnv oder apiKey an, nicht beides – sonst ist nicht klar, welcher gilt.');
    }

    const entry = {
      id,
      label: optionalString(body.label, 'label', { max: 80 }) || id,
      kind,
      baseUrl,
      enabled: body.enabled === undefined ? true : !!body.enabled,
    };
    if (apiKeyEnv) entry.apiKeyEnv = apiKeyEnv;
    if (apiKey) entry.apiKey = apiKey;

    saveRemote(rc.ctx, [...existing, entry]);

    // Opening the gate is a separate decision, never a side effect of adding
    // a backend. It happens only when the caller asked for it in this request.
    let grant = null;
    const host = hostOf(baseUrl);
    if (body.allowHost === true && host) {
      const gate = needMethod(rc.ctx.gate, 'addGrant', 'Die Netz-Schleuse');
      const verdict = gateVerdict(rc.ctx.gate, host);
      const level = verdict.classification === 'private' ? 'lan' : 'online';
      grant = gate.addGrant({
        scope: 'global',
        level,
        hosts: [host],
        reason: `Modellanbieter „${entry.label}“`,
      });
    }

    return {
      record: describeRemote(entry, rc.ctx.gate),
      grant,
      keyWarning: apiKey
        ? 'Der Schlüssel steht jetzt im Klartext in config.json (Dateirechte 0600). Eine Umgebungsvariable wäre sicherer.'
        : null,
    };
  });

  router.patch('/api/models/remote/:id', async (rc) => {
    rc.requireOwner('Ein Online-Modellanbieter');
    const config = need(rc.ctx.config, 'Die Konfiguration');
    const body = asObject(await rc.body());
    const list = remoteList(config);
    const index = list.findIndex((entry) => String(entry.id) === rc.params.id);
    if (index < 0) throw new NotFoundError(`Anbieter ${rc.params.id}`);

    const entry = { ...list[index] };
    if (body.label !== undefined) entry.label = optionalString(body.label, 'label', { max: 80 }) || entry.id;
    if (body.baseUrl !== undefined) entry.baseUrl = requireBaseUrl(body.baseUrl);
    if (body.kind !== undefined) {
      const kind = requireString(body.kind, 'kind', { max: 20 });
      if (!KINDS.has(kind)) {
        throw new ValidationError(`"${kind}" ist kein bekannter Anbietertyp. Möglich: ${[...KINDS].join(', ')}.`);
      }
      entry.kind = kind;
    }
    if (body.enabled !== undefined) entry.enabled = !!body.enabled;
    if (body.apiKeyEnv !== undefined) {
      const name = optionalEnvName(body.apiKeyEnv);
      if (name) {
        entry.apiKeyEnv = name;
        delete entry.apiKey; // one source of truth, or neither is trustworthy
      } else {
        delete entry.apiKeyEnv;
      }
    }
    if (body.apiKey !== undefined) {
      const key = optionalString(body.apiKey, 'apiKey', { max: 400 });
      if (key) {
        entry.apiKey = key;
        delete entry.apiKeyEnv;
      } else {
        delete entry.apiKey;
      }
    }

    const next = [...list];
    next[index] = entry;
    saveRemote(rc.ctx, next);
    return { record: describeRemote(entry, rc.ctx.gate) };
  });

  router.delete('/api/models/remote/:id', (rc) => {
    rc.requireOwner('Ein Online-Modellanbieter');
    const config = need(rc.ctx.config, 'Die Konfiguration');
    const list = remoteList(config);
    const index = list.findIndex((entry) => String(entry.id) === rc.params.id);
    if (index < 0) throw new NotFoundError(`Anbieter ${rc.params.id}`);
    const removed = list[index];
    saveRemote(rc.ctx, list.filter((_, i) => i !== index));
    // The grant, if one was made, is deliberately left alone: revoking it here
    // would quietly undo a network decision the user made separately, and the
    // Netzwerk view is where freigaben are reviewed and withdrawn.
    return {
      ok: true,
      id: removed.id,
      note: hostOf(removed.baseUrl)
        ? `Eine eventuelle Netz-Freigabe für ${hostOf(removed.baseUrl)} besteht weiter. Unter „Netzwerk“ kannst du sie zurücknehmen.`
        : null,
    };
  });

  /**
   * Really connect, once, and report what really happened.
   *
   * This is a write-shaped action (it sends a request to a foreign host), so it
   * is owner-only and it goes through the same registry probe the app uses --
   * not a special code path that might succeed where the real one fails.
   */
  router.post('/api/models/remote/:id/test', async (rc) => {
    rc.requireOwner('Ein Verbindungstest');
    const config = need(rc.ctx.config, 'Die Konfiguration');
    const registry = needMethod(rc.ctx.registry, 'refresh', 'Die Modellverwaltung');
    const entry = remoteList(config).find((e) => String(e.id) === rc.params.id);
    if (!entry) throw new NotFoundError(`Anbieter ${rc.params.id}`);

    const timeoutMs = intParam(rc.query, 'timeoutMs', 8000, 500, 60000);
    const snapshot = await registry.refresh({ timeoutMs });
    const probed = (snapshot.providers || []).find((p) => p.id === entry.id) || null;

    if (!probed) {
      return {
        id: entry.id,
        ok: false,
        blocked: false,
        error: 'Die Modellverwaltung hat diesen Anbieter nicht geprüft. Ist er deaktiviert?',
        record: describeRemote(entry, rc.ctx.gate),
      };
    }

    // "Blocked" and "unreachable" look the same in a bare error string, and
    // they are opposites: one is a policy the user chose, the other is a fault.
    // So this reads the error CODE the provider now carries, and falls back to
    // asking the gate what it thinks of the host -- never to pattern-matching
    // German prose, which is how this check was wrong the first time.
    const verdict = gateVerdict(rc.ctx.gate, hostOf(entry.baseUrl));
    const blocked = probed.code === 'NETWORK_BLOCKED'
      || (!probed.available && verdict.known && verdict.allowed === false);

    const { hasApiKey, keySource } = keyState(entry);
    let hint = null;
    if (blocked) {
      hint = `Die Netz-Schleuse hat die Verbindung verhindert. Im Modus „${(config.network && config.network.mode) || 'offline'}“ `
        + 'ist dieser Host nicht freigegeben. Unter „Netzwerk“ kannst du ihn freigeben – dauerhaft oder nur für kurze Zeit.';
    } else if (!probed.available && !hasApiKey && keySource !== 'none') {
      hint = `Es ist kein Schlüssel gesetzt: die Umgebungsvariable ${entry.apiKeyEnv} ist in diesem Prozess leer. `
        + 'Setze sie, bevor du Neural OS startest.';
    } else if (!probed.available) {
      hint = 'Der Anbieter war nicht erreichbar. Die Meldung oben stammt unverändert vom Versuch – sie ist nicht geraten.';
    }

    return {
      id: entry.id,
      ok: !!probed.available,
      blocked,
      latencyMs: probed.latencyMs,
      models: (probed.models || []).map((m) => m.id || m.name).filter(Boolean),
      error: probed.error || null,
      hint,
      record: describeRemote(entry, rc.ctx.gate),
    };
  });
}

module.exports = { register, PRESETS };
