# Provenance of the vendored engine sources

This folder holds the bounded-index SQLite session-search engine, rebased onto the
sources of `@deepseek-ai/dsh-session-query-sqlite` **0.2.2-rc.3**, the build that was
installed in `/Applications/DeepSeek Harness.app` when this note was written. The
rc.5 build (tag `dsh-v0.2.2-rc.5`, commit `9c2670d3bc`) ships the same `src/index.ts`,
`src/query.ts` and `src/schema.ts` bytes, which is why the pin admits both versions;
only the packages' `package.json` versions changed. That rc.5 check was made against the
git tag, and on 2026-11-23 against the installed DSH 0.2.2-rc.5 app: the sha256 of its
`src/index.ts`, `src/query.ts` and `src/schema.ts` equal the three source pins. These
files are the input of `scripts/build.mjs`, which generates `src/engine/*.js` (see
`src/engine/manifest.json`).

| File | What it is | sha256 |
|---|---|---|
| `vendor/src/index.ts` | rc.3 `src/index.ts` with the bounded-index patch (rebased) | `0472dc2a080a719adef38ccecbfe20574b424763d4dc7938e6818c0c38c3fcdf` |
| `vendor/src/query.ts` | rc.3 `src/query.ts`, verbatim | `b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48` |
| `vendor/src/schema.ts` | rc.3 `src/schema.ts`, verbatim | `2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f` |
| `vendor/tests/sqlite.spec.ts` | rc.3 `tests/sqlite.spec.ts` plus the commit's test changes (lines 1–2416), plus a vendored cost block (lines 2417–2598) | `4d58c79c3413012c8c7fb23ec02782864df323662832bfa4a158938002c05296` |
| `vendor/LICENSE.upstream` | upstream `LICENSE` (MIT), verbatim | `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be` |
| `patches/engine-0.2.2-rc.3.diff` | rc.3 `src/index.ts` → `vendor/src/index.ts` (5-line preamble, then one git diff, 14 hunks, +212/−68) | `19bb0cde35435f6f5268cab98db1577070395ef6f9bb3f0467dcf325a98428cd` |

Shorthands used in the commands below:

```sh
PKG=/Users/<user>/projects/dsh-plugins/packages/session-search-patched
CLONE=/Users/<user>/projects/deepseek-harness
ENG=packages/session-query/session-query-sqlite
APP_ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
```

Tools: node v24.22.3, `@electron/asar` 4.3.2 (through `npx --yes`), pnpm 11.28.5 (selected
by the clone's `packageManager`), TypeScript 6.0.3 and vitest 4.1.11 (the rc.3 lockfile),
GNU patch 2.7.6 and Apple patch 2.0-12u11. Recorded on 2026-11-18.

## Base and the patch commits

- **Base: package `@deepseek-ai/dsh-session-query-sqlite` 0.2.2-rc.3.** The installed app
  reports 0.2.2-rc.3 both in `dsh/package.json` and in the engine's own `package.json`
  (`dsh/node_modules/@deepseek-ai/dsh-session-query-sqlite/package.json`, sha256
  `e19acdd6c66e7f504e0e4c953938162c1285f57d2b374c8daa0ea28d1493a302`). In the upstream clone
  this is tag `dsh-v0.2.2-rc.3` = commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`.
- **rc.4 base: commit `ca33fd6843`** (master, "Merge pull request #8667 … sync-release-dsh-0.2.2-0.2.2-rc.4-to-master").
  The patch was written on this commit. Note: tag `dsh-v0.2.2-rc.4` (`3f321d32bf`) still has
  the rc.3 engine `src/index.ts` byte for byte (`72868e4a…`); the 13-line rc.3/rc.4 delta
  below exists only on master at `ca33fd6843`.
- **`da482fcac4` "fix(session-query-sqlite): index persisted sessions one at a time" and
  `e1f2349309` "fix(session-search): read hit titles one log at a time" are LOCAL UNMERGED
  commits** on branch `fix/session-search-bounded-index` of the clone. They are not upstream
  commits and have no upstream review.
  - `da482fcac4` changes the engine `src/index.ts` (280 changed lines: +212/−68),
    `tests/sqlite.spec.ts` and the engine READMEs. Its `src/index.ts` change is what this
    folder rebases.
  - `e1f2349309` changes no engine source. It adds `persistedReadConcurrency: 1` to the
    engine row of the session-search bundle (`packages/experimental/session-search/cordis.patch.yml`).
    That config key exists on rc.3 (`vendor/src/index.ts:217`, schema default
    `SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY` = 4), so a row that mounts this
    engine on rc.3 can set it.

## Hash table: rc.3 originals from independent sources (criteria 1 and 6)

| File | asar extract-file of the installed app | clone `tmp-repro/rc3/` | rc.3 checkout (tag `dsh-v0.2.2-rc.3`, worktree) | vendored |
|---|---|---|---|---|
| `src/index.ts` | `72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3` | `72868e4a…48b8d3` (equal) | `72868e4a…48b8d3` (equal) | patched: `0472dc2a…c3fcdf` |
| `src/query.ts` | `b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48` | equal | equal | equal |
| `src/schema.ts` | `2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f` | equal | equal | equal |
| `lib/index.js` (installed compiled engine) | `dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0` | — | not built | — |

All three sources agree for all three files. Further check that the rc.3 checkout is the
installed build: every `src/*.ts` of `dsh-session`, `dsh-session-query`,
`dsh-session-persistence` and `dsh-session-persistence-jsonl` in the asar (39 files)
equals the file at the same path of the rc.3 checkout (39 equal, 0 different). The installed
`lib/index.js` has `static inject = ["sessions"]` and `return SessionSearchCursor(Buffer.from(…))`,
the rc.3 forms.

For comparison, the rc.4 base (`ca33fd6843`, equal to clone `tmp-repro/head/`) has
`src/index.ts` `e4f49d404fa77c1b868a096e51252329be07752db8750cb85c8fa15d2eeca321` and the same
`query.ts`/`schema.ts` as rc.3. The patched rc.4 file (clone working tree = `e1f2349309`) is
`26e33a2bafad708489652425b84e719f46f940753cb779530759171840dcd0ef`.

Commands:

```sh
# 1. asar extract-file (run in an empty temp folder; extract-file writes to the cwd)
cd "$(mktemp -d)"
for f in src/index.ts src/query.ts src/schema.ts lib/index.js package.json; do
  npx --yes @electron/asar extract-file "$APP_ASAR" dsh/node_modules/@deepseek-ai/dsh-session-query-sqlite/$f
done
shasum -a 256 index.ts query.ts schema.ts index.js package.json
# 2. clone copy
shasum -a 256 $CLONE/tmp-repro/rc3/{index,query,schema}.ts
# 3. tag / rc.3 checkout
for f in index query schema; do git -C $CLONE show dsh-v0.2.2-rc.3:$ENG/src/$f.ts | shasum -a 256; done
# vendored copies
shasum -a 256 $PKG/vendor/src/*.ts
```

## Commutation (criterion 2)

The 13-line rc.3/rc.4 delta of `src/index.ts`:

| rc.3 | rc.4 base |
|---|---|
| — | `import { brandString } from '@deepseek-ai/dsh-brand'` |
| value import `SessionSearchCursor,` from `@deepseek-ai/dsh-session-query` | — |
| `static override inject = ['sessions']` | `static override inject = ['sessions', 'sessionProjections']` |
| `protected async [Service.init]()` | `protected override async [Service.init]()` and `await super[Service.init]()` |
| `} catch {` (dispose waits for `_ready`) | `} catch (_openFailed) {` |
| `} catch {` (ROLLBACK of the reconcile transaction) | `} catch (_rollbackFailed) {` |
| `return SessionSearchCursor(Buffer.from(…))` | `return brandString<SessionSearchCursorValue>(Buffer.from(…))` |

The patch moves the reconcile transaction body, including the ROLLBACK `catch`, out of
`_reconcile` into the new helper `_writeTransaction`, two levels less indented (8 instead
of 10 spaces). `vendor/src/index.ts` keeps the rc.3 form `catch {` there. So
`vendor/src/index.ts` → patched rc.4 is exactly the seven delta sites above, and the only
difference from the rc.3 → rc.4 delta is the indentation of that moved line:

```sh
diff <(diff $CLONE/tmp-repro/rc3/index.ts $CLONE/tmp-repro/head/index.ts | grep '^[<>]') \
     <(diff $PKG/vendor/src/index.ts $CLONE/$ENG/src/index.ts | grep '^[<>]')
```

output (exit 1), leading white space only:

```
10,11c10,11
< <           } catch {
< >           } catch (_rollbackFailed) {
---
> <         } catch {
> >         } catch (_rollbackFailed) {
```

The same comparison without white-space amounts prints nothing (exit 0):

```sh
diff -b <(diff $CLONE/tmp-repro/rc3/index.ts $CLONE/tmp-repro/head/index.ts | grep '^[<>]') \
        <(diff $PKG/vendor/src/index.ts $CLONE/$ENG/src/index.ts | grep '^[<>]')
```

Both sides have 13 `<`/`>` lines. Without `tmp-repro/`, use
`git -C $CLONE show dsh-v0.2.2-rc.3:$ENG/src/index.ts` and `git -C $CLONE show ca33fd6843:$ENG/src/index.ts`
(same bytes). The alternative, keeping the patch's `catch (_rollbackFailed)` inside
`_writeTransaction`, makes the literal command print `10,11d9` (two delta lines missing) and
leaves an rc.4-style line in an rc.3 file; it was not chosen. Both forms compile and behave
the same.

Second view of the same fact, the patch bodies: the `+`/`−` lines of
`patches/engine-0.2.2-rc.3.diff` and of `git -C $CLONE diff ca33fd6843 e1f2349309 -- $ENG/src/index.ts`
differ in exactly two lines, the removed ROLLBACK `catch` (rc.3 text) and the added one in
`_writeTransaction`:

```sh
diff <(git -C $CLONE diff ca33fd6843 e1f2349309 -- $ENG/src/index.ts | grep '^[-+][^-+]') \
     <(grep '^[-+][^-+]' $PKG/patches/engine-0.2.2-rc.3.diff)
# 68c68  < -          } catch (_rollbackFailed) {   > -          } catch {
# 203c203 < +        } catch (_rollbackFailed) {    > +        } catch {
```

## Patch file reproduces the vendored file (criterion 3)

```sh
patch -s -o - $CLONE/tmp-repro/rc3/index.ts $PKG/patches/engine-0.2.2-rc.3.diff | shasum -a 256
# 0472dc2a080a719adef38ccecbfe20574b424763d4dc7938e6818c0c38c3fcdf  -
shasum -a 256 $PKG/vendor/src/index.ts
# 0472dc2a080a719adef38ccecbfe20574b424763d4dc7938e6818c0c38c3fcdf  .../vendor/src/index.ts
```

Same hash from the asar-extracted `index.ts`, with GNU patch (`/opt/anaconda3/bin/patch`,
first `patch` on this PATH) and with Apple `/usr/bin/patch`. Keep `-s`: without it Apple's
patch prints `patching file …` to stdout and spoils the hash (GNU patch prints it to stderr).
The file is also a valid git patch: `git apply` of it onto a copy of the rc.3 file at
`packages/session-query/session-query-sqlite/src/index.ts` gives the same hash. It was
generated with `git -C <rc.3 worktree> diff -- $ENG/src/index.ts` (blob `7c95afa28d` → `a091bf4a84`)
after the vendored file had been copied in.

## No rc.4-only API (criterion 4)

```sh
grep -rnE 'brandString|dsh-brand|sessionProjections|super\[Service\.init\]' $PKG/vendor/src   # no output, exit 1
grep -n 'static override inject' $PKG/vendor/src/index.ts   # 207:  static override inject = ['sessions']
```

## Per-hunk summary of `patches/engine-0.2.2-rc.3.diff`

Line numbers are rc.3 (old) / vendored (new). Each hunk matches the same-numbered hunk of
`da482fcac4`, offset by −1 old line (the rc.3 file has no `dsh-brand` import).

| # | Hunk | Change |
|---|---|---|
| 1 | `@@ -134,13 +134,16` types | `fingerprint` moves from `ObservedSession` to the new `ObservedLiveSession`; `ObservedPersistedSession` loses `loaded?` (no decoded log is kept in the observation). |
| 2 | `@@ -151,7 +154,7` | `Observation.live` holds `ObservedLiveSession`. |
| 3 | `@@ -231,6 +234,10` fields | new `_persistedRowsBinding`: the binding whose `persisted_sessions` rows may be reused by revision (undefined until this connection's first commit or completed pass). |
| 4 | `@@ -404,25 +411,32` `_reconcile` head | observe first, then read live rows; persisted deletes are unlisted rows, or all rows when another binding issued them; persisted changes are no longer written here. |
| 5 | `@@ -430,15 +444,14` | only deletes bump the main generation in the final transaction. |
| 6 | `@@ -449,53 +462,44` final transaction | inline `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` replaced by `_writeTransaction(...)`: deletes, generation, live deletes and live replacements; records `_persistedRowsBinding`. **Overlaps the rc.3/rc.4 delta** (`catch {` vs `catch (_rollbackFailed)`); resolved to the rc.3 text, see Commutation. |
| 7 | `@@ -503,26 +507,27` `_observeStable` | each attempt re-reads indexed revisions (when reusable), skips live-owned sessions, stops on a binding change, and calls `_indexPersistedSession` per changed session instead of collecting decoded logs. |
| 8 | `@@ -531,6 +536,7` | index failures (`SESSION_QUERY_INDEX_FAILED`) propagate unmapped instead of becoming persistence failures. |
| 9 | `@@ -545,7 +551,7` | live map type. |
| 10 | `@@ -561,6 +567,108` new methods | `_indexPersistedSession` (read one log, check header, commit), `_commitPersistedSession` (one transaction per session at `global_generation + 1`; wipes foreign rows on the first commit under a new binding), `_writeTransaction` (shared BEGIN IMMEDIATE wrapper; its ROLLBACK catch is `catch {` here), `_persistedRowsReusable`, `_indexedPersistedRows`. |
| 11 | `@@ -568,6 +676,10` | `_setMainGeneration`. |
| 12 | `@@ -613,7 +725,7` | `_replaceLiveSession` takes `ObservedLiveSession`. |
| 13 | `@@ -868,28 +980,56` helpers | `observeLive` computes the fingerprint; `observeSession` no longer `structuredClone`s every event; new `liveFingerprint` hashes header, cut and events one event at a time (stored only in connection-local TEMP rows). |
| 14 | `@@ -1114,6 +1254,10` | `isIndexFailure`. |

Untouched by the patch and kept in rc.3 form: the imports (value import `SessionSearchCursor`,
no `dsh-brand`), `inject = ['sessions']`, `protected async [Service.init]()` without a super
call, the dispose `catch {`, and `encodeCursor` with `SessionSearchCursor(...)`. `schema.ts`
and `query.ts` are not patched, so the on-disk schema and `SESSION_QUERY_SQLITE_SCHEMA_VERSION`
are those of rc.3: an index file written by the shipped rc.3 engine opens with this engine and
the other way round.

## rc.3 checkout: type check and spec (criterion 5)

Scratch worktree outside this workspace, removed at the end:

```sh
git -C $CLONE worktree add --detach /tmp/dsh-rc3-checkout-s2 dsh-v0.2.2-rc.3   # HEAD 38a6a5c965
cd /tmp/dsh-rc3-checkout-s2
pnpm install --frozen-lockfile --ignore-scripts      # pnpm 11.28.5; `--offline` failed (ERR_PNPM_NO_OFFLINE_META @agentclientprotocol/sdk)
# the real-JSONL tests need the native flock addon; use the installed rc.3 binary
# (sha256 6c89a8ca0824b2e76b8a2b7e0f36f5bbcf2b7fbff77ae4e9a8d3cde8c44c4b30; native/system is unchanged rc.3..e1f2349309):
mkdir -p native/system/packages/darwin-arm64/bin
cp "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node" native/system/packages/darwin-arm64/bin/
# referenced projects must have declarations before `tsc -p` of the engine package
./node_modules/.bin/tsc -b vendor/cosmokit vendor/cordis vendor/schemastery packages/core/session \
  packages/session/session-persistence packages/session-query/session-query
cp $PKG/vendor/src/{index,query,schema}.ts $ENG/src/
cp $PKG/vendor/tests/sqlite.spec.ts $ENG/tests/sqlite.spec.ts
```

Baseline before copying (pristine rc.3): `pnpm vitest run packages/session-query/session-query-sqlite`
→ `Tests 70 passed (70)` (sqlite.spec 60, query.spec 10); `tsc --noEmit` of the package exit 0.

With the vendored files in place:

```
$ ./node_modules/.bin/tsc --noEmit -p packages/session-query/session-query-sqlite/tsconfig.json
exit 0
$ ./node_modules/.bin/tsc -p tsconfig.s2-spec.json      # extra: type-checks the spec too, see below
exit 0
$ pnpm vitest run packages/session-query/session-query-sqlite
 ✓ |thread-safe| packages/session-query/session-query-sqlite/tests/query.spec.ts (10 tests)
 ✓ |thread-safe| packages/session-query/session-query-sqlite/tests/sqlite.spec.ts (92 tests)
 Test Files  2 passed (2)
      Tests  102 passed (102)
```

`tsconfig.s2-spec.json` (scratch, worktree root only): extends `./tsconfig.base.json`;
`compilerOptions` `{ noEmit: true, rewriteRelativeImportExtensions: false, composite: false, incremental: false }`;
`include` the engine `src` and `tests/sqlite.spec.ts`; `references` `vendor/cosmokit`,
`vendor/cordis`, `vendor/schemastery` (they compile under their own looser options). The
pristine rc.3 spec passes it too.

Counts of the 92 sqlite tests: 60 rc.3 tests (two with expectations changed by the commit),
23 tests added by the commit (block `SQLite per-session persisted commits`), 9 vendored cost
tests. For comparison, the clone's patched rc.4 tree (`e1f2349309`) runs the commit's spec
with 93 passed (83 + 10), the same 83 + 10 without the cost block.

Control, same spec with the pristine rc.3 `src/index.ts` (asar copy) in place: 15 failed /
87 passed. The failures are the two changed expectations (`retries when the snapshot
population changes during observation`, `retries if the persistence binding changes while
live sessions are observed`), 11 of the 23 new tests, and the cost test `re-reads only the
moved log … appended during the first search` for 8 and 32 sessions (for 1 session S+1 = 2S).
So the spec detects the patch.

### Adapted tests

The spec is `git show dsh-v0.2.2-rc.3:$ENG/tests/sqlite.spec.ts` with
`git -C $CLONE diff ca33fd6843 e1f2349309 -- $ENG/tests/sqlite.spec.ts` applied
(9 hunks; 8 applied at offset −1, hunk 1 rejected only because of rc.4 context lines).

| Where | rc.4 text | rc.3 text |
|---|---|---|
| hunk 1, imports | context had `import { brandString } from '@deepseek-ai/dsh-brand'` and `type SessionId` | context without the brand import and with the rc.3 value import `SessionId`; the added lines (`onTestFinished`, `setFlagsFromString`, `runInNewContext`) unchanged |
| test `commits nothing for a session whose read header conflicts with its listed header` | `revision: brandString<SessionPersistenceRevision>('conflict:1')` | `revision: SessionPersistenceRevision('conflict:1')` (rc.3 value constructor, as elsewhere in the rc.3 spec) |

Every other line of the commit's test change is verbatim: the `readHook`, the
`committedRows`/`committedTexts`/`committedGeneration` helpers, the two changed `reads`
expectations (2 → 1) and the 23 new tests. Check:

```sh
P=$ENG/tests/sqlite.spec.ts
diff <(diff <(git -C $CLONE show dsh-v0.2.2-rc.3:$P) <(git -C $CLONE show ca33fd6843:$P) | grep '^[<>]') \
     <(diff <(head -n 2416 $PKG/vendor/tests/sqlite.spec.ts) <(git -C $CLONE show e1f2349309:$P) | grep '^[<>]')
# 115a116,117
# > <       revision: SessionPersistenceRevision('conflict:1'),
# > >       revision: brandString<SessionPersistenceRevision>('conflict:1'),
```

Lines 2417–2598 (`SQLite per-search persistence cost on the real rc.3 JSONL backend`) are
a vendored addition and not part of the commit.

## Persistence cost on rc.3 (criterion 7)

The cost block in `vendor/tests/sqlite.spec.ts` stores S sessions (1 user message each) in
the real rc.3 JSONL backend (`compression: 'none'`), mounts the engine on a file index and
wraps `ctx.sessionPersistence.list` (counts calls) and `open` (counts handle `read(0)` calls
without a length, i.e. whole-log reads). Session 0 keeps its writer open and is the appending
session: either an append through the writer (a stored session that this context does not
own), or, in the live-owned variant, a live `Session` in `ctx.sessions` whose events the
backend routes to that writer, as the host does. "During" appends run inside the wrapped
`list()`, after it took its snapshot. Each search is `searchSessions({ query: 'needle', limit: 1 })`.
The test asserts these figures exactly for S = 1, 8 and 32 (all pass):

| Search | list() calls | whole-log reads | Result |
|---|---|---|---|
| cold index (first search), quiet store | 2 | S | ok |
| quiet store | 2 | 0 | ok |
| stored session appended between searches | 2 | 1 | ok |
| stored session appended once, during the first listing | 4 | 1 | ok (one retry) |
| stored session appended during every listing | 4 | 1 | `SESSION_QUERY_PERSISTENCE_FAILED` (two unstable attempts, `STABLE_OBSERVATION_ATTEMPTS` = 2) |
| next search after that failure | 2 | 1 | ok |
| quiet again | 2 | 0 | ok |
| cold index, one stored session appended during the first listing | 4 | S + 1 | ok |
| live-owned appending session: cold / quiet / appended between / once during / every listing / after / quiet | 2 / 2 / 2 / 4 / 4 / 2 / 2 | S−1 / 0 / 0 / 0 / 0 / 0 / 0 | every-listing case fails as above, all others ok |

list() calls per search are 2, or 4 when one retry runs, for every S: they do not grow
with S. Whole-log reads are bounded by the sessions whose revision changed, and a
live-owned session is never cold-read. The pristine rc.3 engine gives the same figures
in every row except the unstable cold pass: 2S whole-log reads (16 for S = 8, 64 for
S = 32) against S + 1 here, because the patched engine has already committed the first
attempt's sessions.

What one rc.3 list() call costs: rc.3's JSONL `list()` has no listing header cache
(`rc3:dsh-session-persistence-jsonl/src/index.ts:522-564`; it reads one header chunk and one
`stat` per stored session on every call), see `packages/sessions/docs/store-safety.md` (C1:
about 74 ms for 400 sessions cold on rc.4; about 80 ms for the ~430 sessions of the real store
on rc.3). An indicative timing in the rc.3 worktree (scratch probe, not kept; 400 stored
sessions of 8 events with 2 KiB text, about 6.6 MB, file index, two runs each):

| Engine | first search | of it, 2 × list() | quiet search | of it, 2 × list() |
|---|---|---|---|---|
| patched (vendored) | 755 / 760 ms | 84 / 84 ms | 104–110 ms | 56–59 ms |
| pristine rc.3 | 682 / 667 ms | 86 / 73 ms | 103–108 ms | 54–59 ms |

The first search is about 12 % slower with the patch (one `BEGIN IMMEDIATE`/`COMMIT` per
session instead of one per pass); quiet searches cost the same, and about half of a quiet
search is the two rc.3 list() calls.

## Persistence and session APIs the patch calls on rc.3

| Call | Where in the patch | rc.3 | Cost on rc.3 |
|---|---|---|---|
| `sessionPersistence.list({ signal })` | `_observeStable`, before and after each attempt | yes (rc.3 engine already calls it the same way) | no header cache: one header chunk + `stat` per stored session per call; 2 calls per search, 4 with a retry; unchanged by the patch |
| `readColdSessionLog(persistence, id, signal)` → `open(id, 'read')`, `read(0)`, `close()` | `_indexPersistedSession` | yes, same signature (rc.4 only adds the unused `persistedEventCount`) | one whole-log read per changed, not live-owned session; the JSONL cold-log memo keeps up to 2 decoded logs in both rc.3 and rc.4 (`COLD_LOG_MEMO_MAX_ENTRIES = 2`) |
| `ctx.sessions.list()`, `ctx.sessions.get(id)` | `_observeStable` | yes | in memory |
| `Session.snapshotEvents()`, `header`, `inheritedEventCount` | `observeLive` | yes; returns a frozen array | in memory; the patch no longer clones the events |
| `assertSessionHeadersCompatible`, `buildSessionEventSearchDocuments` | `_indexPersistedSession`, `observeSession` | yes; `sources.ts`, `documents.ts` and `extraction.ts` are byte-identical in rc.3 and the rc.4 base; `buildSessionEventSearchDocuments` takes `readonly SessionEvent[]` | unchanged |
| SQLite: `SELECT … FROM persisted_sessions`, `BEGIN IMMEDIATE`/`COMMIT` | `_indexedPersistedRows`, `_writeTransaction` | `node:sqlite`, same schema | one SELECT per attempt plus one in `_reconcile`; one transaction per changed session plus one final |

No call to `sessionProjections`, `brandString` or any API that rc.3 lacks.

## License (criterion 8)

```sh
shasum -a 256 $PKG/vendor/LICENSE.upstream $CLONE/LICENSE
# ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be  (both)
git -C $CLONE show dsh-v0.2.2-rc.3:LICENSE | shasum -a 256   # same hash: unchanged since rc.3
```

MIT License, Copyright (c) 2026 DeepSeek (upstream: <https://github.com/deepseek-ai/deepseek-harness>).
It covers the three vendored source files, the `src/engine/*.js` files generated from them,
the vendored spec and the patch file. The changes in them (the bounded-index patch of
commit `da482fcac4` and the spec's added cost block, both by anvilsong, this package's
author) are also MIT; the rest of the package is MIT, Copyright (c) 2026 anvilsong
(`LICENSE`).

## Re-run and clean-up

Recreate the worktree as above, copy the vendored files in, run the two `tsc` commands and
`pnpm vitest run packages/session-query/session-query-sqlite`, then remove it:

```sh
git -C $CLONE worktree remove --force /tmp/dsh-rc3-checkout-s2
git -C $CLONE worktree list     # only the main checkout
```

The worktree used for the figures above was removed after the run.
