# dsh-plugin-ultracode

An opt-in exhaustive orchestration mode for DeepSeek Harness.

## What it does

`/ultracode` adds a per-session mode. While it is on, the agent is instructed to
be exhaustive within budget, with declared gaps, rather than optimize for speed
and token cost:

- Use available workflow or subagent orchestration for independent fan-out work.
- Use DSH AgentTeam for durable roles when team collaboration is enabled.
- Coordinate team members through messages and the task board, not by
  interrupting running members.
- Run one well-scoped fan-out per phase and synthesize results locally.
- Have every material finding checked by an agent that did not produce it and
  is told to refute it. Report only what survives, and label anything unverified.
- Run the project's cheap checks (tests, build, linter) before spawning
  reviewers, and show their output instead of claiming the work is done.
- Stop after three failing fix rounds on the same check or finding: report what
  remains and ask the user instead of looping.
- Use one reviewer, not stacked extras, and point later rounds at earlier
  findings and failures instead of re-checking everything.
- Do not narrow scope, skip verification, or lower reasoning effort to finish
  sooner. Work solo only on conversational turns or trivial mechanical edits.
- End every final answer with a `Not examined / not verified` section.

While it is off, the plugin adds no prompt text. These rules are prompt text;
see [Limits](#limits) for what is enforced.

## Use

```text
/ultracode on
/ultracode off
/ultracode status
/ultracode
```

With no argument, `/ultracode` toggles the mode, and its reply names the new
mode (`Ultracode on. …` or `Ultracode off. …`). Arguments ignore case and
surrounding spaces. Any other argument returns
`Usage: /ultracode [on|off|status]`. While another `on`, `off` or bare toggle is
pending, a new one is rejected with
`Ultracode is already updating. Try again after it finishes.` until that update
finishes or is five minutes old; `status` and a usage error are still answered.

Cached state: a bare `/ultracode` changed meaning in projection state version 5.
Sessions that logged one under an older build are rebuilt once from their log, so
such a command can now count as a toggle that the old state ignored.

Ultracode does not enable or disable AgentTeam. Enable Team separately when
you want durable roles; the policy uses Team only when it is already enabled.

The composer's model-options menu, where DSH's **Enable agent teamwork** switch
also sits, gets an **Ultracode** switch. It runs `/ultracode on` or
`/ultracode off` and shows the current state. An info button next to the label
shows a short description.

## State model

The mode is derived from the session's `command/run` and `command/done` log
entries. A successful `on`, `off` or bare toggle changes the mode. An error
leaves the previous value unchanged. The mode needs no separate settings file:
it is rebuilt by replaying the session log. Recovery after resume, fork and
compaction relies on DSH replaying that log; this package's tests check a
replay of the command history, not those host paths.

## Delegation budget

While Ultracode is on, the prompt allows **at most 23 work delegations per turn**.
If any delegation occurred, the **24th delegation is reserved for a final
completeness critic**. The prompt tells the agent to give the critic the
original request and final result (the draft to be sent), not worker
transcripts. Every gap in the critic's output must appear in the final answer.
The orchestrator may fix gaps inline, but may not delegate again or drop them.

The prompt also asks for every final answer to end with a
`## Not examined / not verified` section. It says `none` when empty. Otherwise
it declares gaps from budgets, file or time limits, and truncation, plus every
gap in the critic's output.

The host guard enforces a hard limit of **24 direct delegation attempts** per
turn. It counts calls to `subagent`, `subagent_fork`, `subagent_codex`,
`subagent_claude_code` and `spawn_teammate` made by this session's agent. It
does not count `workflow` calls, although one workflow can start many agents,
or `send_message`; calls made inside a delegated agent are not counted here.
Denied attempts count toward the budget. The 25th attempt is denied with
`ultracode_budget_exhausted:spawns`.

A run opens when a turn starts while Ultracode is on. It remains open until that
turn ends, even if Ultracode is turned off mid-run. The count starts again at
zero in every new turn, including a turn started by a subagent's completion
notice, so the guard does not cap the total delegations for one request. If you
turn Ultracode on during a turn, the guard applies from the next turn.

`/ultracode status` answers `Ultracode is on for this session.` or
`Ultracode is off for this session.`, followed, once a run exists, by the
current or last run's attempt count and stop reason. It does not query Team or
start another orchestration.

## Limits

- Only the host guard (24 delegation attempts per turn) is enforced.
  Everything else, including the critic reservation, the
  `Not examined / not verified` section, the three-round stop and the single
  reviewer, is an instruction in the prompt. The agent can ignore it, and
  nothing checks its answers.

## Requirements

- DeepSeek Harness with the Web GUI.
- The `@deepseek-ai/cordis` peer range in `package.json`.
- Loads and is active on DSH 0.2.2-rc.5; functional behaviour not re-verified
  on that release.

## Install

```sh
npm install
dsh plugin --profile <profile> add "$PWD/packages/ultracode"
```

Run both from the repository root. `npm install` is needed once: it installs
`zod`, which the Host entry imports. Replace `<profile>` with your profile
name; a name that does not exist creates a new profile. Restart the host and
refresh the page. `/ultracode status` should then answer
`Ultracode is off for this session.`

The package declares a Host entry and a Web client. It needs the
`systemPrompt`, `sessionProjections`, `tools`, and `commands` Host services,
plus the conversation, commands, primitives and API gateway Client services.

## Privacy and cost

The plugin itself sends no network requests and stores no credentials.
Orchestration can spawn many model calls, so enabling it can increase token
spend substantially. Use it deliberately on metered providers.

## License

MIT
