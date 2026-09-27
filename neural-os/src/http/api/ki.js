'use strict';

/**
 * Die KI wählen und verbinden: Gemini (kostenlos) oder Claude.
 *
 *   GET    /api/ki                         -> Zustand beider Anbieter + der aktive (fragt NIE das Netz)
 *   POST   /api/ki/:anbieter/schluessel    { schluessel } -> prüft mit Probeaufruf, speichert im Tresor
 *   DELETE /api/ki/:anbieter/schluessel    -> vergisst den Schlüssel
 *   PATCH  /api/ki                         { anbieter?, modell? }
 *
 * `/api/ki/name` (Name dieser KI) liegt in src/http/api/system.js und ist
 * etwas anderes: die Identität dieses Sticks, nicht der Anbieter.
 *
 * Die alten Routen unter /api/claude (src/http/api/claude.js) bleiben als
 * Alias auf den Claude-Dienst bestehen. Der Schlüssel geht nur hinein, nie
 * heraus; schreiben dürfen nur Zugänge am Gerät selbst (Owner).
 */

const { asObject } = require('./support');
const { NeuralError } = require('../../kernel/errors');

function kiVon(rc) {
  const k = rc.ctx.kiDienst;
  if (!k || typeof k.zustand !== 'function') {
    throw new NeuralError('SUBSYSTEM_UNAVAILABLE', 'Die KI ist in dieser Instanz nicht geladen. Neural OS kann deshalb nicht antworten.', { status: 503 });
  }
  return k;
}

function register(router) {
  router.get('/api/ki', (rc) => {
    rc.requireCapability('read');
    return kiVon(rc).zustand();
  });

  router.post('/api/ki/:anbieter/schluessel', async (rc) => {
    rc.requireOwner('Der KI-Schlüssel');
    const ki = kiVon(rc);
    const body = asObject(await rc.body());
    const controller = new AbortController();
    // Wer den Tab schliesst, bricht die Pruefung ab; ein fertiger Aufruf nicht mehr.
    rc.res.on('close', () => { if (!rc.res.writableEnded) controller.abort(); });
    const zustand = await ki.schluesselSpeichern(rc.params.anbieter, body.schluessel, { signal: controller.signal });
    return { ok: true, ...zustand };
  });

  router.delete('/api/ki/:anbieter/schluessel', (rc) => {
    rc.requireOwner('Der KI-Schlüssel');
    const r = kiVon(rc).schluesselLoeschen(rc.params.anbieter);
    return { ok: true, geloescht: r.geloescht, ...r.zustand };
  });

  router.patch('/api/ki', async (rc) => {
    rc.requireOwner('Die Wahl der KI');
    const body = asObject(await rc.body());
    return kiVon(rc).setzen({ anbieter: body.anbieter, modell: body.modell });
  });
}

module.exports = { register };
