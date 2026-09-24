'use strict';

/**
 * Koppeln über HTTP (Bauplan 2.8). Nur für den Besitzer: Koppeln legt einen
 * Schlüssel auf einen fremden Stick, Entkoppeln löscht Postfächer, und
 * "eigenständig" gibt dieser KI eine neue Kennung. Ein geteilter Zugang
 * (iPad) darf nichts davon.
 *
 * Nie geht ein Schlüssel über HTTP: `status()` enthält keinen. Was sich
 * ändert, meldet der Dienst über den Bus (`kopplung.*`).
 */

const { ValidationError } = require('../../kernel/errors');
const { need, asObject, boolParam } = require('./support');

const WAS = 'Das Koppeln';

function kopplungOf(rc) {
  return need(rc.ctx.kopplung, WAS);
}

function kennung(value) {
  if (typeof value !== 'string' || !/^dev_[0-9a-f]{24}$/.test(value)) {
    throw new ValidationError('"id" muss die Kennung einer KI sein.');
  }
  return value;
}

function register(router) {
  /**
   * GET /api/kopplung[?suchen=1&leer=1]
   * -> {selbst:{id,name,pin,zwilling}, partner:[{id,name,zustand,zuletzt,steckt,ueber}],
   *     gefunden:[{pfad,id,name,pin,zustand,version,frei}], hinweis, fassungen}
   */
  router.get('/api/kopplung', async (rc) => {
    rc.requireOwner(WAS);
    const k = kopplungOf(rc);
    if (boolParam(rc.query, 'suchen', false)) {
      await k.finden({ leer: boolParam(rc.query, 'leer', false) });
      // Ein Partner, der an diesem Rechner läuft, kann ein Angebot abgelegt haben.
      await k.annehmen();
    }
    return k.status({ hinweisAbholen: true });
  });

  router.post('/api/kopplung/koppeln', async (rc) => {
    rc.requireOwner(WAS);
    const body = asObject(await rc.body());
    if (typeof body.pfad !== 'string' || !body.pfad.trim()) throw new ValidationError('"pfad" fehlt.');
    if (body.pin !== undefined && body.pin !== null && typeof body.pin !== 'string') throw new ValidationError('"pin" muss Text sein.');
    const k = kopplungOf(rc);
    await k.koppeln({ root: body.pfad, pin: body.pin || undefined });
    return k.status();
  });

  router.post('/api/kopplung/abgleichen', async (rc) => {
    rc.requireOwner(WAS);
    const k = kopplungOf(rc);
    const bericht = await k.abgleichen({ grund: 'hand' });
    return {
      ...k.status(),
      bericht: {
        uebernommen: bericht.uebernommen,
        konflikte: bericht.konflikte,
        kopien: bericht.kopien,
        zwilling: bericht.zwilling,
      },
    };
  });

  router.post('/api/kopplung/entkoppeln', async (rc) => {
    rc.requireOwner(WAS);
    const body = asObject(await rc.body());
    return kopplungOf(rc).entkoppeln(kennung(body.id));
  });

  router.post('/api/kopplung/eigenstaendig', async (rc) => {
    rc.requireOwner(WAS);
    return kopplungOf(rc).eigenstaendig();
  });
}

module.exports = { register };
