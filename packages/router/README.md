# dsh-plugin-router

Opt-in lead-controlled model routing with three session-scoped complexity-level
shortlists for ordinary DeepSeek Harness subagents. Each shortlist entry may
carry the reasoning effort to pass with its model.

## Use

```text
/router manual
/router on        # alias for manual
/router off
/router status

/router level mechanical inherit
/router level ordinary inherit
/router level hard inherit
/router level <level> <provider>/<model>[ effort=<id>][,<provider>/<model>[ effort=<id>]...]
```

For example:

```text
/router level hard anthropic/claude-opus-5-5 effort=xhigh,openrouter/~deepseek/deepseek-flash-latest
```

sets Hard judgment to two entries: Opus with effort `xhigh`, and Flash at its
own default effort. See [Effort per entry](#effort-per-entry).

The model-options menu has one **Model router** switch followed by three
native-style menu cells: **Mechanical**, **Ordinary**, and **Hard judgment**.
Each cell shows its current choice (for example `Inherit`, or
`claude-opus-5-5 · xhigh +1`: the first model, its effort, and how many more);
the cells stay in place, dimmed, while Router is off, so the menu does not
shift and levels can be prepared in advance. The cell's tooltip lists every
entry with its effort. Selecting a cell, or pressing ArrowRight on it, opens a
side flyout drawn with the host menu material: a one-line description of the
level, **Inherit (session default)**, then the authorized models grouped by
provider with a trailing check on each selected model and, under each selected
model, its effort rows, indented native menu rows (see [Effort per entry](#effort-per-entry)). Edits are a
draft while the flyout is open and are committed as one `/router level`
command when it closes (or when the menu closes), so each edit session adds
one command entry to the chat. The cell shows a spinner until the session
confirms the change, for at most 30 seconds after its command starts: a change
the session neither confirms nor rejects by then reverts to the session's
value and is reported once in the composer's toast (a newer choice made
meanwhile is kept and committed next). Router commands from this menu run one
at a time per session: the switch, the three cells, and a draft committed as
the menu closes share one queue, so a change made while another command is
queued or running waits its turn, and further presses of the switch are
ignored until its command lands or fails. Time spent waiting does not count
toward the 30 seconds; a command that has not returned 30 seconds after it
started no longer holds up the queue. Up to four models per level; further
rows are disabled. Saved routes that are no longer authorized appear under
**Unavailable** and are dropped, with their efforts, by the next change. Arrow
keys move through the model rows and the effort rows of checked models; Escape, Tab,
or ArrowLeft closes the flyout and returns focus to its cell. Rejections
recorded in the session log (for example "Router is already updating") appear
in the composer's toast.

Selections are session-scoped and retained across off/on. Every level defaults
to Inherit. Invalid or unauthorized routes, and malformed effort tokens, reject
the whole command without changing the level. Null route policy means
Inherit-only. Saved DSH route-policy changes apply only to new Sessions.

## Effort per entry

Each shortlist entry is a model plus, optionally, the effort to pass with it.

- **Grammar.** Entries are separated by commas. Inside an entry the effort
  token `effort=<id>` is the last whitespace-separated token and appears at
  most once; the keyword is lowercase (`EFFORT=` or `Effort=` is a usage
  error, not part of a model id), and the id is 1–32 characters from
  `A-Z a-z 0-9 . _ -`, kept as typed. Model ids may still contain slashes and
  inner spaces. An entry without a token runs at its model's own default
  effort. `inherit` takes no token, there is no level-wide token and no
  effort-only form, and every command states the whole level: an entry's
  effort is never kept from the saved level. The same model may appear only
  once per level, whatever its efforts. Efforts are not checked against the
  model when they are set. An entry typed with `effort=default` is legal: it
  stores the id `default`, which the lead passes as `reasoning_effort`
  "default" although it reads like the model default (`effort: default`) in
  the `router:` line, and replaying a state version 4 log can produce it.
- **Effort rows.** Under each checked model row the flyout shows that model's
  effort rows, indented under it, as a group labelled `Effort for <model>`.
  They are native menu rows like the model rows and the Advisor's Effort group
  (single-choice, a check on the chosen row, a right-aligned *recommended*
  caption on the recommended row), not pills: **Default** (named after the
  model's real default effort, for example `Default (High)`, when the session's
  model directory advertises it), then the efforts the model advertises, in
  the directory's order, by name. A `defaultEffort` that is missing from the
  advertised list counts as unknown (Default stays unnamed). Advertised ids
  outside `[A-Za-z0-9._-]{1,32}`, which a command could not carry, and repeated
  ids are not shown; a list with no usable id counts as unknown. The rows are
  built from the directory snapshot taken when the flyout opens and do not
  change while it is open, so an effort that another tab saves meanwhile and
  that the model does not advertise shows in the cell but has no checked row
  until the next opening. A model's effort rows are hidden until it is checked,
  and are disabled while the menu is locked. A model listed without efforts has
  no effort rows (unless its entry carries an effort: then Default and that
  effort, so it can be cleared). When the directory is not available yet (or
  does not list the model), the group offers **Default** only, plus the entry's
  saved effort, unmarked. A saved effort that a listed model does not advertise
  is appended last in the warning colour.
- **Recommended defaults.** For a model whose efforts are listed, one row is
  marked *recommended* (Default, when the level recommends Default), and the
  recommendation is applied when a model that is not in the saved level is
  checked in the flyout; re-checking a model in the same opening restores the
  effort it had. Typed commands never get a default, and saved entries get one
  only once, through the
  [automatic recommended effort](#automatic-recommended-effort). Per level:

  | Level | Recommended effort |
  |---|---|
  | Mechanical | Default (no effort token: the model's own default). |
  | Ordinary | Default. |
  | Hard judgment | The highest advertised effort other than `max` (and `off`), so `max` stays a deliberate pick; otherwise Default. |

  Models whose efforts are unknown get no recommendation (Default).
- **What the lead sees.** Shortlist lines list each authorized entry with its
  effort, for example:

  ```text
  - hard: anthropic/claude-opus-5-5 (effort xhigh), openrouter/~deepseek/deepseek-flash-latest
  ```

  The lead passes exactly the chosen entry's effort as `reasoning_effort` with
  its provider and model, and omits `reasoning_effort` for an entry without
  one. If the spawn is rejected for the effort, the lead says so and retries
  once on the same route without `reasoning_effort`. The router line ends in
  `effort: <id|default>`.
- **Advisory.** The entry's effort is an instruction to the lead: router
  children carry no Host check, and the `router:` line is the lead's only
  statement of intent; the `reasoning_effort` argument of the subagent call
  itself is also recorded in the session log.
- **Behaviour change.** Before this version the lead chose effort by level
  (`low` for Mechanical when advertised, the route default for Ordinary, the
  highest advertised effort for Hard judgment when useful). That rule is gone:
  an entry without an effort now means the model's own default. The Host does
  not rewrite saved lists; the model menu adds the recommended effort once to
  saved Hard judgment entries without one (see
  [Automatic recommended effort](#automatic-recommended-effort)), and
  Mechanical entries keep their models' defaults: add `effort=low` to keep the
  old behaviour.

`/router status` reports the current mode and every level's entries in
command form (`<provider>/<model> effort=<id>`), marking entries whose route is
no longer authorized with `(unavailable)`; while an update is pending it
reports only which target is updating. Once the
[observe-only audit](#observe-only-audit) has counted a request or an
Advisor-reserved child, up to two last lines report its counts.

**Upgrade note.** The projection moved to state version 5 (entries gained an
optional effort), so cached Router state is rebuilt once from the session log.
Commands from before efforts carry no token, so their entries run at their
models' defaults. A development build briefly kept one effort preference per
level (`effort=auto|lowest|default|highest`, state version 4); replaying such a
log reads `a/b,c/d effort=highest` as the effort id `highest` on the last
entry (and `effort=default` as the id `default`), and `inherit effort=...` is
no longer accepted, so a level that was reset that way is not reset on replay:
it keeps its earlier shortlist, which comes back. Reset levels set with the
earlier effort preference.

## Automatic recommended effort

While the model menu is open, a saved level with at least one entry without an
effort gets the level's recommended effort added to those entries, once,
automatically. It is one ordinary `/router level` command that states the whole
level: the saved entries in their order, each existing effort kept, and the
recommendation added to every entry whose model has one. Only **Hard judgment**
sends anything today: Mechanical and Ordinary recommend Default, so they never
send. For example, with Opus advertising efforts up to `xhigh` and `max`, a
Hard judgment level saved as
`anthropic/claude-opus-5-5,openrouter/~deepseek/deepseek-flash-latest effort=low`
is sent as:

```text
/router level hard anthropic/claude-opus-5-5 effort=xhigh,openrouter/~deepseek/deepseek-flash-latest effort=low
```

The command is sent only when all of these hold at the same time:

- Router is on and the menu is not locked.
- No router command is pending in the session.
- The cell has no change of its own waiting, unconfirmed or still running; its
  own call holds the effort back for as long as it runs.
- No other router command from this page is queued or running. As for any
  change, another command no longer counts once it has run for 30 seconds.
- The level's flyout is closed.
- Every saved entry is authorized: a level with an **Unavailable** entry is
  left alone.
- The session's model directory has loaded the efforts of every entry without
  one. While they are still unknown the cell waits and writes nothing. A model
  listed without efforts, or whose only efforts are `max` and `off`, is
  skipped; a level left without any recommendation sends nothing.
- The level has not changed since the menu opened. A change from another tab
  or a typed command stops it until the menu opens again.

Each opening of the menu makes one attempt at most. The command is checked
again just before it is sent, and when the menu closes first: if the level has
changed meanwhile, Router is off, or the menu is locked, the command is dropped,
not sent. While it waits for another router command, it waits like any change.
It takes the same path as a change made in the flyout: one command entry in the
chat, the cell's effort and spinner while it is saved, the same 30-second
deadline, and a failure reported once in the composer's toast and never
retried. There is no other notice and no setting to turn it off. To undo it,
pick **Default** in the level's flyout; the marker keeps that choice.

**Marker.** The browser's localStorage records that it has happened, in one
key per session and level, never one per model:
`dsh.autoEffort.v1:router:<sessionId>:<level>`. The key is written just before
the automatic command and on every choice made in that level's flyout
(checking or unchecking a model, an effort row, Inherit, removing an
unavailable entry), so a Default picked later is never undone. A command that
is dropped or fails keeps its key, so it is not tried again in this browser.
Keys are never removed. When localStorage is unavailable or throws (for
example, blocked site storage), nothing is sent automatically; nothing in
memory stands in for it.

Caveats:

- localStorage belongs to one browser origin (scheme, host and port). Another
  browser or profile, another origin for the GUI, or cleared site data applies
  the recommendation once more to a level that still has entries without one.
- A saved entry without an effort cannot be told apart from a Default chosen
  by typing a command. A Default typed before the menu was first opened in this
  browser is upgraded once; pick Default in the flyout to keep it.
- Mechanical and Ordinary send nothing, because they recommend Default.
- Without usable localStorage nothing is sent.
- The router Host does not check an effort against the model. A model
  directory that is out of date can save an effort the model no longer offers;
  a routed spawn rejected for it is retried once without the effort (see
  [Effort per entry](#effort-per-entry)).

## Routing rules

- **Ordinary is the default.** Mechanical requires all three: fully specified
  work, no judgment, and a deterministically checkable result. Work that meets
  all three is Mechanical, for example running a named check and reporting its
  output, applying a fully specified edit, or collecting named files or logs.
  Hard needs a verification/judgment stage (review, critique, or refutation) or
  high ambiguity together with costly-to-undo output; costly-to-undo output
  alone, or ambiguity alone, is not enough, and running a named check and
  reporting its output is not a verification stage. Work that
  meets neither Hard criterion is Ordinary. Never relabel substantive work
  Mechanical to save cost. Doubt about whether a level's criteria are met never
  resolves downward, but work that clearly meets a lower level's criteria is not
  raised for safety. The `/router status` per-level line shows which shortlist
  ran, not whether the level was the right one.
- **Mechanical governs only work the lead chooses to delegate.** Fully specified,
  checkable work, such as running a named check, is normally run by the lead
  itself, so `mechanical 0` in `/router status` is the expected reading, not a
  fault. The tier exists to hold a cheap route behind three strict criteria; a
  user who wants no cheap route leaves it at Inherit, which is the default. If
  replays of at least 10 sessions that include plan-driven parallel workers
  still show `mechanical 0`, merge it into Ordinary in the same change as the
  next router state-version bump (the Advisor's plan levels name Mechanical
  too). `scripts/audit-replay.mjs` replays one session log read from stdin; add
  up the `mechanical` counts of the replays by hand.
- **Inherit by default.** A shortlist applies only when configured. Leave
  inheritance for a named non-cost reason—a capability, tool, context window,
  provider feature, or explicit user preference—or for high-confidence
  Mechanical work. Never downshift substantive work merely because it looks
  small, simple, or cheap.
- **Task fit before price or assumed capability.** Choose any shortlisted route
  that fits the stated reason. A shortlist is an unordered set, not a ranking,
  price list, or benchmark claim. The plugin does not invent model capabilities.
- **Effort belongs to the entry.** The lead passes exactly the chosen entry's
  effort, or none for an entry without one, and never chooses another effort.
  A spawn rejected for the effort is retried once on the same route without
  it.
- **Failure is visible.** Discovery failure, no models, or an unauthorized
  preferred route produces `router: inherit — route discovery unavailable or
  unauthorized` and omits route fields. Explicit-route spawn failure has no
  silent fallback. There are no retries on another model and no mid-run route
  changes; the one retry above keeps the route.
- **Other backends are unchanged.** Discovery and `router:` lines apply only to
  ordinary fresh in-process `subagent` calls. Advisor-reserved verifiers never
  use these shortlists; they keep Advisor's own Inherit-or-explicit selection.

Before each delegation the lead states:

```text
router: <level> → <provider>/<model> because <criterion>; effort: <id|default>
```

or `router: inherit — no clear route advantage`.

## Observe-only audit

While Router is on, the Host counts how the lead's `subagent` requests compare
with the shortlist entries the lead was shown. It only observes: nothing is
blocked, delayed or rewritten, and nothing reaches the prompt, the
model-options menu or a tool. In the Host its only output is one or two last
lines in `/router status`, for example:

```text
Observed subagent requests while Router was on: 12 (inherit 2, match 9, effort_mismatch 1). Observe only; nothing is blocked.
Shortlist that ran (route shown by): mechanical 0, ordinary 2, hard 7, shared 1. Advisor-reserved subagent requests: 9. Listed models first in 3 of 5 turns with routed requests.
```

The first line appears once a request has been counted, also after Router is
turned off, and lists the non-zero verdicts in the order of the table below.
The second line appears once a request or an Advisor-reserved child has been
counted (alone when only reserved children were), and always shows all four
level counts and both discovery numbers, zeros included. While an update is
pending, status still reports only the update.

- **What is counted.** Each request to the tool named exactly `subagent` made
  while Router is on in the session, as the session log records it, including
  requests the Host then refused. Counts are requests: a spawn rejected for its
  effort and its retry count as `match` and `retry`. Advisor-reserved children
  (`advisor-verifier`, `advisor-planner` and `advisor-consult`, alone or
  followed by `-`) are not requests: they have their own count (below). The
  other delegation tools (`subagent_fork`, `subagent_codex`,
  `subagent_claude_code`, `spawn_teammate`) are not counted.
- **What is compared.** The request's exact `provider`, `model` and
  `reasoning_effort` (or its absence) against the union of the entries every
  level shows the lead: authorized entries only, with the efforts their
  shortlist lines show. Each request is judged against the mode and
  shortlists in force at its event. A request carries no level, and none is
  guessed. The Host records the session's authorized routes before its first
  model request; only until that first record does the audit count every saved
  entry as shown (the policy would then show such a level as
  `Inherit (saved routes unavailable)`), so in practice no request is judged
  that way.

| Verdict | The request |
|---|---|
| `inherit` | Names no provider, model or effort. Inheritance is always compliant; it shows adoption, not a violation. |
| `match` | Names a shown entry exactly: its route, with its effort, or with none for an entry without one. |
| `retry` | Omits the effort on a shown route directly after an effort `match` on that route in the same turn: the one retry the policy prescribes. |
| `effort_mismatch` | Names a shown route with an effort that none of its shown entries carries, including an effort for an entry without one. |
| `effort_omitted` | Omits the effort on a shown route whose shown entries all carry one, and is no `retry`. |
| `unlisted_closed` | Names a route no level shows while every level shows a shortlist. |
| `unlisted_open` | Names a route no level shows while at least one level reads Inherit, where the policy allows a named non-cost reason. |
| `no_shortlist` | Names a route while no level shows any entry. |
| `malformed` | Has arguments that are no JSON object, a provider without a model or a model without a provider, an effort without both, or an empty or non-text route value. |

- **Fidelity, not judgment.** The audit measures whether requests carry a
  shown route and its effort, not whether the level was right: a 100 % match
  rate does not show that substantive work was never relabelled Mechanical.
- **Shortlist that ran.** Each counted request whose route a level shows
  (`match`, `retry`, `effort_mismatch`, `effort_omitted`) adds one to the
  level whose shortlist shows its exact provider and model, judged like the
  verdicts: prompt-visible (authorized) entries only, with the shortlists in
  force at the request, its effort ignored. A route that several levels show
  counts as `shared`. `inherit`, `malformed` and unlisted requests are not
  attributed (the unlisted verdicts already count them), so the four numbers
  add up to those four verdicts. This reports which level's shortlist the
  route that ran is on, **not** whether that level was right for the work: a
  request carries no level, none is inferred from the prompt or the
  `router:` line, and a shared route says nothing about the level meant.
- **Advisor-reserved children.** `subagent` requests whose child name is
  Advisor-reserved are counted apart, only while Router is on (the same window
  as the verdicts, so the numbers compare). They are never classified,
  attributed, part of the total or of discovery. Reserved children made with
  the other delegation tools are not counted.
- **Discovery.** `turns` counts the turns with at least one counted request
  (any verdict; reserved children do not count) while Router is on; `listed`
  counts how many of them had a `tool/call` to the tool named exactly
  `list_subagent_models` before the turn's first counted request. A list call
  after that first request comes too late for the turn. List calls are
  recorded whatever the mode, but count only for a turn with a counted
  request. A request or list call whose turn is no finite number is left out
  of discovery, never guessed (the request itself is still counted). Two
  caveats: `turns` counts changes of the turn number, not distinct values
  (requests in turns 5, 4, 5 count as three turns), and a list call logged in
  the same step as the request, just before it, counts as listed first even
  though its result could not have been read yet. The status line's "turns with
  routed requests" therefore includes turns that had only inherit or malformed
  requests.
- **Heuristics.** `retry` is an adjacency rule: two deliberate requests on one
  route in a turn, first with and then without an effort, also read as a
  retry, and only a request the audit counts breaks the adjacency. Requests
  are not paired with their results.
- **Per session, from the log.** The counts are a host-only projection of the
  session log: no file, setting or configuration. They replay from the log, so
  sessions that existed before this version are counted from their start. A
  fork child inherits its parent's log, so its counts start with the parent's.
  Of the requests themselves, only the last effort match is kept: its provider
  and model ids (cut to 200 characters), its effort id and its turn number;
  never a child's name, description or prompt. Besides the counts, the state
  keeps the session's authorized routes, the turn numbers of the latest
  `list_subagent_models` call and of the latest counted request, and the
  router state rebuilt from the same commands, with their selections and
  failure text, as the router projection already does.
- **Versions.** The audit embeds the router state, so a change to the router's
  state version must bump the `routerAudit` state version in the same change.
  The audit's own fields bump it too: `routerAudit` is at state version 2 (the
  per-level, reserved and discovery counts; the router stays at 5). A cached
  version-1 state no longer matches the state version, so the Host discards it
  and refolds the session log (the old shape would also fail the new schema), so
  earlier sessions get the new counts from their start.
- **Replay a log.** `packages/router/scripts/audit-replay.mjs` folds one
  session log through the same fold and prints one JSON object
  `{events, router: {mode, selections}, total, counts, levels, reserved, discovery}`:

  ```sh
  <decompress the session log> | node packages/router/scripts/audit-replay.mjs
  ```

  It reads JSONL from stdin only (decompress the log first), skips lines that
  are no JSON (`events` counts the lines it folded), and touches no file,
  network, clock or environment. It is a development tool in this repository:
  the package's `files` list does not include `scripts/`, so it is not
  published.
- **Not covered.** Subagent calls dispatched programmatically (from
  `run_code`) are logged as `tool/ptc-dispatch` events and are not counted. A
  call that names only an `agent_preset` counts as `inherit`, even when the
  preset pins a model. A command event without a time folds as time 0 where
  the router projection reads the clock, so the two could disagree about an
  update pending for five minutes or more; the Host always records a time.

### Before any enforce mode

There is no enforce mode, and none is built. One would be considered only when
all of these hold:

- at least 100 explicit-route requests over at least 10 sessions;
- `effort_mismatch` plus `unlisted_closed` at 2 % of them or more;
- a hand review of those requests finds no false positive;
- enforcement covers only those two verdicts;
- pairing a request with its `tool/result` is verified, or the retry rule is
  rewritten;
- the guard reuses this classifier, fails open, is injected optionally, is
  opt-in per session, and names the allowed entries in its denial.

## Jev auto mode

Jev auto routing is **not included**. `/router auto` returns an explanatory
error. This version is lead-only: no classifier, direct OpenRouter client,
route scoring, learning, retries, task graph, or second orchestration framework.

## Host updates

The installed package links to this directory. Restart DSH manually after Host
code changes; the existing Web URL and `app.asar` are left untouched.

## Tests

```sh
node --test packages/router/test/*.test.mjs
```

## License

MIT
