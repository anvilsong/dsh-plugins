# Verification (S7): the generated engine JS at an rc.3 checkout

This file proves that the JavaScript that ships, `src/engine/index.js` (generated from
`vendor/src/*.ts`, docs/build-audit.md), passes the rebased engine spec against the rc.3 sources,
keeps both failure modes of the engine, returns the same hits as the shipped rc.3 engine and
bounds its heap. Recorded on 2026-11-18 with node v24.22.3 on macOS (darwin-arm64, 16 cores,
128 GB). Paths without a leading `/` are relative to `packages/session-search-patched`.

Engines compared:

| Name | What | Identity |
|---|---|---|
| **generated** | `src/engine/index.js` of this package, loaded in place | sha256 `bef011ff…5037f9` (`src/engine/manifest.json`, checked by C2) |
| **shipped** | rc.3 `packages/session-query/session-query-sqlite/src/index.ts` of the checkout | sha256 `72868e4a…48b8d3`, equal to the installed app's copy (vendor/PROVENANCE.md); the suite skips any other checkout |
| shippedLib (optional) | the installed app's compiled `lib/index.js`, extracted from app.asar | sha256 `dbecf833…dfe70a0`; enabled by `SSP_RC3_EXTRACT=<folder>` |

All engines run on the rc.3 cordis, session store, projections and JSONL backend of the checkout:
`loadUpstream()` (test/upstream/upstream-lib.mjs) registers the checkout's tsx with its tsconfig
paths, which also resolve the bare imports of the generated file, and asserts one module instance
per base class (`Object.getPrototypeOf(Engine) === SessionQueryEngine` of the checkout, `instanceof`
its cordis `Service`) and that only the generated engine has the patch methods. Engine row config
everywhere: `{ path: ':memory:', openAt: 'first-search', persistedReadConcurrency: 1 }` (the bundle
row, composition-spike.md §4).

## 1. Result per criterion

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Without `DSH_UPSTREAM_DIR`: one skipped test, exit 0 | **holds**: `tests 1, skipped 1, pass 0, fail 0`, exit 0 | §3 |
| 2 | Rebased spec against the generated JS at rc.3 passes | **holds**: `sqlite.spec.ts` 92 passed / 0 failed / 0 skipped, plus 1 identity test; control run on the pristine rc.3 source: 15 of the 92 fail | §4 |
| 3 | Appending session: shipped fails with `SESSION_QUERY_PERSISTENCE_FAILED`, generated succeeds and re-reads only the changed session | **holds** for a stored and a live-owned appending session, 8 and 32 sessions, read counters per session id | §5 |
| 4 | Unknown non-ignorable event type: same code and message from both, process stays alive | **holds**: same code, message and cause in this process and in separate processes, which exit 0 with no unhandled rejection | §6 |
| 5 | Same hits on ≥ 50 sessions, ≥ 20 queries | **holds**: 60 sessions, 29 queries (CJK, phrase, filters, paging cursors, no hit), every page deep-equal | §7 |
| 6 | Peak heap of the generated engine under ≥ 2 caps on the largest store, next to the shipped figure | **holds**: 7 caps on a 1.126 GB synthetic store and 5 caps on the 691 MB copy of the real store | §8 |
| 7 | The suite never reads the real DSH home | **holds**: decoys empty after the run; 12 forbidden store paths refused with 0 file-system calls inside `~/.dsh` / `~/.local/state` | §9 |

Suite with `DSH_UPSTREAM_DIR` at the rc.3 checkout: **9 tests, 9 pass, 0 fail**, about 22 s; with
`SSP_RC3_EXTRACT` (third engine) also 9 / 9, about 25 s (§3).

## 2. Setup: rc.3 checkout

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
git -C /Users/macbook/projects/deepseek-harness worktree add --detach /tmp/dsh-rc3-s7 dsh-v0.2.2-rc.3   # HEAD 38a6a5c965
cd /tmp/dsh-rc3-s7
pnpm install --frozen-lockfile --ignore-scripts --prefer-offline    # pnpm 11.28.5 from packageManager; 6.5 s, from the store
mkdir -p native/system/packages/darwin-arm64/bin                    # the JSONL session lock needs the native addon
cp "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node" \
   native/system/packages/darwin-arm64/bin/                         # sha256 6c89a8ca…4c4b30, as in S2
./node_modules/.bin/vitest run packages/session-query/session-query-sqlite    # baseline: Tests 70 passed (70)
git --no-optional-locks status --porcelain                          # empty: the addon path is ignored
```

No tracked file of the checkout is modified. The suite writes into it only one scratch folder per
vitest run (§4), removed afterwards; `git status` is compared before and after.

## 3. The suite

Files (all in `test/upstream/`; only `*.test.mjs` is a test file, the other two do nothing when
imported or run without arguments):

| File | Role |
|---|---|
| `engine-upstream.test.mjs` | the optional suite (tests C2–C7) |
| `upstream-lib.mjs` | loading, real-home guard `assertScratchStorePath()`, contexts, read counters, store writers, the 29 queries, the vitest config and identity spec written for C2 |
| `engine-probe.mjs` | probe script: `generate` (synthetic stores), `heap` (one engine, one process), `matrix` (engines × caps, one child each, `--trace-gc`), `unknown-type` (C4 child) |

Skip rules (`upstreamSkipReason()`): `DSH_UPSTREAM_DIR` unset; Node < 24.9; a missing file of the
checkout (tsx, tsconfig, vitest, the rc.3 sources the suite loads, the native addon); or engine
sources whose sha256 is not rc.3's. Each gives the single skipped test.

```
$ env -u DSH_UPSTREAM_DIR node --test packages/session-search-patched/test/upstream/*.test.mjs; echo "exit=$?"
﹣ generated engine against the rc.3 checkout: spec and failure scenarios (C2-C7) (0.2465ms) # DSH_UPSTREAM_DIR is not set (optional rc.3 engine experiments)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
exit=0
```

Other skips seen: `DSH_UPSTREAM_DIR=/Users/macbook/projects/deepseek-harness` (the clone on
`fix/session-search-bounded-index`) → `# DSH_UPSTREAM_DIR is not the rc.3 checkout: packages/session-query/session-query-sqlite/src/index.ts has sha256 26e33a2bafad…, rc.3 has 72868e4ae967…`;
`DSH_UPSTREAM_DIR=/nonexistent/dir` → `# DSH_UPSTREAM_DIR lacks node_modules/tsx/dist/esm/api/index.mjs`.

```
$ DSH_UPSTREAM_DIR=/tmp/dsh-rc3-s7 node --test packages/session-search-patched/test/upstream/*.test.mjs
  ✔ C7 a store path in the real DSH home is refused before anything inside it is touched (63.141583ms)
  ✔ C2 the rebased spec passes against the generated engine JS inside the rc.3 checkout (vitest) (7952.714208ms)
  ✔ C3 stored appending session: shipped fails with SESSION_QUERY_PERSISTENCE_FAILED, generated succeeds and re-reads only the changed session (1615.462792ms)
  ✔ C3 live-owned appending session: shipped fails with SESSION_QUERY_PERSISTENCE_FAILED, generated succeeds and re-reads only the changed session (1539.506292ms)
  ✔ C3 boundary: a stored session that appends after every single log read defeats both engines (414.243209ms)
  ✔ C4 unknown non-ignorable event type: both engines fail with the same code and message, the process stays alive (635.897333ms)
  ✔ C5 identical ordered hits and pages from both engines on a 60-session store (29 queries) (4349.113583ms)
  ✔ C6 the heap probe runs both engines under two heap caps (small synthetic store) (5625.687833ms)
  ✔ C7 decoy HOME, DSH_HOME and XDG roots stayed empty (0.338583ms)
✔ generated engine against the rc.3 checkout (22375.850875ms)
ℹ tests 9
ℹ suites 1
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22421.05525
exit 0
```

With the compiled app engine as a third engine (`SSP_RC3_EXTRACT=/tmp/ssp-s4/shipped`, the S4
extraction; `index.js` sha256 `dbecf833…dfe70a0`): 9 tests, 9 pass, exit 0. In C3, C4 and C5 the
compiled engine gives exactly the shipped-source figures (e.g. C3 cold search while appending:
`FAILED, lists 4, wholeLogReads 16 / 64 / 14 / 62`).

Each test prints its figures as a JSON diagnostic line (`ℹ {"C3": …}`); the tables below are
taken from those lines.

## 4. C2: the rebased spec against the generated JS

How: the suite writes three files into
`<checkout>/packages/session-query/session-query-sqlite/ssp-upstream-<random>/` and runs the
checkout's vitest on them:

- `sqlite.spec.ts`: a copy of `vendor/tests/sqlite.spec.ts` (sha256 `4d58c79c…c05296` checked),
- `identity.spec.ts`: asserts that the imported engine has the six patch methods, extends the
  checkout's `SessionQueryEngine`, is a `Service` of the checkout's cordis, has `inject ['sessions']`
  and exactly the rc.3 export names,
- `vitest.config.ts` (`VITEST_CONFIG` in upstream-lib.mjs): the checkout's tsconfig paths and
  decorator plugin, its three setup files, `pool: 'forks'`, and aliases. Only the engine import
  changes: `@deepseek-ai/dsh-session-query-sqlite` → `$SSP_ENGINE_UNDER_TEST`. The generated file
  stays at its place in this package, outside the checkout, where vite-tsconfig-paths does not
  apply (first attempt: `Cannot find package '@deepseek-ai/dsh-session' imported from …/src/engine/index.js`).
  So its four bare imports get exact aliases to the files the tsconfig paths give every other
  importer (`vendor/cordis/src/index.ts`, `vendor/schemastery/src/index.ts`,
  `packages/core/session/src/index.ts`, `packages/session-query/session-query/src/index.ts`).
  The identity test proves one module instance.

The suite also checks the three generated files against `src/engine/manifest.json`. Command (run by
test C2, cwd the checkout):

```sh
SSP_ENGINE_UNDER_TEST=/Users/macbook/projects/dsh-plugins/packages/session-search-patched/src/engine/index.js \
  node node_modules/vitest/vitest.mjs run --config <scratch>/vitest.config.ts \
  --reporter=default --reporter=json --outputFile.json=<tmp>/report.json
```

Output tail (generated engine):

```
 ✓ |ssp-engine-spec| packages/session-query/session-query-sqlite/ssp-upstream-1155906e/identity.spec.ts (1 test) 2ms
 ✓ |ssp-engine-spec| packages/session-query/session-query-sqlite/ssp-upstream-1155906e/sqlite.spec.ts (92 tests) 2678ms
     ✓ keeps list() calls constant for 32 stored sessions: quiet store and one appending stored session  589ms
     ✓ never cold-reads a live-owned appending session among 32 stored sessions  565ms
     ✓ re-reads only the moved log when one of 32 stored sessions is appended during the first search  519ms
 Test Files  2 passed (2)
      Tests  93 passed (93)
```

| Run | exit | identity.spec | sqlite.spec passed / failed / skipped |
|---|---|---|---|
| generated `src/engine/index.js` | 0 | 1 passed | **92 / 0 / 0** (60 rc.3 tests, 23 tests of the patch commit, 9 vendored cost tests) |
| control: pristine rc.3 `src/index.ts` through the same config | 1 | 1 failed | 77 / 15 / 0 |

The 15 control failures are the ones S2 recorded for the pristine source (vendor/PROVENANCE.md
§5): `retries when the snapshot population changes during observation`, `retries if the persistence
binding changes while live sessions are observed`, 11 tests of the block `SQLite per-session
persisted commits`, and the cost tests `re-reads only the moved log … appended during the first
search` for 8 and 32 sessions. So the alias reaches the engine, and the spec tells the engines apart.
The checkout's `git status --porcelain` is empty before and after.

## 5. C3: the appending session

Model (`appendingFixture()` in the suite): S sessions are stored in the real rc.3 JSONL backend
(zstd). Session 0 keeps its writer open and appends one user message **after every 4th whole-log
read the engine makes** during the measured search. So the append rate grows with the indexing
work, like the session the user works in, which keeps streaming while a cold index is built. Two
variants: *stored* (session 0 is not live in this context: an append through its writer, as from another
process) and *live-owned* (session 0 is live in `ctx.sessions`, and the backend routes its events to
the writer, as the host does). Counters wrap `ctx.sessionPersistence`: `list()` calls, `open()`
calls, and whole-log reads (`read()` without offset and length) per session id. Each search is
`searchSessions({ query: 'needle', limit: 1 })`. Sequence: cold search while appending → next
search (no appends) → one append, then a search → quiet search.

| Variant, S | Engine | cold search while appending | next | appended between | quiet |
|---|---|---|---|---|---|
| stored, 8 | **generated** | **ok**, lists 4, reads 9 (session 0 ×2, 7 others ×1), 2 appends | ok, 2, 0 | ok, 2, **1 (session 0 only)** | ok, 2, 0 |
| stored, 8 | shipped | **SESSION_QUERY_PERSISTENCE_FAILED**, lists 4, reads 16, 4 appends | ok, 2, 8 | ok, 2, 1 | ok, 2, 0 |
| stored, 32 | **generated** | **ok**, lists 4, reads 33 (session 0 ×2, 31 others ×1), 8 appends | ok, 2, 0 | ok, 2, **1 (session 0 only)** | ok, 2, 0 |
| stored, 32 | shipped | **FAILED**, lists 4, reads 64, 16 appends | ok, 2, 32 | ok, 2, 1 | ok, 2, 0 |
| live-owned, 8 | **generated** | **ok**, lists 4, reads 7 (each non-live session ×1, session 0 never), 1 append | ok, 2, 0 | ok, 2, 0 | ok, 2, 0 |
| live-owned, 8 | shipped | **FAILED**, lists 4, reads 14, 3 appends | ok, 2, 7 | ok, 2, 0 | ok, 2, 0 |
| live-owned, 32 | **generated** | **ok**, lists 4, reads 31, 7 appends | ok, 2, 0 | ok, 2, 0 | ok, 2, 0 |
| live-owned, 32 | shipped | **FAILED**, lists 4, reads 62, 15 appends | ok, 2, 31 | ok, 2, 0 | ok, 2, 0 |

("ok, 2, 0" = result, list() calls, whole-log reads; `appends` counts appends during that search.)
The suite asserts every cell, including the per-id read maps of the generated engine. Why: the
first attempt of both engines sees session 0 move between its two listings. The generated engine
has already committed each log it read, so its retry re-reads only session 0 (or nothing, when it is
live-owned). That is too little work for another append, so the retry is stable. The shipped engine
committed nothing, re-reads every log, and session 0 appends again: both attempts are unstable
(`STABLE_OBSERVATION_ATTEMPTS` = 2). After that failure, its next search reads all S logs again.

Boundary (test `C3 boundary`, asserted): if session 0 appends after **every** whole-log read, the
generated engine fails as well (`FAILED`, lists 4, reads 9, 9 appends; the shipped engine: reads 16,
16 appends). The reason is that its retry must read session 0, and that read appends again. Its
committed sessions survive: the next search reads only session 0. The patch narrows the failure
window to the retry's own work; it does not remove the two-attempt limit.

## 6. C4: unknown non-ignorable event type

Store: 6 sessions (zstd); session `unk-3` gets one event of type `ssp-test/unknown-required` (not
`ignorable`). The type is admitted to `KNOWN_SESSION_EVENT_TYPES` only while that append runs, as a
log written by a newer harness. The test asserts that the set no longer holds the type afterwards.

| | generated | shipped (and shippedLib) |
|---|---|---|
| code | `SESSION_QUERY_PERSISTENCE_FAILED` | same |
| cause | `SessionFormatUnsupportedError` | same |
| message | `session-search persistence observation failed: session "unk-3" contains event type "ssp-test/unknown-required" (seq 1) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness (raw log: <store>/…/unk-3/session.v4.jsonl.zstd)` | byte-identical |
| first search: reads / opens / failed opens | 3 / 4 / 1 | 3 / 4 / 1 |
| second search | same error; 0 / 1 / 1 (only the refused log is tried again) | same error; 3 / 4 / 1 (nothing was committed) |
| `searchEvents` of a good session | same error | same error |
| after moving `unk-3` away: same instance | ok, 5 hits; reads 2 (only the logs it had not committed) | ok, 5 hits (deep-equal); reads 5 |
| separate process (`engine-probe.mjs unknown-type`) | exit 0, no signal, `alive: true`, `unhandled: []`, three failures with the same code and message | same |

The rc.3 JSONL backend decodes and validates a log in `open()`, so the refused log fails there (a
failed open), not in `read()`. The child exits by draining its event loop, not by
`process.exit`, so a leaked handle would hang it and fail the suite's timeout. In this process an
`unhandledRejection` listener stayed empty.

## 7. C5: same hits

Store (`writeComparisonStore()`, PRNG seed 7): **60 sessions, 2184 events**. They lie in four
project folders plus sessions without cwd. Some sessions are subagent children (`parentSession`,
`delegationDepth: 1`) and some have agent presets. The text contains English, Chinese, Japanese and
Korean words, a phrase that also occurs as loose words, marker words with graded frequency, and
aborted and failed final turns (their `turn/end` text is on the `log-only` surface). Both engines
index the same store through their own backend instance. Each query runs to its last page. The test
compares every page deep-equal: items (header, live, persisted, bestMatch with seq, type, time,
surface and snippet), the `session` header of event pages, and the cursor. A cursor is compared by its
decoded payload without `instance` and `generation`, because both are per engine by design: a random
instance id, and the patched engine raises its generation once per committed session.

| Query | kind | pages | items |
|---|---|---|---|
| plain word `needle`, limit 5 | sessions | 6 | 30 |
| frequent word `session`, limit 7 | sessions | 8 | 55 |
| phrase `quick brown fox`, limit 4 | sessions | 3 | 11 |
| two words `needle haystack`, limit 3 | sessions | 3 | 8 |
| CJK `数据库迁移失败`, limit 3 | sessions | 3 | 7 |
| CJK two-character `会话`, limit 4 | sessions | 2 | 7 |
| Japanese `検索エンジン`, limit 2 | sessions | 3 | 5 |
| Korean `세션`, limit 5 | sessions | 7 | 35 |
| CJK background word `全文索引`, limit 9 | sessions | 5 | 44 |
| filter cwd (one project) | sessions | 5 | 14 |
| filter cwd `null` | sessions | 3 | 5 |
| filter parent (children of cmp-007) | sessions | 1 | 1 |
| filter parent `null` | sessions | 5 | 27 |
| filter created-at range | sessions | 6 | 21 |
| filter id list | sessions | 1 | 4 |
| filter availability `persisted` | sessions | 4 | 20 |
| filter availability `live` (none) | sessions | 1 | 0 |
| event filter type `assistant/message` | sessions | 6 | 30 |
| event filter surface `log-only` | sessions | 2 | 3 |
| event filter seq range + cwd | sessions | 5 | 21 |
| `aborted` | sessions | 1 | 4 |
| singleton marker | sessions | 1 | 1 |
| no hit | sessions | 1 | 0 |
| no hit CJK `不存在的词语` | sessions | 1 | 0 |
| events in cmp-009, limit 4 | events | 2 | 6 |
| events in cmp-018, CJK | events | 4 | 7 |
| events in cmp-021, type filter, limit 3 | events | 3 | 9 |
| events in cmp-002, phrase + time filter | events | 1 | 12 |
| events, no hit | events | 1 | 0 |

29 queries, 20 with more than one page; all 29 are deep-equal between generated and shipped (and
shippedLib in the third-engine run). The heap runs of §8 add the large stores: in every run that
finished (8 on the synthetic store, 11 on the real copy), the first page of `needle` (synthetic) or
`the` (real copy) has the same 20 hits in the same order (compared as hashed ids).

## 8. C6: peak heap

Method: `engine-probe.mjs matrix` starts one child per engine and cap:
`node --trace-gc [--max-old-space-size=N] engine-probe.mjs heap …`. The child mounts the rc.3 store,
projections, JSONL backend (zstd) and the engine with the row config. It runs one cold search
(`searchSessions({ query, limit: 20 })`) and one quiet search, then exits. Two peak figures:

- *sampled*: max of `v8.getHeapStatistics().used_heap_size` every 20 ms and after every whole-log read;
- *GC trace*: the largest heap size at the start of a GC in the `--trace-gc` lines (`A (B) -> C (D) MB`,
  max of A).

Both include garbage that is not collected yet, so they bound the live set from above. The cap is
the old-space limit; `heap_size_limit` is about 192 MB larger (512 → 704). "OOM" means that V8
aborted the child with `Reached heap limit … JavaScript heap out of memory` (SIGABRT); for an OOM
the table gives the last GC-trace figure. The maximum RSS includes the `:memory:` SQLite index (native memory).

### 8.1 Synthetic store: 1.126 GB decoded (the largest store available)

Generated by `engine-probe.mjs generate --plan large` (seed 11): **200 sessions, 903 624 events, decoded
log bytes 1 125 992 156 (largest log 145 506 217)**, 309 858 674 bytes on disk (zstd). Sizes:
2 × 120, 4 × 60, 12 × 20, 40 × 5 and 142 × 0.5 MB of text. The text comes from fixed English and
CJK word lists with markers. Generation took 41.5 s. Query `needle` (in every third session).

| `--max-old-space-size` | generated: result | generated: peak sampled / GC trace (MB) | generated: max RSS | generated: first search | shipped: result | shipped: peak sampled / GC trace (MB) | shipped: max RSS | shipped: first search |
|---|---|---|---|---|---|---|---|---|
| 256 | OOM after 4.2 s | — / 294.3 | — | — | (not run) | | | |
| 384 | OOM after 6.1 s | — / 411.6 | — | — | (not run) | | | |
| **512** | **ok**, 20 hits | **464.3 / 481.8** | 2579 MB | 37.9 s | **OOM after 2.1 s** | — / 504.4 | — | — |
| **1024** | **ok** | **618.5 / 649.8** | 2772 MB | 39.4 s | **OOM after 3.1 s** | — / 1107.6 | — | — |
| 2048 | ok | 657.2 / 660.4 | 2788 MB | 40.5 s | ok, 20 hits | 1898.5 / 1938.6 | 4251 MB | 47.0 s |
| 4096 | ok | 686.0 / 689.2 | 2818 MB | 41.9 s | ok | 2199.1 / 2202.0 | 4695 MB | 46.9 s |
| 8192 | ok | 617.3 / 651.6 | 2763 MB | 40.8 s | ok | 2199.2 / 2202.1 | 4874 MB | 45.6 s |

Every finished run: first search 2 `list()` calls and 200 whole-log reads; quiet search 2 calls,
0 reads, 12.0–12.7 s (the SQL of a frequent term over a 1.1 GB index, the same for both engines).
All 8 finished runs return the same 20 hits. The generated engine needs between 385 and 512 MB of
old space on this store, and its peak does not grow with the cap above 1 GB (about 620–690 MB). The
shipped engine needs between 1025 and 2048 MB and peaks at about 2.2 GB when the heap may grow. The
generated engine's floor follows the largest logs, not the store: one decoded log plus the JSONL
backend's memo of up to 2 decoded logs (`COLD_LOG_MEMO_MAX_ENTRIES = 2`, PROVENANCE.md), here
145 + 120 MB of text.

### 8.2 Copy of the real store: 691 MB decoded

The lead's read-only copy `/tmp/ssp-scratch-store/sessions`: 253 sessions, 163 MB on disk (zstd),
decoded 691 333 793 bytes, largest log 67 673 818 bytes (byte counts only, `zstd -dcq <file> | wc -c`).
Probe in `--private` mode: query `the`; the output holds only counts, sizes, timings, heap figures,
error codes and hashed ids (no message, snippet, title, header field or log content; the child's
stderr is not printed). Run with `--admit-plugin-types` (the four plugin event types of the replay
harness, admitted for both engines alike); a control run without it, at 2048, gives the same figures
(generated 355.2 / 367.3 MB, shipped 559.8 / 636.2 MB, both ok).

| `--max-old-space-size` | generated: result | generated: peak sampled / GC trace (MB) | generated: max RSS | generated: first search | shipped: result | shipped: peak sampled / GC trace (MB) | shipped: max RSS | shipped: first search |
|---|---|---|---|---|---|---|---|---|
| **256** | **ok**, 20 hits | **205.2 / 225.7** | 801 MB | 10.5 s | **OOM after 1.0 s** | — / 284.9 | — | — |
| **512** | **ok** | **205.4 / 234.5** | 840 MB | 10.3 s | ok, 20 hits | 394.8 / 413.2 | 1386 MB | 14.5 s |
| 1024 | ok | 246.9 / 285.1 | 927 MB | 10.4 s | ok | 759.5 / 759.9 | 1569 MB | 14.5 s |
| 2048 | ok | 355.5 / 368.9 | 1012 MB | 11.2 s | ok | 560.1 / 636.6 | 1643 MB | 14.7 s |
| 4096 | ok | 354.7 / 362.8 | 1028 MB | 11.3 s | ok | 560.1 / 636.2 | 1639 MB | 14.8 s |

Every finished run: 253 sessions listed, 253 whole-log reads on the first search, 0 on the second
(2.9–3.1 s); all 9 finished runs return the same 20 hashed ids. The copy is not changed by the runs:
the sha256 of its listing (`find sessions -print0 | sort -z | xargs -0 stat -f '%N %z %m %p' | shasum -a 256`)
is `6c578f27a781d5636dfeb43d00f1e16d4286b38463baab42aaaff1b76365940d` before and after.

### 8.3 Commands

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
cd /Users/macbook/projects/dsh-plugins
P=packages/session-search-patched/test/upstream/engine-probe.mjs
T=$(node -e 'console.log(require("fs").realpathSync(require("os").tmpdir()))')
node $P generate --upstream /tmp/dsh-rc3-s7 --out "$T/ssp-s7-syn-large" --plan large
node $P matrix --upstream /tmp/dsh-rc3-s7 --store "$T/ssp-s7-syn-large/sessions" --caps 512,1024,2048,4096,8192 --engines generated,shipped   # 7 min 26 s
node $P matrix --upstream /tmp/dsh-rc3-s7 --store "$T/ssp-s7-syn-large/sessions" --caps 256,384 --engines generated
node $P matrix --upstream /tmp/dsh-rc3-s7 --store /tmp/ssp-scratch-store/sessions --caps 256,512,1024,2048,4096 \
  --engines generated,shipped --private --admit-plugin-types                                                                               # 2 min 22 s
node $P matrix --upstream /tmp/dsh-rc3-s7 --store /tmp/ssp-scratch-store/sessions --caps 2048 --engines generated,shipped --private
rm -rf "$T/ssp-s7-syn-large"
```

Each `matrix` prints one progress line per child on stderr and one `SSP_PROBE_RESULT {…}` line with
all rows on stdout. One child alone: `node --trace-gc --max-old-space-size=512 $P heap --upstream /tmp/dsh-rc3-s7 --engine generated --store <root>`.
Test C6 runs the same probe on a small store (60 sessions, 13.4 MB decoded) under caps 256 and 512
for both engines. All four runs end with exit 0 and the same hashed hits; the generated peak is
55–62 MB, the shipped peak 94–101 MB.

## 9. C7: the real DSH home

- The suite installs decoys before it loads anything (`test/helpers/decoys.mjs`): HOME, DSH_HOME,
  XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME and XDG_CACHE_HOME point at empty folders under
  one mkdtemp folder for the whole run. They are inherited by every child (vitest, the probe). The
  last test asserts that every decoy folder is still empty, and it passes, so vitest and vite did
  not write there either.
- Every store goes through `assertScratchStorePath()`: `mountStore()`, `mountEngine()` and every probe
  mode check the store before they create a context. The guard takes the real home from
  `os.userInfo().homedir` (not `$HOME`). It refuses a path that is, resolves to, or lies inside
  `~/.dsh` or `~/.local/state`. Comparison is case-insensitive on macOS. Resolution works like
  realpath(3), one component at a time: `link/..` is the parent of the link's target, and every
  prefix is checked before it is lstat'ed.
- Test C7 refuses 12 paths: `~/.dsh`, `~/.dsh/`, `~/.dsh/sessions`, `~/.dsh/profiles/web/sessions`,
  `~/projects/../.dsh/sessions`, a link to `~/.dsh/sessions`, `<link>/../elsewhere` (lexically
  outside, really `~/.dsh/elsewhere`), a link chain, `<link to ~>/.dsh/sessions`,
  `~/.local/state/dsh/sessions`, `~/.DSH/sessions` and `~/.Local/State`. During those calls,
  `fs.lstatSync`, `readlinkSync`, `statSync`, `readdirSync` and `openSync` are recorded: 53 calls, **0**
  inside a forbidden folder. `mountStore(~/.dsh/sessions)` rejects with `SSP_FORBIDDEN_STORE_PATH`;
  `engine-probe.mjs heap --store ~/.dsh/sessions` and `matrix --store <link chain into ~/.dsh>` exit
  with code 2 and the same code. A mkdtemp path and a relative link that resolves outside are accepted.
- All stores of the suite are mkdtemp folders under `os.tmpdir()`, removed in `after()`. The synthetic
  generator refuses an `--out` outside `os.tmpdir()`.

## 10. Defects and observations

No defect of the generated engine was found: the spec, all scenarios and all comparisons pass.
Observations for the lead (no product code was changed):

1. **The two-attempt limit stays** (C3 boundary). A session whose revision changes during every
   attempt still fails the search with `SESSION_QUERY_PERSISTENCE_FAILED`. The patch shortens the
   retry to the logs that moved, so a streaming session has to move inside that short window. Repro:
   test `C3 boundary`, `appendingSequence('generated', 8, { liveOwned: false, appendEvery: 1 })`.
2. **The `:memory:` index costs native memory that grows with the store**: the maximum RSS of the
   generated engine is 2.6–2.8 GB on the 1.126 GB synthetic store and 0.8–1.0 GB on the real copy,
   while its JS heap stays at 0.2–0.7 GB. This comes from the row config (`path: ':memory:'`, the same
   as the upstream bundle row), not from the patch; the shipped engine has 4.3–4.9 GB / 1.4–1.6 GB.
3. **The generated engine's heap floor follows the largest logs** (not the store size). It needs
   more than 384 MB of old space on the synthetic store, whose two largest logs hold 145 + 120 MB of
   text: one decoded log plus the backend's 2-entry memo. A store with a single 500 MB log, like the
   former 2.8 GB store, needs a correspondingly larger heap.
4. Quiet searches for a frequent term take about 12 s on the 1.1 GB synthetic index for both
   engines (SQL of `query.ts`, which the patch does not change).
5. On the real copy the shipped engine's sampled peak is higher under a 1024 MB cap (759.5 MB) than
   under 2048 (560.1 MB). This is a garbage-collection timing effect: the figures include uncollected
   garbage. The lowest cap that completes is the robust comparison: generated ≤ 256 MB, shipped
   257–512 MB on the copy; generated 385–512 MB, shipped 1025–2048 MB on the synthetic store.

## 11. Doubts

- C3 models the appending session by work (one append per 4 log reads), not by wall-clock time,
  so the result is deterministic. A real streaming session appends on a timer. The model shows the
  mechanism (the generated retry does less work); it does not give a failure probability for a given
  append rate.
- "shipped" in C2–C5 is the rc.3 engine source, run through tsx. The compiled app engine was compared
  in one full suite run (`SSP_RC3_EXTRACT`), with the same results; the heap tables use the source.
- The heap figures are peaks of used heap including garbage (sampled every 20 ms and from GC traces).
  Short peaks between samples can be missed by the sampler, but not by the GC trace for collected
  ones.
- The synthetic store's text comes from small word lists, and the JSON envelope is that of the test
  events (`stream: []`, no tool calls). Real logs carry larger stream and tool payloads per text byte,
  so the decoded-bytes-to-heap ratio differs (compare 8.1 and 8.2).
- The real-store runs used `--admit-plugin-types`; the control without it gave the same result. The
  copy holds no event type that is unknown to the rc.3 checkout and not ignorable.

## 12. Clean-up and files

```sh
rm -rf "$T/ssp-s7-syn-large"                                              # synthetic store (1.1 GB decoded, 310 MB on disk)
git -C /Users/macbook/projects/deepseek-harness worktree remove --force /tmp/dsh-rc3-s7
git -C /Users/macbook/projects/deepseek-harness worktree prune
git -C /Users/macbook/projects/deepseek-harness worktree list              # only the main checkout
```

Done after the runs above: the synthetic store (300 MB on disk) and the worktree are removed,
`worktree list` shows only `/Users/macbook/projects/deepseek-harness e1f2349309 [fix/session-search-bounded-index]`,
and no `ssp-upstream-*` folder is left under `os.tmpdir()`. The store copy `/tmp/ssp-scratch-store`
belongs to the lead and was left in place, unchanged (listing sha256 in §8.2).

| File | Written by this task |
|---|---|
| `test/upstream/engine-upstream.test.mjs` | yes |
| `test/upstream/upstream-lib.mjs` | yes |
| `test/upstream/engine-probe.mjs` | yes |
| `docs/verification.md` | yes |

Read only: `src/engine/*`, `vendor/*`, `test/helpers/decoys.mjs` (imported), the rc.3 worktree
(apart from the scratch spec folder), `/tmp/ssp-s4/shipped/index.js`, and the store copy.
