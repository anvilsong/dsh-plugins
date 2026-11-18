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
file/line, evidence, and a recommendation. Refuted findings are not shown, and
defects the change did not introduce are listed in their own section.

## What was reviewed

The command's reply and the first line of the report name what was reviewed:

```text
Reviewed: <sha7> (<branch>) + N changed files, state <12 hex>, captured when queued
```

HEAD is resolved once, when the command runs, and every later git call uses that
commit. The state is a SHA-256 over the sorted file manifest, one
`git diff -U0 <commit>` of the kept files, and git's object ids of the kept
untracked files, so the same working tree gives the same state. By design it
ignores the content of skipped files (sensitive, generated, binary or over
budget): they are listed, not reviewed. It is a snapshot taken when the review is
queued: edits made while the review runs are not detected, and nothing is
re-checked when the report is written. A patch review prints
`Reviewed: patch <12 hex>` (the start of the patch file's SHA-256), a repository
without commits prints `Reviewed: no commits yet`, and a directory outside git
prints `Reviewed: not a git review (no commit pin)`. Git is used only at the top
level of a repository: a workspace that git places inside another repository (for
example a subdirectory with an empty `.git`) is reviewed as a non-git workspace.

Each manifest file carries its changed line ranges on the new side, read from the
hunk bodies of that diff or of the patch (an `@@` header gives only the first
line; its counts are not trusted). Untracked, added, deleted and binary files
count as `all`, and so does a path that git quotes in diff headers.

Git runs with textconv, external diff helpers, fsmonitor hooks and local
`git replace` objects disabled, and `git hash-object` runs no filters. Counting can
run clean filters that the repository's `.gitattributes` selects (for example Git
LFS), as `git diff` and `git status` do.

## Owner guidance

A git review reads `REVIEW.md` and `CLAUDE.md` from the root of the pinned commit,
by object id (`git ls-tree`, then `git cat-file blob`), and never from the working
tree or the index. The change under review cannot add or edit the rules it is
reviewed by: a file absent at that commit gives no guidance, and a guidance file
the change adds or edits is reviewed as a file, never followed as instructions.

- Only regular files are read, not symlinks or submodules. A file over 256 KiB or
  containing NUL is skipped.
- HTML comments, control characters other than newline and tab, line and
  paragraph separators, and bidi and zero-width characters are removed. Each file
  is cut to 6,000 characters at a line end and marked `(truncated)`. Other
  markdown tricks are not removed, so guidance must be trusted owner text; it is
  still passed as data.
- The text is passed to the workflow once, as data, and appended to both finders
  and the refuter in every round. It sets focus and conventions. It cannot change
  the output schema, the read-only rule or the exclusions, and it cannot suppress
  a critical or high defect.
- The second report line names it: `Guidance: REVIEW.md@<sha7>, CLAUDE.md@<sha7>`
  or `Guidance: none (<reason>)`, for example `patch mode`, `not a git review`,
  `no commits yet`, `absent at base`, `too large` or `binary`.

Patch reviews, reviews outside git and repositories without commits get no
guidance. The pinned commit is trusted: a commit that edits `REVIEW.md` changes
the rules for the uncommitted work after it, and the printed SHA shows which rules
applied. This covers the review prompts; instruction files that the harness itself
may load into agents are outside this plugin.

## Pre-existing findings

The refuter decides whether a real defect was introduced by the change. A defect
the change did not introduce is `pre-existing` and needs a reason. A defect on an
unchanged line that the change causes or exposes is confirmed, and so is any
defect the refuter is unsure about. Finders do not label origin, and origin is not
part of a finding's fingerprint.

The workflow script then applies a floor: a pre-existing verdict becomes confirmed
when the finding's lines touch the file's changed ranges, when the file counts as
`all`, when the reason is empty, or when the review has no diff ranges (a
directory outside git).

The floor does not depend on how a finding spells its path. The path is resolved
against the reviewed directory, or the reviewed file's directory. If it matches no
manifest path exactly, every manifest or skipped file with the same file name,
compared without case, is a possible match, and every section of a path repeated
in a patch counts. A pre-existing verdict stands only when every possible match is
a file with known ranges that the finding's lines miss. A skipped file, an `all`
file, or a path that matches no file at all keeps the finding confirmed.

Pre-existing findings are reported under `Pre-existing (not introduced by this
change)` with their severity and reason. They are part of the round history, so
later rounds do not report them again, but they are not new confirmations: a round
that finds only pre-existing defects ends the review as `dry`.

A regression at a distance, such as a removed guard, shows on an unchanged line.
Only the refuter's judgement and the required reason stand between it and a
pre-existing label.

## Skipped files

Sensitive files, generated files, binaries, and over-budget files are skipped.
The host does not read sensitive file contents to build the manifest. The only
git call that covers a sensitive file is the scope-wide `--numstat`, which returns
line counts; such a file is never diffed with content, counted on its own, or
hashed. Patch mode sends only filtered patch hunks. These are path-based controls:
hardcoded secrets inside ordinary files are not detected, and the workflow's read
tools are not a security sandbox.

Guidance and patch text are escaped (`</` and `<workflow_spec`) so that they
cannot close the queued workflow spec or open another one.

## Limits

- Two independent finders and one refuter per non-empty round.
- Up to three rounds; a clean round stops as `dry`, while a third round with
  confirmed findings stops as `cap_reached` and reports that more may remain.
- Duplicate findings are not re-argued, and refuter output is limited to supplied IDs.
- A repeated defect pattern is reported once, at its first instance, with its
  class in `category`, the other locations in `evidence`, and a recommendation to
  fix every instance; the refuter refutes later instances as duplicates. This is a
  prompt rule: the tests check the wording, not that models follow it.
- Every round reviews the full scope; there are no diff-only rounds and no stored
  state between reviews.
- The queued task carries the scope, and in patch mode the whole patch, once, in
  `args.scope`. The finder and refuter prompts in the task are templates with one
  `{{SCOPE_JSON}}` placeholder, and the workflow script builds the real prompts
  from `args.scope` when it runs. The prompts the agents receive are unchanged;
  the task is about 1.1 times the size of the patch plus about 15 KB of fixed text
  (a 68 KB patch gave a 90 KB task; JSON escaping of a patch full of backslashes
  can add up to about 40%), which keeps a large patch relayable. A task that lost its scope or one of the placeholders
  fails before any agent starts; it never reviews with a blank scope.
- At most 50 files and 4,000 changed lines (added plus deleted). In a git
  workspace the counts come from `git diff --numstat` against the pinned commit,
  and git counts the lines of untracked files; the host does not read them. A
  rename counts as a deletion plus an addition. A file past either limit, or
  larger than 2,000,000 bytes in the working tree, is skipped as `over_budget`,
  so a large edit is listed, not reviewed. A file git reports as binary has no
  line count and is skipped as `binary`; this includes a text file that
  `.gitattributes` marks `-diff` or `binary`.
- Read-only: no code changes, tests that write, staging, or formatting.
- Uses the existing DSH workflow tool; no new orchestration framework.

The bound is enforced by the fixed review prompt, not by a new host scheduler.
The plugin is experimental.

## Install

Install the package directory as a DSH bundle. The host needs the `commands` and
`subprocess` services.

## License

MIT
