'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Filesystem layout for a Neural OS installation.
 *
 * Everything the app owns lives under ONE directory (the "home"). That is a
 * deliberate privacy property: the user can see, back up, encrypt or delete
 * their entire digital environment by touching a single folder. Nothing is
 * written to OS-wide caches, temp dirs or anywhere outside this tree.
 *
 * Resolution order for the home directory:
 *   1. explicit argument (CLI --home)
 *   2. NEURAL_OS_HOME environment variable
 *   3. ~/.neural-os
 */
function resolveHome(explicit) {
  const raw = explicit || process.env.NEURAL_OS_HOME || path.join(os.homedir(), '.neural-os');
  return path.resolve(raw);
}

/**
 * @param {string} [explicitHome]
 * @returns {{
 *   home:string, config:string, vault:string, log:string, snapshot:string,
 *   files:string, audit:string, runs:string, exports:string, lock:string,
 *   secrets:string, trash:string
 * }}
 */
function layout(explicitHome) {
  const home = resolveHome(explicitHome);
  const vault = path.join(home, 'vault');
  return {
    home,
    // Plain JSON, never encrypted: the app must be able to read its own
    // network policy before it can ask for a passphrase.
    config: path.join(home, 'config.json'),
    vault,
    log: path.join(vault, 'log'), // append-only operation log segments
    snapshot: path.join(vault, 'snapshot.json'), // periodic materialised state
    files: path.join(vault, 'files'), // content-addressed blobs
    audit: path.join(home, 'audit.jsonl'), // network + permission decisions
    runs: path.join(home, 'runs'), // agent run transcripts
    exports: path.join(home, 'exports'),
    trash: path.join(home, 'trash'),
    lock: path.join(home, '.lock'),
    secrets: path.join(home, 'secrets.json'), // key material wrapper, 0600
  };
}

/** Create every directory the layout needs. Idempotent. */
function ensureLayout(paths) {
  for (const dir of [paths.home, paths.vault, paths.log, paths.files, paths.runs, paths.exports, paths.trash]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Tighten the top-level directory even if it already existed.
  try {
    fs.chmodSync(paths.home, 0o700);
  } catch {
    /* best effort: some filesystems (exFAT, network mounts) ignore modes */
  }
  return paths;
}

/**
 * Guard against path traversal for any user-supplied relative path.
 * Returns the resolved absolute path, or throws if it escapes `root`.
 */
function safeJoin(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (target !== resolvedRoot && !target.startsWith(withSep)) {
    const err = new Error(`Path escapes its root: ${relative}`);
    err.code = 'EPATHESCAPE';
    throw err;
  }
  return target;
}

module.exports = { resolveHome, layout, ensureLayout, safeJoin };
