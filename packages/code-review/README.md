# dsh-plugin-code-review

Bounded code review for DeepSeek Harness. The plugin's own git calls change no
working-tree files, staged content or commits; the review agents are told not to
write (see [Limits](#limits)).

## Use

```text
/code-review [path]
```

With no path, the session's working directory is reviewed. A path is resolved
against that directory and must stay inside it after symlinks are resolved. A
path that starts with `-`, contains NUL, CR or LF, or is longer than 4,096
characters returns `Usage: /code-review [path]`.

- In a git repository whose top is the session's working directory, a directory
  reviews its changed files and the untracked files that git's standard ignore
  rules (such as `.gitignore`) do not exclude. A single file is reviewed only if
  it changed or is untracked.
- Outside git, which includes a session working directory below the top of a
  repository, a directory reviews every file under it, up to the limits below,
  and the host reads each counted file to count its lines. Every file that is
  not reviewed, including each file under a folder such as `node_modules`, is
  listed in the task, so a large tree can make the task large. A single file is
  reviewed whole, and its size is not counted against the limits.
- A `.diff` or `.patch` file reviews that patch. Only git-style sections
  (`diff --git a/<path> b/<path>`) are read, and their lines are counted from the
  patch's `+` and `-` lines. A patch in another format (for example plain
  `diff -u` output or `git diff --no-prefix`), or one whose files are all
  skipped, still queues a review with no files.

Outside patch mode, when nothing is reviewable the command fails with
`No reviewable files were found. Sensitive, generated, binary, and over-budget files are skipped.`

The command queues one user-visible review task. The task asks the main agent to
run exactly one workflow: in each of up to three rounds, two independent finders
(one for correctness, one for security) and, when they report new candidates,
one refuter. Findings include severity, file/line, category, evidence, and a
recommendation. Refuted findings are not shown, and defects the change did not
introduce are listed in their own section. Findings the refuter could not verify
are listed under Unverified, followed by the skipped files and one line of stats.

If a finder or the refuter fails, or returns output that breaks the schema (for
example a `line` array that is not exactly `[start, end]`, an extra field, or a
missing or unknown verdict ID), the whole review fails and is reported as
failed. It is never called dry, and findings from earlier rounds are not
returned.

## What was reviewed

The command's reply and the first line of the report name what was reviewed:

```text
Reviewed: <sha7> (<branch>) + N changed files, state <12 hex>, captured when queued
```

N counts the files kept for review; skipped files are not counted.

HEAD is resolved once, when the command runs, and every later git call that reads
a commit uses that commit; the branch name is read from HEAD at the same time.
The state is a SHA-256 over the sorted file manifest, one
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
  and the refuter in every round. It sets focus and conventions. The workflow
  script enforces the output schema, so guidance cannot change it. The prompts
  tell the agents that guidance cannot change the read-only rule or the
  exclusions and that it cannot suppress a critical or high defect; nothing
  checks that.
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

Sensitive files, generated files, binaries, over-budget files and file names with
control characters (skipped as `unsafe_name`) are skipped. The name checks look at
the workspace-relative path, or in patch mode the path in the patch, and its file
name, ignoring case:

- Sensitive: `.env` or `.env.*`; a name ending in `.pem`, `.key`, `.p12`, `.pfx`,
  `.keystore`, `.tfstate` or `.tfvars`; a file name starting with `id_rsa`,
  `id_ed25519`, `credentials`, `secret.` or `secrets.`; a file named `.npmrc` or
  `.netrc`; and a path that starts with `.ssh/` or `.aws/`. A `.ssh` or `.aws`
  folder deeper in the tree is not matched as a folder.
- Generated: a path with a `node_modules`, `dist`, `build`, `coverage`, `.next`,
  `.turbo`, `target`, `vendor`, `out`, `tmp` or `temp` segment; the lockfiles
  `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Cargo.lock`,
  `composer.lock`, `Gemfile.lock`, `go.sum` and `poetry.lock`; and a path that
  contains `.min.js`, `.map` or `.generated.` anywhere. That last match is not
  anchored to the end of the name, so it also skips source files such as
  `user.mapper.ts`, `data.mapping.js` or `foo.min.json`.
- Binary by extension: `png`, `jpg`, `jpeg`, `gif`, `webp`, `pdf`, `zip`, `gz`,
  `exe`, `dll`, `so`, `dylib`, `bin`, `wasm`, `mp4`, `mp3`, `woff`, `woff2`,
  `ttf`, `otf` and `ico` files are skipped with the reason `generated`. A file git
  reports as binary is skipped as `binary` (see [Limits](#limits)).

The host does not read sensitive file contents to build the manifest. The only
git calls that cover a sensitive file are the scope-wide `--numstat`, which
returns line counts, and `git ls-files`, which lists untracked file names (and,
in a repository without commits, tracked ones); such a file is never diffed with
content, counted on its own, or hashed. Patch mode sends only filtered patch hunks. These are path-based controls:
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
  from `args.scope` when it runs, so the agents receive the full prompts with the
  scope filled in. The task is about 19 KB of fixed text plus the JSON-escaped
  scope: a 70 KB test patch of ordinary code gives a 91 KB task. JSON escaping
  adds one byte for each line break, quote, tab or backslash, so ordinary code
  grows by a few percent and a patch full of backslashes can nearly double. This
  keeps the task much smaller than repeating the patch in every prompt. A task
  that lost its scope or one of the placeholders fails before any agent starts;
  it never reviews with a blank scope. The task tells the model to leave
  `{{SCOPE_JSON}}` as written.
- There is no byte cap on the task. The model must pass it to the workflow in one
  call, and the largest size it can relay reliably has not been measured. A
  309 KB task is reported not to have worked; no test or log in this repository
  records it. A task over 150 KB is named in the command's reply, with the advice
  to split the patch (for example by file).
- At most 50 files and 4,000 changed lines (added plus deleted). In a git
  workspace the counts come from `git diff --numstat` against the pinned commit,
  and git counts the lines of untracked files; the host does not read them. A
  rename counts as a deletion plus an addition. A file past either limit, or
  larger than 2,000,000 bytes in the working tree, is skipped as `over_budget`,
  so a large edit is listed, not reviewed. A file git reports as binary has no
  line count and is skipped as `binary`; this includes a text file that
  `.gitattributes` marks `-diff` or `binary`.
- Read-only by instruction: the prompts forbid code changes, tests that write,
  staging, and formatting. The review agents keep the session's normal tool
  permissions, so nothing enforces this. The plugin's own git calls are queries
  (`rev-parse`, `symbolic-ref`, `diff`, `ls-files`, `ls-tree`, `cat-file`, and
  `hash-object` without `-w`); like any `git diff`, they may refresh git's cached
  file status in the index.
- Uses the existing DSH workflow tool; no new orchestration framework.

The bound is enforced by the fixed review prompt, not by a new host scheduler.
The plugin is experimental.

## Requirements

- The `commands` and `subprocess` Host services.
- The `git` command, for reviews inside a git repository.
- DSH's `workflow` tool, available to the session's agent: the queued task asks
  the agent to call it.

No DSH release is recorded in this README as verified for this package.

## Install

```sh
npm install
dsh plugin --profile <profile> add "$PWD/packages/code-review"
```

Run both from the repository root. This package has no dependencies of its own;
`npm install` installs those of the other packages in the repository. Replace
`<profile>` with your profile name; a name that does not exist creates a new
profile. Restart the host after installing.

## License

MIT
