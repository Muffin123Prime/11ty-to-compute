'use strict';

/**
 * Model backends.
 *
 * `GET /api/models` returns the last probe result and never probes: opening
 * the interface must not wait on a backend that may be down. `POST
 * /api/models/refresh` is the explicit "look again", with a timeout, because a
 * probe that hangs would otherwise hold an HTTP connection for minutes.
 *
 * When nothing is reachable the answer carries the registry's own German
 * setup instructions instead of an empty list. "Keine Modelle" without a way
 * forward is a dead end; naming what was probed and how to install Ollama is
 * the difference between a bug report and a solved afternoon.
 */

const { needMethod, intParam } = require('./support');

function installHint(registry) {
  if (typeof registry.installHint !== 'function') return null;
  try {
    return registry.installHint();
  } catch {
    return null;
  }
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
  if (!available) out.hint = installHint(registry);
  return out;
}

function register(router) {
  router.get('/api/models', (rc) => {
    rc.requireCapability('read');
    const registry = needMethod(
      rc.ctx.registry,
      'list',
      'Die Modellverwaltung',
      'Ohne sie kann kein Modell gefunden oder angesprochen werden.',
    );
    return decorate(registry, registry.list());
  });

  router.post('/api/models/refresh', async (rc) => {
    rc.requireCapability('read');
    const registry = needMethod(rc.ctx.registry, 'refresh', 'Die Modellverwaltung');
    const timeoutMs = intParam(rc.query, 'timeoutMs', 1500, 100, 30000);
    const snapshot = await registry.refresh({ timeoutMs });
    return decorate(registry, snapshot);
  });
}

module.exports = { register };
