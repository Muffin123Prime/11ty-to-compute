'use strict';

/**
 * Modelle -- seit dem Wegfall der Offline-KI: Claude.
 *
 * `GET /api/models` liefert den Schnappschuss der Registry, der aus Claudes
 * Zustand abgeleitet ist (kein Netzverkehr). Ist Claude nicht verbunden,
 * steht die Anleitung dabei, wie man es verbindet -- "keine Modelle" ohne
 * Weg nach vorn wäre eine Sackgasse.
 *
 * Verbinden, trennen und das Modell wählen gehören nach /api/claude
 * (src/http/api/claude.js).
 *
 * `/api/models/remote` gab es für weitere Online-Anbieter (OpenAI, Mistral,
 * ein Server im Heimnetz …). Die KI von Neural OS ist Claude; diese Routen
 * sagen das jetzt, statt einen Anbieter anzulegen, den nichts mehr anspricht:
 * die Liste ist leer, jeder Schreibversuch bekommt 410 mit Satz.
 */

const { NeuralError } = require('../../kernel/errors');
const { needMethod } = require('./support');

const ENTFALLEN = 'Weitere Online-Anbieter gibt es nicht mehr: die KI von Neural OS ist Claude. '
  + 'Verbinden unter Einstellungen → Claude (POST /api/claude/schluessel).';

function entfallen() {
  throw new NeuralError('ENTFALLEN', ENTFALLEN, { status: 410 });
}

function decorate(registry, snapshot) {
  const providers = (snapshot && snapshot.providers) || [];
  const available = providers.some((p) => p.available);
  const out = {
    providers,
    at: (snapshot && snapshot.at) || null,
    available,
    probed: !!(snapshot && snapshot.at),
  };
  if (!available && typeof registry.installHint === 'function') {
    try { out.hint = registry.installHint(); } catch { out.hint = null; }
  }
  return out;
}

function register(router) {
  router.get('/api/models', (rc) => {
    rc.requireCapability('read');
    const registry = needMethod(rc.ctx.registry, 'list', 'Die Modellverwaltung', 'Ohne sie kann Claude nicht angesprochen werden.');
    return decorate(registry, registry.list());
  });

  router.post('/api/models/refresh', async (rc) => {
    rc.requireCapability('read');
    const registry = needMethod(rc.ctx.registry, 'refresh', 'Die Modellverwaltung');
    return decorate(registry, await registry.refresh());
  });

  router.get('/api/models/remote', (rc) => {
    rc.requireCapability('read');
    const config = rc.ctx.config || {};
    return {
      items: [],
      total: 0,
      presets: [],
      mode: (config.network && config.network.mode) || 'offline',
      advice: ENTFALLEN,
      entfallen: true,
    };
  });

  router.post('/api/models/remote', () => entfallen());
  router.patch('/api/models/remote/:id', () => entfallen());
  router.delete('/api/models/remote/:id', () => entfallen());
  router.post('/api/models/remote/:id/test', () => entfallen());
}

module.exports = { register, ENTFALLEN };
