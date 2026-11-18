# Sessions manager: dashboard design and decisions

Design record for `dsh-plugin-sessions`. The build tasks implement this file. Where a build task contradicts it, this file wins until the user changes it.

## What it is

A dashboard page in the DeepSeek Harness Web GUI that shows what the session store holds, lists archived sessions, and prunes them safely. DSH has no session delete: archiving only hides a session and its log stays on disk. A prune moves an archived session and all its subagent descendants into a trash folder, can be undone, and is deleted for good only by a separate typed action.

The page is for the owner of the machine. No agent can use it. It never prunes, restores or deletes on its own. Only recovery runs without a click, when the plugin starts (or at the first page call, if the host services are not ready yet) and on a fresh Trash read, and it only finishes interrupted work (D20).

## Layout

One page, titled **Sessions**, with a header and three tabs: **Overview**, **Archived**, **Trash**.

```text
┌─ Sessions ───────────────────────────────────────────────────────────────┐
│ /Users/me/.dsh/sessions            [Prune available]  [Refresh] 20:41    │
├ Overview ─ Archived (80) ─ Trash (1) ────────────────────────────────────┤
│ ┌Total────┐ ┌On disk──┐ ┌Archived─┐ ┌Reclaimable┐ ┌Largest───┐           │
│ │ 426     │ │ 579 MB  │ │ 239 MB  │ │ 437 MB    │ │ 115 MB   │           │
│ │ live 3  │ │ Index   │ │ 80 roots│ │ 206 ready │ │ title    │           │
│ │ arch 80 │ │ load:   │ │ +126    │ │ 0 blocked │ │ workspace│           │
│ │ kids 312│ │ [High]  │ │ children│ │ [Review…] │ │          │           │
│ └─────────┘ └─────────┘ └─────────┘ └───────────┘ └──────────┘           │
│ Workspaces                                                               │
│  browseport      82  20 arch  ████████████░░  2.2 GB   today             │
│  models          46  13 arch  ███░░░░░░░░░░░  193 MB   yesterday         │
│  Unassigned       7           ░░░░░░░░░░░░░░  3 MB                       │
│ Largest sessions (top 10)                                                │
│  Title or short id   workspace   size  events  last activity  [live][arch]│
└──────────────────────────────────────────────────────────────────────────┘
```

### Overview tab

- Five cards in one wrapping row: **Total** (stored, with live, archived, subagent children and unreadable counts), **On disk** (compressed bytes, with the search index load hint), **Archived** (size of archived roots, and how many children ride along), **Reclaimable** (size of units a prune can take now, blocked units counted apart, button *Review prune…*), **Largest** (one session).
- A workspace table: name and path, session count, archived count, size with a proportional bar, last activity. A row is a link that filters the Archived tab. Sessions in no workspace appear as an *Unassigned* row, grouped by their store folder name.
- A top-10 list of the largest sessions with badges *live*, *archived*, *child*.
- Sizes are on-disk bytes. The page says so. Raw size is never computed.
- The search index load hint is a heuristic: a warning tier when the on-disk size of the whole store reaches `indexWarnBytes`. Reason: the experimental session search builds an in-memory index of every stored session, and the host heap ceiling is about 4 GiB.

### Archived tab

- Rows are the top-most archived sessions, called roots. Children are not listed separately: each root row shows its child count and the combined size.
- Toolbar: workspace, older than N days, larger than N MB, text (id, title, workspace). Filters and sort are applied by the Host, never over a full list in the client.
- Rows are grouped by workspace. Columns: checkbox, title or short id, size (with children), last activity, age, a *blocked* badge whose text lists the reasons.
- Row actions: **Unarchive** (the host's own unarchive; the session returns to the normal list) and **Prune…**.
- A selection bar appears with a selection: *Unarchive selected*, *Prune selected…*.
- The sidebar already has Archive and Restore for single sessions. The label here is *Unarchive* so it is never confused with *Restore batch* in Trash.

### Prune panel

Opened from an Archived row or selection, or from the Reclaimable card. A three-step flow on a plan. Nothing moves before the last step.

1. **Scope**: all archived (default), archived older than N days, or the current selection.
2. **Preview** (a dry run, from the Host): roots, descendants, total size, a per-workspace breakdown, and the safety checks grouped by reason with counts. Blocked units are listed as excluded with their reasons.
3. **Confirm**: tick a box and type the number of sessions in the plan, then press **Move to trash**. The button says *trash*, never *delete*.

The result card shows moved and skipped counts, the trash location, warnings, and **Undo** (restores this batch).

### Trash tab

A list of prune batches: time, sessions, size, state (*complete*, *needs recovery*, *conflict*). Actions: **Restore batch**, **Delete permanently…**. Permanent delete needs the batch id typed and a second confirmation, and is disabled when `allowPermanentDelete` is false.

## Safety rules

- **The unit is a whole tree.** A unit is the top-most archived root plus every descendant (`parentSession` link). One refusal on any member blocks the whole unit, so a kept session never points at a pruned one.
- **Refusal codes:** `live`, `locked`, `recent`, `kept-descendant`, `parent-kept`, `cycle`, `path-unsafe`, `no-location`, `changed`, `not-archived`, `cross-device`, `workspace-missing`, `conflict`.
- **Plan token:** `apply` takes only a plan id issued by the Host and the typed count, never session ids. It re-reads every fact and skips what changed. There is no force option.
- **Order:** the manifest is written first and synced, then each session folder is renamed into the trash (rename only; a different device is refused, there is no copy), then the registry steps. A crash at any point is recovered by `recover()`, which never deletes.
- **User-only:** apply, unarchive, restore and purge refuse any agent caller. The plugin registers no tool and no slash command.
- **No log reads:** the dashboard uses headers and file metadata only. It never opens a session body and never calls session search.
- **Audit:** an append-only log in the plugin data directory records every plan, move, restore and purge with ids, counts and reasons, and never titles or message text.
- **Reversible:** restore moves folders back and never overwrites an existing destination.

## Decisions

The planner's open questions, answered by the lead on the user's behalf. The user can reverse any of them.

| # | Decision |
|---|---|
| D1 | Names: Remote and locale namespace `sessionsManager`, patch row id `sessions-manager`, data folder `<DSH home>/sessions-manager`. The page title stays *Sessions*. `sessions` is the host's live-session service key and is never used. |
| D2 | Registry policy is `at-prune` (spike T3, docs/store-safety.md): the registry steps run at prune. The host has an official re-attach call, `Workspace.attachSession`. Leaving the ids in place is not safe: after a restart the host's next change to that workspace drops a missing id for good, and a later restore would land the session under Ungrouped. |
| D3 | The prune unit is the whole tree, all or nothing. |
| D4 | A descendant that is a registered, non-archived top-level session (a user fork) blocks its unit with `kept-descendant`. |
| D5 | Prune order: manifest, move, then unpin, detach, unarchive. Move first. Restore order: move back, verify the log is back (same size and revision file part), `attachSession`, `insertSessionBefore` (attach puts the session first, so this restores its old position), archive, then pin only members that were pinned and are not archived (the host refuses to pin an archived session). The plugin checks membership after `attachSession`, because it can resolve without attaching. Only the restore call itself is strict about the log check: a log that changed in the trash is moved back, gets none of the registry steps, and the call returns `needs-recovery`. A later recovery or a fresh Trash read (the page makes one by itself right after every change) accepts the log and finishes those registry steps (a step that keeps failing: D20). The folder is back in the store either way, and the log is never altered. |
| D6 | `session.lock` is an empty kernel-lock target with no pid and no expiry; every session ever written has one, so its presence means nothing. The plugin never replaces or removes it. A session counts as `locked` only when a lock probe finds it held (macOS: open with `O_EXLOCK\|O_NONBLOCK`); the plugin holds that lock across the rename so no host can open the session for writing meanwhile. Mutations are serialized by the plugin's own `<trashDir>/.lock`, which records pid and start time; a stale one (dead pid) is replaced automatically and journaled. Two hosts on one store: session writes are safe, but `workspace.json` is last-writer-wins per process, so prune and restore run with one host. |
| D7 | Tabs are Overview, Archived, Trash. The prune flow is a panel, not a tab. |
| D8 | *Unarchive* on an Archived row, *Restore batch* in Trash. |
| D9 | Typed session count for the reversible move to trash. Typed batch id plus a second confirmation for permanent delete. |
| D10 | Config: one `dataDir` (default under the DSH home) with `audit.jsonl` and `trash/`. An optional `trashDir` must be on the same device as the store and outside the sessions tree. Also `recentActivityMinutes` 30, `listLimit` 500, `largeSessionBytes` 50 MB, `indexWarnBytes` 256 MiB on disk, `allowPermanentDelete` true, `refreshMs` 0, `planTtlMinutes` 10, `snapshotTtlMs` 15000. |
| D11 | Sessions in no workspace are shown as *Unassigned* and are not pruned in v1. |
| D12 | The plugin never touches the projection cache folder or the search index. The spike found no eviction call. The search index drops unlisted sessions at its next search. Projection-cache rows stay as unserved orphans. The README says so. |
| D13 | Titles never come from a log read. If the spike finds no cheap source, rows show the short id, workspace and creation date. |
| D14 | For current-format logs the backend never serves a moved session (it re-finds the folder on every open, stat and read), so no restart is needed. A *restart recommended* warning is returned only when a moved session is in an old format (open read handle) or a second host is in use. Sessions with `formatStatus: 'migration-required'` are refused in v1 (their revision changes with any change in the store). |
| D15 | Fallback placement if no slot gives a content area of 720 px or more: a Settings section with a single-column layout. |
| D16 | No audit rotation in v1. |
| D17 | The first live run happens on a copied profile and store; then the real store. |
| D18 | Prune is available only where the lock probe works (macOS). On Linux and Windows the dashboard is read-only: `capabilities.prune` is false with reason `sessions-manager/unsupported-platform`. |
| D19 | A restore puts a session back only into its exact recorded folder. If the destination exists, even as an empty folder, the unit is `conflict` (a rename onto an existing empty folder would silently replace it). Project directories are never moved or removed (a missing one makes the host's session listing fail for the whole store). |
| D20 | Crash recovery runs once when the plugin starts (or, if the host services are not ready yet, at the first page call after they are, and it is retried until it has really run once) and when a fresh Trash read finds steps still owed. It only finishes interrupted work (moves back toward the store, registry steps); it never prunes, restores on its own or deletes. At start it runs only when the trash holds a batch folder that is not closed (`isClosedBatchFolder` in `src/trash.js`: an lstat of the folder and one read of its journal's end, with no store read and no trash lock; a folder that is a symbolic link or cannot be read counts as not closed; `.staging-*` and `.purge-*` folders alone do not start it), so a trash of closed batches only costs a start a few file calls per batch. The recovery at start and the one of a fresh Trash read are automatic: they do not attempt again a registry step that failed `AUTO_RETRY_FAILURES` (3) times in a row for one session in one batch (failed journal lines of that step since its last line that did not fail, written by any path). The batch stays *needs recovery*, a Host log line names the batch and the step when an automatic recovery next reaches them (at the next Host start, since a fresh read starts no recovery for such steps alone). The recovery that every prune, restore and permanent delete runs first (and `recover()` called in process) is explicit: it attempts every owed step each time, without a cap, so the user is never locked out; **Restore batch** on the batch completes and closes it once the registry answers. The audit `recover` line counts only steps that ran and did not fail, so failed attempts add no audit line, and an automatic recovery with only held steps appends nothing. A start that finds the host services missing does nothing, and a later call tries again; a run that did start is not repeated, even when it failed. A call waits for the recovery at start at most 5 s after it began; then the call goes ahead, one line is logged, and a change gets `busy` until the recovery ends. A batch that is wholly back in the store with no step owed gets a `closed` journal line and is skipped afterwards, so recovery cost does not grow with the number of old batches. Restore puts a batch's ids back in their recorded relative order in the archived and pinned lists, but the registry cannot place an id at a given position, so they come back as the most recently archived and pinned. |

## Not in v1

Scheduled or automatic pruning, agent tools, slash commands, pruning of non-archived or unassigned sessions, partial subtrees, cross-device trash, raw-size computation, search or reindex integration, live follow-stream updates, trash auto-expiry, a force override.

Candidate for a later version: a *search readiness* check that finds sessions the experimental session search cannot read. A single stored session with an event type this build does not know fails every search. Finding it needs a full read of each session, so it must be a user-started, one-at-a-time action with a size limit.
