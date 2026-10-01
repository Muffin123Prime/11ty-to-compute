'use strict';

/**
 * Der USB-Stick über HTTP.
 *
 * Wofür es diese Routen gibt
 * --------------------------
 * Der Nutzer will seine KI auf einem Stick: "Stick rein, starten antippen,
 * läuft". Alles per Knopfdruck, nichts einrichten, nichts erklären. Die
 * Ansicht (web/views/stick.js) hat deshalb genau vier Handgriffe, und jeder
 * hat hier genau eine Tür:
 *
 *   GET  /api/stick/laufwerke   welche Sticks stecken gerade an diesem Rechner
 *   POST /api/stick/einrichten  [Neue KI] / [Mit dieser KI gekoppelt] /
 *                               [Erneuern] -- was der Stick braucht
 *   POST /api/stick/runtime     [Für Mac holen] / [Für Windows holen]
 *   POST /api/stick/sichern     "Jetzt sichern" -- auf den Stick, sonst in den
 *                               Sicherungsordner
 *   POST /api/stick/beenden     "Beenden & abziehen" -- speichern, auswerfen
 *                               wo es geht, sauber schliessen
 *
 * Die älteren Türen (`prepare`, `update`, `preview`, `verify`) bleiben:
 * dieselben Vorgänge wie auf der Kommandozeile, und die Prüfwerkzeuge
 * benutzen sie. Die Routen für ein Sprachmodell auf dem Stick
 * (`/api/stick/models*`) gibt es nicht mehr: die KI ist Claude und läuft
 * online (Entscheidung des Nutzers).
 *
 * Die Rohkopie des Datenbestands (`includeVault`) gibt es nicht mehr
 * (Bauplan 2.10.3, Befunde 11 und 13): Ein neuer Stick bekommt immer eine
 * eigene KI, und "gleiches Wissen auf zwei Sticks" ist Koppeln --
 * `ki:'gekoppelt'` koppelt den eben vorbereiteten Stick mit dieser KI.
 *
 * Drei Entscheidungen, die sich durch alle Routen ziehen
 * -----------------------------------------------------
 * 1. **Lesen schreibt nicht.** `GET /api/stick`, `/laufwerke`, `/verify`,
 *    `/plan` und `/sicherung` legen keine Datei an -- auch keine Sonde.
 * 2. **Die Absage kommt vor dem ersten Byte.** Was vorher entscheidbar ist
 *    (kein Platz, schon Daten da, ein Vorgang läuft), wird als gewöhnliche
 *    Fehlerantwort abgelehnt, bevor ein Ereignisstrom aufgeht.
 * 3. **Die langen Vorgänge sind ein Ereignisstrom.** `web/lib/api.js` bricht
 *    ein gewöhnliches POST nach 30 Sekunden ab, während der Server
 *    weiterkopiert -- der Tab sähe einen Fehler, und der Stick würde trotzdem
 *    fertig. Deshalb SSE, nach dem Muster von `src/http/api/chat.js`.
 *
 * Was hier NICHT passiert
 * -----------------------
 * Keine Route nimmt einen `sourceRoot` entgegen. Was auf den Stick kommt, ist
 * der Quelltext DIESER Instanz und das Wissen aus `paths.home` DIESER Instanz;
 * ein Pfad aus dem Netz, der bestimmt, welcher Baum kopiert wird, wäre eine
 * Einladung, die niemand braucht.
 *
 * Wer darf was
 * ------------
 * Die Selbstauskunft braucht `read`: sie sagt dasselbe über diese Installation
 * wie `/api/status`. Alles andere ist `requireOwner`: wer Laufwerke auflisten,
 * einen Pfad prüfen oder die Anwendung beenden darf, bestimmt über diesen
 * Computer, nicht nur über den Tresor -- ein geteilter Lesezugang darf das nicht.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  needMethod,
  asObject,
  requireString,
  optionalString,
  requireStringArray,
  strParam,
  boolParam,
} = require('./support');
const { NeuralError, ValidationError, LockedError, asNeuralError } = require('../../kernel/errors');

const { describePortable } = require('../../kernel/paths');
const stickMod = require('../../portable/stick');

/**
 * "Nicht da" als ganzer deutscher Satz. Die Fehlerklasse fuer "nicht
 * gefunden" baut `${what} not found` -- in der Oberflaeche stuende dann
 * "Den Stick unter E:\ … not found".
 */
function nichtDa(satz, details) {
  return new NeuralError('NOT_FOUND', satz, { status: 404, details: details || null });
}

/** Höchstlänge eines getippten Pfads. Ein Pfad, der länger ist, ist ein Versehen. */
const MAX_PATH = 1000;

/** Wie lange eine Erlaubnis für nodejs.org gilt, die "Stick vorbereiten" einholt. */
const ERLAUBNIS_MS = 30 * 60 * 1000;

/** Wurzel des laufenden Programms -- das Laufwerk, das nie ausgeworfen wird. */
const APP_ROOT = path.resolve(__dirname, '..', '..', '..');

function stickOf(rc, method = 'verify') {
  return needMethod(
    rc.ctx.stick,
    method,
    'Das Stick-Werkzeug',
    'Ohne es kann diese Instanz keinen Stick vorbereiten – und behauptet es auch nicht.',
  );
}

function publish(rc, name, payload) {
  const bus = rc.ctx.bus;
  if (bus && typeof bus.publish === 'function') bus.publish(name, payload);
}

function audit(rc, kind, data) {
  const writer = rc.ctx.audit;
  if (writer && typeof writer.write === 'function') writer.write(kind, data);
}

/** Der Stick, von dem diese Instanz läuft -- oder null. */
function eigenerStickPfad(rc) {
  const portable = describePortable(rc.ctx.portable);
  return portable && portable.root ? portable.root : null;
}

/** Der getippte Pfad, aus der Abfrage. */
function pathParam(rc) {
  const value = strParam(rc.query, 'path', MAX_PATH);
  if (!value) {
    throw new ValidationError(
      'Es fehlt der Ort des Sticks (z. B. E:\\ oder /Volumes/STICK). Der Browser kennt keine Dateipfade, '
      + 'er muss gewählt oder getippt werden.',
    );
  }
  return value;
}

function istOrdner(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** `child` liegt in `parent` (oder ist es). */
function liegtIn(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Laufzeiten ohne die absoluten Dateipfade.
 *
 * Die Selbstauskunft hängt an `read`, also an einem möglicherweise geteilten
 * Zugang. Welche Betriebssysteme der Stick kann, ist die Auskunft, um die es
 * geht; wo genau die Binärdatei im Dateisystem liegt, ist keine.
 */
function runtimeSummary(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({
    platform: r.platform,
    bytes: r.bytes ?? null,
    version: r.version || null,
    isLocal: !!r.isLocal,
    executableBit: r.executableBit === undefined ? null : !!r.executableBit,
  }));
}

/* ------------------------------ [Neue KI] oder [Mit dieser KI gekoppelt] */

/** `ki` aus dem Körper: 'neu' (Vorgabe) oder 'gekoppelt'. */
function kiWahl(body) {
  if (body.includeVault === true) throw new ValidationError(stickMod.SATZ.ROHKOPIE);
  const ki = body.ki === undefined || body.ki === null ? 'neu' : body.ki;
  if (ki !== 'neu' && ki !== 'gekoppelt') {
    throw new ValidationError('"ki" muss "neu" oder "gekoppelt" sein.');
  }
  return ki;
}

/**
 * [Mit dieser KI gekoppelt], Bauplan 2.10.3: NACH dem Vorbereiten bekommt der
 * neue Stick -- hat diese KI eine PIN -- einen eigenen Tresor mit der
 * eingegebenen PIN, und dann koppelt `kopplung.koppelnNeu` ihn mit dieser KI.
 * Gekoppelte Sticks sind entweder beide geschützt oder beide nicht (1.6).
 *
 * Was hier VOR dem Strom entschieden wird: Gibt es das Koppeln überhaupt
 * (sonst 501), und fehlt die PIN, obwohl diese KI eine hat (400). Zurück
 * kommt der Schritt, den die Route nach dem Vorbereiten ausführt.
 *
 * @returns {null|((ergebnis:{basis:string, dataDir:string})=>Promise<object|null>)}
 */
function koppelnVorbereiten(rc, ki, pin) {
  if (ki !== 'gekoppelt') return null;
  const kopplung = rc.ctx.kopplung;
  if (!kopplung || typeof kopplung.koppelnNeu !== 'function') {
    throw new NeuralError('KOPPELN_FEHLT', 'Koppeln gibt es noch nicht.', { status: 501 });
  }
  if (pin !== undefined && pin !== null && typeof pin !== 'string') throw new ValidationError('"pin" muss Text sein.');
  // Gilt diese KI als Kopie einer anderen, scheitert das Koppeln -- erst NACH
  // dem Vorbereiten, und der neue Stick stuende ungekoppelt da. Deshalb vorher
  // (Pruefung W2, Befund 3).
  if (typeof kopplung.status === 'function') {
    const stand = kopplung.status();
    if (stand && stand.selbst && stand.selbst.zwilling) {
      throw new NeuralError('KOPPLUNG_ZWILLING', 'Zwei Sticks tragen dieselbe KI.', { status: 409 });
    }
  }
  const vc = rc.ctx.vaultCrypto;
  const mitPin = !!(vc && vc.enabled);
  if (mitPin) {
    if (typeof pin !== 'string' || !pin) throw new ValidationError('PIN für den neuen Stick');
    if (vc.state === 'locked') throw new LockedError('Der Tresor ist gesperrt.');
  }
  return async (ergebnis) => {
    if (mitPin) {
      const { createVaultCrypto } = require('../../store/vaultcrypto');
      const neu = createVaultCrypto({ paths: { secrets: path.join(ergebnis.dataDir, 'secrets.json') }, config: {}, geraet: false });
      try {
        await neu.initialise(pin);
      } finally {
        neu.lock();
      }
      stickMod.schutzEinschalten(ergebnis.dataDir);
    }
    const r = await kopplung.koppelnNeu({ root: ergebnis.basis, pin: mitPin ? pin : undefined });
    return r && r.partner ? r.partner : null;
  };
}

/* ------------------------------------------------- nodejs.org, einmal */

/**
 * Darf "Stick vorbereiten" gerade nodejs.org erreichen -- ohne zu fragen?
 *
 * Dieselbe Entscheidung, die die Netzschleuse beim Herunterladen trifft, nur
 * ohne Namensauflösung und ohne Verbindung (`record: false`, damit die Frage
 * nicht im Netzprotokoll als Zugriff auftaucht). Ist sie "nein", fragt der
 * Knopf einmal um Erlaubnis.
 */
function downloadErlaubt(rc) {
  const gate = rc.ctx.gate;
  if (!gate || typeof gate.check !== 'function') {
    return { erlaubt: false, grund: 'Ohne Netzschleuse holt diese Instanz nichts aus dem Internet.' };
  }
  try {
    const d = gate.check({
      host: stickMod.DIST_HOST,
      port: 443,
      scope: stickMod.RUNTIME_SCOPE,
      purpose: 'stick.runtime.plan',
      maxLevel: 'online',
      allowedHosts: [stickMod.DIST_HOST],
      record: false,
    });
    return { erlaubt: !!d.allowed, grund: d.reason || null };
  } catch (err) {
    return { erlaubt: false, grund: asNeuralError(err).message };
  }
}

/**
 * Die eine Erlaubnis, um die der Knopf gefragt hat -- so eng wie möglich.
 *
 * Nur nodejs.org, nur der Bereich der Laufzeiten, höchstens eine halbe Stunde
 * und nur so viele Abrufe, wie die fehlenden Laufzeiten brauchen (je zwei:
 * Prüfsummenliste und Archiv). Nach dem Vorgang wird sie zurückgezogen; die
 * Schleuse behält sie als zurückgezogen im Protokoll.
 */
function erlaubnisErteilen(rc, anzahl) {
  const gate = rc.ctx.gate;
  if (!gate || typeof gate.addGrant !== 'function') return null;
  const grant = gate.addGrant({
    scope: stickMod.RUNTIME_SCOPE,
    level: 'online',
    hosts: [stickMod.DIST_HOST],
    reason: 'Stick vorbereiten: Laufzeiten für andere Betriebssysteme (einmalig erlaubt)',
    expiresAt: new Date(Date.now() + ERLAUBNIS_MS).toISOString(),
    maxUses: Math.max(2, anzahl * 2 + 2),
  });
  return grant && grant.id ? grant.id : null;
}

function erlaubnisZurueckziehen(rc, id) {
  if (!id) return;
  const gate = rc.ctx.gate;
  try {
    if (gate && typeof gate.revokeGrant === 'function') gate.revokeGrant(id);
  } catch (err) {
    if (rc.log && rc.log.warn) rc.log.warn(`Freigabe ${id} ließ sich nicht zurückziehen: ${err && err.message}`);
  }
}

function andereSysteme(rc) {
  const lokal = stickMod.LOCAL_PLATFORM;
  const plattformen = stickMod.ZIEL_PLATTFORMEN.filter((p) => p !== lokal);
  return {
    plattformen,
    namen: plattformen.map(stickMod.plattformName),
    ...downloadErlaubt(rc),
  };
}

/* ------------------------------------------------------- Ereignisstrom */

/**
 * Den Ereignisstrom öffnen -- oder erklären, warum nicht.
 *
 * `src/http/server.js` begrenzt die gleichzeitig offenen Ströme, und
 * `/api/events` belegt bereits einen je offenem Tab. Die nackte Meldung lässt
 * offen, was mit dem Stick ist. Genau das steht hier dazu.
 */
function openStreamOrExplain(rc, what) {
  try {
    return rc.openStream({});
  } catch (err) {
    const e = asNeuralError(err);
    if (e.code !== 'TOO_MANY_STREAMS') throw e;
    const offen = (e.details && e.details.open) || null;
    throw new NeuralError(
      'TOO_MANY_STREAMS',
      `${what} wurde NICHT gestartet: dieser Server hält schon so viele Ereignisverbindungen offen, `
      + `wie er darf${offen ? ` (${offen})` : ''}. Jeder offene Neural-OS-Tab belegt eine davon. `
      + 'Schließe die anderen Tabs und versuche es erneut – auf dem Stick wurde nichts verändert.',
      { status: 503, details: e.details || null },
    );
  }
}

/**
 * Ein langer Vorgang als Ereignisstrom.
 *
 *   1. Die Vorschau läuft (dieselbe Formel wie der Vorgang) und liefert die
 *      Hindernisse als fertige Sätze samt Statuscode.
 *   2. Gibt es eines, endet die Anfrage hier -- als gewöhnliche
 *      Fehlerantwort, nicht als Strom, der sich sofort entschuldigt.
 *   3. Erst dann öffnet sich der Strom, und erst dann fängt die Arbeit an.
 *
 * Was danach noch schiefgehen kann (der Stick wird abgezogen, er läuft voll),
 * kommt als `fehler`-Ereignis, weil es vorher niemand wissen konnte.
 */
async function streamed(rc, { what, root, previewOpts, vorschauVon, run, danach }) {
  // Was danach aufzuraeumen ist (die Freigabe fuer nodejs.org), gilt auch fuer
  // jede Absage vor dem Strom: ein Hindernis in der Vorschau (Stick voll,
  // schon eine KI darauf), kein freier Platz fuer einen Strom. Sonst bliebe
  // die Freigabe 30 Minuten offen, und der naechste Stick laedt ohne Frage
  // (Pruefung W2, Befund 2).
  const aufraeumen = () => {
    if (typeof danach !== 'function') return;
    try { danach(); } catch { /* Aufräumen darf die Antwort nicht verhindern */ }
  };
  let vorschau;
  let stream;
  try {
    vorschau = typeof vorschauVon === 'function'
      ? vorschauVon()
      : stickOf(rc, 'preview').preview(root, previewOpts);
    if (vorschau.blockers.length) {
      const erste = vorschau.blockers[0];
      throw new NeuralError(erste.code, erste.message, {
        status: erste.status || 409,
        details: { blockers: vorschau.blockers, root: vorschau.root },
      });
    }
    stream = openStreamOrExplain(rc, what);
  } catch (err) {
    aufraeumen();
    throw err;
  }
  // Ein geschlossener Tab darf keine lange Kopie zu Ende laufen lassen.
  const controller = new AbortController();
  stream.onClose(() => controller.abort());

  stream.send('start', { what, root: vorschau.root, vorschau });

  try {
    const ergebnis = await run({
      signal: controller.signal,
      onProgress: (p) => {
        if (!stream.closed && p) stream.send('fortschritt', p);
      },
    });
    if (!stream.closed) stream.send('fertig', { what, root: vorschau.root, ...ergebnis });
  } catch (err) {
    const e = asNeuralError(err);
    if (!stream.closed) {
      stream.send('fehler', {
        what,
        root: vorschau.root,
        error: { code: e.code, status: e.status, message: e.message, details: e.details || null },
      });
    }
    if (e.status >= 500 && e.code === 'INTERNAL_ERROR') rc.log.error(`Stick ${what}: ${e.stack || e.message}`);
  } finally {
    aufraeumen();
    stream.close();
  }
  return undefined; // der Strom hat die Antwort übernommen
}

/* ------------------------------------------------------------ Sichern */

/**
 * Wohin "Jetzt sichern" schreibt -- an EINER Stelle entschieden.
 *
 * Der Stick, wenn einer gewählt ist und steckt; sonst der Stick, von dem diese
 * Instanz läuft; sonst der Sicherungsordner dieser Installation. Auf dem Stick
 * in einen eigenen Ordner neben `data/`, nicht hinein: eine Sicherung im
 * gesicherten Ordner würde bei jeder weiteren mitgesichert.
 *
 * @returns {{art:'stick'|'ordner', stick:string|null, pfad:string, gewaehltFehlt:boolean}}
 */
function sicherungsZiel(rc, gewaehlt) {
  const paths = rc.ctx.paths || {};
  const p = typeof gewaehlt === 'string' ? gewaehlt.trim() : '';
  let gewaehltFehlt = false;
  if (p) {
    const root = path.resolve(p);
    if (istOrdner(root)) {
      return { art: 'stick', stick: root, pfad: path.join(root, stickMod.LAYOUT.backups), gewaehltFehlt };
    }
    gewaehltFehlt = true;
  }
  const eigen = eigenerStickPfad(rc);
  if (eigen) return { art: 'stick', stick: eigen, pfad: path.join(eigen, stickMod.LAYOUT.backups), gewaehltFehlt };
  if (!paths.exports) {
    throw new NeuralError('SUBSYSTEM_UNAVAILABLE', 'Diese Instanz kennt keinen Sicherungsordner.', { status: 503 });
  }
  return { art: 'ordner', stick: null, pfad: paths.exports, gewaehltFehlt };
}

/**
 * Die jüngste Sicherung an den bekannten Orten -- aus `manifest.json`, nicht
 * geraten. Dieselbe Lesart wie `GET /api/backup/list`: ein Ordner ohne
 * Manifest ist irgendein Ordner, keine Sicherung.
 */
function letzteSicherung(orte) {
  let beste = null;
  let anzahl = 0;
  for (const ort of orte) {
    let namen = [];
    try {
      namen = fs.readdirSync(ort.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { continue; }
    for (const name of namen) {
      const dir = path.join(ort.dir, name);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
      if (!manifest || manifest.kind !== 'neural-os-manifest') continue;
      anzahl++;
      const at = manifest.at || null;
      if (!beste || String(at || '') > String(beste.at || '')) {
        const counts = manifest.counts || {};
        beste = {
          at,
          dir,
          art: ort.art,
          sealed: manifest.sealed === true,
          records: Number.isFinite(counts.records) ? counts.records : null,
        };
      }
    }
  }
  return { letzte: beste, anzahl };
}

function sicherungsOrte(rc, ziel) {
  const paths = rc.ctx.paths || {};
  const orte = [];
  const merken = (dir, art) => {
    if (!dir || orte.some((o) => path.resolve(o.dir) === path.resolve(dir))) return;
    orte.push({ dir, art });
  };
  merken(ziel.pfad, ziel.art);
  const eigen = eigenerStickPfad(rc);
  if (eigen) merken(path.join(eigen, stickMod.LAYOUT.backups), 'stick');
  if (paths.exports) merken(paths.exports, eigen ? 'stick' : 'ordner');
  return orte;
}

/* ------------------------------------------------------------ Beenden */

/**
 * Die Anwendung sauber beenden -- NACHDEM die Antwort unterwegs ist.
 *
 * Reihenfolge der Wege:
 *   1. `ctx.beenden`, falls der Einbettende einen Weg vorgibt (Tests, Werkzeuge).
 *   2. Die Kommandozeile (`neural-os start`) hängt ihr sauberes Ende an
 *      SIGTERM: app.close(), Sperrdatei weg, exit(0). `process.emit` statt
 *      `process.kill`: unter Windows beendet ein kill(SIGTERM) den Prozess
 *      sofort, ohne einen einzigen Listener -- dann bliebe die Sperrdatei liegen.
 *   3. Sonst wenigstens alles schließen, was offen ist.
 */
function herunterfahren(rc) {
  const ctx = rc.ctx;
  try {
    if (typeof ctx.beenden === 'function') return Promise.resolve(ctx.beenden());
    if (process.listenerCount('SIGTERM') > 0) {
      process.emit('SIGTERM', 'SIGTERM');
      return Promise.resolve();
    }
    if (typeof ctx.close === 'function') return Promise.resolve(ctx.close());
  } catch (err) {
    if (rc.log && rc.log.error) rc.log.error(`Beenden gescheitert: ${err && err.message}`);
  }
  return Promise.resolve();
}

function register(router) {
  /* ------------------------------------------------------- Selbstauskunft */

  /**
   * Läuft DIESE Instanz von einem Stick? Von wo? Wie viel Platz ist da? Und
   * kommt "Stick vorbereiten" gerade ohne Rückfrage an nodejs.org?
   */
  router.get('/api/stick', async (rc) => {
    rc.requireCapability('read');
    const stick = stickOf(rc);
    const portable = describePortable(rc.ctx.portable);

    const antwort = {
      portabel: !!portable,
      von: portable,
      datenOrdner: (rc.ctx.paths && rc.ctx.paths.home) || null,
      dieserRechner: stick.LOCAL_PLATFORM,
      dieserRechnerName: stickMod.plattformName(stick.LOCAL_PLATFORM),
      bekanntePlattformen: Object.keys(stick.PLATFORMS),
      andereSysteme: andereSysteme(rc),
      laufzeiten: [],
      freieBytes: null,
      dateisystem: null,
      pruefung: null,
      aufbau: null,
      wurzel: null,
      ki: null,
      startklar: null,
      hinweise: [],
      /** Hat diese KI eine PIN? Dann braucht [Mit dieser KI gekoppelt] das Feld "PIN für den neuen Stick". */
      pinNoetig: !!(rc.ctx.vaultCrypto && rc.ctx.vaultCrypto.enabled),
      koppelnMoeglich: !!(rc.ctx.kopplung && typeof rc.ctx.kopplung.koppelnNeu === 'function'),
    };

    if (portable) {
      const pruefung = await stick.verify(portable.root);
      antwort.laufzeiten = runtimeSummary(pruefung.layout && pruefung.layout.runtimes);
      antwort.freieBytes = pruefung.freeBytes;
      antwort.dateisystem = pruefung.filesystem || null;
      antwort.pruefung = { ok: pruefung.ok, problems: pruefung.problems };
      antwort.aufbau = pruefung.aufbau || null;
      antwort.wurzel = pruefung.root || null;
      antwort.ki = pruefung.ki || null;
      antwort.startklar = pruefung.startklar || null;
      antwort.hinweise = pruefung.hinweise || [];
    }
    return antwort;
  });

  /* ------------------------------------------------ welche Sticks stecken */

  /**
   * Die angeschlossenen Wechsel-Laufwerke dieses Rechners. Schreibt nichts.
   * Eine leere Liste ist eine Antwort, kein Fehler -- die Ansicht sagt dann
   * ehrlich, dass keiner gefunden wurde.
   */
  router.get('/api/stick/laufwerke', async (rc) => {
    rc.requireOwner('Die Laufwerke dieses Rechners aufzulisten');
    const finden = typeof rc.ctx.findeLaufwerke === 'function' ? rc.ctx.findeLaufwerke : stickMod.findeLaufwerke;
    return finden({ eigenerStick: eigenerStickPfad(rc) });
  });

  /* -------------------------------------------- einen Stick prüfen/ansehen */

  router.get('/api/stick/verify', async (rc) => {
    rc.requireOwner('Einen Stick zu prüfen');
    const stick = stickOf(rc);
    return stick.verify(pathParam(rc));
  });

  router.get('/api/stick/preview', (rc) => {
    rc.requireOwner('Einen Stick anzusehen');
    const stick = stickOf(rc, 'preview');
    const action = strParam(rc.query, 'action', 20) || 'prepare';
    if (!['prepare', 'update', 'runtime'].includes(action)) {
      throw new ValidationError(`"${action}" ist kein bekannter Vorgang. Möglich sind: prepare, update, runtime.`);
    }
    const runtimes = strParam(rc.query, 'runtimes', 200);
    if (boolParam(rc.query, 'vault', false)) throw new ValidationError(stickMod.SATZ.ROHKOPIE);
    return stick.preview(pathParam(rc), {
      action,
      includeRuntimes: runtimes ? runtimes.split(',').map((s) => s.trim()).filter(Boolean) : true,
      platform: strParam(rc.query, 'platform', 40) || undefined,
    });
  });

  /**
   * Was "Stick vorbereiten" an diesem Ort tun würde -- und ob es dafür einmal
   * ins Internet müsste. Die Ansicht fragt damit VOR dem Klick, ob sie um
   * Erlaubnis bitten muss. Schreibt nichts.
   */
  router.get('/api/stick/plan', (rc) => {
    rc.requireOwner('Einen Stick anzusehen');
    const stick = stickOf(rc, 'einrichtenPlan');
    const plan = stick.einrichtenPlan(pathParam(rc), { eigenerStick: eigenerStickPfad(rc) });
    const netz = downloadErlaubt(rc);
    return {
      ...plan,
      andereNamen: plan.andere.map(stickMod.plattformName),
      ausDemNetzNamen: (plan.ausDemNetz || plan.andere).map(stickMod.plattformName),
      dieserRechner: stick.LOCAL_PLATFORM,
      dieserRechnerName: stickMod.plattformName(stick.LOCAL_PLATFORM),
      // Nur was nicht schon auf dem eigenen Stick oder im Zwischenspeicher liegt, muss ins Netz.
      download: { noetig: (plan.ausDemNetz || plan.andere).length > 0, erlaubt: netz.erlaubt, grund: netz.grund },
      /** Fuer [Mit dieser KI gekoppelt]: Feld "PIN für den neuen Stick" zeigen? Knopf ueberhaupt? */
      pinNoetig: !!(rc.ctx.vaultCrypto && rc.ctx.vaultCrypto.enabled),
      koppelnMoeglich: !!(rc.ctx.kopplung && typeof rc.ctx.kopplung.koppelnNeu === 'function'),
      /** "Leerer Stick: E:\\ · 14,2 GB frei" -- kein Marker, keine KI. */
      leer: !plan.istStick && plan.wissenAufStick === 0,
      frei: stick.freeBytes(plan.root),
    };
  });

  /* ----------------------------------------------- "Stick vorbereiten" */

  /**
   * Ein Klick, alles, was der Stick braucht (siehe `einrichten()` in
   * src/portable/stick.js): Programm, die Laufzeit dieses Rechners, auf
   * Wunsch die für Windows und Mac, und das Wissen dieses Rechners, wenn auf
   * dem Stick noch keins liegt.
   *
   * Körper: `{ path, ki?: 'neu'|'gekoppelt' (Vorgabe 'neu'), pin?, name?,
   *            andereSysteme?: boolean|'ohneNetz' (Vorgabe true), erlaubnis?: boolean }`.
   * `ki:'neu'` ist [Neue KI], `ki:'gekoppelt'` ist [Mit dieser KI gekoppelt]:
   * nach dem Vorbereiten wird der neue Stick mit dieser KI gekoppelt (`pin`
   * ist die PIN des neuen Sticks, Pflicht, wenn diese KI eine hat). Beide
   * gelten nur einem leeren Stick: Wohnt dort schon eine KI, ist es ein 409
   * (KI_VORHANDEN, "Auf diesem Stick wohnt schon eine KI."), und nichts wird
   * überschrieben; Koppeln geht dann über /api/kopplung/koppeln. Ohne `ki`
   * ist es [Erneuern] (Programm erneuern, KI bleibt) bzw. das Nachlegen von
   * Laufzeiten auf dem eigenen Stick.
   * `erlaubnis: true` heißt: der Mensch hat eben zugestimmt, dass nodejs.org
   * einmal erreicht werden darf. Nur dann wird eine Freigabe angelegt -- eng,
   * befristet, und nach dem Vorgang zurückgezogen.
   */
  router.post('/api/stick/einrichten', async (rc) => {
    rc.requireOwner('Einen Stick vorzubereiten');
    const stick = stickOf(rc, 'einrichten');
    const body = asObject(await rc.body());
    const root = path.resolve(requireString(body.path, 'path', { max: MAX_PATH }));
    const ki = kiWahl(body);
    const name = optionalString(body.name, 'name', { max: 60 });
    const mitAnderen = body.andereSysteme !== false;
    const eigenerStick = eigenerStickPfad(rc);
    // `andereSysteme: 'ohneNetz'` ist die zweite Antwort auf die Frage nach
    // dem Internet: die anderen Systeme nur, soweit sie ohne Netz kommen (vom
    // eigenen Stick, aus dem Zwischenspeicher) -- nie eine Freigabe.
    const nurOhneNetz = body.andereSysteme === 'ohneNetz';
    const erster = stick.einrichtenPlan(root, { eigenerStick, andereSysteme: mitAnderen });
    const plattformen = nurOhneNetz
      ? erster.andere.filter((p) => !(erster.ausDemNetz || erster.andere).includes(p))
      : undefined;
    const plan = plattformen ? stick.einrichtenPlan(root, { eigenerStick, andereSysteme: mitAnderen, plattformen }) : erster;

    if (!plan.eigener && !istOrdner(path.dirname(root)) && !istOrdner(root)) {
      throw nichtDa(`Den Ort ${root} gibt es nicht. Steckt der Stick noch?`, { root });
    }
    // [Neue KI] und [Mit dieser KI gekoppelt] gelten nur einem leeren Stick
    // (1.6): Wohnt dort schon eine KI, kommt der Satz, und nichts wird
    // ueberschrieben. Ohne `ki` ist es [Erneuern] bzw. das Nachlegen von
    // Laufzeiten auf dem eigenen Stick -- die KI bleibt, wie sie ist.
    if (body.ki !== undefined && body.ki !== null && plan.fall !== 'neu') {
      throw new stickMod.KiVorhandenError({ root, fall: plan.fall });
    }
    const koppeln = koppelnVorbereiten(rc, ki, body.pin);

    // Was vorher entscheidbar ist, wird vorher entschieden -- mit derselben
    // Vorschau, mit der auch die einzelnen Vorgänge rechnen.
    const vorschauVon = () => {
      if (plan.fall === 'neu') {
        return stick.preview(root, { action: 'prepare', includeRuntimes: plan.andere });
      }
      if (plan.fall === 'erneuern') return stick.preview(root, { action: 'update' });
      const laeuft = stickMod.runningOn(root);
      return {
        root,
        blockers: laeuft ? [{ code: 'STICK_BUSY', status: 409, message: stickMod.busyError(root, laeuft).message }] : [],
      };
    };

    let grantId = null;
    const ausDemNetz = plan.ausDemNetz || plan.andere;
    if (mitAnderen && !nurOhneNetz && body.erlaubnis === true && ausDemNetz.length && !downloadErlaubt(rc).erlaubt) {
      grantId = erlaubnisErteilen(rc, ausDemNetz.length);
    }

    audit(rc, 'stick.einrichten', { root, fall: plan.fall, ki, andere: plan.andere, erlaubnis: !!grantId });
    return streamed(rc, {
      what: 'Stick vorbereiten',
      root,
      // Die Absage vor dem Strom zieht die Freigabe zurück (streamed, danach).
      vorschauVon,
      run: async ({ signal, onProgress }) => {
        const r = await stick.einrichten(root, {
          eigenerStick,
          andereSysteme: mitAnderen,
          ...(plattformen ? { plattformen } : {}),
          name: name || undefined,
          signal,
          onProgress,
        });
        // [Mit dieser KI gekoppelt]: erst jetzt, mit der neuen Kennung auf dem Stick.
        const partner = koppeln && r.fall === 'neu' ? await koppeln(r) : null;
        publish(rc, 'stick.eingerichtet', { root, fall: r.fall, ki: r.ki || null, gekoppelt: !!partner, laufzeiten: r.laufzeiten });
        return {
          ...r,
          gekoppelt: partner,
          laufzeitenNamen: r.laufzeiten.map(stickMod.plattformName),
          fehlend: r.fehlend.map((f) => ({ ...f, name: stickMod.plattformName(f.platform) })),
        };
      },
      danach: () => erlaubnisZurueckziehen(rc, grantId),
    });
  });

  /* ------------------------------------------------ die einzelnen Vorgänge */

  /**
   * Körper: `{ path, ki?: 'neu'|'gekoppelt', pin?, name?, runtimes?: string[] }`.
   * Ohne `runtimes` kommen die Laufzeit dieses Rechners, Windows und beide
   * Macs mit (Bauplan 2.10.1); `runtimes` nennt stattdessen die zusätzlichen.
   * `includeVault` (die Rohkopie) gibt es nicht mehr: 400.
   */
  router.post('/api/stick/prepare', async (rc) => {
    rc.requireOwner('Einen Stick vorzubereiten');
    const stick = stickOf(rc, 'prepare');
    const body = asObject(await rc.body());
    const root = requireString(body.path, 'path', { max: MAX_PATH });
    const ki = kiWahl(body);
    const name = optionalString(body.name, 'name', { max: 60 });
    const extra = body.runtimes === undefined
      ? []
      : requireStringArray(body.runtimes, 'runtimes', { maxItems: 8, max: 40 });
    const includeRuntimes = extra.length ? extra : true;
    const koppeln = koppelnVorbereiten(rc, ki, body.pin);

    return streamed(rc, {
      what: 'Stick vorbereiten',
      root,
      previewOpts: { action: 'prepare', includeRuntimes },
      run: async ({ signal, onProgress }) => {
        const r = await stick.prepare(root, { ki, name: name || undefined, includeRuntimes, signal, onProgress });
        const partner = koppeln ? await koppeln(r) : null;
        publish(rc, 'stick.eingerichtet', { root: r.root, fall: 'neu', ki: r.ki || null, gekoppelt: !!partner, laufzeiten: r.runtimes.map((x) => x.platform) });
        return { ...r, gekoppelt: partner };
      },
    });
  });

  router.post('/api/stick/update', async (rc) => {
    rc.requireOwner('Einen Stick zu aktualisieren');
    const stick = stickOf(rc, 'update');
    const body = asObject(await rc.body());
    const root = requireString(body.path, 'path', { max: MAX_PATH });

    return streamed(rc, {
      what: 'Stick aktualisieren',
      root,
      previewOpts: { action: 'update' },
      run: ({ signal, onProgress }) => stick.update(root, { signal, onProgress }),
    });
  });

  /**
   * [Für Mac holen] bzw. [Für Windows holen] (Bauplan 2.10.1).
   * Körper: `{ path, platforms?: string[], platform?: string, erlaubnis?: boolean }`.
   * `platforms: ['darwin-arm64','darwin-x64']` holt beide Macs; `platform`
   * ist die alte Einzelform. `erlaubnis` wie bei /einrichten. Was nicht
   * kommt, steht in `fehlend` mit dem Satz "Ohne Internet geht das nicht."
   */
  router.post('/api/stick/runtime', async (rc) => {
    rc.requireOwner('Eine Laufzeit auf den Stick zu legen');
    const stick = stickOf(rc, 'addRuntime');
    const body = asObject(await rc.body());
    const root = requireString(body.path, 'path', { max: MAX_PATH });
    const liste = body.platforms !== undefined
      ? requireStringArray(body.platforms, 'platforms', { maxItems: 8, max: 40 })
      : [requireString(body.platform, 'platform', { max: 40 })];
    const platforms = [...new Set(liste)];
    if (!platforms.length) throw new ValidationError('"platforms" nennt keine Plattform.');
    for (const p of platforms) {
      if (!stick.PLATFORMS[p]) {
        throw new ValidationError(`"${p}" ist keine bekannte Plattform. Möglich sind: ${Object.keys(stick.PLATFORMS).join(', ')}.`);
      }
    }
    const fremde = platforms.filter((p) => p !== stick.LOCAL_PLATFORM);
    let grantId = null;
    if (body.erlaubnis === true && fremde.length && !downloadErlaubt(rc).erlaubt) {
      grantId = erlaubnisErteilen(rc, fremde.length);
    }
    const namen = platforms.map(stickMod.plattformName).join(', ');

    return streamed(rc, {
      what: `Laufzeit ${namen} holen`,
      root,
      vorschauVon: () => stick.preview(root, { action: 'runtime', platform: platforms[0] }),
      run: async ({ signal, onProgress }) => {
        const geholt = [];
        const fehlend = [];
        for (const platform of platforms) {
          try {
            const r = await stick.addRuntime(root, platform, { signal, onProgress });
            geholt.push({ platform, name: stickMod.plattformName(platform), bytes: r.bytes || null, version: r.version || null, source: r.source || null });
          } catch (err) {
            const e = asNeuralError(err);
            if (e.code === 'ABORTED') throw err;
            const netz = e.code === 'NETWORK_BLOCKED' || e.code === 'VALIDATION_FAILED' || e.code === 'INTERNAL_ERROR' || /^NETWORK/.test(e.code);
            fehlend.push({ platform, name: stickMod.plattformName(platform), grund: e.message, code: e.code, satz: netz ? stickMod.SATZ.OHNE_INTERNET : null });
          }
        }
        const laufzeiten = stick.detectPlatforms(root).map((p) => p.platform);
        publish(rc, 'stick.eingerichtet', { root, fall: 'laufzeit', laufzeiten });
        return { geholt, fehlend, laufzeiten, laufzeitenNamen: laufzeiten.map(stickMod.plattformName) };
      },
      danach: () => erlaubnisZurueckziehen(rc, grantId),
    });
  });

  /* ------------------------------------------------------ "Jetzt sichern" */

  /**
   * Wohin gesichert würde und wann zuletzt gesichert wurde. Schreibt nichts.
   * `path` ist der Ort des Sticks aus dem Feld der Ansicht (freiwillig).
   */
  router.get('/api/stick/sicherung', (rc) => {
    rc.requireOwner('Die Sicherungen anzusehen');
    const ziel = sicherungsZiel(rc, strParam(rc.query, 'path', MAX_PATH));
    const { letzte, anzahl } = letzteSicherung(sicherungsOrte(rc, ziel));
    return { ziel, letzte, anzahl };
  });

  /**
   * Eine vollständige Sicherung (JSON zum Zurückspielen und Markdown zum
   * Lesen, mit Anhängen) in einen neuen Ordner mit Zeitstempel am Ziel. Eine
   * ältere Sicherung wird dabei nie ersetzt.
   */
  router.post('/api/stick/sichern', async (rc) => {
    rc.requireOwner('Eine Sicherung');
    const backup = needMethod(rc.ctx.backup, 'exportAll', 'Die Sicherung');
    const body = asObject(await rc.body());
    const gewaehlt = optionalString(body.path, 'path', { max: MAX_PATH });
    const ziel = sicherungsZiel(rc, gewaehlt);
    if (ziel.gewaehltFehlt) {
      throw nichtDa(`Den Stick unter ${path.resolve(gewaehlt)} finde ich nicht. Steckt er noch?`, { path: path.resolve(gewaehlt) });
    }
    if (rc.ctx.store && typeof rc.ctx.store.flush === 'function') await rc.ctx.store.flush();
    const r = await backup.exportAll({ parent: ziel.pfad, format: 'both', includeFiles: true });
    audit(rc, 'backup.export', { dir: r.dir, records: r.records, format: 'both', sealed: r.sealed, via: 'stick' });
    publish(rc, 'backup.geschrieben', { dir: r.dir, at: new Date().toISOString() });
    return {
      dir: r.dir,
      records: r.records,
      files: r.files,
      bytes: r.bytes,
      sealed: r.sealed === true,
      at: new Date().toISOString(),
      ziel,
    };
  });

  /* ------------------------------------------------ "Beenden & abziehen" */

  /**
   * Speichern, auswerfen (wo es geht), sauber schließen.
   *
   * Die Reihenfolge ist die Zusage:
   *   1. Läuft irgendwo noch ein Kopiervorgang, passiert NICHTS -- ein Stick,
   *      der mitten im Schreiben abgezogen wird, ist ein halber Stick.
   *   2. Der Tresor wird auf die Platte gezwungen (fsync), bevor irgendwer
   *      "abziehen" sagt.
   *   3. Läuft Neural OS NICHT vom Stick, wird der Stick ausgeworfen, soweit
   *      das ohne Administrator geht. Läuft es vom Stick, geht das nicht --
   *      das Programm selbst liegt darauf; abgezogen wird dann, sobald es zu ist.
   *   4. Die Antwort geht raus, DANN wird geschlossen. Ob der Server wirklich
   *      weg ist, prüft die Ansicht selbst, bevor sie "Jetzt kannst du den
   *      Stick abziehen" sagt.
   */
  router.post('/api/stick/beenden', async (rc) => {
    rc.requireOwner('Neural OS zu beenden');
    const body = asObject(await rc.body());
    const gewaehlt = optionalString(body.path, 'path', { max: MAX_PATH });

    const laufend = stickMod.laufendeVorgaenge();
    if (laufend.length) {
      throw new NeuralError(
        'STICK_BUSY',
        `Gerade läuft noch „${laufend[0].what}“. Warte, bis es fertig ist – sonst ist der Stick nur halb beschrieben.`,
        { status: 409, details: { laufend } },
      );
    }

    if (rc.ctx.store && typeof rc.ctx.store.flush === 'function') await rc.ctx.store.flush();

    const eigen = eigenerStickPfad(rc);
    let auswurf = null;
    if (!eigen && gewaehlt) {
      const root = path.resolve(gewaehlt);
      const home = rc.ctx.paths && rc.ctx.paths.home;
      // Nie das Laufwerk, auf dem das Programm oder sein Tresor liegt.
      const gefaehrlich = liegtIn(root, APP_ROOT) || (home && liegtIn(root, home));
      if (istOrdner(root) && !gefaehrlich) {
        const werfen = typeof rc.ctx.auswerfen === 'function' ? rc.ctx.auswerfen : stickMod.auswerfen;
        try {
          auswurf = await werfen(root);
        } catch (err) {
          auswurf = { ausgeworfen: false, wie: 'fehler', grund: asNeuralError(err).message };
        }
      }
    }

    audit(rc, 'app.beenden', { via: 'stick', vomStick: !!eigen, ausgeworfen: auswurf ? auswurf.ausgeworfen : null });
    publish(rc, 'app.beendet', { vomStick: !!eigen });

    // Erst wenn die Antwort vollständig beim Betriebssystem liegt, wird
    // geschlossen -- sonst sähe der Browser einen Abbruch statt "gespeichert".
    let geplant = false;
    const planen = () => {
      if (geplant) return;
      geplant = true;
      setTimeout(() => { herunterfahren(rc); }, 150);
    };
    if (rc.res && typeof rc.res.once === 'function') {
      rc.res.once('finish', planen);
      rc.res.once('close', planen);
    } else {
      planen();
    }

    return {
      gespeichert: true,
      beendet: true,
      vomStick: !!eigen,
      stick: eigen || (gewaehlt ? path.resolve(gewaehlt) : null),
      auswurf,
    };
  });
}

module.exports = { register, MAX_PATH };
