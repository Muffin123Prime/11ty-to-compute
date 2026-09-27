'use strict';

/**
 * Die Modell-Registry -- ein dünner Mantel um den KI-Verbund
 * (src/models/ki.js: Gemini oder Claude, einer antwortet).
 *
 * Warum es sie noch gibt
 * ----------------------
 * Mehrere Teilsysteme sprechen "ein Modell" über denselben kleinen Vertrag an
 * (`resolve`, `chat`, `list`): der Agentenlauf, der zweite Blick, der
 * Modellvergleich und die Erweiterungen (`model.use`). Diesen Vertrag an
 * einer Stelle zu halten ist billiger, als fünf Aufrufer umzubauen -- und er
 * bleibt ehrlich: "kein Modell" heißt "keine KI verbunden", mit genau dem
 * Satz, den auch die Oberfläche zeigt.
 *
 * Was sie NICHT mehr tut
 * ----------------------
 * - Sie sucht keine lokalen Modellserver mehr (11434/8080/1234). Die
 *   Einträge in `config.models.providers` werden nicht mehr gelesen.
 * - `refresh()` fragt kein Netz: der Zustand ist aus Schlüssel, Tresor
 *   und Schleuse ableitbar, und ein Probeaufruf je Seitenaufruf kostete Geld
 *   (Claude) oder Tageslimit (Gemini).
 * - Einbettungen gibt es nicht; die Suche ist Volltext.
 *
 * Gelistet wird EIN Anbieter: der aktive. Wer den anderen will, wählt ihn
 * unter Einstellungen → KI; die Registry folgt.
 */

const { NoModelError, ValidationError } = require('../kernel/errors');
const anthropic = require('./providers/anthropic');
const { ANLEITUNG } = require('./claude');

const PROVIDER_ID = 'claude';

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

/**
 * @param {{config:object, gate?:object, bus?:object, logger?:Function, claude?:object}} deps
 *   `claude` ist der KI-Verbund (oder ein einzelner Anbieter-Dienst); der Name bleibt, damit ältere Aufrufer weiter passen.
 */
function createRegistry({ config, bus, logger, claude } = {}) {
  if (!config || typeof config !== 'object') {
    throw new ValidationError('Die Modell-Registry braucht eine Konfiguration.');
  }
  const log = typeof logger === 'function' ? logger('models') : nullLogger();
  const ki = claude;
  let at = null;

  /** Das Anbieter-Modul des aktiven Anbieters (Claude, wenn der Dienst keines nennt). */
  function modul() {
    if (ki && typeof ki.anbieterModul === 'function') return ki.anbieterModul();
    if (ki && ki.modul) return ki.modul;
    return anthropic;
  }

  function providerId() {
    return modul().anbieterId || PROVIDER_ID;
  }

  function zustand() {
    if (!ki || typeof ki.zustand !== 'function') {
      return { verbunden: false, grund: 'Die KI ist in dieser Instanz nicht geladen.', grundCode: 'fehlt', schluesselVorhanden: false, modell: anthropic.STANDARD_MODELL };
    }
    return ki.zustand();
  }

  function eintrag() {
    const z = zustand();
    const m = modul();
    const id = providerId();
    return {
      id,
      kind: m.kind,
      baseUrl: ki && ki.basis ? ki.basis : m.API_BASIS,
      remote: true,
      hasApiKey: !!z.schluesselVorhanden,
      quelle: 'fern',
      vomStick: false,
      label: id === 'gemini' ? 'Gemini (Google, kostenlos)' : 'Claude (Anthropic)',
      hinweis: z.verbunden ? null : z.grund,
      available: !!z.verbunden,
      models: Object.values(m.MODELLE).map((x) => ({
        id: x.id, name: x.name, family: id, contextLength: x.id === 'claude-haiku-4-5' ? 200000 : 1000000,
      })),
      error: z.verbunden ? null : z.grund,
      code: z.verbunden ? null : `${id.toUpperCase()}_NICHT_VERBUNDEN`,
      latencyMs: null,
      probedAt: at,
      modell: z.modell,
    };
  }

  function snapshot() {
    return { providers: [eintrag()], at };
  }

  function modellAus(ref) {
    let wunsch = null;
    if (typeof ref === 'string') wunsch = ref.includes('/') ? ref.split('/').slice(1).join('/') : ref;
    else if (ref && typeof ref === 'object') wunsch = ref.model || null;
    // Alte Chats und Agenten nennen noch ein lokales Modell ("llama3.2") oder
    // das Modell des anderen Anbieters. Geantwortet wird mit dem aktiven,
    // und die Antwort trägt, welches Modell es wirklich war.
    const m = modul();
    if (m.istModell(wunsch)) return wunsch;
    return ki && typeof ki.modell === 'function' ? ki.modell() : m.STANDARD_MODELL;
  }

  function nichtVerbunden(headline) {
    const z = zustand();
    const anleitung = ki && typeof ki.anleitung === 'function' ? ki.anleitung() : ANLEITUNG;
    return new NoModelError(
      [headline || z.grund || 'Keine KI ist verbunden.', headline && z.grund ? z.grund : null, '', anleitung]
        .filter((x) => x !== null).join('\n').trim(),
      { grund: z.grundCode || null, provider: providerId() },
    );
  }

  const registry = {
    /** Ohne Netz: der Zustand wird abgeleitet, nicht geprobt. */
    async refresh() {
      at = new Date().toISOString();
      const snap = snapshot();
      if (bus && typeof bus.publish === 'function') {
        try { bus.publish('models.changed', snap); } catch (err) { log.warn(`models.changed: ${err && err.message}`); }
      }
      return snap;
    },

    list() {
      return snapshot();
    },

    resolve(ref) {
      const z = zustand();
      if (!z.verbunden) throw nichtVerbunden();
      return {
        providerId: providerId(),
        kind: modul().kind,
        baseUrl: ki.basis,
        model: modellAus(ref),
        quelle: 'fern',
        vomStick: false,
      };
    },

    /** Keiner der Anbieter läuft auf diesem Gerät. */
    isOffline() {
      return false;
    },

    async chat(ref, opts = {}) {
      const target = registry.resolve(ref);
      const result = await ki.chat({ ...opts, model: target.model });
      return {
        ...result,
        provider: target.providerId,
        kind: target.kind,
        model: result.model || target.model,
        quelle: 'fern',
        vomStick: false,
      };
    },

    async embed() {
      throw new NoModelError('Die KI berechnet keine Einbettungen. Die Suche arbeitet mit Volltext.', { provider: providerId() });
    },

    installHint() {
      return ki && typeof ki.anleitung === 'function' ? ki.anleitung() : ANLEITUNG;
    },

    explain(headline) {
      return nichtVerbunden(headline).message;
    },
  };

  return registry;
}

module.exports = { createRegistry, PROVIDER_ID };
