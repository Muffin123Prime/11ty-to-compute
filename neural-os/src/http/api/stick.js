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
 *   POST /api/stick/einrichten  "Stick vorbereiten" -- was der Stick braucht
 *   POST /api/stick/sichern     "Jetzt sichern" -- auf den Stick, sonst in den
 *                               Sicherungsordner
 *   POST /api/stick/beenden     "Beenden & abziehen" -- speichern, auswerfen
 *                               wo es geht, sauber schliessen
 *
 * Die älteren Türen (`prepare`, `update`, `runtime`, `preview`, `verify`)
 * bleiben: dieselben Vorgänge wie auf der Kommandozeile, und die Prüfwerkzeuge
 * benutzen sie. Die Routen für ein Sprachmodell auf dem Stick
 * (`/api/stick/models*`) gibt es nicht mehr: die KI ist Claude und läuft
 * online (Entscheidung des Nutzers).
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
const { NeuralError, ValidationError, asNeuralError } = require('../../kernel/errors');

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
  const vorschau = typeof vorschauVon === 'function'
    ? vorschauVon()
    : stickOf(rc, 'preview').preview(root, previewOpts);
  if (vorschau.blockers.length) {
    const erste = vorschau.blockers[0];
    throw new NeuralError(erste.code, erste.message, {
      status: erste.status || 409,
      details: { blockers: vorschau.blockers, root: vorschau.root },
    });
  }

  const stream = openStreamOrExplain(rc, what);
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
    if (typeof danach === 'function') {
      try { danach(); } catch { /* Aufräumen darf den Strom nicht offen lassen */ }
    }
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
    };

    if (portable) {
      const pruefung = await stick.verify(portable.root);
      antwort.laufzeiten = runtimeSummary(pruefung.layout && pruefung.layout.runtimes);
      antwort.freieBytes = pruefung.freeBytes;
      antwort.dateisystem = pruefung.filesystem || null;
      antwort.pruefung = { ok: pruefung.ok, problems: pruefung.problems };
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
    return stick.preview(pathParam(rc), {
      action,
      includeVault: boolParam(rc.query, 'vault', false),
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
      dieserRechner: stick.LOCAL_PLATFORM,
      dieserRechnerName: stickMod.plattformName(stick.LOCAL_PLATFORM),
      download: { noetig: plan.andere.length > 0, erlaubt: netz.erlaubt, grund: netz.grund },
    };
  });

  /* ----------------------------------------------- "Stick vorbereiten" */

  /**
   * Ein Klick, alles, was der Stick braucht (siehe `einrichten()` in
   * src/portable/stick.js): Programm, die Laufzeit dieses Rechners, auf
   * Wunsch die für Windows und Mac, und das Wissen dieses Rechners, wenn auf
   * dem Stick noch keins liegt.
   *
   * Körper: `{ path, andereSysteme?: boolean (Vorgabe true), erlaubnis?: boolean }`.
   * `erlaubnis: true` heißt: der Mensch hat eben zugestimmt, dass nodejs.org
   * einmal erreicht werden darf. Nur dann wird eine Freigabe angelegt -- eng,
   * befristet, und nach dem Vorgang zurückgezogen.
   */
  router.post('/api/stick/einrichten', async (rc) => {
    rc.requireOwner('Einen Stick vorzubereiten');
    const stick = stickOf(rc, 'einrichten');
    const body = asObject(await rc.body());
    const root = path.resolve(requireString(body.path, 'path', { max: MAX_PATH }));
    const mitAnderen = body.andereSysteme !== false;
    const eigenerStick = eigenerStickPfad(rc);
    const plan = stick.einrichtenPlan(root, { eigenerStick, andereSysteme: mitAnderen });

    if (!plan.eigener && !istOrdner(path.dirname(root)) && !istOrdner(root)) {
      throw nichtDa(`Den Ort ${root} gibt es nicht. Steckt der Stick noch?`, { root });
    }

    // Was vorher entscheidbar ist, wird vorher entschieden -- mit derselben
    // Vorschau, mit der auch die einzelnen Vorgänge rechnen.
    const vorschauVon = () => {
      if (plan.fall === 'neu') {
        return stick.preview(root, {
          action: 'prepare',
          includeVault: true,
          includeRuntimes: plan.andere.length ? plan.andere : true,
        });
      }
      if (plan.fall === 'erneuern') return stick.preview(root, { action: 'update' });
      const laeuft = stickMod.runningOn(root);
      return {
        root,
        blockers: laeuft ? [{ code: 'STICK_BUSY', status: 409, message: stickMod.busyError(root, laeuft).message }] : [],
      };
    };

    // Das Wissen wird gleich kopiert; was noch im Schreibpuffer des Tresors
    // steht, gehört dazu.
    if (plan.fall === 'neu' && rc.ctx.store && typeof rc.ctx.store.flush === 'function') {
      await rc.ctx.store.flush();
    }

    let grantId = null;
    if (mitAnderen && body.erlaubnis === true && plan.andere.length && !downloadErlaubt(rc).erlaubt) {
      grantId = erlaubnisErteilen(rc, plan.andere.length);
    }

    audit(rc, 'stick.einrichten', { root, fall: plan.fall, andere: plan.andere, erlaubnis: !!grantId });
    return streamed(rc, {
      what: 'Stick vorbereiten',
      root,
      vorschauVon: () => {
        try {
          return vorschauVon();
        } catch (err) {
          // Die Absage vor dem Strom darf keine Freigabe zurücklassen.
          erlaubnisZurueckziehen(rc, grantId);
          throw err;
        }
      },
      run: async ({ signal, onProgress }) => {
        const r = await stick.einrichten(root, {
          eigenerStick,
          andereSysteme: mitAnderen,
          sourceHome: rc.ctx.paths && rc.ctx.paths.home,
          signal,
          onProgress,
        });
        publish(rc, 'stick.eingerichtet', { root, fall: r.fall, laufzeiten: r.laufzeiten });
        return {
          ...r,
          laufzeitenNamen: r.laufzeiten.map(stickMod.plattformName),
          fehlend: r.fehlend.map((f) => ({ ...f, name: stickMod.plattformName(f.platform) })),
        };
      },
      danach: () => erlaubnisZurueckziehen(rc, grantId),
    });
  });

  /* ------------------------------------------------ die einzelnen Vorgänge */

  router.post('/api/stick/prepare', async (rc) => {
    rc.requireOwner('Einen Stick vorzubereiten');
    const stick = stickOf(rc, 'prepare');
    const body = asObject(await rc.body());
    const root = requireString(body.path, 'path', { max: MAX_PATH });
    const includeVault = body.includeVault === true;
    const extra = body.runtimes === undefined
      ? []
      : requireStringArray(body.runtimes, 'runtimes', { maxItems: 8, max: 40 });
    // Die Laufzeit DIESES Rechners kommt immer mit; `runtimes` nennt nur die
    // zusätzlichen.
    const includeRuntimes = extra.length ? extra : true;
    if (includeVault && rc.ctx.store && typeof rc.ctx.store.flush === 'function') await rc.ctx.store.flush();

    return streamed(rc, {
      what: 'Stick vorbereiten',
      root,
      previewOpts: { action: 'prepare', includeVault, includeRuntimes },
      run: ({ signal, onProgress }) => stick.prepare(root, { includeVault, includeRuntimes, signal, onProgress }),
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

  router.post('/api/stick/runtime', async (rc) => {
    rc.requireOwner('Eine Laufzeit auf den Stick zu legen');
    const stick = stickOf(rc, 'addRuntime');
    const body = asObject(await rc.body());
    const root = requireString(body.path, 'path', { max: MAX_PATH });
    const platform = requireString(body.platform, 'platform', { max: 40 });

    return streamed(rc, {
      what: `Laufzeit ${platform} holen`,
      root,
      previewOpts: { action: 'runtime', platform },
      run: ({ signal, onProgress }) => stick.addRuntime(root, platform, { signal, onProgress }),
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
