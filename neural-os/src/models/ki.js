'use strict';

/**
 * Die KI von Neural OS: zwei Anbieter, einer antwortet.
 *
 * Der Nutzer will kein Geld ausgeben. Deshalb ist Gemini (Google, kostenlose
 * Stufe ohne Karte) die erste Wahl und Claude (Anthropic, kostet pro Nutzung)
 * die zweite. Beide sind je ein Dienst aus src/models/anbieter-dienst.js mit
 * eigenem Schlüssel im Tresor, eigenem Modell und eigenem Verbrauch; dieser
 * Verbund entscheidet nur, WER gerade antwortet:
 *
 *   1. `config.ki.anbieter` ('gemini' | 'claude'), wenn gesetzt -- die
 *      Einstellung gilt, auch wenn beide verbunden sind.
 *   2. Sonst der Anbieter, der einen Schlüssel hat.
 *   3. Sonst Gemini -- der kostenlose.
 *
 * Nach dem ERSTEN erfolgreichen Verbinden wird der verbundene Anbieter als
 * Einstellung gespeichert. Wer danach den zweiten verbindet, wechselt nicht
 * still: er wählt unter Einstellungen → KI.
 *
 * Nach außen spricht der Verbund denselben Vertrag wie ein einzelner Dienst
 * (`zustand`, `zugang`, `senden`, `chat`, `modell`), damit chat.js und die
 * Registry ihn nehmen können, ohne zwei Fälle zu kennen -- plus
 * `anbieterModul()`, das sagt, welcher Anbieter gerade die Blöcke übersetzt.
 */

const gemini = require('./providers/gemini');
const { NeuralError, ValidationError } = require('../kernel/errors');
const { createAnbieterDienst } = require('./anbieter-dienst');
const { PROFIL: PROFIL_CLAUDE } = require('./claude');

const ANBIETER = Object.freeze(['gemini', 'claude']);

/* --------------------------------------------------------------- Gemini */

const GEMINI_SCHLUESSEL_DATEI = 'gemini-schluessel.json';
const GEMINI_VERBRAUCH_DATEI = 'gemini-verbrauch.json';

const GEMINI_GRUENDE = Object.freeze({
  'kein-schluessel': 'Gemini ist nicht verbunden. Unter Einstellungen → KI den Google-Schlüssel einfügen.',
  gesperrt: 'Der Tresor ist gesperrt. Erst mit der PIN entsperren, dann kann Gemini antworten.',
  offline: 'Offline — Gemini ist gerade nicht erreichbar. Schalte auf „Online“, dann antwortet Gemini.',
  gesperrtDurchSchleuse: 'Die Schleuse lässt generativelanguage.googleapis.com nicht durch. Unter Netzwerk freigeben.',
  'schluessel-falsch': 'Der Google-Schlüssel stimmt nicht (mehr). Bitte unter Einstellungen → KI neu eingeben.',
});

const GEMINI_ANLEITUNG = [
  'So verbindest du Gemini (kostenlos):',
  '',
  '  1. Auf aistudio.google.com/apikey mit dem Google-Konto anmelden und „Create API key“ antippen. Keine Karte nötig.',
  '  2. In Neural OS im Chat oder unter Einstellungen → KI den Schlüssel einfügen.',
  '  3. Oben auf „Online“ schalten. Neural OS prüft den Schlüssel sofort mit einem kleinen Probeaufruf.',
  '',
  'Kostenlos; Google darf Inhalte zur Verbesserung nutzen.',
  'Ohne KI erfindet Neural OS keine Antworten. Notizen, Kalender, Projekte und die Suche funktionieren trotzdem.',
].join('\n');

function geminiSchluesselPruefen(roh) {
  if (typeof roh !== 'string') throw new ValidationError('Bitte den Google-Schlüssel einfügen.');
  const s = roh.trim();
  if (!s) throw new ValidationError('Bitte den Google-Schlüssel einfügen.');
  if (/\s/.test(s)) throw new ValidationError('Im Schlüssel steht ein Leerzeichen oder Zeilenumbruch. Bitte genau so einfügen, wie er in AI Studio steht.');
  if (s.length < 20 || s.length > 400) throw new ValidationError('Das sieht nicht nach einem Google-Schlüssel aus (die beginnen mit „AIza“).');
  if (!/^[\x21-\x7e]+$/.test(s)) throw new ValidationError('Im Schlüssel stehen Zeichen, die dort nicht hingehören.');
  return s;
}

const PROFIL_GEMINI = Object.freeze({
  id: 'gemini',
  name: 'Gemini',
  praefix: 'GEMINI',
  modul: gemini,
  schluesselDatei: GEMINI_SCHLUESSEL_DATEI,
  verbrauchDatei: GEMINI_VERBRAUCH_DATEI,
  gruende: GEMINI_GRUENDE,
  anleitung: GEMINI_ANLEITUNG,
  kostenlos: true,
  verbrauchHinweis: 'Kostenlos auf Googles kostenloser Stufe; Google begrenzt die Zahl der Anfragen je Minute und je Tag.',
  schluesselPruefen: geminiSchluesselPruefen,
  sperrMuster: 'googleapis.com',
});

function createGemini(deps = {}) {
  return createAnbieterDienst(PROFIL_GEMINI, deps);
}

/* -------------------------------------------------------------- Verbund */

const KEINE = Object.freeze({
  code: 'KI_NICHT_VERBUNDEN',
  satz: 'Keine KI verbunden. Im Chat oder unter Einstellungen → KI einen Schlüssel einfügen — Google ist kostenlos.',
});

const ANLEITUNG = `${GEMINI_ANLEITUNG}\n\nOder Claude (kostet pro Nutzung): console.anthropic.com → API Keys, dann unter Einstellungen → KI bei Claude einfügen.`;

/**
 * @param {object} deps
 * @param {object} deps.paths
 * @param {object} deps.config
 * @param {object} deps.gate
 * @param {object} [deps.bus]
 * @param {object} [deps.vaultCrypto]
 * @param {Function} [deps.logger]
 * @param {Function} [deps.konfigSpeichern]
 * @param {string} [deps.claudeBasis]   nur für Tests (Statist)
 * @param {string} [deps.geminiBasis]   nur für Tests (Statist)
 */
function createKi(deps = {}) {
  const { config, bus } = deps;
  if (!config || typeof config !== 'object') throw new ValidationError('createKi braucht die Konfiguration.');
  const gemeinsam = { ...deps };
  delete gemeinsam.claudeBasis;
  delete gemeinsam.geminiBasis;
  delete gemeinsam.basis;
  const dienste = {
    claude: createAnbieterDienst(PROFIL_CLAUDE, { ...gemeinsam, basis: deps.claudeBasis || deps.basis }),
    gemini: createAnbieterDienst(PROFIL_GEMINI, { ...gemeinsam, basis: deps.geminiBasis }),
  };

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try { bus.publish(name, payload || {}); } catch { /* egal */ }
  }

  function eingestellt() {
    const a = config.ki && config.ki.anbieter;
    return ANBIETER.includes(a) ? a : null;
  }

  /** Wer gerade antwortet (siehe Kopf). */
  function aktiv() {
    const a = eingestellt();
    if (a) return a;
    for (const id of ANBIETER) if (dienste[id].schluesselVorhanden()) return id;
    return 'gemini';
  }

  function dienst(id) {
    if (!ANBIETER.includes(id)) throw new ValidationError(`Unbekannter Anbieter „${id}“. Möglich: gemini, claude.`);
    return dienste[id];
  }

  function aktiver() {
    return dienste[aktiv()];
  }

  function speichern(patch) {
    if (typeof deps.konfigSpeichern === 'function') deps.konfigSpeichern(patch);
    else Object.assign(config, { ki: { ...(config.ki || {}), ...patch.ki } });
  }

  /** Der Zustand beider Anbieter plus der aktive -- für GET /api/ki. Fragt nie das Netz. */
  function zustand() {
    const id = aktiv();
    const je = { gemini: dienste.gemini.zustand(), claude: dienste.claude.zustand() };
    const a = je[id];
    const irgendein = ANBIETER.some((x) => je[x].schluesselVorhanden);
    return {
      aktiv: id,
      eingestellt: eingestellt(),
      name: a.name,
      verbunden: a.verbunden,
      modell: a.modell,
      modellName: a.modellName,
      schluesselVorhanden: a.schluesselVorhanden,
      irgendeinSchluessel: irgendein,
      gesperrt: a.gesperrt,
      netz: a.netz,
      grundCode: irgendein ? a.grundCode : 'kein-schluessel',
      grund: a.verbunden ? null : (irgendein ? a.grund : KEINE.satz),
      letzterFehler: a.letzterFehler,
      anbieter: je,
    };
  }

  /** Zugang des aktiven Anbieters -- oder der Satz, warum nicht. */
  function zugang() {
    const d = aktiver();
    const irgendein = ANBIETER.some((x) => dienste[x].schluesselVorhanden());
    if (!irgendein) {
      throw new NeuralError(KEINE.code, KEINE.satz, { status: 409, details: { grund: 'kein-schluessel', anbieter: d.id } });
    }
    return d.zugang();
  }

  /**
   * Anbieter und/oder Modell setzen (PATCH /api/ki). Das Modell gehört zu
   * dem Anbieter, der danach aktiv ist.
   */
  function setzen({ anbieter, modell } = {}) {
    if (anbieter !== undefined) {
      dienst(anbieter);
      if (anbieter !== eingestellt()) {
        speichern({ ki: { anbieter } });
        publish('ki.anbieter', { anbieter });
      }
    }
    if (modell !== undefined) aktiver().modellSetzen(modell);
    return zustand();
  }

  /** Schlüssel eines Anbieters speichern; beim ersten Erfolg wird er die Einstellung. */
  async function schluesselSpeichern(anbieter, roh, opts) {
    const d = dienst(anbieter);
    await d.schluesselSpeichern(roh, opts);
    if (!eingestellt()) {
      speichern({ ki: { anbieter } });
      publish('ki.anbieter', { anbieter });
    }
    return zustand();
  }

  function schluesselLoeschen(anbieter) {
    const r = dienst(anbieter).schluesselLoeschen();
    return { geloescht: r.geloescht, zustand: zustand() };
  }

  return {
    ANBIETER,
    claude: dienste.claude,
    gemini: dienste.gemini,
    dienst,
    aktiv,
    aktiver,
    /** Das Anbieter-Modul, das gerade Blöcke baut und liest (chat.js). */
    anbieterModul: () => aktiver().modul,
    zustand,
    zugang,
    senden: (opts) => aktiver().senden(opts),
    chat: (opts) => aktiver().chat(opts),
    modell: () => aktiver().modell(),
    setzen,
    schluesselSpeichern,
    schluesselLoeschen,
    vergessen: () => { dienste.claude.vergessen(); dienste.gemini.vergessen(); },
    anleitung: () => ANLEITUNG,
    get basis() { return aktiver().basis; },
  };
}

module.exports = {
  createKi,
  createGemini,
  ANBIETER,
  PROFIL_GEMINI,
  GEMINI_ANLEITUNG,
  GEMINI_GRUENDE,
  GEMINI_SCHLUESSEL_DATEI,
  GEMINI_VERBRAUCH_DATEI,
  KEINE,
  ANLEITUNG,
};
