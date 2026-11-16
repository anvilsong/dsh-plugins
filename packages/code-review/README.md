# dsh-plugin-code-review

Bounded, read-only code review for DeepSeek Harness.

## Use

```text
/code-review [path]
```

With no path, the current workspace is reviewed. A directory reviews its changed
or untracked files. A `.diff` or `.patch` file reviews that patch.

The command queues one user-visible review task. The main agent runs exactly one
workflow with two independent finders and one refuter. Findings include severity,
file/line, evidence, and a recommendation. Refuted findings are not shown.

Sensitive files, generated files, binaries, and over-budget scopes are skipped.
The host does not read sensitive file contents to build the manifest. Patch mode
sends only filtered patch hunks. These are path-based controls: hardcoded secrets
inside ordinary files are not detected, and the workflow's read tools are not a
security sandbox.

## Limits

- Two independent finders and one refuter per non-empty round.
- Up to three rounds; a clean round stops as `dry`, while a third round with
  confirmed findings stops as `cap_reached` and reports that more may remain.
- Duplicate findings are not re-argued, and refuter output is limited to supplied IDs.
- At most 50 files and 4,000 changed lines.
- Read-only: no code changes, tests that write, staging, or formatting.
- Uses the existing DSH workflow tool; no new orchestration framework.

The bound is enforced by the fixed review prompt, not by a new host scheduler.
The plugin is experimental.

## Install

Install the package directory as a DSH bundle. The host needs the `commands` and
`subprocess` services.

## License

MIT
