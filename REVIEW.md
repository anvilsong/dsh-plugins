# Review guidance

Rules for reviewing changes in this repository. They set focus and conventions;
they never excuse a critical or high defect.

## Invariants (a change that breaks one is a defect)

**Sessions manager (`packages/sessions`)**
- Only `purge` deletes, and only `<trashDir>/<batchId>`. Recovery never deletes
  and never moves a session toward the trash. Nothing else removes files.
- A prune moves whole session trees (a root with every descendant) or nothing;
  it is rename-only, manifest first, and never crosses a device (`cross-device`).
- Session logs are never opened or read. Facts come from metadata (`lstat`,
  the persistence snapshot). No agent tool, command or Remote method exposes a
  session's content.
- Prune refuses a tree while any session in it is loaded in the host, locked,
  recent, or part of a kept tree. Prune is available only where the lock probe
  works (macOS); elsewhere the page is read-only. Permanent delete is a separate
  step and can be switched off by `allowPermanentDelete`.
- Remote methods are owner-only. The trash folder must stay outside the
  sessions tree, and that is checked before the trash is used.

**Patched session search (`packages/session-search-patched`)**
- Rollback is bundle-level only. Never disable just the new row: the shipped row
  is disabled by the same patch and the group would be left empty.
- The guard requires the exact engine version and the pinned source hashes and
  falls back to the shipped class on any mismatch. A change to vendored files
  needs the hashes, the provenance note and the audit updated together.

**Model router (`packages/router`)**
- The audit is observe-only: it must not change a route, a model or an effort.
- The policy text is pinned by tests; wording changes need the tests updated on
  purpose.

**In-process Advisor (`packages/advisor`)**
- Child confinement fails closed: an unknown workspace, an unreadable name or a
  missing service must deny, never allow. Protected files (keys, credentials,
  `.env*` without templates) stay unreadable to children and evidence
  references. The list is best-effort; do not shrink it.
- Write scopes and evidence references share one path grammar. No globs in write
  scopes, no `..`, no absolute paths, no control, format or separator characters.
- A verdict exists only with its ledger id; replies are verified against the
  ledger hash.

**Code review (`packages/code-review`)**
- Read-only. Guidance comes from the pinned commit only, never the working tree.
  Patch and guidance text must not be able to close or open the workflow spec.
- The queued task carries the scope once; the prompts the agents receive must
  stay byte-identical to what the templates produce.

## Conventions

- Tests never touch the real profile, the real store or `~/.dsh`: use `mkdtemp`
  and decoy home variables. Destructive paths get crash-point and mutation tests.
- New packages do not name the external CLI helper or its script, and use no
  agent tools unless the package is about them.
- Commits use `feat:`, `fix:`, `docs:` or `test:`, one logical change each.
  Nothing is pushed to the upstream repository.
- Docs must match the code: a README or design claim that the code does not
  back is a defect, not a nit.

## Not worth flagging

- Wording, line wrapping and table layout in docs that are otherwise accurate.
- Style choices that the existing code already follows consistently.
- Missing features that `docs/*checklist.md` lists as out of scope for v1.
