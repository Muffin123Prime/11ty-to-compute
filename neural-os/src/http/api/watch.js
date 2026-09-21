'use strict';

/**
 * Beobachtete Ordner über HTTP.
 *
 * Who may do what, and why
 * ------------------------
 * Reading the list and the log needs `read`; everything that creates a folder,
 * changes it or switches it on needs `requireOwner`. That is the same line
 * src/http/api/network.js draws around egress grants, drawn for the same
 * reason: a shared read token hands somebody a view of this vault, not the
 * ability to point the program at a directory on this machine and pull it in.
 * A guest who can add `/` as a watched folder has read the whole disk.
 *
 * Why `GET /api/watch/:id/log` exists at all
 * ------------------------------------------
 * It is the list „das habe ich aufgenommen". Without it the feature is exactly
 * the invisible automation it was written not to be: files appear in the vault
 * and nothing can say where they came from or what was passed over. The route
 * is therefore not a convenience -- it is the half that makes the other half
 * defensible, and it reports skipped files WITH the reason, not just counts.
 *
 * Why the scan route needs the owner too, even for a dry run
 * ----------------------------------------------------------
 * A dry run does not write anything, but it does read a directory listing off
 * this machine and report the file names back. That is information about the
 * computer, not about the vault.
 */

const {
  needMethod,
  asObject,
  requireString,
  optionalString,
  requireStringArray,
  intParam,
} = require('./support');
const { ValidationError } = require('../../kernel/errors');

function watcherOf(rc, method = 'list') {
  return needMethod(
    rc.ctx.watcher,
    method,
    'Die Ordnerbeobachtung',
    'Ohne sie kann dieses Gerät keine Ordner lesen – und behauptet es auch nicht.',
  );
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new ValidationError(`"${field}" muss true oder false sein.`);
  return value;
}

function positiveInt(value, field, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError(`"${field}" muss eine ganze Zahl ab 1 sein.`);
  if (n > max) throw new ValidationError(`"${field}" ist zu groß (erlaubt sind bis ${max}).`);
  return n;
}

function register(router) {
  router.get('/api/watch', (rc) => {
    rc.requireCapability('read');
    const watcher = watcherOf(rc);
    const items = watcher.list();
    return {
      items,
      status: typeof watcher.status === 'function' ? watcher.status() : null,
      // The interface offers these as the default filter; shipping them with
      // the list keeps the two from drifting apart.
      lesbareEndungen: Array.isArray(watcher.READABLE_EXTENSIONS) ? watcher.READABLE_EXTENSIONS : [],
    };
  });

  router.post('/api/watch', async (rc) => {
    rc.requireOwner('Einen Ordner zu beobachten');
    const watcher = watcherOf(rc, 'add');
    const body = asObject(await rc.body());

    const input = { path: requireString(body.path, 'path', { max: 1000 }) };
    const label = optionalString(body.label, 'label', { max: 200 });
    if (label) input.label = label;
    if (body.recursive !== undefined) input.recursive = bool(body.recursive, 'recursive');
    if (body.extensions !== undefined) {
      input.extensions = requireStringArray(body.extensions, 'extensions', { maxItems: 60, max: 20 });
    }
    if (body.tags !== undefined) input.tags = requireStringArray(body.tags, 'tags', { maxItems: 20, max: 60 });
    if (body.maxFileBytes !== undefined && body.maxFileBytes !== null) {
      input.maxFileBytes = positiveInt(body.maxFileBytes, 'maxFileBytes', 256 * 1024 * 1024);
    }
    // `enabled` is deliberately not read from the body: a folder is switched
    // on in its own request, so that act has its own confirmation and its own
    // line in the log.
    const record = watcher.add(input);
    return { record };
  });

  router.patch('/api/watch/:id', async (rc) => {
    rc.requireOwner('Einen beobachteten Ordner zu ändern');
    const watcher = watcherOf(rc, 'update');
    const body = asObject(await rc.body());

    const patch = {};
    if (body.path !== undefined) patch.path = requireString(body.path, 'path', { max: 1000 });
    if (body.label !== undefined) patch.label = optionalString(body.label, 'label', { max: 200 }) || '';
    if (body.enabled !== undefined) patch.enabled = bool(body.enabled, 'enabled');
    if (body.recursive !== undefined) patch.recursive = bool(body.recursive, 'recursive');
    if (body.extensions !== undefined) {
      patch.extensions = requireStringArray(body.extensions, 'extensions', { maxItems: 60, max: 20 });
    }
    if (body.tags !== undefined) patch.tags = requireStringArray(body.tags, 'tags', { maxItems: 20, max: 60 });
    if (body.maxFileBytes !== undefined && body.maxFileBytes !== null) {
      patch.maxFileBytes = positiveInt(body.maxFileBytes, 'maxFileBytes', 256 * 1024 * 1024);
    }
    if (!Object.keys(patch).length) throw new ValidationError('Es wurde keine Änderung übergeben.');
    return { record: watcher.update(rc.params.id, patch) };
  });

  router.delete('/api/watch/:id', (rc) => {
    rc.requireOwner('Einen beobachteten Ordner zu entfernen');
    const watcher = watcherOf(rc, 'remove');
    const record = watcher.remove(rc.params.id);
    return {
      record,
      // Said out loud, because the opposite would be a reasonable guess.
      hinweis: 'Der Ordner wird nicht mehr beobachtet. Die bereits aufgenommenen Dateien bleiben im Tresor.',
    };
  });

  router.post('/api/watch/:id/scan', async (rc) => {
    rc.requireOwner('Einen Ordner zu durchsuchen');
    const watcher = watcherOf(rc, 'scan');
    const body = asObject(await rc.body());
    const dryRun = body.dryRun === undefined ? false : bool(body.dryRun, 'dryRun');
    return watcher.scan(rc.params.id, { dryRun });
  });

  router.get('/api/watch/:id/log', (rc) => {
    rc.requireCapability('read');
    const watcher = watcherOf(rc, 'log');
    return watcher.log(rc.params.id, { limit: intParam(rc.query, 'limit', 100, 1, 500) });
  });
}

module.exports = { register };
