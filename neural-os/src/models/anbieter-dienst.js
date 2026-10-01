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

const crypto = require('node:crypto');
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
  let letzterFehler = null;
  let verbrauch = null;

  /*
   * Mehrere Schlüssel je Anbieter (Nutzer am 01.10.2026: "mehrere Keys,
   * falls bei einem das Limit leer geht, wechselt er zum nächsten"). Jeder
   * Schlüssel ist ein Zugang; zur Laufzeit merkt sich der Dienst, welcher
   * nicht (mehr) geht und welches Modell eines Zugangs gerade pausiert --
   * gespeichert wird davon nichts, ein Neustart probiert alles neu.
   */
  /** Zugänge, deren Schlüssel nicht (mehr) angenommen wird: id -> Grund ('falsch' | 'guthaben'). */
  const unbrauchbar = new Map();
  /** `${zugang}|${modell}` -> bis (ms): Limit erreicht, überlastet. */
  const pausen = new Map();
  /** `${zugang}|${modell}`: dieses Modell gibt es für diesen Schlüssel nicht (oder nicht kostenlos). */
  const fehlend = new Set();

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
    const daten = normalisieren(JSON.parse(klar.toString('utf8')));
    if (!daten) return null;
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

  /**
   * Ein Eintrag im Tresor in der Form mit Zugängen -- auch einer von früher
   * (genau ein Schlüssel, ohne Liste). `schluessel` und `geprueftAm` oben
   * spiegeln den ersten Zugang, damit eine ältere Fassung die Datei weiter
   * liest.
   */
  function normalisieren(daten) {
    if (!daten || typeof daten !== 'object') return null;
    let liste = Array.isArray(daten.zugaenge)
      ? daten.zugaenge.filter((z) => z && typeof z.schluessel === 'string' && z.schluessel)
      : [];
    if (!liste.length && typeof daten.schluessel === 'string' && daten.schluessel) {
      liste = [{
        id: 'k1',
        schluessel: daten.schluessel,
        geprueftAm: daten.geprueftAm || null,
        modell: typeof daten.modell === 'string' ? daten.modell : null,
        modelle: Array.isArray(daten.modelle) ? daten.modelle : null,
      }];
    }
    if (!liste.length) return null;
    const ids = new Set();
    liste = liste.map((z, i) => {
      let id = typeof z.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(z.id) ? z.id : `k${i + 1}`;
      while (ids.has(id)) id = `${id}x`;
      ids.add(id);
      return {
        id,
        schluessel: z.schluessel,
        geprueftAm: z.geprueftAm || null,
        modell: typeof z.modell === 'string' ? z.modell : null,
        modelle: Array.isArray(z.modelle) ? z.modelle.filter((m) => m && typeof m.id === 'string') : null,
        // Modelle, für die Google diesem Schlüssel die Suche nicht gibt (kostenlose Stufe).
        ohneSuche: Array.isArray(z.ohneSuche) ? z.ohneSuche.filter((x) => typeof x === 'string').slice(0, 40) : [],
      };
    });
    return { schluessel: liste[0].schluessel, geprueftAm: liste[0].geprueftAm, modell: liste[0].modell, zugaenge: liste };
  }

  function eintragSchreiben(zugaenge) {
    const daten = normalisieren({ zugaenge });
    if (!daten) {
      try { fs.unlinkSync(schluesselPfad); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      eintrag = null;
      return null;
    }
    dateiSchreiben(daten);
    eintrag = daten;
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

  /** Höchstens so viele Modelle eines Zugangs probiert der Dienst nacheinander. */
  const MAX_MODELLE_JE_ZUGANG = 4;
  /** Höchstens so viele Versuche je Anfrage (Zugänge mal Modelle). */
  const MAX_VERSUCHE = 8;

  function lesenOhneFehler() {
    try { return lesen(); } catch { return null; }
  }

  function statischBekannt(id) {
    return typeof id === 'string' && !!modul.MODELLE && Object.prototype.hasOwnProperty.call(modul.MODELLE, id);
  }

  /** Das Modell, das antworten SOLL: die Einstellung, wenn der Schlüssel sie kann, sonst das geprüfte. */
  function modell() {
    const m = config[profil.id] && config[profil.id].modell;
    const e = lesenOhneFehler();
    const erster = e && e.zugaenge[0];
    if (modul.istModell(m) && !(erster && fehlend.has(`${erster.id}|${m}`))) {
      const liste = erster && Array.isArray(erster.modelle) ? erster.modelle : null;
      if (!liste || liste.some((x) => x.id === m) || statischBekannt(m)) return m;
    }
    if (erster && modul.istModell(erster.modell) && !fehlend.has(`${erster.id}|${erster.modell}`)) return erster.modell;
    return modul.STANDARD_MODELL;
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

  /** "AIza…x4Q9": woran man einen Schlüssel wiedererkennt, ohne ihn zu verraten. */
  function maske(schluessel) {
    if (profil.ohneSchluessel === true) return 'ohne Schlüssel';
    const t = String(schluessel || '');
    return t.length > 12 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '…';
  }

  function namen(id) {
    const e = lesenOhneFehler();
    for (const z of (e ? e.zugaenge : [])) {
      const m = Array.isArray(z.modelle) ? z.modelle.find((x) => x.id === id) : null;
      if (m && m.name) return m.name;
    }
    return modul.modellInfo(id).name;
  }

  function alleUnbrauchbar(e) {
    return !!e && e.zugaenge.length > 0 && e.zugaenge.every((z) => unbrauchbar.has(z.id));
  }

  /** Bis wann ein Zugang ganz pausiert (jedes seiner Modelle) -- oder null. */
  function zugangPausiertBis(z, jetzt = Date.now()) {
    const reihe = modellReihe(z, modell());
    if (!reihe.length) return null;
    let frueheste = Infinity;
    for (const m of reihe) {
      const k = `${z.id}|${m}`;
      if (fehlend.has(k)) continue;
      const bis = pausen.get(k);
      if (!bis || bis <= jetzt) return null;
      frueheste = Math.min(frueheste, bis);
    }
    return Number.isFinite(frueheste) ? frueheste : null;
  }

  /** Die Modelle eines Zugangs in der Reihenfolge, in der sie probiert werden. */
  function modellReihe(z, wunsch) {
    const out = [];
    const dazu = (id) => { if (modul.istModell(id) && !out.includes(id)) out.push(id); };
    const liste = Array.isArray(z.modelle) ? z.modelle : null;
    // Ein Wunsch, den dieser Schlüssel laut Google nicht kann, zählt nicht.
    if (!liste || liste.some((x) => x.id === wunsch) || statischBekannt(wunsch)) dazu(wunsch);
    dazu(z.modell);
    // Ausweichen auf andere Modelle nur, wo der Anbieter es erlaubt (Gemini:
    // je Modell ein eigenes Tageslimit) und Google die Liste genannt hat.
    if (profil.modellWechsel === true && liste) for (const m of liste) { if (out.length >= MAX_MODELLE_JE_ZUGANG) break; dazu(m.id); }
    return out;
  }

  /**
   * Der Zustand, wie die Routen ihn liefern. Fragt nie das Netz.
   * @returns {object}
   */
  function zustand() {
    let schluesselVorhanden = false;
    let istGesperrt = false;
    let geprueftAm = null;
    let e = null;
    try {
      e = lesen();
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
    else if (alleUnbrauchbar(e)) grundCode = 'schluessel-falsch';
    else if (!n.erlaubt) grundCode = n.modus === 'online' ? 'gesperrtDurchSchleuse' : 'offline';
    const m = modell();
    const jetzt = Date.now();
    const zugaenge = e ? e.zugaenge.map((z, i) => {
      const bis = zugangPausiertBis(z, jetzt);
      const grund = unbrauchbar.get(z.id) || null;
      return {
        id: z.id,
        nr: i + 1,
        maske: maske(z.schluessel),
        geprueftAm: z.geprueftAm || null,
        status: grund || (bis ? 'pause' : 'bereit'),
        bis: bis ? new Date(bis).toISOString() : null,
      };
    }) : [];
    // Die Modelle, die der (erste) Schlüssel laut Google kann -- sonst die bekannten.
    const erster = e && e.zugaenge[0];
    const liste = erster && Array.isArray(erster.modelle) && erster.modelle.length
      ? erster.modelle.slice(0, 6).map((x) => ({ id: x.id, name: x.name || modul.modellInfo(x.id).name, hinweis: x.hinweis || '' }))
      : Object.values(modul.MODELLE).map((x) => ({ id: x.id, name: x.name, hinweis: x.hinweis }));
    if (m && !liste.some((x) => x.id === m)) liste.unshift({ id: m, name: namen(m), hinweis: '' });
    return {
      anbieter: profil.id,
      name: profil.name,
      // Für die Oberfläche: wo es den Schlüssel gibt, ob kostenlos, ob ganz ohne.
      kostenlos: profil.kostenlos === true,
      ohneSchluessel: profil.ohneSchluessel === true,
      info: profil.info || null,
      // Der Host (kein Geheimnis): für den Knopf "freigeben", wenn die Schleuse ihn sperrt.
      host,
      verbunden: grundCode === null,
      modell: m,
      modellName: namen(m),
      modelle: liste,
      schluesselVorhanden,
      gesperrt: istGesperrt,
      geprueftAm,
      zugaenge,
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
    const e = lesen();
    const erster = e.zugaenge.find((x) => !unbrauchbar.has(x.id)) || e.zugaenge[0];
    return { schluessel: erster.schluessel, modell: z.modell, basis, anbieter: profil.id, zugang: erster.id };
  }

  function fehlerMerken(err) {
    const e = asNeuralError(err);
    if (e.code === 'ABORTED') return;
    letzterFehler = { code: e.code, satz: e.message, am: new Date().toISOString() };
  }

  /* --------------------------------------------- Ausweichen (Zugänge) */

  /** Der nächste Mitternachtszeitpunkt in Kalifornien: dann setzt Google die Tageslimits zurück. */
  function naechsterTag(jetzt = Date.now()) {
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const t = Object.fromEntries(f.formatToParts(new Date(jetzt)).map((x) => [x.type, x.value]));
      const vorbei = ((Number(t.hour) % 24) * 3600 + Number(t.minute) * 60 + Number(t.second)) * 1000;
      if (!Number.isFinite(vorbei)) throw new Error('keine Zeit');
      return jetzt + (24 * 3600 * 1000 - vorbei) + 60000;
    } catch {
      return jetzt + 6 * 3600 * 1000;
    }
  }

  /** Was aus einem Fehler folgt: der Zugang ist hin, das Modell fehlt oder pausiert -- oder nichts davon. */
  function einordnen(code) {
    const endung = String(code || '').startsWith(`${P}_`) ? String(code).slice(P.length + 1) : '';
    if (['SCHLUESSEL_FALSCH', 'API_AUS', 'SCHLUESSEL_GESPERRT'].includes(endung)) return 'falsch';
    if (endung === 'GUTHABEN') return 'guthaben';
    if (['MODELL_UNBEKANNT', 'NICHT_KOSTENLOS'].includes(endung)) return 'fehlt';
    if (endung === 'LIMIT_TAG') return 'tag';
    if (['LIMIT', 'ZU_VIELE_ANFRAGEN'].includes(endung)) return 'minute';
    if (endung === 'UEBERLASTET') return 'ueberlastet';
    return null;
  }

  /**
   * Den Fehler eines Versuchs verbuchen.
   * @returns {string|null} die Art (dann lohnt der nächste Versuch) oder null
   */
  function verbuchen(wahl, err) {
    const art = einordnen(err && err.code);
    const jetzt = Date.now();
    if (art === 'falsch' || art === 'guthaben') {
      unbrauchbar.set(wahl.zugang.id, art);
      const e = lesenOhneFehler();
      if (alleUnbrauchbar(e)) publish(`${profil.id}.zustand`, { verbunden: false, grund: 'schluessel-falsch' });
    } else if (art === 'fehlt') {
      fehlend.add(wahl.k);
    } else if (art === 'tag') {
      pausen.set(wahl.k, naechsterTag(jetzt));
    } else if (art === 'minute') {
      const s = Number.isFinite(err.wiederholenNachS) && err.wiederholenNachS > 0 ? Math.min(err.wiederholenNachS, 3600) : 60;
      pausen.set(wahl.k, jetzt + s * 1000);
    } else if (art === 'ueberlastet') {
      pausen.set(wahl.k, jetzt + 30000);
    }
    return art;
  }

  /**
   * Der nächste Versuch: der erste brauchbare Zugang mit dem ersten Modell,
   * das weder fehlt noch pausiert. Gibt es keinen und wurde noch nichts
   * versucht, zählen Pausen nicht -- ein einzelner Schlüssel wird nie
   * verweigert, ohne Google zu fragen.
   */
  function waehlen(wunsch, versucht) {
    const e = lesenOhneFehler();
    if (!e) return null;
    const jetzt = Date.now();
    for (const mitPausen of [true, false]) {
      if (!mitPausen && versucht.size) break;
      for (const z of e.zugaenge) {
        if (unbrauchbar.has(z.id)) continue;
        for (const m of modellReihe(z, wunsch)) {
          const k = `${z.id}|${m}`;
          if (versucht.has(k) || fehlend.has(k)) continue;
          const bis = pausen.get(k);
          if (mitPausen && bis && bis > jetzt) continue;
          return { zugang: z, modell: m, k, nr: e.zugaenge.indexOf(z) + 1, mehrere: e.zugaenge.length > 1 };
        }
      }
    }
    return null;
  }

  /** "Gemini 2.5 Flash hat sein Tageslimit erreicht – es antwortet Gemini 2.5 Flash-Lite." */
  function wechselSatz(vorher, nachher, art) {
    const wer = (w) => `${namen(w.modell)}${w.mehrere ? ` (Schlüssel ${w.nr})` : ''}`;
    const grund = {
      falsch: 'nimmt den Schlüssel nicht an',
      guthaben: 'hat kein Guthaben mehr',
      fehlt: 'steht für diesen Schlüssel nicht zur Verfügung',
      tag: 'hat sein Tageslimit erreicht',
      minute: 'ist gerade am Limit',
      ueberlastet: 'ist gerade überlastet',
    }[art] || 'antwortet gerade nicht';
    return `${wer(vorher)} ${grund} – es antwortet ${wer(nachher)}.`;
  }

  /** Die Modellliste eines Zugangs nachholen (ein Schlüssel von früher kennt keine). */
  async function modelleNachladen(z, signal) {
    if (typeof api.modelleAbfragen !== 'function') return false;
    try {
      const liste = await api.modelleAbfragen({ basis, apiKey: z.schluessel, gate, signal });
      if (!Array.isArray(liste) || !liste.length) return false;
      const e = lesen();
      const zugaenge = e.zugaenge.map((x) => (x.id === z.id ? { ...x, modelle: kurzListe(liste) } : x));
      eintragSchreiben(zugaenge);
      return true;
    } catch (err) {
      log.warn(`${profil.name}-Modelle nicht abrufbar: ${asNeuralError(err).message}`);
      return false;
    }
  }

  function kurzListe(liste) {
    return liste.slice(0, 12).map((m) => ({
      id: m.id, name: m.name || modul.modellInfo(m.id).name, eingabe: m.eingabe || null, ausgabe: m.ausgabe || null,
    }));
  }

  function ausgabeGrenze(wahl) {
    const m = Array.isArray(wahl.zugang.modelle) ? wahl.zugang.modelle.find((x) => x.id === wahl.modell) : null;
    return m && Number.isFinite(m.ausgabe) ? m.ausgabe : undefined;
  }

  /**
   * Ein Aufruf mit Ausweichen: der gewünschte Zugang und das gewünschte
   * Modell zuerst; scheitert es an Schlüssel, Limit, Überlastung oder einem
   * fehlenden Modell, BEVOR etwas angekommen ist, der nächste Versuch -- mit
   * einem Satz an den Nutzer, wer jetzt antwortet. Kommt nichts durch, gilt
   * der Fehler des ersten Versuchs (der sagt, was eigentlich los ist).
   */
  async function mitAusweichen(wunsch, signal, beiEreignis, aufruf) {
    zugang(); // der Satz, wenn gar nichts geht (kein Schlüssel, gesperrt, offline, alle falsch)
    const versucht = new Set();
    let erster = null;
    // Der erste Versuch, der scheiterte, und warum: Davon spricht der Satz an
    // den Nutzer ("Gemini 3.8 Flash hat sein Tageslimit erreicht – es antwortet
    // Gemini 3.5 Flash-Lite"). Gesagt wird er erst, wenn der Ersatz wirklich
    // antwortet -- Zwischenschritte, die auch scheitern, sagt niemand.
    let anfang = null;
    let anfangArt = null;
    const melden = typeof beiEreignis === 'function' ? beiEreignis : () => {};
    for (let i = 0; i < MAX_VERSUCHE; i++) {
      const wahl = waehlen(wunsch, versucht);
      if (!wahl) break;
      versucht.add(wahl.k);
      let ausstehend = anfang ? wechselSatz(anfang, wahl, anfangArt) : null;
      const sagen = () => {
        if (!ausstehend) return;
        const satz = ausstehend;
        ausstehend = null;
        try { melden({ art: 'hinweis', satz }); } catch { /* egal */ }
      };
      const weiter = (e) => {
        sagen();
        try { melden(e); } catch { /* ein kaputter Zuhörer bricht keinen Aufruf ab */ }
      };
      try {
        const r = await aufruf(wahl, weiter);
        sagen();
        letzterFehler = null;
        // Hat ein anderes Modell als gespeichert geantwortet, weil das
        // gespeicherte fehlt: das neue merken (nicht bei Pausen).
        if (wahl.modell !== wahl.zugang.modell && fehlend.has(`${wahl.zugang.id}|${wahl.zugang.modell}`)) {
          try {
            const e = lesen();
            eintragSchreiben(e.zugaenge.map((x) => (x.id === wahl.zugang.id ? { ...x, modell: wahl.modell } : x)));
          } catch { /* beim nächsten Mal */ }
        }
        return { r, wahl };
      } catch (err) {
        const e = asNeuralError(err);
        const angekommen = Array.isArray(err && err.teilInhalt) && err.teilInhalt.length > 0;
        if (e.code === 'ABORTED' || angekommen) {
          fehlerMerken(err);
          throw err;
        }
        let art = einordnen(e.code);
        // Ein Schlüssel von früher hat keine Modellliste: jetzt holen, dann ausweichen.
        if (art === 'fehlt' && profil.modellWechsel === true && !Array.isArray(wahl.zugang.modelle)) {
          await modelleNachladen(wahl.zugang, signal);
        }
        art = verbuchen(wahl, err);
        if (!erster) erster = err;
        if (!art) {
          fehlerMerken(err);
          throw err;
        }
        if (!anfang) {
          anfang = wahl;
          anfangArt = art;
        }
      }
    }
    const fehler = erster || new NeuralError(`${P}_NICHT_VERBUNDEN`, GRUENDE['kein-schluessel'], { status: 409 });
    fehlerMerken(fehler);
    throw fehler;
  }

  /* ------------------------------------------------------------ Aufrufe */

  /**
   * Eine Anfrage senden (für den Chat). Was `modul.anfrageBauen` liefert
   * (`body`, `betas`, `modell`, `stream`, `denken`), reicht der Aufrufer
   * durch; hier kommen Schlüssel, Adresse, Verbrauch, Fehlerzustand und das
   * Ausweichen dazu.
   */
  async function senden(opts) {
    const { r, wahl } = await mitAusweichen(opts.modell, opts.signal, opts.beiEreignis, (w, beiEreignis) => api.senden({
      ...opts,
      beiEreignis,
      gate: opts.gate || gate,
      basis,
      apiKey: w.zugang.schluessel,
      modell: w.modell,
      ausgabeMax: ausgabeGrenze(w),
      ohneSuche: Array.isArray(w.zugang.ohneSuche) && w.zugang.ohneSuche.includes(w.modell),
    }));
    if (r && r.ohneSuche === true) sucheAusMerken(wahl);
    verbrauchAddieren(wahl.modell, r.usage);
    return { ...r, zugang: wahl.zugang.id, modellGenutzt: wahl.modell };
  }

  /** Dieser Schlüssel bekommt die Google-Suche für dieses Modell nicht: beim nächsten Mal gleich ohne. */
  function sucheAusMerken(wahl) {
    try {
      const e = lesen();
      eintragSchreiben(e.zugaenge.map((x) => (x.id === wahl.zugang.id
        ? { ...x, ohneSuche: [...new Set([...(x.ohneSuche || []), wahl.modell])] }
        : x)));
    } catch (err) {
      log.warn(`Nicht gemerkt, dass die Suche fehlt: ${err && err.message}`);
    }
  }

  /** Der allgemeine Weg der Registry (Agenten, Vergleich, zweiter Blick). */
  async function chat(opts) {
    const wunsch = modul.istModell(opts.model) ? opts.model : modell();
    const { r, wahl } = await mitAusweichen(wunsch, opts.signal, null, (w) => api.chat({
      ...opts,
      gate: opts.gate || gate,
      model: w.modell,
      basis,
      apiKey: w.zugang.schluessel,
    }));
    verbrauchAddieren(wahl.modell, r.usage);
    return { ...r, model: wahl.modell };
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

  /** Fehler, bei denen die Modellliste nicht weiterhilft: dann ist das die Antwort auf "Verbinden". */
  function endgueltig(code) {
    return /_(SCHLUESSEL_FALSCH|API_AUS|SCHLUESSEL_GESPERRT|ORT|OFFLINE|GESPERRT|KEIN_NETZ|ZEIT|KEIN_SCHLUESSEL)$/.test(String(code || '')) || code === 'ABORTED';
  }

  /**
   * Schlüssel prüfen und speichern. Nur ein bestätigter Schlüssel wird gespeichert.
   *
   * Gemini: zuerst fragt Neural OS Google, welche Modelle dieser Schlüssel
   * kann (das prüft auch den Schlüssel), dann probt es das beste -- und,
   * wenn das nicht geht (gibt es nicht, nicht kostenlos, Tageslimit), das
   * nächste. Gespeichert werden der Schlüssel, das Modell, das antwortete,
   * und die Liste.
   *
   * @param {string} roh
   * @param {{signal?:AbortSignal, zusaetzlich?:boolean, ersetzt?:string}} [opts]
   *   zusaetzlich: als weiterer Zugang dazu; ersetzt: diesen Zugang ersetzen;
   *   sonst ersetzt er den ersten (wie bisher "Ersetzen").
   */
  async function schluesselSpeichern(roh, opts = {}) {
    const schluessel = profil.schluesselPruefen(roh);
    if (gesperrt()) throw new LockedError(GRUENDE.gesperrt);
    freigabeSicherstellen();
    const merken = (err) => {
      const e = asNeuralError(err);
      letzterFehler = { code: e.code, satz: e.message, am: new Date().toISOString() };
      return e;
    };

    let liste = null;
    if (typeof api.modelleAbfragen === 'function') {
      try {
        liste = await api.modelleAbfragen({ basis, apiKey: schluessel, gate, signal: opts.signal });
      } catch (err) {
        const e = asNeuralError(err);
        if (endgueltig(e.code)) throw merken(e);
        liste = null; // die Liste gibt es hier nicht -- dann ohne
      }
    }
    const gewuenscht = config[profil.id] && config[profil.id].modell;
    const kandidaten = [];
    const dazu = (id) => { if (modul.istModell(id) && !kandidaten.includes(id)) kandidaten.push(id); };
    if (Array.isArray(liste) && liste.length) {
      if (liste.some((m) => m.id === gewuenscht)) dazu(gewuenscht);
      for (const m of liste) { if (kandidaten.length >= MAX_MODELLE_JE_ZUGANG) break; dazu(m.id); }
    } else {
      dazu(modell());
    }
    let gewaehlt = null;
    let erster = null;
    for (const m of kandidaten) {
      try {
        await api.probe({ basis, apiKey: schluessel, modell: m, gate, signal: opts.signal });
        gewaehlt = m;
        break;
      } catch (err) {
        const e = asNeuralError(err);
        if (!erster) erster = e;
        const art = einordnen(e.code);
        if (!(profil.modellWechsel === true && ['fehlt', 'tag', 'minute', 'ueberlastet'].includes(art))) break;
      }
    }
    if (!gewaehlt) throw merken(erster || new NeuralError(`${P}_FEHLER`, `${profil.name} hat den Schlüssel nicht bestätigt.`, { status: 502 }));

    let alt = [];
    try {
      const e = lesen();
      alt = e ? e.zugaenge.slice() : [];
    } catch { alt = []; }
    const neu = {
      id: `k${crypto.randomBytes(4).toString('hex')}`,
      schluessel,
      geprueftAm: new Date().toISOString(),
      modell: gewaehlt,
      modelle: Array.isArray(liste) && liste.length ? kurzListe(liste) : null,
    };
    let zugaenge;
    const doppelt = alt.findIndex((z) => z.schluessel === schluessel);
    if (doppelt >= 0) {
      neu.id = alt[doppelt].id;
      zugaenge = alt.map((z, i) => (i === doppelt ? neu : z));
    } else if (opts.zusaetzlich === true && alt.length) {
      zugaenge = [...alt, neu];
    } else if (typeof opts.ersetzt === 'string' && alt.some((z) => z.id === opts.ersetzt)) {
      zugaenge = alt.map((z) => (z.id === opts.ersetzt ? { ...neu, id: z.id } : z));
    } else {
      zugaenge = [neu, ...alt.slice(1)];
    }
    eintragSchreiben(zugaenge);
    const id = zugaenge.find((z) => z.schluessel === schluessel).id;
    unbrauchbar.delete(id);
    for (const k of [...pausen.keys()]) if (k.startsWith(`${id}|`)) pausen.delete(k);
    for (const k of [...fehlend]) if (k.startsWith(`${id}|`)) fehlend.delete(k);
    // Die Einstellung zeigt auf ein Modell, das dieser (erste) Schlüssel nicht kann: dann das geprüfte.
    if (zugaenge[0].id === id && gewuenscht && gewuenscht !== gewaehlt && neu.modelle && !neu.modelle.some((m) => m.id === gewuenscht)) {
      if (typeof deps.konfigSpeichern === 'function') deps.konfigSpeichern({ [profil.id]: { modell: gewaehlt } });
      else config[profil.id] = { ...(config[profil.id] || {}), modell: gewaehlt };
    }
    letzterFehler = null;
    publish(`${profil.id}.verbunden`, { modell: gewaehlt });
    return zustand();
  }

  /** Einen Zugang (oder ohne id: alle) entfernen. */
  function schluesselLoeschen(zugangId) {
    let da = false;
    if (typeof zugangId === 'string' && zugangId) {
      let e = null;
      try { e = lesen(); } catch (err) { if (!err || err.code !== 'VAULT_LOCKED') throw err; throw new LockedError(GRUENDE.gesperrt); }
      if (e && e.zugaenge.some((z) => z.id === zugangId)) {
        da = true;
        eintragSchreiben(e.zugaenge.filter((z) => z.id !== zugangId));
        unbrauchbar.delete(zugangId);
      }
    } else {
      try {
        fs.unlinkSync(schluesselPfad);
        da = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      eintrag = null;
      unbrauchbar.clear();
      pausen.clear();
      fehlend.clear();
    }
    letzterFehler = null;
    publish(`${profil.id}.getrennt`, { zugang: zugangId || null });
    return { geloescht: da, zustand: zustand() };
  }

  /** Einen Zugang nach vorn holen: er wird zuerst gefragt. */
  function zugangVor(zugangId) {
    const e = lesen();
    const i = e ? e.zugaenge.findIndex((z) => z.id === zugangId) : -1;
    if (i < 0) throw new NeuralError('NOT_FOUND', 'Diesen Schlüssel gibt es nicht (mehr).', { status: 404 });
    if (i > 0) eintragSchreiben([e.zugaenge[i], ...e.zugaenge.filter((_, j) => j !== i)]);
    publish(`${profil.id}.zustand`, { verbunden: zustand().verbunden });
    return zustand();
  }

  function modellSetzen(neu) {
    if (!modul.istModell(neu)) {
      throw new ValidationError(`Unbekanntes Modell „${neu}“. Möglich: ${Object.keys(modul.MODELLE).join(', ')}.`);
    }
    const e = lesenOhneFehler();
    const erster = e && e.zugaenge[0];
    if (erster && Array.isArray(erster.modelle) && erster.modelle.length && !erster.modelle.some((m) => m.id === neu) && !statischBekannt(neu)) {
      throw new ValidationError(`„${neu}“ kann dieser Schlüssel laut ${profil.name} nicht benutzen.`);
    }
    if (typeof deps.konfigSpeichern === 'function') deps.konfigSpeichern({ [profil.id]: { modell: neu } });
    else config[profil.id] = { ...(config[profil.id] || {}), modell: neu };
    if (erster) fehlend.delete(`${erster.id}|${neu}`);
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
    zugangVor,
    modellSetzen,
    vergessen,
    anleitung: () => profil.anleitung,
  };
}

module.exports = { createAnbieterDienst };
