'use strict';

/**
 * Der USB-Stick über HTTP.
 *
 * Warum es diese Datei überhaupt gibt
 * -----------------------------------
 * `src/portable/stick.js` kann seit langem alles, was das Hauptversprechen
 * dieses Projekts einlöst -- die KI mit allem Wissen auf einem Stick mitnehmen
 * --, und war trotzdem nur über die Kommandozeile erreichbar. In `web/**` kam
 * das Wort "Stick" kein einziges Mal vor. Ein Versprechen, das man nur kennt,
 * wenn man ein Terminal öffnet, ist für die meisten Menschen kein Versprechen.
 *
 * Die drei Entscheidungen, die diese Routen prägen
 * -----------------------------------------------
 * 1. **Lesen schreibt nicht.** `GET /api/stick` und `GET /api/stick/verify`
 *    legen keine Datei an -- auch keine Sonde. `verify()` kann das seit der
 *    Härtung von stick.js (die Schreibsonde gibt es nur auf ausdrücklichen
 *    Wunsch), und deshalb darf die Ansicht sie beim Öffnen aufrufen.
 * 2. **Erst ansehen, dann schreiben.** Der Browser kennt keine Dateipfade; es
 *    gibt keinen Ordnerwähler, der einen absoluten Pfad liefert, also wird er
 *    getippt. Ein getippter Pfad und ein Knopf, der sofort acht Gigabyte
 *    kopiert, ist eine Falle. `GET /api/stick/preview` beantwortet vorher, was
 *    passieren WÜRDE -- dieselbe Antwort, die `src/http/api/watch.js` mit
 *    seinem "Erst ansehen" für beobachtete Ordner gibt.
 * 3. **Die langen Vorgänge sind ein Ereignisstrom, kein Warten.**
 *    `web/lib/api.js` bricht ein gewöhnliches `api.post()` nach 30 Sekunden ab
 *    (DEFAULT_TIMEOUT_MS), während der Server weiterkopiert -- der Tab sähe
 *    einen Fehler und der Stick würde trotzdem fertig. Deshalb SSE, nach dem
 *    Muster von `src/http/api/chat.js`.
 *
 * Was hier NICHT passiert
 * -----------------------
 * Keine dieser Routen nimmt einen `sourceRoot` entgegen. Was auf den Stick
 * kommt, ist der Quelltext DIESER Instanz; ein Pfad aus dem Netz, der bestimmt,
 * welcher Baum kopiert wird, wäre eine Einladung, die niemand braucht. Der
 * Datenbestand kommt aus `paths.home` derselben Instanz, aus demselben Grund.
 *
 * Wer darf was
 * ------------
 * Die Selbstauskunft braucht `read`: sie sagt dasselbe über diese Installation
 * wie `/api/status`. Alles andere ist `requireOwner`, und zwar dieselbe Linie,
 * die `watch.js` zieht: wer einen getippten Pfad prüfen lassen darf, liest
 * damit Verzeichnisse dieses Rechners -- das ist eine Auskunft über den
 * Computer, nicht über den Tresor, und ein geteilter Lesezugang bekommt sie
 * nicht.
 */

const {
  needMethod,
  asObject,
  requireString,
  requireStringArray,
  strParam,
  boolParam,
} = require('./support');
const { NeuralError, ValidationError, asNeuralError } = require('../../kernel/errors');
const { describePortable } = require('../../kernel/paths');

/** Höchstlänge eines getippten Pfads. Ein Pfad, der länger ist, ist ein Versehen. */
const MAX_PATH = 1000;

function stickOf(rc, method = 'verify') {
  return needMethod(
    rc.ctx.stick,
    method,
    'Das Stick-Werkzeug',
    'Ohne es kann diese Instanz keinen Stick vorbereiten – und behauptet es auch nicht.',
  );
}

/** Der getippte Pfad, aus der Abfrage oder aus dem Anfragekörper. */
function pathParam(rc) {
  const value = strParam(rc.query, 'path', MAX_PATH);
  if (!value) {
    throw new ValidationError(
      'Es fehlt der Pfad zum Stick (z. B. /media/usb oder E:\\). Der Browser kennt keine Dateipfade, '
      + 'er muss getippt werden.',
    );
  }
  return value;
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

/**
 * Was diese Instanz über Modelle WEISS -- ohne nachzusehen.
 *
 * Absichtlich der zwischengespeicherte Stand (wie `/api/status`): die Frage
 * "kommt das Sprachmodell mit auf den Stick" darf keine Modellsuche auslösen.
 * Die Antwort lautet immer nein; diese Zahlen sagen nur, was auf DIESEM Rechner
 * gerade erreichbar ist -- und damit, was auf einem fremden Rechner fehlen wird.
 */
function modelNote(rc) {
  const registry = rc.ctx.registry;
  const out = {
    reistMit: false,
    grund: 'Ein Sprachmodell ist mehrere Gigabyte gross und gehört einem Anbieter auf diesem Rechner '
      + '(z. B. Ollama), nicht Neural OS. Der Stick nimmt deine Notizen, Chats und Verknüpfungen mit – '
      + 'das Modell nicht.',
    geprueft: false,
    hierErreichbar: null,
    anbieter: [],
  };
  if (!registry || typeof registry.list !== 'function') return out;
  let snapshot = null;
  try {
    snapshot = registry.list();
  } catch {
    snapshot = null;
  }
  if (!snapshot || !Array.isArray(snapshot.providers)) return out;
  // Ohne Zeitstempel hat noch nie jemand nachgesehen. Dann steht hier nicht
  // "kein Modell da" -- das wäre erfunden --, sondern die offene Frage.
  if (!snapshot.at) return out;
  out.geprueft = true;
  out.hierErreichbar = snapshot.providers.some((p) => p.available);
  out.anbieter = snapshot.providers
    .filter((p) => p.available)
    .map((p) => ({ id: p.id, modelle: Array.isArray(p.models) ? p.models.map((m) => m.id) : [] }));
  return out;
}

/**
 * Den Ereignisstrom öffnen -- oder erklären, warum nicht.
 *
 * `src/http/server.js` begrenzt die gleichzeitig offenen Ströme (Vorgabe 8),
 * und `/api/events` belegt bereits einen je offenem Tab. Die Meldung
 * „Es sind bereits 8 Ereignis-Verbindungen offen" ist dann zwar wahr, aber sie
 * lässt offen, was mit dem Stick ist. Genau das steht hier dazu: es wurde
 * nichts geschrieben, und der Stick ist unverändert.
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
      + 'Schliesse die anderen Tabs und versuche es erneut – auf dem Stick wurde nichts verändert.',
      { status: 503, details: e.details || null },
    );
  }
}

/**
 * Ein langer Vorgang als Ereignisstrom.
 *
 * Die Reihenfolge ist die eigentliche Zusage dieser Funktion:
 *
 *   1. Die Vorschau läuft. Sie rechnet mit DERSELBEN Formel wie der Vorgang
 *      (`spaceNeeded` in stick.js) und liefert die Hindernisse als fertige
 *      deutsche Sätze samt Statuscode.
 *   2. Gibt es ein Hindernis, endet die Anfrage hier -- als gewöhnliche
 *      Fehlerantwort mit 409/403/507, nicht als halber Ereignisstrom, in dem
 *      eine Fehlermeldung steht. Ein Strom, der sich sofort entschuldigt, ist
 *      schwerer zu behandeln als ein Statuscode.
 *   3. Erst dann wird der Strom geöffnet, und erst dann fängt die Arbeit an.
 *
 * Damit gilt: alles, was vorher beantwortbar war, ist vor dem ersten Byte
 * beantwortet -- vor dem ersten Byte der Antwort UND vor dem ersten Byte auf
 * dem Stick. Was danach noch schiefgehen kann (der Stick wird abgezogen, er
 * läuft mitten im Kopieren voll), kommt als `fehler`-Ereignis, weil es vorher
 * niemand wissen konnte.
 */
async function streamed(rc, { what, root, previewOpts, run }) {
  const stick = stickOf(rc, 'preview');

  const vorschau = stick.preview(root, previewOpts);
  if (vorschau.blockers.length) {
    const erste = vorschau.blockers[0];
    throw new NeuralError(erste.code, erste.message, {
      status: erste.status || 409,
      details: { blockers: vorschau.blockers, root: vorschau.root },
    });
  }

  const stream = openStreamOrExplain(rc, what);
  // Ein geschlossener Tab darf keine 8-GB-Kopie zu Ende laufen lassen.
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
    stream.close();
  }
  return undefined; // der Strom hat die Antwort übernommen
}

function register(router) {
  /* ------------------------------------------------------- Selbstauskunft */

  /**
   * Läuft DIESE Instanz von einem Stick? Von wo? Wie viel Platz ist da?
   *
   * Kein Pfadargument, keine Nebenwirkung. Läuft die Instanz portabel, kommt
   * die Prüfung ihres eigenen Sticks gleich mit -- sie schreibt nichts und ist
   * genau das, was oben in der Ansicht stehen muss.
   */
  router.get('/api/stick', async (rc) => {
    rc.requireCapability('read');
    const stick = stickOf(rc);
    const portable = describePortable(rc.ctx.portable);

    const antwort = {
      portabel: !!portable,
      von: portable,
      // Wo die Daten dieser Instanz JETZT liegen. Bei einem portablen Start ist
      // das derselbe Pfad wie `von.dataDir`; sonst ist es genau der Ordner, der
      // beim Vorbereiten mitkopiert würde -- und die Ansicht soll ihn nennen
      // können, statt "dein Datenbestand" zu sagen.
      datenOrdner: (rc.ctx.paths && rc.ctx.paths.home) || null,
      dieserRechner: stick.LOCAL_PLATFORM,
      bekanntePlattformen: Object.keys(stick.PLATFORMS),
      laufzeiten: [],
      freieBytes: null,
      dateisystem: null,
      pruefung: null,
      modell: modelNote(rc),
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

  /* -------------------------------------------- einen Stick prüfen/ansehen */

  /**
   * Prüft einen Stick und sagt, was zu tun ist.
   *
   * Schreibt nichts: `verify()` beantwortet die Rechtefrage aus Zeugen statt
   * aus einer Sonde und meldet ehrlich PERMISSIONS_UNKNOWN, wenn es keine
   * gibt. Deshalb darf das ein GET sein.
   */
  router.get('/api/stick/verify', async (rc) => {
    rc.requireOwner('Einen Stick zu prüfen');
    const stick = stickOf(rc);
    return stick.verify(pathParam(rc));
  });

  /**
   * „Erst ansehen": was würde passieren, wenn man jetzt klickt.
   *
   * Dieselben Zahlen, die der Vorgang danach benutzt -- nicht eine Schätzung
   * daneben. Alles, was den Vorgang aufhalten würde, steht in `blockers`, und
   * zwar als Satz, den die Oberfläche anzeigen kann.
   */
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

  /* ------------------------------------------------ die langen Vorgänge */

  router.post('/api/stick/prepare', async (rc) => {
    rc.requireOwner('Einen Stick vorzubereiten');
    const stick = stickOf(rc, 'prepare');
    const body = asObject(await rc.body());
    const root = requireString(body.path, 'path', { max: MAX_PATH });
    const includeVault = body.includeVault === true;
    const extra = body.runtimes === undefined
      ? []
      : requireStringArray(body.runtimes, 'runtimes', { maxItems: 8, max: 40 });
    // Die Laufzeit DIESES Rechners kommt immer mit; sie braucht kein Netz und
    // ist das, was den Stick überhaupt startfähig macht. `runtimes` nennt nur
    // die zusätzlichen.
    const includeRuntimes = extra.length ? extra : true;

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
}

module.exports = { register, MAX_PATH };
