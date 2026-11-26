# Review: `/model-discovery seed` (task-176, plan 3a4db7730b1e T2)

Reviewer: `md-seed-review`, 2026-11-25. Adversarial review of the uncommitted T2 change
in `src/discovery.js` and `src/index.host.js` and the new `test/seed.test.mjs`.

Method:

- Diffed the package against the snapshot `/tmp/md-snapshot-20261125-181901`.
- Ran every test: 87 pass on Node 24.22.3.
- Ran reproductions and 28 mutants on a temporary copy (`/tmp/md-review-IPQ7Th`).
- Read DSH 0.2.2-rc.5 sources, extracted read-only from `app.asar`:
  `dsh-config-editor/src/index.ts`, `dsh-llm-pi-ai/src/{catalog,adapter,config}.ts`, and
  the bundled pi-ai 1.3.0 `dist/model-catalog.js`, `dist/models.js` and
  `dist/providers/data/openrouter.json`. The bundled file is byte-identical to
  `/tmp/or-1.3.0.json`.

No live Host call, no network access, no profile read or write.

Verdict:

- **The safety invariant holds.** I found no path that converts a provider without a
  typed preview and then a typed confirm.
- **No blocker.**
- **One high finding:** a command that the plugin suggests itself can list ids on the
  wrong protocol and base URL. The planned rollout command is not affected.
- **Several medium and low findings.**

## 1. Safety invariant

Checked; no path found.

- **Timer and first check:** `fire` (`index.host.js:560-574`) calls only `sync(false)`.
  `planProvider` still refuses a provider with no list or an empty list
  (`discovery.js:261-263`, unchanged).
- **`status`:** reads state only (`index.host.js:543-546`).
- **Other commands:** only `seed` reaches `runSeed`. The handler checks the words
  exactly (`index.host.js:516-523`).
- **HMR, config reload or re-apply:** each `apply()` builds a new `state`, and
  `previews` starts empty (`index.host.js:229-237`). After a re-apply, a confirm answers
  "There is no preview…".
- **A seed edit does not re-apply this plugin.** `configEditor` reconciles only the
  edited `llm-pi-ai` row (`config-editor/src/index.ts:143`). The plugin reads `llm` at
  call time and does not inject it.
- **A stale preview cannot write a stale plan.** The preview is consumed before any
  work (`index.host.js:452-454`). The confirm re-reads the served list, npm, unpkg and
  the config (`index.host.js:459`), and compares signatures (`:466`). The editor then
  re-plans from the config it reloaded from disk and compares again (`:469-476`,
  `config-editor/src/index.ts:96-100`).
- **Gaps (low):**
  - The signature omits `routeApi` (`discovery.js:482`). See F8: the preview line
    "Route api" can be out of date, but nothing is written to `api` in that case.
  - A preview has no expiry and no session binding. Anyone in the same process who can
    run commands can confirm it, but the write still equals a freshly computed plan.

## 2. Protocol filter

- **`catalogProtocols` matches `mapCatalog`.** On the real 1.6.1 OpenRouter catalog
  (4 groups, including `openrouter-images` and `typesafe-system-one`):
  - it returns 412 chat ids;
  - it agrees with `mapCatalog.apis` on all 304 accepted ids;
  - it excludes image and classifier entries;
  - the 5 ids that both a chat entry and an image entry use (for example
    `openrouter/auto`) keep their chat protocol (R11).
- **`mapCatalog`'s order is not pi-ai's order (F2).** pi-ai flattens with
  `Object.fromEntries` over every group (`pi-ai dist/model-catalog.js:1-6`). For a
  duplicated chat id, the **last** entry wins, and pi-ai uses the entry's own `api`
  field, not the group key. `catalogProtocols` keeps the **first** entry and requires
  `api === group` (`discovery.js:338-340`). This was reproduced with pi-ai's own
  function (`dup.mjs`): for id `x` in completions first and anthropic last, pi-ai
  resolves `anthropic-messages` at `https://openrouter.ai/api`, but
  `seed … openai-completions` lists `x`. The four real catalogs (OpenRouter 1.3.0 and
  1.6.1, anthropic, kimi-coding) have 0 duplicates, 0 entries with `api` ≠ group, and
  0 disagreements with pi-ai today.
- **Order:** the written list keeps `listModels` order (`discovery.js:460-469`).
  Mutant M21 (sorted) is killed by 6 tests.
- **Wrong protocol or base URL (F1).** DSH resolves
  `api = request.api ?? base?.api` and `baseUrl = request.baseURL ?? base?.baseUrl`
  (`dsh-llm-pi-ai/src/catalog.ts:918,923`). The route `api` wins for every listed id,
  and the base URL stays that of the **installed** entry. The seed judges protocols by
  the **latest** catalog.
  - 4 aliases moved from `openai-completions` (1.3.0) to `anthropic-messages` (1.6.1):
    `~anthropic/claude-fable-latest`, `~anthropic/claude-haiku-latest`,
    `~anthropic/claude-opus-latest`, `~anthropic/claude-sonnet-latest`.
  - `seed openrouter anthropic-messages` lists 19 ids. The 4 aliases are among them,
    while their installed entries point at `https://openrouter.ai/api/v1`. DSH would
    send the Anthropic body to the completions base URL, with the completions-shaped
    `compat` carried along by `...base`.
  - The refusal for several protocols prints this command itself
    (`discovery.js:454`).
  - `seed openrouter openai-completions` (the rollout command) lists 326 ids. None of
    them has an installed group other than completions (verified). It **leaves out**
    the 4 aliases, which DSH serves correctly on completions today.
- **Edge cases checked:** ids failing `MODEL_ID` and duplicates are left out in both
  modes. Absent ids are left out under `<api>`. A non-object catalog is an error.
  - **Empty or foreign catalog (F5).** In no-api mode, a `{}` catalog, or one whose
    entries all name another provider, counts as "one protocol". The seed then lists
    every id (R9). There is no routing harm, because no `api` is written.

## 3. Fail-closed completeness

Every refusal in acceptance (5) returns kind `error`, and the tests assert
`h.edits.length === 0` for each one. Refusals and gaps that the code or the tests miss:

- **F4, zero ids.** If every served id fails `MODEL_ID`, the no-api confirm writes
  `models: []` and reports "Seeded … wrote 0 ids" (R10). That is one pointless rewrite
  of the `llm-pi-ai` block, which also drops its comments. DSH treats `[]` as absent
  (`catalog.ts:865-868`), so routing does not change.
- **F5, empty catalog.** See section 2.
- **Missing credential (S3).** `listModels` returns `[]` on `MISSING_CREDENTIAL`
  (`adapter.ts:350-353`). The refusal "DSH serves no models for provider X" gives no
  hint about credentials.
- **The lock:** `seed` and `sync` share it inside one `apply()` closure
  (`index.host.js:409,525-526`), and the tests cover both directions.
  - **Per-closure lock (F9).** The lock is not shared across closures: a seed or sync
    still running from a disposed closure does not block a new closure (R5). Writes
    stay safe: `configEditor` serializes them with a file lock and `hmr.runExclusive`
    (`config-editor/src/index.ts:93,152`), and the edit re-plans inside its callback.
- **Hangs:**
  - `listModels` is bounded (`index.host.js:431-435`), and each fetch is bounded by
    `fetchJson`.
  - `configEditor.edit` has no bound (S1). A hung edit holds `state.running` until
    restart. Sync has the same exposure.
- **F10:** a `sync` during a seed replies "already syncing" (`index.host.js:409`).

## 4. Race and atomicity

- **The edit callback writes nothing on error.** The editor calls `change()` before
  `fiber.resolveConfig()` and before writing the file. If reconciliation fails after
  the write, the editor restores the old file (`config-editor/src/index.ts:100-103,
  141-147`). So an exception in the callback writes nothing, and there is no partial
  write.
- **Provider or row removed mid-confirm.** The re-plan refuses a removed provider
  ("not configured", tested). The editor rejects a removed row with "Configuration
  entry is no longer available" (`config-editor/src/index.ts:94`).
- **Receipt failure.** It is caught, and the reply says so (`index.host.js:483-498`,
  tested). No code after the edit can throw into the "nothing was written" branch.
- **Test gap (M18).** No test changes an *unrelated* provider or top-level key between
  the preview and the edit. Merging into a stale config survives all 87 tests. The code
  is correct today: it merges into `current`.

## 5. Data safety

- **Receipt contents.** The receipt holds provider, row id, version, `apiAdded`,
  counts, left-out lines, undo and `seededAt`. It holds no credential or config value
  (tested with a sentinel).
- **Modes.** The file is 0600 and a new folder 0700 (tested). R3 confirmed that no
  `.tmp` file is left after a failed rename.
- **Left-out lines** are safe: ids match `MODEL_ID`, invalid ids pass through `clean`,
  and reasons use `clean`.
- **F3, unsanitized preview.** The preview prints raw catalog group keys
  (`index.host.js:188`). A catalog whose group key contains `\n` or U+202E injects a
  forged line into the text that the user reads before confirming (R1). `apiLine`
  prints the configured `routeApi` raw (`index.host.js:179`, low).
- **F7, absolute path.** The success reply prints the absolute receipt path
  (`index.host.js:495`), and a failure prints the absolute `.tmp` path (`:497`, R2/R3).
- **F6, receipt cap.** The receipt keeps at most 200 lines, because `statusValue` caps
  arrays at 200 (`index.host.js:152`). With more than 200 left out, the line "and N more
  left out" is dropped (R2). `leftOutCount` is kept.
- **F11 (suspected).** The receipt sits in the folder that all profiles share
  (README:238), and it does not name the profile.

## 6. Sync unchanged

- **Behaviour.** The diff against the snapshot adds 171 lines to `discovery.js`, with
  nothing removed. `index.host.js` changes only:
  - the `join` import and 4 new imports;
  - the `USAGE` text, the `HINT` text and the `seed` dispatch.

  `runSync`, `mapCatalog`, `planProvider` and `expectedApi` are byte-identical.
- **Tests.** The pre-existing test files are byte-identical to the snapshot, and their
  63 tests pass. The index (staged) copies of `src` equal the snapshot. The T2 changes
  are unstaged, and `seed.test.mjs` is untracked.
- **The only behaviour changes for sync:**
  - the lock is shared with seed;
  - the usage text is longer.

## 7. Mutation results

28 mutants were run against all 4 test files (`mutate.mjs`). 25 were killed and 3
survived.

| mutant | result |
|---|---|
| M1 drop the pre-edit signature compare | killed (2) |
| M2 drop the in-edit signature compare | killed (1) |
| M3 in-edit refusal returns `current` instead of throwing | killed (1) |
| M4 preview never consumed | killed (1) |
| M5 no-preview check removed | killed (1); the signature compare alone would still refuse |
| M6 ids absent from the catalog listed under `<api>` | killed (9) |
| M7, M8, M9 `catalogProtocols`: api ≠ group / later duplicate wins / non-chat counted | killed (2 each) |
| M10 refusal for several protocols needs > 2 | killed (2) |
| M11, M12, M13, M28 refusals: models length, `modelOverrides`, api mismatch, `[]` | killed |
| M14, M23, M24 `listModels`: > 2000, foreign provider, no timeout | killed |
| M15 seed takes no lock | killed |
| M16, M17 receipt mode 0644, receipt failure fails the seed | killed |
| M20, M21, M22, M25, M26 | killed |
| **M18** merge into a stale config base | **survived** |
| **M19** early `seedPrecheck` removed (fetches before refusing) | **survived** |
| **M27** version removed from the signature | **survived** (the version test passes only because a left-out reason quotes the version) |

- **Real shape.** Every seed test uses toy two-group fixtures plus one `embedding`
  entry. None uses the real four-group OpenRouter shape, chat and image entries that
  share an id, or the drift between 1.3.0 and 1.6.1.

## 8. What the T3 docs must say to be true

1. **Grammar and preview.** `/model-discovery seed <provider> [<api>] [confirm]`. The
   input is lowercased, and `<provider>` and `<api>` match `[a-z0-9][a-z0-9-]*`. A
   preview writes nothing.
2. **Confirm.**
   - It needs a preview of the same provider and `<api>` in the same process. It
     consumes the preview, even when the confirm fails.
   - A restart or plugin reload drops every preview.
   - The plan is recomputed, and the confirm refuses with "The plan now differs from
     the preview…" or "the plan differs from the preview when the edit ran".
3. **Outcomes.**
   - **No `<api>`, route sets `api`:** every valid served id is listed, and no `api` is
     added.
   - **No `<api>`, one protocol or none:** every valid served id is listed, including
     ids that the latest catalog lacks, and no `api` is added.
   - **No `<api>`, several protocols:** an error with per-protocol counts and the
     commands to run.
   - **With `<api>`:** `api` is written (unless the route already sets it), and only
     ids whose latest-catalog protocol is `<api>` are listed.
4. **Left-out rules.** These ids are left out and named, at most 200 in the reply and
   the receipt:
   - an id that fails the id pattern;
   - a duplicate in the served list;
   - under `<api>`: an id absent from the latest catalog ("not a chat model of
     <provider> in the latest pi-ai catalog (<version>)", which also covers ids that
     pi-ai removed);
   - under `<api>`: an id in another protocol.
5. **Failure modes, stated with the real example.**
   - Protocols are judged from the **latest** catalog, while DSH routes from its
     **bundled** catalog plus the route `api`.
   - An id whose group changed is either lost (`seed openrouter openai-completions`
     leaves out the 4 `~anthropic/*-latest` aliases that work today) or misrouted
     (`seed openrouter anthropic-messages` lists them with the v1 base URL).
   - Duplicated chat ids are judged by the first entry, while pi-ai uses the last.
6. **Every refusal text**, exactly as in `discovery.js:376-398,449,455` and
   `index.host.js:456,467,474,512,524-525`:
   - "already lists models; seed only converts…";
   - "has modelOverrides, which DSH refuses together with models…";
   - "<api> differs from the provider api setting…";
   - "no served model uses <api>…";
   - "llm.listModels did not answer within N ms";
   - "DSH serves no models…": this one also appears when the credential is missing;
   - "DSH serves more than 2000 models…";
   - the row errors from `pickLlmEntry`;
   - "Model discovery is already running a sync or a seed.";
   - "Model discovery is disabled by its config: …".
7. **Receipt.**
   - Path: `$DSH_HOME/model-discovery/seed-<provider>.json`, mode 0600.
   - The folder is shared by all profiles, and a later seed of the same provider
     replaces the file.
   - The fields, and that it stores no config values.
   - A failed write keeps the seed.
8. **Undo.** Remove `models`, and `api` when the seed added it, or restore the backup.
   Note that `configEditor` drops comments in the `llm-pi-ai` block.
9. **Live facts.**
   - **Not verified on a live Host:** what `llm.listModels` returns.
   - **From source:** it maps the materialized chat models of the route, and returns
     `[]` while the route's credential is missing (`adapter.ts:346-362`,
     `pi-ai dist/models.js:571`).
   - **No maximum list length:** DSH's schema sets no limit on `models`
     (`config.ts:360`).
10. **Corrections to `docs/model-discovery-checklist.md`.**
    - Lines 99-101 state the move backwards: the 4 aliases moved **from**
      `openai-completions` **to** `anthropic-messages`.
    - Lines 29 and 107: the served left-out set under `openai-completions` is
      19 `anthropic-messages` ids plus 51 removed ids, 70 in total, not 20 + 51.
    - The listed count is 326, assuming the served set equals the 396 bundled chat ids.
    - Rollout step 2 adds `anthropic` and `kimi-coding` to `providers`. Unless those
      routes already list models, sync refuses them, so they need `seed anthropic` and
      `seed kimi-coding` first. Each is a single protocol, so no `api` is written.
