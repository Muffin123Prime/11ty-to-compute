'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StorageError, ValidationError } = require('./errors');

/**
 * Configuration is stored UNENCRYPTED on purpose.
 *
 * The network policy has to be readable before the vault can be unlocked --
 * otherwise a locked vault would mean an unknown network stance, which is
 * exactly backwards. The config contains no secrets: tokens are hashed and
 * live in the vault, key material lives in secrets.json.
 */

const CONFIG_VERSION = 1;

function defaults() {
  return {
    version: CONFIG_VERSION,
    server: {
      // Loopback only. Binding to 0.0.0.0 is an explicit, separate decision
      // the user makes in the Sharing panel, and it requires auth to be on.
      host: '127.0.0.1',
      port: 7777,
    },
    network: {
      /**
       * Global egress stance:
       *   'offline' - loopback only (default). Local models still work.
       *   'lan'     - loopback + RFC1918 / link-local. No public internet.
       *   'online'  - public internet permitted, still subject to allowHosts
       *               when strictAllowlist is true.
       */
      mode: 'offline',
      /** When true, 'online' additionally requires the host to be allowlisted. */
      strictAllowlist: true,
      /** Hostnames or host:port permitted in 'online'/'lan' mode. '*' = any. */
      allowHosts: [],
      /** Always-blocked hosts, evaluated before everything else. */
      blockHosts: [],
      /** Log every egress decision (allow and deny) to audit.jsonl. */
      audit: true,
    },
    models: {
      /** Backends probed on startup. All default to loopback addresses. */
      providers: [
        { id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true },
        { id: 'llamacpp', kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true },
        { id: 'lmstudio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
      ],
      /** {provider, model} chosen for new chats; null = first available. */
      default: null,
      /** Remote providers are opt-in and carry an apiKeyEnv, never a raw key. */
      remote: [],
    },
    ui: {
      theme: 'system', // system | dark | light
      density: 'comfortable',
      reduceMotion: false,
      locale: 'de',
    },
    security: {
      /** Encryption of the vault at rest. Off by default; enabling re-writes. */
      encryption: { enabled: false, kdf: 'scrypt', algorithm: 'aes-256-gcm' },
      /** LAN sharing. Off by default; turning it on forces token auth. */
      sharing: { enabled: false, requireToken: true, bindHost: '127.0.0.1' },
      /** Ask before any agent side effect, globally. Overrides per-agent 'false'. */
      globalApprovalOverride: false,
    },
    agents: {
      maxConcurrentRuns: 2,
      defaultMaxSteps: 12,
      defaultMaxSeconds: 300,
    },
    /**
     * Wie weit das Rueckgaengig zurueckreicht.
     *
     * Bewusst begrenzt und bewusst sichtbar: ein Journal ohne Grenze ist ein
     * Datenleck auf der Platte, und eine Grenze, die man nirgends sieht, ist
     * eine Ueberraschung an dem Tag, an dem man sie braucht. Wer laenger
     * zurueckwill, nimmt eine Sicherung -- das ist etwas anderes und heisst
     * auch so.
     */
    history: {
      maxEntries: 2000,
      maxDays: 30,
    },
  };
}

function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Load config from disk, merging over defaults. Never throws on missing file. */
function load(configPath) {
  const base = defaults();
  let raw = null;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return base;
    throw new StorageError(`Cannot read config at ${configPath}: ${err.message}`, { cause: String(err) });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A corrupt config must not brick the app or silently reset the network
    // policy to something more permissive. Keep the file, fall back to the
    // safest defaults, and surface it.
    const backup = `${configPath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(configPath, backup); } catch { /* best effort */ }
    const e = new StorageError(`config.json is corrupt (backed up to ${path.basename(backup)}); using safe defaults`, { cause: String(err) });
    e.recovered = base;
    throw e;
  }
  return deepMerge(base, parsed);
}

/** Atomic write: temp file + rename, so a crash cannot truncate the config. */
function save(configPath, config) {
  validateConfig(config);
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  return config;
}

const NETWORK_MODES = ['offline', 'lan', 'online'];

function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') throw new ValidationError('Config must be an object');
  if (!NETWORK_MODES.includes(config.network?.mode)) errors.push(`network.mode must be one of ${NETWORK_MODES.join(', ')}`);
  const port = config.server?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('server.port must be an integer 1-65535');
  if (typeof config.server?.host !== 'string') errors.push('server.host must be a string');
  // Refuse the dangerous combination outright rather than warning about it.
  const bindsPublic = config.server?.host && !['127.0.0.1', 'localhost', '::1'].includes(config.server.host);
  if (bindsPublic && !config.security?.sharing?.enabled) {
    errors.push('server.host is non-loopback but security.sharing.enabled is false');
  }
  if (bindsPublic && config.security?.sharing?.enabled && !config.security.sharing.requireToken) {
    errors.push('Refusing to bind a non-loopback address without token authentication');
  }
  if (errors.length) throw new ValidationError(`Invalid configuration: ${errors.join('; ')}`, { errors });
  return true;
}

module.exports = { CONFIG_VERSION, defaults, load, save, validateConfig, deepMerge, NETWORK_MODES };
