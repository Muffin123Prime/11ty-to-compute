#!/usr/bin/env node
'use strict';

/**
 * Neural OS command line.
 *
 *   neural-os [start]          start the local server (default)
 *   neural-os doctor           report honestly what works and what does not
 *   neural-os export [--dir D] [--format json|markdown|both]
 *   neural-os import <dir>     [--mode merge|replace|fresh]
 *   neural-os compact          snapshot the vault and truncate the log
 *   neural-os version
 *
 * Global flags: --home DIR  --port N  --host H  --log LEVEL  --no-harden
 *               --passphrase P   (prefer NEURAL_OS_PASSPHRASE)
 */

const readline = require('node:readline');
const { createApp, seedIfEmpty, acquireLock, VERSION } = require('../src/app');
const { asNeuralError } = require('../src/kernel/errors');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      if (inline !== undefined) out.flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const B = '\u001b[1m';
const D = '\u001b[2m';
const G = '\u001b[32m';
const Y = '\u001b[33m';
const R = '\u001b[31m';
const X = '\u001b[0m';

function mark(ok) {
  return ok ? `${G}✓${X}` : `${R}✗${X}`;
}

async function boot(flags, extra = {}) {
  return createApp({
    home: typeof flags.home === 'string' ? flags.home : undefined,
    port: flags.port ? Number(flags.port) : undefined,
    host: typeof flags.host === 'string' ? flags.host : undefined,
    logLevel: typeof flags.log === 'string' ? flags.log : undefined,
    harden: flags.harden !== false && flags['no-harden'] !== true,
    passphrase: typeof flags.passphrase === 'string' ? flags.passphrase : process.env.NEURAL_OS_PASSPHRASE,
    ...extra,
  });
}

/** Ask for a passphrase without echoing it to the terminal. */
function promptSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      if (['\n', '\r', '\u0004'].includes(String(char))) {
        process.stdin.removeListener('data', onData);
      } else {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question + '*'.repeat(rl.line.length));
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function cmdStart(flags) {
  let app;
  let releaseLock = async () => {};
  try {
    const probe = require('../src/kernel/paths').layout(typeof flags.home === 'string' ? flags.home : undefined);
    require('../src/kernel/paths').ensureLayout(probe);
    releaseLock = await acquireLock(probe);

    app = await boot(flags);

    // An encrypted vault needs its passphrase before anything is readable.
    if (app.vaultCrypto && app.vaultCrypto.enabled && app.vaultCrypto.state === 'locked') {
      const pass = await promptSecret('Passphrase für den Vault: ');
      await app.vaultCrypto.unlock(pass);
      await app.store.reload();
    }

    const seeded = await seedIfEmpty(app);
    const health = await app.doctor();
    const { host, port } = app.config.server;

    console.log('');
    console.log(`${B}Neural OS${X} ${D}v${VERSION} · Node ${process.version}${X}`);
    console.log(`${D}${'─'.repeat(58)}${X}`);
    console.log(`  Oberfläche    ${B}http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}${X}`);
    console.log(`  Daten         ${app.paths.home}`);
    console.log(`  Netzmodus     ${netLabel(app.config.network.mode)}${health.network.hardened ? ` ${D}(prozessweit durchgesetzt)${X}` : ` ${Y}(NICHT durchgesetzt)${X}`}`);
    console.log(`  Vault         ${health.vault.counts ? Object.entries(health.vault.counts).map(([k, v]) => `${v} ${k}`).join(', ') : '0 Einträge'}${app.vaultCrypto && app.vaultCrypto.enabled ? ' · verschlüsselt' : ''}`);

    const avail = health.models.providers.filter((p) => p.available);
    if (avail.length) {
      console.log(`  Modelle       ${mark(true)} ${avail.map((p) => `${p.id} (${p.models.length})`).join(', ')}`);
    } else {
      console.log(`  Modelle       ${Y}keins gefunden${X} ${D}— Chat und Agenten brauchen ein lokales Modell${X}`);
      console.log(`                ${D}ollama.com/download, dann: ollama pull llama3.2${X}`);
    }
    if (app.failures.length) {
      console.log(`  ${Y}Eingeschränkt${X}  ${app.failures.map((f) => f.subsystem).join(', ')} ${D}— 'neural-os doctor' zeigt Details${X}`);
    }
    if (seeded) console.log(`  ${D}Neuer Vault angelegt und mit einer Einführung befüllt.${X}`);
    console.log(`${D}${'─'.repeat(58)}${X}`);
    console.log(`${D}Beenden mit Strg+C${X}\n`);

    await app.listen();

    let closing = false;
    const shutdown = async (signal) => {
      if (closing) return;
      closing = true;
      process.stdout.write(`\n${D}${signal} — schließe sauber ab …${X}\n`);
      const problems = await app.close();
      await releaseLock();
      if (problems.length) console.error(`${Y}Beim Beenden: ${JSON.stringify(problems)}${X}`);
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    await releaseLock();
    if (app) await app.close().catch(() => {});
    throw err;
  }
}

function netLabel(mode) {
  if (mode === 'offline') return `${G}offline${X}`;
  if (mode === 'lan') return `${Y}lokales Netz${X}`;
  return `${R}online${X}`;
}

async function cmdDoctor(flags) {
  const app = await boot(flags);
  try {
    const h = await app.doctor();
    console.log('');
    console.log(`${B}Neural OS Diagnose${X} ${D}v${h.version} · Node ${h.node}${X}\n`);
    console.log(`${B}Speicherort${X}  ${h.home}`);
    console.log(`${B}Netzmodus${X}    ${h.network.mode}${h.network.hardened ? ' (prozessweit durchgesetzt)' : `  ${R}NICHT durchgesetzt${X}`}`);
    console.log(`${B}Vault${X}        ${JSON.stringify(h.vault.counts || {})} · Verschlüsselung: ${h.vault.encryption}\n`);

    console.log(`${B}Subsysteme${X}`);
    for (const [name, state] of Object.entries(h.subsystems)) {
      const ok = state === true || (typeof state === 'string' && state !== 'unavailable');
      console.log(`  ${mark(ok)} ${name}${typeof state === 'string' ? ` ${D}(${state})${X}` : ''}`);
    }

    console.log(`\n${B}Modelle${X}`);
    if (!h.models.providers.length) {
      console.log(`  ${Y}—${X} keine Provider konfiguriert`);
    }
    for (const p of h.models.providers) {
      console.log(`  ${mark(p.available)} ${p.id} ${D}${p.baseUrl}${X}`);
      if (p.available && p.models.length) console.log(`      ${D}${p.models.join(', ')}${X}`);
      if (!p.available) console.log(`      ${D}${p.error || 'nicht erreichbar'}${X}`);
    }
    if (!h.models.available) {
      console.log(`\n  ${Y}Kein lokales Modell erreichbar.${X}`);
      console.log(`  ${D}Chat und Agenten bleiben ohne Modell funktionslos — das ist kein Fehler der App.${X}`);
      console.log(`  ${D}Abhilfe: ollama.com/download installieren, dann 'ollama pull llama3.2'.${X}`);
    }

    console.log(`\n${B}Semantische Suche${X}`);
    if (h.semantic && h.semantic.available) {
      console.log(`  ${mark(true)} ${h.semantic.model} ${D}(${h.semantic.dim} Dimensionen, ${h.semantic.indexed} Einträge indiziert)${X}`);
    } else {
      const reason = (h.semantic && h.semantic.reason) || 'nicht eingerichtet';
      console.log(`  ${Y}—${X} ${D}${String(reason).split('\n')[0]}${X}`);
      console.log(`  ${D}Einrichten: ollama pull nomic-embed-text${X}`);
    }

    if (h.failures.length) {
      console.log(`\n${B}${Y}Nicht geladene Subsysteme${X}`);
      for (const f of h.failures) console.log(`  ${R}✗${X} ${f.subsystem}: ${f.reason}`);
    }
    console.log('');
    return h.failures.length ? 1 : 0;
  } finally {
    await app.close();
  }
}

async function cmdExport(flags) {
  const app = await boot(flags);
  try {
    if (!app.backup) throw new Error('Backup-Subsystem nicht verfügbar');
    const format = typeof flags.format === 'string' ? flags.format : 'both';
    const dir = typeof flags.dir === 'string' ? flags.dir : undefined;
    const res = await app.backup.exportAll({ dir, format, includeFiles: flags['no-files'] !== true });
    console.log(`${G}✓${X} ${res.records} Einträge exportiert nach ${B}${res.dir}${X} (${res.files} Dateien, ${Math.round(res.bytes / 1024)} KB)`);
    return 0;
  } finally {
    await app.close();
  }
}

async function cmdImport(flags, args) {
  const source = args._[1];
  if (!source) throw new Error('Bitte den Export-Ordner angeben: neural-os import <ordner>');
  const app = await boot(flags);
  try {
    if (!app.backup) throw new Error('Backup-Subsystem nicht verfügbar');
    const mode = typeof flags.mode === 'string' ? flags.mode : 'merge';
    const run = () => app.backup.importAll({ dir: source, mode });
    const res = typeof app.withoutIndexing === 'function' ? await app.withoutIndexing(run) : await run();
    console.log(`${G}✓${X} ${res.imported} übernommen, ${res.skipped} übersprungen, ${res.conflicts ? res.conflicts.length || res.conflicts : 0} Konflikte`);
    return 0;
  } finally {
    await app.close();
  }
}

async function cmdCompact(flags) {
  const app = await boot(flags);
  try {
    const res = await app.store.compact();
    console.log(`${G}✓${X} Vault kompaktiert: ${res.records} Einträge, ${Math.round(res.bytes / 1024)} KB`);
    return 0;
  } finally {
    await app.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'start';
  const flags = args.flags;

  if (flags.version || cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (flags.help || cmd === 'help') {
    console.log(require('node:fs').readFileSync(__filename, 'utf8').split('/**')[1].split('*/')[0].replace(/^\s*\*ic?/gm, '').replace(/^\s*\*/gm, ''));
    return 0;
  }

  switch (cmd) {
    case 'start': return cmdStart(flags);
    case 'doctor': return cmdDoctor(flags);
    case 'export': return cmdExport(flags);
    case 'import': return cmdImport(flags, args);
    case 'compact': return cmdCompact(flags);
    default:
      console.error(`Unbekannter Befehl: ${cmd}\nVerfügbar: start, doctor, export, import, compact, version`);
      return 1;
  }
}

main()
  .then((code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code);
  })
  .catch((err) => {
    const e = asNeuralError(err);
    console.error(`\n${R}✗ ${e.code}${X}  ${e.message}`);
    if (e.details) console.error(`${D}${JSON.stringify(e.details)}${X}`);
    if (process.env.NEURAL_OS_LOG_LEVEL === 'debug' && err.stack) console.error(`${D}${err.stack}${X}`);
    process.exit(1);
  });
