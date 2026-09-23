'use strict';

/**
 * Die Modell-Registry -- seit dem Wegfall der Offline-KI ein dünner Mantel
 * um Claude.
 *
 * Warum es sie noch gibt
 * ----------------------
 * Mehrere Teilsysteme sprechen "ein Modell" über denselben kleinen Vertrag an
 * (`resolve`, `chat`, `list`): der Agentenlauf, der zweite Blick, der
 * Modellvergleich und die Erweiterungen (`model.use`). Diesen Vertrag an
 * einer Stelle zu halten ist billiger, als fünf Aufrufer umzubauen -- und er
 * bleibt ehrlich: "kein Modell" heißt jetzt "Claude ist nicht verbunden",
 * mit genau dem Satz, den auch die Oberfläche zeigt.
 *
 * Was sie NICHT mehr tut
 * ----------------------
 * - Sie sucht keine lokalen Modellserver mehr (11434/8080/1234). Die
 *   Einträge in `config.models.providers` werden nicht mehr gelesen.
 * - `refresh()` fragt kein Netz: Claudes Zustand ist aus Schlüssel, Tresor
 *   und Schleuse ableitbar (src/models/claude.js), und ein Probeaufruf je
 *   Seitenaufruf kostete Geld.
 * - Einbettungen gibt es nicht; Claude berechnet keine. Die Suche ist Volltext.
 */

const { NoModelError, ValidationError } = require('../kernel/errors');
const anbieter = require('./providers/anthropic');
const { ANLEITUNG } = require('./claude');

const PROVIDER_ID = 'claude';

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

/**
 * @param {{config:object, gate?:object, bus?:object, logger?:Function, claude?:object}} deps
 */
function createRegistry({ config, bus, logger, claude } = {}) {
  if (!config || typeof config !== 'object') {
    throw new ValidationError('Die Modell-Registry braucht eine Konfiguration.');
  }
  const log = typeof logger === 'function' ? logger('models') : nullLogger();
  let at = null;

  function zustand() {
    if (!claude || typeof claude.zustand !== 'function') {
      return { verbunden: false, grund: 'Claude ist in dieser Instanz nicht geladen.', grundCode: 'fehlt', schluesselVorhanden: false, modell: anbieter.STANDARD_MODELL };
    }
    return claude.zustand();
  }

  function eintrag() {
    const z = zustand();
    return {
      id: PROVIDER_ID,
      kind: anbieter.kind,
      baseUrl: claude && claude.basis ? claude.basis : anbieter.API_BASIS,
      remote: true,
      hasApiKey: !!z.schluesselVorhanden,
      quelle: 'fern',
      vomStick: false,
      label: 'Claude (Anthropic)',
      hinweis: z.verbunden ? null : z.grund,
      available: !!z.verbunden,
      models: Object.values(anbieter.MODELLE).map((m) => ({
        id: m.id, name: m.name, family: 'claude', contextLength: m.id === 'claude-haiku-4-5' ? 200000 : 1000000,
      })),
      error: z.verbunden ? null : z.grund,
      code: z.verbunden ? null : 'CLAUDE_NICHT_VERBUNDEN',
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
    // Alte Chats und Agenten nennen noch ein lokales Modell ("llama3.2").
    // Das gibt es nicht mehr; geantwortet wird mit Claude, und die Antwort
    // trägt, welches Modell es wirklich war.
    if (anbieter.istModell(wunsch)) return wunsch;
    return claude && typeof claude.modell === 'function' ? claude.modell() : anbieter.STANDARD_MODELL;
  }

  function nichtVerbunden(headline) {
    const z = zustand();
    const anleitung = claude && typeof claude.anleitung === 'function' ? claude.anleitung() : ANLEITUNG;
    return new NoModelError(
      [headline || z.grund || 'Claude ist nicht verbunden.', headline && z.grund ? z.grund : null, '', anleitung]
        .filter((x) => x !== null).join('\n').trim(),
      { grund: z.grundCode || null, provider: PROVIDER_ID },
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
        providerId: PROVIDER_ID,
        kind: anbieter.kind,
        baseUrl: claude.basis,
        model: modellAus(ref),
        quelle: 'fern',
        vomStick: false,
      };
    },

    /** Claude läuft nie auf diesem Gerät. */
    isOffline() {
      return false;
    },

    async chat(ref, opts = {}) {
      const target = registry.resolve(ref);
      const result = await claude.chat({ ...opts, model: target.model });
      return {
        ...result,
        provider: PROVIDER_ID,
        kind: anbieter.kind,
        model: result.model || target.model,
        quelle: 'fern',
        vomStick: false,
      };
    },

    async embed() {
      throw new NoModelError('Claude berechnet keine Einbettungen. Die Suche arbeitet mit Volltext.', { provider: PROVIDER_ID });
    },

    installHint() {
      return claude && typeof claude.anleitung === 'function' ? claude.anleitung() : ANLEITUNG;
    },

    explain(headline) {
      return nichtVerbunden(headline).message;
    },
  };

  return registry;
}

module.exports = { createRegistry, PROVIDER_ID };
