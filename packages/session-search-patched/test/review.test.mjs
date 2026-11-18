// Final-review tests (S10) for the failure modes of a live profile that the
// other files cover thinly: the order in which the shipped row and the new row
// come and go during a live (HMR) install or rollback, a provider clash whose
// other provider later disappears, a second start of the row, the documented
// log line, and (opt-in) the guard pins against an extract of the installed app.
// Run: node --test packages/session-search-patched/test/review.test.mjs   (Node 24)
//
// Same harness as entry.test.mjs: a real cordis Context (the repository's
// node_modules/@deepseek-ai/cordis 4.1.0), the isolated scope of the group
// optional-session-search, fake engine classes handed to apply() as its third
// argument. "other" stands for the shipped row optional-session-query-sqlite
// running beside the new row. HOME, DSH_HOME and the XDG roots are decoys.
//
// Opt-in: SSP_RC3_EXTRACT=<folder with index.ts, query.ts, schema.ts extracted
// from the installed app and, if present, its package.json> compares the
// guard's pinned values with those files.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { installDecoys } from './helpers/decoys.mjs'
import { createJournal, makeEngine, makeHost } from './helpers/fake-engines.mjs'
import { createWorld, LINE_PREFIX, ROW_CONFIG, settle, STATE } from './helpers/world.mjs'

const decoys = installDecoys('review')
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
const REPO = path.resolve(PKG, '..', '..')
const entry = await import(pathToFileURL(path.join(PKG, 'src', 'index.host.js')).href).catch((error) => {
  decoys.restore()
  throw error
})
const guard = await import(pathToFileURL(path.join(PKG, 'src', 'guard.js')).href)

const rowPlugin = (host) => ({ name: entry.name, inject: entry.inject, apply: (ctx, config) => entry.apply(ctx, config, host) })

function setup() {
  const world = createWorld()
  cleanups.push(() => world.close())
  const journal = createJournal()
  const Patched = makeEngine('patched', journal)
  const Shipped = makeEngine('shipped', journal)
  const Other = makeEngine('other', journal)
  const { host, calls } = makeHost({ Patched, Shipped })
  return { world, journal, Patched, Shipped, Other, host, calls }
}

/** A tool row of the group: it runs only while the group has a sessionQuery provider. */
function toolRow(world) {
  const seen = []
  const fiber = world.group.inject(['sessionQuery'], (ctx) => { seen.push(ctx.sessionQuery.constructor.name) })
  world.rows.push(fiber)
  return { fiber, seen }
}

function groupProviders(world) {
  return world.providers().filter((impl) => impl.isolate === world.label).map((impl) => impl.value.constructor.name)
}

function noUnhandled() {
  assert.deepEqual(trapped.map((reason) => String(reason?.stack ?? reason)), [], 'no unhandled rejection')
}

describe('live order of the two rows (HMR install and rollback)', () => {
  test('install: the shipped row stops before the new row starts, so the patched engine provides with no clash', async () => {
    const { world, Other, host } = setup()
    const shippedRow = await world.mount(Other, ROW_CONFIG)
    const tool = toolRow(world)
    await tool.fiber
    assert.deepEqual(groupProviders(world), ['FakeOtherRowEngine'])
    await shippedRow.dispose()
    await settle()
    assert.equal(tool.fiber.state, STATE.PENDING, 'between the two records the group has no provider')
    await world.mount(rowPlugin(host))
    await settle()
    assert.deepEqual(groupProviders(world), ['FakePatchedEngine'])
    assert.equal(tool.fiber.state, STATE.ACTIVE)
    assert.deepEqual(tool.seen, ['FakeOtherRowEngine', 'FakePatchedEngine'])
    const lines = world.lines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0].type, 'info')
    noUnhandled()
  })

  test('rollback: the new row stops, the shipped row starts again and provides', async () => {
    const { world, Other, host, journal } = setup()
    const row = await world.mount(rowPlugin(host))
    const tool = toolRow(world)
    await tool.fiber
    await row.dispose()
    await settle()
    assert.deepEqual(journal.disposed, ['patched'], 'the nested engine went with its row')
    await world.mount(Other, ROW_CONFIG)
    await settle()
    assert.deepEqual(groupProviders(world), ['FakeOtherRowEngine'])
    assert.equal(tool.fiber.state, STATE.ACTIVE)
    noUnhandled()
  })

  test('reverse startup race: the new row provides first, the re-enabled shipped row fails, search keeps working', async () => {
    const { world, Other, host } = setup()
    await world.mount(rowPlugin(host))
    const tool = toolRow(world)
    await tool.fiber
    const late = world.group.plugin(Other, ROW_CONFIG)
    world.rows.push(late)
    await assert.rejects(Promise.resolve(late), /service "sessionQuery" has been registered/)
    await settle()
    assert.deepEqual(groupProviders(world), ['FakePatchedEngine'], 'exactly one provider: the first one')
    assert.equal(tool.fiber.state, STATE.ACTIVE)
    assert.equal(world.lines().length, 1, 'the entry is not involved in the other row failing')
    noUnhandled()
  })
})

describe('a provider clash is not retried (spike T6): known limit, healed by a new start of the row', () => {
  test('the other provider leaving after the clash leaves the group without an engine', async () => {
    const { world, journal, Other, host, calls } = setup()
    const shippedRow = await world.mount(Other, ROW_CONFIG)
    const tool = toolRow(world)
    await tool.fiber
    const row = await world.mount(rowPlugin(host))
    await settle()
    assert.equal(row.state, STATE.ACTIVE, 'the row itself stays active (the plugin list shows it running)')
    let lines = world.lines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0].type, 'error')
    assert.match(lines[0].text, /^session-search-patched: active engine: none \(another row already provides sessionQuery in this group\); reason: provider clash/)

    // The override is removed while the host runs: the shipped row stops.
    await shippedRow.dispose()
    await settle()
    assert.deepEqual(groupProviders(world), [], 'no engine in the group: search is dead')
    assert.equal(tool.fiber.state, STATE.PENDING, 'the tool row waits for sessionQuery')
    assert.deepEqual(journal.attempts, ['other', 'patched'], 'nothing is tried again')
    assert.equal(calls.loadShipped, 0)
    assert.equal(world.lines().length, 1, 'no further line tells about it')

    // A restart (or the bundle switched off and on) starts the row afresh.
    await row.dispose()
    await world.mount(rowPlugin(host))
    await settle()
    assert.deepEqual(groupProviders(world), ['FakePatchedEngine'])
    assert.equal(tool.fiber.state, STATE.ACTIVE)
    lines = world.lines()
    assert.deepEqual(lines.map((line) => line.type), ['error', 'info'], 'one line per start of the row')
    noUnhandled()
  })

  test('a second start of the row after a fallback logs its own line and mounts again', async () => {
    const world = createWorld({ version: '0.2.2-rc.4' })
    cleanups.push(() => world.close())
    const journal = createJournal()
    const { host } = makeHost({ Patched: makeEngine('patched', journal), Shipped: makeEngine('shipped', journal) })
    const first = await world.mount(rowPlugin(host))
    await first.dispose()
    await settle()
    assert.deepEqual(groupProviders(world), [])
    await world.mount(rowPlugin(host))
    await settle()
    assert.deepEqual(groupProviders(world), ['FakeShippedEngine'])
    assert.deepEqual(world.lines().map((line) => line.type), ['warn', 'warn'])
    assert.deepEqual(journal.disposed, ['shipped'])
    noUnhandled()
  })
})

describe('the documented log line is the one the code writes', () => {
  const passLine = guard.formatLine(
    'patched SqliteSessionQueryEngine (./engine/index.js)',
    guard.checkHost({ version: guard.PINNED_VERSION, sources: { ...guard.PINNED_SOURCES } }).reason,
  )

  test('README and the manual checklist quote the exact line of a passing guard', () => {
    assert.ok(passLine.startsWith(LINE_PREFIX))
    const readme = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8')
    assert.ok(readme.includes(passLine), 'README.md quotes the line')
    const checklist = path.join(REPO, 'docs', 'session-search-patched-checklist.md')
    if (fs.existsSync(checklist)) assert.ok(fs.readFileSync(checklist, 'utf8').includes(passLine), 'the checklist quotes the line')
  })

  test('the fallback and clash engine texts of the README are the ones the entry builds', () => {
    const readme = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8')
    const source = fs.readFileSync(path.join(PKG, 'src', 'index.host.js'), 'utf8')
    assert.ok(readme.includes(`shipped SqliteSessionQueryEngine (${guard.ENGINE_PACKAGE}) as fallback`))
    assert.ok(source.includes('as fallback`'))
    assert.ok(readme.includes('none (another row already provides sessionQuery in this group)'))
    assert.ok(source.includes("'none (another row already provides sessionQuery in this group)'"))
    assert.ok(readme.includes('search is unavailable in this group until the cause is fixed and the host is restarted'))
    assert.ok(source.includes('search is unavailable in this group until the cause is fixed and the host is restarted'))
  })
})

const EXTRACT = process.env.SSP_RC3_EXTRACT
describe('guard pins against the installed app (opt-in)', () => {
  const skip = EXTRACT ? false : 'set SSP_RC3_EXTRACT to a folder with index.ts, query.ts, schema.ts extracted from the installed app'
  test('the sha256 of the extracted rc.3 sources equal PINNED_SOURCES, the version equals PINNED_VERSION', { skip }, () => {
    for (const [file, pinned] of Object.entries(guard.PINNED_SOURCES)) {
      const actual = createHash('sha256').update(fs.readFileSync(path.join(EXTRACT, path.basename(file)))).digest('hex')
      assert.equal(actual, pinned, file)
    }
    const manifest = path.join(EXTRACT, 'package.json')
    if (fs.existsSync(manifest)) {
      const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      assert.equal(name, guard.ENGINE_PACKAGE)
      assert.equal(version, guard.PINNED_VERSION)
    }
  })
})

test('every case left no unhandled rejection and the decoy HOME, DSH_HOME and XDG folders empty', async () => {
  await settle()
  noUnhandled()
  assert.equal(process.env.HOME, decoys.folders.HOME)
  assert.deepEqual(decoys.touched(), [])
})
