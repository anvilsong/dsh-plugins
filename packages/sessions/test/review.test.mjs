// Review tests for dsh-plugin-sessions (T15): adversarial checks across the
// contract, the Host service, the trash engine and the client, where the
// other suites were thin. Every Host test runs on the sandbox store of
// test/helpers/sandbox-store.mjs (fs.mkdtemp under os.tmpdir()), through the
// Remote methods as the Client calls them. Nothing here reads the real DSH
// home or a session log body.
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { assertApplyResult, assertOverview, assertPlan, assertTrashList, ERROR, METHOD_NAMES, METHODS, NAMESPACE, PACKAGE } from '../src/contract.js'
import { createHostAdapter } from '../src/host-adapter.js'
import * as hostEntry from '../src/index.host.js'
import { resolveSettings, SessionsManagerService } from '../src/service.js'
import { CLIENT_SOURCE, createLocale, loadClient, plain, settle } from './helpers/client-harness.mjs'
import { assertWorld, batchFolders, createSandbox, startProcess } from './helpers/sandbox-store.mjs'

const DARWIN = process.platform === 'darwin'
const NOT_DARWIN = DARWIN ? false : 'prune and the session lock probe exist only on darwin'
const FAST = Object.freeze({ fsync: false })

/** Plan everything and apply it through the Remote methods. */
async function pruneAll(proc) {
  const plan = await proc.call('plan', { scope: 'all' })
  assertPlan(plan)
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  assertApplyResult(result)
  return { plan, result }
}

/** Make the audit file unwritable once, at the first fs call `match` accepts (after the call's own checks). */
function auditFailsAt(world, match) {
  let armed = true
  return {
    beforeFs(call) {
      if (!armed || !match(call)) return
      armed = false
      nodeFs.chmodSync(world.auditFile, 0o400)
    },
  }
}
const writable = (world) => { if (nodeFs.existsSync(world.auditFile)) nodeFs.chmodSync(world.auditFile, 0o600) }
const firstTrashListing = (world) => ({ source, name, paths }) => source === 'service' && name === 'readdirSync' && paths[0] === world.trashDir

// ---------------------------------------------------------------------------
// Cross-checks between the separately built parts
// ---------------------------------------------------------------------------

test('cross-check: client descriptors = remoteMethods(service) = contract METHODS, one namespace', async () => {
  const env = loadClient({ locale: createLocale() })
  await settle()
  assert.equal(env.mounts.length, 1)
  const descriptors = env.mounts[0].descriptors
  const tmp = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), 'sessions-review-xcheck-')))
  try {
    const ctx = { reflect: { provide() {} }, get: () => undefined, logger: { warn() {} } }
    const service = new SessionsManagerService(ctx, {
      adapter: createHostAdapter(ctx, { platform: 'linux' }),
      settings: resolveSettings({ dataDir: path.join(tmp, 'data') }),
    })
    const markers = remoteMethods(service).map((marker) => marker.method)
    assert.deepEqual(plain(descriptors.map((d) => d.method)), markers)
    assert.deepEqual(markers, [...METHOD_NAMES])
    assert.deepEqual(Object.keys(METHODS), [...METHOD_NAMES])
    assert.equal(service.typertRemote.namespace, NAMESPACE)
    for (const d of descriptors) {
      assert.equal(d.namespace, NAMESPACE)
      assert.equal(d.service, NAMESPACE)
      assert.equal(d.id, `${PACKAGE}#${NAMESPACE}/${d.method}`)
      assert.deepEqual(plain(d.parameters.map((p) => p.name)), [...METHODS[d.method].params])
    }
    assert.equal(nodeFs.existsSync(path.join(tmp, 'data')), false, 'constructing the service writes nothing')
  } finally {
    nodeFs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('cross-check: the plugin entry provides sessionsManager on a bare context and never throws', () => {
  const provided = []
  const ctx = { reflect: { provide: (name, value) => provided.push([name, value]) }, get: () => undefined, logger: { warn() {} } }
  assert.doesNotThrow(() => hostEntry.apply(ctx, { dataDir: path.join(os.tmpdir(), 'sessions-review-never-created') }))
  assert.deepEqual(provided.map(([name]) => name), [NAMESPACE])
  assert.ok(provided[0][1] instanceof SessionsManagerService)
  assert.equal(nodeFs.existsSync(path.join(os.tmpdir(), 'sessions-review-never-created')), false)
})

test('cross-check: every literal translation key the client uses is in both locale tables', () => {
  const env = loadClient({ locale: createLocale() })
  const { en, zh } = env.locale.dictionaries(NAMESPACE)
  const used = new Set()
  for (const m of CLIENT_SOURCE.matchAll(/\btr\(\s*'([^']+)'/g)) used.add(m[1])
  for (const m of CLIENT_SOURCE.matchAll(/\btr\(\s*[^,()]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) { used.add(m[1]); used.add(m[2]) }
  for (const m of CLIENT_SOURCE.matchAll(/plural\(tr,\s*'([^']+)'/g)) { used.add(m[1]); used.add(`${m[1]}One`) }
  assert.ok(used.size > 150, `found ${used.size} keys`)
  for (const key of used) {
    assert.ok(Object.hasOwn(en, key), `en lacks ${key}`)
    assert.ok(Object.hasOwn(zh, key), `zh lacks ${key}`)
  }
  // Template keys: every family the client builds with a suffix has the same members in both tables.
  for (const m of new Set([...CLIENT_SOURCE.matchAll(/\btr\(`([^`$]*)\$\{/g)].map((x) => x[1]))) {
    const family = (table) => Object.keys(table).filter((key) => key.startsWith(m)).sort()
    assert.ok(family(en).length > 0, `no keys for ${m}*`)
    assert.deepEqual(family(zh), family(en), `${m}*`)
  }
})

// ---------------------------------------------------------------------------
// The trash: what a conflict batch holds, and what purge deletes
// ---------------------------------------------------------------------------

test('a batch in conflict counts the copies it still holds, so the purge prompt names every session purge deletes', { skip: NOT_DARWIN }, async () => {
  const world = await createSandbox({ layout: 'compact' })
  try {
    const p = startProcess(world, FAST)
    const { result } = await pruneAll(p)
    assert.equal(result.state, 'complete')
    // Something (a second host, a user) recreates an empty folder at tree-b's recorded place.
    nodeFs.mkdirSync(world.dirOf('tree-b'))
    const back = await p.call('restore', { batchId: result.batchId })
    assert.deepEqual(back.skipped, [{ rootId: 'tree-b', reasons: [{ code: 'conflict', sessionId: 'tree-b' }] }])
    // The batch folder still holds tree-b's only copy of its log.
    assert.deepEqual(world.places().get('tree-b').map((entry) => entry.place).sort(), ['store', `trash:${result.batchId}`])
    const list = await p.call('trash', { fresh: true })
    assertTrashList(list)
    const [row] = list.batches
    assert.equal(row.state, 'conflict')
    assert.equal(row.sessions, 1, 'the Trash tab and the purge prompt count the copy purge would delete')
    assert.ok(row.bytes > 0)
    const gone = await p.call('purge', { batchId: result.batchId, confirm: result.batchId })
    assert.equal(gone.removedSessions, row.sessions, 'purge deletes exactly what the prompt named')
  } finally {
    await world.cleanup()
  }
})

// ---------------------------------------------------------------------------
// A store with one session, then with none
// ---------------------------------------------------------------------------

test('a store with one session prunes it; with none left the Host still knows the sessions tree, so Restore batch stays available', { skip: NOT_DARWIN }, async () => {
  const world = await createSandbox({ layout: 'compact' })
  try {
    // Keep only tree-b (archived, in workspace beta) in the store: the others leave it (the backend no longer lists them).
    for (const [folder, e] of world.entries) {
      if (folder !== 'tree-b') nodeFs.renameSync(e.dir, path.join(world.elsewhere, folder))
    }
    const p = startProcess(world, FAST)
    const one = await p.call('overview', { fresh: true })
    assertOverview(one)
    assert.equal(one.totals.sessions, 1)
    assert.equal(one.storeDir, world.sessionsRoot, 'one session still gives the store root')
    assert.deepEqual(one.capabilities, { prune: true, reason: null })
    const { plan, result } = await pruneAll(p)
    assert.deepEqual([plan.totals.readySessions, result.moved.sessions, result.state], [1, 1, 'complete'])

    const none = await p.call('overview', { fresh: true })
    assertOverview(none)
    assert.equal(none.totals.sessions, 0)
    assert.deepEqual(none.capabilities, { prune: true, reason: null }, 'the dashboard is not read-only: the batch recorded the sessions tree')
    assert.equal(none.storeDir, world.sessionsRoot)
    const empty = await p.call('plan', { scope: 'all' })
    assert.deepEqual([empty.units.length, empty.totals.readySessions], [0, 0], 'a plan of an empty store is empty')
    const list = await p.call('trash', {})
    assert.deepEqual(list.batches.map((b) => [b.batchId, b.sessions, b.state]), [[result.batchId, 1, 'complete']])
    const back = await p.call('restore', { batchId: result.batchId })
    assert.deepEqual([back.state, back.moved.sessions], ['complete', 1])
    assert.ok(nodeFs.existsSync(world.dirOf('tree-b')))
    const beta = world.registry.workspaces.find((w) => w.id === 'ws-beta')
    assert.ok(beta.sessionIds.includes('tree-b'))
    assert.ok(world.registry.archived.includes('tree-b'))
  } finally {
    await world.cleanup()
  }
})

test('an empty store with no batch stays read-only (unsupported-backend): there is no sessions tree to prune or restore into', async () => {
  const world = await createSandbox({ layout: 'compact' })
  try {
    for (const [folder, e] of world.entries) nodeFs.renameSync(e.dir, path.join(world.elsewhere, folder))
    const p = startProcess(world, FAST)
    const view = await p.call('overview', { fresh: true })
    assertOverview(view)
    assert.equal(view.totals.sessions, 0)
    assert.equal(view.storeDir, null)
    assert.deepEqual(view.capabilities, { prune: false, reason: DARWIN ? ERROR.unsupportedBackend : ERROR.unsupportedPlatform })
    assert.deepEqual((await p.call('trash', {})).batches, [])
    assert.equal(nodeFs.existsSync(world.dataDir), false, 'reading an empty store writes nothing')
  } finally {
    await world.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Audit log write failures at each operation
// ---------------------------------------------------------------------------

test('audit failures: apply-start fails closed after the checks; later lines become warnings; restore and purge stop before they move or delete', { skip: NOT_DARWIN }, async () => {
  const world = await createSandbox({ layout: 'compact' })
  try {
    // 1. apply-start cannot be written (the audit file breaks after the call's own checks): nothing moves.
    let p = startProcess(world, { ...FAST, hooks: auditFailsAt(world, firstTrashListing(world)) })
    let plan = await p.call('plan', { scope: 'all' })
    assert.equal(await p.codeOf('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions }), ERROR.trashUnusable)
    assert.deepEqual(batchFolders(world), [], 'no batch, no manifest')
    assert.deepEqual(world.registryLog, [], 'no registry call')
    assertWorld(world, { label: 'apply-start failed' })
    writable(world)

    // 2. Every line after apply-start fails: the prune completes and says so.
    const createsManifest = ({ name, args, paths }) => name === 'openSync' && paths[0]?.endsWith(`${path.sep}manifest.json`) && (args[1] & nodeFs.constants.O_CREAT) !== 0
    p = startProcess(world, { ...FAST, hooks: auditFailsAt(world, createsManifest) })
    plan = await p.call('plan', { scope: 'all' })
    const result = await p.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
    assertApplyResult(result)
    assert.equal(result.moved.sessions, plan.totals.readySessions)
    assert.ok(result.warnings.some((w) => w.code === 'audit-failed'), JSON.stringify(result.warnings))
    assert.equal(result.state, 'complete', 'an audit warning never changes the outcome')
    assertWorld(world, { label: 'apply with a failing audit' })
    writable(world)

    // 3. restore-start cannot be written: nothing comes back.
    const before = world.storeTree()
    const registry = world.registrySnapshot()
    p = startProcess(world, { ...FAST, hooks: auditFailsAt(world, firstTrashListing(world)) })
    assert.equal(await p.codeOf('restore', { batchId: result.batchId }), ERROR.trashUnusable)
    assert.deepEqual(world.storeTree(), before)
    assert.deepEqual(world.registrySnapshot(), registry)
    writable(world)

    // 4. purge-start cannot be written: nothing is deleted.
    const held = world.treeOf(path.join(world.trashDir, result.batchId))
    p = startProcess(world, { ...FAST, hooks: auditFailsAt(world, firstTrashListing(world)) })
    assert.equal(await p.codeOf('purge', { batchId: result.batchId, confirm: result.batchId }), ERROR.trashUnusable)
    assert.deepEqual(world.treeOf(path.join(world.trashDir, result.batchId)), held)
    writable(world)

    // 5. An unwritable audit log turns pruning off before a plan is made.
    nodeFs.chmodSync(world.auditFile, 0o400)
    p = startProcess(world, FAST)
    assert.deepEqual((await p.call('overview', { fresh: true })).capabilities, { prune: false, reason: ERROR.trashUnusable })
    assert.equal(await p.codeOf('plan', { scope: 'all' }), ERROR.trashUnusable)
    writable(world)

    // With the audit log back, the batch restores whole.
    const back = await startProcess(world, FAST).call('restore', { batchId: result.batchId })
    assert.equal(back.state, 'complete')
    assert.deepEqual(world.storeTree(), world.original.tree)
    assert.deepEqual(world.registrySnapshot(), world.original.registry)
  } finally {
    writable(world)
    await world.cleanup()
  }
})

// ---------------------------------------------------------------------------
// A registry step that fails in the middle of a unit
// ---------------------------------------------------------------------------

test('a detach that fails in the middle of a unit is a warning; the moves stand and recover() completes the step', { skip: NOT_DARWIN }, async () => {
  const world = await createSandbox({ layout: 'compact' })
  try {
    world.failRegistry.set('detach', (id) => id === 'tree-a-c2')
    const p = startProcess(world, FAST)
    const { plan, result } = await pruneAll(p)
    assert.equal(result.moved.sessions, plan.totals.readySessions, 'every unit moved')
    assert.equal(result.state, 'needs-recovery')
    assert.deepEqual(result.warnings.filter((w) => w.code === 'registry-step-failed'), [{ code: 'registry-step-failed', sessionId: 'tree-a-c2' }])
    // The other steps of the unit ran: its root is detached and unarchived.
    const alpha = world.registry.workspaces.find((w) => w.id === 'ws-alpha')
    assert.equal(alpha.sessionIds.includes('tree-a'), false)
    assert.equal(world.registry.archived.includes('tree-a'), false)
    world.failRegistry.clear()
    const report = await p.recover()
    assert.equal(report.batches[0].steps, 1, 'only the failed detach is left')
    assertWorld(world, { label: 'after recover()' })
    const again = world.registryLog.length
    await p.recover()
    assert.equal(world.registryLog.length, again, 'nothing is left to do')
  } finally {
    await world.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Plan tokens
// ---------------------------------------------------------------------------

test('a plan cannot be replayed: not after its apply, not after an undo, not after a Host restart', { skip: NOT_DARWIN }, async () => {
  const world = await createSandbox({ layout: 'compact' })
  try {
    const p = startProcess(world, FAST)
    const { plan, result } = await pruneAll(p)
    const replay = { planId: plan.planId, confirmCount: plan.totals.readySessions }
    assert.equal(await p.codeOf('apply', replay), ERROR.planExpired)
    const back = await p.call('restore', { batchId: result.batchId })
    assert.equal(back.state, 'complete')
    assert.equal(await p.codeOf('apply', replay), ERROR.planExpired, 'the undo does not revive the plan')
    const fresh = await p.call('plan', { scope: 'all' })
    assert.equal(await startProcess(world, FAST).codeOf('apply', { planId: fresh.planId, confirmCount: fresh.totals.readySessions }), ERROR.planExpired, 'a plan belongs to the process that issued it')
    assert.deepEqual(world.storeTree(), world.original.tree)
    assert.deepEqual(world.registrySnapshot(), world.original.registry)
  } finally {
    await world.cleanup()
  }
})

// ---------------------------------------------------------------------------
// A trash folder on a real other device
// ---------------------------------------------------------------------------

test('a configured trashDir on another device (devfs) keeps pruning off, and nothing is created there', { skip: NOT_DARWIN }, async () => {
  const world = await createSandbox({ layout: 'compact' })
  try {
    const trashDir = '/dev/sessions-manager-review-trash'
    assert.notEqual(nodeFs.statSync('/dev').dev, nodeFs.statSync(world.sessionsRoot).dev, 'the test needs /dev on another device')
    // The sandbox's fs guard refuses every path outside the sandbox, so this service runs on the real node:fs
    // over the sandbox's host services; only lstat, stat and realpath ever reach /dev.
    const p = startProcess(world, FAST)
    const logs = []
    const adapter = createHostAdapter({ get: (name) => p.services[name], logger: { warn: (line) => logs.push(line) } }, { platform: 'darwin' })
    const service = new SessionsManagerService({ reflect: { provide() {} } }, { adapter, settings: resolveSettings({ trashDir }, { home: world.profileHome }) })
    const codeOf = async (promise) => promise.then(() => 'resolved', (error) => error.code)
    const view = await service.overview({ fresh: true })
    assertOverview(view)
    assert.deepEqual(view.capabilities, { prune: false, reason: ERROR.trashUnusable })
    assert.ok(logs.some((line) => line.includes('another device')), logs.join('\n'))
    assert.equal(await codeOf(service.plan({ scope: 'all' })), ERROR.trashUnusable)
    assert.equal(await codeOf(service.restore({ batchId: 'b-20260101T000000Z-00000000' })), ERROR.trashUnusable)
    assert.equal(await codeOf(service.purge({ batchId: 'b-20260101T000000Z-00000000', confirm: 'b-20260101T000000Z-00000000' })), ERROR.trashUnusable)
    assert.equal(nodeFs.existsSync(trashDir), false)
    assert.deepEqual(world.storeTree(), world.original.tree)
    assert.deepEqual(world.registryLog, [])
  } finally {
    await world.cleanup()
  }
})
