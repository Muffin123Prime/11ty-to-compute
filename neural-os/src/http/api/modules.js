'use strict';

/**
 * The extension system's HTTP surface: install, inspect, enable, disable,
 * roll back and remove the modules the user pasted into the workshop.
 *
 * Five decisions shape this file.
 *
 * **1. A refused install answers with a report, not with a sentence.**
 * The normal case here is pasted code that does not work yet. `registry`
 * deliberately does not throw for that -- problems are data -- so this route
 * runs `validate()` first and, when it says no, refuses with the whole report
 * in `details.validation`. The workshop then renders exactly the same panel
 * for "Prüfen" and for a failed "Installieren", including the line numbers.
 * The cost is one extra dry run; the gain is that the user is never told only
 * "ging nicht".
 *
 * **2. `source.js` exists because of the Content-Security-Policy.**
 * `script-src 'self'` means the interface may not `eval` a module and may not
 * import one from a `blob:` URL. Both are how a plugin system is usually
 * built, and both are blocked here -- on purpose, because that same policy is
 * what stops a module from loading code off the internet. The way through is
 * to serve the source from this server as a real JavaScript document, so the
 * interface can `import()` it from its own origin like any other file. That is
 * why this one route answers with JavaScript instead of JSON.
 *
 * **3. Only UI modules are served that way.** A server module never runs in
 * the browser, so handing its source to the browser buys nothing and would
 * quietly widen what a read-only guest can pull out of the machine.
 *
 * **4. `modules` is its own token permission.** `write` is about records.
 * Installing, changing, rolling back or enabling a module means running code
 * the user pasted on this machine, which is a different kind of act, so a
 * device connected over the LAN share needs its own grant for it. Reading the
 * list needs `read`; switching a module OFF needs only `write`, because the
 * safe direction must never be harder than the dangerous one.
 *
 * **5. A missing registry is a 503, never a crash.** The module subsystem is
 * optional in the assembly (`src/app.js` builds it last and tolerates its
 * absence). Every route here says so in German instead of throwing on
 * `undefined` -- except the capability catalogue, which is a static list and
 * therefore answers even when nothing else about modules works.
 */

const path = require('node:path');

const {
  NeuralError,
  ValidationError,
  PermissionError,
} = require('../../kernel/errors');
const capabilities = require('../../modules/capabilities');
const {
  need,
  needMethod,
  asObject,
  requireString,
  optionalString,
  requireStringArray,
} = require('./support');

/** Module kinds the schema knows. Anything else is a typo, not a feature. */
const KINDS = new Set(['ui', 'server']);

/**
 * Generous for hand-written code, small enough that a mis-paste (a whole log
 * file, a binary) is refused with a sentence instead of being dry-run.
 */
const MAX_SOURCE_CHARS = 512 * 1024;

const MAX_NOTE_CHARS = 500;
const MAX_FILE_ROOTS = 20;

/** Metadata a PATCH may change without touching the code. */
const META_FIELDS = ['name', 'description', 'fileRoots'];

/* ------------------------------------------------------------- plumbing */

function audit(rc, kind, data) {
  const writer = rc.ctx.audit;
  if (!writer || typeof writer.write !== 'function') return;
  const identity = rc.identity || {};
  try {
    writer.write(kind, { ...data, actor: identity.kind || 'unknown', tokenId: identity.tokenId || null });
  } catch {
    // An audit that cannot be written must not cost the user the action it
    // was describing; the Audit class already reports its own failures.
  }
}

/** The module registry, or a 503 naming it. */
function registryOf(rc) {
  return needMethod(
    rc.ctx.modules,
    'list',
    'Die Modulverwaltung',
    'Die Erweiterungen konnten beim Start nicht geladen werden – ohne sie lassen sich keine Module ansehen oder installieren. Einzelheiten stehen im Serverprotokoll.',
  );
}

/**
 * Installing, changing or enabling a module runs pasted code on this machine.
 * `rc.requireCapability` does not know that word, so its generic refusal is
 * replaced by one that names the switch the user has to flip.
 */
function requireModules(rc) {
  try {
    rc.requireCapability('modules');
  } catch (err) {
    if (err instanceof PermissionError) {
      throw new PermissionError(
        'Dieser Zugang darf keine Module installieren, ändern oder aktivieren. '
        + 'Dafür braucht das Zugangstoken die Berechtigung "Module", die du in den Einstellungen '
        + 'unter "Freigabe" beim Anlegen eines Tokens vergibst. Ansehen darfst du die Module weiterhin.',
        { capability: 'modules' },
      );
    }
    throw err;
  }
}

/** Every route that changes a module needs both grants. */
function requireModuleWrite(rc) {
  rc.requireCapability('write');
  requireModules(rc);
}

function notFound(id) {
  // Same code and status as NotFoundError, but a sentence the user can read.
  return new NeuralError('NOT_FOUND', `Es gibt kein Modul mit der Kennung "${id}".`, {
    status: 404,
    details: { id },
  });
}

/**
 * The `data` of a module record. A registry that hands back something else has
 * a bug, and pretending otherwise would produce a confusing 500 three lines
 * later instead of a sentence naming the real problem.
 */
function dataOf(record, id) {
  if (!record || typeof record !== 'object' || !record.data || typeof record.data !== 'object') {
    throw new NeuralError(
      'MODULE_RECORD_BROKEN',
      `Der Eintrag zum Modul "${id}" hat nicht die erwartete Form. Das ist ein Fehler in Neural OS, nicht in deinem Modul.`,
      { status: 500, details: { id } },
    );
  }
  return record.data;
}

/** Fetch a module or answer 404. Errors the registry raises pass through. */
function mustGetModule(registry, id) {
  if (typeof registry.get !== 'function') {
    throw new NeuralError('SUBSYSTEM_UNAVAILABLE', 'Die Modulverwaltung kann einzelne Module nicht nachschlagen.', { status: 503 });
  }
  const record = registry.get(id);
  if (!record) throw notFound(id);
  return record;
}

/**
 * What the interface shows next to a module: which capabilities it holds, in
 * plain German, and how loud the enable dialog has to be.
 */
function describeModule(data) {
  const list = Array.isArray(data.capabilities) ? data.capabilities : [];
  const kind = KINDS.has(data.kind) ? data.kind : 'server';
  return {
    capabilities: list,
    risk: capabilities.riskOf(list),
    text: capabilities.describe(list, kind),
  };
}

/**
 * The list view needs every module, but not every past version of every
 * module -- the history of a file the user edits all afternoon is by far the
 * biggest thing in the vault. Past versions are reduced to their metadata;
 * `GET /api/modules/:id` still hands out the full history with its sources.
 */
function summarise(record, id) {
  const data = dataOf(record, id);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  return {
    ...record,
    data: {
      ...data,
      versions: versions.map((entry) => ({
        version: entry && entry.version,
        at: (entry && entry.at) || null,
        note: (entry && entry.note) || '',
        bytes: entry && typeof entry.source === 'string' ? Buffer.byteLength(entry.source, 'utf8') : 0,
      })),
    },
  };
}

/* ---------------------------------------------------------- input readers */

function readSource(body) {
  // `trim: false`: the source is handed to a compiler, and a line number in a
  // problem report has to match what the user sees in the editor.
  return requireString(body.source, 'source', { max: MAX_SOURCE_CHARS, trim: false });
}

function readKind(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw new ValidationError('"kind" fehlt. Möglich sind "ui" (Oberfläche) und "server".');
  }
  const kind = requireString(value, 'kind', { max: 20 });
  if (!KINDS.has(kind)) {
    throw new ValidationError(`"${kind}" ist keine Modul-Art. Möglich sind "ui" (Oberfläche) und "server".`);
  }
  return kind;
}

function readNote(body) {
  const note = optionalString(body.note, 'note', { max: MAX_NOTE_CHARS });
  return note === null ? '' : note;
}

/**
 * Folders a module may read or write. Checked here only for shape -- the real
 * containment (realpath, symlink resolution) belongs to the sandbox, which is
 * the only place that can do it without a race.
 */
function readFileRoots(value) {
  const roots = requireStringArray(value, 'fileRoots', { maxItems: MAX_FILE_ROOTS, max: 1024 });
  return roots.map((root) => {
    if (root.includes('\0')) throw new ValidationError('Ein Ordnerpfad enthält ein ungültiges Zeichen.');
    if (!path.isAbsolute(root)) {
      throw new ValidationError(
        `"${root}" ist kein vollständiger Pfad. Gib den Ordner von ganz oben an, z. B. /home/du/Dokumente.`,
      );
    }
    if (root.split(/[\\/]+/).includes('..')) {
      throw new ValidationError(`"${root}" enthält "..". Gib den Ordner direkt an.`);
    }
    return path.normalize(root);
  });
}

/* ------------------------------------------------------------------ routes */

function register(router) {
  /*
   * Order matters: the router takes the FIRST pattern that matches, so every
   * literal third segment has to be registered before `/api/modules/:id`,
   * otherwise "capabilities" and "validate" would be read as module ids.
   */

  /**
   * The capability catalogue. Deliberately independent of the registry: the
   * workshop must be able to explain what a permission means even on an
   * instance where the module subsystem failed to start.
   */
  router.get('/api/modules/capabilities', (rc) => {
    rc.requireCapability('read');
    return {
      items: capabilities.CAPABILITIES,
      byKind: {
        ui: capabilities.forKind('ui').map((c) => c.id),
        server: capabilities.forKind('server').map((c) => c.id),
      },
    };
  });

  router.get('/api/modules', (rc) => {
    rc.requireCapability('read');
    const registry = registryOf(rc);
    const records = registry.list() || [];
    const items = records.map((record) => summarise(record, record && record.id));
    return {
      items,
      total: items.length,
      status: typeof registry.status === 'function' ? registry.status() : null,
      descriptions: Object.fromEntries(items.map((item) => [item.id, describeModule(item.data)])),
    };
  });

  /**
   * The "Prüfen" button. Compiles, reads the manifest, checks the requested
   * capabilities and dry-runs `setup()` -- and installs NOTHING. Needs the
   * module permission all the same: a dry run executes the pasted code.
   */
  router.post('/api/modules/validate', async (rc) => {
    requireModuleWrite(rc);
    const registry = needMethod(registryOf(rc), 'validate', 'Die Modulprüfung');
    const body = asObject(await rc.body());
    const source = readSource(body);
    const kind = readKind(body.kind);

    const validation = await registry.validate(source, { kind });
    audit(rc, 'module.validate', { kind: kind || null, ok: !!(validation && validation.ok), bytes: source.length });
    return { ok: !!(validation && validation.ok), installed: false, validation };
  });

  /**
   * Install. The module is stored disabled: pasting code and running it are
   * two separate acts, and the second one shows the permissions first.
   */
  router.post('/api/modules', async (rc) => {
    requireModuleWrite(rc);
    const registry = needMethod(registryOf(rc), 'install', 'Die Modulverwaltung');
    const body = asObject(await rc.body());
    const source = readSource(body);
    const kind = readKind(body.kind);
    const note = readNote(body);

    if (typeof registry.validate === 'function') {
      const validation = await registry.validate(source, { kind });
      if (!validation || validation.ok !== true) {
        const problems = (validation && Array.isArray(validation.problems) ? validation.problems : [])
          .map((p) => (typeof p === 'string' ? p : (p && p.message) || '')).filter(Boolean);
        audit(rc, 'module.install.refused', { problems: problems.length });
        throw new NeuralError(
          'MODULE_INVALID',
          problems.length
            ? `Das Modul wurde NICHT installiert. ${problems.length === 1 ? 'Ein Problem' : `${problems.length} Probleme`}: ${problems[0]}`
            : 'Das Modul wurde NICHT installiert; die Prüfung ist fehlgeschlagen.',
          { status: 400, details: { validation } },
        );
      }
    }

    const result = await registry.install({ source, note });
    const record = (result && result.record) || result;
    audit(rc, 'module.installed', { id: record && record.id, kind: kind || null, bytes: source.length, note });
    return {
      installed: true,
      record,
      validation: (result && result.validation) || null,
      description: record ? describeModule(dataOf(record, record.id)) : null,
    };
  });

  router.get('/api/modules/:id', (rc) => {
    rc.requireCapability('read');
    const registry = registryOf(rc);
    const record = mustGetModule(registry, rc.params.id);
    return { record, description: describeModule(dataOf(record, rc.params.id)) };
  });

  /**
   * Change the code or the metadata of an installed module.
   *
   * A new `source` goes through `registry.update`, which keeps the old version
   * for rollback and switches the module off until it is enabled again. New
   * `fileRoots` switch a RUNNING module off too: the instance was built with
   * the old folders, so leaving it running would make the settings screen lie
   * about what it may reach.
   */
  router.patch('/api/modules/:id', async (rc) => {
    requireModuleWrite(rc);
    const registry = registryOf(rc);
    const id = rc.params.id;
    const before = mustGetModule(registry, id);
    const beforeData = dataOf(before, id);
    const body = asObject(await rc.body());

    const hasSource = Object.prototype.hasOwnProperty.call(body, 'source');
    const meta = {};
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      meta.name = requireString(body.name, 'name', { max: 200 });
    }
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      const description = optionalString(body.description, 'description', { max: 2000 });
      meta.description = description === null ? '' : description;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'fileRoots')) {
      meta.fileRoots = readFileRoots(body.fileRoots);
    }
    if (!hasSource && !Object.keys(meta).length) {
      throw new ValidationError(
        `Es wurde nichts zum Ändern übergeben. Möglich sind: source, ${META_FIELDS.join(', ')}.`,
      );
    }

    const notes = [];
    let record = before;

    if (hasSource) {
      needMethod(registry, 'update', 'Die Modulverwaltung');
      const source = readSource(body);
      const result = await registry.update(id, { source, note: readNote(body) });
      record = (result && result.record) || result || mustGetModule(registry, id);
      notes.push('Der neue Quelltext ist gespeichert. Die alte Fassung bleibt im Verlauf. Aktiviere das Modul erneut, damit die Änderung läuft.');
      audit(rc, 'module.updated', { id, bytes: source.length });
    }

    let disabledForChange = false;
    if (Object.keys(meta).length) {
      const store = need(rc.ctx.store, 'Der Speicher');
      const rootsChanged = meta.fileRoots !== undefined
        && JSON.stringify(meta.fileRoots) !== JSON.stringify(beforeData.fileRoots || []);
      const stillRunning = dataOf(record, id).enabled === true;
      if (rootsChanged && stillRunning && typeof registry.disable === 'function') {
        await registry.disable(id);
        disabledForChange = true;
        notes.push('Das Modul wurde ausgeschaltet, weil sich die freigegebenen Ordner geändert haben. Es liefe sonst noch mit den alten weiter.');
      }
      record = store.update(id, meta);
      audit(rc, 'module.meta', { id, fields: Object.keys(meta) });
    }

    return {
      record,
      description: describeModule(dataOf(record, id)),
      disabledForChange,
      notes,
    };
  });

  /**
   * Turn a module on. This is the moment pasted code really runs.
   *
   * `capabilities` in the body is the user's confirmation of what the enable
   * dialog showed them. It is compared against what the record actually asks
   * for, because between the dialog and the click the source may have been
   * replaced -- and then the user would be granting something they never saw.
   */
  router.post('/api/modules/:id/enable', async (rc) => {
    requireModuleWrite(rc);
    const registry = needMethod(registryOf(rc), 'enable', 'Die Modulverwaltung');
    const id = rc.params.id;
    const record = mustGetModule(registry, id);
    const data = dataOf(record, id);
    const body = asObject(await rc.body());

    if (body.capabilities !== undefined && body.capabilities !== null) {
      const confirmed = requireStringArray(body.capabilities, 'capabilities', { maxItems: 50, max: 100 });
      const wanted = Array.isArray(data.capabilities) ? data.capabilities : [];
      const missing = wanted.filter((c) => !confirmed.includes(c));
      const extra = confirmed.filter((c) => !wanted.includes(c));
      if (missing.length || extra.length) {
        throw new ValidationError(
          'Die bestätigten Berechtigungen passen nicht zu denen, die das Modul verlangt. '
          + 'Wahrscheinlich hat sich der Quelltext geändert, seit der Dialog geöffnet wurde. '
          + 'Schließe ihn und prüfe das Modul noch einmal.'
          + (missing.length ? ` Nicht bestätigt: ${missing.join(', ')}.` : '')
          + (extra.length ? ` Zusätzlich bestätigt: ${extra.join(', ')}.` : ''),
          { wanted, confirmed },
        );
      }
    }

    const outcome = await registry.enable(id);
    const after = mustGetModule(registry, id);
    const afterData = dataOf(after, id);
    audit(rc, 'module.enabled', { id, capabilities: afterData.capabilities || [], risk: capabilities.riskOf(afterData.capabilities) });
    return {
      record: after,
      enabled: afterData.enabled === true,
      description: describeModule(afterData),
      // What the module actually put into the system (tools, routes, views),
      // when the registry reports it. Never invented when it does not.
      registered: (outcome && typeof outcome === 'object' && outcome.registered) || null,
    };
  });

  /**
   * Turn a module off. Needs `write` but NOT `modules`: switching something
   * off is how the user gets out of trouble, and a permission check that
   * stands between them and the off switch is a design mistake.
   */
  router.post('/api/modules/:id/disable', async (rc) => {
    rc.requireCapability('write');
    const registry = needMethod(registryOf(rc), 'disable', 'Die Modulverwaltung');
    const id = rc.params.id;
    mustGetModule(registry, id);
    await registry.disable(id);
    const after = mustGetModule(registry, id);
    audit(rc, 'module.disabled', { id });
    return { record: after, enabled: dataOf(after, id).enabled === true, description: describeModule(dataOf(after, id)) };
  });

  /**
   * Back to an earlier version. The way out of "I pasted something and now it
   * is broken", so it keeps the module's history intact: the registry appends
   * the current version before restoring the old one, which makes the step
   * back itself reversible.
   */
  router.post('/api/modules/:id/rollback', async (rc) => {
    requireModuleWrite(rc);
    const registry = needMethod(registryOf(rc), 'rollback', 'Die Modulverwaltung');
    const id = rc.params.id;
    const before = mustGetModule(registry, id);
    const body = asObject(await rc.body());

    if (body.version === undefined || body.version === null) {
      throw new ValidationError('"version" fehlt. Gib die Nummer der Fassung an, zu der du zurück willst.');
    }
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ValidationError(`"version" muss eine ganze Zahl ab 1 sein (empfangen: ${String(body.version).slice(0, 40)}).`);
    }
    const history = dataOf(before, id).versions;
    const known = (Array.isArray(history) ? history : [])
      .map((entry) => entry && entry.version).filter((v) => Number.isInteger(v));
    if (known.length && !known.includes(version)) {
      throw new ValidationError(
        `Fassung ${version} gibt es bei diesem Modul nicht. Vorhanden sind: ${known.join(', ')}.`,
        { available: known },
      );
    }

    const result = await registry.rollback(id, version);
    const after = (result && result.record) || mustGetModule(registry, id);
    audit(rc, 'module.rollback', { id, version });
    return {
      record: after,
      restoredFrom: version,
      description: describeModule(dataOf(after, id)),
      note: 'Die alte Fassung ist wieder aktiv. Aktiviere das Modul, damit sie läuft – die vorherige liegt weiterhin im Verlauf.',
    };
  });

  router.delete('/api/modules/:id', async (rc) => {
    requireModuleWrite(rc);
    const registry = needMethod(registryOf(rc), 'remove', 'Die Modulverwaltung');
    const id = rc.params.id;
    const before = mustGetModule(registry, id);
    if (dataOf(before, id).builtin === true) {
      throw new PermissionError(
        'Dieses Modul gehört zu Neural OS und kann nicht entfernt werden. Du kannst es aber ausschalten.',
        { id },
      );
    }
    const removed = await registry.remove(id);
    audit(rc, 'module.removed', { id, name: dataOf(before, id).name });
    return { removed: true, record: removed && removed.id ? removed : before };
  });

  /**
   * The source of a UI module, as a real JavaScript document, so the
   * interface can `import()` it from its own origin -- see the note at the top
   * of this file for why that is the only way past the CSP.
   *
   * Two things the interface must do with this URL:
   *  - append a changing query (`?v=<version>`), because the browser caches an
   *    ES module by URL for the lifetime of the page and would otherwise keep
   *    running the version it imported first;
   *  - wrap the import in try/catch, because a module that throws on import is
   *    the normal case here and must not take the interface down with it.
   */
  router.get('/api/modules/:id/source.js', (rc) => {
    rc.requireCapability('read');
    const registry = registryOf(rc);
    const id = rc.params.id;
    const record = mustGetModule(registry, id);
    const data = dataOf(record, id);

    if (data.kind !== 'ui') {
      throw new NeuralError(
        'MODULE_KIND_MISMATCH',
        `"${data.name || id}" ist ein Server-Modul. Sein Quelltext wird nicht an den Browser ausgeliefert, weil er dort nicht läuft. `
        + 'Den Quelltext zum Ansehen und Bearbeiten liefert GET /api/modules/:id.',
        { status: 400, details: { id, kind: data.kind } },
      );
    }
    if (typeof data.source !== 'string' || !data.source) {
      throw new NeuralError(
        'MODULE_SOURCE_MISSING',
        `Zum Modul "${data.name || id}" ist kein Quelltext gespeichert. Installiere es noch einmal oder geh im Verlauf auf eine frühere Fassung zurück.`,
        { status: 409, details: { id } },
      );
    }

    const body = Buffer.from(data.source, 'utf8');
    const { res } = rc;
    rc.handled = true;
    res.writeHead(200, {
      // `application/javascript` is what makes the browser accept this as an
      // ES module; with anything else `import()` refuses the response.
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': body.length,
      // Never cached: the point of the workshop is that an edit takes effect.
      'Cache-Control': 'no-store',
      'X-Neural-OS-Module-Version': String(data.version === undefined ? 1 : data.version),
      'X-Neural-OS-Module-Enabled': data.enabled === true ? '1' : '0',
    });
    if (rc.method === 'HEAD') res.end();
    else res.end(body);
    return undefined;
  });
}

module.exports = {
  register,
  KINDS: Array.from(KINDS),
  MAX_SOURCE_CHARS,
  META_FIELDS,
  // Exported for the tests only; not part of the module's contract.
  __internals: { describeModule, summarise, readFileRoots },
};
