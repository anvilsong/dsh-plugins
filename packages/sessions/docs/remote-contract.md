# Remote contract: `sessionsManager`

The Host mounts one Remote service, namespace `sessionsManager`. The Client registers its locale under the same name. Never use `sessions`: that is the host's live-session service key.

The machine-checked form is [`src/contract.js`](../src/contract.js) (names, method table, frozen code lists, request and response validators, the `HostFacts` typedef). This file is its prose form. If the two differ, `src/contract.js` and its test win, and this file is wrong.

## Rules for every method

- Unary: one JSON parameter named `request`. A method with no input takes `{}`.
- Owner only. Every method refuses an agent caller with `sessions-manager/forbidden`. `apply`, `unarchive`, `restore` and `purge` change the store or the registry; the rest are read-only.
- Requests are strict: an unknown key, a missing key or a wrong type fails with `sessions-manager/invalid-request`.
- Responses are strict. A response holds only ids, paths, numbers, flags and a nullable session title. It never holds message text. A title comes from a cheap source and is never read from a log body.
- No method reads a session log body. No method calls session search.

## Sources of a response field

Every response field has one source. The tables below name it in the last column.

| Source | Meaning |
|---|---|
| persistence snapshot | A field of a stored session's header or file metadata, from the persistence service's snapshot list (`HostFacts.snapshots()`). |
| registry | Workspace, pin and archive state held by the host registry (`workspaces()`, `archivedIds()`, `pinnedIds()`). |
| live-session service | The host's live-session service, key `sessions` (`liveIds()`). |
| lstat | A `lstat` of a log path or a lock file (`statLog()`, `lockState()`). A symbolic link is never followed. |
| computed | Derived by the plugin from the sources above, from its own config, from the audit log or from the trash journal. |

## Codes

### Refusal codes

A refusal is data, not an error: it appears in `reasons` and `skipped` and excludes a session or a whole unit (the top-most archived root plus every descendant). One refusal on any member blocks the unit.

| Code | Meaning |
|---|---|
| `live` | A member is held by the live-session service. |
| `locked` | A lock probe finds a member's `session.lock` held, a `*.tmp` publish is in flight in its folder, or the lock cannot be probed. A present but free `session.lock` does not block (every session ever written has one). |
| `recent` | A member's log was modified within `recentActivityMinutes`. |
| `kept-descendant` | A member that is not archived is a kept session: its header `origin` is not `subagent` (a user fork). A snapshot in the contract shape, which has no header, falls back to workspace membership. |
| `parent-kept` | The root has a parent outside the unit, and that parent is kept. |
| `cycle` | The `parentSession` links form a loop. |
| `path-unsafe` | A path is a symbolic link, leaves the store, or fails the folder checks. At apply this includes a session or project folder swapped for a link (or another folder) while the lock probe ran: the folders are checked again right before the rename. |
| `no-location` | The session has no folder on disk. |
| `changed` | A fact changed between `plan` and `apply`. |
| `not-archived` | The session is not archived. |
| `cross-device` | The folder and the trash are on different devices; there is no copy fallback. |
| `workspace-missing` | The session's workspace is gone, so a restore cannot re-register it. |
| `conflict` | The destination already exists; nothing is overwritten. |
| `legacy-format` | A member's log has `formatStatus: 'migration-required'` (an old generation): its revision changes with any change in the store, so v1 refuses it (design.md D14). |

### Error codes

An error fails the call. `ERROR` in `src/contract.js` holds the short names.

| Code | Raised when |
|---|---|
| `sessions-manager/forbidden` | The caller is an agent. Every method. |
| `sessions-manager/busy` | Another mutation (`apply`, `unarchive`, `restore`, `purge` or a recovery) runs in this process, or holds the trash lock in another process that shares the trash folder. |
| `sessions-manager/plan-expired` | The plan id is unknown, past `expiresAt`, already used by an `apply`, or dropped (the Host keeps at most five plans, in memory; a restart drops them). A plan whose facts changed is not expired: `apply` skips each changed unit with `changed`. |
| `sessions-manager/confirmation-mismatch` | The typed count or the typed batch id does not match. |
| `sessions-manager/purge-disabled` | `allowPermanentDelete` is false. |
| `sessions-manager/unsupported-backend` | The persistence, live-session or registry service is missing, or the backend gives no JSONL session folders (no store root). An empty store counts as this unless a trash batch recorded the sessions tree. |
| `sessions-manager/unsupported-platform` | The session lock probe is not available on this platform (design.md D18): the dashboard is read-only. |
| `sessions-manager/trash-unusable` | The plugin config is invalid; the audit log in `dataDir` cannot be written; `dataDir` or the trash folder overlaps the sessions tree; the trash folder has a symlinked component, is not a folder of this user, is writable by group or others, or is on another device; or a trash file (manifest, journal, registry hints) cannot be written. A missing trash folder is created at the first lock. |
| `sessions-manager/batch-not-found` | The batch id names no batch folder, or cannot name one: it matches the request pattern but holds `..`. |
| `sessions-manager/invalid-request` | The request failed validation. Every method. |
| `sessions-manager/store-unreadable` | The session store cannot be read now: the persistence backend's listing failed (for example a project folder vanished during the listing) or the store index could not be built over it. The message names no path. The call stops before it moves a session or makes a registry call of its own (an `apply` re-reads the store after its recovery step, which may have finished an interrupted earlier operation); a later call can succeed. Every method that reads the store: all but `unarchive` on a platform or config where no prune can run. |

### Warning codes

A warning is data in an `ApplyResult`; it never fails the call: `stale-backend-entry`, `registry-step-failed`, `audit-failed`, `restart-recommended`, `recovery-needed`.

## Methods

### `overview`

Request: `{}` or `{ fresh: boolean }`. `fresh: true` bypasses the Host's snapshot cache (the Refresh button); omitted or false may be served from a cache younger than `snapshotTtlMs`. Errors: `sessions-manager/forbidden`, `sessions-manager/invalid-request`, `sessions-manager/store-unreadable`.

Response `Overview` (validator `assertOverview`):

| Field | Type | Source |
|---|---|---|
| `generatedAt` | integer ms | computed (the clock at build time) |
| `storeDir` | path or null | computed (the common store root; when the store lists no session, the sessions tree the newest trash batch recorded; null when there is neither) |
| `capabilities.prune` | boolean | computed (platform, backend and trash checks; an empty store is prunable, so its batches can be restored, when a trash batch recorded the sessions tree) |
| `capabilities.reason` | `sessions-manager/unsupported-backend`, `sessions-manager/unsupported-platform`, `sessions-manager/trash-unusable` or null; null exactly when `prune` is true | computed |
| `config.allowPermanentDelete` | boolean | computed (plugin config echo) |
| `config.recentActivityMinutes` | integer | computed (plugin config echo) |
| `config.listLimit` | integer | computed (plugin config echo) |
| `config.refreshMs` | integer | computed (plugin config echo) |
| `config.indexWarnBytes` | integer | computed (plugin config echo) |
| `totals.sessions` | integer | persistence snapshot (count of stored sessions) |
| `totals.live` | integer | live-session service (ids that are stored) |
| `totals.archived` | integer | registry (archived ids that are stored) |
| `totals.children` | integer | persistence snapshot (`parentSession` is set and the header `origin` does not mark a user fork) |
| `totals.unreadable` | integer | persistence snapshot (header unreadable) |
| `totals.bytes` | integer, on-disk bytes | persistence snapshot (sum of folder sizes) |
| `totals.archivedBytes` | integer | computed (sum over archived roots and their descendants) |
| `totals.archivedRoots` | integer | computed (top-most archived sessions) |
| `totals.archivedChildren` | integer | computed (descendants inside archived units) |
| `totals.reclaimableBytes` | integer | computed (units that pass every safety check now) |
| `totals.reclaimableUnits` | integer | computed |
| `totals.blockedUnits` | integer | computed |
| `totals.archivedMissing` | integer | registry joined with persistence snapshot (archived ids with no stored log; not counted in `totals.archived`; harmless leftovers the page names in a small line under the Archived card, shown only when above 0) |
| `indexLoad` | `normal` or `high` | computed (`totals.bytes` against `indexWarnBytes`) |
| `workspaces[].id` | string or null (null is the Unassigned row) | registry |
| `workspaces[].name` | string or null | registry |
| `workspaces[].path` | path or null | registry |
| `workspaces[].folder` | store folder name, set only on the Unassigned row | persistence snapshot (`group`) |
| `workspaces[].sessions` | integer | registry (members) joined with persistence snapshot |
| `workspaces[].archived` | integer | registry |
| `workspaces[].bytes` | integer | persistence snapshot (sum) |
| `workspaces[].lastActivityAt` | integer ms or null | persistence snapshot (max `lastActivityAt`) |
| `largest[]` (at most 10) `.id` | string | persistence snapshot |
| `largest[].title` | string or null | computed (`titleOf`, never a log read) |
| `largest[].workspaceId` | string or null | registry |
| `largest[].bytes` | integer | persistence snapshot |
| `largest[].events` | integer or null | persistence snapshot (event count; null when the backend does not report it) |
| `largest[].lastActivityAt` | integer ms | persistence snapshot |
| `largest[].live` | boolean | live-session service |
| `largest[].archived` | boolean | registry |
| `largest[].child` | boolean | persistence snapshot (as `totals.children`) |

### `archived`

Request, every key optional:

| Key | Type |
|---|---|
| `workspaceId` | string, or null for Unassigned |
| `olderThanDays` | integer >= 0 |
| `largerThanBytes` | integer >= 0 |
| `text` | string, at most 200 characters (matches id, title, workspace name) |
| `sort` | `bytes`, `lastActivityAt` or `title` |
| `offset` | integer >= 0 |
| `limit` | integer >= 1; the Host caps it at `listLimit` |

Errors: `sessions-manager/forbidden`, `sessions-manager/invalid-request`, `sessions-manager/store-unreadable`.

Response `ArchivedPage` (validator `assertArchivedPage`). Rows are unit roots, the top-most archived sessions; filters and sort run on the Host.

| Field | Type | Source |
|---|---|---|
| `total` | integer (rows that match the filters) | computed |
| `offset` | integer | computed (request echo) |
| `limit` | integer | computed (the cap that was applied) |
| `rows[].id` | string | persistence snapshot |
| `rows[].title` | string or null | computed (`titleOf`) |
| `rows[].workspaceId` | string or null | registry |
| `rows[].bytes` | integer, root plus descendants | persistence snapshot (sum) |
| `rows[].childCount` | integer | persistence snapshot (`parentSession` links) |
| `rows[].lastActivityAt` | integer ms (latest in the unit) | persistence snapshot |
| `rows[].ageDays` | integer | computed (now minus `lastActivityAt`) |
| `rows[].blocked` | boolean | computed (any refusal on any member) |
| `rows[].orphan` | boolean | computed (the row is a subagent child whose archived parent has no stored log: the id itself is not archived, so Unarchive does not apply to it; it is pruned as its own unit) |
| `rows[].reasons[]` `.code`, `.sessionId` | refusal code, member id; empty exactly when `blocked` is false | computed (`live` from the live-session service, `locked` and `path-unsafe` from lstat, the rest from the registry and snapshots) |

### `plan`

Request:

| Key | Type |
|---|---|
| `scope` | `all`, `olderThan` or `selection` |
| `olderThanDays` | integer >= 0; required with `olderThan`, forbidden otherwise |
| `rootIds` | 1 to 1000 ids; required with `selection`, forbidden otherwise |

Errors: `sessions-manager/forbidden`, `sessions-manager/invalid-request`, `sessions-manager/unsupported-backend`, `sessions-manager/unsupported-platform`, `sessions-manager/trash-unusable`, `sessions-manager/store-unreadable`.

Response `Plan` (validator `assertPlan`). A dry run: nothing moves. The Host keeps the plan by `planId` and `apply` needs nothing else.

| Field | Type | Source |
|---|---|---|
| `planId` | string | computed (issued by the Host) |
| `expiresAt` | integer ms | computed (issue time plus `planTtlMinutes`) |
| `digest` | string | computed (hash over the unit ids, sizes and refusals) |
| `units[].rootId` | string | persistence snapshot |
| `units[].memberIds` | ids, root first, root always included | persistence snapshot (`parentSession` links) |
| `units[].bytes` | integer | persistence snapshot (sum) |
| `units[].workspaceId` | string or null | registry |
| `units[].status` | `ready` or `blocked` | computed |
| `units[].reasons[]` `.code`, `.sessionId` | refusal code, member id; empty exactly when `ready` | computed (sources as for `archived`) |
| `totals.units`, `.ready`, `.blocked` | integers | computed |
| `totals.sessions`, `.readySessions` | integers; the typed confirmation count is `readySessions` | computed |
| `totals.bytes`, `.readyBytes` | integers | computed |
| `byWorkspace[].workspaceId` | string or null | registry |
| `byWorkspace[].units`, `.sessions`, `.bytes` | integers, ready units only | computed |

The validator checks every `totals` field against `units`.

### `apply`

Request: `{ planId, confirmCount }`. `confirmCount` is the integer the user typed. There is no session id and no force option.

Errors: `sessions-manager/forbidden`, `sessions-manager/invalid-request`, `sessions-manager/busy`, `sessions-manager/plan-expired`, `sessions-manager/confirmation-mismatch`, `sessions-manager/unsupported-backend`, `sessions-manager/unsupported-platform`, `sessions-manager/trash-unusable`, `sessions-manager/store-unreadable`.

Response `ApplyResult` (validator `assertApplyResult`). Every unit is re-read first; a unit whose facts changed is skipped, never forced. `restore` returns the same shape: `moved` then counts what came back.

| Field | Type | Source |
|---|---|---|
| `batchId` | batch id, or null when nothing moved | computed (the trash batch folder name) |
| `trashDir` | path | computed (config `dataDir` or `trashDir`) |
| `state` | `complete`, `partial`, `needs-recovery` or `conflict` | computed (fold of the trash journal) |
| `moved.units`, `.sessions` | integers | computed |
| `moved.bytes` | integer | persistence snapshot (sizes taken at move time) |
| `skipped[].rootId` | string | persistence snapshot |
| `skipped[].reasons[]` `.code`, `.sessionId` | refusal code, member id; at least one | computed (re-checked sources as for `archived`, `changed` and `conflict` from lstat) |
| `warnings[].code` | warning code | computed |
| `warnings[].sessionId` | string or null | computed |

### `unarchive`

Request: `{ ids }`, 1 to 1000 session ids (archived roots from the Archived tab). It runs the host's own unarchive, under the trash lock like every other mutation (design.md D6): while another process that shares the trash folder applies, restores or purges, it is `busy` before any registry call. Finding the trash takes one store read. Where no prune can run (no lock probe on the platform, no usable config, backend or trash), there is no lock to share and it runs without one. Otherwise it only calls the registry: no move, no audit line, no journal line.

Errors: `sessions-manager/forbidden`, `sessions-manager/invalid-request`, `sessions-manager/busy`, `sessions-manager/store-unreadable`, `sessions-manager/trash-unusable` (only when the trash folder changes under the lock attempt).

Response `UnarchiveResult` (validator `assertUnarchiveResult`):

| Field | Type | Source |
|---|---|---|
| `unarchived[]` | ids that were unarchived | registry |
| `skipped[].id` | string | registry |
| `skipped[].code` | refusal code (`not-archived`, `live`, `changed`) | computed |

### `trash`

Request: `{}` or `{ fresh: boolean }` (same meaning as for `overview`). With `fresh: true`, when a batch still owes registry steps and pruning is available, the Host first runs its recovery (only if no change is running in this process and the trash lock is free; a failure never fails the read) and then lists the trash again. A plain read only reports. Errors: `sessions-manager/forbidden`, `sessions-manager/invalid-request`, `sessions-manager/trash-unusable`, `sessions-manager/store-unreadable`.

Response `TrashList` (validator `assertTrashList`):

| Field | Type | Source |
|---|---|---|
| `trashDir` | path | computed (config) |
| `batches[].batchId` | batch id | lstat (a real folder of the trash, never a link) |
| `batches[].createdAt` | integer ms | computed (the manifest's time) |
| `batches[].units`, `.sessions`, `.bytes` | integers | computed (what the batch folder holds now: `units` wholly in the trash; `sessions` and `bytes` of every copy in the batch folder, a copy in `conflict` included, since `purge` deletes it too; a complete batch that holds nothing and owes no registry step, for example one fully restored, is not listed, nor is a closed batch) |
| `batches[].state` | `complete`, `needs-recovery` or `conflict` | computed (fold of the batch journal; a batch the fold calls `complete` that still owes registry steps is `needs-recovery`: prune steps (unpin, detach, unarchive) of a unit wholly in the trash, by the journal and the registry; restore steps (attach, insertBefore, archive, pin) of members back in the store, by the journal) |

### `restore`

Request: `{ batchId }`; the id is one path segment (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`).

Errors: `sessions-manager/forbidden`, `sessions-manager/invalid-request`, `sessions-manager/busy`, `sessions-manager/batch-not-found`, `sessions-manager/unsupported-backend`, `sessions-manager/unsupported-platform`, `sessions-manager/trash-unusable`, `sessions-manager/store-unreadable`.

Response: `ApplyResult` (validator `assertApplyResult`; fields and sources as for `apply`). A destination that already exists is skipped with `conflict`; nothing is overwritten. A second restore of the same batch is a no-op. The log of each member must be back as it was when it was moved (revision file part and size journaled right after the move; a batch of an older build has only the hint of the last re-read before the move): a log that changed in the trash is not attached (`recovery-needed`; recovery accepts it later). The batch's archived ids are archived again in their recorded order and its pinned ids pinned in reverse recorded order. A batch wholly back with no registry step left is closed: it stays on disk, unlisted, and recovery skips it.

### `purge`

Request: `{ batchId, confirm }`. `confirm` is the batch id the user typed.

Errors: `sessions-manager/forbidden`, `sessions-manager/invalid-request`, `sessions-manager/busy`, `sessions-manager/purge-disabled`, `sessions-manager/confirmation-mismatch`, `sessions-manager/batch-not-found`, `sessions-manager/unsupported-backend`, `sessions-manager/unsupported-platform`, `sessions-manager/trash-unusable`, `sessions-manager/store-unreadable`.

The Host checks only that `confirm` equals `batchId`: the typed id and the second confirmation are the Client's gates for the owner, not a secret.

Response `PurgeResult` (validator `assertPurgeResult`). The only call that deletes for good.

| Field | Type | Source |
|---|---|---|
| `batchId` | batch id | computed |
| `removedSessions` | integer | computed (manifest) |
| `removedBytes` | integer | lstat (sizes measured before removal) |

## HostFacts

The engine modules (lineage, trash, audit, store index) see the host only through `HostFacts`, a JSDoc typedef in [`src/contract.js`](../src/contract.js). The Host adapter implements it over official services; tests use the fake in `test/helpers/fixtures.mjs`.

| Member | Returns | Source |
|---|---|---|
| `snapshots()` | `SessionSnapshot[]`: `id`, `parentId`, `dir`, `logPath`, `group`, `bytes`, `events`, `createdAt`, `lastActivityAt`, `unreadable`. The host adapter passes the host's own persistence snapshot shape instead (`header`, `location`, `revision`, `formatStatus`, `eventCount`, `sizeBytes`, primitives only); the store index reads both. | persistence snapshot |
| `workspaces()` | `[{ id, name, path, sessionIds }]` | registry |
| `archivedIds()`, `pinnedIds()` | ids | registry |
| `liveIds()` | ids | live-session service |
| `lockState(folder)` | `{ state: 'none' / 'held' / 'stale', pid }`; a folder the probe refuses as unsafe (a symbolic link, not a directory, or swapped while probed) is never probed through and reads `none`: its own lstat refuses it (`path-unsafe` or `no-location`), and `apply` refuses it again as `path-unsafe` | lstat |
| `statLog(path)` | `{ exists, isSymlink, mtimeMs, bytes, dev }` | lstat |
| `titleOf(id)` | string or null, never from a log body | computed |
| `unpin(id)`, `detach(id)`, `unarchive(id)`, `attach(id, workspaceId)`, `archive(id)`, `pin(id)` | nothing; the registry steps | registry |

Any method may return a value or a promise; callers always await.
