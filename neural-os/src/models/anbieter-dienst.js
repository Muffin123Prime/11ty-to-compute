'use strict';

/**
 * Ein KI-Anbieter als Teilsystem: Schlüssel, Zustand, Modellwahl, Verbrauch.
 * Einmal geschrieben, zweimal benutzt -- für Claude (src/models/claude.js)
 * und Gemini (src/models/ki.js). Was die beiden unterscheidet, steht in
 * einem `profil`; was sie gemeinsam haben, steht hier.
 *
 * Warum diese Datei so gebaut ist
 * -------------------------------
 * - **Der Schlüssel liegt im Tresor**, nicht in config.json. config.json ist
 *   absichtlich unverschlüsselt (die Netzregeln müssen lesbar sein, bevor der
 *   Tresor offen ist) und darf deshalb kein Geheimnis tragen. Der Schlüssel
 *   steht in `vault/<anbieter>-schluessel.json`; ist der Tresor verschlüsselt,
 *   ist die Datei mit demselben Datenschlüssel versiegelt wie jeder Satz --
 *   dann reist er mit dem Stick und ist mit der PIN geschützt. Wird die
 *   Verschlüsselung erst später eingeschaltet, wird er beim nächsten Lesen
 *   nachversiegelt. In Sicherungen (export.json) steht er nie: die Sicherung
 *   liest Sätze, keine Dateien.
 * - **Er verlässt Neural OS nur im Kopf der Anfrage an den einen Host.**
 *   `zustand()` sagt `schluesselVorhanden`, nie den Schlüssel; keine
 *   Fehlermeldung und kein Protokolleintrag enthält ihn.
 * - **Gespeichert wird nur, was geprüft ist.** Ein Schlüssel, den ein kleiner
 *   Probeaufruf nicht bestätigt, landet nicht im Tresor. Kann gar nicht
 *   geprüft werden (offline), wird das gesagt -- und ebenfalls nichts
 *   gespeichert, denn "gespeichert, aber vielleicht falsch" wäre ein
 *   Zustand, den später niemand mehr erklären kann.
 * - **`zustand()` fragt nie das Netz.** Die Oberfläche fragt jede Minute;
 *   jede dieser Fragen als Aufruf beim Anbieter wäre Geld (Claude) oder ein
 *   Stück des Tageslimits (Gemini) und Protokollrauschen. "verbunden" heißt
 *   deshalb: Schlüssel da und geprüft, Tresor offen, die Schleuse ließe den
 *   Host gerade durch, und der letzte echte Aufruf ist nicht am Schlüssel
 *   gescheitert.
 * - **Verbrauch ist eine Schätzung** aus den `usage`-Angaben jeder Antwort
 *   und den Listenpreisen, und heißt auch so. Bei Gemini auf der kostenlosen
 *   Stufe sind die Kosten null; gezählt wird trotzdem.
 */

const fs = require('node:fs');
const path = require('node:path');

const { NeuralError, ValidationError, LockedError, asNeuralError } = require('../kernel/errors');

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

function leererVerbrauch() {
  return {
    seit: new Date().toISOString(),
    anfragen: 0,
    eingabeTokens: 0,
    ausgabeTokens: 0,
    cacheGelesen: 0,
    cacheGeschrieben: 0,
    suchen: 0,
    kostenUsd: 0,
  };
}

/**
 * @param {object} profil
 * @param {string} profil.id              'claude' | 'gemini' (Konfiguration, Ereignisse, Routen)
 * @param {string} profil.name            'Claude' | 'Gemini'
 * @param {string} profil.praefix         Fehlercodes: 'CLAUDE' | 'GEMINI'
 * @param {object} profil.modul           der Anbieter (src/models/providers/*)
 * @param {string} profil.schluesselDatei
 * @param {string} profil.verbrauchDatei
 * @param {object} profil.gruende         Satz je Grund (kein-schluessel, gesperrt, offline, gesperrtDurchSchleuse, schluessel-falsch)
 * @param {string} profil.anleitung
 * @param {string} profil.verbrauchHinweis
 * @param {Function} profil.schluesselPruefen  (roh) => string -- wirft ValidationError
 * @param {string} profil.sperrMuster     Teil des Hostnamens, der auf der Sperrliste zählt ('anthropic.com')
 * @param {object} deps                   {paths, config, gate, bus, vaultCrypto, logger, konfigSpeichern, basis, anbieter}
 */
function createAnbieterDienst(profil, deps = {}) {
  const { paths, config, gate, bus, vaultCrypto } = deps;
  if (!paths || typeof paths.vault !== 'string') throw new ValidationError(`create${profil.name} braucht paths.vault.`);
  if (!config || typeof config !== 'object') throw new ValidationError(`create${profil.name} braucht die Konfiguration.`);
  const log = typeof deps.logger === 'function' ? deps.logger(profil.id) : (deps.logger || nullLogger());
  const modul = profil.modul;
  /** Nur für Tests: ein anderer Anbieter (etwa mit Stellvertreter-Probe). */
  const api = deps.anbieter || modul;
  const basis = typeof deps.basis === 'string' && deps.basis ? deps.basis.replace(/\/+$/, '') : modul.API_BASIS;
  const host = new URL(basis).hostname;
  const schluesselPfad = path.join(paths.vault, profil.schluesselDatei);
  const verbrauchPfad = path.join(paths.vault, profil.verbrauchDatei);
  const GRUENDE = profil.gruende;
  const P = profil.praefix;

  /** undefined = noch nicht gelesen; null = keiner da. */
  let eintrag;
  /** Der letzte echte Aufruf ist am Schlüssel gescheitert. */
  let schluesselFalsch = false;
  let letzterFehler = null;
  let verbrauch = null;

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try { bus.publish(name, payload || {}); } catch (err) { log.warn(`bus.publish(${name}): ${err && err.message}`); }
  }

  /* -------------------------------------------------------- Tresor-Datei */

  function verschluesselt() {
    return !!(vaultCrypto && vaultCrypto.enabled);
  }

  function gesperrt() {
    return verschluesselt() && vaultCrypto.state !== 'unlocked';
  }

  function dateiSchreiben(daten) {
    const klar = Buffer.from(JSON.stringify(daten), 'utf8');
    const versiegelt = verschluesselt();
    const inhalt = versiegelt ? vaultCrypto.encryptBuffer(klar) : klar;
    const huelle = { v: 1, versiegelt, inhalt: inhalt.toString('base64') };
    fs.mkdirSync(paths.vault, { recursive: true, mode: 0o700 });
    const tmp = `${schluesselPfad}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(huelle), { mode: 0o600 });
    fs.renameSync(tmp, schluesselPfad);
  }

  function dateiLesen() {
    let roh;
    try {
      roh = fs.readFileSync(schluesselPfad, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    let huelle;
    try {
      huelle = JSON.parse(roh);
    } catch {
      log.warn(`Die Datei mit dem ${profil.name}-Schlüssel ist beschädigt und wird ignoriert.`);
      return null;
    }
    if (!huelle || typeof huelle.inhalt !== 'string') return null;
    let klar = Buffer.from(huelle.inhalt, 'base64');
    if (huelle.versiegelt) {
      if (!vaultCrypto) throw new LockedError(`Der ${profil.name}-Schlüssel ist versiegelt, aber die Tresor-Verschlüsselung fehlt.`);
      klar = vaultCrypto.decryptBuffer(klar);
    }
    const daten = JSON.parse(klar.toString('utf8'));
    if (!daten || typeof daten.schluessel !== 'string' || !daten.schluessel) return null;
    // Später eingeschaltete Verschlüsselung: jetzt nachversiegeln, statt den
    // Schlüssel neben einem verschlüsselten Tresor im Klartext liegen zu lassen.
    if (!huelle.versiegelt && verschluesselt() && !gesperrt()) {
      try {
        dateiSchreiben(daten);
      } catch (err) {
        log.warn(`${profil.name}-Schlüssel konnte nicht nachversiegelt werden: ${err && err.message}`);
      }
    }
    return daten;
  }

  /** Den Eintrag lesen. Wirft LockedError, wenn der Tresor gesperrt ist. */
  function lesen() {
    if (eintrag !== undefined && eintrag !== null) return eintrag;
    if (!fs.existsSync(schluesselPfad)) {
      eintrag = null;
      return null;
    }
    if (gesperrt()) {
      throw new LockedError(`Der Tresor ist gesperrt; der ${profil.name}-Schlüssel ist darin versiegelt.`);
    }
    eintrag = dateiLesen();
    return eintrag;
  }

  function vorhanden() {
    if (eintrag) return true;
    return fs.existsSync(schluesselPfad);
  }

  /* ------------------------------------------------------------ Verbrauch */

  function verbrauchLesen() {
    if (verbrauch) return verbrauch;
    try {
      const j = JSON.parse(fs.readFileSync(verbrauchPfad, 'utf8'));
      verbrauch = { ...leererVerbrauch(), ...(j && typeof j === 'object' ? j : {}) };
    } catch {
      verbrauch = leererVerbrauch();
    }
    return verbrauch;
  }

  function verbrauchAddieren(modell, usage) {
    if (!usage || typeof usage !== 'object') return;
    const v = verbrauchLesen();
    const n = (x) => (Number.isFinite(x) ? x : 0);
    v.anfragen += 1;
    v.eingabeTokens += n(usage.input_tokens);
    v.ausgabeTokens += n(usage.output_tokens);
    v.cacheGelesen += n(usage.cache_read_input_tokens);
    v.cacheGeschrieben += n(usage.cache_creation_input_tokens);
    v.suchen += n(usage.server_tool_use && usage.server_tool_use.web_search_requests);
    v.kostenUsd = Math.round((v.kostenUsd + api.kostenSchaetzen(modell, usage)) * 1e6) / 1e6;
    try {
      fs.mkdirSync(paths.vault, { recursive: true, mode: 0o700 });
      fs.writeFileSync(verbrauchPfad, JSON.stringify(v), { mode: 0o600 });
    } catch (err) {
      log.warn(`Verbrauch konnte nicht gespeichert werden: ${err && err.message}`);
    }
  }

  /* ---------------------------------------------------------- Zustand */

  function modell() {
    const m = config[profil.id] && config[profil.id].modell;
    return modul.istModell(m) ? m : modul.STANDARD_MODELL;
  }

  /** Was die Schleuse JETZT für den Host entscheiden würde -- ohne DNS, ohne Protokolleintrag. */
  function netz() {
    const modus = gate && gate.mode ? gate.mode : ((config.network && config.network.mode) || 'offline');
    if (!gate || typeof gate.check !== 'function') return { modus, erlaubt: false, grund: 'Die Netzschleuse fehlt.' };
    try {
      const d = gate.check({ host, port: 443, scope: 'global', purpose: `Anzeige: Wäre ${profil.name} erreichbar?`, record: false });
      return { modus, erlaubt: d.allowed === true, grund: d.reason || '' };
    } catch (err) {
      return { modus, erlaubt: false, grund: asNeuralError(err).message };
    }
  }

  /**
   * Der Zustand, wie die Routen ihn liefern. Fragt nie das Netz.
   * @returns {object}
   */
  function zustand() {
    let schluesselVorhanden = false;
    let istGesperrt = false;
    let geprueftAm = null;
    try {
      const e = lesen();
      schluesselVorhanden = !!e;
      geprueftAm = e ? e.geprueftAm || null : null;
    } catch (err) {
      if (err && err.code === 'VAULT_LOCKED') {
        istGesperrt = true;
        schluesselVorhanden = vorhanden();
      } else {
        log.warn(`${profil.name}-Schlüssel nicht lesbar: ${err && err.message}`);
      }
    }
    const n = netz();
    let grundCode = null;
    if (!schluesselVorhanden) grundCode = 'kein-schluessel';
    else if (istGesperrt) grundCode = 'gesperrt';
    else if (schluesselFalsch) grundCode = 'schluessel-falsch';
    else if (!n.erlaubt) grundCode = n.modus === 'online' ? 'gesperrtDurchSchleuse' : 'offline';
    const m = modell();
    return {
      anbieter: profil.id,
      name: profil.name,
      verbunden: grundCode === null,
      modell: m,
      modellName: modul.modellInfo(m).name,
      modelle: Object.values(modul.MODELLE).map((x) => ({ id: x.id, name: x.name, hinweis: x.hinweis })),
      schluesselVorhanden,
      gesperrt: istGesperrt,
      geprueftAm,
      netz: { modus: n.modus, erlaubt: n.erlaubt },
      grundCode: grundCode === 'gesperrtDurchSchleuse' ? 'schleuse' : grundCode,
      grund: grundCode ? GRUENDE[grundCode] : null,
      letzterFehler,
      verbrauch: { ...verbrauchLesen(), geschaetzt: true, kostenlos: profil.kostenlos === true, hinweis: profil.verbrauchHinweis },
    };
  }

  /**
   * Schlüssel und Modell für einen echten Aufruf -- oder ein Fehler mit dem
   * Satz, der in der Oberfläche steht. Code: <PRAEFIX>_NICHT_VERBUNDEN.
   */
  function zugang() {
    const z = zustand();
    if (!z.verbunden) {
      // 409, nicht 503: der Dienst ist nicht kaputt, er ist nur noch nicht
      // eingerichtet -- und ein 5xx landet als FEHLER im Protokoll.
      throw new NeuralError(`${P}_NICHT_VERBUNDEN`, z.grund, { status: 409, details: { grund: z.grundCode, anbieter: profil.id } });
    }
    return { schluessel: lesen().schluessel, modell: z.modell, basis, anbieter: profil.id };
  }

  function fehlerMerken(err) {
    const e = asNeuralError(err);
    if (e.code === 'ABORTED') return;
    letzterFehler = { code: e.code, satz: e.message, am: new Date().toISOString() };
    if (e.code === `${P}_SCHLUESSEL_FALSCH`) {
      if (!schluesselFalsch) {
        schluesselFalsch = true;
        publish(`${profil.id}.zustand`, { verbunden: false, grund: 'schluessel-falsch' });
      }
    }
  }

  /* ------------------------------------------------------------ Aufrufe */

  /**
   * Eine Anfrage senden (für den Chat). Was `modul.anfrageBauen` liefert
   * (`body`, `betas`, `modell`, `stream`), reicht der Aufrufer durch; hier
   * kommen Schlüssel, Adresse, Verbrauch und Fehlerzustand dazu.
   */
  async function senden(opts) {
    const z = zugang();
    try {
      const r = await api.senden({ ...opts, gate: opts.gate || gate, basis: z.basis, apiKey: z.schluessel });
      letzterFehler = null;
      verbrauchAddieren(opts.modell || (opts.body && opts.body.model), r.usage);
      return r;
    } catch (err) {
      fehlerMerken(err);
      throw err;
    }
  }

  /** Der allgemeine Weg der Registry (Agenten, Vergleich, zweiter Blick). */
  async function chat(opts) {
    const z = zugang();
    const gewuenscht = modul.istModell(opts.model) ? opts.model : z.modell;
    try {
      const r = await api.chat({ ...opts, gate: opts.gate || gate, model: gewuenscht, basis: z.basis, apiKey: z.schluessel });
      letzterFehler = null;
      verbrauchAddieren(gewuenscht, r.usage);
      return { ...r, model: gewuenscht };
    } catch (err) {
      fehlerMerken(err);
      throw err;
    }
  }

  /* ------------------------------------------------ Schlüssel verwalten */

  /**
   * Bei strenger Freigabeliste und Modus "online" muss der Host auf der Liste
   * stehen. "Verbinden" ist genau diese Entscheidung des Nutzers; sie steht
   * danach sichtbar in den Netzeinstellungen. Im Modus offline oder lan wird
   * NICHTS geändert -- dort bleibt der Anbieter aus.
   */
  function freigabeSicherstellen() {
    const n = netz();
    if (n.erlaubt) return { geaendert: false };
    if (n.modus !== 'online') {
      throw new NeuralError(`${P}_OFFLINE`, 'Neural OS ist offline. Schalte auf „Online“, dann prüfe ich den Schlüssel.', { status: 409, details: { grund: 'offline' } });
    }
    const liste = Array.isArray(config.network && config.network.allowHosts) ? config.network.allowHosts : [];
    const gesperrtListe = Array.isArray(config.network && config.network.blockHosts) ? config.network.blockHosts : [];
    if (gesperrtListe.some((h) => String(h).toLowerCase().includes(profil.sperrMuster))) {
      throw new NeuralError(`${P}_GESPERRT`, `${host} steht auf der Sperrliste. Unter Netzwerk entfernen, dann klappt es.`, { status: 409, details: { grund: 'schleuse' } });
    }
    if (liste.includes(host) || typeof deps.konfigSpeichern !== 'function') {
      throw new NeuralError(`${P}_GESPERRT`, GRUENDE.gesperrtDurchSchleuse, { status: 409, details: { grund: 'schleuse', schleuse: n.grund } });
    }
    deps.konfigSpeichern({ network: { allowHosts: [...liste, host] } });
    publish(`${profil.id}.freigabe`, { host });
    const danach = netz();
    if (!danach.erlaubt) {
      throw new NeuralError(`${P}_GESPERRT`, GRUENDE.gesperrtDurchSchleuse, { status: 409, details: { grund: 'schleuse', schleuse: danach.grund } });
    }
    return { geaendert: true };
  }

  /**
   * Schlüssel prüfen und speichern. Nur ein bestätigter Schlüssel wird gespeichert.
   * @param {string} roh
   * @param {{signal?:AbortSignal}} [opts]
   */
  async function schluesselSpeichern(roh, opts = {}) {
    const schluessel = profil.schluesselPruefen(roh);
    if (gesperrt()) throw new LockedError(GRUENDE.gesperrt);
    freigabeSicherstellen();
    const m = modell();
    try {
      await api.probe({ basis, apiKey: schluessel, modell: m, gate, signal: opts.signal });
    } catch (err) {
      const e = asNeuralError(err);
      letzterFehler = { code: e.code, satz: e.message, am: new Date().toISOString() };
      throw e;
    }
    const daten = { schluessel, geprueftAm: new Date().toISOString(), modell: m };
    dateiSchreiben(daten);
    eintrag = daten;
    schluesselFalsch = false;
    letzterFehler = null;
    publish(`${profil.id}.verbunden`, { modell: m });
    return zustand();
  }

  function schluesselLoeschen() {
    let da = false;
    try {
      fs.unlinkSync(schluesselPfad);
      da = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    eintrag = null;
    schluesselFalsch = false;
    letzterFehler = null;
    publish(`${profil.id}.getrennt`, {});
    return { geloescht: da, zustand: zustand() };
  }

  function modellSetzen(neu) {
    if (!modul.istModell(neu)) {
      throw new ValidationError(`Unbekanntes Modell „${neu}“. Möglich: ${Object.keys(modul.MODELLE).join(', ')}.`);
    }
    if (typeof deps.konfigSpeichern === 'function') deps.konfigSpeichern({ [profil.id]: { modell: neu } });
    else config[profil.id] = { ...(config[profil.id] || {}), modell: neu };
    publish(`${profil.id}.modell`, { modell: neu });
    return zustand();
  }

  /** Nach dem Entsperren des Tresors neu lesen (der Schlüssel war versiegelt). */
  function vergessen() {
    eintrag = undefined;
  }

  if (bus && typeof bus.on === 'function') {
    for (const name of ['vault.unlocked', 'vault.locked', 'vault.encrypted']) {
      bus.on(name, () => vergessen());
    }
  }

  return {
    id: profil.id,
    name: profil.name,
    modul,
    basis,
    host,
    zustand,
    zugang,
    senden,
    chat,
    modell,
    schluesselVorhanden: () => { try { return !!lesen(); } catch { return vorhanden(); } },
    schluesselSpeichern,
    schluesselLoeschen,
    modellSetzen,
    vergessen,
    anleitung: () => profil.anleitung,
  };
}

module.exports = { createAnbieterDienst };
