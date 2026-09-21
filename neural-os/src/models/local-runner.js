'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ValidationError, asNeuralError } = require('../kernel/errors');

/**
 * Aufseher fuer einen Laufzeitkern, der auf dem Datentraeger mitliegt.
 *
 * Warum es diese Datei gibt
 * -------------------------
 * Ein Modell auf dem Stick nuetzt nichts, wenn es niemand startet. Auf einem
 * fremden Rechner ist weder Ollama installiert noch darf etwas installiert
 * werden; was der Stick mitbringt, muss der Stick selbst hochfahren. Dieses
 * Modul ist genau dieser Teil -- und nichts sonst: es spricht keine
 * Modellschnittstelle, es kennt kein Prompt, es erfindet keine Antwort. Es
 * startet einen fremden Prozess, MISST, ob dessen Schnittstelle antwortet,
 * und raeumt ihn wieder ab.
 *
 * Die Entscheidungen, die hier festgehalten sind und nicht anderswo
 * -----------------------------------------------------------------
 * - **Der Port wird gesucht, nicht angenommen.** 11434 (Ollama) und 8080
 *   (llama-server) sind auf einem fremden Rechner regelmaessig belegt -- von
 *   einer anderen Anwendung oder von einem Ollama, das dort schon laeuft. Ein
 *   fester Port waere also der Normalfall eines Fehlschlags. Der Kern bekommt
 *   deshalb einen freien Port zugewiesen, und bei EADDRINUSE wird ein zweiter
 *   und dritter versucht: zwischen "Port frei" und "Kern bindet ihn" liegt ein
 *   Wimpernschlag, in dem ihn jemand anders nehmen kann.
 * - **Gebunden an 127.0.0.1, immer.** Ein Modell, das auf 0.0.0.0 lauscht,
 *   haengt an jedem Rechner, an den der Stick gesteckt wird, das komplette
 *   Wissen des Besitzers ins fremde Netz. Das ist keine Einstellung, das ist
 *   eine Zusage; sie wird an jeder Stelle gesetzt, an der eine Adresse
 *   vorkommt, auch wenn der Beschreibungseintrag etwas anderes wuenscht.
 *   Das gilt AUCH, wenn Neural OS selbst fuer andere Geraete geoeffnet ist
 *   (security.sharing, z. B. um vom iPad im Browser darauf zuzugreifen):
 *   geoeffnet wird dann die Oberflaeche mit ihrer Anmeldung, nicht der
 *   Modellserver. llama-server und Ollama kennen kein Token und keine
 *   Rechte -- wer sie erreicht, redet mit dem Modell. Diese beiden Zusagen
 *   duerfen nie zusammenfallen.
 * - **Bereitschaft wird gemessen.** "Prozess gestartet" heisst nicht
 *   "Modell antwortet": llama-server laedt erst mehrere Gigabyte in den
 *   Arbeitsspeicher. Solange die Schnittstelle nicht antwortet, ist der
 *   Zustand `startet` -- nicht `laeuft`. Ein Chat, der auf eine Adresse
 *   zeigt, hinter der noch nichts ist, faellt sonst mit "Verbindung
 *   verweigert" auf, und niemand weiss warum.
 * - **Ein Kern, der stirbt, hinterlaesst einen Satz.** Fehlendes
 *   Ausfuehrbar-Bit (exFAT kennt keine Dateirechte), falsche Plattform, zu
 *   wenig RAM: das sind die drei haeufigen Faelle, und sie sehen in einem
 *   nackten Fehlercode alle gleich aus. Deshalb werden die letzten Zeilen der
 *   Fehlerausgabe des Kindprozesses mitgefuehrt und mit ausgegeben.
 * - **Kein verwaister Kindprozess.** Ein llama-server, den niemand mehr
 *   kennt, haelt mehrere Gigabyte fest, bis der Rechner neu startet. Deshalb
 *   haengt zusaetzlich zum geordneten `stoppen()` eine Notbremse an
 *   `process.on('exit')`, die auch beim Absturz noch SIGKILL schickt. Gegen
 *   ein SIGKILL auf den Elternprozess selbst hilft nichts -- das steht so im
 *   Bericht und wird nicht schoengeredet.
 * - **Die Beschreibungsdatei wird defensiv gelesen.** `models/modelle.json`
 *   legt ein anderer Teil des Systems an. Statt auf eine Gestalt zu wetten,
 *   werden mehrere uebliche Feldnamen akzeptiert; was nicht verstanden wird,
 *   fuehrt zu `gescheitert` MIT Begruendung, nie zu einem geratenen Aufruf.
 *   Ein geratener Aufruf startet im Zweifel das falsche Programm.
 * - **Nur vom Datentraeger.** Der Programmpfad aus der Beschreibungsdatei
 *   muss innerhalb der Stick-Wurzel liegen. Eine Beschreibungsdatei, die auf
 *   `/bin/sh` zeigt, ist kein Modell, sondern ein Angriff auf den Rechner,
 *   in dem der Stick steckt.
 */

/** Relativer Ort der Beschreibungsdatei auf dem Datentraeger. */
const BESCHREIBUNG = path.join('models', 'modelle.json');

/** Groesser als das darf die Beschreibungsdatei nicht sein, um gelesen zu werden. */
const MAX_BESCHREIBUNG_BYTES = 4 * 1024 * 1024;

/** Die vier Zustaende. Mehr gibt es nicht, und vermischt werden sie nie. */
const ZUSTAND = {
  fehlt: 'nicht-vorhanden',
  startet: 'startet',
  laeuft: 'laeuft',
  gescheitert: 'gescheitert',
};

/** Immer diese Adresse. Siehe Kopfkommentar. */
const HOST = '127.0.0.1';

/** Voreinstellungen, alle in Millisekunden. */
const START_TIMEOUT_MS = 90 * 1000;
const POLL_START_MS = 150;
const POLL_MAX_MS = 3000;
const FRIST_SIGTERM_MS = 5000;
const FRIST_SIGKILL_MS = 2000;

/** So viele Zeilen der Fehlerausgabe werden aufgehoben. */
const AUSGABE_ZEILEN = 40;
const AUSGABE_BYTES = 16 * 1024;

/** Wie oft ein neuer Port versucht wird, wenn der gewaehlte inzwischen belegt ist. */
const PORT_VERSUCHE = 3;

/** Bereich der Netzschleuse fuer alles, was dieses Modul tut. */
const SCOPE = 'stick:modell';

/* --------------------------------------------------------- Feldnamen ---- */

const FELD_PROGRAMM = ['programm', 'binary', 'bin', 'exe', 'executable', 'command', 'cmd', 'server', 'runner', 'kernPfad'];
const FELD_MODELL = ['modell', 'model', 'modellDatei', 'modelFile', 'gguf', 'gewichte', 'weights', 'modelPath', 'modellPfad'];
const FELD_ARGS = ['args', 'argumente', 'arguments', 'argv', 'optionen', 'options', 'flags'];
const FELD_ART = ['kern', 'art', 'kind', 'engine', 'laufzeit', 'runtime', 'typ', 'type', 'backend', 'schnittstelle'];
// `name` vor `id`: src/portable/model.js vergibt ids wie "kern:llama.cpp",
// das steht in einem deutschen Satz schlechter da als "llama-server".
const FELD_NAME = ['name', 'bezeichnung', 'titel', 'label', 'id'];
const FELD_PLATTFORM = ['plattform', 'platform', 'os', 'betriebssystem', 'plattformen', 'platforms'];
const FELD_LISTE = ['modelle', 'models', 'eintraege', 'einträge', 'entries', 'items', 'kerne', 'runtimes', 'liste'];

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

/** Erstes gesetztes Feld aus einer Liste von Schreibweisen. */
function feld(obj, namen) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of namen) {
    const wert = obj[name];
    if (wert !== undefined && wert !== null && wert !== '') return wert;
  }
  return undefined;
}

/**
 * Welche Schnittstelle spricht dieser Kern?
 *
 * Es wird bewusst NICHT geraten: kommt nichts Erkennbares heraus, ist das
 * Ergebnis null, und der Aufrufer sagt das dem Menschen. Ein Kern, den man
 * mit der falschen Schnittstelle anspricht, antwortet mit HTTP 404 -- und
 * das sieht von aussen aus wie "kein Modell da".
 */
function artErkennen(rohwert, programmpfad) {
  const quellen = [rohwert, programmpfad ? path.basename(programmpfad) : null];
  for (const quelle of quellen) {
    if (typeof quelle !== 'string' || !quelle) continue;
    // Trenner weg, bevor verglichen wird: "LM Studio", "lm-studio" und
    // "lmstudio" sind dasselbe Programm, und welche Schreibweise in der
    // Beschreibungsdatei landet, entscheidet nicht dieses Modul.
    const s = quelle.toLowerCase().replace(/[\s._-]/g, '');
    if (s.includes('ollama')) return 'ollama';
    // llama-server, llama.cpp, llamafile, llamacpp, lmstudio, vllm und
    // "openai" sprechen alle den /v1/chat/completions-Dialekt.
    if (s.includes('llama') || s.includes('openai') || s.includes('lmstudio') || s.includes('vllm')) return 'openai';
  }
  return null;
}

/** Passt dieser Eintrag auf den Rechner, auf dem wir gerade stecken? */
function plattformPasst(rohwert, plattform, arch) {
  if (rohwert === undefined || rohwert === null || rohwert === '') return true;
  const werte = Array.isArray(rohwert) ? rohwert : [rohwert];
  const eigene = [plattform, arch, `${plattform}-${arch}`, `${plattform}_${arch}`];
  for (const wert of werte) {
    if (typeof wert !== 'string') continue;
    const w = wert.trim().toLowerCase();
    if (!w || w === '*' || w === 'alle' || w === 'any') return true;
    if (eigene.some((e) => e && w === String(e).toLowerCase())) return true;
    // "win-x64" gegen plattform "win32": der Stick benutzt Nodes dist-Namen.
    if (plattform === 'win32' && (w === 'win' || w === 'win-x64' || w === 'win-arm64') && w.includes(arch === 'x64' ? 'x64' : arch)) return true;
  }
  return false;
}

/** Die Liste der Eintraege aus einer Datei, deren Gestalt wir nicht festlegen. */
function alsListe(roh) {
  if (Array.isArray(roh)) return roh;
  if (!roh || typeof roh !== 'object') return null;
  for (const name of FELD_LISTE) {
    if (Array.isArray(roh[name])) return roh[name];
  }
  // Ein einzelner Eintrag ohne Huelle ist ebenfalls eine gueltige Liste.
  if (feld(roh, FELD_PROGRAMM) !== undefined || Array.isArray(roh.dateien)) return [roh];
  return null;
}

/** Argumente als Zeichenkettenliste; alles andere wird verworfen, nicht geraten. */
function alsArgumente(rohwert) {
  if (rohwert === undefined || rohwert === null) return [];
  if (Array.isArray(rohwert)) return rohwert.filter((a) => typeof a === 'string' || typeof a === 'number').map(String);
  // Eine einzelne Zeichenkette wird an Leerzeichen getrennt. Das ist eine
  // Vereinfachung: Anfuehrungszeichen kann sie nicht. Wer Pfade mit
  // Leerzeichen hat, schreibt eine Liste -- das steht auch im Fehlertext.
  if (typeof rohwert === 'string') return rohwert.split(/\s+/).filter(Boolean);
  return [];
}

/**
 * Loest einen Pfad aus der Beschreibungsdatei auf und haelt ihn im Stick.
 * @returns {{pfad:string}|{fehler:string}}
 */
function pfadImStick(rohwert, basis, wurzel, was) {
  if (typeof rohwert !== 'string' || !rohwert.trim()) {
    return { fehler: `Für ${was} steht in ${BESCHREIBUNG} kein Pfad.` };
  }
  const aufgeloest = path.resolve(basis, rohwert.trim());
  const relativ = path.relative(wurzel, aufgeloest);
  if (relativ === '' || relativ.startsWith('..') || path.isAbsolute(relativ)) {
    return {
      fehler: `${was} zeigt mit "${rohwert}" aus dem Datenträger hinaus (${aufgeloest}). `
        + 'Neural OS startet nur Programme, die auf dem Datenträger selbst liegen.',
    };
  }
  return { pfad: aufgeloest };
}

/** Freier Port auf 127.0.0.1, vom Betriebssystem vergeben. */
function freierPort() {
  return new Promise((resolve, reject) => {
    const horcher = net.createServer();
    horcher.unref();
    horcher.once('error', reject);
    horcher.listen(0, HOST, () => {
      const adresse = horcher.address();
      const port = adresse && adresse.port;
      horcher.close(() => (port ? resolve(port) : reject(new Error('Kein Port vom Betriebssystem erhalten.'))));
    });
  });
}

/**
 * Der deutsche Satz zu einem Startfehler.
 *
 * Ohne diese Uebersetzung steht auf dem Bildschirm "spawn EACCES" -- ein
 * Mensch mit einem USB-Stick in der Hand kann damit nichts anfangen, obwohl
 * der Fehler in 30 Sekunden behebbar ist.
 */
function startFehlerSatz(err, programm) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return `Der Laufzeitkern ${programm} darf nicht ausgeführt werden (${code}). `
      + 'Auf einem Stick mit exFAT oder FAT32 gibt es kein Ausführbar-Bit, das ein Kopiervorgang erhalten könnte. '
      + `Abhilfe unter Linux/macOS: chmod +x "${programm}" — oder den Ordner einmal auf die Festplatte kopieren und von dort starten.`;
  }
  if (code === 'ENOENT') {
    return `Den Laufzeitkern ${programm} gibt es nicht (ENOENT). In ${BESCHREIBUNG} steht er, auf dem Datenträger liegt er nicht.`;
  }
  if (code === 'ENOEXEC') {
    return `Der Laufzeitkern ${programm} ist kein Programm für diesen Rechner (ENOEXEC) — `
      + `vermutlich für ein anderes Betriebssystem oder eine andere Architektur gebaut (hier: ${process.platform}-${process.arch}).`;
  }
  if (code === 'ENOMEM') {
    return `Für den Laufzeitkern ${programm} war nicht genug Arbeitsspeicher frei (ENOMEM).`;
  }
  return `Der Laufzeitkern ${programm} ließ sich nicht starten: ${(err && err.message) || String(err)}`;
}

/** Der Satz zu einem Kern, der startete und gleich wieder starb. */
function todesSatz({ code, signal, programm, ausgabe }) {
  const kopf = signal
    ? `Der Laufzeitkern ${programm} wurde gleich nach dem Start durch ${signal} beendet.`
    : `Der Laufzeitkern ${programm} hat sich gleich nach dem Start mit Code ${code} beendet.`;
  const hinweis = code === 137 || signal === 'SIGKILL'
    ? ' Code 137/SIGKILL heißt in aller Regel: der Arbeitsspeicher hat nicht gereicht.'
    : '';
  const letzte = ausgabe && ausgabe.length
    ? `\nLetzte Zeilen seiner Fehlerausgabe:\n${ausgabe.map((z) => `  | ${z}`).join('\n')}`
    : '\nEr hat nichts ausgegeben, woraus sich der Grund ablesen ließe.';
  return kopf + hinweis + letzte;
}

/* ------------------------------------------------------------- Aufseher -- */

/**
 * @param {object} deps
 * @param {string} deps.stickRoot   Wurzel des Datentraegers (dort liegt models/)
 * @param {object} [deps.gate]      Netzschleuse; die Bereitschaftsmessung laeuft durch sie
 * @param {Function} [deps.logger]
 * @param {object} [deps.audit]
 * @param {string} [deps.plattform] nur fuer Tests
 * @param {string} [deps.arch]      nur fuer Tests
 */
function createLocalRunner({ stickRoot, gate, logger, audit, plattform, arch } = {}) {
  if (typeof stickRoot !== 'string' || !stickRoot.trim()) {
    throw new ValidationError('Der Aufseher für den Laufzeitkern braucht die Wurzel des Datenträgers.');
  }
  const wurzel = path.resolve(stickRoot);
  const log = typeof logger === 'function' ? logger('stick-modell') : nullLogger();
  const dieseP = plattform || process.platform;
  const dieseA = arch || process.arch;

  /** @type {import('node:child_process').ChildProcess|null} */
  let kind = null;
  let zustandName = ZUSTAND.fehlt;
  let grund = null;
  let gewaehlt = null; // der gelesene Eintrag
  let port = null;
  let baseUrl = null;
  let seit = null;
  let bereitVersprechen = null;
  let notbremse = null;
  /** @type {string[]} */
  let ausgabe = [];
  let ausgabeBytes = 0;
  let ausgabeRest = '';

  function merkeAusgabe(text) {
    if (ausgabeBytes > AUSGABE_BYTES) return;
    ausgabeBytes += Buffer.byteLength(text);
    const zeilen = (ausgabeRest + text).split(/\r?\n/);
    ausgabeRest = zeilen.pop() || '';
    for (const zeile of zeilen) {
      const z = zeile.trimEnd();
      if (!z) continue;
      ausgabe.push(z.length > 400 ? `${z.slice(0, 400)}…` : z);
      if (ausgabe.length > AUSGABE_ZEILEN) ausgabe.shift();
    }
  }

  /** Was noch im Puffer steht, gehoert zur Ausgabe -- gerade die letzte Zeile. */
  function ausgabeAbschliessen() {
    if (ausgabeRest.trim()) {
      ausgabe.push(ausgabeRest.trim());
      if (ausgabe.length > AUSGABE_ZEILEN) ausgabe.shift();
    }
    ausgabeRest = '';
  }

  function scheitern(satz) {
    zustandName = ZUSTAND.gescheitert;
    grund = satz;
    log.error(satz.split('\n')[0]);
    if (audit && typeof audit.write === 'function') {
      audit.write('stick.modell.gescheitert', { grund: satz.slice(0, 500) });
    }
    return zustand();
  }

  /* ------------------------------------------------- Beschreibungsdatei -- */

  /**
   * Liest `models/modelle.json` und waehlt den Eintrag fuer diesen Rechner.
   * @returns {{eintrag:object}|{fehlt:true, grund:string}|{fehler:string}}
   */
  function beschreibungLesen() {
    const datei = path.join(wurzel, BESCHREIBUNG);
    let roh;
    try {
      const stat = fs.statSync(datei);
      if (stat.size > MAX_BESCHREIBUNG_BYTES) {
        return { fehler: `${BESCHREIBUNG} ist ${stat.size} Byte groß — das ist keine Beschreibungsdatei, sie wird nicht gelesen.` };
      }
      roh = fs.readFileSync(datei, 'utf8');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return { fehlt: true, grund: `Auf dem Datenträger liegt keine ${BESCHREIBUNG} — also auch kein mitgelieferter Laufzeitkern.` };
      }
      return { fehler: `${BESCHREIBUNG} ist nicht lesbar: ${(err && err.message) || String(err)}` };
    }

    let inhalt;
    try {
      inhalt = JSON.parse(roh);
    } catch (err) {
      return { fehler: `${BESCHREIBUNG} ist kein gültiges JSON (${(err && err.message) || 'Lesefehler'}). Ohne sie wird kein Programm gestartet — geraten wird hier nicht.` };
    }

    const liste = alsListe(inhalt);
    if (!liste) {
      return {
        fehler: `${BESCHREIBUNG} ist gültiges JSON, aber ich erkenne darin keine Liste von Laufzeitkernen. `
          + 'Erwartet wird ein Feld "eintraege" (so schreibt es der Stick selbst) oder "modelle"/"models" mit '
          + 'Einträgen, die entweder "dateien": [{"ziel": …}] oder kurz "programm"/"bin"/"exe" nennen.',
      };
    }
    if (!liste.length) {
      return { fehlt: true, grund: `${BESCHREIBUNG} ist da, enthält aber keinen Eintrag.` };
    }

    // Der Ordner, gegen den alle relativen Pfade der Datei gelten: models/.
    // Genau so schreibt src/portable/model.js seine `dateien[].ziel`.
    const basis = path.dirname(path.join(wurzel, BESCHREIBUNG));

    // Erst die Gewichte einsammeln, dann die Kerne: ein llama-server ohne
    // Modelldatei startet zwar, kann aber nichts. Beides steht in derselben
    // Liste, nur mit verschiedener `rolle` -- die Zuordnung muss also
    // stattfinden, bevor ueber einen Kern entschieden wird.
    const gewichte = liste.filter((e) => e && typeof e === 'object' && rolleVon(e) === 'gewichte');

    const verworfen = [];
    for (const [i, eintrag] of liste.entries()) {
      if (!eintrag || typeof eintrag !== 'object') {
        verworfen.push(`Eintrag ${i + 1} ist kein Objekt.`);
        continue;
      }
      const name = String(feld(eintrag, FELD_NAME) || `Eintrag ${i + 1}`);
      if (rolleVon(eintrag) === 'gewichte') continue; // kein Programm, nichts zu starten
      if (eintrag.enabled === false || eintrag.aktiv === false) {
        verworfen.push(`"${name}" ist in der Datei ausgeschaltet.`);
        continue;
      }
      if (!plattformPasst(feld(eintrag, FELD_PLATTFORM), dieseP, dieseA)) {
        const gewuenscht = Array.isArray(feld(eintrag, FELD_PLATTFORM))
          ? feld(eintrag, FELD_PLATTFORM).join(', ') : String(feld(eintrag, FELD_PLATTFORM));
        verworfen.push(`"${name}" ist für ${gewuenscht} gebaut, nicht für ${dieseP}-${dieseA} gedacht. `
          + 'Ein Programm für ein anderes Betriebssystem startet hier nicht — daran ändert keine Dateikopie etwas.');
        continue;
      }

      const p = programmPfad(eintrag, name, basis);
      if (p.fehler) {
        verworfen.push(p.fehler);
        continue;
      }
      const art = artErkennen(feld(eintrag, FELD_ART), p.pfad);
      if (!art) {
        verworfen.push(`Bei "${name}" ist nicht erkennbar, welche Schnittstelle der Kern spricht. `
          + 'Erwartet wird "art"/"kern": "llama.cpp" (OpenAI-Dialekt) oder "ollama".');
        continue;
      }

      // Wo die Gewichte liegen, hängt an der Art: llama-server bekommt eine
      // Datei mit -m, Ollama einen Ordner über OLLAMA_MODELS.
      const gefunden = art === 'ollama'
        ? ollamaSpeicher(basis)
        : modellDatei(eintrag, name, basis, gewichte);
      if (gefunden.fehler) {
        verworfen.push(gefunden.fehler);
        continue;
      }

      return {
        eintrag: {
          name,
          art,
          programm: p.pfad,
          modell: gefunden.modell || null,
          modellOrdner: gefunden.ordner || null,
          args: alsArgumente(feld(eintrag, FELD_ARGS)),
          umgebung: eintrag.env && typeof eintrag.env === 'object' ? eintrag.env : null,
          modellName: gefunden.modellName || name,
        },
      };
    }

    if (!verworfen.length) {
      return { fehlt: true, grund: `In ${BESCHREIBUNG} stehen nur Modelldateien, aber kein Laufzeitkern, der sie öffnen könnte.` };
    }
    return {
      fehler: `In ${BESCHREIBUNG} steht kein Laufzeitkern, der hier benutzbar wäre:\n`
        + verworfen.map((z) => `  - ${z}`).join('\n'),
    };
  }

  /**
   * Welche Rolle hat dieser Eintrag: Programm oder Gewichte?
   *
   * src/portable/model.js schreibt `rolle: 'kern'` bzw. `rolle: 'modell'`.
   * Fehlt das Feld (handgeschriebene Datei), entscheidet, ob ein Programm
   * benannt ist — ein Eintrag ohne Programm ist nichts, was man starten kann.
   */
  function rolleVon(eintrag) {
    const roh = feld(eintrag, ['rolle', 'role']);
    if (typeof roh === 'string') {
      const r = roh.trim().toLowerCase();
      if (r === 'kern' || r === 'runtime' || r === 'programm' || r === 'server') return 'kern';
      if (r === 'modell' || r === 'model' || r === 'gewichte' || r === 'weights') return 'gewichte';
    }
    return feld(eintrag, FELD_PROGRAMM) !== undefined ? 'kern' : 'gewichte';
  }

  /** Alle Dateien eines Eintrags als Pfade unter models/, in Dateireihenfolge. */
  function dateienVon(eintrag, nurArt) {
    const roh = feld(eintrag, ['dateien', 'files']);
    if (!Array.isArray(roh)) return [];
    return roh
      .filter((d) => d && typeof d === 'object' && typeof (d.ziel || d.pfad || d.path) === 'string')
      .filter((d) => !nurArt || !d.art || d.art === nurArt)
      .map((d) => String(d.ziel || d.pfad || d.path));
  }

  /**
   * Der Pfad des Programms.
   *
   * Zwei Schreibweisen, beide echt: die von `src/portable/model.js`
   * geschriebene (`dateien: [{ziel: "kern/linux-x64/llama-server"}]`) und die
   * kurze, die ein Mensch von Hand hinschreibt (`"programm": "llama-server"`).
   */
  function programmPfad(eintrag, name, basis) {
    const kandidaten = [];
    const kurz = feld(eintrag, FELD_PROGRAMM);
    if (typeof kurz === 'string') kandidaten.push(kurz);
    kandidaten.push(...dateienVon(eintrag, 'programm'));
    if (!kandidaten.length) kandidaten.push(...dateienVon(eintrag));
    if (!kandidaten.length) {
      return {
        fehler: `Bei "${name}" steht nicht, welches Programm gestartet werden soll `
          + '(erwartet: "programm"/"bin"/"exe" oder eine Liste "dateien" mit "ziel").',
      };
    }
    // Mehrere Dateien: die ausfuehrbare ist die ohne Endung bzw. die erste.
    // Geraten wird dabei nichts -- existiert keine davon, sagt der Satz das.
    const fehlend = [];
    for (const kandidat of kandidaten) {
      const p = pfadImStick(kandidat, basis, wurzel, `"${name}"`);
      if (p.fehler) return p;
      if (fs.existsSync(p.pfad)) return p;
      fehlend.push(p.pfad);
    }
    return {
      fehler: `"${name}" verweist auf ${fehlend.join(' bzw. ')} — diese Datei liegt nicht auf dem Datenträger.`,
    };
  }

  /**
   * Die Modelldatei fuer einen llama-server.
   *
   * Sie steht in aller Regel NICHT beim Kern, sondern als eigener Eintrag mit
   * `rolle: "modell"` in derselben Liste -- so legt src/portable/model.js sie
   * an. Ohne Gewichte wird hier nichts gestartet: ein Kern, der laeuft und
   * kein Modell hat, sieht von aussen aus wie ein kaputtes Neural OS.
   */
  function modellDatei(eintrag, name, basis, gewichte) {
    const kurz = feld(eintrag, FELD_MODELL);
    if (typeof kurz === 'string') {
      const m = pfadImStick(kurz, basis, wurzel, `die Modelldatei von "${name}"`);
      if (m.fehler) return m;
      if (!fs.existsSync(m.pfad)) {
        return { fehler: `Die Modelldatei von "${name}" (${m.pfad}) liegt nicht auf dem Datenträger.` };
      }
      return { modell: m.pfad, modellName: path.basename(m.pfad) };
    }

    const fehlend = [];
    for (const kandidat of gewichte) {
      // Ollama-Gewichte sind inhaltsadressierte Blobs; llama-server kann mit
      // ihnen nichts anfangen, sie gehoeren zu einem Ollama-Kern.
      const dateien = dateienVon(kandidat).filter((z) => !z.startsWith('ollama/'));
      // Ein mehrteiliges Modell wird ueber seinen ERSTEN Teil geoeffnet;
      // llama.cpp findet die uebrigen selbst.
      const sortiert = dateien.filter((z) => /\.gguf$/i.test(z)).sort();
      if (!sortiert.length) continue;
      const m = pfadImStick(sortiert[0], basis, wurzel, `die Modelldatei von "${name}"`);
      if (m.fehler) return m;
      if (!fs.existsSync(m.pfad)) {
        fehlend.push(m.pfad);
        continue;
      }
      const gName = String(feld(kandidat, FELD_NAME) || path.basename(m.pfad));
      if (gewichte.length > 1) {
        log.info(`Mehrere Modelle auf dem Datenträger — "${gName}" ist das erste und wird geöffnet.`);
      }
      return { modell: m.pfad, modellName: gName };
    }

    return {
      fehler: `"${name}" ist da, aber es liegt keine Modelldatei (.gguf) dabei, die er öffnen könnte`
        + (fehlend.length ? `; beschrieben ist ${fehlend.join(', ')}, dort liegt aber nichts` : '')
        + '. Ein Laufzeitkern ohne Gewichte kann nicht antworten.',
    };
  }

  /**
   * Der Ollama-Speicher auf dem Datentraeger.
   *
   * Ohne ihn duerfte der mitgebrachte Ollama NICHT starten: er faende sonst
   * den Speicher des FREMDEN Rechners, und aus "die KI auf meinem Stick"
   * wuerde unbemerkt "die Modelle von jemand anderem".
   */
  function ollamaSpeicher(basis) {
    const ordner = path.join(basis, 'ollama');
    if (!fs.existsSync(ordner)) {
      return {
        fehler: 'Für Ollama liegt auf dem Datenträger kein Modellspeicher (models/ollama). '
          + 'Ohne ihn würde Ollama die Modelle des fremden Rechners benutzen — das wäre nicht mehr die KI vom Stick.',
      };
    }
    return { ordner, modellName: 'Ollama-Speicher vom Stick' };
  }

  /* ---------------------------------------------------------- Aufrufzeile */

  /**
   * Baut Argumente und Umgebung. Der Port kommt IMMER von uns: ein Kern, der
   * auf einem anderen Port lauscht als dem, den der Chat anspricht, ist
   * dasselbe wie kein Kern -- nur schwerer zu finden.
   */
  function aufruf(eintrag, gewaehlterPort) {
    const platzhalter = {
      '{port}': String(gewaehlterPort),
      '{PORT}': String(gewaehlterPort),
      '{host}': HOST,
      '{HOST}': HOST,
      '{modell}': eintrag.modell || '',
      '{model}': eintrag.modell || '',
    };
    let hatPort = false;
    const args = eintrag.args.map((a) => {
      let s = a;
      for (const [k, v] of Object.entries(platzhalter)) {
        if (s.includes(k)) {
          if (k === '{port}' || k === '{PORT}') hatPort = true;
          s = s.split(k).join(v);
        }
      }
      return s;
    });

    const env = { ...process.env, ...(eintrag.umgebung || {}) };

    if (eintrag.art === 'ollama') {
      // Ollama nimmt Adresse und Port nicht ueber Argumente, sondern ueber
      // OLLAMA_HOST -- und zwar auch dann, wenn schon ein anderes Ollama auf
      // 11434 laeuft. Unser Wert steht nach dem aus der Datei, gewinnt also.
      env.OLLAMA_HOST = `${HOST}:${gewaehlterPort}`;
      // Und er liest NUR vom Datentraeger. Ohne diese Zeile griffe ein
      // mitgebrachtes Ollama auf den Modellspeicher des fremden Rechners zu.
      if (eintrag.modellOrdner) env.OLLAMA_MODELS = eintrag.modellOrdner;
      if (!args.length) args.push('serve');
      return { args, env };
    }

    // llama-server und Verwandte: --host/--port hinten anhaengen, damit unsere
    // Angabe eine aus der Beschreibungsdatei ueberschreibt (letztes Vorkommen
    // gewinnt bei llama.cpp).
    if (eintrag.modell && !args.some((a) => a === '-m' || a === '--model')) {
      args.push('-m', eintrag.modell);
    }
    if (!hatPort) args.push('--host', HOST, '--port', String(gewaehlterPort));
    return { args, env };
  }

  function adresseFuer(art, gewaehlterPort) {
    return art === 'ollama'
      ? `http://${HOST}:${gewaehlterPort}`
      : `http://${HOST}:${gewaehlterPort}/v1`;
  }

  /** Der Pfad, an dem gemessen wird, ob die Schnittstelle antwortet. */
  function bereitschaftsAdresse(art, adresse) {
    return art === 'ollama' ? `${adresse}/api/tags` : `${adresse}/models`;
  }

  /* -------------------------------------------------------- Bereitschaft */

  /**
   * Ein einzelner Messversuch.
   *
   * Bewusst durch `gate.fetch`: damit ist im Prüfprotokoll belegt, dass die
   * Netzschleuse 127.0.0.1 durchlässt und der Kern vom Stick KEIN
   * Netzwerkzugriff ist. Ohne Schleuse (Unittest) direkt über http.
   */
  async function messen(url, timeoutMs) {
    if (gate && typeof gate.fetch === 'function') {
      const res = await gate.fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        scope: SCOPE,
        purpose: 'Antwortet der Laufzeitkern vom Datenträger schon?',
        timeoutMs,
      });
      return res && typeof res.status === 'number' ? res.status : 0;
    }
    return new Promise((resolve, reject) => {
      const req = require('node:http').get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      });
      req.on('timeout', () => { req.destroy(new Error('Zeitüberschreitung')); });
      req.on('error', reject);
    });
  }

  /**
   * Wartet, bis die Schnittstelle antwortet, der Kern stirbt oder die Frist
   * abläuft. Wirft nie; setzt den Zustand.
   */
  async function aufBereitschaftWarten(eintrag, url, timeoutMs) {
    const ende = Date.now() + timeoutMs;
    let pause = POLL_START_MS;
    let letzterFehler = null;
    while (Date.now() < ende) {
      if (!kind || kind.exitCode !== null || kind.signalCode !== null) {
        // Gestorben: der Grund steht schon in `zustandName`, gesetzt vom
        // 'exit'-Horcher. Hier nur nicht weiter messen.
        return zustand();
      }
      try {
        const status = await messen(url, Math.min(2000, Math.max(250, ende - Date.now())));
        // 2xx/3xx heisst: da antwortet etwas. 503 heisst bei llama.cpp
        // "Modell laedt noch" -- das ist genau der Fall, fuer den gewartet wird.
        if (status >= 200 && status < 400) {
          zustandName = ZUSTAND.laeuft;
          grund = null;
          log.info(`Laufzeitkern vom Datenträger ist bereit: ${eintrag.name} auf ${baseUrl}`);
          if (audit && typeof audit.write === 'function') {
            audit.write('stick.modell.bereit', { name: eintrag.name, art: eintrag.art, port, pid: kind && kind.pid });
          }
          return zustand();
        }
        letzterFehler = `HTTP ${status}`;
      } catch (err) {
        letzterFehler = (err && err.message) || String(err);
      }
      await new Promise((r) => setTimeout(r, pause).unref());
      // Schnell am Anfang, dann traege: jede Messung ist eine Entscheidung der
      // Netzschleuse und landet im Pruefprotokoll. 90 Sekunden im Sekundentakt
      // waeren 90 Zeilen Rauschen fuer einen einzigen Startvorgang.
      pause = Math.min(POLL_MAX_MS, Math.round(pause * 1.6));
    }
    if (zustandName === ZUSTAND.gescheitert) return zustand();
    ausgabeAbschliessen();
    return scheitern(
      `Der Laufzeitkern "${eintrag.name}" läuft als Prozess, antwortet aber nach ${Math.round(timeoutMs / 1000)} Sekunden `
      + `immer noch nicht unter ${url} (zuletzt: ${letzterFehler || 'keine Antwort'}). `
      + 'Entweder braucht er länger, als hier gewartet wird, oder er lauscht auf einer anderen Adresse.'
      + (ausgabe.length ? `\nLetzte Zeilen seiner Fehlerausgabe:\n${ausgabe.map((z) => `  | ${z}`).join('\n')}` : ''),
    );
  }

  /* ------------------------------------------------------------- Starten */

  function notbremseAnbringen(pid) {
    // Nur SIGKILL, und nur synchron: in einem 'exit'-Horcher laeuft nichts
    // Asynchrones mehr. Ein Kern, der 4 GB haelt, ist der groessere Schaden
    // als ein Kern, der nicht geordnet beenden durfte.
    if (!pid) return; // spawn ist gescheitert; es gibt nichts abzuraeumen
    notbremse = () => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* schon weg */ }
    };
    process.once('exit', notbremse);
  }

  function notbremseLoesen() {
    if (notbremse) {
      process.removeListener('exit', notbremse);
      notbremse = null;
    }
  }

  /** Einen Versuch: Prozess starten. Liefert null bei Erfolg, sonst den Satz. */
  function prozessStarten(eintrag, gewaehlterPort) {
    const { args, env } = aufruf(eintrag, gewaehlterPort);
    let prozess;
    try {
      prozess = spawn(eintrag.programm, args, {
        cwd: path.dirname(eintrag.programm),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Bewusst NICHT detached: der Kern soll in derselben Prozessgruppe
        // haengen, damit ein Strg-C im Terminal ihn mitnimmt.
        detached: false,
        windowsHide: true,
      });
    } catch (err) {
      return startFehlerSatz(err, eintrag.programm);
    }
    kind = prozess;
    ausgabe = [];
    ausgabeBytes = 0;
    ausgabeRest = '';
    if (prozess.stderr) prozess.stderr.on('data', (c) => merkeAusgabe(String(c)));
    // stdout gehoert dazu: llama-server schreibt seinen Ladefortschritt und
    // manche Fehler dorthin, nicht nach stderr.
    if (prozess.stdout) prozess.stdout.on('data', (c) => merkeAusgabe(String(c)));
    return null;
  }

  /**
   * Startet den mitgelieferten Kern.
   *
   * Wirft nie: eine Anwendung, die wegen eines fehlenden Modells nicht
   * hochfährt, ist schlimmer als eine Anwendung ohne Modell.
   *
   * @param {{timeoutMs?:number, warten?:boolean}} [opts]
   *   `warten:true` wartet auf die gemessene Bereitschaft. Voreingestellt ist
   *   `false`: der Start des Kerns darf den Start von Neural OS nicht
   *   aufhalten, ein 4-GB-Modell lädt auf einem Stick auch mal eine Minute.
   * @returns {Promise<object>} der Zustand
   */
  async function starten(opts = {}) {
    if (kind) return zustand();
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Number(opts.timeoutMs) : START_TIMEOUT_MS;

    const gelesen = beschreibungLesen();
    if (gelesen.fehlt) {
      zustandName = ZUSTAND.fehlt;
      grund = gelesen.grund;
      log.debug(gelesen.grund);
      return zustand();
    }
    if (gelesen.fehler) return scheitern(gelesen.fehler);
    gewaehlt = gelesen.eintrag;

    let letzterSatz = null;
    for (let versuch = 0; versuch < PORT_VERSUCHE; versuch++) {
      let kandidat;
      try {
        kandidat = await freierPort();
      } catch (err) {
        return scheitern(`Es war kein freier Port auf ${HOST} zu bekommen: ${(err && err.message) || String(err)}`);
      }
      const satz = prozessStarten(gewaehlt, kandidat);
      if (satz) return scheitern(satz);

      port = kandidat;
      baseUrl = adresseFuer(gewaehlt.art, kandidat);
      seit = new Date().toISOString();
      zustandName = ZUSTAND.startet;
      grund = null;
      notbremseAnbringen(kind.pid);

      const prozess = kind;
      let frueherTod = null;
      const gestorben = new Promise((resolve) => {
        prozess.once('error', (err) => {
          // Ein spawn-Fehler kommt auf POSIX asynchron, nicht als Wurf -- und
          // danach kommt KEIN 'exit' mehr. Das Aufraeumen muss deshalb hier
          // stehen: sonst bliebe die Notbremse mit einer toten PID haengen,
          // und nach zehn Fehlstarts warnt Node ueber zu viele Horcher.
          if (kind !== prozess) return resolve(null);
          ausgabeAbschliessen();
          notbremseLoesen();
          kind = null;
          frueherTod = { art: 'spawn', satz: startFehlerSatz(err, gewaehlt.programm) };
          scheitern(frueherTod.satz);
          resolve(frueherTod);
        });
        prozess.once('exit', (code, signal) => {
          if (kind !== prozess) return resolve(null);
          ausgabeAbschliessen();
          notbremseLoesen();
          kind = null;
          if (zustandName === ZUSTAND.laeuft || zustandName === ZUSTAND.startet) {
            frueherTod = {
              art: 'exit',
              code,
              signal,
              satz: todesSatz({ code, signal, programm: gewaehlt.programm, ausgabe }),
            };
            scheitern(frueherTod.satz);
          }
          resolve(frueherTod);
        });
      });

      // Ein belegter Port zeigt sich erst, wenn der Kern daran scheitert.
      // Genau dafuer ist die Schleife da: einmal neu wuerfeln, nicht aufgeben.
      const kurzTot = await Promise.race([
        gestorben,
        new Promise((r) => setTimeout(() => r(null), 400).unref()),
      ]);
      if (kurzTot && kurzTot.art === 'exit' && portBelegt(ausgabe) && versuch < PORT_VERSUCHE - 1) {
        letzterSatz = kurzTot.satz;
        log.warn(`Port ${kandidat} war belegt, als der Kern ihn nehmen wollte — nächster Versuch.`);
        zustandName = ZUSTAND.startet;
        grund = null;
        continue;
      }
      if (kurzTot) return zustand();

      log.info(`Laufzeitkern vom Datenträger gestartet: ${gewaehlt.name} (PID ${prozess.pid}) auf ${baseUrl}`);
      if (audit && typeof audit.write === 'function') {
        audit.write('stick.modell.start', { name: gewaehlt.name, art: gewaehlt.art, programm: gewaehlt.programm, port, pid: prozess.pid });
      }
      const url = bereitschaftsAdresse(gewaehlt.art, baseUrl);
      bereitVersprechen = aufBereitschaftWarten(gewaehlt, url, timeoutMs)
        .catch((err) => scheitern(`Die Bereitschaftsmessung ist selbst gescheitert: ${asNeuralError(err).message}`));
      if (opts.warten === true) await bereitVersprechen;
      return zustand();
    }
    return scheitern(letzterSatz || `Auf ${HOST} war nach ${PORT_VERSUCHE} Versuchen kein freier Port zu halten.`);
  }

  /** Sieht die Ausgabe nach einem belegten Port aus? */
  function portBelegt(zeilen) {
    return (zeilen || []).some((z) => /EADDRINUSE|address already in use|bind.*(in use|failed)/i.test(z));
  }

  /**
   * Wartet auf das Ergebnis der Bereitschaftsmessung.
   * @returns {Promise<object>} der Zustand danach
   */
  async function bereit() {
    if (bereitVersprechen) await bereitVersprechen;
    return zustand();
  }

  /* ------------------------------------------------------------- Stoppen */

  /**
   * SIGTERM, nach Frist SIGKILL. Wirft nie.
   * @param {{fristMs?:number}} [opts]
   */
  async function stoppen(opts = {}) {
    const fristMs = Number.isFinite(opts.fristMs) && opts.fristMs >= 0 ? Number(opts.fristMs) : FRIST_SIGTERM_MS;
    const prozess = kind;
    if (!prozess) {
      notbremseLoesen();
      return { gestoppt: false, grund: 'Es lief kein Laufzeitkern vom Datenträger.' };
    }
    kind = null; // ab hier ist sein 'exit' kein Scheitern mehr, sondern erwartet
    const pid = prozess.pid;

    const beendet = new Promise((resolve) => {
      if (prozess.exitCode !== null || prozess.signalCode !== null) return resolve({ code: prozess.exitCode, signal: prozess.signalCode });
      prozess.once('exit', (code, signal) => resolve({ code, signal }));
    });

    let hart = false;
    try { prozess.kill('SIGTERM'); } catch { /* schon weg */ }
    let ergebnis = await Promise.race([
      beendet,
      new Promise((r) => setTimeout(() => r(null), fristMs).unref()),
    ]);
    if (!ergebnis) {
      hart = true;
      log.warn(`Der Laufzeitkern (PID ${pid}) hat auf SIGTERM nicht reagiert — SIGKILL.`);
      try { prozess.kill('SIGKILL'); } catch { /* schon weg */ }
      ergebnis = await Promise.race([
        beendet,
        new Promise((r) => setTimeout(() => r(null), FRIST_SIGKILL_MS).unref()),
      ]);
    }
    notbremseLoesen();
    ausgabeAbschliessen();

    const wirklichWeg = !!ergebnis || !lebt(pid);
    zustandName = ZUSTAND.fehlt;
    grund = wirklichWeg
      ? 'Der Laufzeitkern vom Datenträger wurde beim Beenden abgeräumt.'
      : `Der Laufzeitkern (PID ${pid}) ließ sich auch mit SIGKILL nicht beenden.`;
    baseUrl = null;
    port = null;
    bereitVersprechen = null;
    if (audit && typeof audit.write === 'function') {
      audit.write('stick.modell.stopp', { pid, hart, weg: wirklichWeg });
    }
    if (!wirklichWeg) log.error(grund);
    return { gestoppt: wirklichWeg, hart, pid, code: ergebnis && ergebnis.code, signal: ergebnis && ergebnis.signal };
  }

  /** Lebt dieser Prozess noch? Signal 0 fragt, ohne etwas zu schicken. */
  function lebt(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return !!(err && err.code === 'EPERM');
    }
  }

  /* ------------------------------------------------------------- Zustand */

  /**
   * Die Selbstauskunft. Vier Zustaende, nie vermischt:
   *   'laeuft'          — Prozess da UND Schnittstelle hat geantwortet
   *   'startet'         — Prozess da, Schnittstelle noch stumm
   *   'gescheitert'     — mit Grund (und, wenn vorhanden, seiner Fehlerausgabe)
   *   'nicht-vorhanden' — kein Kern auf dem Datenträger (kein Fehler)
   */
  function zustand() {
    return {
      zustand: zustandName,
      grund,
      name: gewaehlt ? gewaehlt.name : null,
      art: gewaehlt ? gewaehlt.art : null,
      modellName: gewaehlt ? gewaehlt.modellName : null,
      programm: gewaehlt ? gewaehlt.programm : null,
      baseUrl,
      port,
      pid: kind ? kind.pid : null,
      seit,
      wurzel,
      vomStick: true,
      ausgabe: ausgabe.slice(-AUSGABE_ZEILEN),
    };
  }

  return {
    beschreibungLesen,
    starten,
    bereit,
    stoppen,
    zustand,
    /** Liegt auf diesem Datenträger überhaupt eine Beschreibungsdatei? */
    vorhanden() {
      return fs.existsSync(path.join(wurzel, BESCHREIBUNG));
    },
  };
}

module.exports = {
  createLocalRunner,
  BESCHREIBUNG,
  ZUSTAND,
  /** Nur für Tests: hier stecken die Entscheidungen, die schiefgehen können. */
  __internals: { artErkennen, plattformPasst, alsListe, alsArgumente, pfadImStick, startFehlerSatz, freierPort },
};
