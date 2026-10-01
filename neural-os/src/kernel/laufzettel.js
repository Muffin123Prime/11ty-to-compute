'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const rechner = require('./rechner');
const { schreibeDauerhaft, fsyncOrdner } = require('./dateien');
const { NeuralError, StorageError } = require('./errors');

/**
 * Der Laufzettel `data/.lock` (Stick-Bauplan 2.4, Paket S).
 *
 * Er sagt, ob auf DIESEM Rechner schon ein Neural OS mit DIESEM Datenordner
 * läuft, und wenn ja, unter welcher Adresse. Ein Stick wandert: Ein Zettel,
 * den ein anderer Laptop oder derselbe vor dem letzten Neustart
 * hinterlassen hat, darf den Start nie blockieren (belegt, p1b), und ein
 * zweiter Doppelklick soll zum laufenden Neural OS führen statt zu einem
 * zweiten.
 *
 *   {"v":2, "pid":1234, "rechner":"<kennung>", "boot":1790000000, "seit":"ISO",
 *    "zustand":"startet|gesperrt|bereit", "port":21064, "url":"http://127.0.0.1:21064/",
 *    "instanz":"<12 Zeichen>", "heim":"<sha256(realpath(home))[0..15]>", "version":"0.1.0",
 *    "ordner":"<dev>:<ino> von data/ (nicht unter Windows)",
 *    "stopp":"<zufällig, das Beenden-Recht von `neural-os stop`>",
 *    "bau":"<Fingerabdruck des Programms, src/kernel/bau.js>"}
 *
 * `seit` ist der Zeitpunkt des letzten Zustandswechsels: "startet" gilt nur
 * 120 s, und wer zwischen Vorraum und Anwendung wieder auf "startet" geht,
 * darf nicht wegen einer langsam getippten PIN als verwaist gelten.
 *
 * Die PID allein beweist nichts (wiederverwendet, anderer Rechner, anderer
 * Start). Beweis ist erst die Gesundheitsabfrage: Unter dem Port antwortet
 * ein Neural OS mit derselben Instanz UND demselben Datenordner.
 */

const VERSION_ZETTEL = 2;
/** So lange darf ein Start dauern, bevor sein Zettel als verwaist gilt (USB 2, Bauplan Teil 3). */
const STARTET_MAX_MS = 120 * 1000;
/** Ein unlesbarer Zettel, jünger als das, wird gerade geschrieben (Bauplan: Regel 2, mit Schonfrist). */
const FRISCH_MS = 10 * 1000;
const GESUNDHEIT_MS = 1500;
const GESUNDHEIT_ZWEITER_VERSUCH_MS = 400;
const ANTWORT_MAX = 64 * 1024;

let programmVersion = '0.0.0';
try {
  programmVersion = require('../../package.json').version || programmVersion;
} catch { /* ohne package.json ist die Version nur Beiwerk */ }

/** Welcher Datenordner? Gleich für Starter, Dienst und /api/health. */
function heimKennung(home) {
  let echt;
  try {
    // Unter Windows löst erst der native Aufruf (GetFinalPathNameByHandle)
    // einen zweiten Laufwerksbuchstaben (subst) oder einen als Ordner
    // eingehängten Datenträger auf; der JavaScript-Weg kennt nur Verknüpfungen.
    echt = process.platform === 'win32' ? fs.realpathSync.native(home) : fs.realpathSync(home);
  } catch {
    try {
      echt = fs.realpathSync(home);
    } catch {
      echt = path.resolve(String(home || ''));
    }
  }
  if (process.platform === 'win32') echt = echt.replace(/^\\\\\?\\/, '');
  // Windows und macOS unterscheiden in Pfaden nicht zwischen Groß und Klein.
  if (process.platform === 'win32' || process.platform === 'darwin') echt = echt.toLowerCase();
  return crypto.createHash('sha256').update(echt).digest('hex').slice(0, 16);
}

/**
 * Welcher Ordner, unabhängig vom Pfad: Gerät und Dateinummer von `data/`.
 * Derselbe Stick unter einem zweiten Einhängepunkt (Bind-Mount), den
 * realpath nicht auflöst, hat ein anderes `heim`, aber denselben Ordner; eine
 * Kopie von `data/` ist ein anderer Ordner (Prüfung Runde 2, s15). Unter
 * Windows nicht: Dort ist `dev` die Seriennummer des Laufwerks, und die trägt
 * auch ein Byte-für-Byte-Klon (wie `istSelbst` in src/sync/kopplung.js).
 * @returns {string|null} "<dev>:<ino>" oder null
 */
function ordnerKennung(home, { plattform = process.platform } = {}) {
  if (plattform === 'win32' || !home) return null;
  try {
    const st = fs.statSync(home, { bigint: true });
    if (!st.ino) return null;
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** 12 Zeichen, zufällig: diese eine Laufzeit dieses einen Prozesses. */
function neueInstanz() {
  return crypto.randomBytes(9).toString('base64url');
}

function pidLebt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // lebt, gehört aber einem anderen Konto
  }
}

/**
 * Wer steckt hinter einer PID? Startzeit (ms, Wanduhr) und Befehlszeile, so
 * weit das Betriebssystem es ohne Admin sagt; sonst null bzw. einzelne
 * Felder null. Linux: /proc; macOS: /bin/ps; Windows: PowerShell (CIM),
 * sonst wenigstens der Programmname aus tasklist. Nie länger als 4 s.
 * @param {number} pid
 * @param {{plattform?:string}} [opts]
 * @returns {Promise<{start:number|null, befehl:string|null, name:string|null}|null>}
 */
async function prozessInfo(pid, { plattform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const { execFile } = require('node:child_process');
  const aufruf = (datei, args) => new Promise((resolve) => {
    try {
      execFile(datei, args, { timeout: 4000, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' }, (err, out) => {
        resolve(err ? null : String(out || ''));
      });
    } catch {
      resolve(null);
    }
  });
  if (plattform === 'linux') {
    let befehl = null;
    let start = null;
    try {
      befehl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') || null;
    } catch { /* weg oder nicht lesbar */ }
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const felder = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(felder[19]); // Feld 22: Startzeit in Ticks seit dem Hochfahren
      const btime = Number((/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8')) || [])[1]);
      // USER_HZ ist unter Linux für Programme im Benutzerraum immer 100.
      if (Number.isFinite(ticks) && Number.isFinite(btime) && btime > 0) start = (btime + ticks / 100) * 1000;
    } catch { /* bleibt null */ }
    return befehl === null && start === null ? null : { start, befehl, name: null };
  }
  if (plattform === 'darwin') {
    const out = await aufruf('/bin/ps', ['-o', 'etime=', '-o', 'command=', '-p', String(pid)]);
    const m = out && /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+?)\s*$/.exec(out.split('\n').find((z) => z.trim()) || '');
    if (!m) return null;
    const sek = (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
    return { start: Date.now() - (sek * 1000), befehl: m[5], name: null };
  }
  if (plattform === 'win32') {
    const ps = await aufruf('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object CommandLine,CreationDate | ConvertTo-Json -Compress`]);
    if (ps && ps.trim()) {
      try {
        const j = JSON.parse(ps);
        const d = j && j.CreationDate && typeof j.CreationDate === 'object' ? j.CreationDate.value : j && j.CreationDate;
        const ms = /Date\((\d+)/.exec(String(d || ''));
        const start = ms ? Number(ms[1]) : (Number.isFinite(Date.parse(d)) ? Date.parse(d) : null);
        const befehl = j && typeof j.CommandLine === 'string' && j.CommandLine ? j.CommandLine : null;
        if (befehl || start !== null) return { start, befehl, name: null };
      } catch { /* dann tasklist */ }
    }
    const liste = await aufruf('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const zeile = liste && liste.split(/\r?\n/).map((z) => z.trim()).find((z) => z.startsWith('"'));
    const teile = zeile ? zeile.split('","').map((t) => t.replace(/^"|"$/g, '')) : [];
    if (teile.length > 1 && Number(teile[1]) === pid) return { start: null, befehl: null, name: teile[0] };
    return null;
  }
  return null;
}

/** So weit darf die Sperre einer älteren Version vor bzw. nach dem Start ihres Prozesses liegen. */
const ALT_VOR_START_MS = 60 * 1000;
const ALT_NACH_START_MS = 30 * 60 * 1000;

/**
 * Ist der Prozess hinter einer alten Sperre {pid, at} wirklich das Neural OS,
 * das sie schrieb? Die Sperre kann von einem anderen Rechner stammen, und
 * die PID gehört hier einem beliebigen Programm (Prüfung von Welle 1).
 *   'neural' – Befehlszeile ".../neural-os(.js) …" und gestartet kurz vor `at`
 *   'fremd'  – anderes Programm, oder gestartet lange vor bzw. nach `at`
 *   'unklar' – das Betriebssystem sagt es nicht
 * @returns {'neural'|'fremd'|'unklar'}
 */
function aelterePruefen(info, at) {
  if (!info) return 'unklar';
  if (typeof info.name === 'string' && info.name && !/^node(\.exe)?$/i.test(info.name)) return 'fremd';
  const befehl = typeof info.befehl === 'string' && info.befehl ? info.befehl : null;
  if (befehl && !/(^|[\\/"\s])neural-os(\.js)?("|\s|$)/i.test(befehl)) return 'fremd';
  const start = Number.isFinite(info.start) ? info.start : null;
  if (start !== null && Number.isFinite(at) && (start > at + ALT_VOR_START_MS || at - start > ALT_NACH_START_MS)) return 'fremd';
  return befehl && start !== null ? 'neural' : 'unklar';
}

/**
 * GET http://127.0.0.1:<port>/api/health, höchstens 1,5 s. Nur Loopback:
 * das Ziel wird mit der Klassifizierung der Schleuse (src/net/gate.js)
 * geprüft, nie ein anderer Rechner gefragt.
 * @returns {Promise<object|null>} die Antwort oder null
 */
function gesundheit(port, { ms = GESUNDHEIT_MS, host = '127.0.0.1', probe = null } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) { resolve(null); return; }
    const { classify } = require('../net/gate');
    if (classify(host) !== 'loopback') { resolve(null); return; }
    let fertig = false;
    const ende = (wert) => { if (!fertig) { fertig = true; resolve(wert); } };
    const pfad = typeof probe === 'string' && PROBE_RE.test(probe) ? `/api/health?probe=${probe}` : '/api/health';
    const req = http.get({ host, port, path: pfad, agent: false, timeout: ms, headers: { host: `${host}:${port}` } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); ende(null); return; }
      const teile = [];
      let groesse = 0;
      res.on('data', (c) => {
        groesse += c.length;
        if (groesse > ANTWORT_MAX) { req.destroy(); ende(null); return; }
        teile.push(c);
      });
      res.on('end', () => {
        try { ende(JSON.parse(Buffer.concat(teile).toString('utf8'))); } catch { ende(null); }
      });
      res.on('error', () => ende(null));
    });
    req.on('timeout', () => { req.destroy(); ende(null); });
    req.on('error', () => ende(null));
    const hart = setTimeout(() => { req.destroy(); ende(null); }, ms + 100);
    hart.unref();
  });
}

/**
 * Den Zettel lesen, ohne zu urteilen.
 * @returns {{fehlt:true}|{zettel:object|null, mtimeMs:number}}
 */
function lesen(paths) {
  let roh;
  let mtimeMs = 0;
  try {
    roh = fs.readFileSync(paths.lock, 'utf8');
    try { mtimeMs = fs.statSync(paths.lock).mtimeMs; } catch { mtimeMs = 0; }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { fehlt: true };
    return { zettel: null, mtimeMs };
  }
  let zettel = null;
  try {
    const wert = JSON.parse(roh);
    if (wert && typeof wert === 'object' && !Array.isArray(wert)) zettel = wert;
  } catch { /* unlesbar */ }
  return { zettel, mtimeMs };
}

function zeitAus(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Wie steht es um den Laufzettel? Die Regeln der Reihe nach (Bauplan 2.4):
 *   1. fehlt -> frei
 *   2. unlesbar -> verwaist (jünger als 10 s: startet, er wird gerade geschrieben)
 *   3. anderer Rechner -> verwaist; ein anderes heim als das eigene
 *      (mitkopierter Zettel) -> verwaist, außer `ordner` ist derselbe (ein
 *      zweiter Pfad zum selben Stick: dann zählt das heim des Zettels)
 *   4./5. PID tot -> verwaist
 *   6. bereit/gesperrt und /api/health mit gleicher Instanz und dem EIGENEN
 *      heim -> läuft, auch bei anderer Bootzeit (die hängt an der Wanduhr,
 *      eine Uhrkorrektur verschiebt sie; Abweichung von der Reihenfolge in
 *      Bauplan 2.4, Prüfung Runde 1)
 *   4. anderer Start dieses Rechners (sonst) -> verwaist
 *   7. startet und jünger als 120 s -> startet
 *   8. sonst verwaist (die PID ist wiederverwendet)
 * Eine alte Sperre `{pid, at}` ist verwaist, wenn die PID tot ist oder `at`
 * vor der Bootzeit liegt; sonst läuft eine ältere Version.
 *
 * @param {{lock:string, home?:string}} paths
 * @param {object} [opts] Attrappen für Tests: gesundheit(port), pidLebt(pid),
 *   jetzt(), kennung, boot
 * @returns {Promise<{zustand:'frei'}|{zustand:'laeuft', url:string, zettel:object}
 *   |{zustand:'startet', seit:string, zettel:object|null}|{zustand:'verwaist', grund:string, zettel:object|null}
 *   |{zustand:'aeltere', pid:number, zettel:object}>}
 */
async function pruefen(paths, opts = {}) {
  const frag = opts.gesundheit || gesundheit;
  const lebt = opts.pidLebt || pidLebt;
  const jetzt = typeof opts.jetzt === 'function' ? opts.jetzt() : Date.now();
  const kennung = opts.kennung || rechner.kennung();
  const boot = Number.isFinite(opts.boot) ? opts.boot : rechner.bootZeit();

  const gelesen = lesen(paths);
  if (gelesen.fehlt) return { zustand: 'frei' };
  const z = gelesen.zettel;
  if (!z) {
    if (gelesen.mtimeMs && jetzt - gelesen.mtimeMs < FRISCH_MS && jetzt >= gelesen.mtimeMs) {
      return { zustand: 'startet', seit: new Date(gelesen.mtimeMs).toISOString(), zettel: null };
    }
    return { zustand: 'verwaist', grund: 'Laufzettel unlesbar', zettel: null };
  }

  // Die Sperre von vor Paket S: {pid, at}. Sie nennt keinen Rechner: Die PID
  // kann hier einem ganz anderen Programm gehören. `sicher` nur, wenn das
  // Betriebssystem bestätigt, dass dort ein Neural OS läuft, das kurz vor
  // `at` startete -- nur dann darf der Starter es beenden.
  if (z.v === undefined || Number(z.v) < VERSION_ZETTEL) {
    if (!lebt(z.pid)) return { zustand: 'verwaist', grund: `Prozess ${z.pid} läuft nicht mehr`, zettel: z };
    const at = zeitAus(z.at);
    if (at === null || at / 1000 < boot) return { zustand: 'verwaist', grund: 'Sperre von einem früheren Start', zettel: z };
    let info = null;
    try { info = await (opts.prozess || prozessInfo)(z.pid); } catch { info = null; }
    const urteil = aelterePruefen(info, at);
    if (urteil === 'fremd') return { zustand: 'verwaist', grund: `Prozess ${z.pid} ist kein Neural OS`, zettel: z };
    return { zustand: 'aeltere', pid: z.pid, zettel: z, sicher: urteil === 'neural' };
  }

  if (z.rechner !== kennung) return { zustand: 'verwaist', grund: 'Laufzettel von einem anderen Rechner', zettel: z };
  // Ein Zettel, der ein anderes heim nennt, wurde mitkopiert (Stick samt
  // data/ gesichert, während er lief): Er gehört dem Original, nicht uns.
  // Es sei denn, es ist derselbe Ordner unter einem zweiten Pfad: Dann läuft
  // dort UNSER Neural OS, und ein zweites auf demselben Tresor darf nie
  // entstehen (Prüfung Runde 2, s15).
  let eigenesHeim = opts.heim || (paths.home ? heimKennung(paths.home) : null);
  if (eigenesHeim && z.heim !== eigenesHeim) {
    const hier = opts.ordner !== undefined ? opts.ordner : ordnerKennung(paths.home);
    const zettelHeim = typeof z.heim === 'string' && z.heim ? z.heim : null;
    if (hier && typeof z.ordner === 'string' && z.ordner === hier && zettelHeim) {
      eigenesHeim = zettelHeim;
    } else if ((!hier || typeof z.ordner !== 'string') && zettelHeim && paths.home
      && (z.zustand === 'bereit' || z.zustand === 'gesperrt') && lebt(z.pid)
      && await derselbeOrdner(paths.home, z, frag)) {
      // Gerät und Dateinummer sagen hier nichts (Windows) oder fehlen im
      // Zettel: Der laufende Dienst hat die Probe-Datei in SEINEM
      // Datenordner gesehen, also ist es derselbe (Prüfung von Welle 1).
      eigenesHeim = zettelHeim;
    } else {
      return { zustand: 'verwaist', grund: 'Laufzettel eines anderen Datenordners (mitkopiert)', zettel: z };
    }
  }
  const gleicherBoot = rechner.gleicherStart(z.boot, boot);
  if (!lebt(z.pid)) {
    return { zustand: 'verwaist', grund: gleicherBoot ? `Prozess ${z.pid} läuft nicht mehr` : 'Laufzettel von einem früheren Start', zettel: z };
  }

  if (z.zustand === 'bereit' || z.zustand === 'gesperrt') {
    // Die Gesundheitsabfrage beweist mehr als die Bootzeit: bootZeit() hängt
    // an der Wanduhr, und eine Uhrkorrektur (NTP, leere CMOS-Batterie)
    // verschiebt sie. Antwortet unter dem Port DIESE Instanz mit DIESEM
    // heim, läuft sie -- egal, was boot sagt (Prüfung Runde 1).
    const heim = eigenesHeim || z.heim;
    const passt = (a) => a && a.instanz === z.instanz && a.heim === heim && typeof heim === 'string' && heim;
    let antwort = await frag(z.port);
    if (!passt(antwort) && gleicherBoot) {
      // Ein Server, der gerade eine PIN prüft oder kompaktiert, antwortet
      // vielleicht einmal zu spät; ein zweiter Blick kostet 0,4 s, ein
      // falsches "verwaist" einen zweiten Dienst auf demselben Tresor.
      await new Promise((r) => { setTimeout(r, opts.pauseMs !== undefined ? opts.pauseMs : GESUNDHEIT_ZWEITER_VERSUCH_MS); });
      antwort = await frag(z.port);
    }
    if (passt(antwort)) {
      const url = typeof z.url === 'string' && z.url ? z.url : `http://127.0.0.1:${z.port}/`;
      return { zustand: 'laeuft', url, zettel: z };
    }
    if (!gleicherBoot) return { zustand: 'verwaist', grund: 'Laufzettel von einem früheren Start', zettel: z };
    return { zustand: 'verwaist', grund: `keine passende Antwort auf Port ${z.port}`, zettel: z };
  }
  if (!gleicherBoot) return { zustand: 'verwaist', grund: 'Laufzettel von einem früheren Start', zettel: z };

  if (z.zustand === 'startet') {
    const seit = zeitAus(z.seit);
    if (seit !== null && jetzt - seit < STARTET_MAX_MS) return { zustand: 'startet', seit: z.seit, zettel: z };
    return { zustand: 'verwaist', grund: 'Start hängt seit über 120 s', zettel: z };
  }
  return { zustand: 'verwaist', grund: `unbekannter Zustand "${z.zustand}"`, zettel: z };
}

/** Name der Probe-Datei: `.heimprobe-<probe>` im Datenordner. */
const PROBE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PROBE_PRAEFIX = '.heimprobe-';

/**
 * Ist `home` derselbe Ordner wie der des Dienstes hinter dem Zettel? Eine
 * zufällig benannte Datei hier anlegen und fragen, ob der Dienst sie in
 * seinem Datenordner sieht (/api/health?probe=). Eine Kopie sieht sie nicht,
 * derselbe Stick unter einem zweiten Pfad schon. Ein Dienst, der die Frage
 * nicht kennt (ältere Version, Vorraum), antwortet ohne `probe`: dann nein.
 */
async function derselbeOrdner(home, z, frag) {
  const probe = crypto.randomBytes(18).toString('base64url');
  const datei = path.join(home, `${PROBE_PRAEFIX}${probe}`);
  try {
    fs.closeSync(fs.openSync(datei, 'wx', 0o600));
  } catch {
    return false;
  }
  try {
    const antwort = await frag(z.port, { probe });
    return !!(antwort && antwort.probe === true && antwort.instanz === z.instanz && antwort.heim === z.heim);
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(datei); } catch { /* weg */ }
  }
}

/** Datei exklusiv anlegen ('wx') und haltbar schreiben. */
function exklusivSchreiben(datei, zettel) {
  const daten = Buffer.from(`${JSON.stringify(zettel)}\n`, 'utf8');
  const fd = fs.openSync(datei, 'wx', 0o600);
  try {
    let geschrieben = 0;
    while (geschrieben < daten.length) geschrieben += fs.writeSync(fd, daten, geschrieben, daten.length - geschrieben);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* der Fehler oben zählt */ }
    try { fs.unlinkSync(datei); } catch { /* weg */ }
    throw err;
  }
  fs.closeSync(fd);
  fsyncOrdner(path.dirname(datei));
}

/** Zeigen zwei gelesene Zettel denselben Stand? (unlesbar gegen unlesbar zählt als gleich) */
function derselbeZettel(a, b) {
  if (!a || !b) return !a && !b;
  return a.instanz === b.instanz && a.pid === b.pid && a.zustand === b.zustand && a.seit === b.seit;
}

/** So lange hält ein Aufräumer höchstens die Aufräum-Sperre; älter ist sie liegen geblieben. */
const RAEUMEN_ALT_MS = 5000;

/**
 * Die Aufräum-Sperre `data/.lock.raeumen` ('wx'): Zwei Starts, die denselben
 * verwaisten Zettel gesehen haben, räumen nacheinander, und der zweite sieht
 * dann den frischen Zettel des ersten, statt ihn zu löschen (Prüfung Runde 1).
 */
async function mitRaeumSperre(paths, fn) {
  const sperre = `${paths.lock}.raeumen`;
  const ende = Date.now() + RAEUMEN_ALT_MS + 1000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(sperre, 'wx', 0o600));
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let alt = false;
      try { alt = Date.now() - fs.statSync(sperre).mtimeMs > RAEUMEN_ALT_MS; } catch { /* eben weg */ }
      if (alt || Date.now() > ende) {
        try { fs.unlinkSync(sperre); } catch { /* ein anderer war schneller */ }
        continue;
      }
      await new Promise((r) => { setTimeout(r, 25); });
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(sperre); } catch { /* weg */ }
  }
}

/**
 * Einen verwaisten Zettel wegräumen, samt Tresor-Sperre DERSELBEN PID --
 * aber nur, wenn dort noch genau der geprüfte Zettel liegt.
 * @returns {boolean} weggeräumt?
 */
function verwaistesWegraeumen(paths, befund) {
  const alt = befund.zettel;
  const jetzt = lesen(paths);
  if (jetzt.fehlt) return false;
  if (!derselbeZettel(jetzt.zettel, alt)) return false; // ein anderer Start hat schon einen neuen angelegt
  try { fs.unlinkSync(paths.lock); } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (!alt || !Number.isInteger(alt.pid) || alt.pid === process.pid) return true;
  const vaultLock = paths.vault ? path.join(paths.vault, '.lock') : (paths.home ? path.join(paths.home, 'vault', '.lock') : null);
  if (!vaultLock) return true;
  let halter = null;
  try { halter = JSON.parse(fs.readFileSync(vaultLock, 'utf8')); } catch { return true; }
  if (halter && halter.pid === alt.pid) {
    try { fs.unlinkSync(vaultLock); } catch { /* schon weg */ }
  }
  return true;
}

function laeuftSchon(befund) {
  if (befund.zustand === 'laeuft') {
    return new NeuralError('LAEUFT_SCHON', 'Neural OS läuft schon.', { status: 409, details: { url: befund.url } });
  }
  if (befund.zustand === 'startet') {
    return new NeuralError('STARTET_SCHON', 'Neural OS startet gerade schon.', { status: 409, details: { seit: befund.seit } });
  }
  return new NeuralError('AELTERE_VERSION', 'Neural OS läuft schon (ältere Version). Bitte dort beenden: das schwarze Fenster der alten Version schließen oder den Rechner neu starten.', {
    status: 409, details: { pid: befund.pid },
  });
}

/**
 * Den eigenen Laufzettel anlegen.
 * @param {{lock:string, home:string, vault?:string}} paths
 * @param {{instanz?:string, heim?:string, zustand?:string, port?:number|null, url?:string|null, version?:string, stopp?:string, bau?:string}} [felder]
 * @param {object} [opts] wie bei `pruefen`
 * @returns {Promise<{instanz:string, zettel:object, aktualisieren:(f:object)=>boolean, freigeben:()=>boolean}>}
 * @throws NeuralError LAEUFT_SCHON {url} | STARTET_SCHON | AELTERE_VERSION
 */
async function anlegen(paths, felder = {}, opts = {}) {
  const zettel = {
    v: VERSION_ZETTEL,
    pid: process.pid,
    rechner: rechner.kennung(),
    boot: rechner.bootZeit(),
    seit: new Date().toISOString(),
    zustand: felder.zustand || 'startet',
    port: Number.isInteger(felder.port) ? felder.port : null,
    url: typeof felder.url === 'string' ? felder.url : null,
    instanz: felder.instanz || neueInstanz(),
    heim: felder.heim || heimKennung(paths.home),
    version: felder.version || programmVersion,
  };
  const ordner = ordnerKennung(paths.home);
  if (ordner) zettel.ordner = ordner;
  // Das Beenden-Recht für `neural-os stop` (ohne PIN-Sitzung, etwa unter
  // Windows ohne SIGTERM). Steht nur hier, nie in /api/health.
  if (typeof felder.stopp === 'string' && felder.stopp) zettel.stopp = felder.stopp;
  // Welche Fassung hier läuft: Ein Starter einer anderen beendet sie und
  // startet seine (bin/neural-os.js, cmdStarter). Fehlt sie, ist es eine
  // Fassung von vor dem 01.10.2026.
  if (typeof felder.bau === 'string' && felder.bau) zettel.bau = felder.bau;

  for (let versuch = 0; versuch < 4; versuch++) {
    try {
      exklusivSchreiben(paths.lock, zettel);
      return griff(paths, zettel);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw new StorageError(`Der Laufzettel ließ sich nicht anlegen: ${err && err.message}`, { cause: String(err) });
      }
    }
    const befund = await pruefen(paths, opts);
    if (befund.zustand === 'frei') continue;
    if (befund.zustand === 'verwaist') {
      await mitRaeumSperre(paths, () => verwaistesWegraeumen(paths, befund));
      continue;
    }
    throw laeuftSchon(befund);
  }
  throw new StorageError('Der Laufzettel ließ sich nicht anlegen: ein anderer Start war jedes Mal schneller.');
}

/** Das, was der Besitzer des Zettels damit tun darf. */
function griff(paths, zettel) {
  const eigen = { ...zettel };
  return {
    get instanz() { return eigen.instanz; },
    get zettel() { return { ...eigen }; },
    /**
     * Felder ändern und haltbar schreiben. Nur, solange der Zettel noch
     * unserer ist: Hat ein anderer Start ihn übernommen, bleibt seiner.
     * @returns {boolean} geschrieben?
     */
    aktualisieren(neu = {}) {
      const jetzt = lesen(paths);
      if (jetzt.fehlt || !jetzt.zettel || jetzt.zettel.instanz !== eigen.instanz) return false;
      const zustandNeu = neu.zustand !== undefined && neu.zustand !== eigen.zustand;
      Object.assign(eigen, neu);
      if (zustandNeu) eigen.seit = new Date().toISOString();
      schreibeDauerhaft(paths.lock, `${JSON.stringify(eigen)}\n`, { modus: 0o600 });
      return true;
    },
    freigeben() {
      return freigeben(paths, eigen.instanz);
    },
  };
}

/**
 * Den Zettel löschen -- aber nur den eigenen.
 * @returns {boolean} gelöscht?
 */
function freigeben(paths, instanz) {
  const jetzt = lesen(paths);
  if (jetzt.fehlt || !jetzt.zettel || !instanz || jetzt.zettel.instanz !== instanz) return false;
  try {
    fs.unlinkSync(paths.lock);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  pruefen,
  anlegen,
  freigeben,
  lesen,
  heimKennung,
  ordnerKennung,
  neueInstanz,
  gesundheit,
  pidLebt,
  PROBE_RE,
  PROBE_PRAEFIX,
  prozessInfo,
  aelterePruefen,
  VERSION_ZETTEL,
  STARTET_MAX_MS,
};
