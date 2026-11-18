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
authorized models grouped by provider, with the **Effort** rows of the model
the cell shows (the saved model, or the one a pick is still saving) directly
under that model's own row, indented, as in the Model router. A choice
sends one complete command and closes the flyout; Tab also picks the focused
row. The explanation lives in the Advisor info tooltip.
Advisor off stops advisor runs and verification but keeps both model
preferences. Every new session starts with Advisor off and both models on
**Inherit**.

What each row sends (`/advisor model` for the Advisor model,
`/advisor verifier-model` for the Verifier model):

- **Inherit:** `inherit`, never with an effort.
- **Another model:** `<provider>/<model>` plus its recommended effort, if any.
  For the Advisor model that is the highest advertised effort that is neither
  `max` nor `off` (for example `xhigh`); a model that advertises no other
  effort or no efforts, or whose efforts the model directory cannot tell (not
  listed yet, or no usable effort id), gets none. The Verifier model's
  recommendation is always Default, so its picks send no effort.
- **The model the cell shows:** nothing, so an effort set by command is kept.
  To change the effort of a model that is not saved yet, pick it, then reopen
  the flyout.
- **The saved model, while a pick of another one is unconfirmed:** the saved
  setting as it is, never with a recommended effort.
- **An effort row:** `<provider>/<model> effort=<id>` for the group's model.
- **Default:** `<provider>/<model>` without an effort: the model's own default
  effort.

The Effort rows form a group of their own (labelled **Effort for
claude-opus-5-5** for screen readers; there is no heading row and no separator)
right after their model's row, so a long model list needs no scrolling to reach
them. They list **Default**, then the efforts the model advertises, by name
and in their order, as DSH's model directory for the session reports them.
When the directory reports the model's own default effort and it is one of
those efforts, the first row names it: **Default (High)**; otherwise it reads
plain **Default**. Either way it sends no effort, and the cell shows nothing
extra for it. The recommended row is marked "recommended": for the Advisor
model the highest effort that is neither `max` nor `off`, for the Verifier
model Default. If the Advisor model's recommended effort is the model's
default, the mark sits on that effort's row and the Default row only names it.
The Advisor model's Default row carries the mark itself when there is no such
effort (the model advertises only `max` or `off`, or no efforts and an effort
is saved), or when the directory cannot tell the model's efforts and the group
shows only for a saved effort. The group is hidden for Inherit and for an
unavailable saved route. If the directory does not list the model, lists none
of its efforts in a usable form, or the model advertises no efforts, the group
appears only when an effort is saved: Default plus that id. A saved id that
the model does not advertise is listed last in the warning colour (plainly
when the directory cannot tell); the menu never clears or changes a saved
effort by itself.

The Effort rows do not change while the flyout is open; a directory update
shows when it is next opened. If the cell's model changes while the flyout is
open (a pending pick is refused, another tab saves another model, or the model
leaves the authorized list), the group stays in place under its model's row,
but its rows are disabled and send nothing; the next opening shows the new
model's group. If that model leaves the authorized list, its row stays too
until the flyout closes, disabled and in the warning colour, so no row moves
or disappears from under the pointer or the keyboard focus. The other model
rows follow the authorized list while the flyout is open.

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
that model's recommended effort by itself, once per session in each browser:
it sends `/advisor model <provider>/<model> effort=<id>`, the line a pick of
that model sends (the highest advertised effort that is neither `max` nor
`off`). It sends only while Advisor is on, the cell's flyout is closed, the
cell is not locked or saving, no Advisor update is pending, the saved route is
authorized, the saved setting is still the one the cell first showed in that
opening of the menu (a change from another tab or a typed command stops it
until the menu is opened again), and the model directory lists the model's
efforts with one that is neither `max` nor `off`. While the directory cannot
tell the model's efforts yet, the cell waits and sends nothing; a model that
advertises no other effort, or no efforts, gets nothing. A session with
Advisor off gets it once Advisor is on while the menu is open. While the Host
checks the effort of that command (up to 10 s), the Advisor switch and the
rows of both model cells ignore input, as for any effort you set. The attempt
is claimed (see the key below) before the line is sent, and a claimed attempt
is final in that browser: if the command service is unavailable, the line is
not admitted, or the Host refuses it, or if the menu closes while the command
is in flight and it then fails, nothing tries again; pick the effort by hand.
A failure is reported like any other, the setting stays as it was, and that
model's next picks in that opening go without the effort. The command's chat
entry and the cell's ` · <effort>` are the only signs; there is no other
notice and no switch to turn it off. To undo it, pick **Default** among its
Effort rows.

Before it sends, the cell records the session in the browser's localStorage
under `dsh.autoEffort.v1:advisor:<session id>:advisorModel`: one key per
session, whatever the model. Every choice in the Advisor model cell that sends
a command (a model, an effort, Default, Inherit) writes the same key first, so
nothing is applied automatically after you have chosen there and a Default you
pick stays. A click on the checked **Default** row records your choice the
same way and still sends nothing, so a Default you confirm there stays too.
Any other choice that sends nothing (the model's own row, a checked effort,
Inherit when it is the setting, or any row while the cell is locked) writes
nothing. The key belongs to the GUI's origin (scheme, host and port), so:

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
  enforced at delegation only; its verification line records `effort` and
  `effort_requested` the same way (see
  [Verification records](#verification-records)).

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
- Scopes are not absolute and contain no `~`, `..`, `.git`, or glob
  characters (`*`, `?`, `[`, `]`, `{`, `}`).
- Scopes contain no control, format or line separator characters and no
  unpaired surrogates, the same rule as evidence references: C1 controls such
  as U+0085, the separators U+2028 and U+2029, bidirectional controls such as
  U+202E, and zero-width or other invisible characters such as U+200B and an
  inner U+FEFF are refused, which closes the commonest way to disguise a name
  from the overlap check. It does not close every way: spaces such as U+00A0,
  combining and variation marks, filler characters and look-alike letters from
  other scripts are valid, so the overlap check is advisory. Other non-ASCII
  names, such as `src/文档/readme.md` or `src/café.js`, are valid. Input that an earlier rule already refuses keeps that rule's
  message, such as "must not contain control characters" for C0 controls.

### Advice format

- `question`, `recommendation`, and `rationale`
- `options`: up to 8, each `recommended`, `viable`, or `rejected`; at most one
  is recommended, and names are unique
- `risks` and `do_not_build`
- `claims`: the repository facts the advice relies on, each with 1–5
  `path[:line[-line]]` references, for the verifier. The path follows the
  scope rules, except that literal `[`, `]`, `{` and `}` are allowed (as in
  `app/[id]/page.tsx:3`); `*` and `?` are refused as globs. A malformed line
  suffix such as `a.js:12:5`, `a.js:12-` or `a.js:` is refused rather than read
  as part of the path; a colon followed by anything else, as in `dir/a:b.js`,
  belongs to the name. A reference may not contain control, format or line
  separator characters or unpaired surrogates
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
without a result gets a `status: failed` line with `failure_reason`. The time,
tool-call and invalid-submission caps count from when the Host process that
runs the child started or resumed it, not from the child's first start: a child
resumed after a Host restart gets a fresh budget, and its `duration_s`,
`tool_calls` and `submit_attempts` count only from the resume.

Verifiers add `kind: verification` lines, which name the run under
`verifies` instead of `consult_id`; see
[Verification records](#verification-records).

### Data directory

All Advisor data lives in one plugin-owned folder, `dataDir`:

- `<dataDir>/sessions.jsonl`: the ledger, one JSON line per write (mode 0600).
- `<dataDir>/replies/<id>.md`: one immutable reply per run (mode 0600, created
  exclusively).
- `<dataDir>/replies/<id>.verification.json`: at most one verification record
  per run (mode 0600, created exclusively, at most 64 KB); see
  [Verification records](#verification-records).
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
top-level `consult_id` is the ID counts as an entry of that ID. Verification
lines have no top-level `consult_id`, so they are never an entry of the run
they verify. The recovery
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
   - An unverifiable task keeps its confirmed level, except that one confirmed as mechanical goes up to ordinary (one raised to hard stays hard); the doubt is copied into its description.
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
- The workspace root is the lead's working directory, and the child's own
  working directory must lie inside it. Without the working-directory service,
  or with an unknown root or working directory, the child is stopped (with a
  `failed` line, unless its id already has a terminal line or belongs to
  another child) and every tool is denied; the delegation checks above still
  apply.
- `.git`, `.ssh`, `.env*` (except templates), keys, credential files and the
  other [protected names](#protected-names) are refused.
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

### Protected names

One check, `protectedSegment` in `src/planner.js`, decides which paths are
protected for every reader: the `read`, `grep` and `glob` paths of advisor
children and verifiers, the files whose `grep` matches are dropped, and the
evidence references of advice claims and verification records. The child's
model provider receives what it reads, so these names are kept from it.

The list is best-effort, not a guarantee: it goes by names only, so a secret
stored under an ordinary name, such as `config/settings.json`, stays readable,
and briefings must still never contain secrets. Names are compared without
regard to case.

- Folders, whatever the file inside: `.git`, `.ssh`, `.gnupg`, `.aws`,
  `.azure`, `.kube`, `.docker`, `.config` and `.secrets`.
- The folders `secrets` and `credentials`, except their files with a source,
  documentation or asset extension (listed below): `k8s/secrets/db.yaml` and
  `config/credentials/production.yml.enc` are protected,
  `src/credentials/vault-resolver.ts` is not. The rule goes by the folder name
  alone, so an ordinary package folder named `credentials` or `secrets`, as in a
  monorepo, is refused too: its `package.json` and locale files cannot be read,
  and a verifier whose working directory lies inside it is stopped. Rename the
  folder or work from another directory if that is in the way.
- A file in a source, documentation or asset extension stays readable even when
  its name suggests a secret: `passwords.md`, `secrets/dump.sql` and
  `secrets/config.js` are readable. Only the names above and the extension list
  decide; nothing looks inside a file. The dotenv templates below are readable
  inside these folders as well (`secrets/.env.example`); inside the other
  folders listed first, nothing is.
- Other folders count only by these exact names. A folder whose name merely
  contains a secret word, such as `src/secrets-manager/`, `src/token-service/`
  or `app/reset-password/`, is ordinary, and its files are judged by their own
  names. An existing folder given as a `grep` or `glob` path is judged the
  same way; a path that does not exist, and every evidence reference, is
  judged as a file name. The file rules below also apply to a folder's own
  name when it is given as a path, so a `grep` path `secret/` or `id_rsa_keys/`
  is refused even though the files inside `secret/` are judged by their own
  names.
- dotenv and direnv files: `.env` and `.env.*` and `.envrc` and `.envrc.*`,
  except the templates `.env.example`, `.env.sample`, `.env.template` and
  `.env.dist` and the same four endings after `.envrc`; `*.env` (`prod.env`).
- Keys and key stores: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`,
  `*.keystore`, `*.kdbx`, `*.ppk`, `*.asc`, `*.gpg`, and SSH keys named
  `id_rsa`, `id_dsa`, `id_ecdsa` or `id_ed25519`, alone or followed by `.`,
  `_` or `-` and more (`id_rsa.pub`, `id_ed25519_sk`, `id_rsa_work`), unless
  the name ends in a source extension (`id_rsa_parser.go` is code).
- Credential dotfiles: `.npmrc`, `.netrc`, `.pypirc`, `.pgpass`,
  `.git-credentials` and `.htpasswd`.
- `credentials` and `secret` or `secrets`, alone or with extensions
  (`credentials.json`, `secrets.yaml`, `secret.js`).
- Terraform: state `*.tfstate` and `*.tfstate.*` (`terraform.tfstate.backup`,
  `.terraform.tfstate.lock.info`), and variables `*.tfvars` and
  `*.tfvars.json` (`terraform.tfvars`, `prod.auto.tfvars`). The template
  `terraform.tfvars.example` is not protected.
- Secret words in a file name. The words are `credential` or `credentials`,
  `secret` or `secrets`, `password` or `passwords`, `private key` and
  `api key` (singular or plural, written together or with `-`, `_` or `.`,
  as in `private_key` or `apikey`), and `token`. A word counts only when the
  start or end of the name, `.`, `_`, `-` or a digit bounds it, so
  `secretary.js`, `tokenizer.js`, `credentialing-docs.md`, `passwordless.json`
  and the plural `tokens.json` contain none.
  - A name whose last extension is not a source, documentation or asset
    extension is protected when a secret word other than `token` stands
    anywhere in it (`aws-credentials.json`, `client_secret_123.json`,
    `my_secrets.yaml`, `db-password.txt`, `private-key.json`), or when a
    secret word or `token` is its last word, followed only by digits, `_` or
    `-` before the next dot or the end (`github-token.txt`, `token.json`,
    `refresh_token_2.json`, `bot.token`). `token` counts only as the last word
    because names like `token-bucket.json` and `token-list.json` are ordinary.
  - A name without an extension is protected when a secret word or `token`
    is its last word (`access_token`, `GITHUB_TOKEN`, `.vault-token`,
    `aws-credentials`).
  - A source, documentation or asset extension keeps the name readable:
    code, prose and images about secrets (`src/token-bucket.js`,
    `src/secret-scanner.ts`, `src/aws-credentials.ts`,
    `docs/rotating-secrets.md`, a `…_password_policy.sql` migration). The
    extensions are `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`,
    `.tsx`, `.vue`, `.svelte`, `.astro`, `.map`, `.py`, `.pyi`, `.pyc`,
    `.pyx`, `.pxd`, `.rb`, `.go`, `.rs`, `.java`, `.kt`, `.kts`, `.scala`,
    `.groovy`, `.swift`, `.m`, `.mm`, `.dart`, `.lua`, `.php`, `.pl`, `.pm`,
    `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.cs`, `.fs`, `.ex`,
    `.exs`, `.erl`, `.hrl`, `.clj`, `.cljs`, `.elm`, `.hs`, `.ml`, `.r`,
    `.jl`, `.zig`, `.sol`, `.sql`, `.css`, `.scss`, `.sass`, `.less`, `.html`,
    `.htm`, `.proto`, `.graphql`, `.gql`, `.md`, `.mdx`, `.markdown`, `.rst`,
    `.adoc`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp` and `.ico`.
    Shell scripts, `.txt`, and data and configuration formats such as `.json`,
    `.yaml` or `.ini` are not on the list. The exact names above (`secrets.js`,
    `credentials.ts`) stay protected whatever their extension.

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
   - After the claim review it calls `advisor_verifier_report` once with the
     status and `file:line` evidence of each claim it checked (see
     [Verification records](#verification-records)). The record is
     measurement, not a verdict, and its absence invalidates nothing.
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

- Only `read`, `grep`, `glob`, `team_task_get`, `advisor_evidence_get`, and
  `advisor_verifier_report` are allowed. Shell commands, writes, task
  mutations, messaging, further delegation, and `run_code` are denied,
  including scoped or late-registered tools. The report tool has no path or ID
  argument: the Host writes its one record.
- `read`, `grep`, and `glob` are confined exactly like advisor children: paths
  stay inside the lead's workspace after symlinks are resolved and may not
  contain `..`, [protected names](#protected-names) are refused, and `grep`
  drops matches in protected or outside files.
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
- The Host checks the form of a verification record, not its truth: it does
  not open the cited evidence files, and where the record and the final
  response differ, the final response counts.

The plugin keeps one ledger in its `dataDir` and creates no plan store, retry
engine, or orchestration framework. Restart DSH manually after Host code changes; the
existing Web URL and `app.asar` are left untouched.

### Verification records

After its claim review the verifier calls `advisor_verifier_report` once, with
one entry per claim it checked. The record is measurement, not a verdict: the
verifier's final response stays the sole report, the lead's task, completion
and hash checks do not change, and a missing record invalidates nothing. Like
`advisor_evidence_get`, the tool is registered on each verifier only, bound
to it, and refused by name to every other agent; its consult ID is the 12 hex
characters of the verifier's own name.

Its one argument, `entries`, holds 1 to 100 entries:

- `ref`: for advice the 1-based position of the claim in `claims`, as a string
  such as `"3"`; for a plan the task ID, such as `"T2"`; or `"other"` for any
  other claim. An advice claim number lies between 1 and the terminal line's
  `claim_count` and appears at most once; a plan task ID must be one of the
  plan's and may appear in several entries.
- `status`: `confirmed`, `refuted`, or `unverifiable`.
- `reply_line`: the physical reply line of the claim, a positive integer.
- `evidence`: 0 to 5 workspace-relative references in the grammar of advice
  claims (`path`, `path:line` or `path:start-end`; no absolute, `~`, `..`,
  `.git`, glob (`*` or `?`; literal brackets and braces are allowed) or
  protected path, no malformed line suffix such as `:12:5`, and no control,
  format or line separator character or unpaired surrogate). `confirmed` and
  `refuted` need at least one.
- `note`: optional plain text of at most 300 characters, without control,
  format or line separator characters or unpaired surrogates.

There is no ID, path, tally, importance, severity, score or summary input. A
claim without an entry is not an error: the result names the claims or tasks
that no entry covers, and the record keeps `expected` and `covered`, so the gap
stays measurable. The result carries no counts.

The Host refuses a report, lists the problems and writes nothing when the
entries are invalid or the record would exceed 64 KB; when the reply is
withheld or unreadable, exactly as for `advisor_evidence_get`, or the last
terminal ledger line is not an `ok` or `degraded` plan or advice run with its
count and `reply_sha256`; or when the bytes it reads no longer hash to that
`reply_sha256`. After five refused calls the tool closes; the verifier is never
stopped over it. A synchronous latch lets only one call write. A valid report
is written once:

1. `<dataDir>/replies/<id>.verification.json`, created exclusively with mode
   0600, at most 64 KB: `schema: advisor-verification/1`, `verifies` (the
   ID), the validated `entries`, the `reply_sha256` the Host read, and
   `recorded_at`. Verifier-authored text, the notes and evidence, lives only
   in this file; the verifier's file tools are denied the data directory.
2. One flat line appended to `sessions.jsonl`, with Host-authored values only:

| Field | Value |
|---|---|
| `kind`, `schema` | `verification`, `advisor-verification/1` |
| `verifies`, `verified_kind` | the run's ID and kind, `plan` or `advice` |
| `ts`, `status` | Unix seconds, `recorded` |
| `session_id`, `verifier_session_id` | the agent ids of the lead and of the verifier, as in the planner's `session_id` and `planner_session_id` |
| `backend`, `model`, `effort`, `effort_requested` | the verifier's own route, recorded as for advisor children |
| `reply_sha256` | the hash the Host read |
| `report_file`, `report_sha256` | the record file and the hash of its bytes |
| `expected`, `covered` | the run's `claim_count` or `task_count`, and how many of those claims or tasks have an entry |
| `entries` | the number of entries |
| `confirmed`, `refuted`, `unverifiable` | claim or task entries per status |
| `other` | entries with ref `other`; with the three counts above it sums to `entries` |
| `submit_attempts`, `tool_calls`, `duration_s` | report calls checked, tool calls admitted past the verifier's identity checks, and seconds since its first start in this Host process (a verifier resumed after a Host restart counts from the resume) |

For a plan the status counts are per entry, not per task: one task can have
several entries. There are no token or cost fields for verifiers.

An allowed verifier that ends without a record (at `subagent/end`,
`agent/disposed`, or when the plugin unloads) gets one line with
`status: unrecorded`, unless its session already has a verification line: the
same fields without `reply_sha256`, the record fields and the counts
(`verified_kind` is `null` when the ledger names no plan or advice run), plus a
`reason`:

- `not_called`: it never called the tool.
- `invalid_payload`: its last refused call had invalid entries.
- `reply_changed`: the reply no longer hashed to its `reply_sha256`.
- `reply_withheld`: the reply was withheld or unreadable, or the run did not
  end `ok` or `degraded`.
- `already_recorded`: the consult already had a record.
- `write_failed`: the record or its line could not be written. If only the
  line failed, the record file stays, like a reply whose `ok` line failed.

One record per consult: the exclusive create is the guarantee, and a record
cannot be amended or replaced. A second verifier on the same consult, as in an
A/B round, records `already_recorded`; compare such runs with separate data
directories. A `recorded` line closes its consult: every later report is
refused as `already_recorded`, also when the record file is gone.

The first verification line of a verifier session is final. Once a verifier
session, its agent id, has a `recorded` or `unrecorded` line, no second
`unrecorded` line is written and a later report from the same agent id is
refused as `already_recorded`, also after a plugin reload or for a new Agent
object under the same id. The Host checks the ledger for this, so it holds
across reloads; another verifier session on the same consult may still record.

Verification lines carry no top-level `consult_id`, so the readers keyed by ID
never see them: the evidence tool still serves the reply to a later verifier,
and the planner's resume and ID checks and `idInUse` are unchanged.
`/advisor status` skips them, because they are not runs. The session
projection stays at state version 7.

Offline tallies: divide by the `ok` or `degraded` terminal lines that have a
verification line for their ID, `recorded` or `unrecorded`, and not by all `ok`
terminal lines: only runs verified while verification was on count, and a run
nobody verified has no verification line. The `unrecorded` lines give the
reasons. A Host crash writes no `unrecorded` line, so a verifier that ended
with the Host is missing from both counts.

## License

MIT
