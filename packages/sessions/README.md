# dsh-plugin-sessions

An owner-only **Sessions** page for DeepSeek Harness: what the session store
holds, which archived sessions take the room, and a reversible prune that moves
archived sessions into a trash folder.

## What it is

DSH has no session delete. Archiving only hides a session: its log stays on
disk. This plugin adds one page that

- shows the size of the store, per workspace and for the largest sessions;
- lists archived sessions (the top-most archived session of a tree, with its
  subagent children) and lets you unarchive them;
- moves archived trees into a **trash folder** after a preview and a typed
  confirmation, undoes that move, and deletes a trash batch for good only on a
  separate typed action.

The page is for the owner of the machine. The plugin registers no agent tool
and no slash command, and it never prunes, restores or deletes on its own: no
schedule, no automatic prune, no expiry. Only recovery runs without a click:
when the Host starts and whenever the page reads the Trash tab afresh (**Refresh**,
the timed refresh, and the read the page makes by itself after every change), it can finish an
interrupted operation (move folders back toward the store, run registry steps
still owed), never more (see [Recovery](#recovery)). It never opens a session
log body and never calls session search. A session title comes from the host's projection cache (no log read);
without one, a row shows the short session id.

The unit of a prune is a **whole tree**: the top-most archived session plus
every stored descendant (`parentSession` link), all or nothing. One refusal on
any member keeps the whole tree in place.

Prune is available only on **macOS**, where a session lock can be probed. On
Linux and Windows the page is read-only (see [Limits](#limits-you-should-know)).

## Use

Open the page from the left sidebar: the **Sessions** row (Chinese: **会话管理**)
sits under **New Session** next to **Plugins** and **Automation tasks**. In a
collapsed rail, use its icon; in a window under 768 px, open the drawer first.
On macOS Desktop with the sidebar hidden, press Mod+B. Opening a session, **New
Session** or another panel leaves the page; coming back reads the Host again.

The header shows the store folder, **Prune available** or **Read-only**, the
time of the last read and **Refresh**. Three tabs follow.

**Overview**

- Five cards: **Total** (stored sessions, with live, archived, subagent
  children and unreadable counts), **On disk** (with the *Search index load*
  hint, **Normal** or **High**), **Archived** (size of archived roots and how
  many children ride along), **Reclaimable** (size of the trees a prune can
  take right now, blocked trees counted apart, button **Review prune…**) and
  **Largest**. The counts are of stored sessions. When the registry also marks
  ids archived whose log is gone, a small line under **Archived** says how
  many: that is why the sidebar's registry can hold more archived ids than the
  page counts. Such ids are harmless leftovers.
- A workspace table: sessions, archived count, size with a bar, last activity.
  A row opens the Archived tab filtered to that workspace. Sessions in no
  workspace appear as **Unassigned** rows, grouped by their store folder name.
- The ten largest sessions, with the badges *live*, *archived* and *child*.

**Archived**

- Rows are archived roots; children are not listed on their own. A row shows
  the combined size with children, last activity, age and a *blocked* badge
  that names the refusal.
- Filters, applied by the Host: workspace, older than N days, larger than N MB,
  and text (session id, title or workspace name, at most 200 characters). Sort
  by size (default, largest first), last activity (newest first) or title (A to
  Z). Rows are grouped by workspace.
- **Unarchive** (the host's own call) returns sessions to the normal list. A
  single row acts at once; a selection of more than one asks for a
  confirmation first. It still works when the page is read-only.
- **Prune…** and **Prune selected…** open the prune panel. An *orphan* row is a
  tree whose archived parent has no stored log: it can be pruned as its own
  unit, but not unarchived.

**Prune panel** (an in-page dialog; nothing moves before the last step)

1. **Scope**: all archived sessions, archived sessions older than N days, or
   the current selection.
2. **Preview**: a dry run from the Host. Roots, descendants, total size, a
   per-workspace breakdown and the safety checks. Blocked trees are listed as
   excluded, with their reasons.
3. **Confirm**: tick the box and type the number of sessions in the plan, then
   press **Move to trash**. The button says *trash*, never *delete*. The result
   card shows moved and skipped counts, the batch id, the trash folder,
   warnings and **Undo**.

**Trash** lists prune batches (time, sessions, size, state *complete*, *needs
recovery* or *conflict*) with **Restore batch** (it runs on one click, with no
confirmation) and **Delete permanently…**. A batch whose folders are where they
belong but whose registry steps are not all done (a refused detach after a
prune, a refused attach after a restore) reads *needs recovery* and stays
listed, even when it holds no session any more, until recovery has done them. Permanent delete needs the batch id
typed, then a second confirmation, and is disabled when `allowPermanentDelete`
is `false`.

Keyboard: ArrowLeft, ArrowRight, Home and End move between tabs. A dialog moves
focus to **Cancel** on open, keeps Tab inside, closes on Escape (not while a
call is running) and returns focus to the control that opened it; the page
behind it is inert. The page uses theme tokens only, follows the language set
in **Settings → General → Language** (English and Chinese), and wraps to one
column below 720 px of content width.

## Install

The package is not published on npm yet, so install it from a source checkout
by its folder path.

### Desktop app

1. Open **Settings → Plugins → Add plugin**.
2. Choose the option that installs a local folder and select
   `packages/sessions` of this repository.
3. Enable the plugin, **restart the Host**, then **refresh the page**.

If the dialog only accepts a package name, use the command line below on the
profile the app uses.

### Web or another CLI profile

```sh
dsh plugin --profile web add "$PWD/packages/sessions"
```

Replace `web` with your profile name when needed. Restart `dsh web` and refresh
the page after installation.

A change to a Host file (`src/index.host.js`, `service.js`, `trash.js`, …)
needs a Host restart; a change to `src/client.js` needs only a page refresh.

The bundle patch inserts one row, `sessions-manager`, with the defaults below.
The plugin declares no Settings form, so to change an option, override the row
in `<DSH home>/profiles/<profile>/cordis.patch.yml`, in the same form as the
usage package:

```yaml
- id: include:sessions-manager
  name: dsh-plugin-sessions
  config:
    allowPermanentDelete: false
```

**Config is replaced as a whole.** Restate every option you want to keep; an
option you leave out takes its default. A home-level `<DSH home>/cordis.patch.yml`
applies after the profile patch.

## Configuration

| Field | Default | Range | Meaning |
|---|---|---|---|
| `dataDir` | `<DSH home>/sessions-manager` | absolute path | Plugin-owned folder: `audit.jsonl` and, by default, `trash/`. Must lie outside the sessions tree. |
| `trashDir` | `<dataDir>/trash` | absolute path | Optional. Must be on the **same device** as the sessions tree, outside it, with no symlinked component; an existing folder must be yours and not writable by group or others. |
| `recentActivityMinutes` | `30` | 1 to 10080 (one week) | A tree with a member whose log changed within this many minutes is not pruned (`recent`). Never 0. |
| `listLimit` | `500` | 10 to 5000 | Most rows one Archived request returns. A narrower filter shows the rest. |
| `largeSessionBytes` | `52428800` (50 MB) | 1 MiB to 1 TiB | Reserved. Accepted and clamped, but nothing in v1 reads it. |
| `indexWarnBytes` | `268435456` (256 MiB) | 1 MiB to 1 TiB | On-disk size of the whole store at which the *Search index load* hint turns **High**. A heuristic, see [Limits](#limits-you-should-know). |
| `allowPermanentDelete` | `true` | `true` or `false` | `false` turns **Delete permanently…** off. Any other value is an invalid config. |
| `refreshMs` | `0` | `0` (off), or 5000 to 3600000 | Refresh interval of the page while it is visible. A value from 1 to 4999 becomes 5000. |
| `planTtlMinutes` | `10` | 1 to 60 | How long a prune plan stays valid. At most five plans are kept in memory, and a Host restart drops them. |
| `snapshotTtlMs` | `15000` | 0 to 120000 | How long one read of the store is reused. **Refresh** and every change bypass it. |

Numbers are rounded and clamped into their range; a missing or non-numeric
value gives the default. Paths are checked as strings when the plugin loads:
absolute (no `~`), normalized, no `..`, not a filesystem root, no control,
line-separator, bidirectional-control or backtick characters, no surrounding
whitespace; on Windows a drive or UNC share. An invalid path never falls back
to a default. An invalid config (or an unset `dataDir` with no DSH home) does
not stop the Host: the plugin logs `sessions-manager: invalid plugin config: …`
and runs read-only with reason `sessions-manager/trash-unusable`.

## Data directory and trash layout

Everything the plugin writes is in `dataDir` (folders mode 0700, files 0600).
Nothing is created until the first Preview, prune or Unarchive (on macOS an
Unarchive takes the trash lock, which creates `trash/`). The sessions themselves are
never copied: a prune renames session folders, so the trash must be on the same
device as the store.

```text
<dataDir>/
  audit.jsonl                  append-only audit log
  trash/                       <trashDir>
    .lock                      cross-process mutex (pid, process start, host, token)
    .lock.released             the last released lock
    .journal.jsonl             trash-level journal (stale lock replacements)
    .staging-<batchId>/        a batch being created (holds no session)
    .purge-<batchId>/          a batch being deleted for good
    <batchId>/                 e.g. b-20261117T221150Z-1a2b3c4d
      manifest.json            the full intent, written and synced before the first move
      journal.jsonl            one line per state change; the batch state is a fold of it
                               (also each moved log's revision and size, and `closed`)
      registry.json            position, neighbours, archive and pin order, log name,
                               revision and size of each member
      sessions/<project folder>/<session id>/…    the moved session folders
```

`manifest.json` records, for each session, its id, project folder, workspace,
parent, archived and pinned marks, size and exact source path. A restore goes
only to that recorded folder. Project folders and the sessions tree are never
moved or removed. A batch wholly back in the store with every registry step
done is **closed**: its journal ends with a `closed` line, the Trash tab hides
it, and recovery skips it after reading only the end of that journal (a fixed
four file calls per closed batch, whatever it held). Its small manifest, hints
and journal stay in the folder; only **Delete permanently…** (by batch id)
removes a batch.

## Safety rules

- **Whole trees, all or nothing.** One refusal on any member blocks the tree.
- **Plan token.** `apply` takes only a plan id issued by the Host and the typed
  count, never session ids. It re-reads every fact and skips what changed. There
  is no force option.
- **Order.** Manifest and registry hints are written first and synced; then each
  session folder is renamed into the trash (rename only, never a copy); then
  the registry steps run: unpin, detach from the workspace, unarchive.
- **One at a time.** A second change while one runs gets `busy`; the trash
  `.lock` also excludes a second process, and Unarchive takes the same lock. A stale lock (dead pid, reused pid,
  or an unreadable one older than 60 s) is replaced and journaled.
- **User-only.** Every method refuses an agent caller.
- **Audit first.** The `apply-start` line must be written before anything moves.
- **Never touched:** `session.lock`, the workspace registry file, the
  projection-cache folder, the search database, project folders.

Refusal codes (a refusal is data on a row or in a result, not an error):

| Code | Meaning |
|---|---|
| `live` | A member is held by the host's live-session service. Checked again just before each rename. |
| `locked` | A member's `session.lock` is held, a `*.tmp` publish is in flight in its folder, or the lock cannot be probed. |
| `recent` | A member's log changed within `recentActivityMinutes` (a future time counts). |
| `kept-descendant` | A member is not archived and is a kept top-level session (a user fork), not a subagent child. |
| `parent-kept` | A member's parent exists in the store outside the tree. |
| `cycle` | The `parentSession` links form a loop. |
| `path-unsafe` | A duplicate id, a symbolic link, a folder not named like the session id, a path outside the store, or a failed folder or owner check. |
| `no-location` | The session has no folder or log on disk. |
| `changed` | A fact differs between plan and apply (membership, size, revision, log time), or a rename failed unexpectedly. |
| `not-archived` | The session is not (or no longer) archived. |
| `cross-device` | The folder and the trash are on different devices; there is no copy fallback. |
| `workspace-missing` | The tree is in no workspace (*Unassigned* sessions are not pruned), or on restore its workspace is gone. |
| `conflict` | The destination exists, even as an empty folder or a lock-only leftover; nothing is overwritten. |
| `legacy-format` | A member's log is in an old format (`migration-required`); such sessions are refused in v1. |

Error codes (these fail the call): `sessions-manager/forbidden` (an agent
called), `busy`, `plan-expired` (unknown, expired, already used or dropped
plan), `confirmation-mismatch` (typed count or batch id), `purge-disabled`,
`unsupported-backend` (the persistence, live-session or registry service is
missing, or the backend gives no JSONL folders; an empty store whose trash
holds no batch reads the same), `unsupported-platform` (no
lock probe), `trash-unusable` (invalid config, audit log or trash folder not
usable, overlap with the store, another device), `batch-not-found`,
`invalid-request` and `store-unreadable` (the backend's session listing failed,
for example because a project folder vanished while it ran; nothing was moved,
try again). `unsupported-backend`, `unsupported-platform` and
`trash-unusable` are also the three reasons the page can be read-only.

Warnings in a result: `stale-backend-entry` (the backend still lists a moved
session; that tree's registry steps wait), `registry-step-failed`,
`audit-failed`, `restart-recommended` and `recovery-needed`.

## Limits you should know

- **Sizes are on-disk bytes.** They add up the allocated blocks of every file
  in a session folder, as `du` counts, up to three levels down. Logs are stored
  compressed, so these are compressed sizes. Raw size is never computed.
  Reclaimable counts the same bytes.
- **The index-load hint is a heuristic.** The host's experimental session search
  builds an in-memory index of every stored session, and the host heap ceiling
  is about 4 GiB. **High** only says that the store's on-disk size reached
  `indexWarnBytes`. It does not read or measure the search index. A single
  stored session with an event type this build does not know can make every
  search fail (`session history storage is unavailable`); the page does not
  look for it and cannot fix it. Move that session's folder out of the store by
  hand; it is usually a session that belongs to no workspace and is not
  archived, which v1 does not prune.
- **Prune is available only on macOS.** It needs the session lock probe:
  `session.lock` is the target of the backend's kernel lock, an empty file that
  exists for every session ever written, so only an open with `O_EXLOCK |
  O_NONBLOCK` tells held from free. The plugin holds that lock across the
  rename. On Linux and Windows no probe exists: `capabilities.prune` is false
  with reason `sessions-manager/unsupported-platform` and the page is read-only
  (Overview, Archived and Unarchive work; plan, apply, restore and purge do not).
- **Two hosts on one store are not supported for prune and restore.** Kernel
  locks keep session writes safe, but each host holds the workspace registry in
  memory over one `workspace.json` file, last writer wins: the other host's next
  write can bring back ids the plugin unpinned, detached or unarchived (they
  become ghosts that the host hides again after its restart). A second host can
  also recreate an empty session folder in the instant of a rename; a restore
  reports that as `conflict` and never deletes it. Run prune and restore with one
  Host. The same goes for **Refresh** on the Trash tab and for the start of a
  Host: both can run recovery, and its registry steps are written from that
  host's in-memory view of the registry, which a second host can have made
  stale.
- **A batch whose owed steps cannot finish stays *needs recovery*.** This
  happens when the backend still lists a moved session (`stale-backend-entry`;
  that tree's registry steps wait, and the result recommends a restart), or
  when a session of a restored batch whose registry steps were still owed was
  pruned again into a newer batch (its log is not at the recorded folder, so
  the older batch cannot finish until that session is back). Such a batch stays
  listed as *needs recovery*, and every **Refresh** of the Trash tab runs a
  recovery for it again; while that recovery runs, a change you start gets
  `busy`. Try it again a moment later.
- **Search and caches after a prune.** The plugin calls neither. The search
  index reconciles with the session list before each search, so a pruned
  session drops out of search at the **next search** (not at restart) and is
  indexed again at the next search after a restore. A prune that overlaps a
  search can make that search fail once; repeat it. Rows of the projection
  cache (the title cache) have no evict call: a moved session's row is never
  served while it is in the trash and matches again after a restore. After a
  permanent delete the row stays as an orphan document in the host's storages
  folder: disk space only, and nothing deletes it.
- **A moved session is gone at once** for sessions in the current format: the
  backend finds the folder again on every open, so no restart is needed. A
  *restart recommended* warning appears only if the backend still lists a moved
  session, or a second host is in use. A session in an **old format** (a log that
  needs a migration) is **refused** (`legacy-format`) and its tree stays: its
  revision changes with any change in the store, so a before-and-after check
  would be wrong.
- **Restore under the `at-prune` registry policy.** The registry is updated at
  prune time: unpin, detach (from the recorded workspace), unarchive. Leaving
  the ids in place is not safe: after a host restart its next workspace change
  drops a missing id for good, and a later restore would land the session under
  *Ungrouped*. A restore moves the folder back to the exact recorded folder
  (never over an existing one), checks that the log is back (same folder, and
  the size and revision the log had when it was moved: they are journaled
  right after the move, so a log that changed after the last check but before
  its move still restores), re-attaches the session to its workspace, puts it
  back before its recorded neighbour, archives it again if it was archived, and
  pins it again only if it was pinned and is not archived. A tree whose
  workspace no longer exists stays in the trash (`workspace-missing`); a
  missing project folder is recreated (mode 0700) when the manifest recorded
  it.
- **A log that changed while in the trash.** Only the restore call itself is
  strict about it: it moves the folder back but runs none of that session's
  registry steps, and its result is *needs recovery* (`recovery-needed`). The
  next recovery accepts the log, since the session may be in use by then, and
  finishes the registry steps: attach, order, archive, pin. That is a Host
  start, the next prune, restore or permanent delete, or any fresh read of the
  Trash tab; the page makes one by itself right after every change, so in
  practice the steps finish within moments of the restore. The
  folder is back in the store either way, and the log is never altered.
- **Archive and pin order after a restore.** The workspace order comes back
  exactly. Of the registry's archive and pin lists, a restore gives back the
  batch's own ids in their recorded relative order (it archives them in that
  order and pins them in reverse order), but it cannot put them back at their
  old places among ids outside the batch: `archiveSession` appends and
  `pinSession` prepends, and the registry has no call that puts an id at a
  place. So restored ids come back as the most recently archived (end of the
  archive list) and the most recently pinned (start of the pin list). Moving
  other sessions to make room would take registry calls on sessions outside the
  batch, which the plugin never makes. When the batch's ids were the newest
  archived and the newest pinned, the exact order comes back.
- **Findings come from the rc.4 sources, run on macOS (APFS)**; the installed
  rc.3 was read, not run. The page itself was not driven in a browser by the
  spike. How long an already open sidebar keeps a row after a prune is untested.

## Recovery

- **Undo or Restore batch.** Use **Undo** on the result card, or **Restore
  batch** in the Trash tab. Both are the same action. Check the result: a
  skipped tree stays whole in the trash with its reason. `conflict`: something
  now exists at the recorded folder; move it away yourself, then restore again.
  A batch in conflict still holds its own copy of that session, and the Trash
  tab counts it: **Delete permanently…** on that batch deletes that copy too.
  `workspace-missing`: recreate or re-add the workspace, then restore again.
  If the workspace goes away during the restore itself (after the restore's
  check and before the attach), the folders are back in the store all the
  same: the attach is journaled as skipped, the result says *needs recovery*
  with `registry-step-failed`, the session is in no workspace (the sidebar calls that *Ungrouped*, and an
  archived one stays archived), and the batch is closed, so there is nothing left to restore. Add the session to a
  workspace again in the app.
- **A store with no session left.** When the store lists no session at all, the
  Host takes the sessions tree from the newest trash batch, so the page is not
  read-only and **Restore batch** works.
- **An interrupted action.** After a crash, a batch shows *needs recovery* (or
  *conflict*). Recovery runs once when the Host starts the plugin, at the start
  of every prune, restore or permanent delete, and when **Refresh** reads the
  Trash tab while a batch still owes registry steps (a plain read only reports
  them). At start it runs when the trash holds any batch folder, closed ones
  included: every such start reads the store once and takes the trash lock. A
  failure at start is only logged; while the host services it needs are not
  there yet, the next page call starts it. It runs under the trash lock. Every
  page call waits for the one at start, at most 5 seconds: after that the call
  goes ahead, the Host logs that recovery at start is still running, and a
  change gets `busy` until it ends. It compares the manifest with the disk,
  appends the missing journal lines, finishes registry steps a crash left undone
  and renames a tree that is split between store and trash back whole into the
  store. **Recovery never deletes and never moves toward the trash.** Folders
  named `.staging-*` hold no session; the plugin reports and never deletes them.
  A `.purge-<batchId>` folder is a delete that stopped: run **Delete
  permanently…** on that batch again to finish it.
- **Last resort, with the Host stopped.** `manifest.json` lists each session's
  `source` path. You can `mv` a folder from `<batchId>/sessions/<project>/<id>`
  back to its `source` only if the destination does not exist. Leave the
  registry alone: the batch folder is still there, so the next recovery (at the
  next Host start) finds the folder back, moves the rest of a partly moved tree
  back too, re-attaches those sessions to their workspace, archives again the
  ones that were archived and pins again the ones that were pinned, as a
  restore would. Prefer the page.
- **Stop using the plugin.** Disable it in **Settings → Plugins**. The trash and
  the audit log stay where they are.

## Audit log format

`<dataDir>/audit.jsonl`: one JSON object per line, one append per line, mode
0600, `O_NOFOLLOW`. The folder and an existing file must belong to you and must
not be writable by group or others. There is no rotation in v1. A line is a
trace, never a source of truth.

```json
{"v":1,"ts":"2026-11-17T22:15:03.114Z","op":"apply-end","planId":"p-0f3a9c1e5b7d2a4c68","batchId":"b-20261117T221503Z-1a2b3c4d","counts":{"units":3,"sessions":9,"skipped":0},"bytes":123456789,"outcome":"complete","hostPid":4242}
```

Only these fields exist, and any other key is dropped: `v` (1), `ts` (ISO time),
`op`, `planId`, `batchId`, `digest`, `counts` (small integers), `bytes`,
`sessions` (`id`, `workspaceId`, `parent`, `archived`, `pinned`, `bytes`),
`reasons` (`code`, `sessionId`), `outcome`, `errorCode`, `hostPid`,
`pluginVersion` and `principal` (the Host passes neither of these two today).
Every string is a short token without spaces, so **no title, prompt or message
text is ever recorded**. A line over 4 MiB is refused, not cut.

| `op` | Written | Carries |
|---|---|---|
| `plan` | each Preview | `planId`, `digest`, `counts` (units, ready, blocked, sessions, readySessions), `bytes` |
| `apply-start` | before anything moves; **fails closed** | `planId`, `digest`, `counts` |
| `unit-moved` | after each moved tree | `batchId`, `planId`, `sessions[]`, `bytes` |
| `unit-skipped` | a tree refused at its rename step (trees the re-read skips are only counted in `apply-end`) | `batchId`, `planId`, `reasons[]` |
| `registry-step` | after each tree's registry steps | `batchId`, `counts` (steps, failed), `outcome` |
| `apply-end` | the end of a prune | `planId`, `batchId`, `counts`, `bytes`, `outcome` |
| `recover` | when a recovery changed something | `counts` (batches, appended, moved, steps) |
| `restore-start`, `restore-end` | a restore | `batchId`, and `counts`, `bytes`, `outcome` at the end |
| `purge-start`, `purge-end`, `purge-failed` | a permanent delete | `batchId`, and `counts`, `bytes`, `outcome` or `errorCode` |

If the `apply-start` line cannot be written, nothing moves and the call fails
with `trash-unusable`. Any later write failure returns an `audit-failed`
warning and never stops the work. Unarchive is the host's own call and writes
no line. `outcome` is `complete`, `partial`, `needs-recovery` or `conflict`
(or `ok`, or `failed` for a registry step).

## Not in v1

- Scheduled or automatic pruning
- Agent tools
- Slash commands
- Pruning of non-archived or unassigned sessions
- Partial subtrees
- Cross-device trash
- Raw-size computation
- Search or reindex integration
- Live follow-stream updates
- Trash auto-expiry
- A force override

## Tests

```sh
node --test packages/sessions/test/*.test.mjs
```

The store-safety experiments run only against an upstream source checkout:

```sh
DSH_UPSTREAM_DIR=/path/to/deepseek-harness node --test packages/sessions/test/upstream-persistence.test.mjs
```

Without `DSH_UPSTREAM_DIR` that suite is skipped. Tests use temporary folders
under the system temp directory and never read the real DSH home. The package
tests only run simulated browsers: follow
[`docs/sessions-checklist.md`](../../docs/sessions-checklist.md) by hand in the
real GUI. The design record is in `packages/sessions/docs` (`design.md`,
`store-safety.md`, `placement.md`, `remote-contract.md`).

## License

MIT
