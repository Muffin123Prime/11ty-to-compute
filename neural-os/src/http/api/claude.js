'use strict';

/**
 * Claude verbinden, trennen, Modell wählen (Vertrag 5).
 *
 *   GET    /api/claude             -> Zustand (fragt NIE das Netz)
 *   POST   /api/claude/schluessel  { schluessel } -> prüft mit Probeaufruf, speichert im Tresor
 *                                   (ein Google-Schlüssel AQ.… oder AIza… verbindet Gemini)
 *   DELETE /api/claude/schluessel  -> vergisst den Schlüssel
 *   PATCH  /api/claude             { modell } -> claude-opus-5 | claude-sonnet-5 | claude-haiku-4-5
 *
 * Der Schlüssel geht nur hinein, nie heraus: keine Antwort dieser Routen
 * enthält ihn, auch keine Fehlermeldung. Schreiben dürfen nur Zugänge am
 * Gerät selbst (Owner), denn ein Schlüssel kostet Geld und bestimmt, wohin
 * die Gespräche gehen.
 *
 * Jede Änderung meldet sich als Bus-Ereignis `claude.*` -- darauf frischt die
 * Schale den Status auf.
 */

const { asObject } = require('./support');
const { NeuralError } = require('../../kernel/errors');
const { anbieterVonSchluessel } = require('../../models/ki');

function claudeVon(rc) {
  const c = rc.ctx.claude;
  if (!c || typeof c.zustand !== 'function') {
    throw new NeuralError(
      'SUBSYSTEM_UNAVAILABLE',
      'Claude ist in dieser Instanz nicht geladen. Neural OS kann deshalb nicht antworten.',
      { status: 503 },
    );
  }
  return c;
}

function register(router) {
  router.get('/api/claude', (rc) => {
    rc.requireCapability('read');
    return claudeVon(rc).zustand();
  });

  router.post('/api/claude/schluessel', async (rc) => {
    rc.requireOwner('Der Claude-Schlüssel');
    const claude = claudeVon(rc);
    const body = asObject(await rc.body());
    const controller = new AbortController();
    // Wer den Tab schliesst, bricht die Pruefung ab; ein fertiger Aufruf nicht mehr.
    rc.res.on('close', () => { if (!rc.res.writableEnded) controller.abort(); });
    // Ein Google-Schlüssel (AQ.… oder AIza…) im Claude-Feld -- etwa aus einem Tab, der
    // noch die Oberfläche von vor Gemini zeigt: Er verbindet Gemini, und
    // Gemini antwortet ab dann, wie bei POST /api/ki/claude/schluessel. Die
    // Antwort ist der Zustand der KI, die jetzt antwortet.
    const ki = rc.ctx.kiDienst;
    if (ki && typeof ki.schluesselSpeichern === 'function' && anbieterVonSchluessel(body.schluessel) === 'gemini') {
      const z = await ki.schluesselSpeichern('claude', body.schluessel, { signal: controller.signal, aktivieren: true });
      const { anbieter, ...ohneListe } = z;
      return { ok: true, ...ohneListe, umgeleitet: 'gemini' };
    }
    const zustand = await claude.schluesselSpeichern(body.schluessel, { signal: controller.signal });
    return { ok: true, ...zustand };
  });

  router.delete('/api/claude/schluessel', (rc) => {
    rc.requireOwner('Der Claude-Schlüssel');
    const r = claudeVon(rc).schluesselLoeschen();
    return { ok: true, geloescht: r.geloescht, ...r.zustand };
  });

  router.patch('/api/claude', async (rc) => {
    rc.requireOwner('Das Claude-Modell');
    const body = asObject(await rc.body());
    return claudeVon(rc).modellSetzen(body.modell);
  });
}

module.exports = { register };
