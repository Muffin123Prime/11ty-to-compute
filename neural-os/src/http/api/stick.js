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
 * Das Modell (`/api/stick/models`, `/preview`, `/copy`)
 * ------------------------------------------------------
 * Dieselben drei Entscheidungen, ein zweites Mal: `GET /api/stick/models`
 * schreibt nichts und beantwortet trotzdem alles, was man VOR dem Klick
 * wissen muss -- was hier liegt, was auf dem Stick liegt und für welches
 * Betriebssystem, ob das Dateisystem eine 4-GB-Datei überhaupt aufnimmt, und
 * ob der Platz reicht. `preview` ist derselbe Plan für eine eigene Auswahl,
 * `copy` derselbe Plan und dann der Vorgang als Ereignisstrom. Die Maschinerie
 * steht in `src/portable/model.js`; hier steht nur die Tür.
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
  optionalString,
  requireStringArray,
  strParam,
  boolParam,
} = require('./support');
const { NeuralError, ValidationError, asNeuralError } = require('../../kernel/errors');
const { describePortable } = require('../../kernel/paths');

/** Höchstlänge eines getippten Pfads. Ein Pfad, der länger ist, ist ein Versehen. */
const MAX_PATH = 1000;

/** Mehr Kennungen wählt niemand von Hand aus; mehr Funde gibt es auch selten. */
const MAX_AUSWAHL = 64;

function stickOf(rc, method = 'verify') {
  return needMethod(
    rc.ctx.stick,
    method,
    'Das Stick-Werkzeug',
    'Ohne es kann diese Instanz keinen Stick vorbereiten – und behauptet es auch nicht.',
  );
}

/* ------------------------------------------------------------ das Modell */

/**
 * Das Modellwerkzeug (`src/portable/model.js`) -- eines je Instanz.
 *
 * WARUM hier gebaut und nicht in app.js: das Werkzeug hat keinen Zustand
 * ausser seinen Abhängigkeiten (Logger, Umgebung, Heimatordner), und die
 * Sperre je Stick-Wurzel hängt am Pfad, nicht am Objekt. Es beim ersten
 * Aufruf zu bauen hält den Start der Anwendung frei von einer Modellsuche --
 * `finden()` liest Ollamas Manifeste und darf nicht laufen, nur weil jemand
 * `doctor` aufgerufen hat.
 */
const modelTools = new WeakMap();

function modelsOf(rc) {
  const ctx = rc.ctx || {};
  let tool = modelTools.get(ctx);
  if (tool === undefined) {
    tool = null;
    try {
      const mod = require('../../portable/model');
      tool = mod.createPortableModels({ logger: ctx.logger });
    } catch (err) {
      tool = null;
      if (rc.log && typeof rc.log.error === 'function') rc.log.error(`Modellwerkzeug nicht ladbar: ${err && err.message}`);
    }
    modelTools.set(ctx, tool);
  }
  return needMethod(
    tool,
    'finden',
    'Das Modellwerkzeug des Sticks',
    'Ohne es kann diese Instanz kein Modell auf einen Stick legen – und behauptet es auch nicht.',
  );
}

/**
 * Welcher Statuscode zu einem Stopp-Hindernis aus `planen()` gehört.
 *
 * Dieselbe Linie wie bei `stick.preview()`: was den Vorgang aufhält, wird als
 * gewöhnliche Fehlerantwort abgelehnt, bevor ein Strom geöffnet wird. Ein
 * unbekannter Code ist ein Konflikt mit dem Stick, kein Serverfehler.
 */
const HINDERNIS_STATUS = {
  ZU_WENIG_PLATZ: 507,
  KEIN_SCHREIBRECHT: 403,
  ZIEL_FEHLT: 404,
  QUELLE_FEHLT: 404,
  NICHTS_AUSGEWAEHLT: 400,
  UNBEKANNTE_AUSWAHL: 400,
  VORGANG_LAEUFT: 409,
  DATEI_ZU_GROSS: 409,
};

/**
 * Der Plan ohne seine Dateiliste.
 *
 * Ein Ollama-Modell besteht aus einem Dutzend Blobs mit absoluten Quellpfaden;
 * für die Anzeige zählt die Zahl, nicht die Liste. `anzahl`, `bytes` und die
 * Hindernisse bleiben unverändert -- es sind dieselben Zahlen, mit denen
 * `kopieren()` danach rechnet.
 */
function planFuerHttp(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const { dateien, ...rest } = plan;
  return { ...rest, anzahl: Array.isArray(dateien) ? dateien.length : rest.anzahl };
}

/** Der Stick, von dem diese Instanz läuft -- oder null. */
function eigenerStickPfad(rc) {
  const portable = describePortable(rc.ctx.portable);
  return portable && portable.root ? portable.root : null;
}

/** Die Kennungen aller Funde: die Vorgabe, wenn niemand etwas ausgewählt hat. */
function alleKennungen(befund) {
  return [...(befund.kerne || []), ...(befund.modelle || [])].map((f) => f.id);
}

/** Auswahl aus dem Anfragekörper; fehlt sie, gilt alles, was gefunden wurde. */
function auswahlAus(body, befund) {
  if (body.auswahl === undefined || body.auswahl === null) return alleKennungen(befund);
  return requireStringArray(body.auswahl, 'auswahl', { maxItems: MAX_AUSWAHL, max: 200 });
}

/** Für welches Gerät gefragt wird ('ipados', 'win-x64', …) -- oder dieser Rechner. */
function fuerAus(source) {
  const value = source && typeof source === 'object'
    ? (typeof source.fuer === 'string' ? source.fuer.trim().slice(0, 40) : '')
    : '';
  return value || undefined;
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
 * Was diese Instanz über Modelle WEISS -- ohne auf diesem Rechner nachzusehen.
 *
 * Absichtlich der zwischengespeicherte Stand (wie `/api/status`): die Frage
 * "kommt das Sprachmodell mit auf den Stick" darf keine Modellsuche auslösen.
 * Von selbst reist es nie mit -- `reistMit` sagt nur, ob auf dem Stick, von
 * dem diese Instanz läuft, schon eines liegt (dazugelegt über
 * `/api/stick/models/copy`). Diese Zahlen sagen, was auf DIESEM Rechner gerade
 * erreichbar ist -- und damit, was auf einem fremden Rechner fehlen wird.
 */
function modelNote(rc) {
  const registry = rc.ctx.registry;
  const out = {
    reistMit: false,
    vonSelbst: false,
    grund: 'Ein Sprachmodell reist nicht von selbst mit: es ist mehrere Gigabyte gross und gehört einem '
      + 'Anbieter auf diesem Rechner (z. B. Ollama), nicht Neural OS. Der Stick nimmt deine Notizen, Chats und '
      + 'Verknüpfungen immer mit – das Modell nur, wenn du es unter „Modell mitnehmen" ausdrücklich dazulegst.',
    geprueft: false,
    hierErreichbar: null,
    anbieter: [],
    // Nur im portablen Betrieb: was auf DIESEM Stick schon liegt und ob es zu
    // diesem Rechner passt. Sonst null -- es gibt keinen Stick, über den man
    // etwas sagen könnte.
    aufDemStick: null,
    // Der Aufseher über den Laufzeitkern (src/models/local-runner.js), falls
    // diese Instanz einen hat: einer von vier Zuständen, nie ein Ja/Nein.
    laufzeitkern: null,
  };
  const pfad = eigenerStickPfad(rc);
  if (pfad) {
    try {
      out.aufDemStick = modelsOf(rc).aufDemStick(pfad);
      out.reistMit = !!(out.aufDemStick && out.aufDemStick.vorhanden);
    } catch (err) {
      out.aufDemStick = { fehler: asNeuralError(err).message };
    }
  }
  const runner = rc.ctx.localRunner;
  if (runner && typeof runner.zustand === 'function') {
    try { out.laufzeitkern = runner.zustand(); } catch { out.laufzeitkern = null; }
  }
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
async function streamed(rc, { what, root, previewOpts, vorschauVon, run }) {
  // Entweder die Vorschau des Stick-Werkzeugs oder eine eigene (das Modell
  // plant mit `planen()`); beide liefern `blockers` mit Satz und Statuscode.
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

  /* ------------------------------------------------- das Modell mitnehmen */

  /**
   * Was liegt auf diesem Rechner, was auf dem Stick, und passt es zusammen?
   *
   * Drei Antworten in einer, weil die Ansicht alle drei braucht, BEVOR jemand
   * klickt: `rechner` (finden: Modelle und Laufzeitkerne hier, mit Grösse),
   * `stick` (aufDemStick: was dort liegt, für welches Betriebssystem, und der
   * eine ehrliche Satz dazu) und `vorschau` (planen: Dateisystem, freier
   * Platz, die 4-GB-Grenze -- gerechnet für alles, was gefunden wurde).
   * Nichts davon schreibt; planen() legt nicht einmal einen Ordner an.
   *
   * `path` ist freiwillig: fehlt er, gilt der Stick, von dem diese Instanz
   * läuft; gibt es auch den nicht, kommt nur `rechner` zurück -- und die
   * Ansicht sagt, dass ein Pfad fehlt, statt einen leeren Kasten zu zeigen.
   *
   * `requireOwner`, weil finden() Verzeichnisse dieses Rechners liest (den
   * Heimatordner, den PATH): das ist die Linie, die auch verify zieht.
   */
  router.get('/api/stick/models', (rc) => {
    rc.requireOwner('Nach Modellen auf diesem Rechner zu suchen');
    const modelle = modelsOf(rc);
    const pfad = strParam(rc.query, 'path', MAX_PATH) || eigenerStickPfad(rc);
    const fuer = strParam(rc.query, 'fuer', 40) || undefined;

    const befund = modelle.finden();
    const antwort = {
      dieserRechner: modelle.dieserRechner,
      pfad: pfad || null,
      rechner: befund,
      stick: null,
      vorschau: null,
    };
    if (pfad) {
      antwort.stick = modelle.aufDemStick(pfad, { fuer });
      antwort.vorschau = planFuerHttp(modelle.planen({ ziel: pfad, befund, auswahl: alleKennungen(befund), fuer }));
    }
    return antwort;
  });

  /**
   * „Erst ansehen" für das Modell: derselbe Plan, mit dem `copy` danach
   * arbeitet. Ein POST, obwohl nichts geschrieben wird -- die Auswahl ist eine
   * Liste, und eine Liste gehört in den Anfragekörper, nicht in die Adresse.
   */
  router.post('/api/stick/models/preview', async (rc) => {
    rc.requireOwner('Einen Modellplan anzusehen');
    const modelle = modelsOf(rc);
    const body = asObject(await rc.body());
    const root = requireString(body.path, 'path', { max: MAX_PATH });
    const befund = modelle.finden();
    return planFuerHttp(modelle.planen({
      ziel: root,
      befund,
      auswahl: auswahlAus(body, befund),
      fuer: fuerAus(body),
    }));
  });

  /**
   * Das Modell auf den Stick legen -- als Ereignisstrom, weil es um Gigabyte
   * geht und `web/lib/api.js` ein gewöhnliches POST nach 30 Sekunden abbricht.
   *
   * Vor dem ersten Byte: der Plan. Ein Stopp-Hindernis (FAT32 und eine 5-GB-
   * Datei, zu wenig Platz, nichts ausgewählt) wird als Statuscode abgelehnt,
   * nicht als Strom, der sich sofort entschuldigt. Ein geschlossener Tab
   * bricht ab; das halb Kopierte verschwindet, und was vorher auf dem Stick
   * lag, wurde nie angefasst -- das sichert `kopieren()` selbst zu.
   */
  router.post('/api/stick/models/copy', async (rc) => {
    rc.requireOwner('Ein Modell auf den Stick zu kopieren');
    const modelle = modelsOf(rc);
    const body = asObject(await rc.body());
    const root = requireString(body.path, 'path', { max: MAX_PATH });
    const pruefsummen = optionalString(body.pruefsummen, 'pruefsummen', { max: 10 }) || 'auto';
    if (!['auto', 'alle', 'keine'].includes(pruefsummen)) {
      throw new ValidationError(`"${pruefsummen}" ist keine bekannte Prüfsummen-Einstellung. Möglich sind: auto, alle, keine.`);
    }
    const befund = modelle.finden();
    const auswahl = auswahlAus(body, befund);
    const fuer = fuerAus(body);

    return streamed(rc, {
      what: 'Modell auf den Stick kopieren',
      root,
      vorschauVon: () => {
        const plan = modelle.planen({ ziel: root, befund, auswahl, fuer });
        return {
          ...planFuerHttp(plan),
          root: plan.ziel,
          blockers: plan.hindernisse
            .filter((h) => h.schwere === 'stopp')
            .map((h) => ({ code: h.code, message: h.satz, status: HINDERNIS_STATUS[h.code] || 409, details: h.details })),
        };
      },
      run: async ({ signal, onProgress }) => {
        const ergebnis = await modelle.kopieren(root, { befund, auswahl, fuer, pruefsummen, signal, onProgress });
        // `files`/`bytes`/`warnings` sind die Felder, die die Ansicht schon von
        // den anderen Vorgängen kennt; der Rest bleibt daneben stehen.
        return {
          ...ergebnis,
          files: ergebnis.kopiert ? ergebnis.kopiert.dateien : 0,
          bytes: ergebnis.kopiert ? ergebnis.kopiert.bytes : 0,
          warnings: ergebnis.warnungen || [],
        };
      },
    });
  });
}

module.exports = { register, MAX_PATH };
