// Tests for src/index.host.js, the guarded host entry of the row
// session-query-sqlite-patched.
// Run: node --test packages/session-search-patched/test/entry.test.mjs   (Node 24)
//
// Every case mounts the row on a real cordis Context (the repository's
// node_modules/@deepseek-ai/cordis 4.1.0) inside the isolated sessionQuery scope
// the loader gives the group optional-session-search, with fake engine classes
// (test/helpers/fake-engines.mjs) handed to apply() as its third argument. No
// host package and no generated engine (src/engine) is loaded: the cases that
// mount the real module namespace fail the guard before the engine import.
// An unhandledRejection trap is checked after every case; HOME, DSH_HOME and
// the XDG roots are decoys that must stay empty.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { installDecoys } from './helpers/decoys.mjs'
import { createJournal, makeEngine, makeHost, moduleNotFound, RC3_SOURCES } from './helpers/fake-engines.mjs'
import { createWorld, deepFrozen, ENGINE_PACKAGE, GROUP_SCOPE, LINE_PREFIX, ROW_CONFIG, settle, STATE } from './helpers/world.mjs'

const decoys = installDecoys('entry')
const trapped = []
const onRejection = (reason) => trapped.push(reason)
process.on('unhandledRejection', onRejection)
const cleanups = []
after(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  process.off('unhandledRejection', onRejection)
  decoys.restore()
})

const PKG = path.resolve(import.meta.dirname, '..')
const ENTRY_FILE = path.join(PKG, 'src', 'index.host.js')
const ENTRY_URL = pathToFileURL(ENTRY_FILE).href
const entry = await import(ENTRY_URL).catch((error) => {
  decoys.restore()
  throw error
})

/** The entry as a row plugin, with the test loaders as apply()'s third argument. */
const rowPlugin = (host) => ({ name: entry.name, inject: entry.inject, apply: (ctx, config) => entry.apply(ctx, config, host) })

/**
 * Mount one row and let it settle.
 * @param {object} [options]
 * @param {object} [options.world] createWorld options
 * @param {object} [options.patched] behavior of the fake patched engine
 * @param {object} [options.shipped] behavior of the fake shipped engine
 * @param {object} [options.host] makeHost options (loaders, sources)
 * @param {unknown} [options.config] row config
 * @param {(world: object) => object} [options.scope] context the row is mounted in
 * @param {(world: object, journal: object) => Promise<void>} [options.before] runs before the row
 */
async function scenario(options = {}) {
  const world = createWorld(options.world)
  cleanups.push(() => world.close())
  const journal = createJournal()
  const Patched = makeEngine('patched', journal, options.patched)
  const Shipped = makeEngine('shipped', journal, options.shipped)
  const { host, calls } = makeHost({ Patched, Shipped, ...options.host })
  if (options.before) await options.before(world, journal)
  const config = 'config' in options ? options.config : ROW_CONFIG
  const row = await world.mount(rowPlugin(host), config, options.scope ? options.scope(world) : world.group)
  await settle()
  return { world, journal, calls, row, Patched, Shipped, config }
}

function oneLine(world, { type, engine, reason }) {
  const lines = world.lines()
  assert.equal(lines.length, 1, `exactly one ${LINE_PREFIX} line, got ${JSON.stringify(lines.map((l) => l.text))}`)
  const [line] = lines
  assert.ok(line.text.startsWith(`${LINE_PREFIX} active engine: `), line.text)
  assert.ok(line.text.includes('; reason: '), line.text)
  assert.ok(!/[\r\n]/.test(line.text), 'a single line')
  assert.equal(line.extraArgs, 0, 'the whole line is one string')
  assert.equal(line.name, 'session-search-patched')
  if (type) assert.equal(line.type, type, line.text)
  const [, enginePart, reasonPart] = /active engine: (.*?); reason: (.*)$/.exec(line.text)
  if (engine) assert.match(enginePart, engine)
  if (reason) assert.match(reasonPart, reason)
  return line
}

/** The single sessionQuery provider of the group scope; none at root. */
function soleProvider(world, Class) {
  const providers = world.providers()
  assert.equal(providers.length, 1, 'exactly one sessionQuery service exists')
  const [impl] = providers
  assert.equal(impl.isolate, world.label, 'it lives in the isolated scope of the group')
  assert.ok(impl.value instanceof Class, `provider is ${impl.value?.constructor?.name}, expected ${Class.name}`)
  assert.equal(impl.ctx.fiber.state, STATE.ACTIVE)
  assert.equal(world.root.get('sessionQuery'), undefined, 'nothing in the root scope')
  return impl
}

function noUnhandled() {
  assert.deepEqual(trapped.map((reason) => String(reason?.stack ?? reason)), [], 'no unhandled rejection')
}

function fallbackChecks(result, reason) {
  const { world, journal, row, Shipped, calls } = result
  assert.equal(row.state, STATE.ACTIVE, 'apply() resolved: the row itself is active')
  soleProvider(world, Shipped)
  assert.deepEqual(journal.configs.filter((c) => c.role === 'shipped').map((c) => c.config), [ROW_CONFIG], 'the shipped class got the row config unchanged')
  assert.deepEqual(journal.inits.filter((r) => r === 'shipped'), ['shipped'])
  assert.equal(calls.loadShipped, 1)
  oneLine(world, { type: 'warn', engine: /^shipped FakeShippedEngine \(@deepseek-ai\/dsh-session-query-sqlite\) as fallback$/, reason })
  noUnhandled()
}

function nothingChecks(result, { reason, engine = /^none$/, providers = 0 }) {
  const { world, row } = result
  assert.equal(row.state, STATE.ACTIVE, 'apply() resolved: the row itself is active')
  assert.equal(world.providers().length, providers)
  assert.equal(world.root.get('sessionQuery'), undefined, 'nothing in the root scope')
  oneLine(world, { type: 'error', engine, reason })
  noUnhandled()
}

describe('static shape of src/index.host.js', () => {
  test('exports exactly name, inject and apply; inject is the rc.3 engine list', () => {
    assert.deepEqual(Object.keys(entry).sort(), ['apply', 'inject', 'name'])
    assert.equal(entry.name, 'session-search-patched')
    assert.equal(typeof entry.apply, 'function')
    assert.deepEqual(entry.inject, ['sessions'])
    const vendor = fs.readFileSync(path.join(PKG, 'vendor', 'src', 'index.ts'), 'utf8')
    const declared = /class SqliteSessionQueryEngine extends SessionQueryEngine \{\s*static override inject = \[([^\]]*)\]/.exec(vendor)
    assert.ok(declared, 'the vendored rc.3 engine declares its inject list')
    assert.deepEqual(declared[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')), entry.inject)
    const doc = fs.readFileSync(path.join(PKG, 'docs', 'composition-spike.md'), 'utf8')
    assert.ok(doc.includes("inject: ['sessions']"), 'the spike saw the same list on the shipped class')
  })

  test('static imports are node: builtins and ./guard.js only (parsed by vm.SourceTextModule)', () => {
    const script = [
      "import fs from 'node:fs'",
      "import vm from 'node:vm'",
      'const module = new vm.SourceTextModule(fs.readFileSync(process.argv[1], "utf8"))',
      'process.stdout.write(JSON.stringify(module.moduleRequests.map((r) => r.specifier)))',
    ].join('\n')
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', script, ENTRY_FILE], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const specifiers = JSON.parse(child.stdout)
    assert.ok(specifiers.includes('./guard.js'))
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('node:') || specifier === './guard.js', `static import ${specifier}`)
    }
  })

  test('the engines are loaded only by literal dynamic imports', () => {
    const code = fs.readFileSync(ENTRY_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const all = [...code.matchAll(/\bimport\s*\(/g)].length
    const literal = [...code.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
    assert.equal(all, literal.length, 'no computed import specifier')
    assert.deepEqual([...new Set(literal)].sort(), ['./engine/index.js', '@deepseek-ai/dsh-session-query-sqlite'])
    assert.doesNotMatch(code, /\brequire\s*\(/)
    assert.ok(!code.includes('process.env'))
  })
})

describe('outcome: compatible host', () => {
  test('the patched class provides sessionQuery in the group with the row config unchanged', async () => {
    const config = deepFrozen(ROW_CONFIG)
    const result = await scenario({ config })
    const { world, journal, calls, row, Patched } = result
    assert.equal(row.state, STATE.ACTIVE)
    const impl = soleProvider(world, Patched)
    assert.equal(impl.ctx.fiber.parent.fiber, row, 'the engine fiber is a child of the row')
    assert.deepEqual(journal.configs, [{ role: 'patched', config: ROW_CONFIG }])
    assert.equal(journal.configs[0].config, config, 'the very object of the row config reaches the engine')
    assert.deepEqual(journal.attempts, ['patched'], 'the shipped class is never constructed')
    assert.deepEqual(calls, { loadPatched: 1, loadShipped: 0, readShippedSources: 1 })
    assert.deepEqual(world.packageCalls, [{ name: ENGINE_PACKAGE, importer: ENTRY_URL }], 'version source: pluginPackages.packageOf(engine, import.meta.url)')
    oneLine(world, { type: 'info', engine: /^patched FakePatchedEngine \(\.\/engine\/index\.js\)$/, reason: /0\.2\.2-rc\.3.*src\/index\.ts, src\/query\.ts, src\/schema\.ts/ })

    const seen = []
    const consumer = world.group.inject(['sessionQuery'], (ctx) => { seen.push(ctx.sessionQuery.constructor.name) })
    const rootConsumer = world.root.inject(['sessionQuery'], () => { seen.push('root') })
    world.rows.push(consumer, rootConsumer)
    await consumer
    await settle()
    assert.deepEqual(seen, ['FakePatchedEngine'], 'a tool row of the group sees the patched engine; the root scope has none')
    assert.equal(rootConsumer.state, STATE.PENDING)
    noUnhandled()
  })

  test('the nested mount starts at once: the row waits for sessions only, like the shipped row', async () => {
    const world = createWorld({ sessions: false })
    cleanups.push(() => world.close())
    const journal = createJournal()
    const Patched = makeEngine('patched', journal)
    const { host, calls } = makeHost({ Patched, Shipped: makeEngine('shipped', journal) })
    const row = await world.mount(rowPlugin(host))
    await settle()
    assert.equal(row.state, STATE.PENDING)
    assert.deepEqual(world.lines(), [])
    assert.deepEqual(calls, { loadPatched: 0, loadShipped: 0, readShippedSources: 0 })
    world.root.provide('sessions', { list: () => [], get: () => undefined })
    await row
    await settle()
    assert.equal(row.state, STATE.ACTIVE)
    const impl = soleProvider(world, Patched)
    assert.equal(impl.ctx.fiber.state, STATE.ACTIVE, 'the engine started inside the same start of the row')
    oneLine(world, { type: 'info', engine: /^patched / })
    noUnhandled()
  })
})

describe('outcome: guard or patched-engine failure gives the shipped class with the same config', () => {
  const cases = [
    ['version mismatch', { world: { version: '0.2.2-rc.4' } }, /compatibility guard failed: host @deepseek-ai\/dsh-session-query-sqlite is 0\.2\.2-rc\.4, not one of the pinned 0\.2\.2-rc\.3 \/ 0\.2\.2-rc\.5/, { loadPatched: 0 }],
    ['version unknown: no pluginPackages service', { world: { packages: 'none' } }, /version of @deepseek-ai\/dsh-session-query-sqlite unknown \(the pluginPackages service is not available\)/, { loadPatched: 0 }],
    ['version unknown: packageOf throws', { world: { packages: 'throws' } }, /unknown \(packageOf failed in the fake host\)/, { loadPatched: 0 }],
    ['version unknown: packageOf finds no package', { world: { packages: 'no-entry' } }, /unknown \(pluginPackages has no @deepseek-ai\/dsh-session-query-sqlite for this package\)/, { loadPatched: 0 }],
    ['version unknown: packageOf is not a function', { world: { packages: 'not-a-function' } }, /unknown \(packages\.packageOf is not a function\)/, { loadPatched: 0 }],
    ['version unknown: entry without version', { world: { version: undefined } }, /unknown/, { loadPatched: 0 }],
    ['shipped source hash differs', { host: { sources: { ...RC3_SOURCES, 'src/query.ts': '0'.repeat(64) } } }, /src\/query\.ts sha256 000000000000… is not the pinned b29363581b71…/, { loadPatched: 0 }],
    ['shipped sources unreadable', { host: { sourcesError: moduleNotFound(`${ENGINE_PACKAGE}/src/index.ts`) } }, /src\/index\.ts unreadable \(ERR_MODULE_NOT_FOUND: /, { loadPatched: 0 }],
    ['patched engine import failure', { host: { patchedError: moduleNotFound('@deepseek-ai/dsh-session') } }, /the patched engine \.\/engine\/index\.js did not load: ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai\/dsh-session'/, { loadPatched: 1 }],
    ['patched module without a default class', { host: { patchedModule: { default: 42 } } }, /the patched engine \.\/engine\/index\.js has no default export class/, { loadPatched: 1 }],
    ['patched engine constructor throws', { patched: { throwBeforeSuper: true } }, /the patched engine failed to start: FakePatchedEngine: constructor failed before super/, { loadPatched: 1 }],
    ['patched engine constructor throws after providing', { patched: { throwAfterSuper: true } }, /the patched engine failed to start: FakePatchedEngine: constructor failed after super/, { loadPatched: 1 }],
    ['patched engine init rejects', { patched: { initError: new Error('init rejected in the fake') } }, /the patched engine failed to start: init rejected in the fake/, { loadPatched: 1 }],
  ]
  for (const [label, options, reason, expected] of cases) {
    test(label, async () => {
      const result = await scenario(options)
      fallbackChecks(result, reason)
      assert.equal(result.calls.loadPatched, expected.loadPatched)
      if (expected.loadPatched === 0) assert.deepEqual(result.journal.attempts, ['shipped'], 'a failed guard never touches the patched engine')
      if (options.patched?.throwAfterSuper || options.patched?.initError) {
        assert.ok(result.journal.disposed.includes('patched'), 'the failed patched engine was cleaned up')
      }
    })
  }

  test('no config key switches the guard off; the config still reaches the fallback unchanged', async () => {
    const config = deepFrozen({ ...ROW_CONFIG, force: true, skipGuard: true, guard: false, compatible: true, version: '0.2.2-rc.3', engine: 'patched' })
    const result = await scenario({ world: { version: '0.2.2-rc.4' }, config })
    assert.equal(result.calls.loadPatched, 0)
    soleProvider(result.world, result.Shipped)
    assert.equal(result.journal.configs[0].config, config)
    assert.deepEqual(result.journal.configs, [{ role: 'shipped', config: structuredClone(config) }])
    oneLine(result.world, { type: 'warn', engine: /^shipped /, reason: /0\.2\.2-rc\.4/ })
    noUnhandled()
  })

  test('an absent row config is passed through as it is', async () => {
    const result = await scenario({ config: undefined, world: { version: '0.2.2-rc.4' } })
    assert.deepEqual(result.journal.configs, [{ role: 'shipped', config: undefined }])
    noUnhandled()
  })
})

describe('outcome: nothing is provided', () => {
  test('scope not isolated: the row at the root', async () => {
    const result = await scenario({ scope: (world) => world.root })
    nothingChecks(result, { reason: /not inside the isolated sessionQuery scope sessionQuery#optional-session-search \(found: none\); nothing is mounted/ })
    assert.deepEqual(result.calls, { loadPatched: 0, loadShipped: 0, readShippedSources: 0 })
    assert.deepEqual(result.world.packageCalls, [])
    assert.deepEqual(result.journal.attempts, [])
  })

  test('scope not isolated: another isolated sessionQuery scope', async () => {
    const result = await scenario({ scope: (world) => world.root.isolate('sessionQuery', Symbol('sessionQuery#other-group')) })
    nothingChecks(result, { reason: /found: "sessionQuery#other-group"/ })
    assert.deepEqual(result.journal.attempts, [])
  })

  test('scope not isolated: the root label after a root provider existed', async () => {
    const result = await scenario({
      before: async (world) => {
        const dispose = world.root.provide('sessionQuery', { root: true })
        await dispose()
      },
      scope: (world) => world.root,
    })
    nothingChecks(result, { reason: /found: "sessionQuery"/ })
    assert.deepEqual(result.journal.attempts, [])
  })

  test('fallback import failure after a guard failure', async () => {
    const result = await scenario({ world: { version: '0.2.2-rc.4' }, host: { shippedError: moduleNotFound(ENGINE_PACKAGE) } })
    nothingChecks(result, { reason: /^compatibility guard failed: .*0\.2\.2-rc\.4.*; fallback failed: the shipped engine @deepseek-ai\/dsh-session-query-sqlite did not load: ERR_MODULE_NOT_FOUND: .*search is unavailable in this group/ })
    assert.deepEqual(result.journal.attempts, [])
  })

  test('fallback import failure after a patched-engine failure', async () => {
    const result = await scenario({ patched: { initError: new Error('init rejected') }, host: { shippedError: moduleNotFound(ENGINE_PACKAGE) } })
    nothingChecks(result, { reason: /^the patched engine failed to start: init rejected; fallback failed: the shipped engine .* did not load/ })
  })

  test('fallback module without a default class', async () => {
    const result = await scenario({ world: { packages: 'none' }, host: { shippedModule: {} } })
    nothingChecks(result, { reason: /fallback failed: the shipped engine @deepseek-ai\/dsh-session-query-sqlite has no default export class/ })
  })

  test('fallback engine fails to start', async () => {
    const result = await scenario({ world: { version: '0.2.2-rc.4' }, shipped: { throwBeforeSuper: true } })
    nothingChecks(result, { reason: /fallback failed: the shipped engine failed to start: FakeShippedEngine: constructor failed before super/ })
  })

  test('provider clash on the patched path: a later layer re-enabled the shipped row', async () => {
    let Other
    const result = await scenario({
      before: async (world, journal) => {
        Other = makeEngine('other', journal)
        await world.mount(Other, ROW_CONFIG)
      },
    })
    nothingChecks(result, {
      providers: 1,
      engine: /^none \(another row already provides sessionQuery in this group\)$/,
      reason: /^provider clash: service "sessionQuery" has been registered at <FakeOtherRowEngine>.*optional-session-query-sqlite.*remove that override and restart the host/,
    })
    soleProvider(result.world, Other)
    assert.deepEqual(result.journal.attempts, ['other', 'patched'], 'the shipped class is not tried: it would clash too')
    assert.equal(result.calls.loadShipped, 0)
  })

  test('provider clash on the fallback path', async () => {
    let Other
    const result = await scenario({
      world: { version: '0.2.2-rc.4' },
      before: async (world, journal) => {
        Other = makeEngine('other', journal)
        await world.mount(Other, ROW_CONFIG)
      },
    })
    nothingChecks(result, { providers: 1, engine: /^none \(another row/, reason: /^provider clash: service "sessionQuery" has been registered/ })
    soleProvider(result.world, Other)
  })
})

describe('lifecycle', () => {
  test('disposing the row removes the service and disposes the patched engine', async () => {
    const result = await scenario()
    const { world, journal, row } = result
    const consumer = world.group.inject(['sessionQuery'], () => {})
    world.rows.push(consumer)
    await consumer
    await row.dispose()
    await settle()
    assert.deepEqual(world.providers(), [])
    assert.deepEqual(journal.disposed, ['patched'])
    assert.equal(row.state, STATE.DISPOSED)
    assert.equal(consumer.state, STATE.PENDING, 'a tool row of the group waits again')
    assert.equal(world.lines().length, 1, 'disposal adds no line')
    noUnhandled()
  })

  test('disposing the row removes the service and disposes the fallback engine', async () => {
    const result = await scenario({ world: { version: '0.2.2-rc.4' } })
    await result.row.dispose()
    await settle()
    assert.deepEqual(result.world.providers(), [])
    assert.deepEqual(result.journal.disposed, ['shipped'])
    noUnhandled()
  })

  test('a row stopped while the patched engine loads mounts nothing and logs one line', async () => {
    let open
    const gate = new Promise((resolve) => { open = resolve })
    const world = createWorld()
    cleanups.push(() => world.close())
    const journal = createJournal()
    const { host, calls } = makeHost({ Patched: makeEngine('patched', journal), Shipped: makeEngine('shipped', journal), patchedGate: gate })
    const row = world.group.plugin(rowPlugin(host), ROW_CONFIG)
    for (let turn = 0; calls.loadPatched === 0 && turn < 50; turn++) await settle()
    assert.equal(calls.loadPatched, 1, 'the row reached the patched import')
    const disposing = row.dispose()
    open()
    await disposing
    await settle()
    assert.deepEqual(world.providers(), [])
    assert.deepEqual(journal.attempts, [])
    assert.equal(calls.loadShipped, 0)
    oneLine(world, { type: 'warn', engine: /^none$/, reason: /^the row stopped while its engine was starting$/ })
    noUnhandled()
  })
})

describe('no fallback at search time', () => {
  test('a search error of the patched engine is returned as it is and never starts the shipped engine', async () => {
    const searchError = Object.assign(new Error('SQLITE_FULL: database or disk is full'), { code: 'SESSION_QUERY_FAKE' })
    const result = await scenario({ patched: { searchError } })
    const { world, journal, calls, Patched } = result
    const impl = soleProvider(world, Patched)
    await assert.rejects(impl.value.searchSessions({ query: 'large store' }), (error) => error === searchError)
    await assert.rejects(world.group.get('sessionQuery').searchSessions({ query: 'again' }), (error) => error === searchError)
    await settle()
    soleProvider(world, Patched)
    assert.deepEqual(journal.searches.map((s) => s.role), ['patched', 'patched'])
    assert.deepEqual(journal.attempts, ['patched'], 'the shipped class is never constructed')
    assert.equal(calls.loadShipped, 0, 'the shipped module is never imported')
    assert.equal(world.lines().length, 1)
    noUnhandled()
  })
})

describe('the real module namespace as the row (no fakes for the loaders)', () => {
  test('precondition: the shipped engine package does not resolve from this repository', () => {
    assert.throws(() => import.meta.resolve(ENGINE_PACKAGE), { code: 'ERR_MODULE_NOT_FOUND' })
  })

  test('no pluginPackages: guard fails, the real fallback import fails, nothing provided, one line', async () => {
    const world = createWorld({ packages: 'none' })
    cleanups.push(() => world.close())
    const row = await world.mount(entry)
    await settle()
    nothingChecks({ world, row }, { reason: /^compatibility guard failed: host version of .* unknown .*src\/index\.ts unreadable \(ERR_MODULE_NOT_FOUND: .*fallback failed: the shipped engine @deepseek-ai\/dsh-session-query-sqlite did not load: ERR_MODULE_NOT_FOUND/ })
  })

  test('pinned version reported: the real source check still fails here, so the patched engine is not imported', async () => {
    const world = createWorld()
    cleanups.push(() => world.close())
    const row = await world.mount(entry)
    await settle()
    assert.deepEqual(world.packageCalls, [{ name: ENGINE_PACKAGE, importer: ENTRY_URL }])
    nothingChecks({ world, row }, { reason: /^compatibility guard failed: shipped src\/index\.ts unreadable .*src\/query\.ts unreadable .*src\/schema\.ts unreadable .*fallback failed/ })
  })

  test('outside the group: nothing provided, one line', async () => {
    const world = createWorld()
    cleanups.push(() => world.close())
    const row = await world.mount(entry, ROW_CONFIG, world.root)
    await settle()
    nothingChecks({ world, row }, { reason: /not inside the isolated sessionQuery scope/ })
    assert.deepEqual(world.packageCalls, [])
  })

  test('apply() resolves even on a context that throws on every access', async () => {
    const hostile = new Proxy({}, {
      get() { throw new Error('hostile context') },
      has() { throw new Error('hostile context') },
    })
    const printed = []
    const original = console.error
    console.error = (...args) => printed.push(args)
    let value
    try {
      value = await entry.apply(hostile, ROW_CONFIG)
    } finally {
      console.error = original
    }
    assert.equal(value, undefined)
    assert.equal(printed.length, 1)
    assert.equal(printed[0].length, 1)
    assert.match(printed[0][0], /^session-search-patched: active engine: none; reason: /)
    await settle()
    noUnhandled()
  })
})

test('every case left no unhandled rejection and the decoy HOME, DSH_HOME and XDG folders empty', async () => {
  await settle()
  noUnhandled()
  assert.equal(process.env.HOME, decoys.folders.HOME)
  assert.equal(process.env.DSH_HOME, decoys.folders.DSH_HOME)
  assert.deepEqual(decoys.touched(), [])
  assert.equal(GROUP_SCOPE, 'sessionQuery#optional-session-search')
})
