# Neural OS — Build Contracts (v1)

Binding interface spec. Every module MUST implement exactly these signatures.
CommonJS (`require`/`module.exports`), Node >= 20, **zero npm dependencies**.
Node stdlib only (`node:fs`, `node:http`, `node:crypto`, `node:net`, `node:dns`,
`node:zlib`, `node:worker_threads`, …). No TypeScript, no build step, no CDN.

Shared foundation (already implemented, do not modify):
- `src/kernel/errors.js` — error taxonomy (see below)
- `src/kernel/paths.js` — `layout()`, `ensureLayout()`, `safeJoin()`
- `src/kernel/config.js` — `defaults()`, `load()`, `save()`, `validateConfig()`
- `src/kernel/bus.js` — `bus.publish(name, payload)`, `bus.subscribe(fn)`, `bus.since(seq)`
- `src/kernel/log.js` — `logger(scope)`, `new Audit(path).write(kind, data)`
- `src/store/schema.js` — `validate(type, data, {partial})`, `TYPES`, `GRAPH_TYPES`, `EDGE_KINDS`, `FIELDS`

Errors to throw: `ValidationError`, `NotFoundError`, `PermissionError`,
`NetworkBlockedError`, `NoModelError`, `ModelError`, `StorageError`,
`LockedError`, `AuthError`, `ApprovalDeniedError`, `AbortedError`.

## Cardinal rules

1. **Never fabricate.** No placeholder model output, no fake tool results, no
   "pretend it worked". If something is unavailable, throw the typed error.
2. **No network unless the gate allows it.** No module may call `fetch`,
   `http.request` or `net.connect` directly. Use `gate.fetch(...)`.
3. **No new dependencies.** If you need a parser, write it.
4. **Every write goes through the store.** No module writes user data to disk
   on its own except `store` itself and `backup`.
5. **Ship working code.** Every module gets tests in `test/<name>.test.js`.

---

## 1. `src/store/engine.js`

```js
/** @typedef {{id:string,type:string,createdAt:string,updatedAt:string,deletedAt:string|null,rev:number,data:object}} Record */

async function openStore({ paths, bus, logger, vaultCrypto }): Promise<Store>
```

`Store` (all synchronous unless noted — state is in memory, durability is via
the append-only log):

| Method | Returns | Notes |
|---|---|---|
| `create(type, data, opts?)` | `Record` | validates via `schema.validate`; `opts.id` to force id; publishes `record.created` |
| `get(id, opts?)` | `Record\|null` | `opts.includeDeleted` |
| `update(id, patch, opts?)` | `Record` | shallow-merges `patch` into `data`, bumps `rev`; publishes `record.updated` |
| `remove(id, opts?)` | `Record` | soft by default; `opts.hard=true` purges; publishes `record.deleted` |
| `restore(id)` | `Record` | clears `deletedAt` |
| `list(type, q?)` | `{items:Record[], total:number}` | `q = {filter:fn\|object, sort:string, order:'asc'\|'desc', limit, offset, includeDeleted}` |
| `all(type)` | `Record[]` | live records only |
| `count(type)` | `number` | |
| `search(query, opts?)` | `{items:[{record, score, snippet}], total}` | delegates to `search.js` |
| `transaction(fn)` | `any` | batches log writes, single flush |
| `flush()` | `Promise<void>` | fsync the log |
| `compact()` | `Promise<{records:number, bytes:number}>` | snapshot + truncate log |
| `stats()` | `{counts:object, edges:number, bytes:number, logSegments:number, lastWrite:string\|null}` | |
| `close()` | `Promise<void>` | |

`store.edges`:
- `add({from,to,kind,source,reason,weight})` → `Record` (edge). Dedupes on
  `(from,to,kind)`: returns the existing edge instead of creating a duplicate.
  Throws `NotFoundError` if either endpoint is missing.
- `remove(id)` → `Record`
- `for(id, {direction='both', kinds, limit})` → `Record[]`
- `between(a,b)` → `Record[]`
- `neighbours(id, {depth=1, types, kinds, limit=300})` → `{nodes:Record[], edges:Record[], truncated:boolean}` (BFS)

`store.files`:
- `put(buffer, {name, mime})` → `{hash, size, path}` — content-addressed
  (`sha256`), stored under `paths.files/<aa>/<hash>`; encrypted if enabled.
- `read(hash)` → `Buffer` (throws `NotFoundError`)
- `remove(hash)` → `boolean`
- `has(hash)` → `boolean`

### Durability format

- Log segments: `vault/log/00001.jsonl`, rotated at 8 MB.
  One JSON object per line:
  `{v:1, seq, op:'create'|'update'|'delete'|'restore'|'purge', at, id, type, rev, data?|patch?}`
- Snapshot: `vault/snapshot.json` = `{v:1, at, seq, records:[Record]}`
- Load = read snapshot, then replay every log line with `seq > snapshot.seq`.
- **A corrupt trailing line must not destroy the vault**: truncate it, log a
  warning, continue. Count recovered/dropped lines in the open result.
- IDs: `<type>_<24 lowercase base36 chars>` from `crypto.randomBytes`.
  Must satisfy `schema.ID_RE`.
- If `vaultCrypto.enabled`, every log line and the snapshot body are passed
  through `vaultCrypto.encryptLine` / `decryptLine` before write / after read.

## 2. `src/store/search.js`

```js
function createSearchIndex(opts?): SearchIndex
```
- `add(record)`, `update(record)`, `remove(id)`, `clear()`
- `query(text, {types, limit=30, offset=0})` → `{items:[{id, score, snippet}], total}`
- Inverted index, BM25 scoring, tokeniser must handle German (umlauts, ß,
  compound-ish prefix matching), case/diacritic folding, min token length 2.
- Support `tag:foo`, `type:note`, `"exact phrase"` operators.
- `snippet` = ±90 chars around the best match, with `\u0001`/`\u0002` markers
  around hit terms (the UI converts those to `<mark>`; never emit HTML here).

## 3. `src/store/vaultcrypto.js`

```js
function createVaultCrypto({ paths, config }): VaultCrypto
```
- `enabled` (getter), `state`: `'disabled' | 'locked' | 'unlocked'`
- `async initialise(passphrase)` → writes `secrets.json`:
  `{v:1, kdf:'scrypt', N:2**17, r:8, p:1, salt, keyCheck:{iv,tag,ct}, wrappedKey:{iv,tag,ct}}`
  A random 32-byte data key is wrapped with the scrypt-derived key, so the
  passphrase can be changed without re-encrypting the vault.
- `async unlock(passphrase)` → `true` | throws `LockedError`
- `lock()` → zeroes the key buffer
- `encryptLine(str) → string` (base64 `iv|tag|ct`), `decryptLine(str) → string`
- `encryptBuffer(buf) → Buffer`, `decryptBuffer(buf) → Buffer`
- `async changePassphrase(old, next)`
- AES-256-GCM, fresh 12-byte IV per record, never reuse.
- When disabled, all crypt functions are identity — the seam stays the same.

## 4. `src/store/backup.js`

```js
function createBackup({ store, paths, config, logger }): Backup
```
- `async exportAll({ dir, format='both', includeFiles=true })` →
  `{dir, files:number, records:number, bytes:number, manifest}`
  - `format:'json'` → `export.json` (complete, restorable)
  - `format:'markdown'` → human-readable tree: `notes/<slug>.md` with YAML
    front-matter, `chats/<slug>.md` as transcripts, `projects/`, `files/`
  - `format:'both'` → both. Always writes `manifest.json` with counts + sha256.
- `async importAll({ dir|file, mode='merge' })` → `{imported, skipped, conflicts}`
  - `mode:'merge'` keeps existing on id conflict; `'replace'` overwrites;
    `'fresh'` refuses unless the vault is empty.
- `async verify(dir)` → `{ok, problems:[]}` — checks manifest hashes.
- Export must be **round-trippable**: `exportAll` → fresh vault → `importAll`
  reproduces identical records. Prove it in a test.

## 5. `src/net/gate.js` — the egress gate (most security-critical module)

```js
function createGate({ config, audit, bus, store, logger }): Gate
```

| Member | Signature | Notes |
|---|---|---|
| `classify(hostOrIp)` | `'loopback'\|'private'\|'public'\|'unknown'` | pure, no DNS. Handles IPv4, IPv6, IPv4-mapped IPv6 (`::ffff:a.b.c.d`), `localhost`, `*.localhost` |
| `check({host, port, scope, purpose})` | `{allowed:boolean, level, classification, reason, grantId?}` | pure policy decision, **no DNS** |
| `async resolve(host, {scope})` | `{ip, family}` | DNS is itself egress: refuse to resolve when policy would block the class anyway (a DNS query leaks the hostname to the resolver) |
| `async fetch(url, init)` | `Response` | `init.scope` (string, required), `init.purpose`, `init.timeoutMs`, `init.signal`. Pins the resolved IP (anti DNS-rebinding), re-checks on every redirect, caps redirects at 3 |
| `setMode(mode)` | `void` | persists to config |
| `mode` | getter | |
| `addGrant(g)` | `Record` | stored as a `grant` record |
| `revokeGrant(id)` / `listGrants()` | | expired/used-up grants are filtered out |
| `effectiveFor(scope)` | `{mode, hosts, grants:[]}` | what the UI displays |
| `stats()` | `{allowed, blocked, lastBlockedAt, byHost:{}}` | |

**Policy resolution order** (first match wins):
1. `config.network.blockHosts` → **deny**, always.
2. destination classification `loopback` → **allow** (local models are not
   "the internet"; audited as `network.local`).
3. an active grant for `scope` (or an ancestor scope) covering the class and
   host → **allow**.
4. global `config.network.mode` covers the class, and, when
   `strictAllowlist`, the host matches `allowHosts` → **allow**.
5. otherwise → **deny** with a reason naming the missing permission.

Scope chain: `once:<nonce>` → `run:<id>` → `agent:<id>` → `chat:<id>` → `global`.
`effectiveFor` walks it.

Host matching: exact, `*.example.com` wildcard, optional `:port`. `'*'` = any.
Every decision publishes `network.attempt` on the bus and writes an audit line.

## 6. `src/net/harden.js` — process-level enforcement

```js
function harden(gate, { logger, allowUnscoped = false }): { restore(): void, stats(): object }
```
Monkey-patches, at boot, **before any other module loads**:
`globalThis.fetch`, `http.request`, `http.get`, `https.request`, `https.get`,
`net.Socket.prototype.connect`, `net.connect`, `tls.connect`,
`dns.lookup`, `dns.promises.lookup`, `dns.resolve*`.

Every patched call resolves the destination and asks the gate. Denied calls
throw / emit `NetworkBlockedError`. Calls originating inside `gate.fetch`
carry an internal marker (a module-private `Symbol`) and pass through, so the
gate itself is not blocked by its own patch.

Must NOT break: `server.listen()`, unix sockets, in-process connections to the
app's own port. Document honestly in the header comment that this is
**process-level** enforcement — it stops this app's code and its dependencies,
but it is not an OS firewall and does not constrain a separate process.

## 7. `src/models/providers/*.js` and `src/models/registry.js`

Provider module exports:
```js
module.exports = {
  kind: 'ollama' | 'openai',
  async probe({ baseUrl, gate, scope, signal }):
    { available:boolean, models:[{id,name,family?,parameterSize?,contextLength?,sizeBytes?}], error?:string, latencyMs:number },
  async chat({ baseUrl, model, messages, options, tools, gate, scope, signal, onDelta }):
    { content:string, toolCalls:[{id,name,arguments}], stats:{promptTokens,completionTokens,ms}, raw? },
  async embed({ baseUrl, model, input, gate, scope, signal }): { vectors:number[][] }   // optional
};
```
- `messages`: `[{role:'system'|'user'|'assistant'|'tool', content:string, toolCallId?, name?}]`
- `options`: `{temperature, topP, maxTokens, stop, seed}`
- `onDelta(text)` called per streamed chunk. Streaming is required
  (Ollama NDJSON `/api/chat`, OpenAI-compatible SSE `/v1/chat/completions`).
- `ollama.js`: `/api/tags` for probe, `/api/chat` for chat, native tool calling.
- `openai.js`: `/models` for probe, `/chat/completions`; also carries optional
  `Authorization: Bearer` from `init.apiKey` for remote providers.
- **Never invent output.** Unreachable → `NoModelError`; HTTP error → `ModelError`
  carrying status + body excerpt.

`registry.js`:
```js
function createRegistry({ config, gate, bus, logger }): Registry
```
- `async refresh({timeoutMs=1500})` → `{providers:[{id,kind,baseUrl,available,models,error,latencyMs}], at}`
  probes all enabled providers in parallel; publishes `models.changed`.
- `list()` → last snapshot (never re-probes)
- `resolve(ref)` → `{providerId, kind, baseUrl, model, apiKey?}`; `ref` is
  `{provider, model}` | `'provider/model'` | `null` (→ config default → first
  available). Throws `NoModelError` with an actionable message listing what was
  probed and how to install Ollama.
- `async chat(ref, opts)` → delegates to the provider, injecting `gate`.
- `isOffline(ref)` → `true` when the resolved baseUrl is loopback.

## 8. `src/agents/*`

`permissions.js`:
- `effective(agent, config)` → merged permission object (global overrides win)
- `check(agent, capability, ctx)` → `{allowed, reason}`; capability ∈
  `readNotes|writeNotes|readFiles|writeFiles|createEdges|runTasks|spawnAgents|network`
- `canAccessPath(agent, absPath)` → boolean (must use `safeJoin` against each `fileRoots` entry)
- `networkScope(agent, runId)` → scope string for the gate
- `describe(agent)` → human-readable German summary for the UI

`approvals.js`:
```js
function createApprovals({ store, bus, config }): Approvals
```
- `async request({runId, agentId, kind, summary, payload, timeoutMs=300000})`
  → resolves `true`/throws `ApprovalDeniedError`. Creates an `approval` record,
  publishes `approval.requested`, waits for `resolve()`.
- `resolve(id, decision /* 'approved'|'denied' */)` → `Record`
- `listPending()` → `Record[]`
- `abortAll(runId)`

`tools.js`:
```js
function createToolbox({ store, registry, gate, graph, paths, approvals, config, logger }): Toolbox
```
- `list(agent)` → `[{name, description, parameters /* JSON-Schema */}]` filtered
  by that agent's permissions
- `async call(name, args, ctx)` → `{ok:true, result}` | throws
  `ctx = {agent, run, signal, scope}`
- Required tools:
  `notes.search`, `notes.read`, `notes.create`, `notes.update`,
  `graph.neighbours`, `graph.link`,
  `tasks.create`, `tasks.update`,
  `files.list`, `files.read`, `files.write`,
  `memory.remember`, `memory.recall`,
  `web.fetch` (gate-scoped, strips scripts, returns extracted text),
  `agents.spawn` (only with `spawnAgents`),
  `time.now`, `math.eval` (safe expression evaluator, no `eval`)
- Every mutating tool checks permission **and** goes through `approvals.request`
  when `requireApproval`. Every call is audited.

`runtime.js`:
```js
function createAgentRuntime({ store, registry, toolbox, approvals, gate, bus, config, logger }): Runtime
```
- `async start({agentId, goal, chatId, context})` → `Record` (run), executes async
- `abort(runId)`, `get(runId)`, `listActive()`
- Loop: build system prompt (agent prompt + tool catalogue + explicit statement
  of its network stance) → call model → parse tool calls → execute → feed back →
  repeat until final answer, `maxSteps`, `maxSeconds`, or abort.
- Must also work with models that have **no native tool calling**: fall back to
  a documented `<tool name="..">{json}</tool>` text protocol and parse it.
- Publishes `run.started`, `run.step`, `run.finished`, `run.failed`.
- Every step appended to the run record AND to `paths.runs/<runId>.jsonl`.
- `usedNetwork` on the run must reflect what really happened (ask the gate).

## 9. `src/graph/*`

`derive.js`:
- `deriveFor(store, record)` → `{created:Record[], removed:Record[]}`
  Derives: `[[wiki links]]` and `#tags` in note/task bodies → `links-to`/`tagged`;
  `task.projectId` → `belongs-to`; `message.chatId` → `belongs-to`;
  `run.agentId` → `belongs-to`; `run.producedIds` → `produced`.
  Idempotent; removes derived edges that no longer apply. Never touches
  `source:'manual'` edges.
- `scanAll(store, {onProgress})` → `{scanned, created, removed}`
- `extractLinks(text)` → `{wikiLinks:string[], tags:string[], urls:string[]}`

`view.js`:
- `buildGraph(store, {focus, depth=2, types, kinds, limit=600, query, includeOrphans=true})`
  → `{nodes:[{id,type,label,tags,degree,updatedAt,pinned,snippet}], edges:[{id,from,to,kind,source,weight}], truncated:boolean, stats}`
- `label(record)` → display title for any record type
- `clusters(graph)` → connected components with a suggested label
- Never return more than `limit` nodes; set `truncated` honestly.

## 10. `src/http/*`

`auth.js`:
```js
function createAuth({ store, config, logger, audit }): Auth
```
- `async middleware(req, res)` → `{ok:true, identity}` | `{ok:false, error}`
- Loopback + sharing disabled → identity `{kind:'owner', permissions:'all'}`, no token.
- Sharing enabled → `Authorization: Bearer <token>` (scrypt-compared against
  `token` records) or the `nos_session` cookie.
- `async createToken({label, permissions, expiresAt})` → `{token, record}` (raw token returned once)
- `revokeToken(id)`, `listTokens()`
- **Anti-DNS-rebinding**: reject requests whose `Host` header is not
  `localhost`/`127.0.0.1`/`::1`/the configured bind host.
- **CSRF**: every mutating request (non-GET/HEAD) must carry
  `X-Neural-OS: 1`, and `Origin`, when present, must be same-origin.

`server.js`:
```js
async function createServer(ctx): { server, listen(), close(), url }
// ctx = {config, paths, store, gate, registry, chat, runtime, toolbox, approvals, auth, backup, bus, audit, logger, vaultCrypto}
```
- Plain `node:http`. Static files from `web/` with correct MIME, ETag,
  `Cache-Control: no-cache` for `index.html`.
- Security headers on every response:
  `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy: geolocation=(), camera=(), microphone=()`.
  The CSP is what makes "no silent outbound request from the UI" a browser-enforced fact.
- Body limit 32 MB; JSON parse errors → `ValidationError`.
- Errors → `err.status` + `err.toJSON()`. Unknown errors → 500 `INTERNAL_ERROR`,
  never leak stack traces to the client (log them instead).

### HTTP API (all under `/api`, JSON in/out)

```
GET    /api/status                 -> {version, node, uptime, network:{mode,online,classification}, vault:{state,records,bytes}, models:{...}, agents:{active}, sharing:{enabled}}
GET    /api/events?since=<seq>     -> text/event-stream of bus events
GET    /api/config                 -> sanitised config
PATCH  /api/config                 -> updated config

GET    /api/records?type=&limit=&offset=&q=&sort=&order=
POST   /api/records                {type, data}
GET    /api/records/:id
PATCH  /api/records/:id            {data patch}
DELETE /api/records/:id?hard=true
POST   /api/records/:id/restore

GET    /api/search?q=&types=&limit=

GET    /api/graph?focus=&depth=&types=&kinds=&limit=&q=
POST   /api/edges                  {from,to,kind,reason}
DELETE /api/edges/:id
GET    /api/edges?node=&direction=
POST   /api/graph/rescan           -> re-derive all links

POST   /api/chats                  {title?, model?, network?, agentId?}
GET    /api/chats/:id/messages
POST   /api/chats/:id/send         {content, network?} -> SSE stream (delta/message/error/done)
POST   /api/chats/:id/abort
PATCH  /api/chats/:id              {title?, model?, network?, systemPrompt?, contextNodeIds?}

GET    /api/models                 -> registry snapshot
POST   /api/models/refresh         -> re-probe

GET    /api/network                -> {mode, strictAllowlist, allowHosts, grants, stats, reachability}
PUT    /api/network                {mode, strictAllowlist?, allowHosts?}
POST   /api/network/grants         {scope, level, hosts, expiresAt?, maxUses?, reason}
DELETE /api/network/grants/:id
GET    /api/network/audit?limit=   -> recent egress decisions
POST   /api/network/test           {host, port?} -> gate decision WITHOUT connecting

GET    /api/agents                 | POST /api/agents | PATCH /api/agents/:id | DELETE /api/agents/:id
POST   /api/agents/:id/run         {goal, chatId?} -> {runId}
GET    /api/runs?status=           | GET /api/runs/:id | POST /api/runs/:id/abort
GET    /api/approvals              | POST /api/approvals/:id  {decision:'approved'|'denied'}

POST   /api/vault/unlock           {passphrase}
POST   /api/vault/lock
POST   /api/vault/encrypt          {passphrase}      -> enable encryption
POST   /api/backup/export          {format, includeFiles} -> {dir, manifest}
POST   /api/backup/import          {dir|file, mode}
GET    /api/backup/download        -> application/json attachment of full export

GET    /api/tokens | POST /api/tokens | DELETE /api/tokens/:id
GET    /api/health                 -> {ok:true} (no auth, loopback only)
```

## 11. `web/*` — the interface

Vanilla ES modules, no framework, no bundler, **no external asset of any kind**
(no Google Fonts, no CDN, no telemetry). System font stack only.

- `web/index.html` — app shell
- `web/app.css` — design system (tokens, light + dark)
- `web/app.js` — router, state store, SSE client, keyboard shortcuts
- `web/lib/api.js` — typed fetch wrapper (adds `X-Neural-OS`, handles errors)
- `web/lib/dom.js` — tiny `h()` hyperscript + list reconciler
- `web/lib/markdown.js` — Markdown → sanitised HTML (no `innerHTML` of raw user text)
- `web/lib/graph-canvas.js` — force-directed renderer (canvas 2D, Barnes–Hut
  quadtree, must stay interactive at 2 000 nodes; pan/zoom/drag/select,
  hover highlight of neighbours, devicePixelRatio aware)
- `web/views/chat.js`, `graph.js`, `notes.js`, `agents.js`, `network.js`,
  `settings.js`, `search.js`, `projects.js`
- `web/sw.js` — service worker, cache-first for the shell so the UI opens
  instantly and works with the network stack fully down.

Design language: neutral black/white, one accent used sparingly, generous
whitespace, 8 px spacing scale, `ui-sans-serif` stack, `ui-monospace` for code.
Motion ≤ 160 ms, respects `prefers-reduced-motion`. Full keyboard control.
Every network-touching element shows its true state (offline badge / online badge
naming the host). German UI copy.

## 12. `test/*`

Zero-dependency runner `test/run.js`:
- discovers `test/**/*.test.js`, each exporting `{name, tests:[{name, fn}]}`
  or using the provided `test(name, fn)` global from `test/harness.js`
- assertions via `node:assert/strict`
- `node test/run.js` exits non-zero on failure, prints a compact summary
- tests must not touch the real home directory — use a temp dir per test

---

## 13. UI module contract (so views integrate cleanly)

`web/app.js` exports and owns the shell. Every view module in `web/views/`
exports **exactly** this shape:

```js
export default {
  id: 'chat',                 // route segment: #/chat
  title: 'Chat',              // sidebar label (German)
  icon: '<svg …>',            // inline SVG string, 20x20, currentColor, no external file
  async mount(container, ctx) {},   // render into container (already emptied)
  async unmount() {},               // remove listeners/timers; called before the next mount
};
```

`ctx` given to every view:

```js
{
  api,                 // web/lib/api.js — api.get/post/patch/del/stream
  h, text, clear,      // web/lib/dom.js helpers
  state,               // reactive app state: state.get(k), state.set(k,v), state.on(k,fn)
  bus: {on(name, fn)}, // live server events (SSE), returns unsubscribe
  navigate(hash),      // e.g. navigate('#/graph?focus=note_xyz')
  toast(message, kind),// kind: 'info' | 'success' | 'error'
  confirm(opts),       // async modal -> boolean
  route: {view, params} // parsed current route
}
```

`web/lib/api.js`:
```js
export const api = {
  get(path, opts?), post(path, body?, opts?), patch(path, body?, opts?), del(path, opts?),
  stream(path, {body, onEvent, signal}),  // POST + SSE reader
  events(onEvent),                        // GET /api/events, auto-reconnect w/ backoff + since-seq replay
};
```
All methods throw `ApiError { code, message, status, details }` on failure.

`web/lib/dom.js`:
```js
export function h(tag, props?, ...children)   // 'div.card#id' selector syntax supported
export function text(value)
export function clear(node)
export function on(node, event, handler)      // returns unsubscribe
export function list(container, items, keyFn, renderFn)  // keyed reconciler
```

Global state keys the shell maintains: `status`, `network`, `models`, `approvals`,
`theme`, `vault`, `activeChatId`, `connected` (SSE health).
