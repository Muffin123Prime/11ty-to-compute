#!/usr/bin/env node
'use strict';

/**
 * Neural OS command line.
 *
 *   neural-os [start]          start the local server in the foreground (Strg+C)
 *   neural-os start --hintergrund [--open]
 *                              Starter fuer den Doppelklick: startet Neural OS
 *                              abgeloest im Hintergrund, oeffnet den Browser und
 *                              endet; laeuft es schon, nur den Browser
 *   neural-os stop             ein laufendes Neural OS beenden ([Beenden])
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
 *               --passphrase P   (prefer NEURAL_OS_PASSPHRASE)
 *
 * Ist der Tresor mit einer PIN verschluesselt und keine Passphrase gegeben,
 * startet Neural OS gesperrt; die PIN kommt im Browser (Vorraum).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createApp, seedIfEmpty, VERSION } = require('../src/app');
const { asNeuralError } = require('../src/kernel/errors');
const pathsMod = require('../src/kernel/paths');
const laufzettel = require('../src/kernel/laufzettel');
const logMod = require('../src/kernel/log');

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

// Farben nur in einem Terminal: in eine Datei, ein Rohr oder das Protokoll
// des Dienstes gehören keine Steuerzeichen (Stick-Bauplan 2.4).
const FARBE = process.stdout.isTTY === true;
const B = FARBE ? '\u001b[1m' : '';
const D = FARBE ? '\u001b[2m' : '';
const G = FARBE ? '\u001b[32m' : '';
const Y = FARBE ? '\u001b[33m' : '';
const R = FARBE ? '\u001b[31m' : '';
const X = FARBE ? '\u001b[0m' : '';

function mark(ok) {
  return ok ? `${G}✓${X}` : `${R}✗${X}`;
}

async function boot(flags, extra = {}) {
  return createApp({
    home: homeAus(flags),
    port: flags.port ? Number(flags.port) : undefined,
    host: typeof flags.host === 'string' ? flags.host : undefined,
    logLevel: typeof flags.log === 'string' ? flags.log : undefined,
    harden: flags.harden !== false && flags['no-harden'] !== true,
    passphrase: typeof flags.passphrase === 'string' ? flags.passphrase : process.env.NEURAL_OS_PASSPHRASE,
    ...extra,
  });
}

/* ------------------------------------------------------------------ start */

/*
 * Start ohne Fenster (Stick-Bauplan 2.4, Paket S).
 *
 *   start                  im Vordergrund, wie immer; Strg+C, SIGTERM und das
 *                          Schließen des Terminals (SIGHUP, Windows: SIGBREAK)
 *                          beenden sauber -- auch schon während des Starts.
 *   start --hintergrund    der STARTER des Doppelklicks: prüft den Laufzettel
 *                          (läuft schon -> nur Browser), macht eine
 *                          Schreibprobe, startet den DIENST abgelöst, wartet
 *                          auf {bereit:{url}}, öffnet den Browser und endet.
 *   dienst                 intern: läuft ohne Fenster, Protokoll in
 *                          data/protokoll/dienst.log, Wächter für Stick und
 *                          Leerlauf.
 *
 * Ist der Tresor verschlüsselt und keine Passphrase gegeben, lauscht bis zur
 * PIN nur der Vorraum (src/kernel/vorraum.js, Paket V) auf dem Port der KI;
 * danach übernimmt die Anwendung DENSELBEN Port. Der Browser öffnet dann die
 * PIN-Seite (/api/entsperren), nicht "/": dort zeigte der Service Worker die
 * alte Schale.
 */

const WARTEN_MS = 120 * 1000;
const DAUERT_NOCH_MS = 10 * 1000;
const ABBRUCH = Symbol('abbruch');

const schlafen = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Eine Zeile an den Menschen vor dem Fenster; ein geschlossenes Terminal ist kein Fehler. */
function sagen(text) {
  try { process.stdout.write(`${text}\n`); } catch { /* Terminal schon zu */ }
}

/** --home ist relativ zum Aufrufer gemeint; der Dienst läuft in os.tmpdir(). */
function homeAus(flags) {
  return typeof flags.home === 'string' ? path.resolve(flags.home) : undefined;
}

function portWunsch(flags) {
  if (flags.port === undefined || flags.port === true) return undefined;
  const n = Number(flags.port);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

/**
 * Was vor der Anwendung schon feststehen muss: für den Vorraum der Port und
 * die Kennung der KI (das Sitzungs-Cookie heißt nos_s_<KI>, und die
 * Anwendung danach muss es wiedererkennen). Die Identität (Paket G/I) legt
 * eine fehlende Kennung an und holt einen Stick von 7777 auf seinen eigenen
 * Port; createApp tut dasselbe und findet dann alles vor.
 */
function vorschau(paths, flags) {
  const configMod = require('../src/kernel/config');
  let config;
  try {
    config = configMod.load(paths.config);
  } catch (err) {
    if (!err || !err.recovered) throw err;
    config = err.recovered;
  }
  const portable = pathsMod.portableInfo(paths.home);
  let ki = { id: null, name: null };
  try {
    const identitaet = require('../src/kernel/identitaet').createIdentitaet({
      config, paths, portable, speichern: (c) => configMod.save(paths.config, c),
    });
    identitaet.sicherstellen();
    ki = { id: identitaet.id || null, name: identitaet.name || null };
  } catch { /* createApp meldet es gleich, mit Grund */ }
  const wunsch = portWunsch(flags);
  const port = wunsch !== undefined ? wunsch : (Number(config.server && config.server.port) || 7777);
  return { config, portable, ki, port };
}

/**
 * Lauschen. Kommt die Anwendung aus dem Vorraum, auf DESSEN Port: Die
 * PIN-Seite im Browser fragt genau dort nach, bis die Schale antwortet. Der
 * Port ist gerade erst frei geworden; ein paar kurze Versuche fangen ab,
 * dass das Betriebssystem ihn noch einen Augenblick hält.
 */
async function lauschen(app, { port, tryPorts }) {
  if (Number.isInteger(port) && port > 0) {
    for (let versuch = 0; versuch < 20; versuch++) {
      try {
        await app.listen({ port, tryPorts: 1 });
        return `${app.server.url}/`;
      } catch (err) {
        if (!err || (err.code !== 'PORT_IN_USE' && err.code !== 'PORT_FORBIDDEN')) throw err;
        await schlafen(100);
      }
    }
    // Jemand hat den Port in der Lücke genommen: ein anderer, und der Browser dorthin.
    await app.listen({ tryPorts });
    const url = `${app.server.url}/`;
    await require('../src/portable/open').openInBrowser(url);
    return url;
  }
  await app.listen({ tryPorts });
  return `${app.server.url}/`;
}

/**
 * Hochfahren, für Vordergrund und Dienst gleich:
 *   Laufzettel "startet" -> Signale -> (Vorraum, Laufzettel "gesperrt")
 *   -> Anwendung -> lauschen -> Laufzettel "bereit".
 *
 * @param {object} flags
 * @param {{dienst:boolean, erreichbar?:(url:string)=>any,
 *   beiStart?:(x:{lage:object, beenden:Function, portable:object|null})=>void}} o
 *   `erreichbar`: sobald ein Browser etwas sehen kann (der Vorraum);
 *   `beiStart`: gleich nach Laufzettel und Signalen (der Dienst startet dort den Wächter).
 * @returns {Promise<{app:object, url:string, seeded:boolean, extensions:object,
 *   beenden:(grund:string, code?:number)=>Promise<void>, gesperrt:boolean}>}
 * @throws NeuralError LAEUFT_SCHON {url} | STARTET_SCHON | AELTERE_VERSION | alles aus createApp
 */
async function hochfahren(flags, { dienst, erreichbar = () => {}, beiStart = () => {} }) {
  const vorraumMod = require('../src/kernel/vorraum');
  const paths = pathsMod.ensureLayout(pathsMod.layout(homeAus(flags)));
  const heim = laufzettel.heimKennung(paths.home);
  const instanz = laufzettel.neueInstanz();
  const zettel = await laufzettel.anlegen(paths, { instanz, heim, zustand: 'startet' });
  const log = logMod.logger('start');

  const lage = { app: null, vorraum: null, boot: null, ende: null, waechter: null };

  /** Sauber enden: Vorraum zu, Anwendung zu (Tresor gesichert), Laufzettel weg, exit. */
  function beenden(grund, code = 0) {
    if (lage.ende) return lage.ende;
    lage.ende = (async () => {
      log.info(`Neural OS endet (${grund}).`);
      if (lage.waechter) lage.waechter.stoppe();
      // Windows beendet einen Prozess etwa 10 s nach dem Schließen seines
      // Fensters ohnehin; bis dahin muss alles zu sein.
      const notbremse = setTimeout(() => {
        zettel.freigeben();
        process.exit(code);
      }, 8000);
      try {
        if (lage.vorraum) await lage.vorraum.schliessen().catch(() => {});
        if (lage.boot) await lage.boot.catch(() => {});
        if (lage.app) {
          const probleme = await lage.app.close();
          if (probleme && probleme.length) log.warn(`Beim Beenden: ${JSON.stringify(probleme)}`);
        }
      } catch (err) {
        log.error(`Beim Beenden: ${err && err.message}`);
      } finally {
        zettel.freigeben();
        clearTimeout(notbremse);
        process.exit(code);
      }
    })();
    return lage.ende;
  }

  // Die Signale gleich nach dem Laufzettel: Wer das Fenster während des
  // Starts schließt, soll keine Sperren hinterlassen (belegt, p1d).
  if (dienst) {
    // Abgelöst in eigener Sitzung; ein SIGHUP ist hier nie "Fenster zu".
    process.on('SIGHUP', () => {});
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { beenden(sig); });
  } else {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      process.on(sig, () => {
        if (sig !== 'SIGHUP') sagen(`\n${D}${sig} — schließe sauber ab …${X}`);
        beenden(sig);
      });
    }
  }

  const weiter = () => { if (lage.ende) throw ABBRUCH; };

  try {
    const { config, portable, ki, port } = vorschau(paths, flags);
    beiStart({ lage, beenden, portable });
    const tryPorts = portWunsch(flags) !== undefined ? 1 : (portable ? 20 : 12);

    let passphrase = typeof flags.passphrase === 'string' && flags.passphrase
      ? flags.passphrase
      : (process.env.NEURAL_OS_PASSPHRASE || undefined);
    let vorraumPort = null;
    let sitzung = false;
    let gesperrt = false;

    let vorraumNoetig = false;
    try {
      vorraumNoetig = !passphrase && vorraumMod.noetig({ paths, config, ki });
    } catch (err) {
      // Den Grund (etwa ein beschädigtes secrets.json) sagt createApp gleich genauer.
      log.warn(`Vorraum nicht geprüft: ${err && err.message}`);
    }
    if (vorraumNoetig) {
      gesperrt = true;
      lage.vorraum = await vorraumMod.oeffnen({ paths, config, host: '127.0.0.1', port, tryPorts, ki, instanz, heim });
      weiter();
      zettel.aktualisieren({ zustand: 'gesperrt', port: lage.vorraum.port, url: lage.vorraum.url });
      await erreichbar(lage.vorraum.url);
      const offen = await lage.vorraum.entsperrt;
      weiter();
      passphrase = offen.passphrase || undefined;
      sitzung = offen.sitzung === true;
      vorraumPort = offen.port;
      // Bis die Anwendung lauscht, ist der Port einen Augenblick zu. "startet"
      // statt "gesperrt": sonst hielte ein zweiter Doppelklick genau jetzt
      // den Zettel für verwaist und startete ein zweites Neural OS.
      zettel.aktualisieren({ zustand: 'startet' });
    }

    lage.boot = boot(flags, { passphrase }).then((app) => { lage.app = app; return app; });
    const app = await lage.boot;
    lage.boot = null;
    weiter();
    app.instanz = instanz;
    app.beenden = (grund) => beenden(grund || 'knopf');

    const seeded = await seedIfEmpty(app);
    // Extensions come up only after the rest of the system is known healthy.
    const extensions = await app.loadModules({ safeMode: flags.safe === true });
    weiter();

    // Die Übergabe vom Vorraum so kurz wie möglich: alles andere ist schon da.
    if (sitzung && app.auth && typeof app.auth.bindungEinschalten === 'function') app.auth.bindungEinschalten();
    if (lage.vorraum) {
      await lage.vorraum.schliessen();
      lage.vorraum = null;
    }
    const url = await lauschen(app, { port: vorraumPort, tryPorts });
    weiter();
    zettel.aktualisieren({ zustand: 'bereit', port: app.server.server.address().port, url });
    return { app, url, seeded, extensions, beenden, gesperrt };
  } catch (err) {
    if (err === ABBRUCH || lage.ende) return lage.ende;
    if (lage.vorraum) await lage.vorraum.schliessen().catch(() => {});
    if (lage.app) await lage.app.close().catch(() => {});
    zettel.freigeben();
    throw err;
  }
}

async function oeffnen(url) {
  const { openInBrowser } = require('../src/portable/open');
  const result = await openInBrowser(url);
  if (!result.opened) {
    sagen(`  ${D}Browser konnte nicht geöffnet werden (${result.reason || 'unbekannt'}). Adresse von Hand aufrufen: ${url}${X}`);
  }
  return result;
}

/** `start` im Vordergrund. */
async function cmdStart(flags) {
  // Ein geschlossenes Terminal macht aus jedem Schreiben ein EIO/EPIPE; das
  // darf das saubere Ende nicht überholen.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  let geoeffnet = false;
  let r;
  try {
    r = await hochfahren(flags, {
      dienst: false,
      erreichbar: async (url) => {
        sagen('');
        sagen(`  ${B}Gesperrt.${X} Die PIN kommt im Browser: ${B}${url}${X}`);
        sagen('');
        if (flags.open === true) {
          geoeffnet = true;
          await oeffnen(url);
        }
      },
    });
  } catch (err) {
    if (err && err.code === 'LAEUFT_SCHON') {
      const url = err.details && err.details.url;
      sagen(`Neural OS läuft schon: ${url}`);
      if (flags.open === true && url) await oeffnen(url);
      return 0;
    }
    throw err;
  }
  if (!r || !r.app) return undefined; // endet gerade
  const { app, url, seeded, extensions } = r;
  const health = await app.doctor();
  const port = app.config.server.port;
  // Nur ein Port aus der Konfiguration kann "belegt gewesen" sein; ein
  // ausdrücklich gewählter (auch 0 = irgendeiner) nicht.
  const movedPort = portWunsch(flags) === undefined && !url.includes(`:${port}/`);

  console.log('');
  console.log(`${B}Neural OS${X} ${D}v${VERSION} · Node ${process.version}${X}`);
  console.log(`${D}${'─'.repeat(58)}${X}`);
  console.log(`  Oberfläche    ${B}${url}${X}${movedPort ? ` ${Y}(Port ${port} war belegt)${X}` : ''}`);
  if (app.ki && app.ki.name) console.log(`  KI            ${app.ki.name}`);
  if (app.portable) {
    // A mode that changes where somebody's notes live is never implicit.
    console.log(`  ${B}Portabel${X}      ${G}Daten auf dem Datenträger${X} ${D}${app.portable.root}${X}`);
  }
  if (app.homeHinweis) console.log(`  ${Y}${app.homeHinweis}${X}`);
  console.log(`  Daten         ${app.paths.home}`);
  console.log(`  Netzmodus     ${netLabel(app.config.network.mode)}${health.network.hardened ? ` ${D}(prozessweit durchgesetzt)${X}` : ` ${Y}(NICHT durchgesetzt)${X}`}`);
  console.log(`  Vault         ${health.vault.counts ? Object.entries(health.vault.counts).map(([k, v]) => `${v} ${k}`).join(', ') : '0 Einträge'}${app.vaultCrypto && app.vaultCrypto.enabled ? ' · verschlüsselt' : ''}`);

  const kl = health.claude;
  if (kl && kl.verbunden) {
    console.log(`  Claude        ${mark(true)} verbunden ${D}(${kl.modell})${X}`);
  } else {
    console.log(`  Claude        ${Y}nicht verbunden${X} ${D}— ${(kl && kl.grund) || 'Claude ist nicht geladen.'}${X}`);
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

  if (flags.open === true && !geoeffnet) await oeffnen(url);
  return undefined;
}

/* ---------------------------------------------------------------- dienst */

/** Die letzten Zeilen des Dienst-Protokolls, nur vom letzten Start. */
function protokollEnde(paths, anzahl = 15) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(paths.home, 'protokoll', 'dienst.log'), 'utf8');
  } catch {
    return [];
  }
  const zeilen = text.split('\n').filter((z) => z.trim());
  let ab = 0;
  zeilen.forEach((z, i) => { if (z.includes('[dienst] Dienst startet')) ab = i; });
  return zeilen.slice(ab).slice(-anzahl);
}

/** `dienst`: intern, ohne Fenster, vom Starter abgelöst gestartet. */
async function cmdDienst(flags) {
  // Der Stick darf nicht festgehalten werden: Windows meldet ihn sonst beim
  // Auswerfen als "in Verwendung".
  try { process.chdir(os.tmpdir()); } catch { /* bleibt, wo es ist */ }

  /** An den Starter, solange er zuhört; die Rückgabe wartet, bis es raus ist. */
  const melde = (nachricht) => new Promise((resolve) => {
    try {
      if (typeof process.send === 'function' && process.connected) {
        process.send(nachricht, () => resolve());
        return;
      }
    } catch { /* Starter schon weg */ }
    resolve();
  });

  try {
    const paths = pathsMod.layout(homeAus(flags));
    logMod.setSink(logMod.dateiSenke(path.join(paths.home, 'protokoll', 'dienst.log')));
  } catch { /* ohne Protokoll geht es auch; die Schreibprobe des Starters hat bestanden */ }
  const log = logMod.logger('dienst');
  log.info(`Dienst startet (PID ${process.pid}, Neural OS ${VERSION}, Node ${process.version}, ${process.platform}).`);

  let laufend = null;
  let gescheitert = false;
  const scheitern = async (err) => {
    if (gescheitert) return;
    gescheitert = true;
    const e = asNeuralError(err);
    log.error(`${e.code}: ${e.message}`);
    if (err && err.stack) log.debug(String(err.stack));
    await melde({ fehler: { text: e.message, code: e.code } });
    process.exit(1);
  };
  process.on('uncaughtException', (err) => {
    log.error(`Unerwarteter Fehler: ${(err && err.stack) || err}`);
    if (laufend) laufend.beenden('fehler', 1);
    else scheitern(err);
  });
  process.on('unhandledRejection', (err) => {
    log.error(`Unbehandelt: ${(err && err.stack) || err}`);
    if (!laufend) scheitern(err);
  });

  const start = Date.now();
  let r;
  try {
    r = await hochfahren(flags, {
      dienst: true,
      erreichbar: (url) => melde({ bereit: { url } }),
      beiStart: ({ lage, beenden, portable }) => {
        lage.waechter = require('../src/kernel/waechter').starte({
          marker: portable && portable.marker ? portable.marker : null,
          aktivitaet: () => (lage.app && lage.app.server && typeof lage.app.server.aktivitaet === 'function'
            ? lage.app.server.aktivitaet()
            : { streams: 0, inFlight: 0, letzteAnfrage: start }),
          beenden: (grund) => beenden(grund),
          // Stick weg: sofort, ohne flush und ohne Laufzettel -- beides läge auf dem Stick.
          ende: (code) => process.exit(code),
          log: logMod.logger('waechter'),
        });
      },
    });
  } catch (err) {
    if (err && (err.code === 'LAEUFT_SCHON' || err.code === 'STARTET_SCHON')) {
      log.info(err.message);
      await melde({ schon: { url: (err.details && err.details.url) || null } });
      process.exit(0);
    }
    await scheitern(err);
    return undefined;
  }
  if (!r || !r.app) return undefined; // endet gerade
  laufend = r;
  log.info(`Bereit: ${r.url}`);
  await melde({ bereit: { url: r.url } });
  return undefined;
}

/* --------------------------------------------------------------- starter */

/**
 * Läuft schon eines (oder startet gerade)? Dann dessen Adresse.
 * @returns {Promise<{url?:string, satz?:string}>}
 */
async function laufendesAbwarten(paths, dauertNoch) {
  const bis = Date.now() + WARTEN_MS;
  for (;;) {
    const befund = await laufzettel.pruefen(paths);
    if (befund.zustand === 'laeuft') return { url: befund.url };
    if (befund.zustand === 'aeltere') return { satz: 'Neural OS läuft schon (ältere Version). Bitte dort beenden.' };
    if (befund.zustand !== 'startet') return {};
    if (Date.now() > bis) return { grund: 'Ein anderer Start ist nach 120 s nicht fertig geworden.' };
    dauertNoch();
    await schlafen(300);
  }
}

/** Kann hier geschrieben werden? Ein schreibgeschützter Stick scheitert sonst erst im Tresor. */
function schreibprobe(paths) {
  const datei = path.join(paths.home, `.schreibprobe-${process.pid}`);
  try {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(datei, 'x');
    fs.unlinkSync(datei);
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(datei); } catch { /* gab es nie */ }
    return { ok: false, code: err && err.code, grund: err && err.message };
  }
}

function startScheitert(paths, grund) {
  sagen('Neural OS konnte nicht starten:');
  const zeilen = protokollEnde(paths, 15);
  for (const z of zeilen) sagen(z);
  if (grund && !zeilen.some((z) => z.includes(grund))) sagen(grund);
  return 1;
}

async function browserAuf(flags, url) {
  if (flags.open === true) await oeffnen(url);
  else sagen(url);
  sagen('Fertig. Dieses Fenster kann zu.');
  return 0;
}

/** `start --hintergrund`: der Starter des Doppelklicks. */
async function cmdStarter(flags) {
  sagen('Neural OS startet …');
  const paths = pathsMod.layout(homeAus(flags));
  const portable = pathsMod.portableInfo(paths.home);
  const t0 = Date.now();
  let gesagt = false;
  const dauertNoch = () => {
    if (gesagt || Date.now() - t0 < DAUERT_NOCH_MS) return;
    gesagt = true;
    sagen('Neural OS startet … (dauert noch)');
  };

  // 1. Läuft es schon? Dann nur der Browser.
  const schon = await laufendesAbwarten(paths, dauertNoch);
  if (schon.url) return browserAuf(flags, schon.url);
  if (schon.satz) { sagen(schon.satz); return 1; }
  if (schon.grund) return startScheitert(paths, schon.grund);

  // 2. Schreibprobe.
  const probe = schreibprobe(paths);
  if (!probe.ok) {
    if (portable || probe.code === 'EROFS') { sagen('Der Stick ist schreibgeschützt.'); return 1; }
    return startScheitert(paths, probe.grund);
  }

  // 3. Den Dienst abgelöst starten. Kein geerbter Deskriptor: Unter Windows
  //    setzt libuv dann CREATE_NO_WINDOW (kein zweites Fenster), und unter
  //    macOS/Linux stirbt ein Kind mit geerbtem stdio nach dem Schließen des
  //    Terminals an EIO (Stick-Bauplan 2.4).
  const args = [__filename, 'dienst'];
  if (typeof flags.home === 'string') args.push('--home', path.resolve(flags.home));
  for (const name of ['port', 'host', 'log']) {
    if (typeof flags[name] === 'string') args.push(`--${name}`, flags[name]);
  }
  if (flags.safe === true) args.push('--safe');
  if (flags['no-harden'] === true || flags.harden === false) args.push('--no-harden');
  const env = { ...process.env };
  // Eine Passphrase gehört nicht in die Befehlszeile, die jeder Prozess lesen kann.
  if (typeof flags.passphrase === 'string') env.NEURAL_OS_PASSPHRASE = flags.passphrase;

  let kind;
  try {
    kind = require('node:child_process').spawn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      cwd: os.tmpdir(),
      env,
    });
  } catch (err) {
    return startScheitert(paths, err && err.message);
  }

  // 4. Warten auf {bereit}, höchstens 120 s, solange der Dienst lebt.
  const antwort = await new Promise((resolve) => {
    let fertig = false;
    const takt = setInterval(dauertNoch, 500);
    const grenze = setTimeout(() => ende({ zeit: true }), WARTEN_MS);
    function ende(wert) {
      if (fertig) return;
      fertig = true;
      clearInterval(takt);
      clearTimeout(grenze);
      resolve(wert);
    }
    kind.on('message', (m) => {
      if (m && m.bereit && typeof m.bereit.url === 'string') ende({ url: m.bereit.url });
      else if (m && m.fehler) ende({ fehler: String(m.fehler.text || '') });
      else if (m && m.schon) ende({ schon: true });
    });
    kind.once('exit', (code) => ende({ ende: code }));
    kind.once('error', (err) => ende({ fehler: err && err.message }));
  });
  // Loslassen: Der Dienst lebt allein weiter, der Starter darf enden.
  try { if (kind.connected) kind.disconnect(); } catch { /* schon getrennt */ }
  kind.unref();

  if (antwort.url) return browserAuf(flags, antwort.url);
  if (antwort.schon) {
    // Ein anderer Doppelklick war schneller: zu dessen Neural OS.
    const nochmal = await laufendesAbwarten(paths, dauertNoch);
    if (nochmal.url) return browserAuf(flags, nochmal.url);
    if (nochmal.satz) { sagen(nochmal.satz); return 1; }
    return startScheitert(paths, nochmal.grund || 'Der andere Start ist nicht fertig geworden.');
  }
  if (antwort.zeit) return startScheitert(paths, 'Nach 120 s kam keine Antwort.');
  return startScheitert(paths, antwort.fehler || `Der Dienst endete (Code ${antwort.ende}).`);
}

/* ------------------------------------------------------------------ stop */

/** POST /api/system/beenden an 127.0.0.1:<port>. */
function beendenAnfragen(port) {
  const { classify } = require('../src/net/gate');
  if (classify('127.0.0.1') !== 'loopback') return Promise.reject(new Error('Nur lokal.'));
  return new Promise((resolve, reject) => {
    const koerper = Buffer.from('{}');
    const req = require('node:http').request({
      host: '127.0.0.1', port, path: '/api/system/beenden', method: 'POST', agent: false,
      headers: { host: `127.0.0.1:${port}`, 'x-neural-os': '1', 'content-type': 'application/json', 'content-length': koerper.length },
    }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(teile).toString('utf8')); } catch { /* egal */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Keine Antwort.')));
    req.end(koerper);
  });
}

/** `stop`: ein laufendes Neural OS beenden, wie [Beenden]. */
async function cmdStop(flags) {
  const paths = pathsMod.layout(homeAus(flags));
  const befund = await laufzettel.pruefen(paths);
  if (befund.zustand === 'startet') { sagen('Neural OS startet gerade; gleich noch einmal versuchen.'); return 1; }
  if (befund.zustand === 'aeltere') { sagen('Neural OS läuft schon (ältere Version). Bitte dort beenden.'); return 1; }
  if (befund.zustand !== 'laeuft') { sagen('Neural OS läuft nicht.'); return 0; }
  const z = befund.zettel;

  let antwort;
  try {
    antwort = await beendenAnfragen(z.port);
  } catch (err) {
    antwort = { status: 0, json: { error: { message: err && err.message } } };
  }
  if (antwort.status !== 202) {
    // Gesperrt (Vorraum) oder an den Browser mit der PIN gebunden: Dann
    // beendet SIGTERM sauber -- nur nicht unter Windows, dort ist es ein
    // TerminateProcess ohne Aufräumen.
    if (process.platform === 'win32') {
      const grund = antwort.json && antwort.json.error && antwort.json.error.message;
      sagen(`Neural OS ließ sich nicht beenden${grund ? `: ${grund}` : '.'}`);
      return 1;
    }
    try { process.kill(z.pid, 'SIGTERM'); } catch { /* schon weg */ }
  }
  const bis = Date.now() + 10000;
  while (Date.now() < bis && laufzettel.pidLebt(z.pid)) await schlafen(100);
  if (laufzettel.pidLebt(z.pid)) { sagen('Neural OS reagiert nicht.'); return 1; }
  sagen('Neural OS ist beendet.');
  return 0;
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

    console.log(`\n${B}Claude${X}`);
    const kl = h.claude;
    if (!kl) {
      console.log(`  ${R}✗${X} nicht geladen`);
    } else {
      console.log(`  ${mark(kl.verbunden)} ${kl.verbunden ? 'verbunden' : 'nicht verbunden'} ${D}(${kl.modell})${X}`);
      console.log(`      ${D}Schlüssel: ${kl.schluesselVorhanden ? (kl.gesperrt ? 'im gesperrten Tresor' : 'im Tresor') : 'keiner'} · Netz: ${kl.netz ? `${kl.netz.modus}, ${kl.netz.erlaubt ? 'api.anthropic.com erlaubt' : 'api.anthropic.com gesperrt'}` : 'unbekannt'}${X}`);
      if (!kl.verbunden && kl.grund) console.log(`      ${D}${kl.grund}${X}`);
    }
    console.log(`  ${D}Ohne Claude antwortet der Chat nicht – Notizen, Kalender und Suche funktionieren trotzdem.${X}`);

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
  if (action === 'model') {
    // Die Offline-KI ist entfallen: auf den Stick gehört kein Modell mehr.
    console.error('„stick model“ gibt es nicht mehr: die KI von Neural OS ist Claude, ein Modell auf dem Stick braucht es nicht.');
    return 1;
  }
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

    console.error(`Unbekannte Stick-Aktion "${action}". Verfügbar: prepare, update, verify, runtime`);
    return 1;
  } finally {
    await app.close();
  }
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
    case 'start': return flags.hintergrund === true ? cmdStarter(flags) : cmdStart(flags);
    case 'dienst': return cmdDienst(flags);
    case 'stop': return cmdStop(flags);
    case 'doctor': return cmdDoctor(flags);
    case 'export': return cmdExport(flags);
    case 'import': return cmdImport(flags, args);
    case 'compact': return cmdCompact(flags);
    case 'stick': return cmdStick(flags, args);
    default:
      console.error(`Unbekannter Befehl: ${cmd}\nVerfügbar: start, stop, doctor, export, import, compact, stick, version`);
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
