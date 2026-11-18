# Store safety under a running JSONL backend

Findings of the store-safety spike (plan task T3). They decide the move order, the registry policy and the refusal rules of the prune. [design.md](design.md) stays the authority for the product; where a finding below contradicts one of its decisions, the conflict is listed in [Conflicts with design.md](#conflicts-with-designmd) for the user to decide.

## Contents

- [Sources and how to re-run](#sources-and-how-to-re-run)
- [Decisions in brief](#decisions-in-brief)
- [API table](#api-table)
- [Registry policy](#registry-policy)
- [Experiments S1–S6](#experiments-s1s6)
- [Locks](#locks)
- [Lineage](#lineage)
- [Ghost ids](#ghost-ids)
- [Cost](#cost)
- [Titles](#titles)
- [Caches](#caches)
- [Config](#config)
- [Plugin rules](#plugin-rules)
- [Conflicts with design.md](#conflicts-with-designmd)
- [Doubts and limits](#doubts-and-limits)

## Sources and how to re-run

| Prefix in this file | Meaning |
|---|---|
| `rc4:` | Upstream source checkout, version `0.2.2-rc.4` (branch `fix/session-search-bounded-index`, head `e1f2349309`). Paths are relative to the checkout. |
| `rc3:` | The installed app, version `0.2.2-rc.3`: `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/<package>/src/…`. Read only, never run. |
| `inspect:` | Host service catalog of the running app, saved by the inspect tool to `/tmp/sessions-plugin-inspect/host-services-listService.txt` (line numbers of that file). |
| `S1`…`C1` | Tests in [../test/upstream-persistence.test.mjs](../test/upstream-persistence.test.mjs). Each test prints its observations as one JSON diagnostic line. |

Every experiment ran against the rc.4 sources (JSONL backend, storage-json, storage-domain, workspace registry) loaded through the checkout's own tsx and tsconfig paths, on stores created with `fs.mkdtemp` under `os.tmpdir()`, with decoy `HOME`, `DSH_HOME` and XDG roots that the last test asserts stayed empty.

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"   # the checkout needs Node >= 24.9
DSH_UPSTREAM_DIR=/Users/macbook/projects/deepseek-harness \
  node --test packages/sessions/test/upstream-persistence.test.mjs
# without DSH_UPSTREAM_DIR: 1 test, skipped, exit 0
```

Last run on this machine (macOS 26, darwin 25.5.0, APFS): 11 tests, 11 passed, 0 failed, 16.9 s (14 s of it is seeding 400 sessions for C1).

## Decisions in brief

- **Registry policy: `at-prune`.** The host has an official re-attach call: `Workspace.attachSession(sessionId)`, the same call the host uses for every new session and fork. Restore is move back, verify, attach, reorder, archive, pin; the full cycle restores membership, order, archive and pin sets exactly (G2). The fallback `at-purge` is not safe: the host itself prunes a ghost from its workspace on the next mutation after a restart, so a later restore lands the session in *Ungrouped* (G1).
- **The backend keeps no id→path cache and never serves a moved current-format log from memory.** Every `open`, `stat` and handle read resolves the folder again; the cold-log memo is checked only after the file is found (S1, S2). No restart is needed for persistence.
- **`session.lock` is a kernel `flock(2)` target, not a lease file.** It is empty, has no pid and no expiry, and is never removed. Its presence means nothing; only a non-blocking exclusive flock tells *held* from *stale* (S4, L1–L3). On macOS plain Node can do that probe (`O_EXLOCK | O_NONBLOCK`) and can hold the lock across the rename.
- **A writer whose folder moves fails loudly on its next append (`ENOENT`) and silently on flush** (S3). Live and locked sessions must be refused before the move.
- **`list()` reads one 8 KiB header chunk per session and never a whole log**: 400 sessions, 13.7 MB on disk, 74 ms cold and 13 ms warm on rc.4 (C1). rc.3 has no header cache, so every rc.3 `list()` costs the cold figure. A 15 s snapshot TTL is enough.
- **Three things break the host's whole listing and must never happen**: a session folder under the wrong project directory (S5), the same id in two project directories, and a project directory that disappears while a listing runs (S6). Moving whole session folders in and out is safe even during a concurrent `list()` (S6).
- **Titles without a log read**: `sessionProjectionCache.cachedSnapshot(header, ['title'])`, synchronous and zero-I/O, the same source the sidebar uses for cold rows. No session-search or projection-cache evict call exists; the search index drops unlisted sessions on its next search, and projection-cache rows stay as harmless orphans.

## API table

Sync means the call returns a value; async means it returns a promise. All registry mutations run on one serialized operation chain, and each one first completes an interrupted workspace create/delete (`rc4:packages/workspace/workspace/src/index.ts:925-934`).

### workspaceRegistry (`ctx.workspaceRegistry`, plugin `@deepseek-ai/dsh-workspace`)

| Call | rc.4 | rc.3 (`rc3:dsh-workspace/src/`) | inspect | Kind | Errors and behaviour |
|---|---|---|---|---|---|
| `list(): Workspace[]` | `index.ts:317` | `index.ts:308` | `:2655` | sync | Throws `Error` if the durable order names a missing workspace; no persistence I/O. |
| `get(id): Workspace \| undefined` | `index.ts:307` | `index.ts:298` | `:2652` | sync | `undefined` for an unknown id. |
| `archiveSession(id, { stopActivity? })` | `index.ts:390`, options `:104-112` | `index.ts:381` | `:2664` | async | `WorkspaceUnknownSessionError` (`:48`) when neither live nor in persistence nor in the header cache; `WorkspaceActiveSessionError` (`:64`) when the activity waterfall reports work and `stopActivity` is not set. Already archived: no-op. Drops the pin in the same write; dispatches `workspace/session-archived` (failures only logged). |
| `unarchiveSession(id)` | `index.ts:429` | `index.ts:420` | `:2667` | async | No existence check, so a ghost id unarchives. Not archived: no-op. Awaits `workspace/session-unarchiving`; a rejecting listener rejects the call and keeps the id archived. |
| `pinSession(id)` | `index.ts:459` | `index.ts:450` | `:2670` | async | `WorkspaceArchivedSessionPinError` (`:76`) for an archived id; `WorkspaceUnknownSessionError` for an unknown one. Already pinned: no-op. |
| `unpinSession(id)` | `index.ts:486` | `index.ts:477` | `:2673` | async | No existence check. Not pinned: no-op. |
| `archivedSessionIds` | getter `index.ts:369` | `index.ts:360` | not listed | sync | `readonly SessionId[]` in archive order; the live state array, copy it. Never pruned by the host. |
| `pinnedSessionIds` | getter `index.ts:448` | `index.ts:439` | not listed | sync | Most recently pinned first; never pruned by the host. |

### Workspace entity (returned by `list()`/`get()`; not in the inspect catalog)

| Member | rc.4 | rc.3 | Kind | Errors and behaviour |
|---|---|---|---|---|
| `sessionIds` | `entity.ts:110`, contract `types.ts:89-100` | `entity.ts:102`, `types.ts:100` | sync | Durable account filtered by the registry's header index: ids without an indexed header, without a cwd or with a mismatching cwd are hidden; a missing cwd directory keeps the id. The index is built at startup and only grows during a run (`index.ts:194`, `:838-861`). |
| `attachSession(id)` | `entity.ts:123`, `types.ts:126` | `entity.ts:110`, `types.ts:120` | async | Prepends. Throws `Error` when the header has no cwd, the cwd does not resolve, is not a directory, resolves elsewhere, or "session persistence holds no such session" (`index.ts:892-908`). Skips all validation when the raw durable account already holds the id (`entity.ts:128`) — then it resolves and its write prunes the id instead (G1b). |
| `detachSession(id)` | `entity.ts:188`, `types.ts:150` | `entity.ts:175`, `types.ts:144` | async | Idempotent; acts on the raw durable account, so it also works after a restart has hidden the id. |
| `insertSessionBefore(id, beforeId?)` | `entity.ts:165`, `types.ts:140` | `entity.ts:152`, `types.ts:134` | async | `WorkspaceMoveInvalidError` when either id is not on the account; no anchor appends. |
| `getSessionHeaders()` | `entity.ts:115` | absent | sync | rc.4 only. |
| `status()` | `entity.ts:194` | `entity.ts:181` | async | `'ok' \| 'missing-dir'`. |
| every mutation | `entity.ts:216-234` | `entity.ts:191-222` | async | Writes through `table.update` and prunes every hidden candidate (except missing-directory ones) in the same write. Storage errors propagate. |

### Sessions, persistence, projection cache, profile

| Call | rc.4 | rc.3 | inspect | Kind | Errors and behaviour |
|---|---|---|---|---|---|
| `sessions.list(): Session[]` | `packages/core/session/src/index.ts:1463` | `dsh-session/src/index.ts:1463` | `:1837` | sync | In-memory live sessions only. |
| `sessions.get(id)` | `…/index.ts:1455` | `…/index.ts:1455` | `:1834` | sync | `undefined` when not live. |
| `sessionPersistence.list()` | seam `packages/session/session-persistence/src/index.ts:233`; JSONL `packages/session/session-persistence-jsonl/src/index.ts:615-645` | JSONL `dsh-session-persistence-jsonl/src/index.ts:522` | `:1678` | async | One snapshot per readable session plus this process's unmaterialized ones. Unreadable or unsupported headers are omitted. Rejects for a folder at the wrong path (`:1719-1746`, S5), a duplicate id across project directories (`:1263`), a project directory that vanishes mid-listing (`:1801-1809`, S6), flat-layout or opposite-encoding files. |
| snapshot fields | seam `index.ts:51-68` | seam `dsh-session-persistence/src/index.ts:51-68` | — | — | `header` (`version, id, createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth, agentPreset?`), `formatStatus` (`current` \| `migration-required`), `revision` (`dev:ino:size:mtimeNs:ctimeNs`, `rc4 …jsonl/src/index.ts:220-228`; historical generations add a corpus digest), `sizeBytes` (selected generation only), `location: { kind: 'jsonl', path }`. No `eventCount` from JSONL. No title. |
| `sessionPersistence.stat(id)` | `…jsonl/src/index.ts:576` | `…jsonl/src/index.ts:483` | `:1675` | async | `undefined` when absent; same identity rejections as `list()`. |
| `sessionPersistence.open(id, 'read' \| 'write')` | `…jsonl/src/index.ts:479`, write path `:516-521` | `…jsonl/src/index.ts:423-429` | `:1669` | async | `SessionPersistenceNotFoundError`; write: `SessionAlreadyOwnedError` (in-process claim or kernel lock). A write open of a historical generation publishes a migrated successor file. |
| `sessionProjectionCache.cachedSnapshot(header, keys?)` | `packages/session/session-projection-cache/src/index.ts:162-170` | `dsh-session-projection-cache/src/index.ts:162-170` | `:1687` | sync, zero I/O | `undefined` on a miss or identity mismatch (`createdAt`, `cwd`, `isSeeded`, format version). |
| `sessionProjectionCache.cachedPredecessorTitle(header)` | `…/index.ts:187-192` | `…/index.ts:187-192` | `:1690` | sync, zero I/O | Title row of a pre-migration checkpoint. |
| `profileContext.home` | `packages/boot/app-boot/src/profile-context.ts:23` | `dsh-app-boot/src/profile-context.ts:23` | `:1407-1422` (field not shown) | sync | DSH home (`$DSH_HOME` or `~/.dsh`). The service exists only in a profile launched by dsh (`:34-35`), so use `ctx.get('profileContext')?.home`. |

The `workspaceController` Remote methods (`inspect:2601-2613`) wrap the same registry calls for the browser; the plugin calls the registry directly.

## Registry policy

**Restore gate: an official re-attach exists. `registryPolicy = 'at-prune'`.**

Evidence:

- `Workspace.attachSession` is part of the public `Workspace` interface in both builds (`rc4:packages/workspace/workspace/src/types.ts:115-126`, `rc3:dsh-workspace/src/types.ts:109-120`).
- The host re-registers sessions with exactly this call: new sessions (`rc4:packages/api/session-controller/src/commands.ts:147-149`), forks (`rc4:…/commands.ts:302-304`, `rc3:dsh-api-session-controller/src/commands.ts:300-302`), schedule deliveries (`rc4:packages/schedule/schedule/src/runtime.ts:487`) and imports (`rc4:packages/experimental/deepseek-chat-import/src/importer.ts:547-549`).
- There is no automatic adoption on scan after the first start: the one-time bootstrap runs only while the registry is uninitialized (`rc4:…/workspace/src/index.ts:233-236`, `:681-773`).
- G2 runs the full cycle on the host's own storage-json + workspace composition and gets back the exact original state, including after two restarts.

Prune (after the manifest and the rename): **unpin → detach → unarchive**, each idempotent.

- Record in the manifest before the move, per member: owning `workspaceId` (find it while the id is still visible), its position (the next id in that workspace's `sessionIds`), `archived`, `pinned`.
- Call `detachSession` on the recorded workspace. After a restart the id is hidden but still in the raw account, and `detachSession` still removes it.

Restore: **move back → verify → attach → reorder → archive → pin**.

1. Move back to the exact recorded folder; then `stat(id)` must return the recorded `revision` and `sizeBytes` (S5 shows both are unchanged by a same-device rename round trip).
2. `get(workspaceId).attachSession(id)`, then check `workspace.sessionIds.includes(id)`: a resolved attach does not prove membership (G1b).
3. `insertSessionBefore(id, anchor)`, with the anchor taken from the recorded order. Handle members in reverse recorded order so that every anchor is back first (G2).
4. `archiveSession(id)` without `stopActivity` for members that were archived. It re-dispatches `workspace/session-archived` follow-ups (for example worktree reclamation); they already ran when the session was first archived.
5. `pinSession(id)` only for members that were pinned and not archived. Archived and pinned are mutually exclusive: `pinSession` on an archived id throws `WorkspaceArchivedSessionPinError` (G2), and archiving clears the pin.

`workspace-missing`: `get(workspaceId)` is `undefined`, or `attachSession` rejects because the cwd no longer resolves. Then the unit stays in trash (or, if the folder was already moved back, it stays unattached and is reported).

The order the restore must follow is enforced by the host only after a restart. In the same run the registry's header cache validates a moved id, so `attachSession` succeeds while the log is still in trash (G2 `sameRunAttachWithoutLog`). The plugin must verify the log (step 1) before it attaches.

The plugin never writes `workspace.json`. The reference script's host-stopped overwrite (`docs/reference/prune-archived-sessions.py:206-221`) is not needed.

## Experiments S1–S6

All on a fresh temp store with the rc.4 JSONL backend (`compression: 'zstd'`), trash on the same device. *Rule* is what the plugin must do.

| # | Experiment | Observed | Rule |
|---|---|---|---|
| S1 | Move a cold (closed) session folder, then `list()`, `stat()`, `open()` on the same backend instance and on a second instance. | The id is gone from `list()`, `stat()` returns `undefined`, `open(id,'read')` rejects `SessionPersistenceNotFoundError`; the sibling session in the same project is unaffected. Cause: every call resolves the folder with a directory scan (`findLog`, `rc4:…jsonl/src/index.ts:1691-1706`); the listing header cache is keyed by path and replaced on every complete listing (`:356`, `:1225-1271`). | **Verify after move**: `stat(id) === undefined`, otherwise report `stale-backend-entry`. No evict call is needed. |
| S2 | Open and read a session (12 events, now in the cold-log memo), keep the read handle open, move the folder, then `open()` again and `read()` on the old handle; move back and read again. | Both the new open and the old handle's `read()` reject `SessionPersistenceNotFoundError`: the memo is checked only after `findLog` found the file (`:650-654`, `:700-706`). After the move back the memo answered with 0 whole-log reads (same id, same revision). | **Safe** for current-format (v4) logs; no restart needed. Exception, by source only: an open *read* handle on a historical (v<4) generation keeps serving its primed events from memory (`rc4:…jsonl/src/storage.ts:135-146`). |
| S3 | Open a write handle, move the folder, then `append`, handle `flush`, service `flush`, `close`. | `append` rejects `ENOENT` (`open(path,'a')` at the old path, `index.ts:1529-1532`); both flushes resolve (a materialized handle's flush is a no-op, `storage.ts:211`); `close` resolves; the old folder is not recreated; the moved log is unchanged (596 → 596 bytes); after moving back the log has the original 6 events. The writer's flock travels with the folder (probe at the trash path: `held`). | **Refuse** `live` and `locked` before the move: a moved writer loses every later append, and flush gives no signal. Hold the lock across the rename (L3). |
| S4 | `session.lock` stale and held; see [Locks](#locks). | Stale lock files never block; a held lock blocks a second host's write open, not its reads; the file stays after release. A folder holding only `session.lock` is not a session (not listed, `stat` undefined). | **Refuse** `locked` on a *held* probe only. A stale lock file needs no replacement and no journal. |
| S5 | Snapshot (revision, size, events), move out, move back to the exact folder, compare; then append; then put the folder under another project directory; then rename onto existing directories. | Same `revision` string (`dev:ino:size:mtimeNs:ctimeNs`) on this and on a fresh backend instance, same `sizeBytes` (1001), same `location.path`, same event count (12); the revision changes after an append. A folder under the wrong project directory makes **`list()` and `stat()` reject for the whole store** (`corrupt session log … header id and cwd identify …`, `index.ts:1719-1746` via `:1274-1286`). `rename(2)` onto an existing **empty** directory succeeds and replaces it; onto a non-empty one it fails `ENOTEMPTY`. | **Verify after move back**: `stat(id).revision` and `sizeBytes` equal the manifest. Restore only to the exact recorded folder; check that the destination is absent (`lstat` → `ENOENT`) under the plugin's trash lock before renaming, because rename does not refuse an empty destination. |
| S6 | 60 sessions in 3 projects; 30 `list()` calls started while 30 session folders are moved one per event-loop turn; then a project directory removed between the root and project reads (deterministic hook on `readdir`). | All 30 concurrent listings resolve (each saw 30–60 sessions); the final listing has 30. The vanished project directory makes `list()` reject `ENOENT` (`listSessionDirs` does not catch it, `index.ts:1801-1809`); the next listing recovers. | **Safe** to move session folders while the host lists. **Never** move, remove or rename a project directory (`<root>/--…--/`), not even an empty one; restore creates a missing project directory with `mkdir -p`, mode `0700`. |

## Locks

File and content (`rc4:packages/session/session-persistence-jsonl/src/lease.ts`, identical in `rc3:dsh-session-persistence-jsonl/src/lease.ts:1-45`):

- Name `session.lock` beside the log (`lease.ts:40`). It is the target of a non-blocking `flock(LOCK_EX)` taken through the native system addon (`:94`). Windows uses a named kernel semaphore and has no file (`:4-6`, `:76-86`).
- Content: none. The holder opens it with `'w'` (`:91`), so it is 0 bytes; no pid, no host, no time (L1, L2: 0 bytes while held and after).
- Expiry: none by design (`:10-13`). The kernel drops the lock when the holder's descriptor closes, including on process death; a live but wedged holder keeps it until it exits.
- Release never removes the file (`:118-134`). Every session that was ever written has a `session.lock`. **Presence means nothing.**
- Taken at write-open of an existing session and right before a new session's first write (`:20-22`); readers never touch it (L2: a second host's read open succeeds while the lock is held).
- The holder verifies that its locked inode is still the file at the path (`:99-105`), so deleting or replacing a live session's `session.lock` silently ends its exclusion. The plugin must never remove, recreate or write the file.

**The `lockState(folder)` rule** (S4; darwin):

```text
lockState(folder):
  path = folder + '/session.lock'
  if a '*.tmp' file is in folder        -> 'busy'    (materialize/migration publish in flight)
  fd = open(path, O_RDONLY | O_EXLOCK | O_NONBLOCK)    // O_EXLOCK = 0x20, flock semantics
    ENOENT              -> 'absent'  (never written by this build; not a lock)
    EAGAIN/EWOULDBLOCK  -> 'held'    -> refuse 'locked'
    success             -> 'stale'   (present, not held); close fd, or keep it to hold the lock
```

The probe opens read-only, so it never creates, truncates or replaces the inode the backend verifies against. Measured: `stale` → `free`, held by a write handle → `held`, after close → `free` (L1–L2).

**Holding across the rename (L3).** While the plugin holds that descriptor, both hosts' write opens reject `SessionAlreadyOwnedError`. After the rename, a write open rejects `SessionPersistenceNotFoundError`. So: probe and hold → rename → close the descriptor.

**Two hosts on one store.** The kernel lock excludes concurrent writers across processes, listing and reading need no lock, and each host's `sessions` service sees only its own live sessions. Two hosts can share the session store; the remaining risks are:

1. A write open that has passed its folder lookup but not yet locked (`rc4:…jsonl/src/index.ts:519-521`) when the plugin renames. Its lease `mkdir -p` recreates the old folder with an empty `session.lock` (`lease.ts:74`), and the open then fails not-found. A restore later finds a lock-only folder at the destination: report `conflict` (lock-only leftover); never delete it automatically. Holding the flock across the rename shortens the window but does not close it.
2. The workspace registry is per-process memory over one `storages/workspace.json`, and storage-json is last-writer-wins by design (`rc4:packages/storage/storage-json/src/atomic.ts:4-10`). The other host's next registry write can bring back ids the plugin unpinned, detached or unarchived. They are then ghosts, and the host hides them again after its restart. Prune and restore should run with a single host.
3. There is no lock probe without native code outside darwin; Windows has no lock file at all.

## Lineage

Header fields (`rc4:packages/core/session/src/types.ts:95-132`):

| Kind | `origin` | `parentSession` | `isSeeded` | `delegationDepth` | Source |
|---|---|---|---|---|---|
| Subagent child | `'subagent'` | creator's id | true or false (forked-context subagents are seeded) | parent + 1 | `rc4:packages/subagent/subagent/src/child-agent.ts:135-153` |
| User fork (rc.3, rc.4) | absent | **absent** | `true` | absent/0 | `rc4:packages/api/session-controller/src/commands.ts:280-291`, `rc3:dsh-api-session-controller/src/commands.ts:279-289` |
| Historical user fork | absent | may hold the source id | `true` | absent/0 | `types.ts:111-116`: "presence alone does not classify a Session as a subagent; use `origin`" |

- The discriminator is `origin === 'subagent'`. `isSeeded` does not separate children from forks. A current fork is not linked to its source at all, so a `parentSession` cascade never reaches it. A descendant reached through `parentSession` without `origin: 'subagent'` is a historical fork: treat it as `kept-descendant` unless it is archived.
- Forks are attached to the source's workspace (`commands.ts:302-304`), so they appear in `Workspace.sessionIds`. The subagent runtime never attaches children, but the one-time first-start bootstrap groups every stored header by cwd, children included (G1 step 1: the bootstrap account is `[kept, child, archived, pinned]`). On a store bootstrapped from history, children can therefore be workspace members. The sidebar never shows children as rows (`origin === 'subagent'` is hidden, `rc4:packages/client/ui-workspace/src/client/tree.ts:240`, `rc3:dsh-client-ui-workspace/src/client/tree.ts:235`).
- A child can be archived without its parent: `archiveSession` checks only that the id is known (`rc4:…/workspace/src/index.ts:390-417`), so the API allows it, but the GUI has no row for it. The reverse is gated: an archived ancestor blocks every later step of its descendants (`rc4:packages/subagent/subagent/src/archive-admission.ts:1-19`, `:51-52`).

## Ghost ids

A ghost is an id that the registry still holds while its log is gone. Observations from tests G1, G1b and G2, which use the host's own composition (storage, storage-json, storage-domain, JSONL, workspace) in a temp sandbox. In the sandbox, *kept* K, *child* C (subagent of A), *archived* A and *pinned* N all have the workspace directory as cwd; A is archived and N pinned; A, C and N are then moved to trash with the registry untouched.

| Step | Observation |
|---|---|
| G1.1 bootstrap | Account `[K, C, A, N]` (children included). |
| G1.2 same run, after the move | `sessionIds` still `[K, C, A, N]`, archive `[A]`, pin `[N]`; `list()` shows only K. The header cache keeps ghosts as members until restart. |
| G1.3 after restart | `sessionIds` `[K]`; durable record still `[K, C, A, N]` (filtering does not write). Archive `[A]` and pin `[N]` are kept: these sets are never pruned. `archiveSession(N)` and `pinSession(C)` reject `WorkspaceUnknownSessionError`. `unarchiveSession`/`unpinSession` of an unknown id resolve. Startup logs `workspace '<id>' filtered session '<id>' from membership: session header is missing` (`rc4:…/workspace/src/index.ts:875-890`); there is no error and no failed start. |
| G1.4 any mutation of that workspace (`setTitle`) | Durable record pruned to `[K]` (`entity.ts:216-228`). `attachSession(A)` then rejects "session persistence holds no such session". |
| G1.5 move back with the registry untouched | `list()` has all 4 again, but `sessionIds` stays `[K]`: the sessions are unaccounted and show under *Ungrouped*; A is still archived, N still pinned. |
| G1b attach of a ghost after a restart, before any other mutation | Resolves without error, but because the raw account already holds the id it skips validation, and its own write prunes the id (`sessionIds` and durable record `[K, C, N]`). After the move back, a second attach really attaches, prepending (`[A, K, C, N]`). |
| G2 at-prune | After unpin/detach/unarchive the account is `[K, N]` and the archive set is empty, in memory, on disk and after a restart: no ghosts, no warnings. Restore gives back `[K, C, A, N]`, archive `[A]`, pin `[N]`, also after a restart. |

What the user sees (client source):

- **Sidebar and archived list**: a member id without a session-list row is skipped silently. The comment reads "account may lead the list pull; the row appears when the summary lands" (`rc4:packages/client/ui-workspace/src/client/tree.ts:342-344`, `rc3:dsh-client-ui-workspace/src/client/tree.ts:337-339`). The session list comes from `sessionPersistence.list()` plus live sessions (`rc4:packages/api/session-controller/src/list.ts:111-144`, `rc3:dsh-api-session-controller/src/list.ts:145-178`). A ghost therefore has no row in either the default or the archived filter, archived or not.
- **Errors**: none at startup and none in the GUI. Only the registry calls in G1.3 reject.
- **Not observed**: the browser itself was not driven, so how long an already-loaded session-list row lingers in an open page after a prune (until its next list pull) is untested.

## Cost

C1 (default run, rc.4): 400 sessions in 8 projects, 2 turns each with 32 KiB of incompressible text; 13,667,331 bytes on disk. Measured on a fresh backend instance:

| | wall | bytes read | whole-log reads | heap growth during call | heap retained after gc |
|---|---|---|---|---|---|
| cold `list()` (empty header cache) | 74 ms | 3,276,800 (400 × one 8 KiB chunk) | 0 | 5.7 MB | 0.27 MB |
| warm `list()` (unchanged store) | 13 ms | 0 (stat only) | 0 | 16.2 MB | 0.32 MB |
| control: one `open` + `read` | — | 34,166 | 1 | — | — |

The second run gave the same figures (70/14 ms, 0.8 MB retained). The 8 KiB first read comes from the header reader's chunk size (`rc4:…jsonl/src/index.ts:1615-1649`, chunk `:1621`): `list()` decodes only the first Zstandard frame, which holds the header line, and never more. Bytes read grow with the number of sessions, not with their size.

On rc.3 the backend has no listing header cache (fields at `rc3:dsh-session-persistence-jsonl/src/index.ts:295-314`; rc.4 added it at `:356`), so every rc.3 `list()` costs about the cold figure: roughly 80 ms for the ~430 sessions of the real store.

Recommendation: keep `snapshotTtlMs` at 15,000 and never list per row or per keystroke. For on-disk size, add `stat` of every file in the session folder, because `sizeBytes` covers only the selected generation and a folder can keep retained historical generations. That is metadata only, one `readdir` plus N `stat` calls per session.

Measurement command (the size knobs are optional):

```sh
DSH_UPSTREAM_DIR=/Users/macbook/projects/deepseek-harness SPIKE_SESSIONS=400 SPIKE_PAYLOAD_BYTES=32768 \
  node --test --test-name-pattern='^C1' packages/sessions/test/upstream-persistence.test.mjs
```

## Titles

- **Cheapest source: the projection-cache row.** Use `ctx.get('sessionProjectionCache')?.cachedSnapshot(header, ['title'])?.values.title`, falling back to `cachedPredecessorTitle(header)?.values.title` for a session not yet migrated. Both are synchronous, read the cache's in-memory domain table and do no I/O (`rc4:packages/session/session-projection-cache/src/index.ts:162-192`). The value is `string | null` (`rc4:packages/session/session-title/src/types.ts:80-87`). The sidebar uses exactly this path for every cold row (`rc4:packages/api/session-controller/src/list.ts:285-289`; rc.3 `summarizeCold`, `rc3:dsh-api-session-controller/src/list.ts:180-181`). Verified from source only; no experiment mounted the title projection.
- The header carries no title (fields above). The registry has none either: a workspace record holds `path`, `title` (the workspace's own), `sessionIds` and timestamps.
- `sessionQuery.readTitle*` folds the session log (`rc4:packages/session-query/session-query/src/index.ts:281-292`) and is not allowed.
- A miss (no row, or a row from another lifecycle) means: short id, workspace and creation date (D13).

## Caches

- **Projection cache: no per-session evict, remove or delete call** in either build. The service has only `cachedSnapshot`, `cachedPredecessorTitle`, `hydratePrepared`, `write` and `coldSnapshot` (`rc4:…/session-projection-cache/src/index.ts`, 472 lines, identical length in rc.3; `inspect:1683-1701`). Rows are keyed by session id and served only for a matching header from a listing. A moved session's row is therefore never served while it is in trash, and it matches again after a restore (the header is unchanged). After a permanent delete the row stays as an orphan document under the storages folder. It costs disk space only, and nothing in the host deletes it.
- **Search index (SQLite FTS): no per-session evict call, and none is needed.** Before every search the index reconciles with `sessionPersistence.list()` and deletes the rows of every persisted session that is no longer listed (`rc4:packages/session-query/session-query-sqlite/src/index.ts:427-482`, deletes `:438-440`, `:467`; `rc3:dsh-session-query-sqlite/src/index.ts:407-425`, `:456`). A pruned session drops out of search at the next search, not at restart; a restored one is indexed again at the next search. A prune running during a search can make that search fail once with "did not stabilize" (`rc4:…:503-568`).
- The plugin touches neither the projection-cache folder nor the search database, and never calls search (D12 stands).

## Config

The Plugin Manager does not need an exported `Config` schema. Without one, Cordis passes the raw config through (`rc4:vendor/cordis/src/fiber.ts:80-81`), and the repo convention (plain object validated in `apply`, `packages/usage/src/index.host.js:38-39`) is enough to install, load and configure the plugin through its profile patch. The only loss is the Settings form: Settings lists only entries that have a schema (`rc4:packages/settings/settings/src/index.ts:302-306`, `rc3:dsh-settings/src/index.ts:302-307`). Export a schemastery `Config` only if the user wants to edit `dataDir`, limits or `allowPermanentDelete` in the Settings page.

## Plugin rules

Consolidated from the sections above; T6/T9 implement them.

1. The unit of transfer is the session folder `dirname(snapshot.location.path)`, moved with `rename` only (same device, no copy). Trash lives outside the sessions root. Project directories are never moved or removed.
2. Refuse before the move: `live` (`sessions.get(id)`), `locked` (lock probe `held` or `busy`), and the existing codes. On darwin, hold the probe descriptor across the rename and close it afterwards.
3. After each move: `stat(id)` must be `undefined`; otherwise warn `stale-backend-entry` and stop that unit.
4. Registry at prune (`at-prune`): unpin → detach (recorded workspace) → unarchive, each idempotent and journaled; the manifest is written first.
5. Restore: the destination must be absent (`lstat` → `ENOENT`; a lock-only folder is `conflict`); move back to the exact recorded folder; `stat(id).revision` and `sizeBytes` must equal the manifest; then attach, check membership, `insertSessionBefore` with the recorded anchor, archive, pin (non-archived members only).
6. Never write `workspace.json`, `session.lock`, the projection-cache folder or the search database.
7. Snapshot TTL 15 s; sizes from per-file `stat` in the folder.
8. Prune and restore assume one host (or accept the registry race in [Locks](#locks)).

## Conflicts with design.md

For the user to decide; design.md is unchanged.

- **D6** ("refuse on a present, non-stale `session.lock` … a stale lock whose recorded pid is dead is replaced automatically and journaled"): the lock file records no pid and is never stale in that sense. Every written session has one. Replacing it would break the backend's inode check. The finding is: refuse on a held flock probe; never replace or touch the file.
- **D12** ("stale entries stay until the host restarts"): true for projection-cache rows (they stay forever, unserved); false for the search index, which drops unlisted sessions at its next search.
- **D14** ("if the backend still serves a moved session from memory … restart recommended"): the backend does not, for current-format logs (S1, S2). The registry's in-memory header cache does keep ghosts in the same run, but with `at-prune` the detach removes them. A *restart recommended* warning is needed only for the historical-generation read-handle case and for a second host.
- Restore order in the plan ("move back → attach → archive → pin"): pin must skip archived members, which are never pinned; position needs `insertSessionBefore`, because attach prepends.

## Doubts and limits

- All runs were on rc.4 sources; rc.3 was read, not run. The registry, lease, persistence seam, projection cache, fork and sidebar code cited for rc.3 matches rc.4 at the cited lines, except that rc.3 lacks the listing header cache and `getSessionHeaders()`.
- macOS only: the `O_EXLOCK` probe is darwin-specific. Linux has no pure-Node flock, and Windows uses a semaphore without a file. Prune there needs another liveness source or must refuse `locked`; open question.
- The GUI was not driven. Ghost visibility comes from the registry experiments plus client source, not from a rendered page; in particular, how long a stale row stays in an already-open page is untested.
- The cost was measured on synthetic 2-turn sessions under `os.tmpdir()` (APFS), not on the real store. Seeding is slow (14 s for 400 sessions) only because every materialization fsyncs.
- Historical (v<4) generations were not exercised. Their stat/list revisions append a digest of every generation file in the store (`rc4:…jsonl/src/index.ts:596-598`, `:624-635`), so any change anywhere in the store (an append to another session, another move) changes them. The manifest revision comparison would then fail spuriously for such sessions. For `formatStatus: 'migration-required'`, compare only the file part of the revision (its first five `:`-separated fields, `dev:ino:size:mtimeNs:ctimeNs`), `sizeBytes` and path, or refuse them in v1.
- The real store's bootstrap may already account subagent children in workspaces; whether the dashboard should count such members as "kept" needs the lineage rule above (`origin`), not membership alone.
