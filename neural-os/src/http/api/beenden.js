'use strict';

/**
 * POST /api/system/beenden -- [Beenden] (Stick-Bauplan 2.4 Nr. 5, Teil 1.4).
 *
 * Ohne Fenster gibt es kein Strg+C mehr; wer fertig ist, tippt in der App auf
 * [Beenden]. Der Tresor wird gesichert, BEVOR die Antwort rausgeht: Die
 * Seite sagt danach "Gespeichert. Stick kann raus." (Mac: "... im Finder
 * auswerfen."), und das muss dann schon stimmen. Geschlossen wird erst, wenn
 * die Antwort beim Betriebssystem liegt -- sonst sähe der Browser einen
 * Abbruch statt der Zusage.
 *
 * Nur der Besitzer (am Gerät, mit PIN-Sitzung, falls gebunden); die
 * CSRF-Prüfung greift wie bei jeder ändernden Anfrage.
 *
 * Wie beendet wird, bestimmt der Einbettende:
 *   1. `ctx.beenden(grund)` -- der Dienst und `start` setzen es (app.close,
 *      Laufzettel freigeben, exit 0);
 *   2. sonst SIGTERM-Handler, per `process.emit` (unter Windows wäre ein
 *      echtes kill(SIGTERM) ein TerminateProcess ohne Aufräumen);
 *   3. sonst wenigstens `ctx.close()`.
 */

function herunterfahren(rc, grund) {
  const ctx = rc.ctx;
  try {
    if (typeof ctx.beenden === 'function') return Promise.resolve(ctx.beenden(grund));
    if (process.listenerCount('SIGTERM') > 0) {
      process.emit('SIGTERM', 'SIGTERM');
      return Promise.resolve();
    }
    if (typeof ctx.close === 'function') return Promise.resolve(ctx.close());
  } catch (err) {
    if (rc.log && rc.log.error) rc.log.error(`Beenden gescheitert: ${err && err.message}`);
  }
  return Promise.resolve();
}

function register(router) {
  router.post('/api/system/beenden', async (rc) => {
    rc.requireOwner('Neural OS zu beenden');
    const danach = process.platform === 'darwin' ? 'auswerfen' : 'abziehen';

    if (rc.ctx.store && typeof rc.ctx.store.flush === 'function') await rc.ctx.store.flush();
    if (rc.ctx.audit && typeof rc.ctx.audit.write === 'function') rc.ctx.audit.write('app.beenden', { via: 'knopf' });
    if (rc.ctx.bus && typeof rc.ctx.bus.publish === 'function') rc.ctx.bus.publish('app.beendet', { via: 'knopf', danach });

    let geplant = false;
    const planen = () => {
      if (geplant) return;
      geplant = true;
      // Ein Takt Luft, damit auch ein Keep-alive-Client die Antwort ganz liest.
      setTimeout(() => {
        herunterfahren(rc, 'knopf').catch((err) => {
          if (rc.log && rc.log.error) rc.log.error(`Beenden gescheitert: ${err && err.message}`);
        });
      }, 50);
    };
    rc.res.once('finish', planen);
    rc.res.once('close', planen);
    rc.json(202, { ok: true, danach });
  });
}

module.exports = { register };
