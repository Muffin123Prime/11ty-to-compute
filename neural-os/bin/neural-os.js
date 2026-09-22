#!/usr/bin/env node
'use strict';

/**
 * Neural OS command line.
 *
 *   neural-os [start]          start the local server (default)
 *   neural-os doctor           report honestly what works and what does not
 *   neural-os export [--dir D] [--format json|markdown|both] [--passphrase X]
 *   neural-os import <dir>     [--mode merge|replace|fresh|restore] [--passphrase X]
 *   neural-os compact          snapshot the vault and truncate the log
 *   neural-os version
 *
 * Global flags: --home DIR  --port N  --host H  --log LEVEL  --no-harden
 *               --safe   (startet ohne die selbst eingefügten Erweiterungen)
 *               --open   (oeffnet die Oberflaeche im Browser)
 *
 *   neural-os stick prepare <pfad>   bereitet einen USB-Stick vor
 *   neural-os stick update  <pfad>   erneuert nur den Programmcode
 *   neural-os stick verify  <pfad>   prueft einen Stick
 *   neural-os stick model list [pfad]   Modelle hier und auf dem Stick
 *   neural-os stick model plan <pfad>   was "copy" tun wuerde (schreibt nichts)
 *   neural-os stick model copy <pfad>   Modell samt Laufzeitkern auf den Stick
 *               --auswahl id1,id2   nur diese Funde (Vorgabe: alles)
 *               --fuer plattform    fuer welchen Rechner gefragt wird (z. B. win-x64, ipados)
 *               --pruefsummen alle  auch grosse Dateien nach dem Kopieren pruefen
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
    // Extensions come up only after the rest of the system is known healthy.
    const extensions = await app.loadModules({ safeMode: flags.safe === true });
    const health = await app.doctor();
    const { host, port } = app.config.server;

    // Bind first, then print. On a stick the configured port may belong to
    // something else on this machine, and announcing an address that turns out
    // to be wrong is worse than a moment of silence.
    await app.listen({ tryPorts: flags.port ? 1 : 12 });
    const url = (app.server && app.server.url) || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
    const movedPort = !url.endsWith(`:${port}`);

    console.log('');
    console.log(`${B}Neural OS${X} ${D}v${VERSION} · Node ${process.version}${X}`);
    console.log(`${D}${'─'.repeat(58)}${X}`);
    console.log(`  Oberfläche    ${B}${url}${X}${movedPort ? ` ${Y}(Port ${port} war belegt)${X}` : ''}`);
    if (app.portable) {
      // A mode that changes where somebody's notes live is never implicit.
      console.log(`  ${B}Portabel${X}      ${G}Daten auf dem Datenträger${X} ${D}${app.portable.root}${X}`);
    }
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
    if (extensions && (extensions.loaded || extensions.failed || extensions.safeMode)) {
      if (extensions.safeMode) {
        console.log(`  Erweiterungen ${Y}abgeschaltet${X} ${D}(--safe)${X}`);
      } else {
        const parts = [`${extensions.loaded} aktiv`];
        if (extensions.failed) parts.push(`${R}${extensions.failed} fehlerhaft${X}`);
        if (extensions.disabled) parts.push(`${extensions.disabled} aus`);
        console.log(`  Erweiterungen  ${parts.join(', ')}`);
      }
    }
    if (seeded) console.log(`  ${D}Neuer Vault angelegt und mit einer Einführung befüllt.${X}`);
    console.log(`${D}${'─'.repeat(58)}${X}`);
    console.log(`${D}Beenden mit Strg+C${X}\n`);

    if (flags.open === true && url) {
      const { openInBrowser } = require('../src/portable/open');
      const result = await openInBrowser(url);
      if (!result.opened) {
        console.log(`  ${D}Browser konnte nicht geöffnet werden (${result.reason || 'unbekannt'}). Adresse oben von Hand aufrufen.${X}`);
      }
    }

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

    // Automatik zuletzt und ausdruecklich: die Frage "läuft hier gerade etwas
    // ohne mich?" muss man beantwortet bekommen, ohne die Oberfläche zu
    // öffnen -- gerade dann, wenn man auf der Kommandozeile nachsieht, weil
    // einem etwas seltsam vorkam.
    console.log(`\n${B}Automatik${X}`);
    const auto = h.automation || {};
    const sch = auto.scheduler;
    const trg = auto.triggers;
    if (!sch && !trg) {
      console.log(`  ${Y}—${X} ${D}nicht geladen${X}`);
    } else {
      const an = (sch ? sch.enabled || 0 : 0) + (trg ? trg.enabled || 0 : 0);
      if (an === 0) {
        console.log(`  ${mark(true)} Nichts läuft von allein.`);
      } else {
        console.log(`  ${Y}!${X} ${an} eingeschaltet — hier läuft etwas, ohne dass du davorsitzt.`);
      }
      if (sch) {
        console.log(`  ${D}Zeitpläne   ${sch.total || 0} angelegt, ${sch.enabled || 0} eingeschaltet`
          + `${sch.nextDue ? `, nächster ${sch.nextDue}` : ''}${X}`);
      }
      if (trg) {
        console.log(`  ${D}Auslöser    ${trg.total || 0} angelegt, ${trg.enabled || 0} eingeschaltet`
          + `, ${trg.firedLastHour || 0} Start(s) in der letzten Stunde${X}`);
      }
    }

    if (h.assistance) {
      const a = h.assistance;
      console.log(`\n${B}Vorschläge${X}`);
      console.log(`  ${a.open || 0} offen, ${a.accepted || 0} übernommen, ${a.dismissed || 0} verworfen`
        + `${a.stale ? `, ${a.stale} veraltet` : ''}`);
      console.log(`  ${D}Neu prüfen in der Oberfläche unter „Vorschläge“, oder POST /api/assist/scan${X}`);
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
    const passphrase = typeof flags.passphrase === 'string' ? flags.passphrase : undefined;
    const res = await app.backup.exportAll({ dir, format, includeFiles: flags['no-files'] !== true, passphrase });
    console.log(`${G}✓${X} ${res.records} Einträge exportiert nach ${B}${res.dir}${X} (${res.files} Dateien, ${Math.round(res.bytes / 1024)} KB)`);
    console.log(res.sealed
      ? `  Mit eigener Passphrase verschlüsselt. Ohne sie ist diese Sicherung nicht mehr zu öffnen.`
      : `  ${Y}Achtung:${X} Dieser Ordner liegt im Klartext. Mit --passphrase wird er verschlüsselt.`);
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
    const passphrase = typeof flags.passphrase === 'string' ? flags.passphrase : undefined;
    const run = () => app.backup.importAll({ dir: source, mode, passphrase });
    let ableitung = null;
    const res = typeof app.bulkWrite === 'function'
      ? await app.bulkWrite(run, { onRederive: (b) => { ableitung = b; } })
      : await run();
    console.log(`${G}✓${X} ${res.imported} übernommen, ${res.skipped} übersprungen, ${res.conflicts ? res.conflicts.length || res.conflicts : 0} Konflikte`);
    if (res.purged && res.purged.records) {
      console.log(`  ${res.purged.records} vorhandene Einträge wurden dabei gelöscht`
        + (res.purged.files ? `, ${res.purged.files} Dateiinhalte entfernt` : '') + '.');
    }
    // Was die Wiederherstellung NICHT geleistet hat, gehört auf denselben
    // Bildschirm wie die Zahl, die sie geleistet hat.
    for (const w of Array.isArray(res.warnings) ? res.warnings : []) console.log(`  ${Y}!${X} ${w}`);
    if (ableitung && !ableitung.ok) console.log(`  ${Y}!${X} ${ableitung.grund}`);
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


/* ------------------------------------------------------------------ stick */

async function cmdStick(flags, args) {
  const action = args._[1] || 'verify';
  if (action === 'model') return cmdStickModel(flags, args);
  const target = args._[2];
  if (!target) {
    throw new Error(`Bitte den Pfad zum Stick angeben: neural-os stick ${action} /pfad/zum/stick`);
  }

  const app = await boot(flags);
  try {
    const { createStick } = require('../src/portable/stick');
    const stick = createStick({ gate: app.gate, logger: require('../src/kernel/log').logger, paths: app.paths, config: app.config });

    // A long copy with no sign of life looks like a hang, and the natural
    // reaction to a hang is pulling the stick out.
    let lastPhase = null;
    const onProgress = (p) => {
      if (!p) return;
      if (p.phase && p.phase !== lastPhase) {
        lastPhase = p.phase;
        process.stdout.write(`\n  ${D}${p.message || p.phase}${X}`);
      } else if (p.message) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`  ${D}${String(p.message).slice(0, 70)}${X}`);
      }
    };

    if (action === 'prepare') {
      const runtimes = typeof flags.runtimes === 'string'
        ? flags.runtimes.split(',').map((r) => r.trim()).filter(Boolean)
        : [];
      const res = await stick.prepare(target, {
        includeRuntimes: runtimes.length ? runtimes : true,
        includeVault: flags['include-vault'] === true,
        onProgress,
      });
      console.log('');
      console.log(`${G}✓${X} Stick vorbereitet: ${B}${res.root}${X}`);
      const names = (res.runtimes || []).map((r) => (typeof r === 'string' ? r : (r && (r.platform || r.id || r.name)) || '?'));
      console.log(`  ${res.files} Dateien · ${Math.round(res.bytes / 1048576)} MB · Laufzeiten: ${names.join(', ') || 'keine'}`);
      printProblems(res.warnings, 'Hinweise');
      return 0;
    }

    if (action === 'update') {
      const res = await stick.update(target, { onProgress });
      console.log('');
      console.log(`${G}✓${X} Programmcode auf dem Stick erneuert. ${D}Der Datenordner wurde nicht angefasst.${X}`);
      if (res && res.files) console.log(`  ${res.files} Dateien · ${Math.round((res.bytes || 0) / 1048576)} MB`);
      printProblems(res && res.warnings, 'Hinweise');
      return 0;
    }

    if (action === 'runtime') {
      const platform = args._[3] || flags.platform;
      if (!platform) throw new Error('Bitte die Plattform angeben, z. B. win-x64, darwin-arm64, linux-x64.');
      const res = await stick.addRuntime(target, platform);
      console.log(`${G}✓${X} Laufzeit ${platform} auf den Stick gelegt.${res && res.bytes ? ` ${Math.round(res.bytes / 1048576)} MB` : ''}`);
      return 0;
    }

    if (action === 'verify') {
      const res = await stick.verify(target);
      console.log('');
      console.log(`${B}Stick${X} ${res.root || target}`);
      if (res.layout) {
        for (const [key, value] of Object.entries(res.layout)) {
          console.log(`  ${mark(!!value)} ${key}`);
        }
      }
      if (typeof res.freeBytes === 'number') {
        console.log(`  ${D}frei: ${Math.round(res.freeBytes / 1048576)} MB${X}`);
      }
      printProblems(res.problems, 'Probleme');
      console.log('');
      console.log(res.ok ? `${G}✓ Der Stick ist in Ordnung.${X}` : `${R}✗ Der Stick ist so nicht startklar.${X}`);
      return res.ok ? 0 : 1;
    }

    console.error(`Unbekannte Stick-Aktion "${action}". Verfügbar: prepare, update, verify, runtime, model`);
    return 1;
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------ stick model */

/**
 * Das Modell auf den Stick -- derselbe Weg wie im Browser, ohne Browser.
 *
 * Dieselbe Maschinerie (`src/portable/model.js`), kein zweiter Weg: `list`
 * ist finden() + aufDemStick(), `plan` ist planen() und schreibt nichts,
 * `copy` ist planen() und dann kopieren(). Ein Stopp-Hindernis wird vorher
 * gemeldet und der Vorgang gar nicht erst begonnen -- die Kommandozeile hat
 * dieselbe Pflicht wie die Ansicht, kein halbes Modell zu hinterlassen.
 *
 * Es wird KEINE Anwendung hochgefahren: finden und kopieren brauchen weder
 * den Tresor noch den Server, und ein `stick model list` soll auch dann
 * gehen, wenn Neural OS gerade laeuft und den Heimatordner gesperrt haelt.
 */
async function cmdStickModel(flags, args) {
  const action = args._[2] || 'list';
  const target = args._[3];
  const { createPortableModels, GERAETE } = require('../src/portable/model');
  const { humanBytes } = require('../src/portable/stick');
  const logMod = require('../src/kernel/log');
  // Ohne createApp() setzt niemand die Stufe -- und eine INFO-Zeile mitten im
  // Fortschrittsbalken liest sich wie ein Fehler.
  logMod.setLevel(typeof flags.log === 'string' ? flags.log : (process.env.NEURAL_OS_LOG_LEVEL || 'warn'));
  const modelle = createPortableModels({ logger: logMod.logger });
  const fuer = typeof flags.fuer === 'string' ? flags.fuer : undefined;
  const auswahl = typeof flags.auswahl === 'string'
    ? flags.auswahl.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const befund = modelle.finden();
  const alle = [...befund.kerne, ...befund.modelle];

  const zeigeRechner = () => {
    console.log('');
    console.log(`${B}Auf diesem Rechner${X} ${D}(${befund.rechner.plattform})${X}`);
    if (!alle.length) {
      console.log(`  ${Y}·${X} kein lokales Modell und kein Laufzeitkern gefunden`);
    }
    for (const fund of alle) {
      const art = fund.rolle === 'kern' ? `Laufzeitkern (${fund.art}, ${fund.plattform})` : `Modell (${fund.art})`;
      const bit = fund.rolle === 'kern' && !fund.ausfuehrbar ? ` ${Y}ohne Ausfuehrbar-Bit${X}` : '';
      console.log(`  ${G}✓${X} ${fund.name}  ${D}${art} · ${humanBytes(fund.bytes)} · ${fund.id}${X}${bit}`);
    }
    printProblems(befund.hinweise, 'Hinweise');
  };

  const zeigeStick = (stand) => {
    console.log('');
    console.log(`${B}Auf dem Stick${X} ${stand.wurzel} ${D}(gefragt fuer ${stand.fuer.name})${X}`);
    for (const k of stand.kerne) {
      console.log(`  ${mark(k.plattform === stand.fuer.plattform && stand.fuer.kannProgrammeStarten)} Laufzeitkern ${k.name} fuer ${k.plattform}  ${D}${humanBytes(k.bytes)}${X}`);
    }
    for (const m of stand.modelle) {
      console.log(`  ${G}✓${X} ${m.name}  ${D}${m.art} · ${humanBytes(m.bytes)} · ${m.dateien} Datei(en)${X}`);
    }
    console.log(`  ${stand.passt ? G : Y}${stand.satz}${X}`);
    printProblems(stand.warnungen, 'Warnungen');
    printProblems(stand.hinweise, 'Hinweise');
  };

  const zeigePlan = (plan) => {
    console.log('');
    console.log(`${B}Plan${X} ${plan.zusammenfassung}`);
    if (plan.dateisystem) {
      const fsInfo = plan.dateisystem;
      const grenze = Number.isFinite(fsInfo.maxFileBytes) ? ` · groesste Datei max. ${humanBytes(fsInfo.maxFileBytes)}` : '';
      console.log(`  ${D}Dateisystem: ${fsInfo.typeName || 'unbekannt'}${grenze}${X}`);
    }
    if (plan.groessteDatei) console.log(`  ${D}groesste Datei: ${humanBytes(plan.groessteDatei.bytes)}${X}`);
    console.log(`  ${D}gebraucht: ${humanBytes(plan.bytesMitKopfraum)} · frei: ${plan.frei === null ? 'unbekannt' : humanBytes(plan.frei)}${X}`);
    if (plan.uebersprungen.length) {
      console.log(`  ${D}${plan.uebersprungen.length} Datei(en) liegen schon dort oder sind geteilt (${humanBytes(plan.bytesUebersprungen)})${X}`);
    }
    for (const h of plan.hindernisse) {
      console.log(`  ${h.schwere === 'stopp' ? `${R}✗` : `${Y}·`}${X} ${h.satz}`);
    }
    printProblems(plan.hinweise, 'Hinweise');
    console.log('');
    console.log(plan.kannLosgehen
      ? `${G}✓ Nichts spricht dagegen.${X}`
      : `${R}✗ So kann es nicht losgehen.${X}`);
  };

  if (action === 'list') {
    zeigeRechner();
    if (target) zeigeStick(modelle.aufDemStick(target, { fuer }));
    else {
      console.log('');
      console.log(`${D}Mit Pfad (neural-os stick model list /pfad/zum/stick) steht hier auch, was auf dem Stick liegt.${X}`);
    }
    return 0;
  }

  if (action === 'plan' || action === 'copy') {
    if (!target) throw new Error(`Bitte den Pfad zum Stick angeben: neural-os stick model ${action} /pfad/zum/stick`);
    const gewaehlt = auswahl || alle.map((f) => f.id);
    const plan = modelle.planen({ ziel: target, befund, auswahl: gewaehlt, fuer });
    zeigeRechner();
    zeigePlan(plan);
    if (action === 'plan') return plan.kannLosgehen ? 0 : 1;
    if (!plan.kannLosgehen) return 1;

    let lastPhase = null;
    const onProgress = (p) => {
      if (!p) return;
      if (p.phase && p.phase !== lastPhase) {
        lastPhase = p.phase;
        process.stdout.write(`\n  ${D}${p.message || p.phase}${X}`);
      } else if (p.message) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`  ${D}${String(p.message).slice(0, 70)}${X}`);
      }
    };
    const res = await modelle.kopieren(target, {
      befund,
      auswahl: gewaehlt,
      fuer,
      pruefsummen: typeof flags.pruefsummen === 'string' ? flags.pruefsummen : 'auto',
      onProgress,
    });
    console.log('');
    console.log(`${G}✓${X} ${res.kopiert.dateien} Datei(en), ${humanBytes(res.kopiert.bytes)} liegen jetzt auf dem Stick: ${B}${res.ordner}${X}`);
    if (res.uebersprungen) console.log(`  ${D}${res.uebersprungen} Datei(en) lagen schon dort (${humanBytes(res.bytesUebersprungen)}).${X}`);
    printProblems(res.warnungen, 'Hinweise');
    zeigeStick(modelle.aufDemStick(target, { fuer }));
    return 0;
  }

  console.error(`Unbekannte Modell-Aktion "${action}". Verfügbar: list, plan, copy`
    + `${D} · --fuer kennt u. a. ${Object.keys(GERAETE).join(', ')}${X}`);
  return 1;
}

/** Print whatever the stick tool reported, in whichever shape it used. */
function printProblems(list, heading) {
  if (!Array.isArray(list) || !list.length) return;
  console.log(`\n${B}${heading}${X}`);
  for (const entry of list) {
    if (typeof entry === 'string') { console.log(`  ${Y}·${X} ${entry}`); continue; }
    const level = entry.level === 'error' ? `${R}✗${X}` : `${Y}·${X}`;
    console.log(`  ${level} ${entry.message || entry.code || JSON.stringify(entry)}`);
    if (entry.fix) console.log(`      ${D}${entry.fix}${X}`);
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
    case 'stick': return cmdStick(flags, args);
    default:
      console.error(`Unbekannter Befehl: ${cmd}\nVerfügbar: start, doctor, export, import, compact, stick, version`);
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
