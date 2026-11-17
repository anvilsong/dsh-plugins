# Live menu checklist (client plugins)

Follow this by hand in the real GUI after each change to the client plugins
(`packages/router`, `packages/advisor`, `packages/ultracode`). The package tests
only run simulated browsers. Every check below comes from the package READMEs;
where a README does not settle a point, the step says which section to read first.

## Prerequisites

- Client plugin file (`packages/*/src/client.js`): refresh the page. No restart.
- Host file (`packages/*/src/index.host.js`, and the `state.js`, `ledger.js`,
  `planner.js`, `verifier.js` files it loads): restart `dsh-web`, then refresh.
  If you are not sure which kind a changed file is, restart and refresh.
- Use a fresh session with an authorized route list (more than one model). Pick
  models that advertise at least two efforts, and one that advertises none.
- Open DevTools (Application → Local Storage) for the GUI origin to read the
  `dsh.autoEffort.v1:*` keys. Do not edit keys except where a step says so.
- A "failure" below means: write it down in the table at the end, with what you
  saw instead. Do not retry until you have recorded it.

## 1. Advisor model flyout

1. Turn **Advisor** on. Open the model-options menu, then the **Advisor model** cell.
2. Pick model `P/M` (advertising efforts). Reopen the cell.
3. Expect: **Inherit**, then models by provider. Directly under `P/M`'s row,
   indented, the effort rows: **Default** (named, such as `Default (High)`, when
   the model's default is known), then the advertised efforts in order. No heading
   row, no separator. One row says "recommended" (the highest effort that is not
   `max` or `off`; on the Default row if there is none). A check is on the saved effort row.
4. Pick an effort row. Expect: one command in the chat, `/advisor model P/M effort=<id>`;
   flyout closes; cell reads `M · <id>`.
5. Reopen, pick another model. Expect: flyout closes, one command sent: the new
   model plus its recommended effort (none if it advertises none, or only `max`/`off`).
6. Pick **Inherit**. Expect `inherit` sent, no effort group shown afterwards.

Failure means: rows in the wrong place, a visible heading or separator, a missing
caption or check, or no close/send. Read the README section "Use" first.

## 2. Verifier model cell

1. With Advisor on, open the **Verifier model** cell and pick a model `P/M`.
2. Expect: same structure as 1, but **Default** carries "recommended". The pick sent
   `/advisor verifier-model P/M` with no effort.
3. Pick an effort row, then **Default**. Expect `... effort=<id>`, then no effort.

Failure means: a recommended mark on any row other than Default, or an effort sent on
a model pick. Read "Use" first.

## 3. Automatic recommended effort (Advisor model)

1. In a new session, turn Advisor on, then type `/advisor model P/M` (no effort),
   where `P/M` advertises an effort other than `max`/`off`. Check that the cell
   shows only `M`.
2. Open the model menu once, wait for the model directory, and leave the flyout closed.
3. Expect: one command `/advisor model P/M effort=<id>` appears by itself, the
   cell reads `M · <id>`, and DevTools shows one key
   `dsh.autoEffort.v1:advisor:<session id>:advisorModel`. Close and reopen the menu:
   nothing more is sent.
4. Ask the lead to start an advisor consult. Expect its prompt/spawn to show
   `effort=<id>`. Check README "Effort" for where that shows before relying on it.
5. Reverse it: open the flyout, pick **Default**. Expect `/advisor model P/M` sent,
   and, after reopening the menu, nothing re-applies it.
6. Optional: new browser profile, another GUI origin, or deleting the key applies it once more.

Failure means: nothing sent (or sent again on every opening), a send while the
flyout was open, or a Default that does not stay. Read "Automatic effort" first.

## 4. Router level flyout

1. Turn **Model router** on. Open **Hard judgment**.
2. Expect: a one-line description, **Inherit (session default)**, models by provider.
   Unchecked models show no effort rows. Check a model `P/M`: its effort rows appear
   directly under it, indented, as a group `Effort for M`: **Default**, then the
   advertised efforts. The recommended row (caption on the right) is the highest
   effort that is not `max`/`off`; a check marks the chosen row.
3. Open **Mechanical** and **Ordinary**, check a model. Expect **Default**
   recommended and checked.
4. Toggle models on and off with the mouse and the keyboard. Expect the host menu
   stays open and keyboard focus stays inside the flyout. (README "Use" does not
   state this focus rule; check that section first, and note what you saw.)
5. Close the flyout. Expect one `/router level hard ...` command in the chat and
   a spinner on the cell until it is confirmed. The cell reads like
   `M · <id> +1`.
6. Re-check a model in the same opening and expect the effort it had back.

Failure means: effort rows shown for an unchecked model, the wrong recommended row,
several commands for one edit session, or the host menu closing on a toggle.

## 5. Keyboard

Open a level flyout (Select the cell, or ArrowRight). Check:

- ArrowDown/ArrowUp move through the model rows and the effort rows of checked models.
- Escape, Tab and ArrowLeft each close the flyout and return focus to its cell.
- Home and End: not promised by either README. If they work, note it; do not report a failure.
- Advisor cells: Tab also picks the focused row (README "Use"), so Tab there sends
  a command; in the router it only closes. Escape and ArrowLeft for Advisor:
  check README section "Use" first, as it names no keys beyond Tab.

Failure means: focus lost to the page, or a flyout that stays open after the listed keys.

## 6. Locked state

1. Send a command that runs for a while (for example an effort check: set an
   effort with `/advisor model P/M effort=<id>`; the Host checks up to 10 s).
2. While it runs, open the menu. Expect the Advisor switch and both model cells to
   ignore input. The router's effort rows are disabled while the menu is locked.
3. When the command ends, the rows work again.

README does not define "locked" beyond these cases; check "Use" and "Automatic
effort" (Advisor) and "Effort rows" (router). Failure means: a pick sent during the lock.

## 7. Negative checks

1. Type `/advisor model P/M effort=<an id the model does not advertise>`. Expect a
   refusal that lists the advertised ids as `id (name)`. `/advisor status` shows
   the previous setting, unchanged.
2. Ask the lead to start an `advisor-consult` with a wrong `reasoning_effort`, then
   with none, while an effort is stored. Expect the host guard to deny both. The
   README says only that the denial names the required provider, model,
   `reasoning_effort` and the reset command (README "Effort"); copy the exact
   text you see into the table.
3. Also check that a teammate's call, or a call with Advisor off, that carries
   `reasoning_effort` gets "Only the lead can start an advisor child." or
   "Advisor is off for this session; enable Advisor first.".

Failure means: an unadvertised effort stored, or a spawn admitted with the wrong effort.

## 8. Ultracode

1. The composer shows an **Ultracode** switch beside AgentTeam, in the current state.
2. Flip it. Expect the same as `/ultracode on` / `/ultracode off` (a command entry in
   the chat, the switch following the state). `/ultracode` alone toggles.
3. Run `/ultracode status`. Expect the mode and, for the current or last run,
   the attempt count and stop reason; it does not start any orchestration.
4. With it on, the final answer ends with `## Not examined / not verified`.
   (Prompt behaviour: depends on the model; record, do not treat as a UI failure.)
5. Do not test the 25th-attempt denial (`ultracode_budget_exhausted:spawns`) live;
   it costs many model calls. The package tests cover it.

## Record your result

Copy this table. Get the commit with `git rev-parse --short HEAD`.

| Date | Commit | Scenario | Pass/fail | Note |
|---|---|---|---|---|
| | | 1 Advisor model flyout | | |
| | | 2 Verifier cell | | |
| | | 3 Automatic effort | | |
| | | 4 Router level flyout | | |
| | | 5 Keyboard | | |
| | | 6 Locked state | | |
| | | 7 Negative checks | | |
| | | 8 Ultracode | | |
