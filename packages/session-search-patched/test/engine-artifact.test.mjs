// Checks of the generated engine artifact in src/engine (task S4).
//
//   node --test test/engine-artifact.test.mjs
//
// Always run (no host packages needed):
//   - build config: baseVersion and the decided import allow-list (host-import mode "bare"),
//   - manifest: hashes of every input and output, recorded class fields and inserted semicolons,
//   - every generated file parses (node --check),
//   - the import specifiers of src/engine are exactly the decided allow-list,
//   - exported names and the engine class's static members equal the list recorded from the shipped
//     rc.3 lib/index.js (docs/build-audit.md), statically and by evaluating the module against stubs.
//
// Opt-in, against the files extracted from the installed app (see docs/build-audit.md):
//   SSP_RC3_EXTRACT=<folder with index.ts, query.ts, schema.ts (rc.3 src) and index.js (rc.3 lib)>
//   - the rc.3 sources stripped by the same generator differ from src/engine only at the lines
//     named in patches/engine-0.2.2-rc.3.diff,
//   - the shipped lib/index.js and the generated index.js, evaluated against the same stubs, have the
//     same exports, static members, Config schema, construction result and imported bindings,
//     except what the patch adds.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { generate, scanModuleSyntax, tokenize } from '../scripts/build.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = path.join(PKG, 'src', 'engine')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const read = (rel) => fs.readFileSync(path.join(PKG, ...rel.split('/')), 'utf8')

// ---------------------------------------------------------------------------------------------
// Recorded facts (docs/composition-spike.md section 13, docs/build-audit.md)
// ---------------------------------------------------------------------------------------------

/** Host-import mode "bare": the bare specifiers src/engine may import. */
const DECIDED_BARE = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/schemastery',
  'node:crypto',
  'node:fs/promises',
  'node:path',
  'node:sqlite',
]
const DECIDED_RELATIVE = ['./query.js', './schema.js']

/** Specifiers per generated file: [kind, specifier]. */
const SPECIFIERS = {
  'index.js': [
    ['import', 'node:crypto'],
    ['import', '@deepseek-ai/dsh-session'],
    ['import', '@deepseek-ai/cordis'],
    ['import', '@deepseek-ai/schemastery'],
    ['import', '@deepseek-ai/dsh-session-query'],
    ['import', './schema.js'],
    ['import', './query.js'],
    ['export-from', './schema.js'],
  ],
  'query.js': [['import', '@deepseek-ai/dsh-session-query']],
  'schema.js': [
    ['import', 'node:fs/promises'],
    ['import', 'node:path'],
    ['dynamic import', 'node:sqlite'],
  ],
}

/** Exported names of the shipped rc.3 lib/index.js (its final `export { ... }` statement). */
const SHIPPED_EXPORTS = [
  'SESSION_QUERY_SQLITE_APPLICATION_ID',
  'SESSION_QUERY_SQLITE_DEFAULT_LIMIT',
  'SESSION_QUERY_SQLITE_MAX_LIMIT',
  'SESSION_QUERY_SQLITE_PATH_KEY',
  'SESSION_QUERY_SQLITE_SCHEMA_VERSION',
  'SESSION_QUERY_SQLITE_SNIPPET_CHARS',
  'SqliteSessionQueryEngine',
  'default',
]
/** Values of the exported constants in the shipped rc.3 build. */
const SHIPPED_CONSTANTS = {
  SESSION_QUERY_SQLITE_APPLICATION_ID: 1146308689,
  SESSION_QUERY_SQLITE_DEFAULT_LIMIT: 20,
  SESSION_QUERY_SQLITE_MAX_LIMIT: 100,
  SESSION_QUERY_SQLITE_PATH_KEY: 'launcherSessionQueryPath',
  SESSION_QUERY_SQLITE_SCHEMA_VERSION: 8,
  SESSION_QUERY_SQLITE_SNIPPET_CHARS: 240,
}
/** Static members declared by the shipped engine class (no `provide`, no static `name` field). */
const SHIPPED_STATICS = ['inject', 'Config']
/** Own keys of the shipped class constructor, in V8 order. */
const SHIPPED_STATIC_OWN_KEYS = ['length', 'name', 'prototype', 'inject', 'Config']

/** Own keys of a constructed engine (stub bases mirror cordis Service and rc.3 SessionQueryEngine). */
const SHIPPED_INSTANCE_KEYS = [
  'ctx', 'name', '_readWindowMax', '_corpus', '_observations',
  'config', '_instance', '_ready', '_db', '_persistenceBinding', '_lastPersistenceIdentity',
  '_persistenceEpoch', '_globalGeneration', '_localGeneration', '_tail', '_closed', '_closePromise',
  '_optionalPersistenceFiber',
]
/** The patch adds one instance field (hunk 3) after `_lastPersistenceIdentity`. */
const PATCH_FIELDS = ['_persistedRowsBinding']
const GENERATED_INSTANCE_KEYS = [
  ...SHIPPED_INSTANCE_KEYS.slice(0, SHIPPED_INSTANCE_KEYS.indexOf('_lastPersistenceIdentity') + 1),
  ...PATCH_FIELDS,
  ...SHIPPED_INSTANCE_KEYS.slice(SHIPPED_INSTANCE_KEYS.indexOf('_lastPersistenceIdentity') + 1),
]
/** Prototype methods the patch adds (hunks 10 and 11). */
const PATCH_METHODS = [
  '_indexPersistedSession', '_commitPersistedSession', '_writeTransaction',
  '_persistedRowsReusable', '_indexedPersistedRows', '_setMainGeneration',
]

/** Class fields without initializer reported by the generator (each audited in docs/build-audit.md). */
const FIELDS_WITHOUT_INITIALIZER = [
  'src/engine/index.js:230:12 SqliteSessionQueryEngine.config',
  'src/engine/index.js:233:11 SqliteSessionQueryEngine._ready',
  'src/engine/index.js:234:11 SqliteSessionQueryEngine._db',
  'src/engine/index.js:236:11 SqliteSessionQueryEngine._lastPersistenceIdentity',
  'src/engine/index.js:240:11 SqliteSessionQueryEngine._persistedRowsBinding',
  'src/engine/index.js:246:11 SqliteSessionQueryEngine._closePromise',
  'src/engine/index.js:247:20 SqliteSessionQueryEngine._optionalPersistenceFiber',
]
const SEMICOLONS_INSERTED = ['src/engine/index.js:271:3']

/** sha256 of the rc.3 files inside the installed app.asar (vendor/PROVENANCE.md). */
const RC3_SHA256 = {
  'index.ts': '72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3',
  'query.ts': 'b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48',
  'schema.ts': '2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f',
  'index.js': 'dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0',
}

// ---------------------------------------------------------------------------------------------
// Static helpers
// ---------------------------------------------------------------------------------------------

const isPunct = (tok, v) => tok !== undefined && tok.t === 'punct' && tok.v === v
const isId = (tok, v) => tok !== undefined && tok.t === 'id' && tok.v === v

/** Names exported by a module, read from its top-level export statements. */
function exportedNames(text) {
  const toks = tokenize(text)
  const names = []
  let depth = 0
  for (let k = 0; k < toks.length; k += 1) {
    const tok = toks[k]
    if (isPunct(tok, '{')) depth += 1
    else if (isPunct(tok, '}')) depth -= 1
    if (depth !== 0 || !isId(tok, 'export') || isPunct(toks[k - 1], '.')) continue
    const next = toks[k + 1]
    if (isId(next, 'default')) names.push('default')
    else if (isId(next, 'const') || isId(next, 'let') || isId(next, 'var') || isId(next, 'class')) names.push(toks[k + 2].v)
    else if (isId(next, 'function')) names.push(isPunct(toks[k + 2], '*') ? toks[k + 3].v : toks[k + 2].v)
    else if (isId(next, 'async')) names.push(toks[k + 3].v)
    else if (isPunct(next, '{')) {
      let j = k + 2
      while (!isPunct(toks[j], '}')) {
        if (toks[j].t === 'id') {
          const local = toks[j].v
          if (isId(toks[j + 1], 'as')) {
            names.push(toks[j + 2].v)
            j += 3
          } else {
            names.push(local)
            j += 1
          }
        } else j += 1
      }
    } else assert.fail(`unexpected export form at ${tok.line}:${tok.col}`)
  }
  return names.sort()
}

/** Static member names declared in the body of class `className`. */
function staticMembers(text, className) {
  const toks = tokenize(text)
  const start = toks.findIndex((t, k) => isId(t, 'class') && isId(toks[k + 1], className))
  assert.ok(start >= 0, `class ${className} not found`)
  let k = start
  while (!isPunct(toks[k], '{')) k += 1
  const names = []
  let depth = 0
  for (; k < toks.length; k += 1) {
    if (isPunct(toks[k], '{') || isPunct(toks[k], '(') || isPunct(toks[k], '[')) depth += 1
    else if (isPunct(toks[k], '}') || isPunct(toks[k], ')') || isPunct(toks[k], ']')) {
      depth -= 1
      if (depth === 0) break
    } else if (depth === 1 && isId(toks[k], 'static') && toks[k + 1]?.t === 'id') names.push(toks[k + 1].v)
  }
  return names
}

/** Imported bindings per specifier: { specifier: [local names, 'default' for a default import] }. */
function importedBindings(text) {
  const toks = tokenize(text)
  const out = {}
  for (let k = 0; k < toks.length; k += 1) {
    if (!isId(toks[k], 'import') || isPunct(toks[k - 1], '.') || isPunct(toks[k + 1], '(') || isPunct(toks[k + 1], '.')) continue
    const names = []
    let j = k + 1
    for (; !isId(toks[j], 'from'); j += 1) {
      const t = toks[j]
      if (t.t !== 'id') continue
      if (isId(toks[j + 1], 'as')) {
        names.push(`${t.v} as ${toks[j + 2].v}`)
        j += 2
      } else names.push(j === k + 1 ? `default as ${t.v}` : t.v)
    }
    const spec = toks[j + 1].v
    out[spec] = [...(out[spec] ?? []), ...names].sort()
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Runtime harness: evaluate an engine module against stub host packages in a temp folder
// ---------------------------------------------------------------------------------------------

// The stub bases mirror the shipped host code: cordis 4.1.0 `Service` (fields `ctx` and `name`,
// constructor sets both and registers the service; cordis lib/index.js:1814-1856) and rc.3
// `SessionQueryEngine` (fields `_readWindowMax`, `_corpus`, `_observations`; `super(ctx, "sessionQuery")`;
// dsh-session-query lib/index.js:1078-1093).
const STUBS = {
  '@deepseek-ai/cordis': `
export class Context {}
export class Service {
  ctx
  static init = Symbol('stub:Service.init')
  name
  constructor(ctx, name) {
    this.ctx = ctx
    name ??= this.constructor['provide']
    const self = this
    self.ctx = ctx
    self.name = name
    ctx.provided.push({ name, self })
    return self
  }
}
`,
  '@deepseek-ai/schemastery': `
function node(type, arg) {
  const s = { type, arg, chain: [] }
  for (const m of ['required', 'default', 'step', 'min', 'max']) {
    Object.defineProperty(s, m, { enumerable: false, value: (...args) => { s.chain.push([m, ...args]); return s } })
  }
  return s
}
const z = {
  object: (shape) => node('object', shape),
  string: () => node('string'),
  number: () => node('number'),
  union: (values) => node('union', values),
}
export default z
`,
  '@deepseek-ai/dsh-session': `
export const SESSION_FORMAT_VERSION = 'stub-format'
export const SessionSeq = (value) => value
`,
  '@deepseek-ai/dsh-session-query': `
import { Service } from '@deepseek-ai/cordis'
export const SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5
export const SESSION_QUERY_READ_WINDOW_MAX = 50
export class SessionQueryError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
  }
}
export const SessionSearchCursor = (value) => value
const unused = (name) => () => { throw new Error('stub ' + name + ' called') }
export const assertSessionHeadersCompatible = unused('assertSessionHeadersCompatible')
export const buildSessionEventSearchDocuments = unused('buildSessionEventSearchDocuments')
export const readColdSessionLog = unused('readColdSessionLog')
export const materializeSessionEventResultFilters = unused('materializeSessionEventResultFilters')
export const materializeSessionResultFilters = unused('materializeSessionResultFilters')
export class SessionQueryEngine extends Service {
  static inject = ['sessions']
  _readWindowMax
  _corpus
  _observations
  constructor(ctx, config = {}) {
    super(ctx, 'sessionQuery')
    this._readWindowMax = config.readWindowMax ?? 50
    this._corpus = { stub: 'corpus' }
    this._observations = { stub: 'observations' }
  }
}
export default SessionQueryEngine
`,
}

const ROW_CONFIG = { path: ':memory:', openAt: 'first-search', persistedReadConcurrency: 1 }

/** Copy `files` (name -> text) into a temp folder next to the stubs, import index.js and describe it. */
async function describeEngine(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-engine-artifact-'))
  try {
    for (const [name, text] of Object.entries(STUBS)) {
      const pkgDir = path.join(dir, 'node_modules', ...name.split('/'))
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }))
      fs.writeFileSync(path.join(pkgDir, 'index.js'), text)
    }
    const engineDir = path.join(dir, 'engine')
    fs.mkdirSync(engineDir)
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(engineDir, name), text)
    fs.writeFileSync(path.join(engineDir, 'package.json'), JSON.stringify({ type: 'module' }))
    const ns = await import(pathToFileURL(path.join(engineDir, 'index.js')).href)
    const Engine = ns.default
    const ctx = {
      provided: [],
      effects: [],
      injected: [],
      inject(deps) {
        this.injected.push(deps)
        return { dispose() {} }
      },
      effect(_fn, label) {
        this.effects.push(label)
      },
    }
    const engine = new Engine(ctx, { ...ROW_CONFIG })
    return {
      exports: Object.keys(ns).sort(),
      constants: Object.fromEntries(Object.keys(SHIPPED_CONSTANTS).map((k) => [k, ns[k]])),
      defaultIsNamedExport: ns.default === ns.SqliteSessionQueryEngine,
      className: Engine.name,
      baseName: Object.getPrototypeOf(Engine).name,
      staticOwnKeys: Reflect.ownKeys(Engine).map(String),
      inject: Engine.inject,
      configSchema: JSON.parse(JSON.stringify(Engine.Config)),
      prototypeKeys: Reflect.ownKeys(Engine.prototype).map(String),
      instanceKeys: Reflect.ownKeys(engine).map(String),
      ctxKept: engine.ctx === ctx,
      name: engine.name,
      providedSelf: ctx.provided.length === 1 && ctx.provided[0].self === engine && ctx.provided[0].name === 'sessionQuery',
      config: engine.config,
      undefinedFields: Reflect.ownKeys(engine).filter((k) => engine[k] === undefined).map(String),
      effects: ctx.effects,
      injected: ctx.injected,
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const generatedFiles = () => Object.fromEntries(['index.js', 'query.js', 'schema.js'].map((n) => [n, fs.readFileSync(path.join(ENGINE, n), 'utf8')]))

// ---------------------------------------------------------------------------------------------
// Always-run checks
// ---------------------------------------------------------------------------------------------

test('build config sets baseVersion 0.2.2-rc.3 and exactly the decided allow-list, no mapping', () => {
  const config = JSON.parse(read('scripts/build.config.json'))
  assert.deepEqual(Object.keys(config).sort(), ['allow', 'baseVersion'])
  assert.equal(config.baseVersion, '0.2.2-rc.3')
  assert.deepEqual([...config.allow].sort(), [...DECIDED_BARE].sort())
  assert.equal(new Set(config.allow).size, config.allow.length)
})

test('src/engine holds exactly the generated files and the manifest matches them', () => {
  assert.deepEqual(fs.readdirSync(ENGINE).sort(), ['index.js', 'manifest.json', 'query.js', 'schema.js'])
  const manifest = JSON.parse(read('src/engine/manifest.json'))
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.baseVersion, '0.2.2-rc.3')
  assert.equal(manifest.script.path, 'scripts/build.mjs')
  assert.equal(manifest.script.sha256, sha256(fs.readFileSync(path.join(PKG, 'scripts', 'build.mjs'))))
  assert.equal(manifest.config.path, 'scripts/build.config.json')
  assert.equal(manifest.config.sha256, sha256(fs.readFileSync(path.join(PKG, 'scripts', 'build.config.json'))))
  assert.deepEqual(Object.keys(manifest.inputs), ['vendor/src/index.ts', 'vendor/src/query.ts', 'vendor/src/schema.ts'])
  for (const [rel, hash] of Object.entries(manifest.inputs)) assert.equal(sha256(fs.readFileSync(path.join(PKG, rel))), hash, rel)
  assert.deepEqual(Object.keys(manifest.outputs), ['src/engine/index.js', 'src/engine/query.js', 'src/engine/schema.js'])
  for (const [rel, hash] of Object.entries(manifest.outputs)) assert.equal(sha256(fs.readFileSync(path.join(PKG, rel))), hash, rel)
  assert.deepEqual(manifest.classFieldsWithoutInitializer, FIELDS_WITHOUT_INITIALIZER)
  assert.deepEqual(manifest.semicolonsInsertedByStrip, SEMICOLONS_INSERTED)
})

test('every generated file parses as an ES module', () => {
  for (const name of ['index.js', 'query.js', 'schema.js']) {
    const child = spawnSync(process.execPath, ['--check', path.join(ENGINE, name)], { encoding: 'utf8' })
    assert.equal(child.status, 0, `${name}: ${child.stderr}`)
  }
})

test('import specifiers of src/engine are exactly the decided allow-list', () => {
  const seen = new Set()
  for (const [name, expected] of Object.entries(SPECIFIERS)) {
    const { specs, problems } = scanModuleSyntax(tokenize(fs.readFileSync(path.join(ENGINE, name), 'utf8')))
    assert.deepEqual(problems, [], name)
    assert.deepEqual(specs.map((s) => [s.kind, s.value]), expected, name)
    for (const s of specs) seen.add(s.value)
  }
  assert.deepEqual([...seen].sort(), [...DECIDED_BARE, ...DECIDED_RELATIVE].sort())
  for (const name of ['index.js', 'query.js', 'schema.js']) {
    const text = fs.readFileSync(path.join(ENGINE, name), 'utf8')
    assert.doesNotMatch(text, /from\s+['"][^'"]+\.ts['"]/, `${name}: a .ts specifier survived`)
    assert.doesNotMatch(text, /\brequire\s*\(/, `${name}: require() present`)
  }
})

test('exported names and static members match the shipped rc.3 list (static reading)', () => {
  const text = fs.readFileSync(path.join(ENGINE, 'index.js'), 'utf8')
  assert.deepEqual(exportedNames(text), [...SHIPPED_EXPORTS].sort())
  assert.deepEqual(staticMembers(text, 'SqliteSessionQueryEngine'), SHIPPED_STATICS)
  assert.match(text, /^export default SqliteSessionQueryEngine$/m)
})

test('the evaluated module matches the shipped rc.3 exports, statics and construction', async () => {
  const d = await describeEngine(generatedFiles())
  assert.deepEqual(d.exports, [...SHIPPED_EXPORTS].sort())
  assert.deepEqual(d.constants, SHIPPED_CONSTANTS)
  assert.equal(d.defaultIsNamedExport, true)
  assert.equal(d.className, 'SqliteSessionQueryEngine')
  assert.equal(d.baseName, 'SessionQueryEngine')
  assert.deepEqual(d.staticOwnKeys, SHIPPED_STATIC_OWN_KEYS)
  assert.deepEqual(d.inject, ['sessions'])
  assert.deepEqual(Object.keys(d.configSchema.arg), [
    'path', 'openAt', 'journalMode', 'defaultLimit', 'maxLimit', 'snippetChars', 'readWindowMax',
    'persistedReadConcurrency', 'preparedSessionCacheSize',
  ])
  // Field define semantics: ctx and name set by the Service constructor survive, config is the resolved value.
  assert.equal(d.ctxKept, true)
  assert.equal(d.name, 'sessionQuery')
  assert.equal(d.providedSelf, true)
  assert.deepEqual(d.instanceKeys, GENERATED_INSTANCE_KEYS)
  assert.deepEqual(d.config, {
    path: ':memory:', openAt: 'first-search', journalMode: 'wal', defaultLimit: 20, maxLimit: 100,
    snippetChars: 240, readWindowMax: 50, persistedReadConcurrency: 1, preparedSessionCacheSize: 5,
  })
  assert.deepEqual(d.undefinedFields, ['_ready', '_db', '_lastPersistenceIdentity', '_persistedRowsBinding', '_closePromise'])
  assert.deepEqual(d.effects, ['sessionQuerySqlite.optionalPersistence', 'sessionQuerySqlite.close'])
  assert.deepEqual(d.injected, [['sessionPersistence']])
  for (const m of PATCH_METHODS) assert.ok(d.prototypeKeys.includes(m), m)
})

// ---------------------------------------------------------------------------------------------
// Opt-in checks against the rc.3 files extracted from the installed app
// ---------------------------------------------------------------------------------------------

const RC3_DIR = process.env.SSP_RC3_EXTRACT
const rc3Skip = RC3_DIR ? false : 'set SSP_RC3_EXTRACT to a folder with the extracted rc.3 index.ts, query.ts, schema.ts and lib index.js'

function rc3File(name) {
  const bytes = fs.readFileSync(path.join(RC3_DIR, name))
  assert.equal(sha256(bytes), RC3_SHA256[name], `${name} is not the installed rc.3 file`)
  return bytes.toString('utf8')
}

/** Hunks of a unified diff, read by their line counts. */
function parseHunks(text) {
  const lines = text.split('\n')
  const hunks = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i])
    if (m === null) continue
    const hunk = { oldStart: Number(m[1]), oldLen: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLen: m[4] === undefined ? 1 : Number(m[4]), body: [] }
    let o = 0
    let n = 0
    while (o < hunk.oldLen || n < hunk.newLen) {
      i += 1
      const l = lines[i]
      if (l.startsWith('\\')) continue
      const c = l === '' ? ' ' : l[0]
      hunk.body.push([c, l.slice(1)])
      if (c !== '+') o += 1
      if (c !== '-') n += 1
    }
    hunks.push(hunk)
  }
  return hunks
}

/** Line alignment implied by the patch: unchanged pairs, removed old lines, added new lines (1-based). */
function alignment(hunks, oldCount, newCount) {
  const pairs = []
  const removed = []
  const added = []
  let o = 1
  let n = 1
  for (const h of hunks) {
    while (o < h.oldStart) pairs.push([o++, n++])
    assert.equal(n, h.newStart, 'hunk offsets are consistent')
    for (const [c] of h.body) {
      if (c === ' ') pairs.push([o++, n++])
      else if (c === '-') removed.push(o++)
      else added.push(n++)
    }
  }
  while (o <= oldCount) pairs.push([o++, n++])
  assert.equal(n - 1, newCount, 'patch covers the new file')
  return { pairs, removed, added }
}

test('rc.3 sources stripped by the same generator differ from src/engine only at the patch lines', { skip: rc3Skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-rc3-strip-'))
  try {
    fs.mkdirSync(path.join(root, 'vendor', 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'scripts'))
    for (const name of ['index.ts', 'query.ts', 'schema.ts']) fs.writeFileSync(path.join(root, 'vendor', 'src', name), rc3File(name))
    fs.copyFileSync(path.join(PKG, 'scripts', 'build.config.json'), path.join(root, 'scripts', 'build.config.json'))
    const { files } = generate({ root, srcRel: 'vendor/src', outRel: 'src/engine', configRel: 'scripts/build.config.json' })
    const generated = generatedFiles()
    assert.equal(files.get('src/engine/query.js'), generated['query.js'])
    assert.equal(files.get('src/engine/schema.js'), generated['schema.js'])

    const oldTs = rc3File('index.ts').split('\n')
    const newTs = read('vendor/src/index.ts').split('\n')
    const oldJs = files.get('src/engine/index.js').split('\n')
    const newJs = generated['index.js'].split('\n')
    assert.equal(oldJs.length, oldTs.length)
    assert.equal(newJs.length, newTs.length)
    const hunks = parseHunks(read('patches/engine-0.2.2-rc.3.diff'))
    assert.equal(hunks.length, 14)
    const { pairs, removed, added } = alignment(hunks, oldTs.length, newTs.length)
    assert.equal(removed.length, 68)
    assert.equal(added.length, 212)
    // The patch's alignment holds for the sources ...
    for (const [o, n] of pairs) assert.equal(oldTs[o - 1], newTs[n - 1], `source line ${o}/${n}`)
    // ... and every line it leaves unchanged is identical in the stripped outputs.
    const differing = pairs.filter(([o, n]) => oldJs[o - 1] !== newJs[n - 1])
    assert.deepEqual(differing, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shipped rc.3 lib/index.js and the generated index.js agree under the same stubs', { skip: rc3Skip }, async () => {
  const shippedText = rc3File('index.js')
  const shipped = await describeEngine({ 'index.js': shippedText })
  const generated = await describeEngine(generatedFiles())
  assert.deepEqual(shipped.exports, [...SHIPPED_EXPORTS].sort())
  assert.deepEqual(generated.exports, shipped.exports)
  assert.deepEqual(shipped.constants, SHIPPED_CONSTANTS)
  assert.deepEqual(generated.constants, shipped.constants)
  assert.deepEqual(shipped.staticOwnKeys, SHIPPED_STATIC_OWN_KEYS)
  assert.deepEqual(generated.staticOwnKeys, shipped.staticOwnKeys)
  assert.deepEqual(staticMembers(shippedText.replace('var SqliteSessionQueryEngine = class extends', 'class SqliteSessionQueryEngine extends'), 'SqliteSessionQueryEngine'), SHIPPED_STATICS)
  for (const key of ['defaultIsNamedExport', 'className', 'baseName', 'inject', 'configSchema', 'ctxKept', 'name', 'providedSelf', 'config', 'effects', 'injected']) {
    assert.deepEqual(generated[key], shipped[key], key)
  }
  assert.deepEqual(shipped.instanceKeys, SHIPPED_INSTANCE_KEYS)
  assert.deepEqual(generated.instanceKeys, GENERATED_INSTANCE_KEYS)
  assert.deepEqual(generated.undefinedFields.filter((k) => !PATCH_FIELDS.includes(k)), shipped.undefinedFields)
  assert.deepEqual(generated.prototypeKeys.filter((k) => !PATCH_METHODS.includes(k)), shipped.prototypeKeys)

  // Imported bindings: the generated files import what the shipped bundle imports, plus `Context`
  // (a value import used only in type positions, which tsc elides and strip keeps).
  const merged = {}
  for (const text of Object.values(generatedFiles())) {
    for (const [spec, names] of Object.entries(importedBindings(text))) {
      if (spec.startsWith('.')) continue
      merged[spec] = [...new Set([...(merged[spec] ?? []), ...names])].sort()
    }
  }
  const fromShipped = importedBindings(shippedText)
  assert.deepEqual(Object.keys(merged).sort(), Object.keys(fromShipped).sort())
  for (const spec of Object.keys(fromShipped)) {
    const extra = merged[spec].filter((x) => !fromShipped[spec].includes(x))
    const missing = fromShipped[spec].filter((x) => !merged[spec].includes(x))
    assert.deepEqual(missing, [], `${spec}: missing in the generated files`)
    assert.deepEqual(extra, spec === '@deepseek-ai/cordis' ? ['Context'] : [], `${spec}: extra in the generated files`)
  }
})
