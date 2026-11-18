# Build audit (S4): generated engine against the shipped rc.3 build

`src/engine/{index,query,schema}.js` and `src/engine/manifest.json` are generated from
`vendor/src/*.ts` by `scripts/build.mjs` (type strip, mode `strip`). This file checks that what
ships behaves like the engine installed in the app (`@deepseek-ai/dsh-session-query-sqlite`
0.2.2-rc.3, `lib/index.js`) plus the patch `patches/engine-0.2.2-rc.3.diff`, and nothing else.

Recorded on 2026-11-18 with node v24.22.3 (`export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"`),
`@electron/asar` through `npx --yes`. Paths below are relative to the package folder
`packages/session-search-patched` unless they start with `/`.

## 1. Result

| Item | Result |
|---|---|
| Host-import mode | **bare** (composition-spike.md §13): bare specifiers kept, no `map` |
| `scripts/build.config.json` | `{"baseVersion": "0.2.2-rc.3", "allow": [the 8 bare specifiers of §13]}`, sha256 `d4f70d2a4a7e7eb5ba8f646690d854e32cce6e3a588c7cbf3f24232dadbe61fc` |
| `node scripts/build.mjs --check` | exit 0, `ok: src/engine matches a fresh generation` |
| `node --check` of each generated file | exit 0 (3 files) |
| Import specifiers of `src/engine` | exactly the allow-list of §13 (8 bare + `./query.js`, `./schema.js`) |
| Class fields without initializer | 7: the 6 of rc.3 plus `_persistedRowsBinding` (patch hunk 3); all have the same define semantics as the shipped build (§4.1) |
| Fields over `ctx` / `name` / `config` | no field named `ctx` or `name`; `config` is a field in the shipped build too; no overwrite (§4.2) |
| const enums, parameter properties | none (§4.3, §4.4) |
| Value imports used only as types | one: `Context` from `@deepseek-ai/cordis`; harmless (§4.5) |
| Exports and static members | equal to the shipped rc.3 `lib/index.js` (§5) |
| Generated `index.js` vs strip of the rc.3 original | differs only at the 68 removed / 212 added lines of the patch; `query.js`, `schema.js` byte-identical (§6) |
| Vendor edit needed | **no** (no `declare` is needed; §7) |

Generated files (sha256):

| File | sha256 | bytes |
|---|---|---|
| `src/engine/index.js` | `bef011ff1234e3bdab3863d17390480714875051713c7599dda00f170c5037f9` | 47985 |
| `src/engine/query.js` | `b81c045b5551658d9742ea3f24ae5774abb7acb3a8566b44bc189f6ba9570ab6` | 15548 |
| `src/engine/schema.js` | `7d6be83f3d5ffd876770edaaeea187670eee182e050ee7852b66c4206a5b97f2` | 6098 |
| `src/engine/manifest.json` | `3a6a6189a2f9e1db15a0964bf664cdbde5c26c63ffba2b3c3f4c9749e67d0a1f` (holds the other three hashes, the inputs, the config and the script hash `b35e519f58cd049871e71e796655ff351ebbfac3f376cebe9ba6244af4796724`) | 1621 |

## 2. Reference files

Extracted from the installed app into a scratch folder (extract-file writes into the cwd):

```sh
mkdir -p /tmp/ssp-s4/shipped && cd /tmp/ssp-s4/shipped
for f in lib/index.js src/index.ts src/query.ts src/schema.ts package.json; do
  npx --yes @electron/asar extract-file "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" \
    dsh/node_modules/@deepseek-ai/dsh-session-query-sqlite/$f
done
shasum -a 256 *
```

```
dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0  index.js      (lib/index.js, 46487 bytes, 1155 lines)
72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3  index.ts      (src/index.ts)
e19acdd6c66e7f504e0e4c953938162c1285f57d2b374c8daa0ea28d1493a302  package.json  (version 0.2.2-rc.3)
b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48  query.ts
2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f  schema.ts
```

All five equal the hashes in `vendor/PROVENANCE.md`. Below, "shipped:N" is a line of this
`lib/index.js`, "gen:N" a line of `src/engine/index.js`, "strip-rc3:N" a line of the rc.3
`src/index.ts` stripped by the same generator (§6).

For the base classes the same way: `dsh/node_modules/@deepseek-ai/cordis/lib/index.js` (cordis
4.1.0, sha256 `627409afa06a265f7253200d3bc4648e88805c39fd3768568eb9b9518a31fe8f`, equal to this
repository's `node_modules/@deepseek-ai/cordis/lib/index.js`) and
`dsh/node_modules/@deepseek-ai/dsh-session-query/lib/index.js` (0.2.2-rc.3), plus the export lists of
`dsh-session/lib/index.js` and `schemastery/lib/index.mjs`.

How the shipped file was built: rc.3 `tsconfig.base.json` (`git -C /Users/macbook/projects/deepseek-harness show dsh-v0.2.2-rc.3:tsconfig.base.json`)
has `"target": "es2024"` and `"verbatimModuleSyntax": false`; the engine's tsconfig writes to
`lib/types`, and a bundler step joined those outputs into `lib/index.js` (region markers
`//#region lib/types/schema.js` shipped:8 and `//#region lib/types/index.js` shipped:460). With a target
of ES2022 or later, tsc's `useDefineForClassFields` defaults to true, so class fields keep
define semantics; with `verbatimModuleSyntax: false`, tsc drops imported names that are used only as types.
Type strip has the same field semantics and keeps every value import; §4 shows each case.

## 3. Generation

```sh
cd /Users/macbook/projects/dsh-plugins
node packages/session-search-patched/scripts/build.mjs
```

```
wrote src/engine/index.js (sha256 bef011ff1234e3bd...)
wrote src/engine/query.js (sha256 b81c045b5551658d...)
wrote src/engine/schema.js (sha256 7d6be83f3d5ffd87...)
wrote src/engine/manifest.json (sha256 3a6a6189a2f9e1db...)
class fields without initializer (7):
  src/engine/index.js:230:12 SqliteSessionQueryEngine.config
  src/engine/index.js:233:11 SqliteSessionQueryEngine._ready
  src/engine/index.js:234:11 SqliteSessionQueryEngine._db
  src/engine/index.js:236:11 SqliteSessionQueryEngine._lastPersistenceIdentity
  src/engine/index.js:240:11 SqliteSessionQueryEngine._persistedRowsBinding
  src/engine/index.js:246:11 SqliteSessionQueryEngine._closePromise
  src/engine/index.js:247:20 SqliteSessionQueryEngine._optionalPersistenceFiber
semicolons inserted by strip (1):
  src/engine/index.js:271:3
```

(stderr: Node's `ExperimentalWarning: stripTypeScriptTypes is an experimental feature`.) Then:

```sh
node packages/session-search-patched/scripts/build.mjs --check        # ok: src/engine matches a fresh generation, exit 0
for f in index query schema; do node --check packages/session-search-patched/src/engine/$f.js; echo "$f $?"; done
# index 0 / query 0 / schema 0
node --test packages/session-search-patched/test/engine-artifact.test.mjs   # 6 pass, 2 skipped (opt-in, §8), exit 0
```

The board text for this task named six fields; that list is the rc.3 original's (the same generator
on the rc.3 sources reports exactly those six, §6). The seventh, `_persistedRowsBinding`, is new in the
patch (hunk 3).

## 4. Construct audit

### 4.1 Class fields without initializer

A field without initializer is still defined on every instance (value `undefined`) right after
`super()` returns. The shipped build has the same field declarations, in the same order:

| # | Generated (gen:line:col) | strip-rc3 | Shipped | Verdict |
|---|---|---|---|---|
| 1 | `config` gen:230:12 | 227:12 | shipped:499 `config;` | same semantics: defined `undefined`, assigned at gen:253 / shipped:514 `this.config = config` before any other statement of the constructor |
| 2 | `_ready` gen:233:11 | 230:11 | shipped:501 `_ready;` | same; code reads `undefined` as "not opened" (gen:356, gen:377 `this._ready ??= this._open()`; shipped:613) |
| 3 | `_db` gen:234:11 | 231:11 | shipped:502 `_db;` | same; `undefined` = closed (gen:878; shipped:899 `if (this._db === void 0) throw indexClosed()`) |
| 4 | `_lastPersistenceIdentity` gen:236:11 | 233:11 | shipped:504 `_lastPersistenceIdentity;` | same; `undefined` = no pass yet (gen:446; shipped:663) |
| 5 | `_persistedRowsBinding` gen:240:11 | — (patch) | — (not in rc.3) | patch field; defined `undefined` like its neighbours, which is the state the patch expects ("undefined until this connection's first commit or completed pass", gen:237-239; read at gen:662, set at gen:479, gen:626) |
| 6 | `_closePromise` gen:246:11 | 239:11 | shipped:510 `_closePromise;` | same; gen:336 / shipped:585 `this._closePromise ??= this._close()` |
| 7 | `_optionalPersistenceFiber` gen:247:20 | 240:20 | shipped:511 `_optionalPersistenceFiber;` | same; assigned at gen:254 / shipped:515 |

Runtime evidence (§5.2): the own keys of a constructed engine, shipped and generated, are the same
list in the same order, plus `_persistedRowsBinding` after `_lastPersistenceIdentity`; the keys left
`undefined` after construction are `_ready, _db, _lastPersistenceIdentity, _closePromise` (shipped)
and the same plus `_persistedRowsBinding` (generated).

### 4.2 Field define semantics over `ctx`, `name`, `config`

cordis 4.1.0 `Service` declares `ctx;` and `name;` as its own fields and sets both in its
constructor (host cordis `lib/index.js:1815`, `:1831`, `:1843`, `:1851-1852`; registration at
`:1854`), and rc.3 `SessionQueryEngine` calls `super(ctx, "sessionQuery")` and declares only
`_readWindowMax; _corpus; _observations;` (host dsh-session-query `lib/index.js:1078-1093`). A
subclass field named `ctx` or `name` would be redefined to `undefined` after `super()` and break the
service.

| Name | Generated | Shipped | Verdict |
|---|---|---|---|
| `ctx` | no field in `SqliteSessionQueryEngine` (only the constructor parameter, gen:249) | none (shipped:476-511) | no overwrite; `engine.ctx === ctx` after construction, both builds (§5.2) |
| `name` | no field | none | no overwrite; `engine.name === 'sessionQuery'` both builds |
| `config` | field gen:230, assigned gen:253 | field shipped:499, assigned shipped:514 | identical; neither base sets an instance `config` (cordis `Service.config` is a static symbol, `:1821`), and no base prototype has a `config`/`ctx`/`name` accessor (the only `get name()` in cordis belongs to `Fiber`, `:296`/`:411`); resolved config equal in both builds (§5.2) |

The comment at gen:250-251 (the base constructor registers `ctx.sessionQuery` before
`this.config` is assigned) describes the same window in both builds: during `super()` the
property does not exist yet, between field definition and gen:253 it is `undefined`. No statement
runs in that window in either build (the field initializers that run there are `randomUUID()`,
`{ identity: Symbol() }`, `0`, `Promise.resolve()`, `false`).

### 4.3 const enums

| Generated | Shipped | Verdict |
|---|---|---|
| no `enum` in `vendor/src` (the generator refuses `enum`, `const enum` and namespaces with values) | no enum object or inlined enum member in shipped:1-1155 | none. Every imported value name is a runtime export of its host package, so none is a const enum or a type: cordis export list `:1901` (has `Context`, `Service`), dsh-session `:2142` (`SESSION_FORMAT_VERSION`, `SessionSeq`), dsh-session-query `:1289` (all 10 names), schemastery `:635` (`Schema as default`). |

### 4.4 Parameter properties

| Generated | Shipped | Verdict |
|---|---|---|
| `constructor(ctx         , config        )` gen:249: no modifier (the generator refuses parameter properties) | `constructor(ctx, config)` shipped:512 | none; same |

### 4.5 Value imports used only as types

| Specifier | Generated (all three files) | Shipped (shipped:1-7) | Verdict |
|---|---|---|---|
| `node:crypto` | `createHash, randomUUID` | same | same |
| `@deepseek-ai/dsh-session` | `SESSION_FORMAT_VERSION, SessionSeq` | same | same |
| `@deepseek-ai/cordis` | `Context, Service` (gen:10) | `Service` (shipped:3) | **`Context` is used only as a type** (gen:249, gen:254 annotations, gen:71-76 `declare module` augmentation, all erased). tsc dropped it; strip keeps the binding. Harmless: cordis exports `Context` (`:1901`), the module is already imported for `Service`, so nothing more is loaded or evaluated; the bare specifier resolves to the host cordis (spike §7). |
| `@deepseek-ai/schemastery` | default as `z` | same | same |
| `@deepseek-ai/dsh-session-query` | default as `SessionQueryEngine` + 8 names (gen:18-27) and `SessionQueryError, materializeSessionEventResultFilters, materializeSessionResultFilters` (query.js:3-7) | default + the same 10 names (shipped:5) | same set |
| `node:fs/promises`, `node:path` | `mkdir, open`; `dirname, resolve` (schema.js) | same (shipped:6-7) | same |
| `node:sqlite` | dynamic `import('node:sqlite')` (schema.js:52) | shipped:50 | same |
| `@deepseek-ai/dsh-session-persistence` | `import type` only (vendor 13-17), erased | not imported | same (the optional peer is never loaded) |

The opt-in test (§8) computes the imported bindings of both builds and asserts that the only
difference is the extra `Context`.

### 4.6 Other constructs of the strip

| Construct | Generated | Shipped | Verdict |
|---|---|---|---|
| `;` inserted by strip | gen:271 `;         async [Service.init]()` (strip-rc3:264, same place) | shipped:534 `async [Service.init]() {` | an empty class element; no effect (members and their order equal, §5.2) |
| Fields without `;` (ASI) | gen:230-247 end without `;`; each next line starts with a name, a comment or `constructor` | shipped:499-511 end with `;` | same parse: `node --check` passes and the instance keys equal the shipped ones (no field joined to the next member) |
| `declare module '@deepseek-ai/cordis'` | gen:71-76 blank | absent | same (type only) |
| Modifiers `private`, `protected`, `readonly`, `override`, `static override` | erased to spaces | absent | same; tsc emits nothing for them either |
| `as const`, generics (`_serialized<T>`, `new Promise<T>`), annotations | erased | absent | same |
| `export { …, type JournalMode } from './schema.ts'` | gen:62-66 `export { SESSION_QUERY_SQLITE_APPLICATION_ID, SESSION_QUERY_SQLITE_SCHEMA_VERSION, } from './schema.js'` | both names in shipped:1155 | same exports |
| Module layout | three modules: `index.js` imports `./schema.js`, `./query.js` | one bundle, schema and query code first (shipped:8-459) | same evaluation order (schema, query, index); their top level only defines constants, functions and one `Set` |
| Class form | `export class SqliteSessionQueryEngine` (gen:206) + `export default` (gen:1275) | `var SqliteSessionQueryEngine = class extends …` (shipped:476) + `SqliteSessionQueryEngine as default` (shipped:1155) | same `name` (`SqliteSessionQueryEngine`), same static keys; nothing reads or reassigns the binding before the class is defined |
| Bundler rewrites | constants by name (`SESSION_QUERY_SQLITE_SCHEMA_VERSION`, `SESSION_QUERY_SQLITE_DEFAULT_LIMIT`, …), `undefined` | inlined values (shipped:60 `version !== 8`, shipped:491 `.default(20)`), `void 0`, `/* @__PURE__ */` | same values; Config schema of both builds equal as data (§5.2) |
| Downlevel helpers | none | none (no `__helper(` call; the four `__` are `@__PURE__` comments) | ES2022+ syntax kept by both |

## 5. Exports and static members (criterion 5)

### 5.1 Table

| | Shipped rc.3 `lib/index.js` | Generated `src/engine/index.js` |
|---|---|---|
| Exports | shipped:1155 `SESSION_QUERY_SQLITE_APPLICATION_ID, SESSION_QUERY_SQLITE_DEFAULT_LIMIT, SESSION_QUERY_SQLITE_MAX_LIMIT, SESSION_QUERY_SQLITE_PATH_KEY, SESSION_QUERY_SQLITE_SCHEMA_VERSION, SESSION_QUERY_SQLITE_SNIPPET_CHARS, SqliteSessionQueryEngine, default` | the same 8 (gen:62-66, 69, 79, 81, 83, 206, 1275) |
| Constant values | `1146308689`, `20`, `100`, `'launcherSessionQueryPath'`, `8`, `240` | same |
| `default` | the class | the class |
| Static members declared | `inject` (shipped:477 `["sessions"]`), `Config` (shipped:478, `z.object` with `path, openAt, journalMode, defaultLimit, maxLimit, snippetChars, readWindowMax, persistedReadConcurrency, preparedSessionCacheSize`) | `inject` (gen:207 `['sessions']`), `Config` (gen:209, same keys and chains) |
| `provide`, static `name` field | none (the name comes from `super(ctx, "sessionQuery")` in the base) | none |
| Constructor own keys | `length, name, prototype, inject, Config` | same order |
| Base class | `SessionQueryEngine` | same |

`test/engine-artifact.test.mjs` records these lists and checks the generated file against them,
statically (tokens of the export statements and of the class body) and by evaluating the module.

### 5.2 Evaluation against stubs

The test copies the engine files next to small stub packages for the four host imports (cordis
`Service`/`Context` with the field and constructor layout of cordis 4.1.0; rc.3 `SessionQueryEngine`
with its three fields and `super(ctx, 'sessionQuery')`; a schemastery stand-in that records the
schema as data; dsh-session constants) in a temp folder, imports `index.js` and constructs the
engine with the row config `{path: ':memory:', openAt: 'first-search', persistedReadConcurrency: 1}`.
The same harness on the shipped `lib/index.js` (opt-in test; dump by `/tmp/ssp-s4/describe-dump.mjs`,
the harness of the test plus a print) gives:

| Property | Shipped | Generated |
|---|---|---|
| exports, constants, `default === SqliteSessionQueryEngine`, class name, base name | equal (5.1) | equal |
| static own keys / `inject` / Config schema data | `length,name,prototype,inject,Config` / `["sessions"]` / — | equal / equal / equal (JSON) |
| instance own keys | `ctx, name, _readWindowMax, _corpus, _observations, config, _instance, _ready, _db, _persistenceBinding, _lastPersistenceIdentity, _persistenceEpoch, _globalGeneration, _localGeneration, _tail, _closed, _closePromise, _optionalPersistenceFiber` | same with `_persistedRowsBinding` after `_lastPersistenceIdentity` |
| `engine.ctx === ctx`, `engine.name`, registered instance | `true`, `'sessionQuery'`, the engine itself | same |
| `engine.config` | `{path: ':memory:', openAt: 'first-search', journalMode: 'wal', defaultLimit: 20, maxLimit: 100, snippetChars: 240, readWindowMax: 50, persistedReadConcurrency: 1, preparedSessionCacheSize: 5}` | same |
| `ctx.effect` labels / `ctx.inject` calls | `sessionQuerySqlite.optionalPersistence`, `sessionQuerySqlite.close` / `[["sessionPersistence"]]` | same |
| prototype keys | `constructor, searchSessions, searchEvents, close, _assertSearchEnabled, _close, _open, _ensureReady, _serialized, _reconcile, _observeStable, _mainGeneration, _deleteSession, _replacePersistedSession, _replaceLiveSession, _querySessions, _queryEvents, _targetObservation, _sessionHit, _eventHit, _requireDb, _isClosed, [Service.init]` | same order, plus the patch methods `_indexPersistedSession, _commitPersistedSession, _writeTransaction, _persistedRowsReusable, _indexedPersistedRows` (after `_observeStable`) and `_setMainGeneration` (after `_mainGeneration`) |

The real cordis `Service` also defines a symbol key (`symbols.tracker`) on the instance; the stub
leaves it out, which changes both builds alike.

## 6. Generated `index.js` against a strip of the rc.3 original (criterion 6)

The rc.3 sources go through the same generator and config in a temp package root (the generator's
`--root`), so both sides are stripped the same way:

```sh
PKG=/Users/macbook/projects/dsh-plugins/packages/session-search-patched; R=/tmp/ssp-s4/rc3pkg
mkdir -p $R/vendor/src $R/scripts
cp /tmp/ssp-s4/shipped/{index,query,schema}.ts $R/vendor/src/ && cp $PKG/scripts/build.config.json $R/scripts/
node $PKG/scripts/build.mjs --root $R
#   wrote src/engine/index.js (sha256 e9671a605960b399...)  query.js (b81c045b5551658d...)  schema.js (7d6be83f3d5ffd87...)
#   class fields without initializer (6): 227:12 config, 230:11 _ready, 231:11 _db, 233:11 _lastPersistenceIdentity,
#     239:11 _closePromise, 240:20 _optionalPersistenceFiber;  semicolons inserted by strip (1): src/engine/index.js:264:3
cmp $R/src/engine/query.js $PKG/src/engine/query.js && cmp $R/src/engine/schema.js $PKG/src/engine/schema.js   # identical, exit 0
diff $R/src/engine/index.js $PKG/src/engine/index.js | grep '^[0-9]'
```

```
136a137,139
139a143
143d146
154c157
233a237,240
406a414,425
408a428,430
410,412d431
416d434
418,423c436,437
425c439
433,435c447,448
441c454
452,455c465
457,464c467
469,485c472
491,492c478,480
495,498c483,502
505a510,513
507,508d514
514c520
520a527,528
522,525c530
533a539
548c554
560a567,594
563a598,671
568a677,680
616c728
871c983
873c985,987
875a990,998
882d1004
886,889c1008
892a1012,1032
1116a1257,1260
```

68 `<` and 212 `>` lines (14 of them blank after the strip: changed type-only lines). The same
ranges as the source diff, which the patch file encodes (14 hunks, +212/−68):

```sh
diff <(diff $R/src/engine/index.js $PKG/src/engine/index.js | grep '^[0-9]') \
     <(diff /tmp/ssp-s4/shipped/index.ts $PKG/vendor/src/index.ts | grep '^[0-9]')
# no output, exit 0
```

Exact form against the patch file itself (opt-in test, §8): the test reads the 14 hunks of
`patches/engine-0.2.2-rc.3.diff` by their line counts, builds the line alignment they imply (68
removed old lines, 212 added new lines, every other line paired), checks that every pair is equal in
the two `.ts` files, and asserts that every pair is equal in the two stripped `index.js` files:
the list of differing pairs is empty.

## 7. Vendor edit

None is needed. A `declare` on `config` (or any other field) would remove the field from the output
and make the generated engine differ from the shipped one, which has `config;` (shipped:499). No field
of the engine class is named `ctx` or `name`. Nothing was changed in `vendor/` or `scripts/build.mjs`.

## 8. Test and negative controls

```sh
cd /Users/macbook/projects/dsh-plugins
node --test packages/session-search-patched/test/engine-artifact.test.mjs
#   tests 8, pass 6, skipped 2 (opt-in), fail 0
SSP_RC3_EXTRACT=/tmp/ssp-s4/shipped node --test packages/session-search-patched/test/engine-artifact.test.mjs
#   tests 8, pass 8, fail 0
```

`SSP_RC3_EXTRACT` names the folder of §2; the test first checks the four files' sha256 against the
rc.3 values. Negative controls, run on a copy of the package under `/tmp/ssp-s4/neg` (the real
files untouched):

| Change in the copy | Failing tests |
|---|---|
| gen:86 `STABLE_OBSERVATION_ATTEMPTS = 2` → `3` (a line outside every hunk) | manifest; strip comparison (`actual: [ [ 86, 86 ] ]`) |
| `ctx` field added to the class body at gen:230 | manifest; evaluated module; strip comparison; shipped comparison |
| `import 'node:os'` appended to `query.js` | manifest; import specifiers |

The S3 tests still pass with the config present: `node --test packages/session-search-patched/test/build.test.mjs`
→ 66 pass, 0 fail.

## 9. Doubts

- The construction evidence uses stub bases that copy the field and constructor layout of the
  host's cordis `Service` and rc.3 `SessionQueryEngine`; the real classes register the service,
  add a tracker symbol and build the corpus readers. The define semantics shown do not depend on
  those parts, but a run inside a host (S8) is the end-to-end check.
- Node's `module.stripTypeScriptTypes` is marked experimental; the manifest pins Node 24
  (`--check` refuses another major). A later Node 24 release could strip differently;
  `--check` would then report a difference rather than ship it.
- The shipped `lib/index.js` was compared as the reference output of upstream's build; the
  upstream build itself was not rerun.

## 10. Files

| File | Written by this task |
|---|---|
| `scripts/build.config.json` | yes |
| `src/engine/index.js`, `query.js`, `schema.js`, `manifest.json` | yes (generated) |
| `test/engine-artifact.test.mjs` | yes |
| `docs/build-audit.md` | yes |

Scratch, outside the repository: `/tmp/ssp-s4/shipped` (extracted rc.3 files), `/tmp/ssp-s4/host`
(extracted base libraries), `/tmp/ssp-s4/rc3pkg` (strip of the rc.3 sources), `/tmp/ssp-s4/neg`
(negative controls), `/tmp/ssp-s4/describe-dump.mjs` and `describe-dump.json`.
