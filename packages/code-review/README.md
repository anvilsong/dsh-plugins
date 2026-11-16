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
The host does not read sensitive file contents to build the manifest.

## Limits

- Two independent finders and one refuter.
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
