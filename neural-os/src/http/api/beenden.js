'use strict';

/**
 * POST /api/system/beenden -- [Beenden] (Stick-Bauplan 2.4 Nr. 5, Teil 1.4).
 *
 * Ohne Fenster gibt es kein Strg+C mehr; wer fertig ist, tippt in der App auf
 * [Beenden]. Der Tresor wird gesichert und der letzte Abgleich mit den
 * gekoppelten Sticks geschrieben, BEVOR die Antwort rausgeht: Die
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
 *
 * Paket M: Läuft Neural OS am Mac vom Stick und kann der Mac ihn auswerfen
 * (`diskutil info`: Ejectable), startet beim Beenden ein abgelöster Helfer
 * des Systems, der auswirft, sobald der Dienst weg ist. Die Antwort sagt dann
 * `danach: 'auswerfen-auto'`, und die Seite: „Gespeichert. Stick kann raus,
 * sobald er aus dem Finder verschwindet.“ Sonst bleibt es bei `auswerfen`
 * („… Stick im Finder auswerfen.“). Windows: `abziehen` -- dort ist
 * „Schnelles Entfernen“ die Voreinstellung für USB-Sticks, und PowerShell
 * kann auf Schulrechnern gesperrt sein (Bauplan, Teil 3).
 */

const { describePortable } = require('../../kernel/paths');

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
    const plattform = rc.ctx.plattform || process.platform;
    let danach = plattform === 'darwin' ? 'auswerfen' : 'abziehen';

    // Paket M: Kann der Mac den Stick, von dem Neural OS läuft, selbst auswerfen?
    let auswurf = null;
    if (plattform === 'darwin') {
      const stickMod = require('../../portable/stick');
      const portable = describePortable(rc.ctx.portable);
      const wurzel = portable && portable.root ? stickMod.aufbauVon(portable.root).wurzel : null;
      if (wurzel) {
        const pruefen = typeof rc.ctx.macAuswerfbar === 'function' ? rc.ctx.macAuswerfbar : stickMod.macAuswerfbar;
        try {
          auswurf = await pruefen(wurzel, { platform: plattform });
        } catch (err) {
          auswurf = null;
          if (rc.log && rc.log.warn) rc.log.warn(`Auswerfen nicht prüfbar: ${err && err.message}`);
        }
        if (auswurf && auswurf.punkt) danach = 'auswerfen-auto';
      }
    }

    // Der letzte Abgleich (Postfächer auf diesem und dem Partner-Stick,
    // kopplungen.json, sync-folder.json) gehört VOR die Zusage: Wer auf
    // "Stick kann raus." hin zieht, zöge sonst mitten in rename und fsync
    // (Prüfung Runde 2). Ein zweiter Aufruf in app.close() tut nichts mehr.
    if (rc.ctx.kopplung && typeof rc.ctx.kopplung.beenden === 'function') {
      try {
        await rc.ctx.kopplung.beenden();
      } catch (err) {
        if (rc.log && rc.log.warn) rc.log.warn(`Letzter Abgleich beim Beenden: ${err && err.message}`);
      }
    }
    if (rc.ctx.store && typeof rc.ctx.store.flush === 'function') await rc.ctx.store.flush();
    if (rc.ctx.audit && typeof rc.ctx.audit.write === 'function') rc.ctx.audit.write('app.beenden', { via: 'knopf' });
    if (rc.ctx.bus && typeof rc.ctx.bus.publish === 'function') rc.ctx.bus.publish('app.beendet', { via: 'knopf', danach });

    let geplant = false;
    const planen = () => {
      if (geplant) return;
      geplant = true;
      // Der Helfer wartet, bis dieser Prozess weg ist, und wirft dann aus.
      if (danach === 'auswerfen-auto') {
        const stickMod = require('../../portable/stick');
        const starten = typeof rc.ctx.auswerfenNachEnde === 'function' ? rc.ctx.auswerfenNachEnde : stickMod.auswerfenNachEnde;
        try {
          starten({ pid: process.pid, punkt: auswurf.punkt });
        } catch (err) {
          if (rc.log && rc.log.warn) rc.log.warn(`Der Helfer zum Auswerfen ließ sich nicht starten: ${err && err.message}`);
        }
      }
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
