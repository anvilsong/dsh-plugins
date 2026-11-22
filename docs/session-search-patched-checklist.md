# Patched session-search engine checklist (`packages/session-search-patched`)

Follow this by hand on a real profile before you rely on
`dsh-plugin-session-search-patched`, and again after each change to the package.
The package tests only run engines and a simulated entry; the install on a real
host has been verified on scratch DSH homes only
(`packages/session-search-patched/docs/scratch-verification.md`). Every check below
comes from `packages/session-search-patched/README.md` and the records in that
package's `docs`; where they do not settle a point, the step says **not verified**.

The package is an **unofficial** patched copy of the shipped engine, pinned to DSH
**0.2.2-rc.3**. It is not on npm: you install it by folder path. This is the first
install on your own profile, so you do it with the rollback ready (read "The way back"
before you start) and you stop at the first failure.

## Prerequisites

- DSH **0.2.2-rc.3**: `dsh --version` prints it. On another version the install is
  refused (`nothing was installed`) and there is nothing to check.
- The optional session-search bundle (`@deepseek-ai/dsh-experimental-session-search`)
  is switched on in the profile, **before** you install this package. Check with
  `dsh --profile <profile> --dump-config` that the group `optional-session-search`
  exists and holds the rows `optional-session-query-sqlite` and
  `optional-tool-session-query`. Run the dump only with the host STOPPED: it
  rewrites `<DSH home>/profiles/<profile>/cordis.yml`; it was run on scratch homes
  only.
- Node 24 for the package's own tests; not needed for the install.
- A checkout of this repository: `PKG="$PWD/packages/session-search-patched"`.
- `dsh web` with HMR (the usual way). On a host without HMR, install and rollback
  apply only after a restart.
- A Terminal. You need the host's process id for the memory steps:
  `pgrep -fil dsh`, and for `dsh web` the process that listens on its port
  (`lsof -nP -iTCP:<port> -sTCP:LISTEN`).
- A way to run a search: ask an agent session to use the session-search tool and
  print the **raw tool result** (hit count and the hits in order, with their
  session ids or titles), not a summary. The tool's name and output format are
  **not verified** here; use whatever your host shows.
- Know the effects of one search: **the session you ask in contains your
  question**, so it is a hit for every query and its hit changes with each
  question. Use one dedicated "search session" for all searches, and leave its
  hit out of every comparison below.
- Do not write to any other session between the "before" and the "after"
  snapshots (the store must not change, or the results change for a good reason).
- Optional dry run: the same install, dump and rollback on a scratch home made by
  `packages/session-search-patched/scripts/scratch-home.mjs` (recipe in
  `docs/scratch-verification.md` §11); the scripts refuse the real `~/.dsh`.
- A "failure" below means: write it down in the table at the end, with what you
  saw instead. Do not retry until you have recorded it.

## The way back (read first)

The way back is **bundle-level**; practise it in scenario 8, and keep it at hand
from the install on:

```sh
dsh plugin --profile <profile> remove dsh-plugin-session-search-patched
```

or take the bundle name out of `dsh.profile.bundles` by hand (the one-liner is in
`packages/session-search-patched/docs/rollout-record.md`, section 7). Switching the bundle off
on the Plugins page was not exercised; do not rely on it. On a running `dsh web`
the removal applies about 3 seconds later; restart afterwards. Never
disable only the row `session-query-sqlite-patched`: the shipped row stays off,
the group has no engine and **search is dead** until the bundle is switched off or
removed.

## 1. Before-snapshot of five searches (shipped engine)

1. Restart the host so the search index is cold, as it will be after the install.
   Note the time.
2. In the search session, run these five searches, one after another, and copy
   each raw result into a file you keep (`before-1.txt` … `before-5.txt`):
   1. a word your store holds in **many** sessions (limit 20 or more);
   2. a rarer word: 3 to 10 sessions;
   3. a phrase of two or three words that one old session holds;
   4. a word that exactly one old session holds (a singleton);
   5. a non-English word or phrase that your store holds, if any; else a second
      rare word.
3. For each, record the hit count and the order of the first ten hits (session id
   or title). Leave out the hits of the search session.
4. After the **first** search, read the host's memory (see "Host memory"), and
   again after the fifth. Use the process id from the prerequisites.
5. Open `<DSH home>/profiles/<profile>/package.json` and note that it does **not**
   name `dsh-plugin-session-search-patched`.

Failure means: a search that fails already with the shipped engine
(`SESSION_QUERY_PERSISTENCE_FAILED` or a host that aborts with a JavaScript
out-of-memory error). Write the exact text down; it is the control that the
package is meant to change. Do not install while the failure cause is one
unreadable or unknown-event-type session: this package does **not** fix that, and
both engines give the same clean error (README, "What it does not fix").

## 2. Install

Follow `packages/session-search-patched/docs/rollout-record.md`, section 6: stop the
host first (the host runs your session, so this ends it), install from a **frozen
copy** of the reviewed commit, start the host again with your usual command line.
The steps below name what to check at each point.

1. From the frozen copy (`PKG`, made as in the rollout record, section 6.2 step 1;
   installing straight from the working tree also works, but nobody may edit
   `src/` while it is installed):

   ```sh
   dsh plugin --profile <profile> add "$PKG"
   ```

   Expect exit 0 and no `installation rejected`. (A rejection reads `Plugin … is
   incompatible with dsh …` and ends `nothing was installed`; the host version is
   then not 0.2.2-rc.3.)
2. Installing while `dsh web` runs was tested only on a scratch host: it applied
   about 2 seconds later. On your real host it recomposes the whole profile and
   restarts other linked plugins whose files changed since the host started;
   prefer the host stopped, as the rollout record recommends.
3. `<DSH home>/profiles/<profile>/package.json` now names
   `dsh-plugin-session-search-patched` in `dependencies` and in
   `dsh.profile.bundles`, after the session-search bundle.

Installing from the Desktop **Add plugin** dialog is **not verified**; use the
command line on the profile the app uses.

Failure means: a rejection on a 0.2.2-rc.3 host, the bundle listed **before** the
session-search bundle (both patches would then be skipped and the shipped engine
keeps serving), or any change to files outside the profile folder. Read README,
"Install".

## 3. Restart

1. Stop the host and start it with the command you normally use (for the web
   host that is the same `dsh` command line you started it with before). Refresh
   the page.
2. Expect no line `dsh: skipping profile bundle "dsh-plugin-session-search-patched"`
   on the terminal of `dsh web`.
3. Look at the Plugins page for the session-search bundle and this package's bundle. What each row looks like in the GUI is **not verified**; write down what
   you see.

Failure means: a skipped bundle (read the line: it names the failed requirement),
a host that does not start, or search tools missing from the agent.

## 4. Active-engine check

Four checks. The first is the only one that names the class; the others show the
row and the effect.

1. **Log line.** The host logs one line per start of the row, to its in-memory
   logger buffer (1000 entries). It does **not** appear on the terminal of
   `dsh web`, and a log view in the app is **not verified**. If you can read the
   buffer, expect exactly this line (the version and the three file names are
   fixed):

   ```text
   session-search-patched: active engine: patched SqliteSessionQueryEngine (./engine/index.js); reason: host @deepseek-ai/dsh-session-query-sqlite 0.2.2-rc.5 (pinned 0.2.2-rc.3 / 0.2.2-rc.5) and the sha256 of its src/index.ts, src/query.ts, src/schema.ts match the pinned values
   ```

   Not that line, but `active engine: shipped SqliteSessionQueryEngine
   (@deepseek-ai/dsh-session-query-sqlite) as fallback; reason: …`: the guard or
   the patched engine failed; the shipped class serves inside the new row.
   `active engine: none (another row already provides sessionQuery …`: a profile or
   home row turned the shipped row back on; remove it and restart. If you cannot
   read the buffer, write "line not readable" in the table; do not mark this check
   passed on the next three alone.
2. **Composed config** (with the host stopped, because the dump rewrites
   `cordis.yml`). `dsh --profile <profile> --dump-config`, then look at the
   group `optional-session-search` (for example `… | grep -n -A 24 'id:
   optional-session-search'`). Expect, in this order: `optional-session-query-sqlite`
   with `disabled: true`; `optional-tool-session-query` unchanged;
   `session-query-sqlite-patched` with `name: dsh-plugin-session-search-patched` and
   the config `path: ':memory:'`, `openAt: first-search`,
   `persistedReadConcurrency: 1`; and the group's `isolate:` with
   `sessionQuery: true`. Exactly one enabled engine row in the group. No engine row
   outside the group except the root row `session-query-sqlite` with
   `openAt: never`.
3. **Plugins page.** What it shows for this bundle and for the shipped row
   `optional-session-query-sqlite` is **not verified**: the page may list no row
   for this bundle. Write down what you see; do not fail the check on it.
4. **Behaviour**: scenarios 5 to 7 below.

Failure means: two enabled engine rows in the group, an engine row outside the
group, the shipped row without `disabled: true`, or no `session-query-sqlite-patched`
row. The dump and the Plugins page show the **row**, not the class inside it: a
guard failure keeps the row and mounts the shipped class, so a passing dump does
not prove the patched engine runs. Read README, "Which engine is active".

## 5. Same results

Immediately after the restart (cold index again), in the same search session, run
the five searches of scenario 1 in the same order, and save the raw results as
`after-1.txt` … `after-5.txt`.

1. For each query: the same hit count and the same order of hits as before. Leave
   out the hit of the search session (it also contains the queries you typed since).
2. A difference is a failure unless a conversation changed the store between the
   snapshots; then say which session and compare only the others.
3. The first search after the restart may take a little longer on a small store;
   on a large store it should not take longer than before. Note both times.

Failure means: a different count, a different order, a missing or extra session,
or an error that the "before" run did not give. The scratch comparison (22
queries, 1669 session hits and 100 event hits, byte-identical with the bundle off
and on) is the reference.

## 6. Host memory

1. Read the host's resident memory (RSS, in KB) at three points, before and after
   the install, with the same sequence each time:

   ```sh
   ps -o pid=,rss= -p <host pid>
   ```

   - right after the restart, before any search;
   - right after the **first** search;
   - after the fifth search.
2. Expect the patched host to be at or below the "before" figures after the first
   search. The only reference is the scratch run: one sample each, indicative only,
   after 22 queries on a 253-session store copy, **1.20 GB** with the shipped
   engine and **0.81 GB** with the patched one. Your store, host and sampling
   differ.
3. On a store that made the shipped engine abort in step 1 of scenario 1, expect
   the first search to complete.
4. The index is in memory (`path: ':memory:'`): its native memory grows with the
   store and is not changed by the patch; a high RSS alone is not a failure.

Failure means: more memory than the shipped engine after the first search on the
same store, a host abort, or an error that the shipped engine did not give. Write
the figures down. Read README, "Limits".

## 7. Search during an appending session

This is the case the patch targets: a session that grows while the cold index is
built. The recorded evidence is a model (one append after every 4th log read), not a
live run on a real host; this step is the first live observation.

1. Restart the host (cold index).
2. In session A (not the search session), start a task that keeps the assistant
   writing for a minute or more (a long answer or a long tool run).
3. While A is streaming, in the search session, run search 1 of scenario 1.
4. Expect a result list (the search may be slow on a large store). Then run it
   again once A has finished: the same hits, plus the new text of A.
5. If the search fails with `SESSION_QUERY_PERSISTENCE_FAILED` (message
   `session-search persistence observation failed …`), repeat it: the patched
   engine keeps what it already read, so the second search reads only the logs
   that moved and should pass. Write the first failure down. A session that
   appends after every single log read can still defeat the patched engine
   (`C3 boundary` in `docs/verification.md`); that is a known limit.
6. Optional control: do the same once on the shipped engine (before the install, or
   after the rollback drill). The shipped engine may fail the first search with
   the same code. That it does is a modeled result, not a prediction for your
   store.

Failure means: a search that keeps failing after the appending session has
stopped, a host abort, or a hit list that misses a session that existed before the
test. Read README, "Why" and "Limits".

## 8. Rollback drill

Do it once with nothing pending, so you know it works on your profile.

1. Note the time. Run:

   ```sh
   dsh plugin --profile <profile> remove dsh-plugin-session-search-patched
   ```

   Expect exit 0. About 3 seconds later, with the host running, search is served
   by the shipped row again.
2. With the host stopped, `dsh --profile <profile> --dump-config`: the group has one enabled engine row,
   `optional-session-query-sqlite` (no `disabled: true`), and no
   `session-query-sqlite-patched`. `<DSH home>/profiles/<profile>/package.json` no
   longer has the `dependencies` entry or the bundle entry. A symlink
   `<DSH home>/profiles/<profile>/node_modules/dsh-plugin-session-search-patched`
   may remain; it is inert.
3. Restart the host. Run search 1 and 4 of scenario 1: the same results as the
   "before" snapshot.
4. After you switched the *session-search* bundle off and on, remove and install
   this bundle again once, so that its layer comes after it again.
5. Do **not** try "disable only the row" on a profile you use: it leaves the group
   without a provider and kills search until the bundle is switched off or
   removed.

Failure means: a shipped row that does not come back, search that stays dead, a
dump with two enabled engine rows, or any row of the package left in the profile
after `remove` (apart from the inert symlink).

## Record your result

Copy this table. Get the commit with `git rev-parse --short HEAD`, and the
package version from `packages/session-search-patched/package.json`.

| Date | Commit | Scenario | Pass/fail | Note |
|---|---|---|---|---|
| | | 1 Before-snapshot of five searches | | |
| | | 2 Install | | |
| | | 3 Restart | | |
| | | 4 Active-engine check (line / dump / Plugins page) | | |
| | | 5 Same results | | |
| | | 6 Host memory (before / after, KB) | | |
| | | 7 Search during an appending session | | |
| | | 8 Rollback drill | | |
