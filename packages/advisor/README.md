# dsh-plugin-advisor

An opt-in, in-process advisor for DeepSeek Harness sessions. A read-only
advisor child on the **Advisor model** plans work and advises on design
decisions and reviews. A read-only verifier child on the **Verifier model**
then checks its claims against the repository.

The plugin does not call the `advisor` skill (the Claude CLI behind
`consult.py`). That skill stays available for you to invoke directly, which
also makes the two easy to compare.

## Use

```text
/advisor on
/advisor off
/advisor status
/advisor model
/advisor model inherit
/advisor model <provider>/<model>
/advisor verifier-model
/advisor verifier-model inherit
/advisor verifier-model <provider>/<model>
```

The model-options menu has one **Advisor** switch and two menu cells: **Advisor
model** and **Verifier model**. Both cells are dimmed while Advisor is off.
Each cell opens a side flyout of single-choice rows: **Inherit**, then the
authorized models grouped by provider. A choice commits immediately and closes
the flyout; Tab also picks the focused row. The explanation lives in the
Advisor info tooltip. Advisor off stops advisor runs and verification but keeps
both model preferences. Every new session starts with Advisor off and both
models on **Inherit**.

**Upgrade notes.**

- 0.3.0 removed `/advisor verifier on|off`; Advisor on always verifies.
- 0.5.0 replaces skill consultations with in-process advisor children and adds
  `/advisor model`. Development builds used `/advisor planner`; that command now
  returns an error that points to `/advisor model`.
- The projection moved to state version 6, so cached Advisor state is rebuilt
  once from the session log.
- Advisor data moved into the DSH home (see [Data directory](#data-directory)).
  Runs recorded earlier stay in the advisor skill's folder
  (`~/.local/state/advisor`, or under `$XDG_STATE_HOME` or `$ADVISOR_LEDGER` if
  those were set); nothing is migrated, and the plugin no longer reads
  `XDG_STATE_HOME` or `ADVISOR_LEDGER`.

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

- **Inherit:** omits provider, model, effort, and preset, so configured child
  defaults and compatible parent values apply.
- **Explicit route:** passes exactly that provider and model and omits effort
  and preset, so the model's default effort applies.
- The Host refuses an advisor child whose route differs from the selection or
  is no longer authorized. An explicit-route spawn failure is reported, with no
  silent fallback.
- Model router exempts all Advisor children (`advisor-planner-*`,
  `advisor-consult-*`, `advisor-verifier-*`) and leaves these choices to
  Advisor.

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
create) and appends to `<dataDir>/sessions.jsonl` in the same line format the
skill's `consult.py` uses: a `started` line, then one terminal line with these
fields:

- `consult_id` = `<id>`, `kind` (`plan` or `advice`), `advisor: dsh`, and
  `backend: dsh:<provider>/<model>`
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
  advisor children and not to substitute `consult.py`.

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

Why files and not the DSH storage service: the verifier cites ledger lines and
reply lines, and the lead checks reply hashes with a shell. Both need the exact
bytes in plain files. Guards also need a fresh read of the ledger written by
other hosts. The storage service is key/value only, loads every record when it
opens, and shows changes only within one process.

The data stays when the plugin is removed or a profile is deleted; DSH has no
cleanup hook for plugin data. Delete the folder by hand if you no longer need
it. There is no rotation; the guards read the whole ledger, so revisit this if
`sessions.jsonl` grows past about 5 MB.

### Comparing with the advisor skill

`scripts/compare.mjs` pairs plugin runs (`advisor: dsh`) with CLI advisor runs
(any other advisor) by `topic` and prints a Markdown report.

```text
node packages/advisor/scripts/compare.mjs [--ledger <file>]... [--topics <file>] \
  [--tallies <file>] [--price <model>=<in>,<out>[,<cacheRead>,<cacheWrite>]]...
```

- **Topics:** give each briefing a unique topic. Use it for exactly one run per
  arm: the plugin briefing's first line, and `ADVISOR_TOPIC` for `consult.py`.
  The report shows the last answered line (`ok` or `degraded`) per topic and
  arm, or else the last line. Its `runs` column counts every terminal line, so
  reused topics stay visible. Only lines of kind `plan` or `advice` are paired.
- **`--topics`:** a JSON object mapping `consult_id` to a topic slug. It
  supplies or overrides the topic of those lines, for runs recorded before topic
  tagging existed. A malformed file exits 1.
- **`--ledger`:** repeatable; lines from every ledger are merged, and a
  relative `reply_file` resolves against its own ledger's folder. Without it the
  script reads every existing default: the plugin ledger
  `<DSH home>/advisor/sessions.jsonl` (`$DSH_HOME`, else `~/.dsh`) and the
  advisor skill's ledger `~/.local/state/advisor/sessions.jsonl`
  (`$XDG_STATE_HOME` honoured). `ADVISOR_LEDGER`, if set, replaces the defaults
  for this script only. If no ledger is found, the script exits 1.
- **`--tallies`:** a JSON object keyed by `consult_id` that the lead writes
  from verifier reports:
  `{"<consult_id>": {"confirmed": 0, "refuted": 0, "unverifiable": 0}}`.
  Counts are non-negative integers. A malformed file exits 1 with no table.
- **`--price`:** USD per million tokens, matched on the line's `model`. Token
  fields are disjoint, so give all four rates; with two rates, cache tokens are
  not priced. The `recorded` cost column is the line's own `cost_usd`; the
  `priced` column is tokens times these rates.
- **Status cells:** the line's own status (`ok`, `degraded`, `failed`,
  `timeout`, ...), or `missing` when that arm has no run. `degraded` counts as
  answered.
- **Reply cells:**
  - `valid plan` or `valid advice`.
  - `invalid plan (n)` or `invalid advice (n)`, where `n` is the number of
    issues.
  - `wrong kind`: only the other kind's shape was found.
  - `malformed`: no JSON object in the file, its fenced blocks, or unfenced
    text.
  - `missing-file`.
  - `hash-mismatch`: the file differs from `reply_sha256`, so it is not
    validated.
  - `-` for runs that were not answered.
- **Validity is not symmetric:** plugin replies are validated before they are
  recorded. For the CLI, validity measures whether it returned the exact JSON
  shape.
- **Exit codes:** 0 on success, 2 for usage errors, 1 for an unreadable or
  missing ledger, or a bad tallies or topics file.

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

- Only `subagent` from the lead, with an exact name and no effort or preset.
- Advisor must be on, the selected route still authorized, and Agent Teams
  enabled.
- The id must be unused, and only one advisor child may run per session.
- `send_message` to an advisor child is refused.
- Other child names starting with `advisor-` are refused.

Execution:

- Default-deny. Only `read`, `grep`, `glob`, and the child's own scoped submit
  tool run, checked against the definitions captured at start.
- At start and at submit, the child must be running on the selected Advisor
  model.
- Reads stay inside the lead's workspace after symlinks are resolved, and paths
  may not contain `..`.
- `.git`, `.ssh`, `.env*` (except templates), keys, and credential files are
  refused.
- The child's `grep` is a scoped wrapper around the Host grep that drops
  matches in protected or outside files.
- After a result is recorded, every further tool call is refused.

Limits of this iteration:

- `cost_usd` is `null`, because the Host knows tokens but not prices. A
  comparison prices tokens itself.
- `backend` is `dsh:unknown` if the child's model cannot be read.
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
4. The verifier reads the exact ledger entry, reply file, and relevant
   repository lines. Its final response is the sole report:
   - Each material claim is `confirmed`, `refuted`, or `unverifiable`, with
     `file:line` evidence.
   - For plans it checks facts per task: paths, named files and symbols, verify
     entry points, and contradictions of a mechanical level.
   - For advice it checks each entry under `claims`.
   - Opinions without repository evidence stay unverifiable.
   - There is no aggregate score or overall verdict.
5. After the report, the lead re-reads the task pointers and checks the reply
   hash again; any change invalidates the report. While the Host process runs,
   it also refuses a verifier whose reply file no longer matches the hash it
   recorded.

The verifier boundary is default-deny:

- Only `read`, `grep`, `glob`, and `team_task_get` are allowed. Shell commands,
  writes, task mutations, messaging, further delegation, and `run_code` are
  denied, including scoped or late-registered tools.
- Reserved delegations with malformed names, a non-spawn backend, Advisor off,
  or a route different from the stored selection are rejected.
- Guards belong to the child's lifetime, so switching Advisor off mid-run does
  not lift them.
- Unlike advisor children, the verifier has no workspace path confinement in
  this iteration.

The plugin keeps one ledger in its `dataDir` and creates no plan store, retry
engine, or orchestration framework. Restart DSH manually after Host code changes; the
existing Web URL and `app.asar` are left untouched.

## License

MIT
