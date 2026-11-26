# Rollout record (S10): final gate before the install on the real profile

Task S10 of plan 21d0cf72d308, written by a reviewer who produced no other task of the plan.
Recorded 2026-11-18 10:33Z–10:59Z with node v24.22.3 on macOS. Paths without a leading `/` are
relative to `packages/session-search-patched/`.

**Nothing was installed and the real profile was not touched**: no `dsh` CLI call, no host start, no
plugin manager use, no read, listing or hash of anything under `~/.dsh` or `~/.local/state`. The
install on the real profile is the lead's, after the user approves, following §6 and §7.

## 1. Verdict

| # | criterion | result |
|---|---|---|
| 1 | package suite passes; repo-wide run has no new failure (umask 022, 002, 077) | **holds**: package 151 tests, 147 pass, 4 skipped (opt-in), 0 fail; repo 1118 tests, 1113 pass, 5 skipped, 0 fail under all three umasks (before this task: 1108 / 1105 / 3 skipped / 0 fail under all three) — §3 |
| 2 | `node scripts/build.mjs --check` exits 0 | **holds**: `ok: src/engine matches a fresh generation`, exit 0 |
| 3 | generated engine differs from the shipped rc.3 engine only by the documented hunks; fail-safe claims attacked | **holds** (re-derived from the app's own files, §2); fail-safe review §4: no code defect, 3 medium findings (one doc error fixed, two rollout risks documented), new tests for the thin cases |
| 4 | changes only under the package, the checklist and one README row | **holds**: `git status --short` → ` M README.md`, `?? docs/session-search-patched-checklist.md`, `?? packages/session-search-patched/`; `git diff --stat README.md` → 1 insertion |
| 5 | exact rollback sequence written before any install, the one tested in S8 | **holds**: §7 |
| 6 | rollout plan: install mode with reasons, five before-searches, observations, abort criteria | **holds**: §6 |
| 7 | handoff and unverified claims | §9, §10 |

## 2. Independent re-derivation of the engine

From the installed app, not from the package's records (scratch folder `/tmp/ssp-s10`, removed at the end):

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
A="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"; P=dsh/node_modules/@deepseek-ai/dsh-session-query-sqlite
for f in src/index.ts src/query.ts src/schema.ts lib/index.js package.json; do npx --yes @electron/asar extract-file "$A" "$P/$f"; done   # one empty folder per file
shasum -a 256 *
patch -s -o patched-index.ts index.ts < $PKG/patches/engine-0.2.2-rc.3.diff          # exit 0, no .rej
```

| check | result |
|---|---|
| app files | `src/index.ts` 41094 B `72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3`, `src/query.ts` `b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48`, `src/schema.ts` `2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f`, `lib/index.js` `dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0`, `package.json` version `0.2.2-rc.3` |
| guard pins | `src/guard.js:21-26` `PINNED_VERSION` and the three `PINNED_SOURCES` values are **exactly** these hashes and this version (also asserted by the new opt-in test `test/review.test.mjs` with `SSP_RC3_EXTRACT`; a one-byte change to the extracted `query.ts` makes it fail) |
| patch | applies cleanly; result `cmp`-identical to `vendor/src/index.ts`, sha256 `0472dc2a080a719adef38ccecbfe20574b424763d4dc7938e6818c0c38c3fcdf`; `query.ts`, `schema.ts` identical to the app's; diffstat `1 file changed, 212 insertions(+), 68 deletions(-)`, 14 hunks |
| patch against its source commits | `diff <(git -C <clone> diff ca33fd6843 e1f2349309 -- packages/session-query/session-query-sqlite/src/index.ts \| grep '^[-+][^-+]') <(grep '^[-+][^-+]' patches/engine-0.2.2-rc.3.diff)` → only lines 68 and 203, `catch (_rollbackFailed) {` vs `catch {` (the documented rc.3/rc.4 delta, PROVENANCE "Commutation"); `e1f2349309` changes no engine source, only `persistedReadConcurrency: 1` in the bundle row |
| strip, by the package's generator | `node scripts/build.mjs --root <tmp>` on my patched file + the app's `query.ts`/`schema.ts`: `index.js`, `query.js`, `schema.js` **and** `manifest.json` byte-identical to `src/engine/` |
| strip, independently | Node's own `module.stripTypeScriptTypes(src, {mode: 'strip'})` plus the three `./query.ts`/`./schema.ts` → `.js` rewrites, without `build.mjs`: all three files identical to `src/engine/` |
| generated vs strip of the pristine app source | `diff` gives 36 change ranges, 68 `<` and 212 `>` lines, the **same ranges** as `diff app/index.ts vendor/src/index.ts`: nothing else differs |
| compiled app engine | S4's opt-in tests (`test/engine-artifact.test.mjs`, strip comparison and `lib/index.js` vs generated under stubs) pass against my extraction; the upstream suite ran with the compiled `lib/index.js` as a third engine (§3) |
| import specifiers of `src/engine` | the 8 bare host specifiers + `./query.js`, `./schema.js`; `node:sqlite` dynamic |

## 3. Test runs

| run | command | result |
|---|---|---|
| repo, before this task | `node --test packages/*/test/*.test.mjs` (umask 022 / 002 / 077) | 1108 tests, 1105 pass, 3 skipped, 0 fail, exit 0 (each ≈113 s) |
| repo, final | same | **1118 tests, 1113 pass, 5 skipped, 0 fail, exit 0** under 022, 002 and 077 |
| package, final | `node --test packages/session-search-patched/test/*.test.mjs` (each umask) | 151 tests, 147 pass, 4 skipped, 0 fail |
| package, all opt-ins | `DSH_UPSTREAM_DIR=/tmp/dsh-rc3-s10 SSP_RC3_EXTRACT=/tmp/ssp-s10/shipped node --test packages/session-search-patched/test/*.test.mjs` | 159 tests, 159 pass |
| generator | `node packages/session-search-patched/scripts/build.mjs --check` | `ok: src/engine matches a fresh generation`, exit 0 |
| upstream suite, once | `DSH_UPSTREAM_DIR=/tmp/dsh-rc3-s10 SSP_RC3_EXTRACT=/tmp/ssp-s10/shipped node --test packages/session-search-patched/test/upstream/*.test.mjs` | **9 tests, 9 pass, 0 fail, exit 0, 30 s**; C2: `sqlite.spec.ts` 92 passed, `identity.spec.ts` 1 passed; C3 confirms for 8 and 32 sessions (shipped source and compiled app engine alike): shipped cold pass `FAILED` with 16 / 64 reads, next search 8 / 32 reads, patched 9 / 33 then 0; an append between searches costs **1 read for every engine**. `git status --porcelain` of the worktree empty before and after |

The skipped tests are opt-in only: three need `SSP_RC3_EXTRACT`, one `DSH_UPSTREAM_DIR` (package), one
`DSH_UPSTREAM_DIR` (`packages/sessions`). rc.3 worktree: `git -C /Users/<user>/projects/deepseek-harness worktree add --detach /tmp/dsh-rc3-s10 dsh-v0.2.2-rc.3` (HEAD `38a6a5c965`),
`pnpm install --frozen-lockfile --ignore-scripts --prefer-offline` (6.3 s), the native addon copied from
`app.asar.unpacked` (sha256 `6c89a8ca…4c4b30`), removed at the end (§11).

## 4. Review of the fail-safe claims

Read: `src/index.host.js`, `src/guard.js`, `cordis.patch.yml` against the decision table
(`composition-spike.md` §13), plus the rc.3 sources of the plugin manager
(`packages/boot/plugin-manager/src/index.ts`), HMR (`packages/boot/hmr/src/index.ts`), app-boot
profile loading (`packages/boot/app-boot/src/profile.ts`, `profile-context.ts`), the patch engine
(`vendor/include/src/patch.ts`), the CLI argument parser (`apps/cli/src/args.ts`) and the search tool
(`packages/experimental/tool-session-query/src/`). Line numbers below are of those rc.3 files.

The entry matches the decision table: scope check first (`src/index.host.js:153-154`), guard on the
`pluginPackages.packageOf` version and three source hashes (`:156`, `src/guard.js:115-145`), patched
engine by dynamic import (`:44`, `:159`), shipped class with the same row config on guard, import,
construct or start failure (`:172-178`), nothing on a provider clash (`:165`, `:180`, `:145-150`), one
line per start (`:185-194`), `apply()` never rejects (`:204-212`). No code defect found.

### 4.1 Failure modes on the real profile and how the user would notice

| # | failure | effect | how it shows | evidence |
|---|---|---|---|---|
| a | **bundle order**: the session-search bundle is switched off and on after this install (it is appended after this bundle) | both patches skipped, the shipped row serves, **this row is not composed at all** (no log line) | the plugin list shows `include:optional-session-query-sqlite` active and no `include:session-query-sqlite-patched`; `--dump-config` stderr names both skipped patches | spike L2; `test/composition.test.mjs` |
| b | session-search bundle not selected | no group; search tools absent, as without this package | no session-search tool | spike L3; composition test |
| c | **profile or home row** `- id: optional-session-query-sqlite` with `disabled: false` (also what a row switch of the shipped row on the Plugins page writes) | two engines in the group; one wins the start, the other's fiber stays FAILED; search works | both entries listed as active; the entry's `error` line only in the logger buffer | spike L4/L5, T5; S8 §8; composition test; `test/review.test.mjs` (both start orders) |
| d | that override removed **while the host runs** | the clash is never retried: no engine, the tool row waits — **search dead until restart** | the session-search tool is missing or fails | spike T6; `test/review.test.mjs` |
| e | **profile or home row that replaces the group config wholesale** (`- id: optional-session-search` with `config: [...]`) | this row is dropped **with no warning**; the shipped row serves | only the absent entry `include:session-query-sqlite-patched` | new: `test/composition.test.mjs` (patch.ts:102-105 replaces the key) |
| f | the row switch of `session-query-sqlite-patched` turned off (Plugins page or a profile row) | no engine: **search dead** while the bundle stays | tool missing / pending | spike T4; composition test |
| g | **HMR hot apply** (install or rollback while the host runs) | four live runs (S1 T1/T2b, S8 §7.4 and §6) disposed the old provider ~16 ms before the new one started: no clash. If the order ever inverted, (d) would follow until the restart that the plan requires anyway | — | `test/review.test.mjs` models both orders |
| h | **a live reconcile is profile-wide** | `reconcileProfile()` (hmr/src/index.ts:917-976) compares every loaded module below the profile **and its linked package targets** (`profileRoots`, :1107-1116) with the disk and restarts the plugins whose files changed. `packages/sessions/src/{client,contract,service,store-index,trash}.js` changed at 01:03–01:19, after the live host started (00:13:47): a live install or a live rollback can stop and restart the sessions plugin (and run its start-time work) under the user's session, unless HMR already replaced those files | not observed (scratch homes had no other plugins); finding F3 |
| i | host upgrade (the updater `com.deepseek.dsh.ShipIt` is registered with launchd) | `engines.dsh` skips the whole bundle at profile load; the shipped row serves; the dependency stays | `dsh: skipping profile bundle "dsh-plugin-session-search-patched": … requirements {"engines.dsh":"0.2.2-rc.3"}` on the host's stderr; `dsh --version` | S8 a1b; with a version exemption the guard falls back to the shipped class (S8 a2) |
| j | patched engine fails to import or start | shipped class inside this row, identical results | only the `warn` line in the logger buffer | S8 a2/a3; entry tests |
| k | the shipped class not loadable too | no engine: search dead | tool fails; `error` line | entry tests (`fallback import failure …`) |
| l | **the entry itself fails to import** (syntax error or missing file in an edited or half-copied folder) | the patch still switches the shipped row off: **search dead** | tool missing; the entry listed failed | reasoned from the loader, not run (finding F2) |
| m | the package folder missing as a whole | the bundle is skipped at the next start, shipped serves; live, the loaded code keeps serving | `cannot resolve profile bundle` on stderr | S8 §7.2 |
| n | a second provider from another plugin | none of this repository's packages names `sessionQuery` or the group (grep over `packages/*`); unknown rows of the real profile behave as (c) | as (c) | grep |
| o | `--dump-config` on the real profile | rewrites `<profile>/cordis.yml` (spike §2); on a running host the HMR include refresh may re-read it (hmr/src/index.ts:462-474) | — | run it only with the host stopped |

### 4.2 Findings

| id | severity | where | finding | action |
|---|---|---|---|---|
| F1 | medium (doc, wrong claim) | `README.md:83-86` (was "between searches, an append costs one log read instead of all of them") | contradicted by `docs/verification.md` §5 (shipped "appended between" = 1 read), `vendor/PROVENANCE.md` cost table and my upstream run (shipped source and compiled app engine: 1 read). The benefit is after a failed pass (shipped re-reads 8/32 logs, patched 0) and during the cold pass | **fixed** in README |
| F2 | medium (design limit) | `cordis.patch.yml:8-10` disables the shipped row unconditionally; `src/index.host.js:29` imports `./guard.js` statically | the fallback covers failures inside `apply()` only; an entry that cannot import leaves the group without an engine. With a link install the host loads the working tree as it is at each start (and on HMR reconciles) | **documented** (README Limits, Install); rollout installs from a frozen copy (§6) |
| F3 | medium (rollout) | rc.3 `hmr/src/index.ts:917-976`, `:1107-1116`; `plugin-manager/src/index.ts:1102-1109`, `:1349-1359` | a live install or removal, through the plugin manager or through the CLI while the host runs (HMR watches `package.json`, `:384-407`), recomposes the whole profile and replaces other link plugins with changed files | **documented** (README Install); the recommended mode stops the host first |
| F4 | low–medium (silent skip) | rc.3 `vendor/include/src/patch.ts:102-105` | a later layer replacing the group config drops this row without a warning | **tested** (`test/composition.test.mjs`), README Limits |
| F5 | low (doc) | `README.md:210-216` (was "The Plugins page lists the rows of the bundle") | `bundleRows()`/`declaredRows()` (plugin-manager `:1293-1298`, `:1183-1213`) compose the bundle alone; this bundle then has no row of its own, so the page may list none under it and `requiredIds` is empty after install | **fixed** in README; tested |
| F6 | low (doc) | `README.md:236-238`; checklist `:59`, `:262-265` | the Plugins-page bundle switch is offered as a rollback, but only the hand edit of `dsh.profile.bundles` was exercised (S8 doubt) | README **fixed**; checklist **flagged** (outside this task's write scope) |
| F7 | low (checklist) | `docs/session-search-patched-checklist.md:118` | `dsh web --profile <profile>` is not a recorded command; `apps/cli/src/args.ts:206-208` turns the first word into `--profile web`, so `--profile` is given twice. The live host runs `dsh --profile web --no-open --port 3080 --trusted-host …` (`ps`) | **flagged** |
| F8 | low (checklist) | checklist `:22-26`, `:151`, `:254` | `--dump-config` rewrites the real profile's `cordis.yml`; do it with the host stopped (4.1 o) | **flagged** |
| F9 | info (known limit) | `src/index.host.js:145-150`, `:165`, `:180` | a clash is not retried (4.1 d) | **tested** (`test/review.test.mjs`), README Limits |
| F10 | info | `src/index.host.js:177` | the fallback runs the shipped class with the new row's config (`persistedReadConcurrency: 1`), not the shipped row's default 4; S8 a2/a3 gave identical results | none (decision table) |
| F11 | info | `README.md:70-74` | "peaks 205 to 369 MB" joins the lowest sampled peak (205.2) and the highest GC-trace peak (368.9) of `docs/verification.md` §8.2; both are peaks | none |
| F12 | info | rc.3 `tool-session-query/src/index.ts:53` | the search tool is cursor-free, so the cursor generation cannot tell the agent which engine runs; only the log line names the class | §6.4 |

### 4.3 Spot-check of the README and checklist against the records

| claim | where | record | result |
|---|---|---|---|
| heap table 512/1024/2048: patched 464/618/657 MB, shipped OOM/OOM/1899 (≈2.2 GB) | README 64-68 | verification §8.1 (464.3, 618.5, 657.2; OOM, OOM, 1898.5; 2199) | match |
| real copy: shipped aborts at 256, patched completes from 256 | README 70-74 | verification §8.2 | match (F11) |
| "an append costs one log read instead of all of them" | README 83-84 (old) | verification §5, PROVENANCE, my run | **mismatch, fixed** (F1) |
| 22 queries in 8.1 s against 129 s on an unknown-type session | README 96 | scratch-verification §7.3 | match |
| 14 hunks, +212/−68, `0472dc2a…c3fcdf` | README 325-326 | re-derived §2 | match |
| the exact log line of a passing guard | README 180, checklist 141 | `src/guard.js` `formatLine` + `checkHost` | match; now a test (`test/review.test.mjs`) |
| `installation rejected … nothing was installed` on another `engines.dsh` | README 109-111, checklist 99-101 | scratch-verification §7.1 a1 | match |
| install and rollback apply live ≈2–3 s; no clash, no failed row | README 141-144, 229-230 | scratch-verification §6 (2.9, 2.6, 3.2 s), §7.4 (2.3 s) | match (CLI path; the Plugins-page path F6) |
| rollback command and the inert symlink | README 232-251 | scratch-verification §6, spike §9 | match |
| 1.20 GB / 0.81 GB RSS; 22 queries, 1669 + 100 hits | checklist 186, 203-204 | scratch-verification §4 | match |
| 755 ms against 682 ms first search on 400 sessions | README 294-295 | PROVENANCE cost section | match |
| "141 tests: 139 pass, 2 skipped" | README 356 (Tests) | true before this task | updated to 151 / 147 / 4 |
| Plugins page lists the bundle's rows | README 210 (was 195) | none; rc.3 code says otherwise | **fixed** (F5) |
| `dsh web --profile <profile>` | checklist 118 | none | **flagged** (F7) |

## 5. Changes made by this task (each test was run against the unchanged code first)

| file | change |
|---|---|
| `test/review.test.mjs` (new, 9 tests, 1 opt-in) | live order of the two rows for install and rollback; the reverse start race (the new row first, the re-enabled shipped row fails, search keeps working); clash then the other provider leaving → no engine, nothing retried, one line, a new start of the row heals it; a second start after a fallback; the documented log line, fallback and clash texts equal what the code writes (README and checklist); opt-in `SSP_RC3_EXTRACT`: guard pins equal the extracted app files (negative control: one changed byte fails it) |
| `test/composition.test.mjs` (new, 1 test with 8 subtests, opt-in `DSH_UPSTREAM_DIR`) | the real rc.3 layers (base, web-app, session-search) and this patch composed with rc.3 `applyPatches()`: install order, flipped order, bundle absent, `disabled: false` override, config-only override, `include:` id, **wholesale group override (silent skip)**, **row-only disable (search dead)**, the plugin manager composing the bundle alone. Negative control: candidate B (`include:` ids) as `cordis.patch.yml` in a copy fails 7 of them. Kept out of `test/upstream/` so that suite still reports one skipped test without the checkout (S7 criterion 1) |
| `README.md` | F1 fixed; Install: profile-wide live reconcile, install from a folder you do not edit; Which engine is active: Plugins page (F5); Rollback: page switch not exercised (F6); Limits: entry must load, clash not retried, wholesale override; Tests: new counts and opt-ins |
| `docs/rollout-record.md` | this file |

No change to `src/`, `vendor/`, `scripts/`, `cordis.patch.yml` or `package.json`; `build.mjs --check` still exits 0.

## 6. Rollout plan for the lead

The live host: pid 48548, listening on 127.0.0.1:3080, started 00:13:47 as
`dsh --profile web --no-open --port 3080 --trusted-host <trusted-host>`
(`ps`: `…/MacOS/DeepSeek Harness --expose-internals …/dsh-desktop-host/lib/cli.js --profile web --no-open --port 3080 --trusted-host …`,
parent pid 1, no launchd job of its own; `/usr/local/bin/dsh` → `…/Contents/Resources/runtime/cli/bin/dsh`).
The lead's session runs inside this host: any restart ends the lead's current turn, and while the
host is down the lead cannot run anything.

### 6.1 Install mode: recommendation

**Recommended: B — stop the host, install with the CLI, start the host.** The user runs these steps in
a Terminal after the lead has finished §6.2 and ended its turn.

| | A: `plugin_manager install_bundle` on the running host, then an immediate restart | **B: stop the host, `dsh plugin --profile web add <abs path>`, start** |
|---|---|---|
| tested | never: `installBundle → selectBundle → hmr.reconcileProfile` (plugin-manager `:969-1113`) was not run in this plan; read only | **S8 H1→H2: the cold CLI install with the host stopped, then a start** |
| live side effects | a profile-wide hot reconcile inside the user's session (F3: the sessions plugin with files changed since 00:13 is restarted), the tool row goes down and up, a dispose-before-start window | none: every plugin loads once at the start |
| clash window | yes (4.1 g); harmless only because the restart follows | none: the shipped row is off from the start |
| dump check | would rewrite `cordis.yml` under a running host | safe with the host stopped |
| who acts | the lead, in-session (needs approval; a restart is still needed) | the user, by hand |
| live session | interrupted by the restart | interrupted by the stop |

Choose A only if the user wants the lead to run the install. Then: `install_bundle` with the
absolute folder path as `target`; check the result (`bundle` = `dsh-plugin-session-search-patched`,
`version` `0.1.0`, no failure, note `warnings` and any `restartReason`); end the turn at once; the user
restarts the host with B1 and B6 below; continue at §6.3.

### 6.2 Before (lead, with the user's approval for each read of the real profile)

1. **Frozen copy** (F2): after the commit gate, export the reviewed commit:
   `D=$HOME/dsh-local/session-search-patched-0.1.0; mkdir -p "$D" && git -C /Users/<user>/projects/dsh-plugins archive <commit> packages/session-search-patched | tar -x --strip-components=2 -C "$D"`,
   then `node "$D/scripts/build.mjs" --check` (exit 0) and `diff -r "$D/src" packages/session-search-patched/src` (empty).
   Installing straight from the working tree also works (S8), but then nobody may edit `src/` while it is installed.
2. `dsh --version` → `0.2.2-rc.3`, else **stop**.
3. Profile manifest (prints names only):
   `node -e 'const m=require(process.argv[1]);console.log(JSON.stringify(m.dsh.profile.bundles),Object.keys(m.dependencies??{}))' ~/.dsh/profiles/web/package.json`
   → must contain `@deepseek-ai/dsh-experimental-session-search` and must not contain `dsh-plugin-session-search-patched`. Keep the output.
4. Overrides (cases c and e of 4.1):
   `grep -n -e optional-session -e session-query -e session-search ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/cordis.patch.yml`
   → expected: no line (exit 1, or "No such file" for the home file). Any line → **stop** and review with the user.
5. Backups: `B=$HOME/dsh-rollout-backup-$(date +%Y%m%d); mkdir -p "$B" && cp -p ~/.dsh/profiles/web/package.json ~/.dsh/profiles/web/pnpm-lock.yaml "$B/"`.
6. **Five before-searches** with the shipped engine, through the session-search tool, raw results saved
   as `$B/before-1.txt` … `before-5.txt` (hit count and ordered session ids). Leave out the hits of the
   session that asks and of any session that changes before the after-run. Use query texts that S8 ran on
   a copy of this store (hits on the copy in brackets; today's store has grown):
   1. `plugin` with limit 20 (100 on the copy) — frequent;
   2. `插件` (3) — rare, CJK;
   3. `会话` (7) — CJK, two characters;
   4. a phrase of two or three words that only one old session holds (pick it from an old session;
      not one of today's session-search work, whose sessions contain this plan's words);
   5. `zzqxv-no-such-token-8731` (0) — no hit.
   Note the time of the first one, and if possible the host RSS after it:
   `ps -o pid=,rss= -p $(lsof -t -nP -iTCP:3080 -sTCP:LISTEN)`.
7. Write down where §6.3 continues, then end the turn and hand over to the user.

### 6.3 Steps (B)

```sh
PKG="$HOME/dsh-local/session-search-patched-0.1.0"   # or /Users/<user>/projects/dsh-plugins/packages/session-search-patched
B="$HOME/dsh-rollout-backup-YYYYMMDD"                 # the folder of §6.2 step 5
# B1 stop the host and wait until the port is free
kill -TERM $(lsof -t -nP -iTCP:3080 -sTCP:LISTEN); while lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null; do sleep 1; done
# B2 expect 0.2.2-rc.3
dsh --version
# B3 expect exit=0 and no "installation rejected"
dsh plugin --profile web add "$PKG"; echo "exit=$?"
# B4 expect "true link:…"; only this dependency is new (compare with §6.2 step 3)
node -e 'const m=require(process.argv[1]),b=m.dsh.profile.bundles;console.log(b.indexOf("@deepseek-ai/dsh-experimental-session-search")<b.indexOf("dsh-plugin-session-search-patched"),m.dependencies["dsh-plugin-session-search-patched"])' ~/.dsh/profiles/web/package.json
# B5 host stopped, so rewriting cordis.yml is safe: shipped row disabled: true, tool row, session-query-sqlite-patched; stderr without "not found"
dsh --profile web --dump-config > "$B/dump-after.txt" 2> "$B/dump-after.stderr.txt"; grep -n -A 24 'id: optional-session-search$' "$B/dump-after.txt"; cat "$B/dump-after.stderr.txt"
# B6 start the host as the user normally does; this is the observed command line, with stderr kept
nohup dsh --profile web --no-open --port 3080 --trusted-host <trusted-host> > "$B/host.out" 2> "$B/host.err" &
```

### 6.4 After the restart: what to observe

1. `$B/host.err`: no `skipping profile bundle "dsh-plugin-session-search-patched"`; `dsh --version` still `0.2.2-rc.3` (case i).
2. The plugin list (Plugins page, or `plugin_manager list_plugins`): `include:session-query-sqlite-patched`
   active, `include:optional-session-query-sqlite` **not** active, `include:optional-tool-session-query` active.
   Both engine entries active = case c; the new one absent = case a or e.
3. The session-search tool exists in a fresh session; the five searches in the same order: same counts and
   order as before (leaving out the sessions named in §6.2 step 6). Save `$B/after-1.txt` … `after-5.txt`.
4. Indicative: RSS after the first search below the before sample (S8 on the store copy: 1.20 GB shipped, 0.81 GB patched).
5. The log line (only proof of the class; case j looks identical otherwise): in the host's logger buffer,
   not on the terminal (S8 F2). Expected text:
   `session-search-patched: active engine: patched SqliteSessionQueryEngine (./engine/index.js); reason: host @deepseek-ai/dsh-session-query-sqlite 0.2.2-rc.3 and the sha256 of its src/index.ts, src/query.ts, src/schema.ts match the pinned values`.
   No verified way to read it on the real host; write "line not readable" if none is found.
6. Later, optional: checklist §7 (search during an appending session).

### 6.5 Abort criteria (each one → §7)

| when | criterion |
|---|---|
| before | version ≠ 0.2.2-rc.3; session-search bundle not selected; the package already listed; any override line in §6.2 step 4 (stop and review instead of installing); the before-searches already fail with an unknown-event-type or unreadable-session error (not fixed by this package) |
| install | B3 exit ≠ 0 or `installation rejected`; B4 not `true link:…` or another dependency changed; B5 with two enabled engines, no `session-query-sqlite-patched` or a `not found` warning for this package's patches |
| start | the host does not listen on 3080 within about a minute; `skipping profile bundle "dsh-plugin-session-search-patched"` |
| after | the session-search tool missing, pending or failing with an error the before-run did not give; case c or a/e in §6.4 step 2; any of the five searches different in count or order; a host abort or crash at any time |
| not an abort | RSS not lower (single samples); the log line not readable |

## 7. Rollback (written before any install; the commands S8 ran, §6 of scratch-verification.md)

```sh
# R1 host running (applies live in about 3 s; a profile-wide reconcile, F3), then restart with B1 and B6:
dsh plugin --profile web remove dsh-plugin-session-search-patched; echo "exit=$?"      # exit=0
# R2 host stopped (preferred after a failed start): the same command, then B6.
# Check (S8 grep, profile files only): no output, exit 1
cd ~/.dsh/profiles/web && grep -rn --exclude-dir=node_modules -e dsh-plugin-session-search-patched -e session-query-sqlite-patched .
# The symlink node_modules/dsh-plugin-session-search-patched may stay; it is inert.
```

- **R3**, if `remove` itself fails (host stopped): take the name out of `dsh.profile.bundles` only — the
  "disable" that S8 tested by editing the same field (H2 → H3: shipped row back live and after a restart):
  `node -e 'const f=process.argv[1],fs=require("fs"),m=JSON.parse(fs.readFileSync(f,"utf8"));m.dsh.profile.bundles=m.dsh.profile.bundles.filter(b=>b!=="dsh-plugin-session-search-patched");fs.writeFileSync(f,JSON.stringify(m,null,2)+"\n")' ~/.dsh/profiles/web/package.json`
  (the file's formatting may change), then B6; run R2 later to drop the dependency.
- **R4**, last resort, not tested: with the host stopped, copy `$B/package.json` and `$B/pnpm-lock.yaml` back, then B6.
- After rollback: searches 1 and 4 equal the before-files; the plugin list shows `include:optional-session-query-sqlite` active again.
- Never disable only the row `session-query-sqlite-patched` (case f), and do not use the Plugins-page
  switches for rollback unless the CLI is unavailable (untested path, F6). A reinstall after R3 needs
  `plugin_manager set_bundle` or the CLI, not `install_bundle` (it refuses an installed dependency with
  HMR on, plugin-manager `:983-985`).

## 8. Known limits (unchanged by this task)

Only rc.3; one unreadable or unknown-type session still fails search (same clean error); the
two-attempt limit stays (C3 boundary); the heap floor follows the largest logs; `:memory:` index RSS
grows with the store; no fallback at search time; clash not retried (F9); entry must load (F2); the
wholesale override and the bundle-order flip skip the swap without a log line (a, e).

## 9. Handoff note

- The package is ready to install under the plan in §6 and §7; the artifact equals the app's rc.3 engine
  plus exactly the documented patch, and the guard pins equal the installed app's files.
- The lead commits at the gate: the new tests, the README changes and this file (list in §5).
- The checklist (`docs/session-search-patched-checklist.md`) still has F6, F7 and F8; fix them in its
  own task or read them together with this file.
- After a resume of the lead's session: an active goal must be resumed explicitly; the before-files
  are in `$B`, the observations to make are §6.4.

## 10. Claims I could not verify

1. Anything about the real profile: its `dsh.profile.bundles` order, its `cordis.patch.yml`, a home
   `~/.dsh/cordis.patch.yml`, whether a row already overrides the group or the shipped row (cases c, e) —
   not read by rule; §6.2 steps 3–4 settle it.
2. The plugin manager's `install_bundle`, `set_bundle` and `remove_bundle` paths at runtime (code read only).
3. That a live reconcile restarts other link plugins (F3), and whether the live host already hot-replaced
   the changed `packages/sessions` files: code read only.
4. That an entry which fails to import leaves search dead (F2): reasoned, not run (no host allowed here).
5. How to read the logger buffer on the real host; what the Plugins page shows per row (F5 is from code).
6. Whether the host prints the patch-skip warnings of cases a/e to its stderr at start (the dump does).
7. Whether ShipIt has an update waiting that would apply at the restart (case i covers the outcome).
8. Behaviour with real streaming sessions (the appending case is a model, S7 C3).
9. The `--trusted-host` start command of the user: observed from `ps`, not from the user.
10. That `dsh web --profile x` passes `--profile` twice (F7): read in `args.ts`, not run.

## 11. Clean-up and files

```sh
git -C /Users/<user>/projects/deepseek-harness worktree remove --force /tmp/dsh-rc3-s10
git -C /Users/<user>/projects/deepseek-harness worktree prune
rm -rf /tmp/ssp-s10                     # extraction, re-derivation roots, run logs
```

| file | written by this task |
|---|---|
| `docs/rollout-record.md` | yes (new) |
| `test/review.test.mjs` | yes (new) |
| `test/composition.test.mjs` | yes (new) |
| `README.md` | edited (§5) |
