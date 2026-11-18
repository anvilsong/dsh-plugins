// Optional (S10): the bundle patch composed by the rc.3 loader's own patch code.
// Run: DSH_UPSTREAM_DIR=<rc.3 checkout> node --test packages/session-search-patched/test/composition.test.mjs
// Without DSH_UPSTREAM_DIR (or with another checkout) it is one skipped test.
//
// The layers are the rc.3 files of the checkout (bundles dsh-base, dsh-web-app,
// dsh-experimental-session-search), this package's cordis.patch.yml and small
// profile or home layers written here. They are composed with applyPatches()
// of vendor/include/src/patch.ts (the function app-boot's composeEntries() and
// the boot include call as applyEntryPatches), loaded through the checkout's
// tsx; YAML is read with the checkout's js-yaml, `!!js` values kept as opaque
// objects. Nothing is started and no file is written.
//
// It turns the layer table of docs/composition-spike.md §5 into a repeatable
// check and adds the cases that decide whether the swap is silently skipped on
// a real profile: a later layer that replaces the group's config wholesale, a
// later layer that disables only the new row, and the plugin manager composing
// this bundle on its own (plugin-manager/src/index.ts bundleRows/declaredRows).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { PKG_DIR, upstreamSkipReason } from './upstream/upstream-lib.mjs'

const UPSTREAM = (() => {
  const dir = process.env.DSH_UPSTREAM_DIR
  if (dir === undefined) return undefined
  try { return fs.realpathSync(dir) } catch { return dir }
})()
const skip = upstreamSkipReason(UPSTREAM) ?? false

const ENGINE = '@deepseek-ai/dsh-session-query-sqlite'
const PATCHED = 'dsh-plugin-session-search-patched'
const GROUP = 'optional-session-search'
const SHIPPED_ROW = 'optional-session-query-sqlite'
const NEW_ROW = 'session-query-sqlite-patched'
const TOOL_ROW = 'optional-tool-session-query'

let tools
async function load() {
  if (tools !== undefined) return tools
  const file = (relative) => pathToFileURL(path.join(UPSTREAM, relative)).href
  const { register } = await import(file('node_modules/tsx/dist/esm/api/index.mjs'))
  register({ tsconfig: path.join(UPSTREAM, 'tsconfig.json') })
  const { applyPatches } = await import(file('vendor/include/src/patch.ts'))
  const yaml = await import(file('node_modules/js-yaml/dist/js-yaml.mjs'))
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (expr) => ({ '!!js': expr }) })])
  const read = (absolute) => yaml.load(fs.readFileSync(absolute, 'utf8'), { schema })
  const layers = {
    base: read(path.join(UPSTREAM, 'packages/bundle/base/cordis.patch.yml')),
    web: read(path.join(UPSTREAM, 'packages/bundle/web-app/cordis.patch.yml')),
    search: read(path.join(UPSTREAM, 'packages/experimental/session-search/cordis.patch.yml')),
    patched: read(path.join(PKG_DIR, 'cordis.patch.yml')),
  }
  /** Compose layers in order, like composeEntries(); returns the rows and the skip warnings. */
  const compose = (...list) => {
    const warnings = []
    const rows = applyPatches([], structuredClone(list.flat()), (format, ...args) => {
      let index = 0
      warnings.push(format.replace(/%C/g, () => JSON.stringify(args[index++])))
    })
    return { rows, warnings }
  }
  tools = { compose, layers }
  return tools
}

/** Every row with its scope: 'root' or the id of the group holding it. */
function walk(rows, scope = 'root', out = []) {
  for (const row of rows) {
    out.push({ row, scope })
    if (row.group && Array.isArray(row.config)) walk(row.config, row.id, out)
  }
  return out
}

const isEngine = (row) => row.name === ENGINE || row.name === PATCHED
const enabled = (row) => row.disabled !== true

function engines(rows) {
  const all = walk(rows).filter(({ row }) => isEngine(row))
  return {
    group: all.filter(({ scope }) => scope === GROUP).map(({ row }) => ({ id: row.id, enabled: enabled(row) })),
    root: all.filter(({ scope }) => scope === 'root').map(({ row }) => ({ id: row.id, enabled: enabled(row), openAt: row.config?.openAt })),
    elsewhere: all.filter(({ scope }) => scope !== 'root' && scope !== GROUP).map(({ row }) => row.id),
  }
}

const enabledInGroup = (rows) => engines(rows).group.filter((e) => e.enabled).map((e) => e.id)
const groupOf = (rows) => walk(rows).find(({ row }) => row.id === GROUP)?.row
const ROOT_ROW = [{ id: 'session-query-sqlite', enabled: true, openAt: 'never' }]

test('the bundle patch composed by the rc.3 loader code (optional: DSH_UPSTREAM_DIR at an rc.3 checkout)', { skip }, async (t) => {
  await t.test('installed after the session-search bundle: one enabled engine in the group, the new row; tool row and isolate untouched', async () => {
    const { compose, layers } = await load()
    const baseline = compose(layers.base, layers.web, layers.search)
    const swapped = compose(layers.base, layers.web, layers.search, layers.patched)
    assert.deepEqual(swapped.warnings, [])
    assert.deepEqual(enabledInGroup(baseline.rows), [SHIPPED_ROW])
    assert.deepEqual(enabledInGroup(swapped.rows), [NEW_ROW])
    const { root, elsewhere } = engines(swapped.rows)
    assert.deepEqual(root, ROOT_ROW, 'the root-scope engine row is unchanged')
    assert.deepEqual(elsewhere, [])
    const group = groupOf(swapped.rows)
    assert.deepEqual(group.isolate, { sessionQuery: true })
    const tool = (rows) => groupOf(rows).config.find((row) => row.id === TOOL_ROW)
    assert.deepEqual(tool(swapped.rows), tool(baseline.rows))
    assert.deepEqual(group.config.map((row) => row.id), [SHIPPED_ROW, TOOL_ROW, NEW_ROW], 'the new row comes after the shipped row')
    assert.deepEqual(group.config.at(-1).config, { path: ':memory:', openAt: 'first-search', persistedReadConcurrency: 1 })
  })

  await t.test('this layer before the session-search layer (that bundle switched off and on later): both patches skipped, shipped serves', async () => {
    const { compose, layers } = await load()
    const { rows, warnings } = compose(layers.base, layers.web, layers.patched, layers.search)
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /patch: entry "optional-session-query-sqlite" not found/)
    assert.match(warnings[1], /patch insert: entry "optional-session-search" not found/)
    assert.deepEqual(enabledInGroup(rows), [SHIPPED_ROW])
    assert.ok(!walk(rows).some(({ row }) => row.id === NEW_ROW), 'no row of this package is composed')
  })

  await t.test('session-search bundle not selected: both patches skipped, nothing of this package lands at the root', async () => {
    const { compose, layers } = await load()
    const { rows, warnings } = compose(layers.base, layers.web, layers.patched)
    assert.equal(warnings.length, 2)
    assert.equal(groupOf(rows), undefined)
    assert.deepEqual(engines(rows).root, ROOT_ROW)
    assert.ok(!walk(rows).some(({ row }) => row.id === NEW_ROW))
  })

  await t.test('a later profile or home row with disabled: false on the shipped row gives two enabled engines (provider clash at runtime)', async () => {
    const { compose, layers } = await load()
    const { rows, warnings } = compose(layers.base, layers.web, layers.search, layers.patched, [{ id: SHIPPED_ROW, disabled: false }])
    assert.deepEqual(warnings, [])
    assert.deepEqual(enabledInGroup(rows), [SHIPPED_ROW, NEW_ROW])
  })

  await t.test('a later row that only changes the shipped row config keeps it off; an include: id never matches', async () => {
    const { compose, layers } = await load()
    const configOnly = compose(layers.base, layers.web, layers.search, layers.patched, [{ id: SHIPPED_ROW, config: { path: ':memory:', openAt: 'startup' } }])
    assert.deepEqual(enabledInGroup(configOnly.rows), [NEW_ROW])
    const prefixed = compose(layers.base, layers.web, layers.search, layers.patched, [{ id: `include:${SHIPPED_ROW}`, disabled: false }])
    assert.deepEqual(enabledInGroup(prefixed.rows), [NEW_ROW])
    assert.match(prefixed.warnings.join('\n'), /entry "include:optional-session-query-sqlite" not found/)
  })

  await t.test('SILENT SKIP: a later layer that replaces the group config wholesale drops the new row with no warning', async () => {
    const { compose, layers } = await load()
    const wholesale = [{ id: GROUP, config: [
      { id: SHIPPED_ROW, name: ENGINE, config: { path: ':memory:', openAt: 'first-search' } },
      { id: TOOL_ROW, name: '@deepseek-ai/dsh-tool-session-query' },
    ] }]
    const { rows, warnings } = compose(layers.base, layers.web, layers.search, layers.patched, wholesale)
    assert.deepEqual(warnings, [], 'no warning: only the absent row and the composed config tell')
    assert.deepEqual(enabledInGroup(rows), [SHIPPED_ROW])
    assert.ok(!walk(rows).some(({ row }) => row.id === NEW_ROW))
  })

  await t.test('SEARCH DEAD: a later row that disables only the new row leaves no enabled engine in the group (spike T4)', async () => {
    const { compose, layers } = await load()
    const { rows, warnings } = compose(layers.base, layers.web, layers.search, layers.patched, [{ id: NEW_ROW, disabled: true }])
    assert.deepEqual(warnings, [])
    assert.deepEqual(enabledInGroup(rows), [])
    assert.equal(groupOf(rows).config.find((row) => row.id === TOOL_ROW).disabled, undefined, 'the tool row stays on and waits')
  })

  await t.test('the plugin manager composing this bundle alone (bundleRows, declaredRows) finds no row of its own', async () => {
    const { compose, layers } = await load()
    const alone = compose(layers.patched)
    assert.deepEqual(alone.rows, [], 'bundleRows(): no entry id is required to start after install or enable')
    assert.equal(alone.warnings.length, 2)
    const inserts = compose(layers.patched.filter((patch) => patch.insert !== undefined))
    assert.deepEqual(inserts.rows, [], 'declaredRows(): the bundle lists no row of its own to the plugin manager')
  })
})
