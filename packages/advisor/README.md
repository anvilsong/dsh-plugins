# dsh-plugin-advisor

Opt-in advisor consultations for DeepSeek Harness.

## Use

```text
/advisor on
/advisor off
/advisor status
```

The model-options menu also has an **Advisor** switch. The toggle changes only
this session's policy; it never calls a model by itself.

While enabled, the agent is instructed to use the existing `advisor` skill at
major planning, design, and substantial review steps. It must reload the skill
before consulting, sanitize briefings, and verify verdicts by ledger consult ID.
Direct `subagent_claude_code` or `subagent_codex` calls are not substitutes.

`/advisor status` shows the current state and the last three ledger entries.

The plugin is experimental. Consult frequency and sanitization are governed by
the policy and the advisor skill, not by a new orchestration framework.

## License

MIT
