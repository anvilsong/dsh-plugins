// Integration test of dsh-plugin-sessions on a sandbox store (plan task T10).
//
// Everything goes through the service's Remote methods as the Client calls
// them: a call-derived Cordis Context carrying the owner invocation, JSON in
// and JSON out (helpers/sandbox-store.mjs, startProcess().call). Only recover(),
// which no Remote caller can reach, is called in-process.
//
// The store is a real folder under fs.mkdtemp(os.tmpdir()) with 400+ opaque
// session logs; the host services are fakes over that folder and an
// in-memory registry. The trash engine, the audit log, the session lock probe
// and the host adapter are the real ones. Every file-system call of the
// service and the adapter goes through a wrapper that refuses any path
// outside the sandbox and any log-body open; the node:fs promises calls of
// the audit log and paths.js are guarded the same way (installAuditGate).
// HOME, DSH_HOME and the XDG roots point at decoy folders that must stay empty.
//
// Adversarial parts: a kill-point matrix (every fs call, every registry call
// before and after its effect, every audit write, during apply and during
// restore), time-of-check races in both windows (between plan and apply, and
// between the re-read and the renames), every refusal code, abuse traps,
// memory, two services on one trash folder, path traversal in ids, symlinks
// swapped in, replayed plans, concurrent applies and restores into a missing
// project folder.
//
// Kill points: "fs" is every call of the injected fs (the service's and the
// adapter's wrapper, one index), killed before it runs (a write is torn in
// half); "registry" is every registry mutation, killed before and after its
// effect; "audit" is every audit-log open. Registry reads and backend stat()
// calls change nothing, so they are not kill points. The matrix runs on the
// compact sandbox in worker threads and skips the real fsync (a process death,
// not a power loss); the counts are printed as a test diagnostic.
//
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import vm from 'node:vm'
import { Worker } from 'node:worker_threads'
import {
  assertApplyResult, assertArchivedPage, assertOverview, assertPlan, assertPurgeResult, assertTrashList, assertUnarchiveResult, ERROR,
  ERROR_CODES, METHOD_NAMES, REFUSAL_CODES,
} from '../src/contract.js'
import * as hostEntry from '../src/index.host.js'
import { HINTS_FILE } from '../src/service.js'
import { buildIndex, overview as overviewOf } from '../src/store-index.js'
import {
  AGENT, assertAuditClean, assertWorld, batchFolders, createSandbox, folderBytes, gateViolations, holdForeignLock, hostFacts, installAuditGate,
  installDecoys, LOG_FILE, projectName, registryAfterRestore, releaseForeignLock, resetGateViolations, SECRET, startProcess, uninstallAuditGate,
} from './helpers/sandbox-store.mjs'

const decoys = await installDecoys()
installAuditGate()
const worlds = []
after(async () => {
  for (const world of worlds) await world.cleanup()
  uninstallAuditGate()
  decoys.restore()
})

const DARWIN = process.platform === 'darwin'
const NOT_DARWIN = DARWIN ? false : 'prune needs the darwin session lock probe (design.md D18)'
const MINUTE = 60_000
const tick = () => new Promise((resolve) => setImmediate(resolve))
// A wait for a held call has a wall-clock bound, never a count of event-loop turns. Before the call reaches
// its hook it writes audit lines and checks paths with node:fs promises, and the libuv thread pool runs that
// work. On a loaded machine that work waits for a CPU while the event loop keeps turning (thousands of turns),
// so a bound of 2,000 turns failed these tests at random. WAIT_MS only makes a call that never gets there fail.
const WAIT_MS = 30_000
/** Wait until `check()` is true (the test polls it once per event-loop turn). Fail with `label` if it is not true within WAIT_MS. */
async function until(check, label) {
  const deadline = Date.now() + WAIT_MS
  while (!check() && Date.now() < deadline) await tick()
  assert.ok(check(), label)
}

async function sandbox(options) {
  const world = await createSandbox(options)
  worlds.push(world)
  return world
}

/** Folders of the units of a plan that are ready, and of those that are blocked. */
const foldersOf = (world, ids) => ids.map((id) => world.byId.get(id).folder)

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * The prune units an independent reading of the sandbox gives: the archived
 * cascade over parentSession links, one unit per connected group, and the
 * refusal codes of design.md (all or nothing), from the sandbox's own record
 * of every session.
 */
function expectedUnits(world) {
  const rows = new Map([...world.entries.values()].map((e) => [e.id, e]))
  const archived = new Set(world.registry.archived)
  const kids = new Map()
  for (const e of rows.values()) if (e.parentId) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e.id])
  const reach = new Set()
  const stack = [...archived]
  while (stack.length > 0) {
    const id = stack.pop()
    if (reach.has(id)) continue
    reach.add(id)
    stack.push(...(kids.get(id) ?? []))
  }
  const registered = new Map()
  for (const w of [...world.registry.workspaces].sort((a, b) => (a.id < b.id ? -1 : 1))) for (const id of w.sessionIds) if (!registered.has(id)) registered.set(id, w.id)
  const workspaceOf = (start) => {
    const seen = new Set()
    for (let id = start; id && !seen.has(id); id = rows.get(id)?.parentId) {
      seen.add(id)
      if (registered.has(id)) return registered.get(id)
    }
    return null
  }
  const assigned = new Set()
  const units = []
  for (const start of [...reach].filter((id) => rows.has(id)).sort()) {
    if (assigned.has(start)) continue
    const group = []
    const queue = [start]
    assigned.add(start)
    while (queue.length > 0) {
      const id = queue.pop()
      group.push(id)
      for (const next of [rows.get(id).parentId, ...(kids.get(id) ?? [])]) {
        if (next && reach.has(next) && rows.has(next) && !assigned.has(next)) {
          assigned.add(next)
          queue.push(next)
        }
      }
    }
    const inside = new Set(group)
    const tops = group.filter((id) => !inside.has(rows.get(id).parentId)).sort()
    const rootId = tops.length > 0 ? (tops.find((id) => archived.has(id)) ?? tops[0]) : group.filter((id) => archived.has(id)).sort()[0]
    const codes = new Set()
    for (const id of group) {
      const e = rows.get(id)
      if (world.live.has(id)) codes.add('live')
      if (world.foreignLocks.has(e.folder)) codes.add('locked')
      if (e.age < 30 * MINUTE) codes.add('recent')
      if (!archived.has(id) && e.origin !== 'subagent') codes.add('kept-descendant')
      if (e.formatStatus === 'migration-required') codes.add('legacy-format')
      if (e.link || e.id !== e.folder || e.id.includes('..') || e.id.includes('/')) codes.add('path-unsafe')
      if (e.parentId && rows.has(e.parentId) && !inside.has(e.parentId)) codes.add('parent-kept')
    }
    if (tops.length === 0) codes.add('cycle')
    if (workspaceOf(rootId) === null) codes.add('workspace-missing')
    units.push({ rootId, members: [...group].sort(), status: codes.size > 0 ? 'blocked' : 'ready', codes: [...codes].sort() })
  }
  return units.sort((a, b) => (a.rootId < b.rootId ? -1 : 1))
}

const planShape = (plan) => plan.units.map((u) => ({
  rootId: u.rootId, members: [...u.memberIds].sort(), status: u.status, codes: [...new Set(u.reasons.map((r) => r.code))].sort(),
})).sort((a, b) => (a.rootId < b.rootId ? -1 : 1))

const skippedCodes = (result) => Object.fromEntries(result.skipped.map((s) => [s.rootId, s.reasons.map((r) => `${r.code}:${r.sessionId}`)]))

// ---------------------------------------------------------------------------
// 1. The sandbox store
// ---------------------------------------------------------------------------

test('the sandbox: 400+ opaque sessions with every shape, a HostFacts over the folder that agrees with the host adapter', async () => {
  const world = await sandbox()
  assert.ok(world.entries.size >= 400, `${world.entries.size} sessions`)
  assert.ok(world.root.startsWith(nodeFs.realpathSync(os.tmpdir())), 'the sandbox lies under the temp folder')
  for (const e of world.entries.values()) {
    assert.equal(e.dir, path.join(world.root, 'store', 'sessions', e.project, e.folder))
    const log = nodeFs.readFileSync(path.join(nodeFs.realpathSync(e.dir), LOG_FILE))
    assert.deepEqual([...log.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd], 'an opaque zstd-framed log')
  }
  const shapes = {
    grandchild: [...world.entries.values()].some((e) => e.parentId && world.byId.get(e.parentId)?.parentId),
    nestedArchived: world.registry.archived.includes('tree-a-c1') && world.registry.archived.includes('tree-a-c1-g'),
    live: world.live.has('live-root-c'),
    recent: world.entries.get('recent-root-c').age < 30 * MINUTE,
    locked: world.foreignLocks.has('locked-root-c'),
    fork: world.entries.get('fork-root-f').origin === null && world.registry.workspaces.some((w) => w.sessionIds.includes('fork-root-f')),
    archivedChildOfKept: world.registry.archived.includes('kept-parent-c') && !world.registry.archived.includes('kept-parent'),
    noWorkspace: [...world.entries.values()].filter((e) => e.registeredIn === null && !e.parentId).length,
  }
  assert.deepEqual({ ...shapes, noWorkspace: shapes.noWorkspace > 10 }, {
    grandchild: true, nestedArchived: true, live: true, recent: true, locked: true, fork: true, archivedChildOfKept: true, noWorkspace: true,
  })

  // The HostFacts implementation, read by the store index, gives the same figures as the service over the host adapter.
  const facts = hostFacts(world)
  const proc = startProcess(world)
  const view = await proc.call('overview', { fresh: true })
  assertOverview(view)
  const config = { allowPermanentDelete: true, recentActivityMinutes: 30, listLimit: 500, refreshMs: 0, indexWarnBytes: 268_435_456 }
  const index = await buildIndex(facts, { config, now: Date.now(), folderBytes })
  const totals = (t) => [t.sessions, t.live, t.archived, t.children, t.archivedRoots, t.archivedChildren, t.reclaimableUnits, t.blockedUnits, t.bytes]
  assert.deepEqual(totals(overviewOf(index).totals), totals(view.totals))
  assert.deepEqual(index.units.map((u) => [u.rootId, u.status]), (await proc.call('plan', { scope: 'all' })).units.map((u) => [u.rootId, u.status]))

  // Its registry steps act on the same in-memory registry.
  const small = await sandbox({ layout: 'compact' })
  const steps = hostFacts(small)
  await steps.unpin('tree-a-c2')
  await steps.detach('tree-a')
  await steps.unarchive('tree-a')
  assert.equal(small.registry.pinned.includes('tree-a-c2'), false)
  assert.equal(small.registry.workspaces.some((w) => w.sessionIds.includes('tree-a')), false)
  await steps.attach('tree-a', 'ws-alpha')
  await steps.archive('tree-a')
  await steps.pin('tree-a-c2')
  assert.equal(small.registry.workspaces[0].sessionIds[0], 'tree-a')
  assert.ok(small.registry.archived.includes('tree-a') && small.registry.pinned.includes('tree-a-c2'))
})

// ---------------------------------------------------------------------------
// 2. End to end
// ---------------------------------------------------------------------------

/**
 * The end-to-end flow. `split`: the two prunes take disjoint halves of the
 * ready units (the second plan is a selection of units the first did not
 * touch); without it both prunes take every ready unit, so the second batch
 * holds the sessions the first one restored.
 */
async function endToEnd({ split }) {
  const world = await sandbox()
  const proc = startProcess(world)
  const expected = expectedUnits(world)
  const readyAll = expected.filter((u) => u.status === 'ready')
  const halves = [readyAll.filter((_, i) => i % 2 === 0), readyAll.filter((_, i) => i % 2 === 1)]
  const scopeOf = (half) => (split ? { scope: 'selection', rootIds: halves[half].map((u) => u.rootId) } : { scope: 'all' })
  let ready = split ? halves[0] : readyAll
  let ops = []
  const step = (label, added, options = {}) => {
    const where = assertWorld(world, { label, ...options })
    ops = [...ops, ...added]
    assert.deepEqual(assertAuditClean(world, label), ops, `${label}: audit.jsonl holds the expected ops`)
    assert.deepEqual(decoys.touched(), [], `${label}: the decoy home folders stay empty`)
    return where
  }

  // overview
  const view = await proc.call('overview', { fresh: true })
  assertOverview(view)
  assert.deepEqual(view.capabilities, { prune: true, reason: null })
  assert.equal(view.storeDir, world.sessionsRoot)
  assert.equal(view.totals.sessions, world.entries.size)
  assert.equal(view.totals.live, 1)
  assert.equal(view.totals.archived, world.registry.archived.length)
  assert.equal(view.totals.archivedRoots, expected.length)
  assert.equal(view.totals.reclaimableUnits, readyAll.length)
  assert.equal(view.totals.blockedUnits, expected.length - readyAll.length)
  assert.deepEqual(view.workspaces.filter((w) => w.id !== null).map((w) => w.id).sort(), world.registry.workspaces.map((w) => w.id).sort())
  assert.ok(view.workspaces.some((w) => w.id === null && w.folder === projectName(path.join(world.work, 'loose'))), 'sessions in no workspace form an Unassigned row')
  assert.ok(view.largest.every((row) => row.events === null && (row.title === null || row.title.includes(SECRET))))
  step('overview', [])
  const page = await proc.call('archived', { sort: 'bytes', limit: 500 })
  assertArchivedPage(page)
  assert.equal(page.total, expected.length)

  // plan: a dry run that agrees with an independent reading of the sandbox
  const all = await proc.call('plan', { scope: 'all' })
  assertPlan(all)
  assert.deepEqual(planShape(all), expected)
  assert.equal(all.totals.readySessions, readyAll.reduce((n, u) => n + u.members.length, 0))
  assert.equal(nodeFs.existsSync(world.trashDir), false, 'a plan creates no trash folder')
  step('plan', ['plan'])
  const plan = split ? await proc.call('plan', scopeOf(0)) : all
  if (split) {
    assertPlan(plan)
    step('plan of the first half', ['plan'])
  }
  const sessionsOf = (units) => units.reduce((n, u) => n + u.members.length, 0)
  assert.equal(plan.totals.readySessions, sessionsOf(ready))

  // apply
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  assertApplyResult(result)
  assert.equal(result.state, 'complete', JSON.stringify(result.skipped))
  assert.deepEqual(result.moved, { units: ready.length, sessions: plan.totals.readySessions, bytes: plan.totals.readyBytes })
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.warnings, [])
  const moved = new Set(foldersOf(world, ready.flatMap((u) => u.members)))
  let where = step('apply', ['apply-start', ...ready.flatMap(() => ['unit-moved', 'registry-step']), 'apply-end'])
  for (const [folder] of world.entries) {
    assert.equal(where.get(folder)[0].place, moved.has(folder) ? `trash:${result.batchId}` : 'store', `${folder} after apply`)
  }
  assert.ok(nodeFs.existsSync(path.join(world.trashDir, result.batchId, HINTS_FILE)))
  const end = world.auditRecords().at(-1)
  assert.deepEqual({ op: end.op, outcome: end.outcome, counts: end.counts }, {
    op: 'apply-end', outcome: 'complete', counts: { units: ready.length, sessions: plan.totals.readySessions, skipped: 0 },
  })

  // trash
  const list = await proc.call('trash', { fresh: true })
  assertTrashList(list)
  assert.equal(list.trashDir, world.trashDir)
  assert.deepEqual(list.batches.map((b) => [b.batchId, b.units, b.sessions, b.bytes, b.state]), [
    [result.batchId, ready.length, plan.totals.readySessions, plan.totals.readyBytes, 'complete'],
  ])
  step('trash', [])

  // restore: the byte-identical tree and the exact registry come back
  const back = await proc.call('restore', { batchId: result.batchId })
  assertApplyResult(back)
  assert.equal(back.state, 'complete')
  assert.deepEqual(back.moved, result.moved)
  assert.deepEqual(back.skipped, [])
  assert.deepEqual(world.storeTree(), world.original.tree, 'the store tree is byte-identical to the one before the prune')
  assert.deepEqual(world.registrySnapshot(), registryAfterRestore(world.original.registry, [ready.flatMap((u) => u.members)]), 'workspace order, archive and pin lists are back')
  step('restore', ['restore-start', 'restore-end'])
  assert.deepEqual((await proc.call('trash', {})).batches, [], 'a fully restored batch is not listed')

  // plan again: the same facts give the same digest
  const again = await proc.call('plan', { scope: 'all' })
  assertPlan(again)
  assert.equal(again.digest, all.digest, 'after the round trip every planned fact (revision, size, mtime) is unchanged')
  step('plan again', ['plan'])
  ready = split ? halves[1] : readyAll
  const plan2 = split ? await proc.call('plan', scopeOf(1)) : again
  if (split) step('plan of the second half', ['plan'])

  // apply again, then purge that batch
  const result2 = await proc.call('apply', { planId: plan2.planId, confirmCount: plan2.totals.readySessions })
  assertApplyResult(result2)
  assert.equal(result2.state, 'complete')
  assert.equal(result2.moved.sessions, sessionsOf(ready))
  const moved2 = new Set(foldersOf(world, ready.flatMap((u) => u.members)))
  step('apply again', ['apply-start', ...ready.flatMap(() => ['unit-moved', 'registry-step']), 'apply-end'])
  const gone = await proc.call('purge', { batchId: result2.batchId, confirm: result2.batchId })
  assertPurgeResult(gone)
  assert.equal(gone.batchId, result2.batchId)
  assert.equal(gone.removedSessions, result2.moved.sessions)
  assert.ok(gone.removedBytes >= result2.moved.bytes, `${gone.removedBytes} >= ${result2.moved.bytes}`)
  where = step('purge', ['purge-start', 'purge-end'], { gone: moved2 })
  assert.equal(nodeFs.existsSync(path.join(world.trashDir, result2.batchId)), false)
  const purgedPrefixes = [...moved2].map((folder) => `${world.entries.get(folder).project}/${folder}`)
  const kept = world.original.tree.filter((line) => !purgedPrefixes.some((prefix) => line.split(' ')[1] === prefix || line.split(' ')[1].startsWith(`${prefix}/`)))
  assert.deepEqual(world.storeTree(), kept, 'purge removed exactly the purged session folders')
  assert.deepEqual((await proc.call('trash', { fresh: true })).batches, [], 'nothing is left to list: one batch restored, one purged')
  assert.deepEqual(world.violations, [])
}

test('end to end through the Remote methods: overview, plan, apply, trash, restore, plan, apply, purge (the second prune takes other units)', { skip: NOT_DARWIN }, async () => {
  await endToEnd({ split: true })
})

// Regression (found by this file, fixed in src/trash.js recoverBatch/placeOf): pruning the units a batch restored
// again must leave that batch complete and unlisted, with no `recover` audit line and no `lost` session.
test('end to end with the same units pruned twice: the restored batch stays complete when its units are pruned again', { skip: NOT_DARWIN }, async () => {
  await endToEnd({ split: false })
})

// ---------------------------------------------------------------------------
// 3. Kill-point matrix
// ---------------------------------------------------------------------------

const KINDS = [
  ['fs', (k) => ({ fsAt: k })],
  ['registry-before', (k) => ({ registryAt: k, registryMode: 'before' })],
  ['registry-after', (k) => ({ registryAt: k, registryMode: 'after' })],
  ['audit', (k) => ({ auditAt: k })],
]
/** Kill runs run in worker threads (each run on its own sandbox): the trash engine's fs calls are synchronous. */
const WORKERS = Math.max(2, Math.min(8, os.availableParallelism() - 2))

/**
 * Run killRun (helpers/sandbox-store.mjs) for kill point 0, 1, 2, ... of every
 * kind until the first index the call no longer reaches. Every failing index
 * is listed with the call it killed.
 */
async function matrix(t, phase) {
  const pool = Array.from({ length: WORKERS }, () => new Worker(new URL('./helpers/sandbox-store.mjs', import.meta.url), {
    workerData: { role: 'sessions-kill-runner' },
  }))
  const pending = new Map()
  let nextId = 0
  for (const worker of pool) {
    worker.on('message', ({ id, run, failure }) => {
      pending.get(id)?.resolve({ run, failure })
      pending.delete(id)
    })
    worker.on('error', (error) => {
      for (const entry of pending.values()) entry.reject(error)
      pending.clear()
    })
  }
  const runOn = (worker, spec) => new Promise((resolve, reject) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, phase, spec })
  })
  const counts = {}
  const failures = []
  try {
    for (const [kind, specOf] of KINDS) {
      const results = new Map()
      let next = 0
      let end = null
      await Promise.all(pool.map(async (worker) => {
        while (end === null) {
          const k = next
          next += 1
          if (k >= 5000) {
            end = k
            failures.push(`${kind}: more than 5000 kill points, the matrix did not end`)
            break
          }
          const result = await runOn(worker, specOf(k))
          results.set(k, result)
          if (result.run !== undefined && !result.run.reached && (end === null || k < end)) end = k
        }
      }))
      for (let k = 0; k < end; k += 1) {
        const { run, failure } = results.get(k)
        if (failure !== undefined) failures.push(`${phase} ${kind} index ${k}: ${failure}`)
        else if (!run.reached) failures.push(`${phase} ${kind} index ${k}: not reached, but index ${end} is the end`)
      }
      const last = results.get(end)?.run
      if (last?.error) failures.push(`${phase} ${kind}: the run that was not killed failed: ${last.error}`)
      else if (last !== undefined && last.state !== 'complete') failures.push(`${phase} ${kind}: the run that was not killed ended ${last.state}`)
      counts[kind] = end
    }
  } finally {
    await Promise.all(pool.map((worker) => worker.terminate()))
  }
  t.diagnostic(`${phase} kill points: ${JSON.stringify(counts)}, total ${Object.values(counts).reduce((a, b) => a + b, 0)} (${WORKERS} workers)`)
  assert.deepEqual(failures, [], `${failures.length} failing kill points (first 20):\n${failures.slice(0, 20).join('\n')}`)
  return counts
}

test('kill-point matrix during apply: every fs call, every registry call (before and after its effect), every audit write', { skip: NOT_DARWIN }, async (t) => {
  const counts = await matrix(t, 'apply')
  assert.ok(counts.fs > 300 && counts['registry-before'] === 12 && counts['registry-after'] === 12 && counts.audit >= 8, JSON.stringify(counts))
})

test('kill-point matrix during restore: every fs call, every registry call (before and after its effect), every audit write', { skip: NOT_DARWIN }, async (t) => {
  const counts = await matrix(t, 'restore')
  assert.ok(counts.fs > 300 && counts['registry-before'] >= 10 && counts['registry-after'] >= 10 && counts.audit >= 2, JSON.stringify(counts))
})

// ---------------------------------------------------------------------------
// 4. Guard
// ---------------------------------------------------------------------------

test('guard: the injected fs refuses every path outside the sandbox; decoy HOME and DSH_HOME stay empty; no test file names the real home', async () => {
  const world = await sandbox({ layout: 'compact' })
  const proc = startProcess(world)
  const outside = path.dirname(world.root)
  assert.throws(() => proc.serviceFs.lstatSync(outside), /outside the sandbox/)
  assert.throws(() => proc.serviceFs.renameSync(world.dirOf('keep-1'), path.join(outside, 'escaped-session')), /outside the sandbox/)
  assert.throws(() => proc.adapterFs.readdirSync('/'), /outside the sandbox/)
  assert.throws(() => proc.adapterFs.openSync(path.join(decoys.folders.HOME, 'x'), 'w'), /outside the sandbox/)
  await assert.rejects(proc.serviceFs.promises.readFile(path.join(decoys.folders.DSH_HOME, 'x')), /outside the sandbox/)
  assert.ok(nodeFs.existsSync(world.dirOf('keep-1')), 'nothing moved')
  assert.equal(nodeFs.existsSync(path.join(outside, 'escaped-session')), false)
  assert.equal(world.violations.length, 5)
  world.violations.length = 0
  // The node:fs promises calls of the audit log and paths.js are guarded too.
  await assert.rejects(nodeFs.promises.open(path.join(decoys.folders.HOME, 'audit.jsonl'), 'a'), /outside the sandbox/)
  assert.equal(gateViolations().length, 1)
  resetGateViolations()
  assert.deepEqual(nodeFs.readdirSync(decoys.folders.HOME), [])

  for (const name of ['HOME', 'DSH_HOME', 'XDG_STATE_HOME']) assert.equal(process.env[name], decoys.folders[name], `${name} is a decoy`)
  assert.deepEqual(decoys.touched(), [])
  // No test file calls for the home folder or names the real one; these two files do not even spell the word.
  const testDir = fileURLToPath(new URL('.', import.meta.url))
  const files = nodeFs.readdirSync(testDir, { recursive: true }).filter((name) => /\.m?js$/.test(name)).map((name) => path.join(testDir, name))
  const call = new RegExp(`home${'dir'}\\s*\\(`)
  const word = new RegExp(`home${'dir'}`)
  const realHome = decoys.saved.HOME
  for (const file of files) {
    const text = nodeFs.readFileSync(file, 'utf8')
    assert.equal(call.test(text), false, `${file} asks for the home folder`)
    if (typeof realHome === 'string' && realHome.length > 1) {
      for (const sub of ['.dsh', '.local']) assert.equal(text.includes(`${realHome}/${sub}`), false, `${file} names the real ${sub} folder`)
    }
  }
  for (const file of [fileURLToPath(import.meta.url), fileURLToPath(new URL('./helpers/sandbox-store.mjs', import.meta.url))]) {
    assert.equal(word.test(nodeFs.readFileSync(file, 'utf8')), false, file)
  }
})

// ---------------------------------------------------------------------------
// 5. Refusal coverage
// ---------------------------------------------------------------------------

/** What each session folder holds now (wherever it is: store, trash, or moved aside by a test) and the registry. */
function snap(world) {
  const where = world.places()
  const at = (folder) => where.get(folder)?.[0]?.path ?? (nodeFs.existsSync(path.join(world.elsewhere, folder)) ? path.join(world.elsewhere, folder) : null)
  return {
    prints: new Map([...world.entries.keys()].map((folder) => [folder, at(folder) === null ? null : world.printOf(folder, at(folder))])),
    registry: world.registrySnapshot(),
  }
}

/** The members of a unit are where they were, with the same bytes, and the registry holds them as before. */
function assertUnitUntouched(world, folders, before, label) {
  const where = world.places()
  for (const folder of folders) {
    const found = where.get(folder) ?? []
    assert.equal(found.length, 1, `${label}: ${folder} is in one place`)
    assert.equal(world.printOf(folder, found[0].path), before.prints.get(folder), `${label}: ${folder} is unchanged on disk`)
    const id = world.idOf(folder)
    const member = (registry) => Object.entries(registry.workspaces).filter(([, ids]) => ids.includes(id)).map(([w]) => w)
    const now = world.registrySnapshot()
    assert.deepEqual(member(now), member(before.registry), `${label}: ${folder} keeps its workspace`)
    assert.equal(now.archived.includes(id), before.registry.archived.includes(id), `${label}: ${folder} keeps its archived mark`)
    assert.equal(now.pinned.includes(id), before.registry.pinned.includes(id), `${label}: ${folder} keeps its pin`)
  }
}

const membersOf = (plan, rootId) => plan.units.find((u) => u.rootId === rootId).memberIds

test('refusal coverage: every refusal code of the contract is produced; the affected unit is unchanged on disk and in the registry', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox()
  const proc = startProcess(world)
  const seen = new Map()
  const saw = (code, where) => seen.set(code, [...(seen.get(code) ?? []), where])

  // 1. At plan time: the shapes of the sandbox; one member's folder vanishes right after the listing (another actor).
  const blockedRoots = {
    'live-root': 'live', 'locked-root': 'locked', 'recent-root': 'recent', 'fork-root': 'kept-descendant', 'kept-parent-c': 'parent-kept', 'cycle-a': 'cycle',
    'link-root': 'path-unsafe', 'dots..root': 'path-unsafe', 'mismatch-other': 'path-unsafe', '../../../escape': 'path-unsafe', 'vanish-root': 'no-location',
    'loose-root': 'workspace-missing', 'legacy-root': 'legacy-format',
  }
  let vanished = false
  world.hooks.afterList = () => {
    if (vanished) return
    vanished = true
    nodeFs.renameSync(world.dirOf('vanish-root-c'), path.join(world.elsewhere, 'vanish-root-c'))
  }
  const dry = await proc.call('plan', { scope: 'all' })
  world.hooks.afterList = null
  nodeFs.renameSync(path.join(world.elsewhere, 'vanish-root-c'), world.dirOf('vanish-root-c'))
  assertPlan(dry)
  for (const [rootId, code] of Object.entries(blockedRoots)) {
    const unit = dry.units.find((u) => u.rootId === rootId)
    assert.equal(unit?.status, 'blocked', `${rootId} is blocked`)
    assert.ok(unit.reasons.some((r) => r.code === code), `${rootId}: ${code} in ${JSON.stringify(unit.reasons)}`)
  }
  for (const unit of dry.units) for (const r of unit.reasons) saw(r.code, `plan ${unit.rootId}`)

  // The blocked units next to ready ones: an apply moves the ready ones and leaves every blocked one as it was.
  const controls = ['tree-b', 'tree-c', 'conflict-root', 'delta-root', 'solo-root', 'solo2-root']
  const before1 = snap(world)
  const plan1 = await proc.call('plan', { scope: 'selection', rootIds: [...Object.keys(blockedRoots).filter((id) => id !== 'vanish-root'), ...controls] })
  assert.deepEqual(plan1.units.filter((u) => u.status === 'ready').map((u) => u.rootId).sort(), [...controls].sort())
  const result1 = await proc.call('apply', { planId: plan1.planId, confirmCount: plan1.totals.readySessions })
  assert.equal(result1.state, 'complete')
  const blockedFolders = Object.keys(blockedRoots).filter((id) => id !== 'vanish-root').flatMap((rootId) => foldersOf(world, membersOf(plan1, rootId)))
  assertUnitUntouched(world, [...blockedFolders, 'vanish-root', 'vanish-root-c'], before1, 'plan-time refusal')

  // 2. At apply time: a log that grew (changed), a root the owner unarchived (not-archived), a folder on another device (cross-device).
  const plan2 = await proc.call('plan', { scope: 'selection', rootIds: ['race-a', 'race-b', 'xdev-root', 'race-c'] })
  assert.equal(plan2.totals.ready, 4)
  nodeFs.appendFileSync(path.join(world.dirOf('race-a-c'), LOG_FILE), Buffer.from([1, 2, 3]))
  assert.deepEqual(await proc.call('unarchive', { ids: ['race-b'] }), { unarchived: ['race-b'], skipped: [] })
  world.devOverride.set(world.dirOf('xdev-root'), 1)
  const before2 = snap(world)
  const result2 = await proc.call('apply', { planId: plan2.planId, confirmCount: plan2.totals.readySessions })
  world.devOverride.clear()
  assertApplyResult(result2)
  assert.deepEqual(skippedCodes(result2), { 'race-a': ['changed:race-a-c'], 'race-b': ['not-archived:race-b'], 'xdev-root': ['cross-device:xdev-root'] })
  assert.equal(result2.moved.units, 1)
  for (const s of result2.skipped) for (const r of s.reasons) saw(r.code, `apply ${s.rootId}`)
  assertUnitUntouched(world, ['race-a', 'race-a-c', 'race-b', 'race-b-c', 'xdev-root'], before2, 'apply-time refusal')

  // 3. At restore time, on the first batch: an existing destination (conflict), a workspace whose folder is gone
  //    (workspace-missing), a project folder swapped for a symlink (conflict), a trash copy on another device
  //    (cross-device), a trash copy that is gone (no-location); and one unit whose project folder is missing (recreated).
  const batch = result1.batchId
  const trashCopy = (folder) => path.join(world.trashDir, batch, 'sessions', world.entries.get(folder).project, folder)
  nodeFs.mkdirSync(world.dirOf('conflict-root'))
  nodeFs.renameSync(path.join(world.work, 'delta'), path.join(world.elsewhere, 'delta-work'))
  const epsilon = path.dirname(world.dirOf('solo-root'))
  nodeFs.rmdirSync(epsilon)
  nodeFs.mkdirSync(path.join(world.elsewhere, 'epsilon-target'))
  nodeFs.symlinkSync(path.join(world.elsewhere, 'epsilon-target'), epsilon)
  world.devOverride.set(trashCopy('tree-b'), 1)
  nodeFs.renameSync(trashCopy('tree-c-c'), path.join(world.elsewhere, 'tree-c-c'))
  const zeta = path.dirname(world.dirOf('solo2-root'))
  nodeFs.rmdirSync(zeta)
  const before3 = snap(world)
  const back = await proc.call('restore', { batchId: batch })
  world.devOverride.clear()
  assertApplyResult(back)
  assert.deepEqual(skippedCodes(back), {
    'conflict-root': ['conflict:conflict-root'], 'delta-root': ['workspace-missing:delta-root'], 'solo-root': ['conflict:solo-root'],
    'tree-b': ['cross-device:tree-b'], 'tree-c': ['no-location:tree-c-c'],
  })
  assert.equal(back.state, 'conflict')
  assert.deepEqual(back.moved, { units: 1, sessions: 2, bytes: back.moved.bytes })
  for (const s of back.skipped) for (const r of s.reasons) saw(r.code, `restore ${s.rootId}`)
  assertUnitUntouched(world, ['delta-root', 'delta-root-c', 'solo-root', 'tree-b', 'tree-c'], before3, 'restore-time refusal')
  // conflict-root: the trash copy stays as it was, the planted empty folder is not replaced.
  assert.deepEqual(world.places().get('conflict-root').map((f) => f.place).sort(), ['store', `trash:${batch}`])
  assert.equal(world.printOf('conflict-root', trashCopy('conflict-root')), world.original.prints.get('conflict-root'))
  assert.deepEqual(nodeFs.readdirSync(world.dirOf('conflict-root')), [], 'the existing empty folder is not replaced')
  assert.equal(world.registry.workspaces.some((w) => w.sessionIds.includes('conflict-root')), false, 'a unit left in the trash is not attached')
  assert.deepEqual(nodeFs.readdirSync(path.join(world.elsewhere, 'epsilon-target')), [], 'nothing is moved through the symlinked project folder')
  assert.equal(nodeFs.lstatSync(zeta).mode & 0o777, 0o700, 'the missing project folder is created 0700')
  assert.equal(world.printOf('solo2-root'), world.original.prints.get('solo2-root'))
  assert.ok(nodeFs.readFileSync(path.join(world.trashDir, batch, 'journal.jsonl'), 'utf8').includes('"op":"folder-created"'))
  assert.ok(world.registry.workspaces.find((w) => w.id === 'ws-zeta').sessionIds.includes('solo2-root'), 'the restored unit is attached again')

  // Repair what was done to the store; a second restore brings every remaining unit back.
  nodeFs.rmdirSync(world.dirOf('conflict-root'))
  nodeFs.renameSync(path.join(world.elsewhere, 'delta-work'), path.join(world.work, 'delta'))
  nodeFs.unlinkSync(epsilon)
  nodeFs.renameSync(path.join(world.elsewhere, 'tree-c-c'), trashCopy('tree-c-c'))
  const again = await proc.call('restore', { batchId: batch })
  assert.equal(again.state, 'complete', JSON.stringify(again))
  assert.equal(again.moved.units, 5)
  const registry = { ...world.original.registry, archived: world.original.registry.archived.filter((id) => id !== 'race-b') }
  assertWorld(world, { label: 'after the repaired restore', baseline: { prints: world.original.prints, registry }, changed: new Set(['race-a-c']) })

  // 4. Unarchive: a live session, a session that is not archived, a registry call that fails.
  world.failRegistry.set('unarchive', (id) => id === 'race-h')
  const before4 = snap(world)
  const result4 = await proc.call('unarchive', { ids: ['live-root-c', 'kept-parent', 'race-h'] })
  world.failRegistry.clear()
  assertUnarchiveResult(result4)
  assert.deepEqual(result4, { unarchived: [], skipped: [{ id: 'live-root-c', code: 'live' }, { id: 'kept-parent', code: 'not-archived' }, { id: 'race-h', code: 'changed' }] })
  for (const s of result4.skipped) saw(s.code, `unarchive ${s.id}`)
  assertUnitUntouched(world, ['live-root-c', 'kept-parent', 'race-h'], before4, 'unarchive refusal')

  assert.deepEqual([...REFUSAL_CODES].filter((code) => !seen.has(code)), [], `every refusal code is produced; seen ${JSON.stringify([...seen.keys()])}`)
  assert.deepEqual(world.violations, [])
})

// ---------------------------------------------------------------------------
// 6. Time-of-check races
// ---------------------------------------------------------------------------

const RACE_ROOTS = ['race-a', 'race-b', 'race-c', 'race-d', 'race-e', 'race-f']
const RACE_FOLDERS = ['race-a', 'race-a-c', 'race-b', 'race-b-c', 'race-c', 'race-c-c', 'race-d', 'race-d-c', 'race-e', 'race-e-c']

/** The changes another actor makes: a member turns live, gets a fresh lock, a publish starts, the host unarchives two members. */
function raceChanges(world) {
  world.live.add('race-a-c')
  holdForeignLock(world, 'race-b-c')
  world.registry.archived.splice(world.registry.archived.indexOf('race-c'), 1)
  world.registry.archived.splice(world.registry.archived.indexOf('race-d-c'), 1)
  nodeFs.writeFileSync(path.join(world.dirOf('race-e-c'), `${LOG_FILE}.tmp`), '')
}

test('time-of-check races: a member that turns live, gets a fresh lock or is unarchived between plan and apply makes its unit skip', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox()
  const proc = startProcess(world)
  const plan = await proc.call('plan', { scope: 'selection', rootIds: RACE_ROOTS })
  assert.equal(plan.totals.ready, RACE_ROOTS.length)
  raceChanges(world)
  const before = snap(world)
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  releaseForeignLock(world, 'race-b-c')
  assertApplyResult(result)
  assert.deepEqual(skippedCodes(result), {
    'race-a': ['live:race-a-c'], 'race-b': ['locked:race-b-c'], 'race-c': ['not-archived:race-c'],
    // A nested member that lost its archived mark changes the unit's facts: the fresh unit no longer matches the plan.
    'race-d': ['changed:race-d-c'],
    'race-e': ['locked:race-e-c'],
  })
  assert.equal(result.state, 'partial')
  assert.deepEqual(result.moved.units, 1, 'the unchanged unit still moves')
  assertUnitUntouched(world, RACE_FOLDERS, before, 'race between plan and apply')
  assert.equal(world.registryLog.some(([, id]) => RACE_FOLDERS.includes(id)), false, 'no registry step for a skipped unit')
})

/**
 * The write of the applied batch's hints file: it comes after the re-read and the manifest, before the first
 * rename. An open of registry.json alone is not enough: recover() reads the hints of older batches first.
 */
const isHintsWrite = ({ source, name, paths, args }) => source === 'service' && name === 'openSync' && path.basename(paths[0] ?? '') === HINTS_FILE
  && (args[1] & nodeFs.constants.O_CREAT) !== 0

/** The races of raceChanges(), made inside apply at the write of its hints; the synchronous precheck must catch every one. */
async function racesInsideApply(world, { onFs = () => {} } = {}) {
  let before = null
  const proc = startProcess(world, {
    hooks: {
      beforeFs: (call) => {
        onFs(call)
        if (before === null && isHintsWrite(call)) {
          raceChanges(world)
          before = snap(world)
        }
      },
    },
  })
  const plan = await proc.call('plan', { scope: 'selection', rootIds: RACE_ROOTS })
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  releaseForeignLock(world, 'race-b-c')
  assert.ok(before !== null, 'the race ran inside apply')
  assertApplyResult(result)
  assert.deepEqual(skippedCodes(result), {
    'race-a': ['live:race-a-c'], 'race-b': ['locked:race-b-c'], 'race-c': ['not-archived:race-c'], 'race-d': ['not-archived:race-d-c'],
    'race-e': ['locked:race-e-c'],
  })
  assert.equal(result.moved.units, 1)
  assertUnitUntouched(world, RACE_FOLDERS, before, 'race inside apply')
  assert.equal(world.registryLog.some(([, id]) => RACE_FOLDERS.includes(id)), false, 'no registry step for a skipped unit')
  return result
}

test('time-of-check races inside apply, between the re-read and the renames: the synchronous precheck catches them', { skip: NOT_DARWIN }, async () => {
  await racesInsideApply(await sandbox())
})

test('the inside-apply hooks target the batch being applied: with a closed batch and a batch still in the trash before it, the races still land inside the apply', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox()
  const proc = startProcess(world)
  const closed = await proc.call('apply', await planFor(proc, ['tree-b']))
  assert.equal((await proc.call('restore', { batchId: closed.batchId })).state, 'complete')
  assert.equal(lastJournalOp(world, closed.batchId), 'closed')
  await proc.call('apply', await planFor(proc, ['tree-c']))
  // Before the new batch's hints are written, recover() reads the hints of the batch still in the trash.
  let olderReads = 0
  await racesInsideApply(world, {
    onFs: ({ source, name, paths, args }) => {
      if (source === 'service' && name === 'openSync' && path.basename(paths[0] ?? '') === HINTS_FILE && (args[1] & nodeFs.constants.O_CREAT) === 0) olderReads += 1
    },
  })
  assert.ok(olderReads > 0, 'an older batch\'s hints were read first: a hook on the first open would have fired too early')
  assert.equal(lastJournalOp(world, closed.batchId), 'closed', 'the closed batch was left alone')
})

test('a member that turns live or gets locked after its root was renamed rolls the whole unit back', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox()
  const proc = startProcess(world, {
    hooks: {
      beforeFs: ({ source, name, paths }) => {
        if (source !== 'service' || name !== 'renameSync') return
        if (paths[0] === world.dirOf('race-g')) world.live.add('race-g-c')
        if (paths[0] === world.dirOf('race-h') && !world.foreignLocks.has('race-h-c')) holdForeignLock(world, 'race-h-c')
      },
    },
  })
  const before = snap(world)
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['race-g', 'race-h', 'race-f'] })
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  releaseForeignLock(world, 'race-h-c')
  assert.deepEqual(skippedCodes(result), { 'race-g': ['live:race-g-c'], 'race-h': ['locked:race-h-c'] })
  assert.equal(result.moved.units, 1)
  assertUnitUntouched(world, ['race-g', 'race-g-c', 'race-h', 'race-h-c'], before, 'mid-unit rollback')
  const journal = nodeFs.readFileSync(path.join(world.trashDir, result.batchId, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const id of ['race-g', 'race-h']) {
    assert.deepEqual(journal.filter((r) => r.id === id).map((r) => r.op), ['moved', 'rolled-back'], `${id}: renamed, then renamed back`)
  }
})

// ---------------------------------------------------------------------------
// 7. Abuse and memory
// ---------------------------------------------------------------------------

test('abuse: no method opens or reads a log body or calls search, an agent gets nothing; overview adds less than 50 MB of heap', { skip: NOT_DARWIN }, async (t) => {
  const world = await sandbox()
  const proc = startProcess(world)
  // The traps work.
  const log = path.join(world.dirOf('tree-a'), LOG_FILE)
  assert.throws(() => proc.services.sessionPersistence.open('tree-a', 'read'), /abuse/)
  assert.throws(() => proc.serviceFs.openSync(log, 'r'), /abuse/)
  assert.throws(() => proc.adapterFs.readFileSync(log), /abuse/)
  assert.throws(() => proc.services.sessionQuery.search('anything'), /abuse/)
  assert.throws(() => proc.services.sessionSearch.query('anything'), /abuse/)
  assert.equal(world.violations.length, 5)
  world.violations.length = 0

  // An agent caller is refused by every method before anything is read.
  const lists = world.listCalls
  for (const name of METHOD_NAMES) {
    const request = { overview: {}, archived: {}, plan: { scope: 'all' }, apply: { planId: 'p-0', confirmCount: 1 }, unarchive: { ids: ['tree-a'] }, trash: {},
      restore: { batchId: 'b-0' }, purge: { batchId: 'b-0', confirm: 'b-0' } }[name]
    assert.equal(await proc.codeOf(name, request, AGENT), ERROR.forbidden, name)
  }
  assert.equal(world.listCalls, lists)
  assert.deepEqual(world.registryLog, [])

  // Memory: one overview of the whole sandbox.
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc')
  gc()
  const start = process.memoryUsage().heapUsed
  const view = await proc.call('overview', { fresh: true })
  const during = process.memoryUsage().heapUsed
  gc()
  const retained = process.memoryUsage().heapUsed
  assertOverview(view)
  const MB = 1024 * 1024
  t.diagnostic(`overview of ${view.totals.sessions} sessions: heap +${((during - start) / MB).toFixed(1)} MB before gc, +${((retained - start) / MB).toFixed(1)} MB retained`)
  assert.ok(during - start < 50 * MB, `heap grew ${during - start} bytes`)
  assert.ok(retained - start < 50 * MB, `heap retained ${retained - start} bytes`)

  // Every method once, on the real paths.
  assertArchivedPage(await proc.call('archived', { text: 'tree', sort: 'title', olderThanDays: 1, largerThanBytes: 1 }))
  const plan = await proc.call('plan', { scope: 'olderThan', olderThanDays: 1 })
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  assertUnarchiveResult(await proc.call('unarchive', { ids: ['race-h', 'kept-parent'] }))
  assertTrashList(await proc.call('trash', { fresh: true }))
  assertApplyResult(await proc.call('restore', { batchId: result.batchId }))
  const plan2 = await proc.call('plan', { scope: 'selection', rootIds: ['tree-b'] })
  const result2 = await proc.call('apply', { planId: plan2.planId, confirmCount: plan2.totals.readySessions })
  assertPurgeResult(await proc.call('purge', { batchId: result2.batchId, confirm: result2.batchId }))
  await proc.recover()
  assert.deepEqual(world.violations, [], 'no log body opened or read, no search called')
  assert.deepEqual(gateViolations(), [])
  const recorded = ['profileContext', 'sessionPersistence', 'sessionProjectionCache', 'sessions', 'workspaceRegistry']
  assert.deepEqual([...proc.asked].filter((name) => !recorded.includes(name)), [], 'the adapter asks only for the services docs/store-safety.md records')
})

// ---------------------------------------------------------------------------
// 8. Two services on one trash folder
// ---------------------------------------------------------------------------

/** Host A applies and is held at its first detach; host B shares the store and the trash folder. */
async function twoHosts(variant) {
  const world = await sandbox({ layout: 'compact' })
  let release
  let held = false
  const gate = new Promise((resolve) => { release = resolve })
  const a = startProcess(world, {
    host: variant.hostA,
    hooks: { beforeRegistry: ({ name }) => (!held && name === 'detach' ? ((held = true), gate) : undefined) },
  })
  const b = startProcess(world, { host: variant.hostB })
  const planA = await a.call('plan', { scope: 'all' })
  const planB = await b.call('plan', { scope: 'all' })
  const running = a.call('apply', { planId: planA.planId, confirmCount: planA.totals.readySessions })
  await until(() => held, 'host A is inside its apply')
  const batchId = batchFolders(world)[0]
  return { world, a, b, planB, batchId, running, release }
}

const VARIANTS = [
  { label: 'same machine, another live process', hostA: undefined, hostB: undefined },
  { label: 'two hosts', hostA: 'host-a.example', hostB: 'host-b.example' },
]

test('two services on one trash folder: while one applies, the other host gets busy for apply, restore, purge and recover; reads stay available', { skip: NOT_DARWIN }, async () => {
  for (const variant of VARIANTS) {
    const { world, a, b, planB, batchId, running, release } = await twoHosts(variant)
    const label = variant.label
    assert.equal(await b.codeOf('apply', { planId: planB.planId, confirmCount: planB.totals.readySessions }), ERROR.busy, `${label}: apply`)
    assert.equal(await b.codeOf('restore', { batchId }), ERROR.busy, `${label}: restore`)
    assert.equal(await b.codeOf('purge', { batchId, confirm: batchId }), ERROR.busy, `${label}: purge`)
    assert.equal(await b.recover().then(() => 'resolved', (error) => error.code), ERROR.busy, `${label}: recover`)
    assertOverview(await b.call('overview', { fresh: true }))
    assertArchivedPage(await b.call('archived', {}))
    assertTrashList(await b.call('trash', { fresh: true }))
    assertPlan(await b.call('plan', { scope: 'all' }))
    // The first host's own second mutation is busy too.
    assert.equal(await a.codeOf('restore', { batchId }), ERROR.busy, `${label}: a second mutation on the first host`)
    release()
    const result = await running
    assert.equal(result.state, 'complete', `${label}: ${JSON.stringify(result)}`)
    const pruned = world.idsInTrash()
    // Once the lock is released, the other host can mutate.
    const back = await b.call('restore', { batchId: result.batchId })
    assert.equal(back.state, 'complete', label)
    assert.deepEqual(world.storeTree(), world.original.tree, `${label}: byte-identical after the other host restored`)
    assert.deepEqual(world.registrySnapshot(), registryAfterRestore(world.original.registry, [pruned]), label)
    a.stop()
    b.stop()
  }
})

// Regression test for a defect the first integration run found; it is fixed in src/.
test('unarchive takes the trash lock: on a second host it is busy while the first host applies', { skip: NOT_DARWIN }, async () => {
  for (const variant of VARIANTS) {
    const { b, running, release } = await twoHosts(variant)
    try {
      assert.equal(await b.codeOf('unarchive', { ids: ['tree-c'] }), ERROR.busy, variant.label)
    } finally {
      release()
      await running
    }
  }
})

// ---------------------------------------------------------------------------
// 9. Adversarial
// ---------------------------------------------------------------------------

test('path traversal in session ids and batch ids: refused or not found, never followed, nothing moves', { skip: NOT_DARWIN }, async (t) => {
  const world = await sandbox()
  const proc = startProcess(world)
  const tree = world.storeTree()
  const registry = world.registrySnapshot()
  // Header ids with `..` and `/` are unit roots: selectable, never ready.
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['../../../escape', 'dots..root', 'mismatch-other'] })
  for (const unit of plan.units) assert.deepEqual([unit.status, unit.reasons.map((r) => r.code)], ['blocked', ['path-unsafe']], unit.rootId)
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: 0 })
  assert.deepEqual([result.batchId, result.moved.sessions, result.state, result.skipped], [null, 0, 'complete', []], 'no ready unit: nothing to move')
  assert.equal(await proc.codeOf('plan', { scope: 'selection', rootIds: ['../x'] }), ERROR.invalidRequest, 'not a unit root')
  assert.equal(await proc.codeOf('plan', { scope: 'selection', rootIds: ['tree-a-c1'] }), ERROR.invalidRequest, 'a member is not a root')
  // Batch ids that are not one safe segment.
  for (const batchId of ['../trash', '..', '.lock', '.journal.jsonl', 'a/b', '', '-b']) {
    assert.equal(await proc.codeOf('restore', { batchId }), ERROR.invalidRequest, `restore ${JSON.stringify(batchId)}`)
    assert.equal(await proc.codeOf('purge', { batchId, confirm: batchId }), ERROR.invalidRequest, `purge ${JSON.stringify(batchId)}`)
  }
  const codes = {}
  for (const batchId of ['b..x', 'trash', 'sessions', 'b-0000']) {
    codes[batchId] = [await proc.codeOf('restore', { batchId }), await proc.codeOf('purge', { batchId, confirm: batchId })]
    for (const code of codes[batchId]) assert.ok(ERROR_CODES.includes(code), `${batchId}: ${code}`)
  }
  t.diagnostic(`batch ids that pass the contract pattern but name no batch: ${JSON.stringify(codes)}`)
  assert.deepEqual(await proc.call('unarchive', { ids: ['../x', '/etc'] }), { unarchived: [], skipped: [{ id: '../x', code: 'not-archived' }, { id: '/etc', code: 'not-archived' }] })
  assert.deepEqual(world.storeTree(), tree)
  assert.deepEqual(world.registrySnapshot(), registry)
  assert.deepEqual(world.violations, [])
})

test('symlinks swapped in between plan and apply, or after the re-read, are never followed or moved', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox()
  const swap = (folder, aside) => {
    nodeFs.renameSync(folder, aside)
    nodeFs.symlinkSync(aside, folder)
  }
  let inWindow = false
  const proc = startProcess(world, {
    hooks: {
      beforeFs: (call) => {
        if (inWindow || !isHintsWrite(call)) return
        inWindow = true
        swap(world.dirOf('race-g'), path.join(world.elsewhere, 'race-g'))
        swap(path.dirname(world.dirOf('solo-root')), path.join(world.elsewhere, 'epsilon-project'))
      },
    },
  })
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['race-f', 'race-g', 'solo-root', 'race-h'] })
  assert.equal(plan.totals.ready, 4)
  // Between plan and apply: race-f's folder becomes a link to its own content, moved aside.
  swap(world.dirOf('race-f'), path.join(world.elsewhere, 'race-f'))
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  assert.ok(inWindow)
  assertApplyResult(result)
  assert.deepEqual(skippedCodes(result), { 'race-f': ['path-unsafe:race-f'], 'race-g': ['path-unsafe:race-g'], 'solo-root': ['path-unsafe:solo-root'] })
  assert.equal(result.moved.units, 1, 'race-h, untouched by the swaps, still moves')
  for (const [folder, aside] of [['race-f', 'race-f'], ['race-g', 'race-g'], ['solo-root', path.join('epsilon-project', 'solo-root')]]) {
    assert.ok(nodeFs.lstatSync(world.dirOf(folder)).isSymbolicLink() || nodeFs.lstatSync(path.dirname(world.dirOf(folder))).isSymbolicLink(), `${folder}: the link stays in the store`)
    assert.equal(world.printOf(folder, path.join(world.elsewhere, aside)), world.original.prints.get(folder), `${folder}: the link target is untouched`)
    assert.equal((world.places().get(folder) ?? []).some((f) => f.place.startsWith('trash:')), false, `${folder}: nothing went to the trash`)
    assert.ok(world.registry.archived.includes(folder), `${folder}: still archived`)
  }
})

// Regression test for a defect the first integration run found; it is fixed in src/.
test('a session folder swapped for a symlink during the lock probe is refused, not moved into the trash as a link', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox()
  const target = world.dirOf('race-h')
  let armed = false
  let swapped = false
  const proc = startProcess(world, {
    hooks: {
      beforeFs: (call) => {
        const { source, name, paths } = call
        if (isHintsWrite(call)) armed = true
        if (armed && !swapped && source === 'adapter' && name === 'readdirSync' && paths[0] === target) {
          swapped = true
          nodeFs.renameSync(target, path.join(world.elsewhere, 'race-h'))
          nodeFs.symlinkSync(path.join(world.elsewhere, 'race-h'), target)
        }
      },
    },
  })
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['race-h'] })
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  assert.ok(swapped)
  assert.deepEqual(skippedCodes(result), { 'race-h': ['path-unsafe:race-h'] })
  assert.ok(world.registry.archived.includes('race-h'), 'the registry keeps a session whose data did not move')
})

test('a plan is used once, belongs to its process and expires; a wrong count is refused; a second apply while one runs is busy', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  let offset = 0
  let held = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const proc = startProcess(world, {
    clock: () => Date.now() + offset,
    hooks: { beforeRegistry: ({ name }) => (!held && name === 'unarchive' && world.hold ? ((held = true), gate) : undefined) },
  })
  const other = startProcess(world)
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['tree-b'] })
  assert.equal(await other.codeOf('apply', { planId: plan.planId, confirmCount: 1 }), ERROR.planExpired, 'a plan id of another process')
  assert.equal(await proc.codeOf('apply', { planId: plan.planId, confirmCount: 2 }), ERROR.confirmationMismatch)
  assert.equal(await proc.codeOf('apply', { planId: plan.planId, confirmCount: 0 }), ERROR.confirmationMismatch)
  const first = await proc.call('apply', { planId: plan.planId, confirmCount: 1 })
  assert.equal(first.moved.sessions, 1, 'a wrong count does not use the plan up')
  assert.equal(await proc.codeOf('apply', { planId: plan.planId, confirmCount: 1 }), ERROR.planExpired, 'a replayed plan')
  const stale = await proc.call('plan', { scope: 'selection', rootIds: ['tree-c'] })
  offset += 10 * MINUTE + 1
  assert.equal(await proc.codeOf('apply', { planId: stale.planId, confirmCount: 2 }), ERROR.planExpired, 'expired after planTtlMinutes')
  offset = 0

  // A second mutation while an apply runs.
  const plan2 = await proc.call('plan', { scope: 'selection', rootIds: ['tree-a'] })
  const plan3 = await proc.call('plan', { scope: 'selection', rootIds: ['tree-c'] })
  world.hold = true
  const running = proc.call('apply', { planId: plan2.planId, confirmCount: plan2.totals.readySessions })
  await until(() => held, 'the first apply is held at its unarchive')
  assert.equal(await proc.codeOf('apply', { planId: plan3.planId, confirmCount: plan3.totals.readySessions }), ERROR.busy)
  assert.equal(await proc.codeOf('apply', { planId: plan2.planId, confirmCount: plan2.totals.readySessions }), ERROR.busy, 'the same plan again')
  assert.equal(await proc.codeOf('restore', { batchId: first.batchId }), ERROR.busy)
  assert.equal(await proc.codeOf('purge', { batchId: first.batchId, confirm: first.batchId }), ERROR.busy)
  assert.equal(await proc.codeOf('unarchive', { ids: ['tree-c'] }), ERROR.busy)
  release()
  assert.equal((await running).state, 'complete')
  assert.equal(await proc.codeOf('apply', { planId: plan3.planId, confirmCount: plan3.totals.readySessions }), 'resolved', 'the plan refused as busy is still valid')
  assertWorld(world, { label: 'after the replays' })
})

test('restore into a missing project folder creates exactly that folder (0700); a missing sessions tree is never created', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  const proc = startProcess(world)
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['tree-c'] })
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  const first = world.idsInTrash()
  const project = path.dirname(world.dirOf('tree-c'))
  const neighbours = nodeFs.readdirSync(project)
  assert.ok(neighbours.length > 0, 'the project folder keeps its other sessions')
  // Move the other sessions aside (as the host would with its own) and remove the empty project folder.
  for (const name of neighbours) nodeFs.renameSync(path.join(project, name), path.join(world.elsewhere, name))
  nodeFs.rmdirSync(project)
  const back = await proc.call('restore', { batchId: result.batchId })
  assert.equal(back.state, 'complete', JSON.stringify(back))
  assert.equal(nodeFs.lstatSync(project).mode & 0o777, 0o700)
  assert.deepEqual(nodeFs.readdirSync(project).sort(), ['tree-c', 'tree-c-c'])
  for (const name of neighbours) nodeFs.renameSync(path.join(world.elsewhere, name), path.join(project, name))
  const strip = (lines) => lines.map((line) => line.replace(/ ino=\d+$/, ''))
  const projectName = path.basename(project)
  assert.deepEqual(world.storeTree().filter((l) => !l.startsWith(`d ${projectName} `)), world.original.tree.filter((l) => !l.startsWith(`d ${projectName} `)))
  assert.deepEqual(strip(world.storeTree()), strip(world.original.tree), 'only the project folder itself is new')
  assert.deepEqual(world.registrySnapshot(), registryAfterRestore(world.original.registry, [first]))

  // A sessions tree that is gone: the restore fails with a contract error and creates nothing.
  const plan2 = await proc.call('plan', { scope: 'selection', rootIds: ['tree-b'] })
  const result2 = await proc.call('apply', { planId: plan2.planId, confirmCount: 1 })
  const second = world.idsInTrash()
  nodeFs.renameSync(world.store, path.join(world.elsewhere, 'store'))
  nodeFs.mkdirSync(world.store)
  const code = await proc.codeOf('restore', { batchId: result2.batchId })
  assert.ok(code !== 'resolved', code)
  assert.equal(nodeFs.existsSync(world.sessionsRoot), false, 'the sessions tree is never created')
  nodeFs.rmdirSync(world.store)
  nodeFs.renameSync(path.join(world.elsewhere, 'store'), world.store)
  assert.equal((await proc.call('restore', { batchId: result2.batchId })).state, 'complete')
  assert.deepEqual(world.registrySnapshot(), registryAfterRestore(world.original.registry, [first, second]))
})

test('forged and symlinked batches in the trash folder: restore and purge never follow them and never touch the store', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  const proc = startProcess(world)
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['tree-a'] })
  const real = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  const storeBefore = world.storeTree()
  const project = world.entries.get('keep-1').project
  // A batch that is a symlink to a store project folder.
  nodeFs.symlinkSync(path.join(world.sessionsRoot, project), path.join(world.trashDir, 'b-link'))
  // A forged batch: one entry climbs out of the store, one names a stored session (with a planted copy in the forged batch).
  const forged = path.join(world.trashDir, 'b-forged')
  nodeFs.mkdirSync(path.join(forged, 'sessions', project, 'keep-1'), { recursive: true, mode: 0o700 })
  for (const dir of [forged, path.join(forged, 'sessions'), path.join(forged, 'sessions', project)]) nodeFs.chmodSync(dir, 0o700)
  nodeFs.writeFileSync(path.join(forged, 'sessions', project, 'keep-1', 'planted.txt'), 'planted')
  const entry = (id, workspaceDir) => ({ id, workspaceDir, workspaceId: null, parent: null, archived: false, pinned: false, bytes: 1, source: path.join(world.sessionsRoot, workspaceDir, id) })
  const manifest = {
    v: 1, kind: 'dsh-plugin-sessions/trash-batch', batchId: 'b-forged', createdAt: Date.now(), planId: null, sessionsRoot: world.sessionsRoot,
    workspaceDirs: [project, '..'], units: [{ rootId: 'keep-1', memberIds: ['keep-1'], bytes: 1 }, { rootId: 'escape', memberIds: ['escape'], bytes: 1 }],
    sessions: [entry('keep-1', project), entry('escape', '..')], totals: { units: 2, sessions: 2, bytes: 2 },
  }
  nodeFs.writeFileSync(path.join(forged, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  // A link planted inside the real batch, pointing at a stored log.
  const keptLog = path.join(world.dirOf('keep-2'), LOG_FILE)
  const inside = path.join(world.trashDir, real.batchId, 'sessions', world.entries.get('tree-a').project, 'tree-a', 'planted-link')
  nodeFs.symlinkSync(keptLog, inside)

  for (const batchId of ['b-link', 'b-forged']) {
    const code = await proc.codeOf('restore', { batchId })
    assert.ok(code === 'resolved' || ERROR_CODES.includes(code), `restore ${batchId}: ${code}`)
  }
  assert.deepEqual(world.storeTree(), storeBefore, 'no forged restore changed the store')
  assert.ok(ERROR_CODES.includes(await proc.codeOf('purge', { batchId: 'b-link', confirm: 'b-link' })), 'a symlinked batch is not purged')
  assert.deepEqual(world.storeTree(), storeBefore, 'a symlinked batch purge leaves its target alone')
  const forgedPurge = await proc.codeOf('purge', { batchId: 'b-forged', confirm: 'b-forged' })
  assert.ok(forgedPurge === 'resolved' || ERROR_CODES.includes(forgedPurge), forgedPurge)
  assert.deepEqual(world.storeTree(), storeBefore, 'a forged batch purge removes nothing in the store')
  assertPurgeResult(await proc.call('purge', { batchId: real.batchId, confirm: real.batchId }))
  assert.ok(nodeFs.existsSync(keptLog), 'purge removes a planted link, never its target')
  assert.deepEqual(world.storeTree(), storeBefore, 'the purge of the real batch removes only the trash')
  assert.deepEqual(world.violations, [])
})

test('a trash folder swapped for a symlink between plan and apply: apply refuses, nothing moves, the link target is untouched', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  const proc = startProcess(world)
  const first = await proc.call('plan', { scope: 'selection', rootIds: ['tree-b'] })
  await proc.call('apply', { planId: first.planId, confirmCount: 1 })
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['tree-a', 'tree-c'] })
  const aside = path.join(world.elsewhere, 'trash-real')
  nodeFs.renameSync(world.trashDir, aside)
  nodeFs.symlinkSync(aside, world.trashDir)
  const asideBefore = world.treeOf(aside)
  const storeBefore = world.storeTree()
  assert.equal(await proc.codeOf('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions }), ERROR.trashUnusable)
  assert.deepEqual(world.storeTree(), storeBefore)
  assert.deepEqual(world.treeOf(aside), asideBefore)
  assert.deepEqual((await proc.call('overview', { fresh: true })).capabilities, { prune: false, reason: ERROR.trashUnusable })
  nodeFs.unlinkSync(world.trashDir)
  nodeFs.renameSync(aside, world.trashDir)
})

test('a backend listing that fails moves nothing and makes no registry call', { skip: NOT_DARWIN }, async (t) => {
  const world = await sandbox({ layout: 'compact' })
  const proc = startProcess(world)
  const plan = await proc.call('plan', { scope: 'selection', rootIds: ['tree-b'] })
  const done = await proc.call('apply', { planId: plan.planId, confirmCount: 1 })
  const plan2 = await proc.call('plan', { scope: 'selection', rootIds: ['tree-c'] })
  // docs/store-safety.md S6: a project folder that vanishes during a listing makes list() reject.
  world.hooks.afterList = () => { throw Object.assign(new Error('ENOENT: scandir (a project folder vanished during the listing)'), { code: 'ENOENT' }) }
  const calls = world.registryLog.length
  const tree = world.storeTree()
  const codes = {}
  for (const [name, request] of [['overview', { fresh: true }], ['plan', { scope: 'all' }], ['trash', { fresh: true }],
    ['apply', { planId: plan2.planId, confirmCount: 2 }], ['restore', { batchId: done.batchId }], ['purge', { batchId: done.batchId, confirm: done.batchId }]]) {
    codes[name] = await proc.codeOf(name, request)
    assert.notEqual(codes[name], 'resolved', name)
  }
  world.hooks.afterList = null
  t.diagnostic(`error codes with a failing listing: ${JSON.stringify(codes)}`)
  assert.equal(world.registryLog.length, calls)
  assert.deepEqual(world.storeTree(), tree)
  assert.ok(nodeFs.existsSync(path.join(world.trashDir, done.batchId)))
  assert.equal((await proc.call('restore', { batchId: done.batchId })).state, 'complete')
})

// Regression test for a defect the first integration run found; it is fixed in src/.
test('a failing backend listing reaches the caller as sessions-manager/store-unreadable', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  const proc = startProcess(world)
  world.hooks.afterList = () => { throw Object.assign(new Error('ENOENT: scandir'), { code: 'ENOENT' }) }
  for (const name of ['overview', 'trash']) assert.ok(ERROR_CODES.includes(await proc.codeOf(name, { fresh: true })), name)
})

// ---------------------------------------------------------------------------
// 9b. The prune dry run's findings, replayed on the sandbox (T16)
// ---------------------------------------------------------------------------

const planFor = async (proc, rootIds) => {
  const plan = await proc.call('plan', { scope: 'selection', rootIds })
  return { planId: plan.planId, confirmCount: plan.totals.readySessions }
}
const journalRecords = (world, batchId) => nodeFs.readFileSync(path.join(world.trashDir, batchId, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const lastJournalOp = (world, batchId) => journalRecords(world, batchId).at(-1).op
const trashRows = (list) => list.batches.map((b) => [b.batchId, b.units, b.sessions, b.state])

test('dry run F1: a log touched after the re-read and before its rename (no lock held) is moved; the Undo gives the session back to its workspace, archived', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  let fired = false
  const proc = startProcess(world, {
    hooks: {
      beforeFs: (call) => {
        if (fired || !isHintsWrite(call)) return
        fired = true
        const now = new Date()
        nodeFs.utimesSync(path.join(world.dirOf('tree-a'), LOG_FILE), now, now)
      },
    },
  })
  const result = await proc.call('apply', await planFor(proc, ['tree-a']))
  assert.ok(fired)
  assert.equal(result.state, 'complete')
  const pruned = world.idsInTrash()
  const back = await proc.call('restore', { batchId: result.batchId })
  assert.deepEqual([back.state, back.warnings], ['complete', []], JSON.stringify(back))
  assert.deepEqual((await proc.call('trash', { fresh: true })).batches, [])
  assert.deepEqual(world.registrySnapshot(), registryAfterRestore(world.original.registry, [pruned]), 'in its workspace, at its place, archived, pinned')
  const view = await proc.call('overview', { fresh: true })
  assert.equal(view.workspaces.some((w) => w.id === null && w.folder === world.entries.get('tree-a').project), false, 'no Unassigned row for the restored tree')
  assertWorld(world, { label: 'after the Undo' })
})

test('dry run F2: a registry that refuses one detach, then one attach: the Trash tab says needs-recovery with its counts until recovery has done the step', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  world.failRegistry.set('detach', (id) => id === 'tree-a')
  const p = startProcess(world)
  const plan = await p.call('plan', { scope: 'all' })
  const result = await p.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  world.failRegistry.clear()
  assert.equal(result.state, 'needs-recovery')
  const pruned = world.idsInTrash()
  assert.deepEqual(trashRows(await p.call('trash', {})), [[result.batchId, result.moved.units, result.moved.sessions, 'needs-recovery']])
  assert.ok(world.registry.workspaces.some((w) => w.sessionIds.includes('tree-a')), 'a plain read runs no registry step')

  // A new start finishes the step before any user action.
  const q = startProcess(world)
  await q.service.core.startup()
  assertWorld(world, { label: 'after the recovery at start' })
  assert.deepEqual(trashRows(await q.call('trash', {})), [[result.batchId, result.moved.units, result.moved.sessions, 'complete']])

  // An attach refused during the Undo: the batch stays listed, holding nothing but owing the attach.
  world.failRegistry.set('attach', (id) => id === 'tree-b')
  const back = await q.call('restore', { batchId: result.batchId })
  assert.equal(back.state, 'needs-recovery')
  assert.deepEqual(trashRows(await q.call('trash', {})), [[result.batchId, 0, 0, 'needs-recovery']])
  assert.deepEqual(trashRows(await q.call('trash', { fresh: true })), [[result.batchId, 0, 0, 'needs-recovery']], 'still refused')
  world.failRegistry.clear()
  assert.deepEqual((await q.call('trash', { fresh: true })).batches, [], 'a fresh read finished the attach')
  assert.deepEqual(world.storeTree(), world.original.tree)
  assert.deepEqual(world.registrySnapshot(), registryAfterRestore(world.original.registry, [pruned]))
  assert.equal(lastJournalOp(world, result.batchId), 'closed')
})

test('dry run F4: restored batches are closed; the cost of recover() and of a one-unit apply grows by a fixed 4 fs calls per closed batch', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  const p = startProcess(world, { fsync: false })
  const recoverCosts = []
  const applyCosts = []
  for (let round = 0; round < 6; round += 1) {
    let before = p.fsCount
    const result = await p.call('apply', await planFor(p, ['tree-c']))
    applyCosts.push(p.fsCount - before)
    assert.equal(result.state, 'complete')
    assert.equal((await p.call('restore', { batchId: result.batchId })).state, 'complete')
    before = p.fsCount
    const report = await p.recover()
    recoverCosts.push(p.fsCount - before)
    assert.deepEqual([report.closed, report.batches.length], [round + 1, 0])
  }
  const steps = (list) => list.slice(1).map((value, i) => value - list[i])
  assert.deepEqual(steps(recoverCosts), [4, 4, 4, 4, 4], `recover() fs calls: ${JSON.stringify(recoverCosts)}`)
  // The first apply also creates the trash folder; from the second one on, only the closed batches add to it.
  assert.deepEqual(steps(applyCosts.slice(1)), [4, 4, 4, 4], `apply fs calls: ${JSON.stringify(applyCosts)}`)
  assert.equal(batchFolders(world).length, 6, 'closed batches stay on disk')
  assert.deepEqual((await p.call('trash', { fresh: true })).batches, [], 'and unlisted')
  assert.deepEqual(world.storeTree(), world.original.tree)
})

// ---------------------------------------------------------------------------
// 10. The plugin entry, loaded as the host loads it
// ---------------------------------------------------------------------------

test('the plugin entry loaded with ctx.plugin(): overview, plan, apply, restore on the sandbox', { skip: NOT_DARWIN }, async () => {
  const world = await sandbox({ layout: 'compact' })
  const proc = startProcess(world, { mount: 'entry', entry: hostEntry, config: {} })
  for (let i = 0; i < 20 && proc.ctx.get('sessionsManager') === undefined; i += 1) await tick()
  const view = await proc.call('overview', { fresh: true })
  assertOverview(view)
  assert.deepEqual(view.capabilities, { prune: true, reason: null })
  assert.equal(await proc.codeOf('overview', {}, AGENT), ERROR.forbidden)
  const plan = await proc.call('plan', { scope: 'all' })
  const result = await proc.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
  assert.equal(result.state, 'complete')
  assert.equal(result.trashDir, world.trashDir, 'the trash is under profileContext.home')
  assertWorld(world, { label: 'entry apply' })
  const pruned = world.idsInTrash()
  assert.equal((await proc.call('restore', { batchId: result.batchId })).state, 'complete')
  assert.deepEqual(world.storeTree(), world.original.tree)
  assert.deepEqual(world.registrySnapshot(), registryAfterRestore(world.original.registry, [pruned]))
})

// ---------------------------------------------------------------------------
// 11. Nothing left the sandbox
// ---------------------------------------------------------------------------

test('no test of this file left the sandbox: no guard violation, no fs.promises call outside, the decoy home folders are empty', () => {
  for (const world of worlds) assert.deepEqual(world.violations, [], world.root)
  assert.deepEqual(gateViolations(), [])
  assert.deepEqual(decoys.touched(), [])
})
