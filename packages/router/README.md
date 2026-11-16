# dsh-plugin-router

Opt-in lead-controlled model routing with three session-scoped complexity-level
shortlists for ordinary DeepSeek Harness subagents.

## Use

```text
/router manual
/router on        # alias for manual
/router off
/router status

/router level mechanical inherit
/router level ordinary inherit
/router level hard inherit
/router level mechanical <provider>/<model>[,<provider>/<model>...]
/router level ordinary <provider>/<model>[,<provider>/<model>...]
/router level hard <provider>/<model>[,<provider>/<model>...]
```

The model-options menu has one **Model router** switch followed by three
native-style menu cells: **Mechanical**, **Ordinary**, and **Hard judgment**.
Each cell shows its current choice (for example `Inherit` or
`deepseek-flash-latest +1`); the cells stay in place, dimmed, while Router is
off, so the menu does not shift and levels can be prepared in advance. Selecting
a cell, or pressing ArrowRight on it, opens a side flyout drawn with the host
menu material: a one-line description of the level, **Inherit (session
default)**, then the authorized models grouped by provider with a trailing
check on each selected model. Edits are a draft while the flyout is open and are
committed as one `/router level` command when it closes (or when the menu
closes), so each edit session adds one command entry to the chat. The cell shows
a spinner until the session confirms the change. Up to four models per level;
further rows are disabled. Saved routes that are no longer authorized appear
under **Unavailable** and are dropped by the next change. Escape, Tab, or
ArrowLeft closes the flyout and returns focus to its cell. Rejections recorded
in the session log (for example "Router is already updating") appear in the
composer's toast.

Selections are session-scoped and retained across off/on. Every level defaults to Inherit. Invalid or unauthorized
routes reject the whole command without changing the selection. Null route
policy means Inherit-only. Saved DSH route-policy changes apply only to new
Sessions.

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
- **Effort is separate.** Mechanical uses `low` only when advertised, Ordinary
  uses the route default, and Hard judgment uses the highest advertised effort
  only when useful. Unsupported effort is omitted.
- **Failure is visible.** Discovery failure, no models, or an unauthorized
  preferred route produces `router: inherit — route discovery unavailable or
  unauthorized` and omits route fields. Explicit-route spawn failure has no
  silent fallback. There are no model retries or mid-run route changes.
- **Other backends are unchanged.** Discovery and `router:` lines apply only to
  ordinary fresh in-process `subagent` calls. Advisor-reserved verifiers never
  use these shortlists; they keep Advisor's own Inherit-or-explicit selection.

Before each delegation the lead states:

```text
router: <level> → <provider>/<model> because <criterion>; effort: <low|default|highest-advertised>
```

or `router: inherit — no clear route advantage`.

`/router status` reports the current mode and all three selections; while an
update is pending it reports only which target is updating.

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
