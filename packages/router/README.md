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
  recommendation is applied only when a model that is not in the saved level is
  checked in the flyout; re-checking a model in the same opening restores the
  effort it had. Saved entries, typed commands, and loading the menu never get
  a default. Per level:

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
  an entry without an effort now means the model's own default. Saved lists
  are not changed retroactively; add efforts to their entries to keep the old
  behaviour.

`/router status` reports the current mode and every level's entries in
command form (`<provider>/<model> effort=<id>`), marking entries whose route is
no longer authorized with `(unavailable)`; while an update is pending it
reports only which target is updating.

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

## Routing rules

- **Ordinary is the default.** Mechanical requires all three: fully specified
  work, no judgment, and a deterministically checkable result. Hard judgment
  requires verification/judgment or high ambiguity with costly-to-undo output.
  Doubt never resolves downward.
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
