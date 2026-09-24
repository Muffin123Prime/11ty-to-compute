'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ValidationError, StorageError } = require('./errors');
const { schreibeDauerhaft } = require('./dateien');

/**
 * Wer ist diese KI?
 *
 * Jeder Stick trägt genau eine KI: eine Kennung (`config.sync.deviceId`),
 * einen Namen (`config.sync.deviceName`) und, wenn sie portabel läuft, einen
 * eigenen Port. Der eigene Port ist kein Schmuck: Der Browser trennt Speicher,
 * Service Worker und offene Tabs nach Ursprung, und bei einem gemeinsamen
 * `127.0.0.1:7777` las Stick B den Entwurf von Stick A (belegt, v5).
 *
 * Die Kennung steht zusätzlich im Klartext im Marker neben `data/`. Dort
 * liest sie ein anderer Stick, ohne die PIN zu kennen (Paket K1), und dort
 * fällt auf, wenn jemand den Ordner `data/` auf einen anderen Stick kopiert
 * hat: Marker und Konfiguration nennen dann verschiedene KIs. Zwei Sticks mit
 * derselben Kennung würden sich beim Abgleich für ein und dasselbe Gerät
 * halten und nie etwas austauschen (belegt, p2a). Deshalb bekommt die Kopie
 * eine neue Identität und vergisst alles, was die alte über Partner wusste.
 */

/** Dasselbe Format wie in src/sync/folder.js und src/sync/peer.js. */
const KI_ID_RE = /^dev_[0-9a-f]{24}$/;

/** Der Port der Heim-Installation. Ein Stick, der ihn noch trägt, zieht um. */
const HEIM_PORT = 7777;

const NAME_MAX = 60;

/**
 * Was eine KI über Partner weiß. Nach einer Kopie gehört das der alten KI:
 * Behielte die neue es, gliche sie sich unter falschem Namen mit den Partnern
 * der alten ab.
 */
const PARTNER_DATEIEN = ['sync-folder.json', 'kopplungen.json'];

/**
 * Der Port einer KI, aus ihrer Kennung errechnet. So braucht der Starter
 * keine Absprache und jeder Stick hat an jedem Rechner dieselbe Adresse.
 * 20000–29999 liegt über allen Ports, die Browser sperren, und unter den
 * Bereichen, die Windows, macOS und Linux für ausgehende Verbindungen
 * vergeben (Bauplan 0.2; ob Hyper-V dort Lücken reißt, misst der Probelauf).
 * @param {string} id
 * @returns {number}
 */
function kiPort(id) {
  const hex = crypto.createHash('sha256').update(String(id)).digest('hex');
  return 20000 + (parseInt(hex.slice(0, 8), 16) % 10000);
}

/** Eine neue Kennung. Ausgelagert, damit Paket R sie beim Vorbereiten genauso bildet. */
function neueKiId() {
  return `dev_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Datenträgernamen, die das Betriebssystem oder der Hersteller vergibt.
 * Sie unterscheiden nichts ("USB" neben "USB"), also lieber "KI 3F2A".
 * Verglichen wird ohne Groß/Klein: Finder zeigt "Untitled", FAT speichert
 * "UNTITLED", und gemeint ist beide Male dasselbe.
 */
const GENERISCHE_NAMEN = new Set(['no name', 'untitled', 'usb', 'usb disk']);

/** Wo macOS und die üblichen Linux-Automounter Wechseldatenträger einhängen. */
const EINHAENGEPUNKTE = [
  /^\/Volumes\/([^/]+)(?:\/|$)/,
  /^\/media\/[^/]+\/([^/]+)(?:\/|$)/,
  /^\/run\/media\/[^/]+\/([^/]+)(?:\/|$)/,
];

/**
 * Der Name, den eine neue KI bekommt, solange niemand einen wählt.
 *
 * Am Mac und unter Linux steht der Datenträgername im Pfad; den hat der
 * Nutzer oft selbst vergeben ("LENA"), und er ist der Name, unter dem er den
 * Stick kennt. Unter Windows steht dort nur ein Laufwerksbuchstabe, und den
 * Namen zu erfragen bräuchte einen Kindprozess; dann eben "KI " und vier
 * Zeichen der Kennung.
 * @param {{root:string}|null} portable
 * @param {string} id
 * @returns {string}
 */
function standardName(portable, id) {
  const root = portable && typeof portable.root === 'string' ? portable.root : '';
  for (const muster of EINHAENGEPUNKTE) {
    const treffer = muster.exec(root);
    if (!treffer) continue;
    const name = treffer[1].trim();
    if (name && !GENERISCHE_NAMEN.has(name.toLowerCase())) return [...name].slice(0, NAME_MAX).join('');
    break;
  }
  return `KI ${String(id || '').slice(4, 8).toUpperCase()}`;
}

/**
 * Ein Name, wie er im Marker und in fremden Stick-Ansichten erscheint.
 * Gezählt werden Zeichen, nicht UTF-16-Einheiten: "Jörg" hat vier.
 * Steuerzeichen würden die einzeilige Anzeige zerreißen.
 */
function pruefeName(name) {
  if (typeof name !== 'string') throw new ValidationError('Der Name muss ein Text sein.');
  const sauber = name.trim();
  const laenge = [...sauber].length;
  if (laenge < 1 || laenge > NAME_MAX) throw new ValidationError(`Der Name muss 1 bis ${NAME_MAX} Zeichen lang sein.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(sauber)) throw new ValidationError('Der Name darf keine Zeilenumbrüche enthalten.');
  return sauber;
}

/**
 * @param {object} deps
 * @param {object} deps.config      die geladene Konfiguration; wird an Ort und Stelle geändert
 * @param {{home:string}} deps.paths
 * @param {{root:string, marker:string, info?:object}|null} [deps.portable] aus `paths.portableInfo`
 * @param {(config:object)=>void} deps.speichern schreibt die Konfiguration
 * @param {(name:string, payload:object)=>void} [deps.publish] meldet `ki.erneuert`
 * @param {{publish:Function}} [deps.bus] ersatzweise der Bus
 */
function createIdentitaet({ config, paths, portable = null, speichern, publish, bus } = {}) {
  if (!config || typeof config !== 'object') {
    throw new ValidationError('createIdentitaet braucht die Konfiguration (config).');
  }
  if (typeof speichern !== 'function') {
    throw new ValidationError('createIdentitaet braucht speichern(config), sonst hielte eine neue Kennung nur bis zum Neustart.');
  }
  if (!paths || typeof paths.home !== 'string' || !paths.home) {
    throw new ValidationError('createIdentitaet braucht paths.home; dort liegt der Abgleich-Stand.');
  }

  function sync() {
    if (!config.sync || typeof config.sync !== 'object') config.sync = {};
    return config.sync;
  }

  function melde(name, payload) {
    // Die Erneuerung ist dann schon gespeichert; eine kaputte Meldung darf
    // sie nicht nachträglich wie einen Fehlschlag aussehen lassen.
    try {
      if (typeof publish === 'function') publish(name, payload);
      else if (bus && typeof bus.publish === 'function') bus.publish(name, payload);
    } catch { /* siehe oben */ }
  }

  /**
   * Den Marker frisch lesen: `portable.info` stammt vom Programmstart, und
   * Paket R oder ein früheres `umbenennen` kann ihn seitdem geändert haben.
   * Ist er gerade nicht lesbar, gilt der Stand vom Start. Ohne einen gültigen
   * Marker wird nie geschrieben: Einer ohne `neuralOsPortable:true` machte
   * aus dem Stick beim nächsten Start eine Heim-Installation.
   */
  function leseMarker() {
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(portable.marker, 'utf8'));
    } catch {
      info = null;
    }
    if (info && typeof info === 'object' && !Array.isArray(info) && info.neuralOsPortable === true) return info;
    const vomStart = portable.info;
    if (vomStart && typeof vomStart === 'object' && vomStart.neuralOsPortable === true) return { ...vomStart };
    throw new StorageError('Die Markierungsdatei des Sticks ist nicht lesbar.', { marker: portable.marker });
  }

  /** Alle vorhandenen Felder bleiben, nur `kiId` und `name` werden gesetzt. */
  function schreibeMarker() {
    const info = leseMarker();
    info.kiId = sync().deviceId;
    info.name = sync().deviceName;
    // 0o644 wie bisher (stick.js schreibt ihn mit den Vorgaberechten): Der
    // Marker ist absichtlich kein Geheimnis, andere Sticks lesen ihn.
    schreibeDauerhaft(portable.marker, `${JSON.stringify(info, null, 2)}\n`, { modus: 0o644 });
    // Wer `portable` sonst noch hält (Banner, /api/status), sieht den neuen Stand.
    portable.info = info;
    return info;
  }

  const identitaet = {
    get id() {
      return config.sync && typeof config.sync === 'object' ? config.sync.deviceId : undefined;
    },
    get name() {
      return config.sync && typeof config.sync === 'object' ? config.sync.deviceName : undefined;
    },
    get port() {
      return config.server && typeof config.server === 'object' ? config.server.port : undefined;
    },

    /**
     * Kennung und Namen anlegen, falls sie fehlen, und einen Stick vom
     * Heim-Port 7777 auf seinen eigenen Port holen. Ein selbst gewählter Port
     * bleibt. Gespeichert wird nur, wenn sich etwas geändert hat: Jeder Start
     * schriebe sonst unnötig auf den Stick.
     * @returns {{id:string, name:string, port:number, geaendert:boolean}}
     */
    sicherstellen() {
      const s = sync();
      let geaendert = false;
      // Eine ungültige Kennung zählt als fehlend, genau wie in folder.js und
      // peer.js; sonst ersetzten die beiden sie still durch eine andere.
      if (typeof s.deviceId !== 'string' || !KI_ID_RE.test(s.deviceId)) {
        s.deviceId = neueKiId();
        geaendert = true;
      }
      if (typeof s.deviceName !== 'string' || !s.deviceName.trim()) {
        s.deviceName = standardName(portable, s.deviceId);
        geaendert = true;
      }
      if (portable && config.server && typeof config.server === 'object' && config.server.port === HEIM_PORT) {
        config.server.port = kiPort(s.deviceId);
        geaendert = true;
      }
      if (geaendert) speichern(config);
      return { id: identitaet.id, name: identitaet.name, port: identitaet.port, geaendert };
    },

    /**
     * Passen Marker und Konfiguration zusammen? Nur portabel; die
     * Heim-Installation hat keinen Marker.
     *  - Marker ohne `kiId`: ein Stick von vor diesem Umbau. Er bekommt die
     *    Kennung eingetragen, mehr nicht.
     *  - Marker mit anderer `kiId`: `data/` wurde von einem anderen Stick
     *    hierher kopiert -> neue Identität.
     * @returns {{aktion:'keine'|'eingetragen'|'erneuert', id:string}}
     */
    pruefeMarker() {
      if (!portable) return { aktion: 'keine', id: identitaet.id };
      // Ohne gültige eigene Kennung sähe jeder Marker nach einer Kopie aus.
      if (typeof identitaet.id !== 'string' || !KI_ID_RE.test(identitaet.id)) identitaet.sicherstellen();
      const marker = leseMarker();
      if (typeof marker.kiId !== 'string' || !marker.kiId) {
        schreibeMarker();
        return { aktion: 'eingetragen', id: identitaet.id };
      }
      if (marker.kiId !== identitaet.id) {
        const neu = identitaet.erneuern('daten-kopiert');
        return { aktion: 'erneuert', id: neu.id };
      }
      return { aktion: 'keine', id: identitaet.id };
    },

    /**
     * Eine neue Identität: neue Kennung, portabel ein neuer Port, und alles
     * vergessen, was die alte über Partner wusste. Der Name bleibt.
     *
     * Die Reihenfolge ist so gewählt, dass ein Abbruch an jeder Stelle beim
     * nächsten Start von selbst zu Ende geführt wird: Erst die Partner-Dateien
     * löschen, dann die Konfiguration, zuletzt den Marker. Solange der Marker
     * noch die alte Kennung trägt, erkennt `pruefeMarker` die Abweichung und
     * erneuert erneut.
     * @param {string} grund z. B. 'daten-kopiert', 'zwilling'
     * @returns {{id:string, alteId:string, port:number, grund:string}}
     */
    erneuern(grund) {
      const warum = typeof grund === 'string' && grund ? grund : 'unbekannt';
      for (const datei of PARTNER_DATEIEN) {
        const ziel = path.join(paths.home, datei);
        try {
          fs.rmSync(ziel, { force: true });
        } catch (err) {
          // Eine neue Kennung mit dem Partner-Wissen der alten wäre schlimmer
          // als die alte Kennung noch einen Start länger.
          throw new StorageError('Der alte Abgleich-Stand ließ sich nicht löschen.', { datei: ziel, code: err && err.code });
        }
      }

      const s = sync();
      const alteId = s.deviceId;
      const altePort = config.server && typeof config.server === 'object' ? config.server.port : undefined;
      let neu = neueKiId();
      while (neu === alteId) neu = neueKiId();
      s.deviceId = neu;
      if (portable && config.server && typeof config.server === 'object') config.server.port = kiPort(neu);
      try {
        speichern(config);
      } catch (err) {
        // Der laufende Prozess muss dieselbe KI sein wie die auf der Platte.
        s.deviceId = alteId;
        if (portable && config.server && typeof config.server === 'object') config.server.port = altePort;
        throw err;
      }
      if (portable) schreibeMarker();
      melde('ki.erneuert', { grund: warum });
      return { id: neu, alteId, port: identitaet.port, grund: warum };
    },

    /**
     * Den Namen dieser KI ändern (Einstellungen › "Name dieser KI"). Er steht
     * in der Konfiguration und, portabel, im Marker, damit ein anderer Stick
     * ihn ohne PIN anzeigen kann ("Anderer Stick: Lena").
     * @param {string} name 1..60 Zeichen, Leerraum am Rand zählt nicht
     * @returns {string} der gespeicherte Name
     */
    umbenennen(name) {
      const sauber = pruefeName(name);
      const s = sync();
      const vorher = s.deviceName;
      s.deviceName = sauber;
      try {
        speichern(config);
      } catch (err) {
        s.deviceName = vorher;
        throw err;
      }
      if (portable) schreibeMarker();
      return sauber;
    },
  };

  return identitaet;
}

module.exports = {
  kiPort,
  createIdentitaet,
  standardName,
  neueKiId,
  KI_ID_RE,
};
