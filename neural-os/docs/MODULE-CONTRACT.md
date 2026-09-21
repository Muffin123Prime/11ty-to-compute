# Erweiterungs-System — Vertrag (v1)

Ziel: Der Nutzer fügt in einem Fenster der App Code ein, den ein Assistent für
ihn geschrieben hat, und die App ändert sich — **umkehrbar, geprüft, begrenzt**.

Bereits vorhanden und NICHT zu ändern:
- `src/store/schema.js` — Typ `module` (name, description, kind, source, version,
  versions[], capabilities[], enabled, lastError, failures, author, builtin)
- `src/modules/capabilities.js` — `CAPABILITIES`, `validate(list, kind)`,
  `describe(list, kind)`, `riskOf`, `forKind`, `networkScope(id)`, `networkLevel(list)`
- `src/kernel/errors.js`, `bus.js`, `log.js`, `paths.js`, `config.js`
- `src/net/gate.js` — `gate.fetch(url, {scope, purpose, maxLevel, allowedHosts})`

Regeln wie im gesamten Projekt: **null npm-Abhängigkeiten**, `src/` CommonJS,
`web/` native ES-Module, kein Build-Schritt, Kommentare Englisch, Nutzertexte
Deutsch, niemals etwas vortäuschen.

---

## 1. Das Modul-Format (was der Nutzer einfügt)

### Server-Modul (CommonJS)

```js
module.exports = {
  manifest: {
    name: 'Notizen-Statistik',
    description: 'Zählt Notizen pro Schlagwort.',
    kind: 'server',
    capabilities: ['records.read', 'tools.add'],
  },
  setup(api) {
    api.tool({
      name: 'stats.tags',
      description: 'Zählt Notizen pro Schlagwort.',
      parameters: { type: 'object', properties: {}, },
      run(args, ctx) {
        const notes = api.records.list('note');
        return { counts: /* ... */ };
      },
    });
    return () => { /* optional: aufräumen beim Deaktivieren */ };
  },
};
```

### Oberflächen-Modul (ES-Modul)

```js
export const manifest = {
  name: 'Wortzähler',
  description: 'Zeigt, wie viele Wörter du geschrieben hast.',
  kind: 'ui',
  capabilities: ['ui.view', 'ui.api'],
};

export default {
  id: 'wortzaehler',
  title: 'Wortzähler',
  icon: '<circle cx="10" cy="10" r="7"/>',
  async mount(container, ctx) { /* wie web/views/* */ },
  async unmount() {},
};
```

## 2. `src/modules/sandbox.js`

```js
function createSandbox({ store, gate, bus, registry, config, logger, paths, audit }): Sandbox
```

- `async evaluate(source, { kind, timeoutMs = 2000 })` → `{ manifest, exports }`
  Wertet den Quelltext aus, OHNE `setup()` aufzurufen. Für die Vorprüfung.
- `async instantiate(record, { dryRun })` → `{ api, teardown, registered }`
  Baut den Fähigkeits-`api` aus `record.data.capabilities`, ruft `setup(api)`,
  sammelt was registriert wurde. `dryRun` verwirft alles sofort wieder.
- `dispose(moduleId)`

**Ausführung:** `node:vm` mit `vm.createContext`, Zeitlimit über
`script.runInContext(ctx, { timeout })`. Im Kontext stehen ausschließlich:
`module`, `exports`, `console` (auf den Logger umgeleitet, mit Modulnamen als
Präfix), `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` (nachverfolgt
und beim Deaktivieren abgeräumt), `JSON`, `Math`, `Date`, `URL`,
`TextEncoder`/`TextDecoder`, `Buffer`, `structuredClone`, `Promise`.

**Nicht im Kontext:** `require`, `process`, `globalThis` des Wirts, `fs`, `net`,
`child_process`, `eval` des Wirts, `Function`-Konstruktor über den Wirt.
Ein `require`-Aufruf wirft mit deutscher Erklärung, dass Module ihre Fähigkeiten
über `api` bekommen.

**Ehrlich dokumentieren** (Header-Kommentar): `node:vm` ist KEINE
Sicherheitsgrenze gegen absichtlich ausbrechenden Code. Es schützt vor Fehlern,
nicht vor Angriffen. Die eigentliche Sicherheit liegt in den Fähigkeiten, der
Schleuse, dem Protokoll und der Umkehrbarkeit.

### Der `api`, den `setup()` bekommt

Enthält NUR, was die Berechtigungen hergeben. Fehlt eine Berechtigung, fehlt die
Eigenschaft ganz (nicht eine Funktion, die wirft — dann kann das Modul es prüfen).

| Berechtigung | `api`-Zugang |
|---|---|
| immer | `api.name`, `api.id`, `api.version`, `api.log(...)`, `api.storage` (eigener kleiner Schlüssel-Wert-Speicher im Vault, auf 256 KB begrenzt) |
| `records.read` | `api.records.get(id)`, `.list(type, query)`, `.search(q, opts)`, `.edges.for(id)` |
| `records.write` | zusätzlich `.create(type, data)`, `.update(id, patch)`, `.remove(id)`, `.edges.add(...)` |
| `bus.listen` | `api.on(name, fn)` — Abmeldung beim Deaktivieren automatisch |
| `tools.add` | `api.tool(def)` |
| `routes.add` | `api.route(method, path, handler)` — Pfad MUSS mit `/api/x/` beginnen |
| `files.read` / `files.write` | `api.files.read(path)`, `.write(path, text)`, `.list(dir)` — nur unter `record.data.fileRoots`, über `paths.safeJoin` und `fs.realpathSync` abgesichert |
| `model.use` | `api.model.chat({messages, options})` |
| `net.lan` / `net.online` | `api.fetch(url, init)` → `gate.fetch(url, {...init, scope: networkScope(id), maxLevel: networkLevel(caps)})` |

Jeder schreibende Zugriff wird auditiert (`audit.write('module.write', …)`).

## 3. `src/modules/registry.js`

```js
function createModuleRegistry({ store, sandbox, bus, logger, config, audit }): Registry
```

| Methode | Verhalten |
|---|---|
| `async validate(source, {kind})` | Syntaxprüfung, Manifest lesen und prüfen, Berechtigungen prüfen, Probelauf (`dryRun`). Liefert `{ok, manifest, capabilities, risk, description, problems[], warnings[]}`. Wirft NICHT — Probleme sind Daten. |
| `async install({source, note})` | Validiert, legt den `module`-Record an (`enabled:false`), gibt `{record, validation}` zurück |
| `async update(id, {source, note})` | Hängt die bisherige Fassung an `versions` an, setzt die neue als `source`, erhöht `version`, deaktiviert das Modul bis zur erneuten Aktivierung |
| `async rollback(id, version)` | Stellt eine frühere Fassung als aktive wieder her (und hängt die aktuelle ebenfalls an `versions` an — auch ein Rückschritt ist umkehrbar) |
| `async enable(id)` / `disable(id)` | `enable` instanziiert wirklich; scheitert das, bleibt `enabled:false` und `lastError` wird gesetzt |
| `async loadAll({safeMode})` | Beim Start: alle `enabled` Module laden. `safeMode` lädt keines. |
| `list()` / `get(id)` | |
| `async remove(id)` | deaktiviert und löscht (weich) |
| `tools()` | alle von Modulen bereitgestellten Werkzeuge, für `agents/tools.js` |
| `routes()` | alle bereitgestellten Routen, für den Router |
| `status()` | `{loaded, failed, disabled, safeMode}` |

**Absturzsicherung (wichtigster Teil):**
- Vor dem Laden wird `paths.home/modules-loading.json` mit der ID geschrieben,
  danach gelöscht. Existiert die Datei beim Start noch, hat das Modul beim
  letzten Mal den Prozess mitgerissen → es wird **automatisch deaktiviert**, mit
  `lastError` und einem Eintrag im Protokoll.
- Wirft ein Modul zur Laufzeit (Ereignis-Handler, Route, Werkzeug), wird der
  Fehler eingefangen, `failures` erhöht und ab 3 Fehlschlägen in Folge das Modul
  deaktiviert. Ein kaputtes Modul darf die App nicht unbenutzbar machen.
- `bus.publish('module.*', …)` für die Oberfläche: `installed`, `enabled`,
  `disabled`, `failed`, `updated`.

## 4. `src/http/api/modules.js`

```
GET    /api/modules                 -> {items, status}
POST   /api/modules/validate        {source, kind?}        -> Prüfbericht, installiert NICHTS
POST   /api/modules                 {source, note?}        -> installiert (deaktiviert)
GET    /api/modules/:id
PATCH  /api/modules/:id             {source?, note?, name?, description?, fileRoots?}
POST   /api/modules/:id/enable      {capabilities?}        -> Bestätigung der Berechtigungen
POST   /api/modules/:id/disable
POST   /api/modules/:id/rollback    {version}
DELETE /api/modules/:id
GET    /api/modules/:id/source.js   -> der Quelltext eines UI-Moduls als
                                       application/javascript, damit die
                                       Oberfläche ihn per import() laden kann
                                       (gleicher Ursprung, CSP-konform)
GET    /api/modules/capabilities    -> Katalog für die Oberfläche
```
Alle schreibenden Routen brauchen `rc.requireCapability('write')`; `enable`
zusätzlich `'modules'` (neue Token-Berechtigung). Ein über die Netzfreigabe
verbundenes Gerät darf also standardmäßig **keine** Module aktivieren.

## 5. `web/views/workshop.js` + `web/lib/editor.js`

`editor.js` — kleiner Code-Editor ohne Abhängigkeiten:
`createEditor(container, {value, language, onChange})` → `{getValue, setValue,
focus, setMarker(line, message), destroy}`.
Zeilennummern, Tabulator fügt zwei Leerzeichen ein, Klammern werden ergänzt,
horizontales Scrollen, Monospace, Zeilenumbruch aus. Fehlerzeile markierbar.
Kein `contenteditable`-Chaos: `<textarea>` über einer Zeilennummern-Spalte.

`workshop.js` — die Ansicht **„Werkstatt"** (id `workshop`, Taste `e`):
- Links: Liste der Module mit Zustand (aktiv / aus / fehlerhaft) und Version.
- Rechts oben: der Editor. Rechts unten: Prüfbericht und Protokoll.
- Knöpfe: **Prüfen** (nichts wird installiert), **Installieren**, **Aktivieren**,
  **Deaktivieren**, **Verlauf** (Versionen mit Datum, je Zeile „Zurück zu dieser
  Fassung"), **Entfernen**, **Exportieren**.
- Nach *Prüfen*: Manifest, verlangte Berechtigungen als Karten mit Klartext und
  Risikofarbe, Probleme mit Zeilennummer (Editor markiert die Zeile).
- Vor *Aktivieren*: ein Dialog, der die Berechtigungen nennt und bei Risiko
  „hoch" ausdrücklich benennt, was schiefgehen kann. Nichts ist vorausgewählt.
- Fehlerbereich: `lastError` mit Stapelüberwachung, Knopf „Erneut versuchen".
- Vorlagen-Menü: „Neue Ansicht", „Neues Werkzeug", „Neue Adresse", „Auf
  Ereignisse reagieren" — fügt ein lauffähiges Grundgerüst in den Editor ein.
- Ein ruhiger Hinweis, dass eingefügter Code auf diesem Gerät ausgeführt wird
  und man nur einfügen soll, was man versteht oder von einer Quelle hat, der man
  vertraut.

Die Ansicht wird vom Integrator in `web/app.js` registriert, nicht vom Agenten.

## 6. Tests

`test/modules.test.js`, `test/sandbox.test.js` — im Stil von `test/kernel.test.js`.
Mindestens: Manifest fehlt → sauberer Fehler; Syntaxfehler → Zeilennummer;
Berechtigung fehlt → `api`-Eigenschaft fehlt; `require` im Modul → deutlicher
Fehler; Endlosschleife → Zeitlimit greift; Modul wirft beim Laden → deaktiviert
statt Absturz; Rollback stellt die alte Fassung her; `fileRoots`-Ausbruch wird
verhindert; `routes.add` außerhalb `/api/x/` wird abgelehnt; Netzzugriff ohne
Berechtigung wird von der Schleuse blockiert.
