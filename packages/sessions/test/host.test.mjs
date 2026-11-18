// Tests for the Host half of dsh-plugin-sessions: the Remote service
// (src/service.js), the host adapter (src/host-adapter.js) and the plugin
// entry (src/index.host.js).
//
// The host services are fakes: a JSONL-like persistence that scans a real temp
// store on every list() and stat() (so a moved folder is gone at once, as with
// the real backend, docs/store-safety.md S1), a workspace registry that records
// every mutation in order, a live-session service and a projection cache. The
// trash engine, the audit log and the session lock probe are the real ones, on
// folders under one mkdtemp folder; the DSH home handed to the plugin is a decoy
// folder there too. Nothing reads or writes the real DSH home.
//
// Crash tests: each "process" (one service instance) gets its own view of the
// fakes and its own file-system wrapper with a kill switch. Killing it after the
// n-th session-folder rename or the n-th registry mutation makes every later
// file-system call of that process throw and every later host call hang, as if
// the process had died there; a new service instance (another pid, the old
// trash lock judged stale) then runs recover(), and the store, the trash and
// the registry must be consistent: every session in exactly one place with its
// original bytes, every session in the trash fully cleaned from the registry,
// every session in the store with its original registry state. A final restore
// must then give back the exact original registry.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import nodeFs, {
  appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  assertApplyResult, assertArchivedPage, assertOverview, assertPlan, assertPurgeResult, assertTrashList, assertUnarchiveResult, ERROR,
  METHOD_NAMES, NAMESPACE,
} from '../src/contract.js'
import { createHostAdapter } from '../src/host-adapter.js'
import * as hostEntry from '../src/index.host.js'
import { HINTS_FILE, PLANS_KEPT, resolveSettings, SessionsManagerService } from '../src/service.js'
import * as serviceModule from '../src/service.js'
import { ROW_KEYS } from '../src/store-index.js'

const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sessions-host-test-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

const DARWIN = process.platform === 'darwin'
const NOT_DARWIN = DARWIN ? false : 'the session lock probe and prune exist only on darwin'
const LOG = 'session.v4.jsonl.zstd'
const DAY = 86_400_000
const HOST = os.hostname()
const O_EXLOCK = 0x20
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const BATCH = /^b-/
let worldCount = 0
let pidCount = 4_100_000

// ---------------------------------------------------------------------------
// The world: a store, workspaces, registry sets, live ids. Shared by every
// process; it plays the role of the disk and the registry's durable file.
// ---------------------------------------------------------------------------

// Unit a1 = [a1, a2, c1]: c1 is a subagent child a first-start bootstrap put
// into the workspace (and pinned), a2 an unregistered archived child in another
// project folder. b1 and d1 are single-session units; k1..k3 are kept.
const LAYOUT = Object.freeze([
  { id: 'k1', project: 'p1', ws: 'w1' },
  { id: 'a1', project: 'p1', ws: 'w1', archived: true },
  { id: 'c1', project: 'p1', ws: 'w1', parent: 'a1', origin: 'subagent', pinned: true },
  { id: 'a2', project: 'p2', parent: 'a1', origin: 'subagent', archived: true },
  { id: 'k2', project: 'p1', ws: 'w1' },
  { id: 'b1', project: 'p2', ws: 'w1', archived: true },
  { id: 'd1', project: 'p3', ws: 'w2', archived: true },
  { id: 'k3', project: 'p3', ws: 'w2', pinned: true },
])
const ALL_IDS = LAYOUT.map((s) => s.id)
const PRUNED = ['a1', 'a2', 'b1', 'c1', 'd1']

function makeWorld(layout = LAYOUT) {
  const root = path.join(TMP, `w${++worldCount}`)
  const world = {
    root,
    store: path.join(root, 'store'),
    home: path.join(root, 'home'),
    work: path.join(root, 'work'),
    meta: new Map(),
    titles: new Map(),
    hashes: new Map(),
    workspaces: [],
    archived: [],
    pinned: [],
    live: new Set(),
    legacy: new Set(),
    staleIds: new Set(),
    lastSeen: new Map(),
    fail: new Set(),
    /** Registry mutation name -> predicate over its arguments: true fails that one call (id-specific failures). */
    failWhen: {},
    block: {},
    calls: [],
    events: [],
    logs: [],
    listCalls: 0,
    statCalls: 0,
  }
  world.dataDir = path.join(world.home, 'sessions-manager')
  world.trashDir = path.join(world.dataDir, 'trash')
  world.auditFile = path.join(world.dataDir, 'audit.jsonl')
  for (const dir of [world.store, world.home, world.work]) mkdirSync(dir, { recursive: true })
  const old = (Date.now() - 2 * DAY) / 1000
  for (const id of ['w1', 'w2']) {
    mkdirSync(path.join(world.work, id))
    world.workspaces.push({ id, title: `space ${id}`, path: path.join(world.work, id), sessionIds: [] })
  }
  for (const s of layout) {
    const dir = path.join(world.store, s.project, s.id)
    mkdirSync(dir, { recursive: true })
    const body = Buffer.from(`${s.id}:`.repeat(150))
    writeFileSync(path.join(dir, LOG), body)
    writeFileSync(path.join(dir, 'session.lock'), '')
    utimesSync(path.join(dir, LOG), old, old)
    world.hashes.set(s.id, sha(body))
    const workspace = world.workspaces.find((w) => w.id === s.ws)
    if (workspace) workspace.sessionIds.push(s.id)
    if (s.archived) world.archived.push(s.id)
    if (s.pinned) world.pinned.push(s.id)
    world.titles.set(s.id, `Secret title ${s.id}`)
    world.meta.set(s.id, {
      createdAt: Date.now() - 10 * DAY, cwd: path.join(world.work, s.ws ?? 'w1'), parent: s.parent ?? null, origin: s.origin ?? null,
    })
  }
  return world
}

/** The persistence snapshots of the store now, as the JSONL backend gives them. */
function scan(world) {
  const out = []
  for (const project of readdirSync(world.store).sort()) {
    const folder = path.join(world.store, project)
    if (!lstatSync(folder).isDirectory()) continue
    for (const id of readdirSync(folder).sort()) {
      const log = path.join(folder, id, LOG)
      let stat
      try {
        stat = statSync(log, { bigint: true })
      } catch {
        continue
      }
      const meta = world.meta.get(id) ?? { createdAt: 0, cwd: null, parent: null, origin: null }
      out.push({
        header: {
          version: 4, id, createdAt: meta.createdAt, ...(meta.cwd ? { cwd: meta.cwd } : {}), ...(meta.parent ? { parentSession: meta.parent } : {}),
          isSeeded: false, ...(meta.origin ? { origin: meta.origin } : {}),
        },
        formatStatus: world.legacy.has(id) ? 'migration-required' : 'current',
        revision: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
        sizeBytes: Number(stat.size),
        location: { kind: 'jsonl', path: log },
      })
    }
  }
  return out
}

function auditOps(world) {
  try {
    return readFileSync(world.auditFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).op)
  } catch {
    return []
  }
}

const isSessionMove = (world, from, to) => [from, to].some((p) => typeof p === 'string' && p.startsWith(`${world.store}${path.sep}`))
  && [from, to].some((p) => typeof p === 'string' && p.startsWith(`${world.trashDir}${path.sep}`))

/**
 * One process: its view of the host services and its file-system wrapper.
 * @param {object} world
 * @param {{ killAfter?: { kind: 'rename' | 'registry', n: number }, onManifest?: () => void }} [options]
 */
function makeProcess(world, options = {}) {
  const { killAfter = null } = options
  const proc = { dead: false, renames: 0, registryCalls: 0 }
  const hang = () => new Promise(() => {})
  const event = (...entry) => world.events.push({ entry, applyStarts: auditOps(world).filter((op) => op === 'apply-start').length })

  async function mutation(name, args, fn) {
    if (proc.dead) return hang()
    if (world.block[name]) await world.block[name].promise
    if (proc.dead) return hang()
    if (world.fail.has(name) || world.failWhen?.[name]?.(...args) === true) {
      world.calls.push([`${name}:failed`, ...args])
      throw Object.assign(new Error(`injected ${name} failure`), { code: 'EINJECTED' })
    }
    fn()
    world.calls.push([name, ...args])
    event(name, ...args)
    proc.registryCalls += 1
    if (killAfter?.kind === 'registry' && proc.registryCalls === killAfter.n) proc.dead = true
    if (proc.dead) return hang()
    return undefined
  }
  const remove = (list, id) => {
    const at = list.indexOf(id)
    if (at >= 0) list.splice(at, 1)
  }
  const workspaceView = (w) => ({
    id: w.id,
    path: w.path,
    title: w.title,
    get sessionIds() { return [...w.sessionIds] },
    attachSession: (id) => mutation('attach', [id, w.id], () => { if (!w.sessionIds.includes(id)) w.sessionIds.unshift(id) }),
    detachSession: (id) => mutation('detach', [id, w.id], () => remove(w.sessionIds, id)),
    insertSessionBefore: (id, before) => mutation('insert', [id, w.id, before ?? null], () => {
      if (!w.sessionIds.includes(id) || (before !== undefined && !w.sessionIds.includes(before))) {
        throw Object.assign(new Error('not on the account'), { name: 'WorkspaceMoveInvalidError' })
      }
      remove(w.sessionIds, id)
      if (before === undefined) w.sessionIds.push(id)
      else w.sessionIds.splice(w.sessionIds.indexOf(before), 0, id)
    }),
    status: async () => (existsSync(w.path) ? 'ok' : 'missing-dir'),
  })
  const workspaceRegistry = {
    list: () => world.workspaces.map(workspaceView),
    get: (id) => {
      const found = world.workspaces.find((w) => w.id === id)
      return found ? workspaceView(found) : undefined
    },
    get archivedSessionIds() { return [...world.archived] },
    get pinnedSessionIds() { return [...world.pinned] },
    archiveSession: (id) => mutation('archive', [id], () => {
      if (!world.archived.includes(id)) world.archived.push(id)
      remove(world.pinned, id)
    }),
    unarchiveSession: (id) => mutation('unarchive', [id], () => remove(world.archived, id)),
    pinSession: (id) => mutation('pin', [id], () => {
      if (world.archived.includes(id)) throw Object.assign(new Error('archived'), { name: 'WorkspaceArchivedSessionPinError' })
      if (!world.pinned.includes(id)) world.pinned.unshift(id)
    }),
    unpinSession: (id) => mutation('unpin', [id], () => remove(world.pinned, id)),
  }
  const sessionPersistence = {
    async list() {
      if (proc.dead) return hang()
      world.listCalls += 1
      if (world.listHook) await world.listHook()
      const snapshots = world.snapshotsOverride ? world.snapshotsOverride() : scan(world)
      for (const s of snapshots) if (s.header?.id) world.lastSeen.set(s.header.id, s)
      return snapshots
    },
    async stat(id) {
      if (proc.dead) return hang()
      world.statCalls += 1
      event('stat', id)
      const found = scan(world).find((s) => s.header.id === id)
      if (found === undefined && world.staleIds.has(id)) return world.lastSeen.get(id)
      return found
    },
  }
  const sessions = {
    list: () => [...world.live].map((id) => ({ id })),
    get: (id) => {
      event('live?', id)
      return world.live.has(id) ? { id } : undefined
    },
  }
  const sessionProjectionCache = {
    cachedSnapshot: (header) => (world.titles.has(header.id) ? { values: { title: world.titles.get(header.id) } } : undefined),
    cachedPredecessorTitle: () => undefined,
  }
  proc.services = { sessionPersistence, workspaceRegistry, sessions, sessionProjectionCache, profileContext: { home: world.home } }

  const dead = () => Object.assign(new Error('the process crashed'), { code: 'EDEAD' })
  proc.fs = new Proxy(nodeFs, {
    get(target, key) {
      const value = target[key]
      if (typeof value !== 'function') return value
      return (...args) => {
        if (proc.dead) throw dead()
        if (key === 'openSync' && typeof args[0] === 'string' && args[0].endsWith(`${path.sep}manifest.json`) && (args[1] & constants.O_CREAT)) {
          event('manifest')
          options.onManifest?.()
        }
        const result = value.apply(target, args)
        if (key === 'renameSync' && isSessionMove(world, args[0], args[1])) {
          event('rename', path.basename(args[0]), args[0].startsWith(world.store) ? 'out' : 'back')
          proc.renames += 1
          if (killAfter?.kind === 'rename' && proc.renames === killAfter.n) proc.dead = true
        }
        return result
      }
    },
  })
  proc.adapterFs = new Proxy(nodeFs, {
    get(target, key) {
      const value = target[key]
      if (typeof value !== 'function') return value
      return (...args) => {
        if (key === 'openSync' && typeof args[0] === 'string' && args[0].endsWith(`${path.sep}session.lock`)) event('lock', path.basename(path.dirname(args[0])))
        return value.apply(target, args)
      }
    },
  })
  return proc
}

/** A fake plugin context over the process's services. */
function makeCtx(world, proc, extra = {}) {
  return {
    reflect: { provide(name, value) { proc.provided = { name, value } } },
    invocation: undefined,
    logger: { warn: (message) => world.logs.push(message) },
    get: (name) => proc.services[name],
    ...extra,
  }
}

/**
 * One service instance: a new "process" with its own identity, so the trash lock of a dead one is stale.
 * `adapterFs(fs)` wraps the adapter's file system; `wrapAdapter(adapter)` replaces members of the host adapter;
 * `wrapFs(fs)` wraps the service's file system. The recovery a service runs when it starts is off here unless
 * `startupRecover` is true (the crash tests read the report of their own recover() call); the plugin entry and the
 * sandbox of the integration tests run it. `wrapGet(get)` replaces the context's service lookup (a host whose
 * providing plugins are not active yet answers undefined); `startupWaitMs` bounds the wait of a call for that recovery.
 */
function start(world, options = {}) {
  const proc = makeProcess(world, options)
  const ctx = makeCtx(world, proc)
  if (options.wrapGet) ctx.get = options.wrapGet(ctx.get)
  const made = createHostAdapter(ctx, { platform: options.platform, fs: options.adapterFs ? options.adapterFs(proc.adapterFs) : proc.adapterFs })
  const adapter = options.wrapAdapter ? options.wrapAdapter(made) : made
  const settings = resolveSettings(options.config ?? {}, { home: world.home })
  const fs = options.fs ?? proc.fs
  const service = new SessionsManagerService(ctx, {
    adapter,
    settings,
    fs: options.wrapFs ? options.wrapFs(fs) : fs,
    clock: options.clock,
    startupRecover: options.startupRecover === true,
    startupWaitMs: options.startupWaitMs,
    trashOptions: { identity: { pid: ++pidCount, startedAt: 1, host: HOST }, isAlive: options.isAlive ?? (() => false) },
  })
  return { service, proc, ctx, adapter }
}

/** An fs wrapper that counts every call and runs `before(name, args)` first. */
function countingFs(before = () => {}) {
  const counter = { calls: 0, names: new Map() }
  counter.wrap = (fs) => new Proxy(fs, {
    get(target, key) {
      const value = target[key]
      if (typeof value !== 'function') return value
      return (...args) => {
        counter.calls += 1
        counter.names.set(key, (counter.names.get(key) ?? 0) + 1)
        before(key, args)
        return value.apply(target, args)
      }
    },
  })
  return counter
}

const journalOf = (world, batchId) => readFileSync(path.join(world.trashDir, batchId, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const isHintsWrite = (name, args) => name === 'openSync' && typeof args[0] === 'string' && path.basename(args[0]) === HINTS_FILE && (args[1] & constants.O_CREAT) !== 0
const revisionOf = (file) => {
  const stat = statSync(file, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function settle(promise, proc) {
  let done = false
  promise.then(() => { done = true }, () => { done = true })
  for (let i = 0; i < 2000 && !done; i += 1) {
    if (proc.dead) {
      for (let j = 0; j < 50 && !done; j += 1) await tick()
      return
    }
    await tick()
  }
  assert.ok(done || proc.dead, 'the call neither finished nor crashed')
}

const codeOf = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error.code
  }
  return 'resolved'
}

/** The code a call settles with within a few event-loop turns, or 'pending' while it still waits (on a held registry call, say). */
async function settledCode(promise, turns = 300) {
  let out = null
  codeOf(promise).then((code) => { out = code })
  for (let i = 0; i < turns && out === null; i += 1) await tick()
  return out ?? 'pending'
}

/** Hold every registry mutation `name` of every process until open(); `reached` turns true once one waits. */
function holdRegistry(world, name) {
  const gate = deferred()
  const held = {
    reached: false,
    open() {
      if (world.block[name] === blocker) delete world.block[name]
      gate.resolve()
    },
  }
  const blocker = { get promise() { held.reached = true; return gate.promise } }
  world.block[name] = blocker
  return held
}

async function until(check, label) {
  for (let i = 0; i < 2000 && !check(); i += 1) await tick()
  assert.ok(check(), label)
}

async function prune(service, scope = { scope: 'all' }) {
  const plan = await service.plan(scope)
  assertPlan(plan)
  const result = await service.apply({ planId: plan.planId, confirmCount: plan.totals.readySessions })
  assertApplyResult(result)
  return { plan, result }
}

// ---------------------------------------------------------------------------
// Disk and registry checks
// ---------------------------------------------------------------------------

/** Where each session folder is: 'store' or 'trash:<batch>'; ids found twice have two entries. */
function places(world) {
  const out = new Map()
  const add = (id, place) => out.set(id, [...(out.get(id) ?? []), place])
  for (const project of readdirSync(world.store)) {
    const folder = path.join(world.store, project)
    if (!lstatSync(folder).isDirectory()) continue
    for (const id of readdirSync(folder)) add(id, 'store')
  }
  if (existsSync(world.trashDir)) {
    for (const batch of readdirSync(world.trashDir)) {
      const sessions = path.join(world.trashDir, batch, 'sessions')
      if (!BATCH.test(batch) || !existsSync(sessions)) continue
      for (const project of readdirSync(sessions)) for (const id of readdirSync(path.join(sessions, project))) add(id, `trash:${batch}`)
    }
  }
  return out
}

function folderOf(world, id) {
  const where = places(world).get(id)
  const project = LAYOUT.find((s) => s.id === id).project
  if (where[0] === 'store') return path.join(world.store, project, id)
  return path.join(world.trashDir, where[0].slice('trash:'.length), 'sessions', project, id)
}

function assertIntact(world, ids = ALL_IDS) {
  const where = places(world)
  for (const id of ids) {
    assert.equal(where.get(id)?.length, 1, `${id} must be in exactly one place, found ${JSON.stringify(where.get(id) ?? [])}`)
    assert.equal(sha(readFileSync(path.join(folderOf(world, id), LOG))), world.hashes.get(id), `${id} keeps its bytes`)
  }
  return where
}

const registryOf = (world) => ({
  workspaces: Object.fromEntries(world.workspaces.map((w) => [w.id, [...w.sessionIds]])),
  archived: [...world.archived].sort(),
  pinned: [...world.pinned].sort(),
})

/** Sessions in the trash are fully cleaned; sessions in the store keep their original registry state and relative order. */
function assertRegistryConsistent(world, original, where = places(world)) {
  const inStore = (id) => where.get(id)?.[0] === 'store'
  for (const id of ALL_IDS) {
    const member = world.workspaces.filter((w) => w.sessionIds.includes(id)).map((w) => w.id)
    if (inStore(id)) {
      assert.deepEqual(member, Object.entries(original.workspaces).filter(([, ids]) => ids.includes(id)).map(([wid]) => wid), `${id} keeps its workspace`)
      assert.equal(world.archived.includes(id), original.archived.includes(id), `${id} keeps its archived mark`)
      assert.equal(world.pinned.includes(id), original.pinned.includes(id), `${id} keeps its pin`)
    } else {
      assert.deepEqual(member, [], `${id} in the trash is in no workspace`)
      assert.equal(world.archived.includes(id), false, `${id} in the trash is not archived`)
      assert.equal(world.pinned.includes(id), false, `${id} in the trash is not pinned`)
    }
  }
  for (const w of world.workspaces) {
    assert.deepEqual(w.sessionIds.filter(inStore), original.workspaces[w.id].filter(inStore), `${w.id} keeps the order of its stored sessions`)
  }
}

// ---------------------------------------------------------------------------
// 1. The Remote service
// ---------------------------------------------------------------------------

test('the service is the Remote namespace sessionsManager with exactly the contract methods', () => {
  const world = makeWorld()
  const { service, proc } = start(world)
  assert.equal(SessionsManagerService.provide, 'sessionsManager')
  assert.equal(SessionsManagerService.provide, NAMESPACE)
  assert.equal(service.name, NAMESPACE)
  assert.equal(proc.provided.name, NAMESPACE)
  assert.equal(proc.provided.value, service)
  const markers = remoteMethods(service)
  assert.deepEqual(markers.map((m) => m.method), [...METHOD_NAMES])
  for (const marker of markers) assert.deepEqual(marker, { method: marker.method, invocation: { kind: 'direct' } })
  assert.equal(markers.some((m) => m.method === 'recover'), false, 'recover() is not a Remote method')
  assert.equal(service.typertRemote.namespace, NAMESPACE)
})

test('every method refuses a caller that is not the owner, before it reads anything', async () => {
  const world = makeWorld()
  const { service, ctx } = start(world)
  const requests = {
    overview: {}, archived: {}, plan: { scope: 'all' }, apply: { planId: 'p-1', confirmCount: 1 }, unarchive: { ids: ['a1'] }, trash: {},
    restore: { batchId: 'b-1' }, purge: { batchId: 'b-1', confirm: 'b-1' },
  }
  for (const invocation of [{ peer: { principal: { kind: 'agent', agentId: 'x' } } }, { peer: { principal: { kind: 'remote', id: 'y' } } }, { peer: null }, {}]) {
    ctx.invocation = invocation
    for (const name of METHOD_NAMES) {
      assert.equal(await codeOf(service[name](requests[name])), ERROR.forbidden, `${name} with ${JSON.stringify(invocation)}`)
    }
  }
  assert.equal(world.listCalls, 0)
  assert.deepEqual(world.calls, [])
  ctx.invocation = { peer: { principal: { kind: 'owner' } } }
  assertOverview(await service.overview({}))
  ctx.invocation = undefined
  assertOverview(await service.overview({ fresh: true }))
})

test('requests are strict: no session ids and no force option for apply', async () => {
  const world = makeWorld()
  const { service } = start(world)
  for (const request of [
    { planId: 'p-1', confirmCount: 3, sessionIds: ['a1'] },
    { planId: 'p-1', confirmCount: 3, force: true },
    { planId: 'p-1' },
    { planId: 'p-1', confirmCount: '3' },
  ]) assert.equal(await codeOf(service.apply(request)), ERROR.invalidRequest, JSON.stringify(request))
  if (DARWIN) assert.equal(await codeOf(service.plan({ scope: 'selection', rootIds: ['k1'] })), ERROR.invalidRequest, 'only unit roots can be selected')
  assert.equal(await codeOf(service.overview({ fresh: 'yes' })), ERROR.invalidRequest)
  assert.equal(await codeOf(service.unarchive({ ids: [] })), ERROR.invalidRequest)
})

// ---------------------------------------------------------------------------
// 2. The plugin entry
// ---------------------------------------------------------------------------

test('the plugin entry registers no agent surface and its source never names one', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/index.host.js', import.meta.url)), 'utf8')
  assert.equal(/tools|commands/.test(source), false)
  assert.equal(hostEntry.name, 'sessions-manager')
  assert.ok(Array.isArray(hostEntry.inject))
  assert.equal(hostEntry.inject.includes('tools') || hostEntry.inject.includes('commands'), false)
  assert.equal('Config' in hostEntry, false, 'no Config schema is exported (docs/store-safety.md, Config)')
})

test('apply() with a bad dataDir resolves, logs, and leaves a working read-only dashboard', async () => {
  const world = makeWorld()
  const proc = makeProcess(world)
  const ctx = makeCtx(world, proc)
  assert.equal(await hostEntry.apply(ctx, { dataDir: 'relative/dir' }), undefined)
  const service = proc.provided.value
  assert.ok(service instanceof SessionsManagerService)
  assert.ok(world.logs.some((line) => line.includes('dataDir') && line.includes('read-only')), world.logs.join('\n'))
  const view = await service.overview({})
  assertOverview(view)
  assert.deepEqual(view.capabilities, { prune: false, reason: ERROR.trashUnusable })
  assert.equal(view.totals.sessions, ALL_IDS.length)
  assertArchivedPage(await service.archived({}))
  assert.equal(await codeOf(service.plan({ scope: 'all' })), ERROR.trashUnusable)
  assert.equal(await codeOf(service.restore({ batchId: 'b-1' })), DARWIN ? ERROR.trashUnusable : ERROR.unsupportedPlatform)
  assert.equal(await codeOf(service.trash({})), ERROR.trashUnusable)
  assert.equal(existsSync(path.join(world.home, 'sessions-manager')), false, 'nothing was written')

  // A good config resolves the default dataDir under profileContext.home.
  const proc2 = makeProcess(world)
  hostEntry.apply(makeCtx(world, proc2), {})
  const view2 = await proc2.provided.value.overview({})
  assert.deepEqual(view2.capabilities, DARWIN ? { prune: true, reason: null } : { prune: false, reason: ERROR.unsupportedPlatform })

  // apply() never throws, even when every context lookup throws.
  const hostile = { reflect: { provide() { throw new Error('no provide') } }, get() { throw new Error('no get') }, logger: { warn() { throw new Error('no log') } } }
  assert.doesNotThrow(() => hostEntry.apply(hostile, { dataDir: 7 }))
  assert.doesNotThrow(() => hostEntry.apply(undefined, undefined))
})

test('a trash folder on another device or inside the store keeps pruning off and is logged', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const otherDevice = new Proxy(nodeFs, {
    get(target, key) {
      const value = target[key]
      if (key !== 'lstatSync' && key !== 'statSync') return typeof value === 'function' ? value.bind(target) : value
      return (target2, ...rest) => {
        const stat = value.call(target, target2, ...rest)
        if (typeof target2 === 'string' && (target2 === world.dataDir || target2.startsWith(`${world.dataDir}${path.sep}`) || target2 === world.home)) {
          return Object.create(stat, { dev: { value: stat.dev + 1 } })
        }
        return stat
      }
    },
  })
  mkdirSync(world.trashDir, { recursive: true, mode: 0o700 })
  const { service } = start(world, { fs: otherDevice })
  const view = await service.overview({})
  assert.deepEqual(view.capabilities, { prune: false, reason: ERROR.trashUnusable })
  assert.ok(world.logs.some((line) => line.includes('another device')), world.logs.join('\n'))
  assert.equal(await codeOf(service.plan({ scope: 'all' })), ERROR.trashUnusable)

  const world2 = makeWorld()
  const { service: inside } = start(world2, { config: { dataDir: world2.dataDir, trashDir: path.join(world2.store, 'trash') } })
  assert.deepEqual((await inside.overview({})).capabilities, { prune: false, reason: ERROR.trashUnusable })
  assert.ok(world2.logs.some((line) => line.includes('trashDir')), world2.logs.join('\n'))
})

// ---------------------------------------------------------------------------
// 3. The read path
// ---------------------------------------------------------------------------

test('one cached snapshot: TTL, single flight, fresh bypass, compact rows only', async () => {
  const world = makeWorld()
  let offset = 0
  const { service } = start(world, { clock: () => Date.now() + offset })
  const view = await service.overview({})
  assertOverview(view)
  assert.equal(world.listCalls, 1)
  await service.overview({})
  assertArchivedPage(await service.archived({ sort: 'title' }))
  assert.equal(world.listCalls, 1, 'served from the cache')
  await service.overview({ fresh: true })
  assert.equal(world.listCalls, 2, 'fresh bypasses the cache')
  offset += 15_001
  await service.archived({})
  assert.equal(world.listCalls, 3, 'the cache expires after snapshotTtlMs')
  offset += 15_001
  const gate = deferred()
  world.listHook = () => gate.promise
  const all = Promise.all([service.overview({}), service.archived({}), service.trash({}), service.overview({ fresh: true })])
  await tick()
  gate.resolve()
  await all
  world.listHook = null
  assert.equal(world.listCalls, 4, 'concurrent reads share one build')
  const state = service.core.inspectState()
  assert.equal(state.cached, true)

  assert.equal(view.storeDir, world.store)
  assert.equal(view.totals.sessions, 8)
  assert.equal(view.totals.archived, 4)
  assert.equal(view.totals.children, 2)
  assert.equal(view.totals.archivedRoots, 3)
  assert.equal(view.largest.length, 8)
  assert.ok(view.largest.every((row) => row.events === null), 'the JSONL backend gives no event count')
  assert.equal(view.largest.find((row) => row.id === 'k1').title, 'Secret title k1', 'titles come from the projection cache')
  const archived = await service.archived({})
  assert.deepEqual(archived.rows.map((row) => row.id).sort(), ['a1', 'b1', 'd1'])
  assert.equal(archived.rows.find((row) => row.id === 'a1').childCount, 2)
})

test('the cached index holds compact primitive rows only', async () => {
  const world = makeWorld()
  const { service } = start(world)
  await service.overview({})
  const { rows } = service.core.inspectState()
  assert.equal(rows.count, 8)
  for (const key of rows.keys) assert.ok(ROW_KEYS.includes(key), `unexpected row key ${key}`)
  assert.equal(rows.primitive, true)
})

test('every mutation drops the snapshot, so the next read lists the store again', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const { service } = start(world)
  await service.archived({})
  assertUnarchiveResult(await service.unarchive({ ids: ['b1'] }))
  // unarchive reads the store itself (for the sessions tree of the trash lock); the read after it lists once more.
  const before = world.listCalls
  const page = await service.archived({})
  assert.equal(world.listCalls, before + 1)
  assert.deepEqual(page.rows.map((row) => row.id).sort(), ['a1', 'd1'])

  const { result } = await prune(service)
  const listed = world.listCalls
  const after = await service.archived({})
  assert.equal(world.listCalls, listed + 1)
  assert.deepEqual(after.rows, [])
  await service.restore({ batchId: result.batchId })
  const restored = world.listCalls
  assert.equal((await service.archived({})).rows.length, 2)
  assert.equal(world.listCalls, restored + 1)
  // A failed mutation drops it too.
  await codeOf(service.purge({ batchId: 'b-nothing', confirm: 'b-nothing' }))
  const failed = world.listCalls
  await service.overview({})
  assert.equal(world.listCalls, failed + 1)
})

test('a non-JSONL backend gives prune false and a working read-only dashboard', async () => {
  const world = makeWorld()
  world.snapshotsOverride = () => scan(world).map(({ location, ...rest }) => ({ ...rest, location: { kind: 'sqlite', path: location.path } }))
  const { service } = start(world)
  const view = await service.overview({})
  assertOverview(view)
  assert.deepEqual(view.capabilities, { prune: false, reason: ERROR.unsupportedBackend })
  assert.equal(view.totals.unreadable, 8)
  assertArchivedPage(await service.archived({}))
  assert.equal(await codeOf(service.plan({ scope: 'all' })), DARWIN ? ERROR.unsupportedBackend : ERROR.unsupportedPlatform)
  assert.equal(await codeOf(service.restore({ batchId: 'b-1' })), DARWIN ? ERROR.unsupportedBackend : ERROR.unsupportedPlatform)
  assertTrashList(await service.trash({}))
  assert.deepEqual(world.calls, [])
})

test('a failing backend listing is store-unreadable for every method that reads the store: a short message without paths, nothing moved, no registry call', async () => {
  const world = makeWorld()
  let offset = 0
  const { service } = start(world, { clock: () => Date.now() + offset })
  let batchId = 'b-1'
  let planId = 'p-1'
  if (DARWIN) {
    ;({ batchId } = (await prune(service, { scope: 'selection', rootIds: ['b1'] })).result)
    ;({ planId } = await service.plan({ scope: 'selection', rootIds: ['d1'] }))
  }
  offset += 15_001 // past snapshotTtlMs: no read is served from the snapshot the plan cached
  const calls = world.calls.length
  const where = JSON.stringify([...places(world)])
  const audit = auditOps(world)
  // docs/store-safety.md S6: a project folder that vanishes during a listing makes list() reject (with its path in the message).
  world.listHook = () => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path.join(world.store, 'p9')}'`), { code: 'ENOENT', path: path.join(world.store, 'p9') })
  }
  const requests = [
    ['overview', { fresh: true }], ['archived', {}], ['plan', { scope: 'all' }], ['trash', { fresh: true }],
    ...(DARWIN ? [['apply', { planId, confirmCount: 1 }], ['restore', { batchId }], ['purge', { batchId, confirm: batchId }], ['unarchive', { ids: ['a1'] }]] : []),
  ]
  for (const [name, request] of requests) {
    let failure = null
    try {
      await service[name](request)
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.code, ERROR.storeUnreadable, `${name}: ${failure?.code}`)
    assert.equal(/[/\\]/.test(failure.message) || failure.message.includes(world.root), false, `${name}: no path in the message: ${failure.message}`)
    assert.ok(failure.message.length <= 120, `${name}: a short message`)
  }
  if (DARWIN) assert.equal(await codeOf(service.recover()), ERROR.storeUnreadable, 'recover')
  world.listHook = null
  assert.equal(world.calls.length, calls, 'no registry call')
  assert.equal(JSON.stringify([...places(world)]), where, 'nothing moved')
  assert.deepEqual(auditOps(world), audit, 'no audit line')
  assertOverview(await service.overview({ fresh: true }))
  if (DARWIN) {
    assert.equal((await service.restore({ batchId })).state, 'complete', 'the batch is still there and restores')
    assert.equal((await service.apply({ planId, confirmCount: 1 })).state, 'complete', 'the plan refused with store-unreadable is still valid')
  }
})

test('without a lock probe (not darwin) the dashboard is read-only: unsupported-platform', async () => {
  const world = makeWorld()
  const { service, adapter } = start(world, { platform: 'linux' })
  const view = await service.overview({})
  assertOverview(view)
  assert.deepEqual(view.capabilities, { prune: false, reason: ERROR.unsupportedPlatform })
  assertArchivedPage(await service.archived({}))
  assert.equal(await codeOf(service.plan({ scope: 'all' })), ERROR.unsupportedPlatform)
  assert.equal(await codeOf(service.restore({ batchId: 'b-1' })), ERROR.unsupportedPlatform)
  assert.equal(await codeOf(service.purge({ batchId: 'b-1', confirm: 'b-1' })), ERROR.unsupportedPlatform)
  assert.equal(adapter.lockState(path.join(world.store, 'p1', 'k1')), 'held', 'no probe: every folder reads as held')
  assert.equal((await service.archived({})).rows.every((row) => row.reasons.some((r) => r.code === 'locked')), true)
})

// ---------------------------------------------------------------------------
// 4. The session lock probe
// ---------------------------------------------------------------------------

test('lockState: none, stale, held, busy; never creates or changes session.lock; holdLock keeps it', { skip: NOT_DARWIN }, () => {
  const world = makeWorld()
  const proc = makeProcess(world)
  const adapter = createHostAdapter(makeCtx(world, proc))
  const folder = path.join(world.store, 'p1', 'k1')
  const lock = path.join(folder, 'session.lock')
  const before = statSync(lock)
  assert.equal(adapter.lockState(folder), 'stale')
  const facts = adapter.facts()
  assert.deepEqual(facts.lockState(folder), { state: 'stale', pid: null })
  const afterProbe = statSync(lock)
  assert.equal(afterProbe.ino, before.ino)
  assert.equal(afterProbe.size, 0)
  assert.equal(afterProbe.mtimeMs, before.mtimeMs)

  const fd = openSync(lock, constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK)
  try {
    assert.equal(adapter.lockState(folder), 'held')
    assert.equal(adapter.holdLock(folder).state, 'held')
  } finally {
    closeSync(fd)
  }
  assert.equal(adapter.lockState(folder), 'stale')

  const held = adapter.holdLock(folder)
  assert.equal(held.state, 'stale')
  assert.throws(() => openSync(lock, constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK), { code: 'EAGAIN' }, 'the plugin holds the lock')
  held.release()
  held.release()
  closeSync(openSync(lock, constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK))

  const bare = path.join(world.root, 'bare')
  mkdirSync(bare)
  assert.equal(adapter.lockState(bare), 'none')
  assert.equal(existsSync(path.join(bare, 'session.lock')), false, 'the probe never creates the lock file')
  writeFileSync(path.join(folder, 'session.v4.jsonl.zstd.tmp'), '')
  assert.equal(adapter.lockState(folder), 'held', 'a publish in flight counts as held')
  assert.equal(adapter.lockState(path.join(world.root, 'missing')), 'none')
  assert.equal(adapter.lockState('relative'), 'held')
})

test('the lock probe never follows a symlinked session folder; a folder swapped during the probe is path-unsafe and its lock is let go', { skip: NOT_DARWIN }, () => {
  const world = makeWorld()
  const proc = makeProcess(world)
  const adapter = createHostAdapter(makeCtx(world, proc), { fs: proc.adapterFs })
  const lockOpens = () => world.events.filter(({ entry }) => entry[0] === 'lock').length
  const free = (lock) => closeSync(openSync(lock, constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK))
  const REFUSED = { state: 'held', detail: 'path-unsafe', release: null }

  // 1. A session folder that is a symlink to a real session folder with a free lock: refused, nothing opened through it.
  const folder = path.join(world.store, 'p1', 'k1')
  const aside = path.join(world.root, 'aside-k1')
  nodeFs.renameSync(folder, aside)
  nodeFs.symlinkSync(aside, folder)
  const opens = lockOpens()
  assert.deepEqual(adapter.holdLock(folder), REFUSED)
  assert.equal(adapter.lockState(folder), 'held', 'never free')
  assert.equal(lockOpens(), opens, 'no session.lock is opened through the link')
  // The read path leaves it to the lstat refusal of the lineage engine (path-unsafe), so a plan gives no extra `locked`.
  assert.deepEqual(adapter.facts().lockState(folder), { state: 'none', pid: null })
  free(path.join(aside, 'session.lock'))
  // A plain file where the folder should be is refused the same way.
  const file = path.join(world.root, 'plain-file')
  writeFileSync(file, '')
  assert.deepEqual(adapter.holdLock(file), REFUSED)

  // 2. Swapped for a symlink while the probe lists the folder: the lock it opened through the link is closed again.
  const swapOn = (target, swap) => {
    let swapped = false
    const fs = new Proxy(nodeFs, {
      get(source, key) {
        const value = source[key]
        if (key !== 'readdirSync') return typeof value === 'function' ? value.bind(source) : value
        return (dir, ...rest) => {
          if (!swapped && dir === target) {
            swapped = true
            swap()
          }
          return value.call(source, dir, ...rest)
        }
      },
    })
    return { adapter: createHostAdapter(makeCtx(world, proc), { fs }), swapped: () => swapped }
  }
  const folder2 = path.join(world.store, 'p2', 'b1')
  const aside2 = path.join(world.root, 'aside-b1')
  const race = swapOn(folder2, () => {
    nodeFs.renameSync(folder2, aside2)
    nodeFs.symlinkSync(aside2, folder2)
  })
  assert.deepEqual(race.adapter.holdLock(folder2), REFUSED)
  assert.ok(race.swapped())
  free(path.join(aside2, 'session.lock'))

  // 3. Swapped for a link to a folder without a session.lock: not `none`, path-unsafe.
  const folder3 = path.join(world.store, 'p3', 'd1')
  const empty = path.join(world.root, 'empty-target')
  mkdirSync(empty)
  const race3 = swapOn(folder3, () => {
    nodeFs.renameSync(folder3, path.join(world.root, 'aside-d1'))
    nodeFs.symlinkSync(empty, folder3)
  })
  assert.deepEqual(race3.adapter.holdLock(folder3), REFUSED)
  assert.ok(race3.swapped())
  assert.deepEqual(readdirSync(empty), [], 'nothing is created at the link target')
})

// ---------------------------------------------------------------------------
// 5. Plan and apply
// ---------------------------------------------------------------------------

test('plan is a dry run kept in memory; apply checks the plan id, its age and the typed count', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  let offset = 0
  const { service } = start(world, { clock: () => Date.now() + offset })
  const original = registryOf(world)
  const where = JSON.stringify([...places(world)])
  const plan = await service.plan({ scope: 'all' })
  assertPlan(plan)
  assert.deepEqual(plan.units.map((u) => [u.rootId, u.memberIds, u.status, u.workspaceId]), [
    ['a1', ['a1', 'a2', 'c1'], 'ready', 'w1'], ['b1', ['b1'], 'ready', 'w1'], ['d1', ['d1'], 'ready', 'w2'],
  ])
  assert.equal(plan.totals.readySessions, 5)
  assert.deepEqual(plan.byWorkspace.map((g) => [g.workspaceId, g.units, g.sessions]), [['w1', 2, 4], ['w2', 1, 1]])
  assert.equal(JSON.stringify([...places(world)]), where, 'nothing moved')
  assert.deepEqual(registryOf(world), original)
  assert.deepEqual(world.calls, [])
  assert.equal(existsSync(world.trashDir), false, 'the plan creates no trash folder')

  assert.equal(await codeOf(service.apply({ planId: 'p-unknown', confirmCount: 5 })), ERROR.planExpired)
  assert.equal(await codeOf(service.apply({ planId: plan.planId, confirmCount: 4 })), ERROR.confirmationMismatch)
  assert.equal(await codeOf(service.apply({ planId: plan.planId, confirmCount: 8 })), ERROR.confirmationMismatch)
  offset += 10 * 60_000 + 1
  assert.equal(await codeOf(service.apply({ planId: plan.planId, confirmCount: 5 })), ERROR.planExpired, 'expired after planTtlMinutes')
  offset = 0

  const plans = []
  for (let i = 0; i < PLANS_KEPT + 1; i += 1) plans.push(await service.plan({ scope: 'selection', rootIds: ['b1'] }))
  assert.equal(await codeOf(service.apply({ planId: plans[0].planId, confirmCount: 1 })), ERROR.planExpired, `only the last ${PLANS_KEPT} plans are kept`)
  const result = await service.apply({ planId: plans.at(-1).planId, confirmCount: 1 })
  assertApplyResult(result)
  assert.equal(result.state, 'complete')
  assert.deepEqual(result.moved.sessions, 1)
  assert.equal(await codeOf(service.apply({ planId: plans.at(-1).planId, confirmCount: 1 })), ERROR.planExpired, 'a plan is used once')
  assert.equal(await codeOf(service.apply({ planId: plans.at(-2).planId, confirmCount: 1 })), 'resolved')
})

test('apply order: recover, audit apply-start, manifest, per unit the live and lock re-check and renames, the post-move check, unpin -> detach -> unarchive, apply-end', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  // Phase 1: a process dies right after its first registry step (detach a1).
  const first = start(world, { killAfter: { kind: 'registry', n: 1 } })
  const plan1 = await first.service.plan({ scope: 'all' })
  await settle(first.service.apply({ planId: plan1.planId, confirmCount: 5 }), first.proc)
  assert.equal(first.proc.dead, true)
  // b1 is archived and (artificially) pinned too, so one id shows the full unpin -> detach -> unarchive order.
  world.pinned.push('b1')
  world.events.length = 0

  // Phase 2: a new process plans b1 and d1 and applies.
  const second = start(world)
  const plan2 = await second.service.plan({ scope: 'all' })
  assert.deepEqual(plan2.units.map((u) => u.rootId), ['b1', 'd1'])
  const result = await second.service.apply({ planId: plan2.planId, confirmCount: 2 })
  assertApplyResult(result)
  assert.equal(result.state, 'complete')
  const events = world.events.map(({ entry }) => entry.join(' '))
  const at = (text) => events.indexOf(text)
  const manifest = at('manifest')
  assert.ok(manifest > 0)
  // recover() ran first: it finished unit a1's registry steps before the new apply-start line was written.
  const recovery = ['unarchive a1', 'unarchive a2', 'unpin c1', 'detach c1 w1']
  for (const step of recovery) {
    assert.ok(at(step) >= 0 && at(step) < manifest, `${step} is a recovery step before the manifest`)
    assert.equal(world.events[at(step)].applyStarts, 1, `${step} ran before the second apply-start`)
  }
  assert.equal(world.events[manifest].applyStarts, 2, 'apply-start is on disk before the manifest is created')
  const tail = events.slice(manifest + 1).filter((e) => !e.startsWith('stat '))
  assert.deepEqual(tail, [
    'live? b1', 'lock b1', 'rename b1 out', 'unpin b1', 'detach b1 w1', 'unarchive b1',
    'live? d1', 'lock d1', 'rename d1 out', 'detach d1 w2', 'unarchive d1',
  ])
  const afterMove = events.slice(events.indexOf('rename b1 out'), events.indexOf('unpin b1'))
  assert.deepEqual(afterMove, ['rename b1 out', 'stat b1'], 'the post-move check runs between the rename and the registry steps')
  const ops = auditOps(world)
  assert.equal(ops.at(-1), 'apply-end')
  assert.ok(ops.lastIndexOf('apply-start') < ops.lastIndexOf('unit-moved'))
  assert.equal(readFileSync(world.auditFile, 'utf8').includes('Secret'), false, 'no title reaches the audit log')

  // The journal holds every step of both applies.
  const trash = readdirSync(world.trashDir).filter((name) => BATCH.test(name))
  const steps = trash.flatMap((batch) => readFileSync(path.join(world.trashDir, batch, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((r) => r.op === 'step').map((r) => `${r.step} ${r.id} ${r.outcome}`))
  for (const step of ['detach a1 ok', 'unarchive a1 ok', 'unarchive a2 ok', 'unpin c1 ok', 'detach c1 ok', 'unpin b1 ok', 'detach b1 ok', 'unarchive b1 ok', 'detach d1 ok', 'unarchive d1 ok']) {
    assert.ok(steps.includes(step), `journaled: ${step}`)
  }
  assertIntact(world)
})

test('apply re-reads every fact and skips units that changed, lost their archive mark, or now trip a refusal', { skip: NOT_DARWIN }, async () => {
  const layout = [
    ...LAYOUT,
    { id: 'e1', project: 'p1', ws: 'w1', archived: true },
    { id: 'f1', project: 'p1', ws: 'w1', archived: true },
    { id: 'g1', project: 'p3', ws: 'w2', archived: true },
    { id: 'h1', project: 'p3', ws: 'w2', archived: true },
  ]
  const world = makeWorld(layout)
  const { service } = start(world, {
    onManifest: () => {
      // Between the re-read and the renames: these only the synchronous precheck can see.
      world.live.add('g1')
      world.archived.splice(world.archived.indexOf('h1'), 1)
      held.push(openSync(path.join(world.store, 'p1', 'f1', 'session.lock'), constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK))
    },
  })
  const held = []
  const plan = await service.plan({ scope: 'all' })
  assert.equal(plan.totals.ready, 7)
  appendFileSync(path.join(world.store, 'p2', 'b1', LOG), 'more')
  world.archived.splice(world.archived.indexOf('d1'), 1)
  world.live.add('e1')
  let result
  try {
    result = await service.apply({ planId: plan.planId, confirmCount: plan.totals.readySessions })
  } finally {
    for (const fd of held) closeSync(fd)
  }
  assertApplyResult(result)
  const skipped = Object.fromEntries(result.skipped.map((s) => [s.rootId, s.reasons.map((r) => r.code)]))
  assert.deepEqual(skipped.b1, ['changed'])
  assert.deepEqual(skipped.d1, ['not-archived'])
  assert.deepEqual(skipped.e1, ['live'])
  assert.deepEqual(skipped.f1, ['locked'])
  assert.deepEqual(skipped.g1, ['live'])
  assert.deepEqual(skipped.h1, ['not-archived'])
  assert.equal(result.moved.units, 1)
  assert.equal(result.state, 'partial')
  const where = places(world)
  for (const id of ['b1', 'd1', 'e1', 'f1', 'g1', 'h1']) assert.deepEqual(where.get(id), ['store'], `${id} stayed`)
  for (const id of ['b1', 'e1', 'f1', 'g1', 'h1', 'd1']) {
    assert.equal(world.calls.some((call) => call[1] === id), false, `${id}: no registry step`)
  }
  assert.deepEqual(where.get('a1')[0].startsWith('trash:'), true)
})

test('apply: a session folder swapped for a symlink during its lock probe is refused path-unsafe; its unit is renamed back and keeps its registry state', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const target = path.join(world.store, 'p1', 'c1')
  const aside = path.join(world.root, 'aside-c1')
  let armed = false
  let swapped = false
  // c1 is the last member of unit a1 = [a1, a2, c1]; the swap comes when the precheck's lock probe lists its folder.
  const swapDuringProbe = (fs) => new Proxy(fs, {
    get(source, key) {
      const value = source[key]
      if (key !== 'readdirSync') return value
      return (dir, ...rest) => {
        if (armed && !swapped && dir === target) {
          swapped = true
          nodeFs.renameSync(target, aside)
          nodeFs.symlinkSync(aside, target)
        }
        return value(dir, ...rest)
      }
    },
  })
  const { service } = start(world, { adapterFs: swapDuringProbe, onManifest: () => { armed = true } })
  const plan = await service.plan({ scope: 'all' })
  const result = await service.apply({ planId: plan.planId, confirmCount: plan.totals.readySessions })
  assert.ok(swapped)
  assertApplyResult(result)
  assert.deepEqual(result.skipped, [{ rootId: 'a1', reasons: [{ code: 'path-unsafe', sessionId: 'c1' }] }])
  assert.deepEqual([result.moved.units, result.moved.sessions, result.state], [2, 2, 'partial'])
  const where = places(world)
  for (const id of ['a1', 'a2', 'c1']) assert.deepEqual(where.get(id), ['store'], `${id} is in the store only`)
  assert.ok(lstatSync(target).isSymbolicLink(), 'the link stays in the store')
  assert.equal(sha(readFileSync(path.join(aside, LOG))), world.hashes.get('c1'), 'the data stays at the link target, untouched')
  for (const id of ['a1', 'a2', 'c1']) assert.equal(world.calls.some((call) => call[1] === id), false, `${id}: no registry step`)
  assertRegistryConsistent(world, original, where)
  const events = world.events.map(({ entry }) => entry.join(' '))
  assert.deepEqual(events.filter((e) => /^rename (a1|a2|c1) /.test(e)), ['rename a1 out', 'rename a2 out', 'rename a2 back', 'rename a1 back'])
})

test('a legacy-format log is refused', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  world.legacy.add('a2')
  const { service } = start(world)
  const plan = await service.plan({ scope: 'all' })
  const unit = plan.units.find((u) => u.rootId === 'a1')
  assert.equal(unit.status, 'blocked')
  assert.deepEqual(unit.reasons, [{ code: 'legacy-format', sessionId: 'a2' }])
})

test('stale-backend-entry: the backend still lists a moved id; the prune stands, its registry steps wait for recover()', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  world.staleIds.add('b1')
  const { service } = start(world)
  const { result } = await prune(service)
  assert.equal(result.moved.units, 3)
  assert.deepEqual(result.warnings.filter((w) => w.code !== 'audit-failed'), [
    { code: 'stale-backend-entry', sessionId: 'b1' }, { code: 'restart-recommended', sessionId: null },
  ])
  assert.equal(result.state, 'complete')
  assert.equal(world.calls.some((call) => call[1] === 'b1'), false, 'b1 keeps its registry entries while the backend lists it')
  assert.ok(world.archived.includes('b1'))

  const still = await service.recover()
  assert.ok(still.warnings.some((w) => w.code === 'stale-backend-entry' && w.sessionId === 'b1'))
  assert.ok(world.archived.includes('b1'))
  world.staleIds.clear()
  const done = await service.recover()
  assert.equal(done.batches[0].steps, 2)
  assert.deepEqual(world.calls.filter((call) => call[1] === 'b1').map((call) => call[0]), ['detach', 'unarchive'])
  assertRegistryConsistent(world, original)
})

test('a failed registry step is a warning, never a failure; recover() completes it', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  world.fail.add('unarchive')
  const { service } = start(world)
  const { result } = await prune(service)
  assert.equal(result.state, 'needs-recovery')
  assert.equal(result.moved.sessions, 5)
  assert.deepEqual(result.warnings.map((w) => w.code).filter((c) => c === 'registry-step-failed').length, 4)
  world.fail.clear()
  await service.recover()
  assertRegistryConsistent(world, original)
  const again = world.calls.length
  await service.recover()
  assert.equal(world.calls.length, again, 'a second recover() has nothing to do')
})

test('apply aborts before anything moves when audit apply-start cannot be written', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const { service } = start(world)
  const plan = await service.plan({ scope: 'all' })
  chmodSync(world.auditFile, 0o400)
  try {
    assert.equal(await codeOf(service.apply({ planId: plan.planId, confirmCount: 5 })), ERROR.trashUnusable)
  } finally {
    chmodSync(world.auditFile, 0o600)
  }
  assert.deepEqual([...places(world).values()].flat().filter((p) => p !== 'store'), [])
  assert.deepEqual(world.calls, [])
  assert.equal(world.events.some(({ entry }) => entry[0] === 'manifest'), false)
})

// ---------------------------------------------------------------------------
// 6. Single flight and the trash lock
// ---------------------------------------------------------------------------

test('single flight: a second mutation gets busy while one runs; reads stay available', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const { service } = start(world)
  const plan = await service.plan({ scope: 'all' })
  world.block.detach = deferred()
  const running = service.apply({ planId: plan.planId, confirmCount: 5 })
  for (let i = 0; i < 200 && !world.events.some(({ entry }) => entry[0] === 'rename'); i += 1) await tick()
  await tick()
  assert.equal(service.core.inspectState().mutating, 'apply')
  assert.equal(await codeOf(service.unarchive({ ids: ['k1'] })), ERROR.busy)
  assert.equal(await codeOf(service.restore({ batchId: 'b-1' })), ERROR.busy)
  assert.equal(await codeOf(service.purge({ batchId: 'b-1', confirm: 'b-1' })), ERROR.busy)
  assert.equal(await codeOf(service.apply({ planId: plan.planId, confirmCount: 5 })), ERROR.busy)
  assert.equal(await codeOf(service.recover()), ERROR.busy)
  assertOverview(await service.overview({ fresh: true }))
  assertArchivedPage(await service.archived({}))
  assertTrashList(await service.trash({ fresh: true }))
  assertPlan(await service.plan({ scope: 'all' }))

  // Another process sees the cross-process trash lock as busy.
  const other = start(world, { isAlive: () => true })
  const otherPlan = await other.service.plan({ scope: 'all' })
  assert.equal(await codeOf(other.service.apply({ planId: otherPlan.planId, confirmCount: otherPlan.totals.readySessions })), ERROR.busy)

  world.block.detach.resolve()
  delete world.block.detach
  const result = await running
  assertApplyResult(result)
  assert.equal(result.state, 'complete')
  assert.equal(service.core.inspectState().mutating, null)
  // The reads made while the apply ran are not served after it.
  const listed = world.listCalls
  assert.deepEqual((await service.archived({})).rows, [])
  assert.equal(world.listCalls, listed + 1)
  assertUnarchiveResult(await service.unarchive({ ids: ['k1'] }))
})

test('unarchive takes the trash lock: on another process it is busy while an apply, a restore or a purge runs, and reaches no registry call', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const a = start(world)
  // b judges a's trash lock as held by a live process (design.md D6: the lock serializes every mutation).
  const b = start(world, { isAlive: () => true })
  const unarchivesOf = (id) => world.calls.filter((call) => /^unarchive/.test(call[0]) && call[1] === id).length

  // 1. While a applies, held at its first detach.
  const plan = await a.service.plan({ scope: 'selection', rootIds: ['a1'] })
  let held = holdRegistry(world, 'detach')
  const applying = a.service.apply({ planId: plan.planId, confirmCount: plan.totals.readySessions })
  try {
    await until(() => held.reached, 'a is inside its apply')
    assert.equal(await settledCode(b.service.unarchive({ ids: ['b1'] })), ERROR.busy, 'unarchive while another process applies')
  } finally {
    held.open()
  }
  const applied = await applying
  assert.equal(applied.state, 'complete')

  // 2. While a restores, held at its first attach.
  held = holdRegistry(world, 'attach')
  const restoring = a.service.restore({ batchId: applied.batchId })
  try {
    await until(() => held.reached, 'a is inside its restore')
    assert.equal(await settledCode(b.service.unarchive({ ids: ['b1'] })), ERROR.busy, 'unarchive while another process restores')
  } finally {
    held.open()
  }
  assert.equal((await restoring).state, 'complete')

  // 3. While a purges, held at the registry step its recovery runs first (d1's unarchive failed at prune time).
  world.fail.add('unarchive')
  const { result: failed } = await prune(a.service, { scope: 'selection', rootIds: ['d1'] })
  world.fail.clear()
  assert.equal(failed.state, 'needs-recovery')
  held = holdRegistry(world, 'unarchive')
  const purging = a.service.purge({ batchId: failed.batchId, confirm: failed.batchId })
  try {
    await until(() => held.reached, 'a is inside its purge')
    assert.equal(await settledCode(b.service.unarchive({ ids: ['b1'] })), ERROR.busy, 'unarchive while another process purges')
  } finally {
    held.open()
  }
  assertPurgeResult(await purging)

  assert.equal(unarchivesOf('b1'), 0, 'a busy unarchive reaches no registry call')
  assert.ok(world.archived.includes('b1'))
  // Alone, it works, and leaves no lock behind.
  assert.deepEqual(await b.service.unarchive({ ids: ['b1'] }), { unarchived: ['b1'], skipped: [] })
  assert.equal(existsSync(path.join(world.trashDir, '.lock')), false)
  assert.deepEqual(world.calls.filter((call) => call[1] === 'b1'), [['unarchive', 'b1']])
})

test('unarchive holds the trash lock across its host calls, stays registry-only, and releases the lock after a failed or a thrown unarchive', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const lockFile = path.join(world.trashDir, '.lock')
  const other = start(world, { isAlive: () => true })
  const plan = await other.service.plan({ scope: 'selection', rootIds: ['d1'] })
  const { service } = start(world)

  // While one process unarchives (held at the host call), another one's apply, restore, purge and recover are busy.
  const held = holdRegistry(world, 'unarchive')
  const running = service.unarchive({ ids: ['b1'] })
  try {
    await until(() => held.reached, 'the unarchive is at its host call')
    assert.ok(existsSync(lockFile), 'the trash lock is held across the host call')
    assert.equal(await codeOf(other.service.apply({ planId: plan.planId, confirmCount: 1 })), ERROR.busy, 'apply')
    assert.equal(await codeOf(other.service.restore({ batchId: 'b-1' })), ERROR.busy, 'restore')
    assert.equal(await codeOf(other.service.purge({ batchId: 'b-1', confirm: 'b-1' })), ERROR.busy, 'purge')
    assert.equal(await codeOf(other.service.recover()), ERROR.busy, 'recover')
  } finally {
    held.open()
  }
  assert.deepEqual(await running, { unarchived: ['b1'], skipped: [] })
  assert.equal(existsSync(lockFile), false, 'released after the unarchive')
  // Registry-only: no move, no batch, no audit line, no journal.
  assert.deepEqual(world.events.filter(({ entry }) => entry[0] === 'rename' || entry[0] === 'manifest'), [])
  assert.deepEqual(readdirSync(world.trashDir).filter((name) => BATCH.test(name)), [])
  assert.equal(auditOps(world).includes('unarchive'), false)
  assert.deepEqual(readdirSync(world.trashDir).filter((name) => name.endsWith('.jsonl')), [])

  // A host unarchive that fails: the id is skipped, and the lock is gone.
  world.fail.add('unarchive')
  assert.deepEqual(await service.unarchive({ ids: ['a1'] }), { unarchived: [], skipped: [{ id: 'a1', code: 'changed' }] })
  world.fail.clear()
  assert.equal(existsSync(lockFile), false, 'released after a failed host call')

  // A failure that escapes the unarchive: the lock is released all the same.
  const broken = start(world, {
    wrapAdapter: (adapter) => ({ ...adapter, isArchived: () => { throw Object.assign(new Error('registry read failed'), { code: 'EBROKEN' }) } }),
  })
  assert.equal(await codeOf(broken.service.unarchive({ ids: ['a1'] })), 'EBROKEN')
  assert.equal(existsSync(lockFile), false, 'released after a thrown failure')
  assert.equal(broken.service.core.inspectState().mutating, null)
  // The other process mutates again.
  const result = await other.service.apply({ planId: plan.planId, confirmCount: 1 })
  assert.equal(result.state, 'complete')
  assert.ok(world.archived.includes('a1'), 'a1 was never unarchived')
})

// ---------------------------------------------------------------------------
// 7. Restore, unarchive, purge, trash list
// ---------------------------------------------------------------------------

test('restore round trip: move back, verify, attach, reorder, archive, pin; the original registry comes back exactly', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { service } = start(world)
  const { result } = await prune(service)
  assert.equal(result.state, 'complete')
  assert.deepEqual(result.moved, { units: 3, sessions: 5, bytes: result.moved.bytes })
  assert.deepEqual(registryOf(world), { workspaces: { w1: ['k1', 'k2'], w2: ['k3'] }, archived: [], pinned: ['k3'] })
  assert.ok(existsSync(path.join(world.trashDir, result.batchId, HINTS_FILE)))
  const list = await service.trash({})
  assertTrashList(list)
  assert.deepEqual(list.batches.map((b) => [b.batchId, b.units, b.sessions, b.state]), [[result.batchId, 3, 5, 'complete']])

  world.calls.length = 0
  const back = await service.restore({ batchId: result.batchId })
  assertApplyResult(back)
  assert.equal(back.state, 'complete')
  assert.equal(back.moved.sessions, 5)
  assert.deepEqual(registryOf(world), original)
  assert.deepEqual(world.workspaces.find((w) => w.id === 'w1').sessionIds, ['k1', 'a1', 'c1', 'k2', 'b1'])
  assertIntact(world)
  const names = world.calls.map((call) => `${call[0]} ${call[1]}`)
  for (const id of ['a1', 'b1', 'c1']) {
    assert.ok(names.indexOf(`attach ${id}`) < names.indexOf(`insert ${id}`), `${id}: attach before insert`)
  }
  assert.ok(names.indexOf('insert a1') < names.indexOf('archive a1'))
  assert.ok(names.indexOf('insert c1') < names.indexOf('pin c1'))
  assert.equal(names.includes('pin a1') || names.includes('pin b1'), false, 'archived members are never pinned')
  assert.equal(names.includes('attach a2'), false, 'an unregistered child is not attached')
  const verify = world.events.map(({ entry }) => entry.join(' '))
  assert.ok(verify.lastIndexOf('stat a1') < verify.indexOf('attach a1 w1'), 'the log is verified before the attach')

  world.calls.length = 0
  const twice = await service.restore({ batchId: result.batchId })
  assertApplyResult(twice)
  assert.deepEqual(twice.moved, { units: 0, sessions: 0, bytes: 0 })
  assert.deepEqual(world.calls, [], 'a second restore is a no-op')
  assert.deepEqual((await service.trash({})).batches, [], 'a fully restored batch is no longer listed')
  await service.recover()
  assert.deepEqual(world.calls, [])

  // Later user changes stand: recover() never redoes a finished restore step.
  assert.deepEqual((await service.unarchive({ ids: ['a1'] })).unarchived, ['a1'])
  world.pinned.splice(world.pinned.indexOf('c1'), 1)
  world.workspaces[0].sessionIds.splice(world.workspaces[0].sessionIds.indexOf('b1'), 1)
  world.calls.length = 0
  await service.recover()
  assert.deepEqual(world.calls, [])
  assert.equal(world.archived.includes('a1'), false)
})

test('restore keeps a unit in trash on workspace-missing and conflict, and never overwrites', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const { service } = start(world)
  const { result } = await prune(service)
  // d1's workspace folder is gone; b1's destination exists as an empty folder.
  rmSync(path.join(world.work, 'w2'), { recursive: true })
  mkdirSync(path.join(world.store, 'p2', 'b1'))
  const back = await service.restore({ batchId: result.batchId })
  assertApplyResult(back)
  const skipped = Object.fromEntries(back.skipped.map((s) => [s.rootId, s.reasons.map((r) => r.code)]))
  assert.deepEqual(skipped.d1, ['workspace-missing'])
  assert.deepEqual(skipped.b1, ['conflict'])
  assert.equal(back.state, 'conflict')
  assert.equal(back.moved.sessions, 3)
  const where = places(world)
  assert.ok(where.get('d1')[0].startsWith('trash:'))
  assert.deepEqual(where.get('b1').sort(), ['store', `trash:${result.batchId}`], 'the empty folder is left alone')
  assert.deepEqual(readdirSync(path.join(world.store, 'p2', 'b1')), [])
  // recover() found b1 in both places and marked it conflict; the batch holds d1 (its one whole unit) and b1's copy.
  const list = await service.trash({})
  assertTrashList(list)
  assert.deepEqual(list.batches.map((b) => [b.units, b.sessions, b.state]), [[1, 2, 'conflict']], 'the list counts every copy the batch folder still holds')

  // A workspace the registry no longer holds is workspace-missing too.
  world.workspaces.splice(world.workspaces.findIndex((w) => w.id === 'w2'), 1)
  mkdirSync(path.join(world.work, 'w2'))
  rmSync(path.join(world.store, 'p2', 'b1'), { recursive: true })
  const again = await service.restore({ batchId: result.batchId })
  assert.deepEqual(again.skipped.map((s) => [s.rootId, s.reasons[0].code]), [['d1', 'workspace-missing']])
  assert.ok(places(world).get('d1')[0].startsWith('trash:'))
  assert.equal(again.moved.sessions, 1)
})

test('a log that is back but differs from the recorded one is not attached by restore; recover() accepts it', { skip: NOT_DARWIN }, async () => {
  for (const recorded of ['the log facts journaled at the move', 'the hint of a batch an older build wrote (no logs line)']) {
    const world = makeWorld()
    const original = registryOf(world)
    const { service } = start(world)
    const { result } = await prune(service, { scope: 'selection', rootIds: ['b1'] })
    const journal = path.join(world.trashDir, result.batchId, 'journal.jsonl')
    if (recorded.startsWith('the log facts')) {
      appendFileSync(journal, `${JSON.stringify({ v: 1, ts: Date.now(), op: 'logs', sessions: [{ id: 'b1', name: LOG, revision: '1:2:3:4:5', sizeBytes: 3 }] })}\n`)
    } else {
      writeFileSync(journal, journalOf(world, result.batchId).filter((r) => r.op !== 'logs').map((r) => `${JSON.stringify(r)}\n`).join(''))
      const file = path.join(world.trashDir, result.batchId, HINTS_FILE)
      const hints = JSON.parse(readFileSync(file, 'utf8'))
      hints.sessions[0].revision = '1:2:3:4:5'
      delete hints.sessions[0].logName
      chmodSync(file, 0o600)
      writeFileSync(file, JSON.stringify(hints))
    }
    const back = await service.restore({ batchId: result.batchId })
    assert.deepEqual(back.warnings, [{ code: 'recovery-needed', sessionId: 'b1' }], recorded)
    assert.equal(back.state, 'needs-recovery', recorded)
    assert.equal(world.workspaces[0].sessionIds.includes('b1'), false, recorded)
    await service.recover()
    assert.deepEqual(registryOf(world), original, recorded)
  }
})

test('unarchive runs the host unarchive for archived ids only', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  world.live.add('d1')
  const { service } = start(world)
  const result = await service.unarchive({ ids: ['a1', 'k1', 'd1', 'a1'] })
  assertUnarchiveResult(result)
  assert.deepEqual(result, { unarchived: ['a1'], skipped: [{ id: 'k1', code: 'not-archived' }, { id: 'd1', code: 'live' }] })
  assert.deepEqual(world.calls, [['unarchive', 'a1']])
})

test('purge: typed id, allowPermanentDelete, unknown batch, and the only deletion', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const { service } = start(world)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['a1'] })
  assert.equal(await codeOf(service.purge({ batchId: result.batchId, confirm: 'b-other' })), ERROR.confirmationMismatch)
  assert.equal(await codeOf(service.purge({ batchId: 'b-20200101T000000Z-0000', confirm: 'b-20200101T000000Z-0000' })), ERROR.batchNotFound)
  const locked = start(world, { config: { allowPermanentDelete: false } })
  assert.equal(await codeOf(locked.service.purge({ batchId: result.batchId, confirm: result.batchId })), ERROR.purgeDisabled)
  assert.equal((await locked.service.overview({})).config.allowPermanentDelete, false)
  const gone = await service.purge({ batchId: result.batchId, confirm: result.batchId })
  assertPurgeResult(gone)
  assert.equal(gone.removedSessions, 3)
  assert.ok(gone.removedBytes > 0)
  assert.equal(existsSync(path.join(world.trashDir, result.batchId)), false)
  for (const id of ['a1', 'a2', 'c1']) assert.equal(places(world).has(id), false)
  assert.deepEqual((await service.trash({})).batches, [])
  assert.ok(auditOps(world).includes('purge-end'))

  // An interrupted purge (the batch folder already renamed to .purge-<id>) is listed and finished by a second purge.
  const { result: second } = await prune(service, { scope: 'selection', rootIds: ['b1'] })
  nodeFs.renameSync(path.join(world.trashDir, second.batchId), path.join(world.trashDir, `.purge-${second.batchId}`))
  assert.deepEqual((await service.trash({})).batches.map((b) => [b.batchId, b.state]), [[second.batchId, 'needs-recovery']])
  const finished = await service.purge({ batchId: second.batchId, confirm: second.batchId })
  assertPurgeResult(finished)
  assert.equal(existsSync(path.join(world.trashDir, `.purge-${second.batchId}`)), false)
  assert.deepEqual((await service.trash({})).batches, [])
})

test('a batch id that passes the request pattern but not the trash engine (it holds "..") is batch-not-found for restore and purge', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const { service } = start(world)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['b1'] })
  const audit = auditOps(world)
  const calls = world.calls.length
  for (const batchId of ['b..x', 'x..', `${result.batchId}..`, 'a..b..c']) {
    assert.equal(await codeOf(service.restore({ batchId })), ERROR.batchNotFound, `restore ${batchId}`)
    assert.equal(await codeOf(service.purge({ batchId, confirm: batchId })), ERROR.batchNotFound, `purge ${batchId}`)
  }
  assert.deepEqual(auditOps(world), audit, 'nothing is audited for an id that can name no batch')
  assert.equal(world.calls.length, calls)
  // The other answers stay: a well-formed unknown id, a request the contract refuses, a wrong typed id.
  assert.equal(await codeOf(service.restore({ batchId: 'b-20200101T000000Z-0000' })), ERROR.batchNotFound)
  assert.equal(await codeOf(service.restore({ batchId: '../trash' })), ERROR.invalidRequest)
  assert.equal(await codeOf(service.purge({ batchId: 'b..x', confirm: 'b..y' })), ERROR.confirmationMismatch)
  assert.equal(existsSync(path.join(world.trashDir, result.batchId)), true, 'the real batch is untouched')
  assert.equal((await service.restore({ batchId: result.batchId })).state, 'complete')
})

test('restore finds the sessions tree from the batch when the store lists no session', { skip: NOT_DARWIN }, async () => {
  const layout = [{ id: 'a1', project: 'p1', ws: 'w1', archived: true }]
  const world = makeWorld(layout)
  const { service } = start(world)
  const { result } = await prune(service)
  assert.equal(result.moved.sessions, 1)
  const view = await service.overview({ fresh: true })
  assert.equal(view.totals.sessions, 0)
  const list = await service.trash({})
  assert.equal(list.batches.length, 1)
  const back = await service.restore({ batchId: result.batchId })
  assert.equal(back.moved.sessions, 1)
  assert.deepEqual(world.workspaces[0].sessionIds, ['a1'])
  assert.deepEqual(world.archived, ['a1'])
})

// ---------------------------------------------------------------------------
// 8. Crash tests
// ---------------------------------------------------------------------------

/** Restore every listed batch with a fresh process and check the original state came back. */
async function restoreAll(world, original) {
  const { service } = start(world)
  await service.recover()
  for (const batch of readdirSync(world.trashDir).filter((name) => BATCH.test(name)).sort()) {
    const back = await service.restore({ batchId: batch })
    assertApplyResult(back)
  }
  const where = assertIntact(world)
  for (const id of ALL_IDS) assert.deepEqual(where.get(id), ['store'], `${id} is back in the store`)
  assert.deepEqual(registryOf(world), original)
}

const PRUNE_POINTS = [
  ...[1, 2, 3, 4, 5].map((n) => ({ kind: 'rename', n })),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ kind: 'registry', n })),
]

test('crash during apply after every move and every registry step: recover() completes or reports the batch', { skip: NOT_DARWIN }, async (t) => {
  for (const killAfter of PRUNE_POINTS) {
    await t.test(`crash after ${killAfter.kind} #${killAfter.n}`, async () => {
      const world = makeWorld()
      const original = registryOf(world)
      const dying = start(world, { killAfter })
      const plan = await dying.service.plan({ scope: 'all' })
      await settle(dying.service.apply({ planId: plan.planId, confirmCount: 5 }), dying.proc)
      assert.equal(dying.proc.dead, true, 'the process died at the chosen point')

      const next = start(world)
      const report = await next.service.recover()
      assert.equal(report.batches.length, 1)
      assert.ok(['complete', 'needs-recovery', 'conflict'].includes(report.batches[0].state))
      assert.equal(report.batches[0].state, 'complete', JSON.stringify(report))
      const where = assertIntact(world)
      assertRegistryConsistent(world, original, where)
      const listed = await next.service.trash({ fresh: true })
      assertTrashList(listed)
      // A second recover() has nothing left to do.
      const calls = world.calls.length
      await start(world).service.recover()
      assert.equal(world.calls.length, calls)
      await restoreAll(world, original)
    })
  }
})

const RESTORE_POINTS = [
  ...[1, 2, 3, 4, 5].map((n) => ({ kind: 'rename', n })),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => ({ kind: 'registry', n })),
]

test('crash during restore after every move back and every registry step: recover() completes it', { skip: NOT_DARWIN }, async (t) => {
  for (const killAfter of RESTORE_POINTS) {
    await t.test(`crash after ${killAfter.kind} #${killAfter.n}`, async () => {
      const world = makeWorld()
      const original = registryOf(world)
      const { result } = await prune(start(world).service)
      const dying = start(world, { killAfter })
      await settle(dying.service.restore({ batchId: result.batchId }), dying.proc)
      assert.equal(dying.proc.dead, true, 'the process died at the chosen point')

      const next = start(world)
      const report = await next.service.recover()
      assert.equal(report.batches.length, 1)
      assert.equal(report.batches[0].state, 'complete', JSON.stringify(report))
      const where = assertIntact(world)
      assertRegistryConsistent(world, original, where)
      await restoreAll(world, original)
    })
  }
})

// ---------------------------------------------------------------------------
// 9. Static rules of the Host files
// ---------------------------------------------------------------------------

test('host files: no registry file, projection-cache folder, session open, session search, environment or home lookups', () => {
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n')
  for (const name of ['service.js', 'host-adapter.js', 'index.host.js']) {
    const code = strip(readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8'))
    assert.equal(/workspace[.]json|session_projcache|[.]open[(]|search/.test(code), false, name)
    assert.equal(/process[.]env|homedir/.test(code), false, name)
  }
  const others = ['service.js', 'index.host.js'].map((name) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8'))
  for (const code of others) assert.equal(/ctx\.get\(|sessionPersistence|workspaceRegistry|sessionProjectionCache|profileContext/.test(strip(code)), false, 'only the adapter touches host services')
})

// ---------------------------------------------------------------------------
// 10. Findings of the prune dry run (T16)
// ---------------------------------------------------------------------------

const trashRows = (list) => list.batches.map((b) => [b.batchId, b.units, b.sessions, b.state])
const trashCopy = (world, batchId, project, id) => path.join(world.trashDir, batchId, 'sessions', project, id, LOG)

test('F1: a log that grows after the re-read and before its move (its writer gone before the lock probe) is recorded as moved; the Undo then completes fully', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const order = world.workspaces.find((w) => w.id === 'w1').sessionIds.slice()
  let grown = 0
  const { service } = start(world, {
    wrapFs: (fs) => countingFs((name, args) => {
      // The hints are written after the re-read of every fact and before the first rename.
      if (grown === 0 && isHintsWrite(name, args)) {
        for (const id of ['a1', 'c1']) appendFileSync(path.join(world.store, 'p1', id, LOG), Buffer.from(` grown ${id}`))
        grown += 1
      }
    }).wrap(fs),
  })
  const { result } = await prune(service, { scope: 'selection', rootIds: ['a1'] })
  assert.equal(grown, 1, 'the log grew inside the apply window')
  assert.equal(result.state, 'complete', JSON.stringify(result))
  assert.equal(result.moved.sessions, 3, 'the move goes ahead: the log is unlocked and the session is not live')

  // The journal records the log as it was moved; the registry hints keep the re-read revision.
  const logs = journalOf(world, result.batchId).filter((r) => r.op === 'logs').flatMap((r) => r.sessions)
  for (const [id, project] of [['a1', 'p1'], ['c1', 'p1'], ['a2', 'p2']]) {
    const file = trashCopy(world, result.batchId, project, id)
    assert.deepEqual(logs.find((entry) => entry.id === id), { id, name: LOG, revision: revisionOf(file), sizeBytes: statSync(file).size }, id)
  }
  const hints = JSON.parse(readFileSync(path.join(world.trashDir, result.batchId, HINTS_FILE), 'utf8'))
  assert.notEqual(hints.sessions.find((h) => h.id === 'a1').revision, logs.find((entry) => entry.id === 'a1').revision, 'the hint is the pre-move revision')

  // Undo: attach, order, archive and pin, as before the prune.
  const back = await service.restore({ batchId: result.batchId })
  assertApplyResult(back)
  assert.deepEqual([back.state, back.warnings], ['complete', []], JSON.stringify(back))
  assert.deepEqual(registryOf(world), original)
  assert.deepEqual(world.workspaces.find((w) => w.id === 'w1').sessionIds, order)
  assert.deepEqual((await service.trash({ fresh: true })).batches, [], 'nothing is left in the Trash tab')
})

test('F1: a log that changes while it is in the trash: the Undo call itself is strict (needs-recovery, no registry step), a later fresh Trash read finishes the registry steps; the folder is back either way and the log is never altered', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { service } = start(world)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['b1'] })
  appendFileSync(trashCopy(world, result.batchId, 'p2', 'b1'), Buffer.from('written in the trash'))
  const changed = sha(readFileSync(trashCopy(world, result.batchId, 'p2', 'b1')))
  // The restore result is strict: the folder comes back, but the call runs none of b1's registry steps.
  const back = await service.restore({ batchId: result.batchId })
  assert.deepEqual([back.state, back.warnings], ['needs-recovery', [{ code: 'recovery-needed', sessionId: 'b1' }]])
  assert.equal(world.workspaces[0].sessionIds.includes('b1'), false, 'not attached by the restore call')
  assert.equal(world.archived.includes('b1'), false, 'not archived by the restore call')
  assert.ok(places(world).get('b1')[0] === 'store', 'the folder itself is back')
  const calls = world.calls.length
  assert.deepEqual(trashRows(await service.trash({})), [[result.batchId, 0, 0, 'needs-recovery']], 'listed while its registry steps wait')
  assert.equal(world.calls.length, calls, 'a plain read runs no registry step')
  // A fresh read runs recovery, which accepts the log (the session may be in use by now) and finishes the
  // registry steps: attached and archived again, and the batch leaves the tab.
  assert.deepEqual((await service.trash({ fresh: true })).batches, [])
  assert.deepEqual(registryOf(world), original)
  assert.equal(sha(readFileSync(path.join(world.store, 'p2', 'b1', LOG))), changed, 'the log is never altered')
})

test('O1: restore gives back the recorded order of the batch\'s archived ids (archive appends) and pinned ids (pin prepends)', { skip: NOT_DARWIN }, async () => {
  const layout = [
    { id: 'k1', project: 'p1', ws: 'w1', pinned: true },
    { id: 'a1', project: 'p1', ws: 'w1', archived: true },
    { id: 'c1', project: 'p1', ws: 'w1', parent: 'a1', origin: 'subagent', pinned: true },
    { id: 'c2', project: 'p1', ws: 'w1', parent: 'a1', origin: 'subagent', pinned: true },
    { id: 'kx', project: 'p2', ws: 'w1', archived: true },
    { id: 'b1', project: 'p2', ws: 'w1', archived: true },
    { id: 'd1', project: 'p3', ws: 'w2', archived: true },
  ]
  const world = makeWorld(layout)
  world.live.add('kx') // stays archived: its unit is blocked
  world.archived.splice(0, world.archived.length, 'd1', 'b1', 'kx', 'a1')
  world.pinned.splice(0, world.pinned.length, 'c2', 'k1', 'c1')
  const before = { archived: [...world.archived], pinned: [...world.pinned] }
  const { service } = start(world)
  const { result } = await prune(service)
  assert.deepEqual(result.moved.units, 3)
  assert.deepEqual([world.archived, world.pinned], [['kx'], ['k1']])
  const hints = JSON.parse(readFileSync(path.join(world.trashDir, result.batchId, HINTS_FILE), 'utf8'))
  assert.deepEqual(Object.fromEntries(hints.sessions.map((h) => [h.id, [h.archivedAt, h.pinnedAt]])), {
    a1: [3, null], c1: [null, 2], c2: [null, 0], b1: [1, null], d1: [0, null],
  })
  const back = await service.restore({ batchId: result.batchId })
  assert.equal(back.state, 'complete', JSON.stringify(back))
  // The batch's own ids come back in their recorded relative order. kx was never moved, so it keeps its place,
  // and the batch's ids come back as the most recently archived and pinned (README, known limits).
  assert.deepEqual(world.archived, ['kx', 'd1', 'b1', 'a1'])
  assert.deepEqual(world.pinned, ['c2', 'c1', 'k1'])
  assert.deepEqual(new Set(world.archived), new Set(before.archived))
  assert.deepEqual(new Set(world.pinned), new Set(before.pinned))

  // When every archived and pinned id of the registry was in the batch, the exact order comes back.
  const all = makeWorld()
  all.archived.reverse()
  const exact = { archived: [...all.archived], pinned: [...all.pinned] }
  const second = start(all)
  const { result: pruned } = await prune(second.service)
  assert.equal((await second.service.restore({ batchId: pruned.batchId })).state, 'complete')
  assert.deepEqual({ archived: all.archived, pinned: all.pinned }, exact)
})

test('F2: a detach the registry refuses keeps the batch needs-recovery in the Trash tab, with its counts; a plain read runs nothing, a fresh read recovers it', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  world.fail.add('detach')
  const { service } = start(world)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['b1'] })
  world.fail.clear()
  assert.equal(result.state, 'needs-recovery')
  assert.ok(world.workspaces[0].sessionIds.includes('b1'), 'the workspace still holds an id whose folder is in the trash')
  const calls = world.calls.length
  assert.deepEqual(trashRows(await service.trash({})), [[result.batchId, 1, 1, 'needs-recovery']])
  assert.equal(world.calls.length, calls, 'a plain read runs no registry step')
  assert.deepEqual(trashRows(await service.trash({ fresh: true })), [[result.batchId, 1, 1, 'complete']], 'a fresh read finished the detach')
  assert.equal(world.workspaces[0].sessionIds.includes('b1'), false)
  assertRegistryConsistent(world, original)
  assert.ok(auditOps(world).includes('recover'))
})

test('F2: an attach the registry refuses during a restore keeps the batch listed as needs-recovery until recovery has attached it; after 3 failed attempts only an explicit change retries it', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { service } = start(world)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['b1'] })
  world.fail.add('attach')
  const back = await service.restore({ batchId: result.batchId })
  assert.equal(back.state, 'needs-recovery')
  assert.deepEqual(trashRows(await service.trash({})), [[result.batchId, 0, 0, 'needs-recovery']], 'not hidden as complete and empty')
  assert.deepEqual(trashRows(await service.trash({ fresh: true })), [[result.batchId, 0, 0, 'needs-recovery']], 'the registry still refuses')
  const report = await service.recover()
  assert.deepEqual(report.batches.map((b) => [b.batchId, b.state]), [[result.batchId, 'needs-recovery']], 'recover() reports the step it still owes')
  assert.notEqual(journalOf(world, result.batchId).at(-1).op, 'closed')
  world.fail.clear()
  // Three failed attempts (the restore call, the fresh read, recover()): a fresh read no longer retries the attach.
  assert.equal(journalOf(world, result.batchId).filter((r) => r.op === 'step' && r.step === 'attach' && r.outcome === 'failed').length, 3)
  const calls = world.calls.length
  assert.deepEqual(trashRows(await service.trash({ fresh: true })), [[result.batchId, 0, 0, 'needs-recovery']], 'automatic retries stopped')
  assert.equal(world.calls.length, calls)
  // Restore batch on that row is an explicit change: its recovery attaches, and the batch is closed.
  assert.equal((await service.restore({ batchId: result.batchId })).state, 'complete')
  assert.deepEqual((await service.trash({ fresh: true })).batches, [])
  assert.deepEqual(registryOf(world), original)
  assert.equal(journalOf(world, result.batchId).at(-1).op, 'closed', 'recovery closed the batch once its steps were done')
})

test('F2: recovery runs once when the service starts, never throws, logs, and every call waits for it', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  world.fail.add('unarchive')
  const { result } = await prune(start(world).service)
  world.fail.clear()
  assert.equal(result.state, 'needs-recovery')
  assert.equal(world.archived.some((id) => PRUNED.includes(id)), true, 'a crash-like leftover: archived ids whose folders are in the trash')

  // A new start completes the steps without any call.
  const next = start(world, { startupRecover: true })
  const first = next.service.core.startup()
  assert.equal(next.service.core.startup(), first, 'single flight')
  await first
  assertRegistryConsistent(world, original)
  assert.ok(world.logs.some((line) => /recovery at start/.test(line)), world.logs.join('\n'))
  const calls = world.calls.length
  await next.service.core.startup()
  assert.equal(world.calls.length, calls, 'once')
  assertTrashList(await next.service.trash({}))

  // A call made right after the start waits for it instead of getting busy.
  assert.equal((await next.service.restore({ batchId: result.batchId })).state, 'complete')
  world.fail.add('unarchive')
  const { result: again } = await prune(start(world).service, { scope: 'selection', rootIds: ['b1'] })
  world.fail.clear()
  assert.equal(again.state, 'needs-recovery')
  const third = start(world, { startupRecover: true })
  assert.deepEqual(trashRows(await third.service.trash({})).map((row) => row.at(-1)), ['complete'])
  assertRegistryConsistent(world, original)

  // It never throws: an unwritable audit log turns it into a logged line; no trash at all is no work.
  chmodSync(world.auditFile, 0o400)
  try {
    const broken = start(world, { startupRecover: true })
    await broken.service.core.startup()
    assert.ok(world.logs.some((line) => /recovery at start did not/.test(line)), world.logs.join('\n'))
  } finally {
    chmodSync(world.auditFile, 0o600)
  }
  const bare = makeWorld()
  const idle = start(bare, { startupRecover: true })
  await idle.service.core.startup()
  assert.equal(bare.listCalls, 0, 'no trash: the store is not even read')
  assert.equal(existsSync(bare.trashDir), false, 'and no trash folder is created')
})

const TIMED_OUT = Symbol('timed out')
/** The value of `promise`, or TIMED_OUT when it has not settled within `ms`. */
async function within(promise, ms) {
  let timer
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })
  try {
    return await Promise.race([promise, bound])
  } finally {
    clearTimeout(timer)
  }
}

/** A prune whose unarchive steps the registry refused: archived ids whose folders are in the trash, owed to recovery. */
async function owedBatch(world) {
  world.fail.add('unarchive')
  const { result } = await prune(start(world).service)
  world.fail.clear()
  assert.equal(result.state, 'needs-recovery')
  const owed = world.archived.filter((id) => PRUNED.includes(id))
  assert.ok(owed.length > 0, 'a crash-like leftover: archived ids whose folders are in the trash')
  return { result, owed }
}
const linesOf = (world, pattern) => world.logs.filter((line) => pattern.test(line))
const leftover = (world) => world.archived.filter((id) => PRUNED.includes(id))

test('recovery at start: host services missing at the first call (their plugins not active yet) are tried again at a later call; it then runs once, with no retry loop', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { owed } = await owedBatch(world)
  let ready = false
  let lookups = 0
  const next = start(world, {
    startupRecover: true,
    wrapGet: (get) => (name) => {
      lookups += 1
      return ready ? get(name) : undefined
    },
  })
  await tick() // the recovery the start schedules
  const first = await next.service.overview({})
  assertOverview(first)
  assert.deepEqual(first.capabilities, { prune: false, reason: ERROR.unsupportedBackend })
  assert.deepEqual(leftover(world), owed, 'nothing can run without the services')
  // No retry loop: without a call, nothing looks the services up again.
  const quiet = lookups
  for (let i = 0; i < 100; i += 1) await tick()
  assert.equal(lookups, quiet, 'no retry without a call')

  // The services appear: the next call runs the recovery at start, and each owed step runs once.
  ready = true
  const unarchives = () => world.calls.filter(([name]) => name === 'unarchive').length
  const before = unarchives()
  assertOverview(await next.service.overview({}))
  assertRegistryConsistent(world, original)
  assert.equal(unarchives() - before, owed.length, 'each owed step ran once')
  assert.equal(linesOf(world, /recovery at start finished/).length, 1, world.logs.join('\n'))
  assert.deepEqual(auditOps(world).filter((op) => op === 'recover'), ['recover'])
  // Later calls do not run it again.
  const calls = world.calls.length
  assertOverview(await next.service.overview({ fresh: true }))
  assertTrashList(await next.service.trash({}))
  assertArchivedPage(await next.service.archived({}))
  assert.equal(world.calls.length, calls, 'not run again')
  assert.deepEqual(auditOps(world).filter((op) => op === 'recover'), ['recover'])
  assert.ok(linesOf(world, /recovery at start did not run/).length <= 1, world.logs.join('\n'))

  // A run that really ran and failed (logged) is not repeated by later calls; the next change runs recovery anyway.
  const other = makeWorld()
  const otherOriginal = registryOf(other)
  const { owed: left } = await owedBatch(other)
  chmodSync(other.auditFile, 0o400)
  let broken
  try {
    broken = start(other, { startupRecover: true })
    await broken.service.core.startup()
  } finally {
    chmodSync(other.auditFile, 0o600)
  }
  assert.equal(linesOf(other, /recovery at start did not run/).length, 1, other.logs.join('\n'))
  for (let i = 0; i < 3; i += 1) assertOverview(await broken.service.overview({ fresh: true }))
  assert.deepEqual(leftover(other), left, 'a read does not run it again')
  assert.equal(linesOf(other, /recovery at start did not run/).length, 1, 'logged once')
  await broken.service.recover()
  assertRegistryConsistent(other, otherOriginal)
})

test('recovery at start: a registry call that never settles holds no call past the wait bound; the recovery keeps running, single flight, and a change gets busy until it ends', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { result } = await owedBatch(world)
  const held = holdRegistry(world, 'unarchive') // a registry listener that never answers
  try {
    const BOUND = 1000
    const next = start(world, { startupRecover: true, startupWaitMs: BOUND })
    const run = next.service.core.startup()
    await until(() => held.reached, 'the recovery at start waits on the registry')
    assert.equal(next.service.core.startup(), run, 'single flight')
    const view = await within(next.service.overview({}), BOUND + 3000)
    assert.notEqual(view, TIMED_OUT, 'overview answers once the bound has passed')
    assertOverview(view)
    const still = () => linesOf(world, /recovery at start has taken 1000 ms so far/)
    assert.equal(still().length, 1, world.logs.join('\n'))
    // Past the bound a call does not wait again.
    assert.notEqual(await within(next.service.overview({ fresh: true }), BOUND / 2), TIMED_OUT, 'no second wait')
    const list = await within(next.service.trash({ fresh: true }), BOUND / 2)
    assert.notEqual(list, TIMED_OUT, 'a fresh Trash read answers: it skips its own recovery while one runs')
    assertTrashList(list)
    assert.deepEqual(trashRows(list), [[result.batchId, 3, 5, 'needs-recovery']])
    // The recovery still holds the one mutation slot: a change gets busy at once, it does not hang.
    assert.equal(next.service.core.inspectState().mutating, 'recover')
    assert.equal(await settledCode(next.service.restore({ batchId: result.batchId })), ERROR.busy)
    assert.equal(await settledCode(next.service.recover()), ERROR.busy)
    assert.equal(still().length, 1, 'logged once')
    // The registry answers: the recovery that kept running finishes, once.
    held.open()
    await run
    assertRegistryConsistent(world, original)
    assert.equal(linesOf(world, /recovery at start finished/).length, 1, world.logs.join('\n'))
    assert.equal(next.service.core.inspectState().mutating, null)
    assert.equal((await next.service.restore({ batchId: result.batchId })).state, 'complete')
    assert.deepEqual(registryOf(world), original)
  } finally {
    held.open()
  }
})

test('F4: a restore with nothing left to do closes its batch; recover() then skips it and it stays on disk, unlisted', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const { service } = start(world)
  const { result } = await prune(service)
  const back = await service.restore({ batchId: result.batchId })
  assert.equal(back.state, 'complete')
  const journal = journalOf(world, result.batchId)
  assert.deepEqual([journal.at(-1).op, journal.at(-1).batchId], ['closed', result.batchId])
  assert.equal(journal.filter((r) => r.op === 'closed').length, 1)
  const report = await service.recover()
  assert.deepEqual([report.closed, report.batches], [1, []])
  assert.ok(existsSync(path.join(world.trashDir, result.batchId, 'manifest.json')), 'nothing is deleted')
  assert.deepEqual((await service.trash({ fresh: true })).batches, [])
  // A second restore of a closed batch changes nothing and writes nothing.
  const lines = journal.length
  world.calls.length = 0
  assert.equal((await service.restore({ batchId: result.batchId })).state, 'complete')
  assert.deepEqual(world.calls, [])
  assert.equal(journalOf(world, result.batchId).length, lines)
})

test('closed batch cost: recover() spends the same few fs calls on each closed batch, however many there are and whatever they held', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const counter = countingFs()
  const { service } = start(world, { wrapFs: (fs) => counter.wrap(fs) })
  const measure = async () => {
    const before = counter.calls
    const report = await service.recover()
    return { calls: counter.calls - before, report }
  }
  const costs = []
  let last = null
  for (let round = 0; round < 5; round += 1) {
    const { result } = await prune(service, round % 2 === 0 ? { scope: 'all' } : { scope: 'selection', rootIds: ['b1'] })
    assert.equal((await service.restore({ batchId: result.batchId })).state, 'complete')
    const { calls, report } = await measure()
    assert.deepEqual([report.closed, report.batches.length], [round + 1, 0])
    if (last !== null) costs.push(calls - last)
    last = calls
  }
  assert.deepEqual(costs, [4, 4, 4, 4], `fs calls per added closed batch: ${JSON.stringify(costs)}`)
})

test('F4 upgrade: a fully restored batch of an older build (no closed line, no log facts, no order hints) is closed after one verifying pass, then skipped', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { service } = start(world)
  const { result } = await prune(service)
  // The older build wrote neither logs lines nor the new hint fields.
  const journalFile = path.join(world.trashDir, result.batchId, 'journal.jsonl')
  const hintsFile = path.join(world.trashDir, result.batchId, HINTS_FILE)
  writeFileSync(journalFile, journalOf(world, result.batchId).filter((r) => r.op !== 'logs').map((r) => `${JSON.stringify(r)}\n`).join(''))
  const hints = JSON.parse(readFileSync(hintsFile, 'utf8'))
  for (const hint of hints.sessions) for (const key of ['logName', 'archivedAt', 'pinnedAt']) delete hint[key]
  chmodSync(hintsFile, 0o600)
  writeFileSync(hintsFile, `${JSON.stringify(hints)}\n`)
  const back = await service.restore({ batchId: result.batchId })
  assert.equal(back.state, 'complete', JSON.stringify(back))
  assert.deepEqual(registryOf(world), original)
  // Its closed line is lost (an older build never wrote one).
  writeFileSync(journalFile, journalOf(world, result.batchId).filter((r) => r.op !== 'closed').map((r) => `${JSON.stringify(r)}\n`).join(''))
  const first = await service.recover()
  assert.deepEqual([first.closed, first.batches.map((b) => [b.batchId, b.state])], [0, [[result.batchId, 'complete']]], 'one verifying pass')
  assert.equal(journalOf(world, result.batchId).at(-1).op, 'closed')
  const second = await service.recover()
  assert.deepEqual([second.closed, second.batches], [1, []])
  assert.deepEqual(registryOf(world), original)
})

test('F1: log facts a crash left unrecorded (between a move and its logs line) are taken from the trash copy by recover()', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { service } = start(world)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['a1'] })
  const journalFile = path.join(world.trashDir, result.batchId, 'journal.jsonl')
  writeFileSync(journalFile, journalOf(world, result.batchId).filter((r) => r.op !== 'logs').map((r) => `${JSON.stringify(r)}\n`).join(''))
  await service.recover()
  const logs = journalOf(world, result.batchId).filter((r) => r.op === 'logs').flatMap((r) => r.sessions)
  assert.deepEqual(logs.map((entry) => entry.id).sort(), ['a1', 'a2', 'c1'])
  assert.equal(logs.find((entry) => entry.id === 'a1').revision, revisionOf(trashCopy(world, result.batchId, 'p1', 'a1')))
  const lines = journalOf(world, result.batchId).length
  await service.recover()
  assert.equal(journalOf(world, result.batchId).length, lines, 'filled once')
  assert.equal((await service.restore({ batchId: result.batchId })).state, 'complete')
  assert.deepEqual(registryOf(world), original)
})

// ---------------------------------------------------------------------------
// 11. Recovery bounds: the start gate skips closed batches; automatic retries
// of a step that keeps failing stop after AUTO_RETRY_FAILURES failed attempts
// ---------------------------------------------------------------------------

/** Every file under the trash folder (the lock files included), relative path -> sha256 of its bytes. */
function trashFiles(world) {
  const out = {}
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const child = rel === '' ? name : `${rel}/${name}`
      const stat = lstatSync(full)
      if (stat.isDirectory()) walk(full, child)
      else out[child] = stat.isFile() ? sha(readFileSync(full)) : 'link'
    }
  }
  if (existsSync(world.trashDir)) walk(world.trashDir, '')
  return out
}
const batchNames = (world) => (existsSync(world.trashDir) ? readdirSync(world.trashDir).filter((name) => BATCH.test(name)).sort() : [])
/** A start with its recovery on, its service fs counted; `lockTouches` lists every fs call that names the trash lock files. */
function countedStart(world) {
  const lockTouches = []
  const counter = countingFs((name, args) => {
    for (const arg of args.slice(0, 2)) if (typeof arg === 'string' && /\.lock(\.released)?$/.test(arg)) lockTouches.push([name, path.basename(arg)])
  })
  const next = start(world, { startupRecover: true, wrapFs: (fs) => counter.wrap(fs) })
  return { ...next, counter, lockTouches }
}
/** Prune `rootIds` and restore the batch at once: a closed batch. */
async function closedBatch(service, world, rootIds) {
  const { result } = await prune(service, { scope: 'selection', rootIds })
  assert.equal((await service.restore({ batchId: result.batchId })).state, 'complete')
  assert.equal(journalOf(world, result.batchId).at(-1).op, 'closed')
  return result.batchId
}

test('recovery at start: a trash that holds only closed batches is nothing to recover: the start reads no store, takes no trash lock and writes nothing', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { service } = start(world)
  const closed = [await closedBatch(service, world, ['b1']), await closedBatch(service, world, ['a1', 'd1'])]
  assert.deepEqual(batchNames(world), closed.sort(), 'closed batches stay on disk')
  const before = { list: world.listCalls, stat: world.statCalls, calls: world.calls.length, audit: auditOps(world).length, files: trashFiles(world) }
  const next = countedStart(world)
  await next.service.core.startup()
  assert.equal(world.listCalls, before.list, 'the store is not read')
  assert.equal(world.statCalls, before.stat, 'no session is looked up')
  assert.equal(world.calls.length, before.calls, 'no registry call')
  assert.deepEqual(next.lockTouches, [], 'the trash lock is not taken')
  assert.deepEqual(trashFiles(world), before.files, 'nothing in the trash is written, not even the released-lock record')
  assert.equal(auditOps(world).length, before.audit, 'no audit line')
  // The whole cost: an lstat and a readdir of the trash folder, then per closed batch an lstat of its folder and one journal-tail read.
  assert.deepEqual(Object.fromEntries(next.counter.names), { lstatSync: 3, readdirSync: 1, openSync: 2, fstatSync: 2, readSync: 2, closeSync: 2 })
  assert.equal(next.service.core.inspectState().mutating, null)
  assert.deepEqual((await next.service.trash({})).batches, [])
  assert.deepEqual(registryOf(world), original)
  // A staging folder (a crash before its batch existed) and a purge tombstone are not batches: recovery only reports
  // them, so they alone start nothing either.
  for (const name of ['.staging-b-20991231T000000Z-aaaaaaaa', '.purge-b-20991231T000000Z-bbbbbbbb']) mkdirSync(path.join(world.trashDir, name), { mode: 0o700 })
  const quiet = { list: world.listCalls, files: trashFiles(world) }
  const again = countedStart(world)
  await again.service.core.startup()
  assert.equal(world.listCalls, quiet.list, 'the store is not read')
  assert.deepEqual(again.lockTouches, [])
  assert.deepEqual(trashFiles(world), quiet.files)
})

test('recovery at start: one open batch among closed ones is recovered; once it is closed too, the next start reads nothing', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { service } = start(world)
  await closedBatch(service, world, ['b1'])
  await closedBatch(service, world, ['d1'])
  world.fail.add('unarchive')
  const { result } = await prune(service, { scope: 'selection', rootIds: ['a1'] })
  world.fail.clear()
  assert.equal(result.state, 'needs-recovery')
  assert.equal(batchNames(world).length, 3, 'two closed batches and one open one')
  assert.ok(world.archived.includes('a1'), 'a crash-like leftover: an archived id whose folder is in the trash')
  const list = world.listCalls
  const next = countedStart(world)
  await next.service.core.startup()
  assert.ok(world.listCalls > list, 'the start read the store')
  assert.ok(next.lockTouches.length > 0, 'and took the trash lock')
  assertRegistryConsistent(world, original)
  assert.equal(linesOf(world, /recovery at start finished/).length, 1, world.logs.join('\n'))
  // Undo closes the last batch: the next start has nothing to recover.
  assert.equal((await service.restore({ batchId: result.batchId })).state, 'complete')
  assert.equal(journalOf(world, result.batchId).at(-1).op, 'closed')
  const quiet = { list: world.listCalls, files: trashFiles(world) }
  const last = countedStart(world)
  await last.service.core.startup()
  assert.equal(world.listCalls, quiet.list, 'the store is not read')
  assert.deepEqual(last.lockTouches, [])
  assert.deepEqual(trashFiles(world), quiet.files)
  assert.deepEqual(registryOf(world), original)
})

test('recovery at start: a closed line followed by a torn fragment is not closed: the start recovers that batch, which closes it again; the next start reads nothing', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  const { service } = start(world)
  const batchId = await closedBatch(service, world, ['b1'])
  const journalFile = path.join(world.trashDir, batchId, 'journal.jsonl')
  appendFileSync(journalFile, '{"v":1,"ts":1,"op":"st')
  const list = world.listCalls
  const next = countedStart(world)
  await next.service.core.startup()
  assert.ok(world.listCalls > list, 'a torn tail is treated as open: the start read the store')
  assert.ok(next.lockTouches.length > 0, 'and took the trash lock')
  // The engine ended the torn fragment before its next line; that fragment stays an unreadable line, skipped by every reader.
  const lines = readFileSync(journalFile, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.at(-2), '{"v":1,"ts":1,"op":"st', 'the fragment is kept, on its own line')
  const tail = JSON.parse(lines.at(-1))
  assert.deepEqual([tail.op, tail.batchId], ['closed', batchId], 'recovery closed it again after one verifying pass')
  assert.deepEqual(registryOf(world), original, 'nothing else changed')
  const quiet = { list: world.listCalls, files: trashFiles(world) }
  const last = countedStart(world)
  await last.service.core.startup()
  assert.equal(world.listCalls, quiet.list, 'closed again: the next start reads nothing')
  assert.deepEqual(last.lockTouches, [])
  assert.deepEqual(trashFiles(world), quiet.files)
})

/** The bound the tests expect (service.js AUTO_RETRY_FAILURES; one test checks the export). A literal, so a mutated bound cannot stretch a loop. */
const AUTO_RETRY_FAILURES = 3
/** Failed journal lines of one registry step of one session in a batch. */
const failedLines = (world, batchId, step, id) => journalOf(world, batchId).filter((r) => r.op === 'step' && r.step === step && r.id === id && r.outcome === 'failed').length
const recoverLines = (world) => auditOps(world).filter((op) => op === 'recover').length
/** The two automatic recoveries, in turn: a new start (its recovery at start, with start() `options`) and a fresh Trash read of `service`. */
const automaticRecoveries = (world, service, options = {}) => [
  async () => { await start(world, { ...options, startupRecover: true }).service.core.startup() },
  async () => { assertTrashList(await service.trash({ fresh: true })) },
]

test('bounded retries: a detach that always fails is attempted by the automatic recoveries (start, fresh Trash read) until it has 3 failed journal lines; then they leave it alone, the batch stays needs-recovery and a log line says so; an explicit change still retries it and, once the registry answers, completes it', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  // The prune's own registry steps wait (the backend still lists b1), so every attempt below is a recovery's.
  world.staleIds.add('b1')
  const { service } = start(world)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['b1'] })
  const { batchId } = result
  world.staleIds.clear()
  assert.equal(failedLines(world, batchId, 'detach', 'b1'), 0)
  world.failWhen.detach = (id) => id === 'b1'
  const attempts = () => world.calls.filter(([name, id]) => name === 'detach:failed' && id === 'b1').length
  const automatic = automaticRecoveries(world, service)
  const seen = []
  const lengths = []
  for (let run = 0; run < AUTO_RETRY_FAILURES + 2; run += 1) {
    await automatic[run % 2]()
    seen.push([failedLines(world, batchId, 'detach', 'b1'), attempts()])
    lengths.push(journalOf(world, batchId).length)
  }
  assert.deepEqual(seen, [[1, 1], [2, 2], [3, 3], [3, 3], [3, 3]], 'three attempts, then none')
  assert.deepEqual(lengths.slice(2), [lengths[2], lengths[2], lengths[2]], 'nothing is appended once the retries stopped')
  assert.equal(world.archived.includes('b1'), false, 'the first recovery did the unarchive')
  assert.ok(world.workspaces[0].sessionIds.includes('b1'), 'the detach is still owed')
  assert.deepEqual(trashRows(await service.trash({})), [[batchId, 1, 1, 'needs-recovery']])
  assert.equal(recoverLines(world), 1, 'one audit recover line: the run whose unarchive succeeded; a failed attempt writes none')
  const stopped = linesOf(world, /automatic recovery no longer retries/)
  assert.ok(stopped.length >= 1 && stopped.every((line) => line.includes(batchId) && /\bdetach\b/.test(line)), world.logs.join('\n'))
  const files = trashFiles(world)
  assertTrashList(await service.trash({ fresh: true }))
  assert.deepEqual(trashFiles(world), files, 'with every owed step held, a fresh read starts no recovery: not even the trash lock is taken')

  // recover() called in process is explicit too, and so is every change, which recovers first: each retries it, failing
  // or not. Here recover(), a prune of another tree, then a permanent delete.
  const report = await service.recover()
  assert.ok(report.warnings.some((w) => w.code === 'registry-step-failed' && w.sessionId === 'b1'))
  assert.equal(failedLines(world, batchId, 'detach', 'b1'), 4)
  const { result: other } = await prune(service, { scope: 'selection', rootIds: ['d1'] })
  assert.equal(other.state, 'needs-recovery', 'the retried detach is reported')
  assert.ok(other.warnings.some((w) => w.code === 'registry-step-failed' && w.sessionId === 'b1'))
  assert.equal(failedLines(world, batchId, 'detach', 'b1'), 5)
  assertPurgeResult(await service.purge({ batchId: other.batchId, confirm: other.batchId }))
  assert.equal(existsSync(path.join(world.trashDir, other.batchId)), false)
  assert.equal(failedLines(world, batchId, 'detach', 'b1'), 6)

  // The registry answers again. The automatic recoveries still leave the step alone...
  delete world.failWhen.detach
  const calls = world.calls.length
  assert.deepEqual(trashRows(await service.trash({ fresh: true })), [[batchId, 1, 1, 'needs-recovery']])
  await automatic[0]()
  assert.equal(world.calls.length, calls, 'no registry call from a fresh read or a start')
  assert.ok(world.workspaces[0].sessionIds.includes('b1'))
  // ...and the next explicit change completes it: Restore batch on its row detaches b1 first, then restores it.
  assert.equal((await service.restore({ batchId })).state, 'complete')
  assert.deepEqual(world.calls.slice(calls).filter(([, id]) => id === 'b1').map(([name]) => name), ['detach', 'attach', 'insert', 'archive'])
  assertRegistryConsistent(world, original)
  assert.equal(journalOf(world, batchId).at(-1).op, 'closed')
  assert.deepEqual((await service.trash({ fresh: true })).batches, [])
  assert.equal(failedLines(world, batchId, 'detach', 'b1'), 6)
  assert.equal(serviceModule.AUTO_RETRY_FAILURES, 3, 'service.js exports the bound')
})

test('bounded retries are counted per registry step and per session: in a restored tree each failing step (a thrown call or an attach that resolves without attaching) gets its own 3 automatic attempts; an explicit restore still retries them, and once the registry answers, Restore batch completes them and closes the batch', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  // c1's attach resolves without attaching (a non-ok status, 'not-attached'); the other failures are thrown calls.
  const notAttaching = new Set(['c1'])
  const options = { wrapAdapter: (adapter) => ({ ...adapter, attach: async (id, ws) => (notAttaching.has(id) ? 'not-attached' : adapter.attach(id, ws)) }) }
  const { service } = start(world, options)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['a1'] })
  const { batchId } = result
  // c1's log changes in the trash: the restore call itself runs none of c1's steps (strict), so c1's attempts start
  // one run after a1's. a1's attach fails only in the restore call, so its insert (which needs the attach) starts
  // one run after its archive.
  appendFileSync(trashCopy(world, batchId, 'p1', 'c1'), Buffer.from('written in the trash'))
  const failing = { attach: new Set(['a1']), insert: new Set(['a1']), archive: new Set(['a1']) }
  world.failWhen = Object.fromEntries(Object.entries(failing).map(([name, ids]) => [name, (id) => ids.has(id)]))
  const back = await service.restore({ batchId })
  assert.equal(back.state, 'needs-recovery')
  const counts = () => ({
    a1attach: failedLines(world, batchId, 'attach', 'a1'),
    a1insert: failedLines(world, batchId, 'insert', 'a1'),
    a1archive: failedLines(world, batchId, 'archive', 'a1'),
    c1attach: failedLines(world, batchId, 'attach', 'c1'),
  })
  assert.deepEqual(counts(), { a1attach: 1, a1insert: 0, a1archive: 1, c1attach: 0 })
  failing.attach.delete('a1')
  const automatic = automaticRecoveries(world, service, options)
  const seen = []
  const lengths = []
  const stats = []
  // Fresh read, start, fresh read, start, fresh read: the third run is a fresh read that must hold a1's archive while it
  // still retries a1's insert and c1's attach.
  for (let run = 0; run < AUTO_RETRY_FAILURES + 2; run += 1) {
    const statsBefore = world.statCalls
    await automatic[(run + 1) % 2]()
    seen.push(counts())
    lengths.push(journalOf(world, batchId).length)
    stats.push(world.statCalls - statsBefore)
  }
  assert.deepEqual(seen, [
    { a1attach: 1, a1insert: 1, a1archive: 2, c1attach: 1 },
    { a1attach: 1, a1insert: 2, a1archive: 3, c1attach: 2 },
    { a1attach: 1, a1insert: 3, a1archive: 3, c1attach: 3 }, // a1's archive stopped; a1's insert and c1's attach go on
    { a1attach: 1, a1insert: 3, a1archive: 3, c1attach: 3 },
    { a1attach: 1, a1insert: 3, a1archive: 3, c1attach: 3 },
  ])
  assert.deepEqual(lengths.slice(2), [lengths[2], lengths[2], lengths[2]], 'nothing is appended once every retry stopped')
  assert.deepEqual(stats.slice(3), [0, 0], 'with every owed step held, no session is even looked up')
  assert.ok(world.workspaces[0].sessionIds.includes('a1'), 'a1 attached at its second attempt')
  assert.deepEqual([...new Set(journalOf(world, batchId).filter((r) => r.op === 'step' && r.id === 'c1' && r.outcome === 'failed').map((r) => r.error))], ['not-attached'])
  assert.ok(world.pinned.includes('c1'), 'c1 pinned again: its pin does not wait for its attach')
  assert.deepEqual(trashRows(await service.trash({})), [[batchId, 0, 0, 'needs-recovery']])
  assert.equal(recoverLines(world), 1, 'one audit recover line: the run whose attach and pin succeeded')
  assert.ok(linesOf(world, /automatic recovery no longer retries/).some((line) => line.includes(batchId)), world.logs.join('\n'))
  // c1's insert has never failed, but it waits for c1's held attach: no step is left for a fresh read to start a recovery for.
  const files = trashFiles(world)
  assertTrashList(await service.trash({ fresh: true }))
  assert.deepEqual(trashFiles(world), files, 'with every owed step held, a fresh read takes not even the trash lock')

  // An explicit restore still retries every owed step once, failing or not, and stays needs-recovery.
  const retried = await service.restore({ batchId })
  assert.equal(retried.state, 'needs-recovery')
  assert.deepEqual(counts(), { a1attach: 1, a1insert: 4, a1archive: 4, c1attach: 4 })
  assert.equal(recoverLines(world), 1, 'failed attempts write no recover line')

  // The registry answers. A fresh read and a start leave the stopped steps alone; Restore batch completes and closes it.
  world.failWhen = {}
  notAttaching.clear()
  const calls = world.calls.length
  assert.deepEqual(trashRows(await service.trash({ fresh: true })), [[batchId, 0, 0, 'needs-recovery']])
  await automatic[0]()
  assert.equal(world.calls.length, calls, 'no registry call from a fresh read or a start')
  const done = await service.restore({ batchId })
  assert.deepEqual([done.state, done.warnings], ['complete', []], JSON.stringify(done))
  assert.equal(journalOf(world, batchId).at(-1).op, 'closed')
  assert.deepEqual((await service.trash({ fresh: true })).batches, [])
  assert.deepEqual(registryOf(world), original)
  assert.deepEqual(world.workspaces.find((w) => w.id === 'w1').sessionIds, original.workspaces.w1, 'the recorded order is back')
  assert.equal(recoverLines(world), 2)
})

test('bounded retries count failed attempts in a row: an unarchive that succeeded and is owed again (a second host brought the archived id back) gets three new automatic attempts', { skip: NOT_DARWIN }, async () => {
  const world = makeWorld()
  const original = registryOf(world)
  world.staleIds.add('b1')
  const { service } = start(world)
  const { result } = await prune(service, { scope: 'selection', rootIds: ['b1'] })
  const { batchId } = result
  world.staleIds.clear()
  world.failWhen.unarchive = (id) => id === 'b1'
  const automatic = automaticRecoveries(world, service)
  const seen = []
  for (let run = 0; run < AUTO_RETRY_FAILURES + 1; run += 1) {
    await automatic[run % 2]()
    seen.push(failedLines(world, batchId, 'unarchive', 'b1'))
  }
  assert.deepEqual(seen, [1, 2, 3, 3])
  assert.ok(world.archived.includes('b1'))
  // The registry answers; an explicit change (a prune of another tree) unarchives b1: nothing is owed any more.
  delete world.failWhen.unarchive
  await prune(service, { scope: 'selection', rootIds: ['d1'] })
  assert.equal(world.archived.includes('b1'), false)
  assert.deepEqual(trashRows(await service.trash({})).find((row) => row[0] === batchId), [batchId, 1, 1, 'complete'])
  // A second host's write brings the archived id back (last writer wins), and the registry refuses again.
  world.archived.push('b1')
  world.failWhen.unarchive = (id) => id === 'b1'
  assert.deepEqual(trashRows(await service.trash({})).find((row) => row[0] === batchId), [batchId, 1, 1, 'needs-recovery'])
  const again = []
  for (let run = 0; run < AUTO_RETRY_FAILURES + 1; run += 1) {
    await automatic[run % 2]()
    again.push(failedLines(world, batchId, 'unarchive', 'b1'))
  }
  assert.deepEqual(again, [4, 5, 6, 6], 'the count starts again after the step succeeded')
  delete world.failWhen.unarchive
  assert.equal((await service.restore({ batchId })).state, 'complete')
  assertRegistryConsistent(world, original)
})
