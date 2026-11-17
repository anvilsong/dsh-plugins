# dsh-plugin-advisor

An opt-in, in-process advisor for DeepSeek Harness sessions. A read-only
advisor child on the **Advisor model** plans work and advises on design
decisions and reviews. A read-only verifier child on the **Verifier model**
then checks its claims against the repository.

## Use

```text
/advisor on
/advisor off
/advisor status
/advisor model
/advisor model inherit
/advisor model <provider>/<model> [effort=<id>]
/advisor verifier-model
/advisor verifier-model inherit
/advisor verifier-model <provider>/<model> [effort=<id>]
```

`effort=<id>` is optional and only for an explicit route; see [Effort](#effort).

The model-options menu has one **Advisor** switch and two menu cells: **Advisor
model** and **Verifier model**. Both cells are dimmed while Advisor is off.
Each cell opens one side flyout of single-choice rows: **Inherit**, the
authorized models grouped by provider, then an **Effort** group for the model
the cell shows: the saved model, or the one a pick is still saving. A choice
sends one complete command and closes the flyout; Tab also picks the focused
row. The explanation lives in the Advisor info tooltip.
Advisor off stops advisor runs and verification but keeps both model
preferences. Every new session starts with Advisor off and both models on
**Inherit**.

What each row sends (`/advisor model` for the Advisor model,
`/advisor verifier-model` for the Verifier model):

- **Inherit:** `inherit`, never with an effort.
- **Another model:** `<provider>/<model>` plus its recommended effort, if any.
  For the Advisor model that is the highest effort the model advertises whose
  id is not `max` (for example `xhigh`); a model that advertises only `max` or
  no efforts, or whose efforts the model directory cannot tell (not listed
  yet, or no usable effort id), gets none. The Verifier model's recommendation
  is always Default, so its picks send no effort.
- **The model the cell shows:** nothing, so an effort set by command is kept.
  To change the effort of a model that is not saved yet, pick it, then reopen
  the flyout.
- **The saved model, while a pick of another one is unconfirmed:** the saved
  setting as it is, never with a recommended effort.
- **An effort row:** `<provider>/<model> effort=<id>` for the group's model.
- **Default:** `<provider>/<model>` without an effort: the model's own default
  effort.

The Effort group is headed with its model (**Effort for claude-opus-5-5**) and
lists **Default**, then the efforts the model advertises, by name and in their
order, as DSH's model directory for the session reports them. When the
directory reports the model's own default effort and it is one of those
efforts, the first row names it: **Default (High)**; otherwise it reads plain
**Default**. Either way it sends no effort, and the cell shows nothing extra
for it. The recommended row is marked "recommended": for the Advisor model the
highest effort below `max`, for the Verifier model Default. If the Advisor
model's recommended effort is the model's default, the mark sits on that
effort's row and the Default row only names it. The Advisor model's Default
row carries the mark itself when there is no effort below `max` (the model
advertises only `max`, or no efforts and an effort is saved), or when the
directory cannot tell the model's efforts and the group shows only for a saved
effort. The group is hidden for Inherit and for an unavailable saved route. If
the directory does not list the model, lists none of its efforts in a usable
form, or the model advertises no efforts, the group appears only when an
effort is saved: Default plus that id. A saved id that the model does not
advertise is listed last in the warning colour (plainly when the directory
cannot tell); the menu never clears or changes a saved effort by itself.

The Effort rows do not change while the flyout is open; a directory update
shows when it is next opened. If the cell's model changes while the flyout is
open (a pending pick is refused, another tab saves another model, or the model
leaves the authorized list), the group stays in place under its model's name,
but its rows are disabled and send nothing; the next opening shows the new
model's group. The model rows, unlike the Effort rows, still follow the
authorized list while the flyout is open.

The cell shows `<model> · <effort id>`, or only the model for Default; a long
model name is cut before the effort. Any refusal while a pick whose effort the
menu added is unconfirmed, whatever its reason (that effort, Advisor already
updating, a command line that was not admitted, or another command's failure
for the same setting), makes later picks of that model send no effort until
the session shows a saved effort for that model, or until the model menu
closes; nothing is retried automatically. A refused effort that you picked
yourself only shows the Host's message: an effort row always sends its effort,
and its refusal leaves the model's recommended effort in place.

**Automatic effort.** When the model menu opens and the Advisor model is
saved as a model without an effort (Default), the Advisor model cell applies
that model's recommended effort once, by itself: it sends
`/advisor model <provider>/<model> effort=<id>`, the line a pick of that model
sends (the highest advertised effort whose id is not `max`). It sends only
while Advisor is on, the cell's flyout is closed, the cell is not locked or
saving, no Advisor update is pending, the saved route is authorized, the saved
setting is still the one the cell first showed in that opening of the menu (a
change from another tab or a typed command stops it until the menu is opened
again), and the model directory lists the model's efforts with one below
`max`. While the directory cannot tell the model's efforts yet, the cell waits
and sends nothing; a model that advertises only `max` or no efforts gets
nothing. A session with Advisor off gets it once Advisor is on while the menu
is open. It is tried at most once per opening and never retried: a refusal is
reported like any other, the setting stays as it was, and that model's next
picks in that opening go without the effort. The command's chat entry and the
cell's ` · <effort>` are the only signs; there is no other notice and no
switch to turn it off. To undo it, pick **Default** in the Effort group.

Before it sends, the cell records the session in the browser's localStorage
under `dsh.autoEffort.v1:advisor:<session id>:advisorModel`: one key per
session, whatever the model. Every choice in the Advisor model cell that sends
a command (a model, an effort, Default, Inherit) writes the same key first, so
nothing is applied automatically after you have chosen there and a Default you
pick stays. A choice that sends nothing (the row already checked, or any row
while the cell is locked) writes nothing. The key belongs to the GUI's origin
(scheme, host and port), so:

- Another browser or profile, another GUI origin, or cleared site data applies
  it once more.
- A Default set by command before this browser applied the effort or recorded
  a choice cannot be told from an older setting without an effort, and is
  upgraded once.
- Without localStorage (unavailable, blocked, or failing), nothing is applied
  automatically; the menu otherwise works as before.
- The Verifier model cell never applies anything by itself, since its
  recommendation is Default, and never reads or writes the key.

**Upgrade notes.**

- 0.3.0 removed `/advisor verifier on|off`; Advisor on always verifies.
- 0.5.0 replaces earlier external consultations with in-process advisor children and adds
  `/advisor model`. Development builds used `/advisor planner`; that command now
  returns an error that points to `/advisor model`.
- The projection moved to state version 7 (a saved model can carry an
  effort), so cached Advisor state is rebuilt once from the session log.
- An Advisor model saved without an effort gets its recommended effort once,
  the next time the model menu opens in a browser with Advisor on (see
  **Automatic effort** above).
- Advisor data moved into the DSH home (see [Data directory](#data-directory)).
  Runs recorded before the Advisor data directory existed are not read by the
  plugin.

## Model selection

Both selectors offer **Inherit** plus the exact provider/model routes
authorized for this session's subagents. Advisor derives that list from the
durable `subagent/model-selection-policy` event; it does not modify DSH's
shipped projection or the saved `allowedModels` setting.

- If no explicit route list is authorized, a selector offers Inherit only.
- If a saved route is no longer in that list, the cell marks it unavailable and
  offers Inherit as the reset.
- Saved route-policy changes still apply only to new Sessions.

What the lead does with each choice:

- **Inherit:** omits provider, model, effort, and preset, so the normal
  subagent defaults apply: the configured child defaults, else the lead's own
  model and effort.
- **Explicit route:** passes exactly that provider and model and omits effort
  and preset, so that model runs at its own default effort, not the lead's.
  Choosing the lead's own model explicitly is therefore not Inherit: the effort
  falls to the model's default.
- **Explicit route with an effort:** passes that provider and model plus
  `reasoning_effort "<id>"`, and omits preset.
- The Host refuses an advisor child whose route or effort differs from the
  selection, or whose route is no longer authorized. An explicit-route spawn
  failure is reported, with no silent fallback.
- Model router exempts all Advisor children (`advisor-planner-*`,
  `advisor-consult-*`, `advisor-verifier-*`) and leaves these choices to
  Advisor.

### Effort

```text
/advisor model <provider>/<model> effort=<id>
/advisor verifier-model <provider>/<model> effort=<id>
```

- `<id>` is the exact effort id the model advertises (for example in
  `list_subagent_models`). It is stored as typed: case matters, and there are
  no names, aliases, or nearest-effort fallback.
- The effort is the last whitespace-separated token of the setting, so a model
  id may contain spaces. The keyword `effort=` is lowercase and
  case-sensitive: `EFFORT=high` is not a token but part of the model id. Text
  after the token, or an earlier second `effort=` token, also stays part of
  the model id; such a route is not authorized, so nothing is stored. A model
  id that itself ends in ` effort=<x>` can only be addressed with an effort
  token after it.
- Without `effort=` the route runs at the model's own default effort (Default);
  there is no `effort=default` keyword. An empty `effort=` and `effort=` with
  Inherit are usage errors; only the second adds "Inherit takes no effort":
  Inherit never carries an effort.
- Setting an effort checks it first with the same preflight a spawn runs, for
  at most 10 seconds. An id the model does not advertise is refused with the
  advertised ones as `id (name)`. If the check cannot run (no llm service,
  another error such as missing credentials, or the 10 s limit), the command
  fails with `could not be checked: <reason>`. Either way nothing is stored.
  While the check runs, `/advisor status` reports that Advisor is updating and
  other changes are refused; when it ends, they work again. Setting a model
  without an effort, or Inherit, never runs a check.
- `/advisor status`, `/advisor model`, and `/advisor verifier-model` show a
  stored effort as `<provider>/<model> effort=<id>`.
- The delegation guards require `reasoning_effort` to be exactly the stored id,
  and absent when there is none or on Inherit. With a stored effort, the
  denial of a wrong or missing provider, model or `reasoning_effort` names the
  required provider, model and `reasoning_effort` and the reset command.
  Without one, the denial texts are
  the old ones, with one change of order: the advisor-planner/advisor-consult
  guard now checks `reasoning_effort` after its lead and Advisor-on checks, so
  a teammate's call or a call while Advisor is off that carries one gets "Only
  the lead can start an advisor child." or "Advisor is off for this session;
  enable Advisor first." instead of "must omit reasoning_effort" (still a
  denial).
- An `agent_preset` is refused before those checks. Without a stored effort
  the denial keeps the old text, which says to omit `reasoning_effort` and
  `agent_preset`; with one it says to omit `agent_preset` and repeats the
  required provider, model, `reasoning_effort` and the reset command.
- The effort is checked at delegation only, not at child start or submit:
  changing it mid-run keeps a finished run, while a model change still
  discards it.
- Drift: if the model stops offering a stored effort, the effort is never
  cleared or lowered automatically. Spawns on it fail at the spawn preflight,
  the lead reports that and does not retry without the effort, and
  `/advisor status` adds a best-effort "no longer offered" note. Reset with
  `/advisor model <provider>/<model>` (Default, the same model) or
  `/advisor model inherit`, or the same with `verifier-model`.
- The model menu shows and sends efforts too (see [Use](#use)). Picking
  another model there replaces the saved route, including a command-set
  effort, with that model and its recommended effort; picking Inherit resets
  both; picking the model already saved sends nothing and keeps the effort.
  An Advisor model saved without an effort, including a Default set by
  command, can get its recommended effort once from the open menu (see
  **Automatic effort** under [Use](#use)).
- Advisor children record both values in the ledger: `effort_requested` is
  the effort stored when the child first started (a child resumed after a
  Host restart keeps the value of its `started` line, whatever the setting is
  by then), `effort` what the child's own model selection reports (see
  [What the Host records](#what-the-host-records)). The verifier's effort is
  enforced at delegation only; verifiers write no ledger line.

Live check, before the menu gains an effort choice:

1. Restart DSH so the Host loads this code, open a fresh session, and turn
   Advisor on.
2. Pick a model `P/M` that advertises at least two efforts and an id `E` that
   is not its default (`list_subagent_models`).
3. Run `/advisor model P/M effort=E`, then let the lead start one
   `advisor-consult`.
4. Pass: the guard admits the spawn, and the `ok` ledger line has
   `effort_requested: E`. Its `effort` value tells whether the child's
   selection reports the effort: `E` means it does, `null` means it does not
   (keep the effort out of the start check); anything else means stop and
   investigate first.

## Advisor runs

While Advisor is on, the lead consults the in-process advisor at three points:
before non-trivial multi-step or hard-to-reverse work, at design decisions that
are expensive to reverse, and for an outside review of substantial work.

Limits:

- Normally at most three advisor runs per task, failures included.
- At most one plan per task, plus one re-plan, and only after the verifier
  forces a discard.
- One advisor child at a time per session.

| Role | Child name | Records with | Result |
|---|---|---|---|
| Planning | `advisor-planner-<id>` | `advisor_plan_submit` | Task plan (`kind: plan`) |
| Design decisions and reviews | `advisor-consult-<id>` | `advisor_advice_submit` | Structured advice (`kind: advice`) |

The lead generates each `<id>` with `openssl rand -hex 6` (12 lowercase hex).
The child's whole prompt is a self-contained briefing: the goal, verified
ground truth with `file:line` references, the options or plan under review,
pointed questions, and constraints. The child reads workspace files, and its
model provider receives what it reads, so briefings never contain credentials
or sensitive context.

### Plan format

1–25 tasks. Each task has:

- `id` and `title`
- `level` (`mechanical`, `ordinary`, or `hard`) and `level_reason`
- `write_scopes`: workspace-relative files or prefixes
- `acceptance`: criteria, each with a one-line `verify`
- `blocked_by` and `open_questions`

Checks:

- Ids are unique.
- Dependencies exist and are acyclic.
- Tasks with overlapping scopes are ordered by `blocked_by`. Overlap ignores
  case and Unicode normalization.
- Mechanical tasks have no open questions.
- Scopes are not absolute and contain no `~`, `..`, `.git`, or globs.

### Advice format

- `question`, `recommendation`, and `rationale`
- `options`: up to 8, each `recommended`, `viable`, or `rejected`; at most one
  is recommended, and names are unique
- `risks` and `do_not_build`
- `claims`: the repository facts the advice relies on, each with 1–5
  `path[:line[-line]]` references, for the verifier
- `open_questions`

### Invalid submissions

Problems come back as a list so the child can fix them. After five invalid
attempts the child is stopped.

### What the Host records

The Host writes the result as JSON to `<dataDir>/replies/<id>.md` (exclusive
create) and appends to `<dataDir>/sessions.jsonl` in the line format below: a
`started` line, then one terminal line with these fields:

- `consult_id` = `<id>`, `kind` (`plan` or `advice`), `advisor: dsh`, and
  `backend: dsh:<provider>/<model>`
- `model`; `effort`, the reasoning effort the child's own model selection
  reports (`null` when it reports none); and `effort_requested`, the Advisor
  model's stored effort when the child first started (`null` for none or
  Inherit). The `started` line carries these as well; a child resumed after a
  Host restart takes `effort_requested` from its `started` line.
- `reply_file` and `reply_sha256`
- `task_count` or `claim_count`
- `submit_attempts`, `tool_calls`, and `duration_s`
- token totals summed from the child's own session: `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
  `reasoning_tokens`, and `model_requests`
- `topic`: taken from an optional first briefing line `topic: <slug>`. The
  slug is 1–40 characters of lowercase letters, digits, and hyphens, and starts
  with a letter or digit; spaces or tabs may surround it. Otherwise `topic` is
  `unset`. The `started` line is always `unset`, because it is written before
  the briefing arrives.

A child that ends, times out (30 minutes), exceeds 150 tool calls, or is stopped
without a result gets a `status: failed` line with `failure_reason`.

### Data directory

All Advisor data lives in one plugin-owned folder, `dataDir`:

- `<dataDir>/sessions.jsonl`: the ledger, one JSON line per write (mode 0600).
- `<dataDir>/replies/<id>.md`: one immutable reply per run (mode 0600, created
  exclusively).
- Folders are created with mode 0700.

The bundle patch sets the default, `dataDir: !!js dshHomePath('advisor')`, so
it is `~/.dsh/advisor` unless `DSH_HOME` moves the DSH home. The folder is shared
by every profile on the machine, like DSH's own `~/.dsh/storages`. To isolate a
profile, override the `advisor` row in that profile's `cordis.patch.yml` with an
absolute `dataDir`. An override replaces the whole `config` block, so restate
`dataDir`. A home-level `<DSH home>/cordis.patch.yml` applies after the profile
patch and can replace that override too, so check both when isolating a
profile.

`dataDir` rules:

- It must be an absolute, normalized path with no `..` and at most one
  trailing separator, not a filesystem root, with no control characters, line
  or paragraph separators, bidirectional-control characters (Unicode
  `Bidi_Control`) or backticks, and no leading or trailing whitespace. On
  Windows it needs a drive or UNC share. Only the string is checked when the
  plugin loads; the folder itself is checked at every use (below).
- An existing folder must belong to the user running the Host and its mode
  bits must not let group or others write (`mode & 0o022` is 0). Read bits are
  not checked: the write rule keeps others from planting or swapping entries,
  and confidentiality rests on the files, which the plugin creates with mode
  0600. In an existing folder with mode 0755, other users can therefore list
  file names, sizes and times, but cannot read anything the plugin created. An
  existing `sessions.jsonl` with mode 0644 is accepted and appended to as it
  is, and then other users can read it; the plugin never changes modes. Run
  `chmod 700 <dataDir>` to hide the folder's contents from other users. The
  plugin itself creates its folders with mode 0700 and its files with 0600.
- ACLs are not inspected, only the owner and the mode bits. On macOS, list a
  folder's ACLs with `ls -le` and remove them with `chmod -N`.
- An existing `sessions.jsonl` and `replies/` follow the same owner and mode
  rule, and neither may be a symlink. The ledger must also be readable and
  writable, because the guards read it. The Host opens the ledger with
  `O_NOFOLLOW`.
- `dataDir` itself may be a symlink only if you or root created the link; the
  folder it points to must pass the rules above. Only that first link is
  checked: further links in a chain are followed without checks, and
  `O_NOFOLLOW` covers only the ledger file itself.
- If the config has no `dataDir`, the Host uses `<DSH home>/advisor` from the
  profile context. The DSH home must itself pass the string rule above (an
  absolute, normalized path, not a root); `<DSH home>/advisor` is then
  checked like a configured `dataDir`.

Not supported: a `dataDir` below a folder that another non-root user can write
to, or a link, or link target, that resolves through such a folder. That user
could swap a path component between the check and the write, and Node has no
`openat`-style call to close that race. The same applies to the DSH home
itself: whoever can replace `~/.dsh` also controls the patch that sets
`dataDir`, so no ledger check could defend against that.

On Windows (no `process.getuid`) the owner and mode checks are skipped, so a
symlinked `dataDir` is accepted whoever owns the link, and `O_NOFOLLOW` is not
available; only the `lstat` type checks (a directory, a regular file, no
symlink) and a basic permission check apply.

If the value is invalid or neither source is available, the folder is not
configured; if it is not writable or unsafe, it is reported as such. Either way
the Host logs a warning and fails closed:

- It refuses every advisor-planner, advisor-consult and advisor-verifier
  delegation, and cancels any such child that starts anyway.
- `/advisor status` and the reply to `/advisor on` say that the folder is not
  configured, not writable or unsafe, with the reason.
- The lead's instructions switch to a short notice that tells it not to start
  advisor children.

The folder is re-checked at every delegation, child start, status and prompt
build, so fixing it takes effect without a restart; only an invalid or missing
value needs a config change and a reload. The writers also re-check the folder
right before every write, so a run fails at submit if the folder became unsafe
after the run started; its reply and terminal ledger line are then not
written. If the folder turns unsafe between writing the reply and appending
the ok line, the reply file stays but no terminal line is written. The plugin
reads no environment variables for any of this.

After a short write, the Host ends the partial line with a newline, and the
ledger readers skip an unparseable fragment and recover a whole line behind it.
A line that parses as a whole is taken as it is; only an object whose
top-level `consult_id` is the ID counts as an entry of that ID. The recovery
tries at most 64 offsets per line, from the end of the line backward, and only
on lines of at most 1 MB, so one hostile line cannot stall the guards.

Why files and not the DSH storage service: the verifier cites ledger lines and
reply lines, and the lead checks reply hashes with a shell. Both need the exact
bytes in plain files. Guards also need a fresh read of the ledger written by
other hosts. The storage service is key/value only, loads every record when it
opens, and shows changes only within one process.

The data stays when the plugin is removed or a profile is deleted; DSH has no
cleanup hook for plugin data. Delete the folder by hand if you no longer need
it. There is no rotation; the guards read the whole ledger, so revisit this if
`sessions.jsonl` grows past about 5 MB.

### What the lead does next

1. The lead checks the hash and runs the verifier routine below with
   `advisor-verifier-<id>`.
2. It relies on confirmed claims, drops refuted ones, and treats unverifiable
   ones as opinion. A verdict is cited only by its ledger `consult_id`.
3. For plans:
   - A refuted task stays off the board unless the lead fixes it from the
     verifier's cited fact.
   - An unverifiable task goes up one level.
   - A plan is discarded if a root task's premise is refuted or more than a
     third of its tasks are refuted.
   - The lead confirms levels with the router's rules: doubt goes up, never
     down to mechanical.
   - It creates one shared task per accepted plan task with `team_task_create`,
     mapping `blocked_by` to the created task ids. The model router routes the
     workers; the advisor never picks models or spawns workers.

### Host enforcement for advisor children

Delegation:

- Only `subagent` from the lead, with an exact name, no preset, and
  `reasoning_effort` only as exactly the stored effort (none without one).
- Advisor must be on, the selected route still authorized, and Agent Teams
  enabled.
- The id must be unused, and only one advisor child may run per session.
- `send_message` to an advisor child is refused.
- Other child names starting with `advisor-` are refused.

Execution:

- Default-deny. Only `read`, `grep`, `glob`, and the child's own scoped submit
  tool run, checked against the definitions captured at start.
- At start and at submit, the child must be running on the selected Advisor
  model (provider and model; the effort is checked at delegation only).
- Reads stay inside the lead's workspace after symlinks are resolved, and paths
  may not contain `..`.
- `.git`, `.ssh`, `.env*` (except templates), keys, and credential files are
  refused.
- The child's `grep` is a scoped wrapper around the Host grep that drops
  matches in protected or outside files.
- After a result is recorded, every further tool call is refused.

Limits of this iteration:

- `cost_usd` is `null`, because the Host knows tokens but not prices.
- `backend` is `dsh:unknown` if the child's model cannot be read.
- `effort` is `null` when the child's selection does not report its effort;
  `effort_requested` is then the only record of a requested effort.
- The Host's hash pin lives in memory and is lost on restart; the lead's own
  hash check still applies.
- `glob` can still list the names, but not the contents, of protected files.
- Grep results over 250 matches do not get the saved full-result file.

## Evidence verification

After an advisor run whose terminal ledger line has status `ok`:

1. The lead matches the terminal ledger `consult_id` and `reply_file`, and
   checks the reply against the ledger's `reply_sha256`.
2. The lead creates and claims one shared task containing the ledger path,
   consult ID, exact reply path, and expected hash. Only the lead mutates or
   completes this task; it contains no findings or second verdict.
3. The lead starts one fresh in-process `subagent` named
   `advisor-verifier-<full-id>` on the Verifier model.
4. The verifier gets the ledger entry and the reply from its
   `advisor_evidence_get` tool, reads every part of the reply, and reads the
   relevant repository lines. Its final response is the sole report:
   - Each material claim is `confirmed`, `refuted`, or `unverifiable`, with
     `file:line` evidence, checked against the whole reply. The ledger entry
     is cited as `sessions.jsonl:<line>` and reply lines as
     `<reply_path>:<line>`, with the physical line numbers the tool reports.
   - It compares the tool's `reply_path` with the task's reply path and its
     `reply_sha256` with the task's hash, and says that it cannot hash the
     file itself. Every part must report the same hash and part count.
   - For plans it checks facts per task: paths, named files and symbols, verify
     entry points, and contradictions of a mechanical level.
   - For advice it checks each entry under `claims`.
   - Opinions without repository evidence stay unverifiable, and so do claims
     about sources outside the workspace, such as the DSH installation and its
     harness sources or other repositories, which the verifier cannot read.
   - There is no aggregate score or overall verdict.
5. After the report, the lead re-reads the task pointers and checks the reply
   hash again; any change invalidates the report. While the Host process runs,
   it also refuses a verifier whose reply file no longer matches the hash it
   recorded.

`advisor_evidence_get` is registered on each verifier only. Its consult ID is
the 12 hex characters of the verifier's own name, so a verifier sees only its
own run. It takes one optional argument, `part`: an integer from 1, the
default. Every other argument, such as an ID, a path, an offset or a limit, is
refused, and so is a `part` that is not an integer of at least 1. Every call
returns:

- `ledger_path` and `entries`: the 1-based line number and text of every
  ledger line holding an entry whose top-level `consult_id` is that ID. Lines
  of other IDs are not shown. On a torn line, where a failed short write left
  a fragment of another line in front of a whole line of this ID, only this
  ID's entry is shown, from its first character, and it is marked
  `torn: true`; the fragment itself is never shown.
- `reply_path`: `<dataDir>/replies/<id>.md`, computed by the plugin.
- `reply_sha256`, the hash of the whole file as read by this call (not only
  of the part), `reply_total_lines`, `reply_parts` and `reply_part`. The hash
  is informational; the lead keeps both of its hash checks.
- `reply_text`: one part of the file with `<n>: ` line prefixes, numbered the
  way a file reader numbers lines. The numbered text is split on whole lines
  into parts of at most 32 KB. Larger tool results would be cut by the Host to
  their head and tail, with the middle in a file the verifier cannot read. A
  line longer than 32 KB is cut at character boundaries and continues on lines
  labelled `<n>+: `, which belong to physical line `<n>`. The verifier calls
  the tool again with parts 2 to `reply_parts` and reads all of them before it
  reports. A part beyond the last is refused with the valid range.

The tool never opens the `reply_file` named in a ledger line. It withholds the
reply (`reply_text` is `null`, and `reply_reason` gives the reason for every
part) in these cases:

- **No terminal entry:** the ledger has no terminal line for the ID, or the
  last terminal line does not name `reply_path` as its `reply_file`. A
  `started` line after the terminal line does not change the result.
- **Unsafe folder:** the data directory fails the checks under
  [Data directory](#data-directory), which run again at every call, or the
  real path of the reply is not exactly
  `<real path of dataDir>/replies/<id>.md`. This catches, for example,
  `replies/` replaced by a symlink after the verifier started.
- **Missing:** the reply file does not exist.
- **Unreadable:** the reply file itself is a symbolic link (its last path
  component is never followed, not even to a file inside the data directory),
  it is not a regular file (a directory, or a FIFO, which is refused without
  blocking), or it cannot be opened or read.
- **Too large:** the file is larger than 256 KB, by its size or by the bytes
  actually read. The reason ends with "reply too large to verify; cite as
  unverifiable".

The verifier boundary is default-deny:

- Only `read`, `grep`, `glob`, `team_task_get`, and `advisor_evidence_get` are
  allowed. Shell commands, writes, task mutations, messaging, further
  delegation, and `run_code` are denied, including scoped or late-registered
  tools.
- `read`, `grep`, and `glob` are confined exactly like advisor children: paths
  stay inside the lead's workspace after symlinks are resolved and may not
  contain `..`, protected files are refused, and `grep` drops matches in
  protected or outside files.
- The data directory is denied to `read`, `grep`, and `glob`, also when the
  workspace contains it, such as a home-directory workspace with the default
  `<DSH home>/advisor`. A path is denied when its real path is the folder or
  lies below it, or when one of its folders is the data directory under
  another name (same device and inode), so symlinks into it and a second path
  to the same folder do not get in. `grep` drops matches in it. The verifier
  takes the ledger and the reply only from `advisor_evidence_get`.
- The workspace root is the lead's working directory, and the verifier's own
  working directory must lie inside it and outside the data directory. A
  filesystem root such as `/` is never a workspace. Without the
  working-directory service, with an unknown or relative root or working
  directory, a root of `/`, or a verifier working outside the root or in the
  data directory, the verifier is stopped and every tool is denied.
- Reserved delegations with malformed names, a non-spawn backend, Advisor off,
  a route different from the stored selection, or a `reasoning_effort` other
  than its stored effort are rejected.
- Guards belong to the child's lifetime, so switching Advisor off mid-run does
  not lift them.

Limits of the verifier:

- Claims about files outside the workspace, including the DSH harness sources,
  end as unverifiable, and so do the claims of a reply over 256 KB.
- `glob` can still list the names, but not the contents, of protected files
  and of files in a data directory inside the workspace.
- The data-directory and filesystem-root rules apply to the verifier only.
  Advisor children (`advisor-planner-*`, `advisor-consult-*`) are confined to
  the workspace as described above: a workspace that contains the data
  directory still exposes the ledger and the replies to them, and a workspace
  of `/` is accepted for them.

The plugin keeps one ledger in its `dataDir` and creates no plan store, retry
engine, or orchestration framework. Restart DSH manually after Host code changes; the
existing Web URL and `app.asar` are left untouched.

## License

MIT
