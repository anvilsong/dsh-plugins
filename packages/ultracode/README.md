# dsh-plugin-ultracode

An opt-in exhaustive orchestration mode for DeepSeek Harness.

## What it does

`/ultracode` adds a per-session mode. While it is on, the agent is instructed to
be exhaustive within budget, with declared gaps, rather than optimize for speed
and token cost:

- Use available workflow or subagent orchestration for independent fan-out work.
- Use DSH AgentTeam for durable roles when team collaboration is enabled.
- Run one well-scoped fan-out per phase and synthesize results locally.
- Have material findings checked by an agent that did not produce them.
- Do not lower reasoning effort to save tokens.
- End every final answer with a `Not examined / not verified` section.

While it is off, the plugin adds no prompt text.

## Use

```text
/ultracode on
/ultracode off
/ultracode status
```

With no argument, `/ultracode` toggles the mode.

Ultracode does not enable or disable AgentTeam. Enable Team separately when
you want durable roles; the policy uses Team only when it is already enabled.

The composer also gets an **Ultracode** switch beside AgentTeam. It runs the
same command and shows the current state.

## State model

The mode is derived from the session's `command/run` and `command/done` log
entries. A successful `on` or `off` command changes the mode. An error leaves
the previous value unchanged. Resume, fork, and compaction therefore recover
the same state without a separate settings file.

## Delegation budget

While Ultracode is on, the prompt allows **at most 23 work delegations per turn**.
If any delegation occurred, the **24th delegation is reserved for a final
completeness critic**. The critic receives the original request and final result
(the draft to be sent), not worker transcripts. Every gap in its output must
appear in the final answer. The orchestrator may fix gaps inline, but may not
delegate again or drop them.

Every final answer must end with a `## Not examined / not verified` section. It
says `none` when empty. Otherwise it declares gaps from budgets, file or time
limits, and truncation, plus every gap in the critic's output.

The host guard still allows **24 direct delegation attempts** per turn. The bound
applies to the named delegation tools, not nested fan-out; nested work is
governed by DSH. Denied attempts count toward the budget. The 25th attempt is
denied with `ultracode_budget_exhausted:spawns`. The current run remains open
until turn end, even if Ultracode is turned off mid-run.

`/ultracode status` reports the current or last run's attempt count and stop
reason, without querying Team or starting another orchestration.

## Install

Install the package directory as a DSH bundle. The package declares a Host
entry and a Web client. It needs the `systemPrompt`, `sessionProjections`, `tools`,
and `commands` Host services, plus the conversation and API gateway Client services.

## Privacy and cost

The plugin itself sends no network requests and stores no credentials.
Orchestration can spawn many model calls, so enabling it can increase token
spend substantially. Use it deliberately on metered providers.

## License

MIT
