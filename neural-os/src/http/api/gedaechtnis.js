'use strict';

/**
 * Das Gedaechtnis der KI: ansehen und vergessen (Einstellungen, Gruppe
 * "Gedächtnis", web/views/settings.js). Was hier steht, liest der Chat bei
 * jeder Antwort mit (src/models/chat.js gedaechtnisWahl).
 *
 *   GET  /api/gedaechtnis
 *        -> {items:[{id, text, fuerAlle, liestMit, createdAt, herkunft}], anzahl, mitgelesen}
 *        Neueste zuerst. `fuerAlle`: gilt fuer jeden Chat (scope global);
 *        sonst merkt es sich nur ein Agent. `liestMit`: der Chat liest es
 *        wirklich mit (bei sehr vielen zaehlen die neuesten). `herkunft`:
 *        {art:'chat'|'agent', titel, url} oder null (von dir).
 *   POST /api/gedaechtnis/vergessen {ids?:[...], alle?:true} -> {ids}
 *        Vergisst -- in den Papierkorb wie jedes Loeschen -- und gibt die
 *        Kennungen fuer [Rückgängig] zurueck.
 *   POST /api/gedaechtnis/zurueck {ids:[...]} -> {ids}
 *        Holt genau diese wieder.
 *
 * Einzeln vergessen ginge auch mit DELETE /api/records/:id; die
 * Sammelroute gibt es, damit "Alles vergessen" EIN Schritt ist und
 * [Rückgängig] genau diesen Schritt zuruecknimmt.
 */

const { ValidationError } = require('../../kernel/errors');
const { need, asObject, requireStringArray } = require('./support');
const { gedaechtnisWahl } = require('../../models/chat');

const MAX_IDS = 5000;

function herkunftVon(store, rec, cache) {
  const d = rec.data || {};
  const id = typeof d.sourceId === 'string' && d.sourceId ? d.sourceId : null;
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);
  let out = null;
  const quelle = store.get(id);
  if (quelle && quelle.type === 'chat') {
    out = { art: 'chat', id, titel: String((quelle.data && quelle.data.title) || 'Chat').slice(0, 120), url: `#/chat?id=${encodeURIComponent(id)}` };
  } else if (quelle && quelle.type === 'run') {
    out = { art: 'agent', id, titel: 'einem Agenten', url: `#/agents?id=${encodeURIComponent(id)}` };
  }
  cache.set(id, out);
  return out;
}

function register(router) {
  router.get('/api/gedaechtnis', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const alle = store.list('memory', { sort: 'createdAt', order: 'asc' }).items;
    const mit = new Set(gedaechtnisWahl(alle).map((m) => m.id));
    const cache = new Map();
    const items = alle.slice().reverse().map((m) => ({
      id: m.id,
      text: String((m.data && m.data.text) || ''),
      fuerAlle: !m.data.scope || m.data.scope === 'global',
      liestMit: mit.has(m.id),
      createdAt: m.createdAt,
      herkunft: herkunftVon(store, m, cache),
    }));
    return { items, anzahl: items.length, mitgelesen: mit.size };
  });

  router.post('/api/gedaechtnis/vergessen', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    let ids;
    if (body.alle === true) {
      ids = store.all('memory').map((m) => m.id);
    } else {
      ids = requireStringArray(body.ids, 'ids', { max: 80, maxItems: MAX_IDS });
      for (const id of ids) {
        const rec = store.get(id);
        if (!rec || rec.type !== 'memory') throw new ValidationError(`„${id}“ ist nichts Gemerktes.`);
      }
    }
    for (const id of ids) store.remove(id);
    return { ids };
  });

  router.post('/api/gedaechtnis/zurueck', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const ids = requireStringArray(body.ids, 'ids', { max: 80, maxItems: MAX_IDS });
    const zurueck = [];
    for (const id of ids) {
      const rec = store.get(id, { includeDeleted: true });
      if (!rec || rec.type !== 'memory') continue;
      if (rec.deletedAt) store.restore(id);
      zurueck.push(id);
    }
    return { ids: zurueck };
  });
}

module.exports = { register };
