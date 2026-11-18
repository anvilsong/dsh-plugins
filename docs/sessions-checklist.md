# Sessions page checklist (`packages/sessions`)

Follow this by hand in the real GUI after each change to `packages/sessions`.
The package tests only run simulated browsers. Every check below comes from
`packages/sessions/README.md`; where it does not settle a point, the step says
which section to read first.

Order matters (design decision D17). Run scenarios 1 to 14 on a **copied
profile and a copied store**. Only after they pass, run scenario 15 on the real
store, with one small batch and no permanent delete.

## Prerequisites

- Page file (`packages/sessions/src/client.js`): refresh the page. No restart.
- Host file (`src/index.host.js`, `service.js`, `host-adapter.js`, `trash.js`,
  `audit.js`, `config.js`, `lineage.js`, `store-index.js`, `paths.js`,
  `contract.js`): restart the Host (`dsh web`, or the Desktop app), then refresh.
  If you are not sure which kind a changed file is, restart and refresh.
- Prune needs **macOS**. On Linux or Windows, run only the read-only parts of
  scenarios 1 to 4 and 11 to 14, and expect the header to say **Read-only**.
- Run **one Host** at a time while you prune or restore (README, "Limits you
  should know": two hosts on one store are not supported for prune).
- A Terminal, and DevTools open on the GUI origin (Console tab) to see errors.
- Data to have, in the **copy** (archive them in the sidebar before you copy, and
  wait at least `recentActivityMinutes`, 30 minutes by default, so they are not
  recent):
  - at least three archived sessions in one workspace, one of them with subagent
    children, and at least one archived session in a second workspace;
  - one session in each of those workspaces that is **not** archived;
  - optionally one session that is in no workspace (it shows as *Unassigned*).
- A "failure" below means: write it down in the table at the end, with what you
  saw instead. Do not retry until you have recorded it.

## Copy the profile and the store

Do this once. The copy is a full second DSH home that you run the Host on, so
nothing you do in scenarios 1 to 14 can touch the real store.

1. **Stop the Host** (quit the Desktop app, or stop `dsh web`) so nothing writes
   during the copy. Check that no DSH process is left, for example
   `pgrep -fil dsh || echo none`.
2. Set the source and a destination on the **same volume** with enough free space:

   ```sh
   SRC="${DSH_HOME:-$HOME/.dsh}"
   COPY="$HOME/dsh-copy-$(date +%Y%m%d)"
   test -d "$SRC" && test ! -e "$COPY" && echo "ok: $SRC -> $COPY"
   ```

3. Copy with timestamps preserved (`-p`). On APFS, `-c` makes a clone that uses
   no extra space until a file changes:

   ```sh
   cp -Rpc "$SRC" "$COPY"        # not APFS: rsync -a "$SRC"/ "$COPY"/
   ```

   Without `-p` every file would get today's time, and the `recent` rule would
   block every tree.
4. Verify: the file counts match, and the sizes are close.

   ```sh
   find "$SRC" -type f | wc -l; find "$COPY" -type f | wc -l
   du -sk "$SRC" "$COPY"
   ```

   Optional, slower: `diff -rq "$SRC" "$COPY"` prints nothing when they match.
5. The copy holds the same credentials and settings as the original. Treat it
   like the original and delete it when you are done.
6. Start the Host on the copy, in the way you normally start it, with the DSH
   home set to it: `DSH_HOME="$COPY" dsh web --profile <profile>` (Desktop app:
   start it from a shell that has `DSH_HOME` set). Use the same profile name.
   The real Host must stay stopped.
7. **Gate.** Open the page (scenario 2). The header's **Store** path must start
   with `$COPY`. If it does not, **stop here**: you are on the real store. Do
   not prune. Quit the Host and fix how it is started.

## Undo

- **Any prune on the copy or the real store:** **Undo** on the result card, or
  **Restore batch** in the Trash tab. See scenario 7, and README "Recovery" if a
  batch is *needs recovery* or *conflict*.
- **The whole copy:** after you have recorded your results, stop the Host and
  delete only the copy:

  ```sh
  : "${COPY:?}" ; echo "$COPY" ; test "$COPY" != "$HOME" && test "$COPY" != "$SRC" && rm -rf -- "$COPY"
  ```

  Read the printed path first. Never run it with `COPY` unset or set to the real
  home.
- **Stop using the plugin:** disable it in **Settings → Plugins**. The trash and
  `audit.jsonl` stay where they are.

## 1. Install and restart

1. In the copy's GUI, open **Settings → Plugins → Add plugin → Install a
   third-party plugin**, enter `dsh-plugin-sessions` (or, from a checkout, run
   `dsh plugin --profile <profile> add "$PWD/packages/sessions"`), and enable it. (If the copy already carries the plugin, check that it is enabled.)
2. Restart the Host. Refresh the page.
3. Expect: a **Sessions** row in the left sidebar under **New Session**, after
   **Plugins** and **Automation tasks**. Click it: the center column shows
   *Connecting to the Host…*, then the Overview. The row shows as the current
   page. The Host log has no line `sessions-manager: the dashboard service did
   not start`.
4. Click a session, then **Sessions** again: the page mounts fresh and reads the
   Host again. Reload the browser tab: the GUI shows the Conversation; click
   **Sessions** to return.
5. Expect that `<COPY>/sessions-manager` does not exist yet (the Overview writes
   nothing; it appears at the first Preview, prune or Unarchive).

Failure means: no row, a page that stays on *Connecting…* or shows *Could not
connect the Sessions service*, a console error, or a folder created by the
Overview. Read the README section "Install" first.

## 2. First run on the copied store

1. Look at the header: the **Store** path, **Prune available**, the time of the
   last read and **Refresh**.
2. Check the gate: the path starts with `$COPY` (see "Copy the profile and the
   store", step 7).
3. Expect **Prune available** on macOS. On another system it says **Read-only**,
   with the reason in the notice.
4. Press **Refresh**: the time changes, no error. Leave the tab open for a minute:
   with `refreshMs` 0 nothing refreshes by itself.

Failure means: a Store path outside the copy (stop at once), **Read-only** on
macOS without a clear reason (read the notice, the Host log line
`sessions-manager: …`, and README "Configuration"), or an error banner.

## 3. Overview numbers against `du` and the folder count

Let `STORE` be the **Store** path from the header.

1. Folder count: `find "$STORE" -mindepth 2 -maxdepth 2 -type d | wc -l`.
   Expect it to equal **Total** (live, archived and subagent children are inside
   that number). A folder that holds only `session.lock` is not a session; write
   down any difference and why.
2. On disk: `du -sk "$STORE"`, in KB. Expect the **On disk** card to agree
   closely (both count allocated blocks; the card sums session folders only).
   Record both numbers and the gap. A gap above about 5 % is a failure to
   investigate.
3. The workspace sizes add up to about the **On disk** figure; **Unassigned**
   rows appear only for sessions in no workspace.
4. The page says all sizes are on-disk (compressed) bytes.
5. **Archived** shows the number of archived roots and the children included;
   the **Archived** tab count agrees with the roots.
6. The ready units of **Reclaimable** plus its blocked units equal the number of
   archived roots (a tree whose archived parent has no stored log, an *orphan*,
   counts as one unit too; write down such a difference).
7. **Search index load** reads **Normal**, with the hint that the warning tier
   starts at 256 MiB on disk (or **High** if the store is that big).

Failure means: a count or size that disagrees with the Terminal beyond the notes
above. Read the README sections "Use" and "Limits you should know" first.

## 4. Archived filters and sort

1. Open **Archived**. Rows are archived roots, grouped by workspace, largest
   first. Each shows size with children, last activity, age and, for a blocked
   tree, a *blocked* badge.
2. Filter by **Workspace**, then clear it. From **Overview**, click a workspace
   row: the Archived tab opens filtered to it, with a chip you can remove.
3. **Older than (days)** with `0`, then a larger number; **Larger than (MB)**;
   a letter in a number field shows *Enter a number of 0 or more* and that filter
   is not applied. **Search** by part of an id, a title and a workspace name.
4. Sort by size, last activity and title with the column headers. Expect largest
   first, newest first, A to Z. **Clear filters** resets.
5. Unarchive one row of the copy: the row leaves the list and the session is in
   the sidebar's normal list. Archive it again in the sidebar. Select two rows and
   press **Unarchive selected**: an inline question appears; **Cancel** keeps
   them, and Escape cancels too.

Failure means: a filter or sort that the page applies in the browser instead of
the Host (the list flickers to a wrong order), a count that ignores the filters,
or an unarchive that leaves the session archived. Read "Use", Archived.

## 5. A preview that shows a refusal

1. In the sidebar, open an archived session (Archived filter), in **another
   browser tab** so it is live in the Host.
2. Back on the page, press **Refresh**. Its Archived row shows a *blocked*
   badge naming `live`.
3. Press **Prune…** on that row, or **Prune selected…**, scope **All archived
   sessions**, **Preview**. Expect the tree under **Excluded**, with the reason
   `live`, a line *Excluded as blocked*, and the other trees ready. Nothing moves.
4. Close the second tab or the session, **Refresh**, **Preview** again. The tree
   is ready again, unless the log changed within 30 minutes: then it shows
   `recent`, which is correct.
5. Optional: archive a session now and look at its row: `recent` for 30 minutes.

Failure means: a live tree in the ready set, a typed count that includes it, or a
preview that moves something. Read "Safety rules" first.

## 6. Move to trash, then the host sidebar

1. Before you start, write down the order of two workspaces in the sidebar and
   the sessions in their Archived filters.
2. Select two or three small archived trees, one with children. **Prune
   selected…**, scope **The current selection**, **Preview**, **Continue**.
3. Confirm: tick the box and type the number of sessions shown (roots plus
   descendants). A wrong number keeps **Move to trash** off. Press **Move to
   trash**.
4. Expect the result card: moved and skipped counts, a **Batch** id like
   `b-20261117T221503Z-1a2b3c4d`, the **Trash folder**, no warning, **Undo**.
5. Terminal: `ls "$COPY/sessions-manager/trash"` shows the batch;
   `ls "<trash folder>/<batch id>"` shows `manifest.json`, `journal.jsonl`,
   `registry.json` and `sessions/`. The session folders are under
   `sessions/<project folder>/<id>`, and gone from `$STORE`.
   `tail -n 20 "$COPY/sessions-manager/audit.jsonl"` shows `plan`, `apply-start`,
   one `unit-moved` and one `registry-step` per tree, and `apply-end` (ids,
   counts and codes only, no titles).
6. **Host sidebar:** the moved sessions are gone from the Archived filter and the
   normal list, and there is no *Ungrouped* group and no empty row. Reload the
   tab and look again. Note how long a stale row stays in an open page if one
   does (untested upstream).
7. Overview: **Total** and **On disk** went down; the Trash tab shows
   *Trash (1)*.
8. Optional: run one session search for a word that only a moved session
   holds. Expect no hit from it at the next search.

Failure means: a session that is still in the store folder, one that is in both
places, a ghost row in the sidebar after a reload, an *Ungrouped* group, a
warning on a clean run, or a console error. Read "Safety rules" and "Limits you
should know" first.

## 7. Undo

1. On the result card of scenario 6, press **Undo**.
2. Expect *Restored N to their folders*. The folders are back under `$STORE`;
   `ls` of the batch's `sessions/` is empty of them.
3. In the sidebar the sessions are back in their workspaces, **archived** (in the
   Archived filter, not the normal list), in their old positions. A pinned
   non-archived child would be pinned again.
4. The Trash tab no longer lists the batch (a fully restored batch is hidden).
   The audit log has `restore-start` and `restore-end`.

Failure means: a session missing from its workspace, under *Ungrouped*, in the
wrong position, or not archived again. Read "Limits", restore under `at-prune`.

## 8. Restore batch

1. Prune again (scenario 6, steps 2 to 4), then reload the browser tab so the
   result card is gone.
2. **Trash** tab: the batch is listed with time, sessions, size and state
   *complete*. Press **Restore batch**. It runs at once, with no question.
   Expect the same result as scenario 7.
3. Conflict: prune again. In Terminal, create an empty folder at one recorded
   destination (`mkdir "$STORE/<project folder>/<id>"`). **Restore batch**:
   the tree is skipped with `conflict`, nothing is overwritten, and the batch
   state reads *conflict*. Its session count still includes that session: its
   copy is in the batch folder, and **Delete permanently…** would delete it (do
   not press it here). Remove only that empty folder (`rmdir`), then **Restore
   batch** again: it succeeds.

Failure means: a restore that overwrites a folder, a batch that cannot be
restored after the conflict is cleared, a conflict batch that shows 0 sessions
while its folder still holds one, or sessions left half in the trash.
Read "Recovery" first.

## 9. Purge with typed confirmation

Only on the copy.

1. Prune a small tree. **Trash** → **Delete permanently…** on that batch.
2. Expect a dialog that asks you to type the batch id. Type it with one wrong
   character: you cannot continue. Type it exactly, press **Delete permanently**.
3. Expect a second dialog, *Last confirmation*, with the focus on **Cancel**.
   Press **Cancel** once and check nothing was deleted, then repeat and press
   **Yes, delete for good**.
4. Expect *Deleted batch … for good*, with sessions and size. The batch folder is
   gone from the trash folder; the audit log has `purge-start` and `purge-end`;
   `du -sk` of the trash dropped. **Restore batch** is no longer possible.

Failure means: a delete without both confirmations, a delete that leaves the
batch listed, or any session outside the batch removed. Read "Safety rules".

## 10. Purge disabled by config

1. Stop the Host. In the copy, add to
   `$COPY/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - id: include:sessions-manager
     name: dsh-plugin-sessions
     config:
       allowPermanentDelete: false
   ```

   (An override replaces the whole `config`; the unlisted options keep their
   defaults.) Start the Host on the copy again, refresh.
2. Prune a small tree. **Trash**: **Delete permanently…** is disabled, with the
   note that permanent delete is turned off and `allowPermanentDelete` is false.
   **Restore batch** still works.
3. Remove the override, restart, refresh: the button works again.

Failure means: a delete that still runs, or a Restore that is blocked. Read
"Configuration" first. If the Host reports a patch error for the override, note
its text and use **Settings → Plugins** instead.

## 11. zh locale

1. **Settings → General → Language**, choose Chinese. Go back to the page without
   a reload.
2. Expect: the sidebar row and title read **会话管理**; tabs **概览**, **已归档**,
   **回收站**; **移到回收站**, **撤销**, **恢复批次**, **永久删除…**; the dialogs
   and refusal texts too. No `{n}`-style placeholder shows. Ids and codes stay
   untranslated.
3. Open the prune dialog and the purge dialog in Chinese; the typed-count text
   and the final question read correctly.
4. Switch back to English.

Failure means: English left over in the page or dialogs, a visible placeholder,
or a page that needs a reload to change language.

## 12. Light and dark theme

1. With the page open, switch the GUI theme to light, then dark (Settings).
2. Check each tab, the blocked badge, the danger button (**Move to trash**,
   **Delete permanently**), the dialog mask and card, the focus ring and the
   size bars. Text stays readable, borders stay visible, and nothing keeps the
   old theme's colors.
3. The page follows the switch without a reload.

Failure means: unreadable text, an invisible border or focus ring, or a surface
with a fixed color.

## 13. Narrow width

1. Resize the window: 1280, then 1088 px (sidebar expanded: content 720 px),
   1000, 767 and about 480 px.
2. Expect the cards to wrap. Below 720 px of content the Archived rows stack into
   one column, with the checkbox and actions still reachable. Under 768 px open
   the drawer to reach **Sessions**; it closes on navigation.
3. The prune and purge dialogs scroll inside the window, and the typed field and
   buttons stay usable. No horizontal scroll bar on the page.

Failure means: clipped text or buttons, an unreachable action, or two vertical
scroll bars on the page.

## 14. Keyboard-only run of the whole flow

Put the mouse away. Run scenarios 4 to 9 once more on the copy with the keyboard.

1. Reach **Sessions** with Tab and activate it. Move across the tabs with
   ArrowLeft, ArrowRight, Home and End.
2. Tab to the filters, type into them, Tab to the rows, tick rows with Space,
   Tab to **Prune selected…**, press it.
3. In the dialog, focus starts on **Cancel**. Tab and Shift+Tab stay inside it.
   You cannot tab to the page behind it. Walk Scope, Preview, Confirm; tick the
   box, type the count, **Move to trash**.
4. Press Escape in a dialog: it closes and focus returns to the button that
   opened it. While **Move to trash** runs, Escape must not cancel it.
5. **Undo**, then prune again, open **Trash**, **Restore batch**; once more,
   **Delete permanently…**, type the id, confirm. Escape at the *Last
   confirmation* closes it or goes back, and deletes nothing.
6. Every control you used shows a visible focus ring.

Failure means: a control you cannot reach, focus lost to the page, a dialog that
does not trap focus or does not return it, or Escape that cancels a running move.
Read "Use", the keyboard paragraph, first.

## 15. The real store

Only after scenarios 1 to 14 pass. Keep the copy until this is done.

1. Stop the copy's Host. Start the Host in the usual way, on the real home.
   Install or enable the plugin if it is not (scenario 1). Open the page.
2. Read only first: scenarios 2 to 5 (Store path is the real one, numbers against
   `du` and the folder count, filters, a live refusal). Do not press **Move to
   trash** yet.
3. Pick **one small, old, archived tree** that you can lose track of safely.
   Preview it alone (scope **The current selection**) and check that the preview
   lists only that tree and the typed count is what you expect. Move it.
4. Check the sidebar as in scenario 6, then press **Undo** and check as in
   scenario 7. Stop. Do not use **Delete permanently…** on the real store in this
   run.
5. Run the real prune of more trees only after you are happy with 1 to 4, one
   batch at a time, and keep **Restore batch** in mind as the way back.

Failure means: any difference from the copy's results. Write it down before you
touch anything else.

## Record your result

Copy this table. Get the commit with `git rev-parse --short HEAD`.

| Date | Commit | Scenario | Pass/fail | Note |
|---|---|---|---|---|
| | | 1 Install and restart | | |
| | | 2 First run on the copied store | | |
| | | 3 Overview numbers against `du` | | |
| | | 4 Archived filters and sort | | |
| | | 5 Preview with a refusal | | |
| | | 6 Move to trash, host sidebar | | |
| | | 7 Undo | | |
| | | 8 Restore batch | | |
| | | 9 Purge with typed confirmation | | |
| | | 10 Purge disabled by config | | |
| | | 11 zh locale | | |
| | | 12 Light and dark theme | | |
| | | 13 Narrow width | | |
| | | 14 Keyboard-only run | | |
| | | 15 The real store | | |
