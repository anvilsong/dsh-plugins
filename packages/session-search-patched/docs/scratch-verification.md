# Scratch verification (S8): the real package on the rc.3 host

Task S8 of plan 21d0cf72d308. The finished package (`dsh-plugin-session-search-patched` 0.1.0,
this folder, link-installed with `dsh plugin add`) was loaded by the installed DeepSeek Harness
**0.2.2-rc.3** (`dsh --version` in the scratch environment) on two scratch DSH homes, each holding a
full copy of the user's session store. Run between 2026-11-18T09:55Z and 10:25Z. Paths are
relative to `packages/session-search-patched/` unless they start with `/`.

Privacy: the store copy holds private session logs. No log text, snippet, title, cwd or session id
of that store appears in this file or in any evidence file. A hit is recorded as a sha256 of the
whole hit object, a session as a sha256 of its id, plus ranks, seq numbers, counts and timings.
Error messages from the real store were reduced (ids, paths and quoted strings replaced by short
hashes) before they were written. The only readable session data in the evidence belongs to the
synthetic sessions planted for drill (c).

Redaction: the composed dumps contain DSH row ids with a word the plan's file rule bans; in the
stored dumps its letter `i` is the digit `1` (same normalization as `composition-spike.md`, top).

## 1. Result per criterion

| # | criterion | result | evidence |
|---|---|---|---|
| 1 | scratch homes only, port ≠ 3080, probe logs a store path inside the scratch home, homes removed with the guarded delete | **met**: 12 hosts (H1–H12) on 127.0.0.1:3198 as managed background jobs, stopped with job_kill; every observer `facts` record: store root `<scratch>/home/.dsh/sessions`, `rootStartsWithScratchHome: true`, 253 sessions listed; both roots removed by `scratch-home.mjs destroy` | §2, [`scratch-roots-before-after.txt`](../test/scratch/evidence/scratch-roots-before-after.txt), [`host-outputs.txt`](../test/scratch/evidence/host-outputs.txt) |
| 2 | identical ordered results with the bundle off and on, ≥ 20 queries | **met**: 22 queries (1669 session hits, 100 event hits, 3-page cursor walk); `results-H1-off.json` and `results-H2-on.json` both sha256 **`4700711bb32c7178ee6f4e69b15ce7a3c6832f57140e24143ad94a47e3a34b6a`**, byte-identical (`cmp`); the same hash in 15 further runs | §4 |
| 3 | one enabled sessionQuery provider in the group; host log line | **met with a wording difference**: dump analysis "exactly one enabled engine row in group: yes … session-query-sqlite-patched: yes"; the host log has `session-search-patched: active engine: patched SqliteSessionQueryEngine (./engine/index.js); reason: host @deepseek-ai/dsh-session-query-sqlite 0.2.2-rc.3 and the sha256 of its src/index.ts, src/query.ts, src/schema.ts match the pinned values` — not the literal text `session-search-patched: patched engine active` of the criterion (finding F1); the line is only in the host's logger buffer, not on the terminal (F2) | §5 |
| 4a | copy pinned to another version → shipped class serves | **met** in three forms: `engines.dsh` 0.2.2-rc.4 (install refused; installed then re-pinned → bundle skipped, shipped row serves), guard `PINNED_VERSION` 0.2.2-rc.4 and a changed source pin (→ shipped class mounted in the new row as fallback, `warn` line) | §7.1 |
| 4b | package folder missing → host starts, shipped row serves | **met**: `skipping profile bundle … cannot resolve profile bundle`, host up, shipped row serves, same result hash | §7.2 |
| 4c | unknown event type planted → clean error, host alive | **met**, both engines: `SESSION_QUERY_PERSISTENCE_FAILED` with the same message for all 22 queries, host and rows alive, search recovers when the session is removed; same for an unreadable (mode 000) session | §7.3 |
| 4d | install without restart: observed state | **recorded**: `dsh plugin add` into the running host → about 2.3 s later the shipped row is disposed and the patched engine provides; no clash, no failed row; search identical; after a restart the same | §7.4 |
| 5 | rollback by disable and by remove, each then restart; no row of the package left | **met**: both return search to `optional-session-query-sqlite` (shipped class), live and after restart; dumps after rollback have one enabled group engine (the shipped one); after `remove` no file of the scratch profile names the package (only the inert `node_modules` symlink remains), after disable only the dependency entry stays (by design) | §6 |
| 6 | real profile unchanged | **met**: sha256 of the 7 files at depth 1 of `~/.dsh/profiles/web` equal before (09:55:37Z) and after (10:24:34Z) | §2.4 |

Also checked as the brief asked: `packageOf('@deepseek-ai/dsh-session-query-sqlite', <entry URL>)` gives
0.2.2-rc.3 and the guard passes on this host; the three pinned source hashes of `src/guard.js` equal
the installed engine files inside app.asar; every peer resolves to the host copy and the patched
class shares its base classes with the shipped class (no private cordis copy) — §3. The provider clash
case T5 of the spike was re-run with the real package (§8).

## 2. Isolation

### 2.1 Scratch roots

| root | label | used for |
|---|---|---|
| A `/private/var/folders/57/z_n0xdr53nq701cxgc79lkpc0000gn/T/dsh-scratch-5Cp7ZF` | `s8-main` | H1–H6: off/on comparison, rollback, hot install, drill c |
| B `/private/var/folders/57/z_n0xdr53nq701cxgc79lkpc0000gn/T/dsh-scratch-llL9GT` | `s8-drills` | H7–H12: drills a and b, T5 |

Both were made by [`test/scratch/setup-root.sh`](../test/scratch/setup-root.sh): `scratch-home.mjs create`
(mkdtemp under the temp dir, marker file), `scratch-home.mjs check` of the DSH_HOME, `--dump-config`
to create the shipped `web` profile, the optional session-search bundle appended to
`dsh.profile.bundles` (as the plugin manager's bundle switch does; no CLI command selects it,
`composition-spike.md` §2), the observer rows of [`test/scratch/observers.yml`](../test/scratch/observers.yml)
as the profile's `cordis.patch.yml`, and a gated `cp -Rp /tmp/ssp-scratch-store/sessions <root>/home/.dsh/sessions`.
Before each compared run the store was replaced by a fresh copy with
[`test/scratch/refresh-store.sh`](../test/scratch/refresh-store.sh) (gate: `scratch-home.mjs check` plus a
path pattern `…/T/dsh-scratch-*/home/.dsh/sessions`).

Every dsh CLI call and every host ran through `scripts/scratch-home.mjs` (`dsh` or `run`
subcommand). Child environment of each host: `test/scratch/evidence/env-H<n>.txt` (written by
`--env-dump`): HOME, DSH_HOME, DSH_AGENTS_HOME, XDG_*, TMPDIR inside the root,
`DSH_TELEMETRY_DISABLED=1`, no inherited `DSH_*`, no value names the real `~/.dsh`
(`grep` over all 12 dumps: none).

### 2.2 Store copy

[`test/scratch/store-fingerprint.sh`](../test/scratch/store-fingerprint.sh) prints a sha256 over the sorted
`sha256  path` lines of every file, the file count and the size (no names):

| store | fingerprint | files | KB |
|---|---|---|---|
| `/tmp/ssp-scratch-store/sessions` (read-only source), before (09:55Z) and after (10:24Z) | `03cac5ecc30f48565519ba43f976ce3d71f230831d702c2a3f5201c4604cadbe` | 506 | 166624 |
| each scratch copy right after `cp -Rp`, and root A's copy after H1, before H5 and after drill c (planted sessions removed) | same | 506 | 166624 |

The hosts did not change the copied sessions. 253 sessions (`session.v4.jsonl.zstd` + `session.lock` each).

### 2.3 Hosts

`node scripts/scratch-home.mjs dsh <root> --env-dump test/scratch/evidence/env-H<n>.txt --set SSP_REPORT=<root>/work/report.jsonl --set SSP_TRIGGER_DIR=<root>/work/trigger --set SSP_ENTRY_URL=<entry file URL> -- --profile web --no-open --host 127.0.0.1 --port 3198`,
each as a managed background job, stopped with job_kill; before each start and after each stop
`lsof -nP -iTCP:3198 -sTCP:LISTEN` and `pgrep -fl -- '--port 3198'` showed nothing. Complete host output with
the URL token redacted: [`host-outputs.txt`](../test/scratch/evidence/host-outputs.txt). The live host on
127.0.0.1:3080 was never contacted.

### 2.4 Real profile and removal of the roots

sha256 of `~/.dsh/profiles/web` depth 1 (hashes only), [`before`](../test/scratch/real-profile-sha256-before.txt)
09:55:37Z and [`after`](../test/scratch/real-profile-sha256-after.txt) 10:24:34Z, `diff` empty:

| file | sha256 (before = after) |
|---|---|
| `cordis.patch.yml` | `ff2a5fad375a748a2e5b89e0e1affbe0a4fdd5036c9eab46d8a6564364323ec5` |
| `cordis.patch.yml.bak-before-fable-5-2` | `d2e597035633d7439f037ad41355e1f8e224f0c2b50a8fb7111ed64824bd94f1` |
| `cordis.patch.yml.bak-before-models` | `cdc61a089a65c7445ae206ff2686c38cddfa51085da0a7593103b3cd1ee531fb` |
| `cordis.yml` | `c300dcf2ebc5f02062d6591268d29d3db6fe45e0cb138f5467276fe2ba06076e` |
| `package.json` | `9b4b1db3a21088daedc5a270c4cb9f2dcefacb8ab92f2ba61c5e284c7d2cf8d3` |
| `pnpm-lock.yaml` | `8236dc2f96a8f437c3e3ced49637aec4e1deb55320047a1481e60f38818918aa` |
| `pnpm-workspace.yaml` | `ae7c5b68e2f157528e62885804e69e88583897b775e03c86fcbe52feaf498aba` |

(Equal to the spike's values too.) Guarded delete at 10:24:28Z
([`scratch-roots-before-after.txt`](../test/scratch/evidence/scratch-roots-before-after.txt)):

```text
## before
…/T/dsh-scratch-5Cp7ZF label=s8-main
…/T/dsh-scratch-llL9GT label=s8-drills
…/T/dsh-scratch-rfXeUA label=s1-spike
## destroy
removed …/T/dsh-scratch-5Cp7ZF   exit 0
removed …/T/dsh-scratch-llL9GT   exit 0
## after
…/T/dsh-scratch-rfXeUA
```

`dsh-scratch-rfXeUA` is the S1 spike's root (kept by S1 for its recorded commands), not touched here.

## 3. The package inside the host: guard inputs, resolution, class identity

The observer ([`test/scratch/observer/index.js`](../test/scratch/observer/index.js)) sits in the group
(`ssp-observer-group`, scope `sessionQuery#optional-session-search`) and reads, each time sessionQuery
comes up: the providing row and fiber state; whether the provider's class **is** the class of the
root-scope shipped instance (row `session-query-sqlite`, loaded by the loader from the installation);
how many of the 6 methods the patch adds are on its prototype; whether every base class above the
engine class is the same object as the shipped instance's (`basesIdenticalToShipped`);
`pluginPackages.packageOf(<peer>, <URL>)` for the entry and the engine module URL; the sha256 of the
three pinned files in the directory `packageOf` names, against the pins imported from the package's own
`src/guard.js`; and the persistence root.

H2 (bundle on, cold install), `facts` record (whole record in `report-A.jsonl.txt`):

| check | value |
|---|---|
| provider | `SqliteSessionQueryEngine@session-query-sqlite-patched`, ACTIVE, scope `sessionQuery#optional-session-search` |
| same class as the shipped engine | **false**; patch methods on the prototype: **6/6** |
| base chain | `SqliteSessionQueryEngine → SessionQueryEngine → Service`, `basesIdenticalToShipped: true` (the patched engine extends the host's `SessionQueryEngine` and cordis `Service`, not private copies) |
| row config seen by the engine | `persistedReadConcurrency: 1`, `openAt: first-search` (shipped row: 4, the default) |
| `packageOf(peer, file:///…/session-search-patched/src/index.host.js)` and `(…, …/src/engine/index.js)` | `@deepseek-ai/cordis` 4.1.0, `schemastery` 3.19.0, `dsh-session` 0.2.2-rc.3, `dsh-session-query` 0.2.2-rc.3, `dsh-session-query-sqlite` **0.2.2-rc.3**, every `dir` under `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/` |
| contrast, H1 (package not installed, same URL) | `@deepseek-ai/cordis` → `/Users/macbook/projects/dsh-plugins/node_modules/@deepseek-ai/cordis` (this repository's private copy), the other four unresolved: the host copies come from the installed package's `peerDependencies`, not from the URL |
| shipped sources vs `src/guard.js` pins (in-host read through app.asar) | `src/index.ts` 41094 B `72868e4a…`, `src/query.ts` 15548 B `b2936358…`, `src/schema.ts` 6098 B `2cc4c7c8…`: all `equalsGuardPin: true` |
| the guard itself | passed: the entry's own line names reason `host @deepseek-ai/dsh-session-query-sqlite 0.2.2-rc.3 and the sha256 of its src/index.ts, src/query.ts, src/schema.ts match the pinned values` (it is printed only when the entry's `packageOf(ENGINE, import.meta.url)` returned exactly `0.2.2-rc.3` and all three hashes matched) |
| store | `configRoot` = `root` = `<A>/home/.dsh/sessions`, inside the scratch DSH_HOME, 253 listed |

The same identity facts hold for a copy of the package outside this repository (`<B>/work/pkg-b`, no
ancestor `node_modules`; H9): all peers in app.asar, bases identical.

Out-of-host check of the same pins ([`test/scratch/asar-sources-vs-guard.mjs`](../test/scratch/asar-sources-vs-guard.mjs),
the app's Electron in node mode through `scratch-home.mjs run`, output
[`asar-sources-vs-guard.txt`](../test/scratch/evidence/asar-sources-vs-guard.txt)):

```text
manifest version 0.2.2-rc.3 (guard PINNED_VERSION 0.2.2-rc.3: equal)
src/index.ts 41094 bytes 72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3 equals the guard.js pin
src/query.ts 15548 bytes b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48 equals the guard.js pin
src/schema.ts 6098 bytes 2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f equals the guard.js pin
```

## 4. Same results on the store copy (criterion 2)

Query set (texts chosen here; the result files carry only the ids): defined in `QUERIES` of the
observer. Each query is `searchSessions` with `limit: 100` unless noted; q20 follows the cursor for 3
pages of 10; q21/q22 add `searchEvents` (limit 50) on the first hit's session. A run is triggered by
a file `<root>/work/trigger/<label>.query` and writes `results-<label>.json`:
`{queries: [{id, count, pages: [{items: [{rank, h, s, seq}], more}], events?: {session, items: [{rank, h, seq}], more}, error?}]}`
where `h` = first 32 hex of sha256(JSON of the whole hit: header, live, persisted, bestMatch with
snippet), `s` = first 12 hex of sha256(session id), `error` = the error code only. A scan of all 21
stored result files: only these keys, every string value a hex hash, a query id or an error code.

| run | engine providing sessionQuery in the group | file | sha256 |
|---|---|---|---|
| H1, bundle off, fresh store | shipped `SqliteSessionQueryEngine@optional-session-query-sqlite` (shipped class) | [`results-H1-off.json`](../test/scratch/evidence/results-H1-off.json) | `4700711bb32c7178ee6f4e69b15ce7a3c6832f57140e24143ad94a47e3a34b6a` |
| H2, bundle on, fresh store | patched `SqliteSessionQueryEngine@session-query-sqlite-patched` (not the shipped class, 6 patch methods) | [`results-H2-on.json`](../test/scratch/evidence/results-H2-on.json) | `4700711bb32c7178ee6f4e69b15ce7a3c6832f57140e24143ad94a47e3a34b6a` |

`cmp` of the two files: identical. The same hash came from every other run without a planted session
(H3 disabled, H3 re-enabled live, H3 removed live, H4 removed, H4 hot-installed, H5 restarted, H5 with a
corrupt planted log, H6 after the drill, H7 a1, H8 a2, H9 folder moved live, H10 b, H11 T5, H12 a3).

| id | query | hits | ms off (H1) | ms on (H2) |
|---|---|---|---|---|
| q01 | `plugin` | 100 | 10729 | 8216 |
| q02 | `error` | 100 | 1008 | 1006 |
| q03 | `test` | 100 | 1058 | 1061 |
| q04 | `session` | 100 | 1081 | 1079 |
| q05 | `search` | 100 | 366 | 362 |
| q06 | `build` | 100 | 734 | 727 |
| q07 | `install` | 100 | 246 | 250 |
| q08 | `config` | 100 | 692 | 699 |
| q09 | `function` | 100 | 620 | 626 |
| q10 | `commit` | 100 | 361 | 409 |
| q11 | `README` | 100 | 346 | 381 |
| q12 | `package.json` | 100 | 141 | 147 |
| q13 | `profile web` | 20 | 54 | 48 |
| q14 | `scratch home` | 9 | 51 | 45 |
| q15 | `会话` | 7 | 46 | 40 |
| q16 | `插件` | 3 | 42 | 35 |
| q17 | `zzqxv-no-such-token-8731` (no hit) | 0 | 40 | 33 |
| q18 | `node`, session filter availability persisted | 100 | 703 | 806 |
| q19 | `file`, event filter type `user/message` | 100 | 176 | 187 |
| q20 | `the`, limit 10, 3 pages by cursor | 30 | 8010 | 8717 |
| q21 | `cordis` + searchEvents | 100 + 50 event hits | 427 | 452 |
| q22 | `patch` + searchEvents | 100 + 50 event hits | 708 | 806 |
| | total | 1669 + 100 | 27641 | 26138 |

q01 includes building the index of all 253 sessions. Host RSS sampled once right after the run:
1.20 GB (H1, shipped) and 0.81 GB (H2, patched) — one sample each, indicative only.

## 5. Composition and log line (criterion 3)

`node scripts/scratch-home.mjs dsh <A> -- --profile web --dump-config` after the cold install
([`dump-A1-bundle-on.txt`](../test/scratch/evidence/dump-A1-bundle-on.txt), empty stderr), group at lines 1289-1314:

```yaml
# == @deepseek-ai/dsh-experimental-session-search, patched by dsh-plugin-session-search-patched, <A>/home/.dsh/profiles/web/cordis.patch.yml
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
    - id: ssp-observer-group          # scratch observer row (profile layer)
      …
```

`docs/spike/analyze-dump.cjs` ([`dump-A0-A1.analysis.txt`](../test/scratch/evidence/dump-A0-A1.analysis.txt)):

```text
# test/scratch/evidence/dump-A1-bundle-on.txt
engine session-query-sqlite (@deepseek-ai/dsh-session-query-sqlite) scope=root state=enabled
engine optional-session-query-sqlite (@deepseek-ai/dsh-session-query-sqlite) scope=group:optional-session-search state=disabled
engine session-query-sqlite-patched (dsh-plugin-session-search-patched) scope=group:optional-session-search state=enabled
check exactly one enabled engine row in group: yes
check the enabled group engine is session-query-sqlite-patched: yes
check root engine rows are only session-query-sqlite with openAt never: yes
check tool row unchanged against baseline: yes
check group isolate {sessionQuery: true}: yes
```

Runtime (H2 snapshot, [`timeline-A.txt`](../test/scratch/evidence/timeline-A.txt) lines 22-40):
`optional-session-query-sqlite` disabled / NO-FIBER, `session-query-sqlite-patched` ACTIVE, tool row
ACTIVE, one provider. Host log (cordis logger buffer, read by the observer's root row):

```text
2026-11-18T10:01:14.064Z info [session-search-patched] session-search-patched: active engine: patched SqliteSessionQueryEngine (./engine/index.js); reason: host @deepseek-ai/dsh-session-query-sqlite 0.2.2-rc.3 and the sha256 of its src/index.ts, src/query.ts, src/schema.ts match the pinned values
```

Exactly one such line per start of the row (H2, H3 re-enable, H4 hot install, H5, H6 twice for its
two starts, H9).

## 6. Rollback (criterion 5)

| step | while running (HMR) | after restart | dump / grep |
|---|---|---|---|
| disable: name removed from `dsh.profile.bundles` (H2 10:02:34) | 2.9 s later `sessionQuery-down` patched, `sessionQuery-up` `SqliteSessionQueryEngine@optional-session-query-sqlite` (shipped class); the new row is gone from the Loader | H3: shipped row provides; 22 queries → `4700711b…` | [`dump-A2-bundle-disabled.txt`](../test/scratch/evidence/dump-A2-bundle-disabled.txt): one enabled group engine, `optional-session-query-sqlite`; [`grep`](../test/scratch/evidence/grep-A2-bundle-disabled.txt): only `package.json` (dependency) and `pnpm-lock.yaml` name the package — the switch keeps the dependency; no row in `cordis.yml` or the patch (the two other matches are the observer's own `file://` path under `test/scratch/`) |
| re-enable: name appended again (H3 10:04:19) | 2.6 s later shipped down, patched up; one log line; queries `4700711b…` | — | — |
| remove: `dsh plugin --profile web remove dsh-plugin-session-search-patched` (H3 10:05:04, [cli](../test/scratch/evidence/remove-A3-hot.txt)) | 3.2 s later patched down, shipped up; queries `4700711b…` | H4: shipped row provides; queries `4700711b…` | [`dump-A3-bundle-removed.txt`](../test/scratch/evidence/dump-A3-bundle-removed.txt) is byte-identical to the dump before the install ([`dump-A0-bundle-off.txt`](../test/scratch/evidence/dump-A0-bundle-off.txt)); [`grep`](../test/scratch/evidence/grep-A3-bundle-removed.txt) of every scratch profile file (`node_modules` excluded) for `dsh-plugin-session-search-patched` and `session-query-sqlite-patched`: **no match** (exit 1); `package.json` lost its `dependencies` key; the symlink `node_modules/dsh-plugin-session-search-patched` stays (pnpm 11.28.5, inert, as in the spike) |

Grep command: `cd <A>/home/.dsh/profiles/web && grep -rn --exclude-dir=node_modules -e dsh-plugin-session-search-patched -e session-query-sqlite-patched .`

## 7. Drills (criterion 4)

### 7.1 (a) a copy pinned to another version

Copies of the shipped files (`package.json cordis.patch.yml LICENSE src vendor patches`) under
`<B>/work/pkg-*`, changed only as stated (`diff` printed in the session).

| drill | change in the copy | install | runtime | evidence |
|---|---|---|---|---|
| a1 | `engines.dsh: "0.2.2-rc.4"` | **refused**: `dsh: installation rejected: Plugin dsh-plugin-session-search-patched@0.1.0 is incompatible with dsh 0.2.2-rc.3: requirements {"engines.dsh":"0.2.2-rc.4"} … dsh: nothing was installed.` (exit 1) | — | [`install-B1-a1-engines-rc4.txt`](../test/scratch/evidence/install-B1-a1-engines-rc4.txt), [dump](../test/scratch/evidence/dump-B1-a1-engines-rc4.txt) (shipped row only) |
| a1b | installed with rc.3, then `engines.dsh` set to `0.2.2-rc.4` in the installed copy (the state after a host update) | ok | dump stderr and H7 stderr: `dsh: skipping profile bundle "dsh-plugin-session-search-patched": … requirements {"engines.dsh":"0.2.2-rc.4"} …`; H7: `SqliteSessionQueryEngine@optional-session-query-sqlite`, shipped class, the patched row absent; queries `4700711b…` | [dump](../test/scratch/evidence/dump-B1b-a1-engines-rc4-after-install.txt), [stderr](../test/scratch/evidence/dump-B1b-a1-engines-rc4-after-install.stderr.txt), timeline-B lines 2-21 |
| a2 | `src/guard.js` `PINNED_VERSION = '0.2.2-rc.4'` | ok | H8: provider `SqliteSessionQueryEngine@session-query-sqlite-patched` **with the shipped class** (`sameClassAsRootShipped: true`, 0 patch methods, `persistedReadConcurrency: 1` = the row config), shipped row disabled; `warn` `session-search-patched: active engine: shipped SqliteSessionQueryEngine (@deepseek-ai/dsh-session-query-sqlite) as fallback; reason: compatibility guard failed: host @deepseek-ai/dsh-session-query-sqlite is 0.2.2-rc.3, not the pinned 0.2.2-rc.4`; queries `4700711b…` | timeline-B lines 22-43 |
| a3 | `src/guard.js` pin of `src/query.ts` set to 64 zeros | ok | H12: same fallback; `warn` `… as fallback; reason: compatibility guard failed: shipped src/query.ts sha256 b29363581b71… is not the pinned 000000000000…`; queries `4700711b…` | timeline-B lines 120-140 |

### 7.2 (b) package folder missing

H9: a copy `<B>/work/pkg-b` installed (control: patched provides, peers in app.asar). Moved away while
H9 ran: nothing changed live (the loaded modules keep serving; queries `4700711b…`). Dump with the
folder missing ([stderr](../test/scratch/evidence/dump-B3-b-folder-missing.stderr.txt)):
`dsh: skipping profile bundle "dsh-plugin-session-search-patched": Error: dsh: cannot resolve profile bundle "dsh-plugin-session-search-patched" from the dsh installation or <B>/home/.dsh/profiles/web; run 'dsh plugin --profile web install' if its dependency is not installed`;
analysis: one enabled group engine, the shipped one. H10 restart: same line on stderr, host up
(HTTP 401 to an unauthenticated request), `SqliteSessionQueryEngine@optional-session-query-sqlite`
(shipped class), tool row ACTIVE, queries `4700711b…` (timeline-B lines 77-96).

### 7.3 (c) a session the reader must refuse

[`test/scratch/plant-session.mjs`](../test/scratch/plant-session.mjs) writes synthetic v4 logs (Zstandard: first
frame the header line, second frame the event lines) into `<A>/home/.dsh/sessions/--tmp-ssp-s8-drill--/`
(gate: `scratch-home.mjs check`), never reading an existing log:
`unknown-type` = one event of type `ssp-s8-drill/required-future-event` without `ignorable`;
`unreadable` = header-only log with mode 000; `valid-empty` = readable header-only log (control).
All runs in H6 (root A), switched between engines live by the bundle switch.

| case | engine | persistence read of the planted session | every one of the 22 queries | time | host |
|---|---|---|---|---|---|
| control `valid-empty` | patched | listed (255 together with c1; not read on its own) | after c1 was removed and the control stayed: ok, `4700711b…` | — | alive |
| c1 `unknown-type` | patched | `SessionFormatUnsupportedError: session "5508d8c0-0000-4000-8000-00000000000a" contains event type "ssp-s8-drill/required-future-event" (seq 0) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness (raw log: …)` | `SESSION_QUERY_PERSISTENCE_FAILED` `SessionQueryError: session-search persistence observation failed: session "…" contains event type "…" (seq 0) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness (raw log: …)` | 8.1 s for all 22 (q01 7.6 s, then about 20 ms each) | alive: HTTP 401, rows ACTIVE, observer answering |
| c1 `unknown-type` | shipped | same | **same code and same (redacted) message**, results file sha256 `fdf823ef…` equal to the patched run | 129 s for all 22 (about 5.9 s each) | alive |
| c2 `unreadable` | shipped | `list()` fails: `EACCES: permission denied, open '…'` | `SESSION_QUERY_PERSISTENCE_FAILED` `session-search persistence observation failed: EACCES: permission denied, open '…'` | 0.43 s | alive |
| c2 `unreadable` | patched | same | same code and message, `fdf823ef…` | 0.43 s | alive |
| planted sessions removed | patched | — | ok, `4700711b…` | 19–26 s | alive |

`results-H6-c1-patched.A.json`, `…c1-shipped…`, `…c2-shipped…`, `…c2-patched…`: all
`fdf823ef2379800cf62054320f50f973e6f6a6aac2d7f7d6bd2a0521d10c136c` (22 × error code). Records:
timeline-A lines 257-422. The time difference in c1 is the patch at work: the patched engine keeps the
sessions it committed before the failing one, the shipped engine commits nothing in a failed pass and
re-reads the whole store on every search.

A first attempt (H5, timeline-A lines 241-256) wrote the planted log as one Zstandard frame; the
backend refuses that layout (`SessionPersistenceCorruptionError … first frame is not exactly one header line`)
and `list()` then simply leaves the session out (253 listed), so search ran without error. Same
behaviour for both engines (it is the persistence backend's); recorded as finding F4.

### 7.4 (d) install without restart (HMR)

H4 runs with the bundle removed (shipped serves, queries `4700711b…`). At 10:07:04 `node scripts/scratch-home.mjs dsh <A> -- plugin --profile web add "/Users/macbook/projects/dsh-plugins/packages/session-search-patched"`
([cli](../test/scratch/evidence/install-A4-hot.txt), exit 0 at 10:07:05). Snapshots once a second (timeline-A lines 131-221):

| time | state |
|---|---|
| 10:07:06.483 | shipped row ACTIVE, no patched row |
| 10:07:07.384 | `sessionQuery-down` shipped (`optional-session-query-sqlite`) |
| 10:07:07.400 | `sessionQuery-up` `SqliteSessionQueryEngine@session-query-sqlite-patched`, not the shipped class, 6 patch methods, bases identical |
| 10:07:07.402 | `info` line: patched engine, guard passed |
| 10:07:07.691 – 10:07:13.717 | shipped row disabled / DISPOSED, patched row ACTIVE, tool row ACTIVE; no error on any row |
| 10:07:15 – 10:07:42 | queries `4700711b…`, 0 errors |
| H5 restart (10:08:07) | patched provides from the start, shipped row NO-FIBER, one log line, queries `4700711b…` |

No provider clash and no failed row on the hot path; the group had no provider for about 16 ms
between the two records. The same live behaviour for re-enable (§6).

## 8. Re-check of the spike's clash case T5 with the real package

Profile layer adds `- id: optional-session-query-sqlite` / `disabled: false`
([`observers-t5-reenable-shipped.yml`](../test/scratch/observers-t5-reenable-shipped.yml)); dump analysis
`check exactly one enabled engine row in group: NO (2: …)` ([dump analysis](../test/scratch/evidence/dump-B4.analysis.txt)).
H11: the shipped row provides; the patched engine's registration fails and the entry logs
`error … session-search-patched: active engine: none (another row already provides sessionQuery in this group); reason: provider clash: service "sessionQuery" has been registered at <SqliteSessionQueryEngine>; a later layer (a profile or home cordis.patch.yml row with id optional-session-query-sqlite) turned the shipped engine row back on, and it serves search here; remove that override and restart the host`;
both rows ACTIVE, search ok (`4700711b…`). Cordis also logs one error line under the failed engine fiber's
logger (`sqlite-session-query-engine`). Matches the decision table (§13 fallback exception).

## 9. Findings and defects

No functional defect of the package was found: the guard passes on this host, the patched engine
serves identical results, every failure path ends with a working engine, and rollback works.

- **F1 (wording, criterion vs implementation).** Criterion 3 asks for the log line
  `session-search-patched: patched engine active`; `src/guard.js` `formatLine` produces
  `session-search-patched: active engine: patched SqliteSessionQueryEngine (./engine/index.js); reason: …`.
  The S5 contract (prefix, engine and reason) is met; the literal text is not. Repro: any start with
  the bundle on, then read `ctx.logger.buffer`. For the lead: change the criterion text, or have the
  owner of `src/guard.js` change the line (not changed here).
- **F2 (visibility).** None of the package's lines (info, warn fallback, error clash) appears on the
  stdout/stderr of `dsh web` (H1–H12, [`host-outputs.txt`](../test/scratch/evidence/host-outputs.txt)): the
  web host apparently has no console sink for the cordis logger; the lines were found only in the
  1000-entry in-memory logger buffer. The README (later task) should say where a user sees the line (the
  in-app log view was not verified here). Not a package defect.
- **F3 (install-time pin).** `dsh plugin add` refuses a package whose `engines.dsh` does not match the
  running host ("nothing was installed"), so the bundle-level skip only happens after a host update
  (a1b). Expected; noted for the README.
- **F4 (backend behaviour).** A session log in a layout the backend refuses as corrupt is left out of
  `list()` silently, so search succeeds without it — for both engines. Only an unknown event type
  (c1) or an unreadable file (c2) gives the clean error.

## 10. Doubts

- The bundle switch (disable / re-enable) was made by editing `dsh.profile.bundles` of the scratch
  profile, as the plugin manager's switch does; the plugin manager's own code path was not run
  (no plugin manager use is allowed in this plan). `remove` and `add` used the real CLI.
- The observer's `packageOf` lookups use the entry's real path URL (`SSP_ENTRY_URL`); whether the
  host imports the entry through that URL or the profile's symlink path was not observed directly.
  The entry's own guard line proves that its `packageOf(…, import.meta.url)` returned 0.2.2-rc.3.
- No session was opened in the scratch hosts, so the hits come from persisted sessions only; the
  live-session paths of the two engines were not compared here (S7 covers the engine spec).
- Timings and RSS are single runs on a laptop with the live host running in parallel.
- The store copy was taken by the lead while the live host ran; all comparisons use that one copy.
- `dsh plugin` runs pnpm, which contacted its registry for an update notice ("Update available!");
  no package was downloaded (link installs only).
- HMR re-applied the observer rows when the profile changed (H6), which is how the extended observer
  got loaded without a restart; it does not touch the rows under test.

## 11. Commands (exact, in order)

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"; cd packages/session-search-patched
(cd ~/.dsh/profiles/web && find . -maxdepth 1 -type f -print0 | sort -z | xargs -0 shasum -a 256)   # before / after, hashes only
sh test/scratch/store-fingerprint.sh /tmp/ssp-scratch-store/sessions                               # before / after
R=$(sh test/scratch/setup-root.sh main)        # root A (create, check, dump, select session-search, observers, store copy)
node scripts/scratch-home.mjs dsh $R -- --profile web --dump-config > test/scratch/evidence/dump-A0-bundle-off.txt
HOST="--set SSP_REPORT=$R/work/report.jsonl --set SSP_TRIGGER_DIR=$R/work/trigger --set SSP_ENTRY_URL=file://$PWD/src/index.host.js -- --profile web --no-open --host 127.0.0.1 --port 3198"
node scripts/scratch-home.mjs dsh $R --env-dump test/scratch/evidence/env-H1.txt $HOST       # background job H1
touch $R/work/trigger/off.query                                                             # → results-off.json
touch $R/work/trigger/<label>.snapshot                                                      # Loader rows + log lines
node scripts/scratch-home.mjs dsh $R -- plugin --profile web add "$PWD"                     # cold install (host stopped)
node scripts/scratch-home.mjs dsh $R -- --profile web --dump-config > test/scratch/evidence/dump-A1-bundle-on.txt
node scripts/scratch-home.mjs run $R --cwd "$PWD" --set ELECTRON_RUN_AS_NODE=1 -- "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" docs/spike/analyze-dump.cjs <baseline> <dumps…>
sh test/scratch/refresh-store.sh $R                                                         # before every compared run
node scripts/scratch-home.mjs dsh $R --env-dump test/scratch/evidence/env-H2.txt $HOST       # H2; touch on.query
# disable / re-enable: remove / append "dsh-plugin-session-search-patched" in $R/home/.dsh/profiles/web/package.json dsh.profile.bundles
node scripts/scratch-home.mjs dsh $R -- plugin --profile web remove dsh-plugin-session-search-patched
node scripts/scratch-home.mjs dsh $R -- plugin --profile web add "$PWD"                     # drill d, host H4 running
node test/scratch/plant-session.mjs $R unknown-type|unreadable|valid-empty|remove          # drill c
touch $R/work/trigger/<label>.store                                                         # persistence facts of the planted sessions
B=$(sh test/scratch/setup-root.sh drills)                                                   # root B, copies under $B/work/pkg-{a1,a2,a3,b}
node scripts/scratch-home.mjs dsh $B -- plugin --profile web add "$B/work/pkg-a1"           # and pkg-a2, pkg-a3, pkg-b (remove between)
node scripts/scratch-home.mjs run $R --cwd "$PWD" --set ELECTRON_RUN_AS_NODE=1 -- "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/scratch/asar-sources-vs-guard.mjs "file://$PWD/src/guard.js"
python3 test/scratch/summarize.py $R/work/report.jsonl > test/scratch/evidence/timeline-A.txt
node scripts/scratch-home.mjs destroy $R; node scripts/scratch-home.mjs destroy $B          # guarded delete
```

## 12. Files

| file | content |
|---|---|
| `test/scratch/observer/index.js`, `package.json` | the observer rows (group: provider, identity, packageOf, sources, store, query runs; root: snapshots, log lines) |
| `test/scratch/observers.yml`, `observers-t5-reenable-shipped.yml` | scratch profile patches |
| `test/scratch/setup-root.sh`, `refresh-store.sh`, `store-fingerprint.sh`, `plant-session.mjs`, `asar-sources-vs-guard.mjs`, `summarize.py` | recipe helpers |
| `test/scratch/real-profile-sha256-{before,after}.txt` | criterion 6 |
| `test/scratch/evidence/results-*.json` | 21 hashed result files (`.A`/`.B` = root) |
| `test/scratch/evidence/report-{A,B}.jsonl.txt`, `timeline-{A,B}.txt` | raw observer records and timelines |
| `test/scratch/evidence/dump-*.txt`, `*.analysis.txt`, `grep-*.txt`, `install-*.txt`, `remove-*.txt`, `env-H*.txt`, `host-outputs.txt`, `scratch-roots-before-after.txt`, `asar-sources-vs-guard.txt` | dumps, CLI output, environments, host output, removal listing |
