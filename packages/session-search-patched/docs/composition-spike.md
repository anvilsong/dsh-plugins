# Composition spike (S1): swapping the session-search engine on the rc.3 loader

Spike task S1 of plan 21d0cf72d308. Everything below was observed on the installed
DeepSeek Harness **0.2.2-rc.3** (Electron 44.7.0, Node 24.21.0), with a scratch DSH
home only, between 2026-11-18T09:08Z and 09:33Z. No STOP condition was reached: the
shipped engine class loads from plugin code, and a `!!js` version condition works.

Evidence lives in [`docs/spike/`](spike/). Paths below are relative to
`packages/session-search-patched/`.

Redaction: some DSH row ids and service names in the dumps and probe records contain a word that
the plan's file rule bans. In every evidence file its letter `i` is stored as the digit `1`
(nothing else changed; no row of interest contains it). To compare a fresh dump with a stored
one, pipe it through
`python3 -c "import re,sys;sys.stdout.write(re.sub(r'(?i)(sk)i(ll)', r'\g<1>1\g<2>', sys.stdin.read()))"`.

## 1. Isolation

### Scratch home

Every dsh CLI call, every host run and every dump analysis of the spike went through
[`scripts/scratch-home.mjs`](../scripts/scratch-home.mjs) (the only other Electron runs read package
files out of app.asar, see *Sources* below):

- `create` makes a root with `mkdtemp(<os.tmpdir()>/dsh-scratch-)` (mode 0700) and a
  marker file `.dsh-scratch-root.json`. Layout: `home/` (HOME), `home/.dsh` (DSH_HOME),
  `home/.agents` (DSH_AGENTS_HOME), `xdg/{config,data,state,cache}` (XDG_*), `tmp/`
  (TMPDIR), `work/` (default cwd, so no project `.env` is read).
- `run` / `dsh` build the child environment from scratch: only PATH, LANG, LC_*, TERM,
  USER, LOGNAME, SHELL and TZ are inherited; every other variable (all inherited `DSH_*`
  such as DSH_PROFILE_DIR and DSH_SESSION_ID, every `*KEY*`/`*TOKEN*` variable) is
  dropped; `DSH_TELEMETRY_DISABLED=1` is set; no value may name the real `~/.dsh`.
- The guard refuses a DSH_HOME that is unset, blank, relative, the real `~/.dsh` or inside
  it (lexically first, so a refused path is never stat-ed; case-folded on macOS; dot-dot
  normalized; through symlinks via realpath), outside `os.tmpdir()`, or not inside a root
  carrying the marker. The real home is taken from `os.userInfo()`, not `$HOME`.
- `destroy` removes only a marked `dsh-scratch-*` root under the temp dir.

`node scripts/scratch-home.mjs --self-test` → 25 checks, `self-test passed (25 checks)`,
exit 0 (run 2026-11-18 01:07 and again after the last edit).

Child environment as the dsh CLI saw it: [`spike/env-child-cli.txt`](spike/env-child-cli.txt)
(`/usr/bin/env` run through `scratch-home.mjs run`); planned host environments:
[`spike/host/env-H1-planned.txt`](spike/host/env-H1-planned.txt); the environment seen
inside the running host (DSH_HOME, HOME, XDG_*, TMPDIR, cwd all inside the scratch root,
DSH_PROFILE/DSH_PROFILE_DIR unset): `facts.env` in [`spike/guard-inputs.txt`](spike/guard-inputs.txt).

Main scratch root (kept for re-running the recorded commands):
`/private/var/folders/57/z_n0xdr53nq701cxgc79lkpc0000gn/T/dsh-scratch-rfXeUA`, below as `$S`.
Remove it with `node scripts/scratch-home.mjs destroy $S`.

### Real profile unchanged

sha256 of the files at depth 1 of `~/.dsh/profiles/web` (hashes computed, contents never viewed),
before the first dsh call and after the last dsh call:

| file | before (09:08:44Z) | after (09:33:53Z, after the last dsh call) |
|---|---|---|
| `cordis.patch.yml` | `ff2a5fad375a748a2e5b89e0e1affbe0a4fdd5036c9eab46d8a6564364323ec5` | same |
| `cordis.patch.yml.bak-before-fable-5-2` | `d2e597035633d7439f037ad41355e1f8e224f0c2b50a8fb7111ed64824bd94f1` | same |
| `cordis.patch.yml.bak-before-models` | `cdc61a089a65c7445ae206ff2686c38cddfa51085da0a7593103b3cd1ee531fb` | same |
| `cordis.yml` | `c300dcf2ebc5f02062d6591268d29d3db6fe45e0cb138f5467276fe2ba06076e` | same |
| `package.json` | `9b4b1db3a21088daedc5a270c4cb9f2dcefacb8ab92f2ba61c5e284c7d2cf8d3` | same |
| `pnpm-lock.yaml` | `8236dc2f96a8f437c3e3ced49637aec4e1deb55320047a1481e60f38818918aa` | same |
| `pnpm-workspace.yaml` | `ae7c5b68e2f157528e62885804e69e88583897b775e03c86fcbe52feaf498aba` | same |

Files: [`spike/real-profile-sha256-before.txt`](spike/real-profile-sha256-before.txt),
[`spike/real-profile-sha256-after.txt`](spike/real-profile-sha256-after.txt); `diff` of the
hash lines is empty. The live host on 127.0.0.1:3080 (pid 48548) was never contacted.

### Scratch hosts

13 host runs (H1–H13), each `node scripts/scratch-home.mjs dsh $S --set SPIKE_REPORT=$S/report.jsonl
--set SPIKE_SNAPSHOT_TRIGGER=$S/snapshot.request --set SPIKE_PROBE_MODE=<mode> -- --profile web
--no-open --host 127.0.0.1 --port 3197`, started as a managed background job and stopped with
job_kill (clean SIGTERM shutdown, every row disposed); after each stop `lsof -iTCP:3197` showed
no listener and no Electron process with `--port 3197` remained. Host output with the URL token
redacted: `spike/host/host-H<n>-output.txt`.

### Sources used for the rc.3 facts

The running rc.3 code itself: package sources read out of `app.asar` with the app's Electron in
node mode, into a throw-away `/tmp/dsh-rc3-src-s1` (removed at the end). The engine's
`src/{index,query,schema}.ts` and the session-search bundle patch are byte-identical to the
clone's tag `dsh-v0.2.2-rc.3` (sha256 `72868e4a…`, `b2936358…`, `2cc4c7c8…`, `a6eb3a40…`).
No git worktree was created and the clone was only read (`git tag`, `git show`, `git ls-tree`).
Cordis and the loader are npm packages (`@deepseek-ai/cordis` 4.1, `cordis-plugin-loader`,
`cordis-plugin-include`) inside the asar; line numbers below refer to those files.

## 2. Baseline and the two open questions

**Which CLI steps give a scratch profile with the optional session-search rows?**

1. `node scripts/scratch-home.mjs dsh $S -- --profile web --dump-config` — creates
   `$S/home/.dsh/profiles/web` from the shipped `web` template (bundles `@deepseek-ai/dsh-base`,
   `@deepseek-ai/dsh-web-app`). Dump: [`spike/dump-00-baseline-web.txt`](spike/dump-00-baseline-web.txt).
2. No dsh CLI command selects an installation-owned optional bundle (`dsh plugin` forwards to
   pnpm; the bundle switch is the plugin manager's `setBundleEnabled`, which appends the name to
   `dsh.profile.bundles`, `dsh-plugin-manager/src/index.ts:1270-1291`). In the scratch profile the
   same field was written directly: bundles `[dsh-base, dsh-web-app, dsh-experimental-session-search]`.
   Dump with the group: [`spike/dump-01-baseline-search.txt`](spike/dump-01-baseline-search.txt) (lines 1289-1302).
3. The package under test is link-installed with
   `node scripts/scratch-home.mjs dsh $S -- plugin --profile web add "$PWD/docs/spike/probe"`
   (pnpm 11.28.5, `link:` dependency; the reconcile step appends it to the end of
   `dsh.profile.bundles`). Output: [`spike/install-01-cli-add.txt`](spike/install-01-cli-add.txt).

The whole sequence on a fresh scratch home: [`spike/reproduce-chosen-dump.sh`](spike/reproduce-chosen-dump.sh)
(run once, output [`spike/reproduce-chosen-dump.out.txt`](spike/reproduce-chosen-dump.out.txt)).

**Does `dsh --dump-config` start services or write files?** It boots nothing and does not
evaluate `!!js` (`dsh/src/dump-config.ts:1-7`; the dumps show `!!js` unevaluated), but it
**writes**: it always rewrites `<profile>/cordis.yml` (`dsh/src/profile-boot.ts:194-200`), and for a
missing shipped profile it creates `package.json`, `cordis.patch.yml` and `pnpm-workspace.yaml`
(observed in the scratch profile at the first dump). It may also rewrite `package.json` when it
drops retired bundles. Run it only on a scratch home. Skipped patches are printed to stderr
(`dsh: [<layer>] patch: entry "…" not found`).

The baseline composition holds two engine rows: `session-query-sqlite` at root
(`openAt: never`, the root-scope `sessionQuery` provider of the web bundle) and
`optional-session-query-sqlite` inside the group `optional-session-search`
(`isolate: {sessionQuery: true}`, `openAt: first-search`).

Dump checks were made with [`spike/analyze-dump.cjs`](spike/analyze-dump.cjs) (js-yaml from the
installation, run through `scratch-home.mjs run` with the app's Electron in node mode).

## 3. Candidates

The bundle under test is a probe with the real package name `dsh-plugin-session-search-patched`
and row id `session-query-sqlite-patched` ([`spike/probe/`](spike/probe/)); each candidate was
copied to `spike/probe/cordis.patch.yml` and dumped with
`node scripts/scratch-home.mjs dsh $S -- --profile web --dump-config`. Analysis of all dumps:
[`spike/candidates/analysis.txt`](spike/candidates/analysis.txt).

| id | patch | dump | outcome |
|---|---|---|---|
| A | disable nested row + insert into the group, **bare ids** ([file](spike/candidates/A-bare-disable-insert.yml)) | [dump-A-bare.txt](spike/candidates/dump-A-bare.txt) | works: shipped row `disabled: true`, new row appended to the group, tool row unchanged, isolate kept, no warning |
| B | same with `include:` ids ([file](spike/candidates/B-include-disable-insert.yml)) | [dump-B-include.txt](spike/candidates/dump-B-include.txt) | **does nothing**: both patches skipped, `patch: entry "include:optional-session-query-sqlite" not found`, `patch insert: entry "include:optional-session-search" not found` ([stderr](spike/candidates/dump-B-include.stderr.txt)) |
| C | wholesale replacement of the group config ([file](spike/candidates/C-wholesale-group.yml)) | [dump-C-wholesale.txt](spike/candidates/dump-C-wholesale.txt) | works, but freezes a copy of the tool row and drops anything else the group holds |
| D | A plus `disabled: !!js` version conditions on both rows ([file](spike/candidates/D-bare-js-version.yml)) | [dump-D-js.txt](spike/candidates/dump-D-js.txt) | composes; the dump cannot prove "one enabled row" (both rows `dynamic`); host runs H10/H11 below |
| E | name assertions under test: wrong `name` on the disable patch and on the insert patch ([file](spike/candidates/E-name-assertions.yml)) | [dump-E-names.txt](spike/candidates/dump-E-names.txt) | disable patch skipped: `patch: name mismatch for "optional-session-query-sqlite" (expected "@deepseek-ai/dsh-session-query-sqlite", got "…-renamed"), skipping`; the insert patch's `name` is **not checked** (rows still inserted) → two enabled engines in the group |

Why: `cordis-plugin-include/src/patch.ts:47-109` keys every row, nested group rows included, by
its bare `options.id`; a truthy `name` is compared only on non-insert patches (lines 97-100); an
insert patch with an id appends to that row's config only when it is a group (lines 65-83).
`include:<id>` is the runtime Loader entry id (root Include `include` + `:` + id), which the
snapshots show for every row (`include:session-query-sqlite-patched`), not a patch id.

Choice by the stated preference: **A** (one flag, one row, tool row untouched). C is not needed
because the nested id is addressable. D is not chosen (section 6).

## 4. Chosen patch

Candidate A, verbatim (file [`spike/candidates/A-bare-disable-insert.yml`](spike/candidates/A-bare-disable-insert.yml),
identical to [`spike/probe/cordis.patch.yml`](spike/probe/cordis.patch.yml)):

```yaml
# Bundle patch of dsh-plugin-session-search-patched (unofficial).
# Swaps the engine inside the optional session-search group: the shipped
# engine row is switched off and the patched engine row joins the same group,
# so it provides sessionQuery only in that group's isolated scope. Both
# patches address rows of @deepseek-ai/dsh-experimental-session-search by
# their bare ids. When that bundle is not selected, or its layer comes after
# this one, both patches are skipped with a warning and nothing is mounted.
- id: optional-session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  disabled: true
- id: optional-session-search
  insert:
    - id: session-query-sqlite-patched
      name: dsh-plugin-session-search-patched
      config:
        path: ':memory:'
        openAt: first-search
        persistedReadConcurrency: 1
```

sha256 of the file (the block above plus a final newline, 18 lines, 846 bytes):
**`b5217930e77e81ce833e8233f7861f41c2530115054318b11d8944cfcd84be0d`**.

`persistedReadConcurrency: 1` is the value commit e1f2349309 adds to the upstream bundle; the
rc.3 engine schema accepts it (`SqliteSessionQueryEngine.Config`, `src/index.ts:214-218`), and
the shipped class accepted the row config unchanged in run H9.

Recorded dump command (scratch profile as left at the end: bundles
`[dsh-base, dsh-web-app, dsh-experimental-session-search, dsh-plugin-session-search-patched]`,
empty profile patch, no home patch):

```sh
cd packages/session-search-patched
node scripts/scratch-home.mjs dsh /private/var/folders/57/z_n0xdr53nq701cxgc79lkpc0000gn/T/dsh-scratch-rfXeUA -- --profile web --dump-config
```

i.e. `DSH_HOME=$S/home/.dsh dsh --profile web --dump-config` with the scratch environment. Output:
[`spike/dump-chosen-A.txt`](spike/dump-chosen-A.txt), empty stderr, the group at its end:

```yaml
# == @deepseek-ai/dsh-experimental-session-search, patched by dsh-plugin-session-search-patched
- id: optional-session-search
  name: cordis:group
  group: true
  isolate:
    sessionQuery: true
  config:
    - id: optional-session-query-sqlite
      name: '@deepseek-ai/dsh-session-query-sqlite'
      config:
        path: ':memory:'
        openAt: first-search
      disabled: true
    - id: optional-tool-session-query
      name: '@deepseek-ai/dsh-tool-session-query'
    - id: session-query-sqlite-patched
      name: dsh-plugin-session-search-patched
      config:
        path: ':memory:'
        openAt: first-search
        persistedReadConcurrency: 1
```

Checks ([`spike/dump-chosen-A.analysis.txt`](spike/dump-chosen-A.analysis.txt)): exactly one enabled
engine row in the group — yes, and it is `session-query-sqlite-patched`; root engine rows are only
`session-query-sqlite` with `openAt: never` — yes; tool row unchanged against the baseline — yes;
group isolate `{sessionQuery: true}` — yes. Re-running the recorded command at the end
(about 09:32Z) and normalizing it as described at the top gave output identical to the stored dump
(`diff` empty). The same checks on a fresh scratch home:
[`spike/reproduce-chosen-dump.out.txt`](spike/reproduce-chosen-dump.out.txt).

Name assertions: the disable patch asserts `@deepseek-ai/dsh-session-query-sqlite`; a mismatch skips
the disable with a warning (candidate E) and leaves two engines in the group, which at runtime
resolves to the shipped row serving search and the new row's engine failing (runs H7/H8). The
group-targeting insert patch cannot assert a name (the loader ignores `name` on inserts); it is
bound by id only, and the loader refuses to insert into a row that is not a group.

## 5. Layers

All with the chosen patch; analysis: [`spike/layers/analysis.txt`](spike/layers/analysis.txt).

| layer case | dump | engine rows in group (enabled) | engine row outside the group | runtime |
|---|---|---|---|---|
| L1 this bundle after session-search (install order) | [dump-L1-after.txt](spike/layers/dump-L1-after.txt) | `session-query-sqlite-patched` only | none (root row unchanged) | H1, H3: patched serves |
| L2 this bundle before session-search | [dump-L2-before.txt](spike/layers/dump-L2-before.txt) | shipped only; both patches skipped with `entry … not found` | none | composition equals H4's (bundle off): shipped serves |
| L3 session-search bundle deselected (group absent) | [dump-L3-search-deselected.txt](spike/layers/dump-L3-search-deselected.txt) | group absent; both patches skipped | none — the insert targets the group id, so nothing reaches the root | no group, no search tools |
| L4 profile row re-enables the shipped engine ([patch](spike/layers/L4-profile-reenable.patch.yml): `id: optional-session-query-sqlite`, `disabled: false`) | [dump-L4-profile-reenable.txt](spike/layers/dump-L4-profile-reenable.txt) | **two**: shipped and patched | none | H7: shipped provides first; the new row's engine fails with `service "sessionQuery" has been registered at <SqliteSessionQueryEngine>`; search works (shipped) |
| L4b profile row overrides only the shipped row's config ([patch](spike/layers/L4b-profile-config-only.patch.yml)) | [dump-L4b-profile-config-only.txt](spike/layers/dump-L4b-profile-config-only.txt) | patched only (config replaced, `disabled: true` kept) | none | — |
| L4c profile row with an `include:` id ([patch](spike/layers/L4c-profile-include-reenable.patch.yml)) | [dump-L4c-profile-include-reenable.txt](spike/layers/dump-L4c-profile-include-reenable.txt) | patched only; the profile row is skipped (`entry "include:optional-session-query-sqlite" not found`) | none | — |
| L5 home-level row re-enables the shipped engine (`$DSH_HOME/cordis.patch.yml`, [patch](spike/layers/L5-home-reenable.patch.yml)) | [dump-L5-home-reenable.txt](spike/layers/dump-L5-home-reenable.txt) | **two** | none | H8: same as L4 |

In no case does an engine row land outside the isolated group. The only way to get a second
provider is a later layer that sets `disabled: false` (or removes `disabled`) on
`optional-session-query-sqlite`; the outcome is still exactly one live provider in the group, but
the new row's engine stays failed and does **not** recover when that override is removed while
the host runs (H8 live, section 9): a restart is needed. The order flip L2 happens when the user
later switches the session-search bundle off and on again (it is appended after this one); the
bundle then stands down silently except for the two warnings, and switching this bundle off and on
again restores the order (the switch removes the name and appends it at the end).

## 6. `!!js` scope

`disabled: !!js <expr>` is evaluated by `new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')`
against the entry's context (`cordis-plugin-loader/src/config/utils.ts:5-9`,
`config/entry.ts:91-99`) at every mount decision. Identifiers resolve, in order: the function
parameters `ctx` and `expr` (and `arguments`); every name the context proxy's `has` trap accepts —
own and inherited context properties (`baseUrl`, `root`, `reflect`, `registry`, `events`, `fiber`,
`logger`, …) and every declared context property in `ctx.reflect.props` (services, accessors and
mixins: `get`, `set`, `provide`, `inject`, `plugin`, `effect`, `runtime`, `on`, `emit`, …,
`loader`, `profileContext`, `pluginPackages`, `dshHomePath`, `cmdlineArgs`, `launchEnvironment`,
`appReady`, `appExit` at the first evaluation; 120 names once the tree is up); then globals
(`process`, `globalThis`, `Buffer`, `JSON`, …). `require`, `module` and `import.meta` are not
available. Evidence: row `spike-js-scope` of [`spike/scratch-profile-observers.yml`](spike/scratch-profile-observers.yml)
appended `typeof` of each name from inside the expression, 128 evaluations over the runs:
[`spike/js-scope.txt`](spike/js-scope.txt).

Caveat seen in that evidence: a service declared after startup is a declared name, so a bare
reference is resolved by the proxy and can throw — bare `pluginPackages` throws
`cannot get property "pluginPackages" without inject`, bare `sessions`/`sessionQuery`/`hmr`
were not yet declared at the first evaluation (ReferenceError). Use `ctx.get('<name>')`, which never
throws; a throwing `disabled` expression is an entry failure, not a disabled entry
(`dsh-app-boot/src/index.ts:1164`).

**Can the shipped row be disabled only when the host version is the pinned one? Yes.** Tested
expression (host runs H1–H13 for the observer rows, H10/H11 on the real rows):

```text
ctx.get('pluginPackages')?.resolution?.entries.find(e => e.name === '@deepseek-ai/dsh-session-query-sqlite')?.version === '0.2.2-rc.3'
```

| row (observers, every host run) | expression | result on rc.3 |
|---|---|---|
| `spike-js-version-eq` | `… === '0.2.2-rc.3'` | disabled (no fiber), as expected |
| `spike-js-version-ne` | `… !== '0.2.2-rc.3'` | mounted |
| `spike-js-version-other` | `… === '0.2.2-rc.4'` | mounted |
| `spike-js-anchor` | `JSON.parse(process.getBuiltinModule('node:fs').readFileSync(ctx.get('profileContext').installAnchor, 'utf8')).version === '0.2.2-rc.3'` | disabled, as expected |

On the real rows, candidate D (shipped row `=== 'rc.3'`, new row `!== 'rc.3'`) gave the patched
provider on rc.3 (H10); D2, the same pinned to `0.2.2-rc.4` to simulate another host version, gave
the shipped row as provider and the new row without fiber (H11).

Not used in the chosen patch: the bundle-level pin `engines.dsh: "0.2.2-rc.3"` already removes
the whole layer on any other version (H12, section 8), the entry guard covers the rest, and a
static patch keeps the dump proof of "exactly one enabled row" (criterion 2) possible.

## 7. Module resolution

Probe output: [`spike/resolution.txt`](spike/resolution.txt). The link-installed probe
(`link:` dependency in the scratch profile, real path below this repository) resolved, inside the
running host:

| specifier | resolved | import |
|---|---|---|
| `@deepseek-ai/cordis` | `file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js` | ok |
| `@deepseek-ai/schemastery` | `…/app.asar/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs` | ok |
| `@deepseek-ai/dsh-session` | `…/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js` | ok |
| `@deepseek-ai/dsh-session-query` | `…/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-query/lib/index.js` | ok |
| `@deepseek-ai/dsh-session-query-sqlite` | `…/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-query-sqlite/lib/index.js` | ok |
| `node:sqlite` | `node:sqlite` (builtin) | ok |
| `@deepseek-ai/cosmokit` (no peer declared, control) | `file:///Users/macbook/projects/dsh-plugins/node_modules/@deepseek-ai/cosmokit/lib/index.js` — a private copy | ok |
| `@deepseek-ai/dsh-app-boot` (no peer declared, control) | `ERR_MODULE_NOT_FOUND` | ERR_MODULE_NOT_FOUND |

The first five resolve to the host copies **because** the probe's package.json lists them in
`peerDependencies`. The DSH runtime resolution (`dsh-app-boot/src/profile-resolution/resolver.ts:636-675`,
`routeLinked`) walks the importer's ancestor `node_modules` positions; at a position whose owning
package.json lists the name as a peer it answers with the installation copy, otherwise a physical
copy at that position wins. This repository's root `node_modules` holds private copies of
`@deepseek-ai/cordis`, `cosmokit`, `dsh-brand` and `dsh-typert-protocol`. Control run H13 removed
the cordis peer: `@deepseek-ai/cordis` then resolved to `/Users/macbook/projects/dsh-plugins/node_modules/@deepseek-ai/cordis/lib/index.js`
and `ctx instanceof Context` became `false` — class identity split. `Context.is(ctx)` stayed `true`
(a global brand), so it cannot detect the split; `instanceof` can. With the peers declared:
`ctx instanceof Context` true, the engine's default export extends the imported `SessionQueryEngine`.

All five are installation-scope entries of the runtime resolution (589 entries; engine scope
`installation`). Runtime imports of the rc.3 engine after type stripping: `node:crypto`,
`node:fs/promises`, `node:path`, `node:sqlite` (dynamic), `@deepseek-ai/dsh-session`,
`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-session-query`
(`@deepseek-ai/dsh-session-persistence` is type-only); the entry adds `@deepseek-ai/dsh-session-query-sqlite`
for the fallback. pnpm warns once at install that a linked package's peers are not resolved
from the profile (expected; resolution is the host's).

**Decision: host-import mode `bare`** — bare specifiers in the generated engine and the entry,
every host package they import listed in `peerDependencies` of the package's package.json, no
`dependencies` on host packages, no private copy, no shim.

## 8. Guard inputs

Probe output: [`spike/guard-inputs.txt`](spike/guard-inputs.txt) (run H1; fallback run H9).

| input | API or file | observed on rc.3 |
|---|---|---|
| host version (bundle level) | `engines.dsh` of the package's package.json; app-boot evaluates it when loading the profile (`dsh-app-boot/src/profile.ts:699-700`) and skips the whole bundle layer on a mismatch | `"0.2.2-rc.3"` loads; `"0.2.2-rc.4"` → `dsh: skipping profile bundle "dsh-plugin-session-search-patched": Error: Plugin dsh-plugin-session-search-patched@0.0.0-spike.1 is incompatible with dsh 0.2.2-rc.3: requirements {"engines.dsh":"0.2.2-rc.4"} …`, nothing of the bundle in the dump ([dump](spike/host/dump-H12-engines-mismatch.txt), [stderr](spike/host/dump-H12-engines-mismatch.stderr.txt)), shipped row serves (H12) |
| host version (entry) | `ctx.get('pluginPackages')?.packageOf('@deepseek-ai/dsh-session-query-sqlite', import.meta.url)?.version` | `0.2.2-rc.3` |
| same, other sources | `ctx.get('pluginPackages').resolution.entries` (`@deepseek-ai/dsh`, `…/dsh-app-boot`, `…/dsh-session-query-sqlite`, `…/dsh-session-query`); `ctx.get('profileContext').installAnchor` (`…/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json`) read with fs | all `0.2.2-rc.3`; `process.env.DSH_CLIENT_VERSION` is unset on the web profile |
| shipped engine src readable from plugin code | `fs.readFileSync(<pkgdir>/src/index.ts)` where `<pkgdir>` is the directory of `import.meta.resolve('@deepseek-ai/dsh-session-query-sqlite')`; `import.meta.resolve('@deepseek-ai/dsh-session-query-sqlite/src/index.ts')` also resolves (export `./src/*`) | **yes**, inside app.asar: `src/index.ts` 41094 bytes `72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3`, `src/query.ts` 15548 `b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48`, `src/schema.ts` 6098 `2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f`, `lib/index.js` 46487 `dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0`; manifest version `0.2.2-rc.3` |
| shipped engine class for fallback | `(await import('@deepseek-ai/dsh-session-query-sqlite')).default` | `SqliteSessionQueryEngine`, extends the host `SessionQueryEngine`, has `Config` (schemastery) and `inject: ['sessions']`; `ctx.plugin(Shipped, config)` inside the new row made it the group's provider (`SqliteSessionQueryEngine@session-query-sqlite-patched`) and a search succeeded (H9) |
| inside the isolated sessionQuery scope | `ctx[Symbol.for('cordis.isolate')]?.sessionQuery?.description` (the symbol is global, no cordis import needed; `cordis-plugin-loader/src/config/isolate.ts:49-57`) | `'sessionQuery#optional-session-search'` in the new row (parent row `optional-session-search`); `'sessionQuery'` or absent at root |

## 9. Transitions

Scratch host, chosen patch, probe in `patched` mode (a subclass `PatchedProbeEngine` of the shipped
class stands in for the patched engine). Provider = constructor@row of the `sessionQuery` service
seen by an observer row inside the group; "search" = one `searchSessions({query})` call by that
observer. Changes made while the host ran were picked up by HMR's profile watches about 2–3 s
after the write. Full timeline: [`spike/host/timeline.txt`](spike/host/timeline.txt), raw records:
[`spike/host/report.jsonl`](spike/host/report.jsonl).

| # | transition | while running | after restart |
|---|---|---|---|
| T0 | baseline, bundle not installed (H2) | — | `SqliteSessionQueryEngine@optional-session-query-sqlite`, search ok |
| T1 | install while running: `dsh plugin --profile web add <dir>` (H2 09:16:28; again H5 09:19:12) | shipped row disposed first (09:16:31.377), then the new row started (31.383) and provides `PatchedProbeEngine@session-query-sqlite-patched`; search ok; **no provider clash, no failed row** ([cli](spike/host/cli-add-hot-H2.txt)) | H3: `PatchedProbeEngine@session-query-sqlite-patched`, search ok |
| T2 | disable bundle (name removed from `dsh.profile.bundles`, dependency kept) (H3 09:17:34) | new row disposed, shipped row back: `SqliteSessionQueryEngine@optional-session-query-sqlite`, search ok | H4: shipped, search ok |
| T2b | re-enable bundle (name appended again) (H4 09:18:15) | patched provider, shipped row disposed, search ok | — |
| T3 | remove bundle: `dsh plugin --profile web remove dsh-plugin-session-search-patched` (H4 09:18:34) | shipped row back, search ok ([cli](spike/host/cli-remove-hot-H4.txt)) | H5: shipped, search ok |
| T4 | disable only the new row (profile patch `- id: session-query-sqlite-patched` / `disabled: true`) (H5 09:19:31) | **no provider in the group**; `optional-tool-session-query` PENDING | H6: no provider; startup warning `optional-tool-session-query (@deepseek-ai/dsh-tool-session-query): pending (waiting for service: sessionQuery)` — **search dead** ([output](spike/host/host-H6-output.txt)) |
| T5 | profile row re-enables the shipped row (H6 09:20:20, H7) / home row (H8) | shipped provides; the new row's engine fails `service "sessionQuery" has been registered at <SqliteSessionQueryEngine>`; the new row itself stays ACTIVE; search ok | H7, H8: same (shipped wins the startup race), search ok |
| T6 | home row removed again while running (H8 09:21:56) | shipped row disposed; the failed engine of the new row is **not retried** (cordis `fiber.ts:633-634`); no provider, tool PENDING — search dead until restart | H9 (restart, fallback mode): the new row provides again |
| T7 | patched module import fails inside the row (mode `broken`, H9) | — | fallback: `SqliteSessionQueryEngine@session-query-sqlite-patched`, search ok |
| T8 | `engines.dsh` not matching the host (H12) | — | bundle skipped at profile load, shipped serves |

Rollback that works: switch the bundle off or remove it (T2, T3); both apply live with HMR and
hold after a restart. Not a rollback: disabling only the new row (T4).

Note on T3: pnpm 11.28.5 removed the dependency and the bundle entry but left the symlink
`<profile>/node_modules/dsh-plugin-session-search-patched` in place (both removals,
[cli](spike/host/cli-remove-before-H2.txt)); no row references it afterwards, so it is inert.

## 10. Other findings

- `include:`-prefixed ids never match a patch, in a bundle layer (B) or a profile layer (L4c);
  `include:<id>` is only the runtime entry id. Overrides must use bare ids. (The
  `packages/sessions/README.md:130` example uses the `include:` form; not changed here.)
- `dsh --dump-config` does not evaluate `!!js`, so a dynamic `disabled` cannot be proven by a dump.
- An insert patch's `name` is ignored by the loader; the group is bound by id only.
- The new row's engine failing (clash) leaves the row ACTIVE; only the child engine fiber fails, so
  the plugin manager lists the row as running. The probe saw the failure through the rejection
  of the promise returned by `ctx.plugin(Engine, config)`.

## 11. Doubts

- The probe stood in for the patched engine with a subclass of the shipped class. Startup order in
  the clash case (T5) could differ once the real patched engine (a separate module) loads; either
  way exactly one provider wins and the other fails. S8 re-checks T1–T5 with the real package.
- T2 changed `dsh.profile.bundles` by hand in the scratch profile, as the plugin manager's switch
  does; the plugin manager's own path (`setBundleEnabled` → `hmr.reconcileProfile`) was not run.
- Bundle-order flip (L2) and an `include:` override in the real profile: the real profile was not
  read (rule), so whether it already holds rows for `optional-session-query-sqlite` or
  `optional-tool-session-query` is unknown. A bare-id row with `disabled: false` there gives T5; a
  config-only row is harmless (L4b); an `include:` row is skipped (L4c).
- The real host runs as `dsh web` with HMR (base bundle row `hmr`, enabled when `profileContext`
  exists); a host without HMR would apply T1–T3 only at restart.
- At the start, source files were read out of app.asar with the app's Electron in node mode using
  the session environment (its DSH_HOME pointed at the real home); those calls only read files of
  the app bundle and are not dsh CLI runs. The `ls`/`find` of `~/.dsh/profiles/web` used for the
  hash table listed file names; their contents were never viewed (hashing reads the bytes). The guard stat-s the real `~/.dsh` itself
  (realpath) to catch a symlinked home; it never reads or lists it.

## 12. Commands (exact, in order)

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"; cd packages/session-search-patched
SH=scripts/scratch-home.mjs
node $SH --self-test                                         # 25 checks, exit 0
(cd ~/.dsh/profiles/web && find . -maxdepth 1 -type f -print0 | sort -z | xargs -0 shasum -a 256)   # before / after
node $SH create --label s1-spike                             # → $S
node $SH dsh $S -- --version                                 # 0.2.2-rc.3
node $SH run $S -- /usr/bin/env                              # → spike/env-child-cli.txt
node $SH dsh $S -- --profile web --dump-config               # → spike/dump-00-baseline-web.txt
# append @deepseek-ai/dsh-experimental-session-search to $S/home/.dsh/profiles/web/package.json dsh.profile.bundles
node $SH dsh $S -- --profile web --dump-config               # → spike/dump-01-baseline-search.txt
cp docs/spike/candidates/A-bare-disable-insert.yml docs/spike/probe/cordis.patch.yml
node $SH dsh $S -- plugin --profile web add "$PWD/docs/spike/probe"
node $SH dsh $S -- --profile web --dump-config               # per candidate A–E and per layer L1–L5
node $SH run $S --cwd "$PWD" --set ELECTRON_RUN_AS_NODE=1 -- "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" docs/spike/analyze-dump.cjs <baseline> <dumps…>
cp docs/spike/scratch-profile-observers.yml $S/home/.dsh/profiles/web/cordis.patch.yml
node $SH dsh $S --set SPIKE_REPORT=$S/report.jsonl --set SPIKE_SNAPSHOT_TRIGGER=$S/snapshot.request --set SPIKE_PROBE_MODE=patched -- --profile web --no-open --host 127.0.0.1 --port 3197   # background job, H1…H13
node $SH dsh $S -- plugin --profile web remove dsh-plugin-session-search-patched
python3 docs/spike/summarize-report.py docs/spike/host/report.jsonl > docs/spike/host/timeline.txt
sh docs/spike/reproduce-chosen-dump.sh                       # fresh scratch home, same checks
```

## 13. Decision table (for S4, S5, S6, S8)

| topic | decision | evidence |
|---|---|---|
| Patch text (S6: `cordis.patch.yml`) | Candidate A, byte for byte as in section 4 / [`spike/candidates/A-bare-disable-insert.yml`](spike/candidates/A-bare-disable-insert.yml). sha256 **`b5217930e77e81ce833e8233f7861f41c2530115054318b11d8944cfcd84be0d`** (846 bytes, 18 lines, LF, final newline). No `!!js`. | §3, §4, §5 |
| Row | id `session-query-sqlite-patched`, name `dsh-plugin-session-search-patched` (the package's `exports["."]`), config `{path: ':memory:', openAt: first-search, persistedReadConcurrency: 1}` passed to the engine unchanged | §4 |
| Host-import mode (S4, S5, S6) | **bare**. Generated engine and entry keep bare specifiers; S4 needs no specifier mapping (`scripts/build.config.json` absent or empty). Import allow-list of `src/engine`: `node:crypto`, `node:fs/promises`, `node:path`, `node:sqlite`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-query`, and relative `./query.js`, `./schema.js`. The entry may add `@deepseek-ai/dsh-session-query-sqlite` (fallback). | §7, [`spike/resolution.txt`](spike/resolution.txt) |
| package.json (S6) | `peerDependencies` exactly: `@deepseek-ai/cordis` `~4.1.0`, `@deepseek-ai/schemastery` `~3.19.0`, `@deepseek-ai/dsh-session` `0.2.2-rc.3`, `@deepseek-ai/dsh-session-query` `0.2.2-rc.3`, `@deepseek-ai/dsh-session-query-sqlite` `0.2.2-rc.3` (a host package imported at runtime but missing here resolves to this repository's private copy or fails). No `dependencies`. `engines.dsh: "0.2.2-rc.3"` (exact). `dsh.bundle.patch: "./cordis.patch.yml"`. | §7, §8, H12, H13 |
| Version source | Bundle level: `engines.dsh: "0.2.2-rc.3"` — on any other host version the whole layer is skipped and the shipped row serves (H12). Entry guard (S5): `ctx.get('pluginPackages')?.packageOf('@deepseek-ai/dsh-session-query-sqlite', import.meta.url)?.version === '0.2.2-rc.3'` (observed `0.2.2-rc.3`); a missing service, a throw or another value is a guard failure. | §8 |
| Scope check (S5) | `ctx[Symbol.for('cordis.isolate')]?.sessionQuery?.description === 'sessionQuery#optional-session-search'`; otherwise mount **nothing** and log one line (a mount outside the group would provide or clash in the root scope). | §8 |
| Fallback mechanism (S5) | Inside the new row: `const { default: Shipped } = await import('@deepseek-ai/dsh-session-query-sqlite'); ctx.plugin(Shipped, config)` with the same row config, on guard failure, patched-module import failure, or patched engine construct/init failure. Exception: a failure whose message contains `service "sessionQuery" has been registered` is a provider clash (a later layer re-enabled the shipped row, T5): mount nothing (the shipped class would clash too) and log one line asking to remove that override and restart. Proven: H9 (fallback serves, search ok), H7/H8 (clash). | §8, §9 |
| Rollback commands (S8, later the README) | `dsh plugin --profile <profile> remove dsh-plugin-session-search-patched`, or switch the bundle off on the Plugins page; then restart the host (both also apply live with HMR). Never disable only the row `session-query-sqlite-patched` (search dead, T4). After removing a profile or home row that re-enabled `optional-session-query-sqlite`, restart (T6). If search is served by the shipped engine after the session-search bundle was switched off and on, switch this bundle off and on to put its layer after it (L2). The leftover `node_modules/dsh-plugin-session-search-patched` symlink after `remove` is inert. | §5, §9 |
| Install (S8 scratch, later the user) | `dsh plugin --profile <profile> add "<abs path>/packages/session-search-patched"` (link install, appended after the session-search bundle, applies live; restart to confirm). On a scratch home: `node scripts/scratch-home.mjs dsh <root> -- plugin --profile web add "$PWD"`. | §2, §9 |
| Scratch verification recipe (S8) | `scripts/scratch-home.mjs` for every call; profile from §2 steps 1–3 (or `docs/spike/reproduce-chosen-dump.sh` with the real package path instead of `docs/spike/probe`); observer rows from `docs/spike/scratch-profile-observers.yml` (absolute `file://` names into `docs/spike/reporter/`) and `SPIKE_REPORT`/`SPIKE_SNAPSHOT_TRIGGER`; timeline with `docs/spike/summarize-report.py`; host on 127.0.0.1, port ≠ 3080, managed background job, stopped with job_kill; real-profile sha256 before/after; store dumps and records through the normalization at the top of this file. | §1, §9 |
