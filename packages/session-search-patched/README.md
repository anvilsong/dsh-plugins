# dsh-plugin-session-search-patched

An **unofficial** patched copy of the SQLite engine behind DeepSeek Harness'
optional session search. It keeps the shipped search as it is and replaces only
the engine that builds the search index in memory, so that

- the first search on a large session store needs far less JavaScript heap (its
  peak follows the largest logs, not the whole store) and is much less likely to
  abort with an out-of-memory error, and
- a session that appends while you work no longer forces a re-read of the whole
  store.

This is not an official DSH release and not a fix that DSH has accepted: the patch
comes from two **local, unmerged** commits of an upstream clone (see
[Provenance and license](#provenance-and-license)). It is not affiliated with,
reviewed or endorsed by DeepSeek or the DeepSeek Harness maintainers. The two commits
were written by this package's author (anvilsong) in a local clone; they exist only on
a local branch of that clone and have no upstream review. Provided as is, without
warranty (MIT).

It is pinned to DSH **0.2.2-rc.3 and 0.2.2-rc.5**, whose search-engine sources are
identical; on any other host version it steps aside and the shipped engine serves (see
[Version pin](#version-pin-and-what-happens-on-another-version)). rc.5 is admitted on
source identity alone: no run of this package on an rc.5 host is recorded, and every
host run in this README was on rc.3.

## What it is

The optional bundle `@deepseek-ai/dsh-experimental-session-search` mounts a group
`optional-session-search` that holds the shipped engine row
`optional-session-query-sqlite` and the tool row `optional-tool-session-query`.
The group isolates the service `sessionQuery`, so the engine provides it only
inside that group.

This package is one bundle with one bundle patch
([`cordis.patch.yml`](cordis.patch.yml)) and one row:

- the shipped engine row is switched off (`disabled: true`, addressed by its bare
  id `optional-session-query-sqlite`);
- the row `session-query-sqlite-patched` (package name
  `dsh-plugin-session-search-patched`, title *Session search (patched engine,
  unofficial)*) is inserted into the same group with the row config
  `path: ':memory:'`, `openAt: first-search`, `persistedReadConcurrency: 1`;
- the tool row and the group's isolate map are not touched.

At each start the row decides which engine provides `sessionQuery`
(`src/index.host.js`, `src/guard.js`):

| Situation | What mounts |
|---|---|
| The host passes the guard (the version of `@deepseek-ai/dsh-session-query-sqlite` is one of `0.2.2-rc.3` or `0.2.2-rc.5` and the sha256 of its `src/index.ts`, `src/query.ts` and `src/schema.ts` equal the pinned values) | the patched engine (`src/engine/index.js`) |
| The guard fails, or the patched engine fails to load, construct or start | the **shipped** engine class, mounted in this row with the same config; one `warn` line |
| The row is not inside the isolated `sessionQuery` scope of the group | nothing; one `error` line |
| A later layer turned the shipped row back on (a provider clash) | nothing: the shipped row serves; one `error` line asks you to remove that override and restart |

There is no fallback at search time: once an engine is up, its errors reach the
caller as they are.

The plugin has no page, no agent tool, no slash command and no Settings form. On
the stores tested, the hits, their order and the error messages equal those of
the shipped engine (see [Limits](#limits)); cursors differ by design (each engine
has its own instance id and generation).

## Why

Two failure modes of the shipped rc.3 engine, measured against it in
[`docs/verification.md`](docs/verification.md):

1. **Memory abort on a large store.** The shipped engine decodes every changed log
   of a cold pass and keeps them until the pass ends. Peak heap on a 1.126 GB
   (decoded) synthetic store of 200 sessions:

   | `--max-old-space-size` | patched | shipped |
   |---|---|---|
   | 512 MB | ok, 464 MB peak | **out of memory** |
   | 1024 MB | ok, 618 MB | **out of memory** |
   | 2048 MB | ok, 657 MB | ok, 1899 MB (about 2.2 GB when the heap may grow) |

   On a 691 MB (decoded) copy of a real store of 253 sessions the shipped engine
   aborted at 256 MB and completed from 512 MB (peaks 395 to 760 MB); the patched
   engine completed at every cap from 256 MB (peaks 205 to 356 MB sampled, up to
   369 MB by GC trace). So on a store of
   that size under a heap of several gigabytes the shipped engine may still
   complete; the patch matters when the store is large against the heap. The
   host's own heap ceiling is stated in [`packages/sessions/README.md`](../sessions/README.md)
   as about 4 GiB; this package's measurements did not run on the host's ceiling.
2. **Whole-store re-read when a session appends.** The shipped engine re-reads
   every log when one session changed during a search, and fails with
   `SESSION_QUERY_PERSISTENCE_FAILED` when the changing session moves again
   during the retry. The patched engine commits each session as it reads it, so
   the retry reads only the sessions that moved. In the recorded scenario (a
   stored session appending after every 4th log read, 8 and 32 sessions) the
   shipped engine failed and the patched engine succeeded. After that failure the
   shipped engine's next search read every log again (8 or 32), the patched
   engine's none. A single append between two searches costs one log read with
   either engine (`docs/verification.md` §5).

### What it does not fix

- **One unreadable or unknown-event-type session is not fixed.** A stored session
  with an event type this host does not know (and that is not marked ignorable),
  or an unreadable log (mode 000), still makes every search fail with
  `SESSION_QUERY_PERSISTENCE_FAILED`. Both engines give the **same clean error
  with the same message**, and the host stays alive. The patched engine only
  fails faster on later searches because it keeps the logs it already committed
  (22 queries in 8.1 s against 129 s on the scratch store copy). Remove the
  session to get search back; see `docs/scratch-verification.md` §7.3.
- **A corrupt log that the backend silently drops from `list()` is not fixed
  either.** The persistence backend leaves such a session out, so search runs
  without it, for both engines (finding F4 of `docs/scratch-verification.md`).
- A session that appends after every single log read still defeats the patched
  engine (see [Limits](#limits)).

## Version pin and what happens on another version

The package is pinned to **DSH 0.2.2-rc.3 and 0.2.2-rc.5** twice. Both releases ship the
same `@deepseek-ai/dsh-session-query-sqlite` sources, so one set of sha256 pins covers
both (checked against tag `dsh-v0.2.2-rc.5`, commit `9c2670d3bc`, of an upstream
clone; between rc.3 and rc.5 only the `version` fields of the `package.json` files
changed under `packages/session-query` and `packages/core/session`). rc.5 is admitted
on that source identity. On 2026-11-23 the three engine files (`index.ts`, `query.ts`,
`schema.ts`) of the installed DSH 0.2.2-rc.5 app were hashed with sha256 and equal the
pins below. No run of this package on an rc.5 host is recorded; the entry guard
re-checks the installed bytes at each start and falls back to the shipped class if
they differ. The
two pins:

- **Bundle level**: `package.json` has `"engines": { "dsh": "0.2.2-rc.3 || 0.2.2-rc.5" }`.
  `dsh plugin add` **refuses** to install the package on a host whose version does
  not match (the CLI prints `installation rejected … incompatible with dsh …` and
  `nothing was installed`; seen with a copy pinned to rc.4 on an rc.3 host). After
  a host update the installed package is **skipped when the profile loads**, with
  a line `dsh: skipping profile bundle "dsh-plugin-session-search-patched": …
  requirements {"engines.dsh":"0.2.2-rc.3 || 0.2.2-rc.5"} …` on stderr; no row of the package is
  composed and the shipped engine row serves. That skip was reproduced by editing
  `engines.dsh` in an installed copy on an rc.3 host, not on a real newer host.
  The package stays in the profile's `dependencies` until you remove it.
- **Entry guard**: even when the bundle loads, the row mounts the patched engine
  only when the host's `@deepseek-ai/dsh-session-query-sqlite` is exactly
  `0.2.2-rc.3` or `0.2.2-rc.5` (an allow-list, not a range; `PINNED_VERSION` is the
  newest entry) **and** its three source files have the pinned sha256 values (the
  files this package was rebased on). Otherwise the row mounts the shipped class
  with the same config and logs a `warn` line that names the failed check.
- **Do not grant a DSH version exemption for this package.** An exact-version
  exemption (`dsh plugin allow-version` or the plugin manager) loads the bundle on an
  unpinned host. The bundle patch still switches the shipped row off. The guard then
  mounts the shipped class in this row, but if the row's scope check or the entry
  import fails on that host, search has no engine until you remove the bundle.

rc.4 is not admitted: its engine sources equal rc.3's (`vendor/PROVENANCE.md`), but no
run of this package on an rc.4 host is recorded, so neither `engines.dsh` nor the guard
lists it. The patch was written for the rc.3 sources and rc.5 ships the same bytes, so
`vendor/src/*.ts` is unchanged. The engine files of the installed rc.3 app were
compared byte for byte (`vendor/PROVENANCE.md`); for rc.5 only the git tag
`dsh-v0.2.2-rc.5` was compared.

## Install

The package is not published on npm, so install it from a source checkout by its
folder path. Install it only into a profile that has the optional session-search
bundle selected: this package's layer must come **after** that bundle's layer
(installing appends it last), otherwise both patches are skipped with a warning
and the shipped engine keeps serving. Select the optional bundle
`@deepseek-ai/dsh-experimental-session-search` first with the plugin manager's
bundle switch (Plugins page); on rc.3 no `dsh` CLI command selects an optional
bundle (`docs/composition-spike.md` §2).

Run from the root of your checkout:

```sh
dsh plugin --profile web add "$PWD/packages/session-search-patched"
```

Replace `web` with your profile name when needed. The install is a link
install (pnpm `link:`); it appends the package to the profile's bundles. On a
running `dsh web` the change applies live about 2 to 3 seconds later (the host
disposes the shipped row and starts this row, with no provider clash and no
failed row). **Restart `dsh web` anyway** and check the engine as described
below. Installing from the Desktop **Add plugin** dialog was not verified; use
the command line on the profile the app uses.

A live install (or removal) recomposes the whole profile, not only this bundle:
by the rc.3 HMR code (`reconcileProfile` in `@deepseek-ai/dsh-hmr`), other
link-installed plugins whose files changed on disk since the host started are
stopped and started again with the new files. The scratch runs had no other
plugins, so this was not observed. Installing with the host stopped avoids it;
every plugin then loads once, at the next start.

Install from a folder you do not edit while the package is installed (for
example an exported copy of a reviewed commit; a copy outside this repository
was verified on a scratch home, `docs/scratch-verification.md` §7.2). A link
install loads the folder as it is at each start, and the bundle patch switches
the shipped row off whatever the entry does (see [Limits](#limits)).

The first install on your own profile is a step to take with a way back ready:
read [Rollback](#rollback) first, and follow
[`docs/session-search-patched-checklist.md`](../../docs/session-search-patched-checklist.md).
The install was verified on scratch DSH homes of an rc.3 host only
(`docs/scratch-verification.md`).

The package declares the host packages it imports as `peerDependencies`
(`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-session`,
`@deepseek-ai/dsh-session-query`, `@deepseek-ai/dsh-session-query-sqlite`), so the
host resolves them to its own copies; the package has no `dependencies` and no
private copy of a host package.

## Which engine is active

Four views, from direct to indirect:

**1. The log line.** Each start of the row logs exactly one line that begins with
`session-search-patched:`. With the patched engine serving:

```text
session-search-patched: active engine: patched SqliteSessionQueryEngine (./engine/index.js); reason: host @deepseek-ai/dsh-session-query-sqlite 0.2.2-rc.5 (pinned 0.2.2-rc.3 / 0.2.2-rc.5) and the sha256 of its src/index.ts, src/query.ts, src/schema.ts match the pinned values
```

The version in the reason is the host's: on rc.3 it reads `host
@deepseek-ai/dsh-session-query-sqlite 0.2.2-rc.3 (pinned 0.2.2-rc.3 / 0.2.2-rc.5)`. This
text is built by `src/guard.js`; the scratch hosts (rc.3, before rc.5 was admitted)
logged the older wording without the `(pinned …)` part.

The other variants have the same shape, `session-search-patched: active engine:
<engine>; reason: <reason>`:

| Level | `<engine>` | When |
|---|---|---|
| `info` | `patched SqliteSessionQueryEngine (./engine/index.js)` | the guard passed and the patched engine started |
| `warn` | `shipped SqliteSessionQueryEngine (@deepseek-ai/dsh-session-query-sqlite) as fallback` | the reason is `compatibility guard failed: …` (version or source hash), or `the patched engine failed to start: …`, or `the patched engine ./engine/index.js did not load: …`, or `the patched engine ./engine/index.js has no default export class` |
| `error` | `none (another row already provides sessionQuery in this group)` | provider clash: another row (a profile or home `cordis.patch.yml` row with id `optional-session-query-sqlite`) turned the shipped engine back on; it serves, remove the override and restart |
| `error` | `none` | the row is not in the isolated scope, or both engines failed (the reason then ends with `search is unavailable in this group until the cause is fixed and the host is restarted`), or the reason is `unexpected entry failure: …` |
| `warn` | `none` | the row stopped while its engine was starting |

**Where the line goes.** The line goes to the host's **in-memory logger buffer**
(1000 entries). It does **not** appear in the terminal of `dsh web`: none of the
package's lines showed on the stdout or stderr of the twelve scratch hosts
(finding F2 of `docs/scratch-verification.md`). The recorded evidence read it
from that buffer with a probe row. A log view inside the app was **not
verified**; do not rely on one. Because the line is easy to miss, use the two
other views too.

**2. The composed configuration.** `dsh --profile <profile> --dump-config`
prints the composition without starting anything. After a successful install the
group `optional-session-search` shows the shipped row `optional-session-query-sqlite`
with `disabled: true`, the tool row `optional-tool-session-query` unchanged and
the enabled row `session-query-sqlite-patched` with `persistedReadConcurrency: 1`:
exactly one enabled engine row in the group. The dump writes `<profile>/cordis.yml`
and does not evaluate `!!js`; it was run on scratch homes only.

**3. The Plugins page** lists the bundle. By the rc.3 plugin manager code it may
list **no row under this bundle**: it finds a bundle's own rows by composing that
bundle's patch alone, and this patch only inserts into a group of another bundle
(`test/composition.test.mjs`). The row runs as the Loader entry
`include:session-query-sqlite-patched`, which stays active even when its engine
failed to start in the clash case (spike §10). What the page shows for each row in
the GUI was not verified here.

**4. Behaviour.** Same results as before (22 queries gave byte-identical results
with the bundle off and on on the scratch store copy), lower host memory on a large
store, and fewer `SESSION_QUERY_PERSISTENCE_FAILED` errors while a session appends
(see [Limits](#limits)). These show the effect, not the cause.

The dump and the Plugins page show the **row**, not the class inside it: when the
guard fails, the same row `session-query-sqlite-patched` serves the *shipped*
class, with identical results. Only the log line states which engine runs.

## Rollback

Roll back at **bundle level**: remove or switch off the bundle. Both apply live
about 3 seconds later on a running `dsh web` and hold after a restart.

```sh
dsh plugin --profile web remove dsh-plugin-session-search-patched
```

or switch the bundle `dsh-plugin-session-search-patched` off on the Plugins page
(the page's own switch was not exercised; the tested equivalent removed the name
from `dsh.profile.bundles` of the profile's `package.json`).
Then restart the host. The shipped row `optional-session-query-sqlite` provides
`sessionQuery` again; the dump after a rollback shows one enabled group engine, the
shipped one.

> **Do not disable only the row `session-query-sqlite-patched`.** With the
> bundle's patch still switching the shipped row off, the group then has no
> engine: the tool row `optional-tool-session-query` waits for `sessionQuery` and
> **search is dead** until you switch the bundle off or remove it.

Leftovers: `remove` drops the dependency and the bundle entry but leaves the
symlink `<profile>/node_modules/dsh-plugin-session-search-patched`; no row
references it and it is inert. Switching the bundle off keeps the dependency
entry.

If you added a profile or home row that turns `optional-session-query-sqlite`
back on (`disabled: false`), search is served by the shipped engine and the
patched row's engine fails with a clash; removing that row while the host runs
leaves search dead until a restart.

If you switch the optional session-search bundle itself off and on again, its
layer moves after this package's and both patches are skipped (the shipped engine
serves); switch this bundle off and on to put its layer after it again.

## Limits

- **Only DSH 0.2.2-rc.3 and 0.2.2-rc.5**, rc.5 on source identity alone (no rc.5 host
  run is recorded). See [Version pin](#version-pin-and-what-happens-on-another-version).
- **The entry itself must load.** The fallback covers failures inside the row's
  start; it cannot cover an entry that does not import. If `src/index.host.js` or
  `src/guard.js` cannot be loaded (a syntax error or a missing file in an edited or
  half-copied folder), the bundle patch still switches the shipped row off, so no
  engine provides `sessionQuery` and search is dead until you remove the bundle.
  Reasoned from the loader, not run on a host. A folder that is missing as a whole
  leaves search working: the bundle is then skipped and the shipped row serves (run
  on a scratch host, `docs/scratch-verification.md` §7.2).
- **A clash is not retried.** When a later layer re-enables the shipped row, the
  new row mounts nothing; if that override goes away while the host runs, the
  group has no engine until a restart (`test/review.test.mjs`).
- **A later layer that replaces the group's config wholesale** (`- id:
  optional-session-search` with a `config:` list) drops this row with **no
  warning**; the shipped row then serves (`test/composition.test.mjs`).
- **One unreadable or unknown-type session still fails search** with the same
  clean error as before. This package does not fix it.
- **The two-attempt limit stays.** A session that appends after every single log
  read still fails the search with `SESSION_QUERY_PERSISTENCE_FAILED` (test
  `C3 boundary`); the patch only shortens the retry to the logs that moved. Repeat
  the search. The appending-session scenario is modeled by work (one append per 4
  log reads), not by wall-clock time; a failure probability for a real streaming
  session was not measured.
- **The heap floor follows the largest logs**, not the store: one decoded log plus
  the backend's memo of up to two decoded logs. A store with a single very large
  log needs a correspondingly large heap.
- **The `:memory:` index costs native memory that grows with the store**: maximum
  RSS 2.6 to 2.8 GB on the 1.126 GB synthetic store and 0.8 to 1.0 GB on the 691 MB
  copy. The row config (`path: ':memory:'`) is the upstream bundle's, so this is
  not changed by the patch.
- **A first search after a start costs a little more** on a small store (755 ms
  against 682 ms on 400 sessions of 6.6 MB; one transaction per session). Quiet
  searches cost the same. On the 691 MB copy the first search was shorter
  (10.3 s against 14.5 s at 512 MB).
- **A quiet search for a very frequent term** took about 12 s on the 1.126 GB
  index for both engines (the SQL is `query.ts`, which is not patched).
- **Verified on scratch DSH homes of an rc.3 host with a copy of one store**, not
  on a live profile. The live-session paths of the two engines were compared by the engine
  spec and by the C3 model, not on a running host with real streaming.
- The bundle switch was exercised by editing `dsh.profile.bundles` of the scratch
  profile, as the plugin manager does; the plugin manager's own code path was not
  run. A host without HMR would apply install and rollback only at restart.
- The row config is fixed by the bundle patch. Overriding it in a profile patch
  was not verified; overrides must use bare ids (a row id with the `include:`
  prefix never matches a patch).

## Provenance and license

The engine sources are the sources of `@deepseek-ai/dsh-session-query-sqlite`
**0.2.2-rc.3**, as installed in the app when `vendor/PROVENANCE.md` was recorded
(2026-11-18), with the patch of the local commit
`da482fcac4` ("fix(session-query-sqlite): index persisted sessions one at a time")
rebased on them. The commit `e1f2349309` ("fix(session-search): read hit titles one
log at a time") changes no engine source; it adds `persistedReadConcurrency: 1` to
the engine row of the session-search bundle, which this package's row config
reproduces. **Both commits are local and unmerged** (branch
`fix/session-search-bounded-index` of the upstream clone, written on the rc.4 base
`ca33fd6843`), have no upstream review and may never become upstream.

| Path | What |
|---|---|
| `vendor/src/index.ts` | rc.3 `src/index.ts` with the rebased patch (sha256 `0472dc2a…c3fcdf`) |
| `vendor/src/query.ts`, `vendor/src/schema.ts` | rc.3 originals, verbatim |
| `patches/engine-0.2.2-rc.3.diff` | rc.3 `src/index.ts` → `vendor/src/index.ts` (14 hunks, +212/−68) |
| `src/engine/*.js`, `manifest.json` | generated from `vendor/src` by `scripts/build.mjs` (type strip); `node scripts/build.mjs --check` verifies it |
| `vendor/tests/sqlite.spec.ts` | the engine spec of rc.3 with the commit's test changes and a vendored cost block |
| `vendor/PROVENANCE.md` | hashes, commands and the rebase record |

Code derived from upstream (`vendor/src/*.ts`, the generated `src/engine/*.js`,
`patches/engine-0.2.2-rc.3.diff` and `vendor/tests/sqlite.spec.ts`) comes from
DeepSeek Harness (<https://github.com/deepseek-ai/deepseek-harness>, package
`@deepseek-ai/dsh-session-query-sqlite` 0.2.2-rc.3): MIT, Copyright (c) 2026
DeepSeek, see [`vendor/LICENSE.upstream`](vendor/LICENSE.upstream). The changes
in it (the bounded-index patch and the spec's added cost block) are by anvilsong,
also MIT. The plugin's own code
(`src/index.host.js`, `src/guard.js`, `cordis.patch.yml`, `scripts/`, `test/`) is
MIT, Copyright (c) 2026 anvilsong, see [`LICENSE`](LICENSE). The package's
`files` list ships `src`, `cordis.patch.yml`, `README.md`, `LICENSE`,
`vendor/src`, `vendor/PROVENANCE.md`, `vendor/LICENSE.upstream` and `patches`; it
does **not** ship `vendor/tests`, `docs`, `scripts` or `test` (a folder install
from this repository still has them on disk).

Records of the work: [`docs/composition-spike.md`](docs/composition-spike.md) (patch
dialect, layers, guard inputs, transitions, decisions),
[`docs/build-audit.md`](docs/build-audit.md) (generated engine against the shipped
build), [`docs/verification.md`](docs/verification.md) (spec, appending session,
same hits, heap tables), [`docs/scratch-verification.md`](docs/scratch-verification.md)
(the package on an rc.3 host with a store copy), [`docs/rollout-record.md`](docs/rollout-record.md)
(the final review before an install on a real profile; nothing was installed there).

## Tests

Use Node 24 (tested with 24.22.3; the repository's `.nvmrc`). Run from the repository root, after `npm install` there (it installs the
shared test dependency `@deepseek-ai/cordis` ~4.1.0 of the root `package.json`):

```sh
node --test packages/session-search-patched/test/*.test.mjs
node packages/session-search-patched/scripts/build.mjs --check
node packages/session-search-patched/scripts/scratch-home.mjs --self-test
```

The first command ran 154 tests: 150 pass, 4 skipped, 0 fail (Node v24.22.3). The
skipped ones are opt-in: three need `SSP_RC3_EXTRACT` (a folder with `index.ts`,
`query.ts`, `schema.ts`, `lib/index.js` as `index.js` and optionally `package.json`,
extracted from the installed app; `docs/build-audit.md` §2 and §8), one needs
`DSH_UPSTREAM_DIR` (`test/composition.test.mjs`: the bundle patch composed by the
rc.3 loader code with the other layers). If that folder holds a `package.json`,
`test/review.test.mjs` expects its version to be one of `PINNED_VERSIONS` (rc.3 or
rc.5). With both set the suite ran 159 tests,
159 pass, before the rc.5 change added three tests; that opt-in run was not repeated
since.

The engine experiments against an rc.3 source checkout are optional and skip
themselves without one:

```sh
DSH_UPSTREAM_DIR=/path/to/rc3-checkout node --test packages/session-search-patched/test/upstream/*.test.mjs
```

`DSH_UPSTREAM_DIR` must be a checkout of tag `dsh-v0.2.2-rc.3` with its
dependencies installed (the recipe is in `docs/verification.md` §2); any other
checkout skips the suite. With it, the suite ran 9 tests, 9 pass: the rebased spec
(92 tests) against the generated engine, the appending session, the
unknown-event-type error, 29 queries with identical pages, and a heap probe.

Every dsh CLI call and host run of the verification used a scratch home made by
`scripts/scratch-home.mjs`, which refuses the real `~/.dsh`; the upstream suite
puts decoy home folders in place and a test asserts they stay empty. The package's
tests only run engines and a simulated entry:
follow [`docs/session-search-patched-checklist.md`](../../docs/session-search-patched-checklist.md)
by hand on a real profile.

## License

MIT
